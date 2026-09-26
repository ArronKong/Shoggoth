"use strict";

const fs = require("node:fs");

/** Birth time of a local agent/profile directory, in epoch ms. */
function dirCreatedAtMs(dir) {
  if (typeof dir !== "string" || !dir) return null;
  try {
    const stat = fs.statSync(dir);
    const ms = [stat.birthtimeMs, stat.ctimeMs, stat.mtimeMs]
      .find((value) => Number.isFinite(value) && value > 0);
    return ms == null ? null : Math.round(ms);
  } catch {
    return null;
  }
}

/** Oldest createdAt first; missing timestamps last; id is the stable tie-break. */
function sortAgentsByCreatedAt(agents) {
  return [...(Array.isArray(agents) ? agents : [])].sort((a, b) => {
    const aCreated = Number.isFinite(a?.createdAt) ? a.createdAt : null;
    const bCreated = Number.isFinite(b?.createdAt) ? b.createdAt : null;
    if (aCreated == null && bCreated == null) return String(a?.id || "").localeCompare(String(b?.id || ""));
    if (aCreated == null) return 1;
    if (bCreated == null) return -1;
    if (aCreated !== bCreated) return aCreated - bCreated;
    return String(a?.id || "").localeCompare(String(b?.id || ""));
  });
}

const { unsupportedAdvancedSessionResult } = require("./session-advanced-projection");
const { unsupportedSessionBoardResult } = require("./session-board-projection");

const STANDING_GRANT_REVOKE_OUTCOMES = new Set(["revoked", "already-revoked", "not-found"]);
const WIDGET_RESOURCE_MAX_BYTES = 2 * 1024 * 1024;
const SESSION_BOARD_HTML_MAX_BYTES = 256 * 1024;
const WIDGET_RESOURCE_FAILURE_REASONS = new Set([
  "unsupported",
  "unknown-backend",
  "invalid-path",
  "invalid-method",
  "not-found",
  "upstream-rejected",
  "content-type",
  "too-large",
  "timeout",
  "upstream-error",
]);
const SESSION_BOARD_HTML_FAILURE_REASONS = new Set([
  "unsupported",
  "unknown-backend",
  "invalid-request",
  "invalid-response",
  "widget-not-found",
  "widget-stale",
  "widget-not-renderable",
  "ticket-invalid",
  "not-found",
  "upstream-rejected",
  "redirect",
  "content-type",
  "too-large",
  "invalid-utf8",
  "timeout",
  "upstream-error",
]);

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeSessionBoardHtmlWidgetSpec(value) {
  if (!isPlainRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.includes("name")
    || !keys.includes("revision") || !keys.includes("instanceId")) return null;
  const name = typeof value.name === "string"
    && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.name)
    ? value.name
    : null;
  const revision = Number.isSafeInteger(value.revision) && value.revision >= 1
    ? value.revision
    : null;
  const instanceId = typeof value.instanceId === "string"
    && value.instanceId.length >= 1
    && value.instanceId.length <= 1024
    && value.instanceId === value.instanceId.trim()
    && !/[\p{Cc}\p{Cf}]/u.test(value.instanceId)
    ? value.instanceId
    : null;
  return name && revision !== null && instanceId
    ? { name, revision, instanceId }
    : null;
}

function hasStrictUtf8WithinLimit(value) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value).length
      <= SESSION_BOARD_HTML_MAX_BYTES;
  } catch {
    return false;
  }
}

/**
 * Close a trusted-main-process Board HTML fetch result. This result is never a
 * renderer DTO: it deliberately keeps HTML bytes while dropping all upstream
 * URLs, tickets, headers and errors before the local ticket host receives it.
 */
function projectSessionBoardHtmlWidgetResult(result, expectedSpec) {
  const expected = normalizeSessionBoardHtmlWidgetSpec(expectedSpec);
  if (!expected) return { supported: false, reason: "invalid-request" };
  if (result?.supported !== true) {
    const reason = SESSION_BOARD_HTML_FAILURE_REASONS.has(result?.reason)
      ? result.reason
      : "unsupported";
    return { supported: false, reason };
  }
  if (result?.ok !== true) {
    const reason = SESSION_BOARD_HTML_FAILURE_REASONS.has(result?.reason)
      ? result.reason
      : "upstream-error";
    return { supported: true, ok: false, reason };
  }

  const identity = normalizeSessionBoardHtmlWidgetSpec(result.widgetIdentity);
  const html = Buffer.isBuffer(result.html) ? result.html : null;
  const boardRevision = Number.isSafeInteger(result.boardRevision) && result.boardRevision >= 0
    ? result.boardRevision
    : null;
  const viewGeneration = typeof result.viewGeneration === "string"
    && /^[a-f0-9]{32}$/.test(result.viewGeneration)
    ? result.viewGeneration
    : null;
  if (!identity || identity.name !== expected.name || identity.revision !== expected.revision
    || identity.instanceId !== expected.instanceId || !html
    || html.length > SESSION_BOARD_HTML_MAX_BYTES || boardRevision === null
    || !viewGeneration || viewGeneration !== identity.instanceId
    || !hasStrictUtf8WithinLimit(html)) {
    return { supported: true, ok: false, reason: "invalid-response" };
  }
  return {
    supported: true,
    ok: true,
    html: Buffer.from(html),
    boardRevision,
    widgetIdentity: identity,
    viewGeneration,
  };
}

function normalizeWidgetResourceContentType(value) {
  if (typeof value !== "string") return null;
  const [rawMime, ...parameters] = value.split(";");
  const mime = rawMime.trim().toLowerCase();
  // M7a deliberately supports only OpenClaw's self-contained show_widget HTML
  // document. Sandboxed relative assets need a short-lived resource ticket and
  // remain out of scope rather than weakening the loopback Fetch-Metadata gate.
  if (mime !== "text/html") return null;
  for (const parameter of parameters) {
    if (!/^charset\b/i.test(parameter.trim())) continue;
    const match = /^charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))$/i.exec(parameter.trim());
    const charset = (match?.[1] || match?.[2] || match?.[3] || "").toLowerCase();
    if (charset !== "utf-8" && charset !== "utf8") return null;
  }
  return "text/html; charset=utf-8";
}

/**
 * Close the backend-owned widget response into a small browser-safe DTO.
 * Arbitrary upstream headers/status/error text never cross this boundary.
 */
function projectWidgetResourceResult(result, method = "GET") {
  if (result?.supported !== true) {
    const reason = WIDGET_RESOURCE_FAILURE_REASONS.has(result?.reason)
      ? result.reason : "unsupported";
    return { supported: false, reason };
  }
  if (result?.ok !== true) {
    const reason = WIDGET_RESOURCE_FAILURE_REASONS.has(result?.reason)
      ? result.reason : "upstream-error";
    return { supported: true, ok: false, reason };
  }

  const contentType = normalizeWidgetResourceContentType(result.contentType);
  if (!contentType) return { supported: true, ok: false, reason: "content-type" };
  const isHead = method === "HEAD";
  const body = Buffer.isBuffer(result.body) ? result.body : null;
  if (!isHead && !body) return { supported: true, ok: false, reason: "upstream-error" };
  const contentLength = isHead
    ? result.contentLength
    : body.length;
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    return { supported: true, ok: false, reason: "upstream-error" };
  }
  if (contentLength > WIDGET_RESOURCE_MAX_BYTES) {
    return { supported: true, ok: false, reason: "too-large" };
  }

  return {
    supported: true,
    ok: true,
    contentType,
    contentLength,
    ...(!isHead ? { body } : {}),
  };
}

/**
 * Public projection for the loopback management surface. Standing-grant
 * records contain the original command/cwd upstream; neither those fields nor
 * future unknown fields may cross into the browser.
 */
function projectStandingGrantForBrowser(grant, backendId) {
  const source = grant && typeof grant === "object" ? grant : {};
  const nullableString = (value) => typeof value === "string" ? value : null;
  const nullableInteger = (value) => Number.isSafeInteger(value) ? value : null;
  return {
    backendId: String(backendId || ""),
    grantId: typeof source.grantId === "string" ? source.grantId : "",
    mintedByApprovalId: typeof source.mintedByApprovalId === "string" ? source.mintedByApprovalId : "",
    agentId: typeof source.agentId === "string" ? source.agentId : "",
    cronJobId: typeof source.cronJobId === "string" ? source.cronJobId : "",
    cronJobName: nullableString(source.cronJobName),
    createdAtMs: Number.isSafeInteger(source.createdAtMs) ? source.createdAtMs : 0,
    expiresAtMs: nullableInteger(source.expiresAtMs),
    revokedAtMs: nullableInteger(source.revokedAtMs),
    revokedBy: nullableString(source.revokedBy),
    lastUsedAtMs: nullableInteger(source.lastUsedAtMs),
    useCount: Number.isSafeInteger(source.useCount) && source.useCount >= 0 ? source.useCount : 0,
  };
}

function projectStandingGrantListForBrowser(result, backendId) {
  if (result?.supported !== true) {
    return {
      supported: false,
      ...(typeof result?.reason === "string" ? { reason: result.reason } : {}),
      grants: [],
    };
  }
  return {
    supported: true,
    grants: (Array.isArray(result.grants) ? result.grants : [])
      .map((grant) => projectStandingGrantForBrowser(grant, backendId))
      .filter((grant) => grant.grantId),
  };
}

function projectStandingGrantRevokeResult(result) {
  return STANDING_GRANT_REVOKE_OUTCOMES.has(result?.outcome)
    ? { outcome: result.outcome }
    : {};
}

function projectStandingGrantRevokeForBrowser(result) {
  if (result?.supported !== true) {
    return {
      supported: false,
      ...(typeof result?.reason === "string" ? { reason: result.reason } : {}),
    };
  }
  const projected = projectStandingGrantRevokeResult(result);
  return projected.outcome
    ? { supported: true, ...projected }
    : { supported: false, reason: "invalid-response" };
}

/**
 * Abstract base class for all agent backends.
 *
 * Every backend represents one agent system (OpenClaw, Hermes, a future
 * provider, etc.) and must implement this interface. The BackendRegistry
 * uses these methods to route requests and aggregate data.
 *
 * Lifecycle: constructor → start() → [serve traffic] → stop()
 */
class AgentBackend {
  constructor() {
    this._inspirationOwner = null;
  }

  /** @returns {string} unique backend id, e.g. "openclaw", "hermes" */
  get id() { throw new Error("AgentBackend subclass must implement get id()"); }

  /** @returns {string} human-readable name for logging */
  get name() { return this.id; }

  /**
   * Static product descriptor. This is deliberately independent of runtime
   * reachability so every UI surface can be driven by capabilities instead of
   * backend-id conditionals.
   * @returns {{id: string, name: string,
   *   connectionMode: "gateway"|"managed-service"|"builtin-service"|"native-runtime",
   *   disconnectable: boolean,
   *   agentLifecycle: {create: boolean, update: boolean, remove: boolean,
   *     archive: boolean, restore: boolean, readStates: boolean},
   *   surfaces: {chat: boolean, agents: boolean, models: boolean, skills: boolean,
   *     usage: boolean, oauth: boolean, dashboardRuns: boolean, agentHarness: boolean,
   *     nativeCapacity?: boolean, runtimeBindings?: boolean, runtimeStatus?: boolean,
   *     cron: null|{kind: "openclaw"|"hermes"|"native"},
   *     kanban: null|{kind: "workboard"|"hermes"|"native"}}}}
   */
  getBackendDescriptor() {
    throw new Error("AgentBackend subclass must implement getBackendDescriptor()");
  }

  /** Service-wide native execution capacity; expose only with surfaces.nativeCapacity. */
  async getNativeCapacity() { throw new Error(`${this.id}: getNativeCapacity() not supported`); }

  /** Local CLI inventory, separate from backend/Agent ownership. Read-only;
   * ready means executable available and Service connected, not verified login.
   * Never starts a CLI, model turn, auth flow, or scans runtime Home contents.
   * @returns {Promise<Array<{runtime:string,name:string,runtimeAccountId:string,enabled:boolean,releaseEnabled:boolean,installation:"available"|"unavailable"|"unknown",serviceConnected:boolean}>>}
   */
  async getRuntimeStatuses() { return []; }

  /** Apply a validated revisioned core config projection to the native Service. */
  async applyNativeRuntimeConfig(projection) { throw new Error(`${this.id}: applyNativeRuntimeConfig() not supported`); }

  /**
   * Start the backend. Called once during app boot.
   *
   * `hooks.onPartialReady` lets a backend that boots in stages (Hermes spawns
   * one dashboard process per profile) publish each stage the moment it can
   * serve traffic, instead of making the UI wait for the slowest one. The
   * registry turns every call into a `backend.ready` event, so agents/sessions
   * appear progressively. Call it only after the newly-ready agents are
   * actually listable (getAgents/listSessions must already include them).
   * Optional on both sides: a backend may ignore it, a caller may omit it.
   *
   * `hooks.onSessionActivity` publishes a durable session activity only after
   * the backend's synchronous session snapshot can already resolve its key.
   *
   * @param {{onPartialReady?: () => void,
   *   onSessionActivity?: (activity: object) => void}} [hooks]
   * @returns {Promise<boolean>} true if ready, false if unavailable
   */
  async start(hooks) { return true; }

