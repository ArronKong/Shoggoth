"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { startStaticServer } = require("../app/static-server");

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join("/private/tmp", "sgap-")));
  const paths = resolveServicePaths({ userDataRoot: path.join(root, "u"),
    cacheRoot: path.join(root, "c"), trustedRoot: root });
  let service = null;
  let server = null;
  let child = null;
  try {
    service = createAgentService({ paths, prewarmMcpAuth: false,
      externalPluginAgentVerifier: async row => ({ id: row.agentId, backendId: row.backendId }),
      version: "plugin-external-approval-page-fixture" });
    await service.start();
    const broker = service.externalPluginApprovalBroker;
    const credential = Buffer.alloc(32, 7).toString("base64url");
    const openclaw = { backendId: "openclaw", instanceId: crypto.randomUUID(),
      agentId: "fixture-openclaw", sessionId: "fixture-openclaw-session",
      runId: "fixture-openclaw-run", toolCallId: "fixture-openclaw-call" };
    const hermes = { backendId: "hermes", instanceId: crypto.randomUUID(),
      agentId: "fixture-hermes", sessionId: "fixture-hermes-session",
      taskId: "fixture-hermes-task", turnId: "fixture-hermes-turn",
      toolCallId: "fixture-hermes-call" };
    const request = (identity, toolName, args) => {
      const pending = broker.request({ token: credential, identity,
        callId: `external-fixture-${toolName}`, bindingId: "fixture-binding",
        connectionId: "fixture-connection", connectionAuthRevision: 1,
        packageName: "Fixture package", toolName, arguments: args,
        signal: new AbortController().signal, assertCurrent() {} });
      pending.catch(() => {});
      return pending;
    };
    const accepted = request(openclaw, "write-allow", { text: "approved fixture" });
    const denied = request(hermes, "write-deny", { text: "denied fixture" });
    let nativeConfirmations = 0;
    server = await startStaticServer(0, { homeDir: root, userDataRoot: root,
      registry: { backends: new Map([["shoggoth", new ShoggothBackend({ paths })]]) },
      hostOps: { confirmPluginCapability: async summary => {
        nativeConfirmations += 1;
        assert.equal(summary.action, "external-plugin-call");
        assert.equal(summary.backendId, "openclaw");
        assert.equal(summary.toolName, "write-allow");
        assert.deepEqual(JSON.parse(summary.command), { text: "approved fixture" });
        return true;
      } } });
    const electronMain = path.join(root, "electron-main.cjs");
    const waitForCount = count => `new Promise((resolve,reject)=>{
      const until=Date.now()+12000;const timer=setInterval(()=>{
        if(document.querySelectorAll('#plugins-external-approvals li').length===${count}){
          clearInterval(timer);resolve(true)}
        else if(Date.now()>until){clearInterval(timer);
          reject(Error('approval rows did not reach ${count}: '+document.body.innerText.slice(0,1000)))}
      },40)})`;
    const initialScript = `({
      selected:document.querySelector('[role=tab][aria-selected=true]')?.textContent,
      text:document.querySelector('#plugins-external-approvals')?.innerText})`;
    const clickScript = (toolName, selector) => `{
      const row=[...document.querySelectorAll('#plugins-external-approvals li')]
        .find(item=>item.textContent.includes(${JSON.stringify(toolName)}));
      if(!row)throw Error('approval row missing');
      const selected=row.querySelector(${JSON.stringify(selector)});
      if(!selected)throw Error('approval button missing');selected.click()}`;
    fs.writeFileSync(electronMain, `
const {app, BrowserWindow}=require("electron");
const fs=require("node:fs");
app.setPath("userData", ${JSON.stringify(path.join(root, "electron-profile"))});
app.whenReady().then(async()=>{
  const w=new BrowserWindow({show:false,width:900,height:900,
    webPreferences:{backgroundThrottling:false}});
  try{
    await w.loadURL(${JSON.stringify(`${server.url}/#/plugins?focus=approvals`)});
    await w.webContents.executeJavaScript(${JSON.stringify(waitForCount(2))},true);
    const initial=await w.webContents.executeJavaScript(${JSON.stringify(initialScript)},true);
    if(!initial.text?.includes('write-allow')||!initial.text?.includes('write-deny'))
      throw Error('both pending calls missing: '+JSON.stringify(initial));
    fs.writeFileSync(${JSON.stringify(path.join(root, "approval-page.png"))},
      (await w.webContents.capturePage()).toPNG());
    await w.webContents.executeJavaScript(${JSON.stringify(clickScript("write-allow", "button.btn-primary"))},true);
    await w.webContents.executeJavaScript(${JSON.stringify(waitForCount(1))},true);
    await w.webContents.executeJavaScript(${JSON.stringify(clickScript("write-deny", "button.btn-secondary"))},true);
    await w.webContents.executeJavaScript(${JSON.stringify(waitForCount(0))},true);
    process.stdout.write(JSON.stringify({rendered:true,allowClicked:true,denyClicked:true})+'\\n');
    app.exit(0);
  }catch(error){console.error(error);console.error(await w.webContents.executeJavaScript(
    'document.body.innerText.slice(0,2400)').catch(()=>''));app.exit(1)}
}).catch(error=>{console.error(error);app.exit(1)});
`);
    const electron = require("electron");
    child = spawn(electron, [electronMain], { cwd: root,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
      stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    let deadline;
    const exit = await Promise.race([
      new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", code => resolve(code));
      }),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(Error("approval page fixture timed out")), 35_000); }),
    ]).finally(() => clearTimeout(deadline));
    assert.equal(exit, 0, output);
    assert.match(output, /"allowClicked":true/u);
    assert.match(output, /"denyClicked":true/u);
    assert.equal((await accepted).approved, true);
    assert.equal((await denied).approved, false);
    assert.equal(nativeConfirmations, 1);
    assert.deepEqual(broker.list(), { items: [], nextCursor: null });
    console.log("plugin-external-approval-page-service-fixture: actual PluginsPage -> REST -> Backend -> Service broker allow/deny passed");
  } finally {
    if (child && child.exitCode === null) child.kill("SIGTERM");
    if (server) await server.close();
    if (service) await service.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
