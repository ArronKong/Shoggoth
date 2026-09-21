import type {
  InteractiveApprovalChoice,
  DesktopProductTelemetryBridge,
  UnifiedCronJob,
  ChatCapabilities,
  ChatCacheScope,
  SlashCatalogResponse,
  SlashExecResult,
  CronRun,
  CronDelivery,
  CronRunTrajectory,
  CronJobInput,
  UnifiedModel,
  ModelCatalogSnapshot,
  ModelAuthProfilesResponse,
  ModelCatalogWireResponse,
  ModelChangeCapabilities,
  PendingModelChange,
  ModelChangeSpec,
  ModelChangePreview,
  ModelChangeApplyResult,
  AuxiliaryModels,
  HermesModelSettings,
  MoaConfig,
  StaleAuxSlot,
  CustomEndpointsSnapshot,
  CustomEndpointInput,
  CustomEndpointValidation,
  ModelConfig,
  AddModelSpec,
  ProviderCredential,
  ProviderDirectory,
  EnvVar,
  OAuthProvidersSnapshot,
  OAuthStartSession,
  UnifiedSkill,
  BackendSkillUsage,
  UsageSeries,
  UsageBreakdown,
  TaskBoard,
  FederatedTaskBoard,
  FederatedKanbanProject,
  CanonicalKanbanStatus,
  TaskDiagnosticsRow,
  KanbanBoard,
  Orchestration,
  TaskAttachment,
  TaskBoardConfig,
  TaskHomeChannel,
  TaskLog,
  TaskModelOptions,
  BoardProfile,
  BulkTaskPatch,
  BulkTaskResult,
  UnifiedTask,
  UnifiedTaskDetail,
  TaskInput,
  WorkboardEngine,
  WorkboardRunMode,
  TaskRunResult,
  WbDispatchSummary,
  CliTool,
  CliCategory,
  CliInfo,
  BackendCliUsage,
  UnifiedAgent,
  UnifiedAgentDetail,
  AgentInput,
  AgentChannel,
  SessionArchive,
  SessionArtifactsResult,
  GlobalChatSearchResult,
  SessionPreview,
  EnvironmentInventory,
  SessionAdvancedDescription,
  SessionBranchesResult,
  SessionForkResult,
  SessionBoardOp,
  SessionBoardResult,
  BackendStatus,
  BackendDescriptor,
  BackendVersionStatus,
  BackendSelfUpdate,
  StandingGrantList,
  StandingGrantRevokeResult,
  AppConfig,
  ConnTestResult,
  DashboardSummary,
  DashboardLiveWork,
  DashboardActivityPage,
  DashboardArtifactItem,
  OpenclawHostInfo,
  GatewayStartResult,
  DiscoveredGateway,
  LanDiscoveryState,
  ShoggothProductStatus,
  ShoggothStopImpact,
  ShoggothProviderConfiguration,
  ShoggothProviderConfigurationResult,
  ShoggothProviderSnapshot,
  ShoggothChatGptModels,
  RuntimeAccountSnapshot,
  RuntimeAccountDetail,
  RuntimeAccountAuth,
  RuntimeAccountStorage,
  LegacyRuntimeHomeSummary,
  LegacyRuntimeHomeCleanupPlan,
  LegacyRuntimeHomeCleanupResult,
  RuntimeBackupSummary,
  RuntimeBackupCleanupPlan,
  RuntimeBackupCleanupResult,
  BackendRunDetail,
  ShoggothRunDetail,
} from "../types";
import { isVisibleCronJob } from "../lib/cronVisibility";

// All management calls go to the loopback REST plane served by static-server.js.
// Same origin as the embedding iframe, so relative paths just work.
const BASE = "/__api/cron/jobs";

// REST 错误只接收服务端公开协议字段，避免 UI 意外依赖内部异常对象。
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly stage?: string;
  readonly field?: string;
  readonly details?: unknown;
  readonly safeBlockers?: Array<{ code: string; scope?: string }>;
  readonly canForce?: boolean;
  readonly safeReferences?: Array<{
    store: string;
    referenceKey?: string;
    scope?: string;
    agent?: string;
    profile?: string;
  }>;

  constructor(message: string, options: {
    status: number;
    code?: string;
    stage?: string;
    field?: string;
    details?: unknown;
    safeBlockers?: ApiError["safeBlockers"];
    canForce?: boolean;
    safeReferences?: ApiError["safeReferences"];
  }) {
    super(message);
    this.name = "ApiError";
    this.status = options.status;
    this.code = options.code;
    this.stage = options.stage;
    this.field = options.field;
    this.details = options.details;
    this.safeBlockers = options.safeBlockers;
    this.canForce = options.canForce;
    this.safeReferences = options.safeReferences;
  }
}

// 所有 JSON 请求共用结构化错误映射，调用方可以稳定定位字段与阶段。
async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    /* leave data = {} */
  }
  if (!res.ok) {
    const source = data && typeof data === "object" ? data as Record<string, unknown> : {};
    const safeBlockers = Array.isArray(source.blockers)
      ? source.blockers.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const blocker = item as Record<string, unknown>;
        if (typeof blocker.code !== "string") return [];
        return [{
          code: blocker.code,
          ...(typeof blocker.scope === "string" ? { scope: blocker.scope } : {}),
        }];
      })
      : undefined;
    const safeReferences = Array.isArray(source.references)
      ? source.references.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const reference = item as Record<string, unknown>;
        if (typeof reference.store !== "string") return [];
        return [{
          store: reference.store,
          ...(typeof reference.referenceKey === "string" ? { referenceKey: reference.referenceKey } : {}),
          ...(typeof reference.scope === "string" ? { scope: reference.scope } : {}),
          ...(typeof reference.agent === "string" ? { agent: reference.agent } : {}),
          ...(typeof reference.profile === "string" ? { profile: reference.profile } : {}),
        }];
      })
      : undefined;
    const msg = typeof source.error === "string" ? source.error : `HTTP ${res.status}`;
    throw new ApiError(msg, {
      status: res.status,
      ...(typeof source.code === "string" ? { code: source.code } : {}),
      ...(typeof source.stage === "string" ? { stage: source.stage } : {}),
      ...(typeof source.field === "string" ? { field: source.field } : {}),
      ...(Object.prototype.hasOwnProperty.call(source, "details") ? { details: source.details } : {}),
      ...(safeBlockers ? { safeBlockers } : {}),
      ...(typeof source.canForce === "boolean" ? { canForce: source.canForce } : {}),
      ...(safeReferences ? { safeReferences } : {}),
    });
  }
  return data as T;
}

// Cron ids may contain "/" (OpenClaw) and ":" (all backends) — they ride in
// ?id= (never a path segment, ARCHITECTURE §9), with sub-resources as ?action=.
function jobUrl(id: string, action = ""): string {
  const qs = new URLSearchParams({ id });
  if (action) qs.set("action", action);
  return `${BASE}?${qs.toString()}`;
}

export interface CronListFilters {
  backend?: string;
  query?: string;
  agentIds?: string[];
  enabled?: "all" | "enabled" | "disabled";
  scheduleKind?: "all" | "cron" | "every" | "at" | "on-exit" | "stream";
  lastStatus?: string;
  sortBy?: "nextRunAt" | "lastRunAt" | "name";
  sortDir?: "asc" | "desc";
}

export interface CronRunsFilters {
  status?: string;
  deliveryStatus?: string;
  query?: string;
  limit?: number;
  offset?: number;
  sortDir?: "asc" | "desc";
}

// 明确列出把 "all" 当未筛选哨兵的枚举字段，不能误伤 query 字面搜索词。
const ALL_SENTINEL_FIELDS = new Set(["backend", "enabled", "scheduleKind", "lastStatus", "status", "deliveryStatus"]);

// 所有 Cron 查询共用同一套编码规则，避免列表与运行记录对 query="all" 解释不一致。
function appendSearchParams(params: URLSearchParams, input: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") continue;
    // 多选筛选编码成逗号分隔；空数组等于没筛，不进 query（也不换缓存键）。
    if (Array.isArray(value)) {
      if (value.length) params.set(key, value.join(","));
      continue;
    }
    if (value === "all" && ALL_SENTINEL_FIELDS.has(key)) continue;
    params.set(key, String(value));
  }
}

