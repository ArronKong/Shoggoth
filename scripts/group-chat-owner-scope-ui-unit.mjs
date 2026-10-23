// Owner transition regression: actual production Panel and its read / control / settings components.
// Controlled APIs and React renderer; no Service, Provider, user data, or automatic sends.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const ui = path.resolve(process.env.GROUP_OWNER_UI_ROOT || path.resolve(import.meta.dirname, ".."), "app/manage-ui");
const require = createRequire(path.join(ui, "package.json"));
const React = require("react");
const { act, create, unstable_batchedUpdates } = require("react-test-renderer");
const ts = require("typescript");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// DOM-free menu shell; source callbacks and owner fences remain real.
const MenuContext = React.createContext(null);
const menuMock = {
  Root: ({ children }) => { const [open, setOpen] = React.useState(false);
    return React.createElement(MenuContext.Provider, { value: { open, setOpen } }, children); },
  Trigger: ({ children, ...props }) => { const state = React.useContext(MenuContext);
    return React.createElement("button", { ...props, onClick: () => state.setOpen(!state.open) }, children); },
  Portal: ({ children }) => React.useContext(MenuContext).open ? children : null,
  Positioner: ({ children }) => React.createElement("div", null, children),
  Popup: ({ children }) => React.createElement("div", null, children),
  Item: ({ children, onClick, disabled, ...props }) => { const state = React.useContext(MenuContext);
    return React.createElement("button", { ...props, disabled, onClick: event => {
      if (!disabled) { onClick?.(event); state.setOpen(false); }
    } }, children); },
};

