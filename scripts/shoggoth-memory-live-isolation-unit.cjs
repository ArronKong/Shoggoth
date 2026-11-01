"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { test } = require("node:test");
const { prepareGrokSocketDenyAlias, assertGrokSocketDenyAlias } = require("./shoggoth-memory-live-isolation.cjs");
const live = require("./shoggoth-memory-live-acceptance.cjs");
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-memory-isolation-unit-")));
  const home = path.join(root, "home"), directory = path.join(root, "original-docker-run"), socket = path.join(root, "system-docker.sock");
  for (const dir of [home, directory]) fs.mkdirSync(dir, { mode: 0o700 });
  fs.symlinkSync(path.join(directory, "docker.sock"), socket);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home, directory, socket };
}
test("disposable Grok HOME preserves only the automatic socket deny directory identity", t => {
  const f = fixture(t), before = fs.lstatSync(f.socket);
  const proof = prepareGrokSocketDenyAlias(f.home, f.directory, f.socket);
  assertGrokSocketDenyAlias(f.home, proof);
  assert.equal(fs.realpathSync(path.join(f.home, ".docker", "run")), f.directory);
  assert.equal(fs.lstatSync(f.socket).ino, before.ino);
  assert.deepEqual(fs.readdirSync(f.directory), []);
  assert.deepEqual(fs.readdirSync(f.home), [".docker"]);
  fs.unlinkSync(f.socket); fs.symlinkSync(path.join(f.root, "another.sock"), f.socket);
  assert.throws(() => assertGrokSocketDenyAlias(f.home, proof), { code: "MEMORY_LIVE_SOCKET_IDENTITY_CHANGED" });
});
test("socket alias refuses unrelated, noncanonical or writable-by-others directories", t => {
  const f = fixture(t);
  assert.throws(() => prepareGrokSocketDenyAlias(f.home, "relative", f.socket), { code: "MEMORY_LIVE_SOCKET_DIRECTORY_UNSAFE" });
  assert.throws(() => prepareGrokSocketDenyAlias(f.home, f.home, f.socket), { code: "MEMORY_LIVE_SOCKET_TARGET_MISMATCH" });
  fs.chmodSync(f.directory, 0o777);
  assert.throws(() => prepareGrokSocketDenyAlias(f.home, f.directory, f.socket), { code: "MEMORY_LIVE_SOCKET_DIRECTORY_UNSAFE" });
  assert.deepEqual(fs.readdirSync(f.home), []);
});
test("extended runtime plans read no credentials and socket aliases cannot change other runtimes", async () => {
  for (const runtime of ["grok-build", "antigravity"]) {
    const options = live.parse(["--suite", "repair", "--runtime", runtime]);
    const plan = await live.execute(options);
    assert.equal(plan.credentialFilesRead, false); assert.equal(plan.providerCalls, 0);
    assert.equal(plan.intendedSteps.length, 8);
  }
  assert.throws(() => live.parse(["--suite", "repair", "--runtime", "antigravity", "--runtime-socket-directory", "/tmp"]),
    { code: "MEMORY_LIVE_ARGS_INVALID" });
  assert.throws(() => live.parse(["--suite", "repair", "--runtime", "grok-build", "--runtime-socket-directory", "relative"]),
    { code: "MEMORY_LIVE_ABSOLUTE_PATH_REQUIRED" });
});