// 统一把筛选条件编码到 query string，避免页面层拼 URL。
function searchParams(input: Record<string, unknown>): string {
  const params = new URLSearchParams();
  appendSearchParams(params, input);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export async function listCronJobs(filters: CronListFilters = {}): Promise<UnifiedCronJob[]> {
  const { jobs } = await jsonFetch<{ jobs: UnifiedCronJob[] }>(
    `${BASE}${searchParams({ ...filters })}`,
  );
  return (jobs || []).filter(isVisibleCronJob);
}

export async function getCronJobDetail(id: string): Promise<UnifiedCronJob> {
  const { job } = await jsonFetch<{ job: UnifiedCronJob }>(jobUrl(id, "detail"));
  return job;
}

export async function setCronEnabled(id: string, enabled: boolean): Promise<void> {
  await jsonFetch<{ job: UnifiedCronJob }>(jobUrl(id), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

export async function runCronJob(id: string, mode: "force" | "due" = "force"): Promise<void> {
  await jsonFetch<{ job: UnifiedCronJob | null }>(jobUrl(id, "run"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
}

export async function createCronJob(spec: CronJobInput): Promise<UnifiedCronJob> {
  const { job } = await jsonFetch<{ job: UnifiedCronJob }>(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(spec),
  });
  return job;
}

export async function updateCronJob(
  id: string,
  patch: Partial<CronJobInput>,
): Promise<UnifiedCronJob> {
  const { job } = await jsonFetch<{ job: UnifiedCronJob }>(jobUrl(id), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return job;
}

export async function deleteCronJob(id: string): Promise<void> {
  await jsonFetch(jobUrl(id), { method: "DELETE" });
}

export async function getCronRuns(id: string, filters: CronRunsFilters = {}): Promise<CronRun[]> {
  const qs = new URLSearchParams({ id, action: "runs" });
  appendSearchParams(qs, { ...filters });
  const { runs } = await jsonFetch<{ runs: CronRun[] }>(`${BASE}?${qs.toString()}`);
  return runs || [];
}

// Delivered content for the calendar's task-click modal. Without atMs: the
// latest run. With atMs (clicked occurrence epoch ms): the run that fired for
// that specific occurrence, so older calendar slots show their own report.
// R342:单次运行的 Agent Trajectory;sessionKey 来自 delivery/runs 响应。
export async function getCronRunTrajectory(id: string, sessionKey: string, runId?: string): Promise<CronRunTrajectory> {
  const qs = new URLSearchParams({ id, action: "trajectory", sessionKey });
  if (runId) qs.set("runId", runId);
  return jsonFetch<CronRunTrajectory>(`${BASE}?${qs.toString()}`);
}

export async function getCronLatestDelivery(id: string, atMs?: number): Promise<CronDelivery> {
  const at = typeof atMs === "number" ? `&at=${Math.round(atMs)}` : "";
  return jsonFetch<CronDelivery>(`${jobUrl(id, "delivery")}${at}`);
}

// Model catalog for one backend (the 模型 tab-switch page).
export async function listModels(backend?: string): Promise<UnifiedModel[]> {
  const qs = backend ? `?backend=${encodeURIComponent(backend)}` : "";
  const { models } = await jsonFetch<{ models: UnifiedModel[] }>(`/__api/models${qs}`);
  return models || [];
}

const CATALOG_REVISION_RE = /^[0-9a-f]{64}$/;

// wire 到快照只能在 API 边界完成，store 与组件不自行伪造 verifiedAt/backendId。
export function toModelCatalogSnapshot(
  backend: string,
  wire: ModelCatalogWireResponse,
  now = Date.now(),
): ModelCatalogSnapshot {
  if (!backend || !CATALOG_REVISION_RE.test(String(wire?.catalogRevision || ""))) {
    throw new Error("模型目录 revision 无效");
  }
  if (!Number.isFinite(now) || !Array.isArray(wire.models)) {
    throw new Error("模型目录响应缺少完整 models");
  }
  const models = wire.models.map((raw) => {
    if (!raw || typeof raw !== "object"
      || typeof raw.id !== "string" || !raw.id.trim()
      || typeof raw.name !== "string" || !raw.name.trim()
      || typeof raw.provider !== "string" || !raw.provider.trim()) {
      throw new Error("模型目录包含非法条目");
    }
    return { ...raw, backendId: backend };
  });
  return {
    backendId: backend,
    catalogRevision: wire.catalogRevision,
    models,
    verifiedAt: now,
  };
}

// 读取时始终由服务端 fresh revalidate；knownRevision 只压缩相同内容的响应体。
export async function getModelCatalog(
  backend: string,
  knownRevision?: string,
): Promise<ModelCatalogWireResponse> {
  const params = new URLSearchParams({ backend });
  if (knownRevision) params.set("knownRevision", knownRevision);
  return jsonFetch<ModelCatalogWireResponse>(`/__api/models?${params.toString()}`);
}

// 能力读取不创建 journal，也不会触发模型变更 preview。
export async function getModelChangeCapabilities(backend: string): Promise<ModelChangeCapabilities> {
  return jsonFetch<ModelChangeCapabilities>(
    `/__api/models/config/capabilities?backend=${encodeURIComponent(backend)}`,
  );
}

/** 授权登录 provider 的凭证 profile 管理（脱敏列表 / 换 key / 删除授权）。 */
export async function listModelAuthProfiles(backend: string): Promise<ModelAuthProfilesResponse> {
  return jsonFetch<ModelAuthProfilesResponse>(
    `/__api/models/auth-profiles?backend=${encodeURIComponent(backend)}`,
  );
}

export async function setModelAuthProfileKey(
  backend: string,
  provider: string,
  apiKey: string,
): Promise<{ ok: boolean; id: string; activation?: { kind: string; available?: boolean } | null }> {
  return jsonFetch(`/__api/models/auth-profiles?backend=${encodeURIComponent(backend)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, apiKey }),
  });
}

export async function deleteModelAuthProfile(
  backend: string,
  id: string,
): Promise<{ ok: boolean; id: string; activation?: { kind: string; available?: boolean } | null }> {
  return jsonFetch(
    `/__api/models/auth-profiles?backend=${encodeURIComponent(backend)}&id=${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

/** config-only 保存后的显式生效动作（OpenClaw = 重启网关刷新可用模型目录）。 */
export async function activateModelConfig(backend: string): Promise<{ ok: boolean; restarted?: boolean }> {
  return jsonFetch<{ ok: boolean; restarted?: boolean }>(
    `/__api/models/config/activate?backend=${encodeURIComponent(backend)}`,
    { method: "POST" },
  );
}

/** 读取可由同一 operationId 续提的非终态模型变更。 */
export async function getPendingModelChanges(backend: string): Promise<PendingModelChange[]> {
  const response = await jsonFetch<{ operations?: PendingModelChange[] }>(
    `/__api/models/config/pending?backend=${encodeURIComponent(backend)}`,
  );
  return Array.isArray(response.operations) ? response.operations : [];
}

// 保存前先预览真实引用与 blocker，返回的 token 与当前指纹绑定。
export async function previewModelChange(
  backend: string,
  spec: ModelChangeSpec,
): Promise<ModelChangePreview> {
  return jsonFetch<ModelChangePreview>(
    `/__api/models/config/preview?backend=${encodeURIComponent(backend)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(spec),
    },
  );
}

// 应用请求复用 operationId，网络重试不会生成第二次逻辑变更。
export async function applyModelChange(
  backend: string,
  spec: ModelChangeSpec,
  previewToken: string,
  operationId: string,
): Promise<ModelChangeApplyResult> {
  const result = await jsonFetch<Omit<ModelChangeApplyResult, "catalog"> & {
    catalog?: ModelCatalogWireResponse;
  }>(
    `/__api/models/config/model?backend=${encodeURIComponent(backend)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...spec, previewToken, operationId }),
    },
  );
  const { catalog, ...rest } = result;
  return {
    ...rest,
    operationId: result.operationId || operationId,
    ...(catalog ? { catalog: toModelCatalogSnapshot(backend, catalog) } : {}),
  };
}

// 兼容写入口也只在 API 边界把 coordinator 的 wire catalog 认证为前端快照。
async function legacyModelMutation(
  backend: string,
  url: string,
  init: RequestInit,
  requestedOperationId = "",
): Promise<ModelChangeApplyResult> {
  const result = await jsonFetch<Omit<ModelChangeApplyResult, "catalog"> & {
    catalog?: ModelCatalogWireResponse;
  }>(url, init);
  const { catalog, ...rest } = result;
  return {
    ...rest,
    operationId: result.operationId || requestedOperationId,
    ...(catalog ? { catalog: toModelCatalogSnapshot(backend, catalog) } : {}),
  };
}

// Active model(s) per scope (agent/profile). byScope maps agentId → modelId.
export async function getActiveModel(
  backend: string,
): Promise<{
  byScope?: Record<string, string>;
  providerByScope?: Record<string, string>;
  active?: string;
}> {
  return jsonFetch(`/__api/models/active?backend=${encodeURIComponent(backend)}`);
}
// Set the active model for a scope (Hermes profile). scope = agent id.
export async function setActiveModel(
  backend: string,
  modelId: string,
  opts: { scope?: string; provider?: string } = {},
): Promise<void> {
  await jsonFetch(`/__api/models/active?backend=${encodeURIComponent(backend)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelId, ...opts }),
  });
}

// Auxiliary per-task model slots (Hermes-only). provider "auto" = use main model.
export async function getAuxiliaryModels(backend: string, profile?: string): Promise<AuxiliaryModels> {
  const suffix = profile ? `&profile=${encodeURIComponent(profile)}` : "";
  return jsonFetch(`/__api/models/auxiliary?backend=${encodeURIComponent(backend)}${suffix}`);
}
export async function setAuxiliaryModel(
  backend: string,
  task: string,
  provider?: string,
  model?: string,
  profile?: string,
): Promise<void> {
  await jsonFetch(`/__api/models/auxiliary?backend=${encodeURIComponent(backend)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task, provider, model, profile }),
  });
}

// ---- Hermes 模型设置整合面（官方「模型」+「提供方」，R286）----

function settingsPost<T>(backend: string, action: string, body: Record<string, unknown>): Promise<T> {
  return jsonFetch<T>(`/__api/models/settings/${action}?backend=${encodeURIComponent(backend)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// 聚合快照：主模型 + 全宇宙 provider 目录（含未配置）+ 辅助槽 + MoA + 默认参数 + 后备链。
export async function getModelSettings(backend: string, profile?: string): Promise<HermesModelSettings> {
  const suffix = profile ? `&profile=${encodeURIComponent(profile)}` : "";
  return jsonFetch(`/__api/models/settings?backend=${encodeURIComponent(backend)}${suffix}`);
}

// 应用主模型；响应带 staleAux（仍钉在其它 provider 的辅助槽）。
export function applyMainModel(
  backend: string,
  profile: string | undefined,
  provider: string,
  model: string,
): Promise<{ ok: boolean; provider: string; model: string; staleAux: StaleAuxSlot[] }> {
  return settingsPost(backend, "main", { profile, provider, model });
}

// 全局默认参数（agent.reasoning_effort / agent.service_tier）。
export function setModelDefaults(
  backend: string,
  profile: string | undefined,
  patch: { reasoningEffort?: string; serviceTier?: string },
): Promise<{ ok: boolean }> {
  return settingsPost(backend, "defaults", { profile, ...patch });
}

// fallback_providers 链整体替换（顺序即优先级；空数组=清空）。
export function setFallbackModels(
  backend: string,
  profile: string | undefined,
  entries: { provider: string; model: string }[],
): Promise<{ ok: boolean }> {
  return settingsPost(backend, "fallbacks", { profile, entries });
}

// MoA 配置整份保存，返回服务端权威结果。
export async function saveMoaConfig(
  backend: string,
  profile: string | undefined,
  config: MoaConfig,
): Promise<MoaConfig> {
  const { config: saved } = await jsonFetch<{ config: MoaConfig }>(
    `/__api/models/settings/moa?backend=${encodeURIComponent(backend)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile, config }),
    },
  );
  return saved;
}

// 新激活 provider 的推荐默认模型（失败回空 model，调用方回退目录第一个）。
export async function getRecommendedDefaultModel(
  backend: string,
  provider: string,
  profile?: string,
): Promise<{ provider: string; model: string; freeTier: boolean | null }> {
  const suffix = profile ? `&profile=${encodeURIComponent(profile)}` : "";
  return jsonFetch(
    `/__api/models/settings/recommended?backend=${encodeURIComponent(backend)}&provider=${encodeURIComponent(provider)}${suffix}`,
  );
}

// ---- 自定义端点（OpenAI 兼容自建端点；官方 custom-endpoints，R286）----

export async function listCustomEndpoints(backend: string, profile?: string, options?: { refreshAuth?: boolean }): Promise<CustomEndpointsSnapshot> {
  const suffix = profile ? `&profile=${encodeURIComponent(profile)}` : "";
  const auth = options?.refreshAuth === false ? "&refreshAuth=false" : "";
  return jsonFetch(`/__api/models/endpoints?backend=${encodeURIComponent(backend)}${suffix}${auth}`);
}

export function saveCustomEndpoint(
  backend: string,
  profile: string | undefined,
  endpoint: CustomEndpointInput,
): Promise<CustomEndpointsSnapshot> {
  return jsonFetch(`/__api/models/endpoints?backend=${encodeURIComponent(backend)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile, ...endpoint }),
  });
}

export function validateCustomEndpoint(
  backend: string,
  profile: string | undefined,
  endpoint: CustomEndpointInput,
  signal?: AbortSignal,
): Promise<CustomEndpointValidation> {
  return jsonFetch(`/__api/models/endpoints/validate?backend=${encodeURIComponent(backend)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile, ...endpoint }),
    signal,
  });
}