  /**
   * Stop the backend and release resources.
   *
   * `opts.keepProcesses` is passed ONLY on the app's normal-quit path: it tells a
   * backend that spawns long-lived child processes (Hermes spawns one dashboard
   * per profile) to leave them running so the next launch can claim and reuse
   * them instead of paying the cold start again. Connection state is still torn
   * down either way — what survives is the process, not the session.
   * Backends that spawn nothing (OpenClaw) ignore it. Every other stop path
   * (user disconnect, self-update, reconfigure) omits it and means a real kill.
   *
   * @param {{keepProcesses?: boolean}} [opts]
   * @returns {Promise<void>}
   */
  async stop(opts) {}

  /**
   * Does this backend own the given agent id RIGHT NOW?
   * Runtime归属：随后端就绪状态变化（Hermes 要等 dashboard 起来填好 profileById）。
   * 用于把已就绪后端的请求路由到正确后端。
   * @param {string} agentId
   * @returns {boolean}
   */
  ownsAgentId(agentId) { return false; }

  /**
   * Does this agent id fall in this backend's STATIC namespace, regardless of
   * whether the backend is up yet?
   *
   * 与 ownsAgentId 的区别是承重的：ownsAgentId 依赖运行时就绪（profileById 填充），
   * 在启动竞态窗口里对自家 agent 会误判为 false —— 那正是 orphan 泄漏的成因
   * （Hermes 未就绪时它的 session-write 透传给了 OpenClaw 网关，网关建了
   * agents/hermes-default/ 孤儿）。claimsAgentId 基于**命名约定**（Hermes 的 agent
   * 恒为 `hermes-<profile>`），从注册那一刻就成立、永不因就绪状态翻转。proxy 用它
   * 判断「这个 id 属于某个外籍后端的命名空间，session-write 绝不能漏给上游网关，
   * 上游若返回同名 agent/session 一定是孤儿、要滤掉」。默认回落到 ownsAgentId，
   * 没有静态命名空间的后端（如 OpenClaw，其 agent 名是网关任意命名）行为不变。
   * @param {string} agentId
   * @returns {boolean}
   */
  claimsAgentId(agentId) { return this.ownsAgentId(agentId); }

  /**
   * Read-only resource ownership probe used by BackendRegistry when an id does
   * not carry enough trustworthy routing information (legacy aliases and raw
   * Kanban ids). Implementations must return false for out-of-scope resources.
   * @param {string} kind
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async ownsResourceId(_kind, _id) { return false; }

  /**
   * Return the list of agents this backend provides.
   * Each agent: { id: string, name: string, model?: string, fallbacks?: string[] }
   * @returns {Array<{id: string, name: string}>}
   */
  getAgents() { return []; }

  /**
   * Return available model choices for the UI dropdown.
   * @returns {Array<{id: string, name: string, provider: string}>}
   */
  getModelChoices() { return []; }

  /**
   * Return this backend's full model catalog as UnifiedModel[]:
   * { id, name, provider, backendId, contextWindow?, reasoning?, acpProviderRef?,
   *   modelScopes? }.
   * acpProviderRef (Hermes-only): provider ref the chat `/model` command must
   * use when it differs from `provider` — user-defined (config.yaml) providers
   * need the `custom:<name>` form; Hermes only parses built-in provider names.
   * Powers the 模型 management page (per-backend tab). Default: none.
   * @returns {Promise<Array<object>>}
   */
  async getModels() { return []; }

  // ---- token usage (management UI) ----
  //
  // Split into a fast series (daily curve) and a slower breakdown (rankings) so
  // the token dashboard can render the curve immediately and stream rankings in.

  /**
   * Daily token/cost time series for the usage curve. Fast (no per-session scan).
   * 后端可在 daily/totals 上附带可选 token 分项字段：
   * inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens / reasoningTokens。
   * totals 还可附带可选成本分项：inputCost / outputCost / cacheReadCost /
   * cacheWriteCost / missingCostEntries（无价格记录数，>0 表示成本不完整）。
   * 顶层可选 cacheStatus（"fresh"|"refreshing"——refreshing 表示网关冷扫描中，
   * 数值是全零快照，UI 据此提示并自动重拉）。
   * availability 可为 complete|partial|unavailable；后两者必须在 UI 明示，
   * unavailable 不得作为零用量展示。聚合失败只排除失败来源。
   * availabilityReason="unsupported-range" 表示上游不提供此范围，应改选范围。
   * @param {string} [range] e.g. "today" | "7d" | "30d" | "90d" | "1y" | "all"
   *   （"today" = 当天用量：OpenClaw 按网关本地自然日精确聚合；Hermes 端点只支持
   *   最近 N 天，"today" 取最近 24 小时近似）
   * @returns {Promise<{daily: Array<{date: string, totalTokens: number, totalCost: number}>, totals: {totalTokens: number, totalCost: number}, cacheStatus?: string}>}
   */
  async getUsageSeries(range) {
    return { daily: [], totals: { totalTokens: 0, totalCost: 0 } };
  }

  /**
   * Token-usage rankings + dashboard aggregates (by model / source / channel /
   * tools / latency / per-model daily / activity / top sessions)。May be slow
   * (per-session scan)。除 byModel/byAgent/totals 外全部可选——没有该数据源的
   * 后端不返回，UI 数据驱动隐藏对应区块（铁律 1：不特判后端）。
   * 可选块形状（OpenClaw 实测见 spec 2026-06-11-usage-dashboard-design §1）：
   *   byChannel:      [{channel, totalTokens, totalCost, ...token 分项}]
   *   tools:          {totalCalls, uniqueTools, tools: [{name, count}]}
   *   latency:        {count, avgMs, minMs, maxMs, p95Ms}
   *   dailyLatency:   [{date, count, avgMs, p95Ms}]
   *   modelDaily:     [{date, model, provider?, tokens, cost}]
   *   dailyActivity:  [{date, messages, toolCalls, errors?, tokens, cost}]
   *                   （errors 缺省 = 该后端无错误信号，UI 隐藏错误线）
   *   messages:       {total, user, assistant, toolCalls, errors}
   *   topSessions:    [{key, label?, title?, sessionId?, agentId?, channel?, model?, models?, totalTokens, totalCost, updatedAt?}]
   *                   （tokens 降序 ≤20 条；model=最后使用的模型。models=[{model, tokens}]
   *                   该会话按模型拆分的 token 降序明细——仅逐消息记账的数据源提供，
   *                   拿不到该粒度的路径（如网关 sessions.usage RPC）缺省，UI 回退单 model。
   *                   title=人类可读的会话主题（Hermes=会话标题；OpenClaw=首条用户消息
   *                   截断），缺省 UI 回退 label/key；sessionId=物理 transcript id
   *                   （仅文件扫描源提供，供 getSessionPreview 精确定位）
   *   missingCostEntries: number
   * byModel 行可附带 token 分项 + count（消息数）。
   * availability 与 getUsageSeries 相同。
   * `bySource` 是通用来源列表：OpenClaw 来源是 agent，Hermes 来源是
   * profile dashboard。`byAgent` 保留给旧 UI 兼容。
   * @param {string} [range] 取值同 getUsageSeries（含 "today"）
   * @returns {Promise<{byModel: Array<object>, byAgent: Array<object>, bySource?: Array<object>, totals: object, cacheStatus?: string, sourceKind?: string, scanLimit?: number}>}
   */
  async getUsageBreakdown(range) {
    return { byModel: [], byAgent: [], totals: { totalTokens: 0, totalCost: 0 } };
  }

  /**
   * Return this backend's skills as UnifiedSkill[]:
   * { name, description, enabled, backendId, category?, emoji?, id?, source?, version? }.
   * Native packages are identified by (id, source, version), scoped to agentId.
   * Name-only operations are accepted only when that name resolves uniquely.
   * Powers the Skills management page. Default: none.
   * @returns {Promise<Array<object>>}
   */
  async getSkills(_opts = {}) { return []; }

  /**
   * Return this backend's kanban board for the tasks page:
   * { columns: [{ id, name, tasks: [UnifiedTask...] }], capabilities? }.
   * Each backend defines its own columns; optional `capabilities` lets the page
   * branch on board features (drag/archive/priorities/templates/sessionHandoff)
   * without special-casing a backend. Default: empty board.
   * Workboard-kind boards additionally return { statuses, sessions, agents,
   * refreshError?, error? } and attach the raw official card on each task as
   * `wb` (incl. a computed `lifecycle` view) — see openclaw-backend.js.
   * @param {{includeArchived?: boolean, board?: string, refreshDiagnostics?: boolean,
   *          readOnly?: boolean}} [opts]
   *   includeArchived: Hermes archived column; refreshDiagnostics: workboard
   *   diagnostics recompute before listing (official manual-refresh behavior);
   *   readOnly: pure read — the board must not write anything back (the workboard
   *   normally converges card lifecycle on every list, see openclaw-backend.js).
   *   Callers that only *display* a board (agent 页 Kanban tab) pass it.
   * @returns {Promise<{columns: Array<object>, capabilities?: object}>}
   */
  async getTaskBoard(_opts) { return { columns: [] }; }
  /** Hermes multi-board: list boards (slug/name/total/current). Default: none. */
  async getBoards() { return []; }
  async createBoard(_spec) { throw new Error(`${this.id}: createBoard() not supported`); }
  async switchBoard(_slug) { throw new Error(`${this.id}: switchBoard() not supported`); }
  async deleteBoard(_slug, _hard) { throw new Error(`${this.id}: deleteBoard() not supported`); }
  /** Hermes orchestration settings (auto-decompose / orchestrator profile / default assignee). */
  async getOrchestration() { return { autoDecompose: false, autoPromoteChildren: false }; }
  async setOrchestration(_patch) { throw new Error(`${this.id}: setOrchestration() not supported`); }
  /**
   * Detail-drawer extras (Hermes): dependency links, reassign/reclaim, worker log.
   * 尾参 opts（可选）：{ board?: string } —— Hermes 多板的目标板 slug，缺省 =
   * 服务端 current 板（下同，KAN-005/006）。
   */
  async addTaskLink(_parent, _child, _opts) { throw new Error(`${this.id}: addTaskLink() not supported`); }
  async removeTaskLink(_parent, _child, _opts) { throw new Error(`${this.id}: removeTaskLink() not supported`); }
  async reassignTask(_id, _assignee, _reclaim, _opts) { throw new Error(`${this.id}: reassignTask() not supported`); }
  async reclaimTask(_id, _opts) { throw new Error(`${this.id}: reclaimTask() not supported`); }
  /**
   * Worker 日志。@param {{board?: string, tail?: number}} [_opts]
   * @returns {Promise<{content: string, exists: boolean, sizeBytes?: number,
   *                    truncated?: boolean, path?: string}>}
   */
  async getTaskLog(_id, _opts) { return { content: "", exists: false }; }
  /**
   * Bulk update many tasks at once (status/assignee/priority/archive/model override).
   * 返回 `{ ok, total, failed, failedIds?, errors? }`——`failedIds` 让 UI 标红出错的卡。
   */
  async bulkUpdateTasks(_ids, _patch, _opts) { throw new Error(`${this.id}: bulkUpdateTasks() not supported`); }
  /** 批量永久删除（与单条 deleteTask 同语义，逐条扇出）。返回同 bulkUpdateTasks。 */
  async bulkDeleteTasks(_ids, _opts) { throw new Error(`${this.id}: bulkDeleteTasks() not supported`); }
  /**
   * 板级诊断列表（有活跃诊断的任务）。不支持的后端返回 null（UI 据 capability
   * 隐藏入口）。@param {{board?: string, severity?: string}} [_opts]
   */
  async getTaskDiagnostics(_opts) { return null; }

  /**
   * 看板前端偏好（Hermes `GET /config`）：默认租户 / 默认分泳道 / 默认显示归档 /
   * 是否渲染 markdown。不支持的后端返回 null（UI 用自身默认值）。
   * @returns {Promise<{defaultTenant?: string, laneByProfile?: boolean,
   *                    includeArchivedByDefault?: boolean, renderMarkdown?: boolean}|null>}
   */
  async getTaskBoardConfig() { return null; }
  /** 看板元数据修改：显示名 / 描述 / 图标 / 项目目录（新任务工作区默认值）。 */
  async updateBoard(_slug, _patch) { throw new Error(`${this.id}: updateBoard() not supported`); }
  /**
   * 编排可用的 profile 名单（比 board.assignees 多带描述与默认标记）。
   * @returns {Promise<Array<{name: string, description?: string,
   *                          descriptionAuto?: boolean, isDefault?: boolean}>>}
   */
  async getBoardProfiles() { return []; }
  /** 改 profile 描述（描述指导分解器的路由决策）。 */
  async updateBoardProfile(_name, _patch) { throw new Error(`${this.id}: updateBoardProfile() not supported`); }
  /** 由 profile 的技能/模型自动生成描述（LLM 调用，可能较慢）。 */
  async describeBoardProfileAuto(_name, _overwrite) { throw new Error(`${this.id}: describeBoardProfileAuto() not supported`); }
  /**
   * 任务级模型覆盖的候选目录（按 provider 分组）。
   * @returns {Promise<{providers: Array<{slug: string, label: string, models: string[]}>}>}
   */
  async getTaskModelOptions() { return { providers: [] }; }

