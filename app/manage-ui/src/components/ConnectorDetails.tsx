import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import s from "../pages/ConnectorsPage.module.css";

export type ConnectorGuide = { url?: string | null; label: string };

export function ConnectorFooter({ children, hint, onRemove, removeDisabled }: { children: ReactNode; hint: string; onRemove?: () => void; removeDisabled?: boolean }) {
  const { t } = useTranslation();
  return <div className={s.flowFooter} data-connector-footer>
    {onRemove ? <button type="button" className="btn-danger btn-sm" disabled={removeDisabled} onClick={onRemove}>{t("mcpConnectors.flow.remove")}</button> : <p>{hint}</p>}
    <div className={s.flowFooterActions}>{children}</div>
  </div>;
}

export function ConnectorConnectionHeading({ title, status, guide }: { title: string; status: ReactNode; guide?: ConnectorGuide }) {
  return <div className={s.connectionHeading}>
    <h3>{title}</h3>
    <div className={s.connectionStatus}>
      {guide?.url && /^https:\/\//i.test(guide.url) && <a className={s.connectionGuide} href={guide.url} target="_blank" rel="noopener noreferrer">{guide.label}</a>}
      {status}
    </div>
  </div>;
}

export function ConnectorInfo({ developer, version }: { developer?: string; version?: string | null }) {
  const { t } = useTranslation();
  return <section className={s.connectorInfo}>
    <h3>{t("mcpConnectors.flow.information")}</h3>
    <dl>
      <dt>{t("mcpConnectors.flow.developer")}</dt><dd>{developer || "—"}</dd>
      <dt>{t("mcpConnectors.version")}</dt><dd>{version || "—"}</dd>
    </dl>
  </section>;
}