const { memoryApprovalTool, watchMemoryApprovals } = require("./shoggoth-memory-live-approvals.cjs");
function approvalFixture() {
  const scope = { runtime: "grok-build", runId: "run", profileId: "profile", sessionKey: "test-session" };
  const run = { id: "run", profileId: "profile", source: "chat", sourceId: "test-session", status: "waiting_approval", waitingRequestId: "request" };
  const record = { kind: "approval", runId: "run", requestId: "request", method: "item/commandExecution/requestApproval",
    params: { toolName: "shoggoth__memory_search", approvalOptions: [{ choice: "once", kind: "allow_once" }],
      toolInput: { variant: "inline", tool_name: "shoggoth__memory_search", tool_input: { source: "chat", sourceId: "test-session", query: "synthetic", activityTitle: "Search" } } } };
  return { scope, run, record };
}
test("live approval driver admits only valid once-only memory requests for the exact synthetic run", () => {
  const f = approvalFixture(); assert.equal(memoryApprovalTool(f.record, f.run, f.scope), "memory_search");
  for (const mutate of [
    f => { f.scope.runtime = "antigravity"; },
    f => { f.record.runId = "another-run"; },
    f => { f.run.profileId = "another-profile"; },
    f => { f.run.sourceId = "another-session"; },
    f => { f.run.waitingRequestId = "another-request"; },
    f => { f.record.publicPayload = { redacted: true }; },
    f => { f.record.method = "item/fileChange/requestApproval"; },
    f => { f.record.params.toolName = "bash"; },
    f => { f.record.params.approvalOptions = [{ choice: "session", kind: "allow_always" }]; },
    f => { f.record.params.toolInput.tool_name = "shoggoth__connector_call"; },
    f => { f.record.params.toolInput.tool_name = "other__memory_search"; },
    f => { f.record.params.toolInput.tool_input.sourceId = "original-session"; },
    f => { f.record.params.toolInput.tool_input.includeCandidates = true; },
    f => { f.record.params.toolInput.tool_input.unknown = "value"; },
    f => { f.record.params.toolInput.command = "command"; },
    f => { f.record.params.toolInput.tool_input_file = "/original/data"; },
    f => { f.record.params.toolInput.variant = {}; },
  ]) {
    const value = structuredClone(f); mutate(value);
    assert.equal(memoryApprovalTool(value.record, value.run, value.scope), null);
  }
});
test("live approval watcher answers once, ignores other runs, stops, and fails closed on an unexpected tool", async () => {
  const f = approvalFixture(), calls = [], evidence = [];
  const coordinator = { pendingRequests: new Map([["request", f.record], ["other", { runId: "other" }]]),
    dispatcher: { getRun: () => f.run }, async respondApproval(input) { calls.push(input); } };
  const watcher = watchMemoryApprovals(coordinator, f.scope, evidence);
  await new Promise(resolve => setTimeout(resolve, 125)); watcher.stop();
  assert.equal(calls.length, 1); assert.equal(calls[0].choice, "once");
  assert.deepEqual(evidence, [{ runId: "run", tool: "memory_search", choice: "once" }]);
  f.record.params.toolInput.tool_name = "shoggoth__connector_call";
  const rejected = watchMemoryApprovals(coordinator, f.scope, evidence);
  await assert.rejects(rejected.failure, { code: "MEMORY_LIVE_UNEXPECTED_APPROVAL" }); rejected.stop();
  assert.equal(calls.length, 1);
});

test("independent real acceptance requires a complete explicit copied model account and remains credential-free in plan mode", async () => {
  const base = ["--suite", "repair", "--runtime", "grok-build"];
  assert.throws(() => live.parse([...base, "--memory-model", "fixture"]), { code: "MEMORY_LIVE_ARGS_INVALID" });
  const options = live.parse([...base, "--memory-model", "fixture", "--memory-codex-bin", "/missing/bin", "--memory-codex-auth", "/missing/auth"]);
  assert.equal((await live.execute(options)).credentialFilesRead, false);
  assert.throws(() => live.parse([...base, "--memory-model", "bad model", "--memory-codex-bin", "/missing/bin", "--memory-codex-auth", "/missing/auth"]), { code: "MEMORY_LIVE_MODEL_INVALID" });
});

test("read-only history approvals remain scoped to the synthetic Agent and known sessions", () => {
  const f = approvalFixture(); f.scope.allowedSessionIds = ["owned-source"];
  f.record.params.toolName = f.record.params.toolInput.tool_name = "shoggoth__conversation_search";
  assert.equal(memoryApprovalTool(f.record, f.run, f.scope), "conversation_search");
  f.record.params.toolInput.tool_input.sessionId = "foreign-session";
  assert.equal(memoryApprovalTool(f.record, f.run, f.scope), null);
  f.record.params.toolInput.tool_input.sessionId = "owned-source";
  assert.equal(memoryApprovalTool(f.record, f.run, f.scope), "conversation_search");
  f.record.params.toolInput.tool_input.limit = 999;
  assert.equal(memoryApprovalTool(f.record, f.run, f.scope), null);
  f.record.params.toolName = f.record.params.toolInput.tool_name = "shoggoth__conversation_get";
  f.record.params.toolInput.tool_input = { source: "chat", sourceId: f.scope.sessionKey, sessionId: "owned-source", eventId: "source-event", window: 1 };
  assert.equal(memoryApprovalTool(f.record, f.run, f.scope), "conversation_get");
  f.scope.allowedSessionIds = [];
  assert.equal(memoryApprovalTool(f.record, f.run, f.scope), null);
});