  /**
   * 任务附件：列表 / 上传 / 读取（下载）/ 删除。上传收原始字节，由后端自行组装
   * 上游要求的传输格式（Hermes = multipart）。
   * @param {{filename: string, contentType?: string, data: Buffer}} _file
   */
  async listTaskAttachments(_id, _opts) { return []; }
  async addTaskAttachment(_id, _file, _opts) { throw new Error(`${this.id}: addTaskAttachment() not supported`); }
  /** @returns {Promise<{filename: string, contentType?: string, data: Buffer}>} */
  async readTaskAttachment(_attachmentId, _opts) { throw new Error(`${this.id}: readTaskAttachment() not supported`); }
  async deleteTaskAttachment(_attachmentId, _opts) { throw new Error(`${this.id}: deleteTaskAttachment() not supported`); }

  /**
   * 每任务的「通知到 home 频道」开关：列出已配置 home 的平台 + 本任务是否已订阅。
   * @returns {Promise<Array<{platform: string, name?: string, chatId?: string,
   *                          threadId?: string, subscribed: boolean}>>}
   */
  async getTaskHomeChannels(_id, _opts) { return []; }
  async setTaskHomeSubscription(_id, _platform, _subscribed, _opts) {
    throw new Error(`${this.id}: setTaskHomeSubscription() not supported`);
  }

  /**
   * Rich agent list for the 代理 management page (distinct from the sync
   * getAgents() used by the proxy): UnifiedAgent[] =
   * { id, name, model?, provider?, fallbacks?, workspace?, isDefault?, createdAt?, backendId }.
   * @returns {Promise<Array<object>>}
   */
  async listAgents() { return []; }

  /**
   * Connection / overview status for the 设置 page:
   * { id, name, connected, info }. `info` is a small free-form fact bag
   * (never secrets). When connected=false, backends should surface the
   * failure cause as `info.error` (optionally a machine code `info.reason`) —
   * SetupOverlay/设置页 rely on it for actionable guidance copy.
   *
   * `info.starting === true` is the third state between the two booleans: the
   * backend is mid-boot, so connected=false is "not yet", not "failed" (and
   * carries no `info.error`). Consumers must not render it as an outage —
   * ChatPage keeps such a backend's cached agents visible (dimmed) instead of
   * dropping them, which is what makes a slow boot look like loading rather
   * than disappearance.
   * Default: not connected.
   * @returns {Promise<{id: string, name: string, connected: boolean, info: object}>}
   */
  async getStatus() {
    return { id: this.id, name: this.name, connected: false, info: {} };
  }

  /**
   * 设置页版本检查使用的版本信息。backend 可返回权威 latest /
   * updateAvailable；缺少时 registry 才用通用官方包源补齐。
   * @returns {Promise<{id: string, name: string, current?: string, latest?: string,
   *   updateAvailable?: boolean, currentSource?: string, latestSource?: string,
   *   releaseNotesUrl?: string, error?: string, dashboards?: object[]}>}
   */
  async getVersionInfo() {
    return { id: this.id, name: this.name };
  }

  /**
   * 触发该后端的官方自更新命令（后台异步执行，重复调用幂等返回进行中状态）。
   * 更新是分钟级长操作 → 只启动不等待，进度由 getSelfUpdateStatus() 轮询。
   * 默认不支持；reason 用短机器码（如 "remote"），由前端映射文案。
   * @param {{action?: "update"|"repair", acceptCapabilities?: boolean}} [options]
   * @returns {{supported: boolean, reason?: string, actions?: string[], status?: object}}
   */
  runSelfUpdate(options = {}) {
    return { supported: false, reason: "unsupported" };
  }

  /**
   * 当前/最近一次自更新的状态快照（设置页轮询）。
   * status 是后端自有控制器的安全投影；可包含 phase/operation/progressTail，
   * 但不得包含原始 stdout/stderr 或凭据。终态必须落盘，app 重启后仍能报告
   * 上次结果；具体状态机由后端实现，不在通用契约里假定同一种 updater。
   * @returns {{supported: boolean, reason?: string, status?: object}}
   */
  getSelfUpdateStatus() {
    return { supported: false, reason: "unsupported" };
  }

  /** List durable command-approval grants owned by this backend. */
  async listStandingGrants(options = {}) {
    return { supported: false, reason: "unsupported", grants: [] };
  }

  /** Revoke one durable command-approval grant. */
  async revokeStandingGrant(grantId) {
    throw new Error(`${this.id}: revokeStandingGrant() not supported`);
  }

  /** Read the backend's execution-environment inventory. */
  async listEnvironments() {
    return {
      ...unsupportedAdvancedSessionResult(),
      environments: [],
      profiles: [],
    };
  }

  /** Read one exact session's advanced metadata projection. */
  async describeSession(agentId, sessionKey) {
    return { ...unsupportedAdvancedSessionResult(), session: null };
  }

  /** List the persisted transcript branch tips for one exact session. */
  async listSessionBranches(agentId, sessionKey) {
    return { ...unsupportedAdvancedSessionResult(), branches: [] };
  }

  /** Fork one session immediately before a persisted user-message entry. */
  async forkSessionAtEntry(agentId, sessionKey, entryId) {
    return unsupportedAdvancedSessionResult();
  }

  /** Read one exact session's persistent Board snapshot. */
  async getSessionBoard(agentId, sessionKey) {
    return unsupportedSessionBoardResult();
  }

  /**
   * Fetch one exact persistent HTML Board widget for the trusted Electron main
   * process. This capability must not be exposed through the loopback REST
   * plane; the local ticket host is the only consumer of returned HTML bytes.
   */
  async fetchSessionBoardHtmlWidget(agentId, sessionKey, spec) {
    return { supported: false, reason: "unsupported" };
  }

  /** Apply a closed OpenClaw 2026.8.1 Board layout operation list. */
  async updateSessionBoard(agentId, sessionKey, ops) {
    return unsupportedSessionBoardResult();
  }

  /** Pin one already-materialized Canvas document into a session Board. */
  async pinSessionBoardCanvas(agentId, sessionKey, spec) {
    return unsupportedSessionBoardResult();
  }

  /** Grant or reject one exact pending session Board widget revision. */
  async decideSessionBoardWidgetGrant(agentId, sessionKey, spec) {
    return unsupportedSessionBoardResult();
  }

  /**
   * Return session rows for the sessions.list response.
   * @returns {Array<object>} GatewaySessionRow[]
   */
  getSessionRows() { return []; }

  /**
   * Return the current session-row snapshot together with its authority state.
   * `complete:false` means the backend is starting or temporarily unavailable,
   * so a federating caller must preserve cached rows that are absent from this
   * partial snapshot. Backends with synchronous/always-authoritative rows keep
   * the default implementation.
   * @returns {{rows: Array<object>, complete: boolean}}
   */
  getSessionRowsSnapshot() {
    return { rows: this.getSessionRows(), complete: true };
  }

  /**
   * Fetch message history for a session.
   * `id` (when present) is a per-message stable identifier the chat UI keys its
   * client-side pin / local-hide on; omit it only when no stable id exists.
   * `notice` marks a **timeline row** rather than a real turn (currently only
   * "modelSwitch"): the UI renders it as a quiet one-line divider — model/provider
   * carry the new identity, `content` keeps the backend's raw text for hover
   * triage. Without it a `role:"system"` row renders as a red ERROR bubble.
   * @param {string} sessionKey  e.g. "agent:hermes-default:abc-123"
   * @returns {Promise<{messages: Array<{role: string, id?: string, notice?: string, model?: string, provider?: string, content: Array<{type: string, text: string}>}>}>}
   */
  async getHistory(sessionKey) { return { messages: [] }; }

  /**
   * Create a new session for the given agent.
   * @param {string} agentId
   * @param {{model?: string, provider?: string, acpProviderRef?: string, workspace?: string|null}} [options]
   *        optional session-scoped creation hints. model is always the raw model
   *        id; provider identity travels separately so ids containing `/` stay
   *        unambiguous. acpProviderRef is a transport-specific provider alias.
   * @returns {string|Promise<string>} canonical new sessionKey. The proxy
   *   normalizes both forms so durable Service backends may finish persistence
   *   before publishing a key.
   */
  createSession(agentId, options) { throw new Error("AgentBackend subclass must implement createSession()"); }

  /**
   * Send a message and stream the response.
   *
   * Hooks (all optional; a backend emits what its transport can source):
   *   delta(text)                 — FULL accumulated answer text so far
   *   interim(text)               — the stream so far is SEALED as its own
   *                                 segment (commentary between tool calls);
   *                                 the eventual final carries only the LAST
   *                                 segment. UI settles the pending bubble and
   *                                 opens a new one.
   *   final(text, errored?, meta?)— turn done. `errored === true` is an error
   *                                 terminal (legacy compatibility), never a
   *                                 successful final. meta?: { usage?: {input, output,
   *                                 contextUsed, contextMax, contextPercent},
   *                                 model? } rides onto the emitted message so
   *                                 the footer/context meter light up.
   *   error(msg)                  — turn failed (no final follows). A resolved
   *                                 send emits exactly one terminal callback;
   *                                 rejection is the alternate failure terminal.
   *   thinking(text)              — FULL accumulated reasoning text so far
   *   tool({toolCallId, name?, args?, phase, result?, partialResult?, isError?, durationS?,
   *         diff?, diffText?})    — tool lifecycle (phase start|update|result)
   *   plan(entries)               — agent todo list ([{content, status?}])
   *   status({kind, text, reason?, queuedAt?}) — session progress: queued,
   *                                 starting, running, retrying, waiting_approval/input,
   *                                 compacting or compacted. Queue timestamps
   *                                 use milliseconds since the Unix epoch.
   *   prompt(InteractiveRequestV1 | legacyPrompt)
   *                               — the agent BLOCKED on a user answer. Shoggoth
   *                                 emits the versioned canonical request; legacy
   *                                 backends may retain their historical shape.
   *                                 Answer via respondChatPrompt().
   *   promptExpire({requestId})   — a pending prompt timed out server-side
   *
   * @param {string} sessionKey
   * @param {string} message
   * @param {string|undefined} idempotencyKey opaque retry identity. For the same
   *        session, repeated non-empty keys must share one underlying execution;
   *        requests without a key keep ordinary at-least-once behavior.
   * @param {{ delta?: Function, final?: Function, error?: Function, interim?: Function,
   *           thinking?: Function, tool?: Function, plan?: Function, status?: Function,
   *           prompt?: Function, promptExpire?: Function }} hooks
   * @param {{ attachments?: Array<{type: string, mimeType?: string, fileName?: string,
   *          content?: string, source?: {type: string, media_type?: string, data?: string}}>,
   *          inputProvenance?: {kind: "inter_session", sourceTool: string} }} [opts]
   *        attachments use the chat.send wire shape (top-level content in
   *        OpenClaw 2026.8.1; legacy source is accepted by compatible backends); a backend
   *        that can't deliver them must surface an error instead of dropping. Federated sends
   *        may also include `inputProvenance: {kind: "inter_session", sourceTool: string}`.
   * @returns {Promise<void>}
   */
  async sendMessage(sessionKey, message, idempotencyKey, hooks, opts) {
    throw new Error("AgentBackend subclass must implement sendMessage()");
  }

  /**
   * Chat-surface capabilities for one agent — what the composer may offer.
   * `attachments.image` (base64 on chat.send) is the universal baseline;
   * declare pdf/file only when the transport can actually deliver them
   * (e.g. Hermes gateway upload RPCs). Limits are advisory for UI preflight.
   * `slash: true` additionally routes unhandled / commands to execSlash()
   * instead of the chat stream.
   * @param {string} agentId
   * `modelProvider` scopes a shared backend catalog to the provider/runtime owned
   * by this Agent. `modelScope` adds the profile boundary needed when multiple
   * Agents use isolated homes for the same runtime/provider.
   * `maxPayloadBytes` is the negotiated whole request-frame limit, when the
   * transport exposes one; it includes JSON/base64 envelope overhead.
   * `gatewayPolicy` lets the renderer use its live sanitized hello policy while
   * this management-plane snapshot is temporarily not ready.
   * @returns {{attachments: {image?: {maxBytes?: number}, pdf?: {maxBytes?: number, maxPages?: number}, file?: {maxBytes?: number}}, maxPayloadBytes?: number, gatewayPolicy?: boolean, slash?: boolean, steer?: boolean, modelProvider?: string, modelScope?: string, permissions?: {scope: "session"|"profile", apply: "next-turn"|"live", defaultMode?: string, options: Array<{id: string, label: string, description?: string, risk?: "safe"|"standard"|"elevated"|"danger", requiresConfirmation?: boolean}>}, notReady?: boolean}}
   */
  getChatCapabilities(agentId) {
    return { attachments: { image: {} } };
  }

