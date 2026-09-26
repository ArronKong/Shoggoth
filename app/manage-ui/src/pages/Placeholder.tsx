// Temporary stand-in for sections not yet rebuilt in React (see plan slices).
import { useTranslation } from "react-i18next";

export default function Placeholder({ title }: { title: string }) {
  const { t } = useTranslation();
  return (
    <div className="page placeholder">
      <h2>{title}</h2>
      <p className="muted">{t("placeholder.body")}</p>
    </div>
  );
}
