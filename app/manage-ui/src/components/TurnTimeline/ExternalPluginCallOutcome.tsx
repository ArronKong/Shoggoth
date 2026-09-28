import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getPluginExternalCallForTool, type PluginExternalCall,
  type PluginExternalCallsPage } from "../../api/client";
import styles from "./TurnTimeline.module.css";

type Identity = {
  backendId: "openclaw" | "hermes";
  agentId: string;
  sessionId: string;
  toolCallId: string;
};

const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const readCache = new Map<string, { at: number; result: Promise<PluginExternalCallsPage> }>();
function readOne(identity: Identity): Promise<PluginExternalCallsPage> {
  const key = JSON.stringify([identity.backendId, identity.agentId,
    identity.sessionId, identity.toolCallId]);
  const current = readCache.get(key);
  if (current && Date.now() - current.at < 1_000) return current.result;
  const result = getPluginExternalCallForTool(identity);
  readCache.delete(key);
  readCache.set(key, { at: Date.now(), result });
  if (readCache.size > 128) readCache.delete(readCache.keys().next().value!);
  return result;
}

export default function ExternalPluginCallOutcome({ identity, running }: {
  identity: Identity;
  running: boolean;
}) {
  const { t } = useTranslation();
  const [call, setCall] = useState<PluginExternalCall | null>(null);
  const [ambiguous, setAmbiguous] = useState(false);
  const [visible, setVisible] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const { backendId, agentId, sessionId, toolCallId } = identity;
  useEffect(() => {
    const node = anchorRef.current;
    if (!node) return;
    if (typeof IntersectionObserver !== "function") { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || ![agentId, sessionId, toolCallId].every(value => OPAQUE.test(value))) return;
    let canceled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const started = Date.now();
    const refresh = async () => {
      try {
        const page = await readOne({ backendId, agentId, sessionId, toolCallId });
        if (canceled) return;
        const unique = page.items.length === 1 && page.nextCursor === null
          && page.items[0].backendId === backendId && page.items[0].agentId === agentId
          && page.items[0].sessionId === sessionId && page.items[0].toolCallId === toolCallId;
        setAmbiguous(page.nextCursor !== null || page.items.length > 1);
        setCall(unique ? page.items[0] : null);
        // Poll only an active call. A closed historical row is read once when
        // this exact timeline expands; no page-wide audit polling is needed.
        if ((running || (unique && page.items[0].status === "pending"))
          && Date.now() - started < 135_000) {
          timer = setTimeout(refresh, 2_000);
        }
      } catch {
        if (!canceled) setCall(null);
      }
    };
    void refresh();
    return () => { canceled = true; if (timer) clearTimeout(timer); };
  }, [backendId, agentId, sessionId, toolCallId, running, visible]);

  // Duplicate host tool IDs cannot be assigned to a single visible turn.
  if (ambiguous || !call?.approvalOutcome || call.backendId !== backendId
    || call.agentId !== agentId || call.sessionId !== sessionId
    || call.toolCallId !== toolCallId) return <div ref={anchorRef} />;
  const outcome = {
    approved: "externalApprovalOutcomeApproved",
    denied: "externalApprovalOutcomeDenied",
    expired: "externalApprovalOutcomeExpired",
    withdrawn: "externalApprovalOutcomeWithdrawn",
  }[call.approvalOutcome];
  const execution = {
    pending: "externalCallPending",
    confirmed: "externalCallConfirmed",
    rejected_before_send: "externalCallRejected",
    canceled_before_send: "externalCallCanceled",
    outcome_unknown: "externalCallUnknown",
    canceled_outcome_unknown: "externalCallCanceledUnknown",
  }[call.status];
  return <div ref={anchorRef} className={styles.externalCallOutcome} data-testid="external-plugin-call-outcome"
    data-call-id={call.callId}>
    {t("plugins.externalApprovalOutcomeLabel")}: {t(`plugins.${outcome}`)} · {t("plugins.externalCallExecutionLabel")}: {t(`plugins.${execution}`)}
  </div>;
}