  /**
   * Read one backend-owned, sandboxed inline-widget document. The browser never
   * receives upstream credentials or URLs; static-server supplies only a
   * canonical backend-relative resource path and emits the closed response.
   * Backends that do not host widgets explicitly remain unsupported.
   *
   * @param {string} resourcePath
   * @param {{method?: "GET"|"HEAD"}} [options]
   * @returns {Promise<{supported: boolean, ok?: boolean, reason?: string,
   *   contentType?: string, contentLength?: number, body?: Buffer}>}
   */
  async fetchWidgetResource(resourcePath, options = {}) {
    return { supported: false, reason: "unsupported" };
  }

  /**
   * Opaque identity for renderer-side chat-history cache isolation. Backends
   * opt in only when they can bind a digest to the exact underlying history
   * source without doing network I/O. Raw paths, URLs and credentials must
   * never leave the backend through this capability.
   * @returns {string|null} lowercase SHA-256 hex, or null when unsupported
   */
  getChatCacheScope() { return null; }

  /**
   * Slash-command catalog for one agent (composer palette). Backends without a
   * server-side command surface return {supported:false} — the UI falls back
   * to its builtin table.
   * @param {string} agentId
   * @param {string} [sessionKey]
   * @returns {Promise<{supported: boolean, reason?: string, commands: Array<{name: string, description: string, args?: string|null, category?: string, aliases?: string[]}>}>}
   */
  async listSlashCommands(agentId, sessionKey) { return { supported: false, commands: [] }; }

  /**
   * Argument-stage completion for a partially-typed slash command.
   * @param {string} agentId
   * @param {string} text  the full composer text (e.g. "/skin da")
   * @returns {Promise<{supported: boolean, items: Array<{value: string, label?: string, group?: string}>, replaceFrom?: number}>}
   */
  async completeSlash(agentId, text) { return { supported: false, items: [] }; }

  /**
   * Execute a slash command server-side. Typed result tells the UI what to do:
   * kind "output" → render text; "send" → dispatch text as a normal chat
   * message; "prefill" → fill the composer.
   * @param {string} agentId
   * @param {string} sessionKey
   * @param {string} text  full command incl. leading slash
   * @returns {Promise<{kind: "output"|"send"|"prefill", text?: string, warning?: string}>}
   */
  async execSlash(agentId, sessionKey, text) { throw new Error(`${this.id}: execSlash() not supported`); }

  /**
   * Answer a blocking agent prompt previously surfaced via the sendMessage
   * `prompt` hook (the UI's approval/clarify card → proxy `chat.respond`).
   * Shoggoth accepts an exact requestId plus either a canonical {choice} or
   * {action:"submit"|"cancel", answers}; legacy backends retain their existing
   * response shapes. Backends without blocking prompts keep the default throw.
   * @param {string} sessionKey
   * @param {{kind: string, requestId?: string, choice?: string, all?: boolean, value?: string}} data
   * @returns {Promise<object>}
   */
  async respondChatPrompt(sessionKey, data) { throw new Error(`${this.id}: respondChatPrompt() not supported`); }

  /**
   * Switch the model a chat session uses.
   *
   * This is CRUD, not chat: it goes over `/__api` and must NOT be delivered as
   * a message on the chat stream. Routing a `/model` command through
   * sendMessage() looks equivalent but isn't — the message can only reach the
   * agent once a session exists, so an agent whose model config is broken (the
   * one case where switching is the fix) can never be repaired from the UI.
   * Implementations must therefore not depend on the agent being initializable.
   *
   * @param {string} sessionKey
   * @param {{model: string, provider?: string, acpProviderRef?: string,
   *          scope?: "session"|"persist"}} opts
   *        scope "session" (default) affects only this session; "persist" writes
   *        the backend's stored default. Backends that can't honor the requested
   *        scope must report what they actually did in the result.
   * @returns {Promise<{model: string, scope: "session"|"persist", warning?: string}>}
   */
  async setSessionModel(sessionKey, opts) { throw new Error(`${this.id}: setSessionModel() not supported`); }

  /** Persist the permission mode used by subsequent turns in this session. */
  async setSessionPermission(sessionKey, opts) { throw new Error(`${this.id}: setSessionPermission() not supported`); }

  /**
   * Set a chat session's thinking/reasoning level. The proxy routes the UI's
   * `sessions.patch {thinkingLevel}` here for foreign sessions. Levels come
   * from the session row's `thinkingOptions`; null resets to the default.
   * Like setSessionModel, must not depend on the agent being initializable,
   * and must report the actually-applied scope.
   * @param {string} sessionKey
   * @param {{level?: string|null}} opts
   * @returns {Promise<{level: string, scope: "session"|"persist"}>}
   */
  async setSessionThinking(sessionKey, opts) { throw new Error(`${this.id}: setSessionThinking() not supported`); }

  /**
   * Toggle a chat session's fast mode (provider speed/service tier). The proxy
   * routes the UI's `sessions.patch {fastMode}` here for foreign sessions.
   * @param {string} sessionKey
   * @param {{fast: boolean}} opts
   * @returns {Promise<{fast: boolean, scope: "session"|"persist"}>}
   */
  async setSessionFast(sessionKey, opts) { throw new Error(`${this.id}: setSessionFast() not supported`); }

  /**
   * Rename a chat session (its display label). The proxy routes the UI's
   * `sessions.patch {label}` here for foreign (non-gateway) sessions.
   * @param {string} sessionKey
   * @param {string|null} label  empty/null clears the name
   * @returns {Promise<void>}
   */
  async renameSession(sessionKey, label) { throw new Error(`${this.id}: renameSession() not supported`); }

  /**
   * Delete a chat session. The proxy routes the UI's `sessions.delete` here
   * for foreign sessions.
   * @param {string} sessionKey
   * @returns {Promise<void>}
   */
  async deleteSession(sessionKey) { throw new Error(`${this.id}: deleteSession() not supported`); }

  /**
   * Abort the in-flight generation of a session (the UI's Stop button →
   * `chat.abort`). Best-effort: resolving without an active run is fine.
   * @param {string} sessionKey
   * @returns {Promise<void>}
   */
  async abortChat(sessionKey) { throw new Error(`${this.id}: abortChat() not supported`); }

  /**
   * Compress/compact a chat session's context (the UI's /compact →
   * `sessions.compact`, routed here for foreign sessions). Long operation
   * (LLM summarization, ~2min budget). Returns display hints; the UI reloads
   * history afterwards to show the compacted transcript.
   * @param {string} sessionKey
   * @returns {Promise<{headline?: string, tokenLine?: string}>}
   */
  async compactSession(sessionKey) { throw new Error(`${this.id}: compactSession() not supported`); }

  /**
   * Full-text search across this backend's chat sessions for one agent.
   * Powers the chat page's "全部会话" search scope. Backends without a search
   * source return `{ supported: false }` so the UI can say so instead of
   * silently showing nothing.
   * @param {string} agentId
   * @param {string} query
   * @param {{ limit?: number }} [opts]
   * @returns {Promise<{ supported: boolean, reason?: string, truncated?: boolean, results: Array<{ key: string, sessionId?: string, messageId?: string, snippet: string, ts?: number|null, role?: string }> }>}
   */
  async searchChat(agentId, query, opts) { return { supported: false, results: [] }; }

  // ---- Cron (management UI) ----
  //
  // Methods below take/return the unified shape consumed by /__api/cron/*.
  // Mutating methods receive the FULL unified id ("<routingPrefix>:<localId>");
  // each backend parses out whatever local id it needs. Default impls make
  // cron optional: a backend that doesn't support it returns [] / throws.

  /**
   * Return this backend's cron jobs, normalized to UnifiedCronJob.
   * Optional actions {edit,toggle,delete,run,reason?} describe per-job controls;
   * explicit false denies that action, omitted fields preserve legacy support.
   * reason="system-managed" identifies jobs whose lifecycle belongs to the backend.
   * @returns {Promise<Array<object>>}
   */
  // Inspiration storage has one product owner, injected into BackendRegistry.
  // Execution is routed to the selected Agent's backend; unsupported adapters
  // must never fall back to an ordinary chat send with weaker recovery semantics.
  setInspirationOwner(owner) {
    this._inspirationOwner = owner || null;
  }

  getInspirationCapabilities() {
    if (["openclaw", "hermes"].includes(this.id)
      && typeof this._inspirationOwner?.startExternalInspiration === "function") {
      // The shared Inspiration service outlives the Shoggoth agent connection.
      // startExternalInspiration checks Service readiness before creating a run.
      return { execute: true, session: true, respond: true, cancel: true, reason: null };
    }
    return { execute: false, session: false, respond: false, cancel: false, reason: "unsupported" };
  }
  async listInspirations(_query) { throw new Error(`${this.id}: Inspiration storage not supported`); }
  async getInspirationAgentStats(_agents) { throw new Error(`${this.id}: Inspiration statistics not supported`); }
  /** Dashboard execution history, queried once on the shared product owner. */
  async getRecentInspirationActivities(_opts = {}) { return { supported: false, reason: "unsupported", items: [] }; }
  async getInspirationGrowth() { throw new Error(`${this.id}: Inspiration growth not supported`); }
  async updateInspirationGrowth(_input) { throw new Error(`${this.id}: Inspiration growth not supported`); }
  async getInspiration(_id) { throw new Error(`${this.id}: Inspiration storage not supported`); }
  async createInspiration(_input) { throw new Error(`${this.id}: Inspiration storage not supported`); }
  async updateInspiration(_id, _input) { throw new Error(`${this.id}: Inspiration storage not supported`); }
  async deleteInspiration(_id, _input) { throw new Error(`${this.id}: Inspiration deletion not supported`); }
  async startInspiration(id, input) {
    if (!["openclaw", "hermes"].includes(this.id) || input.backendId !== this.id
      || typeof this._inspirationOwner?.startExternalInspiration !== "function"
      || !this.getInspirationCapabilities().execute) {
      const error = new Error(`${this.id}: Inspiration execution not supported`);
      error.code = "INSPIRATION_UNSUPPORTED";
      throw error;
    }
    return this._inspirationOwner.startExternalInspiration(id, input);
  }
  async respondInspiration(_id, _input) { throw new Error(`${this.id}: Inspiration response not supported`); }
  async cancelInspiration(_id, _input) { throw new Error(`${this.id}: Inspiration cancellation not supported`); }
  async getInspirationExecutions(_id, _query) { throw new Error(`${this.id}: Inspiration history not supported`); }

  async getCronJobs() { return []; }

  /**
   * Create a cron job from a unified spec (includes agentId to target a scope).
   * @param {object} spec
   * @returns {Promise<object>} created job, normalized
   */
  async createCronJob(spec) { throw new Error(`${this.id}: createCronJob() not supported`); }

  /**
   * Update a cron job by full unified id.
   * @param {string} id
   * @param {object} patch
   * @returns {Promise<object>} updated job, normalized
   */
  async updateCronJob(id, patch) { throw new Error(`${this.id}: updateCronJob() not supported`); }

  /**
   * Delete a cron job by full unified id.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async deleteCronJob(id) { throw new Error(`${this.id}: deleteCronJob() not supported`); }

  /**
   * Trigger a cron job to run now.
   * @param {string} id
   * @param {string} [mode]
   * @returns {Promise<object>}
   */
  async runCronJob(id, mode) { throw new Error(`${this.id}: runCronJob() not supported`); }

  /**
   * Recent run history for a cron job (newest first).
   * @param {string} id full unified id
   * @param {object} [options] backend-specific query filters
   * @returns {Promise<{runs: Array<{startedAt?: number|null, finishedAt?: number|null, status?: string, error?: string, sessionKey?: string}>}>}
   */
  async getCronRuns(id, options) { return { runs: [] }; }

  /**
   * Delivered content for a cron job run. Without `atMs`, the most recent
   * execution's full output (or capped summary). With `atMs` (a clicked
   * calendar occurrence's epoch ms), the run that actually fired for THAT
   * occurrence — the run on the same local day, closest to the occurrence time —
   * so a recurring job's older slots show their own report, not the latest.
   * Returns source "none" when no matching run exists. A backend without per-run
   * transcripts returns summary-only / nulls.
   * @param {string} id full unified id
   * @param {number} [atMs] occurrence epoch ms to resolve a specific past run
   * @returns {Promise<{status?: string, startedAt?: number|null, finishedAt?: number|null, model?: string, provider?: string, durationMs?: number, summary?: string, fullText?: string|null, source?: "transcript"|"summary"|"none", sessionKey?: string, error?: string, deliveryStatus?: string}>}
   */
  async getCronLatestDelivery(id, atMs) { return { source: "none" }; }

