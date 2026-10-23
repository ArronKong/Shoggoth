// 群面板界面单元：成员增删入口、失败成员的「重试」、引用回复、图片与附件。真实的 GroupChatPanel / GroupChatMemberModal
// 源码经 TypeScript 转译后用 react-test-renderer 渲染；接口、弹窗外壳与 Markdown 用替身。
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

// Replace the DOM-backed menu primitive while retaining its open/close and item dispatch behavior.
const MenuContext = React.createContext(null);
const menuMock = {
  Root: ({ children }) => {
    const [open, setOpen] = React.useState(false);
    return React.createElement(MenuContext.Provider, { value: { open, setOpen } }, children);
  },
  Trigger: ({ children, onClick, ...props }) => {
    const state = React.useContext(MenuContext);
    return React.createElement("button", { ...props, type: "button", "aria-expanded": state.open,
      onClick: event => { onClick?.(event); state.setOpen(!state.open); } }, children);
  },
  Portal: ({ children }) => React.useContext(MenuContext).open ? children : null,
  Positioner: ({ children }) => React.createElement("div", null, children),
  Popup: ({ children }) => React.createElement("div", { role: "menu" }, children),
  Item: ({ children, onClick, disabled, ...props }) => {
    const state = React.useContext(MenuContext);
    return React.createElement("button", { ...props, role: "menuitem", disabled,
      onClick: event => { if (!disabled) { onClick?.(event); state.setOpen(false); } } }, children);
  },
};

