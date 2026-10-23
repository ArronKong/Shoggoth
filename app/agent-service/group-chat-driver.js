"use strict";

const { groupRunTarget } = require("./group-chat-run");
const { renderRoomPrompt, turnAttachments } = require("./group-room-prompt");
const { redactGrantTokens } = require("./group-tool-grant");
const { parseMemberReply } = require("./group-reply-format");
const { validateInteractiveResponseV1 } = require("../core/shoggoth-interaction-contract");
const { validText } = require("../group-result-content");
const { EXECUTION_TIMEOUT_MS } = require("../execution-timeout");

const TERMINAL_STATUSES = new Set(["completed", "failed", "canceled", "interrupted", "skipped"]);
const WAITING_STATUSES = new Set(["waiting_approval", "waiting_input"]);
// 会话放不下这次输入、原生压缩 / 产品摘要没完成时的拒绝原因；换一条新会话能接着答。
// CONTEXT_INPUT_TOO_LARGE 不在内：这次输入本身就放不下，换会话也没用。
const RENEWABLE_CONTEXT_ERRORS = /^(?:CONTEXT_COMPACTION_REQUIRED|CONTEXT_TRANSPORT_EXCEEDED|RUNTIME_COMPACTION_[A-Z_]+|PRODUCT_COMPACTION_[A-Z_]+)$/u;
// 开始用工具满 15 秒还没说完，就让出发言位，活在后台继续。
const RELEASE_AFTER_TOOL_MS = 15_000;
// 拿不到工具信号的外部成员：开始 60 秒后还没说完就让位。
const EXTERNAL_RELEASE_MS = 60_000;
// 持有发言位时 30 分钟完全没有动静才算超时；让位后在后台干活的回合不按时间中止，用户可以停下它。
const INACTIVITY_TIMEOUT_MS = EXECUTION_TIMEOUT_MS;
const ABORT_GRACE_MS = 30_000;

// 确定性群驱动：全群一次一人发言（谁下一个由存储按轮次决定），不调用任何选人模型；不持有存储
// 事务等待模型；终态回调重新经过存储的状态与 fence 校验。
// 原生成员走 executor（chat.send，终态经运行钩子回到 onRunTerminal）；外部成员走
// externalExecutor（App 私有桥，终态经轮询回到 onExternalTerminal）。
class GroupChatDriver {
  // attachmentPath(attachment)：附件在本机的落盘路径，给没有原生附件通道的外部成员用。
  // ingestAttachment(rootRef, path, key)：把成员工作区里的一个文件核对后存进媒体库，返回附件描述或 null。
  constructor({ store, executor, externalExecutor = null, directory = null, drafts = null, attachmentPath = null,
    ingestAttachment = null, onChanged = () => {}, setTimer = setTimeout, clearTimer = clearTimeout,
    releaseAfterToolMs = RELEASE_AFTER_TOOL_MS, externalReleaseMs = EXTERNAL_RELEASE_MS,
    inactivityMs = INACTIVITY_TIMEOUT_MS, abortGraceMs = ABORT_GRACE_MS, reconcileMs = 5000, onError = () => {} }) {
    this.store = store;
    this.executor = executor;
    this.externalExecutor = externalExecutor;
    this.directory = directory;
    this.drafts = drafts;
    this.attachmentPath = attachmentPath;
    this.ingestAttachment = ingestAttachment;
    this.onChanged = onChanged;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.releaseAfterToolMs = releaseAfterToolMs;
    this.externalReleaseMs = externalReleaseMs;
    this.inactivityMs = inactivityMs;
    this.abortGraceMs = abortGraceMs;
    this.reconcileMs = reconcileMs;
    this.onError = onError;
    this.fence = null;
    this.timers = new Map();
    this.pumping = new Set();
    this.again = new Set();
    this.deletionChecks = new Map();
  }

  async start() {
    this.fence = this.store.advanceDriverFence();
    this.externalExecutor?.start(this.fence);
    for (const groupId of this.store.groupsPendingDeletion()) {
      this.store.deleteGroup({ groupId }); this.directory?.cancelGroup?.(groupId);
    }
    this.drafts?.start?.();
    await this.#retireLegacyRuns();
    await this.recover();
    for (const groupId of this.store.groupsPendingDeletion()) await this.deleteGroup(groupId);
  }