const { resultPage, sha256 } = require("../group-result-content.js");
let fullAnswer = "";
let roleSource = "role", oldRoleSource = "旧版公开设定。", corruptRolePage = false;
const translate = (key) => key;
const calls = [];
let view;
let messages;
let confirmAnswer = true;
const windowListeners = new Map();
const handler = new Map();
const observers = [];
let archived = 0;
const record = (name, result) => (...args) => { calls.push({ name, args }); return Promise.resolve((handler.get(name) ?? result)(...args)); };
const api = {
  getGroupChat: record("getGroupChat", () => view),
  getGroupChatMemberModels: record("models", () => ({ models: [{ id: "model-b", name: "Model B", provider: "codex" }], defaultModel: "model-a" })),
  setGroupChatMemberModel: record("modelSave", () => view),
  listGroupChatMessages: (_id, query) => Promise.resolve({ messages: query.afterSeq ? [] : messages, hasMore: false }),
  sendGroupChatMessage: record("send", (_id, input) => ({ message: { id: "new", groupId: "g", seq: 99, threadId: "main",
    author: { kind: "user" }, body: input.body, mentions: { memberIds: [], broadcast: false, unresolved: [] }, createdAt: 1 },
  discussionId: "d", duplicate: false })),
  readGroupChatMessage: record("readFull", (_id, input) => ({ page: resultPage(fullAnswer, input) })),
  reconcileGroupChatExecution: record("reconcile", () => view),
  retryGroupChatTurn: record("retry", () => view),
  addGroupChatMember: record("add", () => view),
  removeGroupChatMember: record("remove", () => view),
  getGroupChatMemberRole: record("role", (_id, _memberId, query = {}) => {
    const id = query.cursor?.split(":")[0] ?? (query.revision === "old" ? "old" : "current");
    const text = id === "old" ? oldRoleSource : roleSource;
    const page = resultPage(text, { offset: Number(query.cursor?.split(":")[1] ?? 0) });
    return { ok: true, ...page, disclosure: "verbatim", revisionId: corruptRolePage && query.cursor ? "wrong-version" : id,
      exportDigest: page.digest, disclosurePolicyRevision: 1, nextCursor: page.nextOffset === null ? null : `${id}:${page.nextOffset}` };
  }),
  getGroupChatMemberRoleHistory: record("roleHistory", () => ({ snapshots: [{ id: "old", sourceRevision: 1 }], hasMore: false, nextCursor: null })),
  respondGroupChatInteraction: record("respond", () => view),
  stopGroupChatDiscussion: record("stop", () => view),
  stopGroupChatMember: record("stopMember", () => view),
  updateGroupChat: record("update", () => view),
  deleteGroupChat: record("deleteGroup", () => ({ groupId: "g", status: "deleting" })),
  testGroupChatHost: record("testPeer", peer => ({ ...peer, groupTools: true, workspaces: true, artifacts: true })),
  revealAttachment: record("reveal", () => undefined),
};
// 上传替身：由测试决定每个文件何时传完。
const uploads = [];
const media = {
  MAX_INSPIRATION_ATTACHMENTS: 8,
  inspirationMediaLimit: (type) => (type.startsWith("image/") ? 10 : 50) * 1024 * 1024,
  inspirationMediaUrl: (id, preview = false) => `/__api/inspirations/media?id=${id}${preview ? "&preview=1" : ""}`,
  normalizeMediaType: (type) => type || "application/octet-stream",
  uploadInspirationMedia: (file, id, alive, mimeType) => new Promise((resolve, reject) => uploads.push({ file, id, alive,
    resolve: () => resolve(alive() ? { id, name: file.name, mimeType, size: file.size } : null), reject })),
};
const passthrough = (tag) => ({ __esModule: true, default: (props) => React.createElement(tag, null, props.text ?? props.children ?? null) });
const modules = new Map();
let groupJournalMock;
function load(relative) {
  if (modules.has(relative)) return modules.get(relative);
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(ui, relative), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, Date, Set, Map, Error, JSON, Promise, Array, TextEncoder, Uint8Array, AbortController, crypto: globalThis.crypto,
    URL: { createObjectURL: (file) => `blob:${file.name}`, revokeObjectURL: () => {} },
    requestAnimationFrame: (callback) => callback(), setInterval: () => 0, clearInterval: () => {}, setTimeout, clearTimeout,
    window: { addEventListener(name, fn) { if (!windowListeners.has(name)) windowListeners.set(name, new Set()); windowListeners.get(name).add(fn); },
      removeEventListener(name, fn) { windowListeners.get(name)?.delete(fn); } },
    document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
    require: (name) => {
      // 样式类名按属性名返回，便于按类名定位元素。
      if (name.endsWith(".css")) return new Proxy({}, { get: (_target, key) => (key === "__esModule" ? undefined : String(key)) });
      if (name.endsWith(".svg")) return name;
      if (name === "@base-ui/react/menu") return { Menu: menuMock };
      if (name.endsWith("/api/client") || name.endsWith("/api/groupReads") || name.endsWith("/api/groupMemberModel")) return api;
      if (name.endsWith("/group-journal-recovery")) return require(path.resolve(ui, "../group-journal-recovery.js"));
      if (name.endsWith("/lib/groupSendJournal")) return groupJournalMock;
      if (name.endsWith("/lib/groupPanelObserver")) return { createGroupPanelObserver(options) {
        observers.push(options); return load("src/lib/groupPanelObserver.ts").createGroupPanelObserver(options);
      } };
      if (name.endsWith("/lib/turnTimeline")) return load("src/lib/turnTimeline.ts");
      if (name.endsWith("/lib/groupReferenceExcerpt")) return load("src/lib/groupReferenceExcerpt.ts");
      if (name.endsWith("/lib/groupReply")) return load("src/lib/groupReply.ts");
      if (name.endsWith("/lib/groupTimeline")) return load("src/lib/groupTimeline.ts");
      if (name.endsWith("/lib/chatTime")) return load("src/lib/chatTime.ts");
      if (name.endsWith("/lib/groupMessagePresentation")) return load("src/lib/groupMessagePresentation.ts");
      if (name.endsWith("/i18n/groupCollaborationResources") || name.endsWith("/i18n/groupComposerResources")) return {};
      if (/\/i18n\/group(?:Reference|Search|Execution|Model|Files)Resources$/u.test(name)) return {};
      if (name.endsWith("/components/ui")) return { useToast: () => ({ error: (value) => calls.push({ name: "toast", args: [value] }) }),
        useConfirm: () => record("confirm", () => confirmAnswer),
        usePrompt: () => record("prompt", () => null) };
      if (name.endsWith("/lib/groupChat")) return { onGroupChanged: () => () => {}, GROUP_NATIVE_BACKEND_ID: "shoggoth", GROUP_MAX_MEMBERS: 32,
        GROUP_MEMBER_BACKEND_IDS: new Set(["shoggoth", "hermes", "openclaw"]) };
      if (name.endsWith("/components/Modal")) return { __esModule: true, default: (props) => props.open
        ? React.createElement("section", { role: "dialog" }, props.title, props.children, props.footer) : null };
      if (name.endsWith("/components/Field")) return {
        Field: props => React.createElement("label", null, props.label, props.children),
        TextInput: props => React.createElement("input", props),
        TextArea: props => React.createElement("textarea", props),
        Option: props => React.createElement("option", { value: props.value }, props.children),
        Select: props => React.createElement("select", { value: props.value, onChange: event => props.onChange(event.target.value) }, props.children),
        Switch: props => React.createElement("label", null, props.label, React.createElement("input", { type: "checkbox", checked: props.checked,
          disabled: props.disabled, onChange: event => props.onChange(event.target.checked) })),
      };
      if (name.endsWith("/components/AgentAvatar") || name.endsWith("/components/FusionLoader")) return passthrough("i");
      if (name.endsWith("/components/ChatFileButton")) return load("src/components/ChatFileButton.tsx");
      if (name.endsWith("/components/ChatMarkdown")) return passthrough("p");
      if (name === "./GroupChatMarkdown") return { __esModule: true, default: props => React.createElement("p", null, props.lead, props.text) };
      if (name === "./ChatPromptCard") return { __esModule: true, default: props => React.createElement("button", { "data-prompt": true, onClick: () => props.onRespond(props.entry, { decision: "accept" }) }, "respond") };
      if (name === "./ChatModelMenu") return { __esModule: true, default: props => React.createElement("model-menu", props) };
      if (name === "./chatIcons") return load("src/pages/chatIcons.tsx");
      if (name === "./inspiration-media") return media;
      if (name === "react-router-dom") return { Link: (props) => React.createElement("a", null, props.children) };
      if (name === "react-i18next") return { useTranslation: () => ({ t: translate }) };
      if (name.startsWith("./")) return load(path.join(path.dirname(relative), `${name}.tsx`));
      return require(name);
    },
  });
  modules.set(relative, module.exports);
  return module.exports;
}
// The real draft session uses an isolated in-memory journal; durable storage has its own Electron suite.
const journalModule = load("src/lib/groupSendJournal.ts");
const journalDrafts = new Map(), journalSends = new Map();
const clone = value => JSON.parse(JSON.stringify(value));
const journal = {
  async read(ownerScope, groupId) { if (handler.has("journalRead")) return handler.get("journalRead")(ownerScope, groupId);
    return { sends: clone([...journalSends.values()].filter(row => row.ownerScope === ownerScope && row.groupId === groupId)),
    draft: clone([...journalDrafts.values()].filter(row => row.ownerScope === ownerScope && row.groupId === groupId).at(-1) ?? null) }; },
  async saveComposer(ownerScope, groupId, draftId, revision, composer, expectedStorageRevision) {
    const key = JSON.stringify([ownerScope, groupId, draftId]);
    const snapshot = { version: 1, key, ownerScope, groupId, draftId, revision, storageRevision: expectedStorageRevision + 1, composer: clone(composer), updatedAt: Date.now() };
    journalDrafts.set(key, snapshot); return clone(snapshot);
  },
  async prepare(ownerScope, groupId, inputSnapshot, draft) {
    const row = { journalVersion: 1, key: JSON.stringify([ownerScope, groupId, inputSnapshot.clientMessageId]), ownerScope, groupId,
      clientMessageId: inputSnapshot.clientMessageId, inputSnapshot: clone(inputSnapshot), payloadDigest: "a".repeat(64), draftId: draft.draftId,
      draftRevision: draft.revision, composerSnapshot: clone(draft.composer), phase: "prepared", revision: 1 };
    journalSends.set(row.key, row); return clone(row);
  },
  async update(row, patch) { const next = { ...row, ...patch, revision: row.revision + 1 }; journalSends.set(row.key, next); return clone(next); },
  async accepted(row) {
    await journal.update(row, { phase: "observed" });
    const key = JSON.stringify([row.ownerScope, row.groupId, row.draftId]); let draft = journalDrafts.get(key) ?? null;
    if (draft?.revision === row.draftRevision) { draft = { ...draft, composer: journalModule.emptyGroupComposer(), revision: draft.revision + 1, storageRevision: draft.storageRevision + 1 }; journalDrafts.set(key, draft); }
    return { record: journalSends.get(row.key), draft: clone(draft) };
  },
};
groupJournalMock = { ...journalModule, groupSendJournal: journal,
  GroupDraftSession: class extends journalModule.GroupDraftSession { constructor(scope, groupId, snapshot) { super(scope, groupId, snapshot, journal); } } };
