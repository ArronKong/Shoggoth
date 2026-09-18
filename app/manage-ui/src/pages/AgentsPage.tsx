import AgentAvatarView from "../components/AgentAvatar";
import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { PageHead } from "../components/PageHead";
import type {
  AgentComputerState,
  DashboardArtifactItem,
  AgentDefinitionState,
  AgentMemoryPage,
  AgentTranscriptEvent,
  AgentTranscriptSession,
  AgentToolsState,
  ShoggothProviderSnapshot,
  UnifiedAgent,
  UnifiedAgentDetail,
  UnifiedCronJob,
  UnifiedModel,
} from "../types";
import {
  ApiError,
  createAgent,
  deleteAgent,
  exportAgentDefinition,
  getAgent,
  getAgentComputerState,
  getDesktopComputerPermissions,
  getAgentDefinition,
  getAgentFile,
  getModelCatalog,
  getShoggothProviders,
  importAgentDefinition,
  listAgentArtifacts,
  listAgentMemories,
  listAgents,
  listCronJobs,
  listAgentTools,
  listAgentTranscripts,
  mutateAgentMemory,
  openDesktopComputerScreenRecordingSettings,
  openPath,
  restoreAgent,
  restoreAgentDefinition,
  requestDesktopComputerPermissions,
  runCronJob,
  setAgentFile,
  setAgentToolPermission,
  setAgentTranscriptContext,
  setCronEnabled,
  updateAgent,
} from "../api/client";
import {
  readModelCatalog,
  revalidateModelCatalog,
  subscribeModelCatalog,
} from "../model-catalog-store";
import ChatModelMenu from "./ChatModelMenu";
import BackendTabs from "../components/BackendTabs";
import FilterTabs from "../components/FilterTabs";
import { cronForceRunResumesPaused, useBackendCatalog, useBackendState } from "../lib/backends";
import Modal, { ModalSection } from "../components/Modal";
import { Field, Switch, TextInput } from "../components/Field";
import { usePageCache } from "../lib/usePageCache";
import { useRegisterPageRefresh, useRegisterPageLoading } from "../lib/page-refresh";
import { useStickyState } from "../lib/useStickyState";
import { useNavigationGuard, useNavigationRequest } from "../lib/navigation-guard";
import { createTargetRequestGuard } from "../lib/lowUiLifecycle";
import { classifyAgentCreateError, openclawWorkspacePlaceholder } from "../lib/agent-create-error";
import { useConfirm, useToast } from "../components/ui";
import { ShoggothProviderSetup } from "../components/ShoggothProviderSetup";
import { useAgentModelSettings } from "./agents/useAgentModelSettings";
import AgentMainModelField from "./agents/AgentMainModelField";
import AgentModelCards from "./agents/AgentModelCards";
import EmojiField from "./agents/EmojiField";
import s from "./AgentsPage.module.css";

const AgentInspirationPanel = lazy(() => import("./InspirationPage").then(module => ({ default: module.AgentInspirationPanel })));

type Tab = "overview" | "setup" | "memory" | "history" | "tools" | "computer" | "cron" | "inspiration" | "artifacts";
const HIDDEN_NATIVE_TABS = new Set<Tab>(["memory", "history", "tools", "computer"]);

type LifecycleRetryOperation = { target: string; operationId: string; createdAt: number };
const RETRYABLE_LIFECYCLE_CODES = new Set([
  "AGENT_INITIALIZATION_FAILED",
  "AGENT_RUNTIME_CLEANUP_FAILED",
  "AGENT_COMMIT_UNCERTAIN",
  "AGENT_SERVICE_CLOSED",
  "REQUEST_TIMEOUT",
]);

function retainLifecycleOperation(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status >= 500 || RETRYABLE_LIFECYCLE_CODES.has(error.code || "");
}

function lifecycleOperation(prefix: string, target: string): LifecycleRetryOperation {
  return {
    target,
    operationId: `${prefix}-${globalThis.crypto.randomUUID()}`,
    createdAt: Date.now(),
  };
}

function emptyCreateDraft() {
  return {
    name: "",
    workspace: "",
    model: "",
    cloneFromDefault: true,
    noSkills: false,
  };
}

// agent 的 model 字段是 "<provider>/<modelId>"（modelId 自身可能还含 "/"，如
// modelscope/deepseek-ai/DeepSeek-V4-Pro）——只在第一个斜杠处切开。
function splitModelRef(ref: string): { provider?: string; id: string } {
  const i = ref.indexOf("/");
  if (i <= 0) return { id: ref };
  return { provider: ref.slice(0, i), id: ref.slice(i + 1) };
}

// Setup 左栏的展示名：去掉 .md 后缀再大写（设计稿口径 AGENTS/SOUL/…）。
function fileDisplayName(name: string): string {
  return name.replace(/\.md$/i, "").toUpperCase();
}

function fileTargetKey(backend: string, detail: UnifiedAgentDetail, name: string): string {
  return [backend, detail.id, detail.profile || "", name].join("\u0000");
}

