import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { BackendDescriptor, BackendStatus, BackendVersionStatus } from "../../types";
import { REMOTE_CONNECTIONS_ENABLED } from "../../lib/connectionOptions";
import BackendTabIcon from "../../components/BackendTabIcon";

export function BackendMark({ id, name }: { id: string; name: string }) {
  return <span className="settings-backend-mark" aria-hidden="true">
    <BackendTabIcon backend={id} label={name} />
  </span>;
}

function BackendRow({ backend: b, descriptor, version, attention, details, canToggle, toggleDisabled, lastEnabled, onToggle, onConfigure }: {
  backend: BackendStatus;
  descriptor?: BackendDescriptor;
  version?: BackendVersionStatus;
  attention: boolean;
  details: ReactNode;
  canToggle: boolean;
  toggleDisabled: boolean;
  lastEnabled: boolean;
  onToggle: () => void;
  onConfigure?: () => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(attention);
  useEffect(() => { if (attention) setExpanded(true); }, [attention]);
  const mode = descriptor?.connectionMode || b.info.connectionMode;
  const cli = mode === "native-runtime";
  const status = b.disabled ? t("settings.backendDisabled") : b.info.starting ? t("common.loading")
    : b.connected ? t("common.connected") : t("common.disconnected");
  return (
    <article className={`settings-backend ${cli ? "settings-backend--local" : "settings-backend--card"}`}>
      <div className="settings-backend-row">
        <BackendMark id={b.id} name={b.name} />
        <div className="settings-backend-copy">
          <h4>{b.name}</h4>
          <p>{t(mode === "builtin-service" ? "settings.modeBuiltin" : mode === "native-runtime"
            ? "settings.modeNative" : mode === "gateway" ? "settings.gateway" : b.info.mode === "remote" ? "settings.modeRemote" : "settings.modeLocalService")}
            {typeof b.info.agents === "number" && <span> · {t("settings.backendAgentCount", { count: b.info.agents })}</span>}
          </p>
        </div>
        <div className="settings-backend-state">
          <span className={`settings-health ${b.connected && !b.disabled ? "is-healthy" : ""}`}><i />{status}</span>
          {cli && version?.current && <span className="settings-version-short">v{version.current}</span>}
        </div>
        <div className="settings-backend-actions">
          {onConfigure && <button className="ui-cbtn ui-cbtn--sm" onClick={onConfigure}>
            {t("settings.configureConnection")}
          </button>}
          {canToggle && <button className="ui-cbtn ui-cbtn--sm" onClick={onToggle} disabled={toggleDisabled}
            title={lastEnabled ? t("settings.disconnectLastHint") : undefined}>
            {t(b.disabled ? "settings.reconnect" : "settings.disconnect")}
          </button>}
          <button className="settings-detail-toggle" aria-expanded={expanded} aria-controls={`backend-detail-${b.id}`}
            aria-label={t("settings.backendDetails", { name: b.name })} onClick={() => setExpanded(!expanded)}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m5 6 3 3 3-3" /></svg>
          </button>
        </div>
      </div>
      {!cli && <div className="settings-backend-meta">
        {b.info.gatewayUrl && <span className="mono" title={b.info.gatewayUrl}>{b.info.gatewayUrl}</span>}
        {typeof b.info.profiles === "number" && <span>{b.info.profiles} {t("settings.profiles")}</span>}
        {typeof b.info.cronJobs === "number" && <span>{b.info.cronJobs} {t("settings.cronJobs")}</span>}
        {version?.current && <span>v{version.current}</span>}
      </div>}
      {b.disabled && <p className="settings-backend-notice">{t("settings.backendDisabledNote")}</p>}
      {b.info.error && <p className="settings-backend-notice status-error" role="status">{b.info.error}</p>}
      {version?.updateAvailable && !expanded && <button className="settings-update-link" onClick={() => setExpanded(true)}>{t("settings.updateAvailable")} →</button>}
      <div className="settings-backend-details" id={`backend-detail-${b.id}`} hidden={!expanded}>
        {!b.disabled && details}
        {typeof b.info.hasIdentity === "boolean" && <p className="ui-hint">
          {t("settings.deviceIdentity")} · <span className={b.info.hasIdentity ? "" : "status-error"}>{t(b.info.hasIdentity ? "settings.configured" : "settings.missing")}</span>
        </p>}
        {!!b.info.dashboards?.length && <div className="status-dashboards">
          {b.info.dashboards.map((d) => {
            const v = version?.dashboards?.find((item) => item.profile === d.profile);
            return <div className="status-dash" key={d.profile}>
              <span className={d.connected ? "status-dot on" : "status-dot off"} />
              <span>{d.profile}</span><span className="muted mono">{d.baseUrl || `:${d.port}`}</span>
              {(v?.current || d.version) && <span className="muted">v{v?.current || d.version}</span>}
              {v?.updateAvailable && <span className="chip-update">{t("settings.updateAvailable")}</span>}
            </div>;
          })}
        </div>}
      </div>
    </article>
  );
}

export default function BackendOverview({ backends, descriptors, versions, loading, attention, renderDetails, isDisconnectable, enabledCount, configFailed, onToggle, onConfigure }: {
  backends: BackendStatus[];
  descriptors: Map<string, BackendDescriptor>;
  versions: Map<string, BackendVersionStatus>;
  loading: boolean;
  attention: (id: string) => boolean;
  renderDetails: (backend: BackendStatus) => ReactNode;
  isDisconnectable: (backend: BackendStatus) => boolean;
  enabledCount: number;
  configFailed: boolean;
  onToggle: (backend: BackendStatus) => void;
  onConfigure: (id: string) => void;
}) {
  const { t } = useTranslation();
  const isCli = (b: BackendStatus) => (descriptors.get(b.id)?.connectionMode || b.info.connectionMode) === "native-runtime";
  const cliBackends = backends.filter(isCli);
  const serviceBackends = backends.filter((b) => !isCli(b));
  const row = (b: BackendStatus) => <BackendRow key={b.id} backend={b} descriptor={descriptors.get(b.id)} version={versions.get(b.id)}
    attention={attention(b.id)} details={renderDetails(b)} canToggle={isDisconnectable(b)}
    toggleDisabled={loading || configFailed || (!b.disabled && enabledCount <= 1)}
    lastEnabled={!b.disabled && enabledCount <= 1} onToggle={() => onToggle(b)}
    onConfigure={b.id === "openclaw" || (REMOTE_CONNECTIONS_ENABLED && b.id === "hermes") ? () => onConfigure(b.id) : undefined} />;
  return <section className="settings-section" id="settings-conn">
    <header className="settings-section-head settings-heading-row">
      <div><h3 className="settings-h">{t("settings.connStatus")}</h3><p className="settings-sech">{t("settings.connStatusDesc")}</p></div>
      <span className="settings-count">{t("settings.backendsConnected", { connected: backends.filter((b) => b.connected && !b.disabled).length, total: backends.length })}</span>
    </header>
    {backends.length === 0 && <div className="settings-card"><p className="ui-hint">{t(loading ? "common.loading" : "settings.backendsEmpty")}</p></div>}
    {serviceBackends.length > 0 && <div className="settings-backend-grid">{serviceBackends.map(row)}</div>}
    {cliBackends.length > 0 && <div className="settings-native-list">
      <div className="settings-list-heading"><strong>{t("settings.localRuntimes")}</strong><span>{t("settings.localRuntimesHint")}</span></div>
      {cliBackends.map(row)}
    </div>}
  </section>;
}