const Panel = load("src/pages/GroupChatPanel.tsx").default;

const member = (id, displayName, backendId = "shoggoth") => ({ id, groupId: "g", backendId, agentId: `agent-${id}`, displayName,
  handle: id, state: "active", position: 1, joinedSeq: 0, leftSeq: null, card: null });
const base = () => ({ ownerScope: "fixture-owner", group: { id: "g", name: "群", purpose: "", status: "active", createdAt: 1, updatedAt: 1, metadataRevision: 1,
  rosterRevision: 7, directoryRevision: 1, controlEpoch: 0, lastSeq: 6, ownerMemberId: "a" },
currentOwnerId: "a", members: [member("a", "Alpha"), member("b", "Beta"), member("c", "Gamma")],
round: null, activeTurns: [], queuedMemberIds: [], internalSessionKeys: [], pendingInteractions: [] });
const message = (seq, author, body, extra = {}) => ({ id: `m${seq}`, groupId: "g", seq, threadId: "main", author, body,
  mentions: { memberIds: [], broadcast: false, unresolved: [] }, createdAt: seq, ...extra });
const failed = (seq, memberId) => message(seq, { kind: "system" }, "", { system: { eventType: "turn_failed", memberId, errorCode: "RUNTIME_FAILED" } });
const timeline = () => [
  message(1, { kind: "user" }, "大家看看"),
  message(2, { kind: "member", memberId: "a" }, "Alpha 的回答"),
  failed(3, "b"),
  failed(4, "c"),
  message(5, { kind: "member", memberId: "c" }, "Gamma 后来答上了"),
  message(6, { kind: "user" }, "第二步呢", { replyTo: { seq: 2, messageId: "m2", author: { kind: "member", memberId: "a" }, excerpt: "Alpha 的回答" } }),
];
const agents = [{ backendId: "shoggoth", agentId: "agent-a", name: "Alpha" }, { backendId: "hermes", agentId: "bull", name: "bull" },
  { backendId: "other", agentId: "x", name: "Unsupported" }];

