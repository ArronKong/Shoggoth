#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";

const ROOT = path.resolve(import.meta.dirname, "..");
const componentPath = path.join(ROOT, "app/manage-ui/src/pages/ChatPromptCard.tsx");
const uiRequire = createRequire(path.join(ROOT, "app/manage-ui/package.json"));
const ts = uiRequire("typescript");
const React = uiRequire("react");
const TestRenderer = uiRequire("react-test-renderer");

function loadComponent(filePath, mocks = {}) {
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
  if (specifier.endsWith("/i18n/promptCardResources")) return {};
  if (Object.hasOwn(mocks, specifier)) return mocks[specifier];
  if (specifier.endsWith(".css")) return {};
  if (specifier.startsWith(".")) {
    const target = path.resolve(path.dirname(filePath), specifier);
    return loadComponent(fs.existsSync(`${target}.tsx`) ? `${target}.tsx` : `${target}.ts`, mocks);
  }
  if (specifier === "react-i18next") return {
    useTranslation: () => ({
      // Interpolated values stay visible so composed headlines can be asserted.
      t: (key, values) => values?.hosts ? `${key}:${values.hosts}`
        : values ? `${key}:${Object.values(values).join("|")}` : key,
    }),
  };
  return uiRequire(specifier);
};
vm.runInNewContext(`(function(require, module, exports) { ${javaScript}\n})(require, module, module.exports);`, {
  require: localRequire,
  module,
  exports: module.exports,
  window: { setTimeout, clearTimeout },
  setTimeout, clearTimeout, crypto, Error,
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

const inputs = renderer.root.findAllByType("textarea");
assert.equal(inputs.length, 1, "只有自由文本字段使用多行输入区");
assert.equal(renderer.root.findAllByType("input").filter(input => input.props.type === "radio").length, 2);
assert.ok(visibleTextOf(renderer.toJSON()).includes("北京区域"), "选项说明必须直接显示");
assert.deepEqual(inputs.map((input) => input.props["aria-label"]), ["项目"]);
const regionButton = renderer.root.findByProps({ "aria-label": "华北" });
assert.ok(regionButton, "choice label 必须显示给用户");
TestRenderer.act(() => regionButton.props.onChange());
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

// Legacy questions now use the same explicit selection flow, with free text
// remaining an alternative rather than an extra selected answer.
const legacyChoices = [];
TestRenderer.act(() => { renderer = TestRenderer.create(React.createElement(ChatPromptCard, {
  entry: { id: "legacy-options", kind: "clarify", question: "执行范围", choices: ["本周", "本月"] },
  onRespond: (_entry, data) => { legacyChoices.push(data); },
})); });
TestRenderer.act(() => renderer.root.findByProps({ "aria-label": "本周" }).props.onChange());
assert.equal(legacyChoices.length, 0);
assert.equal(renderer.root.findByProps({ "aria-label": "本周" }).props.checked, true);
TestRenderer.act(() => renderer.root.findByType("textarea").props.onChange({ target: { value: "仅周一\n保留原始换行" } }));
assert.equal(renderer.root.findByProps({ "aria-label": "本周" }).props.checked, false);
let enterPrevented = false;
TestRenderer.act(() => renderer.root.findByType("textarea").props.onKeyDown({ key: "Enter", nativeEvent: { isComposing: false },
  preventDefault: () => { enterPrevented = true; } }));
assert.equal(enterPrevented, false, "plain Enter in a multiline answer must insert a newline");
assert.equal(legacyChoices.length, 0);
await TestRenderer.act(async () => renderer.root.findAllByType("button")[0].props.onClick());
assert.deepEqual(structuredClone(legacyChoices), [{ value: "仅周一\n保留原始换行" }]);
renderer.unmount();

const confirmationMessage = "删除后其配置可能无法恢复，确定要删除吗？";
const confirmationEntry = {
  id: "confirmation", version: 1, requestId: "confirmation-request", runId: "confirmation-run",
  kind: "user_input", title: "需要补充信息", message: confirmationMessage,
  fields: [{ id: "confirm_delete", type: "choice", label: "确认删除", description: confirmationMessage,
    required: true, secret: false, options: [
      { value: "确定删除 (Recommended)", label: "确定删除 (Recommended)", description: "永久删除这个 AI 助理。" },
      { value: "cancel-value", label: "取消", description: "保留助理，不做任何更改。" },
    ] }], approvalChoices: [], expiresAt: null,
};
for (const kind of ["user_input", "product_confirmation"]) {
  for (const index of [0, 1]) {
    const responses = [];
    TestRenderer.act(() => {
      renderer = TestRenderer.create(React.createElement(ChatPromptCard, {
        entry: { ...confirmationEntry, kind }, onRespond: (_entry, data) => { responses.push(data); },
      }));
    });
    const buttons = renderer.root.findAllByType("button");
    assert.deepEqual(buttons.map(visibleTextOf), ["确定删除", "取消"],
      "both model questions and product confirmations need exactly two direct actions");
    assert.equal(responses.length, 0, "mounting a confirmation must never submit or preselect an answer");
    assert.equal(visibleTextOf(renderer.toJSON()).split(confirmationMessage).length - 1, 1,
      "duplicate message and field descriptions must appear only once");
    assert.equal(renderer.root.findAllByProps({ className: "chat-prompt__desc" }).length, 0,
      "confirmation buttons must not have a second explanatory row");
    assert.equal(buttons[0].props.title, "永久删除这个 AI 助理。", "option hints remain available on hover");
    assert.equal(buttons[0].props["aria-pressed"], undefined, "confirmation controls are actions, not selected answers");
    await TestRenderer.act(async () => { buttons[index].props.onClick(); buttons[index].props.onClick(); });
    assert.deepEqual(structuredClone(responses), [{ action: "submit", answers: {
      confirm_delete: confirmationEntry.fields[0].options[index].value,
    } }], "each action must immediately submit its exact original value once, including Cancel");
    renderer.unmount();
  }
}

let rejectConfirmation;
const confirmationResponses = [];
TestRenderer.act(() => {
  renderer = TestRenderer.create(React.createElement(ChatPromptCard, {
    entry: confirmationEntry,
    onRespond: (_entry, data) => {
      confirmationResponses.push(data);
      return new Promise((_resolve, reject) => { rejectConfirmation = reject; });
    },
  }));
});
TestRenderer.act(() => renderer.root.findAllByType("button")[0].props.onClick());
assert.ok(renderer.root.findAllByType("button").every((button) => button.props.disabled),
  "confirmation actions must be disabled while the response is in flight");
await TestRenderer.act(async () => { rejectConfirmation(new Error("response failed")); });
assert.ok(renderer.root.findAllByType("button").every((button) => !button.props.disabled),
  "failed confirmation submissions must remain retryable");
TestRenderer.act(() => renderer.root.findAllByType("button")[1].props.onClick());
assert.equal(confirmationResponses.length, 2, "the user can choose Cancel after a failed confirmation");
await TestRenderer.act(async () => { rejectConfirmation(new Error("response failed")); });
renderer.unmount();

for (const fields of [
  [{ ...confirmationEntry.fields[0], options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }],
  [{ ...confirmationEntry.fields[0], secret: true }],
  [confirmationEntry.fields[0], { id: "reason", type: "text", label: "原因", description: "", required: false, secret: false, options: [] }],
]) {
  const responses = [];
  TestRenderer.act(() => {
    renderer = TestRenderer.create(React.createElement(ChatPromptCard, {
      entry: { ...confirmationEntry, fields }, onRespond: (_entry, data) => { responses.push(data); },
    }));
  });
  assert.ok(renderer.root.findAllByType("button").some((button) => visibleTextOf(button) === "chat.promptSubmit"),
    "ordinary choices, secret fields and multi-field forms must keep explicit submission");
  TestRenderer.act(() => renderer.root.findAllByType("input").find(input => input.props.type === "radio").props.onChange());
  assert.equal(responses.length, 0, "ordinary form selections must not submit the form");
  renderer.unmount();
}

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
const macOption = renderer.root.findByProps({ "aria-label": "macOS" });
const webOption = renderer.root.findByProps({ "aria-label": "Web" });
assert.equal(macOption.props.type, "checkbox");
assert.ok(visibleTextOf(renderer.toJSON()).includes("桌面应用"));
assert.ok(macOption && webOption, "OpenClaw question options must render by label");
TestRenderer.act(() => {
  macOption.props.onChange();
  webOption.props.onChange();
});
const otherInput = renderer.root.findByType("textarea");
assert.equal(otherInput.props.rows, 3);
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
const singleQuestionOptions = renderer.root.findAllByType("input")
  .filter((input) => input.props.type === "radio");
TestRenderer.act(() => {
  singleQuestionOptions[0].props.onChange();
  singleQuestionOptions[1].props.onChange();
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
const singleInput = renderer.root.findByType("textarea");
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

TestRenderer.act(() => {
  renderer = TestRenderer.create(React.createElement(ChatPromptCard, {
    entry: {
      id: "prompt-codex-app", version: 1, requestId: "request-codex-app", runId: "run-codex-app",
      kind: "mcp_permission", title: "工具授权",
      message: 'Allow Figma to run tool "figma.use_figma"?',
      fields: [], approvalChoices: ["once", "deny"],
      approvalDetails: { serverName: "codex_apps", toolName: "figma.use_figma" },
      expiresAt: null,
    },
    onRespond: (entry, data) => replies.push({ entry, data }),
  }));
});
assert.ok(visibleTextOf(renderer.toJSON()).includes('Allow Figma to run tool "figma.use_figma"?'),
  "the app name and exact requested tool must remain visible before consent");
assert.ok(visibleTextOf(renderer.toJSON()).includes("chat.approvalDo.appTool:figma|use_figma"),
  "the headline names the app from the validated tool name, never the codex_apps server");
assert.deepEqual(renderer.root.findAllByType("button").map(visibleTextOf), [
  "chat.promptAllowOnce", "chat.promptDenyOperation",
]);
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
  "chat.promptAllowOnce", "chat.promptAllowSession", "chat.promptDenyOperation",
], "existing Grok approvals without scope metadata must localize the known session-edit option; Allow comes first");
TestRenderer.act(() => renderer.root.findAllByType("button")
  .find((button) => visibleTextOf(button) === "chat.promptAllowSession").props.onClick());
assert.deepEqual(structuredClone(replies.at(-1).data), { choice: "runtime:0" },
  "localization must preserve the exact native choice");
renderer.unmount();

const { approvalChoiceLabel, approvalOptionLabel, approvalOptionHint, approvalOptionIsVisible } = loadComponent(path.join(ROOT, "app/manage-ui/src/lib/approvalOptions.ts"));
// The live activity names an answered choice exactly as the card's button did.
assert.equal(approvalChoiceLabel("runtime:0", (key) => key, grokSessionEdits.approvalOptions), "chat.promptAllowSession",
  "a native choice reads as its localized button");
assert.deepEqual(["once", "session", "always", "deny", "cancel"].map((choice) => approvalChoiceLabel(choice, (key) => key)),
  ["chat.promptAllowOnce", "chat.promptAllowSession", "chat.promptAllowAlways", "chat.promptDenyOperation", "common.cancel"],
  "canonical choices never show their internal ids");
assert.equal(approvalChoiceLabel("once", (key) => key, [], true), "chat.promptAllowTurn",
  "a permissions grant reads as its per-turn button");
assert.equal(approvalChoiceLabel("允许一次", (key) => key), "允许一次", "an unknown choice is shown as given");
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
  "chat.promptAllowOnce", "chat.promptAllowAlways", "chat.promptDenyOperation",
], "native approvals must use localized presets, lead with Allow and show only one denial");
assert.deepEqual(renderer.root.findAllByType("button").map((button) => button.props.className.includes("is-primary")),
  [true, false, false], "only the one-time Allow is the primary action");
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
  "chat.promptAllowOnce", "chat.promptAllowAlways", "chat.promptDenyOperation",
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
    assert.equal(approvalOptionHint(unfamiliar, t), option.kind === "allow_always"
      ? `${unfamiliar.label}\n${dictionary.chat.promptAlwaysScopeHint}` : unfamiliar.label,
    "native wording is preserved and an unspecified persistent rule does not imply all future commands");
  }
}
const alternativeRules = ["npm test", "npm test --unit"].map((rule, index) => ({
  choice: `runtime:${index}`, kind: "allow_always", label: `Always allow: ${rule}`,
}));
assert.deepEqual(alternativeRules.map((option) => approvalOptionLabel(option, (key) => key, alternativeRules)),
  ["Always allow: npm test", "Always allow: npm test --unit"],
  "different native rules must expose their meaning without requiring hover");

