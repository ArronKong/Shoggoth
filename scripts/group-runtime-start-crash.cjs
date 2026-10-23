"use strict";
// Hard-crash acceptance of the actual Host/Store/Driver boundary. The adapter is
// controlled and never imports a runtime SDK, authenticates, or calls a Provider.
// Preserve the owned databases and process receipts; a safe unresolved turn is
// not a successful business delivery.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { GroupRuntimeHost } = require("../app/group-runtime-host");
const { ExternalInspirationRunner } = require("../app/external-inspiration-runner");
const { GroupChatStore } = require("../app/agent-service/group-chat-store");
const { GroupChatDriver } = require("../app/agent-service/group-chat-driver");
const { GroupExternalExecutor } = require("../app/agent-service/group-external-executor");
const protocol = require("../app/group-runtime-host-protocol");
const POINTS = ["before-host-start", "after-adapter-accept"];
const FINAL = "Owned external result: original execution confirmed once.";
const AGENT = Object.freeze({ backendId: "hermes", agentId: "owned-helper" });
const identity = value => Object.fromEntries(["executionId", "runId", "backendId", "agentId", "sessionKey", "workspace", "mode"].map(key => [key, value[key]]));
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function write(file, value) {
  const descriptor = fs.openSync(file, "w", 0o600);
  try { fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}
function read(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function append(root, event) {
  const descriptor = fs.openSync(path.join(root, "events.jsonl"), "a", 0o600);
  try { fs.writeSync(descriptor, `${JSON.stringify({ pid: process.pid, ...event })}\n`); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}
function events(root) {
  const file = path.join(root, "events.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
}
function owned(root) {
  assert.ok(root.startsWith("/private/tmp/group-runtime-start-crash-"));
  const stat = fs.lstatSync(root);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0);
  assert.equal(fs.realpathSync(root), root);
}
function hostRow(host, executionId) { return JSON.parse(host.db.prepare("SELECT data FROM executions WHERE id=?").get(executionId).data); }
async function runtime(root, point, phase) {
  owned(root);
  let clock = 10_000;
  const workspace = path.join(root, "workspace"); fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const store = new GroupChatStore({ paths: { stateDir: path.join(root, "group"), trustedRoot: root }, now: () => clock }).open();
  const registry = { getBackend: () => ({ getAgent: async () => ({ id: AGENT.agentId, name: "Owned helper" }) }) };
  const adapter = {
    async prepare(input) { append(root, { type: "adapter.prepare", phase, sessionId: input.sessionId });
      return { sessionKey: input.sessionKey ?? `agent:${AGENT.agentId}:${input.sessionId}`, workspace: input.workspace ?? workspace, mode: "gateway" }; },
    async start(input) {
      append(root, { type: "adapter.accept", phase, identity: identity(input) });
      if (phase === "crash" && point === "after-adapter-accept") crash();
      return { status: "running" };
    },
    async inspect(input) {
      append(root, { type: "adapter.inspect", phase, identity: identity(input) });
      if (fs.existsSync(path.join(root, "terminal.json"))) {
        assert.deepEqual(read(path.join(root, "terminal.json")).identity, identity(input));
        return { status: "completed", resultSummary: FINAL };
      }
      return { status: "unknown", errorCode: "EXTERNAL_INSPECT_UNAVAILABLE" };
    },
    async fullResult() { return fs.existsSync(path.join(root, "terminal.json")) ? FINAL : null; },
    async cancel() { throw new Error("fixture must not cancel unresolved execution"); },
    reset() {},
  };
  const runner = new ExternalInspirationRunner({ registry, adapters: { hermes: adapter }, adapterOptions: { sessionPurpose: "group" }, now: () => clock });
  const host = new GroupRuntimeHost({ paths: { stateDir: path.join(root, "host"), trustedRoot: root }, registry,
    agent: AGENT, ownerToken: "o".repeat(43), runtimeToken: "r".repeat(43), runner, now: () => clock }).open();
  // Synthetic device identity prevents this fixture from inventorying the real machine.
  host.db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES('deviceIdentity',?)").run(hash("owned-crash-fixture-device"));
  let groupId = fs.existsSync(path.join(root, "setup.json")) ? read(path.join(root, "setup.json")).groupId : null;
  const timers = [];
  const setTimer = (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; };
  const clearTimer = timer => { if (timer) timer.cleared = true; };
  function crash() {
    const opportunity = store.runningOpportunities().find(value => value.groupId === groupId);
    assert.ok(opportunity?.external, "Store execution identity must be committed before external start");
    const persistedHost = hostRow(host, opportunity.external.executionId);
    const checkpoint = { phase, point, pid: process.pid, groupId, opportunity, hostId: host.hostId, persistedHost,
      adapterAccepts: events(root).filter(event => event.type === "adapter.accept").length };
    assert.equal(events(root).filter(event => event.type === "bridge.response" && event.method === "group.external.start").length, 0,
      "SIGKILL must precede the Service receiving its start response");
    if (point === "before-host-start") {
      assert.equal(persistedHost.dispatchPossible, false); assert.equal(persistedHost.startFingerprint, undefined);
      assert.equal(checkpoint.adapterAccepts, 0);
    } else {
      assert.equal(persistedHost.dispatchPossible, true); assert.ok(persistedHost.startFingerprint);
      assert.equal(checkpoint.adapterAccepts, 1);
    }
    write(path.join(root, "checkpoint.json"), checkpoint);
    append(root, { type: "kill.request", point, signal: "SIGKILL" });
    process.stdout.write(`CHECKPOINT ${point} pid=${process.pid}\n`);
    process.kill(process.pid, "SIGKILL");
    throw new Error("owned SIGKILL did not terminate process");
  }
  const client = { async request(method, params) {
    append(root, { type: "bridge.request", phase, method, executionId: params.executionId, runId: params.runId, sessionKey: params.sessionKey });
    if (phase === "crash" && point === "before-host-start" && method === "group.external.start") crash();
    let actualMethod = method, actualParams = params;
    if (method === "group.external.prepare") {
      const { context, ...execution } = params;
      actualMethod = "host.prepare"; actualParams = { execution, kind: context.kind, taskId: context.taskId };
    }
    const value = await host.dispatch({ version: protocol.VERSION, id: crypto.randomUUID(), hostId: host.hostId,
      authority: { groupId, ownerId: store.getRemoteOwnerId(), epoch: store.getDriverFence() }, method: actualMethod, params: actualParams });
    append(root, { type: "bridge.response", phase, method, status: value.snapshot?.status ?? null });
    return value;
  } };
  const errors = [];
  let driver;
  const external = new GroupExternalExecutor({ store, getClient: () => client, now: () => clock, pollMs: 10,
    setTimer, clearTimer, unconfirmedTimeoutMs: 90_000,
    onTerminal: (id, outcome) => driver.onExternalTerminal(id, outcome), onError: error => errors.push(error.code ?? error.message) });
  const native = { async ensureSession() { throw new Error("native session forbidden"); }, async start() { throw new Error("native start forbidden"); } };
  driver = new GroupChatDriver({ store, executor: native, externalExecutor: external, setTimer, clearTimer,
    onError: error => errors.push(error.code ?? error.message) });
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
  async function tick() {
    for (const timer of timers.filter(value => !value.cleared && value.ms === 10)) { timer.cleared = true; timer.fn(); }
    await settle();
  }
  return { store, host, driver, errors, settle, tick, advance(ms) { clock += ms; },
    setGroup(value) { groupId = value; },
    async close() { driver.stop(); await host.close(); store.close(); append(root, { type: "clean.close", phase }); } };
}
async function child(root, point, phase) {
  const f = await runtime(root, point, phase);
  if (phase === "crash") {
    const { groupId } = f.store.createGroup({ operationId: "owned-crash-group", name: "Owned crash fixture", purpose: "",
      members: [{ backendId: "hermes", agentId: "unselected-peer", profileId: null, displayName: "Unselected coordinator" },
        { ...AGENT, profileId: null, displayName: "Owned helper" }] });
    f.setGroup(groupId); write(path.join(root, "setup.json"), { groupId, point });
    await f.driver.start();
    const member = f.store.getGroup(groupId).members.find(value => value.agentId === AGENT.agentId);
    f.store.appendUserMessage({ groupId, clientMessageId: "original-user-input", body: "Original owned external request", mentionMemberIds: [member.id] });
    f.driver.wake(groupId); await f.settle();
    throw new Error(`crash point not reached: ${JSON.stringify(f.errors)}`);
  }
  const saved = read(path.join(root, "checkpoint.json"));
  try {
    assert.notEqual(process.pid, saved.pid);
    assert.equal(f.host.hostId, saved.hostId);
    assert.equal(f.store.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(f.host.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    await f.driver.start(); await f.tick();
    f.advance(91_000); await f.tick(); await f.tick();
    const current = f.store.getOpportunity(saved.opportunity.id);
    assert.deepEqual(identity(current.external), identity(saved.opportunity.external));
    assert.equal(current.runId, saved.opportunity.runId); assert.equal(current.sessionKey, saved.opportunity.sessionKey);
    assert.ok(["running", "waiting"].includes(current.state));
    assert.equal(current.recovery?.reason, "GROUP_EXTERNAL_START_UNCONFIRMED");
    assert.equal(f.store.claimNext(saved.groupId, f.store.getDriverFence()), null, "unresolved original execution retains its slot");
    assert.throws(() => f.store.retryMember({ groupId: saved.groupId, memberId: current.memberId, operationId: `${phase}-retry` }),
      { code: "GROUP_CHAT_NOTHING_TO_RETRY" });
    const durable = hostRow(f.host, current.external.executionId);
    assert.equal(durable.dispatchPossible, point === "after-adapter-accept");
    assert.equal(f.host.db.prepare("SELECT COUNT(*) AS count FROM executions").get().count, 1);
    const log = events(root);
    assert.equal(log.filter(event => event.type === "adapter.accept").length, saved.adapterAccepts);
    assert.equal(log.filter(event => event.type === "bridge.request" && event.method === "group.external.start").length, 1);
    assert.equal(log.filter(event => event.type === "adapter.prepare").length, 1, "recovery cannot mint a substitute session");
    for (const event of log.filter(event => event.type === "adapter.inspect")) assert.deepEqual(event.identity, identity(current.external));
    const publicAnswers = () => f.store.listMessages({ groupId: saved.groupId, limit: 100 }).messages.filter(value => value.author.kind === "member");
    assert.equal(publicAnswers().length, 0);
    let delivered = false;
    if (phase === "recover-2" && point === "after-adapter-accept") {
      write(path.join(root, "terminal.json"), { identity: identity(current.external), status: "completed", text: FINAL });
      await f.tick(); await f.tick();
      assert.equal(f.store.getOpportunity(current.id).state, "replied");
      assert.deepEqual(publicAnswers().map(value => value.body), [FINAL]);
      assert.equal(events(root).filter(event => event.type === "adapter.accept").length, 1);
      delivered = true;
    }
    assert.deepEqual(f.errors, []);
    write(path.join(root, `${phase}.json`), { passed: true, point, phase, pid: process.pid, originalPid: saved.pid,
      hostId: f.host.hostId, identity: identity(current.external), opportunityId: current.id,
      stateBeforeOptionalTerminal: current.state, recovery: current.recovery, hostDispatchPossible: durable.dispatchPossible,
      actualControlledAdapterAccepts: saved.adapterAccepts, extraAdapterStarts: 0, extraSessionPrepares: 0,
      businessDelivered: delivered, acceptanceClassification: point === "before-host-start"
        ? "host-prepared-only-start-not-received; conservative-unconfirmed-occupancy"
        : "adapter-accepted-start-receipt-lost; reconcile-original-only" });
  } finally { await f.close(); }
}
async function launch(root, point, phase) {
  const argv = [__filename, "--child", root, point, phase];
  return new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: root, TMPDIR: "/private/tmp", LANG: "en_US.UTF-8" } });
    let stdout = "", stderr = "", exit = null, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; processChild.kill("SIGKILL"); }, 20_000);
    processChild.stdout.on("data", bytes => { stdout += bytes; }); processChild.stderr.on("data", bytes => { stderr += bytes; });
    processChild.once("error", error => { clearTimeout(timer); reject(error); });
    processChild.once("exit", (code, signal) => { exit = { code, signal }; });
    processChild.once("close", (code, signal) => {
      clearTimeout(timer);
      const value = { phase, point, pid: processChild.pid, argv, timedOut, exit, close: { code, signal }, stdout, stderr };
      write(path.join(root, `${phase}-process.json`), value); resolve(value);
    });
  });
}
async function main() {
  const reportDir = path.resolve(process.argv[2] || path.join(".artifacts", "group-runtime-start-crash"));
  fs.mkdirSync(reportDir, { recursive: true });
  const reports = [], runId = `${Date.now()}-${process.pid}`;
  const reportFile = path.join(reportDir, `external-start-crash-${runId}.json`);
  try {
    for (const point of POINTS) {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "group-runtime-start-crash-"))); fs.chmodSync(root, 0o700);
      const report = { point, root, passed: false, processes: [] }; reports.push(report);
      for (const phase of ["crash", "recover-1", "recover-2"]) {
        const processResult = await launch(root, point, phase); report.processes.push(processResult);
        assert.equal(processResult.timedOut, false, processResult.stderr);
        assert.deepEqual(processResult.close, phase === "crash" ? { code: null, signal: "SIGKILL" } : { code: 0, signal: null }, processResult.stderr);
        assert.deepEqual(processResult.exit, processResult.close);
      }
      report.recoveries = [read(path.join(root, "recover-1.json")), read(path.join(root, "recover-2.json"))];
      report.rawFiles = fs.readdirSync(root).filter(name => /\.(json|jsonl)$/u.test(name)).map(name => ({
        path: path.join(root, name), sha256: hash(fs.readFileSync(path.join(root, name))) }));
      report.passed = true; process.stdout.write(`PASS external-start SIGKILL/${point}\n`);
    }
  } finally {
    write(reportFile, { passed: reports.length === POINTS.length && reports.every(value => value.passed),
      realModelCalls: 0, realProviderCalls: 0, sdkExecutions: 0, personalConfigReads: 0, productionServiceStarts: 0,
      transport: "real Host.dispatch + real Store/Driver/ExternalExecutor/Runner with controlled adapter",
      fixtureMode: "independent; execution-boundary contract only, not collaborative model acceptance",
      boundary: "Prepared-only start remains safely unresolved; accepted execution is never replayed; optional confirmed terminal is same-run evidence.",
      reports });
    process.stdout.write(`REPORT ${reportFile}\n`);
  }
}
if (process.argv[2] === "--child") child(process.argv[3], process.argv[4], process.argv[5]).catch(error => { console.error(error); process.exitCode = 1; });
else main().catch(error => { console.error(error); process.exitCode = 1; });
