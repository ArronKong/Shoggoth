import { useTranslation } from "react-i18next";
import type { RuntimeFeatures } from "../types";
import "../i18n/runtimeFeatures";

export function RuntimeResumeNotice() {
  const { t } = useTranslation("runtimeFeatures");
  return <p className="ui-hint" role="status">{t("resumeUnavailable")}</p>;
}

export function RuntimeFeatureNotice({ features }: { features: RuntimeFeatures }) {
  const { t } = useTranslation("runtimeFeatures");
  const resumeUnavailable = features.resume === "unsupported";
  const compactUnavailable = features.compact === "unsupported";
  if (!resumeUnavailable && !compactUnavailable) return null;
  return <div className="ui-hint" data-runtime-features>
    {resumeUnavailable && <RuntimeResumeNotice />}
    {compactUnavailable && <p>{t("compactUnavailable")}</p>}
  </div>;
}
