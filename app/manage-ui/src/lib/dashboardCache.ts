import type { DashboardSummary } from "../types";

/** Dashboard 摘要缓存只使用一个稳定 key，后续写入会原位覆盖。 */
export const DASHBOARD_CACHE_KEY = "shoggoth.dashboard.summary";

/** 缓存信封版本；结构不兼容时递增并让旧缓存自动失效。 */
export const DASHBOARD_CACHE_VERSION = 1;

/** 原始 JSON 的最大 UTF-8 字节数，避免解析异常大的本地缓存。 */
export const DASHBOARD_CACHE_MAX_BYTES = 1024 * 1024;

/** Dashboard 缓存所需的最小 Storage 接口，便于测试和其它宿主注入。 */
export interface DashboardCacheStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 读写包装器的可注入依赖；不传时使用浏览器 localStorage 和当前时间。 */
export interface DashboardCacheOptions {
  storage?: DashboardCacheStorage;
  now?: number;
}

/** Dashboard 渲染层只消费这一份统一状态，避免缓存首帧被实时 loading/error 覆盖。 */
export interface DashboardViewState {
  data: DashboardSummary | undefined;
  showLoading: boolean;
  blockingError: string | null;
  nonBlockingError: string | null;
}

interface DashboardCacheEnvelope {
  version: number;
  savedAt: number;
  data: DashboardSummary;
}

/** 判断值是否为非 null、非数组的普通记录形状。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 判断值是否为有限数字，排除 NaN 和 Infinity。 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 计算给定时间所在本地日期的零点，缓存日界线与 Dashboard 服务口径保持一致。 */
function getLocalDayStart(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** 校验记录中的可选字符串字段；字段缺省不影响前后兼容。 */
function hasOptionalString(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || typeof record[key] === "string";
}

/** 校验记录中的可选有限数字字段，可按真实类型允许 null。 */
function hasOptionalFiniteNumber(
  record: Record<string, unknown>,
  key: string,
  allowNull = false,
): boolean {
  const value = record[key];
  return value === undefined || (allowNull && value === null) || isFiniteNumber(value);
}

/** 校验记录中的可选布尔字段。 */
function hasOptionalBoolean(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || typeof record[key] === "boolean";
}

/** 校验 Dashboard 健康状态行会直接读取的字段。 */
function isBackendStatus(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.connected !== "boolean" ||
    !isRecord(value.info)
  ) {
    return false;
  }

  return ["agents", "cronJobs", "profiles"].every((key) =>
    hasOptionalFiniteNumber(value.info as Record<string, unknown>, key),
  );
}

/** 校验运行记录的必需键和 Dashboard/弹窗会消费的所有可选字段。 */
function isRunEntry(value: unknown): boolean {
  if (!isRecord(value) || typeof value.backendId !== "string" || typeof value.jobId !== "string") return false;

  const optionalStrings = [
    "jobName",
    "agentId",
    "status",
    "completionStatus",
    "error",
    "errorReason",
    "summary",
    "deliveryStatus",
    "deliveryError",
    "deliverySuppressionReason",
    "model",
    "sessionKey",
    "runId",
  ];
  return (
    optionalStrings.every((key) => hasOptionalString(value, key)) &&
    hasOptionalFiniteNumber(value, "startedAt", true) &&
    hasOptionalFiniteNumber(value, "finishedAt", true) &&
    hasOptionalFiniteNumber(value, "durationMs") &&
    hasOptionalBoolean(value, "synthesized")
  );
}

/** 校验 usage 今日/昨日点位，KPI 会直接读取日期、Token 和成本。 */
function isUsagePoint(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.date === "string" &&
    isFiniteNumber(value.totalTokens) &&
    isFiniteNumber(value.totalCost)
    && ["missingCostEntries", "estimatedCostEntries"].every(key => hasOptionalFiniteNumber(value, key))
  );
}

