import AgentAvatarView from "../../components/AgentAvatar";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ClipboardEvent, DragEvent, KeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode, RefObject, WheelEvent } from "react";
import { useTranslation } from "react-i18next";
import { useGlassRenderer } from "./useGlassRenderer";
import FilterTabs from "../../components/FilterTabs";
import { SESSION_CATEGORY_ORDER, sessionCategoryOf, type SessionCategory, type SessionCategoryRow } from "../../lib/sessionKind";
import ChatModelMenu, { type ModelMenuChoice } from "../ChatModelMenu";
import ChatPermissionMenu from "../ChatPermissionMenu";
import type { ChatPermissionModeOption } from "../../types";
import ChatPromptCard, { type ChatPromptEntry, type ChatPromptResponse } from "../ChatPromptCard";
import ImmersiveBackdrop from "./ImmersiveBackdrop";
import ImmersiveStatusLine, { type ImmersiveLiveStatus } from "./ImmersiveStatusLine";
import ImmersiveActivityView from "./ImmersiveActivityView";
import ImmersiveOverlay from "./ImmersiveOverlay";
import ImmersiveCronPanel from "./ImmersiveCronPanel";
import ImmersiveKanbanPanel from "./ImmersiveKanbanPanel";
import ImmersiveProfilePanel from "./ImmersiveProfilePanel";
import { type ImmersivePhase } from "./immersiveBg";
import type { MediaSource } from "../glass/scene";
import { IconSend, IconClip, IconAttachmentFolder, IconClock, IconArchive, IconMic, IconStop, IconPencil, IconActivity, IconBoard, IconUser, IconImmersiveExit } from "../chatIcons";
import styles from "./ImmersiveChat.module.css";

// 聊天列宽持久化键（右缘把手拖出的宽度，px；无键=Figma 默认）
const COL_W_KEY = "shoggoth.chat.immersive.colw.v1";

// 一条会话（切换浮层用）。用纯字符串而非 ChatPage 内部 SessionRow，避免类型耦合 / 循环 import。
export interface ImmersiveSessionRow extends SessionCategoryRow {
  title: string;
  sub: string;
  /** 已格式化的相对时间（"3m"），空串 = 不显示。 */
  time?: string;
  active: boolean;
}

// 一条消息（中央消息流用）。ChatPage 侧把 Group 预渲染成简单判别联合，
// 这样 ImmersiveChat 不耦合 ChatPage 内部的 Group/ChatMsg/Part 类型。
// kind 缺省 = "chat"（普通对话正文）。交互（重试/回答审批）用无参闭包传入，
// Group 本体留在 ChatPage 内部。
export interface ImmersiveMessage {
  id: string;
  role: string; // "user" → 右侧气泡；其余 → 左侧折射玻璃卡
  kind?: "chat" | "injected" | "divider" | "error" | "local";
  html: string; // 已 sanitize 的 markdown（injected = 展开后的全文；divider/error 不用）
  images: string[]; // user 自发图（base64）/ agent MEDIA 图（/__media 或 URL）
  // 非图附件（视频/PDF/文件）。带 src 的视频渲染成可点开灯箱的预览窗，其余是文件 chip。
  files?: { name: string; kind: string; src?: string; path?: string }[];
  footer: string;
  pending?: boolean; // 流式中 → 正文尾部渲染光标
  prompts?: ChatPromptEntry[]; // 阻塞等答的审批/澄清/sudo/密钥卡（挂在 pending 泡上）
  injectedHead?: string; // kind=injected：折叠单行预览
  errorText?: string; // kind=error：显示文本（已 i18n/网关错误翻译）
  errorRaw?: string; // kind=error：hover 原文（与显示不同才给）
  errorRepeat?: number; // kind=error：连续相同失败 ×N
  onRetry?: () => void; // kind=error：重发上一条用户消息
  dividerLabel?: string; // kind=divider：分隔线文案
  dividerTitle?: string; // kind=divider：hover 原文（模型切换标记）
  // 悬浮操作 / 右键（无参闭包捕获 Group，动作与普通模式同一套 handler）
  onCopy?: () => void;
  onPin?: () => void;
  pinned?: boolean;
  onDelete?: () => void;
  onCtx?: (e: ReactMouseEvent<HTMLDivElement>) => void;
}

