import { useTranslation } from "react-i18next";
import type { ShoggothProductStatus } from "../../types";

type ServiceAction = "install" | "start" | "stop" | "repair";

export default function ServiceSettings({ status, error, busy, onRetry, onAction }: {
  status: ShoggothProductStatus | null;
  error: boolean;
  busy: ServiceAction | null;
  onRetry: () => void;
  onAction: (action: ServiceAction) => void;
}) {
  const { t } = useTranslation();
  const background = status?.background;
  const locked = status?.service.pendingCommandsLocked;
  const ready = status?.service.healthy === true && !locked;
  const action = (name: ServiceAction, key: string, primary = false) => <button
    className={`ui-cbtn ui-cbtn--sm${primary ? " ui-cbtn--gold" : ""}`} disabled={busy !== null} onClick={() => onAction(name)}>
    {busy === name ? t("settings.serviceWorking") : t(key)}
  </button>;
  const backgroundText = t(!background?.supported ? "settings.serviceUnsupported" : background.needsRepair ? "settings.serviceNeedsRepair" : background.loaded ? "settings.serviceEnabled" : background.installed ? "settings.serviceNotRunning" : "settings.serviceNotInstalled");
  const domainsReady = !!status && status.service.domainAvailability.kanban && status.service.domainAvailability.cron;
  // Rendered inside the Shoggoth backend card: the card header already names
  // the product, so this block only carries the background-service controls.
  return <section className="settings-subsection settings-service" id="settings-shoggoth" tabIndex={-1} aria-busy={busy !== null}>
    <header className="settings-subsection-head">
      <h5>{t("settings.serviceSubsection")}</h5>
      {status?.service.serviceVersion && <span className="settings-subsection-meta mono">v{status.service.serviceVersion}</span>}
    </header>
    {error ? <div className="settings-inline-state" role="alert"><div><strong>{t("settings.shoggothUnavailable")}</strong><p>{t("settings.serviceRetryHint")}</p></div><button className="ui-cbtn ui-cbtn--sm" onClick={onRetry}>{t("settings.retry")}</button></div>
      : !status ? <p className="ui-hint">{t("common.loading")}</p> : <div className="settings-service-card">
        <div className="settings-service-top">
          <div className={`settings-service-icon ${ready ? "is-healthy" : ""}`} aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="4" y="3" width="16" height="7" rx="2" /><rect x="4" y="14" width="16" height="7" rx="2" /><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6" /></svg>
          </div>
          <div className="settings-service-copy"><h4>{t(ready ? "settings.serviceRunning" : "settings.serviceStopped")}</h4><p>{t(locked ? "settings.shoggothLocked" : "settings.servicePurpose")}</p></div>
          <div className="settings-actions">
            {background?.supported && !background.installed && action("install", "settings.shoggothInstall", true)}
            {background?.supported && background.installed && !background.loaded && action("start", "settings.shoggothStart", true)}
            {background?.supported && background.loaded && !status.service.healthy && !background.needsRepair && action("repair", "settings.reconnect", true)}
            {background?.supported && background.loaded && action("stop", "settings.shoggothStop")}
            {background?.supported && background.needsRepair && action("repair", "settings.shoggothRepair", true)}
          </div>
        </div>
        <dl className="settings-service-facts">
          <div className={background?.loaded && !background.needsRepair ? "is-ok" : ""}><dt>{t("settings.backgroundRun")}</dt><dd>{backgroundText}</dd></div>
          <div className={domainsReady ? "is-ok" : ""}><dt>{t("settings.shoggothDomains")}</dt><dd>{t(domainsReady ? "settings.available" : "settings.partial")}</dd></div>
          <div className={locked ? "is-warn" : "is-ok"}><dt>{t("settings.serviceData")}</dt><dd>{t(locked ? "settings.serviceLocked" : "settings.available")}</dd></div>
        </dl>
        {locked && <p className="ui-hint status-error">{t("settings.shoggothLocked")}</p>}
        {!background?.supported && <p className="ui-hint">{t(background?.reason === "unstable-install-location" ? "settings.shoggothMoveToApplications" : background?.reason === "unsupported-platform" ? "settings.shoggothBackgroundUnsupported" : "settings.shoggothBackgroundUnavailable")}</p>}
        <p className="ui-hint">{t("settings.backgroundRunHint")}</p>
      </div>}
  </section>;
}
