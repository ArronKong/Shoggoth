import AgentAvatarView from "../components/AgentAvatar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { BulkTaskPatch, KanbanBoard, Orchestration, TaskDiagnosticsRow, TaskInput, TaskLog, UnifiedTask, UnifiedTaskDetail, WorkboardRunMode } from "../types";
import {
  addTaskComment,
  archiveTask,
  createTask,
  deleteTask,
  getTask,
  getTaskBoard,
  getTaskBoardConfig,
  getBoards,
  createBoard,
  deleteBoard,
  getOrchestration,
  setOrchestration,
  addTaskLink,
  removeTaskLink,
  reassignTask,
  reclaimTask,
  getTaskLog,
  getTaskDiagnostics,
  bulkDeleteTasks,
  bulkUpdateTasks,
  moveTask,
  nudgeDispatcher,
  runTask,
  taskAction,
  updateTask,
} from "../api/client";
import BackendTabs, { type BackendId } from "../components/BackendTabs";
import SearchCapsule from "../components/SearchCapsule";
import FusionLoader from "../components/FusionLoader";
import { useBackendCatalog, useBackendState } from "../lib/backends";
import { PageHead } from "../components/PageHead";
import Modal, { DetailRow, ModalSection } from "../components/Modal";
import { Field, Option, Select, TextArea, TextInput } from "../components/Field";
import { useConfirm, usePrompt, useToast } from "../components/ui";
import {
  AttachmentsSection,
  BoardSettingsDialog,
  DiagnosticCards,
  HomeSubsSection,
  ModelEditor,
  ProfileDescriptions,
} from "./tasks/HermesTaskExtras";
import { toSanitizedMarkdownHtml } from "../lib/markdown";
import { createAsyncRequestController, createBoardSwitchController } from "../lib/lowUiLifecycle";
import { usePageCache } from "../lib/usePageCache";
import { useRegisterPageRefresh, useRegisterPageLoading } from "../lib/page-refresh";
import { hasStickyValue, useStickyState } from "../lib/useStickyState";
import WorkboardView from "./workboard/WorkboardView";
import {
  fallbackBoardIdentity,
  nativeTaskCanMoveTo,
  nativeTaskCreateSpec,
  nativeTaskEditPlan,
  nativeTaskRunCommand,
  resolveNativeBoardId,
  usesExplicitBoardIdentity,
} from "../lib/shoggothDomainUi";

interface Draft {
  title: string;
  body: string;
  column: string;
  assignee: string;
  priority: number;
  priorityLevel: string;
  labels: string;      // 逗号串
  agentId: string;
  sessionKey: string;
  templateId: string;
  tenant: string;
  skills: string;       // 逗号串
  goalMode: boolean;
  goalMaxTurns: number;
  workspaceKind: string;  // scratch=完成即删 / worktree / dir
  workspacePath: string;
  parent: string;         // 父任务 id（子卡在父完成前一直阻塞）
}

export interface TasksPageDetailTarget {
  backendId: string;
  boardId?: string;
  taskId: string;
  onClose: () => void;
}

