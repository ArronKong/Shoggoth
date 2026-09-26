#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const { resolveServicePaths } = require(path.join(ROOT, "app", "agent-service", "paths.js"));
const { atomicWritePrivateFile } = require(path.join(ROOT, "app", "agent-service", "private-file.js"));

let ChatSessionStore;
let validateChatContainer;
let CHAT_SESSION_STORE_VERSION;
let PendingCommandInbox;
let moduleLoadError = null;
try {
  ({
    CHAT_SESSION_STORE_VERSION,
    ChatSessionStore,
    validateContainer: validateChatContainer,
  } = require(path.join(
    ROOT, "app", "agent-service", "chat-session-store.js",
  )));
  ({ PendingCommandInbox } = require(path.join(
    ROOT, "app", "agent-service", "pending-command-inbox.js",
  )));
} catch (error) {
  moduleLoadError = error;
}

const tests = [];
const fixtureRoots = new Set();
function test(name, fn) { tests.push({ name, fn }); }

function fixturePaths(prefix = "shoggoth-chat-session-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtureRoots.add(root);
  return resolveServicePaths({
    trustedRoot: root,
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
  });
}

function xorCipher(value) {
  const bytes = Buffer.from(value, "utf8");
  for (let index = 0; index < bytes.length; index += 1) bytes[index] ^= 0xa5;
  return bytes;
}

function fakeSafeStorage(overrides = {}) {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => xorCipher(value),
    decryptString: (bytes) => xorCipher(Buffer.from(bytes)).toString("utf8"),
    ...overrides,
  };
}

function readInboxPlaintext(paths) {
  const envelope = JSON.parse(fs.readFileSync(path.join(paths.stateDir, "pending-commands.json"), "utf8"));
  return JSON.parse(xorCipher(Buffer.from(envelope.ciphertext, "base64")).toString("utf8"));
}

test("ChatSessionStore 与 PendingCommandInbox 模块可用", () => {
  assert.ifError(moduleLoadError);
  assert.equal(typeof ChatSessionStore, "function");
  assert.equal(typeof PendingCommandInbox, "function");
});

test("createSession 同步生成稳定 sessionKey，并以 0600 原子文件跨重启恢复", () => {
  const paths = fixturePaths();
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ];
  const first = new ChatSessionStore({
    paths,
    now: () => 100,
    randomUUID: () => ids.shift(),
  });
  first.open();
  const createInput = {
    operationId: "create-session-1",
    profileId: "profile-1",
    workspace: "/tmp/workspace",
    createdAt: 100,
  };
  const session = first.createSession(createInput);
  assert.deepEqual(session, {
    runtimeBindingId: null, retiredRuntimeSessions: [], revision: 1,
    id: "11111111-1111-4111-8111-111111111111",
    sessionKey: "22222222-2222-4222-8222-222222222222",
    profileId: "profile-1",
    codexThreadId: null,
    workspace: "/tmp/workspace",
    title: null,
    modelOverride: null,
    permissionMode: null,
    status: "draft",
    createdAt: 100,
    updatedAt: 100,
  });
  assert.deepEqual(first.createSession(createInput), session);
  assert.throws(
    () => first.createSession({ ...createInput, workspace: "/tmp/other" }),
    (error) => error.code === "CHAT_OPERATION_ID_CONFLICT",
  );
  assert.equal(first.getSession(session.sessionKey).id, session.id);
  assert.equal(fs.statSync(path.join(paths.stateDir, "chat-sessions.json")).mode & 0o777, 0o600);
  first.close();

  const restarted = new ChatSessionStore({ paths });
  restarted.open();
  assert.deepEqual(restarted.getSession(session.sessionKey), session);
  assert.deepEqual(restarted.listSessions(), [session]);
  restarted.close();
});

test("session model 与权限模式按会话隔离、幂等持久化并拒绝封存会话", () => {
  const paths = fixturePaths("shoggoth-session-model-");
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
  ];
  let now = 120;
  const store = new ChatSessionStore({ paths, now: () => now, randomUUID: () => ids.shift() });
  store.open();
  const first = store.createSession({
    operationId: "create-model-first", profileId: "profile-1", workspace: null, createdAt: now,
  });
  const second = store.createSession({
    operationId: "create-model-second", profileId: "profile-1", workspace: null, createdAt: now,
  });
  now = 121;
  const selected = store.setModelOverride(first.sessionKey, "gpt-5.6-terra");
  assert.equal(selected.modelOverride, "gpt-5.6-terra");
  const revision = JSON.parse(fs.readFileSync(store.filePath, "utf8")).revision;
  assert.deepEqual(store.setModelOverride(first.sessionKey, "gpt-5.6-terra"), selected);
  assert.equal(JSON.parse(fs.readFileSync(store.filePath, "utf8")).revision, revision);
  assert.equal(store.getSession(second.sessionKey).modelOverride, null);
  const permission = store.setPermissionMode(first.sessionKey, "workspace-auto");
  assert.equal(permission.permissionMode, "workspace-auto");
  const permissionRevision = JSON.parse(fs.readFileSync(store.filePath, "utf8")).revision;
  assert.deepEqual(store.setPermissionMode(first.sessionKey, "workspace-auto"), permission);
  assert.equal(JSON.parse(fs.readFileSync(store.filePath, "utf8")).revision, permissionRevision);
  assert.equal(store.getSession(second.sessionKey).permissionMode, null);
  store.close();

  const restarted = new ChatSessionStore({ paths });
  restarted.open();
  assert.equal(restarted.getSession(first.sessionKey).modelOverride, "gpt-5.6-terra");
  assert.equal(restarted.getSession(first.sessionKey).permissionMode, "workspace-auto");
  restarted.requestBinding(first.sessionKey, "bind-model-first", Date.now());
  restarted.completeBinding(first.sessionKey, "bind-model-first", "thread-model-first");
  restarted.requestArchive(first.sessionKey, "archive-model-first", Date.now());
  assert.throws(
    () => restarted.setModelOverride(first.sessionKey, "gpt-5.6-sol"),
    (error) => error.code === "CHAT_SESSION_NOT_READY",
  );
  assert.throws(
    () => restarted.setPermissionMode(first.sessionKey, "ask"),
    (error) => error.code === "CHAT_SESSION_NOT_READY",
  );
  restarted.close();
});

