import { useTranslation } from "react-i18next";
import type { RuntimeStatus } from "../../types";
import { BackendMark } from "./BackendOverview";

export default function RuntimeStatusList({ runtimes, loading, error, busy, onToggle }: {
  runtimes: RuntimeStatus[]; loading: boolean; error: boolean; busy: boolean;
  onToggle: (runtime: RuntimeStatus) => void;
}) {
  const { t } = useTranslation();
  const ready = runtimes.filter((runtime) => runtime.releaseEnabled && runtime.enabled
    && runtime.installation === "available" && runtime.serviceConnected).length;
  // Rendered inside the Shoggoth backend card, below its background service.
  return <section className="settings-subsection" id="settings-local-runtimes">
    <header className="settings-subsection-head">
      <div><h5>{t("settings.localRuntimes")}</h5><p>{t("settings.localRuntimeStatusHint")}</p></div>
      {runtimes.length > 0 && !error && <span className="settings-subsection-meta">{ready} / {runtimes.length}</span>}
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
            <div className="settings-backend-copy"><h4>{runtime.name}</h4></div>
            <div className="settings-backend-state"><span className={`settings-health ${status === "runtimeReady" ? "is-healthy" : status === "backendDisabled" || status === "runtimeReleaseDisabled" ? "" : "is-down"}`}><i />{t(`settings.${status}`)}</span></div>
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