// ACP also carries questions through permission requests. Labels are answers,
// not interchangeable grants, even when every answer is tagged allow_once.
const taskOptions = [
  { choice: "once", kind: "allow_once", label: "(Recommended) macOS 系统原生后台服务 (Launchd 脚本)" },
  { choice: "runtime:1", kind: "allow_once", label: "Shoggoth 应用内 Cron 任务 (到点唤醒 Agent 执行)" },
  { choice: "runtime:2", kind: "allow_once", label: "使用已有的定时任务" },
  { choice: "runtime:3", kind: "allow_once", label: "先说明两种方案的区别" },
];
for (const count of [2, 4]) {
  const options = taskOptions.slice(0, count);
  for (const locale of ["zh-CN", "en"]) {
    const dictionary = loadComponent(path.join(ROOT, `app/manage-ui/src/i18n/locales/${locale}.ts`)).default;
    const t = (key) => key.split(".").reduce((value, part) => value[part], dictionary);
    assert.deepEqual(options.map(option => approvalChoiceLabel(option.choice, t, options)),
      options.map(option => option.label), "both buttons and answered activity must retain every native answer");
  }
  for (const compact of [false, true]) {
    for (const selected of [...options, { choice: "deny", label: "chat.promptDenyOperation" }]) {
      TestRenderer.act(() => { renderer = TestRenderer.create(React.createElement(ChatPromptCard, {
        entry: { ...approvalEntry, approvalChoices: [...options.map(option => option.choice), "deny", "cancel"],
          approvalOptions: options, approvalDetails: { kind: "command", toolName: "你希望采用哪种方式实现该定时任务？" } },
        compactApproval: compact, onRespond: (_entry, data) => replies.push({ data }),
      })); });
      const radios = renderer.root.findAllByType("input");
      assert.deepEqual(radios.map(input => input.props["aria-label"]), options.map(option => option.label),
        "normal and compact approval cards must show every answer in selectable rows");
      assert.ok(radios.every(input => input.props.type === "radio" && !input.props.checked), "never preselect a native answer");
      const confirm = () => renderer.root.findAllByType("button").find(button => visibleTextOf(button) === "chat.promptConfirmChoice");
      assert.equal(confirm().props.disabled, true);
      const before = replies.length;
      if (selected.choice !== "deny") {
        TestRenderer.act(() => radios.find(input => input.props.value === selected.choice).props.onChange());
        assert.equal(replies.length, before, "reading/selecting a row must not submit");
        assert.equal(confirm().props.disabled, false);
        TestRenderer.act(() => { confirm().props.onClick(); });
      } else {
        TestRenderer.act(() => renderer.root.findAllByType("button")
          .find(button => visibleTextOf(button) === selected.label).props.onClick());
      }
      assert.equal(renderer.toJSON(), null, "confirmation or denial still dismisses immediately");
      assert.deepEqual(structuredClone(replies.at(-1).data), { choice: selected.choice },
        "a readable native answer must submit only its original choice id");
      renderer.unmount();
    }
  }
}

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

