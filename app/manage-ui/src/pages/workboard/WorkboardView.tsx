// OpenClaw 工作板视图 —— 复刻官方 control-ui workboard 页（openclaw 2026.8.1）：
// 工具条（搜索/视图预设/优先级/agent 筛选/归档开关/密度/隐藏空列）、健康条、
// ⚡调度、自动刷新、九列看板 + 拖拽、官方卡片布局（快捷操作/生命周期/依赖/徽标/
// 事件/状态下拉）、居中新建-编辑模态（模板条）、右侧详情抽屉（操作员备注 +
// Run/Open 引擎控件）。数据取自 TasksPage 传入的 board（服务端只投影生命周期，不回写卡片）。
// 官方函数名标注同 model.ts。

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import SearchCapsule from "../../components/SearchCapsule";
import type {
  TaskBoard,
  TaskInput,
  WbAgents,
  WbSession,
  WorkboardCard,
  WorkboardPriority,
} from "../../types";
import {
  addTaskComment,
  archiveTask,
  createTask,
  deleteTask,
  moveTask,
  nudgeDispatcher,
  runTask,
  taskAction,
  updateTask,
} from "../../api/client";
import Modal from "../../components/Modal";
import { Field, Option, Select, TextArea, TextInput } from "../../components/Field";
import {
  WB_AUTO_REFRESH,
  WB_TEMPLATES,
  WB_VIEW_PRESETS,
  type WbHealthKind,
  type WbItem,
  type WbLayout,
  type WbViewPreset,
  agentChipLabel,
  agentDraftOptions,
  agentFilterOptions,
  cardBadges,
  cardRunId,
  cardSessionKey,
  dependenciesOf,
  engineDisabledReason,
  eventLabel,
  fmtDateTime,
  fmtTime,
  healthCounts,
  isLive,
  lifecycleOf,
  lifecycleTone,
  matchesAgentFilter,
  matchesFilters,
  matchesHealth,
  matchesPreset,
  nextPosition,
  parseLabels,
  priorityLabel,
  sanitizeAgentFilter,
  sessionDisplay,
  sessionOptionOk,
  showStartControls,
  statusLabel,
  taskActive,
  taskConsistent,
  taskDateTime,
  taskStatusKey,
  taskSummary,
  toWbItems,
} from "./model";
import {
  IcAlert,
  IcArchive,
  IcArchiveRestore,
  IcClock,
  IcCornerDownRight,
  IcEdit,
  IcEye,
  IcEyeOff,
  IcLayoutComfortable,
  IcLayoutCompact,
  IcMessage,
  IcPanelRight,
  IcPen,
  IcPlay,
  IcPlus,
  IcStop,
  IcTrash,
  IcZap,
} from "./icons";
import "./workboard.css";

const WB_PRIORITIES: WorkboardPriority[] = ["low", "normal", "high", "urgent"];
type WbEngine = "codex" | "claude";

interface WbDraft {
  open: boolean;
  editingId: string | null;
  title: string;
  notes: string;
  status: string;
  priority: WorkboardPriority;
  labels: string;
  agentId: string;
  sessionKey: string;
  templateId: string;
  comment: string;
}
const EMPTY_DRAFT: WbDraft = {
  open: false, editingId: null, title: "", notes: "", status: "todo",
  priority: "normal", labels: "", agentId: "", sessionKey: "", templateId: "", comment: "",
};

interface WbDispatchCounts {
  started: number; failures: number; promoted: number; blocked: number; reclaimed: number; orchestrated: number;
}