  /**
   * R342: Agent Trajectory for one cron run — the ordered process parts
   * (thinking / toolCall / toolResult / text) parsed from the run's per-run
   * transcript, each with epoch-ms `ts` and (where the transcript has them)
   * `toolCallId` for exact pairing. Backends that can read a run/session
   * transcript support this; unavailable or missing transcripts return
   * supported:false and the UI hides the section.
   * @param {string} id full unified cron id
   * @param {{sessionKey?: string}} [options] the run's sessionKey (from getCronRuns/getCronLatestDelivery)
   * @returns {Promise<{supported: boolean, reason?: string, parts: Array<{type: "thinking"|"toolCall"|"toolResult"|"text", text?: string, toolName?: string, toolArgs?: object, toolCallId?: string, isError?: boolean, ts?: number}>}>}
   */
  async getCronRunTrajectory(id, options) { return { supported: false, reason: "unsupported", parts: [] }; }

  /**
   * Recent cron runs ACROSS ALL JOBS (newest first) — the dashboard's today
   * feed. Entry shape (jobId is the FULL unified id so the UI can deep-link
   * /cron?job=): { backendId, jobId, jobName?, agentId?, startedAt?,
   * finishedAt?, status?, error?, summary?, durationMs?, deliveryStatus?,
   * model?, sessionKey?, synthesized? }.
   * Default implementation synthesizes ≤1 entry per job from getCronJobs()'
   * lastRunAt/lastStatus/lastError, marked `synthesized: true` (no per-run
   * summary/transcript behind it) — right for backends without a run log
   * (Hermes exposes only per-job last-run state, so it inherits this).
   * Backends with a real run log (OpenClaw `cron.runs`) override it.
   * @param {{sinceMs?: number, limit?: number}} [opts]
   * @returns {Promise<{runs: Array<object>}>}
   */
  async getRecentCronRuns({ sinceMs = 0, limit = 50 } = {}) {
    let jobs;
    try {
      jobs = await this.getCronJobs();
    } catch {
      return { runs: [] };
    }
    const runs = (Array.isArray(jobs) ? jobs : [])
      .filter((job) => typeof job?.lastRunAt === "number" && job.lastRunAt >= sinceMs)
      .map((job) => ({
        backendId: job.backendId || this.id,
        jobId: job.id,
        jobName: job.name || undefined,
        agentId: job.agentId || undefined,
        startedAt: job.lastRunAt,
        status: job.lastStatus || undefined,
        error: job.lastError || undefined,
        synthesized: true,
      }))
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
      .slice(0, Math.max(1, limit));
    return { runs };
  }

  // ---- tasks / kanban (management UI) ----
  //
  // Detail/mutation counterparts to getTaskBoard(). Ids are the same ones the
  // board returns (backend-local, e.g. a workboard card UUID for OpenClaw or a
  // numeric kanban id for Hermes); the registry routes by ?backend=.
  // 各方法的可选尾参 opts = { board?: string }：Hermes 多板的目标板 slug，
  // 缺省 = 服务端 current 板（KAN-005/006）。OpenClaw 忽略。

  /**
   * Full detail for one task (body + metadata + optional comments).
   * @param {string} id
   * @param {{board?: string}} [opts]
   * @returns {Promise<object>} { id, title, body, column, assignee?, priority?, comments?, ... }
   */
  async getTask(id, opts) { throw new Error(`${this.id}: getTask() not supported`); }

  /**
   * Create a task. spec: { title, body?, column?, assignee?, priority? }.
   * @param {object} spec
   * @param {{board?: string}} [opts]
   * @returns {Promise<object>} created task
   */
  async createTask(spec, opts) { throw new Error(`${this.id}: createTask() not supported`); }

  /**
   * Update a task. patch may include { title, body, column/status, assignee, priority }.
   * @param {string} id
   * @param {object} patch
   * @returns {Promise<object>} updated task
   */
  async updateTask(id, patch, opts) { throw new Error(`${this.id}: updateTask() not supported`); }

  /**
   * Delete (or archive) a task.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async deleteTask(id, opts) { throw new Error(`${this.id}: deleteTask() not supported`); }

  /**
   * Move a task to a column + set its intra-column order.
   * @param {string} id
   * @param {string} status target column id
   * @param {number} position intra-column rank
   * @returns {Promise<object>} updated task
   */
  async moveTask(id, status, position, opts) { throw new Error(`${this.id}: moveTask() not supported`); }

  /**
   * Archive (soft-delete) or un-archive a task.
   * @param {string} id
   * @param {boolean} [archived=true]
   * @returns {Promise<object>}
   */
  async archiveTask(id, archived = true, opts) { throw new Error(`${this.id}: archiveTask() not supported`); }

  /**
   * Append a comment to a task's thread.
   * @param {string} id
   * @param {string} body
   * @param {string} [author]
   * @returns {Promise<object>}
   */
  async addTaskComment(id, body, author, opts) { throw new Error(`${this.id}: addTaskComment() not supported`); }

  /**
   * Run a task-level action (Hermes: "specify"/"decompose"; OpenClaw: "unblock",
   * "stop" — cancel the linked gateway task + abort the chat run + park blocked).
   * @param {string} id
   * @param {string} action
   * @returns {Promise<object>} backend outcome ({ ok, reason?, ... })
   */
  async taskAction(id, action, opts) { throw new Error(`${this.id}: taskAction() not supported`); }
  /**
   * Board-level (no task id) dispatch. Hermes ("Nudge dispatcher"): claim + spawn up
   * to `opts.max` ready tasks → {claimed, spawned, spawnErrors, oldestReadyAgeSeconds?}.
   * OpenClaw (official ⚡ Dispatch → workboard.cards.dispatch): →
   * {started, failures, promoted, blocked, reclaimed, orchestrated}.
   * @param {{max?: number, dryRun?: boolean}} [opts]
   * @returns {Promise<object>}
   */
  async nudgeDispatcher(_opts) { throw new Error(`${this.id}: nudgeDispatcher() not supported`); }

  /**
   * Start an agent run on a board card (workboard). opts: { engine?: "codex"|"claude", mode: "autonomous"|"manual" }.
   * @returns {Promise<{sessionKey?: string, runId?: string, runStarted?: boolean, status?: string, runError?: any}>}
   */
  async runTaskCard(id, opts) { throw new Error(`${this.id}: runTaskCard() not supported`); }

  // ---- skills (management UI) ----

  /**
   * Enable/disable a skill by name.
   * @param {string} name
   * @param {boolean} enabled
   * @returns {Promise<object>} updated skill (best-effort)
   */
  async setSkillEnabled(name, enabled, _opts = {}) { throw new Error(`${this.id}: setSkillEnabled() not supported`); }

  /**
   * Update a skill's config. patch: { enabled?, apiKey?, env?, id?, source?, version?, expectedRevision? }.
   * @param {string} name
   * @param {object} patch
   * @returns {Promise<object>}
   */
  async updateSkill(name, patch, _opts = {}) { throw new Error(`${this.id}: updateSkill() not supported`); }

  /** Install a Shoggoth-owned local Skill package selected by the trusted App host. */
  async installSkill(_sourcePath, _opts = {}) { throw new Error(`${this.id}: installSkill() not supported`); }
  /** Remove a user-installed Skill package. opts: {agentId?, id?, source?, version?, expectedRevision?}.
   * Built-in packages remain read-only; ambiguous identities must be rejected. */
  async uninstallSkill(_name, _opts = {}) { throw new Error(`${this.id}: uninstallSkill() not supported`); }
  /** Read bounded Skill instructions without recording runtime usage.
   * opts: {agentId?, id?, source?, version?}; ambiguous identities must be rejected. */
  async previewSkill(_name, _opts = {}) { throw new Error(`${this.id}: previewSkill() not supported`); }

  /** Bounded, read-only plugin catalog page. Unsupported backends expose no installations. */
  async getExternalPluginCapabilities() {
    return { supported: false, reasonCode: "PLUGIN_UNSUPPORTED" };
  }
  async getExternalPluginCatalog(_query = {}) {
    return { supported: false, reasonCode: "PLUGIN_UNSUPPORTED", items: [] };
  }
  async getPluginCapabilitiesPage(_query = {}) {
    return { supported: false, reasonCode: "PLUGIN_UNSUPPORTED",
      catalogRevision: null, items: [], nextCursor: null };
  }
  async previewPluginInstall(_source) { throw new Error(`${this.id}: plugin install not supported`); }
  async previewPluginUninstall(_input) { throw new Error(`${this.id}: plugin uninstall not supported`); }
  async uninstallPlugin(_input) { throw new Error(`${this.id}: plugin uninstall not supported`); }
  async preparePluginMcpConsent(_input) { throw new Error(`${this.id}: plugin consent not supported`); }
  async preparePluginOAuth(_input) { throw new Error(`${this.id}: plugin OAuth not supported`); }
  async preparePluginDisconnect(_input) { throw new Error(`${this.id}: plugin disconnect not supported`); }
  async commitPluginDisconnect(_input) { throw new Error(`${this.id}: plugin disconnect not supported`); }
  async getPluginDisconnectOperation(_agentId, _operationId) { throw new Error(`${this.id}: plugin disconnect not supported`); }
  async previewPluginDependency(_input) { throw new Error(`${this.id}: plugin dependencies not supported`); }
  async commitPluginDependency(_input) { throw new Error(`${this.id}: plugin dependencies not supported`); }
  async getPluginDependencyStatus(_input) { throw new Error(`${this.id}: plugin dependencies not supported`); }
  async getPluginDependencyOperation(_operationId) { throw new Error(`${this.id}: plugin dependencies not supported`); }
  async commitPluginOAuth(_input) { throw new Error(`${this.id}: plugin OAuth not supported`); }
  async getPluginOAuthStatus(_agentId, _flowId) { throw new Error(`${this.id}: plugin OAuth not supported`); }
  async cancelPluginOAuth(_agentId, _flowId) { throw new Error(`${this.id}: plugin OAuth not supported`); }
  async preparePluginApp(_sessionKey, _callId) { throw new Error(`${this.id}: plugin Apps not supported`); }
  async commitPluginApp(_input) { throw new Error(`${this.id}: plugin Apps not supported`); }
  async readPluginAppChunk(_transport, _index) { throw new Error(`${this.id}: plugin Apps not supported`); }
  async messagePluginApp(_transport, _message) { throw new Error(`${this.id}: plugin Apps not supported`); }
  async closePluginApp(_transport) { throw new Error(`${this.id}: plugin Apps not supported`); }
  async commitPluginMcpConsent(_input) { throw new Error(`${this.id}: plugin consent not supported`); }
  async discoverPluginMcpTools(_agentId, _bindingId) { throw new Error(`${this.id}: plugin discovery not supported`); }
  async installPlugin(_input) { throw new Error(`${this.id}: plugin install not supported`); }
  async getPluginOperation(_operationId) { return { found: false, operation: null }; }
  async setPluginInstallationState(_input) {
    throw new Error(`${this.id}: plugin installation state not supported`);
  }
  async getPluginSkillBindings(_agentId) {
    throw new Error(`${this.id}: plugin Skill bindings not supported`);
  }
  async getPluginMcpStatus(_agentId, _installationId) {
    throw new Error(`${this.id}: plugin MCP status not supported`);
  }
  async getPluginMcpTools(_agentId, _bindingId) {
    throw new Error(`${this.id}: plugin MCP tools not supported`);
  }
  async revokePluginMcpGrant(_input) {
    throw new Error(`${this.id}: plugin MCP grant revocation not supported`);
  }
  async revokeAllPluginMcpGrants(_input) {
    throw new Error(`${this.id}: plugin MCP grant revocation not supported`);
  }
  async setPluginSkillBinding(_input) {
    throw new Error(`${this.id}: plugin Skill bindings not supported`);
  }

  // ---- models (management UI) ----

  /**
   * Currently-active model(s) for this backend (per scope where applicable).
   * @returns {Promise<{active?: string, byScope?: object}>}
   */
  async getActiveModel() { return {}; }

  /**
   * Set the active model. opts may include { scope } (agentId/profile).
   * @param {string} modelId
   * @param {object} [opts]
   * @returns {Promise<object>}
   */
  async setActiveModel(modelId, opts) { throw new Error(`${this.id}: setActiveModel() not supported`); }

  // ---- auxiliary models (management UI; Hermes-only) ----

  /**
   * Per-task auxiliary model assignments (vision / compression / title-gen / …).
   * Hermes exposes fixed task slots; other backends have no equivalent (empty).
   * @param {{profile?: string}} [opts] 目标 profile（缺省 default）
   * @returns {Promise<{slots: Array<{task: string, provider: string, model: string}>, main: {provider: string, model: string}}>}
   */
  async getAuxiliaryModels(opts) { return { slots: [], main: {} }; }

  /**
   * Assign a model to one auxiliary task slot. task "__reset__" resets all to main.
   * 写语义与官方 App 一致（POST /api/model/set 直写，无条件锁）。
   * @param {string} task slot key (or "__reset__")
   * @param {string} [provider]
   * @param {string} [model]
   * @param {{profile?: string}} [opts]
   * @returns {Promise<object>}
   */
  async setAuxiliaryModel(task, provider, model, opts) { throw new Error(`${this.id}: setAuxiliaryModel() not supported`); }

