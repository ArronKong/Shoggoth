"use strict";

const crypto = require("node:crypto");
const chatUiProtocol = require("./chat-ui-protocol");
const { ChatUiConfig } = require("./chat-ui-config");
const { ChatUiStore } = require("./chat-ui-store");
const { ChatUiController } = require("./chat-ui-controller");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const {
  MCP_CLIENT_REQUEST_TIMEOUT_MS,
  createMcpStdioHandler,
  runMcpStdioSession,
} = require("../shoggoth-mcp-helper");
const { createEventBuffer, jsonlBytes } = require("./event-buffer");
const {
  BACKEND_ID_PATTERN,
  DEFAULT_AGENT_PROFILE_ID,
  JsonlProductStore,
  validateModelProvider,
} = require("./product-store");
const { ACTIVE_WORK_RUN_STATUSES, createWorkDispatcher } = require("./work-run");
const { CodexRuntimePool } = require("./codex-runtime-pool");
const { CodexRuntimeAdapter } = require("./codex-runtime-adapter");
const { GrokBuildRuntimePool } = require("./grok-build-runtime-pool");
const { reconcileGrokUsage } = require("./grok-usage-reconcile");
const { GrokBuildRuntimeAdapter } = require("./grok-build-runtime-adapter");
const { AntigravityRuntimePool } = require("./antigravity-runtime-pool");
const { AntigravityRuntimeAdapter } = require("./antigravity-runtime-adapter");
const { PiRuntimePool } = require("./pi-runtime-pool");
const { PiRuntimeAdapter } = require("./pi-runtime-adapter");
const { ClaudeCodeRuntimePool } = require("./claude-code-runtime-pool");
const { ClaudeCodeRuntimeAdapter } = require("./claude-code-runtime-adapter");
const { OpenCodeRuntimePool } = require("./opencode-runtime-pool");
const { OpenCodeRuntimeAdapter } = require("./opencode-runtime-adapter");
const { DeepSeekHarnessRuntimePool } = require("./deepseek-harness-runtime-pool");
const { DeepSeekHarnessRuntimeAdapter } = require("./deepseek-harness-runtime-adapter");
const { RuntimeAdapterRegistry } = require("./runtime-adapter-registry");
const { runtimeBinding, validRuntimeAccountId } = require("./runtime-adapter");
const { RuntimeMcpGateIssuer } = require("./runtime-mcp-gate");
const { ensureBuiltinCliAgentProfiles } = require("./builtin-cli-profiles");
const { BuiltinAgentState } = require("./builtin-agent-state");
const { assignBuiltinAgentAvatar } = require("./builtin-agent-avatars");
const { agentGreeting } = require("./agent-greeting");
const { DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME } = require("./runtime-account");
const { AUTH_SPECS, createRuntimeCliAuth } = require("../runtime-cli-auth");
const { CodexRuntimeConfigWriter } = require("./codex-runtime-config");
const { EncryptedSecretStore } = require("./encrypted-secret-store");
const { RunExecutionStore } = require("./run-execution-store");
const { McpAuthSecretStore } = require("./mcp-auth-secret-store");
const { InProcessMcpCryptoBroker } = require("./mcp-crypto-broker");
const { McpSessionManager } = require("./mcp-session-manager");
const { ProviderRuntimeBridge } = require("./provider-runtime-bridge");
const { captureExecutionProviderRoute, assertExecutionProviderRouteCurrent } = require("./execution-provider-route");
const { ProviderService } = require("./codex-provider-service");
const { reconcileProviderCredentialSecrets } = require("./provider-secret-reconciliation");
const { AccountAuthStateStore } = require("./account-auth-state-store");
const { AccountAuthManager } = require("./account-auth-manager");
const { NativeCodexAuth } = require("./codex-native-auth");
const { RuntimeAccountAdmission } = require("./runtime-account-admission");
const { NativeRuntimeConfig } = require("./native-runtime-config");
const { RuntimeStartupGate } = require("./runtime-startup-gate");
const { NATIVE_RUNTIME_CONFIG_METHODS, NATIVE_RUNTIME_CONFIG_PUBLIC_MESSAGES,
  validateNativeRuntimeConfigParams, validateNativeRuntimeConfigResult } = require("./native-runtime-config-protocol");
const { NativeMemoryConfig } = require("./native-memory-config");
const { NativeMemorySharingConfig } = require("./native-memory-sharing-config");
const { NATIVE_MEMORY_SHARING_METHODS, NATIVE_MEMORY_SHARING_PUBLIC_MESSAGES,
  validateNativeMemorySharingParams, validateNativeMemorySharingResult } = require("./native-memory-sharing-protocol");
const activeMemoryCommand = require("./active-memory-command-protocol");
const activeMemoryStatus = require("./active-memory-status-protocol");
const memoryProviderOwnerProtocol = require("./memory-provider-owner-protocol.cjs");
const { createMemoryProviderOwnerRpc } = require("./memory-provider-owner-rpc");
const { NATIVE_MEMORY_CONFIG_METHODS, NATIVE_MEMORY_CONFIG_PUBLIC_MESSAGES,
  validateNativeMemoryConfigParams, validateNativeMemoryConfigResult } = require("./native-memory-config-protocol");
const { agentRuntimeProfileViews } = require("./agent-runtime-profile-views");
const {
  createRuntimeAccountServiceController,
} = require("./runtime-account-service-controller");
const { AntigravityAcpLoginManager } = require("./antigravity-acp-login-manager");
const { OpenCodeLoginManager } = require("./opencode-login-manager");
const { RuntimeSessionOwnershipStore } = require("./runtime-session-ownership-store");
const { assertCurrentStorageBaseline } = require("./storage-baseline");
const { ChatSessionStore } = require("./chat-session-store");
const { createStopImpact } = require("./stop-impact");
const { InspirationStore } = require("./inspiration-store");
const { InspirationService } = require("./inspiration-service");
const { HookStore } = require("./hook-store");
const { HookProcessHost } = require("./hook-process-host");
const { HookRunner } = require("./hook-runner");
const { HookService } = require("./hook-service");
const { HookToolExecution } = require("./hook-tool-execution");
const { HookWorkspaceWriters } = require("./hook-workspace-writers");
const { glob: hookToolMatches } = require("./hook-contract");
const { HOOK_TOOL_NAMES } = require("./hook-service-protocol");
const { ProactiveStore } = require("./proactive-store");
const learningProtocol = require("./self-improvement/protocol");
const { LearningStore } = require("./self-improvement/store");
const { LearningService } = require("./self-improvement/service");
const { LearningSources } = require("./self-improvement/sources");
const { LearnedSkillFacade } = require("./self-improvement/skill-facade");
const { WebService } = require("./web-service");
const { WebSettings } = require("./web-settings");
const webSettingsProtocol = require("./web-settings-protocol");
const { HeartbeatDocumentStore } = require("./heartbeat-document");
const { ProactiveService } = require("./proactive-service");
const { ProactiveScheduler } = require("./proactive-scheduler");
const { InspirationReminderService } = require("./inspiration-reminder-service");
const { NoticeDeliveryController } = require("./notice-delivery-controller");
const { PROACTIVE_SERVICE_METHODS, PUBLIC_MESSAGES: PROACTIVE_PUBLIC_MESSAGES, validateParams: validateProactiveParams, validateResult: validateProactiveResult } = require("./proactive-service-protocol");
const PROACTIVE_SERVICE_METHOD_SET = new Set(PROACTIVE_SERVICE_METHODS);
const { GroupChatStore } = require("./group-chat-store");
const { GroupChatService } = require("./group-chat-service");
const { GroupChatDriver } = require("./group-chat-driver");
const { GroupNativeExecutor } = require("./group-native-executor");
const { GroupNativeToolExposure } = require("./group-native-tool-exposure");
const { GroupMemberDirectory } = require("./group-member-directory");
const { GroupExternalExecutor } = require("./group-external-executor");
const { GroupDraftTracker } = require("./group-drafts");
const { GroupAdapterChannel } = require("./group-adapter-channel");
const { isGroupChatRun } = require("./group-chat-run");
const { GROUP_CHAT_SERVICE_METHODS, PUBLIC_MESSAGES: GROUP_CHAT_PUBLIC_MESSAGES, validateParams: validateGroupChatParams, validateResult: validateGroupChatResult } = require("./group-chat-protocol");
const GROUP_CHAT_SERVICE_METHOD_SET = new Set(GROUP_CHAT_SERVICE_METHODS);
const { ExternalInspirationExecutor } = require("./external-inspiration-executor");
const { INSPIRATION_SERVICE_METHODS, PUBLIC_MESSAGES: INSPIRATION_PUBLIC_MESSAGES,
  validateInspirationServiceParams, validateInspirationServiceResult } = require("./inspiration-service-protocol");
const { AgentDefinitionStore } = require("./agent-definition-store");
const { TranscriptStore } = require("./transcript-store");
const { MemoryStore } = require("./memory-store");
const { MemoryEngine } = require("./memory-engine");
const { MemoryProvenanceStore } = require("./memory-provenance-store");
const { MemoryProvenanceService } = require("./memory-provenance-service");
const { MemoryCandidateStore } = require("./memory-candidate-store");
const { MemoryCandidateService } = require("./memory-candidate-service");
const { CodexMemoryImportStore } = require("./codex-memory-import-store");
const { CodexMemoryImportService } = require("./codex-memory-import-service");
const { readCodexMemorySource } = require("./codex-memory-source");
const { ConversationMemoryService } = require("./conversation-memory-service");
const { ConversationRecallService } = require("./conversation-recall-service");
const { NativeMemorySemanticService } = require("./native-memory-semantic-service");
const { ConversationDefinitionService } = require("./conversation-definition-service");
const { ContextSnapshotStore } = require("./context-snapshot-store");
const { ContextCompiler } = require("./context-compiler");
const { NativeSkillStore } = require("./native-skill-store");
const { NativeMcpStore } = require("./native-mcp-store");
const { NativeMcpClientManager } = require("./native-mcp-client-manager");
const { PluginStore } = require("./plugin-store");
const { PluginPackageInstaller } = require("./plugin-package-installer");
const { BundledPluginCatalog, bundledRoot } = require("../core/bundled-plugin-catalog");
const { FirstPartyPluginSync, firstPartyPluginRoot } = require("./first-party-plugin-sync");
const { PluginComponentCatalog } = require("./plugin-component-catalog");
const { PluginComponentResolver } = require("./plugin-component-resolver");
const { PluginSkillFacade } = require("./plugin-skill-facade");
const { PluginToolCatalogRegistry } = require("./plugin-tool-catalog-registry");
const { CapabilityDispatcher } = require("./capability-dispatcher");
const { PluginServiceController, PLUGIN_SERVICE_METHODS } = require("./plugin-service-controller");
const { PluginAuthoringService } = require("./plugin-authoring-service");
const { PluginPackageDeclarations } = require("./plugin-package-declarations");
const { PluginSecretStore } = require("./plugin-secret-store");
const { PluginQuickSetup } = require("./plugin-quick-setup");
const { PluginDataScopeLeaseManager } = require("./plugin-data-scope-lease");
const { PluginMcpConnectionPool } = require("./plugin-mcp-connection-pool");
const { PluginCredentialVault } = require("./plugin-credential-vault");
const { PluginOAuthProviderRegistry } = require("./plugin-oauth-provider-registry");
const { PluginOAuthConnectionController } = require("./plugin-oauth-connection-controller");
const { PluginOutlookGraphConnectionController } =
  require("./plugin-outlook-graph-connection-controller");
const { isGraphSidecar, TRANSPORT: GRAPH_SIDECAR_TRANSPORT } =
  require("./plugin-microsoft-graph-sidecar");
const { OutlookCalendarGraphController, loadOutlookCalendarConfig } =
  require("./outlook-calendar-graph");
const { PluginBearerConnectionController } = require("./plugin-bearer-connection-controller");
const { GogGmailRuntime, EMAIL: GMAIL_EMAIL } = require("./plugin-gogcli-gmail-runtime");
const { GogGmailConnectionController } = require("./plugin-gogcli-gmail-controller");
const { SOURCE_IDENTITY: GMAIL_SOURCE, TRANSPORT: GMAIL_TRANSPORT } =
  require("./plugin-gogcli-gmail-sidecar");
const { loadPluginOAuthProviders } = require("./plugin-oauth-config");
const { loadZoomRegistration, configureZoomRegistration } = require("./plugin-zoom-registration");
const { loadDropboxRegistration, configureDropboxRegistration } =
  require("./plugin-dropbox-registration");
const { SERVER: DROPBOX_MCP_SERVER } = require("./plugin-dropbox-oauth");
const { LovableRegistrationController } = require("./plugin-lovable-registration");
const { HiggsfieldRegistrationController } = require("./plugin-higgsfield-registration");
const { SERVER: HIGGSFIELD_MCP_SERVER } = require("./plugin-higgsfield-official-overlay");
const { SlackRegistrationController } = require("./plugin-slack-registration");
const { reservedEndpointKind, principalMatchesRegistration } =
  require("./plugin-reserved-official-endpoints");
const { getGraphRegistrationStatus, configureGraphRegistration } =
  require("./plugin-graph-registration");
const { PluginDependencyRegistry } = require("./plugin-dependency-registry");
const { PluginDependencyController } = require("./plugin-dependency-controller");
const { PluginDataRollback } = require("./plugin-data-rollback");
const { PluginRollbackController } = require("./plugin-rollback-controller");
const { PluginConnectionController } = require("./plugin-connection-controller");
const { PluginConnectionAuth } = require("./plugin-connection-auth");
const { PluginMcpConnectionManager } = require("./plugin-mcp-connection-manager");
const { PluginMcpConsent } = require("./plugin-mcp-consent");
const { PluginCatalogRestorer } = require("./plugin-catalog-restorer");
const { PluginRuntimeToolService } = require("./plugin-runtime-tool-service");
const { ExternalPluginLeaseManager } = require("./external-plugin-lease");
const { ExternalPluginToolService } = require("./external-plugin-tool-service");
const { ExternalPluginProvenance } = require("./external-plugin-provenance");
const { ExternalPluginSelectionDispatch } = require("./external-plugin-selection-dispatch");
const { ExternalPluginApprovalBroker } = require("./external-plugin-approval-broker");
const { authorizeAdapter: authorizeExternalPluginAdapter } = require("./external-plugin-adapter-auth");
const { PluginAppController } = require("./plugin-app-controller");
const { SystemHostController } = require("./system-host-controller");
const { ComputerUseController } = require("./computer-use-controller");
const { BrowserUseController } = require("./browser-use-controller");
const { BROWSER_SERVICE_METHODS, BROWSER_PUBLIC_MESSAGES,
  validateBrowserState } = require("./browser-use-protocol");
const { COMPUTER_SERVICE_METHODS, handleComputerServiceRequest,
  mapComputerServiceError } = require("./computer-service-protocol");
const { PermissionEngine } = require("./permission-engine");
const { PendingCommandInbox } = require("./pending-command-inbox");
const { TokenUsageStore } = require("./token-usage-store");
const { FederationHostClient } = require("./federation-host-client");
const { AppStateReadService } = require("./app-state-read-service");
const { FederationCoordinator } = require("./federation-coordinator");
const {
  FederationMcpSessionManager,
  ensureFederationMcpCredential,
} = require("./federation-mcp-auth");
const {
  validateUsageBreakdown,
  validateUsageRange,
  validateUsageSeries,
} = require("./token-usage-protocol");
const { WorkRunCoordinator, createWorkRunCoordinator } = require("./work-run-coordinator");
const { createCodexSecurityServiceController, CODEX_SECURITY_STATUS_METHOD,
  CODEX_SECURITY_PUBLIC_MESSAGES } = require("./codex-security-service-controller");
const { ProductMcpApprovalPolicy } = require("./product-mcp-approval-policy");
const { NativeKanbanStore } = require("./native-kanban-store");
const { KanbanRunService } = require("./kanban-run-service");
const { ensureAgentBoard, ensureDefaultAgentBoards } = require("./default-agent-boards");
const { NativeCronStore } = require("./native-cron-store");
const { CodexAutomationController } = require("./codex-automation-controller");
const codexAutomationProtocol = require("./codex-automation-protocol");
const { CodexDesktopSessionController } = require("./codex-desktop-session-controller");
const codexDesktopProtocol = require("./codex-desktop-session-protocol");
const { NativeCronScheduler, describeCronRun } = require("./native-cron-scheduler");
const { DomainWorkRunExecutor } = require("./domain-work-run-executor");
const { NativeDomainServiceController } = require("./native-domain-service-controller");
const {
  DEFAULT_TOOL_REGISTRY,
  McpProductToolController,
  PUBLIC_MESSAGES: MCP_TOOL_PUBLIC_MESSAGES,
} = require("./mcp-product-tool-controller");
const {
  createChatServiceController,
  resolveProfileWorkspace,
} = require("./chat-service-controller");
const { createProfileServiceController } = require("./profile-service-controller");
const { CustomEndpointService } = require("./custom-endpoint-service");
const {
  createAgentLifecycleServiceController,
} = require("./agent-lifecycle-service-controller");
const { AgentArchiveRetention } = require("./agent-archive-retention");
const { AgentHarnessServiceController } = require("./agent-harness-service-controller");
const { CodexSchemaContract } = require("./codex-schema-contract");
const {
  CHAT_SERVICE_METHODS,
  mapChatServiceError,
  validateChatServiceRequest,
  validateChatServiceResult,
} = require("./chat-service-protocol");
const {
  DOMAIN_SERVICE_METHODS,
  mapDomainServiceError,
  validateDomainServiceRequest,
  validateDomainServiceResult,
} = require("./domain-service-protocol");
const {
  PROFILE_SERVICE_METHODS,
  mapProfileServiceError,
  validateProfileServiceParams,
  validateProfileServiceResult,
} = require("./profile-service-protocol");
const {
  RUNTIME_ACCOUNT_SERVICE_METHODS,
  mapRuntimeAccountServiceError,
  validateRuntimeAccountServiceParams,
  validateRuntimeAccountServiceResult,
} = require("./runtime-account-service-protocol");
const {
  AGENT_LIFECYCLE_METHODS,
  mapAgentLifecycleError,
  validateAgentLifecycleParams,
  validateAgentLifecycleResult,
} = require("./agent-lifecycle-service-protocol");
const {
  AGENT_HARNESS_METHODS,
  mapAgentHarnessError,
  validateAgentHarnessParams,
  validateAgentHarnessResult,
} = require("./agent-harness-service-protocol");
const { assertRuntimeProfileId } = require("./codex-runtime-paths");
const {
  acquireInstanceLock,
  defaultProcessIdentity,
  writePrivateToken,
} = require("./instance-state");
const { acquirePrivateWriterLease } = require("./private-writer-lease");
const { atomicWritePrivateFile } = require("./private-file");
const { createServiceStallMonitor } = require("./service-stall-monitor");
const {
  ensurePrivateDirectoryTree,
  lstatIfExists,
  rejectSymlink,
  serviceError,
} = require("./security");
const { SERVICE_PROTOCOL_VERSION: PROTOCOL_VERSION } = require("./service-protocol-version");
const { createExternalProviderCredentialRpc } = require("./external-provider-credential-rpc");
const { createExternalProviderWriterVerifier } = require("./external-provider-credential-writer");

const MAX_FRAME_BYTES = 64 * 1024;
const MAX_SECRET_SCAN_BYTES = 64 * 1024;
const MAX_SUMMARY_SCAN_BYTES = 16 * 1024;
const MAX_STARTUP_ERROR_PROTOTYPE_DEPTH = 16;
const DEFAULT_MCP_AUTH_INIT_TIMEOUT_MS = 9_000;
const PERSISTENT_WRITER_LOCK_BASENAMES = Object.freeze([
  "chat-sessions.writer.lock",
  "inspirations.writer.lock",
  "proactive.writer.lock",
  "self-improvement.writer.lock",
  "native-cron.writer.lock",
  "native-kanban.writer.lock",
  "pending-commands.writer.lock",
]);
const CHAT_SERVICE_METHOD_SET = new Set(CHAT_SERVICE_METHODS);
const INSPIRATION_SERVICE_METHOD_SET = new Set(INSPIRATION_SERVICE_METHODS);
const DOMAIN_SERVICE_METHOD_SET = new Set(DOMAIN_SERVICE_METHODS);
const PROFILE_SERVICE_METHOD_SET = new Set(PROFILE_SERVICE_METHODS);
const RUNTIME_ACCOUNT_SERVICE_METHOD_SET = new Set(RUNTIME_ACCOUNT_SERVICE_METHODS);
const PLUGIN_SERVICE_METHOD_SET = new Set(PLUGIN_SERVICE_METHODS);
// Calls that stay open while the user answers a Service-raised card in chat.
const USER_WAIT_TOOL_NAMES = new Set(["browser_session_wait_for_user", "plugin_secret_request", "workspace_execute"]);
const AGENT_LIFECYCLE_METHOD_SET = new Set(AGENT_LIFECYCLE_METHODS);
const AGENT_HARNESS_METHOD_SET = new Set(AGENT_HARNESS_METHODS);
const DOMAIN_RUNTIME_FATAL_REASON = "runtime_fatal";
const MCP_SERVICE_METHODS = new Set([
  "group.adapter.register", "group.adapter.unregister", "group.adapter.call",
  "mcp.runtime.bridge.open", "mcp.runtime.gate.consume", "mcp.auth.challenge", "mcp.auth.exchange",
  "mcp.federation.open", "mcp.profile.get", "mcp.tool.call",
  "mcp.group.exposure",
  "plugin.external.open", "plugin.external.search", "plugin.external.skill.read",
  "plugin.external.skill.file.read", "plugin.external.resource.read",
  "plugin.external.call", "plugin.external.cancel",
  "plugin.external.selection.bind", "plugin.external.selection.finish",
]);
const PLUGIN_PUBLIC_MESSAGES = Object.freeze({
  PLUGIN_REQUEST_INVALID: "插件管理参数无效",
  PLUGIN_RESPONSE_TOO_LARGE: "插件管理响应超出容量上限",
  EXTERNAL_PLUGIN_AUDIT_UNAVAILABLE: "外部插件调用记录不可用",
  EXTERNAL_PLUGIN_SELECTION_INVALID: "插件选择派发已失效或结果尚待核实",
  EXTERNAL_PLUGIN_SELECTION_CONFLICT: "同一操作的插件选择已变化，不能重复派发",
  EXTERNAL_PLUGIN_SELECTION_BUSY: "待处理的插件选择过多，请稍后重试",
  EXTERNAL_PLUGIN_SELECTION_UNAVAILABLE: "外部插件选择派发不可用",
  EXTERNAL_PLUGIN_SELECTION_STORE_INVALID: "外部插件选择记录无法验证",
  PLUGIN_SELECTION_INVALID: "插件选择参数无效",
  PLUGIN_SELECTION_STALE: "所选插件已变化，请重新选择",
  PLUGIN_SELECTION_UNAVAILABLE: "所选插件尚无可用能力，请查看插件设置",
  CAPABILITY_FORBIDDEN: "插件调用已拒绝或授权失效",
  GRANT_REVOKED: "插件工具授权已撤销",
  MCP_TOOL_CAPACITY: "逐次审批参数超过完整展示上限",
  REVISION_CONFLICT: "插件目录或安装版本已变化，请重新读取",
  PACKAGE_CHANGED: "插件与预览不一致，请重新预览",
  PACKAGE_INVALID: "插件包无效",
  PACKAGE_PATH_INVALID: "插件包路径不安全",
  GIT_SOURCE_INVALID: "Git 来源必须是安全 HTTPS 地址、完整提交 SHA 和包内子目录",
  GIT_REMOTE_CANCELLED: "远程 Git 获取已取消",
  GIT_REMOTE_FAILED: "无法获取指定 Git 提交",
  GIT_REMOTE_TIMEOUT: "远程 Git 获取超时",
  GIT_REMOTE_TOO_LARGE: "远程 Git 仓库超过容量上限",
  GIT_REMOTE_LOG_LIMIT: "远程 Git 输出超过容量上限",
  GIT_REMOTE_LIMIT: "远程 Git 获取并发已达上限",
  GIT_REMOTE_EXIT_UNKNOWN: "远程 Git 进程退出未确认，已停止清理",
  PLUGIN_OPERATION_INVALID: "插件操作参数无效",
  PLUGIN_OPERATION_FAILED: "此前插件操作已失败，请新建操作",
  PLUGIN_OPERATION_OUTCOME_UNKNOWN: "恢复前的操作结果待核对，不能自动重试",
  PLUGIN_INSTALLATION_INVALID: "插件安装不存在",
  PLUGIN_BINDING_INVALID: "插件 Skill 绑定无效",
  PLUGIN_GRANT_INVALID: "插件工具授权无效",
  PLUGIN_COMPONENT_INACTIVE: "插件安装尚未启用",
  PLUGIN_COMPONENT_REVISION_CHANGED: "插件组件已变化，请重新读取",
  ACTIVATION_DEFERRED: "插件连接仍被使用，等待释放后重试",
  PLUGIN_UPDATE_REQUIRES_DISABLE: "更新前必须先停用能力包并排空旧连接",
  PLUGIN_UNINSTALL_REQUIRES_DISABLE: "卸载前必须先停用能力包并排空旧连接",
  LEGACY_SOURCE_OVERLAP: "导入来源不能与插件存储目录重叠",
  MCP_APP_AUTHORITY_INVALID: "交互界面不属于当前会话或授权",
  MCP_APP_AUTHORITY_REVOKED: "交互界面授权已失效",
  MCP_APP_RESOURCE_FORBIDDEN: "工具未提供可用的交互界面",
  MCP_APP_RESOURCE_INVALID: "交互界面资源无效",
  MCP_APP_SESSION_EXPIRED: "交互界面会话已过期",
  MCP_APP_TRANSPORT_INVALID: "交互界面来源无效",
  MCP_APP_LIMIT: "交互界面超过容量限制",
  MCP_APP_UNSUPPORTED: "连接未提供交互界面支持",
  MCP_APP_SEED_UNAVAILABLE: "交互界面原始结果已不可用，请查看文本结果",
  PLUGIN_CONNECTION_CLOSE_FAILED: "插件连接退出未确认，停用未完成",
  PLUGIN_SERVICE_FAILED: "插件管理操作失败",
  MCP_SERVER_EXITED: "MCP 连接已关闭",
  MCP_SERVER_RESPONSE_INVALID: "MCP 服务响应无效",
  MCP_SERVER_RESPONSE_TOO_LARGE: "MCP 服务响应超过容量上限",
  PLUGIN_CONSENT_EXPIRED: "授权确认已过期，请重试",
  PLUGIN_CONSENT_BUSY: "待确认授权过多，请稍后重试",
  PLUGIN_OAUTH_PROVIDER_UNSUPPORTED: "此 HTTP 服务尚未配置受信认证信息",
  PLUGIN_BEARER_PROVIDER_UNSUPPORTED: "仅受信内置 GitHub 或 Cloudflare MCP 支持令牌连接",
  PLUGIN_CONNECTION_LIMIT: "待连接的插件账号过多，请稍后重试",
  PLUGIN_OAUTH_CONFIG_INVALID: "插件认证服务配置无效",
  DROPBOX_REGISTRATION_INVALID: "Dropbox 客户端登记无效或已存在",
  GRAPH_REGISTRATION_INVALID: "Microsoft Graph 客户端 ID 无效",
  GRAPH_REGISTRATION_CONFLICT: "Microsoft Graph 客户端或共享账号已存在，不能覆盖",
  GMAIL_RUNTIME_UNAVAILABLE: "固定版本 gog 运行文件不可用",
  GMAIL_REGISTRATION_INVALID: "Gmail Desktop OAuth 客户端文件无效",
  GMAIL_REGISTRATION_CONFLICT: "Gmail 客户端已登记，不能覆盖",
  GMAIL_CAPABILITIES_INVALID: "Gmail 权限设置无效",
  GMAIL_AUTH_INVALID: "Gmail 账号地址无效",
  GMAIL_AUTH_FAILED: "Gmail 登录或账号验证未成功",
  GMAIL_AUTH_CANCELED: "Gmail 登录已取消",
  GMAIL_AUTH_CONFLICT: "另一项 Gmail 登录正在进行",
  GMAIL_AUTH_RECOVERY_REQUIRED: "本机 Gmail 凭据状态待人工核验，完成清理前不能继续连接",
  GMAIL_AUTH_FLOW_NOT_FOUND: "Gmail 登录流程已失效",
  FIGMA_DESKTOP_IDENTITY_UNVERIFIED: "无法验证 Figma 桌面 MCP 监听进程，请确认官方 Figma 桌面版已启动并启用本地 MCP",
  LOVABLE_REGISTRATION_INVALID: "Lovable 本机回调端口无效",
  LOVABLE_REGISTRATION_CONFLICT: "Lovable 客户端或旧账号绑定已存在，不能覆盖",
  LOVABLE_REGISTRATION_BUSY: "Lovable 客户端登记正在进行，请稍后查询状态",
  LOVABLE_REGISTRATION_NEEDS_VERIFICATION: "Lovable 远端登记结果不确定，请先人工核对再继续",
  HIGGSFIELD_REGISTRATION_INVALID: "Higgsfield 本机回调端口无效",
  HIGGSFIELD_REGISTRATION_CONFLICT: "Higgsfield 客户端或旧账号绑定已存在，不能覆盖",
  HIGGSFIELD_REGISTRATION_BUSY: "Higgsfield 客户端登记正在进行，请稍后查询状态",
  HIGGSFIELD_REGISTRATION_NEEDS_VERIFICATION: "Higgsfield 远端登记结果不确定，请先人工核对再继续",
  SLACK_REGISTRATION_INVALID: "Slack 内部应用登记无效",
  SLACK_REGISTRATION_CONFLICT: "Slack 客户端或旧账号绑定已存在，不能覆盖",
  OUTLOOK_CALENDAR_CONFIG_INVALID: "Microsoft Graph 私有客户端配置无效",
  PLUGIN_OAUTH_FLOW_NOT_FOUND: "账号连接流程已失效，请重新连接",
  CONNECTION_AUTH_REQUIRED: "此连接需要完成账号认证",
  CONNECTION_IDENTITY_CHANGED: "连接身份已变化，请重新连接",
  TOOL_CONTRACT_CHANGED: "工具合同已变化，请重新发现工具",
  DEPENDENCY_PREPARATION_REQUIRED: "启动命令需要固定版本的依赖准备",
  DEPENDENCY_MISSING: "插件启动文件不可用",
  DEPENDENCY_REQUIRES_DISABLE: "准备或撤销依赖前，请先停用能力包",
  DEPENDENCY_CHANGED: "解释器或依赖登记已变化，请重新准备",
  DEPENDENCY_EXECUTABLE_INVALID: "所选解释器不可用或路径不安全",
  DEPENDENCY_INTERPRETER_UNSUPPORTED: "仅支持固定 Node 或 Python 解释器运行包内脚本",
  DEPENDENCY_ARGUMENTS_UNSUPPORTED: "此组件启动参数不支持固定解释器准备",
  DEPENDENCY_ENV_UNSUPPORTED: "此组件环境变量不支持固定解释器准备",
  DEPENDENCY_PROBE_FAILED: "解释器版本检查未通过",
  DEPENDENCY_REGISTRY_INVALID: "插件依赖登记无法验证",
  DEPENDENCY_REGISTRY_LIMIT: "插件依赖登记已达容量上限",
  DEPENDENCY_CONFIRMATION_REQUIRED: "准备依赖需要原生确认",
  DEPENDENCY_INTERPRETER_NOT_FOUND: "未找到可用的 Node.js 或 Python，请先安装后重试",
  PLUGIN_SECRET_REQUIRED: "插件凭据尚未配置",
  PLUGIN_SECRET_INVALID: "插件凭据名称无效",
  PLUGIN_SECRET_VALUE_INVALID: "凭据需为 8 个字符以上的单行文本，且不超过 16 KiB",
  PLUGIN_SECRET_REJECTED: "插件的 MCP 服务拒绝了已保存的凭据（401/403）。请让用户更新凭据（plugin_secret_request 或插件页），不要用同一个值重试",
  PLUGIN_SECRET_NOT_DECLARED: "插件没有声明这个凭据",
  FIRST_PARTY_PLUGIN_NOT_FOUND: "Shoggoth 内置插件不存在",
});

function recoverStalePersistentWriterLeases(paths) {
  for (const lockBasename of PERSISTENT_WRITER_LOCK_BASENAMES) {
    const lease = acquirePrivateWriterLease({
      lockPath: path.join(paths.stateDir, lockBasename),
      trustedRoot: paths.trustedRoot,
    });
    lease.release();
  }
}
const MCP_PUBLIC_ERROR_CODES = new Set([
  ...require("./hook-contract").HOOK_PUBLIC_ERROR_CODES,
  "MCP_AUTH_BUSY",
  "MCP_AUTH_FAILED",
  "MCP_AUTH_REQUEST_INVALID",
  "MCP_SESSION_INVALID",
  "EXTERNAL_PLUGIN_LEASE_INVALID", "EXTERNAL_PLUGIN_LEASE_BUSY",
  "EXTERNAL_PLUGIN_AUDIT_UNAVAILABLE",
  "EXTERNAL_PLUGIN_SELECTION_INVALID", "EXTERNAL_PLUGIN_SELECTION_CONFLICT",
  "EXTERNAL_PLUGIN_SELECTION_BUSY", "EXTERNAL_PLUGIN_SELECTION_UNAVAILABLE",
  "EXTERNAL_PLUGIN_SELECTION_STORE_INVALID", "PLUGIN_SELECTION_INVALID", "PLUGIN_SELECTION_STALE",
  "PLUGIN_SELECTION_UNAVAILABLE",
  "CAPABILITY_FORBIDDEN", "GRANT_REVOKED", "TOOL_CONTRACT_CHANGED",
  "CATALOG_REVISION_CHANGED",
  "CALL_ALREADY_RECORDED", "PLUGIN_RUNTIME_CAPACITY",
  ...Object.keys(MCP_TOOL_PUBLIC_MESSAGES),
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const AUTH_PUBLIC_ERROR_CODES = new Set([
  "AUTH_ACCOUNT_RESPONSE_INVALID",
  "AUTH_CANCEL_FAILED",
  "AUTH_LOGIN_CANCELED",
  "AUTH_LOGIN_IN_PROGRESS",
  "AUTH_LOGIN_NOT_ACTIVE",
  "AUTH_LOGIN_NOT_FOUND",
  "AUTH_LOGIN_TIMEOUT",
]);
const PROVIDER_PUBLIC_ERROR_CODES = new Set([
  "MODEL_PROVIDER_IN_USE",
  "PROVIDER_AGENT_VALIDATION_NOT_RUN",
  "PROVIDER_AGENT_VALIDATION_OPT_IN_REQUIRED",
  "PROVIDER_AUTH_HOST_INVALID",
  "PROVIDER_AUTH_RESPONSE_INVALID",
  "PROVIDER_BASE_URL_ENDPOINT_FORBIDDEN",
  "PROVIDER_BASE_URL_INVALID",
  "PROVIDER_BASE_URL_REQUIRED",
  "PROVIDER_COMMIT_UNCERTAIN",
  "PROVIDER_CREDENTIAL_REQUIRED",
  "PROVIDER_KIND_IMMUTABLE",
  "PROVIDER_CREDENTIAL_INVALID",
  "PROVIDER_MODEL_REQUIRED",
  "PROVIDER_NOT_FOUND",
  "PROVIDER_OPERATION_STALE",
  "PROVIDER_PRESET_INVALID",
  "PROVIDER_PRESET_OVERRIDE_FORBIDDEN",
  "PROVIDER_PROTOCOL_CONFIG_INVALID",
  "PROVIDER_PUBLIC_PRODUCT_URL_REQUIRED",
  "PROVIDER_RUNTIME_PROFILE_MISMATCH",
  "PROVIDER_SECRET_AUTHORITY_FORBIDDEN",
  "PROVIDER_SECRET_CAPACITY_EXCEEDED",
  "PROVIDER_SECRET_PARAMS_INVALID",
  "PROVIDER_SERVICE_CLOSING",
  "PROVIDER_VALIDATION_PARAMS_INVALID",
  "PROVIDER_VALIDATION_STALE",
]);

function exactObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function cloneMcpToolResult(value, state = { nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > 16_384 || depth > 32) {
    throw serviceError("MCP_TOOL_RESPONSE_INVALID", MCP_TOOL_PUBLIC_MESSAGES.MCP_TOOL_RESPONSE_INVALID);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!value.isWellFormed()) {
      throw serviceError("MCP_TOOL_RESPONSE_INVALID", MCP_TOOL_PUBLIC_MESSAGES.MCP_TOOL_RESPONSE_INVALID);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw serviceError("MCP_TOOL_RESPONSE_INVALID", MCP_TOOL_PUBLIC_MESSAGES.MCP_TOOL_RESPONSE_INVALID);
    }
    return value;
  }
  if (Array.isArray(value)) {
    let keys;
    let lengthDescriptor;
    try {
      keys = Reflect.ownKeys(value);
      lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    } catch {
      throw serviceError("MCP_TOOL_RESPONSE_INVALID", MCP_TOOL_PUBLIC_MESSAGES.MCP_TOOL_RESPONSE_INVALID);
    }
    const length = lengthDescriptor && Object.prototype.hasOwnProperty.call(lengthDescriptor, "value")
      ? lengthDescriptor.value : -1;
    if (keys.some((key) => key !== "length"
      && !(typeof key === "string" && /^(?:0|[1-9][0-9]*)$/u.test(key)))
      || !Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1) {
      throw serviceError("MCP_TOOL_RESPONSE_INVALID", MCP_TOOL_PUBLIC_MESSAGES.MCP_TOOL_RESPONSE_INVALID);
    }
    const result = [];
    for (let index = 0; index < length; index += 1) {
      let descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(value, String(index)); } catch {
        throw serviceError("MCP_TOOL_RESPONSE_INVALID", MCP_TOOL_PUBLIC_MESSAGES.MCP_TOOL_RESPONSE_INVALID);
      }
      if (!descriptor || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        throw serviceError("MCP_TOOL_RESPONSE_INVALID", MCP_TOOL_PUBLIC_MESSAGES.MCP_TOOL_RESPONSE_INVALID);
      }
      result.push(cloneMcpToolResult(descriptor.value, state, depth + 1));
    }
    return result;
  }
  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw serviceError("MCP_TOOL_RESPONSE_INVALID", MCP_TOOL_PUBLIC_MESSAGES.MCP_TOOL_RESPONSE_INVALID);
  }
  if (prototype !== Object.prototype
    || keys.some((key) => typeof key !== "string")) {
    throw serviceError("MCP_TOOL_RESPONSE_INVALID", MCP_TOOL_PUBLIC_MESSAGES.MCP_TOOL_RESPONSE_INVALID);
  }
  const result = {};
  for (const key of keys) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch {
      throw serviceError("MCP_TOOL_RESPONSE_INVALID", MCP_TOOL_PUBLIC_MESSAGES.MCP_TOOL_RESPONSE_INVALID);
    }
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")
      || descriptor.enumerable !== true) {
      throw serviceError("MCP_TOOL_RESPONSE_INVALID", MCP_TOOL_PUBLIC_MESSAGES.MCP_TOOL_RESPONSE_INVALID);
    }
    Object.defineProperty(result, key, {
      value: cloneMcpToolResult(descriptor.value, state, depth + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function probeDataProperty(target, property) {
  try {
    if ((typeof target !== "object" && typeof target !== "function") || target === null) {
      return { ok: true, found: false, value: undefined };
    }
    const seen = new Set();
    let cursor = target;
    for (let depth = 0; depth < MAX_STARTUP_ERROR_PROTOTYPE_DEPTH; depth += 1) {
      if (seen.has(cursor)) return { ok: false, found: false, value: undefined };
      seen.add(cursor);
      const descriptor = Object.getOwnPropertyDescriptor(cursor, property);
      if (descriptor) {
        if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) {
          return { ok: false, found: true, value: undefined };
        }
        return { ok: true, found: true, value: descriptor.value };
      }
      cursor = Object.getPrototypeOf(cursor);
      if (cursor === null) return { ok: true, found: false, value: undefined };
    }
    return { ok: false, found: false, value: undefined };
  } catch {
    return { ok: false, found: false, value: undefined };
  }
}

function sanitizedDomainStartupHealthError(domain, error) {
  const upper = domain.toUpperCase();
  const label = domain === "kanban" ? "Kanban" : "Cron";
  const codeProbe = probeDataProperty(error, "code");
  if (codeProbe.ok && codeProbe.value === `${upper}_SENSITIVE_CHECK_FAILED`) return null;
  let code = `${upper}_UNAVAILABLE`;
  let message = `${label} Service 暂时不可用`;
  if (codeProbe.ok && codeProbe.value === `${upper}_COMMIT_UNCERTAIN`) {
    code = codeProbe.value;
    message = `${label} 持久化状态不确定，必须重启 Service`;
  } else if (codeProbe.ok && codeProbe.value === `${upper}_STORE_CORRUPT`) {
    code = codeProbe.value;
    message = `${label} 持久化存储损坏，必须重启 Service`;
  }
  return Object.freeze(serviceError(code, message));
}

function validRuntimeProfileId(value) {
  try { assertRuntimeProfileId(value); return true; } catch { return false; }
}

function authParamsValid(method, params) {
  if (method === "auth.read" || method === "auth.logout") {
    return exactObject(params, ["runtimeProfileId"])
      && validRuntimeProfileId(params.runtimeProfileId);
  }
  if (method === "auth.login.start") {
    return exactObject(params, ["runtimeProfileId", "mode"])
      && validRuntimeProfileId(params.runtimeProfileId)
      && (params.mode === "browser" || params.mode === "deviceCode");
  }
  if (method === "auth.login.cancel") {
    return exactObject(params, ["runtimeProfileId", "requestId"])
      && validRuntimeProfileId(params.runtimeProfileId)
      && typeof params.requestId === "string"
      && params.requestId.length > 0 && params.requestId.length <= 128
      && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(params.requestId);
  }
  return false;
}

function providerParamsValid(method, params) {
  if (method === "provider.list") return exactObject(params, []);
  if (method === "provider.save") {
    return exactObject(params, ["provider"])
      && params.provider && typeof params.provider === "object" && !Array.isArray(params.provider)
      && Object.getPrototypeOf(params.provider) === Object.prototype;
  }
  if (method === "provider.delete") {
    return exactObject(params, ["providerId"]) && validBoundedString(params.providerId, 128);
  }
  if (method === "provider.secret.set") {
    return (exactObject(params, ["providerId", "secret"])
      || exactObject(params, ["providerId", "runtimeProfileId", "secret"]))
      && validBoundedString(params.providerId, 128)
      && validBoundedString(params.secret, 64 * 1024)
      && (!Object.prototype.hasOwnProperty.call(params, "runtimeProfileId")
        || validRuntimeProfileId(params.runtimeProfileId));
  }
  if (method === "provider.secret.clear") {
    return (exactObject(params, ["providerId"])
      || exactObject(params, ["providerId", "runtimeProfileId"]))
      && validBoundedString(params.providerId, 128)
      && (!Object.prototype.hasOwnProperty.call(params, "runtimeProfileId")
        || validRuntimeProfileId(params.runtimeProfileId));
  }
  if (method === "provider.validate") {
    return (exactObject(params, ["providerId", "level"])
      || exactObject(params, ["providerId", "level", "allowPaidModelRequest"]))
      && validBoundedString(params.providerId, 128)
      && (params.level === "protocol" || params.level === "agent")
      && (!Object.prototype.hasOwnProperty.call(params, "allowPaidModelRequest")
        || typeof params.allowPaidModelRequest === "boolean");
  }
  return false;
}

function validatedProviderResult(method, result) {
  try {
    if (method === "provider.list") {
      if (!Array.isArray(result)) throw new Error("invalid provider list");
      return result.map((provider) => validateModelProvider(provider));
    }
    if (method === "provider.validate") {
      if (!exactObject(result, ["providerId", "validationStatus", "parsedBy"])
        || !validBoundedString(result.providerId, 128)
        || result.validationStatus !== "protocol_valid"
        || result.parsedBy !== "codex-0.159.2") throw new Error("invalid validation result");
      return { ...result };
    }
    if (method === "provider.delete" && result === null) return null;
    return validateModelProvider(result);
  } catch {
    throw serviceError("PROVIDER_RESPONSE_INVALID", "Provider operation response is invalid");
  }
}

function validBoundedString(value, maxBytes) {
  return typeof value === "string" && value.length > 0
    && Buffer.byteLength(value, "utf8") <= maxBytes && value.isWellFormed();
}

function validAuthDisplayString(value, maxBytes) {
  return validBoundedString(value, maxBytes) && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validAuthUrl(value) {
  if (!validAuthDisplayString(value, 4096)) return false;
  let parsed;
  try { parsed = new URL(value); } catch { return false; }
  return (parsed.protocol === "http:" || parsed.protocol === "https:")
    && Boolean(parsed.hostname) && !parsed.username && !parsed.password;
}

function validateAuthResult(method, result) {
  if (method === "auth.read") {
    if (!exactObject(result, ["account", "requiresOpenaiAuth", "login",
      ...(result?.authSource === undefined ? [] : ["authSource"])])
      || (result.authSource !== undefined
        && (result.authSource !== "native-codex" || result.account?.type !== "chatgpt"))
      || typeof result.requiresOpenaiAuth !== "boolean") return false;
    if (result.account !== null) {
      if (!result.account || typeof result.account !== "object" || Array.isArray(result.account)) return false;
      if (result.account.type === "chatgpt") {
        if (!exactObject(result.account,
          result.account.planType === undefined ? ["type"] : ["type", "planType"])) return false;
        if (result.account.planType !== undefined && !validBoundedString(result.account.planType, 64)) return false;
      } else if (result.account.type === "apiKey") {
        if (!exactObject(result.account, ["type"])) return false;
      } else if (result.account.type === "amazonBedrock") {
        if (!exactObject(result.account, ["type", "usesCodexManagedCredentials"])
          || typeof result.account.usesCodexManagedCredentials !== "boolean") return false;
      } else return false;
    }
    if (result.login !== null) {
      if (!exactObject(result.login, ["requestId", "mode", "status", "updatedAt", "errorCode"])
        || !validBoundedString(result.login.requestId, 128)
        || !["browser", "deviceCode"].includes(result.login.mode)
        || !["starting", "waiting", "succeeded", "failed", "canceling", "canceled",
          "timed_out", "interrupted", "unknown"].includes(result.login.status)
        || !Number.isSafeInteger(result.login.updatedAt) || result.login.updatedAt < 0
        || (result.login.errorCode !== null
          && (!validBoundedString(result.login.errorCode, 64)
            || !/^[A-Z][A-Z0-9_]*$/u.test(result.login.errorCode)))) return false;
    }
    return true;
  }
  if (method === "auth.login.start") {
    if (!result || typeof result !== "object" || Array.isArray(result)
      || !validBoundedString(result.requestId, 128)
      || !["browser", "deviceCode"].includes(result.mode)
      || !["waiting", "succeeded", "failed"].includes(result.status)
      || !validBoundedString(result.loginId, 256)) return false;
    if (result.mode === "browser") {
      return exactObject(result, ["requestId", "mode", "status", "loginId", "authUrl"])
        && validAuthUrl(result.authUrl);
    }
    return exactObject(result, [
      "requestId", "mode", "status", "loginId", "verificationUrl", "userCode",
    ]) && validAuthUrl(result.verificationUrl)
      && validAuthDisplayString(result.userCode, 256);
  }
  if (method === "auth.login.cancel") {
    return exactObject(result, ["requestId", "status"])
      && validBoundedString(result.requestId, 128)
      && ["succeeded", "failed", "canceled", "timed_out", "interrupted", "unknown"]
        .includes(result.status);
  }
  return method === "auth.logout" && exactObject(result, ["loggedOut"])
    && result.loggedOut === true;
}

function tokensEqual(left, right) {
  const a = Buffer.from(typeof left === "string" ? left : "");
  const b = Buffer.from(typeof right === "string" ? right : "");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sanitizeMcpProfile(profile) {
  return {
    id: profile.id,
    agentId: profile.agentId,
    name: profile.name,
    runtimeProfileId: profile.runtimeProfileId,
    runtimeAccountId: profile.runtimeAccountId,
    defaultModel: profile.defaultModel,
    defaultCwd: profile.defaultCwd,
    permissionPolicy: profile.permissionPolicy,
    concurrency: profile.concurrency,
    isDefault: profile.isDefault,
    enabled: profile.enabled,
  };
}

function attachAcceptedSocketErrorGuard(socket, cleanup) {
  socket.on("error", () => {
    cleanup();
    socket.destroy();
  });
}

function stableJsonForSecretScan(value, maxBytes = MAX_SECRET_SCAN_BYTES) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch {
    throw serviceError("RUN_EVENT_SECRET_REJECTED", "敏感信息检查输入不是稳定 JSON");
  }
  if (typeof serialized !== "string"
    || Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw serviceError("RUN_EVENT_SECRET_REJECTED", "敏感信息检查输入超过上限");
  }
  let parsed;
  try { parsed = JSON.parse(serialized); } catch {
    throw serviceError("RUN_EVENT_SECRET_REJECTED", "敏感信息检查输入不是稳定 JSON");
  }
  if (JSON.stringify(parsed) !== serialized) {
    throw serviceError("RUN_EVENT_SECRET_REJECTED", "敏感信息检查输入不是稳定 JSON");
  }
  return { serialized, parsed };
}

function stableJsonContainsMatchedString(value, matches) {
  const stack = [value];
  let visited = 0;
  while (stack.length > 0) {
    visited += 1;
    if (visited > 8192) return true;
    const current = stack.pop();
    if (typeof current === "string") {
      if (matches(current)) return true;
    } else if (current && typeof current === "object") {
      for (const [key, child] of Object.entries(current)) {
        if (matches(key)) return true;
        stack.push(child);
      }
    }
  }
  return false;
}

function isNativeFederationChatRun(run) {
  return run?.source === "chat" && typeof run.idempotencyKey === "string"
    && /^shoggoth:chat-send:federation-(?:send|message)-/u.test(run.idempotencyKey);
}

function candidateSessionForCompletedRun(run, payload, chatSessionStore, inspirationStore) {
  if (payload?.status !== "completed" || !["chat", "inspiration"].includes(run?.source)
    || isNativeFederationChatRun(run)) return null;
  let sessionKey = run.sourceId;
  if (run.source === "inspiration") {
    let origin;
    try { origin = inspirationStore.executionForRun(run.id); } catch { return null; }
    if (origin?.runId !== run.id || origin.profileId !== run.profileId
      || origin.workspace !== run.workspace || origin.ideaId !== run.sourceId
      || origin.inputSource !== "chat") return null;
    sessionKey = origin.sessionKey;
  }
  let session;
  try { session = sessionKey && chatSessionStore.getSession(sessionKey); } catch { return null; }
  return session && session.profileId === run.profileId && session.workspace === run.workspace
    && ["ready", "archived"].includes(session.status) ? session : null;
}

function createAgentService(options) {
  const { paths } = options;
  const nativeRuntimeConfig = options.nativeRuntimeConfig || new NativeRuntimeConfig({ paths,
    onApplied: () => workRunCoordinator.capacityChanged?.(),
  });
  const getNativeRuntimeConfig = () => nativeRuntimeConfig.read();
  const nativeMemoryConfig = new NativeMemoryConfig({ paths });
  const chatUiConfig = new ChatUiConfig({ paths, onApplied: value => { if (!value.config.nativeChatUiV1) chatUiController?.revokeAll("UI_FEATURE_DISABLED"); } });
  const nativeMemorySharingConfig = new NativeMemorySharingConfig({ paths, featureReady: options.memorySharingFeatureReady !== false });
  const startupGate = new RuntimeStartupGate({ getConfig: getNativeRuntimeConfig });
  const poolCapacityOptions = {
    resolveMaxHosts: () => {
      const config = getNativeRuntimeConfig();
      return config.flags.runtimeAdmissionV1 ? Math.min(128, config.maxActive + 16) : 16;
    },
    canRetireHost(binding, host) {
      if ((!getNativeRuntimeConfig().flags.runtimeAdmissionV1 && !host.mcpExecutionRunId)
        || lifecycleState !== "started"
        || (runtimeManager.isBindingActive ? runtimeManager.isBindingActive(binding) : activeRuntimeRequests > 0)
        || !runtimeAccountActivityKnown(binding)) return false;
      return workRunCoordinator.isRuntimeHostIdle?.(binding, host) === true;
    },
  };
  const repoRoot = options.repoRoot || path.join(__dirname, "..", "..");
  const serviceVersion = String(options.version || "0.0.0");
  const frameTimeoutMs = options.frameTimeoutMs ?? 2000;
  const mcpAuthInitTimeoutMs = options.mcpAuthInitTimeoutMs ?? DEFAULT_MCP_AUTH_INIT_TIMEOUT_MS;
  if (!Number.isSafeInteger(mcpAuthInitTimeoutMs) || mcpAuthInitTimeoutMs <= 0
    || mcpAuthInitTimeoutMs > 90_000) {
    throw serviceError("MCP_AUTH_TIMEOUT_INVALID", "mcp_auth_timeout_invalid");
  }
  const lockProbeTimeoutMs = options.lockProbeTimeoutMs ?? 750;
  const closeTimeoutMs = options.closeTimeoutMs ?? 1000;
  const getProcessIdentity = options.getProcessIdentity || defaultProcessIdentity;
  const cleanupFs = options.cleanupFs || fs;
  const cleanupLstatIfExists = cleanupFs.lstatIfExists || lstatIfExists;
  const instanceNonce = crypto.randomBytes(24).toString("hex");
  let server = null;
  let lockFd = null;
  let ownedLockIdentity = null;
  let ownedSocketIdentity = null;
  let ownedTokenIdentity = null;
  let token = null;
  let startedAt = null;
  let stopping = null;
  let startPromise = null;
  let lifecycleState = "stopped";
  // Records loop blocks long enough for the App to report a lost Service.
  const stallMonitor = options.stallMonitor || createServiceStallMonitor({ paths });
  let activeRuntimeRequests = 0;
  let lifecycleGeneration = 0;
  let mcpTransportReady = false;
  const runtimeTelemetry = new (require("./runtime-telemetry").RuntimeTelemetry)({ now: options.now,
    sink: event => eventBuffer.append(event.name, event) });
  const externalCryptoBroker = options.cryptoBroker || options.mcpCryptoBroker || null;
  const mcpAuthSecretStore = options.mcpAuthSecretStore || (externalCryptoBroker ? null
    : new McpAuthSecretStore({
      paths,
      access: "service",
      safeStorage: options.safeStorage,
      fs: options.mcpAuthFs,
    }));
  const mcpCryptoBroker = require("./runtime-telemetry").observeCryptoBroker(externalCryptoBroker || new InProcessMcpCryptoBroker({
    paths,
    safeStorage: options.safeStorage,
    fs: options.mcpAuthFs,
    store: mcpAuthSecretStore,
  }), runtimeTelemetry);
  const secretStore = options.secretStore || new EncryptedSecretStore({
    paths,
    cryptoBroker: mcpCryptoBroker,
    fs: options.secretFs,
  });
  // Only the authenticated file-token IPC path may mint these private request
  // brands. A renderer, plugin manifest or Backend command cannot create one.
  let externalProviderWriterVerifier = null;
  let externalProviderCredentialRpcOpened = false;
  let externalProviderCredentialGeneration = null;
  const externalProviderCredentialRpc = createExternalProviderCredentialRpc({
    paths, secretStore,
    assertServiceCurrent: () => externalProviderCredentialRpcOpened && externalProviderWriterVerifier !== null
      && lifecycleState === "started" && !maintenanceQuiesced
      && lifecycleGeneration === externalProviderCredentialGeneration,
    getServiceIdentity: () => ({ instanceNonce, pid: process.pid, startedAt, protocolVersion: PROTOCOL_VERSION }),
    verifyManagedWriter: (writer, context) => {
      if (!externalProviderWriterVerifier) throw serviceError("EXTERNAL_PROVIDER_CREDENTIAL_UNAVAILABLE", "受管凭据核验尚未就绪");
      return externalProviderWriterVerifier.verify(writer, context);
    },
  });
  const openClawAuthProfileCredentialRpc = createExternalProviderCredentialRpc({
    namespace: "auth-profile", paths, secretStore,
    assertServiceCurrent: () => externalProviderCredentialRpcOpened && externalProviderWriterVerifier !== null
      && lifecycleState === "started" && !maintenanceQuiesced
      && lifecycleGeneration === externalProviderCredentialGeneration,
    getServiceIdentity: () => ({ instanceNonce, pid: process.pid, startedAt, protocolVersion: PROTOCOL_VERSION }),
    verifyManagedWriter: (writer, context) => {
      if (!externalProviderWriterVerifier) throw serviceError("EXTERNAL_PROVIDER_CREDENTIAL_UNAVAILABLE", "受管凭据核验尚未就绪");
      return externalProviderWriterVerifier.verify(writer, context);
    },
  });
  const runExecutionStore = options.runExecutionStore || new RunExecutionStore({ paths, cryptoBroker: mcpCryptoBroker });
  const beforeCreateBuiltinAgentProfile = (profile) => assignBuiltinAgentAvatar(profile, paths);
  const productStore = options.productStore || new JsonlProductStore({
    paths, beforeCreateDefaultAgentProfile: beforeCreateBuiltinAgentProfile,
  });
  if (typeof secretStore.withPlaintextMatcher !== "function") {
    throw serviceError("SECRET_STORE_MATCHER_REQUIRED", "SecretStore 必须提供有界敏感值 matcher session");
  }
  if (typeof productStore.setSensitiveValueMatcherSessionFactory !== "function") {
    throw serviceError(
      "PRODUCT_STORE_SECRET_MATCHER_REQUIRED",
      "ProductStore 必须接受 Service 的敏感值 matcher",
    );
  }
  productStore.setSensitiveValueMatcherSessionFactory(
    (action) => secretStore.withPlaintextMatcher(action),
  );
  // Plugins are part of every new installation and share the current Service
  // root. Storage preflight rejects incompatible data before any writer opens.
  const pluginStore = options.pluginStore || new PluginStore({ paths, now: options.now });
  const bundledPluginCatalog = options.bundledPluginCatalog || new BundledPluginCatalog(
    bundledRoot({ packaged: options.packaged === true, resourcesPath: options.resourcesPath }),
  );
  const pluginPackageInstaller = pluginStore
    ? (options.pluginPackageInstaller || new PluginPackageInstaller({ store: pluginStore,
      bundledCatalog: bundledPluginCatalog, firstPartyRoot: options.firstPartyPluginRoot
        || firstPartyPluginRoot({ packaged: options.packaged === true, resourcesPath: options.resourcesPath }) })) : null;
  const pluginToolCatalogRegistry = pluginStore
    ? (options.pluginToolCatalogRegistry || new PluginToolCatalogRegistry()) : null;
  const pluginPackageDeclarations = pluginStore
    ? new PluginPackageDeclarations({ packagesDir: pluginStore.paths.pluginPackagesDir }) : null;
  // Test doubles of the encrypted store may omit write methods; plugin
  // credentials are then unavailable instead of blocking Service startup.
  const pluginSecretStore = pluginStore && ["get", "put", "delete", "getCredentialRevision"]
    .every(method => typeof secretStore?.[method] === "function")
    ? new PluginSecretStore({ secretStore, declarations: pluginPackageDeclarations }) : null;
  const pluginComponentCatalog = pluginStore
    ? (options.pluginComponentCatalog || new PluginComponentCatalog({ store: pluginStore,
      toolCatalogRegistry: pluginToolCatalogRegistry, secrets: pluginSecretStore })) : null;
  const pluginComponentResolver = pluginStore
    ? (options.pluginComponentResolver || new PluginComponentResolver({ store: pluginStore })) : null;
  const pluginServiceController = pluginStore
    ? (options.pluginServiceController || new PluginServiceController({ store: pluginStore,
      installer: pluginPackageInstaller, catalog: pluginComponentCatalog,
      bundledCatalog: bundledPluginCatalog,
      resolver: pluginComponentResolver, productStore,
      toolCatalogRegistry: pluginToolCatalogRegistry,
      getConsent: () => pluginMcpConsent,
      prepareSelectionCatalog: selection => pluginCatalogRestorer.prepareSelection(selection),
      getAppController: () => pluginAppController,
      getOAuthController: () => pluginOAuthController,
      getGraphController: () => pluginGraphConnectionController,
      getBearerController: () => pluginBearerController,
      getDependencyController: () => pluginDependencyController,
      getRollbackController: () => pluginRollbackController,
      getConnectionController: () => pluginConnectionController,
      getExternalSelectionDispatch: () => externalPluginSelectionDispatch,
      getQuickSetup: () => pluginQuickSetup,
      getFirstPartySync: () => firstPartyPluginSync,
      drainInstallation: (installationId) => pluginMcpConnectionPool.drainInstallation(
        installationId),
      resumeInstallation: (installationId) => pluginMcpConnectionPool.resumeInstallation(
        installationId),
    })) : null;
  const pluginAuthoringService = pluginServiceController ? new PluginAuthoringService({
    root: path.join(paths.stateDir, "plugin-authoring"), trustedRoot: paths.trustedRoot,
    controller: pluginServiceController, store: pluginStore, catalog: pluginComponentCatalog,
  }) : null;
  // The Service may hold encrypted OAuth records, but account activation
  // stays closed until a trusted verifier is supplied. No fixture token is
  // accepted merely because it was written to the private credential store.
  const zoomRegistration = pluginStore ? loadZoomRegistration(paths) : null;
  const dropboxRegistration = pluginStore ? loadDropboxRegistration(paths) : null;
  const lovableRegistration = pluginStore ? new LovableRegistrationController({
    paths, store: pluginStore,
    fetchImpl: options.pluginLovableRegistrationFetch || globalThis.fetch,
    mcpFetchImpl: options.pluginLovableMcpFetch || globalThis.fetch,
  }) : null;
  const higgsfieldRegistration = pluginStore ? new HiggsfieldRegistrationController({
    paths, store: pluginStore,
    fetchImpl: options.pluginHiggsfieldRegistrationFetch || globalThis.fetch,
  }) : null;
  const slackRegistration = pluginStore ? new SlackRegistrationController({
    paths, store: pluginStore,
  }) : null;
  const zoomClientId = options.pluginZoomRegisteredClientId ?? zoomRegistration?.clientId ?? null;
  const dropboxClientId = dropboxRegistration?.clientId ?? null;
  const pluginOAuthProviders = pluginStore ? new PluginOAuthProviderRegistry({
    providers: options.pluginOAuthProviders ?? [
      ...loadPluginOAuthProviders(paths, { registeredZoomClientId: zoomClientId }),
      ...(zoomRegistration ? [zoomRegistration.provider] : []),
      ...(dropboxRegistration ? [dropboxRegistration.provider] : []),
      ...(lovableRegistration?.provider() ? [lovableRegistration.provider()] : []),
      ...(higgsfieldRegistration?.provider() ? [higgsfieldRegistration.provider()] : []),
      ...(slackRegistration?.provider() ? [slackRegistration.provider()] : []),
    ],
    fetchImpl: options.pluginOAuthFetch || globalThis.fetch,
    registeredZoomClientId: zoomClientId,
    registeredDropboxClientId: dropboxClientId,
    registeredSlackClientId: slackRegistration?.startupRegistration?.clientId ?? null,
    registeredHiggsfieldClientId: higgsfieldRegistration?.startupRegistration?.clientId ?? null,
    secretStore,
  }) : null;
  const pluginCredentialVault = pluginStore
    ? (options.pluginCredentialVault || new PluginCredentialVault({
      store: pluginStore, secretStore,
      verifyPrincipal: options.pluginPrincipalVerifier || (input => pluginOAuthProviders.verifyPrincipal(input)),
      refreshTokens: options.pluginRefreshTokens || (input => pluginOAuthProviders.refreshTokens(input)),
      invalidateToolCatalog: (connectionId) => pluginToolCatalogRegistry.invalidate(connectionId),
      now: options.now,
    })) : null;
  const pluginConnectionAuth = pluginStore
    ? (options.pluginConnectionAuth || new PluginConnectionAuth({
      getConnection: (connectionId) => pluginStore.getConnection(connectionId),
      readCredential: (connectionId) => pluginCredentialVault.readCredential(connectionId),
      refreshCredential: (context) => pluginCredentialVault.refreshCredential(context),
      now: options.now,
    })) : null;
  const runtimeAccountLookup = (runtimeAccountId) => (
    productStore.getRuntimeAccount(runtimeAccountId)
  );
  let nativeSkillStore = null;
  const learningStore = new LearningStore({ paths, now: options.now });
  let learningSources = null;
  const federationMcpSessionManager = options.federationMcpSessionManager
    || new FederationMcpSessionManager({
      productStore,
      paths,
      defaultProfileId: DEFAULT_AGENT_PROFILE_ID,
      now: options.now,
      randomBytes: options.federationMcpRandomBytes,
      ttlMs: options.federationMcpSessionTtlMs,
      maxSessions: options.federationMcpMaxSessions,
    });
  const mcpHelperLaunch = options.mcpHelperLaunch || {
    command: process.execPath,
    argsPrefix: [],
  };
  const runtimeConfigWriter = options.runtimeConfigWriter || new CodexRuntimeConfigWriter({
    paths,
    fs: options.runtimeConfigFs,
    mcpHelperLaunch,
  });
  const providerRuntimeBridge = options.providerRuntimeBridge || new ProviderRuntimeBridge({
    productStore,
    secretStore,
    configWriter: runtimeConfigWriter,
    parentEnv: options.parentEnv,
  });
  const runtimePool = options.runtimePool || new CodexRuntimePool({
    paths,
    canRetireStaleHost: (binding, host, runId) => lifecycleState === "started"
      && workRunCoordinator.isRuntimeHostIdle?.(binding, host, runId) === true,
    nativeAuth: new NativeCodexAuth({
      paths, repoRoot, packageVersion: serviceVersion,
      packaged: options.packaged, resourcesPath: options.resourcesPath,
      parentEnv: options.parentEnv, homedir: options.runtimeStorageHomedir,
    }),
    runtimeAccountLookup,
    parentEnv: options.parentEnv,
    homedir: options.runtimeStorageHomedir,
    hostOptions: {
      repoRoot,
      packageVersion: serviceVersion,
      packaged: options.packaged,
      resourcesPath: options.resourcesPath,
      prepareRuntime: async (runtimeInput) => {
        const prepare = options.prepareRuntime
          || providerRuntimeBridge.prepareRuntime.bind(providerRuntimeBridge);
        return prepare(runtimeInput);
      },
    },
  });
  const runtimeMcpGateIssuer = options.runtimeMcpGateIssuer || new RuntimeMcpGateIssuer({
    paths,
    mcpHelperLaunch,
    now: options.now,
  });
  const groupRuntimeMcpFactory = input => runtimeMcpGateIssuer.createMcpServer(input);
  const codexRuntimeAdapter = options.codexRuntimeAdapter
    || new CodexRuntimeAdapter({ runtimePool });
  const grokBuildRuntimePool = options.grokBuildRuntimePool || new GrokBuildRuntimePool({
      ...poolCapacityOptions,
    paths,
    runtimeAccountLookup,
    binaryPath: options.grokBuildBinaryPath,
    resolveProxy: options.grokBuildResolveProxy,
    parentEnv: options.parentEnv,
    homedir: options.runtimeStorageHomedir,
    packageVersion: serviceVersion,
    createMcpServer: groupRuntimeMcpFactory,
    now: options.now,
    randomUUID: options.randomUUID,
  });
  const grokBuildRuntimeAdapter = options.grokBuildRuntimeAdapter
    || new GrokBuildRuntimeAdapter({ runtimePool: grokBuildRuntimePool });
  const antigravityRuntimePool = options.antigravityRuntimePool || new AntigravityRuntimePool({
      ...poolCapacityOptions,
    paths,
    runtimeAccountLookup,
    binaryPath: options.antigravityBinaryPath,
    parentEnv: options.parentEnv,
    homedir: options.runtimeStorageHomedir,
    mcpGateIssuer: runtimeMcpGateIssuer,
    now: options.now,
    randomUUID: options.randomUUID,
  });
  const antigravityRuntimeAdapter = options.antigravityRuntimeAdapter
    || new AntigravityRuntimeAdapter({ runtimePool: antigravityRuntimePool });
  const piResourcesPath = options.resourcesPath || process.resourcesPath;
  const piExtensionPath = options.piExtensionPath || (options.packaged && piResourcesPath
    ? path.join(piResourcesPath, "pi", "shoggoth-pi-extension.mjs")
    : path.join(repoRoot, "resources", "pi", "shoggoth-pi-extension.mjs"));
  const piRuntimePool = options.piRuntimePool || new PiRuntimePool({
      ...poolCapacityOptions,
    paths,
    runtimeAccountLookup,
    binaryPath: options.piBinaryPath,
    extensionPath: piExtensionPath,
    parentEnv: options.parentEnv,
    homedir: options.runtimeStorageHomedir,
    mcpGateIssuer: runtimeMcpGateIssuer,
    now: options.now,
    randomUUID: options.randomUUID,
  });
  const piRuntimeAdapter = options.piRuntimeAdapter
    || new PiRuntimeAdapter({ runtimePool: piRuntimePool });
  const claudeCodeRuntimePool = options.claudeCodeRuntimePool || new ClaudeCodeRuntimePool({
      ...poolCapacityOptions,
    paths,
    runtimeAccountLookup,
    binaryPath: options.claudeCodeBinaryPath,
    parentEnv: options.parentEnv,
    homedir: options.runtimeStorageHomedir,
    mcpGateIssuer: runtimeMcpGateIssuer,
    sdk: options.claudeCodeSdk,
    now: options.now,
    randomUUID: options.randomUUID,
  });
  const claudeCodeRuntimeAdapter = options.claudeCodeRuntimeAdapter
    || new ClaudeCodeRuntimeAdapter({ runtimePool: claudeCodeRuntimePool });
  const openCodeRuntimePool = options.openCodeRuntimePool || new OpenCodeRuntimePool({
    ...poolCapacityOptions,
    paths,
    runtimeAccountLookup,
    binaryPath: options.openCodeBinaryPath,
    parentEnv: options.parentEnv,
    homedir: options.runtimeStorageHomedir,
    mcpGateIssuer: runtimeMcpGateIssuer,
    now: options.now,
    randomUUID: options.randomUUID,
  });
  const openCodeRuntimeAdapter = options.openCodeRuntimeAdapter
    || new OpenCodeRuntimeAdapter({ runtimePool: openCodeRuntimePool });
  const deepSeekHarnessResourcesPath = options.resourcesPath || process.resourcesPath;
  const deepSeekHarnessBridgePath = options.deepSeekHarnessBridgePath
    || (options.packaged && deepSeekHarnessResourcesPath
      ? path.join(deepSeekHarnessResourcesPath, "deepseek-harness", "shoggoth-dsh-bridge.mjs")
      : path.join(repoRoot, "resources", "deepseek-harness", "shoggoth-dsh-bridge.mjs"));
  const deepSeekHarnessRuntimePool = options.deepSeekHarnessRuntimePool
    || new DeepSeekHarnessRuntimePool({
      ...poolCapacityOptions,
      paths,
      runtimeAccountLookup,
      binaryPath: options.deepSeekHarnessBinaryPath,
      bridgePath: deepSeekHarnessBridgePath,
      parentEnv: options.parentEnv,
      homedir: options.runtimeStorageHomedir,
      mcpGateIssuer: runtimeMcpGateIssuer,
      now: options.now,
      randomUUID: options.randomUUID,
    });
  const deepSeekHarnessRuntimeAdapter = options.deepSeekHarnessRuntimeAdapter
    || new DeepSeekHarnessRuntimeAdapter({ runtimePool: deepSeekHarnessRuntimePool });
  const extensionCatalog = new (require("./runtime-extension-manifest").RuntimeExtensionCatalog)(paths);
  const runtimeExtensions = options.runtimeManager ? [] : extensionCatalog.read().filter(entry => entry.enabled);
  const idleRuntimePools = new Map([
    ["grok-build", grokBuildRuntimePool], ["antigravity", antigravityRuntimePool],
    ["pi", piRuntimePool], ["claude-code", claudeCodeRuntimePool],
    ["opencode", openCodeRuntimePool], ["deepseek-harness", deepSeekHarnessRuntimePool],
  ]);
  function runtimeAccountActivityKnown(binding) {
    const admission = runtimeAccountAdmission.read(binding.runtimeAccountId);
    if (admission.mutationActive !== false || accountAuthManager.active?.has(binding.runtimeAccountId)
      || runtimeLoginActive(binding.runtimeAccountId)
      || accountAuthManager.bindings?.get(binding.runtimeAccountId)?.refreshPromise) return false;
    // Account sharing is not activity sharing. Every admission must still have
    // known frozen ownership; model-only/unknown admissions conservatively retain.
    let known = 0;
    for (const [runId, owner] of workRunCoordinator.runAccountAdmissions) {
      if (owner.runtimeAccountId !== binding.runtimeAccountId) continue;
      const contract = workRunCoordinator.runExecutionContracts.get(runId);
      const run = workRunCoordinator.getRun(runId);
      if (!contract || contract.runId !== runId || !run || run.profileId !== contract.profileId
        || !["starting", "running", "waiting_approval", "waiting_input"].includes(run.status)) return false;
      const frozen = runtimeBinding({ runtime: contract.runtime,
        runtimeProfileId: contract.runtimeProfileId, runtimeAccountId: contract.runtimeAccountId });
      if (frozen.runtimeAccountId !== binding.runtimeAccountId || frozen.runtime !== binding.runtime) return false;
      runtimeAccountAdmission.assertRunAdmitted({ ...owner, runId });
      known += 1;
    }
    return Number.isSafeInteger(admission.active) && admission.active === known;
  }
  const runtimeManager = options.runtimeManager || (() => {
    const registry = new RuntimeAdapterRegistry({
      idleTimeoutMs: options.runtimeIdleTimeoutMs,
      onProtocolViolation: event => runtimeTelemetry.record("runtime.handle.violation", {
        source: event.runtime, reason: event.code, stage: event.type }),
      isIdle(binding) {
        if (idleRuntimePools.has(binding.runtime)) {
          try {
            return lifecycleState === "started" && !registry.isBindingActive(binding)
              && runtimeAccountActivityKnown(binding)
              && workRunCoordinator.isRuntimeBindingIdle(binding)
              && require("./runtime-pool-capacity").isPoolBindingIdle(idleRuntimePools.get(binding.runtime), binding);
          } catch { return false; }
        }
        if (lifecycleState !== "started" || activeRuntimeRequests > 0) return false;
        const admission = runtimeAccountAdmission.read(binding.runtimeAccountId);
        if (admission.active > 0 || admission.mutationActive
          || accountAuthManager.active?.has(binding.runtimeAccountId) || runtimeLoginActive(binding.runtimeAccountId)
          || accountAuthManager.bindings?.get(binding.runtimeAccountId)?.refreshPromise) return false;
        return !workRunCoordinator.listRuns().some((run) => {
          if (!["queued", "starting", "running", "waiting_approval", "waiting_input"].includes(run.status)) return false;
          const profiles = agentRuntimeProfileViews(productStore, run.profileId);
          return !profiles.length || profiles.some(profile => profile.runtime === binding.runtime
            && profile.runtimeProfileId === binding.runtimeProfileId);
        });
      },
      onIdleError() { console.error("[agent-service] idle runtime cleanup failed"); },
    });
    registry.register("codex", codexRuntimeAdapter);
    registry.register("grok-build", grokBuildRuntimeAdapter);
    registry.register("antigravity", antigravityRuntimeAdapter);
    registry.register("pi", piRuntimeAdapter);
    if (require("../runtime-availability").isRuntimeAvailable("claude-code")) {
      registry.register("claude-code", claudeCodeRuntimeAdapter);
    }
    if (require("../runtime-availability").isRuntimeAvailable("opencode")) {
      registry.register("opencode", openCodeRuntimeAdapter);
    }
    registry.register("deepseek-harness", deepSeekHarnessRuntimeAdapter);
    for (const entry of runtimeExtensions) {
      const manifest = require("./runtime-extension-manifest").verifyManifest(entry.envelope, entry.trustedKey);
      registry.register(manifest.runtime, new (require("./runtime-extension-adapter").RuntimeExtensionAdapter)({
        manifest, paths, verify: () => require("./runtime-extension-manifest").verifyManifest(entry.envelope, entry.trustedKey),
        getToken: reference => secretStore.get(reference),
      }));
    }
    return registry;
  })();
  const providerService = options.providerService || new ProviderService({
    productStore,
    secretStore,
    // Provider CRUD is a Codex-specific compatibility surface. Agent execution
    // routes through the generic registry below.
    runtimePool: codexRuntimeAdapter,
    publicProductUrl: options.publicProductUrl,
    repoRoot,
    packaged: options.packaged,
    resourcesPath: options.resourcesPath,
  });
  const runtimeAccountAdmission = options.runtimeAccountAdmission || new RuntimeAccountAdmission({
    runtimeAccountLookup,
    now: options.now,
    resolveMaxActive: (account) => {
      const policy = require("./execution-policy").resolveAdmissionPolicy(getNativeRuntimeConfig());
      return policy.enabled ? Math.min(account.maxActive ?? policy.maxActive, policy.maxActive)
        : Math.min(account.maxActive ?? 4, 4);
    },
  });
  const resolveProfileAuthBinding = (runtimeProfileId) => {
    const matches = agentRuntimeProfileViews(productStore)
      .filter((profile) => profile.runtimeProfileId === runtimeProfileId);
    if (matches.length !== 1) {
      throw serviceError("AUTH_PROFILE_BINDING_INVALID", "Account auth Profile binding is invalid");
    }
    const [profile] = matches;
    return {
      runtime: profile.runtime,
      runtimeProfileId: profile.runtimeProfileId,
      runtimeAccountId: profile.runtimeAccountId,
    };
  };
  const resolveRuntimeAccountBinding = (runtimeAccountId) => {
    const account = productStore.getRuntimeAccount(runtimeAccountId);
    if (!account) {
      throw serviceError("AUTH_ACCOUNT_BINDING_INVALID", "Account auth RuntimeAccount is invalid");
    }
    const profiles = agentRuntimeProfileViews(productStore)
      .filter((profile) => profile.runtimeAccountId === runtimeAccountId)
      .sort((left, right) => Number(right.enabled) - Number(left.enabled)
        // A Profile provider override changes how its process authenticates;
        // the account's own login must be read through one without it.
        || Number(left.providerRef != null) - Number(right.providerRef != null)
        || Number(right.isDefault) - Number(left.isDefault)
        || left.id.localeCompare(right.id));
    if (profiles.length === 0 || profiles[0].runtime !== account.runtime) {
      throw serviceError("AUTH_ACCOUNT_BINDING_INVALID", "Account auth RuntimeAccount is unused");
    }
    return {
      runtime: account.runtime,
      runtimeProfileId: profiles[0].runtimeProfileId,
      runtimeAccountId,
    };
  };
  const accountAuthStateStore = options.accountAuthStateStore || new AccountAuthStateStore({
    paths,
    fs: options.accountAuthFs,
    now: options.now,
  });
  const invalidateRuntimeAccount = async ({ runtimeAccountId, binding }) => {
    const profiles = agentRuntimeProfileViews(productStore)
      .filter((profile) => profile.runtimeAccountId === runtimeAccountId)
      .sort((left, right) => left.id.localeCompare(right.id));
    if (profiles.length === 0 || profiles.some((profile) => profile.runtime !== binding.runtime)) {
      throw serviceError(
        "AUTH_RUNTIME_INVALIDATION_FAILED",
        "Account auth RuntimeAccount references are invalid",
      );
    }
    const failures = [];
    for (const profile of profiles) {
      try {
        await runtimeManager.stop({
          runtime: profile.runtime,
          runtimeProfileId: profile.runtimeProfileId,
          runtimeAccountId: profile.runtimeAccountId,
        });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      const aggregate = new AggregateError(failures, "Account auth RuntimeAccount invalidation failed");
      aggregate.code = "AUTH_RUNTIME_INVALIDATION_FAILED";
      throw aggregate;
    }
  };
  const accountAuthManager = options.accountAuthManager || new AccountAuthManager({
    stateStore: accountAuthStateStore,
    runtimeManager,
    runtimeAccountAdmission,
    resolveProfileAuthBinding,
    resolveRuntimeAccountBinding,
    invalidateRuntimeAccount,
    now: options.now,
    randomUUID: options.randomUUID,
    loginTimeoutMs: options.accountLoginTimeoutMs,
    onEvent: (event) => eventBuffer.append(event.type, event),
  });
  const runtimeAccountStoreMethods = [
    "listRuntimeAccounts", "getRuntimeAccount", "listAgentProfiles",
  ];
  const runtimeAccountStoreAvailable = runtimeAccountStoreMethods.every(
    (method) => typeof productStore[method] === "function",
  );
  const runtimeAccountAuthAvailable = ["read", "loginStart", "loginCancel", "logout"]
    .every((method) => typeof accountAuthManager[method] === "function");
  const runtimeStoragePathsAvailable = ["stateDir", "trustedRoot", "runtimeAccountsDir"]
    .every(field => typeof paths[field] === "string");
  const unavailableRuntimeAccountServiceController = Object.freeze({
    open() {},
    close() {},
    handle() {
      throw serviceError(
        "RUNTIME_ACCOUNT_SERVICE_CLOSED",
        "RuntimeAccount Service is unavailable",
      );
    },
  });
  // Settings sign-in for runtimes other than Codex runs in the Service.
  const runtimeLoginManagers = options.runtimeLoginManagers || {
    antigravity: new AntigravityAcpLoginManager({
      paths, parentEnv: options.parentEnv, packageVersion: serviceVersion,
    }),
    // OpenCode signs into providers through the account's own server.
    opencode: new OpenCodeLoginManager({
      acquireHost: (runtimeAccountId) => {
        const binding = resolveRuntimeAccountBinding(runtimeAccountId);
        const profile = agentRuntimeProfileViews(productStore)
          .find((view) => view.runtimeProfileId === binding.runtimeProfileId);
        return runtimeManager.acquire(runtimeBinding(binding), { permissionPolicy: profile?.permissionPolicy });
      },
    }),
  };
  const runtimeLoginActive = (runtimeAccountId) => Object.values(runtimeLoginManagers)
    .some((manager) => manager.isActive?.(runtimeAccountId) === true);
  const runtimeAccountServiceController = options.runtimeAccountServiceController
    || (runtimeAccountStoreAvailable && runtimeAccountAuthAvailable
      && runtimeStoragePathsAvailable
      ? createRuntimeAccountServiceController({
        productStore,
        runtimeAccountAdmission,
        accountAuthManager,
        loginManagers: runtimeLoginManagers,
        paths,
        fs: options.runtimeStorageFs,
        parentEnv: options.parentEnv,
        homedir: options.runtimeStorageHomedir,
        scanLimits: options.runtimeStorageScanLimits,
        now: options.now,
        inventoryCacheMs: options.runtimeStorageInventoryCacheMs,
        readAccountStorage: options.readAccountStorage,
      }) : unavailableRuntimeAccountServiceController);
  const profileStoreMethods = [
    "getAgentProfile", "getModelProvider", "putAgentProfile", "getRuntimeAccount",
    "listAgentProfiles", "lookupMcpToolCall", "beginMcpToolCall", "completeMcpToolCall",
  ];
  const profileStoreAvailable = profileStoreMethods.every(
    (method) => typeof productStore[method] === "function",
  );
  const unavailableProfileServiceController = Object.freeze({
    open() {},
    close() {},
    handle() {
      throw serviceError("PROFILE_SERVICE_CLOSED", "Profile configuration is unavailable");
    },
  });
  const profileServiceController = options.profileServiceController
    || (profileStoreAvailable ? createProfileServiceController({
      productStore,
      runtimeManager: {
        acquire(binding, acquireOptions) {
          if (typeof runtimeManager.acquire === "function") {
            return runtimeManager.acquire(binding, acquireOptions);
          }
          if (typeof runtimeManager.get !== "function") {
            throw serviceError("PROFILE_SERVICE_CLOSED", "RuntimePool lookup is unavailable");
          }
          return runtimeManager.get(binding.runtimeProfileId);
        },
        stop(binding) {
          if (typeof runtimeManager.stop !== "function") {
            throw serviceError("PROFILE_SERVICE_CLOSED", "RuntimePool targeted stop is unavailable");
          }
          return runtimeManager.stop(binding);
        },
      },
      accountAuthManager: {
        read(params) {
          if (typeof accountAuthManager.read !== "function") {
            throw serviceError("PROFILE_SERVICE_CLOSED", "Account authority is unavailable");
          }
          return accountAuthManager.read(params);
        },
      },
      providerBootstrap: providerService.profileBootstrapCapability || {
        configureOpenAiApiKey() {
          throw serviceError("PROFILE_SERVICE_CLOSED", "Provider bootstrap is unavailable");
        },
        clearUnreferencedOpenAiApiKey() {
          throw serviceError("PROFILE_SERVICE_CLOSED", "Provider bootstrap is unavailable");
        },
      },
      now: options.now,
    }) : unavailableProfileServiceController);
  const customEndpointService = new CustomEndpointService({
    productStore, providerService, secretStore, profileServiceController,
    now: options.now, randomUUID: options.randomUUID,
  });
  const chatSessionStore = options.chatSessionStore || new ChatSessionStore({
    paths,
    fs: options.chatSessionFs,
    onSessionEvent: (session, event, operationId) => hookService.observeSession(session, event, operationId),
    getProfileBinding(profileId, bindingId) {
      return productStore.getAgentRuntimeBinding(profileId, bindingId ?? productStore.getAgentProfile(profileId)?.defaultBindingId);
    },
    now: options.now,
    randomUUID: options.randomUUID,
  });
  const proactiveStore = options.proactiveStore || new ProactiveStore({ paths, now: options.now, randomUUID: options.randomUUID });
  const groupChatStore = options.groupChatStore || new GroupChatStore({ paths, now: options.now, randomUUID: options.randomUUID });
  const agentDefinitionStore = options.agentDefinitionStore || new AgentDefinitionStore({
    paths,
    fs: options.agentDefinitionFs,
    now: options.now,
    randomUUID: options.randomUUID,
  });
  const pendingCommandInbox = options.pendingCommandInbox || new PendingCommandInbox({
    paths,
    fs: options.pendingCommandFs,
    cryptoBroker: mcpCryptoBroker,
    now: options.now,
    decryptStartupBudgetMs: options.pendingCommandDecryptStartupBudgetMs,
    onUnlocked: () => handlePendingCommandInboxUnlocked(),
  });
  const automationWorkRunStore = new (require("./codex-automation-work-run-store").CodexAutomationWorkRunStore)({
    productStore, paths, now: options.now || productStore.now, assertSecretSafe: value => assertSecretSafe(value),
  });
  // Built-in CLI Agents created so far, greeted Agents, and the Codex automation owner.
  const builtinAgentState = new BuiltinAgentState({ paths });
  // CLIs installed on this Mac, whose built-in Agent may be created. Antigravity
  // counts once its own sign-in has installed the ACP server.
  const installedBuiltinAccountIds = () => {
    if (options.builtinCliProfiles !== true) return new Set();
    if (options.builtinCliInstalledAccountIds !== undefined) return new Set(options.builtinCliInstalledAccountIds);
    const parentEnv = options.parentEnv || process.env;
    const homedir = options.runtimeStorageHomedir || os.homedir;
    return new Set(createRuntimeCliAuth({ paths, parentEnv, homedir, nativeOnly: true })
      .filter((entry) => entry.binaryPath !== null).map((entry) => entry.runtimeAccountId));
  };
  // Every new Agent gets one first greeting; one on a local CLI names that CLI.
  // Agents already in use are settled without one.
  const greetNewAgents = (locale) => {
    const runtimeNames = new Map(AUTH_SPECS.map((spec) => [spec.runtimeAccountId, spec.name]));
    const cliAccountIds = new Set(Object.values(DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME));
    const candidates = productStore.listAgentProfiles()
      .filter((profile) => profile.enabled && !builtinAgentState.isGreeted(profile.id)).map((profile) => profile.id);
    const { greeted, settled } = chatServiceController.ensureGreetings({ profileIds: candidates,
      textFor: (profile) => agentGreeting({ locale, name: profile.name, isDefault: profile.isDefault,
        runtimeName: cliAccountIds.has(profile.runtimeAccountId) ? runtimeNames.get(profile.runtimeAccountId) : null }) });
    builtinAgentState.markGreeted(settled);
    return greeted;
  };
  const workDispatcher = options.workDispatcher || createWorkDispatcher({
    store: require("./codex-automation-work-run-store").createAutomationWorkRunStore({ productStore, automationStore: automationWorkRunStore }),
    now: options.now || productStore.now,
    getNativeRuntimeConfig,
    onSkippedRun: run => hookService.observeSkippedRun(run),
  });
  const runtimeSessionOwnershipStore = options.runtimeSessionOwnershipStore
    || new RuntimeSessionOwnershipStore({
      paths,
      fs: options.runtimeSessionOwnershipFs,
      now: options.now,
    });
  const isSensitiveValue = options.isSensitiveValue || ((value) => (
    secretStore.withPlaintextMatcher((matches) => matches(value))
  ));
  const tokenUsageStore = options.tokenUsageStore || new TokenUsageStore({
    paths,
    fs: options.tokenUsageFs,
    now: options.now,
    isSensitiveValue,
  });
  const federationHostClient = options.federationHostClient || new FederationHostClient({ paths });
  const nativeKanbanStore = options.nativeKanbanStore || new NativeKanbanStore({
    paths,
    fs: options.nativeKanbanFs,
    now: options.now,
    randomUUID: options.randomUUID,
    profileExists: (profileId) => productStore.getAgentProfile(profileId) !== null,
    getRun: (runId) => workDispatcher.getRun(runId),
    isSensitiveValue,
  });
  const nativeCronStore = options.nativeCronStore || new NativeCronStore({
    paths,
    fs: options.nativeCronFs,
    now: options.now,
    randomUUID: options.randomUUID,
    profileExists: (profileId) => productStore.getAgentProfile(profileId) !== null,
    isSensitiveValue,
  });
  const assertSecretSafe = options.assertSecretSafe || ((value, context) => {
    const stable = stableJsonForSecretScan(value, ["contextContent", "fullText"].includes(context?.kind)
      ? 8 * 1024 * 1024 : MAX_SECRET_SCAN_BYTES);
    const safe = secretStore.withPlaintextMatcher((matches) => (
      !matches(stable.serialized) && !stableJsonContainsMatchedString(stable.parsed, matches)
    ));
    if (safe !== true) {
      throw serviceError("RUN_EVENT_SECRET_REJECTED", "Run event 含敏感信息");
    }
    return true;
  });
  const sanitizeSummary = options.sanitizeSummary || ((value) => {
    if (typeof value !== "string" || !value.isWellFormed() || value.includes("\0")
      || Buffer.byteLength(value, "utf8") > MAX_SUMMARY_SCAN_BYTES) return null;
    try {
      return secretStore.withPlaintextMatcher((matches) => (matches(value) ? null : value));
    } catch {
      return null;
    }
  });
  const inspirationStore = options.inspirationStore || new InspirationStore({
    paths, now: options.now, randomUUID: options.randomUUID, assertSecretSafe,
  });
  const transcriptStore = options.transcriptStore || new TranscriptStore({
    paths,
    fs: options.transcriptFs,
    now: options.now,
    assertSecretSafe,
  });
  const memoryCandidateStore = options.memoryCandidateStore || new MemoryCandidateStore({
    paths, now: options.now,
  });
  // Fresh installs use the native file owner. Legacy fixtures and trusted
  // offline migration composition remain explicit Node options, never UI config.
  if (options.memoryCoreInitialization !== undefined && (options.memoryCore !== true
    || !["fresh", "migration"].includes(options.memoryCoreInitialization))) {
    throw serviceError("MEMORY_INITIALIZATION_INVALID", "离线记忆初始化必须显式指定原生内核");
  }
  let memoryProviderOwnerRpc = null, memoryProviderOwnerGeneration = null;
  const shoggothMemory = options.memoryCore !== false && !options.memoryStore && !options.memoryEngine
    ? new (require("./shoggoth-memory/service.cjs").ShoggothMemoryService)({
      paths, definitionStore: agentDefinitionStore, transcriptStore, chatSessionStore, sharingConfig: nativeMemorySharingConfig, resolveRun: id => workDispatcher.getRun(id),
      initialization: options.memoryCoreInitialization ?? "fresh",
      candidateStore: memoryCandidateStore, now: options.now, randomUUID: options.randomUUID,
      remoteProviderResources: options.memoryRemoteProviderResources || { secretStore,
        resolveOwner: packet => memoryProviderOwnerRpc.resolveOwner(packet) },
      projectProviderMetadata: (profileId, config) => memoryProviderOwnerRpc
        ? memoryProviderOwnerRpc.projectProviderMetadata(profileId, config) : config,
      // Read-only shared roster: memory checks call this thousands of times per turn.
      profiles: () => (productStore.listAgentProfilesReadOnly?.() ?? productStore.listAgentProfiles()),
      getConfig: () => nativeMemoryConfig.initialized
        ? { ...nativeMemoryConfig.read().config, _shoggothConfigRevision: nativeMemoryConfig.read().revision }
        : options.memoryCoreConfig || {},
    }) : null;
  if (shoggothMemory && !options.memoryRemoteProviderResources) {
    memoryProviderOwnerRpc = createMemoryProviderOwnerRpc({ paths, secretStore,
      getConfig: () => nativeMemoryConfig.initialized ? nativeMemoryConfig.read().config : options.memoryCoreConfig || {},
      getProfileIds: () => (productStore.listAgentProfilesReadOnly?.() ?? productStore.listAgentProfiles()).map(profile => profile.id),
      assertProfileCurrent: profileId => (productStore.listAgentProfilesReadOnly?.() ?? productStore.listAgentProfiles())
        .some(profile => profile.id === profileId),
      assertServiceCurrent: () => ["starting", "started"].includes(lifecycleState)
        && lifecycleGeneration === memoryProviderOwnerGeneration && !maintenanceQuiesced,
      assertExclusiveStoppedRecovery: info => {
        if (lifecycleState !== "starting" || lifecycleGeneration !== memoryProviderOwnerGeneration
          || lockFd === null || !ownedLockIdentity || !Number.isSafeInteger(info.pid) || info.pid <= 1
          || info.pid === process.pid) return false;
        try {
          const current = fs.lstatSync(paths.lockPath), held = fs.fstatSync(lockFd);
          if (current.dev !== ownedLockIdentity.dev || current.ino !== ownedLockIdentity.ino
            || held.dev !== current.dev || held.ino !== current.ino) return false;
          try { process.kill(info.pid, 0); return false; }
          catch (error) { return error?.code === "ESRCH"; }
        } catch { return false; }
      },
      retireOwners: request => shoggothMemory.retireProviderOwners(request),
    });
  }
  let memoryConfigApplyTail = Promise.resolve();
  const memoryConfigApplyPending = new Map();
  let memoryConfigReconciledKey = null;
  const applyNativeMemoryProjection = params => {
    const generation = lifecycleGeneration;
    // The IPC boundary canonicalizes the complete projection. A disconnected
    // caller must join its admitted work rather than enqueue another scan.
    const key = `${generation}:${JSON.stringify(params)}`;
    if (memoryConfigApplyPending.has(key)) return memoryConfigApplyPending.get(key);
    const operation = memoryConfigApplyTail.then(async () => {
      if (lifecycleState !== "started" || lifecycleGeneration !== generation || maintenanceQuiesced) {
        throw serviceError("NATIVE_MEMORY_CONFIG_UNAVAILABLE", "记忆服务暂不可应用配置");
      }
      // Validate even cached projections inside the ordered tail: a newer
      // durable revision can make an earlier successful projection stale.
      const applied = nativeMemoryConfig.apply(params);
      if (memoryConfigReconciledKey === key) return applied;
      await shoggothMemory?.reconcileConfig();
      if (lifecycleState !== "started" || lifecycleGeneration !== generation || maintenanceQuiesced) {
        throw serviceError("NATIVE_MEMORY_CONFIG_UNAVAILABLE", "记忆服务暂不可应用配置");
      }
      // Persistence alone is not an ACK. Failed/incomplete reconciliation stays
      // retryable, and each new Service generation must reconcile its first apply.
      memoryConfigReconciledKey = key;
      return applied;
    });
    memoryConfigApplyPending.set(key, operation);
    const clearPending = () => {
      if (memoryConfigApplyPending.get(key) === operation) memoryConfigApplyPending.delete(key);
    };
    void operation.then(clearPending, clearPending);
    memoryConfigApplyTail = operation.catch(() => {});
    return operation;
  };
  const memoryStore = options.memoryStore || shoggothMemory?.store || new MemoryStore({ paths, fs: options.memoryFs });
  const memoryEngine = options.memoryEngine || shoggothMemory || new MemoryEngine({
    store: memoryStore,
    definitionStore: agentDefinitionStore,
    transcriptStore,
    chatSessionStore,
    strictSourceResolution: true,
    now: options.now,
    randomUUID: options.randomUUID,
    // Every Agent of this owner shares user/project/workspace memory.
    sharedProfiles: () => productStore.listAgentProfiles().map((profile) => profile.id),
  });
  memoryEngine.setReviewReceiptStore?.(memoryCandidateStore);
  const memoryProvenanceStore = options.memoryProvenanceStore || new MemoryProvenanceStore({
    paths, now: options.now,
  });
  const memoryProvenanceService = options.memoryProvenanceService || new MemoryProvenanceService({
    store: memoryProvenanceStore, memoryStore, transcriptStore, chatSessionStore,
    recallPolicy: memoryEngine.recallPolicy, now: options.now,
    getRun: (runId) => workDispatcher.getRun(runId),
    getRunSessionKey: (run) => workRunCoordinator.getRunSessionKey(run),
    getInspirationOrigin: (run) => inspirationStore.executionForRun(run.id),
  });
  memoryEngine.setProvenanceService?.(memoryProvenanceService);
  // The one-time Codex memory import keeps cited excerpts; provenance keeps their hashes.
  const codexMemoryImportStore = new CodexMemoryImportStore({ paths, now: options.now });
  memoryProvenanceService.setImportExcerptResolver?.(
    (profileId, sourceRef) => codexMemoryImportStore.excerpt(profileId, sourceRef));
  let codexMemoryImportService = null;
  let memoryCandidateService = options.memoryCandidateService || null;
  const candidateReview = Object.fromEntries(["list", "accept", "acceptMany", "reject", "excludeSession"].map((method) => [method,
    (input) => {
      if (!memoryCandidateService || typeof memoryCandidateService[method] !== "function") {
        throw serviceError("MEMORY_CANDIDATE_UNAVAILABLE", "候选审核暂不可用");
      }
      return memoryCandidateService[method](input);
    }]));
  const toolRegistry = options.toolRegistry || DEFAULT_TOOL_REGISTRY;
  const permissionEngine = options.permissionEngine || new PermissionEngine({
    toolRegistry,
    paths,
  });
  const pluginCapabilityDispatcher = pluginStore
    ? (options.pluginCapabilityDispatcher || new CapabilityDispatcher({
      store: pluginStore, permissionEngine,
      resolveToolContract: (records) => pluginToolCatalogRegistry.resolve(records),
      // Recheck the actual account-bound registration before issuing a ticket
      // and at final send; OAuth scopes never come from tool annotations.
      slackScopes: principal => officialRegistrationCurrent("slack", principal)
        ? [...slackRegistration.startupRegistration.provider.scopes] : null,
      now: options.now,
    })) : null;
  const officialRegistrationCurrent = (kind, principalIdentity) => {
    const registration = kind === "slack" ? slackRegistration
      : kind === "dropbox" ? dropboxRegistration
        : kind === "higgsfield" ? higgsfieldRegistration : lovableRegistration;
    const endpoint = kind === "slack" ? "https://mcp.slack.com/mcp"
      : kind === "dropbox" ? DROPBOX_MCP_SERVER
        : kind === "higgsfield" ? HIGGSFIELD_MCP_SERVER : "https://mcp.lovable.dev";
    try {
      return registration?.assertCurrent() === true
        && principalMatchesRegistration(pluginOAuthProviders.forEndpoint(new URL(endpoint).href),
          principalIdentity);
    } catch { return false; }
  };
  const gmailRuntime = pluginStore ? (options.pluginGmailRuntime || new GogGmailRuntime({
    paths, packaged: options.packaged === true, resourcesPath: options.resourcesPath,
    repoRoot, run: options.pluginGogRun,
  })) : null;
  const assertSpecialConnection = (connectionId, toolName = null) => {
    const connection = pluginStore.getConnection(connectionId);
    const installation = connection && pluginStore.getInstallation(connection.installationId);
    const reserved = reservedEndpointKind(connection?.endpointIdentity);
    if (reserved && installation?.sourceIdentity !== `bundled:${reserved}`) {
      throw serviceError("CONNECTION_IDENTITY_CHANGED", "官方 MCP 端点的来源身份已变化");
    }
    if (installation?.sourceIdentity === "bundled:lovable"
      && !officialRegistrationCurrent("lovable", connection.principalIdentity)) {
      throw serviceError("CONNECTION_IDENTITY_CHANGED", "Lovable 客户端登记已变化");
    }
    if (installation?.sourceIdentity === "bundled:higgsfield"
      && (!officialRegistrationCurrent("higgsfield", connection.principalIdentity)
        || toolName !== null)) {
      throw serviceError("CAPABILITY_FORBIDDEN", "Higgsfield 工具尚未通过真实合同与计费验收");
    }
    if (installation?.sourceIdentity === "bundled:slack"
      && !officialRegistrationCurrent("slack", connection.principalIdentity)) {
      throw serviceError("CONNECTION_IDENTITY_CHANGED", "Slack 客户端登记已变化");
    }
    if (installation?.sourceIdentity === "bundled:dropbox"
      && !officialRegistrationCurrent("dropbox", connection.principalIdentity)) {
      throw serviceError("CONNECTION_IDENTITY_CHANGED", "Dropbox 客户端登记已变化");
    }
    if (installation?.sourceIdentity === GMAIL_SOURCE) {
      const email = connection?.principalIdentity?.startsWith("gmail:")
        ? connection.principalIdentity.slice(6) : null;
      if (!connection.endpointIdentity?.startsWith(`${GMAIL_TRANSPORT}:`)
        || !email || !GMAIL_EMAIL.test(email) || !gmailRuntime?.configured()
        || toolName !== null && !gmailRuntime.allowedTools().has(toolName)) {
        throw serviceError("CAPABILITY_FORBIDDEN", "Gmail 连接或工具权限已变化");
      }
    }
  };
  const pluginMcpConnectionPool = pluginStore
    ? (options.pluginMcpConnectionPool || new PluginMcpConnectionPool({
      leaseManager: new PluginDataScopeLeaseManager({ paths }),
      authorizeEgress: (request) => {
        assertSpecialConnection(request.connectionId, request.toolName);
        return pluginCapabilityDispatcher.authorizeEgress(request);
      },
      onToolsChanged: ({ connectionId }) => pluginToolCatalogRegistry.invalidate(connectionId),
      onConnectionInvalidated: ({ connectionId }) =>
        pluginToolCatalogRegistry.invalidate(connectionId),
      canAcquire: ({ installationId, releaseDigest }) => {
        const installation = pluginStore.getInstallation(installationId);
        return installation?.desiredState === "enabled"
          && installation.releaseDigest === releaseDigest
          && (installation.sourceIdentity !== "bundled:lovable"
            || lovableRegistration?.assertCurrent() === true)
          && (installation.sourceIdentity !== "bundled:higgsfield"
            || higgsfieldRegistration?.assertCurrent() === true)
          && (installation.sourceIdentity !== "bundled:slack"
            || slackRegistration?.assertCurrent() === true)
          && (installation.sourceIdentity !== "bundled:dropbox"
            || dropboxRegistration?.assertCurrent() === true)
          && !pluginStore.hasPendingInstallationDisable(installationId);
      },
    })) : null;
  let outlookCalendarGraphConfig = options.outlookCalendarGraphConfig;
  if (pluginStore && outlookCalendarGraphConfig === undefined) {
    try {
      const loaded = loadOutlookCalendarConfig(paths);
      outlookCalendarGraphConfig = loaded === null ? null
        : { version: 1, clientId: loaded.clientId };
    }
    catch (error) {
      if (error?.code !== "OUTLOOK_CALENDAR_CONFIG_INVALID") throw error;
      // Optional Graph configuration must fail closed for the component,
      // without making unrelated native Agents unable to start.
      console.error("[agent-service] Outlook Graph configuration unavailable");
      outlookCalendarGraphConfig = null;
    }
  }
  const outlookCalendarGraph = pluginStore ? new OutlookCalendarGraphController({
    paths, secretStore, productStore,
    fetchImpl: options.outlookCalendarGraphFetch || globalThis.fetch,
    config: outlookCalendarGraphConfig,
    now: options.now,
  }) : null;
  const pluginMcpConnectionManager = pluginStore ? new PluginMcpConnectionManager({
    store: pluginStore, resolver: pluginComponentResolver, pool: pluginMcpConnectionPool,
    auth: pluginConnectionAuth, allowLoopback: options.pluginAllowLoopback === true,
    graphCalendar: outlookCalendarGraph,
    lovableRegistration: principal => officialRegistrationCurrent("lovable", principal),
    higgsfieldRegistration: principal => officialRegistrationCurrent("higgsfield", principal),
    slackRegistration: principal => officialRegistrationCurrent("slack", principal),
    dropboxRegistration: principal => officialRegistrationCurrent("dropbox", principal),
    // Scopes come from the Service-owned registration whose digest is bound to
    // this authenticated principal, never from a model or remote tool metadata.
    slackScopes: principal => officialRegistrationCurrent("slack", principal)
      ? [...slackRegistration.startupRegistration.provider.scopes] : null,
    lovableFetchImpl: options.pluginLovableMcpFetch || globalThis.fetch,
    slackFetchImpl: options.pluginSlackMcpFetch || globalThis.fetch,
    figmaFetchImpl: options.pluginFigmaDesktopFetch || globalThis.fetch,
    gmailRuntime,
    authorizeEgress: request => pluginCapabilityDispatcher.authorizeEgress(request),
    secrets: pluginSecretStore,
  }) : null;
  const pluginGmailController = pluginStore ? new GogGmailConnectionController({
    store: pluginStore, productStore, manager: pluginMcpConnectionManager,
    runtime: gmailRuntime, now: options.now,
  }) : null;
  const pluginDependencyController = pluginStore ? new PluginDependencyController({
    store: pluginStore, registry: new PluginDependencyRegistry({ store: pluginStore, resolver: pluginComponentResolver }),
    drainInstallation: id => pluginMcpConnectionPool.drainInstallation(id),
    resumeInstallation: id => pluginMcpConnectionPool.resumeInstallation(id), now: options.now,
  }) : null;
  const pluginRollbackController = pluginStore ? new PluginRollbackController({
    store: pluginStore, rollback: new PluginDataRollback({ store: pluginStore,
      drainInstallation: id => pluginMcpConnectionPool.drainInstallation(id) }),
    resumeInstallation: id => pluginMcpConnectionPool.resumeInstallation(id), now: options.now,
  }) : null;
  const pluginMcpConsent = pluginStore ? new PluginMcpConsent({ store: pluginStore,
    productStore, manager: pluginMcpConnectionManager, registry: pluginToolCatalogRegistry,
    now: options.now,
  }) : null;
  const pluginQuickSetup = pluginStore && pluginSecretStore ? new PluginQuickSetup({ store: pluginStore, productStore,
    manager: pluginMcpConnectionManager, consent: pluginMcpConsent, toolCatalog: pluginToolCatalogRegistry,
    dependencies: new PluginDependencyRegistry({ store: pluginStore, resolver: pluginComponentResolver }),
    secrets: pluginSecretStore, declarations: pluginPackageDeclarations,
    setInstallationState: params => pluginServiceController.handle("plugins.installations.set", params),
    ...(options.pluginInterpreterCandidates ? { candidates: options.pluginInterpreterCandidates } : {}),
    now: options.now,
  }) : null;
  // plugin_status reports the same setup steps as plugin_setup_get.
  if (pluginAuthoringService) pluginAuthoringService.quickSetup = pluginQuickSetup;
  let firstPartySyncDone = Promise.resolve(null);
  const firstPartyPluginSync = pluginServiceController && pluginPackageInstaller?.firstPartyRoot
    ? new FirstPartyPluginSync({ root: pluginPackageInstaller.firstPartyRoot, installer: pluginPackageInstaller,
      store: pluginStore, setInstallationState: params => pluginServiceController.handle("plugins.installations.set", params) })
    : null;
  const pluginCatalogRestorer = pluginStore ? new PluginCatalogRestorer({
    store: pluginStore, productStore, consent: pluginMcpConsent,
    registry: pluginToolCatalogRegistry, now: options.now,
    onFailure: ({ code }) => console.error("[agent-service] plugin tool restore unavailable:", code),
  }) : null;
  const pluginOAuthController = pluginStore ? new PluginOAuthConnectionController({
    store: pluginStore, productStore, manager: pluginMcpConnectionManager,
    providers: pluginOAuthProviders, vault: pluginCredentialVault, now: options.now,
  }) : null;
  const pluginGraphConnectionController = pluginStore ? new PluginOutlookGraphConnectionController({
    store: pluginStore, productStore, manager: pluginMcpConnectionManager,
    calendar: outlookCalendarGraph, now: options.now,
  }) : null;
  const pluginBearerController = pluginStore ? new PluginBearerConnectionController({
    store: pluginStore, productStore, manager: pluginMcpConnectionManager,
    vault: pluginCredentialVault,
    verifyBearer: options.pluginGitHubBearerVerifier || (token =>
      require("./plugin-github-bearer-verifier").verifyGitHubBearer(token,
        { fetchImpl: options.pluginGitHubFetch || globalThis.fetch })),
    verifyCloudflare: options.pluginCloudflareBearerVerifier || (token =>
      require("./plugin-cloudflare-bearer-verifier").verifyCloudflareBearer(token,
        { fetchImpl: options.pluginCloudflareFetch || globalThis.fetch })),
    now: options.now,
  }) : null;
  const pluginConnectionController = pluginStore ? new PluginConnectionController({
    store: pluginStore, productStore, now: options.now,
    credentialDispositionForConnection: ({ connection, installation }) => {
      const packageId = installation.sourceIdentity?.startsWith("bundled:")
        ? installation.sourceIdentity.slice("bundled:".length) : null;
      if (packageId === "gmail"
        && connection.endpointIdentity?.startsWith(`${GMAIL_TRANSPORT}:`)) {
        return "retained_encrypted_shared";
      }
      if (!isGraphSidecar(packageId)
        || !connection.endpointIdentity?.startsWith(`${GRAPH_SIDECAR_TRANSPORT}:`)) return null;
      return outlookCalendarGraph.hasStoredAccount() ? "retained_encrypted_shared" : "none";
    },
    drainConnection: id => pluginMcpConnectionPool.drainConnection(id),
    cancelStaleOAuth: async bindings => {
      await pluginOAuthController.cancelStaleForBindings(bindings);
      await pluginGraphConnectionController.cancelStaleForBindings(bindings);
    },
    invalidateConnection: connectionId => {
      pluginToolCatalogRegistry.invalidate(connectionId);
      pluginAppController.revoke({ connectionId });
    },
  }) : null;
  let hookToolExecution = null;
  const pluginRuntimeToolService = pluginStore ? new PluginRuntimeToolService({
    store: pluginStore, productStore, permissionEngine, getRun: id => workDispatcher.getRun(id),
    toolCatalogRegistry: pluginToolCatalogRegistry,
    capabilityDispatcher: pluginCapabilityDispatcher,
    hookToolExecution: () => hookToolExecution,
    acquireConnection: records => pluginMcpConnectionManager.acquire(records),
    requestApproval: input => workRunCoordinator.requestPluginToolApproval(input),
    requestElicitation: input => workRunCoordinator.requestPluginMcpElicitation(input),
    recordAppCall: input => pluginAppController.recordCall(input),
  }) : null;
  const authorizeExternalPluginIdentity = async (backendId, token, identity) => {
      if (!authorizeExternalPluginAdapter(paths, backendId, token)) return false;
      try {
        const agent = options.externalPluginAgentVerifier
          ? await options.externalPluginAgentVerifier(identity)
          : (await federationHostClient.request("agent.get", {
            backendId, agentId: identity.agentId })).agent;
        return agent?.id === identity.agentId && agent?.backendId === backendId;
      } catch { return false; }
  };
  const externalPluginSelectionDispatch = pluginStore ? new ExternalPluginSelectionDispatch({
    paths, store: pluginStore, toolCatalogRegistry: pluginToolCatalogRegistry,
    authorizeAdapter: authorizeExternalPluginIdentity, now: options.now,
    onRevokeExecution: identity => externalPluginToolService.cancelExecution(identity),
  }) : null;
  const externalPluginLeaseManager = pluginStore ? new ExternalPluginLeaseManager({
    authorizeAdapter: authorizeExternalPluginIdentity,
    now: options.now,
    randomBytes: options.externalPluginLeaseRandomBytes,
  }) : null;
  const externalPluginProvenance = pluginStore ? new ExternalPluginProvenance({
    paths, store: pluginStore, now: options.now,
  }) : null;
  const externalPluginApprovalBroker = pluginStore ? new ExternalPluginApprovalBroker({
    now: options.now,
  }) : null;
  const externalPluginToolService = pluginStore ? new ExternalPluginToolService({
    store: pluginStore, resolver: pluginComponentResolver,
    toolCatalogRegistry: pluginToolCatalogRegistry,
    capabilityDispatcher: pluginCapabilityDispatcher,
    acquireConnection: records => pluginMcpConnectionManager.acquire(records),
    leaseManager: externalPluginLeaseManager,
    selectionDispatch: externalPluginSelectionDispatch,
    provenance: externalPluginProvenance,
    approvalBroker: externalPluginApprovalBroker,
    getNativeSkillStore: () => nativeSkillStore,
  }) : null;
  const pluginAppController = pluginStore ? new PluginAppController({
    store: pluginStore, productStore, getRun: id => workDispatcher.getRun(id),
    getConversation: run => {
      const key = workRunCoordinator.getRunSessionKey(run);
      const session = key && chatSessionStore.getSession(key);
      return session ? { id: key, profileId: session.profileId } : null;
    }, manager: pluginMcpConnectionManager, catalog: pluginToolCatalogRegistry,
    dispatcher: pluginCapabilityDispatcher, permissionEngine, now: options.now,
  }) : null;
  const productMcpApprovalPolicy = options.productMcpApprovalPolicy
    || new ProductMcpApprovalPolicy({ toolRegistry, permissionEngine, productStore });
  const serviceResourcesPath = options.resourcesPath || process.resourcesPath;
  const builtinSkillRoot = path.resolve(options.skillBuiltinRoot || (
    options.packaged && serviceResourcesPath
      ? path.join(serviceResourcesPath, "shoggoth-skills")
      : path.join(repoRoot, "resources", "shoggoth-skills")
  ));
  nativeSkillStore = options.nativeSkillStore || new NativeSkillStore({
    paths,
    builtinRoot: builtinSkillRoot,
    profileExists: (profileId) => productStore.getAgentProfile(profileId) !== null,
    now: options.now,
  });
  const baseSkillStore = pluginComponentResolver
    ? new PluginSkillFacade({ nativeStore: nativeSkillStore,
      resolver: pluginComponentResolver,
      toolCatalogRegistry: pluginToolCatalogRegistry }) : nativeSkillStore;
  const runtimeSkillStore = new LearnedSkillFacade({ base: baseSkillStore, store: learningStore,
    sources: { assertRefs: (...args) => learningSources.assertRefs(...args) },
    getRun: runId => productStore.getWorkRun(runId) });
  const nativeMcpStore = options.nativeMcpStore || new NativeMcpStore({
    paths,
    fs: options.nativeMcpFs,
    now: options.now,
  });
  const nativeMcpClientManager = options.nativeMcpClientManager || new NativeMcpClientManager({
    store: nativeMcpStore,
    spawn: options.nativeMcpSpawn,
    env: options.parentEnv,
  });
  const pluginHooks = pluginStore && pluginComponentResolver ? new (require("./plugin-hook-registry").PluginHookRegistry)({ store: pluginStore, resolver: pluginComponentResolver, now: options.now }) : null;
  const hookStore = options.hookStore || new HookStore({ paths, now: options.now });
  hookStore.pluginHooks = pluginHooks;
  const hookProcessHost = options.hookProcessHost || new HookProcessHost({ store: hookStore,
    cacheDir: paths.hookEphemeralDir || path.join(paths.cacheDir, "hooks"),
    pythonExecutable: options.hookPythonExecutable });
  const hookRunner = options.hookRunner || new HookRunner({ store: hookStore, processHost: hookProcessHost, now: options.now });
  const hookWorkspaceWriters = new HookWorkspaceWriters();
  const hookService = options.hookService || new HookService({ store: hookStore, runner: hookRunner, processHost: hookProcessHost, pluginHooks,
    productStore, getRun: id => workDispatcher.getRun(id), toolRegistry, permissionEngine,
    isMemorySharingQuery: (run, tool, payload) => tool?.scope === "product" && tool.name === "memory_search"
      && payload?.arguments?.memoryScope !== "own" && memoryEngine?.sharing?.policy({ profileId: run.profileId,
        workspace: run.workspace, run, maxSensitivity: "private" }).enabled === true,
    getBorrowedMemoryRefs: run => {
      const { mergeBorrowedMemoryRefs, refsFromEvents } = require("./shoggoth-memory/borrowed-memory-provenance.cjs");
      return mergeBorrowedMemoryRefs(memoryEngine?.sharing?.borrowedRefsForRun(run.id) || [],
        workRunCoordinator?.runExecutionContracts.get(run.id)?.borrowedMemoryRefs || [],
        !run.id && run.profileId && run.source === "chat" && run.sourceId
          ? refsFromEvents(transcriptStore.listEvents(run.profileId, run.sourceId)) : []);
    },
    cacheDir: paths.hookEphemeralDir || path.join(paths.cacheDir, "hooks"),
    requestApproval: input => workRunCoordinator.requestHookApproval(input),
    prepareNativeCapabilities: async (profile, run) => {
      const assignment = workRunCoordinator?.runHostAssignments.get(run.id);
      const runtime = assignment?.runtime || run.runtimeSessionRef?.runtime || profile.runtime;
      if (runtime !== "pi") return {};
      let handle = assignment?.host;
      if (!handle) {
        // This probe verifies the CLI version and extension, not a session's
        // execution permissions. Reuse the control host with the same policy
        // as model/auth reads; the admitted Run gets its own frozen policy.
        try {
          handle = await runtimeManager.acquire(runtimeBinding({ runtime,
            runtimeProfileId: profile.runtimeProfileId, runtimeAccountId: profile.runtimeAccountId }),
          { permissionPolicy: profile.permissionPolicy });
        } catch (error) {
          if (error?.code === "RUNTIME_HOST_CAPACITY") throw error;
          throw require("./runtime-stage-error").runtimeStageError("runtime_acquire", error);
        }
      }
      return handle.nativeHookCapabilities?.() || {};
    },
    resolveToolIdentity: async (scope, matcher, actor) => {
      const matches = name => matcher.toolNames.some(pattern => hookToolMatches(pattern, name));
      if (scope === "product") return permissionEngine.profileProjection(actor.profile.id).tools
        .filter(tool => tool.enabled && tool.effect !== "deny" && !HOOK_TOOL_NAMES.includes(tool.name)
          && !["mcp_server_call", "request_user_input", "proactive_respond"].includes(tool.name) && matches(tool.name));
      if (scope === "native_mcp") {
        const servers = nativeMcpStore.list().servers.filter(server => server.enabled
          && (!matcher.serverId || matcher.serverId === server.id));
        const found = [];
        for (const server of servers) {
          for (const tool of await nativeMcpClientManager.listTools(server.id)) if (matches(tool.name)) found.push({ serverId: server.id, name: tool.name });
        }
        return found;
      }
      if (scope === "plugin_mcp") return pluginRuntimeToolService?.hookToolTargets(actor.run, matcher) || [];
      if (scope === "runtime_builtin") return (hookService.capabilities(actor.profile, actor.run).scopes.runtime_builtin.guard.toolNames || [])
        .filter(matches).map(name => ({ name }));
      return [];
    }, now: options.now });
  hookToolExecution = new HookToolExecution({ service: hookService,
    getExecutionPolicy: runId => workRunCoordinator.hookExecutionPolicy(runId),
    assertWorkspaceWriter: (runId, workspace) => hookWorkspaceWriters.assert(runId, workspace) });
  hookService.nativeTools = new (require("./hook-native-tool-service").HookNativeToolService)({ service: hookService,
    toolExecution: hookToolExecution, getRun: id => workDispatcher.getRun(id),
    getProfile: id => productStore.getAgentProfile(id), getPolicy: id => workRunCoordinator.hookExecutionPolicy(id) });
  hookService.runtimeToolEvent = (request, scope) => hookService.nativeTools.dispatch(request, scope);
  hookService.runtimeBridge = new (require("./runtime-hook-bridge").RuntimeHookBridge)({ service: hookService,
    resolveAssignment: runId => {
      const assignment = workRunCoordinator.runHostAssignments.get(runId);
      return assignment && { host: assignment.host, bindingId: assignment.runtimeProfileId };
    } });
  const systemHostController = options.systemHostController || (options.systemHostAdapter
    ? new SystemHostController({
      host: options.systemHostAdapter,
      platform: options.platform,
      homeDirectory: options.homeDirectory,
      applicationRoots: options.applicationRoots,
      folderRoots: options.folderRoots,
      allowedUrlProtocols: options.allowedUrlProtocols,
      readPlist: options.readApplicationPlist,
      fs: options.systemHostFs,
    })
    : null);
  const isUseSessionAuthorized = (record, toolNames) => {
    try {
      const profile = productStore.getAgentProfile(record.profileId);
      const run = workDispatcher.getRun(record.workRunId);
      const tools = permissionEngine.profileProjection(record.profileId).tools;
      return profile?.enabled === true && run?.profileId === record.profileId
        && ["starting", "running", "waiting_approval", "waiting_input"].includes(run.status)
        && toolNames.every(name => tools.some(tool => tool.name === name
          && tool.enabled === true && tool.effect !== "deny"));
    } catch { return false; }
  };
  const computerUseController = options.computerUseController || (options.computerDriverPath
    ? new ComputerUseController({
      paths,
      binaryPath: options.computerDriverPath,
      binaryManifest: options.computerDriverManifest,
      hostBundleId: options.computerHostBundleId,
      sdkLoader: options.computerSdkLoader,
      permissionStatus: options.computerPermissionStatus,
      getSystemIdleTime: options.computerGetSystemIdleTime,
      isScreenLocked: options.computerIsScreenLocked,
      imageTransformer: options.computerImageTransformer,
      now: options.now,
      randomUUID: options.randomUUID,
      maxSessions: options.computerMaxSessions,
      verifyBinary: options.computerVerifyBinary,
      isAuthorized: record => isUseSessionAuthorized(record, ["computer_session_open"]),
    })
    : null);
  const browserConfigStore = options.browserConfigStore || require("../core/config-store").createConfigStore(
    path.join(paths.userDataRoot, "config.json"),
  );
  const browserUseController = options.browserUseController || new BrowserUseController({
    paths, getSettings: () => browserConfigStore.read().browserUse,
    clientFactory: options.browserClientFactory,
    engineStatus: options.browserEngineStatus,
    executable: options.browserExecutable,
    isAuthorized: record => isUseSessionAuthorized(record, ["browser_session_open", "browser_tool_call",
      ...(record.userWait ? ["browser_session_wait_for_user"] : [])]),
  });
  const contextSnapshotStore = options.contextSnapshotStore || new ContextSnapshotStore({
    paths,
    fs: options.contextSnapshotFs,
  });
  const contextBreakdownReader = new (require("./context-breakdown").ContextBreakdownReader)({ snapshotStore: contextSnapshotStore });
  const conversationCheckpointStore = options.conversationCheckpointStore
    || new (require("./conversation-checkpoint-store").ConversationCheckpointStore)({
      paths, transcriptStore, memoryStore, recallPolicy: memoryEngine.recallPolicy, now: options.now,
      borrowedMemoryDependenciesCurrent: (profileId, sessionId, refs) => memoryEngine.borrowedMemoryDependenciesCurrent?.(profileId, sessionId, refs) === true });
  const runtimeSelectionPolicyStore = options.runtimeSelectionPolicyStore
    || new (require("./runtime-selection-policy").RuntimeSelectionPolicyStore)({ paths, productStore });
  const sourceConversationStore = options.sourceConversationStore
    || new (require("./source-conversation-policy").SourceConversationStore)({ paths, chatSessionStore, now: options.now });
  const nativeMemorySemanticService = options.nativeMemorySemanticService || new NativeMemorySemanticService({
    paths, memoryEngine });
  memoryEngine.setSemanticSearchService?.(nativeMemorySemanticService);
  const contextCompiler = options.contextCompiler || new ContextCompiler({
    definitionStore: agentDefinitionStore,
    memoryEngine,
    semanticSearch: nativeMemorySemanticService,
    memoryStore,
    transcriptStore,
    toolRegistry,
    permissionEngine,
    skillStore: runtimeSkillStore,
    shouldOfferIntroduction: ({ profile, run }) => run.source === "chat"
      && !/^shoggoth:chat-send:(?:federation-(?:send|message)|group-(?:turn|task))-/u.test(run.idempotencyKey || "")
      && typeof workDispatcher.listRuns === "function"
      && !workDispatcher.listRuns({ profileId: profile.id }).some((prior) => prior.id !== run.id
        && ["chat", "inspiration"].includes(prior.source) && prior.status === "completed"),
    runtimeCapabilitiesForProfile: (profile) => {
      if (profile.runtime === "codex" || profile.runtime === undefined) {
        return ["mcp", "filesystem", "shell"];
      }
      return ["grok-build", "antigravity", "pi", "claude-code", "opencode", "deepseek-harness"]
        .includes(profile.runtime)
        ? ["mcp", "filesystem", "shell"] : [];
    },
    snapshotStore: contextSnapshotStore,
    checkpointStore: conversationCheckpointStore,
    now: options.now,
    budgets: options.contextBudgets,
  });
  const harnessDependencies = [
    [productStore, ["getAgentProfile"]],
    [agentDefinitionStore, ["get", "history", "readRevision", "update", "restore", "previewImport", "import", "readGeneratedView"]],
    [memoryStore, ["get", "getRevision", "list"]],
    [memoryEngine, ["propose", "update", "delete"]],
    [chatSessionStore, ["listSessions"]],
    [transcriptStore, ["listEvents", "getRevision", "setContextExcluded"]],
    [toolRegistry, ["list"]],
    [permissionEngine, ["profileProjection", "setProfileOverride"]],
    [nativeSkillStore, ["list", "setProfileSkill", "setGlobalSkill", "installFromDirectory", "uninstall", "preview", "usage"]],
  ];
  const agentHarnessServiceController = options.agentHarnessServiceController
    || (harnessDependencies.every(([value, methods]) => value
      && methods.every((method) => typeof value[method] === "function"))
      ? new AgentHarnessServiceController({
        productStore,
        definitionStore: agentDefinitionStore,
        memoryStore,
        memoryEngine,
        memoryProvenanceService,
        memoryCandidateService: candidateReview,
        memoryImportStatus: (profileId) => (codexMemoryImportService
          ? codexMemoryImportService.status(profileId) : { applicable: false }),
        memoryImportReport: (profileId, request) => (codexMemoryImportService
          ? codexMemoryImportService.report(profileId, request) : { applicable: false }),
        chatSessionStore,
        transcriptStore,
        toolRegistry,
        permissionEngine,
        skillStore: nativeSkillStore,
        learnedSkillStore: runtimeSkillStore,
        nativeMcpStore,
        nativeMcpClientManager,
        computerUseController,
        now: options.now,
      })
      : Object.freeze({
        handle() { throw serviceError("HARNESS_SERVICE_CLOSED", "Agent management is unavailable"); },
      }));
  if (!agentHarnessServiceController || typeof agentHarnessServiceController.handle !== "function") {
    throw new TypeError("Agent Harness Service Controller 必须提供 handle");
  }
  const lifecycleDependencies = [
    [productStore, [
      "listAgentProfiles", "getAgentProfile", "putAgentProfile", "listWorkRuns",
      "listMcpToolCalls", "lookupMcpToolCall", "beginMcpToolCall", "completeMcpToolCall",
    ]],
    [agentDefinitionStore, ["ensureProfile", "writeGeneratedView"]],
    [memoryStore, ["ensureProfile"]],
    [memoryEngine, ["rebuildViews"]],
    [nativeSkillStore, ["ensureProfile"]],
  ];
  const unavailableAgentLifecycleServiceController = Object.freeze({
    open() {},
    close() {},
    handle() { throw serviceError("AGENT_SERVICE_CLOSED", "Agent lifecycle is unavailable"); },
  });
  const chatUiStore = options.chatUiStore || new ChatUiStore({ paths, secretMatcher: isSensitiveValue, now: options.now, fault: options.chatUiFault });
  const retentionStores = [chatSessionStore, nativeCronStore, nativeKanbanStore,
    inspirationStore, proactiveStore, hookStore, permissionEngine, runtimeSessionOwnershipStore, tokenUsageStore, sourceConversationStore];
  const agentArchiveRetention = typeof productStore.purgeArchivedProfile === "function"
    && retentionStores.every((store) => typeof store.purgeProfile === "function")
    ? new AgentArchiveRetention({
      paths, productStore, now: options.now,
      ready: () => ["starting", "started"].includes(lifecycleState) && chatSessionStoreOpened && transcriptStoreOpened
        && nativeCronStoreOpened && nativeKanbanStoreOpened
        && inspirationStoreOpened && proactiveStoreOpened && domainAvailability.cron.available && domainAvailability.kanban.available,
      async stopProfile(profile) {
        await shoggothMemory?.stopProfile(profile.id);
        proactiveStore.pauseProfile(profile.id);
        hookStore.pauseProfile(profile.id);
        for (const view of agentRuntimeProfileViews(productStore, profile.id)) {
          await runtimeManager.stop({ runtime: view.runtime, runtimeProfileId: view.runtimeProfileId,
            runtimeAccountId: view.runtimeAccountId });
        }
        await computerUseController?.closeForProfile(profile.id);
        await browserUseController.closeForProfile(profile.id);
        pluginStore?.assertProfilePurgeReady(profile.id);
      },
      listPublishedArtifacts() {
        // A custom artifact location is external to the App-owned cleanup scope.
        if (options.artifactRoot && path.resolve(options.artifactRoot) !== path.join(paths.stateDir, "artifacts")) return [];
        return nativeKanbanStore.listCards().flatMap((card) => nativeKanbanStore.listArtifacts(card.id)
          .map((artifact) => ({ profileId: card.profileId, storageKey: artifact.storageKey })));
      },
      purgeProfile(profile) {
        // Drop all cross-store references before the Product snapshot. Replays
        // are idempotent, and shared Inspiration notes/accounts remain intact.
        pluginStore?.purgeProfileBindings(profile.id);
        learningStore.purgeProfile(profile.id);
        for (const store of retentionStores) store.purgeProfile(profile.id);
        productStore.purgeArchivedProfile(profile.id);
      },
      finalizePurge(profileId) {
        // Called after Product deletion and again for a journaled partial purge
        // whose Profile is missing on restart. The recall-policy installation
        // anchor lives outside the Profile directory and must be finalized
        // before retention drops its recovery journal.
        transcriptStore.forgetProfile(profileId);
        chatUiStore.forgetProfile(profileId);
        memoryStore.forgetProfile(profileId);
        memoryEngine.forgetProfile(profileId);
        memoryEngine.recallPolicy.forgetProfile(profileId);
        memoryProvenanceStore.forgetProfile(profileId);
        conversationRecallService.forgetProfile(profileId);
        nativeSkillStore.profileManifests?.delete(profileId);
        eventBuffer.append("agent.profile.changed", { profileId,
          backendId: "shoggoth" });
      },
    }) : null;
  const agentLifecycleServiceController = options.agentLifecycleServiceController
    || (lifecycleDependencies.every(([value, methods]) => value
      && methods.every((method) => typeof value[method] === "function"))
      ? createAgentLifecycleServiceController({
        productStore,
        archiveRetention: agentArchiveRetention,
        hasActiveExternalRuns: (profileId) => automationWorkRunStore.listWorkRuns({ profileId })
          .some((run) => run.status === "queued" || ACTIVE_WORK_RUN_STATUSES.has(run.status)),
        builtinAgents: {
          state: builtinAgentState,
          installedAccountIds: installedBuiltinAccountIds,
          beforeCreate: beforeCreateBuiltinAgentProfile,
          // Also gives an Agent created since the Service started its default
          // conversation, on the runtime it now defaults to, before greeting it.
          async afterEnsure({ locale }) {
            await chatServiceController.ensureDefaultSessions();
            return greetNewAgents(locale);
          },
        },
        runtimeManager: {
          stop(binding) {
            if (typeof runtimeManager.stop !== "function") {
              throw serviceError("AGENT_SERVICE_CLOSED", "Runtime targeted stop is unavailable");
            }
            return runtimeManager.stop(binding);
          },
        },
        async initializeProfile(profile, { initialIdentity } = {}) {
          shoggothMemory?.resumeProfile(profile.id);
          nativeSkillStore.ensureProfile(profile.id);
          agentDefinitionStore.ensureProfile({ profileId: profile.id, profileName: profile.name, initialIdentity });
          if (typeof toolRegistry.toolsMarkdown === "function"
            && typeof toolRegistry.revision === "string") {
            agentDefinitionStore.writeGeneratedView({
              profileId: profile.id,
              kind: "TOOLS",
              revision: toolRegistry.revision,
              content: toolRegistry.toolsMarkdown(),
            });
          }
          memoryStore.ensureProfile(profile.id);
          memoryEngine.rebuildViews(profile.id);
        },
        async activateProfile(profile) {
          if (proactiveStoreOpened) {
            proactiveStore.ensureHeartbeatMonitor(profile.id);
            proactiveScheduler.wake();
          }
          if (nativeKanbanStoreOpened && domainAvailability.kanban.available) {
            ensureAgentBoard(productStore, nativeKanbanStore, profile.id, { includeDisabled: true });
          }
        },
        onProfileChanged: (payload) => {
          chatUiController.profileChanged(payload.profileId);
          eventBuffer.append("agent.profile.changed", { ...payload, backendId: payload.backendId });
        },
        ...(pluginStore ? { revokePluginProfile: (profileId) =>
          pluginStore.revokeProfileBindings(profileId) } : {}),
        now: options.now,
      })
      : unavailableAgentLifecycleServiceController);
  if (!agentLifecycleServiceController
    || ["open", "close", "handle"].some((method) => (
      typeof agentLifecycleServiceController[method] !== "function"
    ))) {
    throw new TypeError("Agent Lifecycle Service Controller 必须提供 open/close/handle");
  }
  const MEMORY_CANDIDATE_BACKLOG_INTERVAL_MS = 5 * 60_000;
  const MEMORY_CONSOLIDATION_IDLE_MS = 60_000;
  const memoryConsolidationTimers = new Map();
  let memoryCandidateBacklogTimer = null;
  let memoryCandidateAbortController = null;
  const scheduleMemoryCandidateBacklog = (delayMs) => {
    if (lifecycleState !== "started" || memoryCandidateBacklogTimer
      || typeof memoryCandidateService?.processBacklog !== "function") return;
    memoryCandidateBacklogTimer = setTimeout(() => {
      memoryCandidateBacklogTimer = null;
      if (lifecycleState !== "started" || !memoryCandidateAbortController) return;
      const controller = memoryCandidateAbortController;
      Promise.resolve(memoryCandidateService.processBacklog({ signal: controller.signal }))
        .then((result) => {
          if (result?.failed > 0) {
            console.error("[agent-service] memory candidate backlog deferred:",
              JSON.stringify({ failed: result.failed, failures: result.failures }));
          }
        })
        .catch((error) => {
          const code = typeof error?.code === "string"
            && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(error.code)
            ? error.code : "MEMORY_CANDIDATE_BACKLOG_FAILED";
          console.error(`[agent-service] memory candidate backlog failed: ${code}`);
        })
        .finally(() => {
          if (lifecycleState === "started" && memoryCandidateAbortController === controller) {
            scheduleMemoryCandidateBacklog(MEMORY_CANDIDATE_BACKLOG_INTERVAL_MS);
          }
        });
    }, delayMs);
    memoryCandidateBacklogTimer.unref?.();
  };
  const CODEX_MEMORY_IMPORT_DELAY_MS = 60_000;
  const CODEX_MEMORY_IMPORT_RETRY_MS = 30 * 60_000;
  let codexMemoryImportTimer = null;
  let codexMemoryImportAbortController = null;
  const scheduleCodexMemoryImport = (delayMs) => {
    if (options.codexMemoryImport !== true || lifecycleState !== "started" || codexMemoryImportTimer) return;
    codexMemoryImportTimer = setTimeout(() => {
      codexMemoryImportTimer = null;
      const controller = codexMemoryImportAbortController;
      if (lifecycleState !== "started" || !controller) return;
      Promise.resolve(codexMemoryImportService.run({ signal: controller.signal })).then((status) => {
        if (["failed", "abandoned"].includes(status?.state)) {
          console.error(`[agent-service] Codex memory import ${status.state}: ${status.reason}`);
        }
        // The ledger owns the two-attempt limit. This timer only reconciles
        // persisted Cron state and waits for readiness or the single retry.
        if (["running", "deferred"].includes(status?.state) && lifecycleState === "started"
          && codexMemoryImportAbortController === controller) {
          scheduleCodexMemoryImport(status.state === "running" ? 5000 : CODEX_MEMORY_IMPORT_RETRY_MS);
        }
      }, (error) => {
        console.error(`[agent-service] Codex memory import failed: ${error?.code || "UNKNOWN"}`);
      });
    }, delayMs);
    codexMemoryImportTimer.unref?.();
  };
  const queueMemoryConsolidation = (run, payload) => {
    if (!["chat", "inspiration"].includes(run?.source) || payload?.status !== "completed") return;
    setImmediate(() => {
      // Content is curated through memory_save with authoritative provenance.
      // Terminal housekeeping only expires records; it must not re-extract a
      // forgotten item or interpret a quoted/negated 'remember' as consent.
      try { memoryEngine.consolidate(run.profileId); } catch {}
    });
  };
  const synchronizedSessionKey = (run) => run?.source === "inspiration"
    ? inspirationStore.executionForRun(run.id)?.sessionKey ?? null
    : run?.source === "cron" ? workRunCoordinator.getRunSessionKey(run)
    : isNativeFederationChatRun(run) ? run.sourceId : null;
  const handleRunInteraction = (run, interaction) => {
    if (run?.source === "inspiration") inspirationService.onInteraction(run, interaction);
    if (isGroupChatRun(run)) setImmediate(() => { try { groupChatDriver.onRunInteraction(run, interaction); } catch {} });
    const sessionKey = synchronizedSessionKey(run);
    if (!sessionKey) return;
    try {
      eventBuffer.append("federation.chat.interaction", {
        runId: run.id,
        profileId: run.profileId,
        sessionKey,
        interaction,
      });
    } catch (error) {
      if (error?.code === "EVENT_TOO_LARGE" && interaction?.phase === "requested"
        && interaction.eventType === "approval") {
        try {
          eventBuffer.append("federation.chat.interaction", {
            runId: run.id,
            profileId: run.profileId,
            sessionKey,
            interaction: {
              phase: "requested",
              eventType: "approval",
              requestId: interaction.requestId,
              payload: {
                requestId: interaction.requestId,
                method: "redacted",
                kind: "permissions",
                reason: "审批详情无法安全完整显示，只能拒绝或取消",
                sessionApprovalAvailable: false,
                expiresAt: Number.isSafeInteger(interaction.payload?.expiresAt)
                  ? interaction.payload.expiresAt : null,
                redacted: true,
              },
            },
          });
        } catch {
          // Even the bounded deny-only fallback is observer-only and must fail open.
        }
      }
      // UI 同步是旁路通知；持久化的交互请求不能被观察端故障反向改写。
    }
  };
  const publishFederationTerminal = (run, payload) => {
    const sessionKey = synchronizedSessionKey(run);
    if (!sessionKey) return;
    try {
      eventBuffer.append("federation.chat.terminal", {
        runId: run.id,
        profileId: run.profileId,
        sessionKey,
        status: payload?.status,
        result: payload?.cronOutput?.disposition === "silent" ? null : payload?.resultSummary ?? null,
        ...(payload?.cronOutput ? { outputDisposition: payload.cronOutput.disposition } : {}),
        errorCode: payload?.errorCode ?? null,
        finishedAt: run.finishedAt ?? (options.now || Date.now)(),
      });
    } catch {
      // UI 同步是旁路通知；持久化终态的 WorkRun 不能被观察端故障反向改写。
    }
  };
  const handleRunTerminal = (run, payload) => {
    queueMemoryConsolidation(run, payload);
    if (shoggothMemory && run) void shoggothMemory.finishActiveMemoryRun(run).catch(() => {});
    if (!shoggothMemory && payload?.status === "completed" && ["chat", "inspiration"].includes(run?.source)
      && !isNativeFederationChatRun(run)) {
      // A completed direct user conversation triggers background consolidation
      // once the session has been idle, so a burst of turns costs one model call.
      setImmediate(() => {
        if (lifecycleState !== "started") return;
        const session = candidateSessionForCompletedRun(run, payload,
          chatSessionStore, inspirationStore);
        if (!session) return;
        const key = `${run.profileId}\0${session.id}`;
        clearTimeout(memoryConsolidationTimers.get(key));
        const timer = setTimeout(() => {
          memoryConsolidationTimers.delete(key);
          if (lifecycleState !== "started") return;
          try {
            Promise.resolve(memoryCandidateService.processSession({
              profileId: run.profileId, sessionId: session.id,
              ...(memoryCandidateAbortController ? { signal: memoryCandidateAbortController.signal } : {}),
            })).catch(() => {});
          } catch {}
        }, options.memoryConsolidationIdleMs ?? MEMORY_CONSOLIDATION_IDLE_MS);
        timer.unref?.();
        memoryConsolidationTimers.set(key, timer);
      });
    }
    publishFederationTerminal(run, payload);
    if (run?.source === "cron" && codexMemoryImportService?.isSystemJob(run.sourceId)) {
      if (codexMemoryImportTimer) clearTimeout(codexMemoryImportTimer);
      codexMemoryImportTimer = null;
      scheduleCodexMemoryImport(0);
    }
    if (run?.source === "inspiration") inspirationService.onRunTerminal(run);
    if (isGroupChatRun(run)) {
      const terminal = { ...run, status: payload?.status ?? run.status, errorCode: payload?.errorCode ?? run.errorCode ?? null };
      setImmediate(() => { try { groupChatDriver.onRunTerminal(terminal); } catch {} });
    }
    setImmediate(() => {
      try { Promise.resolve(browserUseController.closeForWorkRun(run.profileId, run.id)).catch(() => {}); } catch {}
      if (!computerUseController || typeof computerUseController.closeForWorkRun !== "function") return;
      try { Promise.resolve(computerUseController.closeForWorkRun(run.profileId, run.id)).catch(() => {}); } catch {}
    });
  };
  const runtimeSupportFacts = require("./runtime-support").createRuntimeSupportFacts({
    runtimeManager, runtimeAccountAdmission, now: options.now,
    contextIdentity: (binding, profile) => {
      const resolved = productStore.resolveAgentRuntimeProfile(profile.id, binding.id);
      return captureExecutionProviderRoute({ productStore, secretStore, profile: resolved,
        modelRef: resolved.defaultModel }).providerFence;
    },
    ...(options.runtimeSupportDiscover ? { discover: options.runtimeSupportDiscover } : {}),
  });
  const createDefaultWorkRunCoordinator = () => createWorkRunCoordinator({
    ...(shoggothMemory ? { beforeMemoryCompaction: input => shoggothMemory.flushBeforeCompaction(input) } : {}),
    hookService, hookWorkspaceWriters,
    pluginRuntimeToolService,
    pluginStore,
    pluginToolCatalogRegistry,
    preparePluginSelection: pluginCatalogRestorer
      ? selection => pluginCatalogRestorer.prepareSelection(selection) : null,
    dispatcher: workDispatcher,
    productStore,
    usageStore: tokenUsageStore,
    cronStore: nativeCronStore,
    chatSessionStore,
    getMediaStore: () => inspirationStore.media,
    transcriptStore,
    contextCompiler,
    conversationCheckpointStore,
    sourceConversationStore,
    queueClock: new (require("./runtime-telemetry").RuntimeQueueClock)({ paths, now: options.now }),
    telemetry: runtimeTelemetry,
    runtimeContextCache: new (require("./runtime-context-cache").RuntimeContextCache)({ paths, now: options.now }),
    getRuntimeModelContextWindow: (session, profile) => session.runtimeBindingId ? runtimeSupportFacts.contextWindow(
      productStore.getAgentRuntimeBinding(session.profileId, session.runtimeBindingId), profile,
      session.modelOverride ?? profile.defaultModel) : null,
    getRuntimeModelContextLimits: (session, profile) => session.runtimeBindingId ? runtimeSupportFacts.contextLimits(
      productStore.getAgentRuntimeBinding(session.profileId, session.runtimeBindingId), profile,
      session.modelOverride ?? profile.defaultModel) : {},
    runExecutionStore,
    captureExecutionProviderRoute: (profile, modelRef) => captureExecutionProviderRoute({
      productStore, secretStore, profile, modelRef,
    }),
    assertExecutionProviderRouteCurrent: (contract) => assertExecutionProviderRouteCurrent(contract, {
      productStore, secretStore,
    }),
    resolveRunSession: (run) => inspirationStore.executionForRun(run.id),
    assertProactiveRunCurrent: run => proactiveService.assertRunCurrent(run),
    productMcpApprovalPolicy,
    onRunInteraction: handleRunInteraction,
    onRunTerminal: handleRunTerminal,
    validateRunCompletion: (run, report) => codexMemoryImportService?.completionError(run, report) ?? null,
    onTranscriptCommitted: (_event, run) => {
      conversationRecallService.scheduleWarm(run.profileId);
    },
    verifyMemoryExtractionSource: ({ profileId, sessionId, events }) => {
      // Candidate prompts are frozen before a Runtime is acquired. A forget,
      // context exclusion or journal replacement during that wait must stop
      // the model call, not merely discard its eventual candidate output.
      try {
        return events.every(({ eventId, text }) => {
          const raw = transcriptStore.getEvent(profileId, sessionId, eventId);
          if (!raw || raw.kind !== "user" || !Number.isSafeInteger(raw.seq)) return false;
          const page = conversationRecallService.scanEligibleSession({ profileId, sessionId,
            afterSeq: raw.seq - 1, limit: 1, completedOnly: true });
          return page.events.some((current) => current.eventId === eventId
            && current.seq === raw.seq && current.kind === "user" && current.text === text
            && conversationRecallService.assertCandidateSourceCurrent(profileId, current));
        });
      } catch { return false; }
    },
    onRuntimeContextChanged: (payload) => eventBuffer.append("runtime.context.updated", payload),
    runtimeSelectionPolicyStore,
    getCapabilityPolicyRevision: profileId => {
      const projection = permissionEngine.profileProjection(profileId);
      return crypto.createHash("sha256").update(JSON.stringify([projection.registryRevision, projection.tools])).digest("hex");
    },
    beforeSessionSend: async input => {
      const ownActive = workRunCoordinator.listSessionRuns(input.sessionKey).some(run =>
        ["starting", "running", "waiting_approval", "waiting_input"].includes(run.status));
      if (!ownActive) await codexDesktopSessionController?.assertSendable(input.sessionKey);
      const selected = await sessionRuntimeController.selectForSend(input);
      if (shoggothMemory && !workRunCoordinator.listSessionRuns(input.sessionKey).some(run =>
        ["starting", "running", "waiting_approval", "waiting_input"].includes(run.status))) {
        const session = chatSessionStore.getSession(input.sessionKey);
        if (require("./historical-chat-session").isHistoricalChatSession(session)) {
          const context = workRunCoordinator.getRuntimeContext(session);
          const budget = context?.productContext?.budget;
          await shoggothMemory.observeBeforeSend({ profileId: session.profileId, sessionId: session.id,
            prompt: input.prompt, contextUsage: context?.contextUsage,
            ...(budget && budget.source !== "fallback" ? { contextWindowTokens: budget.tokens } : {}) });
        }
      }
      return selected;
    },
    validateUiAction: input => chatUiController.assertOperationCurrent(input),
    onRuntimeMcpRequest: async (profileId, request, scope) => cloneMcpToolResult(await mcpProductToolController.handle(
      request.name, request.arguments, Object.freeze({ profileId, callId: request.callId,
        ...(request.confirmation === true ? { confirmation: true } : {}) }), scope)),
    onConversationRenewed: payload => { sessionRuntimeController.auditPending(); eventBuffer.append("runtime.context.updated", payload); },
    followDefaultSessionBinding: (sessionKey, runId) => sessionRuntimeController.followDefault(sessionKey, runId),
    inbox: pendingCommandInbox,
    runtimeManager,
    runtimeAccountAdmission,
    runtimeSessionOwnershipStore,
    getNativeRuntimeConfig,
    startupGate,
    now: options.now,
    randomUUID: options.randomUUID,
    assertSecretSafe,
    sanitizeSummary,
    // Persisted execution bindings belong to the default coordinator; custom
    // domain executors retain their own recovery ownership.
    recoverOrphanedDomainRuns: options.domainWorkRunExecutor === undefined,
  });
  const codexSchemaContract = options.codexSchemaContract || new CodexSchemaContract({
    repoRoot: options.repoRoot || path.join(__dirname, "..", ".."),
  });
  let codexDesktopSessionController;
  const createDefaultChatServiceController = (coordinator) => createChatServiceController({
    paths,
    productStore,
    chatSessionStore,
    transcriptStore,
    coordinator,
    memoryCommands: shoggothMemory?.activeMemoryCommands,
    getInspirationService: () => inspirationService,
    getProactiveSessionOrigin: sessionKey => proactiveStore.sessionOrigin(sessionKey),
    isInternalSession: sessionKey => groupChatStore.isInternalSessionKey(sessionKey),
    getCodexDesktopSessionOrigin: sessionKey => codexDesktopSessionController?.origin(sessionKey),
    getCronJobName: (jobId) => nativeCronStore.getJob(jobId)?.name,
    runtimePool: runtimeManager,
    runtimeSessionOwnershipStore,
    schemaContract: codexSchemaContract,
    cursorSecret: options.chatCursorSecret || crypto.randomBytes(32),
    now: options.now,
    randomUUID: options.randomUUID,
    listProfileModels: (params) => profileServiceController.handle("profile.models.list", params),
    listBindingModels: (params) => profileServiceController.handle("profile.binding.models.list", params),
    getRuntimeContext: (session) => coordinator.getRuntimeContext?.(session),
  });
  let workRunCoordinator = options.workRunCoordinator || createDefaultWorkRunCoordinator();
  const chatUiController = new ChatUiController({ store: chatUiStore, productStore, chatSessionStore,
    transcriptStore, coordinator: workRunCoordinator, memoryEngine, getConfig: () => chatUiConfig.read(), now: options.now, diagnosticSink: options.chatUiDiagnosticSink,
    verifyClick: async input => {
      try { return (await federationHostClient.request("chat.ui.click.verify", input)).approved === true; } catch { return false; }
    },
    getOrigins: (run, session) => ({ cron: chatSessionStore.getCronSessionOrigin(session.sessionKey),
      inspiration: inspirationStore.executionForSession(session.sessionKey), proactive: proactiveStore.sessionOrigin(session.sessionKey),
      federation: run && /^shoggoth:chat-send:federation-(?:send|message)-/u.test(run.idempotencyKey || "") ? { runId: run.id } : null,
      group: null }),
    assertPublishAllowed: sessionKey => {
      const session = chatSessionStore.getSession(sessionKey), activeTurns = [];
      for (const run of workDispatcher.listRuns({ source: "chat", sourceId: sessionKey })) {
        if (!["running", "waiting_input", "waiting_approval"].includes(run.status)
          || run.profileId !== session?.profileId || run.runtimeSessionRef?.runtime !== "codex"
          || run.runtimeSessionRef.sessionId !== session.runtimeSessionId || !run.runtimeTurnRef?.turnId) continue;
        try {
          workRunCoordinator.hostCapabilityIssuer.assert(workRunCoordinator.runCapabilityLeases.get(run.id), {
            kind: "mcp", identity: { runId: run.id, profileId: run.profileId, runtime: "codex",
              runtimeAccountId: run.runtimeSessionRef.runtimeAccountId },
            sessionId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId,
          });
          activeTurns.push(run.runtimeTurnRef.turnId);
        } catch { /* Unconfirmed ownership keeps the Desktop writer busy. */ }
      }
      return codexDesktopSessionController.assertSendable(sessionKey, activeTurns);
    },
  });
  chatUiController.listeners.add(event => {
    if (event.type === "revoked") eventBuffer.append("chat.ui.revoked", {
      profileId: event.profileId, sessionKey: event.sessionKey, artifactId: event.artifactId,
      revision: event.revision, reason: event.reason,
    });
  });
  const createDefaultCodexSecurityServiceController = () => pluginStore
    && workRunCoordinator instanceof WorkRunCoordinator
    ? createCodexSecurityServiceController({ store: pluginStore, resolver: pluginComponentResolver,
      bundledCatalog: bundledPluginCatalog, productStore, dispatcher: workDispatcher,
      capabilityIssuer: workRunCoordinator.hostCapabilityIssuer, runtimeAccountAdmission,
      accountAuthManager, getCoordinator: () => workRunCoordinator }) : null;
  let codexSecurityServiceController = createDefaultCodexSecurityServiceController();
  if (shoggothMemory) {
    shoggothMemory.sharing.onRevoked = runId => {
      chatUiController.reconcileSources(); return workRunCoordinator.stopBorrowedMemoryRun?.(runId);
    };
    shoggothMemory.sharing.onBorrowed = (runId, refs) => workRunCoordinator.recordBorrowedMemoryDependencies?.(runId, refs);
  }
  const conversationRecallService = options.conversationRecallService || new ConversationRecallService({
    paths, transcriptStore, chatSessionStore, workDispatcher, memoryStore,
    getRunSessionKey: (run) => workRunCoordinator.getRunSessionKey(run),
    recallPolicy: memoryEngine.recallPolicy,
    semanticSearch: nativeMemorySemanticService,
    getInspirationOrigin: (run) => inspirationStore.executionForRun(run.id),
  });
  learningSources = new LearningSources({ products: productStore, sessions: chatSessionStore,
    transcripts: transcriptStore, recall: conversationRecallService, getCoordinator: () => workRunCoordinator,
    assertSessionCurrent: (profileId, sessionId) => {
      if (!shoggothMemory) learningProtocol.fail("LEARNING_UNAVAILABLE");
      return shoggothMemory.host(profileId).sessions.current(profileId, sessionId);
    } });
  const learningService = new LearningService({ store: learningStore, sources: learningSources,
    products: productStore, dispatcher: workDispatcher, transcripts: transcriptStore,
    sessions: chatSessionStore, recall: conversationRecallService, getCoordinator: () => workRunCoordinator,
    // Unknown dependency ownership protects a Skill from automatic archival.
    hasDependencies: skill => nativeCronStore.listJobs().some(job => job.profileId === skill.profileId)
      || inspirationStore.list().length > 0,
    notify: notice => eventBuffer.append("learning.changed", { noticeId: notice.id, profileId: notice.profileId,
      change: notice.state || notice.action, attention: notice.actor !== "user" }), now: options.now,
    onError: error => console.error(`[agent-service] learning unavailable: ${error?.code || "UNKNOWN"}`) });
  if (shoggothMemory) shoggothMemory.onLearningSourcesChanged = profileId => {
    if (learningStore.db) learningService.reconcileSources(profileId);
  };
  if (!memoryCandidateService && shoggothMemory) {
    memoryCandidateService = {
      list: ({ profileId }) => ({ revision: memoryStore.getRevision(profileId), items: [],
        usage: { day: null, calls: 0, inputTokens: 0, outputTokens: 0 }, hasMore: false, nextCursor: null,
        owner: "shoggoth-memory-core", archive: shoggothMemory.migration.locations(profileId).directory }),
      ...Object.fromEntries(["accept", "acceptMany", "reject"].map(name => [name, () => {
        throw serviceError("MEMORY_CANDIDATE_ARCHIVED", "旧候选审核已归档；新记忆由 OpenClaw Dreaming 管理");
      }])),
      excludeSession: ({ profileId, sessionId }) => shoggothMemory.forgetSession(profileId, sessionId),
    };
  }
  if (!memoryCandidateService) {
    memoryCandidateService = new MemoryCandidateService({
      candidateStore: memoryCandidateStore, memoryEngine, memoryStore,
      conversationRecallService, chatSessionStore,
      provenanceService: memoryProvenanceService,
      extractCandidates: (input) => workRunCoordinator.extractMemoryCandidatesModelOnly(input),
      isProfileEligible: (profileId) => productStore.getAgentProfile(profileId)?.enabled === true,
      getProfileGeneration: (profileId) => productStore.getAgentProfile(profileId)?.updatedAt ?? null,
      now: options.now,
      autoConsolidate: true,
    });
  }
  shoggothMemory?.attach({ conversationRecall: conversationRecallService, checkpointStore: conversationCheckpointStore,
    getConfigProjection: () => nativeMemoryConfig.initialized
      ? nativeMemoryConfig.read() : { revision: 0, config: options.memoryCoreConfig || {} },
    resolveModelContext: input => workRunCoordinator.resolveMemoryModelContext(input),
    prepareModelContext: input => workRunCoordinator.prepareMemoryModelContext(input),
    complete: ({ profileId, prompt, model, modelSelection, execution, sessionKey, timeoutMs, signal, assertCurrent, onText }) => {
      return workRunCoordinator.generateMemoryImportText({ profileId, prompt,
        operationId: `shoggoth-memory-${crypto.randomUUID()}`, maxOutputBytes: 64 * 1024,
        ...(model ? { model } : {}), ...(sessionKey ? { sessionKey } : {}),
        ...(modelSelection ? { modelSelection } : {}),
        ...(execution ? { execution } : {}),
        ...(onText ? { onText } : {}),
        timeoutMs: Math.min(timeoutMs || 180_000, 15 * 60_000), ...(signal ? { signal } : {}),
        ...(assertCurrent ? { assertCurrent } : {}) });
    } });
  memoryEngine.recallPolicy?.setOnChange?.((profileId) => {
    nativeMemorySemanticService.invalidateProfile(profileId);
    conversationRecallService.refreshProfile(profileId);
    nativeMemorySemanticService.scheduleMemory(profileId);
    conversationRecallService.scheduleWarm(profileId);
  });
  const sessionRuntimeController = require("./session-runtime-controller").createSessionRuntimeController({
    productStore, chatSessionStore, transcriptStore, getCoordinator: () => workRunCoordinator, facts: runtimeSupportFacts,
    policyStore: runtimeSelectionPolicyStore,
    getNativeRuntimeConfig,
    ensureTranscript: session => chatServiceController.handle("chat.history", { sessionKey: session.sessionKey, cursor: null, limit: 1 }, null),
    listBindingModels: params => profileServiceController.handle("profile.binding.models.list", params),
    onChanged: payload => eventBuffer.append("runtime.context.updated", payload),
    isRetiredRuntimeSession: (runtime, sessionId) => runtimeManager.isRetiredSessionId?.(runtime, sessionId) === true,
  });
  let chatServiceController = options.chatServiceController
    || createDefaultChatServiceController(workRunCoordinator);
  const federationCoordinator = options.federationCoordinator || new FederationCoordinator({
    productStore,
    federationClient: federationHostClient,
    getChatServiceController: () => chatServiceController,
    getWorkRunCoordinator: () => workRunCoordinator,
    handleSecret: options.federationHandleSecret,
    getHandleSecret: options.federationHandleSecret ? undefined : () => crypto.createHash("sha256")
      .update("shoggoth-federation-task-handle-v1\0")
      .update(ensureFederationMcpCredential(paths).token)
      .digest(),
    now: options.now,
    randomUUID: options.randomUUID,
  });
  const domainWorkRunExecutor = options.domainWorkRunExecutor || new DomainWorkRunExecutor({
    getCoordinator: () => workRunCoordinator,
  });
  const inspirationService = new InspirationService({
    store: inspirationStore, productStore, chatSessionStore, transcriptStore, paths,
    dispatcher: workDispatcher, getCoordinator: () => workRunCoordinator,
    executor: domainWorkRunExecutor, now: options.now,
    externalExecutor: new ExternalInspirationExecutor({ store: inspirationStore,
      client: federationHostClient, sanitizeSummary, now: options.now,
      prompt: execution => inspirationService.buildPrompt(execution, true) }),
  });
  const inspirationReminders = new InspirationReminderService({ inspirationStore, inspirationService,
    proactiveStore, now: options.now });
  const proactiveVerifier = new (require("./proactive-runtime-verifier").ProactiveRuntimeVerifier)({ store: proactiveStore,
    productStore, codexAdapter: codexRuntimeAdapter, now: options.now });
  let proactiveCliFacts = { at: -Infinity, rows: [] };
  const proactiveProfileAvailable = profile => {
    if (options.proactiveProfileAvailable) return options.proactiveProfileAvailable(profile);
    if (!require("../runtime-availability").isRuntimeAvailable(profile.runtime)) return false;
    const now = (options.now || Date.now)();
    if (Math.abs(now - proactiveCliFacts.at) >= 30_000) {
      proactiveCliFacts = { at: now, rows: require("../runtime-cli-auth").createRuntimeCliAuth({ paths, repoRoot,
        parentEnv: options.parentEnv, homedir: options.runtimeStorageHomedir, packaged: options.packaged, resourcesPath: options.resourcesPath }) };
    }
    return proactiveCliFacts.rows.some(row => row.runtimeAccountId === profile.runtimeAccountId && row.binaryPath !== null);
  };
  const noticeDelivery = new NoticeDeliveryController({ store: proactiveStore, productStore, chatSessionStore, transcriptStore,
    resolveWorkspace: profileId => resolveProfileWorkspace({ paths, profile: productStore.getAgentProfile(profileId), requested: null, errorCode: "PROACTIVE_PROFILE_UNAVAILABLE" }),
    readConfig: () => browserConfigStore.read(), isFocused: async () => {
      try { return (await federationHostClient.request("notification.context", {})).focused; }
      catch { return false; }
    },
    sendSystemNotice: options.proactiveNotificationSender || options.notificationSender,
    validateNotice: notice => proactiveService.validateNotice(notice),
    onPublished: notice => eventBuffer.append("proactive.notice.published", { noticeId: notice.id,
      profileId: notice.profileId, sessionKey: notice.sessionKey }), now: options.now });
  const webSettings = new WebSettings({ paths, secretStore });
  const webService = options.webService || new WebService({ settings: webSettings });
  const heartbeatDocuments = new HeartbeatDocumentStore({ paths, productStore });
  const proactiveService = new ProactiveService({ store: proactiveStore, productStore, dispatcher: workDispatcher,
    heartbeatDocuments, webService,
    executor: domainWorkRunExecutor, getCoordinator: () => workRunCoordinator, reminders: inspirationReminders,
    delivery: noticeDelivery, usageStore: tokenUsageStore, now: options.now, randomUUID: options.randomUUID,
    reviewTimeoutMs: options.proactiveReviewTimeoutMs,
    sparkNotesProfileId: options.autoSparkNotes === false ? null : DEFAULT_AGENT_PROFILE_ID,
    getCapability: options.proactiveRuntimeCapability || (profile => proactiveVerifier.capability(profile)),
    verifyCapability: profileId => proactiveVerifier.verify(profileId),
    getProfileAvailability: proactiveProfileAvailable,
  });
  const proactiveScheduler = new ProactiveScheduler({ store: proactiveStore, service: proactiveService, now: options.now,
    setTimer: options.setProactiveTimer, clearTimer: options.clearProactiveTimer,
    onError: error => options.onProactiveError?.(error) });
  let groupAdapterChannel;
  const groupNativeToolExposure = new GroupNativeToolExposure({ now: options.now });
  const groupNativeToolPreparation = new (require("./group-native-tools-preparation").GroupNativeToolPreparation)({ now: options.now });
  const groupMemberDirectory = new GroupMemberDirectory({
    probeNative: input => groupNativeExecutor.probe?.(input),
    getGroupToolCapability: member => groupAdapterChannel?.capability(member) ?? null,
    groupToolsAvailable: member => groupAdapterChannel?.available(member) === true, store: groupChatStore, productStore,
    definitionStore: agentDefinitionStore, getFederationClient: () => federationHostClient, now: options.now,
    onChanged: groupId => { eventBuffer.append("group.changed", { groupId }); groupChatDriver.wake(groupId); } });
  const groupExternalExecutor = options.groupChatExternalExecutor || new GroupExternalExecutor({
    store: groupChatStore,
    getGroupToolCapability: member => groupAdapterChannel?.capability(member) ?? null,
    onChanged: (groupId) => { eventBuffer.append("group.changed", { groupId }); groupChatDriver.wake(groupId); },
    getClient: () => federationHostClient,
    onTerminal: (opportunityId, outcome) => groupChatDriver.onExternalTerminal(opportunityId, outcome),
    onInteraction: (opportunityId, attention) => groupChatDriver.onExternalInteraction(opportunityId, attention),
    onResumed: (opportunityId) => groupChatDriver.onExternalResumed(opportunityId),
    ...(options.groupChatExternalPollMs ? { pollMs: options.groupChatExternalPollMs } : {}),
    onError: () => {},
  });
  const groupNativeExecutor = options.groupChatExecutor || new GroupNativeExecutor({
    listBindingModels: params => profileServiceController.handle("profile.binding.models.list", params),
    resolveWorkspace: profile => resolveProfileWorkspace({ paths, profile, requested: null }),
    getGroupToolCapability: options.groupNativeToolCapability || (input => groupNativeToolPreparation
      .probe({ ...input, issuer: runtimeMcpGateIssuer, factory: groupRuntimeMcpFactory,
        mcpHelperLaunch, exposure: groupNativeToolExposure })),
    getChatServiceController: () => chatServiceController,
    getWorkRunCoordinator: () => workRunCoordinator,
    chatSessionStore, transcriptStore, now: options.now,
  });
  const groupDrafts = new GroupDraftTracker({ store: groupChatStore, nativeExecutor: groupNativeExecutor,
    externalExecutor: groupExternalExecutor, onChanged: (groupId) => eventBuffer.append("group.changed", { groupId }),
    onActivity: (opportunityId, activity) => groupChatDriver.onActivity(opportunityId, activity) });
  // 群消息的附件存在媒体库里（与私聊、灵感同一处）。外部成员没有原生附件通道，拿落盘文件的本机路径自己读。
  const groupAttachmentPath = (attachment) => {
    const { id, name, mimeType, size } = attachment;
    return inspirationStore.media.materialize({ id, name, mimeType, size });
  };
  // 成员随回复发送自己工作区里的文件：只认工作区内的普通文件，读进媒体库。
  const ingestGroupAttachment = async (rootRef, requested, key) => {
    const file = rootRef.external ? await groupExternalArtifacts.read(rootRef, requested) : groupArtifactFile(rootRef, requested);
    if (!file || file.content.length === 0) return null;
    const { uploadChatAttachments, mimeForFileName } = require("./chat-attachments");
    const fileName = path.basename(file.path ?? file.target);
    try {
      const [attachment] = await uploadChatAttachments(async (_method, params) => inspirationStore.media.write(params),
        [{ fileName, mimeType: mimeForFileName(fileName), content: file.content.toString("base64") }], key);
      return attachment;
    } catch { return null; }
  };
  const groupChatDriver = new GroupChatDriver({
    store: groupChatStore,
    externalExecutor: groupExternalExecutor,
    directory: groupMemberDirectory,
    drafts: groupDrafts,
    attachmentPath: groupAttachmentPath,
    ingestAttachment: ingestGroupAttachment,
    executor: groupNativeExecutor,
    onChanged: (groupId) => eventBuffer.append("group.changed", { groupId }),
    ...(options.groupChatTurnTimeoutMs ? { inactivityMs: options.groupChatTurnTimeoutMs } : {}),
    ...(options.groupChatReleaseAfterToolMs ? { releaseAfterToolMs: options.groupChatReleaseAfterToolMs } : {}),
    onError: (error) => console.error(`[agent-service] group chat driver: ${error?.code || error?.message || "UNKNOWN"}`),
  });
  // 成员随回复发送的文件：只认这次运行所在工作区里的普通文件。原生成员是会话工作区；外部成员是
  // App 准备会话时报告的实际工作区（本机路径才能核验）。
  const groupExternalArtifacts = new (require("./group-external-artifacts").GroupExternalArtifacts)({ store: groupChatStore, getClient: () => federationHostClient });
  const groupArtifactFile = ({ sessionKey = null, workspace = null }, requested) => {
    const base = workspace ?? (sessionKey ? chatSessionStore.getSession(sessionKey)?.workspace : null);
    if (typeof base !== "string" || !path.isAbsolute(base)) return null;
    try {
      const root = fs.realpathSync(base);
      const target = fs.realpathSync(path.resolve(root, requested));
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
      const stat = fs.statSync(target);
      if (!stat.isFile() || stat.size > 64 * 1024 * 1024) return null;
      const content = fs.readFileSync(target);
      return { root, target, content, digest: crypto.createHash("sha256").update(content).digest("hex") };
    } catch { return null; }
  };
  const groupChatService = new GroupChatService({ store: groupChatStore, driver: groupChatDriver,
    nativeExecutor: groupNativeExecutor, directory: groupMemberDirectory, productStore,
    getFederationClient: () => federationHostClient, getMediaStore: () => inspirationStore.media,
    onChanged: (groupId) => eventBuffer.append("group.changed", { groupId }) });
  groupAdapterChannel = new GroupAdapterChannel({ paths, service: groupChatService, now: options.now });
  const kanbanRunService = options.kanbanRunService || new KanbanRunService({
    dispatcher: workDispatcher,
    kanbanStore: nativeKanbanStore,
    executor: domainWorkRunExecutor,
    resolveTargetState(profileId) {
      const profile = productStore.getAgentProfile(profileId);
      if (!profile) {
        throw serviceError("KANBAN_RUN_CORRUPT", "Kanban Card 绑定的 AgentProfile 不存在");
      }
      return profile.enabled && require("../runtime-availability").isRuntimeAvailable(profile.runtime)
        ? "enabled" : "disabled";
    },
    resolveWorkspace(profileId, requested) {
      const profile = productStore.getAgentProfile(profileId);
      if (!profile) {
        throw serviceError("KANBAN_RUN_CORRUPT", "Kanban Card 绑定的 AgentProfile 不存在");
      }
      return resolveProfileWorkspace({
        paths,
        profile,
        requested,
        errorCode: "KANBAN_RUN_CORRUPT",
      });
    },
    now: options.now,
    randomUUID: options.randomUUID,
    onFatalError: (error) => reportDomainFatal("kanban", error),
  });
  const codexAutomationController = options.codexAutomationController || new CodexAutomationController({
    productStore, resolver: runtimePool.runtimeAccountResolver, adapter: codexRuntimeAdapter,
    dispatcher: workDispatcher, coordinator: workRunCoordinator, paths, now: options.now,
    // Without the record, ownership is re-elected on every request instead.
    ownerState: {
      codexAutomationOwner: () => (builtinAgentState.opened ? builtinAgentState.codexAutomationOwner() : null),
      setCodexAutomationOwner: (profileId) => {
        if (builtinAgentState.opened) builtinAgentState.setCodexAutomationOwner(profileId);
      },
    },
  });
  codexDesktopSessionController = options.codexDesktopSessionController || new CodexDesktopSessionController({
    automations: codexAutomationController, productStore, sessions: chatSessionStore, transcripts: transcriptStore,
    contextSnapshots: contextSnapshotStore, checkpoints: conversationCheckpointStore,
    ownership: runtimeSessionOwnershipStore, adapter: codexRuntimeAdapter, schemaContract: codexSchemaContract,
    cursorSecret: options.chatCursorSecret, databaseFactory: options.codexDesktopDatabaseFactory, now: options.now,
  });
  const nativeCronScheduler = options.nativeCronScheduler || new NativeCronScheduler({
    ...(shoggothMemory ? { memoryMaintenance: shoggothMemory.maintenance } : {}),
    cronStore: nativeCronStore,
    dispatcher: workDispatcher,
    executor: domainWorkRunExecutor,
    now: options.now,
    monotonicNow: options.monotonicNow,
    setTimer: options.setCronTimer,
    clearTimer: options.clearCronTimer,
    randomUUID: options.randomUUID,
    resolveTargetState(profileId) {
      const profile = productStore.getAgentProfile(profileId);
      if (!profile) {
        throw serviceError("CRON_RUN_CORRUPT", "Cron Job 绑定的 AgentProfile 不存在");
      }
      return profile.enabled && require("../runtime-availability").isRuntimeAvailable(profile.runtime)
        ? "enabled" : "disabled";
    },
    resolveWorkspace(profileId, requested) {
      const profile = productStore.getAgentProfile(profileId);
      if (!profile) {
        throw serviceError("CRON_RUN_CORRUPT", "Cron Job 绑定的 AgentProfile 不存在");
      }
      return resolveProfileWorkspace({
        paths,
        profile,
        requested,
        errorCode: "CRON_RUN_CORRUPT",
      });
    },
    onFatalError: (error) => reportDomainFatal("cron", error),
  });
  codexMemoryImportService = new CodexMemoryImportService({
    store: codexMemoryImportStore, profileId: DEFAULT_AGENT_PROFILE_ID,
    readRunReport: (run) => {
      const key = workRunCoordinator.getRunSessionKey(run);
      if (!key) return null;
      const session = chatSessionStore.getSession(key);
      if (!session || session.profileId !== run.profileId) return null;
      const answers = transcriptStore.listEvents(run.profileId, session.id).filter((event) =>
        event.runId === run.id && event.kind === "assistant" && event.content?.delivery !== "async"
        && !event.contextExcluded && typeof event.content?.text === "string");
      const answer = answers.findLast((event) => event.content.phase === "final_answer")
        || answers.findLast((event) => event.content.phase == null);
      if (!answer) return null;
      // Native display text is bounded. Its existing hash-checked transcript
      // content object carries the full answer; do not present a prefix as all.
      const full = transcriptStore.contextEvent(run.profileId, session.id, answer);
      if (full.content.contextComplete === false || answer.content.contextRef?.complete === false) {
        throw serviceError("MEMORY_IMPORT_REPORT_INCOMPLETE", "运行报告正文未完整保存");
      }
      return typeof full.content.text === "string" ? full.content.text : null;
    },
    cronStore: nativeCronStore, scheduler: nativeCronScheduler, dispatcher: workDispatcher,
    // Test injection is explicit; production resolves the OS account, never Runtime HOME.
    readSource: options.readCodexMemorySource || ((name) => readCodexMemorySource(name)),
    isProfileReady: (profileId) => {
      try { return productStore.resolveAgentRuntimeProfile(profileId)?.enabled === true; }
      catch { return false; }
    },
    now: options.now, randomUUID: options.randomUUID,
  });
  let defaultCoordinatorRetired = false;
  let defaultControllerRetired = false;
  let defaultDomainControllerRetired = false;
  let defaultMcpProductToolControllerRetired = false;
  let mcpSessionManager = null;
  let mcpAuthInitAttempt = null;
  let mcpAuthFailureGeneration = null;
  let mcpAuthMigration = null;
  let storeOpened = false;
  let pluginStoreOpened = false;
  let externalPluginProvenanceOpened = false;
  let externalPluginSelectionDispatchOpened = false;
  let tokenUsageStoreOpened = false;
  let secretStoreOpened = false;
  let mcpCryptoBrokerOpened = false;
  let runtimeMcpGateIssuerOpened = false;
  let providerRuntimeOpened = false;
  let providerServiceOpened = false;
  let accountAuthStateOpened = false;
  let accountAuthManagerOpened = false;
  let codexSecurityServiceControllerOpened = false;
  let runtimeSessionOwnershipStoreOpened = false;
  let runtimeAccountServiceControllerOpened = false;
  let profileServiceControllerOpened = false;
  let agentLifecycleServiceControllerOpened = false;
  let chatSessionStoreOpened = false;
  let inspirationStoreOpened = false;
  let proactiveStoreOpened = false;
  let groupChatStoreOpened = false;
  let hookStoreOpened = false;
  let proactiveServiceOpened = false;
  let learningStoreOpened = false;
  let unsubscribeLearningUsage = null;
  let proactiveSchedulerOpened = false;
  let agentDefinitionStoreOpened = false;
  let transcriptStoreOpened = false;
  let chatUiStoreOpened = false;
  let memoryStoreOpened = false;
  let memoryEngineOpened = false;
  let memoryProvenanceStoreOpened = false;
  let permissionEngineOpened = false;
  let nativeSkillStoreOpened = false;
  let nativeMcpStoreOpened = false;
  let computerUseControllerOpened = false;
  let browserUseControllerOpened = false;
  let contextSnapshotStoreOpened = false;
  let conversationCheckpointStoreOpened = false;
  let pendingCommandInboxOpened = false;
  let chatServiceControllerOpened = false;
  let workRunCoordinatorOpened = false;
  let workRunCoordinatorReady = false;
  let pendingInboxRecoveryNeeded = false;
  let pendingInboxRecovery = null;
  let nativeKanbanStoreOpened = false;
  let kanbanRunServiceOpened = false;
  let nativeCronStoreOpened = false;
  let nativeCronSchedulerOpened = false;
  const domainAvailability = {
    kanban: { available: true, reason: null },
    cron: { available: true, reason: null },
  };
  const createDefaultNativeDomainServiceController = () => {
    const ownerToken = Object.freeze({});
    const controller = new NativeDomainServiceController({
      kanbanStore: nativeKanbanStore,
      kanbanRunService,
      cronStore: nativeCronStore,
      cronScheduler: nativeCronScheduler,
      isSystemCronJob: (jobId) => codexMemoryImportService?.isSystemJob(jobId) === true,
      workDispatcher,
      usageStore: tokenUsageStore,
      federationClient: federationHostClient,
      getServiceStatus: async () => ({
        healthy: lifecycleState === "started",
        serviceVersion,
        startedAt,
        domainAvailability: domainAvailabilitySnapshot(),
        pendingCommandsLocked: typeof pendingCommandInbox.isLocked === "function"
          ? pendingCommandInbox.isLocked() : true,
        mcpCredentialsLocked: mcpSessionManager === null,
      }),
      getDomainAvailability: domainAvailabilitySnapshot,
      onFatalDomainError: (domain, error) => reportDomainFatal(domain, error, ownerToken),
      describeCronRun,
      getRunSessionKey: (run) => workRunCoordinator.getRunSessionKey?.(run) ?? null,
      getCronOutput: (run) => workRunCoordinator.getCronOutput?.(run) ?? null,
      cursorSecret: options.domainCursorSecret || crypto.randomBytes(32),
      now: options.now,
      randomUUID: options.randomUUID,
    });
    return { controller, ownerToken };
  };
  const initialDomainController = options.nativeDomainServiceController
    ? null : createDefaultNativeDomainServiceController();
  let nativeDomainServiceController = options.nativeDomainServiceController
    || initialDomainController.controller;
  let nativeDomainServiceControllerOwnerToken = initialDomainController?.ownerToken || null;
  let activeDomainControllerOwnerToken = null;
  if (!nativeDomainServiceController
    || typeof nativeDomainServiceController.handle !== "function") {
    throw new TypeError("Native Domain Service Controller 必须提供 handle");
  }
  const workspaceExecutionService = options.workspaceExecutionService
    || new (require("./workspace-execution").WorkspaceExecutionService)({
      cacheDir: path.join(paths.cacheDir, "workspace-execution"), paths,
      requestApproval: input => workRunCoordinator.requestWorkspaceApproval(input),
      pauseRuntimeTimeout: input => workRunCoordinator.pauseManagedWorkspaceTimeout(input),
    });
  const createDefaultMcpProductToolController = () => {
    const ownerToken = Object.freeze({});
    const requiredDependencies = [
      [productStore, ["getAgentProfile", "addRunNote", "lookupMcpToolCall",
        "beginMcpToolCall", "completeMcpToolCall"]],
      [nativeDomainServiceController, ["handle"]],
      [nativeKanbanStore, ["getBoard", "getCard", "listCardRunLinks",
        "getCardRunLinkByRunId", "addComment", "addArtifact", "listArtifacts"]],
      [kanbanRunService, ["requestCompletionFromAgent"]],
      [nativeCronStore, ["getJob"]],
      [workDispatcher, ["getRun"]],
      [workRunCoordinator, ["getRuntimeContextForSource"]],
      [tokenUsageStore, ["summarize"]],
      [federationHostClient, ["request"]],
      [federationCoordinator, ["list", "get", "run", "message", "taskGet", "cancel"]],
    ];
    // 旧有生命周期/故障注入测试会显式替换某个 domain dependency 的最小表面。
    // 该组合不能被 Product 工具误当成可用；固定 unavailable stub 让普通 Service
    // 仍可验证自身域，同时 MCP 调用严格 fail closed。正式默认依赖始终走完整 Controller。
    if (requiredDependencies.some(([value, methods]) => (
      !value || methods.some((method) => typeof value[method] !== "function")
    ))) {
      return {
        controller: Object.freeze({
          async handle() {
            throw serviceError(
              "MCP_TOOL_UNAVAILABLE", MCP_TOOL_PUBLIC_MESSAGES.MCP_TOOL_UNAVAILABLE,
            );
          },
        }),
        ownerToken,
      };
    }
    const controller = new McpProductToolController({
      workspaceExecutionService,
      getExecutionContract: runId => workRunCoordinator.runExecutionContracts.get(runId),
      onNativeGroupToolExposure: ({ profileId, runId, name }) => {
        const contract = workRunCoordinator.runExecutionContracts.get(runId);
        if (!contract || contract.profileId !== profileId) return;
        const { runtimeProfileId, runtimeAccountId } = contract;
        groupNativeToolExposure.recordInvocation({ runtimeProfileId, runtimeAccountId, runId, name }, { authorize: () => {
          if (!workRunCoordinator.hasActiveRuntimeWork(runtimeProfileId, runtimeAccountId, runId)) {
            throw serviceError("MCP_SESSION_INVALID", "mcp_session_invalid");
          }
        } });
      },
      hookService, hookToolExecution,
      productStore,
      domainController: nativeDomainServiceController,
      agentLifecycleService: agentLifecycleServiceController,
      kanbanStore: nativeKanbanStore,
      kanbanRunService,
      cronStore: nativeCronStore,
      workDispatcher,
      getRuntimeContext: (profileId, selector) => workRunCoordinator.getRuntimeContextForSource(
        profileId, selector.source, selector.sourceId),
      getProductHelpContext: (profileId, runId) => runId
        ? workRunCoordinator.getProductHelpContext(profileId, runId) : null,
      usageStore: tokenUsageStore,
      federationClient: federationHostClient,
      federationCoordinator,
      skillStore: runtimeSkillStore,
      nativeMcpStore,
      nativeMcpClientManager,
      pluginRuntimeToolService,
      pluginAuthoringService,
      pluginQuickSetup,
      requestPluginSecretInput: async ({ run, scope, card, signal }) => {
        const result = await workRunCoordinator.requestProductUserInput({ runId: run.id,
          profileId: run.profileId, signal, assertCurrent: scope.assertCurrent,
          params: { message: card.message, requestedSchema: { type: "object", properties: {
            [card.field.id]: { type: "string", title: card.field.title,
              description: card.field.description, format: "password" },
          }, required: [card.field.id] } } });
        return result?.action === "accept" && typeof result.content?.[card.field.id] === "string"
          ? result.content[card.field.id] : null;
      },
      conversationMemoryService: new ConversationMemoryService({
        memoryEngine, memoryStore, transcriptStore, chatSessionStore,
        memoryProvenanceService,
        semanticSearch: nativeMemorySemanticService,
        getRunSessionKey: (run) => workRunCoordinator.getRunSessionKey(run),
        getInspirationOrigin: (run) => inspirationStore.executionForRun(run.id),
      }),
      conversationRecallService,
      getGroupChatService: () => groupChatService,
      chatUiController,
      conversationDefinitionService: new ConversationDefinitionService({
        definitionStore: agentDefinitionStore, productStore, transcriptStore, chatSessionStore,
        agentLifecycleService: agentLifecycleServiceController,
        getRunSessionKey: (run) => workRunCoordinator.getRunSessionKey(run),
        onProfileRenamed: (profileId) => {
          const profile = productStore.getAgentProfile(profileId);
          eventBuffer.append("agent.profile.renamed", { profileId, backendId: profile.backendId });
        },
      }),
      inspirationService,
      appStateService: new AppStateReadService({
        productStore, cronStore: nativeCronStore, kanbanStore: nativeKanbanStore,
        inspirationStore, inspirationService, chatSessionStore, usageStore: tokenUsageStore,
        runtimeAccountController: runtimeAccountServiceController,
        nativeSkillStore, skillStore: runtimeSkillStore, nativeMcpStore, pluginStore, bundledPluginCatalog, agentDefinitionStore,
        federationClient: federationHostClient, computerUseController, browserUseController,
        productToolCount: toolRegistry.mcpDefinitions().length,
        getSettings: () => browserConfigStore.read(),
        getServiceStatus: async () => ({
          healthy: lifecycleState === "started", serviceVersion, startedAt,
          domainAvailability: domainAvailabilitySnapshot(),
          pendingCommandsLocked: typeof pendingCommandInbox.isLocked === "function" ? pendingCommandInbox.isLocked() : true,
          mcpCredentialsLocked: mcpSessionManager === null,
        }),
        now: options.now,
      }),
      proactiveService,
      learningService,
      webService,
      webSettings,
      systemHostController,
      computerUseController,
      browserUseController,
      requestBrowserUserInput: async ({ run, scope, instructions, signal }) => {
        const result = await workRunCoordinator.requestProductUserInput({ runId: run.id,
          profileId: run.profileId, signal, assertCurrent: scope.assertCurrent,
          params: { message: `请在当前 Chrome 窗口完成操作：${instructions}\n完成后选择“已完成操作”；账号密码、验证码只在浏览器内输入。`,
            requestedSchema: { type: "object", properties: { browser_user_action: {
              type: "string", title: "浏览器人工接管", description: instructions,
              enum: ["已完成操作", "取消并关闭"], enumNames: ["已完成操作", "取消并关闭"],
            } }, required: ["browser_user_action"] } },
        });
        return result?.action === "accept" && result.content?.browser_user_action === "已完成操作";
      },
      getServiceStatus: async () => ({
        healthy: lifecycleState === "started",
        serviceVersion,
        startedAt,
        domainAvailability: domainAvailabilitySnapshot(),
        pendingCommandsLocked: typeof pendingCommandInbox.isLocked === "function"
          ? pendingCommandInbox.isLocked() : true,
        mcpCredentialsLocked: mcpSessionManager === null,
      }),
      notificationSender: options.notificationSender || (async () => {
        throw serviceError("NOTIFICATION_FAILED", MCP_TOOL_PUBLIC_MESSAGES.NOTIFICATION_FAILED);
      }),
      isSensitiveValue,
      onFatalError: (error) => reportMcpProductFatal(error, ownerToken),
      artifactRoot: options.artifactRoot || path.join(paths.stateDir, "artifacts"),
      toolRegistry,
      permissionEngine,
      fs: options.artifactFs,
      now: options.now,
      randomUUID: options.randomUUID,
    });
    return { controller, ownerToken };
  };
  const initialMcpProductToolController = options.mcpProductToolController
    ? null : createDefaultMcpProductToolController();
  let mcpProductToolController = options.mcpProductToolController
    || initialMcpProductToolController.controller;
  let mcpProductToolControllerOwnerToken = initialMcpProductToolController?.ownerToken || null;
  let activeMcpProductToolControllerOwnerToken = null;
  if (!mcpProductToolController || typeof mcpProductToolController.handle !== "function") {
    throw new TypeError("MCP Product Tool Controller 必须提供 handle");
  }
  const domainFatalReports = { kanban: null, cron: null };
  let mcpProductFatalReport = null;
  let startupFatal = null;
  const eventBuffer = options.eventBuffer || createEventBuffer(MAX_FRAME_BYTES);
  const sockets = new Set();
  const inFlightSockets = new Set();
  let maintenanceQuiesced = false;
  let recoveryDiagnosticWritten = false;
  const bridgeSockets = new Map();

  function coreRecoveryFailure() {
    // Hook snapshots are mandatory even when no rules are enabled. A closed,
    // unfenced or poisoned Store cannot keep advertising a healthy Service.
    let hookError = null;
    try { hookStore.ready(); } catch (error) { hookError = error; }
    const failures = [
      ["product-store", productStore.commitUncertain, "STORE_COMMIT_UNCERTAIN", productStore.commitError],
      ["transcript-store", transcriptStore.poisonError, "TRANSCRIPT_COMMIT_UNCERTAIN", transcriptStore.poisonError],
      ["chat-session-store", chatSessionStore.commitUncertain, "CHAT_SESSION_COMMIT_UNCERTAIN", null],
      ["pending-command-inbox", pendingCommandInbox.commitUncertain, "PENDING_COMMAND_COMMIT_UNCERTAIN", null],
      ["hook-store", hookError, "HOOK_UNAVAILABLE", hookStore.poisonError || hookError],
      ["work-run-coordinator", workRunCoordinator.poisonError, "WORK_RUN_COORDINATOR_UNAVAILABLE", workRunCoordinator.poisonError],
    ];
    const failed = failures.find(([, failure]) => Boolean(failure));
    if (!failed) return null;
    const [component, , errorCode, error] = failed;
    let causeCode = null;
    let cause = error;
    for (let depth = 0; depth < 3 && cause; depth += 1) {
      const code = probeDataProperty(cause, "code");
      if (code.ok && ["ENOSPC", "EDQUOT", "EIO", "EROFS", "SQLITE_FULL", "SQLITE_IOERR", "SQLITE_CORRUPT", "SQLITE_NOTADB"].includes(code.value)) {
        causeCode = code.value;
        break;
      }
      // Node's built-in SQLite reports ERR_SQLITE_ERROR with a numeric (possibly
      // extended) errcode. Keep the same closed diagnostic codes as better-sqlite3.
      const errcode = probeDataProperty(cause, "errcode");
      if (code.ok && code.value === "ERR_SQLITE_ERROR" && errcode.ok && Number.isInteger(errcode.value)) {
        causeCode = { 10: "SQLITE_IOERR", 11: "SQLITE_CORRUPT", 13: "SQLITE_FULL", 26: "SQLITE_NOTADB" }[errcode.value & 255] || null;
        if (causeCode) break;
      }
      const next = probeDataProperty(cause, "cause");
      cause = next.ok ? next.value : null;
    }
    return { component, errorCode, causeCode };
  }

  function rejectCoreRecoveryRequest(socket, id, failure) {
    // Keep only the last failure, with closed codes and no paths, prompts or
    // credentials. A full disk may prevent recording; a later probe can retry.
    if (!recoveryDiagnosticWritten) {
      try {
        atomicWritePrivateFile(path.join(paths.runtimeDir, "service-recovery.json"),
          `${JSON.stringify({ version: 1, observedAt: Date.now(), ...failure })}\n`,
          { trustedRoot: paths.trustedRoot });
        recoveryDiagnosticWritten = true;
      } catch { /* Diagnostic I/O must not hide the authoritative recovery gate. */ }
    }
    writeResponse(socket, { id: id ?? null, ok: false, error: {
      code: "SERVICE_RECOVERY_REQUIRED", message: "Service 持久状态未验证，需要重新启动后核对",
      ...(["ENOSPC", "EDQUOT", "SQLITE_FULL"].includes(failure.causeCode) ? { systemIssue: "STORAGE_FULL" } : {}),
    } });
  }

  function mcpAuthGenerationIsActive(generation) {
    return lifecycleGeneration === generation
      && (lifecycleState === "started"
        || (lifecycleState === "starting" && mcpTransportReady))
      && mcpCryptoBrokerOpened;
  }

  async function closeUnpublishedMcpManager(manager) {
    if (!manager || typeof manager.close !== "function") return;
    try { await manager.close(); } catch { /* 未发布对象只做 best-effort 销毁 */ }
  }

  function ensureMcpSessionManager() {
    if (mcpSessionManager) return mcpSessionManager;
    const generation = lifecycleGeneration;
    if (!mcpAuthGenerationIsActive(generation)) {
      throw serviceError("SERVICE_UNAVAILABLE", "mcp_auth_unavailable");
    }
    // 一次 Keychain/safeStorage 失败后，本代保持 MCP locked。否则每个新的
    // challenge 都会再启动一次 Electron crypto worker，反复弹系统钥匙串窗口。
    // 用户解锁后通过重启 Service 进入新 generation，再允许一次受控重试。
    if (mcpAuthFailureGeneration === generation) {
      throw serviceError("SERVICE_UNAVAILABLE", "mcp_auth_unavailable");
    }
    if (mcpAuthInitAttempt?.generation === generation) return mcpAuthInitAttempt.result;

    // safeStorage 属于 MCP 的可选凭据边界：放到请求期 singleflight，避免 Service
    // start/socket 健康依赖系统密钥库。Promise 形态也让测试与可替换实现具备超时边界。
    let resultSettled = false;
    let secretConsumed = false;
    const loadPromise = Promise.resolve().then(() => {
      if (!mcpAuthGenerationIsActive(generation)) {
        throw serviceError("SERVICE_UNAVAILABLE", "mcp_auth_unavailable");
      }
      return mcpCryptoBroker.loadOrCreateForService({ generation });
    });
    const guardedLoad = loadPromise.then((secret) => {
      // 超时/stop 后底层调用仍可能迟到；它不得发布 manager，明文也必须立即清零。
      if (resultSettled && !secretConsumed && Buffer.isBuffer(secret)) secret.fill(0);
      return secret;
    });
    let timeout = null;
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        reject(serviceError("SERVICE_UNAVAILABLE", "mcp_auth_unavailable"));
      }, mcpAuthInitTimeoutMs);
    });
    const result = Promise.race([guardedLoad, deadline]).then(async (handshakeSecret) => {
      secretConsumed = true;
      let manager = null;
      try {
        if (!Buffer.isBuffer(handshakeSecret) || handshakeSecret.length !== 32
          || !mcpAuthGenerationIsActive(generation)) {
          throw serviceError("SERVICE_UNAVAILABLE", "mcp_auth_unavailable");
        }
        const factory = options.mcpSessionManagerFactory || ((managerOptions) => (
          new McpSessionManager(managerOptions)
        ));
        manager = factory({
          // Codex starts one helper per conversation. Tokens may coexist;
          // every native call still requires its exact one-use Run proof.
          concurrentHelperSessions: true,
          handshakeSecret,
          profileStore: productStore,
          protocolVersion: PROTOCOL_VERSION,
          now: options.now,
          randomBytes: options.mcpRandomBytes,
          challengeTtlMs: options.mcpChallengeTtlMs,
          sessionTtlMs: options.mcpSessionTtlMs,
          maxChallenges: options.mcpMaxChallenges,
          maxSessions: options.mcpMaxSessions,
        });
        if (!manager || typeof manager.issueChallenge !== "function"
          || typeof manager.exchangeChallenge !== "function"
          || typeof manager.issueBridgeSession !== "function"
          || typeof manager.authorizeSession !== "function"
          || typeof manager.revokeSession !== "function"
          || typeof manager.close !== "function") {
          throw serviceError("MCP_SESSION_MANAGER_INVALID", "mcp_session_manager_invalid");
        }
        if (!mcpAuthGenerationIsActive(generation)) {
          await closeUnpublishedMcpManager(manager);
          manager = null;
          throw serviceError("SERVICE_UNAVAILABLE", "mcp_auth_unavailable");
        }
        mcpSessionManager = manager;
        return manager;
      } catch (error) {
        if (manager && manager !== mcpSessionManager) await closeUnpublishedMcpManager(manager);
        throw error;
      } finally {
        if (Buffer.isBuffer(handshakeSecret)) handshakeSecret.fill(0);
      }
    }).catch((error) => {
      if (lifecycleGeneration === generation) mcpAuthFailureGeneration = generation;
      throw error;
    }).finally(() => {
      resultSettled = true;
      if (timeout) clearTimeout(timeout);
    });
    const attempt = { generation, result };
    mcpAuthInitAttempt = attempt;
    void Promise.allSettled([loadPromise, result]).then(() => {
      if (mcpAuthInitAttempt === attempt) mcpAuthInitAttempt = null;
    });
    return result;
  }

  function writeResponse(socket, payload, close = true) {
    if (socket.destroyed) return;
    let frame = `${JSON.stringify(payload)}\n`;
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
      const safeId = jsonlBytes(payload?.id) <= 256 ? payload?.id ?? null : null;
      frame = `${JSON.stringify({
        id: safeId,
        ok: false,
        error: { code: "RESPONSE_TOO_LARGE", message: "响应超过本地协议上限" },
      })}\n`;
      if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
        socket.destroy();
        return;
      }
    }
    socket.write(frame, (error) => {
      if (error) {
        socket.destroy();
        return;
      }
      if (close && !socket.destroyed) socket.end();
    });
  }

  function errorResponse(socket, id, code, message, close = true) {
    writeResponse(socket, { id: id ?? null, ok: false, error: { code, message } }, close);
  }

  function handleInternalError(socket, request) {
    const rawId = request && typeof request === "object" ? request.id : null;
    const safeId = (typeof rawId === "string" && Buffer.byteLength(rawId) <= 256)
      || (typeof rawId === "number" && Number.isFinite(rawId))
      ? rawId
      : null;
    try {
      // 内部异常只返回固定文案，既不泄漏 stack/message，也不让 rejection 逃到进程级。
      errorResponse(socket, safeId, "INTERNAL_ERROR", "Service 内部请求处理失败", true);
    } catch {
      socket.destroy();
    }
  }

  function domainAvailabilitySnapshot() {
    return Object.freeze({
      kanban: Object.freeze({ ...domainAvailability.kanban }),
      cron: Object.freeze({ ...domainAvailability.cron }),
    });
  }

  function latchStartupFatal(generation, error) {
    if (!startupFatal || startupFatal.generation !== generation) {
      startupFatal = { generation, error };
    }
    return startupFatal.error;
  }

  function reportDomainFatal(domain, error, controllerOwnerToken = null) {
    if (controllerOwnerToken !== null
      && controllerOwnerToken !== activeDomainControllerOwnerToken) return Promise.resolve();
    if ((domain !== "kanban" && domain !== "cron")
      || (lifecycleState !== "starting" && lifecycleState !== "started")) {
      return Promise.resolve();
    }
    domainAvailability[domain] = {
      available: false,
      reason: DOMAIN_RUNTIME_FATAL_REASON,
    };
    // startup 本身已有保留主错的 cleanup 边界；只有已发布的 generation 才走
    // runtime reporter，避免 open 失败与 stop 重入互相覆盖。
    const generation = lifecycleGeneration;
    if (lifecycleState !== "started") {
      latchStartupFatal(generation, error);
      return Promise.resolve();
    }
    if (domainFatalReports[domain]?.generation === generation) {
      return domainFatalReports[domain].promise;
    }
    // Controller fatal 可能由当前 IPC 请求触发；让本轮 JSONL 公共错误先完成 flush，
    // 下一轮再关闭对应领域的 scheduler/service/store，避免本轮正确的
    // commit-uncertain 被生命周期清理覆盖。核心 IPC、聊天与另一领域保持在线。
    const promise = new Promise((resolve) => setImmediate(resolve))
      .then(async () => {
        if (lifecycleState !== "started" || lifecycleGeneration !== generation) return;
        const cleanupError = await quarantineNativeDomain(domain);
        if (lifecycleState !== "started" || lifecycleGeneration !== generation) return;
        try {
          if (typeof options.onDomainRuntimeError === "function") {
            await options.onDomainRuntimeError(domain, error, cleanupError);
          } else {
            console.error(`[agent-service] ${domain} domain isolated: DOMAIN_RUNTIME_FATAL`);
          }
        } catch {
          console.error("[agent-service] domain runtime failure reporter failed");
        }
      });
    domainFatalReports[domain] = { generation, promise };
    void promise.catch(() => {});
    return promise;
  }

  async function quarantineNativeDomain(domain) {
    const errors = [];
    if (domain === "cron") {
      if (nativeCronSchedulerOpened) {
        nativeCronSchedulerOpened = false;
        try { await nativeCronScheduler.close(); } catch (error) { errors.push(error); }
      }
      if (nativeCronStoreOpened) {
        nativeCronStoreOpened = false;
        try { await nativeCronStore.close(); } catch (error) { errors.push(error); }
      }
    } else {
      if (kanbanRunServiceOpened) {
        kanbanRunServiceOpened = false;
        try { await kanbanRunService.close(); } catch (error) { errors.push(error); }
      }
      if (nativeKanbanStoreOpened) {
        nativeKanbanStoreOpened = false;
        try { await nativeKanbanStore.close(); } catch (error) { errors.push(error); }
      }
    }
    if (errors.length === 0) return null;
    const cleanupError = new AggregateError(errors, "Native domain isolation cleanup failed");
    cleanupError.code = "DOMAIN_ISOLATION_CLEANUP_FAILED";
    return cleanupError;
  }

  function reportMcpProductFatal(error, controllerOwnerToken = null) {
    if (controllerOwnerToken !== null
      && controllerOwnerToken !== activeMcpProductToolControllerOwnerToken) {
      return Promise.resolve();
    }
    if (lifecycleState === "starting") {
      latchStartupFatal(lifecycleGeneration, error);
      return Promise.resolve();
    }
    if (lifecycleState !== "started") return Promise.resolve();
    const generation = lifecycleGeneration;
    if (mcpProductFatalReport?.generation === generation) {
      return mcpProductFatalReport.promise;
    }
    // Product Controller fatal 仅由本轮 MCP IPC 触发；下一轮再停止 Service，保证
    // commit-uncertain 的固定公开错误先完成 socket flush。
    const promise = new Promise((resolve) => setImmediate(resolve))
      .then(() => {
        if (lifecycleState !== "started" || lifecycleGeneration !== generation) return;
        return reportRuntimeServerError(error);
      });
    mcpProductFatalReport = { generation, promise };
    void promise.catch(() => {});
    return promise;
  }

  async function reportRuntimeServerError(error) {
    let cleanupError = null;
    try {
      await api.stop({ notify: false });
    } catch (failure) {
      cleanupError = failure;
    }
    try {
      if (typeof options.onRuntimeError === "function") {
        await options.onRuntimeError(error, cleanupError);
      } else {
        // Runtime errors can originate from EventEmitter boundaries. Never read
        // attacker-controlled accessors or forward a raw code/message to logs.
        console.error("[agent-service] runtime server failure: SERVER_ERROR");
      }
    } catch {
      console.error("[agent-service] runtime failure reporter failed");
    }
  }

  async function recoverUnlockedPendingCommands(generation) {
    if (lifecycleGeneration !== generation || !workRunCoordinatorReady
      || !["starting", "started"].includes(lifecycleState)) return;
    if (pendingInboxRecovery?.generation === generation) return pendingInboxRecovery.promise;
    pendingInboxRecoveryNeeded = false;
    const promise = (async () => {
      const recoveries = await workRunCoordinator.recover();
      const outcomes = await Promise.allSettled(recoveries);
      const failure = outcomes.find((outcome) => outcome.status === "rejected");
      if (failure) throw failure.reason;
    })();
    const record = { generation, promise };
    pendingInboxRecovery = record;
    try {
      await promise;
    } finally {
      if (pendingInboxRecovery === record) pendingInboxRecovery = null;
    }
  }

  function handlePendingCommandInboxUnlocked() {
    const generation = lifecycleGeneration;
    if (!["starting", "started"].includes(lifecycleState)) return;
    pendingInboxRecoveryNeeded = true;
    if (!workRunCoordinatorReady || lifecycleState === "starting") return;
    void recoverUnlockedPendingCommands(generation).catch((error) => (
      reportRuntimeServerError(error)
    ));
  }

  async function reportStopFailure(error) {
    try {
      if (typeof options.onStopError === "function") await options.onStopError(error);
      else console.error(`[agent-service] stop failure: ${error?.code || "SERVICE_STOP_FAILED"}`);
    } catch {
      console.error("[agent-service] stop failure reporter failed");
    }
  }

  function handleMcpError(socket, id, error) {
    const codeProbe = probeDataProperty(error, "code");
    const rawCode = codeProbe.ok && codeProbe.found && typeof codeProbe.value === "string"
      ? codeProbe.value : "";
    if (["credentials_locked", "MCP_AUTH_NOT_INITIALIZED", "MCP_CRYPTO_UNAVAILABLE", "SERVICE_UNAVAILABLE"]
      .includes(rawCode)) {
      errorResponse(socket, id, "SERVICE_UNAVAILABLE", "mcp_auth_unavailable");
      return;
    }
    const code = MCP_PUBLIC_ERROR_CODES.has(rawCode) ? rawCode : "MCP_AUTH_FAILED";
    const messages = {
      MCP_AUTH_BUSY: "mcp_auth_busy",
      MCP_AUTH_FAILED: "mcp_auth_failed",
      MCP_AUTH_REQUEST_INVALID: "mcp_auth_request_invalid",
      MCP_SESSION_INVALID: "mcp_session_invalid",
      EXTERNAL_PLUGIN_LEASE_INVALID: "external_plugin_lease_invalid",
      EXTERNAL_PLUGIN_LEASE_BUSY: "external_plugin_lease_busy",
      EXTERNAL_PLUGIN_AUDIT_UNAVAILABLE: "external_plugin_audit_unavailable",
      EXTERNAL_PLUGIN_SELECTION_INVALID: "external_plugin_selection_invalid",
      EXTERNAL_PLUGIN_SELECTION_CONFLICT: "external_plugin_selection_conflict",
      EXTERNAL_PLUGIN_SELECTION_BUSY: "external_plugin_selection_busy",
      EXTERNAL_PLUGIN_SELECTION_UNAVAILABLE: "external_plugin_selection_unavailable",
      EXTERNAL_PLUGIN_SELECTION_STORE_INVALID: "external_plugin_selection_store_invalid",
      PLUGIN_SELECTION_INVALID: "plugin_selection_invalid",
      PLUGIN_SELECTION_STALE: "plugin_selection_stale",
      PLUGIN_SELECTION_UNAVAILABLE: "plugin_selection_unavailable",
      CAPABILITY_FORBIDDEN: "capability_forbidden",
      GRANT_REVOKED: "grant_revoked",
      TOOL_CONTRACT_CHANGED: "tool_contract_changed",
      CATALOG_REVISION_CHANGED: "catalog_revision_changed",
      CALL_ALREADY_RECORDED: "call_already_recorded",
      PLUGIN_RUNTIME_CAPACITY: "plugin_runtime_capacity",
      ...MCP_TOOL_PUBLIC_MESSAGES,
    };
    errorResponse(socket, id, code, messages[code] || (code.startsWith("HOOK_") ? code.toLowerCase() : "mcp_auth_failed"));
  }

  async function executeAuthorizedMcpRequest(method, params, executionRunId = null, interactionSignal = null) {
    const toolCall = method === "mcp.tool.call";
    const exposure = method === "mcp.group.exposure";
    const expectedFields = toolCall
      ? ["runtimeProfileId", "runtimeAccountId", "sessionToken", "callId", "name", "arguments",
        ...(Object.hasOwn(params, "confirmation") ? ["confirmation"] : [])]
      : ["runtimeProfileId", "runtimeAccountId", "sessionToken", ...(exposure ? ["instanceId", "protocolVersion", "tools"] : [])];
    if (!exactObject(params, expectedFields)
      || !validRuntimeProfileId(params.runtimeProfileId)
      || !validRuntimeAccountId(params.runtimeAccountId)
      || (toolCall && (!UUID_PATTERN.test(params.callId)
        || !validBoundedString(params.name, 64)
        || !params.arguments
        || typeof params.arguments !== "object"
        || Array.isArray(params.arguments)
        || Object.getPrototypeOf(params.arguments) !== Object.prototype
        || (Object.hasOwn(params, "confirmation") && params.confirmation !== true)))) {
      if (toolCall) throw serviceError("MCP_AUTH_REQUEST_INVALID", "mcp_auth_request_invalid");
      throw serviceError("MCP_SESSION_INVALID", "mcp_session_invalid");
    }
    let authorized = federationMcpSessionManager.authorize({
      runtimeProfileId: params.runtimeProfileId,
      runtimeAccountId: params.runtimeAccountId,
      token: params.sessionToken,
    });
    if (!authorized) {
      const manager = await ensureMcpSessionManager();
      authorized = manager.authorizeSession({
        runtimeProfileId: params.runtimeProfileId,
        runtimeAccountId: params.runtimeAccountId,
        token: params.sessionToken,
      });
    }
    const profile = agentRuntimeProfileViews(productStore, authorized.profileId)
      .find(view => view.runtimeProfileId === authorized.runtimeProfileId);
    if (!profile || profile.enabled !== true
      || profile.runtimeProfileId !== authorized.runtimeProfileId
      || profile.runtimeAccountId !== authorized.runtimeAccountId) {
      throw serviceError("MCP_SESSION_INVALID", "mcp_session_invalid");
    }
    if (exposure) {
      if (authorized.federationClient) throw serviceError("MCP_SESSION_INVALID", "mcp_session_invalid");
      const manager = await ensureMcpSessionManager();
      const generation = lifecycleGeneration;
      const authorize = () => {
        if (manager !== mcpSessionManager || lifecycleGeneration !== generation) throw serviceError("MCP_SESSION_INVALID", "mcp_session_invalid");
        return manager.authorizeSession({ runtimeProfileId: params.runtimeProfileId,
          runtimeAccountId: params.runtimeAccountId, token: params.sessionToken });
      };
      return groupNativeToolExposure.record(params, { authorize, executionRunId });
    }
    if (!toolCall) return sanitizeMcpProfile(profile);
    let result;
    activeRuntimeRequests += 1;
    try {
      const invoke = scope => mcpProductToolController.handle(
        params.name,
        params.arguments,
        Object.freeze({
          profileId: authorized.profileId,
          callId: params.callId,
          ...(params.confirmation === true ? { confirmation: true } : {}),
          ...(authorized.federationClient
            ? { federationClient: authorized.federationClient } : {}),
        }), interactionSignal && scope ? { ...scope,
          signal: scope.signal ? AbortSignal.any([scope.signal, interactionSignal]) : interactionSignal,
          assertCurrent: () => {
            scope.assertCurrent();
            if (interactionSignal.aborted) throw serviceError("HOST_CAPABILITY_REVOKED", "执行权限租约已失效");
          },
        } : scope,
      );
      const execute = () => (authorized.federationClient ? invoke(undefined)
        : executionRunId ? workRunCoordinator.invokeRuntimeCapability({ runtimeProfileId: params.runtimeProfileId,
          runtimeAccountId: params.runtimeAccountId, runId: executionRunId,
          kind: params.name === "artifact_publish" ? "artifact" : "mcp" }, invoke)
          : workRunCoordinator.invokeBoundRuntimeMcpCall({ profileId: authorized.profileId,
            runtimeProfileId: params.runtimeProfileId, runtimeAccountId: params.runtimeAccountId,
            callId: params.callId, name: params.name, arguments: params.arguments,
            sessionToken: params.sessionToken,
            confirmation: params.confirmation === true }, invoke));
      result = cloneMcpToolResult(await (runtimeManager.withActivity
        ? runtimeManager.withActivity(execute) : execute()));
    } finally {
      activeRuntimeRequests -= 1;
    }
    const worstFrame = `${JSON.stringify({
      id: "\0".repeat(256), ok: true, result,
    })}\n`;
    if (Buffer.byteLength(worstFrame, "utf8") > MAX_FRAME_BYTES) {
      throw serviceError(
        "MCP_TOOL_RESPONSE_TOO_LARGE",
        MCP_TOOL_PUBLIC_MESSAGES.MCP_TOOL_RESPONSE_TOO_LARGE,
      );
    }
    return result;
  }

  async function handleMcpRequest(socket, request) {
    const id = request.id;
    if (!exactObject(request, ["id", "version", "method", "params"])) {
      errorResponse(socket, id, "MCP_AUTH_REQUEST_INVALID", "mcp_auth_request_invalid");
      return;
    }
    let result;
    try {
      if (request.method === "mcp.runtime.gate.consume") {
        if (!exactObject(request.params, [
          "runtimeProfileId", "runtimeAccountId", "gatePath", "nonce", "parentPid",
        ])) {
          throw serviceError("MCP_AUTH_REQUEST_INVALID", "mcp_auth_request_invalid");
        }
        const profiles = agentRuntimeProfileViews(productStore).filter((profile) => (
          profile.enabled === true
          && profile.runtimeProfileId === request.params.runtimeProfileId
          && profile.runtimeAccountId === request.params.runtimeAccountId
        ));
        if (profiles.length !== 1) {
          throw serviceError("MCP_AUTH_FAILED", "mcp_auth_failed");
        }
        result = runtimeMcpGateIssuer.consume(request.params);
      } else if (request.method === "mcp.federation.open") {
        if (!exactObject(request.params,
          ["runtimeProfileId", "runtimeAccountId", "credentialToken", "client"])) {
          throw serviceError("MCP_AUTH_REQUEST_INVALID", "mcp_auth_request_invalid");
        }
        result = federationMcpSessionManager.issue(request.params);
      } else if (["group.adapter.register", "group.adapter.unregister", "group.adapter.call"].includes(request.method)) {
        if (lifecycleState !== "started" || maintenanceQuiesced) throw serviceError("SERVICE_UNAVAILABLE", "群工具通道不可用");
        result = await groupAdapterChannel.handle(request.method, request.params);
      } else if (["plugin.external.selection.bind", "plugin.external.selection.finish"].includes(request.method)) {
        if (lifecycleState !== "started" || !externalPluginSelectionDispatchOpened) {
          throw serviceError("EXTERNAL_PLUGIN_SELECTION_UNAVAILABLE", "external_plugin_selection_unavailable");
        }
        if (!exactObject(request.params, ["credentialToken", "envelope", "identity"])) {
          throw serviceError("MCP_AUTH_REQUEST_INVALID", "mcp_auth_request_invalid");
        }
        result = await externalPluginSelectionDispatch[
          request.method === "plugin.external.selection.bind" ? "bind" : "finish"](request.params);
      } else if (request.method.startsWith("plugin.external.")) {
        if (lifecycleState !== "started" || !externalPluginToolService) {
          throw serviceError("SERVICE_UNAVAILABLE", "service_unavailable");
        }
        const params = request.params;
        const fields = request.method === "plugin.external.open"
          ? ["credentialToken", "identity", ...(params && Object.hasOwn(params, "selectionEnvelope") ? ["selectionEnvelope"] : [])]
          : request.method === "plugin.external.search"
            ? ["token", "identity", "query", "cursor", "limit", "revision"]
            : request.method === "plugin.external.skill.read"
              ? ["token", "identity", "skillId", "cursor"]
              : request.method === "plugin.external.skill.file.read"
                || request.method === "plugin.external.resource.read"
                ? ["token", "identity", "skillId", "relativePath", "cursor"]
              : request.method === "plugin.external.call"
                ? ["token", "identity", "serverId", "toolName", "arguments"]
                : ["token", "identity"];
        if (!exactObject(params, fields)
          && !(request.method === "plugin.external.search"
            && exactObject(params, ["token", "identity", "query", "cursor", "limit"]))) {
          throw serviceError("MCP_AUTH_REQUEST_INVALID", "mcp_auth_request_invalid");
        }
        if (request.method === "plugin.external.open") result = await externalPluginToolService.open(params);
        else if (request.method === "plugin.external.search") result = await externalPluginToolService.search(params);
        else if (request.method === "plugin.external.skill.read") result = await externalPluginToolService.readSkill(params);
        else if (request.method === "plugin.external.skill.file.read") result = await externalPluginToolService.readSkillFile(params);
        else if (request.method === "plugin.external.resource.read") {
          result = await externalPluginToolService.readPluginResource(params);
        }
        else if (request.method === "plugin.external.call") {
          let finished = false;
          let disconnected = false;
          // The one-shot socket uses allowHalfOpen. Once a complete JSONL frame
          // is parsed, acceptSocket marks it terminal and its generic `end`
          // handler intentionally leaves the readable half alone. A vanished
          // adapter can therefore emit `end` without `close` until this call
          // finishes. Treat either event as cancellation for this long call.
          const onDisconnect = () => {
            if (!finished && !disconnected) {
              disconnected = true;
              try { externalPluginToolService.cancel(params); } catch { /* Already settled or revoked. */ }
            }
          };
          socket.once("end", onDisconnect);
          socket.once("close", onDisconnect);
          if (socket.readableEnded || socket.destroyed) onDisconnect();
          try { result = await externalPluginToolService.call(params); }
          finally {
            finished = true;
            socket.off("end", onDisconnect);
            socket.off("close", onDisconnect);
          }
        }
        else { externalPluginToolService.cancel(params); result = { canceled: true }; }
      } else if (request.method === "mcp.auth.challenge") {
        const manager = await ensureMcpSessionManager();
        result = manager.issueChallenge(request.params);
      } else if (request.method === "mcp.auth.exchange") {
        const manager = await ensureMcpSessionManager();
        result = manager.exchangeChallenge(request.params);
      } else {
        if (request.method === "mcp.tool.call" && USER_WAIT_TOOL_NAMES.has(request.params?.name)) {
          const controller = new AbortController();
          const onDisconnect = () => controller.abort();
          socket.once("end", onDisconnect);
          socket.once("close", onDisconnect);
          if (socket.readableEnded || socket.destroyed) onDisconnect();
          try { result = await executeAuthorizedMcpRequest(request.method, request.params, null, controller.signal); }
          finally { socket.off("end", onDisconnect); socket.off("close", onDisconnect); }
        } else result = await executeAuthorizedMcpRequest(request.method, request.params);
      }
    } catch (error) {
      handleMcpError(socket, id, error);
      return;
    }
    writeResponse(socket, { id, ok: true, result });
  }

  function writeMcpBridgeAck(socket) {
    const frame = `${JSON.stringify({ ok: true, result: { bridged: true } })}\n`;
    return new Promise((resolve, reject) => {
      if (socket.destroyed) {
        reject(serviceError("MCP_AUTH_FAILED", "mcp_auth_failed"));
        return;
      }
      try {
        socket.write(frame, (error) => {
          if (error || socket.destroyed) {
            reject(serviceError("MCP_AUTH_FAILED", "mcp_auth_failed"));
          } else {
            resolve();
          }
        });
      } catch {
        reject(serviceError("MCP_AUTH_FAILED", "mcp_auth_failed"));
      }
    });
  }

  async function openMcpRuntimeBridge(socket, request) {
    if (maintenanceQuiesced) throw serviceError("SERVICE_QUIESCED", "mcp_auth_unavailable");
    if (!exactObject(request, ["version", "method", "params"])
      || request.version !== PROTOCOL_VERSION
      || request.method !== "mcp.runtime.bridge.open"
      || !exactObject(request.params, [
        "runtimeProfileId", "runtimeAccountId", "gatePath", "nonce", "parentPid",
      ])
      || !validRuntimeProfileId(request.params.runtimeProfileId)
      || !validRuntimeAccountId(request.params.runtimeAccountId)) {
      throw serviceError("MCP_AUTH_REQUEST_INVALID", "mcp_auth_request_invalid");
    }
    if (!(lifecycleState === "started"
      || (lifecycleState === "starting" && mcpTransportReady))) {
      throw serviceError("SERVICE_UNAVAILABLE", "mcp_auth_unavailable");
    }

    const generation = lifecycleGeneration;
    const runtimeProfileId = request.params.runtimeProfileId;
    const runtimeAccountId = request.params.runtimeAccountId;
    const boundProfiles = agentRuntimeProfileViews(productStore).filter((profile) => (
      profile.enabled === true
      && profile.runtimeProfileId === runtimeProfileId
      && profile.runtimeAccountId === runtimeAccountId
    ));
    if (boundProfiles.length !== 1) {
      throw serviceError("MCP_AUTH_FAILED", "mcp_auth_failed");
    }
    const gateAuthority = await runtimeMcpGateIssuer.consume(request.params);
    const manager = await ensureMcpSessionManager();
    if (!mcpAuthGenerationIsActive(generation) || manager !== mcpSessionManager) {
      throw serviceError("SERVICE_UNAVAILABLE", "mcp_auth_unavailable");
    }

    let activeToken = null;
    let handler = null;
    let closed = false;
    const revokeActiveSession = () => {
      const tokenToRevoke = activeToken;
      activeToken = null;
      if (!tokenToRevoke) return;
      try {
        manager.revokeSession({ runtimeProfileId, runtimeAccountId, token: tokenToRevoke });
      } catch { /* manager close/revoke is best-effort during socket teardown */ }
    };
    // Prompts this bridge asked the Coordinator to show; they end with the bridge.
    const promptControllers = new Set();
    const closeBridge = () => {
      if (closed) return;
      closed = true;
      bridgeSockets.delete(socket);
      for (const controller of promptControllers) controller.abort();
      promptControllers.clear();
      if (handler?.close) handler.close();
      revokeActiveSession();
    };
    const askBridgeUser = (method, params) => {
      if (method !== "elicitation/create" || closed || socket.destroyed) {
        return Promise.reject(serviceError("MCP_SESSION_INVALID", "mcp_session_invalid"));
      }
      // Same deadline the Runtime-forwarded path had (MCP_CLIENT_REQUEST_TIMEOUT_MS).
      const controller = new AbortController();
      promptControllers.add(controller);
      const timer = setTimeout(() => controller.abort(), MCP_CLIENT_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      return workRunCoordinator.requestBridgeElicitation({ runtimeProfileId, runtimeAccountId,
        runId: gateAuthority.executionRunId, params, signal: controller.signal })
        .finally(() => { clearTimeout(timer); promptControllers.delete(controller); });
    };

    try {
      const session = manager.issueBridgeSession({ runtimeProfileId, runtimeAccountId });
      activeToken = session.token;
      const refreshSession = async () => {
        const refreshedManager = await ensureMcpSessionManager();
        if (closed || socket.destroyed || lifecycleGeneration !== generation
          || !mcpAuthGenerationIsActive(generation) || refreshedManager !== manager) {
          throw serviceError("MCP_SESSION_INVALID", "mcp_session_invalid");
        }
        const refreshed = manager.issueBridgeSession({ runtimeProfileId, runtimeAccountId });
        revokeActiveSession();
        activeToken = refreshed.token;
        return refreshed;
      };
      const requestBridgeService = async (_paths, serviceRequest) => {
        if (maintenanceQuiesced || closed || socket.destroyed || lifecycleGeneration !== generation
          || !mcpAuthGenerationIsActive(generation) || manager !== mcpSessionManager
          || !exactObject(serviceRequest, ["version", "method", "params"])
          || serviceRequest.version !== PROTOCOL_VERSION
          || !["mcp.profile.get", "mcp.tool.call", "mcp.group.exposure"].includes(serviceRequest.method)
          || serviceRequest.params.runtimeProfileId !== runtimeProfileId
          || serviceRequest.params.runtimeAccountId !== runtimeAccountId) {
          throw serviceError("MCP_SESSION_INVALID", "mcp_session_invalid");
        }
        if (serviceRequest.method === "mcp.tool.call"
          && !workRunCoordinator.hasActiveRuntimeWork?.(runtimeProfileId, runtimeAccountId, gateAuthority.executionRunId)) {
          throw serviceError("MCP_SESSION_INVALID", "mcp_session_invalid");
        }
        if (serviceRequest.method === "mcp.tool.call" && USER_WAIT_TOOL_NAMES.has(serviceRequest.params.name)) {
          const controller = new AbortController();
          promptControllers.add(controller);
          try { return await executeAuthorizedMcpRequest(serviceRequest.method, serviceRequest.params,
            gateAuthority.executionRunId, controller.signal); }
          finally { promptControllers.delete(controller); }
        }
        return executeAuthorizedMcpRequest(serviceRequest.method, serviceRequest.params, gateAuthority.executionRunId);
      };
      handler = createMcpStdioHandler({
        reportGroupExposure: true,
        paths,
        runtimeProfileId,
        runtimeAccountId,
        sessionToken: session.token,
        sessionExpiresAt: session.expiresAt,
        serviceVersion,
        requestService: requestBridgeService,
        refreshSession,
        ...(gateAuthority.executionRunId ? { interactionClient: askBridgeUser } : {}),
        now: options.now,
        randomUUID: options.randomUUID,
      });
      bridgeSockets.set(socket, { close: closeBridge });
      sockets.delete(socket);
      socket.once("close", closeBridge);
      await writeMcpBridgeAck(socket);
      if (closed || socket.destroyed || lifecycleGeneration !== generation) {
        throw serviceError("MCP_SESSION_INVALID", "mcp_session_invalid");
      }
      const sessionRun = runMcpStdioSession({ input: socket, output: socket, handler });
      socket.resume();
      void sessionRun.then(
        () => { if (!socket.destroyed) socket.end(); },
        () => { if (!socket.destroyed) socket.destroy(); },
      ).finally(closeBridge);
    } catch (error) {
      closeBridge();
      throw error;
    }
  }

  async function handleRequest(socket, request) {
    const id = request && typeof request === "object" ? request.id : null;
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      errorResponse(socket, id, "INVALID_REQUEST", "请求必须是 JSON 对象");
      return;
    }
    stallMonitor.noteMethod(request.method);
    const isMcpRequest = MCP_SERVICE_METHODS.has(request.method);
    if (maintenanceQuiesced && !["service.hello", "service.status", "service.stopImpact", "service.stop"].includes(request.method)) {
      errorResponse(socket, id, "SERVICE_QUIESCED", "Service 已暂停接收任务，等待重新启动");
      return;
    }
    // Startup 期提前 bind 仅供 Runtime MCP helper 完成 one-shot gate + HMAC。
    // 普通客户端即使读到了本代 token，也必须等所有恢复入口完成后才能观察 Service。
    if (!isMcpRequest && lifecycleState !== "started") {
      errorResponse(socket, id, "SERVICE_UNAVAILABLE", "Service 尚未就绪");
      return;
    }
    if (request.version !== PROTOCOL_VERSION) {
      errorResponse(socket, id, "PROTOCOL_VERSION_MISMATCH", "协议版本不匹配");
      return;
    }
    if (isMcpRequest) {
      if (!(lifecycleState === "started"
        || (lifecycleState === "starting" && mcpTransportReady))) {
        errorResponse(socket, id, "SERVICE_UNAVAILABLE", "mcp_auth_unavailable");
        return;
      }
      const failure = lifecycleState === "started" ? coreRecoveryFailure() : null;
      if (failure) {
        rejectCoreRecoveryRequest(socket, id, failure);
        return;
      }
      await handleMcpRequest(socket, request);
      return;
    }
    if (!tokensEqual(request.token, token)) {
      errorResponse(socket, id, "AUTH_FAILED", "本地认证失败");
      return;
    }

    // A responsive process is not healthy when shared durable state is poisoned.
    // Keep stop/impact and protocol identity available, but never admit another action
    // or report healthy until a cold reopen has replayed the uncertain records.
    const recoveryFailure = coreRecoveryFailure();
    if (recoveryFailure && !["service.hello", "service.stopImpact", "service.stop"].includes(request.method)) {
      rejectCoreRecoveryRequest(socket, id, recoveryFailure);
      return;
    }

    const baseFields = ["id", "token", "version", "method"];
    if (["service.hello", "service.status", "service.stopImpact", "service.stop"].includes(request.method)) {
      const validEnvelope = exactObject(request, baseFields)
        || (exactObject(request, [...baseFields, "params"])
          && exactObject(request.params, []));
      if (!validEnvelope) {
        errorResponse(socket, id, "INVALID_PARAMS", "Service 参数无效");
        return;
      }
    } else if (request.method === "events.subscribe") {
      const validEnvelope = exactObject(request, baseFields)
        || (exactObject(request, [...baseFields, "params"])
          && (exactObject(request.params, []) || exactObject(request.params, ["afterSeq"])));
      if (!validEnvelope) {
        errorResponse(socket, id, "INVALID_PARAMS", "events.subscribe 参数无效");
        return;
      }
    }

    let result;
    if (chatUiProtocol.METHODS.includes(request.method)) {
      try {
        if (!exactObject(request, [...baseFields, "params"])) throw Object.assign(new Error(), { code: "UI_REQUEST_INVALID" });
        const params = chatUiProtocol.validateParams(request.method, request.params);
        if (request.method === "chat.ui.config.apply") result = chatUiConfig.apply(params);
        else if (request.method === "chat.ui.config.read") result = chatUiConfig.read();
        else result = await chatUiController.handle(request.method, params);
        result = chatUiProtocol.validateResult(request.method, result);
      } catch (error) {
        const code = Object.hasOwn(chatUiProtocol.MESSAGES, error?.code) ? error.code : "UI_REQUEST_INVALID";
        errorResponse(socket, id, code, chatUiProtocol.MESSAGES[code]); return;
      }
    } else     if (externalProviderCredentialRpc.isMethod(request.method) || openClawAuthProfileCredentialRpc.isMethod(request.method)) {
      // A closed ASCII id also bounds worst-case JSON response escaping.
      if (!exactObject(request, [...baseFields, "params"])
        || typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id)) {
        errorResponse(socket, null, "EXTERNAL_PROVIDER_CREDENTIAL_RPC_INVALID", "受管凭据参数无效");
        return;
      }
      const generation = lifecycleGeneration;
      try {
        const credentialRpc = openClawAuthProfileCredentialRpc.isMethod(request.method) ? openClawAuthProfileCredentialRpc : externalProviderCredentialRpc;
        const context = credentialRpc.createRequestContext(() => !socket.destroyed
          && lifecycleState === "started" && lifecycleGeneration === generation && !maintenanceQuiesced);
        result = await credentialRpc.dispatch(request.method, request.params, context);
      } catch (error) {
        const code = /^EXTERNAL_PROVIDER_[A-Z_]{1,96}$/u.test(error?.code || "")
          ? error.code : "EXTERNAL_PROVIDER_CREDENTIAL_UNAVAILABLE";
        errorResponse(socket, id, code, "受管模型凭据操作未验证");
        return;
      }
    } else if (request.method === "service.hello") {
      result = { protocolVersion: PROTOCOL_VERSION, serviceVersion };
    } else if (NATIVE_RUNTIME_CONFIG_METHODS.includes(request.method)) {
      try {
        if (!exactObject(request, [...baseFields, "params"])) {
          throw serviceError("NATIVE_RUNTIME_CONFIG_INVALID", "原生并发参数无效");
        }
        const params = validateNativeRuntimeConfigParams(request.method, request.params);
        result = request.method === "runtime.config.apply"
          ? nativeRuntimeConfig.apply(params) : workRunCoordinator.nativeCapacitySnapshot();
        result = validateNativeRuntimeConfigResult(request.method, result);
      } catch (error) {
        const code = Object.hasOwn(NATIVE_RUNTIME_CONFIG_PUBLIC_MESSAGES, error?.code || "")
          ? error.code : "NATIVE_RUNTIME_CONFIG_UNAVAILABLE";
        errorResponse(socket, id, code, NATIVE_RUNTIME_CONFIG_PUBLIC_MESSAGES[code]);
        return;
      }
    } else if (NATIVE_MEMORY_SHARING_METHODS.includes(request.method)) {
      try {
        if (!exactObject(request, [...baseFields, "params"])) throw serviceError("NATIVE_MEMORY_SHARING_INVALID", "记忆互查参数无效");
        const params = validateNativeMemorySharingParams(request.method, request.params);
        if (request.method === "memory.sharing.config.apply") {
          nativeMemorySharingConfig.apply(params);
          await shoggothMemory?.sharing?.reconcileConfig();
        }
        result = validateNativeMemorySharingResult(request.method, request.method === "memory.sharing.config.context"
          ? nativeMemorySharingConfig.context(productStore.listAgentProfiles(), shoggothMemory ? "shoggoth-memory-core" : "legacy")
          : nativeMemorySharingConfig.read());
      } catch (error) {
        const code = Object.hasOwn(NATIVE_MEMORY_SHARING_PUBLIC_MESSAGES, error?.code || "")
          ? error.code : "NATIVE_MEMORY_SHARING_UNAVAILABLE";
        errorResponse(socket, id, code, NATIVE_MEMORY_SHARING_PUBLIC_MESSAGES[code]); return;
      }
    } else if (NATIVE_MEMORY_CONFIG_METHODS.includes(request.method)) {
      try {
        if (!exactObject(request, [...baseFields, "params"])) throw serviceError("NATIVE_MEMORY_CONFIG_INVALID", "记忆配置参数无效");
        const params = validateNativeMemoryConfigParams(request.method, request.params);
        result = validateNativeMemoryConfigResult(request.method, request.method === "memory.config.context"
          ? { owner: shoggothMemory ? "shoggoth-memory-core" : "legacy",
            agents: productStore.listAgentProfiles().filter(profile => profile.enabled && profile.backendId === "shoggoth")
              .map(profile => ({ profileId: profile.id, agentId: profile.agentId, name: profile.name })) }
          : request.method === "memory.config.apply" ? await applyNativeMemoryProjection(params) : nativeMemoryConfig.read());
      } catch (error) {
        const code = Object.hasOwn(NATIVE_MEMORY_CONFIG_PUBLIC_MESSAGES, error?.code || "")
          ? error.code : "NATIVE_MEMORY_CONFIG_UNAVAILABLE";
        errorResponse(socket, id, code, NATIVE_MEMORY_CONFIG_PUBLIC_MESSAGES[code]); return;
      }
    } else if (memoryProviderOwnerProtocol.METHODS.includes(request.method)) {
      const generation = lifecycleGeneration;
      try {
        if (!exactObject(request, [...baseFields, "params"]) || !memoryProviderOwnerRpc) memoryProviderOwnerProtocol.fail("MEMORY_OWNER_RETIRED");
        const context = memoryProviderOwnerRpc.createRequestContext(() => !socket.destroyed
          && lifecycleState === "started" && lifecycleGeneration === generation && !maintenanceQuiesced);
        result = await memoryProviderOwnerRpc.dispatch(request.method, request.params, context);
      } catch (error) {
        const safe = memoryProviderOwnerProtocol.publicError(error);
        errorResponse(socket, id, safe.code, safe.message); return;
      }
    } else if (request.method === activeMemoryStatus.METHOD) {
      const generation = lifecycleGeneration;
      try {
        if (!exactObject(request, [...baseFields, "params"])) activeMemoryStatus.fail("MEMORY_STATUS_INVALID");
        const params = activeMemoryStatus.validateParams(request.params);
        result = shoggothMemory ? await shoggothMemory.activeMemory.status.read(params) : { supported: false };
        if (socket.destroyed || lifecycleState !== "started" || lifecycleGeneration !== generation || maintenanceQuiesced) {
          activeMemoryStatus.fail("MEMORY_STATUS_UNAVAILABLE");
        }
        result = activeMemoryStatus.validateResult(result, params);
      } catch (error) {
        const code = Object.hasOwn(activeMemoryStatus.MESSAGES, error?.code || "") ? error.code : "MEMORY_STATUS_UNAVAILABLE";
        errorResponse(socket, id, code, activeMemoryStatus.MESSAGES[code]); return;
      }
    } else if (request.method === activeMemoryCommand.METHOD) {
      const generation = lifecycleGeneration;
      try {
        if (!exactObject(request, [...baseFields, "params"])) activeMemoryCommand.fail("MEMORY_COMMAND_INVALID");
        const params = activeMemoryCommand.validateParams(request.params);
        if (!shoggothMemory) activeMemoryCommand.fail("MEMORY_COMMAND_UNAVAILABLE");
        const assertCurrent = () => {
          if (socket.destroyed || lifecycleState !== "started" || lifecycleGeneration !== generation || maintenanceQuiesced) {
            activeMemoryCommand.fail("MEMORY_COMMAND_STALE");
          }
        };
        result = activeMemoryCommand.validateResult(await shoggothMemory.activeMemoryCommands.execute(params,
          { assertCurrent, allowConfigUpdate: true }), params);
      } catch (error) {
        const code = Object.hasOwn(activeMemoryCommand.MESSAGES, error?.code || "") ? error.code : "MEMORY_COMMAND_UNAVAILABLE";
        errorResponse(socket, id, code, activeMemoryCommand.MESSAGES[code]); return;
      }
    } else if (request.method === "service.status") {
      result = {
        healthy: true,
        pid: process.pid,
        ppid: process.ppid,
        protocolVersion: PROTOCOL_VERSION,
        serviceVersion,
        startedAt,
        instanceNonce,
        productSchemaVersion: paths.productSchemaVersion || productStore.schemaVersion || 15,
        maintenanceQuiesced,
        domainAvailability: domainAvailabilitySnapshot(),
        pendingCommandsLocked: typeof pendingCommandInbox.isLocked === "function"
          ? pendingCommandInbox.isLocked() : true,
        // MCP authority is lazily unlocked on the first authenticated helper handshake.
        mcpCredentialsLocked: mcpSessionManager === null,
        activeMemoryCommands: Boolean(shoggothMemory),
      };
    } else if (request.method === "service.mcpAuth.migrateKeychain") {
      if (!exactObject(request, [...baseFields, "params"])
        || !exactObject(request.params, ["confirm"]) || request.params.confirm !== true) {
        errorResponse(socket, id, "INVALID_PARAMS", "MCP 凭据迁移需要明确确认");
        return;
      }
      const generation = lifecycleGeneration;
      const impact = createStopImpact({ runs: workRunCoordinator.listRuns(),
        instanceNonce: `${instanceNonce}:${generation}` });
      if (!mcpAuthGenerationIsActive(generation) || impact.totalCount !== 0
        || mcpSessionManager || mcpAuthInitAttempt) {
        errorResponse(socket, id, "MCP_AUTH_MIGRATION_BUSY", "MCP 凭据迁移需要空闲且未解锁的服务");
        return;
      }
      if (typeof mcpCryptoBroker.migrateLegacyMcpAuth !== "function") {
        errorResponse(socket, id, "MCP_CRYPTO_UNAVAILABLE", "mcp_crypto_unavailable");
        return;
      }
      // Keep MCP closed until a fresh generation reloads the migrated file.
      // An explicit maintenance request must never race a helper handshake.
      mcpAuthFailureGeneration = generation;
      try {
        if (!mcpAuthMigration || mcpAuthMigration.generation !== generation) {
          mcpAuthMigration = { generation,
            result: Promise.resolve().then(() => mcpCryptoBroker.migrateLegacyMcpAuth({
              generation,
              isCurrent: () => mcpAuthGenerationIsActive(generation) && !mcpSessionManager
                && !mcpAuthInitAttempt && createStopImpact({ runs: workRunCoordinator.listRuns(),
                  instanceNonce: `${instanceNonce}:${generation}` }).totalCount === 0,
            })) };
        }
        const migration = await mcpAuthMigration.result;
        if (!mcpAuthGenerationIsActive(generation)) throw new Error("migration generation retired");
        result = { migrated: migration.migrated === true, restartRequired: true };
      } catch {
        errorResponse(socket, id, "MCP_CRYPTO_UNAVAILABLE", "mcp_crypto_unavailable");
        return;
      }
    } else if (request.method === "service.stopImpact") {
      result = createStopImpact({
        runs: workRunCoordinator.listRuns(),
        instanceNonce: `${instanceNonce}:${lifecycleGeneration}`,
        profileFor: (id) => productStore.getAgentProfile(id),
        titleFor: (run) => {
          if (run.source === "inspiration") return inspirationStore.get(run.sourceId)?.title;
          if (run.source === "cron") return nativeCronStore.getJob(run.sourceId)?.name;
          if (run.source === "kanban") return nativeKanbanStore.getCard(run.sourceId)?.title;
          const session = chatSessionStore.getSession(run.sourceId);
          return session?.title || (session
            ? transcriptStore.getSessionDerivedTitle(session.profileId, session.id) : null);
        },
      });
    } else if (request.method === "events.subscribe") {
      const hasCursor = request.params != null
        && Object.prototype.hasOwnProperty.call(request.params, "afterSeq");
      const rawCursor = request.params?.afterSeq;
      if (hasCursor && (!Number.isSafeInteger(rawCursor) || rawCursor < 0)) {
        errorResponse(socket, id, "INVALID_PARAMS", "afterSeq 必须是非负安全整数");
        return;
      }
      const afterSeq = hasCursor ? rawCursor : 0;
      result = eventBuffer.page(afterSeq, id);
    } else if (request.method === "plugins.external.calls.list") {
      try {
        if (!exactObject(request, [...baseFields, "params"])
          || (!exactObject(request.params, ["backendId", "cursor", "limit"])
            && !exactObject(request.params, ["backendId", "agentId", "sessionId",
              "toolCallId", "cursor", "limit"]))) {
          throw serviceError("PLUGIN_REQUEST_INVALID", "插件调用记录查询参数无效");
        }
        result = externalPluginProvenance.list(request.params);
      } catch (error) {
        const code = error?.code === "PLUGIN_REQUEST_INVALID"
          ? "PLUGIN_REQUEST_INVALID" : "EXTERNAL_PLUGIN_AUDIT_UNAVAILABLE";
        errorResponse(socket, id, code, PLUGIN_PUBLIC_MESSAGES[code]);
        return;
      }
    } else if (typeof request.method === "string"
      && request.method.startsWith("plugins.external.approvals.")) {
      try {
        if (!externalPluginApprovalBroker || !exactObject(request, [...baseFields, "params"])) {
          throw serviceError("PLUGIN_REQUEST_INVALID", "外部插件审批请求无效");
        }
        if (request.method === "plugins.external.approvals.list"
          && exactObject(request.params, ["backendId", "cursor", "limit"])) {
          result = externalPluginApprovalBroker.list(request.params);
        } else if (request.method === "plugins.external.approvals.prepare"
          && exactObject(request.params, ["requestId", "operationId", "decision"])) {
          result = externalPluginApprovalBroker.prepare(request.params);
        } else if (request.method === "plugins.external.approvals.commit"
          && exactObject(request.params, ["challenge", "approved"])) {
          result = externalPluginApprovalBroker.commit(request.params);
        } else throw serviceError("PLUGIN_REQUEST_INVALID", "外部插件审批请求无效");
      } catch (error) {
        const code = Object.hasOwn(PLUGIN_PUBLIC_MESSAGES, error?.code)
          ? error.code : "PLUGIN_REQUEST_INVALID";
        errorResponse(socket, id, code, PLUGIN_PUBLIC_MESSAGES[code]);
        return;
      }
    } else if (request.method === "plugins.zoom.registration.status") {
      try {
        if (!pluginStore || !exactObject(request, [...baseFields, "params"])
          || !exactObject(request.params, [])) {
          throw serviceError("PLUGIN_REQUEST_INVALID", "Zoom 配置状态请求无效");
        }
        const configured = loadZoomRegistration(paths) !== null;
        result = { configured, restartRequired: configured && zoomRegistration === null };
      } catch (error) {
        const code = Object.hasOwn(PLUGIN_PUBLIC_MESSAGES, error?.code)
          ? error.code : "PLUGIN_REQUEST_INVALID";
        errorResponse(socket, id, code, PLUGIN_PUBLIC_MESSAGES[code]);
        return;
      }
    } else if (request.method === "plugins.zoom.registration.configure") {
      try {
        if (!exactObject(request, [...baseFields, "params"])) {
          throw serviceError("PLUGIN_REQUEST_INVALID", "Zoom 配置请求 envelope 无效");
        }
        result = await configureZoomRegistration(paths, secretStore, request.params);
      } catch (error) {
        const code = Object.hasOwn(PLUGIN_PUBLIC_MESSAGES, error?.code)
          ? error.code : "PLUGIN_REQUEST_INVALID";
        errorResponse(socket, id, code, PLUGIN_PUBLIC_MESSAGES[code]);
        return;
      }
    } else if (request.method === "plugins.dropbox.registration.status") {
      try {
        if (!pluginStore || !exactObject(request, [...baseFields, "params"])
          || !exactObject(request.params, [])) {
          throw serviceError("PLUGIN_REQUEST_INVALID", "Dropbox 配置状态请求无效");
        }
        const configured = loadDropboxRegistration(paths) !== null;
        result = { configured, restartRequired: configured && dropboxRegistration === null };
      } catch (error) {
        const code = Object.hasOwn(PLUGIN_PUBLIC_MESSAGES, error?.code)
          ? error.code : "PLUGIN_REQUEST_INVALID";
        errorResponse(socket, id, code, PLUGIN_PUBLIC_MESSAGES[code]);
        return;
      }
    } else if (request.method === "plugins.dropbox.registration.configure") {
      try {
        if (!exactObject(request, [...baseFields, "params"])) {
          throw serviceError("PLUGIN_REQUEST_INVALID", "Dropbox 配置请求 envelope 无效");
        }
        result = await configureDropboxRegistration(paths, secretStore, request.params);
      } catch (error) {
        const code = Object.hasOwn(PLUGIN_PUBLIC_MESSAGES, error?.code)
          ? error.code : "PLUGIN_REQUEST_INVALID";
        errorResponse(socket, id, code, PLUGIN_PUBLIC_MESSAGES[code]);
        return;
      }
    } else if (request.method === "plugins.gmail.registration.status") {
      try {
        if (!gmailRuntime || !exactObject(request, [...baseFields, "params"])
          || !exactObject(request.params, [])) throw serviceError("PLUGIN_REQUEST_INVALID", "Gmail 状态请求无效");
        result = gmailRuntime.status();
      } catch (error) {
        const code = Object.hasOwn(PLUGIN_PUBLIC_MESSAGES, error?.code)
          ? error.code : "GMAIL_REGISTRATION_INVALID";
        errorResponse(socket, id, code, PLUGIN_PUBLIC_MESSAGES[code]);
        return;
      }
    } else if (request.method === "plugins.gmail.registration.configure") {
      try {
        if (!gmailRuntime || !exactObject(request, [...baseFields, "params"])
          || !exactObject(request.params, ["credentialsPath"])) {
          throw serviceError("PLUGIN_REQUEST_INVALID", "Gmail 客户端导入请求无效");
        }
        result = await gmailRuntime.configure(request.params);
      } catch (error) {
        const code = Object.hasOwn(PLUGIN_PUBLIC_MESSAGES, error?.code)
          ? error.code : "GMAIL_REGISTRATION_INVALID";
        errorResponse(socket, id, code, PLUGIN_PUBLIC_MESSAGES[code]);
        return;
      }
    } else if (request.method === "plugins.gmail.capabilities.status") {
      try {
        if (!gmailRuntime || !exactObject(request, [...baseFields, "params"])
          || !exactObject(request.params, [])) throw serviceError("PLUGIN_REQUEST_INVALID", "Gmail 权限状态请求无效");
        result = gmailRuntime.capabilities();
      } catch (error) {
        const code = Object.hasOwn(PLUGIN_PUBLIC_MESSAGES, error?.code)
          ? error.code : "GMAIL_CAPABILITIES_INVALID";
        errorResponse(socket, id, code, PLUGIN_PUBLIC_MESSAGES[code]);
        return;
      }
    } else if (request.method === "plugins.gmail.capabilities.configure") {
      try {
        if (!gmailRuntime || !exactObject(request, [...baseFields, "params"])) {
          throw serviceError("PLUGIN_REQUEST_INVALID", "Gmail 权限设置请求无效");
        }
        result = gmailRuntime.configureCapabilities(request.params);
        for (const connection of pluginStore.listConnections()) {
          if (connection.endpointIdentity?.startsWith(`${GMAIL_TRANSPORT}:`)) {
            pluginToolCatalogRegistry.invalidate(connection.connectionId);
            void pluginMcpConnectionPool.drainConnection(connection.connectionId).catch(() => {});
          }
        }
      } catch (error) {
        const code = Object.hasOwn(PLUGIN_PUBLIC_MESSAGES, error?.code)
          ? error.code : "GMAIL_CAPABILITIES_INVALID";
        errorResponse(socket, id, code, PLUGIN_PUBLIC_MESSAGES[code]);
        return;
      }
    } else if (["plugins.gmail.auth.start", "plugins.gmail.auth.status",
      "plugins.gmail.auth.cancel", "plugins.gmail.auth.pending",
      "plugins.gmail.auth.reconcile"].includes(request.method)) {
      try {
        if (!pluginGmailController || !exactObject(request, [...baseFields, "params"])) {
          throw serviceError("PLUGIN_REQUEST_INVALID", "Gmail 账号连接请求无效");
        }
        result = request.method === "plugins.gmail.auth.start"
          ? pluginGmailController.start(request.params)
          : request.method === "plugins.gmail.auth.cancel"
            ? pluginGmailController.cancel(request.params)
            : request.method === "plugins.gmail.auth.pending"
              ? { pending: pluginGmailController.pendingAuthorization(request.params) }
            : request.method === "plugins.gmail.auth.reconcile"
              ? await pluginGmailController.reconcile(request.params)
              : pluginGmailController.status(request.params);
      } catch (error) {
        const code = Object.hasOwn(PLUGIN_PUBLIC_MESSAGES, error?.code)
          ? error.code : "GMAIL_AUTH_FAILED";
        errorResponse(socket, id, code, PLUGIN_PUBLIC_MESSAGES[code]);
        return;
      }
    } else if (request.method === "plugins.graph.registration.status") {
      try {
        if (!pluginStore || !exactObject(request, [...baseFields, "params"])
          || !exactObject(request.params, [])) {
          throw serviceError("PLUGIN_REQUEST_INVALID", "Graph 配置状态请求无效");
        }
        result = getGraphRegistrationStatus(paths, outlookCalendarGraph);
      } catch (error) {
        const code = Object.hasOwn(PLUGIN_PUBLIC_MESSAGES, error?.code)
          ? error.code : "PLUGIN_REQUEST_INVALID";
        errorResponse(socket, id, code, PLUGIN_PUBLIC_MESSAGES[code]);
        return;
      }
    } else if (request.method === "plugins.graph.registration.configure") {
      try {
        if (!pluginStore || !exactObject(request, [...baseFields, "params"])) {
          throw serviceError("PLUGIN_REQUEST_INVALID", "Graph 配置请求 envelope 无效");
        }
        result = configureGraphRegistration(paths, outlookCalendarGraph, request.params);
      } catch (error) {
        const code = Object.hasOwn(PLUGIN_PUBLIC_MESSAGES, error?.code)
          ? error.code : "PLUGIN_REQUEST_INVALID";
        errorResponse(socket, id, code, PLUGIN_PUBLIC_MESSAGES[code]);
        return;
      }
    } else if (request.method === "plugins.lovable.registration.status") {
      try {
        if (!lovableRegistration || !exactObject(request, [...baseFields, "params"])
          || !exactObject(request.params, [])) {
          throw serviceError("PLUGIN_REQUEST_INVALID", "Lovable 配置状态请求无效");
        }
        result = lovableRegistration.status();
      } catch (error) {
        const code = Object.hasOwn(PLUGIN_PUBLIC_MESSAGES, error?.code)
          ? error.code : "PLUGIN_REQUEST_INVALID";
        errorResponse(socket, id, code, PLUGIN_PUBLIC_MESSAGES[code]);
        return;
      }
    } else if (request.method === "plugins.lovable.registration.configure") {
      try {
        if (!lovableRegistration || !exactObject(request, [...baseFields, "params"])) {
          throw serviceError("PLUGIN_REQUEST_INVALID", "Lovable 配置请求无效");
        }
        result = await lovableRegistration.configure(request.params);
      } catch (error) {
        const code = Object.hasOwn(PLUGIN_PUBLIC_MESSAGES, error?.code)
          ? error.code : "CONNECTION_AUTH_REQUIRED";
        errorResponse(socket, id, code, PLUGIN_PUBLIC_MESSAGES[code]);
        return;
      }
    } else if (request.method === "plugins.lovable.registration.reconcile") {
      try {
        if (!lovableRegistration || !exactObject(request, [...baseFields, "params"])) {
          throw serviceError("PLUGIN_REQUEST_INVALID", "Lovable 待核对登记请求无效");
        }
        result = lovableRegistration.reconcile(request.params);
      } catch (error) {
        const code = Object.hasOwn(PLUGIN_PUBLIC_MESSAGES, error?.code)
          ? error.code : "LOVABLE_REGISTRATION_NEEDS_VERIFICATION";
        errorResponse(socket, id, code, PLUGIN_PUBLIC_MESSAGES[code]);
        return;
      }
    } else if (request.method === "plugins.higgsfield.registration.status") {
      try {
        if (!higgsfieldRegistration || !exactObject(request, [...baseFields, "params"])
          || !exactObject(request.params, [])) {
          throw serviceError("PLUGIN_REQUEST_INVALID", "Higgsfield 配置状态请求无效");
        }
        result = higgsfieldRegistration.status();
      } catch (error) {
        const code = Object.hasOwn(PLUGIN_PUBLIC_MESSAGES, error?.code)
          ? error.code : "PLUGIN_REQUEST_INVALID";
        errorResponse(socket, id, code, PLUGIN_PUBLIC_MESSAGES[code]);
        return;
      }
    } else if (request.method === "plugins.higgsfield.registration.configure") {
      try {
        if (!higgsfieldRegistration || !exactObject(request, [...baseFields, "params"])) {
          throw serviceError("PLUGIN_REQUEST_INVALID", "Higgsfield 配置请求无效");
        }
        result = await higgsfieldRegistration.configure(request.params);
      } catch (error) {
        const code = Object.hasOwn(PLUGIN_PUBLIC_MESSAGES, error?.code)
          ? error.code : "CONNECTION_AUTH_REQUIRED";
        errorResponse(socket, id, code, PLUGIN_PUBLIC_MESSAGES[code]);
        return;
      }
    } else if (request.method === "plugins.higgsfield.registration.reconcile") {
      try {
        if (!higgsfieldRegistration || !exactObject(request, [...baseFields, "params"])) {
          throw serviceError("PLUGIN_REQUEST_INVALID", "Higgsfield 待核对登记请求无效");
        }
        result = higgsfieldRegistration.reconcile(request.params);
      } catch (error) {
        const code = Object.hasOwn(PLUGIN_PUBLIC_MESSAGES, error?.code)
          ? error.code : "HIGGSFIELD_REGISTRATION_NEEDS_VERIFICATION";
        errorResponse(socket, id, code, PLUGIN_PUBLIC_MESSAGES[code]);
        return;
      }
    } else if (request.method === "plugins.slack.registration.status") {
      try {
        if (!slackRegistration || !exactObject(request, [...baseFields, "params"])
          || !exactObject(request.params, [])) {
          throw serviceError("PLUGIN_REQUEST_INVALID", "Slack 配置状态请求无效");
        }
        result = slackRegistration.status();
      } catch (error) {
        const code = Object.hasOwn(PLUGIN_PUBLIC_MESSAGES, error?.code)
          ? error.code : "PLUGIN_REQUEST_INVALID";
        errorResponse(socket, id, code, PLUGIN_PUBLIC_MESSAGES[code]);
        return;
      }
    } else if (request.method === "plugins.slack.registration.configure") {
      try {
        if (!slackRegistration || !exactObject(request, [...baseFields, "params"])) {
          throw serviceError("PLUGIN_REQUEST_INVALID", "Slack 配置请求无效");
        }
        result = slackRegistration.configure(request.params);
      } catch (error) {
        const code = Object.hasOwn(PLUGIN_PUBLIC_MESSAGES, error?.code)
          ? error.code : "PLUGIN_REQUEST_INVALID";
        errorResponse(socket, id, code, PLUGIN_PUBLIC_MESSAGES[code]);
        return;
      }
    } else if (request.method === CODEX_SECURITY_STATUS_METHOD) {
      try {
        if (!codexSecurityServiceController || !exactObject(request, [...baseFields, "params"])) {
          throw serviceError("CODEX_SECURITY_SERVICE_INVALID", "Codex Security 只读请求无效");
        }
        result = await codexSecurityServiceController.status(request.params);
      } catch (error) {
        const code = Object.hasOwn(CODEX_SECURITY_PUBLIC_MESSAGES, error?.code)
          ? error.code : "CODEX_SECURITY_SERVICE_UNAVAILABLE";
        errorResponse(socket, id, code, CODEX_SECURITY_PUBLIC_MESSAGES[code]);
        return;
      }
    } else if (PLUGIN_SERVICE_METHOD_SET.has(request.method)) {
      if (!pluginServiceController) {
        errorResponse(socket, id, "PLUGIN_UNAVAILABLE", "插件管理服务不可用");
        return;
      }
      try {
        if (!exactObject(request, [...baseFields, "params"])) {
          throw serviceError("PLUGIN_REQUEST_INVALID", "插件管理请求 envelope 无效");
        }
        result = await pluginServiceController.handle(request.method, request.params);
      } catch (error) {
        const code = Object.hasOwn(PLUGIN_PUBLIC_MESSAGES, error?.code)
          ? error.code : "PLUGIN_SERVICE_FAILED";
        errorResponse(socket, id, code, PLUGIN_PUBLIC_MESSAGES[code]);
        return;
      }
    } else if (["provider.endpoints.list", "provider.endpoints.save", "provider.endpoints.delete", "provider.endpoints.discover"].includes(request.method)) {
      const fields = request.method === "provider.endpoints.list" ? ["profileId"]
        : request.method === "provider.endpoints.delete" ? ["profileId", "id"] : ["profileId", "endpoint"];
      if (!exactObject(request, ["id", "token", "version", "method", "params"])
        || !exactObject(request.params, fields)
        || (request.params.profileId !== null && !validBoundedString(request.params.profileId, 128))) {
        errorResponse(socket, id, "INVALID_PARAMS", "端点参数无效");
        return;
      }
      try {
        if (request.method === "provider.endpoints.list") result = customEndpointService.list(request.params.profileId);
        else if (request.method === "provider.endpoints.save") result = await customEndpointService.save(request.params.profileId, request.params.endpoint);
        else if (request.method === "provider.endpoints.delete") result = await customEndpointService.remove(request.params.profileId, request.params.id);
        else result = await customEndpointService.discover(request.params.profileId, request.params.endpoint);
      } catch (error) {
        errorResponse(socket, id, "CUSTOM_ENDPOINT_REJECTED", error?.code === "CUSTOM_ENDPOINT_REJECTED"
          ? error.message : "端点操作失败，请检查连接配置和本机 Service 后重试。");
        return;
      }
    } else if ([
      "provider.list", "provider.save", "provider.delete", "provider.secret.set",
      "provider.secret.clear", "provider.validate",
    ].includes(request.method)) {
      if (!exactObject(request, ["id", "token", "version", "method", "params"])
        || !providerParamsValid(request.method, request.params)) {
        errorResponse(socket, id, "INVALID_PARAMS", "Provider 参数无效");
        return;
      }
      try {
        if (request.method === "provider.list") result = providerService.list();
        else if (request.method === "provider.save") result = await providerService.save(request.params.provider);
        else if (request.method === "provider.delete") result = await providerService.delete(request.params);
        else if (request.method === "provider.secret.set") {
          result = await providerService.setSecret(request.params);
        } else if (request.method === "provider.secret.clear") {
          result = await providerService.clearSecret(request.params);
        } else result = await providerService.validate(request.params);
        result = validatedProviderResult(request.method, result);
      } catch (error) {
        const code = PROVIDER_PUBLIC_ERROR_CODES.has(error?.code)
          ? error.code : "PROVIDER_OPERATION_FAILED";
        errorResponse(socket, id, code, "Provider 操作失败");
        return;
      }
    } else if (["auth.read", "auth.login.start", "auth.login.cancel", "auth.logout"]
      .includes(request.method)) {
      if (!exactObject(request, ["id", "token", "version", "method", "params"])
        || !authParamsValid(request.method, request.params)) {
        errorResponse(socket, id, "INVALID_PARAMS", "账户认证参数无效");
        return;
      }
      try {
        if (request.method === "auth.read") result = await accountAuthManager.read(request.params);
        else if (request.method === "auth.login.start") {
          result = await accountAuthManager.loginStart(request.params);
        } else if (request.method === "auth.login.cancel") {
          result = await accountAuthManager.loginCancel(request.params);
        } else result = await accountAuthManager.logout(request.params);
      } catch (error) {
        const code = AUTH_PUBLIC_ERROR_CODES.has(error?.code) ? error.code : "AUTH_OPERATION_FAILED";
        errorResponse(socket, id, code, "账户认证操作失败");
        return;
      }
      if (!validateAuthResult(request.method, result)) {
        errorResponse(socket, id, "AUTH_RESPONSE_INVALID", "账户认证响应无效");
        return;
      }
    } else if (request.method === "runtime.observability.get") {
      if (!exactObject(request, ["id", "token", "version", "method", "params"]) || !exactObject(request.params, [])) {
        errorResponse(socket, id, "INVALID_PARAMS", "Invalid diagnostics request"); return;
      }
      result = workRunCoordinator.getRuntimeObservability();
    } else if (request.method === "runtime.extension.credential.set") {
      if (!exactObject(request, ["id", "token", "version", "method", "params"])
        || !exactObject(request.params, ["credentialRef", "token"])
        || !/^runtime-worker-[a-z0-9-]{1,100}$/u.test(request.params.credentialRef || "")
        || typeof request.params.token !== "string" || request.params.token.length < 32 || request.params.token.length > 4096) {
        errorResponse(socket, id, "INVALID_PARAMS", "Invalid worker credential"); return;
      }
      await secretStore.put(request.params.credentialRef, request.params.token, { kind: "runtime-worker-token" });
      result = { stored: true };
    } else if (require("./product-context-protocol").METHODS.includes(request.method)) {
      const protocol = require("./product-context-protocol");
      try {
        if (!exactObject(request, ["id", "token", "version", "method", "params"])) throw serviceError("PRODUCT_CONTEXT_INVALID", "Invalid envelope");
        const params = protocol.validateParams(request.method, request.params);
        const session = chatSessionStore.getSession(params.sessionKey);
        if (!session || session.profileId !== params.profileId) throw serviceError("CHAT_SESSION_NOT_FOUND", "会话不存在");
        if (request.method === protocol.BREAKDOWN_METHOD) {
          // Read on demand for one reply of this session, never while polling.
          const run = workRunCoordinator.getRun(params.runId);
          if (!run || run.profileId !== params.profileId || workRunCoordinator.getRunSessionKey(run) !== params.sessionKey) {
            throw serviceError("PRODUCT_CONTEXT_BREAKDOWN_UNAVAILABLE", "Run 不属于该会话");
          }
          result = protocol.validateBreakdown(contextBreakdownReader.forRun(run));
        } else {
          await chatServiceController.handle("chat.history", { sessionKey: params.sessionKey, cursor: null, limit: 1 }, null);
          result = protocol.validateResult(await workRunCoordinator.compactConversation(params));
        }
      } catch (error) {
        const code = Object.hasOwn(protocol.MESSAGES, error?.code) ? error.code
          : request.method === protocol.BREAKDOWN_METHOD ? "PRODUCT_CONTEXT_BREAKDOWN_UNAVAILABLE" : "PRODUCT_CONTEXT_FAILED";
        errorResponse(socket, id, code, protocol.MESSAGES[code]); return;
      }
    } else if (require("./runtime-selection-policy").RUNTIME_POLICY_METHODS.includes(request.method)) {
      const protocol = require("./runtime-selection-policy");
      try {
        if (!exactObject(request, ["id", "token", "version", "method", "params"])) throw serviceError("RUNTIME_SELECTION_POLICY_INVALID", "Invalid envelope");
        const params = protocol.validateRuntimePolicyParams(request.method, request.params);
        result = request.method === "agent.runtimePolicy.set"
          ? runtimeSelectionPolicyStore.set(params.profileId, params.policy) : runtimeSelectionPolicyStore.get(params.profileId);
        if (request.method === "agent.runtimePolicy.set") eventBuffer.append("agent.profile.changed", { profileId: params.profileId });
      } catch (error) {
        const code = Object.hasOwn(protocol.RUNTIME_POLICY_MESSAGES, error?.code) ? error.code : "RUNTIME_SELECTION_POLICY_UNAVAILABLE";
        errorResponse(socket, id, code, protocol.RUNTIME_POLICY_MESSAGES[code]); return;
      }
    } else if (require("./session-runtime-protocol").SESSION_RUNTIME_METHODS.includes(request.method)) {
      try {
        if (!exactObject(request, ["id", "token", "version", "method", "params"])) throw serviceError("INVALID_PARAMS", "Invalid envelope");
        result = await sessionRuntimeController.handle(request.method, request.params);
      } catch (error) {
        const { SESSION_RUNTIME_PUBLIC_MESSAGES: messages } = require("./session-runtime-protocol");
        const code = Object.hasOwn(messages, error?.code) ? error.code : "SESSION_RUNTIME_UNAVAILABLE";
        errorResponse(socket, id, code, messages[code]);
        return;
      }
    } else if (["agent.binding.list", "agent.binding.sync", "agent.binding.add", "agent.binding.update", "agent.binding.remove",
      "agent.binding.setDefault"].includes(request.method)) {
      try {
        if (!exactObject(request, ["id", "token", "version", "method", "params"])) {
          throw serviceError("INVALID_PARAMS", "Binding request envelope is invalid");
        }
        result = require("./agent-runtime-binding-controller").createAgentRuntimeBindingController({
          productStore, chatSessionStore, getNativeRuntimeConfig,
          policyStore: runtimeSelectionPolicyStore,
          canGenerateCheckpoint: runtime => runtimeManager.canGenerateModelOnly?.(runtime) === true,
          onChanged: payload => eventBuffer.append("agent.profile.changed", payload),
        }).handle(request.method, request.params);
      } catch (error) {
        const { AGENT_BINDING_PUBLIC_MESSAGES: PUBLIC_MESSAGES } = require("./agent-runtime-binding-protocol");
        const code = Object.hasOwn(PUBLIC_MESSAGES, error?.code) ? error.code : "AGENT_BINDING_INVALID";
        errorResponse(socket, id, code, PUBLIC_MESSAGES[code] || "Runtime Binding 操作失败");
        return;
      }
    } else if (RUNTIME_ACCOUNT_SERVICE_METHOD_SET.has(request.method)) {
      try {
        if (!exactObject(request, ["id", "token", "version", "method", "params"])) {
          throw serviceError("INVALID_PARAMS", "RuntimeAccount request envelope is invalid");
        }
        const params = validateRuntimeAccountServiceParams(request.method, request.params);
        result = await runtimeAccountServiceController.handle(request.method, params);
        result = validateRuntimeAccountServiceResult(request.method, result);
      } catch (error) {
        const mapped = mapRuntimeAccountServiceError(error);
        errorResponse(socket, id, mapped.code, mapped.message);
        return;
      }
    } else if (request.method === "usage.series" || request.method === "usage.breakdown") {
      try {
        if (!exactObject(request, ["id", "token", "version", "method", "params"])
          || !exactObject(request.params, ["range", "backendId"])
          || typeof request.params.backendId !== "string"
          || request.params.backendId !== "shoggoth") {
          throw serviceError("INVALID_PARAMS", "Token usage 参数无效");
        }
        const range = validateUsageRange(request.params.range);
        const profiles = productStore.listAgentProfiles().filter(profile => profile.backendId === request.params.backendId);
        const profileIds = new Set(profiles.map(profile => profile.id));
        let usageComplete = true;
        if (workRunCoordinator.listRuns().some(run => profileIds.has(run.profileId)
          && run.runtimeSessionRef?.runtime === "grok-build") && typeof grokBuildRuntimePool.readUsage === "function") {
          const now = (options.now || Date.now)();
          const start = new Date(now);
          start.setHours(0, 0, 0, 0);
          start.setDate(start.getDate() - ({ today: 1, "7d": 7, "30d": 30, "90d": 90, "1y": 365 }[range] || 1) + 1);
          usageComplete = await reconcileGrokUsage({ profiles, runs: workRunCoordinator.listRuns(),
            usageStore: tokenUsageStore, sinceMs: range === "all" ? 0 : start.getTime(), now,
            readUsage: (profile, query) => grokBuildRuntimePool.readUsage({ runtime: profile.runtime,
              runtimeProfileId: profile.runtimeProfileId, runtimeAccountId: profile.runtimeAccountId }, query) });
        }
        const summary = tokenUsageStore.summarize(range, {
          backendId: request.params.backendId,
          profileIds,
        });
        if (!usageComplete) summary.series.availability = "partial";
        if (request.method === "usage.breakdown"
          && typeof transcriptStore.summarizeUsageActivity === "function") {
          const activity = transcriptStore.summarizeUsageActivity(range, profileIds);
          const usageByDate = new Map(summary.series.daily.map((day) => [day.date, day]));
          summary.breakdown = {
            ...summary.breakdown,
            tools: activity.tools,
            messages: activity.messages,
            dailyActivity: activity.dailyActivity.map((day) => ({
              ...day,
              tokens: Number(usageByDate.get(day.date)?.totalTokens) || 0,
              cost: Number(usageByDate.get(day.date)?.totalCost) || 0,
            })),
          };
        }
        result = request.method === "usage.series"
          ? validateUsageSeries(summary.series)
          : validateUsageBreakdown(summary.breakdown);
      } catch (error) {
        if (error?.code === "INVALID_PARAMS") {
          errorResponse(socket, id, "INVALID_PARAMS", "Token usage 参数无效");
        } else if (error instanceof TypeError) {
          errorResponse(socket, id, "USAGE_RESPONSE_INVALID", "Token usage 响应无效");
        } else {
          errorResponse(socket, id, "SERVICE_UNAVAILABLE", "Token usage 暂时不可用");
        }
        return;
      }
    } else if (AGENT_LIFECYCLE_METHOD_SET.has(request.method)) {
      try {
        if (!exactObject(request, ["id", "token", "version", "method", "params"])) {
          throw serviceError("INVALID_PARAMS", "Agent lifecycle request envelope is invalid");
        }
        const params = validateAgentLifecycleParams(request.method, request.params);
        result = await agentLifecycleServiceController.handle(request.method, params);
        result = validateAgentLifecycleResult(request.method, result);
      } catch (error) {
        const mapped = mapAgentLifecycleError(error);
        errorResponse(socket, id, mapped.code, mapped.message);
        return;
      }
    } else if (BROWSER_SERVICE_METHODS.includes(request.method)) {
      try {
        if (!exactObject(request, [...baseFields, "params"]) || !exactObject(request.params, [])) {
          throw serviceError("INVALID_PARAMS", "Browser Use request envelope is invalid");
        }
        result = validateBrowserState(await browserUseController.status());
      } catch (error) {
        const code = Object.hasOwn(BROWSER_PUBLIC_MESSAGES, error?.code || "") ? error.code
          : error?.code === "INVALID_PARAMS" ? "INVALID_PARAMS" : "BROWSER_SERVICE_UNAVAILABLE";
        errorResponse(socket, id, code, BROWSER_PUBLIC_MESSAGES[code] || "Browser Use 请求参数无效");
        return;
      }
    } else if (COMPUTER_SERVICE_METHODS.includes(request.method)) {
      try {
        if (!exactObject(request, [...baseFields, "params"])) {
          throw serviceError("INVALID_PARAMS", "Computer Use request envelope is invalid");
        }
        result = await handleComputerServiceRequest(computerUseController, request.method, request.params);
      } catch (error) {
        const mapped = mapComputerServiceError(error);
        errorResponse(socket, id, mapped.code, mapped.message);
        return;
      }
    } else if (AGENT_HARNESS_METHOD_SET.has(request.method)) {
      try {
        if (!exactObject(request, ["id", "token", "version", "method", "params"])) {
          throw serviceError("INVALID_PARAMS", "Agent Harness request envelope is invalid");
        }
        const params = validateAgentHarnessParams(request.method, request.params);
        result = await agentHarnessServiceController.handle(request.method, params);
        result = validateAgentHarnessResult(request.method, result, params);
      } catch (error) {
        const mapped = mapAgentHarnessError(error);
        errorResponse(socket, id, mapped.code, mapped.message);
        return;
      }
    } else if (PROFILE_SERVICE_METHOD_SET.has(request.method)) {
      try {
        if (!exactObject(request, ["id", "token", "version", "method", "params"])) {
          throw serviceError("INVALID_PARAMS", "Profile request envelope is invalid");
        }
        const params = validateProfileServiceParams(request.method, request.params);
        result = await profileServiceController.handle(request.method, params);
        result = validateProfileServiceResult(request.method, result);
      } catch (error) {
        const mapped = mapProfileServiceError(error);
        errorResponse(socket, id, mapped.code, mapped.message);
        return;
      }
    } else if (GROUP_CHAT_SERVICE_METHOD_SET.has(request.method)) {
      try {
        if (!exactObject(request, ["id", "token", "version", "method", "params"])) throw serviceError("GROUP_CHAT_INVALID", GROUP_CHAT_PUBLIC_MESSAGES.GROUP_CHAT_INVALID);
        const params = validateGroupChatParams(request.method, request.params);
        result = validateGroupChatResult(request.method, await groupChatService.handle(request.method, params));
        result = groupChatService.responsePages.pack(request.method, params, result);
      } catch (error) {
        const code = Object.hasOwn(GROUP_CHAT_PUBLIC_MESSAGES, error?.code) ? error.code : "GROUP_CHAT_UNAVAILABLE";
        if (code === "GROUP_CHAT_UNAVAILABLE") console.error(`[agent-service] group chat ${request.method} failed: ${error?.code || error?.message || "UNKNOWN"}`);
        errorResponse(socket, id, code, GROUP_CHAT_PUBLIC_MESSAGES[code]); return;
      }
    } else if (learningProtocol.METHODS.has(request.method)) {
      try {
        if (!exactObject(request, ["id", "token", "version", "method", "params"])) learningProtocol.fail();
        result = await learningService.handle(request.method, request.params);
      } catch (error) {
        const code = Object.hasOwn(learningProtocol.PUBLIC_ERRORS, error?.code) ? error.code : "LEARNING_UNAVAILABLE";
        errorResponse(socket, id, code, learningProtocol.PUBLIC_ERRORS[code]); return;
      }
    } else if (webSettingsProtocol.METHODS.includes(request.method)) {
      try {
        if (!exactObject(request, ["id", "token", "version", "method", "params"])) webSettingsProtocol.fail();
        result = webSettingsProtocol.validateResult(await webSettings.handle(request.method, request.params));
      } catch (error) {
        const safe = webSettingsProtocol.publicError(error);
        errorResponse(socket, id, safe.code, safe.message); return;
      }
    } else if (PROACTIVE_SERVICE_METHOD_SET.has(request.method)) {
      try {
        if (!exactObject(request, ["id", "token", "version", "method", "params"])) throw serviceError("PROACTIVE_INVALID", PROACTIVE_PUBLIC_MESSAGES.PROACTIVE_INVALID);
        const params = validateProactiveParams(request.method, request.params);
        result = validateProactiveResult(request.method, await proactiveService.handle(request.method, params));
      } catch (error) {
        const code = Object.hasOwn(PROACTIVE_PUBLIC_MESSAGES, error?.code) ? error.code : "PROACTIVE_UNAVAILABLE";
        errorResponse(socket, id, code, PROACTIVE_PUBLIC_MESSAGES[code]); return;
      }
    } else if (codexAutomationProtocol.METHODS.includes(request.method)) {
      try {
        if (!exactObject(request, [...baseFields, "params"])) throw serviceError("CODEX_AUTOMATION_PARAMS_INVALID", "Invalid request");
        const params = codexAutomationProtocol.validateParams(request.method, request.params);
        result = codexAutomationProtocol.validateResult(request.method,
          await codexAutomationController.handle(request.method, params), params);
      } catch (error) {
        const code = Object.hasOwn(codexAutomationProtocol.MESSAGES, error?.code) ? error.code : "CODEX_AUTOMATION_UNAVAILABLE";
        errorResponse(socket, id, code, codexAutomationProtocol.MESSAGES[code]);
        return;
      }
    } else if (codexDesktopProtocol.METHODS.includes(request.method)) {
      try {
        if (!exactObject(request, [...baseFields, "params"])) throw serviceError("CODEX_DESKTOP_PARAMS_INVALID", "Invalid request");
        const params = codexDesktopProtocol.validateParams(request.method, request.params);
        result = codexDesktopProtocol.validateResult(request.method,
          await codexDesktopSessionController.handle(request.method, params));
      } catch (error) {
        const code = Object.hasOwn(codexDesktopProtocol.MESSAGES, error?.code) ? error.code : "CODEX_DESKTOP_UNAVAILABLE";
        errorResponse(socket, id, code, codexDesktopProtocol.MESSAGES[code]);
        return;
      }
    } else if (INSPIRATION_SERVICE_METHOD_SET.has(request.method)) {
      try {
        const params = validateInspirationServiceParams(request.method, request.params);
        result = validateInspirationServiceResult(request.method, await inspirationService.handle(request.method, params));
      } catch (error) {
        const code = Object.hasOwn(INSPIRATION_PUBLIC_MESSAGES, error?.code) ? error.code : "INSPIRATION_UNAVAILABLE";
        errorResponse(socket, id, code, INSPIRATION_PUBLIC_MESSAGES[code]);
        return;
      }
    } else if (CHAT_SERVICE_METHOD_SET.has(request.method)) {
      try {
        const canonical = validateChatServiceRequest(request);
        result = await chatServiceController.handle(
          canonical.method,
          canonical.params,
          canonical.id,
        );
        result = validateChatServiceResult(canonical.method, result);
      } catch (error) {
        if (error?.code === "UNKNOWN_METHOD") {
          errorResponse(socket, id, "UNKNOWN_METHOD", "Chat Service 方法尚未接线");
          return;
        }
        if (["credentials_locked", "pending_commands_locked"].includes(error?.code)) {
          errorResponse(socket, id, "SERVICE_UNAVAILABLE", "Shoggoth Service 暂时不可用");
          return;
        }
        const mapped = mapChatServiceError(error);
        writeResponse(socket, { id: id ?? null, ok: false, error: { ...mapped,
          ...(request.method === "chat.send" && error?.admissionAccepted === false ? { admissionAccepted: false } : {}) } });
        return;
      }
    } else if (DOMAIN_SERVICE_METHOD_SET.has(request.method)) {
      try {
        const canonical = validateDomainServiceRequest(request);
        result = await nativeDomainServiceController.handle(
          canonical.method,
          canonical.params,
        );
        result = validateDomainServiceResult(canonical.method, result, canonical.params);
      } catch (error) {
        const mapped = mapDomainServiceError(error, { method: request.method });
        errorResponse(socket, id, mapped.code, mapped.message);
        return;
      }
    } else if (request.method === "service.quiesceIdle") {
      if (!exactObject(request, [...baseFields, "params"])
        || !exactObject(request.params, ["instanceNonce", "revision"])
        || request.params.instanceNonce !== instanceNonce
        || typeof request.params.revision !== "string") {
        errorResponse(socket, id, "INVALID_PARAMS", "数据目录切换请求无效");
        return;
      }
      const impact = createStopImpact({ runs: workRunCoordinator.listRuns(),
        instanceNonce: `${instanceNonce}:${lifecycleGeneration}` });
      if (activeRuntimeRequests !== 1 || impact.totalCount !== 0
        || impact.revision !== request.params.revision) {
        errorResponse(socket, id, "SERVICE_MAINTENANCE_BUSY", "Service 正忙，请稍后重试");
        return;
      }
      try { workRunCoordinator.quiesceIfIdle(); }
      catch {
        errorResponse(socket, id, "SERVICE_MAINTENANCE_BUSY", "Service 正忙，请稍后重试");
        return;
      }
      maintenanceQuiesced = true;
      await learningService.close();
      await proactiveScheduler.close();
      await proactiveService.close();
      await proactiveScheduler.waitForIdle();
      result = { quiesced: true, instanceNonce };
    } else if (request.method === "service.stop") {
      result = { stopping: true };
    } else {
      errorResponse(socket, id, "UNKNOWN_METHOD", `未知方法: ${String(request.method)}`);
      return;
    }

    const publicProfile = profile => ({ ...profile, backendId: profile.backendId });
    if (request.method === "profile.list") result = { ...result, profiles: result.profiles.map(publicProfile) };
    else if (request.method === "agent.lifecycle.list") result = { ...result,
      agents: result.agents.map(item => ({ ...item, profile: publicProfile(item.profile) })) };
    else if ((AGENT_LIFECYCLE_METHOD_SET.has(request.method) || PROFILE_SERVICE_METHOD_SET.has(request.method))
      && result.profile) result = { ...result, profile: publicProfile(result.profile) };
    writeResponse(socket, { id, ok: true, result });
    if (request.method === "service.stop") {
      setImmediate(() => { void api.stop().catch(reportStopFailure); });
    }
  }

  function acceptSocket(socket) {
    sockets.add(socket);
    let buffered = Buffer.alloc(0);
    let terminal = false;
    let frameTimer = null;
    const clearFrameTimer = () => {
      if (frameTimer) clearTimeout(frameTimer);
      frameTimer = null;
    };
    const armFrameTimer = () => {
      clearFrameTimer();
      const timer = setTimeout(() => {
        // After a blocked turn, expired timers run before sockets are read.
        // Let bytes that already arrived reach onData (poll phase) first.
        setImmediate(() => {
          if (frameTimer !== timer || terminal || socket.destroyed) return;
          terminal = true;
          buffered = Buffer.alloc(0);
          errorResponse(socket, null, "FRAME_TIMEOUT", "请求帧接收超时", true);
        });
      }, frameTimeoutMs);
      frameTimer = timer;
    };
    armFrameTimer();
    attachAcceptedSocketErrorGuard(socket, () => {
      // 对端 reset/EPIPE 是连接级失败，不能升级成 Service 未捕获异常。
      terminal = true;
      clearFrameTimer();
    });
    const onClose = () => {
      terminal = true;
      clearFrameTimer();
      sockets.delete(socket);
      inFlightSockets.delete(socket);
    };
    const onEnd = () => {
      clearFrameTimer();
      if (terminal || socket.destroyed) return;
      terminal = true;
      if (buffered.length > 0) {
        buffered = Buffer.alloc(0);
        errorResponse(socket, null, "INCOMPLETE_FRAME", "连接在 JSONL 帧完成前结束", true);
      } else {
        socket.end();
      }
    };
    const onData = (chunk) => {
      if (terminal) return;
      clearFrameTimer();
      buffered = Buffer.concat([buffered, chunk]);
      while (true) {
        const newline = buffered.indexOf(0x0a);
        if (newline < 0) {
          if (buffered.length > MAX_FRAME_BYTES) {
            terminal = true;
            buffered = Buffer.alloc(0);
            errorResponse(socket, null, "FRAME_TOO_LARGE", "请求帧超过上限", true);
          } else {
            armFrameTimer();
          }
          return;
        }
        const frame = buffered.subarray(0, newline);
        buffered = buffered.subarray(newline + 1);
        if (frame.length > MAX_FRAME_BYTES) {
          terminal = true;
          errorResponse(socket, null, "FRAME_TOO_LARGE", "请求帧超过上限", true);
          return;
        }
        let request;
        try {
          request = JSON.parse(frame.toString("utf8"));
        } catch {
          terminal = true;
          errorResponse(socket, null, "MALFORMED_JSON", "请求不是有效 JSON", true);
          return;
        }
        if (buffered.length > 0) {
          terminal = true;
          buffered = Buffer.alloc(0);
          errorResponse(socket, null, "MULTIPLE_REQUESTS", "单连接只允许一个 JSONL 请求", true);
          return;
        }
        terminal = true;
        clearFrameTimer();
        if (request && request.method === "mcp.runtime.bridge.open") {
          socket.pause();
          socket.off("data", onData);
          socket.off("end", onEnd);
          void Promise.resolve()
            .then(() => openMcpRuntimeBridge(socket, request))
            .catch((error) => handleMcpError(socket, null, error));
          return;
        }
        activeRuntimeRequests += 1;
        const inFlight = Promise.resolve()
          .then(() => runtimeManager.withActivity
            ? runtimeManager.withActivity(() => handleRequest(socket, request))
            : handleRequest(socket, request))
          .catch(() => handleInternalError(socket, request))
          // A normal response remains in-flight until the socket close confirms
          // write callback + EOF. An already-disconnected peer has no response
          // left to drain, and its close event may have preceded this microtask.
          .finally(() => {
            activeRuntimeRequests -= 1;
            if (socket.destroyed) inFlightSockets.delete(socket);
          });
        inFlightSockets.add(socket);
        void inFlight;
        return;
      }
    };
    socket.on("close", onClose);
    socket.on("end", onEnd);
    socket.on("data", onData);
  }

  const api = {
    hookStore, hookService, hookRunner, hookProcessHost,
    productStore,
    secretStore,
    mcpCryptoBroker,
    runtimeConfigWriter,
    providerRuntimeBridge,
    providerService,
    runtimePool,
    codexRuntimeAdapter,
    grokBuildRuntimePool,
    grokBuildRuntimeAdapter,
    antigravityRuntimePool,
    antigravityRuntimeAdapter,
    piRuntimePool,
    piRuntimeAdapter,
    claudeCodeRuntimePool,
    claudeCodeRuntimeAdapter,
    openCodeRuntimePool,
    openCodeRuntimeAdapter,
    deepSeekHarnessRuntimePool,
    deepSeekHarnessRuntimeAdapter,
    runtimeManager,
    runtimeAccountAdmission,
    runtimeAccountServiceController,
    runtimeSessionOwnershipStore,
    runtimeMcpGateIssuer,
    accountAuthStateStore,
    accountAuthManager,
    get codexSecurityServiceController() { return codexSecurityServiceController; },
    profileServiceController,
    agentLifecycleServiceController,
    agentArchiveRetention,
    chatSessionStore,
    agentDefinitionStore,
    transcriptStore,
    memoryStore,
    memoryEngine,
    memoryProvenanceStore,
    memoryProvenanceService,
    memoryCandidateStore,
    memoryCandidateService,
    codexMemoryImportService,
    conversationRecallService,
    nativeMemorySemanticService,
    nativeSkillStore,
    runtimeSkillStore,
    nativeMcpStore,
    pluginStore,
    pluginPackageInstaller,
    pluginComponentCatalog,
    pluginComponentResolver,
    pluginServiceController,
    pluginMcpConsent,
    pluginCatalogRestorer,
    pluginAppController,
    pluginOAuthController,
    pluginGraphConnectionController,
    outlookCalendarGraph,
    pluginBearerController,
    pluginGmailController,
    gmailRuntime,
    pluginDependencyController,
    pluginRollbackController,
    pluginConnectionController,
    pluginRuntimeToolService,
    externalPluginToolService,
    externalPluginSelectionDispatch,
    externalPluginProvenance,
    externalPluginApprovalBroker,
    pluginMcpConnectionManager,
    pluginCredentialVault,
    pluginConnectionAuth,
    pluginToolCatalogRegistry,
    pluginCapabilityDispatcher,
    pluginMcpConnectionPool,
    pluginQuickSetup,
    pluginSecretStore,
    firstPartyPluginSync,
    // The report of the first-party sync this start ran in the background.
    firstPartyPluginSyncDone: () => firstPartySyncDone,
    nativeMcpClientManager,
    systemHostController,
    computerUseController,
    browserUseController,
    toolRegistry,
    permissionEngine,
    federationCoordinator,
    federationMcpSessionManager,
    contextSnapshotStore,
    conversationCheckpointStore,
    contextCompiler,
    agentHarnessServiceController,
    tokenUsageStore,
    pendingCommandInbox,
    workDispatcher,
    nativeRuntimeConfig,
    nativeMemoryConfig,
    chatUiConfig, chatUiStore, chatUiController,
    nativeMemorySharingConfig,
    startupGate,
    nativeKanbanStore,
    inspirationStore,
    proactiveStore,
    groupChatStore,
    groupChatDriver,
    groupChatService,
    groupMemberDirectory,
    proactiveService,
    learningStore, learningService,
    proactiveScheduler,
    inspirationService,
    kanbanRunService,
    nativeCronStore,
    codexAutomationController,
    codexDesktopSessionController,
    nativeCronScheduler,
    domainWorkRunExecutor,
    get nativeDomainServiceController() { return nativeDomainServiceController; },
    get mcpProductToolController() { return mcpProductToolController; },
    get workRunCoordinator() { return workRunCoordinator; },
    get chatServiceController() { return chatServiceController; },

    getDomainAvailability() {
      return domainAvailabilitySnapshot();
    },

    appendEvent(type, payload) {
      return eventBuffer.append(type, payload);
    },

    start() {
      if (lifecycleState === "started") return Promise.resolve(api);
      if (lifecycleState === "starting") return startPromise;
      if (lifecycleState === "stopping") {
        return Promise.reject(serviceError("SERVICE_STOPPING", "Service 正在停止"));
      }
      if (lifecycleState === "stop_failed") return stopping;

      lifecycleState = "starting";
      recoveryDiagnosticWritten = false;
      const generation = ++lifecycleGeneration;
      // 先发布 singleflight promise，再在下一个 microtask 进入 startup；这样即使
      // 注入的底层实现同步重入 stop，也一定能等待并 fence 这一代启动。
      const currentStart = Promise.resolve().then(async () => {
        let acquiredLock;
        try {
          assertStartGeneration(generation);
          if (defaultCoordinatorRetired && !options.workRunCoordinator) {
            workRunCoordinator = createDefaultWorkRunCoordinator();
            chatUiController.coordinator = workRunCoordinator;
            defaultCoordinatorRetired = false;
            codexSecurityServiceController = createDefaultCodexSecurityServiceController();
          }
          if (defaultControllerRetired && !options.chatServiceController) {
            chatServiceController = createDefaultChatServiceController(workRunCoordinator);
            defaultControllerRetired = false;
          }
          if (defaultDomainControllerRetired && !options.nativeDomainServiceController) {
            const replacement = createDefaultNativeDomainServiceController();
            nativeDomainServiceController = replacement.controller;
            nativeDomainServiceControllerOwnerToken = replacement.ownerToken;
            defaultDomainControllerRetired = false;
          }
          if (defaultMcpProductToolControllerRetired && !options.mcpProductToolController) {
            const replacement = createDefaultMcpProductToolController();
            mcpProductToolController = replacement.controller;
            mcpProductToolControllerOwnerToken = replacement.ownerToken;
            defaultMcpProductToolControllerRetired = false;
          }
          activeDomainControllerOwnerToken = nativeDomainServiceControllerOwnerToken;
          activeMcpProductToolControllerOwnerToken = mcpProductToolControllerOwnerToken;
          domainFatalReports.kanban = null;
          domainFatalReports.cron = null;
          mcpProductFatalReport = null;
          startupFatal = null;
          // cache 必须先逐段拒绝 symlink，再允许创建其下 runtime；否则递归 mkdir
          // 会先穿透攻击者链接并污染链接目标。
          ensurePrivateDirectoryTree(paths.cacheDir, paths.trustedRoot);
          ensurePrivateDirectoryTree(paths.stateDir, paths.trustedRoot);
          ensurePrivateDirectoryTree(paths.profileDir, paths.trustedRoot);
          ensurePrivateDirectoryTree(paths.runtimeDir, paths.trustedRoot);
          acquiredLock = await acquireInstanceLock(paths.lockPath, {
            paths,
            instanceNonce,
            getProcessIdentity,
            lockProbeTimeoutMs,
            protocolVersion: PROTOCOL_VERSION,
            fs: options.lockFs,
          });
          lockFd = acquiredLock.fd;
          ownedLockIdentity = {
            dev: acquiredLock.identity.dev,
            ino: acquiredLock.identity.ino,
          };
          // stop 可能在 lock acquisition 挂起期间到达；先登记刚取得的所有权，
          // 再过 generation fence，确保取消路径能关闭 fd 并只删除自己的 inode。
          assertStartGeneration(generation);
          if (!options.productStore) assertCurrentStorageBaseline(paths);
          // 独占 lock 已证明没有合法 Service 持有这个 endpoint，清理崩溃遗留 socket。
          const staleSocketStat = rejectSymlink(paths.socketPath);
          if (staleSocketStat) fs.unlinkSync(paths.socketPath);
          if (!options.productStore && !options.chatSessionStore) recoverStalePersistentWriterLeases(paths);
          assertStartGeneration(generation);
          // 单实例锁取得后才打开 Store，确保整个产品状态只有 Service 这一位 writer。
          runtimeMcpGateIssuerOpened = true;
          await runtimeMcpGateIssuer.open();
          assertStartGeneration(generation);
          mcpCryptoBrokerOpened = true;
          await mcpCryptoBroker.open({ generation });
          assertStartGeneration(generation);
          secretStoreOpened = true;
          await secretStore.open();
          assertStartGeneration(generation);
          storeOpened = true;
          productStore.open();
          // Open before profile-retention recovery, which purges cross-store
          // references. This does not activate learning or read task evidence.
          try {
            learningStore.open(); learningStoreOpened = true;
            // Usage remains observable when learning is off. This watches
            // terminal metadata only; it never scans content or requests a model.
            unsubscribeLearningUsage = workDispatcher.subscribeChanges(run => {
              if (learningStore.db) learningStore.settleRun(run.id, run.status);
            });
          }
          catch (error) { console.error(`[agent-service] learning store unavailable: ${error?.code || "UNKNOWN"}`); }
          automationWorkRunStore.open();
          if (pluginStore) {
            pluginStoreOpened = true;
            pluginStore.open();
            // This database is a derived audit view, not product authority.
            // Keep native chat and plugin management available if it cannot
            // open; external tool egress will fail closed at audit begin().
            try {
              externalPluginProvenance.open();
              externalPluginProvenanceOpened = true;
            } catch {
              console.error("[agent-service] external plugin audit isolated: unavailable");
            }
            // Selection receipts are a separate Host-dispatch authority. A
            // damaged database must close that feature without hiding native
            // chat or reviving a selected operation after Service restart.
            try {
              externalPluginSelectionDispatch.open();
              externalPluginSelectionDispatchOpened = true;
            } catch {
              console.error("[agent-service] external plugin selection isolated: unavailable");
            }
            // A crash can leave ProductStore disabled while the separate
            // plugin transaction has not yet run. Fence it before IPC opens.
            for (const profile of productStore.listAgentProfiles()) {
              if (!profile.enabled) pluginStore.revokeProfileBindings(profile.id);
            }
            // OAuth may have committed a new Microsoft identity just before a
            // crash, leaving old plugin Connections marked ready in the Store.
            // Demote them before any tool-catalog restoration or IPC opens.
            await pluginGraphConnectionController.reconcileStoredAccount();
            pluginMcpConnectionPool.open();
            // The tool catalog is process-local. Restore only this internal,
            // fixed-contract Graph tool after checking a current global
            // Binding and allowed Grant in PluginStore. The encrypted OAuth
            // record alone never publishes a callable tool after restart.
            const graphProfile = productStore.listAgentProfiles().find(profile => profile.enabled);
            if (graphProfile) {
              for (const binding of pluginStore.listGlobalBindings()) {
                const installation = pluginStore.getInstallation(binding.installationId);
                const graphPackageId = installation?.sourceIdentity?.startsWith("bundled:")
                  ? installation.sourceIdentity.slice("bundled:".length) : null;
                if (!binding.enabled || !isGraphSidecar(graphPackageId)
                  || installation.desiredState !== "enabled"
                  || pluginStore.getGrantCountsForBinding(binding.bindingId).allow < 1) continue;
                try {
                  await pluginMcpConsent.discover({ profileId: graphProfile.id,
                    bindingId: binding.bindingId });
                } catch (error) {
                  // A stale Connection, changed package or missing credential
                  // stays unavailable; regular Service startup still succeeds.
                  console.error("[agent-service] Microsoft Graph tool restore unavailable:", error.code || "UNKNOWN");
                }
                assertStartGeneration(generation);
              }
            }
          }
          for (const entry of runtimeExtensions) {
            const runtime = entry.envelope.manifest.runtime, id = `extension-${runtime}`;
            if (!productStore.getRuntimeAccount(id)) productStore.putRuntimeAccount({ id, runtime,
              kind: "shoggoth-managed", installationKind: "system", homeKind: "managed-shared",
              providerRef: null, isDefault: false, createdAt: null, updatedAt: null });
          }
          nativeRuntimeConfig.open();
          nativeMemoryConfig.open();
          try { chatUiConfig.open(); } catch (error) { chatUiController.storageError = error; }
          nativeMemorySharingConfig.open();
          if (memoryProviderOwnerRpc) {
            memoryProviderOwnerGeneration = generation;
            memoryProviderOwnerRpc.open();
          }
          assertStartGeneration(generation);
          // A damaged record only stops built-in Agent creation; recreating an
          // Agent the user deleted would be worse than creating none.
          try { builtinAgentState.open(); }
          catch { console.error("[agent-service] built-in Agent state isolated: unavailable"); }
          if (options.builtinCliProfiles === true && builtinAgentState.opened) {
            ensureBuiltinCliAgentProfiles(productStore, installedBuiltinAccountIds(), builtinAgentState, {
              beforeCreate: beforeCreateBuiltinAgentProfile,
            });
          }
          await reconcileProviderCredentialSecrets({ productStore, secretStore });
          assertStartGeneration(generation);
          // Construct only after the Service created and validated its private
          // state root. The optional factory is trusted Node composition for
          // isolated tests, never an IPC parameter or product configuration.
          const hostResourcesRoot = options.packaged === true
            ? path.join(options.resourcesPath || process.resourcesPath, "external-plugin-host-patches")
            : path.join(__dirname, "..", "..", "resources", "external-plugin-host-patches");
          externalProviderWriterVerifier = (options.externalProviderWriterVerifierFactory || createExternalProviderWriterVerifier)({
            paths, resourcesRoot: hostResourcesRoot,
          });
          if (!externalProviderWriterVerifier || typeof externalProviderWriterVerifier.verify !== "function"
            || typeof externalProviderWriterVerifier.close !== "function") {
            throw serviceError("EXTERNAL_PROVIDER_CREDENTIAL_VERIFIER_INVALID", "受管凭据核验未就绪");
          }
          externalProviderCredentialGeneration = generation;
          externalProviderCredentialRpcOpened = true;
          await externalProviderCredentialRpc.open();
          await openClawAuthProfileCredentialRpc.open();
          assertStartGeneration(generation);
          runtimeSessionOwnershipStoreOpened = true;
          runtimeSessionOwnershipStore.open();
          if (typeof permissionEngine.open === "function") {
            permissionEngine.open(
              productStore.listAgentProfiles().map((profile) => profile.id),
            );
            permissionEngineOpened = true;
          }
          nativeSkillStoreOpened = true;
          await nativeSkillStore.open(
            productStore.listAgentProfiles().map((profile) => profile.id),
          );
          nativeMcpStoreOpened = true;
          nativeMcpStore.open();
          browserUseControllerOpened = true;
          await browserUseController.open();
          if (computerUseController) {
            computerUseControllerOpened = true;
            await computerUseController.open();
          }
          assertStartGeneration(generation);
          agentDefinitionStoreOpened = true;
          await agentDefinitionStore.open();
          if (typeof productStore.listAgentProfiles === "function") {
            for (const profile of productStore.listAgentProfiles()) {
              agentDefinitionStore.ensureProfile({ profileId: profile.id, profileName: profile.name });
            }
          }
          if (typeof toolRegistry.toolsMarkdown === "function"
            && typeof toolRegistry.revision === "string") {
            const toolsContent = toolRegistry.toolsMarkdown();
            for (const profile of productStore.listAgentProfiles()) {
              agentDefinitionStore.writeGeneratedView({
                profileId: profile.id,
                kind: "TOOLS",
                revision: toolRegistry.revision,
                content: toolsContent,
              });
            }
          }
          assertStartGeneration(generation);
          memoryStoreOpened = true;
          await memoryStore.open();
          memoryProvenanceStoreOpened = true;
          await memoryProvenanceStore.open();
          memoryEngineOpened = true;
          const memoryProfiles = productStore.listAgentProfiles();
          if (shoggothMemory) {
            // Read owners must be ready before activating migrated facts.
            chatSessionStoreOpened = true; await chatSessionStore.open();
            inspirationStoreOpened = true; await inspirationStore.open();
            transcriptStoreOpened = true; await transcriptStore.open();
          }
          await memoryEngine.open(memoryProfiles.map((profile) => profile.id));
          contextSnapshotStoreOpened = true;
          await contextSnapshotStore.open();
          assertStartGeneration(generation);
          tokenUsageStoreOpened = true;
          await tokenUsageStore.open();
          assertStartGeneration(generation);
          domainAvailability.kanban = { available: true, reason: null };
          domainAvailability.cron = { available: true, reason: null };
          try {
            nativeKanbanStoreOpened = true;
            await nativeKanbanStore.open();
            // 每个启用 Agent 都需要稳定的原生任务入口；已有任意用户 Board 时保持原样。
            if (!options.nativeKanbanStore) {
              ensureDefaultAgentBoards(productStore, nativeKanbanStore);
            } else {
              // 注入 Store 仍要执行启动健康探针，不能因跳过默认 Board bootstrap
              // 而漏掉 commit-uncertain / corruption。
              nativeKanbanStore.listBoards();
            }
          } catch (error) {
            const healthFailure = sanitizedDomainStartupHealthError("kanban", error);
            if (healthFailure) throw latchStartupFatal(generation, healthFailure);
            nativeKanbanStoreOpened = false;
            try { await nativeKanbanStore.close(); } catch (cleanupError) {
              throw new AggregateError(
                [error, cleanupError],
                "NativeKanbanStore matcher 不可用且清理失败",
              );
            }
            domainAvailability.kanban = {
              available: false,
              reason: "sensitive_check_unavailable",
            };
          }
          assertStartGeneration(generation);
          try {
            nativeCronStoreOpened = true;
            await nativeCronStore.open();
            nativeCronStore.listJobs();
          } catch (error) {
            const healthFailure = sanitizedDomainStartupHealthError("cron", error);
            if (healthFailure) throw latchStartupFatal(generation, healthFailure);
            nativeCronStoreOpened = false;
            try { await nativeCronStore.close(); } catch (cleanupError) {
              throw new AggregateError(
                [error, cleanupError],
                "NativeCronStore matcher 不可用且清理失败",
              );
            }
            domainAvailability.cron = {
              available: false,
              reason: "sensitive_check_unavailable",
            };
          }
          assertStartGeneration(generation);
          providerRuntimeOpened = true;
          await providerRuntimeBridge.open();
          assertStartGeneration(generation);
          if (typeof providerService.open === "function") {
            providerServiceOpened = true;
            await providerService.open();
            assertStartGeneration(generation);
          }
          accountAuthStateOpened = true;
          await accountAuthStateStore.open();
          assertStartGeneration(generation);
          accountAuthManagerOpened = true;
          await accountAuthManager.open();
          assertStartGeneration(generation);
          runtimeAccountServiceControllerOpened = true;
          await runtimeAccountServiceController.open();
          assertStartGeneration(generation);
          profileServiceControllerOpened = true;
          await profileServiceController.open();
          assertStartGeneration(generation);
          agentArchiveRetention?.open();
          agentLifecycleServiceControllerOpened = true;
          await agentLifecycleServiceController.open();
          assertStartGeneration(generation);
          chatSessionStoreOpened = true;
          await chatSessionStore.open();
          // First start with the record: Agents that already have conversations
          // were not just created, so they never receive a first greeting.
          if (builtinAgentState.opened && builtinAgentState.firstRun) {
            try { builtinAgentState.markGreeted([...new Set(chatSessionStore.listSessions().map((session) => session.profileId))]); }
            catch { console.error("[agent-service] built-in Agent greeting record unavailable"); }
          }
          inspirationStoreOpened = true;
          inspirationStore.open();
          proactiveStoreOpened = true;
          proactiveStore.open();
          // 群库打不开（损坏，或由更新版本的 App 写出）只让群聊不可用，不拖垮整个 Service：
          // group.* 返回 GROUP_CHAT_UNAVAILABLE，驱动不启动，库文件保持原样。
          try { groupChatStore.open(); groupChatStoreOpened = true; }
          catch (error) { console.error(`[agent-service] group chat store unavailable: ${error?.code || "UNKNOWN"}`); }
          hookStoreOpened = true;
          hookStore.open();
          hookProcessHost.open(); hookRunner.open();
          await hookProcessHost.recoverWorkers();
          await hookProcessHost.verify();
          hookRunner.recoverObservers();
          assertStartGeneration(generation);
          transcriptStoreOpened = true;
          await transcriptStore.open();
          // UI recovery completes canonical references before queued native work
          // can resume. Card storage failure is isolated from ordinary chat.
          try { chatUiStore.open(); chatUiStoreOpened = true; chatUiController.storageError = null; chatUiController.recover(); }
          catch (error) { chatUiController.storageError = error; chatUiController.revokeAll(); }
          conversationCheckpointStoreOpened = true;
          await conversationCheckpointStore.open();
          sessionRuntimeController.auditPending();
          // Complete a journaled partial purge before domain recovery inspects
          // WorkRun/Card/Session references that may have been removed already.
          if (agentArchiveRetention && typeof agentLifecycleServiceController.runMaintenance === "function") {
            await agentLifecycleServiceController.runMaintenance(() => agentArchiveRetention.sweep({ resumeOnly: true }));
          }
          assertStartGeneration(generation);
          for (const run of workDispatcher.listRuns({ status: "skipped" })) hookService.observeSkippedRun(run);
          for (const session of chatSessionStore.listSessions()) {
            hookService.observeSession(session, "session.created", null);
            if (session.status === "archived") hookService.observeSession(session, "session.closed", null);
            transcriptStore.ensureSession({ profileId: session.profileId, sessionId: session.id });
          }
          // An accepted review receipt can survive a crash before its staged
          // MemoryStore items become active. Recover after session/transcript
          // stores open so every source is verified before promotion.
          if (typeof memoryCandidateService?.recoverProfile === "function") {
            // Startup may have just resumed a journaled archive purge. Do not
            // recreate that removed Profile's candidate directory from the
            // pre-purge list captured for MemoryEngine.open().
            for (const profile of productStore.listAgentProfiles()) {
              try { memoryCandidateService.recoverProfile(profile.id); }
              catch (error) {
                // A broken optional review queue leaves reviewed items hidden.
                // Primary MemoryStore failures still fail service startup.
                if (!["MEMORY_CANDIDATE_UNAVAILABLE", "MEMORY_CANDIDATE_CORRUPT"].includes(error?.code)) {
                  throw error;
                }
              }
            }
          }
          // On first open, session evidence is not yet readable. A Profile
          // with a previously forgotten and then reauthorized fact may have
          // deferred generated-view rebuilding until this point.
          for (const profile of productStore.listAgentProfiles()) {
            if (!memoryEngine.viewStatus(profile.id).stale) continue;
            try { memoryEngine.rebuildViews(profile.id); }
            catch (error) {
              if (error?.code !== "RECALL_POLICY_UNAVAILABLE") throw error;
            }
          }
          assertStartGeneration(generation);
          pendingCommandInboxOpened = true;
          await pendingCommandInbox.open();
          assertStartGeneration(generation);
          // Only an unlocked, matching command plus a private execution record
          // can enter native reconciliation. Legacy/locked active runs retain
          // Product's restricted SERVICE_RESTARTED recovery, which is safe even
          // when the secret matcher is unavailable.
          const recoverableCommandRuns = new Set(pendingCommandInbox.isLocked?.() === true ? []
            : pendingCommandInbox.list().filter((command) => ["pending", "dispatching"].includes(command.state))
              .map((command) => command.runId));
          for (const run of workDispatcher.listRuns()) {
            if (options.workRunCoordinator === undefined
              && ["completed", "failed", "canceled", "interrupted", "skipped"].includes(run.status)) {
              // A crash after the Product terminal but before descriptor cleanup
              // must not retain an encrypted duplicate of the prompt forever.
              runExecutionStore.remove?.(run);
            }
            if (!ACTIVE_WORK_RUN_STATUSES.has(run.status)) continue;
            if (["kanban", "cron", "inspiration"].includes(run.source)) continue;
            if (run.source === "chat" && run.status === "starting") continue;
            if (run.source === "chat" && options.workRunCoordinator === undefined
              && recoverableCommandRuns.has(run.id) && runExecutionStore.has?.(run) === true) continue;
            const recovered = workDispatcher.recoverActiveRunAfterServiceRestart(run.id);
            publishFederationTerminal(recovered, {
              status: recovered.status,
              resultSummary: recovered.resultSummary,
              errorCode: recovered.errorCode,
            });
          }
          assertStartGeneration(generation);
          if (typeof options.onWorkDispatcherReady === "function") {
            options.onWorkDispatcherReady(workDispatcher);
          }
          assertStartGeneration(generation);
          chatServiceControllerOpened = true;
          await chatServiceController.open();
          assertStartGeneration(generation);
          // Runtime recovery may immediately spawn the packaged MCP helper. Publish the
          // private transport first, while ordinary token APIs remain gated by `started`.
          token = writePrivateToken(paths.tokenPath);
          const tokenStat = fs.lstatSync(paths.tokenPath);
          ownedTokenIdentity = { dev: tokenStat.dev, ino: tokenStat.ino };
          const socketStat = rejectSymlink(paths.socketPath);
          if (socketStat) fs.unlinkSync(paths.socketPath);
          server = net.createServer({ allowHalfOpen: true }, acceptSocket);
          await new Promise((resolve, reject) => {
            const onError = (error) => reject(error);
            server.once("error", onError);
            server.listen(paths.socketPath, () => {
              server.off("error", onError);
              // listen 后必须常驻 error listener；否则运行期 accept/socket 错误会升级
              // 为 EventEmitter 的未捕获 "error" 并终止整个 Service 进程。
              server.on("error", (error) => { void reportRuntimeServerError(error); });
              resolve();
            });
          });
          assertStartGeneration(generation);
          fs.chmodSync(paths.socketPath, 0o600);
          const socketStatAfterListen = fs.lstatSync(paths.socketPath);
          ownedSocketIdentity = { dev: socketStatAfterListen.dev, ino: socketStatAfterListen.ino };
          mcpTransportReady = true;
          assertStartGeneration(generation);
          proactiveServiceOpened = true;
          proactiveService.activate();
          workRunCoordinatorOpened = true;
          await workRunCoordinator.open();
          if (!chatUiController.storageError) await chatUiController.recoverOperations();
          if (codexSecurityServiceController) {
            codexSecurityServiceControllerOpened = true;
            codexSecurityServiceController.open();
          }
          workRunCoordinator.recoverCronChatSessions?.();
          workRunCoordinatorReady = true;
          inspirationService.open();
          await proactiveService.open();
          // Resume only user-opted-in profiles. open() independently repeats
          // the consent guard, as do observation, model dispatch and publish.
          if (learningStoreOpened && learningStore.hasEnabledConsent()) learningService.open();
          for (const profile of productStore.listAgentProfiles()) proactiveStore.ensureHeartbeatMonitor(profile.id);
          if (pendingInboxRecoveryNeeded) {
            await recoverUnlockedPendingCommands(generation);
          }
          assertStartGeneration(generation);
          if (domainAvailability.kanban.available) {
            kanbanRunServiceOpened = true;
            await kanbanRunService.open();
            // open 可同步返回但在同一 event-loop turn 发布 background fatal；ready 发布前
            // 留出一个有界观察点，让本代 latch 成为 startup 主错。
            await new Promise((resolve) => setImmediate(resolve));
          }
          assertStartGeneration(generation);
          if (domainAvailability.cron.available) {
            nativeCronSchedulerOpened = true;
            await nativeCronScheduler.open();
            await new Promise((resolve) => setImmediate(resolve));
          }
          proactiveSchedulerOpened = true;
          await proactiveScheduler.open();
          assertStartGeneration(generation);
          if (groupChatStoreOpened) await groupChatDriver.start();
          assertStartGeneration(generation);
          assertStartGeneration(generation);
          startedAt = Date.now();
          assertStartGeneration(generation);
          if (typeof options.onServerReady === "function") options.onServerReady(server);
          assertStartGeneration(generation);
          lifecycleState = "started";
          stallMonitor.start();
          // First-party plugins sync before catalog restore so an update's drain
          // never competes with restored connections. Failures are logged per
          // package and never block startup; restore waits at most 5 seconds.
          firstPartySyncDone = firstPartyPluginSync ? firstPartyPluginSync.sync().then(report => {
            if (report.failed.length) console.error("[agent-service] first-party plugins not synced:", JSON.stringify(report.failed));
            return report;
          }, error => {
            console.error("[agent-service] first-party plugin sync failed:", error?.code || error?.message);
            return null;
          }) : Promise.resolve(null);
          void Promise.race([firstPartySyncDone, new Promise(resolve => setTimeout(resolve, 5_000).unref?.())]).then(() => {
            if (lifecycleState === "started" && lifecycleGeneration === generation) pluginCatalogRestorer?.start();
          });
          // Model validation and indexing run off the launch/admission path.
          void nativeMemorySemanticService.start().catch(() => {});
          memoryCandidateAbortController = new AbortController();
          // Recover terminal callbacks lost at a crash, and page tails that
          // exceeded the previous bounded extraction wake.
          scheduleMemoryCandidateBacklog(15_000);
          codexMemoryImportAbortController = new AbortController();
          scheduleCodexMemoryImport(options.codexMemoryImportDelayMs ?? CODEX_MEMORY_IMPORT_DELAY_MS);
          for (const profile of productStore.listAgentProfiles()) {
            if (profile.enabled) {
              nativeMemorySemanticService.scheduleMemory(profile.id);
              conversationRecallService.scheduleWarm(profile.id);
            }
          }
          if (typeof agentLifecycleServiceController.runMaintenance === "function") {
            agentArchiveRetention?.start(
              (action) => agentLifecycleServiceController.runMaintenance(action),
              (error) => {
                if (agentArchiveRetention.poisoned || error?.committedUncertain
                  || /COMMIT_UNCERTAIN/u.test(error?.code || "")) {
                  void reportRuntimeServerError(error);
                } else {
                  console.error("[agent-service] archived Agent cleanup deferred; will retry");
                }
              },
            );
          }
          // Unlock can land after the earlier startup recovery check but before
          // this state transition. Once `started` is visible, check the durable
          // flag again; later unlocks are handled directly by the callback.
          if (pendingInboxRecoveryNeeded) {
            void recoverUnlockedPendingCommands(generation).catch((error) => (
              reportRuntimeServerError(error)
            ));
          }
          if (options.prewarmMcpAuth === true) {
            // 正式 App 首次打开后异步初始化后台凭据。crypto worker 与 Service
            // 事件循环隔离，因此系统钥匙串等待不会阻断 status/只读页面；失败
            // 仍由本 generation 的 sticky latch 保证只弹一次。
            setImmediate(() => {
              if (mcpAuthGenerationIsActive(generation)) {
                void Promise.resolve(ensureMcpSessionManager()).catch(() => {});
              }
            });
          }
          return api;
        } catch (error) {
          if (lifecycleGeneration !== generation || lifecycleState !== "starting") {
            throw serviceError("SERVICE_START_CANCELED", "Service 启动已被停止请求取消");
          }
          const latchedStartupFatal = startupFatal?.generation === generation
            && startupFatal.error === error;
          lifecycleState = "stopping";
          lifecycleGeneration += 1;
          const cleanupPromise = cleanupService({ notify: false });
          stopping = cleanupPromise;
          try {
            await cleanupPromise;
            if (stopping === cleanupPromise) {
              stopping = null;
              lifecycleState = "stopped";
            }
          } catch (cleanupError) {
            lifecycleState = "stop_failed";
            // Startup background fatal 已是冻结、脱敏的本代主错。cleanup 仍完整执行，
            // 但其任意失败不得把 commit-uncertain/corrupt 语义或私密细节覆盖掉。
            if (latchedStartupFatal) throw error;
            const combined = new AggregateError(
              [error, ...(cleanupError.errors || [cleanupError])],
              "Service 启动失败且清理不完整",
            );
            combined.code = "SERVICE_START_FAILED";
            throw combined;
          }
          throw error;
        }
      });
      startPromise = currentStart;
      void currentStart.then(
        () => { if (startPromise === currentStart) startPromise = null; },
        () => { if (startPromise === currentStart) startPromise = null; },
      );
      return currentStart;
    },

    stop(stopOptions = {}) {
      if (lifecycleState === "stopping" || lifecycleState === "stop_failed") return stopping;
      const ownsInstance = server !== null || lockFd !== null
        || ownedSocketIdentity !== null || ownedLockIdentity !== null || storeOpened
        || pluginStoreOpened || externalPluginProvenanceOpened || externalPluginSelectionDispatchOpened
        || bridgeSockets.size > 0
        || secretStoreOpened || externalProviderCredentialRpcOpened || externalProviderWriterVerifier || memoryProviderOwnerRpc?.opened
        || mcpCryptoBrokerOpened || mcpSessionManager
        || providerRuntimeOpened || providerServiceOpened || accountAuthStateOpened
        || accountAuthManagerOpened
        || runtimeAccountServiceControllerOpened || profileServiceControllerOpened
        || agentLifecycleServiceControllerOpened
        || chatSessionStoreOpened || inspirationStoreOpened || hookStoreOpened || proactiveStoreOpened || proactiveServiceOpened || proactiveSchedulerOpened || learningStoreOpened || agentDefinitionStoreOpened || transcriptStoreOpened
        || memoryStoreOpened || memoryEngineOpened || permissionEngineOpened
        || nativeSkillStoreOpened
        || computerUseControllerOpened
        || contextSnapshotStoreOpened
        || pendingCommandInboxOpened
        || chatServiceControllerOpened || workRunCoordinatorOpened
        || nativeKanbanStoreOpened || kanbanRunServiceOpened
        || nativeCronStoreOpened || nativeCronSchedulerOpened;
      if (lifecycleState === "stopped" && !ownsInstance) return Promise.resolve();
      const pendingStart = lifecycleState === "starting" ? startPromise : null;
      lifecycleState = "stopping";
      lifecycleGeneration += 1;
      activeDomainControllerOwnerToken = null;
      activeMcpProductToolControllerOwnerToken = null;
      const currentStop = (async () => {
        if (pendingStart) await pendingStart.catch(() => {});
        await cleanupService(stopOptions);
      })();
      stopping = currentStop;
      void currentStop.then(
        () => {
          if (stopping !== currentStop) return;
          stopping = null;
          lifecycleState = "stopped";
        },
        () => {
          if (stopping === currentStop) lifecycleState = "stop_failed";
        },
      );
      return currentStop;
    },
  };

  function assertStartGeneration(generation) {
    if (lifecycleState !== "starting" || lifecycleGeneration !== generation) {
      throw serviceError("SERVICE_START_CANCELED", "Service 启动已被停止请求取消");
    }
    if (startupFatal?.generation === generation) throw startupFatal.error;
  }

  async function cleanupService(stopOptions = {}) {
    stallMonitor.stop();
    chatUiController.stopLifecycle();
    const errors = [];
    // Withdraw catalog admission now; join its actual tail after the memory
    // engine's provider shutdown, and before closing the credential store.
    memoryProviderOwnerGeneration = null;
    const memoryProviderOwnerClosing = memoryProviderOwnerRpc?.close() || Promise.resolve();
    memoryProviderOwnerClosing.catch(() => {});
    // Close publication authority before waiting for network/Runtime shutdown.
    try { await learningService.close(); } catch (error) { errors.push(error); }
    if (proactiveSchedulerOpened) { proactiveSchedulerOpened = false; try { await proactiveScheduler.close(); } catch (error) { errors.push(error); } }
    groupChatDriver.stop();
    groupNativeToolPreparation.stop();
    if (proactiveServiceOpened) { proactiveServiceOpened = false; try { await proactiveService.close(); } catch (error) { errors.push(error); } }
    try { await proactiveScheduler.waitForIdle(); } catch (error) { errors.push(error); }
    pluginCatalogRestorer?.stop();
    if (memoryCandidateBacklogTimer) clearTimeout(memoryCandidateBacklogTimer);
    memoryCandidateBacklogTimer = null;
    for (const timer of memoryConsolidationTimers.values()) clearTimeout(timer);
    memoryConsolidationTimers.clear();
    if (codexMemoryImportTimer) clearTimeout(codexMemoryImportTimer);
    codexMemoryImportTimer = null;
    codexMemoryImportAbortController?.abort();
    codexMemoryImportAbortController = null;
    memoryCandidateAbortController?.abort();
    memoryCandidateAbortController = null;
    if (agentArchiveRetention?.opened) {
      try { await agentArchiveRetention.close(); } catch (error) { errors.push(error); }
    }
    mcpTransportReady = false;
    token = null;
    externalProviderCredentialGeneration = null;
    if (externalProviderCredentialRpcOpened) {
      externalProviderCredentialRpcOpened = false;
      try { await externalProviderCredentialRpc.close(); } catch (error) { errors.push(error); }
      try { await openClawAuthProfileCredentialRpc.close(); } catch (error) { errors.push(error); }
    }
    const retiredWriterVerifier = externalProviderWriterVerifier;
    externalProviderWriterVerifier = null;
    if (retiredWriterVerifier) {
      try { await retiredWriterVerifier.close(); } catch (error) { errors.push(error); }
    }
    const activeServer = server;
    server = null;
    let closePromise = Promise.resolve();
    if (activeServer) {
      closePromise = new Promise((resolve) => {
        try {
          activeServer.close((error) => {
            if (error) errors.push(error);
            resolve();
          });
        } catch (error) {
          errors.push(error);
          resolve();
        }
      });
    }
    // MCP bridge 是长连接，不进入普通 one-request drain。先撤销其内存 session
    // 并断开 socket，避免 server.close 等到 MCP client 自行 EOF。
    for (const [socket, bridge] of bridgeSockets) {
      try { bridge.close(); } catch (error) { errors.push(error); }
      try { socket.destroy(); } catch (error) { errors.push(error); }
    }
    bridgeSockets.clear();
    // Connections without a dispatched request have nothing to drain and must
    // not hold shutdown open until their frame timer expires.
    for (const socket of sockets) {
      if (inFlightSockets.has(socket)) continue;
      try { socket.destroy(); } catch (error) { errors.push(error); }
    }
    // Stop accepting first, then give already-dispatched requests one bounded
    // drain window to flush their single JSONL response. Idle/blocked clients
    // are still force-closed when the same close deadline expires.
    let closeTimer = null;
    try {
      await Promise.race([
        closePromise,
        new Promise((_, reject) => {
          closeTimer = setTimeout(() => {
            reject(serviceError("SERVICE_CLOSE_TIMEOUT", "Service server.close 超时"));
          }, closeTimeoutMs);
        }),
      ]);
    } catch (error) {
      errors.push(error);
    } finally {
      if (closeTimer) clearTimeout(closeTimer);
    }
    for (const socket of sockets) {
      try { socket.destroy(); } catch (error) { errors.push(error); }
    }
    sockets.clear();
    inFlightSockets.clear();
    // 先封住周期触发与 Kanban 接管，再关闭 Coordinator；否则 stop 期间可能把新 Run
    // 送进已开始拆除的 Host 生命周期。
    if (nativeCronSchedulerOpened) {
      nativeCronSchedulerOpened = false;
      try { await nativeCronScheduler.close(); } catch (error) { errors.push(error); }
    }
    if (kanbanRunServiceOpened) {
      kanbanRunServiceOpened = false;
      try { await kanbanRunService.close(); } catch (error) { errors.push(error); }
    }
    inspirationService.close();
    if (!options.nativeDomainServiceController) defaultDomainControllerRetired = true;
    activeDomainControllerOwnerToken = null;
    if (!options.mcpProductToolController) defaultMcpProductToolControllerRetired = true;
    activeMcpProductToolControllerOwnerToken = null;
    if (runtimeAccountServiceControllerOpened) {
      runtimeAccountServiceControllerOpened = false;
      try { await runtimeAccountServiceController.close(); } catch (error) { errors.push(error); }
    }
    if (profileServiceControllerOpened) {
      profileServiceControllerOpened = false;
      try { await profileServiceController.close(); } catch (error) { errors.push(error); }
    }
    if (agentLifecycleServiceControllerOpened) {
      agentLifecycleServiceControllerOpened = false;
      try { await agentLifecycleServiceController.close(); } catch (error) { errors.push(error); }
    }
    if (codexSecurityServiceControllerOpened) {
      codexSecurityServiceControllerOpened = false;
      try { codexSecurityServiceController.close(); } catch (error) { errors.push(error); }
    }
    if (accountAuthManagerOpened) {
      accountAuthManagerOpened = false;
      try { await accountAuthManager.close(); } catch (error) { errors.push(error); }
    }
    if (providerServiceOpened) {
      providerServiceOpened = false;
      try { await providerService.close(); } catch (error) { errors.push(error); }
    }
    if (chatServiceControllerOpened) {
      chatServiceControllerOpened = false;
      try { await chatServiceController.close(); } catch (error) { errors.push(error); }
      if (!options.chatServiceController) defaultControllerRetired = true;
    }
    if (workRunCoordinatorOpened) {
      workRunCoordinatorReady = false;
      pendingInboxRecoveryNeeded = false;
      pendingInboxRecovery = null;
      workRunCoordinatorOpened = false;
      try { await workRunCoordinator.close(); } catch (error) { errors.push(error); }
      if (!options.workRunCoordinator) defaultCoordinatorRetired = true;
    }
    try { await workspaceExecutionService.close(); } catch (error) { errors.push(error); }
    if (mcpSessionManager) {
      const activeMcpSessionManager = mcpSessionManager;
      mcpSessionManager = null;
      try { await activeMcpSessionManager.close(); } catch (error) { errors.push(error); }
    }
    federationMcpSessionManager.reset();
    groupAdapterChannel.reset();
    // 正在进行的密钥库调用不能跨 lifecycle generation 发布 manager；不在 stop
    // 中等待它，避免 MCP 密钥库卡住拖死普通 Service 关闭/重启。
    mcpAuthInitAttempt = null;
    mcpAuthFailureGeneration = null;
    if (mcpCryptoBrokerOpened) {
      mcpCryptoBrokerOpened = false;
      try { await mcpCryptoBroker.close(); } catch (error) { errors.push(error); }
    }
    try {
      await runtimeManager.stopAll();
    } catch (error) {
      if (error?.code === "RUNTIME_ADAPTER_REGISTRY_STOP_FAILED" && Array.isArray(error.errors)) {
        errors.push(...error.errors);
      } else {
        errors.push(error);
      }
    }
    if (runtimeMcpGateIssuerOpened) {
      runtimeMcpGateIssuerOpened = false;
      try { await runtimeMcpGateIssuer.close(); } catch (error) { errors.push(error); }
    }
    if (accountAuthStateOpened) {
      accountAuthStateOpened = false;
      try { await accountAuthStateStore.close(); } catch (error) { errors.push(error); }
    }
    if (runtimeSessionOwnershipStoreOpened) {
      runtimeSessionOwnershipStoreOpened = false;
      try { await runtimeSessionOwnershipStore.close(); } catch (error) { errors.push(error); }
    }
    if (providerRuntimeOpened) {
      providerRuntimeOpened = false;
      try { await providerRuntimeBridge.close(); } catch (error) { errors.push(error); }
    }
    if (pendingCommandInboxOpened) {
      pendingCommandInboxOpened = false;
      try { await pendingCommandInbox.close(); } catch (error) { errors.push(error); }
    }
    if (inspirationStoreOpened) {
      inspirationStoreOpened = false;
      try { inspirationStore.close(); } catch (error) { errors.push(error); }
    }
    if (hookStoreOpened) {
      try {
        await hookRunner.close();
        hookService.nativeTools?.clear(); hookService.preparedNative?.clear();
        hookWorkspaceWriters.close(); hookStore.close(); hookStoreOpened = false;
      } catch (error) { errors.push(error); }
    }
    if (proactiveStoreOpened) { proactiveStoreOpened = false; try { proactiveStore.close(); } catch (error) { errors.push(error); } }
    unsubscribeLearningUsage?.(); unsubscribeLearningUsage = null;
    if (learningStoreOpened) { learningStoreOpened = false; try { learningStore.close(); } catch (error) { errors.push(error); } }
    if (groupChatStoreOpened) { groupChatStoreOpened = false; try { groupChatStore.close(); } catch (error) { errors.push(error); } }
    try { conversationRecallService.close(); } catch (error) { errors.push(error); }
    try { await nativeMemorySemanticService.close(); } catch (error) { errors.push(error); }
    if (memoryProvenanceStoreOpened) {
      memoryProvenanceStoreOpened = false;
      try { memoryProvenanceStore.close(); } catch (error) { errors.push(error); }
    }
    if (conversationCheckpointStoreOpened) {
      conversationCheckpointStoreOpened = false;
      try { await conversationCheckpointStore.close(); } catch (error) { errors.push(error); }
    }
    await chatUiController.close();
    if (chatUiStoreOpened) {
      chatUiStoreOpened = false;
      try { chatUiStore.close(); } catch (error) { errors.push(error); }
    }
    if (chatSessionStoreOpened) {
      if (transcriptStoreOpened) {
        transcriptStoreOpened = false;
        try { await transcriptStore.close(); } catch (error) { errors.push(error); }
      }
      chatSessionStoreOpened = false;
      try { await chatSessionStore.close(); } catch (error) { errors.push(error); }
    }
    if (transcriptStoreOpened) {
      transcriptStoreOpened = false;
      try { await transcriptStore.close(); } catch (error) { errors.push(error); }
    }
    if (agentDefinitionStoreOpened) {
      if (memoryEngineOpened) {
        memoryEngineOpened = false;
        try { await memoryEngine.close(); } catch (error) { errors.push(error); }
      }
      if (memoryStoreOpened) {
        memoryStoreOpened = false;
        try { await memoryStore.close(); } catch (error) { errors.push(error); }
      }
      agentDefinitionStoreOpened = false;
      try { await agentDefinitionStore.close(); } catch (error) { errors.push(error); }
    }
    if (memoryEngineOpened) {
      memoryEngineOpened = false;
      try { await memoryEngine.close(); } catch (error) { errors.push(error); }
    }
    if (memoryStoreOpened) {
      memoryStoreOpened = false;
      try { await memoryStore.close(); } catch (error) { errors.push(error); }
    }
    // Catalog cleanup may still require the Product Profile catalog while it
    // joins an admitted mutation or uncertain provider retirement. Keep that
    // authority and SecretStore alive until its physical close has completed.
    try { await memoryProviderOwnerClosing; } catch (error) { errors.push(error); }
    if (contextSnapshotStoreOpened) {
      contextSnapshotStoreOpened = false;
      try { await contextSnapshotStore.close(); } catch (error) { errors.push(error); }
    }
    if (nativeCronStoreOpened) {
      nativeCronStoreOpened = false;
      try { await nativeCronStore.close(); } catch (error) { errors.push(error); }
    }
    if (nativeKanbanStoreOpened) {
      nativeKanbanStoreOpened = false;
      try { await nativeKanbanStore.close(); } catch (error) { errors.push(error); }
    }
    if (pluginMcpConnectionPool) {
      try { await pluginPackageInstaller?.remoteGitFetcher?.close(); } catch (error) { errors.push(error); }
      pluginDependencyController?.clear();
      pluginRollbackController?.clear();
      pluginConnectionController?.clear();
      pluginBearerController?.clear();
      try { await pluginOAuthController?.close(); } catch (error) { errors.push(error); }
      pluginGraphConnectionController?.clear();
      pluginGmailController?.close();
      try { await outlookCalendarGraph?.close(); } catch (error) { errors.push(error); }
      pluginMcpConsent?.clear();
      pluginAppController?.clear();
      pluginRuntimeToolService?.clear();
      externalPluginToolService?.clear();
      externalPluginApprovalBroker?.clear();
      pluginMcpConnectionManager?.clear();
      try { await pluginMcpConnectionPool.close(); } catch (error) { errors.push(error); }
    }
    if (pluginCapabilityDispatcher) {
      try { pluginCapabilityDispatcher.clear(); } catch (error) { errors.push(error); }
      try { pluginToolCatalogRegistry.clear(); } catch (error) { errors.push(error); }
    }
    if (permissionEngineOpened) {
      permissionEngineOpened = false;
      try { await permissionEngine.close(); } catch (error) {
        errors.push(error);
      }
    }
    if (nativeSkillStoreOpened) {
      nativeSkillStoreOpened = false;
      try { await nativeSkillStore.close(); } catch (error) { errors.push(error); }
    }
    try { await nativeMcpClientManager.close(); } catch (error) { errors.push(error); }
    if (browserUseControllerOpened) {
      browserUseControllerOpened = false;
      try { await browserUseController.close(); } catch (error) { errors.push(error); }
    }
    if (nativeMcpStoreOpened) {
      nativeMcpStoreOpened = false;
      try { await nativeMcpStore.close(); } catch (error) { errors.push(error); }
    }
    if (computerUseControllerOpened) {
      computerUseControllerOpened = false;
      try { await computerUseController.close(); } catch (error) { errors.push(error); }
    }
    if (pluginStoreOpened) {
      if (externalPluginSelectionDispatchOpened) {
        externalPluginSelectionDispatchOpened = false;
        try { externalPluginSelectionDispatch.close(); } catch (error) { errors.push(error); }
      }
      if (externalPluginProvenanceOpened) {
        externalPluginProvenanceOpened = false;
        try { externalPluginProvenance.close(); } catch (error) { errors.push(error); }
      }
      pluginStoreOpened = false;
      try { pluginStore.close(); } catch (error) { errors.push(error); }
    }
    if (storeOpened) {
      if (tokenUsageStoreOpened) {
        tokenUsageStoreOpened = false;
        try { await tokenUsageStore.close(); } catch (error) { errors.push(error); }
      }
      storeOpened = false;
      try { automationWorkRunStore.close(); } catch (error) { errors.push(error); }
      try { productStore.close(); } catch (error) { errors.push(error); }
    }
    try { await webSettings.close(); } catch (error) { errors.push(error); }
    if (secretStoreOpened) {
      secretStoreOpened = false;
      try { await secretStore.close(); } catch (error) { errors.push(error); }
    }
    try {
      const tokenStat = cleanupLstatIfExists(paths.tokenPath);
      if (tokenStat && ownedTokenIdentity
        && tokenStat.dev === ownedTokenIdentity.dev && tokenStat.ino === ownedTokenIdentity.ino) {
        cleanupFs.unlinkSync(paths.tokenPath);
      }
    } catch (error) {
      errors.push(error);
    }
    ownedTokenIdentity = null;
    try {
      const socketStat = cleanupLstatIfExists(paths.socketPath);
      if (socketStat && ownedSocketIdentity
        && socketStat.dev === ownedSocketIdentity.dev && socketStat.ino === ownedSocketIdentity.ino) {
        cleanupFs.unlinkSync(paths.socketPath);
      }
    } catch (error) {
      errors.push(error);
    }
    ownedSocketIdentity = null;
    if (lockFd !== null) {
      const ownedFd = lockFd;
      lockFd = null;
      try { cleanupFs.closeSync(ownedFd); } catch (error) { errors.push(error); }
      try {
        const lockStat = cleanupLstatIfExists(paths.lockPath);
        if (lockStat && ownedLockIdentity
          && lockStat.dev === ownedLockIdentity.dev && lockStat.ino === ownedLockIdentity.ino) {
          cleanupFs.unlinkSync(paths.lockPath);
        }
      } catch (error) {
        errors.push(error);
      }
    }
    ownedLockIdentity = null;
    if (stopOptions.notify !== false && typeof options.onStop === "function") {
      try { await options.onStop(); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) {
      const aggregate = new AggregateError(errors, "Service stop 未能完整清理");
      aggregate.code = "SERVICE_STOP_FAILED";
      throw aggregate;
    }
  }

  return api;
}

module.exports = {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  attachAcceptedSocketErrorGuard,
  candidateSessionForCompletedRun,
  createAgentService,
};
