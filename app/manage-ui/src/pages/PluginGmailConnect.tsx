import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, getPluginGmailAuth, getPluginGmailAuthRecoveryStatus,
  reconcilePluginGmailAuth, startPluginGmailAuth,
  type PluginGmailAuthFlow } from "../api/client";
import styles from "./PluginGraphRegistration.module.css";

const EMAIL = /^[^\s@\x00-\x1f]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,63}$/u;

export function PluginGmailConnect({ agentId, installationId, componentId, revision, disabled,
  connected, onReady }: { agentId: string; installationId: string; componentId: string;
    revision: number; disabled: boolean; connected: boolean; onReady: () => void }) {
  const { t } = useTranslation();
  const key = `shoggoth.plugin.gmail.${agentId}.${installationId}.${componentId}`;
  const [email, setEmail] = useState("");
  const [flowId, setFlowId] = useState<string | null>(() => {
    try { const value = sessionStorage.getItem(key); return value && /^[\w-]{1,128}$/u.test(value) ? value : null; }
    catch { return null; }
  });
  const [flow, setFlow] = useState<PluginGmailAuthFlow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryPending, setRecoveryPending] = useState<{ email: string; client: string } | null>(null);
  const [recoveryStatus, setRecoveryStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const [recoveryRefresh, setRecoveryRefresh] = useState(0);
  const [recoveryOutcome, setRecoveryOutcome] = useState<"recovered" | "canceled" | "blocked" | "failed" | null>(null);
  const recoveryRequired = recoveryPending !== null || error === "GMAIL_AUTH_RECOVERY_REQUIRED"
    || (flow?.status === "failed" && flow.reasonCode === "GMAIL_AUTH_RECOVERY_REQUIRED");
  const readyCallback = useRef(onReady);
  const terminalFlow = useRef(false);
  readyCallback.current = onReady;

  useEffect(() => {
    if (flowId) return;
    let active = true;
    setRecoveryStatus("loading");
    void getPluginGmailAuthRecoveryStatus({ agentId, installationId, componentId,
      expectedRevision: revision }).then(result => {
      if (!active) return;
      setRecoveryPending(result.pending);
      if (result.pending) setEmail(result.pending.email);
      setRecoveryStatus("ready");
    }).catch(() => {
      if (active) setRecoveryStatus("unavailable");
    });
    return () => { active = false; };
  }, [agentId, installationId, componentId, revision, flowId, recoveryRefresh]);

  useEffect(() => {
    if (!flowId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (terminalFlow.current) return;
      try {
        const current = await getPluginGmailAuth(agentId, flowId);
        if (!active || terminalFlow.current) return;
        if (!["pending", "verifying"].includes(current.status)) terminalFlow.current = true;
        setFlow(current); setError(null);
        if (["pending", "verifying"].includes(current.status)) {
          timer = setTimeout(() => void poll(), 1500);
        } else {
          try { sessionStorage.removeItem(key); } catch { /* UI state is still updated. */ }
          setFlowId(null);
          if (current.status === "ready") readyCallback.current();
        }
      } catch (failure) {
        if (!active || terminalFlow.current) return;
        const code = failure instanceof ApiError ? failure.code ?? "GMAIL_AUTH_FAILED" : "GMAIL_AUTH_FAILED";
        setError(code);
        if (code === "GMAIL_AUTH_FLOW_NOT_FOUND" || code === "GMAIL_AUTH_RECOVERY_REQUIRED") {
          terminalFlow.current = true;
          try { sessionStorage.removeItem(key); } catch { /* Optional recovery hint. */ }
          setFlowId(null);
        } else timer = setTimeout(() => void poll(), 5000);
      }
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [agentId, flowId, key]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const selected = email.trim();
    if (recoveryRequired) return;
    if (busy || disabled || flowId || !EMAIL.test(selected)) { setError("GMAIL_AUTH_INVALID"); return; }
    terminalFlow.current = false;
    setBusy(true); setError(null); setFlow(null); setRecoveryOutcome(null);
    try {
      const response = await startPluginGmailAuth({ agentId, installationId, componentId,
        expectedRevision: revision, operationId: crypto.randomUUID(), email: selected });
      if (response.canceled || !response.flow) return;
      setFlowId(response.flow.flowId);
      setFlow(response.flow);
      try { sessionStorage.setItem(key, response.flow.flowId); } catch { /* Poll while mounted. */ }
    } catch (failure) {
      const code = failure instanceof ApiError ? failure.code ?? "GMAIL_AUTH_FAILED" : "GMAIL_AUTH_FAILED";
      setError(code);
      if (code === "GMAIL_AUTH_RECOVERY_REQUIRED") setRecoveryRefresh(value => value + 1);
    } finally { setBusy(false); }
  };

  const cancel = async () => {
    if (!flowId || terminalFlow.current) return;
    setBusy(true);
    try {
      const result = await getPluginGmailAuth(agentId, flowId, true);
      if (terminalFlow.current) return;
      if (!["pending", "verifying"].includes(result.status)) terminalFlow.current = true;
      setFlow(result);
      if (!["pending", "verifying"].includes(result.status)) {
        setFlowId(null);
        try { sessionStorage.removeItem(key); } catch { /* UI state is still updated. */ }
        if (result.status === "ready") readyCallback.current();
      }
    } catch { setError("GMAIL_AUTH_FAILED"); }
    finally { setBusy(false); }
  };

  const reconcile = async () => {
    if (busy || !recoveryPending || recoveryStatus !== "ready") return;
    setBusy(true); setRecoveryOutcome(null);
    try {
      const result = await reconcilePluginGmailAuth({ agentId, installationId, componentId,
        expectedRevision: revision, email: recoveryPending.email });
      if (result.canceled) { setRecoveryOutcome("canceled"); return; }
      if (!result.recovered) { setRecoveryOutcome("blocked"); return; }
      setRecoveryPending(null); setError(null); setFlow(null); setFlowId(null);
      terminalFlow.current = false;
      setRecoveryOutcome("recovered");
    } catch (failure) {
      setRecoveryOutcome(failure instanceof ApiError
        && failure.code === "GMAIL_AUTH_RECOVERY_REQUIRED" ? "blocked" : "failed");
    } finally { setBusy(false); }
  };

  return <div className={styles.control} data-gmail-connect>
    <form className={styles.form} onSubmit={event => void submit(event)}>
      <label>{t("plugins.gmailAuthEmail")}
        <input type="email" autoComplete="email" value={email} maxLength={254}
          disabled={disabled || busy || Boolean(flowId) || recoveryRequired || recoveryStatus !== "ready"}
          onChange={event => { setEmail(event.currentTarget.value); setError(null); }} />
      </label>
      <button className="btn-secondary" type="submit" disabled={disabled || busy || Boolean(flowId) || recoveryRequired
        || recoveryStatus !== "ready"
        || !EMAIL.test(email.trim())}>
        {t(connected ? "plugins.gmailAuthReconnect" : "plugins.gmailAuthConnect")}
      </button>
    </form>
    {flowId && <p className={styles.state} role="status">{t(flow?.status === "verifying"
      ? "plugins.gmailAuthVerifying" : "plugins.gmailAuthPending")}</p>}
    {flowId && <button className="btn-secondary" type="button" disabled={busy}
      onClick={() => void cancel()}>{t("plugins.gmailAuthCancel")}</button>}
    {recoveryRequired && !flowId && <p className={styles.state} role="alert">
      {t("plugins.gmailAuthRecoveryRequired")}</p>}
    {recoveryRequired && !flowId && recoveryPending && recoveryStatus === "ready" &&
      <button className="btn-secondary" type="button" data-gmail-reconcile disabled={busy}
        onClick={() => void reconcile()}>{t(busy
          ? "plugins.gmailAuthRecoveryChecking" : "plugins.gmailAuthRecoveryCheck")}</button>}
    {flow && !flowId && !recoveryRequired && <p className={styles.state} role="status">{t(flow.status === "ready"
      ? "plugins.gmailAuthReady" : flow.status === "canceled"
        ? "plugins.gmailAuthCanceled" : "plugins.gmailAuthFailed")}</p>}
    {error && !recoveryRequired && <p className={styles.state} role="alert">{t(error === "GMAIL_AUTH_INVALID"
      ? "plugins.gmailAuthInvalid" : "plugins.gmailAuthFailed")}</p>}
    {recoveryStatus === "unavailable" && !flowId && <p className={styles.state} role="alert">
      {t("plugins.gmailAuthRecoveryStatusUnavailable")}</p>}
    {recoveryRequired && !recoveryPending && recoveryStatus === "ready" && <p className={styles.state} role="alert">
      {t("plugins.gmailAuthRecoveryRecordUnavailable")}</p>}
    {recoveryOutcome && <p className={styles.state}
      role={recoveryOutcome === "recovered" || recoveryOutcome === "canceled" ? "status" : "alert"}>
      {t(recoveryOutcome === "recovered" ? "plugins.gmailAuthRecoveryRecovered"
        : recoveryOutcome === "canceled" ? "plugins.gmailAuthRecoveryCanceled"
          : recoveryOutcome === "blocked" ? "plugins.gmailAuthRecoveryBlocked"
            : "plugins.gmailAuthRecoveryFailed")}</p>}
  </div>;
}
