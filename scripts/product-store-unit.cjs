#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const {
  DEFAULT_AGENT_PROFILE_ID,
  DEFAULT_AGENT_PROFILE_UUID,
  MCP_TOOL_CALL_FIELDS,
  RUN_NOTE_FIELDS,
  STORE_SCHEMA_VERSION,
  JsonlProductStore,
  eventChecksum,
  snapshotChecksum,
} = require(path.join(ROOT, "app", "agent-service", "product-store.js"));
const {
  BUILTIN_CLI_AGENT_PROFILES,
} = require(path.join(ROOT, "app", "agent-service", "builtin-cli-profiles.js"));
const {
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
} = require(path.join(ROOT, "app", "agent-service", "runtime-account.js"));
const { resolveServicePaths } = require(path.join(ROOT, "app", "agent-service", "paths.js"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function fixturePaths(prefix = "shoggoth-store-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return resolveServicePaths({
    stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"),
  });
}

function openStore(paths, options = {}) {
  const store = new JsonlProductStore({ paths, ...options });
  store.open();
  return store;
}

function validProfile(id, overrides = {}) {
  return {
    id,
    backendId: "shoggoth",
    agentId: id,
    name: `Fixture ${id}`,
    runtime: "codex",
    runtimeProfileId: id,
    providerRef: null,
    defaultModel: null,
    defaultCwd: null,
    permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    concurrency: { maxActive: 1, maxWorkspaceWrites: 1 },
    isDefault: false,
    enabled: true,
    ...overrides,
  };
}

function validRun(id, overrides = {}) {
  const legacySessionId = Object.prototype.hasOwnProperty.call(overrides, "codexThreadId")
    ? overrides.codexThreadId : null;
  const legacyTurnId = Object.prototype.hasOwnProperty.call(overrides, "codexTurnId")
    ? overrides.codexTurnId : null;
  const currentOverrides = { ...overrides };
  delete currentOverrides.codexThreadId;
  delete currentOverrides.codexTurnId;
  const binding = {
    runtime: "codex",
    runtimeProfileId: `shoggoth-${DEFAULT_AGENT_PROFILE_UUID}`,
    runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
  };
  return {
    id,
    source: "chat",
    sourceId: `source-${id}`,
    idempotencyKey: `idem-${id}`,
    profileId: DEFAULT_AGENT_PROFILE_ID,
    workspace: "/tmp/workspace",
    status: "queued",
    contextSnapshotId: null,
    runtimeSessionRef: legacySessionId === null ? null : { ...binding, sessionId: legacySessionId },
    runtimeTurnRef: legacyTurnId === null
      ? null : { ...binding, sessionId: legacySessionId ?? "", turnId: legacyTurnId },
    eventSeq: 1,
    waitingRequestId: null,
    startedAt: null,
    finishedAt: null,
    resultSummary: null,
    errorCode: null,
    retryOf: null,
    ...currentOverrides,
  };
}

function validRunNote(id, runId, overrides = {}) {
  return {
    id,
    runId,
    profileId: DEFAULT_AGENT_PROFILE_ID,
    kind: "note",
    cardId: null,
    body: "durable run note",
    percent: null,
    createdAt: 100,
    ...overrides,
  };
}

function encodeSnapshot(snapshot) {
  const candidate = { ...snapshot };
  candidate.checksum = snapshotChecksum(candidate);
  return `${JSON.stringify(candidate)}\n`;
}

function builtinProfile(spec, overrides = {}) {
  return validProfile(spec.id, {
    ...spec,
    isDefault: false,
    ...overrides,
  });
}

function seedBuiltinSnapshot(paths, now = 600) {
  const store = openStore(paths, { now: () => now });
  for (const spec of BUILTIN_CLI_AGENT_PROFILES) store.putAgentProfile(builtinProfile(spec));
  store.close();
  return JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
}

test("paths 将 snapshot 与 JSONL 日志放在 Service core state 目录", () => {
  const paths = fixturePaths();
  assert.equal(paths.stateSnapshotPath, path.join(paths.stateDir, "state.snapshot.json"));
  assert.equal(paths.eventLogPath, path.join(paths.stateDir, "events.jsonl"));
  assert.equal(path.dirname(paths.stateSnapshotPath), paths.stateDir);
  assert.equal(path.dirname(paths.eventLogPath), paths.stateDir);
  assert.equal(paths.runtimeSwitchPath, path.join(paths.stateDir, "runtime-switch.json"));
});

test("默认产品根稳定落在 Shoggoth/shoggoth-core，测试可显式注入 userDataRoot/stateRoot", () => {
  const homeDir = path.join(os.tmpdir(), "shoggoth-home-contract");
  const defaults = resolveServicePaths({ homeDir });
  assert.equal(
    defaults.userDataRoot,
    path.join(homeDir, "Library", "Application Support", "Shoggoth"),
  );
  assert.equal(defaults.stateDir, path.join(defaults.userDataRoot, "shoggoth-core"));
  assert.equal(defaults.profileDir, path.join(defaults.userDataRoot, "agent-service-profile"));
  assert.equal(defaults.backupsDir, path.join(defaults.stateDir, "backups"));
  assert.equal(defaults.runtimeDir, path.join(defaults.userDataRoot, "run"));
  assert.equal(defaults.socketPath.startsWith(defaults.cacheDir), false);

  const injectedRoot = path.join(homeDir, "fixture-user-data");
  const injected = resolveServicePaths({ userDataRoot: injectedRoot, cacheRoot: path.join(homeDir, "cache") });
  assert.equal(injected.stateDir, path.join(injectedRoot, "shoggoth-core"));
  assert.equal(injected.profileDir, path.join(injectedRoot, "agent-service-profile"));

  const stateRoot = path.join(homeDir, "explicit-state");
  assert.equal(resolveServicePaths({ stateRoot, cacheRoot: path.join(homeDir, "cache-2") }).stateDir, stateRoot);
});

