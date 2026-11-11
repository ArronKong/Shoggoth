"use strict";
// Generic ACP acceptance driver. Full production UI, Service and Helper; only
// the signed ACP executable, local encryption provider and Registry transport are controlled.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const net = require("node:net");
const http = require("node:http");
const { app, BrowserWindow, session } = require("electron");
const root = process.env.SHOGGOTH_APP_RECOVERY_FIXTURE_ROOT, snapshot = path.join(root, "source"), moduleRoot = path.join(snapshot, "app"), isolatedHome = path.join(root, "home");
const connectorAcceptance = false;
const generation = Number(process.env.SHOGGOTH_APP_RECOVERY_GENERATION);
assert([0, 1].includes(generation));
assert(root.startsWith("/private/tmp/sg-model-app-restart-") && fs.realpathSync(root) === root); assert.equal(app.getAppPath(), snapshot);
assert.equal(app.isReady(), false); assert.equal(fs.statSync(root).mode & 0o777, 0o700);
const originalUserInfo = os.userInfo.bind(os); os.userInfo = (...args) => ({ ...originalUserInfo(...args), homedir: isolatedHome });
const { prepareDesktopData } = require(path.join(moduleRoot, "desktop-data-bootstrap"));
const paths = prepareDesktopData(app, { userInfo: () => ({ homedir: isolatedHome }) });
assert(paths.userDataRoot.startsWith(isolatedHome + path.sep));
const { createAgentService } = require(path.join(moduleRoot, "agent-service/server"));
const { readClientToken, requestService } = require(path.join(moduleRoot, "agent-service/client"));
const { SERVICE_PROTOCOL_VERSION } = require(path.join(moduleRoot, "agent-service/service-protocol-version"));
const { DEFAULT_AGENT_PROFILE_ID } = require(path.join(moduleRoot, "agent-service/product-store"));
const report = { completed: false, willQuit: false, actualUiEntryExecuted: false, naturalQuitRequested: false,
  pid: process.pid, userData: paths.userDataRoot, sessionData: app.getPath("sessionData"), pages: [], screenshots: [],
  forbiddenRequests: [], rendererErrors: [], rendererCrashes: [], preloadErrors: [], requests: [], externalModelCalls: 0, blockedNativeLookups: [], forbiddenNativeExecutionAttempts: 0,
  genericAcp: true, generation, boundary: "frozen full ui-entry and actual production Service/SQLite/Backend/Registry/Proxy/REST/chat broker/preload/React/Helper; signed Generic ACP process controlled; no physical human input or external provider" };
let mainWindow, service, success = false, serviceStopping = false;
let disclosureGateway, disclosureProjectionFails = true, disclosureProviderPort;
let connectorAccount, connectorPid;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeout = 20000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await read(); if (value) return value; await pause(30); } throw Error(label); }
const js = code => mainWindow.webContents.executeJavaScript(code, true);
function reloadRenderer() {
  // reload() returns void. Dispatching executeJavaScript immediately afterwards
  // can target the old frame and leave its promise pending across navigation.
  // Observe the real load completion before reading the replacement document.
  return new Promise((resolve, reject) => {
    const contents = mainWindow.webContents;
    const cleanup = () => { clearTimeout(timer); contents.removeListener("did-finish-load", loaded); contents.removeListener("did-fail-load", failed); };
    const loaded = () => { cleanup(); resolve(); };
    const failed = (_event, code, description, _url, isMainFrame) => { if (isMainFrame) { cleanup(); reject(Error(`renderer reload failed: ${code} ${description}`)); } };
    const timer = setTimeout(() => { cleanup(); reject(Error("renderer reload did not finish")); }, 20000);
    contents.once("did-finish-load", loaded); contents.on("did-fail-load", failed); contents.reload();
  });
}
const checkpoint = phase => {
  report.phase = phase;
  fs.writeFileSync(path.join(root, "navigation-checkpoint.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
};
const deadline = setTimeout(() => {
  checkpoint("deadline: " + report.phase);
  report.failure = "nine-page App deadline";
  report.window = mainWindow && !mainWindow.isDestroyed() ? { url: mainWindow.webContents.getURL(),
    loading: mainWindow.webContents.isLoading(), destroyed: mainWindow.webContents.isDestroyed() } : null;
  fs.writeFileSync(path.join(root, `generation-${generation}-failed.json`), JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  console.error("nine-page App deadline", report.stage, report.window); app.exit(2);
}, 138000);
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
      await service.stop(); report.serviceStopped = true;
      const children = [...new Set(auditRows().flatMap(row => row.kind === "started" ? [row.pid] : row.kind === "helper-started" ? [row.helperPid] : []))];
      for (const pid of children) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `owned ACP/Helper child ${pid} must exit`);
      report.childrenClosed = true; report.ownedChildren = children;
      if (connectorAcceptance) {
        assert.throws(() => process.kill(connectorPid, 0), { code: "ESRCH" });
        assert.equal(fs.existsSync(path.join(paths.stateDir, "connectors/runtime-child.json")), false);
        report.connectors.childClosed = true;
      }
      app.quit();
    })().catch(error => {
      report.failure = error.stack; console.error(error); clearTimeout(deadline);
      fs.writeFileSync(path.join(root, `generation-${generation}-failed.json`), JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      app.exit(1);
    });
    return;
  }
  report.willQuit = true; report.completed = success; clearTimeout(deadline);
  fs.writeFileSync(path.join(root, `generation-${generation}.json`), JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  if (success) console.log("GENERIC_ACP_APP_OK");
});

