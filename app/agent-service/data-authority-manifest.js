"use strict";

const { RUNTIME_ACCOUNT_FIELDS } = require("./runtime-account");
const { IDEA_FIELDS, EXECUTION_FIELDS, OPERATION_FIELDS } = require("./inspiration-store");

const FIELD_CLASSIFICATIONS = Object.freeze([
  "authority",
  "runtimeCache",
  "derived",
  "uiCache",
]);

function recordAuthority({ authority = [], runtimeCache = [], derived = [], uiCache = [] }) {
  return Object.freeze({
    authority: Object.freeze([...authority]),
    runtimeCache: Object.freeze([...runtimeCache]),
    derived: Object.freeze([...derived]),
    uiCache: Object.freeze([...uiCache]),
  });
}

const DATA_AUTHORITY_MANIFEST = Object.freeze({
  schemaVersion: 1,
  stores: Object.freeze({
    inspiration: Object.freeze({
      owner: "shoggoth",
      pathRules: Object.freeze(["stateDir/inspirations.sqlite", "stateDir/inspirations.sqlite-wal"]),
      legacyBackup: "stateDir/inspirations.migrated.json (read-only pre-migration recovery copy)",
      records: Object.freeze({
        Inspiration: recordAuthority({ authority: IDEA_FIELDS }),
        InspirationExecution: recordAuthority({ authority: EXECUTION_FIELDS }),
        InspirationOperation: recordAuthority({ authority: OPERATION_FIELDS }),
      }),
    }),
    product: Object.freeze({
      owner: "shoggoth",
      pathRules: Object.freeze(["stateSnapshotPath", "eventLogPath"]),
      records: Object.freeze({
        RuntimeAccount: recordAuthority({ authority: RUNTIME_ACCOUNT_FIELDS }),
        AgentProfile: recordAuthority({
          authority: [
            "id", "backendId", "agentId", "name", "runtime", "runtimeProfileId",
            "runtimeAccountId", "defaultModel", "defaultCwd", "permissionPolicy", "concurrency",
            "isDefault", "enabled", "createdAt", "updatedAt",
          ],
          derived: ["providerRef"],
        }),
        ModelProvider: recordAuthority({ authority: [
          "id", "kind", "name", "baseUrl", "model", "credentialRef", "headers",
          "awsRegion", "awsProfile", "validationStatus",
        ] }),
        WorkRun: recordAuthority({
          authority: [
            "id", "source", "sourceId", "idempotencyKey", "profileId", "workspace",
            "status", "contextSnapshotId", "eventSeq", "waitingRequestId", "startedAt", "finishedAt",
            "resultSummary", "errorCode", "retryOf",
          ],
          runtimeCache: ["runtimeSessionRef", "runtimeTurnRef"],
        }),
        RunNote: recordAuthority({ authority: [
          "id", "runId", "profileId", "kind", "cardId", "body", "percent", "createdAt",
        ] }),
        McpToolCall: recordAuthority({ authority: [
          "id", "profileId", "callId", "name", "fingerprint", "operationId", "binding",
          "createdAt", "status", "result",
        ] }),
      }),
    }),
    chatSession: Object.freeze({
      owner: "shoggoth",
      pathRules: Object.freeze(["stateDir/chat-sessions.json"]),
      records: Object.freeze({
        ChatSession: recordAuthority({
          authority: [
            "id", "sessionKey", "profileId", "workspace", "title", "modelOverride",
            "permissionMode", "status", "createdAt", "updatedAt",
          ],
          runtimeCache: ["runtimeSessionId"],
        }),
        ChatBindingOperation: recordAuthority({
          authority: [
            "operationId", "sessionKey", "threadSource", "state", "createdAt", "updatedAt",
            "finishedAt",
          ],
          runtimeCache: ["runtimeSessionId"],
        }),
        ChatRemoteOperation: recordAuthority({ authority: [
          "operationId", "sessionKey", "kind", "title", "state", "createdAt", "updatedAt",
          "finishedAt",
        ] }),
        ChatCreateOperation: recordAuthority({ authority: [
          "operationId", "profileId", "workspace", "sessionKey", "state", "createdAt",
          "finishedAt",
        ] }),
      }),
    }),
  }),
  profiles: Object.freeze({
    owner: "shoggoth",
    source: "product.AgentProfile",
  }),
  transcript: Object.freeze({
    owner: "shoggoth",
    classification: "authority",
    source: "TranscriptStore",
    runtimeSource: "thread/read reconciliation/import only",
    shoggothStore: "agents/<profileId>/transcripts/<sessionId>",
  }),
  definition: Object.freeze({
    owner: "shoggoth",
    classification: "authority",
    source: "AgentDefinitionStore",
    shoggothStore: "agents/<profileId>/definition",
    generatedViews: Object.freeze(["USER.md", "TOOLS.md", "MEMORY.md"]),
  }),
  memory: Object.freeze({
    owner: "shoggoth",
    classification: "authority",
    source: "MemoryStore",
    shoggothStore: "agents/<profileId>/memory",
    runtimeSource: "codex memories read-only migration candidate",
  }),
  tools: Object.freeze({
    owner: "shoggoth",
    classification: "authority",
    source: "ToolRegistry + PermissionEngine",
    runtimeProjection: "mcp",
  }),
  skills: Object.freeze({
    owner: "shoggoth",
    classification: "authority",
    source: "NativeSkillStore",
    packageStore: "skills/packages/<skillId>/<version>",
    registry: "skills/registry.json",
    profileSelection: "agents/<profileId>/skills/manifest.json",
    runtimeProjection: "ContextCompiler + authorized MCP injection (no Runtime Home materialization)",
  }),
  nativeRuntimeImport: Object.freeze({
    owner: "shoggoth",
    classification: "legacyCompatibility",
    source: "disabled by default; explicit legacy migration/test input only",
    marker: "nativeRuntimeImportPath",
    staging: "nativeRuntimeImportStagingDir (runtimeCache, excluded from backup)",
    scope: "never runs during normal startup or Agent creation",
    excluded: "credentials, chat/session history, memories, attachments, caches",
    executableContent: "quarantined pending explicit review",
  }),
  computer: Object.freeze({
    owner: "shoggoth",
    classification: "authority",
    source: "ComputerUseController",
    artifacts: "computer/artifacts/<profileHash>/<artifactId>.<extension>",
    ephemeralSessions: "cacheDir/computer-sessions (runtimeCache, excluded from backup)",
    driver: "application resource (versioned dependency, never user authority)",
  }),
  upgrade: Object.freeze({
    owner: "shoggoth",
    classification: "authority",
    switchJournal: "runtimeSwitchPath",
    legacyCodexApiKeyMigrationJournal:
      "legacyCodexApiKeyMigrationPath (metadata only; never contains credential plaintext)",
    snapshotManifest: "backups/upgrade-<generationId>/generation.json",
  }),
  runtime: Object.freeze({
    codexHome: Object.freeze({
      owner: "shoggoth",
      classification: "authority",
      rootRule: "runtimeAccountsDir/codex/<runtimeAccountId>/home (legacy default canonical may remain in place)",
      backupRequired: true,
      credentialPolicy: "one managed Home per internal RuntimeAccount; API keys live only in EncryptedSecretStore and never in shared auth.json; native Codex access tokens may be borrowed in memory, with a persistent logout opt-out",
    }),
    nativeCodexHome: Object.freeze({
      owner: "codex",
      classification: "externalAuthority",
      rootRule: "CODEX_HOME || ~/.codex",
      backupRequired: false,
      credentialPolicy: "owned by the user's system Codex CLI; an auth-only bundled Codex process may read and refresh credentials for Shoggoth; credentials are never copied or linked",
    }),
    grokBuildHome: Object.freeze({
      owner: "grok-build",
      classification: "externalAuthority",
      rootRule: "GROK_HOME || ~/.grok",
      backupRequired: false,
      credentialPolicy: "one system-user Home shared by the native Grok RuntimeAccount; never copied",
    }),
    grokBuildLedger: Object.freeze({
      owner: "shoggoth",
      classification: "authority",
      rootRule: "stateDir/runtime-ledgers/grok-build/<runtimeProfileId>/<workspaceShardId>",
      backupRequired: true,
    }),
    antigravityHome: Object.freeze({
      owner: "shoggoth",
      classification: "derivedIntegration",
      rootRule: "runtimeIntegrationDir/antigravity/<runtimeAccountId>/home",
      backupRequired: false,
      excludedRuntimeCaches: Object.freeze([
        "runtimeIntegrationDir/antigravity/<runtimeAccountId>/home/.gemini/antigravity-cli/cli.log",
        "runtimeIntegrationDir/antigravity/<runtimeAccountId>/home/.gemini/antigravity-cli/log",
      ]),
      credentialPolicy: "one lightweight integration Home per account; native ~/.gemini is never rewritten and credentials are never copied",
    }),
    antigravityLedger: Object.freeze({
      owner: "shoggoth",
      classification: "authority",
      rootRule: "stateDir/runtime-ledgers/antigravity/<runtimeProfileId>/<workspaceShardId>",
      backupRequired: true,
    }),
    piHome: Object.freeze({
      owner: "pi",
      classification: "externalAuthority",
      rootRule: "PI_CODING_AGENT_DIR || ~/.pi/agent",
      backupRequired: false,
      credentialPolicy: "one system-user Home shared by the native Pi RuntimeAccount; never copied",
    }),
    piLedger: Object.freeze({
      owner: "shoggoth",
      classification: "authority",
      rootRule: "stateDir/runtime-ledgers/pi/<runtimeProfileId>/<workspaceShardId>",
      backupRequired: true,
    }),
    claudeCodeHome: Object.freeze({
      owner: "claude-code",
      classification: "externalAuthority",
      rootRule: "CLAUDE_CONFIG_DIR || ~/.claude",
      backupRequired: false,
      credentialPolicy: "one system-user Home shared by the native Claude RuntimeAccount; OS keychain remains external",
    }),
    claudeCodeLedger: Object.freeze({
      owner: "shoggoth",
      classification: "authority",
      rootRule: "stateDir/runtime-ledgers/claude-code/<runtimeProfileId>/<workspaceShardId>",
      backupRequired: true,
    }),
    deepSeekHarnessHome: Object.freeze({
      owner: "deepseek-harness",
      classification: "externalAuthority",
      rootRule: "DSH_HOME || ~/.dsh",
      backupRequired: false,
      credentialPolicy: "one system-user Home shared by the native DSH RuntimeAccount; official dsh installation remains unmodified",
    }),
    deepSeekHarnessIntegration: Object.freeze({
      owner: "shoggoth",
      classification: "derivedIntegration",
      rootRule: "runtimeIntegrationDir/deepseek-harness/<runtimeAccountId>",
      backupRequired: false,
    }),
    deepSeekHarnessLedger: Object.freeze({
      owner: "shoggoth",
      classification: "authority",
      rootRule: "stateDir/runtime-ledgers/deepseek-harness/<runtimeProfileId>/<workspaceShardId>",
      backupRequired: true,
    }),
    electronProfile: Object.freeze({
      owner: "shoggoth-runtime",
      classification: "runtimeCache",
      rootRule: "profileDir",
      backupRequired: false,
    }),
  }),
  backends: Object.freeze({
    shoggoth: Object.freeze({
      owner: "shoggoth",
      rootRule: "userDataRoot",
      isolation: "native",
    }),
    openclaw: Object.freeze({
      owner: "openclaw",
      rootRule: "OPENCLAW_HOME || ~/.openclaw",
      isolation: "external",
    }),
    hermes: Object.freeze({
      owner: "hermes",
      rootRule: "HERMES_HOME || ~/.hermes",
      isolation: "external",
    }),
  }),
});

