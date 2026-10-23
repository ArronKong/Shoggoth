"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const net = require("node:net");
const { HookStore } = require("../app/agent-service/hook-store");
const { HookProcessHost } = require("../app/agent-service/hook-process-host");
const { validateDefinition, HOOK_LIMITS } = require("../app/agent-service/hook-contract");
const { runtimeHookCapabilities } = require("../app/agent-service/runtime-hook-bridge");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createAuthorityBackup, restoreAuthorityBackup } = require("../app/agent-service/authority-backup");
const { defaultProcessIdentity, defaultProcessIsAlive } = require("../app/agent-service/private-writer-lease");
const uuid = () => crypto.randomUUID();
const sha = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sg-hook-security-"));
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  const workspace = path.join(root, "workspace"); fs.mkdirSync(workspace, { mode: 0o700 });
  let clock = Date.now();
  const store = new HookStore({ paths, now: () => clock }).open();
  const host = new HookProcessHost({ store, cacheDir: paths.hookEphemeralDir });
  t.after(async () => { await host.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const run = { id: uuid(), profileId: "profile-one", source: "chat", workspace };
  const definition = (handler, kind = "guard", event = "tool.before", extra = {}) => validateDefinition({ schemaVersion: 1,
    name: "fixture rule", event, kind, scope: { workspace: "current", sources: ["chat"] },
    matcher: { toolScopes: ["product"], toolNames: ["business_tool"] }, handler, ...extra }, workspace);
  const freeze = def => {
    const saved = store.register(run.profileId, uuid(), def);
    store.grant(run.profileId, uuid(), saved.hookId, 1); store.activate(run.profileId, uuid(), saved.hookId, 1, 1, () => {});
    return store.freeze(run, runtimeHookCapabilities("codex"), () => {});
  };
  const event = (snapshot, name = "tool.before") => ({ schemaVersion: 1, eventId: uuid(), event: name, runId: run.id,
    profileId: run.profileId, source: "chat", workspace, tool: { scope: "product", name: "business_tool" }, payload: {}, causation: { depth: 0 } });
  return { root, paths, workspace, store, host, run, definition, freeze, event, advance: ms => { clock += ms; } };
}
test("backup restore rotates authority, revokes grants and merges later unknown actions, including pre-Hooks backups", t => {
  const f = fixture(t);
  f.store.close();
  // Backups have no real credential store or provider state.
  createAuthorityBackup({ paths: f.paths, backupId: "empty-hooks" });
  fs.renameSync(f.paths.hooksDir, f.paths.hooksDir + ".fixture-held");
  createAuthorityBackup({ paths: f.paths, backupId: "before-hooks" });
  fs.renameSync(f.paths.hooksDir + ".fixture-held", f.paths.hooksDir);
  f.store.open();
  const def = f.definition({ type: "builtin", name: "workspace.copy", config: { from: "a", to: "b" } }, "action", "tool.after");
  const snapshot = f.freeze(def), incarnation = f.store.incarnation;
  f.store.close(); createAuthorityBackup({ paths: f.paths, backupId: "active-definitions" }); f.store.open();
  const { execution } = f.store.beginExecution(snapshot, snapshot.entries[0], f.event(snapshot, "tool.after"));
  f.store.settleExecution(execution, { state: "dispatched" });
  assert.throws(() => createAuthorityBackup({ paths: f.paths, backupId: "live-writer" }), { code: "BACKUP_SERVICE_ACTIVE" });
  f.store.close(); const sourceDigest = sha(f.paths.hookDatabasePath);
  for (const backupId of ["active-definitions", "empty-hooks", "before-hooks"]) {
    const restored = restoreAuthorityBackup({ paths: f.paths, backupId, destinationStateDir: path.join(f.root, "restored-" + backupId) });
    assert.equal(restored.hookRestore.noReplayReceipts, 1); assert.equal(restored.hookRestore.grantsRevoked, true);
    const restoredPaths = resolveServicePaths({ trustedRoot: f.root, stateRoot: restored.destinationStateDir });
    const store = new HookStore({ paths: restoredPaths }).open();
    try {
      assert.notEqual(store.incarnation, incarnation);
      assert.equal(store.execution(f.run.profileId, execution.id).state, "needs_verification");
      assert.equal(store.list(f.run.profileId).items.every(item => item.activeVersion === null), true);
      assert.equal(store.db.prepare("SELECT count(*) AS n FROM grants").get().n, 0);
    } finally { store.close(); }
    assert.equal(sha(f.paths.hookDatabasePath), sourceDigest);
  }
  f.store.open(); f.store.purgeProfile(f.run.profileId);
  assert.equal(f.store.execution(f.run.profileId, execution.id).state, "needs_verification");
  f.store.close(); f.store.open();
  assert.equal(f.store.execution(f.run.profileId, execution.id).state, "needs_verification");
});
test("retention preserves active or unknown receipts; only reconciled terminal history expires", t => {
  const f = fixture(t), snapshot = f.freeze(f.definition({ type: "builtin", name: "guard.block", config: { reason: "fixture" } }));
  const event = f.event(snapshot), { execution } = f.store.beginExecution(snapshot, snapshot.entries[0], event);
  f.store.settleExecution(execution, { state: "settled", output: { decision: "block" }, finishedAt: Date.now() });
  f.advance(HOOK_LIMITS.retentionMs + 1); f.store.prune();
  assert.equal(f.store.beginExecution(snapshot, snapshot.entries[0], event).fresh, false);
  f.store.markTerminal(f.run.id); f.advance(HOOK_LIMITS.retentionMs + 1); f.store.prune();
  assert.equal(f.store.snapshotForRun(f.run.id), null);
  assert.throws(() => f.store.execution(f.run.profileId, execution.id), { code: "HOOK_NOT_FOUND" });
});
test("tampered successful-test or grant metadata stops Store startup before any hook can run", t => {
  for (const table of ["tests", "grants"]) {
    const f = fixture(t), snapshot = f.freeze(f.definition({ type: "builtin", name: "guard.condition",
      config: { conditions: [{ path: "arguments.amount", op: "gt", value: 1 }], decision: "block", reason: "fixture" } }));
    const entry = snapshot.entries[0];
    f.store.recordTest(f.run.profileId, entry.hookId, 1, entry.contentDigest, true);
    f.store.db.prepare("UPDATE " + table + " SET data=json_set(data,'$.contentDigest',?)").run("a".repeat(64));
    f.store.close(); assert.throws(() => f.store.open(), { code: "HOOK_STORE_CORRUPT" });
  }
});
test("actual SQLite capacity failure rolls back registration and fences subsequent execution until reopen", t => {
  const f = fixture(t), count = f.store.db.prepare("PRAGMA page_count").get().page_count;
  f.store.db.exec("PRAGMA max_page_count=" + count);
  const definition = f.definition({ type: "script", language: "javascript",
    source: "module.exports=()=>({decision:'allow'});/*" + "x".repeat(100000) + "*/" });
  assert.throws(() => f.store.register(f.run.profileId, uuid(), definition), error => error.errcode === 13 || error.code === "SQLITE_FULL");
  assert.equal(f.store.poisoned, true); assert.equal(f.host.children.size, 0);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM hooks").get().n, 0);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM operations").get().n, 0);
  assert.throws(() => f.store.list(f.run.profileId), { code: "HOOK_UNAVAILABLE" });
  f.store.close(); f.store.open(); assert.equal(f.store.list(f.run.profileId).items.length, 0);
});
test("sandbox denies credentials, ungranted workspace reads, code replacement, network module, and cleans abort/output errors", async t => {
  const f = fixture(t); assert.equal(await f.host.verify(), true);
  const canary = path.join(f.paths.profileDir, "fixture-secret"); fs.mkdirSync(f.paths.profileDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(canary, "fixture-only-secret", { mode: 0o600 });
  fs.writeFileSync(path.join(f.workspace, "private.txt"), "workspace-canary");
  const source = "module.exports=()=>{const fs=require('node:fs');let denied=0;for(const p of " + JSON.stringify([canary, path.join(f.workspace, "private.txt")]) + "){try{fs.readFileSync(p)}catch(e){if(['EPERM','EACCES'].includes(e.code))denied++}};if(denied!==2)throw Error('leak');return {decision:'allow'}}";
  const run = async (source, extra = {}, options = {}) => {
    const def = f.definition({ type: "script", language: "javascript", source }, "guard", "tool.before", extra);
    f.store.saveSource(def); return f.host.run(def, f.event(), { workspace: f.workspace, ...options });
  };
  assert.equal((await run(source)).decision, "allow");
  await assert.rejects(run("module.exports=()=>{require('node:net');return {decision:'allow'}}"), { code: "HOOK_WORKER_FAILED" });
  const listener = net.createServer(); let connections = 0;
  listener.on("connection", socket => { connections++; socket.destroy(); });
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const port = listener.address().port, childCanary = path.join(f.root, "spawn-must-not-run");
  // Escape the language-level module allowlist deliberately: OS restrictions
  // must still deny network and fork even when real Node builtins are reached.
  const escape = "const p=require('node:fs').readFileSync.constructor('return process')();";
  const network = "module.exports=async()=>{" + escape + "const net=p.getBuiltinModule('node:net');const code=await new Promise(r=>{const s=net.connect({host:'127.0.0.1',port:" + port + "});s.on('error',e=>r(e.code));s.on('connect',()=>{s.destroy();r('CONNECTED')});p.getBuiltinModule('node:timers').setTimeout(()=>{s.destroy();r('TIMEOUT')},300)});return {decision:['EPERM','EACCES'].includes(code)?'allow':'block',reason:String(code)}}";
  assert.equal((await run(network)).decision, "allow"); assert.equal(connections, 0);
  const fork = "module.exports=()=>{" + escape + "const c=p.getBuiltinModule('node:child_process').spawnSync('/usr/bin/touch'," + JSON.stringify([childCanary]) + ");return {decision:['EPERM','EACCES'].includes(c.error?.code)?'allow':'block',reason:String(c.error?.code)}}";
  assert.equal((await run(fork)).decision, "allow"); assert.equal(fs.existsSync(childCanary), false);
  const changed = f.definition({ type: "script", language: "javascript", source: "module.exports=()=>({decision:'allow'})" });
  f.store.saveSource(changed); fs.writeFileSync(f.store.sourcePath(changed), "module.exports=()=>({decision:'block'})", { mode: 0o600 });
  await assert.rejects(f.host.run(changed, f.event()), { code: "HOOK_SOURCE_CHANGED" });
  await assert.rejects(run("module.exports=()=>({decision:'allow',reason:'x'.repeat(20000)})"), { code: "HOOK_WORKER_FAILED" });
  const abort = new AbortController();
  const pending = run("module.exports=()=>{while(true){}}", { timeoutMs: 2000 }, { signal: abort.signal });
  setTimeout(() => abort.abort(), 30); await assert.rejects(pending, { code: "HOOK_CANCELED" });
  assert.equal(f.host.children.size, 0);
  assert.equal(fs.readdirSync(f.paths.hookEphemeralDir).some(name => name.startsWith("worker-")), false);
  const unverifiedPython = new HookProcessHost({ store: f.store, cacheDir: f.paths.hookEphemeralDir, pythonExecutable: "/usr/bin/python3" });
  unverifiedPython.verified = true;
  assert.equal(unverifiedPython.available("python"), false, "an executable and a JavaScript proof do not prove Python support");
  await unverifiedPython.close();
});
test("supervisor kills its sandboxed worker when the owning Service process is killed", async t => {
  const f = fixture(t);
  const script = path.join(f.root, "parent.cjs"), moduleFile = path.join(__dirname, "../app/agent-service/hook-process-host.js");
  fs.writeFileSync(script, "const {HookProcessHost}=require(" + JSON.stringify(moduleFile) + ");const fs=require('node:fs');const host=new HookProcessHost({cacheDir:" + JSON.stringify(f.paths.hookEphemeralDir) + ",store:{paths:{},sourcePath:()=>" + JSON.stringify(path.join(f.root, "orphan.cjs")) + "}});(async()=>{await host.verify();await host.run({kind:'guard',timeoutMs:10000,handler:{type:'script',language:'javascript',source:'module.exports=()=>{while(true){}}'}},{workspace:null},{onDispatch:i=>process.stdout.write(JSON.stringify(i)+'\\n')})})().catch(()=>process.exit(2));", { mode: 0o600 });
  fs.writeFileSync(path.join(f.root, "orphan.cjs"), "module.exports=()=>{while(true){}}", { mode: 0o600 });
  const parent = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => { try { parent.kill("SIGKILL"); } catch {} });
  const info = await new Promise((resolve, reject) => {
    let buffer = ""; const timeout = setTimeout(() => reject(new Error("supervisor fixture startup timeout")), 5000);
    parent.stdout.on("data", chunk => { buffer += chunk; if (buffer.includes("\n")) { clearTimeout(timeout); resolve(JSON.parse(buffer.split("\n")[0])); } });
    parent.on("exit", () => { clearTimeout(timeout); if (!buffer.includes("\n")) reject(new Error("supervisor fixture exited early")); });
  });
  assert.equal(defaultProcessIsAlive(info.workerPid), true);
  parent.kill("SIGKILL");
  const limit = Date.now() + 2500;
  while (defaultProcessIsAlive(info.workerPid) && defaultProcessIdentity(info.workerPid) === info.workerStartIdentity) {
    if (Date.now() > limit) assert.fail("orphan supervisor or worker survived Service death");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
});
