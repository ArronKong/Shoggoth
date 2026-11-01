import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { completeMcpRequest, listMcpConnectors, listMcpRequests, MCP_CHANGE_EVENT, formatMcpError, searchMcpRegistry, type McpConnectionRequest, type McpRegistryItem, type McpServer } from "../api/mcpConnectors";
import { mcpRequestFields, mcpRequestStatus } from "../lib/mcpConnectorUi";
import Modal from "./Modal";
import McpConnectorDialog from "../pages/McpConnectorDialog";
import s from "../pages/ConnectorsPage.module.css";

// Credential input lives only in this mounted dialog. Never persist drafts or
// route values through chat.send, artifact state, or the conversation transcript.
export default function McpConnectionRequests({ backendId, agentId, sessionKey, visible = true, group = false }: {
  backendId: string; agentId: string; sessionKey: string; visible?: boolean; group?: boolean;
}) {
  const { t } = useTranslation(); const tr = (key: string) => t(`mcpConnectors.${key}`);
  const [items, setItems] = useState<McpConnectionRequest[]>([]), [selectedId, setSelectedId] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string,string>>({}), [servers, setServers] = useState<McpServer[]>([]), [serverId, setServerId] = useState("");
  const [add, setAdd] = useState<{ item?: McpRegistryItem; initialUrl?: string } | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [setupServer, setSetupServer] = useState<McpServer | null>(null);
  const [reload, setReload] = useState(0); const scope = `${backendId}:${agentId}:${sessionKey}`; const activeScope = useRef(scope); activeScope.current = scope;
  const request = items.find(item => item.requestId === selectedId);
  useEffect(() => { if (!visible || group) { setSelectedId(null); setValues({}); setAdd(null); setSetupServer(null); setError(""); } }, [visible, group]);
  useEffect(() => { setItems([]); setSelectedId(null); setValues({}); setAdd(null); setSetupServer(null); setError(""); }, [scope]);
  useEffect(() => {
    if (!visible || group || !sessionKey || !agentId) return;
    const controller = new AbortController(); let pending = false;
    const load = async () => { if (pending || document.visibilityState === "hidden") return; pending = true; try {
      const result = await listMcpRequests({ backendId, agentId, sessionKey }, controller.signal);
      const installed = result.items.some(item => item.kind === "setup") ? await listMcpConnectors(controller.signal) : null;
      if (!controller.signal.aborted) { setItems(result.items); if (installed) setServers(installed.servers); }
    } catch { /* Ordinary chat remains usable if the local management plane is unavailable. */ } finally { pending = false; } };
    void load(); const timer = setInterval(() => void load(), 3000); const changed = () => void load(); window.addEventListener(MCP_CHANGE_EVENT, changed);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener(MCP_CHANGE_EVENT, changed); };
  }, [scope, visible, group, reload]);
  const open = async (value: McpConnectionRequest) => { setSelectedId(value.requestId); setValues({}); setServerId(value.serverId || ""); setError(""); const started = scope; try { const list = await listMcpConnectors(); if (activeScope.current === started) setServers(list.servers); } catch (error) { if (activeScope.current === started) setError(formatMcpError(error, t)); } };
  const complete = async (id?: string) => {
    if (!request || busy) return; setBusy(true); setError(""); const started = scope;
    try {
      const fields = mcpRequestFields(request, values);
      const target = id || serverId;
      await completeMcpRequest({ requestId: request.requestId, ...(target && request.kind !== "setup" ? { serverId: target } : {}), ...(request.kind === "secret" ? { fields } : {}) });
      if (activeScope.current === started) { setValues({}); setSelectedId(null); setAdd(null); setSetupServer(null); setReload(value => value + 1); }
    } catch (error) { if (activeScope.current === started) { setError(formatMcpError(error, t)); setAdd(null); } }
    finally { if (activeScope.current === started) setBusy(false); }
  };
  const addRequested = async () => { if (!request) return; setBusy(true); setError(""); const started = scope; try { const page = request.registryName ? await searchMcpRegistry(request.registryName) : null; if (activeScope.current !== started) return; const item = page?.items.find(value => value.registryName === request.registryName); if (request.registryName && !item) { setError(formatMcpError({ code: "MCP_REGISTRY_ENTRY_UNAVAILABLE" }, t)); return; } setAdd(item ? { item } : { initialUrl: request.url || "" }); } catch (error) { if (activeScope.current === started) setError(formatMcpError(error, t)); } finally { if (activeScope.current === started) setBusy(false); } };
  if (!visible) return null;
  if (group) return <div className={s.requestList} role="note"><p>{tr("privateOnly")}</p></div>;
  if (!items.length) return null;
  return <div className={s.requestList} aria-label={tr("request")}>
    {items.map(item => { const expired = mcpRequestStatus(item) === "expired";
      const setup = item.kind === "setup";
      const targets = setup ? servers.filter(server => item.serverIds?.includes(server.id)) : [];
      const ready = setup && targets.length === item.serverIds?.length && targets.every(server => server.status === "ready");
      return <section className={s.requestCard} key={item.requestId}><h3>{item.title}</h3><p>{item.purpose}</p>
        <p className={s.muted}>{item.status === "completed" ? tr("requestDone") : expired ? tr("requestExpired") : item.continuation === "unknown" ? tr("errors.ackUnknown")
          : setup ? tr(ready ? "setupResuming" : "setupUserAction") : t("mcpConnectors.expires", { time: new Date(item.expiresAt).toLocaleString() })}</p>
        {item.status === "pending" && !expired && item.continuation !== "unknown" && (setup ? targets.map(server => <div key={server.id} className={s.actions}>
          <span>{server.name} · {tr(`statuses.${server.status}`)}</span>
          {["needsSetup", "signedOut"].includes(server.status) && <button type="button" className={s.button} onClick={() => { setSelectedId(item.requestId); setSetupServer(server); setError(""); }}>{tr(server.status === "signedOut" ? "signin" : "requestSecret")}</button>}
        </div>) : <button type="button" className={s.button} onClick={() => void open(item)}>{tr(item.kind === "secret" ? "requestSecret" : "requestComplete")}</button>)}
      </section>; })}
    <Modal open={!!request && request.kind !== "setup" && !add} onClose={() => { if (!busy) { setSelectedId(null); setValues({}); } }} dismissible={!busy} title={request?.title || tr("request")} width={600} className={s.modal}><div className={s.detail}>
      <p>{request?.purpose}</p><p className={s.muted}>{tr("secretsHint")}</p>
      {request?.kind === "secret" ? <div className={s.fields}>{request.requiredFields.map(field => <label className={s.field} key={`${field.kind}:${field.name}`}><span>{field.label}</span><input type="password" autoComplete="off" spellCheck={false} disabled={busy} value={values[`${field.kind}:${field.name}`] || ""} onChange={event => setValues(previous => ({ ...previous, [`${field.kind}:${field.name}`]: event.target.value }))} /></label>)}</div> : <><button type="button" className={s.button} disabled={busy} onClick={() => void addRequested()}>{tr("add")}</button><label className={s.field}><span>{tr("selectInstalled")}</span><select value={serverId} disabled={busy} onChange={event => setServerId(event.target.value)}><option value="">—</option>{servers.map(server => <option value={server.id} key={server.id}>{server.name} · {tr(`statuses.${server.status}`)}</option>)}</select></label></>}
      {error && <p className={s.error} role="alert">{error}</p>}<div className={s.actions}><button type="button" className={s.primary} disabled={busy || request?.kind === "connection" && !serverId} onClick={() => void complete()}>{tr(busy ? "working" : "finish")}</button></div>
    </div></Modal>
    {add && <McpConnectorDialog {...add} onClose={() => setAdd(null)} onChanged={() => setReload(value => value + 1)} onReady={server => { setServerId(server.id); void complete(server.id); }} />}
    {setupServer && <McpConnectorDialog key={setupServer.id} server={setupServer} credentialsOnly onClose={() => { setSetupServer(null); setSelectedId(null); }} onChanged={() => setReload(value => value + 1)} onReady={() => { void complete(); }} />}
  </div>;
}
