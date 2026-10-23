#!/usr/bin/env node
// Actual pinned Pi SDK/tool loop, production extension, private Hook bridge and
// real sandboxed Worker. The provider stream is controlled: no model/network bill.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = process.env.SHOGGOTH_HOOKS_PI_PACKAGE;
assert.ok(packagePath && path.isAbsolute(packagePath), "Set SHOGGOTH_HOOKS_PI_PACKAGE to the installed Pi package; unavailable is not a passing fixture");
const manifest = JSON.parse(fs.readFileSync(path.join(packagePath, "package.json"), "utf8"));
assert.equal(manifest.name, "@earendil-works/pi-coding-agent");
assert.equal(manifest.version, "0.84.4", "Native Hook evidence is pinned to the tested Pi version");
const { createAgentSession, ModelRuntime, DefaultResourceLoader, SessionManager, SettingsManager } =
  await import(pathToFileURL(path.join(packagePath, "dist/index.js")));
const { createAssistantMessageEventStream } = await import(pathToFileURL(path.join(packagePath,
  "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js")));
const { default: extension } = await import(pathToFileURL(path.join(ROOT, "resources/pi/shoggoth-pi-extension.mjs")));
const { HookStore } = require("../app/agent-service/hook-store");
const { HookRunner } = require("../app/agent-service/hook-runner");
const { HookProcessHost } = require("../app/agent-service/hook-process-host");
const { HookService } = require("../app/agent-service/hook-service");
const { HookToolExecution } = require("../app/agent-service/hook-tool-execution");
const { HookNativeToolService } = require("../app/agent-service/hook-native-tool-service");
const { HookWorkspaceWriters } = require("../app/agent-service/hook-workspace-writers");
const { RuntimeHookBridge } = require("../app/agent-service/runtime-hook-bridge");
const { piNativeHookCapabilities, PI_HOOK_TITLE } = require("../app/agent-service/pi-hook-contract");
const { DEFAULT_TOOL_REGISTRY } = require("../app/agent-service/mcp-product-tool-controller");
const { PermissionEngine } = require("../app/agent-service/permission-engine");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { dataAccess } = require("../app/agent-service/hook-contract");
const uuid = () => crypto.randomUUID();
const builtin = (name, config) => ({ type: "builtin", name, config });
const rule = (toolName, kind, event, handler) => ({ schemaVersion: 1, name: handler.name, kind, event,
  scope: { workspace: "current", sources: ["chat", "cron", "kanban", "inspiration"] },
  matcher: { toolScopes: ["runtime_builtin"], toolNames: [toolName] }, handler });
const ENV_KEYS = ["SHOGGOTH_PI_MCP_COMMAND", "SHOGGOTH_PI_MCP_ARGS", "SHOGGOTH_PI_PERMISSION_POLICY", "SHOGGOTH_PI_NATIVE_HOOK_TOOLS"];

