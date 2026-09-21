import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const require = createRequire(path.join(uiRoot, "package.json"));
const ts = require("typescript");
const React = require("react");
const { create, act } = require("react-test-renderer");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const compile = (file, stubs = {}) => {
  const mod = { exports: {} };
  const source = fs.readFileSync(path.join(uiRoot, "src", file), "utf8");
  const { outputText } = ts.transpileModule(source, { fileName: file, compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } });
  vm.runInNewContext(outputText, { exports: mod.exports, require: name => stubs[name] || require(name) });
  return mod.exports;
};
const agentDisplay = compile("lib/agentDisplay.ts");
const { applyChatSessionAgentNames, mergeLinkedSessionRows, openChatSessionLink } = compile("lib/chatSessionNavigation.ts", {
  "./agentDisplay": agentDisplay,
});
const { createChatHistoryController } = compile("lib/chatHistoryRuntime.ts");
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = () => new Promise(setImmediate);
const existing = { key: "agent:worker:main", backendId: "openclaw" };
const cron = { key: "agent:worker:cron:job:run:42", backendId: "openclaw" };

// The display name belongs to the agent, including before its new session is
// listed by the backend. Never derive it from a UUID or the session title.
for (const [agentId, name, backendId] of [
  ["shoggoth-61ccd39b-7a29-8bbc-a47c-3af127d719b8", "溪桥", "shoggoth"],
  ["shoggoth-f8a76c25-bd49-4c12-9d63-7b7d1eb1d0a4", "Shoggoth", "shoggoth"],
  ["ada", "Product", "openclaw"], ["main", "CEO", "openclaw"],
  ["hermes-bull", "bull · Hermes", "hermes"],
  ["codex-c79e0e41-2c12-8cc9-978b-aa7882d56be4", "星帆", "codex"],
  ["deepseek-harness-2031c7ed-e75e-8a61-8cf4-ea24551b3887", "晴川", "deepseek-harness"],
  ["shoggoth-grok", "Grok", "grok-build"], ["shoggoth-antigravity", "Antigravity", "antigravity"],
  ["shoggoth-pi", "Pi", "pi"], ["shoggoth-claude", "Claude", "claude-code"],
]) {
  const old = { key: `agent:${agentId}:main`, agentId, agentName: name, backendId };
  const fresh = { key: `agent:${agentId}:new`, backendId, model: "fixture-model" };
  const names = agentDisplay.createAgentNameIndex([{ id: agentId, name }]);
  for (const catalog of [names, {}]) {
    const [created] = applyChatSessionAgentNames([fresh], catalog, [old]);
    assert.equal(created.agentName, name, `${name}: immediate /new with or without agents.list`);
    assert.equal(created.key, fresh.key, "name enrichment must not change routing or avatar identity");
    assert.equal(created.model, fresh.model);
    assert.equal(fresh.agentName, undefined, "do not mutate the input row");
    const linked = new Map([[fresh.key, created]]);
    let rows = applyChatSessionAgentNames(mergeLinkedSessionRows([old], linked, [old]), catalog, [old, created]);
    assert.equal(rows.find(row => row.key === fresh.key).agentName, name, "omitted new rows keep the agent name after refresh");
    rows = applyChatSessionAgentNames(mergeLinkedSessionRows([old, fresh], linked, [old, fresh]), catalog, rows);
    assert.equal(rows.find(row => row.key === fresh.key).agentName, name, "an authoritative row without agentName inherits the known name");
    assert.equal(linked.size, 0);
    const renamed = agentDisplay.createAgentNameIndex([{ id: agentId, name: `${name}新版` }]);
    rows = applyChatSessionAgentNames(rows, renamed, rows);
    assert.ok(rows.every(row => row.agentName === `${name}新版`), "a current roster rename wins for all sessions");
  }
}
{
  const rows = [
    { key: "agent:main:empty", agentId: "main" },
    { key: "agent:hermes-main:empty", agentId: "main" },
    { key: "agent:other:empty", displayName: "Conversation title" },
  ];
  const names = agentDisplay.createAgentNameIndex([{ id: "main", name: "CEO" }, { id: "hermes-main", name: "Hermes" }]);
  const enriched = applyChatSessionAgentNames(rows, names);
  assert.equal(enriched[0].agentName, "CEO");
  assert.equal(enriched[1].agentName, "Hermes", "route namespace must win over backend-local agentId");
  assert.equal(enriched[2].agentName, undefined, "do not borrow another agent's name or a conversation title");
}