export default function TasksPage({ detailOnly }: { detailOnly?: TasksPageDetailTarget } = {}) {
  // Dashboard 活动流深链：#/tasks?backend=&board=&task=（照 CronPage ?job= 先例）。
  // board 只作为 getTaskBoard 的查看参数，绝不调 switchBoard（服务端全局状态）。
  const deepLink = useMemo(() => {
    if (detailOnly) {
      return {
        backend: detailOnly.backendId,
        board: detailOnly.boardId || "",
        task: detailOnly.taskId,
      };
    }
    const q = new URLSearchParams(window.location.hash.split("?")[1] || "");
    return {
      backend: q.get("backend") || "",
      board: q.get("board") || "",
      task: q.get("task") || "",
    };
    // hash 深链只在挂载时消费一次
  }, [detailOnly?.backendId, detailOnly?.boardId, detailOnly?.taskId]);
  const [selectedBackend, setBackend] = useBackendState(
    "tasks",
    deepLink.backend ? (deepLink.backend as BackendId) : undefined,
    { surface: "kanban" },
  );
  const backend = detailOnly ? detailOnly.backendId as BackendId : selectedBackend;
  const backendCatalog = useBackendCatalog("kanban");
  const descriptorKanbanKind = backendCatalog.find((item) => item.id === backend)?.surfaces.kanban?.kind;

  const [mode, setMode] = useState<"view" | "edit" | "create" | null>(null);
  const [detail, setDetail] = useState<UnifiedTaskDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // 详情请求代际：后打开的任务或主动关闭弹窗会让旧响应失效。
  const detailReqRef = useRef(0);
  // 当前弹窗的目标任务同步写 ref，供异步刷新在 React 重渲染前核对身份。
  const detailTargetRef = useRef<string | null>(null);
  const [draft, setDraft] = useState<Draft>({ title: "", body: "", column: "", assignee: "", priority: 0,
    priorityLevel: "normal", labels: "", agentId: "", sessionKey: "", templateId: "",
    tenant: "", skills: "", goalMode: false, goalMaxTurns: 0,
    workspaceKind: "scratch", workspacePath: "", parent: "" });
  const [saving, setSaving] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [posting, setPosting] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [runBusy, setRunBusy] = useState<string | null>(null);

  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [includeArchived, setIncludeArchived] = useStickyState("tasks.includeArchived", false); // 显示归档（后端重取）
  // 板选择持久化（官方存 localStorage 的同一意图）：切页/重开仍停在上次看的板；
  // "" = 跟随服务端 current；深链可临时指定。
  const [activeBoards, setActiveBoards] = useStickyState<Record<string, string>>(
    "tasks.boards",
    {},
    deepLink.backend && deepLink.board ? { [deepLink.backend]: deepLink.board } : undefined,
  );
  const activeBoard = detailOnly?.boardId || activeBoards[backend] || "";
  const setActiveBoard = useCallback((boardId: string) => {
    setActiveBoards((current) => ({ ...current, [backend]: boardId }));
  }, [backend, setActiveBoards]);
  // 看板切换控制器同步保存挂载状态、最新请求代际和目标，避免 B→C 乱序回写。
  const boardSwitchControllerRef = useRef<ReturnType<typeof createBoardSwitchController> | null>(null);
  if (!boardSwitchControllerRef.current) boardSwitchControllerRef.current = createBoardSwitchController();
  const boardSwitchController = boardSwitchControllerRef.current;
  const auxiliaryReqControllerRef = useRef<ReturnType<typeof createAsyncRequestController> | null>(null);
  if (!auxiliaryReqControllerRef.current) {
    auxiliaryReqControllerRef.current = createAsyncRequestController();
  }
  const auxiliaryReqController = auxiliaryReqControllerRef.current;
  // await 结算时读取当前 render 的 backend，不能只相信请求发起时的旧闭包。
  const backendRef = useRef(backend);
  backendRef.current = backend;
  useEffect(() => {
    boardSwitchController.mount();
    auxiliaryReqController.mount();
    return () => {
      boardSwitchController.unmount();
      auxiliaryReqController.unmount();
    };
  }, [auxiliaryReqController, boardSwitchController]);
  // 工作板（OpenClaw）：手动刷新/首载按官方语义先重算 diagnostics 再取列表。
  // fetcher 每次渲染是新闭包（usePageCache 走 ref），用 ref 传一次性参数。
  const wbDiagRef = useRef(true);
  const effectiveIncludeArchived = detailOnly ? true : includeArchived;
  const { data: boardData, loading, error, refresh } = usePageCache(
    `tasks:${backend}:${effectiveIncludeArchived}:${activeBoard}`,
    async () => {
      const diag = wbDiagRef.current;
      wbDiagRef.current = false;
      let requestedBoard = activeBoard || undefined;
      const availableBoards = await getBoards(backend);
      if (usesExplicitBoardIdentity(availableBoards)) {
        const explicitBoardId = resolveNativeBoardId(availableBoards, activeBoard);
        if (!explicitBoardId) {
          return { columns: [], capabilities: { boards: true } };
        }
        requestedBoard = explicitBoardId;
      }
      return getTaskBoard(backend, {
        includeArchived: effectiveIncludeArchived,
        board: requestedBoard,
        refreshDiagnostics: diag || undefined,
      });
    },
  );
  const board = boardData ?? null;
  const refreshWb = useCallback(async (opts?: { diagnostics?: boolean }) => {
    wbDiagRef.current = !!opts?.diagnostics;
    await refresh();
  }, [refresh]);
  const pageRegistrationKey = detailOnly ? `/tasks/detail/${backend}/${activeBoard}/${detailOnly.taskId}` : "/tasks";
  useRegisterPageRefresh(pageRegistrationKey, refresh);
  useRegisterPageLoading(pageRegistrationKey, loading);

  const columns = board?.columns ?? [];
  const caps = board?.capabilities ?? {};
  const boardKind = caps.kind ?? descriptorKanbanKind;
  // Hermes 旧契约在引入显式 flags 前就已提供评论/运行历史；保留该兼容基线。
  // Shoggoth 与未知后端仍严格 fail closed，只认独立 capability。
  const commentsEnabled = caps.comments === true || boardKind === "hermes";
  const runsEnabled = caps.run === true || caps.retry === true || boardKind === "hermes";
  // OpenClaw 工作板走 1:1 官方视图（WorkboardView）；按 capability 分支，不特判后端 id。
  const isWorkboard = boardKind === "workboard";
  const isNativeBoard = boardKind === "native";
  const isHermesBoard = boardKind === "hermes";
  // Hermes 多板：item 操作贯穿当前查看板（KAN-005/006）；"" = 服务端 current 板。
  const boardArg = activeBoard || undefined;
  // KAN-004: capabilities.moveTargets 缺省 = 不限制（OpenClaw）。目标列按白名单
  // 过滤（running 走 dispatcher/claim、review 由 worker 提交产生，不可直接移入）。
  const canMoveTo = (colId: string) => isNativeBoard
    ? nativeTaskCanMoveTo(caps, colId)
    : !caps.moveTargets || caps.moveTargets.includes(colId);
  const [query, setQuery] = useStickyState("tasks.query", "");
  const [prioFilter, setPrioFilter] = useStickyState<string>("tasks.prio", "");   // "" = 所有优先级
  const [tenantFilter, setTenantFilter] = useStickyState("tasks.tenant", "");     // Hermes 租户筛选（客户端）
  const [assigneeFilter, setAssigneeFilter] = useStickyState("tasks.assignee", ""); // Hermes 受理人筛选（客户端）
  const [laneByProfile, setLaneByProfile] = useStickyState("tasks.laneByProfile", false); // 运行中列按 profile 分泳道
  const [bannerDismissed, setBannerDismissed] = useState(false); // 本地关闭关注横幅（不持久化）
  const [bannerExpanded, setBannerExpanded] = useState(false);
  const [nudging, setNudging] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  const [diagRows, setDiagRows] = useState<TaskDiagnosticsRow[] | null>(null);
  const [boards, setBoards] = useState<KanbanBoard[]>([]);
  const explicitBoardIdentity = usesExplicitBoardIdentity(boards);
  const [boardDialog, setBoardDialog] = useState(false);
  const [boardDraft, setBoardDraft] = useState({ slug: "", name: "", description: "", icon: "", defaultWorkdir: "", switchAfter: true });
  const [boardSaving, setBoardSaving] = useState(false);
  const [orch, setOrch] = useState<Orchestration | null>(null);
  const [orchDraft, setOrchDraft] = useState({ orchestratorProfile: "", defaultAssignee: "", autoDecompose: false, autoPromoteChildren: false });
  const [orchExpanded, setOrchExpanded] = useState(false);
  const [orchSaving, setOrchSaving] = useState(false);
  const [reassignTo, setReassignTo] = useState("");
  const [depInput, setDepInput] = useState("");
  const [depDir, setDepDir] = useState<"parent" | "child">("child");
  const [workerLog, setWorkerLog] = useState<TaskLog | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());   // 批量选择（Hermes 看板多选）
  const [bulkBusy, setBulkBusy] = useState(false);
  // Shift 范围选的锚点；批量部分失败后要标红的卡（官方 failedIds）。
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);
  const [failedIds, setFailedIds] = useState<Set<string>>(new Set());
  const [bulkAssignee, setBulkAssignee] = useState("");
  const [bulkReclaimFirst, setBulkReclaimFirst] = useState(false);
  const [bulkPriority, setBulkPriority] = useState("");
  const [boardSettingsOpen, setBoardSettingsOpen] = useState(false);
  // 建卡时点的是哪一列（triage 列建卡要带 triage:true，占位文案也不同）。
  const [createColumn, setCreateColumn] = useState<string | null>(null);
  // 评论输入框：诊断的 comment 动作要滚动+聚焦到它（官方同款）。
  const commentRef = useRef<HTMLTextAreaElement>(null);
  // 当前板仍存在的任务 id；刷新后用它剔除已经消失的批量选择。
  const visibleTaskIds = useMemo(
    () => new Set(columns.flatMap((column) => column.tasks.map((task) => task.id))),
    [boardData],
  );
  const total = columns.reduce((s, c) => s + c.tasks.length, 0);
  // 页头统计（Figma 6379-530）：已完成 = done 列（两后端列 id 同名），未完成 = 其余。
  const doneCount = columns.filter((c) => c.id === "done").reduce((s, c) => s + c.tasks.length, 0);
  // Column names arrive from the backend in Chinese (openclaw-backend.js); translate
  // by stable id, falling back to the backend label for unknown (e.g. Hermes) ids.
  const colLabel = useCallback(
    (c: { id: string; name: string }) => t(`tasks.columns.${c.id}`, { defaultValue: c.name }),
    [t],
  );
  const columnOptions = useMemo(() => columns.map((c) => ({ id: c.id, name: colLabel(c) })), [columns, colLabel]);
  // Attention banner: rolled up client-side from card warnings (severity desc, then newest).
  const attentionTasks = useMemo(
    () =>
      columns
        .flatMap((c) => c.tasks)
        .filter((tk) => tk.warnings && tk.warnings.count > 0)
        .sort(
          (a, b) =>
            (HK_SEV_RANK[b.warnings!.highestSeverity] || 0) - (HK_SEV_RANK[a.warnings!.highestSeverity] || 0) ||
            (b.createdAt || 0) - (a.createdAt || 0),
        ),
    [columns],
  );

  const matchCard = useCallback((tk: UnifiedTask) => {
    if (prioFilter && tk.priorityLevel !== prioFilter) return false;
    if (tenantFilter && tk.tenant !== tenantFilter) return false;
    if (assigneeFilter && tk.assignee !== assigneeFilter) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const hay = [tk.id, tk.title, tk.excerpt, tk.agentId, tk.sessionKey, tk.assignee, tk.tenant, (tk.labels || []).join(" ")]
      .filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  }, [query, prioFilter, tenantFilter, assigneeFilter]);

  // Hermes multi-board list (Slice 4) — drives the board switcher.
  const loadBoards = useCallback(async () => {
    const requestedBackend = backend;
    const ticket = auxiliaryReqController.begin("boards", requestedBackend);
    try {
      const nextBoards = await getBoards(requestedBackend);
      if (!auxiliaryReqController.isCurrent(ticket, backendRef.current)) return;
      setBoards(nextBoards);
    } catch {
      if (!auxiliaryReqController.isCurrent(ticket, backendRef.current)) return;
      setBoards([]);
    }
  }, [auxiliaryReqController, backend]);
  useEffect(() => { loadBoards(); }, [loadBoards]);
  // 当前正在看的板（activeBoard 为空 = 跟随服务端 current）。板被 CLI 删掉后
  // 落回 default，免得整页卡在 404 上（官方 loadBoardList 同款兜底）。
  const currentBoard = useMemo(() => {
    if (explicitBoardIdentity) {
      const boardId = resolveNativeBoardId(boards, activeBoard);
      return boards.find((board) => board.id === boardId) || null;
    }
    return boards.find((board) => board.slug === activeBoard)
      || boards.find((board) => board.current)
      || null;
  }, [boards, activeBoard, explicitBoardIdentity]);
  useEffect(() => {
    if (boards.length === 0 || (!activeBoard && !explicitBoardIdentity)) return;
    const nativeBoardId = explicitBoardIdentity ? resolveNativeBoardId(boards, activeBoard) : null;
    const selectedBoards = explicitBoardIdentity ? [] : boards.filter((b) => b.slug === activeBoard);
    const selectedBoard = explicitBoardIdentity
      ? boards.find((b) => b.id === nativeBoardId) || null
      : selectedBoards.length === 1 ? selectedBoards[0] : null;
    if (selectedBoard) {
      const canonical = explicitBoardIdentity ? selectedBoard.id || selectedBoard.slug : selectedBoard.slug;
      if (canonical !== activeBoard) setActiveBoard(canonical);
      return;
    }
    setActiveBoard(fallbackBoardIdentity(boards));
  }, [boards, activeBoard, explicitBoardIdentity, setActiveBoard]);

  // 看板前端偏好（官方 GET /config）：只在用户从没动过这几个开关时拿它当默认值，
  // 动过就以用户的 sticky 选择为准。官方 lane_by_profile 默认是 **开**。
  const cfgApplied = useRef(false);
  useEffect(() => {
    if (detailOnly || !isHermesBoard || cfgApplied.current) return;
    let alive = true;
    (async () => {
      const cfg = await getTaskBoardConfig(backend).catch(() => null);
      if (!alive || !cfg) return;
      cfgApplied.current = true;
      if (cfg.defaultTenant && !hasStickyValue("tasks.tenant")) setTenantFilter(cfg.defaultTenant);
      if (typeof cfg.laneByProfile === "boolean" && !hasStickyValue("tasks.laneByProfile")) setLaneByProfile(cfg.laneByProfile);
      if (typeof cfg.includeArchivedByDefault === "boolean" && !hasStickyValue("tasks.includeArchived")) {
        setIncludeArchived(cfg.includeArchivedByDefault);
      }
    })();
    return () => { alive = false; };
    // 只在后端切换时重试一次；setter 恒定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, detailOnly, isHermesBoard]);

  // Hermes orchestration settings (Slice 5).
  const loadOrch = useCallback(async () => {
    const requestedBackend = backend;
    const ticket = auxiliaryReqController.begin("orchestration", requestedBackend);
    if (!isHermesBoard) {
      if (auxiliaryReqController.isCurrent(ticket, backendRef.current)) setOrch(null);
      return;
    }
    try {
      const o = await getOrchestration(requestedBackend);
      if (!auxiliaryReqController.isCurrent(ticket, backendRef.current)) return;
      setOrch(o);
      setOrchDraft({
        orchestratorProfile: o.orchestratorProfile || "",
        defaultAssignee: o.defaultAssignee || "",
        autoDecompose: !!o.autoDecompose,
        autoPromoteChildren: !!o.autoPromoteChildren,
      });
    } catch {
      if (!auxiliaryReqController.isCurrent(ticket, backendRef.current)) return;
      setOrch(null);
    }
  }, [auxiliaryReqController, backend, isHermesBoard]);
  useEffect(() => { loadOrch(); }, [loadOrch]);
  // Reset modal-extra inputs when the opened task changes.
  useEffect(() => { setWorkerLog(null); setReassignTo(""); setDepInput(""); }, [detail?.id]);
  // Live updates (Slice 9): subscribe to the Hermes kanban event stream via the
  // /__kanbanws broker; on any event, debounce-refetch (only while visible + no
  // modal open). Auto-reconnects. Refs keep the latest refresh/mode so the socket
  // doesn't reconnect on every modal toggle.
  const refreshRef = useRef(refresh);
  const modeRef = useRef(mode);
  const reloadDetailRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => { refreshRef.current = refresh; modeRef.current = mode; });
  useEffect(() => {
    if (!isHermesBoard) return;
    let ws: WebSocket | null = null;
    let retry: number | undefined;
    let debounce: number | undefined;
    let closed = false;
    const connect = () => {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${location.host}/__kanbanws${activeBoard ? `?board=${encodeURIComponent(activeBoard)}` : ""}`;
      try {
        ws = new WebSocket(url);
      } catch {
        retry = window.setTimeout(connect, 4000);
        return;
      }
      ws.onopen = () => { void refreshRef.current(); }; // catch up on (re)connect
      ws.onmessage = (ev) => {
        // 事件里点了名的任务，如果正开着它的详情抽屉，就把抽屉一起重载——
        // 否则 worker 跑完/被阻塞时抽屉里还是旧数据（官方按 task 的 eventTick 重载）。
        try {
          const msg = JSON.parse(String(ev.data));
          const ids: string[] = (Array.isArray(msg?.events) ? msg.events : []).map((e: { task_id?: string }) => String(e?.task_id || ""));
          if (detailTargetRef.current && ids.includes(detailTargetRef.current)) void reloadDetailRef.current();
        } catch { /* 非 JSON 帧忽略 */ }
        if (debounce) window.clearTimeout(debounce);
        debounce = window.setTimeout(() => {
          if (document.visibilityState === "visible" && modeRef.current === null) void refreshRef.current();
        }, 600);
      };
      ws.onclose = () => { if (!closed) retry = window.setTimeout(connect, 4000); };
    };
    connect();
    return () => {
      closed = true;
      if (retry) window.clearTimeout(retry);
      if (debounce) window.clearTimeout(debounce);
      try { ws?.close(); } catch { /* ignore */ }
    };
  }, [backend, activeBoard, isHermesBoard]);

  const close = () => {
    detailReqRef.current += 1;
    detailTargetRef.current = null;
    setMode(null);
    setDetail(null);
    setDetailLoading(false);
    detailOnly?.onClose();
  };

  const openView = async (id: string) => {
    const seq = ++detailReqRef.current;
    detailTargetRef.current = id;
    setMode("view");
    setDetail(null);
    setCommentText("");
    setDetailLoading(true);
    try {
      const next = await getTask(backend, id, boardArg);
      if (seq === detailReqRef.current && detailTargetRef.current === id) setDetail(next);
    } catch (e) {
      if (seq !== detailReqRef.current) return;
      detailTargetRef.current = null;
      toast.error(e instanceof Error ? e.message : String(e));
      setMode(null);
    } finally {
      if (seq === detailReqRef.current) setDetailLoading(false);
    }
  };

  // 切后端或切板时，旧板上的详情响应不能重新打开弹窗。
  useEffect(() => {
    detailReqRef.current += 1;
    detailTargetRef.current = null;
    setMode(null);
    setDetail(null);
    setDetailLoading(false);
  }, [backend, activeBoard]);

  // 深链任务：板数据就绪后打开一次详情弹窗（任务已删除时 openView 自身
  // 会 toast 并退回列表）；随后清掉查询串避免刷新重复触发。
  // 工作板（kind=workboard）由 WorkboardView 自己接管深链详情，这里只清 URL。
  const deepLinkConsumed = useRef(false);
  useEffect(() => {
    if (deepLinkConsumed.current || !deepLink.task || !boardData) return;
    deepLinkConsumed.current = true;
    if (boardData.capabilities?.kind !== "workboard") void openView(deepLink.task);
    if (!detailOnly) navigate("/tasks", { replace: true });
    // openView 依赖当前 backend 闭包，深链只消费一次，不进依赖数组
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardData, deepLink.task, detailOnly?.backendId]);

  const openEdit = () => {
    if (!detail) return;
    setDraft({
      title: detail.title || "",
      body: detail.body || "",
      column: detail.column || columnOptions[0]?.id || "",
      assignee: detail.assignee || "",
      priority: detail.priority || 0,
      priorityLevel: detail.priorityLevel || "normal",
      labels: (detail.labels || []).join(", "),
      agentId: detail.agentId || "",
      sessionKey: detail.sessionKey || "",
      templateId: detail.templateId || "",
      tenant: detail.tenant || "",
      skills: (detail.skills || []).join(", "),
      goalMode: !!detail.goalMode,
      goalMaxTurns: detail.goalMaxTurns || 0,
      workspaceKind: detail.workspaceKind || "scratch",
      workspacePath: detail.workspacePath || "",
      parent: "",
    });
    setMode("edit");
  };

  // column 参数 = 从某一列的 [+] 进来（官方每列都有快速建卡）。工作区默认值取当前板
  // 的 default_workdir/default_workspace_kind——板配了项目目录就默认保留式工作区。
  const openCreate = (column?: string) => {
    detailReqRef.current += 1;
    detailTargetRef.current = null;
    setDetail(null);
    setCreateColumn(column ?? null);
    const b = boards.find((x) => x.slug === activeBoard || x.id === activeBoard)
      || boards.find((y) => y.current);
    const initialColumn = isNativeBoard ? "backlog" : column || columnOptions[0]?.id || "";
    setDraft({ title: "", body: "", column: initialColumn, assignee: "", priority: 0,
      priorityLevel: "normal", labels: "", agentId: "", sessionKey: "", templateId: "",
      tenant: "", skills: "", goalMode: false, goalMaxTurns: 0,
      workspaceKind: b?.defaultWorkspaceKind || "scratch", workspacePath: b?.defaultWorkdir || "", parent: "" });
    setMode("create");
  };

  const buildPatch = (): TaskInput => {
    const p: TaskInput = { title: draft.title, body: draft.body, column: draft.column };
    if (isHermesBoard) {
      p.assignee = draft.assignee || undefined;
      p.priority = Number.isFinite(draft.priority) ? draft.priority : 0;
      // tenant/skills/goal 是官方 CreateTaskBody 独有（UpdateTaskBody 不含），
      // 编辑时提交会被上游静默丢弃（KAN-001）→ 只在创建时带上。
      if (mode === "create") {
        p.tenant = draft.tenant || undefined;
        const sk = draft.skills.split(",").map((s) => s.trim()).filter(Boolean);
        if (sk.length) p.skills = sk;
        if (draft.goalMode) { p.goalMode = true; if (draft.goalMaxTurns > 0) p.goalMaxTurns = draft.goalMaxTurns; }
        // 工作区只在非默认时送（官方同款：请求体小、旧 dispatcher 忽略未知键更安全）。
        if (draft.workspaceKind && draft.workspaceKind !== "scratch") p.workspaceKind = draft.workspaceKind;
        if (draft.workspacePath.trim()) p.workspacePath = draft.workspacePath.trim();
        if (draft.parent) p.parents = [draft.parent];
        // 在 triage 列建卡 = 交给 specifier 细化（官方 InlineCreate 的 triage 标志）。
        if (createColumn === "triage") p.triage = true;
      }
    }
    if (caps.priorities) p.priorityLevel = draft.priorityLevel as TaskInput["priorityLevel"];
    if (caps.labels) p.labels = draft.labels.split(",").map((s) => s.trim()).filter(Boolean);
    if (caps.sessionHandoff) { p.agentId = draft.agentId || undefined; p.sessionKey = draft.sessionKey || undefined; }
    if (caps.templates && draft.templateId) p.templateId = draft.templateId as TaskInput["templateId"];
    return p;
  };

  const saveEdit = async () => {
    if (!detail) return;
    setSaving(true);
    try {
      const patch = buildPatch();
      if (isNativeBoard) {
        if (!canMoveTo(patch.column || detail.column)) throw new Error(t("tasks.moveTargetNotAllowed"));
        for (const step of nativeTaskEditPlan(patch, detail)) {
          await updateTask(backend, detail.id, step, boardArg);
        }
      } else {
        await updateTask(backend, detail.id, patch, boardArg);
      }
      toast.success(t("tasks.savedToast"));
      close();
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const saveCreate = async () => {
    setSaving(true);
    try {
      if (!draft.title.trim()) throw new Error(t("tasks.titleRequired"));
      const nativeBoardId = isNativeBoard
        ? resolveNativeBoardId(boards, activeBoard)
        : undefined;
      if (isNativeBoard && !nativeBoardId) throw new Error(t("tasks.nativeBoardRequired"));
      const spec = buildPatch();
      await createTask(
        backend,
        isNativeBoard ? nativeTaskCreateSpec(spec) : spec,
        isNativeBoard ? nativeBoardId || undefined : boardArg,
      );
      toast.success(t("tasks.createdToast"));
      close();
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const runDiagAction = async (kind: string) => {
    if (!detail) return;
    if (kind === "unblock") {
      try { await taskAction(backend, detail.id, "unblock", boardArg); toast.success(t("tasks.unblockedToast")); await reloadDetail(); await refresh(); }
      catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
    } else if (kind === "reassign") {
      openEdit();
    } else if (kind === "open_session") {
      navigate(`/chat?backend=${encodeURIComponent(backend)}`);
    }
  };

  // 只把卡片标记为 blocked。两个后端都没有「终止运行中会话」的 API，别在文案里假装有。
  const doStopSession = async () => {
    if (!detail) return;
    try { await updateTask(backend, detail.id, { status: "blocked" }, boardArg); toast.success(t("tasks.sessionStopped")); await reloadDetail(); await refresh(); }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
  };

  const doArchive = async () => {
    if (!detail) return;
    const okToArchive = await confirm({
      title: t("tasks.archiveTaskTitle"),
      message: t("tasks.archiveConfirm", { title: detail.title }),
      confirmLabel: t("tasks.archive"),
    });
    if (!okToArchive) return;
    try {
      await archiveTask(backend, detail.id, true, boardArg);
      toast.success(t("tasks.archivedToast"));
      close();
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const doDelete = async () => {
    if (!detail) return;
    const okToDelete = await confirm({
      title: t("tasks.deleteTaskTitle"),
      message: t("tasks.deleteConfirm", { title: detail.title }),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!okToDelete) return;
    try {
      await deleteTask(backend, detail.id, boardArg);
      toast.success(t("tasks.deletedToast"));
      close();
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  // 破坏性转换的确认文案（官方 FALLBACK_DESTRUCTIVE：done/archived/blocked 三种）。
  // 返回 false = 用户取消，调用方直接放弃。
  const confirmTransition = async (status: string, count = 1): Promise<boolean> => {
    if (!caps.completionSummary) return true;   // 只有 Hermes 看板有这套语义
    const key = status === "done" ? "confirmDone" : status === "archived" ? "confirmArchive" : status === "blocked" ? "confirmBlocked" : null;
    if (!key) return true;
    return confirm({
      title: t(`tasks.${key}Title`),
      message: t(`tasks.${key}`, { count }),
      confirmLabel: t("common.ok"),
      danger: status !== "done",
    });
  };

  // 移到 done 必须填完成摘要——它被写进任务的 result+summary，是这张卡对外的交接产出。
  // 用户取消 = 整个转换放弃（官方 withCompletionSummary 同款）。
  const askCompletion = async (status: string, count = 1): Promise<{ result: string; summary: string } | null | "skip"> => {
    if (status !== "done" || !caps.completionSummary) return "skip";
    const label = count > 1 ? t("tasks.completionLabelMany", { count }) : t("tasks.completionLabelOne");
    const value = await prompt({
      title: t("tasks.completionSummaryTitle"),
      message: t("tasks.completionSummary", { label }),
      placeholder: t("tasks.completionSummaryPlaceholder"),
      required: true,
      multiline: true,
      confirmLabel: t("tasks.complete"),
    });
    if (value === null) return null;
    return { result: value, summary: value };
  };

  const quickMove = async (id: string, column: string) => {
    if (!(await confirmTransition(column))) return;
    const done = await askCompletion(column);
    if (done === null) return;
    try {
      await updateTask(backend, id, { column, ...(done === "skip" ? {} : done) }, boardArg);
      toast.success(t("tasks.movedToast"));
      // 弹窗打开时其 detail.column 是旧值 → 同步刷新（KAN-008）。
      if (detail?.id === id) await reloadDetail();
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  // 抽屉里自包含的几块（附件/home/模型/诊断）共用的上下文：它们各自发请求，
  // 改完回调这里统一重载详情 + 刷板。
  const detailCtx = useMemo(
    () => (detail ? { backend, taskId: detail.id, board: boardArg, onChanged: async () => { await reloadDetail(); await refresh(); } } : null),
    // reloadDetail/refresh 每渲染都是新引用，这里只关心目标任务变没变
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [backend, detail?.id, boardArg],
  );

  const reloadDetail = async () => {
    if (!detail) return;
    const targetId = detail.id;
    // 旧任务动作迟到时先退出，不能抢走新任务 openView 已领取的代际。
    if (detailTargetRef.current !== targetId) return;
    const seq = ++detailReqRef.current;
    try {
      const next = await getTask(backend, targetId, boardArg);
      if (seq === detailReqRef.current && detailTargetRef.current === targetId) setDetail(next);
    } catch {
      /* keep current */
    }
  };
  reloadDetailRef.current = reloadDetail;

  const postComment = async () => {
    if (!detail || !commentText.trim()) return;
    setPosting(true);
    try {
      await addTaskComment(backend, detail.id, commentText.trim(), undefined, boardArg);
      setCommentText("");
      await reloadDetail();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setPosting(false);
    }
  };

  const runAction = async (action: "specify" | "decompose") => {
    if (!detail) return;
    setActionBusy(action);
    try {
      const r = await taskAction(backend, detail.id, action, boardArg);
      if (r.ok === false) {
        toast.info(r.reason || t("tasks.actionSkipped", { action }));
      } else {
        toast.success(action === "specify" ? t("tasks.specifiedToast") : t("tasks.decomposedToast"));
      }
      await reloadDetail();
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(null);
    }
  };

  const doRun = async (
    engine: "codex" | "claude" | undefined,
    mode: WorkboardRunMode,
    options?: { retryOf?: string },
  ) => {
    if (!detail) return;
    const tag = `${engine ?? "default"}:${mode}`;
    setRunBusy(tag);
    try {
      const r = await runTask(backend, detail.id, engine, mode, options);
      if (mode !== "manual" && r.runStarted === false) toast.info(t("tasks.runFailedToast"));
      else toast.success(t("tasks.runStartedToast"));
      await reloadDetail();
      await refresh();
      // official navigates only when a session was created —— 但官方只跳 /chat，落地是
      // 「请选择会话」。带上 session 走深链（ChatPage 那边有合成行兜底，新建的会话还没
      // 进 sessions.list 也能立刻打开），与工作板的 onOpenSession 同一套语义。
      if (r.sessionKey) navigate(`/chat?backend=${encodeURIComponent(backend)}&session=${encodeURIComponent(r.sessionKey)}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRunBusy(null);
    }
  };

  const nativeRetryCommand = detail
    ? nativeTaskRunCommand(caps, detail, "retry")
    : null;
  const doNativeRun = async (intent: "run" | "retry") => {
    if (!detail) return;
    const command = nativeTaskRunCommand(caps, detail, intent);
    if (!command) {
      toast.info(t("tasks.nativeRetryUnavailable"));
      return;
    }
    await doRun(undefined, command.mode, { retryOf: command.retryOf });
  };

  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);
  const [trashOver, setTrashOver] = useState(false);
  const endDrag = () => { setDragId(null); setDragOverCol(null); setTrashOver(false); };
  // 拖的是一张已选中的卡且选区 >1 → 整批一起动（官方同款），并把拖影换成「N 张卡」。
  const dragIsBatch = (id: string) => selected.has(id) && selected.size > 1;
  const onCardDragStart = (e: React.DragEvent, id: string) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
    if (dragIsBatch(id)) {
      const ghost = document.createElement("div");
      ghost.className = "hk-drag-ghost";
      ghost.textContent = t("tasks.dragGhost", { count: selected.size });
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 0, 0);
      requestAnimationFrame(() => ghost.remove());
    }
  };
  const onColDrop = async (e: React.DragEvent, colId: string) => {
    e.preventDefault();
    const id = dragId || e.dataTransfer.getData("text/plain");
    const batch = !!id && dragIsBatch(id);
    endDrag();
    if (!id) return;
    if (!canMoveTo(colId)) {
      toast.info(t("tasks.moveTargetNotAllowed"));
      return;
    }
    if (batch) return void doBulk({ status: colId });
    if (!(await confirmTransition(colId))) return;
    const done = await askCompletion(colId);
    if (done === null) return;
    const colTasks = columns.find((c) => c.id === colId)?.tasks ?? [];
    const maxPos = colTasks.reduce((m, tk) => Math.max(m, tk.position ?? 0), 0);
    try {
      await moveTask(backend, id, colId, maxPos + 1000, boardArg, done === "skip" ? undefined : done);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };
  // 垃圾桶拖放 = 永久删除（官方 TrashDropZone），拖批量则整批删。
  const onTrashDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const id = dragId || e.dataTransfer.getData("text/plain");
    const batch = !!id && dragIsBatch(id);
    endDrag();
    if (!id) return;
    if (batch) return void doBulkDelete();
    const tk = columns.flatMap((c) => c.tasks).find((x) => x.id === id);
    const okDel = await confirm({
      title: t("tasks.deleteTaskTitle"),
      message: t("tasks.trashConfirm", { title: tk?.title || id }),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!okDel) return;
    try {
      await deleteTask(backend, id, boardArg);
      if (detail?.id === id) close();
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const setDraftField = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...draft, [k]: v });

  // 可连的依赖候选：全板任务减去自己和已经连上的（官方 DependencyEditor 同款）。
  const linkCandidates = useMemo(() => {
    if (!detail) return [];
    const taken = new Set<string>([detail.id, ...(detail.linkIds?.parents ?? []), ...(detail.linkIds?.children ?? [])]);
    return columns.flatMap((c) => c.tasks).filter((tk) => !taken.has(tk.id)).map((tk) => ({ id: tk.id, title: tk.title }));
  }, [columns, detail]);

  const clearFilters = () => {
    setQuery("");
    setTenantFilter("");
    setAssigneeFilter("");
    setIncludeArchived(false);
  };

  // Nudge dispatcher: real side effect (claims + spawns ready workers). The button
  // fires for real; smoke uses dryRun. Surfaces claimed/spawned counts the official UI drops.
  const doNudge = async () => {
    setNudging(true);
    try {
      const r = await nudgeDispatcher(backend);
      toast.success(
        r.claimed || r.spawned
          ? t("tasks.nudgeResult", { claimed: r.claimed, spawned: r.spawned })
          : t("tasks.nudgeEmpty"),
      );
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setNudging(false);
    }
  };

  // 板级诊断（GAP-002）：有活跃诊断的任务清单，点行深入详情。
  const openDiagnostics = async () => {
    setDiagOpen(true);
    setDiagRows(null);
    try {
      setDiagRows(await getTaskDiagnostics(backend, { board: boardArg }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      setDiagOpen(false);
    }
  };

  // 看板选择是**本页的浏览视角**，不动服务端的 current 板：官方明确这么设计
  // （#20879），否则用户在这里点一下就把某个开着终端的 CLI 会话的活动板抢走了。
  // 每个请求都显式带 ?board=；真正写 current 的只有「新建后切换到该板」那个勾选。
  // 切板同时清筛选与选区（跨板的搜索/租户/受理人筛选毫无意义）。
  const onSelectBoard = async (slug: string) => {
    const ticket = boardSwitchController.begin(slug);
    if (!boardSwitchController.isCurrent(ticket, slug)) return;
    setActiveBoard(slug);
    setQuery("");
    setTenantFilter("");
    setAssigneeFilter("");
    clearSelection();
  };

  // 归档看板：挪到 boards/_archived/ 可恢复，卡片从 UI 消失。default 不可归档。
  const doArchiveBoard = async () => {
    const slug = currentBoard?.slug;
    if (!slug || slug === "default") return;
    const okArchive = await confirm({
      title: t("tasks.archiveBoard"),
      message: t("tasks.archiveBoardConfirm", { name: currentBoard?.name || slug }),
      confirmLabel: t("tasks.archive"),
      danger: true,
    });
    if (!okArchive) return;
    try {
      await deleteBoard(backend, slug);
      toast.success(t("tasks.boardArchived"));
      setActiveBoard("default");
      await loadBoards();
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  // 后端改变会切换整个看板上下文，必须在 setState 前同步作废旧后端请求。
  const onBackendChange = (nextBackend: BackendId) => {
    boardSwitchController.invalidate();
    auxiliaryReqController.invalidate();
    setBoards([]);
    setOrch(null);
    setBackend(nextBackend);
  };
  const submitBoard = async () => {
    if (!boardDraft.slug.trim()) { toast.error(t("tasks.boardSlugRequired")); return; }
    setBoardSaving(true);
    try {
      await createBoard(backend, {
        slug: boardDraft.slug.trim(),
        name: boardDraft.name || undefined,
        description: boardDraft.description || undefined,
        icon: boardDraft.icon || undefined,
        defaultWorkdir: boardDraft.defaultWorkdir || undefined,
        switch: boardDraft.switchAfter,
      });
      toast.success(t("tasks.boardCreated"));
      setBoardDialog(false);
      if (boardDraft.switchAfter) setActiveBoard(boardDraft.slug.trim());
      await loadBoards();
      setBoardDraft({ slug: "", name: "", description: "", icon: "", defaultWorkdir: "", switchAfter: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBoardSaving(false);
    }
  };

  // Orchestration pill toggles Auto/Manual (auto_decompose); panel saves the full set.
  const toggleAuto = async () => {
    if (!orch) return;
    try {
      const next = await setOrchestration(backend, {
        orchestratorProfile: orch.orchestratorProfile,
        defaultAssignee: orch.defaultAssignee,
        autoDecompose: !orch.autoDecompose,
        autoPromoteChildren: orch.autoPromoteChildren,
      });
      setOrch(next);
      setOrchDraft({
        orchestratorProfile: next.orchestratorProfile || "", defaultAssignee: next.defaultAssignee || "",
        autoDecompose: !!next.autoDecompose, autoPromoteChildren: !!next.autoPromoteChildren,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };
  const saveOrch = async () => {
    setOrchSaving(true);
    try {
      const next = await setOrchestration(backend, orchDraft);
      setOrch(next);
      toast.success(t("tasks.orchSaved"));
      setOrchExpanded(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setOrchSaving(false);
    }
  };

  // Detail-modal extras (Slice 6): reassign/reclaim, dependency links, worker log.
  const doReassign = async () => {
    if (!detail || !reassignTo) return;
    try {
      await reassignTask(backend, detail.id, reassignTo, undefined, boardArg);
      toast.success(t("tasks.reassignBtn"));
      setReassignTo("");
      await reloadDetail();
      await refresh();
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
  };
  const doReclaim = async () => {
    if (!detail) return;
    try {
      await reclaimTask(backend, detail.id, boardArg);
      toast.success(t("tasks.reclaimBtn"));
      await reloadDetail();
      await refresh();
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
  };
  const doAddLink = async () => {
    if (!detail || !depInput.trim()) return;
    const other = depInput.trim();
    const [parent, child] = depDir === "parent" ? [other, detail.id] : [detail.id, other];
    try {
      await addTaskLink(backend, parent, child, boardArg);
      setDepInput("");
      await reloadDetail();
      await refresh();
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
  };
  const doRemoveLink = async (otherId: string, isParent: boolean) => {
    if (!detail) return;
    const [parent, child] = isParent ? [otherId, detail.id] : [detail.id, otherId];
    try {
      await removeTaskLink(backend, parent, child, boardArg);
      await reloadDetail();
      await refresh();
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
  };
  const loadLog = async () => {
    if (!detail) return;
    setLogLoading(true);
    try { setWorkerLog(await getTaskLog(backend, detail.id, boardArg)); }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
    finally { setLogLoading(false); }
  };

  // 批量选择：切后端/切板时清空；选中卡片后浮现操作栏，扇出到单任务端点。
  useEffect(() => { setSelected(new Set()); }, [backend, activeBoard]);
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => visibleTaskIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [visibleTaskIds]);
  // additive=false（普通 checkbox / Ctrl 点击）只加减自己；Shift 点击走 toggleRange。
  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
    setLastSelectedId(id);
    setFailedIds((prev) => {
      if (!prev.has(id)) return prev;
      const n = new Set(prev); n.delete(id); return n;
    });
  };
  // 可见卡的扁平顺序（按列、按列内顺序）——Shift 范围选沿着它取区间。
  const visibleOrder = useMemo(
    () => columns.flatMap((c) => c.tasks.filter(matchCard).map((tk) => tk.id)),
    [columns, matchCard],
  );
  const toggleRange = (toId: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      const a = lastSelectedId ? visibleOrder.indexOf(lastSelectedId) : -1;
      const b = visibleOrder.indexOf(toId);
      if (a === -1 || b === -1) { n.add(toId); return n; }
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) n.add(visibleOrder[i]);
      return n;
    });
    setLastSelectedId(toId);
  };
  const selectAllVisible = () => {
    setSelected(new Set(visibleOrder));
    if (visibleOrder.length) setLastSelectedId(visibleOrder[0]);
  };
  const selectAllInColumn = (colId: string) => {
    const ids = (columns.find((c) => c.id === colId)?.tasks ?? []).filter(matchCard).map((tk) => tk.id);
    if (!ids.length) return;
    setSelected((prev) => {
      const all = ids.every((id) => prev.has(id));
      const n = new Set(prev);
      for (const id of ids) { if (all) n.delete(id); else n.add(id); }
      return n;
    });
    setLastSelectedId(ids[0]);
  };
  const clearSelection = () => { setSelected(new Set()); setLastSelectedId(null); setFailedIds(new Set()); };

  const doBulk = async (patch: BulkTaskPatch) => {
    if (!selected.size) return;
    if (patch.status && !(await confirmTransition(patch.status, selected.size))) return;
    if (patch.archive && !(await confirmTransition("archived", selected.size))) return;
    const done = await askCompletion(patch.status || "", selected.size);
    if (done === null) return;
    setBulkBusy(true);
    try {
      const r = await bulkUpdateTasks(backend, [...selected], { ...patch, ...(done === "skip" ? {} : done) }, boardArg);
      if (r.failed) {
        toast.error(t("tasks.bulkPartial", { ok: r.total - r.failed, failed: r.failed }));
        // 失败的卡留在选区里并标红，方便用户看清是哪几张、直接重试。
        setSelected(new Set(r.failedIds || []));
        setFailedIds(new Set(r.failedIds || []));
      } else {
        toast.success(t("tasks.bulkDone", { count: r.total }));
        clearSelection();
      }
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setBulkBusy(false); }
  };

  const doBulkDelete = async () => {
    if (!selected.size) return;
    const okDel = await confirm({
      title: t("tasks.deleteTaskTitle"),
      message: t("tasks.trashConfirmMany", { count: selected.size }),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!okDel) return;
    setBulkBusy(true);
    try {
      const r = await bulkDeleteTasks(backend, [...selected], boardArg);
      if (r.failed) {
        toast.error(t("tasks.bulkPartial", { ok: r.total - r.failed, failed: r.failed }));
        setSelected(new Set(r.failedIds || []));
        setFailedIds(new Set(r.failedIds || []));
      } else {
        toast.success(t("tasks.bulkDone", { count: r.total }));
        clearSelection();
      }
      if (detail && selected.has(detail.id)) close();
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setBulkBusy(false); }
  };

  // One card renderer reused by the flat column body and the per-profile lanes.
  const renderCard = (tk: UnifiedTask) => (
    <div
      key={tk.id}
      className={`kanban-card clickable${tk.live ? " is-live" : ""}${caps.kind === "hermes" ? hkStaleClass(tk) : ""}${
        selected.has(tk.id) ? " is-selected" : ""}${failedIds.has(tk.id) ? " is-failed" : ""}`}
      draggable={!!caps.drag}
      onDragStart={(e) => onCardDragStart(e, tk.id)}
      onDragEnd={endDrag}
      // Shift = 范围选，Ctrl/Cmd = 加选，普通点击 = 打开详情（官方 TaskCard 同款）。
      onClick={(e) => {
        if (caps.kind === "hermes" && e.shiftKey) { e.preventDefault(); toggleRange(tk.id); return; }
        if (caps.kind === "hermes" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); toggleSelect(tk.id); return; }
        openView(tk.id);
      }}
    >
      {caps.kind === "hermes" ? (
        <>
          <input
            type="checkbox"
            className="hk-card-check"
            checked={selected.has(tk.id)}
            onClick={(e) => e.stopPropagation()}
            onChange={() => toggleSelect(tk.id)}
            title={t("tasks.bulkSelect")}
          />
          <HermesCardBody tk={tk} />
        </>
      ) : (
        <>
          {tk.priorityLevel && (
            <span className={`wb-prio wb-prio--${tk.priorityLevel}`}>{t(`tasks.priority.${tk.priorityLevel}`)}</span>
          )}
          {tk.live && <span className="wb-live">●</span>}
          <div className="kanban-card-title">{tk.title}</div>
          {tk.excerpt && <div className="kanban-card-excerpt">{tk.excerpt}</div>}
          {tk.labels && tk.labels.length > 0 && (
            <div className="wb-labels">{tk.labels.map((l) => <span key={l} className="wb-label">{l}</span>)}</div>
          )}
          <div className="kanban-card-meta">
            {tk.agentId && <span className="kanban-assignee"><CardAvatar id={tk.agentId} />@{tk.agentId}</span>}
            {tk.assignee && <span className="kanban-assignee"><CardAvatar id={tk.assignee} />@{tk.assignee}</span>}
            {typeof tk.priority === "number" && tk.priority > 0 && <span className="chip-meta">P{tk.priority}</span>}
            <TaskBadges b={tk.badges} />
            {cardDate(tk) && <span className="kb-date">{cardDate(tk)}</span>}
          </div>
        </>
      )}
    </div>
  );

  return (
    <div className="page management-page tasks-page" hidden={!!detailOnly}>
      {/* 页头（Figma 6379-530）：大标题 + 未完成/已完成/总任务统计行；
          工作板 = 官方标题「工作板 / 智能体工作队列和会话交接。」 */}
      <PageHead
        title={isWorkboard ? t("tasks.wb.pageTitle") : t("tasks.pageTitle")}
        subtitle={
          isWorkboard ? (
            t("tasks.wb.pageSubtitle")
          ) : (
            <div className="kb-stats">
              <span>{t("tasks.statOpen", { count: board ? total - doneCount : "—" })}</span>
              <span>{t("tasks.statDone", { count: board ? doneCount : "—" })}</span>
              <span>{t("tasks.statTotal", { count: board ? total : "—" })}</span>
            </div>
          )
        }
      />
      {/* OpenClaw 工作板：1:1 官方视图（工具条/健康条/九列/模态/详情全在组件内） */}
      {isWorkboard && (
        // 后端切换不再单占一行——它是工具条的第一颗控件，交给 WorkboardView 排进主行，
        // 免得 48px 的 PillTabs 和工作板自己的工具条上下叠成两套语言（R268）。
        <WorkboardView
          backend={backend}
          board={board}
          loading={loading}
          error={error}
          refresh={refreshWb}
          leading={<BackendTabs value={backend} onChange={onBackendChange} surface="kanban" />}
          deepLinkTask={deepLink.task || undefined}
          detailOnly={!!detailOnly}
          onDetailClose={detailOnly?.onClose}
          onOpenSession={(key) => navigate(`/chat?backend=${encodeURIComponent(backend)}&session=${encodeURIComponent(key)}`)}
        />
      )}
      {!isWorkboard && (
      <>
      {caps.boards && (
        <div className="hk-boardbar">
          <span className="hk-boardbar-label">{t("tasks.board")}</span>
          <Select value={explicitBoardIdentity ? currentBoard?.id || "" : currentBoard?.slug || ""} onChange={onSelectBoard}>
            {explicitBoardIdentity && boards.length > 1 && <Option value="">{t("tasks.nativeBoardRequired")}</Option>}
            {boards.map((b) => (
              <Option key={explicitBoardIdentity ? b.id || b.slug : b.slug} value={explicitBoardIdentity ? b.id || b.slug : b.slug}>
                {b.name}{explicitBoardIdentity && b.profileName ? ` · ${b.profileName}` : ""}{b.total ? ` · ${b.total}` : ""}
              </Option>
            ))}
          </Select>
          <span className="muted">{t("tasks.boardTasks", { count: total })}</span>
          {isHermesBoard && <button className="ui-cbtn ui-cbtn--sm" onClick={() => setBoardDialog(true)}>{t("tasks.newBoard")}</button>}
          {isHermesBoard && caps.boardSettings && (
            <button className="ui-cbtn ui-cbtn--sm" onClick={() => setBoardSettingsOpen(true)}>{t("tasks.boardSettings")}</button>
          )}
          {/* 归档看板：挪进 boards/_archived/ 可恢复；default 板不给这个按钮。 */}
          {isHermesBoard && currentBoard && currentBoard.slug !== "default" && (
            <button className="ui-cbtn ui-cbtn--sm" onClick={doArchiveBoard}>{t("tasks.archiveBoard")}</button>
          )}
        </div>
      )}
      {caps.kind === "hermes" && caps.orchestration && orch && (
        <div className="hk-orch">
          <button className="ui-toggle" aria-pressed={orch.autoDecompose} onClick={toggleAuto}>
            {t("tasks.orchModeLabel")}: {orch.autoDecompose ? t("tasks.orchAuto") : t("tasks.orchManual")}
          </button>
          <button className="ui-toggle" aria-pressed={orchExpanded} onClick={() => setOrchExpanded((v) => !v)}>
            › {orchExpanded ? t("tasks.hide") : t("tasks.orchSettings")}
          </button>
          {orchExpanded && (
            <div className="hk-orch-panel">
              <Field label={t("tasks.orchProfile")}>
                <Select value={orchDraft.orchestratorProfile} onChange={(v) => setOrchDraft({ ...orchDraft, orchestratorProfile: v })}>
                  <Option value="">{t("tasks.orchAutoLabel", { name: orch.resolvedOrchestratorProfile || "—" })}</Option>
                  {(board?.assignees ?? []).map((p) => <Option key={p} value={p}>{p}</Option>)}
                  {orchDraft.orchestratorProfile && !(board?.assignees ?? []).includes(orchDraft.orchestratorProfile) && (
                    <Option value={orchDraft.orchestratorProfile}>{orchDraft.orchestratorProfile}</Option>
                  )}
                </Select>
              </Field>
              <Field label={t("tasks.orchAssignee")}>
                <Select value={orchDraft.defaultAssignee} onChange={(v) => setOrchDraft({ ...orchDraft, defaultAssignee: v })}>
                  <Option value="">{t("tasks.orchAutoLabel", { name: orch.resolvedDefaultAssignee || "—" })}</Option>
                  {(board?.assignees ?? []).map((p) => <Option key={p} value={p}>{p}</Option>)}
                  {orchDraft.defaultAssignee && !(board?.assignees ?? []).includes(orchDraft.defaultAssignee) && (
                    <Option value={orchDraft.defaultAssignee}>{orchDraft.defaultAssignee}</Option>
                  )}
                </Select>
              </Field>
              <label className="hk-check">
                <input type="checkbox" checked={orchDraft.autoDecompose} onChange={(e) => setOrchDraft({ ...orchDraft, autoDecompose: e.target.checked })} />
                {t("tasks.autoDecompose")}
              </label>
              <label className="hk-check">
                <input type="checkbox" checked={orchDraft.autoPromoteChildren} onChange={(e) => setOrchDraft({ ...orchDraft, autoPromoteChildren: e.target.checked })} />
                {t("tasks.autoPromote")}
              </label>
              <button className="ui-cbtn ui-cbtn--sm ui-cbtn--gold" onClick={saveOrch} disabled={orchSaving}>
                {orchSaving ? t("common.loading") : t("common.save")}
              </button>
              {/* Profile 描述指导分解器把子任务路由给谁——官方把它放在编排面板里。 */}
              {caps.profiles && <ProfileDescriptions backend={backend} />}
            </div>
          )}
        </div>
      )}
      {/* 过滤条（Figma 6379-530）：后端切换 seg → Agent/Priority 胶囊 → 搜索靠右；
          功能控件与处理函数零变化，只按设计稿重排 + 套 .kb-pill 胶囊壳。 */}
      <div className="ui-toolbar">
        <BackendTabs value={backend} onChange={onBackendChange} surface="kanban" />
        {caps.kind === "hermes" && (
          <span className="kb-pill">
            <AgentGlyph />
            <Select value={assigneeFilter} onChange={setAssigneeFilter}>
              <Option value="">{t("tasks.allProfiles")}</Option>
              {(board?.assignees ?? []).map((a) => <Option key={a} value={a}>@{a}</Option>)}
            </Select>
          </span>
        )}
        {caps.priorities && caps.priorities.length > 0 && (
          <span className="kb-pill">
            <PriorityGlyph />
            <Select value={prioFilter} onChange={setPrioFilter}>
              <Option value="">{t("tasks.allPriorities")}</Option>
              {caps.priorities.map((p) => (
                <Option key={p} value={p}>{t(`tasks.priority.${p}`)}</Option>
              ))}
            </Select>
          </span>
        )}
        {caps.kind === "hermes" && (
          <>
            <span className="kb-pill">
              <Select value={tenantFilter} onChange={setTenantFilter}>
                <Option value="">{t("tasks.allTenants")}</Option>
                {(board?.tenants ?? []).map((tn) => <Option key={tn} value={tn}>{tn}</Option>)}
              </Select>
            </span>
            {/* 原生 checkbox 换成与工作板视图行同一套的 32px 胶囊开关（R268）。 */}
            <button
              type="button"
              className="ui-toggle"
              aria-pressed={includeArchived}
              onClick={() => setIncludeArchived((v) => !v)}
            >
              {t("tasks.showArchived")}
            </button>
            <button
              type="button"
              className="ui-toggle"
              aria-pressed={laneByProfile}
              onClick={() => setLaneByProfile((v) => !v)}
            >
              {t("tasks.lanesByProfile")}
            </button>
            <button type="button" className="ui-toggle" onClick={clearFilters}>
              {t("tasks.clearFilters")}
            </button>
          </>
        )}
        <span className="ui-toolbar-end">
          <SearchCapsule
            value={query}
            onChange={setQuery}
            placeholder={t("tasks.searchPlaceholder")}
          />
          {caps.kind === "hermes" && caps.dispatch && (
            <button className="ui-cbtn" onClick={doNudge} disabled={nudging}>{t("tasks.nudge")}</button>
          )}
          {caps.kind === "hermes" && caps.diagnostics && (
            <button className="ui-cbtn" onClick={openDiagnostics}>{t("tasks.diagnosticsBtn")}</button>
          )}
          <button
            className="ui-cbtn ui-cbtn--gold"
            onClick={() => openCreate()}
            disabled={explicitBoardIdentity && !resolveNativeBoardId(boards, activeBoard)}
          >
            {t("tasks.newTaskBtn")}
          </button>
        </span>
      </div>

      {caps.kind === "hermes" && selected.size > 0 && (
        <div className="hk-bulkbar">
          <span className="hk-bulkbar-count">{t("tasks.bulkSelected", { count: selected.size })}</span>
          <Select value="" onChange={(v) => v && doBulk({ status: v })} disabled={bulkBusy}>
            <Option value="">{t("tasks.bulkMove")}</Option>
            {columnOptions.filter((c) => canMoveTo(c.id)).map((c) => <Option key={c.id} value={c.id}>{c.name}</Option>)}
          </Select>
          <button className="ui-cbtn ui-cbtn--sm" onClick={() => doBulk({ status: "blocked" })} disabled={bulkBusy}>{t("tasks.blockBtn")}</button>
          <button className="ui-cbtn ui-cbtn--sm" onClick={() => doBulk({ status: "ready" })} disabled={bulkBusy}>{t("tasks.unblockBtn")}</button>
          <button className="ui-cbtn ui-cbtn--sm" onClick={() => doBulk({ status: "done" })} disabled={bulkBusy}>{t("tasks.complete")}</button>
          <button className="ui-cbtn ui-cbtn--sm" onClick={() => doBulk({ archive: true })} disabled={bulkBusy}>{t("tasks.bulkArchive")}</button>
          {caps.bulkDelete && (
            <button className="ui-cbtn ui-cbtn--sm btn-danger" onClick={doBulkDelete} disabled={bulkBusy}>{t("common.delete")}</button>
          )}
          {/* 优先级：数字越大越先被 dispatcher 认领。 */}
          <span className="hk-bulk-group">
            <TextInput
              type="number"
              value={bulkPriority}
              placeholder={t("tasks.priorityField")}
              onChange={(e) => setBulkPriority(e.target.value)}
            />
            <button
              className="ui-cbtn ui-cbtn--sm"
              disabled={bulkBusy || bulkPriority === ""}
              onClick={() => { doBulk({ priority: Number(bulkPriority) || 0 }); setBulkPriority(""); }}
            >{t("tasks.bulkSetPriority")}</button>
          </span>
          {/* 指派：__none__ = 解除指派（官方语义，"" 才是"没选"）。 */}
          <span className="hk-bulk-group">
            <Select value={bulkAssignee} onChange={setBulkAssignee} disabled={bulkBusy}>
              <Option value="">{t("tasks.bulkAssign")}</Option>
              <Option value="__none__">{t("tasks.bulkUnassign")}</Option>
              {(board?.assignees ?? []).map((p) => <Option key={p} value={p}>@{p}</Option>)}
            </Select>
            <button
              className="ui-cbtn ui-cbtn--sm"
              disabled={bulkBusy || !bulkAssignee}
              onClick={() => {
                doBulk({ assignee: bulkAssignee === "__none__" ? "" : bulkAssignee, reclaimFirst: bulkReclaimFirst });
                setBulkAssignee("");
              }}
            >{t("tasks.bulkApply")}</button>
            <button
              type="button"
              className="ui-toggle"
              aria-pressed={bulkReclaimFirst}
              title={t("tasks.reclaimFirstHint")}
              onClick={() => setBulkReclaimFirst((v) => !v)}
            >{t("tasks.reclaimFirst")}</button>
          </span>
          <span className="ui-toolbar-end">
            <button className="ui-cbtn ui-cbtn--sm" onClick={selectAllVisible} disabled={bulkBusy}>{t("tasks.selectAllVisible")}</button>
            <button className="ui-cbtn ui-cbtn--sm" onClick={clearSelection} disabled={bulkBusy}>{t("tasks.bulkClear")}</button>
          </span>
        </div>
      )}

      {caps.kind === "hermes" && !bannerDismissed && attentionTasks.length > 0 && (
        <div className="hk-attn ui-banner ui-banner--danger">
          <div className="hk-attn-head">
            <span className={`hk-warn hk-warn--${attentionTasks[0].warnings!.highestSeverity}`}>
              {hkWarnGlyph(attentionTasks[0].warnings!.highestSeverity)}
            </span>
            <span className="hk-attn-title">{t("tasks.needAttention", { count: attentionTasks.length })}</span>
            <button className="ui-toggle" aria-pressed={bannerExpanded} onClick={() => setBannerExpanded((v) => !v)}>
              {bannerExpanded ? t("tasks.hide") : t("tasks.show")}
            </button>
            <button className="ui-toggle ui-toggle--icon" onClick={() => setBannerDismissed(true)} aria-label={t("common.close")}>×</button>
          </div>
          {bannerExpanded && (
            <div className="hk-attn-list">
              {attentionTasks.map((tk) => (
                <button key={tk.id} className="hk-attn-row" onClick={() => openView(tk.id)}>
                  <span className={`hk-warn hk-warn--${tk.warnings!.highestSeverity}`}>{hkWarnGlyph(tk.warnings!.highestSeverity)}</span>
                  <span className="hk-id">{tk.id}</span>
                  <span className="hk-attn-rowtitle">{tk.title}</span>
                  <span className="kanban-assignee">{tk.assignee ? `@${tk.assignee}` : t("tasks.unassigned")}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 首载提示（老工具条 spacer 的加载态挪到这里；后台刷新 loading=false 不闪） */}
      {loading && columns.length === 0 && (
        <p className="muted"><FusionLoader size="md" label={t("common.loading")} /></p>
      )}
      {error && <div className="error">{t("tasks.error", { msg: error })}</div>}
      {!loading && !error && columns.length === 0 && (
        <p className="muted">
          {t("tasks.emptyBoard1")}{isHermesBoard ? t("tasks.emptyBoardHermesHint") : ""}{t("tasks.emptyBoard2")}
        </p>
      )}

      {!loading && columns.length > 0 && (
        <div className="kanban">
          {columns.map((col) => (
            <div
              key={col.id}
              className={`kanban-col${dragOverCol === col.id ? " drag-over" : ""}`}
              onDragOver={(e) => { if (caps.drag) { e.preventDefault(); if (dragOverCol !== col.id) setDragOverCol(col.id); } }}
              onDrop={(e) => caps.drag && onColDrop(e, col.id)}
            >
              <div className="kanban-col-head">
                {caps.kind === "hermes" && (
                  <input
                    type="checkbox"
                    className="hk-col-check"
                    title={t("tasks.selectAllInColumn")}
                    checked={col.tasks.length > 0 && col.tasks.filter(matchCard).every((tk) => selected.has(tk.id))}
                    onChange={() => selectAllInColumn(col.id)}
                  />
                )}
                <span className="hk-colname">
                  {caps.kind === "hermes" && (
                    <span className="hk-dot" style={{ background: HERMES_COLUMN_META[col.id]?.dot || "var(--muted, #888)" }} />
                  )}
                  {caps.kind === "hermes" ? (HERMES_COLUMN_META[col.id]?.label ?? colLabel(col)) : colLabel(col)}
                </span>
                <span className="muted">{col.tasks.length}</span>
                {caps.kind === "hermes" && (
                  <button
                    type="button"
                    className="hk-col-add"
                    title={t("tasks.createInColumn")}
                    onClick={() => openCreate(col.id)}
                  >+</button>
                )}
              </div>
              {caps.kind === "hermes" && HERMES_COLUMN_META[col.id]?.subtitle && (
                <div className="hk-colsub muted">{HERMES_COLUMN_META[col.id].subtitle}</div>
              )}
              <div className="kanban-col-body">
                {(() => {
                  const shown = col.tasks.filter(matchCard);
                  if (caps.kind === "hermes" && laneByProfile && col.id === "running" && shown.length > 0) {
                    const byProfile: Record<string, UnifiedTask[]> = {};
                    for (const tk of shown) {
                      const k = tk.assignee || "(unassigned)";
                      (byProfile[k] ||= []).push(tk);
                    }
                    return Object.keys(byProfile).sort().map((prof) => (
                      <div key={prof} className="hk-lane">
                        <div className="hk-lane-head">
                          <span className="hk-lane-name">{prof}</span>
                          <span className="hk-lane-count">{byProfile[prof].length}</span>
                        </div>
                        {byProfile[prof].map(renderCard)}
                      </div>
                    ));
                  }
                  return shown.map(renderCard);
                })()}
                {col.tasks.length === 0 && <div className="kanban-empty muted">{t("tasks.columnEmpty")}</div>}
              </div>
            </div>
          ))}
          {/* 垃圾桶：拖卡进来 = 永久删除（拖的是选中批则整批删）。仅拖拽中高亮。 */}
          {caps.kind === "hermes" && caps.bulkDelete && (
            <div
              className={`hk-trash${dragId ? " is-active" : ""}${trashOver ? " is-over" : ""}`}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (!trashOver) setTrashOver(true); }}
              onDragLeave={() => setTrashOver(false)}
              onDrop={onTrashDrop}
            >
              <span className="hk-trash-icon">🗑️</span>
              <span className="hk-trash-label">{t("tasks.trashDropHint")}</span>
            </div>
          )}
        </div>
      )}

      {/* detail */}
      <Modal
        open={mode === "view"}
        onClose={close}
        title={detail?.title || (detailLoading ? t("common.loading") : "")}
        subtitle={isNativeBoard ? undefined : detail?.id}
        footer={
          detail && (
            <>
              {caps.archive && (
                <button className="foot-left" onClick={doArchive}>{t("tasks.archive")}</button>
              )}
              {caps.hardDelete && (
                <button className={caps.archive ? "btn-danger" : "foot-left btn-danger"} onClick={doDelete}>
                  {t("common.delete")}
                </button>
              )}
              <button className="btn-primary" onClick={openEdit}>
                {t("common.edit")}
              </button>
            </>
          )
        }
      >
        {detailLoading && <p className="muted">{t("common.loading")}</p>}
        {detail && (
          <>
            <ModalSection title={t("tasks.overview")}>
              <DetailRow label={t("tasks.statusLabel")}>
                <Select
                  value={detail.column}
                  onChange={(v) => quickMove(detail.id, v)}
                >
                  {columnOptions.filter((c) => canMoveTo(c.id) || c.id === detail.column).map((c) => (
                    <Option key={c.id} value={c.id}>
                      {c.name}
                    </Option>
                  ))}
                  {!columnOptions.some((c) => c.id === detail.column) && (
                    <Option value={detail.column}>{detail.column}</Option>
                  )}
                </Select>
              </DetailRow>
              {detail.assignee && <DetailRow label={t("tasks.assigneeLabel")}>@{detail.assignee}</DetailRow>}
              {detail.priorityLevel ? (
                <DetailRow label={t("tasks.priorityLabel")}>{t(`tasks.priority.${detail.priorityLevel}`)}</DetailRow>
              ) : typeof detail.priority === "number" ? (
                <DetailRow label={t("tasks.priorityLabel")}>{detail.priority}</DetailRow>
              ) : null}
              {!isNativeBoard && detail.agentId && <DetailRow label={t("tasks.agentField")}>@{detail.agentId}</DetailRow>}
              {detail.labels && detail.labels.length > 0 && (
                <DetailRow label={t("tasks.labelsField")}>{detail.labels.join(", ")}</DetailRow>
              )}
              {isHermesBoard && (
                <>
                  {detail.tenant && <DetailRow label={t("tasks.tenantLabel")}>{detail.tenant}</DetailRow>}
                  {detail.skills && detail.skills.length > 0 && (
                    <DetailRow label={t("tasks.skillsLabel")}>{detail.skills.join(", ")}</DetailRow>
                  )}
                  {detail.goalMode && (
                    <DetailRow label={t("tasks.goalLabel")}>{detail.goalMaxTurns ? `≤ ${detail.goalMaxTurns}` : "✓"}</DetailRow>
                  )}
                  {detail.createdBy && <DetailRow label={t("tasks.createdByLabel")}>{detail.createdBy}</DetailRow>}
                  {(detail.workspaceKind || detail.workspacePath) && (
                    <DetailRow label={t("tasks.workspace")}>
                      {detail.workspaceKind}{detail.workspacePath ? `: ${detail.workspacePath}` : ""}
                    </DetailRow>
                  )}
                  {caps.modelOverride && detailCtx && <ModelEditor ctx={detailCtx} task={detail} />}
                  <DetailRow label={t("tasks.reassignBtn")}>
                    <span className="hk-reassign">
                      <Select value={reassignTo} onChange={setReassignTo}>
                        <Option value="">—</Option>
                        {(board?.assignees ?? []).map((p) => <Option key={p} value={p}>{p}</Option>)}
                      </Select>
                      <button className="btn-sm" disabled={!reassignTo} onClick={doReassign}>{t("tasks.reassignBtn")}</button>
                      <button className="btn-sm" onClick={doReclaim}>{t("tasks.reclaimBtn")}</button>
                    </span>
                  </DetailRow>
                </>
              )}
            </ModalSection>
            {/* 状态动作行：按当前状态启停（→running 不给按钮——PATCH 直接拒，
                任务只能经 dispatcher 的 claim 进 running）。破坏性转换先确认。 */}
            {caps.kind === "hermes" && (
              <ModalSection title={t("tasks.statusActions")}>
                <div className="settings-actions">
                  <button className="btn-sm" disabled={detail.column === "triage"} onClick={() => quickMove(detail.id, "triage")}>→ triage</button>
                  <button className="btn-sm" disabled={detail.column === "ready"} onClick={() => quickMove(detail.id, "ready")}>→ ready</button>
                  <button
                    className="btn-sm"
                    disabled={detail.column !== "running" && detail.column !== "ready"}
                    onClick={() => quickMove(detail.id, "blocked")}
                  >{t("tasks.blockBtn")}</button>
                  <button className="btn-sm" disabled={detail.column !== "blocked"} onClick={() => quickMove(detail.id, "ready")}>
                    {t("tasks.unblockBtn")}
                  </button>
                  <button
                    className="btn-sm"
                    disabled={!["running", "ready", "blocked"].includes(detail.column)}
                    onClick={() => quickMove(detail.id, "done")}
                  >{t("tasks.complete")}</button>
                  <button className="btn-sm" disabled={detail.column === "archived"} onClick={() => quickMove(detail.id, "archived")}>
                    {t("tasks.archive")}
                  </button>
                </div>
              </ModalSection>
            )}
            {detail.summary && (
              <ModalSection title={t("tasks.summary")}>
                <p className="muted">{detail.summary}</p>
              </ModalSection>
            )}
            <ModalSection title={t("tasks.bodyLabel")}>
              {detail.body ? (
                <div
                  className="md-body"
                  dangerouslySetInnerHTML={{ __html: toSanitizedMarkdownHtml(detail.body) }}
                />
              ) : (
                <p className="muted">{t("tasks.bodyEmpty")}</p>
              )}
            </ModalSection>
            {/* Specify / Decompose 只对 triage 列的卡有意义——别的列上游一律
                ok:false «not in triage»，官方索性只在 triage 显示（R360 对齐）。 */}
            {isHermesBoard && detail.column === "triage" && (
              <ModalSection title={t("tasks.orchestration")}>
                <div className="settings-actions">
                  <button onClick={() => runAction("specify")} disabled={actionBusy !== null}>
                    {actionBusy === "specify" ? t("tasks.specifying") : t("tasks.specifyBtn")}
                  </button>
                  <button onClick={() => runAction("decompose")} disabled={actionBusy !== null}>
                    {actionBusy === "decompose" ? t("tasks.decomposing") : t("tasks.decomposeBtn")}
                  </button>
                </div>
                <p className="field-hint">{t("tasks.orchestrationHint")}</p>
              </ModalSection>
            )}

            {/* 结果：result 缺席时退到最近一次 run 的 summary；done 却两者皆无时
                给出明确说明（父卡指向子任务结果区），别只留一片空白。 */}
            {isHermesBoard && (detail.result || detail.latestSummary) && (
              <ModalSection title={detail.result ? t("tasks.resultLabel") : t("tasks.finalResultLabel")}>
                <div
                  className="md-body"
                  dangerouslySetInnerHTML={{ __html: toSanitizedMarkdownHtml(detail.result || detail.latestSummary || "") }}
                />
              </ModalSection>
            )}
            {isHermesBoard && !detail.result && !detail.latestSummary && detail.column === "done" && (
              <ModalSection title={t("tasks.resultLabel")}>
                <p className="muted">
                  {(detail.linkIds?.children.length ?? 0) > 0 ? t("tasks.doneParentNote") : t("tasks.doneNoResult")}
                </p>
              </ModalSection>
            )}
            {/* 子任务结果：父卡自己常常没有产出，实质工作在子卡里。 */}
            {isHermesBoard && detail.childResults && detail.childResults.length > 0 && (
              <ModalSection title={`${t("tasks.childResults")} (${detail.childResults.length})`}>
                <div className="hk-child-list">
                  {detail.childResults.map((c) => (
                    <div key={c.id} className="hk-child">
                      <div className="hk-child-head">
                        <span className="hk-id">{c.id}</span>
                        <span className="hk-child-title">{c.title || t("tasks.untitled")}</span>
                        <span className="chip-meta">{c.status}</span>
                        <button className="btn-sm" onClick={() => openView(c.id)}>{t("tasks.diagnosticsOpenTask")}</button>
                      </div>
                      {c.result || c.latestSummary ? (
                        <div className="md-body" dangerouslySetInnerHTML={{ __html: toSanitizedMarkdownHtml(c.result || c.latestSummary || "") }} />
                      ) : (
                        <p className="muted">{t("tasks.noChildResult")}</p>
                      )}
                    </div>
                  ))}
                </div>
              </ModalSection>
            )}
            {caps.attachments && detailCtx && (
              <AttachmentsSection ctx={detailCtx} attachments={detail.attachments || []} />
            )}
            {caps.homeChannels && detailCtx && <HomeSubsSection ctx={detailCtx} />}
            {isHermesBoard && caps.links && (
              <ModalSection title={t("tasks.dependencies")}>
                {detail.linkIds && (detail.linkIds.parents.length > 0 || detail.linkIds.children.length > 0) ? (
                  <div className="hk-dep-list">
                    {detail.linkIds.parents.map((p) => (
                      <div key={`p${p}`} className="hk-dep-row">
                        <span className="muted">{t("tasks.depParent")}</span>
                        <button className="hk-dep-link" onClick={() => openView(p)}>{p}</button>
                        <button className="hk-dep-x" onClick={() => doRemoveLink(p, true)}>×</button>
                      </div>
                    ))}
                    {detail.linkIds.children.map((c) => (
                      <div key={`c${c}`} className="hk-dep-row">
                        <span className="muted">{t("tasks.depChild")}</span>
                        <button className="hk-dep-link" onClick={() => openView(c)}>{c}</button>
                        <button className="hk-dep-x" onClick={() => doRemoveLink(c, false)}>×</button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="muted">—</p>
                )}
                {/* 加依赖从全板任务里选（排除自己和已连的），别让用户手抄 t_ 开头的 id。 */}
                <div className="hk-dep-add">
                  <Select value={depDir} onChange={(v) => setDepDir(v as "parent" | "child")}>
                    <Option value="parent">{t("tasks.depParent")}</Option>
                    <Option value="child">{t("tasks.depChild")}</Option>
                  </Select>
                  <Select value={depInput} onChange={setDepInput}>
                    <Option value="">{t("tasks.depPlaceholder")}</Option>
                    {linkCandidates.map((c) => (
                      <Option key={c.id} value={c.id}>{`${c.id} — ${c.title.slice(0, 50)}`}</Option>
                    ))}
                  </Select>
                  <button className="btn-sm" disabled={!depInput.trim()} onClick={doAddLink}>{t("tasks.addDep")}</button>
                </div>
              </ModalSection>
            )}
            {isHermesBoard && (
              <ModalSection
                title={`${t("tasks.workerLog")}${workerLog?.sizeBytes ? ` (${workerLog.sizeBytes} B)` : ""}`}
              >
                {workerLog === null ? (
                  <button className="btn-sm" disabled={logLoading} onClick={loadLog}>{logLoading ? t("common.loading") : t("tasks.loadLog")}</button>
                ) : !workerLog.exists ? (
                  <p className="muted">{t("tasks.noWorkerLog")}</p>
                ) : (
                  <>
                    <pre className="hk-log">{workerLog.content || "—"}</pre>
                    {workerLog.truncated && (
                      <p className="field-hint">{t("tasks.logTruncated", { path: workerLog.path || "" })}</p>
                    )}
                  </>
                )}
                {workerLog !== null && (
                  <button className="btn-sm" disabled={logLoading} onClick={loadLog}>
                    {logLoading ? t("common.loading") : t("common.refresh")}
                  </button>
                )}
              </ModalSection>
            )}

            {/* Hermes 走官方那套完整恢复动作（含 cli_hint 复制 / open_docs /
                内联 profile 选择器）；OpenClaw 工作板保留原来的简单渲染。 */}
            {caps.kind === "hermes" && detailCtx ? (
              <DiagnosticCards
                ctx={detailCtx}
                task={detail}
                assignees={board?.assignees ?? []}
                onFocusComment={() => {
                  commentRef.current?.scrollIntoView({ behavior: "auto", block: "nearest" });
                  commentRef.current?.focus();
                }}
              />
            ) : detail.diagnostics && detail.diagnostics.length > 0 ? (
              <ModalSection title={t("tasks.diagnostics")}>
                <div className="run-list">
                  {detail.diagnostics.map((d, i) => (
                    <div key={i} className="diag-row">
                      <div className="diag-head">
                        <span className={`status status-${d.severity === "critical" || d.severity === "error" ? "error" : "skipped"}`}>{d.severity}</span>
                        <span className="muted">{d.kind}</span>
                        <span>{d.title || d.message}</span>
                      </div>
                      {d.detail && <div className="diag-detail muted">{d.detail}</div>}
                      {d.actions && d.actions.length > 0 && (
                        <div className="diag-actions">
                          {d.actions.map((a, j) => {
                            if (a.kind === "add_proof" || a.kind === "claim") return null; // agent-side
                            return (
                              <button key={j} className="btn-sm" onClick={() => runDiagAction(a.kind)}>{a.label}</button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </ModalSection>
            ) : null}

            {caps.sessionHandoff && (
              <ModalSection title={t("tasks.sessionHandoff")}>
                {(detail.sessionKey || detail.execution) && (
                  <>
                    <DetailRow label={t("tasks.linkedSession")}>
                      {detail.sessionKey
                        ? <span><code>{detail.sessionKey}</code> <button className="btn-sm" onClick={() => navigate(`/chat?backend=${encodeURIComponent(backend)}&session=${encodeURIComponent(detail.sessionKey as string)}`)}>{t("tasks.openSession")}</button></span>
                        : <span className="muted">{t("tasks.noLinkedSession")}</span>}
                    </DetailRow>
                    {detail.execution && (
                      <>
                        <DetailRow label={t("tasks.execStatus")}>{detail.execution.status}{detail.execution.model ? ` · ${detail.execution.model}` : ""}</DetailRow>
                        {detail.execution.status === "running" && (
                          <button className="btn-sm btn-danger" onClick={doStopSession}>{t("tasks.stopSession")}</button>
                        )}
                      </>
                    )}
                  </>
                )}
                <div className="settings-actions wb-run-actions">
                  <button className="btn-sm" disabled={runBusy !== null} onClick={() => doRun(undefined, "autonomous")}>{t("tasks.runDefaultAgent")}</button>
                  <button className="btn-sm" disabled={runBusy !== null} onClick={() => doRun("codex", "autonomous")}>{t("tasks.runCodex")}</button>
                  <button className="btn-sm" disabled={runBusy !== null} onClick={() => doRun("claude", "autonomous")}>{t("tasks.runClaude")}</button>
                  <button className="btn-sm" disabled={runBusy !== null} onClick={() => doRun("codex", "manual")}>{t("tasks.openCodex")}</button>
                  <button className="btn-sm" disabled={runBusy !== null} onClick={() => doRun("claude", "manual")}>{t("tasks.openClaude")}</button>
                </div>
              </ModalSection>
            )}

            {(caps.run || caps.retry) && !caps.sessionHandoff && (
              <ModalSection title={t("tasks.nativeRunActions")}>
                <div className="settings-actions wb-run-actions">
                  {caps.run && (
                    <button className="btn-sm" disabled={runBusy !== null} onClick={() => void doNativeRun("run")}>
                      {t("tasks.runDefaultAgent")}
                    </button>
                  )}
                  {caps.retry && (
                    <button className="btn-sm" disabled={runBusy !== null || !nativeRetryCommand} onClick={() => void doNativeRun("retry")}>
                      {t("tasks.retryLatestRun")}
                    </button>
                  )}
                </div>
              </ModalSection>
            )}

            {!isNativeBoard && detail.proof && detail.proof.length > 0 && (
              <ModalSection title={t("tasks.proof")}>
                <div className="run-list">
                  {detail.proof.map((p) => (
                    <div key={p.id} className="run-row">
                      <span className={`status status-${p.status === "passed" ? "ok" : p.status === "failed" ? "error" : "skipped"}`}>{p.status}</span>
                      <span>{p.label || p.command || p.url || p.note || p.id}</span>
                    </div>
                  ))}
                </div>
              </ModalSection>
            )}
            {detail.artifacts && detail.artifacts.length > 0 && (
              <ModalSection title={t("tasks.artifacts")}>
                <div className="run-list">
                  {detail.artifacts.map((a) => (
                    <div key={a.id} className="run-row">
                      <span>{isNativeBoard ? (a.label || t("tasks.untitled")) : (a.label || a.path || a.url || a.id)}</span>
                      {!isNativeBoard && a.url && <a href={a.url} target="_blank" rel="noreferrer">↗</a>}
                    </div>
                  ))}
                </div>
              </ModalSection>
            )}
            {/* 事件流：最近 20 条（官方同款）。幻觉类诊断事件单独高亮并把
                phantom id 列成芯片——那是「worker 引用了不存在的卡」的现场证据。 */}
            {!isNativeBoard && detail.events && detail.events.length > 0 && (
              <ModalSection title={`${t("tasks.events")} (${detail.events.length})`}>
                <div className="run-list">
                  {detail.events.slice().reverse().slice(0, 20).map((ev, i) => {
                    const diag = HK_DIAG_EVENT_KINDS.includes(ev.kind);
                    const phantoms = diag ? hkPhantomIds(ev.payload) : [];
                    return (
                      <div key={ev.id || i} className={`run-row${diag ? " hk-event-diag" : ""}`}>
                        <span className={diag ? "hk-warn hk-warn--warning" : "muted"}>{diag ? "⚠" : ""}{ev.kind}</span>
                        {ev.toStatus && <span>→ {t(`tasks.columns.${ev.toStatus}`, { defaultValue: ev.toStatus })}</span>}
                        <span className="mono">{new Date(ev.at).toLocaleString()}</span>
                        {phantoms.length > 0 && (
                          <span className="hk-phantoms">
                            {t("tasks.phantomIds")}
                            {phantoms.map((pid) => <code key={pid} className="hk-id-chip">{pid}</code>)}
                          </span>
                        )}
                        {!diag && ev.payload && Object.keys(ev.payload).length > 0 && (
                          <code className="hk-event-payload">{JSON.stringify(ev.payload)}</code>
                        )}
                      </div>
                    );
                  })}
                </div>
              </ModalSection>
            )}

            {runsEnabled && detail.runs && detail.runs.length > 0 && (
              <ModalSection title={t("tasks.runHistory", { count: detail.runs.length })}>
                <div className="run-list">
                  {detail.runs.map((r, i) => (
                    <div key={r.id || i} className="run-row">
                      <span className={`status status-${r.status === "completed" ? "ok" : r.status && r.status !== "running" ? "error" : "skipped"}`}>
                        {r.finishedAt ? (r.outcome || r.status || t("tasks.runEnded")) : t("tasks.runActive")}
                      </span>
                      {r.profile && <span className="muted">@{r.profile}</span>}
                      <span className="mono">{hkElapsed(r.startedAt, r.finishedAt)}</span>
                      {r.startedAt && <span className="mono">{new Date(r.startedAt).toLocaleString()}</span>}
                      {r.error && <span className="status-error">{r.error}</span>}
                      {r.summary && !r.error && <span className="muted">{r.summary}</span>}
                      {caps.kind === "hermes" && r.metadata && Object.keys(r.metadata).length > 0 && (
                        <details className="hk-run-meta">
                          <summary>{t("tasks.runMetadata")}</summary>
                          <code>{JSON.stringify(r.metadata, null, 2)}</code>
                        </details>
                      )}
                    </div>
                  ))}
                </div>
              </ModalSection>
            )}

            {commentsEnabled && <ModalSection title={`${t("tasks.comments")}${detail.comments && detail.comments.length ? ` (${detail.comments.length})` : ""}`}>
              {detail.comments && detail.comments.length > 0 ? (
                <div className="comment-list">
                  {detail.comments.map((c, i) => (
                    <div key={i} className="comment">
                      <div className="comment-author">@{c.author || "?"}</div>
                      <div className="comment-body">{c.body}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">{t("tasks.noComments")}</p>
              )}
              {isHermesBoard && <p className="field-hint">{t("tasks.commentHint")}</p>}
              {commentsEnabled && (
                <div className="comment-composer">
                  <TextArea
                    ref={commentRef}
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    rows={2}
                    placeholder={t("tasks.commentPlaceholder")}
                    onKeyDown={(e) => {
                      // Enter 直发、Shift+Enter 换行（官方评论框同款）。
                      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void postComment(); }
                    }}
                  />
                  <div className="file-actions">
                    <button
                      className="btn-primary"
                      onClick={postComment}
                      disabled={posting || !commentText.trim()}
                    >
                      {posting ? t("tasks.sending") : t("tasks.send")}
                    </button>
                  </div>
                </div>
              )}
            </ModalSection>}
          </>
        )}
      </Modal>

      {/* 板级诊断（GAP-002）：capability 驱动，点行深入任务详情 */}
      <Modal open={diagOpen} onClose={() => setDiagOpen(false)} title={t("tasks.diagnosticsTitle")}>
        {diagRows === null && <p className="muted">{t("common.loading")}</p>}
        {diagRows !== null && diagRows.length === 0 && <p className="muted">{t("tasks.diagnosticsEmpty")}</p>}
        {(diagRows ?? []).map((row) => (
          <ModalSection key={row.taskId} title={`${row.taskTitle}${row.taskStatus ? ` · ${row.taskStatus}` : ""}${row.taskAssignee ? ` @${row.taskAssignee}` : ""}`}>
            {row.diagnostics.map((d, i) => (
              <p key={i} className={`hk-warn hk-warn--${d.severity}`}>
                {hkWarnGlyph(d.severity)} {d.message}
              </p>
            ))}
            <button onClick={() => { setDiagOpen(false); openView(row.taskId); }}>{t("tasks.diagnosticsOpenTask")}</button>
          </ModalSection>
        ))}
      </Modal>

      {/* edit / create */}
      <Modal
        open={mode === "edit" || mode === "create"}
        onClose={close}
        title={mode === "create" ? t("tasks.newTaskTitle") : t("tasks.editTitle", { title: detail?.title ?? "" })}
        footer={
          <>
            <button className="btn-secondary" onClick={close} disabled={saving}>
              {t("common.cancel")}
            </button>
            <button
              className="btn-primary"
              onClick={mode === "create" ? saveCreate : saveEdit}
              disabled={saving}
            >
              {saving ? t("common.saving") : t("common.save")}
            </button>
          </>
        }
      >
        <Field label={t("tasks.titleField")}>
          <TextInput value={draft.title} onChange={(e) => setDraftField("title", e.target.value)} />
        </Field>
        <Field label={t("tasks.columnField")}>
          <Select value={draft.column} onChange={(v) => setDraftField("column", v)}>
            {columnOptions.filter((c) => isNativeBoard && mode === "create"
              ? c.id === "backlog"
              : canMoveTo(c.id) || c.id === draft.column).map((c) => (
              <Option key={c.id} value={c.id}>
                {c.name}
              </Option>
            ))}
          </Select>
        </Field>
        {caps.templates && caps.templates.length > 0 && (
          <Field label={t("tasks.templateField")}>
            <Select value={draft.templateId} onChange={(v) => setDraftField("templateId", v)}>
              <Option value="">{t("tasks.templateNone")}</Option>
              {caps.templates.map((tpl) => (
                <Option key={tpl} value={tpl}>{t(`tasks.template.${tpl}`)}</Option>
              ))}
            </Select>
          </Field>
        )}
        {caps.priorities && caps.priorities.length > 0 && (
          <Field label={t("tasks.priorityField")}>
            <Select value={draft.priorityLevel} onChange={(v) => setDraftField("priorityLevel", v)}>
              {caps.priorities.map((p) => (
                <Option key={p} value={p}>{t(`tasks.priority.${p}`)}</Option>
              ))}
            </Select>
          </Field>
        )}
        {caps.sessionHandoff && (
          <div className="field-row">
            <Field label={t("tasks.agentField")}>
              <TextInput value={draft.agentId} onChange={(e) => setDraftField("agentId", e.target.value)} placeholder={t("tasks.agentPlaceholder")} />
            </Field>
            <Field label={t("tasks.sessionField")}>
              <TextInput value={draft.sessionKey} onChange={(e) => setDraftField("sessionKey", e.target.value)} placeholder={t("tasks.sessionPlaceholder")} />
            </Field>
          </div>
        )}
        {caps.labels && (
          <Field label={t("tasks.labelsField")} hint={t("tasks.labelsHint")}>
            <TextInput value={draft.labels} onChange={(e) => setDraftField("labels", e.target.value)} />
          </Field>
        )}
        {isHermesBoard && (
          <div className="field-row">
            <Field label={t("tasks.assigneeField")}>
              <TextInput
                value={draft.assignee}
                onChange={(e) => setDraftField("assignee", e.target.value)}
                placeholder={t("tasks.assigneePlaceholder")}
              />
            </Field>
            <Field label={t("tasks.priorityField")}>
              <TextInput
                type="number"
                value={draft.priority}
                onChange={(e) => setDraftField("priority", Number(e.target.value) || 0)}
              />
            </Field>
          </div>
        )}
        {isHermesBoard && (
          <>
            <div className="field-row">
              <Field label={t("tasks.tenantLabel")} hint={mode === "edit" ? t("tasks.hermesCreateOnlyHint") : undefined}>
                <TextInput value={draft.tenant} disabled={mode === "edit"} onChange={(e) => setDraftField("tenant", e.target.value)} />
              </Field>
              <Field label={t("tasks.skillsField")} hint={mode === "edit" ? t("tasks.hermesCreateOnlyHint") : undefined}>
                <TextInput value={draft.skills} disabled={mode === "edit"} onChange={(e) => setDraftField("skills", e.target.value)} />
              </Field>
            </div>
            {/* 工作区：scratch 的产物在任务完成时会被删掉——这条必须显式告知。 */}
            {mode === "create" && caps.workspaceKinds && caps.workspaceKinds.length > 0 && (
              <>
                <div className="field-row">
                  <Field label={t("tasks.workspace")}>
                    <Select value={draft.workspaceKind} onChange={(v) => setDraftField("workspaceKind", v)}>
                      {caps.workspaceKinds.map((k) => (
                        <Option key={k} value={k}>{t(`tasks.workspaceKind.${k}`, { defaultValue: k })}</Option>
                      ))}
                    </Select>
                  </Field>
                  {draft.workspaceKind !== "scratch" && (
                    <Field label={t("tasks.workspacePath")}>
                      <TextInput
                        value={draft.workspacePath}
                        spellCheck={false}
                        autoCapitalize="none"
                        autoCorrect="off"
                        onChange={(e) => setDraftField("workspacePath", e.target.value)}
                      />
                    </Field>
                  )}
                </div>
                {draft.workspaceKind === "scratch" && (
                  <p className="field-hint status-error">{t("tasks.workspaceScratchWarning")}</p>
                )}
                <Field label={t("tasks.parentField")} hint={t("tasks.parentFieldHint")}>
                  <Select value={draft.parent} onChange={(v) => setDraftField("parent", v)}>
                    <Option value="">{t("tasks.noParent")}</Option>
                    {columns.flatMap((c) => c.tasks).map((tk) => (
                      <Option key={tk.id} value={tk.id}>{`${tk.id} — ${tk.title.slice(0, 50)}`}</Option>
                    ))}
                  </Select>
                </Field>
              </>
            )}
            <div className="field-row">
              <label className="hk-check">
                <input type="checkbox" checked={draft.goalMode} disabled={mode === "edit"} onChange={(e) => setDraftField("goalMode", e.target.checked)} />
                {t("tasks.goalModeField")}
              </label>
              {draft.goalMode && (
                <Field label={t("tasks.goalTurnsField")}>
                  <TextInput type="number" value={draft.goalMaxTurns} disabled={mode === "edit"} onChange={(e) => setDraftField("goalMaxTurns", Number(e.target.value) || 0)} />
                </Field>
              )}
            </div>
          </>
        )}
        <Field label={t("tasks.bodyField")} hint={t("tasks.bodyHint")}>
          <TextArea
            value={draft.body}
            onChange={(e) => setDraftField("body", e.target.value)}
            rows={12}
          />
        </Field>
      </Modal>

      {/* New board dialog (Slice 4) */}
      <Modal
        open={boardDialog}
        onClose={() => setBoardDialog(false)}
        title={t("tasks.newBoard")}
        footer={
          <button className="btn-primary" onClick={submitBoard} disabled={boardSaving}>
            {boardSaving ? t("common.loading") : t("common.save")}
          </button>
        }
      >
        <Field label={t("tasks.boardSlugField")}>
          <TextInput
            value={boardDraft.slug}
            onChange={(e) => setBoardDraft({ ...boardDraft, slug: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "-") })}
            placeholder="atm10-server"
          />
        </Field>
        <Field label={t("tasks.boardNameField")}>
          <TextInput value={boardDraft.name} onChange={(e) => setBoardDraft({ ...boardDraft, name: e.target.value })} />
        </Field>
        <Field label={t("tasks.boardDescField")}>
          <TextInput value={boardDraft.description} onChange={(e) => setBoardDraft({ ...boardDraft, description: e.target.value })} />
        </Field>
        <Field label={t("tasks.projectDirectory")} hint={t("tasks.projectDirectoryExplanation")}>
          <TextInput
            value={boardDraft.defaultWorkdir}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            placeholder={t("tasks.projectDirectoryPlaceholder")}
            onChange={(e) => setBoardDraft({ ...boardDraft, defaultWorkdir: e.target.value })}
          />
        </Field>
        <Field label={t("tasks.boardIconField")}>
          <TextInput value={boardDraft.icon} onChange={(e) => setBoardDraft({ ...boardDraft, icon: e.target.value.slice(0, 4) })} placeholder="📦" />
        </Field>
        <label className="hk-check" style={{ marginTop: "0.6rem" }}>
          <input type="checkbox" checked={boardDraft.switchAfter} onChange={(e) => setBoardDraft({ ...boardDraft, switchAfter: e.target.checked })} />
          {t("tasks.boardSwitchField")}
        </label>
      </Modal>

      {/* 板设置：显示名 / 描述 / 项目目录（新任务的工作区默认值继承它） */}
      <BoardSettingsDialog
        open={boardSettingsOpen}
        backend={backend}
        board={currentBoard}
        onClose={() => setBoardSettingsOpen(false)}
        onSaved={loadBoards}
      />
      </>
      )}
    </div>
  );
}

// Official Hermes board column labels + subtitles + dot colors (English, 1:1 with the
// dashboard). Hermes board renders these verbatim — NOT the shared i18n column labels —
// to match the official kanban exactly (OpenClaw board keeps its i18n labels).
const HERMES_COLUMN_META: Record<string, { label: string; subtitle: string; dot: string }> = {
  triage:    { label: "Triage", subtitle: "Raw ideas — a specifier will flesh out the spec", dot: "#b47dd6" },
  todo:      { label: "Todo", subtitle: "Waiting on dependencies or unassigned", dot: "var(--muted, #888)" },
  scheduled: { label: "Scheduled", subtitle: "Waiting on a known time delay or scheduled follow-up", dot: "#6c8cd5" },
  ready:     { label: "Ready", subtitle: "Dependencies satisfied; assign a profile to dispatch", dot: "#d4b348" },
  running:   { label: "In Progress", subtitle: "Claimed by a worker — in-flight", dot: "#3fb97d" },
  blocked:   { label: "Blocked", subtitle: "Worker asked for human input", dot: "#d14a4a" },
  review:    { label: "Review", subtitle: "Awaiting review", dot: "#9aa0a6" },
  done:      { label: "Done", subtitle: "Completed", dot: "#4a8cd1" },
  archived:  { label: "Archived", subtitle: "Archived", dot: "var(--border, #ccc)" },
};
// 幻觉类诊断事件（kanban_db.complete_task 发出）：worker 引用了不存在的卡 id。
// 官方在事件流里单独高亮它们并列出 phantom id。
const HK_DIAG_EVENT_KINDS = ["completion_blocked_hallucination", "suspected_hallucinated_references"];
function hkPhantomIds(payload?: Record<string, unknown>): string[] {
  const raw = payload?.phantom_cards ?? payload?.phantom_refs;
  return Array.isArray(raw) ? raw.map(String) : [];
}
// run 用时：未结束的按「到现在」算（官方 fmtElapsed）。
function hkElapsed(startedAt?: number | null, finishedAt?: number | null): string {
  if (!startedAt) return "";
  const secs = Math.max(0, Math.round(((finishedAt || Date.now()) - startedAt) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  return `${(secs / 3600).toFixed(1)}h`;
}
const HK_SEV_RANK: Record<string, number> = { critical: 3, error: 2, warning: 1 };
function hkWarnGlyph(sev: string): string {
  return sev === "critical" ? "!!!" : sev === "error" ? "!!" : "⚠";
}
// Hermes 卡片年龄统一走 i18n，避免任一语言下混入固定文案。
function hkTimeAgo(sec: number, t: TFunction): string {
  if (sec < 60) return t("tasks.ageSeconds", { count: Math.max(0, Math.floor(sec)) });
  const m = Math.floor(sec / 60); if (m < 60) return t("tasks.ageMinutes", { count: m });
  const h = Math.floor(m / 60); if (h < 24) return t("tasks.ageHours", { count: h });
  const d = Math.floor(h / 24); if (d < 30) return t("tasks.ageDays", { count: d });
  const mo = Math.floor(d / 30); if (mo < 12) return t("tasks.ageMonths", { count: mo });
  return t("tasks.ageYears", { count: Math.floor(mo / 12) });
}
const HK_STALE: Record<string, { amber: number; red: number }> = {
  ready: { amber: 3600, red: 86400 }, blocked: { amber: 3600, red: 86400 },
  running: { amber: 600, red: 3600 }, todo: { amber: 604800, red: 2592000 },
};
function hkStaleClass(tk: UnifiedTask): string {
  const tier = HK_STALE[tk.column]; if (!tier) return "";
  const age = tk.column === "running"
    ? (tk.age?.startedAgeSeconds ?? tk.age?.createdAgeSeconds)
    : tk.age?.createdAgeSeconds;
  if (typeof age !== "number") return "";
  if (age >= tier.red) return " hk-stale-red";
  if (age >= tier.amber) return " hk-stale-amber";
  return "";
}
function HermesCardBody({ tk }: { tk: UnifiedTask }) {
  const { t } = useTranslation();
  const links = tk.linkCount ? tk.linkCount.parents + tk.linkCount.children : 0;
  const needsAssignee = tk.column === "ready" && !tk.assignee;
  const ageSec = tk.age?.createdAgeSeconds;
  return (
    <>
      <div className="hk-row1">
        <span className="hk-id" title={t("tasks.taskIdTip", { id: tk.id })}>{tk.id}</span>
        {tk.warnings && (
          <span className={`hk-warn hk-warn--${tk.warnings.highestSeverity}`} title={t("tasks.attentionItems", { count: tk.warnings.count })}>
            {hkWarnGlyph(tk.warnings.highestSeverity)}
          </span>
        )}
        {typeof tk.priority === "number" && tk.priority > 0 && (
          <span className="hk-prio" title={t("tasks.priorityTitle", { priority: tk.priority })}>P{tk.priority}</span>
        )}
        {tk.tenant && <span className="hk-tenant">{tk.tenant}</span>}
        {tk.progress && tk.progress.total > 0 && (
          <span className={`hk-prog${tk.progress.done >= tk.progress.total ? " is-done" : ""}`}
            title={t("tasks.subtasksDone", { done: tk.progress.done, total: tk.progress.total })}>
            {tk.progress.done}/{tk.progress.total}
          </span>
        )}
        {needsAssignee && <span className="hk-need">{t("tasks.needsAssignee")}</span>}
      </div>
      <div className="kanban-card-title">{tk.title || t("tasks.untitled")}</div>
      <div className="kanban-card-meta hk-meta">
        <span className={`kanban-assignee${needsAssignee ? " hk-unassigned" : ""}`}>
          <CardAvatar id={tk.assignee} />
          {tk.assignee ? `@${tk.assignee}` : t("tasks.unassigned")}
        </span>
        {tk.commentCount ? <span className="hk-chip" title={t("tasks.commentsCount", { count: tk.commentCount })}>💬{tk.commentCount}</span> : null}
        {links ? (
          <span className="hk-chip" title={t("tasks.parentChildCount", { parents: tk.linkCount!.parents, children: tk.linkCount!.children })}>↔{links}</span>
        ) : null}
        {typeof ageSec === "number" && (
          <span className="hk-age" title={tk.createdAt ? new Date(tk.createdAt).toLocaleString() : ""}>{hkTimeAgo(ageSec, t)}</span>
        )}
      </div>
    </>
  );
}
// 卡片右下角日期 MM/DD（Figma 6379-530）：只用已有字段 updatedAt/createdAt，无则不渲染。
function cardDate(tk: UnifiedTask): string | null {
  const ms = tk.updatedAt || tk.createdAt;
  if (!ms) return null;
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}
// 过滤条胶囊的内联小图标（设计稿：Agent 人形 / Priority 滑杆 / 搜索放大镜），随文字色。
function AgentGlyph() {
  return (
    <svg className="kb-picon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="5" r="2.6" />
      <path d="M2.8 13.4c.9-2.3 2.9-3.5 5.2-3.5s4.3 1.2 5.2 3.5" />
    </svg>
  );
}
function PriorityGlyph() {
  return (
    <svg className="kb-picon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
      <path d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3" />
    </svg>
  );
}
function CardAvatar({ id }: { id?: string }) {
  return <AgentAvatarView agentId={id} className="kanban-avatar" loading="lazy" />;
}
function TaskBadges({ b }: { b?: import("../types").TaskCardBadges }) {
  if (!b) return null;
  const items: string[] = [];
  if (b.comments) items.push(`💬${b.comments}`);
  if (b.proof) items.push(`✓${b.proof}`);
  if (b.artifacts) items.push(`📎${b.artifacts}`);
  if (b.diagnostics) items.push(`⚠${b.diagnostics}`);
  if (b.failures) items.push(`✗${b.failures}`);
  if (b.claimed) items.push("🔒");
  if (b.stale) items.push("⏳");
  return items.length ? <span className="wb-badges">{items.join(" ")}</span> : null;
}
