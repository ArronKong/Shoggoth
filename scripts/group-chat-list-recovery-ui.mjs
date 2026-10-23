#!/usr/bin/env node
// Real ChatPage in an isolated Electron profile; all API/WS traffic is synthetic.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "app/manage-ui/package.json"));
const { build } = require("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-group-list-ui-"));
const output = process.env.GROUP_LIST_UI_OUTPUT ? path.resolve(process.env.GROUP_LIST_UI_OUTPUT) : null;
const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import ChatPage from "./app/manage-ui/src/pages/ChatPage";
import { UiProvider } from "./app/manage-ui/src/components/ui";
import ScrollbarProvider from "./app/manage-ui/src/components/ScrollbarProvider";
import { runPageRefresh } from "./app/manage-ui/src/lib/page-refresh";
import i18n from "./app/manage-ui/src/i18n";
import "./app/manage-ui/src/styles.css";
import "./app/manage-ui/src/manage-skin.css";
const state = window as any, options = new URLSearchParams(location.search);
const scenario = options.get("scenario") || "retry", language = options.get("language") || "zh-CN";
const key = "agent:fixture:main", now = Date.now();
const sessions = [{ key, agentId: "fixture", agentName: "Fixture Agent", backendId: "openclaw", updatedAt: now }];
const makeGroup = (id: string) => ({ group: { id, name: "Saved group " + id, purpose: "", status: "active", createdAt: now,
  updatedAt: now, metadataRevision: 1, rosterRevision: 1, directoryRevision: 1, controlEpoch: 0, lastSeq: 0 },
  members: [{ id: "a", backendId: "shoggoth", agentId: "a", displayName: "Alpha", handle: "a", state: "active" },
    { id: "b", backendId: "hermes", agentId: "b", displayName: "Beta", handle: "b", state: "active" }],
  discussion: null, activeTurns: [], queuedMemberIds: [], internalSessionKeys: [], pendingInteractions: [], tasks: [] });
