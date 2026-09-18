#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  mcpElicitationUsesApprovalWait,
  normalizeInteractiveRequestV1,
  parseMcpToolPermission,
  validateInteractiveResponseV1,
} = require("../app/core/shoggoth-interaction-contract");

const choicePayload = {
  requestId: "request-choice",
  method: "mcpServer/elicitation/request",
  kind: "mcp_elicitation",
  serverName: "shoggoth",
  mode: "form",
  message: "Choose deployment settings",
  requestedSchema: {
    type: "object",
    properties: {
      region: {
        type: "string",
        title: "Region",
        description: "Choose one region\nNorth: First region\nEast: Second region",
        enum: ["cn-north", "cn-east"],
        enumNames: ["North", "East"],
      },
      note: { type: "string", title: "Note", description: "Optional note" },
    },
    required: ["region"],
  },
};

const request = normalizeInteractiveRequestV1({
  runId: "run-choice",
  eventType: "prompt",
  payload: choicePayload,
  expiresAt: 10_000,
});
assert.deepEqual(request, {
  version: 1,
  requestId: "request-choice",
  runId: "run-choice",
  kind: "user_input",
  title: "需要补充信息",
  message: "Choose deployment settings",
  fields: [
    {
      id: "region",
      type: "choice",
      label: "Region",
      description: "Choose one region",
      required: true,
      secret: false,
      options: [
        { value: "cn-north", label: "North", description: "First region" },
        { value: "cn-east", label: "East", description: "Second region" },
      ],
    },
    {
      id: "note",
      type: "text",
      label: "Note",
      description: "Optional note",
      required: false,
      secret: false,
      options: [],
    },
  ],
  approvalChoices: [],
  expiresAt: 10_000,
});
assert.deepEqual(validateInteractiveResponseV1(request, {
  action: "submit",
  answers: { region: "cn-east" },
}), { action: "submit", answers: { region: "cn-east" } });
assert.throws(() => validateInteractiveResponseV1(request, {
  action: "submit",
  answers: { region: "East" },
}), (error) => error.code === "INTERACTION_RESPONSE_INVALID");

const oneTimeRuntimeApproval = normalizeInteractiveRequestV1({
  runId: "run-approval-once",
  eventType: "approval",
  payload: {
    requestId: "approval-once",
    reason: "Run one command",
    sessionApprovalAvailable: false,
  },
});
assert.deepEqual(oneTimeRuntimeApproval.approvalChoices, ["once", "deny", "cancel"],
  "没有可复用规则的运行时授权不能显示误导性的本会话允许");

const reusableRuntimeApproval = normalizeInteractiveRequestV1({
  runId: "run-approval-session",
  eventType: "approval",
  payload: {
    requestId: "approval-session",
    reason: "Run ego-browser commands",
    sessionApprovalAvailable: true,
  },
});
assert.deepEqual(reusableRuntimeApproval.approvalChoices, ["once", "session", "deny", "cancel"]);

const nativeOptions = [
  { choice: "once", label: "Allow once", kind: "allow_once" },
  { choice: "runtime:1", label: "Always allow this tool", kind: "allow_always", scope: "tool" },
  { choice: "runtime:2", label: "Always allow this server", kind: "allow_always", scope: "server" },
  { choice: "deny", label: "Reject", kind: "reject_once" },
];
const nativeApproval = normalizeInteractiveRequestV1({
  runId: "run-grok-options", eventType: "approval",
  payload: { requestId: "grok-options", reason: "Create a card", sessionApprovalAvailable: true,
    approvalOptions: nativeOptions },
});
assert.deepEqual(nativeApproval.approvalOptions, nativeOptions);
assert.deepEqual(nativeApproval.approvalChoices, ["once", "runtime:1", "runtime:2", "deny", "cancel"]);
assert.deepEqual(validateInteractiveResponseV1(nativeApproval, { choice: "runtime:2" }), { choice: "runtime:2" });
for (const choice of ["session", "runtime:3", "runtime:01", "runtime:32"]) {
  assert.throws(() => validateInteractiveResponseV1(nativeApproval, { choice }),
    (error) => error.code === "INTERACTION_RESPONSE_INVALID");
}
for (const approvalOptions of [null, {}, [], [...nativeOptions, nativeOptions[0]],
  [{ choice: "session", label: "Misleading", kind: "allow_always" }],
  [{ choice: "runtime:1", label: "too long".repeat(600), kind: "allow_always" }],
  [{ choice: "runtime:1", label: "Wrong scope", kind: "reject_once", scope: "server" }],
]) {
  const hidden = normalizeInteractiveRequestV1({ runId: "run-invalid-native", eventType: "approval",
    payload: { requestId: "invalid-native", approvalOptions } });
  assert.deepEqual(hidden.approvalChoices, ["deny", "cancel"]);
  assert.equal(hidden.approvalOptions, undefined);
}
const hiddenNative = normalizeInteractiveRequestV1({ runId: "run-redacted-native", eventType: "approval",
  payload: { requestId: "redacted-native", approvalOptions: nativeOptions, redacted: true } });
assert.equal(hiddenNative.approvalOptions, undefined);

