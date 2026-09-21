// Mirrors the UnifiedCronJob shape produced by the Node backends
// (see app/core/hermes-backend.js normalizeHermesCronJob).

// Desktop-only empty signal: no event payload, identity or basic toggle API.
export interface DesktopProductTelemetryBridge {
  recordActivity: () => void;
}

// The backends pass OpenClaw's CronSchedule through as a superset, so a few
// optional fields (tz/staggerMs/anchorMs) ride along beyond the base union.
export type CronSchedule =
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "at"; at: string | null }
  | { kind: "on-exit"; command: string; cwd?: string }
  | {
      kind: "stream";
      command: string[];
      cwd?: string;
      mode?: "line" | "match";
      match?: string;
      batchMs?: number;
      maxBatchBytes?: number;
    };

// Backend ids are registry-owned. Keep well-known ids out of this type so a
// newly installed backend does not require a manage-ui release just to appear.
export type CronBackendId = string;

export type OpenClawCronSessionTarget = "main" | "isolated" | "current" | `session:${string}`;
export type OpenClawCronWakeMode = "next-heartbeat" | "now";

export type OpenClawCronPayload =
  | { kind: "systemEvent"; text: string }
  | {
      kind: "agentTurn";
      message: string;
      model?: string;
      fallbacks?: string[];
      thinking?: string;
      timeoutSeconds?: number;
      allowUnsafeExternalContent?: boolean;
      externalContentSource?: string;
      lightContext?: boolean;
      toolsAllow?: string[];
    };

export interface OpenClawCronDelivery {
  mode: "none" | "announce" | "webhook";
  channel?: string;
  to?: string;
  threadId?: string;
  accountId?: string;
  bestEffort?: boolean;
  completionDestination?: Record<string, unknown>;
  failureDestination?: Record<string, unknown>;
}

export interface OpenClawCronFailureAlert {
  after?: number;
  channel?: string;
  to?: string;
  cooldownMs?: number;
  includeSkipped?: boolean;
  mode?: "announce" | "webhook";
  accountId?: string;
}

export interface HermesCronRepeat {
  times?: number | null;
  completed?: number;
}

export interface CronBackendDetails {
  capabilityTags?: string[];
  deliveryStatus?: string;
  profile?: string;
  hermesHome?: string;
  raw?: Record<string, unknown>;
}

export interface UnifiedCronJob {
  id: string; // "<agentId|backendId>:<localId>"
  backendId: CronBackendId;
  agentId?: string;
  name: string;
  description?: string;
  prompt?: string;
  schedule: CronSchedule;
  scheduleDisplay?: string;
  enabled: boolean;
  state?: string;
  stateLabel?: string;
  actions?: { edit?: boolean; toggle?: boolean; delete?: boolean; run?: boolean; reason?: "system-managed" };
  createdAt?: number | null; // epoch ms; calendar hides occurrences before this
  lastRunAt?: number | null;
  lastStatus?: string;
  lastError?: string;
  nextRunAt?: number | null;
  model?: string;
  provider?: string;
  baseUrl?: string;
  deliver?: string;
  deleteAfterRun?: boolean;
  sessionTarget?: OpenClawCronSessionTarget;
  wakeMode?: OpenClawCronWakeMode;
  payload?: OpenClawCronPayload | { kind: "heartbeat" | "skillCollectionReview" };
  delivery?: OpenClawCronDelivery;
  failureAlert?: OpenClawCronFailureAlert | null;
  script?: string;
  noAgent?: boolean;
  repeat?: HermesCronRepeat;
  skills?: string[];
  contextFrom?: string[];
  enabledToolsets?: string[];
  workdir?: string;
  profile?: string;
  backendDetails?: CronBackendDetails;
  rawCapabilities?: string[];
}

export type CronRunStatus = "ok" | "error" | "skipped";
export type CronCompletionStatus = "succeeded" | "failed" | "unknown";
export type CronDeliveryStatus = "delivered" | "not-delivered" | "unknown" | "not-requested";
export type CronErrorReason =
  | "auth" | "auth_permanent" | "format" | "rate_limit" | "overloaded" | "billing"
  | "server_error" | "timeout" | "tls_certificate" | "context_overflow" | "model_not_found"
  | "session_expired" | "empty_response" | "no_error_details" | "unclassified" | "unknown";

export interface CronFailureNotificationDelivery {
  delivered?: boolean;
  status: CronDeliveryStatus;
  error?: string;
}

// One historical run of a cron job (see backend getCronRuns()).
export interface CronRun {
  startedAt?: number | null;
  finishedAt?: number | null;
  status?: CronRunStatus | string;
  completionStatus?: CronCompletionStatus;
  error?: string;
  errorReason?: CronErrorReason;
  summary?: string;
  durationMs?: number;
  sessionKey?: string;
  runId?: string;
  nextRunAt?: number | null;
  deliveryStatus?: CronDeliveryStatus | string;
  deliveryError?: string;
  deliverySuppressionReason?: string;
  failureNotificationDelivery?: CronFailureNotificationDelivery;
  diagnostics?: unknown;
  model?: string;
  provider?: string;
}

// Latest delivered content for a cron job (see backend getCronLatestDelivery()).
// `source` says where `fullText` came from: "transcript" = full untruncated
// run/session output, "summary" = the ≤2000-char run summary,
// "none" = no output recoverable (e.g. a never-run / errored job or an old backend).
// R342:cron 单次运行的 Agent Trajectory（过程 parts，来自 run/session 转录）。
// 后端不支持或转录不可用时 supported=false，UI 隐藏该区。
export interface CronTrajectoryPart {
  type: "thinking" | "toolCall" | "toolResult" | "text";
  text?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolCallId?: string;
  isError?: boolean;
  ts?: number;
}
export interface CronRunTrajectory {
  supported: boolean;
  reason?: string;
  parts: CronTrajectoryPart[];
}

export interface CronDelivery {
  runId?: string;
  status?: string;
  startedAt?: number | null;
  finishedAt?: number | null;
  model?: string;
  provider?: string;
  durationMs?: number;
  summary?: string;
  fullText?: string | null;
  source?: "transcript" | "summary" | "none";
  sessionKey?: string;
  error?: string;
  deliveryStatus?: string;
}

interface CronJobInputBase {
  backendId: CronBackendId;
  agentId?: string;
  name?: string;
  description?: string;
  prompt?: string;
  model?: string;
  provider?: string;
  baseUrl?: string;
  enabled?: boolean;
  deliver?: string;
  schedule: CronSchedule;
}

// OpenClaw 的创建/编辑输入保留完整 gateway cron 控制面。
export interface OpenClawCronJobInput extends CronJobInputBase {
  backendId: "openclaw";
  deleteAfterRun?: boolean;
  sessionTarget?: OpenClawCronSessionTarget;
  wakeMode?: OpenClawCronWakeMode;
  payload?: OpenClawCronPayload;
  delivery?: OpenClawCronDelivery;
  failureAlert?: OpenClawCronFailureAlert | null;
}

// Hermes 的创建/编辑输入保留自动化任务特有能力。
export interface HermesCronJobInput extends CronJobInputBase {
  backendId: "hermes";
  repeat?: number | HermesCronRepeat | null;
  skills?: string[];
  script?: string;
  noAgent?: boolean;
  contextFrom?: string[];
  enabledToolsets?: string[];
  workdir?: string;
  profile?: string;
}

export interface NativeCronJobInput extends CronJobInputBase {
  backendId: string;
  workspace?: string | null;
  misfirePolicy?: "skip" | "latest" | "all-bounded";
  maxCatchUp?: number;
  overlapPolicy?: "skip" | "queue";
  threadPolicy?: "new" | "continue";
  threadId?: string | null;
}

/** @deprecated Use NativeCronJobInput; retained for source compatibility. */
export type ShoggothCronJobInput = NativeCronJobInput;

export type CronJobInput = OpenClawCronJobInput | HermesCronJobInput | NativeCronJobInput;

// One model from a backend's catalog (see backend getModels()).
export interface UnifiedModel {
  id: string;
  name: string;
  provider: string;
  backendId: string; // "openclaw" | "hermes"
  contextWindow?: number;
  reasoning?: boolean;
  thinkingOptions?: string[];
  thinkingDefault?: string | null;
  // Fast-mode capability (service-tier request param; Hermes /api/model/options
  // capabilities.fast). Gates the chat page's ⚡ toggle; undefined = unknown.
  fast?: boolean;
  // Per-model pricing as pre-formatted $/Mtok strings ("$3.00" | "free" | "").
  // Hermes-only (from /api/model/options); OpenClaw provides none.
  pricing?: { input?: string; output?: string; cache?: string | null; free?: boolean };
  // Hermes-only: provider ref the chat `/model` command must use when it differs
  // from `provider` — user-defined (config.yaml) providers need `custom:<name>`
  // (Hermes only parses built-in provider names before the colon).
  acpProviderRef?: string;
  // Shared-backend profile ids that independently advertised this model.
  // The chat surface intersects this with ChatCapabilities.modelScope.
  modelScopes?: string[];
  // Profiles for which this is the runtime-advertised inherited default.
  // Kept separate from modelScopes because defaults can differ per Agent.
  defaultModelScopes?: string[];
}

// 聊天面能力（GET /__api/chat/capabilities?agent=）：composer 按此渲染附件
// accept 列表与大小预检。image 是兼容底线；pdf/file 由真实可传输的后端声明。
export interface ChatCapabilities {
  attachments: {
    image?: { maxBytes?: number };
    pdf?: { maxBytes?: number; maxPages?: number };
    file?: { maxBytes?: number };
  };
  // Negotiated limit for the complete gateway request JSON frame, including
  // UTF-8 text, base64 expansion, attachment metadata, and the RPC envelope.
  maxPayloadBytes?: number;
  // Native uploads use separate chunks; this is the JSON-encoded text budget.
  maxPromptBytes?: number;
  maxAttachmentBytes?: number;
  maxAttachments?: number;
  // This transport consumes the sanitized gateway.ready policy. It is a
  // capability marker, not a concrete backend identity check.
  gatewayPolicy?: boolean;
  // 未被本地处理的 / 命令交给 execSlash 服务端执行（而不是当聊天消息发出）。
  slash?: boolean;
  // Runtime 能把新文本追加到当前正在执行的 turn，而不是等结束后新开一轮。
  steer?: boolean;
  // 共享 backend 下按 Agent 固定的 provider/runtime 目录边界。声明后模型菜单只展示
  // 该 provider 的条目，避免相同 model id 或其它 CLI 的模型跨 Agent 误选。
  modelProvider?: string;
  // Isolated Agent Profile boundary inside a shared backend/provider catalog.
  modelScope?: string;
  permissions?: {
    scope: "session" | "profile";
    apply: "next-turn" | "live";
    defaultMode?: string;
    options: ChatPermissionModeOption[];
  };
  // 后端未就绪的降级信号（Hermes dashboard 冷启动竞态）：这份能力是**临时**的
  // image-only，UI 不得当终态缓存，须重取，否则命令/附件会永久停在退化态。
  notReady?: boolean;
}

export interface ChatPermissionModeOption {
  id: string;
  label: string;
  description?: string;
  risk?: "safe" | "standard" | "elevated" | "danger";
  requiresConfirmation?: boolean;
}

/** Safe browser projection of an OpenClaw 2026.8.1 assistant-message Canvas. */
export interface ChatCanvasWidgetPreview {
  kind: "canvas";
  surface: "assistant_message";
  render: "url";
  viewId: string;
  url: string;
  title?: string;
  preferredHeight?: number;
  boardWidgetName?: string;
}

