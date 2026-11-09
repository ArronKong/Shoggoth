import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { BackendDescriptor, BackendStatus, BackendVersionStatus } from "../../types";
import BackendTabIcon, { sortBackendTabs } from "../../components/BackendTabIcon";

export type ConnectionStatusState = "loading" | "ready" | "failed";
type BackendIdentity = Pick<BackendStatus, "id" | "name">;
type ConnectionCard = BackendIdentity & { status?: BackendStatus };

export function BackendMark({ id, name }: { id: string; name: string }) {
  return <span className="settings-backend-mark" aria-hidden="true">
    <BackendTabIcon backend={id} label={name} />
  </span>;
}

// One compact row per backend: identity, connection state, version and actions.
// Backend-owned settings (gateway, local CLIs) open in a dialog from `manage`.
function BackendRow({ card, cli, statusState, version, manage, canToggle, toggleDisabled, lastEnabled, onToggle }: {
  card: ConnectionCard;
  cli: boolean;
  statusState: ConnectionStatusState;
  version?: BackendVersionStatus;
  manage?: ReactNode;
  canToggle: boolean;
  toggleDisabled: boolean;
  lastEnabled: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const b = card.status;
  const visibleStatus = statusState === "failed" ? undefined : b;
  const status = visibleStatus
    ? t(visibleStatus.disabled ? "settings.backendDisabled" : visibleStatus.info.starting ? "settings.serviceWorking"
      : visibleStatus.connected ? "common.connected" : "common.disconnected")
    : t(statusState === "loading" ? "common.loading" : "settings.connectionStatusUnavailable");
  const healthClass = !visibleStatus || visibleStatus.disabled ? "" : visibleStatus.connected ? " is-healthy"
    : visibleStatus.info.starting ? " is-pending" : " is-down";
  const toggleButton = canToggle && <button className="btn-secondary btn-sm" onClick={onToggle} disabled={toggleDisabled}
    title={lastEnabled ? t("settings.disconnectLastHint") : undefined}>
    {t(b?.disabled ? "settings.reconnect" : "settings.disconnect")}
  </button>;
  const health = <span className={`settings-health${healthClass}`}><i />{status}</span>;
  return (
    <article className={`settings-backend ${cli ? "settings-backend--local" : "settings-backend--card"}`} data-backend={card.id}>
      <div className="settings-backend-row">
        <BackendMark id={card.id} name={card.name} />
        <div className="settings-backend-copy">
          <div className="settings-backend-title">
            <h4>{card.name}</h4>{health}
            {version?.current && <span className="settings-backend-version mono">v{version.current}</span>}
            {/* Read-only notice, styled like the current-version chip. */}
            {version?.updateAvailable && version.comparisonSupported !== false && <span className="settings-backend-version mono">
              {t("settings.updateAvailable")}{version.latest ? ` · v${version.latest}` : ""}
            </span>}
          </div>
        </div>
        <div className="settings-backend-actions">{manage}{toggleButton}</div>
      </div>
      {b?.disabled && <p className="settings-backend-notice">{t("settings.backendDisabledNote")}</p>}
      {visibleStatus?.info.error && <p className="settings-backend-notice status-error" role="status">{visibleStatus.info.error}</p>}
    </article>
  );
}

export default function BackendOverview({ backends, descriptors, fallbackBackends = [], statusState = "ready", versions, loading, renderManage, isDisconnectable, enabledCount, configFailed, onToggle }: {
  backends: BackendStatus[];
  descriptors: Map<string, BackendDescriptor>;
  fallbackBackends?: BackendIdentity[];
  statusState?: ConnectionStatusState;
  versions: Map<string, BackendVersionStatus>;
  loading: boolean;
  /** Optional action that opens the backend's own settings dialog. */
  renderManage?: (id: string) => ReactNode;
  isDisconnectable: (backend: BackendStatus) => boolean;
  enabledCount: number;
  configFailed: boolean;
  onToggle: (backend: BackendStatus) => void;
  /** @deprecated Connection editors now live inside their backend card. */
  onConfigure?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const byId = new Map<string, ConnectionCard>(fallbackBackends.map((card) => [card.id, card]));
  if (backends.length === 0 && statusState !== "ready") {
    for (const descriptor of descriptors.values()) byId.set(descriptor.id, descriptor);
  }
  for (const b of backends) byId.set(b.id, { id: b.id, name: b.name, status: b });
  const cards = sortBackendTabs([...byId.values()]);
  const isCli = (card: ConnectionCard) => (descriptors.get(card.id)?.connectionMode || card.status?.info.connectionMode) === "native-runtime";
  const cliBackends = cards.filter(isCli);
  const serviceBackends = cards.filter((card) => !isCli(card));
  const row = (card: ConnectionCard) => {
    const b = card.status;
    const lastEnabled = statusState === "ready" && !!b && !b.disabled && enabledCount <= 1;
    return <BackendRow key={card.id} card={card} cli={isCli(card)} statusState={statusState} version={versions.get(card.id)}
      manage={renderManage?.(card.id)} canToggle={!!b && isDisconnectable(b)}
      toggleDisabled={statusState !== "ready" || loading || configFailed || lastEnabled}
      lastEnabled={lastEnabled} onToggle={() => { if (b) onToggle(b); }} />;
  };
  return <section className="settings-section" id="settings-conn">
    <header className="settings-section-head settings-heading-row">
      <div><h3 className="settings-h">{t("settings.connectionsTitle")}</h3><p className="settings-sech">{t("settings.connStatusDesc")}</p></div>
      {backends.length > 0 && statusState !== "failed" && <span className="settings-count">{t("settings.backendsConnected", { connected: backends.filter((b) => b.connected && !b.disabled).length, total: backends.length })}</span>}
    </header>
    {(statusState === "failed" || (statusState === "ready" && backends.length === 0)) && <p className="ui-hint" role="status">{t("settings.backendsEmpty")}</p>}
    {serviceBackends.length > 0 && <div className="settings-backend-stack">{serviceBackends.map(row)}</div>}
    {cliBackends.length > 0 && <div className="settings-native-list">
      <div className="settings-list-heading"><strong>{t("settings.localRuntimes")}</strong><span>{t("settings.localRuntimesHint")}</span></div>
      {cliBackends.map(row)}
    </div>}
  </section>;
}
