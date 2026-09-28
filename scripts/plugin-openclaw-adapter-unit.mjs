import assert from "node:assert/strict";
import { createAdapter } from "../resources/external-plugin-adapters/openclaw/index.mjs";

const methods = [];
const token = "x".repeat(43);
const adapter = createAdapter({ credential: () => token,
  requestService: async (method, params) => {
    methods.push([method, structuredClone(params)]);
    if (method === "plugin.external.open") return { token: "lease", expiresAt: Date.now() + 60_000 };
    if (method === "plugin.external.search") return { items: [], nextCursor: null, total: 0 };
    if (method === "plugin.external.skill.file.read") return { relativePath: params.relativePath,
      content: "fixture", nextCursor: null };
    if (method === "plugin.external.call") return { serverId: params.serverId, result: { content: [] } };
    throw new Error("unexpected method");
  } });
const hooks = new Map();
const tools = new Map();
adapter.register({ on: (name, callback) => hooks.set(name, callback),
  registerTool: (factory, options) => tools.set(options.name, factory) });
assert.equal(tools.size, 4);
const search = tools.get("shoggoth_capability_search")({ agentId: "agent-a", sessionId: "session-a" });
await assert.rejects(search.execute("call-a", { query: "figma" }),
  /no trusted host execution identity/);
assert.equal(methods.length, 0);
assert.deepEqual(hooks.get("before_tool_call")({ toolName: "shoggoth_capability_search",
  toolCallId: "call-b", runId: "run-a" }, { agentId: "agent-a", sessionId: "session-a" }), undefined);
const result = await search.execute("call-b", { query: "figma" });
assert.equal(result.details.total, 0);
assert.equal(methods[0][0], "plugin.external.open");
assert.equal(methods[0][1].credentialToken, token);
assert.equal(methods[0][1].identity.runId, "run-a");
assert.equal(methods[1][0], "plugin.external.search");
assert.equal(methods[1][1].identity.toolCallId, "call-b");
hooks.get("before_tool_call")({ toolName: "shoggoth_capability_search",
  toolCallId: "call-page", runId: "run-a" }, { agentId: "agent-a", sessionId: "session-a" });
await search.execute("call-page", { query: "figma", cursor: 1, revision: "a".repeat(64) });
assert.equal(methods.at(-1)[1].revision, "a".repeat(64));
await assert.rejects(search.execute("call-b", { query: "figma" }),
  /no trusted host execution identity/);
const blocked = hooks.get("before_tool_call")({ toolName: "shoggoth_plugin_call",
  toolCallId: "call-c" }, { agentId: "agent-a", sessionId: "session-a" });
assert.equal(blocked.block, true);
hooks.get("before_tool_call")({ toolName: "shoggoth_plugin_call", toolCallId: "call-d",
  runId: "run-a" }, { agentId: "agent-a", sessionId: "session-a" });
const callTool = tools.get("shoggoth_plugin_call")({ agentId: "agent-a", sessionId: "session-a" });
await callTool.execute("call-d", { serverId: "plugin.a", toolName: "read", arguments: {} });
assert.equal(methods.at(-1)[0], "plugin.external.call");
assert.equal(Object.hasOwn(methods.at(-1)[1].arguments, "identity"), false);
hooks.get("before_tool_call")({ toolName: "shoggoth_skill_file_read", toolCallId: "call-e",
  runId: "run-a" }, { agentId: "agent-a", sessionId: "session-a" });
const fileTool = tools.get("shoggoth_skill_file_read")({ agentId: "agent-a", sessionId: "session-a" });
const file = await fileTool.execute("call-e", { skillId: "a".repeat(64),
  relativePath: "references/guide.md" });
assert.equal(file.details.content, "fixture");
assert.equal(methods.at(-1)[0], "plugin.external.skill.file.read");
assert.equal(methods.at(-1)[1].relativePath, "references/guide.md");
console.log("plugin-openclaw-adapter-unit: ok");
