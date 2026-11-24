import { useTranslation } from "react-i18next";
import "../i18n/runtimeFeatures";

export function RuntimeResumeNotice() {
  const { t } = useTranslation("runtimeFeatures");
  return <p className="ui-hint" role="status">{t("resumeUnavailable")}</p>;
}
