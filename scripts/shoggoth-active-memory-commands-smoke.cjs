"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { createAgentService, PROTOCOL_VERSION } = require("../app/agent-service/server");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { DEFAULT_AGENT_PROFILE_ID: profileId } = require("../app/agent-service/product-store");
const { createConfigStore } = require("../app/core/config-store");
const { sha256 } = require("../app/agent-service/shoggoth-memory/migration.cjs");
const protocol = require("../app/agent-service/active-memory-command-protocol");
const { ACTIVE_MEMORY_TOGGLES_NAMESPACE: namespace } = require("../app/agent-service/shoggoth-memory/active-memory-commands.cjs");
const { STATUS_NAMESPACE } = require("../app/agent-service/shoggoth-memory/active-memory-state.cjs");
const { startInspirationFixture } = require("./fixtures/inspiration-service-fixture.cjs");

const policy = () => ({ memory: { search: { provider: "none", rememberAcrossConversations: false } },
  plugins: { entries: { "active-memory": { enabled: true, config: { agents: [profileId], mode: "always", model: "command-fixture-model" } } } } });
async function fixture(t, memoryCoreConfig = policy()) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sg-acmd-")); fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profiles"), cacheRoot: path.join(root, "cache") });
  const workspace = path.join(root, "workspace"); fs.mkdirSync(workspace);
  const f = { root, paths, workspace, acquisitions: 0, service: null, catalog: null };
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
  const runtimeManager = { async acquire() {
    f.acquisitions++;
    if (!f.catalog) throw Object.assign(new Error("fixture Runtime unavailable"), { code: "RUNTIME_NOT_INSTALLED" });
    return { capabilities: { "commands.list": true }, commandsList: async () => f.catalog };
  }, async stop() {}, async stopAll() {} };
  f.open = async () => {
    f.service = createAgentService({ paths, safeStorage, memoryCore: true, memoryCoreConfig,
      runtimeManager, prewarmMcpAuth: false, version: "active-command-fixture" });
    await f.service.start();
    require("./fixtures/literal-memory-model-control.cjs").installLiteralMemoryModelControl(f.service.memoryEngine);
    return f.service;
  };
  f.close = async () => { if (f.service) { await f.service.stop({ notify: false }); f.service = null; } };
  f.ipc = (method, params, patch) => requestService(paths, { id: crypto.randomUUID(), version: PROTOCOL_VERSION,
    token: readClientToken(paths), method, params, ...patch });
  f.createSession = () => f.service.chatSessionStore.createSession({ profileId, workspace,
    operationId: `cmd-${crypto.randomUUID()}`, createdAt: Date.now() });
  f.command = (session, text) => f.ipc(protocol.METHOD, { sessionKey: session.sessionKey, text });
  t.after(async () => { await f.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await f.open(); return f;
}
function inputFor(f, session, id) {
  return { profile: { id: profileId }, run: { id, profileId, source: "chat", sourceId: session.sessionKey,
    workspace: f.workspace }, query: "Recall the telescope lens" };
}

test("original session command persists only its own toggle and survives Service restart", async t => {
  const f = await fixture(t), session = f.createSession(), other = f.createSession();
  assert.deepEqual(await f.command(session, "/active-memory"), { text: "Active Memory: on for this session.", configUpdate: null });
  assert.match((await f.command(session, "/active-memory help")).text, /\/active-memory/u);
  assert.match((await f.command(session, "/active-memory strange")).text, /Unknown Active Memory action: strange/u);
  const owner = f.service.memoryEngine, database = owner.host(profileId).database;
  await database.openKeyedStore({ namespace: STATUS_NAMESPACE, maxEntries: 1000 }).register(sha256(session.sessionKey), { privateSummary: "should never be returned" });
  const before = await owner.activeMemoryCommands.policy(session.sessionKey);
  assert.equal(before.disabled, false);
  assert.match((await f.command(session, "/active-memory disable")).text, /off for this session/u);
  assert.throws(before.assertCurrent, { code: "MEMORY_COMMAND_STALE" });
  assert.equal(database.db.prepare("SELECT value FROM memory_state WHERE namespace=? AND key=?").get(STATUS_NAMESPACE, sha256(session.sessionKey)).value, null);
  const row = database.db.prepare("SELECT key,value FROM memory_state WHERE namespace=? AND value IS NOT NULL").get(namespace);
  assert.equal(row.key, sha256(`agent:${profileId}:webchat:${session.sessionKey}`));
  assert.equal(JSON.parse(row.value).sessionKey, `agent:${profileId}:webchat:${session.sessionKey}`);
  assert.match((await f.command(other, "/active-memory status")).text, /on for this session/u);
  assert.equal(f.acquisitions, 0, "no Runtime should be acquired by Product's command");
  await f.close(); await f.open();
  assert.match((await f.command(session, "/active-memory status")).text, /off for this session/u);
  assert.match((await f.command(session, "/active-memory enable")).text, /on for this session/u);
  assert.equal((await f.service.memoryEngine.activeMemoryCommands.policy(session.sessionKey)).disabled, false);
});

test("off cancels pending recall, waits for scratch cleanup and leaves the main WorkRun running", async t => {
  const f = await fixture(t), session = f.createSession(), owner = f.service.memoryEngine;
  let entered; const arrived = new Promise(resolve => { entered = resolve; });
  owner.complete = async ({ signal }) => { entered(); await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); };
  const input = inputFor(f, session, "command-running-recall");
  const main = f.service.workDispatcher.enqueue({ ...input.run, idempotencyKey: "command-main-fixture" });
  f.service.workDispatcher.admit(main.id); f.service.workDispatcher.transition(main.id, "running");
  const pending = owner.prepareActiveMemory(input); await arrived;
  assert.equal(owner.host(profileId).database.db.prepare("SELECT count(*) AS n FROM memory_state WHERE namespace='active-memory-runtime' AND value IS NOT NULL").get().n, 1);
  assert.match((await f.ipc("chat.command.exec", { sessionKey: session.sessionKey, text: "/active-memory off" })).text, /off/u);
  await pending;
  assert.equal(owner.takeActiveMemory(input), null);
  assert.equal(owner.activeMemory.pending.size, 0); assert.equal(owner.activeMemory.runtimes.size, 0); assert.equal(owner.activeMemory.runs.size, 0);
  assert.equal(owner.host(profileId).database.db.prepare("SELECT count(*) AS n FROM memory_state WHERE namespace='active-memory-runtime' AND value IS NOT NULL").get().n, 0);
  assert.equal(f.service.workDispatcher.getRun(main.id).status, "running");
  f.service.workDispatcher.transition(main.id, "completed");
  assert.equal(f.acquisitions, 0);
});

