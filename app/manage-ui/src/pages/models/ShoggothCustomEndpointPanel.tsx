import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ShoggothProviderSnapshot } from "../../types";
import CustomEndpointsPanel from "./CustomEndpointsPanel";
import { createShoggothEndpointController } from "./endpoint-controller";

export default function ShoggothCustomEndpointPanel({ snapshot, profileId = snapshot.profile?.id, onConfigured }: {
  snapshot: ShoggothProviderSnapshot;
  profileId?: string | null;
  onConfigured: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const controller = useMemo(() => createShoggothEndpointController(profileId ?? undefined), [profileId]);
  // The "active in" badge follows the default source chosen above; reload the
  // list whenever that default changes.
  const defaultSource = `${snapshot.profile?.configuredProviderId ?? ""}\0${snapshot.profile?.defaultModel ?? ""}`;
  const refreshKey = useMemo(() => {
    let hash = 0;
    for (const char of defaultSource) hash = (hash * 31 + char.charCodeAt(0)) | 0;
    return hash;
  }, [defaultSource]);
  return <CustomEndpointsPanel controller={controller} active={Boolean(snapshot.profile)} refreshKey={refreshKey}
    description={t("shoggothProvider.customEndpointsHint")}
    onChanged={() => { void onConfigured(); }} />;
}
