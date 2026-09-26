#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { PluginComponentCatalog } = require("../app/agent-service/plugin-component-catalog");
const { PluginDependencyRegistry, inspectExecutable } = require("../app/agent-service/plugin-dependency-registry");
const { PluginMcpLaunchPlanner } = require("../app/agent-service/plugin-mcp-launch-planner");
const { PluginMcpClient } = require("../app/agent-service/plugin-mcp-client");
const { PluginDataScopeLeaseManager } = require("../app/agent-service/plugin-data-scope-lease");
const { spawnSync } = require("node:child_process");
const { createAuthorityBackup, restoreAuthorityBackup } = require("../app/agent-service/authority-backup");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const server = `"use strict";
const fs=require('node:fs'),path=require('node:path');
fs.writeFileSync(path.join(process.env.PLUGIN_DATA,'startup.json'),JSON.stringify({
nodeOptions:process.env.NODE_OPTIONS||null,home:process.env.HOME,path:process.env.PATH,
args:process.argv.slice(2)}));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const req=JSON.parse(line);if(req.id===undefined)return;
 const result=req.method==='initialize'?{protocolVersion:req.params.protocolVersion,capabilities:{tools:{}},
 serverInfo:{name:'fixed-dependency-fixture',version:'1'}}:req.method==='tools/list'?{tools:[]}:{};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\\n');
});`;

function fakeNative(file) {
  const bytes = Buffer.alloc(64);
  if (process.platform === "darwin") {
    bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(process.arch === "arm64" ? 0x100000c : 0x1000007, 4);
    bytes.writeUInt32LE(2, 12);
  } else {
    Buffer.from([127, 69, 76, 70, 2, 1]).copy(bytes);
    bytes.writeUInt16LE(2, 16); bytes.writeUInt16LE(process.arch === "arm64" ? 183 : 62, 18);
  }
  fs.writeFileSync(file, bytes, { mode: 0o700 });
}
async function withFixture(run, spec = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-dependency-fixture-"));
  const paths = resolveServicePaths({ stateRoot: path.join(temp, "state"), trustedRoot: temp });
  const store = new PluginStore({ paths }).open();
  const source = path.join(temp, "source"); fs.mkdirSync(source, { mode: 0o700 });
  fs.writeFileSync(path.join(source, "plugin.json"), JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "dependency-fixture", version: "1.0.0" }));
  fs.writeFileSync(path.join(source, "server.cjs"), server);
  fs.writeFileSync(path.join(source, "server.py"), "print('fixture')\n");
  fs.writeFileSync(path.join(source, "mcp.json"), JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: { local: { type: "stdio", command: "node", args: ["./server.cjs", "--fixture"], ...spec } } }));
  const installer = new PluginPackageInstaller({ store });
  const preview = installer.preview(source);
  const installed = installer.install({ sourcePath: source, previewDigest: preview.contentDigest,
    expectedRevision: 0, operationId: "install-fixture" });
  const component = new PluginComponentCatalog({ store }).list()[0].components.find(item => item.localName === "local");
  const input = { installationId: installed.installationId, componentId: component.componentId,
    releaseDigest: installed.releaseDigest, descriptorDigest: component.descriptorDigest };
  const executablePath = path.join(temp, "native-interpreter"); fakeNative(executablePath);
  const probes = [];
  const runProbe = (...args) => { probes.push(args); return { status: 0, stdout: "v22.22.3\n", stderr: "" }; };
  const registry = new PluginDependencyRegistry({ store, runProbe });
  const state = { temp, paths, store, source, input, executablePath, registry, probes, runProbe,
    setEnabled(enabled) {
      const current = store.getInstallation(input.installationId);
      return store.setInstallationDesiredState({ installationId: input.installationId,
        expectedRevision: current.revision, desiredState: enabled ? "enabled" : "disabled" });
    },
    prepare(options = {}) {
      const request = { ...input, executablePath, ...options };
      const before = registry.preview(request);
      return registry.prepare({ ...request, previewDigest: before.previewDigest,
        expectedRevision: before.expectedRevision, operationId: "prepare-fixture", confirmed: true, ...options });
    } };
  try { await run(state); }
  finally { store.close(); fs.rmSync(temp, { recursive: true, force: true }); }
}

