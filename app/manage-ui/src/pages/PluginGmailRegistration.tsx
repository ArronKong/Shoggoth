import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, configurePluginGmailRegistration, getPluginGmailRegistrationStatus,
  type PluginGmailRegistrationStatus } from "../api/client";
import { PluginGmailCapabilities } from "./PluginGmailCapabilities";
import styles from "./PluginGraphRegistration.module.css";

type ErrorState = "invalid" | "conflict" | "failed" | "unavailable" | null;

export function PluginGmailRegistration({ children, showCapabilities = false, onCapabilitiesChanged }: {
  children?: ReactNode; showCapabilities?: boolean; onCapabilitiesChanged?: () => void;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<PluginGmailRegistrationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorState>(null);
  const [canceled, setCanceled] = useState(false);

  useEffect(() => {
    let active = true;
    void getPluginGmailRegistrationStatus().then(value => {
      if (active) { setStatus(value); setError(null); }
    }).catch(cause => {
      if (!active) return;
      setStatus(null);
      setError(cause instanceof ApiError && cause.code === "GMAIL_REGISTRATION_CONFLICT"
        ? "conflict" : "unavailable");
    });
    return () => { active = false; };
  }, []);

  const configure = async () => {
    if (busy || !status?.runtimeAvailable || status.configured) return;
    setBusy(true); setError(null); setCanceled(false);
    try {
      const receipt = await configurePluginGmailRegistration();
      if (receipt.canceled) { setCanceled(true); return; }
      if (!receipt.configured) { setError("failed"); return; }
      setStatus(receipt);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "GMAIL_REGISTRATION_INVALID") {
        setError("invalid"); return;
      }
      // A lost reply could follow an imported client. Read the saved state
      // before offering another import; never submit the dialog result twice.
      try {
        const current = await getPluginGmailRegistrationStatus();
        setStatus(current);
        if (!current.configured) setError(cause instanceof ApiError
          && cause.code === "GMAIL_REGISTRATION_CONFLICT" ? "conflict" : "failed");
      } catch (statusCause) {
        setStatus(null);
        setError(statusCause instanceof ApiError
          && statusCause.code === "GMAIL_REGISTRATION_CONFLICT" ? "conflict" : "unavailable");
      }
    } finally { setBusy(false); }
  };

  const unavailable = status && !status.runtimeAvailable;
  return <section className={styles.control} data-gmail-registration
    aria-label={t("plugins.gmailRegistrationTitle")}>
    <div className={styles.heading}>
      <strong>{t("plugins.gmailRegistrationTitle")}</strong>
      <span className={styles.shared}>{t("plugins.gmailGogcliBadge")}</span>
    </div>
    <p className={styles.intro}>{t("plugins.gmailRegistrationIntro")}</p>
    <dl className={styles.facts}>
      <div><dt>{t("plugins.gmailRegistrationServer")}</dt>
        <dd><code>gog mcp · v0.42.0</code></dd></div>
      <div><dt>{t("plugins.gmailRegistrationClient")}</dt>
        <dd>{t("plugins.gmailRegistrationClientValue")}</dd></div>
    </dl>
    <p className={styles.formHint}>{t("plugins.gmailRegistrationClientHint")}</p>
    <p className={styles.scopeWarning}>{t("plugins.gmailRegistrationScopeWarning")}</p>
    {unavailable && <p className={styles.state} role="alert">{t("plugins.gmailRegistrationRuntimeUnavailable")}</p>}
    {status?.configured && <p className={styles.state} role="status">{t(status.restartRequired
      ? "plugins.gmailRegistrationRestart" : "plugins.gmailRegistrationConfigured")}</p>}
    {status === null && <p className={styles.state} role={error ? "alert" : "status"}>{t(error === "conflict"
      ? "plugins.gmailRegistrationConflict" : error
        ? "plugins.gmailRegistrationUnavailable" : "plugins.mcpStatusLoading")}</p>}
    {status && !status.configured && <button className="btn-secondary" type="button"
      disabled={busy || !status.runtimeAvailable} onClick={() => void configure()}>
      {t(busy ? "plugins.gmailRegistrationSaving" : "plugins.gmailRegistrationOpen")}</button>}
    {canceled && <p className={styles.state} role="status">{t("plugins.gmailRegistrationCanceled")}</p>}
    {error && status !== null && <p className={styles.state} role="alert">{t(error === "invalid"
      ? "plugins.gmailRegistrationInvalid" : error === "conflict"
        ? "plugins.gmailRegistrationConflict" : "plugins.gmailRegistrationFailed")}</p>}
    {status?.configured && status.runtimeAvailable && !status.restartRequired && <>
      {showCapabilities && <PluginGmailCapabilities onChanged={onCapabilitiesChanged} />}
      {children}
    </>}
  </section>;
}