test("off/on rebound invalidates prepared summaries and the native cache even after returning to on", async t => {
  const f = await fixture(t), session = f.createSession(), owner = f.service.memoryEngine;
  await owner.propose({ profileId, classification: "explicit", scope: "agent", sourceRefs: ["user:memory-editor"],
    content: "The telescope uses an amber lens." });
  let calls = 0;
  owner.complete = async () => ({ text: ++calls % 2 === 1
    ? '{"tool":"memory_get","arguments":{"path":"MEMORY.md"}}'
    : '{"summary":"The telescope uses an amber lens."}' });
  const first = inputFor(f, session, "toggle-cache-before");
  await owner.prepareActiveMemory(first); assert.equal(calls, 2);
  const before = await owner.activeMemoryCommands.policy(session.sessionKey);
  await f.command(session, "/active-memory off"); await f.command(session, "/active-memory on");
  assert.throws(before.assertCurrent, { code: "MEMORY_COMMAND_STALE" });
  assert.equal(owner.takeActiveMemory(first), null);
  const next = inputFor(f, session, "toggle-cache-after");
  await owner.prepareActiveMemory(next);
  assert.match(owner.takeActiveMemory(next).content, /amber lens/u); assert.equal(calls, 4);
  await owner.finishActiveMemoryRun(next.run);
});

test("a newer toggle wins while an older command is waiting for recall cleanup", async t => {
  const f = await fixture(t), session = f.createSession(), owner = f.service.memoryEngine;
  let entered, release; const arrived = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  let calls = 0;
  owner.activeMemory.invalidateSession = async () => { if (++calls === 1) { entered(); await waiting; } };
  const stale = f.command(session, "/active-memory off"), rejected = assert.rejects(stale, { code: "MEMORY_COMMAND_STALE" });
  await arrived;
  assert.equal((await owner.activeMemoryCommands.policy(session.sessionKey)).disabled, true);
  assert.equal((await f.command(session, "/active-memory on")).text, "Active Memory: on for this session.");
  release(); await rejected;
  assert.equal((await owner.activeMemoryCommands.policy(session.sessionKey)).disabled, false);
});

