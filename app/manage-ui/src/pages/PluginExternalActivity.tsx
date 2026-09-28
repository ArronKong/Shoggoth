import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getExternalPluginApprovals, getPluginExternalCalls,
  respondExternalPluginApproval, type PluginExternalApproval, type PluginExternalCall,
  type PluginExternalApprovalPage, type PluginExternalCallsPage } from "../api/client";
import styles from "./PluginsPage.module.css";

type Host = "all" | "openclaw" | "hermes";

// Match the native confirmation dialog: render every invisible JSON code unit
// visibly, while leaving the Service-owned command and digest untouched.
function escapeInvisibleJsonCharacters(command: string): string {
  return command.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, character =>
    Array.from({ length: character.length }, (_, index) =>
      `\\u${character.charCodeAt(index).toString(16).padStart(4, "0")}`).join(""));
}

export function PluginExternalActivity({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const [host, setHost] = useState<Host>("all");
  const [items, setItems] = useState<PluginExternalCall[]>([]);
  const [cursor, setCursor] = useState<PluginExternalCallsPage["nextCursor"]>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [approvals, setApprovals] = useState<PluginExternalApproval[]>([]);
  const [approvalCursor, setApprovalCursor] = useState<PluginExternalApprovalPage["nextCursor"]>(null);
  const [approvalError, setApprovalError] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  const generation = useRef(0);
  const approvalGeneration = useRef(0);

  const refreshApprovals = () => {
    const current = ++approvalGeneration.current;
    void getExternalPluginApprovals(host).then(page => {
      if (approvalGeneration.current === current) {
        setApprovals(page.items); setApprovalCursor(page.nextCursor); setApprovalError(false);
      }
    }).catch(() => { if (approvalGeneration.current === current) setApprovalError(true); });
  };
  const loadMoreApprovals = () => {
    if (!approvalCursor) return;
    const current = approvalGeneration.current;
    void getExternalPluginApprovals(host, approvalCursor).then(page => {
      if (approvalGeneration.current !== current) return;
      setApprovals(previous => {
        const seen = new Set(previous.map(item => item.requestId));
        return [...previous, ...page.items.filter(item => !seen.has(item.requestId))];
      });
      setApprovalCursor(page.nextCursor);
    }).catch(() => { if (approvalGeneration.current === current) refreshApprovals(); });
  };

  const refresh = () => {
    const current = ++generation.current;
    setItems([]); setCursor(null); setError(false); setLoading(true);
    void getPluginExternalCalls(host).then(page => {
      if (generation.current !== current) return;
      setItems(page.items); setCursor(page.nextCursor);
    }).catch(() => { if (generation.current === current) setError(true); })
      .finally(() => { if (generation.current === current) setLoading(false); });
  };

  useEffect(() => {
    const current = ++generation.current;
    setItems([]); setCursor(null); setError(false);
    if (active) {
      setLoading(true);
      void getPluginExternalCalls(host).then(page => {
        if (generation.current !== current) return;
        setItems(page.items); setCursor(page.nextCursor);
      }).catch(() => { if (generation.current === current) setError(true); })
        .finally(() => { if (generation.current === current) setLoading(false); });
    } else setLoading(false);
    return () => { generation.current += 1; };
  }, [active, host]);

  useEffect(() => {
    if (!active) { setApprovals([]); setApprovalCursor(null); return; }
    refreshApprovals();
    const timer = window.setInterval(refreshApprovals, 3_000);
    return () => { window.clearInterval(timer); approvalGeneration.current += 1; };
  }, [active, host]);

  const respond = (requestId: string, decision: "once" | "deny") => {
    if (approvalBusy) return;
    setApprovalBusy(requestId); setApprovalError(false);
    void respondExternalPluginApproval(requestId, decision)
      .catch(() => setApprovalError(true))
      .finally(() => {
        refreshApprovals();
        refresh();
        setApprovalBusy(null);
      });
  };

  const loadMore = () => {
    if (!cursor || loading) return;
    const current = generation.current;
    setLoading(true); setError(false);
    void getPluginExternalCalls(host, cursor).then(page => {
      if (generation.current !== current) return;
      setItems(previous => {
        const seen = new Set(previous.map(item => item.callId));
        return [...previous, ...page.items.filter(item => !seen.has(item.callId))];
      });
      setCursor(page.nextCursor);
    }).catch(() => { if (generation.current === current) setError(true); })
      .finally(() => { if (generation.current === current) setLoading(false); });
  };

  if (!active) return null;
  const status = (value: PluginExternalCall["status"]) => {
    switch (value) {
      case "confirmed": return t("plugins.externalCallConfirmed");
      case "pending": return t("plugins.externalCallPending");
      case "rejected_before_send": return t("plugins.externalCallRejected");
      case "canceled_before_send": return t("plugins.externalCallCanceled");
      case "canceled_outcome_unknown": return t("plugins.externalCallCanceledUnknown");
      default: return t("plugins.externalCallUnknown");
    }
  };
  const approvalStatus = (value: NonNullable<PluginExternalCall["approvalOutcome"]>) => {
    switch (value) {
      case "approved": return t("plugins.externalApprovalOutcomeApproved");
      case "denied": return t("plugins.externalApprovalOutcomeDenied");
      case "expired": return t("plugins.externalApprovalOutcomeExpired");
      case "withdrawn": return t("plugins.externalApprovalOutcomeWithdrawn");
    }
  };
  return <div className={styles.externalActivity}>
    <section id="plugins-external-approvals" className={styles.card}
      aria-labelledby="plugins-external-approvals-heading">
      <div className={styles.cardHeading}>
        <h2 id="plugins-external-approvals-heading">{t("plugins.externalApprovalTitle")}</h2>
        <button className="btn-secondary" type="button" onClick={refreshApprovals}>
          {t("plugins.externalCallsRefresh")}</button>
      </div>
      <p>{t("plugins.externalApprovalDescription")}</p>
      {approvalError && <p role="status">{t("plugins.externalApprovalUnavailable")}</p>}
      {!approvalError && approvals.length === 0 && <p>{t("plugins.externalApprovalEmpty")}</p>}
      {approvals.length > 0 && <ul className={styles.externalApprovalList}>
        {approvals.map(item => <li key={item.requestId}>
          <strong>{item.packageName} · {item.toolName}</strong>
          <span>{item.backendId === "openclaw" ? "OpenClaw" : "Hermes"} · {item.agentId}</span>
          <small>{t("plugins.externalApprovalSession", { session: item.sessionId,
            call: item.toolCallId })}</small>
          <small>{item.runId || item.taskId}{item.turnId ? ` / ${item.turnId}` : ""} · {item.connectionId}</small>
          <small>{t("plugins.externalApprovalExpires", { time: new Date(item.expiresAt).toLocaleTimeString() })}</small>
          <details open><summary>{t("plugins.externalApprovalArguments")}</summary>
            <pre dir="ltr" aria-label={t("plugins.externalApprovalArguments")}>
              {escapeInvisibleJsonCharacters(item.command)}</pre></details>
          <small>{t("plugins.externalApprovalConfirmHint")}</small>
          <div className={styles.externalApprovalActions}>
            <button className="btn-secondary" type="button" disabled={approvalBusy !== null}
              onClick={() => respond(item.requestId, "deny")}>{t("plugins.externalApprovalDeny")}</button>
            <button className="btn-primary" type="button" disabled={approvalBusy !== null}
              onClick={() => respond(item.requestId, "once")}>{t("plugins.externalApprovalOnce")}</button>
          </div>
        </li>)}
      </ul>}
      {approvalCursor && <button className="btn-secondary" type="button"
        onClick={loadMoreApprovals}>{t("plugins.loadMore")}</button>}
    </section>
    <section className={styles.card} aria-labelledby="plugins-external-calls-heading">
    <div className={styles.cardHeading}>
      <h2 id="plugins-external-calls-heading">{t("plugins.externalCallsTitle")}</h2>
      <button className="btn-secondary" type="button" disabled={loading}
        onClick={refresh}>{t("plugins.externalCallsRefresh")}</button>
    </div>
    <p>{t("plugins.externalCallsDescription")}</p>
    <label className={styles.externalHostFilter} htmlFor="plugin-external-calls-host">
      {t("plugins.externalCallsHost")}
      <select id="plugin-external-calls-host" value={host}
        onChange={event => setHost(event.target.value as Host)}>
        <option value="all">{t("plugins.externalCallsAllHosts")}</option>
        <option value="openclaw">OpenClaw</option>
        <option value="hermes">Hermes</option>
      </select>
    </label>
    {error && <p role="status">{t("plugins.externalCallsUnavailable")}</p>}
    {!loading && !error && items.length === 0 && <p>{t("plugins.externalCallsEmpty")}</p>}
    {items.length > 0 && <ul className={styles.externalCallList}>
      {items.map(item => <li key={item.callId}>
        <strong>{item.toolName}</strong>
        <span>{item.backendId === "openclaw" ? "OpenClaw" : "Hermes"} · {status(item.status)}</span>
        <small>{item.agentId} · {new Date(item.updatedAt).toLocaleString()}</small>
        {item.approvalOutcome && <small>{t("plugins.externalApprovalOutcomeLabel")}: {approvalStatus(item.approvalOutcome)}
          {item.approvalUpdatedAt !== null ? ` · ${new Date(item.approvalUpdatedAt).toLocaleString()}` : ""}</small>}
        <details>
          <summary>{t("plugins.externalCallIdentityDetails")}</summary>
          <small>{t("plugins.externalCallInstance")}: {item.instanceId}</small>
          <small>{t("plugins.externalCallSession")}: {item.sessionId}</small>
          <small>{item.runId !== null ? `${t("plugins.externalCallRun")}: ${item.runId}`
            : `${t("plugins.externalCallTask")}: ${item.taskId} · ${t("plugins.externalCallTurn")}: ${item.turnId}`}</small>
          <small>{t("plugins.externalCallToolCall")}: {item.toolCallId}</small>
          <small>{t("plugins.externalCallId")}: {item.callId}</small>
          {item.approvalRequestId && <small>{t("plugins.externalCallApprovalId")}: {item.approvalRequestId}</small>}
        </details>
      </li>)}
    </ul>}
    {cursor && <button className="btn-secondary" type="button" disabled={loading}
      onClick={loadMore}>{t("plugins.loadMore")}</button>}
    </section>
  </div>;
}