export function activateCustomEndpoint(
  backend: string,
  profile: string | undefined,
  id: string,
): Promise<{ ok: boolean; provider: string; model: string }> {
  return jsonFetch(`/__api/models/endpoints/activate?backend=${encodeURIComponent(backend)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile, id }),
  });
}

export function deleteCustomEndpoint(
  backend: string,
  profile: string | undefined,
  id: string,
): Promise<CustomEndpointsSnapshot> {
  const suffix = profile ? `&profile=${encodeURIComponent(profile)}` : "";
  return jsonFetch(
    `/__api/models/endpoints?backend=${encodeURIComponent(backend)}&id=${encodeURIComponent(id)}${suffix}`,
    { method: "DELETE" },
  );
}

// Custom model config：自定义 provider 模型的增删（模型页）。
export async function getModelConfig(backend: string): Promise<ModelConfig> {
  return jsonFetch(`/__api/models/config?backend=${encodeURIComponent(backend)}`);
}
export async function addModelConfig(
  backend: string,
  spec: AddModelSpec,
  operationId?: string,
): Promise<ModelChangeApplyResult> {
  return legacyModelMutation(backend, `/__api/models/config?backend=${encodeURIComponent(backend)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // 旧新增入口同样传递显式幂等键，网络重试才能续提同一逻辑操作。
    body: JSON.stringify({ ...spec, ...(operationId ? { operationId } : {}) }),
  }, operationId);
}
export async function removeModelConfig(
  backend: string,
  providerKey: string,
  modelId: string,
  operationId?: string,
  force?: boolean,
): Promise<ModelChangeApplyResult> {
  return legacyModelMutation(
    backend,
    `/__api/models/config?backend=${encodeURIComponent(backend)}&provider=${encodeURIComponent(providerKey)}&id=${encodeURIComponent(modelId)}${operationId ? `&operationId=${encodeURIComponent(operationId)}` : ""}${force ? "&force=1" : ""}`,
    { method: "DELETE" },
    operationId,
  );
}
// Browser previews have no telemetry bridge and never fall back to HTTP/fetch.
export function getDesktopProductTelemetry(): DesktopProductTelemetryBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as { openclawDesktop?: { productTelemetry?: DesktopProductTelemetryBridge } })
    .openclawDesktop?.productTelemetry;
  return typeof bridge?.recordActivity === "function" ? bridge : null;
}

type DesktopSecretEnvelope<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } };

type DesktopSecretBridge = {
  revealModelProviderKey?: (
    backend: string,
    providerKey: string,
  ) => Promise<DesktopSecretEnvelope<{
    apiKey: string | null;
    baseUrl?: string;
    reason?: "none" | "env" | "managed" | "remote";
    envVar?: string;
  }>>;
  revealEnvVar?: (
    backend: string,
    key: string,
  ) => Promise<DesktopSecretEnvelope<{ value: string }>>;
  getComputerPermissions?: () => Promise<DesktopSecretEnvelope<{
    accessibility: boolean; screenRecording: boolean;
  }>>;
  requestComputerPermissions?: () => Promise<DesktopSecretEnvelope<{
    accessibility: boolean; screenRecording: boolean;
  }>>;
  openComputerScreenRecordingSettings?: () => Promise<DesktopSecretEnvelope<{ opened: boolean }>>;
};

function desktopSecretBridge(): DesktopSecretBridge | null {
  return (window as unknown as { openclawDesktop?: DesktopSecretBridge }).openclawDesktop || null;
}

function desktopSecretError(code: string, message: string): ApiError {
  return new ApiError(message, { status: 403, code });
}

// 取 provider 的 API Key 明文。loopback HTTP 不是权限边界，必须经 Electron preload。
export async function revealModelProviderKey(
  backend: string,
  providerKey: string,
  signal?: AbortSignal,
): Promise<{
  apiKey: string | null;
  baseUrl?: string;
  reason?: "none" | "env" | "managed" | "remote";
  envVar?: string;
}> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const reveal = desktopSecretBridge()?.revealModelProviderKey;
  if (!reveal) {
    throw desktopSecretError("DESKTOP_BRIDGE_REQUIRED", "仅桌面应用可读取凭据");
  }
  const result = await reveal(backend, providerKey);
  if (!result.ok) throw desktopSecretError(result.error.code, result.error.message);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return result.value;
}
// 更新 provider 的端点字段（apiKey 留空 = 不改；clearBaseUrl = 移除端点覆盖；
// renameTo = provider 整体改名,引用与凭证由后端同步迁移）。
export async function updateModelProvider(
  backend: string,
  providerKey: string,
  patch: { baseUrl?: string; apiKey?: string; api?: string; clearBaseUrl?: boolean; clearApiKey?: boolean; renameTo?: string },
  operationId?: string,
): Promise<ModelChangeApplyResult> {
  return legacyModelMutation(backend, `/__api/models/config?backend=${encodeURIComponent(backend)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerKey, ...patch, ...(operationId ? { operationId } : {}) }),
  }, operationId);
}
// 批量模型变更:草稿层一次提交(删除/目录改ID/目录新增,无凭证),合并为一次网关配置写。
export async function applyModelBatch(
  backend: string,
  items: Array<
    | { op: "delete"; providerKey: string; modelId: string }
    | { providerKey: string; sourceModelId?: string; model: { id: string } }
  >,
  operationId?: string,
  options?: { confirmReferences: true; force?: boolean; preservePrimaryRefs?: boolean },
): Promise<ModelChangeApplyResult> {
  return legacyModelMutation(backend, `/__api/models/config/batch?backend=${encodeURIComponent(backend)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items, ...(operationId ? { operationId } : {}), ...options }),
  }, operationId);
}
// provider 凭证池（轮换 key，脱敏）。source 说明 key 从哪来（env: / gh_cli / manual…）。
export async function listProviderCredentials(
  backend: string,
  providerKey: string,
): Promise<ProviderCredential[]> {
  const { entries } = await jsonFetch<{ entries: ProviderCredential[] }>(
    `/__api/models/credentials?backend=${encodeURIComponent(backend)}&provider=${encodeURIComponent(providerKey)}`,
  );
  return entries || [];
}
export async function removeProviderCredential(
  backend: string,
  providerKey: string,
  index: number,
): Promise<void> {
  await jsonFetch(
    `/__api/models/credentials?backend=${encodeURIComponent(backend)}&provider=${encodeURIComponent(providerKey)}&index=${index}`,
    { method: "DELETE" },
  );
}
// 删除整个 provider：config 类删配置条目，env 类清掉其凭证环境变量 + 池条目。
export async function removeModelProvider(
  backend: string,
  providerKey: string,
  operationId?: string,
  force?: boolean,
): Promise<ModelChangeApplyResult> {
  return legacyModelMutation(
    backend,
    `/__api/models/config?backend=${encodeURIComponent(backend)}&provider=${encodeURIComponent(providerKey)}${operationId ? `&operationId=${encodeURIComponent(operationId)}` : ""}${force ? "&force=1" : ""}`,
    { method: "DELETE" },
    operationId,
  );
}