// 沉浸模式：fixed 覆盖层，盖在普通聊天 `.chat-shell` 之上。底下 ChatPage 原样保活
// （WS 不断、内存态全在），退出 = 卸载本覆盖层。三层合成：<video> 背景 → <canvas>
// WebGL 折射玻璃（pointer-events:none）→ DOM 内容（背景透明，盖在折射面板上）。
// 布局按 Figma 6721:74：左列（内容 ~617px）+ 右侧视频主体。复用 ChatPage 逻辑（bundle 注入）。
export interface ImmersiveBundle {
  onExit: () => void;
  /** agent 状态相位（未滞回原始值）——背景媒体层据此切素材，滞回在 Backdrop 内做。 */
  phase: ImmersivePhase;
  /** 本轮流式过程（工具/思考）——轻量状态行的原料；无过程信息时 null（沿用三点等待）。 */
  live: ImmersiveLiveStatus | null;
  /** 本地发送单调计数：变化一次 = 触发一次「发送即锚定」（R280 mirror）。 */
  sendSeq: number;
  /** 滚近顶部时触发加载封存历史（幂等/节流由 ChatPage 的 archive 状态机自守）。 */
  onNearTop: () => void;
  /** 拖拽文件到 composer 上传（与普通模式同一 handler）。 */
  onDropFiles: (e: DragEvent<HTMLDivElement>) => void;
  // 中央消息流
  messages: ImmersiveMessage[];
  // composer：输入 + 发送。setInput/onInputKeyDown/onInputPaste 与普通 composer 共享同一套
  // 处理器（IME 组合守卫 / slash 菜单联动导航 / ↑↓ 历史召回 / Enter 发送 / 粘贴图片）。
  input: string;
  setInput: (v: string) => void;
  inputElRef: RefObject<HTMLTextAreaElement>;
  onInputKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onInputPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  submit: (overrideText?: string) => void;
  sending: boolean;
  canSteer: boolean;
  abortActive: () => void;
  hasActiveSession: boolean;
  canSend: boolean;
  // slash 命令菜单：节点由 ChatPage 构建（与普通模式同一份 JSX），渲染进沉浸 composer。
  slashMenu: ReactNode;
  slashOpen: boolean;
  // composer：工具行
  models: ModelMenuChoice[];
  displayModel: string;
  changeModel: (id: string, provider?: string) => void;
  activeModelProvider?: string;
  modelsLoading?: boolean;
  modelsError?: boolean;
  refreshModels?: () => void;
  modelSelectionDisabled: boolean;
  permissionOptions?: ChatPermissionModeOption[];
  permissionMode?: string;
  changePermissionMode?: (option: ChatPermissionModeOption) => void;
  permissionSelectionDisabled?: boolean;
  listLive: boolean;
  thinkingLevel: string; // 已经过 thinkLabel 的显示文案（如 "Think hard"），空串 = 不显示
  ctxSummary: string; // 会话上下文用量摘要（"34% · 12k/200k"），空串 = 不显示
  listening: boolean;
  toggleTalk: () => void;
  sttSupported: boolean;
  onAttachClick: () => void;
  supportsAttachments: boolean;
  // 发送前可见状态：附件预览（可移除）+ 引用条（可取消）——否则发送时会带上看不见的内容
  attachments: { id: string; dataUrl: string; name: string; kind?: string }[];
  removeAttachment: (id: string) => void;
  quoteText: string | null;
  clearQuote: () => void;
  // 左上角身份 + 会话切换
  sessionTitle: string;
  sessionMeta: string;
  // 身份区状态点：与普通模式 header 状态点同口径（statusOf：running=前台轮次在跑）。
  // reconnecting（网关重启/后端启动中，正在自愈）沿用离线的灰点皮肤，只有 title 文案不同。
  liveStatusKind: "running" | "online" | "offline" | "reconnecting";
  activeAgentId: string | null;
  activeBackendId: string;
  avatarVersion: number;
  sessions: ImmersiveSessionRow[];
  openSession: (key: string) => void;
  // 右上角工具
  onRefresh: () => void;
  sessionLabel: string; // 重命名输入框预填（当前自定义名，可为空）
  onRenameSubmit: (label: string) => void; // sessions.patch；结果 toast（z 高于本层）可见
  onDelete: () => void;
  // 灯箱：复用 ChatPage 的（其 z-index 高于本层）。kind 缺省 image；视频附件传 "video"。
  openLightbox: (src: string, kind?: "image" | "video") => void;
  openAttachmentFile?: (file: { name: string; src?: string; path?: string }) => void;
  lightboxOpen: boolean;
  // 回答阻塞式 agent 请求卡（approval/clarify/sudo/secret）→ ChatPage 的 chat.respond
  onRespondPrompt: (entry: ChatPromptEntry, data: ChatPromptResponse) => void;
}