const auditFile = path.join(root, "acp-worker-audit.jsonl"), fixtureFile = path.join(root, "acp-app-fixture.json");
const auditRows = () => fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const rpc = (method, params = {}) => requestService(paths, { token: readClientToken(paths), version: SERVICE_PROTOCOL_VERSION, method, params }, { timeoutMs: 15000 });
async function openChat(profile, chat, expected) {
  const key = `agent:${profile.agentId}:${chat.sessionKey}`;
  await js(`location.hash=${JSON.stringify("/chat?session=" + encodeURIComponent(key))};void 0`);
  await until(async () => await js(`location.hash==='#/chat'&&localStorage.getItem('shoggoth.chat.lastActive.v1')===${JSON.stringify(key)}&&!!document.querySelector('.chat-conv textarea:not(:disabled)')&&document.querySelector('.chat-thread')?.innerText.includes(${JSON.stringify(expected)})`), "canonical ACP conversation and composer ready");
}
async function visibleButtonPoint(selector, { scroll = false } = {}) {
  if (scroll) await js(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center',inline:'nearest'});void 0`);
  await js("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(null))))");
  return until(async () => await js(`(()=>{const button=document.querySelector(${JSON.stringify(selector)});if(!button||button.disabled)return null;const rect=button.getBoundingClientRect();const x=Math.round(rect.left+rect.width/2),y=Math.round(rect.top+rect.height/2);if(rect.width<=0||rect.height<=0||x<0||x>=innerWidth||y<0||y>=innerHeight)return null;const hit=document.elementFromPoint(x,y);return hit&&(hit===button||button.contains(hit))?{x,y}:null})()`), `visible, unobscured button ${selector}`);
}
async function clickVisibleButton(selector, options) {
  const point = await visibleButtonPoint(selector, options); mainWindow.webContents.focus();
  mainWindow.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
  mainWindow.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
}
async function sendChat(prompt) {
  await js("document.querySelector('.chat-conv textarea').focus();void 0"); await mainWindow.webContents.insertText(prompt);
  await until(async () => await js(`document.querySelector('.chat-conv textarea')?.value===${JSON.stringify(prompt)}&&!!document.querySelector('.chat-conv .chat-send:not(:disabled)')`), "ACP input committed and send enabled");
  await clickVisibleButton(".chat-conv .chat-send:not(:disabled)");
}
async function credentialUiProof(profile, chat, fixture, restart = false) {
  const hidden = () => js("!Array.from(document.querySelectorAll('button')).some(button=>/密码与结果|Passwords & results|管理这次对话的密码与操作结果|Manage passwords and results/.test(button.textContent+' '+button.title))");
  assert.equal(await hidden(), true, "credential management stays out of the chat UI");
  const scope = { profileId: profile.id, sessionId: chat.sessionKey };
  const owner = { backendId: "shoggoth", agentId: profile.id, sessionKey: chat.sessionKey };
  const readResult = receiptId => rpc("chat.secret.result", { ...owner, receiptId });
  const broker = service.mcpProductToolController.secretExecution;
  if (!restart) {
    const input = "[ACP_PROBE:secret-ui] 凭据自动处理验收，密码是 764219，订单号：210987";
    await sendChat(input);
    await until(async () => await js("document.querySelector('.chat-thread')?.innerText.includes('ACP answer secret-ui')"), "credential message automatically prepares and completes through actual React and ACP");
    const items = broker.secrets.list(scope); assert.equal(items.length, 1);
    const reference = items[0].reference;
    let calls = 0;
    const receipt = await broker.execute({ scope, callId: "app-secret-result-fixture", tool: "fixture-echo", args: { value: reference },
      assertCurrent() {}, invoke: async args => { calls++; assert.equal(args.value, "764219"); return { echo: args.value, text: "Recorded fixture result" }; } });
    assert.equal(calls, 1); fixture.secretProof = { reference, receiptId: receipt.receiptId };
    const original = await readResult(receipt.receiptId);
    assert(JSON.stringify(original).includes("764219"));
    assert.equal(await hidden(), true);
    assert.equal(await js("document.body.innerText.includes('764219')"), false);
    await capture("credential-hidden");
    assert.equal(calls, 1);
    assert.equal(await js("JSON.stringify(Object.entries(localStorage)).includes('764219')"), false);
    assert.equal(JSON.stringify(service.transcriptStore.listEvents(profile.id, chat.id)).includes("764219"), false);
    assert(auditRows().some(row => row.kind === "secret-projection" && row.token === "secret-ui"));
    report.secretUi = { buttonHidden: true, inputPrepared: true, localResultRead: true, executionCount: calls, plaintextCacheAbsent: true };
  } else {
    const before = auditRows().filter(row => row.kind === "prompt").length;
    const original = await readResult(fixture.secretProof.receiptId);
    assert(JSON.stringify(original).includes("764219"), "original result survives full App restart without invoking the tool");
    assert.equal((await rpc("chat.secret.revoke", { ...owner, reference: fixture.secretProof.reference })).revoked, 1);
    assert.equal(broker.secrets.list(scope).length, 0);
    const result = await readResult(fixture.secretProof.receiptId);
    assert(!JSON.stringify(result).includes("764219")); assert(JSON.stringify(result).includes("Recorded fixture result"));
    assert.equal(auditRows().filter(row => row.kind === "prompt").length, before);
    assert.equal(await hidden(), true);
    assert.equal(await js("document.body.innerText.includes('764219')"), false);
    await capture("credential-revoked");
    report.secretUi = { buttonHidden: true, restored: true, revoked: true, unrelatedResultRetained: true, replayedPrompts: 0 };
  }
}
async function disclosureUiProof(profile, chat) {
  const received = [], scope = { profileId: profile.id, sessionId: chat.sessionKey };
  const provider = http.createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    received.push(JSON.parse(raw)); response.writeHead(200, { "content-type": "application/json" }); response.end('{"output":[]}');
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  disclosureProviderPort = provider.address().port;
  const route = await disclosureGateway.bind({ scope, providerKind: "chatgpt" });
  const send = () => fetch(route.baseUrl + "/responses", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "password: 764219" }) });
  const visible = () => js("document.body.innerText.includes('本次发送原文') || document.body.innerText.includes('发送已暂停')");
  try {
    assert.equal(await visible(), false);
    disclosureProjectionFails = true;
    const original = await send(); assert.equal(original.status, 200); await original.text();
    assert.deepEqual(received, [{ input: "password: 764219" }]);
    assert.equal(await visible(), false);
    assert.equal(await js("document.body.innerText.includes('764219')"), false);
    await capture("silent-original-fallback");
    disclosureProjectionFails = false;
    const safe = await send(); assert.equal(safe.status, 200); await safe.text();
    assert.equal(received.length, 2);
    assert.match(received[1].input, /\{\{SHOGGOTH_SECRET_[a-f0-9]{32}\}\}/u);
    assert.equal(await visible(), false);
    route.close(); assert.equal((await send()).status, 503); assert.equal(received.length, 2);
    report.disclosureUi = { actualReactObserved: true, originalProviderCalls: 1, protectedProviderCalls: 1,
      revokedProviderCalls: 0, originalOptionVisible: false, plaintextAbsent: true };
  } finally { route.close(); disclosureProviderPort = null; provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
}
async function capture(label, expectedText) {
  const file = path.join(root, `acp-${generation}-${label}.png`);
  // A hidden/minimized private window cannot produce animation frames after
  // reload. Make this fixture window paintable without taking keyboard focus.
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.showInactive();
  // Layout rectangles can exist while a column's finite entry animation is
  // still transparent. Wait for the actual paint boundary without disabling
  // motion, changing production styles, or waiting on infinite spinners.
  const animations = await until(async () => { await js("new Promise(resolve=>requestAnimationFrame(()=>resolve(null)))"); return await js(`(()=>{const content=document.querySelector('main.content');if(!content)return null;const finite=content.getAnimations({subtree:true}).filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime));return finite.every(animation=>animation.playState==='finished'||animation.playState==='idle')?{finiteAnimations:finite.length,unfinished:0}:null})()`); }, `${label} finite page animations finished`).catch(async error => {
    report.animationFailure = await js(`document.querySelector('main.content')?.getAnimations({subtree:true}).map(animation=>({state:animation.playState,currentTime:animation.currentTime,endTime:String(animation.effect?.getComputedTiming().endTime),timing:animation.effect?.getTiming(),name:animation.animationName,transition:animation.transitionProperty,target:animation.effect?.target?.outerHTML.slice(0,600)}))`);
    checkpoint('capture-failed: '+label);
    throw error;
  });
  await js("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(null))))");
  let paintedTarget = null;
  if (expectedText) paintedTarget = await until(async () => await js(`(()=>{const content=document.querySelector('main.content');if(!content||content.querySelector('.page-loading'))return null;for(const node of content.querySelectorAll('*')){if(node.children.length||node.textContent.trim()!==${JSON.stringify(expectedText)})continue;const rect=node.getBoundingClientRect();if(rect.width<=0||rect.height<=0||rect.left<0||rect.right>innerWidth||rect.top<0||rect.bottom>innerHeight)continue;const ancestors=[];let visible=true;for(let parent=node;parent;parent=parent.parentElement){const style=getComputedStyle(parent);ancestors.push({tag:parent.tagName,opacity:style.opacity,visibility:style.visibility,display:style.display});if(style.display==='none'||style.visibility!=='visible'||Number(style.opacity)<0.99){visible=false;break;}if(parent===content)break;}if(!visible)continue;const x=Math.round(rect.left+rect.width/2),y=Math.round(rect.top+rect.height/2),hit=document.elementFromPoint(x,y);if(hit&&(hit===node||node.contains(hit)))return {text:${JSON.stringify(expectedText)},rect:{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom},centerHit:true,ancestors};}return null})()`), `${label} text painted and unobscured`);
  report.visualProofs ||= []; report.visualProofs.push({ label, ...animations, paintedTarget });
  fs.writeFileSync(file, (await mainWindow.webContents.capturePage()).toPNG(), { mode: 0o600 }); report.screenshots.push(file);
}
async function run() {
  const configPath = path.join(paths.userDataRoot, "config.json");
  if (!generation) fs.writeFileSync(configPath, JSON.stringify({ gatewayUrl: "", token: "", openclawPluginHostMode: "managed",
    hermesPluginHostMode: "existing", hermesMode: "remote", hermesRemotes: [], disabledBackends: ["openclaw", "hermes"], setupCompletedAt: 1,
    locale: "zh-CN", theme: "light", telemetryConsent: false, hermesKeepAlive: false,
    notifications: { chat: false, cron: false, task: false }, windowBounds: { width: 1240, height: 950 } }), { mode: 0o600, flag: "wx" });
  const { RuntimeExtensionCatalog } = require(path.join(moduleRoot, "agent-service/runtime-extension-manifest"));
  const runtime = "ext-app-proof", accountId = "extension-ext-app-proof";
  if (!generation) {
    const command = fs.realpathSync(process.env.SHOGGOTH_ACP_FIXTURE_NODE), script = path.join(snapshot, "scripts/fixtures/generic-acp-app-worker.cjs");
    assert.notEqual(command, process.execPath, "The signed worker uses Node, not an unconfigured Electron executable");
    const manifest = { version: 1, runtime, transport: "acp", command, args: [script],
      files: [command, script].map(file => ({ path: file, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") })), endpoint: null, credentialRef: null };
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const payload = JSON.stringify(Object.fromEntries(Object.keys(manifest).sort().map(key => [key, manifest[key]])));
    new RuntimeExtensionCatalog(paths).install({ manifest, signature: crypto.sign(null, Buffer.from(payload), privateKey).toString("base64") }, publicKey.export({ type: "spki", format: "pem" }));
  }
  const parentEnv = { HOME: isolatedHome, PATH: process.env.PATH, TMPDIR: root, NO_PROXY: "127.0.0.1,localhost,::1" };
  const { RuntimeMcpGateIssuer } = require(path.join(moduleRoot, "agent-service/runtime-mcp-gate"));
  const runtimeMcpGateIssuer = new RuntimeMcpGateIssuer({ paths, mcpHelperLaunch: { command: process.execPath, argsPrefix: [] },
    bootstrapPath: path.join(snapshot, "scripts/fixtures/generic-acp-app-helper.cjs") });
  report.helperBoundary = "production bootstrap-role, actual live parent/process identity, gate/HMAC/Service/relay/tool route; only OS account-home observation injected by a controlled source-mode launcher";
  const blockedNativePool = runtime => ({
    get(binding, options = {}) {
      const execution = !!options.executionContract;
      report.blockedNativeLookups.push({ runtime, executionContract: execution, callsite: new Error().stack.split("\n").slice(2, 7) });
      if (execution) { report.forbiddenNativeExecutionAttempts++; report.externalModelCalls++; }
      throw Error("Native runtime forbidden in Generic ACP proof");
    }, async stopAll() {}, async stop() {},
  });
  report.nativeRuntimePoolsBlocked = ["codex", "grok-build", "antigravity", "pi", "claude-code", "opencode", "deepseek-harness"];
  // Keep the real Registry parser/cache and Service/IPC/REST path while making
  // navigation independent of live catalog contents and publisher icon URLs.
  const { McpRegistryClient } = require(path.join(moduleRoot, "agent-service/mcp-registry-client"));
  const registryEntry = { server: { name: "io.github.github/github-mcp-server", title: "GitHub", version: "1.0.0-fixture",
    description: "Controlled App acceptance directory entry", repository: { url: "https://github.com/github/github-mcp-server" },
    remotes: [{ type: "streamable-http", url: "https://api.githubcopilot.com/mcp/" }] },
    _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } } };
  report.registry = { controlledTransport: true, realClient: true, requests: [], recommendedRendered: false };
  const mcpRegistryClient = new McpRegistryClient({ fetch: async raw => {
    const url = new URL(raw); assert.equal(url.origin, "https://registry.modelcontextprotocol.io");
    assert.equal(url.pathname, "/v0.1/servers"); assert.equal(url.searchParams.get("version"), "latest");
    const search = url.searchParams.get("search") || ""; report.registry.requests.push({ search });
    const servers = !search || search === registryEntry.server.name ? [registryEntry] : [];
    return { ok: true, text: async () => JSON.stringify({ servers, metadata: {} }) };
  } });
  // Only the fault and upstream transport are controlled. The production gateway,
  // disclosure store, Service owner, REST, React, preload and desktop IPC execute.
  disclosureGateway = new (require(path.join(moduleRoot, "agent-service/model-secret-gateway")).ModelSecretGateway)({
    disclosures: new (require(path.join(moduleRoot, "agent-service/model-secret-disclosures")).ModelSecretDisclosures)(),
    projection: { async project(scope, body, options) {
      if (disclosureProjectionFails) throw Object.assign(Error("synthetic projection failure"), { code: "SECRET_MEDIA_UNAVAILABLE" });
      return new (require(path.join(moduleRoot, "agent-service/model-secret-projection")).ModelSecretProjection)({
        secrets: service.mcpProductToolController.secretExecution.secrets,
      }).project(scope, body, options);
    } },
    request(url, options, callback) {
      assert.equal(url.href, "https://chatgpt.com/backend-api/codex/responses"); assert(disclosureProviderPort);
      return http.request(`http://127.0.0.1:${disclosureProviderPort}/responses`, options, callback);
    },
  });
  service = createAgentService({ paths, parentEnv, runtimeMcpGateIssuer, runtimeStorageHomedir: () => isolatedHome,
    autoDetectChatSecrets: true,
    modelSecretGateway: disclosureGateway,
    mcpRegistryClient,
    runtimePool: blockedNativePool("codex"), grokBuildRuntimePool: blockedNativePool("grok-build"),
    antigravityRuntimePool: blockedNativePool("antigravity"), piRuntimePool: blockedNativePool("pi"),
    claudeCodeRuntimePool: blockedNativePool("claude-code"), openCodeRuntimePool: blockedNativePool("opencode"),
    deepSeekHarnessRuntimePool: blockedNativePool("deepseek-harness"),
    version: require(path.join(snapshot, "package.json")).version, prewarmMcpAuth: false,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => Buffer.from(value).toString() } });
  checkpoint("service-start"); await service.start();
  let fixture;
  if (!generation) {
    const base = { ...service.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID) };
    for (const field of ["defaultBindingId", "bindingsRevision", "selectedBindingId"]) delete base[field];
    service.productStore.putAgentProfile({ ...base, enabled: false });
    const workspace = path.join(root, "acp-workspace"); fs.mkdirSync(workspace, { mode: 0o700 });
    const accounts = [accountId, `${accountId}-second`];
    const firstAccount = service.productStore.getRuntimeAccount(accountId);
    service.productStore.putRuntimeAccount({ ...firstAccount, id: accounts[1], isDefault: false });
    const profiles = [0, 1].map(index => service.productStore.putAgentProfile({ ...base, id: crypto.randomUUID(),
      agentId: `shoggoth-acp-proof-${index + 1}`, name: `ACP 隔离助理 ${index + 1}`, runtime, runtimeProfileId: `acp-proof-${index + 1}`,
      runtimeAccountId: accounts[index], isDefault: false, enabled: true, defaultModel: null, defaultCwd: workspace,
      permissionPolicy: { sandbox: "danger-full-access", approvalPolicy: "on-request" } }));
    for (const profile of profiles) { service.agentDefinitionStore.ensureProfile({ profileId: profile.id, profileName: profile.name }); service.memoryStore.ensureProfile(profile.id); }
    const chats = profiles.map((profile, index) => service.chatSessionStore.createSession({ operationId: `acp-app-create-${index}`, profileId: profile.id, workspace, createdAt: Date.now() }));
    for (let index = 0; index < profiles.length; index++) service.transcriptStore.appendEvent({ profileId: profiles[index].id, sessionId: chats[index].id,
      id: `acp-saved-anchor-${index}`, kind: "assistant", content: { text: `ACP 历史锚点 ${index + 1}` }, occurredAt: Date.now() - 1000 });
    fixture = { profiles: profiles.map(profile => profile.id), chats: chats.map(chat => chat.sessionKey), workspace };
    fs.writeFileSync(fixtureFile, JSON.stringify(fixture), { mode: 0o600, flag: "wx" });
  } else fixture = JSON.parse(fs.readFileSync(fixtureFile, "utf8"));
  const profiles = fixture.profiles.map(id => service.productStore.getAgentProfile(id)), chats = fixture.chats.map(key => service.chatSessionStore.getSession(key));
  const beforePrompts = auditRows().filter(row => row.kind === "prompt").length;
  const cold = await rpc("runtime.extension.status.get");
  assert(cold.entries.filter(row => row.runtime === runtime).every(row => row.authentication === "unverified" && row.features.attachments.length === 0));
  assert.equal(auditRows().filter(row => row.kind === "prompt").length, beforePrompts);
  checkpoint("production-ui-entry"); require(path.join(moduleRoot, "ui-entry.js")); report.actualUiEntryExecuted = !!require.cache[path.join(moduleRoot, "ui-entry.js")];
  await until(() => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.getURL().startsWith("http://127.0.0.1:"), "Generic ACP full ui-entry window");
  await until(async () => { try { return await js("document.querySelectorAll('.nav-link').length>=9"); } catch { return false; } }, "actual production navigation");
  report.origin = new URL(mainWindow.webContents.getURL()).origin; report.preferences = mainWindow.webContents.getLastWebPreferences();
  assert.equal(report.preferences.sandbox, true); assert.equal(report.preferences.contextIsolation, true); assert.equal(report.preferences.nodeIntegration, false);
  assert.equal(await js("typeof require"), "undefined");
  if (!generation) {
    report.navigationInventory = await js("Array.from(document.querySelectorAll('.nav-link')).map(a=>({href:a.getAttribute('href'),label:a.getAttribute('aria-label')||a.getAttribute('title')}))");
    for (const link of report.navigationInventory) {
      checkpoint(`page:${link.href}`); await js(`document.querySelector(${JSON.stringify(`.nav-link[href="${link.href}"]`)}).click();void 0`);
      const page = await until(async () => await js(`(()=>{const content=document.querySelector('main.content');return document.querySelector('.nav-link.active')?.getAttribute('href')===${JSON.stringify(link.href)}&&!content?.querySelector('.page-loading')&&(content?.innerText.trim().length||0)>8?{rendered:true,resourceError:content.innerText.includes('界面资源读取失败，请重试。')}:null})()`), `production route ${link.href}`);
      assert.equal(page.resourceError, false); report.pages.push({ ...link, ...page });
      if (link.href === "#/connectors") {
        const direct = require(path.join(moduleRoot, "agent-service/data/mcp-featured-presets.json"))
          .filter(item => !item.hidden && !item.supersededBy && !item.registryName && item.setup !== "oauth-client" && item.setup !== "restricted" && !item.requiresOAuthApp);
        const officialSkills = require(path.join(moduleRoot, "agent-service/data/official-skill-connectors.json"));
        const displayName = item => ({ didi: "滴滴打车", luckin: "瑞幸咖啡", figma: "Figma", notion: "Notion", canva: "Canva",
          mcdonalds: "麦当劳", kiwi: "Kiwi", amap: "高德地图", mijia: "米家", "baidu-maps": "百度地图",
          variflight: "飞常准", eastmoney: "东方财富", ifind: "同花顺", "rollinggo-hotel": "RollingGo 酒店", monday: "Monday" }[item.id] || item.name);

        const recommended = await until(async () => await js("(() => { const sections = Array.from(document.querySelectorAll('main.content section')); const section = sections.find(value => value.querySelector('h2')?.textContent === '推荐'); const names = section ? Array.from(section.querySelectorAll('button strong')).filter(value => !value.closest('[data-device-recommendation]')).map(value => value.textContent) : []; if (!section || names.length !== " + (direct.length + officialSkills.length + 2) + ") return null; return { names, devices: Array.from(section.querySelectorAll('[data-device-recommendation]')).map(value => value.dataset.deviceRecommendation).sort(), github: section.querySelectorAll('[data-mcp-icon=\\\"io.github.github/github-mcp-server\\\"]').length, oldDirectory: sections.some(value => value.querySelector('h2')?.textContent === 'MCP 目录') }; })()"), "curated recommendations rendered through actual Registry REST");
        assert.equal(recommended.github, 1);
        assert.equal(recommended.oldDirectory, false);
        for (const item of require(path.join(moduleRoot, "agent-service/data/mcp-featured-presets.json")).filter(item => item.supersededBy || item.hidden)) {
          assert.equal(recommended.names.includes(item.name), false, "superseded or explicitly hidden entries remain configured but are not recommended");
        }
        assert.deepEqual(recommended.devices, ["calendar", "reminders"]);
        for (const item of direct) assert(recommended.names.includes(displayName(item)), displayName(item));
        for (const item of officialSkills) {
          assert(recommended.names.includes(displayName(item)), displayName(item));
          await js(`document.querySelector('[data-official-recommendation="${item.id}"] button').click();void 0`);
          await until(async () => await js(`(() => { const d=document.querySelector('[role="dialog"]'); return d?.textContent.includes(${JSON.stringify(displayName(item))}) && Array.from(d.querySelectorAll('button')).some(b=>b.textContent==='添加'&&!b.disabled); })()`), `${item.id} actual installation dialog and Service state`);
          assert.equal(await js("document.querySelector('[role=dialog]').textContent.includes('账号检查通过')"), false);
          if (item.id === "alipay") await capture("connectors-alipay-setup");
          assert.deepEqual(await js("Array.from(document.querySelectorAll('[role=dialog] footer button')).map(b=>b.textContent)"), ["添加"], "unadded connectors have one footer action");
          await js("document.querySelector('[role=dialog] button[aria-label=\"关闭\"]').click();void 0");
          await until(async () => await js("!document.querySelector('[role=dialog]')"), `${item.id} dialog closes`);
          assert.equal(service.officialSkillConnectorController.status(item.id).state, "notInstalled", "opening setup never installs or authorizes");
        }
        report.registry.officialSkillDialogs = officialSkills.map(item => item.id);
        await js("document.querySelector('[data-official-recommendation=fliggy]').scrollIntoView({block:'center'});void 0");
        await capture("connectors-official");
        report.registry.curatedRecommendations = recommended;
        assert(report.registry.requests.some(request => request.search === registryEntry.server.name));
        report.registry.recommendedRendered = true;
        // Public MCP registrations can arrive before separate ownership status.
        // Disabled bridges exercise presentation without launching any CLI.
        const { ensurePrivateDirectoryTree } = require(path.join(moduleRoot, "agent-service/security"));
        const displayRegistrations = ["alipay", "fliggy", "shop"].map((id, index) => {
          const runtimeRoot = path.join(paths.stateDir, "runtime-bin/official-skills", id, crypto.randomUUID());
          ensurePrivateDirectoryTree(path.join(runtimeRoot, "home"), paths.trustedRoot);
          return { id: `official-${id}-a0b0c0d${index}`, name: officialSkills.find(item => item.id === id).name, source: { kind: "custom" }, enabled: false,
            transport: { kind: "stdio-command", command: process.execPath, args: [path.join(moduleRoot, "agent-service/official-skill-mcp-bridge.js"), "--provider", id, "--root", runtimeRoot, "--home", path.join(runtimeRoot, "home")], cwd: runtimeRoot },
            auth: { kind: "none" }, secretRef: null, setup: { requiredFields: [], configuredFields: [] }, status: "disabled", lastCheck: null, disabledProfileIds: [] };
        });
        for (const server of displayRegistrations) service.nativeMcpStore.register({ expectedRevision: service.nativeMcpStore.revision, server });
        await js("window.dispatchEvent(new Event('shoggoth:mcp-connectors-changed'));void 0");
        await until(async () => await js(`!!document.querySelector('[data-mcp-icon="${displayRegistrations[0].id}"]')`), "installed registration is rendered");
        await js(`document.querySelector('[data-mcp-icon="${displayRegistrations[0].id}"]').scrollIntoView({block:'start'});void 0`);
        const iconRows = await until(async () => await js(`(() => {
          const ids=${JSON.stringify(displayRegistrations.map(server => server.id))};
          const rows=ids.map(id=>{const image=document.querySelector('[data-mcp-icon="'+id+'"] img');return image?.complete&&image.naturalWidth>0?{id,src:image.getAttribute('src')}:null});
          const duplicate=${JSON.stringify(["alipay", "fliggy", "shop"])}.some(id=>document.querySelector('[data-official-recommendation="'+id+'"]'));
          return rows.every(Boolean)&&!duplicate?rows:null;
        })()`), "installed official artwork loads and duplicate Add recommendations disappear");
        await js(`document.querySelector('[data-mcp-icon="${displayRegistrations[0].id}"]').scrollIntoView({block:'center'});void 0`);
        await capture("connectors-installed-icons");
        await js(`document.querySelector('[data-mcp-icon="${displayRegistrations[0].id}"]').closest('li').querySelector('button').click();void 0`);
        await until(async () => await js("(() => {const d=document.querySelector('[role=dialog]');const image=d?.querySelector('img');return image?.complete&&image.naturalWidth>0&&!Array.from(d.querySelectorAll('button')).some(b=>b.textContent==='添加');})()"), "installed Alipay management keeps its bundled icon and has no Add action");
        await capture("connectors-installed-icon-dialog");
        await js("document.querySelector('[role=dialog] button[aria-label]').click();void 0");
        await until(async () => await js("!document.querySelector('[role=dialog]')"), "installed management dialog closes");
        for (const server of displayRegistrations) service.nativeMcpStore.remove({ id: server.id, expectedRevision: service.nativeMcpStore.revision });
        await js("window.dispatchEvent(new Event('shoggoth:mcp-connectors-changed'));void 0");
        await until(async () => await js("!!document.querySelector('[data-official-recommendation=alipay]')"), "removing a registration restores its Add recommendation");
        report.registry.installedOfficialIcons = { rows: iconRows, noDuplicateAdd: true, dialogImageLoaded: true, removalRestoresRecommendation: true, businessCalls: false };
      }
      if (link.href === "#/settings") {
        await until(async () => await js("!!document.querySelector('[data-runtime=ext-app-proof]')"), "extension status rendered from actual Service");
        assert.equal(await js("document.querySelector('[data-runtime=ext-app-proof]')?.classList.contains('is-healthy')"), false);
        assert.equal(await js("!!document.querySelector('[data-runtime=ext-app-proof] button')"), false);
      }
    }
    checkpoint("first-ACP-chat-permission"); await openChat(profiles[0], chats[0], "ACP 历史锚点 1");
    const prompt = "[ACP_PROBE:first-chat] [ACP_REQUIRE_MCP] [ACP_APPROVAL] 请执行隔离确认。"; await sendChat(prompt);
    const waiting = await until(() => service.productStore.listWorkRuns().find(run => run.profileId === profiles[0].id && run.status === "waiting_approval"), "first ACP request reached the existing approval owner");
    assert.equal(waiting.runtimeTurnRef, null, "local prepared turn cannot claim remote acceptance before terminal");
    assert(waiting.runtimeAttemptRef?.attemptId); assert.equal(waiting.runtimeAttemptRef.dispatchState, "write_attempted");
    await until(async () => await js("!!document.querySelector('.chat-prompt--approval .chat-prompt__btn.is-primary:not(:disabled)')"), "first-event approval rendered in real React");
    await visibleButtonPoint(".chat-prompt--approval .chat-prompt__btn.is-primary:not(:disabled)", { scroll: true });
    await capture("approval"); await clickVisibleButton(".chat-prompt--approval .chat-prompt__btn.is-primary:not(:disabled)");
    const run = await until(() => service.productStore.getWorkRun(waiting.id)?.status === "completed" && service.productStore.getWorkRun(waiting.id), "Generic ACP UI approval roundtrip completed");
    await until(async () => await js("document.querySelector('.chat-thread')?.innerText.includes('ACP answer first-chat')"), "Generic ACP result rendered");
    report.approval = { actualReactClick: true, inputMethod: "Electron mouseDown/mouseUp", centerHitTestPassed: true, runId: run.id, preparedBeforeApproval: true };
    report.mcp = { actualHelperCall: auditRows().some(row => row.kind === "mcp-call" && row.token === "first-chat" && row.ok) };
    assert.equal(report.mcp.actualHelperCall, true); assert(run.runtimeTurnRef?.turnId); assert(run.runtimeSessionRef?.sessionId);
    report.chat = { sent: true, received: true, runtime: run.runtime, runId: run.id, runtimeSessionId: run.runtimeSessionRef.sessionId };
    await capture("chat");
    await credentialUiProof(profiles[0], chats[0], fixture);
    await disclosureUiProof(profiles[0], chats[0]);
    const beforeReload = service.transcriptStore.listEvents(profiles[0].id, chats[0].id);
    await reloadRenderer(); await until(async () => { try { return await js("document.querySelector('.chat-thread')?.innerText.includes('ACP answer first-chat')"); } catch { return false; } }, "renderer refresh retained canonical ACP history");
    assert.deepEqual(service.transcriptStore.listEvents(profiles[0].id, chats[0].id), beforeReload); report.rendererRefreshRetained = true;
    const sent = await Promise.all(profiles.map((profile, index) => rpc("chat.send", { operationId: `acp-app-isolation-${index}`, sessionKey: chats[index].sessionKey,
      prompt: `[ACP_PROBE:agent-${index + 1}] [ACP_REQUIRE_MCP] 隔离交互。`, createdAt: Date.now() })));
    const isolated = await Promise.all(sent.map(ack => service.workRunCoordinator.waitForTerminal(ack.run.id)));
    assert(isolated.every(run => run.status === "completed")); assert.notEqual(isolated[0].runtimeSessionRef.sessionId, isolated[1].runtimeSessionRef.sessionId);
    for (let index = 0; index < profiles.length; index++) {
      const events = service.transcriptStore.listEvents(profiles[index].id, chats[index].id);
      assert(events.some(event => event.kind === "assistant" && event.content.text?.includes(`ACP answer agent-${index + 1}`)));
      assert(!events.some(event => event.kind === "assistant" && event.content.text?.includes(`ACP answer agent-${2 - index}`)));
    }
    report.twoAgentIsolation = true;
    const job = (await rpc("cron.job.create", { operationId: "acp-app-cron-create", name: "ACP 隔离定时任务", enabled: false,
      profileId: profiles[0].id, prompt: "[ACP_PROBE:cron] [ACP_REQUIRE_MCP] 执行定时确认。", workspace: fixture.workspace,
      schedule: { kind: "every", everyMs: 60000, anchorMs: 0 }, misfirePolicy: "latest", maxCatchUp: 1,
      overlapPolicy: "skip", threadPolicy: "new", threadId: null, createdAt: Date.now() })).job;
    const cronAck = await rpc("cron.run.trigger", { operationId: "acp-app-cron-trigger", jobId: job.id, createdAt: Date.now() });
    const cronRun = await service.nativeCronScheduler.waitForIdle(cronAck.run?.id || cronAck.id);
    assert.equal(cronRun.status, "completed", cronRun.errorCode); report.cron = { completed: true, id: job.id, runId: cronRun.id };
    const board = (await rpc("kanban.board.create", { operationId: "acp-app-board-create", profileId: profiles[1].id,
      slug: "acp-proof", name: "ACP 隔离看板", description: null, createdAt: Date.now() })).board;
    const card = (await rpc("kanban.card.create", { operationId: "acp-app-card-create", boardId: board.id, profileId: profiles[1].id,
      title: "ACP 隔离卡片", body: "[ACP_PROBE:kanban] [ACP_REQUIRE_MCP] 执行看板确认。", status: "backlog", position: 0, createdAt: Date.now() })).card;
    const kanbanAck = await rpc("kanban.run.dispatch", { operationId: "acp-app-kanban-dispatch", cardId: card.id, workspace: fixture.workspace, createdAt: Date.now() });
    const kanbanRun = await service.kanbanRunService.waitForIdle(kanbanAck.run.id);
    assert.equal(kanbanRun.status, "completed", kanbanRun.errorCode); report.kanban = { completed: true, completionScope: "WorkRun execution; card workflow and business outcome are not asserted", boardId: board.id, cardId: card.id, runId: kanbanRun.id };
    for (const [route, text] of [["/cron", "ACP 隔离定时任务"], [`/tasks?backend=shoggoth&board=${encodeURIComponent(board.id)}`, "ACP 隔离卡片"]]) {
      await js(`location.hash=${JSON.stringify(route)};void 0`);
      await until(async () => await js(`(()=>{const content=document.querySelector('main.content');if(!content||content.querySelector('.page-loading'))return false;return ${route.startsWith('/tasks') ? `Array.from(content.querySelectorAll('*')).some(node=>{if(node.children.length||node.textContent.trim()!==${JSON.stringify(text)})return false;const rect=node.getBoundingClientRect();return rect.width>0&&rect.height>0&&rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight})` : `content.innerText.includes(${JSON.stringify(text)})`}})()`), `${route} actual ACP object rendered`);
      await capture(route.startsWith("/tasks") ? "tasks" : "cron", route.startsWith("/tasks") ? text : undefined);
    }
    checkpoint("cancel-pending-ACP-approval");
    await openChat(profiles[1], chats[1], "ACP answer agent-2");
    await sendChat("[ACP_PROBE:cancel-approval] [ACP_REQUIRE_MCP] [ACP_APPROVAL] 取消后不得继续批准。");
    const pending = await until(() => service.productStore.listWorkRuns().find(row => row.profileId === profiles[1].id && row.status === "waiting_approval"), "cancel probe reached actual approval owner");
    await until(async () => await js("!!document.querySelector('.chat-stop')&&!!document.querySelector('.chat-prompt--approval')"), "real React stop and approval visible together");
    await clickVisibleButton(".chat-stop");
    const canceled = await until(() => service.productStore.getWorkRun(pending.id)?.status === "canceled" && service.productStore.getWorkRun(pending.id), "React stop converged canceled ACP execution");
    await assert.rejects(rpc("run.approval.respond", { operationId: "acp-app-late-approval", runId: pending.id,
      requestId: pending.waitingRequestId, choice: "once", createdAt: Date.now() }), { code: "RUN_REQUEST_NOT_FOUND" });
    assert.equal(auditRows().some(row => row.kind === "completed" && row.token === "cancel-approval"), false);
    report.cancel = { actualReactClick: true, inputMethod: "Electron mouseDown/mouseUp", centerHitTestPassed: true, status: canceled.status, lateApprovalRejected: true };
    checkpoint("crash-unknown-without-replay");
    const crashInput = { operationId: "acp-app-crash-after-write", sessionKey: chats[1].sessionKey,
      prompt: "[ACP_PROBE:crash] [ACP_REQUIRE_MCP] [ACP_CRASH] 验证未知结果不可重发。", createdAt: Date.now() };
    const crashAck = await rpc("chat.send", crashInput);
    const crashed = await service.workRunCoordinator.waitForTerminal(crashAck.run.id);
    assert.equal(crashed.status, "interrupted"); assert.equal(crashed.errorCode, "RUNTIME_TURN_ACCEPTANCE_UNKNOWN");
    assert.equal(crashed.runtimeSessionRef, null); assert.equal(crashed.runtimeTurnRef, null);
    assert.equal(crashed.runtimeAttemptRef.dispatchState, "write_attempted");
    const replay = await rpc("chat.send", crashInput); assert.equal(replay.run.id, crashed.id);
    assert.equal(auditRows().filter(row => row.kind === "prompt" && row.token === "crash").length, 1);
    report.crashUnknown = { runId: crashed.id, status: crashed.status, code: crashed.errorCode, duplicatePromptCount: 0, remoteAccepted: false };
    checkpoint("unknown-attempt-reload"); await reloadRenderer(); checkpoint("unknown-attempt-history");
    await until(async () => { try { return await js("document.querySelector('.chat-thread')?.innerText.includes('[ACP_PROBE:crash]')"); } catch { return false; } }, "unknown ACP attempt survives renderer refresh");
    assert.equal(auditRows().filter(row => row.kind === "prompt" && row.token === "crash").length, 1);
    checkpoint("unknown-attempt-capture"); await capture("unknown-retained");
    fixture.firstRunId = run.id; fixture.runtimeSessionId = run.runtimeSessionRef.sessionId;
    fs.writeFileSync(fixtureFile, JSON.stringify(fixture), { mode: 0o600 });
  } else {
    checkpoint("restart-history"); await openChat(profiles[0], chats[0], "ACP answer first-chat");
    assert.equal(auditRows().filter(row => row.kind === "prompt").length, beforePrompts, "history reads cannot replay an old prompt");
    assert.equal(await js("document.querySelector('.chat-thread')?.innerText.includes('ACP replay-only marker')"), false);
    report.restartRetained = true; report.historyReplayedPrompts = 0;
    await credentialUiProof(profiles[0], chats[0], fixture, true);
    await sendChat("[ACP_PROBE:after-restart] [ACP_REQUIRE_MCP] 重启后继续。");
    const run = await until(() => service.productStore.listWorkRuns().find(run => run.profileId === profiles[0].id && run.id !== fixture.firstRunId
      && run.startedAt >= report.startedAt && run.status === "completed"), "ACP conversation continued after full App/Service restart");
    assert.equal(run.runtimeSessionRef.sessionId, fixture.runtimeSessionId);
    await until(async () => await js("document.querySelector('.chat-thread')?.innerText.includes('ACP answer after-restart')"), "restarted ACP reply rendered");
    report.chat = { sent: true, received: true, runtimeSessionId: run.runtimeSessionRef.sessionId, runId: run.id };
    await capture("restart-chat");
  }
  report.audit = auditRows().map(({ home, ...row }) => row);
  report.runtimeStatuses = await rpc("runtime.extension.status.get");
  report.observability = await rpc("runtime.observability.get");
  assert.equal(report.preloadErrors.length, 0); assert.equal(report.rendererCrashes.length, 0); assert.equal(report.forbiddenRequests.length, 0);
  assert.equal(report.externalModelCalls, 0); assert.equal(report.forbiddenNativeExecutionAttempts, 0);
  success = true; report.naturalQuitRequested = true; checkpoint("natural-quit"); app.quit();
}
report.startedAt = Date.now();
run().catch(async error => {
  report.failure = error.stack; console.error(error);
  try {
    report.failedWorkRuns = service?.productStore.listWorkRuns() || [];
    report.audit = auditRows().map(({ home, ...row }) => row);
    if (mainWindow && !mainWindow.isDestroyed()) { report.failedDomText = await js("document.querySelector('main.content')?.innerText"); await capture("failure"); }
    fs.writeFileSync(path.join(root, `generation-${generation}-failed.json`), JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  } catch (diagnosticError) { console.error("failure diagnostic", diagnosticError); }
  try { await service?.stop(); } catch {} clearTimeout(deadline); app.exit(1);
});
