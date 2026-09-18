import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { CronListFilters } from "../../api/client";
import type { UnifiedAgent } from "../../types";
import CronFilterMenu from "./CronFilterMenu";
import { IconAgent, IconSliders } from "./cronIcons";

// Cron 列表筛选统一控制服务端查询参数，日历和列表共享结果集。
export default function CronFiltersBar({
  filters,
  agents,
  onChange,
}: {
  filters: CronListFilters;
  agents: UnifiedAgent[];
  onChange: (filters: CronListFilters) => void;
}) {
  const { t } = useTranslation();
  // 局部更新单个筛选项，保留其它筛选条件。
  const set = <K extends keyof CronListFilters>(key: K, value: CronListFilters[K]) => {
    onChange({ ...filters, [key]: value });
  };
  // 两个后端可能有同 id 的 agent，按 id 去重后再列。
  const agentOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const agent of agents) {
      if (!seen.has(agent.id)) seen.set(agent.id, agent.name || agent.id);
    }
    return Array.from(seen, ([value, label]) => ({ value, label }));
  }, [agents]);

  return (
    <div className="cron-filters">
      <CronFilterMenu
        multiple
        icon={<IconAgent />}
        label={t("cronForm.filtersAgent")}
        options={agentOptions}
        emptyHint={t("cronForm.filtersNoAgents")}
        value={filters.agentIds || []}
        onChange={(value) => set("agentIds", value)}
      />
      <CronFilterMenu
        icon={<IconSliders />}
        label={t("cronForm.filtersStatuses")}
        options={[
          { value: "all", label: t("cronForm.filtersAllStatuses") },
          { value: "enabled", label: t("cronForm.filtersEnabled") },
          { value: "disabled", label: t("cronForm.filtersDisabled") },
        ]}
        value={filters.enabled || "all"}
        onChange={(value) => set("enabled", value as CronListFilters["enabled"])}
      />
      <CronFilterMenu
        icon={<IconSliders />}
        label={t("cronForm.filtersSchedules")}
        options={[
          { value: "all", label: t("cronForm.filtersAllSchedules") },
          // 值仍是后端认的 "cron"，只把展示文案首字母大写，和同排其它标签统一。
          { value: "cron", label: "Cron" },
          { value: "every", label: t("cronForm.filtersEvery") },
          { value: "at", label: t("cronForm.filtersAt") },
          { value: "on-exit", label: t("cronForm.filtersOnExit") },
          { value: "stream", label: t("cronForm.filtersStream") },
        ]}
        value={filters.scheduleKind || "all"}
        onChange={(value) => set("scheduleKind", value as CronListFilters["scheduleKind"])}
      />
    </div>
  );
}