/** Structured content block stored in chat history and emitted by live/final turns. */
export interface ChatCanvasWidgetPart {
  type: "canvas";
  preview: ChatCanvasWidgetPreview;
  rawText?: string;
}

/** 主进程生成的聊天历史缓存隔离摘要；不包含数据目录、URL 或凭据。 */
export interface ChatCacheScope {
  backendId: string;
  cacheScope: string;
}

// 服务端斜杠命令目录（GET /__api/chat/slash?agent=）。
export interface SlashCatalogResponse {
  supported: boolean;
  reason?: string | null;
  commands: Array<{
    name: string;
    description: string;
    args?: string | null;
    category?: string;
    aliases?: string[];
    source?: string;
    execution?: "runtime" | "client" | "cli";
  }>;
}

// 服务端斜杠执行结果（POST /__api/chat/slash/exec）。
export interface SlashExecResult {
  kind: "output" | "send" | "prefill";
  text?: string | null;
  warning?: string | null;
}

// 一次经过后端 fresh 校验的目录快照；revision 是内容寻址真值。
export interface ModelCatalogSnapshot {
  backendId: string;
  catalogRevision: string;
  models: UnifiedModel[];
  verifiedAt: number;
  legacyPlaceholder?: boolean;
}

// `/__api/models` 的传输结构；unchanged 响应会有意省略 models。
export interface ModelCatalogWireResponse {
  models?: UnifiedModel[];
  catalogRevision: string;
  unchanged?: boolean;
}

// 后端在首次写入前公开的模型变更能力，用于前端 fail-closed 门控。
export interface ModelChangeCapabilities {
  supported: boolean;
  create: boolean;
  update: boolean;
  rename: boolean;
  delete: boolean;
  updateProvider: boolean;
  renameProvider?: boolean;
  deleteCatalogModel?: boolean;
  renameCatalogModel?: boolean;
  batch?: boolean;
  auxiliary?: boolean;
  /** 该后端的模型配置按 agent 各存一份 → 主模型等设置归「代理」页，模型页只留凭证层。
      静态事实，不随运行时探测翻转（见 agent-backend.js 的契约注释）。 */
  perAgentModelSettings?: boolean;
  /** 该后端有「提供方」页签数据面（provider 目录 + OAuth 卡）。静态事实，同上不随
      运行时探测翻转（OpenClaw 恒真）。 */
  providerDirectory?: boolean;
  /** 授权 profile 的读取、替换 Key 和删除是否由此后端支持。静态能力，缺省禁用。 */
  manageAuthProfiles?: boolean;
  fields?: Record<string, boolean>;
  blockers?: string[];
  configWrite?: ModelConfigWriteCapabilities;
}

// config-only 降级写能力：完整立即应用不可用时仍可保存配置，生效由 activation 完成。
export interface ModelConfigWriteCapabilities {
  supported: boolean;
  create: boolean;
  update: boolean;
  delete: boolean;
  updateProvider: boolean;
  // provider 改名(update-provider patch.renameTo);后端能同步迁移引用与凭证才声明
  renameProvider?: boolean;
  // 目录模型删除(config 不管定义,allowlist 移除);后端支持才声明
  deleteCatalogModel?: boolean;
  // 目录模型 id 改名(allowlist 搬键+引用改写);后端支持才声明
  renameCatalogModel?: boolean;
  // 批量合并写(草稿层一次提交);后端支持才声明
  batch?: boolean;
  activation: { kind: string; available?: boolean } | null;
  // 数组 = 全 kind 通用；map = "*" 通用 + 按 kind（create/update/update-provider…）追加。
  bypassBlockerCodes?: string[] | Record<string, string[]>;
  blockers?: string[];
}

// 非终态模型变更的安全公开投影，用于 App 重启后恢复同一幂等操作。
export interface PendingModelChange {
  operationId: string;
  backendId: string;
  providerKey: string;
  kind: string;
  status: ModelChangeApplyResult["status"];
  stage: string;
  source: { provider?: string; modelId?: string } | null;
  target: { provider?: string; modelId?: string } | null;
}

// 新增与编辑共用的完整变更输入；凭证只存在于当前请求内。
export interface ModelChangeSpec {
  providerKey: string;
  providerMode: "existing" | "new";
  sourceModelId?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  model: {
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
  };
}

// 保存前的影响预览，包含引用迁移范围与运行态应用方式。
export interface ModelChangePreview {
  previewToken: string;
  capabilities: ModelChangeCapabilities;
  references: Array<{
    store: string;
    profile?: string | null;
    referenceKey: string;
    writable?: boolean;
  }>;
  blockers: Array<{
    code: string;
    store?: string;
    message: string;
    referenceKey?: string;
  }>;
  runtimeApply?: string;
  fingerprints: Record<string, string>;
}

// 模型变更的终态结果；成功时 catalog 可直接发布到共享目录。
export interface ModelChangeApplyResult {
  operationId: string;
  status:
    | "applied"
    | "partial"
    | "failed"
    | "blocked"
    | "needs_secret"
    | "cleanup_pending"
    | "compensated";
  stage: string;
  code?: string;
  /** Server-verified availability of the reference-removal confirmation path. */
  canForce?: boolean;
  catalog?: ModelCatalogSnapshot;
  // config-only 保存成功时的生效方式（如 gateway_restart）；完整应用无此字段。
  activation?: { kind: string; available?: boolean } | null;
  // 兼容旧 mutation 路由的部分写提示；新协调器使用 status/details。
  warnings?: string[];
  details?: Array<{
    stage: string;
    reference?: string;
    status: string;
    message?: string;
    retryable?: boolean;
  }>;
}

// 授权登录 provider 的凭证 profile 脱敏投影；完整 key/token 永不下发。
export interface ModelAuthProfile {
  id: string;
  provider: string;
  type: string;
  label?: string;
  displayName?: string;
  keyTail?: string;
  email?: string;
  expires?: number;
  // 授权存放层:store=主 auth-profiles.json;agents=仅各 agent sqlite 凭证库
  // (gateway 登录直写,主文件看不到);both=两层都有;canonical=9.1 权威 state store
  source?: "store" | "agents" | "both" | "canonical";
  agentCount?: number;
}

export interface ModelAuthProfilesResponse {
  supported: boolean;
  reason?: string;
  profiles: ModelAuthProfile[];
}

// Auxiliary per-task model assignments (Hermes-only). provider "auto" = use main.
export interface AuxiliaryModels {
  slots: { task: string; provider: string; model: string }[];
  main: { provider?: string; model?: string };
}

// ---- Hermes 模型设置整合面（官方「模型」+「提供方」全量移植，R286）----

// 设置目录里的一个 provider 行（含未配置的：authenticated:false + authType/keyEnv
// 供行内激活/OAuth 引导；官方 /api/model/options?include_unconfigured=1 同款）。
export interface ModelSettingsProvider {
  name: string;
  slug: string;
  models: string[];
  totalModels?: number;
  authenticated?: boolean;
  // "api_key" = 粘贴 keyEnv 行内激活；oauth_* / external 等 = 登录引导
  authType?: string;
  keyEnv?: string;
  isUserDefined?: boolean;
  isCurrent?: boolean;
  warning?: string;
  // Nous 专属：免费档标记 + 免费档不可选的付费模型
  freeTier?: boolean;
  unavailableModels?: string[];
  // 按模型 id 的能力表（fast/reasoning 门控默认参数控件）
  capabilities?: Record<string, { fast?: boolean; reasoning?: boolean }>;
  pricing?: Record<string, { input?: string; output?: string; cache?: string | null; free?: boolean }>;
}

// MoA 模型槽（reference / aggregator 共用）。
export interface MoaSlot {
  provider: string;
  model: string;
  reasoningEffort?: string;
  enabled?: boolean;
}

export interface MoaPreset {
  aggregator: MoaSlot;
  referenceModels: MoaSlot[];
  enabled: boolean;
  aggregatorTemperature?: number;
  referenceTemperature?: number;
  maxTokens?: number;
  referenceMaxTokens?: number | null;
  referenceTimeout?: number | null;
  degradedReferencePolicy?: "loud" | "silent";
  fanout?: string;
  // 未列出的服务端字段原样透传（round-trip 不丢）
  [extra: string]: unknown;
}

export interface MoaConfig {
  defaultPreset: string;
  activePreset: string;
  presets: Record<string, MoaPreset>;
  [extra: string]: unknown;
}

// 切主模型后仍钉在其它 provider 上的辅助槽（官方 stale_aux）。
export interface StaleAuxSlot {
  task: string;
  provider: string;
  model: string;
}

// GET /__api/models/settings 聚合快照。supported:false = 该后端无此设置面（隐藏区块）。
export interface HermesModelSettings {
  supported: boolean;
  profile?: string;
  profiles?: string[];
  main?: { provider: string; model: string };
  providers?: ModelSettingsProvider[];
  auxiliary?: AuxiliaryModels;
  // 原始配置值：reasoningEffort ""=medium、false/disabled=关；serviceTier fast/priority/on=快速档
  defaults?: { reasoningEffort: string; serviceTier: string };
  fallbacks?: { provider: string; model: string }[];
  moa?: MoaConfig | null;
}

// 自定义端点（OpenAI 兼容自建端点；官方 custom-endpoints 同款字段）。
export interface CustomEndpoint {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  models: string[];
  /** 主模型绑定的只读用途信息，不含凭据或原始配置。 */
  primaryModelUsage?: Array<{ modelId: string; isDefault: boolean; agentIds: string[] }>;
  api?: string | null;
  hasApiKey: boolean;
  apiKeyPreview?: string | null;
  canRevealApiKey?: boolean;
  canClearApiKey?: boolean;
  contextLength?: number | null;
  discoverModels: boolean;
  isCurrent?: boolean;
  /** 该端点存在于哪些 profile（聚合读才有；少于全部 = 历史漂移）。 */
  profiles?: string[];
  /** 在哪些 profile 里是当前主模型（激活是 per-profile 的，不广播）。 */
  activeIn?: string[];
  // "direct-config" = config.yaml 直管条目（只读，不可删）
  source?: string;
}

export interface CustomEndpointsSnapshot {
  supported: boolean;
  id?: string;
  current?: { provider: string; model: string; baseUrl: string };
  /** 聚合读覆盖到的 profile 全集（用于判断某条端点是否缺 profile）。 */
  profiles?: string[];
  endpoints: CustomEndpoint[];
  /** 广播写时部分 profile 失败的说明（全失败会直接抛错）。 */
  warnings?: string[];
  form?: {
    apiOptions?: string[];
    defaultApi?: string;
    nameEditable?: boolean;
    /** The endpoint name is the provider ID, with no separate display name. */
    nameIsProviderId?: boolean;
    /** Existing provider IDs can be renamed with their references. */
    providerIdEditable?: boolean;
    firstModelIsDefault?: boolean;
    /** Model selection can be saved atomically with reference confirmation. */
    batchModelSelection?: boolean;
    /** Confirmed deselection may retain existing Agent primary bindings. */
    allowPrimaryModelRemoval?: boolean;
  };
}

export interface CustomEndpointInput {
  id?: string;
  name: string;
  baseUrl: string;
  model: string;
  api?: string;
  // 多选保存（R314 弹窗）：选中的模型 id 集合=该端点在聊天列表的唯一真相；
  // 后端据此走整条目条件写并强制 discover_models:false。缺省=老的单模型语义。
  models?: string[];
  // 编辑已有端点时留空 = 保持原 key
  apiKey?: string;
  /** 验 Key 的专用探针 path（OpenClaw 检测按钮用；缺省探 /models）。 */
  probePath?: string;
  contextLength?: number;
  discoverModels?: boolean;
  makeDefault?: boolean;
}

