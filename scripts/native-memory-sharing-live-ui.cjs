"use strict";
// Current source-built management UI reads the real disposable Product Service
// through the production Backend/Registry/gateway. No history replies are mocked.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { startProxyGateway } = require("../app/core/proxy-gateway");
const { createWorkAdmissionGate } = require("../app/core/work-admission-gate");
const { DEFAULT_OPERATOR_SCOPES, generateIdentity } = require("../app/core/device-auth");
const { startStaticServer } = require("../app/static-server");
async function render({ service, paths, root, reader, session, expectedCode, electron, output }) {
  const backend = new ShoggothBackend({ paths, pollIntervalMs: 50, readinessIntervalMs: 25, readinessTimeoutMs: 5000 });
  const registry = new BackendRegistry(); registry.register(backend);
  let proxy, staticServer, child, timer;
  try {
    if ((await registry.start()).get(backend.id) !== true) throw Object.assign(new Error(), { code: "MEMORY_SHARING_LIVE_UI_BACKEND_FAILED" });
    backend._profilesByAgent.set(reader.agentId, reader); backend._upsertSession(reader, session);
    const key = `agent:${reader.agentId}:${session.sessionKey}`;
    const history = await backend.getHistory(key);
    if (!history.messages.length) throw Object.assign(new Error(), { code: "MEMORY_SHARING_LIVE_UI_HISTORY_MISSING" });
    proxy = await startProxyGateway({ port: 0, getUpstreamUrl: () => "", registry, workAdmissionGate: createWorkAdmissionGate() });
    const identity = generateIdentity();
    const config = { locale: "zh-CN", effectiveLocale: "zh-CN", setupCompletedAt: Date.now(), gatewayUrl: "", token: "", disabledBackends: ["openclaw", "hermes"] };
    staticServer = await startStaticServer(0, { registry, chatUpstreamUrl: proxy.url, chatOrigin: "http://127.0.0.1",
      homeDir: root, userDataRoot: path.join(root, "desktop-assets"), configStore: { read: () => config },
      authResolver: { resolveConnectAuth: () => ({ ...identity, token: "isolated-source-ui", scopes: DEFAULT_OPERATOR_SCOPES }), storeDeviceToken() {} } });
    const main = path.join(root, "electron-history-main.cjs"), evidence = path.join(root, "electron-history-result.json");
    const seed = [{ key, agentId: reader.agentId, agentName: reader.name, backendId: "shoggoth", updatedAt: Date.now(), displayName: "真实只读借阅验收", kind: "direct" }];
    const code = `const {app,BrowserWindow,ipcMain}=require("electron"),fs=require("node:fs"),crypto=require("node:crypto");
app.setPath("userData",${JSON.stringify(path.join(root, "electron"))});app.setPath("sessionData",${JSON.stringify(path.join(root, "electron-session"))});
ipcMain.on("openclaw:get-config",event=>{event.returnValue=${JSON.stringify(config)}});
const deadline=setTimeout(()=>app.exit(1),50000);
app.whenReady().then(async()=>{const window=new BrowserWindow({show:false,width:1220,height:940,webPreferences:{preload:${JSON.stringify(path.resolve(__dirname, "../app/preload.js"))},sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});let result;
try{await window.loadURL(${JSON.stringify(staticServer.url)});await window.webContents.executeJavaScript(${JSON.stringify(`localStorage.setItem("shoggoth.chat.sessions.v1",${JSON.stringify(JSON.stringify(seed))});localStorage.setItem("shoggoth.chat.lastActive.v1",${JSON.stringify(key)});localStorage.setItem("shoggoth.chat.immersive.v1","0");window.location.hash=${JSON.stringify("/chat?session=" + encodeURIComponent(key))};`)});await window.reload();
const until=Date.now()+25000;let snapshot;
while(Date.now()<until){snapshot=await window.webContents.executeJavaScript('({text:document.body.innerText,chat:!!document.querySelector(".chat-thread"),markdown:document.querySelectorAll(".chat-thread .markdown-body,.chat-thread .chat-markdown").length})');if(snapshot.chat&&snapshot.text.includes(${JSON.stringify(expectedCode)})&&snapshot.text.includes("已停止借阅"))break;await new Promise(resolve=>setTimeout(resolve,250));}
const passed=!!snapshot?.chat&&snapshot.text.includes(${JSON.stringify(expectedCode)})&&snapshot.text.includes("MEMORY.md")&&snapshot.text.includes("已停止借阅");
const image=await window.webContents.capturePage();fs.writeFileSync(${JSON.stringify(output)},image.toPNG(),{mode:0o600});
result={status:passed?"passed":"failed",historyContainsRealBorrowedAnswer:!!snapshot?.text.includes(${JSON.stringify(expectedCode)}),historyContainsSourceCitation:!!snapshot?.text.includes("MEMORY.md"),historyContainsRebuiltReply:!!snapshot?.text.includes("已停止借阅"),chatMounted:!!snapshot?.chat,sandbox:window.webContents.getLastWebPreferences().sandbox,screenshot:${JSON.stringify(output)},renderedTextHash:crypto.createHash("sha256").update(snapshot?.text||"").digest("hex")};
fs.writeFileSync(${JSON.stringify(evidence)},JSON.stringify(result),{mode:0o600});}
finally{window.destroy();clearTimeout(deadline);app.quit();}}).catch(()=>{clearTimeout(deadline);app.exit(1)});`;
    fs.writeFileSync(main, code, { mode: 0o600 });
    const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" }; delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(electron, [main], { cwd: root, env, stdio: ["ignore", "ignore", "ignore"] });
    timer = setTimeout(() => child.kill("SIGTERM"), 55000);
    const exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); });
    const result = fs.existsSync(evidence) ? JSON.parse(fs.readFileSync(evidence, "utf8")) : { status: "failed", errorCode: "MEMORY_SHARING_LIVE_UI_NO_RESULT" };
    return { ...result, naturalExit: exit, ui: "current-source-built-management-UI", history: "real-Service-through-production-Backend-gateway",
      historyMessageCount: history.messages.length, historyHash: crypto.createHash("sha256").update(JSON.stringify(history)).digest("hex"),
      assetsHash: crypto.createHash("sha256").update(fs.readFileSync(path.resolve(__dirname, "../app/manage-ui/dist/index.html"))).digest("hex") };
  } finally { clearTimeout(timer); if (child?.exitCode === null) child.kill("SIGTERM"); await staticServer?.close(); await proxy?.close(); await backend.stop(); }
}
module.exports = { render };
