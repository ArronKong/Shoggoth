import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getUsageBreakdown } from "../api/client";
import { usePageCache } from "../lib/usePageCache";
import RuntimeUsageBreakdown from "./RuntimeUsageBreakdown";
import styles from "./RuntimeUsageBreakdown.module.css";
type Props = { backend: string; refreshToken?: number; agentName?: (id: string, fallback?: string) => string };
function Contents({ backend, refreshToken, agentName }: Props) {
  const { t } = useTranslation();
  const cache = usePageCache(`dashboard:runtime-usage:${backend}`, () => getUsageBreakdown(backend, "today"));
  const previousToken = useRef(refreshToken);
  useEffect(() => { if (refreshToken !== previousToken.current) { previousToken.current = refreshToken; void cache.refresh(); } }, [refreshToken, cache.refresh]);
  if (cache.error) return <p className={styles.hint} role="alert">{t("usage.runtimeLoadFailed")} <button className="ui-cbtn ui-cbtn--sm" onClick={() => void cache.refresh()}>{t("settings.retry")}</button></p>;
  if (cache.data === undefined) return <p className={styles.hint}>{t("usage.scanning")}</p>;
  if (!cache.data?.runtimes) return <p className={styles.hint}>{t("usage.runtimeUnavailable")}</p>;
  return <RuntimeUsageBreakdown data={cache.data} showAgents agentName={agentName} />;
}
export default function RuntimeUsagePanel(props: Props) {
  const { t } = useTranslation(); const [opened, setOpened] = useState(false);
  return <details className={styles.panel} onToggle={(event) => { if (event.currentTarget.open) setOpened(true); }}>
    <summary className={styles.summary}>{t("usage.runtimeTodayTitle")}</summary>
    {opened && <Contents {...props} />}
  </details>;
}