for (const metadataFirst of [true, false]) {
  let rows = [existing], activeKey = existing.key, quote = null, history = [];
  const linked = new Map();
  const scopeGate = gate();
  const controller = createChatHistoryController({
    backendOfSession: key => rows.find(row => row.key === key)?.backendId,
    agentOfSession: key => key.split(":")[1],
    getCacheScope: async () => { await scopeGate.promise; return "fixture"; },
    getCached: async () => undefined, putCached: async () => {}, deleteCached: async () => {}, clearCachedExcept: async () => {},
    prepare: async (_key, messages) => messages,
    requestCanonical: async key => { assert.equal(key, cron.key); return [{ role: "assistant", text: "QA_CRON_OK" }]; },
    isInFlight: () => false,
    commitOpen: key => { activeKey = key; quote = null; },
    commitCanonical: (_key, messages) => { history = messages; },
    commitFailure: () => assert.fail("canonical history should succeed"),
  });
  const metadata = () => { rows = mergeLinkedSessionRows(rows.map(row => ({ ...row, agentName: "Worker" })), linked); };
  const sessions = () => { rows = mergeLinkedSessionRows([existing], linked, [existing]); };
  const opening = openChatSessionLink(cron.key, {
    ensureSession: () => { linked.set(cron.key, cron); rows = mergeLinkedSessionRows(rows, linked); },
    openSession: controller.open,
    refreshSessions: async () => { if (metadataFirst) { metadata(); sessions(); } else { sessions(); metadata(); } },
    isCurrent: () => activeKey === cron.key,
    onOpened: () => { quote = "Exact Cron report"; },
    onError: error => { throw error; },
  });
  assert.ok(rows.some(row => row.key === cron.key), "metadata refresh followed by an omitted Cron run must not lose selection metadata");
  assert.ok(linked.has(cron.key), "metadata must not be treated as an authoritative session list");
  assert.equal(quote, null, "context must wait for the async open commit");
  scopeGate.resolve();
  await opening; await flush();
  assert.equal(activeKey, cron.key);
  assert.equal(quote, "Exact Cron report", "commitOpen must not clear the handoff quote");
  assert.equal(history[0].text, "QA_CRON_OK", "the displayed contents come from the requested session history");
  const realCron = { ...cron, label: "Retained execution" };
  rows = mergeLinkedSessionRows([existing, realCron], linked, [existing, realCron]);
  assert.equal(linked.size, 0, "the actual list row retires its placeholder");
  assert.equal(rows.filter(row => row.key === cron.key).length, 1);
  assert.equal(rows.find(row => row.key === cron.key).label, "Retained execution");
}

{
  const linked = new Map([[cron.key, cron]]);
  const retainedDuringDegradation = [existing, cron];
  mergeLinkedSessionRows(retainedDuringDegradation, linked, [existing]);
  assert.ok(linked.has(cron.key), "a row preserved for an incomplete backend is not fresh listing evidence");
}
{
  const opening = gate();
  let selected = cron.key, quoted = false;
  const pending = openChatSessionLink(cron.key, {
    ensureSession() {}, openSession: () => opening.promise, refreshSessions: async () => { throw new Error("offline"); },
    isCurrent: () => selected === cron.key, onOpened: () => { quoted = true; }, onError: () => assert.fail(),
  });
  selected = existing.key;
  opening.resolve(); await pending;
  assert.equal(quoted, false, "a delayed handoff must not attach its report to a later user selection");
}
{
  let reason;
  await openChatSessionLink(cron.key, {
    ensureSession() {}, openSession: async () => { throw new Error("History unavailable"); }, refreshSessions: async () => {},
    isCurrent: () => true, onOpened: () => assert.fail(), onError: error => { reason = error.message; },
  });
  assert.equal(reason, "History unavailable", "failure is not reported as a loaded conversation");
}

