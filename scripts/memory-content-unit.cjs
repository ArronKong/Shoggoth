"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const content = require("../app/agent-service/memory-content");
const workspace = require("../app/agent-service/memory-workspace");

test("shared memory helpers load without the legacy engine and the legacy API re-exports the same functions", () => {
  execFileSync(process.execPath, ["-e", `
    const assert = require('node:assert/strict');
    require('./app/agent-service/memory-content');
    require('./app/agent-service/memory-workspace');
    assert.ok(!Object.keys(require.cache).some(file => /memory-engine\\.js$/.test(file)));
  `], { cwd: require("node:path").resolve(__dirname, "..") });
  const legacy = require("../app/agent-service/memory-engine");
  for (const [name, value] of Object.entries({ ...content, ...workspace })) {
    if (!["normalizeContent", "REVIEWED_MEMORY_ID"].includes(name)) assert.equal(legacy[name], value, name);
  }
});

test("content policy retains credential, PII, normalization, quote and trust boundaries", () => {
  assert.equal(content.hasSecret("api_key=sk-proj-abcdefghijklmnopqrstuvwx"), true);
  assert.equal(content.hasSecret('token = os.environ["SERVICE_TOKEN"]'), false);
  assert.equal(content.hasSecret('token = os.environ["SERVICE_TOKEN"] or "embedded-secret-value"'), true);
  assert.equal(content.hasPii("person@example.com"), true);
  assert.equal(content.contentHash("  Ｈello\nWORLD  "), content.contentHash("hello world"));
  assert.equal(content.quoteSupportsContent("用户喜欢简短回答", "用户偏好简短回答"), true);
  assert.equal(content.quoteSupportsContent("prefers concise answers", "User preference: concise answers"), true);
  assert.equal(content.quoteSupportsContent("Only telescopes", "User lives in Paris"), false);
  for (const [refs, expected] of [[['user-edit:1'], 'owner'], [['consolidated:auto'], 'system'],
    [['run-1'], 'agent'], [['user-edit:1', 'untrusted:source'], 'untrusted']]) {
    assert.equal(content.memoryTrust({ id: "record", sourceRefs: refs }), expected);
  }
  const item = { sourceRefs: workspace.workspaceMemoryRefs("/isolated-workspace", "workspace") };
  assert.equal(workspace.matchesWorkspace(item, "/isolated-workspace"), true);
  assert.equal(workspace.matchesWorkspace(item, "/another-workspace"), false);
});