export interface CustomEndpointValidation {
  ok: boolean;
  reachable: boolean;
  message: string;
  models: string[];
  /** Optional stable discovery error code; remote error bodies are not required. */
  code?: string;
}

// Editable custom model-config subset (user-defined providers; management UI).
export interface CustomModelEntry {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  // 该模型在 getModels() 目录行里的裸 id（目录行 provider = 配置键；
  // 页面用 `${provider}:${catalogId}` 复合键匹配卡片）
  catalogId: string;
}
export interface CustomModelProvider {
  key: string;
  name?: string;
  baseUrl: string;
  api?: string;
  hasApiKey: boolean;
  // "config" = 端点+模型都在配置文件里（可增删模型）；
  // "env" = 内置目录 provider，凭证在环境变量里（只能改 Key/端点，models 恒空）；
  // "auth" = 内置目录 provider，凭证在 auth-profiles（只能换 Key / 删除授权，
  //          端点由网关内置，models 恒空）
  source: "config" | "env" | "auth";
  // false = 纯凭证池 provider（OAuth/CLI 登录，如 openai-codex）：没有可写的
  // Key/端点变量，编辑表单不渲染；「删除」只清凭证池（撤销授权）。
  editable: boolean;
  // env 类：目录里已有模型 ⇒ 已能用（可能靠 OAuth/CLI/中转认证，未必靠 env Key）
  authenticated?: boolean;
  keyEnv?: string;
  baseUrlEnv?: string;
  hasBaseUrl?: boolean;
  // 凭证池条目数（Hermes credential_pool）。>0 而 hasApiKey=false ⇒ 凭证来自
  // gh CLI / OAuth / 手工添加，而非环境变量。
  poolCount?: number;
  profiles?: string[];
  models: CustomModelEntry[];
}

// 一条凭证池记录（轮换 key，脱敏）。
export interface ProviderCredential {
  index: number; // 1-based，删除时用
  id?: string;
  label?: string;
  authType?: string;
  source?: string; // "env:XXX_API_KEY" | "gh_cli" | "manual" | "claude_code" | …
  lastStatus?: string; // "ok" | "exhausted" | …
  requestCount?: number;
  hasRefresh?: boolean;
  tokenPreview?: string;
}
export interface ModelConfig {
  providers: CustomModelProvider[];
}
export interface AddModelSpec {
  providerKey: string;
  // 建**新** provider 必须显式声明 "new"：校验层默认按 "existing" 走，缺这行 preflight
  // 直接 blocked（provider_not_found）——R370 前的「添加自定义 Provider」就是漏了它，
  // 一路 409 建不出东西。给既有 provider 加模型时留空即可。
  providerMode?: "existing" | "new";
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  model: { id: string; name?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean };
}

// Configurable env var / API key (Hermes-only; values redacted in listings).
export interface EnvVar {
  key: string;
  isSet: boolean;
  redactedValue: string | null;
  description: string;
  url: string | null;
  category: string;
  isPassword: boolean;
  advanced: boolean;
  // 用到该 key 的工具名
  tools?: string[];
  // 渠道页拥有的平台凭证（密钥面板隐藏它们，避免与渠道配置重复）
  channelManaged?: boolean;
  // 用户自己加进 .env、不在任何目录里的键
  custom?: boolean;
  // provider 归属（模型页据此把 Key/端点归到对应 provider 组）
  provider?: string;
  providerLabel?: string;
}

// 可交互登录的 provider（OAuth 或外部 CLI）。原生 Runtime 登录态按
// RuntimeAccount 共享；connectedProfiles 列出引用该账号的逻辑 Agent。
export interface OAuthProvider {
  id: string;
  name: string;
  // pkce = 浏览器授权后粘贴 code；device_code = 展示码 + 轮询；external = 交给外部 CLI
  flow: "pkce" | "device_code" | "external";
  cliCommand: string;
  /** 缺省 true。false = 当前主机不可运行（远程网关或 CLI 未安装）。 */
  cliRunnable?: boolean;
  docsUrl: string;
  disconnectHint: string | null;
  disconnectCommand: string | null;
  disconnectable: boolean;
  status: {
    loggedIn: boolean;
    source: string | null;
    sourceLabel: string | null;
    tokenPreview: string | null;
    expiresAt: string | null;
    hasRefreshToken: boolean;
    error: string | null;
    // 外部 CLI 已写入安全凭证，但 Runtime 尚未完成一次无副作用的在线证明。
    // 此时不能显示为 Connected，也不应误报登录失败。
    verification?: "unverified";
  };
  connectedProfiles: string[];
}
export interface OAuthProvidersSnapshot {
  providers: OAuthProvider[];
  profiles: string[];
}
// OpenClaw「提供方」页签的 provider 目录卡（快照∪config∪auth 三源合并，见
// openclaw-backend.getProviderDirectory）。
export interface ProviderDirectoryEntry {
  id: string;
  label: string;
  logoKey: string;
  getKeyUrl: string | null;
  /** config.models.providers 里有该条目（保存走 update-provider）；否则 key 走
      auth-profile 直写、覆盖端点走 create。 */
  inConfig: boolean;
  api: string | null;
  baseUrl: { value: string | null; defaultValue: string | null; editable: boolean };
  key: {
    configured: boolean;
    /** 删除 config Key 需要 coordinator/config-only updateProvider；纯 auth-profile Key 可直删。 */
    clearable: boolean;
    source: "config" | "auth-profile" | null;
    /** 本机网关的密钥摘要（sk-o...c2f8）；远程 null → UI 显示「已设置」。 */
    redacted: string | null;
  };
  /** 检测按钮的专用探针 path（openrouter 的 /key 这类；null = 探 /models）。 */
  keyProbePath: string | null;
  configured: boolean;
  /** true = 不在 OpenClaw 插件目录（预设快照）里 → 归「自定义端点」卡；false = 预设家归目录卡。 */
  custom: boolean;
  modelsCount: number;
  /** 快照默认首模型 id；未配置 provider 首次覆盖端点走 create 时用（无则 UI 回落 "default"）。 */
  defaultModelId: string | null;
  oauth: Array<{ choiceId: string; method: string; label: string }>;
}
export interface ProviderDirectory {
  supported: boolean;
  providers?: ProviderDirectoryEntry[];
}
export interface OAuthStartSession {
  sessionId: string;
  flow: string;
  expiresIn: number;
  authUrl: string | null;
  verificationUrl: string | null;
  userCode: string | null;
  profile: string;
}

// token 用量仪表盘 (see backend getUsageSeries/getUsageBreakdown()).
export interface UsageTokenParts {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}
export interface UsageDailyPoint extends UsageTokenParts {
  missingCostEntries?: number;
  estimatedCostEntries?: number;
  date: string; // YYYY-MM-DD
  totalTokens: number;
  totalCost: number;
}
export interface UsageTotals extends UsageTokenParts {
  totalTokens: number;
  totalCost: number;
  inputCost?: number;
  outputCost?: number;
  cacheReadCost?: number;
  cacheWriteCost?: number;
  missingCostEntries?: number;
  estimatedCostEntries?: number;
}
export interface UsageSeries {
  availability?: "complete" | "partial" | "unavailable";
  availabilityReason?: "unsupported-range";
  daily: UsageDailyPoint[];
  totals: UsageTotals;
  cacheStatus?: string; // "fresh" | "refreshing"（网关冷扫描中，数值为全零快照）
}
export interface UsageModelRank extends UsageTokenParts {
  model: string;
  provider?: string;
  count?: number; // 消息数（OpenClaw）
  totalTokens: number;
  totalCost: number;
}
export interface UsageAgentRank extends UsageTokenParts {
  agentId: string;
  totalTokens: number;
  totalCost: number;
}
export interface UsageSourceRank extends UsageTokenParts {
  id: string;
  label: string;
  kind: "agent" | "profile";
  backendId: string;
  profile?: string;
  model?: string;
  provider?: string;
  totalTokens: number;
  totalCost: number;
}
export interface UsageChannelRank extends UsageTokenParts {
  channel: string;
  totalTokens: number;
  totalCost: number;
}
export interface UsageToolStat {
  name: string;
  count: number;
}
export interface UsageToolStats {
  totalCalls: number;
  uniqueTools: number;
  tools: UsageToolStat[];
}
export interface UsageLatency {
  count: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p95Ms: number;
}
export interface UsageDailyLatency {
  date: string;
  count: number;
  avgMs: number;
  p95Ms: number;
}
export interface UsageModelDailyPoint {
  date: string;
  model: string;
  provider?: string;
  tokens: number;
  cost: number;
}
export interface UsageDailyActivity {
  date: string;
  messages: number;
  toolCalls: number;
  /** 缺省 = 该后端无错误信号（如 Hermes），UI 据此隐藏整条错误线（R211）。 */
  errors?: number;
  tokens: number;
  cost: number;
}
export interface UsageMessageStats {
  total: number;
  user: number;
  assistant: number;
  toolCalls: number;
  errors: number;
}
export interface UsageTopSession {
  key: string;
  label?: string;
  /** 人类可读的会话主题（Hermes=会话标题；OpenClaw=首条用户消息截断）；缺省回退 label/key */
  title?: string;
  /** 物理 transcript id（仅文件扫描源提供），传给 getSessionPreview 精确定位 */
  sessionId?: string;
  agentId?: string;
  channel?: string;
  model?: string; // 最后使用的模型（models 缺省时的回退显示）
  models?: { model: string; tokens: number }[]; // 按模型拆分的 token 明细，降序；仅逐消息数据源提供
  totalTokens: number;
  totalCost: number;
  updatedAt?: number;
}
export interface UsageBreakdown {
  availability?: "complete" | "partial" | "unavailable";
  availabilityReason?: "unsupported-range";
  byModel: UsageModelRank[];
  byAgent: UsageAgentRank[];
  bySource?: UsageSourceRank[];
  byChannel?: UsageChannelRank[];
  tools?: UsageToolStats;
  latency?: UsageLatency;
  dailyLatency?: UsageDailyLatency[];
  modelDaily?: UsageModelDailyPoint[];
  dailyActivity?: UsageDailyActivity[];
  messages?: UsageMessageStats;
  topSessions?: UsageTopSession[];
  missingCostEntries?: number;
  totals: UsageTotals;
  cacheStatus?: string;
  sourceKind?: "agent" | "profile";
  scanLimit?: number;
}

// One skill from a backend (see backend getSkills()). Read-only in the UI.
export interface UnifiedSkill {
  name: string;
  description: string;
  enabled: boolean;
  backendId: string; // "openclaw" | "hermes"
  category?: string;
  emoji?: string;
  id?: string;
  version?: string;
  source?: "builtin" | "user";
  contentHash?: string;
  requiredTools?: string[];
  requiredRuntimeCapabilities?: string[];
  sourceCompatibility?: string[];
  eligible?: boolean;
  ineligibleReason?: string | null;
  profileId?: string;
  agentId?: string;
  registryRevision?: string;
  registryVersion?: number;
  profileRevision?: number;
}

// "哪个 agent 把哪个 skill 读进过上下文"（见 backend getSkillUsage()）。形状与
// BackendCliUsage 一致，skills[skillName][agentId] = 次数。
export interface BackendSkillUsage {
  backend: string;
  supported: boolean;
  reason?: string;
  skills: Record<string, Record<string, number>>;
  scanLimit?: number;
}

