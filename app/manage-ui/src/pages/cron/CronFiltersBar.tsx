import { useTranslation } from "react-i18next";
import type { CronListFilters } from "../../api/client";
import type { BackendDescriptor, UnifiedAgent } from "../../types";
import CronFilterMenu, { CronAgentFilter } from "./CronFilterMenu";
import { CRON_SCHEDULE_TYPES } from "./CronFormLayout";
import { IconSchedule, IconSliders } from "./cronIcons";

// Cron 列表筛选统一控制服务端查询参数，日历和列表共享结果集。
export default function CronFiltersBar({
  filters,
  agents,
  backends,
  onChange,
}: {
  filters: CronListFilters;
  agents: Record<string, UnifiedAgent[]>;
  backends: BackendDescriptor[];
  onChange: (filters: CronListFilters) => void;
}) {
  const { t } = useTranslation();
  // 局部更新单个筛选项，保留其它筛选条件。
  const set = <K extends keyof CronListFilters>(key: K, value: CronListFilters[K]) => {
    onChange({ ...filters, [key]: value });
  };
  return (
    <div className="cron-filters">
      <CronAgentFilter
        backends={backends}
        agents={agents}
        value={filters.agentScopes}
        legacyAgentIds={filters.agentIds}
        onChange={(agentScopes) => onChange({ ...filters, agentIds: undefined, agentScopes })}
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
        icon={<IconSchedule />}
        label={t("cronForm.filtersSchedules")}
        options={[
          { value: "all", label: t("cronForm.filtersAllSchedules") },
          ...CRON_SCHEDULE_TYPES.map((kind) => ({ value: kind, label: t(`cronForm.scheduleType_${kind}`) })),
        ]}
        value={filters.scheduleKind || "all"}
        onChange={(value) => set("scheduleKind", value as CronListFilters["scheduleKind"])}
      />
    </div>
  );
}
