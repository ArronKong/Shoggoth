import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { configurePluginDropboxRegistration, getPluginDropboxRegistrationStatus,
  type PluginDropboxRegistrationStatus } from "../api/client";
import styles from "./PluginZoomRegistration.module.css";

export function PluginDropboxRegistration() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<PluginDropboxRegistrationStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"invalid" | "unavailable" | null>(null);

  useEffect(() => {
    let active = true;
    void getPluginDropboxRegistrationStatus().then(value => {
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
    form.reset();
    if (!/^[A-Za-z0-9_-]{8,128}$/u.test(clientId)
      || !/^[\x21-\x7e]{8,512}$/u.test(clientSecret)
      || !Number.isSafeInteger(redirectPort) || redirectPort < 1024 || redirectPort > 65535) {
      setError("invalid");
      return;
    }
    setBusy(true); setError(null);
    try {
      const result = await configurePluginDropboxRegistration({ clientId, clientSecret, redirectPort });
      if (result.configured) {
        setStatus(result);
        setOpen(false);
      }
    } catch {
      // A committed secret write may precede a lost reply. Inspect status and
      // never replay the secret automatically.
      try {
        const current = await getPluginDropboxRegistrationStatus();
        setStatus(current);
        if (!current.configured) setError("unavailable");
        else setOpen(false);
      } catch { setStatus(null); setError("unavailable"); }
    } finally { setBusy(false); }
  };

  return <div className={styles.control} data-dropbox-registration>
    <strong>{t("plugins.dropboxRegistrationTitle")}</strong>
    <span className={styles.hint}>{t("plugins.dropboxRegistrationIntro")}</span>
    <a href="https://help.dropbox.com/integrations/connect-dropbox-mcp-server"
      target="_blank" rel="noreferrer">{t("plugins.dropboxRegistrationGuide")}</a>
    {status?.configured ? <span role="status">{t(status.restartRequired
      ? "plugins.dropboxRegistrationRestart" : "plugins.dropboxRegistrationConfigured")}</span>
      : status === null ? <span role={error ? "alert" : "status"}>{t(error
        ? "plugins.dropboxRegistrationUnavailable" : "plugins.mcpStatusLoading")}</span>
        : <>
          <button className="btn-secondary" type="button" disabled={busy} aria-expanded={open}
            onClick={() => { setOpen(value => !value); setError(null); }}>
            {t("plugins.dropboxRegistrationOpen")}
          </button>
          {open && <form className={styles.form} onSubmit={event => void submit(event)} autoComplete="off">
            <label htmlFor="plugin-dropbox-client-id">{t("plugins.dropboxClientId")}</label>
            <input className="field-input" id="plugin-dropbox-client-id" name="clientId"
              maxLength={128} disabled={busy} autoComplete="off" spellCheck={false} />
            <label htmlFor="plugin-dropbox-client-secret">{t("plugins.dropboxClientSecret")}</label>
            <input className="field-input" id="plugin-dropbox-client-secret" name="clientSecret"
              type="password" maxLength={512} disabled={busy} autoComplete="off" spellCheck={false} />
            <label htmlFor="plugin-dropbox-redirect-port">{t("plugins.dropboxRedirectPort")}</label>
            <input className="field-input" id="plugin-dropbox-redirect-port" name="redirectPort"
              type="number" min={1024} max={65535} disabled={busy} inputMode="numeric" />
            <span className={styles.hint}>{t("plugins.dropboxRedirectHint")}</span>
            <div className={styles.actions}>
              <button className="btn-secondary" type="button" disabled={busy} onClick={event => {
                event.currentTarget.closest("form")?.reset();
                setOpen(false); setError(null);
              }}>{t("common.cancel")}</button>
              <button className="btn-secondary" type="submit" disabled={busy}>
                {t(busy ? "plugins.dropboxRegistrationSaving" : "plugins.dropboxRegistrationSave")}
              </button>
            </div>
          </form>}
        </>}
    {error && status !== null && <span role="alert">{t(error === "invalid"
      ? "plugins.dropboxRegistrationInvalid" : "plugins.dropboxRegistrationFailed")}</span>}
  </div>;
}