/** 校验单条 usage 记录。 */
function isUsageEntry(value: unknown): boolean {
  if (!isRecord(value) || typeof value.backend !== "string" || !hasOptionalString(value, "error")) return false;
  if (value.availability !== undefined && !["complete", "partial", "unavailable"].includes(String(value.availability))) return false;
  if (!hasOptionalBoolean(value, "yesterdayComplete")) return false;
  if (value.today !== undefined && !isUsagePoint(value.today)) return false;
  if (value.yesterday !== undefined && !isUsagePoint(value.yesterday)) return false;
  return true;
}

/** 校验正在运行条目，避免摘要清理时对非字符串调用 replace。 */
function isRunningItem(value: unknown): boolean {
  if (!isRecord(value) || typeof value.id !== "string") return false;
  return (
    ["title", "kind", "agentId", "progressSummary"].every((key) => hasOptionalString(value, key)) &&
    hasOptionalFiniteNumber(value, "startedAt")
  );
}

/** 校验审批条目及弹窗会读取的可选字段。 */
function isApprovalItem(value: unknown): boolean {
  if (!isRecord(value) || typeof value.id !== "string") return false;
  if (!["commandPreview", "commandText", "agentId"].every((key) => hasOptionalString(value, key))) return false;
  if (
    value.allowedDecisions !== undefined &&
    (!Array.isArray(value.allowedDecisions) || !value.allowedDecisions.every((item) => typeof item === "string"))
  ) {
    return false;
  }
  return hasOptionalFiniteNumber(value, "createdAtMs") && hasOptionalFiniteNumber(value, "expiresAtMs");
}

/** 校验产出文件行展示、排序和 Finder 定位所需字段。 */
function isArtifactItem(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.path === "string" &&
    typeof value.name === "string" &&
    typeof value.area === "string" &&
    isFiniteNumber(value.mtimeMs) &&
    typeof value.kind === "string" &&
    hasOptionalString(value, "agentId") &&
    hasOptionalString(value, "ext") &&
    hasOptionalFiniteNumber(value, "size")
  );
}

/** 校验能力 section 的公共字段，并委托对应条目验证器。 */
function isBackendSectionArray(
  value: unknown,
  isItem: (item: unknown) => boolean,
): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (section) =>
        isRecord(section) &&
        typeof section.backend === "string" &&
        typeof section.supported === "boolean" &&
        hasOptionalString(section, "reason") &&
        Array.isArray(section.items) &&
        section.items.every(isItem),
    )
  );
}

/** 校验活动公共字段，保证排序、头像和摘要清理均可安全执行。 */
function hasValidActivityBase(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === "string" &&
    typeof value.backendId === "string" &&
    typeof value.title === "string" &&
    isFiniteNumber(value.occurredAt) &&
    typeof value.severity === "string" &&
    hasOptionalString(value, "agentId") &&
    hasOptionalString(value, "summary")
  );
}

/** 按活动 kind 校验对应载荷，防止消费方解引用错误分支。 */
function isActivityItem(value: unknown): boolean {
  if (!isRecord(value) || !hasValidActivityBase(value)) return false;

  switch (value.kind) {
    case "cron":
      return isRunEntry(value.run);
    case "kanban":
      return (
        isRecord(value.kanban) &&
        typeof value.kanban.taskId === "string" &&
        typeof value.kanban.action === "string" &&
        ["board", "fromStatus", "toStatus"].every((key) =>
          hasOptionalString(value.kanban as Record<string, unknown>, key),
        )
      );
    case "health":
      return (
        isRecord(value.health) &&
        typeof value.health.targetType === "string" &&
        typeof value.health.targetId === "string" &&
        typeof value.health.state === "string" &&
        hasOptionalBoolean(value.health, "detectedAfterRestart")
      );
    default:
      return false;
  }
}

/** 校验活动来源降级说明，避免 i18n 模板收到对象或 null。 */
function isDegradedSource(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.backend === "string" &&
    typeof value.source === "string" &&
    typeof value.reason === "string"
  );
}

