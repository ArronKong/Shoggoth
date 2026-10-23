#!/usr/bin/env node
"use strict";

// First-launch Agent onboarding through the real Service and its IPC:
// built-in CLI Agents are created once per connected, installed CLI; deleted
// ones are never created again; every new Agent gets its default conversation
// and one fixed greeting that stays in model context; Agents from an earlier
// install are not greeted; deleting the Codex automation owner hands the
// automations to the next Agent on the Codex CLI.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { DEFAULT_AGENT_PROFILE_ID } = require(path.join(ROOT, "app", "agent-service", "product-store.js"));
const { resolveServicePaths } = require(path.join(ROOT, "app", "agent-service", "paths.js"));
const { BUILTIN_CLI_AGENT_PROFILES } = require(path.join(ROOT, "app", "agent-service", "builtin-cli-profiles.js"));
const { DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME, DEFAULT_RUNTIME_ACCOUNTS } = require(path.join(ROOT, "app", "agent-service", "runtime-account.js"));
const { createAgentService, PROTOCOL_VERSION } = require(path.join(ROOT, "app", "agent-service", "server.js"));
const { readClientToken, requestService } = require(path.join(ROOT, "app", "agent-service", "client.js"));

const spec = (runtime) => BUILTIN_CLI_AGENT_PROFILES.find((entry) => entry.runtime === runtime);
const account = (runtime) => DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME[runtime];
const ALL_CLI_ACCOUNTS = DEFAULT_RUNTIME_ACCOUNTS.filter((entry) => entry.kind === "native-user").map((entry) => entry.id);

// `detect` makes the Service find CLIs itself, in an empty PATH and a home whose
// only trace is Antigravity's `agy` command (its ACP server is not installed).
function fixture({ detect = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sbo-")));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  // Mutated by the test: the Service reads it on every request.
  const installed = [];
  const value = { root, paths, installed, service: null };
  let detection = { builtinCliInstalledAccountIds: installed };
  if (detect) {
    const home = path.join(root, "home");
    fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(home, ".local", "bin", "agy"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    fs.mkdirSync(path.join(root, "bin"), { mode: 0o700 });
    detection = { parentEnv: { PATH: path.join(root, "bin") }, runtimeStorageHomedir: () => home };
  }
  value.start = async (version) => {
    value.service = createAgentService({ paths, version, builtinCliProfiles: true, ...detection });
    await value.service.start();
    // As the desktop app applies it on every start: new installs bind each Agent to every connected CLI.
    const config = value.service.nativeRuntimeConfig.read();
    value.service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1,
      flags: { ...config.flags, runtimeMultiBinding: true } });
  };
  value.call = (method, params) => requestService(paths, { method, token: readClientToken(paths),
    version: PROTOCOL_VERSION, params }, { timeoutMs: 20_000 });
  value.ensure = (runtimeAccountIds = ALL_CLI_ACCOUNTS, locale = "zh-CN") =>
    value.call("agent.builtin.ensure", { runtimeAccountIds, locale });
  value.sessions = (profileId) => value.service.chatSessionStore.listSessions()
    .filter((session) => session.profileId === profileId);
  value.greeting = (profileId) => {
    const sessions = value.sessions(profileId);
    assert.equal(sessions.length, 1);
    return value.service.transcriptStore.listEvents(profileId, sessions[0].id).find((event) => event.id === "agent-greeting") || null;
  };
  // An Agent made in Agents -> New, which starts on the built-in harness.
  value.create = async (name) => (await value.call("agent.create", { operationId: `create-${name}`, backendId: "shoggoth",
    name, defaultCwd: null, createdAt: Date.now() })).profile;
  // Makes a connected CLI the Agent's default runtime, as the create dialog does.
  value.useCli = async (profileId, runtimeAccountId) => {
    const state = await value.call("agent.binding.sync", { profileId, runtimeAccountIds: [runtimeAccountId] });
    const binding = state.bindings.find((entry) => entry.runtimeAccountId === runtimeAccountId);
    await value.call("agent.binding.setDefault", { profileId, bindingId: binding.id, revision: state.revision });
    return binding.id;
  };
  return value;
}

