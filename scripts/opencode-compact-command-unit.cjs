"use strict";
// OpenCode `/compact`: Shoggoth calls the CLI's own session summarize and
// reports the compacted notice. The HTTP server is a stub; no CLI is spawned.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RuntimeAccountResolver } = require("../app/agent-service/runtime-account-resolver");
const { DEFAULT_RUNTIME_ACCOUNTS, NATIVE_OPENCODE_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");
const { OpenCodeRuntimeHost } = require("../app/agent-service/opencode-runtime-host");

const SESSION = "ses_compactfixture01";

function openHost({ model = "openai/gpt-fixture", turns = [], respond } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-oc-compact-")));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(root, "home"));
  const paths = { trustedRoot: root, stateDir: path.join(root, "state") };
  const binding = { runtime: "opencode", runtimeProfileId: "compact-unit", runtimeAccountId: NATIVE_OPENCODE_RUNTIME_ACCOUNT_ID };
  const resolver = new RuntimeAccountResolver({ paths, parentEnv: { PATH: process.env.PATH, TMPDIR: root }, homedir: path.join(root, "home") });
  const environment = resolver.resolve(binding, DEFAULT_RUNTIME_ACCOUNTS.find(item => item.id === NATIVE_OPENCODE_RUNTIME_ACCOUNT_ID));
  const host = new OpenCodeRuntimeHost({ paths, runtimeBinding: binding, runtimeEnvironment: environment, workspace,
    permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" } });
  const session = { id: SESSION, source: "chat:compact", cwd: host.workspace, title: null, archived: false,
    created: true, createdAt: 1, updatedAt: 1, turns };
  host.state = "ready";
  host.ledger = { snapshot: () => ({ sessions: [session] }) };
  const requests = [];
  host.client = { request: async (method, route, body) => {
    requests.push({ method, route, body });
    if (method === "GET" && route.startsWith(`/session/${SESSION}/message`)) {
      return { status: 200, data: [{ info: { id: "msg_1", sessionID: SESSION, role: "assistant",
        providerID: "anthropic", modelID: "claude-fixture" }, parts: [] }] };
    }
    if (method === "POST" && route === `/session/${SESSION}/summarize`) return respond ? respond(body) : { status: 200, data: true };
    throw new Error(`unexpected ${method} ${route}`);
  } };
  if (model) host.sessionConfigs.set(SESSION, { model, developerInstructions: "" });
  const events = [];
  host.subscribe(event => events.push(event));
  return { host, requests, events, cwd: host.workspace, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("commandsList exposes only compact", async () => {
  const { host, cleanup } = openHost();
  try {
    const listed = await host.commandsList({ sessionId: SESSION });
    assert.deepEqual(listed.commands.map(command => [command.name, command.execution]), [["compact", "runtime"]]);
  } finally { cleanup(); }
});

test("/compact summarizes with the session model, then reports the compacted notice", async () => {
  const { host, requests, events, cwd, cleanup } = openHost();
  try {
    const result = await host.commandExecute({ text: "/compact", sessionId: SESSION, cwd });
    assert.deepEqual(result, { kind: "output", text: "OpenCode conversation compacted.", warning: null });
    assert.deepEqual(requests, [{ method: "POST", route: `/session/${SESSION}/summarize`,
      body: { providerID: "openai", modelID: "gpt-fixture" } }]);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "context_compacted");
    assert.equal(events[0].sessionId, SESSION);
    assert.equal(events[0].contextUsage.runtimeSessionId, SESSION);
    assert.equal(host.canRetireIdle(), true, "no compaction is left registered");
  } finally { cleanup(); }
});

test("without a session model the last assistant model is used", async () => {
  const { host, requests, cwd, cleanup } = openHost({ model: null });
  try {
    await host.commandExecute({ text: "/compact", sessionId: SESSION, cwd });
    assert.deepEqual(requests.at(-1).body, { providerID: "anthropic", modelID: "claude-fixture" });
  } finally { cleanup(); }
});

test("invalid, busy and unconfirmed compactions fail without a compacted notice", async () => {
  const busy = openHost({ turns: [{ id: "turn-1", status: "inProgress" }] });
  const rejected = openHost({ respond: () => ({ status: 200, data: false }) });
  try {
    await assert.rejects(busy.host.commandExecute({ text: "/compact now", sessionId: SESSION, cwd: busy.cwd }),
      { code: "RUNTIME_COMMAND_PARAMS_INVALID" });
    await assert.rejects(busy.host.commandExecute({ text: "/compact", sessionId: null, cwd: busy.cwd }),
      { code: "RUNTIME_COMMAND_SESSION_REQUIRED" });
    await assert.rejects(busy.host.commandExecute({ text: "/review", sessionId: SESSION, cwd: busy.cwd }),
      { code: "RUNTIME_COMMAND_NOT_FOUND" });
    await assert.rejects(busy.host.commandExecute({ text: "/compact", sessionId: SESSION, cwd: busy.cwd }),
      { code: "RUNTIME_SESSION_BUSY" });
    await assert.rejects(rejected.host.commandExecute({ text: "/compact", sessionId: SESSION, cwd: rejected.cwd }),
      { code: "RUNTIME_PROTOCOL_INVALID" });
    assert.equal(busy.events.length + rejected.events.length, 0);
  } finally { busy.cleanup(); rejected.cleanup(); }
});

test("a turn cannot start while the same session is compacting", async () => {
  let release;
  const fixture = openHost({ respond: () => new Promise(resolve => { release = () => resolve({ status: 200, data: true }); }) });
  try {
    const pending = fixture.host.commandExecute({ text: "/compact", sessionId: SESSION, cwd: fixture.cwd });
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(fixture.host.turnStart({ sessionId: SESSION, operationId: "op-1", prompt: "hi", cwd: fixture.cwd,
      permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" } }), { code: "RUNTIME_SESSION_BUSY" });
    release();
    await pending;
    assert.equal(fixture.events.length, 1);
  } finally { fixture.cleanup(); }
});