test("v1 ChatSession 容器读取时补齐新增字段与 Runtime session，首次切换写回当前 schema", () => {
  const paths = fixturePaths("shoggoth-session-model-v1-");
  const ids = [
    "55555555-5555-4555-8555-555555555555",
    "66666666-6666-4666-8666-666666666666",
  ];
  const store = new ChatSessionStore({ paths, now: () => 130, randomUUID: () => ids.shift() });
  store.open();
  const session = store.createSession({
    operationId: "create-model-v1", profileId: "profile-1", workspace: null, createdAt: 130,
  });
  store.close();
  const filePath = path.join(paths.stateDir, "chat-sessions.json");
  const legacy = JSON.parse(fs.readFileSync(filePath, "utf8"));
  legacy.version = 1;
  delete legacy.cronRuns;
  delete legacy.runtimeSwitches;
  for (const value of Object.values(legacy.sessions)) {
    delete value.runtimeBindingId; delete value.retiredRuntimeSessions; delete value.revision;
    value.codexThreadId = value.runtimeSessionId;
    delete value.runtimeSessionId;
    delete value.modelOverride;
    delete value.permissionMode;
  }
  fs.writeFileSync(filePath, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

  const restarted = new ChatSessionStore({ paths, now: () => 131 });
  restarted.open();
  assert.equal(restarted.getSession(session.sessionKey).modelOverride, null);
  restarted.setModelOverride(session.sessionKey, "gpt-5.6-luna");
  const migrated = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(migrated.version, CHAT_SESSION_STORE_VERSION);
  assert.equal(migrated.sessions[session.sessionKey].modelOverride, "gpt-5.6-luna");
  restarted.close();
});

test("thread binding 以 operationId 幂等恢复，并全局拒绝重复 threadId", () => {
  const paths = fixturePaths();
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
  ];
  let now = 200;
  const store = new ChatSessionStore({ paths, now: () => now, randomUUID: () => ids.shift() });
  store.open();
  const first = store.createSession({
    operationId: "create-first", profileId: "profile-1", workspace: null, createdAt: 200,
  });
  const second = store.createSession({
    operationId: "create-second", profileId: "profile-1", workspace: null, createdAt: 200,
  });

  now = 201;
  const pending = store.requestBinding(first.sessionKey, "bind-op-1", 201);
  assert.equal(pending.threadSource, `shoggoth:${first.sessionKey}:bind-op-1`);
  assert.deepEqual(store.requestBinding(first.sessionKey, "bind-op-1", 201), pending);
  assert.equal(store.getSession(first.sessionKey).status, "binding");
  assert.throws(
    () => store.requestBinding(first.sessionKey, "bind-op-other", 201),
    (error) => error.code === "CHAT_SESSION_BINDING_CONFLICT",
  );

  now = 202;
  const ready = store.completeBinding(first.sessionKey, "bind-op-1", "thread-shared");
  assert.equal(ready.codexThreadId, "thread-shared");
  assert.equal(ready.status, "ready");
  assert.deepEqual(store.completeBinding(first.sessionKey, "bind-op-1", "thread-shared"), ready);

  store.requestBinding(second.sessionKey, "bind-op-2", 202);
  assert.throws(
    () => store.completeBinding(second.sessionKey, "bind-op-2", "thread-shared"),
    (error) => error.code === "CHAT_THREAD_ID_CONFLICT",
  );
  store.close();

  const restarted = new ChatSessionStore({ paths });
  restarted.open();
  assert.deepEqual(restarted.listPendingBindings(), [{
    operationId: "bind-op-2",
    sessionKey: second.sessionKey,
    threadSource: `shoggoth:${second.sessionKey}:bind-op-2`,
    state: "pending",
    codexThreadId: null,
    createdAt: 202,
    updatedAt: 202,
    finishedAt: null,
  }]);
  assert.equal(restarted.getSession(second.sessionKey).status, "binding");
  restarted.close();
});

test("远端未持久化的 bound thread 可在明确旧值后原子换绑并跨重启保留", () => {
  const paths = fixturePaths("shoggoth-bound-thread-repair-");
  const ids = [
    "51515151-5151-4515-8515-515151515151",
    "52525252-5252-4525-8525-525252525252",
  ];
  let now = 220;
  const store = new ChatSessionStore({ paths, now: () => now, randomUUID: () => ids.shift() });
  store.open();
  const session = store.createSession({
    operationId: "create-bound-repair", profileId: "profile-1", workspace: null, createdAt: now,
  });
  const binding = store.requestBinding(session.sessionKey, "bind-bound-repair", now);
  store.completeBinding(session.sessionKey, binding.operationId, "thread-ephemeral");
  assert.equal(store.getBinding(session.sessionKey).codexThreadId, "thread-ephemeral");

  now += 1;
  assert.throws(
    () => store.replaceBoundThread({
      sessionKey: session.sessionKey,
      operationId: binding.operationId,
      expectedCodexThreadId: "thread-other",
      codexThreadId: "thread-persisted",
    }),
    (error) => error.code === "CHAT_SESSION_BINDING_CONFLICT",
  );
  const repaired = store.replaceBoundThread({
    sessionKey: session.sessionKey,
    operationId: binding.operationId,
    expectedCodexThreadId: "thread-ephemeral",
    codexThreadId: "thread-persisted",
  });
  assert.equal(repaired.status, "ready");
  assert.equal(repaired.codexThreadId, "thread-persisted");
  assert.equal(store.getBinding(session.sessionKey).codexThreadId, "thread-persisted");
  store.close();

  const restarted = new ChatSessionStore({ paths });
  restarted.open();
  assert.equal(restarted.getSession(session.sessionKey).codexThreadId, "thread-persisted");
  assert.equal(restarted.getBinding(session.sessionKey).codexThreadId, "thread-persisted");
  restarted.close();
});

test("rename/archive/delete 先落本地状态，远端失败后可跨重启补偿", () => {
  const paths = fixturePaths();
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ];
  let now = 300;
  const first = new ChatSessionStore({ paths, now: () => now, randomUUID: () => ids.shift() });
  first.open();
  const session = first.createSession({
    operationId: "create-remote", profileId: "profile-1", workspace: null, createdAt: 300,
  });
  first.requestBinding(session.sessionKey, "bind-op", 300);
  first.completeBinding(session.sessionKey, "bind-op", "thread-1");

  now = 301;
  const rename = first.requestRename(session.sessionKey, "Renamed", "rename-op", 301);
  assert.equal(first.getSession(session.sessionKey).title, "Renamed");
  assert.deepEqual(first.requestRename(session.sessionKey, "Renamed", "rename-op", 301), rename);
  first.close();

  const restarted = new ChatSessionStore({ paths, now: () => 302 });
  restarted.open();
  assert.deepEqual(restarted.listPendingRemoteOperations(), [rename]);
  restarted.completeRemoteOperation("rename-op");
  assert.deepEqual(restarted.listPendingRemoteOperations(), []);

  const archive = restarted.requestArchive(session.sessionKey, "archive-op", 302);
  assert.equal(restarted.getSession(session.sessionKey).status, "archived");
  assert.deepEqual(restarted.listPendingRemoteOperations(), [archive]);
  restarted.completeRemoteOperation("archive-op");

  const deletion = restarted.requestDelete(session.sessionKey, "delete-op", 302);
  assert.equal(restarted.getSession(session.sessionKey).status, "delete_pending");
  assert.deepEqual(restarted.listPendingRemoteOperations(), [deletion]);
  restarted.close();

  const finalStore = new ChatSessionStore({ paths });
  finalStore.open();
  assert.equal(finalStore.listPendingRemoteOperations()[0].operationId, "delete-op");
  assert.equal(finalStore.completeRemoteOperation("delete-op"), null);
  assert.equal(finalStore.getSession(session.sessionKey), null);
  assert.deepEqual(finalStore.listPendingRemoteOperations(), []);
  finalStore.close();

  const afterDeleteRestart = new ChatSessionStore({ paths });
  afterDeleteRestart.open();
  assert.equal(afterDeleteRestart.getSession(session.sessionKey), null);
  assert.deepEqual(afterDeleteRestart.listPendingRemoteOperations(), []);
  afterDeleteRestart.close();
});

test("rename title=null 持久化为可恢复的本地清空操作", () => {
  const paths = fixturePaths("shoggoth-chat-clear-title-");
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ];
  let now = 400;
  const first = new ChatSessionStore({ paths, now: () => now, randomUUID: () => ids.shift() });
  first.open();
  const session = first.createSession({
    operationId: "create-clear", profileId: "profile-1", workspace: null, createdAt: 400,
  });
  first.requestBinding(session.sessionKey, "bind-clear", 400);
  first.completeBinding(session.sessionKey, "bind-clear", "thread-clear");
  now = 401;
  const clear = first.requestRename(session.sessionKey, null, "clear-title", 401);
  assert.equal(clear.title, null);
  assert.equal(clear.state, "pending");
  assert.equal(first.getSession(session.sessionKey).title, null);
  first.close();

  const restarted = new ChatSessionStore({ paths, now: () => 402 });
  restarted.open();
  assert.deepEqual(restarted.listPendingRemoteOperations(), [clear]);
  assert.equal(restarted.completeRemoteOperation(clear.operationId).title, null);
  assert.deepEqual(restarted.requestRename(
    session.sessionKey, null, "clear-title", 401,
  ), { ...clear, state: "completed", updatedAt: 402, finishedAt: 402 });
  restarted.close();
});

