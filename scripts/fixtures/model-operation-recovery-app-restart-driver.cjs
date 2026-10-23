"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, session } = require("electron");
const root = process.env.SHOGGOTH_APP_RECOVERY_FIXTURE_ROOT;
const generation = Number(process.env.SHOGGOTH_APP_RECOVERY_GENERATION);
assert(root && path.isAbsolute(root) && fs.realpathSync(root) === root && root.startsWith("/private/tmp/sg-model-app-restart-"));
assert([0, 1].includes(generation)); assert.equal(fs.lstatSync(root).mode & 0o777, 0o700);
const snapshot = path.join(root, "source"), moduleRoot = path.join(snapshot, "app"), isolatedHome = path.join(root, "home");
assert.equal(app.getAppPath(), snapshot); assert.equal(app.isReady(), false);
const { prepareDesktopData } = require(path.join(moduleRoot, "desktop-data-bootstrap"));
const paths = prepareDesktopData(app, { userInfo: () => ({ homedir: isolatedHome }) });
assert(paths); assert.equal(app.hasSingleInstanceLock(), true); assert.equal(app.getPath("userData"), paths.userDataRoot);
assert(paths.userDataRoot.startsWith(isolatedHome + path.sep));
const identity = Object.freeze({ version: 1, backendId: "openclaw", providerKey: "isolated-app-provider", operationId: "original-full-app-restart" });
const marker = "model_recovery_requested", recoveryKey = "shoggoth.model-operation-recovery.v1", sentinelKey = "fixture.full-app.original-origin";
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const journalFile = path.join(paths.userDataRoot, "model-change-journal.json"), identityFile = path.join(paths.userDataRoot, "model-operation-recovery/identities.json");
const { createEntry, createModelChangeJournal } = require(path.join(moduleRoot, "core/model-change-journal"));
const journal = createModelChangeJournal(journalFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { generation, pid: process.pid, userData: paths.userDataRoot, sessionData: app.getPath("sessionData"),
  appPath: app.getAppPath(), electron: process.versions.electron, node: process.versions.node, completed: false, willQuit: false,
  actualUiEntryExecuted: false, naturalQuitRequested: false, modelRequests: [], modelResponses: [], forbiddenRequests: [], preloadErrors: [], rendererCrashes: [], screenshots: [], screenshotFrames: [] };
let mainWindow, first, success = false;
const timeout = setTimeout(() => { console.error("full App fixture deadline"); app.exit(2); }, 82000);
const safeFile = target => {
  const stat = fs.lstatSync(target); assert.equal(stat.isFile(), true); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.nlink, 1);
  assert.equal(stat.mode & 0o7777, 0o600);
  return { sha256: sha(fs.readFileSync(target)), bytes: stat.size, inode: stat.ino, dev: stat.dev, mode: stat.mode & 0o7777 };
};
async function waitFor(action, label, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await action(); if (value) return value; await delay(30); }
  throw new Error(`Timed out: ${label}`);
}
const js = source => mainWindow.webContents.executeJavaScript(source, true);
const nativeRead = async () => { const value = await js("window.openclawDesktop.modelOperationRecovery.read()"); assert.equal(value.ok, true, JSON.stringify(value)); return value; };
const original = snapshot => snapshot.value.operations.find(row => row.operationId === identity.operationId && row.backendId === identity.backendId && row.providerKey === identity.providerKey);
const dom = () => js(`({origin:location.origin,hash:location.hash,root:document.querySelector('#root')?.children.length,
 recovery:document.querySelector('[data-model-operation-recovery]')?.textContent||'',
 row:document.querySelector('[data-model-recovery-operation]')?.textContent||'',
 unknown:!!document.querySelector('[data-model-recovery-unknown]'),
 buttons:Array.from(document.querySelectorAll('[data-model-recovery-operation] button')).map(b=>({text:b.textContent,disabled:b.disabled})),
 terminal:document.querySelector('[data-model-recovery-terminal]')?.textContent||''})`);
