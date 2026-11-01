import { useTranslation } from "react-i18next";
import type { RuntimeFeatures } from "../types";
import "../i18n/runtimeFeatures";

export function RuntimeResumeNotice() {
  const { t } = useTranslation("runtimeFeatures");
  return <p className="ui-hint" role="status">{t("resumeUnavailable")}</p>;
}

export function RuntimeFeatureNotice({ features }: { features: RuntimeFeatures }) {
  const { t } = useTranslation("runtimeFeatures");
  return <div className="ui-hint" data-runtime-features>
    {features.resume === "unsupported" && <RuntimeResumeNotice />}
    {features.compact === "unsupported" && <p>{t("compactUnavailable")}</p>}
    <p>{t("availableAttachments", { kinds: features.attachments.length
      ? features.attachments.map(kind => t(kind)).join(" / ") : t("attachmentsUnverified") })}</p>
  </div>;
}
