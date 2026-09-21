import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const ui = path.resolve(import.meta.dirname, "../app/manage-ui");
const require = createRequire(path.join(ui, "package.json"));
const React = require("react");
const { act, create } = require("react-test-renderer");
const ts = require("typescript");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const pending = [];
const notices = [];
let guard;
const deferred = (name, args) => new Promise((resolve, reject) => pending.push({ name, args, resolve, reject }));
const api = {
  listAgentMemories: (...args) => deferred("list", args),
  mutateAgentMemory: (...args) => deferred("write", args),
};
function load(relative) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(ui, relative), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, Date, Set, Error,
    require: (name) => {
      if (name.endsWith(".css")) return {};
      if (name.endsWith("/api/client")) return api;
      if (name.endsWith("/components/ui")) return { useToast: () => ({ success: (value) => notices.push(value) }) };
      if (name.endsWith("/navigation-guard")) return { useNavigationGuard: (value) => { guard = value; } };
      if (name === "react-i18next") return { useTranslation: () => ({ t: (key) => key }) };
      return require(name);
    },
  });
  return module.exports;
}
const Editor = load("src/pages/agents/AgentMemoryEditor.tsx").default;
const { visibleAgentFiles } = load("src/lib/agentFiles.ts");
assert.deepEqual(Array.from(visibleAgentFiles([{ name: "MEMORY.md" }, { name: "TOOLS.md" }, { name: "tools.md" }]), (file) => file.name), ["MEMORY.md"]);
const item = (id, content) => ({ id, content, status: "active", scope: "agent", type: "semantic",
  confidence: 1, validUntil: null, sensitivity: "normal", updatedAt: 1, validFrom: 0 });
const page = (items, revision, hasMore = false, nextCursor = items.length) => ({ supported: true, items, revision, hasMore, nextCursor });
let renderer;
const view = (agentId) => React.createElement(Editor, { key: agentId, backendId: "shoggoth", agentId });
const settle = async (value, reject = false) => {
  const request = pending.shift(); assert.ok(request);
  await act(async () => { request[reject ? "reject" : "resolve"](value); });
  return request;
};
await act(async () => { renderer = create(view("a")); });
assert.equal(pending[0].args[1], "a");
// An older Agent response must never overwrite the newly selected Agent.
await act(async () => { renderer.update(view("b")); });
await settle(page([item("old", "other Agent")], 1));
assert.equal(renderer.root.findAllByType("textarea").length, 0);
await settle(page([item("one", "first"), item("two", "second")], 2, true));
const entries = () => renderer.root.findAllByType("article");
const text = (index) => entries()[index].findByType("textarea");
const saveButton = (index) => entries()[index].findAllByType("button").at(-1);
await act(async () => {
  text(0).props.onChange({ target: { value: "unsaved first" } });
  text(1).props.onChange({ target: { value: "saved second" } });
});
assert.equal(guard.dirty, true);
await act(async () => { saveButton(1).props.onClick(); });
assert.equal(guard.busy, true);
assert.equal(pending[0].args[1], "b");
assert.equal(pending[0].args[3].expectedRevision, 2);
await settle({ revision: 3, item: { ...item("two", "saved second"), updatedAt: 3 } });
assert.ok(renderer.root.findAllByType("textarea").some((node) => node.props.value === "unsaved first"));
assert.equal(guard.dirty, true, "saving one record preserves another record's draft");
const more = () => renderer.root.findAllByType("button").find((node) => node.children.includes("common.loadMore"));
await act(async () => { more().props.onClick(); });
assert.equal(pending[0].args[4], 2);
await settle(page([item("three", "third")], 3, false, 3));
assert.equal(entries().length, 3);
const first = entries().find((entry) => entry.findByType("textarea").props.value === "unsaved first");
await act(async () => { first.findAllByType("button").at(-1).props.onClick(); });
await settle(new Error("HARNESS_REVISION_CONFLICT"), true);
assert.ok(renderer.root.findAllByType("textarea").some((node) => node.props.value === "unsaved first"));
assert.equal(notices.length, 1, "failed saves never report success");
assert.equal(renderer.root.findByProps({ role: "alert" }).findByType("p").children[0], "HARNESS_REVISION_CONFLICT");
await act(async () => { renderer.unmount(); });

// A completed write on a closed editor must not toast or mutate another Agent.
await act(async () => { renderer = create(view("c")); });
await settle(page([item("four", "fourth")], 4));
await act(async () => {
  renderer.root.findAllByType("article")[0].findByType("textarea").props.onChange({ target: { value: "changed" } });
});
await act(async () => { saveButton(0).props.onClick(); });
await act(async () => { renderer.unmount(); });
await settle({ revision: 5, item: item("four", "changed") });
assert.equal(notices.length, 1);
console.log("PASS memory editor: hidden TOOLS, Agent response isolation, independent drafts, pagination, stale-save errors and closed-editor writes");
