#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-federation-isolation-"));
fs.chmodSync(root, 0o700);
const openclawRoot = path.join(root, "openclaw");
const hermesRoot = path.join(root, "hermes");
fs.mkdirSync(openclawRoot, { mode: 0o700 });
fs.mkdirSync(hermesRoot, { mode: 0o700 });
fs.writeFileSync(path.join(openclawRoot, "sentinel.json"), "{\"owner\":\"openclaw\"}\n", { mode: 0o600 });
fs.writeFileSync(path.join(hermesRoot, "sentinel.json"), "{\"owner\":\"hermes\"}\n", { mode: 0o600 });

function digestTree(target) {
  const hash = crypto.createHash("sha256");
  function visit(current, relative = "") {
    for (const name of fs.readdirSync(current).sort()) {
      const absolute = path.join(current, name);
      const child = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(absolute);
      hash.update(`${child}\0${stat.mode & 0o777}\0`);
      if (stat.isDirectory()) visit(absolute, child);
      else hash.update(fs.readFileSync(absolute));
    }
  }
  visit(target);
  return hash.digest("hex");
}

const before = { openclaw: digestTree(openclawRoot), hermes: digestTree(hermesRoot) };
try {
  const { BackendRegistry } = require("../app/core/backend-registry");
  const { FederationHostClient } = require("../app/agent-service/federation-host-client");
  const { buildCodexSpawnEnv, prepareCodexHome } = require("../app/agent-service/codex-runtime-paths");
  const { resolveServicePaths } = require("../app/agent-service/paths");
  const { DEFAULT_TOOL_REGISTRY } = require("../app/agent-service/mcp-product-tool-controller");
  const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");
  const paths = resolveServicePaths({
    trustedRoot: root,
    stateRoot: path.join(root, "shoggoth-state"),
    profileRoot: path.join(root, "shoggoth-profile"),
    cacheRoot: path.join(root, "shoggoth-cache"),
  });
  fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
  const client = new FederationHostClient({ paths, timeoutMs: 100 });
  await assert.rejects(client.request("backend.status", {}), (error) => (
    ["APP_HOST_UNAVAILABLE", "ENOENT", "ECONNREFUSED"].includes(error.code)
  ));
  const publicCapabilities = DEFAULT_TOOL_REGISTRY.publicProjection();
  assert.equal(publicCapabilities.lifecycle.nativeWhenAppQuit, true);
  assert.equal(publicCapabilities.lifecycle.federationRequiresAppProcess, true);
  assert.equal(publicCapabilities.lifecycle.federationUnavailableCode, "APP_HOST_UNAVAILABLE");
  const federationTools = publicCapabilities.capabilities
    .filter((tool) => tool.domain === "federation")
    .map((tool) => tool.tool);
  assert.equal(federationTools.includes("federation_agent_list"), true);
  assert.equal(federationTools.every((tool) => (
    tool === "backend_status" || tool.startsWith("federation_") || tool.startsWith("external_")
  )), true);
  for (const hidden of ["external_agent_list", "external_agent_get", "external_agent_run"]) {
    assert.equal(federationTools.includes(hidden), false);
  }
  assert.deepEqual(
    { openclaw: digestTree(openclawRoot), hermes: digestTree(hermesRoot) },
    before,
    "App Host 缺失时不得直接写外部 Backend 目录",
  );
  console.log("PASS Federation 明确 ui-required，Host 缺失 fail closed，外部目录摘要不变");

  // Registry 只按各 Backend 的 ownership/namespace 路由；一个 Backend 的读取失败
  // 不得让另外两个 Backend 的模型目录一起失败。
  const registry = new BackendRegistry();
  const fakeBackend = (id, prefix, modelId, failModels = false) => ({
    id,
    name: id,
    ownsAgentId: (agentId) => agentId === `${prefix}ready`,
    claimsAgentId: (agentId) => agentId.startsWith(prefix),
    getAgents: () => [{ id: `${prefix}ready`, name: id }],
    getModelChoices: () => [],
    getModels: async () => {
      if (failModels) throw new Error(`${id} offline`);
      return [{ id: modelId, name: modelId, provider: id, backendId: id }];
    },
  });
  const openclaw = fakeBackend("openclaw", "openclaw-fixture-", "openclaw-model");
  const hermes = fakeBackend("hermes", "hermes-", "hermes-model", true);
  const shoggoth = fakeBackend("shoggoth", "shoggoth-", "shoggoth-model");
  registry.register(openclaw);
  registry.register(hermes);
  registry.register(shoggoth);
  assert.equal(registry.route("openclaw-fixture-ready"), openclaw);
  assert.equal(registry.route("hermes-ready"), hermes);
  assert.equal(registry.route("shoggoth-ready"), shoggoth);
  assert.equal(registry.claimsAgentId("hermes-offline"), true);
  assert.equal(registry.claimsAgentId("shoggoth-offline"), true);
  assert.equal(registry.route("hermes-offline"), null);
  assert.deepEqual((await registry.listModels()).map((row) => row.id).sort(), [
    "openclaw-model", "shoggoth-model",
  ]);
  console.log("PASS 三 Backend namespace 独立路由，Hermes 故障不拖垮 OpenClaw/Shoggoth 聚合");

  // 同一 Shoggoth Service 内的 Profile 也必须隔离 Definition/Memory/Transcript/
  // Context Snapshot 与 Tool override，不能只做到三 Backend 目录分开。
  const context = contextFixture();
  try {
    context.definitions.ensureProfile({ profileId: "profile-2" });
    const updateDefinition = (profileId, marker) => {
      const current = context.definitions.get(profileId);
      context.definitions.update({
        profileId,
        expectedRevision: current.manifest.revision,
        actor: "user",
        reason: "isolation-regression",
        documents: { IDENTITY: `# Identity\n\n${marker}` },
      });
    };
    updateDefinition("profile-1", "ALPHA_PROFILE_SENTINEL");
    updateDefinition("profile-2", "BETA_PROFILE_SENTINEL");
    context.memoryEngine.propose({
      profileId: "profile-1", classification: "explicit", scope: "user", type: "semantic",
      content: "shared alpha memory sentinel", sourceRefs: ["session-1:memory-alpha"],
    });
    context.memoryEngine.propose({
      profileId: "profile-2", classification: "explicit", scope: "user", type: "semantic",
      content: "shared beta memory sentinel", sourceRefs: ["session-2:memory-beta"],
    });
    context.append({ id: "alpha-old", kind: "user", content: { text: "shared alpha transcript sentinel" } });
    context.append({ id: "alpha-current", kind: "user", content: { text: "alpha current" } });
    for (const event of [
      { id: "beta-old", kind: "user", content: { text: "shared beta transcript sentinel" } },
      { id: "beta-current", kind: "user", content: { text: "beta current" } },
    ]) context.transcripts.appendEvent({
      profileId: "profile-2", sessionId: "session-2", runId: "run-2",
      runtimeRef: null, contextExcluded: false, occurredAt: 500, ...event,
    });
    const toolName = DEFAULT_TOOL_REGISTRY.list()[0].tool;
    context.permissions.setProfileOverride("profile-1", toolName, "deny", context.permissions.revision);
    assert.equal(context.permissions.profileProjection("profile-1").tools
      .find((tool) => tool.name === toolName).effect, "deny");
    assert.equal(context.permissions.profileProjection("profile-2").tools
      .find((tool) => tool.name === toolName).effect, "allow");

    const alpha = context.compiler.compile({ profile: context.profile, run: context.run, query: "shared" });
    const beta = context.compiler.compile({
      profile: {
        id: "profile-2",
        name: "Beta Agent",
        runtime: "codex",
        permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
      },
      run: {
        id: "run-2", source: "chat", sourceId: "session-2", profileId: "profile-2",
        workspace: "/tmp/context-workspace-2",
      },
      query: "shared",
    });
    assert.match(alpha.developerInstructions, /ALPHA_PROFILE_SENTINEL/u);
    assert.doesNotMatch(alpha.developerInstructions, /BETA_PROFILE_SENTINEL/u);
    assert.match(alpha.dynamicContext, /alpha memory sentinel/u);
    assert.match(alpha.dynamicContext, /alpha transcript sentinel/u);
    assert.doesNotMatch(alpha.dynamicContext, /beta (memory|transcript) sentinel/u);
    assert.match(beta.developerInstructions, /BETA_PROFILE_SENTINEL/u);
    assert.doesNotMatch(beta.developerInstructions, /ALPHA_PROFILE_SENTINEL/u);
    assert.match(beta.dynamicContext, /beta memory sentinel/u);
    assert.match(beta.dynamicContext, /beta transcript sentinel/u);
    assert.doesNotMatch(beta.dynamicContext, /alpha (memory|transcript) sentinel/u);
    assert.notEqual(alpha.profileId, beta.profileId);
    assert.equal(fs.existsSync(path.join(context.paths.agentsDir, "profile-1", "context-snapshots", `${alpha.id}.json`)), true);
    assert.equal(fs.existsSync(path.join(context.paths.agentsDir, "profile-2", "context-snapshots", `${beta.id}.json`)), true);
  } finally {
    context.cleanup();
  }
  console.log("PASS 多 Profile Definition/Memory/Transcript/Context/Tool 权限无交叉污染");

  // Runtime spawn 只继承最小 allowlist，并只合并当前 runtimeProfile 的显式 secret。
  // OpenClaw/Hermes token 与另一个 Shoggoth Profile 的 provider key 都不能泄漏。
  const alphaHome = prepareCodexHome(paths, "runtime-alpha");
  const betaHome = prepareCodexHome(paths, "runtime-beta");
  const parentEnv = {
    HOME: root,
    PATH: "/usr/bin:/bin",
    TMPDIR: os.tmpdir(),
    OPENCLAW_GATEWAY_TOKEN: "openclaw-secret-canary",
    HERMES_API_TOKEN: "hermes-secret-canary",
    SHOGGOTH_PROVIDER_OTHER_API_KEY: "other-profile-secret-canary",
  };
  const alphaEnv = buildCodexSpawnEnv({
    codexHome: alphaHome,
    parentEnv,
    spawnEnv: { SHOGGOTH_PROVIDER_ALPHA_API_KEY: "alpha-secret-canary" },
  });
  const betaEnv = buildCodexSpawnEnv({
    codexHome: betaHome,
    parentEnv,
    spawnEnv: { SHOGGOTH_PROVIDER_BETA_API_KEY: "beta-secret-canary" },
  });
  assert.equal(alphaEnv.OPENCLAW_GATEWAY_TOKEN, undefined);
  assert.equal(alphaEnv.HERMES_API_TOKEN, undefined);
  assert.equal(alphaEnv.SHOGGOTH_PROVIDER_OTHER_API_KEY, undefined);
  assert.equal(alphaEnv.SHOGGOTH_PROVIDER_BETA_API_KEY, undefined);
  assert.equal(betaEnv.SHOGGOTH_PROVIDER_ALPHA_API_KEY, undefined);
  assert.equal(alphaEnv.CODEX_HOME, alphaHome);
  assert.equal(betaEnv.CODEX_HOME, betaHome);
  assert.deepEqual(
    { openclaw: digestTree(openclawRoot), hermes: digestTree(hermesRoot) },
    before,
    "Runtime/Profile 操作不得修改 OpenClaw/Hermes authority",
  );
  console.log("PASS Runtime env/Profile home 隔离且外部 Backend authority 摘要保持不变");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
