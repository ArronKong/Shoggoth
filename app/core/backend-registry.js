"use strict";

const { EventEmitter } = require("node:events");
const {
  agentIdentity,
  buildCanonicalColumns,
  canonicalStatus,
  mergeProjectRows,
  nativeTargetForCanonical,
  normalizeFederatedTask,
  normalizeProjectKey,
  parseAgentIdentity,
  taskProjectKey,
} = require("./kanban-federation");
const { buildVersionSummary, fetchOfficialLatestVersions } = require("./version-checker");
const { collectActivities, buildActivityPage } = require("./dashboard-activity");
const {
  projectWidgetResourceResult,
  normalizeSessionBoardHtmlWidgetSpec,
  projectSessionBoardHtmlWidgetResult,
} = require("./agent-backend");
const {
  unsupportedAdvancedSessionResult,
  projectEnvironmentInventory,
  projectSessionDescribeResult,
  projectSessionBranchesResult,
  projectSessionForkResult,
} = require("./session-advanced-projection");
const {
  unsupportedSessionBoardResult,
  projectSessionBoardEnvelope,
  normalizeSessionBoardAgentId,
  normalizeSessionBoardSessionKey,
  normalizeSessionBoardOps,
  normalizeSessionBoardCanvasSpec,
  normalizeSessionBoardGrantSpec,
} = require("./session-board-projection");

function advancedSessionFailureReason(value) {
  return value === "error" || value === "invalid-request" || value === "invalid-response"
    ? value
    : "unsupported";
}

// Dashboard 首屏不能被本地全历史 usage 冷扫描拖住。超时只让本轮该 section
// 降级；原 Promise 继续执行并填充 backend 的单飞缓存，前端随后自动补刷。
const DASHBOARD_USAGE_WAIT_MS = 5_000;
const { computeCatalogRevision, normalizeCatalogRows } = require("./model-catalog-revision");

/**
 * 给后端目录行补齐可信 backendId，并统一白名单与稳定顺序。
 * @param {*} rows
 * @param {string} backendId
 * @returns {Array<object>}
 */
function normalizedBackendRows(rows, backendId) {
  return normalizeCatalogRows(
    (Array.isArray(rows) ? rows : []).map((row) => ({ ...row, backendId })),
  );
}

// Registry chat-path getters are deliberately synchronous. A broken backend may
// still throw, return the wrong shape, or accidentally return a Promise; consume
// all three per backend so one adapter cannot sink the healthy aggregate.
function failSoftSyncCall(backend, method, ...args) {
  try {
    const value = backend[method](...args);
    if (value && typeof value.then === "function") {
      // Attach a rejection handler even though this violates the sync contract;
      // otherwise merely skipping the value would create an unhandled rejection.
      void Promise.resolve(value).catch(() => {});
      console.error(`[registry] ${backend.id} ${method} returned a Promise; expected a synchronous result`);
      return { ok: false, value: undefined };
    }
    return { ok: true, value };
  } catch (err) {
    console.error(`[registry] ${backend.id} ${method} failed:`, err?.message || err);
    return { ok: false, value: undefined };
  }
}

function failSoftSyncRows(backend, method) {
  const result = failSoftSyncCall(backend, method);
  if (!result.ok) return [];
  if (Array.isArray(result.value)) return result.value;
  console.error(`[registry] ${backend.id} ${method} returned a non-array result`);
  return [];
}

/**
 * Registry that manages multiple AgentBackend instances.
 *
 * The proxy gateway queries the registry instead of a single backend.
 * Registry responsibilities:
 *   1. Route: agentId → correct backend
 *   2. Aggregate: merge agents/models/sessions from all backends
 *   3. Lifecycle: start/stop all backends
 */
