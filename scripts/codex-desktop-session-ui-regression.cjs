"use strict";
// Built production UI and real Service; only the native model is simulated.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { fixture, turn } = require("./codex-desktop-session-service-fixture.cjs");
const { BackendRegistry } = require("../app/core/backend-registry");
const { startStaticServer } = require("../app/static-server");
const { startProxyGateway } = require("../app/core/proxy-gateway");
const { createAuthResolver } = require("../app/core/device-auth");

async function browserMain() {
  const { app, BrowserWindow } = require("electron"), fs = require("node:fs");
  const options = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  app.setPath("userData", options.profile);
  await app.whenReady();
  fs.mkdirSync(options.profile, { recursive: true });
  const preload = require("node:path").join(options.profile, "fixture-preload.cjs");
  fs.writeFileSync(preload, "window.fixtureSockets={created:0,closed:0};const NativeSocket=window.WebSocket;window.WebSocket=class extends NativeSocket{constructor(...a){super(...a);if(String(a[0]).endsWith('/__chatws')){window.fixtureSockets.created++;this.addEventListener('close',()=>window.fixtureSockets.closed++);}}};");
  const w = new BrowserWindow({ show: false, width: 1120, height: 920,
    webPreferences: { backgroundThrottling: false, contextIsolation: false, preload } });
  const js = code => w.webContents.executeJavaScript(code, true);
  const wait = async (code, label) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await js(code)) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw Error(label + " timed out: " + await js("document.body.innerText.slice(-1500)"));
  };
  try {
    console.log("UI stage: load isolated production page");
    const at = Date.now(); await w.loadURL(options.large);
    await wait("document.body.innerText.includes('DESKTOP_ANSWER_600')", "first history");
    const firstPaintMs = Date.now() - at;
    const initialSockets = await js("window.fixtureSockets");
    if (initialSockets.closed !== 0) throw Error("startup connection closed");
    console.log("UI stage: initial history visible");
    await js("document.querySelector('button.chat-archive-bar').click()");
    await wait("!document.querySelector('button.chat-archive-bar')?.disabled", "older history request");
    await js("document.querySelector('.chat-thread').scrollTop=0");
    await wait("document.body.innerText.includes('DESKTOP_ANSWER_501')", "older history");
    await js("location.hash=" + JSON.stringify(options.first.split("#")[1]));
    await wait("document.body.innerText.includes('已记住桌面对话的上下文')", "switch to original");
    await wait("document.body.innerText.includes('Shoggoth 记忆系统（沿用九章目录）')", "readable question reply");
    if (await js("document.body.innerText.includes('send_user_message_question_reply')")) throw Error("raw question transport is visible");
    fs.writeFileSync(options.questionScreenshot, (await w.webContents.capturePage()).toPNG());
    await js("(()=>{const e=document.querySelector('textarea.chat-composer__input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'开始改吧');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await new Promise(resolve => setTimeout(resolve, 50));
    await js("document.querySelector('textarea.chat-composer__input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}))");
    await wait("document.body.innerText.includes('开始改吧') && document.body.innerText.includes('RUNTIME_START_SESSION_START_OR_RESUME_FAILED')", "failed send survives canonical refresh");
    await js("location.hash=" + JSON.stringify(options.large.split("#")[1]));
    await wait("document.body.innerText.includes('DESKTOP_ANSWER_600')", "switch away from failed send");
    await js("location.hash=" + JSON.stringify(options.first.split("#")[1]));
    await wait("document.body.innerText.includes('开始改吧') && document.body.innerText.includes('RUNTIME_START_SESSION_START_OR_RESUME_FAILED')", "reopened failed send");
    fs.writeFileSync(options.failureScreenshot, (await w.webContents.capturePage()).toPNG());
    await js("location.hash=" + JSON.stringify(options.large.split("#")[1]));
    await wait("document.body.innerText.includes('DESKTOP_ANSWER_600')", "switch back");
    await js("(()=>{const e=document.querySelector('textarea.chat-composer__input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Continue this Desktop conversation');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await new Promise(resolve => setTimeout(resolve, 50));
    await js("document.querySelector('textarea.chat-composer__input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}))");
    await wait("document.body.innerText.includes('DESKTOP_UI_CONTINUED_ORIGINAL_THREAD')", "same thread response");
    await wait("!document.body.innerText.includes('发送结果未确认')", "terminal send verification");
    await js("(()=>{const e=document.querySelector('textarea.chat-composer__input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'A second explicit Desktop message');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await new Promise(resolve => setTimeout(resolve, 50));
    await js("document.querySelector('textarea.chat-composer__input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}))");
    await wait("document.body.innerText.includes('DESKTOP_UI_SECOND_REPLY')", "second explicit send");
    await wait("!document.body.innerText.includes('发送结果未确认')", "second terminal verification");
    if (await js("document.body.innerText.includes('BEGIN UNTRUSTED ENABLED SKILL CATALOG DATA')")) throw Error("internal context is visible in user messages");
    const sockets = await js("window.fixtureSockets");
    // App has separate ChatPage and Notifier channels. Neither should reopen
    // when selecting another Desktop history or sending in the original thread.
    if (sockets.created !== initialSockets.created || sockets.closed !== 0) throw Error("unexpected reconnect " + JSON.stringify(sockets));
    fs.writeFileSync(options.screenshot, (await w.webContents.capturePage()).toPNG());
    console.log(JSON.stringify({ verified: true, firstPaintMs, olderHistoryLoaded: true, readableQuestionReply: true,
      noContextInUserBubbles: true, sessionSwitches: 4, failedSendRetained: true, continued: true, sends: 2, terminalVerified: true, sockets }));
  } finally { w.destroy(); app.quit(); }
}

(async () => {
  const f = await fixture({ enabledSkill: true }); let server, proxy;
  try {
    f.native.turns.push(turn('<send_user_message_question_reply>\n' + JSON.stringify([{ questionItemId: "fixture-question",
      question: "这份页面希望聚焦哪个范围？", answer: "Shoggoth 记忆系统（沿用九章目录）" }]) + '\n</send_user_message_question_reply>', "已确认范围"));
    const long = f.add({ title: "Desktop UI long history" });
    long.turns = Array.from({ length: 600 }, (_, i) => turn("DESKTOP_QUESTION_" + (i + 1), "DESKTOP_ANSWER_" + (i + 1)));
    await f.backend._refreshCodexDesktopSessions();
    const rows = f.backend.getSessionRows(), first = rows.find(r => r.label === "桌面对话：保留原上下文"), large = rows.find(r => r.label === "Desktop UI long history");
    const history = f.backend.getHistory.bind(f.backend), reads = [];
    f.backend.getHistory = async (key, options) => {
      const at = Date.now(), result = await history(key, options);
      reads.push({ key, cursor: !!options?.cursor, items: result.messages.length, bytes: Buffer.byteLength(JSON.stringify(result)), elapsedMs: Date.now() - at });
      return result;
    };
    const resume = f.host.threadResume.bind(f.host);
    f.host.threadResume = async params => {
      if (params.threadId === f.native.id) throw Error("fixture Desktop resume failed");
      return resume(params);
    };
    const start = f.host.turnStart.bind(f.host);
    f.host.turnStart = async params => {
      assert.ok(["Continue this Desktop conversation", "A second explicit Desktop message"].includes(params.input[0].text));
      const response = await start(params);
      const answer = f.host.turnStarts === 1 ? "DESKTOP_UI_CONTINUED_ORIGINAL_THREAD" : "DESKTOP_UI_SECOND_REPLY";
      setTimeout(() => f.host.finish(response.turn.id, answer), 100);
      return response;
    };
    const registry = new BackendRegistry(); registry.register(f.backend); await registry.start();
    proxy = await startProxyGateway({ port: 0, getUpstreamUrl: () => "", registry });
    const authResolver = createAuthResolver({ getConfig: () => ({ gatewayUrl: proxy.url, token: "" }),
      credentialsDir: path.join(f.root, "browser-credentials"), operatorIdentityDir: path.join(f.root, "browser-operator") });
    server = await startStaticServer(0, { registry, homeDir: f.root, userDataRoot: f.root,
      chatUpstreamUrl: proxy.url, chatOrigin: "http://127.0.0.1", authResolver });
    const page = key => server.url + "/#/chat?backend=shoggoth&session=" + encodeURIComponent(key);
    const output = path.resolve(".artifacts/codex-desktop-message-fix-2026-10-02"); fs.mkdirSync(output, { recursive: true });
    const main = path.join(f.root, "ui-main.cjs"), options = path.join(f.root, "ui-options.json");
    fs.writeFileSync(main, "(" + browserMain.toString() + ")().catch(e=>{console.error(e);require('electron').app.exit(1)});");
    fs.writeFileSync(options, JSON.stringify({ first: page(first.key), large: page(large.key),
      profile: path.join(f.root, "browser-profile"), screenshot: path.join(output, "desktop-ui.png"),
      failureScreenshot: path.join(output, "desktop-failed-send-ui.png"),
      questionScreenshot: path.join(output, "desktop-question-reply-ui.png") }));
    const child = spawn(require("electron"), [main, options], { env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
    const timeout = setTimeout(() => child.kill("SIGTERM"), 90000);
    const status = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    clearTimeout(timeout); assert.equal(status, 0, "production Desktop UI regression must exit naturally");
    assert.equal(f.host.turnStarts, 2); assert.equal(f.host.turnParams.threadId, long.id); assert.equal(f.host.threadStarts, 0);
    assert.ok(reads.filter(r => r.key === large.key && !r.cursor).every(r => r.items <= 100));
    fs.writeFileSync(path.join(output, "desktop-ui-history.json"), JSON.stringify(reads, null, 2));
  } finally { if (server) await server.close(); if (proxy) await proxy.close(); await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
