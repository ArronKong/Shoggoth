"use strict";
const { isImplicitChatWorkspace } = require("../agent-service/chat-workspace");
const { claimsNativeAgentId,
  isNativeBindingDisabled } = require("../agent-service/native-backend-identity");
const { isRuntimeAvailable } = require("../runtime-availability");

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { AgentBackend } = require("./agent-backend");
const { validateCustomEndpointResult } = require("../agent-service/custom-endpoint-protocol");
const { inspirationExecutionToActivity } = require("./dashboard-activity");
const {
  normalizeInteractiveRequestV1,
  validateInteractiveResponseV1,
  validInteractiveApprovalChoice,
} = require("./shoggoth-interaction-contract");
const { requestService, readClientToken } = require("../agent-service/client");
const { resolveServicePaths } = require("../agent-service/paths");
const { SERVICE_PROTOCOL_VERSION } = require("../agent-service/service-protocol-version");
const {
  NATIVE_RUNTIME_CONFIG_METHODS, NATIVE_RUNTIME_CONFIG_PUBLIC_MESSAGES,
  validateNativeRuntimeConfigProjection, validateNativeRuntimeConfigResult,
} = require("../agent-service/native-runtime-config-protocol");
const { AGENT_BINDING_METHODS, AGENT_BINDING_PUBLIC_MESSAGES, validateAgentBindingParams,
  validateAgentBindingResult } = require("../agent-service/agent-runtime-binding-protocol");
const { SESSION_RUNTIME_METHODS, SESSION_RUNTIME_PUBLIC_MESSAGES, validateSessionRuntimeParams,
  validateSessionRuntimeResult } = require("../agent-service/session-runtime-protocol");
const { INSPIRATION_SERVICE_METHODS, PUBLIC_MESSAGES: INSPIRATION_PUBLIC_MESSAGES,
  validateInspirationServiceResult } = require("../agent-service/inspiration-service-protocol");
const { deriveSessionTitle } = require("../agent-service/session-display-projection");
const { CHAT_MAX_PROMPT_BYTES, CHAT_ATTACHMENT_CAPABILITIES, uploadChatAttachments,
  explicitPathAttachment } = require("../agent-service/chat-attachments");
const {
  MAX_ITEM_BYTES,
  MAX_PAGE_LIMIT,
  PUBLIC_MESSAGES: CHAT_PUBLIC_MESSAGES,
  validateChatServiceResult,
} = require("../agent-service/chat-service-protocol");
const {
  PROFILE_SERVICE_METHODS,
  PUBLIC_MESSAGES: PROFILE_PUBLIC_MESSAGES,
  validateProfileServiceResult,
} = require("../agent-service/profile-service-protocol");
const {
  AGENT_LIFECYCLE_METHODS,
  PUBLIC_MESSAGES: AGENT_LIFECYCLE_PUBLIC_MESSAGES,
  validateAgentLifecycleResult,
} = require("../agent-service/agent-lifecycle-service-protocol");
const { DEFAULT_AGENT_PROFILE_ID } = require("../agent-service/product-store");
const { DEFAULT_RUNTIME_ACCOUNTS } = require("../agent-service/runtime-account");
const { BUILTIN_CLI_AGENT_PROFILES } = require("../agent-service/builtin-cli-profiles");
const {
  defaultRuntimePermissionMode,
  runtimePermissionModeOptions,
} = require("../agent-service/runtime-permission-modes");
const {
  AGENT_HARNESS_METHODS,
  PUBLIC_MESSAGES: AGENT_HARNESS_PUBLIC_MESSAGES,
  validateAgentHarnessResult,
} = require("../agent-service/agent-harness-service-protocol");
const {
  DOMAIN_SERVICE_METHODS,
  MAX_CONTENT_READ_BYTES,
  PUBLIC_MESSAGES: DOMAIN_PUBLIC_MESSAGES,
  validateDomainServiceResult,
} = require("../agent-service/domain-service-protocol");
const {
  validateUsageBreakdown,
  validateUsageRange,
  validateUsageSeries,
} = require("../agent-service/token-usage-protocol");
const { collectSessionOutputArtifacts } = require("./session-output-artifacts");
const { validatePluginManagementResult } = require("./plugin-management-dto");
const { validatePluginAppResult } = require("./plugin-app-dto");

const SERVICE_TIMEOUT_MS = 5_000;
const ENCRYPTED_MUTATION_TIMEOUT_MS = 15_000;
const RUNTIME_COMMAND_TIMEOUT_MS = 45_000;
const MODEL_CATALOG_TIMEOUT_MS = 45_000;
const PLUGIN_INSTALL_TIMEOUT_MS = 30_000;
const DEFAULT_READINESS_TIMEOUT_MS = 70_000;
const DEFAULT_READINESS_INTERVAL_MS = 500;
const DEFAULT_SERVICE_STATUS_TIMEOUT_MS = 1_000;
const DEFAULT_READINESS_MAX_ATTEMPTS = 140;
const ENCRYPTED_MUTATION_METHODS = new Set([
  "provider.endpoints.save", "provider.endpoints.delete", "provider.endpoints.discover",
  "chat.send",
  "chat.abort",
  "chat.steer",
  "run.approval.respond",
  "run.input.respond",
  "agent.create",
  "agent.update",
  "agent.archive",
  "agent.restore",
]);
const RUNTIME_COMMAND_METHODS = new Set(["chat.command.list", "chat.command.exec"]);
const NATIVE_SLASH_RUNTIMES = new Set(["codex", "claude-code", "grok-build", "pi", "antigravity", "deepseek-harness"]);
const NATIVE_STEER_RUNTIMES = new Set(["codex", "claude-code", "pi", "deepseek-harness"]);
// 1 MiB of JSON-escaped control text can require ~130 protocol-sized frames;
// 256 remains finite while covering both that case and 8,192 ordinary page items.
const DEFAULT_MAX_PAGES = 256;
const DEFAULT_POLL_INTERVAL_MS = 120;
const DEFAULT_MAX_POLL_ERRORS = 5;
const DEFAULT_SERVICE_EVENT_POLL_MS = 500;
const MAX_SERVICE_EVENT_POLL_MS = 5_000;
const MAX_SERVICE_EVENTS = 1_024;
const MAX_PROFILE_SESSION_CONCURRENCY = 4;
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY_ITEMS = 8_192;
const MAX_FRAGMENT_COUNT = 2_048;
const MAX_DOMAIN_AGGREGATE_BYTES = 8 * 1024 * 1024;
const MAX_DOMAIN_AGGREGATE_ITEMS = 8_192;
const MAX_DOMAIN_CONTENT_BYTES = 1024 * 1024;
const MAX_DASHBOARD_EVENT_BYTES = 1024 * 1024;
const MAX_DASHBOARD_EVENT_ITEMS = 1024;
const MAX_MANAGED_CREDENTIAL_FILE_BYTES = 1024 * 1024;
const DOMAIN_SERVICE_METHOD_SET = new Set(DOMAIN_SERVICE_METHODS);
const INSPIRATION_SERVICE_METHOD_SET = new Set(INSPIRATION_SERVICE_METHODS);
const PROFILE_SERVICE_METHOD_SET = new Set(PROFILE_SERVICE_METHODS);
const AGENT_LIFECYCLE_METHOD_SET = new Set(AGENT_LIFECYCLE_METHODS);
const AGENT_HARNESS_METHOD_SET = new Set(AGENT_HARNESS_METHODS);
const NATIVE_CARD_STATUSES = Object.freeze([
  "triage", "backlog", "queued", "running", "review", "waiting", "done", "failed", "canceled",
]);
const NATIVE_COLUMN_NAMES = Object.freeze({
  triage: "Triage",
  backlog: "Backlog",
  queued: "Queued",
  running: "Running",
  review: "Review",
  waiting: "Waiting",
  done: "Done",
  failed: "Failed",
  canceled: "Canceled",
});
const NATIVE_STATUS_TRANSITIONS = Object.freeze({
  triage: new Set(["backlog", "canceled"]),
  backlog: new Set(["triage", "queued", "canceled"]),
  queued: new Set(["backlog", "running", "waiting", "failed", "canceled"]),
  running: new Set(["review", "waiting", "failed", "canceled"]),
  review: new Set(["backlog", "waiting", "failed", "canceled"]),
  waiting: new Set(["queued", "running", "review", "failed", "canceled"]),
  failed: new Set(["queued", "canceled"]),
  canceled: new Set(["queued"]),
  done: new Set(),
});
const ACTIVE_DOMAIN_RUN_STATUSES = new Set([
  "queued", "starting", "running", "waiting_approval", "waiting_input",
]);
const ACTIVE_RUN_STATUSES = new Set([
  "queued", "starting", "running", "waiting_approval", "waiting_input",
]);
const TERMINAL_RUN_STATUSES = new Set([
  "completed", "failed", "canceled", "interrupted", "skipped",
]);
const MCP_TOOL_APPROVAL_CHOICES = new Set(["once", "deny"]);
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
const SAFE_INTERACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const NATIVE_FEDERATION_CHAT_RUN_PATTERN = /^shoggoth:chat-send:federation-(?:send|message)-/u;
const RUN_RECONCILE_STREAM_IDS = Object.freeze([
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
]);
const RUNTIME_START_MESSAGES = Object.freeze({
  RUNTIME_PROTOCOL_ERROR: "CLI 返回的通信数据不符合协议，本次任务已停止；请检查 CLI 与 App 的版本兼容性及原生会话结果",
  RUNTIME_CONNECTION_LOST: "CLI 进程或通信连接异常中断，未自动重放；请检查原生会话结果后决定是否重试",
  CODEX_HOST_TERMINATED: "Codex 运行进程已终止，本次任务未自动重放；请检查原生会话结果后决定是否重试",
  RUNTIME_AUTH_REQUIRED: "当前 Agent 登录验证失败，请前往「设置」检查账号状态或重新登录后重试",
  RUNTIME_PERMISSION_REQUIRED: "当前权限不允许 Agent 执行所需操作，请检查会话的工作区和权限设置后重试",
  RUNTIME_APPROVAL_UNAVAILABLE: "Antigravity 的非交互模式无法弹出原生工具授权，本次操作已被拒绝；请检查权限设置，调整后可在当前会话重新发送",
  ANTIGRAVITY_ONBOARDING_REQUIRED: "请先在 Antigravity CLI 中完成首次登录引导，再回到当前会话重试",
  ANTIGRAVITY_NETWORK_UNAVAILABLE: "Antigravity 网络检查失败，本次消息未发送；请检查代理与 Google 服务的连接后重试",
  ANTIGRAVITY_REGION_UNSUPPORTED: "Antigravity 服务不支持当前账号的访问地区，本次消息未发送；请检查服务可用地区后重试",
  ANTIGRAVITY_ELIGIBILITY_FAILED: "Antigravity 账号可用性检查未通过，本次消息未发送；请在原生 CLI 中查看账号状态后重试",
  ANTIGRAVITY_STARTUP_TIMEOUT: "Antigravity 启动或登录检查超时，本次消息未发送；请检查网络和 CLI 登录状态后重试",
  ANTIGRAVITY_APPROVAL_FORMAT_UNSUPPORTED: "暂时无法识别 Antigravity 的原生授权界面，本次操作已停止；请检查 CLI 与 Shoggoth 的版本兼容性",
  ANTIGRAVITY_APPROVAL_CHANGED: "Antigravity 的原生授权请求已变化，旧选择未被应用；请在当前会话重新发送",
  ANTIGRAVITY_APPROVAL_TIMEOUT: "等待 Antigravity 授权选择已超时，本次任务已停止，迟到的选择不会应用",
  ANTIGRAVITY_APPROVAL_RESPONSE_UNCONFIRMED: "Antigravity 尚未确认授权选择，任务已停止；无法确定工具是否执行，请检查原生会话结果后决定是否重试",
  RUNTIME_QUOTA_EXHAUSTED: "当前账号额度已用尽，本次请求已停止，不会继续排队。请等待额度恢复、补充额度或更换账号后重试",
  RUNTIME_RATE_LIMITED: "模型服务限流，本次回复未完成。请稍后重试，或更换模型",
  RUNTIME_SPENDING_LIMIT_REACHED: "当前账号已达到消费上限，本次请求已停止，不会继续排队。请检查服务商的消费上限设置，恢复后重试",
  RUNTIME_ACCOUNT_BLOCKED: "模型服务商返回账号受限（account blocked），请前往服务商检查账号状态；解除限制或更换可用账号后重试",
  RUNTIME_UPSTREAM_UNAVAILABLE: "Agent 上游服务暂时不可用，请稍后重试",
  RUNTIME_SESSION_BUSY: "此原生会话仍有任务在执行，请等待任务结束或取消后再发送",
  RUNTIME_SESSION_ACCEPTANCE_UNKNOWN: "未能确认原生会话是否创建成功，已暂停自动重试以避免重复创建；请先检查 CLI 的会话记录",
  RUNTIME_TURN_ACCEPTANCE_UNKNOWN: "未能确认 CLI 是否已接受本次任务，已暂停自动重试以避免重复执行；请先检查原生会话的执行结果",
  RUNTIME_SESSION_RECOVERY_HISTORY_REQUIRED: "原生会话历史不足以确认任务执行状态，已暂停恢复以避免重复执行",
  RUNTIME_MODEL_CATALOG_UNAVAILABLE: "暂时无法读取当前账号的模型列表，请检查 CLI 登录和网络后重试",
  RUNTIME_MODEL_CATALOG_INVALID: "CLI 返回的模型列表无法识别，请检查 CLI 与 App 的版本兼容性",
  RUNTIME_MODEL_UNAVAILABLE: "当前账号无法使用所选模型，请检查登录状态或选择可用模型",
  GROK_ACP_OUTBOUND_FRAME_TOO_LARGE: "消息或附件超过 Grok CLI 的传输大小限制，本次消息未发送；请缩小附件或减少内容后重试",
  GROK_ACP_REQUEST_TIMEOUT: "Grok CLI 响应超时，未自动重放；请检查原生会话结果后决定是否重试",
  GROK_ACP_WRITE_FAILED: "写入 Grok CLI 时连接中断，尚无法确认完整执行结果；请检查原生会话记录",
  GROK_ACP_STDIN_CLOSED: "Grok CLI 通信通道已关闭，未自动重放；请检查 CLI 状态和原生会话结果",
  RUNTIME_REQUEST_NOT_SENT: "本次请求在发送前已停止；确认未发送，可以在当前会话重新提交",
  PI_TURN_TIMEOUT: "Pi 本次任务执行超时，未自动重放；请检查原生会话结果后决定是否重试",
  PI_PROCESS_CLOSED: "Pi 进程在任务完成前退出，未自动重放；请检查 CLI 状态和原生会话结果",
  PI_RPC_STARTUP_TIMEOUT: "Pi 通信初始化超时，请检查 CLI 安装与登录状态后重试",
  DEEPSEEK_HARNESS_REQUEST_TIMEOUT: "DeepSeek 通信超时，未自动重放；请检查原生会话结果后决定是否重试",
  DEEPSEEK_HARNESS_STARTUP_TIMEOUT: "DeepSeek 初始化超时，请检查 CLI 安装与登录状态后重试",
  DEEPSEEK_HARNESS_PROCESS_CLOSED: "DeepSeek 进程在任务完成前退出，未自动重放；请检查原生会话结果",
  ANTIGRAVITY_TURN_TIMEOUT: "Antigravity 本次任务执行超时，未自动重放；请检查原生会话结果后决定是否重试",
  OPENCODE_TURN_TIMEOUT: "OpenCode 本次任务执行超时，已通知 CLI 停止；未自动重放，请检查会话结果后决定是否重试",
  CODEX_TERMINAL_RECONCILIATION_FAILED: "未能从原生 CLI 读取本次任务的最终结果，已停止等待；未自动重放，请先检查原生会话记录，避免重复执行",
  ANTIGRAVITY_PROCESS_EXIT_INVALID: "Antigravity 进程异常退出，未自动重放；请检查 CLI 状态和原生会话结果",
  RUNTIME_TURN_INTERRUPTED: "Agent 本次任务已中断，尚无法确认完整执行结果；请检查会话记录后决定是否重试",
  EXECUTION_BINDING_UNAVAILABLE: "无法安全保存任务的恢复记录，本次任务尚未发送；请检查本地存储后重试",
  EXECUTION_CONTRACT_LOST: "缺少原任务的完整执行记录，无法安全恢复；请检查原生会话结果后决定是否重试",
  RUNTIME_RECOVERY_UNAVAILABLE: "Service 重启后无法确认原任务的完整结果或恢复执行绑定，已停止自动恢复；请检查原生会话结果后决定是否重试",
  CODEX_SYSTEM_BINARY_NOT_FOUND: "未找到可执行的本机 Codex CLI，请先安装 Codex 并检查 PATH",
  CODEX_RUNTIME_VERSION_MISMATCH: "Codex CLI 版本与当前 App 不兼容，请检查 CLI 与 App 版本",
  CODEX_RUNTIME_VERSION_PROBE_FAILED: "无法读取 Codex CLI 版本，请检查本机安装与执行权限",
  CODEX_SCHEMA_ERROR: "Codex 协议校验失败，请检查 CLI 与 App 的版本兼容性",
  RUNTIME_TURN_FAILED: "Agent 本次任务执行失败，请重试；若持续失败，请在「设置」中检查登录状态",
  RUNTIME_TURN_OUTCOME_UNKNOWN: "原生 CLI 尚未确认本次任务的最终结果，已停止等待；请先检查原生会话记录，避免重复执行",
  RUNTIME_START_FAILED: "启动 Agent Runtime 失败，请重试；若持续失败，请检查 CLI 安装与登录状态",
  RUNTIME_START_RUNTIME_ACQUIRE_FAILED: "获取 Agent Runtime 失败，请重试",
  RUNTIME_START_PROCESS_SPAWN_FAILED: "启动 Agent Runtime 进程失败，请重试或检查 CLI 安装",
  RUNTIME_START_BOOTSTRAP_ROLE_FAILED: "启动 Shoggoth Helper 失败，请重试或重启 App",
  RUNTIME_START_RPC_INITIALIZE_FAILED: "初始化 Agent Runtime 通信失败，请重试",
  RUNTIME_START_MCP_INITIALIZE_FAILED: "初始化 Shoggoth 工具失败，请重试或重启 App",
  RUNTIME_START_SESSION_START_OR_RESUME_FAILED: "创建或恢复 Agent 会话失败，请重试",
  RUNTIME_START_TURN_START_FAILED: "发送本次任务失败；为避免重复执行，未自动重放",
  CODEX_START_FAILED: "启动 Codex Runtime 失败，请重试",
  CODEX_TURN_FAILED: "Codex 本次任务执行失败，请重试；若持续失败，请在「设置」中检查登录状态",
  CODEX_START_RUNTIME_ACQUIRE_FAILED: "获取 Agent Runtime 失败，请重试",
  CODEX_START_PROCESS_SPAWN_FAILED: "启动 Codex 进程失败，请重试或检查安装完整性",
  CODEX_START_BOOTSTRAP_ROLE_FAILED: "启动 Shoggoth Helper 失败，请重试或重启 App",
  CODEX_START_RPC_INITIALIZE_FAILED: "初始化 Codex 通信失败，请重试",
  CODEX_START_MCP_INITIALIZE_FAILED: "初始化 Shoggoth 工具失败，请重试或重启 App",
  CODEX_START_SESSION_START_OR_RESUME_FAILED: "创建或恢复 Agent 会话失败，请重试",
  CODEX_START_TURN_START_FAILED: "发送本次任务失败；为避免重复执行，未自动重放",
});
const CHAT_REQUEST_MESSAGES = Object.freeze({
  ...require("../agent-service/product-context-protocol").MESSAGES,
  ...require("../agent-service/runtime-selection-policy").RUNTIME_POLICY_MESSAGES,
  ...SESSION_RUNTIME_PUBLIC_MESSAGES,
  NATIVE_RUNTIME_DISABLED: "该运行环境已停用，请在设置中恢复后再执行任务",
  ...AGENT_BINDING_PUBLIC_MESSAGES,
  ...NATIVE_RUNTIME_CONFIG_PUBLIC_MESSAGES,
  CUSTOM_ENDPOINT_REJECTED: "端点操作失败，请检查配置、当前任务和本机 Service 后重试。",
  ...INSPIRATION_PUBLIC_MESSAGES,
  RUNTIME_AUTH_REQUIRED: CHAT_PUBLIC_MESSAGES.RUNTIME_AUTH_REQUIRED,
  CHAT_ATTACHMENT_INVALID: CHAT_PUBLIC_MESSAGES.CHAT_ATTACHMENT_INVALID,
  INSPIRATION_ARCHIVED: "此会话关联的灵感已归档，请先在「灵感便签」中恢复它，或切换到普通聊天会话",
  INSPIRATION_NOT_FOUND: "此会话关联的灵感已删除或不存在，历史记录仍可查看；请切换到普通聊天会话继续",
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const BACKEND_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const CONNECTION_MODES = new Set(["builtin-service", "native-runtime"]);
const CLIENT_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_ADAPTER_ERRORS = new WeakSet();
const PUBLIC_SERVICE_ERROR_CODES = new Set([
  ...Object.keys(require("../agent-service/product-context-protocol").MESSAGES),
  ...Object.keys(require("../agent-service/runtime-selection-policy").RUNTIME_POLICY_MESSAGES),
  ...Object.keys(SESSION_RUNTIME_PUBLIC_MESSAGES),
  "NATIVE_RUNTIME_DISABLED",
  ...Object.keys(AGENT_BINDING_PUBLIC_MESSAGES),
  ...Object.keys(NATIVE_RUNTIME_CONFIG_PUBLIC_MESSAGES),
  "CUSTOM_ENDPOINT_REJECTED",
  ...Object.keys(CHAT_PUBLIC_MESSAGES),
  ...Object.keys(INSPIRATION_PUBLIC_MESSAGES),
  ...Object.keys(DOMAIN_PUBLIC_MESSAGES),
  ...Object.keys(PROFILE_PUBLIC_MESSAGES),
  ...Object.keys(AGENT_LIFECYCLE_PUBLIC_MESSAGES),
  ...Object.keys(AGENT_HARNESS_PUBLIC_MESSAGES),
  "REQUEST_TIMEOUT",
  "UNSAFE_SYMLINK",
  "UNSAFE_TOKEN_CHANGED",
  "UNSAFE_OWNER",
  "UNSAFE_PERMISSIONS",
  "UNSAFE_SOCKET_CHANGED",
  "INCOMPLETE_RESPONSE",
  "MULTIPLE_RESPONSE_FRAMES",
  "RESPONSE_TRAILING_DATA",
  "MALFORMED_RESPONSE",
  "RESPONSE_ID_MISMATCH",
  "SERVICE_ERROR",
  "SERVICE_DISCONNECTED",
  "INVALID_PARAMS",
  "USAGE_RESPONSE_INVALID",
  "PLUGIN_UNAVAILABLE",
  "PLUGIN_RESPONSE_INVALID",
  "PLUGIN_REQUEST_INVALID",
  "PLUGIN_SERVICE_FAILED",
  "PLUGIN_OPERATION_INVALID",
  "PLUGIN_OPERATION_FAILED",
  "PLUGIN_OPERATION_OUTCOME_UNKNOWN",
  "PACKAGE_CHANGED",
  "PACKAGE_INVALID",
  "PACKAGE_PATH_INVALID",
  "GIT_SOURCE_INVALID",
  "GIT_REMOTE_CANCELLED",
  "GIT_REMOTE_FAILED",
  "GIT_REMOTE_TIMEOUT",
  "GIT_REMOTE_TOO_LARGE",
  "GIT_REMOTE_LOG_LIMIT",
  "GIT_REMOTE_LIMIT",
  "GIT_REMOTE_EXIT_UNKNOWN",
  "REVISION_CONFLICT",
  "PLUGIN_INSTALLATION_INVALID",
  "PLUGIN_BINDING_INVALID",
  "PLUGIN_COMPONENT_INACTIVE",
  "PLUGIN_COMPONENT_REVISION_CHANGED",
  "ACTIVATION_DEFERRED",
  "PLUGIN_UPDATE_REQUIRES_DISABLE",
  "PLUGIN_CONNECTION_CLOSE_FAILED",
  "PLUGIN_UNINSTALL_REQUIRES_DISABLE",
  "PLUGIN_GRANT_INVALID",
  "PLUGIN_RESPONSE_TOO_LARGE",
  "LEGACY_SOURCE_OVERLAP",
  "PLUGIN_CONSENT_EXPIRED",
  "PLUGIN_CONSENT_BUSY",
  "PLUGIN_OAUTH_PROVIDER_UNSUPPORTED",
  "PLUGIN_OAUTH_CONFIG_INVALID",
  "PLUGIN_OAUTH_FLOW_NOT_FOUND",
  "PLUGIN_CONNECTION_LIMIT",
  "CONNECTION_AUTH_REQUIRED",
  "CONNECTION_IDENTITY_CHANGED",
  "TOOL_CONTRACT_CHANGED",
  "DEPENDENCY_PREPARATION_REQUIRED",
  "DEPENDENCY_MISSING",
  "DEPENDENCY_REQUIRES_DISABLE",
  "DEPENDENCY_CHANGED",
  "DEPENDENCY_EXECUTABLE_INVALID",
  "DEPENDENCY_INTERPRETER_UNSUPPORTED",
  "DEPENDENCY_ARGUMENTS_UNSUPPORTED",
  "DEPENDENCY_ENV_UNSUPPORTED",
  "DEPENDENCY_PROBE_FAILED",
  "DEPENDENCY_REGISTRY_INVALID",
  "DEPENDENCY_REGISTRY_LIMIT",
  "DEPENDENCY_CONFIRMATION_REQUIRED",
  "MCP_APP_AUTHORITY_INVALID",
  "MCP_APP_AUTHORITY_REVOKED",
  "MCP_APP_RESOURCE_FORBIDDEN",
  "MCP_APP_RESOURCE_INVALID",
  "MCP_APP_SESSION_EXPIRED",
  "MCP_APP_TRANSPORT_INVALID",
  "MCP_APP_LIMIT",
  "MCP_APP_UNSUPPORTED",
  "MCP_APP_SEED_UNAVAILABLE",
]);
const AUTH_STATUS_TRANSIENT_ERROR_CODES = new Set([
  "SERVICE_UNAVAILABLE",
  "REQUEST_TIMEOUT",
  "SERVICE_DISCONNECTED",
  "PROFILE_AUTH_STATUS_UNAVAILABLE",
  "PROFILE_SERVICE_CLOSED",
]);
const RUN_OBSERVER_TRANSIENT_ERROR_CODES = new Set([
  "SERVICE_UNAVAILABLE",
  "REQUEST_TIMEOUT",
  "SERVICE_DISCONNECTED",
]);

function ownDataObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.prototype.hasOwnProperty.call(descriptor, "value");
  });
}

function exactObject(value, fields) {
  return ownDataObject(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function validatePluginCatalogPage(value, params) {
  const digest = /^[a-f0-9]{64}$/u;
  const shortText = (text, max = 2048) => typeof text === "string"
    && text.isWellFormed() && Buffer.byteLength(text, "utf8") <= max;
  if (!exactObject(value, ["supported", "catalogRevision", "items", "nextCursor"])
    || value.supported !== true || !digest.test(value.catalogRevision)
    || !Array.isArray(value.items) || value.items.length > params.limit
    || value.items.length > 20
    || (value.nextCursor !== null
      && (!Number.isSafeInteger(value.nextCursor)
        || value.nextCursor <= params.cursor))) {
    throw new TypeError("invalid plugin catalog page");
  }
  const items = value.items.map((item) => {
    if (!exactObject(item, ["installationId", "releaseDigest", "desiredState",
      "revision", "createdAt", "updatedAt", "sourceKind", "packageName",
      "declaredVersion", "components", "diagnostics"])
      || !shortText(item.installationId, 128) || !digest.test(item.releaseDigest)
      || !["enabled", "disabled"].includes(item.desiredState)
      || !Number.isSafeInteger(item.revision) || item.revision < 1
      || !Number.isSafeInteger(item.createdAt) || item.createdAt < 0
      || !Number.isSafeInteger(item.updatedAt) || item.updatedAt < 0
      || !["directory", "git", "legacy-directory", "remote-git", "bundled"].includes(item.sourceKind)
      || !shortText(item.packageName, 256)
      || (item.declaredVersion !== null && !shortText(item.declaredVersion, 256))
      || !Array.isArray(item.components) || item.components.length > 256
      || !Array.isArray(item.diagnostics) || item.diagnostics.length > 256) {
      throw new TypeError("invalid plugin catalog item");
    }
    const components = item.components.map((component) => {
      const common = ["componentId", "kind", "localName", "title",
        "descriptorDigest", "state"];
      const skill = component?.kind === "skill";
      if (!exactObject(component, [...common, skill ? "description" : "transport"])
        || !digest.test(component.componentId)
        || !digest.test(component.descriptorDigest)
        || !shortText(component.localName, 256)
        || !shortText(component.title, 256)
        || !shortText(component.state, 64)
        || (skill ? !shortText(component.description, 2048)
          : component.kind !== "mcp-server"
            || !["stdio", "streamable-http"].includes(component.transport))) {
        throw new TypeError("invalid plugin component");
      }
      return { componentId: component.componentId, kind: component.kind,
        localName: component.localName, title: component.title,
        descriptorDigest: component.descriptorDigest, state: component.state,
        ...(skill ? { description: component.description }
          : { transport: component.transport }) };
    });
    return { installationId: item.installationId,
      releaseDigest: item.releaseDigest, desiredState: item.desiredState,
      revision: item.revision, createdAt: item.createdAt,
      updatedAt: item.updatedAt, sourceKind: item.sourceKind,
      packageName: item.packageName, declaredVersion: item.declaredVersion,
      components, diagnosticCount: item.diagnostics.length };
  });
  return { supported: true, catalogRevision: value.catalogRevision,
    items, nextCursor: value.nextCursor };
}

function validateBundledPluginList(value) {
  const digest = /^[a-f0-9]{64}$/u;
  const id = /^[a-z0-9][a-z0-9-]{0,63}$/u;
  if (!exactObject(value, ["batchDigest", "items"]) || !digest.test(value.batchDigest)
    || !Array.isArray(value.items) || value.items.length > 62) {
    throw new TypeError("invalid bundled plugin list");
  }
  const seen = new Set();
  const items = value.items.map(item => {
    if (!exactObject(item, ["id", "installationId", "displayName",
      "shortDescription", "category", "version", "iconAvailable",
      "components", "converted", "unconvertedMcp", "importStatus", "installationState",
      "installedReleaseDigest"])
      || !id.test(item.id) || seen.has(item.id) || !digest.test(item.installationId)
      || typeof item.displayName !== "string" || item.displayName.length > 128
      || typeof item.shortDescription !== "string" || item.shortDescription.length > 1024
      || typeof item.category !== "string" || item.category.length > 128
      || typeof item.version !== "string" || item.version.length > 128
      || typeof item.iconAvailable !== "boolean"
      || !exactObject(item.components, ["skills", "allSkillFiles", "apps", "mcp"])
      || Object.values(item.components).some(count => !Number.isSafeInteger(count) || count < 0)
      || !exactObject(item.converted, ["skills", "mcp"])
      || !Number.isSafeInteger(item.converted.skills) || item.converted.skills < 0
      || !Number.isSafeInteger(item.converted.mcp) || item.converted.mcp < 0
      || item.converted.skills > item.components.skills
      || item.converted.mcp > item.components.mcp
      || !Array.isArray(item.unconvertedMcp)
      || item.converted.mcp + item.unconvertedMcp.length !== item.components.mcp
      || item.unconvertedMcp.some(issue => !exactObject(issue, ["name", "reasonCode"])
        || typeof issue.name !== "string" || issue.name.length < 1 || issue.name.length > 128
        || !["LEGACY_MCP_FIELD_UNSUPPORTED", "LEGACY_MCP_ENTRY_INVALID"].includes(issue.reasonCode))
      || (item.importStatus === "previewable") !== (item.converted.skills + item.converted.mcp > 0)
      || !["previewable", "needs-adapter"].includes(item.importStatus)
      || !["not-installed", "enabled", "disabled"].includes(item.installationState)
      || (item.installationState === "not-installed"
        ? item.installedReleaseDigest !== null : !digest.test(item.installedReleaseDigest))) {
      throw new TypeError("invalid bundled plugin item");
    }
    seen.add(item.id);
    return { ...item, components: { ...item.components }, converted: { ...item.converted },
      unconvertedMcp: item.unconvertedMcp.map(issue => ({ ...issue })) };
  });
  return { batchDigest: value.batchDigest, items };
}

function boundedIntegerOption(options, name, fallback, min, max) {
  const value = options[name];
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`ShoggothBackend ${name} 必须是 ${min} 到 ${max} 之间的安全整数`);
  }
  return value;
}

