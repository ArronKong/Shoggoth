#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { AgentDefinitionStore } = require("../app/agent-service/agent-definition-store");
const { restoreAuthorityBackup } = require("../app/agent-service/authority-backup");
const { ClaudeCodeRuntimeLedger } = require("../app/agent-service/claude-code-runtime-ledger");
const { prepareClaudeCodeHome } = require("../app/agent-service/claude-code-runtime-paths");
const { prepareCodexHome } = require("../app/agent-service/codex-runtime-paths");
const { DeepSeekHarnessRuntimeLedger } = require("../app/agent-service/deepseek-harness-runtime-ledger");
const { prepareDeepSeekHarnessHome } = require("../app/agent-service/deepseek-harness-runtime-paths");
const { MemoryEngine } = require("../app/agent-service/memory-engine");
const { MemoryStore } = require("../app/agent-service/memory-store");
const { NativeSkillStore } = require("../app/agent-service/native-skill-store");
const { DEFAULT_TOOL_REGISTRY } = require("../app/agent-service/mcp-product-tool-controller");
const { PermissionEngine } = require("../app/agent-service/permission-engine");
const { resolveServicePaths } = require("../app/agent-service/paths");
const {
  DEFAULT_AGENT_PROFILE_ID,
  JsonlProductStore,
} = require("../app/agent-service/product-store");
const { TranscriptStore } = require("../app/agent-service/transcript-store");
const {
  COMPONENTS,
  LEGACY_COMPONENTS_V1,
  createUpgradeSnapshot,
  verifyUpgradeSnapshot,
} = require("../app/agent-service/upgrade-snapshot");

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function buildAuthorityFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-upgrade-recovery-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({
    trustedRoot: root,
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
  });
  let time = 1000;
  const now = () => ++time;
  const product = new JsonlProductStore({ paths, now });
  product.open();
  const profile = product.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
  const definitions = new AgentDefinitionStore({
    paths,
    now,
    randomUUID: () => `00000000-0000-4000-8000-${String(++time).padStart(12, "0")}`,
  });
  definitions.open();
  definitions.ensureProfile({ profileId: profile.id });
  const current = definitions.get(profile.id);
  definitions.update({
    profileId: profile.id,
    expectedRevision: current.manifest.revision,
    actor: "user",
    reason: "upgrade-fixture",
    documents: { IDENTITY: "# Identity\n\nUPGRADE_DEFINITION_SENTINEL" },
  });
  const memoryStore = new MemoryStore({ paths });
  memoryStore.open();
  const memory = new MemoryEngine({
    store: memoryStore,
    definitionStore: definitions,
    now,
    randomUUID: () => `00000000-0000-4000-8001-${String(++time).padStart(12, "0")}`,
  });
  memory.open([profile.id]);
  memory.propose({
    profileId: profile.id,
    classification: "explicit",
    scope: "user",
    type: "semantic",
    content: "UPGRADE_MEMORY_SENTINEL",
    sourceRefs: ["session-upgrade:event-memory"],
  });
  const transcripts = new TranscriptStore({ paths, now, assertSecretSafe: () => true });
  transcripts.open();
  transcripts.appendEvent({
    profileId: profile.id,
    sessionId: "session-upgrade",
    id: "event-upgrade",
    runId: "run-upgrade",
    kind: "user",
    content: { text: "UPGRADE_TRANSCRIPT_SENTINEL" },
    runtimeRef: null,
    contextExcluded: false,
    occurredAt: now(),
  });
  const permissions = new PermissionEngine({ paths, toolRegistry: DEFAULT_TOOL_REGISTRY });
  permissions.open([profile.id]);
  const toolName = DEFAULT_TOOL_REGISTRY.list()[0].tool;
  permissions.setProfileOverride(profile.id, toolName, "deny", permissions.revision);
  const builtinRoot = path.join(root, "builtins");
  const sourceSkill = path.join(root, "source-skill");
  fs.mkdirSync(builtinRoot, { mode: 0o700 });
  fs.mkdirSync(sourceSkill, { mode: 0o700 });
  fs.writeFileSync(path.join(sourceSkill, "skill.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: "upgrade-skill",
    name: "upgrade-skill",
    version: "1.0.0",
    description: "UPGRADE_SKILL_SENTINEL",
    entry: "SKILL.md",
    requiredTools: [],
    requiredRuntimeCapabilities: [],
    sourceCompatibility: ["shoggoth", "codex"],
  })}\n`);
  fs.writeFileSync(path.join(sourceSkill, "SKILL.md"), "# UPGRADE_SKILL_SENTINEL\n");
  const skills = new NativeSkillStore({
    paths,
    builtinRoot,
    profileExists: (profileId) => profileId === profile.id,
    now,
  });
  skills.open([profile.id]);
  skills.installFromDirectory({
    sourcePath: sourceSkill,
    operationId: "upgrade-skill-install",
    expectedRevision: 1,
  });
  skills.setProfileSkill({
    profileId: profile.id,
    skillId: "upgrade-skill",
    source: "user",
    version: "1.0.0",
    enabled: true,
    expectedRevision: 1,
  });
  const retiredBrowserData = path.join(paths.stateDir, "browser", "legacy-sentinel.txt");
  fs.mkdirSync(path.dirname(retiredBrowserData), { recursive: true, mode: 0o700 });
  fs.writeFileSync(retiredBrowserData, "UPGRADE_RETIRED_BROWSER_DATA_SENTINEL\n", { mode: 0o600 });
  const computerArtifact = path.join(paths.computerArtifactsDir, "upgrade-profile", "snapshot.txt");
  fs.mkdirSync(path.dirname(computerArtifact), { recursive: true, mode: 0o700 });
  fs.writeFileSync(computerArtifact, "UPGRADE_COMPUTER_SENTINEL\n", { mode: 0o600 });
  const runtimeHome = prepareCodexHome(paths, profile.runtimeProfileId);
  fs.writeFileSync(path.join(runtimeHome, "auth.json"), "UPGRADE_MANAGED_AUTH_SENTINEL\n", { mode: 0o600 });
  fs.writeFileSync(path.join(runtimeHome, "config.toml"), "UPGRADE_MANAGED_CONFIG_SENTINEL\n", { mode: 0o600 });
  fs.writeFileSync(path.join(runtimeHome, "thread-fixture.jsonl"), "UPGRADE_RUNTIME_HOME_SENTINEL\n", { mode: 0o600 });
  const claudeCodeRuntimeProfileId = "upgrade-claude-code-runtime";
  const claudeCodeHome = prepareClaudeCodeHome(paths, claudeCodeRuntimeProfileId);
  fs.writeFileSync(path.join(claudeCodeHome, "upgrade-fixture.txt"),
    "UPGRADE_CLAUDE_CODE_HOME_SENTINEL\n", { mode: 0o600 });
  const claudeCodeWorkspaceShardId = "a".repeat(64);
  const claudeCodeLedger = new ClaudeCodeRuntimeLedger({
    stateRoot: path.join(paths.stateDir, "runtime-ledgers", "claude-code"),
    trustedRoot: paths.trustedRoot,
    runtimeProfileId: claudeCodeRuntimeProfileId,
    workspaceShardId: claudeCodeWorkspaceShardId,
    now,
  }).open();
  claudeCodeLedger.update((ledger) => {
    ledger.sessions.push({
      id: "00000000-0000-4000-8000-000000000001",
      remoteSessionId: "00000000-0000-4000-8000-000000000001",
      source: "upgrade-recovery-fixture",
      cwd: root,
      title: "UPGRADE_CLAUDE_CODE_LEDGER_SENTINEL",
      archived: false,
      createdAt: now(),
      updatedAt: time,
      turns: [],
    });
  });
  const deepSeekHarnessRuntimeProfileId = "upgrade-deepseek-harness-runtime";
  const deepSeekHarnessHome = prepareDeepSeekHarnessHome(paths, deepSeekHarnessRuntimeProfileId);
  fs.writeFileSync(path.join(deepSeekHarnessHome, "upgrade-fixture.txt"),
    "UPGRADE_DEEPSEEK_HARNESS_HOME_SENTINEL\n", { mode: 0o600 });
  const deepSeekHarnessWorkspaceShardId = "b".repeat(64);
  const deepSeekHarnessLedger = new DeepSeekHarnessRuntimeLedger({
    stateRoot: path.join(paths.stateDir, "runtime-ledgers", "deepseek-harness"),
    trustedRoot: paths.trustedRoot,
    runtimeProfileId: deepSeekHarnessRuntimeProfileId,
    workspaceShardId: deepSeekHarnessWorkspaceShardId,
  }).open();
  deepSeekHarnessLedger.update((ledger) => {
    ledger.sessions.push({
      id: "00000000-0000-4000-8000-000000000002",
      remoteSessionId: "00000000-0000-4000-8000-000000000002",
      source: "upgrade-recovery-deepseek-harness-fixture",
      cwd: root,
      title: "UPGRADE_DEEPSEEK_HARNESS_LEDGER_SENTINEL",
      archived: false,
      createdAt: now(),
      updatedAt: time,
      turns: [],
    });
  });

  transcripts.close();
  memory.close();
  memoryStore.close();
  definitions.close();
  permissions.close();
  skills.close();
  product.close();
  return {
    root,
    paths,
    profile,
    toolName,
    runtimeHome,
    builtinRoot,
    claudeCodeRuntimeProfileId,
    claudeCodeWorkspaceShardId,
    deepSeekHarnessRuntimeProfileId,
    deepSeekHarnessWorkspaceShardId,
  };
}

function verifyRestoredAuthority(root, stateDir, source) {
  const paths = resolveServicePaths({
    trustedRoot: root,
    stateRoot: stateDir,
    profileRoot: path.join(root, "restored-profile"),
    cacheRoot: path.join(root, "restored-cache"),
  });
  const product = new JsonlProductStore({ paths });
  const definitions = new AgentDefinitionStore({ paths });
  const memory = new MemoryStore({ paths });
  const transcripts = new TranscriptStore({ paths, assertSecretSafe: () => true });
  const permissions = new PermissionEngine({ paths, toolRegistry: DEFAULT_TOOL_REGISTRY });
  const skills = new NativeSkillStore({
    paths,
    builtinRoot: source.builtinRoot,
    profileExists: (profileId) => profileId === source.profile.id,
  });
  try {
    product.open();
    definitions.open();
    memory.open();
    transcripts.open();
    permissions.open([source.profile.id]);
    skills.open([source.profile.id]);
    assert.equal(product.getAgentProfile(source.profile.id).agentId, source.profile.agentId);
    assert.match(definitions.get(source.profile.id).documents.IDENTITY, /UPGRADE_DEFINITION_SENTINEL/u);
    assert.equal(memory.list(source.profile.id).some((item) => item.content === "UPGRADE_MEMORY_SENTINEL"), true);
    assert.equal(transcripts.listEvents(source.profile.id, "session-upgrade")[0].content.text,
      "UPGRADE_TRANSCRIPT_SENTINEL");
    assert.equal(permissions.profileProjection(source.profile.id).tools
      .find((tool) => tool.name === source.toolName).effect, "deny");
    assert.equal(skills.list(source.profile.id).items
      .some((skill) => skill.name === "upgrade-skill" && skill.enabled), true);
    assert.equal(fs.readFileSync(path.join(
      paths.stateDir, "browser", "legacy-sentinel.txt",
    ), "utf8"), "UPGRADE_RETIRED_BROWSER_DATA_SENTINEL\n");
    assert.equal(fs.readFileSync(path.join(
      paths.computerArtifactsDir, "upgrade-profile", "snapshot.txt",
    ), "utf8"), "UPGRADE_COMPUTER_SENTINEL\n");
    assert.equal(fs.readFileSync(path.join(
      paths.stateDir, "codex", source.profile.runtimeProfileId, "auth.json",
    ), "utf8"), "UPGRADE_MANAGED_AUTH_SENTINEL\n");
    assert.equal(fs.readFileSync(path.join(
      paths.stateDir, "codex", source.profile.runtimeProfileId, "config.toml",
    ), "utf8"), "UPGRADE_MANAGED_CONFIG_SENTINEL\n");
    assert.equal(fs.existsSync(path.join(
      paths.stateDir, "codex", source.profile.runtimeProfileId, "thread-fixture.jsonl",
    )), false);
    assert.equal(fs.existsSync(path.join(
      paths.stateDir, "claude-code", source.claudeCodeRuntimeProfileId,
    )), false);
    const claudeCodeLedger = new ClaudeCodeRuntimeLedger({
      stateRoot: path.join(paths.stateDir, "runtime-ledgers", "claude-code"),
      trustedRoot: paths.trustedRoot,
      runtimeProfileId: source.claudeCodeRuntimeProfileId,
      workspaceShardId: source.claudeCodeWorkspaceShardId,
    }).open();
    assert.equal(
      claudeCodeLedger.snapshot().sessions[0].title,
      "UPGRADE_CLAUDE_CODE_LEDGER_SENTINEL",
    );
    assert.equal(fs.existsSync(path.join(
      paths.stateDir, "deepseek-harness", source.deepSeekHarnessRuntimeProfileId,
    )), false);
    const deepSeekHarnessLedger = new DeepSeekHarnessRuntimeLedger({
      stateRoot: path.join(paths.stateDir, "runtime-ledgers", "deepseek-harness"),
      trustedRoot: paths.trustedRoot,
      runtimeProfileId: source.deepSeekHarnessRuntimeProfileId,
      workspaceShardId: source.deepSeekHarnessWorkspaceShardId,
    }).open();
    assert.equal(
      deepSeekHarnessLedger.snapshot().sessions[0].title,
      "UPGRADE_DEEPSEEK_HARNESS_LEDGER_SENTINEL",
    );
  } finally {
    try { skills.close(); } catch {}
    try { permissions.close(); } catch {}
    try { transcripts.close(); } catch {}
    try { memory.close(); } catch {}
    try { definitions.close(); } catch {}
    try { product.close(); } catch {}
  }
}

const fixture = buildAuthorityFixture();
try {
  const snapshot = createUpgradeSnapshot({
    paths: fixture.paths,
    generationId: "release-candidate-1",
    now: () => 2000,
  });
  assert.deepEqual(Object.keys(snapshot.manifest.components), COMPONENTS);
  for (const component of COMPONENTS) {
    assert.equal(snapshot.manifest.components[component].present, true, `${component} must be present`);
    assert.equal(snapshot.manifest.components[component].files.length > 0, true, component);
  }
  const runtimeHomeFiles = snapshot.manifest.components.runtimeHome.files.map((entry) => entry.path);
  assert.equal(runtimeHomeFiles.some((entry) => entry.endsWith("/auth.json")), true);
  assert.equal(runtimeHomeFiles.some((entry) => entry.endsWith("/config.toml")), true);
  assert.equal(runtimeHomeFiles.some((entry) => entry.startsWith("claude-code/")), false);
  assert.equal(runtimeHomeFiles.some((entry) => entry.startsWith("runtime-ledgers/claude-code/")), true);
  assert.equal(runtimeHomeFiles.some((entry) => entry.startsWith("deepseek-harness/")), false);
  assert.equal(runtimeHomeFiles.some((entry) => entry.startsWith("runtime-ledgers/deepseek-harness/")), true);
  assert.equal(verifyUpgradeSnapshot({
    paths: fixture.paths,
    generationId: "release-candidate-1",
  }).manifest.checksum, snapshot.manifest.checksum);
  const restoredState = path.join(fixture.root, "restored-state");
  restoreAuthorityBackup({
    paths: fixture.paths,
    backupId: snapshot.manifest.backupId,
    destinationStateDir: restoredState,
  });
  verifyRestoredAuthority(fixture.root, restoredState, fixture);
  console.log("PASS 同代 manifest 覆盖产品 authority、Runtime ledger 与 managed Codex 最小凭据配置");

  const legacySnapshot = createUpgradeSnapshot({
    paths: fixture.paths,
    generationId: "legacy-v1",
    now: () => 2500,
  });
  const legacyManifest = {
    ...legacySnapshot.manifest,
    schemaVersion: 1,
    components: Object.fromEntries(LEGACY_COMPONENTS_V1.map((name) => (
      [name, legacySnapshot.manifest.components[name]]
    ))),
  };
  const { checksum: _oldChecksum, ...legacyBody } = legacyManifest;
  legacyManifest.checksum = crypto.createHash("sha256").update(stable(legacyBody)).digest("hex");
  fs.writeFileSync(path.join(legacySnapshot.backupPath, "generation.json"),
    `${JSON.stringify(legacyManifest)}\n`, { mode: 0o600 });
  assert.equal(verifyUpgradeSnapshot({
    paths: fixture.paths, generationId: "legacy-v1",
  }).manifest.schemaVersion, 1);
  console.log("PASS 新版本仍可验证升级前的 v1 generation manifest");

  const crash = new Error("simulated generation manifest crash");
  assert.throws(() => createUpgradeSnapshot({
    paths: fixture.paths,
    generationId: "release-candidate-crash",
    now: () => 3000,
    checkpoint(point) { if (point === "before-generation-commit") throw crash; },
  }), (error) => error === crash);
  assert.throws(() => verifyUpgradeSnapshot({
    paths: fixture.paths,
    generationId: "release-candidate-crash",
  }), (error) => error.code === "UPGRADE_SNAPSHOT_INCOMPLETE");
  const repaired = createUpgradeSnapshot({
    paths: fixture.paths,
    generationId: "release-candidate-crash",
    now: () => 9999,
  });
  assert.equal(repaired.manifest.createdAt, 3000, "重试必须复用已提交 authority generation");
  console.log("PASS authority 已提交但 generation manifest 未切换时，重启可幂等补完同一代");

  const target = path.join(snapshot.backupPath, "generation.json");
  const tampered = JSON.parse(fs.readFileSync(target, "utf8"));
  tampered.components.memory.digest = "0".repeat(64);
  fs.writeFileSync(target, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
  assert.throws(() => verifyUpgradeSnapshot({
    paths: fixture.paths,
    generationId: "release-candidate-1",
  }), (error) => error.code === "UPGRADE_SNAPSHOT_CORRUPT");
  console.log("PASS generation manifest/组件摘要篡改 fail closed，不接受混代恢复");
  console.log("PASS shoggoth recovery regression (4)");
} finally {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}