test("首次启动创建字段完整且内部 ID 与显示名分离的唯一默认 Shoggoth profile", () => {
  const paths = fixturePaths();
  for (let restart = 0; restart < 100; restart += 1) {
    const store = openStore(paths, { now: () => 1_700_000_000_000 + restart });
    const profiles = store.listAgentProfiles();
    assert.equal(profiles.length, 1, `restart ${restart}`);
    assert.deepEqual(profiles[0], {
      id: DEFAULT_AGENT_PROFILE_UUID,
      backendId: "shoggoth",
      agentId: `shoggoth-${DEFAULT_AGENT_PROFILE_UUID}`,
      name: "Shoggoth",
      runtime: "codex",
      runtimeProfileId: `shoggoth-${DEFAULT_AGENT_PROFILE_UUID}`,
      runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
      providerRef: null,
      defaultModel: null,
      defaultCwd: null,
      permissionPolicy: { approvalPolicy: "on-request", sandbox: "danger-full-access" },
      concurrency: { maxActive: 4, maxWorkspaceWrites: 4 },
      isDefault: true,
      enabled: true,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    });
    assert.equal(DEFAULT_AGENT_PROFILE_ID, DEFAULT_AGENT_PROFILE_UUID);
    assert.match(DEFAULT_AGENT_PROFILE_UUID, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    store.close();
  }
});

test("保留 ID 的默认 profile 不允许取消 default，但允许 enabled=false", () => {
  const paths = fixturePaths();
  const store = openStore(paths);
  const profile = store.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
  assert.throws(
    () => store.putAgentProfile({ ...profile, isDefault: false }),
    (error) => error.code === "DEFAULT_AGENT_PROFILE_IDENTITY_IMMUTABLE",
  );
  assert.equal(store.putAgentProfile({ ...profile, enabled: false }).enabled, false);
  assert.equal(store.listAgentProfiles().filter((item) => item.isDefault).length, 1);
  store.close();
});

test("reserved default 的稳定身份字段不可变且拒绝时不追加日志", () => {
  const paths = fixturePaths();
  const store = openStore(paths);
  store.putModelProvider({
    id: "provider-fixture",
    kind: "ollama",
    name: "Fixture provider",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "fixture-model",
    credentialRef: null,
    headers: null,
    validationStatus: "unverified",
  });
  const profile = store.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
  const before = fs.readFileSync(paths.eventLogPath);
  for (const patch of [
    { backendId: "other" },
    { agentId: "shoggoth-other" },
    { runtime: "other" },
    { runtimeProfileId: "shoggoth-other" },
    { isDefault: false },
  ]) {
    assert.throws(
      () => store.putAgentProfile({ ...profile, ...patch }),
      (error) => error.code === "DEFAULT_AGENT_PROFILE_IDENTITY_IMMUTABLE",
    );
    assert.deepEqual(fs.readFileSync(paths.eventLogPath), before);
  }
  const updated = store.putAgentProfile({
    ...profile,
    name: "Renamed Shoggoth",
    enabled: false,
    providerRef: "provider-fixture",
    defaultModel: "model-fixture",
    defaultCwd: "/tmp/fixture-cwd",
    permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" },
    concurrency: { maxActive: 2, maxWorkspaceWrites: 0 },
  });
  assert.equal(updated.name, "Renamed Shoggoth");
  assert.equal(updated.enabled, false);
  assert.equal(updated.agentId, profile.agentId);
  store.close();
});

test("append 在返回前写入带校验和的 fsync JSONL envelope，重启先 snapshot 后 replay", () => {
  const paths = fixturePaths();
  const syncs = [];
  const instrumentedFs = Object.create(fs);
  instrumentedFs.fsyncSync = (fd) => { syncs.push(fd); return fs.fsyncSync(fd); };
  const store = openStore(paths, { fs: instrumentedFs, now: () => 10 });
  const profile = store.putAgentProfile(validProfile("profile-extra"));
  assert.equal(profile.id, "profile-extra");
  assert.equal(syncs.length > 0, true, "mutation ack 前必须 fsync");

  const raw = fs.readFileSync(paths.eventLogPath, "utf8");
  const lines = raw.trimEnd().split("\n").map(JSON.parse);
  assert.equal(lines.length, 2);
  for (const event of lines) {
    assert.equal(event.schemaVersion, STORE_SCHEMA_VERSION);
    assert.equal(Number.isSafeInteger(event.seq), true);
    assert.equal(typeof event.aggregateId, "string");
    assert.equal(typeof event.type, "string");
    assert.equal(event.time, 10);
    assert.equal(typeof event.payload, "object");
    assert.match(event.checksum, /^[a-f0-9]{64}$/);
  }
  assert.deepEqual(lines.map((event) => event.seq), [1, 2]);

  const replayed = openStore(paths, { now: () => 11 });
  assert.equal(replayed.getAgentProfile("profile-extra").name, "Fixture profile-extra");
  assert.equal(replayed.lastEventSeq, 2);
  replayed.close();
  store.close();

  const snapshot = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
  assert.equal(snapshot.schemaVersion, STORE_SCHEMA_VERSION);
  assert.equal(snapshot.lastSeq, 2);
  assert.equal(snapshot.agentProfiles.length, 2);
  assert.equal(fs.readFileSync(paths.eventLogPath, "utf8"), "", "snapshot 后安全轮转日志");
});

test("首次创建 events.jsonl 会 fsync 文件及 stateDir 后再返回", () => {
  const paths = fixturePaths();
  const syncOrder = [];
  const instrumentedFs = Object.create(fs);
  instrumentedFs.fsyncSync = (fd) => {
    syncOrder.push(fs.fstatSync(fd).isDirectory() ? "directory" : "file");
    return fs.fsyncSync(fd);
  };
  const store = openStore(paths, { fs: instrumentedFs });
  assert.deepEqual(syncOrder.slice(0, 2), ["file", "directory"]);
  store.close();
});

test("append 与 snapshot 对底层短写循环写满后才 fsync/ack", () => {
  const paths = fixturePaths();
  const partialFs = Object.create(fs);
  partialFs.writeSync = (fd, data, offset, length, position) => {
    if (Buffer.isBuffer(data)) {
      return fs.writeSync(fd, data, offset, Math.min(length, 13), position);
    }
    return fs.writeSync(fd, String(data).slice(0, 13), offset, length);
  };
  const store = openStore(paths, { fs: partialFs, now: () => 12 });
  store.putAgentProfile(validProfile("profile-short-write"));
  const events = fs.readFileSync(paths.eventLogPath, "utf8").trimEnd().split("\n").map(JSON.parse);
  assert.equal(events.length, 2);
  assert.equal(events[1].payload.profile.id, "profile-short-write");
  store.close();
  const snapshot = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
  assert.equal(snapshot.agentProfiles.length, 2);
});

test("append 已 fsync 后 close EIO 会 poison 当前 Store，reopen 从 durable log 恢复连续 seq", () => {
  const paths = fixturePaths();
  let injectCloseFailure = false;
  let eventFd = null;
  let eventFsynced = false;
  const faultFs = Object.create(fs);
  faultFs.openSync = (target, flags, mode) => {
    const fd = fs.openSync(target, flags, mode);
    if (target === paths.eventLogPath) eventFd = fd;
    return fd;
  };
  faultFs.fsyncSync = (fd) => {
    if (fd === eventFd) eventFsynced = true;
    return fs.fsyncSync(fd);
  };
  faultFs.closeSync = (fd) => {
    fs.closeSync(fd);
    if (fd === eventFd && eventFsynced && injectCloseFailure) {
      injectCloseFailure = false;
      throw Object.assign(new Error("durable close fixture"), { code: "EIO" });
    }
  };
  const store = openStore(paths, { fs: faultFs, now: () => 10_000 });
  const before = store.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
  injectCloseFailure = true;
  assert.throws(
    () => store.putAgentProfile({ ...before, name: "Durable Despite Close Error" }),
    (error) => error.code === "STORE_COMMIT_UNCERTAIN",
  );
  for (const action of [
    () => store.getAgentProfile(DEFAULT_AGENT_PROFILE_ID),
    () => store.putAgentProfile(before),
    () => store.listWorkRuns(),
  ]) assert.throws(action, (error) => error.code === "STORE_COMMIT_UNCERTAIN");
  assert.doesNotThrow(() => store.close());

  const reopened = openStore(paths, { now: () => 11_000 });
  assert.equal(reopened.getAgentProfile(DEFAULT_AGENT_PROFILE_ID).name, "Durable Despite Close Error");
  reopened.putAgentProfile({
    ...reopened.getAgentProfile(DEFAULT_AGENT_PROFILE_ID),
    name: "Next Continuous Event",
  });
  const events = fs.readFileSync(paths.eventLogPath, "utf8").trim().split("\n").map(JSON.parse);
  for (let index = 1; index < events.length; index += 1) {
    assert.equal(events[index].seq, events[index - 1].seq + 1);
  }
  reopened.close();
});

test("崩溃留下的不完整尾行会截断，完整行中的损坏则 fail closed 并保留证据", () => {
  const tailPaths = fixturePaths();
  const store = openStore(tailPaths);
  store.putAgentProfile(validProfile("profile-tail"));
  fs.appendFileSync(tailPaths.eventLogPath, '{"schemaVersion":1,"seq":3');
  const before = fs.statSync(tailPaths.eventLogPath).size;
  const recovered = openStore(tailPaths);
  assert.equal(recovered.getAgentProfile("profile-tail").id, "profile-tail");
  assert.equal(fs.statSync(tailPaths.eventLogPath).size < before, true);
  assert.equal(fs.readFileSync(tailPaths.eventLogPath, "utf8").endsWith("\n"), true);
  recovered.close();
  store.close();

  const corruptPaths = fixturePaths();
  const corruptStore = openStore(corruptPaths);
  corruptStore.putAgentProfile(validProfile("profile-corrupt"));
  const goodEvidence = fs.readFileSync(corruptPaths.eventLogPath);
  const evidence = Buffer.concat([
    goodEvidence.subarray(0, goodEvidence.indexOf(0x0a) + 1),
    Buffer.from("{definitely-not-json}\n"),
    goodEvidence.subarray(goodEvidence.indexOf(0x0a) + 1),
  ]);
  fs.writeFileSync(corruptPaths.eventLogPath, evidence);
  assert.throws(
    () => openStore(corruptPaths),
    (error) => error.code === "STORE_CORRUPT_EVENT_LOG",
  );
  assert.deepEqual(fs.readFileSync(corruptPaths.eventLogPath), evidence, "不得静默重写中间损坏");
});

test("旧版与未来版 snapshot 都固定拒绝", () => {
  for (const schemaVersion of [0, STORE_SCHEMA_VERSION + 1]) {
    const paths = fixturePaths();
    fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
    const bytes = `${JSON.stringify({
      schemaVersion,
      lastSeq: 0,
      agentProfiles: [],
      workRuns: [],
    })}\n`;
    fs.writeFileSync(paths.stateSnapshotPath, bytes, { mode: 0o600 });
    assert.throws(
      () => openStore(paths),
      (error) => error.code === "STORE_SCHEMA_UNSUPPORTED",
    );
    assert.equal(fs.readFileSync(paths.stateSnapshotPath, "utf8"), bytes);
  }
});

test("snapshot 中出现多个默认 profile 会 fail closed", () => {
  const paths = fixturePaths();
  const store = openStore(paths, { now: () => 20 });
  store.close();
  const snapshot = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
  snapshot.agentProfiles.push({
    ...validProfile("profile-illegal-default", { isDefault: true }),
    runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    createdAt: 20,
    updatedAt: 20,
  });
  fs.writeFileSync(paths.stateSnapshotPath, encodeSnapshot(snapshot));
  assert.throws(
    () => openStore(paths),
    (error) => error.code === "STORE_CORRUPT_SNAPSHOT",
  );
});

test("snapshot 中 AgentProfile runtime identity 冲突会 fail closed", () => {
  const paths = fixturePaths();
  const store = openStore(paths, { now: () => 25 });
  store.putAgentProfile(validProfile("profile-identity-source"));
  store.close();
  const snapshot = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
  const source = snapshot.agentProfiles.find((profile) => profile.id === "profile-identity-source");
  snapshot.agentProfiles.push({
    ...source,
    id: "profile-identity-collision",
    name: "Identity collision",
    agentId: "profile-identity-collision",
  });
  fs.writeFileSync(paths.stateSnapshotPath, encodeSnapshot(snapshot), { mode: 0o600 });
  assert.throws(
    () => openStore(paths),
    (error) => error.code === "STORE_CORRUPT_SNAPSHOT",
  );
});

test("snapshot 中未知 WorkRun source/status 会 fail closed", () => {
  for (const invalid of [{ source: "email" }, { status: "mystery" }]) {
    const paths = fixturePaths();
    const store = openStore(paths, { now: () => 30 });
    store.close();
    const snapshot = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
    snapshot.workRuns.push(validRun(`run-${Object.keys(invalid)[0]}`, invalid));
    fs.writeFileSync(paths.stateSnapshotPath, encodeSnapshot(snapshot), { mode: 0o600 });
    assert.throws(
      () => openStore(paths),
      (error) => error.code === "STORE_INVALID_RECORD",
    );
  }
});

test("Store 拒绝更换非空 thread/turn 绑定", () => {
  const paths = fixturePaths();
  const store = openStore(paths);
  store.putWorkRun(validRun("run-binding-store"));
  store.putWorkRun(validRun("run-binding-store", {
    status: "running",
    codexThreadId: "thread-store",
    codexTurnId: "turn-store",
    eventSeq: 2,
    startedAt: 1,
  }));
  for (const patch of [
    { codexThreadId: null },
    { codexThreadId: "thread-other" },
    { codexTurnId: null },
    { codexTurnId: "turn-other" },
  ]) {
    assert.throws(
      () => store.putWorkRun(validRun("run-binding-store", {
        status: "completed",
        codexThreadId: "thread-store",
        codexTurnId: "turn-store",
        eventSeq: 3,
        startedAt: 1,
        finishedAt: 2,
        ...patch,
      })),
      (error) => error.code === "WORK_RUN_BINDING_IMMUTABLE",
    );
  }
  store.close();
});

test("snapshot 中两个 active Run 绑定同一 Runtime session 会 fail closed 并保留证据", () => {
  const paths = fixturePaths();
  const store = openStore(paths);
  store.putWorkRun(validRun("run-thread-snapshot-a", {
    status: "running", codexThreadId: "thread-snapshot", codexTurnId: "turn-a", startedAt: 1,
  }));
  store.putWorkRun(validRun("run-thread-snapshot-b", {
    status: "waiting_input", codexThreadId: "thread-other", codexTurnId: "turn-b",
    startedAt: 1, waitingRequestId: "request-b",
  }));
  store.close();
  const snapshot = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
  const firstRef = snapshot.workRuns
    .find((run) => run.id === "run-thread-snapshot-a").runtimeSessionRef;
  const secondRun = snapshot.workRuns.find((run) => run.id === "run-thread-snapshot-b");
  secondRun.runtimeSessionRef = firstRef;
  secondRun.runtimeTurnRef = { ...secondRun.runtimeTurnRef, ...firstRef };
  const evidence = encodeSnapshot(snapshot);
  fs.writeFileSync(paths.stateSnapshotPath, evidence, { mode: 0o600 });
  assert.throws(
    () => openStore(paths),
    (error) => error.code === "STORE_CORRUPT_SNAPSHOT",
  );
  assert.equal(fs.readFileSync(paths.stateSnapshotPath, "utf8"), evidence);
});

test("AgentProfile 接受通用 backendId，但归属持久化后不可静默更改", () => {
  const paths = fixturePaths();
  const store = openStore(paths);
  const profile = store.putAgentProfile(validProfile("profile-backendId", { backendId: "codex" }));
  assert.equal(profile.backendId, "codex");
  const before = fs.readFileSync(paths.eventLogPath);
  assert.throws(() => store.putAgentProfile({ ...profile, backendId: "grok-build" }),
    (error) => error.code === "AGENT_PROFILE_BACKEND_IMMUTABLE");
  assert.deepEqual(fs.readFileSync(paths.eventLogPath), before);
  for (const backendId of ["Codex", "grok_build", "grok:build", `a${"b".repeat(64)}`]) {
    assert.throws(
      () => store.putAgentProfile(validProfile(`profile-invalid-${crypto.randomUUID()}`, { backendId })),
      (error) => error.code === "STORE_INVALID_RECORD",
    );
  }
  assert.equal(store.putAgentProfile(validProfile("profile-future", {
    runtime: "future-runtime",
  })).runtime, "future-runtime");
  store.close();
});

test("schema v5 精确迁移两个内置 CLI Profile 的 backendId，保留所有身份与引用", () => {
  const paths = fixturePaths("shoggoth-profile-backend-v5-");
  const snapshot = seedBuiltinSnapshot(paths);
  const codex = BUILTIN_CLI_AGENT_PROFILES[0];
  const grok = BUILTIN_CLI_AGENT_PROFILES[1];

  const populated = openStore(paths, { now: () => 601 });
  populated.putWorkRun(validRun("run-builtin-profile-ref", {
    profileId: codex.id,
    idempotencyKey: "idem-builtin-profile-ref",
  }));
  populated.addRunNote(validRunNote("note-builtin-profile-ref", "run-builtin-profile-ref", {
    profileId: codex.id,
  }));
  populated.beginMcpToolCall({
    profileId: grok.id,
    callId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    name: "run_add_note",
    fingerprint: crypto.createHash("sha256").update("builtin-profile-ref").digest("hex"),
    binding: null,
    createdAt: 601,
  });
  populated.close();

  const legacy = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
  legacy.schemaVersion = 5;
  delete legacy.runtimeAccounts;
  delete legacy.runtimeAccountTombstones;
  for (const profile of legacy.agentProfiles) {
    delete profile.runtimeAccountId;
    if ([codex.id, grok.id].includes(profile.id)) profile.backendId = "shoggoth";
  }
  fs.writeFileSync(paths.stateSnapshotPath, encodeSnapshot(legacy), { mode: 0o600 });
  const codexBefore = legacy.agentProfiles.find((profile) => profile.id === codex.id);
  const v6Codex = { ...codexBefore, backendId: "codex", name: "Codex after migration" };
  const event = {
    schemaVersion: 6,
    seq: legacy.lastSeq + 1,
    aggregateId: codex.id,
    type: "agent_profile.put",
    time: 602,
    payload: { profile: v6Codex },
  };
  event.checksum = eventChecksum(event);
  fs.writeFileSync(paths.eventLogPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });

  const migrated = openStore(paths, { now: () => 603 });
  assert.equal(migrated.getAgentProfile(codex.id).backendId, "codex");
  assert.equal(migrated.getAgentProfile(codex.id).name, "Codex after migration");
  assert.equal(migrated.getAgentProfile(grok.id).backendId, "grok-build");
  assert.equal(migrated.getWorkRun("run-builtin-profile-ref").profileId, codex.id);
  assert.equal(migrated.getRunNote("note-builtin-profile-ref").profileId, codex.id);
  assert.equal(migrated.listMcpToolCalls({ profileId: grok.id }).length, 1);
  for (const spec of BUILTIN_CLI_AGENT_PROFILES) {
    const before = legacy.agentProfiles.find((profile) => profile.id === spec.id);
    const after = migrated.getAgentProfile(spec.id);
    for (const field of ["id", "agentId", "runtime", "runtimeProfileId", "createdAt"]) {
      assert.equal(after[field], before[field], `${spec.name}.${field}`);
    }
  }
  migrated.close();
  assert.equal(
    JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8")).schemaVersion,
    STORE_SCHEMA_VERSION,
  );
  const reopened = openStore(paths);
  assert.deepEqual(reopened.listAgentProfiles()
    .filter((profile) => [codex.id, grok.id].includes(profile.id))
    .map((profile) => profile.backendId), ["codex", "grok-build"]);
  reopened.close();
  assert.equal(snapshot.schemaVersion, STORE_SCHEMA_VERSION);
});

