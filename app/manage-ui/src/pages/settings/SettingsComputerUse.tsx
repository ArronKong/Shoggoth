import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentComputerState } from "../../types";
import {
  desktopComputerAvailable, getDesktopComputerState, openDesktopComputerAccessibilitySettings,
  openDesktopComputerScreenRecordingSettings, reloadDesktopComputerPermissions,
  requestDesktopComputerPermissions,
} from "../../api/client";
import s from "./SettingsComputerUse.module.css";

function errorKey(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (code === "COMPUTER_PERMISSION_RELOAD_BUSY") return "reloadBusy";
  if (code === "COMPUTER_PERMISSION_RELOAD_FAILED") return "reloadFailed";
  if (code === "COMPUTER_DRIVER_INVALID") return "driverInvalid";
  if (code === "COMPUTER_DRIVER_UNAVAILABLE") return "driverUnavailable";
  if (code === "COMPUTER_PERMISSION_REQUEST_FAILED") return "requestFailed";
  if (code === "COMPUTER_PERMISSION_STATUS_FAILED") return "statusFailed";
  if (code === "COMPUTER_SETTINGS_OPEN_FAILED") return "settingsFailed";
  return "serviceUnavailable";
}

export default function SettingsComputerUse({ onServiceRestarted }: { onServiceRestarted?: () => void }) {
  const { t } = useTranslation();
  const desktop = desktopComputerAvailable();
  const [state, setState] = useState<AgentComputerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const mounted = useRef(false), sequence = useRef(0), operation = useRef(false);

  const refresh = useCallback(async () => {
    const ticket = ++sequence.current;
    try {
      const value = await getDesktopComputerState();
      if (mounted.current && ticket === sequence.current) { setState(value); setError(null); setNote(null); }
      return value;
    } catch (cause) {
      if (mounted.current && ticket === sequence.current) { setState(null); setError(errorKey(cause)); }
      return null;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (desktop) void refresh();
    const check = () => { if (desktop && !operation.current && document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      mounted.current = false;
      sequence.current += 1;
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [desktop, refresh]);

  const run = async (action: "grant" | "reload" | "refresh" | "accessibility" | "screenRecording") => {
    if (!desktop || operation.current) return;
    operation.current = true;
    sequence.current += 1;
    setBusy(action); setError(null); setNote(null);
    try {
      if (action === "grant") {
        await requestDesktopComputerPermissions();
        const value = await refresh();
        if (mounted.current) setNote(value?.permissions.accessibility && value?.permissions.screenRecording ? "ready" : "grantHint");
      } else if (action === "reload") {
        const value = await reloadDesktopComputerPermissions();
        if (mounted.current) {
          setState(value);
          setNote(value.permissions.accessibility && value.permissions.screenRecording ? "ready" : "reloadIncomplete");
          onServiceRestarted?.();
        }
      } else if (action === "refresh") await refresh();
      else if (action === "accessibility") await openDesktopComputerAccessibilitySettings();
      else await openDesktopComputerScreenRecordingSettings();
    } catch (cause) {
      if (mounted.current) { setError(errorKey(cause)); if (action === "reload") setState(null); }
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  const ready = state?.available && state.permissions.accessibility && state.permissions.screenRecording;
  const label = (value: boolean | null) => t(`settings.computerUse.${value === null ? "unknown" : value ? "granted" : "notGranted"}`);
  const unavailable = error || (state?.reason ? errorKey({ code: state.reason }) : null);
  const button = (action: Parameters<typeof run>[0], key: string, primary = false) => <button
    type="button" className={`ui-cbtn ui-cbtn--sm${primary ? " ui-cbtn--gold" : ""}`}
    disabled={!desktop || busy !== null} onClick={() => void run(action)}>
    {busy === action ? t("settings.serviceWorking") : t(`settings.computerUse.${key}`)}
  </button>;

  return <section className={`settings-section ${s.section}`} id="settings-computer-use" aria-labelledby="settings-computer-title" aria-busy={busy !== null}>
    <header className="settings-section-head">
      <h3 className="settings-h" id="settings-computer-title">{t("settings.computerUse.title")}</h3>
      <p className="settings-sech">{t("settings.computerUse.description")}</p>
    </header>
    <div className={`settings-card settings-list-card ${s.card}`}>
      {(["accessibility", "screenRecording"] as const).map(kind => {
        const value = state?.permissions[kind] ?? null;
        return <div className={`settings-list-row ${s.permission}`} key={kind}>
          <div className="settings-list-copy"><h4>{t(`settings.computerUse.${kind}`)}</h4><p>{t(`settings.computerUse.${kind}Hint`)}</p></div>
          <span className={`${s.status} ${value === true ? s.granted : ""}`} data-permission={kind} data-state={value === null ? "unknown" : String(value)}>
            <i aria-hidden="true" />{label(value)}
          </span>
          {button(kind, `${kind}Settings`)}
        </div>;
      })}
      <div className={s.footer}>
        <p className="ui-hint" role="status">{!desktop ? t("settings.computerUse.desktopOnly")
          : unavailable ? t(`settings.computerUse.${unavailable}`)
          : note ? t(`settings.computerUse.${note}`)
          : !state ? t("settings.serviceWorking") : t(`settings.computerUse.${ready ? "ready" : "grantHint"}`)}</p>
        <div className={s.actions}>
          {button("grant", "grant", true)}{button("refresh", "refresh")}{button("reload", "reload")}
        </div>
        <p className={`ui-hint ${s.reloadHint}`}>{t("settings.computerUse.reloadHint")}</p>
        {state?.available && <span className={s.version}>{t("settings.computerUse.driver", { version: state.driverVersion || "—" })}</span>}
      </div>
      {state && <details className={s.sessions}>
        <summary>{t("settings.computerUse.sessions", { count: state.sessions.length })}</summary>
        {state.sessions.length === 0 ? <p className="ui-hint">{t("settings.computerUse.sessionsEmpty")}</p>
          : <ul>{state.sessions.map(session => <li key={session.id}>
            <span>{session.allowedApplications.join(", ")}</span>
            <span>{t(`settings.computerUse.session${session.status === "ready" ? "Ready" : session.status === "paused" ? "Paused" : session.status === "failed" ? "Failed" : session.status === "starting" ? "Starting" : session.status === "closing" ? "Closing" : session.status === "close_failed" ? "CloseFailed" : "Closed"}`)}</span>
            <small>{t("settings.computerUse.sessionLifetime")}</small>
          </li>)}</ul>}
      </details>}
    </div>
  </section>;
}
