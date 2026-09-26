#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const {
  BINDING_AGENT_PROFILE_FIELDS,
  MCP_TOOL_CALL_FIELDS,
  MODEL_PROVIDER_FIELDS,
  RUN_NOTE_FIELDS,
  WORK_RUN_FIELDS,
  STORE_SCHEMA_VERSION,
} = require(path.join(ROOT, "app", "agent-service", "product-store.js"));
const {
  RUNTIME_ACCOUNT_FIELDS,
  RUNTIME_ACCOUNT_SCHEMA,
} = require(path.join(ROOT, "app", "agent-service", "runtime-account.js"));
const {
  BINDING_FIELDS,
  CREATE_OPERATION_FIELDS,
  REMOTE_OPERATION_FIELDS,
  SESSION_FIELDS,
  RUNTIME_SWITCH_FIELDS,
  CHAT_SESSION_STORE_VERSION,
} = require(path.join(ROOT, "app", "agent-service", "chat-session-store.js"));
const { BINDING_FIELDS: AGENT_BINDING_FIELDS, PROJECTED_RUNTIME_FIELDS } = require(
  path.join(ROOT, "app", "agent-service", "agent-runtime-binding.js"),
);
const { RECORD_FIELDS, STORE_VERSION: USAGE_STORE_VERSION } = require(
  path.join(ROOT, "app", "agent-service", "token-usage-store.js"),
);
const {
  DATA_AUTHORITY_MANIFEST,
  flattenRecordFields,
  validateDataAuthorityManifest,
} = require(path.join(ROOT, "app", "agent-service", "data-authority-manifest.js"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

test("权威清单 schema 完整且所有字段恰好归入一个分类", () => {
  assert.equal(validateDataAuthorityManifest(DATA_AUTHORITY_MANIFEST), true);
  for (const store of Object.values(DATA_AUTHORITY_MANIFEST.stores)) {
    for (const record of Object.values(store.records || {})) {
      const flattened = flattenRecordFields(record);
      assert.equal(new Set(flattened).size, flattened.length);
    }
  }
});

test("插件账本和密文容器各自持有 Connection 与凭据权威", () => {
  const pluginStore = DATA_AUTHORITY_MANIFEST.stores.plugins;
  assert.equal(pluginStore.schemaVersion,
    require("../app/agent-service/plugin-store").PLUGIN_STORE_SCHEMA_VERSION);
  assert.deepEqual(pluginStore.records.PluginConnection.authority,
    ["connectionId", "installationId", "componentId", "endpointIdentity",
      "principalIdentity", "credentialRef", "state", "authRevision", "revision"]);
  assert.deepEqual(pluginStore.records.PluginBinding.authority,
    ["bindingId", "subjectKind", "subjectId", "installationId", "componentId",
      "componentKind", "connectionId", "enabled", "revision"]);
  assert.ok(pluginStore.records.PluginGrant.authority.includes("epoch"));
  assert.ok(pluginStore.records.PluginCapabilityCall.authority.includes("phase"));
  assert.equal(pluginStore.pathRules.includes("stateDir/encrypted-secrets.json"), false);
  const secrets = DATA_AUTHORITY_MANIFEST.stores.encryptedSecrets;
  assert.deepEqual(secrets.pathRules, ["stateDir/encrypted-secrets.json"]);
  assert.deepEqual(secrets.records.EncryptedCredential.authority,
    ["credentialRef", "kind", "ciphertext"]);
});

test("Product15、Chat8、Usage2 与权威清单版本一致", () => {
  assert.equal(DATA_AUTHORITY_MANIFEST.stores.product.schemaVersion, STORE_SCHEMA_VERSION);
  assert.equal(DATA_AUTHORITY_MANIFEST.stores.chatSession.schemaVersion, CHAT_SESSION_STORE_VERSION);
  assert.equal(DATA_AUTHORITY_MANIFEST.stores.tokenUsage.schemaVersion, USAGE_STORE_VERSION);
  assert.equal(DATA_AUTHORITY_MANIFEST.stores.conversationCheckpoint.schemaVersion,
    require("../app/agent-service/conversation-checkpoint-store").CHECKPOINT_VERSION);
  assert.ok(flattenRecordFields(DATA_AUTHORITY_MANIFEST.stores.conversationCheckpoint.records.ConversationCheckpoint).includes("partial"));
  assert.match(DATA_AUTHORITY_MANIFEST.transcript.contextContentStore, /context-content\/.*sha256/u);
});

test("Product、ChatSession、Usage 的必需及可选字段和权威清单逐项一致", () => {
  const actual = {
    RuntimeAccount: [...RUNTIME_ACCOUNT_FIELDS, ...RUNTIME_ACCOUNT_SCHEMA.optionalFields],
    AgentProfile: BINDING_AGENT_PROFILE_FIELDS,
    AgentRuntimeBinding: AGENT_BINDING_FIELDS,
    AgentProfileRuntimeProjection: PROJECTED_RUNTIME_FIELDS,
    ModelProvider: [...MODEL_PROVIDER_FIELDS, "models", "revision"],
    WorkRun: WORK_RUN_FIELDS,
    RunNote: RUN_NOTE_FIELDS,
    McpToolCall: MCP_TOOL_CALL_FIELDS,
    ChatSession: [...SESSION_FIELDS, "modelSettings"],
    ChatBindingOperation: BINDING_FIELDS,
    ChatRemoteOperation: REMOTE_OPERATION_FIELDS,
    ChatCreateOperation: CREATE_OPERATION_FIELDS,
    ChatRuntimeSwitchReceipt: RUNTIME_SWITCH_FIELDS,
    TokenUsage: RECORD_FIELDS,
  };
  const declared = {
    ...DATA_AUTHORITY_MANIFEST.stores.product.records,
    ...DATA_AUTHORITY_MANIFEST.stores.chatSession.records,
    ...DATA_AUTHORITY_MANIFEST.stores.tokenUsage.records,
  };
  assert.deepEqual(sorted(Object.keys(declared)), sorted(Object.keys(actual)));
  for (const [name, fields] of Object.entries(actual)) {
    assert.deepEqual(sorted(flattenRecordFields(declared[name])), sorted(fields), name);
  }
});

test("RuntimeAccount 全部字段属于 Product authority", () => {
  const record = DATA_AUTHORITY_MANIFEST.stores.product.records.RuntimeAccount;
  assert.deepEqual(record.authority, [...RUNTIME_ACCOUNT_FIELDS, ...RUNTIME_ACCOUNT_SCHEMA.optionalFields]);
  assert.deepEqual(record.runtimeCache, []);
  assert.deepEqual(record.derived, []);
  assert.deepEqual(record.uiCache, []);
});

test("Agent provider/model 属于 Agent authority，runtime 三字段只由 Binding 投影", () => {
  const record = DATA_AUTHORITY_MANIFEST.stores.product.records.AgentProfile;
  assert.deepEqual(record.derived, []);
  assert.equal(record.authority.includes("runtimeAccountId"), false);
  assert.equal(record.authority.includes("providerRef"), true);
  assert.equal(record.authority.includes("defaultBindingId"), true);
  const projection = DATA_AUTHORITY_MANIFEST.stores.product.records.AgentProfileRuntimeProjection;
  assert.deepEqual(projection.authority, []);
  assert.deepEqual(projection.derived, PROJECTED_RUNTIME_FIELDS);
});

test("Product Core 持久 schema 不含 Codex 专属字段", () => {
  const productRecords = DATA_AUTHORITY_MANIFEST.stores.product.records;
  const actualCodexFields = Object.values(productRecords)
    .flatMap(flattenRecordFields)
    .filter((field) => /^codex[A-Z]/u.test(field));
  assert.deepEqual(sorted(actualCodexFields), []);
  assert.deepEqual(
    sorted(productRecords.WorkRun.runtimeCache),
    ["runtimeSessionRef", "runtimeTurnRef"],
  );
});

test("当前 Transcript 与各 Runtime home 的真实 owner 被显式记录", () => {
  assert.deepEqual(DATA_AUTHORITY_MANIFEST.transcript, {
    owner: "shoggoth",
    classification: "authority",
    source: "TranscriptStore",
    runtimeSource: "thread/read reconciliation/import only",
    shoggothStore: "agents/<profileId>/transcripts/<sessionId>",
    contextContentStore: "agents/<profileId>/transcripts/<sessionId>/context-content/<sha256>.json",
  });
  const runtimeHomes = DATA_AUTHORITY_MANIFEST.runtime;
  assert.deepEqual(Object.fromEntries([
    "codexHome", "nativeCodexHome", "grokBuildHome", "antigravityHome",
    "piHome", "claudeCodeHome", "deepSeekHarnessHome", "deepSeekHarnessIntegration",
  ].map((name) => [name, {
    owner: runtimeHomes[name].owner,
    classification: runtimeHomes[name].classification,
    rootRule: runtimeHomes[name].rootRule,
    backupRequired: runtimeHomes[name].backupRequired,
  }])), {
    codexHome: {
      owner: "shoggoth", classification: "authority",
      rootRule: "runtimeAccountsDir/codex/<runtimeAccountId>/home",
      backupRequired: true,
    },
    nativeCodexHome: {
      owner: "codex", classification: "externalAuthority",
      rootRule: "CODEX_HOME || ~/.codex", backupRequired: false,
    },
    grokBuildHome: {
      owner: "grok-build", classification: "externalAuthority",
      rootRule: "GROK_HOME || ~/.grok", backupRequired: false,
    },
    antigravityHome: {
      owner: "shoggoth", classification: "derivedIntegration",
      rootRule: "runtimeIntegrationDir/antigravity/<runtimeAccountId>/home",
      backupRequired: false,
    },
    piHome: {
      owner: "pi", classification: "externalAuthority",
      rootRule: "PI_CODING_AGENT_DIR || ~/.pi/agent", backupRequired: false,
    },
    claudeCodeHome: {
      owner: "claude-code", classification: "externalAuthority",
      rootRule: "CLAUDE_CONFIG_DIR || ~/.claude", backupRequired: false,
    },
    deepSeekHarnessHome: {
      owner: "deepseek-harness", classification: "externalAuthority",
      rootRule: "DSH_HOME || ~/.dsh", backupRequired: false,
    },
    deepSeekHarnessIntegration: {
      owner: "shoggoth", classification: "derivedIntegration",
      rootRule: "runtimeIntegrationDir/deepseek-harness/<runtimeAccountId>",
      backupRequired: false,
    },
  });
  assert.match(runtimeHomes.codexHome.credentialPolicy, /one managed Home/u);
  assert.match(runtimeHomes.codexHome.credentialPolicy, /never in shared auth\.json/u);
  assert.match(runtimeHomes.nativeCodexHome.credentialPolicy, /system Codex CLI/u);
  assert.match(runtimeHomes.grokBuildHome.credentialPolicy, /never copied/u);
  assert.equal(DATA_AUTHORITY_MANIFEST.runtime.grokBuildLedger.owner, "shoggoth");
  assert.equal(DATA_AUTHORITY_MANIFEST.runtime.grokBuildLedger.backupRequired, true);
  assert.deepEqual(DATA_AUTHORITY_MANIFEST.runtime.antigravityHome.excludedRuntimeCaches, [
    "runtimeIntegrationDir/antigravity/<runtimeAccountId>/home/.gemini/antigravity-cli/cli.log",
    "runtimeIntegrationDir/antigravity/<runtimeAccountId>/home/.gemini/antigravity-cli/log",
  ]);
  assert.match(DATA_AUTHORITY_MANIFEST.runtime.antigravityHome.credentialPolicy, /native ~\/\.gemini is never rewritten/u);
  assert.equal(DATA_AUTHORITY_MANIFEST.runtime.antigravityLedger.owner, "shoggoth");
  assert.equal(DATA_AUTHORITY_MANIFEST.runtime.antigravityLedger.backupRequired, true);
  assert.match(runtimeHomes.piHome.credentialPolicy, /never copied/u);
  assert.equal(DATA_AUTHORITY_MANIFEST.runtime.piLedger.owner, "shoggoth");
  assert.equal(DATA_AUTHORITY_MANIFEST.runtime.piLedger.backupRequired, true);
  assert.match(runtimeHomes.claudeCodeHome.credentialPolicy, /OS keychain/u);
  assert.equal(DATA_AUTHORITY_MANIFEST.runtime.claudeCodeLedger.owner, "shoggoth");
  assert.equal(DATA_AUTHORITY_MANIFEST.runtime.claudeCodeLedger.backupRequired, true);
  assert.match(runtimeHomes.deepSeekHarnessHome.credentialPolicy, /unmodified/u);
  assert.equal(DATA_AUTHORITY_MANIFEST.runtime.deepSeekHarnessLedger.owner, "shoggoth");
  assert.equal(DATA_AUTHORITY_MANIFEST.runtime.deepSeekHarnessLedger.backupRequired, true);
  assert.equal(DATA_AUTHORITY_MANIFEST.definition.owner, "shoggoth");
  assert.equal(DATA_AUTHORITY_MANIFEST.definition.source, "AgentDefinitionStore");
  assert.deepEqual(DATA_AUTHORITY_MANIFEST.definition.generatedViews, [
    "USER.md", "TOOLS.md", "MEMORY.md",
  ]);
  assert.equal(DATA_AUTHORITY_MANIFEST.memory.owner, "shoggoth");
  assert.equal(DATA_AUTHORITY_MANIFEST.memory.source, "MemoryStore");
  assert.equal(DATA_AUTHORITY_MANIFEST.memory.runtimeSource, "Shoggoth MemoryEngine");
  assert.equal(DATA_AUTHORITY_MANIFEST.skills.owner, "shoggoth");
  assert.equal(DATA_AUTHORITY_MANIFEST.skills.source, "NativeSkillStore");
  assert.match(DATA_AUTHORITY_MANIFEST.skills.runtimeProjection, /no Runtime Home materialization/u);
  assert.equal(DATA_AUTHORITY_MANIFEST.mcpExtensions.owner, "shoggoth");
  assert.equal(DATA_AUTHORITY_MANIFEST.mcpExtensions.source, "NativeMcpStore");
  assert.match(DATA_AUTHORITY_MANIFEST.mcpExtensions.runtimeProjection, /OpenClaw\/Hermes/u);
  assert.match(DATA_AUTHORITY_MANIFEST.mcpExtensions.externalOwnership, /remains independent/u);
  assert.equal(DATA_AUTHORITY_MANIFEST.computer.owner, "shoggoth");
  assert.match(DATA_AUTHORITY_MANIFEST.computer.artifacts, /^computer\/artifacts/u);
  assert.match(DATA_AUTHORITY_MANIFEST.computer.ephemeralSessions, /excluded from backup/u);
  assert.match(DATA_AUTHORITY_MANIFEST.computer.driver, /never user authority/u);
  assert.equal(DATA_AUTHORITY_MANIFEST.upgrade.owner, "shoggoth");
  assert.equal(DATA_AUTHORITY_MANIFEST.upgrade.switchJournal, "runtimeSwitchPath");
  assert.deepEqual(
    Object.fromEntries(Object.entries(DATA_AUTHORITY_MANIFEST.backends)
      .map(([id, boundary]) => [id, boundary.owner])),
    { shoggoth: "shoggoth", openclaw: "openclaw", hermes: "hermes" },
  );
  assert.equal(DATA_AUTHORITY_MANIFEST.backends.openclaw.rootRule, "OPENCLAW_HOME || ~/.openclaw");
  assert.equal(DATA_AUTHORITY_MANIFEST.backends.hermes.rootRule, "HERMES_HOME || ~/.hermes");
});

(async () => {
  for (const { name, fn } of tests) {
    await fn();
    console.log(`PASS ${name}`);
  }
  console.log(`PASS shoggoth authority boundary unit (${tests.length})`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
