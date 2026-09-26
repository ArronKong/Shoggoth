import { useTranslation } from "react-i18next";
import type { UsageBreakdown } from "../types";
import { fmtTokens } from "../pages/usage/charts";
import styles from "./RuntimeUsageBreakdown.module.css";

export default function RuntimeUsageBreakdown({ data, showAgents = false, agentName }: {
  data: UsageBreakdown; showAgents?: boolean; agentName?: (id: string, fallback?: string) => string;
}) {
  const { t } = useTranslation();
  const rows = data.runtimes;
  if (rows === undefined) return null;
  return <div className={styles.content}>
    {showAgents && <div className={styles.agentTotals}>
      <h4>{t("usage.runtimeAgentTotals")}</h4>
      {data.byAgent.length ? <ul>{data.byAgent.map((entry) => {
        const source = data.bySource?.find((item) => item.id === entry.agentId);
        return <li key={entry.agentId}><span>{agentName?.(entry.agentId, source?.label) || source?.label || entry.agentId}</span><strong>{fmtTokens(entry.totalTokens)}</strong></li>;
      })}</ul> : <p className={styles.hint}>{t("usage.runtimeEmpty")}</p>}
    </div>}
    <div><h4>{t("usage.runtimeDistribution")}</h4><p className={styles.hint}>{t("usage.runtimeDistributionHint")}</p>
      {!rows.length ? <p className={styles.hint}>{t("usage.runtimeEmpty")}</p> : <div className={styles.scroll}>
        <table><thead><tr><th>{t("usage.runtimeColumn")}</th><th>{t("usage.runtimeAccountColumn")}</th><th className={styles.number}>{t("usage.runtimeTokensColumn")}</th></tr></thead>
          <tbody>{rows.map((entry) => <tr key={`${entry.runtime ?? "unknown"}:${entry.runtimeAccountId ?? "unknown"}`}>
            <td>{entry.runtime ?? t("usage.runtimeUnknown")}</td><td className={styles.account}>{entry.runtimeAccountId ?? t("usage.runtimeUnknown")}</td>
            <td className={styles.number}>{fmtTokens(entry.totalTokens)}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    </div>
  </div>;
}
