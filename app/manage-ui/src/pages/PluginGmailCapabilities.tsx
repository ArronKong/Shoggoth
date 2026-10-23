import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, configurePluginGmailCapabilities, getPluginGmailCapabilitiesStatus,
  type PluginGmailCapabilitiesStatus } from "../api/client";
import styles from "./PluginGraphRegistration.module.css";

export function PluginGmailCapabilities({ onChanged }: { onChanged?: () => void }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<PluginGmailCapabilitiesStatus | null>(null);
  const [writeEnabled, setWriteEnabled] = useState(false);
  const [sendEnabled, setSendEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"unavailable" | "conflict" | "deferred" | "failed" | null>(null);
  const [canceled, setCanceled] = useState(false);

  const accept = (value: PluginGmailCapabilitiesStatus) => {
    setStatus(value);
    setWriteEnabled(value.writeEnabled);
    setSendEnabled(value.sendEnabled);
  };

  useEffect(() => {
    let active = true;
    void getPluginGmailCapabilitiesStatus().then(value => {
      if (active) { accept(value); setError(null); }
    }).catch(() => { if (active) setError("unavailable"); });
    return () => { active = false; };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !status || status.writeEnabled === writeEnabled && status.sendEnabled === sendEnabled) return;
    const requested = { expectedRevision: status.revision, writeEnabled,
      sendEnabled: writeEnabled && sendEnabled };
    setBusy(true); setError(null); setCanceled(false);
    try {
      const receipt = await configurePluginGmailCapabilities(requested);
      accept(receipt);
      if (receipt.canceled) setCanceled(true);
      else onChanged?.();
    } catch (cause) {
      // A lost response may follow a committed policy change. Read its
      // revision and values before allowing another explicit submission.
      try {
        const current = await getPluginGmailCapabilitiesStatus();
        accept(current);
        if (current.revision !== requested.expectedRevision
          && current.writeEnabled === requested.writeEnabled
          && current.sendEnabled === requested.sendEnabled) onChanged?.();
        else setError(cause instanceof ApiError && cause.code === "REVISION_CONFLICT"
          ? "conflict" : cause instanceof ApiError && cause.code === "ACTIVATION_DEFERRED"
            ? "deferred" : "failed");
      } catch { setStatus(null); setError("unavailable"); }
    } finally { setBusy(false); }
  };

  return <section className={styles.control} data-gmail-capabilities
    aria-label={t("plugins.gmailCapabilitiesTitle")}>
    <div className={styles.heading}>
      <strong>{t("plugins.gmailCapabilitiesTitle")}</strong>
      <span className={styles.shared}>{t("plugins.gmailCapabilitiesReadDefault")}</span>
    </div>
    <p className={styles.intro}>{t("plugins.gmailCapabilitiesIntro")}</p>
    {status ? <form className={styles.form} onSubmit={event => void submit(event)}>
      <label className={styles.choice}><input type="checkbox" checked={writeEnabled} disabled={busy}
        onChange={event => {
          setWriteEnabled(event.currentTarget.checked);
          if (!event.currentTarget.checked) setSendEnabled(false);
          setError(null); setCanceled(false);
        }} /> {t("plugins.gmailCapabilitiesWrite")}</label>
      <label className={styles.choice}><input type="checkbox" checked={sendEnabled} disabled={busy || !writeEnabled}
        onChange={event => { setSendEnabled(event.currentTarget.checked); setError(null); setCanceled(false); }} />
        {" "}{t("plugins.gmailCapabilitiesSend")}</label>
      <p className={styles.formHint}>{t("plugins.gmailCapabilitiesDeleteUnavailable")}</p>
      <button className="btn-secondary" type="submit" disabled={busy
        || status.writeEnabled === writeEnabled && status.sendEnabled === sendEnabled}>
        {t(busy ? "plugins.gmailCapabilitiesSaving" : "plugins.gmailCapabilitiesSave")}
      </button>
    </form> : <p className={styles.state} role={error ? "alert" : "status"}>
      {t(error ? "plugins.gmailCapabilitiesUnavailable" : "plugins.mcpStatusLoading")}</p>}
    {canceled && <p className={styles.state} role="status">{t("plugins.gmailCapabilitiesCanceled")}</p>}
    {error && status && <p className={styles.state} role="alert">{t(error === "conflict"
      ? "plugins.gmailCapabilitiesConflict" : error === "deferred"
        ? "plugins.gmailCapabilitiesDeferred" : "plugins.gmailCapabilitiesFailed")}</p>}
  </section>;
}
