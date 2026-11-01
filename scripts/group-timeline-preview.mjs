#!/usr/bin/env node
// Real SQLite publication -> real GroupChatPanel, with isolated APIs and no model/provider calls.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, ".."), require = createRequire(path.join(root, "app/manage-ui/package.json"));
const { GroupChatStore } = require(path.join(root, "app/agent-service/group-chat-store.js"));
const output = path.resolve(process.env.GROUP_TIMELINE_OUTPUT || path.join(root, ".artifacts/group-chat-quiet-20261101/timeline"));
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-group-timeline-")));
fs.chmodSync(temp, 0o700); fs.mkdirSync(output, { recursive: true });
let store;
try {
  const paths = { stateDir: path.join(temp, "state"), trustedRoot: temp };
  let clock = Date.parse("2026-11-01T10:00:00+08:00");
  store = new GroupChatStore({ paths, now: () => clock }).open();
  const { groupId } = store.createGroup({ operationId: "preview-create", name: "产品体验讨论", purpose: "",
    members: ["A", "B"].map(id => ({ backendId: "shoggoth", agentId: id.toLowerCase(), profileId: id.toLowerCase(), displayName: id })) });
  store.appendUserMessage({ groupId, clientMessageId: "preview-user", body: "A 检查配置，B 核对权限，分别把进展发到群里。", mentionMemberIds: [] });
  const fence = store.advanceDriverFence(), a = store.claimNext(groupId, fence);
  store.bindSession({ groupId, memberId: a.member.id, sessionKey: "session-a", fence });
  store.recordRun({ opportunityId: a.opportunity.id, runId: "run-a", sessionKey: "session-a", fence });
  const capture = () => {
    const view = store.getGroup(groupId);
    view.activeTurns = view.activeTurns.map(turn => ({ ...turn, individualMessages: true }));
    return JSON.parse(JSON.stringify({ view, messages: store.listMessages({ groupId, limit: 50 }).messages }));
  };
  const snapshots = [capture()], first = { id: "a-one", text: "A1：我先检查配置，稍后继续汇报。@b 请核对权限。", pending: false };
  clock += 60000;
  store.syncTurnMessages({ opportunityId: a.opportunity.id, runId: "run-a", fence, messages: [first] });
  store.releaseTurn({ opportunityId: a.opportunity.id, reason: "working", fence, text: first.text, replyMessages: [first] });
  snapshots.push(capture());
  const b = store.claimNext(groupId, fence); assert.ok(b);
  store.bindSession({ groupId, memberId: b.member.id, sessionKey: "session-b", fence });
  store.recordRun({ opportunityId: b.opportunity.id, runId: "run-b", sessionKey: "session-b", fence });
  clock += 60000;
  store.completeTurn({ opportunityId: b.opportunity.id, fence, status: "completed", text: "B1：权限已核对，没有发现阻塞，可以继续。",
    replyMessages: [{ id: "b-one", text: "B1：权限已核对，没有发现阻塞，可以继续。", final: true }] });
  snapshots.push(capture());
  clock += 60000;
  const second = { id: "a-two", text: "A2：配置检查", pending: true };
  store.syncTurnMessages({ opportunityId: a.opportunity.id, runId: "run-a", fence, messages: [first, second] });
  snapshots.push(capture());
  clock += 60000;
  const final = "A2：配置检查完成，结果已整理好。接下来可以按检查清单逐项处理。";
  store.completeTurn({ opportunityId: a.opportunity.id, fence, status: "completed", text: final,
    replyMessages: [first, { ...second, text: final, final: true }] });
  // Exercise the normal driver drain with silent fixture acknowledgments; no additional public replies or model calls.
  for (let attempt = 0; attempt < 4; attempt++) {
    const next = store.claimNext(groupId, fence); if (!next) break;
    store.completeTurn({ opportunityId: next.opportunity.id, fence, status: "completed", text: "(pass)" });
  }
  store.close(); store = new GroupChatStore({ paths, now: () => clock }).open(); snapshots.push(capture());
  assert.equal(snapshots[4].view.round, null);
  assert.deepEqual(snapshots[4].messages.filter(message => message.author.kind === "member").map(message => message.body.slice(0, 2)), ["A1", "B1", "A2"]);
  fs.writeFileSync(path.join(output, "data.json"), JSON.stringify(snapshots, null, 2));
  await require("esbuild").build({ entryPoints: [path.join(root, "scripts/fixtures/group-timeline.tsx")], bundle: true, format: "esm", jsx: "automatic",
    nodePaths: [path.join(root, "app/manage-ui/node_modules")], loader: { ".woff2": "dataurl", ".svg": "dataurl", ".png": "dataurl", ".webp": "dataurl" },
    define: { "process.env.NODE_ENV": '"production"', GROUP_TIMELINE_DATA: JSON.stringify(snapshots) }, outfile: path.join(output, "fixture.js"), logLevel: "silent" });
  fs.writeFileSync(path.join(output, "fixture.html"), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;margin:0;min-height:0}#root{display:flex;flex-direction:column}</style><div id="root" class="chat-shell"></div><script type="module" src="fixture.js"></script>');
  fs.writeFileSync(path.join(output, "index.html"), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>群聊 · 独立消息时间线</title><style>*{box-sizing:border-box}body{margin:0;background:#eeefed;color:#292c29;font:15px/1.5 -apple-system,BlinkMacSystemFont,sans-serif}main{max-width:1100px;padding:24px 32px;margin:auto}h1{font-size:24px;font-weight:600;margin:0 0 5px}p{color:#686e67;margin:0}nav{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0}button{font:inherit;border:1px solid #d3d8d0;background:#f9faf7;border-radius:20px;padding:7px 16px;cursor:pointer}button[aria-pressed=true]{color:#fff;background:#364b39;border-color:#364b39}iframe{display:block;width:100%;height:880px;border:1px solid #d7dad4;border-radius:16px;background:#fff}.note{font-size:12px;margin-top:10px}@media(max-width:650px){main{padding:16px}iframe{height:880px}}</style><main><h1>群聊 · 独立消息时间线</h1><p>A1 → B1 → A2；每条独立时间，旧气泡持续保留。</p><nav><button data-stage="1" aria-pressed="false">10:01 · A1 发出</button><button data-stage="2" aria-pressed="false">10:02 · B1 接话</button><button data-stage="3" aria-pressed="true">10:03 · A2 继续输出</button><button data-stage="4" aria-pressed="false">完成后重新打开</button></nav><iframe title="群聊独立时间线预览" src="fixture.html?stage=3"></iframe><p class="note">示例消息 · 完成后仍保留每条消息的时间和顺序</p></main><script>for(const button of document.querySelectorAll('[data-stage]'))button.onclick=()=>{for(const tab of document.querySelectorAll('[data-stage]'))tab.setAttribute('aria-pressed',String(tab===button));document.querySelector('iframe').src='fixture.html?stage='+button.dataset.stage}</script></html>`);
  if (!process.argv.includes("--build-only")) {
    const main = path.join(temp, "main.cjs");
    fs.writeFileSync(main, `const{app,BrowserWindow}=require('electron'),fs=require('node:fs');app.setPath('userData',${JSON.stringify(path.join(temp, "profile"))});app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});let ok=false;try{const results=[];for(const width of[1100,390])for(const theme of['light','dark']){w.setSize(width,1000);await w.loadFile(${JSON.stringify(path.join(output, "fixture.html"))},{query:{stage:'0',test:'1',theme}});const result=await w.webContents.executeJavaScript('window.timelinePromise');results.push({...result,width,theme});fs.writeFileSync(${JSON.stringify(output)}+'/settled-'+width+'-'+theme+'.png',(await w.webContents.capturePage()).toPNG())}fs.writeFileSync(${JSON.stringify(path.join(output, "results.json"))},JSON.stringify(results,null,2));console.log(JSON.stringify(results));ok=true}catch(error){console.error(error.stack||error);fs.writeFileSync(${JSON.stringify(path.join(output, "failed.png"))},(await w.webContents.capturePage()).toPNG())}finally{w.destroy();app.exit(ok?0:1)}});`);
    const child = spawn(require("electron"), [main], { env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", data => process.stdout.write(data)); child.stderr.on("data", data => process.stderr.write(data));
    const timer = setTimeout(() => child.kill("SIGTERM"), 45000);
    const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }); clearTimeout(timer);
    assert.equal(code, 0, "independent group timeline UI acceptance failed");
  }
  console.log(`PREVIEW ${path.join(output, "index.html")}`);
} finally { store?.close(); fs.rmSync(temp, { recursive: true, force: true }); }