// env / API keys (Hermes-only). list is redacted; reveal returns plaintext.
export async function listEnvVars(backend: string): Promise<EnvVar[]> {
  const { vars } = await jsonFetch<{ vars: EnvVar[] }>(`/__api/env?backend=${encodeURIComponent(backend)}`);
  return vars || [];
}
export async function setEnvVar(
  backend: string,
  key: string,
  value: string,
): Promise<{ ok?: boolean; activation?: { kind: string; available?: boolean } | null }> {
  return jsonFetch(`/__api/env?backend=${encodeURIComponent(backend)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
}
export async function deleteEnvVar(
  backend: string,
  key: string,
): Promise<{ ok?: boolean; activation?: { kind: string; available?: boolean } | null }> {
  return jsonFetch(`/__api/env?backend=${encodeURIComponent(backend)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
}
export async function revealEnvVar(backend: string, key: string): Promise<string> {
  const reveal = desktopSecretBridge()?.revealEnvVar;
  if (!reveal) {
    throw desktopSecretError("DESKTOP_BRIDGE_REQUIRED", "仅桌面应用可读取凭据");
  }
  const result = await reveal(backend, key);
  if (!result.ok) throw desktopSecretError(result.error.code, result.error.message);
  return result.value.value || "";
}
export async function validateProviderCredential(
  backend: string,
  key: string,
  value: string,
): Promise<{ supported: boolean; valid?: boolean; error?: string }> {
  return jsonFetch(`/__api/env/validate?backend=${encodeURIComponent(backend)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
}

// OAuth / 外部 CLI provider 登录。列表是 GET，其余动作 POST + JSON body。
function oauthPost<T>(backend: string, action: string, body: Record<string, unknown>): Promise<T> {
  return jsonFetch<T>(`/__api/oauth/${action}?backend=${encodeURIComponent(backend)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
export async function listOAuthProviders(backend: string): Promise<OAuthProvidersSnapshot> {
  const snap = await jsonFetch<OAuthProvidersSnapshot>(`/__api/oauth?backend=${encodeURIComponent(backend)}`);
  return { providers: snap.providers || [], profiles: snap.profiles || [] };
}
export function getProviderDirectory(backend: string): Promise<ProviderDirectory> {
  return jsonFetch<ProviderDirectory>(`/__api/models/provider-directory?backend=${encodeURIComponent(backend)}`);
}
export function disconnectOAuthProvider(backend: string, provider: string, profile?: string) {
  return oauthPost<{ ok: boolean; warnings?: string[] }>(backend, "disconnect", { provider, profile });
}
export function startOAuthLogin(backend: string, provider: string, profile?: string) {
  return oauthPost<OAuthStartSession>(backend, "start", { provider, profile });
}
export function submitOAuthCode(
  backend: string,
  provider: string,
  sessionId: string,
  code: string,
  profile?: string,
) {
  return oauthPost<{ ok: boolean; status: string; message: string }>(backend, "submit", {
    provider,
    sessionId,
    code,
    profile,
  });
}
export function pollOAuthSession(backend: string, provider: string, sessionId: string, profile?: string) {
  return oauthPost<{ status: string; errorMessage: string }>(backend, "poll", { provider, sessionId, profile });
}
export function cancelOAuthSession(backend: string, sessionId: string, profile?: string) {
  return oauthPost<{ ok: boolean }>(backend, "cancel", { sessionId, profile });
}
// external provider 的登录/断开命令：在系统终端里跑（host 能力，非 registry）。
// 只发 provider + kind——命令由服务端从 oauth 目录解析，前端不经手命令串。
export function runProviderCommandInTerminal(backend: string, provider: string, kind: "cli" | "disconnect") {
  return jsonFetch<{ ok: boolean; command: string }>("/__api/host/terminal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backend, provider, kind }),
  });
}

// token dashboard: fast daily series + slow by-model/by-agent rankings.
export async function getUsageSeries(backend: string, range?: string): Promise<UsageSeries | null> {
  const qs = new URLSearchParams({ backend });
  if (range) qs.set("range", range);
  const { series } = await jsonFetch<{ series: UsageSeries | null }>(
    `/__api/usage?${qs.toString()}`,
  );
  return series;
}
export async function getUsageBreakdown(backend: string, range?: string): Promise<UsageBreakdown | null> {
  const qs = new URLSearchParams({ backend });
  if (range) qs.set("range", range);
  const { breakdown } = await jsonFetch<{ breakdown: UsageBreakdown | null }>(
    `/__api/usage/breakdown?${qs.toString()}`,
  );
  return breakdown;
}

// Skill list for one backend (the Skills tab-switch page).
export async function listSkills(backend: string, agentId?: string): Promise<UnifiedSkill[]> {
  const qs = new URLSearchParams({ backend });
  if (agentId) qs.set("agentId", agentId);
  const { skills } = await jsonFetch<{ skills: UnifiedSkill[] }>(
    `/__api/skills?${qs.toString()}`,
  );
  return skills || [];
}

// Per-backend "which skills have agents actually loaded" aggregate (local
// backends only; others supported:false). Joined against listSkills() in the
// Skills page. Failure is silent — the overlay is optional decoration.
export async function getSkillUsage(): Promise<BackendSkillUsage[]> {
  try {
    const data = await jsonFetch<{ backends: BackendSkillUsage[] }>(`/__api/skills/usage`);
    return data.backends || [];
  } catch {
    return [];
  }
}

// Enable/disable + (OpenClaw) configure a skill.
export async function updateSkill(
  backend: string,
  name: string,
  patch: {
    enabled?: boolean;
    apiKey?: string;
    env?: Record<string, string>;
    id?: string;
    source?: "builtin" | "user";
    version?: string;
    expectedRevision?: number;
  },
  agentId?: string,
): Promise<void> {
  const qs = new URLSearchParams({ backend, name });
  if (agentId) qs.set("agentId", agentId);
  await jsonFetch(`/__api/skills?${qs.toString()}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export async function installSkill(
  backend: string,
  agentId?: string,
): Promise<{ canceled: boolean }> {
  return jsonFetch("/__api/skills/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backend, agentId }),
  });
}

export async function uninstallSkill(
  backend: string,
  skill: UnifiedSkill,
  agentId?: string,
): Promise<void> {
  const qs = new URLSearchParams({
    backend,
    name: skill.name,
    id: skill.id || "",
    source: skill.source || "user",
    version: skill.version || "",
    expectedRevision: String(skill.registryVersion || 0),
  });
  if (agentId) qs.set("agentId", agentId);
  await jsonFetch(`/__api/skills?${qs.toString()}`, { method: "DELETE" });
}

export async function previewSkill(
  backend: string,
  skill: UnifiedSkill,
  agentId?: string,
): Promise<{ content: string }> {
  const qs = new URLSearchParams({
    backend,
    name: skill.name,
    id: skill.id || "",
    source: skill.source || "user",
    version: skill.version || "",
  });
  if (agentId) qs.set("agentId", agentId);
  const { preview } = await jsonFetch<{ preview: { content: string } }>(
    `/__api/skills/preview?${qs.toString()}`,
  );
  return preview;
}

// Kanban board for one backend (the tasks tab-switch page). refreshDiagnostics =
// workboard manual refresh (recompute diagnostics before listing, official behavior).
export async function getTaskBoard(
  backend: string,
  opts?: { includeArchived?: boolean; board?: string; refreshDiagnostics?: boolean; readOnly?: boolean },
): Promise<TaskBoard> {
  const qs = new URLSearchParams({ backend });
  if (opts?.includeArchived) qs.set("archived", "1");
  if (opts?.board) qs.set("board", opts.board);
  if (opts?.refreshDiagnostics) qs.set("refreshDiagnostics", "1");
  // 旧客户端 hint；8.1 board reads 无条件保持纯读。
  if (opts?.readOnly) qs.set("readOnly", "1");
  const { board } = await jsonFetch<{ board: TaskBoard }>(`/__api/tasks?${qs.toString()}`);
  return board || { columns: [] };
}

export async function getFederatedTaskBoard(project?: string): Promise<FederatedTaskBoard> {
  const qs = new URLSearchParams();
  if (project) qs.set("project", project);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const { board } = await jsonFetch<{ board: FederatedTaskBoard }>(`/__api/tasks/federated${suffix}`);
  return board;
}

export async function createFederatedKanbanProject(spec: {
  name: string;
  slug?: string;
  description?: string;
}): Promise<FederatedKanbanProject> {
  const { project } = await jsonFetch<{ project: FederatedKanbanProject }>("/__api/tasks/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(spec),
  });
  return project;
}

export async function deleteFederatedKanbanProject(project: string): Promise<{
  key: string;
  deletedTasks: number;
  deletedBoards: number;
}> {
  const { result } = await jsonFetch<{ result: { key: string; deletedTasks: number; deletedBoards: number } }>(
    `/__api/tasks/projects/${encodeURIComponent(project)}`, {
      method: "DELETE",
    },
  );
  return result;
}

export async function createFederatedTask(
  project: string,
  agentKey: string,
  task: TaskInput & { status?: CanonicalKanbanStatus },
): Promise<UnifiedTask> {
  const { task: created } = await jsonFetch<{ task: UnifiedTask }>("/__api/tasks/federated", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project, agentKey, task }),
  });
  return created;
}

export async function moveFederatedTask(
  task: UnifiedTask,
  status: CanonicalKanbanStatus,
  position?: number,
  completion?: { result?: string; summary?: string; note?: string },
): Promise<void> {
  await jsonFetch("/__api/tasks/federated/move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task, status, position, completion }),
  });
}

// Board-level dispatch. Hermes nudge → {claimed, spawned, ...}; OpenClaw workboard
// (workboard.cards.dispatch) → official summary {started, failures, promoted, ...}.
export async function nudgeDispatcher(
  backend: string,
  opts?: { max?: number; dryRun?: boolean },
): Promise<{ claimed?: number; spawned?: number; spawnErrors?: number; oldestReadyAgeSeconds?: number } & Partial<WbDispatchSummary>> {
  const { result } = await jsonFetch<{ result: { claimed?: number; spawned?: number; spawnErrors?: number; oldestReadyAgeSeconds?: number } & Partial<WbDispatchSummary> }>(
    `/__api/tasks?backend=${encodeURIComponent(backend)}&action=dispatch`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts || {}) },
  );
  return result;
}

// Hermes multi-board (Slice 4).
export async function getBoards(backend: string): Promise<KanbanBoard[]> {
  const { boards } = await jsonFetch<{ boards: KanbanBoard[] }>(`/__api/tasks/boards?backend=${encodeURIComponent(backend)}`);
  return boards || [];
}
export async function createBoard(
  backend: string,
  spec: { slug: string; name?: string; description?: string; icon?: string; defaultWorkdir?: string; switch?: boolean },
): Promise<{ slug: string; name: string }> {
  const { board } = await jsonFetch<{ board: { slug: string; name: string } }>(
    `/__api/tasks/boards?backend=${encodeURIComponent(backend)}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(spec) },
  );
  return board;
}
export async function switchBoard(backend: string, slug: string): Promise<void> {
  await jsonFetch(`/__api/tasks/boards/${encodeURIComponent(slug)}/switch?backend=${encodeURIComponent(backend)}`, { method: "POST" });
}
export async function updateBoard(
  backend: string,
  slug: string,
  patch: { name?: string; description?: string; icon?: string; defaultWorkdir?: string },
): Promise<void> {
  await jsonFetch(`/__api/tasks/boards/${encodeURIComponent(slug)}?backend=${encodeURIComponent(backend)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
  });
}
export async function deleteBoard(backend: string, slug: string): Promise<void> {
  await jsonFetch(`/__api/tasks/boards/${encodeURIComponent(slug)}?backend=${encodeURIComponent(backend)}`, { method: "DELETE" });
}

// 看板前端偏好（默认租户 / 分泳道 / 显示归档 / 渲染 markdown）。取不到 = null，UI 用自身默认。
export async function getTaskBoardConfig(backend: string): Promise<TaskBoardConfig | null> {
  const { config } = await jsonFetch<{ config: TaskBoardConfig | null }>(
    `/__api/tasks/config?backend=${encodeURIComponent(backend)}`,
  );
  return config ?? null;
}
// 任务级模型覆盖的候选目录；空 providers → UI 退化成自由文本输入（官方同款）。
export async function getTaskModelOptions(backend: string): Promise<TaskModelOptions> {
  const { options } = await jsonFetch<{ options: TaskModelOptions }>(
    `/__api/tasks/model-options?backend=${encodeURIComponent(backend)}`,
  );
  return options || { providers: [] };
}
// 编排 profile 名单 + 描述编辑 + ⚗ 自动生成（描述指导分解器路由）。
export async function getBoardProfiles(backend: string): Promise<BoardProfile[]> {
  const { profiles } = await jsonFetch<{ profiles: BoardProfile[] }>(
    `/__api/tasks/profiles?backend=${encodeURIComponent(backend)}`,
  );
  return profiles || [];
}
export async function updateBoardProfile(backend: string, name: string, description: string): Promise<void> {
  await jsonFetch(`/__api/tasks/profiles/${encodeURIComponent(name)}?backend=${encodeURIComponent(backend)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ description }),
  });
}
export async function describeBoardProfileAuto(
  backend: string, name: string, overwrite = true,
): Promise<{ ok: boolean; reason?: string; description?: string }> {
  const { result } = await jsonFetch<{ result: { ok: boolean; reason?: string; description?: string } }>(
    `/__api/tasks/profiles/${encodeURIComponent(name)}/describe-auto?backend=${encodeURIComponent(backend)}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ overwrite }) },
  );
  return result;
}

// 附件。上传把文件字节直接当请求体发（服务端再组 multipart 给上游）；
// 下载走浏览器原生导航（attachmentUrl），无需在 JS 里搬二进制。
export async function listTaskAttachments(backend: string, id: string, board?: string): Promise<TaskAttachment[]> {
  const qs = new URLSearchParams({ backend, id });
  if (board) qs.set("board", board);
  const { attachments } = await jsonFetch<{ attachments: TaskAttachment[] }>(`/__api/tasks/attachments?${qs.toString()}`);
  return attachments || [];
}
export async function uploadTaskAttachment(
  backend: string, id: string, file: File, board?: string,
): Promise<TaskAttachment> {
  const qs = new URLSearchParams({ backend, id, filename: file.name, contentType: file.type || "application/octet-stream" });
  if (board) qs.set("board", board);
  const { attachment } = await jsonFetch<{ attachment: TaskAttachment }>(`/__api/tasks/attachments?${qs.toString()}`, {
    method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file,
  });
  return attachment;
}
export function taskAttachmentUrl(backend: string, attachmentId: string, board?: string): string {
  const qs = new URLSearchParams({ backend });
  if (board) qs.set("board", board);
  return `/__api/tasks/attachments/${encodeURIComponent(attachmentId)}?${qs.toString()}`;
}
export async function deleteTaskAttachment(backend: string, attachmentId: string, board?: string): Promise<void> {
  await jsonFetch(taskAttachmentUrl(backend, attachmentId, board), { method: "DELETE" });
}

// 每任务的 home 频道通知订阅（无已配置平台时返回空数组 → 整区不渲染）。
export async function getTaskHomeChannels(backend: string, id: string, board?: string): Promise<TaskHomeChannel[]> {
  const qs = new URLSearchParams({ backend, id });
  if (board) qs.set("board", board);
  const { channels } = await jsonFetch<{ channels: TaskHomeChannel[] }>(`/__api/tasks/home-channels?${qs.toString()}`);
  return channels || [];
}
export async function setTaskHomeSubscription(
  backend: string, id: string, platform: string, subscribed: boolean, board?: string,
): Promise<void> {
  const qs = new URLSearchParams({ backend, id, platform });
  if (board) qs.set("board", board);
  await jsonFetch(`/__api/tasks/home-channels?${qs.toString()}`, { method: subscribed ? "POST" : "DELETE" });
}

// Hermes orchestration (Slice 5).
export async function getOrchestration(backend: string): Promise<Orchestration> {
  const { orchestration } = await jsonFetch<{ orchestration: Orchestration }>(`/__api/tasks/orchestration?backend=${encodeURIComponent(backend)}`);
  return orchestration;
}
export async function setOrchestration(backend: string, patch: Partial<Orchestration>): Promise<Orchestration> {
  const { orchestration } = await jsonFetch<{ orchestration: Orchestration }>(
    `/__api/tasks/orchestration?backend=${encodeURIComponent(backend)}`,
    { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) },
  );
  return orchestration;
}

// Detail-drawer extras (Slice 6). Link ops carry parent/child in the body; the URL
// id= is only there to satisfy the task-action route shape. 可选尾参 board：
// Hermes 多板的目标板 slug（KAN-005/006），缺省 = 服务端 current 板。
export async function addTaskLink(backend: string, parent: string, child: string, board?: string): Promise<void> {
  await jsonFetch(`${taskUrl(backend, parent, board)}&action=link`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parent, child }),
  });
}
export async function removeTaskLink(backend: string, parent: string, child: string, board?: string): Promise<void> {
  await jsonFetch(`${taskUrl(backend, parent, board)}&action=unlink`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parent, child }),
  });
}
export async function reassignTask(backend: string, id: string, assignee: string, reclaim?: boolean, board?: string): Promise<void> {
  await jsonFetch(`${taskUrl(backend, id, board)}&action=reassign`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assignee, reclaim }),
  });
}
export async function reclaimTask(backend: string, id: string, board?: string): Promise<void> {
  await jsonFetch(`${taskUrl(backend, id, board)}&action=reclaim`, { method: "POST" });
}
export async function getTaskLog(backend: string, id: string, board?: string): Promise<TaskLog> {
  const { log } = await jsonFetch<{ log: TaskLog }>(`${taskUrl(backend, id, board)}&action=log`);
  return log || { content: "", exists: false };
}
export async function bulkUpdateTasks(
  backend: string,
  ids: string[],
  patch: BulkTaskPatch,
  board?: string,
): Promise<BulkTaskResult> {
  const { result } = await jsonFetch<{ result: BulkTaskResult }>(
    `${taskUrl(backend, undefined, board)}&action=bulk`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids, patch }) },
  );
  return result;
}
export async function bulkDeleteTasks(backend: string, ids: string[], board?: string): Promise<BulkTaskResult> {
  const { result } = await jsonFetch<{ result: BulkTaskResult }>(
    `${taskUrl(backend, undefined, board)}&action=bulkDelete`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) },
  );
  return result;
}

// Task item ops use ?backend=&id= (OpenClaw ids contain "/").
function taskUrl(backend: string, id?: string, board?: string): string {
  const qs = new URLSearchParams({ backend });
  if (id) qs.set("id", id);
  if (board) qs.set("board", board);
  return `/__api/tasks?${qs.toString()}`;
}
export async function getTask(backend: string, id: string, board?: string): Promise<UnifiedTaskDetail> {
  const { task } = await jsonFetch<{ task: UnifiedTaskDetail }>(taskUrl(backend, id, board));
  return task;
}
export async function createTask(
  backend: string,
  spec: TaskInput,
  board?: string,
): Promise<UnifiedTaskDetail> {
  const { task } = await jsonFetch<{ task: UnifiedTaskDetail }>(taskUrl(backend, undefined, board), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Native boards bind by body.boardId; Hermes binds by the query-string board
    // option. Send the same opaque identity through both protocol boundaries so
    // descriptor-selected backends can consume the representation they own.
    body: JSON.stringify({ ...spec, ...(board ? { boardId: board } : {}) }),
  });
  return task;
}
export async function updateTask(
  backend: string,
  id: string,
  patch: TaskInput,
  board?: string,
): Promise<UnifiedTaskDetail> {
  const { task } = await jsonFetch<{ task: UnifiedTaskDetail }>(taskUrl(backend, id, board), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return task;
}
export async function deleteTask(backend: string, id: string, board?: string): Promise<void> {
  await jsonFetch(taskUrl(backend, id, board), { method: "DELETE" });
}
export async function moveTask(
  backend: string,
  id: string,
  status: string,
  position: number,
  board?: string,
  // 移到 done 时的完成摘要（写进 result+summary，官方强制要求）。
  completion?: { result?: string; summary?: string },
): Promise<UnifiedTaskDetail> {
  const { task } = await jsonFetch<{ task: UnifiedTaskDetail }>(`${taskUrl(backend, id, board)}&action=move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, position, ...(completion || {}) }),
  });
  return task;
}
export async function archiveTask(backend: string, id: string, archived = true, board?: string): Promise<void> {
  await jsonFetch(`${taskUrl(backend, id, board)}&action=archive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archived }),
  });
}
export async function runTask(
  backend: string,
  id: string,
  engine: WorkboardEngine | undefined,
  mode: WorkboardRunMode,
  options?: { retryOf?: string },
): Promise<TaskRunResult> {
  const { result } = await jsonFetch<{ result: TaskRunResult }>(`${taskUrl(backend, id)}&action=run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ engine, mode, ...(options?.retryOf ? { retryOf: options.retryOf } : {}) }),
  });
  return result || {};
}
// Append a comment (Hermes kanban).
export async function addTaskComment(
  backend: string,
  id: string,
  body: string,
  author?: string,
  board?: string,
): Promise<void> {
  await jsonFetch(`${taskUrl(backend, id, board)}&action=comment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body, author }),
  });
}
// 板级诊断列表（GAP-002）。后端不支持时返回 null（capability 缺省即隐藏入口）。
export async function getTaskDiagnostics(
  backend: string,
  opts?: { board?: string; severity?: string },
): Promise<TaskDiagnosticsRow[] | null> {
  const qs = new URLSearchParams({ backend, action: "diagnostics" });
  if (opts?.board) qs.set("board", opts.board);
  if (opts?.severity) qs.set("severity", opts.severity);
  const { diagnostics } = await jsonFetch<{ diagnostics: TaskDiagnosticsRow[] | null }>(`/__api/tasks?${qs.toString()}`);
  return diagnostics;
}
// Run a task action: "specify" | "decompose" (Hermes; LLM-backed, slow),
// "unblock" | "stop" (OpenClaw workboard; stop = cancel gateway task + abort chat run).
export async function taskAction(
  backend: string,
  id: string,
  action: "specify" | "decompose" | "unblock" | "stop",
  board?: string,
): Promise<{ ok?: boolean; reason?: string; new_title?: string }> {
  const { result } = await jsonFetch<{ result: { ok?: boolean; reason?: string; new_title?: string } }>(
    `${taskUrl(backend, id, board)}&action=${action}`,
    { method: "POST" },
  );
  return result || {};
}

// Host-level CLI scan (local-only, no backend).
export async function getClis(): Promise<{ tools: CliTool[]; categories: CliCategory[] }> {
  const data = await jsonFetch<{ tools: CliTool[]; categories: CliCategory[] }>(`/__api/cli`);
  return { tools: data.tools || [], categories: data.categories || [] };
}
// Lazy version resolution for one tool (runs the binary; slow, on-demand).
export async function getCliVersion(path: string): Promise<string | null> {
  const { version } = await jsonFetch<{ version: string | null }>(
    `/__api/cli/version`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    },
  );
  return version;
}
// Reveal the binary in the OS file manager (Electron only; 501 elsewhere).
export async function revealCli(path: string): Promise<boolean> {
  try {
    const { ok } = await jsonFetch<{ ok: boolean }>(`/__api/cli/reveal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    return ok;
  } catch {
    return false;
  }
}

