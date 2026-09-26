import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { PageHead } from "../components/PageHead";
import type {
  CustomModelProvider,
  ModelAuthProfile,
  ModelCatalogSnapshot,
  ModelChangeApplyResult,
  ModelChangeCapabilities,
  ModelConfig,
  PendingModelChange,
  ProviderCredential,
  UnifiedModel,
} from "../types";
import {
  activateModelConfig,
  deleteModelAuthProfile,
  getActiveModel,
  applyModelBatch,
  getModelConfig,
  getModelCatalog,
  listModelAuthProfiles,
  setModelAuthProfileKey,
  getModelChangeCapabilities,
  getPendingModelChanges,
  listProviderCredentials,
  removeModelConfig,
  removeModelProvider,
  removeProviderCredential,
  revealModelProviderKey,
  setActiveModel,
  updateModelProvider,
} from "../api/client";
import { usePageCache } from "../lib/usePageCache";
import { useRegisterPageRefresh, useRegisterPageLoading } from "../lib/page-refresh";
import { publishAppliedModelCatalog, revalidateModelCatalog } from "../model-catalog-store";
import BackendTabs, { type BackendId } from "../components/BackendTabs";
import FilterTabs from "../components/FilterTabs";
import SearchCapsule from "../components/SearchCapsule";
import { useStickyState } from "../lib/useStickyState";
import { useBackendCatalog, useBackendState } from "../lib/backends";
import Modal, { DetailRow, ModalSection } from "../components/Modal";
import { Field, Option, Select, TextInput } from "../components/Field";
import { useConfirm, useToast } from "../components/ui";
import KeysPanel from "./keys/KeysPanel";
import styles from "./ModelsPage.module.css";
import CustomEndpointsPanel from "./models/CustomEndpointsPanel";
import { createHermesEndpointController } from "./models/endpoint-controller";
import OpenClawProvidersPane from "./models/OpenClawProvidersPane";
import ModelEditorDrawer from "./models/ModelEditorDrawer";
import ModelAccounts from "./models/ModelAccounts";
import type { EditableModelInput, ModelEditorMode } from "./models/model-editor-state";
import { useNavigationGuard, useNavigationRequest } from "../lib/navigation-guard";
import {
  isValidHttpUrl,
  modelIdentity,
  modelMayMatchScopeForDeletion,
  modelMatchesScope,
} from "../model-identity";

// 草稿层操作(批量提交):删除 / 目录模型改 ID / 目录模型新增。
type DraftOp =
  | { op: "delete"; providerKey: string; modelId: string }
  | { op: "rename"; providerKey: string; sourceModelId: string; newId: string }
  | { op: "create"; providerKey: string; modelId: string; name?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean };
// 列表投影行:__draft 标记待提交状态,点击该卡=撤销对应草稿项。
type DraftedModel = UnifiedModel & { __draft?: "delete" | "rename" | "create"; __draftIndex?: number };

type ModelEditorSession = {
  generation: number;
  mode: ModelEditorMode;
  model?: EditableModelInput;
  catalogOnly?: boolean;
};