const detailedApproval = normalizeInteractiveRequestV1({
  runId: "run-tool-details", eventType: "approval",
  payload: {
    requestId: "tool-details", kind: "command", reason: "shoggoth__kanban_card_create",
    toolName: "shoggoth__kanban_card_create", command: "shoggoth__kanban_card_create",
    cwd: "/tmp/project", toolInput: { boardId: "board-1", title: "Remember this idea" },
    sessionApprovalAvailable: true,
  },
});
assert.deepEqual(detailedApproval.approvalDetails, {
  kind: "command", toolName: "shoggoth__kanban_card_create", command: "shoggoth__kanban_card_create",
  cwd: "/tmp/project", input: '{"boardId":"board-1","title":"Remember this idea"}',
});
for (const payload of [
  { command: "x".repeat(17 * 1024) },
  { command: "bad\u0000command" },
  { toolInput: { title: "x".repeat(17 * 1024) } },
  { redacted: true, command: "hidden command", toolInput: { title: "hidden title" } },
]) {
  const hidden = normalizeInteractiveRequestV1({
    runId: "run-hidden", eventType: "approval",
    payload: { requestId: "hidden-request", reason: "Details", sessionApprovalAvailable: true, ...payload },
  });
  assert.deepEqual(hidden.approvalChoices, ["deny", "cancel"]);
  assert.equal(hidden.approvalDetails, undefined, "unrenderable details must never leak through the new projection");
}

const redactedRuntimeApproval = normalizeInteractiveRequestV1({
  runId: "run-approval-redacted",
  eventType: "approval",
  payload: {
    requestId: "approval-redacted",
    reason: "需要用户授权",
    sessionApprovalAvailable: true,
    redacted: true,
  },
});
assert.deepEqual(redactedRuntimeApproval, {
  version: 1,
  requestId: "approval-redacted",
  runId: "run-approval-redacted",
  kind: "runtime_approval",
  title: "审批详情不可用",
  message: "审批详情无法安全完整显示，只能拒绝或取消。请在 Agent 对话中重新发起任务。",
  fields: [],
  approvalChoices: ["deny", "cancel"],
  expiresAt: null,
});
assert.deepEqual(
  validateInteractiveResponseV1(redactedRuntimeApproval, { choice: "deny" }),
  { choice: "deny" },
);
assert.throws(
  () => validateInteractiveResponseV1(redactedRuntimeApproval, { choice: "once" }),
  (error) => error.code === "INTERACTION_RESPONSE_INVALID",
);

const oversizedRuntimeApproval = normalizeInteractiveRequestV1({
  runId: "run-approval-oversized",
  eventType: "approval",
  payload: {
    requestId: "approval-oversized",
    reason: "x".repeat(48_646),
    sessionApprovalAvailable: true,
  },
});
assert.deepEqual(oversizedRuntimeApproval.approvalChoices, ["deny", "cancel"],
  "authoritative oversized snapshots must not recreate allow choices");

const permissionPayload = {
  requestId: "permission-1",
  method: "mcpServer/elicitation/request",
  kind: "mcp_elicitation",
  serverName: "shoggoth",
  mode: "form",
  message: "Allow the shoggoth MCP server to run tool \"system_open_url\"?",
  requestedSchema: { type: "object", properties: {}, required: [] },
};
assert.deepEqual(parseMcpToolPermission(permissionPayload), {
  serverName: "shoggoth", toolName: "system_open_url",
});
const permission = normalizeInteractiveRequestV1({
  runId: "run-permission", eventType: "prompt", payload: permissionPayload,
});
assert.equal(permission.kind, "mcp_permission");
assert.equal(mcpElicitationUsesApprovalWait(permissionPayload), true);
assert.deepEqual(permission.fields, []);
assert.deepEqual(validateInteractiveResponseV1(permission, { choice: "once" }), { choice: "once" });

const confirmation = normalizeInteractiveRequestV1({
  runId: "run-confirmation",
  eventType: "prompt",
  payload: {
    ...choicePayload,
    requestId: "confirmation-1",
    message: "Confirm",
    requestedSchema: {
      type: "object",
      properties: {
        confirm_product_action: {
          type: "string",
          title: "确认修改",
          description: "是否继续？\n确认执行: 执行操作\n取消: 不修改",
          enum: ["确认执行", "取消"],
          enumNames: ["确认执行", "取消"],
        },
      },
      required: ["confirm_product_action"],
    },
  },
});
assert.equal(confirmation.kind, "product_confirmation");
assert.equal(mcpElicitationUsesApprovalWait({
  ...choicePayload,
  requestId: "confirmation-1",
  message: "Confirm",
  requestedSchema: {
    type: "object",
    properties: {
      confirm_product_action: {
        type: "string",
        title: "确认修改",
        enum: ["确认执行", "取消"],
      },
    },
    required: ["confirm_product_action"],
  },
}), true);
assert.equal(mcpElicitationUsesApprovalWait(choicePayload), false);

for (const badSchema of [
  { type: "object", properties: {} },
  { type: "object", properties: { choice: { type: "number" } } },
  { type: "object", properties: { choice: { type: "string", enum: ["a", "a"] } } },
  { type: "object", properties: { choice: { type: "string", enum: ["a", "b"], enumNames: ["A"] } } },
]) {
  assert.throws(() => normalizeInteractiveRequestV1({
    runId: "run-bad",
    eventType: "prompt",
    payload: { ...choicePayload, requestId: "request-bad", requestedSchema: badSchema },
  }), (error) => error.code === "INTERACTION_REQUEST_INVALID");
}

console.log("shoggoth interaction contract regression: PASS");