const failedApprovalResponses = [];
mountApproval(approvalEntry, (_entry, data) => {
  failedApprovalResponses.push(data);
  return new Promise((_resolve, reject) => { finishResponse = reject; });
});
const firstApprovalClick = renderer.root.findAllByType("button")[0].props.onClick;
TestRenderer.act(() => { firstApprovalClick(); firstApprovalClick(); });
assert.equal(renderer.toJSON(), null, "an approval must disappear before the response completes");
assert.deepEqual(structuredClone(failedApprovalResponses), [{ choice: "once" }],
  "hiding the approval must retain duplicate-click protection and the original choice");
await TestRenderer.act(async () => { finishResponse(new Error("relay unavailable")); });
assert.equal(renderer.root.findAllByType("button").length, 3,
  "a failed response must restore the same approval and all of its choices");
assert.ok(renderer.root.findAllByType("button").every((button) => !button.props.disabled),
  "a failed response must leave the same card available for retry");
TestRenderer.act(() => renderer.root.findAllByType("button")[2].props.onClick());
assert.equal(renderer.toJSON(), null, "retrying with Deny must immediately dismiss the approval too");
assert.deepEqual(structuredClone(failedApprovalResponses), [{ choice: "once" }, { choice: "deny" }]);
await TestRenderer.act(async () => { finishResponse(new Error("relay unavailable")); });
renderer.unmount();

