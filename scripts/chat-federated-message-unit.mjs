#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const sourcePath = path.join(ROOT, "app/manage-ui/src/pages/ChatPage.tsx");
const source = fs.readFileSync(sourcePath, "utf8");
const proxySource = fs.readFileSync(path.join(ROOT, "app/core/proxy-gateway.js"), "utf8");
const visibilityPath = path.join(ROOT, "app/manage-ui/src/lib/chatMessageVisibility.ts");
const visibilitySource = fs.readFileSync(visibilityPath, "utf8");
const visibilityJavaScript = ts.transpileModule(visibilitySource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: visibilityPath,
}).outputText;
const visibilityModule = { exports: {} };
vm.runInNewContext(
  `(function(module, exports) { ${visibilityJavaScript}\n})(module, module.exports);`,
  { module: visibilityModule, exports: visibilityModule.exports },
);
const { isInterSessionUserMessage } = visibilityModule.exports;
const {
  federationInputProvenanceForOperationId,
  hasFederationPromptMarker,
} = require("../app/federation-chat-provenance.js");
const {
  deriveSessionTitleFromEvents,
} = require("../app/agent-service/session-display-projection.js");

assert.doesNotMatch(
  source,
  /federationMessageFromToolResult|projectFederationMessages|chat-federated-message/u,
  "发起会话不得再从联邦工具结果合成目标 Agent 正文",
);
assert.match(
  proxySource,
  /onBackendSessionActivity[\s\S]*?activity\.kind !== "federation\.chat\.terminal"[\s\S]*?broadcastTerminal\([\s\S]*?event: "chat"/u,
  "目标 session 活动必须走已认证的 chat 终态广播",
);
assert.equal(isInterSessionUserMessage({
  role: "user",
  provenance: { kind: "inter_session", sourceTool: "federation_agent_run" },
}, "agent input"), true, "带结构化 provenance 的 agent 输入必须隐藏");
assert.equal(isInterSessionUserMessage({ role: "user" }, "human input"), false,
  "真实用户输入必须继续显示");
assert.equal(isInterSessionUserMessage({
  role: "assistant",
  provenance: { kind: "inter_session" },
}, "answer"), false, "目标 Agent 的回答必须继续显示");
assert.equal(isInterSessionUserMessage({
  role: "user",
  local: true,
  provenance: { kind: "inter_session" },
}, "local result"), false, "本地 UI 消息不能被外部 provenance 误隐藏");
assert.equal(isInterSessionUserMessage({ role: "user" },
  "[Inter-session message] sourceSession=agent:source:main isUser=false\nlegacy input"), true,
"旧 transcript 的标准正文标记也必须隐藏");
assert.match(source,
  /group\.msgs\.filter\([\s\S]*?!isInterSessionUserMessage\(message, msgText\(message\)\)/u,
  "聊天投影必须过滤 inter-session 用户消息");
assert.deepEqual(federationInputProvenanceForOperationId("federation-send-call-1"), {
  kind: "inter_session",
  sourceTool: "federation_agent_run",
});
assert.equal(federationInputProvenanceForOperationId("direct-send-1"), null);
assert.equal(hasFederationPromptMarker(
  "[Inter-session message] sourceTool=federation_agent_run isUser=false",
), true, "持久化 marker 不能泄露到 Hermes 会话标题/预览");
assert.equal(deriveSessionTitleFromEvents([{
  kind: "user",
  content: { text: "internal prompt", operationId: "federation-send-call-1" },
}, {
  kind: "user",
  content: { text: "human title", operationId: "direct-send-1" },
}]), "human title", "内部 prompt 不得成为会话标题");

console.log("PASS 联邦输入有结构化来源标记且不进入目标会话可见投影");