test("远端 thread/start 成功但本地绑定写失败时按 threadSource 恢复且不二次启动", () => {
  const paths = fixturePaths("shoggoth-binding-recovery-");
  const ids = [
    "77777777-7777-4777-8777-777777777777",
    "88888888-8888-4888-8888-888888888888",
  ];
  let writes = 0;
  const first = new ChatSessionStore({
    paths,
    now: () => 350,
    randomUUID: () => ids.shift(),
    atomicWrite(target, value, options) {
      writes += 1;
      if (writes === 3) throw new Error("injected local bind failure");
      return atomicWritePrivateFile(target, value, options);
    },
  });
  first.open();
  const session = first.createSession({
    operationId: "create-recovery", profileId: "profile-1", workspace: null, createdAt: 350,
  });
  const request = first.requestBinding(session.sessionKey, "binding-recovery", 350);
  let threadStartCalls = 1;
  const remoteThread = { id: "thread-recovered", threadSource: request.threadSource };
  assert.throws(
    () => first.completeBinding(session.sessionKey, request.operationId, remoteThread.id),
    (error) => error.code === "CHAT_SESSION_WRITE_FAILED",
  );
  first.close();

  const restarted = new ChatSessionStore({ paths });
  restarted.open();
  const pending = restarted.listPendingBindings();
  const match = [remoteThread].find((thread) => thread.threadSource === pending[0].threadSource);
  if (match) restarted.recoverBinding({
    threadSource: match.threadSource,
    codexThreadId: match.id,
  });
  else threadStartCalls += 1;
  assert.equal(threadStartCalls, 1);
  assert.equal(restarted.getSession(session.sessionKey).codexThreadId, "thread-recovered");
  assert.deepEqual(restarted.listPendingBindings(), []);
  restarted.close();
});

test("completed remote operations 窗口内满载拒绝，窗口外才回收", () => {
  const paths = fixturePaths("shoggoth-remote-capacity-");
  const ids = [
    "99999999-9999-4999-8999-999999999999",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ];
  let now = 360;
  const store = new ChatSessionStore({
    paths,
    now: () => now,
    randomUUID: () => ids.shift(),
    maxCompletedRemoteOperations: 2,
  });
  store.open();
  const session = store.createSession({
    operationId: "create-remote-capacity", profileId: "profile-1", workspace: null, createdAt: 360,
  });
  store.requestBinding(session.sessionKey, "bind-remote-capacity", 360);
  store.completeBinding(session.sessionKey, "bind-remote-capacity", "thread-capacity");
  for (let index = 1; index <= 2; index += 1) {
    now += 1;
    store.requestRename(session.sessionKey, `Title ${index}`, `rename-capacity-${index}`, now);
    store.completeRemoteOperation(`rename-capacity-${index}`);
  }
  now += 1;
  store.requestRename(session.sessionKey, "Title 3", "rename-capacity-3", now);
  assert.throws(
    () => store.completeRemoteOperation("rename-capacity-3"),
    (error) => error.code === "CHAT_SESSION_CAPACITY",
  );
  now += 30 * 24 * 60 * 60 * 1000 + 1;
  store.completeRemoteOperation("rename-capacity-3");
  const disk = JSON.parse(fs.readFileSync(path.join(paths.stateDir, "chat-sessions.json"), "utf8"));
  assert.deepEqual(Object.keys(disk.remoteOperations), ["rename-capacity-3"]);
  store.close();

  const restarted = new ChatSessionStore({ paths, maxCompletedRemoteOperations: 2 });
  restarted.open();
  assert.equal(restarted.getSession(session.sessionKey).title, "Title 3");
  assert.deepEqual(restarted.listPendingRemoteOperations(), []);
  restarted.close();
});

