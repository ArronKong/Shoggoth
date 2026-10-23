#!/usr/bin/env node
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const c = require("../app/agent-service/chat-ui-contract");
const schema = { type: "object", properties: { selected: { type: "string", enum: ["A", "B"] },
  weight: { type: "number", minimum: 0, maximum: 1 }, tags: { type: "array", items: { type: "string", maxLength: 30 }, maxItems: 8 } },
  required: ["selected", "weight"], additionalProperties: false };
const publication = () => ({ sourceFile: "drafts/comparison.html", title: "比较方案", summary: "调整参数后继续分析",
  stateSchemaVersion: 1, stateSchema: structuredClone(schema), initialState: { selected: "A", weight: .6 },
  actions: [{ actionId: "continue", kind: "continue_agent", label: "继续分析", instruction: "根据当前选择继续分析", stateFields: ["selected", "weight"] }] });
const rejects = (fn, code) => assert.throws(fn, { code });
test("publish and update freeze complete declarations without owner fields", () => {
  const p = publication(); assert.deepEqual(c.normalizePublication("render_ui", p), p);
  assert.deepEqual(c.normalizePublication("update_ui", { ...p, artifactId: "artifact-a", expectedRevision: 1, updateNote: "增加筛选" }).expectedRevision, 1);
  rejects(() => c.normalizePublication("render_ui", { ...p, profileId: "other" }), "UI_REQUEST_INVALID");
  rejects(() => c.normalizePublication("update_ui", { artifactId: "a", expectedRevision: 1 }), "UI_REQUEST_INVALID");
});
test("unsupported schema and action declarations fail before publication", () => {
  for (const extension of [{ $ref: "file:///secret" }, { pattern: "(a+)+" }, { additionalProperties: true }]) {
    rejects(() => c.normalizeSchema({ ...schema, ...extension }), "UI_SCHEMA_INVALID");
  }
  rejects(() => c.normalizeSchema({ ...schema, properties: { unbounded: { type: "array", items: { type: "number" } } } }), "UI_SCHEMA_INVALID");
  const p = publication(); p.actions[0].stateFields.push("unknown"); rejects(() => c.normalizePublication("render_ui", p), "UI_ACTION_INVALID");
  p.actions[0].stateFields.pop(); p.actions.push(p.actions[0]); rejects(() => c.normalizePublication("render_ui", p), "UI_ACTION_INVALID");
});
test("state validation checks numeric bounds, fields, prototypes, bytes and secrets", () => {
  assert.deepEqual(c.normalizePatch({ selected: "B" }, schema), { selected: "B" });
  for (const value of [{ weight: 2 }, { selected: "C" }, { weight: NaN }, { selected: undefined }, { unknown: 1 }, JSON.parse('{"__proto__":{}}')]) rejects(() => c.normalizePatch(value, schema), "UI_STATE_INVALID");
  rejects(() => c.normalizeState({ selected: "B" }, schema), "UI_STATE_INVALID");
  rejects(() => c.normalizePatch({ tags: ["x".repeat(9000)] }, schema), "UI_CONTENT_TOO_LARGE");
  rejects(() => c.sensitive({ value: "sk-proj-abcdefghijklmnopqrstuvwxyz1234" }), "UI_SENSITIVE_CONTENT");
  rejects(() => c.sensitive({ password: "private-registered-value" }, text => text.includes("private-registered-value")), "UI_SENSITIVE_CONTENT");
  const getter = { get weight() { throw Error("getter executed"); } }; rejects(() => c.normalizePatch(getter, schema), "UI_STATE_INVALID");
});
test("references are small, immutable revision identities with no HTML or state", () => {
  const p = { type: "ui_artifact", schemaVersion: 1, artifactId: "a", revision: 1, sourceEventId: "source-v1", segmentId: "segment-v1", title: "比较方案", summary: "调整参数" };
  assert.deepEqual(c.normalizePart(p), p); rejects(() => c.normalizePart({ ...p, html: "<script/>" }), "UI_REQUEST_INVALID");
  rejects(() => c.normalizePart({ ...p, revision: 0 }), "UI_REQUEST_INVALID");
});
test("host requests separate the lease state bridge from action authority", () => {
  const base = { profileId: "p", sessionKey: "s", leaseId: "l" };
  assert.deepEqual(c.normalizeUiRequest("chat.ui.state.save", { ...base, patch: { selected: "B" }, baseStateRevision: 0 }).patch, { selected: "B" });
  rejects(() => c.normalizeUiRequest("chat.ui.state.save", { ...base, actionId: "continue", patch: {}, baseStateRevision: 0 }), "UI_REQUEST_INVALID");
  assert.deepEqual(c.normalizeUiRequest("chat.ui.operation.get", { profileId: "p", sessionKey: "s", actionRequestId: "request-before-crash" }).actionRequestId, "request-before-crash");
  rejects(() => c.normalizeUiRequest("chat.ui.operation.get", { profileId: "p", sessionKey: "s", actionRequestId: "r", operationId: "o" }), "UI_REQUEST_INVALID");
});
test("only a current direct chat with an authenticated user source qualifies", () => {
  const run = { id: "run", profileId: "p", activeAttemptId: "attempt", source: "chat", sourceId: "s", status: "running", workspace: "/fixture" };
  const session = { id: "transcript", sessionKey: "s", profileId: "p", workspace: "/fixture", status: "ready" };
  const scope = { runId: "run", assertCurrent() {} };
  const origins = Object.fromEntries(["cron", "inspiration", "proactive", "federation", "group"].map(key => [key, null]));
  const input = { profileId: "p", run, session, scope, origins, hasUser: true };
  assert.equal(c.assertDirectChatEligibility(input), session);
  for (const source of ["cron", "inspiration", "proactive", "automation", "kanban"]) rejects(() => c.assertDirectChatEligibility({ ...input, run: { ...run, source } }), "UI_DIRECT_CHAT_REQUIRED");
  for (const kind of Object.keys(origins)) rejects(() => c.assertDirectChatEligibility({ ...input, origins: { ...origins, [kind]: {} } }), "UI_DIRECT_CHAT_REQUIRED");
  rejects(() => c.assertDirectChatEligibility({ ...input, run: { ...run, idempotencyKey: "shoggoth:chat-send:federation-send-a" } }), "UI_DIRECT_CHAT_REQUIRED");
  rejects(() => c.assertDirectChatEligibility({ ...input, scope: { ...scope, runId: "stale" } }), "UI_SCOPE_MISMATCH");
  rejects(() => c.assertDirectChatEligibility({ ...input, scope: { ...scope, assertCurrent() { throw c.uiError("UI_SCOPE_MISMATCH"); } } }), "UI_SCOPE_MISMATCH");
  rejects(() => c.assertDirectChatEligibility({ ...input, hasUser: false }), "UI_DIRECT_CHAT_REQUIRED");
});
test("borrowed dependencies cannot be cleared by claiming a new UI origin", () => {
  const sourceHash = "a".repeat(64);
  const ref = { version: 1, requesterProfileId: "p", ownerProfileId: "source", canonicalRelativePath: "MEMORY.md", documentKind: "long_term",
    startLine: 1, endLine: 3, sourceHash, sourceRevision: `sha256:${sourceHash}`, policyRevision: 1 };
  const normalized = c.normalizeProvenance({ borrowedMemoryRefs: [ref], origin: "user" });
  assert.equal(normalized.origin, "assistant_generated_ui"); assert.equal(normalized.borrowedMemoryDerived, true);
  assert.deepEqual(normalized.borrowedMemoryRefs, [ref]);
  rejects(() => c.normalizeProvenance({ borrowedMemoryRefs: [ref], borrowedMemoryDerived: false }), "UI_SCOPE_MISMATCH");
});

