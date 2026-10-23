#!/usr/bin/env node
"use strict";
// Full byte-identical ui-entry source snapshot, production compiled React,
// real sandboxed preload/IPC/Store, and two sequential Electron UI processes.
// Synthetic journal only: no actual Runtime, provider key, account or package.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const repo = fs.realpathSync(path.resolve(option("repo") || path.join(__dirname, "..")));
const ninePages = option("scenario") === "group-nine-pages";
const sourceDriver = path.join(repo, ninePages ? "scripts/fixtures/group-nine-page-app-driver.cjs" : "scripts/fixtures/model-operation-recovery-app-restart-driver.cjs");
const output = path.resolve(option("output") || `/private/tmp/model-operation-recovery-app-restart-${process.pid}-${Date.now()}.json`);
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const fileHash = file => sha(fs.readFileSync(file));
const json = file => JSON.parse(fs.readFileSync(file, "utf8"));
const privateDirectory = directory => fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
function inventory(directory, prefix = "") {
  const rows = [];
  for (const name of fs.readdirSync(directory).sort()) {
    const file = path.join(directory, name), rel = prefix ? `${prefix}/${name}` : name;
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false, `Source inventory may not follow a link: ${rel}`);
    if (stat.isDirectory()) rows.push(...inventory(file, rel));
    else { assert.equal(stat.isFile(), true); rows.push({ path: rel, bytes: stat.size, sha256: fileHash(file) }); }
  }
  return rows;
}
function productionInventory() {
  const app = path.join(repo, "app"), result = [];
  for (const name of fs.readdirSync(app).sort()) if (/\.(?:js|json)$/u.test(name)) {
    const file = path.join(app, name); result.push({ path: `app/${name}`, bytes: fs.statSync(file).size, sha256: fileHash(file) });
  }
  for (const directory of ["app/core", "app/cli-runtime", "app/agent-service", "app/manage-ui/src", "app/manage-ui/public", "schemas"])
    result.push(...inventory(path.join(repo, directory), directory));
  for (const file of ["package.json", "build/inspiration-sqlite-manifest.json", "app/manage-ui/index.html", "app/manage-ui/vite.config.ts", "app/manage-ui/package.json"])
    result.push({ path: file, bytes: fs.statSync(path.join(repo, file)).size, sha256: fileHash(path.join(repo, file)) });
  // The managed command path must be available in this frozen App source too.
  // Snapshot the compiled owner/reaper rather than borrowing a mutable binary.
  for (const name of ["process-owner", "manifest.json"]) {
    const file = `.vendor/workspace-execution/${name}`;
    if (fs.existsSync(path.join(repo, file))) result.push({ path: file, bytes: fs.statSync(path.join(repo, file)).size, sha256: fileHash(path.join(repo, file)) });
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
function userListeners() {
  const result = spawnSync("/usr/sbin/lsof", ["-nP", "-iTCP:18799", "-iTCP:18790", "-sTCP:LISTEN", "-Fpctn"],
    { encoding: "utf8", timeout: 3000 });
  assert([0, 1].includes(result.status));
  return { exitCode: result.status, listing: result.stdout || "" };
}
function runChild(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false, forceTimer;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM");
      forceTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 5000);
    }, options.deadline || 95000);
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => { clearTimeout(timer); clearTimeout(forceTimer); reject(error); });
    child.once("exit", (exitCode, signal) => { clearTimeout(timer); clearTimeout(forceTimer); resolve({ pid: child.pid, exitCode, signal, timedOut, stdout, stderr }); });
  });
}
async function freePort() {
  const server = net.createServer(); await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function reserve(port, optional = false) {
  const server = http.createServer((_request, response) => { response.writeHead(410); response.end("isolated origin retired"); });
  try { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); }); return server; }
  catch (error) { if (optional && error.code === "EADDRINUSE") return null; throw error; }
}
async function run() {
  assert.equal(fs.existsSync(output), false, "Append-only evidence requires a new output path");
  const available = fs.statfsSync("/private/tmp");
  assert(available.bavail * available.bsize > 512 * 1024 * 1024, "Need at least 512 MiB of actual free disk for isolated UI build");
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-model-app-restart-")); fs.chmodSync(root, 0o700);
  const snapshot = path.join(root, "source"), isolatedHome = path.join(root, "home"), evidenceDir = `${output}.artifacts`;
  privateDirectory(snapshot); privateDirectory(isolatedHome); privateDirectory(evidenceDir);
  const before = productionInventory(), driverHash = fileHash(sourceDriver), runnerHash = fileHash(__filename);
  const sharedDistBefore = inventory(path.join(repo, "app/manage-ui/dist"));
  const reused = [];
  const dependencyMetadata = [];
  let runtimeCopyBytes = 0;
  for (const [base, packages] of [[repo, ["electron", "ws", "electron-updater", "better-sqlite3", "@modelcontextprotocol/sdk"]],
    [path.join(repo, "app/manage-ui"), ["react", "react-dom", "vite", "@vitejs/plugin-react", "typescript"]]]) {
    for (const name of packages) {
      const file = path.join(base, "node_modules", name, "package.json");
      if (fs.existsSync(file)) dependencyMetadata.push({ name, path: fs.realpathSync(file), version: json(file).version, sha256: fileHash(file) });
    }
  }
  const electronExecutable = require(path.join(repo, "node_modules/electron"));
  const executables = { electron: { path: electronExecutable, sha256: fileHash(electronExecutable) },
    node: { path: process.execPath, version: process.versions.node, sha256: fileHash(process.execPath) } };
  const sourceSnapshot = before.filter(row => !row.path.startsWith("app/manage-ui/") && row.path !== "package.json");
  for (const row of sourceSnapshot) {
    const source = path.join(repo, row.path), target = path.join(snapshot, row.path);
    assert.equal(fileHash(source), row.sha256); privateDirectory(path.dirname(target));
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, row.path === ".vendor/workspace-execution/process-owner" ? 0o700 : 0o600);
    assert.equal(fileHash(target), row.sha256);
  }
  if (ninePages) {
    const relative = "scripts/fixtures/codex-app-server-fake.cjs", target = path.join(snapshot, relative);
    privateDirectory(path.dirname(target)); fs.copyFileSync(path.join(repo, relative), target, fs.constants.COPYFILE_EXCL); fs.chmodSync(target, 0o600);
    assert.equal(fileHash(target), fileHash(path.join(repo, relative)));
    const manifest = json(path.join(repo, "build/inspiration-sqlite-manifest.json"));
    const installed = json(path.join(repo, "node_modules/better-sqlite3/package.json"));
    const pinned = json(path.join(repo, "package-lock.json")).packages["node_modules/better-sqlite3"];
    const entry = manifest.architectures[process.arch];
    assert.equal(manifest.nativeApi, "Node-API"); assert.equal(installed.version, manifest.version);
    assert.equal(pinned.integrity, manifest.source.integrity);
    assert.equal(entry.packageFile, `prebuilds/darwin-${process.arch}.node`);
    const binarySource = path.join(repo, "node_modules/better-sqlite3", entry.packageFile);
    assert.equal(fileHash(binarySource), entry.binarySha256);
    const binaryTarget = path.join(snapshot, ".vendor/sqlite", process.arch, "better_sqlite3.node");
    privateDirectory(path.dirname(binaryTarget)); fs.copyFileSync(binarySource, binaryTarget, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(binaryTarget, 0o600); assert.equal(fileHash(binaryTarget), entry.binarySha256);
    runtimeCopyBytes += fs.statSync(binaryTarget).size;
    dependencyMetadata.push({ name: "sqlite-node-api", path: fs.realpathSync(binarySource), version: manifest.version,
      architecture: process.arch, sha256: entry.binarySha256, snapshot: binaryTarget });
  }
  const link = (relative, source) => { privateDirectory(path.dirname(path.join(snapshot, relative)));
    fs.symlinkSync(source, path.join(snapshot, relative)); reused.push({ path: relative, source: fs.realpathSync(source), copied: false }); };
  link("node_modules", path.join(repo, "node_modules")); link("resources", path.join(repo, "resources"));
  link("app/assets", path.join(repo, "app/assets")); link("app/manage-ui/public", path.join(repo, "app/manage-ui/public"));
  const packageFixture = { ...json(path.join(repo, "package.json")), main: "fixtures/driver.cjs" };
  if (ninePages) { assert.equal(packageFixture.scripts.start, "electron ."); assert.equal(packageFixture.scripts.prestart, undefined); assert.equal(packageFixture.scripts.poststart, undefined); }
  fs.writeFileSync(path.join(snapshot, "package.json"), `${JSON.stringify(packageFixture, null, 2)}\n`, { mode: 0o600 });
  privateDirectory(path.join(snapshot, "fixtures")); fs.copyFileSync(sourceDriver, path.join(snapshot, "fixtures/driver.cjs"));
  assert.equal(fileHash(path.join(snapshot, "fixtures/driver.cjs")), driverHash);
  const cleanEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: isolatedHome, TMPDIR: root, SHELL: "/bin/sh",
    OPENCLAW_BIN: path.join(root, "absent/openclaw"), HERMES_BIN: path.join(root, "absent/hermes"),
    OPENCLAW_HOME: path.join(isolatedHome, ".openclaw"), HERMES_HOME: path.join(isolatedHome, ".hermes"), NODE_ENV: "test" };
  const results = [], guards = [], screenshots = [], appLogs = [], initialListeners = userListeners();
  let build, builtManifest, failure, verified = false;
  try {
    build = await runChild(process.execPath, [path.join(repo, "app/manage-ui/node_modules/vite/bin/vite.js"), "build", "--configLoader", "native", "--outDir", path.join(snapshot, "app/manage-ui/dist")],
      { cwd: path.join(repo, "app/manage-ui"), env: { ...cleanEnv, NODE_ENV: "production" }, deadline: 120000 });
    fs.writeFileSync(path.join(evidenceDir, "build.log"), build.stdout + build.stderr);
    assert.equal(build.exitCode, 0, build.stderr); assert.equal(build.signal, null); assert.equal(build.timedOut, false);
    builtManifest = inventory(path.join(snapshot, "app/manage-ui/dist"));
    assert(builtManifest.some(row => row.path === "index.html"));
    // Force the production static server's existing collision fallback, without
    // touching the user's listener if they already own the preferred port.
    const preferredGuard = await reserve(18799, true); if (preferredGuard) guards.push(preferredGuard);
    for (const generation of ninePages ? [0] : [0, 1]) {
      const proxyPort = await freePort();
      const env = { ...cleanEnv, SHOGGOTH_DEV_GATEWAY_PROXY_PORT: String(proxyPort),
        SHOGGOTH_APP_RECOVERY_FIXTURE_ROOT: root, SHOGGOTH_APP_RECOVERY_GENERATION: String(generation) };
      const electron = require(path.join(repo, "node_modules/electron"));
      const result = await runChild(electron, [snapshot], { cwd: snapshot, env, deadline: 95000 });
      results.push({ generation, proxyPort, ...result });
      const log = path.join(evidenceDir, `generation-${generation}.log`); fs.writeFileSync(log, result.stdout + result.stderr); appLogs.push(log);
      const failedReportFile = path.join(root, `generation-${generation}-failed.json`);
      if (fs.existsSync(failedReportFile)) {
        const failedReport = json(failedReportFile); results[generation].failureReport = failedReport;
        for (const name of failedReport.screenshots) {
          const target = path.join(evidenceDir, path.basename(name)); fs.copyFileSync(name, target);
          screenshots.push({ path: target, sha256: fileHash(target) });
        }
      }
      assert.equal(result.signal, null, `Main ${generation} must exit naturally`); assert.equal(result.timedOut, false);
      assert.equal(result.exitCode, 0, result.stderr); assert.match(result.stdout, ninePages ? /GROUP_NINE_PAGE_APP_OK/u : /MODEL_OPERATION_APP_RESTART_OK/u);
      const report = json(path.join(root, `generation-${generation}.json`)); results[generation].report = report;
      assert.equal(report.completed, true); assert.equal(report.willQuit, true); assert.equal(report.actualUiEntryExecuted, true);
      assert.equal(report.naturalQuitRequested, true); assert.equal(report.forbiddenRequests.length, 0);
      for (const name of report.screenshots) {
        const target = path.join(evidenceDir, path.basename(name)); fs.copyFileSync(name, target); screenshots.push({ path: target, sha256: fileHash(target) });
      }
      if (generation === 0 && !ninePages) guards.push(await reserve(Number(new URL(report.origin).port)));
    }
    const [first, second] = results.map(result => result.report);
    if (ninePages) {
      assert.equal(first.serviceQuiesced, true, "Fixture Service must confirm idle quiescence before stopping");
      assert.equal(first.serviceStopped, true, "Fixture Service must stop after production App clients close");
      assert(first.pages.length >= 9); assert(first.pages.every(page => page.rendered && !page.resourceError));
      assert.equal(first.chat.sent, true); assert.equal(first.chat.received, true); assert.equal(first.chat.workRuns, 1);
      assert.equal(first.chat.userMessages, 1); assert.equal(first.chat.nativeResponses, 1); assert.equal(first.externalModelCalls, 0);
      assert.equal(fileHash(path.join(snapshot, "scripts/fixtures/codex-app-server-fake.cjs")), fileHash(path.join(repo, "scripts/fixtures/codex-app-server-fake.cjs")));
    } else {
      assert.notEqual(first.pid, second.pid); assert.equal(first.userData, second.userData); assert.equal(first.sessionData, second.sessionData);
      assert.notEqual(first.origin, second.origin); assert.equal(second.initialOriginProbe.recoveryCache, null);
      assert.equal(second.initialOriginProbe.sentinel, null); assert.equal(second.reopenedFile.sha256, first.finalIdentityFile.sha256);
      assert.deepEqual(second.initialNative.value.operations, first.finalNative.value.operations);
      assert.equal(first.manualPostCount, 1); assert.equal(second.manualPostCount, 0);
      assert.equal(second.terminal.outcome, "compensated"); assert.equal(second.finalNative.value.operations.length, 0);
    }
    assert.deepEqual(productionInventory(), before, "WT production dependencies changed during proof");
    assert.deepEqual(inventory(path.join(repo, "app/manage-ui/dist")), sharedDistBefore, "Shared dist must remain unchanged");
    assert.deepEqual(inventory(path.join(snapshot, "app/manage-ui/dist")), builtManifest);
    for (const row of sourceSnapshot) assert.equal(fileHash(path.join(snapshot, row.path)), row.sha256);
    assert.equal(fileHash(sourceDriver), driverHash); assert.equal(fileHash(__filename), runnerHash);
    verified = true;
  } catch (error) { failure = { name: error.name, message: error.message, stack: error.stack }; }
  finally { for (const server of guards.reverse()) await new Promise(resolve => server.close(resolve)); }
  const finalListeners = userListeners();
  const allSourceHashes = { before, after: productionInventory(), copied: sourceSnapshot, reused,
    runnerSha256: runnerHash, driverSha256: driverHash, dependencyMetadata, executables, fixturePackageSha256: fileHash(path.join(snapshot, "package.json")) };
  const evidence = { version: 1, verified, timestamp: new Date().toISOString(), repo, root, snapshot,
    boundary: ninePages ? "Full source-mode byte-identical ui-entry and App JS closure, production-built React, actual Service/SQLite/Backend/Registry/Proxy/REST/broker/preload; current main navigation and native Chat roundtrip; native Codex process controlled, no user state or external model/account/package acceptance" : "Full source-mode ui-entry, byte-identical App JS closure, production-built React, native preload/IPC/Store, actual journal; synthetic metadata only, no Runtime/provider/account/package acceptance",
    sharedDistUnchanged: JSON.stringify(inventory(path.join(repo, "app/manage-ui/dist"))) === JSON.stringify(sharedDistBefore),
    allSourceHashes, compiledUiManifest: builtManifest || [], buildConfiguration: { configLoader: "native", configSource: "app/manage-ui/vite.config.ts", nodeEnvironment: "production", outDir: "private snapshot only" }, build, results, screenshots, appLogs,
    currentUserAppListeners: { before: initialListeners, after: finalListeners,
      unchanged: JSON.stringify(initialListeners) === JSON.stringify(finalListeners), proves: "listener PID/endpoints only; no provider connection or user token was inspected" },
    runtimeCopyBytes, realUserDataAccess: false, realModelOrAccount: false, packaging: false,
    ...(ninePages ? { launcher: { npmStartScript: packageFixture.scripts.start, effectiveCommand: "electron .", executable: electronExecutable, lifecycleScriptsAbsent: true, fixtureWrapperDelegatesToByteIdenticalUiEntry: true } } : {}), ...(failure ? { failure } : {}) };
  fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  if (!verified) throw new Error(`Full App restart proof failed; exact isolated root and evidence retained: ${root}; ${output}`);
  fs.rmSync(root, { recursive: true, force: true });
  console.log(ninePages ? `PASS full ui-entry / current navigation / real native Chat roundtrip: natural Main exit; ${output}` : `PASS full ui-entry / React / native IPC restart: 2 natural Main exits; new origin / marker / actual journal ACK; ${output}`);
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
