import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "app/manage-ui/package.json"));
const ts = require("typescript");
const catalog = require(path.join(root, "app/core/data/product-telemetry-catalog.json"));
const source = fs.readFileSync(path.join(root, "app/manage-ui/src/lib/productTelemetry.ts"), "utf8");
const clientSource = fs.readFileSync(path.join(root, "app/manage-ui/src/api/client.ts"), "utf8");
const clientAst = ts.createSourceFile("client.ts", clientSource, ts.ScriptTarget.Latest, true);
const bridgeFunction = clientAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "getDesktopProductTelemetry");
assert.ok(bridgeFunction);
const transpile = text => ts.transpileModule(text, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
} }).outputText;

async function fixture(desktop = true) {
  let at = Date.parse("2026-09-10T23:59:59.999Z");
  let mono = 0;
  let focused = true;
  let noticeOpen = false;
  let uuidCalls = 0;
  let settings = { available: true, collectionAvailable: true, enabled: true, detailedEnabled: true,
    basicEpoch: randomUUID(), detailedEpoch: randomUUID() };
  const calls = [];
  const listeners = new Map();
  class Element {
    constructor(excluded = false) { this.excluded = excluded; }
    closest(selector) { assert.match(selector, /data-product-telemetry-exclude/); return this.excluded ? this : null; }
    get textContent() { throw new Error("must not read text"); }
    get value() { throw new Error("must not read input values"); }
  }
  const document = {
    visibilityState: "visible", hasFocus: () => focused,
    querySelector(selector) { assert.equal(selector, ".product-telemetry-privacy[data-open]"); return noticeOpen ? new Element(true) : null; },
    addEventListener(name, listener, options) { assert.equal(options.passive, true); assert.equal(options.capture, true); listeners.set(name, listener); },
    removeEventListener(name, listener) { assert.equal(listeners.get(name), listener); listeners.delete(name); },
  };
  const set = (field, enabled) => {
    const next = { ...settings, [field]: enabled };
    if (field === "enabled") next.basicEpoch = enabled ? randomUUID() : null;
    next.detailedEpoch = next.enabled && next.detailedEnabled ? randomUUID() : null;
    settings = next;
    return { error: null, settings };
  };
  const window = { location: { hash: "#/chat" }, addEventListener() {}, removeEventListener() {},
    ...(desktop ? { openclawDesktop: { productTelemetry: {
      record: value => calls.push(JSON.parse(JSON.stringify(value))),
      getSettings: async () => settings,
      setEnabled: async enabled => set("enabled", enabled),
      setDetailedEnabled: async enabled => set("detailedEnabled", enabled),
    } } } : {}) };
  const globals = { window, document, Element, performance: { now: () => mono },
    Date: class extends Date { constructor() { super(at); } },
    crypto: { randomUUID: () => { uuidCalls++; return randomUUID(); } } };
  const clientExports = {};
  vm.runInNewContext(transpile(bridgeFunction.getText(clientAst)), { ...globals, exports: clientExports });
  const helpers = {};
  vm.runInNewContext(transpile(source), { ...globals, exports: helpers, require(id) {
    if (id === "../api/client") return clientExports;
    if (id === "react") return {};
    assert.equal(id, "../../../core/data/product-telemetry-catalog.json");
    return catalog;
  } });
  const dispose = helpers.installProductActivityListener();
  await new Promise(resolve => setImmediate(resolve));
  const emit = (type, options = {}) => {
    const event = { type, isTrusted: true, target: new Element(), ...options };
    for (const field of ["key", "code", "clientX", "clientY", "deltaX", "deltaY", "data"]) {
      Object.defineProperty(event, field, { get() { throw new Error(`must not read ${field}`); } });
    }
    listeners.get(type)?.(event);
  };
  return { document, window, listeners, dispose, emit, Element, calls, helpers, uuidCalls: () => uuidCalls,
    advance(ms) { at += ms; mono += ms; }, focus(value) { focused = value; }, openNotice(value) { noticeOpen = value; } };
}