for (const compactApproval of [false, true]) {
  for (const entry of [
    approvalEntry,
    { ...approvalEntry, id: "mcp-approval", kind: "mcp_permission" },
    { ...approvalEntry, id: "product-approval", kind: "product_confirmation" },
    { id: "legacy-approval", kind: "approval", choices: ["once", "session", "deny"] },
    { id: "legacy-mcp-approval", kind: "mcp_tool_approval", choices: ["once", "deny"] },
  ]) {
    let acknowledge;
    const responses = [];
    const onRespond = (request, data) => {
      responses.push({ id: request.id, data });
      return new Promise(resolve => { acknowledge = resolve; });
    };
    TestRenderer.act(() => {
      renderer = TestRenderer.create(React.createElement(ChatPromptCard, { entry, compactApproval, onRespond }));
    });
    const button = renderer.root.findAllByType("button")[0];
    TestRenderer.act(() => { button.props.onClick(); button.props.onClick(); });
    assert.equal(renderer.toJSON(), null, `${entry.kind}/${compactApproval}: hide immediately without submitting text`);
    TestRenderer.act(() => renderer.update(React.createElement(ChatPromptCard,
      { entry: { ...entry }, compactApproval, onRespond })));
    assert.equal(renderer.toJSON(), null, "an unchanged pending projection must not restore the card");
    await TestRenderer.act(async () => { acknowledge(); });
    assert.equal(renderer.toJSON(), null, "a successful response must stay dismissed while awaiting projection refresh");
    assert.deepEqual(structuredClone(responses), [{ id: entry.id, data: { choice: "once" } }]);
    TestRenderer.act(() => renderer.update(React.createElement(ChatPromptCard,
      { entry: { ...entry, id: `${entry.id}-next`, requestId: "next-request" }, compactApproval, onRespond })));
    assert.ok(renderer.root.findAllByType("button").length > 0, "a new request must remain visible and actionable");
    assert.ok(renderer.root.findAllByType("button").every(button => !button.props.disabled));
    renderer.unmount();
  }
}