let groups = [1, 2, 3, 4, 5].map(id => makeGroup(String(id))), ready = false, enabled = true, reads = 0, writes = 0;
state.fetch = async (url: unknown, init: RequestInit = {}) => {
  if (init.method && init.method !== "GET") { writes++; throw Error("Unexpected write: " + url); }
  const pathname = String(url);
  let payload: unknown = {};
  if (pathname === "/__api/group-chats" || pathname.startsWith("/__api/group-chats?")) {
    reads++;
    if (!ready) return new Response(JSON.stringify({ code: "GROUP_CHAT_UNAVAILABLE" }), { status: 503 });
    payload = { groups, enabled };
  } else if (pathname.startsWith("/__api/group-chats/detail")) payload = groups[0];
  else if (pathname.startsWith("/__api/group-chats/messages")) payload = { messages: [], hasMore: false };
  else if (pathname.startsWith("/__api/status")) payload = { backends: [{ id: "openclaw", connected: true }] };
  else if (pathname.includes("/__api/backends")) payload = { backends: [] };
  else if (pathname.includes("/archive")) payload = { archive: { supported: true, segments: [] } };
  else if (pathname.includes("runtime-models")) payload = { selection: { canSwitch: false, candidates: [] }, capabilities: {}, models: [], runtimes: [] };
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};
class FixtureSocket {
  static OPEN = 1; readyState = 1; onopen: any; onmessage: any; onclose: any;
  constructor() { state.socket = this; setTimeout(() => this.onopen?.(), 0); }
  emit(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  send(data: string) {
    const request = JSON.parse(data);
    const payload = request.method === "sessions.list" ? { sessions, hasMore: false }
      : request.method === "agents.list" ? { agents: [{ id: "fixture", name: "Fixture Agent", backendId: "openclaw" }] }
      : request.method === "chat.history" ? { messages: [{ role: "user", content: "Existing direct chat", timestamp: now }] } : {};
    setTimeout(() => this.emit({ type: "res", id: request.id, ok: true, payload }), 0);
  }
  close() { this.readyState = 3; }
}
state.WebSocket = FixtureSocket;
window.addEventListener("error", event => { state.fixtureError = event.error?.stack || event.message; });
window.addEventListener("unhandledrejection", event => { state.fixtureError = String(event.reason); });
localStorage.clear();
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
localStorage.setItem("shoggoth.chat.lastActive.v1", key);
void i18n.changeLanguage(language);
document.documentElement.setAttribute("data-theme", language === "en" ? "dark" : "light");
const pause = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (check: () => unknown, label: string) => {
  const until = Date.now() + 8000;
  while (!check()) { if (state.fixtureError) throw Error(state.fixtureError); if (Date.now() > until) throw Error(label); await pause(); }
};
const rows = () => document.querySelectorAll('.chat-aside__list button[title^="Saved group "]');
createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><ScrollbarProvider /><ChatPage /></UiProvider></HashRouter>);
state.runGroupListFixture = async () => {
  await wait(() => reads > 0 && document.querySelector(".chat-thread")?.textContent?.includes("Existing direct chat"), "direct chat did not load");
  if (rows().length !== 0) throw Error("unavailable groups should not be fabricated");
  ready = true;
  await wait(() => rows().length === 5, "existing groups did not recover without a group event");
  if (scenario !== "retry") {
    // The startup retry has succeeded and stopped. Only the selected recovery
    // trigger can now discover a missed group; a retry cannot mask missing wiring.
    groups = [...groups, makeGroup("recovered")];
    if (scenario === "service-ready") state.socket.emit({ type: "event", event: "agents.changed", payload: {} });
    else if (scenario === "manual") await runPageRefresh("/chat");
    else if (scenario === "reconnect") { state.socket.close(); state.socket.onclose?.(); }
    await wait(() => rows().length === 6, "recovery trigger did not refresh groups: " + scenario);
  }
  if (scenario === "retry") {
    ready = false;
    await runPageRefresh("/chat");
    if (rows().length !== 5) throw Error("refresh failure cleared known groups");
    ready = true; enabled = false;
    window.dispatchEvent(new Event("focus"));
    await wait(() => rows().length === 0, "disabled groups remain visible");
    enabled = true; window.dispatchEvent(new Event("focus"));
    await wait(() => rows().length === 5, "re-enabled groups did not return");
  }
  if (writes !== 0) throw Error("recovery required a write");
  return { scenario, language, visibleGroups: rows().length, reads, writes, passed: true };
};
`;
try {
  await build({ stdin: { contents: fixture, loader: "tsx", resolveDir: root }, bundle: true, format: "esm", jsx: "automatic",
    nodePaths: [path.join(root, "app/manage-ui/node_modules")], define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl" }, outfile: path.join(temp, "fixture.js"), logLevel: "silent" });
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;height:100%;min-height:0}#root{display:flex;flex-direction:column}</style><div id="root"></div><script type="module" src="fixture.js"></script>');
  if (output) fs.mkdirSync(output, { recursive: true });
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, `const {app,BrowserWindow}=require("electron"),fs=require("node:fs");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1200,height:850,webPreferences:{backgroundThrottling:false}});let passed=false;
try{const results=[];for(const scenario of ["retry","service-ready","manual","reconnect"]){for(const language of ["zh-CN","en"]){
await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))},{query:{scenario,language},hash:"/chat"});
const result=await w.webContents.executeJavaScript("window.runGroupListFixture()");results.push(result);console.log(JSON.stringify(result));
if(${Boolean(output)}&&scenario==="retry")fs.writeFileSync(${JSON.stringify(output)}+"/recovered-"+language+".png",(await w.webContents.capturePage()).toPNG());
}}if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+"/results.json",JSON.stringify(results,null,2));passed=true;
}catch(error){console.error(error.stack||error);console.error(await w.webContents.executeJavaScript("document.body.innerText.slice(0,1500)"));}finally{w.destroy();app.exit(passed?0:1);}});`);
  const child = spawn(require("electron"), [main], { env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => process.stdout.write(chunk)); child.stderr.on("data", chunk => process.stderr.write(chunk));
  const timeout = setTimeout(() => child.kill("SIGTERM"), 120000);
  let status;
  try { status = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }); }
  finally { clearTimeout(timeout); }
  assert.equal(status, 0, "group list recovery UI regression failed");
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