test("atomic writer committed=true 安装 candidate；create unknown commit 由 operationId 重启收敛", async () => {
  const chatPaths = fixturePaths("shoggoth-chat-committed-");
  const ids = [
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  ];
  let chatWrites = 0;
  const chat = new ChatSessionStore({
    paths: chatPaths,
    randomUUID: () => ids.shift(),
    atomicWrite(target, value, options) {
      atomicWritePrivateFile(target, value, options);
      chatWrites += 1;
      if (chatWrites === 1) {
        const error = new Error("committed cleanup failure");
        error.committed = true;
        throw error;
      }
    },
  });
  chat.open();
  const createInput = {
    operationId: "create-committed", profileId: "profile-1", workspace: null,
    createdAt: Date.now(),
  };
  const committedSession = chat.createSession(createInput);
  assert.deepEqual(chat.getSession(committedSession.sessionKey), committedSession);
  chat.close();
  const committedRestart = new ChatSessionStore({ paths: chatPaths });
  committedRestart.open();
  assert.deepEqual(committedRestart.createSession(createInput), committedSession);
  committedRestart.close();

  const uncertainPaths = fixturePaths("shoggoth-chat-unknown-commit-");
  const uncertainIds = [
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  ];
  const unknownCreatedAt = Date.now();
  const uncertain = new ChatSessionStore({
    paths: uncertainPaths,
    now: () => unknownCreatedAt,
    randomUUID: () => uncertainIds.shift(),
    atomicWrite(target, value, options) {
      atomicWritePrivateFile(target, value, options);
      const error = new Error("unknown commit result");
      error.committedUncertain = true;
      throw error;
    },
  });
  uncertain.open();
  assert.throws(
    () => uncertain.createSession({
      operationId: "create-unknown", profileId: "profile-1", workspace: null,
      createdAt: unknownCreatedAt,
    }),
    (error) => error.code === "CHAT_SESSION_COMMIT_UNCERTAIN",
  );
  uncertain.close();
  const recovered = new ChatSessionStore({ paths: uncertainPaths, now: () => unknownCreatedAt });
  recovered.open();
  const recoveredInput = JSON.parse(fs.readFileSync(
    path.join(uncertainPaths.stateDir, "chat-sessions.json"), "utf8",
  )).createOperations["create-unknown"];
  const recoveredSession = recovered.createSession({
    operationId: "create-unknown",
    profileId: "profile-1",
    workspace: null,
    createdAt: recoveredInput.createdAt,
  });
  assert.equal(recoveredSession.id, "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  recovered.close();

  const inboxPaths = fixturePaths("shoggoth-inbox-committed-");
  let inboxWrites = 0;
  const inbox = new PendingCommandInbox({
    paths: inboxPaths,
    safeStorage: fakeSafeStorage(),
    now: () => 370,
    atomicWrite(target, value, options) {
      atomicWritePrivateFile(target, value, options);
      inboxWrites += 1;
      if (inboxWrites === 1) {
        const error = new Error("committed cleanup failure");
        error.committed = true;
        throw error;
      }
    },
  });
  await inbox.open();
  const commandInput = {
    operationId: "operation-committed",
    runId: "run-committed",
    sessionKey: "22222222-2222-4222-8222-222222222222",
    prompt: "prompt-committed",
    createdAt: 370,
  };
  const committedCommand = await inbox.enqueue(commandInput);
  assert.deepEqual(inbox.get(commandInput.operationId), committedCommand);
  await inbox.close();
  const inboxRestart = new PendingCommandInbox({
    paths: inboxPaths, safeStorage: fakeSafeStorage(), now: () => 371,
  });
  await inboxRestart.open();
  assert.deepEqual(await inboxRestart.enqueue(commandInput), committedCommand);
  await inboxRestart.close();
});

test("两个 Store 各自取得 0600 writer lease，同类型双实例拒绝且 close 后可重取", async () => {
  const paths = fixturePaths("shoggoth-writer-lease-");
  const firstChat = new ChatSessionStore({ paths });
  const secondChat = new ChatSessionStore({ paths });
  const inbox = new PendingCommandInbox({ paths, safeStorage: fakeSafeStorage() });
  firstChat.open();
  await inbox.open();
  const chatLock = path.join(paths.stateDir, "chat-sessions.writer.lock");
  const inboxLock = path.join(paths.stateDir, "pending-commands.writer.lock");
  assert.equal(fs.statSync(chatLock).mode & 0o777, 0o600);
  assert.equal(fs.statSync(inboxLock).mode & 0o777, 0o600);
  const record = JSON.parse(fs.readFileSync(chatLock, "utf8"));
  assert.equal(record.pid, process.pid);
  assert.equal(typeof record.startIdentity, "string");
  assert.equal(record.startIdentity.length > 0, true);
  assert.match(record.candidateBasename, /^chat-sessions\.writer\.lock\.candidate-[1-9][0-9]*-[a-f0-9]{64}$/);
  const chatCandidate = path.join(paths.stateDir, record.candidateBasename);
  const fixedStat = fs.lstatSync(chatLock);
  const candidateStat = fs.lstatSync(chatCandidate);
  assert.deepEqual([fixedStat.dev, fixedStat.ino], [candidateStat.dev, candidateStat.ino]);
  assert.equal(fixedStat.nlink, 2);
  assert.equal(candidateStat.mode & 0o777, 0o600);
  assert.throws(
    () => secondChat.open(),
    (error) => error.code === "WRITER_LEASE_HELD",
  );
  firstChat.close();
  assert.equal(fs.existsSync(chatLock), false);
  secondChat.open();
  secondChat.close();
  await inbox.close();
  assert.equal(fs.existsSync(inboxLock), false);
});

test("writer lease 安全回收真实 crash/PID reuse，且 inode 被替换时 close 不误删", () => {
  const crashPaths = fixturePaths("shoggoth-writer-crash-");
  const storeModule = path.join(ROOT, "app", "agent-service", "chat-session-store.js");
  const crashScript = [
    '"use strict";',
    "const { ChatSessionStore } = require(process.argv[1]);",
    "const paths = JSON.parse(process.argv[2]);",
    "new ChatSessionStore({ paths }).open();",
    "process.exit(17);",
  ].join("\n");
  const crashed = spawnSync(process.execPath, [
    "-e", crashScript, storeModule, JSON.stringify(crashPaths),
  ], { encoding: "utf8" });
  assert.equal(crashed.status, 17, crashed.stderr);
  const crashLock = path.join(crashPaths.stateDir, "chat-sessions.writer.lock");
  const deadRecord = JSON.parse(fs.readFileSync(crashLock, "utf8"));
  assert.notEqual(deadRecord.pid, process.pid);
  const recovered = new ChatSessionStore({ paths: crashPaths });
  recovered.open();
  assert.equal(JSON.parse(fs.readFileSync(crashLock, "utf8")).pid, process.pid);
  recovered.close();

  const reusePaths = fixturePaths("shoggoth-writer-pid-reuse-");
  fs.mkdirSync(reusePaths.stateDir, { recursive: true, mode: 0o700 });
  const reuseLock = path.join(reusePaths.stateDir, "chat-sessions.writer.lock");
  const staleNonce = "a".repeat(64);
  const staleCandidateBasename = `chat-sessions.writer.lock.candidate-${process.pid}-${staleNonce}`;
  const staleCandidate = path.join(reusePaths.stateDir, staleCandidateBasename);
  fs.writeFileSync(staleCandidate, `${JSON.stringify({
    version: 1,
    pid: process.pid,
    startIdentity: "stale-process-start-identity",
    nonce: staleNonce,
    candidateBasename: staleCandidateBasename,
    createdAt: 1,
  })}\n`, { mode: 0o600 });
  fs.linkSync(staleCandidate, reuseLock);
  const reused = new ChatSessionStore({ paths: reusePaths });
  reused.open();
  assert.notEqual(
    JSON.parse(fs.readFileSync(reuseLock, "utf8")).startIdentity,
    "stale-process-start-identity",
  );
  reused.close();

  const replacePaths = fixturePaths("shoggoth-writer-replaced-");
  const owner = new ChatSessionStore({ paths: replacePaths });
  owner.open();
  const target = path.join(replacePaths.stateDir, "chat-sessions.writer.lock");
  const stolen = `${target}.stolen`;
  fs.renameSync(target, stolen);
  fs.writeFileSync(target, "replacement-owner\n", { mode: 0o600 });
  owner.close();
  assert.equal(fs.readFileSync(target, "utf8"), "replacement-owner\n");
  assert.equal(fs.existsSync(stolen), true);
});

test("writer lease 在 claim 前后真实 crash 均留下可恢复的完整证据", () => {
  const leaseModule = path.join(ROOT, "app", "agent-service", "private-writer-lease.js");
  for (const cut of ["before", "after"]) {
    const paths = fixturePaths(`shoggoth-writer-crash-${cut}-claim-`);
    const lock = path.join(paths.stateDir, "chat-sessions.writer.lock");
    const script = [
      '"use strict";',
      "const fs = require('node:fs');",
      "const { acquirePrivateWriterLease } = require(process.argv[1]);",
      "const lockPath = process.argv[2];",
      "const trustedRoot = process.argv[3];",
      "const cut = process.argv[4];",
      "const injected = { ...fs, linkSync(source, target) {",
      "  if (cut === 'after') fs.linkSync(source, target);",
      "  process.exit(cut === 'before' ? 18 : 19);",
      "} };",
      "acquirePrivateWriterLease({ lockPath, trustedRoot, fs: injected });",
    ].join("\n");
    const crashed = spawnSync(process.execPath, [
      "-e", script, leaseModule, lock, paths.trustedRoot, cut,
    ], { encoding: "utf8" });
    assert.equal(crashed.status, cut === "before" ? 18 : 19, crashed.stderr);
    const candidates = fs.readdirSync(paths.stateDir)
      .filter((name) => name.startsWith("chat-sessions.writer.lock.candidate-"));
    assert.equal(candidates.length, 1);
    const candidateStat = fs.lstatSync(path.join(paths.stateDir, candidates[0]));
    assert.equal(candidateStat.mode & 0o777, 0o600);
    if (cut === "before") {
      assert.equal(fs.existsSync(lock), false);
      assert.equal(candidateStat.nlink, 1);
    } else {
      assert.equal(fs.existsSync(lock), true);
      assert.deepEqual(
        [fs.lstatSync(lock).dev, fs.lstatSync(lock).ino],
        [candidateStat.dev, candidateStat.ino],
      );
      assert.equal(candidateStat.nlink, 2);
    }
    const recovered = new ChatSessionStore({ paths });
    recovered.open();
    assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).pid, process.pid);
    recovered.close();
  }
});