async function fixture(t, policy = { approvalPolicy: "never", sandbox: "workspace-write" }) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sg-hooks-pi-sdk-"));
  const workspace = path.join(root, "workspace"), agentDir = path.join(root, "pi-agent");
  fs.mkdirSync(workspace, { mode: 0o700 }); fs.mkdirSync(agentDir, { mode: 0o700 });
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"), profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  const store = new HookStore({ paths }).open(), processHost = new HookProcessHost({ store, cacheDir: paths.hookEphemeralDir });
  assert.equal(await processHost.verify(), true);
  const runner = new HookRunner({ store, processHost }), writers = new HookWorkspaceWriters();
  const profile = { id: "pi-hooks-fixture", enabled: true, runtime: "pi" }, runs = new Map();
  const host = { runtime: "pi", host: { state: "ready", cliVersion: [0, 84, 4],
    extensionPath: path.join(ROOT, "resources/pi/shoggoth-pi-extension.mjs") } };
  const approvals = [], control = { approved: true, onApproval: null, onAfter: null };
  const service = new HookService({ store, runner, processHost, productStore: { getAgentProfile: id => id === profile.id ? profile : null },
    getRun: id => runs.get(id), permissionEngine: new PermissionEngine({ toolRegistry: DEFAULT_TOOL_REGISTRY }),
    toolRegistry: DEFAULT_TOOL_REGISTRY, cacheDir: paths.hookEphemeralDir,
    nativeCapabilities: () => piNativeHookCapabilities(host.host), resolveToolIdentity: async () => [{ name: "read" }, { name: "write" }],
    requestApproval: async input => { approvals.push(structuredClone(input.arguments)); await control.onApproval?.(); return { approved: control.approved }; } });
  const execution = new HookToolExecution({ service, getExecutionPolicy: () => policy,
    assertWorkspaceWriter: (id, cwd) => writers.assert(id, cwd) });
  const nativeTools = new HookNativeToolService({ service, toolExecution: execution,
    getRun: id => runs.get(id), getProfile: id => id === profile.id ? profile : null, getPolicy: () => policy });
  service.nativeTools = nativeTools;
  service.runtimeToolEvent = async (request, scope) => { if (request.phase === "after") await control.onAfter?.(); return nativeTools.dispatch(request, scope); };
  const bridge = new RuntimeHookBridge({ service, resolveAssignment: id => runs.has(id) ? { host, bindingId: "pi-fixture-binding" } : null });
  const run = () => { const value = { id: uuid(), profileId: profile.id, workspace, source: "chat", status: "running" }; runs.set(value.id, value); return value; };
  const scope = value => ({ runId: value.id, host, bindingId: "pi-fixture-binding", signal: new AbortController().signal,
    assertCurrent() { if (!profile.enabled || runs.get(value.id)?.status !== "running") throw Object.assign(new Error("revoked"), { code: "HOOK_REVOKED" }); } });
  const admin = run();
  const call = (name, args, confirmed = false) => service.handleTool(name, args, { profileId: profile.id, callId: uuid(), ...(confirmed ? { confirmation: true } : {}) }, scope(admin));
  const enable = async (definition, payload = { arguments: { path: "output.txt", content: "original" } }, files = []) => {
    const saved = await call("hook_register", { definition });
    const receipt = await call("hook_test", { hookId: saved.hookId, version: 1, payload, files });
    assert.equal(receipt.passed, true, JSON.stringify(receipt));
    if (Object.values(dataAccess(store.get(profile.id, saved.hookId).definition)).some(Boolean)) await call("hook_grant", { hookId: saved.hookId, version: 1 }, true);
    return call("hook_enable", { hookId: saved.hookId, version: 1, expectedRevision: saved.revision });
  };
  const relay = path.join(root, "catalog-relay.cjs");
  fs.writeFileSync(relay, `"use strict"; const readline = require("node:readline");
    readline.createInterface({input: process.stdin}).on("line", line => { const m=JSON.parse(line);
      if(m.id===undefined)return; const result=m.method==="initialize"?{protocolVersion:"2025-06-18",capabilities:{tools:{}},serverInfo:{name:"isolated-empty-catalog",version:"1"}}:m.method==="tools/list"?{tools:[]}:null;
      process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result})+"\\n"); });`, { mode: 0o600 });
  const previous = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  process.env.SHOGGOTH_PI_MCP_COMMAND = process.execPath;
  process.env.SHOGGOTH_PI_MCP_ARGS = JSON.stringify([relay]);
  process.env.SHOGGOTH_PI_PERMISSION_POLICY = JSON.stringify(policy);
  let session = null, modelRuntime = null;
  const execute = async (toolName, args, onNextModel = () => {}) => {
    assert.equal(session, null, "each fixture owns one genuine Pi loop");
    const current = run(); writers.acquire(current.id, workspace, policy.sandbox);
    service.freezeRun(current, profile);
    process.env.SHOGGOTH_PI_NATIVE_HOOK_TOOLS = JSON.stringify(service.nativeRunScope(current.id).toolNames);
    const settingsManager = SettingsManager.create(workspace, agentDir); settingsManager.setProjectTrusted(true);
    modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"),
      modelsStorePath: path.join(agentDir, "models-cache.json"), allowModelNetwork: false, refreshOnCreate: false });
    const provider = "shoggoth-hook-fixture-" + uuid();
    modelRuntime.registerProvider(provider, { api: "openai-completions", baseUrl: "http://127.0.0.1:1/never-called", apiKey: "fixture-only-no-credential",
      models: [{ id: "controlled", name: "Controlled fixture stream", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
      streamSimple() { throw new Error("Fixture must never invoke a provider"); } });
    const loader = new DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Controlled isolated Hook boundary fixture.",
      extensionFactories: [{ name: "shoggoth-production-bridge", factory: extension }] });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: workspace, agentDir, model: modelRuntime.getModel(provider, "controlled"), modelRuntime,
      settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(workspace), tools: ["read", "write"], thinkingLevel: "off" }));
    const errors = [], requests = [], toolEvents = [];
    await session.bindExtensions({ mode: "rpc", onError: error => errors.push(error), uiContext: {
      input: async (title, encoded) => { assert.equal(title, PI_HOOK_TITLE); const request = JSON.parse(encoded); requests.push(request);
        try { return JSON.stringify(await bridge.dispatch(request, scope(current))); }
        catch (error) { return JSON.stringify({ errorCode: error.code || "HOOK_NATIVE_CALL_FAILED" }); } },
      confirm: async () => { throw new Error("Hook/native approval must be merged into the Service card"); },
      notify() {}, setStatus() {}, setWidget() {}, setWorkingMessage() {}, setTitle() {},
    } });
    session.subscribe(event => { if (event.type === "tool_execution_end") toolEvents.push(event); });
    let count = 0;
    session.agent.streamFunction = (_model, context) => {
      const stream = createAssistantMessageEventStream();
      const first = count++ === 0;
      if (!first) onNextModel(structuredClone(context), current);
      const message = { role: "assistant", api: "openai-completions", provider, model: "controlled",
        content: first ? [{ type: "toolCall", id: "pi-native-fixture-call", name: toolName, arguments: structuredClone(args) }] : [{ type: "text", text: "done" }],
        stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); stream.end(message); return stream;
    };
    await session.prompt("Execute the controlled isolated tool call.", { expandPromptTemplates: false });
    assert.equal(count, 2); assert.deepEqual(errors, []); assert.equal(toolEvents.length, 1);
    return { current, requests, result: toolEvents[0].result, event: toolEvents[0] };
  };
  t.after(async () => {
    if (session?.extensionRunner) await session.extensionRunner.emit({ type: "session_shutdown" });
    session?.dispose(); nativeTools.clear(); writers.close(); await runner.close(); store.close();
    for (const key of ENV_KEYS) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, workspace, store, service, host, profile, nativeTools, writers, approvals, control, enable, execute };
}