  // ---- model settings（官方「模型」+「提供方」设置整合面；Hermes-only）----

  /**
   * 模型设置聚合快照（官方 model-settings 的 Promise.all refresh 同款）：
   * 主模型 + 全宇宙 provider 目录（含未配置，authenticated:false）+ 辅助槽 +
   * MoA 配置 + agent.* 默认参数 + fallback 链。不支持的后端返回 {supported:false}，
   * UI 据此隐藏整个设置区（数据驱动，非后端名驱动）。
   * @param {{profile?: string}} [opts]
   * @returns {Promise<{supported: boolean, profile?: string, profiles?: string[],
   *   main?: {provider: string, model: string},
   *   providers?: Array<{name: string, slug: string, models: string[],
   *     authenticated?: boolean, authType?: string, keyEnv?: string,
   *     isUserDefined?: boolean, isCurrent?: boolean,
   *     capabilities?: Record<string, {fast?: boolean, reasoning?: boolean}>,
   *     pricing?: Record<string, object>}>,
   *   auxiliary?: {slots: Array<{task: string, provider: string, model: string}>,
   *     main: {provider: string, model: string}},
   *   defaults?: {reasoningEffort: string, serviceTier: string},
   *   fallbacks?: Array<{provider: string, model: string}>,
   *   moa?: object|null}>}
   */
  async getModelSettings(opts) { return { supported: false }; }

  /**
   * 应用主模型（官方 POST /api/model/set scope:"main" 同款）。
   * @param {{profile?: string, provider: string, model: string}} opts
   * @returns {Promise<{ok: boolean, provider: string, model: string,
   *   staleAux: Array<{task: string, provider: string, model: string}>}>}
   */
  async applyMainModel(opts) { throw new Error(`${this.id}: applyMainModel() not supported`); }

  /**
   * 写全局默认参数（agent.reasoning_effort / agent.service_tier）。
   * 官方=整份 config 回环 PUT；本实现只发嵌套键，服务端深合并等价且更抗覆盖。
   * @param {{profile?: string, reasoningEffort?: string, serviceTier?: string}} opts
   * @returns {Promise<{ok: boolean}>}
   */
  async setModelDefaults(opts) { throw new Error(`${this.id}: setModelDefaults() not supported`); }

  /**
   * 写 fallback_providers 链（顺序即优先级；list 深合并=整体替换）。
   * @param {Array<{provider: string, model: string}>} entries
   * @param {{profile?: string}} [opts]
   * @returns {Promise<{ok: boolean}>}
   */
  async setFallbackModels(entries, opts) { throw new Error(`${this.id}: setFallbackModels() not supported`); }

  /**
   * MoA（Mixture of Agents）配置整份保存（官方 PUT /api/model/moa 同款，
   * 半填槽位由调用方挡在 UI 层——服务端 422 拒绝）。
   * @param {object} config camelCase MoA 配置（backend 负责转回 snake_case）
   * @param {{profile?: string}} [opts]
   * @returns {Promise<object>} 保存后的权威配置（camelCase）
   */
  async saveMoaConfig(config, opts) { throw new Error(`${this.id}: saveMoaConfig() not supported`); }

  /**
   * 新激活 provider 的推荐默认模型（官方 /api/model/recommended-default 同款；
   * Nous 按 free/paid tier 挑）。失败/不支持返回空 model，调用方回退目录第一个。
   * @param {string} provider
   * @param {{profile?: string}} [opts]
   * @returns {Promise<{provider: string, model: string, freeTier: boolean|null}>}
   */
  async getRecommendedDefaultModel(provider, opts) { return { provider, model: "", freeTier: null }; }

  // ---- custom endpoints（官方「提供方 → 自定义端点」；OpenAI 兼容自建端点）----

  /**
   * 自定义端点列表。
   * @param {{profile?: string}} [opts]
   * @returns {Promise<{supported: boolean, current?: {provider: string, model: string, baseUrl: string},
   *   endpoints: Array<{id: string, name: string, baseUrl: string, model: string,
   *     models: string[], hasApiKey: boolean, apiKeyPreview?: string|null,
   *     contextLength?: number|null, discoverModels: boolean, isCurrent?: boolean, source?: string}>}>}
   */
  // Hermes 侧端点是**跨 profile 同步**的（R296）：不传 profile 时聚合全部 profile
  // 并回 profiles/activeIn；save/delete 广播到每个 profile，make_default 除外。
  async listCustomEndpoints(opts) { return { supported: false, endpoints: [] }; }

  /**
   * 新建/更新自定义端点（id 缺省=新建；编辑时 apiKey 留空=保持原 key）。
   * @param {{id?: string, name: string, baseUrl: string, model: string, apiKey?: string,
   *   contextLength?: number, discoverModels?: boolean, makeDefault?: boolean}} endpoint
   * @param {{profile?: string}} [opts]
   * @returns {Promise<object>} 官方响应：{ok, id, endpoints, current}
   */
  async saveCustomEndpoint(endpoint, opts) { throw new Error(`${this.id}: saveCustomEndpoint() not supported`); }

  /**
   * 连通性校验（副作用只有对目标 URL 的探测）：返回可达性 + 发现的模型列表。
   * @returns {Promise<{ok: boolean, reachable: boolean, message: string, models: string[]}>}
   */
  async validateCustomEndpoint(endpoint, opts) { throw new Error(`${this.id}: validateCustomEndpoint() not supported`); }

  /**
   * 激活某端点为该 profile 的主模型。
   * @returns {Promise<{ok: boolean, provider: string, model: string}>}
   */
  async activateCustomEndpoint(id, opts) { throw new Error(`${this.id}: activateCustomEndpoint() not supported`); }

  /**
   * 删除自定义端点（source:"direct-config" 的条目由 config 直管，不可删）。
   * @returns {Promise<object>} 官方响应：{ok, endpoints}
   */
  async deleteCustomEndpoint(id, opts) { throw new Error(`${this.id}: deleteCustomEndpoint() not supported`); }

  // ---- custom model config (management UI) ----

   /**
   * 可编辑的 provider 配置。两类：
   *   source:"config" —— 用户自定义 provider（端点+模型都在配置文件里），models 非空，
   *                      可增删模型；
   *   source:"env"    —— 内置目录 provider，凭证在环境变量里（keyEnv/baseUrlEnv），
   *                      只能改 Key/端点，models 恒为 []（目录由上游给）；baseUrl
   *                      恒为 ""（明文随 revealModelProviderKey 返回），hasBaseUrl
   *                      表示是否覆盖过默认端点。
   * catalogId = 该模型在本后端 getModels() 目录里的 UnifiedModel.id，供页面 O(1)
   * 标记「自定义」卡片并定位删除目标。
   * authenticated（env 类）= 该 provider 目录里已有模型，即它已经能用——未必靠
   * env Key（可能是 OAuth/CLI/中转认证），据此区分「无需填 Key」与「填了才能用」。
   * @returns {Promise<{providers: Array<{key: string, name?: string, baseUrl: string,
   *   api?: string, hasApiKey: boolean, source: "config"|"env", editable: boolean,
   *   authenticated?: boolean, keyEnv?: string, baseUrlEnv?: string, profiles?: string[],
   *   models: Array<{id: string, name?: string, contextWindow?: number,
   *     maxTokens?: number, reasoning?: boolean, catalogId: string}>}>}>}
   */
  async getModelConfig() { return { providers: [] }; }

  /**
   * 模型变更能力声明。默认后端不支持任何写操作，调用方不得据缓存推断可用性。
   *
   * `perAgentModelSettings` 与其余位不同：它是**静态事实**而非运行时探测结果——
   * 「该后端的模型配置按 agent 各存一份」（Hermes 的 profile = 一个 agent = 一份
   * 独立 config），于是主模型/默认参数/辅助模型/MoA/回退链归「代理」页的每个
   * agent，「模型」页只承载跨 agent 共享的凭证层（env Key / 自定义端点）。
   * 实现必须把它放在运行时探测的 try/catch **之外**无条件返回：一次 provider
   * 读取失败不该让页面形态翻转。同 claimsAgentId（静态归属）vs ownsAgentId
   * （运行时就绪）的分层。
   * `manageAuthProfiles` 是授权 profile 管理面是否存在的静态能力；UI 不得从
   * provider 缺少 config 条目推断 OAuth/CLI 凭证可管理。默认 false。
   * @returns {Promise<{supported: boolean, create: boolean, update: boolean, rename: boolean, delete: boolean, updateProvider: boolean, perAgentModelSettings?: boolean, manageAuthProfiles?: boolean, blockers: string[]}>}
   */
  async getModelChangeCapabilities() {
    return { supported: false, create: false, update: false, rename: false, delete: false, updateProvider: false, manageAuthProfiles: false, blockers: ["unsupported"] };
  }

  /**
   * 获取实时模型目录来源；默认实现明确拒绝，避免用热缓存冒充实时目录。
   * @returns {Promise<Array<object>>}
   */
  async getModelCatalogSources() {
    throw new Error(`${this.id}: fresh model catalog sources not supported`);
  }

  /** 预览模型变更；具体后端必须覆盖并提供真实的影响分析。 */
  async previewModelChange() { throw new Error(`${this.id}: previewModelChange() not supported`); }

  /** 应用模型变更；具体后端必须覆盖并执行实际写入。 */
  async applyModelChange() { throw new Error(`${this.id}: applyModelChange() not supported`); }

  /** 恢复中断的模型变更；具体后端必须覆盖并实现可恢复语义。 */
  async recoverModelChange() { throw new Error(`${this.id}: recoverModelChange() not supported`); }

  /**
   * 仅写配置（不做运行态收敛）的降级写能力声明。完整立即应用不可用时，
   * coordinator 只有在该声明允许对应 kind、且 preview blocker 全部落在
   * bypassBlockerCodes 内时才会降级为 config-only 写；生效动作由 activation 描述。
   * 模型 rename 涉及引用迁移，永远不允许 config-only。provider 改名由可选的
   * renameProvider 字段声明（update-provider patch 的 renameTo；实现方必须同步
   * 迁移允许列表/primary/fallbacks 引用与凭证存储,做不到就不声明）。
   * @returns {Promise<{supported: boolean, create: boolean, update: boolean, delete: boolean,
   *   updateProvider: boolean, renameProvider?: boolean, activation: {kind: string}|null,
   *   bypassBlockerCodes: string[], blockers: string[]}>}
   */
  async getModelConfigWriteCapabilities() {
    return {
      supported: false, create: false, update: false, delete: false, updateProvider: false,
      activation: null, bypassBlockerCodes: [], blockers: ["unsupported"],
    };
  }

  /** 仅写配置的模型变更；同 spec 重放必须幂等，外部写入成功后须经 context
   * checkpoint secretStep，且可用 fingerprints 保存无敏感原文的读回判据。 */
  async applyModelChangeConfigOnly() { throw new Error(`${this.id}: applyModelChangeConfigOnly() not supported`); }

  /**
   * 批量仅写配置变更：把多个已归一化 spec 按序合并成【一次】配置写入
   * (网关控制面写 3 次/60s 限流按请求数计,批量把 N 次合成 1 次)。
   * 支持方在 getModelConfigWriteCapabilities 声明 batch:true 才可用;
   * 整批必须重放幂等(已完成的子操作跳过收敛)。
   */
  async applyModelChangeConfigOnlyBatch() { throw new Error(`${this.id}: applyModelChangeConfigOnlyBatch() not supported`); }

  /**
   * 恢复中断的 config-only 变更：只读回配置验证目标是否已写入，返回
   * applied（精确验证已写入）或 partial+retryable（未确认，等完整 spec 重试），
   * code=config_write_not_applied 允许同请求重新预检；其它 partial 只等待恢复。
   * 绝不在缺少原始请求字段时盲目重放。
   */
  async recoverModelChangeConfigOnly() { throw new Error(`${this.id}: recoverModelChangeConfigOnly() not supported`); }

  /** 让已保存的 config-only 变更生效（如重启网关）；仅 activation 非空的后端需要实现。 */
  async activateModelConfig() { throw new Error(`${this.id}: activateModelConfig() not supported`); }

  /**
   * 授权登录 provider 的凭证 profile 列表（脱敏投影，绝不返回完整 key/token）。
   * @returns {Promise<{supported: boolean, reason?: string, profiles: Array<{id: string,
   *   provider: string, type: string, keyTail?: string, email?: string, expires?: number}>}>}
   */
  async listModelAuthProfiles() { return { supported: false, profiles: [] }; }

  /** 写入/更新某 provider 的 api_key 型授权 profile（重新授权）；oauth 型拒绝覆盖。 */
  async setModelAuthProfileKey() { throw new Error(`${this.id}: setModelAuthProfileKey() not supported`); }

  /** 删除一条授权 profile（登出）；生效通常需要重启网关。 */
  async deleteModelAuthProfile() { throw new Error(`${this.id}: deleteModelAuthProfile() not supported`); }