test("writer lease stale replacement race fail closed 且 release EIO 可重试", async () => {
  const racePaths = fixturePaths("shoggoth-writer-recovery-race-");
  const storeModule = path.join(ROOT, "app", "agent-service", "chat-session-store.js");
  const crashScript = [
    '"use strict";',
    "const { ChatSessionStore } = require(process.argv[1]);",
    "new ChatSessionStore({ paths: JSON.parse(process.argv[2]) }).open();",
    "process.exit(20);",
  ].join("\n");
  const crashed = spawnSync(process.execPath, [
    "-e", crashScript, storeModule, JSON.stringify(racePaths),
  ], { encoding: "utf8" });
  assert.equal(crashed.status, 20, crashed.stderr);
  const raceLock = path.join(racePaths.stateDir, "chat-sessions.writer.lock");
  const originalEvidence = `${raceLock}.original-evidence`;
  let injectedRace = false;
  const racingFs = {
    ...fs,
    renameSync(source, destination) {
      if (!injectedRace && source === raceLock
        && destination.includes(".quarantine-fixed-")) {
        injectedRace = true;
        fs.renameSync(source, originalEvidence);
        fs.writeFileSync(source, "replacement-owner\n", { mode: 0o600 });
      }
      return fs.renameSync(source, destination);
    },
  };
  assert.throws(
    () => new ChatSessionStore({ paths: racePaths, fs: racingFs }).open(),
    (error) => error.code === "WRITER_LEASE_RECOVERY_RACE",
  );
  assert.equal(fs.readFileSync(raceLock, "utf8"), "replacement-owner\n");
  assert.equal(fs.existsSync(originalEvidence), true);

  const retryPaths = fixturePaths("shoggoth-writer-release-retry-");
  let failRelease = false;
  let failedOnce = false;
  const retryFs = {
    ...fs,
    unlinkSync(target) {
      if (failRelease && !failedOnce
        && path.basename(target).startsWith(".quarantine-release-")) {
        failedOnce = true;
        const error = new Error("injected release EIO");
        error.code = "EIO";
        throw error;
      }
      return fs.unlinkSync(target);
    },
  };
  const store = new ChatSessionStore({ paths: retryPaths, fs: retryFs });
  store.open();
  const retryLock = path.join(retryPaths.stateDir, "chat-sessions.writer.lock");
  failRelease = true;
  assert.throws(() => store.close(), (error) => error.code === "EIO");
  assert.equal(fs.existsSync(retryLock), true);
  assert.throws(
    () => new ChatSessionStore({ paths: retryPaths }).open(),
    (error) => error.code === "WRITER_LEASE_HELD",
  );
  assert.equal(store.listSessions().length, 0, "失败 close 必须保留 open 与 lease 引用");
  store.close();
  assert.equal(fs.existsSync(retryLock), false);
  assert.equal(
    fs.readdirSync(retryPaths.stateDir)
      .some((name) => name.startsWith("chat-sessions.writer.lock.")),
    false,
  );

  const inboxPaths = fixturePaths("shoggoth-inbox-release-retry-");
  failRelease = false;
  failedOnce = false;
  const inbox = new PendingCommandInbox({
    paths: inboxPaths,
    fs: retryFs,
    safeStorage: fakeSafeStorage(),
  });
  await inbox.open();
  const inboxLock = path.join(inboxPaths.stateDir, "pending-commands.writer.lock");
  failRelease = true;
  await assert.rejects(inbox.close(), (error) => error.code === "EIO");
  assert.deepEqual(inbox.list(), [], "Inbox 失败 close 必须保留 open 与 lease 引用");
  await inbox.close();
  assert.equal(fs.existsSync(inboxLock), false);
});

test("两个 Store open 失败且 lease release EIO 时保留 cleanup lease 供 close 重试", async () => {
  for (const kind of ["chat", "pending"]) {
    const paths = fixturePaths(`shoggoth-open-cleanup-${kind}-`);
    fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
    const dataPath = path.join(
      paths.stateDir,
      kind === "chat" ? "chat-sessions.json" : "pending-commands.json",
    );
    fs.writeFileSync(dataPath, "{broken\n", { mode: 0o600 });
    let failedOnce = false;
    const injectedFs = {
      ...fs,
      unlinkSync(target) {
        if (!failedOnce && path.basename(target).startsWith(".quarantine-release-")) {
          failedOnce = true;
          const error = new Error("injected open cleanup EIO");
          error.code = "EIO";
          throw error;
        }
        return fs.unlinkSync(target);
      },
    };
    const store = kind === "chat"
      ? new ChatSessionStore({ paths, fs: injectedFs })
      : new PendingCommandInbox({ paths, fs: injectedFs, safeStorage: fakeSafeStorage() });
    let aggregate;
    try {
      if (kind === "pending") await store.open();
      else store.open();
      assert.fail("open 应失败");
    } catch (error) {
      aggregate = error;
    }
    assert.equal(aggregate instanceof AggregateError, true);
    assert.equal(
      aggregate.errors[0].code,
      kind === "chat" ? "CHAT_SESSION_STORE_CORRUPT" : "PENDING_COMMAND_INBOX_CORRUPT",
    );
    assert.equal(aggregate.errors[1].code, "LEASE_RELEASE_FAILED");
    assert.equal(store.cleanupPending, true);
    const lock = path.join(
      paths.stateDir,
      kind === "chat" ? "chat-sessions.writer.lock" : "pending-commands.writer.lock",
    );
    assert.equal(fs.existsSync(lock), true);
    assert.equal(
      fs.readdirSync(paths.stateDir).some((name) => name.startsWith(".quarantine-release-")),
      true,
    );
    if (kind === "pending") await store.close();
    else store.close();
    assert.equal(store.cleanupPending, false);
    assert.equal(fs.existsSync(lock), false);
    assert.equal(
      fs.readdirSync(paths.stateDir).some((name) => name.startsWith(".quarantine-release-")),
      false,
    );
  }
});

test("进程死于 release candidate quarantine 后，新实例 inode-safe 恢复", () => {
  const paths = fixturePaths("shoggoth-release-crash-recovery-");
  const leaseModule = path.join(ROOT, "app", "agent-service", "private-writer-lease.js");
  const lock = path.join(paths.stateDir, "chat-sessions.writer.lock");
  const script = [
    '"use strict";',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const { acquirePrivateWriterLease } = require(process.argv[1]);",
    "const injected = { ...fs, unlinkSync(target) {",
    "  if (path.basename(target).startsWith('.quarantine-release-')) process.exit(23);",
    "  return fs.unlinkSync(target);",
    "} };",
    "const lease = acquirePrivateWriterLease({",
    "  lockPath: process.argv[2], trustedRoot: process.argv[3], fs: injected,",
    "});",
    "lease.release();",
  ].join("\n");
  const crashed = spawnSync(process.execPath, [
    "-e", script, leaseModule, lock, paths.trustedRoot,
  ], { encoding: "utf8" });
  assert.equal(crashed.status, 23, crashed.stderr);
  const record = JSON.parse(fs.readFileSync(lock, "utf8"));
  const evidence = path.join(
    paths.stateDir,
    `.quarantine-release-${record.candidateBasename}`,
  );
  const fixedStat = fs.lstatSync(lock);
  const evidenceStat = fs.lstatSync(evidence);
  assert.deepEqual([fixedStat.dev, fixedStat.ino], [evidenceStat.dev, evidenceStat.ino]);
  assert.equal(fixedStat.nlink, 2);
  assert.equal(fs.readFileSync(evidence, "utf8"), fs.readFileSync(lock, "utf8"));

  const recovered = new ChatSessionStore({ paths });
  recovered.open();
  assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).pid, process.pid);
  assert.equal(fs.existsSync(evidence), false);
  recovered.close();
});

test("status/threadId/binding/threadSource 任一反向不变量损坏均拒绝重启并释放 lease", () => {
  const mutations = [
    (disk, sessionKey) => { disk.sessions[sessionKey].codexThreadId = "forged-thread"; },
    (disk, sessionKey) => { disk.sessions[sessionKey].status = "ready"; },
    (disk, sessionKey) => {
      disk.bindingOperations[sessionKey].threadSource = `shoggoth:${sessionKey}:forged`;
    },
  ];
  for (let index = 0; index < mutations.length; index += 1) {
    const paths = fixturePaths(`shoggoth-binding-invariant-${index}-`);
    const ids = [
      `11111111-1111-4111-8111-11111111111${index}`,
      `22222222-2222-4222-8222-22222222222${index}`,
    ];
    const store = new ChatSessionStore({ paths, randomUUID: () => ids.shift() });
    store.open();
    const createdAt = Date.now();
    const session = store.createSession({
      operationId: `create-invariant-${index}`, profileId: "profile-1", workspace: null,
      createdAt,
    });
    if (index === 2) {
      store.requestBinding(session.sessionKey, `bind-invariant-${index}`, createdAt);
    }
    store.close();
    const filePath = path.join(paths.stateDir, "chat-sessions.json");
    const disk = JSON.parse(fs.readFileSync(filePath, "utf8"));
    mutations[index](disk, session.sessionKey);
    fs.writeFileSync(filePath, `${JSON.stringify(disk)}\n`, { mode: 0o600 });
    assert.throws(
      () => new ChatSessionStore({ paths }).open(),
      (error) => error.code === "CHAT_SESSION_STORE_CORRUPT",
    );
    assert.equal(
      fs.existsSync(path.join(paths.stateDir, "chat-sessions.writer.lock")),
      false,
    );
  }
});

