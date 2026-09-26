#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { DesktopPluginAppHost, wrapperHtml } = require("../app/desktop-plugin-app-host");
const { normalizeAppResource } = require("../app/agent-service/plugin-app-session");

const CHANNEL = "shoggoth-plugin-app:request";
const HTML = "<!doctype html><html><body><h1>Isolated fixture</h1></body></html>";
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const policy = normalizeAppResource({ tool: { _meta: { ui: { resourceUri: "ui://fixture/app" } } },
  resource: { uri: "ui://fixture/app", mimeType: "text/html;profile=mcp-app", text: HTML } }).policy;
const tick = () => new Promise(resolve => setImmediate(resolve));
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture({ html = HTML, alter = () => {}, loadError = null, onClose = async () => {},
  read = null, createWait = null, expiresIn = 10_000, onMessage = async message => ({ result: message }) } = {}) {
  const instances = [], partitions = [], requests = [], closes = [];
  const transports = new Set();
  const handlers = new Map();
  let transport, createInput, descriptor;
  let sequence = 0;
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; instances.push(this);
      this.webContents = new EventEmitter();
      this.webContents.id = ++sequence;
      this.webContents.mainFrame = { url: "" };
      this.webContents.setWindowOpenHandler = handler => { this.popup = handler; };
    }
    async loadURL(url) {
      this.url = url; this.webContents.mainFrame.url = url;
      if (loadError) throw loadError;
      const response = await fetch(url);
      this.headers = response.headers; this.html = await response.text();
      assert.equal(response.status, 200);
    }
    show() { this.shown = true; }
    isDestroyed() { return this.destroyed; }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("closed"); } }
  }
  const session = { fromPartition(name, options) {
    const partition = new EventEmitter();
    Object.assign(partition, { name, options,
      setPermissionRequestHandler(handler) { this.permissionRequest = handler; },
      setPermissionCheckHandler(handler) { this.permissionCheck = handler; },
      webRequest: { onBeforeRequest(handler) { partition.beforeRequest = handler; } },
      async clearStorageData() {}, async clearCache() {} });
    partitions.push(partition); return partition;
  } };
  const host = new DesktopPluginAppHost({ BrowserWindow: FakeWindow, session,
    ipcMain: { handle(channel, handler) { assert.equal(handlers.has(channel), false); handlers.set(channel, handler); } } });
  const bytes = Buffer.from(html);
  const chunks = [];
  for (let index = 0; index < bytes.length; index += 18 * 1024) chunks.push(bytes.subarray(index, index + 18 * 1024).toString("base64"));
  const options = {
    async create(input) {
      createInput = input;
      if (createWait) await createWait;
      transport = { sessionId: "a".repeat(64), nonce: "b".repeat(64), sourceId: input.sourceId,
        origin: input.sandboxOrigin, conversationId: "conversation-fixture" };
      transports.add(transport);
      descriptor = { sandboxOrigin: input.sandboxOrigin, expiresAt: Date.now() + expiresIn,
        transport, policy, resource: { encoding: "base64", byteLength: bytes.length,
          chunkCount: chunks.length, contentDigest: sha(bytes) } };
      alter(descriptor);
      return { canceled: false, descriptor };
    },
    async readChunk(received, index) {
      assert.ok(transports.has(received));
      return read ? read({ index, chunks }) : { index, data: chunks[index], total: chunks.length };
    },
    async message(received, message) {
      assert.ok(transports.has(received)); requests.push(message); return onMessage(message);
    },
    async close(received) { closes.push(received); await onClose(); },
  };
  return { host, options, instances, partitions, requests, closes, handlers,
    get descriptor() { return descriptor; }, get createInput() { return createInput; } };
}
const eventFor = window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
const navigation = (contents, kind, url) => {
  let blocked = false; contents.emit(kind, { url, preventDefault() { blocked = true; } }); return blocked;
};

test("wrapper escapes script delimiters and keeps the child opaque", () => {
  const hostile = "</script><script>globalThis.escaped=true</script><img src=x onerror=escaped()>&\u2028\u2029";
  const wrapper = wrapperHtml(hostile, policy.contentSecurityPolicy,
    [{ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { text: hostile } }]);
  assert.equal((wrapper.match(/<script>/gu) || []).length, 1);
  assert.equal((wrapper.match(/<\/script>/gu) || []).length, 1);
  assert.equal(wrapper.includes(hostile), false);
  assert.match(wrapper, /sandbox="allow-scripts"/u);
  assert.doesNotMatch(wrapper, /allow-same-origin/u);
  assert.match(wrapper, /event\.source\s*!==\s*frame\.contentWindow/u);
  assert.match(wrapper, /event\.origin\s*!==\s*'null'/u);
  const source = wrapper.match(/<script>([\s\S]*)<\/script>/u)[1];
  new vm.Script(source);
});

