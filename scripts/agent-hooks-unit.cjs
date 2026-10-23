"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { HookStore } = require("../app/agent-service/hook-store");
const { HookRunner } = require("../app/agent-service/hook-runner");
const { HookProcessHost } = require("../app/agent-service/hook-process-host");
const { HookService } = require("../app/agent-service/hook-service");
const { HookToolExecution } = require("../app/agent-service/hook-tool-execution");
const { HookWorkspaceWriters } = require("../app/agent-service/hook-workspace-writers");
const { validateDefinition, validateOutput, digest } = require("../app/agent-service/hook-contract");
const { HOOK_TOOL_NAMES, validateHookArguments, HOOK_AGENT_INSTRUCTIONS } = require("../app/agent-service/hook-service-protocol");
const { runtimeHookCapabilities, assertHookSupported } = require("../app/agent-service/runtime-hook-bridge");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { DEFAULT_TOOL_REGISTRY } = require("../app/agent-service/mcp-product-tool-controller");
const { PermissionEngine } = require("../app/agent-service/permission-engine");
const uuid = () => crypto.randomUUID();
test("workspace writer gate treats aliases as one writer and fences retargeted paths", t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sg-hook-writer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, "original"), sibling = path.join(root, "sibling"), alias = path.join(root, "alias");
  fs.mkdirSync(original); fs.mkdirSync(sibling); fs.symlinkSync(original, alias);
  const writers = new HookWorkspaceWriters(); writers.acquire("run-one", original, "workspace-write");
  assert.equal(writers.busy("run-two", alias, "workspace-write"), true);
  assert.equal(writers.busy("run-two", path.join(original, "nested"), "workspace-write"), true);
  assert.equal(writers.busy("run-two", root, "workspace-write"), true);
  assert.equal(writers.busy("run-two", path.parse(root).root, "workspace-write"), true);
  assert.equal(writers.busy("run-two", sibling, "workspace-write"), false);
  assert.throws(() => writers.acquire("run-one", sibling, "workspace-write"), { code: "HOOK_WRITE_FORBIDDEN" });
  assert.throws(() => writers.acquire("run-two", alias, "workspace-write"), { code: "HOOK_WORKSPACE_BUSY" });
  writers.assert("run-one", alias);
  fs.unlinkSync(alias); fs.symlinkSync(sibling, alias);
  assert.throws(() => writers.assert("run-one", alias), { code: "HOOK_WRITE_FORBIDDEN" });
  writers.release("run-one"); writers.acquire("run-two", path.join(alias, "not-created", "yet"), "workspace-write");
  assert.equal(writers.busy("run-three", path.join(sibling, "not-created", "yet"), "workspace-write"), true);
  writers.close();
});
const definition = (handler, { event = "tool.before", kind = "guard", scopes = ["product"], tools = ["business_tool"], ...extra } = {}) => ({
  schemaVersion: 1, name: handler.name || "生活规则", kind, event,
  scope: { workspace: "current", sources: ["chat", "cron", "kanban", "inspiration"] },
  matcher: event.startsWith("tool.") ? { toolScopes: scopes, toolNames: tools } : {}, handler, ...extra,
});
const builtin = (name, config) => ({ type: "builtin", name, config });
async function fixture(t, { sandbox = false } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sg-hooks-unit-"));
  const workspace = path.join(root, "workspace"); fs.mkdirSync(workspace, { mode: 0o700 });
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"), profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  const store = new HookStore({ paths }).open();
  const processHost = new HookProcessHost({ store, cacheDir: paths.hookEphemeralDir });
  if (sandbox) assert.equal(await processHost.verify(), true, "real OS sandbox must pass; never silently skip");
  const runner = new HookRunner({ store, processHost });
  const profile = { id: "profile-one", enabled: true, runtime: "codex" };
  const runs = new Map(), productStore = { getAgentProfile: id => id === profile.id ? profile : null };
  const permissionEngine = new PermissionEngine({ toolRegistry: DEFAULT_TOOL_REGISTRY });
  const approvals = [], writers = new HookWorkspaceWriters();
  const service = new HookService({ store, runner, processHost, productStore, getRun: id => runs.get(id),
    permissionEngine, toolRegistry: DEFAULT_TOOL_REGISTRY, cacheDir: paths.hookEphemeralDir,
    resolveToolIdentity: async () => [{ name: "business_tool" }],
    requestApproval: async input => { approvals.push(structuredClone(input.arguments)); return { approved: true }; } });
  const execution = new HookToolExecution({ service, getExecutionPolicy: () => ({ sandbox: "workspace-write" }),
    assertWorkspaceWriter: (runId, workspace) => writers.assert(runId, workspace) });
  const run = (source = "chat") => {
    const run = { id: uuid(), profileId: profile.id, workspace, source, status: "running" };
    runs.set(run.id, run); return run;
  };
  const scope = run => ({ runId: run.id, signal: new AbortController().signal, assertCurrent() { if (!profile.enabled) throw Object.assign(new Error("revoked"), { code: "HOOK_REVOKED" }); } });
  const call = (name, args, run, confirmed = false) => service.handleTool(name, args, { profileId: profile.id,
    callId: uuid(), ...(confirmed ? { confirmation: true } : {}) }, scope(run));
  const enable = async (input, run = f.run(), payload = { arguments: { amount: 600 } }, files = []) => {
    const saved = await call("hook_register", { definition: input }, run);
    const receipt = await call("hook_test", { hookId: saved.hookId, version: saved.version, payload, files }, run);
    assert.equal(receipt.passed, true, JSON.stringify(receipt));
    if (Object.values(require("../app/agent-service/hook-contract").dataAccess(store.get(profile.id, saved.hookId).definition)).some(Boolean)
      || input.handler.type === "script") await call("hook_grant", { hookId: saved.hookId, version: saved.version }, run, true);
    return call("hook_enable", { hookId: saved.hookId, version: saved.version, expectedRevision: saved.revision }, run);
  };
  const f = { root, workspace, paths, store, processHost, runner, profile, runs, service, execution, writers, run, scope, call, enable, approvals };
  t.after(async () => { await runner.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return f;
}
test("contract rejects authority injection, malformed data, wrong events and path escapes", () => {
  assert.equal(HOOK_TOOL_NAMES.length, 12);
  assert.equal(validateHookArguments("hook_register", { definition: {}, confirmation: true }), false);
  for (const input of [
    definition(builtin("arguments.patch", { patch: { profileId: "another" } }), { kind: "transform" }),
    definition(builtin("guard.require_approval", { reason: "confirm" }), { event: "run.before" }),
    definition(builtin("context.file", { relativePath: "../secret" }), { kind: "transform", event: "context.prepare" }),
    definition(builtin("guard.block", { reason: "block" }), { owner: "product" }),
    definition(builtin("guard.block", { reason: "block" }), { required: false }),
    definition(builtin("guard.block", { reason: "block" }), { failurePolicy: "continue" }),
  ]) assert.throws(() => validateDefinition(input, "/private/tmp"));
  const injected = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(() => validateDefinition(injected, "/private/tmp"));
  assert.match(HOOK_AGENT_INSTRUCTIONS, /quoted material/);
  assert.match(HOOK_AGENT_INSTRUCTIONS, /next_run/);
  assert.throws(() => validateDefinition(definition({ type: "script", language: "javascript", source: "module.exports=()=>({})", compatibility: "claude-code-pretooluse-v1" },
    { kind: "observe", event: "run.completed" }), "/private/tmp"), { code: "HOOK_COMPATIBILITY_UNSUPPORTED" });
});
test("explicit compatible scripts normalize decisions and exit 2 inside the real OS sandbox", async t => {
  const f = await fixture(t, { sandbox: true });
  const cases = [
    ["claude-code-pretooluse-v1", "const input=JSON.parse(require('node:fs').readFileSync(0,'utf8')); if(input.tool_name!=='business_tool'||input.tool_input.amount!==600)throw Error('input'); console.log(JSON.stringify({decision:'block',reason:'legacy block'}));", "block"],
    ["claude-code-pretooluse-v1", "process.stderr.write('exit-code policy'); process.exit(2);", "block"],
    ["claude-code-pretooluse-v1", "module.exports=()=>({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'ask',permissionDecisionReason:'confirm'}})", "require_approval"],
    ["claude-code-pretooluse-v1", "process.exit(0)", "allow"],
    ["cursor-tool-permission-v1", "module.exports=()=>({permission:'deny',agent_message:'cursor policy'})", "block"],
    ["cursor-tool-permission-v1", "console.log(JSON.stringify({permission:'ask',user_message:'confirm'}))", "require_approval"],
  ];
  for (const [compatibility, source, decision] of cases) {
    const def = definition({ type: "script", language: "javascript", compatibility, source });
    const saved = await f.enable(def), run = f.run(), snapshot = f.service.freezeRun(run, f.profile);
    const event = f.service.event(snapshot, run, "tool.before", "legacy-" + uuid(), { arguments: { amount: 600 } }, { scope: "product", name: "business_tool" });
    const verdict = await f.runner.before(snapshot, event, { assertCurrent() {} }); assert.equal(verdict.decision, decision);
    f.store.disable(f.profile.id, uuid(), saved.hookId, f.store.get(f.profile.id, saved.hookId).revision);
  }
  for (const source of ["console.log('invalid-json')", "module.exports=()=>({hookSpecificOutput:{hookEventName:'PostToolUse',permissionDecision:'allow'}})",
    "module.exports=()=>({permission:'allow',updatedInput:{amount:0}})", "process.exit(1)"]) {
    const definitionInput = validateDefinition(definition({ type: "script", language: "javascript", compatibility: source.includes("permission:'allow'") ? "cursor-tool-permission-v1" : "claude-code-pretooluse-v1", source }), f.workspace);
    const saved = f.store.register(f.profile.id, uuid(), definitionInput); f.store.grant(f.profile.id, uuid(), saved.hookId, 1);
    f.store.activate(f.profile.id, uuid(), saved.hookId, 1, 1, () => {});
    const run = f.run(); f.service.freezeRun(run, f.profile); let effects = 0;
    await assert.rejects(f.execution.execute({ run, profile: f.profile, tool: { scope: "product", name: "business_tool" }, args: { amount: 600 },
      scope: f.scope(run), callId: uuid(), validateArguments: () => true }, async () => { effects++; return { status: "completed" }; }));
    assert.equal(effects, 0);
    f.store.disable(f.profile.id, uuid(), saved.hookId, f.store.get(f.profile.id, saved.hookId).revision);
  }
});
test("real SQLite: idempotency, CAS, cross-profile denial and next-run version freezing", async t => {
  const f = await fixture(t), run = f.run();
  const def = validateDefinition(definition(builtin("guard.block", { reason: "blocked" })), f.workspace);
  const op = uuid(), saved = f.store.register(f.profile.id, op, def);
  assert.equal(f.store.register(f.profile.id, op, def).hookId, saved.hookId);
  assert.throws(() => f.store.register(f.profile.id, op, { ...def, name: "changed" }), { code: "HOOK_OPERATION_CONFLICT" });
  assert.throws(() => f.store.get("another-profile", saved.hookId), { code: "HOOK_NOT_FOUND" });
  const active = f.store.activate(f.profile.id, uuid(), saved.hookId, 1, 1, () => {});
  const frozen = f.service.freezeRun(run, f.profile);
  assert.equal(active.effectiveFrom, "next_run"); assert.equal(frozen.entries[0].version, 1);
  assert.throws(() => f.store.update(f.profile.id, uuid(), saved.hookId, 1, def), { code: "HOOK_REVISION_CONFLICT" });
  const updated = f.store.update(f.profile.id, uuid(), saved.hookId, active.revision, { ...def, name: "changed" });
  f.store.activate(f.profile.id, uuid(), saved.hookId, 2, updated.revision, () => {});
  assert.equal(f.store.snapshotForRun(run.id).entries[0].version, 1);
  const next = f.service.freezeRun(f.run(), f.profile); assert.equal(next.entries[0].version, 2);
  f.store.assertCurrent(frozen, frozen.entries[0]);
  f.store.disable(f.profile.id, uuid(), saved.hookId, f.store.get(f.profile.id, saved.hookId).revision);
  assert.throws(() => f.store.assertCurrent(frozen, frozen.entries[0]), { code: "HOOK_REVOKED" });
  f.store.close(); f.store.open(); assert.equal(f.store.get(f.profile.id, saved.hookId).activeVersion, null);
});
test("management requires trusted authority, exact grant and successful test before enable", async t => {
  const f = await fixture(t), run = f.run();
  const saved = await f.call("hook_register", { definition: definition(builtin("guard.condition", { conditions: [{ path: "arguments.amount", op: "gt", value: 500 }], decision: "require_approval", reason: "金额超过 500" })) }, run);
  await assert.rejects(f.call("hook_enable", { hookId: saved.hookId, version: 1, expectedRevision: 1 }, run), { code: "HOOK_TEST_REQUIRED" });
  await assert.rejects(f.call("hook_grant", { hookId: saved.hookId, version: 1 }, run), { code: "MCP_TOOL_CONFIRMATION_REQUIRED" });
  const test = await f.call("hook_test", { hookId: saved.hookId, version: 1, payload: { arguments: { amount: 600 } } }, run);
  assert.equal(test.output.decision, "require_approval");
  await assert.rejects(f.call("hook_enable", { hookId: saved.hookId, version: 1, expectedRevision: 1 }, run), { code: "HOOK_GRANT_REQUIRED" });
  await f.call("hook_grant", { hookId: saved.hookId, version: 1 }, run, true);
  await f.call("hook_enable", { hookId: saved.hookId, version: 1, expectedRevision: 1 }, run);
  await assert.rejects(f.service.handleTool("hook_list", {}, { profileId: f.profile.id, callId: uuid() }, { ...f.scope(run), runId: "wrong" }), { code: "HOOK_FORBIDDEN" });
  await assert.rejects(f.service.handleTool("hook_list", {}, { profileId: f.profile.id, callId: uuid(), federationClient: {} }, f.scope(run)), { code: "HOOK_FORBIDDEN" });
});
test("tool barrier: transform first, final schema and approval, block causes zero business calls", async t => {
  const f = await fixture(t);
  await f.enable(definition(builtin("arguments.patch", { patch: { amount: 900 } }), { kind: "transform", priority: -100 }));
  await f.enable(definition(builtin("guard.condition", { conditions: [{ path: "arguments.amount", op: "gt", value: 500 }], decision: "require_approval", reason: "超过预算" }), { priority: 100 }));
  const run = f.run(); f.service.freezeRun(run, f.profile);
  const input = () => ({ run, profile: f.profile, tool: { scope: "product", name: "business_tool" },
    args: { amount: 20 }, scope: f.scope(run), callId: uuid(), validateArguments: args => Number.isFinite(args.amount) });
  let calls = 0;
  const output = await f.execution.execute(input(), async args => { calls++; assert.equal(args.amount, 900); return { status: "completed", id: "original" }; });
  assert.equal(calls, 1); assert.equal(output.id, "original"); assert.deepEqual(f.approvals, [{ amount: 900 }]);
  await assert.rejects(f.execution.execute({ ...input(), validateArguments: () => false }, async () => { calls++; }), { code: "HOOK_ARGUMENTS_INVALID" });
  assert.equal(calls, 1);
  await f.enable(definition(builtin("guard.block", { reason: "不允许" }), { priority: -200 }));
  const next = f.run(); f.service.freezeRun(next, f.profile);
  await assert.rejects(f.execution.execute({ ...input(), run: next, scope: f.scope(next) }, async () => { calls++; }), { code: "HOOK_BLOCKED" });
  assert.equal(calls, 1); assert.equal(f.approvals.length, 1);
});
test("result redaction reaches caller and retains authoritative status and IDs", async t => {
  const f = await fixture(t);
  await f.enable(definition(builtin("result.redact", { patterns: ["phone", "email"] }),
    { event: "tool.result.transform", kind: "transform" }), f.run(), { result: { status: "completed", id: "order-1", text: "电话 13800138000，邮箱 a@example.com" } });
  const run = f.run(); f.service.freezeRun(run, f.profile);
  const original = { status: "completed", id: "order-1", text: "电话 13800138000，邮箱 a@example.com" };
  const result = await f.execution.execute({ run, profile: f.profile, tool: { scope: "product", name: "business_tool" },
    args: {}, scope: f.scope(run), callId: uuid(), validateArguments: () => true }, async () => original);
  assert.equal(result.status, "completed"); assert.equal(result.id, "order-1");
  assert.doesNotMatch(result.text, /13800138000|a@example.com/); assert.match(original.text, /13800138000/);
});
test("failed or uncertain business results never dispatch after-tool actions", async t => {
  const f = await fixture(t, { sandbox: true });
  await f.enable(definition(builtin("workspace.copy", { from: "a", to: "b" }), { kind: "action", event: "tool.after" }),
    f.run(), {}, [{ relativePath: "a", content: "synthetic" }]);
  const run = f.run(); f.service.freezeRun(run, f.profile);
  let actions = 0;
  f.runner.processHost = { async run() { actions++; return { status: "completed", sideEffect: "known" }; }, async close() {} };
  f.writers.acquire(run.id, run.workspace);
  for (const result of [{ success: false }, { exitCode: 2 }, { status: "needs_verification" },
    { isError: false, structuredContent: { status: "unknown" } }]) {
    assert.deepEqual(await f.execution.execute({ run, profile: f.profile, tool: { scope: "product", name: "business_tool" },
      args: {}, scope: f.scope(run), callId: uuid(), validateArguments: () => true }, async () => result), result);
  }
  assert.equal(actions, 0);
  await f.execution.execute({ run, profile: f.profile, tool: { scope: "product", name: "business_tool" },
    args: {}, scope: f.scope(run), callId: uuid(), validateArguments: () => true }, async () => ({ success: true }));
  assert.equal(actions, 1); f.writers.release(run.id);
});
test("context freezes before next model call; observability is durable, bounded and idempotent", async t => {
  const f = await fixture(t);
  await f.enable(definition(builtin("context.literal", { text: "本周购物上限 300 元" }), { event: "context.prepare", kind: "transform" }), f.run(), {});
  await f.enable(definition(builtin("observe.record", { tags: ["生活记录"] }), { event: "run.completed", kind: "observe" }), f.run(), {});
  const run = f.run(), prepared = await f.service.prepareRun(run, f.profile, () => {});
  assert.equal(prepared.contributions[0].text, "本周购物上限 300 元");
  f.service.observeRun(run, "run.completed", { secretBody: "must not persist" });
  f.service.observeRun(run, "run.completed", { secretBody: "must not persist" });
  await f.runner.drain();
  const receipts = f.store.executions(f.profile.id, { runId: run.id }).items;
  assert.equal(receipts.filter(item => item.event === "run.completed").length, 1);
  const event = f.store.db.prepare("SELECT data FROM events").get();
  assert.doesNotMatch(event.data, /must not persist/);
});
test("receipt pagination filters the full retained history before applying page limits", async t => {
  const f = await fixture(t);
  f.store.write(() => {
    for (let index = 0; index < 1100; index++) {
      f.store.putExecution({ id: "receipt-" + String(index).padStart(5, "0"), profileId: f.profile.id,
        hookId: index >= 1040 ? "target-hook" : "other-hook", version: 1, eventId: "event-" + index,
        runId: index >= 1040 ? "target-run" : "other-run", kind: "observe", state: "settled",
        createdAt: index, finishedAt: index, output: { secret: "never in management page" } });
    }
  });
  const filters = { hookId: "target-hook", runId: "target-run", limit: 50 };
  const first = f.store.executions(f.profile.id, filters);
  assert.equal(first.items.length, 50); assert.equal(first.items[0].id, "receipt-01040");
  assert.equal(first.nextCursor, "receipt-01089"); assert.ok(first.items.every(item => !Object.hasOwn(item, "output")));
  const second = f.store.executions(f.profile.id, { ...filters, cursor: first.nextCursor });
  assert.equal(second.items.length, 10); assert.equal(second.items.at(-1).id, "receipt-01099");
  assert.equal(second.nextCursor, null);
  assert.deepEqual(f.store.executions("another-profile", filters).items, []);
});
test("unknown action receipt survives reopen and is never replayed", async t => {
  const f = await fixture(t), run = f.run();
  const def = validateDefinition(definition(builtin("workspace.copy", { from: "a", to: "b" }), { kind: "action", event: "tool.after" }), f.workspace);
  const saved = f.store.register(f.profile.id, uuid(), def);
  f.store.grant(f.profile.id, uuid(), saved.hookId, 1); f.store.activate(f.profile.id, uuid(), saved.hookId, 1, 1, () => {});
  const snapshot = f.store.freeze(run, runtimeHookCapabilities("codex"), () => {}), entry = snapshot.entries[0];
  const event = f.service.event(snapshot, run, "tool.after", "cut-" + uuid(), {}, { scope: "product", name: "business_tool" });
  const { execution } = f.store.beginExecution(snapshot, entry, event);
  f.store.settleExecution(execution, { state: "dispatched" });
  f.store.close(); f.store.open();
  let launched = 0; f.runner.processHost = { async run() { launched++; }, async close() {} };
  await assert.rejects(f.runner.execute(snapshot, entry, event, { assertWritable() {} }), { code: "HOOK_NEEDS_VERIFICATION" });
  assert.equal(launched, 0); assert.equal(f.store.execution(f.profile.id, execution.id).state, "needs_verification");
  f.store.prune(); assert.equal(f.store.execution(f.profile.id, execution.id).state, "needs_verification");
});
test("required native rule is refused for an unverified Runtime; special sources have zero hooks", async t => {
  const f = await fixture(t), caps = runtimeHookCapabilities("pi");
  const rule = validateDefinition(definition(builtin("guard.block", { reason: "停" }), { scopes: ["runtime_builtin"], tools: ["bash"] }), f.workspace);
  assert.throws(() => assertHookSupported(rule, caps, f.processHost), { code: "HOOK_RUNTIME_UNSUPPORTED" });
  await f.enable(definition(builtin("guard.block", { reason: "停" })));
  assert.equal(f.service.freezeRun(f.run("proactive"), f.profile).entries.length, 0);
  assert.equal(f.service.freezeRun(f.run("compaction"), f.profile).entries.length, 0);
});
test("50 ToolExecution rounds, 1000 isolated tool interactions across four sources", async t => {
  const f = await fixture(t);
  await f.enable(definition(builtin("guard.condition", { conditions: [{ path: "arguments.amount", op: "gt", value: 500 }], decision: "block", reason: "预算" })));
  let calls = 0, blocks = 0;
  for (let round = 0; round < 50; round++) {
    const run = f.run(["chat", "cron", "kanban", "inspiration"][round % 4]); f.service.freezeRun(run, f.profile);
    for (let i = 0; i < 20; i++) {
      const args = { amount: i % 2 === 0 ? 600 : 100 };
      try {
        await f.execution.execute({ run, profile: f.profile, tool: { scope: "product", name: "business_tool" },
          args, scope: f.scope(run), callId: uuid(), validateArguments: value => typeof value.amount === "number" },
          async () => { calls++; return { status: "completed" }; });
      } catch (error) { assert.equal(error.code, "HOOK_BLOCKED"); blocks++; }
    }
  }
  assert.equal(calls, 500); assert.equal(blocks, 500); assert.equal(f.runner.active.size, 0);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM executions").get().n, 1000);
});
test("real sandboxed Worker: isolated copy, no overwrite, timeout cleanup and synthetic test", async t => {
  const f = await fixture(t, { sandbox: true });
  const rule = definition(builtin("workspace.copy", { from: "invoice.txt", to: "archive/invoice.txt" }), { event: "tool.after", kind: "action" });
  fs.mkdirSync(path.join(f.workspace, "archive")); fs.writeFileSync(path.join(f.workspace, "invoice.txt"), "真实收据");
  // A seeded empty test directory must contain every required parent itself.
  const saved = await f.call("hook_register", { definition: rule }, f.run());
  const testResult = await f.call("hook_test", { hookId: saved.hookId, version: 1, payload: {}, files: [
    { relativePath: "invoice.txt", content: "测试收据" }, { relativePath: "archive/.keep", content: "" },
  ] }, f.run());
  assert.equal(testResult.passed, true, JSON.stringify(testResult)); assert.equal(fs.existsSync(path.join(f.workspace, "archive/invoice.txt")), false);
  await f.call("hook_grant", { hookId: saved.hookId, version: 1 }, f.run(), true);
  await f.call("hook_enable", { hookId: saved.hookId, version: 1, expectedRevision: 1 }, f.run());
  const run = f.run(); f.service.freezeRun(run, f.profile); f.writers.acquire(run.id, f.workspace, "workspace-write");
  const input = { run, profile: f.profile, tool: { scope: "product", name: "business_tool" }, args: {},
    scope: f.scope(run), callId: uuid(), validateArguments: () => true };
  const output = await f.execution.execute(input, async () => ({ status: "completed" }));
  assert.equal(output.status, "completed"); assert.equal(fs.readFileSync(path.join(f.workspace, "archive/invoice.txt"), "utf8"), "真实收据");
  const repeat = await f.execution.execute({ ...input, callId: uuid() }, async () => ({ status: "completed" }));
  assert.equal(repeat._meta.shoggothHooks.actionStatus, "HOOK_WORKER_FAILED"); assert.equal(repeat._meta.shoggothHooks.retryAllowed, false);
  const script = validateDefinition(definition({ type: "script", language: "javascript", source: "module.exports=()=>{while(true){}}" }, { timeoutMs: 150 }), f.workspace);
  f.store.saveSource(script);
  await assert.rejects(f.processHost.run(script, { workspace: f.workspace }, { workspace: f.workspace }), { code: "HOOK_TIMEOUT" });
  assert.equal(f.processHost.children.size, 0); assert.equal(f.runner.active.size, 0);
});
