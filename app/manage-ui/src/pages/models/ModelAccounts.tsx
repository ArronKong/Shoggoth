import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { BackendDescriptor } from "../../types";
import OAuthProvidersCard from "../keys/OAuthProvidersCard";
import CustomEndpointsPanel from "./CustomEndpointsPanel";
import { createShoggothEndpointController } from "./endpoint-controller";
import styles from "./ModelAccounts.module.css";

export default function ModelAccounts({ backend, refreshKey, onChanged }: {
  backend: BackendDescriptor;
  refreshKey: number;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const endpointController = useMemo(() => createShoggothEndpointController(), []);
  return <div className={styles.stack} id="models-runtime-accounts">
    <OAuthProvidersCard backend={backend.id} refreshKey={refreshKey} onChanged={onChanged} />
    {backend.id === "shoggoth" && <CustomEndpointsPanel controller={endpointController} active
      refreshKey={refreshKey} description={t("models.shoggothEndpointsSubtitle")} onChanged={onChanged} />}
  </div>;
}