test("disabled Profiles and archived chats cannot change session memory policy", async t => {
  const f = await fixture(t), session = f.createSession(), service = f.service;
  const original = service.productStore.getAgentProfile(profileId);
  service.productStore.putAgentProfile({ ...original, enabled: false });
  await assert.rejects(f.command(session, "/active-memory off"), { code: "MEMORY_COMMAND_SESSION_UNAVAILABLE" });
  service.productStore.putAgentProfile(original);
  service.chatSessionStore.requestBinding(session.sessionKey, "archive-command-binding", Date.now());
  service.chatSessionStore.completeBinding(session.sessionKey, "archive-command-binding", "archive-command-runtime");
  const operation = service.chatSessionStore.requestArchive(session.sessionKey, "archive-command-fixture", Date.now());
  service.chatSessionStore.completeRemoteOperation(operation.operationId);
  await assert.rejects(f.command(session, "/active-memory off"), { code: "MEMORY_COMMAND_SESSION_UNAVAILABLE" });
});

test("corrupt or expired toggle state cannot silently enable recall or be overwritten by a command", async t => {
  const f = await fixture(t), session = f.createSession(), owner = f.service.memoryEngine;
  await f.command(session, "/active-memory off");
  const database = owner.host(profileId).database, key = sha256(`agent:${profileId}:webchat:${session.sessionKey}`);
  const original = database.db.prepare("SELECT value FROM memory_state WHERE namespace=? AND key=?").get(namespace, key).value;
  owner.complete = async () => assert.fail("invalid toggle must not call the model");
  for (const [value, ttl] of [["{broken", null], [original, Date.now() - 1], ['{"disabled":false}', null]]) {
    database.db.prepare("UPDATE memory_state SET value=?,expires_at=? WHERE namespace=? AND key=?").run(value, ttl, namespace, key);
    await assert.rejects(f.command(session, "/active-memory on"), { code: "MEMORY_COMMAND_STATE_INVALID" });
    await assert.rejects(owner.activeMemoryCommands.policy(session.sessionKey), { code: "MEMORY_COMMAND_STATE_INVALID" });
    const input = inputFor(f, session, crypto.randomUUID());
    await owner.prepareActiveMemory(input); assert.equal(owner.takeActiveMemory(input), null);
    assert.equal(database.db.prepare("SELECT value FROM memory_state WHERE namespace=? AND key=?").get(namespace, key).value, value);
  }
  assert.deepEqual((await owner.searchMemory({ profileId, workspace: f.workspace, query: "unrelated", record: false })).results, []);
});

test("Product command remains discoverable without a Runtime and owns any colliding Runtime alias", async t => {
  const f = await fixture(t), session = f.createSession();
  const first = await f.ipc("chat.command.list", { sessionKey: session.sessionKey });
  assert.equal(first.supported, true); assert.deepEqual(first.commands.map(value => value.name), ["active-memory"]);
  assert.equal(first.commands[0].allowWhileRunning, true);
  f.catalog = { supported: true, reason: null, commands: [
    { name: "native-unsafe", description: "collision", args: null, category: "tools", aliases: ["active-memory"] },
    { name: "compact", description: "runtime command", args: null, category: "session", aliases: [], allowWhileRunning: true },
  ] };
  const commands = (await f.ipc("chat.command.list", { sessionKey: session.sessionKey })).commands;
  assert.deepEqual(commands.map(value => value.name), ["active-memory", "compact"]);
  assert.equal(commands[1].allowWhileRunning, undefined, "the host must not promise concurrent execution for Runtime commands");
});

test("authenticated IPC yields global config proposals, never writes them, and rejects direct chat bypasses", async t => {
  const f = await fixture(t, {}), session = f.createSession();
  assert.match((await f.command(session, "/active-memory status --global")).text, /off globally/u);
  const result = await f.command(session, "/active-memory --global ON");
  assert.deepEqual(result.configUpdate, { expectedRevision: 0,
    config: { plugins: { entries: { "active-memory": { enabled: true, config: { enabled: true } } } } } });
  assert.deepEqual(f.service.nativeMemoryConfig.read().config, {});
  assert.match((await f.command(session, "/active-memory status --global")).text, /off globally/u);
  await assert.rejects(f.ipc("chat.command.exec", { sessionKey: session.sessionKey, text: "/active-memory on --global" }), { code: "MEMORY_COMMAND_CONFIG_REQUIRED" });
  await assert.rejects(f.ipc(protocol.METHOD, { sessionKey: session.sessionKey, text: "/active-memory on" }, { token: "wrong-token" }));
  await assert.rejects(f.ipc(protocol.METHOD, { sessionKey: session.sessionKey, text: "/active-memory on", profileId }), { code: "MEMORY_COMMAND_INVALID" });
  await assert.rejects(f.command({ sessionKey: crypto.randomUUID() }, "/active-memory on"), { code: "MEMORY_COMMAND_SESSION_UNAVAILABLE" });
  assert.deepEqual(f.service.nativeMemoryConfig.read().config, {});
});

