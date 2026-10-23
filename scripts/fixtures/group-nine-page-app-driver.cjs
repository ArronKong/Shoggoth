"use strict";
// Driver for the existing byte-identical ui-entry snapshot runner's optional
// group-nine-pages scenario. Production Service/Backend/Registry/Proxy/REST/UI;
// only native Codex executable and encryption are isolated fixtures.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const net = require("node:net");
const { app, BrowserWindow, session } = require("electron");
const root = process.env.SHOGGOTH_APP_RECOVERY_FIXTURE_ROOT, snapshot = path.join(root, "source"), moduleRoot = path.join(snapshot, "app"), isolatedHome = path.join(root, "home");
assert(root.startsWith("/private/tmp/sg-model-app-restart-") && fs.realpathSync(root) === root); assert.equal(app.getAppPath(), snapshot);
assert.equal(app.isReady(), false); assert.equal(fs.statSync(root).mode & 0o777, 0o700);
const originalUserInfo = os.userInfo.bind(os); os.userInfo = (...args) => ({ ...originalUserInfo(...args), homedir: isolatedHome });
const { prepareDesktopData } = require(path.join(moduleRoot, "desktop-data-bootstrap"));
const paths = prepareDesktopData(app, { userInfo: () => ({ homedir: isolatedHome }) });
assert(paths.userDataRoot.startsWith(isolatedHome + path.sep));
const { CodexRuntimePool } = require(path.join(moduleRoot, "agent-service/codex-runtime-pool"));
const { CodexRuntimeHost } = require(path.join(moduleRoot, "agent-service/codex-runtime-host"));
const { prepareCodexRuntimeAccountHome } = require(path.join(moduleRoot, "agent-service/codex-runtime-paths"));
const { createAgentService } = require(path.join(moduleRoot, "agent-service/server"));
const { readClientToken, requestService } = require(path.join(moduleRoot, "agent-service/client"));
const { SERVICE_PROTOCOL_VERSION } = require(path.join(moduleRoot, "agent-service/service-protocol-version"));
const { DEFAULT_AGENT_PROFILE_ID } = require(path.join(moduleRoot, "agent-service/product-store"));
const report = { completed: false, willQuit: false, actualUiEntryExecuted: false, naturalQuitRequested: false,
  pid: process.pid, userData: paths.userDataRoot, sessionData: app.getPath("sessionData"), pages: [], screenshots: [],
  forbiddenRequests: [], rendererErrors: [], rendererCrashes: [], preloadErrors: [], requests: [], externalModelCalls: 0,
  boundary: "byte-identical full ui-entry, actual production Service/SQLite/Backend/Registry/Proxy/REST/chat broker/preload/React; native model executable and encryption controlled; no physical human input or external model" };