test("actual Pi loop: native write guard blocks before any filesystem side effect", async t => {
  const f = await fixture(t);
  await f.enable(rule("write", "guard", "tool.before", builtin("guard.block", { reason: "protected file" })));
  const result = await f.execute("write", { path: "protected.txt", content: "must not appear" }, context => {
    assert.match(JSON.stringify(context.messages.at(-1)), /HOOK_BLOCKED/);
    assert.equal(fs.existsSync(path.join(f.workspace, "protected.txt")), false);
  });
  assert.equal(result.event.isError, true); assert.deepEqual(result.requests.map(request => request.phase), ["before"]);
});

for (const approvalPolicy of ["on-request", "never"]) test(`actual Pi loop: final arguments and one merged approval (${approvalPolicy})`, async t => {
  const f = await fixture(t, { approvalPolicy, sandbox: "workspace-write" });
  await f.enable(rule("write", "transform", "tool.before", builtin("arguments.patch", { patch: { content: "final-content" } })));
  await f.enable(rule("write", "guard", "tool.before", builtin("guard.require_approval", { reason: "confirm final write" })));
  const result = await f.execute("write", { path: "final.txt", content: "original" }, () => {
    assert.equal(fs.readFileSync(path.join(f.workspace, "final.txt"), "utf8"), "final-content");
  });
  assert.deepEqual(f.approvals, [{ path: "final.txt", content: "final-content" }]);
  assert.deepEqual(result.requests.map(request => request.phase), ["before", "approve"]); assert.equal(result.event.isError, false);
});

test("actual Pi loop: transformed input is revalidated against the real write schema", async t => {
  const f = await fixture(t);
  await f.enable(rule("write", "transform", "tool.before", builtin("arguments.patch", { patch: { path: 42 } })));
  const result = await f.execute("write", { path: "invalid.txt", content: "original" });
  assert.equal(result.event.isError, true); assert.match(JSON.stringify(result.result), /HOOK_ARGUMENTS_INVALID/);
  assert.equal(fs.existsSync(path.join(f.workspace, "invalid.txt")), false); assert.equal(f.approvals.length, 0);
});

