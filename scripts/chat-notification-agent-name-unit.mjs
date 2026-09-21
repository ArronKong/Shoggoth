import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "app/manage-ui/package.json"));
const ts = require("typescript");
const React = require("react");
const { create, act } = require("react-test-renderer");
function load(file, globals = {}) {
  const module = { exports: {} };
  const { outputText } = ts.transpileModule(fs.readFileSync(path.join(root, "app/manage-ui/src", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  vm.runInNewContext(outputText, { exports: module.exports, ...globals });
  return module.exports;
}
const display = load("lib/agentDisplay.ts");
const settle = async callback => act(async () => { callback(); await new Promise(setImmediate); });

// Mount the production driver and use the real notification transport helper.
// Only the network, timers, and desktop/browser boundaries are in memory.
async function fixture(native = true) {
  const notices = [], sockets = [], requests = [], timers = new Map(), listeners = new Map(), storage = new Map();
  let timerId = 0, timestamp = 0, nativeOpen, renderer;
  let config = { notifications: { chat: true, cron: false, task: false } };
  const location = { protocol: "http:", host: "fixture.invalid", hash: "" };
  const window = { location, focus() {},
    addEventListener: (event, callback) => listeners.set(event, callback),
    removeEventListener: event => listeners.delete(event),
    dispatchEvent: event => listeners.get(event.type)?.(event),
    ...(native ? { openclawDesktop: {
      notify: payload => { notices.push(payload); return true; },
      onOpenTarget: callback => { nativeOpen = callback; return () => { nativeOpen = null; }; },
    } } : {}),
  };
  class BrowserNotification {
    static permission = "granted";
    constructor(title, { body }) { this.title = title; this.body = body; notices.push(this); }
  }
  class Socket {
    static OPEN = 1;
    readyState = 0;
    constructor() { sockets.push(this); }
    send(raw) {
      if (this.sendFails) throw Error("offline");
      requests.push({ socket: this, ...JSON.parse(raw) });
    }
    receive(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = Socket.OPEN; this.onopen?.(); }
  }
  const notifications = load("lib/notify.ts", { window, Notification: BrowserNotification, document: { hasFocus: () => false } });
  const enabled = [];
  const Notifier = load("components/Notifier.tsx", {
    require: name => ({
      react: React,
      "react-i18next": { useTranslation: () => ({ t: key => key }) },
      "./ui": { useToast: () => ({ info() {}, error() {} }) },
      "../api/client": { getConfig: async () => config },
      "../lib/backends": { useEnabledBackends: () => enabled },
      "../lib/agentDisplay": display,
      "../lib/shoggothDomainUi": {},
      "../lib/inspiration-notifications": {},
      "../lib/notify": notifications,
    })[name] || require(name),
    window, location, WebSocket: Socket,
    sessionStorage: { setItem: (key, value) => storage.set(key, value) },
    CustomEvent: class { constructor(type, { detail }) { this.type = type; this.detail = detail; } },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => 0, clearInterval() {},
  }).default;
  await settle(() => { renderer = create(React.createElement(Notifier)); });
  const open = () => settle(() => sockets.at(-1).open());
  const latestRequest = () => requests.filter(request => request.method === "agents.list").at(-1);
  const respond = (agents, request = latestRequest(), ok = true) => settle(() => request.socket.receive({
    type: "res", id: request.id, ok, payload: { agents },
  }));
  const reply = (id, extra = {}) => {
    const frame = { type: "event", event: "chat", payload: { state: "final", sessionKey: `agent:${id}:main`,
      message: { role: "assistant", content: "已处理完毕。", timestamp: ++timestamp, ...extra } } };
    return frame;
  };
  const receive = frame => settle(() => sockets.at(-1).receive(frame));
  const runTimer = delay => settle(() => {
    for (const [id, timer] of [...timers]) {
      if (timer.delay === delay) { timers.delete(id); timer.callback(); }
    }
  });
  return { notices, sockets, requests, timers, location, storage, open, latestRequest, respond, reply, receive, runTimer,
    save: chat => settle(() => { config = { notifications: { chat, cron: false, task: false } }; listeners.get("openclaw:config-changed")(); }),
    click: index => settle(() => native
      ? nativeOpen({ category: "chat", target: notices[index].target }) : notices[index].onclick()),
    unmount: () => settle(() => renderer.unmount()),
  };
}

const rows = [
  { id: "ada", name: "产品经理", backendId: "openclaw" },
  { id: "main", name: "CEO", backendId: "openclaw" },
  { id: "hermes-main", name: "research", backendId: "hermes" },
  { id: "shoggoth-61ccd39b", name: "溪桥", backendId: "shoggoth" },
  { id: "codex-c79e0e41", name: "星帆", backendId: "codex" },
  { id: "deepseek-harness-2031c7ed", name: "晴川", backendId: "deepseek-harness" },
  { id: "shoggoth-grok", name: "Grok", backendId: "grok-build" },
  { id: "shoggoth-antigravity", name: "Antigravity", backendId: "antigravity" },
  { id: "shoggoth-pi", name: "Pi", backendId: "pi" },
  { id: "shoggoth-claude", name: "Claude", backendId: "claude-code" },
  { id: "identity-only", name: " ", identity: { name: "  小写 iOS 助手  " } },
];
const f = await fixture();
await f.open();
for (const row of rows) await f.receive(f.reply(row.id));
assert.equal(f.notices.length, 0, "Early replies wait for the first roster instead of showing raw ids");
assert.equal(f.requests.filter(request => request.method === "agents.list").length, 1, "Concurrent replies share the pending roster lookup");
await f.respond(rows);
assert.deepEqual(f.notices.map(notice => notice.title), rows.map(row => row.name.trim() || row.identity.name.trim()),
  "Desktop titles must match current names for every routing namespace, preserving case and Unicode");
assert.equal(f.notices[1].title, "CEO");
assert.equal(f.notices[2].title, "research", "Backend-local main ids must not collide");
assert.ok(f.notices.every(notice => notice.body === "已处理完毕。"));
await f.click(3);
assert.equal(f.location.hash, "#/chat");
assert.equal(f.storage.get("openclaw.pendingChatSession"), `agent:${rows[3].id}:main`, "Names never replace routing identity");

// Rename without a page switch or a backend change event.
rows[0].name = "产品负责人";
const renamedReply = f.reply("ada");
await f.receive(renamedReply);
await f.receive(renamedReply);
const beforeRename = f.notices.length;
await f.respond(rows);
assert.equal(f.notices.length, beforeRename + 1, "Duplicate finals still emit only once while metadata is pending");
assert.equal(f.notices.at(-1).title, "产品负责人", "A long-mounted Notifier refreshes the current name before delivery");

// Failed, malformed, and degraded responses preserve the last known name.
for (const [agents, ok] of [[[], false], [null, true], [[], true]]) {
  await f.receive(f.reply("ada"));
  await f.respond(agents, undefined, ok);
  assert.equal(f.notices.at(-1).title, "产品负责人");
}
await f.receive(f.reply("ada"));
const timedOut = f.latestRequest();
await f.runTimer(3000);
assert.equal(f.notices.at(-1).title, "产品负责人", "Timeout delivers using the known name");
await f.respond([{ id: "ada", name: "过期回复" }], timedOut);
await f.receive(f.reply("ada"));
await f.respond([], undefined, false);
assert.equal(f.notices.at(-1).title, "产品负责人", "Late roster responses cannot overwrite current names");
await f.receive(f.reply("unknown"));
await f.runTimer(3000);
assert.equal(f.notices.at(-1).title, "Unknown", "Unknown agents keep the existing fallback without borrowing another name");

const beforeSuppressed = f.notices.length, requestsBefore = f.requests.length;
for (const [id, extra] of [["ada:cron:job", {}], ["ada:dashboard:inspiration-note", {}],
  ["ada", { shoggoth: { source: "cron" } }], ["ada", { shoggoth: { source: "inspiration" } }],
  ["ada", { content: "HEARTBEAT_OK" }], ["ada", { isError: true }], ["ada", { content: "" }]]) {
  await f.receive(f.reply(id, extra));
}
assert.equal(f.requests.length, requestsBefore, "Silent events do not request notification metadata");
assert.equal(f.notices.length, beforeSuppressed);

await f.receive(f.reply("ada"));
await f.save(false);
await f.respond(rows);
assert.equal(f.notices.length, beforeSuppressed, "Disabling chat during name lookup cancels delivery");
await f.save(true);
await f.receive(f.reply("ada"));
await f.save(false);
await f.save(true);
await f.respond(rows);
assert.equal(f.notices.length, beforeSuppressed, "Re-enabling does not resurrect a canceled notification");

// Backend readiness and reconnects refresh names; a closing socket releases waiters.
await f.receive({ type: "event", event: "agents.changed", payload: {} });
rows[0].name = "新名称";
await f.respond(rows);
await f.receive(f.reply("ada"));
await settle(() => f.sockets.at(-1).close());
assert.equal(f.notices.at(-1).title, "新名称");
assert.equal([...f.timers.values()].filter(timer => timer.delay === 3000).length, 0);
await f.runTimer(4000);
await f.open();
rows[0].name = "重连后的名称";
await f.respond(rows);
await f.receive(f.reply("ada"));
f.sockets.at(-1).sendFails = true;
await f.respond(rows);
await f.receive(f.reply("ada"));
assert.equal(f.notices.at(-1).title, "重连后的名称", "A send failure preserves notification delivery");
f.sockets.at(-1).sendFails = false;
await f.receive(f.reply("ada"));
const beforeUnmount = f.notices.length;
await f.unmount();
assert.equal(f.notices.length, beforeUnmount, "Unmounted drivers do not deliver late notifications");
assert.equal(f.timers.size, 0, "Cleanup clears name lookup and reconnect timers");

const browser = await fixture(false);
await browser.open();
await browser.receive(browser.reply("ada"));
await browser.respond(rows);
assert.equal(browser.notices[0].title, "重连后的名称", "Browser notifications use the same resolved title as native IPC");
await browser.click(0);
assert.equal(browser.storage.get("openclaw.pendingChatSession"), "agent:ada:main");
await browser.unmount();

console.log("chat notification Agent names: PASS (all backends, initial delay, rename, dedup, degraded/failed/late lookup, preferences, reconnect, cleanup, native/browser delivery)");