let mainWindow, service, success = false, serviceStopping = false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeout = 20000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await read(); if (value) return value; await pause(30); } throw Error(label); }
const js = code => mainWindow.webContents.executeJavaScript(code, true);
const checkpoint = phase => {
  report.phase = phase;
  fs.writeFileSync(path.join(root, "navigation-checkpoint.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
};
const deadline = setTimeout(() => {
  checkpoint("deadline: " + report.phase);
  report.failure = "nine-page App deadline";
  report.window = mainWindow && !mainWindow.isDestroyed() ? { url: mainWindow.webContents.getURL(),
    loading: mainWindow.webContents.isLoading(), destroyed: mainWindow.webContents.isDestroyed() } : null;
  fs.writeFileSync(path.join(root, "generation-0-failed.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  console.error("nine-page App deadline", report.stage, report.window); app.exit(2);
}, 82000);
app.on("browser-window-created", (_event, window) => {
  if (mainWindow) return; mainWindow = window;
  // A private acceptance window can be occluded by another local test. Keep
  // requestAnimationFrame advancing for the real page/capture assertions.
  window.webContents.setBackgroundThrottling(false);
  report.backgroundThrottling = window.webContents.getBackgroundThrottling();
  window.webContents.on("preload-error", (_event, file, error) => report.preloadErrors.push({ file, message: error.message }));
  window.webContents.on("render-process-gone", (_event, details) => report.rendererCrashes.push(details));
  window.webContents.on("console-message", (_event, level, message) => { if (level === 3) report.rendererErrors.push(message); });
});
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    if (["http:", "https:", "ws:", "wss:"].includes(url.protocol) && url.hostname !== "127.0.0.1") {
      report.forbiddenRequests.push({ origin: url.origin, pathname: url.pathname }); return callback({ cancel: true });
    }
    callback({ cancel: false });
  });
  session.defaultSession.webRequest.onCompleted(details => {
    const url = new URL(details.url); if (url.pathname.startsWith("/__api/")) report.requests.push({ method: details.method, pathname: url.pathname, statusCode: details.statusCode });
  });
});
app.on("will-quit", event => {
  if (!report.serviceStopped) {
    event.preventDefault();
    if (serviceStopping) return;
    serviceStopping = true;
    // Let the production quit handler close its Renderer, Registry and HTTP
    // server before stopping this fixture-owned Service. Otherwise UI requests
    // race the Service's bounded drain and can fail an already completed proof.
    void (async () => {
      const port = Number(new URL(report.origin).port);
      await until(() => new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => { socket.destroy(); resolve(false); });
        socket.once("error", error => { socket.destroy(); error.code === "ECONNREFUSED" ? resolve(true) : reject(error); });
        socket.setTimeout(1000, () => { socket.destroy(); reject(Error("fixture App close probe timed out")); });
      }), "production App server closed before fixture Service");
      const rpc = (method, params = {}) => requestService(paths, {
        token: readClientToken(paths), version: SERVICE_PROTOCOL_VERSION, method, params,
      }, { timeoutMs: 5000 });
      const status = await rpc("service.status"); assert.equal(status.pid, process.pid);
      await until(async () => {
        const impact = await rpc("service.stopImpact"); assert.equal(impact.totalCount, 0);
        try {
          const fence = await rpc("service.quiesceIdle", { instanceNonce: status.instanceNonce, revision: impact.revision });
          assert.equal(fence.quiesced, true); assert.equal(fence.instanceNonce, status.instanceNonce);
          report.serviceQuiesced = true; return true;
        } catch (error) { if (error.code === "SERVICE_MAINTENANCE_BUSY") return false; throw error; }
      }, "fixture Service requests drained and idle quiescence confirmed");
      await service.stop(); report.serviceStopped = true; app.quit();
    })().catch(error => {
      report.failure = error.stack; console.error(error); clearTimeout(deadline);
      fs.writeFileSync(path.join(root, "generation-0-failed.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      app.exit(1);
    });
    return;
  }
  report.willQuit = true; report.completed = success; clearTimeout(deadline);
  fs.writeFileSync(path.join(root, "generation-0.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  if (success) console.log("GROUP_NINE_PAGE_APP_OK");
});
async function run() {
  fs.writeFileSync(path.join(paths.userDataRoot, "config.json"), JSON.stringify({ gatewayUrl: "", token: "", openclawPluginHostMode: "managed",
    hermesPluginHostMode: "existing", hermesMode: "remote", hermesRemotes: [], disabledBackends: ["openclaw", "hermes"], setupCompletedAt: 1,
    locale: "zh-CN", theme: "light", telemetryConsent: false, hermesKeepAlive: false,
    notifications: { chat: false, cron: false, task: false }, windowBounds: { width: 1240, height: 950 } }), { mode: 0o600, flag: "wx" });
  const parentEnv = { HOME: isolatedHome, PATH: process.env.PATH, TMPDIR: root, NO_PROXY: "127.0.0.1,localhost,::1" };
  const runtimePool = new CodexRuntimePool({ paths, repoRoot: snapshot, failureThreshold: 100, parentEnv,
    runtimeAccountResolver: { parentEnv, userHome: isolatedHome, resolve(binding, account) {
      const home = prepareCodexRuntimeAccountHome(paths, binding.runtimeAccountId);
      return Object.freeze({ runtime: binding.runtime, runtimeAccountId: binding.runtimeAccountId, kind: account.kind,
        installationKind: "bundled", homeKind: account.homeKind, strategy: "managed-shared", home, nativeHome: null, integrationRoot: null,
        binaryPath: process.execPath, launchArgs: Object.freeze(["app-server"]), spawnEnv: Object.freeze({ HOME: isolatedHome, CODEX_HOME: home }), configurationMode: "overlay" });
    } },
    hostFactory: hostOptions => new CodexRuntimeHost({ ...hostOptions, repoRoot: snapshot, packageVersion: require(path.join(snapshot, "package.json")).version,
      probeBinary: async () => {}, spawnEnv: { ELECTRON_RUN_AS_NODE: "1", CODEX_FAKE_BEHAVIOR: "mcp-elicitation", CODEX_FAKE_ELICITATION_RESPONSE_PATH: path.join(root, "responses.jsonl"), CODEX_FAKE_AUTOCOMPLETE_ALL: "1", CODEX_FAKE_INDEPENDENT_IDS: "1", CODEX_FAKE_ID_NAMESPACE: "nine-pages", CODEX_FAKE_PROFILE: "nine-pages" },
      spawnProcess(_command, _args, options) { return spawn(process.execPath, [path.join(snapshot, "scripts/fixtures/codex-app-server-fake.cjs")], options); },
      requestTimeoutMs: 2000, initializeTimeoutMs: 2000, shutdownGraceMs: 100, killGraceMs: 100 }) });
  service = createAgentService({ paths, runtimePool, parentEnv, runtimeStorageHomedir: () => isolatedHome,
    version: require(path.join(snapshot, "package.json")).version, prewarmMcpAuth: false,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => Buffer.from(value).toString() } });
  report.stage = "service-start";
  await service.start(); const originalProfile = service.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
  const profile = originalProfile.defaultModel === "fake-model" ? originalProfile
    : service.productStore.putAgentProfile({ ...originalProfile, defaultModel: "fake-model" });
  const workspace = path.join(root, "chat-workspace"); fs.mkdirSync(workspace, { mode: 0o700 });
  const chat = service.chatSessionStore.createSession({ operationId: "nine-pages-create", profileId: profile.id, workspace, createdAt: Date.now() });
  // Fresh empty chats intentionally have no "all history loaded" banner. Use
  // a canonical saved-history anchor so the complete App proof can observe an
  // actual authoritative render before typing, without weakening the history
  // readiness gate or adding test hooks to product UI.
  const historyAnchor = "隔离验收历史锚点：正文已经载入。";
  const historyAnchorId = "nine-pages-saved-history-anchor";
  service.transcriptStore.appendEvent({ profileId: profile.id, sessionId: chat.id,
    id: historyAnchorId, kind: "assistant", content: { text: historyAnchor }, occurredAt: Date.now() - 1000 });
  const key = `agent:${profile.agentId}:${chat.sessionKey}`;
  report.stage = "ui-entry";
  checkpoint("production ui-entry startup");
  require(path.join(moduleRoot, "ui-entry.js")); report.actualUiEntryExecuted = !!require.cache[path.join(moduleRoot, "ui-entry.js")];
  await until(() => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.getURL().startsWith("http://127.0.0.1:"), "full ui-entry main window");
  report.stage = "navigation-mount";
  await until(async () => { try { return await js("document.querySelectorAll('.nav-link').length>=9"); } catch { return false; } }, "production navigation mount");
  report.origin = new URL(mainWindow.webContents.getURL()).origin; report.preferences = mainWindow.webContents.getLastWebPreferences();
  assert.equal(report.preferences.sandbox, true); assert.equal(report.preferences.contextIsolation, true); assert.equal(report.preferences.nodeIntegration, false);
  assert.equal(await js("typeof require"), "undefined");
  const links = await js("Array.from(document.querySelectorAll('.nav-link')).map(a=>({href:a.getAttribute('href'),label:a.getAttribute('aria-label')||a.getAttribute('title')}))");
  assert(links.length >= 9); report.navigationInventory = links;
  for (const link of links) {
    checkpoint(`route ${link.href}: click`);
    report.stage = `page:${link.href}`;
    await js(`document.querySelector(${JSON.stringify(`.nav-link[href="${link.href}"]`)}).click();void 0`);
    checkpoint(`route ${link.href}: render`);
    const page = await until(async () => {
      const value = await js(`(()=>{const content=document.querySelector('main.content'),text=content?.innerText.trim()||'',active=document.querySelector('.nav-link.active');return {href:active?.getAttribute('href'),hash:location.hash,text:text.slice(0,1200),loading:!!content?.querySelector('.page-loading'),rendered:text.length>8,resourceError:text.includes('界面资源读取失败，请重试。')}})()`);
      return value.href === link.href && !value.loading && value.rendered ? value : false;
    }, `route ${link.href} rendered`);
    assert.equal(page.resourceError, false); report.pages.push({ ...link, ...page });
    checkpoint(`route ${link.href}: animation frames`);
    await js("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))");
    checkpoint(`route ${link.href}: capture`);
    const file = path.join(root, `nine-page-${link.href.replace(/[^a-z0-9]/gi, "")}.png`);
    fs.writeFileSync(file, (await mainWindow.webContents.capturePage()).toPNG(), { mode: 0o600 }); report.screenshots.push(file);
  }
  checkpoint("native chat roundtrip");
  // Use one production navigation entry. Sending the notification event as well
  // would open the same session twice and could reset a just-entered draft.
  await js(`location.hash=${JSON.stringify("/chat?session=" + encodeURIComponent(key))};void 0`);
  // lastActive survives navigation and the composer mounts before history.
  // Wait for this session's authoritative saved body before entering the draft.
  await js("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))");
  await until(async () => await js(`location.hash==='#/chat'&&localStorage.getItem('shoggoth.chat.lastActive.v1')===${JSON.stringify(key)}&&!!document.querySelector('.chat-conv textarea:not(:disabled)')&&!!document.querySelector('.chat-thread [data-testid=\"chat-history-complete\"]')&&document.querySelector('.chat-thread')?.innerText.includes(${JSON.stringify(historyAnchor)})`), "target Chat session committed, canonical saved history loaded and composer ready");
  const prompt = "隔离集成验收：请回复一个确认词。";
  mainWindow.show(); mainWindow.focus(); app.focus({ steal: true });
  await js("document.querySelector('.chat-conv textarea').focus();void 0"); await mainWindow.webContents.insertText(prompt);
  await until(async () => await js(`document.querySelector('.chat-conv textarea')?.value===${JSON.stringify(prompt)}&&document.activeElement===document.querySelector('.chat-conv textarea')`), "real Chat input committed and focused");
  await until(async () => await js("!!document.querySelector('.chat-conv .chat-send:not(:disabled)')"), "real send enabled");
  await js("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))");
  // Use the actual enabled send button. Native key events depend on App focus
  // after the navigation sweep and can disappear before reaching React.
  report.chatSubmit = await js(`(()=>{const input=document.querySelector('.chat-conv textarea'),button=document.querySelector('.chat-conv .chat-send:not(:disabled)');if(input?.value!==${JSON.stringify(prompt)}||!button)throw new Error('Chat draft changed before submission');button.click();return {inputMethod:'Electron insertText',submitMethod:'production send button click',draft:${JSON.stringify(prompt)}}})()`);
  const run = await until(() => { const rows = service.productStore.listWorkRuns(); return rows.length === 1 && rows[0].status === "completed" && rows[0]; }, "actual native Chat execution completed");
  await until(async () => await js(`document.querySelector('.chat-thread')?.innerText.includes(${JSON.stringify(prompt)})&&document.querySelector('.chat-thread')?.innerText.includes('completed ')`), "real UI received native answer");
  const events = service.transcriptStore.listEvents(profile.id, chat.id);
  const user = events.filter(e => e.kind === "user"), answers = events.filter(e => e.kind === "assistant" && e.runId === run.id);
  assert.equal(user.length, 1); assert.equal(answers.length, 1);
  assert.equal(events.filter(e => e.kind === "assistant").length, 2, "only the saved anchor and this one actual native answer exist");
  assert.equal(events.find(e => e.id === historyAnchorId)?.content.text, historyAnchor, "saved history remains unchanged after the native roundtrip");
  report.savedHistoryAnchorRetained = true;
  report.chat = { sent: true, received: true, workRuns: service.productStore.listWorkRuns().length, userMessages: user.length, nativeResponses: answers.length,
    runId: run.id, status: run.status, runtime: run.runtime, sessionKey: chat.sessionKey, prompt, domText: await js("document.querySelector('.chat-thread').innerText"), input: "Electron insertText + production send button click through React handler" };
  const metadata = await until(() => service.transcriptStore.listEvents(profile.id, chat.id)
    .find(event => event.runId === run.id && event.content?.transcriptType === "terminal")?.content.responseMetadata,
    "native response metadata persisted at terminal");
  assert.deepEqual(metadata.models, ["fake-model"]);
  // Message pinning is currently hidden in ChatMessageActions. Require the
  // two available actions by name, along with the canonical Service metadata.
  report.chat.footer = await until(async () => await js(`(()=>{const group=Array.from(document.querySelectorAll('.chat-thread .chat-group.is-assistant')).find(group=>group.innerText.includes(${JSON.stringify(run.resultSummary)}));const footer=group?.querySelector('.chat-group__footer');
    const model=footer?.querySelector('.chat-response-model');const shortcuts=Array.from(footer?.querySelectorAll('.chat-copybtn')||[]).map(button=>button.title);
    const modelId=model?.lastElementChild?.textContent;
    if(modelId!=='fake-model'||JSON.stringify(shortcuts)!==JSON.stringify(['复制为 Markdown','删除']))return null;
    if(/[↑↓]|\\b[RW]\\d|\\bctx\\b|\\btok\\b/.test(footer.textContent))throw Error('Message usage/context must stay hidden');
    const hidden=getComputedStyle(model).opacity==='0';if(!hidden)throw Error('Model must be hidden before message interaction');
    const copy=footer.querySelector('.chat-copybtn');copy.focus();const focused=getComputedStyle(model).opacity==='1'&&getComputedStyle(copy).opacity==='1';copy.blur();
    if(!focused)throw Error('Keyboard focus must reveal model and actions together');
    return {model:modelId,text:footer.innerText,modelHiddenByDefault:hidden,modelRevealedOnFocus:focused,shortcuts};})()`),
    "canonical Service metadata and copy/delete actions reached the real React footer");
  report.chat.responseMetadata = metadata;
  const screenshot = path.join(root, "nine-page-chat-roundtrip.png"); fs.writeFileSync(screenshot, (await mainWindow.webContents.capturePage()).toPNG(), { mode: 0o600 }); report.screenshots.push(screenshot);
  assert.equal(report.preloadErrors.length, 0); assert.equal(report.rendererCrashes.length, 0); assert.equal(report.forbiddenRequests.length, 0);
  report.productionRequests = report.requests.length; assert(report.productionRequests > 9);
  success = true; report.naturalQuitRequested = true; app.quit();
}
run().catch(async error => {
  report.failure = error.stack; console.error(error);
  try {
    report.failedWorkRuns = service?.productStore.listWorkRuns() || [];
    if (mainWindow && !mainWindow.isDestroyed()) {
      report.failedDomText = await js("document.querySelector('main.content')?.innerText");
      report.failedComposer = await js("(()=>{const input=document.querySelector('.chat-conv textarea'),button=document.querySelector('.chat-conv .chat-send');return {hash:location.hash,lastActive:localStorage.getItem('shoggoth.chat.lastActive.v1'),draft:input?.value,focused:document.activeElement===input,sendDisabled:button?.disabled}})()");
      const screenshot = path.join(root, "nine-page-failure.png");
      fs.writeFileSync(screenshot, (await mainWindow.webContents.capturePage()).toPNG(), { mode: 0o600 });
      report.screenshots.push(screenshot);
    }
    fs.writeFileSync(path.join(root, "generation-0-failed.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  } catch (diagnosticError) { console.error("failure diagnostic", diagnosticError); }
  try { await service?.stop(); } catch {} clearTimeout(deadline); app.exit(1);
});
