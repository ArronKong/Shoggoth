"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const UI_ENTRY = path.join(ROOT, "app", "ui-entry.js");
const SHOGGOTH_BACKEND = path.join(ROOT, "app", "core", "shoggoth-backend.js");
const { BackendRegistry } = require(path.join(ROOT, "app", "core", "backend-registry.js"));
const { OpenClawBackend } = require(path.join(ROOT, "app", "core", "openclaw-backend.js"));
const { HermesBackend } = require(path.join(ROOT, "app", "core", "hermes-backend.js"));
const { ShoggothBackend } = require(SHOGGOTH_BACKEND);

function registryBackend({ id, emitPartial }) {
  return {
    id,
    name: id,
    async start({ onPartialReady }) {
      if (emitPartial) onPartialReady();
      return true;
    },
    getAgents() { return [{ id: `${id}-agent` }]; },
  };
}

function nativeFacade({ id, name, connectionMode, claimsAgentId }) {
  return new ShoggothBackend({
    id,
    name,
    connectionMode,
    claimsAgentId,
    paths: { tokenPath: "/tmp/unused-token" },
    readToken: () => "unused",
    requestService: async () => { throw new Error("unused"); },
  });
}

test("BackendRegistry 对已 partial-ready 的成功启动不重复发 final ready", async () => {
  const registry = new BackendRegistry();
  const events = [];
  registry.on("backend.ready", (event) => events.push(event));
  registry.register(registryBackend({ id: "partial", emitPartial: true }));

  const result = await registry.start();

  assert.equal(result.get("partial"), true);
  assert.equal(events.length, 1);
  assert.equal(events[0].backendId, "partial");
});

test("BackendRegistry 对没有 partial-ready 的成功启动仍发一次 final ready", async () => {
  const registry = new BackendRegistry();
  const events = [];
  registry.on("backend.ready", (event) => events.push(event));
  registry.register(registryBackend({ id: "final", emitPartial: false }));

  const result = await registry.start();

  assert.equal(result.get("final"), true);
  assert.equal(events.length, 1);
  assert.equal(events[0].backendId, "final");
});

test("Shoggoth backend exposes the registry adapter contract", () => {
  assert.equal(fs.existsSync(SHOGGOTH_BACKEND), true, "shoggoth-backend.js must exist before desktop registration");
  const { AgentBackend } = require(path.join(ROOT, "app", "core", "agent-backend.js"));
  const { ShoggothBackend } = require(SHOGGOTH_BACKEND);
  assert.equal(typeof ShoggothBackend, "function");
  const backend = new ShoggothBackend({
    paths: { tokenPath: "/tmp/unused-token" },
    readToken: () => "unused",
    requestService: async () => { throw new Error("unused"); },
  });
  assert.equal(backend instanceof AgentBackend, true);
  assert.equal(backend.id, "shoggoth");
  assert.equal(backend.claimsAgentId("shoggoth-starting-profile"), true);
  assert.equal(backend.claimsAgentId("hermes-default"), false);
});

