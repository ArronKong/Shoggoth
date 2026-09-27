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
  // Rendered inside the Shoggoth backend card as a grid of small tiles.
  return <section className="settings-subsection" id="settings-local-runtimes">
    <header className="settings-subsection-head">
      <div><h5>{t("settings.localRuntimes")}</h5><p>{t("settings.localRuntimeStatusHint")}</p></div>
      {runtimes.length > 0 && !error && <span className="settings-subsection-meta">{t("settings.localRuntimesReady", { ready, total: runtimes.length })}</span>}
    </header>
    {loading && !runtimes.length ? <p className="ui-hint">{t("common.loading")}</p>
      : error || !runtimes.length ? <p className="ui-hint" role="status">{t("settings.localRuntimeStatusFailed")}</p>
      : <div className="settings-cli-grid">{runtimes.map(runtime => {
        const status = !runtime.releaseEnabled ? "runtimeReleaseDisabled" : !runtime.enabled ? "backendDisabled"
          : runtime.installation !== "available" ? "runtimeUnavailable"
          : !runtime.serviceConnected ? "runtimeServiceOffline" : "runtimeReady";
        const tone = status === "runtimeReady" ? "is-healthy" : status === "backendDisabled" || status === "runtimeReleaseDisabled" ? "is-off" : "is-down";
        return <article className={`settings-cli-tile ${tone}`} key={`${runtime.backendId}:${runtime.runtimeAccountId}`}
          data-runtime={runtime.runtime}>
          <BackendMark id={runtime.runtime} name={runtime.name} />
          <div className="settings-cli-tile-copy">
            <h6>{runtime.name}</h6>
            <span className={`settings-health ${tone === "is-off" ? "" : tone}`}><i />{t(`settings.${status}`)}</span>
          </div>
          {runtime.releaseEnabled && <button className="ui-cbtn ui-cbtn--sm" disabled={busy} onClick={() => onToggle(runtime)}>
            {t(runtime.enabled ? "settings.disconnect" : "settings.reconnect")}
          </button>}
        </article>;
      })}</div>}
  </section>;
}