/** 校验可选活动页容器、多态条目、分页游标和降级来源。 */
function isActivityPage(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.every(isActivityItem) &&
    Array.isArray(value.degradedSources) &&
    value.degradedSources.every(isDegradedSource) &&
    typeof value.hasMore === "boolean" &&
    hasOptionalString(value, "nextCursor") &&
    hasOptionalFiniteNumber(value, "sinceMs") &&
    hasOptionalFiniteNumber(value, "generatedAt")
  );
}

/** 校验 runStats.total 中所有 KPI 数字均存在且有限。 */
function isRunStats(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.total)) return false;
  const total = value.total;

  return ["ok", "error", "skipped", "other", "total"].every((key) =>
    isFiniteNumber(total[key]),
  );
}

function isTaskStats(value: unknown): boolean {
  const counts = (row: unknown) => isRecord(row) && [row.ok, row.error].every(
    count => typeof count === "number" && Number.isSafeInteger(count) && count >= 0,
  );
  return isRecord(value) && counts(value.total) && isRecord(value.byKind)
    && ["cron", "kanban", "inspiration"].every(kind => counts((value.byKind as Record<string, unknown>)[kind]))
    && Array.isArray(value.byAgent) && value.byAgent.every(row => isRecord(row)
      && typeof row.backendId === "string" && typeof row.agentId === "string" && counts(row))
    && typeof value.complete === "boolean";
}

/**
 * 递归校验 DashboardSummary 的最低安全形状。
 * 仅约束当前读取方会直接访问的结构，并允许额外字段以维持前后兼容。
 */
function isDashboardSummary(value: unknown, todayStart: number): value is DashboardSummary {
  if (!isRecord(value)) return false;
  if (!isFiniteNumber(value.generatedAt) || value.sinceMs !== todayStart) return false;
  if (!Array.isArray(value.status) || !value.status.every(isBackendStatus)) return false;
  if (!Array.isArray(value.runs) || !value.runs.every(isRunEntry)) return false;
  if (!Array.isArray(value.usage) || !value.usage.every(isUsageEntry)) return false;
  if (!isBackendSectionArray(value.running, isRunningItem)) return false;
  if (!isBackendSectionArray(value.approvals, isApprovalItem)) return false;
  if (!isBackendSectionArray(value.artifacts, isArtifactItem)) return false;
  if (value.activityPage !== undefined && !isActivityPage(value.activityPage)) return false;
  if (value.runStats !== undefined && !isRunStats(value.runStats)) return false;
  if (value.taskStats !== undefined && !isTaskStats(value.taskStats)) return false;
  return true;
}

/** 按 UTF-8 计算原始字符串大小；必须在 JSON.parse 前调用。 */
function getUtf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** 校验 now 并返回其本地当天零点，无效时间返回 null。 */
function resolveTodayStart(now: number): number | null {
  if (!isFiniteNumber(now)) return null;
  const todayStart = getLocalDayStart(now);
  return isFiniteNumber(todayStart) ? todayStart : null;
}

/**
 * 将原始缓存字符串解码为当天 DashboardSummary。
 * 任意大小、语法、版本、时间或递归形状异常都返回 null，绝不向外抛错。
 */
export function decodeDashboardCache(raw: string, now: number): DashboardSummary | null {
  try {
    const todayStart = resolveTodayStart(now);
    if (todayStart === null || typeof raw !== "string") return null;
    if (getUtf8ByteLength(raw) > DASHBOARD_CACHE_MAX_BYTES) return null;

    const envelope: unknown = JSON.parse(raw);
    if (!isRecord(envelope) || envelope.version !== DASHBOARD_CACHE_VERSION) return null;
    if (!isFiniteNumber(envelope.savedAt)) return null;
    if (envelope.savedAt > now || getLocalDayStart(envelope.savedAt) !== todayStart) return null;
    if (!isDashboardSummary(envelope.data, todayStart)) return null;
    return envelope.data;
  } catch {
    return null;
  }
}