test("registry exposes fixed descriptors for external and peer native backends", () => {
  const registry = new BackendRegistry();
  const peerIds = new Set([
    "shoggoth-codex", "shoggoth-grok", "shoggoth-antigravity", "shoggoth-pi",
    "shoggoth-claude-code", "shoggoth-deepseek-harness",
  ]);
  registry.register(new OpenClawBackend());
  registry.register(new HermesBackend());
  registry.register(nativeFacade({
    id: "shoggoth", name: "Shoggoth", connectionMode: "builtin-service",
    claimsAgentId: (agentId) => typeof agentId === "string"
      && agentId.startsWith("shoggoth-") && !peerIds.has(agentId),
  }));
  registry.register(nativeFacade({
    id: "codex", name: "Codex", connectionMode: "native-runtime",
    claimsAgentId: (agentId) => agentId === "shoggoth-codex"
      || (typeof agentId === "string" && agentId.startsWith("codex-")),
  }));
  registry.register(nativeFacade({
    id: "grok-build", name: "Grok", connectionMode: "native-runtime",
    claimsAgentId: (agentId) => agentId === "shoggoth-grok"
      || (typeof agentId === "string" && agentId.startsWith("grok-")),
  }));
  registry.register(nativeFacade({
    id: "antigravity", name: "Antigravity", connectionMode: "native-runtime",
    claimsAgentId: (agentId) => agentId === "shoggoth-antigravity"
      || (typeof agentId === "string" && agentId.startsWith("antigravity-")),
  }));
  registry.register(nativeFacade({
    id: "pi", name: "Pi", connectionMode: "native-runtime",
    claimsAgentId: (agentId) => agentId === "shoggoth-pi"
      || (typeof agentId === "string" && agentId.startsWith("pi-")),
  }));
  registry.register(nativeFacade({
    id: "claude-code", name: "Claude Code", connectionMode: "native-runtime",
    claimsAgentId: (agentId) => agentId === "shoggoth-claude-code"
      || (typeof agentId === "string" && agentId.startsWith("claude-code-")),
  }));
  registry.register(nativeFacade({
    id: "deepseek-harness", name: "DeepSeek Harness", connectionMode: "native-runtime",
    claimsAgentId: (agentId) => agentId === "shoggoth-deepseek-harness"
      || (typeof agentId === "string" && agentId.startsWith("deepseek-harness-")),
  }));

  const descriptors = registry.listBackendDescriptors();
  assert.deepEqual(descriptors.map(({ id, name, connectionMode, disconnectable }) => ({
    id, name, connectionMode, disconnectable,
  })), [
    { id: "openclaw", name: "OpenClaw", connectionMode: "gateway", disconnectable: true },
    { id: "hermes", name: "Hermes", connectionMode: "managed-service", disconnectable: true },
    { id: "shoggoth", name: "Shoggoth", connectionMode: "builtin-service", disconnectable: true },
    { id: "codex", name: "Codex", connectionMode: "native-runtime", disconnectable: true },
    { id: "grok-build", name: "Grok", connectionMode: "native-runtime", disconnectable: true },
    { id: "antigravity", name: "Antigravity", connectionMode: "native-runtime", disconnectable: true },
    { id: "pi", name: "Pi", connectionMode: "native-runtime", disconnectable: true },
    { id: "claude-code", name: "Claude Code", connectionMode: "native-runtime", disconnectable: true },
    { id: "deepseek-harness", name: "DeepSeek Harness", connectionMode: "native-runtime", disconnectable: true },
  ]);
  assert.deepEqual(descriptors.find(({ id }) => id === "codex").surfaces, {
    chat: true, agents: true, models: true, skills: true, usage: true, oauth: true,
    dashboardRuns: true, agentHarness: true,
    cron: { kind: "native" }, kanban: { kind: "native" },
  });
  assert.deepEqual(descriptors.find(({ id }) => id === "codex").agentLifecycle, {
    create: true, update: true, remove: false, archive: true, restore: true, readStates: true,
  });
  for (const remaining of descriptors) {
    registry.setDisabledBackendsProvider(() => descriptors.filter(({ id }) => id !== remaining.id).map(({ id }) => id));
    assert.deepEqual(registry._activeBackends().map(({ id }) => id), [remaining.id]);
    for (const { id } of descriptors) {
      assert.equal(registry.getBackend(id)?.id || null, id === remaining.id ? id : null);
    }
  }
});

