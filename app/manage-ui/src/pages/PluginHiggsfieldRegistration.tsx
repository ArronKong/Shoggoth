import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, configurePluginHiggsfieldRegistration, getPluginHiggsfieldRegistrationStatus,
  reconcilePluginHiggsfieldRegistration,
  type PluginHiggsfieldRegistrationStatus } from "../api/client";
import styles from "./PluginGraphRegistration.module.css";

type ErrorState = "invalid" | "conflict" | "failed" | "reconcile" | "unavailable" | null;

export function PluginHiggsfieldRegistration() {
  const { t } = useTranslation();
  const inputId = useId();
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const [status, setStatus] = useState<PluginHiggsfieldRegistrationStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState<ErrorState>(null);
  const [canceled, setCanceled] = useState(false);

  useEffect(() => {
    let active = true;
    void getPluginHiggsfieldRegistrationStatus().then(value => {
      if (active) { setStatus(value); setError(null); }
    }).catch(cause => {
      if (!active) return;
      if (cause instanceof ApiError && cause.code === "HIGGSFIELD_REGISTRATION_CONFLICT") {
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
      const receipt = await configurePluginHiggsfieldRegistration({ redirectPort });
      if (receipt.canceled) { setCanceled(true); return; }
      if (!receipt.configured) { setError("failed"); return; }
      setStatus({ configured: true, restartRequired: receipt.restartRequired,
        needsVerification: false });
      setOpen(false);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "HIGGSFIELD_REGISTRATION_INVALID") {
        setError("invalid"); return;
      }
      if (cause instanceof ApiError && cause.code === "HIGGSFIELD_REGISTRATION_NEEDS_VERIFICATION") {
        setStatus({ configured: false, restartRequired: false, needsVerification: true });
        setOpen(false); return;
      }
      // DCR can succeed even when the reply is lost. Observe the stored client
      // before allowing another remote registration; never resend on our own.
      try {
        const current = await getPluginHiggsfieldRegistrationStatus();
        setStatus(current);
        if (current.configured || current.needsVerification) setOpen(false);
        else setError("failed");
      } catch (statusCause) {
        if (statusCause instanceof ApiError
          && statusCause.code === "HIGGSFIELD_REGISTRATION_CONFLICT") {
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
      const receipt = await reconcilePluginHiggsfieldRegistration();
      if (!receipt.canceled) setStatus({ configured: receipt.configured,
        restartRequired: receipt.restartRequired, needsVerification: receipt.needsVerification });
    } catch {
      try {
        const current = await getPluginHiggsfieldRegistrationStatus();
        setStatus(current);
        if (current.needsVerification) setError("reconcile");
      }
      catch { setStatus(null); setError("unavailable"); return; }
    } finally { setBusy(false); }
  };

  return <section className={styles.control} data-higgsfield-registration
    aria-label={t("plugins.higgsfieldRegistrationTitle")}>
    <div className={styles.heading}>
      <strong>{t("plugins.higgsfieldRegistrationTitle")}</strong>
      <span className={styles.shared}>{t("plugins.higgsfieldRegistrationIndependent")}</span>
    </div>
    <p className={styles.intro}>{t("plugins.higgsfieldRegistrationIntro")}</p>
    <dl className={styles.facts}>
      <div><dt>{t("plugins.higgsfieldRegistrationServer")}</dt>
        <dd><code>https://mcp.higgsfield.ai/mcp</code></dd></div>
      <div><dt>{t("plugins.higgsfieldRegistrationPermission")}</dt>
        <dd><code>openid email offline_access</code></dd></div>
    </dl>
    {status?.configured ? <p className={styles.state} role="status">{t(status.restartRequired
      ? "plugins.higgsfieldRegistrationRestart" : "plugins.higgsfieldRegistrationConfigured")}</p>
      : status?.needsVerification ? <>
        <p className={styles.state} role="alert">{t("plugins.higgsfieldRegistrationNeedsVerification")}</p>
        <button className="btn-secondary" type="button" disabled={busy}
          onClick={() => { void reconcile(); }}>
          {t(busy ? "plugins.higgsfieldRegistrationReconciling" : "plugins.higgsfieldRegistrationReconcile")}
        </button>
      </>
      : status === null ? <p className={styles.state} role={error ? "alert" : "status"}>{t(error
        ? "plugins.higgsfieldRegistrationUnavailable" : "plugins.mcpStatusLoading")}</p>
        : blocked ? <p className={styles.state} role="alert">{t("plugins.higgsfieldRegistrationConflict")}</p>
          : <>
            <button className="btn-secondary" type="button" disabled={busy} aria-expanded={open}
              ref={openButtonRef}
              onClick={() => { setOpen(value => !value); setError(null); setCanceled(false); }}>
              {t("plugins.higgsfieldRegistrationOpen")}</button>
            {open && <form className={styles.form} onSubmit={event => void submit(event)} autoComplete="off">
              <label htmlFor={inputId}>{t("plugins.higgsfieldRegistrationPort")}</label>
              <input className="field-input" id={inputId} name="redirectPort" type="number"
                min={1024} max={65535} step={1} defaultValue={45932} required disabled={busy} />
              <p className={styles.formHint}>{t("plugins.higgsfieldRegistrationPortHint")}</p>
              <div className={styles.actions}>
                <button className="btn-secondary" type="button" disabled={busy}
                  onClick={() => { openButtonRef.current?.focus(); setOpen(false); setError(null); setCanceled(false); }}>
                  {t("common.cancel")}</button>
                <button className="btn-secondary" type="submit" disabled={busy}>
                  {t(busy ? "plugins.higgsfieldRegistrationSaving" : "plugins.higgsfieldRegistrationSave")}</button>
              </div>
            </form>}
          </>}
    {canceled && <p className={styles.state} role="status">{t("plugins.higgsfieldRegistrationCanceled")}</p>}
    {error && status !== null && !blocked && <p className={styles.state} role="alert">{t(error === "invalid"
      ? "plugins.higgsfieldRegistrationInvalid" : error === "reconcile"
        ? "plugins.higgsfieldRegistrationReconcileFailed" : "plugins.higgsfieldRegistrationFailed")}</p>}
  </section>;
}