// Cron owns its error display, but must still reject the card's response so it
// can restore an approval after failure or a concurrent Stop operation.
let settleCronControl;
const cronControls = [];
const CodexCronRunResult = loadComponent(path.join(ROOT, "app/manage-ui/src/pages/cron/CodexCronRunResult.tsx"), {
  "../../api/client": {
    getCodexCronRunResult: async () => ({ executionOrigin: "shoggoth", executionStatus: "waiting_approval",
      available: false, interaction: { type: "approval", payload: approvalEntry } }),
    controlCodexCronRun: (_id, input) => {
      cronControls.push(input);
      return new Promise((resolve, reject) => { settleCronControl = { resolve, reject }; });
    },
  },
  "../../lib/markdown": { toSanitizedMarkdownHtml: value => value },
}).default;
await TestRenderer.act(async () => {
  renderer = TestRenderer.create(React.createElement(CodexCronRunResult, {
    job: { id: "cron-job", name: "Cron Agent" }, run: { runId: "cron-run" },
    onClose: () => {}, onChanged: () => {},
  }));
});
const cronApprovalButtons = () => renderer.root.findAllByType("button")
  .filter(button => button.props.className?.includes("chat-prompt__btn"));
const cronStopButton = () => renderer.root.findAllByType("button")
  .find(button => visibleTextOf(button) === "codexAutomation.stopRun");
TestRenderer.act(() => cronApprovalButtons()[0].props.onClick());
assert.equal(cronApprovalButtons().length, 0, "the real Cron result panel must hide approvals before control responds");
assert.equal(cronControls.length, 1);
assert.equal(cronControls[0].action, "approval");
assert.equal(cronControls[0].requestId, approvalEntry.requestId);
await TestRenderer.act(async () => { settleCronControl.reject(new Error("relay unavailable")); });
assert.equal(cronApprovalButtons().length, 3, "Cron control failure must restore the approval, not treat it as accepted");
assert.equal(visibleTextOf(renderer.root.findByProps({ role: "alert" })), "relay unavailable");
TestRenderer.act(() => cronStopButton().props.onClick());
await TestRenderer.act(async () => { cronApprovalButtons()[0].props.onClick(); });
assert.equal(cronControls.length, 2, "an approval must not be sent while the run's Stop response is pending");
assert.equal(cronControls[1].action, "stop");
assert.equal(cronApprovalButtons().length, 3, "a locally refused response must not permanently dismiss its approval");
await TestRenderer.act(async () => { settleCronControl.reject(new Error("stop unavailable")); });
assert.equal(cronStopButton().props.disabled, false, "a failed Stop must remain retryable without an unhandled rejection");
TestRenderer.act(() => renderer.unmount());