async function click(text) {
  assert.equal(await js(`(()=>{const b=Array.from(document.querySelectorAll('[data-model-recovery-operation] button')).find(b=>b.textContent===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true})()`), true, `Missing enabled original button: ${text}`);
}
async function screenshot(name, expected = "original-marker") {
  const ready = value => !value.unknown && (expected === "terminal"
    ? !value.row && value.terminal.includes(identity.operationId) && value.terminal.includes("compensated")
    : value.row.includes(identity.operationId) && value.buttons.length > 0 && value.buttons.every(button => !button.disabled)
      && !value.buttons.some(button => button.text === "恢复原操作"));
  // DOM hydration can precede the displayed compositor frame. Wait for two real
  // rendering frames and preserve both DOM observations around the capture.
  const before = await waitFor(async () => {
    await js("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))");
    const value = await dom(); return ready(value) ? value : false;
  }, `painted screenshot ${name}`);
  const file = path.join(root, name);
  fs.writeFileSync(file, (await mainWindow.webContents.capturePage()).toPNG(), { mode: 0o600 });
  const after = await dom(); assert(ready(after), "The captured recovery frame must retain the asserted original state");
  report.screenshots.push(file); report.screenshotFrames.push({ name, expected, before, after });
}
app.on("browser-window-created", (_event, window) => {
  if (mainWindow) return;
  mainWindow = window;
  window.webContents.on("preload-error", (_event, file, error) => report.preloadErrors.push({ file, message: error.message }));
  window.webContents.on("render-process-gone", (_event, details) => report.rendererCrashes.push(details));
});
app.whenReady().then(() => {
  session.defaultSession.webRequest.onCompleted(details => {
    const url = new URL(details.url);
    if (url.pathname.startsWith("/__api/models")) report.modelResponses.push({ method: details.method, pathname: url.pathname,
      query: Object.fromEntries(url.searchParams), statusCode: details.statusCode });
  });
  // Observe real browser requests without changing Core/IPC/preload responses.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    try {
      const url = new URL(details.url);
      if (["http:", "https:", "ws:", "wss:"].includes(url.protocol) && url.hostname !== "127.0.0.1") {
        report.forbiddenRequests.push({ origin: url.origin, pathname: url.pathname }); return callback({ cancel: true });
      }
      if (url.pathname.startsWith("/__api/models")) {
        const request = { method: details.method, pathname: url.pathname, query: Object.fromEntries(url.searchParams) };
        report.modelRequests.push(request);
        if (details.method !== "GET") {
          assert.equal(url.pathname, "/__api/models/config/operation/recover", "Only one explicit original recovery POST is permitted");
          assert.equal(details.method, "POST"); assert.deepEqual(request.query, { backend: identity.backendId, operationId: identity.operationId, provider: identity.providerKey });
          const disk = JSON.parse(fs.readFileSync(identityFile, "utf8"));
          assert.equal(disk.operations.find(row => row.operationId === identity.operationId)?.code, marker, "Main durable marker must precede actual HTTP dispatch");
          const body = (details.uploadData || []).map(row => row.bytes ? Buffer.from(row.bytes).toString() : "").join("");
          assert(["", "{}"].includes(body), "Recovery POST contains no patch/spec/key"); request.body = body; request.durableMarkerBeforeDispatch = true;
          assert.equal(generation, 0, "A restarted Renderer must never dispatch the original recovery again");
        }
      }
      callback({ cancel: false });
    } catch (error) { report.requestFailure = error.message; callback({ cancel: true }); }
  });
});
app.on("will-quit", () => {
  report.willQuit = true; report.completed = success; clearTimeout(timeout);
  fs.writeFileSync(path.join(root, `generation-${generation}.json`), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  if (success) console.log("MODEL_OPERATION_APP_RESTART_OK");
});
async function run() {
  if (generation === 0) {
    fs.writeFileSync(path.join(paths.userDataRoot, "config.json"), JSON.stringify({ gatewayUrl: "ws://127.0.0.1:1", token: "",
      openclawPluginHostMode: "managed", hermesPluginHostMode: "existing", hermesMode: "remote", hermesRemotes: [], disabledBackends: ["hermes"],
      setupCompletedAt: 1, locale: "zh-CN", theme: "light", telemetryConsent: false, hermesKeepAlive: false,
      notifications: { chat: false, cron: false, task: false }, windowBounds: { width: 1240, height: 1020 } }), { mode: 0o600, flag: "wx" });
    await journal.withExclusiveLock("fixture:full-app-original-input", () => {
      journal.begin(createEntry({ operationId: identity.operationId, backendId: identity.backendId, providerKey: identity.providerKey,
        requestDigest: sha("synthetic-original-app-request"), previewTokenDigest: sha("synthetic-original-app-preview"), kind: "create", mode: "full", source: null,
        target: { provider: identity.providerKey, modelId: "synthetic-no-model-call" }, fingerprints: {},
        modelDiff: { before: null, after: { id: "synthetic-no-model-call", name: "Synthetic fixture journal only" } } }));
      journal.finish(identity.operationId, "partial", { operationId: identity.operationId, status: "partial", stage: "recovery" });
    });
    assert.equal(fs.existsSync(identityFile), false, "Only the production React/native flow will create safe identities");
  } else {
    first = JSON.parse(fs.readFileSync(path.join(root, "generation-0.json"), "utf8"));
    report.reopenedFile = safeFile(identityFile); assert.equal(report.reopenedFile.sha256, first.finalIdentityFile.sha256);
  }
  require(path.join(moduleRoot, "ui-entry.js"));
  report.actualUiEntryExecuted = !!require.cache[path.join(moduleRoot, "ui-entry.js")];
  assert.equal(report.actualUiEntryExecuted, true);
  await waitFor(async () => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.getURL().startsWith("http://127.0.0.1:"), "formal main window");
  await waitFor(async () => { try { return await js("document.querySelector('#root')?.children.length > 0"); } catch { return false; } }, "production React mount");
  report.origin = new URL(mainWindow.webContents.getURL()).origin;
  report.initialOriginProbe = await js(`({origin:location.origin,recoveryCache:localStorage.getItem(${JSON.stringify(recoveryKey)}),
    sentinel:localStorage.getItem(${JSON.stringify(sentinelKey)}),node:typeof require,hash:location.hash})`);
  assert(!await js("document.querySelector('[data-model-operation-recovery]')"), "Probe the fresh production origin before opening Models");
  assert.equal(report.initialOriginProbe.recoveryCache, null); assert.equal(report.initialOriginProbe.sentinel, null);
  assert.equal(report.initialOriginProbe.node, "undefined");
  if (generation === 1) assert.notEqual(report.origin, first.origin);
  report.preferences = mainWindow.webContents.getLastWebPreferences();
  // Electron's normalized getLastWebPreferences DTO omits the preload path.
  // Assert the source-configured real preload and its actual isolated bridge,
  // rather than inventing a missing runtime preference field.
  const configuredPreload = path.join(moduleRoot, "preload.js");
  assert(fs.readFileSync(path.join(moduleRoot, "ui-entry.js"), "utf8").includes('preload: path.join(__dirname, "preload.js")'));
  report.preloadSource = { path: configuredPreload, sha256: sha(fs.readFileSync(configuredPreload)), runtimePreferencesOmitPath: true };
  report.nativeBridgeProbe = await js("({bridge:typeof window.openclawDesktop?.modelOperationRecovery,methods:['read','retain','ack'].map(method=>typeof window.openclawDesktop?.modelOperationRecovery?.[method]),node:typeof require})");
  assert.deepEqual(report.nativeBridgeProbe, { bridge: "object", methods: ["function", "function", "function"], node: "undefined" });
  assert.equal(report.preferences.sandbox, true);
  assert.equal(report.preferences.contextIsolation, true); assert.equal(report.preferences.nodeIntegration, false);
  report.initialNative = await nativeRead();
  if (generation === 1) assert.deepEqual(report.initialNative.value.operations, first.finalNative.value.operations);
  await js("location.hash='#/models'");
  await waitFor(async () => { const value = await dom(); return value.row.includes(identity.operationId) && !value.unknown ? value : false; }, "original recovery row independent of catalog availability");
  report.initialModelPage = await dom();
  const hydrated = await nativeRead(), hydratedRow = original(hydrated); assert(hydratedRow);
  assert.deepEqual(Object.keys(hydratedRow).sort(), ["version", "backendId", "providerKey", "operationId", "status", ...(generation === 1 ? ["code"] : [])].sort());
  report.catalogFailure = await waitFor(() => report.modelResponses.find(row => row.method === "GET"
    && row.pathname === "/__api/models/provider-directory" && row.statusCode >= 400 && row.statusCode <= 599),
    "actual directory failure must not remove the original recovery row");
  assert((await dom()).row.includes(identity.operationId));
  if (generation === 0) {
    assert.equal(report.modelRequests.filter(row => row.method !== "GET").length, 0);
    await click("恢复原操作");
    await waitFor(async () => original(await nativeRead())?.code === marker && report.modelResponses.some(row => row.method === "POST"), "real Main marker before the only actual recovery POST");
    await waitFor(async () => { const value = await dom(); return value.buttons.every(button => !button.disabled) && !value.buttons.some(button => button.text === "恢复原操作"); }, "original request remains GET-only");
    assert.equal(report.requestFailure, undefined);
    await screenshot("full-app-generation-0-original-marker.png");
    await js(`localStorage.setItem(${JSON.stringify(sentinelKey)},'original-origin-only')`);
    await mainWindow.webContents.reload();
    await waitFor(async () => { const value = await dom(); return value.row.includes(identity.operationId) && !value.unknown; }, "same App reload retains marker and original identity");
    assert.equal((await dom()).buttons.some(button => button.text === "恢复原操作"), false);
    report.finalNative = await nativeRead(); report.finalIdentityFile = safeFile(identityFile);
    assert.equal(original(report.finalNative)?.code, marker);
    report.manualPostCount = report.modelRequests.filter(row => row.method === "POST").length; assert.equal(report.manualPostCount, 1);
  } else {
    assert.equal(hydratedRow.code, marker); assert.equal(report.initialModelPage.buttons.some(button => button.text === "恢复原操作"), false);
    await screenshot("full-app-generation-1-new-origin-original.png");
    const failedAck = await js(`window.openclawDesktop.modelOperationRecovery.ack(${JSON.stringify(identity)})`);
    assert.equal(failedAck.ok, false, "A real nonterminal journal cannot clear Main identities");
    report.nonTerminalAck = failedAck; assert.equal(original(await nativeRead())?.code, marker);
    const observedResponses = () => report.modelResponses.filter(row => row.method === "GET" && row.pathname === "/__api/models/config/operation").length;
    const beforeOriginalGet = observedResponses();
    await click("检查原操作");
    await waitFor(async () => observedResponses() > beforeOriginalGet && (await dom()).buttons.every(button => !button.disabled), "completed nonterminal original GET/native retain");
    assert.equal(original(await nativeRead())?.code, marker); assert.equal(report.requestFailure, undefined);
    const beforeTerminal = safeFile(journalFile);
    // Exact synthetic input change via the real production journal lock. Main's
    // own actual coordinator will read this on the following HTTP GET and IPC ACK.
    await journal.withExclusiveLock("fixture:finish-full-app-original", () => journal.finish(identity.operationId, "compensated", {
      operationId: identity.operationId, status: "compensated", stage: "verify-ready", code: "fixture-original-terminal" }));
    const terminalJournal = safeFile(journalFile); assert.notEqual(terminalJournal.sha256, beforeTerminal.sha256);
    await click("检查原操作");
    await waitFor(async () => { const value = await dom(); return !value.row && value.terminal.includes(identity.operationId) && value.terminal.includes("compensated"); }, "production React GET then actual Main terminal ACK");
    report.terminal = { outcome: "compensated", page: await dom(), journal: terminalJournal };
    report.finalNative = await nativeRead(); assert.equal(report.finalNative.value.operations.length, 0);
    assert.deepEqual(safeFile(journalFile), terminalJournal, "HTTP GET / Main ACK do not rewrite the true terminal journal");
    await screenshot("full-app-generation-1-terminal-ack.png", "terminal");
    report.manualPostCount = report.modelRequests.filter(row => row.method === "POST").length; assert.equal(report.manualPostCount, 0);
    const cache = JSON.parse(await js(`localStorage.getItem(${JSON.stringify(recoveryKey)})`)); assert.equal(cache.operations.length, 0);
  }
  assert.equal(report.requestFailure, undefined); assert.deepEqual(report.preloadErrors, []); assert.deepEqual(report.rendererCrashes, []);
  assert.deepEqual(report.forbiddenRequests, []); assert.equal(app.hasSingleInstanceLock(), true);
  assert.equal(fs.existsSync(paths.tokenPath), false, "No Agent Service or actual account token was created/read by this fixture");
  assert.equal(fs.existsSync(path.join(paths.stateDir, "external-plugin-host-data")), false, "No Runtime input/payload was materialized");
  report.loadedProductionModules = Object.keys(require.cache).filter(file => file.startsWith(moduleRoot + path.sep)).sort()
    .map(file => ({ path: path.relative(snapshot, file), sha256: sha(fs.readFileSync(file)) }));
  mainWindow.webContents.session.flushStorageData();
  success = true; report.naturalQuitRequested = true; app.quit();
}
run().catch(error => { console.error(error); clearTimeout(timeout); report.failure = { name: error.name, message: error.message }; app.exit(1); });