const host = type => props => React.createElement(type, props, props.children);
const RenameModal = compile("pages/ChatSessionRenameModal.tsx", {
  "react-i18next": { useTranslation: () => ({ t: key => key }) },
  "../components/Modal": props => React.createElement("dialog", props, props.children, props.footer),
  "../components/Field": { Field: host("label"), TextInput: host("input") },
}).default;
{
  const calls = [];
  let closeCount = 0, result = gate(), renderer;
  await act(async () => { renderer = create(React.createElement(RenameModal, {
    target: { key: cron.key, label: "Original" }, onClose: () => { closeCount++; },
    onSubmit: (key, label) => { calls.push({ key, label }); return result.promise; },
  })); });
  const input = () => renderer.root.findByType("input");
  const form = () => renderer.root.findByType("form");
  const submit = () => form().props.onSubmit({ preventDefault() {} });
  assert.equal(input().props.value, "Original");
  let composingSubmitPrevented = false;
  act(() => input().props.onKeyDown({ key: "Enter", nativeEvent: { isComposing: true },
    preventDefault() { composingSubmitPrevented = true; } }));
  assert.equal(composingSubmitPrevented, true, "confirming an IME candidate must not submit the rename");
  act(() => input().props.onChange({ target: { value: "  " } }));
  act(submit); assert.equal(calls.length, 0, "blank rename cannot clear the existing name accidentally");
  assert.equal(renderer.root.findByProps({ type: "submit" }).props.disabled, true);
  act(() => input().props.onChange({ target: { value: "  Renamed run  " } }));
  act(() => { submit(); submit(); });
  assert.deepEqual(calls, [{ key: cron.key, label: "Renamed run" }], "duplicate submission sends exactly one rename to the captured session");
  assert.equal(renderer.root.findByType("dialog").props.dismissible, false);
  act(() => renderer.root.findByType("dialog").props.onClose());
  assert.equal(closeCount, 0);
  await act(async () => { result.resolve(false); await flush(); });
  assert.equal(input().props.value, "  Renamed run  ", "a failed rename keeps the edit for retry");
  assert.equal(closeCount, 0);
  result = gate();
  act(submit);
  await act(async () => { result.resolve(true); await flush(); });
  assert.equal(closeCount, 1, "the modal closes only after confirmed success");
  act(() => renderer.unmount());
}
{
  let calls = 0, closes = 0, renderer;
  act(() => { renderer = create(React.createElement(RenameModal, {
    target: { key: existing.key, label: "Keep" }, onClose: () => { closes++; }, onSubmit: async () => { calls++; return true; },
  })); });
  act(() => renderer.root.findByType("dialog").props.onClose());
  assert.equal(closes, 1); assert.equal(calls, 0, "cancel never patches the session");
  act(() => renderer.unmount());
}
const chat = fs.readFileSync(path.join(uiRoot, "src/pages/ChatPage.tsx"), "utf8");
assert.doesNotMatch(chat, /window\.prompt\s*\(/, "installed Electron cannot use browser prompt");
assert.match(chat, /onSubmit=\{\(key, label\) => renameSessionTo\(label, key\)\}/);
assert.match(chat, /commitSessions\(next\.rows, true\)/);
assert.match(chat, /commitSessions\(fetchedRows \|\| sessionsRef\.current\)/);
assert.match(chat, /applyChatSessionAgentNames\(\s*mergeSynthetic\(merged, authoritative \? all : undefined\)/,
  "refresh must enrich names after the linked placeholders are merged");
assert.match(chat, /const \[row\] = applyChatSessionAgentNames<SessionRow>\(/,
  "new, fork and deep-link entries must resolve their name before opening");
assert.match(chat, /void openChatSessionLink\(key,/);
console.log("PASS Chat session navigation: both metadata/list race orders, exact history and quote, authoritative rows, degradation, stale navigation, errors; rename submit, cancel, retry, blank input and duplicate guard");