  /**
   * 新增（同 id 覆盖）一个自定义模型。provider 不存在时必须带 baseUrl
   * （apiKey 可选——本地端点可无鉴权）；已存在时端点字段可省略。
   * @param {{providerKey: string, baseUrl?: string, apiKey?: string, api?: string,
   *   model: {id: string, name?: string, contextWindow?: number, maxTokens?: number,
   *   reasoning?: boolean}}} spec
   * @returns {Promise<{warnings?: string[]}>} 部分 profile 失败时给 warnings（Hermes）
   */
  async addModelConfig(spec) { throw new Error(`${this.id}: addModelConfig() not supported`); }

  /**
   * 删除一个自定义模型；provider 最后一个模型删掉后连 provider 条目一起移除。
   * @param {{providerKey: string, modelId: string}} ref
   * @returns {Promise<{warnings?: string[]}>}
   */
  async removeModelConfig(ref) { throw new Error(`${this.id}: removeModelConfig() not supported`); }

  /**
   * 更新一个 provider 的端点字段。只写传入的非空字段（apiKey 留空 = 不改）；
   * 模型数组不归此方法管（用 add/removeModelConfig）。source:"env" 的 provider
   * 写的是其 keyEnv/baseUrlEnv 环境变量。provider 不存在则抛错。
   * clearBaseUrl:true 且 baseUrl 为空 → 删掉端点覆盖（env 类），回落上游默认端点。
   * @param {string} providerKey
   * @param {{baseUrl?: string, apiKey?: string, api?: string, clearBaseUrl?: boolean}} patch
   * @returns {Promise<{warnings?: string[]}>}
   */
  async updateModelProvider(providerKey, patch) { throw new Error(`${this.id}: updateModelProvider() not supported`); }

  /**
   * 删除一个 provider。source:"config" → 连同它的模型一起从配置里移除；
   * source:"env" → 清掉它的 API Key / 端点覆盖环境变量（provider 回到未配置状态，
   * 目录条目由上游决定是否还在）。
   * @param {string} providerKey
   * @returns {Promise<{warnings?: string[]}>}
   */
  async removeModelProvider(providerKey) { throw new Error(`${this.id}: removeModelProvider() not supported`); }

  /**
   * 该 provider 的凭证池条目（轮换 key，脱敏）。Hermes 的 credential_pool——凭证
   * 未必来自环境变量：source 形如 "env:XXX_API_KEY" / "gh_cli" / "manual" /
   * "claude_code"。没有池概念的后端返回 []。
   * @param {string} providerKey
   * @returns {Promise<Array<{index: number, id?: string, label?: string, authType?: string,
   *   source?: string, lastStatus?: string, requestCount?: number, hasRefresh?: boolean,
   *   tokenPreview?: string}>>}
   */
  async listProviderCredentials(providerKey) { return []; }

  /**
   * 删除一条凭证池条目。index 用 listProviderCredentials 返回的值（1-based）。
   * @param {string} providerKey
   * @param {number} index
   * @returns {Promise<object>}
   */
  async removeProviderCredential(providerKey, index) { throw new Error(`${this.id}: removeProviderCredential() not supported`); }

  /**
   * 取一个 provider 的 API Key（及 source:"env" 时的端点覆盖）明文。loopback 管理面
   * 按需拉取，不进列表接口。取不到 key 时 apiKey=null 并给 reason：
   *   "none"=没存（可填）｜"env"=只存了环境变量名｜"managed"=走 OAuth/CLI 登录，
   *   无可写 Key｜"remote"=后端在远端，本机读不到。
   * @param {string} providerKey
   * @returns {Promise<{apiKey: string|null, baseUrl?: string, reason?: "none"|"env"|"managed"|"remote", envVar?: string}>}
   */
  async revealModelProviderKey(providerKey) { return { apiKey: null, reason: "none" }; }

  /**
   * Provider 目录卡（管理面「提供方」页签）：内置已知 provider 目录 ∪ 已配置项。
   * OpenClaw-only（Hermes 走 env 五方法那套）。不支持的后端返回 {supported:false}。
   * @returns {Promise<{supported: boolean, providers?: Array<{id: string, label: string,
   *   logoKey: string, getKeyUrl: string|null, api: string|null,
   *   baseUrl: {value: string|null, defaultValue: string|null, editable: boolean},
   *   key: {configured: boolean, source: "config"|"auth-profile"|null},
   *   configured: boolean, modelsCount: number,
   *   oauth: Array<{choiceId: string, method: string, label: string}>}>}>}
   */
  async getProviderDirectory() { return { supported: false }; }

  // ---- env / provider credentials (management UI; Hermes-only) ----

  /**
   * List configurable env vars / API keys (values redacted). Default: none.
   * `tools` = 用到该 key 的工具名；`channelManaged` = 归渠道页管的平台凭证；
   * `custom` = 用户自己加的、不在任何目录里的键。
   * @returns {Promise<Array<{key: string, isSet: boolean, redactedValue: string|null, description: string, url: string|null, category: string, isPassword: boolean, advanced: boolean, tools?: string[], channelManaged?: boolean, custom?: boolean}>>}
   */
  async listEnvVars() { return []; }

  /** Set an env var / API key. @returns {Promise<object>} */
  async setEnvVar(key, value) { throw new Error(`${this.id}: setEnvVar() not supported`); }

  /** Delete an env var / API key. @returns {Promise<object>} */
  async deleteEnvVar(key) { throw new Error(`${this.id}: deleteEnvVar() not supported`); }

  /** Reveal the unredacted value of one env var. @returns {Promise<{value: string}>} */
  async revealEnvVar(key) { throw new Error(`${this.id}: revealEnvVar() not supported`); }

  /** Live-probe a provider credential (best-effort). @returns {Promise<{supported: boolean, valid?: boolean}>} */
  async validateProviderCredential(key, value) { return { supported: false }; }

  // ---- OAuth provider logins (management UI) ----
  //
  // Hermes：登录态是**按 profile 存**的（每个 isolated dashboard 一份 auth 库），所以：
  // 读聚合（哪些 profile 连上了 → connectedProfiles），登出广播，而登录流三步
  // （start/submit/poll）必须落在**同一个** dashboard —— session 存在它的进程内存里，
  // 故这三个方法带 profile 参数。
  // OpenClaw：无 profile 维度（profiles 恒空）；flow 一律 "external"（gateway 无
  // authLogin RPC，发起 = 终端跑 cliCommand + 「我已登录」回查），start/submit/poll/
  // cancel 不实现；条目多带 cliRunnable（远程网关 = false：命令须在网关机器上跑，
  // UI 只给复制不给「在终端运行」）。

  /**
   * 枚举可 OAuth 登录的 provider + 当前状态。profiles = 可选的目标 profile 列表。
   * 条目形状见 manage-ui types.ts 的 OAuthProvider（cliRunnable 缺省视为 true）。
   * @returns {Promise<{providers: Array<object>, profiles: string[]}>}
   */
  async listOAuthProviders() { return { providers: [], profiles: [] }; }

  /** 断开一个 OAuth provider（不带 profile = 全部 profile 广播）。@returns {Promise<object>} */
  async disconnectOAuthProvider(providerId, profile) { throw new Error(`${this.id}: disconnectOAuthProvider() not supported`); }

  /** 发起 OAuth 登录（pkce 返回 auth_url，device_code 返回 user_code）。@returns {Promise<object>} */
  async startOAuthLogin(providerId, profile) { throw new Error(`${this.id}: startOAuthLogin() not supported`); }

  /** 提交 PKCE 授权码。@returns {Promise<object>} */
  async submitOAuthCode(providerId, sessionId, code, profile) { throw new Error(`${this.id}: submitOAuthCode() not supported`); }

  /** 轮询 device-code 会话状态。@returns {Promise<object>} */
  async pollOAuthSession(providerId, sessionId, profile) { throw new Error(`${this.id}: pollOAuthSession() not supported`); }

  /** 取消一个待定的 OAuth 会话。@returns {Promise<object>} */
  async cancelOAuthSession(sessionId, profile) { throw new Error(`${this.id}: cancelOAuthSession() not supported`); }

  // ---- agents (management UI, 代理 page parity) ----

  /**
   * Full detail for one agent: identity, model, workspace, + the file list.
   * @param {string} id
   * @returns {Promise<object>} { id, name, model?, fallbacks?, workspace?, identity?, files?, ... }
   */
  async getAgent(id) { throw new Error(`${this.id}: getAgent() not supported`); }

  /**
   * Create an agent. spec is backend-specific (name, cloneFrom?, model?, ...).
   * @param {object} spec
   * @returns {Promise<object>}
   */
  async createAgent(spec) { throw new Error(`${this.id}: createAgent() not supported`); }

  /**
   * Update an agent (name, model, identity {emoji/avatar/color}, workspace, ...).
   * @param {string} id
   * @param {object} patch —— `patch.fallbacks` (string[]) 是模型降级链，与
   *   `patch.model` 同属 agent 的 model 节点：后端必须**整节点写**，只写 primary
   *   会清空 fallbacks（OpenClaw 的 agents.update RPC 就是这样，故它改走
   *   config.patch，见 openclaw-backend.js）。不支持降级链的后端忽略该字段。
   * @returns {Promise<{id: string} & object>} `id` is the agent's id AFTER the
   *   update. Some backends derive the id from the agent's name (Hermes: renaming
   *   a profile re-keys its agent), so callers must re-select on the RETURNED id
   *   rather than the one they passed in.
   */
  async updateAgent(id, patch) { throw new Error(`${this.id}: updateAgent() not supported`); }

  /**
   * 该 agent 的「产出文件」（Agent 页文件 tab）。复用 dashboard 产出区的同一套
   * 扫描规则（core/artifact-scan.js：深度≤2、lstat 不追 symlink、点文件/黑名单/
   * 身份文件排除），只是把根收窄到这个 agent 自己的目录。
   * 纯本地磁盘能力（远端网关/远端 Hermes → supported:false + reason:"remote"），
   * 与 getRecentArtifacts 同一约束。
   * `total` = 扫描到的产出文件总数（items 按 mtime 倒序截到 limit，长度 ≠ 总数）；
   * 与 dashboard 同受 walker 的 stat 硬上限约束。
   * @param {string} _agentId
   * @param {{limit?: number}} [_opts]
   * @returns {Promise<{supported: boolean, reason?: string, total?: number, items: Array<{path: string,
   *   name: string, area: string, size: number, mtimeMs: number, ext?: string, kind: string}>}>}
   */
  async listAgentArtifacts(_agentId, _opts) { return { supported: false, reason: "unsupported", items: [] }; }

  /**
   * AI output files attributable to one chat session's successful write events.
   * Workspace timestamps alone are not provenance. Unavailable history and
   * remote backends return supported:false instead of unscoped local files.
   * @param {string} _agentId
   * @param {string} _sessionKey
   * @param {{limit?: number}} [_opts]
   * @returns {Promise<{supported: boolean, reason?: string, approximate?: boolean,
   *   sinceMs?: number, total?: number, items: Array<object>}>}
   */
  async listSessionArtifacts(_agentId, _sessionKey, _opts) {
    return { supported: false, reason: "unsupported", items: [] };
  }

  /**
   * Remove an agent according to descriptor.agentLifecycle. Native backends
   * archive for seven days before deleting their owned product data; external
   * workspace files and shared Runtime accounts are retained. opts: { trash?: boolean }.
   * @param {string} id
   * @param {object} [opts]
   * @returns {Promise<void>}
   */
  async deleteAgent(id, opts) { throw new Error(`${this.id}: deleteAgent() not supported`); }

  /**
   * Restore a recoverably archived agent within its retention period. Backends that only support permanent
   * removal leave descriptor.agentLifecycle.restore=false and inherit this method.
   * @param {string} id
   * @param {object} [opts]
   * @returns {Promise<object>}
   */
  async restoreAgent(id, opts) { throw new Error(`${this.id}: restoreAgent() not supported`); }

  async getAgentRuntimeBindings(_id) { throw new Error(`${this.id}: runtime bindings not supported`); }
  async getAgentRuntimePolicy(_id) { throw new Error(`${this.id}: runtime policy not supported`); }
  async compactConversation(_id, _key, _operationId) { throw new Error(`${this.id}: product context not supported`); }
  async setAgentRuntimePolicy(_id, _policy) { throw new Error(`${this.id}: runtime policy not supported`); }
  async addAgentRuntimeBinding(_id, _spec, _options) { throw new Error(`${this.id}: runtime bindings not supported`); }
  async updateAgentRuntimeBinding(_id, _bindingId, _patch, _options) { throw new Error(`${this.id}: runtime bindings not supported`); }
  async removeAgentRuntimeBinding(_id, _bindingId, _options) { throw new Error(`${this.id}: runtime bindings not supported`); }
  async setAgentDefaultBinding(_id, _bindingId, _options) { throw new Error(`${this.id}: runtime bindings not supported`); }
  async getSessionRuntime(_id, _key) { throw new Error(`${this.id}: session runtime switching not supported`); }
  async switchSessionRuntime(_id, _key, _input) { throw new Error(`${this.id}: session runtime switching not supported`); }
  /** Connected CLI catalogs for this Agent's conversation; choices retain their Runtime Binding identity. */
  async getSessionRuntimeModels(_id, _key) { throw new Error(`${this.id}: session runtime models not supported`); }
  /** Atomically select the conversation's Runtime and model, without changing the Agent default. */
  async selectSessionRuntimeModel(_id, _key, _input) { throw new Error(`${this.id}: session runtime models not supported`); }