export default function AgentsPage() {
  const [backend, setBackend] = useBackendState("agents", undefined, { surface: "agents" });
  const backendCatalog = useBackendCatalog("agents");
  const backendDescriptors = useMemo(
    () => new Map(backendCatalog.map((descriptor) => [descriptor.id, descriptor])),
    [backendCatalog],
  );
  const activeBackendDescriptor = backendDescriptors.get(backend);
  const backendName = activeBackendDescriptor?.name || backend;
  const hasAgentHarness = activeBackendDescriptor?.surfaces.agentHarness === true;
  const agentLifecycle = activeBackendDescriptor?.agentLifecycle;
  const canCreateAgent = agentLifecycle?.create === true;
  const canUpdateAgent = agentLifecycle?.update === true;
  const canRemoveAgent = agentLifecycle?.remove === true;
  const canArchiveAgent = agentLifecycle?.archive === true;
  const canRestoreAgent = agentLifecycle?.restore === true;
  const runWillResumePaused = (job: UnifiedCronJob) => (
    cronForceRunResumesPaused(backendDescriptors.get(job.backendId), job)
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<UnifiedAgentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [savedTab, setTab] = useStickyState<Tab>("agents.tab", "overview");
  // 旧缓存也先回到概览，避免隐藏页签的内容闪现或触发数据加载。
  const tab = HIDDEN_NATIVE_TABS.has(savedTab) ? "overview" : savedTab;

  // overview edit
  const [form, setForm] = useState<{ name: string; model: string; emoji: string; fallbacks: string[] }>({
    name: "",
    model: "",
    emoji: "",
    fallbacks: [],
  });
  const [savingOverview, setSavingOverview] = useState(false);

  // files（Setup 页签）。阅读态点击进入编辑态，Esc 放弃、Save 写回。
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const [savingFile, setSavingFile] = useState(false);
  const [fileEditing, setFileEditing] = useState(false);
  const [fileReadOnly, setFileReadOnly] = useState(false);
  const fileOrigRef = useRef("");
  const fileTargetRef = useRef<string | null>(null);
  const fileRequestGuardRef = useRef<ReturnType<typeof createTargetRequestGuard> | null>(null);
  if (!fileRequestGuardRef.current) fileRequestGuardRef.current = createTargetRequestGuard();
  const fileRequestGuard = fileRequestGuardRef.current;

  const [definition, setDefinition] = useState<AgentDefinitionState | null>(null);
  const [memories, setMemories] = useState<AgentMemoryPage | null>(null);
  const [memoryDrafts, setMemoryDrafts] = useState<Record<string, string>>({});
  const [transcriptSessions, setTranscriptSessions] = useState<AgentTranscriptSession[] | null>(null);
  const [transcriptSessionsCursor, setTranscriptSessionsCursor] = useState(0);
  const [transcriptSessionsHasMore, setTranscriptSessionsHasMore] = useState(false);
  const [transcriptSessionId, setTranscriptSessionId] = useState<string | null>(null);
  const [transcriptEvents, setTranscriptEvents] = useState<AgentTranscriptEvent[] | null>(null);
  const [transcriptEventsCursor, setTranscriptEventsCursor] = useState(0);
  const [transcriptEventsHasMore, setTranscriptEventsHasMore] = useState(false);
  const [transcriptRevision, setTranscriptRevision] = useState(0);
  const [harnessLoadingMore, setHarnessLoadingMore] = useState(false);
  const [toolsState, setToolsState] = useState<AgentToolsState | null>(null);
  const [computerState, setComputerState] = useState<AgentComputerState | null>(null);
  const [computerPermissionBusy, setComputerPermissionBusy] = useState(false);
  const [shoggothProviderSnapshot, setShoggothProviderSnapshot] = useState<ShoggothProviderSnapshot | null>(null);
  const harnessImportRef = useRef<HTMLInputElement>(null);

  // cron + 产出文件 (lazy)。
  const [agentCron, setAgentCron] = useState<UnifiedCronJob[] | null>(null);
  const [artifacts, setArtifacts] = useState<
    { supported: boolean; reason?: string; total?: number; items: DashboardArtifactItem[] } | null
  >(null);

  // 模型目录（Overview 的模型选择器）——与聊天页同一个共享 revision store
  const [models, setModels] = useState<UnifiedModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  // create
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState(emptyCreateDraft);
  const [savingCreate, setSavingCreate] = useState(false);
  const createOperationRef = useRef<LifecycleRetryOperation | null>(null);
  const archiveOperationRef = useRef<LifecycleRetryOperation | null>(null);
  const restoreOperationRef = useRef<LifecycleRetryOperation | null>(null);

  useEffect(() => {
    createOperationRef.current = null;
  }, [backend, createDraft]);

  // 左上角头像的悬浮 agent 列表（进入头像展开、移出浮层收起）
  const [holoOpen, setHoloOpen] = useState(false);

  // 展开/收起形变的开关（实现在下方 openFromCard / closeDetail 与各自的
  // useLayoutEffect）。声明必须放在这里——下面的 deck 副作用依赖 closing。
  // closing 期间**列表与面板同时挂载**（面板 fixed 盖在列表之上），才能量到
  // 目标卡片的落点；动效跑完才真正卸载面板。
  const [morphing, setMorphing] = useState(false);
  const [closing, setClosing] = useState(false);

  const toast = useToast();
  const confirm = useConfirm();
  const { t } = useTranslation();
  const requestNavigation = useNavigationRequest();

  // Hermes 的 updateAgent 只支持改名（模型等配置属于 profile，由本页概览的
  // per-agent 设置面直接写），所以 updateAgent 的模型选择器只在能写回模型的后端
  // 出现——沿用本页既有的同一条件，不新增分叉。
  const modelEditable = backend === "openclaw";

  const { data: agentsData, loading, error, refresh } = usePageCache(
    `agents:${backend}`,
    () => listAgents(backend),
  );
  const { data: archivedData, refresh: refreshArchived } = usePageCache(
    `agents:${backend}:archived`,
    () => (canRestoreAgent ? listAgents(backend, { lifecycle: "archived" }) : Promise.resolve([])),
  );
  const agents = agentsData ?? [];
  const archivedAgents = archivedData ?? [];
  // 刷新同时重拉 per-agent 模型设置面快照（同 ModelsPage 的 doRefresh 口径）。
  // 回传 refresh 的 promise：导航栏刷新要等数据落地才弹 toast。
  const [modelReload, setModelReload] = useState(0);
  const doRefresh = () => {
    setModelReload((n) => n + 1);
    return Promise.all([refresh(), refreshArchived()]).then(() => undefined);
  };
  useRegisterPageRefresh("/agents", doRefresh);
  useRegisterPageLoading("/agents", loading);

  // 每次打开详情领一个序号。OpenClaw(本地 WS) 与 Hermes(HTTP，可能是远端) 延迟差很大，
  // 连点两个 agent 时先点的那个若后返回，会把已经渲染好的另一个 agent 的详情覆盖掉
  // ——高亮 B、面板却是 A，此时点保存会写到 A。
  const detailReqRef = useRef(0);

  const openDetail = async (id: string) => {
    const seq = ++detailReqRef.current;
    fileRequestGuard.invalidate();
    fileTargetRef.current = null;
    fileOrigRef.current = "";
    setTab("overview");
    setDetail(null);
    setActiveFile(null);
    setFileLoading(false);
    setFileEditing(false);
    setFileReadOnly(false);
    setDefinition(null);
    setMemories(null);
    setMemoryDrafts({});
    setTranscriptSessions(null);
    setTranscriptSessionsCursor(0);
    setTranscriptSessionsHasMore(false);
    setTranscriptSessionId(null);
    setTranscriptEvents(null);
    setTranscriptEventsCursor(0);
    setTranscriptEventsHasMore(false);
    setToolsState(null);
    setComputerState(null);
    setShoggothProviderSnapshot(null);
    setAgentCron(null);
    setArtifacts(null);
    setDetailLoading(true);
    try {
      const d = await getAgent(backend, id);
      if (seq !== detailReqRef.current) return; // 已被更新的选择取代
      setDetail(d);
      setForm({
        name: d.name || "",
        model: d.model || "",
        emoji: d.emoji || "",
        fallbacks: d.fallbacks || [],
      });
    } catch (e) {
      if (seq !== detailReqRef.current) return;
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === detailReqRef.current) setDetailLoading(false);
    }
  };

  const selectAgent = (id: string) => {
    setSelectedId(id);
    openDetail(id);
  };

  // 主模型改完后只把 detail 的服务端真值刷新一遍（左侧卡片的模型/提供方跟着变）。
  // 故意不复用 openDetail：那会 setDetail(null) 并清空 kanban/cron/artifacts/文件缓存，
  // 面板闪一下还丢掉其他页签已加载的数据。也故意不回写 form —— form 是用户的编辑
  // 草稿（改名），覆写会冲掉未保存的输入并让 overviewDirty 误判。
  const reloadDetail = async () => {
    if (!selectedId) return;
    const seq = detailReqRef.current;
    try {
      const d = await getAgent(backend, selectedId);
      if (seq === detailReqRef.current) setDetail(d);
    } catch {
      /* 卡片显示的是上一次真值，静默即可（设置面自己会报写入错误） */
    }
  };

  // per-agent 模型设置面（主模型/默认参数/辅助模型/MoA/回退链）。作用域 = 当前 agent
  // 的 profile；后端不提供整合设置面时快照回报 supported:false，两个视图各自隐身。
  const modelSettings = useAgentModelSettings({
    backend,
    profile: detail?.profile,
    reloadToken: modelReload,
    onMainModelChanged: () => void reloadDetail(),
    // 凭证与自定义端点是跨 agent 的全局层 → 引导跳模型页对应区（走 guard，带未保存提醒）。
    onNavigate: (section) => {
      requestNavigation(`/models?section=${section}`);
    },
  });

  // 真正收起（不带动效）。反向形变跑完后、以及无动效场景直接调它。
  const hardClose = () => {
    detailReqRef.current++; // 在途的详情响应作废
    fileRequestGuard.invalidate();
    fileTargetRef.current = null;
    setFileLoading(false);
    setSelectedId(null);
    setDetail(null);
    setHoloOpen(false);
  };

  // 首页 = 卡片列表，不自动展开；但展开中的 agent 从列表消失（切后端/删除）时收起面板。
  useEffect(() => {
    if (selectedId && !loading && !agents.some((a) => a.id === selectedId)) hardClose();
  }, [agents, loading]);

  // 卡片横滑支持鼠标竖直滚轮（非被动监听才能 preventDefault，不连带滚动页面）。
  const deckRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = deckRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [selectedId, closing, loading, agents.length]);

  // 卡片相对**整个窗口**垂直居中所需的两个量（配 AgentsPage.module.css 的 .deck）：
  // 上方页头区实高与页面下内边距。必须实测——BackendTabs 只连一个后端时整组隐藏、
  // toolbar 塌成 0 高，页头也会随窄屏换行，写死常量当场偏掉。
  useLayoutEffect(() => {
    const el = deckRef.current;
    const page = el?.parentElement;
    if (!el || !page) return;
    const sync = () => {
      const above = el.getBoundingClientRect().top - page.getBoundingClientRect().top;
      el.style.setProperty("--deck-above", `${Math.max(0, Math.round(above))}px`);
      el.style.setProperty("--deck-below", getComputedStyle(page).paddingBottom || "0px");
    };
    sync();
    // 必须观察 deck 的**前置兄弟**（页头、toolbar）——推动 deck 上沿的是它们的高度。
    // 只观察 page 不行：page 是 main 的 flex item，高度恒等于视口，toolbar 从 0 长到
    // 48px 时它纹丝不动，回调根本不触发（实踩）。page 仍要观察，窗口缩放时同步下内边距。
    // 依赖里的 closing 不能少：收起动效期间列表会先于面板卸载挂载出来，此时不重测，
    // 居中量就还是 CSS 默认的 0，等面板卸载后才补算——卡片会在动效收尾跳一下（实踩）。
    const ro = new ResizeObserver(sync);
    ro.observe(page);
    for (const sib of page.children) if (sib !== el) ro.observe(sib);
    return () => ro.disconnect();
  }, [selectedId, closing, loading, agents.length]);

  // lazy-load per-tab data。切走 agent 后迟到的响应不能写进新 agent 的面板。
  useEffect(() => {
    if (!detail) return;
    const agentId = detail.id;
    let alive = true;
    if (tab === "cron" && agentCron === null) {
      listCronJobs()
        .then((all) => { if (alive) setAgentCron(all.filter((j) => j.backendId === backend && j.agentId === agentId)); })
        .catch(() => { if (alive) setAgentCron([]); });
    }
    if (tab === "artifacts" && artifacts === null) {
      listAgentArtifacts(backend, agentId)
        .then((r) => { if (alive) setArtifacts(r); })
        .catch(() => { if (alive) setArtifacts({ supported: true, items: [] }); });
    }
    // 进 Setup 默认打开第一个 .md（agent 的人设/记忆文件都是 md，没有则退回第一个文件）。
    if (tab === "setup" && !activeFile) {
      const files = detail.files || [];
      const first = files.find((f) => /\.md$/i.test(f.name)) || files[0];
      if (first) void openFile(first.name);
    }
    if (hasAgentHarness && tab === "setup" && definition === null) {
      getAgentDefinition(backend, agentId)
        .then((value) => { if (alive) setDefinition(value); })
        .catch(() => { if (alive) setDefinition(null); });
    }
    if (hasAgentHarness && tab === "memory" && memories === null) {
      listAgentMemories(backend, agentId)
        .then((value) => { if (alive) setMemories(value); })
        .catch(() => { if (alive) setMemories({ supported: true, revision: 0, items: [], nextCursor: 0, hasMore: false }); });
    }
    if (hasAgentHarness && tab === "history" && transcriptSessions === null) {
      listAgentTranscripts(backend, agentId)
        .then((value) => {
          if (!alive || "revision" in value) return;
          setTranscriptSessions(value.items);
          setTranscriptSessionsCursor(value.nextCursor);
          setTranscriptSessionsHasMore(value.hasMore);
        })
        .catch(() => { if (alive) setTranscriptSessions([]); });
    }
    if (hasAgentHarness && tab === "tools" && toolsState === null) {
      listAgentTools(backend, agentId)
        .then((value) => { if (alive) setToolsState(value); })
        .catch(() => { if (alive) setToolsState({ supported: true, registryRevision: "", revision: 1, tools: [] }); });
    }
    if (hasAgentHarness && tab === "computer" && computerState === null) {
      getAgentComputerState(backend, agentId)
        .then((value) => { if (alive) setComputerState(value); })
        .catch(() => { if (alive) setComputerState({
          supported: true, available: false, reason: "unavailable",
          driverVersion: null, contractVersion: null,
          permissions: { accessibility: false, screenRecording: false }, sessions: [],
        }); });
    }
    return () => { alive = false; };
  }, [tab, detail, backend, agentCron, artifacts, activeFile, hasAgentHarness, definition, memories, transcriptSessions, toolsState, computerState]);

  useEffect(() => {
    const profileId = backend === "shoggoth" ? detail?.profile : undefined;
    if (!profileId) {
      setShoggothProviderSnapshot(null);
      return;
    }
    let alive = true;
    void getShoggothProviders(profileId)
      .then((snapshot) => { if (alive) setShoggothProviderSnapshot(snapshot); })
      .catch(() => { if (alive) setShoggothProviderSnapshot(null); });
    return () => { alive = false; };
  }, [backend, detail?.profile]);

  // 模型目录：与聊天页共用同一个 revision store（先同步首屏缓存、订阅 apply、再 revalidate）。
  // 只有能写回模型的后端才需要它。
  useEffect(() => {
    if (!modelEditable) return;
    let alive = true;
    const cached = readModelCatalog(backend);
    setModels(cached?.models || []);
    setModelsLoading(!cached || !!cached.legacyPlaceholder);
    const unsubscribe = subscribeModelCatalog(backend, (snapshot) => {
      if (!alive || snapshot.backendId !== backend || snapshot.legacyPlaceholder) return;
      setModels(snapshot.models);
      setModelsLoading(false);
    });
    void revalidateModelCatalog(backend, (knownRevision) => getModelCatalog(backend, knownRevision))
      .then((snapshot) => {
        if (!alive || snapshot.backendId !== backend || snapshot.legacyPlaceholder) return;
        setModels(snapshot.models);
        setModelsLoading(false);
      })
      // 瞬时失败保留已有快照，不清空选择器。
      .catch(() => {});
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [backend, modelEditable]);

  const openFile = async (name: string) => {
    if (!detail) return;
    const target = fileTargetKey(backend, detail, name);
    const ticket = fileRequestGuard.begin(target);
    fileTargetRef.current = null;
    setActiveFile(name);
    setFileEditing(false);
    setFileLoading(true);
    setFileContent("");
    try {
      const f = await getAgentFile(backend, detail.id, name);
      if (!fileRequestGuard.isCurrent(ticket, target)) return;
      setFileContent(f.content || "");
      setFileReadOnly(f.readOnly === true);
      fileOrigRef.current = f.content || "";
      fileTargetRef.current = target;
    } catch (e) {
      if (!fileRequestGuard.isCurrent(ticket, target)) return;
      setActiveFile(null);
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      if (fileRequestGuard.isCurrent(ticket, target)) setFileLoading(false);
    }
  };

  const saveFile = async () => {
    if (!detail || !activeFile) return;
    const target = fileTargetKey(backend, detail, activeFile);
    if (fileTargetRef.current !== target) {
      toast.error(t("agents.fileTargetChanged"));
      return;
    }
    const targetBackend = backend;
    const targetAgentId = detail.id;
    const targetFile = activeFile;
    const nextContent = fileContent;
    const targetDefinitionRevision = detail.definitionRevision;
    setSavingFile(true);
    try {
      const result = await setAgentFile(
        targetBackend,
        targetAgentId,
        targetFile,
        nextContent,
        targetDefinitionRevision,
      );
      if (fileTargetRef.current !== target) return;
      fileOrigRef.current = nextContent;
      setFileEditing(false);
      if (result?.definitionRevision) {
        setDetail((current) =>
          current?.id === targetAgentId
            ? { ...current, definitionRevision: result.definitionRevision }
            : current,
        );
        const nextDefinition = await getAgentDefinition(targetBackend, targetAgentId);
        if (fileTargetRef.current !== target) return;
        setDefinition(nextDefinition);
      }
      if (fileTargetRef.current === target) {
        toast.success(t("agents.fileSaved", { name: targetFile }));
      }
    } catch (e) {
      if (fileTargetRef.current === target) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSavingFile(false);
    }
  };

  const reloadDefinition = async () => {
    if (!detail) return;
    const next = await getAgentDefinition(backend, detail.id);
    setDefinition(next);
    setDetail({ ...detail, definitionRevision: next.current.revision });
  };

  const restoreDefinition = async (revision: number) => {
    if (!detail?.definitionRevision) return;
    const accepted = await confirm({
      title: t("agents.restoreDefinitionTitle"),
      message: t("agents.restoreDefinitionConfirm", { revision }),
      confirmLabel: t("agents.restore"),
    });
    if (!accepted) return;
    try {
      await restoreAgentDefinition(backend, detail.id, revision, detail.definitionRevision);
      await reloadDefinition();
      if (activeFile) await openFile(activeFile);
      toast.success(t("agents.definitionRestored"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const downloadDefinition = async () => {
    if (!detail) return;
    try {
      const bundle = await exportAgentDefinition(backend, detail.id);
      const blob = new Blob([`${JSON.stringify(bundle, null, 2)}\n`], { type: "application/json" });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = `${detail.id}-definition.json`;
      anchor.click();
      URL.revokeObjectURL(href);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const uploadDefinition = async (file: File) => {
    if (!detail?.definitionRevision) return;
    try {
      const bundle = JSON.parse(await file.text()) as {
        format?: string;
        schemaVersion?: number;
        profileId?: string;
        revision?: number;
        documents?: Record<string, string>;
      };
      if (bundle.format !== "shoggoth-agent-definition-v1" || bundle.schemaVersion !== 1
        || !bundle.profileId || !Number.isSafeInteger(bundle.revision)
        || !bundle.documents || ["IDENTITY", "SOUL", "USER", "AGENTS"]
          .some((kind) => typeof bundle.documents?.[kind] !== "string")) {
        throw new Error(t("agents.definitionImportInvalid"));
      }
      const current = definition || await getAgentDefinition(backend, detail.id);
      const changed: string[] = [];
      for (const kind of ["IDENTITY", "SOUL", "USER", "AGENTS"]) {
        const bytes = new TextEncoder().encode(bundle.documents[kind]);
        const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
          .map((part) => part.toString(16).padStart(2, "0")).join("");
        if (digest !== current.current.documents[kind]?.contentHash) changed.push(kind);
      }
      const accepted = await confirm({
        title: t("agents.importDefinition"),
        message: t("agents.definitionImportPreview", { files: changed.join(", ") || "—" }),
        confirmLabel: t("agents.importDefinition"),
      });
      if (!accepted) return;
      await importAgentDefinition(backend, detail.id, bundle, detail.definitionRevision);
      await reloadDefinition();
      setActiveFile(null);
      toast.success(t("agents.definitionImported"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      if (harnessImportRef.current) harnessImportRef.current.value = "";
    }
  };

  const reloadMemories = async () => {
    if (!detail) return;
    const next = await listAgentMemories(backend, detail.id);
    setMemories(next);
    setMemoryDrafts(Object.fromEntries(next.items.map((item) => [item.id, item.content])));
  };

  const memoryAction = async (action: "confirm" | "update" | "delete", itemId: string) => {
    if (!detail || !memories) return;
    const item = memories.items.find((candidate) => candidate.id === itemId);
    if (!item) return;
    try {
      await mutateAgentMemory(backend, detail.id, action, action === "update" ? {
        id: item.id,
        content: memoryDrafts[item.id] ?? item.content,
        confidence: item.confidence,
        validUntil: item.validUntil,
        expectedRevision: memories.revision,
      } : { id: item.id, expectedRevision: memories.revision });
      await reloadMemories();
      toast.success(t(action === "delete" ? "agents.memoryForgotten" : "agents.memorySaved"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const loadMoreMemories = async () => {
    if (!detail || !memories?.hasMore || harnessLoadingMore) return;
    setHarnessLoadingMore(true);
    try {
      const next = await listAgentMemories(backend, detail.id, undefined, undefined, memories.nextCursor);
      // 索引型 cursor 只在同一 revision 内可拼接；后台若变化就重拉第一页。
      if (next.revision !== memories.revision) await reloadMemories();
      else setMemories({ ...next, items: [...memories.items, ...next.items] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setHarnessLoadingMore(false);
    }
  };

  const loadMoreTranscriptSessions = async () => {
    if (!detail || !transcriptSessionsHasMore || harnessLoadingMore) return;
    setHarnessLoadingMore(true);
    try {
      const next = await listAgentTranscripts(backend, detail.id, undefined, transcriptSessionsCursor);
      if ("revision" in next) return;
      setTranscriptSessions([...(transcriptSessions || []), ...next.items]);
      setTranscriptSessionsCursor(next.nextCursor);
      setTranscriptSessionsHasMore(next.hasMore);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setHarnessLoadingMore(false);
    }
  };

  const openTranscript = async (sessionId: string) => {
    if (!detail) return;
    setTranscriptSessionId(sessionId);
    setTranscriptEvents(null);
    try {
      const result = await listAgentTranscripts(backend, detail.id, sessionId);
      if ("revision" in result) {
        setTranscriptRevision(result.revision);
        setTranscriptEvents(result.items);
        setTranscriptEventsCursor(result.nextCursor);
        setTranscriptEventsHasMore(result.hasMore);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      setTranscriptEvents([]);
    }
  };

  const loadMoreTranscriptEvents = async () => {
    if (!detail || !transcriptSessionId || !transcriptEventsHasMore || harnessLoadingMore) return;
    setHarnessLoadingMore(true);
    try {
      const next = await listAgentTranscripts(
        backend, detail.id, transcriptSessionId, transcriptEventsCursor,
      );
      if (!("revision" in next)) return;
      // contextExcluded 等字段可能刚被另一窗口更新，revision 漂移时不用旧页拼新页。
      if (next.revision !== transcriptRevision) await openTranscript(transcriptSessionId);
      else {
        setTranscriptEvents([...(transcriptEvents || []), ...next.items]);
        setTranscriptEventsCursor(next.nextCursor);
        setTranscriptEventsHasMore(next.hasMore);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setHarnessLoadingMore(false);
    }
  };

  const toggleTranscriptContext = async (event: AgentTranscriptEvent) => {
    if (!detail || !transcriptSessionId) return;
    try {
      await setAgentTranscriptContext(backend, detail.id, {
        sessionId: transcriptSessionId,
        eventId: event.id,
        contextExcluded: !event.contextExcluded,
        expectedRevision: transcriptRevision,
      });
      await openTranscript(transcriptSessionId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleToolPermission = async (toolName: string, effect: "allow" | "deny") => {
    if (!detail || !toolsState) return;
    try {
      await setAgentToolPermission(backend, detail.id, {
        toolName, effect, expectedRevision: toolsState.revision,
      });
      setToolsState(await listAgentTools(backend, detail.id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const refreshComputerState = async () => {
    if (!detail) return;
    const [state, permissions] = await Promise.all([
      getAgentComputerState(backend, detail.id),
      getDesktopComputerPermissions(),
    ]);
    setComputerState({ ...state, permissions });
  };

  const grantComputerPermissions = async () => {
    if (!detail || computerPermissionBusy) return;
    setComputerPermissionBusy(true);
    try {
      const permissions = await requestDesktopComputerPermissions();
      const state = await getAgentComputerState(backend, detail.id);
      setComputerState({ ...state, permissions });
      if (permissions.accessibility && permissions.screenRecording) {
        toast.success(t("agents.computerPermissionGranted"));
      } else {
        toast.error(t("agents.computerPermissionIncomplete"));
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setComputerPermissionBusy(false);
    }
  };

  const openComputerScreenSettings = async () => {
    try {
      await openDesktopComputerScreenRecordingSettings();
      toast.success(t("agents.computerSettingsOpened"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const overviewDirty =
    !!detail &&
    (form.name !== (detail.name || "") ||
      (modelEditable &&
        (form.model !== (detail.model || "") ||
          form.emoji !== (detail.emoji || "") ||
          form.fallbacks.join("\n") !== (detail.fallbacks || []).join("\n"))));
  const fileDirty =
    fileEditing &&
    !!detail &&
    !!activeFile &&
    fileTargetRef.current === fileTargetKey(backend, detail, activeFile) &&
    fileContent !== fileOrigRef.current;

  useNavigationGuard({
    dirty: overviewDirty || fileDirty,
    busy: savingOverview || savingFile,
    onDiscard: () => {
      if (detail) {
        setForm({
          name: detail.name || "",
          model: detail.model || "",
          emoji: detail.emoji || "",
          fallbacks: detail.fallbacks || [],
        });
      }
      setFileContent(fileOrigRef.current);
      setFileEditing(false);
    },
  });

  const saveOverview = async () => {
    if (!detail || !canUpdateAgent) return;
    setSavingOverview(true);
    try {
      // workspace 已改为只读展示，不再随保存写回。model+fallbacks 同属一个配置
      // 节点，必须一起交给后端整节点写（只写 model 会清空 fallbacks）。
      const patch = hasAgentHarness
        ? { name: form.name, expectedUpdatedAt: detail.updatedAt }
        : backend === "hermes"
          ? { name: form.name }
          : { name: form.name, model: form.model, emoji: form.emoji, fallbacks: form.fallbacks };
      // 后端返回**更新后**的 id：Hermes 改名会让 agent id 跟着 profile 名变，
      // 继续用旧 id 重载详情必然 404。
      const nextId = await updateAgent(backend, detail.id, patch);
      toast.success(t("agents.saved"));
      await refresh();
      setSelectedId(nextId);
      await openDetail(nextId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingOverview(false);
    }
  };

  const doDelete = async () => {
    if (!detail || detail.protected || (!canRemoveAgent && !canArchiveAgent)) return;
    const archiving = canArchiveAgent;
    const okToDelete = await confirm({
      title: t(archiving ? "agents.archiveTitle" : "agents.deleteTitle"),
      message: archiving
        ? t("agents.archiveConfirm", { name: detail.name })
        : `${t("agents.deleteConfirm", { name: detail.name })}${
          backend === "openclaw" ? t("agents.deleteHintOpenclaw") : t("agents.deleteHintHermes")
        }`,
      confirmLabel: t(archiving ? "agents.archive" : "common.delete"),
      danger: true,
    });
    if (!okToDelete) return;
    const target = `${backend}\u0000${detail.id}`;
    const operation = archiveOperationRef.current?.target === target
      ? archiveOperationRef.current : lifecycleOperation("agent-archive", target);
    archiveOperationRef.current = operation;
    try {
      await deleteAgent(backend, detail.id, {
        expectedUpdatedAt: detail.updatedAt,
        operationId: operation.operationId,
        createdAt: operation.createdAt,
      });
      archiveOperationRef.current = null;
      toast.success(t(archiving ? "agents.archived" : "agents.deleted"));
      hardClose(); // 卡片马上要从列表消失，别做缩回它的反向形变
      await doRefresh();
    } catch (e) {
      if (!hasAgentHarness || !retainLifecycleOperation(e)) archiveOperationRef.current = null;
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const openCreate = () => {
    if (!canCreateAgent) return;
    createOperationRef.current = null;
    setCreateDraft(emptyCreateDraft());
    setCreating(true);
  };

  const saveCreate = async () => {
    if (!canCreateAgent) return;
    setSavingCreate(true);
    try {
      if (!createDraft.name.trim()) throw new Error(t("agents.nameRequired"));
      const target = `${backend}\u0000${createDraft.name.trim()}\u0000${createDraft.workspace.trim()}`;
      const operation = createOperationRef.current?.target === target
        ? createOperationRef.current : lifecycleOperation("agent-create", target);
      createOperationRef.current = operation;
      const spec = hasAgentHarness
        ? {
            name: createDraft.name.trim(),
            workspace: createDraft.workspace.trim() || undefined,
          }
        : backend === "openclaw"
        ? {
            name: createDraft.name.trim(),
            workspace: createDraft.workspace.trim() || undefined,
            model: createDraft.model.trim() || undefined,
          }
        : {
            name: createDraft.name,
            cloneFromDefault: createDraft.cloneFromDefault,
            noSkills: createDraft.noSkills,
          };
      const created = await createAgent(backend, {
        ...spec,
        operationId: operation.operationId,
        createdAt: operation.createdAt,
      });
      createOperationRef.current = null;
      toast.success(t("agents.created"));
      setCreating(false);
      setCreateDraft(emptyCreateDraft());
      await doRefresh();
      if (hasAgentHarness && created && typeof created === "object"
        && "id" in created && typeof created.id === "string") {
        setSelectedId(created.id);
        await openDetail(created.id);
      }
    } catch (e) {
      if (!hasAgentHarness || !retainLifecycleOperation(e)) createOperationRef.current = null;
      const message = e instanceof Error ? e.message : String(e);
      const kind = classifyAgentCreateError(backend, createDraft.name, message);
      toast.error(kind ? t(`agents.createError.${kind}`) : message);
    } finally {
      setSavingCreate(false);
    }
  };

  const doRestore = async (agent: UnifiedAgent) => {
    if (!canRestoreAgent) return;
    const target = `${backend}\u0000${agent.id}`;
    const operation = restoreOperationRef.current?.target === target
      ? restoreOperationRef.current : lifecycleOperation("agent-restore", target);
    restoreOperationRef.current = operation;
    try {
      await restoreAgent(backend, agent.id, {
        expectedUpdatedAt: agent.updatedAt,
        operationId: operation.operationId,
        createdAt: operation.createdAt,
      });
      restoreOperationRef.current = null;
      toast.success(t("agents.restored"));
      await doRefresh();
    } catch (e) {
      if (!retainLifecycleOperation(e)) restoreOperationRef.current = null;
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  // 降级链的加/减：选中即追加到链尾，再点同一个（或点 chip 的 ×）移除。
  const toggleFallback = (ref: string) => {
    setForm((f) => ({
      ...f,
      fallbacks: f.fallbacks.includes(ref) ? f.fallbacks.filter((x) => x !== ref) : [...f.fallbacks, ref],
    }));
  };

  const openHostPath = async (target: string) => {
    try {
      await openPath(target);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const cronAct = async (fn: () => Promise<void>) => {
    try {
      await fn();
      if (detail) {
        const all = await listCronJobs();
        setAgentCron(all.filter((j) => j.backendId === backend && j.agentId === detail.id));
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const runAgentCron = async (job: UnifiedCronJob) => {
    if (runWillResumePaused(job)) {
      const okToRun = await confirm({
        title: t("cron.runAndEnableTitle"),
        message: t("cron.runAndEnableConfirm", { name: job.name }),
        confirmLabel: t("cron.runAndEnable"),
      });
      if (!okToRun) return;
    }
    await cronAct(() => runCronJob(job.id, "force"));
  };

  const TABS: { key: Tab; label: string }[] = useMemo(
    () => hasAgentHarness
      ? [
          { key: "overview", label: t("agents.tabOverview") },
          { key: "setup", label: t("agents.tabSetup") },
          { key: "cron", label: t("agents.tabCron") },
          { key: "inspiration", label: t("agents.tabInspiration") },
        ]
      : [
          { key: "overview", label: t("agents.tabOverview") },
          { key: "setup", label: t("agents.tabSetup") },
          { key: "cron", label: t("agents.tabCron") },
          { key: "inspiration", label: t("agents.tabInspiration") },
          { key: "artifacts", label: t("agents.tabArtifacts") },
        ],
    [hasAgentHarness, t],
  );

  useEffect(() => {
    if (!TABS.some(item => item.key === savedTab)) setTab("overview");
  }, [TABS, setTab, savedTab]);

  useEffect(() => {
    if (!hasAgentHarness) return;
    setCreating(false);
    if (tab === "artifacts") setTab("overview");
  }, [hasAgentHarness, setTab, tab]);

  // 已知 setup 文件的「作用」一句话（右上角文件名下方）；未知文件给通用描述。
  const fileDesc = (name: string): string => {
    const key = fileDisplayName(name);
    return t(`agents.fileDesc.${key}`, { defaultValue: t("agents.fileDescDefault") });
  };

  const agentNo = (i: number) => `#${String(i + 1).padStart(3, "0")}`;
  const selectedIndex = agents.findIndex((a) => a.id === selectedId);

  // 3D 悬浮倾斜（首页卡 + Overview 内卡共用）：指针相对卡心的位置直写 CSS 变量
  // （绕过 React 渲染，mousemove 高频下零开销），transform 装配在 .tilt3d 里；
  // 纯 CSS 3D 无需 three.js。
  const tiltMove = (e: ReactMouseEvent<HTMLElement>) => {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    el.style.setProperty("--tiltX", `${(py * 9).toFixed(2)}deg`);
    el.style.setProperty("--tiltY", `${(px * 11).toFixed(2)}deg`);
  };
  const tiltReset = (e: ReactMouseEvent<HTMLElement>) => {
    e.currentTarget.style.setProperty("--tiltX", "0deg");
    e.currentTarget.style.setProperty("--tiltY", "0deg");
  };

  // ---- 卡片 → 面板 展开形变（形变的就是面板本体，没有替身）----
  // 点卡时记下卡片与其图片区的起点 rect；面板挂载同帧量出它的自然终点 rect，
  // 然后把面板临时 fixed 住，用 WAAPI 把 几何 + 挖角尺寸 + 圆角 一起从「卡片形状」
  // 跑到「面板形状」，面板里那个**真头像**同步从铺满的方图收成左上角 48px 圆。
  // 动画结束解除 fixed 回流——终点几何即自然几何，回归零位移，也没有任何
  // 「替身交接」可闪（旧版替身方案正是闪烁的来源）。
  const morphFrom = useRef<{ card: DOMRect; art: DOMRect } | null>(null);
  const closeFrom = useRef<DOMRect | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const holoRef = useRef<HTMLDivElement>(null);
  const morphActive = morphing || closing;

  const prefersReducedMotion = () =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // 形变的时间曲线与时长：展开/收起共用一套，保证来回观感一致。
  const MORPH_MS = 320;
  const MORPH_EASE = "cubic-bezier(0.32, 0.72, 0.34, 1)";

  // 面板内容分层淡入：与形变收尾**重叠**（delay < 形变时长），且 tab→内容错开，
  // 避免"形变停住 → 内容整块齐刷刷冒出来"的突兀感。
  const fadeInContents = (panel: HTMLElement): Animation[] => {
    // 每层都必须在 MORPH_MS 之前收尾：几何动画一结束就 setMorphing(false)，
    // effect cleanup 会 cancel 掉**所有**本轮动画——跨过这个点的淡入会被拦腰取消，
    // 透明度当场从半途跳满（实测约 0.53→1 一帧突变）。故 delay + duration ≡ MORPH_MS。
    const seq: [string, number][] = [
      [s.panelTabs, 130],
      [s.panelClose, 155],
      [s.panelBody, 180],
    ];
    const out: Animation[] = [];
    for (const [cls, delay] of seq) {
      const el = panel.querySelector<HTMLElement>(`.${cls}`);
      const a = el?.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: MORPH_MS - delay,
        delay,
        easing: "ease-out",
        // both 而非 backwards：backwards 只在 delay 期保持，动画一结束效果即撤销，
        // 若此刻 .panelMorphing 还没摘掉（它给内容定的是 opacity:0），内容会闪一下
        // 不可见——与 R262 那个「finish 撤销效果」是同一类坑。
        fill: "both",
      });
      if (a) out.push(a);
    }
    return out;
  };

  const closeDetailNow = () => {
    const panel = panelRef.current;
    if (!panel || !morphFrom.current || prefersReducedMotion() || morphing) {
      hardClose();
      return;
    }
    // **必须在这里量**：一旦 .panelMorphing 上身（position:fixed 且四边 auto），
    // 面板立刻脱流 shrink-to-fit，那时再量拿到的是塌缩后的尺寸（实测 1443×1007 → 1086×592），
    // 动画起点就错了，面板会先"跳窄一下"再开始缩。
    closeFrom.current = panel.getBoundingClientRect();
    setHoloOpen(false);
    setClosing(true);
  };

  const closeDetail = () => {
    requestNavigation(closeDetailNow);
  };

  const requestSelectAgent = (id: string) => {
    requestNavigation(() => selectAgent(id));
  };

  const requestTabChange = (next: Tab) => {
    requestNavigation(() => setTab(next));
  };

  const requestOpenFile = (name: string) => {
    requestNavigation(() => void openFile(name));
  };

  const openFromCard = (id: string, e: ReactMouseEvent<HTMLButtonElement>) => {
    // 先打断进行中的收起：不然它跑完时的 hardClose() 会把这里刚选中的 agent 一起清掉
    // （实测表现为"点了新卡片，面板闪一下就没了"）。
    setClosing(false);
    const btn = e.currentTarget;
    const art = btn.querySelector<HTMLElement>(`.${s.cardArt}`);
    if (art && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      morphFrom.current = { card: btn.getBoundingClientRect(), art: art.getBoundingClientRect() };
      setMorphing(true);
    }
    selectAgent(id);
  };

  useLayoutEffect(() => {
    if (!morphing) return;
    const from = morphFrom.current;
    const panel = panelRef.current;
    const holo = holoRef.current;
    if (!from || !panel || !holo) {
      setMorphing(false);
      return;
    }
    // 面板此刻已挂 .panelMorphing（fixed）但还没被赋几何。先临时摘掉 fixed 量出
    // 它在流里的自然位置，再立刻钉回去——都在同一帧内，中间态不会被绘制。
    panel.style.position = "static";
    const to = panel.getBoundingClientRect();
    panel.style.position = "";
    // inline 一律写**起点**值（不是终点）：动画若有任何一帧没生效，元素落回的是 inline，
    // 而 inline = 起点 = 卡片形态，视觉上仍然正确。写终点则会闪一帧全尺寸空面板。
    // minHeight 必须在量完 to 之后解除：卡片 420 低于面板 520 下限，不解除就缩不到位。
    Object.assign(panel.style, {
      minHeight: "0px",
      top: `${from.card.top}px`,
      left: `${from.card.left}px`,
      width: `${from.card.width}px`,
      height: `${from.card.height}px`,
    });
    panel.style.setProperty("--panel-notch-size", "0px");
    panel.style.setProperty("--panel-radius", "12px");

    // fill:"forwards" 不能省：动画一 finish 效果就撤销，元素瞬间弹回 CSS 默认
    // （挖角 84 / 圆角 24 / 头像 48 圆），而 inline 几何还在——那正是收起末尾
    // 「卡片大小 + 完整挖角 + 小圆头像 + 空内容」那一闪的成因（手机翻拍第 20 帧实证）。
    const timing: KeyframeAnimationOptions = {
      duration: MORPH_MS,
      easing: MORPH_EASE,
      fill: "forwards",
    };
    // 面板：卡片几何 + 无挖角 + 12 圆角 → 面板几何 + 84 挖角 + 24 圆角。
    // 挖角/圆角能平滑插值全靠 CSS 里的 @property 注册（否则只会离散跳变）。
    const anim = panel.animate(
      [
        {
          top: `${from.card.top}px`,
          left: `${from.card.left}px`,
          width: `${from.card.width}px`,
          height: `${from.card.height}px`,
          "--panel-notch-size": "0px",
          "--panel-radius": "12px",
        } as unknown as Keyframe,
        {
          top: `${to.top}px`,
          left: `${to.left}px`,
          width: `${to.width}px`,
          height: `${to.height}px`,
          "--panel-notch-size": "84px",
          "--panel-radius": "24px",
        } as unknown as Keyframe,
      ],
      timing,
    );
    // 真头像：卡片图片区那么大的方图 → 左上角 48px 圆（终点即 .holo 的常态几何）。
    // 同样先把起点写进 inline，避免任何未生效帧露出 CSS 默认的 48px 小圆。
    Object.assign(holo.style, {
      top: `${from.art.top - from.card.top}px`,
      left: `${from.art.left - from.card.left}px`,
      width: `${from.art.width}px`,
      height: `${from.art.height}px`,
      borderRadius: "12px 12px 0 0",
    });
    const holoAnim = holo.animate(
      [
        {
          top: `${from.art.top - from.card.top}px`,
          left: `${from.art.left - from.card.left}px`,
          width: `${from.art.width}px`,
          height: `${from.art.height}px`,
          borderRadius: "12px 12px 0 0",
        },
        { top: "4px", left: "4px", width: "48px", height: "48px", borderRadius: "50%" },
      ],
      timing,
    );

    const contentAnims = fadeInContents(panel);
    // 展开第一帧面板 == 卡片，所以名牌层此刻应当在场，随几何长开淡出。
    const face = panel.querySelector<HTMLElement>(`.${s.panelCardFace}`);
    if (face) {
      contentAnims.push(
        face.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: 150,
          easing: "ease-in",
          fill: "backwards",
        }),
      );
    }

    // 只摘状态，**不要**在这里清 inline 几何：那会让面板在 React 还没摘掉
    // .panelMorphing（position:fixed）的那一帧变成「fixed 且无几何」，当场跳成
    // 错乱尺寸再弹回来（实测 top 36 / width 1086 的一帧）——正是收尾那下闪烁。
    const done = () => setMorphing(false);
    anim.onfinish = done;
    anim.oncancel = done;
    // cleanup 在 React 提交完 DOM（.panelMorphing 已移除）之后、绘制之前跑，
    // 所以在这里解开几何才是同帧无缝的。--panel-h 是别处写的，不能一并清掉。
    return () => {
      anim.onfinish = null;
      anim.oncancel = null;
      // 被打断时必须把**这一轮起的所有动画**都撤掉。漏掉任何一个，它都会继续跑到
      // 自己的终点，把元素拖到与当前状态不符的样子——头像残留成大方图、内容停在
      // 半透明，正是"卡内闪现一帧头像+缺角背景"的来源。
      for (const a of [anim, holoAnim, ...contentAnims]) a.cancel();
      const el = panelRef.current;
      if (el) {
        el.style.position = "";
        el.style.top = "";
        el.style.left = "";
        el.style.width = "";
        el.style.height = "";
        el.style.minHeight = "";
        el.style.opacity = "";
        el.style.removeProperty("--panel-notch-size");
        el.style.removeProperty("--panel-radius");
      }
      const h = holoRef.current;
      if (h) {
        h.style.top = "";
        h.style.left = "";
        h.style.width = "";
        h.style.height = "";
        h.style.borderRadius = "";
      }
    };
  }, [morphing]);

  // ---- 面板 → 卡片 收起形变（展开的反向）----
  // closing 期间列表已重新渲染在流里，面板 fixed 盖其上：量出目标卡片的落点，把
  // 面板 + 头像原路缩回去，挖角与圆角同步退回卡片形状，内容先淡出。跑完才卸载面板。
  useLayoutEffect(() => {
    if (!closing) return;
    const panel = panelRef.current;
    const holo = holoRef.current;
    const deck = deckRef.current;
    if (!panel || !holo || !deck || !selectedId) {
      hardClose();
      setClosing(false);
      return;
    }
    const card = deck.querySelector<HTMLElement>(`[data-agent-id="${CSS.escape(selectedId)}"]`);
    if (!card) {
      hardClose();
      setClosing(false);
      return;
    }
    // 列表是重新挂载的，横向滚动位置归零 → 目标卡片可能在视口外，先把它滚进来，
    // 否则面板会朝屏幕外飞。滚完再量落点。
    const deckRect = deck.getBoundingClientRect();
    let cardRect = card.getBoundingClientRect();
    if (cardRect.left < deckRect.left || cardRect.right > deckRect.right) {
      deck.scrollLeft += cardRect.left - deckRect.left - 40;
      cardRect = card.getBoundingClientRect();
    }
    const art = card.querySelector<HTMLElement>(`.${s.cardArt}`);
    const artRect = art ? art.getBoundingClientRect() : cardRect;

    // from 是 closeDetail 里趁面板还在流中量好的真实全尺寸。此刻面板已 fixed 塌缩，
    // 现场再量只会拿到缩水值（实测 1443×1007 → 1086×592）。
    const from = closeFrom.current ?? panel.getBoundingClientRect();
    // inline 写**起点**（当前全尺寸），不是终点：任何未生效帧落回的都是正确的起点形态。
    Object.assign(panel.style, {
      minHeight: "0px", // 同展开：不解除就缩不到卡片的 420 高
      top: `${from.top}px`,
      left: `${from.left}px`,
      width: `${from.width}px`,
      height: `${from.height}px`,
    });

    const timing: KeyframeAnimationOptions = {
      duration: MORPH_MS,
      easing: MORPH_EASE,
      fill: "forwards", // 见展开侧注释：缺它就是末尾那一闪的根因
    };
    const anim = panel.animate(
      [
        {
          top: `${from.top}px`,
          left: `${from.left}px`,
          width: `${from.width}px`,
          height: `${from.height}px`,
          "--panel-notch-size": "84px",
          "--panel-radius": "24px",
        } as unknown as Keyframe,
        {
          top: `${cardRect.top}px`,
          left: `${cardRect.left}px`,
          width: `${cardRect.width}px`,
          height: `${cardRect.height}px`,
          "--panel-notch-size": "0px",
          "--panel-radius": "12px",
        } as unknown as Keyframe,
      ],
      timing,
    );
    const holoAnim = holo.animate(
      [
        { top: "4px", left: "4px", width: "48px", height: "48px", borderRadius: "50%" },
        {
          top: `${artRect.top - cardRect.top}px`,
          left: `${artRect.left - cardRect.left}px`,
          width: `${artRect.width}px`,
          height: `${artRect.height}px`,
          borderRadius: "12px 12px 0 0",
        },
      ],
      timing,
    );
    // 内容先撤：比几何快一截收干净，免得缩到卡片大小时文字还在里面挤成一团。
    // fill:forwards 会把透明**留住**，所以打断时必须 cancel，否则面板留下、内容全隐形。
    const contentAnims: Animation[] = [];
    for (const cls of [s.panelTabs, s.panelClose, s.panelBody]) {
      const a = panel
        .querySelector<HTMLElement>(`.${cls}`)
        ?.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: 140,
          easing: "ease-in",
          fill: "forwards",
        });
      if (a) contentAnims.push(a);
    }

    // 收尾交接：**面板自己长出卡片名牌**，缩到位时它已经和真卡片长得一模一样
    // （挖角 0 + 圆角 12 + 头像铺满方图 + 名牌），于是可以瞬间交接、全程只有一层。
    // 不能用「真卡片淡入 + 面板淡出」的交叉淡化：那要求两者同时可见，而交叉开始时
    // 面板还没缩到位 —— 一个还在缩的大面板叠着一个已在终点的真卡片 = 双影（实测）。
    const face = panel.querySelector<HTMLElement>(`.${s.panelCardFace}`);
    if (face) {
      contentAnims.push(
        face.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: MORPH_MS - 60, // 同 fadeInContents：不能跨过 cleanup 的 cancel 点
          delay: 60,
          easing: "ease-out",
          fill: "both",
        }),
      );
    }

    const done = () => {
      hardClose();
      setClosing(false);
    };
    anim.onfinish = done;
    anim.oncancel = done;
    return () => {
      anim.onfinish = null;
      anim.oncancel = null;
      for (const a of [anim, holoAnim, ...contentAnims]) a.cancel();
      const el = panelRef.current;
      if (el) {
        el.style.position = "";
        el.style.top = "";
        el.style.left = "";
        el.style.width = "";
        el.style.height = "";
        el.style.minHeight = "";
        el.style.opacity = "";
        el.style.removeProperty("--panel-notch-size");
        el.style.removeProperty("--panel-radius");
      }
      const h = holoRef.current;
      if (h) {
        h.style.top = "";
        h.style.left = "";
        h.style.width = "";
        h.style.height = "";
        h.style.borderRadius = "";
      }
    };
  }, [closing, selectedId]);

  // 面板实际高度回写 --panel-h（holoList 与面板等高要用；面板高度已交给 flex，
  // CSS 侧拿不到具体值）。
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el || !selectedId) return;
    const ro = new ResizeObserver(() => {
      el.style.setProperty("--panel-h", `${Math.round(el.getBoundingClientRect().height)}px`);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [selectedId]);

  return (
    <div className={`page management-page agents-page ${s.root}`}>
      <PageHead
        title={t("agents.pageTitle")}
        subtitle={t("agents.pageSubtitle")}
        actions={
          <span className="muted">
            {loading ? t("common.loading") : t("agents.count", { count: agents.length })}
          </span>
        }
      />
      <div className="toolbar">
        <BackendTabs
          value={backend}
          surface="agents"
          onChange={(next) => {
            requestNavigation(() => {
              hardClose();
              setBackend(next);
            });
          }}
        />
      </div>

      {error && <div className="error">{t("agents.error", { msg: error })}</div>}
      {!loading && !error && agents.length === 0 && (
        <div className="empty-hint agents-empty">
          <div className="agents-empty-icon" aria-hidden="true">
            🤖
          </div>
          <p className="agents-empty-title">{t("agents.empty")}</p>
          <p>{t(hasAgentHarness ? "agents.emptyHintManaged" : backend === "hermes" ? "agents.emptyHintHermes" : "agents.emptyHintOpenclaw", { backend: backendName })}</p>
          {canCreateAgent ? (
            <button className="btn-primary" onClick={openCreate}>
              {backend === "hermes" ? t("agents.newProfile") : t("agents.newAgent")}
            </button>
          ) : (
            <button className="btn-primary" onClick={() => void refresh()}>{t("common.retry")}</button>
          )}
        </div>
      )}

      {/* 首页：横滑卡片列表。closing 时也渲染——收起形变要靠它量出卡片落点 */}
      {(!selectedId || closing) && agents.length > 0 && (
        <div className={s.deck} ref={deckRef}>
          {agents.map((a, i) => (
            <button
              key={a.id}
              type="button"
              data-agent-id={a.id}
              className={
                closing && a.id === selectedId
                  ? `${s.card} ${s.tilt3d} ${s.cardHandoff}`
                  : `${s.card} ${s.tilt3d}`
              }
              onClick={(e) => openFromCard(a.id, e)}
              onMouseMove={tiltMove}
              onMouseLeave={tiltReset}
            >
              <AgentCardFace agent={a} no={agentNo(i)} defaultLabel={t("agents.default")} brand={backendName} />
            </button>
          ))}
          {canCreateAgent && (
            <button
              type="button"
              className={s.cardNew}
              onClick={openCreate}
              title={backend === "hermes" ? t("agents.newProfile") : t("agents.newAgent")}
            >
              <span className={s.cardNewPlus} aria-hidden="true">
                +
              </span>
              <span className={s.cardNewLabel}>
                {backend === "hermes" ? t("agents.newProfile") : t("agents.newAgent")}
              </span>
            </button>
          )}
        </div>
      )}

      {!selectedId && canRestoreAgent && archivedAgents.length > 0 && (
        <section className={s.harnessHistory} aria-label={t("agents.archivedAgents")}>
          <h3>{t("agents.archivedAgents")}</h3>
          <div className={s.rowList}>
            {archivedAgents.map((agent) => (
              <div key={agent.id} className={s.row}>
                <span className={s.rowTitle}>{agent.name}</span>
                <span className={s.rowMeta}>{agent.lifecycleState || "archived"}</span>
                <span className={s.rowSpacer} />
                <button type="button" className={s.pillBtnGhost} onClick={() => void doRestore(agent)}>
                  {t("agents.restore")}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 展开态：整块白面板 */}
      {selectedId && (
        <section
          className={morphActive ? `${s.panel} ${s.panelMorphing}` : s.panel}
          ref={panelRef}
        >
          <header className={s.panelHead}>
            {/* 左上角头像：悬浮展开 agent 切换列表，移出收起 */}
            <div
              className={s.holo}
              ref={holoRef}
              onMouseEnter={() => !morphing && setHoloOpen(true)}
              onMouseLeave={() => setHoloOpen(false)}
            >
              <AgentAvatar
                id={selectedId}
                emoji={detail?.emoji}
                className={`${s.avatar} ${s.holoAvatar}`}
              />
              {holoOpen && (
                <div className={s.holoList} role="listbox" aria-label={t("agents.pageTitle")}>
                  {agents.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      role="option"
                      aria-selected={a.id === selectedId}
                      className={a.id === selectedId ? `${s.holoItem} ${s.holoItemOn}` : s.holoItem}
                      onClick={() => {
                        setHoloOpen(false);
                        if (a.id !== selectedId) requestSelectAgent(a.id);
                      }}
                    >
                      <AgentAvatar id={a.id} className={s.avatar} />
                      <span className={s.holoText}>
                        <span className={s.holoName}>{a.name}</span>
                        <span className={s.holoModel}>{a.model || a.id}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 与 Dashboard 筛选、模型菜单同一个 FilterTabs：胶囊在项间流动 */}
            <FilterTabs
              className={s.panelTabs}
              ariaLabel={t("agents.pageTitle")}
              value={tab}
              onChange={(v) => requestTabChange(v as Tab)}
              items={TABS.map((it) => ({ value: it.key, label: it.label }))}
              scrollable
            />

            <button type="button" className={s.panelClose} onClick={closeDetail} aria-label={t("common.close")}>
              <svg viewBox="0 0 32 32" aria-hidden="true">
                <path d="M10 10 L22 22 M22 10 L10 22" />
              </svg>
            </button>
          </header>

          {/* 形变用的「卡片名牌」层：只在形变期可见（CSS 默认 opacity:0）。
              让面板在卡片尺寸时与真卡片像素一致，从而无需任何交叉淡化即可交接。 */}
          {(() => {
            const a = agents.find((x) => x.id === selectedId);
            if (!a) return null;
            return (
              <span className={s.panelCardFace} aria-hidden="true">
                <span className={s.cardNameRow}>
                  <span className={s.cardName}>{a.name}</span>
                  {a.isDefault && <span className={s.cardDefault}>{t("agents.default")}</span>}
                </span>
                <span className={s.cardFoot}>
                  <span>{selectedIndex >= 0 ? agentNo(selectedIndex) : "#—"}</span>
                  <span className={s.cardBrand}>
                    {backendName.toUpperCase()} <span aria-hidden="true">✦</span>
                  </span>
                </span>
              </span>
            );
          })()}

          <div className={s.panelBody}>
            {detailLoading && <p className={s.dim}>{t("common.loading")}</p>}

            {detail && tab === "overview" && (
              <>
              <div className={s.ovLayout}>
                {/* 左：与首页同款卡片（含同款 3D 悬浮倾斜）；悬浮出现删除按钮 */}
                <div
                  className={`${s.ovCardWrap} ${s.tilt3d}`}
                  onMouseMove={tiltMove}
                  onMouseLeave={tiltReset}
                >
                  <AgentCardFace
                    agent={detail}
                    no={selectedIndex >= 0 ? agentNo(selectedIndex) : "#—"}
                    defaultLabel={t("agents.default")}
                    brand={backendName}
                  />
                  {(canRemoveAgent || canArchiveAgent) && !detail.protected && (
                    <button type="button" className={s.ovDelete} onClick={doDelete}>
                      {t(canArchiveAgent ? "agents.archive" : "common.delete")}
                    </button>
                  )}
                </div>

                {/* 右：信息栅格 */}
                <div className={s.ovFields}>
                  <label className={s.ovField}>
                    <span className={s.ovLabel}>{t("agents.name")}</span>
                    <input
                      className={s.ovInput}
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      readOnly={!canUpdateAgent}
                    />
                  </label>

                  {hasAgentHarness && detail.model && (
                    <div className={s.ovField}>
                      <span className={s.ovLabel}>{t("agents.model")}</span>
                      <span className={s.ovValue}>{detail.model}</span>
                    </div>
                  )}

                  {hasAgentHarness && detail.provider && (
                    <div className={s.ovField}>
                      <span className={s.ovLabel}>{t("agents.provider")}</span>
                      <span className={s.ovValue}>{detail.provider}</span>
                    </div>
                  )}

                  {detail.environmentKind && (
                    <div className={`${s.ovField} ${s.ovFieldWide}`}>
                      <span className={s.ovLabel}>{t("agents.runtimeEnvironment")}</span>
                      <span className={s.ovValue}>
                        {t(
                          detail.environmentKind === "native-user"
                            ? "agents.nativeRuntimeEnvironment"
                            : "agents.shoggothRuntimeEnvironment",
                          {
                            runtime: detail.runtime || detail.provider || "CLI",
                            count: detail.sharedAgentCount || 1,
                          },
                        )}
                      </span>
                    </div>
                  )}

                  {modelEditable && (
                    <label className={s.ovField}>
                      <span className={s.ovLabel}>{t("agents.emoji")}</span>
                      <EmojiField
                        className={s.ovInput}
                        value={form.emoji}
                        onChange={(emoji) => setForm({ ...form, emoji })}
                        placeholder="🤖"
                      />
                    </label>
                  )}

                  {detail.isDefault && (
                    <div className={s.ovField}>
                      <span className={s.ovLabel}>{t("agents.defaultAgent")}</span>
                      <span className={s.ovValue}>{t("agents.yes")}</span>
                    </div>
                  )}

                  {detail.workspace && (
                    <div className={`${s.ovField} ${s.ovFieldWide}`}>
                      <span className={s.ovLabel}>{t("agents.workspace")}</span>
                      {/* 只读——点一下用系统文件管理器打开该目录（Electron 宿主能力）。 */}
                      <button
                        type="button"
                        className={s.ovLink}
                        title={t("agents.openWorkspace")}
                        onClick={() => openHostPath(detail.workspace as string)}
                      >
                        {detail.workspace}
                      </button>
                    </div>
                  )}

                  {modelEditable && (
                    <div className={`${s.ovField} ${s.ovFieldWide}`}>
                      <span className={s.ovLabel}>{t("agents.model")}</span>
                      {/* 聊天页那个模型浮层原样复用（搜索 + provider 筛选 + 价格/推理标签）。
                          触发器被皮肤化成设计稿里的纯文本值；选中只改表单，Save 才写回。 */}
                      <div className={`agents-model-picker ${s.modelPicker}`}>
                        <ChatModelMenu
                          models={models}
                          activeModel={splitModelRef(form.model).id}
                          activeProvider={splitModelRef(form.model).provider}
                          triggerLabel={form.model || undefined}
                          onSelect={(id, provider) =>
                            setForm({ ...form, model: provider ? `${provider}/${id}` : id })
                          }
                          loading={modelsLoading}
                        />
                      </div>
                    </div>
                  )}

                  {/* per-agent 模型设置面的主模型区：provider/model 就地可改 + 默认参数。
                      有整合设置面的后端（Hermes）在此接管「模型」字段；没有的返回
                      supported:false 自行隐身，模型选择留给上面的 updateAgent 表单。 */}
                  {!hasAgentHarness && <AgentMainModelField state={modelSettings} />}

                  {modelEditable && (
                    <div className={`${s.ovField} ${s.ovFieldWide}`}>
                      <span className={s.ovLabel}>{t("agents.fallbackModels")}</span>
                      {/* 降级链：有序 chip（× 移除）+「+ 添加」多选浮层，序号即尝试顺序。 */}
                      <div className={s.fallbacks}>
                        {form.fallbacks.map((ref, i) => (
                          <span key={ref} className={s.fallbackChip}>
                            {i > 0 && (
                              <span className={s.fallbackArrow} aria-hidden="true">
                                →
                              </span>
                            )}
                            <span className={s.fallbackRef}>{ref}</span>
                            <button
                              type="button"
                              className={s.fallbackX}
                              title={t("agents.fallbackRemove", { model: ref })}
                              onClick={() => toggleFallback(ref)}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                        <div className={`agents-model-picker ${s.modelPicker}`}>
                          <ChatModelMenu
                            models={models}
                            activeModel=""
                            selectedRefs={form.fallbacks}
                            triggerLabel={t("agents.fallbackAdd")}
                            onSelect={(id, provider) => toggleFallback(provider ? `${provider}/${id}` : id)}
                            loading={modelsLoading}
                          />
                        </div>
                      </div>
                      <span className={s.ovHint}>{t("agents.fallbackHint")}</span>
                    </div>
                  )}

                  {(overviewDirty || savingOverview) && (
                    <div className={s.ovFieldWide}>
                      <button className={s.saveBtn} onClick={saveOverview} disabled={savingOverview}>
                        {savingOverview ? t("common.saving") : t("common.save")}
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* 重设置（辅助模型 / MoA / 回退链）全宽摆在两列区之后：一眼先看到主模型，
                  往下滚才是这些。与主模型区共用同一份快照，不各拉一次。 */}
              {hasAgentHarness ? (
                <p className={s.dim}>{t("agents.managedReadOnly", { backend: backendName })}</p>
              ) : (
                <AgentModelCards state={modelSettings} />
              )}
              {backend === "shoggoth" && detail.profile && (
                <ShoggothProviderSetup
                  snapshot={shoggothProviderSnapshot}
                  profileId={detail.profile}
                  onConfigured={async () => {
                    const [snapshot] = await Promise.all([
                      getShoggothProviders(detail.profile || null),
                      reloadDetail(),
                      doRefresh(),
                    ]);
                    setShoggothProviderSnapshot(snapshot);
                  }}
                />
              )}
              </>
            )}

            {detail && tab === "setup" && (
              <div className={s.tabPane}>
                {hasAgentHarness && (
                  <div className={s.harnessActions}>
                    <span className={s.rowMeta}>
                      {definition ? t("agents.definitionRevision", { revision: definition.current.revision }) : t("common.loading")}
                    </span>
                    <span className={s.rowSpacer} />
                    <button type="button" className={s.pillBtnGhost} onClick={() => void downloadDefinition()}>
                      {t("agents.exportDefinition")}
                    </button>
                    <button type="button" className={s.pillBtn} onClick={() => harnessImportRef.current?.click()}>
                      {t("agents.importDefinition")}
                    </button>
                    <input
                      ref={harnessImportRef}
                      type="file"
                      accept="application/json,.json"
                      hidden
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void uploadDefinition(file);
                      }}
                    />
                  </div>
                )}
              <div className={s.suLayout}>
                <nav className={s.suList}>
                  {(detail.files || []).length === 0 && <p className={s.dim}>{t("agents.noFiles")}</p>}
                  {(detail.files || []).map((f) => (
                    <button
                      key={f.name}
                      type="button"
                      className={activeFile === f.name ? `${s.suItem} ${s.suItemOn}` : s.suItem}
                      onClick={() => requestOpenFile(f.name)}
                      title={f.name}
                    >
                      <span className={s.suItemIcon} aria-hidden="true">
                        ✦
                      </span>
                      <span className={s.suItemName}>{fileDisplayName(f.name)}</span>
                    </button>
                  ))}
                </nav>
                <div className={s.suDivider} aria-hidden="true" />
                <div className={s.suMain}>
                  {!activeFile && <p className={s.dim}>{t("agents.selectFile")}</p>}
                  {activeFile && (
                    <>
                      <header className={s.suHead}>
                        <MdFileIcon />
                        <div className={s.suHeadText}>
                          <div className={s.suFileName}>{activeFile}</div>
                          <div className={s.suFileDesc}>{fileDesc(activeFile)}</div>
                        </div>
                        {fileEditing && !fileReadOnly && (
                          <button
                            type="button"
                            className={s.saveBtn}
                            onClick={saveFile}
                            disabled={savingFile || fileLoading}
                          >
                            {savingFile ? t("common.saving") : t("common.save")}
                          </button>
                        )}
                      </header>
                      {fileLoading ? (
                        <p className={s.dim}>{t("common.loading")}</p>
                      ) : fileEditing && !fileReadOnly ? (
                        <textarea
                          className={s.suEditor}
                          value={fileContent}
                          onChange={(e) => setFileContent(e.target.value)}
                          onKeyDown={(e) => {
                            // Esc 放弃本次编辑，回到阅读态
                            if (e.key === "Escape") {
                              setFileContent(fileOrigRef.current);
                              setFileEditing(false);
                            }
                          }}
                          autoFocus
                          spellCheck={false}
                        />
                      ) : (
                        // 阅读态：点击任意处直接进入编辑（设计稿 7046-4605）
                        <div
                          className={s.suRead}
                          title={fileReadOnly ? t("agents.generatedReadOnly") : t("agents.clickToEdit")}
                          onClick={() => { if (!fileReadOnly) setFileEditing(true); }}
                        >
                          {fileContent || <span className={s.dim}>{t("agents.emptyFile")}</span>}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
                {hasAgentHarness && definition && definition.history.length > 1 && (
                  <div className={s.harnessHistory}>
                    <h3>{t("agents.definitionHistory")}</h3>
                    <div className={s.rowList}>
                      {definition.history.slice(1).map((revision) => (
                        <div key={revision.revision} className={s.row}>
                          <span className={s.rowTitle}>r{revision.revision}</span>
                          <span className={s.rowMeta}>{revision.actor} · {revision.reason || "—"}</span>
                          <span className={s.rowSpacer} />
                          <button type="button" className={s.pillBtnGhost} onClick={() => void restoreDefinition(revision.revision)}>
                            {t("agents.restore")}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {detail && tab === "memory" && (
              <div className={s.tabPane}>
                <p className={s.paneNote}>{t("agents.memoryExplain")}</p>
                {memories === null ? <p className={s.dim}>{t("common.loading")}</p>
                  : memories.items.length === 0 ? <p className={s.dim}>{t("agents.memoryEmpty")}</p>
                    : <div className={s.harnessList}>
                      {memories.items.map((item) => (
                        <article key={item.id} className={s.harnessCard}>
                          <div className={s.harnessMeta}>
                            <span className={s.chip}>{item.status}</span>
                            <span className={s.chip}>{item.scope}</span>
                            <span>{t("agents.memoryConfidence", { value: Math.round(item.confidence * 100) })}</span>
                            <span className={s.rowSpacer} />
                            <span className={s.rowMono}>{item.sourceRefs.join(", ")}</span>
                          </div>
                          <textarea
                            className={s.harnessEditor}
                            value={memoryDrafts[item.id] ?? item.content}
                            disabled={item.status === "deleted" || item.status === "superseded"}
                            onChange={(event) => setMemoryDrafts({ ...memoryDrafts, [item.id]: event.target.value })}
                          />
                          <div className={s.harnessActions}>
                            {item.status === "candidate" && (
                              <button type="button" className={s.pillBtn} onClick={() => void memoryAction("confirm", item.id)}>
                                {t("agents.memoryConfirm")}
                              </button>
                            )}
                            {["candidate", "active"].includes(item.status) && (
                              <>
                                <button type="button" className={s.pillBtnGhost} onClick={() => void memoryAction("update", item.id)}>
                                  {t("common.save")}
                                </button>
                                <button type="button" className={s.pillBtnGhost} onClick={() => void memoryAction("delete", item.id)}>
                                  {t("agents.forget")}
                                </button>
                              </>
                            )}
                          </div>
                        </article>
                      ))}
                      {memories.hasMore && (
                        <button type="button" className={s.pillBtnGhost} disabled={harnessLoadingMore} onClick={() => void loadMoreMemories()}>
                          {t("common.loadMore")}
                        </button>
                      )}
                    </div>}
              </div>
            )}

            {detail && tab === "history" && (
              <div className={s.historyLayout}>
                <nav className={s.historySessions}>
                  {transcriptSessions === null ? <p className={s.dim}>{t("common.loading")}</p>
                    : transcriptSessions.length === 0 ? <p className={s.dim}>{t("agents.historyEmpty")}</p>
                      : transcriptSessions.map((session) => (
                        <button
                          key={session.id}
                          type="button"
                          className={session.id === transcriptSessionId ? `${s.suItem} ${s.suItemOn}` : s.suItem}
                          onClick={() => void openTranscript(session.id)}
                        >
                          <span className={s.suItemName}>{session.title || session.sessionKey.slice(0, 8)}</span>
                          <span className={s.rowMeta}>{session.eventCount}</span>
                        </button>
                      ))}
                  {transcriptSessionsHasMore && (
                    <button type="button" className={s.pillBtnGhost} disabled={harnessLoadingMore} onClick={() => void loadMoreTranscriptSessions()}>
                      {t("common.loadMore")}
                    </button>
                  )}
                </nav>
                <div className={s.harnessList}>
                  {transcriptEvents === null ? <p className={s.dim}>{t("agents.selectHistory")}</p>
                    : transcriptEvents.map((event) => (
                      <article key={event.id} className={s.harnessCard}>
                        <div className={s.harnessMeta}>
                          <span className={s.chip}>{event.kind}</span>
                          <span>#{event.seq}</span>
                          <span className={s.rowSpacer} />
                          <Switch
                            checked={!event.contextExcluded}
                            onChange={() => void toggleTranscriptContext(event)}
                            label={t("agents.includeInContext")}
                          />
                        </div>
                        <pre className={s.harnessPre}>{event.content.text || JSON.stringify(event.content, null, 2)}</pre>
                      </article>
                    ))}
                  {transcriptEventsHasMore && (
                    <button type="button" className={s.pillBtnGhost} disabled={harnessLoadingMore} onClick={() => void loadMoreTranscriptEvents()}>
                      {t("common.loadMore")}
                    </button>
                  )}
                </div>
              </div>
            )}

            {detail && tab === "tools" && (
              <div className={s.tabPane}>
                <p className={s.paneNote}>
                  {toolsState ? t("agents.toolRevision", { registry: toolsState.registryRevision.slice(0, 8), permission: toolsState.revision }) : t("common.loading")}
                </p>
                {toolsState && <div className={s.rowList}>
                  {toolsState.tools.map((tool) => (
                    <div key={tool.name} className={s.row}>
                      <span className={s.rowTitle}>{tool.name}</span>
                      <span className={s.chip}>{tool.risk}</span>
                      <span className={s.rowMeta}>{tool.description}</span>
                      <span className={s.rowSpacer} />
                      <Switch
                        checked={tool.effect === "allow"}
                        onChange={(allowed) => void toggleToolPermission(tool.name, allowed ? "allow" : "deny")}
                        label={tool.effect === "allow" ? t("agents.toolAllowed") : t("agents.toolDenied")}
                      />
                    </div>
                  ))}
                </div>}
              </div>
            )}

            {detail && tab === "computer" && (
              <div className={s.tabPane}>
                <p className={s.paneNote}>{t("agents.computerExplain")}</p>
                {computerState === null ? <p className={s.dim}>{t("common.loading")}</p> : (
                  <>
                    <div className={s.rowList}>
                      <div className={s.row}>
                        <span className={s.rowTitle}>{t("agents.computerDriver")}</span>
                        <span className={computerState.available ? `${s.chip} ${s.chipOn}` : s.chip}>
                          {computerState.available ? t("agents.computerAvailable") : t("agents.computerUnavailable")}
                        </span>
                        <span className={s.rowSpacer} />
                        <span className={s.rowMeta}>
                          {computerState.driverVersion ? `v${computerState.driverVersion}` : computerState.reason || "—"}
                        </span>
                      </div>
                      <div className={s.row}>
                        <span className={s.rowTitle}>{t("agents.computerAccessibility")}</span>
                        <span className={computerState.permissions.accessibility ? `${s.chip} ${s.chipOn}` : s.chip}>
                          {computerState.permissions.accessibility ? t("agents.computerGranted") : t("agents.computerNotGranted")}
                        </span>
                      </div>
                      <div className={s.row}>
                        <span className={s.rowTitle}>{t("agents.computerScreenRecording")}</span>
                        <span className={computerState.permissions.screenRecording ? `${s.chip} ${s.chipOn}` : s.chip}>
                          {computerState.permissions.screenRecording ? t("agents.computerGranted") : t("agents.computerNotGranted")}
                        </span>
                      </div>
                    </div>
                    <div className={s.harnessActions}>
                      <button
                        type="button"
                        className={s.pillBtn}
                        disabled={computerPermissionBusy}
                        onClick={() => void grantComputerPermissions()}
                      >
                        {computerPermissionBusy ? t("common.loading") : t("agents.computerGrantPermissions")}
                      </button>
                      <button type="button" className={s.pillBtnGhost} onClick={() => void openComputerScreenSettings()}>
                        {t("agents.computerOpenScreenSettings")}
                      </button>
                      <button
                        type="button"
                        className={s.pillBtnGhost}
                        onClick={() => void refreshComputerState().catch((error) => toast.error(error instanceof Error ? error.message : String(error)))}
                      >
                        {t("common.refresh")}
                      </button>
                    </div>
                    <p className={s.paneNote}>{t("agents.computerPermissionNote")}</p>
                    <h3>{t("agents.computerSessions")}</h3>
                    {computerState.sessions.length === 0 ? <p className={s.dim}>{t("agents.computerSessionsEmpty")}</p>
                      : <div className={s.rowList}>
                        {computerState.sessions.map((session) => (
                          <div key={session.id} className={s.row}>
                            <span className={s.rowTitle}>{session.allowedApplications.join(", ")}</span>
                            <span className={session.status === "ready" ? `${s.chip} ${s.chipOn}` : s.chip}>{session.status}</span>
                            <span className={s.rowMono}>{session.workRunId}</span>
                            <span className={s.rowSpacer} />
                            <span className={s.rowMeta}>
                              {t("agents.computerExpires", { time: new Date(session.expiresAt).toLocaleTimeString() })}
                            </span>
                          </div>
                        ))}
                      </div>}
                  </>
                )}
              </div>
            )}

            {detail && tab === "cron" && (
              <div className={s.tabPane}>
                {agentCron === null ? (
                  <p className={s.dim}>{t("common.loading")}</p>
                ) : agentCron.length === 0 ? (
                  <p className={s.dim}>{t("agents.cronEmpty")}</p>
                ) : (
                  <div className={s.rowList}>
                    {agentCron.map((j) => (
                      <div key={j.id} className={s.row}>
                        <span className={s.rowTitle}>{j.name}</span>
                        <span className={s.rowMono}>{j.scheduleDisplay || j.schedule.kind}</span>
                        <span className={j.enabled ? `${s.chip} ${s.chipOn}` : s.chip}>
                          {j.enabled ? t("agents.enabled") : t("agents.disabled")}
                        </span>
                        <span className={s.rowSpacer} />
                        <button type="button" className={s.pillBtn} disabled={j.actions?.run === false} onClick={() => void runAgentCron(j)}>
                          {t(runWillResumePaused(j) ? "cron.runAndEnable" : "agents.run")}
                        </button>
                        <button
                          type="button"
                          className={s.pillBtnGhost}
                          disabled={j.actions?.toggle === false}
                          title={j.actions?.reason === "system-managed" ? t("cron.systemManaged") : undefined}
                          onClick={() => cronAct(() => setCronEnabled(j.id, !j.enabled))}
                        >
                          {j.enabled ? t("agents.disable") : t("agents.enable")}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {detail && tab === "inspiration" && (
              <div className={s.tabPane}>
                <Suspense fallback={<p className={s.dim}>{t("common.loading")}</p>}>
                  <AgentInspirationPanel key={`${backend}:${detail.id}`} backendId={backend} agentId={detail.id} />
                </Suspense>
              </div>
            )}

            {detail && tab === "artifacts" && (
              <div className={s.tabPane}>
                {artifacts?.supported && (artifacts.total ?? artifacts.items.length) > 0 && (
                  // 总数 = 扫描到的全部产出；列表按 mtime 倒序截断时补一句实际显示条数。
                  <p className={s.paneNote}>
                    {t("agents.artifactsCount", { count: artifacts.total ?? artifacts.items.length })}
                    {artifacts.items.length < (artifacts.total ?? 0)
                      ? t("agents.artifactsShown", { shown: artifacts.items.length })
                      : ""}
                  </p>
                )}
                {artifacts === null ? (
                  <p className={s.dim}>{t("common.loading")}</p>
                ) : !artifacts.supported ? (
                  <p className={s.dim}>{t("agents.artifactsUnsupported")}</p>
                ) : artifacts.items.length === 0 ? (
                  <p className={s.dim}>{t("agents.artifactsEmpty")}</p>
                ) : (
                  <div className={s.rowList}>
                    {artifacts.items.map((f) => (
                      // 点一行 = 用系统默认程序打开这个文件（同 workspace 行的 host 能力）。
                      <button
                        key={f.path}
                        type="button"
                        className={`${s.row} ${s.rowClickable}`}
                        title={f.path}
                        onClick={() => openHostPath(f.path)}
                      >
                        <span className={`${s.rowTitle} ${s.rowMonoTitle}`}>{f.name}</span>
                        <span className={s.chip}>{f.kind}</span>
                        <span className={s.rowSpacer} />
                        <span className={s.rowMeta}>
                          {[f.size != null ? fmtBytes(f.size) : null, new Date(f.mtimeMs).toLocaleDateString()]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {/* create */}
      <Modal
        open={creating && canCreateAgent}
        onClose={() => setCreating(false)}
        title={hasAgentHarness
          ? t("agents.createTitleNative", { backend: backendName })
          : backend === "hermes" ? t("agents.createTitleHermes") : t("agents.createTitleOpenclaw")}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setCreating(false)} disabled={savingCreate}>
              {t("common.cancel")}
            </button>
            <button className="btn-primary" onClick={saveCreate} disabled={savingCreate}>
              {savingCreate ? t("agents.creating") : t("agents.create")}
            </button>
          </>
        }
      >
        <Field label={t("agents.name")}>
          <TextInput
            value={createDraft.name}
            onChange={(e) => setCreateDraft({ ...createDraft, name: e.target.value })}
            placeholder={backend === "hermes" ? t("agents.profileNamePlaceholder") : t("agents.agentNamePlaceholder")}
          />
        </Field>
        {hasAgentHarness || backend === "openclaw" ? (
          <>
            <Field
              label={t("agents.workspacePath")}
              hint={t(hasAgentHarness ? "agents.nativeWorkspaceHint" : "agents.workspaceHint")}
            >
              <TextInput
                className="field-input field-mono"
                value={createDraft.workspace}
                onChange={(e) => setCreateDraft({ ...createDraft, workspace: e.target.value })}
                placeholder={hasAgentHarness
                  ? t("agents.nativeWorkspacePlaceholder")
                  : openclawWorkspacePlaceholder(createDraft.name)}
              />
            </Field>
            {!hasAgentHarness && (
              <Field label={t("agents.modelOptional")} hint={t("agents.modelOptionalHint")}>
                <TextInput
                  className="field-input field-mono"
                  value={createDraft.model}
                  onChange={(e) => setCreateDraft({ ...createDraft, model: e.target.value })}
                  placeholder={agents.find((agent) => agent.isDefault)?.model || "provider/model"}
                />
              </Field>
            )}
          </>
        ) : (
          <ModalSection title={t("agents.createOptions")}>
            <div>
              <Switch
                checked={createDraft.cloneFromDefault}
                onChange={(v) =>
                  // Hermes 侧 clone 与 no_skills 互斥（克隆本身会复制源 profile 的
                  // skills），同时开会被 400 挡回来——这里就让它们互斥。
                  setCreateDraft({
                    ...createDraft,
                    cloneFromDefault: v,
                    noSkills: v ? false : createDraft.noSkills,
                  })
                }
                label={t("agents.cloneFromDefault")}
              />
              <p className="switch-hint">{t("agents.cloneFromDefaultHint")}</p>
            </div>
            <div>
              <Switch
                checked={createDraft.noSkills}
                onChange={(v) =>
                  setCreateDraft({
                    ...createDraft,
                    noSkills: v,
                    cloneFromDefault: v ? false : createDraft.cloneFromDefault,
                  })
                }
                label={t("agents.noSkills")}
              />
              <p className="switch-hint">{t("agents.noSkillsHint")}</p>
            </div>
          </ModalSection>
        )}
      </Modal>
    </div>
  );
}

// 卡片正面（首页与 Overview 左卡共用）：320 方图 + 名牌（名称 / #编号 / 品牌角标）。
function AgentCardFace({
  agent,
  no,
  defaultLabel,
  brand,
}: {
  agent: Pick<UnifiedAgent, "id" | "name" | "isDefault"> & { emoji?: string };
  no: string;
  defaultLabel: string;
  brand: string;
}) {
  return (
    <span className={s.cardFace}>
      <span className={s.cardArt}>
        <AgentAvatar id={agent.id} emoji={agent.emoji} className={s.cardImg} />
      </span>
      <span className={s.cardBody}>
        <span className={s.cardNameRow}>
          <span className={s.cardName}>{agent.name}</span>
          {agent.isDefault && <span className={s.cardDefault}>{defaultLabel}</span>}
        </span>
        <span className={s.cardFoot}>
          <span>{no}</span>
          <span className={s.cardBrand}>
            {brand.toUpperCase()} <span aria-hidden="true">✦</span>
          </span>
        </span>
      </span>
    </span>
  );
}

// Preserve the card/detail geometry and optional emoji fallback.
function AgentAvatar({ id, emoji, className }: { id?: string; emoji?: string; className?: string }) {
  return <AgentAvatarView agentId={id} fallback={emoji} className={`${s.avatarBase} ${className || ""}`} loading="lazy" />;
}

// Setup 头部的黄色 MD 文档小图标（设计稿 7043-4418 的简化矢量版）。
function MdFileIcon() {
  return (
    <span className={s.suFileIcon} aria-hidden="true">
      <svg viewBox="0 0 48 48">
        <rect x="10" y="9" width="28" height="29" rx="4" fill="#fff" stroke="rgba(0,0,0,0.08)" />
        <rect x="14" y="13" width="20" height="2" rx="1" fill="rgba(0,0,0,0.08)" />
        <rect x="14" y="17" width="15" height="2" rx="1" fill="rgba(0,0,0,0.08)" />
        <path
          d="M7 16 h34 a3 3 0 0 1 3 3 v14 a5 5 0 0 1 -5 5 h-30 a5 5 0 0 1 -5 -5 v-14 a3 3 0 0 1 3 -3 z"
          fill="#FFDF80"
        />
        <text x="13" y="33" fontSize="7" fontWeight="800" fill="rgba(179,120,0,0.65)">
          MD
        </text>
      </svg>
    </span>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