test("peer native facade agent namespaces are mutually exclusive", () => {
  const peerIds = new Set([
    "shoggoth-codex", "shoggoth-grok", "shoggoth-antigravity", "shoggoth-pi",
    "shoggoth-claude-code", "shoggoth-deepseek-harness",
  ]);
  const backends = [
    nativeFacade({
      id: "shoggoth", name: "Shoggoth", connectionMode: "builtin-service",
      claimsAgentId: (agentId) => typeof agentId === "string"
        && agentId.startsWith("shoggoth-") && !peerIds.has(agentId),
    }),
    nativeFacade({
      id: "codex", name: "Codex", connectionMode: "native-runtime",
      claimsAgentId: (agentId) => agentId === "shoggoth-codex"
        || (typeof agentId === "string" && agentId.startsWith("codex-")),
    }),
    nativeFacade({
      id: "grok-build", name: "Grok", connectionMode: "native-runtime",
      claimsAgentId: (agentId) => agentId === "shoggoth-grok"
        || (typeof agentId === "string" && agentId.startsWith("grok-")),
    }),
    nativeFacade({
      id: "antigravity", name: "Antigravity", connectionMode: "native-runtime",
      claimsAgentId: (agentId) => agentId === "shoggoth-antigravity"
        || (typeof agentId === "string" && agentId.startsWith("antigravity-")),
    }),
    nativeFacade({
      id: "pi", name: "Pi", connectionMode: "native-runtime",
      claimsAgentId: (agentId) => agentId === "shoggoth-pi"
        || (typeof agentId === "string" && agentId.startsWith("pi-")),
    }),
    nativeFacade({
      id: "claude-code", name: "Claude Code", connectionMode: "native-runtime",
      claimsAgentId: (agentId) => agentId === "shoggoth-claude-code"
        || (typeof agentId === "string" && agentId.startsWith("claude-code-")),
    }),
    nativeFacade({
      id: "deepseek-harness", name: "DeepSeek Harness", connectionMode: "native-runtime",
      claimsAgentId: (agentId) => agentId === "shoggoth-deepseek-harness"
        || (typeof agentId === "string" && agentId.startsWith("deepseek-harness-")),
    }),
  ];
  for (const agentId of [
    "shoggoth-default", "shoggoth-codex", "shoggoth-grok", "shoggoth-antigravity",
    "shoggoth-pi", "shoggoth-claude-code", "shoggoth-deepseek-harness",
    "codex-11111111-1111-8111-8111-111111111111",
    "grok-22222222-2222-8222-8222-222222222222",
    "antigravity-33333333-3333-8333-8333-333333333333",
    "pi-44444444-4444-8444-8444-444444444444",
    "claude-code-55555555-5555-8555-8555-555555555555",
    "deepseek-harness-66666666-6666-8666-8666-666666666666",
  ]) {
    assert.equal(backends.filter((backend) => backend.claimsAgentId(agentId)).length, 1, agentId);
  }
});

test("async resource owner resolution requires exactly one authoritative claimant", async () => {
  const registry = new BackendRegistry();
  const ownedBy = new Map([["one", new Set(["single", "ambiguous"])], ["two", new Set(["ambiguous"])]]);
  for (const id of ["one", "two"]) {
    registry.register({
      id,
      name: id,
      async ownsResourceId(kind, resourceId) {
        return kind === "kanban" && ownedBy.get(id).has(resourceId);
      },
    });
  }
  assert.equal((await registry.resolveResourceOwner("kanban", "single"))?.id, "one");
  assert.equal(await registry.resolveResourceOwner("kanban", "missing"), null);
  assert.equal(await registry.resolveResourceOwner("kanban", "ambiguous"), null);
});

