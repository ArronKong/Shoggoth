import { useTranslation } from "react-i18next";
import s from "../pages/ConnectorsPage.module.css";

export default function ConnectorAddButton({ name, onClick, disabled }: { name: string; onClick: () => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const label = `${t("mcpConnectors.add")} ${name}`;
  return <button type="button" className={`btn-secondary ${s.serviceAdd}`} aria-label={label} title={label} onClick={onClick} disabled={disabled}>
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M3 8h10M8 3v10" />
    </svg>
  </button>;
}