const { resultPage, sha256 } = require("../group-result-content.js");
let fullAnswer = "";
const groupChangedListeners = new Set();
let roleSource = "role", oldRoleSource = "旧版公开设定。", corruptRolePage = false;
const translate = (key) => key;
const calls = [];
let view;
let messages;
let confirmAnswer = true;
const record = (name, result) => (...args) => { calls.push({ name, args }); return Promise.resolve(result(...args)); };
const api = {
  getGroupChat: () => Promise.resolve(view),
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
  deleteGroupChat: record("deleteGroup", () => {
    view = { ...view, group: { ...view.group, status: "deleting" } };
    return { groupId: "g", status: "deleting" };
  }),
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
  vm.runInNewContext(code, { module, exports: module.exports, Date, Set, Map, Error, JSON, Promise, Array, TextEncoder, Uint8Array, crypto: globalThis.crypto,
    URL: { createObjectURL: (file) => `blob:${file.name}`, revokeObjectURL: () => {} },
    requestAnimationFrame: (callback) => callback(), setInterval: () => 0, clearInterval: () => {}, setTimeout, clearTimeout,
    window: { addEventListener() {}, removeEventListener() {} },
    document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
    require: (name) => {
      // 样式类名按属性名返回，便于按类名定位元素。
      if (name.endsWith(".css")) return new Proxy({}, { get: (_target, key) => (key === "__esModule" ? undefined : String(key)) });
      if (name.endsWith(".svg")) return name;
      if (name.endsWith("/api/client") || name.endsWith("/api/groupReads") || name.endsWith("/api/groupMemberModel")) return api;
      if (name.endsWith("/group-journal-recovery")) return require(path.resolve(ui, "../group-journal-recovery.js"));
      if (name.endsWith("/lib/groupSendJournal")) return groupJournalMock;
      if (name.endsWith("/groupReply")) return load("src/lib/groupReply.ts");
      if (name.endsWith("/lib/groupTimeline")) return load("src/lib/groupTimeline.ts");
      if (name.endsWith("/lib/chatTime")) return load("src/lib/chatTime.ts");
      if (name.endsWith("/lib/groupMessagePresentation")) return load("src/lib/groupMessagePresentation.ts");
      if (name.endsWith("/lib/groupPanelObserver")) return load("src/lib/groupPanelObserver.ts");
      if (name.endsWith("/lib/turnTimeline")) return load("src/lib/turnTimeline.ts");
      if (name.endsWith("/lib/groupReferenceExcerpt")) return load("src/lib/groupReferenceExcerpt.ts");
      if (name.endsWith("/i18n/groupCollaborationResources") || name.endsWith("/i18n/groupComposerResources")) return {};
      if (/\/i18n\/group(?:Reference|Search|Execution|Model|Files)Resources$/u.test(name)) return {};
      if (name.endsWith("/components/ui")) return { useToast: () => ({ error: (value) => calls.push({ name: "toast", args: [value] }) }),
        useConfirm: () => (options) => { calls.push({ name: "confirm", args: [options] }); return Promise.resolve(confirmAnswer); },
        usePrompt: () => () => Promise.resolve(null) };
      if (name.endsWith("/lib/groupChat")) return { onGroupChanged: callback => { groupChangedListeners.add(callback); return () => groupChangedListeners.delete(callback); }, GROUP_NATIVE_BACKEND_ID: "shoggoth", GROUP_MAX_MEMBERS: 32,
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
      if (name === "@base-ui/react/menu") return { Menu: menuMock };
      if (name.endsWith("/components/ChatMarkdown")) return passthrough("p");
      if (name.endsWith("/components/ChatFileButton")) return load("src/components/ChatFileButton.tsx");
      if (name === "./GroupChatMarkdown") return { __esModule: true, default: props => React.createElement("p", null, props.lead, props.text) };
      if (name === "./ChatPromptCard") return { __esModule: true, default: () => null };
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
// This harness covers existing roster / quoting / attachment UI. Persistence has a separate real IndexedDB Electron suite.
const journalModule = load("src/lib/groupSendJournal.ts");
const journalDrafts = new Map(), journalSends = new Map();
const clone = value => JSON.parse(JSON.stringify(value));
const journal = {
  async read(ownerScope, groupId) { return { sends: clone([...journalSends.values()].filter(row => row.ownerScope === ownerScope && row.groupId === groupId)),
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
{
  const { groupChatActivity, groupChatPreview } = load("src/lib/groupChat.ts");
  const pending = { ...base(), activeTurns: [{ opportunityId: "pending", memberId: "b", startedAt: 1,
    recovery: { type: "result", reason: "GROUP_TURN_RESULT_EMPTY", since: 1, cancelRequested: false } }] };
  assert.equal(groupChatActivity(pending), "reading");
  assert.equal(groupChatPreview(pending, translate), "groupChat.sidebar.reading");
  assert.equal(groupChatActivity({ ...pending, pendingInteractions: [{ request: { requestId: "r" } }] }), "waiting");
  assert.equal(groupChatActivity({ ...base(), activeTurns: [{ stopping: true }] }), "stopping");
  assert.equal(groupChatActivity({ ...base(), activeTurns: [{ recovery: { type: "execution" } }] }), "checking");
  assert.equal(groupChatActivity({ ...base(), activeTurns: [{ dispatchState: "queued" }] }), "queued");
  assert.equal(groupChatActivity({ ...base(), queuedMemberIds: ["a"] }), "queued");
  assert.equal(groupChatPreview({ ...base(), activeTurns: [{ dispatchState: "queued", queueReason: "execution_unconfirmed" }] }, translate), "groupChat.sidebar.queueBlocked");
  assert.equal(groupChatActivity({ ...base(), group: { ...base().group, status: "deleting" },
    activeTurns: [{ recovery: { type: "execution" } }] }), "deleting");
}
const agents = [{ backendId: "shoggoth", agentId: "agent-a", name: "Alpha" }, { backendId: "hermes", agentId: "bull", name: "bull" },
  { backendId: "other", agentId: "x", name: "Unsupported" }];

let renderer;
const mount = async () => {
  calls.length = 0;
  journalDrafts.clear(); journalSends.clear();
  await act(async () => { renderer = create(React.createElement(Panel, { groupId: "g", agents, onArchived() {} })); });
  await act(async () => {});
};
const buttons = (label) => renderer.root.findAllByType("button")
  .filter((node) => node.children.includes(label) || node.props["aria-label"] === label);
const click = async (node) => { await act(async () => { await node.props.onClick({ preventDefault() {}, stopPropagation() {} }); }); };
const detailActions = (action) => renderer.root.findAll(node => node.type === "button"
  && node.props["data-group-details-action"] === action);
const detailMembers = () => renderer.root.findAll(node => node.type === "button"
  && node.props["data-group-details-member"] !== undefined);
const openDetails = async () => {
  const trigger = renderer.root.find(node => node.type === "button" && node.props["data-group-details-trigger"] !== undefined);
  assert.equal(trigger.props["aria-expanded"], false, "group details start collapsed");
  assert.equal(detailMembers().length, 0, "the collapsed header does not render member cards");
  await click(trigger);
  await act(async () => {});
  assert.equal(trigger.props["aria-expanded"], true, "the header exposes its expanded state");
  assert.equal(renderer.root.findAll(node => node.type === "section" && node.props["data-group-details"] !== undefined).length, 1);
};
const menuAction = async (action) => {
  await click(detailActions("menu")[0]);
  await click(detailActions(action)[0]);
};
const selectDetailMember = async (id) => {
  await click(detailMembers().find(node => node.props["data-group-details-member"] === id));
};
const named = (name) => calls.filter((call) => call.name === name);
// 组件在独立的 vm 环境里运行，它创建的对象原型与这里不同：比较前先转成普通对象。
const plain = (value) => JSON.parse(JSON.stringify(value));

// ---- 重试：只出现在「该成员最近一次是失败」的那一行 ----
view = base();
messages = [message(1, { kind: "user" }, "user", { createdAt: new Date(2026, 9, 16, 9, 5).getTime() }),
  message(2, { kind: "member", memberId: "a" }, "member", { createdAt: new Date(2026, 9, 17, 20, 11).getTime() }),
  message(3, { kind: "user" }, "no timestamp", { createdAt: 0 }), failed(4, "b")];
await mount();
const displayedTimes = renderer.root.findAll(node => node.type === "time" && node.props["data-group-message-time"]);
assert.equal(displayedTimes.length, 2, "only published user/member messages with a timestamp show a time");
for (const [index, time] of displayedTimes.entries()) {
  const stamp = messages[index].createdAt;
  assert.equal(time.children.join(""), new Date(stamp).toLocaleString([], {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  }), "group date/time uses the direct-chat month/day and minute format");
  assert.equal(time.props.dateTime, new Date(stamp).toISOString());
  assert.equal(time.parent.props.className, "chat-group__footer", "group footer reuses direct-chat styling");
}
for (const [errorCode, key] of [["RUNTIME_ATTACHMENT_UNSUPPORTED", "groupChat.event.attachmentUnsupported"],
  ["RUNTIME_ATTACHMENT_RECOVERY_REQUIRED", "groupChat.event.attachmentRecoveryRequired"]]) {
  view = base(); messages = [message(1, { kind: "system" }, "", {
    system: { eventType: "turn_failed", memberId: "b", errorCode },
  })];
  await mount();
  assert.ok(JSON.stringify(renderer.toJSON()).includes(key), "attachment failures have a concrete explanation");
  assert.equal(JSON.stringify(renderer.toJSON()).includes("groupChat.event.turnFailed"), false);
}
view = base(); messages = timeline();
await mount();
assert.equal(buttons("groupChat.retry").length, 1, "Beta's failure is retryable; Gamma answered afterwards, so its old failure is not");
await click(buttons("groupChat.retry")[0]);
await click(buttons("groupChat.retry")[0]);
assert.deepEqual(named("retry").map((call) => call.args.slice(0, 2)), [["g", "b"], ["g", "b"]]);
assert.equal(named("retry")[0].args[2], named("retry")[1].args[2], "the same row retries with the same operation id");
view = { ...base(), activeTurns: [{ opportunityId: "o", memberId: "b", startedAt: 1 }] };
await mount();
assert.equal(buttons("groupChat.retry").length, 0, "no retry while the member is already answering");
view = { ...base(), group: { ...base().group, status: "archived" } };
await mount();
assert.equal(buttons("groupChat.retry").length, 0, "an archived group offers no retry");
assert.equal(buttons("groupChat.archive").length, 0, "archive is replaced by deletion");
await openDetails();
await menuAction("delete");
assert.equal(named("deleteGroup").length, 1);
assert.deepEqual(plain(named("deleteGroup")[0].args), ["g", 1]);
await click(detailActions("menu")[0]);
assert.equal(detailActions("delete")[0].props.disabled, true, "pending deletion cannot be resubmitted");
assert.equal(renderer.root.findByType("textarea").props.disabled, true);

// ---- 引用回复 ----
view = base(); messages = timeline();
await mount();
assert.equal(renderer.root.findAll((node) => node.props.className === "quoteBlock").length, 1, "a reply shows what it quotes");
const quoteButtons = buttons("groupChat.reply.action");
assert.equal(quoteButtons.length, 4, "every user and member message can be quoted; system rows cannot");
await click(quoteButtons[1]);
const chip = renderer.root.findAll((node) => node.props.className === "chat-quote-bar replyChip");
assert.equal(chip.length, 1);
assert.ok(chip[0].findAllByType("span").flatMap((node) => node.children.filter((child) => typeof child === "string"))
  .join("").includes("Alpha 的回答"));
const textarea = renderer.root.findByType("textarea");
await act(async () => { textarea.props.onChange({ target: { value: "展开说说", selectionStart: 4 } }); });
await click(buttons("groupChat.send")[0]);
assert.deepEqual([named("send")[0].args[1].body, named("send")[0].args[1].replyTo], ["展开说说", 2]);
assert.equal(renderer.root.findAll((node) => node.props.className === "chat-quote-bar replyChip").length, 0, "the quote is cleared after sending");
await act(async () => { renderer.root.findByType("textarea").props.onChange({ target: { value: "普通消息", selectionStart: 4 } }); });
await click(buttons("groupChat.send")[0]);
assert.equal(named("send")[1].args[1].replyTo, null);

// ---- 添加成员 ----
view = base(); messages = timeline();
await mount();
await openDetails();
await click(detailActions("add")[0]);
const addRows = buttons("groupChat.members.add");
assert.equal(addRows.length, 2, "agents already in the group are not offered (Alpha), the others are listed");
assert.deepEqual(addRows.map((node) => node.props.disabled), [false, true], "an unsupported backend cannot be added");
await click(addRows[0]);
assert.deepEqual(plain(named("add")[0].args), ["g", { expectedRosterRevision: 7, member: { backendId: "hermes", agentId: "bull" } }]);
view = { ...base(), members: Array.from({ length: 32 }, (_, i) => member(`member-${i}`, `成员 ${i}`)) };
await mount();
await openDetails();
assert.equal(detailActions("add").length, 0, "a full group has no add entry");
assert.equal(detailMembers().length, 32, "the expanded details expose the complete roster");
await selectDetailMember("member-31");
assert.equal(detailMembers().at(-1).props["aria-selected"], true, "the selected member is exposed as the active tab");
assert.ok(named("role").some(call => call.args[1] === "member-31"), "the last member's actual card can be opened");
await click(detailActions("close")[0]);
assert.equal(detailMembers().length, 0, "closing the details returns to the compact header");

// ---- 群设置：群主与群用途 ----
view = base(); messages = timeline();
await mount();
await openDetails();
await menuAction("settings");
await act(async () => { renderer.root.findAllByType("select").find(node => node.props.value === "a").props.onChange({ target: { value: "c" } }); });
await click(buttons("groupChat.strategy.save")[0]);
assert.deepEqual(plain(named("update")[0].args), ["g", { expectedMetadataRevision: 1, patch: { ownerMemberId: "c" } }]);
await act(async () => renderer.unmount());

// ---- 移出成员 ----
view = base(); messages = timeline();
await mount();
await openDetails();
await selectDetailMember("b");
await menuAction("profile");
confirmAnswer = false;
await click(buttons("groupChat.members.remove")[0]);
assert.equal(named("remove").length, 0, "removal needs confirmation");
confirmAnswer = true;
await click(buttons("groupChat.members.remove")[0]);
assert.deepEqual(plain(named("remove")[0].args), ["g", { expectedRosterRevision: 7, memberId: "b" }]);
view = { ...base(), members: [member("a", "Alpha")] };
await mount();
await openDetails();
await menuAction("profile");
assert.equal(buttons("groupChat.members.remove").length, 0, "the last member cannot be removed");

// ---- 图片与附件：样式沿用单聊（chat-att-*），传完才能发，可以只发附件 ----
const image = { id: "11111111-1111-4111-8111-111111111111", name: "截图.png", mimeType: "image/png", size: 2048 };
const report = { id: "22222222-2222-4222-8222-222222222222", name: "报告.pdf", mimeType: "application/pdf", size: 4096 };
view = base(); messages = [...timeline(), message(7, { kind: "user" }, "", { attachments: [image, report] })];
await mount();
const byClass = (className) => renderer.root.findAll((node) => typeof node.type === "string" && node.props.className === className);
assert.deepEqual(byClass("chat-att-thumb").map((node) => node.props.src), [`/__api/inspirations/media?id=${image.id}&preview=1`]);
assert.equal(byClass("chat-file-button").length, 1);
await click(byClass("chat-file-button")[0]);
assert.deepEqual(plain(named("reveal")[0].args), [report.name, `/__api/inspirations/media?id=${report.id}`]);
await click(byClass("chat-att-thumb")[0]);
assert.equal(byClass("chat-lightbox").length, 1, "an image opens in the same lightbox markup as the direct chat");
await click(byClass("chat-lightbox")[0]);
assert.equal(byClass("chat-lightbox").length, 0);

// 成员发的附件和引用用同一套显示。
view = base(); messages = [...timeline(), message(7, { kind: "member", memberId: "a" }, "", { attachments: [image],
  replyTo: { seq: 1, messageId: "m1", author: { kind: "user" }, excerpt: "大家看看" } })];
await mount();
assert.equal(byClass("chat-att-thumb").length, 1, "a member's picture shows like the user's");
assert.equal(byClass("quoteBlock").length, 2, "a member's quote shows like the user's");

// 图片引用在已发送消息和输入栏都能显示，草稿也保留图片元数据。
view = base(); messages = [message(1, { kind: "user" }, "", { attachments: [image, report] }),
  message(2, { kind: "user" }, "描述这张图", { replyTo: { seq: 1, messageId: "m1", author: { kind: "user" }, excerpt: "", attachments: [image, report] } }),
  message(3, { kind: "member", memberId: "a" }, "坡道", { replyTo: { seq: 1, messageId: "m1", author: { kind: "user" }, excerpt: "" } })];
await mount();
assert.deepEqual(byClass("quoteBlock").map(node => node.findAllByType("img").map(img => img.props.src)),
  [[media.inspirationMediaUrl(image.id, true)], [media.inspirationMediaUrl(image.id, true)]], "new and existing image quotes show thumbnails");
await click(buttons("groupChat.reply.action")[0]);
assert.equal(byClass("chat-quote-bar replyChip")[0].findAllByType("img")[0].props.src, media.inspirationMediaUrl(image.id, true));
assert.deepEqual(plain([...journalDrafts.values()].at(-1).composer.replyTo.attachments), [image, report]);
await act(async () => { renderer.unmount(); });
await act(async () => { renderer = create(React.createElement(Panel, { groupId: "g", agents, onArchived() {} })); });
await act(async () => {});
assert.equal(byClass("chat-quote-bar replyChip")[0].findAllByType("img")[0].props.alt, image.name, "restored draft keeps its image preview");
await click(buttons("groupChat.reply.cancel")[0]);
assert.equal(byClass("chat-quote-bar replyChip").length, 0);

view = base(); messages = [...timeline(), message(7, { kind: "user" }, "", { attachments: [image, report] })];
await mount();

const picker = renderer.root.findByProps({ type: "file" });
const pick = async (list) => { await act(async () => { picker.props.onChange({ target: { files: list, value: "x" } }); }); };
const sendButton = () => buttons("groupChat.send")[0];
await pick([{ name: "a.png", type: "image/png", size: 1024 }, { name: "b.pdf", type: "application/pdf", size: 2048 },
  { name: "空.txt", type: "text/plain", size: 0 }, { name: "太大.png", type: "image/png", size: 11 * 1024 * 1024 }]);
assert.equal(uploads.length, 2, "empty and oversized files are refused before uploading");
assert.deepEqual(plain(named("toast").map((call) => call.args[0])), ["groupChat.attach.empty", "chat.attachTooLarge"]);
const pendingRow = () => renderer.root.findAll((node) => typeof node.type === "string"
  && String(node.props.className).startsWith("chat-att-row chat-att-row--pending"))[0];
assert.deepEqual(pendingRow().findAllByType("div").filter((node) => node.props["data-status"])
  .map((node) => [node.props.className, node.props["data-status"]]),
  [["chat-att-chip", "uploading"], ["chat-att-chip chat-att-chip--file", "uploading"]]);
assert.equal(sendButton().props.disabled, true, "nothing is sent while a file is still uploading");
await act(async () => { uploads[0].resolve(); });
assert.equal(sendButton().props.disabled, true);
await act(async () => { uploads[1].resolve(); });
assert.equal(sendButton().props.disabled, false, "attachments alone are enough to send");
// 移除一个再发送：只带剩下的那个，正文可以为空。
await click(pendingRow().findAllByType("button")[0]);
calls.length = 0;
await click(sendButton());
const sentInput = plain(named("send")[0].args[1]);
assert.deepEqual([sentInput.body, sentInput.attachments.map((item) => [item.name, item.mimeType, item.size])],
  ["", [["b.pdf", "application/pdf", 2048]]]);
assert.equal(pendingRow(), undefined, "the pending row is cleared after sending");
// 一条消息最多 8 个。
uploads.length = 0; calls.length = 0;
await pick(Array.from({ length: 9 }, (_item, index) => ({ name: `f${index}.txt`, type: "text/plain", size: 10 })));
assert.equal(uploads.length, 8);
assert.deepEqual(plain(named("toast").map((call) => call.args[0])), ["groupChat.attach.tooMany"]);
// 粘贴图片也进同一条待发送列表（先移掉一个腾出位置）。
await click(pendingRow().findAllByType("button")[0]);
let prevented = false;
await act(async () => { renderer.root.findByType("textarea").props.onPaste({ preventDefault() { prevented = true; },
  clipboardData: { items: [{ kind: "file", getAsFile: () => ({ name: "粘贴.png", type: "image/png", size: 512 }) }, { kind: "string" }] } }); });
assert.deepEqual([prevented, uploads.length, uploads.at(-1).file.name], [true, 9, "粘贴.png"]);

// 点名入口和键盘选择沿用输入区；Enter 接受候选，输入法确认和 Shift+Enter 都不能误发送。
{
  view = base(); messages = [];
  await mount();
  await click(buttons("groupChat.composer.mention")[0]);
  let input = renderer.root.findByType("textarea");
  assert.equal(input.props.value, "@");
  assert.equal(input.props["aria-expanded"], true);
  assert.equal(renderer.root.findAllByProps({ role: "option" }).length, 3);
  const key = (key, extra = {}) => ({ key, shiftKey: false, nativeEvent: { isComposing: false }, preventDefault() {}, ...extra });
  await act(async () => input.props.onKeyDown(key("ArrowDown")));
  await act(async () => renderer.root.findByType("textarea").props.onKeyDown(key("Enter")));
  input = renderer.root.findByType("textarea");
  assert.equal(input.props.value, "@b ");
  assert.equal(input.props["aria-expanded"], false);
  assert.equal(named("send").length, 0);
  await act(async () => input.props.onKeyDown(key("Enter", { nativeEvent: { isComposing: true } })));
  await act(async () => input.props.onKeyDown(key("Enter", { shiftKey: true })));
  assert.equal(named("send").length, 0);
  await act(async () => input.props.onKeyDown(key("Enter")));
  assert.deepEqual(plain(named("send")[0].args[1].mentions), ["b"]);
  uploads.length = 0;
  await act(async () => renderer.root.findByProps({ "data-chat-composer": true }).props.onDrop({
    dataTransfer: { files: [{ name: "drop.txt", type: "text/plain", size: 10 }] }, preventDefault() {},
  }));
  assert.equal(uploads.length, 1, "dropping a file uses the same upload and send gate as picking or pasting");
  assert.equal(buttons("groupChat.send")[0].props.disabled, true);
  await act(async () => renderer.unmount());
}


{
  view = base();
  view.activeTurns = [{ opportunityId: "pending-result", memberId: "b", startedAt: 1,
    recovery: { type: "result", reason: "GROUP_TURN_RESULT_EMPTY", since: 2, cancelRequested: false } }];
  fullAnswer = "完整正文🙂\n".repeat(2000) + "尾部 FINAL";
  messages = [failed(1, "b"), message(2, { kind: "member", memberId: "a" }, "正文节选", {
    fullResult: { bytes: Buffer.byteLength(fullAnswer), digest: sha256(fullAnswer) }, handoffs: [{ memberId: "b", excerpt: "@b 核对尾部" }],
  })];
  await mount();
  assert.equal(buttons("groupChat.retry").length, 0, "pending reconciliation does not expose the ordinary retry");
  await click(buttons("groupChat.recovery.reread")[0]);
  assert.deepEqual(plain(named("reconcile")[0].args), ["g", { kind: "turn", opportunityId: "pending-result" }]);
  await click(buttons("groupChat.fullResult.open")[0]);
  for (let n = 0; n < 10 && !JSON.stringify(renderer.toJSON()).includes("groupChat.fullResult.verified"); n++) {
    if (buttons("groupChat.fullResult.more")[0]) await click(buttons("groupChat.fullResult.more")[0]);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  assert.ok(JSON.stringify(renderer.toJSON()).includes("尾部 FINAL"));
  assert.ok(JSON.stringify(renderer.toJSON()).includes("groupChat.fullResult.verified"));
  assert.ok(named("readFull").length > 1);
  assert.ok(named("readFull").slice(1).every((call) => call.args[1].offset > 0 && call.args[1].digest === sha256(fullAnswer)));
  await act(async () => renderer.unmount());
}

// 固定角色版本读完后核对完整摘要；切换历史版本不能拼上上一版本的文本。
view = base(); messages = timeline();
roleSource = "公开角色🙂协作方式。\n".repeat(3000) + "角色全文尾部";
await mount();
await openDetails();
for (let n = 0; n < 15 && !JSON.stringify(renderer.toJSON()).includes("groupChat.fullResult.verified"); n++) {
  if (buttons("groupChat.fullResult.more")[0]) await click(buttons("groupChat.fullResult.more")[0]);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
}
assert.ok(JSON.stringify(renderer.toJSON()).includes("角色全文尾部"));
assert.ok(JSON.stringify(renderer.toJSON()).includes("groupChat.fullResult.verified"));
assert.ok(named("role").some(call => call.args[2].cursor?.startsWith("current:")));
await act(async () => { renderer.root.findAllByType("select").find(node => node.props.value === "latest").props.onChange({ target: { value: "old" } }); });
await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
assert.ok(JSON.stringify(renderer.toJSON()).includes(oldRoleSource));
assert.ok(!JSON.stringify(renderer.toJSON()).includes("角色全文尾部"));
await act(async () => renderer.unmount());
corruptRolePage = true;
await mount();
await openDetails();
await click(buttons("groupChat.fullResult.more")[0]);
assert.ok(JSON.stringify(renderer.toJSON()).includes("groupChat.fullResult.mismatch"));
assert.ok(!JSON.stringify(renderer.toJSON()).includes("角色全文尾部"));
assert.equal(buttons("groupChat.fullResult.more").length, 0, "a mismatched version stops paging");
await act(async () => renderer.unmount());

// Older saved bodies retain their digest while the redundant protocol header is omitted from presentation.
view = base(); messages = [message(7, { kind: "member", memberId: "a" }, "回复 #1\n\n保留的最终建议", {
  replyTo: { seq: 1, messageId: "m1", author: { kind: "user" }, excerpt: "一起看看" } })];
await mount();
assert.ok(!JSON.stringify(renderer.toJSON()).includes("回复 #1"));
assert.equal(load("src/lib/groupChat.ts").groupChatPreview({ ...view, lastMessage: messages[0] }, translate), "Alpha：保留的最终建议");
assert.ok(JSON.stringify(renderer.toJSON()).includes("保留的最终建议"));
const presentReply = load("src/lib/groupReply.ts").groupReplyBody;
assert.equal(presentReply(messages[0], "回复 #11\n正常编号不同"), "回复 #11\n正常编号不同");
assert.equal(presentReply(messages[0], "回复 #1 是正文中的解释"), "回复 #1 是正文中的解释");
await act(async () => renderer.unmount());

// ---- 群主、状态条与单独停下：发言中 / 在后台干活 / 等审批，每位都能单独停下；结果类型不在作者栏显示 ----
view = { ...base(), activeTurns: [
  { opportunityId: "speak", memberId: "a", startedAt: 1, floor: true, released: false, releasedReason: null },
  { opportunityId: "work", memberId: "b", startedAt: 1, floor: false, released: true, releasedReason: "working" },
  { opportunityId: "approve", memberId: "c", startedAt: 1, floor: false, released: true, releasedReason: "approval" }],
  pendingInteractions: [{ opportunityId: "approve", memberId: "c", status: "pending", request: { requestId: "q" }, context: null, occurredAt: 1 }] };
messages = [message(1, { kind: "user" }, "大家看看"),
  message(2, { kind: "member", memberId: "b" }, "后台做完了", { origin: { opportunityId: "earlier", runId: "r", discussionId: "d", late: true } })];
await mount();
assert.equal(renderer.root.find(node => node.props.className === "headerMembers").props.title, "Alpha · Beta · Gamma",
  "the compact header summarizes all active member names");
const status = renderer.root.findAll(node => node.props["data-group-status-member"]);
assert.deepEqual(status.map(node => [node.props["data-group-status-member"],
  node.findAllByType("span").flatMap(item => item.children).find(text => typeof text === "string" && text.startsWith("groupChat.status."))]),
[["a", "groupChat.status.speaking"], ["b", "groupChat.status.working"], ["c", "groupChat.status.approval"]]);
assert.equal(buttons("groupChat.status.stop").length, 3);
await click(buttons("groupChat.status.stop")[1]);
assert.deepEqual(plain(named("stopMember")[0].args), ["g", "b"], "stopping one member leaves the others running");
assert.equal(named("stop").length, 0);
assert.equal(byClass("muted").filter(node => node.children.includes("groupChat.turn.working")).length, 2,
  "members that gave up the floor are shown as working in the background");
assert.deepEqual(byClass("resultTag"), [], "reply type labels are hidden from the message author footer");
assert.equal(messages[1].origin.late, true, "hiding the label preserves the saved reply identity");
assert.equal(buttons("groupChat.stop").length, 1, "a running discussion keeps its stop action");
assert.equal(buttons("groupChat.send").length, 0, "send and stop actions are mutually exclusive");
await act(async () => renderer.root.findByType("textarea").props.onChange({ target: { value: "继续补充方向" } }));
await act(async () => renderer.root.findByType("textarea").props.onKeyDown({
  key: "Enter", shiftKey: false, nativeEvent: { isComposing: false }, preventDefault() {},
}));
assert.equal(named("send").length, 1, "Enter still sends while the send button is hidden");
assert.equal(named("stop").length, 0, "sending with Enter does not stop the discussion");
await act(async () => renderer.unmount());

// Published results precede older unfinished turns. A lagging view must not
// resurrect the turn/approval, while partial speech and a new turn stay live.
const mayaTurn = { opportunityId: "maya", memberId: "b", startedAt: 2, inputThroughSeq: 9, floor: false, released: true };
const deepTurn = { opportunityId: "deep", memberId: "c", startedAt: 3, floor: true, released: false };
const order = () => renderer.root.findAll(node => typeof node.type === "string"
  && (node.props["data-seq"] !== undefined || node.props["data-group-execution"] || node.props["data-group-interaction"]))
  .map(node => node.props["data-seq"] ?? `turn:${node.props["data-group-execution"] ?? node.props["data-group-interaction"]}`);
const initial = message(9, { kind: "user" }, "整理新闻", { createdAt: 1 });
const deepResult = message(11, { kind: "member", memberId: "c" }, "DeepSeek 已完成", { createdAt: 10, origin: { opportunityId: "deep" } });
const mayaPartial = message(12, { kind: "member", memberId: "b" }, "Maya 已开始，继续核对", { createdAt: 11, origin: { opportunityId: "maya", partial: true } });
const mayaResult = message(14, { kind: "member", memberId: "b" }, "Maya 已完成", { createdAt: 12, origin: { opportunityId: "maya", late: true } });
for (const [saved, expected] of [
  [[initial], [9, "turn:maya", "turn:deep"]],
  [[initial, deepResult], [9, 11, "turn:maya"]],
  [[initial, deepResult, mayaPartial], [9, 11, 12, "turn:maya"]],
  [[initial, deepResult, mayaPartial, mayaResult], [9, 11, 12, 14]],
]) {
  view = { ...base(), activeTurns: [deepTurn, mayaTurn] };
  messages = saved;
  await mount();
  assert.deepEqual(order(), expected, "published seq order and remaining execution cards stay separate");
  await act(async () => renderer.unmount());
}
view = { ...base(), activeTurns: [mayaTurn, { ...mayaTurn, opportunityId: "next-maya", startedAt: 13 }],
  pendingInteractions: [{ opportunityId: "maya", memberId: "b", status: "pending", request: { requestId: "old-approval" }, occurredAt: 2 }] };
messages = [initial, deepResult, mayaResult];
await mount();
assert.deepEqual(order(), [9, 11, 14, "turn:next-maya"], "final result clears only its exact turn and stale interaction");
await act(async () => renderer.unmount());

console.log("PASS group chat panel UI: retry, quote, compact and expanded roster, member tabs, owner settings, attachments, recovery, immutable pages, role versions, status capsule, published result ordering and exact turn settlement");