test("schema v5 内置 Profile 半迁移或身份冲突时保留证据并 fail closed", () => {
  const codex = BUILTIN_CLI_AGENT_PROFILES[0];
  for (const mutate of [
    (profile) => { profile.backendId = codex.backendId; },
    (profile) => { profile.agentId = "conflicting-codex-agent"; },
  ]) {
    const paths = fixturePaths("shoggoth-profile-backend-conflict-");
    const legacy = seedBuiltinSnapshot(paths);
    legacy.schemaVersion = 5;
    delete legacy.runtimeAccounts;
    delete legacy.runtimeAccountTombstones;
    for (const profile of legacy.agentProfiles) {
      delete profile.runtimeAccountId;
      if (BUILTIN_CLI_AGENT_PROFILES.some((spec) => spec.id === profile.id)) {
        profile.backendId = "shoggoth";
      }
    }
    mutate(legacy.agentProfiles.find((profile) => profile.id === codex.id));
    const evidence = encodeSnapshot(legacy);
    fs.writeFileSync(paths.stateSnapshotPath, evidence, { mode: 0o600 });
    assert.throws(
      () => openStore(paths),
      (error) => error.code === "STORE_PROFILE_MIGRATION_CONFLICT",
    );
    assert.equal(fs.readFileSync(paths.stateSnapshotPath, "utf8"), evidence);
  }

  const occupiedPaths = fixturePaths("shoggoth-profile-backend-occupied-");
  const occupied = seedBuiltinSnapshot(occupiedPaths);
  const codexIndex = occupied.agentProfiles.findIndex((profile) => profile.id === codex.id);
  const codexProfile = occupied.agentProfiles[codexIndex];
  occupied.agentProfiles.splice(codexIndex, 1);
  occupied.agentProfiles.push({
    ...codexProfile,
    id: "11111111-1111-4111-8111-111111111111",
    backendId: "shoggoth",
    createdAt: 600,
    updatedAt: 600,
  });
  const evidence = encodeSnapshot(occupied);
  fs.writeFileSync(occupiedPaths.stateSnapshotPath, evidence, { mode: 0o600 });
  assert.throws(
    () => openStore(occupiedPaths),
    (error) => error.code === "STORE_CORRUPT_SNAPSHOT",
  );
  assert.equal(fs.readFileSync(occupiedPaths.stateSnapshotPath, "utf8"), evidence);
});

