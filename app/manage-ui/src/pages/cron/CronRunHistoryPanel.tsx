import { useTranslation } from "react-i18next";
import type { CronRunsFilters } from "../../api/client";
import type { BackendCronKind, CronRun } from "../../types";
import { Option, Select, TextInput } from "../../components/Field";
import { cronDeliveryView, cronExecutionView } from "./runPresentation";

// 运行历史时间可能缺失，统一兜底展示。
function fmtTime(ms?: number | null): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "—";
  }
}

// 运行历史面板负责二级筛选和错误展开，不影响主列表筛选。
export default function CronRunHistoryPanel({
  kind,
  runs,
  loading,
  filters,
  setFilters,
  onRefresh,
  onOpenChat,
}: {
  kind: BackendCronKind;
  runs: CronRun[] | null;
  loading: boolean;
  filters: CronRunsFilters;
  setFilters: (filters: CronRunsFilters) => void;
  onRefresh: () => void;
  onOpenChat?: (sessionKey: string) => void;
}) {
  const { t } = useTranslation();
  // 局部更新运行历史筛选项，并交给父级重新拉取数据。
  const set = <K extends keyof CronRunsFilters>(key: K, value: CronRunsFilters[K]) => {
    setFilters({ ...filters, [key]: value });
  };
  return (
    <div className="run-history-panel">
      <div className="run-history-tools">
        <Select value={filters.status || "all"} onChange={(event) => set("status", event === "all" ? undefined : event)}>
          <Option value="all">{t("cronForm.runsAllStatuses")}</Option>
          <Option value="ok">ok</Option>
          <Option value="error">error</Option>
          <Option value="skipped">skipped</Option>
        </Select>
        {kind === "openclaw" && (
          <Select
            value={filters.deliveryStatus || "all"}
            onChange={(event) => set("deliveryStatus", event === "all" ? undefined : event)}
          >
            <Option value="all">{t("cronForm.runsAllDeliveries")}</Option>
            <Option value="delivered">delivered</Option>
            <Option value="not-delivered">not-delivered</Option>
            <Option value="unknown">unknown</Option>
            <Option value="not-requested">not-requested</Option>
          </Select>
        )}
        <TextInput
          value={filters.query || ""}
          onChange={(event) => set("query", event.target.value)}
          placeholder={t("cronForm.runsSearchPlaceholder")}
        />
        <Select value={filters.sortDir || "desc"} onChange={(event) => set("sortDir", event as CronRunsFilters["sortDir"])}>
          <Option value="desc">{t("cronForm.runsSortNewest")}</Option>
          <Option value="asc">{t("cronForm.runsSortOldest")}</Option>
        </Select>
        <button onClick={onRefresh} disabled={loading}>{t("cronForm.runsRefresh")}</button>
      </div>
      {loading ? (
        <p className="muted">{t("common.loading")}</p>
      ) : runs === null || runs.length === 0 ? (
        <p className="muted">{t("cronForm.runsEmpty")}</p>
      ) : (
        <div className="run-list">
          {runs.map((run, index) => {
            const execution = cronExecutionView(run);
            const delivery = cronDeliveryView(run);
            const failureDelivery = run.failureNotificationDelivery;
            return (
              <div key={run.runId || `${run.startedAt || "run"}-${index}`} className="run-row run-row-rich">
                <div className="run-outcomes">
                  <div className={`run-outcome run-outcome--${execution.tone}`} data-outcome="execution">
                    <span className="run-outcome__label">{t("cronForm.runExecutionResult")}</span>
                    <span className={`status status-${execution.value}`}>{execution.value}</span>
                    {execution.detail && <span className="run-outcome__detail">{execution.detail}</span>}
                  </div>
                  {delivery && (
                    <div className={`run-outcome run-outcome--${delivery.tone}`} data-outcome="delivery">
                      <span className="run-outcome__label">{t("cronForm.runDeliveryResult")}</span>
                      <span className={`status status-${delivery.value}`}>{delivery.value}</span>
                      {delivery.detail && <span className="run-outcome__detail">{delivery.detail}</span>}
                    </div>
                  )}
                  {failureDelivery && (
                    <div className="run-outcome run-outcome--neutral" data-outcome="failure-notification">
                      <span className="run-outcome__label">{t("cronForm.runFailureNotification")}</span>
                      <span className={`status status-${failureDelivery.status}`}>{failureDelivery.status}</span>
                      {failureDelivery.error && <span className="run-outcome__detail">{failureDelivery.error}</span>}
                    </div>
                  )}
                </div>
                <div className="run-row__meta">
                  <span className="mono">{fmtTime(run.startedAt)}</span>
                  {typeof run.durationMs === "number" && <span className="muted">{Math.round(run.durationMs / 100) / 10}s</span>}
                  {run.model && <span className="muted">{run.provider ? `${run.provider}/` : ""}{run.model}</span>}
                  {run.runId && <span className="mono muted">{run.runId}</span>}
                  {kind !== "native" && run.sessionKey && <span className="mono muted">{run.sessionKey}</span>}
                  {kind === "native" && run.sessionKey && onOpenChat && (
                    <button onClick={() => onOpenChat(run.sessionKey!)}>{t("cron.askInChat")}</button>
                  )}
                </div>
                {run.summary && <span className="muted run-row__summary">{run.summary}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