// 用系统默认程序打开路径（Agent 页 workspace → Finder）。Electron 宿主专属，
// 开发态无 hostOps → 501，抛出的错误交由调用端 toast。
export async function openPath(path: string): Promise<void> {
  await jsonFetch<{ ok: boolean }>(`/__api/host/open-path`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

export async function openAttachment(name: string, src: string): Promise<void> {
  if (!src.startsWith("data:") && !/^\/(?:__api\/inspirations\/media|__media)\?/.test(src)) {
    throw new Error("Invalid attachment source");
  }
  const response = await fetch(src);
  if (!response.ok) throw new Error(`File unavailable (${response.status})`);
  const bytes = await response.blob();
  await jsonFetch<{ ok: boolean }>(`/__api/host/open-attachment?name=${encodeURIComponent(name)}`, {
    method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: bytes,
  });
}

// 在系统文件管理器中定位文件但不打开（聊天 session 产物）。
export async function revealPath(path: string): Promise<void> {
  const { ok } = await jsonFetch<{ ok: boolean }>(`/__api/host/reveal-path`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!ok) throw new Error("reveal failed");
}

// Lazy per-tool reference info (version + summary + --help), fetched on drawer open.
export async function getCliInfo(_name: string, path: string): Promise<CliInfo> {
  return jsonFetch<CliInfo>(`/__api/cli/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

// Per-backend "which CLI commands have agents actually run" aggregate (OpenClaw
// local only; others supported:false). Joined against getClis() in the CLI page.
export async function getCliUsage(): Promise<BackendCliUsage[]> {
  try {
    const data = await jsonFetch<{ backends: BackendCliUsage[] }>(`/__api/cli/usage`);
    return data.backends || [];
  } catch {
    return [];
  }
}

// Agent list for one backend (the 代理 tab-switch page).
export async function listAgents(
  backend: string,
  options: { lifecycle?: "active" | "archived" | "pending" | "all" } = {},
): Promise<UnifiedAgent[]> {
  const lifecycle = options.lifecycle || "active";
  const { agents } = await jsonFetch<{ agents: UnifiedAgent[] }>(
    `/__api/agents?backend=${encodeURIComponent(backend)}&lifecycle=${encodeURIComponent(lifecycle)}`,
  );
  return agents || [];
}

function agentUrl(backend: string, id: string, suffix = ""): string {
  return `/__api/agents/${encodeURIComponent(id)}${suffix}?backend=${encodeURIComponent(backend)}`;
}
export async function getAgent(backend: string, id: string): Promise<UnifiedAgentDetail> {
  const { agent } = await jsonFetch<{ agent: UnifiedAgentDetail }>(agentUrl(backend, id));
  return agent;
}
export async function createAgent(backend: string, spec: AgentInput): Promise<unknown> {
  const request = {
    ...spec,
    operationId: spec.operationId || `agent-create-${globalThis.crypto.randomUUID()}`,
    createdAt: spec.createdAt ?? Date.now(),
  };
  const { result } = await jsonFetch<{ result: unknown }>(
    `/__api/agents?backend=${encodeURIComponent(backend)}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) },
  );
  return result;
}
// Resolves to the agent's id AFTER the update. Renaming a Hermes profile re-keys
// its agent, so the caller must re-select on this id, not the one it passed in.
export async function updateAgent(backend: string, id: string, patch: AgentInput): Promise<string> {
  const request = {
    ...patch,
    operationId: patch.operationId || `agent-update-${globalThis.crypto.randomUUID()}`,
    createdAt: patch.createdAt ?? Date.now(),
  };
  const { result } = await jsonFetch<{ result?: { id?: string } }>(agentUrl(backend, id), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  return result?.id || id;
}
export async function deleteAgent(
  backend: string,
  id: string,
  options: { expectedUpdatedAt?: number; operationId?: string; createdAt?: number } = {},
): Promise<void> {
  const operationId = options.operationId || `agent-archive-${globalThis.crypto.randomUUID()}`;
  const createdAt = options.createdAt ?? Date.now();
  const suffix = `&operationId=${encodeURIComponent(operationId)}`
    + `&createdAt=${createdAt}`
    + (options.expectedUpdatedAt === undefined ? "" : `&expectedUpdatedAt=${options.expectedUpdatedAt}`);
  await jsonFetch(agentUrl(backend, id) + suffix, { method: "DELETE" });
}
export async function restoreAgent(
  backend: string,
  id: string,
  options: { expectedUpdatedAt?: number; operationId?: string; createdAt?: number } = {},
): Promise<void> {
  await jsonFetch(agentUrl(backend, id, "/restore"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      operationId: options.operationId || `agent-restore-${globalThis.crypto.randomUUID()}`,
      expectedUpdatedAt: options.expectedUpdatedAt,
      createdAt: options.createdAt ?? Date.now(),
    }),
  });
}
export async function getAgentFile(
  backend: string,
  id: string,
  file: string,
): Promise<{ name: string; content: string; missing?: boolean; revision?: number | string | null; readOnly?: boolean }> {
  const { file: f } = await jsonFetch<{ file: { name: string; content: string; missing?: boolean; revision?: number | string | null; readOnly?: boolean } }>(
    agentUrl(backend, id, "/file") + `&file=${encodeURIComponent(file)}`,
  );
  return f;
}
export async function setAgentFile(
  backend: string,
  id: string,
  file: string,
  content: string,
  expectedRevision?: number,
): Promise<{ id?: string; definitionRevision?: number } | undefined> {
  const { result } = await jsonFetch<{ result?: { id?: string; definitionRevision?: number } }>(
    agentUrl(backend, id, "/file") + `&file=${encodeURIComponent(file)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, expectedRevision, reason: "agents-ui" }),
  });
  return result;
}

export async function getAgentDefinition(backend: string, id: string): Promise<import("../types").AgentDefinitionState> {
  const { definition } = await jsonFetch<{ definition: import("../types").AgentDefinitionState }>(
    agentUrl(backend, id, "/definition"),
  );
  return definition;
}
export async function restoreAgentDefinition(
  backend: string, id: string, revision: number, expectedRevision: number,
): Promise<void> {
  await jsonFetch(agentUrl(backend, id, "/definition"), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "restore", revision, expectedRevision }),
  });
}
export async function exportAgentDefinition(backend: string, id: string): Promise<unknown> {
  const { definition } = await jsonFetch<{ definition: unknown }>(
    agentUrl(backend, id, "/definition") + "&format=export",
  );
  return definition;
}
export async function importAgentDefinition(
  backend: string, id: string, bundle: unknown, expectedRevision: number,
): Promise<void> {
  await jsonFetch(agentUrl(backend, id, "/definition"), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "import", bundle, expectedRevision }),
  });
}
export async function listAgentMemories(
  backend: string, id: string, status?: string, scope?: string, cursor = 0, limit = 50,
): Promise<import("../types").AgentMemoryPage> {
  const query = `${status ? `&status=${encodeURIComponent(status)}` : ""}${scope ? `&scope=${encodeURIComponent(scope)}` : ""}&cursor=${cursor}&limit=${limit}`;
  const { memories } = await jsonFetch<{ memories: import("../types").AgentMemoryPage }>(
    agentUrl(backend, id, "/memories") + query,
  );
  return memories;
}
export async function mutateAgentMemory(
  backend: string, id: string, action: "create" | "confirm" | "update" | "delete", input: Record<string, unknown>,
): Promise<{ revision: number; item: import("../types").AgentMemoryItem | null }> {
  const method = action === "create" || action === "confirm" ? "POST" : action === "update" ? "PUT" : "DELETE";
  const { result } = await jsonFetch<{ result: { revision: number; item: import("../types").AgentMemoryItem | null } }>(
    agentUrl(backend, id, "/memory"), {
      method, headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action === "create" ? { ...input, action } : input),
    },
  );
  return result;
}
export async function listAgentTranscripts(
  backend: string, id: string, sessionId?: string, cursor = 0, limit = 50,
): Promise<import("../types").AgentTranscriptSessionPage | import("../types").AgentTranscriptEventPage> {
  const query = `${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}&cursor=${cursor}&limit=${limit}`;
  const { transcripts } = await jsonFetch<{
    transcripts: import("../types").AgentTranscriptSessionPage | import("../types").AgentTranscriptEventPage;
  }>(
    agentUrl(backend, id, "/transcripts") + query,
  );
  return transcripts;
}
export async function setAgentTranscriptContext(
  backend: string, id: string, input: { sessionId: string; eventId: string; contextExcluded: boolean; expectedRevision: number },
): Promise<void> {
  await jsonFetch(agentUrl(backend, id, "/transcript-context"), {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
}
export async function listAgentTools(backend: string, id: string): Promise<import("../types").AgentToolsState> {
  const { tools } = await jsonFetch<{ tools: import("../types").AgentToolsState }>(agentUrl(backend, id, "/tools"));
  return tools;
}
export async function setAgentToolPermission(
  backend: string, id: string, input: { toolName: string; effect: "allow" | "deny"; expectedRevision: number },
): Promise<void> {
  await jsonFetch(agentUrl(backend, id, "/tool-permission"), {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
}
export async function getAgentComputerState(
  backend: string, id: string,
): Promise<import("../types").AgentComputerState> {
  const { computer } = await jsonFetch<{ computer: import("../types").AgentComputerState }>(
    agentUrl(backend, id, "/computer"),
  );
  return computer;
}
export async function getDesktopComputerPermissions(): Promise<{
  accessibility: boolean; screenRecording: boolean;
}> {
  const invoke = desktopSecretBridge()?.getComputerPermissions;
  if (!invoke) throw desktopSecretError("DESKTOP_BRIDGE_REQUIRED", "仅桌面应用可管理 Computer Use 权限");
  const result = await invoke();
  if (!result.ok) throw desktopSecretError(result.error.code, result.error.message);
  return result.value;
}
export async function requestDesktopComputerPermissions(): Promise<{
  accessibility: boolean; screenRecording: boolean;
}> {
  const invoke = desktopSecretBridge()?.requestComputerPermissions;
  if (!invoke) throw desktopSecretError("DESKTOP_BRIDGE_REQUIRED", "仅桌面应用可管理 Computer Use 权限");
  const result = await invoke();
  if (!result.ok) throw desktopSecretError(result.error.code, result.error.message);
  return result.value;
}
export async function openDesktopComputerScreenRecordingSettings(): Promise<void> {
  const invoke = desktopSecretBridge()?.openComputerScreenRecordingSettings;
  if (!invoke) throw desktopSecretError("DESKTOP_BRIDGE_REQUIRED", "仅桌面应用可管理 Computer Use 权限");
  const result = await invoke();
  if (!result.ok) throw desktopSecretError(result.error.code, result.error.message);
}
export async function getAgentChannels(backend: string, id: string): Promise<AgentChannel[]> {
  const { channels } = await jsonFetch<{ channels: AgentChannel[] }>(agentUrl(backend, id, "/channels"));
  return channels || [];
}
// 该 agent 的产出文件（Agent 页「文件」tab）。与 Dashboard 产出区同一套扫描规则，
// 只是根收窄到这个 agent；本地磁盘能力，远端后端返回 supported:false。
export async function listAgentArtifacts(
  backend: string,
  id: string,
): Promise<{ supported: boolean; reason?: string; total?: number; items: DashboardArtifactItem[] }> {
  const { artifacts } = await jsonFetch<{
    artifacts: { supported: boolean; reason?: string; total?: number; items: DashboardArtifactItem[] };
  }>(agentUrl(backend, id, "/artifacts"));
  return artifacts || { supported: false, items: [] };
}
// Archived (sealed/reset) transcript segments preceding a session's live thread.
// session keys hold ":" → always a query param, never a path segment.
export async function getSessionArchive(
  backend: string,
  agentId: string,
  key: string,
): Promise<SessionArchive> {
  const q = new URLSearchParams({ backend, agentId, key });
  const { archive } = await jsonFetch<{ archive: SessionArchive }>(`/__api/sessions/archive?${q.toString()}`);
  return archive;
}

export async function searchGlobalChats(
  query: string,
  opts: { limit?: number; offset?: number; signal?: AbortSignal } = {},
): Promise<GlobalChatSearchResult> {
  const q = new URLSearchParams({
    q: query,
    limit: String(opts.limit ?? 50),
    offset: String(opts.offset ?? 0),
  });
  const { search } = await jsonFetch<{ search: GlobalChatSearchResult }>(
    `/__api/chat/search?${q.toString()}`,
    { signal: opts.signal },
  );
  return search;
}

// Usage Top 会话行点击的 transcript 预览（「这个会话在聊什么」）。
// key/sid 都可能含 ":" 或 "/" → 一律 query 参数；offset 分页（滑动逐步加载）。
export async function getSessionPreview(
  backend: string,
  agentId: string,
  key: string,
  opts: { sessionId?: string; offset?: number; limit?: number } = {},
): Promise<SessionPreview> {
  const q = new URLSearchParams({ backend, agentId, key });
  if (opts.sessionId) q.set("sid", opts.sessionId);
  if (opts.offset) q.set("offset", String(opts.offset));
  if (opts.limit) q.set("limit", String(opts.limit));
  const { preview } = await jsonFetch<{ preview: SessionPreview }>(`/__api/sessions/preview?${q.toString()}`);
  return preview;
}

export async function listEnvironments(
  backend: string,
  signal?: AbortSignal,
): Promise<EnvironmentInventory> {
  const q = new URLSearchParams({ backend });
  return jsonFetch<EnvironmentInventory>(`/__api/environments?${q.toString()}`, { signal });
}

export async function describeSession(
  backend: string,
  agentId: string,
  key: string,
  signal?: AbortSignal,
): Promise<SessionAdvancedDescription> {
  const q = new URLSearchParams({ backend, agentId, key });
  return jsonFetch<SessionAdvancedDescription>(`/__api/sessions/describe?${q.toString()}`, { signal });
}

export async function listSessionArtifacts(
  backend: string,
  agentId: string,
  key: string,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<SessionArtifactsResult> {
  const q = new URLSearchParams({ backend, agentId, key, limit: String(opts.limit ?? 50) });
  const { artifacts } = await jsonFetch<{ artifacts: SessionArtifactsResult }>(
    `/__api/sessions/artifacts?${q.toString()}`,
    { signal: opts.signal },
  );
  return artifacts;
}

export async function listSessionBranches(
  backend: string,
  agentId: string,
  key: string,
  signal?: AbortSignal,
): Promise<SessionBranchesResult> {
  const q = new URLSearchParams({ backend, agentId, key });
  return jsonFetch<SessionBranchesResult>(`/__api/sessions/branches?${q.toString()}`, { signal });
}

export async function forkSessionAtEntry(
  backend: string,
  agentId: string,
  key: string,
  entryId: string,
): Promise<SessionForkResult> {
  return jsonFetch<SessionForkResult>(`/__api/sessions/fork`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backend, agentId, key, entryId }),
  });
}

export async function getSessionBoard(
  backend: string,
  agentId: string,
  sessionKey: string,
  signal?: AbortSignal,
): Promise<SessionBoardResult> {
  const q = new URLSearchParams({ backend, agentId, sessionKey });
  return jsonFetch<SessionBoardResult>(`/__api/session-board?${q.toString()}`, { signal });
}

export async function updateSessionBoard(
  backend: string,
  agentId: string,
  sessionKey: string,
  ops: SessionBoardOp[],
  signal?: AbortSignal,
): Promise<SessionBoardResult> {
  return jsonFetch<SessionBoardResult>(`/__api/session-board/ops`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backend, agentId, sessionKey, ops }),
    signal,
  });
}

export async function pinSessionCanvas(
  backend: string,
  agentId: string,
  sessionKey: string,
  spec: {
    name: string;
    docId: string;
    title?: string;
    placement?: { tabId?: string; size?: "sm" | "md" | "lg" | "xl" | "full"; after?: string };
  },
  signal?: AbortSignal,
): Promise<SessionBoardResult> {
  return jsonFetch<SessionBoardResult>(`/__api/session-board/pin-canvas`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backend, agentId, sessionKey, spec }),
    signal,
  });
}

export async function grantSessionBoardWidget(
  backend: string,
  agentId: string,
  sessionKey: string,
  input: { name: string; revision: number; instanceId: string; decision: "granted" | "rejected" },
  signal?: AbortSignal,
): Promise<SessionBoardResult> {
  return jsonFetch<SessionBoardResult>(`/__api/session-board/grant`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backend, agentId, sessionKey, spec: input }),
    signal,
  });
}

// Per-backend connection / overview status (the 设置 page).
export async function getStatus(): Promise<BackendStatus[]> {
  const { backends } = await jsonFetch<{ backends: BackendStatus[] }>(`/__api/status`);
  return backends || [];
}

// Registry-owned UI catalog. Pages filter by surfaces instead of knowing which
// concrete backend happens to implement a capability.
export async function getBackendDescriptors(): Promise<BackendDescriptor[]> {
  const { backends } = await jsonFetch<{ backends: BackendDescriptor[] }>(`/__api/backends`);
  return Array.isArray(backends) ? backends : [];
}

// 聊天面能力（附件种类/上限）：composer 按 agent 查询并缓存。
// `backend` 是启动竞态的兜底——后端还没就绪时它不认领自己的 agent，按 agent
// 查会 404，但这些能力是与在线无关的静态传输属性，按后端仍能如实回答（否则
// 那个窗口里 composer 会误显示成「只能传图片」）。
export async function getChatCapabilities(agentId: string, backendId?: string): Promise<ChatCapabilities> {
  const q = `agent=${encodeURIComponent(agentId)}${backendId ? `&backend=${encodeURIComponent(backendId)}` : ""}`;
  return jsonFetch<ChatCapabilities>(`/__api/chat/capabilities?${q}`);
}

// 主进程快速生成的数据源摘要；调用方只把摘要用于 IndexedDB key，接口不会探测
// dashboard，因此可以在 Hermes 冷启动完成前读取。
export async function getChatCacheScope(backendId: string): Promise<ChatCacheScope> {
  return jsonFetch<ChatCacheScope>(
    `/__api/chat/cache-scope?backend=${encodeURIComponent(backendId)}`,
  );
}

// 斜杠命令目录（Hermes = 网关 commands.catalog；无服务端命令面的后端 supported:false）。
export async function listSlashCommands(
  agentId: string,
  backendId?: string,
  sessionKey?: string,
  signal?: AbortSignal,
): Promise<SlashCatalogResponse> {
  const q = `agent=${encodeURIComponent(agentId)}${backendId ? `&backend=${encodeURIComponent(backendId)}` : ""}${sessionKey ? `&session=${encodeURIComponent(sessionKey)}` : ""}`;
  return jsonFetch<SlashCatalogResponse>(`/__api/chat/slash?${q}`, { signal });
}

// 服务端斜杠执行（typed 结果：output 渲染 / send 转发消息 / prefill 回填）。
export async function execSlashCommand(agentId: string, sessionKey: string, text: string): Promise<SlashExecResult> {
  return jsonFetch<SlashExecResult>(`/__api/chat/slash/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, sessionKey, text }),
  });
}

