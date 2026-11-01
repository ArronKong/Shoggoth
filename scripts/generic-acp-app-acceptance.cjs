#!/usr/bin/env node
"use strict";
// Generic ACP full App acceptance: frozen source + real React/Service/Backend/Helper,
// two sequential Electron processes and a signed controlled ACP executable.
// No provider, user account, installed App, or manufacturer certification.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const repo = fs.realpathSync(path.resolve(option("repo") || path.join(__dirname, "..")));
const connectorPages = false;
const ninePages = true;
const sourceDriver = path.join(repo, "scripts/fixtures/generic-acp-app-driver.cjs");
const output = path.resolve(option("output") || `/private/tmp/generic-acp-app-${process.pid}-${Date.now()}.json`);
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
  for (const directory of ["app/core", "app/cli-runtime", "app/agent-service", "app/manage-ui/src", "app/manage-ui/public", "schemas", "resources"])
    result.push(...inventory(path.join(repo, directory), directory));
  for (const file of ["package.json", "build/inspiration-sqlite-manifest.json", "app/manage-ui/index.html", "app/manage-ui/vite.config.ts", "app/manage-ui/package.json"])
    result.push({ path: file, bytes: fs.statSync(path.join(repo, file)).size, sha256: fileHash(path.join(repo, file)) });
  // The managed command path must be available in this frozen App source too.
  // Snapshot the compiled owner/reaper rather than borrowing a mutable binary.
  for (const name of ["process-owner", "manifest.json"]) {
    const file = `.vendor/workspace-execution/${name}`;
    if (fs.existsSync(path.join(repo, file))) result.push({ path: file, bytes: fs.statSync(path.join(repo, file)).size, sha256: fileHash(path.join(repo, file)) });
  }
  for (const name of ["shoggoth-secret-media", "manifest.json"]) {
    const file = `.vendor/local-media/${name}`;
    result.push({ path: file, bytes: fs.statSync(path.join(repo, file)).size, sha256: fileHash(path.join(repo, file)) });
  }
  if (connectorPages) result.push(...inventory(path.join(repo, ".vendor/open-connector", `darwin-${process.arch}`), `.vendor/open-connector/darwin-${process.arch}`));
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
function userListeners() {
  const result = spawnSync("/usr/sbin/lsof", ["-nP", "-iTCP:18799", "-iTCP:18790", "-iTCP:18792", "-sTCP:LISTEN", "-Fpctn"],
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
async function observeFailedOwnedChildren(root) {
  const auditFile = path.join(root, "acp-worker-audit.jsonl");
  if (!fs.existsSync(auditFile)) return { ownedChildren: [], allExited: true, signals: [] };
  const rows = fs.readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const workers = [...new Set(rows.filter(row => row.kind === "started").map(row => row.pid))];
  const pids = [...new Set(rows.flatMap(row => row.kind === "started" ? [row.pid] : row.kind === "helper-started" ? [row.helperPid] : []))];
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
  const signals = [];
  for (const signal of [null, "SIGTERM", "SIGKILL"]) {
    if (signal) for (const worker of workers) {
      const owned = pids.filter(pid => alive(pid)).map(pid => {
        const seen = spawnSync("/bin/ps", ["-p", String(pid), "-o", "pgid=", "-o", "command="], { encoding: "utf8", timeout: 3000 });
        if (seen.status !== 0) return null;
        const line = seen.stdout.trim(), group = Number(/^\s*(\d+)/u.exec(line)?.[1]);
        const expected = line.includes(path.join(root, "source/scripts/fixtures/generic-acp-app-worker.cjs"))
          || line.includes(path.join(root, "source/scripts/fixtures/generic-acp-app-helper.cjs"));
        return expected && group === worker ? { pid, group } : null;
      }).filter(Boolean);
      if (!owned.length) continue;
      try { process.kill(-worker, signal); signals.push({ workerGroup: worker, signal, verifiedPrivateChildren: owned.map(row => row.pid) }); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    const deadline = Date.now() + (signal === null ? 1500 : 4000);
    while (Date.now() < deadline) { if (pids.every(pid => !alive(pid))) return { ownedChildren: pids, allExited: true, signals }; await new Promise(resolve => setTimeout(resolve, 30)); }
  }
  return { ownedChildren: pids, allExited: pids.every(pid => !alive(pid)), signals };
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
  const fixtureHashes = Object.fromEntries(["generic-acp-app-worker.cjs", "generic-acp-app-helper.cjs"].map(name => [name, fileHash(path.join(repo, "scripts/fixtures", name))]));
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
    if (process.platform === "darwin" && row.bytes > 16 * 1024 * 1024) {
      assert.equal(fs.existsSync(target), false);
      const copied = spawnSync("/bin/cp", ["-c", source, target], { encoding: "utf8", timeout: 30000 });
      assert.equal(copied.status, 0, copied.stderr);
    } else fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(target, row.path === ".vendor/workspace-execution/process-owner" || row.path === ".vendor/local-media/shoggoth-secret-media" || row.path.endsWith("/connector-runtime") ? 0o700 : 0o600);
    assert.equal(fileHash(target), row.sha256);
  }
  if (ninePages) {
    for (const relative of ["scripts/fixtures/generic-acp-app-worker.cjs", "scripts/fixtures/generic-acp-app-helper.cjs"]) {
      const target = path.join(snapshot, relative);
      privateDirectory(path.dirname(target)); fs.copyFileSync(path.join(repo, relative), target, fs.constants.COPYFILE_EXCL); fs.chmodSync(target, 0o600);
      assert.equal(fileHash(target), fileHash(path.join(repo, relative)));
    }
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
  link("node_modules", path.join(repo, "node_modules"));
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
  let build, builtManifest, failure, failureCleanup, verified = false;
  try {
    build = await runChild(process.execPath, [path.join(repo, "app/manage-ui/node_modules/vite/bin/vite.js"), "build", "--configLoader", "native", "--outDir", path.join(snapshot, "app/manage-ui/dist")],
      { cwd: path.join(repo, "app/manage-ui"), env: { ...cleanEnv, NODE_ENV: "production" }, deadline: 120000 });
    fs.writeFileSync(path.join(evidenceDir, "build.log"), build.stdout + build.stderr);
    assert.equal(build.exitCode, 0, build.stderr); assert.equal(build.signal, null); assert.equal(build.timedOut, false);
    builtManifest = inventory(path.join(snapshot, "app/manage-ui/dist"));
    assert(builtManifest.some(row => row.path === "index.html"));
    if (process.platform === "darwin") for (const row of builtManifest.filter(item => item.bytes > 32768)) {
      const reference = path.join(repo, "app/manage-ui/dist", row.path), target = path.join(snapshot, "app/manage-ui/dist", row.path);
      if (!fs.existsSync(reference) || fileHash(reference) !== row.sha256) continue;
      const temporary = target + ".cow-copy"; assert.equal(fs.existsSync(temporary), false);
      const cloned = spawnSync("/bin/cp", ["-c", reference, temporary], { encoding: "utf8", timeout: 30000 });
      assert.equal(cloned.status, 0, cloned.stderr); assert.equal(fileHash(temporary), row.sha256);
      fs.renameSync(temporary, target);
      assert.notEqual(fs.statSync(target).ino, fs.statSync(reference).ino, "CoW keeps an independent build inode");
    }
    // Force the production static server's existing collision fallback, without
    // touching the user's listener if they already own the preferred port.
    const preferredGuard = await reserve(18799, true); if (preferredGuard) guards.push(preferredGuard);
    for (const generation of [0, 1]) {
      const proxyPort = await freePort();
      const env = { ...cleanEnv, SHOGGOTH_DEV_GATEWAY_PROXY_PORT: String(proxyPort),
        SHOGGOTH_APP_RECOVERY_FIXTURE_ROOT: root, SHOGGOTH_APP_RECOVERY_GENERATION: String(generation), SHOGGOTH_ACP_FIXTURE_NODE: process.execPath,
        ...(connectorPages ? { SHOGGOTH_CONNECTOR_APP_ACCEPTANCE: "1" } : {}) };
      const electron = require(path.join(repo, "node_modules/electron"));
      const result = await runChild(electron, [snapshot], { cwd: snapshot, env, deadline: 150000 });
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
      assert.equal(result.exitCode, 0, result.stderr); assert.match(result.stdout, /GENERIC_ACP_APP_OK/u);
      const report = json(path.join(root, `generation-${generation}.json`)); results[generation].report = report;
      assert.equal(report.completed, true); assert.equal(report.willQuit, true); assert.equal(report.actualUiEntryExecuted, true);
      assert.equal(report.naturalQuitRequested, true); assert.equal(report.forbiddenRequests.length, 0);
      for (const name of report.screenshots) {
        const target = path.join(evidenceDir, path.basename(name)); fs.copyFileSync(name, target); screenshots.push({ path: target, sha256: fileHash(target) });
      }
      if (generation === 0 && !ninePages) guards.push(await reserve(Number(new URL(report.origin).port)));
    }
    const [first, second] = results.map(result => result.report);
    assert.notEqual(first.pid, second.pid); assert.equal(first.userData, second.userData);
    for (const report of [first, second]) {
      assert.equal(report.serviceQuiesced, true); assert.equal(report.serviceStopped, true);
      assert.equal(report.childrenClosed, true); assert.equal(report.externalModelCalls, 0);
      assert.equal(report.genericAcp, true); assert.equal(report.rendererCrashes.length, 0);
      assert.equal(report.chat.sent, true); assert.equal(report.chat.received, true);
    }
    assert.equal(first.approval.actualReactClick, true); assert.equal(first.mcp.actualHelperCall, true);
    assert.equal(first.cron.completed, true); assert.equal(first.kanban.completed, true);
    assert.equal(first.twoAgentIsolation, true); assert.equal(first.rendererRefreshRetained, true);
    assert.equal(first.cancel.actualReactClick, true); assert.equal(first.cancel.lateApprovalRejected, true);
    assert.equal(first.crashUnknown.remoteAccepted, false); assert.equal(first.crashUnknown.duplicatePromptCount, 0);
    assert.equal(second.restartRetained, true); assert.equal(second.historyReplayedPrompts, 0);
    assert.equal(first.secretUi.buttonHidden, true); assert.equal(second.secretUi.buttonHidden, true);
    assert.equal(first.secretUi.inputPrepared, true); assert.equal(first.secretUi.localResultRead, true);
    assert.equal(first.secretUi.executionCount, 1); assert.equal(second.secretUi.revoked, true);
    assert.deepEqual(first.disclosureUi, { actualReactObserved: true, originalProviderCalls: 1, protectedProviderCalls: 1,
      revokedProviderCalls: 0, originalOptionVisible: false, plaintextAbsent: true });
    assert.equal(second.secretUi.unrelatedResultRetained, true); assert.equal(second.secretUi.replayedPrompts, 0);
    assert.equal(second.chat.runtimeSessionId, first.chat.runtimeSessionId);
    assert.equal(fileHash(path.join(snapshot, "scripts/fixtures/generic-acp-app-worker.cjs")), fileHash(path.join(repo, "scripts/fixtures/generic-acp-app-worker.cjs")));
    assert.deepEqual(productionInventory(), before, "WT production dependencies changed during proof");
    assert.deepEqual(inventory(path.join(repo, "app/manage-ui/dist")), sharedDistBefore, "Shared dist must remain unchanged");
    assert.deepEqual(inventory(path.join(snapshot, "app/manage-ui/dist")), builtManifest);
    for (const row of sourceSnapshot) assert.equal(fileHash(path.join(snapshot, row.path)), row.sha256);
    assert.equal(fileHash(sourceDriver), driverHash); assert.equal(fileHash(__filename), runnerHash);
    for (const [name, expected] of Object.entries(fixtureHashes)) { assert.equal(fileHash(path.join(repo, "scripts/fixtures", name)), expected); assert.equal(fileHash(path.join(snapshot, "scripts/fixtures", name)), expected); }
    verified = true;
  } catch (error) { failure = { name: error.name, message: error.message, stack: error.stack };
    try { failureCleanup = await observeFailedOwnedChildren(root); } catch (cleanupError) { failureCleanup = { allExited: false, error: cleanupError.stack }; }
  }
  finally { for (const server of guards.reverse()) await new Promise(resolve => server.close(resolve)); }
  const auditSource = path.join(root, "acp-worker-audit.jsonl");
  let acpAudit;
  if (fs.existsSync(auditSource)) {
    const target = path.join(evidenceDir, "acp-worker-audit.jsonl"); fs.copyFileSync(auditSource, target);
    acpAudit = { path: target, sha256: fileHash(target), rows: fs.readFileSync(target, "utf8").trim().split("\n").filter(Boolean).length };
  }
  const finalListeners = userListeners();
  const allSourceHashes = { before, after: productionInventory(), copied: sourceSnapshot, reused,
    runnerSha256: runnerHash, driverSha256: driverHash, fixtureHashes, dependencyMetadata, executables, fixturePackageSha256: fileHash(path.join(snapshot, "package.json")) };
  const evidence = { version: 1, verified, timestamp: new Date().toISOString(), repo, root, snapshot,
    boundary: "Frozen full ui-entry source and production-built React; actual Service/SQLite/Backend/Registry/Proxy/REST/broker/preload/Helper; signed controlled Generic ACP process, no real provider/account/package or manufacturer acceptance",
    sharedDistUnchanged: JSON.stringify(inventory(path.join(repo, "app/manage-ui/dist"))) === JSON.stringify(sharedDistBefore),
    allSourceHashes, acpAudit, compiledUiManifest: builtManifest || [], buildConfiguration: { configLoader: "native", configSource: "app/manage-ui/vite.config.ts", nodeEnvironment: "production", outDir: "private snapshot only" }, build, results, screenshots, appLogs,
    currentUserAppListeners: { before: initialListeners, after: finalListeners,
      unchanged: JSON.stringify(initialListeners) === JSON.stringify(finalListeners), proves: "listener PID/endpoints only; no provider connection or user token was inspected" },
    runtimeCopyBytes, realUserDataAccess: false, realModelOrAccount: false, packaging: false,
    ...(ninePages ? { launcher: { npmStartScript: packageFixture.scripts.start, effectiveCommand: "electron .", executable: electronExecutable, lifecycleScriptsAbsent: true, fixtureWrapperDelegatesToByteIdenticalUiEntry: true } } : {}), ...(failure ? { failure, failureCleanup } : {}) };
  fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  if (!verified) throw new Error(`Full App restart proof failed; exact isolated root and evidence retained: ${root}; ${output}`);
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`PASS Generic ACP full App / React approval / Helper MCP / Chat-Cron-Kanban / 2 Agent isolation / refresh-restart / 2 natural Main exits; ${output}`);
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
