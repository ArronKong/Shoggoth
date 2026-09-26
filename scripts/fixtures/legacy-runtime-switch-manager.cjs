// Historical migration fixture only. Production switching is owned by SessionRuntimeController.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  atomicWritePrivateFile,
  preparePrivateParent,
  readPrivateFile,
  recoverInterruptedPrivateFile,
  statIfExists,
} = require("../../app/agent-service/private-file");
const { runtimeBinding } = require("../../app/agent-service/runtime-adapter");
const { ACTIVE_WORK_RUN_STATUSES } = require("../../app/agent-service/work-run");
const { serviceError } = require("../../app/agent-service/security");

const RUNTIME_SWITCH_VERSION = 1;
const MAX_SWITCH_BYTES = 1024 * 1024;
const STATES = new Set(["prepared", "candidate_verified", "binding_committed", "rollback_required"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

function switchError(code, message) { return serviceError(code, message); }
function exact(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}
function clone(value) { return value === null ? null : structuredClone(value); }
function sameBinding(left, right) {
  return left?.runtime === right.runtime
    && left?.runtimeProfileId === right.runtimeProfileId
    && left?.runtimeAccountId === right.runtimeAccountId;
}
function profileBinding(profile) {
  return runtimeBinding({
    runtime: profile.runtime,
    runtimeProfileId: profile.runtimeProfileId,
    runtimeAccountId: profile.runtimeAccountId,
  });
}
function validOperation(value, corrupt = false) {
  const fail = () => { throw switchError(corrupt ? "RUNTIME_SWITCH_CORRUPT" : "RUNTIME_SWITCH_INVALID", "Runtime switch operation 无效"); };
  if (!exact(value, [
    "operationId", "profileId", "previousBinding", "candidateBinding", "contextSnapshotId",
    "transcriptSessionId", "state", "createdAt", "updatedAt",
  ]) || typeof value.operationId !== "string" || !ID_PATTERN.test(value.operationId)
    || typeof value.profileId !== "string" || !ID_PATTERN.test(value.profileId)
    || typeof value.contextSnapshotId !== "string" || !/^ctx-[a-f0-9]{64}$/u.test(value.contextSnapshotId)
    || typeof value.transcriptSessionId !== "string" || !ID_PATTERN.test(value.transcriptSessionId)
    || !STATES.has(value.state)
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
    || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < value.createdAt) fail();
  let previousBinding;
  let candidateBinding;
  try {
    previousBinding = runtimeBinding(value.previousBinding);
    candidateBinding = runtimeBinding(value.candidateBinding);
  } catch { fail(); }
  if (sameBinding(previousBinding, candidateBinding)) fail();
  return { ...structuredClone(value), previousBinding, candidateBinding };
}
function validContainer(value) {
  if (!exact(value, ["version", "revision", "operation"])
    || value.version !== RUNTIME_SWITCH_VERSION || !Number.isSafeInteger(value.revision)
    || value.revision < 0 || (value.operation !== null && typeof value.operation !== "object")) {
    throw switchError("RUNTIME_SWITCH_CORRUPT", "Runtime switch journal 损坏");
  }
  return {
    version: RUNTIME_SWITCH_VERSION,
    revision: value.revision,
    operation: value.operation === null ? null : validOperation(value.operation, true),
  };
}

class RuntimeSwitchJournal {
  constructor(options = {}) {
    if (!options.paths?.runtimeSwitchPath || !options.paths?.stateDir
      || path.dirname(options.paths.runtimeSwitchPath) !== options.paths.stateDir) {
      throw switchError("RUNTIME_SWITCH_PATHS_REQUIRED", "Runtime switch journal 路径无效");
    }
    this.paths = options.paths;
    this.fs = options.fs || fs;
    this.atomicWrite = options.atomicWrite || atomicWritePrivateFile;
    this.container = { version: RUNTIME_SWITCH_VERSION, revision: 0, operation: null };
    this.opened = false;
    this.commitUncertain = false;
  }
  open() {
    if (this.opened) return this;
    preparePrivateParent(this.paths.runtimeSwitchPath, this.paths.trustedRoot, this.fs);
    const recovery = recoverInterruptedPrivateFile(this.paths.runtimeSwitchPath, {
      fs: this.fs, trustedRoot: this.paths.trustedRoot,
    });
    const stat = statIfExists(this.fs, this.paths.runtimeSwitchPath);
    if (stat && stat.size > MAX_SWITCH_BYTES) throw switchError("RUNTIME_SWITCH_CORRUPT", "Runtime switch journal 超限");
    try {
      this.container = stat ? validContainer(JSON.parse(readPrivateFile(
        this.paths.runtimeSwitchPath, { fs: this.fs, maxBytes: MAX_SWITCH_BYTES },
      ).toString("utf8"))) : { version: RUNTIME_SWITCH_VERSION, revision: 0, operation: null };
    } catch (error) {
      if (error?.code === "RUNTIME_SWITCH_CORRUPT") throw error;
      throw switchError("RUNTIME_SWITCH_CORRUPT", "Runtime switch journal 无法读取");
    }
    this.commitUncertain = recovery === "uncertain";
    this.opened = true;
    return this;
  }
  close() { this.opened = false; }
  get() { this._assertOpen(); return clone(this.container.operation); }
  put(operation) { this._commit(validOperation(operation)); return this.get(); }
  clear() { this._commit(null); }
  _commit(operation) {
    this._assertOpen();
    const candidate = {
      version: RUNTIME_SWITCH_VERSION,
      revision: this.container.revision + 1,
      operation,
    };
    try {
      this.atomicWrite(this.paths.runtimeSwitchPath, `${JSON.stringify(candidate)}\n`, {
        fs: this.fs, trustedRoot: this.paths.trustedRoot,
      });
    } catch (error) {
      if (error?.committed || error?.committedUncertain) {
        this.commitUncertain = true;
        throw switchError("RUNTIME_SWITCH_COMMIT_UNCERTAIN", "Runtime switch journal 提交状态不确定");
      }
      throw error;
    }
    this.container = candidate;
  }
  _assertOpen() {
    if (this.commitUncertain) throw switchError("RUNTIME_SWITCH_COMMIT_UNCERTAIN", "Runtime switch journal 必须重新打开");
    if (!this.opened) throw switchError("RUNTIME_SWITCH_CLOSED", "Runtime switch journal 未打开");
  }
}

// Diagnostic/legacy canary utility only. Production handoff uses ChatSessionStore
// and never routes through this Profile-default switch manager.
class RuntimeSwitchManager {
  constructor(options = {}) {
    for (const [value, methods, label] of [
      [options.productStore, ["getAgentProfile", "getAgentRuntimeBindings", "setAgentDefaultBinding", "listWorkRuns"], "ProductStore"],
      [options.runtimeManager, ["acquire", "stop"], "RuntimeManager"],
      [options.contextSnapshotStore, ["get"], "ContextSnapshotStore"],
      [options.transcriptStore, ["listEvents"], "TranscriptStore"],
    ]) if (!value || methods.some((method) => typeof value[method] !== "function")) {
      throw new TypeError(`RuntimeSwitchManager 需要 ${label}`);
    }
    if (typeof options.assertExclusive !== "function") {
      throw new TypeError("RuntimeSwitchManager 需要 exclusive updater fence");
    }
    this.productStore = options.productStore;
    this.runtimeManager = options.runtimeManager;
    this.contextSnapshotStore = options.contextSnapshotStore;
    this.transcriptStore = options.transcriptStore;
    this.assertExclusive = options.assertExclusive;
    this.now = options.now || Date.now;
    this.randomUUID = options.randomUUID || require("node:crypto").randomUUID;
    this.checkpoint = options.checkpoint || (() => {});
    this.journal = options.journal || new RuntimeSwitchJournal({ paths: options.paths });
  }
  open() { this.journal.open(); return this; }
  close() { this.journal.close(); }
  _assertNoActiveRuns(profileId) {
    const active = this.productStore.listWorkRuns({ profileId })
      .filter((run) => ACTIVE_WORK_RUN_STATUSES.has(run.status));
    if (active.length > 0) {
      throw switchError("RUNTIME_SWITCH_ACTIVE_RUNS", "Runtime 切换前必须 drain 或 interrupt active Run");
    }
  }
  _selectBinding(profileId, binding, expectedRevision) {
    const state = this.productStore.getAgentRuntimeBindings(profileId);
    const selected = state.bindings.find((candidate) => sameBinding(candidate, binding));
    if (!selected || !selected.enabled) throw switchError("RUNTIME_SWITCH_ACCOUNT_UNSUPPORTED", "候选必须是此 Agent 已存在且启用的 Binding");
    this.productStore.setAgentDefaultBinding(profileId, selected.id, { revision: expectedRevision ?? state.revision });
  }
  _time(previous = 0) {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < previous) throw switchError("RUNTIME_SWITCH_TIME_INVALID", "Runtime switch 时钟无效");
    return value;
  }
  async switchProfile(input = {}) {
    this.assertExclusive();
    if (typeof input.verifyCanary !== "function" || !Number.isSafeInteger(input.expectedProfileUpdatedAt)) {
      throw switchError("RUNTIME_SWITCH_INVALID", "Runtime switch 缺少 canary verifier 或 profile revision");
    }
    const candidateBinding = runtimeBinding(input.candidateBinding);
    const profile = this.productStore.getAgentProfile(input.profileId);
    if (!profile || profile.updatedAt !== input.expectedProfileUpdatedAt) {
      throw switchError("RUNTIME_SWITCH_PROFILE_CONFLICT", "Agent Profile 已变化");
    }
    const previousBinding = profileBinding(profile);
    if (sameBinding(previousBinding, candidateBinding)) throw switchError("RUNTIME_SWITCH_INVALID", "candidate 与当前 Runtime 相同");
    const bindingState = this.productStore.getAgentRuntimeBindings(profile.id);
    if (!bindingState.bindings.some((binding) => binding.enabled && sameBinding(binding, candidateBinding))) {
      throw switchError("RUNTIME_SWITCH_ACCOUNT_UNSUPPORTED", "候选必须是此 Agent 已存在且启用的 Binding");
    }
    this._assertNoActiveRuns(profile.id);
    const snapshot = this.contextSnapshotStore.get(profile.id, input.contextSnapshotId);
    if (!snapshot) throw switchError("RUNTIME_SWITCH_CONTEXT_MISSING", "Context Snapshot 不存在");
    const transcript = this.transcriptStore.listEvents(profile.id, input.transcriptSessionId);
    const operationId = input.operationId || `switch-${this.randomUUID()}`;
    const createdAt = this._time();
    let operation = this.journal.put({
      operationId,
      profileId: profile.id,
      previousBinding,
      candidateBinding,
      contextSnapshotId: snapshot.id,
      transcriptSessionId: input.transcriptSessionId,
      state: "prepared",
      createdAt,
      updatedAt: createdAt,
    });
    this.checkpoint("prepared", operation);
    let candidateAcquired = false;
    try {
      const handle = await this.runtimeManager.acquire(candidateBinding, {
        permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" },
        workspace: input.workspace ?? profile.defaultCwd,
      });
      candidateAcquired = true;
      if (!handle || typeof handle.sessionStart !== "function" || typeof handle.turnStart !== "function") {
        throw switchError("RUNTIME_SWITCH_CAPABILITY_MISSING", "candidate Runtime 缺少 canary capability");
      }
      const started = await handle.sessionStart({
        source: `runtime-switch:${operationId}`,
        persistent: false,
        developerInstructions: snapshot.developerInstructions,
        model: profile.defaultModel,
        cwd: input.workspace ?? profile.defaultCwd,
        permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" },
      });
      const sessionId = started?.session?.id;
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw switchError("RUNTIME_SWITCH_CANARY_FAILED", "candidate Runtime 未返回 session");
      }
      const startedTurn = await handle.turnStart({
        sessionId,
        operationId,
        prompt: "Shoggoth runtime compatibility canary. Do not call tools or modify external state.",
        context: snapshot.dynamicContext,
        model: profile.defaultModel,
        cwd: input.workspace ?? profile.defaultCwd,
        permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" },
      });
      const canary = await input.verifyCanary({
        handle,
        binding: candidateBinding,
        session: started.session,
        turn: startedTurn?.turn,
        snapshot: structuredClone(snapshot),
        transcript: structuredClone(transcript),
      });
      if (!exact(canary, ["ok"]) || canary.ok !== true) {
        throw switchError("RUNTIME_SWITCH_CANARY_FAILED", "candidate Runtime canary 未通过");
      }
      operation = this.journal.put({
        ...operation, state: "candidate_verified", updatedAt: this._time(operation.updatedAt),
      });
      this.checkpoint("candidate-verified", operation);
      this.assertExclusive();
      this._assertNoActiveRuns(profile.id);
      const current = this.productStore.getAgentProfile(profile.id);
      if (!current || current.updatedAt !== profile.updatedAt
        || !sameBinding(profileBinding(current), previousBinding)) {
        throw switchError("RUNTIME_SWITCH_PROFILE_CONFLICT", "Agent Profile 在 canary 期间变化");
      }
      this._selectBinding(profile.id, candidateBinding, bindingState.revision);
      operation = this.journal.put({
        ...operation, state: "binding_committed", updatedAt: this._time(operation.updatedAt),
      });
      this.checkpoint("binding-committed", operation);
      await this.runtimeManager.stop(previousBinding);
      this.checkpoint("previous-runtime-stopped", operation);
      this.journal.clear();
      return this.productStore.getAgentProfile(profile.id);
    } catch (error) {
      if (error?.simulatedCrash === true) throw error;
      const cleanup = [];
      try {
        const current = this.productStore.getAgentProfile(profile.id);
        if (current && sameBinding(profileBinding(current), candidateBinding)) {
          this._selectBinding(profile.id, previousBinding, current.bindingsRevision);
        }
      } catch (rollbackError) { cleanup.push(rollbackError); }
      if (candidateAcquired) {
        try { await this.runtimeManager.stop(candidateBinding); } catch (stopError) { cleanup.push(stopError); }
      }
      try {
        if (cleanup.length === 0) this.journal.clear();
        else this.journal.put({
          ...operation, state: "rollback_required", updatedAt: this._time(operation.updatedAt),
        });
      } catch (journalError) { cleanup.push(journalError); }
      if (cleanup.length > 0) {
        const aggregate = new AggregateError([error, ...cleanup], "Runtime switch rollback incomplete");
        aggregate.code = "RUNTIME_SWITCH_ROLLBACK_INCOMPLETE";
        throw aggregate;
      }
      throw error;
    }
  }
  async recover() {
    this.assertExclusive();
    const operation = this.journal.get();
    if (!operation) return null;
    const profile = this.productStore.getAgentProfile(operation.profileId);
    if (!profile) throw switchError("RUNTIME_SWITCH_RECOVERY_CONFLICT", "Runtime switch Profile 不存在");
    const current = profileBinding(profile);
    if (operation.state === "binding_committed" && sameBinding(current, operation.candidateBinding)) {
      await this.runtimeManager.stop(operation.previousBinding);
      this.journal.clear();
      return { action: "commit-finished", profile: this.productStore.getAgentProfile(profile.id) };
    }
    if (sameBinding(current, operation.candidateBinding)) {
      this._assertNoActiveRuns(profile.id);
      this._selectBinding(profile.id, operation.previousBinding, profile.bindingsRevision);
    } else if (!sameBinding(current, operation.previousBinding)) {
      throw switchError("RUNTIME_SWITCH_RECOVERY_CONFLICT", "Runtime binding 与 journal 不一致");
    }
    await this.runtimeManager.stop(operation.candidateBinding);
    this.journal.clear();
    return { action: "rolled-back", profile: this.productStore.getAgentProfile(profile.id) };
  }
}

module.exports = {
  RUNTIME_SWITCH_VERSION,
  RuntimeSwitchJournal,
  RuntimeSwitchManager,
  validContainer,
};
