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
  return <CustomEndpointsPanel controller={controller} active={Boolean(snapshot.profile)}
    description={t("shoggothProvider.customEndpointsHint")}
    onChanged={() => { void onConfigured(); }} />;
}
