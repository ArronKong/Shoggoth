import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Switch } from "../../components/Field";
import { APP_UPDATE_SECTION_ID, appUpdateBridge, observeAppUpdateState, type AppUpdateState } from "../../lib/appUpdate";
import { SettingsIcon } from "./SettingsIcons";

const fallbackState: AppUpdateState = {
  supported: false,
  reason: "desktop-only",
  status: "unsupported",
  currentVersion: "—",
  automaticUpdates: false,
  availableVersion: null,
  releaseName: null,
  releaseDate: null,
  progress: null,
  canCheck: false,
  canInstall: false,
  installBlockReason: null,
};

export default function SettingsAppUpdate() {
  const { t } = useTranslation();
  const { hash, key } = useLocation();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [state, setState] = useState<AppUpdateState | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [preferencePending, setPreferencePending] = useState(false);
  const [preferenceError, setPreferenceError] = useState(false);

  useEffect(() => {
    const bridge = appUpdateBridge();
    if (!bridge) {
      setState(fallbackState);
      return undefined;
    }
    return observeAppUpdateState(bridge,
      (next) => setState(next || fallbackState),
      () => setState({ ...fallbackState, reason: "updater-unavailable" }),
    );
  }, []);

  useEffect(() => {
    if (hash !== `#${APP_UPDATE_SECTION_ID}`) return;
    const heading = headingRef.current;
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({ block: "center" });
  }, [hash, key]);

  const statusText = useMemo(() => {
    if (!state) return t("settings.appUpdate.loading");
    if (!state.supported && state.reason === "desktop-only") return null;
    if (!state.supported) return t(`settings.appUpdate.unsupported.${state.reason || "unknown"}`, {
      defaultValue: t("settings.appUpdate.unsupported.unknown"),
    });
    switch (state.status) {
      case "checking": return t("settings.appUpdate.checking");
      case "available": return t(state.canCheck ? "settings.appUpdate.available" : "settings.appUpdate.startingDownload", {
        version: state.availableVersion || "",
      });
      case "downloading": return t("settings.appUpdate.downloading", { progress: Math.round(state.progress || 0) });
      case "downloaded": return state.installBlockReason
        ? t(`settings.appUpdate.installBlocked.${state.installBlockReason}`, {
          defaultValue: t("settings.appUpdate.installBlocked.unknown"),
        })
        : t("settings.appUpdate.downloaded", { version: state.availableVersion || "" });
      case "preparing": return t("settings.appUpdate.preparing");
      case "recovering": return t("settings.appUpdate.recovering");
      case "up-to-date": return t("settings.appUpdate.upToDate");
      case "error": return t("settings.appUpdate.error");
      case "installing": return t("settings.appUpdate.installing");
      default: return null;
    }
  }, [state, t]);

  const setAutomatic = async (enabled: boolean) => {
    const bridge = appUpdateBridge();
    if (!bridge) return;
    setPreferencePending(true);
    setPreferenceError(false);
    try {
      const next = await bridge.setAutomatic(enabled);
      if (next) setState(next);
      else setPreferenceError(true);
    } catch { setPreferenceError(true); }
    finally { setPreferencePending(false); }
  };

  const runCheck = async () => {
    const bridge = appUpdateBridge();
    if (!bridge) return;
    setActionPending(true);
    try { setState(await bridge.check()); }
    catch { setState((previous) => previous ? { ...previous, status: "error", canCheck: true } : fallbackState); }
    finally { setActionPending(false); }
  };

  const install = async () => {
    const bridge = appUpdateBridge();
    if (!bridge) return;
    setActionPending(true);
    try { await bridge.install(); }
    catch { setState((previous) => previous ? {
      ...previous, status: "downloaded", canInstall: true, installBlockReason: "unknown",
    } : fallbackState); }
    finally { setActionPending(false); }
  };

  const progress = state?.status === "downloading" || state?.status === "downloaded"
    ? Math.round(state.progress || 0)
    : null;
  const installationBusy = state && ["preparing", "installing", "recovering"].includes(state.status);
  const canDownload = state?.status === "available" && state.canCheck;

  return (
    <div id={APP_UPDATE_SECTION_ID}>
      <div className="settings-list-row settings-update-heading">
        <SettingsIcon name="update" />
        <div className="settings-list-copy">
          <h4 ref={headingRef} tabIndex={-1}>
            {t("settings.appUpdate.title")}
            <span className="settings-app-update-version mono" aria-label={t("settings.appUpdate.currentVersion")}>{state?.currentVersion || "—"}</span>
          </h4>
        </div>
        <div className="settings-app-update-actions">
          {state?.canInstall && (
            <button type="button" className="btn-dark btn-sm" disabled={actionPending} onClick={() => void install()}>
              {t("settings.appUpdate.restart")}
            </button>
          )}
          <button type="button" className="btn-secondary btn-sm" disabled={actionPending || !state?.canCheck} onClick={() => void runCheck()}>
            {t(canDownload ? "settings.appUpdate.download" : "settings.appUpdate.check")}
          </button>
        </div>
      </div>
      <div className="settings-app-update-copy">
        <div className="settings-switch-list">
          <div className="settings-switch-row">
            <Switch
              checked={state?.automaticUpdates === true}
              disabled={!state?.supported || preferencePending || Boolean(installationBusy)}
              onChange={(enabled) => void setAutomatic(enabled)}
              label={<span className="settings-switch-label">
                <SettingsIcon name="schedule" />
                <span className="settings-switch-copy">
                  <span>{t("settings.appUpdate.automatic")}</span>
                  {state?.supported && <small>{t("settings.appUpdate.automaticHint")}</small>}
                </span>
              </span>}
            />
          </div>
        </div>
        {preferenceError && <p role="alert">{t("settings.appUpdate.preferenceError")}</p>}
        {statusText && <p className="ui-hint" role="status" aria-live="polite">{statusText}</p>}
        {progress !== null && (
          <progress value={progress} max={100} aria-label={t("settings.appUpdate.downloadProgress")} />
        )}
      </div>
    </div>
  );
}