export default function ImmersiveChat(props: ImmersiveBundle) {
  const {
    onExit, phase, live, sendSeq, onNearTop, onDropFiles, messages, input, setInput, inputElRef, onInputKeyDown, onInputPaste,
    submit, sending, canSteer, abortActive, hasActiveSession, canSend, slashMenu, slashOpen,
    models, displayModel, changeModel, activeModelProvider, modelsLoading, modelsError, refreshModels, modelSelectionDisabled, listLive, thinkingLevel, ctxSummary,
    permissionOptions = [], permissionMode = "", changePermissionMode, permissionSelectionDisabled = false,
    listening, toggleTalk, sttSupported, onAttachClick, supportsAttachments,
    attachments, removeAttachment, quoteText, clearQuote,
    sessionTitle, sessionMeta, liveStatusKind, activeAgentId, activeBackendId, avatarVersion, sessions, openSession,
    onRefresh, sessionLabel, onRenameSubmit, onDelete,
    openLightbox, openAttachmentFile, lightboxOpen, onRespondPrompt,
  } = props;
  const { t } = useTranslation();
  // 背景媒体层的前台元素（视频/图片），由 Backdrop 维护——GL 折射纹理源。
  const bgSourceRef = useRef<MediaSource | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  // 视图：聊天 / 今日动态（聊天收起成左下胶囊）。纯呈现态，进入沉浸恒为 chat。
  const [view, setView] = useState<"chat" | "activity">("chat");
  // 右上角三面板（当前 agent 的 cron/kanban/档案），玻璃浮层，一次一个。
  const [overlay, setOverlay] = useState<null | "cron" | "kanban" | "profile">(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // 会话类型筛选（null = 全部）。R266 起会话列表不再按类型隐藏 cron/子代理/dream，
  // 靠这排 Tab 分流——与普通模式的 ChatSessionMenu 同一个分类函数、同一个组件。
  const [pickerKind, setPickerKind] = useState<SessionCategory | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  // 聊天列宽（px）：右缘把手拖出的用户宽度，null=未拖过（走 Figma 默认 min(617px,46vw)）。
  // 存原始值，应用侧由 CSS clamp 钳（下限 400 / 上限半窗 50vw），窗口缩放自动跟随。
  const [colW, setColW] = useState<number | null>(() => {
    try {
      const n = parseInt(localStorage.getItem(COL_W_KEY) || "", 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  });
  const [colDragging, setColDragging] = useState(false);
  const colDragRef = useRef(false);
  useEffect(() => {
    try {
      if (colW == null) localStorage.removeItem(COL_W_KEY);
      else localStorage.setItem(COL_W_KEY, String(colW));
    } catch {
      /* ignore */
    }
  }, [colW]);
  const onColDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    colDragRef.current = true;
    setColDragging(true);
  };
  const onColMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!colDragRef.current) return;
    // 列左缘固定 112px；JS 侧同款 clamp 让落盘值本身就干净。上限取半窗但不低于下限
    //（窗口未布局时 innerWidth 可为 0，别把 0 落盘）。
    const cap = Math.max(400, window.innerWidth / 2);
    setColW(Math.round(Math.min(Math.max(400, e.clientX - 112), cap)));
  };
  const onColUp = () => {
    colDragRef.current = false;
    setColDragging(false);
  };
  // 注入伪 user 灰条（kind=injected）的展开集合——按条目 id 记，切会话时消息 id 全换,自然收起。
  const [injectedOpen, setInjectedOpen] = useState<Set<string>>(new Set());
  const toggleInjected = (id: string) =>
    setInjectedOpen((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // 只有用户本来就贴在底部（<80px）时新消息才自动滚底——
  // 往上翻历史时流式输出不再把人拽回底部。
  const stickRef = useRef(true);
  // ── R280 mirror — keep in sync with ChatPage 普通线程的锚定编排（sizeStreamSpacer +
  //    useLayoutEffect 分支）。发送即锚定：自己的消息停在视口上方（留 ~280px 上文），
  //    末尾 spacer 预留一屏站位，回复流入时 1:1 收缩 → scrollHeight 不变视口不动；
  //    锚定态永不自动吸底，「跳到最新」胶囊或手动滚到底解除。 ──
  const anchoredRef = useRef(false);
  const spacerRef = useRef<HTMLDivElement | null>(null);
  const lastSendSeqRef = useRef(sendSeq);
  const lastScrollHeightRef = useRef(0);
  const [showJump, setShowJump] = useState(false);
  const clearAnchor = () => {
    anchoredRef.current = false;
    if (spacerRef.current) spacerRef.current.style.height = "0px";
    setShowJump(false);
  };
  const jumpToLatest = () => {
    clearAnchor();
    stickRef.current = true;
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  const onThreadScroll = () => {
    const el = threadRef.current;
    if (el) {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      if (nearBottom && anchoredRef.current) {
        // 用户自己滚过预留区到底 = 解除锚定，回到贴底跟随
        clearAnchor();
        stickRef.current = true;
      } else {
        stickRef.current = nearBottom && !anchoredRef.current;
      }
    }
  };
  // 滚轮到顶继续上滚 → 触发封存历史加载（前插补偿在下方 layout effect）
  const onThreadWheel = (e: WheelEvent<HTMLDivElement>) => {
    const el = threadRef.current;
    if (el && e.deltaY < 0 && el.scrollTop < 400) onNearTop();
  };
  useGlassRenderer({
    getSource: () => bgSourceRef.current,
    canvasRef,
    active: true,
    panelSelector: "[data-glass-panel]",
    onFail: () => setFailed(true),
  });

  // 切会话 → 重新贴底；新消息/流式更新 → 仅贴底时跟随。
  const activeSessKey = useMemo(() => sessions.find((s) => s.active)?.key ?? "", [sessions]);
  // Tab 行只列真实存在的类型（自动分 Tab），顺序固定、各带条数。
  const pickerKinds = useMemo(() => {
    const count = new Map<SessionCategory, number>();
    for (const s of sessions) {
      const k = sessionCategoryOf(s);
      count.set(k, (count.get(k) ?? 0) + 1);
    }
    return SESSION_CATEGORY_ORDER.filter((k) => count.has(k)).map((k) => ({ kind: k, count: count.get(k) ?? 0 }));
  }, [sessions]);
  const pickerSessions = useMemo(
    () => (pickerKind ? sessions.filter((s) => sessionCategoryOf(s) === pickerKind) : sessions),
    [sessions, pickerKind],
  );
  // 关掉浮层就把筛选清回「全部」（下次打开是干净的，与模型菜单同一收尾）。
  useEffect(() => {
    if (!pickerOpen) setPickerKind(null);
  }, [pickerOpen]);
  useEffect(() => {
    stickRef.current = true;
    clearAnchor();
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    lastScrollHeightRef.current = el?.scrollHeight ?? 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessKey]);
  // 消息变化的滚动编排（R280 mirror）：发送锚定 / 锚定态维持 spacer / 贴底跟随 /
  // 顶部前插补偿（封存历史 prepend 时视口不跳）。
  useLayoutEffect(() => {
    const el = threadRef.current;
    const spacer = spacerRef.current;
    if (!el || !spacer || !el.clientHeight) return;
    const lastUserRow = (): HTMLElement | null => {
      const rows = el.querySelectorAll<HTMLElement>("[data-user-row]");
      return rows.length ? rows[rows.length - 1] : null;
    };
    const anchorTopOf = (anchor: HTMLElement): number =>
      anchor.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    const SEND_ANCHOR_CONTEXT_PX = 280; // 与普通模式同一校准值（留 ~4 条上文气泡）
    const sizeSpacer = (anchorTop: number): number => {
      const padTop = parseFloat(getComputedStyle(el).paddingTop) || 0;
      const target = Math.max(0, anchorTop - padTop - SEND_ANCHOR_CONTEXT_PX);
      const heightSansSpacer = el.scrollHeight - spacer.offsetHeight;
      // 预留至多一屏：站位 = 「气泡在顶、其余留白」，上限兜住量算失手
      const h = Math.min(el.clientHeight, Math.max(0, target + el.clientHeight - heightSansSpacer));
      spacer.style.height = `${h}px`;
      return target;
    };
    // 顶部前插（封存历史）补偿：视口在上方且非贴底时，把高度差原样加回 scrollTop
    const grown = el.scrollHeight - lastScrollHeightRef.current;
    if (grown > 0 && !stickRef.current && !anchoredRef.current && el.scrollTop < 400) {
      el.scrollTop += grown;
    }
    if (sendSeq !== lastSendSeqRef.current) {
      lastSendSeqRef.current = sendSeq;
      const anchor = lastUserRow();
      if (anchor) {
        el.scrollTop = sizeSpacer(anchorTopOf(anchor));
        anchoredRef.current = true;
        stickRef.current = false;
        setShowJump(true);
      }
    } else if (anchoredRef.current) {
      const anchor = lastUserRow();
      if (anchor) sizeSpacer(anchorTopOf(anchor)); // 回复流入 → spacer 1:1 收缩，视口纹丝不动
    } else if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
    lastScrollHeightRef.current = el.scrollHeight;
  }, [messages, sendSeq]);

  // Esc：优先关内部浮层（灯箱由 ChatPage 自己关、slash 菜单由 composer 键盘处理关、
  // 状态行详情浮层在 capture 阶段自拦），再退动态视图回聊天，都没有才退出沉浸模式。
  // 内部输入框里的 Esc 已 stopPropagation，不会走到这里。
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (lightboxOpen || slashOpen) return;
      if (overlay) { setOverlay(null); return; }
      if (pickerOpen) { setPickerOpen(false); return; }
      if (renameOpen) { setRenameOpen(false); return; }
      if (view !== "chat") { setView("chat"); return; }
      onExit();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [lightboxOpen, slashOpen, overlay, pickerOpen, renameOpen, view, onExit]);

  // 等待指示：已发出、assistant 还没吐出首个可见内容（thinking/工具阶段）时给个脉冲点，
  // 否则发送后画面毫无反应。首个可见 assistant 内容（正文/审批卡）落地即消失；
  // 末条是 divider/注入灰条时同样算「还没回应」。
  const lastMsg = messages[messages.length - 1];
  const waiting = sending && !(lastMsg && (lastMsg.kind ?? "chat") === "chat" && lastMsg.role !== "user");

  const startRename = () => {
    setRenameDraft(sessionLabel);
    setRenameOpen(true);
  };

  // 消息悬浮操作条（复制/置顶/本地删除；重试在错误卡内）——hover 淡入，动作闭包来自 ChatPage
  const actionsFor = (m: ImmersiveMessage) =>
    m.onCopy || m.onPin || m.onDelete ? (
      <div className={styles.rowActions}>
        {m.onCopy && (
          <button type="button" className={styles.actBtn} onClick={m.onCopy} title={t("chat.copy")}>
            <IconMiniCopy />
          </button>
        )}
        {m.onPin && (
          <button
            type="button"
            className={m.pinned ? `${styles.actBtn} ${styles.actBtnOn}` : styles.actBtn}
            onClick={m.onPin}
            title={m.pinned ? t("chat.unpin") : t("chat.pin")}
          >
            <IconMiniPin />
          </button>
        )}
        {m.onDelete && (
          <button type="button" className={`${styles.actBtn} ${styles.actBtnDanger}`} onClick={m.onDelete} title={t("chat.deleteLocal")}>
            <IconMiniTrash />
          </button>
        )}
      </div>
    ) : null;

  return (
    <div data-testid="immersive-chat" className={styles.root} style={colW != null ? ({ "--imm-col": `${colW}px` } as CSSProperties) : undefined}>
      <ImmersiveBackdrop phase={phase} sourceRef={bgSourceRef} />
      <canvas ref={canvasRef} className={styles.gl} aria-hidden="true" />

      {/* 左上角：身份（会话名 + 状态）+ 点击展开同一 agent 的会话切换浮层。
          动态视图下让位给 ActivityView 自己的标题区（Figma 6677）。 */}
      {view === "chat" && (
      <div className={styles.topleft}>
        <button type="button" className={styles.identity} onClick={() => setPickerOpen((v) => !v)} disabled={!hasActiveSession}>
          {activeAgentId && (
            <AgentAvatarView agentId={activeAgentId} version={avatarVersion} className={styles.avatar} />
          )}
          <span className={styles.idText}>
            <span className={styles.idName}>{sessionTitle || t("chat.immersiveEnter")}</span>
            <span className={styles.idMeta}>
              <span
                className={`${styles.statusDot} ${
                  liveStatusKind === "running" ? styles.statusRunning : liveStatusKind === "online" ? styles.statusOnline : styles.statusOffline
                }`}
                title={t(`chat.liveStatus.${liveStatusKind}`)}
              />
              {sessionMeta}
            </span>
          </span>
        </button>
        {pickerOpen && sessions.length > 0 && (
          <>
            <div className={styles.backdrop} onMouseDown={() => setPickerOpen(false)} />
            <div className={styles.picker}>
              {pickerKinds.length > 1 && (
                <FilterTabs
                  className={styles.pickerTabs}
                  ariaLabel={t("chat.switchAgentSession")}
                  scrollable
                  toggleOff=""
                  value={pickerKind ?? ""}
                  onChange={(v) => setPickerKind(v === "" ? null : (v as SessionCategory))}
                  items={[
                    { value: "", label: t("chat.sessionFilterAll", { count: sessions.length }) },
                    ...pickerKinds.map((k) => ({
                      value: k.kind,
                      label: `${t(`chat.sessionFilter.${k.kind}`)} ${k.count}`,
                      title: t(`chat.sessionFilter.${k.kind}`),
                    })),
                  ]}
                />
              )}
              <div className={styles.pickerList}>
                {pickerSessions.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    className={s.active ? `${styles.pickerItem} ${styles.pickerItemActive}` : styles.pickerItem}
                    title={s.key}
                    onClick={() => {
                      openSession(s.key);
                      setPickerOpen(false);
                    }}
                  >
                    <span className={styles.pickerTop}>
                      <span className={styles.pickerName}>{s.title}</span>
                      {s.time && <span className={styles.pickerTime}>{s.time}</span>}
                    </span>
                  </button>
                ))}
              </div>
              {/* 当前会话动作行（S2 从右上角收纳进来——右上角让位给视图切换/面板入口） */}
              <div className={styles.pickerActions}>
                <button
                  type="button"
                  className={styles.pickerAction}
                  title={t("common.refresh")}
                  onClick={() => {
                    onRefresh();
                    setPickerOpen(false);
                  }}
                >
                  <IconClock />
                </button>
                <button
                  type="button"
                  className={styles.pickerAction}
                  title={t("chat.renameSession")}
                  onClick={() => {
                    setPickerOpen(false);
                    startRename();
                  }}
                >
                  <IconPencil />
                </button>
                <button
                  type="button"
                  className={styles.pickerAction}
                  title={t("chat.deleteSession")}
                  onClick={() => {
                    setPickerOpen(false);
                    onDelete();
                  }}
                >
                  <IconArchive />
                </button>
              </div>
            </div>
          </>
        )}
        {/* 重命名浮层（随动作行迁到左上；Electron 不支持 window.prompt，用自己的玻璃输入框） */}
        {renameOpen && (
          <>
            <div className={styles.backdrop} onMouseDown={() => setRenameOpen(false)} />
            <div className={`${styles.renamePop} ${styles.renamePopLeft}`}>
              <div className={styles.renameTitle}>{t("chat.renameSession")}</div>
              <input
                className={styles.renameInput}
                value={renameDraft}
                autoFocus
                placeholder={t("chat.sessionNamePrompt")}
                onChange={(e) => setRenameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.nativeEvent as { isComposing?: boolean }).isComposing) return;
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onRenameSubmit(renameDraft);
                    setRenameOpen(false);
                  }
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setRenameOpen(false);
                  }
                }}
              />
              <div className={styles.renameBtns}>
                <button type="button" className={styles.renameBtn} onClick={() => setRenameOpen(false)}>
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  className={`${styles.renameBtn} ${styles.renameBtnPrimary}`}
                  onClick={() => {
                    onRenameSubmit(renameDraft);
                    setRenameOpen(false);
                  }}
                >
                  {t("common.save")}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      )}

      {/* 右上角：工具 + 退出 */}
      <div className={styles.topright}>
        <button
          type="button"
          className={view === "activity" ? `${styles.tool} ${styles.toolActive}` : styles.tool}
          onClick={() => setView((v) => (v === "chat" ? "activity" : "chat"))}
          title={t("chat.activityToggle")}
        >
          <IconActivity />
        </button>
        <button
          type="button"
          className={overlay === "cron" ? `${styles.tool} ${styles.toolActive}` : styles.tool}
          onClick={() => setOverlay((o) => (o === "cron" ? null : "cron"))}
          title={t("chat.panelCron")}
          disabled={!activeAgentId}
        >
          <IconClock />
        </button>
        <button
          type="button"
          className={overlay === "kanban" ? `${styles.tool} ${styles.toolActive}` : styles.tool}
          onClick={() => setOverlay((o) => (o === "kanban" ? null : "kanban"))}
          title={t("chat.panelKanban")}
          disabled={!activeAgentId}
        >
          <IconBoard />
        </button>
        <button
          type="button"
          className={overlay === "profile" ? `${styles.tool} ${styles.toolActive}` : styles.tool}
          onClick={() => setOverlay((o) => (o === "profile" ? null : "profile"))}
          title={t("chat.panelProfile")}
          disabled={!activeAgentId}
        >
          <IconUser />
        </button>
        <button type="button" className={styles.tool} onClick={onExit} title={t("chat.immersiveExit")} aria-label={t("chat.immersiveExit")}>
          <IconImmersiveExit />
        </button>
      </div>

      {/* 中央：消息流。assistant 卡 = data-glass-panel（WebGL 折射）；user 气泡 = CSS 半透明。
          data-glass-clip：卡片的玻璃背景在本容器边界截断（与 overflow 裁掉的文字同步）。 */}
      {view === "chat" && (
      <div
        className={styles.thread}
        ref={threadRef}
        onScroll={onThreadScroll}
        onWheel={onThreadWheel}
        data-glass-clip
      >
        {messages.length === 0 && (
          <div className={styles.empty}>
            {hasActiveSession ? t("chat.emptyHistory") : t("chat.emptySelect")}
          </div>
        )}
        {messages.map((m) => {
          const kind = m.kind ?? "chat";
          // 封存/模型切换分隔线：安静的一行居中文案
          if (kind === "divider") {
            return (
              <div key={m.id} className={styles.divider}>
                <span className={styles.dividerLabel} title={m.dividerTitle}>{m.dividerLabel}</span>
              </div>
            );
          }
          // 注入伪 user 消息（cron/系统信封）：折叠灰条，点开展开全文
          if (kind === "injected") {
            const open = injectedOpen.has(m.id);
            return (
              <div key={m.id} className={styles.injectedWrap}>
                <button
                  type="button"
                  className={open ? `${styles.sysline} ${styles.syslineOpen}` : styles.sysline}
                  title={open ? t("chat.injectedCollapse") : t("chat.injectedExpand")}
                  aria-expanded={open}
                  onClick={() => toggleInjected(m.id)}
                >
                  <span className={styles.syslineIco}>⚙</span>
                  <span className={styles.syslineText}>{m.injectedHead}</span>
                  <span className={styles.syslineChev}>{open ? "▾" : "▸"}</span>
                </button>
                {open && m.html && (
                  <div className={styles.injectedBody}>
                    <div className={styles.md} dangerouslySetInnerHTML={{ __html: m.html }} />
                  </div>
                )}
                {m.footer && <div className={styles.footer}>{m.footer}</div>}
              </div>
            );
          }
          // 失败轮次：红调卡 + ×N 重复徽标 + hover 原文 + 重试
          if (kind === "error") {
            return (
              <div key={m.id} className={styles.asstRow} onContextMenu={m.onCtx}>
                <div className={styles.errCard} title={m.errorRaw}>
                  <span className={styles.errText}>{m.errorText}</span>
                  {(m.errorRepeat ?? 1) > 1 && (
                    <span className={styles.errRepeat} title={t("chat.repeatedErrors", { count: m.errorRepeat })}>
                      ×{m.errorRepeat}
                    </span>
                  )}
                  {m.onRetry && (
                    <button type="button" className={styles.errRetry} onClick={m.onRetry} title={t("chat.retry")}>
                      ↻
                    </button>
                  )}
                </div>
                {m.footer && <div className={styles.footer}>{m.footer}</div>}
                {actionsFor(m)}
              </div>
            );
          }
          // chat / local
          const files = m.files ?? [];
          const prompts = m.prompts ?? [];
          const attRow =
            m.images.length > 0 || files.length > 0 ? (
              <div className={styles.attRow}>
                {m.images.map((src, i) => (
                  <img key={`i${i}`} className={styles.attThumb} src={src} alt="" onClick={() => openLightbox(src)} />
                ))}
                {files.map((f, i) =>
                  // 视频（带 src）= 可播放预览窗，点击进灯箱；其余 = 文件 chip（与普通模式同规则）
                  f.kind === "video" && f.src ? (
                    <span key={`f${i}`} className={styles.attVideo} title={f.name} onClick={() => openLightbox(f.src as string, "video")}>
                      <video className={styles.attThumb} src={f.src} preload="metadata" muted playsInline />
                      <span className={styles.attPlay}>▶</span>
                    </span>
                  ) : (
                    <button key={`f${i}`} type="button" className={styles.attChip} title={f.name}
                      onClick={() => openAttachmentFile?.(f)} disabled={!openAttachmentFile}>
                      <IconAttachmentFolder /><span className={styles.attName}>{f.name}</span>
                    </button>
                  ),
                )}
              </div>
            ) : null;
          if (m.role === "user") {
            return (
              <div key={m.id} className={styles.userRow} data-user-row="" onContextMenu={m.onCtx}>
                {attRow}
                {m.html && (
                  <div className={styles.userBubble} data-glass-panel>
                    <div className={styles.md} dangerouslySetInnerHTML={{ __html: m.html }} />
                  </div>
                )}
                {m.footer && <div className={styles.footer}>{m.footer}</div>}
                {actionsFor(m)}
              </div>
            );
          }
          return (
            <div key={m.id} className={styles.asstRow} onContextMenu={m.onCtx}>
              {attRow}
              {m.html && (
                <div className={kind === "local" ? `${styles.asstCard} ${styles.localCard}` : styles.asstCard} data-glass-panel>
                  <div className={styles.md} dangerouslySetInnerHTML={{ __html: m.html }} />
                  {m.pending && <span className={styles.cursor} aria-hidden="true" />}
                </div>
              )}
              {prompts.length > 0 && (
                <div className={`${styles.asstCard} ${styles.promptCard}`} data-glass-panel>
                  {prompts.map((p) => (
                    <ChatPromptCard key={p.id} entry={p} onRespond={onRespondPrompt} />
                  ))}
                </div>
              )}
              {m.footer && <div className={styles.footer}>{m.footer}</div>}
              {actionsFor(m)}
            </div>
          );
        })}
        {/* 轻量状态行：本轮有过程信息（思考/工具）时替代三点，点开看详情，完成自动收起 */}
        <ImmersiveStatusLine phase={phase} live={live} />
        {waiting && !live && (
          <div className={styles.asstRow} aria-label={t("chat.generating")}>
            <div className={styles.typing}>
              <span className={styles.typingDot} />
              <span className={styles.typingDot} />
              <span className={styles.typingDot} />
            </div>
          </div>
        )}
        {/* R280 mirror：发送锚定的站位块（高度命令式写入，不进 state） */}
        <div ref={spacerRef} className={styles.spacer} aria-hidden="true" />
      </div>
      )}
      {/* 锚定态的「跳到最新」胶囊 */}
      {/* 聊天列宽拖拽把手：悬停在列右缘浮现细条，拖动改宽（400px ~ 半窗），双击复位默认 */}
      {view === "chat" && (
        <div
          className={colDragging ? `${styles.colHandle} ${styles.colHandleActive}` : styles.colHandle}
          role="separator"
          aria-orientation="vertical"
          title={t("chat.immersiveColResize")}
          onPointerDown={onColDown}
          onPointerMove={onColMove}
          onPointerUp={onColUp}
          onPointerCancel={onColUp}
          onDoubleClick={() => setColW(null)}
        />
      )}

      {view === "chat" && showJump && (
        <button type="button" className={styles.jump} onClick={jumpToLatest} title={t("chat.jumpToLatest")}>
          ↓ {t("chat.jumpToLatest")}
        </button>
      )}

      {/* 今日动态视图：聊天收起成左下胶囊（点击回聊天并聚焦输入框） */}
      {view === "activity" && (
        <>
          <ImmersiveActivityView />
          <button
            type="button"
            className={styles.capsule}
            onClick={() => {
              setView("chat");
              requestAnimationFrame(() => inputElRef.current?.focus());
            }}
          >
            <span className={styles.capsuleText}>
              {input.trim() ? input.trim().split("\n")[0] : t("chat.immersivePlaceholder")}
            </span>
            <span className={styles.capsuleSend} aria-hidden="true">
              <IconSend />
            </span>
          </button>
        </>
      )}

      {/* 当前 agent 面板浮层（cron/kanban/档案，一次一个；Esc 链最先关它） */}
      {overlay && activeAgentId && (
        <ImmersiveOverlay
          title={overlay === "cron" ? t("chat.panelCron") : overlay === "kanban" ? t("chat.panelKanban") : t("chat.panelProfile")}
          onClose={() => setOverlay(null)}
        >
          {overlay === "cron" ? (
            <ImmersiveCronPanel backendId={activeBackendId} agentId={activeAgentId} />
          ) : overlay === "kanban" ? (
            <ImmersiveKanbanPanel backendId={activeBackendId} agentId={activeAgentId} />
          ) : (
            <ImmersiveProfilePanel backendId={activeBackendId} agentId={activeAgentId} avatarVersion={avatarVersion} />
          )}
        </ImmersiveOverlay>
      )}

      {/* 折射玻璃 composer：两行（输入框 + 工具行），对齐 Figma。data-glass-panel 让 WebGL 折射，
          DOM 背景透明；WebGL 不可用时回退 CSS 毛玻璃（fallback）。 */}
      {view === "chat" && (
      <div
        className={failed ? `${styles.composer} ${styles.fallback}` : styles.composer}
        data-glass-panel
        onDrop={supportsAttachments ? onDropFiles : undefined}
        onDragOver={supportsAttachments ? (e) => e.preventDefault() : undefined}
      >
        {slashMenu}
        {quoteText != null && (
          <div className={styles.quoteBar}>
            <span className={styles.quoteIco}>↩</span>
            {/* title = 悬停核对将随消息发出的引用文本（显示层限长 300/600，payload 全文不受影响） */}
            <span
              className={styles.quoteText}
              title={quoteText.length > 600 ? `${quoteText.slice(0, 600)}…` : quoteText}
            >
              {quoteText.length > 300 ? `${quoteText.slice(0, 300)}…` : quoteText}
            </span>
            <button type="button" className={styles.quoteX} title={t("chat.removeQuote")} onClick={clearQuote}>
              ×
            </button>
          </div>
        )}
        {attachments.length > 0 && (
          <div className={styles.pendRow}>
            {attachments.map((a) => (
              <div key={a.id} className={a.kind && a.kind !== "image" && a.kind !== "video" ? styles.pendFile : styles.pendChip}>
                {a.kind && a.kind !== "image" && a.kind !== "video" ? (
                  <button type="button" className={styles.attChip} title={a.name} disabled={!openAttachmentFile}
                    onClick={() => openAttachmentFile?.({ name: a.name, src: a.dataUrl })}>
                    <IconAttachmentFolder /><span className={styles.attName}>{a.name}</span>
                  </button>
                ) : a.kind === "video" ? (
                  <video src={a.dataUrl} title={a.name} preload="metadata" muted playsInline />
                ) : <img src={a.dataUrl} alt={a.name} />}
                <button type="button" className={styles.pendX} onClick={() => removeAttachment(a.id)}
                  title={t("common.remove")} aria-label={`${t("common.remove")} ${a.name}`}>
                  <span aria-hidden="true">{a.kind && a.kind !== "image" && a.kind !== "video" ? "✕" : "×"}</span>
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={inputElRef}
          className={styles.input}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onInputKeyDown}
          onPaste={supportsAttachments ? onInputPaste : undefined}
          placeholder={t("chat.immersivePlaceholder")}
          rows={2}
          disabled={!hasActiveSession}
        />
        <div className={styles.bar}>
          <div className={styles.barLeft}>
            {hasActiveSession && (
              <span className={listLive ? styles.modelWrap : `${styles.modelWrap} ${styles.stale}`}>
                <ChatModelMenu
                  models={models}
                  activeModel={displayModel}
                  activeProvider={activeModelProvider}
                  onSelect={changeModel}
                  loading={modelsLoading}
                  loadError={modelsError}
                  onRefresh={refreshModels}
                  disabled={modelSelectionDisabled}
                />
              </span>
            )}
            <ChatPermissionMenu
              options={permissionOptions}
              activeMode={permissionMode}
              onSelect={(option) => changePermissionMode?.(option)}
              disabled={permissionSelectionDisabled}
              triggerClassName={styles.pill}
              appearance="dark"
            />
            {thinkingLevel && <span className={styles.pillStatic}>{thinkingLevel}</span>}
            {ctxSummary && <span className={`${styles.pillStatic} ${styles.pillCtx}`} title={t("chat.ctxUsage")}>{ctxSummary}</span>}
          </div>
          <div className={styles.barRight}>
            <button type="button" className={listening ? `${styles.iconBtn} ${styles.iconBtnActive}` : styles.iconBtn} onClick={toggleTalk} disabled={!sttSupported} title={sttSupported ? (listening ? t("chat.stopTalk") : t("chat.startTalk")) : t("chat.sttUnsupported")}>
              <IconMic />
            </button>
            {supportsAttachments && (
              <button type="button" className={styles.iconBtn} onClick={onAttachClick} disabled={!hasActiveSession} title={t("chat.attachImage")}>
                <IconClip />
              </button>
            )}
            {sending && canSteer && (
              <button
                type="button"
                className={styles.send}
                data-send-entry="immersiveButton"
                onClick={() => submit()}
                disabled={!hasActiveSession || !canSend || (!input.trim() && attachments.length === 0)}
                title={t(attachments.length ? "chat.send" : "chat.steerCurrentTurn")}
              >
                <IconSend />
              </button>
            )}
            {sending ? (
              <button type="button" className={`${styles.send} ${styles.stop}`} onClick={abortActive} title={t("chat.stopGenerating")}>
                <IconStop />
              </button>
            ) : (
              <button
                type="button"
                className={styles.send}
                data-send-entry="immersiveButton"
                onClick={() => submit()}
                disabled={!hasActiveSession || !canSend || (!input.trim() && attachments.length === 0)}
                title={t("chat.immersiveSend")}
              >
                <IconSend />
              </button>
            )}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

// 悬浮操作条的迷你图标（沉浸层专用；普通模式的同类图标定义在 ChatPage 内部，
// 反向 import 会构成循环依赖，故此处独立一份）。
function IconMiniCopy() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}
function IconMiniPin() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 4h6l-1 7 3 3H7l3-3-1-7z" />
      <path d="M12 14v6" />
    </svg>
  );
}
function IconMiniTrash() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
    </svg>
  );
}
