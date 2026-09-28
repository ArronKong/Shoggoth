"use strict";

// Drive the built, unmodified ChatPage through the actual same-origin chat
// broker. Only the host, Service, HTTP server and Electron profile are fixtures.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { generateIdentity } = require("../app/core/device-auth");
const { startStaticServer } = require("../app/static-server");

const MARKER = "@@SHOGGOTH_CHAT_STOP@@";

function within(promise, label, timeoutMs = 20_000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

async function createChatPageStopDriver({ root, proxyUrl, registry, sessionKey,
  backendId, agentId, token }) {
  assert.ok(fs.existsSync(path.join(__dirname, "../app/manage-ui/dist/index.html")),
    "built management UI is required: run npm run build:manage");
  const identity = generateIdentity();
  const staticServer = await startStaticServer(0, {
    homeDir: root, userDataRoot: root, registry,
    chatUpstreamUrl: proxyUrl, chatOrigin: "http://127.0.0.1",
    authResolver: {
      resolveConnectAuth: () => ({ ...identity, token,
        scopes: ["operator.read", "operator.write"] }),
      storeDeviceToken() {},
    },
  });
  let child;
  try {
    const main = path.join(root, `chatpage-stop-${backendId}.cjs`);
    const seed = `(() => {
      const session={key:${JSON.stringify(sessionKey)},agentId:${JSON.stringify(agentId)},
        agentName:"Host stop fixture",backendId:${JSON.stringify(backendId)},
        model:"shoggoth-host-probe",updatedAt:Date.now()};
      localStorage.setItem("shoggoth.chat.sessions.v1",JSON.stringify([session]));
      localStorage.setItem("shoggoth.chat.lastActive.v1",session.key);
      localStorage.setItem("shoggoth.chat.immersive.v1","0");
      window.__shoggothStopTrace=[];
      const NativeWebSocket=window.WebSocket;
      let nextSocketId=0;
      window.WebSocket=class extends NativeWebSocket {
        constructor(url,protocols){super(url,protocols);this.fixtureSocketId=++nextSocketId;
          this.addEventListener('open',()=>window.__shoggothStopTrace.push({socketId:this.fixtureSocketId,
            event:'open',url:String(url)}));
          this.addEventListener('close',event=>window.__shoggothStopTrace.push({socketId:this.fixtureSocketId,
            event:'close',code:event.code,reason:event.reason}));
          this.addEventListener('message',event=>{try{const frame=JSON.parse(event.data);
            if(frame.event==='gateway.ready')window.__shoggothStopTrace.push({socketId:this.fixtureSocketId,
              event:'gateway.ready',degraded:frame.payload?.degraded===true})}catch{}})
        }
        send(value){
          try {const frame=JSON.parse(value);if(frame?.method==="chat.send"||frame?.method==="chat.abort")
            window.__shoggothStopTrace.push({socketId:this.fixtureSocketId,
              method:frame.method,sessionKey:frame.params?.sessionKey,
              runId:frame.params?.idempotencyKey||null});}catch{}
          return super.send(value)
        }
      };
      location.hash="/chat?session="+encodeURIComponent(session.key);
    })()`;
    fs.writeFileSync(main, `
const {app,BrowserWindow}=require("electron");
const readline=require("node:readline");
app.setPath("userData",${JSON.stringify(path.join(root, `electron-stop-${backendId}`))});
const marker=${JSON.stringify(MARKER)};
const emit=value=>process.stdout.write(marker+JSON.stringify(value)+"\\n");
const wait=async(predicate,label,timeout=18000)=>{
  const deadline=Date.now()+timeout;
  while(true){const value=await win.webContents.executeJavaScript(predicate,true);
    if(value)return value;
    if(Date.now()>deadline){const text=await win.webContents.executeJavaScript(
      'document.body.innerText.slice(0,1600)').catch(()=>"");
      const trace=await win.webContents.executeJavaScript(
        'JSON.stringify(window.__shoggothStopTrace||[])').catch(()=>"");
      throw Error(label+" timed out: "+text+"; websocket="+trace)}
    await new Promise(resolve=>setTimeout(resolve,50));
  }
};
let win;
app.whenReady().then(async()=>{
  try{
    win=new BrowserWindow({show:false,width:1000,height:900,
      webPreferences:{backgroundThrottling:false}});
    await win.loadURL(${JSON.stringify(`${staticServer.url}/#/plugins`)});
    await win.webContents.executeJavaScript(${JSON.stringify(seed)},true);
    await wait(${JSON.stringify('Boolean(document.querySelector(".chat-composer__input") && document.querySelector(".chat-send:not(.chat-stop)"))')},
      'actual ChatPage composer ready');
    emit({type:"ready"});
    const input=readline.createInterface({input:process.stdin});
    input.on("line",async line=>{
      let command;
      try{command=JSON.parse(line);
        if(command.action==="send"){
          await win.webContents.executeJavaScript(${JSON.stringify(`(() => {
            const area=document.querySelector('.chat-composer__input');
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set
              .call(area,'Shoggoth cancel probe');
            area.dispatchEvent(new Event('input',{bubbles:true}));
          })()`)},true);
          await wait(${JSON.stringify('Boolean(document.querySelector(".chat-send:not(.chat-stop)") && !document.querySelector(".chat-send:not(.chat-stop)").disabled)')},
            'composer send enabled');
          await win.webContents.executeJavaScript(
            'document.querySelector(".chat-send:not(.chat-stop)").click()',true);
          await wait(${JSON.stringify('Boolean(document.querySelector(".chat-stop") && window.__shoggothStopTrace.some(row=>row.method==="chat.send"))')},
            'actual ChatPage sent turn');
        }else if(command.action==="stop"){
          await win.webContents.executeJavaScript(
            'document.querySelector(".chat-stop").click()',true);
          await wait(${JSON.stringify('Boolean(window.__shoggothStopTrace.some(row=>row.method==="chat.abort") && !document.querySelector(".chat-stop"))')},'actual ChatPage stopped turn');
        }else throw Error('unknown action '+command.action);
        const trace=await win.webContents.executeJavaScript(
          'window.__shoggothStopTrace',true);
        emit({type:"result",id:command.id,trace});
      }catch(error){emit({type:"error",id:command?.id,message:String(error?.stack||error)})}
    });
  }catch(error){emit({type:"fatal",message:String(error?.stack||error)});app.exit(1)}
}).catch(error=>{emit({type:"fatal",message:String(error?.stack||error)});app.exit(1)});
`);
    const syntax = spawnSync(process.execPath, ["--check", main], { encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);
    child = spawn(require("electron"), [main], {
      cwd: root,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let buffered = "";
    let sequence = 0;
    let readyResolve; let readyReject;
    const ready = new Promise((resolve, reject) => {
      readyResolve = resolve; readyReject = reject;
    });
    const pending = new Map();
    const fail = error => {
      readyReject(error);
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
    };
    child.stdout.on("data", chunk => {
      const raw = chunk.toString(); output += raw; buffered += raw;
      while (buffered.includes("\n")) {
        const index = buffered.indexOf("\n");
        const line = buffered.slice(0, index); buffered = buffered.slice(index + 1);
        if (!line.startsWith(MARKER)) continue;
        let event;
        try { event = JSON.parse(line.slice(MARKER.length)); }
        catch { continue; }
        if (event.type === "ready") readyResolve();
        else if (event.type === "fatal") fail(new Error(event.message));
        else if (event.id && pending.has(event.id)) {
          const entry = pending.get(event.id); pending.delete(event.id);
          if (event.type === "result") entry.resolve(event.trace);
          else entry.reject(new Error(event.message));
        }
      }
    });
    child.stderr.on("data", chunk => { output += chunk.toString(); });
    child.once("error", fail);
    child.once("close", code => fail(new Error(`ChatPage fixture exited ${code}: ${output.slice(-2000)}`)));
    return {
      ready: within(ready, "ChatPage UI startup", 25_000).catch(error => {
        throw new Error(`${error.message}: ${output.slice(-2500)}`);
      }),
      async command(action) {
        const id = ++sequence;
        const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
        child.stdin.write(`${JSON.stringify({ id, action })}\n`);
        return within(response, `ChatPage ${action}`, 22_000);
      },
      async close() {
        if (child.exitCode === null) {
          child.kill("SIGTERM");
          try {
            await within(new Promise(resolve => child.once("close", resolve)),
              "ChatPage Electron shutdown", 2_000);
          } catch { child.kill("SIGKILL"); }
        }
        await staticServer.close();
      },
    };
  } catch (error) {
    if (child && child.exitCode === null) child.kill("SIGTERM");
    await staticServer.close();
    throw error;
  }
}

module.exports = { createChatPageStopDriver };
