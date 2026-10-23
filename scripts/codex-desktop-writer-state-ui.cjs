"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),Module=require("node:module"),{spawn}=require("node:child_process");
const {fixture}=require("./codex-desktop-session-service-fixture.cjs");
const {BackendRegistry}=require("../app/core/backend-registry");
const {startProxyGateway}=require("../app/core/proxy-gateway");
const {createAuthResolver}=require("../app/core/device-auth");
const repo=path.resolve(__dirname,"..");
const output=path.resolve(process.env.SHOGGOTH_WRITER_UI_OUTPUT || path.join(repo,".artifacts/codex-desktop-writer-state-ui"));
const uiDist=path.resolve(process.env.SHOGGOTH_WRITER_UI_DIST || path.join(repo,"app/manage-ui/dist"));

async function browserMain(){
 const {app,BrowserWindow}=require("electron"),fs=require("node:fs");const options=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));app.setPath("userData",options.profile);await app.whenReady();
 const w=new BrowserWindow({show:false,width:1120,height:920,webPreferences:{backgroundThrottling:false,contextIsolation:false}}),js=code=>w.webContents.executeJavaScript(code,true);
 const wait=async(code,label)=>{const deadline=Date.now()+25000;while(Date.now()<deadline){if(await js(code))return;await new Promise(r=>setTimeout(r,50));}throw Error(label+" timed out");};
 const mode=async state=>{process.send({state});await new Promise(resolve=>process.once("message",resolve));};
 try{
  await w.loadURL(options.url);await wait("document.body.innerText.includes('已记住桌面对话的上下文')","native history");
  await wait("document.querySelector('textarea.chat-composer__input')?.placeholder.includes('Codex Desktop 占用中')","busy placeholder");
  await js("(()=>{const e=document.querySelector('textarea.chat-composer__input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'占用期间保留的草稿');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await wait("document.getElementById('chat-codex-writer-status')?.textContent.includes('Codex Desktop 占用中') && document.querySelector('button[data-send-entry=\"composerButton\"]')?.disabled","busy send gate and draft hint");
  await js("document.querySelector('button.chat-session-select').click()");await wait("document.querySelector('.session-menu__writer-state')?.textContent.includes('Codex Desktop 占用中')","session picker badge");
  await js("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");fs.writeFileSync(options.busyScreenshot,(await w.webContents.capturePage()).toPNG());
  await js("document.querySelector('button.chat-session-select').click()");
  await mode("unknown");await wait("document.getElementById('chat-codex-writer-status')?.textContent.includes('占用状态暂不可用')","unknown status while preserving draft");
  if(!await js("document.querySelector('textarea.chat-composer__input').value==='占用期间保留的草稿'"))throw Error("draft was overwritten");
  await js("(()=>{const e=document.querySelector('textarea.chat-composer__input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await wait("document.querySelector('textarea.chat-composer__input')?.value==='' && document.querySelector('textarea.chat-composer__input')?.placeholder.includes('占用状态暂不可用') && document.getElementById('chat-codex-writer-status')?.classList.contains('is-empty')","unknown placeholder in empty input");
  await js("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");fs.writeFileSync(options.unknownScreenshot,(await w.webContents.capturePage()).toPNG());
  await js("Array.from(document.querySelectorAll('button')).find(b=>b.title.includes('沉浸'))?.click()");
  await wait("document.querySelector('[data-chat-composer] textarea')?.placeholder.includes('占用状态暂不可用')","immersive unknown placeholder");
  await js("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");fs.writeFileSync(options.immersiveScreenshot,(await w.webContents.capturePage()).toPNG());
  await mode("busy");await wait("document.querySelector('[data-chat-composer] textarea')?.placeholder.includes('Codex Desktop 占用中')","immersive busy placeholder");
  await mode("available");await wait("document.querySelector('[data-chat-composer] textarea') && !document.querySelector('[data-chat-composer] textarea').placeholder.includes('占用')","release clears occupancy hint");
  console.log(JSON.stringify({verified:true,busyShownBeforeSend:true,unknownShownInInput:true,draftPreserved:true,sessionPickerBadge:true,busySendDisabled:true,immersiveVerified:true,releasedHintCleared:true,modelTurnsSent:0}));
 }finally{w.destroy();app.quit();}
}

(async()=>{
 assert.ok(fs.existsSync(path.join(uiDist,"index.html")),"Build the management UI with npm run build:manage before this regression.");
 fs.mkdirSync(output,{recursive:true});
 const f=await fixture();let server,proxy,child;
 try{
  let state="busy";f.service.codexDesktopSessionController.writerObserver={observe:async(_home,ids)=>new Map(ids.map(id=>[id,{state,owner:state==="busy"?"codex-desktop":null,checkedAt:Date.now()}]))};await f.backend._refreshCodexDesktopSessions();
  const row=f.backend.getSessionRows().find(r=>r.label==="桌面对话：保留原上下文");assert.equal(row.codexDesktopWriter.owner,"codex-desktop");
  const entry=f.backend._codexDesktopEntries.get(row.sessionId);const listed=await f.ipc("codex.desktop.sessions.list",{backendId:"shoggoth",cursor:null,limit:100});assert.equal(listed.sessions.find(item=>item.threadId===entry.threadId).session.codexDesktopWriter.state,"busy");
  const registry=new BackendRegistry();registry.register(f.backend);await registry.start();proxy=await startProxyGateway({port:0,getUpstreamUrl:()=>"",registry});
  const authResolver=createAuthResolver({getConfig:()=>({gatewayUrl:proxy.url,token:""}),credentialsDir:path.join(f.root,"browser-credentials"),operatorIdentityDir:path.join(f.root,"browser-operator")});
  const staticFile=path.join(repo,"app/static-server.js"),compiled=new Module(staticFile,module);compiled.filename=staticFile;compiled.paths=Module._nodeModulePaths(path.dirname(staticFile));
  const source=fs.readFileSync(staticFile,"utf8"),anchor='const MANAGE_DIR = path.join(__dirname, "manage-ui", "dist");';assert.equal(source.split(anchor).length-1,1);compiled._compile(source.replace(anchor,"const MANAGE_DIR = "+JSON.stringify(uiDist)+";"),staticFile);
  server=await compiled.exports.startStaticServer(0,{registry,homeDir:f.root,userDataRoot:f.root,chatUpstreamUrl:proxy.url,chatOrigin:"http://127.0.0.1",authResolver});
  const main=path.join(f.root,"writer-ui-main.cjs"),options=path.join(f.root,"writer-ui-options.json");fs.writeFileSync(main,"("+browserMain.toString()+")().catch(e=>{console.error(e);require('electron').app.exit(1)});");fs.writeFileSync(options,JSON.stringify({url:server.url+"/#/chat?backend=shoggoth&session="+encodeURIComponent(row.key),profile:path.join(f.root,"browser-profile"),busyScreenshot:path.join(output,"writer-busy.png"),unknownScreenshot:path.join(output,"writer-unknown.png"),immersiveScreenshot:path.join(output,"writer-unknown-immersive.png")}));
  child=spawn(require("electron"),[main,options],{env:{...process.env,ELECTRON_DISABLE_SECURITY_WARNINGS:"true"},stdio:["ignore","pipe","pipe","ipc"]});child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
  child.on("message",async message=>{if(!["busy","unknown","available"].includes(message?.state))return;state=message.state;await f.backend._refreshCodexDesktopSessions();child.send({updated:true});});
  const timeout=setTimeout(()=>child.kill("SIGTERM"),100000);const status=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",resolve);});clearTimeout(timeout);assert.equal(status,0,"UI regression must exit naturally");assert.equal(f.host.turnStarts,0);assert.equal(f.host.threadStarts,0);
  fs.writeFileSync(path.join(output,"ui-verification.json"),JSON.stringify({verified:true,busyShownBeforeSend:true,unknownShownInInput:true,draftPreserved:true,sessionPickerBadge:true,busySendDisabled:true,immersiveVerified:true,releasedHintCleared:true,naturalExit:true,modelTurnsSent:0,originalHomeWrites:0},null,2)+"\n");
 }finally{if(server)await server.close();if(proxy)await proxy.close();await f.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
