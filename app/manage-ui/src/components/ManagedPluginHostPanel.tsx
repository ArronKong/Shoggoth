import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getManagedPluginHostOperation, getManagedPluginHostStatus, runManagedPluginHostAction,
  type ManagedPluginHostBackend, type ManagedPluginHostAction, type ManagedPluginHostStatus } from "../lib/managedPluginHostApi";
import { clearManagedHostPending, readManagedHostPending, saveManagedHostPending } from "../lib/managedPluginHostRecovery";
import styles from "./ManagedPluginHostPanel.module.css";

const activeStates = new Set(["preparing", "activating", "stopping"]);
interface Scope { backendId: ManagedPluginHostBackend; live: boolean; checking: boolean; actionBusy: boolean;
  pending: string | null; recoveryUnavailable: boolean; controllers: Set<AbortController>; }

export function ManagedPluginHostPanel({ backendId = "openclaw", onModeObserved }: { backendId?: ManagedPluginHostBackend;
  onModeObserved?: (backendId: ManagedPluginHostBackend, mode: "existing" | "managed") => void }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ManagedPluginHostStatus | null>(null);
  const [checking, setChecking] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState(false);
  const current = useRef<Scope | null>(null), uncertainChecks = useRef(0);
  const value = status?.backendId === backendId ? status : null;
  const active = !!value && activeStates.has(value.state);
  const isCurrent = (scope: Scope) => current.current === scope && scope.live && scope.backendId === backendId;
  function consume(scope: Scope, result: ManagedPluginHostStatus | null, expected: string | null) {
    if (!isCurrent(scope)) return;
    setStatus(result); setError(false);
    if (!result || (expected && result.operationId !== expected)) {
      if (expected) setUncertain(true);
      return;
    }
    onModeObserved?.(scope.backendId, result.mode);
    setUncertain(false);
    if (expected && !activeStates.has(result.state) && result.state !== "needs_verification") {
      clearManagedHostPending(scope.backendId, expected);
      scope.pending = null;
    }
  }
  async function observe() {
    const scope = current.current;
    if (!scope || !isCurrent(scope) || scope.checking) return;
    scope.checking = true; setChecking(true);
    const controller = new AbortController(); scope.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 10000);
    let original = scope.pending;
    try {
      if (scope.recoveryUnavailable) {
        scope.pending = readManagedHostPending(scope.backendId); scope.recoveryUnavailable = false; original = scope.pending;
      }
      const result = original ? await getManagedPluginHostOperation(scope.backendId, original, controller.signal)
        : await getManagedPluginHostStatus(scope.backendId, controller.signal);
      consume(scope, result, original);
    } catch { if (isCurrent(scope)) { setError(true); if (original) setUncertain(true); } }
    finally {
      clearTimeout(timeout); scope.controllers.delete(controller); scope.checking = false;
      if (isCurrent(scope)) setChecking(false);
    }
  }
  useEffect(() => {
    const scope: Scope = { backendId, live: true, checking: false, actionBusy: false, pending: null, recoveryUnavailable: false, controllers: new Set() };
    current.current = scope; uncertainChecks.current = 0;
    setStatus(null); setChecking(false); setError(false); setUncertain(false);
    try { scope.pending = readManagedHostPending(backendId); setUncertain(scope.pending !== null); void observe(); }
    catch { scope.recoveryUnavailable = true; setUncertain(true); setError(true); }
    return () => { scope.live = false; for (const controller of scope.controllers) controller.abort(); };
  }, [backendId]);
  useEffect(() => {
    if (!active && !uncertain) return;
    if (uncertain && !active && uncertainChecks.current >= 5) return;
    // A lost receipt observes only its persisted original ID, including after remount.
    const timer = setTimeout(() => { uncertainChecks.current += 1; void observe(); }, 1500);
    return () => clearTimeout(timer);
  }, [backendId, active, uncertain, checking, value]);
  async function run(action: ManagedPluginHostAction) {
    const scope = current.current;
    if (!scope || !isCurrent(scope) || scope.actionBusy || scope.checking || active || uncertain) return;
    const operationId = crypto.randomUUID();
    // Persist before dispatch. Failure here performs no action.
    try { saveManagedHostPending(scope.backendId, operationId); }
    catch { setError(true); return; }
    uncertainChecks.current = 0; scope.pending = operationId; scope.actionBusy = true; scope.checking = true;
    setChecking(true); setError(false);
    const controller = new AbortController(); scope.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 10000);
    try { consume(scope, await runManagedPluginHostAction(scope.backendId, action, operationId, controller.signal), operationId); }
    catch { if (isCurrent(scope)) { setUncertain(true); setError(true); } }
    finally {
      clearTimeout(timeout); scope.controllers.delete(controller); scope.actionBusy = false; scope.checking = false;
      if (isCurrent(scope)) setChecking(false);
    }
  }
  if (!value && !error && !uncertain) return null;
  const needsVerification = uncertain || value?.state === "needs_verification" || (value?.state === "running" && !value.selectionSupported);
  const state = value?.state || "needs_verification", titleId = `managed-${backendId}-title`;
  return <section className={`settings-section ${styles.panel}`} aria-labelledby={titleId} data-managed-plugin-host={backendId}>
    <h3 className="settings-h" id={titleId}>{t(`managedPluginHost.${backendId}.title`)}</h3>
    <p className="settings-sech">{t("managedPluginHost.description")}</p>
    <div className={styles.status} role="status" aria-live="polite">
      {t(`managedPluginHost.state.${needsVerification ? "needs_verification" : state}`)}
    </div>
    {value?.state === "running" && value.selectionSupported && !needsVerification && <p className="muted">{t(`managedPluginHost.${backendId}.configureModels`)}</p>}
    {needsVerification && <p className="muted">{t("managedPluginHost.verification")}</p>}
    {value?.errorCode && /(?:INPUT|VERSION|ARCH|INTERPRETER|LOCAL_RUNTIME|SOURCE)/u.test(value.errorCode)
      && <p className="muted">{t(`managedPluginHost.${backendId}.unsupported`)}</p>}
    {error && <p className="error" role="alert">{t("managedPluginHost.error")}</p>}
    <div className={styles.actions}>
      {value?.mode === "existing" && !needsVerification && <button className="ui-cbtn" disabled={checking || active || uncertain}
        onClick={() => void run("prepare")}>{t("managedPluginHost.prepare")}</button>}
      {value?.mode === "managed" && !active && !uncertain && ["stopped", "failed"].includes(state) && <button className="ui-cbtn"
        disabled={checking} onClick={() => void run("prepare")}>{t("managedPluginHost.start")}</button>}
      {state === "running" && !needsVerification && <>
        <button className="ui-cbtn" disabled={checking || uncertain} onClick={() => void run("restart")}>{t("managedPluginHost.restart")}</button>
        <button className="ui-cbtn ui-cbtn--danger" disabled={checking || uncertain} onClick={() => void run("stop")}>{t("managedPluginHost.stop")}</button>
      </>}
      {value?.mode === "managed" && needsVerification && !uncertain && <button className="ui-cbtn ui-cbtn--danger"
        disabled={checking} onClick={() => void run("stop")}>{t("managedPluginHost.stop")}</button>}
      <button className="ui-cbtn" disabled={checking} onClick={() => void observe()}>{t("managedPluginHost.check")}</button>
    </div>
  </section>;
}
