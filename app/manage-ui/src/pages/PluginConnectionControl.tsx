import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { disconnectPluginConnection, getPluginDisconnectOperation,
  type PluginDisconnectReceipt, type PluginDisconnectRequest } from "../api/client";

export function PluginConnectionControl({ agentId, bindingId, revision, disabled, connected, onDisconnected }: {
  agentId: string; bindingId: string; revision: number; disabled: boolean; connected: boolean; onDisconnected: () => void;
}) {
  const { t } = useTranslation();
  const key = `shoggoth.plugin.disconnect.${agentId}.${bindingId}`;
  const [pending, setPending] = useState<PluginDisconnectRequest | null>(null);
  const [receipt, setReceipt] = useState<PluginDisconnectReceipt | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [unknown, setUnknown] = useState(false);
  const generation = useRef(0), callback = useRef(onDisconnected); callback.current = onDisconnected;
  const latestBinding = useRef({ revision, connected }); latestBinding.current = { revision, connected };
  const remember = (value: PluginDisconnectRequest | null) => {
    setPending(value);
    try { if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key); }
    catch { /* The request remains recoverable within this mounted component. */ }
  };
  const acceptReceipt = (value: PluginDisconnectReceipt) => {
    if (latestBinding.current.connected && latestBinding.current.revision > value.revision) {
      setReceipt(null); remember(null); return false;
    }
    setReceipt(value);
    if (value.cleanupStatus === "complete") remember(null);
    return true;
  };
  useEffect(() => {
    const current = ++generation.current;
    setPending(null); setReceipt(null); setError(false); setUnknown(false); setBusy(false);
    let value: PluginDisconnectRequest | null = null;
    try {
      const stored = JSON.parse(sessionStorage.getItem(key) || "null");
      if (stored && Object.keys(stored).length === 4 && stored.agentId === agentId && stored.bindingId === bindingId
        && Number.isSafeInteger(stored.expectedRevision) && stored.expectedRevision > 0
        && typeof stored.operationId === "string" && /^[\w.-]{1,128}$/u.test(stored.operationId)) value = stored;
    } catch { /* Invalid optional recovery state supplies no authority. */ }
    if (value) {
      setPending(value); setBusy(true);
      void getPluginDisconnectOperation(agentId, value.operationId).then(result => {
        if (generation.current !== current) return;
        setUnknown(result.phase === "outcome_unknown");
        if (result.receipt) {
          if (acceptReceipt(result.receipt)) callback.current();
        }
      }).catch(() => { if (generation.current === current) setError(true); })
        .finally(() => { if (generation.current === current) setBusy(false); });
    }
    return () => { generation.current += 1; };
  }, [agentId, bindingId, key]);
  const disconnect = async () => {
    const current = generation.current;
    const request = pending || { agentId, bindingId, expectedRevision: revision, operationId: crypto.randomUUID() };
    remember(request); setBusy(true); setError(false);
    try {
      const result = await disconnectPluginConnection(request);
      if (generation.current !== current) return;
      if (result.canceled) { if (!receipt) remember(null); return; }
      if (result.receipt && acceptReceipt(result.receipt)) callback.current();
    } catch {
      if (generation.current !== current) return;
      setError(true);
      try {
        const result = await getPluginDisconnectOperation(agentId, request.operationId);
        if (generation.current !== current) return;
        setUnknown(result.phase === "outcome_unknown");
        if (result.receipt) {
          setError(false);
          if (acceptReceipt(result.receipt)) callback.current();
        }
      } catch { /* Preserve the exact operation ID; never silently submit a new mutation. */ }
    } finally { if (generation.current === current) setBusy(false); }
  };
  if (!connected && !pending && !receipt) return null;
  return <>
    {(connected || pending) && <button className="btn-secondary" type="button"
      disabled={disabled || busy || unknown} onClick={() => void disconnect()}>
      {t(receipt?.cleanupStatus === "pending" ? "plugins.disconnectRetry" : "plugins.disconnect")}
    </button>}
    {receipt && <span role="status">{t(receipt.cleanupStatus === "complete"
      ? "plugins.disconnected" : "plugins.disconnectCleanupPending")}</span>}
    {unknown && <span role="alert">{t("plugins.disconnectUnknown")}</span>}
    {error && <span role="alert">{t("plugins.disconnectFailed")}</span>}
  </>;
}
