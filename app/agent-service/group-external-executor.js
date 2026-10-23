"use strict";

const crypto = require("node:crypto");
const { validResponseMetadata } = require("../chat-response-metadata");
const { validResultPage, sha256 } = require("../group-result-content");
const { serviceError } = require("./security");
const { redactGrantTokens } = require("./group-tool-grant");
const { EXTERNAL_TERMINAL } = require("../external-inspiration-protocol");

// 同一回合的外部运行 id 由回合 id 确定性派生：prepare 与 start 必须使用同一身份，
// 崩溃后重试也会落到 App 侧同一条执行记录上，而不是另起一次。
function deterministicUuid(seed) {
  const hex = crypto.createHash("sha256").update(seed, "utf8").digest("hex");
  const variant = "89ab"[parseInt(hex[16], 16) % 4];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// 后端还没确认这次执行已经开始（或查不到它）时的快照状态。
const UNCONFIRMED_STATUSES = new Set(["queued", "unknown"]);
const DEFAULT_UNCONFIRMED_TIMEOUT_MS = 90_000;
// 准备旧会话时对方表示这条会话已经续接不上（典型：App 重启后 Hermes 不再认它）。
const SESSION_LOST_CODES = new Set(["HERMES_INSPIRATION_SESSION_UNCONFIRMED", "HERMES_INSPIRATION_WORKSPACE_UNCONFIRMED",
  "HERMES_INSPIRATION_TARGET_MISMATCH", "INSPIRATION_BINDING_INVALID"]);

// 外部成员（Hermes / OpenClaw）的群回合（群聊开发计划 §12.2，R4）：经 App 私有桥
// group.external.*，与灵感外部执行同一合同。执行身份先写进群库再请求启动；终态靠轮询
// 快照获得。D15：接受证据和待核对状态落库；超出观察时限只标待核对，不把断线当作执行失败。
// 未取得终态 / 取消证据时持续保留原身份与运行占用，不能开放普通重试。
// 旧会话续接不上时抛 GROUP_EXTERNAL_SESSION_LOST：回合由驱动换新会话后重排。
// 内部以 "turn:<回合 id>" 标识一次执行。
class GroupExternalExecutor {
  constructor({ store, getClient, onTerminal, getGroupToolCapability = () => null, onInteraction = () => {},
    onResumed = () => {}, pollMs = 1500, unconfirmedTimeoutMs = DEFAULT_UNCONFIRMED_TIMEOUT_MS,
    lostTimeoutMs = 2 * unconfirmedTimeoutMs, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
    onChanged = () => {}, onError = () => {} }) {
    this.store = store;
    this.getClient = getClient;
    this.getGroupToolCapability = getGroupToolCapability;
    this.onTerminal = onTerminal;
    this.onInteraction = onInteraction;
    this.onResumed = onResumed;
    this.pollMs = pollMs;
    this.unconfirmedTimeoutMs = unconfirmedTimeoutMs;
    this.lostTimeoutMs = lostTimeoutMs;
    this.now = now;
    this.canceling = new Set();
    this.reading = new Set();
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onError = onError;
    this.onChanged = onChanged;
    this.timers = new Map();
    this.stopped = false;
    this.fence = null;
  }

  #client() {
    const client = this.getClient();
    if (!client) throw serviceError("GROUP_EXTERNAL_UNAVAILABLE", "外部成员执行通道不可用");
    return { request: async (method, params) => {
      const fence = this.fence;
      if (fence === null || fence !== this.store.getDriverFence() || (this.stopped && method !== "group.external.cancel")) {
        throw serviceError("GROUP_HOST_OWNER_CHANGED", "执行宿主的写入租约已变化");
      }
      const value = await client.request(method, params.remote ? { ...params, remote: { ...params.remote,
        ownerId: this.store.getRemoteOwnerId(), epoch: fence } } : params);
      if (fence !== this.fence || fence !== this.store.getDriverFence()) throw serviceError("GROUP_HOST_OWNER_CHANGED", "执行宿主的写入租约已变化");
      return value;
    } };
  }

  // 准备会话（首次会创建外部会话）并返回执行身份；会话或工作区变化时交给 rebind 记下来。
  // 换过会话后用新的执行身份：App 侧按执行 id 记住了上一次（失败的）准备，同一个 id 不能换参数重来。
  async #prepare({ id, kind, taskId = null, member, binding, modelSelection = null, rebind }) {
    const client = this.#client();
    const generation = binding.external?.retired?.length ?? 0;
    const executionId = generation ? deterministicUuid(`group-${kind}-exec:${id}:${generation}`) : id;
    const runId = deterministicUuid(`group-${kind === "task" ? "task-" : ""}run:${id}${generation ? `:${generation}` : ""}`);
    let prepared;
    try {
      prepared = await client.request("group.external.prepare", {
        executionId, runId,
        backendId: member.backendId, agentId: member.agentId, sessionKey: binding.sessionKey,
        workspace: binding.external?.workspace ?? null, operationId: `prepare-${executionId}`,
        modelSelection,
        context: { authority: { groupId: binding.groupId, ownerId: this.store.getRemoteOwnerId(), epoch: this.store.getDriverFence() }, kind, taskId, peerId: member.peerId ?? null },
      });
    } catch (error) {
      if (binding.sessionKey && SESSION_LOST_CODES.has(error?.code)) {
        throw Object.assign(new Error("external session can no longer be resumed"),
          { code: "GROUP_EXTERNAL_SESSION_LOST", cause: error });
      }
      throw error;
    }
    if (this.fence !== this.store.getDriverFence()) throw serviceError("GROUP_HOST_OWNER_CHANGED", "执行租约已变化");
    const { sessionKey, workspace, mode } = prepared.binding;
    if (binding.sessionKey !== sessionKey || binding.external?.workspace !== workspace
      || binding.external?.mode !== mode || binding.external?.remote?.peerId !== prepared.remote?.peerId
      || binding.external?.resource?.key !== prepared.resource?.key) rebind(sessionKey, { workspace, mode, ...(prepared.resource ? { resource: prepared.resource } : {}), ...(prepared.remote ? { remote: prepared.remote } : {}) });
    return { client, external: { executionId, runId, backendId: member.backendId,
      agentId: member.agentId, sessionKey, workspace, mode, hostId: prepared.hostId, ...(prepared.remote ? { remote: prepared.remote } : {}) },
      isolation: prepared.isolation ?? null };
  }

  /** @returns {Promise<{runId: string, sessionKey: string} | null>} null 表示回合已被停止 */
  async startTurn({ opportunity, member, binding, prompt }) {
    const { client, external } = await this.#prepare({ id: opportunity.id, kind: "turn",
      modelSelection: opportunity.modelSelection ?? null,
      member, binding, rebind: (sessionKey, info) => this.store.bindSession({ groupId: binding.groupId,
        memberId: binding.memberId, sessionKey, external: info, fence: opportunity.fence }) });
    const recorded = this.store.recordRun({ opportunityId: opportunity.id, runId: external.runId,
      sessionKey: external.sessionKey, runKind: "external", external, fence: opportunity.fence });
    if (!recorded) return null;
    if (recorded.abortReason) { this.cancel(recorded); return null; }
    // 身份一登记就开始核对：启动请求迟迟不返回时，未确认计时照常进行。
    this.#schedule(`turn:${opportunity.id}`);
    const result = await client.request("group.external.start", { ...external, prompt,
      operationId: `start-${opportunity.id}` });
    await this.#observe(`turn:${opportunity.id}`, result.snapshot, result.hostId);
    return { runId: external.runId, sessionKey: external.sessionKey };
  }

  async #observe(key, snapshot, hostId) {
    if (this.stopped || this.fence !== this.store.getDriverFence()) return;
    const [kind, id] = key.split(":");
    const external = this.#active(key);
    if (!external) return;
    if (["executionId", "runId", "backendId", "agentId", "sessionKey", "workspace", "mode"]
      .some((field) => snapshot[field] !== external[field])) {
      this.onError(serviceError("GROUP_EXTERNAL_RESPONSE_MISMATCH", "外部运行身份不匹配"));
      this.#schedule(key);
      return;
    }
    const before = this.store.getOpportunity(id);
    if (hostId === external.hostId && Number.isSafeInteger(snapshot.sequence)
      && snapshot.sequence < (before?.observation?.sequence ?? 0)) { this.#schedule(key); return; }
    const observed = this.store.recordExecutionObservation({ kind, id, runId: snapshot.runId,
      status: snapshot.status, dispatchState: snapshot.dispatchState, sequence: snapshot.sequence, hostId, at: this.now(), fence: this.fence });
    if (!observed) return;
    if (observed.changed) this.onChanged(observed.groupId);
    if (EXTERNAL_TERMINAL.has(snapshot.status)) {
      let text = snapshot.resultSummary;
      let responseMetadata = null;
      if (kind === "turn" && snapshot.status === "completed" && !observed.record.abortReason) {
        if (this.reading.has(key)) return;
        this.reading.add(key);
        try {
          text = await this.#readResult(observed.record.external);
          // Older Hosts can omit this read-only capability. Missing usage must
          // never fail a verified answer or trigger another execution.
          try {
            const result = await this.#client().request("group.external.metadata", observed.record.external);
            if (result.hostId === observed.record.external.hostId && validResponseMetadata(result.responseMetadata)) responseMetadata = result.responseMetadata;
          } catch {}
        }
        catch (error) {
          this.onError(error);
          if (!this.stopped) {
            const marked = this.store.markReconciliation({ kind, id, runId: snapshot.runId,
              type: "result", reason: error.code === "GROUP_TURN_RESULT_EMPTY" ? error.code : "GROUP_TURN_RESULT_UNAVAILABLE", fence: this.fence });
            if (marked?.changed) this.onChanged(marked.groupId);
            this.#schedule(key);
          }
          return;
        } finally { this.reading.delete(key); }
      }
      if (!this.stopped) this.#settle(key, { status: snapshot.status, text, errorCode: snapshot.errorCode, responseMetadata });
      return;
    }
    if (kind === "turn" && observed.record.state === "waiting" && snapshot.status === "running" && !snapshot.attention?.active) {
      this.store.markInteractionResponded({ opportunityId: id, requestId: observed.record.interaction?.request?.requestId });
      this.onResumed(id);
      this.onChanged(observed.groupId);
    } else if (kind === "turn" && (before?.recovery && !observed.record.recovery
      || before?.observation?.acceptedAt == null && observed.record.observation?.acceptedAt != null)) this.onResumed(id);
    if (UNCONFIRMED_STATUSES.has(snapshot.status)) this.#unconfirmed(key, observed.record);
    if (snapshot.attention?.active && kind === "turn") this.onInteraction(id, snapshot.attention);
    this.#schedule(key);
  }

  async #readResult(external, part = "answer") {
    let offset = 0, digest = null, totalBytes = null;
    const parts = [];
    for (;;) {
      const result = await this.#client().request("group.external.result", { ...external, offset, digest,
        ...(part === "progress" ? { part } : {}) });
      if (result.hostId !== external.hostId) throw serviceError("GROUP_EXTERNAL_RESPONSE_MISMATCH", "外部结果身份不匹配");
      const page = result.page;
      if (page === null && part === "progress") return null;
      if (page === null) throw serviceError("GROUP_TURN_RESULT_EMPTY", "最终正文暂时读不到");
      if (!validResultPage(page) || page.offset !== offset || (digest !== null && digest !== page.digest)
        || (totalBytes !== null && totalBytes !== page.totalBytes) || page.totalBytes > 32 * 1024 * 1024) {
        throw serviceError("GROUP_RESULT_MISMATCH", "完整结果校验未通过");
      }
      digest = page.digest; totalBytes = page.totalBytes;
      parts.push(page.text);
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
      if (this.stopped) throw serviceError("GROUP_EXTERNAL_UNAVAILABLE", "执行器已停止");
    }
    const text = parts.join("");
    if (sha256(text) !== digest) throw serviceError("GROUP_RESULT_MISMATCH", "完整结果校验未通过");
    if (!text.trim() && part !== "progress") throw serviceError("GROUP_TURN_RESULT_EMPTY", "最终正文为空");
    return text;
  }

  async publicProgress(record) {
    if (!record.external) return null;
    try { return redactGrantTokens(await this.#readResult(record.external, "progress")); }
    catch (error) {
      if (["INVALID_PARAMS", "GROUP_HOST_REQUEST_INVALID", "APP_HOST_REQUEST_INVALID", "GROUP_HOST_TOOL_UNSUPPORTED"].includes(error?.code)) return null;
      throw error;
    }
  }

  #settle(key, outcome) {
    if (this.stopped || this.fence !== this.store.getDriverFence()) return;
    const [kind, id] = key.split(":");
    this.#clear(key);
    if (kind === "turn") this.onTerminal(id, outcome);
  }

  #unconfirmed(key, record) {
    if (record.observation?.dispatchState === "queued") return;
    const lost = record.observation?.acceptedAt != null;
    const since = record.observation?.unknownSince ?? this.now();
    if (this.now() - since < (lost ? this.lostTimeoutMs : this.unconfirmedTimeoutMs)) return;
    const [kind, id] = key.split(":");
    const marked = this.store.markReconciliation({ kind, id, runId: record.runId,
      reason: lost ? "GROUP_EXTERNAL_RUN_LOST" : "GROUP_EXTERNAL_START_UNCONFIRMED", fence: this.fence });
    if (marked?.changed) this.onChanged(marked.groupId);
  }

  #clear(key) {
    const timer = this.timers.get(key);
    if (timer) this.clearTimer(timer);
    this.timers.delete(key);
  }

  #schedule(key) {
    if (this.stopped || this.fence !== this.store.getDriverFence() || this.timers.has(key)) return;
    const timer = this.setTimer(() => {
      this.timers.delete(key);
      void this.#poll(key);
    }, this.pollMs);
    timer?.unref?.();
    this.timers.set(key, timer);
  }

  // 仍在进行的执行才继续轮询；返回已保存的执行身份。
  #active(key) {
    const [kind, id] = key.split(":");
    if (kind !== "turn") return null;
    const opportunity = this.store.getOpportunity(id);
    return opportunity && ["running", "waiting"].includes(opportunity.state) ? opportunity.external ?? null : null;
  }

  async #poll(key) {
    if (this.stopped) return;
    let external;
    // 轮询在定时器回调里：群库不可用时记下错误并结束，不让异常逃出回调。
    try { external = this.#active(key); } catch (error) { this.onError(error); return; }
    if (!external) {
      return;
    }
    try {
      const [kind, id] = key.split(":");
      const record = kind === "turn" ? this.store.getOpportunity(id) : null;
      if (record?.observation?.terminalStatus) {
        await this.#observe(key, { ...external, status: record.observation.terminalStatus }, external.hostId);
        return;
      }
      const result = await this.#client().request("group.external.get", external);
      await this.#observe(key, result.snapshot, result.hostId);
      this.#retryCancellation(key);
    } catch (error) {
      this.onError(error);
      if (this.stopped || this.fence !== this.store.getDriverFence()) return;
      const [kind, id] = key.split(":");
      const observed = this.store.recordExecutionObservation({ kind, id, status: "unavailable", at: this.now(), fence: this.fence });
      if (observed) this.#unconfirmed(key, observed.record);
      this.#retryCancellation(key);
      this.#schedule(key);
    }
  }

  #retryCancellation(key) {
    // 取消意图已持久化：桥暂不可达后，核对循环继续重试同一取消操作，不另起执行。
    const [kind, id] = key.split(":");
    const record = kind === "turn" ? this.store.getOpportunity(id) : null;
    const active = record && ["running", "waiting"].includes(record.state);
    if (active && (record.abortReason || record.recovery?.cancelRequested)) this.#cancel(kind, record);
  }

  /** 重启或启动结果不确定后，按已保存的执行身份继续核对。 */
  resume(opportunity) {
    if (opportunity.external) this.#schedule(`turn:${opportunity.id}`);
  }

  reconcile(opportunity) { return this.#poll(`turn:${opportunity.id}`); }

  /** 外部成员当前的回复草稿（不支持的后端返回 null）。 */
  async draft(opportunity) {
    if (!opportunity.external) return null;
    const result = await this.#client().request("group.external.draft", opportunity.external);
    return result.draft;
  }

  async probe(member) {
    const { groupCapabilities } = require("./group-capabilities");
    try {
      const input = { backendId: member.backendId, agentId: member.agentId, ...(member.peerId ? { peerId: member.peerId } : {}) };
      let result;
      try { result = await this.#client().request("group.external.capabilities", { ...input, protocolVersion: 2 }); }
      catch (error) {
        if (!["APP_HOST_INVALID_REQUEST", "INVALID_PARAMS", "APP_HOST_REQUEST_INVALID"].includes(error?.code)) throw error;
        result = await this.#client().request("group.external.capabilities", input);
      }
      const value = groupCapabilities(Object.hasOwn(result, "collaborationActions") ? result : {
        groupTools: result.groupTools, source: "legacy-host", checkedAt: this.now() });
      // The App knows configured helpers; this Service owns authenticated live
      // adapter registrations. Merge the same current proof used by the directory.
      const proof = !member.peerId ? this.getGroupToolCapability(member) : null;
      const actions = value.collaborationActions || proof?.groupTools === true
        && proof.protocolVersion === 2 && proof.collaborationActions === true;
      return groupCapabilities({ ...value, groupTools: value.groupTools || proof?.groupTools === true,
        collaborationActions: actions, protocolVersion: actions ? 2 : value.protocolVersion });
    } catch { return groupCapabilities({ availability: "unavailable", checkedAt: this.now() }); }
  }

  /** Bound read only; legacy Hosts explicitly degrade to status/draft observation. */
  async activity(record) {
    if (!record.external) return null;
    try {
      const result = await this.#client().request("group.external.activity", record.external);
      if (result.activity && result.activity.runId !== record.runId
        || result.hostId !== record.external.hostId) throw serviceError("GROUP_EXTERNAL_RESPONSE_MISMATCH", "外部活动身份不匹配");
      return result.activity;
    } catch (error) {
      if (["METHOD_NOT_FOUND", "INVALID_METHOD", "APP_HOST_METHOD_UNSUPPORTED", "GROUP_HOST_TOOL_UNSUPPORTED",
        "GROUP_HOST_REQUEST_INVALID", "APP_HOST_REQUEST_INVALID"].includes(error?.code)) return null;
      throw error;
    }
  }

  async respond(opportunity, { requestId, response, operationId }) {
    const result = await this.#client().request("group.external.respond", { ...opportunity.external,
      requestId, response, operationId });
    await this.#observe(`turn:${opportunity.id}`, result.snapshot, result.hostId);
  }

  cancel(opportunity) {
    this.#cancel("turn", opportunity);
  }

  /** 升级前旧机制留下的外部运行：只请求一次停止，不再跟踪它的结果。 */
  cancelRetired(run) {
    if (!run.external || this.stopped || this.fence !== this.store.getDriverFence()) return;
    void Promise.resolve().then(() => this.#client().request("group.external.cancel", { ...run.external,
      operationId: `cancel-${run.id}` })).catch((error) => this.onError(error));
  }

  async stopGroup(groupId) {
    const targets = this.store.groupDeletionTargets(groupId);
    let confirmed = true;
    for (const external of targets.targets) {
      try {
        const result = await this.#client().request("group.external.cancel", { ...external, stopGroup: true,
          operationId: `delete-group-${external.executionId}` });
        if (result.groupStopped !== true) confirmed = false;
      } catch (error) { confirmed = false; this.onError(error); }
    }
    return { confirmed, digest: targets.digest };
  }

  #cancel(kind, record) {
    if (!record.external || this.stopped || this.fence !== this.store.getDriverFence()) return;
    const key = `${kind}:${record.id}`;
    if (!record.recovery?.cancelRequested) {
      const marked = this.store.markReconciliation({ kind, id: record.id, runId: record.runId,
        reason: "GROUP_EXECUTION_STOP_UNCONFIRMED", cancelRequested: true, fence: this.fence });
      if (marked?.changed) this.onChanged(marked.groupId);
    }
    this.#schedule(key);
    if (this.canceling.has(key)) return;
    this.canceling.add(key);
    // 回应用户不等待取消 RPC；核对循环保持运行。重启后仍使用同一个取消操作 id。
    void Promise.resolve().then(() => this.#client().request("group.external.cancel", { ...record.external,
      ...(["deleting", "deleted"].includes(this.store.groupLifecycle(record.groupId)) ? { stopGroup: true } : {}),
      operationId: `cancel-${record.id}` })).then((result) => this.#observe(key, result.snapshot, result.hostId))
      .catch((error) => this.onError(error)).finally(() => this.canceling.delete(key));
  }

  stop() {
    this.stopped = true;
    for (const timer of this.timers.values()) this.clearTimer(timer);
    this.timers.clear();
    this.canceling.clear();
  }

  start(fence = this.store.getDriverFence()) {
    this.fence = fence;
    this.stopped = false;
  }
}

module.exports = { GroupExternalExecutor, deterministicUuid };