test("敏感字段递归拒绝写入，fixture 明文永不出现在 snapshot 或日志", () => {
  const paths = fixturePaths();
  const store = openStore(paths);
  const fixtures = [
    ["token", "fixture-token-never-disk"],
    ["apiKey", "fixture-api-key-never-disk"],
    ["Authorization", "fixture-auth-never-disk"],
    ["client_secret", "fixture-secret-never-disk"],
  ];
  for (const [field, secret] of fixtures) {
    assert.throws(
      () => store.putAgentProfile(validProfile(`profile-${crypto.randomUUID()}`, {
        permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write", nested: { [field]: secret } },
      })),
      (error) => error.code === "STORE_SENSITIVE_FIELD",
    );
  }
  store.close();
  const disk = [paths.stateSnapshotPath, paths.eventLogPath]
    .filter((target) => fs.existsSync(target))
    .map((target) => fs.readFileSync(target, "utf8"))
    .join("\n");
  for (const [, secret] of fixtures) assert.equal(disk.includes(secret), false);
});

test("高置信 secret 字符串即使位于合法 resultSummary 也拒绝且 canary 不落盘", () => {
  const paths = fixturePaths();
  const store = openStore(paths);
  const canaries = [
    "Bearer eyJhbGciOiJIUzI1NiJ9.fixtureSignaturePayload",
    `sk-${"A".repeat(32)}`,
    `sk-proj-${"B".repeat(32)}`,
    `AKIA${"C".repeat(16)}`,
    `ASIA${"D".repeat(16)}`,
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlMTIz", // gitleaks:allow -- synthetic test fixture; not a usable credential
    "-----BEGIN PRIVATE KEY-----\nfixture-private-material\n-----END PRIVATE KEY-----", // gitleaks:allow -- synthetic test fixture; not a usable credential
    "-----BEGIN ENCRYPTED PRIVATE KEY-----\nfixture-encrypted-material\n-----END ENCRYPTED PRIVATE KEY-----",
    "api_key = abcdefghijklmnopqrstuvwxyz",
    "token: abcdefghijklmnop",
    "OPENAI_API_KEY=abcdefghijklmnopqrstuvwxyz",
    "AWS_SECRET_ACCESS_KEY=abcdefghijklmnopqrstuvwxyz0123456789ABCD",
    "GITHUB_TOKEN=abcdefghijklmnopqrstuvwxyz",
  ];
  for (const [index, canary] of canaries.entries()) {
    assert.throws(
      () => store.putWorkRun(validRun(`run-secret-value-${index}`, { resultSummary: canary })),
      (error) => error.code === "STORE_SENSITIVE_VALUE" && !error.message.includes(canary),
    );
  }
  assert.equal(store.putWorkRun(validRun("run-safe-bearer-summary", {
    resultSummary: "Documented how Bearer authentication works without including credentials.",
  })).id, "run-safe-bearer-summary");
  store.close();
  const disk = fs.readFileSync(paths.stateSnapshotPath, "utf8")
    + fs.readFileSync(paths.eventLogPath, "utf8");
  for (const canary of canaries) assert.equal(disk.includes(canary), false);
});

