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
    runtimeSelectionPolicy: Object.freeze({
      owner: "shoggoth", schemaVersion: 1,
      pathRules: Object.freeze(["agents/<profileId>/runtime-selection-policy.json"]),
      records: Object.freeze({ RuntimeSelectionPolicy: recordAuthority({ authority: ["version", "revision", "mode",
        "allowedBindingIds", "preferredBindingIds", "affinity", "weights", "compactionBindingId"] }) }),
      recovery: "CAS policy belongs to the Agent; recovery uses the frozen execution binding, never a new selection",
    }),
    sourceConversation: Object.freeze({
      owner: "shoggoth", schemaVersion: 1,
      pathRules: Object.freeze(["stateDir/source-conversations-v1.json"]),
      records: Object.freeze({ SourceConversation: recordAuthority({ authority: ["runId", "source", "sourceId", "profileId",
        "workspace", "sessionKey", "policy", "createdAt"] }) }),
      recovery: "Kanban associations persist; deleted conversations are not recreated for an old run",
    }),
    cron: Object.freeze({
      owner: "shoggoth", schemaVersion: 3,
      pathRules: Object.freeze(["stateDir/native-cron.json", "stateDir/native-cron.json.pre-v3"]),
      records: Object.freeze({ CronTombstone: recordAuthority({ authority: ["id", "profileId", "name", "deletedAt", "operationId"] }) }),
      recovery: "Deleted job IDs remain reserved and historical WorkRuns remain attributable",
    }),
    runtimeExtensions: Object.freeze({
      owner: "shoggoth", schemaVersion: 1,
      pathRules: Object.freeze(["stateDir/runtime-extensions-v1.json", "stateDir/runtime-acp-ledgers/<sha256-binding-workspace>.json"]),
      records: Object.freeze({ RuntimeExtension: recordAuthority({ authority: ["enabled", "envelope", "trustedKey"] }),
        AcpLedger: recordAuthority({ authority: ["version", "sessions", "pending"] }) }),
      recovery: "Signed opt-in packages; ACP pending receipts reject replay when remote acceptance is unknown",
    }),
    plugins: Object.freeze({
      owner: "shoggoth", schemaVersion: 8,
      pathRules: Object.freeze(["stateDir/plugins/catalog.sqlite", "stateDir/plugins/packages/<contentDigest>",
        "stateDir/plugins/staging/<operationId>", "stateDir/plugins/data/<installationId>/<dataScopeId>",
        "stateDir/plugins/oauth-providers.json", "stateDir/plugins/data/.prepared-dependencies",
        "stateDir/plugins/plugin-rollback/<installationId>"]),
      records: Object.freeze({
        PluginAuthorityState: recordAuthority({ authority: ["incarnation", "restoredAt", "restoredFrom", "receiptGap"] }),
        PluginRelease: recordAuthority({ authority: ["sourceIdentity", "contentDigest", "name", "declaredVersion",
          "manifest", "components", "diagnostics", "createdAt"] }),
        PluginInstallation: recordAuthority({ authority: ["installationId", "sourceIdentity", "releaseDigest",
          "desiredState", "revision", "createdAt", "updatedAt"] }),
        PluginOperation: recordAuthority({ authority: ["operationId", "fingerprint", "kind", "phase", "result",
          "createdAt", "updatedAt"] }),
        PluginOperationIntent: recordAuthority({ authority: ["operationId", "installationId",
          "desiredState", "expectedRevision"] }),
        PluginConnection: recordAuthority({ authority: ["connectionId", "installationId", "componentId",
          "endpointIdentity", "principalIdentity", "credentialRef", "state", "authRevision", "revision"] }),
        PluginBinding: recordAuthority({ authority: ["bindingId", "subjectKind", "subjectId", "installationId",
          "componentId", "componentKind", "connectionId", "enabled", "revision"] }),
        PluginGrant: recordAuthority({ authority: ["grantId", "bindingId", "connectionId", "principalIdentity",
          "toolIdentity", "contractDigest", "effect", "approvalMode", "expiresAt", "epoch", "revision"] }),
        PluginCapabilityCall: recordAuthority({ authority: ["callId", "runRef", "bindingId", "connectionId",
          "principalIdentity", "toolIdentity", "contractDigest", "argumentDigest", "phase", "createdAt",
          "updatedAt"] }),
      }),
      recovery: "Catalog schema 8 is preflighted read-only; maintenance intents survive restart; code rollback stays disabled until explicit pinned data restoration; authority restore rotates incarnation and preserves unknown receipts; all new installations use Product15 in one canonical root; incompatible data is rejected before writers open",
    }),
    encryptedSecrets: Object.freeze({
      owner: "shoggoth", schemaVersion: 1,
      pathRules: Object.freeze(["stateDir/encrypted-secrets.json"]),
      records: Object.freeze({
        SecretContainer: recordAuthority({ authority: ["version", "revision"] }),
        EncryptedCredential: recordAuthority({ authority: ["credentialRef", "kind", "ciphertext"] }),
      }),
      recovery: "EncryptedSecretStore is the sole ciphertext owner; mcp-oauth remains fixture-only until live identity and installed new-App acceptance",
    }),
    runtimeObservation: Object.freeze({
      owner: "shoggoth", schemaVersion: 1,
      pathRules: Object.freeze(["cacheDir/runtime-context-v1.json", "cacheDir/runtime-queue-clock-v1.json"]),
      records: Object.freeze({ ContextObservation: recordAuthority({ derived: ["key", "usage"] }),
        QueueArrival: recordAuthority({ derived: ["runId", "queuedAt"] }) }),
      recovery: "Bounded disposable caches; missing queue age falls back to the encrypted command timestamp",
    }),
    conversationCheckpoint: Object.freeze({
      owner: "shoggoth",
      schemaVersion: 2,
      pathRules: Object.freeze(["agents/<profileId>/conversation-checkpoints/<sha256-session-id>.json",
        "agents/<profileId>/conversation-checkpoints/checkpoint-<sha256>.json",
        "agents/<profileId>/conversation-checkpoints/<sha256-session-id>.json.invalidation"]),
      records: Object.freeze({ ConversationCheckpoint: recordAuthority({ authority: [
        "version", "id", "profileId", "sessionId", "coveredThroughSeq", "coveredHash", "transcriptRevision",
        "previousId", "summary", "provenance", "createdAt", "contentHash", "partial",
      ] }), CheckpointInvalidation: recordAuthority({ authority: ["version", "checkpointId", "coverageHash", "nativeSessionId", "bindingId"] }) }),
      recovery: "Only a matching Transcript prefix permits projection; summaries never replace original events",
    }),
    runExecution: Object.freeze({
      owner: "shoggoth",
      schemaVersion: 2,
      pathRules: Object.freeze(["stateDir/run-executions/<sha256-run-id>.json"]),
      records: Object.freeze({
        RunExecutionBinding: recordAuthority({ authority: ["version", "identity", "contract", "command"] }),
      }),
      encryption: "Service crypto broker; removed after durable Product terminal and command completion",
      recovery: "Frozen identity and execution only; native complete history must prove remote outcome",
    }),
    inspiration: Object.freeze({
      owner: "shoggoth",
      pathRules: Object.freeze(["stateDir/inspirations.sqlite", "stateDir/inspirations.sqlite-wal"]),
      records: Object.freeze({
        Inspiration: recordAuthority({ authority: IDEA_FIELDS }),
        InspirationExecution: recordAuthority({ authority: EXECUTION_FIELDS }),
        InspirationOperation: recordAuthority({ authority: OPERATION_FIELDS }),
      }),
    }),
    product: Object.freeze({
      owner: "shoggoth",
      schemaVersion: 15,
      identity: "Agent id/agentId remain stable; backendId is always shoggoth; selected runtimes belong to Agent bindings",
      pathRules: Object.freeze(["stateSnapshotPath", "eventLogPath"]),
      records: Object.freeze({
        RuntimeAccount: recordAuthority({ authority: [...RUNTIME_ACCOUNT_FIELDS, "maxActive"] }),
        AgentProfile: recordAuthority({
          authority: [
            "id", "backendId", "agentId", "name", "providerRef",
            "defaultModel", "defaultCwd", "permissionPolicy", "concurrency",
            "isDefault", "enabled", "createdAt", "updatedAt",
            "defaultBindingId", "bindingsRevision", "bindings", "bindingOperations",
          ],
        }),
        AgentRuntimeBinding: recordAuthority({ authority: [
          "id", "profileId", "runtime", "runtimeProfileId", "runtimeAccountId",
          "label", "enabled", "revision", "createdAt", "updatedAt",
        ] }),
        AgentProfileRuntimeProjection: recordAuthority({ derived: [
          "runtime", "runtimeProfileId", "runtimeAccountId",
        ] }),
        ModelProvider: recordAuthority({ authority: [
          "id", "kind", "name", "baseUrl", "model", "credentialRef", "headers",
          "awsRegion", "awsProfile", "validationStatus", "models", "revision",
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
      schemaVersion: 8,
      pathRules: Object.freeze(["stateDir/chat-sessions.json"]),
      records: Object.freeze({
        ChatSession: recordAuthority({
          authority: [
            "id", "sessionKey", "profileId", "workspace", "title", "modelOverride",
            "permissionMode", "status", "createdAt", "updatedAt", "modelSettings",
            "runtimeBindingId", "retiredRuntimeSessions", "revision",
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
        ChatRuntimeSwitchReceipt: recordAuthority({ authority: [
          "sessionKey", "revision", "fromBindingId", "fromRuntimeSessionId", "toBindingId", "switchedAt", "audited",
        ] }),
      }),
    }),
    tokenUsage: Object.freeze({
      owner: "shoggoth",
      schemaVersion: 2,
      pathRules: Object.freeze(["tokenUsagePath"]),
      records: Object.freeze({
        TokenUsage: recordAuthority({ authority: [
          "id", "profileId", "agentId", "agentName", "source", "sourceId", "threadId", "turnId",
          "model", "provider", "totalTokens", "inputTokens", "cachedInputTokens", "cacheWriteInputTokens",
          "outputTokens", "reasoningOutputTokens", "createdAt", "identityVersion", "runId",
          "runtime", "runtimeAccountId", "responseId",
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
    contextContentStore: "agents/<profileId>/transcripts/<sessionId>/context-content/<sha256>.json",
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
    runtimeSource: "Shoggoth MemoryEngine",
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
  mcpExtensions: Object.freeze({
    owner: "shoggoth",
    classification: "authority",
    source: "NativeMcpStore",
    registry: "mcp-servers/registry.json",
    childProcesses: "ephemeral runtime state; recreated lazily from the registry",
    runtimeProjection: "shared Shoggoth MCP proxy for native and bridged OpenClaw/Hermes Agents",
    externalOwnership: "OpenClaw/Hermes-owned MCP and Skill configuration remains independent",
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
    snapshotManifest: "backups/upgrade-<generationId>/generation.json",
  }),
  runtime: Object.freeze({
    extensionHome: Object.freeze({
      owner: "shoggoth", classification: "authority",
      rootRule: "stateDir/runtime-extension-homes/<runtime>/<runtimeAccountId>", backupRequired: true,
      credentialPolicy: "Explicit signed plugins use an isolated Home; Remote Worker tokens live only in EncryptedSecretStore",
    }),
    codexHome: Object.freeze({
      owner: "shoggoth",
      classification: "authority",
      rootRule: "runtimeAccountsDir/codex/<runtimeAccountId>/home",
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
    openCodeHome: Object.freeze({
      owner: "opencode",
      classification: "externalAuthority",
      rootRule: "XDG_DATA_HOME/opencode || ~/.local/share/opencode",
      backupRequired: false,
      credentialPolicy: "native OpenCode account data remains external and is never copied",
    }),
    openCodeIntegration: Object.freeze({
      owner: "shoggoth",
      classification: "derivedIntegration",
      rootRule: "runtimeIntegrationDir/opencode/<runtimeAccountId>/<runtimeProfileId>/<workspaceShardId>",
      backupRequired: false,
    }),
    openCodeLedger: Object.freeze({
      owner: "shoggoth",
      classification: "authority",
      rootRule: "stateDir/runtime-ledgers/opencode/<runtimeProfileId>/<runtimeAccountId>/<workspaceShardId>",
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
    || !manifest.memory || !manifest.tools || !manifest.skills || !manifest.mcpExtensions
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