const f = await fixture();
assert.deepEqual([...f.listeners.keys()], ["pointerdown", "keydown", "wheel"]);
assert.equal(f.calls.length, 0, "mounting never produces activity");
assert.equal(f.helpers.startTelemetryOperation("chat_send", "shoggoth"), undefined);
for (const type of ["scroll", "visibilitychange", "focus", "load", "message", "input", "click"]) f.emit(type);
f.emit("pointerdown", { isTrusted: false });
assert.equal(f.calls.length, 0, "auto-scroll, focus, messages and JS synthetic clicks never count");
f.document.visibilityState = "hidden"; f.emit("keydown");
f.document.visibilityState = "visible"; f.focus(false); f.emit("wheel"); f.focus(true);
f.emit("pointerdown", { target: new f.Element(true) });
f.openNotice(true);
f.emit("pointerdown");
f.emit("keydown", { target: f.document });
f.openNotice(false);
for (const route of ["/glass", "/components", "/turnlab", "/", "/unknown", "/chat/unknown"]) {
  f.window.location.hash = `#${route}`; f.emit("pointerdown");
}
assert.equal(f.calls.length, 0);
f.window.location.hash = "#/chat?session=SECRET_CANARY";
f.emit("wheel");
assert.deepEqual(f.calls.map(row => [row.kind, row.payload]), [["activity", {}], ["page_used", { page: "chat" }]]);
for (let n = 0; n < 1000; n++) f.emit("pointerdown");
assert.equal(f.calls.length, 2);
f.advance(1); f.emit("keydown");
assert.equal(f.calls.filter(row => row.kind === "activity").length, 2, "UTC midnight bypasses the 60-second throttle");
for (const [route, name] of Object.entries(catalog.pages)) {
  f.advance(60_000); f.window.location.hash = `#${route}`; f.emit("pointerdown");
  assert.ok(f.calls.some(row => row.kind === "page_used" && row.payload.page === name));
}
const result = { id: "SECRET_CANARY" };
assert.equal(await f.helpers.measureTelemetry("inspiration_create", "PRIVATE_BACKEND", async () => result), result);
assert.deepEqual(f.calls.slice(-2).map(row => row.kind), ["feature_start", "feature_end"]);
assert.equal(f.calls.at(-2).payload.backendType, "other");
assert.equal(f.calls.at(-1).payload.outcome, "success");
const operation = f.helpers.startTelemetryOperation("chat_send", "shoggoth");
assert.ok(operation);
await f.helpers.changeTelemetrySetting("detailedEnabled", false);
const previous = f.calls.length, uuidCalls = f.uuidCalls();
assert.equal(f.helpers.startTelemetryOperation("chat_send"), undefined);
assert.equal(f.uuidCalls(), uuidCalls);
f.advance(60_000); f.emit("wheel");
assert.deepEqual(f.calls.slice(previous).map(row => row.kind), ["activity"]);
await f.helpers.changeTelemetrySetting("detailedEnabled", true);
operation.finish("success");
assert.equal(f.calls.length, previous + 1, "a callback from a revoked epoch is ignored");
await f.helpers.changeTelemetrySetting("enabled", false);
assert.equal(f.listeners.size, 0, "master opt-out detaches interaction listeners");
f.advance(60_000); f.emit("keydown");
assert.equal(f.calls.length, previous + 1);
assert.equal(JSON.stringify(f.calls).includes("SECRET_CANARY"), false);
assert.deepEqual(JSON.parse(JSON.stringify(f.helpers.telemetryModel("PRIVATE_PROVIDER", "SECRET_CANARY"))),
  { providerId: "custom", modelId: "custom" });
f.dispose();
const browser = await fixture(false);
assert.equal(browser.listeners.size, 0);
assert.equal(browser.helpers.startTelemetryOperation("chat_send"), undefined);
browser.emit("pointerdown"); assert.equal(browser.calls.length, 0); browser.dispose();
assert.doesNotMatch(source, /fetch\(|localStorage|sessionStorage|\.track\(/u);
console.log("Product telemetry UI: real-input eligibility, UTC, daily page categories, narrow actions, opt-out and browser isolation passed");