test("actual Pi loop: result redaction and real Worker action settle before the next model input", async t => {
  const f = await fixture(t), text = "Contact person@example.com, phone 13800138000";
  fs.writeFileSync(path.join(f.workspace, "contacts.txt"), text, { mode: 0o600 });
  await f.enable(rule("read", "transform", "tool.result.transform", builtin("result.redact", { patterns: ["email", "phone"] })),
    { result: { content: [{ type: "text", text }], details: null, isError: false } });
  await f.enable(rule("read", "action", "tool.after", builtin("workspace.copy", { from: "contacts.txt", to: "backup.txt" })),
    { result: { content: [{ type: "text", text }], isError: false } }, [{ relativePath: "contacts.txt", content: text }]);
  const result = await f.execute("read", { path: "contacts.txt" }, context => {
    assert.equal(fs.readFileSync(path.join(f.workspace, "backup.txt"), "utf8"), text);
    const nextInput = JSON.stringify(context.messages.at(-1));
    assert.equal(nextInput.includes("person@example.com"), false); assert.equal(nextInput.includes("13800138000"), false);
    assert.equal(context.messages.at(-1).isError, false);
  });
  assert.deepEqual(result.requests.map(request => request.phase), ["before", "after"]); assert.equal(result.event.isError, false);
});

test("actual Pi loop: result callback failure withholds mandatory output despite Pi swallowing handler errors", async t => {
  const f = await fixture(t), secret = "person@example.com";
  fs.writeFileSync(path.join(f.workspace, "private.txt"), secret, { mode: 0o600 });
  await f.enable(rule("read", "transform", "tool.result.transform", builtin("result.redact", { patterns: ["email"] })),
    { result: { content: [{ type: "text", text: secret }], details: null, isError: false } });
  f.control.onAfter = () => { throw Object.assign(new Error("connection lost"), { code: "HOOK_NATIVE_CALL_FAILED" }); };
  await f.execute("read", { path: "private.txt" }, context => {
    assert.equal(JSON.stringify(context.messages.at(-1)).includes(secret), false);
    assert.match(JSON.stringify(context.messages.at(-1)), /请勿自动重试/); assert.equal(context.messages.at(-1).isError, false);
  });
});

test("actual Pi loop: failed action preserves the business outcome and forbids retry in the next model input", async t => {
  const f = await fixture(t), text = "invoice body";
  fs.writeFileSync(path.join(f.workspace, "invoice.txt"), text, { mode: 0o600 });
  fs.writeFileSync(path.join(f.workspace, "backup.txt"), "existing protected backup", { mode: 0o600 });
  await f.enable(rule("read", "action", "tool.after", builtin("workspace.copy", { from: "invoice.txt", to: "backup.txt" })),
    { result: { content: [{ type: "text", text }], isError: false } }, [{ relativePath: "invoice.txt", content: text }]);
  const result = await f.execute("read", { path: "invoice.txt" }, context => {
    const next = context.messages.at(-1);
    assert.equal(next.isError, false); assert.match(JSON.stringify(next), /invoice body/);
    assert.match(JSON.stringify(next), /请勿自动重试/);
    assert.equal(fs.readFileSync(path.join(f.workspace, "backup.txt"), "utf8"), "existing protected backup");
  });
  assert.equal(result.result.details.shoggothHooks.retryAllowed, false);
  assert.equal(result.result.details.shoggothHooks.businessOperation, "already_executed");
});

test("actual Pi loop: disable during final approval sends no write", async t => {
  const f = await fixture(t), active = await f.enable(rule("write", "guard", "tool.before", builtin("guard.require_approval", { reason: "approval" })));
  f.control.onApproval = () => f.store.disable(f.profile.id, uuid(), active.hookId, f.store.get(f.profile.id, active.hookId).revision);
  const result = await f.execute("write", { path: "revoked.txt", content: "must not appear" });
  assert.equal(result.event.isError, true); assert.equal(fs.existsSync(path.join(f.workspace, "revoked.txt")), false);
});
