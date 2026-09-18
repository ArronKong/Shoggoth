import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { getShoggothProductStatus, getShoggothProviders } from "../../api/client";
import { ShoggothProviderSetup } from "../../components/ShoggothProviderSetup";
import { usePageCache } from "../../lib/usePageCache";
import type { BackendDescriptor } from "../../types";
import OAuthProvidersCard from "../keys/OAuthProvidersCard";
import cardStyles from "../keys/KeysPanel.module.css";
import styles from "./ModelAccounts.module.css";

function ShoggothModelSettings({ refreshKey, onChanged }: {
  refreshKey: number;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const { data, loading, error, refresh } = usePageCache("models:shoggoth:provider-settings", async () => {
    const status = await getShoggothProductStatus();
    const providers = status.service.healthy ? await getShoggothProviders() : null;
    return { status, providers };
  });
  useEffect(() => { if (refreshKey > 0) void refresh(); }, [refreshKey, refresh]);
  const providers = data?.providers ?? null;
  return <details className={cardStyles.card} open={!providers?.profile?.ready}>
    <summary className={styles.providerSummary}>
      <div>
        <h4 className={cardStyles.cardTitle}>{t("models.providerSettingsTitle")}</h4>
        <p className={cardStyles.cardDesc}>{providers?.profile?.defaultModel || t("models.providerSettingsHint")}</p>
      </div>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m5 6 3 3 3-3" /></svg>
    </summary>
    <div className={styles.providerBody}>
      {loading && !data ? <p className="muted">{t("common.loading")}</p>
        : error || !data?.status.service.healthy || !providers ? <div role="alert">
          <p className="muted">{t(error ? "models.accountUnavailable" : "models.providerServiceRequired")}</p>
          <button className="ui-cbtn ui-cbtn--sm" onClick={() => void refresh()}>{t("settings.retry")}</button>
        </div> : <>
          {providers.providers.length > 0 && <div className={styles.providerList}>
            {providers.providers.map((provider) => <div key={provider.id}>
              <strong>{provider.displayName}</strong>{provider.baseUrlHost && <span>{provider.baseUrlHost}</span>}
              <span>{t(provider.authState === "authenticated" ? "settings.providerAuthenticated"
                : provider.authState === "configured" || provider.authState === "not_required" ? "settings.configured" : "settings.providerNeedsAuth")}</span>
            </div>)}
          </div>}
          <ShoggothProviderSetup snapshot={providers} onConfigured={onChanged} />
        </>}
    </div>
  </details>;
}

export default function ModelAccounts({ backend, refreshKey, onChanged }: {
  backend: BackendDescriptor;
  refreshKey: number;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  return <div className={styles.stack} id="models-runtime-accounts">
    <OAuthProvidersCard backend={backend.id} title={t("models.accountTitle", { name: backend.name })}
      showActionLabels refreshKey={refreshKey} onChanged={onChanged} />
    {backend.id === "shoggoth" && <ShoggothModelSettings refreshKey={refreshKey} onChanged={onChanged} />}
  </div>;
}
