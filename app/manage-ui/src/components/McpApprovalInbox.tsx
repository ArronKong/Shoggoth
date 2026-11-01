import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { listMcpApprovals, formatMcpError, resolveMcpApproval, MCP_CHANGE_EVENT, type McpApproval } from "../api/mcpConnectors";
import { canResolveMcpApproval, mcpApprovalDisplay, mcpApprovalMatchesConversation, mcpApprovalPrompt } from "../lib/mcpConnectorUi";
import ChatApprovalCard from "../pages/ChatApprovalCard";
import { useMcpApprovalTarget } from "./McpApprovalTarget";
import Modal from "./Modal";
import "../pages/ChatPromptCard.css";
import s from "../pages/ConnectorsPage.module.css";
import styles from "./McpApprovalInbox.module.css";

export default function McpApprovalInbox({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation(); const location = useLocation(); const tr = (key: string) => t(`mcpConnectors.${key}`);
  const enabled = embedded || location.pathname !== "/connectors";
  const destination = useMcpApprovalTarget();
  const target = !embedded && location.pathname === "/chat" ? destination : null;
  const [items, setItems] = useState<McpApproval[]>([]), [selected, setSelected] = useState<McpApproval | null>(null);
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<{ id: string; message: string } | null>(null);
  const [now, setNow] = useState(Date.now);
  const current = useRef(items); current.current = items;
  const mounted = useRef(false), submitting = useRef(false), sequence = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController(); let loading = false;
    const read = async () => {
      setNow(Date.now());
      if (loading || document.visibilityState === "hidden") return;
      loading = true; const ticket = ++sequence.current;
      try {
        const result = await listMcpApprovals(controller.signal);
        if (!controller.signal.aborted && ticket === sequence.current) setItems(result.items);
      } catch { /* Keep pending requests on a temporary transport error. */ }
      finally { loading = false; }
    };
    void read(); const timer = setInterval(() => void read(), 2000);
    window.addEventListener(MCP_CHANGE_EVENT, read);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener(MCP_CHANGE_EVENT, read); };
  }, [enabled]);

  const decide = async (approval: McpApproval, choice: string) => {
    if (submitting.current || !["once", "deny"].includes(choice)) return;
    const id = mcpApprovalPrompt(approval).id;
    const latest = current.current.find(item => item.requestId === approval.requestId);
    if (!canResolveMcpApproval(approval, latest)) { setError({ id, message: tr("approvalExpired") }); return; }
    submitting.current = true; setBusy(id); setError(null);
    try {
      await resolveMcpApproval(approval.requestId, approval.argumentDigest, choice === "once");
      if (mounted.current) {
        // Fence a list read that began before this exact request was resolved.
        sequence.current++;
        setItems(previous => previous.filter(item => item.requestId !== approval.requestId));
        setSelected(previous => previous?.requestId === approval.requestId ? null : previous);
      }
    } catch (value) { if (mounted.current) setError({ id, message: formatMcpError(value, t) }); }
    finally { submitting.current = false; if (mounted.current) setBusy(null); }
  };
  if (!enabled) return null;
  const pending = items.filter(item => item.expiresAt === null || item.expiresAt > now);
  const belongsHere = (item: McpApproval) => !!target && mcpApprovalMatchesConversation(item, target.conversation);
  const inline = pending.filter(belongsHere), other = pending.filter(item => !belongsHere(item));
  const selectedCurrent = selected && other.find(item => canResolveMcpApproval(selected, item, now));
  const card = (approval: McpApproval, agentName?: string) => {
    const entry = mcpApprovalPrompt(approval, t);
    return <div key={entry.id} data-mcp-approval={approval.requestId}>
      <ChatApprovalCard entry={entry} agentName={agentName || approval.agentId} submitting={busy !== null}
        onChoose={choice => void decide(approval, choice)}>
        <pre className="chat-prompt__cmd">{approval.argumentsPreview}</pre>
        {approval.expiresAt !== null && <div className="chat-prompt__desc">{t("mcpConnectors.expires", { time: new Date(approval.expiresAt).toLocaleString() })}</div>}
      </ChatApprovalCard>
      {error?.id === entry.id && <p className={s.error} role="alert">{error.message}</p>}
    </div>;
  };
  return <>
    {target && inline.length > 0 && createPortal(<div className="chat-group is-assistant"><div className="chat-group__stack">
      {inline.map(item => card(item, target.agentName))}
    </div></div>, target.element)}
    {other.length > 0 && (embedded ? <section className={s.section}><div className={s.sectionHeading}><h2>{tr("approvals")}</h2><span className={s.count}>{other.length}</span></div>{other.map(item => { const display = mcpApprovalDisplay(item, t); return <div key={item.requestId} className={s.accountRow}><div className={s.accountLabel}><strong>{display.title}</strong><small>{item.backendId} · {item.agentId} · {display.serverName}</small></div><button className={s.button} type="button" onClick={() => { setSelected(item); setError(null); }}>{tr("reviewApproval")}</button></div>; })}</section> : <button type="button" className={styles.notice} onClick={() => { setSelected(other[0]); setError(null); }}>{t("mcpConnectors.pendingApprovals", { count: other.length })}</button>)}
    <Modal open={!!selectedCurrent} onClose={() => { if (!submitting.current) setSelected(null); }} dismissible={!busy}
      title={tr("reviewApproval")} subtitle={selectedCurrent ? `${selectedCurrent.backendId} · ${selectedCurrent.agentId}` : undefined}
      width={680} className={s.modal}>{selectedCurrent ? card(selected!) : null}</Modal>
  </>;
}