// ---- Workboard (OpenClaw gateway plugin) enums ----
export type WorkboardPriority = "low" | "normal" | "high" | "urgent";
export type WorkboardTemplateId = "bugfix" | "docs" | "release" | "pr_review" | "plugin";
// Official workboard status enum (columns come from the gateway's list response).
export type WorkboardStatus =
  | "triage" | "backlog" | "todo" | "scheduled" | "ready"
  | "running" | "review" | "blocked" | "done";
// Card lifecycle derived from the linked gateway task/session (official Vp states).
export type WorkboardLifecycleState =
  | "running" | "succeeded" | "failed" | "stale" | "idle" | "missing" | "unlinked";
export type WbGatewayTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out";

// Per-card badge counts (OpenClaw workboard); each omitted when zero/false.
export interface TaskCardBadges {
  comments?: number; attempts?: number; proof?: number; artifacts?: number;
  diagnostics?: number; links?: number; claimed?: boolean; stale?: boolean; failures?: number;
}

// Kanban board item (see backend getTaskBoard()). Each backend defines its own columns.
export interface UnifiedTask {
  id: string;
  title: string;
  excerpt?: string;
  column: string;
  assignee?: string;          // Hermes (legacy)
  priority?: number;          // Hermes (legacy numeric)
  backendId: string;
  // Hermes kanban rich-card additions (all optional → render by presence):
  tenant?: string;
  commentCount?: number;
  linkCount?: { parents: number; children: number };
  progress?: { done: number; total: number };
  warnings?: { count: number; highestSeverity: string };
  createdAt?: number;                                   // epoch ms (tooltip)
  age?: { createdAgeSeconds?: number; startedAgeSeconds?: number };
  // OpenClaw workboard additions (all optional → page renders by presence, not backend id):
  priorityLevel?: WorkboardPriority;
  labels?: string[];
  agentId?: string;
  sessionKey?: string;
  position?: number;
  live?: boolean;
  updatedAt?: number;
  badges?: TaskCardBadges;
  lastEvent?: { kind: string; at: number };
  /** OpenClaw workboard: the raw official card + server-derived lifecycle (1:1 view renders from this). */
  wb?: WorkboardCard;
  /** Cross-backend Kanban projection. rawStatus is never discarded when columns collapse. */
  rawStatus?: string;
  taskKey?: string;
  projectKey?: string;
  sourceBoard?: string;
  sourceKind?: "workboard" | "hermes" | "native";
  agentKey?: string;
  scheduledAt?: number;
  archivedAt?: number;
}
export interface TaskColumn {
  id: string;
  name: string;
  tasks: UnifiedTask[];
}
// Board-level feature flags so the page branches on CAPABILITY, not backend id.
export interface TaskBoardCapabilities {
  kind?: "workboard" | "files" | "hermes" | "native";
  drag?: boolean;
  archive?: boolean;
  hardDelete?: boolean;
  sessionHandoff?: boolean;
  run?: boolean;
  retry?: boolean;
  manualComplete?: boolean;
  labels?: boolean;
  comments?: boolean;      // OpenClaw workboard: operator notes (workboard.cards.comment)
  priorities?: WorkboardPriority[];
  templates?: WorkboardTemplateId[];
  // Hermes parity gates (Slice 2-7 controls read these):
  boards?: boolean;
  orchestration?: boolean;
  tenants?: boolean;
  lanes?: boolean;
  diagnostics?: boolean;
  dispatch?: boolean;
  links?: boolean;
  progress?: boolean;
  archived?: boolean;
  /** 可直接移入的列 id 白名单；缺省 = 全部列都可（OpenClaw）。KAN-004。 */
  moveTargets?: string[];
  // 官方 Hermes kanban 独有能力（每项只被 UI 消费一次）：
  attachments?: boolean;       // 抽屉附件区（上传/下载/删）
  modelOverride?: boolean;     // 每任务模型覆盖
  boardSettings?: boolean;     // 板设置（名/描述/项目目录）
  profiles?: boolean;          // 编排面板的 profile 描述编辑
  homeChannels?: boolean;      // 每任务的 home 频道通知开关
  completionSummary?: boolean; // 移到 done 必须填完成摘要
  bulkDelete?: boolean;        // 批量永久删除 / 垃圾桶拖放
  workspaceKinds?: string[];   // 建卡可选的工作区类型
}

// 看板前端偏好（Hermes GET /config）。取不到 = null，页面用自身默认值。
export interface TaskBoardConfig {
  defaultTenant?: string;
  laneByProfile?: boolean;
  includeArchivedByDefault?: boolean;
  renderMarkdown?: boolean;
}
// 任务级模型覆盖的候选目录（按 provider 分组）。空 providers → 自由文本输入。
export interface TaskModelOptions {
  providers: { slug: string; label: string; models: string[] }[];
}
// 编排面板的 profile 行（比 board.assignees 多带描述 / 默认标记）。
export interface BoardProfile {
  name: string;
  description?: string;
  descriptionAuto?: boolean;
  isDefault?: boolean;
  model?: string;
  provider?: string;
  skillCount?: number;
}
// Worker 日志（含尾巴截断元信息）。
export interface TaskLog {
  content: string;
  exists: boolean;
  sizeBytes?: number;
  truncated?: boolean;
  path?: string;
}
// 每任务的 home 频道通知开关。
export interface TaskHomeChannel {
  platform: string;
  name?: string;
  chatId?: string;
  threadId?: string;
  subscribed: boolean;
}
export interface BulkTaskPatch {
  status?: string;
  assignee?: string;          // "" = 解除指派
  priority?: number;
  archive?: boolean;
  result?: string;
  summary?: string;
  reclaimFirst?: boolean;
  modelOverride?: string;
  providerOverride?: string;
  clearModelOverride?: boolean;
}
export interface BulkTaskResult {
  total: number;
  failed: number;
  failedIds?: string[];
  errors?: string[];
}

// 板级诊断行（有活跃诊断的任务，见 backend getTaskDiagnostics()，GAP-002）。
export interface TaskDiagnosticsRow {
  taskId: string;
  taskTitle: string;
  taskStatus?: string;
  taskAssignee?: string;
  diagnostics: { severity: string; kind?: string; message: string }[];
}
export interface TaskBoard {
  columns: TaskColumn[];
  capabilities?: TaskBoardCapabilities;
  tenants?: string[];        // Hermes: distinct task tenants (Slice 2 filter)
  assignees?: string[];      // Hermes: known profiles (Slice 2 filter)
  // OpenClaw workboard extras (official page inputs):
  statuses?: string[];       // ordered status/column ids from the gateway
  sessions?: WbSession[];    // session select options + lifecycle display
  agents?: WbAgents;         // agent filter/assignment (incl. defaultId + runtime)
  refreshError?: string;     // diagnostics refresh failed (non-fatal, official tone)
  error?: string;            // cards.list failed (plugin disabled / gateway down)
}
// Hermes multi-board (Slice 4): one project board among many.
export interface KanbanBoard {
  id?: string;
  slug: string;
  /** Logical cross-backend project identity; storage slugs may remain globally unique. */
  projectKey?: string;
  name: string;
  description?: string;
  icon?: string;
  total: number;
  current?: boolean;
  profileId?: string;
  agentId?: string;
  profileName?: string;
  backendId?: string;
  /** 板级项目目录 + 由它推导的工作区类型；建卡表单的默认值来源。 */
  defaultWorkdir?: string;
  defaultWorkspaceKind?: string;
}

export type CanonicalKanbanStatus =
  | "triage" | "ready" | "in_progress" | "review" | "blocked" | "done" | "archived";
export interface FederatedKanbanSource {
  backendId: string;
  backendName: string;
  kind: "workboard" | "hermes" | "native";
  boardId?: string;
  slug?: string;
  projectKey: string;
  agentId?: string;
  total: number;
  capabilities?: TaskBoardCapabilities;
}
export interface FederatedKanbanProject {
  key: string;
  name: string;
  description?: string;
  total: number;
  sources: FederatedKanbanSource[];
}
export interface FederatedTaskBoard {
  project: FederatedKanbanProject;
  projects: FederatedKanbanProject[];
  columns: TaskColumn[];
  agents: UnifiedAgent[];
  errors: { backendId: string; stage: string; error: string }[];
}
// Hermes orchestration settings (Slice 5). autoDecompose=true → "Auto" mode.
export interface Orchestration {
  orchestratorProfile?: string;
  defaultAssignee?: string;
  autoDecompose: boolean;
  autoPromoteChildren: boolean;
  resolvedOrchestratorProfile?: string;
  resolvedDefaultAssignee?: string;
  activeProfile?: string;
}

export interface TaskComment {
  author: string;
  body: string;
  createdAt?: string | number;
}
export interface TaskRun {
  id?: string;
  status?: string;
  outcome?: string;
  startedAt?: number | null;
  finishedAt?: number | null;
  summary?: string;
  error?: string;
  profile?: string;
  metadata?: Record<string, unknown>;
}
export interface TaskDiagnosticAction {
  /** 官方可扩展：未知 kind 由 UI 降级成只读行，不许崩。 */
  kind: "claim" | "unblock" | "reassign" | "add_proof" | "open_session" | "reclaim" | "comment" | "cli_hint" | "open_docs" | string;
  label: string;
  suggested?: boolean;
  payload?: { command?: string; url?: string; reclaim_first?: boolean; [k: string]: unknown };
}
export interface TaskDiagnostic {
  severity: string;
  kind: string;
  message: string;             // = title (back-compat)
  title?: string;
  detail?: string;
  data?: Record<string, unknown>;
  actions?: TaskDiagnosticAction[];
}
export interface TaskEvent {
  id?: string; kind: string; at: number; fromStatus?: string; toStatus?: string;
  payload?: Record<string, unknown>;
}
/** 子任务结果（官方抽屉 Child Results：父卡自己常常没有 result）。 */
export interface TaskChildResult {
  id: string;
  title: string;
  status: string;
  result?: string;
  latestSummary?: string;
}
export interface TaskProof { id: string; status: "passed" | "failed" | "skipped" | "unknown"; createdAt: number; label?: string; command?: string; url?: string; note?: string; }
export interface TaskArtifact { id: string; createdAt: number; label?: string; url?: string; path?: string; mimeType?: string; }
export interface TaskLink { id: string; type: "parent" | "child" | "blocks" | "blocked_by" | "relates_to"; createdAt: number; targetCardId?: string; title?: string; url?: string; }
export interface TaskAttachment {
  id: string; filename: string; size?: number;
  contentType?: string; uploadedBy?: string; createdAt?: number;
}
export interface TaskExecution { id: string; kind: string; engine?: string; mode?: string; status: string; model?: string; sessionKey?: string; runId?: string; startedAt?: number; updatedAt?: number; }