  /**
   * List the agent's editable workspace files.
   * 工作区条目可能是指向别处的链接（symlink / hardlink）；后端应把它当普通文件
   * 呈现（size/modifiedAt 取链接目标的），而不是报缺失。
   * @param {string} id
   * @returns {Promise<Array<{name: string, size?: number, modifiedAt?: number}>>}
   */
  async listAgentFiles(id) { return []; }

  /**
   * Read one of the agent's workspace files.
   * 链接条目读的是链接目标的内容。
   * @param {string} id
   * @param {string} file e.g. "soul.md"
   * @returns {Promise<{name: string, content: string}>}
   */
  async getAgentFile(id, file) { throw new Error(`${this.id}: getAgentFile() not supported`); }

  /**
   * Write one of the agent's workspace files.
   * 链接条目写的是链接目标本身（链接不被替换成普通文件）——即同一目标的其他引用
   * 者也会看到这次改动，这正是软链共享身份文件的语义。
   * @param {string} id
   * @param {string} file
   * @param {string} content
   * @returns {Promise<object>}
   */
  async setAgentFile(id, file, content) { throw new Error(`${this.id}: setAgentFile() not supported`); }

  /** Structured persistent-Agent controls. External backends remain unsupported. */
  async getAgentDefinition(_id) { return { supported: false, reason: "unsupported" }; }
  async restoreAgentDefinition(_id, _revision, _expectedRevision) {
    throw new Error(`${this.id}: restoreAgentDefinition() not supported`);
  }
  async exportAgentDefinition(_id) { throw new Error(`${this.id}: exportAgentDefinition() not supported`); }
  async importAgentDefinition(_id, _bundle, _expectedRevision) {
    throw new Error(`${this.id}: importAgentDefinition() not supported`);
  }
  async listAgentMemories(_id, _opts) { return { supported: false, reason: "unsupported", items: [] }; }
  async mutateAgentMemory(_id, _action, _input) {
    throw new Error(`${this.id}: mutateAgentMemory() not supported`);
  }
  async listAgentTranscripts(_id, _opts) { return { supported: false, reason: "unsupported", items: [] }; }
  async setAgentTranscriptContext(_id, _input) {
    throw new Error(`${this.id}: setAgentTranscriptContext() not supported`);
  }
  async listAgentTools(_id) { return { supported: false, reason: "unsupported", tools: [] }; }
  async setAgentToolPermission(_id, _input) {
    throw new Error(`${this.id}: setAgentToolPermission() not supported`);
  }
  async getAgentComputerState(_id) {
    return { supported: false, reason: "unsupported", available: false, sessions: [] };
  }

  /**
   * Communication channels bound to this agent (read-only overview).
   * @param {string} id
   * @returns {Promise<Array<object>>}
   */
  async getAgentChannels(id) { return []; }

  /**
   * Archived (rotated-out) transcript segments that preceded a session's CURRENT
   * physical transcript — the gateway's usage-family chain minus the live session.
   * Surfaces history the gateway sealed on a role-ordering-conflict reset (it
   * renames `<id>.jsonl` → `<id>.jsonl.reset.<ts>` and starts a fresh session, so
   * `chat.history` no longer serves the old turns). OpenClaw-only (reads the local
   * on-disk session store); other backends / a remote gateway return
   * `{ supported: false }`.
   * @param {string} agentId
   * @param {string} sessionKey  e.g. "agent:sara:main"
   * @returns {Promise<{ supported: boolean, reason?: string, segments: Array<{ sessionId: string, sealedAt: number|null, fromReset: boolean, truncated?: boolean, messages: Array<object> }> }>}
   */
  async getSessionArchive(agentId, sessionKey) { return { supported: false, segments: [] }; }

  /**
   * Head-of-transcript preview for a usage top-session — answers「这个会话在聊
   * 什么」without loading the chat plane. Returns the first N user/assistant
   * messages with text extracted (tool-only turns skipped). Backends without
   * per-session transcript access return { supported: false }.
   * @param {string} agentId
   * @param {string} sessionKey backend 会话 key（OpenClaw "agent:x:tail"/裸 uuid；Hermes "profile:id"）
   * @param {{sessionId?: string, offset?: number, limit?: number}} [opts]
   *   sessionId=物理 transcript id（topSessions.sessionId），提供时精确定位该物理
   *   文件（同一逻辑 key 的 reset 链可对应多个文件）；offset/limit=文本消息窗口
   *   分页（UI 滑动逐步加载；limit 默认 100、上限 200）
   * @returns {Promise<{supported: boolean, reason?: string, title?: string, totalMessages?: number, offset?: number, truncated?: boolean, messages: Array<{role: string, text: string, timestamp?: number, model?: string}>}>}
   *   truncated = offset+messages.length 之后还有更多（UI 据此续拉）
   */
  async getSessionPreview(agentId, sessionKey, opts) { return { supported: false, reason: "unsupported", messages: [] }; }

  /**
   * Aggregate which host CLI commands this backend's agents have actually
   * invoked through their bash/exec tool, as { commandName: { agentId: count } } —
   * powers the CLI page's per-agent usage overlay (装了哪些 × 哪个 agent 用过).
   * Only a backend with on-disk command-level transcripts can answer; others
   * (remote gateway, no historical tool data) return { supported: false }.
   * Counts are best-effort and NOT $PATH-filtered — the UI joins them against
   * the host scan from GET /__api/cli. scanLimit (when set) = the page is showing
   * only the newest N sessions (older ones skipped for performance).
   * @returns {Promise<{ supported: boolean, reason?: string, commands: Record<string, Record<string, number>>, scanLimit?: number }>}
   */
  async getCliUsage() { return { supported: false, commands: {} }; }

  /**
   * Aggregate which SKILLS this backend's agents have actually loaded, as
   * { skillName: { agentId: count } } — the Skills page's per-agent usage
   * overlay (同 getCliUsage 的形状，UI 侧 join 逻辑一样)。
   * 「用过一次」= agent 主动把某个 skill 的正文读进上下文：OpenClaw 是一次
   * 读 `<…>/skills/<dir>/SKILL.md` 的 read 工具调用，Hermes 是一次 skill_view。
   * 光把 skill 列进系统提示的目录**不算**——那是每轮都发生的注入，不是使用。
   * 只有拿得到本机 transcript 的后端能回答；其余（远程网关）返回
   * { supported:false }。scanLimit 语义同 getCliUsage。
   * @returns {Promise<{ supported: boolean, reason?: string, skills: Record<string, Record<string, number>>, scanLimit?: number }>}
   */
  async getSkillUsage() { return { supported: false, skills: {} }; }

  // ---- dashboard 总览 (management UI) ----
  //
  // Per-backend capability sections for GET /__api/dashboard. Each returns
  // { supported, reason?, items } so the registry aggregates fail-soft and the
  // UI hides/degrades sections data-driven (铁律 1: no backend special-casing).
  // reason is a short machine code ("unsupported" | "unavailable" | "remote" |
  // "error") mapped to copy by the frontend. Defaults: unsupported.

  /**
   * Work items executing RIGHT NOW (cron runs, agent turns, subagent tasks).
   * item: { id, title?, kind?, runtime?, status?, agentId?, sessionKey?,
   *         runId?, createdAt?, startedAt?, progressSummary? }
   * @returns {Promise<{supported: boolean, reason?: string, items: Array<object>}>}
   */
  async getRunningWork() { return { supported: false, reason: "unsupported", items: [] }; }

  /** Native dashboard WorkRun detail; unsupported for external backends. */
  async getDashboardRunDetail(_runId) {
    throw new Error(`${this.id}: getDashboardRunDetail() not supported`);
  }

  /** Resolve a pending prompt/approval from the dashboard WorkRun surface. */
  async respondDashboardPrompt(_input) {
    throw new Error(`${this.id}: respondDashboardPrompt() not supported`);
  }

  /**
   * Exec/tool requests waiting for a HUMAN decision (read-only overview; v1
   * does not resolve them).
   * item: { id, commandPreview?, commandText?, agentId?, allowedDecisions?,
   *         createdAtMs?, expiresAtMs? }
   * @returns {Promise<{supported: boolean, reason?: string, items: Array<object>}>}
   */
  async getPendingApprovals() { return { supported: false, reason: "unsupported", items: [] }; }

  /**
   * Recently produced work-product files (reports, media), newest first. Only
   * a backend with local-disk access can answer (remote gateway → "remote"),
   * same constraint as getCliUsage.
   * item: { path, name, area, agentId?, size?, mtimeMs, ext?, kind }
   *   area: "workspace" | "media/outbound" | "agents/<id>"
   *   kind: "doc" | "image" | "data" | "other" (by extension; UI picks icon)
   * @param {{limit?: number}} [opts]
   * @returns {Promise<{supported: boolean, reason?: string, items: Array<object>}>}
   */
  async getRecentArtifacts(opts) { return { supported: false, reason: "unsupported", items: [] }; }

  /**
   * 看板活动源（统一动态流 kind:"kanban"）：sinceMs 以来的生命周期事件，由
   * backend 用 dashboard-activity.js 的映射器（真实上游 kind 词表）转成
   * DashboardActivityEntry。除 reason 惯例外可带 truncated（上游留存/分页
   * 上限导致当天不完整）。默认不支持。
   * @param {{sinceMs?: number}} [opts]
   * @returns {Promise<{supported: boolean, reason?: string, truncated?: boolean, items: Array<object>}>}
   */
  async getRecentKanbanActivities(_opts = {}) { return { supported: false, reason: "unsupported", items: [] }; }

  /**
   * 健康采样目标（registry 45s 采样 → DashboardJournal 健康事件）。默认由
   * getStatus() 派生单目标=后端自身；有子目标的后端（Hermes 整体 + 每
   * profile dashboard）覆盖本方法——registry/UI 不特判任何后端（铁律 1）。
   * @returns {Promise<Array<{targetType: string, targetId: string, state: "connected"|"disconnected", reason?: string}>>}
   */
  async getHealthTargets() {
    let status = null;
    try { status = await this.getStatus(); } catch { /* 视为断连 */ }
    return [{
      targetType: "backend",
      targetId: this.id,
      backendId: this.id,
      state: status?.connected ? "connected" : "disconnected",
      reason: (status && status.info && status.info.error) || undefined,
    }];
  }

  /**
   * DashboardJournal 注入点（健康事件 + kanban cursor/事件留存）。registry 在
   * attach/register 时对每个后端调用；默认只存引用，需要留存的后端自取。
   */
  attachDashboardJournal(journal) { this._dashboardJournal = journal || null; }

  /**
   * Dashboard 文件缩略图预览重验证：path 属于本后端当前允许根、扩展名为
   * 图片且为普通文件时返回 {absPath}，否则 null（路由层 404）。聊天
   * /__media 的 OpenClaw 安全边界不走这里。默认不支持。
   * @param {string} _path
   * @returns {Promise<{absPath: string}|null>}
   */
  async resolveArtifactPreview(_path) { return null; }

  /**
   * Test a candidate connection config WITHOUT persisting it (设置 page).
   * @param {object} spec backend-specific connection fields
   * @returns {Promise<{ok: boolean, error?: string, info?: object}>}
   */
  async testConnection(spec) { return { ok: false, error: `${this.id}: testConnection() not supported` }; }

  /**
   * LAN 发现开关状态(网关是否被 Bonjour 广播)。managed=false 表示无
   * plugins.allow 白名单——bonjour 默认启用(darwin),此时只读展示不可切。
   * @returns {Promise<{supported: boolean, enabled?: boolean, managed?: boolean, error?: string}>}
   */
  async getLanDiscovery() { return { supported: false }; }

  /**
   * 开/关 LAN 发现(写 plugins.allow)。
   * @returns {Promise<{enabled: boolean, requiresRestart: boolean}>}
   */
  async setLanDiscovery(enabled) { throw new Error(`${this.id}: setLanDiscovery() not supported`); }
}

module.exports = {
  AgentBackend,
  dirCreatedAtMs,
  sortAgentsByCreatedAt,
  WIDGET_RESOURCE_MAX_BYTES,
  SESSION_BOARD_HTML_MAX_BYTES,
  normalizeWidgetResourceContentType,
  projectWidgetResourceResult,
  normalizeSessionBoardHtmlWidgetSpec,
  projectSessionBoardHtmlWidgetResult,
  projectStandingGrantForBrowser,
  projectStandingGrantListForBrowser,
  projectStandingGrantRevokeResult,
  projectStandingGrantRevokeForBrowser,
};