test("preview is read only and explicit prepare registers a bounded clean version probe", async () => {
  await withFixture(({ registry, input, executablePath, probes, paths }) => {
    const before = registry.preview({ ...input, executablePath });
    assert.equal(before.probeStatus, "not-executed"); assert.equal(before.executable.version, null);
    assert.equal(before.executable.canonicalPath, fs.realpathSync(executablePath));
    assert.equal(before.executable.sha256, hash(fs.readFileSync(executablePath)));
    assert.equal(before.expectedRevision, 0); assert.equal(probes.length, 0);
    assert.equal(fs.existsSync(registry.directory), false);
    const request = { ...input, executablePath, previewDigest: before.previewDigest,
      expectedRevision: 0, operationId: "explicit" };
    assert.throws(() => registry.prepare(request), { code: "DEPENDENCY_CONFIRMATION_REQUIRED" });
    const result = registry.prepare({ ...request, confirmed: true });
    assert.equal(result.status, "ready"); assert.equal(result.expectedRevision, 1);
    assert.equal(result.executable.version, "v22.22.3"); assert.equal(probes.length, 1);
    const [command, args, options] = probes[0];
    assert.equal(command, before.executable.canonicalPath); assert.deepEqual(args, ["--version"]);
    assert.equal(options.shell, false); assert.equal(options.timeout, 2000); assert.equal(options.maxBuffer, 1024);
    assert.deepEqual(Object.keys(options.env).sort(), ["HOME", "LANG", "LC_ALL", "PATH", "TMPDIR"]);
    assert.equal(options.env.PATH, ""); assert.equal(fs.existsSync(options.cwd), false);
    assert.equal(fs.statSync(registry.file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(registry.directory).mode & 0o777, 0o700);
    assert.ok(registry.file.startsWith(`${paths.pluginDataDir}${path.sep}`));
    assert.equal(registry.queryState(input).status, "ready");
    assert.deepEqual(registry.prepare({ ...request, confirmed: true }), result);
    assert.equal(probes.length, 1, "completed operation never repeats the probe");
  });
});

test("binary content, symlink destination, owner, permissions and native format are checked", async () => {
  await withFixture(({ registry, input, executablePath, temp, prepare }) => {
    const alias = path.join(temp, "node"); fs.symlinkSync(executablePath, alias);
    const preview = registry.preview({ ...input, executablePath: alias });
    assert.equal(preview.executable.selectedPath, alias);
    prepare({ executablePath: alias });
    const other = path.join(temp, "other"); fs.copyFileSync(executablePath, other); fs.chmodSync(other, 0o700);
    fs.unlinkSync(alias); fs.symlinkSync(other, alias);
    assert.equal(registry.queryState(input).status, "changed");
    assert.throws(() => registry.prepare({ ...input, executablePath: alias, previewDigest: preview.previewDigest,
      expectedRevision: 1, operationId: "swapped", confirmed: true }), { code: "DEPENDENCY_CHANGED" });
    fs.chmodSync(other, 0o722);
    assert.throws(() => inspectExecutable(other), { code: "DEPENDENCY_EXECUTABLE_INVALID" });
    fs.chmodSync(other, 0o700); fs.writeFileSync(other, "#!/bin/sh\necho v22.22.3\n".repeat(3));
    assert.throws(() => inspectExecutable(other), { code: "DEPENDENCY_EXECUTABLE_INVALID" });
    fs.linkSync(executablePath, path.join(temp, "hardlink"));
    assert.throws(() => inspectExecutable(executablePath), { code: "DEPENDENCY_EXECUTABLE_INVALID" });
  });
});

test("only fixed in-package node/python scripts and safe interpreter arguments are accepted", async () => {
  for (const [spec, code] of [
    [{ command: "npx" }, "DEPENDENCY_INTERPRETER_UNSUPPORTED"],
    [{ command: "uv" }, "DEPENDENCY_INTERPRETER_UNSUPPORTED"],
    [{ command: "sh" }, "DEPENDENCY_INTERPRETER_UNSUPPORTED"],
    [{ args: ["-e", "process.exit()"] }, "DEPENDENCY_ARGUMENTS_UNSUPPORTED"],
    [{ command: "python3", args: ["-m", "pip"] }, "DEPENDENCY_ARGUMENTS_UNSUPPORTED"],
    [{ args: ["/tmp/unpinned.js"] }, "DEPENDENCY_ARGUMENTS_UNSUPPORTED"],
    [{ args: ["./../outside.js"] }, "DEPENDENCY_ARGUMENTS_UNSUPPORTED"],
    [{ args: ["./server.cjs", "--import=external"] }, "DEPENDENCY_ARGUMENTS_UNSUPPORTED"],
    [{ cwd: "${PLUGIN_DATA}" }, "DEPENDENCY_ARGUMENTS_UNSUPPORTED"],
    [{ env: { NODE_OPTIONS: "--require=/tmp/extra.js" } }, "DEPENDENCY_ENV_UNSUPPORTED"],
    [{ env: { PYTHONPATH: "/tmp/modules" } }, "DEPENDENCY_ENV_UNSUPPORTED"],
    [{ env: { LD_PRELOAD: "/tmp/inject.so" } }, "DEPENDENCY_ENV_UNSUPPORTED"],
  ]) {
    await withFixture(({ registry, input, executablePath, probes }) => {
      assert.throws(() => registry.preview({ ...input, executablePath }), { code });
      assert.equal(probes.length, 0);
    }, spec);
  }
});

test("revocation and CAS persist across registry reopen and invalidate captured plans", async () => {
  await withFixture(({ registry, input, executablePath, store, prepare, runProbe, probes, setEnabled }) => {
    const before = registry.preview({ ...input, executablePath });
    prepare();
    setEnabled(true);
    const planner = new PluginMcpLaunchPlanner({ store, dependencies: registry });
    const plan = planner.planStdio(input);
    assert.equal(plan.command, fs.realpathSync(executablePath));
    assert.deepEqual(plan.args.slice(0, 3), ["--no-addons", "--no-global-search-paths", "--"]);
    assert.equal(plan.env.PATH, ""); assert.equal(plan.env.HOME, "${PLUGIN_DATA}");
    assert.throws(() => registry.prepare({ ...input, executablePath, previewDigest: before.previewDigest,
      expectedRevision: 0, operationId: "active", confirmed: true }), { code: "DEPENDENCY_REQUIRES_DISABLE" });
    setEnabled(false);
    assert.throws(() => registry.prepare({ ...input, executablePath, previewDigest: before.previewDigest,
      expectedRevision: 0, operationId: "stale", confirmed: true }), { code: "REVISION_CONFLICT" });
    const revoked = registry.revoke({ ...input, expectedRevision: 1, operationId: "revoke", confirmed: true });
    assert.equal(revoked.status, "revoked"); assert.equal(revoked.expectedRevision, 2);
    setEnabled(true);
    assert.throws(() => plan.assertDependencyCurrent(), { code: "DEPENDENCY_CHANGED" });
    const reopened = new PluginDependencyRegistry({ store, runProbe });
    assert.equal(reopened.queryState(input).status, "revoked");
    assert.deepEqual(reopened.revoke({ ...input, expectedRevision: 1, operationId: "revoke", confirmed: true }), revoked);
    assert.equal(probes.length, 1);
  });
});

test("failed probes, source races, and interrupted commits never silently change a pin", async () => {
  await withFixture(({ registry, input, executablePath, store, runProbe }) => {
    const preview = registry.preview({ ...input, executablePath });
    const request = { ...input, executablePath, previewDigest: preview.previewDigest,
      expectedRevision: 0, operationId: "crash-commit", confirmed: true };
    const crashing = new PluginDependencyRegistry({ store, runProbe, onPhase(phase) {
      if (phase === "dependency-committed") throw Object.assign(new Error("crash"), { code: "PLUGIN_SIMULATED_CRASH" });
    } });
    assert.throws(() => crashing.prepare(request), { code: "PLUGIN_SIMULATED_CRASH" });
    const reopened = new PluginDependencyRegistry({ store, runProbe: () => { throw new Error("must not probe"); } });
    assert.equal(reopened.prepare(request).status, "ready");
    const next = registry.preview({ ...input, executablePath });
    const racing = new PluginDependencyRegistry({ store, runProbe() {
      fs.appendFileSync(executablePath, "changed"); return { status: 0, stdout: "v22.22.3" };
    } });
    assert.throws(() => racing.prepare({ ...request, expectedRevision: 1, previewDigest: next.previewDigest,
      operationId: "binary-race" }), { code: "DEPENDENCY_CHANGED" });
    assert.equal(registry.queryState(input).status, "changed");
  });
  await withFixture(({ input, executablePath, registry, store }) => {
    const preview = registry.preview({ ...input, executablePath });
    const bad = new PluginDependencyRegistry({ store, runProbe: () => ({ status: 0, stdout: "not node" }) });
    const request = { ...input, executablePath, previewDigest: preview.previewDigest,
      expectedRevision: 0, operationId: "bad-probe", confirmed: true };
    assert.throws(() => bad.prepare(request), { code: "DEPENDENCY_PROBE_FAILED" });
    assert.throws(() => bad.prepare(request), { code: "DEPENDENCY_OPERATION_FAILED" });
    assert.equal(registry.queryState(input).status, "missing");
  });
});

test("registry tampering and symlink storage fail closed", async () => {
  await withFixture(({ registry, input, prepare, temp }) => {
    prepare();
    const bytes = fs.readFileSync(registry.file);
    const record = JSON.parse(bytes); record.entries[Object.keys(record.entries)[0]].revision += 1;
    fs.writeFileSync(registry.file, JSON.stringify(record));
    assert.throws(() => registry.queryState(input), { code: "DEPENDENCY_REGISTRY_INVALID" });
    fs.writeFileSync(registry.file, bytes); fs.chmodSync(registry.file, 0o644);
    assert.throws(() => registry.queryState(input), { code: "UNSAFE_PERMISSIONS" });
    fs.chmodSync(registry.file, 0o600);
    const moved = path.join(temp, "moved-registry"); fs.renameSync(registry.directory, moved);
    fs.symlinkSync(moved, registry.directory);
    assert.throws(() => registry.queryState(input), { code: "UNSAFE_SYMLINK" });
  });
});

test("interrupted probing can resume unchanged, while changed content cannot resume registration", async () => {
  await withFixture(({ registry, input, executablePath, store, probes, runProbe }) => {
    const preview = registry.preview({ ...input, executablePath });
    const request = { ...input, executablePath, previewDigest: preview.previewDigest,
      expectedRevision: 0, operationId: "probe-interrupted", confirmed: true };
    const crashing = new PluginDependencyRegistry({ store, runProbe, onPhase() {
      throw Object.assign(new Error("crash"), { code: "PLUGIN_SIMULATED_CRASH" });
    } });
    assert.throws(() => crashing.prepare(request), { code: "PLUGIN_SIMULATED_CRASH" });
    assert.equal(registry.getOperation(request.operationId).phase, "probing");
    assert.equal(probes.length, 0);
    const original = fs.readFileSync(executablePath);
    fs.appendFileSync(executablePath, "changed");
    assert.throws(() => registry.prepare(request), { code: "DEPENDENCY_CHANGED" });
    assert.equal(probes.length, 0);
    fs.writeFileSync(executablePath, original);
    assert.equal(registry.prepare(request).status, "ready");
    assert.equal(registry.getOperation(request.operationId).phase, "completed");
    assert.equal(probes.length, 1);
  });
});

test("Python preparation uses isolated no-site no-bytecode flags and no module entry points", async () => {
  await withFixture(({ input, executablePath, store, setEnabled }) => {
    const calls = [];
    const registry = new PluginDependencyRegistry({ store, runProbe(...args) {
      calls.push(args); return { status: 0, stdout: "Python 3.14.6\n" };
    } });
    const preview = registry.preview({ ...input, executablePath });
    registry.prepare({ ...input, executablePath, previewDigest: preview.previewDigest,
      expectedRevision: 0, operationId: "python-fixed", confirmed: true });
    assert.deepEqual(calls[0][1], ["-I", "-S", "--version"]);
    setEnabled(true);
    const plan = new PluginMcpLaunchPlanner({ store, dependencies: registry }).planStdio(input);
    assert.deepEqual(plan.args.slice(0, 4), ["-I", "-S", "-B", "--"]);
    assert.ok(plan.args[4].endsWith("/server.py"));
  }, { command: "python3", args: ["./server.py"] });
});

test("restore rotates dependency authority and requires fresh consent instead of replaying old completed receipts", async () => {
  await withFixture(({ registry, input, executablePath, store, setEnabled }) => {
    const preview = registry.preview({ ...input, executablePath });
    const request = { ...input, executablePath, previewDigest: preview.previewDigest,
      expectedRevision: 0, operationId: "before-restore", confirmed: true };
    registry.prepare(request);
    setEnabled(true);
    const oldPlan = new PluginMcpLaunchPlanner({ store, dependencies: registry }).planStdio(input);
    const originalIncarnation = store.getAuthorityIncarnation();
    store.rotateAuthorityForRestore({ backupId: "isolated-fixture-restore" });
    assert.notEqual(store.getAuthorityIncarnation(), originalIncarnation);
    assert.equal(registry.queryState(input).status, "stale");
    assert.equal(registry.getOperation(request.operationId).phase, "outcome_unknown");
    assert.throws(() => registry.prepare(request), { code: "REVISION_CONFLICT" });
    setEnabled(true);
    assert.throws(() => oldPlan.assertDependencyCurrent(), { code: "DEPENDENCY_CHANGED" });
    assert.throws(() => new PluginMcpLaunchPlanner({ store, dependencies: registry }).planStdio(input), { code: "DEPENDENCY_CHANGED" });
    setEnabled(false);
    const fresh = registry.preview({ ...input, executablePath });
    assert.notEqual(fresh.previewDigest, preview.previewDigest);
    const replaced = registry.prepare({ ...request, operationId: "after-restore", expectedRevision: fresh.expectedRevision,
      previewDigest: fresh.previewDigest });
    assert.equal(replaced.status, "ready");
    assert.equal(replaced.authorityIncarnation, store.getAuthorityIncarnation());
    setEnabled(true);
    const freshPlan = new PluginMcpLaunchPlanner({ store, dependencies: registry }).planStdio(input);
    assert.notEqual(freshPlan.dependencyFingerprint, oldPlan.dependencyFingerprint);
    freshPlan.assertDependencyCurrent();
  });
});

test("authority backup includes the private registry and restored state invalidates its execution trust", async () => {
  await withFixture(({ registry, input, store, paths, temp, prepare }) => {
    prepare(); store.close();
    const backup = createAuthorityBackup({ paths, backupId: "dependency-backup" });
    const entry = backup.manifest.entries.find(item => item.path === "plugins/data/.prepared-dependencies/registry.json");
    assert.ok(entry); assert.equal(entry.mode, 0o600);
    assert.equal(entry.sha256, hash(fs.readFileSync(registry.file)));
    const destinationStateDir = path.join(temp, "restored-state");
    restoreAuthorityBackup({ paths, backupId: "dependency-backup", destinationStateDir });
    const restoredPaths = resolveServicePaths({ stateRoot: destinationStateDir, trustedRoot: temp });
    const restored = new PluginStore({ paths: restoredPaths }).open();
    try {
      const dependencies = new PluginDependencyRegistry({ store: restored });
      assert.equal(dependencies.queryState(input).status, "stale");
      assert.equal(dependencies.getOperation("prepare-fixture").phase, "outcome_unknown");
      assert.equal(fs.statSync(dependencies.file).mode & 0o777, 0o600);
    } finally { restored.close(); }
  });
});

test("actual local node version is fixed and starts package code with isolated interpreter flags", async () => {
  await withFixture(async ({ input, store, paths, setEnabled }) => {
    const registry = new PluginDependencyRegistry({ store });
    const executablePath = process.execPath;
    const preview = registry.preview({ ...input, executablePath });
    const receipt = registry.prepare({ ...input, executablePath, previewDigest: preview.previewDigest,
      expectedRevision: 0, operationId: "actual-node", confirmed: true });
    assert.equal(receipt.executable.version, process.version);
    setEnabled(true);
    const plan = new PluginMcpLaunchPlanner({ store, dependencies: registry }).planStdio(input);
    const scopeId = "b".repeat(64), leaseManager = new PluginDataScopeLeaseManager({ paths });
    const client = await PluginMcpClient.connectStdio({ ...plan, connectionId: "fixture-connection",
      principalIdentity: "fixture-local", authorizeEgress: () => true,
      dataScope: { leaseManager, installationId: input.installationId, scopeId }, timeoutMs: 3000 });
    try { assert.deepEqual(await client.listTools(), []); }
    finally { await client.close(); }
    const startup = JSON.parse(fs.readFileSync(path.join(paths.pluginDataDir, input.installationId, scopeId, "startup.json")));
    assert.equal(startup.nodeOptions, null); assert.equal(startup.path, "");
    assert.equal(startup.home, fs.realpathSync(path.join(paths.pluginDataDir, input.installationId, scopeId)));
    assert.deepEqual(startup.args, ["--fixture"]);
    setEnabled(false);
    registry.revoke({ ...input, expectedRevision: 1, operationId: "revoke-before-spawn", confirmed: true });
    setEnabled(true);
    await assert.rejects(PluginMcpClient.connectStdio({ ...plan, connectionId: "fixture-stale",
      principalIdentity: "fixture-local", authorizeEgress: () => true,
      dataScope: { leaseManager, installationId: input.installationId, scopeId: "c".repeat(64) }, timeoutMs: 3000 }),
    { code: "DEPENDENCY_CHANGED" });
    assert.equal(fs.existsSync(path.join(paths.pluginDataDir, input.installationId, "c".repeat(64), "startup.json")), false);
    const reclaimed = leaseManager.acquire({ installationId: input.installationId, scopeId: "c".repeat(64) });
    reclaimed.release();
  });
});

test("locally installed Python executes only the fixed package script", {
  skip: !fs.existsSync("/opt/homebrew/bin/python3") && !process.env.PLUGIN_FIXTURE_PYTHON,
}, async () => {
  await withFixture(({ input, store, setEnabled }) => {
    const registry = new PluginDependencyRegistry({ store });
    const executablePath = process.env.PLUGIN_FIXTURE_PYTHON || "/opt/homebrew/bin/python3";
    const preview = registry.preview({ ...input, executablePath });
    const registered = registry.prepare({ ...input, executablePath, previewDigest: preview.previewDigest,
      expectedRevision: 0, operationId: "real-python", confirmed: true });
    assert.match(registered.executable.version, /^Python 3\./u);
    setEnabled(true);
    const plan = new PluginMcpLaunchPlanner({ store, dependencies: registry }).planStdio(input);
    plan.assertDependencyCurrent();
    const result = spawnSync(plan.command, plan.args, { cwd: plan.pluginRoot,
      env: { PATH: "" }, timeout: 2000, maxBuffer: 1024, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.equal(result.stdout.trim(), "fixture");
  }, { command: "python3", args: ["./server.py"] });
});
