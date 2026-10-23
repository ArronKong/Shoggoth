import assert from "node:assert/strict";
import { createAdapter } from "../resources/external-plugin-adapters/openclaw/index.mjs";
import groupMetadata from "../app/agent-service/group-mcp-tools.js";

const methods = [];
const token = "x".repeat(43);
const adapter = createAdapter({ credential: () => token,
  requestService: async (method, params) => {
    methods.push([method, structuredClone(params)]);
    if (method === "plugin.external.open") return { token: "lease", expiresAt: Date.now() + 60_000 };
    if (method === "plugin.external.search") return { items: [], nextCursor: null, total: 0 };
    if (method === "plugin.external.skill.file.read") return { relativePath: params.relativePath,
      content: "fixture", nextCursor: null };
    if (method === "plugin.external.resource.read") return { relativePath: params.relativePath,
      content: "shared fixture", nextCursor: null };
    if (method === "plugin.external.call") return { serverId: params.serverId, result: { content: [] } };
    throw new Error("unexpected method");
  } });
const hooks = new Map();
const tools = new Map();
adapter.register({ on: (name, callback) => hooks.set(name, callback),
  registerTool: (factory, options) => tools.set(options.name, factory) });
assert.equal(tools.size, 9);
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
hooks.get("before_tool_call")({ toolName: "shoggoth_plugin_resource_read", toolCallId: "call-f",
  runId: "run-a" }, { agentId: "agent-a", sessionId: "session-a" });
const resourceTool = tools.get("shoggoth_plugin_resource_read")({ agentId: "agent-a",
  sessionId: "session-a" });
const resource = await resourceTool.execute("call-f", { skillId: "a".repeat(64),
  relativePath: "shared/workflow.md" });
assert.equal(resource.details.content, "shared fixture");
assert.equal(methods.at(-1)[0], "plugin.external.resource.read");
assert.equal(methods.at(-1)[1].relativePath, "shared/workflow.md");
console.log("plugin-openclaw-adapter-unit: ok");

const groupMethods = [], services = new Map(), groupTools = new Map(), groupHooks = new Map();
const groups = createAdapter({ credential: () => token, requestService: async (method, params) => {
  groupMethods.push({ method, params }); return method === "group.adapter.call" ? { ok: true, messages: [] } : { registered: method.endsWith("register") };
} });
groups.register({ on: (name, callback) => groupHooks.set(name, callback), registerTool: (factory, options) => groupTools.set(options.name, factory),
  registerService: service => services.set(service.id, service) });
await services.get("shoggoth-group-channel").start();
assert.equal(groupMethods[0].method, "group.adapter.register");
assert.equal(groupMethods[0].params.protocolVersion, 2);
assert.ok(groupMethods[0].params.tools.includes("group_collaborate"));
const group = groupTools.get("group_messages_read")({ agentId: "agent-a", sessionId: "session-a" });
await assert.rejects(group.execute("unbound", { groupToken: "invalid" }), /no trusted host execution identity/);
groupHooks.get("before_tool_call")({ toolName: "group_messages_read", toolCallId: "g-call", runId: "run-a" }, { agentId: "agent-a", sessionId: "session-a" });
const granted = await group.execute("g-call", { groupToken: "fixture-group-token" });
assert.equal(granted.details.ok, true);
assert.equal(groupMethods.at(-1).method, "group.adapter.call");
assert.equal(groupMethods.at(-1).params.agentId, "agent-a");
assert.equal(groupMethods.at(-1).params.callId, "g-call");
const collaborate = groupTools.get("group_collaborate")({ agentId: "agent-a", sessionId: "session-a" });
const collaborationArgs = { groupToken: "fixture-group-token", clientActionId: "plan-1", action: "plan",
  scopeKey: "research", target: "@researcher", objective: "Read evidence", stopCondition: "Cite one source" };
groupHooks.get("before_tool_call")({ toolName: "group_collaborate", toolCallId: "gc-call", runId: "run-a" },
  { agentId: "agent-a", sessionId: "session-a" });
