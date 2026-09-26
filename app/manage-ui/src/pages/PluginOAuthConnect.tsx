import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, connectPluginOAuth, getPluginOAuthFlow, type PluginOAuthFlow } from "../api/client";

export function PluginOAuthConnect({ agentId, installationId, componentId, revision, disabled, connected, onReady }: {
  agentId: string; installationId: string; componentId: string; revision: number;
  disabled: boolean; connected: boolean; onReady: () => void;
}) {
  const { t } = useTranslation();
  const key = `shoggoth.plugin.oauth.${agentId}.${installationId}.${componentId}`;
  const [flowId, setFlowId] = useState<string | null>(() => {
    try { const value = sessionStorage.getItem(key); return value && /^[\w-]{1,128}$/u.test(value) ? value : null; }
    catch { return null; }
  });
  const [flow, setFlow] = useState<PluginOAuthFlow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readyCallback = useRef(onReady);
  readyCallback.current = onReady;
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; }, []);
  const remember = (id: string | null) => {
    setFlowId(id);
    try { if (id) sessionStorage.setItem(key, id); else sessionStorage.removeItem(key); } catch { /* In-memory flow still works. */ }
  };
  useEffect(() => {
    if (!flowId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await getPluginOAuthFlow(agentId, flowId);
        if (!active) return;
        setFlow(value); setError(null);
        if (["starting", "pending", "exchanging"].includes(value.status)) timer = setTimeout(() => void poll(), 1500);
        else {
          try { sessionStorage.removeItem(key); } catch { /* Optional recovery hint. */ }
          setFlowId(null);
          if (value.status === "ready") readyCallback.current();
        }
      } catch (failure) {
        if (!active) return;
        setError(failure instanceof ApiError ? failure.code ?? "unavailable" : "unavailable");
        if (failure instanceof ApiError && failure.code === "PLUGIN_OAUTH_FLOW_NOT_FOUND") {
          try { sessionStorage.removeItem(key); } catch { /* Optional hint. */ }
          setFlowId(null); return;
        }
        timer = setTimeout(() => void poll(), 5000);
      }
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [agentId, flowId, key]);
  const connect = async () => {
    const current = generation.current;
    setBusy(true); setError(null); setFlow(null);
    try {
      const value = await connectPluginOAuth({ agentId, installationId, componentId,
        expectedRevision: revision, operationId: crypto.randomUUID() });
      if (current !== generation.current) {
        if (value.flow) {
          try { sessionStorage.setItem(key, value.flow.flowId); }
          catch { await getPluginOAuthFlow(agentId, value.flow.flowId, true).catch(() => {}); }
        }
        return;
      }
      if (value.flow) remember(value.flow.flowId);
    } catch (failure) {
      if (current === generation.current) setError(failure instanceof ApiError ? failure.code ?? "unavailable" : "unavailable");
    } finally { if (current === generation.current) setBusy(false); }
  };
  const cancel = async () => {
    if (!flowId) return;
    const current = generation.current;
    setBusy(true);
    try {
      const value = await getPluginOAuthFlow(agentId, flowId, true);
      if (current === generation.current) { setFlow(value); remember(null); }
    } catch { if (current === generation.current) setError("unavailable"); }
    finally { if (current === generation.current) setBusy(false); }
  };
  return <>
    <button className="btn-secondary" type="button" disabled={disabled || busy || Boolean(flowId)} onClick={() => void connect()}>
      {t(connected ? "plugins.oauthReconnect" : "plugins.oauthConnect")}
    </button>
    {flowId && <><span role="status">{t("plugins.oauthPending")}</span>
      <button className="btn-secondary" type="button" disabled={busy} onClick={() => void cancel()}>{t("plugins.oauthCancel")}</button></>}
    {flow && !flowId && <span role="status">{t(flow.status === "ready" ? "plugins.oauthReady" : "plugins.oauthEnded")}</span>}
    {error && <span role="alert">{t(error === "PLUGIN_OAUTH_PROVIDER_UNSUPPORTED" ? "plugins.oauthUnconfigured" : "plugins.oauthFailed")}</span>}
  </>;
}
