import { useEffect, useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, configurePluginSlackRegistration, getPluginSlackRegistrationStatus,
  type PluginSlackRegistrationStatus, type PluginSlackAccessProfile } from "../api/client";
import { SLACK_ACCESS_PROFILES, slackProfileTranslation } from "../lib/slackAccessProfiles";
import styles from "./PluginGraphRegistration.module.css";

export function PluginSlackRegistration() {
  const { t } = useTranslation();
  const clientIdInput = useId();
  const portInput = useId();
  const profileInput = useId();
  const [accessProfile, setAccessProfile] = useState<PluginSlackAccessProfile>("public-search");
  const [status, setStatus] = useState<PluginSlackRegistrationStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [redirectPort, setRedirectPort] = useState(49152);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"invalid" | "conflict" | "failed" | "unavailable" | null>(null);
  const [canceled, setCanceled] = useState(false);

  useEffect(() => {
    let active = true;
    void getPluginSlackRegistrationStatus().then(value => {
      if (active) { setStatus(value); setError(null); }
    }).catch(cause => {
      if (!active) return;
      setStatus(null);
      setError(cause instanceof ApiError && cause.code === "SLACK_REGISTRATION_CONFLICT"
        ? "conflict" : "unavailable");
    });
    return () => { active = false; };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || status?.configured !== false) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const clientId = String(values.get("clientId") || "").trim();
    const redirectPort = Number(values.get("redirectPort"));
    if (!/^[0-9]{3,20}\.[0-9]{3,20}$/u.test(clientId)
      || !Number.isSafeInteger(redirectPort) || redirectPort < 1024
      || redirectPort > 65535) { setError("invalid"); return; }
    setBusy(true); setError(null); setCanceled(false);
    try {
      const result = await configurePluginSlackRegistration({ clientId, redirectPort,
        scopes: [...SLACK_ACCESS_PROFILES.find(item => item.id === accessProfile)!.scopes] });
      if (result.canceled) { setCanceled(true); return; }
      if (!result.configured) { setError("failed"); return; }
      form.reset();
      setStatus({ configured: true, restartRequired: result.restartRequired, accessProfile });
      setOpen(false);
    } catch (cause) {
      form.reset();
      if (cause instanceof ApiError && cause.code === "SLACK_REGISTRATION_INVALID") {
        setError("invalid"); return;
      }
      // An uncertain reply may follow a committed private write. Observe the
      // original state before offering another registration attempt.
      try {
        const current = await getPluginSlackRegistrationStatus();
        setStatus(current);
        if (current.configured) setOpen(false);
        else setError("failed");
      } catch (statusCause) {
        setStatus(null);
        setError(statusCause instanceof ApiError
          && statusCause.code === "SLACK_REGISTRATION_CONFLICT"
          ? "conflict" : "unavailable");
      }
    } finally { setBusy(false); }
  };

  const displayedProfile = SLACK_ACCESS_PROFILES.find(item => item.id === (status?.configured
    ? status.accessProfile : accessProfile));

  return <section className={styles.control} data-slack-registration
    aria-label={t("plugins.slackRegistrationTitle")}>
    <div className={styles.heading}>
      <strong>{t("plugins.slackRegistrationTitle")}</strong>
      <span className={styles.shared}>{t("plugins.slackOfficialBadge")}</span>
    </div>
    <p className={styles.intro}>{t("plugins.slackRegistrationIntro")}</p>
    <dl className={styles.facts}>
      <div><dt>{t("plugins.slackRegistrationServer")}</dt>
        <dd><code>https://mcp.slack.com/mcp</code></dd></div>
      <div><dt>{t("plugins.slackRegistrationPermission")}</dt>
        <dd>{displayedProfile ? <>{t(slackProfileTranslation(displayedProfile.id))}<br />
          <code>{displayedProfile.scopes.join(", ")}</code></>
          : t("plugins.slackAccessUnavailable")}</dd></div>
    </dl>
    {status?.configured ? <p className={styles.state} role="status">{t(status.restartRequired
      ? "plugins.slackRegistrationRestart" : "plugins.slackRegistrationConfigured")}</p>
      : status === null ? <p className={styles.state} role={error ? "alert" : "status"}>{t(error === "conflict"
        ? "plugins.slackRegistrationConflict" : error
          ? "plugins.slackRegistrationUnavailable" : "plugins.mcpStatusLoading")}</p>
        : <>
          <button className="btn-secondary" type="button" disabled={busy} aria-expanded={open}
            onClick={() => { setOpen(value => !value); setError(null); setCanceled(false); }}>
            {t("plugins.slackRegistrationOpen")}</button>
          {open && <form className={styles.form} onSubmit={event => void submit(event)} autoComplete="off">
            <label htmlFor={profileInput}>{t("plugins.slackAccessLabel")}</label>
            <select className="field-input" id={profileInput} name="accessProfile" value={accessProfile}
              disabled={busy} onChange={event => {
                const selected = SLACK_ACCESS_PROFILES.find(item => item.id === event.currentTarget.value);
                if (selected) setAccessProfile(selected.id);
              }}>
              {SLACK_ACCESS_PROFILES.map(item => <option key={item.id} value={item.id}>
                {t(slackProfileTranslation(item.id))}</option>)}
            </select>
            <p className={styles.formHint}>{t("plugins.slackAccessHint")}</p>
            <label htmlFor={clientIdInput}>{t("plugins.slackRegistrationClientId")}</label>
            <input className="field-input" id={clientIdInput} name="clientId" required
              maxLength={41} disabled={busy} autoComplete="off" spellCheck={false} />
            <label htmlFor={portInput}>{t("plugins.slackRegistrationPort")}</label>
            <input className="field-input" id={portInput} name="redirectPort" type="number"
              min={1024} max={65535} step={1} value={redirectPort} required disabled={busy}
              onChange={event => setRedirectPort(Number(event.currentTarget.value))} />
            <p className={styles.formHint}>{t("plugins.slackRegistrationPortHint", { port: redirectPort })}</p>
            <div className={styles.actions}>
              <button className="btn-secondary" type="button" disabled={busy}
                onClick={() => { setOpen(false); setError(null); setCanceled(false); }}>
                {t("common.cancel")}</button>
              <button className="btn-secondary" type="submit" disabled={busy}>
                {t(busy ? "plugins.slackRegistrationSaving" : "plugins.slackRegistrationSave")}</button>
            </div>
          </form>}
        </>}
    {canceled && <p className={styles.state} role="status">{t("plugins.slackRegistrationCanceled")}</p>}
    {error && status !== null && <p className={styles.state} role="alert">{t(error === "invalid"
      ? "plugins.slackRegistrationInvalid" : "plugins.slackRegistrationFailed")}</p>}
  </section>;
}
