import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { changePluginRollback, getPluginRollbackOperation, listPluginRollback,
  type PluginRollbackChange, type PluginRollbackReceipt, type PluginRollbackState } from "../api/client";
import styles from "./PluginRollbackControl.module.css";

export function PluginRollbackControl({ installationId, revision, enabled, disabled, onChanged }: {
  installationId: string; revision: number; enabled: boolean; disabled: boolean; onChanged: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const [state, setState] = useState<PluginRollbackState | null>(null);
  const [target, setTarget] = useState(""), [snapshotId, setSnapshotId] = useState("");
  const [receipt, setReceipt] = useState<PluginRollbackReceipt | null>(null);
  const [pendingOperation, setPendingOperation] = useState<string | null>(null);
  const generation = useRef(0);
  const key = `shoggoth.plugin.rollback.${installationId}`;
  const remember = (value: string | null) => {
    setPendingOperation(value);
    try { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key); } catch { /* Query durable pending intents after reload. */ }
  };
  useEffect(() => {
    const current = ++generation.current;
    setBusy(false); setError(false); setState(null); setTarget(""); setSnapshotId("");
    if (!open) return () => { generation.current++; };
    try { setPendingOperation(sessionStorage.getItem(key)); } catch { setPendingOperation(null); }
    void listPluginRollback(installationId).then(value => {
      if (generation.current !== current) return;
      setState(value);
      setTarget(value.releases.find(item => item.digest !== value.codeDigest)?.digest || "");
      setSnapshotId(value.snapshots.find(item => item.releaseDigest === value.codeDigest)?.snapshotId || "");
    }).catch(() => { if (generation.current === current) setError(true); });
    return () => { generation.current++; };
  }, [installationId, revision, key, open]);
  const checkOperation = async (operationId: string) => {
    const current = generation.current;
    setBusy(true);
    try {
      const found = await getPluginRollbackOperation(installationId, operationId);
      const latest = await listPluginRollback(installationId);
      if (generation.current !== current) return;
      setState(latest);
      if (found.receipt) { setReceipt(found.receipt); remember(null); setError(false); await onChanged(); }
      else setError(true);
    } catch { if (generation.current === current) setError(true); }
    finally { if (generation.current === current) setBusy(false); }
  };
  const change = async (selection: { action: "snapshot" } | { action: "code"; targetDigest: string }
    | { action: "restore"; snapshotId: string; snapshotDigest: string } | { action: "retry"; operationId: string }) => {
    const current = generation.current;
    const operationId = "operationId" in selection ? selection.operationId : crypto.randomUUID();
    remember(operationId); setBusy(true); setError(false);
    try {
      const result = await changePluginRollback({ ...selection, installationId,
        expectedRevision: state?.revision || revision, operationId } as PluginRollbackChange);
      if (generation.current !== current) return;
      if (result.canceled) { remember(null); return; }
      if (result.receipt) setReceipt(result.receipt);
      remember(null);
      const latest = await listPluginRollback(installationId);
      if (generation.current !== current) return;
      setState(latest); setSnapshotId(latest.snapshots.find(item => item.releaseDigest === latest.codeDigest)?.snapshotId || "");
      await onChanged();
    } catch {
      if (generation.current === current) { setError(true); await checkOperation(operationId); }
    } finally { if (generation.current === current) setBusy(false); }
  };
  const fence = state?.pending.some(item => item.state === "rollback_requires_data_restore");
  const otherPending = state?.pending.filter(item => item.state !== "rollback_requires_data_restore") || [];
  const locked = enabled || disabled || busy || !state;
  const snapshots = state?.snapshots.filter(item => item.releaseDigest === state.codeDigest) || [];
  const selectedSnapshot = snapshots.find(item => item.snapshotId === snapshotId);
  const targetHasSnapshot = Boolean(state?.snapshots.some(item => item.releaseDigest === target));
  const receiptText = receipt?.state === "snapshot_preserved" ? t("plugins.rollbackSnapshotSaved")
    : receipt?.state === "rollback_requires_data_restore" ? t("plugins.rollbackDataRequired") : t("plugins.rollbackRestored");
  return <div className={styles.control}>
    <button className="btn-secondary" type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{t("plugins.rollbackTitle")}</button>
    {open && <div className={styles.panel}>
      <p>{t("plugins.rollbackDescription")}</p>
      {enabled && <p>{t("plugins.rollbackDisableFirst")}</p>}
      {fence && <p role="status">{t("plugins.rollbackDataRequired")}</p>}
      <button className="btn-secondary" type="button" disabled={locked || Boolean(state?.pending.length) || Boolean(pendingOperation)}
        onClick={() => void change({ action: "snapshot" })}>{t("plugins.rollbackSnapshot")}</button>
      <label htmlFor={`rollback-code-${installationId}`}>{t("plugins.rollbackCodeVersion")}</label>
      <select id={`rollback-code-${installationId}`} value={target} onChange={event => setTarget(event.target.value)} disabled={locked || Boolean(state?.pending.length)}>
        <option value="">{t("plugins.rollbackNoVersion")}</option>
        {state?.releases.filter(item => item.digest !== state.codeDigest).map(item => <option key={item.digest} value={item.digest}>
          {item.version || item.name} · {item.digest.slice(0, 12)}
        </option>)}
      </select>
      {target && state && !targetHasSnapshot && <p role="status">{t("plugins.rollbackMissingTargetSnapshot")}</p>}
      <button className="btn-secondary" type="button" disabled={locked || !target || !targetHasSnapshot || Boolean(state?.pending.length) || Boolean(pendingOperation)}
        onClick={() => void change({ action: "code", targetDigest: target })}>{t("plugins.rollbackCode")}</button>
      <label htmlFor={`rollback-data-${installationId}`}>{t("plugins.rollbackSnapshotChoice")}</label>
      <select id={`rollback-data-${installationId}`} value={snapshotId} onChange={event => setSnapshotId(event.target.value)} disabled={locked || otherPending.length > 0}>
        <option value="">{t("plugins.rollbackNoSnapshot")}</option>
        {snapshots.map(item => <option key={item.snapshotId} value={item.snapshotId}>{new Date(item.createdAt).toLocaleString()} · {item.byteLength} B</option>)}
      </select>
      <button className="btn-secondary" type="button" disabled={locked || !selectedSnapshot || otherPending.length > 0 || Boolean(pendingOperation)}
        onClick={() => selectedSnapshot && void change({ action: "restore", snapshotId: selectedSnapshot.snapshotId,
          snapshotDigest: selectedSnapshot.snapshotDigest })}>{t("plugins.rollbackRestore")}</button>
      {otherPending.map(item => <div key={item.operationId} className={styles.pending}>
        <span>{item.phase === "outcome_unknown" ? t("plugins.rollbackUnknown") : t("plugins.rollbackPending")}</span>
        <button className="btn-secondary" type="button" disabled={busy} onClick={() => void checkOperation(item.operationId)}>{t("plugins.checkOperation")}</button>
        {item.action !== "other" && item.phase !== "outcome_unknown" && <button className="btn-secondary" type="button" disabled={locked}
          onClick={() => void change({ action: "retry", operationId: item.operationId })}>{t("plugins.rollbackContinue")}</button>}
      </div>)}
      {pendingOperation && !otherPending.some(item => item.operationId === pendingOperation) && <button className="btn-secondary" type="button"
        disabled={busy} onClick={() => void checkOperation(pendingOperation)}>{t("plugins.checkOperation")}</button>}
      {receipt && <p role="status">{receiptText}</p>}
      {error && <p role="alert">{t("plugins.rollbackFailed")}</p>}
    </div>}
  </div>;
}