class BackendRegistry extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, import('./agent-backend').AgentBackend>} */
    this.backends = new Map();
    this._inspirationOwner = null;
    // 「断开连接」的后端 id 提供器（入口注入，实时读 config——与 backend 的
    // getUpstreamUrl 同款拉模型）。断开的后端仍保持注册（设置页要显示卡片和
    // 「重新连接」），但聚合/路由/健康采样全部跳过它。
    this._getDisabledIds = null;
  }

  /**
   * 注入「已断开后端 id 列表」提供器（如 () => configStore.read().disabledBackends）。
   * @param {() => Array<string>} fn
   */
  setDisabledBackendsProvider(fn) {
    this._getDisabledIds = typeof fn === "function" ? fn : null;
  }

  setInspirationOwner(owner) {
    this._inspirationOwner = owner || null;
    for (const backend of this.backends.values()) {
      if (["openclaw", "hermes"].includes(backend.id) && typeof backend.setInspirationOwner === "function") {
        backend.setInspirationOwner(this._inspirationOwner);
      }
    }
  }

  _requireInspirationOwner() {
    if (!this._inspirationOwner) {
      const error = new Error("灵感服务暂不可用，输入仍保留在本机");
      error.code = "INSPIRATION_UNAVAILABLE";
      throw error;
    }
    return this._inspirationOwner;
  }

  listInspirations(query) { return this._requireInspirationOwner().listInspirations(query); }
  getInspirationGrowth() { return this._requireInspirationOwner().getInspirationGrowth(); }
  async updateInspirationGrowth(input) {
    const { validateInspirationServiceParams } = require("../agent-service/inspiration-service-protocol");
    validateInspirationServiceParams("inspiration.growth.set", input);
    if (input.enabled) {
      const { agents } = await this.getInspirationAgents();
      if (input.executors.some(value => !agents.some(agent => agent.id === value.agentId
        && agent.backendId === value.backendId && agent.capabilities.execute))) {
        const error = new Error("所选执行者当前不可用，请重新选择 Agent");
        error.code = "INSPIRATION_UNSUPPORTED";
        throw error;
      }
    }
    return this._requireInspirationOwner().updateInspirationGrowth(input);
  }
  getInspiration(id) { return this._requireInspirationOwner().getInspiration(id); }
  createInspiration(input) { return this._requireInspirationOwner().createInspiration(input); }
  importInspirations(input) { return this._requireInspirationOwner().importInspirations(input); }
  writeInspirationMedia(input) { return this._requireInspirationOwner().writeInspirationMedia(input); }
  readInspirationMedia(input) { return this._requireInspirationOwner().readInspirationMedia(input); }
  updateInspiration(id, input) { return this._requireInspirationOwner().updateInspiration(id, input); }
  deleteInspiration(id, input) { return this._requireInspirationOwner().deleteInspiration(id, input); }
  getInspirationExecutions(id, query) { return this._requireInspirationOwner().getInspirationExecutions(id, query); }
  getInspirationActivity(id, runId) { return require("./inspiration-activity").loadInspirationActivity(this, id, runId); }
  getIdleInspirationAgents() { return require("./inspiration-presence").loadIdleInspirationAgents(this); }
  respondInspiration(id, input) { return this._requireInspirationOwner().respondInspiration(id, input); }
  cancelInspiration(id, input) { return this._requireInspirationOwner().cancelInspiration(id, input); }
  getExternalInspirationSessionRoute(input) {
    return this._inspirationOwner?.getExternalInspirationSessionRoute?.(input) ?? null;
  }
  hasExternalInspirationSessionBridge() {
    return typeof this._inspirationOwner?.getExternalInspirationSessionRoute === "function";
  }

  async getInspirationAgentDock() {
    const owner = this._requireInspirationOwner();
    const { agents } = await this.getInspirationAgents();
    const counts = new Map();
    // Bound each Service message without limiting the number of visible Agents.
    for (let offset = 0; offset < agents.length; offset += 50) {
      const batch = agents.slice(offset, offset + 50).map(agent => ({ backendId: agent.backendId, agentId: agent.id }));
      const result = await owner.getInspirationAgentStats(batch);
      for (const agent of result.agents) counts.set(`${agent.backendId}/${agent.agentId}`, agent.executionCount);
    }
    return { agents: agents.map(agent => ({ ...agent, executionCount: counts.get(`${agent.backendId}/${agent.id}`) || 0 }))
      .sort((a, b) => b.executionCount - a.executionCount) };
  }

  async getInspirationAgents() {
    const groups = await Promise.all(this._activeBackends().map(async (backend) => {
      try {
        const agents = await backend.listAgents();
        const capabilities = backend.getInspirationCapabilities();
        const status = capabilities.execute
          ? await backend.getStatus().catch(() => ({ connected: false })) : null;
        return agents.map((agent) => ({ id: agent.id, name: agent.name || agent.id,
          backendId: backend.id, backendName: backend.name,
          capabilities: status && (!status.connected || (Array.isArray(status.info?.readyAgentIds)
            && !status.info.readyAgentIds.includes(agent.id)))
            ? { ...capabilities, execute: false, reason: "backend-unavailable" } : capabilities }));
      } catch { return []; }
    }));
    return { agents: groups.flat() };
  }

  startInspiration(id, input) {
    const backend = this._activeGet(input.backendId);
    if (!backend || backend.getInspirationCapabilities().execute !== true) {
      const error = new Error("这个 Agent 暂不支持灵感执行");
      error.code = "INSPIRATION_UNSUPPORTED";
      throw error;
    }
    return this.getInspirationExecutorReadiness(input).then(({ ready }) => {
      if (!ready) {
        const error = new Error("这个 Agent 暂不可用，请稍后重试");
        error.code = "INSPIRATION_UNAVAILABLE";
        throw error;
      }
      return backend.startInspiration(id, input);
    });
  }

  async getInspirationExecutorReadiness({ backendId, agentId }) {
    const backend = this._activeGet(backendId);
    if (!backend || backend.getInspirationCapabilities().execute !== true) return { ready: false };
    const status = await backend.getStatus().catch(() => ({ connected: false }));
    if (!status.connected || status.disabled === true) return { ready: false };
    const ids = status.info?.readyAgentIds;
    if (Array.isArray(ids)) return { ready: ids.includes(agentId) };
    const agents = await backend.listAgents().catch(() => []);
    return { ready: agents.some(agent => agent.id === agentId) };
  }

  /** @returns {Set<string>} 当前断开的后端 id（provider 失败视作全部启用）。 */
  _disabledSet() {
    if (!this._getDisabledIds) return new Set();
    try {
      const ids = this._getDisabledIds();
      const disabled = new Set();
      for (const id of Array.isArray(ids) ? ids : []) {
        const backend = this.backends.get(id);
        if (!backend) continue;
        try {
          const descriptor = typeof backend.getBackendDescriptor === "function"
            ? backend.getBackendDescriptor()
            : null;
          // Respect the same connection policy for native and external backends.
          // Legacy adapters without descriptors also honor disabledBackends.
          if (descriptor?.disconnectable !== false) disabled.add(id);
        } catch {
          // An invalid descriptor cannot prove that a backend is built-in.
          disabled.add(id);
        }
      }
      return disabled;
    } catch {
      return new Set();
    }
  }

  /** 未被断开的后端列表——所有聚合/遍历的统一入口。 */
  _activeBackends() {
    const disabled = this._disabledSet();
    return [...this.backends.values()].filter((backend) => !disabled.has(backend.id));
  }

  /** 按 id 取后端；断开的视作不存在（数据面/管理面都不再触达它）。 */
  _activeGet(backendId) {
    const backend = this.backends.get(backendId);
    if (!backend || this._disabledSet().has(backend.id)) return null;
    return backend;
  }

  /**
   * 公开的按-后端-id 取用入口（REST 层用）。route(agentId) 是常规寻址；这个是
   * 给「与在线状态无关的静态属性」用的，比如聊天面能力：后端离线时不认领自己的
   * agent，但它的传输能接什么附件并不因此改变。
   * @param {string} backendId
   * @returns {import('./agent-backend').AgentBackend|null}
   */
  getBackend(backendId) {
    return this._activeGet(backendId);
  }

  /**
   * Static descriptors for every registered backend, including disabled ones.
   * A broken descriptor is omitted rather than sinking the remaining cards.
   * @returns {Array<object>}
   */
  listBackendDescriptors() {
    const rows = [];
    for (const backend of this.backends.values()) {
      try {
        const descriptor = backend.getBackendDescriptor();
        if (!descriptor || descriptor.id !== backend.id || descriptor.name !== backend.name) {
          throw new Error("descriptor identity mismatch");
        }
        rows.push(structuredClone(descriptor));
      } catch (err) {
        console.error(`[registry] ${backend.id} getBackendDescriptor failed:`, err?.message || err);
      }
    }
    return rows;
  }

  /**
   * Register a backend. Must be called before start().
   * @param {import('./agent-backend').AgentBackend} backend
   */
  register(backend) {
    if (!backend || !backend.id) {
      throw new Error("BackendRegistry: backend must have an id");
    }
    if (this.backends.has(backend.id)) {
      throw new Error(`BackendRegistry: duplicate backend id "${backend.id}"`);
    }
    this.backends.set(backend.id, backend);
    if (["openclaw", "hermes"].includes(backend.id) && typeof backend.setInspirationOwner === "function") {
      backend.setInspirationOwner(this._inspirationOwner);
    }
    if (this._dashboardJournal && typeof backend.attachDashboardJournal === "function") {
      try { backend.attachDashboardJournal(this._dashboardJournal); } catch { /* 可选能力 */ }
    }
    console.log(`[registry] registered backend: ${backend.id}`);
  }

  /**
   * Dashboard journal 注入（健康事件 + Hermes kanban cursor/事件留存）。
   * registry 持有它做健康采样，并下发给每个后端（含之后 register 的）。
   */
  attachDashboardJournal(journal) {
    this._dashboardJournal = journal || null;
    for (const backend of this.backends.values()) {
      if (typeof backend.attachDashboardJournal === "function") {
        try { backend.attachDashboardJournal(journal); } catch { /* 可选能力 */ }
      }
    }
  }

  /** App-owned logical Kanban projects and task-to-project bindings. */
  attachKanbanProjectStore(store) {
    this._kanbanProjectStore = store || null;
  }

  /**
   * 健康采样一轮：聚合所有后端 getHealthTargets()（单个失败跳过，铁律 4），
   * 写入 journal（抗抖动/首异常/断连/恢复语义在 journal 内）。
   * @returns {Promise<Array<object>>} 本轮落下的健康事件
   */
  async sampleDashboardHealthOnce() {
    if (!this._dashboardJournal) return [];
    const targets = [];
    await Promise.all(
      this._activeBackends().map(async (backend) => {
        try {
          const list = await backend.getHealthTargets();
          for (const t of Array.isArray(list) ? list : []) targets.push(t);
        } catch (err) {
          console.error(`[registry] ${backend.id} getHealthTargets failed:`, err?.message || err);
        }
      }),
    );
    return this._dashboardJournal.recordHealthSample(targets, { atMs: Date.now() });
  }

  /** 45s 健康采样定时器（启动即采一轮）；stop() 清理。 */
  startDashboardHealthSampler({ intervalMs = 45000 } = {}) {
    if (this._healthSamplerTimer) return;
    const tick = () => { this.sampleDashboardHealthOnce().catch(() => { /* 采样绝不抛 */ }); };
    tick();
    this._healthSamplerTimer = setInterval(tick, intervalMs);
    if (typeof this._healthSamplerTimer.unref === "function") this._healthSamplerTimer.unref();
  }

  stopDashboardHealthSampler() {
    if (this._healthSamplerTimer) {
      clearInterval(this._healthSamplerTimer);
      this._healthSamplerTimer = null;
    }
  }

  /**
   * Start all enabled backends, or reconnect one with the same event hooks.
   * Backends start in parallel; a failing backend doesn't block others.
   * @param {string} [backendId]
   * @returns {Promise<Map<string, boolean>>}
   */
  async start(backendId) {
    const results = new Map();
    const backends = backendId === undefined ? this._activeBackends() : [this._activeGet(backendId)].filter(Boolean);
    await Promise.all(
      backends.map(async (backend) => {
        // 分阶段启动的后端（Hermes 每 profile 一个 dashboard 进程）每就绪一批就
        // 广播一次，别让 UI 陪最慢的那个等到底。事件形状与最终那次完全一致，
        // 消费端（proxy→agents.changed）本就是幂等重拉，无需区分。
        let lastReadyAgentIds = null;
        const emitReady = () => {
          const agentIds = failSoftSyncRows(backend, "getAgents")
            .map((agent) => agent?.id)
            .filter(Boolean);
          lastReadyAgentIds = JSON.stringify(agentIds);
          this.emit("backend.ready", {
            backendId: backend.id,
            name: backend.name,
            agentIds,
          });
        };
        const emitSessionActivity = (activity) => {
          const agentIds = failSoftSyncRows(backend, "getAgents")
            .map((agent) => agent?.id)
            .filter(Boolean);
          this.emit("backend.sessionActivity", {
            backendId: backend.id,
            name: backend.name,
            agentIds,
            activity,
          });
        };
        try {
          const ok = await backend.start({
            onPartialReady: emitReady,
            onSessionActivity: emitSessionActivity,
          });
          results.set(backend.id, ok);
          console.log(`[registry] ${backend.id}: ${ok ? "ready" : "unavailable"}`);
          // 后端异步 ready 后主动通知上层。UI 首轮 agents.list 可能早于
          // Hermes 等慢启动后端完成，事件让 proxy 可以触发一次轻量刷新。
          const finalAgentIds = JSON.stringify(
            failSoftSyncRows(backend, "getAgents").map((agent) => agent?.id).filter(Boolean),
          );
          if (ok && finalAgentIds !== lastReadyAgentIds) emitReady();
        } catch (err) {
          results.set(backend.id, false);
          console.error(`[registry] ${backend.id} start failed:`, err);
        }
      }),
    );
    return results;
  }

  /**
   * Stop all backends. `opts` is passed through verbatim (see AgentBackend.stop —
   * `keepProcesses` on the normal-quit path lets a backend leave its spawned
   * child processes running for the next launch to claim).
   * @param {{keepProcesses?: boolean}} [opts]
   * @returns {Promise<void>}
   */
  async stop(opts) {
    this.stopDashboardHealthSampler();
    await Promise.all(
      [...this.backends.values()].map(async (backend) => {
        try {
          await backend.stop(opts);
        } catch {
          /* best-effort */
        }
      }),
    );
    this.backends.clear();
  }

  /**
   * Find the backend that owns the given agentId.
   * @param {string} agentId
   * @returns {import('./agent-backend').AgentBackend|null}
   */
  route(agentId) {
    if (!agentId) return null;
    for (const backend of this._activeBackends()) {
      const owned = failSoftSyncCall(backend, "ownsAgentId", agentId);
      if (owned.ok && owned.value === true) return backend;
    }
    return null;
  }

  /**
   * 是否有已注册后端「声称」这个 agentId 属于它的静态命名空间——独立于就绪状态
   * （见 agent-backend.claimsAgentId）。proxy 用它在启动竞态窗口正确归属：foreign
   * 命名空间的 session-write 绝不透传给上游网关（防孤儿），上游返回的同名行要滤掉。
   * 注意用 this.backends 全量而非 _activeBackends：一个刚 disable 的后端，它命名空间
   * 里的写仍不该漏给别的后端的网关。
   * @param {string} agentId
   * @returns {boolean}
   */
  claimsAgentId(agentId) {
    if (!agentId) return false;
    for (const backend of this.backends.values()) {
      const claimed = failSoftSyncCall(backend, "claimsAgentId", agentId);
      if (claimed.ok && claimed.value === true) return true;
    }
    return false;
  }

  /**
   * Aggregate agents from all backends.
   * @returns {Array<{id: string, name: string, model?: string, fallbacks?: string[]}>}
   */
  aggregateAgents() {
    const agents = [];
    for (const backend of this._activeBackends()) {
      for (const agent of failSoftSyncRows(backend, "getAgents")) {
        agents.push(agent);
      }
    }
    return agents;
  }

  /**
   * Aggregate model choices from all backends, deduplicating by id.
   * @returns {Array<{id: string, name: string, provider: string}>}
   */
  aggregateModels() {
    const seen = new Set();
    const models = [];
    for (const backend of this._activeBackends()) {
      for (const choice of failSoftSyncRows(backend, "getModelChoices")) {
        if (choice && choice.id && !seen.has(choice.id)) {
          seen.add(choice.id);
          models.push(choice);
        }
      }
    }
    return models;
  }

  /**
   * 快速读取某后端的聊天历史缓存隔离摘要。只允许 active backend，且只转发
   * 固定长度 SHA-256；后端异常或未声明能力都 fail closed。
   * @param {string} backendId
   * @returns {{backendId: string, cacheScope: string}|null}
   */
  getChatCacheScope(backendId) {
    const backend = this._activeGet(backendId);
    if (!backend || typeof backend.getChatCacheScope !== "function") return null;
    try {
      const cacheScope = backend.getChatCacheScope();
      if (typeof cacheScope !== "string" || !/^[0-9a-f]{64}$/.test(cacheScope)) return null;
      return { backendId: backend.id, cacheScope };
    } catch (err) {
      console.error(`[registry] ${backendId} getChatCacheScope failed:`, err?.message || err);
      return null;
    }
  }

  /**
   * Route a browser widget document to one active backend and close its result
   * before static-server emits bytes. A broken backend cannot inject headers or
   * expose raw upstream errors through the loopback origin.
   */
  async fetchWidgetResource(backendId, resourcePath, options = {}) {
    const backend = this._activeGet(backendId);
    if (!backend) return { supported: false, reason: "unknown-backend" };
    if (typeof backend.fetchWidgetResource !== "function") {
      return { supported: false, reason: "unsupported" };
    }
    try {
      return projectWidgetResourceResult(
        await backend.fetchWidgetResource(resourcePath, options),
        options.method,
      );
    } catch (err) {
      console.error(`[registry] ${backendId} fetchWidgetResource failed:`, err?.message || err);
      return { supported: true, ok: false, reason: "upstream-error" };
    }
  }

  async listEnvironments(backendId) {
    const backend = this._activeGet(backendId);
    if (!backend) {
      return {
        ...unsupportedAdvancedSessionResult("unknown-backend"),
        environments: [],
        profiles: [],
      };
    }
    try {
      const result = await backend.listEnvironments();
      if (result?.supported !== true) {
        return {
          ...unsupportedAdvancedSessionResult(advancedSessionFailureReason(result?.reason), result?.methods),
          environments: [],
          profiles: [],
        };
      }
      return projectEnvironmentInventory(result, result.methods);
    } catch (err) {
      console.error(`[registry] ${backendId} listEnvironments failed:`, err?.message || err);
      return { ...unsupportedAdvancedSessionResult("error"), environments: [], profiles: [] };
    }
  }

  async describeSession(backendId, agentId, sessionKey) {
    const backend = this._activeGet(backendId);
    if (!backend) return { ...unsupportedAdvancedSessionResult("unknown-backend"), session: null };
    try {
      const result = await backend.describeSession(agentId, sessionKey);
      if (result?.supported !== true) {
        return {
          ...unsupportedAdvancedSessionResult(advancedSessionFailureReason(result?.reason), result?.methods),
          session: null,
        };
      }
      return projectSessionDescribeResult(result, result.methods);
    } catch (err) {
      console.error(`[registry] ${backendId} describeSession failed:`, err?.message || err);
      return { ...unsupportedAdvancedSessionResult("error"), session: null };
    }
  }

  async listSessionArtifacts(backendId, agentId, sessionKey, opts = {}) {
    const backend = this._activeGet(backendId);
    if (!backend) return { supported: false, reason: "unknown-backend", items: [] };
    try {
      const result = await backend.listSessionArtifacts(agentId, sessionKey, opts);
      return result && Array.isArray(result.items)
        ? result
        : { supported: false, reason: "error", items: [] };
    } catch (err) {
      console.error(`[registry] ${backendId} listSessionArtifacts failed:`, err?.message || err);
      return { supported: false, reason: "error", items: [] };
    }
  }

  async listSessionBranches(backendId, agentId, sessionKey) {
    const backend = this._activeGet(backendId);
    if (!backend) return { ...unsupportedAdvancedSessionResult("unknown-backend"), branches: [] };
    try {
      const result = await backend.listSessionBranches(agentId, sessionKey);
      if (result?.supported !== true) {
        return {
          ...unsupportedAdvancedSessionResult(advancedSessionFailureReason(result?.reason), result?.methods),
          branches: [],
        };
      }
      return projectSessionBranchesResult(result, result.methods);
    } catch (err) {
      console.error(`[registry] ${backendId} listSessionBranches failed:`, err?.message || err);
      return { ...unsupportedAdvancedSessionResult("error"), branches: [] };
    }
  }

  async forkSessionAtEntry(backendId, agentId, sessionKey, entryId) {
    const backend = this._activeGet(backendId);
    if (!backend) return unsupportedAdvancedSessionResult("unknown-backend");
    try {
      const result = await backend.forkSessionAtEntry(agentId, sessionKey, entryId);
      if (result?.supported !== true) {
        return unsupportedAdvancedSessionResult(
          advancedSessionFailureReason(result?.reason),
          result?.methods,
        );
      }
      return projectSessionForkResult(result, result.methods);
    } catch (err) {
      console.error(`[registry] ${backendId} forkSessionAtEntry failed:`, err?.message || err);
      return unsupportedAdvancedSessionResult("error");
    }
  }

  async getSessionBoard(backendId, agentId, sessionKey) {
    const backend = this._activeGet(backendId);
    if (!backend) return unsupportedSessionBoardResult("unknown-backend");
    const safeAgentId = normalizeSessionBoardAgentId(agentId);
    const safeSessionKey = normalizeSessionBoardSessionKey(sessionKey);
    if (!safeAgentId || !safeSessionKey) return unsupportedSessionBoardResult("invalid-request");
    try {
      return projectSessionBoardEnvelope(
        await backend.getSessionBoard(safeAgentId, safeSessionKey),
        safeSessionKey,
      );
    } catch {
      console.error(`[registry] ${backendId} getSessionBoard failed`);
      return unsupportedSessionBoardResult("error");
    }
  }

  /**
   * Trusted-main-process only. No static-server route may expose the returned
   * HTML bytes or upstream Board authority to the loopback management plane.
   */
  async fetchSessionBoardHtmlWidget(backendId, agentId, sessionKey, spec) {
    const backend = this._activeGet(backendId);
    if (!backend) return { supported: false, reason: "unknown-backend" };
    const safeAgentId = normalizeSessionBoardAgentId(agentId);
    const safeSessionKey = normalizeSessionBoardSessionKey(sessionKey);
    const safeSpec = normalizeSessionBoardHtmlWidgetSpec(spec);
    if (!safeAgentId || !safeSessionKey || !safeSpec) {
      return { supported: false, reason: "invalid-request" };
    }
    if (typeof backend.fetchSessionBoardHtmlWidget !== "function") {
      return { supported: false, reason: "unsupported" };
    }
    let result = null;
    try {
      result = await backend.fetchSessionBoardHtmlWidget(safeAgentId, safeSessionKey, safeSpec);
      return projectSessionBoardHtmlWidgetResult(result, safeSpec);
    } catch {
      console.error(`[registry] ${backend.id} fetchSessionBoardHtmlWidget failed`);
      return { supported: true, ok: false, reason: "upstream-error" };
    } finally {
      // Projection owns a copy; do not retain the backend's raw HTML buffer
      // beyond this trusted-main boundary.
      if (Buffer.isBuffer(result?.html)) result.html.fill(0);
    }
  }

  async updateSessionBoard(backendId, agentId, sessionKey, ops) {
    const backend = this._activeGet(backendId);
    if (!backend) return unsupportedSessionBoardResult("unknown-backend");
    const safeAgentId = normalizeSessionBoardAgentId(agentId);
    const safeSessionKey = normalizeSessionBoardSessionKey(sessionKey);
    const normalized = normalizeSessionBoardOps(ops);
    if (!safeAgentId || !safeSessionKey || !normalized) {
      return unsupportedSessionBoardResult("invalid-request");
    }
    try {
      return projectSessionBoardEnvelope(
        await backend.updateSessionBoard(safeAgentId, safeSessionKey, normalized),
        safeSessionKey,
      );
    } catch {
      console.error(`[registry] ${backendId} updateSessionBoard failed`);
      return unsupportedSessionBoardResult("error");
    }
  }

  async pinSessionBoardCanvas(backendId, agentId, sessionKey, spec) {
    const backend = this._activeGet(backendId);
    if (!backend) return unsupportedSessionBoardResult("unknown-backend");
    const safeAgentId = normalizeSessionBoardAgentId(agentId);
    const safeSessionKey = normalizeSessionBoardSessionKey(sessionKey);
    const normalized = normalizeSessionBoardCanvasSpec(spec);
    if (!safeAgentId || !safeSessionKey || !normalized) {
      return unsupportedSessionBoardResult("invalid-request");
    }
    try {
      return projectSessionBoardEnvelope(
        await backend.pinSessionBoardCanvas(safeAgentId, safeSessionKey, normalized),
        safeSessionKey,
      );
    } catch {
      console.error(`[registry] ${backendId} pinSessionBoardCanvas failed`);
      return unsupportedSessionBoardResult("error");
    }
  }

  async decideSessionBoardWidgetGrant(backendId, agentId, sessionKey, spec) {
    const backend = this._activeGet(backendId);
    if (!backend) return unsupportedSessionBoardResult("unknown-backend");
    const safeAgentId = normalizeSessionBoardAgentId(agentId);
    const safeSessionKey = normalizeSessionBoardSessionKey(sessionKey);
    const normalized = normalizeSessionBoardGrantSpec(spec);
    if (!safeAgentId || !safeSessionKey || !normalized) {
      return unsupportedSessionBoardResult("invalid-request");
    }
    try {
      return projectSessionBoardEnvelope(
        await backend.decideSessionBoardWidgetGrant(safeAgentId, safeSessionKey, normalized),
        safeSessionKey,
      );
    } catch {
      console.error(`[registry] ${backendId} decideSessionBoardWidgetGrant failed`);
      return unsupportedSessionBoardResult("error");
    }
  }

  /**
   * Full model catalog (UnifiedModel[]) for the 模型 page. With a backendId,
   * returns just that backend's models; otherwise merges all. A failing/slow
   * backend contributes nothing rather than sinking the response.
   * @param {string} [backendId]
   * @returns {Promise<Array<object>>}
   */
  async listModels(backendId) {
    const targets = backendId
      ? [this._activeGet(backendId)].filter(Boolean)
      : this._activeBackends();
    const all = [];
    await Promise.all(
      targets.map(async (backend) => {
        try {
          const models = await backend.getModels();
          if (Array.isArray(models)) all.push(...models);
        } catch (err) {
          console.error(`[registry] ${backend.id} getModels failed:`, err?.message || err);
        }
      }),
    );
    return all;
  }

  /**
   * 读取模型页所需的 fresh 双来源快照，并生成内容寻址 revision。
   * 显式后端失败直接抛出；聚合模式保持既有 fail-soft 语义。
   * @param {string} [backendId]
   * @param {{fresh?: boolean}} [options]
   * @returns {Promise<{models: Array<object>, config: Array<object>, runtime: Array<object>, catalogRevision: string}>}
   */
  async listModelsSnapshot(backendId, { fresh = true } = {}) {
    // 单后端读取不得走 listModels 的吞错路径，否则 fresh 失败会伪装成空成功。
    if (backendId) {
      // 显式读取同样只允许 active backend；断开后不能触达其管理面 sources。
      const backend = this._activeGet(backendId);
      if (!backend) {
        const error = new Error(`unknown backend ${backendId}`);
        error.code = "ERR_UNKNOWN_BACKEND";
        error.statusCode = 404;
        throw error;
      }
      const sources = await backend.getModelCatalogSources({ fresh });
      const models = normalizedBackendRows(sources?.models, backend.id);
      const config = normalizedBackendRows(sources?.config, backend.id);
      const runtime = normalizedBackendRows(sources?.runtime, backend.id);
      return {
        models,
        config,
        runtime,
        catalogRevision: computeCatalogRevision({ backendId: backend.id, config, runtime }),
      };
    }

    // 先固定后端顺序，再并发拉取；这样响应和摘要都不受完成时序影响。
    const targets = this._activeBackends().sort((left, right) => left.id.localeCompare(right.id));
    const snapshots = await Promise.all(
      targets.map(async (backend) => {
        try {
          const sources = await backend.getModelCatalogSources({ fresh });
          return {
            models: normalizedBackendRows(sources?.models, backend.id),
            config: normalizedBackendRows(sources?.config, backend.id),
            runtime: normalizedBackendRows(sources?.runtime, backend.id),
          };
        } catch (err) {
          console.error(
            `[registry] ${backend.id} getModelCatalogSources failed:`,
            err?.message || err,
          );
          return null;
        }
      }),
    );
    const models = normalizeCatalogRows(snapshots.flatMap((snapshot) => snapshot?.models || []));
    const config = normalizeCatalogRows(snapshots.flatMap((snapshot) => snapshot?.config || []));
    const runtime = normalizeCatalogRows(snapshots.flatMap((snapshot) => snapshot?.runtime || []));
    return {
      models,
      config,
      runtime,
      catalogRevision: computeCatalogRevision({ backendId: "all", config, runtime }),
    };
  }

  /**
   * Token-usage daily series for one backend (the token dashboard curve).
   * @param {string} backendId
   * @param {string} [range]
   * @returns {Promise<object|null>}
   */
  async getUsageSeries(backendId, range) {
    const backend = this._activeGet(backendId);
    if (!backend) return null;
    try {
      return await backend.getUsageSeries(range);
    } catch (err) {
      console.error(`[registry] ${backendId} getUsageSeries failed:`, err?.message || err);
      return null;
    }
  }

  /**
   * Token-usage rankings for one backend (the token dashboard breakdown).
   * @param {string} backendId
   * @param {string} [range]
   * @returns {Promise<object|null>}
   */
  async getUsageBreakdown(backendId, range) {
    const backend = this._activeGet(backendId);
    if (!backend) return null;
    try {
      return await backend.getUsageBreakdown(range);
    } catch (err) {
      console.error(`[registry] ${backendId} getUsageBreakdown failed:`, err?.message || err);
      return null;
    }
  }

  /**
   * Skills (UnifiedSkill[]) for one backend (the Skills tab, read-only).
   * @param {string} backendId
   * @returns {Promise<Array<object>>}
   */
  async listSkills(backendId, opts = {}) {
    const backend = this._activeGet(backendId);
    if (!backend) return [];
    try {
      return await backend.getSkills(opts);
    } catch (err) {
      console.error(`[registry] ${backendId} getSkills failed:`, err?.message || err);
      return [];
    }
  }

  /**
   * Aggregate per-backend CLI command usage for the CLI page overlay. Each
   * entry: { backend, supported, reason?, commands }. A failing/unsupported
   * backend degrades to an unsupported entry rather than sinking the response.
   * @returns {Promise<Array<{backend: string, supported: boolean, reason?: string, commands: Record<string, Record<string, number>>, scanLimit?: number}>>}
   */
  async listCliUsage() {
    const out = [];
    await Promise.all(
      this._activeBackends().map(async (backend) => {
        try {
          const u = await backend.getCliUsage();
          out.push({
            backend: backend.id,
            supported: !!(u && u.supported),
            reason: u && u.reason,
            commands: (u && u.commands) || {},
            scanLimit: u && u.scanLimit,
          });
        } catch (err) {
          console.error(`[registry] ${backend.id} getCliUsage failed:`, err?.message || err);
          out.push({ backend: backend.id, supported: false, reason: "error", commands: {} });
        }
      }),
    );
    return out;
  }

  /**
   * Aggregate per-backend SKILL usage for the Skills page overlay. Same
   * fail-soft contract as listCliUsage: a failing/unsupported backend degrades
   * to an unsupported entry instead of sinking the response (铁律 4).
   * @returns {Promise<Array<{backend: string, supported: boolean, reason?: string, skills: Record<string, Record<string, number>>, scanLimit?: number}>>}
   */
  async listSkillUsage() {
    const out = [];
    await Promise.all(
      this._activeBackends().map(async (backend) => {
        try {
          const u = await backend.getSkillUsage();
          out.push({
            backend: backend.id,
            supported: !!(u && u.supported),
            reason: u && u.reason,
            skills: (u && u.skills) || {},
            scanLimit: u && u.scanLimit,
          });
        } catch (err) {
          console.error(`[registry] ${backend.id} getSkillUsage failed:`, err?.message || err);
          out.push({ backend: backend.id, supported: false, reason: "error", skills: {} });
        }
      }),
    );
    return out;
  }

  /**
   * Kanban board (one backend) for the tasks page. Each backend has its own
   * columns, so this is a per-backend fetch (tab-switch), not a merge.
   * @param {string} backendId
   * @returns {Promise<{columns: Array<object>}>}
   */
  async getTaskBoard(backendId, opts) {
    const backend = this._activeGet(backendId);
    if (!backend) return { columns: [] };
    try {
      return await backend.getTaskBoard(opts);
    } catch (err) {
      console.error(`[registry] ${backendId} getTaskBoard failed:`, err?.message || err);
      return { columns: [] };
    }
  }

  _kanbanBackends() {
    const descriptors = new Map(this.listBackendDescriptors().map((row) => [row.id, row]));
    return this._activeBackends().flatMap((backend) => {
      const descriptor = descriptors.get(backend.id);
      const kind = descriptor?.surfaces?.kanban?.kind;
      return kind ? [{ backend, kind, name: descriptor.name }] : [];
    });
  }

  /**
   * One logical project, projected across every Kanban-capable backend.
   * Reads fail softly per backend; task identities remain backend-qualified.
   */
  async getFederatedKanban(opts = {}) {
    const errors = [];
    const targets = this._kanbanBackends();
    const snapshots = await Promise.all(targets.map(async (target) => {
      let boards = [];
      let agents = [];
      let workboard = null;
      await Promise.all([
        Promise.resolve().then(() => target.backend.listAgents()).then((rows) => {
          agents = Array.isArray(rows) ? rows : [];
        }).catch((err) => {
          errors.push({ backendId: target.backend.id, stage: "agents", error: err?.message || String(err) });
        }),
        target.kind === "workboard"
          ? Promise.resolve().then(() => target.backend.getTaskBoard({ includeArchived: true, readOnly: true })).then((board) => {
              workboard = board && typeof board === "object" ? board : { columns: [] };
            }).catch((err) => {
              errors.push({ backendId: target.backend.id, stage: "board", error: err?.message || String(err) });
              workboard = { columns: [] };
            })
          : Promise.resolve().then(() => target.backend.getBoards()).then((rows) => {
              boards = Array.isArray(rows) ? rows : [];
            }).catch((err) => {
              errors.push({ backendId: target.backend.id, stage: "boards", error: err?.message || String(err) });
            }),
      ]);
      return { ...target, boards, agents, workboard };
    }));

    const projectRows = [];
    for (const snapshot of snapshots) {
      if (snapshot.kind === "workboard") {
        const counts = new Map();
        const tasks = (snapshot.workboard?.columns || []).flatMap((column) => column.tasks || []);
        for (const task of tasks) {
          const stored = this._kanbanProjectStore?.projectForTask(snapshot.backend.id, task.id);
          const key = taskProjectKey(task, stored);
          counts.set(key, (counts.get(key) || 0) + 1);
        }
        if (counts.size === 0) counts.set("default", 0);
        for (const [key, total] of counts) {
          projectRows.push({
            backendId: snapshot.backend.id,
            backendName: snapshot.name,
            kind: snapshot.kind,
            boardId: key,
            slug: key,
            projectKey: key,
            name: key === "default" ? "Default" : key,
            total,
          });
        }
        continue;
      }
      for (const board of snapshot.boards) {
        projectRows.push({
          backendId: snapshot.backend.id,
          backendName: snapshot.name,
          kind: snapshot.kind,
          boardId: board.id || board.slug,
          slug: board.slug || board.id,
          projectKey: normalizeProjectKey(board.projectKey || board.slug || board.id),
          name: board.name || board.slug || board.id,
          description: board.description || undefined,
          agentId: board.agentId || undefined,
          profileId: board.profileId || undefined,
          total: Number(board.total || 0),
        });
      }
    }

    const customProjects = this._kanbanProjectStore?.listProjects() || [];
    let projects = mergeProjectRows(projectRows, customProjects);
    if (projects.length === 0) {
      projects = mergeProjectRows([], [{ key: "default", name: "Default" }]);
    }
    const requestedKey = normalizeProjectKey(opts.project || "default");
    const selected = projects.find((project) => project.key === requestedKey)
      || projects.find((project) => project.key === "default")
      || projects[0];
    const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.backend.id, snapshot]));
    const taskRows = [];
    const selectedSources = [];

    await Promise.all(selected.sources.map(async (source) => {
      const snapshot = snapshotById.get(source.backendId);
      if (!snapshot) return;
      let board = snapshot.workboard;
      if (snapshot.kind !== "workboard") {
        const boardSelector = snapshot.kind === "native" ? source.boardId : source.slug;
        try {
          board = await snapshot.backend.getTaskBoard({
            includeArchived: true,
            board: boardSelector,
            readOnly: true,
          });
        } catch (err) {
          errors.push({ backendId: source.backendId, stage: "board", error: err?.message || String(err) });
          return;
        }
      }
      const sourceWithCapabilities = { ...source, capabilities: board?.capabilities || {} };
      selectedSources.push(sourceWithCapabilities);
      for (const task of (board?.columns || []).flatMap((column) => column.tasks || [])) {
        const stored = this._kanbanProjectStore?.projectForTask(source.backendId, task.id);
        if (snapshot.kind === "workboard" && taskProjectKey(task, stored) !== selected.key) continue;
        taskRows.push(normalizeFederatedTask(task, sourceWithCapabilities, stored));
      }
    }));

    const agents = snapshots.flatMap((snapshot) => snapshot.agents.map((agent) => ({
      ...agent,
      backendId: snapshot.backend.id,
      backendName: snapshot.name,
      sourceKind: snapshot.kind,
      agentKey: agentIdentity(snapshot.backend.id, agent.id),
    })));
    const columns = buildCanonicalColumns(taskRows);
    const total = taskRows.length;
    const selectedProject = { ...selected, total, sources: selectedSources };
    projects = projects.map((project) => project.key === selected.key ? selectedProject : project);
    return {
      project: selectedProject,
      projects,
      columns,
      agents,
      errors,
    };
  }

  createFederatedKanbanProject(spec = {}) {
    if (!this._kanbanProjectStore) throw new Error("Kanban project store unavailable");
    const name = String(spec.name || "").trim();
    if (!name) throw new Error("项目名称不能为空");
    return this._kanbanProjectStore.upsertProject({
      slug: spec.slug || name,
      name,
      description: spec.description,
    });
  }

  async deleteFederatedKanbanProject(project) {
    if (!this._kanbanProjectStore) throw new Error("Kanban project store unavailable");
    const key = normalizeProjectKey(project, "");
    if (!key) throw new Error("project key is required");
    if (key === "default") throw new Error("Default 项目不能删除");

    const board = await this.getFederatedKanban({ project: key });
    if (board.project.key !== key) throw new Error(`项目 ${key} 不存在`);
    const unavailable = board.errors.filter((error) => ["board", "boards"].includes(error.stage));
    if (unavailable.length > 0) {
      const backends = [...new Set(unavailable.map((error) => error.backendId))];
      throw new Error(`${backends.join("、")} 当前不可用；未删除任何后端数据`);
    }
    const unsupported = board.project.sources.filter((source) => !["workboard", "hermes"].includes(source.kind));
    if (unsupported.length > 0) {
      const backends = [...new Set(unsupported.map((source) => source.backendName || source.backendId))];
      throw new Error(`${backends.join("、")} 不支持永久删除项目；未删除任何后端数据`);
    }

    const targetById = new Map(this._kanbanBackends().map((target) => [target.backend.id, target]));
    const tasks = board.columns.flatMap((column) => column.tasks || []);
    const operations = [];
    for (const source of board.project.sources) {
      const target = targetById.get(source.backendId);
      if (!target) throw new Error(`${source.backendName || source.backendId} 当前不可用；未删除任何后端数据`);
      if (source.kind === "workboard") {
        for (const task of tasks.filter((row) => row.backendId === source.backendId)) {
          operations.push({
            type: "task",
            backendName: source.backendName || source.backendId,
            run: () => target.backend.deleteTask(task.id),
          });
        }
        continue;
      }
      const selector = source.slug || source.boardId;
      if (!selector) throw new Error(`${source.backendName || source.backendId} 项目缺少看板标识；未删除任何后端数据`);
      operations.push({
        type: "board",
        backendName: source.backendName || source.backendId,
        run: () => target.backend.deleteBoard(selector, true),
      });
    }

    const results = await Promise.allSettled(operations.map((operation) => operation.run()));
    const failed = results.flatMap((result, index) => (
      result.status === "rejected" ? [operations[index].backendName] : []
    ));
    if (failed.length > 0) {
      throw new Error(`项目后端数据删除部分失败（${[...new Set(failed)].join("、")}）；本地项目记录已保留，请刷新后重试`);
    }

    this._kanbanProjectStore.deleteProject(key);
    return {
      key,
      deletedTasks: operations.filter((operation) => operation.type === "task").length,
      deletedBoards: operations.filter((operation) => operation.type === "board").length,
    };
  }

  async createFederatedTask(project, agentKey, spec = {}) {
    const projectKey = normalizeProjectKey(project);
    const identity = parseAgentIdentity(agentKey);
    if (!identity) throw new Error("请选择执行 Agent");
    const target = this._kanbanBackends().find((row) => row.backend.id === identity.backendId);
    if (!target) throw new Error(`unknown Kanban backend ${identity.backendId}`);
    const agents = await target.backend.listAgents();
    const agent = (Array.isArray(agents) ? agents : []).find((row) => row.id === identity.agentId);
    if (!agent) throw new Error(`unknown Agent ${identity.agentId}`);
    const title = String(spec.title || "").trim();
    if (!title) throw new Error("任务标题不能为空");
    const canonical = String(spec.status || spec.column || "triage");
    if (!nativeTargetForCanonical(target.kind, canonical, "todo")) {
      throw new Error(`不支持的目标状态 ${canonical}`);
    }

    const storedProject = this._kanbanProjectStore?.listProjects()
      .find((row) => row.key === projectKey);
    let boardSelector;
    if (target.kind !== "workboard") {
      const boards = await target.backend.getBoards();
      let board = (Array.isArray(boards) ? boards : []).find((row) => (
        normalizeProjectKey(row.projectKey || row.slug || row.id) === projectKey
        && (target.kind !== "native" || row.agentId === identity.agentId)
      ));
      if (!board) {
        board = await target.backend.createBoard({
          slug: projectKey,
          name: storedProject?.name || projectKey,
          description: storedProject?.description,
          ...(target.kind === "native" ? { agentId: identity.agentId } : { switch: false }),
        });
      }
      boardSelector = target.kind === "native" ? (board.id || board.slug) : board.slug;
    }

    let created;
    if (target.kind === "workboard") {
      const status = canonical === "archived" ? "todo"
        : nativeTargetForCanonical(target.kind, canonical, "blocked")?.status || "todo";
      created = await target.backend.createTask({ ...spec, title, status, agentId: identity.agentId });
      if (canonical === "archived") await target.backend.archiveTask(created.id, true);
    } else if (target.kind === "hermes") {
      const status = canonical === "archived" || canonical === "done" ? "todo"
        : nativeTargetForCanonical(target.kind, canonical, "blocked")?.status || "todo";
      created = await target.backend.createTask({
        ...spec,
        title,
        status,
        triage: status === "triage",
        assignee: agent.kanbanAssignee,
      }, { board: boardSelector });
      if (canonical === "archived") await target.backend.archiveTask(created.id, true, { board: boardSelector });
      if (canonical === "done") {
        const summary = String(spec.summary || spec.body || title);
        created = await target.backend.moveTask(created.id, "done", undefined, {
          board: boardSelector,
          result: summary,
          summary,
        });
      }
    } else {
      created = await target.backend.createTask({
        board: boardSelector,
        agentId: identity.agentId,
        title,
        body: spec.body,
        status: canonical === "triage" ? "triage" : "backlog",
      });
      if (canonical === "blocked") {
        await target.backend.moveTask(created.id, "queued", undefined);
        created = await target.backend.moveTask(created.id, "waiting", undefined);
      } else if (canonical === "done") {
        created = await target.backend.moveTask(created.id, "done", undefined, {
          note: spec.summary || spec.body,
        });
      } else if (canonical === "archived") {
        created = await target.backend.archiveTask(created.id, true);
      }
    }
    this._kanbanProjectStore?.bindTask(target.backend.id, created.id, projectKey);
    return normalizeFederatedTask(created, {
      backendId: target.backend.id,
      backendName: target.name,
      kind: target.kind,
      boardId: boardSelector || projectKey,
      slug: projectKey,
      projectKey,
      agentId: identity.agentId,
    }, projectKey);
  }

  async moveFederatedTask(ref = {}, targetStatus, position, completion = {}) {
    const backendId = String(ref.backendId || "");
    const backendTarget = this._kanbanBackends().find((row) => row.backend.id === backendId);
    if (!backendTarget) throw new Error(`unknown Kanban backend ${backendId}`);
    const id = String(ref.id || "");
    if (!id) throw new Error("missing task id");
    const boardOpts = ref.sourceBoard ? { board: ref.sourceBoard } : undefined;
    let rawStatus = String(ref.rawStatus || "");
    if (!rawStatus) {
      const task = await backendTarget.backend.getTask(id, boardOpts);
      rawStatus = String(task?.column || task?.status || "");
    }
    const current = canonicalStatus(backendTarget.kind, rawStatus, ref);
    if (current === targetStatus) return { ok: true, unchanged: true };

    let nativeTarget = nativeTargetForCanonical(
      backendTarget.kind,
      targetStatus,
      rawStatus,
      ref,
    );
    if (!nativeTarget) throw new Error(`该后端无法移动到 ${targetStatus}`);
    if (nativeTarget.action === "unarchive") {
      const restored = await backendTarget.backend.archiveTask(id, false, boardOpts);
      rawStatus = String(restored?.rawStatus || restored?.column || restored?.status || rawStatus);
      // Re-resolve from the backend's authoritative restored status, without the
      // browser snapshot's stale archive marker.
      nativeTarget = nativeTargetForCanonical(backendTarget.kind, targetStatus, rawStatus, restored);
      if (!nativeTarget) throw new Error(`该后端无法移动到 ${targetStatus}`);
    }
    if (nativeTarget.action === "none") return { ok: true, unchanged: true };
    if (nativeTarget.action === "archive") {
      await backendTarget.backend.archiveTask(id, true, boardOpts);
      return { ok: true };
    }
    if (backendTarget.kind === "native" && nativeTarget.status === "waiting") {
      if (rawStatus === "triage") {
        await backendTarget.backend.moveTask(id, "backlog", undefined, boardOpts);
        rawStatus = "backlog";
      }
      if (rawStatus === "backlog") {
        await backendTarget.backend.moveTask(id, "queued", undefined, boardOpts);
        rawStatus = "queued";
      }
    }
    const moveOpts = { ...(boardOpts || {}) };
    if (typeof completion.result === "string") moveOpts.result = completion.result;
    if (typeof completion.summary === "string") moveOpts.summary = completion.summary;
    if (typeof completion.note === "string") moveOpts.note = completion.note;
    const task = await backendTarget.backend.moveTask(id, nativeTarget.status, position, moveOpts);
    return { ok: true, task };
  }

  /**
   * Rich agent list (one backend) for the 代理 page.
   * @param {string} backendId
   * @param {{lifecycle?: "active"|"archived"|"pending"|"all"}} [options]
   * @returns {Promise<Array<object>>}
   */
  async listAgents(backendId, options = {}) {
    const backend = this._activeGet(backendId);
    if (!backend) return [];
    try {
      return await backend.listAgents(options);
    } catch (err) {
      console.error(`[registry] ${backendId} listAgents failed:`, err?.message || err);
      return [];
    }
  }

  /**
   * Archived (sealed/rotated-out) transcript segments preceding a session's live
   * transcript — surfaces history the gateway reset away (one backend only).
   * @param {string} backendId
   * @param {string} agentId
   * @param {string} sessionKey
   * @returns {Promise<{supported: boolean, reason?: string, segments: Array<object>}>}
   */
  async getSessionArchive(backendId, agentId, sessionKey) {
    const backend = this._activeGet(backendId);
    if (!backend) return { supported: false, segments: [] };
    try {
      return await backend.getSessionArchive(agentId, sessionKey);
    } catch (err) {
      console.error(`[registry] ${backendId} getSessionArchive failed:`, err?.message || err);
      return { supported: false, segments: [] };
    }
  }

  /**
   * Usage Top 会话的 transcript 头部预览（「这个会话在聊什么」）。
   * Mirrors getSessionArchive's degrade-to-unsupported error handling (铁律4).
   * @param {string} backendId
   * @param {string} agentId
   * @param {string} sessionKey
   * @param {{sessionId?: string}} [opts]
   * @returns {Promise<{supported: boolean, reason?: string, title?: string, totalMessages?: number, truncated?: boolean, messages: Array<object>}>}
   */
  async getSessionPreview(backendId, agentId, sessionKey, opts) {
    const backend = this._activeGet(backendId);
    if (!backend) return { supported: false, reason: "unknown-backend", messages: [] };
    try {
      return await backend.getSessionPreview(agentId, sessionKey, opts);
    } catch (err) {
      console.error(`[registry] ${backendId} getSessionPreview failed:`, err?.message || err);
      return { supported: false, reason: "error", messages: [] };
    }
  }

  /**
   * Cross-session chat search for one agent (chat page "全部会话" scope).
   * Mirrors getSessionArchive's degrade-to-unsupported error handling (铁律4).
   * @param {string} backendId
   * @param {string} agentId
   * @param {string} query
   * @param {{limit?: number}} [opts]
   * @returns {Promise<{supported: boolean, reason?: string, results: Array<object>}>}
   */
  async searchChat(backendId, agentId, query, opts) {
    const backend = this._activeGet(backendId);
    if (!backend) return { supported: false, results: [] };
    try {
      return await backend.searchChat(agentId, query, opts);
    } catch (err) {
      console.error(`[registry] ${backendId} searchChat failed:`, err?.message || err);
      return { supported: false, results: [] };
    }
  }

  /**
   * Global chat search across every active backend and agent. The backend-level
   * primitive stays agent-scoped; aggregation belongs here so the renderer makes
   * one request and one broken/unsupported agent cannot sink healthy results.
   * @param {string} query
   * @param {{limit?: number, offset?: number}} [opts]
   * @returns {Promise<{query:string,offset:number,searchedAgents:number,unsupportedAgents:number,failedAgents:number,truncated:boolean,hasMore:boolean,nextOffset?:number,results:Array<object>}>}
   */
  async searchAllChat(query, opts = {}) {
    const q = String(query || "").trim().slice(0, 4096);
    const limit = Number(opts.limit) > 0 ? Math.min(Math.floor(Number(opts.limit)), 100) : 50;
    const offset = Number(opts.offset) >= 0 ? Math.min(Math.floor(Number(opts.offset)), 10000) : 0;
    if (!q) {
      return {
        query: "",
        offset,
        searchedAgents: 0,
        unsupportedAgents: 0,
        failedAgents: 0,
        truncated: false,
        hasMore: false,
        results: [],
      };
    }

    const targetGroups = await Promise.all(this._activeBackends().map(async (backend) => {
      const seen = new Set();
      let listed = [];
      try {
        const value = await backend.listAgents();
        if (Array.isArray(value)) listed = value;
        else console.error(`[registry] ${backend.id} listAgents returned a non-array result`);
      } catch (err) {
        console.error(`[registry] ${backend.id} listAgents for chat search failed:`, err?.message || err);
      }
      const targets = [];
      // listAgents is required for passthrough backends such as OpenClaw, whose
      // synchronous getAgents() intentionally injects no rows into the proxy.
      // Keep getAgents as a compatibility supplement for small test/adapters.
      for (const agent of [...listed, ...failSoftSyncRows(backend, "getAgents")]) {
        const agentId = typeof agent?.id === "string" ? agent.id.trim() : "";
        if (!agentId || seen.has(agentId)) continue;
        seen.add(agentId);
        targets.push({
          backend,
          agentId,
          agentName: typeof agent?.name === "string" && agent.name.trim() ? agent.name.trim() : agentId,
        });
      }
      return targets;
    }));
    const targets = targetGroups.flat();

    let searchedAgents = 0;
    let unsupportedAgents = 0;
    let failedAgents = 0;
    let truncated = false;
    const results = [];
    await Promise.all(targets.map(async ({ backend, agentId, agentName }) => {
      let search;
      try {
        // Fetch the same bounded candidate pool for every page. Varying this by
        // offset would let newly included candidates reorder earlier pages.
        // Individual backends keep their own stricter protocol caps.
        search = await backend.searchChat(agentId, q, { limit: 100 });
      } catch (err) {
        failedAgents += 1;
        console.error(`[registry] ${backend.id} searchChat(${agentId}) failed:`, err?.message || err);
        return;
      }
      if (search?.supported !== true) {
        unsupportedAgents += 1;
        return;
      }
      searchedAgents += 1;
      if (search.truncated === true) truncated = true;
      for (const hit of Array.isArray(search.results) ? search.results : []) {
        const key = typeof hit?.key === "string" ? hit.key.trim() : "";
        const snippet = typeof hit?.snippet === "string" ? hit.snippet : "";
        if (!key || !snippet) continue;
        results.push({
          backendId: backend.id,
          agentId,
          agentName,
          key,
          snippet,
          ts: Number.isFinite(hit.ts) ? hit.ts : null,
          ...(typeof hit.sessionId === "string" && hit.sessionId ? { sessionId: hit.sessionId } : {}),
          ...(typeof hit.messageId === "string" && hit.messageId ? { messageId: hit.messageId } : {}),
          ...(typeof hit.role === "string" ? { role: hit.role } : {}),
        });
      }
    }));

    results.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)
      || a.agentName.localeCompare(b.agentName)
      || a.key.localeCompare(b.key)
      || String(a.messageId || "").localeCompare(String(b.messageId || "")));
    const page = results.slice(offset, offset + limit);
    const hasMore = offset + page.length < results.length;
    return {
      query: q,
      offset,
      searchedAgents,
      unsupportedAgents,
      failedAgents,
      truncated,
      hasMore,
      ...(hasMore ? { nextOffset: offset + page.length } : {}),
      results: page,
    };
  }

  /**
   * Connection / overview status for every backend (the 设置 page).
   * @returns {Promise<Array<object>>}
   */
  async getStatus() {
    const disabled = this._disabledSet();
    const out = [];
    await Promise.all(
      [...this.backends.values()].map(async (backend) => {
        // 断开的后端不触碰实例（openclaw getStatus 会惰性重连）——直接合成
        // 「已断开」行，设置页据此渲染卡片和「重新连接」按钮。
        if (disabled.has(backend.id)) {
          out.push({ id: backend.id, name: backend.name, connected: false, disabled: true, info: {} });
          return;
        }
        try {
          out.push(await backend.getStatus());
        } catch (err) {
          out.push({
            id: backend.id,
            name: backend.name,
            connected: false,
            info: { error: err?.message || String(err) },
          });
        }
      }),
    );
    out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return out;
  }

  // ---- dashboard 总览 (GET /__api/dashboard) ----

  // Local-time YYYY-MM-DD for matching usage daily[] rows. NOT
  // toISOString().slice(0,10) — that's UTC and lands on the wrong day for
  // evening hours in UTC+ timezones (app/gateway/UI share one machine, so
  // local-day is the established convention — see openclaw sameLocalDay).
  _localDateStr(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  async _dashboardSection(label, fn, backends = this._activeBackends()) {
    return Promise.all(backends.map(async (backend) => {
      try {
        const r = await fn(backend);
        return {
          backend: backend.id,
          supported: !!r?.supported,
          ...(r?.reason ? { reason: r.reason } : {}),
          items: Array.isArray(r?.items) ? r.items : [],
        };
      } catch (err) {
        console.error(`[registry] ${backend.id} ${label} failed:`, err?.message || err);
        return { backend: backend.id, supported: false, reason: "error", items: [] };
      }
    }));
  }

  // Live status polling must not repeatedly fetch usage, artifacts or history.
  async getDashboardLiveWork() {
    const backends = this._activeBackends();
    const [running, approvals] = await Promise.all([
      this._dashboardSection("getRunningWork", b => b.getRunningWork(), backends),
      this._dashboardSection("getPendingApprovals", b => b.getPendingApprovals(), backends),
    ]);
    return { generatedAt: Date.now(), running, approvals };
  }

  /**
   * One-shot aggregate for the dashboard page. Every section is fetched
   * per-backend behind its own try/catch (铁律 4) — this method never throws;
   * a failing backend degrades to an unsupported/empty entry per section.
   * `sinceMs` defaults to today's LOCAL midnight and is echoed back so the UI
   * and smoke share the server's notion of "today".
   * @param {{sinceMs?: number, runsLimit?: number, artifactsLimit?: number}} [opts]
   * @returns {Promise<{generatedAt: number, sinceMs: number, status: Array<object>,
   *   runs: Array<object>, running: Array<object>, approvals: Array<object>,
   *   artifacts: Array<object>, usage: Array<object>}>}
   */
  async getDashboardSummary({ sinceMs, runsLimit = 50, artifactsLimit = 20 } = {}) {
    const since = Number.isFinite(sinceMs) ? sinceMs : new Date().setHours(0, 0, 0, 0);
    const backends = this._activeBackends();
    const section = (label, fn) => this._dashboardSection(label, fn, backends);
    // 活动聚合会拉取当天 cron 全量；与其余 section 同时启动，并让 summary 复用
    // 其中的原始 runs，避免首屏再逐后端重复请求一次 getRecentCronRuns。
    const activityPromise = this.getDashboardActivityData({ sinceMs: since }).catch((err) => {
      console.error("[registry] dashboard activity aggregation failed:", err?.message || err);
      return null;
    });
    const [status, running, approvals, artifacts, usage, activity] = await Promise.all([
      this.getStatus(), // already fail-soft per backend
      section("getRunningWork", (b) => b.getRunningWork()),
      section("getPendingApprovals", (b) => b.getPendingApprovals()),
      section("getRecentArtifacts", (b) => b.getRecentArtifacts({ limit: artifactsLimit, sinceMs: since })),
      Promise.all(
        backends.map(async (backend) => {
          let timer;
          try {
            // Today and yesterday have separate failure boundaries. A failed
            // trend query must not discard a valid full today's total.
            const usage = Promise.allSettled([
              backend.getUsageSeries("today"),
              backend.getUsageSeries("7d"),
            ]);
            const result = await Promise.race([
              usage.then((series) => ({ series })),
              new Promise((resolve) => {
                timer = setTimeout(() => resolve(null), DASHBOARD_USAGE_WAIT_MS);
              }),
            ]);
            if (!result) return { backend: backend.id, error: "pending" };
            const [todayResult, weekResult] = result.series;
            if (todayResult.status !== "fulfilled") return { backend: backend.id, error: "unavailable", availability: "unavailable" };
            const todaySeries = todayResult.value;
            const series7d = weekResult.status === "fulfilled" ? weekResult.value : null;
            const now = Date.now();
            const yesterdayKey = this._localDateStr(now - 86_400_000);
            const daily = Array.isArray(series7d?.daily) ? series7d.daily : [];
            const yesterday = daily.find(d => d?.date === yesterdayKey);
            const tt = todaySeries?.totals;
            const valid = tt && Number.isFinite(tt.totalTokens) && Number.isFinite(tt.totalCost);
            const availability = !valid ? "unavailable" : todaySeries.availability
              || (todaySeries.cacheStatus === "refreshing" ? "partial" : "complete");
            return {
              backend: backend.id, availability,
              ...(valid ? { today: { date: this._localDateStr(now), ...tt } } : { error: "unavailable" }),
              ...(yesterday ? { yesterday } : {}),
              yesterdayComplete: !!series7d && !["partial", "unavailable"].includes(series7d.availability),
            };
          } catch (err) {
            return { backend: backend.id, error: err?.message || String(err) };
          } finally {
            if (timer) clearTimeout(timer);
          }
        }),
      ),
      activityPromise,
    ]);
    let activityRuns = Array.isArray(activity?.runs) ? activity.runs.slice() : null;
    // 只在活动层整体失败/旧桩未提供 runs 时回退，保持 summary 的 fail-soft 契约。
    if (!activityRuns) {
      activityRuns = (await Promise.all(
        backends.map(async (backend) => {
          try {
            const r = await backend.getRecentCronRuns({ sinceMs: since, limit: runsLimit });
            return Array.isArray(r?.runs) ? r.runs : [];
          } catch (err) {
            console.error(`[registry] ${backend.id} getRecentCronRuns failed:`, err?.message || err);
            return [];
          }
        }),
      )).flat();
    }
    const runs = activityRuns
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
      .slice(0, Math.max(1, runsLimit));
    // 统一活动流首屏 + 当天全量 cron 计数（KPI 换此口径消除 runsLimit 截断矛盾）。
    // fail-soft：活动层失败只缺 activityPage/runStats，summary 本身照常返回。
    let activityPage;
    let runStats;
    if (activity) {
      try {
        activityPage = buildActivityPage(activity.entries, { degradedSources: activity.degradedSources });
        runStats = activity.runStats;
      } catch (err) {
        console.error("[registry] dashboard activity page failed:", err?.message || err);
      }
    }
    return {
      generatedAt: Date.now(), sinceMs: since, status, runs, running, approvals, artifacts, usage,
      ...(activityPage ? { activityPage } : {}),
      ...(runStats ? { runStats } : {}),
      ...(activity?.taskStats ? { taskStats: activity.taskStats } : {}),
    };
  }

  /**
   * 统一活动流数据（cron/kanban/inspiration/health 聚合）。30 秒 TTL + 单飞（照
   * _cliUsageCache 的 SWR 惯例简化为 TTL 单飞）：45s 轮询、首屏与
   * /activities 分页共享一份计算。绝不 throw 之外的失败留给 collectActivities
   * 内部逐源降级（铁律 4）。
   * @param {{sinceMs: number}} opts
   */
  async getDashboardActivityData({ sinceMs }) {
    const now = Date.now();
    // 断开集合进缓存键：断开/重连后 30s TTL 内不能回吐旧后端集的活动流。
    const disabledKey = [...this._disabledSet()].sort().join(",");
    const cached = this._activityCache;
    if (cached && cached.sinceMs === sinceMs && cached.disabledKey === disabledKey && now - cached.at < 30_000) {
      return cached.promise;
    }
    const promise = collectActivities({
      backends: this._activeBackends(),
      inspirationOwner: this._inspirationOwner,
      sinceMs,
      healthEvents: this._dashboardJournal ? this._dashboardJournal.getHealthEvents() : [],
    });
    this._activityCache = { sinceMs, at: now, promise, disabledKey };
    try {
      return await promise;
    } catch (err) {
      this._activityCache = null; // 失败不缓存
      throw err;
    }
  }

  /**
   * 活动流分页（GET /__api/dashboard/activities）。非法 cursor/kind/backend
   * 抛错 → 路由层 400。
   * @param {{sinceMs?: number, limit?: number, cursor?: string, backend?: string, kind?: string}} [opts]
   */
  async getDashboardActivityPage({ sinceMs, limit, cursor, backend, kind } = {}) {
    const since = Number.isFinite(sinceMs) ? sinceMs : new Date().setHours(0, 0, 0, 0);
    if (backend && !this.backends.has(backend)) throw new Error(`invalid backend: ${backend}`);
    const data = await this.getDashboardActivityData({ sinceMs: since });
    const page = buildActivityPage(data.entries, {
      limit, cursor, backend, kind, degradedSources: data.degradedSources,
    });
    return { ...page, sinceMs: since, generatedAt: Date.now() };
  }

  /**
   * 设置页版本摘要：backend 可提供权威判断，缺失字段在这里查询官方包源补齐。
   * @param {{latest?: Record<string, object>}} [opts] 测试可注入 latest，生产默认查官方源。
   * @returns {Promise<Array<object>>}
   */
  async getVersions(opts = {}) {
    const [currentRows, latest] = await Promise.all([
      Promise.all(
        [...this.backends.values()].map(async (backend) => {
          try {
            return await backend.getVersionInfo();
          } catch (err) {
            return {
              id: backend.id,
              name: backend.name,
              error: err?.message || String(err),
            };
          }
        }),
      ),
      opts.latest ? Promise.resolve(opts.latest) : fetchOfficialLatestVersions(),
    ]);
    return currentRows
      .map((row) => this._mergeVersionRow(row, latest[row.id] || {}))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  // 合并一个 backend 的版本信息；backend 的权威判断优先，通用包源只补空缺。
  _mergeVersionRow(row, latestInfo) {
    const hasBackendLatest = !!row.latest;
    const summary = buildVersionSummary({
      current: row.current,
      latest: row.latest || latestInfo.latest,
      currentSource: row.currentSource,
      latestSource: row.latestSource || latestInfo.source,
      releaseNotesUrl: row.releaseNotesUrl || latestInfo.releaseNotesUrl,
      error: row.error || (!hasBackendLatest ? latestInfo.error : undefined),
    });
    const { updateAvailable: inferredUpdateAvailable, ...versionSummary } = summary;
    const dashboards = Array.isArray(row.dashboards)
      ? row.dashboards.map((dash) => {
          const hasBackendDashboardLatest = !!(dash.latest || row.latest);
          const dashboardSummary = buildVersionSummary({
            current: dash.current,
            latest: dash.latest || row.latest || latestInfo.latest,
            currentSource: dash.currentSource || row.currentSource,
            latestSource: dash.latestSource || row.latestSource || latestInfo.source,
            error: dash.error || (!hasBackendDashboardLatest ? latestInfo.error : undefined),
          });
          const { updateAvailable: inferredUpdateAvailable, ...dashboardVersion } = dashboardSummary;
          const dashboardUpdateAvailable = typeof dash.updateAvailable === "boolean"
            ? dash.updateAvailable
            : dashboardSummary.error
              ? undefined
              : inferredUpdateAvailable;
          return {
            ...dash,
            ...dashboardVersion,
            ...(typeof dashboardUpdateAvailable === "boolean"
              ? { updateAvailable: dashboardUpdateAvailable }
              : {}),
          };
        })
      : undefined;
    const connectedDashboards = dashboards?.filter((dash) => dash.connected) || [];
    const anyDashboardUpdate = connectedDashboards.some((dash) => dash.updateAvailable === true);
    const allDashboardsCompared = connectedDashboards.length > 0
      && connectedDashboards.every((dash) => typeof dash.updateAvailable === "boolean");
    const updateAvailable =
      typeof row.updateAvailable === "boolean"
        ? row.updateAvailable
        : connectedDashboards.length > 0
          ? anyDashboardUpdate
            ? true
            : allDashboardsCompared
              ? false
              : undefined
          : typeof inferredUpdateAvailable === "boolean"
            ? inferredUpdateAvailable
            : undefined;
    return {
      id: row.id,
      name: row.name,
      ...versionSummary,
      ...(typeof row.comparisonSupported === "boolean"
        ? { comparisonSupported: row.comparisonSupported } : {}),
      ...(typeof updateAvailable === "boolean" ? { updateAvailable } : {}),
      ...(dashboards ? { dashboards } : {}),
    };
  }

  /**
   * 触发单个后端的官方自更新（后台执行）；未知 backend 返回 null（REST 层转 404）。
   * @param {string} backendId
   * @param {{action?: "update"|"repair", acceptCapabilities?: boolean}} [options]
   * @returns {object|null}
   */
  runSelfUpdate(backendId, options = {}) {
    const backend = this.backends.get(backendId);
    if (!backend) return null;
    try {
      return { id: backend.id, name: backend.name, ...backend.runSelfUpdate(options) };
    } catch (err) {
      return { id: backend.id, name: backend.name, supported: false, reason: err?.message || String(err) };
    }
  }

  /**
   * 全部后端的自更新状态（设置页一次拉全、轮询进度）。
   * @returns {Array<object>}
   */
  getSelfUpdateStatuses() {
    return [...this.backends.values()]
      .map((backend) => {
        try {
          return { id: backend.id, name: backend.name, ...backend.getSelfUpdateStatus() };
        } catch (err) {
          return { id: backend.id, name: backend.name, supported: false, reason: err?.message || String(err) };
        }
      })
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  async listStandingGrants(backendId, options = {}) {
    const backend = this._activeGet(backendId);
    if (!backend) return { supported: false, reason: "unknown-backend", grants: [] };
    try {
      return await backend.listStandingGrants(options);
    } catch (err) {
      console.error(`[registry] ${backendId} listStandingGrants failed:`, err?.message || err);
      return { supported: false, reason: "error", grants: [] };
    }
  }

  async revokeStandingGrant(backendId, grantId) {
    const backend = this._activeGet(backendId);
    if (!backend) return { supported: false, reason: "unknown-backend" };
    try {
      return { supported: true, ...(await backend.revokeStandingGrant(grantId)) };
    } catch (err) {
      console.error(`[registry] ${backendId} revokeStandingGrant failed:`, err?.message || err);
      return { supported: false, reason: "error" };
    }
  }

  /**
   * Aggregate session rows plus the backends whose current rows are only a
   * partial/non-authoritative snapshot. The proxy forwards that metadata in the
   * same `degradedBackends` contract used for an unreachable OpenClaw upstream,
   * allowing the UI to preserve the missing partition from cache.
   * @param {{ agentId?: string }} [filter]
   * @returns {{rows: Array<object>, incompleteBackends: Array<string>}}
   */
  aggregateSessionSnapshot(filter) {
    const readSnapshot = (backend) => {
      try {
        const snapshot = backend.getSessionRowsSnapshot();
        return {
          rows: Array.isArray(snapshot?.rows) ? snapshot.rows : [],
          complete: snapshot?.complete !== false,
        };
      } catch {
        return { rows: [], complete: false };
      }
    };

    // If agentId filter is set, find the owning backend and return only its rows.
    if (filter?.agentId) {
      const backend = this.route(filter.agentId);
      if (!backend) return { rows: [], incompleteBackends: [] };
      const snapshot = readSnapshot(backend);
      return {
        rows: snapshot.rows.filter(
          (row) => row && row.key && row.key.startsWith(`agent:${filter.agentId}:`),
        ),
        incompleteBackends: snapshot.complete ? [] : [backend.id],
      };
    }

    const all = [];
    const incompleteBackends = [];
    for (const backend of this._activeBackends()) {
      const snapshot = readSnapshot(backend);
      if (!snapshot.complete) incompleteBackends.push(backend.id);
      for (const row of snapshot.rows) {
        all.push(row);
      }
    }

    // Global: deduplicate by key.
    const seen = new Set();
    const rows = all.filter((row) => {
      if (!row?.key || seen.has(row.key)) return false;
      seen.add(row.key);
      return true;
    });
    return { rows, incompleteBackends };
  }

  /**
   * Backwards-compatible rows-only view for management callers.
   * @param {{ agentId?: string }} [filter]
   * @returns {Array<object>}
   */
  aggregateSessions(filter) {
    return this.aggregateSessionSnapshot(filter).rows;
  }

  /**
   * Aggregate cron jobs (UnifiedCronJob[]) from all backends. A backend that
   * throws or is slow doesn't sink the others — its jobs are simply omitted.
   * @returns {Promise<Array<object>>}
   */
  async aggregateCronJobs() {
    const all = [];
    await Promise.all(
      this._activeBackends().map(async (backend) => {
        try {
          const jobs = await backend.getCronJobs();
          if (Array.isArray(jobs)) all.push(...jobs);
        } catch (err) {
          console.error(`[registry] ${backend.id} getCronJobs failed:`, err?.message || err);
        }
      }),
    );
    return all;
  }

  /**
   * Route a unified cron id to its owning backend. The id is
   * "<prefix>:<localId>" where prefix is either a literal backend id
   * ("openclaw") or an agentId a backend owns ("hermes-default").
   * @param {string} id
   * @returns {import('./agent-backend').AgentBackend|null}
   */
  routeByCronId(id) {
    const prefix = String(id || "").split(":")[0];
    if (!prefix) return null;
    const direct = this._activeGet(prefix);
    if (direct) return direct;
    return this.route(prefix);
  }

  /**
   * Resolve an opaque or legacy resource id by asking every active backend for
   * an authoritative, read-only ownership decision. Exactly one claimant is
   * required; zero or multiple claimants fail closed.
   * @param {string} kind e.g. "cron" | "kanban" | "dashboard-run"
   * @param {string} id
   * @returns {Promise<import('./agent-backend').AgentBackend|null>}
   */
  async resolveResourceOwner(kind, id) {
    if (typeof kind !== "string" || kind.length === 0
      || typeof id !== "string" || id.length === 0) return null;
    const claims = await Promise.all(
      this._activeBackends().map(async (backend) => {
        try {
          return await backend.ownsResourceId(kind, id) === true ? backend : null;
        } catch (err) {
          console.error(
            `[registry] ${backend.id} ownsResourceId(${kind}) failed:`,
            err?.message || err,
          );
          return null;
        }
      }),
    );
    const owners = claims.filter(Boolean);
    return owners.length === 1 ? owners[0] : null;
  }

  /**
   * Test a candidate connection config for one backend (设置 page).
   * @param {{ backend?: string }} spec
   * @returns {Promise<{ok: boolean, error?: string, info?: object}>}
   */
  async testConnection(spec) {
    const backend = this.backends.get(spec?.backend);
    if (!backend) return { ok: false, error: `unknown backend "${spec?.backend}"` };
    try {
      return await backend.testConnection(spec);
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  /** LAN 发现开关状态(单后端透传;未知后端按不支持处理)。 */
  async getLanDiscovery(backendId) {
    const backend = this.backends.get(backendId);
    if (!backend) return { supported: false, error: `unknown backend "${backendId}"` };
    try {
      return await backend.getLanDiscovery();
    } catch (err) {
      return { supported: false, error: err?.message || String(err) };
    }
  }

  /** 开/关 LAN 发现(单后端透传;错误按契约上抛给路由层转 500)。 */
  async setLanDiscovery(backendId, enabled) {
    const backend = this.backends.get(backendId);
    if (!backend) throw new Error(`unknown backend "${backendId}"`);
    return backend.setLanDiscovery(enabled);
  }
}

module.exports = { BackendRegistry };