function flattenRecordFields(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError("record authority must be an object");
  }
  return FIELD_CLASSIFICATIONS.flatMap((classification) => {
    const fields = record[classification];
    if (!Array.isArray(fields)) throw new TypeError(`missing ${classification} field list`);
    return fields;
  });
}

function validateDataAuthorityManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || !manifest.stores
    || !manifest.runtime?.codexHome || !manifest.runtime?.nativeCodexHome
    || !manifest.runtime?.grokBuildHome
    || !manifest.runtime?.grokBuildLedger || !manifest.runtime?.antigravityHome
    || !manifest.runtime?.antigravityLedger || !manifest.runtime?.piHome
    || !manifest.runtime?.piLedger || !manifest.runtime?.claudeCodeHome
    || !manifest.runtime?.claudeCodeLedger || !manifest.runtime?.deepSeekHarnessHome
    || !manifest.runtime?.deepSeekHarnessIntegration
    || !manifest.runtime?.deepSeekHarnessLedger
    || !manifest.transcript || !manifest.definition
    || !manifest.memory || !manifest.tools || !manifest.skills || !manifest.nativeRuntimeImport
    || !manifest.computer || !manifest.upgrade
    || !manifest.backends?.shoggoth || !manifest.backends?.openclaw
    || !manifest.backends?.hermes) {
    throw new TypeError("data authority manifest is incomplete");
  }
  for (const store of Object.values(manifest.stores)) {
    if (store.owner !== "shoggoth" || !Array.isArray(store.pathRules)
      || !store.records || typeof store.records !== "object") {
      throw new TypeError("store authority is invalid");
    }
    for (const record of Object.values(store.records)) {
      const fields = flattenRecordFields(record);
      if (fields.length === 0 || fields.some((field) => typeof field !== "string" || field.length === 0)
        || new Set(fields).size !== fields.length) {
        throw new TypeError("record fields must have one authority classification");
      }
    }
  }
  return true;
}

module.exports = {
  DATA_AUTHORITY_MANIFEST,
  FIELD_CLASSIFICATIONS,
  flattenRecordFields,
  validateDataAuthorityManifest,
};