async function closeFixture(value) {
  await value.service?.stop().catch(() => {});
  fs.rmSync(value.root, { recursive: true, force: true });
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("fresh install greets the default Agent and creates CLI Agents on first connection", async () => {
  const f = fixture();
  try {
    await f.start("onboarding-fresh");
    assert.equal(f.service.productStore.getAgentProfile(spec("grok-build").id), null);
    const first = await f.ensure();
    assert.deepEqual(first, { createdProfileIds: [], greetedProfileIds: [DEFAULT_AGENT_PROFILE_ID] });
    const greeting = f.greeting(DEFAULT_AGENT_PROFILE_ID);
    assert.equal(greeting.kind, "assistant");
    assert.equal(greeting.runId, null);
    assert.equal(greeting.contextExcluded, false, "the greeting is part of the next turn's model context");
    assert.match(greeting.content.text, /^你好，我是 .+，你的内置 AI 助理。/u);

    // Grok installed later and connected: its Agent appears with a greeting.
    f.installed.push(account("grok-build"));
    const second = await f.ensure();
    assert.deepEqual(second, { createdProfileIds: [spec("grok-build").id], greetedProfileIds: [spec("grok-build").id] });
    const grok = f.service.productStore.getAgentProfile(spec("grok-build").id);
    assert.equal(grok.enabled, true);
    assert.equal(grok.name, "Grok");
    assert.match(f.greeting(grok.id).content.text, /^你好，我是 Grok，由你本机的 Grok 驱动。/u);
    assert.equal(f.service.agentDefinitionStore.get(grok.id).documents.IDENTITY.match(/^- Name: (.+)$/mu)?.[1], "Grok");
    assert.deepEqual(await f.ensure(), { createdProfileIds: [], greetedProfileIds: [] }, "ensure is idempotent");

    // An installed CLI that Settings disconnected gets no Agent until it is connected.
    f.installed.push(account("pi"));
    await f.ensure(ALL_CLI_ACCOUNTS.filter((id) => id !== account("pi")));
    assert.equal(f.service.productStore.getAgentProfile(spec("pi").id), null);
    const connected = await f.ensure(ALL_CLI_ACCOUNTS, "en");
    assert.deepEqual(connected.createdProfileIds, [spec("pi").id]);
    assert.match(f.greeting(spec("pi").id).content.text, /^Hi, I'm Pi, powered by Pi on this Mac\./u);
  } finally {
    await closeFixture(f);
  }
});

test("a deleted built-in Agent is never created again, also after restart", async () => {
  const f = fixture();
  try {
    f.installed.push(account("grok-build"));
    await f.start("onboarding-delete");
    const grok = f.service.productStore.getAgentProfile(spec("grok-build").id);
    assert.equal(grok.enabled, true, "startup creates the Agent of an installed CLI");
    const archived = await f.call("agent.archive", { operationId: "delete-grok", profileId: grok.id,
      expectedUpdatedAt: grok.updatedAt, createdAt: Date.now() });
    assert.equal(archived.profile.enabled, false);
    assert.deepEqual((await f.ensure()).createdProfileIds, []);
    assert.equal(f.service.productStore.getAgentProfile(grok.id).enabled, false);
    await f.service.stop();
    await f.start("onboarding-delete-restart");
    assert.equal(f.service.productStore.getAgentProfile(grok.id).enabled, false);
    assert.deepEqual((await f.ensure()).createdProfileIds, []);
    await assert.rejects(f.call("agent.archive", { operationId: "delete-default", profileId: DEFAULT_AGENT_PROFILE_ID,
      expectedUpdatedAt: f.service.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID).updatedAt, createdAt: Date.now() }),
    (error) => error.code === "AGENT_PROTECTED");
  } finally {
    await closeFixture(f);
  }
});

test("Agents from an earlier install are not greeted when the record first appears", async () => {
  const f = fixture();
  try {
    f.installed.push(account("codex"));
    await f.start("onboarding-upgrade-old");
    // The earlier version created the Agents and their sessions, but no record.
    const mine = await f.create("Mine");
    await f.call("chat.session.create", { operationId: "mine-session", profileId: mine.id, workspace: null,
      createdAt: Date.now() });
    await f.service.stop();
    fs.rmSync(path.join(f.paths.stateDir, "builtin-agent-state.json"));
    await f.start("onboarding-upgrade-new");
    assert.deepEqual(await f.ensure(), { createdProfileIds: [], greetedProfileIds: [] });
    assert.equal(f.greeting(spec("codex").id), null);
    assert.equal(f.greeting(DEFAULT_AGENT_PROFILE_ID), null);
    assert.equal(f.greeting(mine.id), null, "nor is an Agent the user made earlier");
  } finally {
    await closeFixture(f);
  }
});

test("Antigravity's built-in Agent waits until its sign-in installs the ACP server", async () => {
  const f = fixture({ detect: true });
  try {
    await f.start("onboarding-antigravity");
    const antigravity = spec("antigravity").id;
    assert.equal(f.service.productStore.getAgentProfile(antigravity), null, "startup does not create it");
    await f.ensure();
    assert.equal(f.service.productStore.getAgentProfile(antigravity), null,
      "Antigravity on this Mac without its ACP server is not installed");
  } finally {
    await closeFixture(f);
  }
});

test("a new Agent gets a default conversation on its chosen runtime and a first greeting", async () => {
  const f = fixture();
  try {
    f.installed.push(account("codex"));
    await f.start("onboarding-new-agent");
    await f.ensure();
    const onCli = await f.create("CodeX");
    const onHarness = await f.create("Helper");
    assert.equal(f.sessions(onCli.id).length, 0, "creating an Agent alone adds no conversation");
    const bindingId = await f.useCli(onCli.id, account("codex"));
    const result = await f.ensure();
    assert.deepEqual(result.greetedProfileIds.toSorted(), [onCli.id, onHarness.id].toSorted());
    assert.equal(f.sessions(onCli.id)[0].runtimeBindingId, bindingId, "it runs on the runtime chosen when creating it");
    assert.match(f.greeting(onCli.id).content.text, /^你好，我是 CodeX，由你本机的 Codex CLI 驱动。/u);
    assert.match(f.greeting(onHarness.id).content.text, /^你好，我是 Helper，你的 AI 助理。/u);
    assert.deepEqual(await f.ensure(), { createdProfileIds: [], greetedProfileIds: [] }, "greeted only once");
    assert.equal(f.sessions(onCli.id).length, 1);
  } finally {
    await closeFixture(f);
  }
});

test("deleting the automation owner hands the Codex automations to the next Agent on the Codex CLI", async () => {
  const f = fixture();
  try {
    f.installed.push(account("codex"));
    await f.start("onboarding-automation-owner");
    const owner = async () => (await f.call("codex.automation.owner", { backendId: "shoggoth" })).ownerProfileId;
    const codex = f.service.productStore.getAgentProfile(spec("codex").id);
    assert.equal(await owner(), codex.id, "the first-generated Codex Agent starts as owner");
    await f.call("agent.archive", { operationId: "delete-codex", profileId: codex.id,
      expectedUpdatedAt: codex.updatedAt, createdAt: Date.now() });
    assert.equal(await owner(), null, "with no Agent on the Codex CLI the automations are unavailable, not failing");
    const created = await f.create("CodeX");
    assert.equal(await owner(), null, "an Agent on the built-in harness does not qualify");
    await f.useCli(created.id, account("codex"));
    assert.equal(await owner(), created.id, "the new Codex CLI Agent takes over");
    const record = JSON.parse(fs.readFileSync(path.join(f.paths.stateDir, "builtin-agent-state.json"), "utf8"));
    assert.equal(record.codexAutomationOwnerProfileId, created.id);
  } finally {
    await closeFixture(f);
  }
});

test("protocol rejects malformed ensure requests", async () => {
  const f = fixture();
  try {
    await f.start("onboarding-protocol");
    for (const params of [{ runtimeAccountIds: [], locale: "fr" }, { runtimeAccountIds: ["a", "a"], locale: "en" },
      { runtimeAccountIds: [], locale: "en", extra: true }]) {
      await assert.rejects(f.call("agent.builtin.ensure", params), (error) => error.code === "INVALID_PARAMS");
    }
  } finally {
    await closeFixture(f);
  }
});

(async () => {
  let failures = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log(`PASS ${name}`); }
    catch (error) { failures += 1; console.error(`FAIL ${name}\n${error.stack}`); }
  }
  if (failures) process.exitCode = 1;
  else console.log(`${tests.length} built-in Agent onboarding tests passed`);
})();