/**
 * 将当天 DashboardSummary 编码为单版本信封。
 * 写入前同样校验日期和递归形状，避免把昨日数据或不安全结构持久化。
 */
export function encodeDashboardCache(summary: DashboardSummary, now: number): string | null {
  try {
    const todayStart = resolveTodayStart(now);
    if (todayStart === null || !isDashboardSummary(summary, todayStart)) return null;

    const envelope: DashboardCacheEnvelope = {
      version: DASHBOARD_CACHE_VERSION,
      savedAt: now,
      data: summary,
    };
    const raw = JSON.stringify(envelope);
    return getUtf8ByteLength(raw) <= DASHBOARD_CACHE_MAX_BYTES ? raw : null;
  } catch {
    return null;
  }
}

/** 在 try/catch 内解析默认依赖，确保 localStorage getter 抛错时也 fail-safe。 */
function resolveDependencies(options: DashboardCacheOptions): { storage: DashboardCacheStorage; now: number } {
  return {
    storage: options.storage ?? globalThis.localStorage,
    now: options.now ?? Date.now(),
  };
}

/**
 * 从单 key 读取缓存；坏缓存会尽力清理，storage 的 getter/get/remove 异常均被吞掉。
 */
export function readDashboardCache(options: DashboardCacheOptions = {}): DashboardSummary | null {
  try {
    const { storage, now } = resolveDependencies(options);
    const raw = storage.getItem(DASHBOARD_CACHE_KEY);
    if (raw === null) return null;

    const summary = decodeDashboardCache(raw, now);
    if (summary !== null) return summary;

    try {
      storage.removeItem(DASHBOARD_CACHE_KEY);
    } catch {
      // 清理失败不影响读取的 fail-safe 语义，下次读取会再次尝试。
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 校验并覆盖写入单 key；默认 storage getter 或 setItem 抛错时返回 false。
 */
export function writeDashboardCache(
  summary: DashboardSummary,
  options: DashboardCacheOptions = {},
): boolean {
  try {
    const { storage, now } = resolveDependencies(options);
    const raw = encodeDashboardCache(summary, now);
    if (raw === null) return false;
    storage.setItem(DASHBOARD_CACHE_KEY, raw);
    return true;
  } catch {
    return false;
  }
}

/** 比较实时摘要版本与最近成功持久化版本，避免 StrictMode 和路由重挂重复序列化。 */
export function shouldWriteDashboardCache(
  liveData: DashboardSummary,
  cachedGeneratedAt: number | undefined,
): boolean {
  return liveData.generatedAt !== cachedGeneratedAt;
}

/**
 * 合并实时摘要与持久缓存：实时结果优先，有数据时 loading 和 error 都不得遮挡主体。
 * error 在有数据时降级为非阻塞提示，无数据时才作为阻塞错误展示。
 */
export function resolveDashboardViewState(
  liveData: DashboardSummary | undefined,
  persistedData: DashboardSummary | null,
  loading: boolean,
  error: string | null,
  enabledBackendIds?: readonly string[],
): DashboardViewState {
  // Aggregate task totals cannot be safely subtracted from a paginated snapshot.
  // Reuse the whole summary only when it belongs to the current connection scope.
  const inScope = (summary: DashboardSummary | null | undefined) => {
    if (!summary || !enabledBackendIds) return summary;
    const active = summary.status.filter(backend => !backend.disabled).map(backend => backend.id);
    return active.length === enabledBackendIds.length && active.every(id => enabledBackendIds.includes(id))
      ? summary : undefined;
  };
  const data = inScope(liveData) ?? inScope(persistedData) ?? undefined;
  const hasData = data !== undefined;

  return {
    data,
    showLoading: loading && !hasData,
    blockingError: hasData ? null : error,
    nonBlockingError: hasData ? error : null,
  };
}