  stop() {
    this.fence = null;
    this.externalExecutor?.stop();
    this.drafts?.stop();
    this.directory?.stop?.();
    this.deletionChecks.clear();
    for (const timer of this.timers.values()) this.clearTimer(timer);
    this.timers.clear();
  }

  // 升级前旧机制（讨论、正式任务）还在跑的运行：群库已把它们标为取消，这里请运行时停下。
  async #retireLegacyRuns() {
    for (const run of this.store.takeLegacyRuns?.() ?? []) {
      try {
        if (run.runKind === "external") this.externalExecutor?.cancelRetired?.(run);
        else if (run.runId) await this.executor.abort({ sessionKey: run.sessionKey, runId: run.runId });
      } catch (error) { this.onError(error); }
    }
  }

  wake(groupId) {
    if (this.fence === null) return;
    if (this.pumping.has(groupId)) { this.again.add(groupId); return; }
    this.pumping.add(groupId);
    void this.#pump(groupId).catch((error) => this.onError(error)).finally(() => {
      this.pumping.delete(groupId);
      if (this.again.delete(groupId)) this.wake(groupId);
    });
  }

  async #pump(groupId) {
    if (["deleting", "deleted"].includes(this.store.groupLifecycle(groupId))) {
      await this.deleteGroup(groupId); return;
    }
    // 回合边界刷新成员目录（设定、显示名、可用状态）；失败时沿用已有成员卡。
    try { await this.directory?.refresh(groupId); } catch (error) { this.onError(error); }
    // 认领能开始的回合：持有发言位的至多一位，另有忙完再答的后台回合。
    for (;;) {
      if (this.fence === null) return;
      const claim = this.store.claimNext(groupId, this.fence);
      if (!claim) break;
      this.#armInactivity(claim.opportunity);
      void this.#execute(claim).catch((error) => this.onError(error));
    }
    this.onChanged(groupId);
  }

  #prompt(claim, external = false) {
    return renderRoomPrompt({ group: claim.group, member: claim.member, members: claim.members, ownerId: claim.ownerId,
      earlier: claim.earlier, current: claim.current, omitted: claim.omitted, spokeThisRound: claim.spokeThisRound,
      order: claim.order, position: claim.position, working: claim.working, note: claim.note, now: this.store.now(),
      ...(external ? { attachmentPath: (attachment) => this.#attachmentPath(attachment) } : { readHistory: true }) });
  }

  async #execute(claim) {
    if (!claim.member.profileId) return this.#executeExternal(claim);
    const { opportunity, binding } = claim;
    let sessionKey = binding.sessionKey;
    try {
      if (!sessionKey) {
        sessionKey = await this.executor.ensureSession(binding);
        if (this.fence === null || this.fence !== opportunity.fence || this.fence !== this.store.getDriverFence()) return;
        this.store.bindSession({ groupId: binding.groupId, memberId: binding.memberId, sessionKey, fence: opportunity.fence });
      }
      if (this.fence === null || this.fence !== this.store.getDriverFence()) return;
      const current = this.store.getOpportunity(opportunity.id);
      if (!current || !["running", "waiting"].includes(current.state)) return;
      // 会话准备期间收到停止：尚未发送执行请求，可以直接结束，不再启动一次模型调用。
      if (current.abortReason) { this.#complete(current.id, { status: "canceled" }); return; }
      await this.executor.prepareModel?.({ member: claim.member, sessionKey, modelSelection: opportunity.modelSelection ?? null });
      // 这次输入里用户与同伴新发的附件随本回合一起交给运行时（各会话拿到的是同一份数据的克隆）。
      const attachments = turnAttachments([...claim.earlier, ...claim.current]).attachments
        .map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size }));
      const run = await this.executor.start({ sessionKey, operationId: opportunity.operationId, prompt: this.#prompt(claim),
        ...(attachments.length ? { attachments } : {}) });
      await this.#track(opportunity.id, run, sessionKey);
    } catch (error) {
      // 发送可能已被接受但响应丢失：先按幂等操作核对，再决定是否记失败。
      const run = (() => { try { return this.executor.findRun({ operationId: opportunity.operationId, sessionKey }); } catch { return null; } })();
      if (run) { await this.#track(opportunity.id, run, sessionKey); return; }
      this.#complete(opportunity.id, { status: "failed", errorCode: error?.code || "GROUP_TURN_START_FAILED" });
    }
  }

  async #executeExternal(claim) {
    const { opportunity, member, binding } = claim;
    try {
      if (!this.externalExecutor) throw Object.assign(new Error("external"), { code: "GROUP_EXTERNAL_UNAVAILABLE" });
      const started = await this.externalExecutor.startTurn({ opportunity, member, binding, prompt: this.#prompt(claim, true) });
      const current = this.store.getOpportunity(opportunity.id);
      if (!started || !current || current.state !== "running") {
        if (current?.state === "running") void this.#abort(current);
        return;
      }
      this.drafts?.watch(current.id);
      // 外部成员可能报不出工具活动：开始一段时间后还没说完就让位（报得出时按工具规则提前让位）。
      if (current.floor && !current.released) this.#armRelease(current.id, this.externalReleaseMs);
      if (current.abortReason) void this.#abort(current);
    } catch (error) {
      // 成员原来的群内部会话续接不上：换新会话，回合回到原位置；下一次认领给它看最近的群消息。
      if (error?.code === "GROUP_EXTERNAL_SESSION_LOST"
        && this.store.resetSession({ groupId: binding.groupId, memberId: binding.memberId })
        && this.store.requeue({ opportunityId: opportunity.id })) {
        this.#clearTimers(opportunity.id);
        this.wake(opportunity.groupId);
        return;
      }
      // 外部执行身份已经登记时，启动请求失败不代表模型没开始：继续按原身份核对。
      const current = this.store.getOpportunity(opportunity.id);
      if (current?.state === "running" && current.external) {
        this.externalExecutor.resume(current);
        return;
      }
      this.#complete(opportunity.id, { status: "failed", errorCode: error?.code || "GROUP_TURN_START_FAILED" });
    }
  }

  #attachmentPath(attachment) {
    try { return this.attachmentPath?.(attachment) ?? null; } catch (error) { this.onError(error); return null; }
  }

  // ---- 让位与超时 ----

  #timer(key, delayMs, fn) {
    if (this.fence === null) return;
    const prior = this.timers.get(key);
    if (prior) this.clearTimer(prior);
    const fence = this.fence;
    const timer = this.setTimer(() => {
      this.timers.delete(key);
      if (this.fence === null || this.fence !== fence || this.fence !== this.store.getDriverFence()) return;
      try { fn(); } catch (error) { this.onError(error); }
    }, Math.max(0, delayMs));
    timer?.unref?.();
    this.timers.set(key, timer);
  }

  #cancelTimer(key) {
    const timer = this.timers.get(key);
    if (timer) { this.clearTimer(timer); this.timers.delete(key); }
  }

  #clearTimers(opportunityId) {
    for (const key of [opportunityId, `idle:${opportunityId}`, `release:${opportunityId}`]) this.#cancelTimer(key);
  }

  // 持有发言位时，最后一次动静之后 inactivityMs 内没有新动静就超时：让出发言位并中止。
  #armInactivity(opportunity) {
    if (!opportunity.floor || opportunity.released || opportunity.state !== "running" || opportunity.abortReason) {
      this.#cancelTimer(`idle:${opportunity.id}`);
      return;
    }
    this.#timer(`idle:${opportunity.id}`, this.inactivityMs, () => {
      const current = this.store.getOpportunity(opportunity.id);
      if (!current || current.state !== "running" || !current.floor || current.released) return;
      // 外部运行还在宿主排队，或桥暂时查不到它：不是成员没动静，不能据此取消；只让出发言位，结果出来照常回群。
      const unproven = current.runKind === "external" && (current.observation?.dispatchState === "queued"
        || current.observation?.status === "unavailable");
      this.#release(current.id, unproven ? "busy" : "timeout");
      if (unproven) return;
      const marked = this.store.requestAbort({ opportunityId: current.id, reason: "GROUP_TURN_TIMEOUT" });
      if (!marked) return;
      if (marked.runId) void this.#abort(marked);
      else this.#pending(marked, "execution", "GROUP_TURN_TIMEOUT");
    });
  }

  #armRelease(opportunityId, delayMs) {
    if (this.timers.has(`release:${opportunityId}`)) return;
    this.#timer(`release:${opportunityId}`, delayMs, () => this.#release(opportunityId, "working"));
  }

  // 让出发言位：已经写出的正文先发到群里，下一位开始发言；回合在后台继续。
  #release(opportunityId, reason) {
    const current = this.store.getOpportunity(opportunityId);
    if (!current || current.state !== "running" || !current.floor || current.released) return;
    const text = reason === "working" ? redactGrantTokens(this.drafts?.draftFor(opportunityId) ?? null) : null;
    const result = this.store.releaseTurn({ opportunityId, reason, fence: this.fence, text: validText(text) ? text : null });
    this.#cancelTimer(`idle:${opportunityId}`);
    this.#cancelTimer(`release:${opportunityId}`);
    if (result.changed) { this.onChanged(result.groupId); this.wake(result.groupId); }
  }

  /** 草稿 / 活动观察到的新动静：重置无动静计时；开始用工具后按时让位。 */
  onActivity(opportunityId, activity) {
    if (this.fence === null || !activity) return;
    const current = this.store.getOpportunity(opportunityId);
    if (!current || current.state !== "running" || !current.floor || current.released) return;
    this.#armInactivity(current);
    const starts = [activity.tool, ...(activity.recentTools ?? [])].filter(Boolean).map(tool => tool.startedAt)
      .filter(Number.isFinite);
    if (starts.length) {
      const due = Math.min(...starts) + this.releaseAfterToolMs - this.store.now();
      this.#cancelTimer(`release:${opportunityId}`);
      this.#timer(`release:${opportunityId}`, due, () => this.#release(opportunityId, "working"));
    } else if (current.runKind === "external" && activity.streamGeneration) {
      // 报得出活动的外部成员按工具规则让位，不再用开始后固定时长的兜底。
      this.#cancelTimer(`release:${opportunityId}`);
    }
  }

  // ---- 外部成员回调 ----

  onExternalTerminal(opportunityId, outcome) {
    if (this.fence === null) return;
    const opportunity = this.store.getOpportunity(opportunityId);
    if (!opportunity || !["running", "waiting"].includes(opportunity.state) || opportunity.runKind !== "external") return;
    void this.#publishTurn(opportunity, { ...outcome, text: redactGrantTokens(outcome.text) }).catch((error) => this.onError(error));
  }

  onExternalResumed(opportunityId) {
    if (this.fence === null) return;
    const current = this.store.getOpportunity(opportunityId);
    if (current && current.state === "running") this.#armInactivity(current);
  }

  onExternalInteraction(opportunityId, attention) {
    if (this.fence === null || !attention?.request) return;
    this.#wait(opportunityId, { request: attention.request, context: null });
  }

  // 隐藏回合请求审批 / 补充输入：回合进入等待、让出发言位，交互卡挂到群上；
  // 用户回应后原运行继续，终态照常提交。
  #wait(opportunityId, interaction) {
    const result = this.store.markWaiting({ opportunityId, interaction });
    if (!result?.changed) return;
    this.#clearTimers(opportunityId);
    this.onChanged(result.opportunity.groupId);
    this.wake(result.opportunity.groupId);
  }

  /** 用户对交互卡的回应（只经用户入口；答案不进群库）。 */
  async respondInteraction({ opportunityId, requestId, response, operationId }) {
    const opportunity = this.store.getOpportunity(opportunityId);
    const interaction = opportunity?.interaction;
    if (!opportunity || opportunity.state !== "waiting" || opportunity.abortReason || interaction?.status !== "pending"
      || interaction.request.requestId !== requestId) {
      throw Object.assign(new Error("expired"), { code: "GROUP_CHAT_INTERACTION_EXPIRED" });
    }
    const checked = validateInteractiveResponseV1(interaction.request, response);
    if (opportunity.runKind === "external") {
      await this.externalExecutor.respond(opportunity, { requestId, response: checked, operationId });
    } else {
      await this.executor.respond({ runId: opportunity.runId, request: interaction.request, response: checked, operationId });
    }
    const updated = this.store.markInteractionResponded({ opportunityId, requestId }) ?? this.store.getOpportunity(opportunityId);
    if (updated?.state === "running") this.onChanged(updated.groupId);
  }

  // ---- 原生运行 ----

  async #track(opportunityId, run, sessionKey) {
    let recorded = this.store.recordRun({ opportunityId, runId: run.id, sessionKey, fence: this.fence });
    if (!recorded) return;
    let current = run;
    try { current = this.executor.getRun(run.id) || run; } catch (error) { this.onError(error); }
    this.store.recordExecutionObservation({ kind: "turn", id: recorded.id, runId: run.id, status: current.status, fence: this.fence });
    if (recorded.state === "waiting" && current.status === "running" && recorded.interaction) {
      this.store.markInteractionResponded({ opportunityId, requestId: recorded.interaction.request.requestId });
    }
    recorded = this.store.getOpportunity(opportunityId);
    this.drafts?.watch(opportunityId);
    if (recorded.abortReason) void this.#abort(recorded);
    if (TERMINAL_STATUSES.has(current.status)) this.onRunTerminal(current);
    else if (WAITING_STATUSES.has(current.status)) this.onRunInteraction(current, null);
  }

  #opportunityForRun(run) {
    const target = groupRunTarget(run);
    if (target?.kind !== "turn") return null;
    const opportunity = this.store.getOpportunity(target.opportunityId);
    if (!opportunity || this.fence === null || this.fence !== this.store.getDriverFence() || opportunity.fence !== this.fence
      || !["running", "waiting"].includes(opportunity.state)
      || (opportunity.runId && opportunity.runId !== run.id)) return null;
    return opportunity;
  }

  onRunTerminal(run) {
    if (this.fence === null) return;
    const opportunity = this.#opportunityForRun(run);
    if (!opportunity) return;
    // 上下文放不下、自动压缩 / 摘要也没成功，请求没发给模型：换一条新会话接着答（只换一次）。
    if (run.status === "failed" && !run.runtimeTurnRef && RENEWABLE_CONTEXT_ERRORS.test(run.errorCode ?? "")) {
      const renewed = this.store.renewSessionForTurn({ opportunityId: opportunity.id, fence: this.fence });
      if (renewed) {
        this.drafts?.forget(opportunity.id);
        this.#clearTimers(opportunity.id);
        this.onChanged(renewed.groupId);
        this.wake(renewed.groupId);
        return;
      }
    }
    let text = null;
    if (run.status === "completed" && !opportunity.abortReason) {
      this.store.recordExecutionObservation({ kind: "turn", id: opportunity.id, runId: run.id, status: "completed" });
      let reason = "GROUP_TURN_RESULT_EMPTY";
      try { text = this.executor.finalText(run); } catch (error) {
        this.onError(error);
        reason = "GROUP_TURN_RESULT_UNAVAILABLE";
      }
      if (!validText(text) || (!text.trim() && !opportunity.postedText)) {
        this.#pending(opportunity, "result", text && !validText(text) ? "GROUP_TURN_RESULT_UNAVAILABLE" : reason);
        return;
      }
    }
    let responseMetadata = null;
    try { responseMetadata = this.executor.responseMetadata?.(run) ?? null; } catch {}
    void this.#publishTurn(opportunity, { status: run.status, text, errorCode: run.errorCode ?? null, responseMetadata })
      .catch((error) => this.onError(error));
  }

  // 原生运行请求审批 / 补充输入：转成群内交互卡；无法规范化的请求才取消本回合，避免群卡住。
  onRunInteraction(run, interaction = null) {
    if (this.fence === null) return;
    // resolved 只表示请求已处理（用户回应或过期）；回合继续，终态照常提交。
    if (interaction && interaction.phase !== "requested") return;
    const opportunity = this.#opportunityForRun(run);
    if (!opportunity) return;
    let request = null;
    try { request = this.executor.interactionRequest?.(run, interaction) ?? null; } catch { request = null; }
    if (request) { this.#wait(opportunity.id, request); return; }
    const marked = this.store.requestAbort({ opportunityId: opportunity.id, reason: "GROUP_TURN_INTERACTION_UNSUPPORTED" });
    if (marked) void this.#abort(marked);
  }

  async abortAll(opportunities) {
    for (const opportunity of opportunities) {
      this.#cancelTimer(`idle:${opportunity.id}`);
      this.#cancelTimer(`release:${opportunity.id}`);
      if (opportunity.runId) void this.#abort(opportunity);
      else this.#armAbortGrace(opportunity, this.abortGraceMs);
    }
  }

  async deleteGroup(groupId) {
    if (this.fence === null) return;
    this.directory?.cancelGroup?.(groupId);
    if (this.store.groupLifecycle(groupId) === "deleted") return;
    await this.abortAll(this.store.runningOpportunities().filter(turn => turn.groupId === groupId));
    if (this.externalExecutor?.stopGroup && !this.deletionChecks.has(groupId)) {
      const fence = this.fence;
      const check = Promise.resolve().then(() => this.externalExecutor.stopGroup(groupId)).then(result => {
        if (this.fence !== fence || this.store.getDriverFence() !== fence || !result.confirmed) return;
        if (this.store.confirmGroupDeletionHosts(groupId, result.digest)) {
          this.store.finishGroupDeletion(groupId); this.onChanged(groupId);
        }
      }).catch(error => this.onError(error)).finally(() => {
        if (this.deletionChecks.get(groupId) === check) this.deletionChecks.delete(groupId);
      });
      this.deletionChecks.set(groupId, check);
    }
    const key = `delete:${groupId}`;
    this.#cancelTimer(key);
    const result = this.store.finishGroupDeletion(groupId);
    this.onChanged(groupId);
    if (result.status === "deleting") this.#timer(key, this.reconcileMs, () => void this.deleteGroup(groupId).catch(error => this.onError(error)));
  }

  async #abort(opportunity) {
    if (this.fence === null || this.fence !== this.store.getDriverFence() || opportunity.fence !== this.fence) return;
    const current = this.store.requestAbort({ opportunityId: opportunity.id,
      reason: opportunity.abortReason || "GROUP_TURN_TIMEOUT" });
    if (!current) return;
    // 先挂兜底再请求取消。没有停止证据时保持占用并进入待核对，不能开放新一轮写入。
    this.#armAbortGrace(current, this.abortGraceMs);
    try {
      if (opportunity.runKind === "external") await this.externalExecutor?.cancel(opportunity);
      else await this.executor.abort({ sessionKey: opportunity.sessionKey, runId: opportunity.runId });
    } catch (error) {
      this.onError(error);
    }
  }

  // 请求停止后一段时间仍没有终态：转入待核对，按原执行身份继续读取。
  #armAbortGrace(opportunity, delayMs) {
    this.#timer(opportunity.id, delayMs, () => {
      const current = this.store.getOpportunity(opportunity.id);
      if (!current || !["running", "waiting"].includes(current.state)) return;
      const marked = this.store.requestAbort({ opportunityId: current.id, reason: current.abortReason || "GROUP_TURN_TIMEOUT" });
      if (marked) this.#pending(marked, "execution", marked.abortReason);
    });
  }

  #pending(opportunity, type, reason) {
    const marked = this.store.markReconciliation({ kind: "turn", id: opportunity.id, runId: opportunity.runId,
      type, reason, cancelRequested: Boolean(opportunity.abortReason), fence: this.fence });
    if (!marked) return;
    this.drafts?.forget(opportunity.id);
    if (marked.changed) { this.onChanged(marked.groupId); this.wake(marked.groupId); }
    if (opportunity.runKind !== "external") this.#timer(opportunity.id, this.reconcileMs,
      () => void this.reconcile(opportunity.id).catch((error) => this.onError(error)));
  }

  /** 只读取原执行的状态 / 结果；自动核对与用户“重新读取”共用，不启动模型。 */
  async reconcile(opportunityId) {
    if (this.fence === null || this.fence !== this.store.getDriverFence()) return;
    const opportunity = this.store.getOpportunity(opportunityId);
    if (!opportunity || !["running", "waiting"].includes(opportunity.state)) return;
    if (opportunity.runKind === "external") return this.externalExecutor?.reconcile(opportunity);
    let run;
    try { run = opportunity.runId ? this.executor.getRun(opportunity.runId)
      : this.executor.findRun({ operationId: opportunity.operationId, sessionKey: opportunity.sessionKey }); } catch (error) { this.onError(error); }
    if (run) {
      if (run.status === "completed" && opportunity.recovery?.type === "result" && !opportunity.abortReason
        && this.executor.recoverFinalText) {
        const fence = this.fence;
        const assertCurrent = () => {
          const current = this.store.getOpportunity(opportunity.id);
          const view = this.store.getGroup(opportunity.groupId);
          if (this.fence !== fence || this.store.getDriverFence() !== fence || current?.fence !== fence
            || !["running", "waiting"].includes(current?.state) || current.runId !== run.id || current.abortReason
            || view.group.status !== "active" || !view.members.some(member => member.id === current.memberId && member.state === "active")) {
            throw Object.assign(new Error("group result recovery changed"), { code: "GROUP_TURN_RESULT_UNAVAILABLE" });
          }
        };
        try { assertCurrent(); await this.executor.recoverFinalText(run, assertCurrent); }
        catch (error) { this.onError(error); }
        if (this.fence !== fence) return;
      }
      await this.#track(opportunity.id, run, opportunity.sessionKey ?? run.sourceId); return;
    }
    this.#pending(opportunity, "execution", opportunity.abortReason || "GROUP_TURN_EXECUTION_UNCONFIRMED");
  }

  /** 正在回复的成员当前草稿（只在内存，不进群日志）。 */
  draftFor(opportunityId) {
    return this.drafts?.draftFor(opportunityId) ?? null;
  }

  activityFor(opportunityId) {
    return this.drafts?.activityFor(opportunityId) ?? null;
  }

  // 成员的回复可以带引用和附件（约定见 group-reply-format）。附件只认它自己工作区里的文件，先存进媒体库
  // 再提交回合；读不到的附件行原样留在正文里，让大家看到它原本想发什么。
  async #publishTurn(opportunity, outcome) {
    const parsed = outcome.status === "completed" && typeof outcome.text === "string" ? parseMemberReply(outcome.text) : null;
    if (!parsed || (parsed.replyToSeq === null && parsed.attachmentLines.length === 0)) {
      this.#complete(opportunity.id, outcome);
      return;
    }
    const rootRef = opportunity.runKind === "external" ? { external: opportunity.external, groupId: opportunity.groupId }
      : { sessionKey: opportunity.sessionKey };
    const attachments = [];
    const unresolved = [];
    for (const item of parsed.attachmentLines) {
      let attachment = null;
      try {
        attachment = this.ingestAttachment ? await this.ingestAttachment(rootRef, item.path, `group-reply:${opportunity.id}`) : null;
      } catch (error) { this.onError(error); }
      if (!attachment) unresolved.push(item.line.trim());
      else if (!attachments.some((existing) => existing.id === attachment.id)) attachments.push(attachment);
    }
    this.#complete(opportunity.id, { ...outcome, text: [parsed.body, ...unresolved].filter(Boolean).join("\n"),
      attachments, replyToSeq: parsed.replyToSeq });
  }

  #complete(opportunityId, outcome) {
    this.drafts?.forget(opportunityId);
    this.#clearTimers(opportunityId);
    const result = this.store.completeTurn({ opportunityId, fence: this.fence, ...outcome });
    if (["running", "waiting"].includes(result.state)) {
      // 去掉引用 / 附件标记后仍可能没有可见正文；继续读原结果，不丢掉自动核对定时器。
      const pending = this.store.getOpportunity(opportunityId);
      if (pending?.recovery) {
        if (pending.runKind === "external") this.externalExecutor?.resume(pending);
        else this.#timer(opportunityId, this.reconcileMs, () => void this.reconcile(opportunityId).catch((error) => this.onError(error)));
      }
    }
    if (result.groupId) {
      this.onChanged(result.groupId);
      this.wake(result.groupId);
    }
  }

  async recover() {
    for (const opportunity of this.store.runningOpportunities()) {
      const adopted = this.store.adopt({ opportunityId: opportunity.id, fence: this.fence });
      if (!adopted) continue;
      const member = this.store.getGroup(adopted.groupId).members.find((item) => item.id === adopted.memberId);
      if (member && !member.profileId) {
        // 外部回合：已登记执行身份就按原身份继续核对；从未登记说明启动请求没发出，回到原位置。
        if (adopted.external && this.externalExecutor) {
          this.externalExecutor.resume(adopted);
          if (adopted.abortReason) void this.#abort(adopted);
          else this.#armInactivity(adopted);
          this.drafts?.watch(adopted.id);
        } else this.store.requeue({ opportunityId: adopted.id });
        continue;
      }
      let run = null;
      try {
        run = adopted.runId ? this.executor.getRun(adopted.runId)
          : this.executor.findRun({ operationId: adopted.operationId, sessionKey: adopted.sessionKey });
      } catch (error) { this.onError(error); }
      if (!run) {
        if (adopted.runId) this.#pending(adopted, "execution", "GROUP_TURN_EXECUTION_UNCONFIRMED");
        else this.store.requeue({ opportunityId: adopted.id });
        continue;
      }
      this.#armInactivity(adopted);
      await this.#track(adopted.id, run, adopted.sessionKey ?? run.sourceId);
    }
    for (const groupId of this.store.groupsWithQueuedTurns()) this.wake(groupId);
  }
}

module.exports = { GroupChatDriver };