test("未注册 opaque 摘要可持久化，登记值或权威回调命中则固定拒绝且不落盘", () => {
  const opaque = "fixture-super-secret-value";
  const plainPaths = fixturePaths();
  const plainStore = openStore(plainPaths);
  plainStore.putWorkRun(validRun("run-opaque-unregistered", { resultSummary: opaque }));
  plainStore.close();
  assert.equal(fs.readFileSync(plainPaths.stateSnapshotPath, "utf8").includes(opaque), true);

  const registeredPaths = fixturePaths();
  const registered = openStore(registeredPaths, { sensitiveValues: new Set([opaque]) });
  for (const [index, resultSummary] of [opaque, `prefix-${opaque}-suffix`].entries()) {
    assert.throws(
      () => registered.putWorkRun(validRun(`run-opaque-registered-${index}`, { resultSummary })),
      (error) => error.code === "STORE_SENSITIVE_VALUE" && !error.message.includes(opaque),
    );
  }
  registered.close();
  const registeredDisk = fs.readFileSync(registeredPaths.stateSnapshotPath, "utf8")
    + fs.readFileSync(registeredPaths.eventLogPath, "utf8");
  assert.equal(registeredDisk.includes(opaque), false);

  const callbackCanary = "fixture-callback-opaque-value";
  const callbackPaths = fixturePaths();
  const callbackStore = openStore(callbackPaths, {
    isSensitiveValue(value) { return value === callbackCanary; },
  });
  assert.throws(
    () => callbackStore.putWorkRun(validRun("run-opaque-callback", { resultSummary: callbackCanary })),
    (error) => error.code === "STORE_SENSITIVE_VALUE" && !error.message.includes(callbackCanary),
  );
  callbackStore.close();
  assert.equal(fs.readFileSync(callbackPaths.stateSnapshotPath, "utf8").includes(callbackCanary), false);

  assert.throws(
    () => new JsonlProductStore({ paths: fixturePaths(), sensitiveValues: ["short"] }),
    (error) => error.code === "STORE_INVALID_OPTIONS",
  );
});

test("permissionPolicy 使用严格稳定枚举且所有持久化 JSON 可稳定 round-trip", () => {
  const paths = fixturePaths();
  const store = openStore(paths);
  const approvals = ["untrusted", "on-failure", "on-request", "never"];
  const sandboxes = ["read-only", "workspace-write", "danger-full-access"];
  let index = 0;
  for (const approvalPolicy of approvals) {
    for (const sandbox of sandboxes) {
      const policy = { approvalPolicy, sandbox };
      const saved = store.putAgentProfile(validProfile(`profile-policy-${index}`, {
        permissionPolicy: policy,
      }));
      assert.deepEqual(saved.permissionPolicy, policy);
      index += 1;
    }
  }
  const symbolPolicy = { approvalPolicy: "never", sandbox: "read-only" };
  symbolPolicy[Symbol("hidden")] = "value";
  const sparse = [];
  sparse[1] = "value";
  const cyclic = { approvalPolicy: "never", sandbox: "read-only" };
  cyclic.self = cyclic;
  const invalidPolicies = [
    { approvalPolicy: "ask", sandbox: "read-only" },
    { approvalPolicy: "never", sandbox: "host-write" },
    { approvalPolicy: "never", sandbox: "read-only", extra: true },
    Object.assign(Object.create(null), { approvalPolicy: "never", sandbox: "read-only" }),
    { approvalPolicy: "never", sandbox: "read-only", extra: NaN },
    { approvalPolicy: "never", sandbox: "read-only", extra: Infinity },
    { approvalPolicy: "never", sandbox: "read-only", extra: undefined },
    { approvalPolicy: "never", sandbox: "read-only", extra() {} },
    { approvalPolicy: "never", sandbox: "read-only", extra: Symbol("value") },
    { approvalPolicy: "never", sandbox: "read-only", extra: sparse },
    symbolPolicy,
    cyclic,
  ];
  for (const [invalidIndex, permissionPolicy] of invalidPolicies.entries()) {
    assert.throws(
      () => store.putAgentProfile(validProfile(`profile-invalid-policy-${invalidIndex}`, {
        permissionPolicy,
      })),
      (error) => ["STORE_INVALID_RECORD", "STORE_INVALID_JSON", "STORE_INVALID_VALUE"].includes(error.code),
    );
  }
  store.close();
  const reopened = openStore(paths);
  for (let profileIndex = 0; profileIndex < index; profileIndex += 1) {
    const profile = reopened.getAgentProfile(`profile-policy-${profileIndex}`);
    assert.deepEqual(profile.permissionPolicy, JSON.parse(JSON.stringify(profile.permissionPolicy)));
  }
  reopened.close();
});

test("WorkRun 状态组合不变量拒绝不完整记录", () => {
  const paths = fixturePaths();
  const store = openStore(paths);
  const invalid = [
    { status: "queued", startedAt: 1 },
    { status: "queued", finishedAt: 1 },
    { status: "queued", waitingRequestId: "request" },
    { status: "running", startedAt: null },
    { status: "running", startedAt: 1, finishedAt: 2 },
    { status: "running", startedAt: 1, waitingRequestId: "request" },
    { status: "waiting_input", startedAt: 1, waitingRequestId: null },
    { status: "completed", startedAt: 2, finishedAt: 1 },
    { status: "completed", startedAt: 1, finishedAt: 2, errorCode: "NOPE" },
    { status: "failed", startedAt: 1, finishedAt: 2, errorCode: null },
    { status: "interrupted", startedAt: 1, finishedAt: 2, errorCode: null },
    { status: "canceled", startedAt: null, finishedAt: 2, errorCode: "NOPE" },
  ];
  for (const [index, override] of invalid.entries()) {
    assert.throws(
      () => store.putWorkRun(validRun(`run-invariant-${index}`, override)),
      (error) => error.code === "STORE_INVALID_RECORD",
    );
  }
  store.close();
});

test("Store 冻结 WorkRun 创建身份并校验 profile/retry 引用且拒绝时不追加", () => {
  const paths = fixturePaths();
  const store = openStore(paths);
  const initialBytes = fs.readFileSync(paths.eventLogPath);
  assert.throws(
    () => store.putWorkRun(validRun("run-missing-profile", { profileId: "missing" })),
    (error) => error.code === "UNKNOWN_AGENT_PROFILE",
  );
  assert.throws(
    () => store.putWorkRun(validRun("run-missing-retry", { retryOf: "missing" })),
    (error) => error.code === "UNKNOWN_RETRY_WORK_RUN",
  );
  assert.deepEqual(fs.readFileSync(paths.eventLogPath), initialBytes);
  store.putWorkRun(validRun("run-identity"));
  store.putWorkRun(validRun("run-retry-parent"));
  const beforeUpdates = fs.readFileSync(paths.eventLogPath);
  for (const patch of [
    { source: "cron" },
    { sourceId: "changed" },
    { idempotencyKey: "changed" },
    { profileId: "missing" },
    { workspace: "/tmp/changed" },
    { retryOf: "run-retry-parent" },
  ]) {
    assert.throws(
      () => store.putWorkRun(validRun("run-identity", { ...patch, eventSeq: 2 })),
      (error) => error.code === "WORK_RUN_IDENTITY_IMMUTABLE",
    );
    assert.deepEqual(fs.readFileSync(paths.eventLogPath), beforeUpdates);
  }
  store.close();
});