export default function WorkboardView({
  backend,
  board,
  loading,
  error,
  refresh,
  leading,
  deepLinkTask,
  detailOnly = false,
  onDetailClose,
  onOpenSession,
}: {
  backend: string;
  board: TaskBoard | null;
  loading: boolean;
  error: string | null;
  refresh: (opts?: { diagnostics?: boolean }) => Promise<void>;
  /** 页面级控件（后端切换），排进工具条主行的最左侧。 */
  leading?: ReactNode;
  deepLinkTask?: string;
  detailOnly?: boolean;
  onDetailClose?: () => void;
  onOpenSession: (sessionKey: string) => void;
}) {
  const { t } = useTranslation();

  // ---- 官方 Af 状态 ----
  const [query, setQuery] = useState("");
  const [preset, setPreset] = useState<WbViewPreset>("all");
  const [priorityFilter, setPriorityFilter] = useState<WorkboardPriority | "all">("all");
  const [agentFilter, setAgentFilter] = useState("all");
  const [showArchived, setShowArchived] = useState(detailOnly);
  const [hideEmpty, setHideEmpty] = useState(false);
  const [layout, setLayout] = useState<WbLayout>("compact");
  const [autoMs, setAutoMs] = useState(0);
  const [highlight, setHighlight] = useState<WbHealthKind | null>(null);
  const [draft, setDraft] = useState<WbDraft>(EMPTY_DRAFT);
  const [draftSaving, setDraftSaving] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailNote, setDetailNote] = useState("");
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [dispatchSummary, setDispatchSummary] = useState<WbDispatchCounts | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);

  // ---- 数据派生 ----
  const items = useMemo(() => toWbItems(board?.columns ?? []), [board]);
  const statuses = useMemo(() => {
    if (board?.statuses?.length) return board.statuses;
    return (board?.columns ?? []).map((c) => c.id);
  }, [board]);
  const sessions: WbSession[] = board?.sessions ?? [];
  const agents: WbAgents | undefined = board?.agents;

  // 刷新完成时间戳（官方 lastRefreshed）：loading 落回 false 即视为一轮取数结束。
  const wasLoading = useRef(loading);
  useEffect(() => {
    if (wasLoading.current && !loading && board) setLastRefreshAt(Date.now());
    wasLoading.current = loading;
  }, [loading, board]);

  // 用户交互中不打自动刷新（官方 Dp guard）。
  const interactingRef = useRef(false);
  interactingRef.current =
    draft.open || !!dragId || dispatching || busy.size > 0 ||
    detailNote.trim() !== "" || draft.comment.trim() !== "";
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!autoMs) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "hidden" || interactingRef.current) return;
      void refreshRef.current();
    }, autoMs);
    return () => window.clearInterval(id);
  }, [autoMs]);

  // 深链 #/tasks?task= → 打开详情抽屉（TasksPage 消费 URL，这里只接 id）。
  const deepConsumed = useRef(false);
  useEffect(() => {
    if (deepConsumed.current || !deepLinkTask || !board) return;
    deepConsumed.current = true;
    if (items.some((i) => i.card.id === deepLinkTask)) setDetailId(deepLinkTask);
  }, [board, deepLinkTask, items]);

  // ---- 过滤管线（官方 Gt 的 a/o） ----
  const agentOptions = useMemo(() => agentFilterOptions(agents, items, t), [agents, items, t]);
  const agentFilterSafe = sanitizeAgentFilter(agentOptions, agentFilter);   // 官方 Ke
  const baseFilter = (list: WbItem[]) =>
    list
      .filter(({ card }) => showArchived || !card.archived)
      .filter(({ card }) => matchesAgentFilter(card, agentFilterSafe))
      .filter(({ card }) => matchesFilters(card, { query, priority: priorityFilter }));
  const presetFiltered = (p: WbViewPreset) =>
    baseFilter(items.filter(({ card }) => matchesPreset(card, p, agents?.defaultId)));
  const visible = useMemo(
    () => presetFiltered(preset),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, preset, showArchived, agentFilterSafe, query, priorityFilter, agents],
  );
  const health = useMemo(() => healthCounts(visible), [visible]);
  const buckets = useMemo(() => {
    const map = new Map<string, WbItem[]>(statuses.map((s) => [s, []]));
    for (const it of visible) {
      if (!map.has(it.card.status)) map.set(it.card.status, []);
      map.get(it.card.status)!.push(it);
    }
    return map;
  }, [visible, statuses]);
  const visibleStatuses =
    hideEmpty || preset !== "all" ? statuses.filter((s) => (buckets.get(s)?.length ?? 0) > 0) : statuses;
  const archivedHiddenExists = !showArchived && items.some(({ card }) => card.archived);
  const filtersActive =
    preset !== "all" || query.trim() !== "" || priorityFilter !== "all" || agentFilterSafe !== "all" || archivedHiddenExists;
  const emptyFiltered = visible.length === 0 && filtersActive;

  const detailItem = detailId && !draft.open ? items.find((i) => i.card.id === detailId) ?? null : null;
  const detailVisible = detailItem && (!detailItem.card.archived || showArchived) ? detailItem : null;

  // ---- 动作 ----
  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const withCard = async (cardId: string, fn: () => Promise<unknown>, opts?: { skipRefresh?: boolean }) => {
    if (busy.has(cardId) || dispatching) return;
    setBusy((prev) => new Set(prev).add(cardId));
    setActionError(null);
    try {
      await fn();
      if (!opts?.skipRefresh) await refresh();
    } catch (e) {
      setActionError(errMsg(e));
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(cardId);
        return next;
      });
    }
  };
  const doMove = (cardId: string, status: string) =>                        // 官方 _m
    withCard(cardId, () => moveTask(backend, cardId, status, nextPosition(items, status)));
  const doDelete = (cardId: string) =>                                      // 官方 vm（官方无确认弹窗）
    withCard(cardId, async () => {
      await deleteTask(backend, cardId);
      if (detailId === cardId) {
        setDetailId(null);
        onDetailClose?.();
      }
    });
  const doArchive = (card: WorkboardCard) =>                                // 官方 ym
    withCard(card.id, () => archiveTask(backend, card.id, !card.archived));
  const doAddNote = (cardId: string, body: string, clear: () => void) =>    // 官方 gm
    withCard(cardId, async () => {
      await addTaskComment(backend, cardId, body.trim());
      clear();
    });
  const doStop = (card: WorkboardCard) =>                                   // 官方 Nm
    withCard(card.id, () => taskAction(backend, card.id, "stop"));
  const doStart = (card: WorkboardCard, engine: WbEngine | null, mode: "autonomous" | "manual") => // 官方 Mm+Z
    withCard(card.id, async () => {
      const r = await runTask(backend, card.id, engine ?? undefined, mode);
      if (r.sessionKey) onOpenSession(r.sessionKey);
    }, { skipRefresh: true }).then(() => refresh());
  const doDispatch = async () => {                                          // 官方 bm
    if (dispatching) return;
    setDispatching(true);
    setActionError(null);
    setDispatchSummary(null);
    try {
      const r = await nudgeDispatcher(backend);
      setDispatchSummary({
        started: r.started ?? 0, failures: r.failures ?? 0, promoted: r.promoted ?? 0,
        blocked: r.blocked ?? 0, reclaimed: r.reclaimed ?? 0, orchestrated: r.orchestrated ?? 0,
      });
      await refresh();
    } catch (e) {
      setActionError(errMsg(e));
    } finally {
      setDispatching(false);
    }
  };

  // ---- 新建/编辑（官方 vt/yt/bt/Lp/hm） ----
  const openCreate = () => setDraft({ ...EMPTY_DRAFT, open: true });
  const openEdit = (card: WorkboardCard) =>
    setDraft({
      open: true, editingId: card.id, title: card.title, notes: card.notes ?? "",
      status: card.status, priority: card.priority, labels: card.labels.join(", "),
      agentId: card.agentId ?? "", sessionKey: card.sessionKey ?? "",
      templateId: card.metadata?.templateId ?? "", comment: "",
    });
  const closeDraft = () => setDraft(EMPTY_DRAFT);
  const applyTemplate = (id: string) => {                                   // 官方 bt
    const tpl = WB_TEMPLATES.find((x) => x.id === id);
    if (!tpl) return;
    setDraft((d) => ({ ...d, templateId: tpl.id, title: tpl.title, notes: tpl.notes, labels: tpl.labels, priority: tpl.priority }));
  };
  const submitDraft = async () => {
    if (!draft.title.trim() || draftSaving || dispatching) return;
    if (draft.editingId && busy.has(draft.editingId)) return;
    setDraftSaving(true);
    setActionError(null);
    const spec: TaskInput = {                                               // 官方 Lp
      title: draft.title,
      body: draft.notes,
      status: draft.status,
      priorityLevel: draft.priority,
      labels: parseLabels(draft.labels),
      agentId: draft.agentId,
      sessionKey: draft.sessionKey,
      ...(draft.templateId ? { templateId: draft.templateId as TaskInput["templateId"] } : {}),
    };
    try {
      if (draft.editingId) await updateTask(backend, draft.editingId, spec);
      else await createTask(backend, spec);
      closeDraft();
      await refresh();
    } catch (e) {
      setActionError(errMsg(e));
    } finally {
      setDraftSaving(false);
    }
  };

  // ---- 顶层空态/禁用态 ----
  if (!board) {
    return <div className="wb"><p className="muted">{t("common.loading")}</p></div>;
  }
  if (board.error && items.length === 0) {
    // 官方 pluginEnabled=false 提示（Workboard 已禁用。启用 <code>…</code>）。
    const disabledLike = /workboard|unknown method|disabled|not enabled|未启用/i.test(board.error);
    return (
      <div className="wb">
        {disabledLike ? (
          <div className="wb-callout">
            {t("tasks.wb.disabledHelpStart")} <code>{t("tasks.wb.enableConfigKey")}</code>
            {t("tasks.wb.disabledHelpEnd")}
          </div>
        ) : (
          <div className="wb-callout is-danger" role="alert">{board.error}</div>
        )}
      </div>
    );
  }

  const refreshFailed = !!error || !!board.refreshError;
  const displayError = actionError ?? error;

  const draftAgentOpts = agentDraftOptions(agents, draft.agentId, t);       // 官方 Ge
  const sessionOpts = sessions.filter(sessionOptionOk);                     // 官方 Ie

  // ---- 卡片渲染（官方 Ut） ----
  const renderCard = (it: WbItem) => {
    const { card } = it;
    const cardBusy = busy.has(card.id) || dispatching;
    const lc = lifecycleOf(card);
    const tone = lifecycleTone(lc.state);
    const live = isLive(card);
    const linkedKey = cardSessionKey(card);
    const deps = dependenciesOf(card, items);
    const badges = cardBadges(card, t);
    const startable = showStartControls(card);
    const highlighted = highlight ? matchesHealth(card, highlight) : false;
    const taskLine = lc.task && taskConsistent(lc.task, lc.state) ? lc.task : null;
    const events = (card.events ?? []).slice(-4).reverse();
    const stopVisible = linkedKey ? live : taskActive(lc.task);
    return (
      <article
        key={card.id}
        className={`wb-card priority-${card.priority}${cardBusy ? " is-busy" : ""}${card.archived ? " is-archived" : ""}${highlighted ? " is-highlight" : ""}`}
        role="button"
        tabIndex={0}
        title={t("tasks.wb.viewDetails")}
        draggable={!dispatching && !cardBusy}
        onClick={(e) => {
          if ((e.target as Element).closest("button, a, input, select, textarea")) return;
          setDetailId(card.id);
          setDetailNote("");
        }}
        onKeyDown={(e) => {
          if ((e.target as Element).closest("button, a, input, select, textarea")) return;
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          setDetailId(card.id);
          setDetailNote("");
        }}
        onDragStart={(e) => {
          if (dispatching) { e.preventDefault(); return; }
          setDragId(card.id);
          e.dataTransfer.setData("text/plain", card.id);
        }}
        onDragEnd={() => { setDragId(null); setDragOver(null); }}
      >
        <div className="wb-card-top">
          <span className="wb-card-updated" title={t("tasks.wb.detailUpdatedValue", { time: fmtDateTime(card.updatedAt) })}>
            <IcClock />
            <span>{fmtDateTime(card.updatedAt)}</span>
          </span>
          <span className="wb-card-quick">
            {startable && (
              <button
                className="wb-card-iconbtn"
                type="button"
                title={t("tasks.wb.runDefaultAgent")}
                aria-label={t("tasks.wb.runDefaultAgent")}
                disabled={cardBusy}
                onClick={() => void doStart(card, null, "autonomous")}
              >
                <IcPlay />
              </button>
            )}
            {!card.archived && (
              <button
                className="wb-card-iconbtn"
                type="button"
                title={t("tasks.wb.editCard")}
                aria-label={t("tasks.wb.editCard")}
                disabled={dispatching}
                onClick={() => openEdit(card)}
              >
                <IcEdit />
              </button>
            )}
            <button
              className="wb-card-iconbtn"
              type="button"
              title={t(card.archived ? "tasks.wb.unarchiveCard" : "tasks.wb.archiveCard")}
              aria-label={t(card.archived ? "tasks.wb.unarchiveCard" : "tasks.wb.archiveCard")}
              disabled={cardBusy}
              onClick={() => void doArchive(card)}
            >
              {card.archived ? <IcArchiveRestore /> : <IcArchive />}
            </button>
          </span>
        </div>
        {/* R268 信息分层：标题是第一信息，先于 chips；下面 .wb-card-meta 把
            生命周期/依赖/标签/徽标/会话收成一段「状态区」，与内容区拉开层级。
            元素与数据一个没少，只是顺序与分组变了。 */}
        <h3 className="wb-card-title">{card.title}</h3>
        {card.notes && <p className="wb-card-notes">{card.notes}</p>}
        <div className="wb-card-chips">
          <span className={`wb-chip wb-chip--priority-${card.priority}`}>{priorityLabel(card.priority, t)}</span>
          <span
            className="wb-chip wb-chip--agent"
            title={card.agentId
              ? t("tasks.wb.agentLinked", { agent: agentChipLabel(card, agents, t) })
              : t("tasks.wb.agentDefaultLinked", { agent: agentChipLabel(card, agents, t) })}
          >
            {agentChipLabel(card, agents, t)}
          </span>
          {card.archived && <span className="wb-chip">{t("tasks.wb.archived")}</span>}
          {live && <span className="wb-chip wb-chip--live">{t("tasks.wb.live")}</span>}
        </div>
        <div className="wb-card-meta">
        <div className="wb-lifecycle-row">
          <span className={`wb-lifecycle wb-lifecycle--${tone.tone}`}>
            {taskLine
              ? t(`tasks.wb.${taskStatusKey(taskLine)}`)
              : lc.state !== "stale" && card.execution
                ? `${card.execution.engine ?? ""} ${card.execution.mode ?? ""}`.trim() || t(`tasks.wb.${tone.labelKey}`)
                : t(`tasks.wb.${tone.labelKey}`)}
          </span>
          <span className="wb-lifecycle-detail">
            {taskLine ? taskSummary(taskLine) : lc.state === "stale" ? t(`tasks.wb.${tone.detailKey}`) : lc.session?.name ?? t(`tasks.wb.${tone.detailKey}`)}
          </span>
        </div>
        {deps.parents.length > 0 && (
          <div className="wb-deps" title={deps.blockedParents.length
            ? t("tasks.wb.dependenciesBlockedTitle", { parents: deps.blockedParents.map((p) => p.missing ? t("tasks.wb.dependencyMissing", { parent: p.title }) : `${p.title} (${p.status ? statusLabel(p.status, t) : t("tasks.wb.unknownStatus")})`).join(", ") })
            : t("tasks.wb.dependenciesReadyTitle", { count: deps.parents.length })}>
            {deps.blockedParents.length > 0 ? (
              <span className="wb-dep wb-dep--blocked"><IcAlert />{t("tasks.wb.dependenciesBlocked", { count: deps.blockedParents.length })}</span>
            ) : (
              <span className="wb-dep">{t("tasks.wb.dependenciesReady", { count: deps.parents.length })}</span>
            )}
          </div>
        )}
        {card.labels.length > 0 && (
          <div className="wb-labels">{card.labels.map((l) => <span key={l} className="wb-label">{l}</span>)}</div>
        )}
        {badges.length > 0 && (
          <div className="wb-badges">
            {badges.map((b, i) => (
              <span key={i} className={`wb-badge${b.warning ? " is-warning" : ""}`} title={b.title}>
                {b.warning && <IcAlert />}{b.text}
              </span>
            ))}
          </div>
        )}
        <div className="wb-card-session">{linkedKey ?? t("tasks.wb.noLinkedSession")}</div>
        </div>
        {events.length > 0 && (
          <ol className="wb-events" aria-label={t("tasks.wb.eventsLabel")}>
            {events.map((ev, i) => (
              <li key={ev.id ?? i}>
                <span>{eventLabel(ev, t)}</span>
                <time>{new Date(ev.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time>
              </li>
            ))}
          </ol>
        )}
        <div className="wb-card-actions">
          <button
            className="wb-card-iconbtn"
            type="button"
            title={t("tasks.wb.viewDetails")}
            aria-label={t("tasks.wb.viewDetails")}
            onClick={() => { setDetailId(card.id); setDetailNote(""); }}
          >
            <IcPanelRight />
          </button>
          <span className="wb-card-actions-mid">
            {linkedKey && (
              <button
                className="wb-card-iconbtn"
                type="button"
                title={t("tasks.wb.openSession")}
                aria-label={t("tasks.wb.openSession")}
                onClick={() => onOpenSession(linkedKey)}
              >
                <IcMessage />
              </button>
            )}
            {stopVisible && (
              <button
                className="wb-card-iconbtn"
                type="button"
                title={t("tasks.wb.stopSession")}
                aria-label={t("tasks.wb.stopSession")}
                disabled={cardBusy}
                onClick={() => void doStop(card)}
              >
                <IcStop />
              </button>
            )}
            {renderMoveSelect(it, cardBusy, false)}
          </span>
          <button
            className="wb-card-iconbtn is-danger"
            type="button"
            title={t("tasks.wb.deleteCard")}
            aria-label={t("tasks.wb.deleteCard")}
            disabled={cardBusy}
            onClick={() => void doDelete(card.id)}
          >
            <IcTrash />
          </button>
        </div>
      </article>
    );
  };

  // 状态下拉（官方 ct）：卡片内联紧凑版 + 详情抽屉宽版。
  function renderMoveSelect(it: WbItem, disabled: boolean, wide: boolean) {
    const { card } = it;
    const list = statuses.includes(card.status) ? statuses : [card.status, ...statuses];
    if (list.length < 2) return null;
    return (
      <label className={`wb-move${wide ? " wb-move--wide" : ""}`} title={t("tasks.wb.fieldStatus")}>
        <IcCornerDownRight />
        <select
          value={card.status}
          disabled={disabled}
          aria-label={`${t("tasks.wb.fieldStatus")}: ${card.title}`}
          onChange={(e) => void doMove(card.id, e.currentTarget.value)}
        >
          {list.map((s) => <option key={s} value={s}>{statusLabel(s, t)}</option>)}
        </select>
      </label>
    );
  }

  // Run/Open 引擎控件（官方 Z/Ft）。
  function renderStartControls(card: WorkboardCard) {
    const cardBusy = busy.has(card.id) || dispatching;
    const disabledReason = (engine: WbEngine | null) => (engine ? engineDisabledReason(card, agents, t) : null);
    const btn = (engine: WbEngine | null, mode: "autonomous" | "manual") => {
      const reason = disabledReason(engine);
      const label = reason ?? (engine
        ? t(mode === "autonomous" ? "tasks.wb.runEngine" : "tasks.wb.openEngine", { engine: t(engine === "codex" ? "tasks.wb.engineOpenAI" : "tasks.wb.engineClaude") })
        : t("tasks.wb.runDefaultAgent"));
      return (
        <button
          key={`${engine ?? "default"}:${mode}`}
          className="wb-start"
          type="button"
          title={label}
          aria-label={label}
          disabled={cardBusy || !!reason || card.archived}
          onClick={() => void doStart(card, engine, mode)}
        >
          {engine ? (
            <>
              <span className={`wb-engine-mark wb-engine-mark--${engine}`}>
                {engine === "codex" ? t("tasks.wb.engineOpenAI") : t("tasks.wb.engineClaude")}
              </span>
              <span>{t(mode === "autonomous" ? "tasks.wb.run" : "tasks.wb.open")}</span>
            </>
          ) : (
            <>
              {mode === "autonomous" ? <IcPlay /> : <IcPen />}
              <span>{t("tasks.wb.start")}</span>
            </>
          )}
        </button>
      );
    };
    return (
      <div className="wb-start-strip">
        {btn(null, "autonomous")}
        {btn("codex", "autonomous")}
        {btn("claude", "autonomous")}
        {btn("codex", "manual")}
        {btn("claude", "manual")}
      </div>
    );
  }

  // 详情抽屉分节列表（官方 $：取末 6 条）。
  const detailList = (title: string, rows: string[]) => {
    const list = rows.map((r) => r.trim()).filter(Boolean).slice(-6);
    if (!list.length) return null;
    return (
      <section className="drawer-wb-section">
        <h4>{title}</h4>
        <ol className="wb-detail-list">{list.map((r, i) => <li key={i}>{r}</li>)}</ol>
      </section>
    );
  };

  return (
    <div className="wb">
      {/* ---- 主行（R268）：后端切换 · 数据筛选 →右→ 页面动作。全部 48px（规范 §3）。 ---- */}
      <div className="wb-bar">
        {leading}
        <SearchCapsule
          value={query}
          onChange={setQuery}
          placeholder={t("tasks.wb.searchPlaceholder")}
        />
        <span className="wb-select" title={t("tasks.wb.viewPreset")}>
          <Select value={preset} onChange={(v) => setPreset(v as WbViewPreset)}>
            {WB_VIEW_PRESETS.map((p) => {
              const n = presetFiltered(p.value).length;
              return (
                <Option key={p.value} value={p.value} disabled={p.value !== "all" && n === 0}>
                  {t(`tasks.wb.${p.labelKey}`)}
                  {p.value !== "all" ? `（${t("tasks.wb.viewPresetCount", { count: n })}）` : ""}
                </Option>
              );
            })}
          </Select>
        </span>
        <span className="wb-select wb-select--priority" title={t("tasks.wb.allPriorities")}>
          <Select value={priorityFilter} onChange={(v) => setPriorityFilter(v as WorkboardPriority | "all")}>
            <Option value="all">{t("tasks.wb.allPriorities")}</Option>
            {WB_PRIORITIES.map((p) => <Option key={p} value={p}>{priorityLabel(p, t)}</Option>)}
          </Select>
        </span>
        <span className="wb-select wb-select--agent" title={t("tasks.wb.agentFilter")}>
          <Select value={agentFilterSafe} onChange={setAgentFilter}>
            {agentOptions.map((o) => <Option key={o.id} value={o.id}>{o.label}</Option>)}
          </Select>
        </span>
        <span className="wb-bar-end">
          <button
            className="ui-cbtn"
            type="button"
            disabled={dispatching || busy.size > 0}
            onClick={() => void doDispatch()}
          >
            <IcZap /> {t("tasks.wb.dispatch")}
          </button>
          <button
            className="ui-cbtn ui-cbtn--gold"
            type="button"
            aria-haspopup="dialog"
            disabled={dispatching}
            onClick={openCreate}
          >
            <IcPlus /> {t("tasks.wb.newCard")}
          </button>
        </span>
      </div>

      {/* ---- 视图行：左＝健康分诊筛选（官方 Rt），右＝视图开关。语义分层，不再混进主行。 ---- */}
      <div className="wb-bar2">
        <div className="wb-health" aria-label={t("tasks.wb.healthLabel")}>
          {(["running", "blocked", "stale", "readyUnassigned", "missingProof", "failedAttempts"] as WbHealthKind[]).map((k) => (
            <button
              key={k}
              className={`wb-health-item wb-health-item--${k}${highlight === k ? " is-active" : ""}${health[k] === 0 ? " is-empty" : ""}`}
              type="button"
              aria-pressed={highlight === k}
              onClick={() => setHighlight((prev) => (prev === k ? null : k))}
            >
              <strong>{health[k]}</strong>{t(`tasks.wb.health${k.charAt(0).toUpperCase()}${k.slice(1)}`)}
            </button>
          ))}
        </div>
        <div className="wb-viewopts">
          {/* 刷新与「自动刷新 / 上次刷新时间」同属一件事，归到视图行同一簇（R268）。 */}
          {autoMs === 0 && (
            <button
              className="ui-toggle"
              type="button"
              disabled={loading || dispatching || busy.size > 0}
              onClick={() => void refresh({ diagnostics: true })}
            >
              {loading ? t("common.refreshing", { defaultValue: t("common.loading") }) : t("common.refresh")}
            </button>
          )}
          {lastRefreshAt !== null ? (
            <span className={`wb-refresh-status${refreshFailed ? " is-error" : ""}`} title={refreshFailed ? t("tasks.wb.refreshError") : ""}>
              {t("tasks.wb.lastRefreshed", { time: fmtTime(lastRefreshAt) })}
            </span>
          ) : refreshFailed ? (
            <span className="wb-refresh-status is-error">{t("tasks.wb.refreshError")}</span>
          ) : null}
          <button
            className="ui-toggle"
            type="button"
            aria-pressed={showArchived}
            onClick={() => setShowArchived((v) => !v)}
          >
            {showArchived ? <IcEye /> : <IcEyeOff />}
            {showArchived ? t("tasks.wb.hideArchivedShort") : t("tasks.wb.showArchivedShort")}
          </button>
          <button
            className="ui-toggle"
            type="button"
            aria-pressed={hideEmpty}
            onClick={() => setHideEmpty((v) => !v)}
          >
            {t("tasks.wb.hideEmptyColumns")}
          </button>
          <span className="wb-layout-toggle" role="group" aria-label={t("tasks.wb.layout")}>
            <button
              className={`ui-toggle ui-toggle--icon${layout === "compact" ? " is-on" : ""}`}
              type="button"
              title={t("tasks.wb.layoutCompact")}
              aria-pressed={layout === "compact"}
              onClick={() => setLayout("compact")}
            >
              <IcLayoutCompact />
            </button>
            <button
              className={`ui-toggle ui-toggle--icon${layout === "comfortable" ? " is-on" : ""}`}
              type="button"
              title={t("tasks.wb.layoutComfortable")}
              aria-pressed={layout === "comfortable"}
              onClick={() => setLayout("comfortable")}
            >
              <IcLayoutComfortable />
            </button>
          </span>
          <label className="wb-auto-refresh">
            <span>{t("tasks.wb.autoRefresh")}</span>
            <span className="wb-select wb-select--auto">
              <Select value={String(autoMs)} onChange={(v) => setAutoMs(Number(v))}>
                {WB_AUTO_REFRESH.map((o) => (
                  <Option key={o.value} value={String(o.value)}>{t(`tasks.wb.${o.labelKey}`)}</Option>
                ))}
              </Select>
            </span>
          </label>
        </div>
      </div>

      {displayError && <div className="wb-callout is-danger" role="alert">{displayError}</div>}
      {dispatchSummary && (
        <div className="wb-callout">
          {dispatchSummary.started + dispatchSummary.failures + dispatchSummary.promoted +
            dispatchSummary.blocked + dispatchSummary.reclaimed + dispatchSummary.orchestrated === 0
            ? t("tasks.wb.dispatchSummaryEmpty")
            : t("tasks.wb.dispatchSummary", { ...dispatchSummary })}
        </div>
      )}

      {/* ---- 看板（官方 Wt/Bt） ---- */}
      {emptyFiltered || visibleStatuses.length === 0 ? (
        <div className="wb-empty-state" role="status">
          <strong>{t("tasks.wb.emptyFilteredTitle")}</strong>
          <span>{t("tasks.wb.emptyFilteredHint")}</span>
        </div>
      ) : (
        <div className={`wb-board wb-board--${layout}${visibleStatuses.length === 1 ? " wb-board--single-column" : ""}`}>
          {visibleStatuses.map((s) => {
            const cards = buckets.get(s) ?? [];
            return (
              <section
                key={s}
                className={`wb-column wb-column--${s}${dragId && dragOver === s ? " is-drop" : ""}`}
                onDragOver={(e) => {
                  if (!dragId) return;
                  e.preventDefault();
                  if (dragOver !== s) setDragOver(s);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const id = e.dataTransfer.getData("text/plain") || dragId;
                  setDragId(null);
                  setDragOver(null);
                  if (id) void doMove(id, s);
                }}
              >
                <div className="wb-column-head">
                  <h2 style={{ all: "unset" }}>{statusLabel(s, t)}</h2>
                  <span>{cards.length}</span>
                </div>
                <div className="wb-column-cards">
                  {cards.length ? cards.map(renderCard) : <div className="wb-column-empty">{t("tasks.wb.emptyColumn")}</div>}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* ---- 新建/编辑居中模态（官方 xt） ---- */}
      <Modal
        open={draft.open}
        onClose={closeDraft}
        title={t(draft.editingId ? "tasks.wb.editCard" : "tasks.wb.newCard")}
        subtitle={t(draft.editingId ? "tasks.wb.editCardHelp" : "tasks.wb.newCardHelp")}
        width={920}
        footer={(
          <>
            <button
              className="wb-btn-primary"
              type="button"
              disabled={draftSaving || dispatching || !draft.title.trim()}
              onClick={() => void submitDraft()}
            >
              {t(draft.editingId ? "common.save" : "common.create")}
            </button>
            <button className="wb-btn" type="button" onClick={closeDraft}>{t("common.cancel")}</button>
          </>
        )}
      >
        {!draft.editingId && (
          <div className="wb-template-strip" aria-label={t("tasks.wb.templatesLabel")}>
            {WB_TEMPLATES.map((tpl) => (
              <button
                key={tpl.id}
                className={`wb-btn${draft.templateId === tpl.id ? " is-active" : ""}`}
                type="button"
                onClick={() => applyTemplate(tpl.id)}
              >
                {t(`tasks.wb.template_${tpl.id}`)}
              </button>
            ))}
          </div>
        )}
        <Field label={t("tasks.wb.fieldTitle")}>
          <TextInput
            autoFocus
            placeholder={t("tasks.wb.titlePlaceholder")}
            value={draft.title}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
          />
        </Field>
        <Field label={t("tasks.wb.fieldNotes")}>
          <TextArea
            rows={6}
            placeholder={t("tasks.wb.notesPlaceholder")}
            value={draft.notes}
            onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
          />
        </Field>
        <div className="wb-modal-grid">
          <Field label={t("tasks.wb.fieldStatus")}>
            <Select value={draft.status} onChange={(v) => setDraft((d) => ({ ...d, status: v }))}>
              {statuses.map((s) => <Option key={s} value={s}>{statusLabel(s, t)}</Option>)}
            </Select>
          </Field>
          <Field label={t("tasks.wb.fieldPriority")}>
            <Select value={draft.priority} onChange={(v) => setDraft((d) => ({ ...d, priority: v as WorkboardPriority }))}>
              {WB_PRIORITIES.map((p) => <Option key={p} value={p}>{priorityLabel(p, t)}</Option>)}
            </Select>
          </Field>
          <Field label={t("tasks.wb.fieldAgent")}>
            <Select value={draft.agentId} onChange={(v) => setDraft((d) => ({ ...d, agentId: v }))}>
              {draftAgentOpts.map((o) => <Option key={o.id} value={o.id}>{o.label}</Option>)}
            </Select>
          </Field>
          <Field label={t("tasks.wb.fieldSession")}>
            <Select value={draft.sessionKey} onChange={(v) => setDraft((d) => ({ ...d, sessionKey: v }))}>
              <Option value="">{t("tasks.wb.noLinkedSession")}</Option>
              {sessionOpts.map((s) => <Option key={s.key} value={s.key}>{sessionDisplay(s)}</Option>)}
              {draft.sessionKey && !sessionOpts.some((s) => s.key === draft.sessionKey) && (
                <Option value={draft.sessionKey}>{draft.sessionKey}</Option>
              )}
            </Select>
          </Field>
          <div className="wb-field--wide">
            <Field label={t("tasks.wb.fieldLabels")}>
              <TextInput
                placeholder={t("tasks.wb.labelsPlaceholder")}
                value={draft.labels}
                onChange={(e) => setDraft((d) => ({ ...d, labels: e.target.value }))}
              />
            </Field>
          </div>
        </div>
        {draft.editingId && (() => {
          const editing = items.find((i) => i.card.id === draft.editingId)?.card;
          const comments = editing?.metadata?.comments ?? [];
          const editBusy = draftSaving || dispatching || (draft.editingId ? busy.has(draft.editingId) : false);
          return (
            <section aria-label={t("tasks.wb.badgeComments", { count: comments.length })}>
              <Field label={t("tasks.wb.badgeComments", { count: comments.length })}>
                <>
                  {comments.length > 0 && (
                    <ol className="wb-comments-list">{comments.map((c) => <li key={c.id}>{c.body}</li>)}</ol>
                  )}
                  <TextArea
                    rows={2}
                    maxLength={2000}
                    value={draft.comment}
                    onChange={(e) => setDraft((d) => ({ ...d, comment: e.target.value }))}
                  />
                  <div className="wb-modal-actions">
                    <button
                      className="wb-btn"
                      type="button"
                      disabled={editBusy || !draft.comment.trim()}
                      onClick={() => void doAddNote(draft.editingId!, draft.comment, () => setDraft((d) => ({ ...d, comment: "" })))}
                    >
                      <IcPlus /> {t("common.create")}
                    </button>
                  </div>
                </>
              </Field>
            </section>
          );
        })()}
      </Modal>

      {/* ---- 详情抽屉（官方 It） ---- */}
      <Modal
        open={!!detailVisible}
        onClose={() => { setDetailId(null); setDetailNote(""); onDetailClose?.(); }}
        title={detailVisible ? (
          <span>
            <span className={`wb-chip wb-chip--priority-${detailVisible.card.priority}`} style={{ marginRight: 8 }}>
              {priorityLabel(detailVisible.card.priority, t)}
            </span>
            {detailVisible.card.title}
          </span>
        ) : ""}
        subtitle={detailVisible ? t("tasks.wb.detailTitle") : undefined}
        width={560}
      >
        {detailVisible && (() => {
          const { card } = detailVisible;
          const cardBusy = busy.has(card.id) || dispatching;
          const lc = lifecycleOf(card);
          const tone = lifecycleTone(lc.state);
          const md = card.metadata ?? {};
          const deps = dependenciesOf(card, items);
          const linkedKey = cardSessionKey(card);
          const live = isLive(card);
          const taskLine = lc.task && taskConsistent(lc.task, lc.state) ? lc.task : null;
          const events = (card.events ?? []).slice(-6).reverse();
          const comments = md.comments ?? [];
          const auto = md.automation;
          const stopVisible = linkedKey ? live : taskActive(lc.task);
          return (
            <>
              <div className="wb-lifecycle-row" style={{ marginBottom: 10 }}>
                <span className={`wb-lifecycle wb-lifecycle--${tone.tone}`}>
                  {taskLine ? t(`tasks.wb.${taskStatusKey(taskLine)}`) : t(`tasks.wb.${tone.labelKey}`)}
                </span>
                <span className="wb-lifecycle-detail">
                  {taskLine ? taskSummary(taskLine) : lc.session?.name ?? t(`tasks.wb.${tone.detailKey}`)}
                </span>
              </div>
              <div className="wb-detail-grid">
                <div className="wb-detail-row"><span>{t("tasks.wb.fieldStatus")}</span><strong>{statusLabel(card.status, t)}</strong></div>
                <div className="wb-detail-row"><span>{t("tasks.wb.fieldAgent")}</span><strong>{card.agentId ?? t("tasks.wb.defaultAgent")}</strong></div>
                {(lc.task?.taskId ?? card.taskId) && (
                  <div className="wb-detail-row"><span>{t("tasks.wb.detailTask")}</span><strong>{lc.task?.taskId ?? card.taskId}</strong></div>
                )}
                {lc.task?.runtime && (
                  <div className="wb-detail-row"><span>{t("tasks.wb.taskRuntime")}</span><strong>{lc.task.runtime}</strong></div>
                )}
                {lc.task?.terminalOutcome && (
                  <div className="wb-detail-row"><span>{t("tasks.wb.taskTerminalOutcome")}</span><strong>{lc.task.terminalOutcome}</strong></div>
                )}
                {lc.task?.deliveryStatus && (
                  <div className="wb-detail-row">
                    <span>{t("tasks.wb.taskDeliveryStatus")}</span>
                    <strong className={lc.task.deliveryStatus === "failed" ? "status-error" : undefined}>
                      {lc.task.deliveryStatus === "failed" ? t("tasks.wb.taskResultNotDelivered") : lc.task.deliveryStatus}
                    </strong>
                  </div>
                )}
                {taskDateTime(lc.task?.startedAt) && (
                  <div className="wb-detail-row"><span>{t("tasks.wb.taskStarted")}</span><strong>{taskDateTime(lc.task?.startedAt)}</strong></div>
                )}
                {taskDateTime(lc.task?.endedAt) && (
                  <div className="wb-detail-row"><span>{t("tasks.wb.taskEnded")}</span><strong>{taskDateTime(lc.task?.endedAt)}</strong></div>
                )}
                {linkedKey && <div className="wb-detail-row"><span>{t("tasks.wb.fieldSession")}</span><strong>{linkedKey}</strong></div>}
                {cardRunId(card) && <div className="wb-detail-row"><span>{t("tasks.wb.detailRun")}</span><strong>{cardRunId(card)}</strong></div>}
                <div className="wb-detail-row"><span>{t("tasks.wb.detailUpdated")}</span><strong>{fmtDateTime(card.updatedAt)}</strong></div>
              </div>
              {card.notes && (
                <section className="drawer-wb-section">
                  <h4>{t("tasks.wb.fieldNotes")}</h4>
                  <p style={{ whiteSpace: "pre-line", margin: 0 }}>{card.notes}</p>
                </section>
              )}
              {deps.parents.length > 0 && (
                <section className="drawer-wb-section">
                  <h4>{t("tasks.wb.dependencies")}</h4>
                  <ul className="wb-detail-list wb-detail-deps" style={{ listStyle: "none", paddingLeft: 0 }}>
                    {deps.parents.map((p) => (
                      <li key={p.id} className={p.done ? "is-done" : "is-blocked"}>
                        {!p.done && <IcAlert />} {p.title} —{" "}
                        {p.missing ? t("tasks.wb.dependencyStatusMissing") : p.status ? statusLabel(p.status, t) : t("tasks.wb.unknownStatus")}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {detailList(t("tasks.wb.fieldLabels"), card.labels)}
              {detailList(
                t("tasks.wb.badgeAttempts", { count: (md.attempts ?? []).length }),
                (md.attempts ?? []).map((a) => [a.status, a.model, a.sessionKey, a.error].filter(Boolean).join(" - ")),
              )}
              {detailList(
                t("tasks.wb.badgeLinks", { count: (md.links ?? []).length }),
                (md.links ?? []).map((l) => [l.type, l.title, l.targetCardId, l.url].filter(Boolean).join(" - ")),
              )}
              {detailList(
                t("tasks.wb.detailProof"),
                (md.proof ?? []).map((p) => [p.status, p.label, p.command, p.url, p.note].filter(Boolean).join(" - ")),
              )}
              {detailList(
                t("tasks.wb.badgeArtifacts", { count: (md.artifacts ?? []).length }),
                (md.artifacts ?? []).map((a) => [a.label, a.url, a.path, a.mimeType].filter(Boolean).join(" - ")),
              )}
              {detailList(
                t("tasks.wb.badgeAttachments", { count: (md.attachments ?? []).length }),
                (md.attachments ?? []).map((a) => [a.fileName, a.mimeType, a.note].filter(Boolean).join(" - ")),
              )}
              {detailList(t("tasks.wb.detailDiagnostics"), (md.diagnostics ?? []).map((d) => `${d.severity}: ${d.title}`))}
              {detailList(t("tasks.wb.detailWorkerLogs"), (md.workerLogs ?? []).map((l) => `${l.level}: ${l.message}`))}
              {md.workerProtocol &&
                detailList(t("tasks.wb.detailWorkerProtocol"), [
                  md.workerProtocol.state,
                  md.workerProtocol.detail ?? "",
                  md.workerProtocol.updatedAt ? t("tasks.wb.detailUpdatedValue", { time: fmtDateTime(md.workerProtocol.updatedAt) }) : "",
                ])}
              {auto &&
                detailList(t("tasks.wb.detailAutomation"), [
                  auto.tenant ? t("tasks.wb.detailAutomationTenant", { tenant: auto.tenant }) : "",
                  auto.boardId ? t("tasks.wb.detailAutomationBoard", { board: auto.boardId }) : "",
                  auto.skills?.length ? t("tasks.wb.detailAutomationSkills", { skills: auto.skills.join(", ") }) : "",
                  auto.workspace ? t("tasks.wb.detailAutomationWorkspace", { workspace: [auto.workspace.kind, auto.workspace.path, auto.workspace.branch].filter(Boolean).join(" ") }) : "",
                  auto.dispatchCount ? t("tasks.wb.badgeDispatches", { count: auto.dispatchCount }) : "",
                  auto.lastDispatchAt ? t("tasks.wb.detailUpdatedValue", { time: fmtDateTime(auto.lastDispatchAt) }) : "",
                  auto.summary ? t("tasks.wb.detailAutomationSummary", { summary: auto.summary }) : "",
                ])}
              {detailList(t("tasks.wb.eventsLabel"), events.map((ev) => `${eventLabel(ev, t)} ${fmtDateTime(ev.at)}`))}
              <section className="drawer-wb-section">
                <h4>{t("tasks.wb.detailOperatorNotes")}</h4>
                {comments.length ? (
                  <ol className="wb-detail-list">{comments.slice(-6).map((c) => <li key={c.id}>{c.body}</li>)}</ol>
                ) : (
                  <p className="muted" style={{ margin: 0 }}>{t("tasks.wb.detailNoNotes")}</p>
                )}
                <textarea
                  className="wb-note-input"
                  maxLength={2000}
                  placeholder={t("tasks.wb.detailNotePlaceholder")}
                  value={detailNote}
                  onChange={(e) => setDetailNote(e.target.value)}
                />
                <div className="wb-detail-actions">
                  <button
                    className="wb-btn"
                    type="button"
                    disabled={cardBusy || !detailNote.trim()}
                    onClick={() => void doAddNote(card.id, detailNote, () => setDetailNote(""))}
                  >
                    <IcPlus /> {t("tasks.wb.detailAddNote")}
                  </button>
                </div>
              </section>
              <section className="drawer-wb-section">
                <div className="wb-detail-actions">
                  {!card.archived && (
                    <button className="wb-btn" type="button" disabled={dispatching} onClick={() => openEdit(card)}>
                      <IcEdit /> {t("tasks.wb.editCard")}
                    </button>
                  )}
                  <button className="wb-btn" type="button" disabled={cardBusy} onClick={() => void doArchive(card)}>
                    {card.archived ? <IcArchiveRestore /> : <IcArchive />}
                    {t(card.archived ? "tasks.wb.unarchiveCard" : "tasks.wb.archiveCard")}
                  </button>
                  {renderMoveSelect(detailVisible, cardBusy, true)}
                  {stopVisible && (
                    <button className="wb-btn" type="button" disabled={cardBusy} onClick={() => void doStop(card)}>
                      <IcStop /> {t("tasks.wb.stopSession")}
                    </button>
                  )}
                  {linkedKey && (
                    <button className="wb-btn" type="button" onClick={() => onOpenSession(linkedKey)}>
                      <IcMessage /> {t("tasks.wb.openSession")}
                    </button>
                  )}
                  <button className="wb-btn wb-btn-danger" type="button" disabled={cardBusy} onClick={() => void doDelete(card.id)}>
                    <IcTrash /> {t("tasks.wb.deleteCard")}
                  </button>
                </div>
                {showStartControls(card) && <div style={{ marginTop: 10 }}>{renderStartControls(card)}</div>}
              </section>
            </>
          );
        })()}
      </Modal>
    </div>
  );
}