await collaborate.execute("gc-call", collaborationArgs);
assert.equal(groupMethods.at(-1).method, "group.adapter.call");
assert.equal(groupMethods.at(-1).params.name, "group_collaborate");
assert.deepEqual(groupMethods.at(-1).params.arguments, collaborationArgs);
assert.equal(groupMethods.at(-1).params.agentId, "agent-a");
for (const definition of groupMetadata.GROUP_MCP_TOOL_DEFINITIONS) {
  const registered = groupTools.get(definition.name)({ agentId: "agent-a", sessionId: "session-a" });
  assert.equal(registered.description, definition.description);
  assert.deepEqual(registered.parameters, definition.inputSchema);
}
const taskReader = groupTools.get("group_task")({ agentId: "agent-a", sessionId: "session-a" });
const beforeInvalid = groupMethods.length;
groupHooks.get("before_tool_call")({ toolName: "group_task", toolCallId: "get-missing", runId: "run-a" }, { agentId: "agent-a", sessionId: "session-a" });
const missingTask = await taskReader.execute("get-missing", { groupToken: "fixture-group-token", action: "get" });
assert.equal(missingTask.isError, true); assert.ok(missingTask.details.problems.includes("Missing taskId")); assert.equal(groupMethods.length, beforeInvalid);
const fixedGet = { groupToken: "fixture-group-token", action: "get", taskId: "full-owned-task-id" };
groupHooks.get("before_tool_call")({ toolName: "group_task", toolCallId: "get-fixed", runId: "run-a" }, { agentId: "agent-a", sessionId: "session-a" });
await taskReader.execute("get-fixed", fixedGet); assert.deepEqual(groupMethods.at(-1).params.arguments, fixedGet);
const beforeFinish = groupMethods.length;
groupHooks.get("before_tool_call")({ toolName: "group_collaborate", toolCallId: "finish-conflict", runId: "run-a" }, { agentId: "agent-a", sessionId: "session-a" });
const invalidFinish = await collaborate.execute("finish-conflict", { groupToken: "fixture-group-token", action: "finish", clientActionId: "finish-conflict", summary: "PRIVATE_SUMMARY", resultRefs: [] });
assert.equal(invalidFinish.isError, true); assert.equal(groupMethods.length, beforeFinish); assert.ok(!JSON.stringify(invalidFinish).includes("PRIVATE_SUMMARY"));
let nestedGetterTouched = false;
const badRef = { itemId: "item", revision: 1, messageId: "message", seq: 1 };
Object.defineProperty(badRef, "digest", { enumerable: true, get() { nestedGetterTouched = true; return "a".repeat(64); } });
groupHooks.get("before_tool_call")({ toolName: "group_collaborate", toolCallId: "finish-getter", runId: "run-a" }, { agentId: "agent-a", sessionId: "session-a" });
const getterFinish = await collaborate.execute("finish-getter", { groupToken: "fixture-group-token", action: "finish", clientActionId: "finish-getter", resultRefs: [badRef] });
assert.equal(getterFinish.isError, true); assert.equal(nestedGetterTouched, false); assert.equal(groupMethods.length, beforeFinish);
const fixedFinish = { groupToken: "fixture-group-token", action: "finish", clientActionId: "fixed-finish", resultRefs: [{ itemId: "item", revision: 1, messageId: "message", seq: 1, digest: "a".repeat(64) }] };
groupHooks.get("before_tool_call")({ toolName: "group_collaborate", toolCallId: "finish-fixed", runId: "run-a" }, { agentId: "agent-a", sessionId: "session-a" });
await collaborate.execute("finish-fixed", fixedFinish); assert.deepEqual(groupMethods.at(-1).params.arguments, fixedFinish);
await services.get("shoggoth-group-channel").stop();
assert.equal(groupMethods.at(-1).method, "group.adapter.unregister");
console.log("plugin-openclaw-group-adapter: lifecycle and bound calls ok");

// A startup ordering failure must keep the registration heartbeat alive.
let readyCredential = false, heartbeatTick, heartbeatCleared = false;
const recoveringServices = new Map(), recoveredCalls = [];
const recovering = createAdapter({ credential: () => { if (!readyCredential) throw Error("Service credential not ready"); return token; },
  requestService: async (method, params) => { recoveredCalls.push({ method, params }); return { registered: true }; },
  setInterval: fn => { heartbeatTick = fn; return { unref() {} }; },
  clearInterval: () => { heartbeatCleared = true; } });
recovering.register({ on() {}, registerTool() {}, registerService: service => recoveringServices.set(service.id, service) });
await assert.doesNotReject(recoveringServices.get("shoggoth-group-channel").start());
assert.equal(typeof heartbeatTick, "function");
assert.equal(recoveredCalls.length, 0);
readyCredential = true; await heartbeatTick();
assert.equal(recoveredCalls[0].method, "group.adapter.register");
assert.ok(recoveredCalls[0].params.tools.includes("group_collaborate"));
await recoveringServices.get("shoggoth-group-channel").stop();
assert.equal(heartbeatCleared, true);
const afterStop = recoveredCalls.length; await heartbeatTick(); assert.equal(recoveredCalls.length, afterStop);
const fs = await import("node:fs/promises");
const manifest = JSON.parse(await fs.readFile(new URL("../resources/external-plugin-adapters/openclaw/openclaw.plugin.json", import.meta.url), "utf8"));
for (const name of groupMetadata.GROUP_MCP_TOOL_DEFINITIONS.map(tool => tool.name)) assert.ok(manifest.contracts.tools.includes(name), name + " must be declared to the Host");
console.log("plugin-openclaw recovery and group manifest: ok");
