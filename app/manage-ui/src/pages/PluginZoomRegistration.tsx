import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { configurePluginZoomRegistration, getPluginZoomRegistrationStatus,
  type PluginZoomRegistrationStatus } from "../api/client";
import styles from "./PluginZoomRegistration.module.css";

const MEETING_SCOPES = ["meeting:read:search", "meeting:read:assets",
  "cloud_recording:read:list_user_recordings", "cloud_recording:read:content"];

export function PluginZoomRegistration() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<PluginZoomRegistrationStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"invalid" | "unavailable" | null>(null);

  useEffect(() => {
    let active = true;
    void getPluginZoomRegistrationStatus().then(value => {
      if (active) { setStatus(value); setError(null); }
    }).catch(() => {
      if (active) { setStatus(null); setError("unavailable"); }
    });
    return () => { active = false; };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || status?.configured !== false) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const clientId = String(data.get("clientId") || "").trim();
    const clientSecret = String(data.get("clientSecret") || "");
    const redirectPort = Number(data.get("redirectPort"));
    const scopes = ["user:read:user", ...data.getAll("meetingScope").map(String)];
    form.reset();
    if (!/^[A-Za-z0-9._-]{10,128}$/u.test(clientId) || clientId.startsWith("ZOOM_")
      || !/^[\x21-\x7e]{8,512}$/u.test(clientSecret)
      || !Number.isSafeInteger(redirectPort) || redirectPort < 1024 || redirectPort > 65535
      || scopes.length < 2 || scopes.some(scope =>
        scope !== "user:read:user" && !MEETING_SCOPES.includes(scope))) {
      setError("invalid");
      return;
    }
    setBusy(true); setError(null);
    try {
      const result = await configurePluginZoomRegistration({ clientId, clientSecret,
        redirectPort, scopes });
      if (result.configured) {
        setStatus({ configured: true, restartRequired: result.restartRequired });
        setOpen(false);
      }
    } catch {
      // A lost reply can follow a committed write. Check the original state before
      // offering the form again; never resend a client secret automatically.
      try {
        const current = await getPluginZoomRegistrationStatus();
        setStatus(current);
        if (!current.configured) setError("unavailable");
        else setOpen(false);
      } catch {
        setStatus(null);
        setError("unavailable");
      }
    } finally { setBusy(false); }
  };

  return <div className={styles.control} data-zoom-registration>
    <strong>{t("plugins.zoomRegistrationTitle")}</strong>
    <span className={styles.hint}>{t("plugins.zoomRegistrationIntro")}</span>
    {status?.configured ? <span role="status">{t(status.restartRequired
      ? "plugins.zoomRegistrationRestart" : "plugins.zoomRegistrationConfigured")}</span>
      : status === null ? <span role={error ? "alert" : "status"}>{t(error
        ? "plugins.zoomRegistrationUnavailable" : "plugins.mcpStatusLoading")}</span>
        : <>
          <button className="btn-secondary" type="button" disabled={busy} aria-expanded={open}
            onClick={() => { setOpen(value => !value); setError(null); }}>
            {t("plugins.zoomRegistrationOpen")}
          </button>
          {open && <form className={styles.form} onSubmit={event => void submit(event)} autoComplete="off">
            <label htmlFor="plugin-zoom-client-id">{t("plugins.zoomClientId")}</label>
            <input className="field-input" id="plugin-zoom-client-id" name="clientId"
              maxLength={128} disabled={busy} autoComplete="off" spellCheck={false} />
            <label htmlFor="plugin-zoom-client-secret">{t("plugins.zoomClientSecret")}</label>
            <input className="field-input" id="plugin-zoom-client-secret" name="clientSecret"
              type="password" maxLength={512} disabled={busy} autoComplete="off" spellCheck={false} />
            <label htmlFor="plugin-zoom-redirect-port">{t("plugins.zoomRedirectPort")}</label>
            <input className="field-input" id="plugin-zoom-redirect-port" name="redirectPort"
              type="number" min={1024} max={65535} disabled={busy} inputMode="numeric" />
            <span className={styles.hint}>{t("plugins.zoomRedirectHint")}</span>
            <fieldset className={styles.scopes} disabled={busy}>
              <legend>{t("plugins.zoomMeetingScopes")}</legend>
              {MEETING_SCOPES.map(scope => <label key={scope}>
                <input type="checkbox" name="meetingScope" value={scope} />{scope}
              </label>)}
            </fieldset>
            <span className={styles.hint}>{t("plugins.zoomIdentityScope")}</span>
            <div className={styles.actions}>
              <button className="btn-secondary" type="button" disabled={busy} onClick={event => {
                event.currentTarget.closest("form")?.reset();
                setOpen(false); setError(null);
              }}>{t("common.cancel")}</button>
              <button className="btn-secondary" type="submit" disabled={busy}>
                {t(busy ? "plugins.zoomRegistrationSaving" : "plugins.zoomRegistrationSave")}
              </button>
            </div>
          </form>}
        </>}
    {error && status !== null && <span role="alert">{t(error === "invalid"
      ? "plugins.zoomRegistrationInvalid" : "plugins.zoomRegistrationFailed")}</span>}
  </div>;
}