test("writer lease 的 malformed/symlink/hardlink 证据均 fail closed 且不改写 victim", () => {
  const malformedPaths = fixturePaths("shoggoth-writer-malformed-");
  fs.mkdirSync(malformedPaths.stateDir, { recursive: true, mode: 0o700 });
  const malformedLock = path.join(malformedPaths.stateDir, "chat-sessions.writer.lock");
  fs.writeFileSync(malformedLock, "{broken\n", { mode: 0o600 });
  assert.throws(
    () => new ChatSessionStore({ paths: malformedPaths }).open(),
    (error) => error.code === "WRITER_LEASE_CORRUPT",
  );
  assert.equal(fs.readFileSync(malformedLock, "utf8"), "{broken\n");

  for (const kind of ["symlink", "hardlink"]) {
    const paths = fixturePaths(`shoggoth-writer-${kind}-`);
    fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
    const victim = path.join(path.dirname(paths.stateDir), `writer-victim-${kind}`);
    fs.writeFileSync(victim, "writer-victim\n", { mode: 0o600 });
    const lock = path.join(paths.stateDir, "chat-sessions.writer.lock");
    if (kind === "symlink") fs.symlinkSync(victim, lock);
    else fs.linkSync(victim, lock);
    assert.throws(
      () => new ChatSessionStore({ paths }).open(),
      (error) => ["UNSAFE_SYMLINK", "UNSAFE_HARDLINK"].includes(error.code),
    );
    assert.equal(fs.readFileSync(victim, "utf8"), "writer-victim\n");
  }
});

test("createOperations active 与 4096 deleted tombstone 独立计数", () => {
  const createOperations = {};
  for (let index = 0; index < 4096; index += 1) {
    const suffix = index.toString(16).padStart(12, "0");
    const operationId = `deleted-create-${index}`;
    createOperations[operationId] = {
      operationId,
      profileId: "profile-1",
      workspace: null,
      sessionKey: `00000000-0000-4000-8000-${suffix}`,
      state: "deleted",
      createdAt: index,
      finishedAt: index,
    };
  }
  const activeKey = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  createOperations["active-create"] = {
    operationId: "active-create",
    profileId: "profile-1",
    workspace: null,
    sessionKey: activeKey,
    state: "active",
    createdAt: 5000,
    finishedAt: null,
  };
  const container = {
    version: 1,
    revision: 1,
    idempotencyFloorMs: 0,
    sessions: {
      [activeKey]: {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        sessionKey: activeKey,
        profileId: "profile-1",
        codexThreadId: null,
        workspace: null,
        title: null,
        status: "draft",
        createdAt: 5000,
        updatedAt: 5000,
      },
    },
    createOperations,
    bindingOperations: {},
    remoteOperations: {},
  };
  assert.equal(Object.keys(validateChatContainer(container).sessions).length, 1);
  const overflow = structuredClone(container);
  overflow.createOperations["deleted-create-overflow"] = {
    operationId: "deleted-create-overflow",
    profileId: "profile-1",
    workspace: null,
    sessionKey: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    state: "deleted",
    createdAt: 6000,
    finishedAt: 6000,
  };
  assert.throws(
    () => validateChatContainer(overflow),
    (error) => error.code === "CHAT_SESSION_STORE_CORRUPT",
  );
});

test("deleted create tombstone 窗口内满载拒绝，过窗回收且不占活动容量", () => {
  const paths = fixturePaths("shoggoth-create-tombstone-reclaim-");
  const ids = [];
  for (let index = 1; index <= 4; index += 1) {
    const digit = String(index);
    ids.push(`${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`);
    const next = String(index + 4);
    ids.push(`${next.repeat(8)}-${next.repeat(4)}-4${next.repeat(3)}-8${next.repeat(3)}-${next.repeat(12)}`);
  }
  let now = 7000;
  const store = new ChatSessionStore({
    paths,
    maxDeletedCreateOperations: 2,
    now: () => now,
    randomUUID: () => ids.shift(),
  });
  store.open();
  for (let index = 1; index <= 3; index += 1) {
    now = 7000 + index;
    const session = store.createSession({
      operationId: `create-reclaim-${index}`,
      profileId: "profile-1",
      workspace: null,
      createdAt: now,
    });
    store.requestBinding(session.sessionKey, `bind-reclaim-${index}`, now);
    store.completeBinding(session.sessionKey, `bind-reclaim-${index}`, `thread-reclaim-${index}`);
    store.requestDelete(session.sessionKey, `delete-reclaim-${index}`, now);
    if (index < 3) store.completeRemoteOperation(`delete-reclaim-${index}`);
    else {
      assert.throws(
        () => store.completeRemoteOperation(`delete-reclaim-${index}`),
        (error) => error.code === "CHAT_SESSION_CAPACITY",
      );
      now += 30 * 24 * 60 * 60 * 1000 + 1;
      store.completeRemoteOperation(`delete-reclaim-${index}`);
    }
  }
  const active = store.createSession({
    operationId: "create-reclaim-active",
    profileId: "profile-1",
    workspace: null,
    createdAt: now,
  });
  assert.equal(store.getSession(active.sessionKey).status, "draft");
  const disk = JSON.parse(fs.readFileSync(path.join(paths.stateDir, "chat-sessions.json"), "utf8"));
  assert.equal(disk.createOperations["create-reclaim-1"], undefined);
  assert.equal(disk.createOperations["create-reclaim-2"], undefined);
  assert.equal(disk.createOperations["create-reclaim-3"].state, "deleted");
  assert.equal(disk.createOperations["create-reclaim-active"].state, "active");
  store.close();
});

test("legacy Runtime session detach 幂等持久化并允许下一轮语义续接", () => {
  const paths = fixturePaths("shoggoth-runtime-session-migration-");
  const ids = [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  ];
  let now = 240;
  const store = new ChatSessionStore({ paths, now: () => now, randomUUID: () => ids.shift() });
  store.open();
  const session = store.createSession({
    operationId: "create-migrated-session",
    profileId: "profile-1",
    workspace: "/tmp/workspace",
    createdAt: now,
  });
  store.requestBinding(session.sessionKey, "bind-legacy-session", now);
  store.completeBinding(session.sessionKey, "bind-legacy-session", "legacy-thread");
  now += 1;
  store.detachRuntimeSession({
    sessionKey: session.sessionKey,
    expectedRuntimeSessionId: "legacy-thread",
  });
  assert.equal(store.getSession(session.sessionKey).codexThreadId, null);
  store.close();

  const restarted = new ChatSessionStore({ paths, now: () => now + 1 }).open();
  restarted.detachRuntimeSession({
    sessionKey: session.sessionKey,
    expectedRuntimeSessionId: "legacy-thread",
  });
  assert.equal(restarted.getSession(session.sessionKey).codexThreadId, null);
  restarted.requestBinding(session.sessionKey, "bind-semantic-continuation", now);
  restarted.completeBinding(session.sessionKey, "bind-semantic-continuation", "shared-thread");
  assert.equal(restarted.getSession(session.sessionKey).codexThreadId, "shared-thread");
  restarted.close();

  const rebound = new ChatSessionStore({ paths, now: () => now + 2 }).open();
  assert.equal(rebound.getSession(session.sessionKey).codexThreadId, "shared-thread");
  rebound.close();
});