let renderer;
const mount = async () => {
  if (renderer) await act(async () => renderer.unmount());
  calls.length = 0; handler.clear(); observers.length = 0; archived = 0;
  journalDrafts.clear(); journalSends.clear();
  await act(async () => { renderer = create(React.createElement(Panel, { groupId: "g", agents, onArchived() { archived++; } })); });
  await act(async () => {});
};
const buttons = (label) => renderer.root.findAllByType("button")
  .filter((node) => node.children.includes(label) || node.props["aria-label"] === label);
const click = async (node) => { await act(async () => { await node.props.onClick({ preventDefault() {} }); }); };
const groupAction = async action => {
  const trigger = renderer.root.find(node => node.type === "button" && node.props["data-group-details-trigger"] !== undefined);
  if (!trigger.props["aria-expanded"]) { await click(trigger); await act(async () => {}); }
  const button = value => renderer.root.find(node => node.type === "button" && node.props["data-group-details-action"] === value);
  await click(button("menu")); await click(button(action)); await act(async () => {});
};
const named = (name) => calls.filter((call) => call.name === name);
// 组件在独立的 vm 环境里运行，它创建的对象原型与这里不同：比较前先转成普通对象。
const plain = (value) => JSON.parse(JSON.stringify(value));

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setImmediate(resolve)); }); };
const text = () => JSON.stringify(renderer.toJSON());
const refresh = async () => { await act(async () => { for (const fn of [...(windowListeners.get("focus") ?? [])]) fn(); }); await flush(); };
const setup = async () => {
  view = base(); view.group.name = "OWNER_A"; fullAnswer = "OLD_OWNER_RESULT";
  messages = [message(2, { kind: "member", memberId: "a" }, "excerpt", {
    fullResult: { digest: sha256(fullAnswer), bytes: Buffer.byteLength(fullAnswer), truncated: true },
    origin: { opportunityId: "turn-a", runId: "run-a", discussionId: "round" },
  })];
  await mount(); await flush();
};
const changeOwner = async (owner = "owner-b", name = "OWNER_B") => {
  view = { ...plain(view), ownerScope: owner, group: { ...view.group, name } };
  messages = [];
  await refresh();
  assert.ok(text().includes(name), "authoritative view observed the new owner");
};
const noWrites = () => assert.equal(calls.filter(call => ["send", "stop", "stopMember", "update", "respond", "retry", "remove", "add", "modelSave"].includes(call.name)).length, 0);
let passed = 0; const failures = [];
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok ${passed} - ${name}`); }
  catch (error) { failures.push({ name, message: error.message }); console.error(`FAIL ${name}: ${error.stack}`); }
  finally { if (renderer) { await act(async () => renderer.unmount()); renderer = null; } }
};

await test("timeline full-message preview closes when owner changes", async () => {
  await setup(); const full = deferred(); handler.set("readFull", () => full.promise);
  await click(buttons("groupChat.fullResult.open")[0]); await changeOwner();
  full.resolve({ page: resultPage(fullAnswer, { offset: 0, digest: sha256(fullAnswer) }) }); await flush();
  assert.equal(renderer.root.findAllByProps({ role: "dialog" }).length, 0); assert.ok(!text().includes(fullAnswer)); noWrites();
});
await test("late stop response cannot replace a newly observed owner", async () => {
  await setup(); await act(async () => renderer.unmount()); renderer = null;
  view.round = { id: "round", causeMessageId: "m1", order: [] }; await mount();
  const pending = deferred(), old = plain(view); handler.set("stop", () => pending.promise);
  await click(buttons("groupChat.stop")[0]); await changeOwner();
  handler.set("getGroupChat", () => new Promise(() => {}));
  pending.resolve({ ...old, group: { ...old.group, name: "STALE_CONTROL" } }); await flush();
  assert.ok(text().includes("OWNER_B")); assert.ok(!text().includes("STALE_CONTROL")); assert.equal(named("stop").length, 1); assert.equal(named("send").length, 0);
});
await test("late Panel run response is fenced even after owner A to B to A", async () => {
  await setup(); messages = [failed(3, "b")]; await refresh();
  // The initial history is bounded; explicitly mount the same owned fixture with its failure.
  await mount(); const pending = deferred(), old = plain(view); handler.set("retry", () => pending.promise);
  await click(buttons("groupChat.retry")[0]); await changeOwner(); await changeOwner("fixture-owner", "OWNER_A_RETURNED");
  handler.set("getGroupChat", () => new Promise(() => {}));
  pending.resolve({ ...old, group: { ...old.group, name: "STALE_RETRY" } }); await flush();
  assert.ok(text().includes("OWNER_A_RETURNED")); assert.ok(!text().includes("STALE_RETRY")); assert.equal(named("retry").length, 1);
});
await test("child onView rejects old and mismatched owners while retaining valid same-owner updates", async () => {
  await setup(); const old = plain(view);
  await groupAction("settings");
  const callback = renderer.root.findByType(load("src/pages/GroupChatSettings.tsx").default).props.onView;
  await act(async () => callback({ ...old, ownerScope: "unexpected-owner", group: { ...old.group, name: "WRONG_OWNER" } }));
  assert.ok(!text().includes("WRONG_OWNER"));
  view = { ...old, group: { ...old.group, name: "VALID_SAME_OWNER" } };
  await act(async () => callback(view));
  assert.ok(text().includes("VALID_SAME_OWNER")); await changeOwner();
  handler.set("getGroupChat", () => new Promise(() => {}));
  await act(async () => callback({ ...old, group: { ...old.group, name: "STALE_CHILD" } }));
  assert.ok(text().includes("OWNER_B")); assert.ok(!text().includes("STALE_CHILD")); noWrites();
});
await test("late interaction response cannot replace the new owner", async () => {
  await setup(); await act(async () => renderer.unmount()); renderer = null;
  view.pendingInteractions = [{ memberId: "a", opportunityId: "op", status: "pending", request: { requestId: "approval", kind: "approval" } }];
  await mount(); const old = plain(view), pending = deferred(); handler.set("respond", () => pending.promise);
  let responding; await act(async () => { responding = buttons("respond")[0].props.onClick(); });
  await changeOwner(); handler.set("getGroupChat", () => new Promise(() => {}));
  pending.resolve({ ...old, group: { ...old.group, name: "STALE_RESPONSE" } }); await responding; await flush();
  assert.ok(text().includes("OWNER_B")); assert.ok(!text().includes("STALE_RESPONSE")); assert.equal(named("respond").length, 1);
});
await test("owner transition cancels a delayed delete confirmation before posting", async () => {
  await setup();
  const pending = deferred(); handler.set("confirm", () => pending.promise);
  await groupAction("delete"); await changeOwner(); pending.resolve(true); await flush();
  noWrites(); assert.equal(named("deleteGroup").length, 0); assert.equal(archived, 0);
});
await test("owner transition cancels delayed member removal before posting", async () => {
  await setup(); await groupAction("profile");
  const pending = deferred(); handler.set("confirm", () => pending.promise);
  await click(buttons("groupChat.members.remove")[0]); await changeOwner(); pending.resolve(true); await flush(); noWrites();
});
await test("late member model saves cannot replace the current owner and retired controls cannot write", async () => {
  await setup(); await groupAction("profile");
  const choose = renderer.root.findByType("model-menu").props.onSelect;
  const pending = deferred(); handler.set("modelSave", () => pending.promise);
  await act(async () => choose("model-b", "codex")); await flush();
  assert.equal(named("modelSave").length, 1);
  const stale = { ...view, group: { ...view.group, name: "STALE_MODEL_SAVE" } };
  await changeOwner(); pending.resolve(stale); await flush();
  assert.ok(text().includes("OWNER_B")); assert.ok(!text().includes("STALE_MODEL_SAVE"));
  await act(async () => choose("model-b", "codex")); await flush();
  assert.equal(named("modelSave").length, 1, "a retired model control cannot post to a new owner");
});
await test("a visible model choice can be saved while its menu refreshes the catalog", async () => {
  await setup(); await groupAction("profile");
  const pending = deferred(); handler.set("models", () => pending.promise);
  await act(async () => renderer.root.findByType("model-menu").props.onRefresh()); await flush();
  assert.equal(renderer.root.findByType("model-menu").props.loading, true);
  await act(async () => renderer.root.findByType("model-menu").props.onSelect("model-b", "codex")); await flush();
  assert.equal(named("modelSave").length, 1, "refresh cannot silently discard a visible choice");
  assert.deepEqual(JSON.parse(JSON.stringify(named("modelSave")[0].args[1].modelSelection)), { model: "model-b", provider: "codex" });
  pending.resolve({ models: [], defaultModel: "model-a" }); await flush();
});
await test("late execution reconciliation response cannot overwrite the current owner", async () => {
  await setup(); await act(async () => renderer.unmount()); renderer = null;
  view.activeTurns = [{ opportunityId: "op", memberId: "a", startedAt: 1,
    recovery: { type: "execution", reason: "GROUP_TURN_EXECUTION_UNCONFIRMED", since: 1, cancelRequested: false } }];
  await mount(); const old = plain(view), pending = deferred(); handler.set("reconcile", () => pending.promise);
  await click(buttons("groupChat.recovery.reconcile")[0]); await changeOwner();
  pending.resolve({ ...old, group: { ...old.group, name: "STALE_RECOVERY" } }); await flush();
  assert.ok(text().includes("OWNER_B")); assert.ok(!text().includes("STALE_RECOVERY")); assert.equal(named("reconcile").length, 1); noWrites();
});
await test("late settings save cannot close settings reopened by the new owner", async () => {
  await setup(); await groupAction("settings"); const pending = deferred(), old = plain(view);
  await act(async () => { renderer.root.findAllByType("select").find(node => node.props.value === "a").props.onChange({ target: { value: "b" } }); });
  handler.set("update", () => pending.promise); await click(buttons("groupChat.strategy.save")[0]); await changeOwner();
  await groupAction("settings");
  const settings = renderer.root.findByType(load("src/pages/GroupChatSettings.tsx").default);
  pending.resolve({ ...old, group: { ...old.group, name: "OLD_SETTINGS_SAVE" } }); await flush();
  assert.equal(renderer.root.findByType(load("src/pages/GroupChatSettings.tsx").default), settings);
  assert.ok(text().includes("OWNER_B")); assert.ok(!text().includes("OLD_SETTINGS_SAVE")); assert.equal(named("update").length, 1);
});
await test("batched A to B to A cannot revive old controls, journal callbacks, or result readers", async () => {
  await setup(); await groupAction("settings"); await flush();
  const oldView = plain(view), sourceReads = named("readFull").length;
  const oldControl = renderer.root.findByType(load("src/pages/GroupChatSettings.tsx").default).props.onView;
  const authority = observers[0], oldJournal = observers.at(-1);
  const stale = { sends: [], foreignPending: 77, draft: { ...plain([...journalDrafts.values()][0]),
    composer: { ...journalModule.emptyGroupComposer(), text: "STALE_BATCH_DRAFT" } } };
  view = { ...oldView, group: { ...oldView.group, name: "OWNER_A_BATCH_RETURNED" } }; messages = [];
  await act(async () => unstable_batchedUpdates(() => {
    authority.commit({ detail: { ...oldView, ownerScope: "owner-b", group: { ...oldView.group, name: "OWNER_B_BATCH" } }, page: { messages: [], hasMore: false }, initialHistory: false });
    authority.commit({ detail: view, page: { messages: [], hasMore: false }, initialHistory: false });
    oldControl({ ...oldView, group: { ...oldView.group, name: "STALE_BATCH_CONTROL" } });
    oldJournal.commit(stale); oldJournal.failed(new Error("STALE_BATCH_JOURNAL_ERROR"));
  })); await flush();
  assert.ok(text().includes("OWNER_A_BATCH_RETURNED"));
  assert.ok(!text().includes("STALE_BATCH") && !text().includes(fullAnswer));
  assert.equal(named("readFull").length, sourceReads); assert.equal(renderer.root.findAllByProps({ role: "dialog" }).length, 0);
  assert.notEqual(observers.at(-1), oldJournal, "journal observer is rebuilt even when the final owner string is unchanged"); noWrites();
});
await test("late journal refresh from the first owner epoch cannot replace current send records or error", async () => {
  for (const reject of [false, true]) {
    await setup(); const pending = deferred(); handler.set("journalRead", () => pending.promise);
    await act(async () => { for (const fn of [...(windowListeners.get(journalModule.GROUP_JOURNAL_CHANGED) ?? [])]) fn({ detail: { groupId: "g" } }); });
    handler.delete("journalRead"); await changeOwner(); await changeOwner("fixture-owner", "OWNER_A_FRESH");
    if (reject) pending.reject(new Error("STALE_REFRESH_ERROR"));
    else pending.resolve({ sends: [], foreignPending: 999, draft: null });
    await flush(); assert.ok(!text().includes("STALE_REFRESH_ERROR"));
    assert.ok(!text().includes("groupChat.sendJournal.otherOwner")); noWrites();
  }
});
console.log(JSON.stringify({ passed, failed: failures.length, failures, realProviderCalls: 0, privateStateReads: 0 }));
if (failures.length) process.exitCode = 1;