// ---- OpenClaw workboard: the raw official card (workboard.cards.list shape) ----
export interface WbComment { id: string; body: string; createdAt: number; updatedAt?: number }
export interface WbAttempt {
  id: string; status: "running" | "succeeded" | "failed" | "blocked" | "stopped"; startedAt: number; endedAt?: number;
  engine?: string; mode?: string; model?: string; sessionKey?: string; runId?: string; error?: string;
}
export interface WbAttachment { id: string; cardId?: string; createdAt: number; fileName: string; byteSize: number; mimeType?: string; note?: string }
export interface WbWorkerLog { id: string; createdAt: number; level: "info" | "warning" | "error"; message: string }
export interface WbDiagnostic { kind: string; severity: "warning" | "error" | "critical"; title: string; detail?: string; lastSeenAt?: number; count?: number }
export interface WbNotification { id: string; kind: string; createdAt: number; message: string }
export interface WbWorkspace { kind: string; path?: string; branch?: string }
export interface WbAutomation {
  tenant?: string; boardId?: string; idempotencyKey?: string; skills?: string[]; workspace?: WbWorkspace;
  scheduledAt?: number; summary?: string; createdCardIds?: string[]; dispatchCount?: number; lastDispatchAt?: number;
}
export interface WbMetadata {
  attempts?: WbAttempt[]; comments?: WbComment[]; links?: TaskLink[]; proof?: TaskProof[]; artifacts?: TaskArtifact[];
  attachments?: WbAttachment[]; workerLogs?: WbWorkerLog[]; workerProtocol?: { state: string; updatedAt?: number; detail?: string };
  automation?: WbAutomation; claim?: { ownerId: string; claimedAt?: number; lastHeartbeatAt?: number; expiresAt?: number };
  diagnostics?: WbDiagnostic[]; notifications?: WbNotification[]; templateId?: WorkboardTemplateId; archivedAt?: number;
  stale?: { detectedAt: number; lastSessionUpdatedAt?: number; reason: string };
  lifecycleStatusSourceUpdatedAt?: number; failureCount?: number;
}
// Server-computed lifecycle view (inputs of the official St/Ct/health helpers).
export interface WbLifecycleView {
  state: WorkboardLifecycleState;
  session: { key: string; name: string; status?: string; hasActiveRun?: boolean; abortedLastRun?: boolean; updatedAt?: number } | null;
  task: {
    id: string; taskId: string; status: WbGatewayTaskStatus; title?: string;
    runtime?: string;
    deliveryStatus?: "pending" | "delivered" | "session_queued" | "failed" | "dismissed" | "parent_missing" | "not_applicable";
    terminalOutcome?: "succeeded" | "blocked";
    startedAt?: string | number;
    endedAt?: string | number;
    progressSummary?: string; terminalSummary?: string; error?: string;
    runId?: string; sessionKey?: string; childSessionKey?: string; ownerKey?: string;
  } | null;
}
export interface WorkboardCard {
  id: string; title: string; notes?: string; status: string; priority: WorkboardPriority;
  labels: string[]; agentId?: string; sessionKey?: string; runId?: string; taskId?: string; sourceUrl?: string;
  execution?: TaskExecution; position: number; createdAt: number; updatedAt: number; startedAt?: number; completedAt?: number;
  events?: TaskEvent[]; metadata?: WbMetadata;
  archived: boolean;             // derived: !!metadata.archivedAt
  lifecycle?: WbLifecycleView;   // server-computed per refresh
}
export interface WbSession {
  key: string; label?: string; displayName?: string; kind?: string; archived?: boolean;
  status?: string; hasActiveRun?: boolean; abortedLastRun?: boolean; updatedAt?: number;
}
export interface WbAgents { defaultId?: string; agents: { id: string; name: string; runtimeId?: string }[] }
// workboard.cards.dispatch summary (official Sp counts).
export interface WbDispatchSummary {
  started: number; failures: number; promoted: number; blocked: number; reclaimed: number; orchestrated: number;
}

// Full task detail (see backend getTask()).
export interface UnifiedTaskDetail {
  id: string;
  title: string;
  body: string;
  column: string;
  assignee?: string;
  priority?: number;
  summary?: string;
  comments?: TaskComment[];
  runs?: TaskRun[];
  diagnostics?: TaskDiagnostic[];
  raw?: string;
  backendId: string;
  // OpenClaw workboard additions:
  priorityLevel?: WorkboardPriority;
  labels?: string[];
  agentId?: string;
  sessionKey?: string;
  templateId?: WorkboardTemplateId;
  execution?: TaskExecution;
  events?: TaskEvent[];
  proof?: TaskProof[];
  artifacts?: TaskArtifact[];
  links?: TaskLink[];
  // Hermes detail extras (Slice 6):
  tenant?: string;
  result?: string;
  workspaceKind?: string;
  workspacePath?: string;
  skills?: string[];
  goalMode?: boolean;
  goalMaxTurns?: number;
  createdBy?: string;
  linkIds?: { parents: string[]; children: string[] };
  attachments?: TaskAttachment[];
  childResults?: TaskChildResult[];
  /** 最近一次 run 的 summary；官方 Result 区在 result 缺席时退到它。 */
  latestSummary?: string;
  blockReason?: string;
  /** 每任务模型覆盖（provider 可空 = 只覆盖模型名）。 */
  modelOverride?: string;
  providerOverride?: string;
  createdAt?: number;
  updatedAt?: number;
  startedAt?: number;
  completedAt?: number;
}
export type WorkboardEngine = "codex" | "claude";
export type WorkboardRunMode = "autonomous" | "manual" | "retry";
export interface TaskRunResult { sessionKey?: string; runId?: string; retryOf?: string; runStarted?: boolean; status?: string; runError?: unknown; }

// Create/edit spec for POST/PUT /__api/tasks.
export interface TaskInput {
  board?: string;
  boardId?: string;
  title?: string;
  body?: string;
  column?: string;
  assignee?: string;
  priority?: number;
  // OpenClaw workboard additions:
  status?: string;
  priorityLevel?: WorkboardPriority;
  labels?: string[];
  agentId?: string;
  sessionKey?: string;
  templateId?: WorkboardTemplateId;
  // Hermes create extras (Slice 6):
  tenant?: string;
  skills?: string[];
  goalMode?: boolean;
  goalMaxTurns?: number;
  // Hermes 建卡补齐：工作区（scratch=完成即删）/父任务/triage 落列/模型覆盖。
  workspaceKind?: string;
  workspacePath?: string;
  parents?: string[];
  triage?: boolean;
  modelOverride?: string;
  providerOverride?: string;
  clearModelOverride?: boolean;
  // 完成摘要（status=done 时一并 PATCH，写入 result+summary）。
  result?: string;
  summary?: string;
  blockReason?: string;
}

// CLI page (host-level $PATH scan, see app/cli-scanner.js).
export interface CliTool {
  name: string;
  path: string;
  category: string;
  version?: string | null;
  // Install provenance (R77+): system | homebrew | homebrew-dep | npm | pyenv |
  // cargo | local | other. userInstalled = the user put it here on purpose
  // (excludes OS built-ins, version-manager shims, transitive Homebrew deps).
  source?: string;
  userInstalled?: boolean;
}
export interface CliCategory {
  id: string;
  label: string;
  order: number;
}
// Per-backend aggregate of which host CLI commands the backend's agents have
// actually invoked (bash/exec tool calls), as { commandName: { agentId: count } }.
// OpenClaw local only; other backends return supported:false. The CLI page joins
// this against getClis() to show per-agent usage + totals. scanLimit (when set) =
// only the newest N sessions were scanned (older skipped for performance).
export interface BackendCliUsage {
  backend: string;
  supported: boolean;
  reason?: string;
  commands: Record<string, Record<string, number>>;
  scanLimit?: number;
}
// Lazy per-tool reference info (fetched when the detail drawer opens).
export interface CliInfo {
  version: string | null;
  summary: string | null;
  help: string | null;
}

// One agent for the 代理 page (see backend listAgents()).
export interface UnifiedAgent {
  id: string;
  name: string;
  model?: string;
  provider?: string;
  runtime?: string;
  runtimeAccountId?: string;
  environmentKind?: "native-user" | "shoggoth-managed";
  sharedAgentCount?: number;
  fallbacks?: string[];
  workspace?: string;
  isDefault?: boolean;
  protected?: boolean;
  archived?: boolean;
  lifecycleState?: "active" | "updating" | "provisioning" | "archiving" | "archive-repair" | "archived" | "restoring";
  updatedAt?: number;
  createdAt?: number | null;
  backendId: string;
  backendName?: string;
  sourceKind?: "workboard" | "hermes" | "native";
  agentKey?: string;
  kanbanAssignee?: string;
}

export interface AgentFileMeta {
  name: string;
  size?: number;
  modifiedAt?: number;
  readOnly?: boolean;
}
export interface AgentChannel {
  id: string;
  type?: string;
  status?: string;
  label?: string;
}
// Archived (sealed/rotated-out) transcript segments preceding a session's live
// transcript. The gateway reset-archives a session on a role-ordering conflict
// (renames <id>.jsonl → <id>.jsonl.reset.<ts>), so chat.history stops serving it.
export interface ArchiveSegment {
  sessionId: string;
  sealedAt: number | null;
  fromReset: boolean;
  truncated?: boolean;
  messages: unknown[]; // raw chat.history-shaped records; ChatPage normalize()s them
}
export interface SessionArchive {
  supported: boolean;
  reason?: string;
  segments: ArchiveSegment[];
}
export interface SessionArtifactItem {
  path: string;
  name: string;
  area: string;
  size?: number;
  mtimeMs: number;
  ext?: string;
  kind: "doc" | "image" | "data" | "other";
}
export interface SessionArtifactsResult {
  supported: boolean;
  reason?: string;
  approximate?: boolean;
  sinceMs?: number;
  total?: number;
  items: SessionArtifactItem[];
}
export interface InspirationActivity {
  runId: string;
  trajectory: {
    supported: boolean;
    reason: string | null;
    parts: (import('./lib/turnTimeline').TimelinePartLike & { id: string; ts: number | null })[];
    truncated: boolean;
  };
  artifacts: { supported: boolean; reason: string | null; items: SessionArtifactItem[]; hasMore: boolean };
}
export interface GlobalChatSearchHit {
  backendId: string;
  agentId: string;
  agentName: string;
  key: string;
  sessionId?: string;
  messageId?: string;
  snippet: string;
  ts: number | null;
  role?: string;
}
export interface GlobalChatSearchResult {
  query: string;
  offset: number;
  searchedAgents: number;
  unsupportedAgents: number;
  failedAgents: number;
  truncated: boolean;
  hasMore: boolean;
  nextOffset?: number;
  results: GlobalChatSearchHit[];
}
// Usage Top 会话行点击的 transcript 头部预览（GET /__api/sessions/preview）。
export interface SessionPreviewMessage {
  role: string; // "user" | "assistant"
  text: string;
  timestamp?: number;
  model?: string;
}
export interface SessionPreview {
  supported: boolean;
  reason?: string;
  title?: string;
  totalMessages?: number;
  /** 本页窗口起点（分页；UI 滑动逐步加载） */
  offset?: number;
  /** offset+messages.length 之后还有更多（UI 据此续拉） */
  truncated?: boolean;
  messages: SessionPreviewMessage[];
}

export interface AdvancedSessionMethodMap {
  "environments.list": boolean;
  "sessions.describe": boolean;
  "sessions.branches.list": boolean;
  "sessions.fork": boolean;
}

export interface EnvironmentWorkerSummary {
  providerId: string;
  state: string;
  ageMs?: number;
  idleMs?: number;
  tunnelStatus?: string;
  desktop?: boolean;
  desktopApps?: string[];
  attachedSessionCount?: number;
}

export interface EnvironmentSummary {
  id: string;
  type: string;
  label?: string;
  status: string;
  platform?: string;
  sessionHost?: boolean;
  trust?: string;
  desktop?: boolean;
  workerSlots?: { total: number; available: number };
  workerBundle?: { status: "installed" | "missing"; version?: string };
  lastConnectedAtMs?: number;
  lastDisconnectedAtMs?: number;
  lastSeenAtMs?: number;
  issues?: Array<{ code: string; action: string }>;
  worker?: EnvironmentWorkerSummary;
}