test("real REST applies global changes through Core, preserves other policy and never acknowledges a failed apply", async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sg-acore-"));
  const configStore = createConfigStore(path.join(root, "config.json"));
  configStore.writeNativeMemoryConfig({ expectedRevision: 0, config: policy() });
  const f = await startInspirationFixture({ agentCount: 1, configStore, serviceOptions: { memoryCore: true, prewarmMcpAuth: false } });
  t.after(async () => { await f.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const profile = f.service.productStore.getAgentProfile(profileId);
  const created = await f.backend.createSession(profile.agentId);
  const exec = async (text, origin = f.url) => {
    const response = await fetch(`${f.url}/__api/chat/slash/exec`, { method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify({ agentId: profile.agentId, sessionKey: created, text }) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await exec("/active-memory off --global", null)).status, 403);
  const off = await exec("/active-memory off --global");
  assert.equal(off.status, 200, JSON.stringify(off)); assert.equal(off.body.text, "Active Memory: off globally.");
  assert.equal(configStore.read().nativeMemory.revision, 2);
  assert.equal(configStore.read().nativeMemory.config.plugins.entries["active-memory"].config.enabled, false);
  assert.equal(configStore.read().nativeMemory.config.plugins.entries["active-memory"].config.mode, "always");
  assert.equal(configStore.read().nativeMemory.config.memory.search.provider, "none");
  assert.deepEqual(f.service.nativeMemoryConfig.read(), configStore.read().nativeMemory);
  assert.equal((await exec("/active-memory status --global")).body.text, "Active Memory: off globally.");
  const apply = f.registry.applyNativeMemoryConfig.bind(f.registry); let fail = true;
  f.registry.applyNativeMemoryConfig = async input => { const applied = await apply(input);
    if (fail) { fail = false; throw new Error("fixture lost response"); } return applied; };
  const rejected = await exec("/active-memory on --global");
  assert.notEqual(rejected.status, 200); assert.equal(rejected.body.code, "NATIVE_MEMORY_CONFIG_APPLY_FAILED");
  assert.deepEqual(f.service.nativeMemoryConfig.read(), configStore.read().nativeMemory);
  assert.equal(configStore.read().nativeMemory.revision, 4);
  assert.equal((await exec("/active-memory status --global")).body.text, "Active Memory: off globally.");
  assert.equal((await exec("/active-memory on --global")).body.text, "Active Memory: on globally.");
});

test("command response validation forbids unrelated config edits, session-to-global escalation and stale revisions", () => {
  const params = { sessionKey: crypto.randomUUID(), text: "/active-memory on --global" };
  const before = { revision: 4, config: policy() }, next = structuredClone(before.config);
  next.plugins.entries["active-memory"].config.enabled = true;
  const update = { expectedRevision: 4, config: next };
  assert.deepEqual(protocol.validateConfigUpdate(update, params, before), update);
  assert.throws(() => protocol.validateConfigUpdate(update, { ...params, text: "/active-memory on" }, before), { code: "MEMORY_COMMAND_INVALID" });
  assert.throws(() => protocol.validateConfigUpdate(update, params, { ...before, revision: 5 }), { code: "NATIVE_MEMORY_CONFIG_STALE" });
  assert.throws(() => protocol.validateConfigUpdate({ ...update, config: { ...next, memory: { search: { enabled: false } } } }, params, before), { code: "MEMORY_COMMAND_INVALID" });
  assert.throws(() => protocol.validateResult({ text: "Active Memory: on globally.", configUpdate: update }, { ...params, text: "/active-memory on" }), { code: "MEMORY_COMMAND_INVALID" });
  assert.throws(() => protocol.validateResult({ text: "Active Memory: on globally.", configUpdate: null }, params), { code: "MEMORY_COMMAND_INVALID" });
});
