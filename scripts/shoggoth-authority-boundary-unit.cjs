#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const {
  AGENT_PROFILE_FIELDS,
  MCP_TOOL_CALL_FIELDS,
  MODEL_PROVIDER_FIELDS,
  RUN_NOTE_FIELDS,
  WORK_RUN_FIELDS,
} = require(path.join(ROOT, "app", "agent-service", "product-store.js"));
const {
  RUNTIME_ACCOUNT_FIELDS,
} = require(path.join(ROOT, "app", "agent-service", "runtime-account.js"));
const {
  BINDING_FIELDS,
  CREATE_OPERATION_FIELDS,
  REMOTE_OPERATION_FIELDS,
  SESSION_FIELDS,
} = require(path.join(ROOT, "app", "agent-service", "chat-session-store.js"));
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

test("Product Store 与 ChatSession 的真实字段和权威清单逐项一致", () => {
  const actual = {
    RuntimeAccount: RUNTIME_ACCOUNT_FIELDS,
    AgentProfile: AGENT_PROFILE_FIELDS,
    ModelProvider: MODEL_PROVIDER_FIELDS,
    WorkRun: WORK_RUN_FIELDS,
    RunNote: RUN_NOTE_FIELDS,
    McpToolCall: MCP_TOOL_CALL_FIELDS,
    ChatSession: SESSION_FIELDS,
    ChatBindingOperation: BINDING_FIELDS,
    ChatRemoteOperation: REMOTE_OPERATION_FIELDS,
    ChatCreateOperation: CREATE_OPERATION_FIELDS,
  };
  const declared = {
    ...DATA_AUTHORITY_MANIFEST.stores.product.records,
    ...DATA_AUTHORITY_MANIFEST.stores.chatSession.records,
  };
  assert.deepEqual(sorted(Object.keys(declared)), sorted(Object.keys(actual)));
  for (const [name, fields] of Object.entries(actual)) {
    assert.deepEqual(sorted(flattenRecordFields(declared[name])), sorted(fields), name);
  }
});

test("RuntimeAccount 全部字段属于 Product authority", () => {
  const record = DATA_AUTHORITY_MANIFEST.stores.product.records.RuntimeAccount;
  assert.deepEqual(record.authority, RUNTIME_ACCOUNT_FIELDS);
  assert.deepEqual(record.runtimeCache, []);
  assert.deepEqual(record.derived, []);
  assert.deepEqual(record.uiCache, []);
});

test("AgentProfile.providerRef 是 RuntimeAccount authority 的兼容投影", () => {
  const record = DATA_AUTHORITY_MANIFEST.stores.product.records.AgentProfile;
  assert.deepEqual(record.derived, ["providerRef"]);
  assert.equal(record.authority.includes("runtimeAccountId"), true);
  assert.equal(record.authority.includes("providerRef"), false);
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
      rootRule: "runtimeAccountsDir/codex/<runtimeAccountId>/home (legacy default canonical may remain in place)",
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
  assert.match(DATA_AUTHORITY_MANIFEST.memory.runtimeSource, /read-only/u);
  assert.equal(DATA_AUTHORITY_MANIFEST.skills.owner, "shoggoth");
  assert.equal(DATA_AUTHORITY_MANIFEST.skills.source, "NativeSkillStore");
  assert.match(DATA_AUTHORITY_MANIFEST.skills.runtimeProjection, /no Runtime Home materialization/u);
  assert.match(DATA_AUTHORITY_MANIFEST.nativeRuntimeImport.source, /disabled by default/u);
  assert.match(DATA_AUTHORITY_MANIFEST.nativeRuntimeImport.scope, /never runs/u);
  assert.equal(DATA_AUTHORITY_MANIFEST.computer.owner, "shoggoth");
  assert.match(DATA_AUTHORITY_MANIFEST.computer.artifacts, /^computer\/artifacts/u);
  assert.match(DATA_AUTHORITY_MANIFEST.computer.ephemeralSessions, /excluded from backup/u);
  assert.match(DATA_AUTHORITY_MANIFEST.computer.driver, /never user authority/u);
  assert.equal(DATA_AUTHORITY_MANIFEST.upgrade.owner, "shoggoth");
  assert.equal(DATA_AUTHORITY_MANIFEST.upgrade.switchJournal, "runtimeSwitchPath");
  assert.match(
    DATA_AUTHORITY_MANIFEST.upgrade.legacyCodexApiKeyMigrationJournal,
    /never contains credential plaintext/u,
  );
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
