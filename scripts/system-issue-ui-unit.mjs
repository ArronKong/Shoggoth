import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const uiRequire = createRequire(path.join(root, "app/manage-ui/package.json"));
const ts = uiRequire("typescript"), React = uiRequire("react");
const { create, act } = uiRequire("react-test-renderer");
const clone = value => JSON.parse(JSON.stringify(value));
function load(relative, require = uiRequire, globals = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(root, "app/manage-ui/src", relative), "utf8"), {
    fileName: relative, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(`(function(require,module,exports){${code}\n})(require,module,module.exports);`, {
    module, require, console, ...globals,
  }, { filename: relative });
  return module.exports;
}
function fixture(locale = "zh-CN") {
  let now = 100_000, callback, subscriptions = 0, writes = 0, ui;
  const manager = { toasts: [], notices: [], closed: [],
    add(value) { this.notices.push(clone(value)); }, close(id) { this.closed.push(id); } };
  const dictionary = load(`i18n/locales/${locale}.ts`, name => name === "../productToolLabels"
    ? load("i18n/productToolLabels.ts") : uiRequire(name)).default;
  const t = key => key.split(".").reduce((value, part) => value?.[part], dictionary) ?? key;
  const clock = { now: () => now };
  const issues = load("lib/system-issues.ts", uiRequire, { Date: clock });
  const window = { openclawDesktop: { onSystemIssue: value => {
    callback = value; subscriptions++; return () => { subscriptions--; callback = null; };
  } }, location: { reload() { window.reloads++; } }, reloads: 0 };
  const pass = ({ children }) => children ?? null;
  const Toast = { Provider: pass, Portal: pass, Viewport: pass, Root: pass, Title: () => null,
    useToastManager: () => manager };
  const localRequire = name => {
    if (name.endsWith(".css")) return {};
    if (name === "react-i18next") return { useTranslation: () => ({ t }) };
    if (name === "@base-ui/react/toast") return { Toast };
    if (name === "@base-ui/react/alert-dialog") return { AlertDialog: {
      Root: () => null, Portal: pass, Backdrop: () => null, Popup: pass, Title: pass,
    } };
    if (name.endsWith("/lib/system-issues")) return issues;
    if (name === "./ui") return ui;
    return uiRequire(name);
  };
  ui = load("components/ui.tsx", localRequire, { Date: clock, window });
  const Notices = load("components/SystemIssueToasts.tsx", localRequire, { window }).default;
  const Boundary = load("components/UiResourceBoundary.tsx", localRequire, { window }).default;
  const state = { issues, manager, t, window, Notices, Boundary, ui,
    advance: ms => { now += ms; }, notify: value => callback(value),
    subscriptions: () => subscriptions, writes: () => writes, response: null, toast: null };
  const api = load("api/client.ts", name => {
    if (name === "i18next") return { __esModule: true, default: { t } };
    if (name === "../lib/system-issues") return issues;
    if (name === "./memoryProviderOwnerDto" || name === "../lib/cronVisibility" || name === "../lib/runtimeVisibility") return {};
    return uiRequire(name);
  }, { fetch: async () => { writes++; return { ok: false, status: 409, text: async () => JSON.stringify(state.response) }; } });
  state.api = api;
  function Capture() { state.toast = ui.useToast(); return null; }
  state.render = child => React.createElement(ui.UiProvider, null,
    React.createElement(Notices), React.createElement(Capture), child);
  return state;
}

test("bootstrap queues only known notices, gives confirmed disk-full priority and tolerates notification failure", () => {
  const f = fixture();
  for (const value of [null, "STORAGE_FULL", { code: "ENOENT" }, { code: "OTHER" }]) assert.equal(f.issues.parseSystemIssue(value), null);
  assert.equal(f.issues.parseSystemIssue({ code: "STORAGE_FULL", path: "private" }), "STORAGE_FULL");
  f.issues.publishSystemIssue("UI_RESOURCE_UNAVAILABLE");
  f.issues.publishSystemIssue("STORAGE_FULL");
  f.issues.publishSystemIssue("UI_RESOURCE_UNAVAILABLE");
  const values = [], stop = f.issues.subscribeSystemIssues(code => values.push(code));
  assert.deepEqual(values, ["STORAGE_FULL"]);
  stop(); f.issues.publishSystemIssue("STORAGE_FULL");
  assert.doesNotThrow(() => f.issues.subscribeSystemIssues(() => { throw new Error("toast unavailable"); }));
});

