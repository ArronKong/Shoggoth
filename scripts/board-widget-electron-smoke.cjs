#!/usr/bin/env electron
"use strict";

const assert = require("node:assert/strict");
const dgram = require("node:dgram");
const http = require("node:http");
const { app, BrowserWindow } = require("electron");
const { createBoardWidgetHost } = require("../app/board-widget-host");
const { createBoardWidgetNavigationGuard } = require("../app/board-widget-navigation");

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      resolve({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function listenUdp(onMessage) {
  const socket = dgram.createSocket("udp4");
  socket.on("message", onMessage);
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      socket.removeListener("error", reject);
      resolve({ socket, port: socket.address().port });
    });
  });
}

function closeUdp(socket) {
  return new Promise((resolve) => socket.close(resolve));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

app.whenReady().then(async () => {
  let sink;
  let udpSink;
  let ui;
  let host;
  let window;
  try {
    let sinkHits = 0;
    sink = await listen((_req, res) => {
      sinkHits += 1;
      res.writeHead(204).end();
    });
    let udpHits = 0;
    udpSink = await listenUdp(() => { udpHits += 1; });
    let page = "";
    ui = await listen((_req, res) => {
      const body = Buffer.from(page, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": body.length,
        "Cache-Control": "no-store",
      });
      res.end(body);
    });
    host = createBoardWidgetHost({ uiOrigin: ui.origin });
    await host.start();
    const viewGeneration = "0123456789abcdef0123456789abcdef";
    const attackUrl = `${sink.origin}/leak`;
    const html = Buffer.from(`<!doctype html><meta charset="utf-8">
<meta http-equiv="refresh" content=${JSON.stringify(`0;url=${attackUrl}?via=inner-meta-refresh`)}>
<a id="inner-link" href=${JSON.stringify(`${attackUrl}?via=inner-popup`)} target="_blank">inner</a>
<style>@import url(${JSON.stringify(`${attackUrl}?via=css`)});</style>
<img src=${JSON.stringify(`${attackUrl}?via=declarative-image`)}>
<iframe src=${JSON.stringify(`${attackUrl}?via=declarative-frame`)}></iframe>
<script>
setTimeout(() => {
  parent.postMessage({type:"height",height:333}, "*");
  try {
    const peer = new RTCPeerConnection({iceServers:[{urls:${JSON.stringify(`stun:127.0.0.1:${udpSink.port}`)}}]});
    peer.createDataChannel("blocked");
    peer.createOffer().then((offer) => peer.setLocalDescription(offer));
  } catch {}
  try { fetch(${JSON.stringify(`${attackUrl}?via=fetch`)}); } catch {}
  try { const image = new Image(); image.src = ${JSON.stringify(`${attackUrl}?via=image`)}; } catch {}
  try { new WebSocket(${JSON.stringify(attackUrl.replace("http:", "ws:") + "?via=ws")}); } catch {}
  try { new Worker(${JSON.stringify(`${attackUrl}?via=worker`)}); } catch {}
  try { const form=document.createElement("form"); form.action=${JSON.stringify(`${attackUrl}?via=form`)}; document.body.append(form); form.submit(); } catch {}
  try { const frame=document.createElement("iframe"); frame.src=${JSON.stringify(`${attackUrl}?via=frame`)}; document.body.append(frame); } catch {}
  try { window.open(${JSON.stringify(`${attackUrl}?via=popup`)}, "_blank"); } catch {}
  try { location.href=${JSON.stringify(`${attackUrl}?via=navigate`)}; } catch {}
}, 120);
</script>`, "utf8");
    const issued = host.issue({
      owner: 1,
      scope: "openclaw\0main\0agent:main:main",
      html,
      identity: {
        backend: "openclaw",
        agentId: "main",
        sessionKey: "agent:main:main",
        boardRevision: 7,
        viewGeneration,
        name: "electron-smoke",
        revision: 2,
        instanceId: viewGeneration,
      },
    });
    const normalExternalUrl = `${attackUrl}?via=normal-ui-link`;
    page = `<!doctype html><meta charset="utf-8"><a id="normal" href=${JSON.stringify(normalExternalUrl)} target="_blank" rel="noreferrer">normal</a><iframe id="board" sandbox="allow-scripts" allow="" referrerpolicy="origin"></iframe><script>
window.testState={head:null,ready:false,height:null};
const frame=document.getElementById("board");
window.addEventListener("message",(event)=>{
  const value=event.data;
  if(event.source!==frame.contentWindow||event.origin!=="null"||event.ports.length!==0||!value||value.type!=="shoggoth:board-widget-bootstrap"||value.nonce!==${JSON.stringify(issued.nonce)})return;
  const channel=new MessageChannel();
  channel.port1.onmessage=(portEvent)=>{
    if(portEvent.data?.type==="ready"&&portEvent.data.nonce===${JSON.stringify(issued.nonce)})window.testState.ready=true;
    if(portEvent.data?.type==="height")window.testState.height=portEvent.data.height;
  };
  channel.port1.start();
  frame.contentWindow.postMessage({type:"shoggoth:board-widget-connect",nonce:${JSON.stringify(issued.nonce)},theme:{mode:"light",tokens:{text:"#111"}}},"*",[channel.port2]);
},{once:true});
fetch(${JSON.stringify(issued.url)},{method:"HEAD",mode:"cors",cache:"no-store",credentials:"omit",referrerPolicy:"origin"})
  .then((response)=>{window.testState.head=response.status;if(response.ok)frame.src=${JSON.stringify(issued.url)};})
  .catch(()=>{window.testState.head=-1;});
</script>`;

    window = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    const guard = createBoardWidgetNavigationGuard();
    guard.allowTicket({
      ticket: issued.ticket,
      url: issued.url,
      ownerId: window.webContents.id,
      expiresAt: issued.expiresAt,
    });
    let blockedNavigations = 0;
    const popupRequests = [];
    window.webContents.on("will-frame-navigate", (details) => {
      const result = guard.handle(details, {
        ownerId: window.webContents.id,
        mainFrame: window.webContents.mainFrame,
      });
      if (!result.allowed) blockedNavigations += 1;
    });
    window.webContents.on("will-navigate", (details) => {
      if (guard.isBoardFrame(details.initiator)) details.preventDefault();
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      popupRequests.push(url);
      return { action: "deny" };
    });
    await window.loadURL(`${ui.origin}/chat`);

    const deadline = Date.now() + 5_000;
    let state = null;
    while (Date.now() < deadline) {
      state = await window.webContents.executeJavaScript("window.testState", true);
      if (state?.head === 200 && state?.ready) break;
      await delay(50);
    }
    if (state?.head !== 200 || !state?.ready) {
      console.error("board-widget-electron-smoke diagnostics", {
        state,
        host: host.stats(),
        blockedNavigations,
        mainUrl: window.webContents.getURL(),
      });
    }
    assert.equal(state?.head, 200, "a real Chromium CORS HEAD probe must pass the host's Fetch-Metadata gate");
    assert.equal(state?.ready, true, "outer shell must complete its nonce-bound MessagePort handshake");
    assert.equal(state?.height, null, "untrusted inner scripts must not execute");
    await window.webContents.executeJavaScript("document.getElementById('normal').click()");
    await delay(50);
    assert.deepEqual(popupRequests, [normalExternalUrl],
      "a normal noreferrer UI link must still reach Electron's external-link handler");
    const outerFrame = window.webContents.mainFrame.frames.find((frame) => frame.url === issued.url);
    assert.ok(outerFrame, "the ticket URL must be hosted in its own Electron frame");
    const innerFrame = outerFrame.frames.find((frame) => frame.url === "about:srcdoc");
    assert.ok(innerFrame, "the static HTML must stay in a nested opaque srcdoc frame");
    await innerFrame.executeJavaScript("document.getElementById('inner-link').click()")
      .catch(() => {});
    await delay(50);
    assert.deepEqual(popupRequests, [normalExternalUrl],
      "a static inner target=_blank link must not reach Electron's external-link handler");
    await outerFrame.executeJavaScript(`window.open(${JSON.stringify(`${attackUrl}?via=outer-popup`)}, "_blank")`)
      .catch(() => {});
    await delay(50);
    assert.deepEqual(popupRequests, [normalExternalUrl],
      "the Board outer sandbox must not reach Electron's external-link handler");
    await outerFrame.executeJavaScript(`location.href=${JSON.stringify(`${attackUrl}?via=outer-navigation`)}`)
      .catch(() => {});
    await delay(50);
    assert.ok(blockedNavigations >= 1, "Electron will-frame-navigate must block a Board outer-frame navigation");
    assert.equal(host.markReady({
      ticket: issued.ticket,
      nonce: issued.nonce,
      owner: 1,
      scope: "openclaw\0main\0agent:main:main",
    }), true);
    assert.equal(host.stats().bytes, 0, "ready must scrub the retained HTML buffer");
    await delay(800);
    assert.equal(sinkHits, 0, "CSP/sandbox/navigation guards must prevent every network escape attempt");
    assert.equal(udpHits, 0, "the static inner sandbox must prevent WebRTC UDP from bypassing CSP");
    assert.equal(window.webContents.getURL(), `${ui.origin}/chat`, "the Board subtree must not navigate the main frame");
    console.log("board-widget-electron-smoke: PASS");
  } finally {
    try { window?.destroy(); } catch {}
    try { await host?.close(); } catch {}
    try { if (ui) await close(ui.server); } catch {}
    try { if (sink) await close(sink.server); } catch {}
    try { if (udpSink) await closeUdp(udpSink.socket); } catch {}
    app.quit();
  }
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
