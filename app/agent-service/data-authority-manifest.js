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
    officialSkillConnectors: Object.freeze({
      owner: "shoggoth", schemaVersion: 1, backupRequired: true,
      pathRules: Object.freeze(["stateDir/official-skill-connectors.json", "stateDir/skills/registry.json", "stateDir/skills/packages/<skillId>/<version>", "stateDir/mcp-servers/registry.json", "stateDir/encrypted-secrets.json"]),
      records: Object.freeze({
        OfficialSkillInstallation: recordAuthority({ authority: ["id", "revision", "state", "installation", "errorCode"], runtimeCache: ["stage"] }),
        OfficialSkillAccount: recordAuthority({ derived: ["state", "userName"], runtimeCache: ["verificationUrl", "qrCode", "userCode", "errorCode"] }),
      }),
      recovery: "Service owns pinned official payload hashes, exact Skill versions and the bound MCP transport. runtime-bin payloads and private CLI account homes are derived and excluded from backup; restore requires explicit repair and reauthorization. Repair preserves the existing private account home and encrypted MCP credential references. Removal revokes and drains the exact MCP process before deleting owned components, Skills and credentials; user/global installations and account homes are never adopted. Interrupted operations are not replayed.",
    }),
    larkCliConnector: Object.freeze({
      owner: "shoggoth", schemaVersion: 1, backupRequired: true,
      pathRules: Object.freeze(["stateDir/lark-cli-connector.json", "stateDir/skills/registry.json", "stateDir/skills/packages/<skillId>/<version>"]),
      records: Object.freeze({
        LarkCliInstallation: recordAuthority({ authority: ["revision", "state", "installation", "errorCode"], runtimeCache: ["stage"] }),
        LarkCliSetup: recordAuthority({ derived: ["configured", "appId", "brand", "userName"],
          runtimeCache: ["requestId", "state", "verificationUrl", "userCode", "qrCode", "expiresAt", "warning", "errorCode"] }),
      }),
      recovery: "Service owns the pinned CLI installation and exact skill hashes; downloads and runtime-bin payloads are derived and excluded from backup. Missing payloads require explicit reinstall. Interrupted operations are never replayed. Setup processes and QR files are ephemeral, cancelled and drained on shutdown; restart reads official CLI account status without replaying login. User/global CLI installations and official CLI account credentials remain outside this connector's removal authority.",
    }),
    appleDevices: Object.freeze({
      owner: "shoggoth", schemaVersion: 2, backupRequired: true,
      pathRules: Object.freeze(["stateDir/apple-device-policy.json", "stateDir/apple-device-write-ledger.json"]),
      records: Object.freeze({
        AppleDevicePolicy: recordAuthority({ authority: ["schemaVersion", "revision", "resources"] }),
        AppleDeviceResourcePolicy: recordAuthority({ authority: ["enabled", "readPolicy", "writePolicy", "disabledProfileIds"], derived: ["id", "authorization"] }),
        AppleDeviceWriteReceipt: recordAuthority({ authority: ["key", "fingerprint", "operation", "operationId", "state", "result", "errorCode"] }),
      }),
      recovery: "Private single Service writer; writing follows each resource's allow/ask/deny policy and has a durable receipt before dispatch; version 1 policies default to ask; uncertain writes never replay; authority restore disconnects both devices while retaining reading/writing choices and receipts; macOS consent, native binaries and pending approvals are never backup authority",
    }),
    webSettings: Object.freeze({
      owner: "shoggoth", schemaVersion: 1, backupRequired: true,
      pathRules: Object.freeze(["stateDir/web-settings.json", "agents/<profileId>/web-settings.json", "stateDir/encrypted-secrets.json"]),
      records: Object.freeze({
        WebProviderSettings: recordAuthority({ authority: ["revision", "searchProvider", "fetchProvider"] }),
        AgentWebProviderSettings: recordAuthority({ authority: ["profileId", "revision", "searchProvider", "fetchProvider"], derived: ["effective", "source"] }),
        WebProviderCredentialStatus: recordAuthority({ derived: ["provider", "configured", "revision"] }),
      }),
      recovery: "Service owns CAS provider choices; API keys are separate encrypted credentials and plaintext canaries; authority backup keeps both files; absence uses keyless Exa search and direct fetch",
    }),
    heartbeat: Object.freeze({
      owner: "shoggoth", schemaVersion: 1, backupRequired: true,
      pathRules: Object.freeze(["agents/<profileId>/HEARTBEAT.md", "stateDir/proactive.sqlite"]),
      records: Object.freeze({
        HeartbeatDocument: recordAuthority({ authority: ["profileId", "content"], derived: ["revision", "missing", "readOnly"] }),
        HeartbeatScratch: recordAuthority({ authority: ["profileId", "content", "revision", "updatedAt"] }),
        HeartbeatEvidence: recordAuthority({ authority: ["revision", "content", "scratch", "web"] }),
      }),
      recovery: "User rules stay separate from monitor state and working notes; completed reviews save scratch with CAS only while the frozen file remains current; authority backup restores both file and database",
    }),
    chatUi: Object.freeze({
      owner: "shoggoth", schemaVersion: 1, backupRequired: true,
      pathRules: Object.freeze(["stateDir/chat-ui-config.json", "agents/<profileId>/chat-ui/<sessionId>/journal.jsonl",
        "agents/<profileId>/chat-ui/<sessionId>/manifest.json", "agents/<profileId>/chat-ui/objects/<sha256>.html"]),
      records: Object.freeze({
        ChatUiConfig: recordAuthority({ authority: ["revision", "config"] }),
        ChatUiSession: recordAuthority({ authority: ["profileId", "sessionId", "owner", "epoch", "seq", "checksum"] }),
        ChatUiRevision: recordAuthority({ authority: ["publicationId", "callId", "fingerprint", "tool", "artifactId", "revision", "sourceEventId", "segmentId", "htmlHash",
          "htmlBytes", "declaration", "creatorRunId", "creatorAttemptId", "conversationEpoch", "provenance", "state",
          "stateRevision", "status", "transcriptSeq", "createdAt", "legacy", "bridgeApiVersion", "resourceBundleId", "rendererPolicyVersion"] }),
        ChatUiOperation: recordAuthority({ authority: ["actionRequestId", "operationId", "artifactId", "revision",
          "sourceEventId", "actionId", "action", "baseStateRevision", "snapshot", "fingerprint", "sendEnvelope", "sendFingerprint", "stateRevision",
          "conversationEpoch", "status", "receipt", "publicCode", "createdAt", "updatedAt"] }),
        ChatUiMount: recordAuthority({ runtimeCache: ["leaseId", "mountId", "generation", "expiresAt", "port"] }),
      }),
      recovery: "Private single Service writer; immutable objects and confirmed facts survive restart; authority restore advances UI epochs before Inbox recovery; stale operations never replay; writer locks, mounts, ports and previews are excluded from backup",
    }),
    agentFiles: Object.freeze({
      owner: "shoggoth", schemaVersion: 1, backupRequired: true,
      pathRules: Object.freeze(["agents/<profileId>/files/<fileId>/.shoggoth-file.json",
        "agents/<profileId>/files/<fileId>/<filename>"]),
      records: Object.freeze({
        AgentFile: recordAuthority({ authority: ["profileId", "fileId", "name", "mimeType", "sizeBytes",
          "sha256", "source", "createdAt", "updatedAt", "revision", "status", "intent", "pendingName"] }),
      }),
      recovery: "A private Service writer commits metadata and payload together. Rename intents and delete receipts survive restart and restore. The in-memory index is rebuilt from the records, and incomplete import staging is outside backup authority.",
    }),
    hooks: Object.freeze({
      owner: "shoggoth", schemaVersion: 1, backupRequired: true,
      pathRules: Object.freeze(["stateDir/hooks/hooks.sqlite", "stateDir/hooks/packages/<contentDigest>"]),
      records: Object.freeze({
        HookDefinition: recordAuthority({ authority: ["hookId", "profileId", "owner", "revision", "version", "contentDigest", "definition", "activeVersion", "epoch"] }),
        HookGrant: recordAuthority({ authority: ["hookId", "version", "incarnation", "epoch", "contentDigest", "payload", "workspaceRead", "workspaceWrite"] }),
        HookSnapshot: recordAuthority({ authority: ["id", "runId", "profileId", "workspace", "source", "incarnation", "entries", "capabilities"] }),
        HookExecution: recordAuthority({ authority: ["id", "profileId", "hookId", "version", "eventId", "runId", "kind", "state", "inputDigest", "outputDigest", "workerPid", "workerStartIdentity"] }),
      }),
      recovery: "Single private Service writer; restored definitions stay disabled, grants rotate with incarnation, uncertain actions are never replayed; cacheDir/hooks workers and simulation directories are ephemeral",
    }),
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
      records: Object.freeze({
        CronGroupDelivery: recordAuthority({ authority: ["ownerScope", "groupId", "memberId", "messageId", "watch"] }),
        CronTombstone: recordAuthority({ authority: ["id", "profileId", "name", "deletedAt", "operationId"] }),
      }),
      recovery: "Deleted job IDs remain reserved and historical WorkRuns remain attributable",
    }),
    cronAuthorization: Object.freeze({
      owner: "shoggoth", schemaVersion: 1,
      pathRules: Object.freeze(["stateDir/cron-authorizations-v1.json"]),
      records: Object.freeze({ CronAuthorization: recordAuthority({ authority: ["jobId", "profileId", "epoch",
        "definitionDigest", "grants", "approvedAt", "runId"] }) }),
      recovery: "Exact task and operation grants survive restart; definition edits revoke before the job changes",
    }),
    runtimeExtensions: Object.freeze({
      owner: "shoggoth", schemaVersion: 1,
      pathRules: Object.freeze(["stateDir/runtime-extensions-v1.json"]),
      records: Object.freeze({ RuntimeExtension: recordAuthority({ authority: ["enabled", "envelope", "trustedKey"] }) }),
      recovery: "Signed opt-in packages; invalid catalog entries remain unavailable without deleting account history",
    }),
    runtimeAcpLedger: Object.freeze({
      owner: "shoggoth", schemaVersion: 2,
      pathRules: Object.freeze(["stateDir/runtime-acp-ledgers/<sha256-binding-workspace>.json",
        "stateDir/runtime-acp-ledgers/<sha256-binding-workspace>.json.v1-original",
        "stateDir/runtime-acp-ledgers/<sha256-binding-workspace>.json.migration-v2.json"]),
      records: Object.freeze({ AcpLedger: recordAuthority({ authority: ["version", "sessions", "pending"] }) }),
      recovery: "V1 raw sources and migration receipts retained; structured items and independent write/terminal facts reject unknown replay",
    }),
    mcpConnectors: Object.freeze({
      owner: "shoggoth", schemaVersion: 2, backupRequired: true,
      pathRules: Object.freeze(["stateDir/mcp-servers/registry.json", "stateDir/mcp-servers/connection-requests-v1.json"]),
      records: Object.freeze({ McpConnector: recordAuthority({ authority: ["id", "source", "transport", "auth", "secretRef", "setup", "status", "lastCheck", "disabledProfileIds"] }),
        McpConnectionRequest: recordAuthority({ authority: ["requestId", "owner", "fingerprint", "status", "expiresAt"] }) }),
      recovery: "Restored connectors are disabled and lose credential references; credentials are local to the OS keychain. Empty exclusion lists include all current and future Agents. Run admission freezes readiness; revocation immediately narrows visibility and calls.",
    }),
    mcpConnectionAcknowledgements: Object.freeze({
      owner: "shoggoth", schemaVersion: 1, backupRequired: true,
      pathRules: Object.freeze(["stateDir/mcp-connection-acks-v1.json"]),
      records: Object.freeze({ McpConnectionAcknowledgement: recordAuthority({authority:["requestId","fingerprint","sessionKey","status","createdAt","updatedAt"]}) }),
      recovery: "The App Host holds the private writer lease until close. Offline backup/restore must hold the same lease throughout the snapshot or staging commit, and refuses an active App writer. The lease and its candidates are excluded from backups. A reservation is persisted before sending a fixed confirmation. Restore overlays current exact-scope acknowledgements over older backups, converts pending to unknown and never resends accepted or uncertain operations. Conflicting request identity fails closed; the original ledger remains unchanged.",
    }),
    retiredOpenConnector: Object.freeze({
      owner: "shoggoth", schemaVersion: 1, backupRequired: false,
      pathRules: Object.freeze(["stateDir/connectors/access-v1.json", "stateDir/connectors/runtime/**", "stateDir/connectors/runtime-version.json", "stateDir/connectors/external-selection-v1.sqlite", "stateDir/connectors/open-connector-retired-v1.json"]),
      records: Object.freeze({ RetiredOpenConnectorEvidence: recordAuthority({ authority: ["opaqueLegacyBytes", "retirementReceipt"] }) }),
      recovery: "Opaque data and encrypted credential entries are preserved without opening an old Store or launching a writer. New backups exclude retired runtime/account payloads; old backups restore opaque bytes only and never re-enable execution.",
    }),
    retiredPluginPlatform: Object.freeze({
      owner: "shoggoth", schemaVersion: 2, backupRequired: true,
      pathRules: Object.freeze(["stateDir/plugins/catalog.sqlite", "stateDir/plugins/packages/**", "stateDir/plugins/data/**",
        "stateDir/plugins/staging/**", "stateDir/plugins/oauth-providers.json", "stateDir/plugins/plugin-rollback/**",
        "stateDir/plugins/external-selection-dispatch.sqlite", "stateDir/connectors/legacy-platform-retired-v1.json"]),
      records: Object.freeze({ LegacyPluginEvidence: recordAuthority({ authority: ["opaqueLegacyBytes", "retirementReceipt", "upgradeSnapshot"] }) }),
      recovery: "Before the first cutover, an existing legacy platform requires a verified authority upgrade snapshot under the exact owned Service lock and before any Store writer. Snapshot failure leaves Connectors unavailable and ordinary chat usable. No old package Store, installer, login, Grant resolver or executor is opened. Backups preserve opaque legacy bytes and never activate them. Downgrading to an old executable requires a separately authorized stopped-state restore.",
    }),
    externalPluginAudit: Object.freeze({
      owner: "shoggoth", schemaVersion: 4, journalSchemaVersion: 1,
      pathRules: Object.freeze(["stateDir/plugins/external-provenance.sqlite",
        "stateDir/plugins/external-approval-journal.sqlite"]),
      backupRequired: true,
      records: Object.freeze({
        ExternalPluginCallAudit: recordAuthority({ derived: ["callId", "backendId", "instanceId",
          "agentId", "sessionId", "runId", "taskId", "turnId", "toolCallId", "bindingId",
          "installationId", "componentId", "connectionId", "toolIdentity", "toolName",
          "status", "cancelRequested", "resultDigest", "resultBytes", "errorCode",
          "approvalRequestId", "approvalOutcome", "approvalUpdatedAt", "approvalRequired",
          "approvalJournalGate", "createdAt", "updatedAt"] }),
        ExternalPluginApprovalJournalEvent: recordAuthority({ derived: ["callId", "requestId",
          "outcome", "updatedAt"] }),
      }),
      recovery: "Retired history reader snapshots both databases to a private temporary directory and opens only those copies read-only. Exact durable approval events may enrich historical display; pending calls remain unknown. Original bytes are never reconciled, pruned or written and cannot authorize execution",
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
    externalProviderCredentialRecovery: Object.freeze({
      owner: "shoggoth", schemaVersion: 1,
      pathRules: Object.freeze(["stateDir/external-provider-credentials.json", "stateDir/external-provider-credential-receipts/*",
        "stateDir/openclaw-auth-profile-credentials.json", "stateDir/openclaw-auth-profile-credential-receipts/*"]),
      records: Object.freeze({
        CredentialLedger: recordAuthority({ authority: ["version", "revision", "bindings", "operations"] }),
        CredentialBinding: recordAuthority({ authority: ["backendId", "providerKey", "baseUrl", "api", "revision",
          "credentialRef", "credentialFingerprint", "lastOperationId"] }),
        CredentialOperation: recordAuthority({ authority: ["backendId", "providerKey", "baseUrl", "api", "operationId", "requestDigest",
          "action", "status", "previousBinding", "candidateRef", "candidateFingerprint", "ownerGeneration", "createdAt", "updatedAt"] }),
        CredentialReceipt: recordAuthority({ authority: ["version", "operationId", "requestDigest", "scopeDigest", "providerKey", "action", "status"] }),
      }),
      recovery: "Back up stopped-Service ledgers and receipts with encryptedSecrets; legacy endpoint and native auth-profile namespaces remain separate; receipts never authorize a replacement write or credential replay",
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
        "agents/<profileId>/conversation-checkpoints/checkpoint-<sha256>.memory-anchor.json",
        "agents/<profileId>/conversation-checkpoints/<sha256-session-id>.native-memory-anchor.json",
        "agents/<profileId>/conversation-checkpoints/<sha256-session-id>.json.invalidation",
        "agents/<profileId>/conversation-checkpoints/<sha256-session-id>.json.memory-invalidation"]),
      records: Object.freeze({ ConversationCheckpoint: recordAuthority({ authority: [
        "version", "id", "profileId", "sessionId", "coveredThroughSeq", "coveredHash", "transcriptRevision",
        "previousId", "summary", "provenance", "createdAt", "contentHash", "partial",
      ] }), CheckpointMemoryAnchor: recordAuthority({ authority: ["version", "profileId",
          "checkpointId", "memoryRevision", "memoryInvalidationRevision", "memoryFreshUntil", "checksum"] }),
        NativeMemoryAnchor: recordAuthority({ authority: ["version", "profileId", "sessionId",
          "nativeSessionId", "bindingId", "memoryRevision", "memoryInvalidationRevision", "memoryFreshUntil", "policyRevision", "checksum"] }),
        CheckpointInvalidation: recordAuthority({ authority: ["version", "checkpointId", "coverageHash", "nativeSessionId", "bindingId"] }),
        CheckpointMemoryInvalidation: recordAuthority({ authority: ["version", "checkpointId", "coverageHash",
          "nativeSessionId", "bindingId", "memoryRevision", "memoryInvalidationRevision", "memoryFreshUntil", "policyRevision"] }) }),
      recovery: "New App projection requires a matching Transcript prefix and separate Memory revision/expiry anchor; any revocation blocks unprovenanced compaction",
    }),
    runExecution: Object.freeze({
      owner: "shoggoth",
      schemaVersion: 3,
      pathRules: Object.freeze(["stateDir/run-executions/<sha256-run-id>.json"]),
      records: Object.freeze({
        RunExecutionBinding: recordAuthority({ authority: ["version", "identity", "contract", "command", "attempt"] }),
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
    conditionWatch: Object.freeze({
      owner: "shoggoth", schemaVersion: 1, backupRequired: true,
      pathRules: Object.freeze(["stateDir/condition-watches.sqlite", "stateDir/condition-watches.sqlite-wal"]),
      records: Object.freeze({
        Watch: recordAuthority({ authority: ["id", "target", "definition", "version", "revision", "epoch", "state",
          "nextDueAt", "anchorAt", "test", "binding", "checkpoint", "failure"] }),
        WatchCheck: recordAuthority({ authority: ["id", "watchId", "epoch", "version", "scheduledAt", "outcome", "eventId"] }),
        WatchEvent: recordAuthority({ authority: ["id", "watchId", "epoch", "version", "target", "evidence", "state", "receipt"] }),
      }),
      recovery: "Single Service writer. Ordinary restart reconciles pending events by destination receipt; restore pauses and revokes read and delivery authority.",
    }),
    groupChat: Object.freeze({
      owner: "shoggoth",
      pathRules: Object.freeze(["stateDir/group-chats.sqlite", "stateDir/group-chats.sqlite-wal"]),
      records: Object.freeze({
        GroupChat: recordAuthority({ authority: ["id", "name", "purpose", "status", "createdAt", "updatedAt",
          "metadataRevision", "rosterRevision", "controlEpoch", "lastSeq"] }),
        GroupChatMember: recordAuthority({ authority: ["id", "groupId", "backendId", "agentId", "profileId",
          "displayName", "handle", "state", "position", "joinedSeq", "leftSeq"] }),
        GroupChatMessage: recordAuthority({ authority: ["id", "groupId", "seq", "threadId", "author", "body",
          "mentions", "system", "origin", "createdAt"] }),
        GroupChatDiscussion: recordAuthority({ authority: ["id", "groupId", "status", "causeMessageId",
          "publicReplyCount", "opportunityCount", "deferredMemberIds"] }),
        GroupChatOpportunity: recordAuthority({ authority: ["id", "discussionId", "memberId", "state", "round",
          "operationId", "runId", "inputThroughSeq", "errorCode"] }),
        // 内部会话归属记在群库里：会话库 schema 不变，回退旧版不会把会话库判为损坏。
        GroupChatSessionBinding: recordAuthority({ authority: ["groupId", "memberId", "threadId", "purpose",
          "profileId", "sessionKey", "watermark"] }),
      }),
    }),
    product: Object.freeze({
      owner: "shoggoth",
      schemaVersion: 17,
      identity: "Agent id/agentId remain stable; backendId is always shoggoth; selected runtimes belong to Agent bindings",
      pathRules: Object.freeze(["stateSnapshotPath", "eventLogPath", "stateDir/agent-create-definitions/<profileId>-<digest>.json",
        "stateDir/product-schema-migrations/15-to-16/<digest>/*",
        "stateDir/product-schema-migrations/15-to-17/<digest>/*", "stateDir/product-schema-migrations/16-to-17/<digest>/*"]),
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
          "label", "enabled", "revision", "createdAt", "updatedAt", "defaultModel",
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
            "status", "contextSnapshotId", "runtimeAttemptRef", "eventSeq", "waitingRequestId", "startedAt", "finishedAt",
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
    diagnosticTranscripts: "stateDir/plugins/active-memory/transcripts/** (independent memory data; never retired)",
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
    builtinSettings: "skills/builtin-authoring.json",
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
      // The ACP server keeps its sign-in selection and native conversations under
      // .gemini/antigravity-acp; the retired agy CLI data under .gemini/antigravity-cli is never read.
      excludedRuntimeCaches: Object.freeze([
        "runtimeIntegrationDir/antigravity/<runtimeAccountId>/home/.gemini/antigravity/bin",
      ]),
      credentialPolicy: "one lightweight integration Home per account; native ~/.gemini is never rewritten and credentials are never copied",
    }),
    antigravityLedger: Object.freeze({
      owner: "shoggoth",
      classification: "authority",
      rootRule: "stateDir/runtime-ledgers/antigravity-acp/<runtimeProfileId>/<workspaceShardId>",
      backupRequired: true,
    }),
    antigravityAcpServer: Object.freeze({
      owner: "shoggoth",
      classification: "runtimeCache",
      rootRule: "stateDir/runtime-bin/antigravity-acp/<version>",
      backupRequired: false,
      credentialPolicy: "pinned official server re-downloaded and verified by hash and Google signature; holds no credentials",
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
    || !manifest.runtime?.antigravityLedger || !manifest.runtime?.antigravityAcpServer
    || !manifest.runtime?.piHome
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