export interface EnvironmentProfileSummary {
  id: string;
  providerId: string;
  trust?: string;
  executionMode?: string;
  executionModes?: string[];
  machines?: Array<{
    id: string;
    label: string;
    cpu?: number;
    memoryGb?: number;
    default?: boolean;
  }>;
}

export interface EnvironmentInventory {
  supported: boolean;
  reason?: string;
  methods: AdvancedSessionMethodMap;
  environments: EnvironmentSummary[];
  profiles: EnvironmentProfileSummary[];
}

export interface SessionAdvancedSummary {
  key: string;
  agentId: string;
  kind?: string;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  createdAt?: number;
  updatedAt?: number;
  archived?: boolean;
  status?: string;
  model?: string;
  modelProvider?: string;
  activeLeafEntryId?: string;
  parentSessionKey?: string;
  forkSource?: { sessionKey: string; entryId: string };
  placement?: {
    state?: string;
    environmentId?: string;
    providerId?: string;
    profileId?: string;
    generation?: number;
    createdAtMs?: number;
    updatedAtMs?: number;
    stateChangedAtMs?: number;
    terminalReason?: string;
    terminalAtMs?: number;
  };
}

export interface SessionAdvancedDescription {
  supported: boolean;
  reason?: string;
  methods: AdvancedSessionMethodMap;
  session: SessionAdvancedSummary | null;
}

export interface SessionBranchSummary {
  leafEntryId: string;
  headline: string;
  messageCount: number;
  updatedAt?: string;
  active: boolean;
}

export interface SessionBranchesResult {
  supported: boolean;
  reason?: string;
  methods: AdvancedSessionMethodMap;
  branches: SessionBranchSummary[];
}

export interface SessionForkResult {
  supported: boolean;
  reason?: string;
  methods: AdvancedSessionMethodMap;
  sessionKey?: string;
  editorText?: string;
  editorAttachments?: Array<{ mimeType: string; data: string }>;
  attachmentsOmitted?: boolean;
}

export interface SessionBoardMethodMap {
  "board.get": boolean;
  "board.update": boolean;
  "board.widget.put": boolean;
  "board.widget.grant": boolean;
}

export interface SessionBoardTab {
  tabId: string;
  title: string;
  position: number;
  chatDock: "left" | "right" | "bottom" | "hidden";
}

export interface SessionBoardWidget {
  name: string;
  tabId: string;
  title?: string;
  content: { kind: "html" | "mcp-app" | "plugin" | "registered" | "unknown"; supported: false };
  presentation?: "card" | "full-bleed" | "frameless";
  heightMode?: "auto" | "fixed";
  sizeW: number;
  sizeH: number;
  position: number;
  grantState: "none" | "pending" | "granted" | "rejected";
  revision: number;
  instanceId?: string;
  accessSummary?: { networkOrigins: string[]; tools: string[] };
}

export interface SessionBoardSnapshot {
  sessionKey: string;
  revision: number;
  tabs: SessionBoardTab[];
  widgets: SessionBoardWidget[];
}

export type SessionBoardOp =
  | { kind: "tab_create"; tabId: string; title: string; chatDock?: SessionBoardTab["chatDock"] }
  | { kind: "tab_update"; tabId: string; title?: string; chatDock?: SessionBoardTab["chatDock"]; position?: number }
  | { kind: "tab_delete"; tabId: string }
  | { kind: "tabs_reorder"; tabIds: string[] }
  | { kind: "widget_move"; name: string; tabId?: string; position?: number; after?: string }
  | { kind: "widget_resize"; name: string; sizeW: number; sizeH: number; heightMode?: SessionBoardWidget["heightMode"] }
  | { kind: "widget_remove"; name: string };

export interface SessionBoardResult {
  supported: boolean;
  reason?: string;
  methods: SessionBoardMethodMap;
  capabilities: { "board-widget-put-canvas-doc": boolean };
  snapshot: SessionBoardSnapshot | null;
  resolvedWidgetName?: string;
}
// Full agent detail for the 代理 page (see backend getAgent()).
export interface UnifiedAgentDetail {
  id: string;
  name: string;
  model?: string;
  fallbacks?: string[];
  workspace?: string;
  emoji?: string;
  provider?: string;
  runtime?: string;
  runtimeAccountId?: string;
  environmentKind?: "native-user" | "shoggoth-managed";
  sharedAgentCount?: number;
  profile?: string;
  isDefault?: boolean;
  protected?: boolean;
  archived?: boolean;
  lifecycleState?: UnifiedAgent["lifecycleState"];
  updatedAt?: number;
  files?: AgentFileMeta[];
  definitionRevision?: number;
  backendId: string;
}