test("preload exposes one narrowly scoped request method without generic IPC or main bridge", async () => {
  let exposed, invoked;
  const context = { require(name) {
    assert.equal(name, "electron");
    return { contextBridge: { exposeInMainWorld(name, api) { exposed = { name, api }; } },
      ipcRenderer: { invoke(channel, message) { invoked = { channel, message }; return Promise.resolve("reply"); } } };
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../app/desktop-plugin-app-preload.js"), "utf8"), context);
  assert.equal(exposed.name, "pluginAppBridge");
  assert.deepEqual(Object.keys(exposed.api), ["request"]);
  assert.equal(Object.isFrozen(exposed.api), true);
  assert.equal(await exposed.api.request({ method: "ping" }), "reply");
  assert.equal(invoked.channel, CHANNEL);
});

test("Host pins main-frame sender and creates a private sandbox with all ambient capabilities denied", async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.host.open(f.options), { opened: true });
    const window = f.instances[0], partition = f.partitions[0], handler = f.handlers.get(CHANNEL);
    const preferences = window.options.webPreferences;
    assert.equal(preferences.session, partition);
    assert.equal(preferences.nodeIntegration, false);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.webviewTag, false);
    assert.equal(preferences.devTools, false);
    assert.doesNotMatch(partition.name, /^persist:/u);
    assert.equal(partition.options.cache, false);
    assert.match(window.headers.get("content-security-policy"), /frame-src 'self'/u);
    assert.equal(window.headers.get("cache-control"), "no-store");
    assert.equal(window.headers.get("referrer-policy"), "no-referrer");
    assert.equal(window.headers.get("x-content-type-options"), "nosniff");
    let permission;
    partition.permissionRequest(window.webContents, "camera", value => { permission = value; });
    assert.equal(permission, false); assert.equal(partition.permissionCheck(), false);
    for (const url of ["https://example.invalid/", "http://127.0.0.1:1/", "file:///tmp/fixture",
      "data:text/html,fixture", "https://example.invalid/a.js", `${window.url}?redirect=1`]) {
      let decision; partition.beforeRequest({ url }, result => { decision = result; });
      assert.equal(decision.cancel, true);
      assert.equal(navigation(window.webContents, "will-frame-navigate", url), true);
    }
    assert.equal(navigation(window.webContents, "will-navigate", window.url), true);
    assert.equal(navigation(window.webContents, "will-attach-webview", ""), true);
    assert.deepEqual(window.popup({ url: "https://example.invalid" }), { action: "deny" });
    let downloadPrevented = false;
    partition.emit("will-download", { preventDefault() { downloadPrevented = true; } });
    assert.equal(downloadPrevented, true);
    const message = { jsonrpc: "2.0", id: 1, method: "ping" };
    assert.deepEqual(await handler(eventFor(window), message), { result: message });
    const main = window.webContents.mainFrame;
    await assert.rejects(handler({ sender: window.webContents, senderFrame: { url: main.url } }, message));
    await assert.rejects(handler({ sender: { id: -1, mainFrame: main }, senderFrame: main }, message));
    main.url = "about:blank";
    await assert.rejects(handler(eventFor(window), message));
    assert.equal(f.requests.length, 1);
    window.destroy(); await tick();
    await assert.rejects(handler(eventFor(window), message));
  } finally { await f.host.closeAll(); }
});

test("resource assembly rejects malformed descriptor, chunks, integrity and UTF-8 before rendering", async () => {
  const cases = [
    { alter: value => { value.transport.sourceId = "wrong-source"; } },
    { alter: value => { value.sandboxOrigin = "https://other.invalid"; } },
    { alter: value => { value.resource.byteLength = -1; } },
    { alter: value => { value.resource.byteLength = 192 * 1024 + 1; } },
    { alter: value => { value.resource.chunkCount = 17; } },
    { alter: value => { value.resource.contentDigest = "0".repeat(64); } },
    { read: ({ chunks }) => ({ index: 1, data: chunks[0], total: chunks.length }) },
    { read: ({ chunks }) => ({ index: 0, data: chunks[0], total: 2 }) },
    { read: () => ({ index: 0, data: "x".repeat(24 * 1024 + 1), total: 1 }) },
    { read: ({ chunks }) => ({ index: 0, data: chunks[0].replace(/.$/u, "!"), total: 1 }) },
    { read: ({ chunks }) => ({ index: 0, data: `A${chunks[0].slice(1)}`, total: 1 }) },
    { html: Buffer.from([0xff, 0xfe, 0xfd]) },
  ];
  for (const options of cases) {
    const f = fixture(options);
    try {
      await assert.rejects(f.host.open(f.options));
      assert.equal(f.instances.length, 0, "reject before creating a renderer");
      assert.equal(f.closes.length, 1, "allocated authority must close after validation failure");
      await assert.rejects(fetch(`${f.createInput.sandboxOrigin}/anything`));
    } finally { await f.host.closeAll(); }
  }
});

