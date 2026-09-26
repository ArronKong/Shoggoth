import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "app/manage-ui/package.json"));
const ts = require("typescript");
const source = fs.readFileSync(path.join(root, "app/manage-ui/src/lib/productTelemetry.ts"), "utf8");
const clientSource = fs.readFileSync(path.join(root, "app/manage-ui/src/api/client.ts"), "utf8");
const clientAst = ts.createSourceFile("client.ts", clientSource, ts.ScriptTarget.Latest, true);
const bridgeFunction = clientAst.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "getDesktopProductTelemetry");
assert.ok(bridgeFunction);
const transpile = (text) => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture(desktop = true) {
  let at = Date.parse("2026-09-10T23:59:59.999Z");
  let mono = 0;
  let focused = true;
  let calls = 0;
  const listeners = new Map();
  class Element {
    constructor(excluded = false) { this.excluded = excluded; }
    closest(selector) { assert.equal(selector, "[data-product-telemetry-exclude]"); return this.excluded ? this : null; }
    get textContent() { throw new Error("must not read text"); }
    get value() { throw new Error("must not read input values"); }
  }
  const document = {
    visibilityState: "visible", hasFocus: () => focused,
    addEventListener(name, listener, options) { assert.equal(options.passive, true); assert.equal(options.capture, true); listeners.set(name, listener); },
    removeEventListener(name, listener) { assert.equal(listeners.get(name), listener); listeners.delete(name); },
  };
  const window = { location: { hash: "#/chat" }, ...(desktop ? { openclawDesktop: { productTelemetry: { recordActivity(...args) { assert.equal(args.length, 0); calls++; } } } } : {}) };
  const globals = { window, document, Element, performance: { now: () => mono },
    Date: class extends Date { constructor() { super(at); } } };
  const clientExports = {};
  vm.runInNewContext(transpile(bridgeFunction.getText(clientAst)), { ...globals, exports: clientExports });
  const exports = {};
  vm.runInNewContext(transpile(source), { ...globals, exports, require(id) { assert.equal(id, "../api/client"); return clientExports; } });
  const dispose = exports.installProductActivityListener();
  const emit = (type, options = {}) => {
    const event = { type, isTrusted: true, target: new Element(), ...options };
    for (const field of ["key", "code", "clientX", "clientY", "deltaX", "deltaY", "data"]) {
      Object.defineProperty(event, field, { get() { throw new Error(`must not read ${field}`); } });
    }
    listeners.get(type)?.(event);
  };
  return { document, window, listeners, dispose, emit, Element, calls: () => calls,
    advance(ms) { at += ms; mono += ms; }, focus(value) { focused = value; } };
}

const f = fixture();
assert.deepEqual([...f.listeners.keys()], ["pointerdown", "keydown", "wheel"]);
assert.equal(f.calls(), 0, "mounting never produces activity");
for (const type of ["scroll", "visibilitychange", "focus", "load", "message", "input", "click"]) f.emit(type);
f.emit("pointerdown", { isTrusted: false });
assert.equal(f.calls(), 0, "auto-scroll, focus, messages and JS synthetic clicks never count");
f.document.visibilityState = "hidden"; f.emit("keydown");
f.document.visibilityState = "visible"; f.focus(false); f.emit("wheel"); f.focus(true);
f.emit("pointerdown", { target: new f.Element(true) });
for (const route of ["/glass", "/components", "/turnlab", "/", "/unknown", "/chat/unknown"]) {
  f.window.location.hash = `#${route}`; f.emit("pointerdown");
}
assert.equal(f.calls(), 0);
f.window.location.hash = "#/chat?session=SECRET_CANARY";
f.emit("wheel");
assert.equal(f.calls(), 1);
for (let n = 0; n < 1000; n++) f.emit("pointerdown");
assert.equal(f.calls(), 1);
f.advance(1); f.emit("keydown");
assert.equal(f.calls(), 2, "UTC midnight is not swallowed by the 60-second throttle");
for (const route of ["/chat", "/dashboard", "/tasks", "/cron", "/models", "/skills", "/agents", "/token", "/cli", "/settings"]) {
  f.advance(60_000); f.window.location.hash = `#${route}`; f.emit("pointerdown");
}
assert.equal(f.calls(), 12);
f.dispose(); assert.equal(f.listeners.size, 0);
const browser = fixture(false);
assert.equal(browser.listeners.size, 0, "plain browser preview installs no collector/listeners");
browser.emit("pointerdown"); assert.equal(browser.calls(), 0); browser.dispose();
assert.doesNotMatch(source, /fetch\(|localStorage|sessionStorage|\.track\(|randomUUID/u);
const appSource = fs.readFileSync(path.join(root, "app/manage-ui/src/App.tsx"), "utf8");
assert.match(appSource, /useEffect\(installProductActivityListener, \[\]\)/u);
console.log("Product telemetry UI: trusted input, foreground, route eligibility, midnight, content boundary, cleanup and browser no-op passed");
