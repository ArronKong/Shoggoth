import { useEffect, useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, configurePluginGraphRegistration, getPluginGraphRegistrationStatus,
  type PluginGraphRegistrationStatus } from "../api/client";
import styles from "./PluginGraphRegistration.module.css";

const CLIENT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const UPDATED = "shoggoth:graph-registration-updated";
const SCOPES = {
  "outlook-calendar": { permission: "Calendars.Read", label: "plugins.graphCalendarPermission" },
  "outlook-email": { permission: "Mail.ReadBasic", label: "plugins.graphEmailPermission" },
  sharepoint: { permission: "Sites.Read.All", label: "plugins.graphSharePointPermission" },
  teams: { permission: "Chat.ReadBasic", label: "plugins.graphTeamsPermission" },
} as const;

export function isGraphRegistrationPackage(packageId: string): packageId is keyof typeof SCOPES {
  return Object.hasOwn(SCOPES, packageId);
}

type ErrorState = "invalid" | "conflict" | "failed" | "unavailable" | null;

export function PluginGraphRegistration({ packageId }: { packageId: keyof typeof SCOPES }) {
  const { t } = useTranslation();
  const inputId = useId();
  const [status, setStatus] = useState<PluginGraphRegistrationStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState<ErrorState>(null);
  const [canceled, setCanceled] = useState(false);
  const scope = SCOPES[packageId];

  useEffect(() => {
    let active = true;
    let configuredEventSeen = false;
    const onUpdated = (event: Event) => {
      configuredEventSeen = true;
      const value = (event as CustomEvent<PluginGraphRegistrationStatus>).detail;
      setStatus(value); setOpen(false); setBlocked(false); setError(null); setCanceled(false);
    };
    window.addEventListener(UPDATED, onUpdated);
    void getPluginGraphRegistrationStatus().then(value => {
      if (!active || configuredEventSeen && !value.configured) return;
      setStatus(value); setError(null);
    }).catch(cause => {
      if (!active || configuredEventSeen) return;
      if (cause instanceof ApiError && cause.code === "GRAPH_REGISTRATION_CONFLICT") {
        setStatus({ configured: false, restartRequired: false });
        setBlocked(true); setError("conflict");
      } else { setStatus(null); setError("unavailable"); }
    });
    return () => { active = false; window.removeEventListener(UPDATED, onUpdated); };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || blocked || status?.configured !== false) return;
    const clientId = String(new FormData(event.currentTarget).get("clientId") || "").trim();
    if (!CLIENT_ID.test(clientId)) { setError("invalid"); return; }
    setBusy(true); setError(null); setCanceled(false);
    try {
      const receipt = await configurePluginGraphRegistration({ clientId });
      if (receipt.canceled) { setCanceled(true); return; }
      if (!receipt.configured) { setError("failed"); return; }
      const value = { configured: true, restartRequired: receipt.restartRequired };
      window.dispatchEvent(new CustomEvent(UPDATED, { detail: value }));
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "GRAPH_REGISTRATION_INVALID") {
        setError("invalid"); return;
      }
      // A lost reply may follow the first write. Observe its status before
      // allowing another attempt; never send the registration automatically.
      try {
        const current = await getPluginGraphRegistrationStatus();
        if (current.configured) {
          window.dispatchEvent(new CustomEvent(UPDATED, { detail: current }));
        } else {
          setStatus(current);
          if (cause instanceof ApiError && cause.code === "GRAPH_REGISTRATION_CONFLICT") {
            setBlocked(true); setOpen(false); setError("conflict");
          } else setError("failed");
        }
      } catch (statusCause) {
        if (statusCause instanceof ApiError && statusCause.code === "GRAPH_REGISTRATION_CONFLICT") {
          setStatus({ configured: false, restartRequired: false });
          setBlocked(true); setOpen(false); setError("conflict");
        } else { setStatus(null); setError("unavailable"); }
      }
    } finally { setBusy(false); }
  };

  return <section className={styles.control} data-graph-registration data-package-id={packageId}
    aria-label={t("plugins.graphRegistrationTitle")}>
    <div className={styles.heading}>
      <strong>{t("plugins.graphRegistrationTitle")}</strong>
      <span className={styles.shared}>{t("plugins.graphRegistrationShared")}</span>
    </div>
    <p className={styles.intro}>{t("plugins.graphRegistrationIntro")}</p>
    <dl className={styles.facts}>
      <div><dt>{t("plugins.graphRedirectLabel")}</dt>
        <dd><code>http://localhost</code><span>{t("plugins.graphRedirectHint")}</span></dd></div>
      <div><dt>{t("plugins.graphPermissionLabel")}</dt>
        <dd><code>{scope.permission}</code><span>{t(scope.label)}</span></dd></div>
    </dl>
    <p className={styles.secondaryScope}>{t("plugins.graphIdentityPermissions")}</p>
    {packageId === "sharepoint" && <p className={styles.scopeWarning}>
      {t("plugins.graphSharePointBroadPermission")}</p>}
    {status?.configured ? <p className={styles.state} role="status">{t(status.restartRequired
      ? "plugins.graphRegistrationRestart" : "plugins.graphRegistrationConfigured")}</p>
      : status === null ? <p className={styles.state} role={error ? "alert" : "status"}>{t(error
        ? "plugins.graphRegistrationUnavailable" : "plugins.mcpStatusLoading")}</p>
        : blocked ? <p className={styles.state} role="alert">{t("plugins.graphRegistrationConflict")}</p>
          : <>
            <button className="btn-secondary" type="button" disabled={busy} aria-expanded={open}
              onClick={() => { setOpen(value => !value); setError(null); setCanceled(false); }}>
              {t("plugins.graphRegistrationOpen")}
            </button>
            {open && <form className={styles.form} onSubmit={event => void submit(event)} autoComplete="off">
              <label htmlFor={inputId}>{t("plugins.graphClientId")}</label>
              <input className="field-input" id={inputId} name="clientId" type="text"
                maxLength={36} inputMode="text" spellCheck={false} autoComplete="off"
                placeholder="00000000-0000-0000-0000-000000000000" disabled={busy} required />
              <p className={styles.formHint}>{t("plugins.graphClientIdHint")}</p>
              <div className={styles.actions}>
                <button className="btn-secondary" type="button" disabled={busy}
                  onClick={() => { setOpen(false); setError(null); setCanceled(false); }}>
                  {t("common.cancel")}</button>
                <button className="btn-secondary" type="submit" disabled={busy}>
                  {t(busy ? "plugins.graphRegistrationSaving" : "plugins.graphRegistrationSave")}</button>
              </div>
            </form>}
          </>}
    {canceled && <p className={styles.state} role="status">{t("plugins.graphRegistrationCanceled")}</p>}
    {error && status !== null && !blocked && <p className={styles.state} role="alert">{t(error === "invalid"
      ? "plugins.graphRegistrationInvalid" : "plugins.graphRegistrationFailed")}</p>}
  </section>;
}