export interface AgentDefinitionRevision {
  revision: number;
  actor: string;
  reason: string | null;
  updatedAt: number;
  documents: Record<string, { kind: string; contentHash: string; byteLength: number; revision: number }>;
}
export interface AgentDefinitionState {
  supported: boolean;
  reason?: string;
  current: AgentDefinitionRevision;
  history: AgentDefinitionRevision[];
  historyHasMore?: boolean;
  files: Array<{ kind: string; name: string; readOnly: boolean }>;
}
export interface AgentMemoryItem {
  id: string;
  profileId: string;
  scope: "user" | "agent" | "project" | "workspace";
  type: "semantic" | "episodic" | "procedural" | "project" | "temporary";
  content: string;
  sourceRefs: string[];
  confidence: number;
  sensitivity: "normal" | "private" | "restricted";
  status: "candidate" | "active" | "superseded" | "deleted";
  validFrom: number;
  validUntil: number | null;
  supersedes: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface AgentMemoryPage {
  supported: boolean;
  reason?: string;
  revision: number;
  items: AgentMemoryItem[];
  nextCursor: number;
  hasMore: boolean;
}
export interface AgentTranscriptSession {
  id: string;
  sessionKey: string;
  title: string | null;
  status: string;
  updatedAt: number;
  transcriptRevision: number;
  eventCount: number;
}
export interface AgentTranscriptSessionPage {
  supported: boolean;
  reason?: string;
  items: AgentTranscriptSession[];
  nextCursor: number;
  hasMore: boolean;
}
export interface AgentTranscriptEvent {
  id: string;
  seq: number;
  kind: string;
  content: { text?: string; [key: string]: unknown };
  contextExcluded: boolean;
  occurredAt: number;
}
export interface AgentTranscriptEventPage {
  supported: boolean;
  reason?: string;
  revision: number;
  items: AgentTranscriptEvent[];
  nextCursor: number;
  hasMore: boolean;
}
export interface AgentToolPermission {
  name: string;
  domain: string;
  description: string;
  risk: "read" | "write" | "confirm" | "destructive";
  enabled: boolean;
  effect: "allow" | "deny";
}
export interface AgentToolsState {
  supported: boolean;
  reason?: string;
  registryRevision: string;
  revision: number;
  tools: AgentToolPermission[];
}
export interface ComputerUseSession {
  id: string;
  profileId: string;
  workRunId: string;
  allowedApplications: string[];
  status: "ready" | "paused" | "closed" | "failed";
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  pauseReason: string | null;
}
export interface AgentComputerState {
  supported: boolean;
  reason?: string;
  available: boolean;
  driverVersion: string | null;
  contractVersion: string | null;
  permissions: { accessibility: boolean | null; screenRecording: boolean | null };
  sessions: ComputerUseSession[];
}
// Create/edit spec for POST/PUT /__api/agents.
export interface AgentInput {
  name?: string;
  model?: string;
  /** 模型降级链（OpenClaw）。与 model 同属一个配置节点，后端整节点写。 */
  fallbacks?: string[];
  emoji?: string;
  avatar?: string;
  workspace?: string;
  cloneFromDefault?: boolean;
  noSkills?: boolean;
  operationId?: string;
  expectedUpdatedAt?: number;
  createdAt?: number;
}

// Per-backend status for the 设置 page (see backend getStatus()).
export interface BackendDashboard {
  profile: string;
  port: number;
  baseUrl?: string;
  connected: boolean;
  version?: string;
}
export type VersionSource = "gateway" | "dashboard" | "npm" | "pypi" | "github" | "desktop";
export interface BackendVersionDashboard {
  profile: string;
  port?: number;
  baseUrl?: string;
  connected: boolean;
  current?: string;
  latest?: string;
  updateAvailable?: boolean;
  currentSource?: VersionSource;
  latestSource?: VersionSource;
  error?: string;
}
export interface BackendVersionStatus {
  id: string;
  name: string;
  current?: string;
  latest?: string;
  updateAvailable?: boolean;
  currentSource?: VersionSource;
  latestSource?: VersionSource;
  releaseNotesUrl?: string;
  error?: string;
  comparisonSupported?: boolean;
  dashboards?: BackendVersionDashboard[];
}

// 设置页「立即更新」状态（/__api/updates；形状对应 core/self-updater.js）。
export interface SelfUpdateRun {
  running: boolean;
  phase?:
    | "updating"
    | "finalizing"
    | "restart_pending"
    | "verifying"
    | "repair_required"
    | "capability_review_required"
    | "completed"
    | "failed";
  operation?: "update" | "repair" | "doctor" | "gateway_status";
  reason?: string;
  startedAt?: number;
  finishedAt?: number;
  exitCode?: number | null;
  ok?: boolean;
  error?: string;
  // 更新命令成功但收尾失败（服务重启/更新后健康检查没过）→ ok=false + 这里存原因。
  postUpdateError?: string;
  // 上次更新进行中 app 退出（落盘状态恢复时合成），结果未知。
  interrupted?: boolean;
  command?: string;
  logTail?: string;
  progressTail?: string;
  expectedVersion?: string;
  loadedVersion?: string;
  findings?: unknown[];
  pluginWarnings?: unknown[];
  pluginVersionDrift?: Array<{ pluginId: string; installedVersion?: string; gatewayVersion?: string }>;
  capabilityReviews?: Array<{ pluginId?: string; message?: string }>;
}
export interface BackendSelfUpdate {
  id: string;
  name: string;
  supported: boolean;
  reason?: string;
  actions?: Array<"update" | "repair">;
  status?: SelfUpdateRun;
}

export interface StandingGrant {
  backendId: string;
  grantId: string;
  mintedByApprovalId: string;
  agentId: string;
  cronJobId: string;
  cronJobName: string | null;
  createdAtMs: number;
  expiresAtMs: number | null;
  revokedAtMs: number | null;
  revokedBy: string | null;
  lastUsedAtMs: number | null;
  useCount: number;
}

export interface StandingGrantList {
  supported: boolean;
  reason?: string;
  grants: StandingGrant[];
}

export interface StandingGrantRevokeResult {
  supported: boolean;
  reason?: string;
  outcome?: "revoked" | "already-revoked" | "not-found";
}

// App config (设置 page) — mirrors app/core/config-store.js.
export interface HermesRemote {
  profile: string;
  baseUrl: string;
  token?: string;
}
export interface NotificationPrefs {
  chat: boolean;
  cron: boolean;
  task: boolean; // Kanban tasks and Inspiration
}
export interface AppConfig {
  gatewayUrl: string;
  token: string;
  locale: string;
  theme: "system" | "light" | "dark";
  hermesMode: "local" | "remote";
  hermesRemotes: HermesRemote[];
  /** 退出 app 时保留本地 spawn 的 Hermes dashboard 进程，留给下次启动复用（默认 true）。 */
  hermesKeepAlive: boolean;
  /** 设置页「断开连接」的后端 id 列表；registry 聚合/路由跳过它们。 */
  disabledBackends: string[];
  notifications: NotificationPrefs;
  // 首启引导完成/跳过的时间戳（epoch ms）；0 = 从未。SetupOverlay 仅在
  // setupCompletedAt===0 且 token==="" 时自动出现一次。
  setupCompletedAt: number;
}
export interface ConnTestResult {
  ok: boolean;
  error?: string;
  /** S1 classifyAuthError 机器码(token_mismatch/unreachable/…),失败时给指引文案。 */
  reason?: string;
  info?: Record<string, unknown>;
}

export type BackendConnectionMode =
  | "gateway"
  | "managed-service"
  | "builtin-service"
  | "native-runtime";

export type BackendCronKind = "openclaw" | "hermes" | "native";
export type BackendKanbanKind = "workboard" | "hermes" | "native";

export interface BackendDescriptor {
  id: string;
  name: string;
  connectionMode: BackendConnectionMode;
  disconnectable: boolean;
  agentLifecycle: {
    create: boolean;
    update: boolean;
    remove: boolean;
    archive: boolean;
    restore: boolean;
    readStates: boolean;
  };
  surfaces: {
    chat: boolean;
    agents: boolean;
    models: boolean;
    skills: boolean;
    usage: boolean;
    oauth: boolean;
    dashboardRuns: boolean;
    agentHarness: boolean;
    cron: null | { kind: BackendCronKind };
    kanban: null | { kind: BackendKanbanKind };
  };
}

export interface BackendStatus {
  id: string;
  name: string;
  connected: boolean;
  /** 用户在设置页显式断开（config.disabledBackends）；卡片渲染「重新连接」。 */
  disabled?: boolean;
  info: {
    gatewayUrl?: string;
    hasIdentity?: boolean;
    cronJobs?: number;
    agents?: number;
    profiles?: number;
    mode?: string;
    connectionMode?: BackendConnectionMode;
    dashboards?: BackendDashboard[];
    error?: string;
    /** S1 classifyAuthError 机器码,未连接时才有。 */
    reason?: string;
    /** 后端 start() 进行中（spawn→ready 窗口），UI 按「检测中」渲染。 */
    starting?: boolean;
    /** 当前确实可服务聊天的 agent；Hermes 按 profile dashboard 精确投影。 */
    readyAgentIds?: string[];
  };
}

/** GET /__api/host/openclaw —— 首启梯子的本机侦察(只报存在性,绝不含 token 值)。 */
export interface OpenclawHostInfo {
  binPath: string | null;
  version: string | null;
  gatewayRunning: boolean;
  /** 本机网关真实监听地址(gateway status 探出;端口随版本漂移,R125)。 */
  localGatewayUrl: string | null;
  localGatewayRunning: boolean;
  configExists: boolean;
  localTokenReadable: boolean;
  identityExists: boolean;
}

/** POST /__api/host/openclaw/start —— 代跑 openclaw daemon start|install 的结果。 */
export interface GatewayStartResult {
  ok: boolean;
  code: number | null;
  output: string;
}

/** GET /__api/discovery/openclaw —— 局域网 mDNS 浏览到的 OpenClaw 网关。 */
export interface DiscoveredGateway {
  name: string;
  host: string;
  port: number;
  url: string;
}

/** GET/PUT /__api/discovery/state —— LAN 发现开关(managed=false:无白名单,默认开,只读)。 */
export interface LanDiscoveryState {
  supported: boolean;
  enabled?: boolean;
  managed?: boolean;
  error?: string;
}

// ---- dashboard 总览（GET /__api/dashboard）----

/** 每后端能力型 section 的统一包裹（对齐 BackendCliUsage 惯例）。 */
export interface DashboardBackendSection<T> {
  backend: string;
  supported: boolean;
  /** "unsupported" | "unavailable" | "remote" | "error" —— 前端映射文案。 */
  reason?: string;
  items: T[];
}

export interface DashboardRunEntry {
  backendId: string;
  /** 统一 id "<prefix>:<localId>"，可直接深链 /cron?job=。 */
  jobId: string;
  jobName?: string;
  agentId?: string;
  startedAt?: number | null;
  finishedAt?: number | null;
  status?: string;
  completionStatus?: CronCompletionStatus;
  error?: string;
  errorReason?: CronErrorReason;
  /** 投递摘要正文（feed 主体）；Hermes 合成行无此字段。 */
  summary?: string;
  durationMs?: number;
  deliveryStatus?: CronDeliveryStatus | string;
  deliveryError?: string;
  deliverySuppressionReason?: string;
  failureNotificationDelivery?: CronFailureNotificationDelivery;
  model?: string;
  sessionKey?: string;
  runId?: string;
  /** true = 由 job 末次状态合成（无 per-run 记录），弹窗据此隐藏「查看全文」。 */
  synthesized?: boolean;
}

export interface DashboardRunningItem {
  id: string;
  backendId?: string;
  title?: string;
  kind?: string;
  runtime?: string;
  status?: string;
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  createdAt?: number;
  startedAt?: number;
  progressSummary?: string;
  waitingRequestId?: string | null;
}

export interface InteractiveOptionV1 {
  value: string;
  label: string;
  description: string;
}

export interface InteractiveFieldV1 {
  id: string;
  type: "text" | "choice";
  label: string;
  description: string;
  required: boolean;
  secret: boolean;
  options: InteractiveOptionV1[];
}

export type InteractiveApprovalChoice = "once" | "session" | "deny" | "cancel" | `runtime:${number}`;

export interface InteractiveApprovalOption {
  choice: InteractiveApprovalChoice;
  label: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  scope?: "tool" | "server" | "session_files" | "all_operations";
}

export interface InteractiveRequestV1 {
  version: 1;
  requestId: string;
  runId: string;
  kind: "runtime_approval" | "mcp_permission" | "product_confirmation" | "user_input";
  title: string;
  message: string;
  fields: InteractiveFieldV1[];
  approvalChoices: InteractiveApprovalChoice[];
  approvalOptions?: InteractiveApprovalOption[];
  approvalDetails?: {
    kind?: "command" | "file_change" | "permissions";
    toolName?: string;
    serverName?: string;
    command?: string;
    cwd?: string;
    grantRoot?: string;
    input?: string;
    permissions?: string;
  };
  expiresAt: number | null;
}

export interface OpenClawQuestionOption {
  label: string;
  description?: string;
}

export interface OpenClawQuestionSecretStoreBinding {
  name: string;
  kind: "secret" | "env";
  allowedHosts?: string[];
  reason?: string;
}

export interface OpenClawQuestionSecretStoreExisting {
  updatedAtMs: number;
  updatedBy?: string;
}

export interface OpenClawQuestion {
  questionId: string;
  header: string;
  question: string;
  options: OpenClawQuestionOption[];
  multiSelect?: boolean;
  isOther?: boolean;
  isSecret?: boolean;
  secretStore?: OpenClawQuestionSecretStoreBinding;
  secretStoreExisting?: OpenClawQuestionSecretStoreExisting;
}

export interface OpenClawQuestionAnswers {
  answers: Record<string, string[]>;
}

export type OpenClawQuestionStatus = "pending" | "answered" | "cancelled" | "expired";

export interface OpenClawQuestionRecord {
  id: string;
  questions: OpenClawQuestion[];
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  createdAtMs: number;
  expiresAtMs: number;
  status: OpenClawQuestionStatus;
  answers?: OpenClawQuestionAnswers;
  resolvedBy?: string;
}

// ChatPromptCard receives a tagged projection so it can coexist with the
// legacy Hermes `chat.respond` prompt without guessing from backend ids.
export interface OpenClawQuestionPromptEntry extends OpenClawQuestionRecord {
  kind: "openclaw_question";
  requestId?: string;
}

export type OpenClawQuestionResolvedEvent =
  | { id: string; status: "answered"; answers: OpenClawQuestionAnswers }
  | { id: string; status: "cancelled" | "expired" };

export type OpenClawProgressCardStepStatus = "pending" | "in_progress" | "completed";

export interface OpenClawProgressCardStep {
  step: string;
  status: OpenClawProgressCardStepStatus;
}

export interface OpenClawProgressCard {
  sessionKey: string;
  revision: number;
  updatedAt: number;
  markdown?: string;
  steps?: OpenClawProgressCardStep[];
}

export interface OpenClawProgressCardChangedEvent {
  sessionKey: string;
  revision: number | null;
}

export interface DashboardApprovalItem {
  id: string;
  backendId?: string;
  kind?: "approval" | "input" | string;
  runId?: string;
  requestId?: string;
  commandPreview?: string;
  commandText?: string;
  message?: string;
  questions?: InteractiveFieldV1[];
  interactiveRequest?: InteractiveRequestV1;
  interactionInvalid?: boolean;
  source?: string;
  agentId?: string;
  allowedDecisions?: string[];
  createdAtMs?: number;
  expiresAtMs?: number;
}

export interface ShoggothServiceProductStatus {
  healthy: boolean;
  protocolVersion?: number;
  serviceVersion?: string;
  startedAt?: number;
  domainAvailability: Record<string, boolean>;
  pendingCommandsLocked: boolean;
  mcpCredentialsLocked: boolean;
}

export interface ShoggothBackgroundStatus {
  supported: boolean;
  reason?: "unsupported-platform" | "unstable-install-location" | "status-unavailable";
  installed?: boolean;
  enabled?: boolean;
  loaded?: boolean;
  needsRepair?: boolean;
}

export interface ShoggothProductStatus {
  service: ShoggothServiceProductStatus;
  background: ShoggothBackgroundStatus;
}

export interface ShoggothStopImpact {
  availability: "available" | "unavailable";
  revision: string;
  totalCount: number | null;
  runs: Array<{
    runId: string;
    source: "chat" | "kanban" | "cron" | "inspiration";
    status: "starting" | "running" | "waiting_approval" | "waiting_input";
    agentName: string | null;
    title: string | null;
  }>;
}

export interface RuntimeAccountAdmissionSummary {
  generation: number;
  active: number;
  maxActive: number;
  mutationActive: boolean;
  backoffUntil: number | null;
}

export interface RuntimeAccountStorage {
  runtimeAccountId: string;
  scope: "native-system" | "managed-account" | "managed-legacy";
  available: boolean;
  bytes: number;
  files: number;
  dirs: number;
  symlinks: number;
  incomplete: boolean;
  limitReason: "bytes" | "depth" | "duration" | "entries" | null;
}

/** Renderer-safe legacy Home projection. Filesystem paths and Profile IDs never cross this boundary. */
export interface LegacyRuntimeHomeSummary {
  id: string;
  runtime: string;
  runtimeAccountId: string;
  accountKind: "native-user" | "shoggoth-managed";
  role: "canonical" | "reclaimable";
  affectedAgentCount: number;
  bytes: number;
  files: number;
  dirs: number;
  symlinks: number;
  incomplete: boolean;
  lastModifiedAt: number;
}

export type RuntimeBackupCategory =
  | "native-runtime-import"
  | "runtime-schema-history"
  | "runtime-schema-current"
  | "native-capabilities"
  | "memory-migration"
  | "permission-policy"
  | "staging"
  | "unknown";

/** Renderer-safe backup projection. Backup names and filesystem paths stay inside the Service. */
export interface RuntimeBackupSummary {
  id: string;
  category: RuntimeBackupCategory;
  role: "retained" | "reclaimable";
  bytes: number;
  files: number;
  dirs: number;
  symlinks: number;
  incomplete: boolean;
  lastModifiedAt: number;
}

export interface RuntimeAccountSummary {
  id: string;
  runtime: string;
  kind: "native-user" | "shoggoth-managed";
  installationKind: "system" | "bundled";
  homeKind: "system-default" | "managed-shared";
  isDefault: boolean;
  sharedAgentCount: number;
  admission: RuntimeAccountAdmissionSummary;
}

export interface RuntimeAccountCardSnapshot extends RuntimeAccountSummary {
  storage: RuntimeAccountStorage;
  legacyHomes: LegacyRuntimeHomeSummary[];
}

export interface RuntimeAccountSnapshot {
  accounts: RuntimeAccountCardSnapshot[];
  backups: RuntimeBackupSummary[];
  legacyReclaimableBytes: number;
  backupReclaimableBytes: number;
}

export interface RuntimeAccountDetail {
  account: RuntimeAccountSummary;
  storage: RuntimeAccountStorage;
  legacyHomes: LegacyRuntimeHomeSummary[];
}

export interface RuntimeAccountAuth {
  authSource?: "native-codex";
  account: null | {
    type: "chatgpt" | "apiKey" | "amazonBedrock";
    planType?: string;
    usesCodexManagedCredentials?: boolean;
  };
  requiresOpenaiAuth: boolean;
  login: null | {
    requestId: string;
    mode: "browser" | "deviceCode";
    status: string;
    updatedAt: number;
    errorCode: string | null;
  };
}

export interface LegacyRuntimeHomeCleanupPlan {
  planId: string;
  entryId: string;
  runtime: string;
  runtimeAccountId: string;
  affectedAgentCount: number;
  bytes: number;
  files: number;
  dirs: number;
  symlinks: number;
  expiresAt: number;
}

export interface LegacyRuntimeHomeCleanupResult {
  entryId: string;
  runtime: string;
  runtimeAccountId: string;
  bytesReleased: number;
  filesRemoved: number;
  dirsRemoved: number;
  symlinksRemoved: number;
  deletedAt: number;
}

export interface RuntimeBackupCleanupPlan {
  planId: string;
  entryId: string;
  category: RuntimeBackupCategory;
  bytes: number;
  files: number;
  dirs: number;
  symlinks: number;
  expiresAt: number;
}

export interface RuntimeBackupCleanupResult {
  entryId: string;
  category: RuntimeBackupCategory;
  bytesReleased: number;
  filesRemoved: number;
  dirsRemoved: number;
  symlinksRemoved: number;
  deletedAt: number;
}

/** Renderer-safe provider projection; storage references and request headers never cross this boundary. */
export interface ShoggothProviderSummary {
  authSource?: "native-codex";
  id: string;
  kind: string;
  displayName: string;
  baseUrlHost?: string;
  /** Custom Responses API root, exposed only when the URL contains no auth/query/fragment. */
  baseUrl?: string;
  authState: "authenticated" | "configured" | "missing" | "not_required" | string;
  defaultModel?: string;
  validationStatus?: "unverified" | "protocol_valid" | "agent_compatible" | "invalid" | string;
}

export interface ShoggothProviderSnapshot {
  profile: null | {
    id: string;
    name: string;
    isDefault: boolean;
    configuredProviderId: string | null;
    defaultModel: string | null;
    ready: boolean;
  };
  providers: ShoggothProviderSummary[];
}

export interface ShoggothChatGptModel {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
}

export interface ShoggothChatGptModels {
  models: ShoggothChatGptModel[];
}

export interface ShoggothProviderConfiguration {
  profileId: string | null;
  operationId: string;
  createdAt: number;
  secret: string | null;
  provider: {
    id: string;
    kind: "openai-api-key" | "openrouter" | "ollama" | "lmstudio" | "custom-responses" | "amazon-bedrock";
    name: string;
    model: string;
    baseUrl: string | null;
    awsRegion: string | null;
    awsProfile: string | null;
  };
}

export interface ShoggothProviderConfigurationResult {
  profile: NonNullable<ShoggothProviderSnapshot["profile"]>;
  provider: ShoggothProviderSummary;
}

export interface ShoggothRunEvent {
  seq: number;
  type: string;
  text?: string;
  status?: string;
  error?: string;
  requestId?: string;
  message?: string;
  summary?: string;
  tool?: {
    kind?: string;
    name?: string;
    status?: string;
    errorCode?: string;
    success?: boolean;
    exitCode?: number;
  };
}

export interface BackendRunDetail {
  id: string;
  backendId: string;
  runId: string;
  source: string;
  status: string;
  agentId?: string;
  startedAt?: number;
  finishedAt?: number;
  summary?: string;
  error?: string;
  retryOf?: string;
  events: ShoggothRunEvent[];
  artifacts: Array<{ id: string; name: string; kind: string }>;
}

/** @deprecated Use BackendRunDetail. */
export type ShoggothRunDetail = BackendRunDetail;

export interface DashboardArtifactItem {
  /** 绝对路径：Finder reveal（/__api/cli/reveal）与 /__media 缩略图直接用。 */
  path: string;
  name: string;
  /** "workspace" | "media/outbound" | "agents/<id>" */
  area: string;
  agentId?: string;
  size?: number;
  mtimeMs: number;
  ext?: string;
  kind: "doc" | "image" | "data" | "other";
}

export interface DashboardUsageEntry {
  backend: string;
  availability?: "complete" | "partial" | "unavailable";
  yesterdayComplete?: boolean;
  /** 缺失今日数据不能解释为零用量。 */
  today?: UsageDailyPoint;
  yesterday?: UsageDailyPoint;
  error?: string;
}

/** 单来源降级（活动流非阻塞提示）：unsupported 不出现（本来就不支持≠降级）。 */
export interface DashboardDegradedSource {
  backend: string;
  source: "cron" | "kanban" | "health" | string;
  reason: "unavailable" | "remote" | "error" | "truncated" | "latest-only" | string;
}

export type DashboardActivitySeverity = "success" | "error" | "warning" | "info";

interface DashboardActivityBase {
  /** 稳定 ID（跨轮询/分页去重键）。 */
  id: string;
  backendId: string;
  occurredAt: number;
  severity: DashboardActivitySeverity;
  title: string;
  summary?: string;
  agentId?: string;
}

export interface DashboardActivityCron extends DashboardActivityBase {
  kind: "cron";
  /** 原运行行完整携带（Run 弹窗直接复用）。 */
  run: DashboardRunEntry;
}

export interface DashboardActivityKanban extends DashboardActivityBase {
  kind: "kanban";
  kanban: {
    taskId: string;
    board?: string;
    /** 规整后的动作码（created/started/moved/completed/failed/blocked/archived/restored/deleted），文案在 i18n。 */
    action: string;
    fromStatus?: string;
    toStatus?: string;
  };
}

export interface DashboardActivityHealth extends DashboardActivityBase {
  kind: "health";
  health: {
    targetType: string;
    targetId: string;
    state: "connected" | "disconnected";
    /** 应用关闭期间发生、启动后才检测到（不伪造发生时间）。 */
    detectedAfterRestart?: boolean;
  };
}

export interface DashboardActivityInspiration extends DashboardActivityBase {
  kind: "inspiration";
  inspiration: { ideaId: string; runId: string; status: Exclude<InspirationStatus, "saved"> };
}

export type DashboardActivityEntry = DashboardActivityCron | DashboardActivityKanban | DashboardActivityInspiration | DashboardActivityHealth;

export interface DashboardActivityPage {
  items: DashboardActivityEntry[];
  nextCursor?: string;
  hasMore: boolean;
  degradedSources: DashboardDegradedSource[];
  /** /activities 响应携带；首屏嵌在 summary 里时以 summary.sinceMs 为准。 */
  sinceMs?: number;
  generatedAt?: number;
}

export interface DashboardRunStatsBucket {
  ok: number;
  error: number;
  skipped: number;
  other: number;
  total: number;
}

/** 当天全量 cron 成败计数（KPI 口径，消除 runsLimit 截断低估）。 */
export interface DashboardRunStats {
  total: DashboardRunStatsBucket;
  byBackend: Array<{ backend: string } & DashboardRunStatsBucket>;
}

export interface DashboardTaskStats {
  total: { ok: number; error: number };
  byKind: Record<"cron" | "kanban" | "inspiration", { ok: number; error: number }>;
  byAgent: Array<{ backendId: string; agentId: string; ok: number; error: number }>;
  complete: boolean;
}

export interface DashboardSummary {
  generatedAt: number;
  /** 服务端实际使用的「今日 0 点」（本地时区），UI 与 smoke 都以它为准。 */
  sinceMs: number;
  status: BackendStatus[];
  /** 已跨后端合并、startedAt 降序、截断到 runsLimit。 */
  runs: DashboardRunEntry[];
  running: DashboardBackendSection<DashboardRunningItem>[];
  approvals: DashboardBackendSection<DashboardApprovalItem>[];
  artifacts: DashboardBackendSection<DashboardArtifactItem>[];
  usage: DashboardUsageEntry[];
  /** 统一活动流首屏（默认筛选第一页）；活动层失败时缺省（summary 本身照常）。 */
  activityPage?: DashboardActivityPage;
  runStats?: DashboardRunStats;
  taskStats?: DashboardTaskStats;
}

export type DashboardLiveWork = Pick<DashboardSummary, "generatedAt" | "running" | "approvals">;

export type InspirationStatus = 'saved' | 'queued' | 'starting' | 'running' | 'waiting_input' | 'waiting_approval' | 'completed' | 'failed' | 'canceled' | 'interrupted' | 'skipped' | 'unknown';
export type InspirationFilter = 'all' | 'saved' | 'active' | 'result' | 'favorite' | 'archived';
export interface InspirationExecution {
  id: string; ideaId: string; runId: string; profileId: string | null; agentId: string; backendId: string;
  workspace: string | null; sessionKey: string | null; sessionHref?: string | null; ideaRevision: number;
  createdAt: number; retryOf: string | null; status: InspirationStatus;
  resultSummary: string | null; errorCode: string | null; finishedAt: number | null;
  attention: { request: InteractiveRequestV1; active: boolean; occurredAt: number;
    command?: string | null; cwd?: string | null; details?: string | null } | null;
}
export interface InspirationAttachment {
  id: string; name: string; mimeType: string; size: number;
  /** UTF-16 position in the note body; omitted on legacy attachments. */
  textOffset?: number;
}
export interface InspirationIdea {
  id: string; body: string; title: string | null; revision: number; favorite: boolean;
  paperTone?: number;
  attachments?: InspirationAttachment[];
  archivedAt: number | null; acceptedAt: number | null; createdAt: number; updatedAt: number;
  status: InspirationStatus; latestExecution: InspirationExecution | null;
}
export interface InspirationPageResult {
  items: InspirationIdea[]; total: number; hasMore: boolean; nextCursor: string | null;
}
export interface InspirationExecutionsResult {
  executions: InspirationExecution[]; total: number; hasMore: boolean; nextCursor: string | null;
}
export interface InspirationAgent {
  id: string; name: string; backendId: string; backendName: string;
  capabilities: { execute: boolean; session: boolean; respond: boolean; cancel: boolean; reason: string | null };
}
export interface InspirationDockAgent extends InspirationAgent {
  executionCount: number;
}
export type InspirationPatch = Partial<{ body: string; title: string | null; favorite: boolean; archived: boolean; accepted: boolean; attachments: InspirationAttachment[] }>;
export interface InspirationGrowthSettings {
  revision: number; enabled: boolean; executors: Array<{ agentId: string; backendId: string }>;
}
export interface InspirationGrowthResult {
  settings: InspirationGrowthSettings;
  failures: Array<{ ideaId: string; title: string; runId: string | null; attempts: number; errorCode: string }>;
  errorCode: string | null;
}
export interface InspirationStartInput {
  operationId: string; expectedRevision: number; agentId: string; backendId: string;
  instruction: string; workspace: string | null;
}
