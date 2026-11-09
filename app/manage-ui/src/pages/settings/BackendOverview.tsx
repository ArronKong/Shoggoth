import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { BackendDescriptor, BackendStatus, BackendVersionStatus } from "../../types";
import BackendTabIcon from "../../components/BackendTabIcon";

export function BackendMark({ id, name }: { id: string; name: string }) {
  return <span className="settings-backend-mark" aria-hidden="true">
    <BackendTabIcon backend={id} label={name} />
  </span>;
}

// One compact row per backend: identity, connection state, version and actions.
// Backend-owned settings (gateway, local CLIs) open in a dialog from `manage`.
function BackendRow({ backend: b, descriptor, version, manage, canToggle, toggleDisabled, lastEnabled, onToggle }: {
  backend: BackendStatus;
  descriptor?: BackendDescriptor;
  version?: BackendVersionStatus;
  manage?: ReactNode;
  canToggle: boolean;
  toggleDisabled: boolean;
  lastEnabled: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const cli = (descriptor?.connectionMode || b.info.connectionMode) === "native-runtime";
  const status = b.disabled ? t("settings.backendDisabled") : b.info.starting ? t("settings.serviceWorking")
    : b.connected ? t("common.connected") : t("common.disconnected");
  const toggleButton = canToggle && <button className="btn-secondary btn-sm" onClick={onToggle} disabled={toggleDisabled}
    title={lastEnabled ? t("settings.disconnectLastHint") : undefined}>
    {t(b.disabled ? "settings.reconnect" : "settings.disconnect")}
  </button>;
  const health = <span className={`settings-health ${b.connected && !b.disabled ? "is-healthy" : b.disabled ? "" : b.info.starting ? "is-pending" : "is-down"}`}><i />{status}</span>;
  return (
    <article className={`settings-backend ${cli ? "settings-backend--local" : "settings-backend--card"}`} data-backend={b.id}>
      <div className="settings-backend-row">
        <BackendMark id={b.id} name={b.name} />
        <div className="settings-backend-copy">
          <div className="settings-backend-title">
            <h4>{b.name}</h4>{health}
            {version?.current && <span className="settings-backend-version mono">v{version.current}</span>}
            {/* Read-only notice, styled like the current-version chip. */}
            {version?.updateAvailable && version.comparisonSupported !== false && <span className="settings-backend-version mono">
              {t("settings.updateAvailable")}{version.latest ? ` · v${version.latest}` : ""}
            </span>}
          </div>
        </div>
        <div className="settings-backend-actions">{manage}{toggleButton}</div>
      </div>
      {b.disabled && <p className="settings-backend-notice">{t("settings.backendDisabledNote")}</p>}
      {b.info.error && <p className="settings-backend-notice status-error" role="status">{b.info.error}</p>}
    </article>
  );
}

export default function BackendOverview({ backends, descriptors, versions, loading, renderManage, isDisconnectable, enabledCount, configFailed, onToggle }: {
  backends: BackendStatus[];
  descriptors: Map<string, BackendDescriptor>;
  versions: Map<string, BackendVersionStatus>;
  loading: boolean;
  /** Optional action that opens the backend's own settings dialog. */
  renderManage?: (backend: BackendStatus) => ReactNode;
  isDisconnectable: (backend: BackendStatus) => boolean;
  enabledCount: number;
  configFailed: boolean;
  onToggle: (backend: BackendStatus) => void;
  /** @deprecated Connection editors now live inside their backend card. */
  onConfigure?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const isCli = (b: BackendStatus) => (descriptors.get(b.id)?.connectionMode || b.info.connectionMode) === "native-runtime";
  const cliBackends = backends.filter(isCli);
  const serviceBackends = backends.filter((b) => !isCli(b));
  const row = (b: BackendStatus) => <BackendRow key={b.id} backend={b} descriptor={descriptors.get(b.id)} version={versions.get(b.id)}
    manage={renderManage?.(b)} canToggle={isDisconnectable(b)}
    toggleDisabled={loading || configFailed || (!b.disabled && enabledCount <= 1)}
    lastEnabled={!b.disabled && enabledCount <= 1} onToggle={() => onToggle(b)} />;
  return <section className="settings-section" id="settings-conn">
    <header className="settings-section-head settings-heading-row">
      <div><h3 className="settings-h">{t("settings.connectionsTitle")}</h3><p className="settings-sech">{t("settings.connStatusDesc")}</p></div>
      <span className="settings-count">{t("settings.backendsConnected", { connected: backends.filter((b) => b.connected && !b.disabled).length, total: backends.length })}</span>
    </header>
    {backends.length === 0 && <div className="settings-card"><p className="ui-hint">{t(loading ? "settings.serviceWorking" : "settings.backendsEmpty")}</p></div>}
    {serviceBackends.length > 0 && <div className="settings-backend-stack">{serviceBackends.map(row)}</div>}
    {cliBackends.length > 0 && <div className="settings-native-list">
      <div className="settings-list-heading"><strong>{t("settings.localRuntimes")}</strong><span>{t("settings.localRuntimesHint")}</span></div>
      {cliBackends.map(row)}
    </div>}
  </section>;
}