for (const locale of ["zh-CN", "en"]) {
  test(`actual React toast and API client localize ${locale}, deduplicate IPC/request errors and preserve operation outcomes`, async () => {
    const f = fixture(locale);
    f.issues.publishSystemIssue("STORAGE_FULL");
    let tree;
    act(() => { tree = create(f.render()); });
    assert.equal(f.subscriptions(), 1);
    assert.deepEqual(f.manager.notices, [{ id: "system-STORAGE_FULL", title: f.t("common.diskFull"), type: "error", timeout: 8000 }]);
    f.notify({ code: "OTHER", message: "private stack" });
    f.notify({ code: "STORAGE_FULL", message: "private stack" });
    f.response = { systemIssue: "STORAGE_FULL", error: "private path", code: "journal_commit_unknown",
      stage: "commit", details: { operationId: "safe-operation" } };
    let error;
    try { await f.api.updateConfig({ theme: "dark" }); } catch (value) { error = value; }
    assert.ok(error instanceof f.api.ApiError);
    assert.equal(error.message, f.t("common.diskFull"));
    assert.equal(error.status, 409); assert.equal(error.code, "journal_commit_unknown");
    assert.equal(error.stage, "commit"); assert.equal(error.details.operationId, "safe-operation");
    f.toast.error(`Save failed: ${error.message}`);
    assert.equal(f.manager.notices.length, 1, "request catch and IPC must show only one toast");
    assert.equal(f.writes(), 1, "notification must not replay a failed or uncertain write");
    f.advance(30_000); f.notify({ code: "STORAGE_FULL" });
    assert.equal(f.manager.notices.length, 2);
    f.toast.error("An unrelated failure");
    assert.equal(f.manager.notices.at(-1).timeout, 4200);
    act(() => tree.unmount()); assert.equal(f.subscriptions(), 0);
  });
}

test("ordinary resource errors stay generic, and failed lazy pages preserve the shell and recover on navigation", () => {
  const f = fixture(); let tree, mounts = 0, unmounts = 0;
  function Healthy() {
    React.useEffect(() => { mounts++; return () => { unmounts++; }; }, []);
    return React.createElement("p", null, "healthy page");
  }
  function Broken() { throw new Error("Failed to fetch dynamically imported module: private URL"); }
  const render = (key, child) => f.render(React.createElement(f.Boundary, { resetKey: key }, child));
  act(() => { tree = create(render("/chat", React.createElement(Healthy))); });
  act(() => tree.update(render("/settings", React.createElement(Healthy))));
  assert.equal(mounts, 1); assert.equal(unmounts, 0, "healthy children must not remount on route changes");
  const log = console.error;
  try {
    console.error = () => {};
    act(() => tree.update(render("/agents", React.createElement(Broken))));
  } finally { console.error = log; }
  assert.equal(f.manager.notices.at(-1).title, f.t("common.uiResourceUnavailable"));
  assert.equal(f.manager.notices.at(-1).id, "system-UI_RESOURCE_UNAVAILABLE");
  assert.equal(f.subscriptions(), 1, "notification bridge remains mounted after page failure");
  const button = tree.root.findByType("button");
  assert.equal(button.props.children, f.t("common.reloadPage"));
  act(() => button.props.onClick()); assert.equal(f.window.reloads, 1);
  act(() => tree.update(render("/settings", React.createElement(Healthy))));
  assert.ok(JSON.stringify(tree.toJSON()).includes("healthy page"));
  f.notify({ code: "STORAGE_FULL" });
  assert.ok(f.manager.closed.includes("system-UI_RESOURCE_UNAVAILABLE"));
  assert.equal(f.manager.notices.at(-1).title, f.t("common.diskFull"));
  act(() => tree.unmount());
});

test("ENOENT API failures do not become a disk-full notice", async () => {
  const f = fixture(); let tree;
  act(() => { tree = create(f.render()); });
  f.response = { code: "ENOENT", error: "File missing" };
  await assert.rejects(f.api.updateConfig({ theme: "dark" }), error => error.message === "File missing" && error.code === "ENOENT");
  assert.equal(f.manager.notices.length, 0);
  act(() => tree.unmount());
});
