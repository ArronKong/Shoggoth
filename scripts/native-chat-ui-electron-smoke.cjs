#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");

if (!process.versions.electron) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-native-ui-"));
  const output = path.resolve(process.argv.find(value => value.startsWith("--output-dir="))?.slice(13) || path.join(__dirname, "../.artifacts/native-chat-ui/electron"));
  try {
    fs.mkdirSync(output, { recursive: true }); const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const result = require("node:child_process").spawnSync(process.env.NATIVE_CHAT_UI_ELECTRON || require("electron"), [__filename, "--fixture", root, output, ...process.argv.filter(value=>value.startsWith("--visual-wait=")||value==="--native-input")], {
      env, stdio: "inherit", encoding: "utf8", timeout: 315_000, maxBuffer: 2 * 1024 * 1024 });
    if (result.stdout) process.stdout.write(result.stdout); if (result.stderr) process.stderr.write(result.stderr);
    assert.equal(result.status, 0, `Electron fixture failed: ${result.error || result.signal || result.stderr}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
} else {
  const { app, BrowserWindow, WebContentsView, ipcMain, session, webContents } = require("electron");
  const { DesktopChatUiHost, clippedLayout } = require("../app/desktop-chat-ui-host");
  const at = process.argv.indexOf("--fixture"), root = process.argv[at + 1], output = process.argv[at + 2];
  app.setPath("userData", path.join(root, "data")); app.setPath("sessionData", path.join(root, "sessions"));
  app.setName("Shoggoth isolated native UI fixture"); app.on("window-all-closed", () => {});
  const timeout = setTimeout(() => { console.error("Native UI fixture timed out"); app.exit(1); }, 305_000);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function waitFor(test, description, timeoutMs=8000) { const end = Date.now() + timeoutMs; while (Date.now() < end) { if (await test()) return; await delay(25); } throw new Error(description); }
  function serve(handler) { const server = http.createServer(handler); return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }))); }
  const passed = []; const check = (name, action) => { action(); passed.push(name); };
  app.whenReady().then(async () => {
    let owner, host, page, canary;
    const outgoing = [], calls = [], notifications = [], closed = [];
    try {
      canary = await serve((request, response) => { outgoing.push(request.url); response.end("DENIED"); });
      page = await serve((_request, response) => { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(`<!doctype html><meta charset="utf-8"><title>Shoggoth Native UI Admission Fixture</title><style>
        *{box-sizing:border-box}body{margin:0;background:#e9edf5;font:16px system-ui}header{height:70px;padding:20px;background:#263246;color:white}
        #chat{position:relative;height:470px;overflow:auto;padding:24px}#slot{height:320px;border:1px solid #96a4ba;margin-top:100px}
        #spacer{height:700px}footer{height:80px;padding:14px;background:#cbd5e5}input{width:600px;height:42px}
        #menu{display:none;position:fixed;inset:150px 100px;background:white;z-index:100}</style>
        <header>Native UI inline fixture · 主聊天</header><div id="chat"><div id="slot"></div><div id="spacer"></div></div>
        <footer><input id="composer" aria-label="消息"><button id="stop">停止</button></footer><div id="menu">宿主菜单</div>
        <script>window.stopped=0;document.querySelector('#stop').onclick=()=>window.stopped++;</script>`); });
      owner = new BrowserWindow({ width: 760, height: 660, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
      await owner.loadURL(page.url); owner.showInactive();
      const layout = async generation => ({ generation, ...(await owner.webContents.executeJavaScript(`(()=>{
        const rect=element=>{const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};
        return {rect:rect(document.querySelector('#slot')),clip:rect(document.querySelector('#chat'))};})()`)) });
      host = new DesktopChatUiHost({ WebContentsView, ipcMain, session, webContents, heartbeatMs: 100, heartbeatTimeoutMs: 1600 });
      const html = `<!doctype html><style>body{margin:0;padding:20px;background:#d9eee4}h2{margin:0}input{width:260px}</style>
        <h2>比较方案</h2><p>独立进程 · 原位交互</p><input id="parameter" value="原始值"><button id="change">选择 B</button>
        <script>(async()=>{window.initCount=(window.initCount||0)+1;const ready=await shoggothUi.ready();
        window.report={state:ready.state,parentBlocked:false,node:typeof require,desktop:typeof openclawDesktop,bridge:typeof nativeChatUiBridge};
        try{void parent.document.body;}catch{window.report.parentBlocked=true;}
        try{await fetch(${JSON.stringify(canary.url+'/fetch')});}catch{window.report.fetchBlocked=true;}
        const image=new Image();image.src=${JSON.stringify(canary.url+'/image')};
        window.report.popupBlocked=window.open(${JSON.stringify(canary.url+'/popup')})===null;
        document.querySelector('#change').onclick=()=>{shoggothUi.setState({selected:'B'});document.querySelector('#parameter').value='B';};
        window.initialized=true;})();</script>`;
      let state = { selected: "A" }, stateRevision = 0, pauseSave = null;
      const options = { ownerWindow: owner, mountId: "fixture-main", html, descriptor: { title: "比较方案" },
        onMessage: async value => {
          calls.push(value.type);
          if (value.type === "ready") return { bridgeApiVersion: 1, state, stateRevision, theme: "light", locale: "zh-CN" };
          if (value.type === "state.patch") { if (pauseSave) await pauseSave.promise; assert.equal(value.baseStateRevision, stateRevision); state = { ...state, ...value.patch }; return { state, stateRevision: ++stateRevision }; }
          return null;
        }, onClose: async () => closed.push("fixture-main"), onNotify: value => notifications.push(value) };
      const mounted = await host.mount(options), entry = host.entries.get("fixture-main");
      host.layout("fixture-main", await layout(1));
      const child = () => entry.view.webContents.mainFrame.frames.find(frame => frame.url === "about:srcdoc");
      await waitFor(async () => child() && await child().executeJavaScript("window.initialized===true"), "child failed to initialize");
      const childProcessId = child().processId, childOsProcessId = child().osProcessId;
      assert(childOsProcessId > 0);
      assert.notEqual(childOsProcessId, mounted.ownerProcessId);
      check("isolated-process-and-partition", () => {
        assert.notEqual(mounted.rendererProcessId, mounted.ownerProcessId); assert.equal(entry.view.webContents.session.isPersistent(), false);
        assert.equal(entry.view.webContents.getLastWebPreferences().sandbox, true); assert.equal(entry.view.webContents.getLastWebPreferences().contextIsolation, true);
      });
      const report = await child().executeJavaScript("window.report");
      check("opaque-child-no-host-or-node", () => { assert.equal(report.parentBlocked, true); for (const key of ["node", "desktop", "bridge"]) assert.equal(report[key], "undefined"); });
      check("network-and-popup-blocked", () => { assert.equal(report.fetchBlocked, true); assert.equal(report.popupBlocked, true); assert.deepEqual(outgoing, []); });
      app.focus({ steal: true }); owner.show(); owner.focus(); await delay(250); entry.view.webContents.focus();
      const pointer = await child().executeJavaScript("(()=>{const r=document.querySelector('#change').getBoundingClientRect();return {x:Math.round(r.x+5),y:Math.round(r.y+5)}})()");
      await child().executeJavaScript("window.pointerEvents=[];for(const type of ['mousedown','mouseup','click'])document.addEventListener(type,event=>window.pointerEvents.push({type,id:event.target.id,x:event.clientX,y:event.clientY,trusted:event.isTrusted}));");
      if(process.argv.includes("--native-input")) {
        console.log("NATIVE INPUT CHECKPOINT", JSON.stringify({title:owner.getTitle(),window:owner.getBounds(),view:entry.view.getBounds(),pointer}));
        await waitFor(()=>state.selected==="B","native pointer button was not clicked",180000);
      } else {
        entry.view.webContents.debugger.attach("1.3");
        await entry.view.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...pointer, button: "none" });
        await delay(100);
        await entry.view.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", ...pointer, button: "left", clickCount: 1 });
        await entry.view.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", ...pointer, button: "left", clickCount: 1 });
        entry.view.webContents.debugger.detach();
      }
      await delay(100);
      await delay(600);
      const pointerReport = await child().executeJavaScript("({events:window.pointerEvents,parameter:document.querySelector('#parameter').value,focus:document.hasFocus(),parentFocus:document.activeElement.id})");
      await waitFor(() => state.selected === "B", "state patch not acknowledged");
      assert((await child().executeJavaScript("window.pointerEvents")).some(event => event.type === "click" && event.id === "change" && event.trusted));
      assert.equal(pointerReport.focus, true, "input must focus the generated document");
      check("state-port-no-agent-actions", () => { assert.equal(stateRevision, 1); assert(!calls.includes("action")); });
      passed.push("native-pointer-hit-tests-card-controls");
      const wc = entry.view.webContents;
      wc.focus();
      await child().executeJavaScript("window.imeEvents=[];for(const type of ['compositionstart','compositionupdate','compositionend'])document.querySelector('#parameter').addEventListener(type,event=>window.imeEvents.push({type:event.type,data:event.data}));document.querySelector('#parameter').value='';document.querySelector('#parameter').focus();");
      wc.debugger.attach("1.3");
      await wc.debugger.sendCommand("Input.imeSetComposition", { text: "中文", selectionStart: 0, selectionEnd: 2 });
      await wc.debugger.sendCommand("Input.insertText", { text: "中文参数" });
      const ime = await child().executeJavaScript("({value:document.querySelector('#parameter').value,events:window.imeEvents})");
      assert.equal(ime.value, "中文参数");
      for (const type of ["compositionstart", "compositionupdate", "compositionend"]) assert(ime.events.some(event => event.type === type));
      passed.push("chromium-chinese-ime-composition-and-commit");
      await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      assert.equal(await child().executeJavaScript("document.activeElement.id"), "change");
      await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      wc.debugger.detach();
      await waitFor(() => notifications.some(value => value.type === "focus-return"), "Escape did not restore trusted host focus");
      passed.push("keyboard-tab-and-escape-return-host-focus");
      // A persisted acknowledgement must preserve edits queued after it.
      pauseSave = {};
      pauseSave.promise = new Promise(resolve => { pauseSave.release = resolve; });
      const stateBeforeLateSubscription = structuredClone(state);
      await child().executeJavaScript("window.savedStates=[];shoggothUi.onStateChange(value=>window.savedStates.push(value));window.saveOne=shoggothUi.setState({selected:'C'}).then(()=>window.saveOneDone=true);void 0;");
      const saveStart = calls.filter(type => type === "state.patch").length;
      await waitFor(() => calls.filter(type => type === "state.patch").length > saveStart, "deferred save did not start");
      await child().executeJavaScript("window.saveTwo=shoggothUi.setState({selected:'D'}).then(()=>window.saveTwoDone=true);void 0;");
      pauseSave.release(); pauseSave = null;
      await waitFor(async () => await child().executeJavaScript("window.saveOneDone&&window.saveTwoDone"), "serialized state saves did not finish");
      assert.equal(state.selected, "D");
      const savedStates = await child().executeJavaScript("window.savedStates");
      assert.deepEqual(savedStates[0], stateBeforeLateSubscription,
        "a listener registered after ready must immediately restore current parameters");
      assert(savedStates.slice(1).length > 0);
      assert(savedStates.slice(1).every(value => value.selected === "D"));
      passed.push("late-state-subscription-restores-current-parameters");
      passed.push("save-acknowledgement-retains-later-local-edits");
      const before = calls.length;
      await entry.view.webContents.executeJavaScript("window.postMessage({type:'shoggoth-ui-bootstrap'},'*')"); await delay(100);
      check("parent-cannot-spoof-child", () => assert.equal(calls.length, before));
      await owner.webContents.executeJavaScript("document.querySelector('#chat').scrollTop=210"); host.layout("fixture-main", await layout(2));
      await delay(100);
      const frameRect = await entry.view.webContents.executeJavaScript("({top:document.querySelector('iframe').style.top,width:document.querySelector('iframe').style.width})");
      const current = await layout(3), expected = clippedLayout(current.rect, current.clip, owner.webContents.getZoomFactor());
      check("partial-scroll-preserves-document-layout", () => { assert.deepEqual(entry.view.getBounds(), expected.bounds); assert.equal(frameRect.top, `-${expected.document.offsetY}px`); assert.equal(frameRect.width, `${current.rect.width}px`); });
      const originalPid = entry.view.webContents.getOSProcessId();
      for (let i = 0; i < 20; i++) { await owner.webContents.executeJavaScript(`document.querySelector('#chat').scrollTop=${160+i*2}`); host.layout("fixture-main", await layout(4+i)); }
      owner.webContents.setZoomFactor(1.25); host.layout("fixture-main", await layout(30));
      host.layout("fixture-main", { ...(await layout(31)), occluded: true });
      check("occlusion-hides-native-view", () => assert.equal(entry.visible, false));
      host.layout("fixture-main", await layout(32));
      host.update("fixture-main", { type: "theme", value: "dark" });
      check("layout-theme-and-zoom-do-not-remount", () => assert.equal(entry.view.webContents.getOSProcessId(), originalPid));
      assert.equal(await child().executeJavaScript("window.initCount"), 1); passed.push("single-initialization");
      await owner.webContents.executeJavaScript("document.querySelector('#chat').style.padding='8px 80px';document.querySelector('header').textContent='沉浸聊天';document.querySelector('#chat').scrollTop=170");
      host.layout("fixture-main", await layout(33));
      assert.equal(await child().executeJavaScript("window.initCount"), 1);
      assert.equal(state.selected, "D"); passed.push("ordinary-immersive-slot-relocation-retains-state");
      await owner.webContents.executeJavaScript("document.querySelector('#chat').style.padding='24px'");
      owner.webContents.setZoomFactor(1); await owner.webContents.executeJavaScript("document.querySelector('#chat').scrollTop=190"); host.layout("fixture-main", await layout(34));
      fs.writeFileSync(path.join(output, "inline-content.png"), (await entry.view.webContents.capturePage()).toPNG());
      fs.writeFileSync(path.join(output, "host-chat.png"), (await owner.capturePage()).toPNG());
      const visualWait=Number(process.argv.find(value=>value.startsWith("--visual-wait="))?.split("=")[1]||0);
      if(visualWait){console.log("VISUAL CHECKPOINT",JSON.stringify({mountId:options.mountId,windowTitle:owner.getTitle(),bounds:entry.view.getBounds()}));await delay(Math.min(20000,visualWait));}
      // The loop executes in the actual generated-document renderer. Do not
      // await its JavaScript completion; the trusted host must stop it.
      void child().executeJavaScript("while(true){}", true).catch(() => {});
      await delay(150);
      owner.webContents.focus(); await owner.webContents.executeJavaScript("document.querySelector('#composer').focus()");
      owner.webContents.insertText("中文输入仍可用");
      assert.equal(await owner.webContents.executeJavaScript("document.querySelector('#composer').value"), "中文输入仍可用");
      await owner.webContents.executeJavaScript("document.querySelector('#stop').click()");
      assert.equal(await owner.webContents.executeJavaScript("window.stopped"), 1); passed.push("deadloop-keeps-chat-input-and-stop-responsive");
      await waitFor(() => !host.entries.size, "hung renderer not reclaimed");
      await waitFor(() => !app.getAppMetrics().some(metric => metric.pid === childOsProcessId), "generated frame OS process not reclaimed");
      check("watchdog-terminates-only-interaction", () => { assert.equal(owner.webContents.getOSProcessId(), mounted.ownerProcessId); assert(!owner.isDestroyed()); assert(notifications.some(value => value.code === "UI_RENDERER_UNRESPONSIVE")); assert.equal(closed.length, 1); });
      await host.closeAll();
      const evidence = { electron: process.versions.electron, architecture: process.arch, mounted, childReport: report, childProcessId, childOsProcessId, inputMode:process.argv.includes("--native-input")?"native-macos":"chromium", ime, pointerReport,
        passed, outgoingRequests: outgoing, notifications, screenshotFiles: ["inline-content.png", "host-chat.png"] };
      fs.writeFileSync(path.join(output, "verification.json"), JSON.stringify(evidence, null, 2)+'\n');
      console.log(`PASS native UI Electron ${passed.length}/${passed.length}`, JSON.stringify({ architecture: process.arch, mounted, passed }));
    } finally {
      await host?.closeAll(); owner?.destroy();
      for (const value of [page, canary]) if (value) { value.server.closeAllConnections?.(); await new Promise(resolve => value.server.close(resolve)); }
      clearTimeout(timeout);
    }
  }).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
}