test("snapshot checksum 检出篡改且事件旧前缀也必须严格连续", () => {
  const tamperPaths = fixturePaths();
  const tamperStore = openStore(tamperPaths);
  tamperStore.close();
  const tampered = JSON.parse(fs.readFileSync(tamperPaths.stateSnapshotPath, "utf8"));
  assert.match(tampered.checksum, /^[a-f0-9]{64}$/);
  tampered.agentProfiles[0].name = "Tampered";
  const tamperEvidence = `${JSON.stringify(tampered)}\n`;
  fs.writeFileSync(tamperPaths.stateSnapshotPath, tamperEvidence);
  assert.throws(
    () => openStore(tamperPaths),
    (error) => error.code === "STORE_CORRUPT_SNAPSHOT",
  );
  assert.equal(fs.readFileSync(tamperPaths.stateSnapshotPath, "utf8"), tamperEvidence);

  const extraPaths = fixturePaths();
  const extraStore = openStore(extraPaths);
  extraStore.close();
  const uncheckedExtra = JSON.parse(fs.readFileSync(extraPaths.stateSnapshotPath, "utf8"));
  uncheckedExtra.unchecked = "field";
  const extraEvidence = `${JSON.stringify(uncheckedExtra)}\n`;
  fs.writeFileSync(extraPaths.stateSnapshotPath, extraEvidence);
  assert.throws(
    () => openStore(extraPaths),
    (error) => error.code === "STORE_CORRUPT_SNAPSHOT",
  );
  assert.equal(fs.readFileSync(extraPaths.stateSnapshotPath, "utf8"), extraEvidence);

  const reorderPaths = fixturePaths();
  const reorderStore = openStore(reorderPaths, { now: () => 77 });
  reorderStore.putAgentProfile(validProfile("profile-old-prefix"));
  const oldEvents = fs.readFileSync(reorderPaths.eventLogPath, "utf8").trimEnd().split("\n");
  reorderStore.close();
  const reorderedEvidence = `${oldEvents[0]}\n${oldEvents[0]}\n${oldEvents[1]}\n`;
  fs.writeFileSync(reorderPaths.eventLogPath, reorderedEvidence);
  assert.throws(
    () => openStore(reorderPaths),
    (error) => error.code === "STORE_CORRUPT_EVENT_LOG",
  );
  assert.equal(fs.readFileSync(reorderPaths.eventLogPath, "utf8"), reorderedEvidence);
});

test("Store 读取 snapshot/events 时拒绝 symlink 且不截断 victim", () => {
  for (const leaf of ["stateSnapshotPath", "eventLogPath"]) {
    const paths = fixturePaths();
    const store = openStore(paths);
    store.close();
    const victim = path.join(path.dirname(paths.stateDir), `victim-symlink-${leaf}.txt`);
    const evidence = `victim-${leaf}-must-survive`;
    fs.writeFileSync(victim, evidence, { mode: 0o600 });
    fs.unlinkSync(paths[leaf]);
    fs.symlinkSync(victim, paths[leaf]);
    assert.throws(
      () => openStore(paths),
      (error) => error.code === "UNSAFE_SYMLINK",
    );
    assert.equal(fs.readFileSync(victim, "utf8"), evidence);
  }
});

test("Store 读取状态文件时拒绝 hardlink 与非普通文件", () => {
  for (const [leaf, kind] of [
    ["stateSnapshotPath", "hardlink"],
    ["eventLogPath", "hardlink"],
    ["stateSnapshotPath", "directory"],
    ["eventLogPath", "directory"],
  ]) {
    const paths = fixturePaths();
    const store = openStore(paths);
    store.close();
    fs.unlinkSync(paths[leaf]);
    if (kind === "hardlink") {
      const victim = path.join(path.dirname(paths.stateDir), `victim-hardlink-${leaf}.txt`);
      fs.writeFileSync(victim, "hardlink-victim", { mode: 0o600 });
      fs.linkSync(victim, paths[leaf]);
    } else {
      fs.mkdirSync(paths[leaf]);
    }
    assert.throws(
      () => openStore(paths),
      (error) => error.code === (kind === "hardlink" ? "UNSAFE_HARDLINK" : "UNSAFE_PATH"),
    );
  }
});

test("日志轮转发现 events 被替换为 symlink 时拒绝且不清空 victim", () => {
  const paths = fixturePaths();
  const store = openStore(paths);
  const victim = path.join(path.dirname(paths.stateDir), "victim-rotation.txt");
  const evidence = "rotation-victim-must-survive";
  fs.writeFileSync(victim, evidence, { mode: 0o600 });
  fs.unlinkSync(paths.eventLogPath);
  fs.symlinkSync(victim, paths.eventLogPath);
  assert.throws(
    () => store.close(),
    (error) => error.code === "UNSAFE_SYMLINK",
  );
  assert.equal(fs.readFileSync(victim, "utf8"), evidence);
});

test("当前 schema 持久化 append-only RunNote，重放/快照顺序稳定且返回 clone", () => {
  assert.equal(STORE_SCHEMA_VERSION, 10);
  assert.deepEqual(RUN_NOTE_FIELDS, [
    "id", "runId", "profileId", "kind", "cardId", "body", "percent", "createdAt",
  ]);
  const paths = fixturePaths("shoggoth-run-note-");
  const store = openStore(paths, { now: () => 101 });
  store.putWorkRun(validRun("run-notes"));
  const later = store.addRunNote(validRunNote("note-later", "run-notes", { createdAt: 200 }));
  store.addRunNote(validRunNote("note-earlier-b", "run-notes", { createdAt: 150 }));
  store.addRunNote(validRunNote("note-earlier-a", "run-notes", { createdAt: 150 }));
  later.body = "caller mutation";
  assert.deepEqual(store.listRunNotes({ runId: "run-notes" }).map((note) => note.id), [
    "note-earlier-a", "note-earlier-b", "note-later",
  ]);
  assert.equal(store.getRunNote("note-later").body, "durable run note");

  const replayed = openStore(paths, { now: () => 102 });
  assert.equal(replayed.getRunNote("note-earlier-a").runId, "run-notes");
  replayed.close();
  store.close();
  const snapshot = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
  assert.equal(snapshot.schemaVersion, STORE_SCHEMA_VERSION);
  assert.equal(snapshot.runNotes.length, 3);
});

test("RunNote exact replay 不追加，复用 id 改参数固定冲突", () => {
  const paths = fixturePaths("shoggoth-run-note-replay-");
  const store = openStore(paths);
  store.putWorkRun(validRun("run-note-replay"));
  const note = validRunNote("note-replay", "run-note-replay");
  assert.deepEqual(store.addRunNote(note), note);
  const before = fs.readFileSync(paths.eventLogPath);
  assert.deepEqual(store.addRunNote({ ...note }), note);
  assert.deepEqual(fs.readFileSync(paths.eventLogPath), before);
  assert.throws(
    () => store.addRunNote({ ...note, body: "changed" }),
    (error) => error.code === "RUN_NOTE_ID_CONFLICT",
  );
  assert.deepEqual(fs.readFileSync(paths.eventLogPath), before);
  store.close();
});