// 首启梯子:本机 openclaw 侦察(host 能力,无 backend 参数)。
export async function getOpenclawHost(): Promise<OpenclawHostInfo> {
  const { host } = await jsonFetch<{ host: OpenclawHostInfo }>(`/__api/host/openclaw`);
  return host;
}

// 代跑 `openclaw daemon start|install`(仅 loopback 网关时 UI 才给按钮)。
export async function startOpenclawGateway(mode: "start" | "install" = "start"): Promise<GatewayStartResult> {
  return jsonFetch<GatewayStartResult>(`/__api/host/openclaw/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
}

// 局域网 mDNS 浏览 OpenClaw 网关(向导远程面板点选预填;服务端扫描 ~2.5s+缓存 5s)。
export async function listDiscoveredGateways(): Promise<DiscoveredGateway[]> {
  const { gateways } = await jsonFetch<{ gateways: DiscoveredGateway[] }>(`/__api/discovery/openclaw`);
  return gateways || [];
}

// LAN 发现开关(设置页;写 plugins.allow,重启网关生效)。
export async function getLanDiscovery(backend = "openclaw"): Promise<LanDiscoveryState> {
  return jsonFetch<LanDiscoveryState>(`/__api/discovery/state?backend=${encodeURIComponent(backend)}`);
}
export async function setLanDiscovery(
  backend: string,
  enabled: boolean,
): Promise<{ enabled: boolean; requiresRestart: boolean }> {
  return jsonFetch(`/__api/discovery/state?backend=${encodeURIComponent(backend)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

// Dashboard 总览一把抓（registry 聚合，fail-soft）。无参 = 服务端取本地 0 点。
export async function getDashboardSummary(): Promise<DashboardSummary> {
  const { summary } = await jsonFetch<{ summary: DashboardSummary }>(`/__api/dashboard`);
  return summary;
}

export async function getShoggothProductStatus(signal?: AbortSignal): Promise<ShoggothProductStatus> {
  return jsonFetch<ShoggothProductStatus>(`/__api/shoggoth/status`, { signal });
}

export async function getRuntimeAccounts(): Promise<RuntimeAccountSnapshot> {
  return jsonFetch<RuntimeAccountSnapshot>(`/__api/shoggoth/runtime-accounts`);
}

export async function getRuntimeAccount(runtimeAccountId: string): Promise<RuntimeAccountDetail> {
  return jsonFetch<RuntimeAccountDetail>(
    `/__api/shoggoth/runtime-accounts/${encodeURIComponent(runtimeAccountId)}`,
  );
}

export async function getRuntimeAccountAuth(runtimeAccountId: string): Promise<RuntimeAccountAuth> {
  return jsonFetch<RuntimeAccountAuth>(
    `/__api/shoggoth/runtime-accounts/${encodeURIComponent(runtimeAccountId)}/auth`,
  );
}

export async function startRuntimeAccountLogin(
  runtimeAccountId: string,
  mode: "browser" | "deviceCode",
): Promise<{
  requestId: string;
  mode: "browser" | "deviceCode";
  status: "waiting" | "succeeded" | "failed";
  loginId: string;
  authUrl?: string;
  verificationUrl?: string;
  userCode?: string;
}> {
  return jsonFetch(`/__api/shoggoth/runtime-accounts/${encodeURIComponent(runtimeAccountId)}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
}

export async function cancelRuntimeAccountLogin(
  runtimeAccountId: string,
  requestId: string,
): Promise<{ requestId: string; status: string }> {
  return jsonFetch(
    `/__api/shoggoth/runtime-accounts/${encodeURIComponent(runtimeAccountId)}/login/cancel`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId }),
    },
  );
}

export async function logoutRuntimeAccount(
  runtimeAccountId: string,
): Promise<{ loggedOut: true }> {
  return jsonFetch(
    `/__api/shoggoth/runtime-accounts/${encodeURIComponent(runtimeAccountId)}/logout`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  );
}

export async function getRuntimeAccountStorage(
  runtimeAccountId: string,
): Promise<RuntimeAccountStorage> {
  return jsonFetch<RuntimeAccountStorage>(
    `/__api/shoggoth/runtime-accounts/${encodeURIComponent(runtimeAccountId)}/storage`,
  );
}

export async function getLegacyRuntimeHomes(): Promise<{ homes: LegacyRuntimeHomeSummary[] }> {
  return jsonFetch<{ homes: LegacyRuntimeHomeSummary[] }>(
    `/__api/shoggoth/runtime-accounts/legacy-homes`,
  );
}

export async function prepareLegacyRuntimeHomeCleanup(
  entryId: string,
): Promise<LegacyRuntimeHomeCleanupPlan> {
  return jsonFetch<LegacyRuntimeHomeCleanupPlan>(
    `/__api/shoggoth/runtime-accounts/legacy-homes/cleanup/prepare`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entryId }),
    },
  );
}

export async function commitLegacyRuntimeHomeCleanup(
  planId: string,
): Promise<LegacyRuntimeHomeCleanupResult> {
  return jsonFetch<LegacyRuntimeHomeCleanupResult>(
    `/__api/shoggoth/runtime-accounts/legacy-homes/cleanup/commit`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId }),
    },
  );
}

export async function getRuntimeBackups(): Promise<{ backups: RuntimeBackupSummary[] }> {
  return jsonFetch<{ backups: RuntimeBackupSummary[] }>(
    `/__api/shoggoth/runtime-accounts/backups`,
  );
}

export async function prepareRuntimeBackupCleanup(
  entryId: string,
): Promise<RuntimeBackupCleanupPlan> {
  return jsonFetch<RuntimeBackupCleanupPlan>(
    `/__api/shoggoth/runtime-accounts/backups/cleanup/prepare`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entryId }),
    },
  );
}

export async function commitRuntimeBackupCleanup(
  planId: string,
): Promise<RuntimeBackupCleanupResult> {
  return jsonFetch<RuntimeBackupCleanupResult>(
    `/__api/shoggoth/runtime-accounts/backups/cleanup/commit`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId }),
    },
  );
}

export async function getShoggothProviders(profileId: string | null = null): Promise<ShoggothProviderSnapshot> {
  const query = profileId === null ? "" : `?profileId=${encodeURIComponent(profileId)}`;
  return jsonFetch<ShoggothProviderSnapshot>(`/__api/shoggoth/providers${query}`);
}

export async function getShoggothChatGptModels(
  profileId: string | null = null,
): Promise<ShoggothChatGptModels> {
  const query = profileId === null ? "" : `?profileId=${encodeURIComponent(profileId)}`;
  return jsonFetch<ShoggothChatGptModels>(`/__api/shoggoth/chatgpt/models${query}`);
}

export async function configureShoggothProvider(
  input: ShoggothProviderConfiguration,
): Promise<ShoggothProviderConfigurationResult> {
  return jsonFetch<ShoggothProviderConfigurationResult>(`/__api/shoggoth/providers/configure`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function bindShoggothChatGpt(input: {
  profileId: string | null;
  operationId: string;
  defaultModel: string;
  createdAt: number;
}): Promise<{ profile: NonNullable<ShoggothProviderSnapshot["profile"]> }> {
  return jsonFetch<{ profile: NonNullable<ShoggothProviderSnapshot["profile"]> }>(
    `/__api/shoggoth/chatgpt/bind`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export async function clearShoggothProvider(input: {
  operationId: string;
  profileId: string | null;
  createdAt: number;
}): Promise<{ profile: NonNullable<ShoggothProviderSnapshot["profile"]> }> {
  return jsonFetch<{ profile: NonNullable<ShoggothProviderSnapshot["profile"]> }>(
    `/__api/shoggoth/providers/clear`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export async function startShoggothChatGptLogin(profileId: string | null = null): Promise<{
  mode: "browser";
  status: "waiting" | "succeeded" | "failed";
  authUrl: string;
}> {
  return jsonFetch(`/__api/shoggoth/chatgpt/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "browser", profileId }),
  });
}

