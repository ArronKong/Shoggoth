import { useEffect, useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, configurePluginLovableRegistration, getPluginLovableRegistrationStatus,
  reconcilePluginLovableRegistration,
  type PluginLovableRegistrationStatus } from "../api/client";
import styles from "./PluginGraphRegistration.module.css";

type ErrorState = "invalid" | "conflict" | "failed" | "reconcile" | "unavailable" | null;

export function PluginLovableRegistration() {
  const { t } = useTranslation();
  const inputId = useId();
  const [status, setStatus] = useState<PluginLovableRegistrationStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState<ErrorState>(null);
  const [canceled, setCanceled] = useState(false);

  useEffect(() => {
    let active = true;
    void getPluginLovableRegistrationStatus().then(value => {
      if (active) { setStatus(value); setError(null); }
    }).catch(cause => {
      if (!active) return;
      if (cause instanceof ApiError && cause.code === "LOVABLE_REGISTRATION_CONFLICT") {
        setStatus({ configured: false, restartRequired: false, needsVerification: false });
        setBlocked(true); setError("conflict");
      } else { setStatus(null); setError("unavailable"); }
    });
    return () => { active = false; };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || blocked || status?.configured !== false || status.needsVerification) return;
    const redirectPort = Number(new FormData(event.currentTarget).get("redirectPort"));
    if (!Number.isSafeInteger(redirectPort) || redirectPort < 1024 || redirectPort > 65535) {
      setError("invalid"); return;
    }
    setBusy(true); setError(null); setCanceled(false);
    try {
      const receipt = await configurePluginLovableRegistration({ redirectPort });
      if (receipt.canceled) { setCanceled(true); return; }
      if (!receipt.configured) { setError("failed"); return; }
      setStatus({ configured: true, restartRequired: receipt.restartRequired,
        needsVerification: false });
      setOpen(false);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "LOVABLE_REGISTRATION_INVALID") {
        setError("invalid"); return;
      }
      if (cause instanceof ApiError && cause.code === "LOVABLE_REGISTRATION_NEEDS_VERIFICATION") {
        setStatus({ configured: false, restartRequired: false, needsVerification: true });
        setOpen(false); return;
      }
      // DCR can succeed even when the reply is lost. Observe the stored client
      // before allowing another remote registration; never resend on our own.
      try {
        const current = await getPluginLovableRegistrationStatus();
        setStatus(current);
        if (current.configured || current.needsVerification) setOpen(false);
        else setError("failed");
      } catch (statusCause) {
        if (statusCause instanceof ApiError
          && statusCause.code === "LOVABLE_REGISTRATION_CONFLICT") {
          setStatus({ configured: false, restartRequired: false, needsVerification: false });
          setBlocked(true); setOpen(false); setError("conflict");
        } else { setStatus(null); setError("unavailable"); }
      }
    } finally { setBusy(false); }
  };

  const reconcile = async () => {
    if (busy || status?.needsVerification !== true) return;
    setBusy(true); setError(null);
    try {
      const receipt = await reconcilePluginLovableRegistration();
      if (!receipt.canceled) setStatus({ configured: receipt.configured,
        restartRequired: receipt.restartRequired, needsVerification: receipt.needsVerification });
    } catch {
      try {
        const current = await getPluginLovableRegistrationStatus();
        setStatus(current);
        if (current.needsVerification) setError("reconcile");
      }
      catch { setStatus(null); setError("unavailable"); return; }
    } finally { setBusy(false); }
  };

  return <section className={styles.control} data-lovable-registration
    aria-label={t("plugins.lovableRegistrationTitle")}>
    <div className={styles.heading}>
      <strong>{t("plugins.lovableRegistrationTitle")}</strong>
      <span className={styles.shared}>{t("plugins.lovableRegistrationIndependent")}</span>
    </div>
    <p className={styles.intro}>{t("plugins.lovableRegistrationIntro")}</p>
    <dl className={styles.facts}>
      <div><dt>{t("plugins.lovableRegistrationServer")}</dt>
        <dd><code>https://mcp.lovable.dev</code></dd></div>
      <div><dt>{t("plugins.lovableRegistrationPermission")}</dt>
        <dd><code>workspaces:read</code></dd></div>
    </dl>
    {status?.configured ? <p className={styles.state} role="status">{t(status.restartRequired
      ? "plugins.lovableRegistrationRestart" : "plugins.lovableRegistrationConfigured")}</p>
      : status?.needsVerification ? <>
        <p className={styles.state} role="alert">{t("plugins.lovableRegistrationNeedsVerification")}</p>
        <button className="btn-secondary" type="button" disabled={busy}
          onClick={() => { void reconcile(); }}>
          {t(busy ? "plugins.lovableRegistrationReconciling" : "plugins.lovableRegistrationReconcile")}
        </button>
      </>
      : status === null ? <p className={styles.state} role={error ? "alert" : "status"}>{t(error
        ? "plugins.lovableRegistrationUnavailable" : "plugins.mcpStatusLoading")}</p>
        : blocked ? <p className={styles.state} role="alert">{t("plugins.lovableRegistrationConflict")}</p>
          : <>
            <button className="btn-secondary" type="button" disabled={busy} aria-expanded={open}
              onClick={() => { setOpen(value => !value); setError(null); setCanceled(false); }}>
              {t("plugins.lovableRegistrationOpen")}</button>
            {open && <form className={styles.form} onSubmit={event => void submit(event)} autoComplete="off">
              <label htmlFor={inputId}>{t("plugins.lovableRegistrationPort")}</label>
              <input className="field-input" id={inputId} name="redirectPort" type="number"
                min={1024} max={65535} step={1} defaultValue={45931} required disabled={busy} />
              <p className={styles.formHint}>{t("plugins.lovableRegistrationPortHint")}</p>
              <div className={styles.actions}>
                <button className="btn-secondary" type="button" disabled={busy}
                  onClick={() => { setOpen(false); setError(null); setCanceled(false); }}>
                  {t("common.cancel")}</button>
                <button className="btn-secondary" type="submit" disabled={busy}>
                  {t(busy ? "plugins.lovableRegistrationSaving" : "plugins.lovableRegistrationSave")}</button>
              </div>
            </form>}
          </>}
    {canceled && <p className={styles.state} role="status">{t("plugins.lovableRegistrationCanceled")}</p>}
    {error && status !== null && !blocked && <p className={styles.state} role="alert">{t(error === "invalid"
      ? "plugins.lovableRegistrationInvalid" : error === "reconcile"
        ? "plugins.lovableRegistrationReconcileFailed" : "plugins.lovableRegistrationFailed")}</p>}
  </section>;
}