// Plain-language cards, built only from the structured request.
function mountNamed(entry) {
  TestRenderer.act(() => { renderer = TestRenderer.create(React.createElement(ChatPromptCard,
    { entry, agentName: "Antigravity", onRespond: (_entry, data) => replies.push({ data }) })); });
  return visibleTextOf(renderer.toJSON());
}
const antigravityOptions = [
  { choice: "runtime:0", kind: "allow_always", label: "Allow Always (risky) — Allowing always can be risky" },
  { choice: "once", kind: "allow_once", label: "Allow" },
  { choice: "deny", kind: "reject_once", label: "Deny" },
];
const antigravityFetch = { ...approvalEntry, message: "需要用户授权",
  approvalChoices: ["runtime:0", "once", "deny", "cancel"], approvalOptions: antigravityOptions,
  approvalDetails: { kind: "command", toolName: "read_url_content", cwd: "/workspace",
    input: JSON.stringify({ url: "https://example.com/page" }) } };
let text = mountNamed(antigravityFetch);
assert.ok(text.includes("chat.promptAlwaysScopeHint"), "Antigravity's unspecified native rule scope is visible before choosing Always allow");
assert.ok(text.includes("chat.approvalWants:Antigravity|chat.approvalDo.fetch:example.com"),
  `the headline names who asks and what it opens: ${text}`);
assert.equal(renderer.root.findAllByProps({ className: "chat-prompt__cmd" })[0].children.join(""), "https://example.com/page");
assert.deepEqual(renderer.root.findAllByProps({ className: "chat-prompt__risk" }).map(visibleTextOf),
  ["chat.approvalRisk.web", "chat.approvalRisk.alwaysWeb"]);
assert.ok(!text.includes("Run read_url_content"), "the server's title sentence is never shown");
assert.ok(text.includes("chat.approvalTechnical:read_url_content · url=https://example.com/page"));
assert.equal(renderer.root.findAllByType("details").length, 0, "technical facts stay visible, not collapsed");
assert.deepEqual(renderer.root.findAllByType("button").map(visibleTextOf),
  ["chat.promptAllowOnce", "chat.promptAllowAlways", "chat.promptDenyOperation"]);
renderer.unmount();

text = mountNamed({ ...antigravityFetch, approvalDetails: { kind: "command", toolName: "list_resources",
  input: JSON.stringify({ server: "shoggoth" }) } });
assert.ok(text.includes("chat.approvalDo.listResources:shoggoth") && text.includes("chat.approvalReadOnly"));
assert.equal(renderer.root.findAllByProps({ className: "chat-prompt__risk" }).length, 0);
renderer.unmount();

text = mountNamed({ ...approvalEntry, message: "Needs network access to install dependencies",
  approvalDetails: { kind: "command", command: "npm install", cwd: "/workspace/app", networkHost: "registry.npmjs.org" } });
assert.ok(text.includes("chat.approvalDo.runCommandNetwork"));
assert.ok(text.includes("chat.approvalRunsIn:/workspace/app"));
assert.ok(text.includes("chat.approvalSays:Needs network access to install dependencies"),
  "the runtime's own explanation is attributed to it");
assert.ok(text.includes("chat.approvalRisk.network:registry.npmjs.org"));
renderer.unmount();

text = mountNamed({ ...approvalEntry, message: "",
  approvalDetails: { kind: "command", command: "cat /etc/hosts", cwd: "/workspace",
    actions: JSON.stringify([{ type: "read", path: "/etc/hosts" }]) } });
assert.ok(text.includes("chat.approvalDo.readFile:hosts") && text.includes("chat.approvalReadOnly"));
assert.equal(renderer.root.findAllByProps({ className: "chat-prompt__cmd" })[0].children.join(""), "cat /etc/hosts");
renderer.unmount();

text = mountNamed({ ...approvalEntry, message: "",
  approvalDetails: { kind: "file_change", toolName: "edit", grantRoot: "/workspace",
    input: JSON.stringify({ path: "/elsewhere/notes.md" }) } });
assert.ok(text.includes("chat.approvalDo.editFile:notes.md") && text.includes("chat.approvalRisk.outside"));
renderer.unmount();

console.log("chat prompt card: PASS");