function normalizeRuntimeCliAuth(entries) {
  if (entries === undefined) return new Map();
  if (!Array.isArray(entries)) {
    throw new TypeError("ShoggothBackend runtimeCliAuth 必须是数组");
  }
  const result = new Map();
  for (const entry of entries) {
    const credentialProbe = entry?.credentialProbe ?? "file";
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || typeof entry.runtime !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(entry.runtime)
      || typeof entry.name !== "string" || entry.name.length === 0
      || (entry.binaryPath !== null
        && (typeof entry.binaryPath !== "string" || !path.isAbsolute(entry.binaryPath)))
      || (entry.binaryPath === null
        && (typeof entry.unavailableReason !== "string" || entry.unavailableReason.length === 0
          || !entry.unavailableReason.isWellFormed() || entry.unavailableReason.includes("\0")
          || Buffer.byteLength(entry.unavailableReason, "utf8") > 4096))
      || typeof entry.runtimeAccountId !== "string"
      || !OPAQUE_ID_PATTERN.test(entry.runtimeAccountId)
      || typeof entry.accountHome !== "string" || !path.isAbsolute(entry.accountHome)
      || typeof entry.processHome !== "string" || !path.isAbsolute(entry.processHome)
      || (entry.homeEnv !== null
        && (typeof entry.homeEnv !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(entry.homeEnv)))
      || !["native-user", "shoggoth-managed"].includes(entry.accountKind)
      || !["file", "runtime"].includes(credentialProbe)
      || (credentialProbe === "file"
        ? (typeof entry.credentialFile !== "string"
          || !/^[A-Za-z0-9._-]{1,64}$/u.test(entry.credentialFile))
        : entry.credentialFile !== null)
      || !Array.isArray(entry.loginArgs)
      || !entry.loginArgs.every((arg) => typeof arg === "string" && !arg.includes("\0"))
      || !Array.isArray(entry.logoutArgs)
      || !entry.logoutArgs.every((arg) => typeof arg === "string" && !arg.includes("\0"))
      || typeof entry.docsUrl !== "string" || !/^https:\/\//u.test(entry.docsUrl)
      || result.has(entry.runtimeAccountId)) {
      throw new TypeError("ShoggothBackend runtimeCliAuth 条目无效");
    }
    result.set(entry.runtimeAccountId, Object.freeze({
      runtime: entry.runtime,
      runtimeAccountId: entry.runtimeAccountId,
      name: entry.name,
      binaryPath: entry.binaryPath === null ? null : path.resolve(entry.binaryPath),
      unavailableReason: entry.binaryPath === null ? entry.unavailableReason : null,
      accountHome: path.resolve(entry.accountHome),
      processHome: path.resolve(entry.processHome),
      homeEnv: entry.homeEnv,
      accountKind: entry.accountKind,
      credentialFile: entry.credentialFile,
      credentialProbe,
      loginArgs: Object.freeze([...entry.loginArgs]),
      logoutArgs: Object.freeze([...entry.logoutArgs]),
      docsUrl: entry.docsUrl,
    }));
  }
  return result;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function runtimeCliCommand(descriptor, args) {
  if (!descriptor.binaryPath) return "";
  return [
    "/usr/bin/env",
    `HOME=${shellQuote(descriptor.processHome)}`,
    ...(descriptor.homeEnv
      ? [`${descriptor.homeEnv}=${shellQuote(descriptor.accountHome)}`] : []),
    shellQuote(descriptor.binaryPath),
    ...args.map(shellQuote),
  ].join(" ");
}

function managedCredentialPresence(home, credentialFile, accountKind) {
  const target = path.join(home, credentialFile);
  try {
    const homeStat = fs.lstatSync(home);
    const stat = fs.lstatSync(target);
    if (!homeStat.isDirectory() || homeStat.isSymbolicLink()
      || (accountKind === "shoggoth-managed" && (homeStat.mode & 0o077) !== 0)
      || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
      || (typeof process.getuid === "function"
        && (homeStat.uid !== process.getuid() || stat.uid !== process.getuid()))) {
      return { present: false, error: "Managed CLI credential permissions are unsafe" };
    }
    const realHome = fs.realpathSync(home);
    const realTarget = fs.realpathSync(target);
    if (path.dirname(realTarget) !== realHome || stat.size <= 0
      || stat.size > MAX_MANAGED_CREDENTIAL_FILE_BYTES) {
      return { present: false, error: "Managed CLI credential is invalid" };
    }
    let credential;
    try {
      credential = JSON.parse(fs.readFileSync(target, "utf8"));
    } catch {
      return { present: false, error: "Managed CLI credential is invalid" };
    }
    if (!ownDataObject(credential)) {
      return { present: false, error: "Managed CLI credential is invalid" };
    }
    return { present: Object.keys(credential).length > 0, error: null };
  } catch (error) {
    return error?.code === "ENOENT"
      ? { present: false, error: null }
      : { present: false, error: "Managed CLI credential path cannot be inspected" };
  }
}

function safeString(value, maxBytes = 16 * 1024) {
  return typeof value === "string" && value.isWellFormed()
    && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function boundedText(value, maxBytes) {
  if (!safeString(value, maxBytes)) {
    if (typeof value !== "string" || !value.isWellFormed() || value.includes("\0")) return null;
    const encoded = Buffer.from(value, "utf8");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (let end = Math.min(encoded.length, maxBytes); end >= Math.max(0, maxBytes - 3); end -= 1) {
      try { return decoder.decode(encoded.subarray(0, end)); } catch {}
    }
    return "";
  }
  return value;
}

function sameData(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameData(value, right[index]));
  }
  if (!ownDataObject(left) || !ownDataObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && sameData(left[key], right[key]));
}

function contentMetaMatches(meta, content) {
  if (content === null) return meta === null;
  return meta !== null
    && meta.byteLength === Buffer.byteLength(content, "utf8")
    && meta.sha256 === crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function fieldsMatch(value, expected) {
  return Object.entries(expected).every(([key, item]) => sameData(value[key], item));
}

async function mapBounded(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  let firstError = null;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (firstError === null) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= values.length) return;
        try {
          results[index] = await mapper(values[index], index);
        } catch (error) {
          firstError = error;
        }
      }
    },
  );
  await Promise.all(workers);
  if (firstError !== null) throw firstError;
  return results;
}

function safeError(error, fallback = "SERVICE_UNAVAILABLE") {
  let candidate = null;
  const locallyCreated = error !== null && (typeof error === "object" || typeof error === "function")
    && SAFE_ADAPTER_ERRORS.has(error);
  try {
    const descriptor = error && (typeof error === "object" || typeof error === "function")
      ? Object.getOwnPropertyDescriptor(error, "code") : null;
    if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")
      && typeof descriptor.value === "string") candidate = descriptor.value;
  } catch { /* hostile errors always collapse to the fixed fallback */ }
  const code = candidate !== null && (locallyCreated || PUBLIC_SERVICE_ERROR_CODES.has(candidate))
    ? candidate : fallback;
  const output = new Error(CHAT_REQUEST_MESSAGES[code] || `Shoggoth 请求失败 (${code})`);
  output.code = code;
  SAFE_ADAPTER_ERRORS.add(output);
  return output;
}

function sendOperationId(sessionKey, clientKey, randomUUID) {
  if (clientKey === undefined || clientKey === null) return `send-${randomUUID()}`;
  if (typeof clientKey !== "string" || !clientKey.isWellFormed()
    || Buffer.byteLength(clientKey, "utf8") > 128
    || !CLIENT_IDEMPOTENCY_KEY_PATTERN.test(clientKey)) {
    throw safeError(null, "CHAT_IDEMPOTENCY_KEY_INVALID");
  }
  const digest = crypto.createHash("sha256")
    .update("shoggoth-chat-send\0", "utf8")
    .update(sessionKey, "utf8")
    .update("\0", "utf8")
    .update(clientKey, "utf8")
    .digest("hex");
  return `send-${digest}`;
}

function gatewaySessionKey(agentId, sessionKey) {
  return `agent:${agentId}:${sessionKey}`;
}

function parseGatewaySessionKey(value) {
  const match = /^agent:([A-Za-z0-9][A-Za-z0-9._:-]*):([0-9a-f-]+)$/u.exec(String(value || ""));
  if (!match || !UUID_PATTERN.test(match[2])) {
    const error = new Error("Shoggoth 会话标识无效");
    error.code = "CHAT_SESSION_INVALID";
    throw error;
  }
  return { agentId: match[1], sessionKey: match[2] };
}

function runFromSnapshot(snapshot, runId) {
  if (!exactObject(snapshot, ["run"])
    && !exactObject(snapshot, ["run", "queue"])
    && !exactObject(snapshot, ["run", "interaction"])) return null;
  let result;
  try {
    result = validateChatServiceResult("run.get", { run: snapshot.run });
  } catch {
    return null;
  }
  if (Object.hasOwn(snapshot, "queue") && (result.run.status !== "queued"
    || !exactObject(snapshot.queue, ["status", "reason", "queuedAt"])
    || snapshot.queue.status !== "queued" || !safeString(snapshot.queue.reason, 128)
    || !Number.isSafeInteger(snapshot.queue.queuedAt) || snapshot.queue.queuedAt < 0)) return null;
  return result.run.id === runId ? result.run : null;
}

function interactionFromSnapshot(snapshot, runId, requestId, type) {
  if (!exactObject(snapshot, ["run", "interaction"])
    || !exactObject(snapshot.interaction, ["type", "payload"])
    || snapshot.interaction.type !== type
    || snapshot.interaction.payload?.requestId !== requestId) return null;
  try {
    return normalizeInteractiveRequestV1({
      runId,
      eventType: type,
      payload: snapshot.interaction.payload,
      expiresAt: snapshot.interaction.payload.expiresAt ?? null,
    });
  } catch {
    return null;
  }
}

function terminalFromSnapshot(snapshot, runId) {
  const run = runFromSnapshot(snapshot, runId);
  return run && TERMINAL_RUN_STATUSES.has(run.status) ? run : null;
}

// The protocol brands the in-process authoritative null reset with a WeakSet.
// That brand intentionally cannot survive JSONL. The desktop client therefore
// rechecks the exact, terminal-only wire form here instead of trusting an
// unvalidated snapshot received across the socket.
function validateWireNullReset(value) {
  const fields = [
    "runId", "streamId", "events", "cursor", "nextCursor", "hasMore",
    "baseSeq", "latestSeq", "gap", "snapshot",
  ];
  if (!exactObject(value, fields) || typeof value.runId !== "string"
    || !UUID_PATTERN.test(value.streamId) || !Array.isArray(value.events)
    || value.events.length !== 0 || value.cursor !== 0 || value.nextCursor !== 0
    || value.hasMore !== false || value.baseSeq !== 0 || value.latestSeq !== 0
    || !exactObject(value.gap, [
      "code", "requestedStreamId", "currentStreamId", "requestedAfterSeq",
      "baseSeq", "latestSeq",
    ]) || value.gap.code !== "STREAM_RESET" || value.gap.requestedStreamId !== null
    || value.gap.currentStreamId !== value.streamId || value.gap.requestedAfterSeq !== 0
    || value.gap.baseSeq !== 0 || value.gap.latestSeq !== 0) {
    throw safeError(null, "CHAT_RESPONSE_INVALID");
  }
  const terminal = terminalFromSnapshot(value.snapshot, value.runId);
  if (!terminal) throw safeError(null, "CHAT_RESPONSE_INVALID");
  return {
    runId: value.runId,
    streamId: value.streamId,
    events: [],
    cursor: 0,
    nextCursor: 0,
    hasMore: false,
    baseSeq: 0,
    latestSeq: 0,
    gap: structuredClone(value.gap),
    snapshot: { run: terminal },
  };
}

function validateServiceEventPage(value, params) {
  const fields = [
    "streamId", "events", "cursor", "nextCursor", "hasMore", "oldestSeq",
    "baseSeq", "latestSeq", "gap", "snapshot",
  ];
  if (!exactObject(value, fields) || !Array.isArray(value.events)
    || typeof value.streamId !== "string" || !UUID_PATTERN.test(value.streamId)
    || value.events.length > MAX_SERVICE_EVENTS
    || !Number.isSafeInteger(value.cursor) || value.cursor < 0
    || value.nextCursor !== value.cursor || typeof value.hasMore !== "boolean"
    || !Number.isSafeInteger(value.oldestSeq) || value.oldestSeq < 1
    || !Number.isSafeInteger(value.baseSeq) || value.baseSeq < 0
    || !Number.isSafeInteger(value.latestSeq) || value.latestSeq < value.baseSeq) {
    throw new TypeError("invalid events.subscribe response");
  }
  const requestedAfterSeq = params?.afterSeq ?? 0;
  let previousSeq = requestedAfterSeq;
  for (const event of value.events) {
    if (!exactObject(event, ["seq", "type", "payload"])
      || !Number.isSafeInteger(event.seq) || event.seq <= previousSeq
      || event.seq > value.latestSeq
      || typeof event.type !== "string" || event.type.length === 0
      || !event.type.isWellFormed() || Buffer.byteLength(event.type, "utf8") > 128
      || event.payload === undefined) {
      throw new TypeError("invalid events.subscribe event");
    }
    if (event.type === "agent.profile.renamed" || event.type === "agent.profile.changed") {
      const payload = event.payload;
      if (!exactObject(payload, ["profileId", "backendId"])
        || !safeString(payload.profileId, 256) || payload.profileId.length === 0
        || !safeString(payload.backendId, 128) || payload.backendId.length === 0) {
        throw new TypeError("invalid Agent profile event");
      }
    } else if (event.type === "runtime.context.updated") {
      const payload = event.payload;
      if (!exactObject(payload, ["profileId", "sessionKey"])
        || !safeString(payload.profileId, 256) || payload.profileId.length === 0
        || !UUID_PATTERN.test(payload.sessionKey)) throw new TypeError("invalid context observation event");
    } else if (event.type === "federation.chat.terminal") {
      const payload = event.payload;
      if (!exactObject(payload, [
        "runId", "profileId", "sessionKey", "status", "result", "errorCode", "finishedAt",
      ]) || typeof payload.runId !== "string" || payload.runId.length === 0
        || !payload.runId.isWellFormed() || payload.runId.includes("\0")
        || Buffer.byteLength(payload.runId, "utf8") > 256
        || typeof payload.profileId !== "string" || payload.profileId.length === 0
        || !payload.profileId.isWellFormed() || payload.profileId.includes("\0")
        || Buffer.byteLength(payload.profileId, "utf8") > 256
        || typeof payload.sessionKey !== "string" || payload.sessionKey.length === 0
        || !payload.sessionKey.isWellFormed() || payload.sessionKey.includes("\0")
        || Buffer.byteLength(payload.sessionKey, "utf8") > 512
        || !UUID_PATTERN.test(payload.sessionKey)
        || !TERMINAL_RUN_STATUSES.has(payload.status)
        || (payload.result !== null && (typeof payload.result !== "string"
          || !payload.result.isWellFormed() || payload.result.includes("\0")
          || Buffer.byteLength(payload.result, "utf8") > 32 * 1024))
        || (payload.errorCode !== null && (typeof payload.errorCode !== "string"
          || !SAFE_CODE_PATTERN.test(payload.errorCode)))
        || !Number.isSafeInteger(payload.finishedAt) || payload.finishedAt < 0) {
        throw new TypeError("invalid federation terminal event");
      }
    } else if (event.type === "federation.chat.interaction") {
      const payload = event.payload;
      const interaction = payload?.interaction;
      if (!exactObject(payload, ["runId", "profileId", "sessionKey", "interaction"])
        || typeof payload.runId !== "string" || payload.runId.length === 0
        || !payload.runId.isWellFormed() || payload.runId.includes("\0")
        || Buffer.byteLength(payload.runId, "utf8") > 128
        || typeof payload.profileId !== "string" || payload.profileId.length === 0
        || !payload.profileId.isWellFormed() || payload.profileId.includes("\0")
        || Buffer.byteLength(payload.profileId, "utf8") > 256
        || typeof payload.sessionKey !== "string" || payload.sessionKey.length === 0
        || !payload.sessionKey.isWellFormed() || payload.sessionKey.includes("\0")
        || Buffer.byteLength(payload.sessionKey, "utf8") > 512
        || !UUID_PATTERN.test(payload.sessionKey)
        || !exactObject(interaction, ["phase", "eventType", "requestId", "payload"])
        || !["requested", "resolved"].includes(interaction.phase)
        || !["approval", "prompt"].includes(interaction.eventType)
        || typeof interaction.requestId !== "string" || interaction.requestId.length === 0
        || !interaction.requestId.isWellFormed() || interaction.requestId.includes("\0")
        || Buffer.byteLength(interaction.requestId, "utf8") > 128
        || !SAFE_INTERACTION_ID_PATTERN.test(interaction.requestId)
        || (interaction.phase === "requested"
          && (!ownDataObject(interaction.payload)
            || interaction.payload.requestId !== interaction.requestId))
        || (interaction.phase === "resolved" && interaction.payload !== null)) {
        throw new TypeError("invalid federation interaction event");
      }
    }
    previousSeq = event.seq;
  }
  if (value.events.length > 0 && value.cursor !== previousSeq) {
    throw new TypeError("invalid events.subscribe cursor");
  }
  if (value.gap === null) {
    if (value.snapshot !== null) throw new TypeError("invalid events.subscribe snapshot");
  } else if (!exactObject(value.gap, [
    "code", "requestedAfterSeq", "baseSeq", "oldestSeq",
  ]) || value.gap.code !== "CURSOR_GAP"
    || value.gap.requestedAfterSeq !== requestedAfterSeq
    || value.gap.baseSeq !== value.baseSeq
    || value.gap.oldestSeq !== value.oldestSeq
    || !exactObject(value.snapshot, ["kind", "baseSeq", "latestSeq"])
    || value.snapshot.kind !== "cursor-reset"
    || value.snapshot.baseSeq !== value.baseSeq
    || value.snapshot.latestSeq !== value.latestSeq
    || value.events.length !== 0 || value.cursor !== value.baseSeq) {
    throw new TypeError("invalid events.subscribe gap");
  }
  return structuredClone(value);
}

function validateServiceResult(method, value, params) {
  try {
    if (require("../agent-service/product-context-protocol").METHODS.includes(method)) return require("../agent-service/product-context-protocol").validateResult(value);
    if (require("../agent-service/runtime-selection-policy").RUNTIME_POLICY_METHODS.includes(method)) {
      return require("../agent-service/runtime-selection-policy").validateRuntimeSelectionPolicy(value);
    }
    if (SESSION_RUNTIME_METHODS.includes(method)) return validateSessionRuntimeResult(value, params);
    if (AGENT_BINDING_METHODS.includes(method)) return validateAgentBindingResult(method, value, params);
    if (NATIVE_RUNTIME_CONFIG_METHODS.includes(method)) return validateNativeRuntimeConfigResult(method, value);
    if (method.startsWith("provider.endpoints.")) return validateCustomEndpointResult(method, value);
    if (INSPIRATION_SERVICE_METHOD_SET.has(method)) return validateInspirationServiceResult(method, value);
    if (method === "service.status") {
      if (!ownDataObject(value) || value.healthy !== true
        || typeof value.pendingCommandsLocked !== "boolean"
        || typeof value.mcpCredentialsLocked !== "boolean") {
        throw new TypeError("invalid service.status response");
      }
      return Object.freeze({
        healthy: true,
        pendingCommandsLocked: value.pendingCommandsLocked,
        mcpCredentialsLocked: value.mcpCredentialsLocked,
      });
    }
    if (method === "events.subscribe") return validateServiceEventPage(value, params);
    if (method === "plugins.capabilities.list") {
      return validatePluginCatalogPage(value, params);
    }
    if (method === "plugins.bundled.list") return validateBundledPluginList(value);
    if (method.startsWith("plugins.apps.")) return validatePluginAppResult(method, value);
    if (method.startsWith("plugins.oauth.")) return require("./plugin-oauth-dto").validatePluginOAuthResult(method, value);
    if (method.startsWith("plugins.connections.")) return require("./plugin-connection-dto").validatePluginConnectionResult(method, value);
    if (method.startsWith("plugins.dependencies.")) return require("./plugin-dependency-dto").validatePluginDependencyResult(method, value);
    if (method.startsWith("plugins.rollback.")) return require("./plugin-rollback-dto").validatePluginRollbackResult(method, value);
    if (["plugins.install.preview", "plugins.install", "plugins.installations.set",
      "plugins.skills.bindings.list", "plugins.skills.bindings.set",
      "plugins.mcp.status", "plugins.mcp.tools.list", "plugins.mcp.grants.revoke",
      "plugins.mcp.grants.revoke-all",
      "plugins.mcp.consent.prepare", "plugins.mcp.consent.commit", "plugins.mcp.discover",
      "plugins.uninstall.preview", "plugins.uninstall",
      "plugins.operations.get"]
      .includes(method)) return validatePluginManagementResult(method, value);
    if (DOMAIN_SERVICE_METHOD_SET.has(method)) {
      return validateDomainServiceResult(method, value, params);
    }
    if (AGENT_LIFECYCLE_METHOD_SET.has(method)) {
      return validateAgentLifecycleResult(method, value);
    }
    if (PROFILE_SERVICE_METHOD_SET.has(method)) {
      return validateProfileServiceResult(method, value);
    }
    if (AGENT_HARNESS_METHOD_SET.has(method)) {
      return validateAgentHarnessResult(method, value);
    }
    if (method === "usage.series") return validateUsageSeries(value);
    if (method === "usage.breakdown") return validateUsageBreakdown(value);
    return validateChatServiceResult(method, value);
  } catch (error) {
    if (method === "run.subscribe" && value?.gap?.code === "STREAM_RESET"
      && value.gap.requestedStreamId === null) return validateWireNullReset(value);
    throw safeError(error, method === "service.status"
      ? "SERVICE_UNAVAILABLE"
      : method.startsWith("usage.") ? "USAGE_RESPONSE_INVALID"
        : method.startsWith("plugins.") ? "PLUGIN_RESPONSE_INVALID"
        : AGENT_HARNESS_METHOD_SET.has(method) ? "HARNESS_RESPONSE_INVALID"
          : "CHAT_RESPONSE_INVALID");
  }
}

function encodedBytes(value, code = "RESPONSE_TOO_LARGE") {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    throw safeError(null, code);
  }
}

const PROTECTED_NATIVE_PROFILE_IDS = new Set([
  DEFAULT_AGENT_PROFILE_ID,
  ...BUILTIN_CLI_AGENT_PROFILES.map((profile) => profile.id),
]);

function runtimeAccountReferenceCounts(profiles) {
  const counts = new Map();
  for (const profile of profiles) {
    counts.set(profile.runtimeAccountId, (counts.get(profile.runtimeAccountId) || 0) + 1);
  }
  return counts;
}

function profileToAgent(profile, backendId, sharedAgentCount = 1) {
  return Object.freeze({
    id: profile.agentId,
    name: profile.name,
    model: profile.defaultModel || undefined,
    provider: profile.providerRef || profile.runtime || undefined,
    runtime: profile.runtime,
    runtimeAccountId: profile.runtimeAccountId,
    environmentKind: DEFAULT_RUNTIME_ACCOUNTS.find((account) => account.id === profile.runtimeAccountId)?.kind,
    sharedAgentCount,
    backendId,
  });
}

function profileToManagedAgent(
  profile,
  backendId,
  lifecycleState = profile.enabled ? "active" : "archived",
  sharedAgentCount = 1,
) {
  return Object.freeze({
    ...profileToAgent(profile, backendId, sharedAgentCount),
    isDefault: profile.isDefault === true,
    protected: profile.isDefault === true || PROTECTED_NATIVE_PROFILE_IDS.has(profile.id),
    archived: profile.enabled !== true,
    lifecycleState,
    updatedAt: profile.updatedAt,
  });
}

function sessionToRow(profile, value, backendId) {
  const title = typeof value.title === "string" && value.title.length > 0
    ? value.title : undefined;
  const derivedTitle = value.inspirationTitle ? `Inspiration · ${value.inspirationTitle}`
    : typeof value.derivedTitle === "string" && value.derivedTitle.length > 0
    ? value.derivedTitle : undefined;
  return Object.freeze({
    key: gatewaySessionKey(profile.agentId, value.sessionKey),
    kind: value.cronJobId ? "cron" : "direct",
    label: title,
    displayName: title,
    ...(derivedTitle ? { derivedTitle } : {}),
    ...(value.inspirationId ? { inspirationId: value.inspirationId } : {}),
    subject: undefined,
    updatedAt: value.updatedAt,
    sessionId: value.sessionKey,
    agentId: profile.agentId,
    agentName: profile.name,
    model: value.modelOverride || profile.defaultModel || undefined,
    ...(value.modelSettings ? { thinkingLevel: value.modelSettings.thinkingLevel,
      fastMode: value.modelSettings.serviceTier !== null } : {}),
    ...(value.contextCapabilities ? { contextUsage: value.contextUsage, contextCapabilities: value.contextCapabilities } : {}),
    ...(value.productContext ? { productContext: value.productContext } : {}),
    permissionMode: value.permissionMode
      || defaultRuntimePermissionMode(profile.runtime || "codex", profile.permissionPolicy),
    provider: profile.providerRef || profile.runtime,
    backendId,
  });
}

function assertGatewayMessage(value) {
  if (!ownDataObject(value) || !safeString(value.id, 256) || value.id.length === 0
    || !["user", "assistant", "toolResult", "system"].includes(value.role)
    || !Array.isArray(value.content)) {
    throw safeError(null, "CHAT_HISTORY_INVALID");
  }
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw safeError(null, "CHAT_HISTORY_INVALID"); }
  if (!safeString(encoded, MAX_HISTORY_BYTES)) throw safeError(null, "CHAT_HISTORY_TOO_LARGE");
  return structuredClone(value);
}

function displayHistoryMessage(message, item) {
  if (item.type !== "error" || item.role !== "system" || message.role !== "system"
    || message.content.length !== 1 || message.content[0]?.type !== "text") return message;
  const code = message.content[0].text;
  if (typeof code === "string" && SAFE_CODE_PATTERN.test(code) && RUNTIME_START_MESSAGES[code]) {
    // Only project canonical error records. Keep the durable code untouched,
    // and never rewrite an error code quoted by the user or the model.
    message.content[0].text = `错误：${RUNTIME_START_MESSAGES[code]}`;
  }
  return message;
}

function reassembleHistory(items) {
  if (!Array.isArray(items) || items.length > MAX_HISTORY_ITEMS) {
    throw safeError(null, "CHAT_HISTORY_TOO_LARGE");
  }
  let totalBytes = 0;
  for (const item of items) {
    try { totalBytes += Buffer.byteLength(JSON.stringify(item), "utf8"); } catch {
      throw safeError(null, "CHAT_HISTORY_INVALID");
    }
    if (totalBytes > MAX_HISTORY_BYTES) throw safeError(null, "CHAT_HISTORY_TOO_LARGE");
  }
  const output = [];
  const seenMessageIds = new Set();
  for (let index = 0; index < items.length;) {
    const item = items[index];
    if (item.fragment === null) {
      if (!exactObject(item.payload, ["message"])) throw safeError(null, "CHAT_HISTORY_INVALID");
      const message = assertGatewayMessage(item.payload.message);
      if (seenMessageIds.has(message.id)) throw safeError(null, "CHAT_HISTORY_DUPLICATE");
      seenMessageIds.add(message.id);
      output.push(displayHistoryMessage(message, item));
      index += 1;
      continue;
    }

    const identity = item.fragment;
    const payload = item.payload;
    if (identity.index !== 0 || identity.count < 2 || identity.count > MAX_FRAGMENT_COUNT
      || !exactObject(payload, ["encoding", "sha256", "data"])
      || payload.encoding !== "gateway-message-json-utf8"
      || !/^[a-f0-9]{64}$/u.test(payload.sha256) || !safeString(payload.data, MAX_ITEM_BYTES)) {
      throw safeError(null, "CHAT_HISTORY_FRAGMENT_INVALID");
    }
    if (index + identity.count > items.length || seenMessageIds.has(identity.messageId)) {
      throw safeError(null, "CHAT_HISTORY_FRAGMENT_INCOMPLETE");
    }
    const fragments = items.slice(index, index + identity.count);
    const data = [];
    for (let fragmentIndex = 0; fragmentIndex < fragments.length; fragmentIndex += 1) {
      const fragment = fragments[fragmentIndex];
      if (fragment.fragment?.messageId !== identity.messageId
        || fragment.fragment?.index !== fragmentIndex
        || fragment.fragment?.count !== identity.count
        || !exactObject(fragment.payload, ["encoding", "sha256", "data"])
        || fragment.payload.encoding !== payload.encoding
        || fragment.payload.sha256 !== payload.sha256
        || !safeString(fragment.payload.data, MAX_ITEM_BYTES)) {
        throw safeError(null, "CHAT_HISTORY_FRAGMENT_INCOMPLETE");
      }
      data.push(fragment.payload.data);
    }
    const serialized = data.join("");
    if (!serialized.isWellFormed() || Buffer.byteLength(serialized, "utf8") > MAX_HISTORY_BYTES
      || crypto.createHash("sha256").update(serialized, "utf8").digest("hex") !== payload.sha256) {
      throw safeError(null, "CHAT_HISTORY_FRAGMENT_CORRUPT");
    }
    let message;
    try { message = JSON.parse(serialized); } catch { throw safeError(null, "CHAT_HISTORY_FRAGMENT_CORRUPT"); }
    message = assertGatewayMessage(message);
    if (message.id !== identity.messageId) throw safeError(null, "CHAT_HISTORY_FRAGMENT_CORRUPT");
    seenMessageIds.add(message.id);
    output.push(displayHistoryMessage(message, item));
    index += identity.count;
  }
  return output;
}

