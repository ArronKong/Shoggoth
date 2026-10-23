#!/usr/bin/env electron
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = option("fixture-root"), moduleRoot = option("module-root"), generation = Number(option("generation"));
assert(root && path.isAbsolute(root) && fs.realpathSync(root) === root && root.startsWith("/private/tmp/sg-model-recovery-restart-"));
assert(moduleRoot && path.isAbsolute(moduleRoot));
assert([0, 1].includes(generation));
assert.equal(fs.lstatSync(root).mode & 0o777, 0o700);
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const userData = path.join(root, "user-data"), sessionData = path.join(root, "sessions");
for (const directory of [userData, sessionData, path.join(root, "logs"), path.join(root, "crashes")])
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
app.setName("Shoggoth isolated model recovery restart fixture");
app.setPath("userData", userData); app.setPath("sessionData", sessionData);
app.setPath("logs", path.join(root, "logs")); app.setPath("crashDumps", path.join(root, "crashes"));
assert.equal(app.requestSingleInstanceLock(), true, "Main must hold the actual App singleton for this private userData");
app.on("window-all-closed", () => {});
const timeout = setTimeout(() => { console.error("model recovery restart driver deadline"); app.exit(2); }, 45_000);
const { ModelOperationRecoveryStore } = require(path.join(moduleRoot, "model-operation-recovery-store"));
const { registerDesktopModelOperationRecoveryIpc } = require(path.join(moduleRoot, "desktop-model-operation-recovery-ipc"));
const { ModelChangeCoordinator } = require(path.join(moduleRoot, "core/model-change-coordinator"));
const { createEntry, createModelChangeJournal } = require(path.join(moduleRoot, "core/model-change-journal"));
const identity = Object.freeze({ version: 1, backendId: "openclaw", providerKey: "isolated-provider", operationId: "original-model-recovery-restart" });
const retainedRow = Object.freeze({ ...identity, status: "partial", code: "model_recovery_requested" });
const storageKey = "fixture:model-operation-recovery:old-origin";
const backendCalls = [];
const forbidden = method => { backendCalls.push(method); throw new Error(`Unexpected backend/model access: ${method}`); };
const registry = { _activeGet() { return forbidden("backend"); }, listModelsSnapshot() { return forbidden("catalog"); } };
const journalFile = path.join(userData, "model-change-journal.json");
const journal = createModelChangeJournal(journalFile);
const coordinator = new ModelChangeCoordinator({ registry, journal, tokenSecret: Buffer.alloc(32, 19) });
const store = new ModelOperationRecoveryStore({ userDataRoot: userData, coordinator });
const retainedFile = path.join(userData, "model-operation-recovery/identities.json");
const fileEvidence = target => {
  const stat = fs.lstatSync(target);
  assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.isFile(), true);
  assert.equal(stat.mode & 0o7777, 0o600); assert.equal(stat.nlink, 1);
  if (typeof process.getuid === "function") assert.equal(stat.uid, process.getuid());
  return { sha256: sha(fs.readFileSync(target)), inode: stat.ino, dev: stat.dev, size: stat.size,
    mode: stat.mode & 0o7777, mtimeMs: stat.mtimeMs };
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(action, name) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) { const value = await action(); if (value) return value; await delay(20); }
  throw new Error(`Timed out: ${name}`);
}
function page() {
  return `<!doctype html><meta charset="utf-8"><title>Isolated model recovery restart</title>
<h1>Model operation recovery fixture</h1><p id="status">Production preload/IPC only</p>
<script>
globalThis.fixtureProbe = () => ({origin:location.origin,node:typeof require,process:typeof process,
 bridge:typeof globalThis.openclawDesktop?.modelOperationRecovery,
 length:localStorage.length,oldIdentity:localStorage.getItem(${JSON.stringify(storageKey)})});
globalThis.fixtureCall = (method,input) => method==='read'
 ? globalThis.openclawDesktop.modelOperationRecovery.read()
 : globalThis.openclawDesktop.modelOperationRecovery[method](input);
</script>`;
}
async function listen(previousOrigin) {
  // If the OS immediately reuses the old port, close it and choose another.
  for (let attempts = 0; attempts < 8; attempts++) {
    const server = http.createServer((request, response) => {
      assert(["/", "/child", "/wrong", "/favicon.ico"].includes(request.url));
      const html = page(); response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(html);
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (origin !== previousOrigin) return { server, origin };
    await new Promise(resolve => server.close(resolve));
  }
  throw new Error("unable to allocate a different loopback origin");
}
const call = (frame, method, value) => frame.executeJavaScript(
  `globalThis.fixtureCall(${JSON.stringify(method)}${method === "read" ? "" : `,${JSON.stringify(value)}`})`);
const ok = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value.value; };
const denied = (value, code) => { assert.deepEqual(value, { ok: false, error: { code, message: "无法核实模型操作记录，请重新读取。" } }); return value; };

app.whenReady().then(async () => {
  let mainWindow, extraWindow, ipc, ui;
  const preloadErrors = [], renderCrashes = [], report = { generation, pid: process.pid, userData, sessionData,
    electron: process.versions.electron, node: process.versions.node, completed: false, backendCalls };
  try {
    const first = generation === 1 ? JSON.parse(fs.readFileSync(path.join(root, "generation-0.json"), "utf8")) : null;
    if (generation === 0) {
      assert.equal(fs.existsSync(journalFile), false);
      await journal.withExclusiveLock("fixture:seed-original", () => {
        journal.begin(createEntry({ operationId: identity.operationId, backendId: identity.backendId, providerKey: identity.providerKey,
          requestDigest: sha("isolated-original-request"), previewTokenDigest: sha("isolated-original-preview"), kind: "create", mode: "full",
          source: null, target: { provider: identity.providerKey, modelId: "synthetic-no-execution" },
          fingerprints: {}, modelDiff: { before: null, after: { id: "synthetic-no-execution", name: "Synthetic journal-only model" } } }));
        journal.finish(identity.operationId, "partial", { operationId: identity.operationId, status: "partial", stage: "verify-ready" });
      });
    } else assert.equal(coordinator.observeOperation(identity.backendId, { operationId: identity.operationId, providerKey: identity.providerKey }).status, "partial");
    const journalBefore = fileEvidence(journalFile);
    await store.open();
    assert.equal(fs.lstatSync(path.dirname(retainedFile)).mode & 0o7777, 0o700);
    const configListener = event => { event.returnValue = { gatewayUrl: "", token: "", locale: "", effectiveLocale: "" }; };
    ipcMain.on("openclaw:get-config", configListener); // Production preload's config dependency, no user config access.
    ui = await listen(first?.origin); report.origin = ui.origin;
    ipc = registerDesktopModelOperationRecoveryIpc({ ipcMain, getMainWindow: () => mainWindow,
      getUiOrigin: () => ui.origin, async getStore() { return store; } });
    function newWindow(subFrames) {
      const window = new BrowserWindow({ show: false, width: 760, height: 620,
        webPreferences: { preload: path.join(moduleRoot, "preload.js"), contextIsolation: true,
          nodeIntegration: false, sandbox: true, nodeIntegrationInSubFrames: subFrames,
          partition: "persist:model-recovery-restart-fixture" } });
      window.webContents.on("preload-error", (_event, file, error) => preloadErrors.push({ file, message: error.message }));
      window.webContents.on("render-process-gone", (_event, details) => renderCrashes.push(details));
      return window;
    }
    // The three production sandbox settings remain strict. This fixture-only
    // sub-frame preload flag lets an actual child exercise senderFrame denial.
    mainWindow = newWindow(true); await mainWindow.loadURL(`${ui.origin}/#/models`);
    const prefs = mainWindow.webContents.getLastWebPreferences();
    report.webPreferences = Object.fromEntries(["contextIsolation", "nodeIntegration", "sandbox", "nodeIntegrationInSubFrames"].map(key => [key, prefs[key]]));
    assert.deepEqual(report.webPreferences, { contextIsolation: true, nodeIntegration: false, sandbox: true, nodeIntegrationInSubFrames: true });
    const probe = await mainWindow.webContents.executeJavaScript("fixtureProbe()");
    assert.equal(probe.node, "undefined"); assert.equal(probe.process, "undefined"); assert.equal(probe.bridge, "object");
    const initial = await call(mainWindow.webContents, "read"); ok(initial);
    if (generation === 0) {
      assert.deepEqual(initial.value.operations, []);
      ok(await call(mainWindow.webContents, "retain", { ...identity, status: "unconfirmed" }));
      const marked = await call(mainWindow.webContents, "retain", retainedRow); ok(marked);
      const noMarker = await call(mainWindow.webContents, "retain", { ...identity, status: "partial" });
      assert.deepEqual(noMarker, marked, "retaining without code cannot erase the durable recovery request");
      report.retained = marked; report.retainedFile = fileEvidence(retainedFile);
      await mainWindow.webContents.executeJavaScript(`localStorage.setItem(${JSON.stringify(storageKey)},${JSON.stringify(identity.operationId)});`);
      report.oldOriginStorage = await mainWindow.webContents.executeJavaScript("fixtureProbe()");
      assert.equal(report.oldOriginStorage.oldIdentity, identity.operationId);

      extraWindow = newWindow(false); await extraWindow.loadURL(`${ui.origin}/#/models`);
      report.otherWindow = [];
      for (const method of ["read", "retain", "ack"])
        report.otherWindow.push({ method, response: denied(await call(extraWindow.webContents, method, method === "retain" ? retainedRow : identity), "MODEL_RECOVERY_CALLER_REQUIRED") });
      extraWindow.close(); extraWindow = null;
      await mainWindow.webContents.executeJavaScript("const child=document.createElement('iframe');child.id='child';child.src='/#/child';document.body.appendChild(child);");
      const child = await waitFor(async () => {
        const frame = mainWindow.webContents.mainFrame.frames.find(value => value.url === `${ui.origin}/#/child`);
        return frame && await frame.executeJavaScript("typeof fixtureCall==='function' && typeof openclawDesktop?.modelOperationRecovery==='object'") ? frame : null;
      }, "actual child frame and production preload");
      assert.notEqual(child, mainWindow.webContents.mainFrame);
      report.subFrame = { url: child.url, probe: await child.executeJavaScript("fixtureProbe()"), responses: [] };
      assert.equal(report.subFrame.probe.node, "undefined"); assert.equal(report.subFrame.probe.process, "undefined");
      for (const method of ["read", "retain", "ack"])
        report.subFrame.responses.push({ method, response: denied(await call(child, method, method === "retain" ? retainedRow : identity), "MODEL_RECOVERY_CALLER_REQUIRED") });
      await mainWindow.webContents.executeJavaScript("document.querySelector('#child').remove()");
      await mainWindow.loadURL(`${ui.origin}/wrong`);
      report.wrongPath = denied(await call(mainWindow.webContents, "read"), "MODEL_RECOVERY_CALLER_REQUIRED");
      await mainWindow.loadURL(`${ui.origin}/#/models`);
      report.invalidRequest = denied(await call(mainWindow.webContents, "retain", { ...retainedRow, spec: {} }), "MODEL_RECOVERY_INVALID_REQUEST");
      assert.deepEqual((await call(mainWindow.webContents, "read")).value, { version: 1, revision: marked.value.revision, operations: [retainedRow] });
      assert.deepEqual(fileEvidence(retainedFile), report.retainedFile);
      assert.deepEqual(fileEvidence(journalFile), journalBefore, "Renderer IPC never changes the model journal");
      mainWindow.webContents.session.flushStorageData();
    } else {
      report.newOriginStorage = probe;
      assert.equal(probe.length, 0); assert.equal(probe.oldIdentity, null); assert.notEqual(probe.origin, first.origin);
      report.reopened = initial; report.reopenedFile = fileEvidence(retainedFile);
      assert.deepEqual(initial.value.operations, [retainedRow]); assert.equal(initial.value.revision, first.retained.value.revision);
      assert.equal(report.reopenedFile.sha256, first.retainedFile.sha256);
      report.nonTerminal = { response: denied(await call(mainWindow.webContents, "ack", identity), "MODEL_RECOVERY_STORE_UNAVAILABLE") };
      report.nonTerminal.after = (await call(mainWindow.webContents, "read")).value;
      assert.deepEqual(report.nonTerminal.after, initial.value);
      report.foreignIdentities = [];
      for (const foreign of [{ ...identity, backendId: "hermes" }, { ...identity, providerKey: "foreign-provider" }, { ...identity, operationId: "missing-original" }])
        report.foreignIdentities.push(denied(await call(mainWindow.webContents, "ack", foreign), "MODEL_RECOVERY_STORE_UNAVAILABLE"));
      assert.deepEqual(fileEvidence(retainedFile), report.reopenedFile);
      assert.deepEqual(fileEvidence(journalFile), journalBefore);
      // Explicit journal-only terminal injection under the real production
      // exclusive lock; no backend, model apply, recovery or credentials.
      await journal.withExclusiveLock("fixture:finish-original", () => journal.finish(identity.operationId, "compensated", {
        operationId: identity.operationId, status: "compensated", stage: "verify-ready", code: "fixture-terminal" }));
      report.observedTerminal = coordinator.observeOperation(identity.backendId, { operationId: identity.operationId, providerKey: identity.providerKey });
      assert.equal(report.observedTerminal.terminal, true); assert.equal(report.observedTerminal.status, "compensated");
      const terminalFile = fileEvidence(journalFile);
      report.ack = await call(mainWindow.webContents, "ack", identity); ok(report.ack);
      assert.deepEqual(report.ack.value, { ...identity, revision: initial.value.revision + 1, status: "acknowledged", outcome: "compensated" });
      const acknowledgedFile = fileEvidence(retainedFile);
      report.ackAgain = await call(mainWindow.webContents, "ack", identity); assert.deepEqual(report.ackAgain, report.ack);
      assert.deepEqual(fileEvidence(retainedFile), acknowledgedFile, "repeat ack must not rewrite the identity file");
      report.finalRead = await call(mainWindow.webContents, "read"); ok(report.finalRead);
      assert.deepEqual(report.finalRead.value, { version: 1, revision: initial.value.revision + 1, operations: [] });
      assert.deepEqual(fileEvidence(journalFile), terminalFile, "ack/read do not mutate the true terminal journal");
      report.acknowledgedFile = acknowledgedFile;
    }
    assert.deepEqual(backendCalls, []); assert.equal(coordinator.isReady(), false);
    assert.deepEqual(preloadErrors, []); assert.deepEqual(renderCrashes, []);
    report.preloadErrors = preloadErrors; report.renderCrashes = renderCrashes; report.coordinatorReady = coordinator.isReady();
    ipcMain.removeListener("openclaw:get-config", configListener);
    report.completed = true;
    fs.writeFileSync(path.join(root, `generation-${generation}.json`), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } finally {
    ipc?.dispose(); await store.close();
    for (const window of [extraWindow, mainWindow]) if (window && !window.isDestroyed()) window.close();
    if (ui?.server.listening) await new Promise(resolve => ui.server.close(resolve));
    clearTimeout(timeout); app.releaseSingleInstanceLock();
  }
}).then(() => { console.log("MODEL_OPERATION_RECOVERY_RESTART_PROCESS_OK"); app.quit(); })
  .catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