test("Electron composition root registers all native facades over one Service host", () => {
  const source = fs.readFileSync(UI_ENTRY, "utf8");
  assert.match(
    source,
    /const\s*\{\s*ShoggothBackend\s*\}\s*=\s*require\("\.\/core\/shoggoth-backend"\)/,
  );
  assert.match(
    source,
    /const\s*\{\s*resolveServicePaths\s*\}\s*=\s*require\("\.\/agent-service\/paths"\)/,
  );
  assert.match(
    source,
    /const\s+shoggothServicePaths\s*=\s*resolveServicePaths\(\{[\s\S]*?homeDir:\s*os\.homedir\(\)[\s\S]*?userDataRoot:\s*app\.getPath\("userData"\)[\s\S]*?\}\)/,
  );
  assert.match(
    source,
    /const\s+nativeBackendOptions\s*=\s*\{[\s\S]*?paths:\s*shoggothServicePaths,[\s\S]*?runtimeCliAuth,[\s\S]*?\};/,
  );
  for (const [variable, id, name, mode] of [
    ["shoggothBackend", "shoggoth", "Shoggoth", "builtin-service"],
    ["codexBackend", "codex", "Codex", "native-runtime"],
    ["grokBackend", "grok-build", "Grok", "native-runtime"],
    ["antigravityBackend", "antigravity", "Antigravity", "native-runtime"],
    ["piBackend", "pi", "Pi", "native-runtime"],
    ["claudeCodeBackend", "claude-code", "Claude Code", "native-runtime"],
    ["deepSeekHarnessBackend", "deepseek-harness", "DeepSeek Harness", "native-runtime"],
  ]) {
    assert.match(source, new RegExp(
      `const\\s+${variable}\\s*=\\s*new\\s+ShoggothBackend\\(\\{[\\s\\S]*?id:\\s*"${id}"[\\s\\S]*?name:\\s*"${name}"[\\s\\S]*?connectionMode:\\s*"${mode}"[\\s\\S]*?\\}\\);`,
    ));
    assert.match(source, new RegExp(`registry\\.register\\(${variable}\\)`));
  }
  assert.match(source, /const\s+nativeBackends\s*=\s*\[\s*shoggothBackend,\s*codexBackend,\s*grokBackend,\s*antigravityBackend,\s*piBackend,\s*claudeCodeBackend,\s*deepSeekHarnessBackend,?\s*\]/);
  assert.match(source, /Promise\.all\(nativeBackends\.map\(\(backend\)\s*=>\s*backend\.stop\(\)\)\)/);
  assert.match(source, /nativeBackends\.filter\(\(backend\) => !disabled\.has\(backend\.id\)\)/);
  assert.match(source, /backend\.getBackendDescriptor\(\)\?\.disconnectable\s*===\s*true/);
  assert.match(source, /if\s*\(!disconnectable\)\s*continue/);
  const registerAt = source.indexOf("registry.register(deepSeekHarnessBackend)");
  const disabledProviderAt = source.indexOf("registry.setDisabledBackendsProvider");
  assert.ok(registerAt >= 0, "all native facades must be registered");
  assert.ok(disabledProviderAt > registerAt, "native facades must use the generic disabledBackends provider");
  assert.equal((source.match(/createLaunchAgentController\s*\(/g) || []).length, 1);
  assert.doesNotMatch(source, /(?:shoggoth|codex|grok|antigravity|pi|claudeCode|deepSeekHarness)Backend\.(?:stopService|shutdownService|terminateService)\s*\(/);
});

test("Electron startup fails closed when the federating proxy cannot bind", () => {
  const source = fs.readFileSync(UI_ENTRY, "utf8");
  const proxyStart = source.indexOf("gatewayProxy = await startProxyGateway");
  const registryStart = source.indexOf("registry.start()", proxyStart);
  assert.ok(proxyStart >= 0 && registryStart > proxyStart, "expected proxy startup before backend warm-up");
  const startupBlock = source.slice(proxyStart, registryStart);
  assert.doesNotMatch(startupBlock, /using direct gateway|fall back to\s+a direct connection/i);
  assert.match(startupBlock, /catch(?:\s*\([^)]*\))?\s*\{[\s\S]*?app\.quit\(\);[\s\S]*?return;/);
});

test("desktop bootstrap still isolates the Service role from UI adapters", () => {
  const source = fs.readFileSync(path.join(ROOT, "app", "bootstrap-role.js"), "utf8");
  assert.match(source, /role === "ui"/);
  assert.match(source, /role === "agent-service"/);
  assert.doesNotMatch(source, /require\("\.\/core\/shoggoth-backend"\)/);
});