function groupByProvider(models: UnifiedModel[]): [string, UnifiedModel[]][] {
  const map = new Map<string, UnifiedModel[]>();
  for (const m of models) {
    const key = m.provider || "—";
    let arr = map.get(key);
    if (!arr) {
      arr = [];
      map.set(key, arr);
    }
    arr.push(m);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

// 目录卡片与自定义配置条目的匹配键：两个后端目录行的 provider 都等于配置键、
// id 都是裸条目 id（实测），复合键避免不同 provider 撞同名模型 id。
const customKey = (provider: string, id: string) => `${provider}:${id}`;

const RESUMABLE_MUTATION_STATUSES = new Set<ModelChangeApplyResult["status"]>([
  "blocked",
  "partial",
  "cleanup_pending",
  "needs_secret",
]);

// 本页两块可被跳转定位的区（「代理」页概览的设置引导跳过来时用 ?section= 命中）。
const KEYS_ANCHOR = "models-provider-keys";
const ENDPOINTS_ANCHOR = "models-provider-endpoints";

export default function ModelsPage() {
  const [backend, setBackend] = useBackendState("models", undefined, { surface: "models" });
  const backendCatalog = useBackendCatalog("models");
  const accountBackend = backendCatalog.find((item) => item.id === backend && item.surfaces.oauth
    && (item.connectionMode === "builtin-service" || item.connectionMode === "native-runtime"));
  const [accountRefreshKey, setAccountRefreshKey] = useState(0);
  // 工具栏视角（provider 筛选 + 搜索词）跨切页记忆，同 Cron/Tasks 的做法。
  const [providerFilter, setProviderFilter] = useStickyState("models.provider", "");
  const [query, setQuery] = useStickyState("models.query", "");
  // 后端切换会让旧请求的 UI 副作用失效；epoch 必须同步递增，不能等待 React 重渲染。
  const backendEpoch = useRef(0);

  const [selected, setSelected] = useState<UnifiedModel | null>(null);
  const [scope, setScope] = useState("");
  const [setting, setSetting] = useState(false);

  const toast = useToast();
  const confirm = useConfirm();
  const { t } = useTranslation();
  const requestNavigation = useNavigationRequest();

  const { data: modelsData, loading, error, refresh, replace } = usePageCache(`models:${backend}`, async () => {
    const [catalogResult, active, config, capabilities, pending, authList] = await Promise.all([
      // 目录读挂不连坐整页（铁律 4 的 UI 侧同款）：提供方/设置面根本不依赖目录，
      // 一个 profile 的运行时目录读不全时它们必须照常可用，失败原因单独成行显示。
      revalidateModelCatalog(backend, (knownRevision) => getModelCatalog(backend, knownRevision))
        .then((snapshot) => ({ ok: true as const, snapshot }))
        .catch((e) => ({ ok: false as const, message: e instanceof Error ? e.message : String(e) })),
      getActiveModel(backend).catch(() => ({ byScope: {}, providerByScope: {} })),
      // 自定义模型配置读挂时降级为空（页面照常渲染目录，只是失去增删能力）
      getModelConfig(backend).catch(() => ({ providers: [] }) as ModelConfig),
      getModelChangeCapabilities(backend).catch(() => ({
        supported: false,
        create: false,
        update: false,
        rename: false,
        delete: false,
        updateProvider: false,
        blockers: ["capability_unavailable"],
      } as ModelChangeCapabilities)),
      getPendingModelChanges(backend).catch(() => [] as PendingModelChange[]),
      // 组头判断「config + 授权 profile 共存」用；失败静默为空（授权入口只会少不会错）
      listModelAuthProfiles(backend).catch(() => ({ supported: false, profiles: [] })),
    ]);
    return {
      models: catalogResult.ok ? catalogResult.snapshot.models : [],
      catalogRevision: catalogResult.ok ? catalogResult.snapshot.catalogRevision : "",
      catalogError: catalogResult.ok ? "" : catalogResult.message,
      byScope: active.byScope || {},
      providerByScope: active.providerByScope || {},
      config,
      capabilities,
      pending,
      authProviders: authList.supported ? [...new Set(authList.profiles.map((p) => p.provider))] : [],
    };
  });
  const refreshAccountsAndModels = () => {
    setAccountRefreshKey((value) => value + 1);
    return refresh();
  };
  useRegisterPageRefresh("/models", refreshAccountsAndModels);
  useRegisterPageLoading("/models", loading);
  const catalogError = modelsData?.catalogError ?? "";
  const models = modelsData?.models ?? [];
  const byScope: Record<string, string> = modelsData?.byScope ?? {};
  const providerByScope: Record<string, string> = modelsData?.providerByScope ?? {};
  const config: ModelConfig = modelsData?.config ?? { providers: [] };
  const capabilities: ModelChangeCapabilities = modelsData?.capabilities ?? {
    supported: false,
    create: false,
    update: false,
    rename: false,
    delete: false,
    updateProvider: false,
    blockers: ["loading"],
  };
  const pending: PendingModelChange[] = modelsData?.pending ?? [];
  // 该后端的模型配置是否 per-agent（Hermes：一个 profile = 一个 agent = 一份独立
  // config）。静态能力位，不特判后端（铁律 1）。是的话本页只承载**跨 agent 共享**的
  // 凭证层（API 密钥 + 自定义端点），per-agent 的主模型/默认参数/辅助模型/MoA/回退链
  // 归「代理」页每个 agent 的概览。
  //
  // 三态而非两态：modelsData 还没到 = **形态未知**，两种形态都不渲染。把「未知」和
  // 「不是 per-agent」混为一谈会让切后端时先闪一帧目录网格再翻成凭证层（R293）。
  const shapeReady = !!modelsData;
  const perAgentModelSettings = modelsData?.capabilities.perAgentModelSettings === true;
  const showProviders = shapeReady && perAgentModelSettings;
  const showCatalog = shapeReady && !perAgentModelSettings;
  // 目录形态后端有「提供方」数据面（OpenClaw：providerDirectory 静态能力位）时，
  // 提供方内容（OAuth 卡 + Provider 目录卡 + 自定义端点卡 + 工具密钥卡）就是页面
  // 全部（R356/R359 用户定案，对齐 Hermes tab）；模型目录网格只在**无该位**的目录
  // 形态后端出现。Hermes（showProviders 形态）不受影响。
  const providerDirectory = modelsData?.capabilities.providerDirectory === true;
  const canManageAuthProfiles = capabilities.manageAuthProfiles === true;
  const showModelsPane = showCatalog && !providerDirectory;
  const showDirectoryPane = showCatalog && providerDirectory;
  // 有授权 profile 的 provider 集合;config 条目共存时组头同时给「编辑端点」和「授权」入口
  const authProviderSet = useMemo(
    () => new Set(modelsData?.authProviders ?? []),
    [modelsData?.authProviders],
  );

  // config-only 降级：完整立即应用不可用但配置写可用时，解锁除 rename 外的编辑
  // 入口；保存结果带 activation（重启网关生效），由待生效横幅承接显式生效动作。
  const configWrite = capabilities.configWrite;
  const configOnlyMode = !capabilities.supported && configWrite?.supported === true;
  const effective: ModelChangeCapabilities = configOnlyMode && configWrite
    ? {
        ...capabilities,
        supported: true,
        create: configWrite.create,
        update: configWrite.update,
        rename: false,
        delete: configWrite.delete,
        updateProvider: configWrite.updateProvider,
        renameProvider: configWrite.renameProvider === true,
        deleteCatalogModel: configWrite.deleteCatalogModel === true,
        renameCatalogModel: configWrite.renameCatalogModel === true,
        batch: configWrite.batch === true,
      }
    : capabilities;
  const [pendingActivation, setPendingActivation] = useState<{ kind: string; available?: boolean } | null>(null);
  const [activating, setActivating] = useState(false);
  const endpointController = useMemo(
    () => createHermesEndpointController(backend),
    [backend],
  );
  const noteActivation = (activation?: { kind: string; available?: boolean } | null) => {
    if (activation?.kind === "gateway_restart") setPendingActivation(activation);
  };
  const doActivate = async () => {
    const actionEpoch = backendEpoch.current;
    setActivating(true);
    try {
      await activateModelConfig(backend);
      toast.success(t("models.activationTriggered"));
      if (actionEpoch === backendEpoch.current) setPendingActivation(null);
      // 网关重启要几秒才回来；稍后刷新一次目录，让 runtime 侧收敛结果可见。
      window.setTimeout(() => {
        if (actionEpoch === backendEpoch.current) void refresh();
      }, 5000);
    } catch (err) {
      toast.error(t("models.activationFailed", { msg: err instanceof Error ? err.message : String(err) }));
    } finally {
      if (actionEpoch === backendEpoch.current) setActivating(false);
    }
  };

  // 授权登录 provider 的凭证管理（auth-profiles;换 Key / 删除授权,生效需重启网关)。
  const [authManage, setAuthManage] = useState<string | null>(null);
  const [authProfiles, setAuthProfiles] = useState<ModelAuthProfile[] | null>(null);
  const [authSupported, setAuthSupported] = useState(true);
  const [authKeyInput, setAuthKeyInput] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const openAuthManage = async (provider: string) => {
    if (!canManageAuthProfiles) return;
    const actionEpoch = backendEpoch.current;
    setAuthManage(provider);
    setAuthKeyInput("");
    setAuthProfiles(null);
    setAuthSupported(true);
    try {
      const r = await listModelAuthProfiles(backend);
      if (actionEpoch !== backendEpoch.current) return;
      setAuthSupported(r.supported);
      // provider 字段可能存凭证来源名(如 anthropic:claude-cli 的 provider="claude-cli"),
      // 归属以 id 前缀兜底判定
      setAuthProfiles(r.profiles.filter((p) => p.provider === provider || p.id.startsWith(`${provider}:`)));
    } catch {
      if (actionEpoch === backendEpoch.current) {
        setAuthSupported(false);
        setAuthProfiles([]);
      }
    }
  };
  const doSaveAuthKey = async () => {
    if (!canManageAuthProfiles || !authManage || !authKeyInput.trim() || authBusy) return;
    const actionEpoch = backendEpoch.current;
    setAuthBusy(true);
    try {
      const r = await setModelAuthProfileKey(backend, authManage, authKeyInput.trim());
      if (actionEpoch !== backendEpoch.current) return;
      toast.success(t("models.authSaved"));
      noteActivation(r.activation);
      setAuthManage(null);
    } catch (e) {
      if (actionEpoch === backendEpoch.current) toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      if (actionEpoch === backendEpoch.current) setAuthBusy(false);
    }
  };
  const doDeleteAuth = async (profile: ModelAuthProfile) => {
    if (!canManageAuthProfiles || authBusy) return;
    const okToDelete = await confirm({
      title: t("models.authDeleteProfile"),
      message: t("models.authDeleteConfirm", { id: profile.id }),
      confirmLabel: t("models.authDeleteProfile"),
      danger: true,
    });
    if (!okToDelete) return;
    const actionEpoch = backendEpoch.current;
    setAuthBusy(true);
    try {
      const r = await deleteModelAuthProfile(backend, profile.id);
      if (actionEpoch !== backendEpoch.current) return;
      toast.success(t("models.authDeleted"));
      noteActivation(r.activation);
      setAuthManage(null);
    } catch (e) {
      if (actionEpoch === backendEpoch.current) toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      if (actionEpoch === backendEpoch.current) setAuthBusy(false);
    }
  };

  // 目录 + 配置真值合并展示：OpenClaw 的 models.list 目录缓存在 config.patch 后
  // 不会热刷新（上游 SWR 缓存缺陷，重启才收敛），刚加的自定义模型会在目录里缺席。
  // 配置里有而目录没有的条目按 UnifiedModel 合成补卡，新增立即可见；删除侧的
  // 目录残影由 OpenClawBackend.getModels 按配置过滤（R118 补丁），这里无需处理。
  const displayModels = useMemo(() => {
    const have = new Set(models.map((m) => customKey(m.provider, m.id)));
    const extras: UnifiedModel[] = [];
    for (const p of config.providers) {
      for (const cm of p.models) {
        if (have.has(customKey(p.key, cm.catalogId))) continue;
        extras.push({
          id: cm.catalogId,
          name: cm.name || cm.id,
          provider: p.key,
          backendId: backend,
          contextWindow: cm.contextWindow,
          reasoning: cm.reasoning,
        });
      }
    }
    return extras.length ? [...models, ...extras] : models;
  }, [models, config, backend]);

  // ---- 草稿层(批量提交):删除/目录改ID/目录新增先暂存,一次合并写提交 ----
  // 网关控制面写 3 次/60s 限流按请求数计——草稿把 N 个操作合成 1 次 config.patch。
  const [draftOps, setDraftOps] = useState<DraftOp[]>([]);
  const [committingDraft, setCommittingDraft] = useState(false);
  const draftOperationId = useRef<string | null>(null);
  const draftEnabled = effective.batch === true;
  // 切后端草稿必须作废(操作对象属于原后端)
  useEffect(() => {
    setDraftOps([]);
    draftOperationId.current = null;
  }, [backend]);
  const removeDraftAt = (index: number) => setDraftOps((ops) => ops.filter((_, i) => i !== index));
  const draftView = useMemo(() => {
    const deleted = new Map<string, number>();
    const renamed = new Map<string, { index: number; newId: string }>();
    const created: Array<{ index: number; providerKey: string; modelId: string; name?: string; contextWindow?: number; reasoning?: boolean }> = [];
    draftOps.forEach((op, index) => {
      if (op.op === "delete") deleted.set(customKey(op.providerKey, op.modelId), index);
      else if (op.op === "rename") renamed.set(customKey(op.providerKey, op.sourceModelId), { index, newId: op.newId });
      else created.push({ index, providerKey: op.providerKey, modelId: op.modelId, name: op.name, contextWindow: op.contextWindow, reasoning: op.reasoning });
    });
    return { deleted, renamed, created };
  }, [draftOps]);
  // 列表投影:待删=原卡标灰、待改名=显示新 ID、待新增=虚卡;点 draft 卡=撤销该项
  const draftedModels = useMemo<DraftedModel[]>(() => {
    if (!draftOps.length) return displayModels;
    const rows: DraftedModel[] = displayModels.map((m) => {
      const k = customKey(m.provider, m.id);
      const del = draftView.deleted.get(k);
      if (del !== undefined) return { ...m, __draft: "delete", __draftIndex: del };
      const ren = draftView.renamed.get(k);
      if (ren) return { ...m, id: ren.newId, name: ren.newId, __draft: "rename", __draftIndex: ren.index };
      return m;
    });
    for (const c of draftView.created) {
      rows.push({
        id: c.modelId, name: c.name || c.modelId, provider: c.providerKey, backendId: backend,
        ...(c.contextWindow ? { contextWindow: c.contextWindow } : {}),
        ...(c.reasoning ? { reasoning: true } : {}),
        __draft: "create", __draftIndex: c.index,
      });
    }
    return rows;
  }, [displayModels, draftOps, draftView, backend]);
  useNavigationGuard({
    dirty: draftOps.length > 0,
    busy: committingDraft,
    onDiscard: () => setDraftOps([]),
  });
  const doCommitDraft = async () => {
    if (!draftOps.length || committingDraft) return;
    const actionBackend = backend;
    const actionEpoch = backendEpoch.current;
    const okToCommit = await confirm({
      title: t("models.draftCommit"),
      message: t("models.draftCommitConfirm", { count: draftOps.length }),
      confirmLabel: t("models.draftCommit"),
      danger: true,
    });
    if (!okToCommit || actionEpoch !== backendEpoch.current) return;
    setCommittingDraft(true);
    // 失败保留幂等键整批重试(后端整批幂等,已收敛子项自动跳过)
    const operationId = draftOperationId.current || crypto.randomUUID();
    draftOperationId.current = operationId;
    try {
      const items = draftOps.map((op) => op.op === "delete"
        ? { op: "delete" as const, providerKey: op.providerKey, modelId: op.modelId }
        : op.op === "rename"
          ? { providerKey: op.providerKey, sourceModelId: op.sourceModelId, model: { id: op.newId } }
          : { providerKey: op.providerKey, model: {
              id: op.modelId,
              ...(op.name ? { name: op.name } : {}),
              ...(op.contextWindow ? { contextWindow: op.contextWindow } : {}),
              ...(op.maxTokens ? { maxTokens: op.maxTokens } : {}),
              ...(op.reasoning ? { reasoning: true } : {}),
            } });
      const r = await applyModelBatch(actionBackend, items, operationId);
      if (actionEpoch !== backendEpoch.current) return;
      if (!(await syncMutationResult(r))) return;
      draftOperationId.current = null;
      setDraftOps([]);
      toast.success(t("models.draftCommitted", { count: items.length }));
    } catch (e) {
      if (actionEpoch === backendEpoch.current) {
        toast.error(e instanceof Error ? e.message : String(e)); // 文案已带「第 N 项」定位
      }
    } finally {
      if (actionEpoch === backendEpoch.current) setCommittingDraft(false);
    }
  };

  // 目录动辄 40+ 张卡：provider 筛选胶囊 + 搜索把它收敛到一屏（规范 §9）。
  // 筛选只发生在展示层，草稿/激活等逻辑一律用未筛选的 draftedModels / displayModels。
  const providerOptions = useMemo(
    () => [...new Set(draftedModels.map((m) => m.provider))].sort((a, b) => a.localeCompare(b)),
    [draftedModels],
  );
  useEffect(() => {
    // 切后端或 provider 消失（删空/改名）后，旧筛选值会让页面看起来是空的。
    if (providerFilter && !providerOptions.includes(providerFilter)) setProviderFilter("");
  }, [providerOptions, providerFilter]);
  const visibleModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q && !providerFilter) return draftedModels;
    return draftedModels.filter((m) => {
      if (providerFilter && m.provider !== providerFilter) return false;
      if (!q) return true;
      return m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
    });
  }, [draftedModels, query, providerFilter]);

  const groups = useMemo(() => groupByProvider(visibleModels), [visibleModels]);
  const scopes = useMemo(() => Object.keys(byScope).sort(), [byScope]);

  const usedBy = (m: UnifiedModel) =>
    Object.entries(byScope)
      .filter(([scopeId, v]) =>
        modelMatchesScope(m, v, providerByScope[scopeId], displayModels),
      )
      .map(([k]) => k);

  const openDetail = (m: UnifiedModel) => {
    // App 重启后按 provider + modelId 找回未终结删除，继续使用原 operationId。
    modelDeleteOperationId.current = pending.find((entry) => (
      entry.kind === "delete-model"
      && entry.providerKey === m.provider
      && entry.source?.modelId === m.id
    ))?.operationId || null;
    setSelected(m);
    // 默认目标选主 profile（…-default），别让字典序第一个（如 hermes-bull）背锅。
    setScope(scopes.find((s) => s.endsWith("-default")) || scopes[0] || "");
  };

  // provider key -> 配置条目（组头「编辑端点」入口用）
  const configProviderByKey = useMemo(() => {
    const map = new Map<string, CustomModelProvider>();
    for (const p of config.providers) map.set(p.key, p);
    return map;
  }, [config]);

  // `${provider}:${catalogId}` -> 配置定位（provider key + 配置内模型 id），
  // 驱动「自定义」tag 与删除。
  const customByCatalogId = useMemo(() => {
    const map = new Map<string, {
      providerKey: string;
      modelId: string;
      provider: CustomModelProvider;
      entry: CustomModelProvider["models"][number];
    }>();
    for (const p of config.providers) {
      for (const cm of p.models) {
        const k = customKey(p.key, cm.catalogId);
        if (!map.has(k)) map.set(k, { providerKey: p.key, modelId: cm.id, provider: p, entry: cm });
      }
    }
    return map;
  }, [config]);

  const [editor, setEditor] = useState<ModelEditorSession | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const editorGeneration = useRef(0);
  const showEditor = (next: Omit<ModelEditorSession, "generation">) => {
    const generation = ++editorGeneration.current;
    setEditor({ ...next, generation });
    setEditorOpen(true);
  };
  const [removing, setRemoving] = useState(false);
  const modelDeleteOperationId = useRef<string | null>(null);

  // 有 env 类 provider ⇒ 该后端有环境变量凭证面（据此显示凭证入口，不特判后端）
  const hasEnvCreds = useMemo(
    () => config.providers.some((p) => p.source === "env"),
    [config],
  );

  // coordinator 已验证的 catalog 先广播给常驻 Chat，再原子回读 active/config 替换页面复合状态。
  const handleCatalogApplied = async (
    catalog: ModelCatalogSnapshot,
  ): Promise<"synced" | "sync-pending"> => {
    if (catalog.backendId !== backend) return "sync-pending";
    publishAppliedModelCatalog(catalog);
    const actionBackend = backend;
    const actionEpoch = backendEpoch.current;
    try {
      const [active, nextConfig, nextPending, authList] = await Promise.all([
        getActiveModel(actionBackend),
        getModelConfig(actionBackend),
        getPendingModelChanges(actionBackend).catch(() => pending),
        // provider 改名/删除后授权集合会变；失败沿用上一轮值（宁可过期，也不误清空入口）
        listModelAuthProfiles(actionBackend).catch(() => null),
      ]);
      if (actionEpoch !== backendEpoch.current || actionBackend !== backend) return "sync-pending";
      replace({
        models: catalog.models,
        catalogRevision: catalog.catalogRevision,
        // coordinator 已验证的目录 = 权威新鲜值，清掉上一轮的读取失败行
        catalogError: "",
        byScope: active.byScope || {},
        providerByScope: active.providerByScope || {},
        config: nextConfig,
        capabilities,
        pending: nextPending,
        authProviders: authList
          ? (authList.supported ? [...new Set(authList.profiles.map((p) => p.provider))] : [])
          : (modelsData?.authProviders ?? []),
      });
      return "synced";
    } catch {
      return "sync-pending";
    }
  };

  // 兼容删除/Provider PUT 也必须消费 coordinator 终态，partial/failed 保留当前弹窗。
  const syncMutationResult = async (
    result: Awaited<ReturnType<typeof removeModelConfig>>,
  ): Promise<boolean> => {
    if (result.status !== "applied" || !result.catalog) {
      // 兼容路由可能返回内部错误文本；只展示稳定阶段和 operationId，避免泄露配置内容。
      const stage = result.stage || result.status || "unknown";
      const operation = result.operationId
        ? ` ${t("models.operationReference", { operationId: result.operationId })}`
        : "";
      // 具体原因优先于笼统失败:重名/源不存在/网关忙都给可直接行动的文案
      const code = (result as { code?: string }).code;
      const message = code === "config_write_conflict"
        ? t("models.mutationWriteConflict")
        : code === "target_conflict"
          ? t("models.errorTargetConflict")
          : code === "source_not_found"
            ? t("models.errorSourceMissing")
            : t("models.mutationIncomplete", { stage });
      toast.error(`${message}${operation}`);
      return false;
    }
    noteActivation(result.activation);
    return (await handleCatalogApplied(result.catalog)) === "synced";
  };

  // 详情编辑按 provider + catalogId 精确定位配置条目，跨 Provider 同 ID 不串。
  const openModelEditor = (modelToEdit: UnifiedModel) => {
    const configured = customByCatalogId.get(customKey(modelToEdit.provider, modelToEdit.id));
    if (!configured) {
      // 目录模型(config 不管定义):条目本体是 allowlist 键,编辑=改 id(搬键+引用改写)
      if (effective.renameCatalogModel !== true || !configProviderByKey.has(modelToEdit.provider)) return;
      setSelected(null);
      showEditor({
        mode: "edit",
        catalogOnly: true,
        model: {
          providerKey: modelToEdit.provider,
          id: modelToEdit.id,
          name: modelToEdit.name,
        },
      });
      return;
    }
    if (!effective.update) return;
    setSelected(null);
    showEditor({
      mode: "edit",
      model: {
        providerKey: configured.providerKey,
        baseUrl: configured.provider.baseUrl,
        api: configured.provider.api,
        id: configured.entry.id,
        name: configured.entry.name || modelToEdit.name,
        contextWindow: configured.entry.contextWindow,
        maxTokens: configured.entry.maxTokens,
        reasoning: configured.entry.reasoning ?? modelToEdit.reasoning,
      },
    });
  };

  // provider 端点编辑（baseUrl / apiKey / api）
  const [editProvider, setEditProvider] = useState<CustomModelProvider | null>(null);
  const [savingProvider, setSavingProvider] = useState(false);
  const providerUpdateOperationId = useRef<string | null>(null);
  const providerUpdateRecoveredFromPending = useRef(false);
  const providerDeleteOperationId = useRef<string | null>(null);
  const [editBaseUrl, setEditBaseUrl] = useState("");
  const [editApiKey, setEditApiKey] = useState("");
  const [editApi, setEditApi] = useState("");
  const [editProviderName, setEditProviderName] = useState("");
  // 明文 key 按需拉取（列表接口只给 hasApiKey）。keyReason 记录拉不到的原因。
  const [showKey, setShowKey] = useState(false);
  const [revealingKey, setRevealingKey] = useState(false);
  const providerSessionEpoch = useRef(0);
  const providerInputEpoch = useRef(0);
  const revealAbort = useRef<AbortController | null>(null);
  const [keyReason, setKeyReason] = useState<"none" | "env" | "managed" | "remote" | null>(null);
  const [keyEnvVar, setKeyEnvVar] = useState("");
  const [credsOpen, setCredsOpen] = useState(false);
  // 该 provider 的凭证池条目（Hermes credential_pool；轮换 key）
  const [pool, setPool] = useState<ProviderCredential[]>([]);
  const [poolBusy, setPoolBusy] = useState<number | null>(null);
  // 名称可改的条件:config 类可编辑条目 + 后端声明 renameProvider(引用/凭证会同步迁移)
  const canRenameProvider = !!editProvider
    && editProvider.source === "config"
    && editProvider.editable !== false
    && effective.renameProvider === true;
  const providerNameChanged = canRenameProvider
    && editProviderName.trim() !== ""
    && editProviderName.trim() !== editProvider!.key;
  const providerNameInvalid = canRenameProvider
    && editProviderName.trim() !== ""
    && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(editProviderName.trim());
  const providerDirty = !!editProvider && (
    editBaseUrl !== editProvider.baseUrl
    || editApi !== (editProvider.api || "")
    || providerNameChanged
    || (providerInputEpoch.current > 0 && editApiKey.length > 0)
  );

  // 普通会话修改公开 patch 必须生成新 operation；跨重启恢复的 pending 则需保留原幂等键。
  const invalidateProviderUpdateOperationForPublicEdit = () => {
    if (!providerUpdateRecoveredFromPending.current) {
      providerUpdateOperationId.current = null;
    }
  };
  useNavigationGuard({
    dirty: providerDirty,
    busy: !!editProvider && savingProvider,
    onDiscard: () => closeEditProvider(),
  });

  // Provider 凭证池请求只允许回写启动时所在的后端世代。
  const refreshPool = async (
    p: CustomModelProvider,
    actionBackend: BackendId,
    actionEpoch: number,
  ) => {
    if (!p.poolCount) {
      if (actionEpoch === backendEpoch.current) setPool([]);
      return;
    }
    try {
      const nextPool = await listProviderCredentials(actionBackend, p.key);
      if (actionEpoch === backendEpoch.current) setPool(nextPool);
    } catch {
      if (actionEpoch === backendEpoch.current) setPool([]);
    }
  };

  const doRemoveCredential = async (entry: ProviderCredential) => {
    if (!editProvider) return;
    const actionBackend = backend;
    const actionEpoch = backendEpoch.current;
    const providerKey = editProvider.key;
    const okToDelete = await confirm({
      title: t("models.deleteCredential"),
      message: t("models.deleteCredentialConfirm", {
        label: entry.label || `#${entry.index}`,
        source: entry.source || "—",
      }),
      confirmLabel: t("models.deleteCredential"),
      danger: true,
    });
    if (!okToDelete || actionEpoch !== backendEpoch.current) return;
    setPoolBusy(entry.index);
    try {
      await removeProviderCredential(actionBackend, providerKey, entry.index);
      if (actionEpoch !== backendEpoch.current) return;
      toast.success(t("models.deleteCredentialOk"));
      await refresh();
      if (actionEpoch !== backendEpoch.current) return;
      // 池条目删除后 index 会前移 → 重新拉一次而不是本地剔除
      const nextPool = await listProviderCredentials(actionBackend, providerKey).catch(() => []);
      if (actionEpoch === backendEpoch.current) setPool(nextPool);
    } catch (e) {
      if (actionEpoch === backendEpoch.current) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (actionEpoch === backendEpoch.current) setPoolBusy(null);
    }
  };

  const openEditProvider = (p: CustomModelProvider) => {
    const actionBackend = backend;
    const actionEpoch = backendEpoch.current;
    providerSessionEpoch.current += 1;
    providerInputEpoch.current = 0;
    revealAbort.current?.abort();
    const pendingUpdate = pending.find((entry) => (
      entry.kind === "update-provider" && entry.providerKey === p.key
    ));
    providerUpdateOperationId.current = pendingUpdate?.operationId || null;
    providerUpdateRecoveredFromPending.current = !!pendingUpdate?.operationId;
    providerDeleteOperationId.current = pending.find((entry) => (
      entry.kind === "delete-provider" && entry.providerKey === p.key
    ))?.operationId || null;
    setEditProvider(p);
    setEditBaseUrl(p.baseUrl);
    setEditApiKey("");
    setEditApi(p.api || "");
    setEditProviderName(p.key);
    setShowKey(false);
    setRevealingKey(false);
    setKeyReason(null);
    setKeyEnvVar("");
    setPool([]);
    void refreshPool(p, actionBackend, actionEpoch);
  };

  // 明文只在用户显式点击后请求；输入或切换弹窗后迟到响应不得覆盖当前值。
  const revealExistingProviderKey = async () => {
    const provider = editProvider;
    if (!provider || provider.editable === false) return;
    const actionBackend = backend;
    const actionEpoch = backendEpoch.current;
    const actionSession = providerSessionEpoch.current;
    const actionInput = providerInputEpoch.current;
    const controller = new AbortController();
    revealAbort.current?.abort();
    revealAbort.current = controller;
    setRevealingKey(true);
    try {
      const r = await revealModelProviderKey(actionBackend, provider.key, controller.signal);
      if (actionEpoch !== backendEpoch.current
        || actionSession !== providerSessionEpoch.current
        || actionInput !== providerInputEpoch.current
        || editProvider?.key !== provider.key) return;
      if (r.apiKey) setEditApiKey(r.apiKey);
      else {
        setKeyReason(r.reason ?? "none");
        setKeyEnvVar(r.envVar || "");
      }
      setShowKey(true);
    } catch (error) {
      if (!controller.signal.aborted && actionEpoch === backendEpoch.current) setKeyReason("remote");
    } finally {
      if (actionSession === providerSessionEpoch.current) setRevealingKey(false);
    }
  };

  // 关闭 Provider 弹窗同时撤销 reveal，确保明文不会流入下一次 session。
  const closeEditProvider = () => {
    providerSessionEpoch.current += 1;
    revealAbort.current?.abort();
    revealAbort.current = null;
    setRevealingKey(false);
    providerUpdateOperationId.current = null;
    providerUpdateRecoveredFromPending.current = false;
    providerDeleteOperationId.current = null;
    setEditProvider(null);
    setEditApiKey("");
    setShowKey(false);
  };

  // Provider 表单也遵守页面 dirty 规则；保存中不能通过关闭按钮中断状态跟踪。
  const requestCloseEditProvider = () => {
    if (savingProvider) return;
    if (providerDirty && !window.confirm(t("models.discardProvider"))) return;
    closeEditProvider();
  };

  const apiKeyHint = () => {
    if (keyReason === "managed") return t("models.apiKeyManagedHint");
    if (keyReason === "env") return t("models.apiKeyEnvHint", { env: keyEnvVar });
    if (keyReason === "remote") return t("models.apiKeyRemoteHint");
    if (keyReason === "none") {
      if (editProvider?.source !== "env" || !editProvider.keyEnv) return t("models.apiKeyUnsetHint");
      // 目录里已有模型 ⇒ 它已通过别的方式（OAuth/CLI/中转）认证，填 Key 是改直连而非「启用」
      return editProvider.authenticated
        ? t("models.apiKeyAuthedNoKeyHint", { env: editProvider.keyEnv })
        : t("models.apiKeyEnvUnsetHint", { env: editProvider.keyEnv });
    }
    return editProvider?.source === "env" && editProvider.keyEnv
      ? t("models.apiKeyEnvSetHint", { env: editProvider.keyEnv })
      : t("models.apiKeySetHint");
  };

  // 编辑与新增共用严格 URL 解析，避免只校验协议前缀而放过畸形地址。
  const baseUrlInvalid = !!editBaseUrl.trim() && !isValidHttpUrl(editBaseUrl);
  const baseUrlWillClear =
    editProvider?.source === "env" && !!editProvider.hasBaseUrl && !editBaseUrl.trim();

  const doRemoveProvider = async () => {
    if (!editProvider || !effective.delete) return;
    const p = editProvider;
    const actionBackend = backend;
    const actionEpoch = backendEpoch.current;
    // config provider 删除的是整组模型；同时覆盖配置内部 id 与目录 catalogId，兼容新旧后端。
    // env provider 只清凭证，不删除目录模型，故后续不套此阻断。
    const providerModelsByIdentity = new Map<string, UnifiedModel>();
    for (const model of displayModels.filter((item) => item.provider === p.key)) {
      providerModelsByIdentity.set(modelIdentity(model), model);
    }
    for (const configured of p.models) {
      for (const id of new Set([configured.id, configured.catalogId].filter(Boolean))) {
        const model: UnifiedModel = {
          id,
          name: configured.name || id,
          provider: p.key,
          backendId: actionBackend,
        };
        if (!providerModelsByIdentity.has(modelIdentity(model))) {
          providerModelsByIdentity.set(modelIdentity(model), model);
        }
      }
    }
    const providerModels = [...providerModelsByIdentity.values()];
    // 按 provider 内全部模型做保守匹配；旧 API 缺 provider 时，裸 id 歧义也视为可能在用。
    const findProviderUsers = (
      activeByScope: Record<string, string>,
      activeProviderByScope: Record<string, string>,
    ) =>
      Object.entries(activeByScope)
        .filter(([scopeId, value]) =>
          providerModels.some((model) =>
            modelMayMatchScopeForDeletion(
              model,
              value,
              activeProviderByScope[scopeId],
            ),
          ),
        )
        .map(([scopeId]) => scopeId);
    // 使用中不再硬拦：把在用数量并入确认文案，用户知情确认后照删（引用失效自担）。
    const providerUsers = p.source === "config" ? findProviderUsers(byScope, providerByScope) : [];
    // editable:false = 纯凭证池 provider（OAuth/CLI 登录）：没有 env 变量可清，
    // 删除的语义就是撤销池里的登录凭证，确认文案照实说。
    const poolOnly = p.editable === false;
    const parts = poolOnly
      ? [t("models.deleteProviderPoolOnlyConfirm", { key: p.key, count: p.poolCount ?? 0 })]
      : [
          p.source === "config"
            ? t("models.deleteProviderConfigConfirm", { key: p.key, count: p.models.length })
            : t("models.deleteProviderEnvConfirm", { key: p.key }),
          providerUsers.length > 0 ? t("models.deleteProviderInUseWarning", { count: providerUsers.length }) : "",
          p.source === "config" ? t("models.deleteReferencesWarning") : "",
          p.poolCount ? t("models.deleteProviderPoolNote", { count: p.poolCount }) : "",
        ].filter(Boolean);
    const okToDelete = await confirm({
      title: poolOnly ? t("models.clearCredentials") : t("models.deleteProvider"),
      message: parts.join(" "),
      confirmLabel: poolOnly ? t("models.clearCredentials") : t("models.deleteProvider"),
      danger: true,
    });
    if (!okToDelete || actionEpoch !== backendEpoch.current) return;
    setSavingProvider(true);
    const operationId = providerDeleteOperationId.current || crypto.randomUUID();
    // 请求发出前即保存 operationId；即使响应丢失，用户重试也不会产生第二次逻辑删除。
    providerDeleteOperationId.current = operationId;
    try {
      const r = await removeModelProvider(actionBackend, p.key, operationId, true);
      if (actionEpoch !== backendEpoch.current) return;
      if (!(await syncMutationResult(r))) {
        providerDeleteOperationId.current = RESUMABLE_MUTATION_STATUSES.has(r.status)
          || r.status === "applied"
          ? (r.operationId || operationId)
          : null;
        return;
      }
      providerDeleteOperationId.current = null;
      toast.success(
        poolOnly
          ? t("models.clearCredentialsOk", { key: p.key })
          : t("models.deleteProviderOk", { key: p.key }),
      );
      closeEditProvider();
    } catch (e) {
      if (actionEpoch === backendEpoch.current) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (actionEpoch === backendEpoch.current) setSavingProvider(false);
    }
  };

  const doUpdateProvider = async () => {
    if (!editProvider || effective.updateProvider !== true) return;
    const p = editProvider;
    const actionBackend = backend;
    const actionEpoch = backendEpoch.current;
    const operationId = providerUpdateOperationId.current || crypto.randomUUID();
    // needs_secret 只补充短生命周期凭证，公开 patch 未变，因此必须沿用同一 operationId。
    providerUpdateOperationId.current = operationId;
    setSavingProvider(true);
    try {
      const renameTo = providerNameChanged ? editProviderName.trim() : undefined;
      // auth 类(内置端点+auth-profiles 凭证)只有 Key 可写,端点字段不进请求
      const r = await updateModelProvider(actionBackend, p.key, p.source === "auth" ? {
        apiKey: editApiKey.trim() || undefined,
      } : {
        baseUrl: editBaseUrl.trim() || undefined,
        apiKey: editApiKey.trim() || undefined,
        api: editApi.trim() || undefined,
        // env 类端点被清空 ⇒ 显式移除覆盖（否则「留空=不改」会保住脏值）
        clearBaseUrl: baseUrlWillClear || undefined,
        renameTo,
      }, operationId);
      if (actionEpoch !== backendEpoch.current) return;
      if (!(await syncMutationResult(r))) {
        const resumable = RESUMABLE_MUTATION_STATUSES.has(r.status) || r.status === "applied";
        providerUpdateOperationId.current = resumable
          ? (r.operationId || operationId)
          : null;
        providerUpdateRecoveredFromPending.current = resumable
          && providerUpdateRecoveredFromPending.current;
        return;
      }
      providerUpdateOperationId.current = null;
      providerUpdateRecoveredFromPending.current = false;
      toast.success(renameTo
        ? t("models.providerRenamed", { from: p.key, to: renameTo })
        : t("models.providerUpdated", { key: p.key }));
      closeEditProvider();
    } catch (e) {
      if (actionEpoch === backendEpoch.current) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (actionEpoch === backendEpoch.current) setSavingProvider(false);
    }
  };

  const doRemove = async () => {
    if (!selected) return;
    const model = selected;
    const actionBackend = backend;
    const actionEpoch = backendEpoch.current;
    // 自定义模型删 config 条目;目录模型(无 config 条目)删的是允许列表键+引用
    const ref = customByCatalogId.get(customKey(model.provider, model.id))
      || (effective.deleteCatalogModel === true && configProviderByKey.has(model.provider)
        ? { providerKey: model.provider, modelId: model.id }
        : null);
    if (!ref) return;
    // 草稿模式:删除先暂存(卡片标灰可点击撤销),最后一次批量提交,不逐发网关
    if (draftEnabled) {
      setDraftOps((ops) => [...ops, { op: "delete", providerKey: ref.providerKey, modelId: ref.modelId }]);
      setSelected(null);
      toast.success(t("models.draftAdded"));
      return;
    }
    // 使用中不再硬拦：在用数量并入确认文案，用户知情确认后照删（引用失效自担）。
    const users = usedBy(model);
    const okToDelete = await confirm({
      title: t("models.deleteModel"),
      message: [
        t("models.deleteConfirm", { id: model.id }),
        users.length > 0 ? t("models.deleteInUseWarning", { count: users.length }) : "",
        t("models.deleteReferencesWarning"),
      ].filter(Boolean).join(" "),
      confirmLabel: t("models.deleteModel"),
      danger: true,
    });
    if (!okToDelete || actionEpoch !== backendEpoch.current) return;
    setRemoving(true);
    const operationId = modelDeleteOperationId.current || crypto.randomUUID();
    // 删除在网络未知结果下也保留幂等键，避免用户重试时重复迁移或清理引用。
    modelDeleteOperationId.current = operationId;
    try {
      const r = await removeModelConfig(actionBackend, ref.providerKey, ref.modelId, operationId, true);
      if (actionEpoch !== backendEpoch.current) return;
      if (!(await syncMutationResult(r))) {
        modelDeleteOperationId.current = RESUMABLE_MUTATION_STATUSES.has(r.status)
          || r.status === "applied"
          ? (r.operationId || operationId)
          : null;
        return;
      }
      modelDeleteOperationId.current = null;
      toast.success(t("models.deleteOk", { id: model.id }));
      setSelected(null);
    } catch (e) {
      if (actionEpoch === backendEpoch.current) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (actionEpoch === backendEpoch.current) setRemoving(false);
    }
  };

  const doSetActive = async () => {
    if (!selected) return;
    const model = selected;
    const actionScope = scope;
    const actionBackend = backend;
    const actionEpoch = backendEpoch.current;
    setSetting(true);
    try {
      await setActiveModel(actionBackend, model.id, {
        scope: actionScope,
        provider: model.provider,
      });
      if (actionEpoch !== backendEpoch.current) return;
      toast.success(t("models.setActiveOk", { scope: actionScope || "default" }));
      await refresh();
    } catch (e) {
      if (actionEpoch === backendEpoch.current) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (actionEpoch === backendEpoch.current) setSetting(false);
    }
  };

  // 页面级能力提示在打开表单前就可见；只映射固定 blocker code，不暴露后端内部文本。
  const capabilityBlockerMessage = (code: string): string => {
    switch (code) {
      case "upgrade_required": return t("models.capabilityUpgradeRequired");
      case "conditional_write_unsupported":
      case "hermes_conditional_write_unsupported":
        return t("models.capabilityConditionalWrite");
      case "supervisor_drain_unsupported":
      case "openclaw_supervisor_drain_unsupported":
        return t("models.capabilitySupervisorDrain");
      case "loading": return t("models.capabilityLoading");
      default: return t("models.capabilityUnsupported");
    }
  };
  const capabilityReadOnlyReason = !effective.supported
    ? (capabilities.blockers || ["unsupported"]).map(capabilityBlockerMessage).join(" ")
    : "";

  // 「代理」页概览的设置引导跳过来时带 ?section=keys|endpoints：滚到对应区。
  // 一次性消费掉（replace 掉 query），否则页内再导航会重复滚动。
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const section = new URLSearchParams(location.search).get("section");
    if (!section || !showProviders) return;
    const anchor = section === "keys" ? KEYS_ANCHOR : section === "endpoints" ? ENDPOINTS_ANCHOR : "";
    if (!anchor) return;
    navigate("/models", { replace: true });
    // 轮询到位即止，不靠固定延时猜：密钥卡与端点卡都是异步落数据的（端点列表要等
    // active 翻 true 后的一次请求），页面高度会连着变几次，先前滚到的落点会被顶掉。
    // behavior 必须是 "auto"——smooth 在本项目的宿主里会被整个吞掉，实测滚动容器
    // scrollTop 分毫未动；auto 当场归位。
    //
    // 故意**不返回 cleanup**：上面那句 navigate 会改 location.search，于是本 effect
    // 依赖变化、React 先跑上一轮的 cleanup —— 有 cleanup 的话这个循环会被自己掐死，
    // 滚动永远不发生。元素不在时是 no-op，循环有 2s 上限，留着没有副作用。
    let tries = 0;
    const settle = () => {
      const el = document.getElementById(anchor);
      if (el) {
        if (Math.abs(el.getBoundingClientRect().top) < 80) return; // 已到位
        el.scrollIntoView({ behavior: "auto", block: "start" });
      }
      if (++tries < 40) window.setTimeout(settle, 50);
    };
    settle();
  }, [location.search, showProviders, navigate]);

  // provider 端点/凭证表单：目录形态摆在弹窗里，凭证层形态在页内就地展开
  // ——同一份表单体与动作按钮供两个容器复用，避免两套实现漂移。
  const providerFormActions = editProvider && (
    <>
      {editProvider.editable !== false && (
        <button
          className="btn-primary"
          onClick={doUpdateProvider}
          // env 类端点可留空（走上游默认）；config 类必须有 baseUrl；非法 URL 一律拦下
          disabled={
            savingProvider ||
            effective.updateProvider !== true ||
            baseUrlInvalid ||
            providerNameInvalid ||
            (canRenameProvider && !editProviderName.trim()) ||
            (editProvider.source === "config" && !editBaseUrl.trim()) ||
            // auth 类唯一可写的是 Key——没输入就没有可保存的内容
            (editProvider.source === "auth" && !editApiKey.trim())
          }
        >
          {savingProvider ? t("models.saving") : t("models.save")}
        </button>
      )}
      <button className="btn-danger" onClick={doRemoveProvider} disabled={savingProvider || !effective.delete}>
        {editProvider.editable === false
          ? t("models.clearCredentials")
          : editProvider.source === "auth"
            ? t("models.authDeleteProfile")
            : t("models.deleteProvider")}
      </button>
    </>
  );

  const providerFormBody = editProvider && (
    <>
      {(effective.updateProvider !== true || !effective.delete) && (
        <div className={styles.capabilityBanner} role="status">
          {t("models.capabilityReadOnly", {
            reason: capabilityReadOnlyReason || t("models.capabilityUnsupported"),
          })}
        </div>
      )}
      {/* 纯凭证池 provider（OAuth/CLI 登录）：没有可写的 Key/端点变量——不渲染
          编辑表单（保存必失败），只说明原因；凭证池区在下方照常渲染。 */}
      {editProvider.editable === false && (
        <ModalSection title={t("models.providerSection")}>
          <p className="muted">{t("models.poolOnlyProviderNote")}</p>
        </ModalSection>
      )}
      {editProvider.editable !== false && (
        <ModalSection title={t("models.providerSection")}>
          {canRenameProvider && (
            <Field
              label={t("models.providerName")}
              hint={providerNameInvalid
                ? t("models.providerNameInvalid")
                : providerNameChanged
                  ? t("models.providerNameHint")
                  : undefined}
            >
              <TextInput
                value={editProviderName}
                onChange={(e) => {
                  invalidateProviderUpdateOperationForPublicEdit();
                  setEditProviderName(e.target.value);
                }}
                spellCheck={false}
                autoComplete="off"
              />
            </Field>
          )}
          <Field
            label={t("models.baseUrl")}
            hint={
              baseUrlInvalid
                ? t("models.baseUrlInvalid")
                : baseUrlWillClear
                  ? t("models.baseUrlWillClear", { env: editProvider.baseUrlEnv || "—" })
                  : editProvider.source === "env"
                    ? t("models.baseUrlEnvHint", { env: editProvider.baseUrlEnv || "—" })
                    : editProvider.source === "auth"
                      ? t("models.baseUrlAuthHint")
                      : undefined
            }
          >
            <TextInput
              value={editBaseUrl}
              onChange={(e) => {
                invalidateProviderUpdateOperationForPublicEdit();
                setEditBaseUrl(e.target.value);
              }}
              // auth 类端点由网关内置,只读展示(注册表镜像值;空=内置默认)
              disabled={(editProvider.source === "env" && !editProvider.baseUrlEnv) || editProvider.source === "auth"}
              placeholder={editProvider.source === "env" || editProvider.source === "auth" ? t("models.baseUrlDefaultPlaceholder") : undefined}
            />
          </Field>
          <Field label={t("models.apiKey")} hint={apiKeyHint()}>
            {/* loopback 管理面：打开即拉明文填入，可切换隐藏；清空保存不会清掉旧值 */}
            <div className={styles.keyRow}>
              <TextInput
                type={showKey ? "text" : "password"}
                value={editApiKey}
                onChange={(e) => {
                  providerInputEpoch.current += 1;
                  setEditApiKey(e.target.value);
                }}
                disabled={keyReason === "managed"}
                spellCheck={false}
                autoComplete="off"
              />
              <button
                type="button"
                className={styles.keyToggle}
                onClick={() => showKey ? setShowKey(false) : void revealExistingProviderKey()}
                disabled={revealingKey}
              >
                {revealingKey ? t("models.revealLoading") : showKey ? t("models.hideKey") : t("models.revealExistingKey")}
              </button>
            </div>
          </Field>
          {/* api_mode 只对配置文件里的自定义 provider 有意义 */}
          {editProvider.source === "config" && (
            <Field label={t("models.apiMode")} hint={t("models.apiModeHint")}>
              <TextInput
                value={editApi}
                onChange={(e) => {
                  invalidateProviderUpdateOperationForPublicEdit();
                  setEditApi(e.target.value);
                }}
                placeholder={backend === "openclaw" ? "openai-completions" : "openai"}
              />
            </Field>
          )}
          {(editProvider.profiles?.length ?? 0) > 0 && (
            <Field label={t("models.profilesLabel")}>
              <div className="chip-row">
                {editProvider.profiles!.map((p) => (
                  <span key={p} className="chip-meta">{p}</span>
                ))}
              </div>
            </Field>
          )}
          {editProvider.source === "env" && (
            <p className="muted">{t("models.envProviderNote")}</p>
          )}
          {editProvider.source === "auth" && (
            <p className="muted">{t("models.authProviderNote")}</p>
          )}
          {/* 该 provider 另有授权 profile(OAuth/CLI 登录):组头不再放第二个按钮,
              授权管理从这里进(查看/换 Key/删除授权) */}
          {canManageAuthProfiles && authProviderSet.has(editProvider.key) && (
            <button
              type="button"
              className={styles.keyToggle}
              title={t("models.authManageTip")}
              onClick={() => {
                const k = editProvider.key;
                closeEditProvider();
                void openAuthManage(k);
              }}
            >
              {t("models.authManageTitle")} →
            </button>
          )}
        </ModalSection>
      )}

      {pool.length > 0 && (
        <ModalSection title={t("models.poolTitle")}>
          <p className="muted">{t("models.poolHint")}</p>
          {pool.map((c) => (
            <div key={c.index} className={styles.poolRow}>
              <div className={styles.poolMeta}>
                <span className={styles.poolLabel} title={c.label}>{c.label || `#${c.index}`}</span>
                <span className="muted">
                  {c.source || "—"}
                  {c.lastStatus ? ` · ${c.lastStatus}` : ""}
                  {c.requestCount ? ` · ${t("models.poolRequests", { count: c.requestCount })}` : ""}
                </span>
              </div>
              <button
                className="btn-danger"
                onClick={() => doRemoveCredential(c)}
                disabled={poolBusy === c.index}
              >
                {poolBusy === c.index ? t("models.deleting") : t("common.delete")}
              </button>
            </div>
          ))}
        </ModalSection>
      )}
    </>
  );

  // 切换后端前关闭所有依赖旧后端数据的弹窗，避免跨后端误操作旧对象。
  const handleBackendChange = (nextBackend: BackendId) => {
    requestNavigation(() => {
      backendEpoch.current += 1;
      setSelected(null);
      closeEditProvider();
      setEditorOpen(false);
      setEditor(null);
      setCredsOpen(false);
      // 形态（目录网格 vs 凭证层）跟着新后端的 capabilities 走：usePageCache 的 key
      // 含 backend，切过去还没数据时 shapeReady=false，两种形态都不渲染。
      // 新后端不能继承旧请求的 loading 状态；旧请求 finally 也会被 epoch 拦截。
      setRemoving(false);
      setSetting(false);
      setSavingProvider(false);
      setPoolBusy(null);
      setBackend(nextBackend);
    });
  };

  return (
    <div className="page management-page models-page">
      {/* 统计进副标题、搜索进页头右槽（规范 §2）。凭证层形态下这一页讲的是端点与
          provider 的规模，不讲主模型——那是 per-agent 的事，归「代理」页概览。 */}
      <PageHead
        title={t("models.pageTitle")}
        subtitle={
          // 形态未知时只说「加载中」：这时报目录统计等于把旧形态的口径先亮出来。
          // providerDirectory 形态（OpenClaw 提供方主体）与 Hermes 同款副标题——
          // 页面内容就是共享凭证层，模型统计没有对应物（网格已随 R359 移除）。
          !shapeReady
            ? t("common.loading")
            : showProviders || showDirectoryPane
              ? t("models.providersSubtitle")
              : loading && displayModels.length === 0
                ? t("common.loading")
                : t("models.statLine", { count: displayModels.length, providers: providerOptions.length })
        }
        actions={
          showModelsPane ? (
            <SearchCapsule value={query} onChange={setQuery} placeholder={t("models.searchPlaceholder")} />
          ) : undefined
        }
      />
      <div className="ui-toolbar">
        <BackendTabs value={backend} onChange={handleBackendChange} surface="models" />
        {showModelsPane && providerOptions.length > 1 && (
          <FilterTabs
            scrollable
            toggleOff=""
            value={providerFilter}
            onChange={setProviderFilter}
            ariaLabel={t("models.providerFilterAria")}
            items={[
              { value: "", label: t("models.providerAll") },
              ...providerOptions.map((p) => ({ value: p, label: p, title: p })),
            ]}
          />
        )}
        <span className="ui-toolbar-end">
          {showModelsPane && hasEnvCreds && (
            <button className="ui-cbtn" onClick={() => setCredsOpen(true)}>{t("models.credsBtn")}</button>
          )}
          {showModelsPane && (
            <button
              className="ui-cbtn ui-cbtn--gold"
              onClick={() => showEditor({ mode: "create" })}
              disabled={!effective.create}
              title={!effective.create ? capabilityReadOnlyReason || t("models.capabilityUnsupported") : undefined}
            >
              {t("models.addModel")}
            </button>
          )}
        </span>
      </div>

      {accountBackend && <ModelAccounts key={backend} backend={accountBackend} refreshKey={accountRefreshKey}
        onChanged={() => void refreshAccountsAndModels()} />}

      {/* 目录写能力相关的两条横幅只对目录形态有意义（整合设置面里没有目录写入口）。 */}
      {showCatalog && capabilityReadOnlyReason && (
        <div className="ui-banner ui-banner--warn" role="status">
          <span>{t("models.capabilityReadOnly", { reason: capabilityReadOnlyReason })}</span>
        </div>
      )}
      {showCatalog && configOnlyMode && !pendingActivation && (
        <div className="ui-banner" role="status">
          {/* 文案按能力驱动：无 activation 的后端（如 Hermes）写完即对新会话生效。 */}
          <span>{t(configWrite?.activation ? "models.configOnlyBanner" : "models.configOnlyBannerAuto")}</span>
        </div>
      )}
      {pendingActivation?.kind === "gateway_restart" && (
        <div className="ui-banner ui-banner--warn" role="status">
          <span>{t("models.activationPending")}</span>
          {pendingActivation.available !== false && (
            <button className="ui-cbtn ui-cbtn--sm" onClick={doActivate} disabled={activating}>
              {activating ? t("models.activating") : t("models.activateNow")}
            </button>
          )}
        </div>
      )}
      {/* 草稿横幅:操作先暂存,一次批量提交=一次网关配置写(绕开 3 次/60s 限流逐发等待) */}
      {draftOps.length > 0 && (
        <div className="ui-banner ui-banner--warn" role="status">
          <span>{t("models.draftCount", { count: draftOps.length })}</span>
          <button className="ui-cbtn ui-cbtn--sm ui-cbtn--gold" onClick={doCommitDraft} disabled={committingDraft}>
            {committingDraft ? t("models.draftCommitting") : t("models.draftCommit")}
          </button>
          <button className="ui-cbtn ui-cbtn--sm" onClick={() => setDraftOps([])} disabled={committingDraft}>
            {t("models.draftDiscard")}
          </button>
        </div>
      )}

      {(error || catalogError) && (
        <div className="error">{t("models.error", { msg: error || catalogError })}</div>
      )}
      {showModelsPane && !loading && !error && displayModels.length === 0 && (
        <p className="muted">{t("models.empty")}</p>
      )}
      {showModelsPane && !loading && !error && displayModels.length > 0 && visibleModels.length === 0 && (
        <div className="ui-empty">{t("models.noMatch")}</div>
      )}

      {/* 模型配置 per-agent 的后端（Hermes）：本页 = **跨 agent 共享**的凭证层
          （读聚合、写广播到每个 Profile）。per-agent 的主模型/参数/辅助模型/MoA/
          回退链在「代理」页每个 agent 的概览里，本页不再有 Profile 作用域概念。 */}
      {showProviders && (
        <div className={styles.pane}>
          {/* 不再套外层白卡：KeysPanel 里的每张卡自己就是一张卡（设计稿 6958-135
              的 OAuth / API Keys 两张），再包一层会变成卡中卡。
              自定义端点走插槽，排在「模型 Provider」与「工具密钥」之间——它和上面的
              provider 目录是一件事的两半（内置 provider 填密钥 / 自建 provider 填地址）。
              R296 起端点写广播到全部 Profile → 它和密钥一样是跨 agent 的东西，归本页。 */}
          <KeysPanel
            id={KEYS_ANCHOR}
            endpointsSlot={
              <CustomEndpointsPanel
                key={backend}
                active={showProviders}
                controller={endpointController}
                anchorId={ENDPOINTS_ANCHOR}
                onChanged={() => void refresh()}
                onActivation={noteActivation}
              />
            }
          />
        </div>
      )}

      {/* OpenClaw 提供方主体：OAuth 卡 + Provider 目录卡 + 工具密钥卡（数据链路独立
          于 Hermes KeysPanel，观感复用其卡片样式；保存结果的 activation 汇入本页统一
          的待生效横幅）。 */}
      {showDirectoryPane && (
        <div className={styles.pane}>
          <OpenClawProvidersPane
            backend={backend}
            active={showDirectoryPane}
            onActivation={noteActivation}
          />
        </div>
      )}

      {showModelsPane && !loading &&
        groups.map(([provider, list]) => (
          <div key={provider} className="model-group">
            {/* 分组头走全站统一的 .ui-secthead：18/24·500 + 计数 chip，不再用 hairline 下划线分隔。 */}
            <div className="ui-secthead">
              <span className="ui-secthead-title model-provider">{provider}</span>
              <span className="ui-count">{list.length}</span>
              {configProviderByKey.has(provider) ? (
                // 组头只留一个入口;config 与授权 profile 共存时,授权管理从
                // 编辑端点弹窗内进入(见 providerSection 尾部)。
                <button className="ui-cbtn ui-cbtn--sm" onClick={() => openEditProvider(configProviderByKey.get(provider)!)}>
                  {/* 纯凭证池 provider 没有可编辑的 Key/端点——入口如实叫「凭证」 */}
                  {configProviderByKey.get(provider)!.editable === false
                    ? t("models.credentialsButton")
                    : t("models.editProvider")}
                </button>
              ) : canManageAuthProfiles ? (
                // 配置中没有凭证条目时，只在后端明确提供授权管理能力时显示入口。
                <button
                  type="button"
                  className="ui-cbtn ui-cbtn--sm"
                  title={t("models.authManageTip")}
                  onClick={() => void openAuthManage(provider)}
                >
                  {t("models.managedProvider")}
                </button>
              ) : null}
            </div>
            <div className="model-grid">
              {list.map((rawModel) => {
                const m = rawModel as DraftedModel;
                const active = Object.entries(byScope).some(([scopeId, v]) =>
                  modelMatchesScope(m, v, providerByScope[scopeId], displayModels),
                );
                return (
                  <button
                    type="button"
                    // 草稿卡可能与原卡撞 provider+id（如新增已存在的 ID），key 必须再分层
                    key={m.__draft ? `${modelIdentity(m)}:${m.__draft}:${m.__draftIndex}` : modelIdentity(m)}
                    className="model-card clickable model-card-button"
                    // 草稿卡:半透明标记待提交状态,点击=撤销该草稿项
                    style={m.__draft ? { opacity: 0.5 } : undefined}
                    title={m.__draft ? t("models.draftUndoTip") : undefined}
                    onClick={() => (m.__draft !== undefined && m.__draftIndex !== undefined
                      ? removeDraftAt(m.__draftIndex)
                      : openDetail(m))}
                  >
                    <div className="model-name" title={m.name}>
                      {m.name}
                    </div>
                    <div className="model-meta mono" title={m.id}>
                      {m.id}
                    </div>
                    <div className="model-tags">
                      {m.__draft === "delete" && <span className="tag tag-active">{t("models.draftDeleteTag")}</span>}
                      {m.__draft === "rename" && <span className="tag tag-active">{t("models.draftRenameTag")}</span>}
                      {m.__draft === "create" && <span className="tag tag-active">{t("models.draftCreateTag")}</span>}
                      {active && <span className="tag tag-active">{t("models.activeTag")}</span>}
                      {customByCatalogId.has(customKey(m.provider, m.id)) && <span className="tag">{t("models.customTag")}</span>}
                      {m.reasoning && <span className="tag tag-reason">{t("common.reasoning")}</span>}
                      {typeof m.contextWindow === "number" && m.contextWindow > 0 && (
                        <span className="tag">{Math.round(m.contextWindow / 1000)}K ctx</span>
                      )}
                      {m.pricing?.free && <span className="tag">{t("models.free")}</span>}
                      {!m.pricing?.free && m.pricing?.input && (
                        <span className="tag" title={`in ${m.pricing.input} · out ${m.pricing.output || "—"} / Mtok`}>
                          {m.pricing.input}/M
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}

      <Modal
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.name}
        subtitle={selected?.id}
        footer={
          selected && (
            <>
              {backend === "hermes" && scopes.length > 0 && (
                <button className="btn-primary" onClick={doSetActive} disabled={setting || !scope}>
                  {setting ? t("models.setting") : t("models.setActive")}
                </button>
              )}
              {(customByCatalogId.has(customKey(selected.provider, selected.id))
                // 目录模型:受管 provider + 后端声明 allowlist 改名 → 可改模型 ID
                || (effective.renameCatalogModel === true && configProviderByKey.has(selected.provider))) && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => openModelEditor(selected)}
                  disabled={customByCatalogId.has(customKey(selected.provider, selected.id)) && !effective.update}
                  title={!effective.update ? t("models.capabilityUnsupported") : undefined}
                >
                  {t("models.editModel")}
                </button>
              )}
              {(customByCatalogId.has(customKey(selected.provider, selected.id))
                // 目录模型:provider 受管(config/auth 条目)且后端声明 allowlist 删除
                || (effective.deleteCatalogModel === true && configProviderByKey.has(selected.provider))) && (
                <button className="btn-danger" onClick={doRemove} disabled={removing || !effective.delete}>
                  {removing ? t("models.deleting") : t("models.deleteModel")}
                </button>
              )}
            </>
          )
        }
      >
        {selected && (
          <>
            <ModalSection title={t("models.specs")}>
              <DetailRow label={t("models.providerField")}>{selected.provider || "—"}</DetailRow>
              <DetailRow label={t("models.modelId")}>
                <span className="mono">{selected.id}</span>
              </DetailRow>
              {typeof selected.contextWindow === "number" && selected.contextWindow > 0 && (
                <DetailRow label={t("models.contextWindow")}>
                  {selected.contextWindow.toLocaleString()} tokens
                </DetailRow>
              )}
              <DetailRow label={t("models.reasoningModel")}>{selected.reasoning ? t("models.yes") : t("models.no")}</DetailRow>
              {selected.pricing && (
                <DetailRow label={t("models.pricing")}>
                  {selected.pricing.free ? (
                    t("models.free")
                  ) : (
                    <span className="mono">
                      in {selected.pricing.input || "—"} · out {selected.pricing.output || "—"}
                      {selected.pricing.cache ? ` · cache ${selected.pricing.cache}` : ""} / Mtok
                    </span>
                  )}
                </DetailRow>
              )}
            </ModalSection>

            {backend === "hermes" && scopes.length > 0 && (
              <ModalSection title={t("models.setActive")}>
                <Field label={t("models.targetProfile")} hint={t("models.targetProfileHint")}>
                  <Select value={scope} onChange={(v) => setScope(v)}>
                    {scopes.map((s) => (
                      <Option key={s} value={s}>
                        {s}
                        {byScope[s] ? t("models.current", { model: byScope[s] }) : ""}
                      </Option>
                    ))}
                  </Select>
                </Field>
              </ModalSection>
            )}

            <ModalSection title={backend === "hermes" ? t("models.usedByProfiles") : t("models.usedByAgents")}>
              {usedBy(selected).length === 0 ? (
                <p className="muted">{t("models.none")}</p>
              ) : (
                <div className="chip-row">
                  {usedBy(selected).map((a) => (
                    <span key={a} className="chip-meta">
                      {a}
                    </span>
                  ))}
                </div>
              )}
            </ModalSection>

            {selected && !customByCatalogId.has(customKey(selected.provider, selected.id)) && (
              <p className="muted">
                {effective.deleteCatalogModel === true && configProviderByKey.has(selected.provider)
                  // 受管 provider 的目录模型:元数据来自上游改不了,但可从可用列表删除
                  ? t("models.catalogModelDeletableHint")
                  : t("models.catalogModelHint")}
              </p>
            )}
            {backend === "openclaw" && (
              <p className="muted">
                {t("models.openclawHint")}
              </p>
            )}
          </>
        )}
      </Modal>

      {/* 目录形态（无整合设置面的后端）：provider 端点/凭证仍走弹窗。
          整合设置面形态下同一份表单就地展开在「提供方」页签里，不再开浮层。 */}
      <Modal
        open={!!editProvider && showCatalog}
        onClose={requestCloseEditProvider}
        dismissible={!savingProvider}
        title={editProvider?.editable === false ? t("models.providerCredentialsTitle") : t("models.editProviderTitle")}
        subtitle={editProvider?.key}
        footer={providerFormActions}
      >
        {providerFormBody}
      </Modal>

      <Modal
        open={credsOpen}
        onClose={() => setCredsOpen(false)}
        title={t("models.credsTitle")}
        subtitle={t("models.credsSubtitle")}
        width={760}
      >
        {credsOpen && <KeysPanel />}
      </Modal>

      <Modal
        open={canManageAuthProfiles && !!authManage}
        onClose={() => !authBusy && setAuthManage(null)}
        title={t("models.authManageTitle")}
        subtitle={authManage || ""}
      >
        {authManage && (
          <ModalSection title={t("models.authProfilesSection")}>
            {authProfiles === null && <p className="muted">{t("common.loading")}</p>}
            {authProfiles !== null && !authSupported && (
              <p className="muted">{t("models.authUnsupported")}</p>
            )}
            {authProfiles !== null && authSupported && authProfiles.length === 0 && (
              <p className="muted">{t("models.authNoProfiles")}</p>
            )}
            {(authProfiles || []).map((p) => (
              <div key={p.id} className={styles.authProfileRow}>
                <div>
                  <div className="mono">{p.id}</div>
                  <div className="muted">
                    {p.type}
                    {p.keyTail ? ` · ${t("models.authKeyTail", { tail: p.keyTail })}` : ""}
                    {p.email ? ` · ${p.email}` : ""}
                    {typeof p.expires === "number" && p.expires > 0
                      ? ` · ${p.expires <= Date.now() ? t("models.authExpired") : t("models.authExpires", { date: new Date(p.expires).toLocaleDateString() })}`
                      : ""}
                    {/* gateway 登录(CLI/OAuth)直写各 agent 凭证库,主文件里没有——标注真实存放层 */}
                    {p.source === "agents"
                      ? ` · ${t("models.authInAgents", { count: p.agentCount ?? 0 })}`
                      : p.source === "both" && (p.agentCount ?? 0) > 0
                        ? ` · ${t("models.authInBoth", { count: p.agentCount ?? 0 })}`
                        : ""}
                  </div>
                </div>
                <button className="btn-danger" disabled={authBusy} onClick={() => void doDeleteAuth(p)}>
                  {t("models.authDeleteProfile")}
                </button>
              </div>
            ))}
            {authSupported && (
              <>
                {(authProfiles || []).some((p) => p.type !== "api_key") && (
                  <p className="muted">{t("models.authOauthHint")}</p>
                )}
                {/* Key 输入框只对已有 api_key 授权的 provider 开放(换 Key)。
                    OAuth/CLI 登录类(xai/anthropic 等)没有可写的 Key——只显示
                    授权记录与删除按钮,不给输入框造成误导。 */}
                {(authProfiles || []).some((p) => p.type === "api_key") && (
                  <>
                    <Field label={t("models.authKeyLabel")}>
                      <TextInput
                        type="password"
                        value={authKeyInput}
                        onChange={(e) => setAuthKeyInput(e.target.value)}
                        placeholder="sk-..."
                      />
                    </Field>
                    <button
                      className="btn-primary"
                      disabled={authBusy || !authKeyInput.trim()}
                      onClick={() => void doSaveAuthKey()}
                    >
                      {authBusy ? t("common.loading") : t("models.authSaveKey")}
                    </button>
                  </>
                )}
              </>
            )}
          </ModalSection>
        )}
      </Modal>

      {editor && (
        <ModelEditorDrawer
          key={editor.generation}
          mode={editor.mode}
          backend={backend}
          providers={config.providers}
          model={editor.model}
          capabilities={effective}
          catalogOnly={editor.catalogOnly}
          onDraft={draftEnabled ? (op) => {
            setDraftOps((ops) => [...ops, op.kind === "rename"
              ? { op: "rename", providerKey: op.providerKey, sourceModelId: op.sourceModelId!, newId: op.modelId }
              : { op: "create", providerKey: op.providerKey, modelId: op.modelId,
                  name: op.name, contextWindow: op.contextWindow, maxTokens: op.maxTokens, reasoning: op.reasoning }]);
            setEditorOpen(false);
            toast.success(t("models.draftAdded"));
          } : undefined}
          open={editorOpen}
          onApplied={handleCatalogApplied}
          onActivation={noteActivation}
          onRequestClose={() => setEditorOpen(false)}
          onOpenChangeComplete={(open) => {
            if (!open) setEditor(null);
          }}
        />
      )}
    </div>
  );
}