test("fresh Core and Service keep UI disabled while explicit configuration survives projection", () => {
  const { normalizeConfig, projectNativeChatUiConfig } = require("../app/core/config-store");
  const { ChatUiConfig } = require("../app/agent-service/chat-ui-config");
  assert.deepEqual(projectNativeChatUiConfig(normalizeConfig({})), { revision: 1, config: { nativeChatUiV1: false } });
  const fs = require("node:fs"), path = require("node:path");
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/sg-ui-config-")); fs.chmodSync(root, 0o700);
  try {
    const paths = require("../app/agent-service/paths").resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state") });
    fs.mkdirSync(paths.stateDir, { mode: 0o700 });
    const stored = new ChatUiConfig({ paths }); stored.open();
    assert.deepEqual(stored.read(), { revision: 0, config: { nativeChatUiV1: false } });
    stored.apply(projectNativeChatUiConfig(normalizeConfig({})));
    assert.equal(stored.read().config.nativeChatUiV1, false);
    stored.apply({ revision: 2, config: { nativeChatUiV1: true } });
    const reopened = new ChatUiConfig({ paths }); reopened.open(); assert.equal(reopened.read().config.nativeChatUiV1, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  const enabled = { revision: 7, config: { nativeChatUiV1: true } };
  assert.deepEqual(projectNativeChatUiConfig(normalizeConfig({ nativeChatUi: enabled })), enabled);
  assert.equal(normalizeConfig({ nativeChatUi: { revision: 7, config: { nativeChatUiV1: "true" } } }).nativeChatUi, null);
});
