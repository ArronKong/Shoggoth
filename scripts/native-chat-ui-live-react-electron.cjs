#!/usr/bin/env node
"use strict";
// Real Service, Backend, Gateway, built React and Electron host. Only the
// native model transport is controlled; there are no fabricated UI replies.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const { atomicWritePrivateFile } = require("../app/agent-service/private-file");
// Parent and Electron readers must never observe a marker before its complete
// JSON payload is published. Invalid complete JSON still fails the qualification.
const markerPath = (root, name) => path.join(root, "gui-markers", name + ".json");
const writeMarker = (root, name, value) => atomicWritePrivateFile(markerPath(root, name), JSON.stringify(value), { trustedRoot: root });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = NATIVE_INPUT ? 90000 : 15000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await check(); if (value) return value; await delay(40); } throw Error(label); }
const ROOT = path.resolve(__dirname, "..");
const NATIVE_INPUT = process.env.NATIVE_CHAT_UI_NATIVE_INPUT === "1";
const READ_FLOW = process.env.NATIVE_CHAT_UI_READ_FLOW === "1";
assert(READ_FLOW || NATIVE_INPUT, "Full action qualification requires NATIVE_CHAT_UI_NATIVE_INPUT=1 and real native clicks; use NATIVE_CHAT_UI_READ_FLOW=1 for the read-only fixture");
if (!process.versions.electron) main().catch(error => { console.error(error); process.exitCode = 1; });
else {
  process.on("unhandledRejection", error => { console.error(error); require("electron").app.exit(1); });
  electronMain().catch(error => { console.error(error); require("electron").app.exit(1); });
}
async function main() {
  const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs"), { declaration } = require("./native-chat-ui-service-unit.cjs");
  const { ShoggothBackend } = require("../app/core/shoggoth-backend"), { BackendRegistry } = require("../app/core/backend-registry");
  const { startProxyGateway } = require("../app/core/proxy-gateway"), { createWorkAdmissionGate } = require("../app/core/work-admission-gate");
  const { DEFAULT_OPERATOR_SCOPES, generateIdentity } = require("../app/core/device-auth"), { startStaticServer } = require("../app/static-server");
  const f = await openHandoffFixture(), registry = new BackendRegistry(), output = path.resolve(process.env.NATIVE_CHAT_UI_OUTPUT || path.join(ROOT, READ_FLOW ? ".artifacts/native-chat-ui/live-react-read" : ".artifacts/native-chat-ui/live-react"));
  let backend, proxy, server, child, deadline;
  fs.mkdirSync(output, { recursive: true });
  const mark = (name, value = {}) => writeMarker(f.root, name, value);
  const seen = name => waitFor(() => { const file = markerPath(f.root, name); if (fs.existsSync(markerPath(f.root, "failed"))) throw Error(fs.readFileSync(markerPath(f.root, "failed"), "utf8")); return fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")); }, name, NATIVE_INPUT ? 90000 : 30000);
  try {
    f.service.chatUiConfig.apply({ revision: 1, config: { nativeChatUiV1: true } });
    const session = f.createSession(), key = `agent:${f.profile.agentId}:${session.sessionKey}`;
    const producer = await f.send(session.sessionKey, crypto.randomUUID(), "比较三个方案并生成两张交互卡片"); assert.equal(producer.status, "running");
    backend = new ShoggothBackend({ paths: f.paths, serviceEventPollMs: 30, getNativeChatUiConfig: () => f.service.chatUiConfig.read() }); registry.register(backend);
    assert.equal((await registry.start()).get("shoggoth"), true);
    proxy = await startProxyGateway({ port: 0, getUpstreamUrl: () => "", registry, workAdmissionGate: createWorkAdmissionGate() });
    const identity = generateIdentity(), config = { locale: "zh-CN", effectiveLocale: "zh-CN", setupCompletedAt: Date.now(), gatewayUrl: "", token: "", disabledBackends: ["openclaw", "hermes"] };
    server = await startStaticServer(0, { registry, chatUpstreamUrl: proxy.url, chatOrigin: "http://127.0.0.1", homeDir: f.root, userDataRoot: path.join(f.root, "desktop-assets"), configStore: { read: () => config },
      authResolver: { resolveConnectAuth: () => ({ ...identity, token: "isolated-native-ui", scopes: DEFAULT_OPERATOR_SCOPES }), storeDeviceToken() {} } });
    mark("options", { paths: f.paths, key, profile: f.profile, session, config, url: server.url, output });
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    child = require("node:child_process").spawn(process.env.NATIVE_CHAT_UI_ELECTRON || require("electron"), [__filename, "--electron", f.root], { env, stdio: ["ignore", "inherit", "inherit"] });
    deadline = setTimeout(() => child.kill("SIGTERM"), NATIVE_INPUT ? 480000 : 150000);
    const exit = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); });
    await seen("ready");
    const raw = f.transport.hosts.get("codex"), lease = f.service.workRunCoordinator.runCapabilityLeases.get(producer.id);
    const scope = { runId: producer.id, assertCurrent: () => f.service.workRunCoordinator.hostCapabilityIssuer.assert(lease, { kind: "mcp", identity: { runId: producer.id } }) };
    const emit = text => raw.emit({ known: true, type: "text_delta", threadId: producer.runtimeSessionRef.sessionId, turnId: producer.runtimeTurnRef.turnId, itemId: `answer-${producer.id}`, delta: text });
    const publish = async (index) => {
      fs.writeFileSync(path.join(f.workspace, "card.html"), `<!doctype html><style>body{margin:0;padding:18px;font:16px system-ui;background:var(--background);color:var(--foreground)}button{padding:9px 18px;margin:8px}strong{display:block}</style><h2>交互方案 ${index}</h2><strong id="current"></strong><button id="selectB">选择 B</button><button id="selectC">选择 C</button><script>window.initCount=1;shoggothUi.ready().then(value=>{document.querySelector('#current').textContent=value.state.selected;window.ready=true});shoggothUi.onStateChange(value=>document.querySelector('#current').textContent=value.selected);shoggothUi.onThemeChange(value=>window.currentTheme=value);for(const choice of ['B','C'])document.querySelector('#select'+choice).onclick=()=>shoggothUi.setState({selected:choice});</script>`);
      return f.service.mcpProductToolController.handle("render_ui", { ...declaration(), title: `方案卡片 ${index}` }, { profileId: f.profile.id, callId: crypto.randomUUID() }, scope);
    };
    emit("前文验收标记\n"); const first = await publish(1); mark("first", { part: first.part });
    let op, queued, input, piRun;
    if (!READ_FLOW) {
    await seen("queued");
    const operations = f.service.chatUiStore.operationsForRecovery(); assert.equal(operations.length, 1);
    assert.deepEqual(operations[0].owner, { profileId: f.profile.id, transcriptSessionId: session.id, sessionKey: session.sessionKey });
    op = operations[0].operation; assert.equal(op.snapshot.selected, "B");
    queued = f.service.workRunCoordinator.getRun(op.receipt.runId); assert.equal(queued.status, "queued");
    input = f.service.transcriptStore.listEvents(f.profile.id, session.id).find(e => e.runId === queued.id && e.kind === "user");
    assert.equal(input.content.uiAction.userSelection.values.selected, "B"); mark("queue-verified", { runId: queued.id });
    await seen("cancel"); await waitFor(() => f.service.workRunCoordinator.getRun(queued.id)?.status === "canceled", "real ChatPage cancel did not reach Coordinator");
    assert.equal(f.service.workRunCoordinator.getRun(producer.id).status, "running", "canceling the queued UI task must preserve its producer"); scope.assertCurrent(); mark("cancel-verified");
    }
    await seen("first-saved"); emit("中段验收标记\n"); const second = await publish(2); emit("后文验收标记"); mark("second", { part: second.part });
    await seen("second-ready"); await f.complete(producer, "前文验收标记\n中段验收标记\n后文验收标记");
    // Legacy compatibility must read the complete native history and establish
    // its canonical source. A new local Transcript row alone is not native history.
    const producerThread = raw.threads.find(thread => thread.id === producer.runtimeSessionRef.sessionId);
    const producerTurn = producerThread.turns.find(turn => turn.id === producer.runtimeTurnRef.turnId);
    producerTurn.items.push({ type: "agentMessage", id: "legacy-live-ui-native", phase: "final_answer",
      text: "旧消息预览验收\n```html\n<!doctype html><h2>历史兼容卡片</h2><button id=legacySend>提供内容</button><script>window.initCount=1;document.querySelector('#legacySend').onclick=()=>sendPrompt('旧卡片的待提交内容');</script>\n```" });
    const legacy = { id: "legacy-live-ui-native" };
    const importedLegacy = f.service.transcriptStore.importHistoryItems({ profileId: f.profile.id, sessionId: session.id,
      items: [{ id: legacy.id, runId: producer.id, role: "assistant", type: "text", payload: { message: { id: legacy.id,
        role: "assistant", timestamp: Date.now(), content: [{ type: "text", text: producerTurn.items.at(-1).text }],
        shoggoth: { runId: producer.id, displayId: `native-run:${producer.id}`, nativeUiVersion: 1 },
        codex: { itemType: "agentMessage" } } }, createdAt: Date.now(), fragment: null }], runtimeRef: producer.runtimeSessionRef });
    assert.equal(importedLegacy.length, 1); assert.notEqual(importedLegacy[0].id, legacy.id);
    fs.writeFileSync(path.join(output, "grouped-legacy-canonical-source.json"), JSON.stringify({
      nativeMessageId: legacy.id, canonicalSourceEventId: importedLegacy[0].id, runId: producer.id,
      earlierSources: f.service.transcriptStore.listEvents(f.profile.id, session.id).filter(event => event.kind === "assistant")
        .map(event => ({ id: event.id, contextExcluded: event.contextExcluded, segmentId: event.content?.segmentId })),
    }, null, 2));
    mark("final", { legacyId: legacy.id, legacySourceEventId: importedLegacy[0].id, runCount: f.service.productStore.listWorkRuns().length });
    await seen("stable");
    if (!READ_FLOW) { await f.switch(session.sessionKey, "pi"); mark("switched"); await seen("pi-clicked");
    const all = f.service.chatUiStore.operationsForRecovery(); assert.equal(all.length, 2);
    const piRecord = all.find(value => value.operation.operationId !== op.operationId);
    assert.deepEqual(piRecord.owner, { profileId: f.profile.id, transcriptSessionId: session.id, sessionKey: session.sessionKey });
    const piOp = piRecord.operation;
    await waitFor(() => f.service.workRunCoordinator.getRun(piOp.receipt?.runId)?.status === "running", "UI task did not start after Runtime handoff");
    piRun = f.service.workRunCoordinator.getRun(piOp.receipt.runId); assert.equal(piRun.runtimeSessionRef.runtime, "pi");
    await f.complete(piRun, "Pi 运行时继续分析完成"); mark("pi-completed", { runCount: f.service.productStore.listWorkRuns().length });
    } else { mark("pi-completed", { readFlow: true }); }
    await seen("legacy"); const reloaded = await seen("reloaded");
    assert.equal(f.service.chatUiController.leases.has(reloaded.previousLeaseId), false, "previous document lease survived reload");
    assert.equal(f.service.productStore.listWorkRuns().length, READ_FLOW ? 1 : 3); mark("legacy-verified");
    if (READ_FLOW) {
      await seen("source-read-waiting");
      f.service.transcriptStore.setContextExcluded({ profileId: f.profile.id, sessionId: session.id, eventId: first.part.sourceEventId, contextExcluded: true });
      await waitFor(() => f.service.chatUiStore.revision({ profileId: f.profile.id, transcriptSessionId: session.id, sessionKey: session.sessionKey }, first.part.artifactId, 1).status === "revoked", "canonical source did not revoke UI");
      mark("source-revoked"); await seen("source-cleared");
    }
    const result = await seen("done"), naturalExit = await exit; assert.equal(naturalExit.code, 0, JSON.stringify(naturalExit));
    assert.equal(f.service.chatUiController.leases.size, 0, "closing the fixture left active UI leases");
    const state = f.service.chatUiStore.revision({ profileId: f.profile.id, transcriptSessionId: session.id, sessionKey: session.sessionKey }, second.part.artifactId, 1).state;
    assert.equal(state.selected, "B"); assert.equal(f.service.productStore.listWorkRuns().length, READ_FLOW ? 1 : 3);
    const all = f.service.chatUiStore.operationsForRecovery(); assert.equal(all.length, READ_FLOW ? 0 : 2);
    const evidence = { ...result, status: "passed", modelTransport: "controlled-Runtime", UI: "built-production-React-in-Electron", service: "real-Service-Backend-Gateway-MainIPC", mode: READ_FLOW ? "read-flow-SDK-state-no-UI-actions" : "trusted-native-action-flow", nativeInput: NATIVE_INPUT, canonicalUserInput: input?.id || null, queuedRun: queued?.id || null, handoffRun: piRun?.id || null, operations: all.length, totalRuns: f.service.productStore.listWorkRuns().length, confirmedState: state, naturalExit };
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(evidence, null, 2)); console.log("PASS real React/Electron native UI", JSON.stringify(evidence));
  } finally { clearTimeout(deadline); if (child?.exitCode === null) child.kill("SIGTERM"); await server?.close(); await proxy?.close(); await registry.stop(); await f.close(); }
}
async function electronMain() {
  const { app, BrowserWindow, WebContentsView, ipcMain, session, webContents } = require("electron");
  const { DesktopChatUiHost } = require("../app/desktop-chat-ui-host"), { registerDesktopChatUiIpc } = require("../app/desktop-chat-ui-ipc");
  const { ShoggothBackend } = require("../app/core/shoggoth-backend"), { BackendRegistry } = require("../app/core/backend-registry"), { createFederationHostServer } = require("../app/federation-host-server");
  const root = process.argv[process.argv.indexOf("--electron") + 1], options = JSON.parse(fs.readFileSync(markerPath(root, "options"), "utf8"));
  app.setPath("userData", path.join(root, "electron-data")); app.setPath("sessionData", path.join(root, "electron-session")); app.setName("Shoggoth Native UI Live React Fixture");
  ipcMain.on("openclaw:get-config", event => { event.returnValue = options.config; });
  const mark = (name, value = {}) => writeMarker(root, name, value);
  const seen = name => waitFor(() => fs.existsSync(markerPath(root, name)) && JSON.parse(fs.readFileSync(markerPath(root, name), "utf8")), name, NATIVE_INPUT ? 90000 : 30000);
  const registry = new BackendRegistry(); registry.register(new ShoggothBackend({ paths: options.paths, serviceEventPollMs: 30, getNativeChatUiConfig: () => ({ revision: 1, config: { nativeChatUiV1: true } }) }));
  let window, host, mainIpc, federation; const checks = [], nativeClicks = [], deadline = setTimeout(() => { mark("failed", { reason: "Electron deadline" }); app.exit(1); }, NATIVE_INPUT ? 470000 : 140000);
  const check = name => checks.push(name);
  try {
    await app.whenReady(); assert.equal((await registry.start()).get("shoggoth"), true);
    window = new BrowserWindow({ show: true, width: 1260, height: 1000, webPreferences: { preload: path.join(ROOT, "app/preload.js"), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    host = new DesktopChatUiHost({ WebContentsView, ipcMain, session, webContents });
    mainIpc = registerDesktopChatUiIpc({ ipcMain, getMainWindow: () => window, getUiOrigin: () => options.url, getRegistry: () => registry, host });
    federation = createFederationHostServer({ paths: options.paths, registry, verifyChatUiClick: value => mainIpc.verifyClick(value) }); await federation.start();
    window.webContents.on("console-message", (_event, level, message) => { if (level === 3) console.error("UI console:", message); });
    await window.loadURL(options.url);
    const seed = [{ key: options.key, agentId: options.profile.agentId, agentName: options.profile.name, backendId: "shoggoth", updatedAt: Date.now(), displayName: "原生交互界面验收", kind: "direct" }];
    await window.webContents.executeJavaScript(`localStorage.setItem('shoggoth.chat.sessions.v1',${JSON.stringify(JSON.stringify(seed))});localStorage.setItem('shoggoth.chat.lastActive.v1',${JSON.stringify(options.key)});localStorage.setItem('shoggoth.chat.immersive.v1','0');location.hash=${JSON.stringify("/chat?session=" + encodeURIComponent(options.key))};`); window.reload();
    const js = code => window.webContents.executeJavaScript(code);
    await waitFor(() => js("!!document.querySelector('.chat-thread')"), "real ChatPage did not mount", 25000); mark("ready");
    const cardSelector = part => `[data-native-ui-source="${part.sourceEventId}"]`;
    const click = async (contents, selector, text) => { app.focus({steal:true}); window.show(); window.focus(); contents.focus();
      const point = await contents.executeJavaScript(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>${text ? "e.textContent.trim()===" + JSON.stringify(text) : "true"});if(!e)throw Error('button missing');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
      if(READ_FLOW){await contents.executeJavaScript(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>${text ? "e.textContent.trim()===" + JSON.stringify(text) : "true"});e.click()})()`);return;}
      console.log("NATIVE_REACT_CLICK",JSON.stringify({selector,text,point}));
    };
    const mounted = async (part, previousMountId = null) => waitFor(async () => {
      const entry = [...mainIpc.entries.values()].find(e => !e.closed && e.mountId !== previousMountId && e.part.sourceEventId === part.sourceEventId);
      const view = entry && host.entries.get(entry.mountId); if (!view) return;
      const child = view.view.webContents.mainFrame.frames.find(f => f.url === "about:srcdoc");
      if (child && await child.executeJavaScript("window.ready===true")) return { entry, view, child };
    }, "real SDK card failed to mount");
    const frameClick = async (m, selector) => { if(READ_FLOW){if(selector==="#legacySend")await m.child.executeJavaScript("sendPrompt('旧卡片的待提交内容')");else await m.child.executeJavaScript(`shoggothUi.setState({selected:${JSON.stringify(selector==="#selectB" ? "B" : "C")}})`);return;} app.focus({steal:true}); window.show(); window.focus(); m.view.view.webContents.focus(); await delay(150); const point = await m.child.executeJavaScript(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`); const offset = await m.view.view.webContents.mainFrame.executeJavaScript("(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return{x:r.x,y:r.y}})()"); point.x+=offset.x; point.y+=offset.y; console.log("FRAME_CLICK", JSON.stringify({point,visible:m.view.visible,bounds:m.view.view.getBounds(),state:m.entry?.state,offset})); await m.child.executeJavaScript("window.pointerLog=[];document.addEventListener('click',event=>window.pointerLog.push({id:event.target.id,trusted:event.isTrusted}))"); console.log("NATIVE_FRAME_CLICK",JSON.stringify({selector,point})); await waitFor(() => m.child.executeJavaScript(`window.pointerLog.some(event => event.id === ${JSON.stringify(selector.slice(1))} && event.trusted === true)`), "real native frame click missing: " + selector); nativeClicks.push({ selector, trusted: true }); };
    const focusReturnEvidence = [];
    const verifyComposerFocusReturn = async (mode, active) => {
      const surface = mode === "ordinary" ? '.chat-conv[data-native-ui-surface]' : '[data-testid="immersive-chat"][data-native-ui-surface]';
      // Start from another DOM control so an already focused composer cannot
      // conceal a missing focus-return notification or the wrong surface.
      await js(`(()=>{const root=document.querySelector(${JSON.stringify(surface)}),composer=root?.querySelector('[data-chat-composer] textarea');if(!composer||composer.disabled||!composer.getClientRects().length)throw Error('visible composer missing');const sentinel=document.createElement('button');sentinel.dataset.nativeFocusSentinel='true';sentinel.style.cssText='position:fixed;left:0;top:0;width:1px;height:1px';document.body.append(sentinel);sentinel.focus();if(document.activeElement===composer)throw Error('focus reset failed');})()`);
      let escapeEvents = 0;
      const observeEscape = (_event, input) => { if (input.type === "keyDown" && input.key === "Escape" && !input.isComposing) escapeEvents++; };
      const contents = active.view.view.webContents;
      contents.on("before-input-event", observeEscape);
      try {
        app.focus({ steal: true }); window.focus(); contents.focus();
        contents.sendInputEvent({ type: "keyDown", keyCode: "ESC" });
        contents.sendInputEvent({ type: "keyUp", keyCode: "ESC" });
        await waitFor(() => escapeEvents > 0, "fixture Escape did not reach native host listener", 2000);
        await waitFor(() => js(`document.activeElement===document.querySelector(${JSON.stringify(surface)}).querySelector('[data-chat-composer] textarea')`), mode+" Escape did not focus the current surface composer");
        assert.equal(escapeEvents, 1, "Escape must pass through the real native host input listener");
        assert.equal(await active.child.executeJavaScript("window.initCount"), 1);
        focusReturnEvidence.push({ mode, input: "Electron-webContents.sendInputEvent", escapeEvents, viewId: contents.id, composer: "current-surface" });
        check(mode+"-host-Escape-focuses-current-surface-composer");
      } finally {
        console.log("FOCUS_RETURN_DIAGNOSTIC", JSON.stringify({ mode, escapeEvents, focus: await js(`(()=>{const e=document.activeElement,c=document.querySelector(${JSON.stringify(surface)})?.querySelector('[data-chat-composer] textarea');return{activeTag:e?.tagName,activeClass:e?.className,activeSurface:e?.closest('[data-native-ui-surface]')?.getAttribute('data-testid')||null,expectedClass:c?.className,currentComposer:e===c}})()`) }));
        contents.removeListener("before-input-event", observeEscape);
        await js("document.querySelector('[data-native-focus-sentinel]')?.remove();void 0;");
      }
    };
    const floatingClipEvidence = [];
    const verifyFloatingClip = async (mode, part, active) => {
      const selectors = mode === "ordinary"
        ? { root: ".chat-conv", thread: ".chat-thread", top: ".chat-topdock", bottom: ".chat-botdock" }
        : { root: '[data-testid="immersive-chat"]', thread: "[data-glass-clip]", top: '[class*="topleft"]', bottom: "[data-chat-composer]" };
      const setup = `window.nativeClipFixture=(()=>{const root=document.querySelector(${JSON.stringify(selectors.root)}),thread=root.querySelector(${JSON.stringify(selectors.thread)}),slot=root.querySelector(${JSON.stringify(cardSelector(part)+" .chat-ui-artifact__slot")}),top=root.querySelector(${JSON.stringify(selectors.top)}),bottom=root.querySelector(${JSON.stringify(selectors.bottom)});if(!thread||!slot||!top||!bottom)throw Error('floating controls missing');const spacer=document.createElement('div');spacer.style.height='1200px';thread.append(spacer);return {thread,slot,top,bottom,spacer,scroll:thread.scrollTop,padding:top.style.paddingBottom};})();void 0;`;
      await js(setup);
      const geometry = () => js("(()=>{const f=window.nativeClipFixture,r=e=>{const x=e.getBoundingClientRect();return{x:x.x,y:x.y,width:x.width,height:x.height,bottom:x.bottom}};return{slot:r(f.slot),top:r(f.top),bottom:r(f.bottom),thread:r(f.thread),action:r(f.slot.closest('.chat-ui-artifact').querySelector('.chat-ui-artifact__action button'))}})()");
      try {
        for (const edge of ["top", "bottom"]) {
          await js(`(()=>{const f=window.nativeClipFixture,s=f.slot.getBoundingClientRect();f.thread.scrollTop+=s.top-${edge === "top" ? "(f.top.getBoundingClientRect().bottom-72)" : "(f.bottom.getBoundingClientRect().top-130)"};f.thread.dispatchEvent(new Event('scroll'));})()`);
          await delay(250);
          const g = await geometry(), bounds = active.view.view.getBounds(), zoom = window.webContents.getZoomFactor();
          assert(active.view.visible && bounds.height > 0 && bounds.width > 0, mode+" "+edge+" must leave a visible card fragment");
          if(mode === "immersive") { assert(g.slot.x+g.slot.width <= g.thread.x+g.thread.width+2, "immersive content overflows its actual column: "+JSON.stringify(g)); assert(g.action.x+g.action.width <= g.thread.x+g.thread.width+2, "immersive continue control falls outside the visible column"); }
          assert(bounds.y >= g.top.bottom*zoom-2, mode+" native view covers floating identity: "+JSON.stringify({g,bounds}));
          assert(bounds.y+bounds.height <= g.bottom.y*zoom+2, mode+" native view covers composer: "+JSON.stringify({g,bounds}));
          assert.equal(await active.child.executeJavaScript("window.initCount"), 1);
          floatingClipEvidence.push({mode,edge,geometry:g,bounds,zoom,viewId:active.view.view.webContents.id});
          fs.writeFileSync(path.join(options.output, mode+"-clip-"+edge+".png"), (await window.capturePage()).toPNG());
        }
        await js("(()=>{const f=window.nativeClipFixture;f.top.style.paddingBottom='64px';const s=f.slot.getBoundingClientRect();f.thread.scrollTop+=s.top-(f.top.getBoundingClientRect().bottom-72);f.thread.dispatchEvent(new Event('scroll'));})()");
        await delay(250); const resized = await geometry(), resizeBounds = active.view.view.getBounds(), zoom = window.webContents.getZoomFactor();
        assert(active.view.visible && resizeBounds.height > 0); assert(resizeBounds.y >= resized.top.bottom*zoom-2, mode+" resized floating identity covers native view");
        floatingClipEvidence.push({mode,edge:"resized-top",geometry:resized,bounds:resizeBounds,zoom});
        check(mode+"-floating-identity-composer-and-resize-clip-without-remount");
      } finally {
        await js("(()=>{const f=window.nativeClipFixture;f.top.style.paddingBottom=f.padding;f.spacer.remove();f.thread.scrollTop=f.scroll;f.thread.dispatchEvent(new Event('scroll'));delete window.nativeClipFixture;})()"); await delay(150);
      }
    };
    const first = await seen("first"), firstCard = cardSelector(first.part); let active = await mounted(first.part);
    assert.notEqual(active.child.osProcessId, window.webContents.getOSProcessId()); await js(`document.querySelector(${JSON.stringify(firstCard)}).scrollIntoView({block:'center'})`); await delay(150); await frameClick(active, "#selectB");
    await waitFor(() => active.entry.localPatch.selected === "B" || active.entry.state.selected === "B", "local state change not visible").catch(async error=>{console.log("FRAME_DIAGNOSTIC",await active.child.executeJavaScript("({pointer:window.pointerLog,ready:window.ready,body:document.body.innerText,currentTheme:window.currentTheme,init:window.initCount})"));throw error;});
    if (!READ_FLOW) {
    await click(window.webContents, firstCard + " button", "继续分析"); await waitFor(() => js(`document.querySelector(${JSON.stringify(firstCard)}).innerText.includes('已排队')`), "queued receipt missing"); mark("queued"); await seen("queue-verified"); check("trusted-React-click-freezes-B-enters-busy-queue");
    await click(window.webContents, firstCard + " button", "取消这次操作"); mark("cancel"); await seen("cancel-verified"); check("existing-chat-abort-cancels-same-run");
    }
    await js(`document.querySelector(${JSON.stringify(firstCard)}).scrollIntoView({block:'center'})`); await delay(100); await frameClick(active, "#selectC");
    await waitFor(() => active.entry.state.selected === "C", "first card state not confirmed"); mark("first-saved");
    const second = await seen("second"), secondCard = cardSelector(second.part); active = await mounted(second.part); await js(`document.querySelector(${JSON.stringify(secondCard)}).scrollIntoView({block:'center'})`); await delay(150); await frameClick(active, "#selectB"); await waitFor(() => active.entry.state.selected === "B", "second card not confirmed");
    const viewId = active.view.view.webContents.id, mountId = active.entry.mountId; mark("second-ready"); await seen("final");
    await waitFor(() => js(`document.querySelector('.chat-thread')?.innerText.includes('后文验收标记')`), "final text missing"); await delay(600);
    const ordering = await js("(()=>{const t=document.querySelector('.chat-thread').innerText;return ['前文验收标记','方案卡片 1','中段验收标记','方案卡片 2','后文验收标记'].map(s=>t.indexOf(s))})()");
    assert(ordering.every((n,i) => n >= 0 && (!i || n > ordering[i-1])), JSON.stringify(ordering));
    assert.equal(host.entries.get(mountId)?.view.webContents.id, viewId); assert.equal(await active.child.executeJavaScript("window.initCount"), 1); check("live-final-text-card-order-and-stable-host");
    await js("document.documentElement.dataset.theme='dark';document.documentElement.classList.add('dark')"); await delay(150); assert.equal(await active.child.executeJavaScript("window.initCount"), 1); check("theme-keeps-active-document");
    await verifyFloatingClip("ordinary", second.part, active);
    await verifyComposerFocusReturn("ordinary", active);
    assert.equal(await js("document.querySelector('[data-testid=chat-immersive-enter]')?.hidden"), false, "enabled native capability must expose immersive entry");
    await click(window.webContents, "[data-testid=chat-immersive-enter]"); await waitFor(() => js("!!document.querySelector('[data-testid=immersive-chat]')?.getClientRects().length"), "immersive mode not mounted"); await delay(200);
    assert.equal(host.entries.get(mountId)?.view.webContents.id, viewId); assert.equal(active.entry.state.selected, "B"); assert.equal(await active.child.executeJavaScript("window.initCount"), 1);
    fs.writeFileSync(path.join(options.output, "immersive.png"), (await window.webContents.capturePage()).toPNG()); check("ordinary-immersive-share-host-state");
    await verifyFloatingClip("immersive", second.part, active);
    await verifyComposerFocusReturn("immersive", active);
    await js("(()=>{const b=[...document.querySelectorAll('button')].find(e=>/退出沉浸/.test(e.getAttribute('title')||e.getAttribute('aria-label')||''));if(!b)throw Error('immersive exit missing');b.click()})()"); await delay(200);
    mark("stable");
    if (!READ_FLOW) { await seen("switched"); await click(window.webContents, secondCard + " button", "继续分析"); await waitFor(() => active.entry.actions.size === 1, "new UI operation missing after handoff"); mark("pi-clicked"); }
    await seen("pi-completed"); if (!READ_FLOW) check("current-selected-Runtime-handoff-completes-once");
    // A deliberate document reload restores confirmed state and queries the
    // existing pending identity. It must never create another model operation.
    const previousMountId = active.entry.mountId, previousLeaseId = active.entry.leaseId;
    window.reload(); await waitFor(() => !mainIpc.entries.has(previousMountId) && !host.entries.has(previousMountId), "previous document mount not reclaimed on reload");
    await waitFor(() => js(`!!document.querySelector(${JSON.stringify(secondCard)})`), "history card not restored");
    active = await mounted(second.part, previousMountId); await waitFor(() => active.view.visible, "restored card did not become visible");
    assert.deepEqual([...mainIpc.entries.values()].map(entry => entry.part.sourceEventId), [second.part.sourceEventId],
      "older history cards must not displace the automatically restored current card");
    check("history-card-loads-automatically-without-activation-click");
    assert.equal(active.entry.state.selected, "B"); assert.equal(await active.child.executeJavaScript("document.querySelector('#current').textContent"), "B");
    mark("reloaded", { previousLeaseId }); check("reload-restores-confirmed-state-without-action-replay");
    await waitFor(() => js("!!document.querySelector('.chat-thread .chat-ui-legacy button')"), "legacy canonical message not projected");
    await js("(()=>{const t=document.querySelector('.chat-compose textarea,.chat-composer textarea,textarea.chat-input');if(!t)throw Error('composer missing');const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;setter.call(t,'用户已有草稿');t.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await click(window.webContents, ".chat-ui-legacy button", "预览历史界面");
    await waitFor(() => [...mainIpc.entries.values()].some(e => e.descriptor.legacy), "legacy host not mounted");
    const legacyEntry = [...mainIpc.entries.values()].find(e => e.descriptor.legacy);
    assert.equal(legacyEntry.part.sourceEventId, (await seen("final")).legacySourceEventId,
      "legacy preview used another chunk's source or the imported native id");
    check("grouped-later-legacy-text-uses-its-canonical-source");
    const legacyView = await waitFor(() => host.entries.get(legacyEntry.mountId), "legacy native host not mounted");
    const legacyChild = await waitFor(() => legacyView.view.webContents.mainFrame.frames.find(frame => frame.url === "about:srcdoc"), "legacy generated frame missing");
    await frameClick({ view: legacyView, child: legacyChild }, "#legacySend"); await waitFor(() => js("Array.from(document.querySelectorAll('.chat-ui-artifact__legacy-prompt pre')).some(element => element.textContent === '旧卡片的待提交内容')"), "legacy pending prompt was not actually displayed");
    assert.equal(await js("document.querySelector('.chat-compose textarea,.chat-composer textarea,textarea.chat-input').value"), "用户已有草稿"); mark("legacy"); await seen("legacy-verified"); check("legacy-sendPrompt-visible-pending-preserves-existing-draft-zero-runs");
    check("SDK-state-changes-and-generated-legacy-pending-do-not-run-Agent");
    // A previewed legacy entry stays in both surfaces. Choosing another card
    // must survive either handover without the old preview activating again.
    await click(window.webContents, secondCard + " button", "显示交互卡片");
    active = await mounted(second.part); const chosenMountId = active.entry.mountId,
      chosenViewId = active.view.view.webContents.id, chosenLeaseId = active.entry.leaseId;
    await waitFor(() => active.view.visible, "chosen native card is not visible after legacy preview");
    const legacyMounts = () => [...mainIpc.entries.values()].filter(entry => entry.descriptor.legacy).map(entry => entry.mountId);
    assert.deepEqual(legacyMounts(), [], "choosing native card did not release the legacy preview");
    await click(window.webContents, "[data-testid=chat-immersive-enter]");
    // Native input arrives asynchronously after the marker. Wait for the visible
    // surface before reading its card; a fixed delay can precede the real click.
    await waitFor(() => js(`!!document.querySelector('[data-testid="immersive-chat"] ${secondCard}')?.getClientRects().length`), "chosen native card did not enter the visible immersive surface"); await delay(250);
    await js(`document.querySelector('[data-testid="immersive-chat"] ${secondCard}').scrollIntoView({block:'center'})`); await delay(150);
    assert.equal(host.entries.get(chosenMountId)?.view.webContents.id, chosenViewId,
      "previewed legacy card replaced the chosen native document during immersive handover");
    assert.equal(mainIpc.entries.get(chosenMountId)?.leaseId, chosenLeaseId);
    assert.deepEqual(legacyMounts(), [], "legacy preview reactivated without another user preview");
    assert.equal(await active.child.executeJavaScript("window.initCount"), 1);
    assert.equal(active.entry.state.selected, "B"); assert(active.view.visible);
    await js("(()=>{const b=[...document.querySelectorAll('button')].find(e=>/退出沉浸/.test(e.getAttribute('title')||e.getAttribute('aria-label')||''));if(!b)throw Error('immersive exit missing');b.click()})()"); await delay(250);
    assert.equal(host.entries.get(chosenMountId)?.view.webContents.id, chosenViewId,
      "chosen native document changed on the return to ordinary mode");
    assert.equal(mainIpc.entries.get(chosenMountId)?.leaseId, chosenLeaseId);
    assert.deepEqual(legacyMounts(), []); assert.equal(await active.child.executeJavaScript("window.initCount"), 1);
    check("previewed-legacy-does-not-replace-chosen-native-document-on-mode-handover");
    if (READ_FLOW) {
      // Pause only the owned test renderer's digest, after all source chunks
      // arrive. Revocation must beat this late read without trusting UI timing.
      await js("window.sourceDigestOriginal=crypto.subtle.digest.bind(crypto.subtle);crypto.subtle.digest=(...args)=>new Promise(resolve=>{window.sourceDigestWaiting=true;window.sourceDigestRelease=()=>window.sourceDigestOriginal(...args).then(resolve)});void 0;");
      await click(window.webContents, firstCard + " button", "源码");
      await waitFor(() => js("window.sourceDigestWaiting===true"), "source read did not reach delayed verification"); mark("source-read-waiting");
      await seen("source-revoked");
      await waitFor(() => js(`document.querySelector(${JSON.stringify(firstCard)}).innerText.includes('卡片来源已失效')`), "source revocation did not reach actual React card");
      await js("window.sourceDigestRelease();crypto.subtle.digest=window.sourceDigestOriginal;void 0;"); await delay(100);
      assert.equal(await js(`!!document.querySelector(${JSON.stringify(firstCard + " .chat-ui-artifact__source")})`), false);
      assert.equal(await js(`document.querySelector(${JSON.stringify(firstCard)}).innerText.includes('方案卡片 1')`), false);
      assert.equal(await js(`Array.from(document.querySelectorAll(${JSON.stringify(firstCard + " button")})).some(e=>e.textContent==='导出 HTML')`), false);
      mark("source-cleared"); check("canonical-revocation-clears-source-and-metadata-despite-late-read");
    }
    fs.writeFileSync(path.join(options.output, "ordinary.png"), (await window.webContents.capturePage()).toPNG());
    assert.equal(nativeClicks.length, READ_FLOW ? 0 : 4);
    mark("done", { checks, nativeClicks, floatingClipEvidence, focusReturnEvidence, electron: process.versions.electron, architecture: process.arch, ordering, mainProcessId: window.webContents.getOSProcessId(), sandbox: window.webContents.getLastWebPreferences().sandbox });
  } catch (error) { if(window&&!window.isDestroyed())fs.writeFileSync(path.join(options.output,"failed.png"),(await window.webContents.capturePage()).toPNG()); mark("failed", { reason: error.message, stack: error.stack, checks }); throw error; }
  finally { clearTimeout(deadline); if (window && !window.isDestroyed()) window.destroy(); await mainIpc?.close(); await host?.closeAll(); await federation?.stop(); await registry.stop(); app.quit(); }
}