test("Chat operation 30天边界、未来偏差与跨类别 operationId 冲突固定", () => {
  const windowMs = 30 * 24 * 60 * 60 * 1000;
  let now = windowMs + 1000;
  const paths = fixturePaths("shoggoth-operation-window-");
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
  ];
  const store = new ChatSessionStore({ paths, now: () => now, randomUUID: () => ids.shift() });
  store.open();
  assert.throws(
    () => store.createSession({
      operationId: "expired-create", profileId: "profile-1", workspace: null, createdAt: 1000,
    }),
    (error) => error.code === "OPERATION_EXPIRED",
  );
  assert.throws(
    () => store.createSession({
      operationId: "future-create", profileId: "profile-1", workspace: null,
      createdAt: now + 5 * 60 * 1000 + 1,
    }),
    (error) => error.code === "CHAT_OPERATION_TIMESTAMP_INVALID",
  );
  const session = store.createSession({
    operationId: "shared-operation", profileId: "profile-1", workspace: null,
    createdAt: now,
  });
  assert.throws(
    () => store.requestBinding(session.sessionKey, "shared-operation", now),
    (error) => error.code === "CHAT_OPERATION_ID_CONFLICT",
  );
  const binding = store.requestBinding(session.sessionKey, "binding-operation", now);
  assert.throws(
    () => store.requestBinding(session.sessionKey, "binding-operation", now + 1),
    (error) => error.code === "CHAT_OPERATION_ID_CONFLICT",
  );
  store.completeBinding(session.sessionKey, binding.operationId, "thread-operation-window");
  assert.throws(
    () => store.requestRename(session.sessionKey, "Conflict", "shared-operation", now),
    (error) => error.code === "CHAT_OPERATION_ID_CONFLICT",
  );
  const remote = store.requestRename(session.sessionKey, "Window", "remote-operation", now);
  store.completeRemoteOperation(remote.operationId);
  assert.throws(
    () => store.createSession({
      operationId: remote.operationId, profileId: "profile-1", workspace: null, createdAt: now,
    }),
    (error) => error.code === "CHAT_OPERATION_ID_CONFLICT",
  );
  assert.throws(
    () => store.requestRename(session.sessionKey, "Window", remote.operationId, now + 1),
    (error) => error.code === "CHAT_OPERATION_ID_CONFLICT",
  );
  store.close();

  const disk = JSON.parse(fs.readFileSync(path.join(paths.stateDir, "chat-sessions.json"), "utf8"));
  assert.equal(disk.idempotencyFloorMs, 1000);
  now = 0;
  const rollback = new ChatSessionStore({ paths, now: () => now });
  rollback.open();
  assert.throws(
    () => rollback.createSession({
      operationId: "expired-after-rollback", profileId: "profile-1", workspace: null, createdAt: 1000,
    }),
    (error) => error.code === "OPERATION_EXPIRED",
  );
  rollback.close();
});

test("PendingCommand 30天边界保留、容量拒绝、过窗回收及旧 replay 拒绝", async () => {
  const windowMs = 30 * 24 * 60 * 60 * 1000;
  let now = 100;
  const paths = fixturePaths("shoggoth-pending-window-boundary-");
  const inbox = new PendingCommandInbox({
    paths,
    safeStorage: fakeSafeStorage(),
    now: () => now,
    maxTombstones: 1,
  });
  await inbox.open();
  const command = (operationId) => ({
    operationId,
    runId: `run-${operationId}`,
    sessionKey: "22222222-2222-4222-8222-222222222222",
    prompt: `prompt-${operationId}`,
    createdAt: 100,
  });
  const first = command("boundary-first");
  const second = command("boundary-second");
  await inbox.enqueue(first);
  await inbox.transition(first.operationId, "canceled");
  await inbox.enqueue(second);
  now = windowMs + 100;
  await assert.rejects(
    inbox.transition(second.operationId, "canceled"),
    (error) => error.code === "PENDING_COMMAND_CAPACITY",
  );
  now += 1;
  await inbox.transition(second.operationId, "canceled");
  assert.equal(inbox.get(first.operationId), null);
  await assert.rejects(
    inbox.enqueue(first),
    (error) => error.code === "OPERATION_EXPIRED",
  );
  await assert.rejects(
    inbox.enqueue({ ...command("future-command"), createdAt: now + 5 * 60 * 1000 + 1 }),
    (error) => error.code === "PENDING_COMMAND_TIMESTAMP_INVALID",
  );
  const plaintext = readInboxPlaintext(paths);
  assert.equal(plaintext.idempotencyFloorMs, 101);
  await inbox.close();
});

test("PendingCommand 整包 safeStorage 加密、operationId 幂等并跨重启保持状态", async () => {
  const paths = fixturePaths("shoggoth-pending-command-");
  const inbox = new PendingCommandInbox({
    paths, safeStorage: fakeSafeStorage(), now: () => 401,
  });
  await inbox.open();
  const input = {
    operationId: "operation-secret-1",
    runId: "run-secret-1",
    sessionKey: "22222222-2222-4222-8222-222222222222",
    prompt: "prompt-secret-canary-1",
    createdAt: 400,
  };
  const command = await inbox.enqueue(input);
  assert.deepEqual(command, { ...input, state: "pending" });
  assert.deepEqual(await inbox.enqueue(input), command);
  await assert.rejects(
    inbox.enqueue({ ...input, prompt: "different-secret-prompt" }),
    (error) => error.code === "PENDING_COMMAND_IDEMPOTENCY_CONFLICT",
  );
  await inbox.transition(input.operationId, "dispatching");

  const filePath = path.join(paths.stateDir, "pending-commands.json");
  const disk = fs.readFileSync(filePath, "utf8");
  for (const secret of Object.values(input).filter((value) => typeof value === "string")) {
    assert.equal(disk.includes(secret), false, secret);
  }
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(disk)), ["version", "revision", "ciphertext"]);
  await inbox.close();

  const restarted = new PendingCommandInbox({
    paths, safeStorage: fakeSafeStorage(), now: () => 402,
  });
  await restarted.open();
  assert.deepEqual(restarted.get(input.operationId), { ...input, state: "dispatching" });
  assert.deepEqual(restarted.list({ state: "dispatching" }), [{ ...input, state: "dispatching" }]);
  const tombstone = await restarted.transition(input.operationId, "completed");
  assert.deepEqual(Object.keys(tombstone), [
    "operationId", "fingerprint", "state", "createdAt", "finishedAt",
  ]);
  assert.match(tombstone.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(tombstone.state, "completed");
  assert.equal(tombstone.finishedAt, 402);
  assert.deepEqual(restarted.get(input.operationId), tombstone);
  assert.deepEqual(await restarted.enqueue(input), tombstone);
  await assert.rejects(
    restarted.enqueue({ ...input, prompt: "changed-after-terminal" }),
    (error) => error.code === "PENDING_COMMAND_IDEMPOTENCY_CONFLICT",
  );
  const plaintext = readInboxPlaintext(paths);
  assert.deepEqual(Object.keys(plaintext), ["idempotencyFloorMs", "activeCommands", "tombstones"]);
  assert.deepEqual(Object.keys(plaintext.activeCommands), []);
  assert.equal(JSON.stringify(plaintext).includes(input.prompt), false);
  await restarted.close();
});

