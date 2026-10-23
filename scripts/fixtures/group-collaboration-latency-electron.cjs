"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { app, BrowserWindow, ipcMain, session, net } = require("electron");
const options = JSON.parse(fs.readFileSync(process.argv[2], "utf8")), root = options.root;
assert(root.startsWith("/private/tmp/sg-group-latency-") && fs.realpathSync(root) === root); assert.equal(fs.statSync(root).mode & 0o777, 0o700);
const { atomicWritePrivateFile } = require(path.join(options.sourceRoot, "app/agent-service/private-file"));
const { DesktopGroupSendJournalStore } = require(path.join(options.sourceRoot, "app/desktop-group-send-journal-store"));
const { registerDesktopGroupSendJournalIpc } = require(path.join(options.sourceRoot, "app/desktop-group-send-journal-ipc"));
for (const name of ["profile", "sessions", "meta"]) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
app.setPath("userData", path.join(root, "profile")); app.setPath("sessionData", path.join(root, "sessions")); app.on("window-all-closed", () => {});
const report = { completed: false, failedDetailReads: 0, forbiddenRequests: [], requests: [], actualPreload: true, actualUiEntry: false };
let window, store, ipc, poll, fault = false; const detailReads = new Set();
const save = (file, value) => atomicWritePrivateFile(path.join(root, file.includes("/") ? file : "meta/" + file), JSON.stringify(value), { trustedRoot: root });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = source => window.webContents.executeJavaScript(source, true);
async function until(read, label) { const end = Date.now() + 25000; while (Date.now() < end) { const value = await read(); if (value) return value; await delay(10); } throw Error(label); }
async function run() {
  await app.whenReady();
  ipcMain.on("openclaw:get-config", event => { event.returnValue = { locale: "zh-CN", effectiveLocale: "zh-CN", theme: "light" }; });
  await session.defaultSession.protocol.handle("http", request => {
    const url = new URL(request.url), origin = new URL(options.url).origin;
    if (url.origin === origin && url.pathname === "/") return new Response('<div id="root"></div>', { headers: { "Content-Type": "text/html" } });
    if (url.origin === origin && ["/__fixture/fixture.js", "/__fixture/fixture.css"].includes(url.pathname)) return new Response(fs.readFileSync(path.join(root, path.basename(url.pathname))), { headers: { "Content-Type": url.pathname.endsWith(".js") ? "text/javascript" : "text/css" } });
    return net.fetch(request, { bypassCustomProtocolHandlers: true });
  });
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    if (["http:", "https:", "ws:", "wss:"].includes(url.protocol) && url.origin !== new URL(options.url).origin && url.origin !== new URL(options.url).origin.replace("http:", "ws:")) { report.forbiddenRequests.push({ origin: url.origin, pathname: url.pathname }); return callback({ cancel: true }); }
    if (fault && url.pathname === "/__api/group-chats/detail" && details.webContentsId === window?.webContents.id) { fault = false; report.failedDetailReads++; return callback({ cancel: true }); }
    if (url.pathname === "/__api/group-chats/detail" && details.webContentsId === window?.webContents.id) detailReads.add(details.id);
    callback({ cancel: false });
  });
  session.defaultSession.webRequest.onCompleted(details => { detailReads.delete(details.id); if (details.url.includes("/__api/")) report.requests.push({ method: details.method, path: new URL(details.url).pathname, status: details.statusCode }); });
  session.defaultSession.webRequest.onErrorOccurred(details => detailReads.delete(details.id));
  store = new DesktopGroupSendJournalStore({ userDataRoot: app.getPath("userData") }); await store.open();
  const detail = async groupId => { const r = await fetch(options.url + "/__api/group-chats/detail?id=" + encodeURIComponent(groupId)); if (!r.ok) throw Error("authority unavailable"); return r.json(); };
  ipc = registerDesktopGroupSendJournalIpc({ ipcMain, getMainWindow: () => window, getUiOrigin: () => options.url, getStore: () => store,
    getAuthorityScope: async ({ groupId }) => (await detail(groupId)).ownerScope,
    lookupSend: async input => { const q = new URLSearchParams(input); return (await fetch(options.url + "/__api/group-chats/messages/lookup?id=" + encodeURIComponent(input.groupId) + "&" + q)).json(); } });
  window = new BrowserWindow({ show: true, width: 1200, height: 850, title: "Shoggoth · isolated collaboration timing", webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(options.sourceRoot, "app/preload.js") } });
  const windowState = event => ({ event, at: Date.now(), visible: window.isVisible() && !window.isMinimized(), focused: window.isFocused() });
  report.windowTimeline = [windowState("created")];
  for (const event of ["show", "hide", "minimize", "restore", "focus", "blur"]) window.on(event, () => report.windowTimeline.push(windowState(event)));
  window.webContents.on("console-message", (_event, _level, message) => console.log(message));
  await window.loadURL(options.url); window.show(); window.focus(); app.focus({ steal: true });
  await js(`window.fixtureOptions=${JSON.stringify({ groupId: options.groupId })};(()=>{const s=document.createElement('script');s.type='module';s.src='/__fixture/fixture.js';document.head.append(s)})()`);
  await until(async () => { try { const state = await js("window.fixtureState?window.fixtureState():{loaded:false}"); save("diagnostic.json", state); if (state.errors?.length) throw Error(state.errors.join("\n")); return state.ready&&state.wsOpened&&state.activities===1; } catch (error) { if (error.message !== "window.fixtureState is not a function") console.error(error.message); return false; } }, "production Panel and broker mounted");
  report.preferences = window.webContents.getLastWebPreferences(); assert.equal(report.preferences.sandbox, true); assert.equal(report.preferences.contextIsolation, true); assert.equal(report.preferences.nodeIntegration, false);
  save("ready.json", { ready: true });
  const handling = new Set(), processed = new Set();
  poll = setInterval(() => {
    for (const file of fs.readdirSync(path.join(root, "main-control")).filter(name => name.endsWith(".request.json"))) {
      if (handling.has(file) || processed.has(file)) continue; handling.add(file);
      void (async () => {
        const requestPath = path.join(root, "main-control", file); let request;
        try { request = JSON.parse(fs.readFileSync(requestPath, "utf8")); let result;
          if (request.action === "state") result = { ...await js("window.fixtureState()"), failedDetailReads: report.failedDetailReads, windowVisible: window.isVisible() && !window.isMinimized(), windowFocused: window.isFocused() };
          else if (request.action === "focus") { window.show(); window.focus(); app.focus({ steal: true }); await until(async () => await js("document.visibilityState==='visible'&&document.hasFocus()"), "foreground before wire facts"); result = { visible: true, focused: true }; }
          else if (request.action === "wait-marker") { result = await js(`window.waitFixtureMarker(${JSON.stringify(request.params.marker)})`); const state = [...report.windowTimeline].reverse().find(state => state.at <= result.renderedAt); result.windowVisible = state?.visible === true; result.windowFocused = state?.focused ?? null; }
          else if (request.action === "arm-fault") {
            assert.equal(fault, false);
            assert(window.isVisible() && !window.isMinimized());
            await until(async () => await js("document.visibilityState==='visible'"), "visible foreground panel before fault injection");
            // The focus handler has its own legitimate read. Observe its network
            // completion before arming the next notification's controlled fault.
            await js("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))");
            await until(() => detailReads.size === 0, "focus detail read settled");
            fault = true; result = { failedDetailReads: report.failedDetailReads };
          }
          else if (request.action === "capture") { fs.writeFileSync(path.join(options.output, "foreground-latest.png"), (await window.webContents.capturePage()).toPNG()); result = { captured: true }; }
          else if (request.action === "quit") { report.completed = true; result = { naturalQuitRequested: true }; }
          else throw Error("invalid fixture action");
          save(`main-control/${request.id}.response.json`, { result });
          if (request.action === "quit") { clearInterval(poll); ipc.dispose(); await store.close(); save("final.json", report); window.destroy(); app.quit(); }
        } catch (error) { if (request) save(`main-control/${request.id}.response.json`, { error: error.stack }); else throw error; }
        finally { handling.delete(file); processed.add(file); }
      })().catch(error => { console.error(error); app.exit(1); });
    }
  }, 10);
}
process.on("unhandledRejection", error => { console.error(error); app.exit(1); });
run().catch(error => { console.error(error); app.exit(1); });