export async function getShoggothStopImpact(): Promise<ShoggothStopImpact> {
  return jsonFetch<ShoggothStopImpact>(`/__api/shoggoth/background/stop-impact`);
}

export async function runShoggothBackgroundAction(
  action: "install" | "start" | "stop" | "repair",
  revision?: string,
): Promise<ShoggothProductStatus> {
  return jsonFetch<ShoggothProductStatus>(`/__api/shoggoth/background/${action}`, {
    method: "POST",
    ...(action === "stop" ? { body: JSON.stringify({ revision }) } : {}),
  });
}

export async function getShoggothRunDetail(runId: string): Promise<ShoggothRunDetail> {
  return getBackendRunDetail("shoggoth", runId);
}

export async function respondShoggothPrompt(input:
  | { runId: string; requestId: string; kind: "approval"; choice: InteractiveApprovalChoice }
  | { runId: string; requestId: string; kind: "input"; action: "submit" | "cancel"; answers: Record<string, string> }
): Promise<{ runId: string; status: string }> {
  return respondBackendPrompt("shoggoth", input);
}

export async function getBackendRunDetail(
  backendId: string,
  runId: string,
): Promise<BackendRunDetail> {
  return jsonFetch<BackendRunDetail>(
    `/__api/dashboard/runs/${encodeURIComponent(runId)}?backend=${encodeURIComponent(backendId)}`,
  );
}