test("RunNote 严格校验 profile/run/progress 引用、容量与动态 secret，拒绝零日志", () => {
  const paths = fixturePaths("shoggoth-run-note-validation-");
  const secret = "registered-fixture-secret-value";
  const store = openStore(paths, {
    maxRunNotes: 2,
    maxRunNotesPerRun: 1,
    isSensitiveValue: (value) => typeof value === "string" && value.includes(secret),
  });
  store.putWorkRun(validRun("run-note-chat"));
  store.putWorkRun(validRun("run-note-kanban", {
    source: "kanban",
    sourceId: "33333333-3333-4333-8333-333333333333",
  }));
  const before = fs.readFileSync(paths.eventLogPath);
  for (const invalid of [
    validRunNote("bad-missing-run", "missing"),
    validRunNote("bad-profile", "run-note-chat", { profileId: "other-profile" }),
    validRunNote("bad-progress-chat", "run-note-chat", {
      kind: "progress", cardId: "33333333-3333-4333-8333-333333333333", percent: 50,
    }),
    validRunNote("bad-progress-card", "run-note-kanban", {
      kind: "progress", cardId: "44444444-4444-4444-8444-444444444444", percent: 50,
    }),
    validRunNote("bad-percent", "run-note-kanban", {
      kind: "progress", cardId: "33333333-3333-4333-8333-333333333333", percent: 101,
    }),
    validRunNote("bad-secret", "run-note-chat", { body: `note ${secret}` }),
    { ...validRunNote("bad-extra", "run-note-chat"), operationId: "forbidden" },
  ]) assert.throws(() => store.addRunNote(invalid));
  assert.deepEqual(fs.readFileSync(paths.eventLogPath), before);

  store.addRunNote(validRunNote("note-capacity", "run-note-chat"));
  assert.throws(
    () => store.addRunNote(validRunNote("note-per-run-full", "run-note-chat")),
    (error) => error.code === "RUN_NOTE_CAPACITY",
  );
  store.close();
});

test("schema v2 snapshot 严格迁移为空 RunNote 集合，当前 schema 损坏引用 fail closed", () => {
  const legacyPaths = fixturePaths("shoggoth-run-note-v2-");
  const legacyStore = openStore(legacyPaths, { now: () => 500 });
  legacyStore.putWorkRun(validRun("legacy-run"));
  legacyStore.close();
  const legacy = JSON.parse(fs.readFileSync(legacyPaths.stateSnapshotPath, "utf8"));
  legacy.schemaVersion = 2;
  delete legacy.runtimeAccounts;
  delete legacy.runtimeAccountTombstones;
  for (const profile of legacy.agentProfiles) delete profile.runtimeAccountId;
  legacy.workRuns = legacy.workRuns.map(({
    contextSnapshotId: _contextSnapshotId,
    runtimeSessionRef: sessionRef,
    runtimeTurnRef: turnRef,
    ...run
  }) => ({
    ...run,
    codexThreadId: sessionRef?.sessionId ?? null,
    codexTurnId: turnRef?.turnId ?? null,
  }));
  delete legacy.runNotes;
  delete legacy.mcpToolCalls;
  fs.writeFileSync(legacyPaths.stateSnapshotPath, encodeSnapshot(legacy), { mode: 0o600 });
  const migrated = openStore(legacyPaths, { now: () => 501 });
  assert.deepEqual(migrated.listRunNotes({}), []);
  migrated.close();
  assert.equal(
    JSON.parse(fs.readFileSync(legacyPaths.stateSnapshotPath, "utf8")).schemaVersion,
    STORE_SCHEMA_VERSION,
  );

  const corruptPaths = fixturePaths("shoggoth-run-note-corrupt-");
  const corruptStore = openStore(corruptPaths);
  corruptStore.putWorkRun(validRun("corrupt-run"));
  corruptStore.addRunNote(validRunNote("corrupt-note", "corrupt-run"));
  corruptStore.close();
  const snapshot = JSON.parse(fs.readFileSync(corruptPaths.stateSnapshotPath, "utf8"));
  snapshot.runNotes[0].runId = "missing";
  fs.writeFileSync(corruptPaths.stateSnapshotPath, encodeSnapshot(snapshot), { mode: 0o600 });
  assert.throws(
    () => openStore(corruptPaths),
    (error) => error.code === "STORE_CORRUPT_SNAPSHOT",
  );
});

test("McpToolCall 首次冻结 createdAt 与短 hash operationId，最长 Profile 仍小于 128B", () => {
  assert.deepEqual(MCP_TOOL_CALL_FIELDS, [
    "id", "profileId", "callId", "name", "fingerprint", "operationId", "binding", "createdAt",
    "status", "result",
  ]);
  const paths = fixturePaths("shoggoth-mcp-call-");
  const store = openStore(paths);
  const longProfileId = `p${"x".repeat(127)}`;
  store.putAgentProfile(validProfile(longProfileId));
  const input = {
    profileId: longProfileId,
    callId: "11111111-1111-4111-8111-111111111111",
    name: "kanban_add_comment",
    fingerprint: crypto.createHash("sha256").update("args").digest("hex"),
    binding: null,
    createdAt: 1234,
  };
  const begun = store.beginMcpToolCall(input);
  assert.match(begun.id, /^mcp-call-[a-f0-9]{48}$/u);
  assert.match(begun.operationId, /^mcp-v1-[a-f0-9]{48}$/u);
  assert(Buffer.byteLength(begun.operationId) < 128);
  assert.equal(begun.createdAt, 1234);
  assert.equal(begun.status, "pending");
  assert.equal(begun.result, null);
  assert.deepEqual(store.beginMcpToolCall({ ...input, createdAt: 9999 }), begun,
    "exact semantic replay 必须保留首次 Service 时间");
  store.close();
});

test("McpToolCall 同 callId 换 name/args conflict，completed result exact replay 不漂移", () => {
  const paths = fixturePaths("shoggoth-mcp-call-complete-");
  const store = openStore(paths);
  const base = {
    profileId: DEFAULT_AGENT_PROFILE_ID,
    callId: "22222222-2222-4222-8222-222222222222",
    name: "run_add_note",
    fingerprint: crypto.createHash("sha256").update("original").digest("hex"),
    binding: null,
    createdAt: 2000,
  };
  const begun = store.beginMcpToolCall(base);
  for (const patch of [
    { name: "artifact_publish" },
    { fingerprint: crypto.createHash("sha256").update("changed").digest("hex") },
  ]) assert.throws(
    () => store.beginMcpToolCall({ ...base, ...patch, createdAt: 3000 }),
    (error) => error.code === "MCP_TOOL_CALL_CONFLICT",
  );
  const outcome = { ok: true, result: { note: { id: "note-fixed", body: "fixed result" } } };
  const completed = store.completeMcpToolCall({ id: begun.id, outcome });
  outcome.result.note.body = "caller mutation";
  assert.equal(completed.result.result.note.body, "fixed result");
  assert.deepEqual(store.completeMcpToolCall({
    id: begun.id,
    outcome: { ok: true, result: { note: { id: "note-fixed", body: "fixed result" } } },
  }), completed);
  assert.throws(
    () => store.completeMcpToolCall({
      id: begun.id, outcome: { ok: true, result: { changed: true } },
    }),
    (error) => error.code === "MCP_TOOL_CALL_CONFLICT",
  );
  assert.deepEqual(store.beginMcpToolCall({ ...base, createdAt: 9999 }), completed);
  store.close();
});

