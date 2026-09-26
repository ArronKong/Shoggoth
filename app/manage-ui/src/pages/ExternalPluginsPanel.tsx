import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getExternalPluginCatalog, type ExternalPluginCatalog } from "../api/client";
import styles from "./PluginsPage.module.css";

export function ExternalPluginsPanel({ backend, backendName }: { backend: string; backendName: string }) {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<ExternalPluginCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const generation = ++request.current;
    setLoading(true); setFailed(false); setCatalog(null);
    try {
      const page = await getExternalPluginCatalog(backend);
      if (generation === request.current) setCatalog(page);
    } catch {
      if (generation === request.current) setFailed(true);
    } finally {
      if (generation === request.current) setLoading(false);
    }
  }, [backend]);
  useEffect(() => {
    void refresh();
    return () => { request.current += 1; };
  }, [refresh]);
  const more = async () => {
    if (!catalog?.nextCursor || !catalog.catalogRevision || busy || failed) return;
    const generation = ++request.current;
    setBusy(true);
    try {
      const page = await getExternalPluginCatalog(backend, catalog.nextCursor, catalog.catalogRevision);
      if (generation === request.current) setCatalog(page.supported
        ? { ...page, items: [...catalog.items, ...page.items] } : page);
    } catch {
      if (generation === request.current) setFailed(true);
    } finally {
      if (generation === request.current) setBusy(false);
    }
  };
  const unavailable = failed || (catalog !== null && !catalog.supported);
  return <section className={`${styles.card} ${styles.externalCatalog}`} data-plugin-host={backend}
    aria-labelledby="external-plugins-heading" aria-busy={loading || busy}>
    <div className={styles.cardHeading}>
      <h2 id="external-plugins-heading">{backendName}{catalog?.hostVersion ? ` · ${catalog.hostVersion}` : ""}</h2>
      {catalog?.supported && <span className={styles.pending}>{t("plugins.externalCount", { count: catalog.items.length })}</span>}
    </div>
    <p>{t("plugins.externalReadOnly")}</p>
    {loading && <p role="status">{t("plugins.loading")}</p>}
    {unavailable && <div role="status">
      <p>{t(catalog?.reasonCode === "PLUGIN_EXTERNAL_RESPONSE_INVALID" ? "plugins.externalInvalid" : "plugins.externalUnavailable")}</p>
      <button type="button" className="btn-secondary" onClick={() => void refresh()}>{t("plugins.externalRetry")}</button>
    </div>}
    {catalog?.supported && <>
      {catalog.items.length === 0 && <p>{t("plugins.externalEmpty")}</p>}
      <ul className={styles.packageList}>{catalog.items.map(item => <li className={styles.packageItem} key={item.pluginId}>
        <div className={styles.packageHeading}>
          <strong>{item.name}{item.version ? ` · ${item.version}` : ""}</strong>
          {item.sourceKind === "bundled" && <span>{t("plugins.externalBundled")}</span>}
        </div>
        <div className={styles.packageMeta}>
          {t(item.desiredState === "enabled" ? "plugins.desiredEnabled"
            : item.desiredState === "disabled" ? "plugins.disabled" : "plugins.externalDesiredUnknown")}
          {` · ${item.observedState === "unknown" ? t("plugins.externalUnknown") : item.observedState}`}
        </div>
      </li>)}</ul>
      {catalog.nextCursor && <button type="button" className="btn-secondary" disabled={busy || failed}
        onClick={() => void more()}>{t(busy ? "plugins.loading" : "plugins.loadMore")}</button>}
    </>}
  </section>;
}