export async function getDashboardLiveWork(): Promise<DashboardLiveWork> {
  return jsonFetch<DashboardLiveWork>("/__api/dashboard/live");
}

export async function respondBackendPrompt(
  backendId: string,
  input:
    | { runId: string; requestId: string; kind: "approval"; choice: InteractiveApprovalChoice }
    | { runId: string; requestId: string; kind: "input"; action: "submit" | "cancel"; answers: Record<string, string> },
): Promise<{ runId: string; status: string }> {
  return jsonFetch<{ runId: string; status: string }>(
    `/__api/dashboard/prompts/respond?backend=${encodeURIComponent(backendId)}`,
    {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    },
  );
}

// 统一活动流分页（筛选在服务端；cursor 为 opaque 串）。无参 = 本地 0 点第一页。
export async function getDashboardActivities(params: {
  sinceMs?: number;
  limit?: number;
  cursor?: string;
  backend?: string;
  kind?: DashboardActivityPage["items"][number]["kind"];
} = {}): Promise<DashboardActivityPage> {
  const q = new URLSearchParams();
  if (params.sinceMs != null) q.set("sinceMs", String(params.sinceMs));
  if (params.limit != null) q.set("limit", String(params.limit));
  if (params.cursor) q.set("cursor", params.cursor);
  if (params.backend) q.set("backend", params.backend);
  if (params.kind) q.set("kind", params.kind);
  const qs = q.toString();
  return jsonFetch<DashboardActivityPage>(`/__api/dashboard/activities${qs ? `?${qs}` : ""}`);
}

/** Dashboard 文件缩略图 URL（backend 侧重验证；聊天 /__media 不动）。 */
export function dashboardPreviewUrl(backend: string, path: string): string {
  return `/__api/dashboard/preview?backend=${encodeURIComponent(backend)}&path=${encodeURIComponent(path)}`;
}

// 设置页版本检查：后端负责查询官方 latest，前端只消费结构化结果。
export async function getVersions(): Promise<BackendVersionStatus[]> {
  const { versions } = await jsonFetch<{ versions: BackendVersionStatus[] }>(`/__api/versions`);
  return versions || [];
}

// 设置页「立即更新」：触发官方自更新（后台执行），进度靠轮询 getSelfUpdates。
export async function getSelfUpdates(): Promise<BackendSelfUpdate[]> {
  const { updates } = await jsonFetch<{ updates: BackendSelfUpdate[] }>(`/__api/updates`);
  return updates || [];
}
export async function runSelfUpdate(
  backendId: string,
  options: { action?: "update" | "repair"; acceptCapabilities?: boolean } = {},
): Promise<BackendSelfUpdate> {
  const query = new URLSearchParams({ backend: backendId });
  if (options.action) query.set("action", options.action);
  if (options.acceptCapabilities === true) query.set("acceptCapabilities", "true");
  const { update } = await jsonFetch<{ update: BackendSelfUpdate }>(
    `/__api/updates/run?${query.toString()}`,
    { method: "POST" },
  );
  return update;
}

export async function listStandingGrants(
  backendId: string,
  limit = 100,
): Promise<StandingGrantList> {
  const query = new URLSearchParams({ backend: backendId, limit: String(limit) });
  return jsonFetch<StandingGrantList>(`/__api/approval-grants?${query.toString()}`);
}

export async function revokeStandingGrant(
  backendId: string,
  grantId: string,
): Promise<StandingGrantRevokeResult> {
  const query = new URLSearchParams({ backend: backendId, id: grantId });
  return jsonFetch<StandingGrantRevokeResult>(`/__api/approval-grants?${query.toString()}`, {
    method: "DELETE",
  });
}

// App config read/write (设置 page).
export async function getConfig(): Promise<AppConfig> {
  const { config } = await jsonFetch<{ config: AppConfig }>(`/__api/config`);
  return config;
}
export async function updateConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  const { config } = await jsonFetch<{ config: AppConfig }>(`/__api/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return config;
}
// Test a candidate connection without saving.
export async function testConnection(spec: {
  backend: string;
  gatewayUrl?: string;
  baseUrl?: string;
  token?: string;
}): Promise<ConnTestResult> {
  return jsonFetch<ConnTestResult>(`/__api/status/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(spec),
  });
}

// Inspiration remains backend-neutral; session links and execution capabilities
// are supplied by its owner through the registry.
export function listInspirations(query: { query: string; filter: import('../types').InspirationFilter; cursor: string | null; limit: number;
  backendId?: string; agentId?: string }) {
  const params = new URLSearchParams({ query: query.query, filter: query.filter, limit: String(query.limit) });
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.backendId !== undefined) params.set('backendId', query.backendId);
  if (query.agentId !== undefined) params.set('agentId', query.agentId);
  return jsonFetch<import('../types').InspirationPageResult>(`/__api/inspirations?${params}`);
}
export function getInspiration(id: string) {
  return jsonFetch<{ idea: import('../types').InspirationIdea }>(`/__api/inspirations/detail?id=${encodeURIComponent(id)}`);
}
export function getInspirationAgents() {
  return jsonFetch<{ agents: import('../types').InspirationAgent[] }>('/__api/inspirations/agents');
}
export function getInspirationAgentDock(signal?: AbortSignal) {
  return jsonFetch<{ agents: import('../types').InspirationDockAgent[] }>('/__api/inspirations/agent-dock', { signal });
}
export function getIdleInspirationAgents(signal?: AbortSignal) {
  return jsonFetch<{ agents: import('../types').InspirationAgent[] }>('/__api/inspirations/idle-agents', { signal });
}
async function filterInspirationGrowthFailures(result: import('../types').InspirationGrowthResult) {
  // A saved blocked assignment can outlive its failed run, especially while
  // connected to an older desktop service. Verify the current run before
  // counting it; approval/input requests belong on their own note cards.
  const failures = await Promise.all(result.failures.map(async failure => {
    if (!failure.runId) return null;
    try {
      const { idea } = await getInspiration(failure.ideaId);
      return idea.latestExecution?.runId === failure.runId && ['failed', 'canceled'].includes(idea.latestExecution.status)
        && !idea.latestExecution.attention?.active && idea.archivedAt === null ? failure : null;
    } catch { return null; }
  }));
  return { ...result, failures: failures.filter((failure): failure is typeof result.failures[number] => failure !== null) };
}
export async function getInspirationGrowth() {
  return filterInspirationGrowthFailures(await jsonFetch<import('../types').InspirationGrowthResult>('/__api/inspirations/growth'));
}
export async function updateInspirationGrowth(input: Omit<import('../types').InspirationGrowthSettings, 'revision'> & { expectedRevision: number }) {
  return filterInspirationGrowthFailures(await jsonFetch<import('../types').InspirationGrowthResult>('/__api/inspirations/growth', { method: 'PATCH', body: JSON.stringify(input) }));
}
export function getInspirationExecutions(id: string, cursor: string | null = null, limit = 20) {
  const params = new URLSearchParams({ id, limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  return jsonFetch<import('../types').InspirationExecutionsResult>(`/__api/inspirations/executions?${params}`);
}
export function getInspirationActivity(id: string, runId: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ id, runId });
  return jsonFetch<import('../types').InspirationActivity>(`/__api/inspirations/activity?${params}`, { signal });
}
export function createInspiration(input: { operationId: string; body: string; paperTone?: number; attachments?: import('../types').InspirationAttachment[] }) {
  return jsonFetch<{ idea: import('../types').InspirationIdea }>('/__api/inspirations', { method: 'POST', body: JSON.stringify(input) });
}
export function writeInspirationMedia(input: { attachment: import('../types').InspirationAttachment; offset: number; content: string }) {
  return jsonFetch<{ attachment: import('../types').InspirationAttachment; nextOffset: number }>('/__api/inspirations/media', {
    method: 'POST', body: JSON.stringify(input),
  });
}
export function updateInspiration(id: string, input: { operationId: string; expectedRevision: number; patch: import('../types').InspirationPatch }) {
  return jsonFetch<{ idea: import('../types').InspirationIdea }>(`/__api/inspirations/detail?id=${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) });
}
export function startInspiration(id: string, input: import('../types').InspirationStartInput) {
  return jsonFetch<{ idea: import('../types').InspirationIdea }>(`/__api/inspirations/start?id=${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify(input) });
}
export function deleteInspiration(id: string, input: { operationId: string; expectedRevision: number }) {
  return jsonFetch<{ id: string; deleted: true }>(`/__api/inspirations/detail?id=${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify(input) });
}
export function respondInspiration(id: string, input: { operationId: string; runId: string; requestId: string; response: { choice?: string; action?: 'submit' | 'cancel'; answers?: Record<string, string> } }) {
  return jsonFetch<{ idea: import('../types').InspirationIdea }>(`/__api/inspirations/respond?id=${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify(input) });
}
export function cancelInspiration(id: string, input: { operationId: string; runId: string }) {
  return jsonFetch<{ idea: import('../types').InspirationIdea }>(`/__api/inspirations/cancel?id=${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify(input) });
}