test("McpToolCall pending/completed 跨重启，容量/secret/corrupt 均 fail closed", () => {
  const paths = fixturePaths("shoggoth-mcp-call-restart-");
  const store = openStore(paths, {
    maxMcpToolCalls: 2,
    isSensitiveValue: (value) => value === "fixture-secret-canary",
  });
  const first = store.beginMcpToolCall({
    profileId: DEFAULT_AGENT_PROFILE_ID,
    callId: "33333333-3333-4333-8333-333333333333",
    name: "kanban_add_comment",
    fingerprint: crypto.createHash("sha256").update("first").digest("hex"),
    binding: null,
    createdAt: 3000,
  });
  store.completeMcpToolCall({ id: first.id, outcome: { ok: true, result: { accepted: true } } });
  store.beginMcpToolCall({
    profileId: DEFAULT_AGENT_PROFILE_ID,
    callId: "44444444-4444-4444-8444-444444444444",
    name: "artifact_publish",
    fingerprint: crypto.createHash("sha256").update("second").digest("hex"),
    binding: null,
    createdAt: 4000,
  });
  const third = store.beginMcpToolCall({
    profileId: DEFAULT_AGENT_PROFILE_ID,
    callId: "55555555-5555-4555-8555-555555555555",
    name: "run_add_note",
    fingerprint: crypto.createHash("sha256").update("third").digest("hex"),
    binding: null,
    createdAt: 5000,
  });
  assert.equal(store.getMcpToolCall(first.id), null, "容量满时确定性驱逐最旧 completed");
  assert.equal(third.status, "pending");
  assert.throws(() => store.beginMcpToolCall({
    profileId: DEFAULT_AGENT_PROFILE_ID,
    callId: "66666666-6666-4666-8666-666666666666",
    name: "run_add_note",
    fingerprint: crypto.createHash("sha256").update("fourth").digest("hex"),
    binding: null,
    createdAt: 6000,
  }), (error) => error.code === "MCP_TOOL_CALL_CAPACITY");
  assert.throws(() => store.completeMcpToolCall({
    id: third.id,
    outcome: { ok: true, result: { body: "fixture-secret-canary" } },
  }));
  store.close();
  const reopened = openStore(paths, { maxMcpToolCalls: 2 });
  assert.equal(reopened.getMcpToolCall(first.id), null);
  assert.equal(reopened.listMcpToolCalls({ profileId: DEFAULT_AGENT_PROFILE_ID }).length, 2);
  reopened.close();

  const snapshot = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
  snapshot.mcpToolCalls[0].profileId = "missing-profile";
  fs.writeFileSync(paths.stateSnapshotPath, encodeSnapshot(snapshot), { mode: 0o600 });
  assert.throws(
    () => openStore(paths, { maxMcpToolCalls: 2 }),
    (error) => error.code === "STORE_INVALID_RECORD",
  );
});

test("McpToolCall completed 总结果预算确定性驱逐，单结果超总预算保留 pending", () => {
  const paths = fixturePaths("shoggoth-mcp-call-budget-");
  const store = openStore(paths, { maxMcpToolCalls: 4, maxMcpToolResultBytesTotal: 180 });
  const begin = (digit, createdAt) => store.beginMcpToolCall({
    profileId: DEFAULT_AGENT_PROFILE_ID,
    callId: `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`,
    name: "run_add_note",
    fingerprint: crypto.createHash("sha256").update(digit).digest("hex"),
    binding: null,
    createdAt,
  });
  const first = begin("7", 1);
  store.completeMcpToolCall({
    id: first.id, outcome: { ok: true, result: { text: "a".repeat(100) } },
  });
  const second = begin("8", 2);
  store.completeMcpToolCall({
    id: second.id, outcome: { ok: true, result: { text: "b".repeat(100) } },
  });
  assert.equal(store.getMcpToolCall(first.id), null);
  assert.equal(store.getMcpToolCall(second.id).status, "completed");
  const tooLarge = begin("9", 3);
  assert.throws(() => store.completeMcpToolCall({
    id: tooLarge.id, outcome: { ok: true, result: { text: "c".repeat(200) } },
  }), (error) => error.code === "MCP_TOOL_CALL_CAPACITY");
  assert.equal(store.getMcpToolCall(tooLarge.id).status, "pending");
  store.close();
});

test("completed Agent lifecycle ledger 在 24 小时窗口内不可淘汰", () => {
  const paths = fixturePaths("shoggoth-agent-ledger-retention-");
  let clock = 100;
  const store = openStore(paths, { maxMcpToolCalls: 1, now: () => clock });
  const lifecycle = store.beginMcpToolCall({
    profileId: DEFAULT_AGENT_PROFILE_ID,
    callId: "aaaaaaaa-aaaa-8aaa-8aaa-aaaaaaaaaaaa",
    name: "agent.create",
    fingerprint: crypto.createHash("sha256").update("agent-create-retained").digest("hex"),
    binding: null,
    createdAt: clock,
  });
  store.completeMcpToolCall({
    id: lifecycle.id,
    outcome: { ok: true, result: { profile: { id: "retained" } } },
  });
  const ordinary = {
    profileId: DEFAULT_AGENT_PROFILE_ID,
    callId: "bbbbbbbb-bbbb-8bbb-8bbb-bbbbbbbbbbbb",
    name: "run_add_note",
    fingerprint: crypto.createHash("sha256").update("ordinary-after-agent").digest("hex"),
    binding: null,
  };
  clock = 100 + (24 * 60 * 60 * 1000) - 1;
  assert.throws(
    () => store.beginMcpToolCall({ ...ordinary, createdAt: clock }),
    (error) => error.code === "MCP_TOOL_CALL_CAPACITY",
  );
  clock = 100 + (24 * 60 * 60 * 1000) + 1;
  const admitted = store.beginMcpToolCall({ ...ordinary, createdAt: clock });
  assert.equal(admitted.status, "pending");
  assert.equal(store.getMcpToolCall(lifecycle.id), null);
  store.close();
});

test("McpToolCall binding 只允许固定 SHA-256 secretDigest，拒绝原始 secret", () => {
  const paths = fixturePaths("shoggoth-profile-ledger-digest-");
  const store = openStore(paths, { sensitiveValues: ["fixture-profile-secret"] });
  const base = {
    profileId: DEFAULT_AGENT_PROFILE_ID,
    callId: "aaaaaaaa-aaaa-8aaa-8aaa-aaaaaaaaaaaa",
    name: "profile.configure",
    fingerprint: crypto.createHash("sha256").update("profile-configure").digest("hex"),
    createdAt: 10,
  };
  const secretDigest = crypto.createHash("sha256").update("fixture-profile-secret").digest("hex");
  const begun = store.beginMcpToolCall({
    ...base,
    binding: {
      method: "profile.configure",
      operationId: "profile-op",
      profileId: DEFAULT_AGENT_PROFILE_ID,
      providerRef: "provider-openai",
      defaultModel: "gpt-5",
      createdAt: 10,
      secretDigest,
    },
  });
  assert.equal(begun.binding.secretDigest, secretDigest);
  assert.equal(JSON.stringify(begun).includes("fixture-profile-secret"), false);
  assert.throws(
    () => store.beginMcpToolCall({
      ...base,
      callId: "bbbbbbbb-bbbb-8bbb-8bbb-bbbbbbbbbbbb",
      binding: { secret: "fixture-profile-secret" },
    }),
    (error) => error.code === "STORE_SENSITIVE_FIELD",
  );
  assert.throws(
    () => store.beginMcpToolCall({
      ...base,
      callId: "cccccccc-cccc-8ccc-8ccc-cccccccccccc",
      binding: { secretDigest: "not-a-digest" },
    }),
    (error) => error.code === "STORE_SENSITIVE_FIELD",
  );
  store.close();
});

test("profile.bind 持久绑定允许明确的空 secretDigest", () => {
  const paths = fixturePaths("shoggoth-profile-bind-ledger-");
  const store = openStore(paths);
  const begun = store.beginMcpToolCall({
    profileId: DEFAULT_AGENT_PROFILE_ID,
    callId: "dddddddd-dddd-8ddd-8ddd-dddddddddddd",
    name: "profile.bind",
    fingerprint: crypto.createHash("sha256").update("profile-bind").digest("hex"),
    binding: {
      method: "profile.bind",
      operationId: "profile-bind-op",
      profileId: DEFAULT_AGENT_PROFILE_ID,
      providerRef: null,
      defaultModel: "gpt-5.6-sol",
      createdAt: 10,
      secretDigest: null,
    },
    createdAt: 10,
  });
  assert.equal(begun.binding.secretDigest, null);
  store.close();
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
  else console.log(`PASS product store unit (${tests.length})`);
})();
