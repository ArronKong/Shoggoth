#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const {
  DEFAULT_AGENT_PROFILE_ID,
  JsonlProductStore,
} = require(path.join(ROOT, "app", "agent-service", "product-store.js"));
const {
  ACTIVE_WORK_RUN_STATUSES,
  TERMINAL_WORK_RUN_STATUSES,
  WORK_RUN_STATUSES,
  createWorkDispatcher,
} = require(path.join(ROOT, "app", "agent-service", "work-run.js"));
const { SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID } = require(path.join(
  ROOT, "app", "agent-service", "runtime-account.js",
));
const { resolveServicePaths } = require(path.join(ROOT, "app", "agent-service", "paths.js"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function fixture(now = (() => Date.now())) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-runs-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const store = new JsonlProductStore({ paths, now });
  store.open();
  return { paths, store, dispatcher: createWorkDispatcher({ store, now }) };
}

function runInput(id, overrides = {}) {
  return {
    id,
    source: "chat",
    sourceId: `source-${id}`,
    idempotencyKey: `idem-${id}`,
    profileId: DEFAULT_AGENT_PROFILE_ID,
    workspace: `/tmp/workspace-${id}`,
    ...overrides,
  };
}

function runtimePatch(sessionId, turnId = null, runtimeProfileId = `shoggoth-${DEFAULT_AGENT_PROFILE_ID}`) {
  const binding = {
    runtime: "codex",
    runtimeProfileId,
    runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
  };
  return {
    runtimeSessionRef: sessionId === null ? null : { ...binding, sessionId },
    runtimeTurnRef: turnId === null ? null : { ...binding, sessionId, turnId },
  };
}

test("WorkRun 状态集合、完整字段与同 key 幂等", () => {
  assert.deepEqual(WORK_RUN_STATUSES, [
    "queued", "starting", "running", "waiting_approval", "waiting_input",
    "completed", "failed", "canceled", "interrupted", "skipped",
  ]);
  const clock = { value: 100 };
  const { store, dispatcher } = fixture(() => clock.value);
  const first = dispatcher.enqueue(runInput("run-one"));
  const duplicate = dispatcher.enqueue(runInput("different-id", {
    idempotencyKey: "idem-run-one",
    sourceId: "different-source",
  }));
  assert.deepEqual(duplicate, first);
  assert.deepEqual(first, {
    id: "run-one",
    source: "chat",
    sourceId: "source-run-one",
    idempotencyKey: "idem-run-one",
    profileId: DEFAULT_AGENT_PROFILE_ID,
    workspace: path.join(fs.realpathSync.native("/tmp"), "workspace-run-one"),
    status: "queued",
    contextSnapshotId: null,
    runtimeSessionRef: null,
    runtimeTurnRef: null,
    eventSeq: 1,
    waitingRequestId: null,
    startedAt: null,
    finishedAt: null,
    resultSummary: null,
    errorCode: null,
    retryOf: null,
  });
  assert.equal(dispatcher.listRuns().length, 1);
  assert.deepEqual(dispatcher.getRun("run-one"), first);
  store.close();
});

test("显式状态机接受合法迁移、更新时间与事件 seq 单调，拒绝非法迁移", () => {
  const clock = { value: 1_000 };
  const { store, dispatcher } = fixture(() => clock.value);
  dispatcher.enqueue(runInput("run-state"));
  clock.value += 1;
  const starting = dispatcher.admit("run-state").run;
  assert.equal(starting.startedAt, 1_001);
  clock.value += 1;
  const running = dispatcher.transition("run-state", "running", {
    ...runtimePatch("thread-state", "turn-state"),
  });
  clock.value += 1;
  const waiting = dispatcher.transition("run-state", "waiting_approval", {
    waitingRequestId: "approval-1",
  });
  clock.value += 1;
  const resumed = dispatcher.transition("run-state", "running", { waitingRequestId: null });
  clock.value += 1;
  const completed = dispatcher.transition("run-state", "completed", { resultSummary: "done" });
  assert.deepEqual(
    [starting, running, waiting, resumed, completed].map((run) => run.eventSeq),
    [2, 3, 4, 5, 6],
  );
  assert.equal(completed.finishedAt, 1_005);
  assert.equal(completed.resultSummary, "done");
  assert.equal(completed.waitingRequestId, null);
  assert.throws(
    () => dispatcher.transition("run-state", "running"),
    (error) => error.code === "INVALID_WORK_RUN_TRANSITION",
  );
  assert.throws(
    () => dispatcher.transition("run-state", "not-a-status"),
    (error) => error.code === "INVALID_WORK_RUN_STATUS",
  );
  assert.equal(ACTIVE_WORK_RUN_STATUSES.has("waiting_input"), true);
  assert.equal(TERMINAL_WORK_RUN_STATUSES.has("completed"), true);
  store.close();
});

test("已确认的额度拒绝可在 queued 阶段失败，不伪造开始时间或占用执行槽", () => {
  const { store, dispatcher } = fixture(() => 1000);
  dispatcher.enqueue(runInput("quota-rejected"));
  const rejected = dispatcher.transition("quota-rejected", "failed", { errorCode: "RUNTIME_QUOTA_EXHAUSTED" });
  assert.equal(rejected.startedAt, null);
  assert.equal(rejected.finishedAt, 1000);
  assert.equal(rejected.eventSeq, 2);
  assert.throws(() => dispatcher.admit(rejected.id), { code: "WORK_RUN_NOT_QUEUED" });
  dispatcher.enqueue(runInput("quota-retry"));
  assert.equal(dispatcher.admit("quota-retry").disposition, "started");
  store.close();
});

test("queued -> starting 只能经过 admit，public transition 不得绕过准入", () => {
  const { store, dispatcher } = fixture();
  dispatcher.enqueue(runInput("run-admission-gate"));
  assert.throws(
    () => dispatcher.transition("run-admission-gate", "starting"),
    (error) => error.code === "WORK_RUN_ADMISSION_REQUIRED",
  );
  assert.equal(dispatcher.getRun("run-admission-gate").status, "queued");
  store.close();
});

test("Store 层也拒绝 WorkRun aggregate eventSeq 回退或跳号", () => {
  const { store, dispatcher } = fixture();
  dispatcher.enqueue(runInput("run-seq"));
  const run = dispatcher.admit("run-seq").run;
  for (const eventSeq of [1, 4]) {
    assert.throws(
      () => store.putWorkRun({ ...run, eventSeq }),
      (error) => error.code === "WORK_RUN_EVENT_SEQ_CONFLICT",
    );
  }
  store.close();
});

test("同一 Runtime session 最多一个 active turn", () => {
  const { store, dispatcher } = fixture();
  store.putAgentProfile({
    ...store.getAgentProfile(DEFAULT_AGENT_PROFILE_ID),
    id: "profile-thread",
    agentId: "thread",
    runtimeProfileId: "thread",
    name: "Thread",
    isDefault: false,
    concurrency: { maxActive: 2, maxWorkspaceWrites: 2 },
  });
  dispatcher.enqueue(runInput("run-thread-a", { profileId: "profile-thread", workspace: "/tmp/a" }));
  dispatcher.enqueue(runInput("run-thread-b", { profileId: "profile-thread", workspace: "/tmp/b" }));
  dispatcher.admit("run-thread-a");
  dispatcher.transition("run-thread-a", "running", {
    ...runtimePatch("thread-shared", "turn-a", "thread"),
  });
  dispatcher.admit("run-thread-b");
  assert.throws(
    () => dispatcher.transition("run-thread-b", "running", {
      ...runtimePatch("thread-shared", "turn-b", "thread"),
    }),
    (error) => error.code === "THREAD_ACTIVE_TURN_CONFLICT",
  );
  dispatcher.transition("run-thread-a", "completed");
  assert.equal(
    dispatcher.transition("run-thread-b", "running", {
      ...runtimePatch("thread-shared", "turn-b", "thread"),
    }).status,
    "running",
  );
  store.close();
});

test("非空 Runtime session/turn 绑定不可清空或更换，waiting 与 terminal 保留绑定", () => {
  const { store, dispatcher } = fixture();
  dispatcher.enqueue(runInput("run-binding"));
  dispatcher.admit("run-binding");
  dispatcher.transition("run-binding", "running", {
    ...runtimePatch("thread-binding", "turn-binding"),
  });
  const waiting = dispatcher.transition("run-binding", "waiting_input", {
    waitingRequestId: "request-binding",
  });
  assert.equal(waiting.runtimeSessionRef?.sessionId, "thread-binding");
  assert.equal(waiting.runtimeTurnRef?.turnId, "turn-binding");
  for (const patch of [
    { runtimeSessionRef: null },
    { runtimeSessionRef: runtimePatch("thread-other").runtimeSessionRef },
    { runtimeTurnRef: null },
    { runtimeTurnRef: runtimePatch("thread-binding", "turn-other").runtimeTurnRef },
  ]) {
    assert.throws(
      () => dispatcher.transition("run-binding", "running", patch),
      (error) => error.code === "WORK_RUN_BINDING_IMMUTABLE",
    );
  }
  dispatcher.transition("run-binding", "running");
  const completed = dispatcher.transition("run-binding", "completed");
  assert.equal(completed.runtimeSessionRef?.sessionId, "thread-binding");
  assert.equal(completed.runtimeTurnRef?.turnId, "turn-binding");
  store.close();
});

test("同 workspace 默认只准入一个 writable Run：queue 明确保留 queued，reject 明确报错", () => {
  const { store, dispatcher } = fixture();
  dispatcher.enqueue(runInput("run-ws-a", { workspace: "/tmp/shared" }));
  dispatcher.enqueue(runInput("run-ws-b", {
    workspace: "/tmp/shared/../shared",
    profileId: DEFAULT_AGENT_PROFILE_ID,
  }));
  assert.equal(dispatcher.admit("run-ws-a").disposition, "started");
  const queued = dispatcher.admit("run-ws-b");
  assert.equal(queued.disposition, "queued");
  assert.equal(queued.reason, "WORKSPACE_WRITE_BUSY");
  assert.equal(queued.run.status, "queued");
  assert.throws(
    () => dispatcher.admit("run-ws-b", { onBusy: "reject" }),
    (error) => error.code === "WORKSPACE_WRITE_BUSY",
  );
  dispatcher.transition("run-ws-a", "running");
  dispatcher.transition("run-ws-a", "completed");
  assert.equal(dispatcher.admit("run-ws-b").run.status, "starting");
  store.close();
});

test("workspace 必须是非空路径字符串，symlink alias 不能绕过 writer 锁", () => {
  const { store, dispatcher } = fixture();
  for (const workspace of ["", { cwd: "/tmp/shared" }]) {
    assert.throws(
      () => dispatcher.enqueue(runInput(`run-invalid-ws-${typeof workspace}`, { workspace })),
      (error) => error.code === "INVALID_WORK_RUN",
    );
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-workspace-alias-"));
  const real = path.join(root, "real");
  const alias = path.join(root, "alias");
  fs.mkdirSync(real);
  fs.symlinkSync(real, alias);
  store.putAgentProfile({
    ...store.getAgentProfile(DEFAULT_AGENT_PROFILE_ID),
    id: "profile-alias",
    agentId: "alias",
    runtimeProfileId: "alias",
    name: "Alias",
    isDefault: false,
    concurrency: { maxActive: 2, maxWorkspaceWrites: 2 },
  });
  const realRun = dispatcher.enqueue(runInput("run-real", {
    profileId: "profile-alias", workspace: real,
  }));
  const aliasRun = dispatcher.enqueue(runInput("run-alias", {
    profileId: "profile-alias", workspace: alias,
  }));
  assert.equal(realRun.workspace, fs.realpathSync.native(real));
  assert.equal(aliasRun.workspace, realRun.workspace);
  assert.equal(dispatcher.admit("run-real").disposition, "started");
  const blocked = dispatcher.admit("run-alias");
  assert.equal(blocked.disposition, "queued");
  assert.equal(blocked.reason, "WORKSPACE_WRITE_BUSY");
  store.close();
});

test("workspace 最长已存在祖先 realpath 会折叠 symlink 下的 nested missing 后缀", () => {
  const { store, dispatcher } = fixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-workspace-missing-alias-"));
  const real = path.join(root, "real");
  const alias = path.join(root, "alias");
  fs.mkdirSync(real);
  fs.symlinkSync(real, alias);
  store.putAgentProfile({
    ...store.getAgentProfile(DEFAULT_AGENT_PROFILE_ID),
    id: "profile-missing-alias",
    agentId: "missing-alias",
    runtimeProfileId: "missing-alias",
    name: "Missing Alias",
    isDefault: false,
    concurrency: { maxActive: 2, maxWorkspaceWrites: 2 },
  });
  const canonicalMissing = path.join(fs.realpathSync.native(real), "nested", "missing");
  const realMissing = dispatcher.enqueue(runInput("run-real-missing", {
    profileId: "profile-missing-alias",
    workspace: path.relative(process.cwd(), path.join(real, "nested", "missing")),
  }));
  const aliasMissing = dispatcher.enqueue(runInput("run-alias-missing", {
    profileId: "profile-missing-alias",
    workspace: path.join(alias, "nested", "missing"),
  }));
  assert.equal(realMissing.workspace, canonicalMissing);
  assert.equal(aliasMissing.workspace, canonicalMissing);
  assert.equal(dispatcher.admit("run-real-missing").disposition, "started");
  const blocked = dispatcher.admit("run-alias-missing");
  assert.equal(blocked.reason, "WORKSPACE_WRITE_BUSY");
  store.close();
});

test("workspace 解析失败固定脱敏且不携带原始路径或 cause", () => {
  const { store, dispatcher } = fixture();
  const registeredValue = "m0i3registeredvalue-7f52c1";
  const workspace = path.join("/dev/null", registeredValue);
  let caught = null;
  try {
    dispatcher.enqueue(runInput("run-workspace-resolution-i3", { workspace }));
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  assert.equal(caught.code, "WORKSPACE_RESOLUTION_FAILED");
  assert.equal(caught.message, "无法解析 workspace");
  assert.equal(caught.cause, undefined);
  assert.equal(String(caught).includes(registeredValue), false);
  assert.equal(dispatcher.listRuns().length, 0);
  store.close();
});

test("enqueue 持久化 canonical execution workspace，symlink 改指不改变公开路径或制造 runtime 冲突", () => {
  const { store, dispatcher } = fixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-workspace-retarget-"));
  const realA = path.join(root, "real-a");
  const realB = path.join(root, "real-b");
  const alias = path.join(root, "alias");
  fs.mkdirSync(realA);
  fs.mkdirSync(realB);
  fs.symlinkSync(realA, alias);
  store.putAgentProfile({
    ...store.getAgentProfile(DEFAULT_AGENT_PROFILE_ID),
    id: "profile-retarget",
    agentId: "retarget",
    runtimeProfileId: "retarget",
    name: "Retarget",
    isDefault: false,
    concurrency: { maxActive: 2, maxWorkspaceWrites: 2 },
  });
  const runA = dispatcher.enqueue(runInput("run-retarget-alias", {
    profileId: "profile-retarget", workspace: alias,
  }));
  assert.equal(runA.workspace, fs.realpathSync.native(realA));
  assert.equal(dispatcher.admit("run-retarget-alias").disposition, "started");
  fs.unlinkSync(alias);
  fs.symlinkSync(realB, alias);
  assert.equal(dispatcher.getRun("run-retarget-alias").workspace, fs.realpathSync.native(realA));

  const runB = dispatcher.enqueue(runInput("run-retarget-real-b", {
    profileId: "profile-retarget", workspace: realB,
  }));
  assert.equal(runB.workspace, fs.realpathSync.native(realB));
  assert.equal(dispatcher.admit("run-retarget-real-b").disposition, "started");

  dispatcher.enqueue(runInput("run-retarget-real-a", {
    profileId: "profile-retarget", workspace: realA,
  }));
  const blocked = dispatcher.admit("run-retarget-real-a");
  assert.equal(blocked.disposition, "queued");
  assert.equal(blocked.reason, "WORKSPACE_WRITE_BUSY");
  store.close();
});

test("transition 维护 WorkRun 组合不变量并抵御时钟回拨", () => {
  const clock = { value: 1_000 };
  const { store, dispatcher } = fixture(() => clock.value);
  dispatcher.enqueue(runInput("run-clock"));
  const starting = dispatcher.admit("run-clock").run;
  assert.equal(starting.startedAt, 1_000);
  clock.value = 900;
  const running = dispatcher.transition("run-clock", "running");
  assert.equal(running.startedAt, 1_000);
  assert.throws(
    () => dispatcher.transition("run-clock", "waiting_input"),
    (error) => error.code === "STORE_INVALID_RECORD",
  );
  const waiting = dispatcher.transition("run-clock", "waiting_input", {
    waitingRequestId: "request-clock",
  });
  assert.equal(waiting.finishedAt, null);
  clock.value = 800;
  const interrupted = dispatcher.transition("run-clock", "interrupted", {
    errorCode: "CLOCK_INTERRUPTED",
  });
  assert.equal(interrupted.finishedAt, 1_000);
  assert.equal(interrupted.waitingRequestId, null);
  assert.equal(interrupted.errorCode, "CLOCK_INTERRUPTED");

  dispatcher.enqueue(runInput("run-cancel-before-start"));
  const canceled = dispatcher.transition("run-cancel-before-start", "canceled");
  assert.equal(canceled.startedAt, null);
  assert.equal(canceled.finishedAt, 800);
  assert.equal(canceled.errorCode, null);
  store.close();
});

test("profile maxActive 准入与只读 Run 不占 workspace writer 名额", () => {
  const { store, dispatcher } = fixture();
  store.putAgentProfile({
    ...store.getAgentProfile(DEFAULT_AGENT_PROFILE_ID),
    id: "profile-parallel",
    agentId: "parallel",
    runtimeProfileId: "parallel",
    name: "Parallel",
    isDefault: false,
    concurrency: { maxActive: 2, maxWorkspaceWrites: 1 },
  });
  dispatcher.enqueue(runInput("run-read", { profileId: "profile-parallel", workspace: "/tmp/same" }));
  dispatcher.enqueue(runInput("run-write", { profileId: "profile-parallel", workspace: "/tmp/same" }));
  assert.equal(dispatcher.admit("run-read", { writable: false }).disposition, "started");
  assert.equal(dispatcher.admit("run-write").disposition, "started");
  dispatcher.enqueue(runInput("run-overflow", { profileId: "profile-parallel", workspace: "/tmp/other" }));
  const queued = dispatcher.admit("run-overflow");
  assert.equal(queued.reason, "PROFILE_ACTIVE_LIMIT");
  store.close();
});

test("enabled=false 的默认 profile 保留但 enqueue 起即明确拒绝", () => {
  const { store, dispatcher } = fixture();
  const profile = store.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
  store.putAgentProfile({ ...profile, enabled: false });
  assert.throws(
    () => dispatcher.enqueue(runInput("run-disabled-profile")),
    (error) => error.code === "AGENT_PROFILE_DISABLED",
  );
  assert.equal(dispatcher.getRun("run-disabled-profile"), null);
  store.close();
});

test("source/profile/字段补丁校验 fail closed，Store 不保存 transcript", () => {
  const { store, paths, dispatcher } = fixture();
  assert.throws(
    () => dispatcher.enqueue(runInput("run-source", { source: "email" })),
    (error) => error.code === "INVALID_WORK_RUN",
  );
  assert.throws(
    () => dispatcher.enqueue(runInput("run-profile", { profileId: "missing" })),
    (error) => error.code === "UNKNOWN_AGENT_PROFILE",
  );
  dispatcher.enqueue(runInput("run-patch"));
  dispatcher.admit("run-patch");
  assert.throws(
    () => dispatcher.transition("run-patch", "running", { transcript: "must-not-persist" }),
    (error) => error.code === "INVALID_WORK_RUN_PATCH",
  );
  store.close();
  const disk = fs.readFileSync(paths.stateSnapshotPath, "utf8")
    + fs.readFileSync(paths.eventLogPath, "utf8");
  assert.equal(disk.includes("must-not-persist"), false);
  assert.equal(disk.includes("transcript"), false);
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${name}`);
      console.error(error?.stack || error);
    }
  }
  if (failed > 0) process.exitCode = 1;
  else console.log(`PASS work dispatcher unit (${tests.length})`);
})();