class ShoggothBackend extends AgentBackend {
  constructor(options = {}) {
    super();
    const backendId = options.id === undefined ? "shoggoth" : options.id;
    const backendName = options.name === undefined ? "Shoggoth" : options.name;
    const connectionMode = options.connectionMode === undefined
      ? "builtin-service" : options.connectionMode;
    if (backendId !== "shoggoth") {
      throw new TypeError("ShoggothBackend id 必须为 shoggoth");
    }
    if (typeof backendName !== "string" || backendName.length === 0
      || !backendName.isWellFormed() || Buffer.byteLength(backendName, "utf8") > 128) {
      throw new TypeError("ShoggothBackend name 必须是非空短字符串");
    }
    if (!CONNECTION_MODES.has(connectionMode)) {
      throw new TypeError("ShoggothBackend connectionMode 无效");
    }
    if (options.claimsAgentId !== undefined && typeof options.claimsAgentId !== "function") {
      throw new TypeError("ShoggothBackend claimsAgentId 必须是函数");
    }
    if (options.requestService !== undefined && typeof options.requestService !== "function") {
      throw new TypeError("ShoggothBackend requestService 必须是函数");
    }
    if (options.readToken !== undefined && typeof options.readToken !== "function") {
      throw new TypeError("ShoggothBackend readToken 必须是函数");
    }
    if (options.getNativeRuntimeConfig !== undefined && typeof options.getNativeRuntimeConfig !== "function") {
      throw new TypeError("ShoggothBackend getNativeRuntimeConfig 必须是函数");
    }
    if (options.randomUUID !== undefined && typeof options.randomUUID !== "function") {
      throw new TypeError("ShoggothBackend randomUUID 必须是函数");
    }
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new TypeError("ShoggothBackend now 必须是函数");
    }
    if (options.readinessNow !== undefined && typeof options.readinessNow !== "function") {
      throw new TypeError("ShoggothBackend readinessNow 必须是函数");
    }
    if (options.delay !== undefined && typeof options.delay !== "function") {
      throw new TypeError("ShoggothBackend delay 必须是函数");
    }
    if (options.timeZone !== undefined && (typeof options.timeZone !== "string"
      || options.timeZone.length === 0 || Buffer.byteLength(options.timeZone, "utf8") > 128)) {
      throw new TypeError("ShoggothBackend timeZone 必须是有效时区字符串");
    }
    if (options.version !== undefined && (typeof options.version !== "string"
      || options.version.length === 0 || Buffer.byteLength(options.version, "utf8") > 128)) {
      throw new TypeError("ShoggothBackend version 必须是非空短字符串");
    }
    this.backendId = backendId;
    this.backendName = backendName;
    this.connectionMode = connectionMode;
    this._claimsAgentId = options.claimsAgentId || claimsNativeAgentId;
    this._getDisabledBackendIds = null;
    this.paths = options.paths || resolveServicePaths();
    this.requestService = options.requestService || requestService;
    this.readToken = options.readToken || readClientToken;
    this.getNativeRuntimeConfig = options.getNativeRuntimeConfig || null;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.now = options.now || Date.now;
    this.readinessNow = options.readinessNow || (() => performance.now());
    this.delay = options.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.readinessTimeoutMs = boundedIntegerOption(
      options, "readinessTimeoutMs", DEFAULT_READINESS_TIMEOUT_MS,
      1, DEFAULT_READINESS_TIMEOUT_MS,
    );
    this.readinessIntervalMs = boundedIntegerOption(
      options, "readinessIntervalMs", DEFAULT_READINESS_INTERVAL_MS,
      0, DEFAULT_READINESS_INTERVAL_MS,
    );
    this.serviceStatusTimeoutMs = boundedIntegerOption(
      options, "serviceStatusTimeoutMs", DEFAULT_SERVICE_STATUS_TIMEOUT_MS,
      1, DEFAULT_SERVICE_STATUS_TIMEOUT_MS,
    );
    this.readinessMaxAttempts = boundedIntegerOption(
      options, "readinessMaxAttempts", DEFAULT_READINESS_MAX_ATTEMPTS,
      1, DEFAULT_READINESS_MAX_ATTEMPTS,
    );
    this.maxPages = Number.isSafeInteger(options.maxPages) && options.maxPages > 0
      ? options.maxPages : DEFAULT_MAX_PAGES;
    this.pollIntervalMs = Number.isSafeInteger(options.pollIntervalMs) && options.pollIntervalMs >= 0
      ? options.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS;
    this.maxPollErrors = Number.isSafeInteger(options.maxPollErrors) && options.maxPollErrors > 0
      ? options.maxPollErrors : DEFAULT_MAX_POLL_ERRORS;
    this.serviceEventPollMs = boundedIntegerOption(
      options, "serviceEventPollMs", DEFAULT_SERVICE_EVENT_POLL_MS,
      1, MAX_SERVICE_EVENT_POLL_MS,
    );
    this.timeZone = options.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    this.version = options.version || null;
    this.runtimeCliAuth = normalizeRuntimeCliAuth(options.runtimeCliAuth);
    if (options.getRuntimeCliAuth !== undefined && typeof options.getRuntimeCliAuth !== "function") {
      throw new TypeError("ShoggothBackend getRuntimeCliAuth must be a function");
    }
    this.getRuntimeCliAuth = options.getRuntimeCliAuth || null;
    try { new Intl.DateTimeFormat("en", { timeZone: this.timeZone }).format(0); } catch {
      throw new TypeError("ShoggothBackend timeZone 必须是有效 IANA 时区");
    }
    this._profilesByAgent = new Map();
    this._profilesById = new Map();
    this._sessionsByKey = new Map();
    this._agents = [];
    this._rows = [];
    this._modelChoices = [];
    this._modelsRefreshing = null;
    this._modelsRefreshingGeneration = null;
    this._profileRefreshPromise = null;
    this._complete = false;
    this._state = "stopped";
    this._generation = 0;
    this._startPromise = null;
    this._queuedStartPromise = null;
    this._stopPromise = null;
    this._statusRefreshPromise = null;
    this._statusRefreshGeneration = null;
    this._consecutiveStatusTimeouts = 0;
    this._readyNotifier = null;
    this._sessionActivityNotifier = null;
    this._serviceEventCursor = 0;
    this._serviceEventStreamId = null;
    this._serviceEventPollTimer = null;
    this._serviceEventPollGeneration = null;
    this._retryOnStatus = false;
    this._polls = new Set();
    this._activeBySession = new Map();
    this._promptByRequest = new Map();
  }

  get id() { return this.backendId; }

  get name() { return this.backendName; }

  getBackendDescriptor() {
    return {
      id: this.id,
      name: this.name,
      connectionMode: this.connectionMode,
      disconnectable: false,
      agentLifecycle: {
        create: true,
        update: true,
        remove: false,
        archive: true,
        restore: true,
        readStates: true,
      },
      surfaces: {
        chat: true,
        agents: true,
        models: true,
        skills: true,
        usage: true,
        oauth: true,
        dashboardRuns: true,
        agentHarness: true,
        nativeCapacity: true,
        runtimeBindings: true,
        runtimeStatus: true,
        sessionRuntimeSwitch: true,
        runtimeUsage: true,
        cron: { kind: "native" },
        kanban: { kind: "native" },
      },
    };
  }

  claimsAgentId(agentId) {
    try {
      return this._claimsAgentId(agentId) === true;
    } catch {
      return false;
    }
  }

  ownsAgentId(agentId) {
    return typeof agentId === "string" && this._profilesByAgent.has(agentId);
  }

  getAgents() { return [...this._agents]; }

  setDisabledBackendsProvider(provider) { this._getDisabledBackendIds = provider; }

  _bindingAvailability(agentId, runtime, runtimeAccountId) {
    let disabled;
    try { disabled = this._getDisabledBackendIds?.() || []; } catch { disabled = []; }
    return !isRuntimeAvailable(runtime) ? { available: false, reason: "runtime-unavailable" }
      : isNativeBindingDisabled(agentId, runtime, disabled, runtimeAccountId) ? { available: false, reason: "runtime-disabled" }
        : { available: true, reason: null };
  }

  _assertRuntimeEnabled(profile, runtime = profile.runtime) {
    if (!this._bindingAvailability(profile.agentId, runtime, profile.runtimeAccountId).available) throw safeError(null, "NATIVE_RUNTIME_DISABLED");
  }

  async _connectedCliAccounts() {
    const descriptors = this.getRuntimeCliAuth
      ? normalizeRuntimeCliAuth(await this.getRuntimeCliAuth()) : this.runtimeCliAuth;
    return DEFAULT_RUNTIME_ACCOUNTS.filter(account => account.kind === "native-user"
      && descriptors.get(account.id)?.binaryPath
      && this._bindingAvailability("", account.runtime, account.id).available).map(account => account.id);
  }

  _rememberBindings(profileId, state) {
    this._bindingsByProfile ||= new Map();
    this._bindingsByProfile.set(profileId, state.bindings);
    return state;
  }

  async _syncCliBindings(profileId, runtimeAccountIds) {
    return this._rememberBindings(profileId, await this._call("agent.binding.sync", { profileId, runtimeAccountIds }));
  }

  _profileForSession(profile, session) {
    const binding = this._bindingsByProfile?.get(profile.id)?.find(entry => entry.id === session.runtimeBindingId);
    return binding ? { ...profile, runtime: binding.runtime, runtimeProfileId: binding.runtimeProfileId,
      runtimeAccountId: binding.runtimeAccountId } : profile;
  }

  _acceptsProfileBackend(backendId) {
    return backendId === this.id;
  }

  getNativeCapacity() { return this._call("runtime.capacity.read", {}); }

  async getRuntimeStatuses() {
    // Resolve the executables again on an explicit settings refresh so a newly
    // installed CLI is visible without restarting. Do not launch auth probes.
    const descriptors = this.getRuntimeCliAuth
      ? normalizeRuntimeCliAuth(await this.getRuntimeCliAuth()) : this.runtimeCliAuth;
    const serviceConnected = await this.getStatus().then(status => status.connected === true, () => false);
    let disabled = [];
    try { disabled = this._getDisabledBackendIds?.() || []; } catch { /* configuration unavailable */ }
    const names = new Map(require("../runtime-cli-auth").AUTH_SPECS.map(spec => [spec.runtimeAccountId, spec.name]));
    return DEFAULT_RUNTIME_ACCOUNTS.filter(account => account.kind === "native-user").map(account => {
      const descriptor = descriptors.get(account.id);
      const releaseEnabled = isRuntimeAvailable(account.runtime);
      return {
        runtime: account.runtime, name: names.get(account.id) || account.runtime,
        runtimeAccountId: account.id, releaseEnabled,
        enabled: !isNativeBindingDisabled("", account.runtime, disabled, account.id),
        installation: !releaseEnabled ? "unknown" : descriptor?.binaryPath ? "available" : "unavailable",
        serviceConnected,
      };
    });
  }

  async applyNativeRuntimeConfig(input) {
    const projection = validateNativeRuntimeConfigProjection(input);
    const applied = await this._call("runtime.config.apply", projection);
    if (JSON.stringify(applied) !== JSON.stringify(projection)) {
      throw safeError(null, "NATIVE_RUNTIME_CONFIG_CONFLICT");
    }
    return applied;
  }

  _isServiceReady(status) {
    // MCP credentials initialize on the first authenticated helper handshake.
    // Their optional lock must not hide the native Agent roster.
    return status.healthy === true
      && status.pendingCommandsLocked === false;
  }

  _statusResult() {
    if (this._state === "started") {
      return {
        id: this.id,
        name: this.name,
        connected: true,
        info: {
          connectionMode: this.connectionMode,
          state: "started",
          agents: this._agents.length,
          sessions: this._rows.length,
          readyAgentIds: this._agents.map((agent) => agent.id),
        },
      };
    }
    const starting = this._state === "starting" || this._state === "recovering";
    return {
      id: this.id,
      name: this.name,
      connected: false,
      info: {
        connectionMode: this.connectionMode,
        state: this._state,
        ...(starting ? { starting: true } : {}),
        readyAgentIds: [],
      },
    };
  }

  _refreshStartedStatus(generation) {
    if (this._statusRefreshPromise && this._statusRefreshGeneration === generation) {
      return this._statusRefreshPromise;
    }
    let refresh;
    refresh = (async () => {
      try {
        const status = await this._call("service.status", {}, {
          timeoutMs: Math.min(this.serviceStatusTimeoutMs, DEFAULT_SERVICE_STATUS_TIMEOUT_MS),
        });
        if (generation === this._generation) this._consecutiveStatusTimeouts = 0;
        return this._isServiceReady(status);
      } catch (error) {
        const code = error && typeof error === "object"
          ? Object.getOwnPropertyDescriptor(error, "code")?.value : null;
        if (code === "REQUEST_TIMEOUT") {
          if (generation !== this._generation) return null;
          this._consecutiveStatusTimeouts += 1;
          // One bounded timeout is unknown; a repeated timeout enters recovery.
          return this._consecutiveStatusTimeouts === 1 ? null : false;
        }
        if (generation === this._generation) this._consecutiveStatusTimeouts = 0;
        return false;
      }
    })().finally(() => {
      if (this._statusRefreshPromise === refresh) {
        this._statusRefreshPromise = null;
        this._statusRefreshGeneration = null;
      }
    });
    this._statusRefreshPromise = refresh;
    this._statusRefreshGeneration = generation;
    return refresh;
  }

  _invalidateReadySnapshot(generation) {
    if (generation !== this._generation || this._state !== "started") return false;
    ++this._generation;
    this._stopServiceEventPolling();
    for (const poll of this._polls) poll.cancelled = true;
    this._polls.clear();
    this._profilesByAgent = new Map();
    this._profilesById = new Map();
    this._sessionsByKey = new Map();
    this._agents = [];
    this._rows = [];
    this._activeBySession.clear();
    // Accepted WorkRun prompts remain valid across readiness recovery.
    // Terminal settlement, transport failure, delete, and stop still clear them.
    this._complete = false;
    this._state = "recovering";
    this._retryOnStatus = true;
    return true;
  }

  async getStatus() {
    if (this._state === "started") {
      const generation = this._generation;
      const ready = await this._refreshStartedStatus(generation);
      if (generation === this._generation && this._state === "started" && ready === false
        && this._invalidateReadySnapshot(generation)) {
        void this.start().catch(() => {});
      }
    } else if (this._state === "stopped" && this._retryOnStatus && !this._stopPromise) {
      // A settings/status refresh starts the bounded recovery owner but never
      // inherits its 70-second budget.
      void this.start().catch(() => {});
    }
    return this._statusResult();
  }

  async getVersionInfo() {
    return {
      id: this.id,
      name: this.name,
      ...(this.version ? { current: this.version, currentSource: "desktop" } : {}),
      // There is no configured authoritative Shoggoth release feed. Surface the
      // packaged version, but never manufacture an "official latest" result.
      comparisonSupported: false,
    };
  }

  async _refreshModels() {
    this._assertDomainReady();
    if (this._modelsRefreshing && this._modelsRefreshingGeneration === this._generation) {
      return this._modelsRefreshing;
    }
    const generation = this._generation;
    const profiles = [...this._profilesByAgent.values()];
    let refresh;
    refresh = (async () => {
      const results = await Promise.allSettled(profiles.map((profile) => (
        this._page("profile.models.list", { profileId: profile.id }, "models", {
          maxBytes: MAX_HISTORY_BYTES,
          maxItems: MAX_HISTORY_ITEMS,
        })
      )));
      const successful = results.flatMap((result, index) => result.status === "fulfilled"
        ? [{ models: result.value, profile: profiles[index] }]
        : []);
      // A verified backend snapshot must cover every visible Agent. A timeout must
      // not erase one Agent's choices/default or be cached as a successful empty list.
      if (successful.length !== profiles.length) {
        throw safeError(null, "PROFILE_MODEL_CATALOG_UNAVAILABLE");
      }
      const byId = new Map();
      for (const result of successful) {
        const provider = result.profile.providerRef || result.profile.runtime;
        for (const model of result.models) {
          const key = `${provider}\0${model.id}\0${JSON.stringify(model.capabilities || null)}`;
          const existing = byId.get(key);
          if (existing) {
            existing.modelScopes.add(result.profile.id);
            if (model.isDefault) existing.defaultModelScopes.add(result.profile.id);
          } else {
            byId.set(key, {
              id: model.id,
              name: model.displayName,
              provider,
              backendId: this.id,
              capabilities: model.capabilities,
              modelScopes: new Set([result.profile.id]),
              defaultModelScopes: new Set(model.isDefault ? [result.profile.id] : []),
            });
          }
        }
      }
      const choices = [...byId.values()].map((row) => {
        const defaultModelScopes = [...row.defaultModelScopes].sort();
        return Object.freeze({
          id: row.id,
          name: row.name,
          provider: row.provider,
          backendId: row.backendId,
          ...(row.capabilities ? {
            thinkingOptions: Object.freeze([...row.capabilities.thinkingOptions]),
            thinkingDefault: row.capabilities.thinkingDefault,
            reasoning: row.capabilities.thinkingOptions.length > 0,
            fast: row.capabilities.fastTier !== null,
          } : {}),
          modelScopes: Object.freeze([...row.modelScopes].sort()),
          ...(defaultModelScopes.length > 0
            ? { defaultModelScopes: Object.freeze(defaultModelScopes) }
            : {}),
        });
      }).sort((left, right) => left.name.localeCompare(right.name));
      if (generation !== this._generation || this._state !== "started") {
        throw safeError(null, "SERVICE_UNAVAILABLE");
      }
      this._modelChoices = choices;
      return choices;
    })().finally(() => {
      if (this._modelsRefreshing === refresh) {
        this._modelsRefreshing = null;
        this._modelsRefreshingGeneration = null;
      }
    });
    this._modelsRefreshing = refresh;
    this._modelsRefreshingGeneration = generation;
    return refresh;
  }

  async listCustomEndpoints({ profile } = {}) {
    if (this.id !== "shoggoth") return { supported: false, endpoints: [] };
    return this._call("provider.endpoints.list", { profileId: profile || null });
  }

  async saveCustomEndpoint(endpoint, { profile } = {}) {
    if (this.id !== "shoggoth") throw safeError(null, "INVALID_PARAMS");
    const result = await this._call("provider.endpoints.save", { profileId: profile || null, endpoint });
    this._modelChoices = [];
    if (this._state === "started") await this._refreshManagedProfiles();
    return result;
  }

  async deleteCustomEndpoint(id, { profile } = {}) {
    if (this.id !== "shoggoth") throw safeError(null, "INVALID_PARAMS");
    const result = await this._call("provider.endpoints.delete", { profileId: profile || null, id });
    this._modelChoices = [];
    if (this._state === "started") await this._refreshManagedProfiles();
    return result;
  }

  async validateCustomEndpoint(endpoint = {}, { profile } = {}) {
    if (this.id !== "shoggoth") throw safeError(null, "INVALID_PARAMS");
    return this._call("provider.endpoints.discover", { profileId: profile || null, endpoint });
  }

  async getModels() {
    if (this._state !== "started") return [];
    if (this._modelChoices.length > 0) {
      void this._refreshModels().catch(() => {});
      return this._modelChoices.map((row) => ({ ...row }));
    }
    try {
      const choices = await this._refreshModels();
      return choices.map((row) => ({ ...row }));
    } catch {
      return [];
    }
  }

  async listOAuthProviders() {
    const profiles = [...this._profilesByAgent.values()];
    const accountGroups = new Map();
    for (const profile of profiles) {
      const descriptor = this.runtimeCliAuth.get(profile.runtimeAccountId);
      if (!descriptor || descriptor.runtime !== profile.runtime) continue;
      const existing = accountGroups.get(profile.runtimeAccountId);
      if (existing) existing.profiles.push(profile);
      else accountGroups.set(profile.runtimeAccountId, { descriptor, profiles: [profile] });
    }
    const providers = await Promise.all([...accountGroups.values()].map(async (group) => {
      const { descriptor } = group;
      const accountProfiles = group.profiles.sort((left, right) => (
        Number(right.isDefault) - Number(left.isDefault) || left.id.localeCompare(right.id, "en")
      ));
      const representative = accountProfiles[0];
      let loggedIn = false;
      let statusError = descriptor.binaryPath ? null : descriptor.unavailableReason;
      let statusVerification = null;
      if (descriptor.binaryPath) {
        const presence = descriptor.credentialProbe === "runtime"
          ? { present: true, error: null }
          : managedCredentialPresence(
            descriptor.accountHome,
            descriptor.credentialFile,
            descriptor.accountKind,
          );
        statusError = presence.error;
        if (presence.present) {
          try {
            const verified = await this._call("profile.auth.read", {
              profileId: representative.id,
            });
            loggedIn = verified.status === "authenticated";
            if (verified.status === "unverified") statusVerification = "unverified";
          } catch (error) {
            if (AUTH_STATUS_TRANSIENT_ERROR_CODES.has(error?.code)) {
              // Safe local credential still exists; a transient proof lookup cannot revoke it.
              statusVerification = "unverified";
            } else {
              statusError = "Unable to verify managed CLI authentication";
            }
          }
        }
      }
      const connectedProfiles = accountProfiles.map((profile) => profile.name)
        .sort((left, right) => left.localeCompare(right, "en"));
      return {
        id: descriptor.runtimeAccountId,
        backendId: this.id,
        name: descriptor.name,
        flow: "external",
        cliCommand: runtimeCliCommand(descriptor, descriptor.loginArgs),
        cliRunnable: Boolean(descriptor.binaryPath),
        docsUrl: descriptor.docsUrl,
        disconnectHint: null,
        disconnectCommand: descriptor.binaryPath && descriptor.logoutArgs.length > 0
          ? runtimeCliCommand(descriptor, descriptor.logoutArgs) : null,
        disconnectable: false,
        status: {
          loggedIn,
          source: loggedIn ? "managed-cli" : null,
          sourceLabel: loggedIn ? descriptor.name : null,
          tokenPreview: null,
          expiresAt: null,
          hasRefreshToken: false,
          error: statusError,
          ...(statusVerification ? { verification: statusVerification } : {}),
        },
        connectedProfiles: loggedIn ? connectedProfiles : [],
      };
    }));
    providers.sort((left, right) => left.name.localeCompare(right.name, "en"));
    return { providers, profiles: providers.map((provider) => provider.name) };
  }

  async _lifecycleSnapshot() {
    this._assertDomainReady();
    const result = await this._call("agent.lifecycle.list", { backendId: this.id });
    if (result.agents.some((entry) => !this._acceptsProfileBackend(entry.profile.backendId))) {
      throw safeError(null, "AGENT_RESPONSE_INVALID");
    }
    return result.agents;
  }

  async listAgents(options = {}) {
    const lifecycle = options.lifecycle || (options.archivedOnly ? "archived" : "active");
    if (!["active", "archived", "pending", "all"].includes(lifecycle)) {
      throw safeError(null, "INVALID_PARAMS");
    }
    if (lifecycle === "active") {
      this._assertDomainReady();
      const profiles = [...this._profilesByAgent.values()];
      const accountCounts = runtimeAccountReferenceCounts(profiles);
      return profiles.map((profile) => ({
        ...profileToAgent(profile, this.id, accountCounts.get(profile.runtimeAccountId)),
        isDefault: profile.isDefault === true,
      }));
    }
    const entries = await this._lifecycleSnapshot();
    const accountCounts = runtimeAccountReferenceCounts(entries.map((entry) => entry.profile));
    return entries.filter((entry) => {
      if (lifecycle === "all") return true;
      if (lifecycle === "active") return entry.profile.enabled === true;
      if (lifecycle === "archived") {
        return entry.profile.enabled !== true
          && ["archived", "archive-repair"].includes(entry.state);
      }
      return !["active", "archived"].includes(entry.state);
    }).map((entry) => profileToManagedAgent(
      entry.profile,
      this.id,
      entry.state,
      accountCounts.get(entry.profile.runtimeAccountId),
    ));
  }

  async _refreshManagedProfiles() {
    if (this._profileRefreshPromise) return this._profileRefreshPromise;
    const generation = this._generation;
    let refresh;
    refresh = (async () => {
      const entries = await this._lifecycleSnapshot();
      const profiles = entries.filter((entry) => entry.profile.enabled).map((entry) => entry.profile);
      const connectedAccounts = await this._connectedCliAccounts();
      const sessionsByProfile = await mapBounded(
        profiles, MAX_PROFILE_SESSION_CONCURRENCY, async (profile) => {
          if (connectedAccounts.length) await this._syncCliBindings(profile.id, connectedAccounts);
          const sessions = await this._page("chat.session.list", {
            profileId: profile.id,
            includeArchived: false,
          }, "sessions", {
            maxBytes: MAX_HISTORY_BYTES,
            maxItems: MAX_HISTORY_ITEMS,
          });
          if (sessions.some((session) => session.profileId !== profile.id)) {
            throw safeError(null, "CHAT_RESPONSE_INVALID");
          }
          return { profile, sessions };
        },
      );
      if (generation !== this._generation || this._state !== "started") return false;
      const profilesByAgent = new Map(profiles.map((profile) => [profile.agentId, profile]));
      const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
      const sessionsByKey = new Map();
      const rows = [];
      for (const entry of sessionsByProfile) {
        for (const session of entry.sessions) {
          sessionsByKey.set(session.sessionKey, session);
          rows.push(sessionToRow(this._profileForSession(entry.profile, session), session, this.id));
        }
      }
      // Expire bridge-owned cards before publishing a profile/session snapshot
      // that no longer contains their target. The notifier still observes the
      // old agent roster here, so Proxy can authenticate the exact cleanup.
      for (const [requestId, record] of this._promptByRequest) {
        if (record.federation !== true || sessionsByKey.has(record.sessionKey)) continue;
        const oldProfile = this._profilesById.get(record.federationProfileId);
        if (!oldProfile) continue;
        this._promptByRequest.delete(requestId);
        const active = this._activeBySession.get(record.sessionKey);
        if (active?.runId === record.runId && active.requestId === requestId) {
          this._activeBySession.delete(record.sessionKey);
        }
        try {
          this._sessionActivityNotifier?.({
            kind: "federation.chat.interaction",
            runId: record.runId,
            sessionKey: gatewaySessionKey(oldProfile.agentId, record.sessionKey),
            interaction: {
              phase: "resolved",
              eventType: record.kind === "approval" ? "approval" : "prompt",
              requestId,
              payload: null,
            },
          });
        } catch {
          // Registry/UI listeners are observers and cannot invalidate durable state.
        }
      }
      this._profilesByAgent = profilesByAgent;
      this._profilesById = profilesById;
      this._sessionsByKey = sessionsByKey;
      const accountCounts = runtimeAccountReferenceCounts(profiles);
      this._agents = profiles.map((profile) => profileToAgent(
        profile,
        this.id,
        accountCounts.get(profile.runtimeAccountId),
      ));
      this._rows = rows;
      try { this._readyNotifier?.(); } catch {}
      return true;
    })().finally(() => {
      if (this._profileRefreshPromise === refresh) this._profileRefreshPromise = null;
    });
    this._profileRefreshPromise = refresh;
    return refresh;
  }

  async createAgent(spec = {}) {
    this._assertDomainReady();
    const result = await this._call("agent.create", {
      operationId: spec.operationId || `agent-create-${this.randomUUID()}`,
      backendId: this.id,
      name: spec.name,
      defaultCwd: spec.workspace || null,
      createdAt: spec.createdAt ?? this.now(),
    });
    if (!this._acceptsProfileBackend(result.profile.backendId) || result.profile.enabled !== true) {
      throw safeError(null, "AGENT_RESPONSE_INVALID");
    }
    await this._refreshManagedProfiles();
    const refreshed = this._profilesByAgent.get(result.profile.agentId) || result.profile;
    const sharedAgentCount = [...this._profilesByAgent.values()].filter(
      (profile) => profile.runtimeAccountId === refreshed.runtimeAccountId,
    ).length;
    return profileToManagedAgent(refreshed, this.id, undefined, sharedAgentCount);
  }

  async updateAgent(id, patch = {}) {
    const profile = this._profileForManagedAgent(id);
    const result = await this._call("agent.update", {
      operationId: patch.operationId || `agent-update-${this.randomUUID()}`,
      profileId: profile.id,
      name: Object.hasOwn(patch, "name") ? patch.name : profile.name,
      defaultCwd: Object.hasOwn(patch, "workspace") ? (patch.workspace || null) : profile.defaultCwd,
      expectedUpdatedAt: patch.expectedUpdatedAt ?? profile.updatedAt,
      createdAt: patch.createdAt ?? this.now(),
    });
    if (!this._acceptsProfileBackend(result.profile.backendId) || result.profile.agentId !== id) {
      throw safeError(null, "AGENT_RESPONSE_INVALID");
    }
    await this._refreshManagedProfiles();
    return { id: result.profile.agentId, updatedAt: result.profile.updatedAt };
  }

  async deleteAgent(id, options = {}) {
    const profile = this._profileForManagedAgent(id);
    const result = await this._call("agent.archive", {
      operationId: options.operationId || `agent-archive-${this.randomUUID()}`,
      profileId: profile.id,
      expectedUpdatedAt: options.expectedUpdatedAt ?? profile.updatedAt,
      createdAt: options.createdAt ?? this.now(),
    });
    if (!this._acceptsProfileBackend(result.profile.backendId) || result.profile.agentId !== id
      || result.profile.enabled !== false) throw safeError(null, "AGENT_RESPONSE_INVALID");
    await this._refreshManagedProfiles();
  }

  async restoreAgent(id, options = {}) {
    const entry = (await this._lifecycleSnapshot()).find((item) => item.profile.agentId === id);
    const retryingPendingRestore = entry?.state === "restoring"
      && entry.pendingOperationId === options.operationId;
    if (!entry || (entry.profile.enabled && !retryingPendingRestore)) {
      throw safeError(null, "AGENT_NOT_FOUND");
    }
    const result = await this._call("agent.restore", {
      operationId: options.operationId || `agent-restore-${this.randomUUID()}`,
      profileId: entry.profile.id,
      expectedUpdatedAt: options.expectedUpdatedAt ?? entry.profile.updatedAt,
      createdAt: options.createdAt ?? this.now(),
    });
    if (!this._acceptsProfileBackend(result.profile.backendId) || result.profile.agentId !== id
      || result.profile.enabled !== true) throw safeError(null, "AGENT_RESPONSE_INVALID");
    await this._refreshManagedProfiles();
    const refreshed = this._profilesByAgent.get(result.profile.agentId) || result.profile;
    const sharedAgentCount = [...this._profilesByAgent.values()].filter(
      (profile) => profile.runtimeAccountId === refreshed.runtimeAccountId,
    ).length;
    return profileToManagedAgent(refreshed, this.id, undefined, sharedAgentCount);
  }

  async getAgent(id) {
    this._assertDomainReady();
    const profile = this._profilesByAgent.get(id);
    if (!profile) throw safeError(null, "AGENT_NOT_FOUND");
    const definition = await this._call("harness.definition.meta", { profileId: profile.id });
    const sharedAgentCount = [...this._profilesByAgent.values()].filter(
      (candidate) => candidate.runtimeAccountId === profile.runtimeAccountId,
    ).length;
    return {
      id: profile.agentId,
      name: profile.name,
      ...(profile.defaultModel ? { model: profile.defaultModel } : {}),
      ...((profile.providerRef || profile.runtime)
        ? { provider: profile.providerRef || profile.runtime } : {}),
      runtime: profile.runtime,
      runtimeAccountId: profile.runtimeAccountId,
      environmentKind: DEFAULT_RUNTIME_ACCOUNTS.find((account) => account.id === profile.runtimeAccountId)?.kind,
      sharedAgentCount,
      profile: profile.id,
      ...(profile.defaultCwd ? { workspace: profile.defaultCwd } : {}),
      isDefault: profile.isDefault === true,
      protected: profile.isDefault === true || PROTECTED_NATIVE_PROFILE_IDS.has(profile.id),
      archived: false,
      lifecycleState: "active",
      updatedAt: profile.updatedAt,
      files: definition.files.map((file) => ({
        name: file.name,
        size: definition.current.documents[file.kind]?.byteLength,
        readOnly: file.readOnly,
      })),
      definitionRevision: definition.current.revision,
      backendId: this.id,
    };
  }

  async listSessionArtifacts(agentId, key, { limit = 50 } = {}) {
    const target = this._sessionTarget(key);
    if (target.agentId !== agentId) throw safeError(null, "CHAT_SESSION_INVALID");
    const sinceMs = target.session.createdAt;
    let matched;
    try {
      const runs = await this._page("run.list", {
        profileId: target.profile.id,
        sessionKey: target.sessionKey,
        status: null,
      }, "runs", { maxBytes: MAX_HISTORY_BYTES, maxItems: MAX_HISTORY_ITEMS });
      const events = [];
      const seenCursors = new Set();
      let cursor = 0;
      let bytes = 0;
      let transcriptComplete = false;
      for (let pageIndex = 0; pageIndex < this.maxPages; pageIndex += 1) {
        const result = await this._call("harness.transcript.events", {
          profileId: target.profile.id,
          sessionId: target.session.id,
          cursor,
          limit: 100,
        });
        for (const event of result.items) {
          bytes += encodedBytes(event);
          if (bytes > MAX_HISTORY_BYTES || events.length >= MAX_HISTORY_ITEMS) {
            throw safeError(null, "RESPONSE_TOO_LARGE");
          }
          events.push(event);
        }
        if (!result.hasMore) {
          transcriptComplete = true;
          break;
        }
        if (result.nextCursor === cursor || seenCursors.has(result.nextCursor)) {
          throw safeError(null, "CURSOR_NOT_ADVANCING");
        }
        seenCursors.add(result.nextCursor);
        cursor = result.nextCursor;
      }
      if (!transcriptComplete) throw safeError(null, "PAGE_LIMIT_EXCEEDED");
      const descriptor = this.runtimeCliAuth.get(target.profile.runtimeAccountId);
      const runtimeHome = descriptor?.runtime === target.profile.runtime
        ? descriptor.processHome : os.homedir();
      matched = await collectSessionOutputArtifacts({
        events,
        runs,
        workspace: target.session.workspace,
        runtimeHome,
        sessionCreatedAt: sinceMs,
        agentId,
      });
    } catch {
      return { supported: false, reason: "provenance-unavailable", items: [] };
    }
    const take = Math.min(Math.max(Math.floor(Number(limit) || 50), 1), 100);
    return {
      supported: true,
      approximate: false,
      sinceMs,
      total: matched.length,
      items: matched.slice(0, take),
    };
  }

  _profileForManagedAgent(id) {
    this._assertDomainReady();
    const profile = this._profilesByAgent.get(id);
    if (!profile) throw safeError(null, "AGENT_NOT_FOUND");
    return profile;
  }

  async _agentRuntimeBindings(method, id, input = {}) {
    const profile = this._profileForManagedAgent(id);
    const params = validateAgentBindingParams(method, { profileId: profile.id, ...input });
    const result = await this._call(method, params);
    if (method !== "agent.binding.list") await this._refreshManagedProfiles();
    return { ...result, availability: result.bindings.map((binding) => ({ bindingId: binding.id,
      ...this._bindingAvailability(id, binding.runtime, binding.runtimeAccountId) })) };
  }

  async getAgentRuntimeBindings(id) {
    const profile = this._profileForManagedAgent(id);
    const connectedAccounts = await this._connectedCliAccounts();
    if (connectedAccounts.length) await this._syncCliBindings(profile.id, connectedAccounts);
    return this._rememberBindings(profile.id, await this._agentRuntimeBindings("agent.binding.list", id));
  }
  async getAgentRuntimePolicy(id) {
    return this._call("agent.runtimePolicy.get", { profileId: this._profileForManagedAgent(id).id });
  }
  async compactConversation(id, key, operationId) {
    const profile = this._profileForManagedAgent(id), target = this._sessionTarget(key);
    if (target.profile.id !== profile.id) throw safeError(null, "CHAT_SESSION_INVALID");
    return this._call("chat.context.compact", require("../agent-service/product-context-protocol").validateParams("chat.context.compact",
      { profileId: profile.id, sessionKey: target.sessionKey, operationId }));
  }
  async setAgentRuntimePolicy(id, policy) {
    const params = require("../agent-service/runtime-selection-policy").validateRuntimePolicyParams("agent.runtimePolicy.set",
      { profileId: this._profileForManagedAgent(id).id, policy });
    return this._call("agent.runtimePolicy.set", params);
  }
  addAgentRuntimeBinding(id, spec, { operationId, revision } = {}) {
    return this._agentRuntimeBindings("agent.binding.add", id, { spec, operationId, revision });
  }
  updateAgentRuntimeBinding(id, bindingId, patch, { revision } = {}) {
    return this._agentRuntimeBindings("agent.binding.update", id, { bindingId, patch, revision });
  }
  removeAgentRuntimeBinding(id, bindingId, { revision } = {}) {
    return this._agentRuntimeBindings("agent.binding.remove", id, { bindingId, revision });
  }
  setAgentDefaultBinding(id, bindingId, { revision } = {}) {
    return this._agentRuntimeBindings("agent.binding.setDefault", id, { bindingId, revision });
  }

  async _sessionRuntimeRequest(method, id, key, input = {}) {
    const selectingModel = method === "chat.session.runtime.model.set";
    if (!exactObject(input, method === "chat.session.runtime.switch" || selectingModel
      ? ["bindingId", "revision", "acceptAdjustments", ...(selectingModel ? ["model"] : [])] : [])) {
      throw safeError(null, "INVALID_PARAMS");
    }
    const profile = this._profileForManagedAgent(id);
    const target = this._sessionTarget(key);
    if (target.profile.id !== profile.id) throw safeError(null, "CHAT_SESSION_INVALID");
    const params = validateSessionRuntimeParams(method, { profileId: profile.id, sessionKey: target.sessionKey, ...input });
    const result = await this._call(method, params);
    if (method === "chat.session.runtime.switch" || selectingModel) {
      await this._syncFederationTargetSession({ profileId: profile.id, sessionKey: target.sessionKey }, this._generation);
      this._sessionActivityNotifier?.({ kind: "sessions.changed", sessionKey: key });
    }
    return result;
  }
  getSessionRuntime(id, key) { return this._sessionRuntimeRequest("chat.session.runtime.get", id, key); }

  async getSessionRuntimeModels(id, key) {
    const profile = this._profileForManagedAgent(id);
    if (this._sessionTarget(key).profile.id !== profile.id) throw safeError(null, "CHAT_SESSION_INVALID");
    const bindings = await this.getAgentRuntimeBindings(id);
    const selection = await this._sessionRuntimeRequest("chat.session.runtime.state", id, key);
    const accounts = new Set(await this._connectedCliAccounts());
    const connectedRuntimes = new Set(DEFAULT_RUNTIME_ACCOUNTS.filter(account => accounts.has(account.id)).map(account => account.runtime));
    const names = new Map(require("../runtime-cli-auth").AUTH_SPECS.map(spec => [spec.runtimeAccountId, spec.name]));
    const candidates = bindings.bindings.filter(binding => binding.enabled
      && this._bindingAvailability(id, binding.runtime, binding.runtimeAccountId).available
      && connectedRuntimes.has(binding.runtime));
    // Prefer the conversation's existing Binding for duplicate runtime/accounts;
    // historical Binding rows remain durable but never create duplicate options.
    candidates.sort((a, b) => Number(b.id === selection.bindingId) - Number(a.id === selection.bindingId)
      || Number(b.id === bindings.defaultBindingId) - Number(a.id === bindings.defaultBindingId));
    const unique = candidates.filter((binding, index) => candidates.findIndex(entry => entry.runtime === binding.runtime) === index);
    unique.sort((a, b) => DEFAULT_RUNTIME_ACCOUNTS.findIndex(account => account.runtime === a.runtime)
      - DEFAULT_RUNTIME_ACCOUNTS.findIndex(account => account.runtime === b.runtime));
    const groups = await mapBounded(unique, 3, async binding => {
      const runtimeName = names.get(binding.runtimeAccountId) || binding.runtime;
      const capabilities = this._chatCapabilitiesForProfile({ ...profile, ...binding, id: profile.id });
      try {
        const models = await this._page("profile.binding.models.list", { profileId: profile.id, bindingId: binding.id }, "models",
          { maxBytes: MAX_HISTORY_BYTES, maxItems: 512 });
        return { runtime: binding.runtime, name: runtimeName, available: true, capabilities, models: models.map(model => ({
          id: model.id, name: model.displayName, backendId: this.id, provider: binding.runtime === "codex" ? profile.providerRef || binding.runtime : binding.runtime,
          runtime: binding.runtime, runtimeName, bindingId: binding.id, isDefault: model.isDefault,
          ...(model.capabilities ? { thinkingOptions: model.capabilities.thinkingOptions,
            thinkingDefault: model.capabilities.thinkingDefault, reasoning: model.capabilities.thinkingOptions.length > 0,
            fast: model.capabilities.fastTier !== null } : {}),
        })) };
      } catch { return { runtime: binding.runtime, name: runtimeName, available: false, capabilities, models: [] }; }
    });
    const currentBinding = bindings.bindings.find(binding => binding.id === selection.bindingId);
    return { selection, models: groups.flatMap(group => group.models),
      runtimes: groups.map(({ models: _models, ...group }) => group),
      capabilities: this._chatCapabilitiesForProfile(currentBinding ? { ...profile, ...currentBinding, id: profile.id } : profile) };
  }

  async selectSessionRuntimeModel(id, key, input) {
    if (!exactObject(input, ["bindingId", "model", "revision", "acceptAdjustments"])) throw safeError(null, "INVALID_PARAMS");
    const target = this._sessionTarget(key);
    if (target.profile.agentId !== id) throw safeError(null, "CHAT_SESSION_INVALID");
    validateSessionRuntimeParams("chat.session.runtime.model.set", { ...input, profileId: target.profile.id, sessionKey: target.sessionKey });
    const bindings = await this.getAgentRuntimeBindings(id);
    const binding = bindings.bindings.find(entry => entry.id === input.bindingId);
    if (!binding) throw safeError(null, "AGENT_BINDING_NOT_FOUND");
    this._assertRuntimeEnabled({ agentId: id, ...binding });
    const accounts = await this._connectedCliAccounts();
    if (!DEFAULT_RUNTIME_ACCOUNTS.some(account => accounts.includes(account.id) && account.runtime === binding.runtime)) {
      throw safeError(null, "RUNTIME_NOT_INSTALLED");
    }
    return this._sessionRuntimeRequest("chat.session.runtime.model.set", id, key, input);
  }
  async switchSessionRuntime(id, key, input) {
    if (!exactObject(input, ["bindingId", "revision", "acceptAdjustments"])) throw safeError(null, "INVALID_PARAMS");
    const target = this._sessionTarget(key);
    if (target.profile.agentId !== id) throw safeError(null, "CHAT_SESSION_INVALID");
    validateSessionRuntimeParams("chat.session.runtime.switch", { profileId: target.profile.id, sessionKey: target.sessionKey, ...input });
    const bindings = await this.getAgentRuntimeBindings(id);
    const binding = bindings.bindings.find((entry) => entry.id === input?.bindingId);
    if (binding) this._assertRuntimeEnabled({ agentId: id, ...binding });
    return this._sessionRuntimeRequest("chat.session.runtime.switch", id, key, input);
  }

  _assertSessionRuntimeEnabled(target) {
    let disabled;
    try { disabled = this._getDisabledBackendIds?.() || []; } catch { disabled = []; }
    if (!disabled.length) return;
    return (async () => {
      const sessionRuntime = await this._call("chat.session.runtime.get", { profileId: target.profile.id, sessionKey: target.sessionKey });
      const bindings = await this.getAgentRuntimeBindings(target.profile.agentId);
      const binding = bindings.bindings.find((entry) => entry.id === sessionRuntime.bindingId);
      if (!binding) throw safeError(null, "AGENT_BINDING_NOT_FOUND");
      this._assertRuntimeEnabled({ agentId: target.profile.agentId, ...binding });
    })();
  }

  async getAgentFile(id, file) {
    const profile = this._profileForManagedAgent(id);
    const match = /^([A-Z]+)\.md$/u.exec(file);
    if (!match || !["IDENTITY", "SOUL", "USER", "AGENTS", "TOOLS", "MEMORY"].includes(match[1])) {
      throw safeError(null, "INVALID_PARAMS");
    }
    const result = await this._call("harness.definition.read", {
      profileId: profile.id, kind: match[1], revision: null,
    });
    return { name: file, content: result.content, revision: result.revision, readOnly: result.readOnly };
  }

  async setAgentFile(id, file, content, options = {}) {
    const profile = this._profileForManagedAgent(id);
    const match = /^([A-Z]+)\.md$/u.exec(file);
    if (!match) throw safeError(null, "INVALID_PARAMS");
    const result = await this._call("harness.definition.update", {
      profileId: profile.id,
      kind: match[1],
      content,
      expectedRevision: options.expectedRevision,
      reason: options.reason || "agents-ui",
    });
    return { id, definitionRevision: result.current.revision };
  }

  async getAgentDefinition(id) {
    const profile = this._profileForManagedAgent(id);
    return { supported: true, ...(await this._call("harness.definition.meta", { profileId: profile.id })) };
  }

  async restoreAgentDefinition(id, revision, expectedRevision) {
    const profile = this._profileForManagedAgent(id);
    return this._call("harness.definition.restore", { profileId: profile.id, revision, expectedRevision });
  }

  async exportAgentDefinition(id) {
    const profile = this._profileForManagedAgent(id);
    const meta = await this._call("harness.definition.meta", { profileId: profile.id });
    const documents = {};
    for (const kind of ["IDENTITY", "SOUL", "USER", "AGENTS"]) {
      documents[kind] = (await this._call("harness.definition.read", {
        profileId: profile.id, kind, revision: null,
      })).content;
    }
    return {
      format: "shoggoth-agent-definition-v1", schemaVersion: 1, profileId: profile.id,
      revision: meta.current.revision, documents,
    };
  }

  async importAgentDefinition(id, bundle, expectedRevision) {
    const profile = this._profileForManagedAgent(id);
    const operationId = this.randomUUID();
    for (const kind of ["IDENTITY", "SOUL", "USER", "AGENTS"]) {
      await this._call("harness.definition.import.stage", {
        profileId: profile.id, operationId, kind, content: bundle.documents?.[kind],
        sourceProfileId: bundle.profileId, sourceRevision: bundle.revision,
      });
    }
    const preview = await this._call("harness.definition.import.preview", { profileId: profile.id, operationId });
    const committed = await this._call("harness.definition.import.commit", {
      profileId: profile.id, operationId, expectedRevision,
    });
    return { preview, ...committed };
  }

  async listAgentMemories(id, options = {}) {
    const profile = this._profileForManagedAgent(id);
    return {
      supported: true,
      ...(await this._call("harness.memory.list", {
        profileId: profile.id, status: options.status || null, scope: options.scope || null,
        cursor: options.cursor || 0, limit: options.limit || 50,
      })),
    };
  }

  async mutateAgentMemory(id, action, input) {
    const profile = this._profileForManagedAgent(id);
    if (!["create", "confirm", "update", "delete"].includes(action)) throw safeError(null, "INVALID_PARAMS");
    return this._call(`harness.memory.${action}`, { ...input, profileId: profile.id });
  }

  async listAgentTranscripts(id, options = {}) {
    const profile = this._profileForManagedAgent(id);
    if (!options.sessionId) {
      const result = await this._call("harness.transcript.sessions", {
        profileId: profile.id, cursor: options.cursor || 0, limit: options.limit || 50,
      });
      return { supported: true, ...result };
    }
    const result = await this._call("harness.transcript.events", {
      profileId: profile.id, sessionId: options.sessionId,
      cursor: options.cursor || 0, limit: options.limit || 50,
    });
    return { supported: true, ...result };
  }

  async setAgentTranscriptContext(id, input) {
    const profile = this._profileForManagedAgent(id);
    return this._call("harness.transcript.context.set", { profileId: profile.id, ...input });
  }

  async listAgentTools(id) {
    const profile = this._profileForManagedAgent(id);
    return { supported: true, ...(await this._call("harness.tools.list", { profileId: profile.id })) };
  }

  async setAgentToolPermission(id, input) {
    const profile = this._profileForManagedAgent(id);
    return this._call("harness.tools.permission.set", { profileId: profile.id, ...input });
  }

  async getAgentComputerState(id) {
    const profile = this._profileForManagedAgent(id);
    return {
      supported: true,
      ...(await this._call("harness.computer.status", { profileId: profile.id })),
    };
  }

  _profileForSkills(options = {}) {
    this._assertDomainReady();
    if (typeof options.agentId !== "string" || options.agentId.length === 0) {
      throw safeError(null, "INVALID_PARAMS");
    }
    return this._profileForManagedAgent(options.agentId);
  }

  async getPluginCapabilitiesPage(query = {}) {
    if (!exactObject(query, ["cursor", "limit", "catalogRevision"])
      || !Number.isSafeInteger(query.cursor) || query.cursor < 0
      || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 20
      || (query.catalogRevision !== null
        && (typeof query.catalogRevision !== "string"
          || !/^[a-f0-9]{64}$/u.test(query.catalogRevision)))) {
      throw safeError(null, "INVALID_PARAMS");
    }
    try {
      return await this._call("plugins.capabilities.list", query);
    } catch (error) {
      if (error?.code === "PLUGIN_UNAVAILABLE") {
        return { supported: false, reasonCode: "PLUGIN_UNAVAILABLE",
          catalogRevision: null, items: [], nextCursor: null };
      }
      throw error;
    }
  }

  async previewPluginInstall(source) {
    return this._call("plugins.install.preview", { source });
  }

  async listBundledPlugins() {
    return this._call("plugins.bundled.list", {});
  }

  async previewPluginUninstall(input) { return this._call("plugins.uninstall.preview", input); }
  async uninstallPlugin(input) { return this._call("plugins.uninstall", input); }
  async preparePluginApp(sessionKey, callId) {
    const target = this._sessionTarget(sessionKey);
    return this._call("plugins.apps.prepare", { profileId: target.profile.id,
      conversationId: target.sessionKey, callId });
  }
  async commitPluginApp(input) { return this._call("plugins.apps.commit", input); }
  async readPluginAppChunk(transport, index) { return this._call("plugins.apps.chunk", { transport, index }); }
  async messagePluginApp(transport, message) { return this._call("plugins.apps.message", { transport, message }); }
  async closePluginApp(transport) { return this._call("plugins.apps.close", { transport }); }

  async preparePluginMcpConsent(input) {
    const profile = this._profilesByAgent.get(input.agentId);
    if (!profile) throw safeError(null, "AGENT_NOT_FOUND");
    const { agentId, ...request } = input;
    return this._call("plugins.mcp.consent.prepare", { ...request, profileId: profile.id });
  }

  async preparePluginOAuth(input) {
    const profile = this._profilesByAgent.get(input.agentId);
    if (!profile) throw safeError(null, "AGENT_NOT_FOUND");
    const { agentId, ...request } = input;
    return this._call("plugins.oauth.prepare", { ...request, profileId: profile.id });
  }
  async commitPluginOAuth(input) { return this._call("plugins.oauth.commit", input); }
  async preparePluginDisconnect(input) {
    const profile = this._profilesByAgent.get(input.agentId);
    if (!profile) throw safeError(null, "AGENT_NOT_FOUND");
    const { agentId, ...request } = input;
    return this._call("plugins.connections.prepare", { ...request, profileId: profile.id });
  }
  async commitPluginDisconnect(input) { return this._call("plugins.connections.commit", input); }
  async getPluginDisconnectOperation(agentId, operationId) {
    const profile = this._profilesByAgent.get(agentId);
    if (!profile) throw safeError(null, "AGENT_NOT_FOUND");
    return this._call("plugins.connections.operation", { profileId: profile.id, operationId });
  }
  async previewPluginDependency(input) { return this._call("plugins.dependencies.preview", input); }
  async commitPluginDependency(input) { return this._call("plugins.dependencies.commit", input); }
  async getPluginDependencyStatus(input) { return this._call("plugins.dependencies.status", input); }
  async getPluginDependencyOperation(operationId) { return this._call("plugins.dependencies.operation", { operationId }); }
  async listPluginRollback(input) { return this._call("plugins.rollback.list", input); }
  async preparePluginRollback(input) { return this._call("plugins.rollback.prepare", input); }
  async commitPluginRollback(input) { return this._call("plugins.rollback.commit", input); }
  async getPluginRollbackOperation(input) { return this._call("plugins.rollback.operation", input); }
  async getPluginOAuthStatus(agentId, flowId) {
    const profile = this._profilesByAgent.get(agentId);
    if (!profile) throw safeError(null, "AGENT_NOT_FOUND");
    return this._call("plugins.oauth.status", { profileId: profile.id, flowId });
  }
  async cancelPluginOAuth(agentId, flowId) {
    const profile = this._profilesByAgent.get(agentId);
    if (!profile) throw safeError(null, "AGENT_NOT_FOUND");
    return this._call("plugins.oauth.cancel", { profileId: profile.id, flowId });
  }

  async commitPluginMcpConsent(input) {
    return this._call("plugins.mcp.consent.commit", input);
  }

  async discoverPluginMcpTools(agentId, bindingId) {
    const profile = this._profilesByAgent.get(agentId);
    if (!profile) throw safeError(null, "AGENT_NOT_FOUND");
    return this._call("plugins.mcp.discover", { profileId: profile.id, bindingId });
  }

  async installPlugin(input) {
    return this._call("plugins.install", input);
  }

  async getPluginOperation(operationId) {
    return this._call("plugins.operations.get", { operationId });
  }

  async setPluginInstallationState(input) {
    return this._call("plugins.installations.set", input);
  }

  async getPluginSkillBindings(agentId) {
    const profile = this._profilesByAgent.get(agentId);
    if (!profile) throw safeError(null, "AGENT_NOT_FOUND");
    return this._call("plugins.skills.bindings.list", { profileId: profile.id });
  }

  async getPluginMcpStatus(agentId, installationId) {
    const profile = this._profilesByAgent.get(agentId);
    if (!profile) throw safeError(null, "AGENT_NOT_FOUND");
    return this._call("plugins.mcp.status", { profileId: profile.id,
      installationId });
  }

  async getPluginMcpTools(agentId, bindingId) {
    const profile = this._profilesByAgent.get(agentId);
    if (!profile) throw safeError(null, "AGENT_NOT_FOUND");
    return this._call("plugins.mcp.tools.list", { profileId: profile.id,
      bindingId });
  }

  async revokePluginMcpGrant(input) {
    const profile = this._profilesByAgent.get(input.agentId);
    if (!profile) throw safeError(null, "AGENT_NOT_FOUND");
    return this._call("plugins.mcp.grants.revoke", {
      profileId: profile.id, bindingId: input.bindingId,
      toolIdentity: input.toolIdentity, expectedRevision: input.expectedRevision,
      operationId: input.operationId,
    });
  }

  async revokeAllPluginMcpGrants(input) {
    const profile = this._profilesByAgent.get(input.agentId);
    if (!profile) throw safeError(null, "AGENT_NOT_FOUND");
    return this._call("plugins.mcp.grants.revoke-all", {
      profileId: profile.id, bindingId: input.bindingId,
      expectedRevision: input.expectedRevision, operationId: input.operationId,
    });
  }

  async setPluginSkillBinding(input) {
    const profile = this._profilesByAgent.get(input.agentId);
    if (!profile) throw safeError(null, "AGENT_NOT_FOUND");
    return this._call("plugins.skills.bindings.set", {
      profileId: profile.id, installationId: input.installationId,
      componentId: input.componentId, enabled: input.enabled,
      expectedRevision: input.expectedRevision, operationId: input.operationId,
    });
  }

  async _nativeSkills(profile) {
    const items = [];
    let cursor = 0;
    let registryRevision = null;
    let registryVersion = null;
    let profileRevision = null;
    for (let pageIndex = 0; pageIndex < this.maxPages; pageIndex += 1) {
      const result = await this._call("harness.skills.list", {
        profileId: profile.id,
        cursor,
        limit: MAX_PAGE_LIMIT,
      });
      if (registryRevision !== null && (registryRevision !== result.registryRevision
        || registryVersion !== result.registryVersion || profileRevision !== result.profileRevision)) {
        throw safeError(null, "HARNESS_REVISION_CONFLICT");
      }
      registryRevision = result.registryRevision;
      registryVersion = result.registryVersion;
      profileRevision = result.profileRevision;
      items.push(...result.items);
      if (!result.hasMore) return { items, registryRevision, registryVersion, profileRevision };
      if (result.nextCursor <= cursor) throw safeError(null, "INCOMPLETE_RESPONSE");
      cursor = result.nextCursor;
    }
    throw safeError(null, "INCOMPLETE_RESPONSE");
  }

  async getSkills(options = {}) {
    const profile = this._profileForSkills(options);
    const value = await this._nativeSkills(profile);
    return value.items.map((skill) => ({
      name: skill.name,
      description: skill.description,
      enabled: skill.enabled,
      backendId: this.id,
      category: skill.source === "builtin" ? "Shoggoth built-in" : "Shoggoth native",
      emoji: "🧩",
      id: skill.id,
      version: skill.version,
      source: skill.source,
      globalEnabled: skill.globalEnabled,
      contentHash: skill.contentHash,
      requiredTools: skill.requiredTools,
      requiredRuntimeCapabilities: skill.requiredRuntimeCapabilities,
      sourceCompatibility: skill.sourceCompatibility,
      eligible: skill.eligible,
      ineligibleReason: skill.ineligibleReason,
      profileId: profile.id,
      agentId: profile.agentId,
      registryRevision: value.registryRevision,
      registryVersion: value.registryVersion,
      profileRevision: value.profileRevision,
    }));
  }

  _resolveNativeSkill(items, name, identity = {}) {
    const matches = items.filter((item) => item.name === name
      && (!identity.id || identity.id === item.id)
      && (!identity.source || identity.source === item.source)
      && (!identity.version || identity.version === item.version));
    if (matches.length > 1) throw safeError(null, "SKILL_IDENTITY_AMBIGUOUS");
    if (matches.length === 0) throw safeError(null, "SKILL_NOT_FOUND");
    return matches[0];
  }

  async updateSkill(name, patch, options = {}) {
    const profile = this._profileForSkills({ agentId: options.agentId || patch.agentId });
    if (typeof patch.enabled !== "boolean") throw safeError(null, "INVALID_PARAMS");
    const current = await this._nativeSkills(profile);
    const skill = this._resolveNativeSkill(current.items, name, patch);
    const global = skill.source === "user";
    const result = await this._call(global ? "harness.skills.global.set" : "harness.skills.enable", {
      profileId: profile.id,
      skillId: skill.id,
      source: skill.source,
      version: skill.version,
      enabled: patch.enabled,
      expectedRevision: global ? patch.expectedRevision ?? current.registryVersion
        : patch.expectedRevision ?? current.profileRevision,
    });
    return { ...skill, ...result.skill, backendId: this.id,
      profileRevision: global ? current.profileRevision : result.profileRevision,
      registryVersion: global ? result.registryRevision : current.registryVersion };
  }

  async installSkill(sourcePath, options = {}) {
    const profile = this._profileForSkills(options);
    const current = await this._nativeSkills(profile);
    return this._call("harness.skills.install", {
      profileId: profile.id,
      sourcePath,
      operationId: options.operationId || `skill-install-${this.randomUUID()}`,
      expectedRevision: options.expectedRevision || current.registryVersion,
    });
  }

  async uninstallSkill(name, options = {}) {
    const profile = this._profileForSkills(options);
    const current = await this._nativeSkills(profile);
    const skill = this._resolveNativeSkill(current.items, name, options);
    if (skill.source !== "user") throw safeError(null, "SKILL_NOT_FOUND");
    return this._call("harness.skills.uninstall", {
      profileId: profile.id,
      skillId: skill.id,
      source: "user",
      version: skill.version,
      expectedRevision: options.expectedRevision || current.registryVersion,
    });
  }

  async previewSkill(name, options = {}) {
    const profile = this._profileForSkills(options);
    const current = await this._nativeSkills(profile);
    const skill = this._resolveNativeSkill(current.items, name, options);
    return this._call("harness.skills.preview", {
      profileId: profile.id,
      skillId: skill.id,
      source: skill.source,
      version: skill.version,
      cursor: 0,
      maxBytes: 32 * 1024,
    });
  }

  async getSkillUsage() {
    this._assertDomainReady();
    const skills = {};
    for (const profile of this._profilesByAgent.values()) {
      const result = await this._call("harness.skills.usage", { profileId: profile.id });
      for (const [name, counts] of Object.entries(result.skills)) {
        skills[name] ||= {};
        const count = counts[profile.id] || 0;
        if (count > 0) skills[name][profile.agentId] = count;
      }
    }
    return { supported: true, skills };
  }

  async getUsageSeries(range = "30d") {
    this._assertDomainReady();
    return this._call("usage.series", { range: validateUsageRange(range), backendId: this.id });
  }

  async getUsageBreakdown(range = "30d") {
    this._assertDomainReady();
    return this._call("usage.breakdown", { range: validateUsageRange(range), backendId: this.id });
  }

  async getModelCatalogSources({ fresh = true } = {}) {
    // The revision API must await discovery and propagate failures. getModels is
    // the legacy best-effort path and may return an older cache immediately.
    const models = fresh ? await this._refreshModels() : await this.getModels();
    return {
      models: models.map((row) => ({ ...row })),
      config: [],
      runtime: models.map((row) => ({ ...row })),
    };
  }

  getSessionRows() { return [...this._rows]; }

  getSessionRowsSnapshot() {
    return { rows: this.getSessionRows(), complete: this._complete };
  }

  getChatCapabilities(agentId) {
    const profile = this._profilesByAgent.get(agentId);
    if (!profile) {
      return {
        attachments: {},
        slash: false,
        notReady: this.claimsAgentId(agentId),
      };
    }
    return this._chatCapabilitiesForProfile(profile);
  }

  _chatCapabilitiesForProfile(profile) {
    return {
      attachments: structuredClone(CHAT_ATTACHMENT_CAPABILITIES),
      maxPromptBytes: CHAT_MAX_PROMPT_BYTES,
      maxAttachmentBytes: 50 * 1024 * 1024,
      maxAttachments: 8,
      slash: NATIVE_SLASH_RUNTIMES.has(profile.runtime),
      steer: NATIVE_STEER_RUNTIMES.has(profile.runtime),
      modelProvider: profile.runtime === "codex" ? profile.providerRef || profile.runtime : profile.runtime,
      modelScope: profile.id,
      permissions: {
        scope: "session",
        apply: "next-turn",
        defaultMode: defaultRuntimePermissionMode(profile.runtime || "codex", profile.permissionPolicy),
        options: runtimePermissionModeOptions(profile.runtime || "codex"),
      },
    };
  }

  async listSlashCommands(agentId, key) {
    const profile = this._profilesByAgent.get(agentId);
    if (!profile) {
      return { supported: false, reason: "unsupported", commands: [] };
    }
    if (typeof key !== "string" || key.length === 0) {
      return { supported: false, reason: "session-required", commands: [] };
    }
    const target = this._sessionTarget(key);
    if (target.profile.id !== profile.id) throw safeError(null, "CHAT_SESSION_INVALID");
    if (!NATIVE_SLASH_RUNTIMES.has(this._profileForSession(profile, target.session).runtime)) {
      return { supported: false, reason: "unsupported", commands: [] };
    }
    return this._call("chat.command.list", { sessionKey: target.sessionKey });
  }

  async execSlash(agentId, key, text) {
    const profile = this._profilesByAgent.get(agentId);
    if (!profile) {
      throw safeError(null, "RUNTIME_CAPABILITY_UNSUPPORTED");
    }
    const target = this._sessionTarget(key);
    if (!NATIVE_SLASH_RUNTIMES.has(this._profileForSession(profile, target.session).runtime)) {
      throw safeError(null, "RUNTIME_CAPABILITY_UNSUPPORTED");
    }
    await this._assertSessionRuntimeEnabled(target);
    if (target.profile.id !== profile.id || !safeString(text, MAX_ITEM_BYTES)
      || !text.trimStart().startsWith("/")) {
      throw safeError(null, "INVALID_PARAMS");
    }
    return this._call("chat.command.exec", { sessionKey: target.sessionKey, text });
  }

  _sessionTarget(key) {
    const parsed = parseGatewaySessionKey(key);
    const profile = this._profilesByAgent.get(parsed.agentId);
    const session = this._sessionsByKey.get(parsed.sessionKey);
    if (!profile || !session || session.profileId !== profile.id) {
      throw safeError(null, "CHAT_SESSION_INVALID");
    }
    return { ...parsed, profile, session };
  }

  _assertRunBinding(target, run) {
    const matchesSource = run?.source === "chat" ? run.sourceId === target.sessionKey
      : run?.source === "cron" ? target.session?.cronJobId === run.sourceId
        && target.session.cronRunIds?.includes(run.id) && target.session.workspace === run.workspace
      : run?.source === "inspiration" && target.session?.inspirationId === run.sourceId
        && target.session.workspace === run.workspace;
    if (!run || !matchesSource
      || run.profileId !== target.profile.id) {
      throw safeError(null, "WORK_RUN_CONTROL_MISMATCH");
    }
    return run;
  }

  _clearSessionRuntime(sessionKey, runId = null) {
    const active = this._activeBySession.get(sessionKey);
    if (runId === null || active?.runId === runId) this._activeBySession.delete(sessionKey);
    for (const [requestId, record] of this._promptByRequest) {
      if (record.sessionKey === sessionKey && (runId === null || record.runId === runId)) {
        this._promptByRequest.delete(requestId);
      }
    }
  }

  _invokeHook(hooks, name, ...args) {
    try { hooks?.[name]?.(...args); } catch { /* consumer failure must not alter transport */ }
  }

  async _call(method, params, options = {}) {
    let token;
    try {
      let timeoutMs = ENCRYPTED_MUTATION_METHODS.has(method)
        ? ENCRYPTED_MUTATION_TIMEOUT_MS : SERVICE_TIMEOUT_MS;
      if (RUNTIME_COMMAND_METHODS.has(method)) timeoutMs = RUNTIME_COMMAND_TIMEOUT_MS;
      if (SESSION_RUNTIME_METHODS.includes(method)) timeoutMs = 12_000;
      // Discovery may start/authenticate a native CLI and query its catalog. The
      // ordinary 5-second control budget is shorter than the runtime's own deadline.
      if (method === "profile.models.list" || method === "profile.binding.models.list"
        || method === "chat.session.runtime.model.set") timeoutMs = MODEL_CATALOG_TIMEOUT_MS;
      if (method === "plugins.install.preview" || method === "plugins.install"
        || method === "plugins.installations.set" || method === "plugins.mcp.discover"
        || method === "plugins.uninstall" || method.startsWith("plugins.apps.")
        || method.startsWith("plugins.dependencies.") || method.startsWith("plugins.connections.") || method.startsWith("plugins.rollback.")) {
        timeoutMs = PLUGIN_INSTALL_TIMEOUT_MS;
      }
      if (method === "plugins.oauth.commit") timeoutMs = 60_000;
      if (["plugins.install.preview", "plugins.install"].includes(method)
        && params.source?.kind === "remote-git") timeoutMs = 120_000;
      if (method === "inspiration.media.read" && params.preview === true) timeoutMs = 125_000;
      if (options.timeoutMs !== undefined) {
        if (method !== "service.status" || !Number.isSafeInteger(options.timeoutMs)
          || options.timeoutMs < 1 || options.timeoutMs > DEFAULT_SERVICE_STATUS_TIMEOUT_MS) {
          throw Object.assign(new TypeError("invalid service.status timeout"), {
            code: "SERVICE_UNAVAILABLE",
          });
        }
        timeoutMs = options.timeoutMs;
      }
      token = this.readToken(this.paths);
      if (typeof token !== "string" || token.length === 0 || token.length > 1024) {
        throw Object.assign(new Error("invalid token"), { code: "SERVICE_UNAVAILABLE" });
      }
      const value = await this.requestService(this.paths, {
        id: this.randomUUID(),
        token,
        version: SERVICE_PROTOCOL_VERSION,
        method,
        params,
      }, {
        timeoutMs,
      });
      return validateServiceResult(method, value, params);
    } catch (error) {
      throw safeError(error);
    } finally {
      token = null;
    }
  }

  async _page(method, params, field, options = {}) {
    const newestFirst = options.newestFirst === true;
    const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0
      ? options.maxBytes : Infinity;
    const maxItems = Number.isSafeInteger(options.maxItems) && options.maxItems > 0
      ? options.maxItems : Infinity;
    const values = [];
    const seenCursors = new Set();
    let accumulatedBytes = 0;
    let cursor = null;
    for (let pageIndex = 0; pageIndex < this.maxPages; pageIndex += 1) {
      const result = await this._call(method, { ...params, cursor, limit: options.pageLimit ?? MAX_PAGE_LIMIT });
      let pageItems = 0;
      for (const item of result[field]) {
        let itemBytes;
        try { itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8"); } catch {
          throw safeError(null, "CHAT_RESPONSE_INVALID");
        }
        accumulatedBytes += itemBytes;
        pageItems += 1;
        if (accumulatedBytes > maxBytes || values.length + pageItems > maxItems) {
          throw safeError(null, method === "chat.history"
            ? "CHAT_HISTORY_TOO_LARGE" : "RESPONSE_TOO_LARGE");
        }
      }
      if (newestFirst) values.unshift(...result[field]);
      else values.push(...result[field]);
      if (!result.hasMore) return values;
      if (result.nextCursor === null || result.nextCursor === cursor
        || seenCursors.has(result.nextCursor)) {
        throw safeError(null, "CURSOR_NOT_ADVANCING");
      }
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw safeError(null, "PAGE_LIMIT_EXCEEDED");
  }

  _assertDomainReady() {
    if (this._state !== "started") throw safeError(null, "BACKEND_NOT_READY");
  }

  _assertDomainAggregate(values, currentBytes = 0, currentItems = 0) {
    let bytes = currentBytes;
    let items = currentItems;
    for (const value of values) {
      bytes += encodedBytes(value);
      items += 1;
      if (bytes > MAX_DOMAIN_AGGREGATE_BYTES || items > MAX_DOMAIN_AGGREGATE_ITEMS) {
        throw safeError(null, "RESPONSE_TOO_LARGE");
      }
    }
    return { bytes, items };
  }

  async _domainPage(method, params, field, options = {}) {
    this._assertDomainReady();
    return this._page(method, params, field, {
      maxBytes: options.maxBytes || MAX_DOMAIN_AGGREGATE_BYTES,
      maxItems: options.maxItems || MAX_DOMAIN_AGGREGATE_ITEMS,
      newestFirst: options.newestFirst === true,
    });
  }

  async _readDomainContent(method, params, expectedMeta = null) {
    this._assertDomainReady();
    const chunks = [];
    const cursors = new Set();
    let cursor = null;
    let totalBytes = null;
    let sha256 = null;
    let offsetBytes = 0;
    for (let pageIndex = 0; pageIndex < this.maxPages; pageIndex += 1) {
      const result = await this._call(method, {
        ...params,
        cursor,
        maxBytes: MAX_CONTENT_READ_BYTES,
      });
      if (result.offsetBytes !== offsetBytes) throw safeError(null, "CONTENT_CURSOR_INVALID");
      if (totalBytes === null) {
        totalBytes = result.totalBytes;
        sha256 = result.sha256;
        if (totalBytes > MAX_DOMAIN_CONTENT_BYTES) throw safeError(null, "CONTENT_TOO_LARGE");
        if (expectedMeta && (expectedMeta.byteLength !== totalBytes || expectedMeta.sha256 !== sha256)) {
          throw safeError(null, "RESOURCE_CHANGED");
        }
      } else if (result.totalBytes !== totalBytes || result.sha256 !== sha256) {
        throw safeError(null, "RESOURCE_CHANGED");
      }
      chunks.push(result.text);
      offsetBytes += Buffer.byteLength(result.text, "utf8");
      if (offsetBytes > totalBytes || offsetBytes > MAX_DOMAIN_CONTENT_BYTES) {
        throw safeError(null, "CONTENT_TOO_LARGE");
      }
      if (!result.hasMore) {
        if (offsetBytes !== totalBytes) throw safeError(null, "CONTENT_CURSOR_INVALID");
        const content = chunks.join("");
        if (crypto.createHash("sha256").update(content, "utf8").digest("hex") !== sha256) {
          throw safeError(null, "RESOURCE_CHANGED");
        }
        return content;
      }
      if (result.nextCursor === null || result.nextCursor === cursor
        || cursors.has(result.nextCursor)) {
        throw safeError(null, "CURSOR_NOT_ADVANCING");
      }
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw safeError(null, "PAGE_LIMIT_EXCEEDED");
  }

  _stopServiceEventPolling({ resetCursor = true } = {}) {
    if (this._serviceEventPollTimer) {
      clearTimeout(this._serviceEventPollTimer);
      this._serviceEventPollTimer = null;
    }
    this._serviceEventPollGeneration = null;
    if (resetCursor) this._serviceEventCursor = 0;
  }

  _scheduleServiceEventPoll(generation, delayMs) {
    if (generation !== this._generation || this._state !== "started"
      || this._sessionActivityNotifier === null || this._serviceEventPollTimer) return;
    this._serviceEventPollGeneration = generation;
    this._serviceEventPollTimer = setTimeout(() => {
      this._serviceEventPollTimer = null;
      void this._pollServiceEvents(generation);
    }, delayMs);
    if (typeof this._serviceEventPollTimer.unref === "function") {
      this._serviceEventPollTimer.unref();
    }
  }

  async _syncFederationTargetSession(payload, generation, options = {}) {
    let profile = this._profilesById.get(payload.profileId);
    if (!profile) {
      await this._refreshManagedProfiles();
      profile = this._profilesById.get(payload.profileId);
    }
    if (generation !== this._generation || this._state !== "started") return null;
    // Every native facade consumes the same Service event stream. Activity for
    // another facade is normal topology, not a retryable failure: skip it while
    // still advancing this facade's cursor so later events cannot be head-of-line
    // blocked behind an unrelated profile.
    if (!profile) return null;
    const target = {
      profile,
      sessionKey: gatewaySessionKey(profile.agentId, payload.sessionKey),
      liveSession: false,
    };
    const sessions = await this._page("chat.session.list", {
      profileId: profile.id,
      includeArchived: false,
    }, "sessions", {
      maxBytes: MAX_HISTORY_BYTES,
      maxItems: MAX_HISTORY_ITEMS,
    });
    if (generation !== this._generation || this._state !== "started") return null;
    if (sessions.some((value) => value.profileId !== profile.id)) {
      throw safeError(null, "CHAT_RESPONSE_INVALID");
    }
    const session = sessions.find((value) => value.sessionKey === payload.sessionKey);
    // A deleted/archived target makes its historical observer event an orphan.
    // Requested cards require a live row. Cleanup can still use the immutable
    // profile/session identity so Proxy does not replay a card forever.
    if (!session) return options.allowMissingSession === true ? target : null;
    this._upsertSession(profile, session);
    return { ...target, liveSession: true };
  }

  async _federationInteractionSnapshot(run) {
    for (const streamId of RUN_RECONCILE_STREAM_IDS) {
      const result = await this._call("run.subscribe", {
        runId: run.id,
        streamId,
        afterSeq: 0,
        limit: MAX_PAGE_LIMIT,
      });
      if (result.runId !== run.id) throw safeError(null, "WORK_RUN_CONTROL_MISMATCH");
      // A fixed stream id can theoretically equal the real one. The second id
      // cannot equal that same stream, so it deterministically forces an
      // authoritative reset snapshot without consuming the run event history.
      if (result.gap === null) continue;
      const current = runFromSnapshot(result.snapshot, run.id);
      if (!current) throw safeError(null, "CHAT_RESPONSE_INVALID");
      if (!["chat", "inspiration", "cron"].includes(current.source) || current.profileId !== run.profileId
        || current.sourceId !== run.sourceId || current.idempotencyKey !== run.idempotencyKey
        || (current.source === "chat" && !NATIVE_FEDERATION_CHAT_RUN_PATTERN.test(current.idempotencyKey))) {
        throw safeError(null, "WORK_RUN_CONTROL_MISMATCH");
      }
      if (!["waiting_approval", "waiting_input"].includes(current.status)
        || !safeString(current.waitingRequestId, 128)) return null;
      const eventType = current.status === "waiting_approval" ? "approval" : "prompt";
      const request = interactionFromSnapshot(
        result.snapshot,
        current.id,
        current.waitingRequestId,
        eventType,
      );
      if (!request) return null;
      return {
        run: current,
        eventType,
        request,
        payload: structuredClone(result.snapshot.interaction.payload),
      };
    }
    throw safeError(null, "CHAT_RESPONSE_INVALID");
  }

  async _reconcileFederationInteractions(generation) {
    const pendingRuns = [];
    let aggregate = { bytes: 0, items: 0 };
    for (const profile of this._profilesById.values()) {
      for (const status of ["waiting_approval", "waiting_input"]) {
        const scoped = await this._page("run.list", {
          profileId: profile.id,
          sessionKey: null,
          status,
        }, "runs", {
          maxBytes: MAX_DOMAIN_AGGREGATE_BYTES,
          maxItems: MAX_DOMAIN_AGGREGATE_ITEMS,
        });
        if (scoped.some((run) => run.profileId !== profile.id || run.status !== status)) {
          throw safeError(null, "CHAT_RESPONSE_INVALID");
        }
        aggregate = this._assertDomainAggregate(scoped, aggregate.bytes, aggregate.items);
        pendingRuns.push(...scoped.filter((run) => ["inspiration", "cron"].includes(run.source) || (run.source === "chat"
          && NATIVE_FEDERATION_CHAT_RUN_PATTERN.test(run.idempotencyKey))));
      }
    }

    const gathered = [];
    for (const run of pendingRuns) {
      let snapshot;
      try {
        snapshot = await this._federationInteractionSnapshot(run);
      } catch (error) {
        if (error?.code === "WORK_RUN_NOT_FOUND") continue;
        if (error?.code === "RUN_EVENT_SNAPSHOT_TOO_LARGE"
          && run.status === "waiting_approval" && safeString(run.waitingRequestId, 128)) {
          const payload = {
            requestId: run.waitingRequestId,
            method: "redacted",
            kind: "permissions",
            reason: "审批详情无法安全完整显示，只能拒绝或取消",
            sessionApprovalAvailable: false,
            expiresAt: null,
            redacted: true,
          };
          snapshot = {
            run,
            eventType: "approval",
            request: normalizeInteractiveRequestV1({
              runId: run.id,
              eventType: "approval",
              payload,
              expiresAt: null,
            }),
            payload,
          };
        } else if (error?.code === "RUN_EVENT_SNAPSHOT_TOO_LARGE") {
          continue;
        } else {
          throw error;
        }
      }
      if (!snapshot) continue;
      let rawSessionKey = snapshot.run.sourceId;
      if (snapshot.run.source === "inspiration") {
        const result = await this._call("inspiration.executions", {
          id: snapshot.run.sourceId, cursor: null, limit: 1,
        });
        const execution = result.executions[0];
        if (!execution || execution.runId !== snapshot.run.id || execution.profileId !== snapshot.run.profileId
          || execution.workspace !== snapshot.run.workspace || execution.sessionKey === null) {
          throw safeError(null, "INSPIRATION_BINDING_INVALID");
        }
        rawSessionKey = execution.sessionKey;
      }
      if (snapshot.run.source === "cron") {
        const sessions = await this._page("chat.session.list", {
          profileId: snapshot.run.profileId, includeArchived: false,
        }, "sessions", { maxBytes: MAX_HISTORY_BYTES, maxItems: MAX_HISTORY_ITEMS });
        const session = sessions.find((item) => item.cronJobId === snapshot.run.sourceId
          && item.cronRunIds?.includes(snapshot.run.id) && item.workspace === snapshot.run.workspace);
        if (!session) continue;
        rawSessionKey = session.sessionKey;
      }
      const target = await this._syncFederationTargetSession({
        profileId: snapshot.run.profileId,
        sessionKey: rawSessionKey,
      }, generation);
      if (generation !== this._generation || this._state !== "started") return false;
      if (!target) continue;
      gathered.push({
        runId: snapshot.run.id,
        profileId: snapshot.run.profileId,
        rawSessionKey,
        sessionKey: target.sessionKey,
        eventType: snapshot.eventType,
        requestId: snapshot.run.waitingRequestId,
        payload: snapshot.payload,
        request: snapshot.request,
      });
    }
    if (generation !== this._generation || this._state !== "started") return false;

    // Only bridge-owned prompt state is replaced. Ordinary prompts observed by
    // an open chat watcher share these maps and must survive Service-event repair.
    for (const [requestId, record] of this._promptByRequest) {
      if (record.federation !== true) continue;
      this._promptByRequest.delete(requestId);
      const active = this._activeBySession.get(record.sessionKey);
      if (active?.runId === record.runId && active.requestId === requestId) {
        this._activeBySession.delete(record.sessionKey);
      }
    }
    try {
      this._sessionActivityNotifier?.({ kind: "federation.chat.interaction.reset" });
    } catch {
      // Registry/UI listeners are observers and cannot invalidate durable state.
    }
    for (const item of gathered) {
      const record = this._rememberPrompt(
        item.rawSessionKey,
        item.runId,
        item.payload,
        item.eventType === "approval" ? "approval" : "input",
        item.request,
      );
      if (!record) continue;
      record.federation = true;
      record.federationProfileId = item.profileId;
      try {
        this._sessionActivityNotifier?.({
          kind: "federation.chat.interaction",
          runId: item.runId,
          sessionKey: item.sessionKey,
          interaction: {
            phase: "requested",
            eventType: item.eventType,
            requestId: item.requestId,
            payload: structuredClone(item.payload),
          },
        });
      } catch {
        // Registry/UI listeners are observers and cannot invalidate durable state.
      }
    }
    return true;
  }

  async _applyFederationTerminalActivity(payload, generation) {
    const target = await this._syncFederationTargetSession(payload, generation, {
      allowMissingSession: true,
    });
    if (!target || generation !== this._generation || this._state !== "started") return;
    this._clearSessionRuntime(payload.sessionKey, payload.runId);
    try {
      if (!target.liveSession) {
        this._sessionActivityNotifier?.({
          kind: "federation.chat.interaction.clear",
          runId: payload.runId,
          sessionKey: target.sessionKey,
        });
        return;
      }
      this._sessionActivityNotifier?.({
        kind: "federation.chat.terminal",
        runId: payload.runId,
        sessionKey: target.sessionKey,
        status: payload.status,
        result: payload.result,
        errorCode: payload.errorCode,
        finishedAt: payload.finishedAt,
        ...(this._sessionsByKey.get(payload.sessionKey)?.cronJobId ? { notificationCategory: "cron" }
          : this._sessionsByKey.get(payload.sessionKey)?.inspirationId ? { notificationCategory: "inspiration" } : {}),
      });
    } catch {
      // Registry/UI listeners are observers and cannot invalidate durable state.
    }
  }

  async _applyFederationInteractionActivity(payload, generation) {
    const { interaction } = payload;
    const target = await this._syncFederationTargetSession(payload, generation, {
      allowMissingSession: interaction.phase === "resolved",
    });
    if (!target || generation !== this._generation || this._state !== "started") return;
    if (interaction.phase === "requested") {
      let request;
      try {
        request = normalizeInteractiveRequestV1({
          runId: payload.runId,
          eventType: interaction.eventType,
          payload: interaction.payload,
          expiresAt: interaction.payload.expiresAt ?? null,
        });
      } catch {
        // Malformed observer events are skipped without pinning the shared
        // Service cursor. Redacted approvals normalize to deny/cancel only.
        return;
      }
      let current;
      try {
        current = (await this._call("run.get", { runId: payload.runId })).run;
      } catch (error) {
        if (error?.code === "WORK_RUN_NOT_FOUND") return;
        throw error;
      }
      if (generation !== this._generation || this._state !== "started") return;
      const waitingStatus = interaction.eventType === "approval"
        ? "waiting_approval" : "waiting_input";
      const sourceMatches = current.source === "chat" ? current.sourceId === payload.sessionKey
        : current.source === "cron" ? this._sessionsByKey.get(payload.sessionKey)?.cronJobId === current.sourceId
          && this._sessionsByKey.get(payload.sessionKey)?.cronRunIds?.includes(current.id)
        : current.source === "inspiration" && this._sessionsByKey.get(payload.sessionKey)?.inspirationId === current.sourceId;
      if (current.id !== payload.runId || !sourceMatches
        || current.profileId !== payload.profileId
        || current.status !== waitingStatus
        || current.waitingRequestId !== interaction.requestId) return;
      const record = this._rememberPrompt(
        payload.sessionKey,
        payload.runId,
        interaction.payload,
        interaction.eventType === "approval" ? "approval" : "input",
        request,
      );
      if (record) {
        record.federation = true;
        record.federationProfileId = payload.profileId;
      }
    } else {
      const prompt = this._promptByRequest.get(interaction.requestId);
      if (prompt?.sessionKey === payload.sessionKey && prompt.runId === payload.runId) {
        this._promptByRequest.delete(interaction.requestId);
      }
      const active = this._activeBySession.get(payload.sessionKey);
      if (active?.runId === payload.runId && active.requestId === interaction.requestId) {
        this._activeBySession.delete(payload.sessionKey);
      }
    }
    try {
      this._sessionActivityNotifier?.({
        kind: "federation.chat.interaction",
        runId: payload.runId,
        sessionKey: target.sessionKey,
        interaction: structuredClone(interaction),
      });
    } catch {
      // Registry/UI listeners are observers and cannot invalidate durable state.
    }
  }

  async _refreshProfileNames(generation, profileId = null) {
    const profiles = await this._page("profile.list", { backendId: this.id, enabledOnly: false }, "profiles", {
      maxBytes: MAX_HISTORY_BYTES, maxItems: MAX_HISTORY_ITEMS,
    });
    if (generation !== this._generation || this._state !== "started") return;
    if (profiles.some((profile) => !this._acceptsProfileBackend(profile.backendId))) throw safeError(null, "PROFILE_NOT_FOUND");
    if (profileId === null) {
      const activeIds = new Set(profiles.filter(profile => profile.enabled).map(profile => profile.id));
      if (activeIds.size !== this._profilesById.size
        || [...activeIds].some(id => !this._profilesById.has(id))) {
        await this._refreshManagedProfiles();
        return;
      }
    }
    const renamed = new Map();
    let workspaceChanged = false;
    for (const profile of profiles) {
      const prior = this._profilesById.get(profile.id);
      if (!prior || !profile.enabled || (profileId !== null && profile.id !== profileId)
        || profile.updatedAt < prior.updatedAt) continue;
      this._profilesById.set(profile.id, profile);
      this._profilesByAgent.set(profile.agentId, profile);
      if (prior.name !== profile.name) renamed.set(profile.agentId, profile.name);
      if (prior.defaultCwd !== profile.defaultCwd) workspaceChanged = true;
    }
    if (renamed.size === 0 && !workspaceChanged) return;
    // Keep sessions, active streams, drafts and unrelated row objects intact.
    this._agents = this._agents.map((agent) => renamed.has(agent.id)
      ? Object.freeze({ ...agent, name: renamed.get(agent.id) }) : agent);
    this._rows = this._rows.map((row) => renamed.has(row.agentId)
      ? Object.freeze({ ...row, agentName: renamed.get(row.agentId) }) : row);
    try { this._readyNotifier?.(); } catch {}
  }

  async _pollServiceEvents(generation) {
    let nextDelayMs = this.serviceEventPollMs;
    try {
      const result = await this._call("events.subscribe", {
        afterSeq: this._serviceEventCursor,
      });
      if (generation !== this._generation || this._state !== "started"
        || this._serviceEventPollGeneration !== generation) return;
      const streamChanged = this._serviceEventStreamId !== result.streamId;
      if (streamChanged || result.latestSeq < this._serviceEventCursor) {
        if (this._serviceEventStreamId !== null) {
          if (this._rows.some((row) => row.contextCapabilities)) await this._refreshManagedProfiles();
          else await this._refreshProfileNames(generation);
        }
        this._serviceEventCursor = 0;
        const reconciled = await this._reconcileFederationInteractions(generation);
        if (!reconciled || generation !== this._generation || this._state !== "started"
          || this._serviceEventPollGeneration !== generation) return;
        this._serviceEventStreamId = result.streamId;
        nextDelayMs = 0;
      } else if (result.gap) {
        if (this._rows.some((row) => row.contextCapabilities)) await this._refreshManagedProfiles();
        else await this._refreshProfileNames(generation);
        const reconciled = await this._reconcileFederationInteractions(generation);
        if (!reconciled || generation !== this._generation || this._state !== "started"
          || this._serviceEventPollGeneration !== generation) return;
        this._serviceEventCursor = result.nextCursor;
        nextDelayMs = 0;
      } else {
        for (const event of result.events) {
          if (event.type === "agent.profile.renamed" && this._acceptsProfileBackend(event.payload.backendId)) {
            await this._refreshProfileNames(generation, event.payload.profileId);
          } else if (event.type === "agent.profile.changed" && this._acceptsProfileBackend(event.payload.backendId)) {
            await this._refreshProfileNames(generation);
          } else if (event.type === "runtime.context.updated") {
            // All native facades share this stream. Only its owning facade
            // refreshes one profile; no content or token counts ride the event.
            if (this._profilesById.has(event.payload.profileId)) {
              const target = await this._syncFederationTargetSession(event.payload, generation);
              if (target?.liveSession) {
                try { this._sessionActivityNotifier?.({ kind: "sessions.changed", sessionKey: target.sessionKey }); }
                catch { /* UI listeners cannot invalidate a context observation. */ }
              }
            }
          } else if (event.type === "federation.chat.terminal") {
            await this._applyFederationTerminalActivity(event.payload, generation);
          } else if (event.type === "federation.chat.interaction") {
            await this._applyFederationInteractionActivity(event.payload, generation);
          }
        }
        if (generation !== this._generation || this._state !== "started"
          || this._serviceEventPollGeneration !== generation) return;
        this._serviceEventCursor = result.nextCursor;
        nextDelayMs = result.hasMore ? 0 : this.serviceEventPollMs;
      }
    } catch {
      // Service restart and transient socket loss are retried without affecting chat readiness.
    }
    this._scheduleServiceEventPoll(generation, nextDelayMs);
  }

  _startGenerationActive(generation) {
    return generation === this._generation
      && (this._state === "starting" || this._state === "recovering");
  }

  async _waitForServiceReady(generation) {
    let lastNow = -Infinity;
    const readNow = () => {
      const value = this.readinessNow();
      if (typeof value !== "number" || !Number.isFinite(value) || value < lastNow) {
        throw new TypeError("ShoggothBackend readinessNow 必须返回单调有限数值");
      }
      lastNow = value;
      return value;
    };
    let deadline;
    try {
      deadline = readNow() + this.readinessTimeoutMs;
    } catch {
      return false;
    }
    for (let attempts = 0; attempts < this.readinessMaxAttempts; attempts += 1) {
      if (!this._startGenerationActive(generation)) return false;
      let remaining;
      try {
        remaining = deadline - readNow();
      } catch {
        return false;
      }
      if (remaining < 1) return false;
      const timeoutMs = Math.min(
        this.serviceStatusTimeoutMs,
        DEFAULT_SERVICE_STATUS_TIMEOUT_MS,
        Math.floor(remaining),
      );
      let ready = false;
      try {
        const status = await this._call("service.status", {}, { timeoutMs });
        ready = this._isServiceReady(status);
      } catch { /* unavailable/invalid samples consume the same bounded attempt */ }
      if (!this._startGenerationActive(generation)) return false;
      let remainingAfterSample;
      try {
        remainingAfterSample = deadline - readNow();
      } catch {
        return false;
      }
      if (remainingAfterSample < 0) return false;
      if (ready) return true;
      if (attempts + 1 >= this.readinessMaxAttempts || remainingAfterSample <= 0) return false;
      const delayMs = Math.min(
        this.readinessIntervalMs,
        DEFAULT_READINESS_INTERVAL_MS,
        remainingAfterSample,
      );
      if (delayMs > 0) await this.delay(delayMs);
    }
    return false;
  }

  async _runStartCycle() {
    const recovering = this._state === "recovering";
    const generation = ++this._generation;
    this._state = recovering ? "recovering" : "starting";
    this._modelChoices = [];
    try {
      const ready = await this._waitForServiceReady(generation);
      if (!this._startGenerationActive(generation)) return false;
      if (!ready) {
        this._complete = false;
        this._state = "stopped";
        this._retryOnStatus = true;
        return false;
      }
      if (this.getNativeRuntimeConfig) {
        await this.applyNativeRuntimeConfig(this.getNativeRuntimeConfig());
        if (!this._startGenerationActive(generation)) return false;
      }
      const profiles = await this._page(
        "profile.list", { backendId: this.id, enabledOnly: false }, "profiles", {
          maxBytes: MAX_HISTORY_BYTES,
          maxItems: MAX_HISTORY_ITEMS,
        },
      );
      if (!this._startGenerationActive(generation)) return false;
      if (profiles.some((value) => !this._acceptsProfileBackend(value.backendId))) {
        throw safeError(null, "PROFILE_NOT_FOUND");
      }
      const enabled = profiles.filter((value) => value.enabled);
      const connectedAccounts = await this._connectedCliAccounts();
      let snapshotItems = 0;
      let snapshotBytes = 0;
      const sessionsByProfile = await mapBounded(
        enabled, MAX_PROFILE_SESSION_CONCURRENCY, async (value) => {
          if (!this._startGenerationActive(generation)) {
            throw safeError(null, "BACKEND_START_CANCELLED");
          }
          if (connectedAccounts.length) await this._syncCliBindings(value.id, connectedAccounts);
          const sessions = await this._page("chat.session.list", {
            profileId: value.id,
            includeArchived: false,
          }, "sessions", {
            maxBytes: MAX_HISTORY_BYTES,
            maxItems: MAX_HISTORY_ITEMS,
          });
          const rows = sessions.map((session) => sessionToRow(this._profileForSession(value, session), session, this.id));
          snapshotItems += rows.length;
          for (const row of rows) snapshotBytes += encodedBytes(row);
          if (snapshotItems > MAX_HISTORY_ITEMS || snapshotBytes > MAX_HISTORY_BYTES) {
            throw safeError(null, "RESPONSE_TOO_LARGE");
          }
          return { profile: value, sessions, rows };
        },
      );
      if (!this._startGenerationActive(generation)) return false;
      const profilesByAgent = new Map(enabled.map((value) => [value.agentId, value]));
      const profilesById = new Map(enabled.map((value) => [value.id, value]));
      const sessionsByKey = new Map();
      const rows = [];
      for (const entry of sessionsByProfile) {
        for (const value of entry.sessions) {
          sessionsByKey.set(value.sessionKey, value);
        }
        rows.push(...entry.rows);
      }
      this._profilesByAgent = profilesByAgent;
      this._profilesById = profilesById;
      this._sessionsByKey = sessionsByKey;
      const accountCounts = runtimeAccountReferenceCounts(enabled);
      this._agents = enabled.map((profile) => profileToAgent(
        profile,
        this.id,
        accountCounts.get(profile.runtimeAccountId),
      ));
      this._rows = rows;
      this._complete = true;
      this._state = "started";
      this._consecutiveStatusTimeouts = 0;
      this._retryOnStatus = false;
      try { this._readyNotifier?.(); } catch { /* registry listener failures are isolated */ }
      this._serviceEventCursor = 0;
      this._scheduleServiceEventPoll(generation, 0);
      return true;
    } catch {
      if (generation === this._generation) {
        this._complete = false;
        this._state = "stopped";
        this._retryOnStatus = true;
      }
      return false;
    }
  }

  start(hooks = {}) {
    if (typeof hooks?.onPartialReady === "function") {
      this._readyNotifier = hooks.onPartialReady;
    }
    if (typeof hooks?.onSessionActivity === "function") {
      this._sessionActivityNotifier = hooks.onSessionActivity;
    }
    if (this._startPromise && !this._stopPromise) return this._startPromise;
    if (this._state === "started") {
      this._scheduleServiceEventPoll(this._generation, 0);
      return Promise.resolve(true);
    }
    if (this._stopPromise) {
      if (this._queuedStartPromise) return this._queuedStartPromise;
      const pendingStop = this._stopPromise;
      let queued;
      queued = (async () => {
        await pendingStop;
        if (this._state === "started") return true;
        return this._runStartCycle();
      })().finally(() => {
        if (this._queuedStartPromise === queued) this._queuedStartPromise = null;
        if (this._startPromise === queued) this._startPromise = null;
      });
      this._queuedStartPromise = queued;
      this._startPromise = queued;
      return queued;
    }
    let starting;
    starting = (async () => {
      if (this._state === "started") return true;
      return this._runStartCycle();
    })().finally(() => {
      if (this._startPromise === starting) this._startPromise = null;
    });
    this._startPromise = starting;
    return starting;
  }

  stop() {
    if (this._stopPromise) return this._stopPromise;
    ++this._generation;
    this._stopServiceEventPolling();
    this._serviceEventStreamId = null;
    try {
      this._sessionActivityNotifier?.({ kind: "federation.chat.interaction.reset" });
    } catch {
      // Registry/UI listeners are observers and cannot block backend shutdown.
    }
    this._state = "stopping";
    this._consecutiveStatusTimeouts = 0;
    this._retryOnStatus = false;
    for (const poll of this._polls) poll.cancelled = true;
    this._polls.clear();
    this._complete = false;
    this._activeBySession.clear();
    this._promptByRequest.clear();
    const pendingStart = this._startPromise;
    const stopping = Promise.resolve().then(async () => {
      if (pendingStart) await Promise.allSettled([pendingStart]);
      this._state = "stopped";
    }).finally(() => {
      if (this._stopPromise === stopping) this._stopPromise = null;
    });
    this._stopPromise = stopping;
    return stopping;
  }

  _optionalSelector(value, key, code) {
    if (!Object.prototype.hasOwnProperty.call(value || {}, key)) return undefined;
    const selector = value[key];
    if (typeof selector !== "string" || selector.length === 0) {
      throw safeError(null, code);
    }
    return selector;
  }

  _profileSelectors(value) {
    return {
      profileId: this._optionalSelector(value, "profileId", "PROFILE_SELECTOR_INVALID"),
      agentId: this._optionalSelector(value, "agentId", "PROFILE_SELECTOR_INVALID"),
    };
  }

  _boardSelector(value) {
    const boardId = this._optionalSelector(
      value, "boardId", "KANBAN_BOARD_SELECTOR_INVALID",
    );
    const boardSlug = this._optionalSelector(
      value, "board", "KANBAN_BOARD_SELECTOR_INVALID",
    );
    if (boardId !== undefined && boardSlug !== undefined && boardId !== boardSlug) {
      throw safeError(null, "KANBAN_BOARD_SELECTOR_INVALID");
    }
    return boardId === undefined ? boardSlug : boardId;
  }

  _domainProfile({ profileId = undefined, agentId = undefined } = {}) {
    this._assertDomainReady();
    const byProfile = profileId === undefined ? null : this._profilesById.get(profileId);
    const byAgent = agentId === undefined ? null : this._profilesByAgent.get(agentId);
    if ((profileId !== undefined && !byProfile) || (agentId !== undefined && !byAgent)
      || (byProfile && byAgent && byProfile.id !== byAgent.id)) {
      throw safeError(null, "PROFILE_NOT_FOUND");
    }
    if (byProfile || byAgent) return byProfile || byAgent;
    const profiles = [...this._profilesByAgent.values()];
    if (profiles.length === 1) return profiles[0];
    throw safeError(null, "PROFILE_REQUIRED");
  }

  _assertKnownProfileId(profileId) {
    const profile = this._profilesById.get(profileId);
    if (!profile) throw safeError(null, "PROFILE_NOT_FOUND");
    return profile;
  }

  async _listBoardsForProfile(profile) {
    const boards = await this._domainPage(
      "kanban.board.list", { profileId: profile.id }, "boards",
    );
    for (const value of boards) {
      if (value.profileId !== profile.id) throw safeError(null, "KANBAN_PROFILE_MISMATCH");
    }
    return boards;
  }

  async _resolveBoard(selector = undefined, qualifiers = {}) {
    this._assertDomainReady();
    if (selector !== undefined && (typeof selector !== "string" || selector.length === 0)) {
      throw safeError(null, "KANBAN_BOARD_SELECTOR_INVALID");
    }
    const { profileId, agentId } = this._profileSelectors(qualifiers);
    let profiles;
    if (profileId !== undefined || agentId !== undefined) {
      profiles = [this._domainProfile({ profileId, agentId })];
    } else {
      profiles = [...this._profilesByAgent.values()];
    }
    const rawSelector = selector === undefined ? null : selector;
    if (rawSelector && UUID_PATTERN.test(rawSelector)) {
      const result = await this._call("kanban.board.get", { boardId: rawSelector });
      if (result.board.id !== rawSelector) throw safeError(null, "KANBAN_BOARD_MISMATCH");
      const profile = this._assertKnownProfileId(result.board.profileId);
      if (!profiles.some((candidate) => candidate.id === profile.id)) {
        throw safeError(null, "KANBAN_PROFILE_MISMATCH");
      }
      return { board: result.board, profile };
    }
    const matches = [];
    let aggregate = { bytes: 0, items: 0 };
    for (const profile of profiles) {
      const boards = await this._listBoardsForProfile(profile);
      aggregate = this._assertDomainAggregate(boards, aggregate.bytes, aggregate.items);
      for (const value of boards) {
        if (rawSelector === null || value.slug === rawSelector) matches.push({ board: value, profile });
      }
    }
    if (matches.length === 0) throw safeError(null, "KANBAN_BOARD_NOT_FOUND");
    if (matches.length !== 1) throw safeError(null, "KANBAN_BOARD_AMBIGUOUS");
    return matches[0];
  }

  _nativeTaskCapabilities() {
    return {
      kind: "native",
      drag: true,
      archive: true,
      hardDelete: false,
      sessionHandoff: false,
      labels: false,
      comments: true,
      boards: true,
      orchestration: false,
      tenants: false,
      lanes: false,
      diagnostics: false,
      dispatch: false,
      links: false,
      progress: false,
      archived: true,
      moveTargets: [...NATIVE_CARD_STATUSES],
      attachments: false,
      modelOverride: false,
      boardSettings: true,
      profiles: false,
      homeChannels: false,
      completionSummary: false,
      bulkDelete: false,
      workspaceKinds: [],
      run: true,
      retry: true,
      manualComplete: true,
    };
  }

  _mapTaskCard(value, profile) {
    return {
      id: value.id,
      title: value.title,
      excerpt: value.bodyMeta?.preview?.replace(/\s+/gu, " ").slice(0, 140) || "",
      column: value.status,
      position: value.position,
      live: ["queued", "running", "waiting"].includes(value.status),
      archivedAt: value.archivedAt ?? undefined,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      backendId: this.id,
      agentId: profile?.agentId,
    };
  }

  async getBoards() {
    this._assertDomainReady();
    const rows = [];
    let aggregate = { bytes: 0, items: 0 };
    for (const profile of this._profilesByAgent.values()) {
      const boards = await this._listBoardsForProfile(profile);
      for (const [index, value] of boards.entries()) {
        const cards = await this._domainPage(
          "kanban.card.list", { boardId: value.id, status: null }, "cards",
        );
        for (const item of cards) {
          if (item.boardId !== value.id || item.profileId !== profile.id) {
            throw safeError(null, "KANBAN_PROFILE_MISMATCH");
          }
        }
        aggregate = this._assertDomainAggregate(
          [value, ...cards], aggregate.bytes, aggregate.items,
        );
        rows.push({ value, profile, total: cards.length, isProfileDefault: index === 0 });
      }
    }
    const defaultRows = rows.filter(({ profile }) => profile.isDefault === true);
    const current = defaultRows.find(({ value }) => value.slug === "default")
      || (rows.length === 1 ? rows[0] : null);
    return rows.map(({ value, profile, total, isProfileDefault }) => ({
      id: value.id,
      slug: value.slug,
      projectKey: isProfileDefault ? "default" : value.slug,
      name: value.name,
      description: value.description || undefined,
      total,
      current: current?.value.id === value.id,
      profileId: profile.id,
      agentId: profile.agentId,
      profileName: profile.name,
      backendId: this.id,
    }));
  }

  async createBoard(spec = {}) {
    this._rejectUnsupportedTaskFields(spec, new Set([
      "profileId", "agentId", "slug", "name", "description",
    ]), "KANBAN_BOARD_CREATE_UNSUPPORTED");
    const profile = this._domainProfile({
      ...this._profileSelectors(spec),
    });
    const createdAt = this.now();
    const result = await this._call("kanban.board.create", {
      operationId: `board-create-${this.randomUUID()}`,
      profileId: profile.id,
      slug: String(spec.slug || ""),
      name: String(spec.name || ""),
      description: spec.description === undefined ? null : spec.description,
      createdAt,
    });
    if (result.board.profileId !== profile.id) throw safeError(null, "KANBAN_PROFILE_MISMATCH");
    if (!fieldsMatch(result.board, {
      slug: String(spec.slug || ""),
      name: String(spec.name || ""),
      description: spec.description === undefined ? null : spec.description,
      createdAt,
      updatedAt: createdAt,
    })) throw safeError(null, "KANBAN_MUTATION_BINDING_INVALID");
    return {
      id: result.board.id,
      slug: result.board.slug,
      name: result.board.name,
      description: result.board.description || undefined,
      total: 0,
      current: false,
      profileId: profile.id,
      agentId: profile.agentId,
      profileName: profile.name,
      backendId: this.id,
    };
  }

  async updateBoard(selector, patch = {}) {
    const target = await this._resolveBoard(selector, patch);
    const allowed = new Set(["name", "description"]);
    const update = {};
    for (const [key, value] of Object.entries(patch)) {
      if (["profileId", "agentId"].includes(key)) continue;
      if (!allowed.has(key)) throw safeError(null, "KANBAN_BOARD_PATCH_UNSUPPORTED");
      update[key] = value;
    }
    if (Object.keys(update).length === 0) throw safeError(null, "KANBAN_BOARD_PATCH_INVALID");
    const result = await this._call("kanban.board.update", {
      operationId: `board-update-${this.randomUUID()}`,
      boardId: target.board.id,
      patch: update,
      createdAt: this.now(),
    });
    if (result.board.id !== target.board.id || result.board.profileId !== target.profile.id) {
      throw safeError(null, "KANBAN_PROFILE_MISMATCH");
    }
    if (!fieldsMatch(result.board, update)) {
      throw safeError(null, "KANBAN_MUTATION_BINDING_INVALID");
    }
    return {
      id: result.board.id,
      slug: result.board.slug,
      name: result.board.name,
      description: result.board.description || undefined,
      profileId: target.profile.id,
      agentId: target.profile.agentId,
      profileName: target.profile.name,
      backendId: this.id,
    };
  }

  async getTaskBoard(opts = {}) {
    const target = await this._resolveBoard(this._boardSelector(opts), opts);
    const cards = await this._domainPage(
      "kanban.card.list", { boardId: target.board.id, status: null }, "cards",
    );
    const buckets = new Map(NATIVE_CARD_STATUSES.map((status) => [status, []]));
    for (const value of cards) {
      if (value.boardId !== target.board.id || value.profileId !== target.profile.id) {
        throw safeError(null, "KANBAN_PROFILE_MISMATCH");
      }
      if (opts.includeArchived || value.archivedAt === null) buckets.get(value.status).push(value);
    }
    return {
      columns: NATIVE_CARD_STATUSES.map((status) => ({
        id: status,
        name: NATIVE_COLUMN_NAMES[status],
        tasks: buckets.get(status)
          .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id))
          .map((value) => this._mapTaskCard(value, target.profile)),
      })),
      capabilities: this._nativeTaskCapabilities(),
    };
  }

  async _loadCardTarget(cardId) {
    this._assertDomainReady();
    const expectedCardId = typeof cardId === "string" ? cardId : "";
    const result = await this._call("kanban.card.get", { cardId: expectedCardId });
    if (result.card.id !== expectedCardId) throw safeError(null, "KANBAN_CARD_MISMATCH");
    const profile = this._assertKnownProfileId(result.card.profileId);
    const boardResult = await this._call("kanban.board.get", { boardId: result.card.boardId });
    if (boardResult.board.profileId !== profile.id || boardResult.board.id !== result.card.boardId) {
      throw safeError(null, "KANBAN_PROFILE_MISMATCH");
    }
    return { card: result.card, board: boardResult.board, profile };
  }

  _mapTaskRun(value, profile) {
    let status = value.status;
    if (["queued", "starting", "waiting_approval", "waiting_input"].includes(status)) status = "running";
    if (["canceled", "interrupted", "skipped"].includes(status)) status = "failed";
    return {
      id: value.id,
      ...(value.sessionKey ? { sessionKey: gatewaySessionKey(profile.agentId, value.sessionKey) } : {}),
      status,
      startedAt: value.startedAt,
      finishedAt: value.finishedAt,
      ...(value.resultSummary ? { summary: value.resultSummary } : {}),
      ...(value.errorCode ? { error: value.errorCode } : {}),
      profile: profile.name,
    };
  }

  _mapTaskDetail(value, body, profile, extras = {}) {
    const completion = value.completion;
    const summary = completion?.mode === "manual" ? completion.note || undefined : extras.summary;
    return {
      id: value.id,
      title: value.title,
      body: body || "",
      column: value.status,
      archivedAt: value.archivedAt ?? undefined,
      summary,
      backendId: this.id,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      ...extras,
    };
  }

  async getTask(id) {
    const target = await this._loadCardTarget(id);
    const body = target.card.bodyMeta === null ? "" : await this._readDomainContent(
      "kanban.card.body.read", { cardId: target.card.id }, target.card.bodyMeta,
    );
    const comments = await this._domainPage(
      "kanban.comment.list", { cardId: target.card.id }, "comments",
    );
    const attachments = await this._domainPage(
      "kanban.attachment.list", { cardId: target.card.id }, "attachments",
    );
    const artifacts = await this._domainPage(
      "kanban.artifact.list", { cardId: target.card.id }, "artifacts",
    );
    const runs = await this._domainPage(
      "kanban.run.list", { cardId: target.card.id, status: null }, "runs",
    );
    for (const value of [...comments, ...attachments, ...artifacts]) {
      if (value.cardId !== target.card.id) throw safeError(null, "KANBAN_CARD_MISMATCH");
    }
    for (const value of runs) {
      if (value.profileId !== target.profile.id) throw safeError(null, "KANBAN_PROFILE_MISMATCH");
    }
    const mappedComments = [];
    let aggregate = this._assertDomainAggregate(
      [target.card, ...comments, ...attachments, ...artifacts, ...runs],
    );
    for (const value of comments) {
      const commentBody = await this._readDomainContent(
        "kanban.comment.body.read", { commentId: value.id }, value.bodyMeta,
      );
      aggregate = this._assertDomainAggregate([commentBody], aggregate.bytes, aggregate.items);
      mappedComments.push({
        id: value.id,
        author: value.authorType === "human"
          ? "You" : value.authorType === "agent" ? target.profile.name : "Shoggoth",
        body: commentBody,
        createdAt: value.createdAt,
      });
    }
    const mappedRuns = runs.map((value) => this._mapTaskRun(value, target.profile));
    const latestSummary = [...mappedRuns].reverse().find((value) => value.summary)?.summary;
    const detail = this._mapTaskDetail(target.card, body, target.profile, {
      comments: mappedComments,
      attachments: attachments.map((value) => ({
        id: value.id,
        filename: value.name,
        contentType: value.mimeType || undefined,
        size: value.sizeBytes,
        createdAt: value.createdAt,
      })),
      artifacts: artifacts.map((value) => ({
        id: value.id,
        label: value.name,
        mimeType: value.mimeType || undefined,
        createdAt: value.createdAt,
      })),
      runs: mappedRuns,
      latestSummary,
    });
    if (encodedBytes(detail) > MAX_DOMAIN_AGGREGATE_BYTES) {
      throw safeError(null, "RESPONSE_TOO_LARGE");
    }
    return detail;
  }

  _rejectUnsupportedTaskFields(value, allowed, code) {
    for (const [key, item] of Object.entries(value || {})) {
      if (!allowed.has(key) && item !== undefined) throw safeError(null, code);
    }
  }

  async createTask(spec = {}) {
    this._rejectUnsupportedTaskFields(spec, new Set([
      "board", "boardId", "profileId", "agentId", "title", "body",
      "column", "status", "position",
    ]), "KANBAN_TASK_CREATE_UNSUPPORTED");
    const target = await this._resolveBoard(this._boardSelector(spec), spec);
    const status = spec.status || spec.column || "backlog";
    if (!["triage", "backlog"].includes(status)) {
      throw safeError(null, "KANBAN_CREATE_STATUS_UNSUPPORTED");
    }
    const createdAt = this.now();
    const body = spec.body === undefined ? null : spec.body;
    const result = await this._call("kanban.card.create", {
      operationId: `card-create-${this.randomUUID()}`,
      boardId: target.board.id,
      profileId: target.profile.id,
      title: String(spec.title || ""),
      body,
      status,
      position: Number.isSafeInteger(spec.position) && spec.position >= 0 ? spec.position : 0,
      createdAt,
    });
    if (result.card.boardId !== target.board.id || result.card.profileId !== target.profile.id
      || result.card.status !== status) {
      throw safeError(null, "KANBAN_PROFILE_MISMATCH");
    }
    if (!fieldsMatch(result.card, {
      title: String(spec.title || ""),
      status,
      position: Number.isSafeInteger(spec.position) && spec.position >= 0 ? spec.position : 0,
      createdAt,
      updatedAt: createdAt,
    }) || !contentMetaMatches(result.card.bodyMeta, body)) {
      throw safeError(null, "KANBAN_MUTATION_BINDING_INVALID");
    }
    return this._mapTaskDetail(result.card, body || "", target.profile);
  }

  async updateTask(id, patch = {}) {
    this._rejectUnsupportedTaskFields(patch, new Set([
      "title", "body", "position", "column", "status", "result", "summary", "note",
    ]), "KANBAN_TASK_PATCH_UNSUPPORTED");
    const status = patch.status || patch.column || null;
    const dataKeys = ["title", "body", "position"].filter(
      (key) => Object.prototype.hasOwnProperty.call(patch, key),
    );
    if (status !== null) {
      if (dataKeys.length > 0) throw safeError(null, "KANBAN_PATCH_MIXED_UNSUPPORTED");
      return this.moveTask(id, status, patch.position, patch);
    }
    if (dataKeys.length === 0) throw safeError(null, "KANBAN_TASK_PATCH_INVALID");
    const target = await this._loadCardTarget(id);
    const update = {};
    for (const key of dataKeys) update[key] = patch[key];
    const result = await this._call("kanban.card.update", {
      operationId: `card-update-${this.randomUUID()}`,
      cardId: target.card.id,
      patch: update,
      createdAt: this.now(),
    });
    if (result.card.id !== target.card.id || result.card.boardId !== target.board.id
      || result.card.profileId !== target.profile.id) {
      throw safeError(null, "KANBAN_PROFILE_MISMATCH");
    }
    const scalarUpdate = { ...update };
    delete scalarUpdate.body;
    if (!fieldsMatch(result.card, scalarUpdate)
      || (Object.prototype.hasOwnProperty.call(update, "body")
        && !contentMetaMatches(result.card.bodyMeta, update.body))) {
      throw safeError(null, "KANBAN_MUTATION_BINDING_INVALID");
    }
    const body = Object.prototype.hasOwnProperty.call(update, "body")
      ? update.body || "" : result.card.bodyMeta?.preview || "";
    return this._mapTaskDetail(result.card, body, target.profile);
  }

  async moveTask(id, status, position, opts = {}) {
    const target = await this._loadCardTarget(id);
    if (!NATIVE_CARD_STATUSES.includes(status)) throw safeError(null, "KANBAN_STATUS_INVALID");
    if (status === "done") {
      if (target.card.status === "done") throw safeError(null, "STATE_CONFLICT");
      const note = typeof opts.note === "string"
        ? opts.note : typeof opts.summary === "string"
          ? opts.summary : typeof opts.result === "string" ? opts.result : null;
      const createdAt = this.now();
      const result = await this._call("kanban.card.complete.manual", {
        operationId: `card-complete-${this.randomUUID()}`,
        cardId: target.card.id,
        note,
        createdAt,
      });
      if (result.card.id !== target.card.id || result.card.profileId !== target.profile.id
        || result.card.boardId !== target.board.id || result.card.status !== "done"
        || result.audit.cardId !== target.card.id) {
        throw safeError(null, "KANBAN_PROFILE_MISMATCH");
      }
      if (result.card.completion?.mode !== "manual"
        || result.card.completion.runId !== null || result.card.completion.note !== note
        || result.card.completion.at !== createdAt || result.audit.kind !== "manual_completion"
        || result.audit.runId !== null || result.audit.note !== note
        || result.audit.createdAt !== createdAt) {
        throw safeError(null, "KANBAN_MUTATION_BINDING_INVALID");
      }
      return this._mapTaskDetail(result.card, result.card.bodyMeta?.preview || "", target.profile);
    }
    if (target.card.status !== status
      && !NATIVE_STATUS_TRANSITIONS[target.card.status]?.has(status)) {
      throw safeError(null, "STATE_CONFLICT");
    }
    let authoritative = target.card;
    if (Number.isSafeInteger(position) && position >= 0 && position !== target.card.position) {
      const positioned = await this._call("kanban.card.update", {
        operationId: `card-position-${this.randomUUID()}`,
        cardId: target.card.id,
        patch: { position },
        createdAt: this.now(),
      });
      if (positioned.card.id !== target.card.id
        || positioned.card.boardId !== target.board.id
        || positioned.card.profileId !== target.profile.id
        || positioned.card.position !== position) {
        throw safeError(null, "KANBAN_MUTATION_BINDING_INVALID");
      }
      authoritative = positioned.card;
    }
    if (authoritative.status !== status) {
      const moved = await this._call("kanban.card.status.set", {
        operationId: `card-move-${this.randomUUID()}`,
        cardId: target.card.id,
        status,
        createdAt: this.now(),
      });
      if (moved.card.id !== target.card.id || moved.card.boardId !== target.board.id
        || moved.card.profileId !== target.profile.id || moved.card.status !== status) {
        throw safeError(null, "KANBAN_MUTATION_BINDING_INVALID");
      }
      authoritative = moved.card;
    }
    if (authoritative.id !== target.card.id || authoritative.boardId !== target.board.id
      || authoritative.profileId !== target.profile.id || authoritative.status !== status) {
      throw safeError(null, "KANBAN_PROFILE_MISMATCH");
    }
    return this._mapTaskDetail(
      authoritative, authoritative.bodyMeta?.preview || "", target.profile,
    );
  }

  async archiveTask(id, archived = true) {
    const target = await this._loadCardTarget(id);
    const result = await this._call("kanban.card.archived.set", {
      operationId: `card-archive-${this.randomUUID()}`,
      cardId: target.card.id,
      archived: !!archived,
      createdAt: this.now(),
    });
    if (result.card.id !== target.card.id || result.card.boardId !== target.board.id
      || result.card.profileId !== target.profile.id
      || (result.card.archivedAt !== null) !== !!archived) {
      throw safeError(null, "KANBAN_MUTATION_BINDING_INVALID");
    }
    return this._mapTaskDetail(
      result.card, result.card.bodyMeta?.preview || "", target.profile,
    );
  }

  async addTaskComment(id, body) {
    const target = await this._loadCardTarget(id);
    const text = String(body || "");
    const createdAt = this.now();
    const result = await this._call("kanban.comment.add", {
      operationId: `comment-add-${this.randomUUID()}`,
      cardId: target.card.id,
      body: text,
      createdAt,
    });
    const expectedHash = crypto.createHash("sha256").update(text, "utf8").digest("hex");
    if (result.comment.cardId !== target.card.id
      || result.comment.bodyMeta.byteLength !== Buffer.byteLength(text, "utf8")
      || result.comment.bodyMeta.sha256 !== expectedHash
      || result.comment.authorType !== "human"
      || result.comment.authorId !== "shoggoth-local-user"
      || result.comment.createdAt !== createdAt) {
      throw safeError(null, "KANBAN_CARD_MISMATCH");
    }
    return {
      id: result.comment.id,
      author: "You",
      body: text,
      createdAt: result.comment.createdAt,
    };
  }

  async _cardRuns(target) {
    const values = await this._domainPage(
      "kanban.run.list", { cardId: target.card.id, status: null }, "runs",
    );
    for (const value of values) {
      if (value.sourceId !== target.card.id || value.profileId !== target.profile.id) {
        throw safeError(null, "KANBAN_PROFILE_MISMATCH");
      }
    }
    return values;
  }

  async runTaskCard(id, opts = {}) {
    const target = await this._loadCardTarget(id);
    this._assertRuntimeEnabled(target.profile);
    if (opts.engine !== undefined || opts.model !== undefined
      || opts.mode === "manual") throw safeError(null, "KANBAN_RUN_MODE_UNSUPPORTED");
    const workspace = opts.workspace === undefined ? null : opts.workspace;
    const createdAt = this.now();
    let result;
    let retryOf = null;
    if (opts.mode === "retry") {
      const runs = await this._cardRuns(target);
      const latest = runs.at(-1) || null;
      if (!latest || !["failed", "canceled", "interrupted", "skipped"].includes(latest.status)
        || (opts.retryOf !== undefined && opts.retryOf !== latest.id)) {
        throw safeError(null, "KANBAN_RETRY_REFERENCE_STALE");
      }
      retryOf = latest.id;
      result = await this._call("kanban.run.retry", {
        operationId: `run-retry-${this.randomUUID()}`,
        cardId: target.card.id,
        retryOf,
        workspace,
        createdAt,
      });
    } else {
      if (opts.mode !== undefined && opts.mode !== "autonomous") {
        throw safeError(null, "KANBAN_RUN_MODE_UNSUPPORTED");
      }
      result = await this._call("kanban.run.dispatch", {
        operationId: `run-dispatch-${this.randomUUID()}`,
        cardId: target.card.id,
        workspace,
        createdAt,
      });
    }
    const workspaceMatches = workspace === null
      ? typeof result.run.workspace === "string" && path.isAbsolute(result.run.workspace)
      : result.run.workspace === workspace;
    if (result.run.profileId !== target.profile.id || result.run.sourceId !== target.card.id
      || result.card.id !== target.card.id || result.card.boardId !== target.board.id
      || result.card.profileId !== target.profile.id || result.link.cardId !== target.card.id
      || result.link.runId !== result.run.id || result.run.retryOf !== retryOf
      || result.link.retryOf !== retryOf || !workspaceMatches
      || result.link.createdAt !== createdAt || result.card.status !== "queued") {
      throw safeError(null, "KANBAN_RUN_BINDING_INVALID");
    }
    return {
      runId: result.run.id,
      ...(retryOf ? { retryOf } : {}),
      runStarted: ACTIVE_DOMAIN_RUN_STATUSES.has(result.run.status),
      status: result.run.status,
    };
  }

  _nativeResourceLocalId(id, { allowBare = false, opaque = false } = {}) {
    const value = String(id || "");
    const validLocalId = (candidate) => opaque
      ? safeString(candidate, 128) && OPAQUE_ID_PATTERN.test(candidate)
      : UUID_PATTERN.test(candidate);
    if (allowBare && validLocalId(value)) return value;
    const separator = value.indexOf(":");
    if (separator < 1) return null;
    const prefix = value.slice(0, separator);
    const localId = value.slice(separator + 1);
    if (prefix !== this.id) return null;
    return validLocalId(localId) ? localId : null;
  }

  async ownsResourceId(kind, id) {
    const localId = this._nativeResourceLocalId(id, {
      allowBare: kind === "kanban" || kind === "dashboard-run",
      opaque: kind === "dashboard-run",
    });
    if (!localId || this._state !== "started") return false;
    if (kind === "cron") {
      try {
        const result = await this._call("cron.job.get", { jobId: localId });
        return result.job.id === localId && this._profilesById.has(result.job.profileId);
      } catch {
        return false;
      }
    }
    if (kind === "kanban") {
      try {
        const result = await this._call("kanban.card.get", { cardId: localId });
        if (result.card.id === localId && this._profilesById.has(result.card.profileId)) return true;
      } catch { /* It may be a board id rather than a card id. */ }
      try {
        const result = await this._call("kanban.board.get", { boardId: localId });
        return result.board.id === localId && this._profilesById.has(result.board.profileId);
      } catch {
        return false;
      }
    }
    if (kind === "dashboard-run") {
      try {
        const result = await this._call("run.get", { runId: localId });
        return result.run.id === localId && this._profilesById.has(result.run.profileId);
      } catch {
        return false;
      }
    }
    return false;
  }

  _parseCronId(id) {
    const localId = this._nativeResourceLocalId(id);
    if (!localId) throw safeError(null, "CRON_JOB_ID_INVALID");
    return localId;
  }

  _cronScheduleToUi(schedule) {
    if (schedule.kind === "at") {
      return { kind: "at", at: new Date(schedule.at).toISOString() };
    }
    return structuredClone(schedule);
  }

  _cronScheduleFromUi(schedule, createdAt, previous = null) {
    if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
      throw safeError(null, "CRON_SCHEDULE_INVALID");
    }
    if (schedule.kind === "at") {
      const at = typeof schedule.at === "number" ? schedule.at : Date.parse(schedule.at);
      if (!Number.isSafeInteger(at) || at < 0) throw safeError(null, "CRON_SCHEDULE_INVALID");
      return { kind: "at", at };
    }
    if (schedule.kind === "every") {
      const anchorMs = Number.isSafeInteger(schedule.anchorMs) && schedule.anchorMs >= 0
        ? schedule.anchorMs
        : previous?.kind === "every" ? previous.anchorMs : createdAt;
      return { kind: "every", everyMs: schedule.everyMs, anchorMs };
    }
    if (schedule.kind === "cron") {
      return {
        kind: "cron",
        expr: schedule.expr,
        tz: typeof schedule.tz === "string" && schedule.tz.length > 0
          ? schedule.tz : previous?.kind === "cron" ? previous.tz : this.timeZone,
      };
    }
    throw safeError(null, "CRON_SCHEDULE_INVALID");
  }

  _cronCapabilityTags(value) {
    const tags = [
      "native",
      `schedule:${value.schedule.kind}`,
      `misfire:${value.misfirePolicy}`,
      `overlap:${value.overlapPolicy}`,
      `thread:${value.threadPolicy}`,
    ];
    if (value.workspace !== null) tags.push("workspace");
    return tags;
  }

  _assertCronJobProfile(value, expectedProfile = null) {
    const profile = this._assertKnownProfileId(value.profileId);
    if (expectedProfile && profile.id !== expectedProfile.id) {
      throw safeError(null, "CRON_PROFILE_MISMATCH");
    }
    return profile;
  }

  _assertPromptMeta(meta, prompt) {
    const bytes = Buffer.byteLength(prompt, "utf8");
    const hash = crypto.createHash("sha256").update(prompt, "utf8").digest("hex");
    if (meta.byteLength !== bytes || meta.sha256 !== hash) {
      throw safeError(null, "RESOURCE_CHANGED");
    }
  }

  _cronLastFields(values) {
    const latest = values.map((value) => this._mapCronRun(value)).sort((left, right) => (
      (right.startedAt || 0) - (left.startedAt || 0)
      || String(right.id).localeCompare(String(left.id))
    ))[0] || null;
    if (!latest) return {};
    return {
      lastRunAt: latest.startedAt,
      lastStatus: latest.status,
      ...(latest.error ? { lastError: latest.error } : {}),
    };
  }

  _mapCronJob(value, profile, prompt = undefined, last = {}) {
    const tags = this._cronCapabilityTags(value);
    const output = {
      id: `${this.id}:${value.id}`,
      backendId: this.id,
      agentId: profile.agentId,
      name: value.name,
      schedule: this._cronScheduleToUi(value.schedule),
      scheduleDisplay: value.schedule.kind === "cron"
        ? value.schedule.expr : value.schedule.kind === "every"
          ? `Every ${value.schedule.everyMs} ms` : new Date(value.schedule.at).toISOString(),
      enabled: value.enabled,
      state: value.enabled ? "scheduled" : "disabled",
      stateLabel: value.enabled ? "scheduled" : "disabled",
      deliver: "chat",
      createdAt: value.createdAt,
      nextRunAt: value.nextRunAt,
      backendDetails: {
        capabilityTags: [...tags],
        raw: {
          workspace: value.workspace,
          misfirePolicy: value.misfirePolicy,
          maxCatchUp: value.maxCatchUp,
          overlapPolicy: value.overlapPolicy,
          threadPolicy: value.threadPolicy,
          threadId: value.threadId,
        },
      },
      rawCapabilities: tags,
      ...last,
    };
    if (prompt !== undefined) output.prompt = prompt;
    return output;
  }

  getInspirationCapabilities() {
    return { execute: this._state === "started", session: true, respond: true, cancel: true,
      reason: this._state === "started" ? null : "backend-unavailable" };
  }

  async _inspirationCall(method, params) {
    const result = await this._call(method, params);
    const decorate = (execution) => execution && ({ ...execution,
      sessionHref: execution.sessionKey ? `/chat?backend=${encodeURIComponent(execution.backendId)}&session=${encodeURIComponent(
        ["openclaw", "hermes"].includes(execution.backendId) ? execution.sessionKey
          : gatewaySessionKey(execution.agentId, execution.sessionKey))}` : null });
    if (result.idea) result.idea.latestExecution = decorate(result.idea.latestExecution);
    if (result.items) for (const idea of result.items) idea.latestExecution = decorate(idea.latestExecution);
    if (result.executions) result.executions = result.executions.map(decorate);
    return result;
  }

  listInspirations(query) { return this._inspirationCall("inspiration.list", query); }
  getInspirationAgentStats(agents) { return this._inspirationCall("inspiration.agent-stats", { agents }); }
  async getRecentInspirationActivities({ sinceMs = 0, limit = 5000 } = {}) {
    const items = [];
    let cursor = null;
    const cap = Math.max(1, Math.min(5000, limit));
    do {
      const page = await this._call("inspiration.activities", { sinceMs, cursor, limit: Math.min(50, cap - items.length) });
      items.push(...page.items.map(inspirationExecutionToActivity));
      cursor = page.hasMore ? page.nextCursor : null;
    } while (cursor && items.length < cap);
    return { supported: true, items, truncated: cursor !== null };
  }
  getInspirationGrowth() { return this._inspirationCall("inspiration.growth.get", {}); }
  updateInspirationGrowth(input) { return this._inspirationCall("inspiration.growth.set", input); }
  getInspiration(id) { return this._inspirationCall("inspiration.get", { id }); }
  createInspiration(input) { return this._inspirationCall("inspiration.create", input); }
  importInspirations(input) { return this._inspirationCall("inspiration.import", input); }
  writeInspirationMedia(input) { return this._inspirationCall("inspiration.media.write", input); }
  readInspirationMedia(input) { return this._inspirationCall("inspiration.media.read", input); }
  updateInspiration(id, input) { return this._inspirationCall("inspiration.update", { ...input, id }); }
  deleteInspiration(id, input) { return this._inspirationCall("inspiration.delete", { ...input, id }); }
  getInspirationExecutions(id, query) { return this._inspirationCall("inspiration.executions", { ...query, id }); }
  getInspirationActivityBinding(id, runId) { return this._call("inspiration.activity.binding", { id, runId }); }

  async getInspirationHistory(execution) {
    const profile = this._profilesByAgent.get(execution.agentId);
    if (profile?.id !== execution.profileId) {
      throw safeError(null, "INSPIRATION_BINDING_INVALID");
    }
    // The Service has verified the exact Session binding. Reading a card must
    // also work before the user has ever opened Chat or populated its cache.
    const items = (await this._page("chat.history", { sessionKey: execution.sessionKey }, "messages", {
      newestFirst: true, maxBytes: MAX_HISTORY_BYTES, maxItems: MAX_HISTORY_ITEMS,
    })).filter(item => item.runId === execution.runId);
    const descriptor = this.runtimeCliAuth.get(profile.runtimeAccountId);
    return { messages: reassembleHistory(items), exactRun: true, local: true,
      runtimeHome: descriptor?.processHome || os.homedir() };
  }
  respondInspiration(id, input) { return this._inspirationCall("inspiration.respond", { ...input, id }); }
  cancelInspiration(id, input) { return this._inspirationCall("inspiration.cancel", { ...input, id }); }

  async getExternalInspirationSessionRoute(input) {
    const result = await this._call("inspiration.session.get", input);
    if (!result.origin) return null;
    const target = { ...input, inspirationId: result.origin.inspirationId };
    return {
      origin: result.origin,
      projectHistory: history => this.projectExternalInspirationHistory(input, history),
      sendMessage: (key, message, runId, hooks, opts) => {
        if (key !== target.sessionKey) throw safeError(null, "INSPIRATION_BINDING_INVALID");
        return this.sendExternalInspirationMessage(target, message, runId, hooks, opts);
      },
      watchSession: (key, hooks, opts) => {
        if (key !== target.sessionKey) throw safeError(null, "INSPIRATION_BINDING_INVALID");
        return this.watchExternalInspirationSession(target, hooks, opts);
      },
      abortChat: (key) => this._controlExternalInspirationSession(target, key, null),
      respondChatPrompt: (key, data) => this._controlExternalInspirationSession(target, key, data),
    };
  }

  _assertExternalInspirationExecution(target, idea, runId = null) {
    const execution = idea?.latestExecution;
    if (idea?.id !== target.inspirationId || !execution || execution.profileId !== null
      || execution.agentId !== target.agentId || execution.backendId !== target.backendId
      || execution.sessionKey !== target.sessionKey || (runId !== null && execution.runId !== runId)) {
      throw safeError(null, "INSPIRATION_BINDING_INVALID");
    }
    return execution;
  }

  async projectExternalInspirationHistory(target, history) {
    const { inspirationHistoryText, projectInspirationHistory } = require("./inspiration-chat-history");
    if (!Array.isArray(history?.messages) || !history.messages.some(message => inspirationHistoryText(message))) return history;
    const projections = await this._page("inspiration.session.messages", target, "items", {
      pageLimit: 50, maxBytes: MAX_HISTORY_BYTES, maxItems: MAX_HISTORY_ITEMS,
    });
    return projectInspirationHistory(history, projections);
  }

  async _loadExternalInspirationExecution(target, runId = null, idea = null) {
    if (idea === null) ({ idea } = await this._call("inspiration.get", { id: target.inspirationId }));
    const latest = this._assertExternalInspirationExecution(target, idea, runId);
    // get/list intentionally omit attention. The execution projection is the
    // bounded, canonical source for an approval or input card.
    if (!["waiting_input", "waiting_approval"].includes(latest.status)) return latest;
    const result = await this._call("inspiration.executions", { id: idea.id, cursor: null, limit: 1 });
    const detailed = this._assertExternalInspirationExecution(target,
      { id: idea.id, latestExecution: result.executions[0] }, latest.runId);
    if (detailed.id !== latest.id) throw safeError(null, "INSPIRATION_BINDING_INVALID");
    return detailed;
  }

  async _controlExternalInspirationSession(target, key, data) {
    if (key !== target.sessionKey) throw safeError(null, "INSPIRATION_BINDING_INVALID");
    const execution = await this._loadExternalInspirationExecution(target);
    if (data === null) return this.cancelInspiration(target.inspirationId, {
      operationId: `cancel-${this.randomUUID()}`, runId: execution.runId,
    });
    const attention = execution.attention;
    if (!attention?.active || attention.request.requestId !== data.requestId) {
      throw safeError(null, "INSPIRATION_REQUEST_EXPIRED");
    }
    let response;
    try {
      response = validateInteractiveResponseV1(attention.request, attention.request.fields.length === 0
        ? { choice: data.choice } : { action: data.action, answers: data.answers });
    } catch { throw safeError(null, "INSPIRATION_INVALID"); }
    return this.respondInspiration(target.inspirationId, { operationId: `respond-${this.randomUUID()}`,
      runId: execution.runId, requestId: data.requestId, response });
  }

  async sendExternalInspirationMessage(target, message, clientRunId, hooks = {}, opts = {}) {
    if (Array.isArray(opts.attachments) && opts.attachments.length > 0) {
      throw new Error("灵感会话暂不支持附件");
    }
    if (opts.signal?.aborted) return;
    const generation = this._generation;
    const sent = await this._call("inspiration.session.send", {
      backendId: target.backendId, agentId: target.agentId, sessionKey: target.sessionKey,
      operationId: sendOperationId(`${target.backendId}:${target.sessionKey}`, clientRunId, this.randomUUID),
      prompt: String(message),
    });
    opts.onAccepted?.();
    const execution = await this._loadExternalInspirationExecution(target, null, sent.idea);
    return this._observeExternalInspirationExecution(target, execution, hooks, opts, generation);
  }

  async watchExternalInspirationSession(target, hooks = {}, opts = {}) {
    if (opts.signal?.aborted) return;
    const generation = this._generation;
    const execution = await this._loadExternalInspirationExecution(target);
    // Historical terminal messages belong to the real backend's history.
    // Replaying a terminal on every refresh would cause a history/final loop.
    if (!["queued", "starting", "running", "waiting_input", "waiting_approval"].includes(execution.status)) return;
    return this._observeExternalInspirationExecution(target, execution, hooks, opts, generation);
  }

  _externalInspirationPrompt(attention) {
    const request = structuredClone(attention.request);
    if (request.fields.length !== 0) return request;
    const message = [request.message,
      attention.command !== null ? `命令：\n${attention.command}` : null,
      attention.cwd !== null ? `工作目录：\n${attention.cwd}` : null,
      attention.details !== null ? `审批详情：\n${attention.details}` : null,
    ].filter(value => value !== null && value !== "").join("\n\n");
    if (message.isWellFormed() && !message.includes("\0")
      && Buffer.byteLength(JSON.stringify(message), "utf8") <= 16 * 1024) return { ...request, message };
    const approvalChoices = request.approvalChoices.filter(choice => choice === "deny" || choice === "cancel");
    if (approvalChoices.length === 0) throw safeError(null, "INSPIRATION_RESPONSE_INVALID");
    const { approvalDetails: _hiddenDetails, approvalOptions: _hiddenOptions, ...safeRequest } = request;
    return { ...safeRequest, approvalChoices,
      message: "审批详情无法在此会话中完整显示。请返回灵感卡片查看；这里仅可拒绝或取消。" };
  }

  async _observeExternalInspirationExecution(target, execution, hooks, opts, generation) {
    const runId = execution.runId;
    let lastStatus = null;
    let lastSummary = null;
    let requestId = null;
    let errors = 0;
    // Only observe the execution persisted by the Service. Never dispatch a
    // second backend chat.send, or read unrelated Session history for recovery.
    while (!opts.signal?.aborted && generation === this._generation) {
      if (execution.status !== lastStatus) {
        lastStatus = execution.status;
        this._invokeHook(hooks, "status", { kind: lastStatus, text: lastStatus });
      }
      const pending = execution.attention?.active ? this._externalInspirationPrompt(execution.attention) : null;
      if (requestId && requestId !== pending?.requestId) this._invokeHook(hooks, "promptExpire", { requestId });
      if (pending && pending.requestId !== requestId) this._invokeHook(hooks, "prompt", pending);
      requestId = pending?.requestId || null;
      if (execution.resultSummary !== null && execution.resultSummary !== lastSummary) {
        lastSummary = execution.resultSummary;
        this._invokeHook(hooks, "delta", lastSummary);
      }
      if (!["queued", "starting", "running", "waiting_input", "waiting_approval"].includes(execution.status)) {
        if (requestId) this._invokeHook(hooks, "promptExpire", { requestId });
        if (execution.status === "completed" || execution.status === "canceled") {
          this._invokeHook(hooks, "final", execution.resultSummary || "", false,
            { runId, notificationCategory: "inspiration", ...(execution.status === "canceled" ? { stopReason: "cancelled" } : {}) });
        } else {
          this._invokeHook(hooks, "error", `灵感任务未完成 (${execution.errorCode || execution.status})`);
        }
        this._readyNotifier?.();
        return;
      }
      await this.delay(Math.max(100, this.pollIntervalMs));
      if (opts.signal?.aborted || generation !== this._generation) return;
      try {
        execution = await this._loadExternalInspirationExecution(target, runId);
        errors = 0;
      } catch (error) {
        errors += 1;
        if (error?.code === "INSPIRATION_BINDING_INVALID" || errors >= this.maxPollErrors) throw error;
      }
    }
  }

  async startExternalInspiration(id, input) {
    if (!["openclaw", "hermes"].includes(input.backendId)) {
      throw safeError(null, "INSPIRATION_UNSUPPORTED");
    }
    if (!this._isServiceReady(await this._call("service.status", {}))) {
      throw safeError(null, "INSPIRATION_UNAVAILABLE");
    }
    const result = await this._inspirationCall("inspiration.start", { ...input, id });
    const execution = result.idea.latestExecution;
    if (!execution || execution.profileId !== null || execution.backendId !== input.backendId
      || execution.agentId !== input.agentId) throw safeError(null, "INSPIRATION_BINDING_INVALID");
    return result;
  }

  async startInspiration(id, input) {
    const profile = this._profilesByAgent.get(input.agentId);
    if (!profile || input.backendId !== this.id || !this.getInspirationCapabilities().execute) {
      throw safeError(null, "INSPIRATION_UNSUPPORTED");
    }
    this._assertRuntimeEnabled(profile);
    const result = await this._inspirationCall("inspiration.start", { ...input, id });
    const execution = result.idea.latestExecution;
    if (!execution || execution.profileId !== profile.id || execution.backendId !== this.id
      || execution.agentId !== profile.agentId) throw safeError(null, "INSPIRATION_BINDING_INVALID");
    await this._syncFederationTargetSession({ profileId: profile.id, sessionKey: execution.sessionKey }, this._generation);
    this._readyNotifier?.();
    return result;
  }

  async getCronJobs(options = {}) {
    this._assertDomainReady();
    const rows = [];
    let aggregate = { bytes: 0, items: 0 };
    let outputAggregate = { bytes: 0, items: 0 };
    for (const profile of this._profilesByAgent.values()) {
      const values = await this._domainPage(
        "cron.job.list", { profileId: profile.id, enabled: null }, "jobs",
      );
      aggregate = this._assertDomainAggregate(values, aggregate.bytes, aggregate.items);
      for (const value of values) {
        this._assertCronJobProfile(value, profile);
        const runValues = await this._cronRunsForJob(value.id, profile);
        aggregate = this._assertDomainAggregate(
          runValues, aggregate.bytes, aggregate.items,
        );
        let prompt;
        if (options.includePrompt === true) {
          prompt = await this._readDomainContent(
            "cron.job.prompt.read", { jobId: value.id }, value.promptMeta,
          );
        }
        const row = this._mapCronJob(
          value, profile, prompt, this._cronLastFields(runValues),
        );
        outputAggregate = this._assertDomainAggregate(
          [row], outputAggregate.bytes, outputAggregate.items,
        );
        rows.push(row);
      }
    }
    return rows.sort((left, right) => (
      left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
    ));
  }

  async _loadCronTarget(id) {
    this._assertDomainReady();
    const jobId = this._parseCronId(id);
    const result = await this._call("cron.job.get", { jobId });
    if (result.job.id !== jobId) throw safeError(null, "CRON_JOB_ID_INVALID");
    const profile = this._assertCronJobProfile(result.job);
    return { jobId, job: result.job, profile };
  }

  async getCronJob(id, options = {}) {
    const target = await this._loadCronTarget(id);
    const runValues = await this._cronRunsForTarget(target);
    let prompt;
    if (options.includePrompt === true) {
      prompt = await this._readDomainContent(
        "cron.job.prompt.read", { jobId: target.jobId }, target.job.promptMeta,
      );
    }
    return this._mapCronJob(
      target.job, target.profile, prompt, this._cronLastFields(runValues),
    );
  }

  async createCronJob(spec = {}) {
    this._rejectUnsupportedTaskFields(spec, new Set([
      "agentId", "profileId", "name", "prompt", "enabled", "workspace", "schedule",
      "misfirePolicy", "maxCatchUp", "overlapPolicy", "threadPolicy", "threadId",
      "backendId",
    ]), "CRON_CREATE_UNSUPPORTED");
    if (spec.backendId !== undefined && spec.backendId !== this.id) {
      throw safeError(null, "PROFILE_NOT_FOUND");
    }
    const profile = this._domainProfile({
      ...this._profileSelectors(spec),
    });
    const createdAt = this.now();
    const prompt = String(spec.prompt || "");
    const schedule = this._cronScheduleFromUi(spec.schedule, createdAt);
    const threadPolicy = spec.threadPolicy || "new";
    const threadId = threadPolicy === "new" ? null : spec.threadId;
    const mutation = {
      operationId: `cron-create-${this.randomUUID()}`,
      name: String(spec.name || ""),
      enabled: spec.enabled !== false,
      profileId: profile.id,
      prompt,
      workspace: spec.workspace === undefined ? null : spec.workspace,
      schedule,
      misfirePolicy: spec.misfirePolicy || "latest",
      maxCatchUp: spec.maxCatchUp === undefined ? 1 : spec.maxCatchUp,
      overlapPolicy: spec.overlapPolicy || "skip",
      threadPolicy,
      threadId: threadId === undefined ? null : threadId,
      createdAt,
    };
    const result = await this._call("cron.job.create", mutation);
    this._assertCronJobProfile(result.job, profile);
    this._assertPromptMeta(result.job.promptMeta, prompt);
    if (!fieldsMatch(result.job, {
      name: mutation.name,
      enabled: mutation.enabled,
      profileId: mutation.profileId,
      workspace: mutation.workspace,
      schedule: mutation.schedule,
      misfirePolicy: mutation.misfirePolicy,
      maxCatchUp: mutation.maxCatchUp,
      overlapPolicy: mutation.overlapPolicy,
      threadPolicy: mutation.threadPolicy,
      threadId: mutation.threadId,
      createdAt,
      updatedAt: createdAt,
    })) throw safeError(null, "CRON_MUTATION_BINDING_INVALID");
    return this._mapCronJob(result.job, profile, prompt);
  }

  async updateCronJob(id, patch = {}) {
    const target = await this._loadCronTarget(id);
    this._rejectUnsupportedTaskFields(patch, new Set([
      "name", "prompt", "enabled", "workspace", "schedule", "misfirePolicy",
      "maxCatchUp", "overlapPolicy", "threadPolicy", "threadId",
    ]), "CRON_PATCH_UNSUPPORTED");
    const keys = Object.keys(patch).filter((key) => patch[key] !== undefined);
    if (keys.length === 0) throw safeError(null, "CRON_PATCH_INVALID");
    const createdAt = this.now();
    if (Object.prototype.hasOwnProperty.call(patch, "enabled")) {
      if (keys.length !== 1) throw safeError(null, "CRON_PATCH_MIXED_UNSUPPORTED");
      const result = await this._call("cron.job.enabled.set", {
        operationId: `cron-enabled-${this.randomUUID()}`,
        jobId: target.jobId,
        enabled: patch.enabled,
        createdAt,
      });
      this._assertCronJobProfile(result.job, target.profile);
      if (result.job.id !== target.jobId) throw safeError(null, "CRON_JOB_ID_INVALID");
      if (result.job.enabled !== patch.enabled) {
        throw safeError(null, "CRON_MUTATION_BINDING_INVALID");
      }
      return this._mapCronJob(result.job, target.profile);
    }
    const update = {};
    for (const key of keys) {
      update[key] = key === "schedule"
        ? this._cronScheduleFromUi(patch.schedule, createdAt, target.job.schedule)
        : patch[key];
    }
    if (Object.prototype.hasOwnProperty.call(update, "threadPolicy")) {
      if (update.threadPolicy === "new") update.threadId = null;
      else if (!Object.prototype.hasOwnProperty.call(update, "threadId")) {
        if (target.job.threadPolicy === update.threadPolicy && target.job.threadId !== null) {
          update.threadId = target.job.threadId;
        } else {
          // A null continue binding lets the Service resolve the one durable
          // job-scoped threadSource. Legacy explicit bindings remain readable.
          update.threadId = null;
        }
      }
    }
    const result = await this._call("cron.job.update", {
      operationId: `cron-update-${this.randomUUID()}`,
      jobId: target.jobId,
      patch: update,
      createdAt,
    });
    this._assertCronJobProfile(result.job, target.profile);
    if (result.job.id !== target.jobId) throw safeError(null, "CRON_JOB_ID_INVALID");
    if (typeof update.prompt === "string") this._assertPromptMeta(result.job.promptMeta, update.prompt);
    const scalarUpdate = { ...update };
    delete scalarUpdate.prompt;
    if (!fieldsMatch(result.job, scalarUpdate)) {
      throw safeError(null, "CRON_MUTATION_BINDING_INVALID");
    }
    return this._mapCronJob(result.job, target.profile,
      typeof update.prompt === "string" ? update.prompt : undefined);
  }

  async deleteCronJob(id) {
    const target = await this._loadCronTarget(id);
    const result = await this._call("cron.job.delete", {
      operationId: `cron-delete-${this.randomUUID()}`,
      jobId: target.jobId,
      createdAt: this.now(),
    });
    if (result.jobId !== target.jobId || result.deleted !== true) {
      throw safeError(null, "CRON_JOB_ID_INVALID");
    }
  }

  _mapCronRun(value) {
    const run = value.run;
    let status;
    if (run.status === "completed") status = "ok";
    else if (run.status === "skipped") status = "skipped";
    else if (["failed", "canceled", "interrupted"].includes(run.status)) status = "error";
    else status = "running";
    const startedAt = run.startedAt === null ? value.createdAt : run.startedAt;
    const output = {
      id: run.id,
      kind: value.kind,
      startedAt,
      finishedAt: run.finishedAt,
      status,
      error: run.errorCode || undefined,
      summary: run.resultSummary || undefined,
      ...(value.sessionKey ? { sessionKey: gatewaySessionKey(
        this._assertKnownProfileId(run.profileId).agentId, value.sessionKey,
      ) } : {}),
      durationMs: run.finishedAt === null ? undefined : Math.max(0, run.finishedAt - startedAt),
    };
    return output;
  }

  async _cronRunsForJob(jobId, profile) {
    const values = await this._domainPage(
      "cron.run.list", { jobId, status: null }, "runs",
    );
    for (const value of values) {
      if (value.run.profileId !== profile.id || value.run.sourceId !== jobId) {
        throw safeError(null, "CRON_PROFILE_MISMATCH");
      }
    }
    return values;
  }

  async _cronRunsForTarget(target) {
    return this._cronRunsForJob(target.jobId, target.profile);
  }

  async runCronJob(id, mode = "force") {
    if (mode !== undefined && mode !== null && mode !== "force") {
      throw safeError(null, "CRON_RUN_MODE_UNSUPPORTED");
    }
    const target = await this._loadCronTarget(id);
    this._assertRuntimeEnabled(target.profile);
    const createdAt = this.now();
    const result = await this._call("cron.run.trigger", {
      operationId: `cron-trigger-${this.randomUUID()}`,
      jobId: target.jobId,
      createdAt,
    });
    if (result.run.sourceId !== target.jobId || result.run.profileId !== target.profile.id) {
      throw safeError(null, "CRON_PROFILE_MISMATCH");
    }
    return {
      runId: result.run.id,
      runStarted: ACTIVE_DOMAIN_RUN_STATUSES.has(result.run.status),
      status: this._mapCronRun({ run: result.run, kind: "manual", createdAt }).status,
    };
  }

  async getCronRuns(id, options = {}) {
    const target = await this._loadCronTarget(id);
    let runs = (await this._cronRunsForTarget(target)).map((value) => this._mapCronRun(value));
    if (options.status) runs = runs.filter((value) => value.status === options.status);
    if (options.query) {
      const query = String(options.query).toLocaleLowerCase();
      runs = runs.filter((value) => [value.summary, value.error, value.kind]
        .some((item) => typeof item === "string" && item.toLocaleLowerCase().includes(query)));
    }
    runs.sort((left, right) => (
      (right.startedAt || 0) - (left.startedAt || 0) || String(right.id).localeCompare(String(left.id))
    ));
    if (options.sortDir === "asc") runs.reverse();
    const offset = Number.isSafeInteger(options.offset) && options.offset >= 0 ? options.offset : 0;
    const limit = Number.isSafeInteger(options.limit) && options.limit > 0
      ? Math.min(options.limit, MAX_DOMAIN_AGGREGATE_ITEMS) : 25;
    return { runs: runs.slice(offset, offset + limit) };
  }

  async _dashboardProfiles() {
    this._assertDomainReady();
    const profiles = await this._page("profile.list", { backendId: this.id, enabledOnly: false }, "profiles", {
      maxBytes: MAX_DOMAIN_AGGREGATE_BYTES, maxItems: MAX_DOMAIN_AGGREGATE_ITEMS,
    });
    if (profiles.some(profile => !this._acceptsProfileBackend(profile.backendId))) throw safeError(null, "PROFILE_NOT_FOUND");
    return profiles;
  }

  async getRecentCronRuns({ sinceMs = 0, limit = 50 } = {}) {
    const profiles = await this._dashboardProfiles();
    const rows = [];
    let aggregate = { bytes: 0, items: 0 };
    for (const profile of profiles) {
      const [jobs, runs] = await Promise.all([
        this._domainPage("cron.job.list", { profileId: profile.id, enabled: null }, "jobs"),
        this._page("run.list", { profileId: profile.id, sessionKey: null, status: null }, "runs", {
          maxBytes: MAX_DOMAIN_AGGREGATE_BYTES, maxItems: MAX_DOMAIN_AGGREGATE_ITEMS,
        }),
      ]);
      aggregate = this._assertDomainAggregate(runs, aggregate.bytes, aggregate.items);
      const byId = new Map(jobs.map(job => [job.id, job]));
      for (const value of runs) {
        if (value.profileId !== profile.id) throw safeError(null, "CRON_PROFILE_MISMATCH");
        if (value.source !== "cron" || (value.finishedAt ?? value.startedAt ?? value.createdAt) < sinceMs) continue;
        const run = this._mapCronRun({ run: value, createdAt: value.createdAt });
        rows.push({ backendId: this.id, jobId: `${this.id}:${value.sourceId}`,
          jobName: byId.get(value.sourceId)?.name, agentId: profile.agentId, runId: value.id, ...run });
      }
    }
    rows.sort((left, right) => (right.finishedAt ?? right.startedAt ?? 0) - (left.finishedAt ?? left.startedAt ?? 0));
    const cap = Number.isSafeInteger(limit) && limit > 0 ? limit : 50;
    return { runs: rows.slice(0, cap), ...(rows.length > cap ? { truncated: true } : {}) };
  }

  async getRecentKanbanActivities({ sinceMs = 0 } = {}) {
    this._assertDomainReady();
    const items = [];
    let aggregate = { bytes: 0, items: 0 };
    for (const profile of await this._dashboardProfiles()) {
      const boards = await this._listBoardsForProfile(profile);
      for (const board of boards) {
        const cards = await this._domainPage("kanban.card.list", { boardId: board.id, status: null }, "cards");
        aggregate = this._assertDomainAggregate(cards, aggregate.bytes, aggregate.items);
        for (const card of cards) {
          if (card.profileId !== profile.id || card.boardId !== board.id) throw safeError(null, "KANBAN_PROFILE_MISMATCH");
          const activity = (action, at, identity, summary) => ({
            id: `kanban:${this.id}:${card.id}:${identity}`, backendId: this.id, kind: "kanban",
            occurredAt: at, severity: action === "completed" ? "success" : "error",
            title: card.title, agentId: profile.agentId,
            ...(summary ? { summary } : {}),
            kanban: { taskId: card.id, board: board.id, action },
          });
          if (card.completion && card.completion.at >= sinceMs) {
            items.push(activity("completed", card.completion.at, `completed:${card.completion.at}`, card.completion.note));
          }
          if (card.updatedAt < sinceMs) continue;
          const runs = await this._domainPage("kanban.run.list", { cardId: card.id, status: null }, "runs");
          aggregate = this._assertDomainAggregate(runs, aggregate.bytes, aggregate.items);
          for (const run of runs) {
            if (run.profileId !== profile.id) throw safeError(null, "KANBAN_PROFILE_MISMATCH");
            if (run.status === "failed" && run.finishedAt >= sinceMs) {
              items.push(activity("failed", run.finishedAt, run.id, run.errorCode));
            }
          }
        }
      }
    }
    return { supported: true, items };
  }

  async _dashboardRuns() {
    this._assertDomainReady();
    const runs = [];
    let aggregate = { bytes: 0, items: 0 };
    for (const profile of this._profilesById.values()) {
      const scoped = await this._page("run.list", {
        profileId: profile.id,
        sessionKey: null,
        status: null,
      }, "runs", {
        maxBytes: MAX_DOMAIN_AGGREGATE_BYTES,
        maxItems: MAX_DOMAIN_AGGREGATE_ITEMS,
      });
      for (const run of scoped) {
        if (run.profileId !== profile.id) throw safeError(null, "PROFILE_NOT_FOUND");
      }
      aggregate = this._assertDomainAggregate(scoped, aggregate.bytes, aggregate.items);
      runs.push(...scoped);
    }
    return runs;
  }

  _dashboardRunningItem(run) {
    const profile = this._assertKnownProfileId(run.profileId);
    const kindLabel = { cron: "Cron", kanban: "Kanban", inspiration: "Inspiration" }[run.source];
    return {
      id: `${this.id}:${run.id}`,
      backendId: this.id,
      title: kindLabel,
      kind: run.source,
      waitingRequestId: run.waitingRequestId,
      runtime: profile.runtime,
      status: run.status,
      agentId: profile.agentId,
      runId: run.id,
      ...(run.startedAt !== null ? { startedAt: run.startedAt } : {}),
      ...(run.resultSummary ? { progressSummary: run.resultSummary } : {}),
    };
  }

  async getRunningWork() {
    const runs = await this._dashboardRuns();
    const items = runs
      .filter((run) => ["cron", "kanban", "inspiration"].includes(run.source)
        && ["starting", "running", "waiting_approval", "waiting_input"].includes(run.status))
      .map((run) => this._dashboardRunningItem(run))
      .sort((left, right) => (
        (right.startedAt || 0) - (left.startedAt || 0) || left.id.localeCompare(right.id)
      ));
    return { supported: true, items };
  }

  async _dashboardRunEvents(runId, options = {}) {
    const budget = options.budget || { bytes: 0, items: 0 };
    const maxBytes = options.maxBytes || MAX_DASHBOARD_EVENT_BYTES;
    const maxItems = options.maxItems || MAX_DASHBOARD_EVENT_ITEMS;
    const values = [];
    const seenCursors = new Set();
    let streamId = null;
    let afterSeq = 0;
    for (let pageIndex = 0; pageIndex < this.maxPages; pageIndex += 1) {
      const result = await this._call("run.subscribe", {
        runId,
        streamId,
        afterSeq,
        limit: MAX_PAGE_LIMIT,
      });
      if (result.runId !== runId || (streamId !== null && result.streamId !== streamId)) {
        throw safeError(null, "WORK_RUN_CONTROL_MISMATCH");
      }
      if (result.gap !== null) return values;
      if (result.cursor !== afterSeq) throw safeError(null, "CURSOR_NOT_ADVANCING");
      for (const event of result.events) {
        const bytes = encodedBytes(event);
        budget.bytes += bytes;
        budget.items += 1;
        if (budget.bytes > maxBytes || budget.items > maxItems) {
          throw safeError(null, "RESPONSE_TOO_LARGE");
        }
        values.push(event);
      }
      if (!result.hasMore) return values;
      if (result.nextCursor <= afterSeq || seenCursors.has(result.nextCursor)) {
        throw safeError(null, "CURSOR_NOT_ADVANCING");
      }
      seenCursors.add(result.nextCursor);
      streamId = result.streamId;
      afterSeq = result.nextCursor;
    }
    throw safeError(null, "PAGE_LIMIT_EXCEEDED");
  }

  _dashboardPromptDetails(run, events) {
    const event = [...events].reverse().find((candidate) => (
      (candidate.type === "approval" || candidate.type === "prompt")
      && candidate.payload?.requestId === run.waitingRequestId
    ));
    if (!event) return {};
    const payload = event.payload;
    let interactiveRequest;
    try {
      interactiveRequest = normalizeInteractiveRequestV1({
        runId: run.id,
        eventType: event.type,
        payload,
        expiresAt: payload.expiresAt ?? null,
      });
    } catch {
      return {
        message: "交互请求格式不兼容，请重新发起",
        interactionInvalid: true,
      };
    }
    if (event.type === "approval") {
      let commandText = null;
      if (typeof payload.command === "string") commandText = boundedText(payload.command, 8192);
      else if (Array.isArray(payload.command) && payload.command.length <= 128
        && payload.command.every((part) => safeString(part, 1024))) {
        commandText = boundedText(payload.command.join(" "), 8192);
      }
      return {
        message: interactiveRequest.message,
        interactiveRequest,
        ...(commandText ? {
          commandText,
          commandPreview: boundedText(commandText, 256),
        } : {}),
      };
    }
    return {
      message: interactiveRequest.message,
      interactiveRequest,
      questions: interactiveRequest.fields,
    };
  }

  async getPendingApprovals() {
    const runs = (await this._dashboardRuns())
      .filter((run) => ["waiting_approval", "waiting_input"].includes(run.status));
    const budget = { bytes: 0, items: 0 };
    const items = await mapBounded(runs, MAX_PROFILE_SESSION_CONCURRENCY, async (run) => {
      const profile = this._assertKnownProfileId(run.profileId);
      const events = await this._dashboardRunEvents(run.id, {
        budget,
        maxBytes: MAX_DOMAIN_AGGREGATE_BYTES,
        maxItems: MAX_DOMAIN_AGGREGATE_ITEMS,
      });
      const kind = run.status === "waiting_approval" ? "approval" : "input";
      const details = this._dashboardPromptDetails(run, events);
      const interaction = details.interactiveRequest;
      return {
        id: `${this.id}:${run.id}:${run.waitingRequestId}`,
        backendId: this.id,
        kind,
        runId: run.id,
        requestId: run.waitingRequestId,
        agentId: profile.agentId,
        source: run.source,
        allowedDecisions: interaction?.fields?.length === 0
          ? [...interaction.approvalChoices] : ["submit", "cancel"],
        ...(interaction?.expiresAt === null || interaction?.expiresAt === undefined
          ? {} : { expiresAtMs: interaction.expiresAt }),
        ...details,
      };
    });
    items.sort((left, right) => left.id.localeCompare(right.id));
    return { supported: true, items };
  }

  async respondDashboardPrompt(input) {
    if (!ownDataObject(input) || !safeString(input.runId, 128)
      || !safeString(input.requestId, 128) || !["approval", "input"].includes(input.kind)) {
      throw safeError(null, "INVALID_PARAMS");
    }
    const isApproval = input.kind === "approval";
    const expectedFields = isApproval
      ? ["runId", "requestId", "kind", "choice"]
      : ["runId", "requestId", "kind", "action", "answers"];
    if (!exactObject(input, expectedFields)) throw safeError(null, "INVALID_PARAMS");
    if (isApproval && !validInteractiveApprovalChoice(input.choice)) {
      throw safeError(null, "RUN_APPROVAL_DECISION_INVALID");
    }
    if (!isApproval && (!new Set(["submit", "cancel"]).has(input.action)
      || !ownDataObject(input.answers) || Object.keys(input.answers).length > 32
      || Object.entries(input.answers).some(([key, value]) => (
        !safeString(key, 128) || !safeString(value, 16 * 1024)
      )) || (input.action === "cancel" && Object.keys(input.answers).length !== 0))) {
      throw safeError(null, "RUN_INPUT_RESPONSE_INVALID");
    }
    const snapshot = await this._call("run.get", { runId: input.runId });
    const run = snapshot.run;
    this._assertKnownProfileId(run.profileId);
    const expectedStatus = isApproval ? "waiting_approval" : "waiting_input";
    if (run.id !== input.runId || run.status !== expectedStatus
      || run.waitingRequestId !== input.requestId) {
      throw safeError(null, "RUN_REQUEST_NOT_FOUND");
    }
    if (isApproval) {
      const details = this._dashboardPromptDetails(
        run,
        await this._dashboardRunEvents(run.id),
      );
      if (details.interactiveRequest?.kind !== "runtime_approval") {
        throw safeError(null, "RUN_APPROVAL_DECISION_INVALID");
      }
      try {
        validateInteractiveResponseV1(details.interactiveRequest, { choice: input.choice });
      } catch {
        throw safeError(null, "RUN_APPROVAL_DECISION_INVALID");
      }
    }
    const createdAt = this.now();
    const result = await this._call(
      isApproval ? "run.approval.respond" : "run.input.respond",
      isApproval ? {
        operationId: `approval-${this.randomUUID()}`,
        createdAt,
        runId: input.runId,
        requestId: input.requestId,
        choice: input.choice,
      } : {
        operationId: `input-${this.randomUUID()}`,
        createdAt,
        runId: input.runId,
        requestId: input.requestId,
        action: input.action,
        answers: structuredClone(input.answers),
      },
    );
    if (result.requestId !== input.requestId || result.run.id !== input.runId
      || result.run.profileId !== run.profileId || result.run.source !== run.source
      || result.run.sourceId !== run.sourceId || result.run.status !== "running") {
      throw safeError(null, "WORK_RUN_CONTROL_MISMATCH");
    }
    return result;
  }

  _dashboardEvent(event) {
    const base = { seq: event.seq, type: event.type };
    const payload = event.payload;
    if (event.type === "status") {
      const status = boundedText(payload?.status, 128);
      return status ? { ...base, status } : base;
    }
    if (event.type === "text") {
      const text = boundedText(payload?.text, 16 * 1024);
      return text ? { ...base, text } : base;
    }
    if (event.type === "tool.start" || event.type === "tool.result") {
      const tool = ownDataObject(payload?.tool) ? payload.tool : null;
      if (!tool) return base;
      const projected = {};
      for (const key of ["kind", "name", "status", "errorCode"]) {
        const value = boundedText(tool[key], 512);
        if (value) projected[key] = value;
      }
      if (typeof tool.success === "boolean") projected.success = tool.success;
      if (Number.isSafeInteger(tool.exitCode)) projected.exitCode = tool.exitCode;
      return Object.keys(projected).length > 0 ? { ...base, tool: projected } : base;
    }
    if (event.type === "terminal") {
      const status = boundedText(payload?.status, 128);
      const summary = boundedText(payload?.resultSummary, 16 * 1024);
      const error = boundedText(payload?.errorCode, 128);
      return {
        ...base,
        ...(status ? { status } : {}),
        ...(summary ? { summary } : {}),
        ...(error ? { error } : {}),
      };
    }
    if (event.type === "approval" || event.type === "prompt") {
      const requestId = boundedText(payload?.requestId, 128);
      const message = boundedText(payload?.reason, 4096) || boundedText(payload?.message, 4096);
      return {
        ...base,
        ...(requestId ? { requestId } : {}),
        ...(message ? { message } : {}),
      };
    }
    return base;
  }

  async getDashboardRunDetail(runId) {
    this._assertDomainReady();
    if (!safeString(runId, 128)) throw safeError(null, "INVALID_PARAMS");
    const result = await this._call("run.get", { runId });
    const run = result.run;
    if (run.id !== runId) throw safeError(null, "WORK_RUN_CONTROL_MISMATCH");
    const profile = this._assertKnownProfileId(run.profileId);
    const events = await this._dashboardRunEvents(runId);
    return {
      id: `${this.id}:${run.id}`,
      backendId: this.id,
      runId: run.id,
      source: run.source,
      status: run.status,
      agentId: profile.agentId,
      ...(run.startedAt !== null ? { startedAt: run.startedAt } : {}),
      ...(run.finishedAt !== null ? { finishedAt: run.finishedAt } : {}),
      ...(run.resultSummary ? { summary: run.resultSummary } : {}),
      ...(run.errorCode ? { error: run.errorCode } : {}),
      ...(run.retryOf ? { retryOf: run.retryOf } : {}),
      events: events.map((event) => this._dashboardEvent(event)),
      artifacts: [],
    };
  }

  async getCronLatestDelivery(id, atMs) {
    const target = await this._loadCronTarget(id);
    const values = await this._cronRunsForTarget(target);
    let selected = null;
    if (Number.isFinite(atMs)) {
      const matches = values.filter((value) => (
        value.kind === "schedule" && value.createdAt === atMs
      ));
      if (matches.length > 1) throw safeError(null, "CRON_RUN_BINDING_INVALID");
      selected = matches.length === 1 ? this._mapCronRun(matches[0]) : null;
    } else {
      selected = values.map((value) => this._mapCronRun(value))
        .filter((value) => typeof value.startedAt === "number")
        .sort((left, right) => right.startedAt - left.startedAt)[0] || null;
    }
    if (!selected) return { source: "none" };
    const output = {
      status: selected.status,
      startedAt: selected.startedAt,
      finishedAt: selected.finishedAt,
      durationMs: selected.durationMs,
      ...(selected.summary ? { summary: selected.summary } : {}),
      fullText: null,
      source: selected.summary ? "summary" : "none",
      ...(selected.error ? { error: selected.error } : {}),
      ...(selected.sessionKey ? { sessionKey: selected.sessionKey } : {}),
      runId: selected.id,
    };
    if (selected.sessionKey && selected.status === "ok") {
      const messages = await this._cronRunMessages(target, selected);
      const final = messages.filter((message) => message.role === "assistant")
        .map((message) => message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"))
        .filter((text) => text.trim()).at(-1);
      if (final) { output.fullText = final; output.source = "transcript"; }
    }
    return output;
  }

  async _cronRunMessages(target, selected) {
    const { sessionKey, agentId } = parseGatewaySessionKey(selected.sessionKey);
    if (agentId !== target.profile.agentId) throw safeError(null, "CRON_PROFILE_MISMATCH");
    const items = await this._page("chat.history", { sessionKey }, "messages", {
      newestFirst: true, maxBytes: MAX_HISTORY_BYTES, maxItems: MAX_HISTORY_ITEMS,
    });
    return reassembleHistory(items.filter((item) => item.runId === selected.id));
  }

  async getCronRunTrajectory(id, { sessionKey, runId } = {}) {
    const target = await this._loadCronTarget(id);
    const runs = (await this._cronRunsForTarget(target)).map((value) => this._mapCronRun(value));
    const matches = runs.filter((run) => run.sessionKey && (!sessionKey || run.sessionKey === sessionKey)
      && (!runId || run.id === runId));
    if (!matches.length) return { supported: false, reason: "unsupported", parts: [] };
    // A continued session can contain several occurrences. Do not present another
    // occurrence's trajectory when the caller only supplies a session identity.
    if (matches.length !== 1) return { supported: false, reason: "ambiguous-run", parts: [] };
    const messages = await this._cronRunMessages(target, matches[0]);
    const parts = messages.flatMap((message) => message.content.flatMap((part) => {
      const ts = message.timestamp;
      if (part.type === "text" && message.role === "assistant") return [{ type: "text", text: part.text, ts }];
      if (part.type === "thinking") return [{ type: "thinking", text: part.thinking, ts }];
      if (part.type === "toolCall") return [{ type: "toolCall", toolName: part.toolName,
        toolCallId: part.toolCallId, toolArgs: part.arguments, ts }];
      if (part.type === "toolResult") return [{ type: "toolResult", toolName: part.name,
        toolCallId: part.toolCallId, text: part.content, isError: part.is_error, ts }];
      return [];
    }));
    return { supported: parts.length > 0, parts };
  }

  async createSession(agentId, options = {}) {
    const profile = this._profilesByAgent.get(agentId);
    if (!profile) throw safeError(null, "BACKEND_NOT_READY");
    let workspace = options?.workspace;
    if (workspace === undefined && typeof options?.parentSessionKey === "string") {
      const parent = this._sessionTarget(options.parentSessionKey);
      if (parent.agentId !== agentId) throw safeError(null, "CHAT_SESSION_INVALID");
      workspace = parent.session.workspace;
      if (isImplicitChatWorkspace(this.paths, profile, workspace)) workspace = null;
    }
    const result = await this._call("chat.session.create", {
      operationId: `create-${this.randomUUID()}`,
      profileId: profile.id,
      workspace: workspace ?? null,
      createdAt: this.now(),
    });
    if (result.session.profileId !== profile.id) throw safeError(null, "CHAT_SESSION_INVALID");
    this._upsertSession(profile, result.session);
    return gatewaySessionKey(agentId, result.session.sessionKey);
  }

  _upsertSession(profile, value) {
    if (!profile || value.profileId !== profile.id) throw safeError(null, "CHAT_SESSION_INVALID");
    const current = this._sessionsByKey.get(value.sessionKey);
    const session = {
      ...(current?.inspirationId ? { inspirationId: current.inspirationId, inspirationTitle: current.inspirationTitle } : {}),
      ...(current?.cronJobId ? { cronJobId: current.cronJobId, cronRunIds: current.cronRunIds } : {}),
      ...value, derivedTitle: Object.hasOwn(value, "derivedTitle") ? value.derivedTitle : current?.derivedTitle ?? null,
    };
    this._sessionsByKey.set(session.sessionKey, session);
    const row = sessionToRow(this._profileForSession(profile, session), session, this.id);
    const index = this._rows.findIndex((candidate) => candidate.sessionId === value.sessionKey);
    if (index < 0) this._rows = [...this._rows, row];
    else this._rows = this._rows.map((candidate, rowIndex) => rowIndex === index ? row : candidate);
  }

  async renameSession(key, label) {
    const { profile, sessionKey } = this._sessionTarget(key);
    const result = await this._call("chat.session.rename", {
      operationId: `rename-${this.randomUUID()}`,
      sessionKey,
      title: label === null || label === undefined || label === "" ? null : String(label),
      createdAt: this.now(),
    });
    if (result.session) this._upsertSession(profile, result.session);
  }

  async setSessionModel(key, opts = {}) {
    const { profile, sessionKey } = this._sessionTarget(key);
    const expectedProvider = profile.providerRef || profile.runtime;
    if (!safeString(opts.model, 512) || opts.model.length === 0
      || (opts.provider !== undefined && opts.provider !== null
        && opts.provider !== expectedProvider)) {
      throw safeError(null, "INVALID_PARAMS");
    }
    const result = await this._call("chat.session.model.set", {
      sessionKey,
      model: opts.model,
    });
    if (result.session.profileId !== profile.id) throw safeError(null, "CHAT_SESSION_INVALID");
    this._upsertSession(profile, result.session);
    return { model: result.session.modelOverride || profile.defaultModel, scope: "session" };
  }

  async setSessionPermission(key, opts = {}) {
    const { profile, sessionKey } = this._sessionTarget(key);
    if (!safeString(opts.mode, 64) || opts.mode.length === 0) {
      throw safeError(null, "INVALID_PARAMS");
    }
    const result = await this._call("chat.session.permission.set", {
      sessionKey,
      mode: opts.mode,
    });
    if (result.session.profileId !== profile.id) throw safeError(null, "CHAT_SESSION_INVALID");
    this._upsertSession(profile, result.session);
    return { mode: result.session.permissionMode, scope: "session" };
  }

  async _setSessionModelSettings(key, patch) {
    const { profile, sessionKey } = this._sessionTarget(key);
    const result = await this._call("chat.session.settings.set", { sessionKey, patch });
    if (result.session.profileId !== profile.id) throw safeError(null, "CHAT_SESSION_INVALID");
    this._upsertSession(profile, result.session);
    return result.session.modelSettings;
  }

  async setSessionThinking(key, opts = {}) {
    const settings = await this._setSessionModelSettings(key, { thinkingLevel: opts.level ?? null });
    return { level: settings.thinkingLevel, scope: "session" };
  }

  async setSessionFast(key, opts = {}) {
    const settings = await this._setSessionModelSettings(key, { fastMode: opts.fast });
    return { fast: settings.serviceTier !== null, scope: "session" };
  }

  async searchChat(agentId, query, opts = {}) {
    const profile = this._profilesByAgent.get(agentId);
    if (!profile) return { supported: false, results: [] };
    const text = typeof query === "string" ? query.trim() : "";
    if (!text) return { supported: true, results: [] };
    const result = await this._call("chat.search", { profileId: profile.id, query: text,
      limit: Number.isSafeInteger(opts.limit) ? Math.max(1, Math.min(50, opts.limit)) : 25 });
    return { supported: true, truncated: result.truncated, results: result.results.map(item => ({
      key: gatewaySessionKey(agentId, item.sessionKey), sessionId: item.sessionKey,
      messageId: item.messageId, role: item.role, ts: item.ts, snippet: item.snippet,
    })) };
  }

  async deleteSession(key) {
    const { profile, sessionKey } = this._sessionTarget(key);
    const result = await this._call("chat.session.delete", {
      operationId: `delete-${this.randomUUID()}`,
      sessionKey,
      createdAt: this.now(),
    });
    if (result.session && result.session.profileId !== this._sessionsByKey.get(sessionKey)?.profileId) {
      throw safeError(null, "CHAT_SESSION_INVALID");
    }
    const federationRunIds = new Set();
    for (const record of this._promptByRequest.values()) {
      if (record.federation === true && record.sessionKey === sessionKey) {
        federationRunIds.add(record.runId);
      }
    }
    for (const runId of federationRunIds) {
      try {
        this._sessionActivityNotifier?.({
          kind: "federation.chat.interaction.clear",
          runId,
          sessionKey: gatewaySessionKey(profile.agentId, sessionKey),
        });
      } catch {
        // Registry/UI listeners are observers and cannot invalidate durable state.
      }
    }
    this._sessionsByKey.delete(sessionKey);
    this._rows = this._rows.filter((row) => row.sessionId !== sessionKey);
    this._clearSessionRuntime(sessionKey);
  }

  async _getHistoryItems(key) {
    const { sessionKey, session } = this._sessionTarget(key);
    try {
      return await this._page("chat.history", { sessionKey }, "messages", {
        newestFirst: true,
        maxBytes: MAX_HISTORY_BYTES,
        maxItems: MAX_HISTORY_ITEMS,
      });
    } catch (error) {
      const code = error && typeof error === "object"
        ? Object.getOwnPropertyDescriptor(error, "code")?.value : null;
      // 首次打开的 draft 尚无 Codex thread；这表示历史为空，不是用户可处理的错误。
      // 仅吞掉 Service 对该精确状态的拒绝，ready/archived 或其它错误仍原样失败。
      if (session.status === "draft" && code === "CHAT_SESSION_NOT_READY") {
        return [];
      }
      throw error;
    }
  }

  async getHistory(key) {
    return { messages: reassembleHistory(await this._getHistoryItems(key)) };
  }

  async sendMessage(key, message, runId, hooks = {}, opts = {}) {
    let target = this._sessionTarget(key);
    const enabled = this._assertSessionRuntimeEnabled(target);
    if (enabled) await enabled;
    const { sessionKey } = target;
    const operationId = sendOperationId(sessionKey, runId, this.randomUUID);
    let generation = this._generation;
    let resolveConsumerCancellation;
    const poll = {
      cancelled: false,
      consumerCancelled: false,
      consumerCancellation: new Promise((resolve) => { resolveConsumerCancellation = resolve; }),
    };
    const state = {
      text: "",
      reasoning: "",
      settled: false,
      lastStatus: null,
      historyRequired: false,
      observerRecoveryAttempts: 0,
    };
    let terminalObserved = false;
    const observerHooks = {
      ...hooks,
      final: (...args) => {
        if (terminalObserved) return;
        terminalObserved = true;
        this._invokeHook(hooks, "final", ...args);
      },
      error: (...args) => {
        if (terminalObserved) return;
        terminalObserved = true;
        this._invokeHook(hooks, "error", ...args);
      },
    };
    this._polls.add(poll);
    let removeAbort = null;
    if (opts.signal && typeof opts.signal.addEventListener === "function") {
      const cancel = () => {
        poll.cancelled = true;
        poll.consumerCancelled = true;
        resolveConsumerCancellation();
      };
      if (opts.signal.aborted) cancel();
      else {
        opts.signal.addEventListener("abort", cancel, { once: true });
        removeAbort = () => opts.signal.removeEventListener("abort", cancel);
      }
    }
    try {
      if (poll.cancelled) return;
      const supplied = opts.attachments ?? [];
      const pathAttachment = supplied.length ? null : explicitPathAttachment(message);
      const items = pathAttachment ? [pathAttachment] : supplied;
      const attachments = items.length || !Array.isArray(items)
        ? await uploadChatAttachments((method, params) => {
          if (poll.cancelled) throw Object.assign(new Error("附件上传已取消"), { code: "ABORT_ERR" });
          return this._call(method, params);
        }, items, operationId) : [];
      if (poll.cancelled) return;
      const sent = await this._call("chat.send", {
        operationId,
        sessionKey,
        prompt: String(message),
        ...(attachments.length ? { attachments } : {}),
        createdAt: this.now(),
      });
      this._assertRunBinding(target, sent.run);
      const currentSession = this._sessionsByKey.get(sessionKey);
      const derivedTitle = deriveSessionTitle(String(message));
      if (currentSession && currentSession.derivedTitle === null && derivedTitle !== null) {
        this._upsertSession(target.profile, { ...currentSession, derivedTitle });
      }
      const active = {
        runId: sent.run.id,
        requestId: sent.run.waitingRequestId,
        status: sent.run.status,
        run: sent.run,
      };
      this._activeBySession.set(sessionKey, active);
      this._emitRunStatus(observerHooks, state, sent.run.status, {
        reason: sent.reason, queuedAt: this.now(),
      });
      let observedRun = sent.run;
      let streamId = null;
      let afterSeq = 0;
      while (!terminalObserved && !opts.signal?.aborted) {
        const outcome = await this._pollRun({
          key,
          sessionKey,
          target,
          run: observedRun,
          hooks: observerHooks,
          poll,
          generation,
          state,
          streamId,
          afterSeq,
          reconcileAccepted: true,
        });
        if (terminalObserved || state.settled || outcome.kind === "consumer-cancelled") return;
        streamId = outcome.streamId;
        afterSeq = outcome.afterSeq;
        const recovered = await this._reconcileAcceptedRun({
          key,
          sessionKey,
          target,
          run: observedRun,
          hooks: observerHooks,
          poll,
          generation,
          state,
        }, outcome.error);
        if (!recovered || terminalObserved || state.settled) return;
        target = recovered.target;
        observedRun = recovered.run;
        generation = recovered.generation;
        if (state.observerRecoveryAttempts > 0) {
          const retry = await Promise.race([
            this.delay(Math.min(
              1_000,
              25 * (2 ** Math.min(5, state.observerRecoveryAttempts - 1)),
            )).then(() => true),
            poll.consumerCancellation.then(() => false),
          ]);
          if (!retry) return;
        }
      }
    } catch (error) {
      if (!terminalObserved && !opts.signal?.aborted) {
        this._clearSessionRuntime(sessionKey);
        const failure = poll.cancelled || generation !== this._generation
          ? safeError(null, "SERVICE_UNAVAILABLE") : safeError(error);
        observerHooks.error(failure.message);
      }
    } finally {
      removeAbort?.();
      this._polls.delete(poll);
    }
  }

  async _pollRun(context) {
    let snapshotStreamIndex = context.snapshotFirst === true ? 0 : null;
    let streamId = snapshotStreamIndex === null ? context.streamId || null
      : RUN_RECONCILE_STREAM_IDS[snapshotStreamIndex];
    let afterSeq = Number.isSafeInteger(context.afterSeq) && context.afterSeq >= 0
      ? context.afterSeq : 0;
    let consecutiveErrors = 0;
    const state = context.state || {
      text: "",
      reasoning: "",
      settled: false,
      lastStatus: context.initialStatus || null,
    };
    while (!context.poll.cancelled && context.generation === this._generation) {
      let result;
      try {
        result = await this._call("run.subscribe", {
          runId: context.run.id,
          streamId,
          afterSeq,
          limit: MAX_PAGE_LIMIT,
        });
        consecutiveErrors = 0;
      } catch (error) {
        consecutiveErrors += 1;
        if (consecutiveErrors >= this.maxPollErrors) {
          const failure = safeError(error);
          if (context.reconcileAccepted === true
            && RUN_OBSERVER_TRANSIENT_ERROR_CODES.has(failure.code)) {
            state.observerRecoveryAttempts = Math.min(
              32,
              (state.observerRecoveryAttempts || 0) + 1,
            );
            return { kind: "observation-lost", error: failure, streamId, afterSeq };
          }
          this._clearSessionRuntime(context.sessionKey, context.run.id);
          this._settleError(state, context.hooks, failure.message);
          return { kind: "settled", streamId, afterSeq };
        }
        await this.delay(Math.min(1_000, 25 * (2 ** (consecutiveErrors - 1))));
        continue;
      }
      if (result.runId !== context.run.id) {
        if (!context.poll.consumerCancelled) {
          this._clearSessionRuntime(context.sessionKey, context.run.id);
          this._settleError(
            state,
            context.hooks,
            safeError(null, "CHAT_RESPONSE_INVALID").message,
          );
        }
        return { kind: "settled", streamId, afterSeq };
      }
      state.observerRecoveryAttempts = 0;
      if (context.poll.cancelled || context.generation !== this._generation) {
        const settled = await this._settleReturnedTerminal(context, state, result);
        if (settled) return { kind: "settled", streamId, afterSeq };
        return {
          kind: context.poll.consumerCancelled ? "consumer-cancelled" : "observation-lost",
          error: safeError(null, "SERVICE_UNAVAILABLE"),
          streamId,
          afterSeq,
        };
      }
      streamId = result.streamId;
      afterSeq = result.nextCursor;
      if (snapshotStreamIndex !== null) {
        if (result.gap === null) {
          // A reconnect needs the current approval before any historical events.
          // One of the two fixed ids always differs from the live stream id.
          snapshotStreamIndex += 1;
          if (snapshotStreamIndex >= RUN_RECONCILE_STREAM_IDS.length) throw safeError(null, "CHAT_RESPONSE_INVALID");
          streamId = RUN_RECONCILE_STREAM_IDS[snapshotStreamIndex];
          afterSeq = 0;
          continue;
        }
        snapshotStreamIndex = null;
      }
      if (result.gap !== null) {
        state.historyRequired = true;
        const snapshotRun = runFromSnapshot(result.snapshot, context.run.id);
        if (!snapshotRun) {
          this._clearSessionRuntime(context.sessionKey, context.run.id);
          this._settleError(state, context.hooks, safeError(null, "CHAT_RESPONSE_INVALID").message);
          return { kind: "settled", streamId, afterSeq };
        }
        this._assertRunBinding(context.target, snapshotRun);
        if (TERMINAL_RUN_STATUSES.has(snapshotRun.status)) {
          await this._settleTerminal(context, state, snapshotRun);
          return { kind: "settled", streamId, afterSeq };
        }
        await this._consumeActiveSnapshot(context, state, snapshotRun, result.snapshot);
      } else {
        for (const item of result.events) {
          const terminal = await this._consumeEvent(context, state, item);
          if (terminal) return { kind: "settled", streamId, afterSeq };
        }
      }
      if (result.hasMore) continue;
      await this.delay(this.pollIntervalMs);
    }
    return {
      kind: context.poll.consumerCancelled ? "consumer-cancelled" : "observation-lost",
      error: safeError(null, "SERVICE_UNAVAILABLE"),
      streamId,
      afterSeq,
    };
  }

  async _reconcileAcceptedRun(context, initialError) {
    let failure = safeError(initialError);
    let attempt = 0;
    let waitedForRecovery = false;
    while (attempt < this.maxPollErrors) {
      if (context.poll.consumerCancelled) return null;
      if (this._state === "stopping" || (this._state === "stopped" && !this._retryOnStatus)) {
        throw failure;
      }
      const generation = this._generation;
      try {
        const result = await this._call("run.get", { runId: context.run.id });
        this._assertRunBinding(context.target, result.run);
        if (context.poll.consumerCancelled) return null;
        if (generation !== this._generation) {
          if (TERMINAL_RUN_STATUSES.has(result.run.status)) {
            context.run = result.run;
            if (result.run.status === "completed") context.state.historyRequired = true;
            await this._settleTerminal(context, context.state, result.run, { skipHistory: true });
            return null;
          }
          attempt += 1;
          if (attempt < this.maxPollErrors) {
            await this.delay(Math.min(1_000, 25 * (2 ** (attempt - 1))));
          }
          continue;
        }
        let target = context.target;
        try { target = this._sessionTarget(context.key); } catch { /* frozen binding remains valid */ }
        this._assertRunBinding(target, result.run);
        context.poll.cancelled = false;
        this._polls.add(context.poll);
        context.target = target;
        context.run = result.run;
        context.generation = generation;
        if (TERMINAL_RUN_STATUSES.has(result.run.status)) {
          if (result.run.status === "completed") context.state.historyRequired = true;
          await this._settleTerminal(context, context.state, result.run);
          return null;
        }
        this._expireSupersededPrompts(context, result.run.waitingRequestId);
        this._activeBySession.set(context.sessionKey, {
          runId: result.run.id,
          requestId: result.run.waitingRequestId,
          status: result.run.status,
          run: result.run,
        });
        return { target, run: result.run, generation };
      } catch (error) {
        failure = safeError(error);
        if (!RUN_OBSERVER_TRANSIENT_ERROR_CODES.has(failure.code)) throw failure;
        if (!waitedForRecovery && (this._state === "starting" || this._state === "recovering"
          || (this._state === "stopped" && this._retryOnStatus))) {
          waitedForRecovery = true;
          const recovery = await Promise.race([
            this.start().then((ready) => ({ ready })),
            context.poll.consumerCancellation.then(() => null),
          ]);
          if (recovery === null || context.poll.consumerCancelled) return null;
          if (!recovery.ready) throw safeError(null, "SERVICE_UNAVAILABLE");
          continue;
        }
      }
      attempt += 1;
      if (attempt < this.maxPollErrors) {
        await this.delay(Math.min(1_000, 25 * (2 ** (attempt - 1))));
      }
    }
    throw failure;
  }

  async _settleReturnedTerminal(context, state, result) {
    if (context.poll.consumerCancelled) return false;
    let terminal = null;
    if (result.gap !== null) {
      const snapshotRun = runFromSnapshot(result.snapshot, context.run.id);
      if (snapshotRun && TERMINAL_RUN_STATUSES.has(snapshotRun.status)) {
        this._assertRunBinding(context.target, snapshotRun);
        terminal = snapshotRun;
      }
    } else {
      const terminalIndex = result.events.findIndex((item) => item.type === "terminal");
      if (terminalIndex >= 0) {
        for (const item of result.events.slice(0, terminalIndex)) {
          const payload = item.payload || {};
          if (item.type === "text.delta" && safeString(payload.delta)) {
            state.text += payload.delta;
          } else if (item.type === "text" && safeString(payload.text)) {
            if (!state.text) state.text = payload.text;
            else if (payload.text.startsWith(state.text)) state.text = payload.text;
            else if (!state.text.endsWith(payload.text)) state.text += payload.text;
            if (payload.phase === "commentary") state.text = "";
          }
        }
        const payload = result.events[terminalIndex].payload || {};
        if (TERMINAL_RUN_STATUSES.has(payload.status)) {
          terminal = {
            ...context.run,
            status: payload.status,
            resultSummary: payload.resultSummary ?? null,
            errorCode: payload.errorCode ?? null,
          };
        }
      }
    }
    if (!terminal) return false;
    await this._settleTerminal(context, state, terminal, {
      skipHistory: true,
    });
    return true;
  }

  async _consumeEvent(context, state, event) {
    const payload = event.payload || {};
    if (event.type === "text.delta" && safeString(payload.delta)) {
      state.text += payload.delta;
      this._invokeHook(context.hooks, "delta", state.text);
    } else if (event.type === "text" && safeString(payload.text)) {
      const previous = state.text;
      if (!state.text) state.text = payload.text;
      else if (payload.text.startsWith(state.text)) state.text = payload.text;
      else if (!state.text.endsWith(payload.text)) state.text += payload.text;
      if (state.text !== previous) this._invokeHook(context.hooks, "delta", state.text);
      if (payload.phase === "commentary") {
        this._invokeHook(context.hooks, "interim", state.text);
        state.text = "";
      }
    } else if (event.type === "reasoning.delta" && safeString(payload.delta)) {
      state.reasoning += payload.delta;
      this._invokeHook(context.hooks, "thinking", state.reasoning);
    } else if (event.type === "reasoning") {
      const reasoning = Array.isArray(payload.reasoning)
        ? payload.reasoning.filter((value) => typeof value === "string").join("\n")
        : typeof payload.reasoning === "string" ? payload.reasoning : "";
      if (reasoning) {
        state.reasoning = reasoning;
        this._invokeHook(context.hooks, "thinking", reasoning);
      }
    } else if (event.type === "plan" && Array.isArray(payload.plan)) {
      const entries = payload.plan.map((entry) => ({
        content: String(entry?.step ?? entry?.content ?? ""),
        status: entry?.status === "inProgress" ? "in_progress"
          : typeof entry?.status === "string" ? entry.status : undefined,
      })).filter((entry) => entry.content);
      const delta = safeString(payload.delta) && payload.delta.length > 0
        ? payload.delta : safeString(payload.text) && payload.text.length > 0 ? payload.text : null;
      if (delta) entries.push({ content: delta, status: "in_progress" });
      this._invokeHook(context.hooks, "plan", entries);
    } else if (["tool.start", "tool.update", "tool.result"].includes(event.type)) {
      const tool = ownDataObject(payload.tool) ? payload.tool : {};
      const failureMeta = {
        ...(Number.isSafeInteger(tool.exitCode) && tool.exitCode !== 0
          ? { exitCode: tool.exitCode } : {}),
        ...(typeof tool.errorCode === "string" ? { errorCode: tool.errorCode } : {}),
      };
      const partialResult = boundedText(payload.delta, 2 * 1024)
        || boundedText(payload.message, 2 * 1024)
        || boundedText(payload.progress, 2 * 1024);
      const result = boundedText(tool.resultSummary, 2 * 1024)
        || (Object.keys(failureMeta).length > 0 ? failureMeta : undefined);
      this._invokeHook(context.hooks, "tool", {
        toolCallId: payload.toolCallId || payload.itemId,
        name: tool.name || tool.kind,
        args: ownDataObject(tool.displayArgs) ? tool.displayArgs : undefined,
        phase: event.type === "tool.start" ? "start" : event.type === "tool.result" ? "result" : "update",
        result: event.type === "tool.result" ? result : undefined,
        pluginAppCallId: event.type === "tool.result"
          ? require("./plugin-app-call-reference").pluginAppCallId(tool.pluginAppCallId) || undefined : undefined,
        partialResult: event.type === "tool.update" ? partialResult : undefined,
        isError: tool.status === "failed" || tool.isError === true,
        durationS: Number.isSafeInteger(tool.durationMs) && tool.durationMs > 0
          ? tool.durationMs / 1000 : undefined,
      });
    } else if (event.type === "status") {
      const status = payload.status || "status";
      if (safeString(payload.requestId, 128)) {
        this._expirePrompt(context, payload.requestId);
      }
      this._emitRunStatus(context.hooks, state, status, payload);
    } else if (event.type === "approval") {
      let request;
      try {
        request = normalizeInteractiveRequestV1({
          runId: context.run.id, eventType: "approval", payload,
          expiresAt: payload.expiresAt ?? null,
        });
      } catch {
        this._invokeHook(context.hooks, "error", "交互请求格式不兼容，请重新发起");
        return false;
      }
      this._rememberPrompt(context.sessionKey, context.run.id, payload, "approval", request);
      this._invokeHook(context.hooks, "prompt", request);
    } else if (event.type === "prompt") {
      let request;
      try {
        request = normalizeInteractiveRequestV1({
          runId: context.run.id, eventType: "prompt", payload,
          expiresAt: payload.expiresAt ?? null,
        });
      } catch {
        this._invokeHook(context.hooks, "error", "交互请求格式不兼容，请重新发起");
        return false;
      }
      this._rememberPrompt(context.sessionKey, context.run.id, payload, "input", request);
      this._invokeHook(context.hooks, "prompt", request);
    } else if (event.type === "terminal") {
      const terminal = {
        ...context.run,
        status: payload.status,
        resultSummary: payload.resultSummary ?? null,
        errorCode: payload.errorCode ?? null,
      };
      await this._settleTerminal(context, state, terminal);
      return true;
    }
    return false;
  }

  _emitRunStatus(hooks, state, status, payload = {}) {
    if (!["queued", "starting", "running", "retrying", "waiting_approval", "waiting_input", "compacting", "compacted"].includes(status)) return;
    const reason = status === "queued" ? boundedText(payload?.reason, 128) || null
      : status === "retrying" && payload?.reason === "RUNTIME_RATE_LIMITED" ? payload.reason : null;
    const queuedAt = status === "queued" && Number.isSafeInteger(payload?.queuedAt) && payload.queuedAt >= 0
      ? payload.queuedAt : null;
    if (state.lastStatus === status && state.lastQueueReason === reason && state.lastQueuedAt === queuedAt) return;
    state.lastStatus = status;
    state.lastQueueReason = reason;
    state.lastQueuedAt = queuedAt;
    this._invokeHook(hooks, "status", { kind: status, text: status,
      ...(reason ? { reason } : {}), ...(queuedAt !== null ? { queuedAt } : {}) });
  }

  async _consumeActiveSnapshot(context, state, snapshotRun, snapshot = null) {
    this._expireSupersededPrompts(context, snapshotRun.waitingRequestId);
    this._activeBySession.set(context.sessionKey, {
      runId: snapshotRun.id,
      requestId: snapshotRun.waitingRequestId,
      status: snapshotRun.status,
      run: snapshotRun,
    });
    this._emitRunStatus(context.hooks, state, snapshotRun.status, snapshot?.queue);
    if (!["waiting_approval", "waiting_input"].includes(snapshotRun.status)
      || !snapshotRun.waitingRequestId) return;
    const kind = snapshotRun.status === "waiting_approval" ? "approval" : "input";
    let record = this._promptByRequest.get(snapshotRun.waitingRequestId);
    if (!record || record.sessionKey !== context.sessionKey || record.runId !== snapshotRun.id
      || record.kind !== kind) {
      const eventType = kind === "approval" ? "approval" : "prompt";
      const request = interactionFromSnapshot(
        snapshot, snapshotRun.id, snapshotRun.waitingRequestId, eventType,
      );
      if (request) {
        record = this._rememberPrompt(
          context.sessionKey,
          snapshotRun.id,
          snapshot.interaction.payload,
          kind,
          request,
        );
      }
      if (!record) {
        const method = kind === "approval" ? "run.approval.respond" : "run.input.respond";
        const params = kind === "approval" ? {
          operationId: `approval-${this.randomUUID()}`,
          createdAt: this.now(),
          runId: snapshotRun.id,
          requestId: snapshotRun.waitingRequestId,
          choice: "cancel",
        } : {
          operationId: `input-${this.randomUUID()}`,
          createdAt: this.now(),
          runId: snapshotRun.id,
          requestId: snapshotRun.waitingRequestId,
          action: "cancel",
          answers: {},
        };
        try {
          const result = await this._call(method, params);
          this._assertRunBinding(context.target, result.run);
          this._activeBySession.set(context.sessionKey, {
            runId: result.run.id,
            requestId: result.run.waitingRequestId,
            status: result.run.status,
            run: result.run,
          });
        } catch {}
        this._invokeHook(context.hooks, "promptExpire", {
          requestId: snapshotRun.waitingRequestId,
        });
        this._invokeHook(context.hooks, "error", "请求格式已过期，请重新发起");
        return;
      }
    }
    this._invokeHook(context.hooks, "prompt", record.request);
  }

  _expirePrompt(context, requestId) {
    const record = this._promptByRequest.get(requestId);
    if (!record || record.sessionKey !== context.sessionKey || record.runId !== context.run.id) return;
    this._promptByRequest.delete(requestId);
    this._invokeHook(context.hooks, "promptExpire", { requestId });
  }

  _expireSupersededPrompts(context, waitingRequestId) {
    for (const record of this._promptByRequest.values()) {
      if (record.sessionKey === context.sessionKey && record.runId === context.run.id
        && record.requestId !== waitingRequestId) {
        this._expirePrompt(context, record.requestId);
      }
    }
  }

  _rememberPrompt(sessionKey, runId, payload, kind, request = null) {
    if (!safeString(payload.requestId, 128)) return;
    const existing = this._promptByRequest.get(payload.requestId);
    const sameInteraction = existing?.sessionKey === sessionKey
      && existing.runId === runId && existing.requestId === payload.requestId
      && existing.kind === kind;
    const record = {
      sessionKey,
      runId,
      requestId: payload.requestId,
      kind,
      request: request ? structuredClone(request) : null,
      ...(sameInteraction && existing.federation === true ? {
        federation: true,
        federationProfileId: existing.federationProfileId,
      } : {}),
    };
    this._promptByRequest.set(payload.requestId, record);
    const previous = this._activeBySession.get(sessionKey);
    this._activeBySession.set(sessionKey, {
      runId,
      requestId: payload.requestId,
      status: kind === "approval" ? "waiting_approval" : "waiting_input",
      run: previous?.runId === runId ? previous.run : undefined,
    });
    return record;
  }

  async _settleTerminal(context, state, terminal, options = {}) {
    if (state.settled) return;
    state.settled = true;
    const pendingRequestId = terminal.waitingRequestId
      || this._activeBySession.get(context.sessionKey)?.requestId
      || null;
    this._clearSessionRuntime(context.sessionKey, context.run.id);
    if (terminal.status === "completed") {
      let text = state.historyRequired === true ? "" : state.text;
      if (!text && options.skipHistory !== true) {
        try {
          const items = await this._getHistoryItems(context.key);
          const messages = reassembleHistory(items.filter((item) => item.runId === terminal.id));
          const assistant = [...messages].reverse().find((message) => message.role === "assistant");
          const historyText = assistant?.content?.filter((part) => part?.type === "text")
            .map((part) => part.text).filter((part) => typeof part === "string").join("\n") || "";
          if (!context.poll.cancelled && context.generation === this._generation) text = historyText;
        } catch {
          text = typeof terminal.resultSummary === "string" ? terminal.resultSummary : "";
        }
      }
      if (!text) text = typeof terminal.resultSummary === "string" ? terminal.resultSummary : "";
      if (context.poll.consumerCancelled) return;
      this._invokeHook(context.hooks, "final", text, false, { runId: terminal.id,
        ...(context.run.source === "inspiration" ? { notificationCategory: "inspiration" } : {}) });
      return;
    }
    const code = typeof terminal.errorCode === "string" && SAFE_CODE_PATTERN.test(terminal.errorCode)
      ? terminal.errorCode : terminal.status === "canceled" ? "RUN_CANCELED" : "RUN_FAILED";
    if (code === "CODEX_PROMPT_TIMEOUT") {
      if (pendingRequestId) {
        this._invokeHook(context.hooks, "promptExpire", { requestId: pendingRequestId });
      }
      this._invokeHook(
        context.hooks,
        "error",
        "等待补充信息已超时（5 分钟）。任务已中断，请重新发送并及时完成输入",
      );
      return;
    }
    if (code === "SERVICE_RESTARTED") {
      this._invokeHook(context.hooks, "error", "Agent Service 已重启，本次任务已中断，请重试");
      return;
    }
    if (RUNTIME_START_MESSAGES[code]) {
      this._invokeHook(context.hooks, "error", RUNTIME_START_MESSAGES[code]);
      return;
    }
    this._invokeHook(context.hooks, "error", `Shoggoth 任务未完成 (${code})`);
  }

  _settleError(state, hooks, message) {
    if (state.settled) return;
    state.settled = true;
    this._invokeHook(hooks, "error", message);
  }

  async respondChatPrompt(key, data = {}) {
    // A stream can recover before the profile/session snapshot finishes loading.
    // Preserve the delivered approval while waiting for that same recovery.
    if (this._state === "recovering" && this._startPromise) await this._startPromise;
    const target = this._sessionTarget(key);
    const { sessionKey } = target;
    const record = this._promptByRequest.get(String(data.requestId || ""));
    if (!record || record.sessionKey !== sessionKey || !record.request) {
      throw safeError(null, "RUN_REQUEST_NOT_FOUND");
    }
    let response;
    try {
      response = record.request.fields.length === 0
        ? validateInteractiveResponseV1(record.request, { choice: data.choice })
        : validateInteractiveResponseV1(record.request, {
          action: data.action,
          answers: data.answers,
        });
    } catch {
      throw safeError(null, record.kind === "approval"
        ? "RUN_APPROVAL_DECISION_INVALID" : "RUN_INPUT_RESPONSE_INVALID");
    }
    let result;
    if (record.request.kind === "runtime_approval") {
      result = await this._call("run.approval.respond", {
        operationId: `approval-${this.randomUUID()}`,
        createdAt: this.now(),
        runId: record.runId,
        requestId: record.requestId,
        choice: response.choice,
      });
    } else if (record.request.kind === "mcp_permission") {
      if (record.kind !== "input" || !MCP_TOOL_APPROVAL_CHOICES.has(response.choice)) {
        throw safeError(null, "RUN_INPUT_RESPONSE_INVALID");
      }
      result = await this._call("run.input.respond", {
        operationId: `input-${this.randomUUID()}`,
        createdAt: this.now(),
        runId: record.runId,
        requestId: record.requestId,
        action: response.choice === "deny" ? "cancel" : "submit",
        answers: {},
      });
    } else {
      if (record.kind !== "input") throw safeError(null, "RUN_INPUT_RESPONSE_INVALID");
      result = await this._call("run.input.respond", {
        operationId: `input-${this.randomUUID()}`,
        createdAt: this.now(),
        runId: record.runId,
        requestId: record.requestId,
        action: response.action,
        answers: response.answers,
      });
    }
    this._assertRunBinding(target, result.run);
    if (result.run.id !== record.runId) throw safeError(null, "WORK_RUN_CONTROL_MISMATCH");
    this._promptByRequest.delete(record.requestId);
    this._activeBySession.set(sessionKey, {
      runId: result.run.id,
      requestId: result.run.waitingRequestId,
      status: result.run.status,
      run: result.run,
    });
    return result;
  }

  async _findActiveRun(target, { refresh = false } = {}) {
    const { sessionKey } = target;
    const cached = this._activeBySession.get(sessionKey);
    if (!refresh && cached?.run && ACTIVE_RUN_STATUSES.has(cached.status)) {
      return this._assertRunBinding(target, cached.run);
    }
    const runs = await this._page("run.list", {
      profileId: target.profile.id,
      sessionKey,
      status: null,
    }, "runs");
    const active = runs.filter((value) => ACTIVE_RUN_STATUSES.has(value.status));
    if (active.length > 1) throw safeError(null, "CHAT_SESSION_BUSY");
    if (active.length === 0) {
      if (cached) this._clearSessionRuntime(sessionKey, cached.runId);
      return null;
    }
    const run = this._assertRunBinding(target, active[0]);
    this._activeBySession.set(sessionKey, {
      runId: run.id,
      requestId: run.waitingRequestId,
      status: run.status,
      run,
    });
    return run;
  }

  async abortChat(key) {
    const target = this._sessionTarget(key);
    const { sessionKey } = target;
    let active = null;
    try {
      active = await this._findActiveRun(target);
      if (!active) return;
      const result = await this._call("chat.abort", {
        operationId: `abort-${this.randomUUID()}`,
        sessionKey,
        runId: active.id,
        createdAt: this.now(),
      });
      if (result.run) {
        this._assertRunBinding(target, result.run);
        if (result.run.id !== active.id) throw safeError(null, "WORK_RUN_CONTROL_MISMATCH");
      }
    } finally {
      this._clearSessionRuntime(sessionKey, active?.id || null);
    }
  }

  async steerChat(key, message) {
    const target = this._sessionTarget(key);
    const { sessionKey } = target;
    const active = await this._findActiveRun(target);
    if (!active) throw safeError(null, "WORK_RUN_NOT_FOUND");
    const result = await this._call("chat.steer", {
      operationId: `steer-${this.randomUUID()}`,
      sessionKey,
      runId: active.id,
      message: String(message),
      createdAt: this.now(),
    });
    if (result.runId !== active.id) throw safeError(null, "WORK_RUN_CONTROL_MISMATCH");
    return result;
  }

  async watchSession(key, hooks = {}, opts = {}) {
    if (opts.signal?.aborted) return;
    const generation = this._generation;
    const target = this._sessionTarget(key);
    const active = await this._findActiveRun(target, { refresh: true });
    if (!active || opts.signal?.aborted || generation !== this._generation) return;
    const poll = { cancelled: false, consumerCancelled: false };
    this._polls.add(poll);
    let removeAbort = null;
    if (opts.signal && typeof opts.signal.addEventListener === "function") {
      const cancel = () => {
        poll.cancelled = true;
        poll.consumerCancelled = true;
      };
      if (opts.signal.aborted) cancel();
      else {
        opts.signal.addEventListener("abort", cancel, { once: true });
        removeAbort = () => opts.signal.removeEventListener("abort", cancel);
      }
    }
    try {
      if (poll.cancelled) return;
      this._invokeHook(hooks, "status", { kind: active.status, text: active.status });
      if (poll.cancelled) return;
      await this._pollRun({
        key,
        sessionKey: target.sessionKey,
        target,
        run: active,
        hooks,
        poll,
        generation,
        initialStatus: active.status,
        snapshotFirst: ["waiting_approval", "waiting_input"].includes(active.status),
      });
    } finally {
      removeAbort?.();
      this._polls.delete(poll);
    }
  }
}

module.exports = { ShoggothBackend };