test("PendingCommand active 与 tombstone 独立有界，窗口内满载拒绝且过窗回收", async () => {
  const paths = fixturePaths("shoggoth-pending-capacity-");
  let now = 600;
  const inbox = new PendingCommandInbox({
    paths,
    safeStorage: fakeSafeStorage(),
    now: () => now,
    maxActiveCommands: 2,
    maxTombstones: 2,
  });
  await inbox.open();
  const command = (index) => ({
    operationId: `operation-${index}`,
    runId: `run-${index}`,
    sessionKey: "22222222-2222-4222-8222-222222222222",
    prompt: `prompt-capacity-${index}`,
    createdAt: 600 + index,
  });
  await inbox.enqueue(command(1));
  await inbox.enqueue(command(2));
  await assert.rejects(
    inbox.enqueue(command(3)),
    (error) => error.code === "PENDING_COMMAND_CAPACITY",
  );
  await inbox.transition("operation-1", "canceled");
  await inbox.transition("operation-2", "dispatching");
  await inbox.transition("operation-2", "completed");
  await inbox.enqueue(command(3));
  await inbox.enqueue(command(4));
  now = 700;
  await assert.rejects(
    inbox.transition("operation-3", "canceled"),
    (error) => error.code === "PENDING_COMMAND_CAPACITY",
  );
  now = 30 * 24 * 60 * 60 * 1000 + 703;
  await inbox.transition("operation-3", "canceled");
  assert.equal(inbox.get("operation-1"), null);
  assert.equal(inbox.get("operation-2"), null);
  assert.equal(inbox.get("operation-3").state, "canceled");
  assert.equal(inbox.get("operation-4").state, "pending");
  await assert.rejects(
    inbox.enqueue(command(1)),
    (error) => error.code === "OPERATION_EXPIRED",
  );
  const plaintext = readInboxPlaintext(paths);
  assert.equal(Object.keys(plaintext.activeCommands).length, 1);
  assert.equal(Object.keys(plaintext.tombstones).length, 1);
  for (const index of [1, 2, 3]) {
    assert.equal(JSON.stringify(plaintext).includes(`prompt-capacity-${index}`), false);
  }
  await inbox.close();
});

test("PendingCommand 坏文件、symlink 与 hardlink 均 fail closed 并保留证据", async () => {
  const corruptPaths = fixturePaths("shoggoth-pending-corrupt-");
  fs.mkdirSync(corruptPaths.stateDir, { recursive: true, mode: 0o700 });
  const corruptPath = path.join(corruptPaths.stateDir, "pending-commands.json");
  fs.writeFileSync(corruptPath, "{broken\n", { mode: 0o600 });
  await assert.rejects(
    new PendingCommandInbox({
      paths: corruptPaths,
      safeStorage: fakeSafeStorage(),
    }).open(),
    (error) => error.code === "PENDING_COMMAND_INBOX_CORRUPT",
  );
  assert.equal(fs.readFileSync(corruptPath, "utf8"), "{broken\n");

  for (const kind of ["symlink", "hardlink"]) {
    const paths = fixturePaths(`shoggoth-pending-${kind}-`);
    fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
    const victim = path.join(path.dirname(paths.stateDir), `victim-${kind}`);
    fs.writeFileSync(victim, "pending-command-victim", { mode: 0o600 });
    const target = path.join(paths.stateDir, "pending-commands.json");
    if (kind === "symlink") fs.symlinkSync(victim, target);
    else fs.linkSync(victim, target);
    await assert.rejects(
      new PendingCommandInbox({ paths, safeStorage: fakeSafeStorage() }).open(),
      (error) => ["UNSAFE_SYMLINK", "UNSAFE_HARDLINK"].includes(error.code),
    );
    assert.equal(fs.readFileSync(victim, "utf8"), "pending-command-victim");
  }
});

test("PendingCommand safeStorage locked 与 commit uncertain 均 poison 当前 inbox", async () => {
  const uncertainPaths = fixturePaths("shoggoth-pending-uncertain-");
  const uncertain = new PendingCommandInbox({
    paths: uncertainPaths,
    safeStorage: fakeSafeStorage(),
    now: () => 500,
    atomicWrite() {
      const error = new Error("injected uncertain commit");
      error.code = "PRIVATE_FILE_COMMIT_UNCERTAIN";
      error.committedUncertain = true;
      throw error;
    },
  });
  await uncertain.open();
  const input = {
    operationId: "operation-uncertain",
    runId: "run-uncertain",
    sessionKey: "22222222-2222-4222-8222-222222222222",
    prompt: "uncertain-prompt-canary",
    createdAt: 500,
  };
  await assert.rejects(
    uncertain.enqueue(input),
    (error) => error.code === "PENDING_COMMAND_COMMIT_UNCERTAIN"
      && error.committedUncertain === true,
  );
  assert.throws(
    () => uncertain.list(),
    (error) => error.code === "PENDING_COMMAND_COMMIT_UNCERTAIN",
  );
  await uncertain.close();

  const lockedPaths = fixturePaths("shoggoth-pending-locked-");
  const unlocked = new PendingCommandInbox({
    paths: lockedPaths, safeStorage: fakeSafeStorage(), now: () => 500,
  });
  await unlocked.open();
  await unlocked.enqueue(input);
  await unlocked.close();
  const evidencePath = path.join(lockedPaths.stateDir, "pending-commands.json");
  const encryptedEvidence = fs.readFileSync(evidencePath);
  const locked = new PendingCommandInbox({
    paths: lockedPaths,
    safeStorage: fakeSafeStorage({ isEncryptionAvailable: () => false }),
    now: () => 501,
  });
  await locked.open();
  assert.equal(locked.isLocked(), true);
  assert.throws(
    () => locked.list(),
    (error) => error.code === "pending_commands_locked"
      && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(input.prompt),
  );
  await assert.rejects(
    Promise.resolve().then(() => locked.enqueue({
      ...input, operationId: "operation-locked-new", runId: "run-locked-new",
    })),
    (error) => error.code === "pending_commands_locked",
  );
  assert.equal(fs.readFileSync(evidencePath).equals(encryptedEvidence), true);
  assert.equal(
    fs.existsSync(path.join(lockedPaths.stateDir, "pending-commands.writer.lock")),
    true,
  );
  await locked.close();
  assert.equal(fs.existsSync(path.join(lockedPaths.stateDir, "pending-commands.writer.lock")), false);

  const recovered = new PendingCommandInbox({
    paths: lockedPaths, safeStorage: fakeSafeStorage(), now: () => 502,
  });
  await recovered.open();
  assert.equal(recovered.isLocked(), false);
  assert.deepEqual(recovered.get(input.operationId), { ...input, state: "pending" });
  await recovered.close();
});

test("PendingCommand decrypt 超过启动预算但有界成功时在线解锁且只通知一次", async () => {
  const paths = fixturePaths("shoggoth-pending-late-unlock-");
  const safeStorage = fakeSafeStorage();
  const input = {
    operationId: "late-unlock-operation",
    runId: "late-unlock-run",
    sessionKey: "22222222-2222-4222-8222-222222222222",
    prompt: "late-unlock-prompt",
    createdAt: 700,
  };
  const seeded = new PendingCommandInbox({ paths, safeStorage, now: () => 700 });
  await seeded.open();
  await seeded.enqueue(input);
  await seeded.close();

  let unlocks = 0;
  const delayedCryptoBroker = {
    async encrypt(payload) {
      return safeStorage.encryptString(payload.toString("utf8"));
    },
    async decrypt(payload) {
      // 模拟 packaged selector 先异步校验 codesign，超过启动预算后才真正读取输入。
      // Inbox 必须持有独立副本，不能在 timeout 分支提前清零仍在途的 payload。
      await new Promise((resolve) => setTimeout(resolve, 40));
      return Buffer.from(safeStorage.decryptString(payload), "utf8");
    },
  };
  const inbox = new PendingCommandInbox({
    paths,
    cryptoBroker: delayedCryptoBroker,
    now: () => 701,
    decryptStartupBudgetMs: 10,
    onUnlocked() { unlocks += 1; },
  });
  await inbox.open();
  assert.equal(inbox.isLocked(), true, "Service 可先以只读 locked 状态完成启动");
  const deadline = Date.now() + 500;
  while (inbox.isLocked() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(inbox.isLocked(), false);
  assert.equal(unlocks, 1);
  assert.deepEqual(inbox.get(input.operationId), { ...input, state: "pending" });
  await inbox.close();
});

async function main() {
  let passed = 0;
  try {
    for (const { name, fn } of tests) {
      try {
        await fn();
        passed += 1;
        process.stdout.write(`PASS ${name}\n`);
      } catch (error) {
        process.stderr.write(`FAIL ${name}\n${error.stack || error}\n`);
        process.exitCode = 1;
      }
    }
  } finally {
    for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true });
  }
  process.stdout.write(`${passed}/${tests.length} tests passed\n`);
}

main();
