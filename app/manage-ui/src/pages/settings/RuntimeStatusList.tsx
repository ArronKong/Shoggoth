import { useTranslation } from "react-i18next";
import type { RuntimeStatus } from "../../types";
import { BackendMark } from "./BackendOverview";

export default function RuntimeStatusList({ runtimes, loading, error, busy, onToggle }: {
  runtimes: RuntimeStatus[]; loading: boolean; error: boolean; busy: boolean;
  onToggle: (runtime: RuntimeStatus) => void;
}) {
  const { t } = useTranslation();
  return <section className="settings-section" id="settings-local-runtimes">
    <header className="settings-section-head">
      <h3 className="settings-h">{t("settings.localRuntimes")}</h3>
      <p className="settings-sech">{t("settings.localRuntimeStatusHint")}</p>
    </header>
    {loading && !runtimes.length ? <p className="ui-hint">{t("common.loading")}</p>
      : error || !runtimes.length ? <p className="ui-hint" role="status">{t("settings.localRuntimeStatusFailed")}</p>
      : <div className="settings-native-list">{runtimes.map(runtime => {
        const status = !runtime.releaseEnabled ? "runtimeReleaseDisabled" : !runtime.enabled ? "backendDisabled"
          : runtime.installation !== "available" ? "runtimeUnavailable"
          : !runtime.serviceConnected ? "runtimeServiceOffline" : "runtimeReady";
        return <article className="settings-backend settings-backend--local" key={`${runtime.backendId}:${runtime.runtimeAccountId}`}
          data-runtime={runtime.runtime}>
          <div className="settings-backend-row">
            <BackendMark id={runtime.runtime} name={runtime.name} />
            <div className="settings-backend-copy"><h4>{runtime.name}</h4><p>{t("settings.modeNative")}</p></div>
            <div className="settings-backend-state"><span className={`settings-health ${status === "runtimeReady" ? "is-healthy" : ""}`}><i />{t(`settings.${status}`)}</span></div>
            <div className="settings-backend-actions">
              {runtime.releaseEnabled && <button className="ui-cbtn ui-cbtn--sm" disabled={busy} onClick={() => onToggle(runtime)}>
                {t(runtime.enabled ? "settings.disconnect" : "settings.reconnect")}
              </button>}
            </div>
          </div>
        </article>;
      })}</div>}
  </section>;
}
