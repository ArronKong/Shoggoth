import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { appUpdateBridge, type AppUpdateState } from "../../lib/appUpdate";

const fallbackState: AppUpdateState = {
  supported: false,
  reason: "desktop-only",
  status: "unsupported",
  currentVersion: "—",
  availableVersion: null,
  releaseName: null,
  releaseDate: null,
  progress: null,
  canCheck: false,
  canInstall: false,
};

export default function SettingsAppUpdate() {
  const { t } = useTranslation();
  const [state, setState] = useState<AppUpdateState | null>(null);
  const [actionPending, setActionPending] = useState(false);

  useEffect(() => {
    const bridge = appUpdateBridge();
    if (!bridge) {
      setState(fallbackState);
      return undefined;
    }
    let mounted = true;
    const dispose = bridge.onState((next) => { if (mounted) setState(next); });
    void bridge.getState()
      .then((next) => { if (mounted) setState(next || fallbackState); })
      .catch(() => { if (mounted) setState({ ...fallbackState, reason: "updater-unavailable" }); });
    return () => { mounted = false; dispose(); };
  }, []);

  const statusText = useMemo(() => {
    if (!state) return t("settings.appUpdate.loading");
    if (!state.supported) return t(`settings.appUpdate.unsupported.${state.reason || "unknown"}`, {
      defaultValue: t("settings.appUpdate.unsupported.unknown"),
    });
    switch (state.status) {
      case "checking": return t("settings.appUpdate.checking");
      case "available": return t("settings.appUpdate.available", { version: state.availableVersion || "" });
      case "downloading": return t("settings.appUpdate.downloading", { progress: Math.round(state.progress || 0) });
      case "downloaded": return t("settings.appUpdate.downloaded", { version: state.availableVersion || "" });
      case "up-to-date": return t("settings.appUpdate.upToDate");
      case "error": return t("settings.appUpdate.error");
      case "installing": return t("settings.appUpdate.installing");
      default: return t("settings.appUpdate.idle");
    }
  }, [state, t]);

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
    finally { setActionPending(false); }
  };

  const progress = state?.status === "downloading" || state?.status === "downloaded"
    ? Math.round(state.progress || 0)
    : null;

  return (
    <section className="settings-section" id="settings-app-update">
      <header className="settings-section-head">
        <h3 className="settings-h">{t("settings.appUpdate.title")}</h3>
        <p className="settings-sech">{t("settings.appUpdate.description")}</p>
      </header>
      <div className="settings-card settings-app-update-card">
        <div className="settings-app-update-copy">
          <div>
            <span className="settings-app-update-label">{t("settings.appUpdate.currentVersion")}</span>
            <strong>{state?.currentVersion || "—"}</strong>
          </div>
          <p role="status" aria-live="polite">{statusText}</p>
          {progress !== null && (
            <progress value={progress} max={100} aria-label={t("settings.appUpdate.downloadProgress")} />
          )}
        </div>
        <div className="settings-app-update-actions">
          {state?.canInstall && (
            <button type="button" className="ui-cbtn ui-cbtn--sm ui-cbtn--gold" disabled={actionPending} onClick={() => void install()}>
              {t("settings.appUpdate.restart")}
            </button>
          )}
          <button type="button" className="ui-cbtn ui-cbtn--sm" disabled={actionPending || !state?.canCheck} onClick={() => void runCheck()}>
            {t("settings.appUpdate.check")}
          </button>
        </div>
      </div>
    </section>
  );
}
