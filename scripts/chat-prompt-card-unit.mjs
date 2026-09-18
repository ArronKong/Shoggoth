#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "..");
const componentPath = path.join(ROOT, "app/manage-ui/src/pages/ChatPromptCard.tsx");
const uiRequire = createRequire(path.join(ROOT, "app/manage-ui/package.json"));
const React = uiRequire("react");
const TestRenderer = uiRequire("react-test-renderer");

function loadComponent(filePath) {
const javaScript = ts.transpileModule(fs.readFileSync(filePath, "utf8"), {
  compilerOptions: {
    esModuleInterop: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: filePath,
}).outputText;

const module = { exports: {} };
const localRequire = (specifier) => {
  if (specifier.endsWith(".css")) return {};
  if (specifier.startsWith(".")) {
    const target = path.resolve(path.dirname(filePath), specifier);
    return loadComponent(fs.existsSync(`${target}.tsx`) ? `${target}.tsx` : `${target}.ts`);
  }
  if (specifier === "react-i18next") return {
    useTranslation: () => ({
      t: (key, values) => values?.hosts ? `${key}:${values.hosts}` : key,
    }),
  };
  return uiRequire(specifier);
};
vm.runInNewContext(`(function(require, module, exports) { ${javaScript}\n})(require, module, module.exports);`, {
  require: localRequire,
  module,
  exports: module.exports,
  window: { setTimeout, clearTimeout },
});
return module.exports;
}
const component = loadComponent(componentPath);
const ChatPromptCard = component.default;
const { chatPromptAttentionOf, interruptedApprovalEntry } = component;
const visibleTextOf = (node) => {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(visibleTextOf).join(" ");
  return node?.children ? visibleTextOf(node.children) : "";
};

assert.equal(chatPromptAttentionOf([]), null);
assert.equal(chatPromptAttentionOf([{ id: "legacy-approval", kind: "approval" }]), "approval");
assert.equal(chatPromptAttentionOf([{ id: "legacy-input", kind: "clarify" }]), "input");
assert.equal(chatPromptAttentionOf([{
  id: "canonical-approval",
  version: 1,
  kind: "runtime_approval",
  fields: [],
}]), "approval");
assert.equal(chatPromptAttentionOf([{
  id: "canonical-input",
  version: 1,
  kind: "user_input",
  fields: [{ id: "value" }],
}]), "input");
assert.equal(chatPromptAttentionOf([
  { id: "input-first", kind: "clarify" },
  { id: "approval-second", kind: "mcp_tool_approval" },
]), "approval", "同一会话有多种阻塞请求时审批必须优先提示");

const replies = [];
let renderer;
const interrupted = interruptedApprovalEntry({
  version: 1, runId: "stopped-run", requestId: "stopped-request", kind: "runtime_approval",
  title: "需要授权", message: "Edit capture.md", fields: [], expiresAt: null,
  approvalChoices: ["once", "session", "deny"],
  approvalDetails: { kind: "file_change", input: JSON.stringify({ file_path: "/workspace/capture.md" }) },
});
assert.ok(interrupted);
assert.equal(interruptedApprovalEntry({}), null);
assert.equal(chatPromptAttentionOf([interrupted]), null, "历史授权不能让 Agent 再次显示等待审批");
TestRenderer.act(() => {
  renderer = TestRenderer.create(React.createElement(ChatPromptCard, {
    entry: interrupted, onRespond: () => assert.fail("历史授权不能提交"),
  }));
});
assert.equal(renderer.root.findAllByType("button").length, 0);
assert.ok(visibleTextOf(renderer.toJSON()).includes("chat.promptInterruptedApproval"));
assert.ok(visibleTextOf(renderer.toJSON()).includes("/workspace/capture.md"));
renderer.unmount();

TestRenderer.act(() => {
  renderer = TestRenderer.create(React.createElement(ChatPromptCard, {
    entry: {
      id: "prompt-multi",
      version: 1,
      requestId: "request-multi",
      runId: "run-multi",
      kind: "user_input",
      title: "需要补充信息",
      message: "请补充部署信息",
      fields: [
        {
          id: "region",
          type: "choice",
          label: "区域",
          description: "部署区域",
          required: true,
          secret: false,
          options: [
            { value: "cn-north", label: "华北", description: "北京区域" },
            { value: "cn-east", label: "华东", description: "上海区域" },
          ],
        },
        {
          id: "project",
          type: "text",
          label: "项目",
          description: "可选项目名",
          required: false,
          secret: false,
          options: [],
        },
      ],
      approvalChoices: [],
      expiresAt: null,
    },
    onRespond: (entry, data) => replies.push({ entry, data }),
  }));
});

const inputs = renderer.root.findAllByType("input");
assert.equal(inputs.length, 1, "choice 必须渲染明确选项，不能退化成自由文本");
assert.deepEqual(inputs.map((input) => input.props["aria-label"]), ["项目"]);
const regionButton = renderer.root.findAllByType("button")
  .find((button) => button.children.join("") === "华北");
assert.ok(regionButton, "choice label 必须显示给用户");
TestRenderer.act(() => regionButton.props.onClick());
const submit = renderer.root.findAllByType("button")
  .find((button) => button.children.join("") === "chat.promptSubmit");
assert.equal(submit.props.disabled, false);
TestRenderer.act(() => {
  submit.props.onClick();
  submit.props.onClick();
});
assert.deepEqual(structuredClone(replies.map(({ data }) => data)), [{
  action: "submit", answers: { region: "cn-north" },
}], "UI 必须提交 option value，且同事件循环双击只能响应一次");
renderer.unmount();

TestRenderer.act(() => {
  renderer = TestRenderer.create(React.createElement(ChatPromptCard, {
    entry: {
      id: "question-request-multi",
      kind: "openclaw_question",
      questions: [{
        questionId: "targets",
        header: "目标",
        question: "选择一个或多个目标",
        options: [
          { label: "macOS", description: "桌面应用" },
          { label: "Web", description: "浏览器" },
        ],
        multiSelect: true,
        isOther: true,
      }],
      createdAtMs: Date.now() - 1_000,
      expiresAtMs: Date.now() + 60_000,
      status: "pending",
    },
    onRespond: (entry, data) => replies.push({ entry, data }),
  }));
});
const questionButtons = renderer.root.findAllByType("button");
const macOption = questionButtons.find((button) => button.children.join("") === "macOS");
const webOption = questionButtons.find((button) => button.children.join("") === "Web");
assert.ok(macOption && webOption, "OpenClaw question options must render by label");
TestRenderer.act(() => {
  macOption.props.onClick();
  webOption.props.onClick();
});
const otherInput = renderer.root.findByType("input");
assert.equal(otherInput.props.type, "text");
TestRenderer.act(() => otherInput.props.onChange({ target: { value: "CLI" } }));
const questionSubmit = renderer.root.findAllByType("button")
  .find((button) => button.children.join("") === "chat.promptSubmit");
assert.equal(questionSubmit.props.disabled, false, "multi-select plus Other must be submittable");
TestRenderer.act(() => {
  questionSubmit.props.onClick();
  questionSubmit.props.onClick();
});
assert.deepEqual(structuredClone(replies.at(-1).data), {
  action: "submit",
  questionAnswers: { targets: ["macOS", "Web", "CLI"] },
}, "OpenClaw question answers must preserve all selected labels and Other text");
renderer.unmount();

TestRenderer.act(() => {
  renderer = TestRenderer.create(React.createElement(ChatPromptCard, {
    entry: {
      id: "question-request-secret",
      kind: "openclaw_question",
      questions: [{
        questionId: "token",
        header: "API Token",
        question: "请输入凭证",
        options: [],
        isSecret: true,
        secretStore: {
          name: "EXAMPLE_API_TOKEN",
          kind: "secret",
          allowedHosts: ["api.example.com"],
          reason: "供后续请求使用",
        },
        secretStoreExisting: { updatedAtMs: Date.now() - 10_000 },
      }],
      createdAtMs: Date.now() - 1_000,
      expiresAtMs: Date.now() + 60_000,
      status: "pending",
    },
    onRespond: (entry, data) => replies.push({ entry, data }),
  }));
});
const secretInput = renderer.root.findByType("input");
assert.equal(secretInput.props.type, "password", "secret question must use a masked input");
assert.equal(secretInput.props.autoComplete, "off");
TestRenderer.act(() => secretInput.props.onChange({ target: { value: "top-secret-value" } }));
const visibleText = visibleTextOf(renderer.toJSON());
assert.equal(visibleText.includes("top-secret-value"), false,
  "secret value must never be rendered as ordinary text");
assert.equal(visibleText.includes("api.example.com"), true,
  "secret-store host scope must be visible before consent");
assert.equal(visibleText.includes("chat.promptSecretExisting"), true,
  "replacement of an existing stored secret must be disclosed");
const secretSubmit = renderer.root.findAllByType("button")
  .find((button) => button.children.join("") === "chat.promptSubmit");
TestRenderer.act(() => secretSubmit.props.onClick());
assert.deepEqual(structuredClone(replies.at(-1).data), {
  action: "submit",
  questionAnswers: { token: ["top-secret-value"] },
});
renderer.unmount();

TestRenderer.act(() => {
  renderer = TestRenderer.create(React.createElement(ChatPromptCard, {
    entry: {
      id: "question-request-single",
      kind: "openclaw_question",
      questions: [{
        questionId: "choice",
        header: "选择",
        question: "请选择一个",
        options: [{ label: "A" }, { label: "B" }],
      }],
      createdAtMs: Date.now() - 1_000,
      expiresAtMs: Date.now() + 60_000,
      status: "pending",
    },
    onRespond: (entry, data) => replies.push({ entry, data }),
  }));
});
const singleQuestionOptions = renderer.root.findAllByType("button")
  .filter((button) => button.props.role === "radio");
TestRenderer.act(() => {
  singleQuestionOptions[0].props.onClick();
  singleQuestionOptions[1].props.onClick();
});
const singleQuestionSubmit = renderer.root.findAllByType("button")
  .find((button) => button.children.join("") === "chat.promptSubmit");
TestRenderer.act(() => singleQuestionSubmit.props.onClick());
assert.deepEqual(structuredClone(replies.at(-1).data), {
  action: "submit",
  questionAnswers: { choice: ["B"] },
}, "single-select question must submit only the latest selected label");
renderer.unmount();

TestRenderer.act(() => {
  renderer = TestRenderer.create(React.createElement(ChatPromptCard, {
    entry: {
      id: "question-request-skip",
      kind: "openclaw_question",
      questions: [{
        questionId: "choice",
        header: "选择",
        question: "请选择",
        options: [{ label: "A" }, { label: "B" }],
      }],
      createdAtMs: Date.now() - 1_000,
      expiresAtMs: Date.now() + 60_000,
      status: "pending",
    },
    onRespond: (entry, data) => replies.push({ entry, data }),
  }));
});
const skipButton = renderer.root.findAllByType("button")
  .find((button) => button.children.join("") === "setup.skip");
assert.ok(skipButton, "pending OpenClaw question must offer Skip");
TestRenderer.act(() => skipButton.props.onClick());
assert.deepEqual(structuredClone(replies.at(-1).data), { action: "cancel" },
  "Skip must remain distinct from an empty answer");
renderer.unmount();

TestRenderer.act(() => {
  renderer = TestRenderer.create(React.createElement(ChatPromptCard, {
    entry: {
      id: "question-request-expired",
      kind: "openclaw_question",
      questions: [{
        questionId: "choice",
        header: "选择",
        question: "请选择",
        options: [{ label: "A" }, { label: "B" }],
      }],
      createdAtMs: Date.now() - 60_000,
      expiresAtMs: Date.now() - 1,
      status: "pending",
    },
    onRespond: (entry, data) => replies.push({ entry, data }),
  }));
});
assert.equal(renderer.root.findAllByType("button").length, 0,
  "locally expired question must not keep actionable controls");
assert.ok(renderer.root.findAll((node) => node.children?.join("") === "dashboard.expired").length > 0,
  "expired question must have an explicit terminal state");
renderer.unmount();

TestRenderer.act(() => {
  renderer = TestRenderer.create(React.createElement(ChatPromptCard, {
    entry: { id: "prompt-single", kind: "clarify", question: "继续吗？" },
    onRespond: (entry, data) => replies.push({ entry, data }),
  }));
});
const singleInput = renderer.root.findByType("input");
TestRenderer.act(() => singleInput.props.onChange({ target: { value: "继续" } }));
const singleSubmit = renderer.root.findAllByType("button").find((button) => button.props.className.includes("is-primary"));
TestRenderer.act(() => singleSubmit.props.onClick());
assert.deepEqual(structuredClone(replies.at(-1).data), { value: "继续" }, "旧单问题路径必须保持兼容");
renderer.unmount();

TestRenderer.act(() => {
  renderer = TestRenderer.create(React.createElement(ChatPromptCard, {
    entry: {
      id: "prompt-mcp-tool",
      version: 1,
      requestId: "request-mcp-tool",
      runId: "run-mcp-tool",
      kind: "mcp_permission",
      title: "工具授权",
      message: "允许 shoggoth MCP 运行工具 external_agent_run？",
      fields: [],
      approvalChoices: ["once", "session", "deny"],
      expiresAt: null,
    },
    onRespond: (entry, data) => replies.push({ entry, data }),
  }));
});
assert.equal(renderer.root.findAllByType("input").length, 0,
  "空 schema MCP 权限请求必须渲染为按钮，不能退化成文本输入");
const permissionButtons = renderer.root.findAllByType("button");
assert.deepEqual(permissionButtons.map(visibleTextOf), [
  "chat.promptAllowOnce", "chat.promptAllowSession", "chat.promptDenyOperation",
], "all supported approval choices must be available without expanding a menu");
TestRenderer.act(() => permissionButtons[1].props.onClick());
assert.deepEqual(structuredClone(replies.at(-1).data), { choice: "session" });
renderer.unmount();

const approvalEntry = {
  id: "native-approval", version: 1, kind: "runtime_approval", requestId: "native-request", runId: "native-run",
  title: "需要授权", message: "shoggoth__kanban_card_create", fields: [], expiresAt: null,
  approvalChoices: ["once", "session", "deny", "cancel"],
  approvalDetails: {
    kind: "command", toolName: "shoggoth__kanban_card_create",
    input: JSON.stringify({ boardId: "board-42", title: "Remember this idea", body: "A small first step" }),
  },
};
function mountApproval(entry = approvalEntry, onRespond = (_entry, data) => replies.push({ data })) {
  TestRenderer.act(() => { renderer = TestRenderer.create(React.createElement(ChatPromptCard, { entry, onRespond })); });
}
mountApproval();
let approvalText = visibleTextOf(renderer.toJSON());
assert.ok(approvalText.includes("chat.promptActions.kanban_card_create"));
assert.ok(approvalText.includes("Remember this idea") && approvalText.includes("board-42"));
assert.ok(!approvalText.includes("需要授权"), "the canonical heading must follow the UI locale");
assert.deepEqual(renderer.root.findAllByType("button").map(visibleTextOf), [
  "chat.promptAllowOnce", "chat.promptAllowSession", "chat.promptDenyOperation",
], "native approvals must omit the stop-turn action");
assert.equal(renderer.root.findAllByType("details").length, 0, "approval details must not be expandable");
assert.equal(renderer.root.findAllByProps({ role: "menu" }).length, 0);
const deny = renderer.root.findAllByType("button").find((button) => visibleTextOf(button) === "chat.promptDenyOperation");
TestRenderer.act(() => deny.props.onClick());
assert.deepEqual(structuredClone(replies.at(-1).data), { choice: "deny" });
renderer.unmount();

mountApproval({ ...approvalEntry, approvalChoices: ["once", "deny", "cancel"] });
assert.deepEqual(renderer.root.findAllByType("button").map(visibleTextOf), ["chat.promptAllowOnce", "chat.promptDenyOperation"],
  "one-time approvals must not offer unsupported reusable scopes");
renderer.unmount();

mountApproval({ ...approvalEntry, approvalChoices: ["deny", "cancel"] });
approvalText = visibleTextOf(renderer.toJSON());
assert.ok(!approvalText.includes("Remember this idea") && !approvalText.includes("board-42"),
  "unavailable approval details must remain hidden even if stale metadata is present");
assert.deepEqual(renderer.root.findAllByType("button").map(visibleTextOf), ["chat.promptDenyOperation"]);
renderer.unmount();

const permissionEntry = {
  ...approvalEntry, message: "Download dependencies and update the project.",
  approvalDetails: {
    kind: "permissions", cwd: "/workspace/project",
    permissions: JSON.stringify({
      fileSystem: { read: ["/workspace/reference", "/workspace/spec.md"], write: ["/workspace/project"] },
      network: { enabled: true },
    }),
  },
};
mountApproval(permissionEntry);
approvalText = visibleTextOf(renderer.toJSON());
for (const text of ["chat.promptPermissions.filesAndNetworkTitle", permissionEntry.message,
  "chat.promptPermissions.read", "/workspace/reference", "/workspace/spec.md",
  "chat.promptPermissions.write", "/workspace/project", "chat.promptPermissions.networkEnabled",
  "chat.promptPermissions.cwd"]) assert.ok(approvalText.includes(text), `permission card must show ${text}`);
assert.equal(renderer.root.findAllByType("details").length, 0, "permission scopes must be visible without expanding");
assert.deepEqual(renderer.root.findAllByType("button").map(visibleTextOf), [
  "chat.promptAllowTurn", "chat.promptAllowSession", "chat.promptDenyOperation",
]);
TestRenderer.act(() => renderer.root.findAllByType("button")[0].props.onClick());
assert.deepEqual(structuredClone(replies.at(-1).data), { choice: "once" }, "readable scopes must not alter the grant response");
renderer.unmount();

const permissionCases = [
  [{ fileSystem: { entries: [
    { access: "read", path: { type: "path", path: "/reference/guide.md" } },
    { access: "write", path: { type: "glob_pattern", pattern: "/project/**/*.md" } },
    { access: "deny", path: { type: "path", path: "/project/.env" } },
    { access: "write", path: { type: "special", value: { kind: "project_roots", subpath: "docs" } } },
    { access: "read", path: { type: "special", value: { kind: "root" } } },
  ], globScanMaxDepth: 3 }, network: null },
  ["filesTitle", "read", "/reference/guide.md", "write", "matchingPaths", "/project/**/*.md",
    "deny", "/project/.env", "paths.project_roots", "docs", "paths.root", "scanDepth", "3"]],
  [{ fileSystem: null, network: { enabled: false } }, ["networkTitle", "networkDisabled"]],
  [{ fileSystem: null, network: { enabled: true } }, ["networkTitle", "networkEnabled"]],
  [{ fileSystem: null, network: null }, ["unspecified"]],
  [{ network: { enabled: true, allowedHosts: ["example.com"] } }, ["other", "allowedHosts", "example.com"]],
  [{ fileSystem: { entries: [{ access: "write", path: { type: "special", value: { kind: "unknown", path: "future-root" } } }] } },
    ["other", "future-root"]],
  [{ fileSystem: { write: [42] } }, ["other", "42"]],
];
for (const [permissions, expected] of permissionCases) {
  mountApproval({ ...permissionEntry, approvalDetails: { kind: "permissions", permissions: JSON.stringify(permissions) } });
  approvalText = visibleTextOf(renderer.toJSON());
  for (const text of expected) assert.ok(approvalText.includes(text), `permission summary must preserve ${text}`);
  if (permissions.network?.enabled === false) assert.ok(!approvalText.includes("networkEnabled"));
  renderer.unmount();
}
for (const permissions of [undefined, "not-valid-json"]) {
  mountApproval({ ...permissionEntry, approvalDetails: { kind: "permissions", permissions } });
  approvalText = visibleTextOf(renderer.toJSON());
  assert.ok(approvalText.includes(permissions ? "chat.promptPermissions.unreadable" : "chat.promptPermissions.unspecified"));
  if (permissions) assert.ok(approvalText.includes(permissions), "unreadable request must remain available inline");
  renderer.unmount();
}
mountApproval({ ...permissionEntry, approvalChoices: ["deny", "cancel"] });
approvalText = visibleTextOf(renderer.toJSON());
assert.ok(!approvalText.includes("/workspace/") && !approvalText.includes("chat.promptPermissions.networkEnabled"),
  "deny-only recovery must not reveal stale permission scopes");
renderer.unmount();

mountApproval({ id: "hermes-approval", kind: "approval", command: "pwd", choices: ["once", "session", "always", "deny"] });
assert.deepEqual(renderer.root.findAllByType("button").map(visibleTextOf), [
  "chat.promptAllowOnce", "chat.promptAllowSession", "chat.promptAllowAlways", "chat.promptDenyOperation",
]);
TestRenderer.act(() => renderer.root.findAllByType("button")
  .find((button) => visibleTextOf(button) === "chat.promptAllowAlways").props.onClick());
assert.deepEqual(structuredClone(replies.at(-1).data), { choice: "always" }, "legacy persistent approval must still route upstream");
renderer.unmount();

// Captured from Grok 1.0.30: this pending file approval has no recognized scope.
const grokSessionEdits = { ...approvalEntry,
  approvalChoices: ["runtime:0", "once", "deny", "cancel"],
  approvalOptions: [
    { choice: "runtime:0", kind: "allow_always", label: "Yes, allow all edits during this session" },
    { choice: "once", kind: "allow_once", label: "Yes" },
    { choice: "deny", kind: "reject_once", label: "No, and tell Grok what to do differently" },
  ],
  approvalDetails: { kind: "file_change", input: JSON.stringify({ file_path: "/project/capture-vague-idea.md" }) },
};
mountApproval(grokSessionEdits);
assert.deepEqual(renderer.root.findAllByType("button").map(visibleTextOf), [
  "chat.promptAllowSession", "chat.promptAllowOnce", "chat.promptDenyOperation",
], "existing Grok approvals without scope metadata must localize the known session-edit option");
TestRenderer.act(() => renderer.root.findAllByType("button")[0].props.onClick());
assert.deepEqual(structuredClone(replies.at(-1).data), { choice: "runtime:0" },
  "localization must preserve the exact native choice");
renderer.unmount();

const { approvalOptionLabel, approvalOptionHint, approvalOptionIsVisible } = loadComponent(path.join(ROOT, "app/manage-ui/src/lib/approvalOptions.ts"));
for (const locale of ["zh-CN", "en"]) {
  const dictionary = loadComponent(path.join(ROOT, `app/manage-ui/src/i18n/locales/${locale}.ts`)).default;
  const t = (key) => key.split(".").reduce((value, part) => value[part], dictionary);
  assert.equal(approvalOptionLabel(grokSessionEdits.approvalOptions[0], t), dictionary.chat.promptAllowSession,
    "session file permission must reuse the existing session label");
  assert.equal(approvalOptionHint(grokSessionEdits.approvalOptions[0], t), dictionary.chat.promptSessionFilesScopeHint);
}
assert.equal(approvalOptionLabel({ choice: "runtime:0", kind: "allow_always", label: "Custom file rule" }, (key) => key),
  "chat.promptAllowAlways", "unknown wording must use the approval-kind preset without implying session permission");
assert.equal(approvalOptionLabel({ ...grokSessionEdits.approvalOptions[0], scope: "tool" }, (key) => key),
  "chat.promptAllowTool", "explicit scope remains authoritative");
assert.equal(approvalOptionLabel({ ...grokSessionEdits.approvalOptions[0], kind: "allow_once" }, (key) => key),
  "chat.promptAllowOnce", "the option kind determines the preset when wording disagrees");

// Real Grok command approval: native text varies, while ACP kinds stay stable.
const grokBashEntry = { ...approvalEntry,
  approvalChoices: ["runtime:0", "once", "deny", "runtime:3", "cancel"],
  approvalOptions: [
    { choice: "runtime:0", kind: "allow_always", label: "Yes, and don't ask again for bash commands" },
    { choice: "once", kind: "allow_once", label: "Yes, proceed" },
    { choice: "deny", kind: "reject_once", label: "No, and tell Grok what to do differently" },
    { choice: "runtime:3", kind: "reject_always", label: "No, and don't ask again for this command" },
  ],
  approvalDetails: { kind: "command", command: "date" },
};
mountApproval(grokBashEntry);
assert.deepEqual(renderer.root.findAllByType("button").map(visibleTextOf), [
  "chat.promptAllowAlways", "chat.promptAllowOnce", "chat.promptDenyOperation",
], "native approvals must use localized presets and show only one denial");
TestRenderer.act(() => renderer.root.findAllByType("button")[2].props.onClick());
assert.deepEqual(structuredClone(replies.at(-1).data), { choice: "deny" },
  "the single Deny button must reject once, never persist a denial");
renderer.unmount();
assert.deepEqual(grokBashEntry.approvalOptions.filter(approvalOptionIsVisible).map((option) => option.choice),
  ["runtime:0", "once", "deny"], "chat and dashboard must omit the persistent-denial option");
assert.equal(approvalOptionIsVisible({ choice: "runtime:4", kind: "reject_once", label: "Another denial" }), false,
  "additional native rejection variants must not add another Deny button");
mountApproval({ ...grokBashEntry,
  approvalChoices: ["runtime:0", "once", "runtime:3", "deny", "cancel"],
  approvalOptions: grokBashEntry.approvalOptions.filter((option) => option.kind !== "reject_once"),
});
assert.deepEqual(renderer.root.findAllByType("button").map(visibleTextOf), [
  "chat.promptAllowAlways", "chat.promptAllowOnce", "chat.promptDenyOperation",
], "a request without native reject_once still retains the canonical safe Deny action");
renderer.unmount();
for (const locale of ["zh-CN", "en"]) {
  const dictionary = loadComponent(path.join(ROOT, `app/manage-ui/src/i18n/locales/${locale}.ts`)).default;
  const t = (key) => key.split(".").reduce((value, part) => value[part], dictionary);
  const expected = [dictionary.chat.promptAllowAlways, dictionary.chat.promptAllowOnce,
    dictionary.chat.promptDenyOperation, dictionary.chat.promptDenyOperation];
  assert.ok(expected.every((label) => typeof label === "string" && label.length > 0));
  assert.deepEqual(grokBashEntry.approvalOptions.map((option) => approvalOptionLabel(option, t)), expected);
  for (const [index, option] of grokBashEntry.approvalOptions.entries()) {
    const unfamiliar = { ...option, choice: `runtime:${index}`, label: `Unfamiliar provider wording ${index}` };
    assert.equal(approvalOptionLabel(unfamiliar, t), expected[index], "new provider wording must still use the same preset");
    assert.equal(approvalOptionHint(unfamiliar, t), unfamiliar.label, "native scope must remain available in existing hover text");
  }
}
const alternativeRules = ["npm test", "npm test --unit"].map((rule, index) => ({
  choice: `runtime:${index}`, kind: "allow_always", label: `Always allow: ${rule}`,
}));
assert.deepEqual(alternativeRules.map((option) => approvalOptionLabel(option, (key) => key, alternativeRules)),
  ["chat.promptAllowAlways (1)", "chat.promptAllowAlways (2)"],
  "different native rules must remain distinct without putting commands on the buttons");

let finishResponse;
const grokEntry = { ...approvalEntry,
  approvalChoices: ["once", "runtime:1", "runtime:2", "runtime:3", "deny", "cancel"],
  approvalOptions: [
    { choice: "once", label: "Allow once", kind: "allow_once" },
    { choice: "runtime:1", label: "Always allow this tool", kind: "allow_always", scope: "tool" },
    { choice: "runtime:2", label: "Always allow this server", kind: "allow_always", scope: "server" },
    { choice: "runtime:3", label: "Always allow: npm test --*", kind: "allow_always" },
    { choice: "deny", label: "Reject", kind: "reject_once" },
  ],
};
mountApproval(grokEntry);
assert.deepEqual(renderer.root.findAllByType("button").map(visibleTextOf), [
  "chat.promptAllowOnce", "chat.promptAllowTool", "chat.promptAllowServer", "chat.promptAllowAlways", "chat.promptDenyOperation",
], "Grok scopes remain separate and the remembered command has a compact button");
TestRenderer.act(() => renderer.root.findAllByType("button")[3].props.onClick());
assert.deepEqual(structuredClone(replies.at(-1).data), { choice: "runtime:3" });
renderer.unmount();

mountApproval({ ...grokEntry, approvalChoices: ["deny", "cancel"] });
assert.deepEqual(renderer.root.findAllByType("button").map(visibleTextOf), ["chat.promptDenyOperation"]);
assert.ok(!visibleTextOf(renderer.toJSON()).includes("Remember this idea"), "stale native allow options must not restore hidden details");
renderer.unmount();

mountApproval(approvalEntry, () => new Promise((_resolve, reject) => { finishResponse = reject; }));
TestRenderer.act(() => renderer.root.findAllByType("button")[0].props.onClick());
assert.ok(renderer.root.findAllByType("button").every((button) => button.props.disabled));
await TestRenderer.act(async () => { finishResponse(new Error("relay unavailable")); });
assert.ok(renderer.root.findAllByType("button").every((button) => !button.props.disabled),
  "a failed response must leave the same card available for retry");
renderer.unmount();

console.log("chat prompt card: PASS");
