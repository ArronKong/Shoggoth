import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "../../components/Field";
import { desktopBrowserAvailable, getDesktopBrowserState } from "../../api/client";
import type { AppConfig, BrowserUseSettings, BrowserUseState } from "../../types";
import s from "./SettingsBrowserUse.module.css";

export default function SettingsBrowserUse({ cfg, onChange, disabled }: {
  cfg: AppConfig; onChange: (patch: Partial<AppConfig>) => void; disabled: boolean;
}) {
  const { t } = useTranslation();
  const desktop = desktopBrowserAvailable(), settings = cfg.browserUse;
  const [state, setState] = useState<BrowserUseState | null>(null);
  const [error, setError] = useState(false), [busy, setBusy] = useState(false);
  const mounted = useRef(false), sequence = useRef(0);
  const refresh = useCallback(async () => {
    const ticket = ++sequence.current;
    setBusy(true);
    try {
      const result = await getDesktopBrowserState();
      if (mounted.current && ticket === sequence.current) { setState(result); setError(false); }
    } catch {
      if (mounted.current && ticket === sequence.current) { setState(null); setError(true); }
    } finally { if (mounted.current && ticket === sequence.current) setBusy(false); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    if (desktop) void refresh();
    const check = () => { if (desktop && document.visibilityState === "visible") void refresh(); };
    const timer = desktop ? setInterval(check, 5000) : undefined;
    window.addEventListener("focus", check);
    return () => { mounted.current = false; sequence.current++; clearInterval(timer); window.removeEventListener("focus", check); };
  }, [desktop, refresh]);
  useEffect(() => { if (desktop) { setState(null); void refresh(); } }, [desktop, settings?.browser, settings?.enabled, refresh]);
  const change = (patch: Partial<BrowserUseSettings>) => { if (settings && !disabled) onChange({ browserUse: { ...settings, ...patch } }); };
  const controlsDisabled = disabled || !settings;
  const reason = !settings ? "checking" : !settings.enabled ? "disabled" : error ? "serviceUnavailable"
    : !desktop ? "desktopOnly" : !state ? "checking" : state.browser !== settings.browser ? "applying"
    : state.reason === "BROWSER_EXECUTABLE_UNAVAILABLE" ? "browserMissing"
    : state.reason === "BROWSER_ENGINE_UNAVAILABLE" ? "engineMissing"
    : state.reason === "BROWSER_DISABLED" ? "applying"
    : state.available ? "ready" : "serviceUnavailable";

  return <section className={`settings-section ${s.section}`} id="settings-browser-use" aria-labelledby="settings-browser-title" aria-busy={busy}>
    <header className="settings-section-head">
      <h3 className="settings-h" id="settings-browser-title">{t("settings.browserUse.title")}</h3>
      <p className="settings-sech">{t("settings.browserUse.description")}</p>
    </header>
    <div className="settings-card settings-list-card">
      <div className="settings-list-row">
        <Switch checked={settings?.enabled === true} disabled={controlsDisabled} onChange={enabled => change({ enabled })}
          label={t("settings.browserUse.enable")} />
      </div>
      <div className="settings-list-row">
        <Switch checked={settings?.headless === true} disabled={controlsDisabled || !settings?.enabled}
          onChange={headless => change({ headless })} label={<span className={s.copy}>
            <span>{t("settings.browserUse.headless")}</span><small>{t("settings.browserUse.headlessHint")}</small>
          </span>} />
      </div>
      <div className="settings-list-row">
        <Switch checked={settings?.isolated === false} disabled={controlsDisabled || !settings?.enabled}
          onChange={persistent => change({ isolated: !persistent })} label={<span className={s.copy}>
            <span>{t("settings.browserUse.persistent")}</span><small>{t("settings.browserUse.persistentHint")}</small>
          </span>} />
      </div>
      <div className={s.footer}>
        <div className={s.statusRow}>
          <p className="ui-hint" role="status" data-browser-state={reason}>{t(`settings.browserUse.${reason}`)}</p>
          <button type="button" className="ui-cbtn ui-cbtn--sm" disabled={!desktop || busy} onClick={() => void refresh()}>
            {busy ? t("settings.serviceWorking") : t("settings.browserUse.refresh")}
          </button>
        </div>
        <p className="ui-hint">{t("settings.browserUse.settingsHint")}</p>
        {state?.engineVersion && <span className={s.version}>{t("settings.browserUse.engineVersion", { version: state.engineVersion })}</span>}
      </div>
      {desktop && state && <details className={s.sessions}>
        <summary>{t("settings.browserUse.sessions", { count: state.sessions.length })}</summary>
        {state.sessions.length === 0 ? <p className="ui-hint">{t("settings.browserUse.sessionsEmpty")}</p>
          : <ul>{state.sessions.map(session => <li key={session.id}>
            <span>{session.profileId}</span><span>Chrome</span>
            <span>{t(`settings.browserUse.session.${session.status}`)}</span>
            <small>{t("settings.browserUse.sessionLifetime")}</small>
          </li>)}</ul>}
      </details>}
    </div>
  </section>;
}