test("all chunk boundaries including UTF-8 multibyte content reconstruct exactly", async () => {
  const html = `<!doctype html><html><body>${"文😀".repeat(8000)}</body></html>`;
  const f = fixture({ html });
  try {
    await f.host.open(f.options);
    assert.ok(f.descriptor.resource.chunkCount > 1);
    assert.ok(f.instances[0].html.includes("文😀"));
  } finally { await f.host.closeAll(); }
});

test("closeAll awaits authority disposal exactly once even when closed event starts cleanup", async () => {
  const gate = defer(); const f = fixture({ onClose: () => gate.promise });
  try {
    await f.host.open(f.options);
    let finished = false;
    const close = f.host.closeAll().then(() => { finished = true; });
    await tick();
    assert.equal(finished, false, "closeAll must await the same cleanup promise as the closed event");
    gate.resolve(); await close;
    assert.equal(f.closes.length, 1);
    assert.equal(f.host.windows.size, 0);
  } finally { gate.resolve(); await f.host.closeAll(); }
});

test("load failure and expiry destroy renderer and release session", async () => {
  const failing = fixture({ loadError: new Error("fixture load error") });
  await assert.rejects(failing.host.open(failing.options), /fixture load error/u);
  assert.equal(failing.instances[0].destroyed, true);
  assert.equal(failing.closes.length, 1);
  const expiring = fixture({ expiresIn: 80 });
  try {
    await expiring.host.open(expiring.options);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(expiring.instances[0].destroyed, true);
    assert.equal(expiring.closes.length, 1);
  } finally { await expiring.host.closeAll(); }
});

test("concurrent openings reserve the eight-window limit before awaiting untrusted resources", async () => {
  const gate = defer(); const f = fixture({ createWait: gate.promise });
  const first = Array.from({ length: 8 }, () => f.host.open(f.options));
  let ninth;
  try {
    const outcome = await Promise.race([
      f.host.open(f.options).then(value => { ninth = value; return "opened"; }, () => "rejected"),
      new Promise(resolve => setTimeout(() => resolve("pending"), 30)),
    ]);
    assert.equal(outcome, "rejected");
  } finally {
    gate.resolve();
    const completed = await Promise.allSettled(first);
    assert.equal(completed.filter(entry => entry.status === "fulfilled").length, 8);
    await tick(); await f.host.closeAll();
    void ninth;
  }
});

test("message dispatch failure closes its renderer and releases authority", async () => {
  const f = fixture({ onMessage: async () => { throw new Error("fixture revoked"); } });
  try {
    await f.host.open(f.options);
    await assert.rejects(f.handlers.get(CHANNEL)(eventFor(f.instances[0]), { method: "ping" }), /fixture revoked/u);
    assert.equal(f.instances[0].destroyed, true);
    assert.equal(f.host.windows.size, 0);
    assert.equal(f.closes.length, 1);
  } finally { await f.host.closeAll(); }
});

test("closing Host cancels in-progress opening and prevents late renderer creation", async () => {
  const gate = defer(); const f = fixture({ createWait: gate.promise });
  const opening = f.host.open(f.options);
  await tick();
  const closing = f.host.closeAll();
  gate.resolve();
  await assert.rejects(opening);
  await closing;
  assert.equal(f.instances.length, 0);
  assert.equal(f.closes.length, 1);
  assert.equal(f.host.windows.size, 0);
  await assert.rejects(f.host.open(f.options));
});

test("committed top navigation and renderer failure revoke authority even if prevention events are bypassed", async () => {
  for (const event of ["did-navigate", "did-fail-load", "render-process-gone"]) {
    const f = fixture();
    try {
      await f.host.open(f.options);
      const window = f.instances[0];
      window.webContents.emit(event, {}, "about:blank");
      assert.equal(window.destroyed, true);
      await f.host.closeAll();
      assert.equal(f.closes.length, 1);
      assert.equal(f.host.windows.size, 0);
    } finally { await f.host.closeAll(); }
  }
});
