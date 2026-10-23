import '../i18n/groupCollaborationResources';
import '../i18n/groupComposerResources';
import '../i18n/groupFilesResources';
import { type ClipboardEvent, type KeyboardEvent, type MouseEvent, lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import AgentAvatar from "../components/AgentAvatar";
import ChatFileButton, { ChatFileLabel } from "../components/ChatFileButton";
import GroupChatMarkdown from "./GroupChatMarkdown";
import FusionLoader from "../components/FusionLoader";
import { useConfirm, usePrompt, useToast } from "../components/ui";
import {
  getGroupChat, listGroupChatMessages, lookupGroupChatSend, revealAttachment, respondGroupChatInteraction, retryGroupChatTurn,
  sendGroupChatMessage, stopGroupChatDiscussion, stopGroupChatMember, updateGroupChat, deleteGroupChat,
} from "../api/client";
import ChatPromptCard, { type ChatPromptResponse } from "./ChatPromptCard";
import { IconClip, IconSend, IconStop } from "./chatIcons";
import groupFilesTrigger from "../assets/figma/group-chat/group-files-trigger.svg";
import {
  inspirationMediaLimit, inspirationMediaUrl, MAX_INSPIRATION_ATTACHMENTS, normalizeMediaType, uploadInspirationMedia,
} from "./inspiration-media";
import { onGroupChanged, GROUP_MAX_MEMBERS, type GroupCandidateAgent } from "../lib/groupChat";
import { createGroupPanelObserver } from "../lib/groupPanelObserver";
import type { GroupPanelCache } from "../lib/groupPanelCache";
import { emptyGroupComposer, GroupDraftSession, groupSendJournal, GROUP_CONNECTION_EVENT, GROUP_JOURNAL_CHANGED,
  type GroupComposer, type GroupSendInput, type GroupSendRecord } from "../lib/groupSendJournal";
import GroupChatFullMessage from "./GroupChatFullMessage";
import GroupChatRecovery from "./GroupChatRecovery";
import GroupChatSettings from "./GroupChatSettings";
import GroupChatReference from "./GroupChatReference";
import GroupChatJournalRecovery from "./GroupChatJournalRecovery";
import GroupChatSearch from "./GroupChatSearch";
import { appendGroupReference } from "../lib/groupReferenceExcerpt";
import GroupChatActivity, { boundGroupActivity } from "./GroupChatActivity";
import type { GroupChatMember, GroupChatMessage, GroupChatView, InspirationAttachment } from "../types";
import { groupReplyBody } from "../lib/groupReply";
import { formatChatTime } from "../lib/chatTime";
import { orderGroupTimeline } from "../lib/groupTimeline";
import { ChatMessageContextMenu, ChatPinnedMessages, IconCopy, IconPin, IconTrash, MESSAGE_PINNING_ENABLED } from "./ChatMessageActions";
import ChatResponseMetadata from "./ChatResponseMetadata";
import { useGroupMessagePresentation } from "../lib/groupMessagePresentation";
import styles from "./GroupChatPanel.module.css";

const PAGE = 100;
const GroupChatMemberModal = lazy(() => import('./GroupChatMemberModal'));
const GroupChatAddMemberModal = lazy(() => import('./GroupChatMemberModal').then(module => ({ default: module.GroupChatAddMemberModal })));
const GroupChatDetails = lazy(() => import('./GroupChatDetails'));
const GroupChatFiles = lazy(() => import('./GroupChatFiles'));

// 回合失败原因里有专门说明的那些；其余显示错误码。
const TURN_FAILURE_KEYS: Record<string, string> = {
  GROUP_TURN_INTERACTION_UNSUPPORTED: "groupChat.event.needsInteraction",
  GROUP_TURN_NO_ANSWER: "groupChat.event.noAnswer",
  GROUP_TURN_TIMEOUT: "groupChat.event.timeout",
  RUNTIME_ATTACHMENT_UNSUPPORTED: "groupChat.event.attachmentUnsupported",
  RUNTIME_ATTACHMENT_RECOVERY_REQUIRED: "groupChat.event.attachmentRecoveryRequired",
  GROUP_EXTERNAL_START_UNCONFIRMED: "groupChat.event.unconfirmed",
  GROUP_EXTERNAL_RUN_LOST: "groupChat.event.runLost",
  HERMES_EXECUTION_FAILED: "groupChat.event.backendFailed",
  OPENCLAW_RUN_FAILED: "groupChat.event.backendFailed",
  OPENCLAW_RUN_TIMED_OUT: "groupChat.event.backendFailed",
};

function normalize(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase();
}

// 光标前正在输入的 @词：@ 前是行首、空白或标点，@ 到光标之间没有空白。
function mentionAtCaret(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  const query = before.slice(at + 1);
  if (/\s/u.test(query) || query.length > 32) return null;
  if (at > 0 && /[A-Za-z0-9_.+%/\\-]/u.test(before[at - 1])) return null;
  return { start: at, query };
}

const MAX_MEMBERS = GROUP_MAX_MEMBERS;

// 待发送的附件：选中或粘贴后立刻上传到媒体库，传完才能发送。
type PendingFile = { id: string; name: string; preview: string | null; status: "uploading" | "ready" | "error";
  attachment: InspirationAttachment | null };

function excerptOf(text: string, max = 80) {
  const flat = text.replace(/\s+/gu, " ").trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max).join("")}…`;
}

/** agents：可以加进群的 Agent（聊天页的 Agent 列表），用于「添加成员」。 */
export default function GroupChatPanel({ groupId, agents = [], onArchived, cache, cacheScope }: {
  groupId: string;
  agents?: GroupCandidateAgent[];
  onArchived(): void;
  cache?: GroupPanelCache;
  cacheScope?: string;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const cached = useMemo(() => cache?.get(groupId, cacheScope), [cache, groupId, cacheScope]);
  const ownerEpochRef = useRef(0);
  // Commit the view and its owner epoch together; intermediate renders must not
  // remount old readers under a new epoch before their panels are cleared.
  const [ownedView, setOwnedView] = useState<{ view: GroupChatView | null; epoch: number }>({ view: cached?.view ?? null, epoch: 0 });
  const { view, epoch: ownerEpoch } = ownedView;
  const setView = (next: GroupChatView | null | ((previous: GroupChatView | null) => GroupChatView | null)) => {
    const epoch = ownerEpochRef.current;
    setOwnedView(previous => ({ view: typeof next === "function" ? next(previous.view) : next, epoch }));
  };
  const scopeKey = JSON.stringify([groupId, view?.ownerScope ?? null, ownerEpoch]);
  const presentation = useGroupMessagePresentation(view?.group.id === groupId ? view.ownerScope ?? null : null, groupId);
  const [messageMenu, setMessageMenu] = useState<{ scope: string; x: number; y: number; message: GroupChatMessage } | null>(null);
  const [messageUndo, setMessageUndo] = useState<{ scope: string; id: string } | null>(null);
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [pinIndex, setPinIndex] = useState(0);
  const pinJumpRef = useRef(0);
  const [pinJumpTarget, setPinJumpTarget] = useState<{ scope: string; jump: number; seq: number } | null>(null);
  useEffect(() => { setMessageMenu(null); setMessageUndo(null); setPinnedOnly(false); setPinIndex(0); setPinJumpTarget(null); pinJumpRef.current++; }, [scopeKey]);
  useEffect(() => {
    if (!messageUndo) return;
    const timer = setTimeout(() => setMessageUndo(previous => previous === messageUndo ? null : previous), 6000);
    return () => clearTimeout(timer);
  }, [messageUndo]);
  const pins = presentation.pins.filter(pin => !presentation.hidden.has(pin.id));
  useEffect(() => { if (!pins.length) setPinnedOnly(false); }, [pins.length]);
  const [messages, setMessages] = useState<GroupChatMessage[]>(cached?.messages ?? []);
  const [hasOlder, setHasOlder] = useState(cached?.hasOlder ?? false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [mentionIds, setMentionIds] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [stoppingScope, setStoppingScope] = useState<string | null>(null);
  const stoppingScopeRef = useRef<string | null>(null);
  const deletingScopeRef = useRef<string | null>(null);
  const [deletingScope, setDeletingScope] = useState<string | null>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [cardMemberId, setCardMemberId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [expandedPanel, setExpandedPanel] = useState<"members" | "files" | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 引用回复：发送时带上被引用消息的序号。
  const [replyTo, setReplyTo] = useState<GroupChatMessage | null>(null);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [journalRecoveryOpen, setJournalRecoveryOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [fullMessage, setFullMessage] = useState<GroupChatMessage | null>(null);
  const retryOps = useRef(new Map<number, string>());
  const [files, setFiles] = useState<PendingFile[]>([]);
  const filesRef = useRef(files);
  filesRef.current = files;
  const [lightbox, setLightbox] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const respondOps = useRef(new Map<string, { input: string; id: string }>());
  const lastSeqRef = useRef(0);
  const historyReadyRef = useRef(!!cached);
  const generationRef = useRef(0);
  const currentGroupRef = useRef(groupId);
  currentGroupRef.current = groupId;
  const mountedRef = useRef(false);
  const ownerScopeRef = useRef<string | null>(cached?.view.ownerScope ?? null);
  const observedOwnerRef = useRef<string | null>(null);
  const observerRef = useRef<ReturnType<typeof createGroupPanelObserver> | null>(null);
  const journalObserverRef = useRef<ReturnType<typeof createGroupPanelObserver> | null>(null);
  const mutationRevisionRef = useRef(0);
  const discussionRunningRef = useRef(false);
  const draftSessionRef = useRef<GroupDraftSession | null>(null);
  const [journalReady, setJournalReady] = useState(false);
  const [journalError, setJournalError] = useState<string | null>(null);
  const [sendRecords, setSendRecords] = useState<GroupSendRecord[]>([]);
  const [sendRecordPage, setSendRecordPage] = useState(0);
  const [foreignPending, setForeignPending] = useState(0);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(cached?.lastSyncAt ?? null);
  const verifyingRef = useRef(new Set<string>());
  const listRef = useRef<HTMLDivElement>(null);
  const readingPositionRef = useRef<number | null>(null);
  const stickToBottomRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionMenuId = useId();
  const composerHintId = useId();
  useLayoutEffect(() => {
    if (!pinJumpTarget || pinJumpTarget.scope !== scopeKey || pinJumpTarget.jump !== pinJumpRef.current) return;
    const target = listRef.current?.querySelector(`[data-seq="${pinJumpTarget.seq}"]`);
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    setPinJumpTarget(null);
  }, [messages, pinJumpTarget, scopeKey]);

  const membersById = useMemo(() => new Map((view?.members ?? []).map((member) => [member.id, member])), [view]);
  const activeMembers = useMemo(() => (view?.members ?? []).filter((member) => member.state === "active"), [view]);
  const unavailableMembers = activeMembers.filter(member => member.card?.availability === "offline");

  const append = useCallback((incoming: GroupChatMessage[]) => {
    if (incoming.length === 0) return;
    // 分页游标在 React 批处理 state updater 前同步推进。
    for (const message of incoming) lastSeqRef.current = Math.max(lastSeqRef.current, message.seq);
    setMessages((prev) => {
      const known = new Set(prev.map((message) => message.seq));
      const merged = [...prev, ...incoming.filter((message) => !known.has(message.seq))].sort((a, b) => a.seq - b.seq);
      lastSeqRef.current = merged.at(-1)?.seq ?? lastSeqRef.current;
      return merged;
    });
  }, []);

  const pull = useCallback(() => observerRef.current?.invalidate() ?? Promise.resolve(), []);
  const currentScope = useCallback(() => mountedRef.current && currentGroupRef.current === groupId
    && ownerScopeRef.current === (view?.ownerScope ?? null) && ownerEpochRef.current === ownerEpoch,
  [groupId, view?.ownerScope, ownerEpoch]);
  const applyView = (next: GroupChatView) => {
    if (!currentScope() || next.group.id !== groupId || (next.ownerScope ?? null) !== (view?.ownerScope ?? null)) return;
    mutationRevisionRef.current++;
    setView(next); void pull();
  };

  useLayoutEffect(() => {
    if (view?.group.id === groupId && historyReadyRef.current && lastSyncAt !== null) {
      cache?.put({ view, messages, hasOlder, lastSyncAt });
    }
  }, [cache, groupId, view, messages, hasOlder, lastSyncAt]);

  useEffect(() => {
    mountedRef.current = true;
    ownerEpochRef.current++;
    generationRef.current += 1;
    const generation = generationRef.current;
    setView(cached?.view ?? null);
    setMessages(cached?.messages ?? []);
    setHasOlder(cached?.hasOlder ?? false);
    historyReadyRef.current = !!cached;
    setLoadError(null);
    setSyncError(null); setLastSyncAt(cached?.lastSyncAt ?? null); setJournalReady(false); setJournalError(null); setSendRecords([]); setForeignPending(0);
    draftSessionRef.current = null;
    setSending(false);
    setDraft("");
    setMentionIds([]);
    setReplyTo(null);
    setReferenceOpen(false); setSearchOpen(false); setJournalRecoveryOpen(false);
    setFullMessage(null);
    setAdding(false);
    setSettingsOpen(false);
    setExpandedPanel(null);
    readingPositionRef.current = null;
    for (const file of filesRef.current) if (file.preview) URL.revokeObjectURL(file.preview);
    setFiles([]);
    setLightbox(null);
    lastSeqRef.current = cached?.messages.at(-1)?.seq ?? 0;
    observedOwnerRef.current = cached?.view.ownerScope ?? null;
    ownerScopeRef.current = cached?.view.ownerScope ?? null;
    stickToBottomRef.current = true;
    const observer = createGroupPanelObserver({
      read: async () => {
        const mutationRevision = mutationRevisionRef.current;
        const initialHistory = !historyReadyRef.current;
        const [detail, page] = await Promise.all([getGroupChat(groupId), listGroupChatMessages(groupId,
          initialHistory ? { limit: PAGE } : { afterSeq: lastSeqRef.current, limit: 200 })]);
        if (mutationRevision !== mutationRevisionRef.current) throw new Error("GROUP_PANEL_READ_INVALIDATED");
        if (detail?.group?.id !== groupId || !Array.isArray(page?.messages) || typeof page.hasMore !== "boolean"
          || page.messages.some(message => message?.groupId !== groupId || !Number.isSafeInteger(message.seq) || message.seq <= 0)) {
          throw new Error("Invalid group chat response");
        }
        const nextSeq = page.messages.reduce((last, message) => Math.max(last, message.seq), lastSeqRef.current);
        if (!initialHistory && page.hasMore && nextSeq <= lastSeqRef.current) throw new Error("Invalid group chat response");
        return { detail, page, initialHistory };
      },
      commit: ({ detail, page, initialHistory }) => {
        if (generation !== generationRef.current) return;
        if (observedOwnerRef.current && observedOwnerRef.current !== detail.ownerScope) {
          // Invalidate captured callbacks before React commits the new owner. An
          // A -> B -> A transition must not revive callbacks from the first A.
          ownerEpochRef.current++; ownerScopeRef.current = detail.ownerScope ?? null;
          mutationRevisionRef.current++;
          cache?.delete(groupId); historyReadyRef.current = false;
          observedOwnerRef.current = detail.ownerScope ?? null; lastSeqRef.current = 0; setMessages([]); setHasOlder(false);
          setFullMessage(null); setLightbox(null);
          setSettingsOpen(false); setCardMemberId(null); setAdding(false); setExpandedPanel(null);
          setSearchOpen(false); setReferenceOpen(false); setJournalRecoveryOpen(false);
          setJournalReady(false); draftSessionRef.current = null; setSendRecords([]); setForeignPending(0); setJournalError(null);
          setSending(false); setDraft(""); setMentionIds([]); setMention(null); setReplyTo(null);
          for (const file of filesRef.current) if (file.preview) URL.revokeObjectURL(file.preview);
          setFiles([]); retryOps.current.clear(); respondOps.current.clear();
          setView(detail); void observer.invalidate(); return;
        }
        observedOwnerRef.current = detail.ownerScope ?? null;
        ownerScopeRef.current = detail.ownerScope ?? null;
        historyReadyRef.current = true;
        setView(previous => previous && previous.ownerScope === detail.ownerScope && previous.group.lastSeq > detail.group.lastSeq ? previous : detail);
        setLoadError(null); setSyncError(null); setLastSyncAt(Date.now());
        if (initialHistory) setHasOlder(page.hasMore);
        append(page.messages);
        if (!initialHistory && page.hasMore) void observer.invalidate();
      },
      failed: cause => {
        if (generation !== generationRef.current) return;
        if ((cause as { code?: string })?.code === "GROUP_CHAT_DELETED") { cache?.delete(groupId); onArchived(); return; }
        const error = cause instanceof Error ? cause.message : String(cause);
        setSyncError(error); setLoadError(previous => lastSeqRef.current === 0 ? error : previous);
      },
      visible: () => typeof document === "undefined" || document.visibilityState === "visible",
      active: () => discussionRunningRef.current,
    });
    observerRef.current = observer; void observer.load();
    const off = onGroupChanged(changed => { if (changed === groupId) void observer.invalidate(false); });
    const onRecovery = () => { void observer.invalidate(); };
    const onVisible = () => { if (document.visibilityState === "visible") onRecovery(); };
    if (typeof window !== "undefined") {
      window.addEventListener("online", onRecovery); window.addEventListener("focus", onRecovery);
      window.addEventListener(GROUP_CONNECTION_EVENT, onRecovery);
      document.addEventListener("visibilitychange", onVisible);
    }
    const timer = setInterval(() => observer.check(), 1000);
    return () => {
      mountedRef.current = false; generationRef.current++; observer.dispose(); off(); clearInterval(timer);
      if (observerRef.current === observer) observerRef.current = null;
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onRecovery); window.removeEventListener("focus", onRecovery);
        window.removeEventListener(GROUP_CONNECTION_EVENT, onRecovery);
        document.removeEventListener("visibilitychange", onVisible);
      }
      for (const file of filesRef.current) if (file.preview) URL.revokeObjectURL(file.preview);
    };
  }, [append, groupId, pull, cache, cached]);

  // 事件是旁路通知：讨论进行中再加一层慢轮询，断线时状态也能前进。
  const discussionRunning = view?.group.status === "deleting" || Boolean(view?.round) || (view?.activeTurns ?? []).length > 0
    || (view?.queuedMemberIds ?? []).length > 0 || (view?.pendingInteractions ?? []).length > 0;
  discussionRunningRef.current = discussionRunning;
  const stoppingTurns = (view?.activeTurns ?? []).filter(turn => turn.stopping || turn.recovery?.cancelRequested);
  const canStopDiscussion = Boolean(view?.round) || (view?.queuedMemberIds.length ?? 0) > 0
    || (view?.activeTurns ?? []).some(turn => !turn.stopping && !turn.recovery?.cancelRequested);
  const stopPending = stoppingScope === scopeKey;

  const applyComposer = useCallback((composer: GroupComposer) => {
    setDraft(composer.text); setMentionIds(composer.mentionIds); setReplyTo(composer.replyTo);
    setFiles(composer.files.map(file => ({ ...file, status: file.status === "uploading" ? "error" : file.status,
      preview: file.attachment?.mimeType.startsWith("image/") ? inspirationMediaUrl(file.attachment.id, true) : null })));
  }, []);
  const ownerScope = view?.ownerScope ?? null;
  const replyAttachments = replyTo?.attachments ?? messages.find(message => message.groupId === groupId
    && message.id === replyTo?.id && message.seq === replyTo.seq)?.attachments;
  const composer: GroupComposer = { text: draft, mentionIds, replyTo: replyTo ? { id: replyTo.id, groupId: replyTo.groupId,
    seq: replyTo.seq, threadId: replyTo.threadId, author: replyTo.author, body: excerptOf(replyTo.body, 600),
    mentions: replyTo.mentions, createdAt: replyTo.createdAt, origin: replyTo.origin, attachments: replyAttachments } : null,
    replyTask: null, requestRef: null, newRequest: false, summaryMemberId: "",
    files: files.map(({ id, name, status, attachment }) => ({ id, name, status, attachment })) };
  const composerSignature = JSON.stringify(composer);
  if (journalReady) draftSessionRef.current?.update(composer);
  useEffect(() => {
    const session = draftSessionRef.current, generation = generationRef.current;
    if (!journalReady || !session) return;
    void session.persist().then(() => {
      if (currentScope() && generation === generationRef.current && draftSessionRef.current === session) setJournalError(null);
    }, cause => { if (currentScope() && generation === generationRef.current && draftSessionRef.current === session) setJournalError(cause instanceof Error ? cause.message : String(cause)); });
  }, [journalReady, composerSignature, currentScope]);

  const refreshSendRecords = useCallback(async () => {
    if (!ownerScope || !currentScope()) return;
    const generation = generationRef.current;
    try {
      const state = await groupSendJournal.read(ownerScope, groupId);
      if (currentScope() && generation === generationRef.current) { setSendRecords(state.sends.filter(record => record.phase !== "observed")); setForeignPending(state.foreignPending); }
    } catch (cause) { if (currentScope() && generation === generationRef.current) setJournalError(cause instanceof Error ? cause.message : String(cause)); }
  }, [groupId, ownerScope, currentScope]);
  useEffect(() => {
    if (!ownerScope) return;
    const generation = generationRef.current;
    let disposed = false;
    setJournalReady(false); setSending(false); draftSessionRef.current = null;
    const observer = createGroupPanelObserver({
      read: () => groupSendJournal.read(ownerScope, groupId),
      commit: state => {
        if (disposed || !currentScope() || generation !== generationRef.current) return;
        if (!draftSessionRef.current || draftSessionRef.current.ownerScope !== ownerScope || draftSessionRef.current.groupId !== groupId) {
          const session = new GroupDraftSession(ownerScope, groupId, state.draft);
          draftSessionRef.current = session; applyComposer(session.composer);
        }
        setSendRecords(state.sends.filter(record => record.phase !== "observed")); setForeignPending(state.foreignPending); setJournalReady(true);
        setJournalError(draftSessionRef.current.lastError);
      },
      failed: cause => { if (!disposed && currentScope() && generation === generationRef.current) setJournalError(cause instanceof Error ? cause.message : String(cause)); },
    });
    journalObserverRef.current = observer; void observer.load();
    const changed = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.groupId === groupId) void refreshSendRecords();
    };
    const recover = () => { void observer.invalidate(); };
    if (typeof window !== "undefined") {
      window.addEventListener(GROUP_JOURNAL_CHANGED, changed); window.addEventListener("focus", recover);
      window.addEventListener("online", recover); window.addEventListener(GROUP_CONNECTION_EVENT, recover);
    }
    return () => {
      disposed = true; observer.dispose(); if (journalObserverRef.current === observer) journalObserverRef.current = null;
      if (typeof window !== "undefined") {
        window.removeEventListener(GROUP_JOURNAL_CHANGED, changed); window.removeEventListener("focus", recover);
        window.removeEventListener("online", recover); window.removeEventListener(GROUP_CONNECTION_EVENT, recover);
      }
    };
  }, [applyComposer, groupId, ownerScope, refreshSendRecords, currentScope]);

  // 动态、草稿和交互卡都属于消息流；只有用户仍在底部时才跟随新的内容。
  const activitySignature = JSON.stringify([
    (view?.activeTurns ?? []).map(turn => [turn.opportunityId, turn.draft?.length, turn.activity?.eventSeq,
      turn.activity?.phase, turn.stopping, turn.recovery, turn.released]),
    (view?.pendingInteractions ?? []).map(item => [item.opportunityId, item.request.requestId, item.status]),
    view?.queuedMemberIds, view?.round?.id,
  ]);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && expandedPanel === null) {
      if (stickToBottomRef.current) list.scrollTop = list.scrollHeight;
      else if (readingPositionRef.current !== null) list.scrollTop = readingPositionRef.current;
      readingPositionRef.current = null;
    }
  }, [messages, activitySignature, expandedPanel]);

  const loadOlder = async () => {
    const generation = generationRef.current;
    const scope = ownerScopeRef.current;
    const first = messages[0]?.seq;
    if (first === undefined) return;
    const list = listRef.current;
    const previousHeight = list?.scrollHeight ?? 0;
    try {
      const page = await listGroupChatMessages(groupId, { beforeSeq: first, limit: PAGE });
      if (!currentScope() || generation !== generationRef.current || ownerScopeRef.current !== scope) return;
      stickToBottomRef.current = false;
      setHasOlder(page.hasMore);
      setMessages((prev) => [...page.messages.filter((message) => message.seq < first), ...prev]);
      requestAnimationFrame(() => { if (list) list.scrollTop = list.scrollHeight - previousHeight; });
    } catch (cause) {
      if (currentScope() && generation === generationRef.current && ownerScopeRef.current === scope) toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const candidates = useMemo(() => {
    if (!mention) return [];
    const query = normalize(mention.query);
    return activeMembers.filter((member) => normalize(member.handle).includes(query)
      || normalize(member.displayName).includes(query));
  }, [activeMembers, mention]);

  const updateDraft = (value: string, caret: number) => {
    setDraft(value);
    const next = mentionAtCaret(value, caret);
    setMention(next);
    setMentionIndex(0);
  };

  const openMentions = () => {
    const caret = textareaRef.current?.selectionStart ?? draft.length;
    const end = textareaRef.current?.selectionEnd ?? caret;
    const current = mentionAtCaret(draft, caret);
    if (current) { setMention(current); setMentionIndex(0); textareaRef.current?.focus(); return; }
    const insert = `${caret > 0 && !/\s/u.test(draft[caret - 1]) ? " " : ""}@`;
    updateDraft(draft.slice(0, caret) + insert + draft.slice(end), caret + insert.length);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(caret + insert.length, caret + insert.length);
    });
  };

  const pickMention = (member: GroupChatMember) => {
    if (!mention) return;
    const caret = textareaRef.current?.selectionStart ?? draft.length;
    const insert = `@${member.handle} `;
    const value = draft.slice(0, mention.start) + insert + draft.slice(caret);
    setDraft(value);
    setMentionIds((prev) => prev.includes(member.id) ? prev : [...prev, member.id]);
    setMention(null);
    requestAnimationFrame(() => {
      const position = mention.start + insert.length;
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(position, position);
    });
  };

  const removeFile = (id: string) => setFiles((prev) => {
    const file = prev.find((item) => item.id === id);
    if (file?.preview) URL.revokeObjectURL(file.preview);
    return prev.filter((item) => item.id !== id);
  });
  const addFiles = (picked: File[]) => {
    const generation = generationRef.current;
    const draftId = draftSessionRef.current?.draftId;
    for (const file of picked) {
      if (filesRef.current.length >= MAX_INSPIRATION_ATTACHMENTS) {
        toast.error(t("groupChat.attach.tooMany", { count: MAX_INSPIRATION_ATTACHMENTS }));
        break;
      }
      const mimeType = normalizeMediaType(file.type, file.name);
      const limit = inspirationMediaLimit(mimeType);
      if (file.size === 0 || file.size > limit) {
        toast.error(file.size === 0 ? t("groupChat.attach.empty", { name: file.name })
          : t("chat.attachTooLarge", { name: file.name, limit: `${Math.round(limit / 1024 / 1024)}MB` }));
        continue;
      }
      const id = crypto.randomUUID();
      const pending: PendingFile = { id, name: file.name, status: "uploading", attachment: null,
        preview: mimeType.startsWith("image/") ? URL.createObjectURL(file) : null };
      filesRef.current = [...filesRef.current, pending];
      setFiles(filesRef.current);
      // 换了群或移除了这个文件就停止上传。
      const alive = () => currentScope() && generation === generationRef.current && draftSessionRef.current?.draftId === draftId
        && filesRef.current.some((item) => item.id === id);
      void uploadInspirationMedia(file, id, alive, mimeType).then((attachment) => {
        if (attachment && alive()) setFiles((prev) => prev.map((item) => item.id === id ? { ...item, status: "ready", attachment } : item));
      }, (cause) => {
        if (!alive()) return;
        setFiles((prev) => prev.map((item) => item.id === id ? { ...item, status: "error" } : item));
        toast.error(cause instanceof Error ? cause.message : String(cause));
      });
    }
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = Array.from(event.clipboardData?.items ?? []).filter((item) => item.kind === "file")
      .map((item) => item.getAsFile()).filter((file): file is File => !!file);
    if (pasted.length === 0) return;
    event.preventDefault();
    addFiles(pasted);
  };
  const filesBusy = files.some((file) => file.status !== "ready");
  const sameDraftPending = sendRecords.some(record => record.draftId === draftSessionRef.current?.draftId
    && record.draftRevision === draftSessionRef.current?.revision);
  const send = async () => {
    const body = draft.trim();
    const attachments = files.flatMap((file) => file.attachment ? [file.attachment] : []);
    const session = draftSessionRef.current;
    if (!currentScope() || (!body && attachments.length === 0) || filesBusy || sending || !view || view.group.status !== "active"
      || !journalReady || !session || !ownerScope || session.ownerScope !== ownerScope) return;
    const mentions = mentionIds.filter((id) => {
      const member = membersById.get(id);
      return member && body.includes(`@${member.handle}`);
    });
    const generation = generationRef.current;
    setSending(true);
    try {
      const snapshot = await session.persist();
      const prior = (await groupSendJournal.read(ownerScope, groupId)).sends.find(record => record.draftId === snapshot.draftId
        && record.draftRevision === snapshot.revision && record.phase !== "observed");
      if (!currentScope()) return;
      if (prior) { if (generation === generationRef.current) setSendRecords(previous => [prior, ...previous.filter(row => row.key !== prior.key)]); return; }
      const input: GroupSendInput = { clientMessageId: crypto.randomUUID(), body, mentions,
        replyTo: replyTo?.seq ?? null, attachments, ownerScope, expectedPolicyVersion: view.group.policyVersion };
      const record = await groupSendJournal.prepare(ownerScope, groupId, input, snapshot);
      await dispatchRecord(record, session, generation);
    } catch (cause) {
      if (currentScope() && generation === generationRef.current) { setJournalError(cause instanceof Error ? cause.message : String(cause)); toast.error(cause instanceof Error ? cause.message : String(cause)); }
    } finally {
      if (currentScope() && generation === generationRef.current) { setSending(false); void refreshSendRecords(); }
    }
  };

  const acceptRecord = async (record: GroupSendRecord, message: GroupChatMessage, discussionId: string | null,
    session: GroupDraftSession | null, generation: number) => {
    const consumed = session?.ownerScope === record.ownerScope && session.groupId === record.groupId
      ? await session.accepted(record, message, discussionId)
      : (await groupSendJournal.accepted(record, message, discussionId), false);
    if (!currentScope() || generation !== generationRef.current || currentGroupRef.current !== record.groupId
      || ownerScopeRef.current !== record.ownerScope) return;
    mutationRevisionRef.current++;
    if (consumed && draftSessionRef.current === session) {
      for (const file of filesRef.current) if (file.preview) URL.revokeObjectURL(file.preview);
      applyComposer(emptyGroupComposer()); setMention(null);
    }
    stickToBottomRef.current = true; append([message]); void pull();
  };
  const dispatchRecord = async (record: GroupSendRecord, session: GroupDraftSession | null, generation: number) => {
    if (!currentScope()) return;
    let submitting = await groupSendJournal.update(record, { phase: "submitting", lastError: null });
    if (submitting.phase === "observed" || !currentScope()) return;
    try {
      const result = await sendGroupChatMessage(record.groupId, record.inputSnapshot);
      submitting = await groupSendJournal.update(submitting, { phase: "accepted_awaiting_echo", acceptedMessageId: result.message.id,
        acceptedSeq: result.message.seq, discussionId: result.discussionId, lastCheckedAt: Date.now() });
      await acceptRecord(submitting, result.message, result.discussionId, session, generation);
    } catch (cause) {
      const code = (cause as { code?: string })?.code;
      const refused = ["GROUP_CHAT_INVALID", "GROUP_CHAT_NOT_FOUND", "GROUP_CHAT_ARCHIVED", "GROUP_CHAT_MESSAGE_CONFLICT",
        "GROUP_CHAT_POLICY_CONFLICT", "GROUP_CHAT_POLICY_CHANGED", "GROUP_CHAT_OWNER_CHANGED", "GROUP_CHAT_REPLY_NOT_FOUND",
        "GROUP_CHAT_MEMBER_NOT_FOUND"].includes(code ?? "");
      await groupSendJournal.update(submitting, { phase: refused ? "rejected" : "needs_verification",
        lastError: cause instanceof Error ? cause.message : String(cause), lastCheckedAt: Date.now() });
      if (currentScope() && generation === generationRef.current) toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const verifyRecord = useCallback(async (record: GroupSendRecord) => {
    if (!currentScope() || record.groupId !== currentGroupRef.current || record.ownerScope !== ownerScopeRef.current) return;
    if (verifyingRef.current.has(record.key)) return;
    verifyingRef.current.add(record.key);
    const generation = generationRef.current;
    try {
      const found = await lookupGroupChatSend(record.groupId, { clientMessageId: record.clientMessageId,
        payloadDigest: record.payloadDigest, ownerScope: record.ownerScope });
      if (found.ownerScope !== record.ownerScope || found.groupId !== record.groupId || found.clientMessageId !== record.clientMessageId) {
        throw new Error("GROUP_SEND_LOOKUP_IDENTITY_MISMATCH");
      }
      if (found.status === "found") {
        if (found.payloadMatches !== true || found.payloadDigest !== record.payloadDigest || !found.message) throw new Error("GROUP_SEND_PAYLOAD_CONFLICT");
        await acceptRecord(record, found.message, found.discussionId, draftSessionRef.current, generation);
      } else {
        await groupSendJournal.update(record, { phase: "needs_verification", lastCheckedAt: Date.now(),
          lastError: found.status === "not_found" ? "GROUP_SEND_NOT_FOUND" : found.reason ?? "GROUP_SEND_LOOKUP_UNKNOWN" });
      }
    } catch (cause) {
      await groupSendJournal.update(record, { phase: "needs_verification", lastCheckedAt: Date.now(), lastError: cause instanceof Error ? cause.message : String(cause) })
        .catch(() => {});
    } finally { verifyingRef.current.delete(record.key); if (currentScope() && generation === generationRef.current) void refreshSendRecords(); }
  }, [append, applyComposer, pull, refreshSendRecords, currentScope]);
  useEffect(() => {
    if (!journalReady) return;
    let disposed = false;
    // Recovery checks originals only. Neither prepared nor uncertain entries are replayed.
    const check = () => {
      void groupSendJournal.read(ownerScope!, groupId).then(async state => {
        if (disposed || !currentScope()) return;
        const pending = state.sends.filter(record => record.phase !== "observed" && record.phase !== "rejected");
        let index = 0;
        await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
          while (!disposed && currentScope() && index < pending.length) await verifyRecord(pending[index++]);
        }));
      }).catch(() => {});
    };
    check();
    const off = onGroupChanged(changed => { if (changed === groupId) check(); });
    if (typeof window !== "undefined") { window.addEventListener("online", check); window.addEventListener("focus", check); window.addEventListener(GROUP_CONNECTION_EVENT, check); }
    return () => { disposed = true; off(); if (typeof window !== "undefined") { window.removeEventListener("online", check); window.removeEventListener("focus", check); window.removeEventListener(GROUP_CONNECTION_EVENT, check); } };
  }, [groupId, journalReady, ownerScope, verifyRecord, currentScope]);
  const retrySend = async (record: GroupSendRecord) => {
    if (!currentScope() || sending || !view || view.group.status !== "active" || view.ownerScope !== record.ownerScope || !journalReady) return;
    const generation = generationRef.current; setSending(true);
    try { await dispatchRecord(record, draftSessionRef.current, generation); }
    catch (cause) { if (currentScope() && generation === generationRef.current) setJournalError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (currentScope() && generation === generationRef.current) { setSending(false); void refreshSendRecords(); } }
  };
  const sendAsNew = async (record: GroupSendRecord) => {
    if (!currentScope() || sending || !view || view.group.status !== "active" || view.ownerScope !== record.ownerScope || !journalReady) return;
    const generation = generationRef.current; setSending(true);
    try {
      const newComposer = { ...record.composerSnapshot, replyTask: null, requestRef: null, newRequest: false, summaryMemberId: "" };
      const snapshot = await groupSendJournal.saveComposer(record.ownerScope, record.groupId, crypto.randomUUID(), 0, newComposer, 0, true);
      if (!currentScope()) return;
      const { taskId: _taskId, discussionId: _discussionId, requestMode: _requestMode, summaryMemberId: _summary, ...original } = record.inputSnapshot;
      const input: GroupSendInput = { ...original, clientMessageId: crypto.randomUUID(), expectedPolicyVersion: view.group.policyVersion };
      const prepared = await groupSendJournal.prepare(record.ownerScope, record.groupId, input, snapshot);
      await dispatchRecord(prepared, null, generation);
    } catch (cause) { if (currentScope() && generation === generationRef.current) setJournalError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (currentScope() && generation === generationRef.current) { setSending(false); void refreshSendRecords(); } }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (mention && candidates.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + candidates.length) % candidates.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pickMention(candidates[Math.min(mentionIndex, candidates.length - 1)]);
        return;
      }
      if (event.key === "Escape") { event.preventDefault(); setMention(null); return; }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const run = async (action: () => Promise<GroupChatView>) => {
    if (!currentScope()) return;
    mutationRevisionRef.current++;
    try { applyView(await action()); } catch (cause) {
      if (currentScope()) toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const stopDiscussion = async () => {
    if (!currentScope() || !canStopDiscussion || stoppingScopeRef.current === scopeKey) return;
    stoppingScopeRef.current = scopeKey; setStoppingScope(scopeKey);
    mutationRevisionRef.current++;
    try { applyView(await stopGroupChatDiscussion(groupId)); }
    catch (cause) {
      if (currentScope()) { toast.error(cause instanceof Error ? cause.message : String(cause)); void pull(); }
    } finally {
      if (stoppingScopeRef.current === scopeKey) {
        stoppingScopeRef.current = null;
        if (currentScope()) setStoppingScope(null);
      }
    }
  };
  const rename = async () => {
    if (!view) return;
    const name = await prompt({ title: t("groupChat.rename"), defaultValue: view.group.name, required: true });
    if (!name || name.trim() === view.group.name) return;
    await run(() => updateGroupChat(groupId, { expectedMetadataRevision: view.group.metadataRevision, patch: { name: name.trim() } }));
  };
  const removeGroup = async () => {
    if (!view || deletingScopeRef.current === scopeKey || view.group.status === "deleting") return;
    const ok = await confirm({ title: t("groupChat.delete"), message: t("groupChat.deleteConfirm"), danger: true });
    if (!ok || !currentScope()) return;
    deletingScopeRef.current = scopeKey; setDeletingScope(scopeKey); mutationRevisionRef.current++;
    try {
      const result = await deleteGroupChat(groupId, view.group.metadataRevision);
      if (!currentScope()) return;
      mutationRevisionRef.current++;
      cache?.delete(groupId);
      if (result.status === "deleted") onArchived();
      else { setView(previous => previous && ({ ...previous, group: { ...previous.group, status: "deleting" } })); void pull(); }
    } catch (cause) {
      if (currentScope()) { toast.error(cause instanceof Error ? cause.message : String(cause)); void pull(); }
    } finally {
      if (deletingScopeRef.current === scopeKey) { deletingScopeRef.current = null; if (currentScope()) setDeletingScope(null); }
    }
  };

  const systemText = (message: GroupChatMessage) => {
    const system = message.system;
    const who = (id?: string) => (id && membersById.get(id)?.displayName) || t("groupChat.someMember");
    if (system?.eventType === "renamed") return t("groupChat.event.renamed", { name: system.name });
    if (system?.eventType === "member_added") return t("groupChat.event.memberAdded", { name: who(system.memberId) });
    if (system?.eventType === "member_removed") return t("groupChat.event.memberRemoved", { name: who(system.memberId) });
    if (system?.eventType === "turn_failed") {
      const key = TURN_FAILURE_KEYS[system.errorCode ?? ""] ?? "groupChat.event.turnFailed";
      return t(key, { name: who(system.memberId), code: system.errorCode ?? "" });
    }
    if (system?.eventType === "turn_stopped") return t("groupChat.event.turnStopped", { name: who(system.memberId) });
    if (system?.eventType === "work_done") return t("groupChat.event.workDone", { name: who(system.memberId) });
    if (system?.eventType === "session_renewed") return t("groupChat.event.sessionRenewed", { name: who(system.memberId) });
    return t("groupChat.event.updated");
  };

  if (loadError && !view) return <div className={styles.panel}><div className={styles.empty} role="status">{t("groupChat.sync.recovering")} · {loadError}
    <button type="button" className="btn-sm" onClick={() => void pull()}>{t("groupChat.sync.check")}</button></div></div>;
  if (!view) return <div className={styles.panel}><div className={styles.empty}><FusionLoader size="sm" /></div></div>;

  const respond = async (opportunityId: string, requestId: string, response: ChatPromptResponse) => {
    if (!currentScope()) return;
    // 同一份回应重试时沿用同一个操作 id，服务端据此去重。
    const key = opportunityId, target = { kind: "turn" as const, opportunityId };
    const input = JSON.stringify([key, requestId, response]);
    const prior = respondOps.current.get(key);
    const operation = prior?.input === input ? prior : { input, id: crypto.randomUUID() };
    respondOps.current.set(key, operation);
    try {
      applyView(await respondGroupChatInteraction(groupId, { target, requestId,
        response: response as Record<string, unknown>, operationId: operation.id }));
    } catch (cause) {
      if (!currentScope()) return;
      toast.error(cause instanceof Error ? cause.message : String(cause));
      void pull();
      throw cause;
    }
  };
  // History and active state are separate reads. A published final settles its
  // exact member/turn even if an older view still includes it. Partial speech
  // only releases the floor; it must not hide work continuing in the background.
  const settledTurnMembers = new Map<string, string>();
  for (const message of messages) {
    if (message.author.kind === "member" && message.origin?.opportunityId && !message.origin.partial) {
      settledTurnMembers.set(message.origin.opportunityId, message.author.memberId);
    }
  }
  const interactions = (view.pendingInteractions ?? [])
    .filter(item => settledTurnMembers.get(item.opportunityId) !== item.memberId);
  const speaking = view.activeTurns.flatMap((turn) => {
    const member = membersById.get(turn.memberId);
    return member && settledTurnMembers.get(turn.opportunityId) !== turn.memberId ? [{ turn, member }] : [];
  });
  const answering = speaking.filter((item) => {
    const phase = boundGroupActivity(item.turn.activity, { groupId, memberId: item.member.id, opportunityId: item.turn.opportunityId })?.phase;
    return item.turn.dispatchState !== "queued" && !item.turn.recovery && !item.turn.stopping
      && !["queued", "preparing", "reconciling", "stopping", "completed", "failed", "cancelled", "waiting_approval", "waiting_input"].includes(phase ?? "")
      && !interactions.some(interaction => interaction.opportunityId === item.turn.opportunityId && interaction.status === "pending");
  });
  const speakingIds = new Set(speaking.map((item) => item.member.id));
  const queued = view.queuedMemberIds.map((id) => membersById.get(id)?.displayName).filter(Boolean);
  const archived = view.group.status !== "active";
  const timeline = orderGroupTimeline([
    ...messages.filter(message => message.author.kind === "system" || (!presentation.hidden.has(message.id)
      && (!MESSAGE_PINNING_ENABLED || !pinnedOnly || pins.some(pin => pin.id === message.id))))
      .map(message => ({ key: `message:${message.id}`, kind: "message" as const, message, seq: message.seq, createdAt: message.createdAt })),
    ...speaking.map(({ turn, member }) => ({ key: `turn:${turn.opportunityId}`, kind: "turn" as const, turn, member,
      createdAt: turn.startedAt ?? 0 })),
    ...interactions.map(item => ({ key: `interaction:${item.request.requestId}`, kind: "interaction" as const, item, createdAt: item.occurredAt })),
  ]);
  // 每位成员最近一次的结果（发言或失败）：只有「最近一次是失败」的那一行才给重试。
  const latestOutcome = new Map<string, number>();
  for (const message of messages) {
    const memberId = message.author.kind === "member" ? message.author.memberId
      : message.system?.eventType === "turn_failed" ? message.system.memberId : undefined;
    if (memberId) latestOutcome.set(memberId, message.seq);
  }
  const canRetry = (message: GroupChatMessage) => {
    const memberId = message.system?.eventType === "turn_failed" ? message.system.memberId : undefined;
    return !!memberId && !archived && latestOutcome.get(memberId) === message.seq
      && membersById.get(memberId)?.state === "active" && !speakingIds.has(memberId)
      && !view.queuedMemberIds.includes(memberId);
  };
  const retry = async (message: GroupChatMessage) => {
    // 同一行的重试沿用同一个操作 id，服务端只生效一次。
    const operationId = retryOps.current.get(message.seq) ?? crypto.randomUUID();
    retryOps.current.set(message.seq, operationId);
    await run(() => retryGroupChatTurn(groupId, message.system!.memberId!, operationId));
  };
  const authorName = (author: GroupChatMessage["author"]) => author.kind === "user" ? t("groupChat.you")
    : author.kind === "member" ? membersById.get(author.memberId)?.displayName ?? t("groupChat.someMember") : "";
  const quote = (message: GroupChatMessage) => { if (!journalReady || archived || !currentScope()) return; setReplyTo(message); requestAnimationFrame(() => { if (currentScope()) textareaRef.current?.focus(); }); };
  const jumpTo = (seq: number) => listRef.current?.querySelector(`[data-seq="${seq}"]`)
    ?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  const openMessageMenu = (event: MouseEvent, message: GroupChatMessage) => {
    if (!currentScope()) return;
    event.preventDefault(); event.stopPropagation();
    setMessageMenu({ scope: scopeKey, x: event.clientX, y: event.clientY, message });
  };
  const messageText = (message: GroupChatMessage) => message.author.kind === "member" ? groupReplyBody(message) : message.body;
  const copyMessage = async (message: GroupChatMessage) => {
    if (!currentScope()) return;
    const text = messageText(message);
    try {
      await navigator.clipboard.writeText(text);
      if (currentScope()) toast.success(t("chat.copied"));
    } catch { if (currentScope()) toast.error(t("chat.copyFailed")); }
  };
  const pinMessage = (message: GroupChatMessage) => {
    if (!currentScope()) return;
    if (presentation.pins.some(pin => pin.id === message.id)) presentation.unpin(message.id);
    else {
      presentation.pin({ id: message.id, seq: message.seq,
        text: excerptOf(messageText(message) || message.attachments?.map(item => item.name).join(" · ") || "", 160) });
      setPinIndex(pins.filter(pin => pin.seq < message.seq).length);
    }
  };
  const hideMessage = (message: GroupChatMessage) => {
    if (!currentScope()) return;
    presentation.hide(message.id); setMessageUndo({ scope: scopeKey, id: message.id });
  };
  const messageFooter = (message: GroupChatMessage) => {
    const pinned = presentation.pins.some(pin => pin.id === message.id);
    return <div className="chat-group__footer" data-group-message-footer={message.id}>
      {message.createdAt ? <time data-group-message-time={message.id} dateTime={new Date(message.createdAt).toISOString()}>{formatChatTime(message.createdAt)}</time> : null}
      {message.author.kind === "member" && <ChatResponseMetadata metadata={message.responseMetadata} />}
      {messageText(message).trim() && <button type="button" className="chat-copybtn" title={t("chat.copyAsMarkdown")}
        aria-label={t("chat.copyAsMarkdown")} onClick={() => void copyMessage(message)}><IconCopy /></button>}
      {MESSAGE_PINNING_ENABLED && <button type="button" className={pinned ? "chat-copybtn is-pinned" : "chat-copybtn"}
        title={t(pinned ? "chat.unpin" : "chat.pin")} aria-label={t(pinned ? "chat.unpin" : "chat.pin")}
        aria-pressed={pinned} onClick={() => pinMessage(message)}><IconPin /></button>}
      <button type="button" className="chat-copybtn" title={t("chat.deleteLocal")} aria-label={t("chat.deleteLocal")}
        onClick={() => hideMessage(message)}><IconTrash /></button>
    </div>;
  };
  const jumpToPin = async (id: string) => {
    const pin = pins.find(pin => pin.id === id);
    if (!pin || !currentScope()) return;
    const generation = generationRef.current, jump = ++pinJumpRef.current;
    const alive = () => currentScope() && generationRef.current === generation && pinJumpRef.current === jump;
    stickToBottomRef.current = false;
    let before = messages[0]?.seq, more = hasOlder;
    let found = messages.some(message => message.id === id);
    try {
      while (!found && more && before !== undefined && pin.seq < before) {
        const page = await listGroupChatMessages(groupId, { beforeSeq: before, limit: PAGE });
        if (!alive()) return;
        if (typeof page.hasMore !== "boolean" || page.messages.some(message => message.groupId !== groupId || !Number.isSafeInteger(message.seq) || message.seq <= 0 || message.seq >= before!)
          || (page.hasMore && !page.messages.length)) throw new Error(t("chat.pinnedMessageUnavailable"));
        setMessages(previous => {
          const known = new Set(previous.map(message => message.id));
          return [...previous, ...page.messages.filter(message => !known.has(message.id))].sort((a, b) => a.seq - b.seq);
        });
        setHasOlder(page.hasMore); more = page.hasMore;
        found = page.messages.some(message => message.id === id);
        before = page.messages[0]?.seq;
      }
      if (!alive()) return;
      if (!found) { toast.error(t("chat.pinnedMessageUnavailable")); return; }
      setPinJumpTarget({ scope: scopeKey, jump, seq: pin.seq });
    } catch (cause) { if (alive()) toast.error(cause instanceof Error ? cause.message : String(cause)); }
  };
  const quotePreview = (text: string, attachments: InspirationAttachment[] = []) => {
    const photos = attachments.filter(item => item.mimeType.startsWith("image/"));
    const caption = excerptOf(text, 120) || attachments.filter(item => !item.mimeType.startsWith("image/"))
      .map(item => item.name).join("、");
    return <span className={styles.quotePreview}>
      {photos.length > 0 && <span className={styles.quoteImages}>
        {photos.map(item => <img key={item.id} className={styles.quoteThumb}
          src={inspirationMediaUrl(item.id, true)} alt={item.name} />)}
      </span>}
      {caption && <span className={styles.quoteExcerpt}>{caption}</span>}
    </span>;
  };
  const quoteBlock = (message: GroupChatMessage) => {
    const reply = message.replyTo;
    if (!reply) return null;
    const attachments = reply.attachments ?? messages.find(source => source.groupId === groupId
      && source.id === reply.messageId && source.seq === reply.seq)?.attachments;
    return <button type="button" className={styles.quoteBlock} title={t("groupChat.reply.jump")}
      onClick={() => jumpTo(reply.seq)}>
      <span className={styles.quoteAuthor}>{authorName(reply.author)}</span>
      {quotePreview(reply.excerpt, attachments)}
    </button>;
  };
  // 消息里的附件：样式与单聊一致（图片缩略图点开大图，其余是文件条）。
  const attachmentRow = (message: GroupChatMessage) => message.attachments && message.attachments.length > 0 && (
    <div className="chat-att-row">
      {message.attachments.map((item) => item.mimeType.startsWith("image/") ? (
        <img key={item.id} className="chat-att-thumb" src={inspirationMediaUrl(item.id, true)} alt={item.name}
          onClick={() => setLightbox(inspirationMediaUrl(item.id, true))} />
      ) : (
        <ChatFileButton key={item.id} name={item.name}
          title={`${t("chat.artifactsRevealInFolder")} · ${item.name}`}
          onClick={() => void revealAttachment(item.name, inspirationMediaUrl(item.id))
            .catch((cause) => toast.error(t("chat.artifactsRevealFailed", { msg: cause instanceof Error ? cause.message : String(cause) })))} />
      ))}
    </div>
  );
  const quoteButton = (message: GroupChatMessage) => !archived && (
    <button type="button" className={`btn-sm ${styles.msgAction}`} disabled={!journalReady} onClick={() => quote(message)}>{t("groupChat.reply.action")}</button>
  );
  // 输入框上方的状态条：谁在发言、谁在后台干活、谁在等审批；每位都可以单独停下。
  const busyMembers = speaking.map(({ turn, member }) => ({ turn, member,
    state: interactions.some(item => item.opportunityId === turn.opportunityId && item.status === "pending") ? "approval" as const
      : turn.floor ? "speaking" as const : "working" as const }));
  const stopMember = async (memberId: string) => {
    if (!currentScope()) return;
    await run(() => stopGroupChatMember(groupId, memberId));
  };
  const authorHeader = (member: GroupChatMember | undefined) => (
    <button type="button" className={styles.author} data-group-author
      onClick={() => member && setCardMemberId(member.id)} disabled={!member}
      title={t("groupChat.card.open")}>
      <AgentAvatar agentId={member?.agentId} name={member?.displayName} className={styles.authorAvatar} />
      <span className={styles.authorName}>{member?.displayName ?? t("groupChat.someMember")}</span>
    </button>
  );
  const expand = (panel: "members" | "files") => {
    readingPositionRef.current = listRef.current?.scrollTop ?? null;
    setMessageMenu(null);
    setExpandedPanel(panel);
  };

  return (
    <div className={styles.panel}>
      {settingsOpen && <GroupChatSettings key={`settings:${scopeKey}`} view={view} onView={applyView} onClose={() => { if (currentScope()) setSettingsOpen(false); }} />}
      {cardMemberId && membersById.get(cardMemberId) && (
        <Suspense fallback={null}><GroupChatMemberModal key={`member:${scopeKey}:${cardMemberId}`} groupId={groupId} member={membersById.get(cardMemberId)!} view={view}
          onView={applyView} isCurrentScope={currentScope} onClose={() => { if (currentScope()) setCardMemberId(null); }} /></Suspense>
      )}
      {adding && (
        <Suspense fallback={null}><GroupChatAddMemberModal key={`add:${scopeKey}`} view={view} candidates={agents}
          onView={applyView} onClose={() => { if (currentScope()) setAdding(false); }} /></Suspense>
      )}
      {expandedPanel && <Suspense fallback={<div className={styles.expandedLoading} role="status"><FusionLoader size="sm" /></div>}>
        {expandedPanel === "members" ? <GroupChatDetails key={`details:${scopeKey}`} view={view}
          onClose={() => setExpandedPanel(null)}
          onAddMember={!archived && activeMembers.length < MAX_MEMBERS ? () => setAdding(true) : undefined}
          onOpenMember={setCardMemberId} onSearch={() => { setExpandedPanel(null); setSearchOpen(true); }}
          onRename={() => void rename()} onSettings={() => setSettingsOpen(true)}
          onDelete={() => void removeGroup()} deleting={view.group.status === "deleting" || deletingScope === scopeKey} />
          : <GroupChatFiles key={`files:${scopeKey}`} view={view} onClose={() => setExpandedPanel(null)} />}
      </Suspense>}
      <div className={styles.chatContent} hidden={expandedPanel !== null}>
      <header className={`chat-header ${styles.head}`}>
        <div className="chat-header__row">
          <button type="button" className={styles.detailsTrigger} data-group-details-trigger
            title={t("groupChat.members.all")} aria-label={`${view.group.name} · ${t("groupChat.members.all")}`}
            aria-expanded={expandedPanel === "members"} onClick={() => expand("members")}>
            <GroupChatAvatar view={view} className={styles.headerAvatar} />
            <span className={styles.headerIdentity}>
              <span className={styles.headerName}>{view.group.name}</span>
              <span className={styles.headerMembers} title={activeMembers.map(member => member.displayName).join(" · ")}>
                {activeMembers.map(member => member.displayName).join(" · ") || t("groupChat.memberCount", { count: 0 })}
              </span>
            </span>
          </button>
          <button type="button" className={`chat-headbtn ${styles.filesTrigger}`} data-group-files-trigger
            title={t("groupChat.files.open")} aria-label={t("groupChat.files.open")}
            onClick={() => expand("files")}>
            <img src={groupFilesTrigger} alt="" />
          </button>
        </div>
        {view.group.status === "deleting" && <p role="status" className={styles.muted}>{t("groupChat.deletingNotice")}</p>}
        {unavailableMembers.length > 0 && <div className={styles.availability} role="status">
          {t("groupChat.owner.offline", { names: unavailableMembers.map(member => member.displayName).join("、") })}
        </div>}
      </header>
      <ChatPinnedMessages items={pins} index={pinIndex} onIndex={setPinIndex} onJump={id => void jumpToPin(id)}
        onUnpin={id => { if (currentScope()) presentation.unpin(id); }} pinnedOnly={pinnedOnly} onToggle={() => setPinnedOnly(value => !value)} />
      {messageUndo?.scope === scopeKey && <div className="chat-toast chat-toast--success" role="status">
        <span className="chat-toast__text">{t("chat.hiddenN", { count: 1 })}</span>
        <button type="button" className="chat-toast__act" onClick={() => {
          if (!currentScope()) return;
          presentation.restore(messageUndo.id); setMessageUndo(null);
        }}>{t("chat.undo")}</button>
      </div>}
      {journalRecoveryOpen && ownerScope && <GroupChatJournalRecovery key={`journal:${scopeKey}`}
        ownerScope={ownerScope} groupId={groupId} onClose={() => { if (currentScope()) setJournalRecoveryOpen(false); }} />}
      {searchOpen && <GroupChatSearch key={`search:${scopeKey}`} view={view} onClose={() => { if (currentScope()) setSearchOpen(false); }}
        onOpenMessage={message => { if (!currentScope()) return; setSearchOpen(false); setFullMessage(message); }} />}
      {referenceOpen && <GroupChatReference key={`reference:${scopeKey}`} onClose={() => { if (currentScope()) setReferenceOpen(false); }} onInsert={excerpt => {
        if (!journalReady || archived || !currentScope()) return false;
        const next = appendGroupReference(draft, excerpt);
        if (next === null) { toast.error(t("groupChat.reference.tooLarge")); return false; }
        setDraft(next); textareaRef.current?.focus(); return true;
      }} />}
      <div className={styles.timeline} data-group-timeline ref={listRef} onScroll={(event) => {
        if (expandedPanel !== null) return;
        const el = event.currentTarget;
        stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}>
        {hasOlder && (
          <button type="button" className={`btn-sm ${styles.older}`} onClick={() => void loadOlder()}>{t("groupChat.loadOlder")}</button>
        )}
        {messages.length === 0 && speaking.length === 0 && interactions.length === 0 && <div className={styles.empty}>{t("groupChat.emptyTimeline")}</div>}
        {timeline.map(entry => {
          if (entry.kind === "turn") {
            const { turn, member } = entry;
            return (
          <div key={`turn:${turn.opportunityId}`} className="chat-group is-assistant"
            data-group-execution={turn.opportunityId} data-group-member={member.id}>
            <div className="chat-group__stack">
              {authorHeader(member)}
              <div className={`chat-bubble ${styles.liveBubble}`}>
                <GroupChatActivity activity={turn.activity} binding={{ groupId, memberId: member.id, opportunityId: turn.opportunityId }}
                  fallbackPhase={turn.recovery ? "reconciling" : turn.stopping ? "stopping" : turn.dispatchState === "queued" ? "queued" : "running"} context={t("groupChat.activity.discussion")} />
                {turn.queueReason === "execution_unconfirmed" && <p className={styles.muted}>{t("groupChat.queueBlocked")}</p>}
                {turn.recovery && <GroupChatRecovery key={`recovery:${scopeKey}`} groupId={groupId} target={{ kind: "turn", opportunityId: turn.opportunityId }}
                  recovery={turn.recovery} onView={applyView} />}
                {!turn.floor && <p className={styles.muted}>{t("groupChat.turn.working")}</p>}
                {turn.draft && turn.floor && answering.some(item => item.turn.opportunityId === turn.opportunityId) && (
                  <div aria-live="polite"><GroupChatMarkdown text={turn.draft} className={`chat-md ${styles.draft}`}
                    members={view.members} onMemberClick={setCardMemberId} /></div>
                )}
              </div>
            </div>
          </div>
        );
          }
          if (entry.kind === "interaction") {
            const { item } = entry;
          const member = membersById.get(item.memberId);
          return (
            <div key={`interaction:${item.opportunityId}:${item.request.requestId}`} className="chat-group is-assistant" data-card-interactive
              data-group-interaction={item.request.requestId} data-group-member={item.memberId}>
              <div className="chat-group__stack">
                {authorHeader(member)}
                <div className={`chat-bubble ${styles.liveBubble}`}>
                  <p className={styles.muted}>{t(item.status === "pending" ? "groupChat.interaction.waiting" : "groupChat.interaction.continuing",
                    { name: member?.displayName ?? t("groupChat.someMember") })}</p>
                  {item.status === "pending" && (
                    <>
                      {item.context?.command && <pre className="chat-prompt__cmd">{item.context.command}</pre>}
                      <ChatPromptCard key={item.request.requestId} compactApproval compactInput
                        draftKey={`group:${item.opportunityId}:${item.request.requestId}`} agentName={member?.displayName}
                        entry={{ ...item.request, id: item.request.requestId }}
                        onRespond={(_entry, data) => respond(item.opportunityId, item.request.requestId, data)} />
                    </>
                  )}
                </div>
              </div>
            </div>
          );

          }
          const { message } = entry;
          if (message.author.kind === "system") {
            return (
              <div key={message.seq} className={styles.system}>
                {systemText(message)}
                {canRetry(message) && (
                  <button type="button" className={`btn-sm ${styles.retry}`} onClick={() => void retry(message)}>
                    {t("groupChat.retry")}
                  </button>
                )}
              </div>
            );
          }
          const fullResultNote = message.fullResult && new TextEncoder().encode(message.body).length < message.fullResult.bytes && (
            <div className={styles.note}>
              <span>{t("groupChat.fullResult.excerpt")}</span>{" "}
              <button type="button" className="btn-sm" onClick={() => setFullMessage(message)}>{t("groupChat.fullResult.open")}</button>
              {(message.handoffs ?? []).map((handoff) => <p key={handoff.memberId}>
                {t("groupChat.fullResult.handoff", { text: handoff.excerpt })}
              </p>)}
            </div>
          );
          if (message.author.kind === "user") {
            return (
              <div key={message.seq} data-seq={message.seq} className={`chat-group is-user ${styles.msg}`}
                onContextMenu={event => openMessageMenu(event, message)}>
                <div className="chat-group__stack">
                  {quoteBlock(message)}
                  {message.body.trim() && <GroupChatMarkdown text={message.body} className="chat-bubble chat-md"
                    members={view.members} onMemberClick={setCardMemberId} />}
                  {attachmentRow(message)}
                  {fullResultNote}
                  <div className={styles.userAction}>{quoteButton(message)}</div>
                  {message.mentions.unresolved.length > 0 && (
                    <div className={styles.note}>{t("groupChat.unresolved", {
                      handles: message.mentions.unresolved.map((handle) => `@${handle}`).join("、") })}</div>
                  )}
                  {messageFooter(message)}
                </div>
              </div>
            );
          }
          const body = groupReplyBody(message);
          const member = membersById.get(message.author.memberId);
          return (
            <div key={message.seq} data-seq={message.seq} className={`chat-group is-assistant ${styles.msg}`}
              onContextMenu={event => openMessageMenu(event, message)}>
              <div className="chat-group__stack">
                {authorHeader(member)}
                {quoteBlock(message)}
                {body.trim() && <GroupChatMarkdown text={body} className="chat-bubble chat-md"
                  members={view.members} onMemberClick={setCardMemberId} />}
                {attachmentRow(message)}
                {fullResultNote}
                {messageFooter(message)}
                <div className={styles.messageActions}>{quoteButton(message)}</div>
              </div>
            </div>
          );

        })}
        {queued.length > 0 && <div className={styles.system} role="status">{t("groupChat.queued", { names: queued.join("、") })}</div>}
      </div>

      <div className={`chat-composer ${styles.composer}`} data-chat-composer
        onDragOver={archived || !journalReady ? undefined : (event) => event.preventDefault()}
        onDrop={archived || !journalReady ? undefined : (event) => {
          if (event.dataTransfer.files.length === 0) return;
          event.preventDefault(); addFiles(Array.from(event.dataTransfer.files));
        }}>
        {(stopPending || stoppingTurns.length > 0) && <p className={styles.scopeHint} role="status">
          {t(stopPending ? "groupChat.stopState.requesting" : "groupChat.stopState.confirming")}
        </p>}
        {busyMembers.length > 0 && <div className={styles.statusCapsule} role="status" data-group-status>
          {busyMembers.map(({ turn, member, state }) => <span key={turn.opportunityId} className={styles.statusItem} data-group-status-member={member.id}>
            <AgentAvatar agentId={member.agentId} name={member.displayName} className={styles.memberAvatar} />
            <span>{t(`groupChat.status.${state}`, { name: member.displayName })}</span>
            {!archived && !turn.stopping && <button type="button" className="btn-sm" onClick={() => void stopMember(member.id)}>{t("groupChat.status.stop")}</button>}
          </span>)}
        </div>}
        {!ownerScope && <p className={styles.scopeHint} role="status">{t("groupChat.sendJournal.scopeUnavailable")}</p>}
        {syncError && <p className={styles.scopeHint} role="status">
          {t("groupChat.sync.recovering")}{lastSyncAt ? ` · ${t("groupChat.sync.last", { time: new Date(lastSyncAt).toLocaleTimeString() })}` : ""}
          <button type="button" className="btn-sm" onClick={() => void pull()}>{t("groupChat.sync.check")}</button>
        </p>}
        {journalError && <div className={styles.scopeHint} role="alert">
          {t("groupChat.sendJournal.storageError", { code: journalError })}
          <button type="button" className="btn-sm" disabled={!ownerScope} onClick={() => setJournalRecoveryOpen(true)}>{t("groupChat.sendJournal.recoveryOpen")}</button>
          <button type="button" className="btn-sm" onClick={() => void journalObserverRef.current?.invalidate()}>{t("groupChat.sendJournal.checkStorage")}</button>
          {draftSessionRef.current && <button type="button" className="btn-sm" onClick={() => {
            const session = draftSessionRef.current!, generation = generationRef.current;
            void session.saveAsNewDraft().then(() => { if (generation === generationRef.current) setJournalError(null); }, cause => {
              if (generation === generationRef.current) setJournalError(cause instanceof Error ? cause.message : String(cause));
            });
          }}>{t("groupChat.sendJournal.saveDraft")}</button>}
        </div>}
        {foreignPending > 0 && <p className={styles.scopeHint} role="status">{t("groupChat.sendJournal.otherOwner", { count: foreignPending })}</p>}
        {sendRecords.length > 0 && <div className={styles.sendJournal} data-group-send-journal>
          <span role="status">{t("groupChat.sendJournal.pending", { count: sendRecords.length })}</span>
          <p>{t("groupChat.sendJournal.newHint")}</p>
          {[...sendRecords].sort((a, b) => b.createdAt - a.createdAt)
            .slice(Math.min(sendRecordPage, Math.floor((sendRecords.length - 1) / 20)) * 20, (Math.min(sendRecordPage, Math.floor((sendRecords.length - 1) / 20)) + 1) * 20)
            .map(record => <details key={record.key} data-send-id={record.clientMessageId}>
            <summary>{t(`groupChat.sendJournal.${record.phase}`)} · {excerptOf(record.inputSnapshot.body || record.inputSnapshot.attachments?.map(file => file.name).join("、") || "", 70)}</summary>
            <p>{record.inputSnapshot.body}</p>
            {record.inputSnapshot.attachments?.map(file => <p key={file.id}>{file.name}</p>)}
            {record.lastError && <p>{t("groupChat.sendJournal.detail", { code: record.lastError })}</p>}
            {archived && <p>{t("groupChat.sendJournal.archived")}</p>}
            <button type="button" className="btn-sm" disabled={sending} onClick={() => void verifyRecord(record)}>{t("groupChat.sendJournal.check")}</button>
            {record.phase !== "rejected" && <button type="button" className="btn-sm" disabled={sending || archived || !journalReady || !!journalError}
              onClick={() => void retrySend(record)}>{t("groupChat.sendJournal.retry")}</button>}
            <button type="button" className="btn-sm" disabled={sending || archived || !journalReady || !!journalError}
              onClick={() => void sendAsNew(record)}>{t("groupChat.sendJournal.new")}</button>
            <button type="button" className="btn-sm" disabled={JSON.stringify(composer) !== JSON.stringify(emptyGroupComposer())}
              onClick={() => { applyComposer(record.composerSnapshot); }}>{t("groupChat.sendJournal.restore")}</button>
          </details>)}
          {sendRecordPage > 0 && <button type="button" className="btn-sm" onClick={() => setSendRecordPage(value => Math.max(0, value - 1))}>{t("groupChat.sendJournal.previous")}</button>}
          {(sendRecordPage + 1) * 20 < sendRecords.length && <button type="button" className="btn-sm" onClick={() => setSendRecordPage(value => value + 1)}>{t("groupChat.sendJournal.next")}</button>}
        </div>}
        {mention && candidates.length > 0 && (
          <div className={styles.mentionMenu} id={mentionMenuId} role="listbox" aria-label={t("groupChat.composer.mention")}>
            {candidates.map((member, index) => (
              <button type="button" key={member.id} id={`${mentionMenuId}-${member.id}`} role="option" tabIndex={-1}
                aria-selected={index === mentionIndex}
                className={`${styles.mentionItem}${index === mentionIndex ? ` ${styles.isActive}` : ""}`}
                onMouseDown={(event) => event.preventDefault()} onClick={() => pickMention(member)}>
                <AgentAvatar agentId={member.agentId} name={member.displayName} className={styles.memberAvatar} />
                <span>{member.displayName}</span>
                <span className={styles.muted}>@{member.handle}</span>
              </button>
            ))}
          </div>
        )}
        {replyTo && (
          <div className={`chat-quote-bar ${styles.replyChip}`}>
            <span className="chat-quote-bar__ico" aria-hidden="true">↩</span>
            <span className={`chat-quote-bar__text ${styles.replyPreview}`} title={excerptOf(replyTo.body, 600)}>
              <strong>{t("groupChat.reply.to", { name: authorName(replyTo.author) })}</strong>
              {quotePreview(replyTo.body, replyAttachments)}
            </span>
            <button type="button" className="chat-quote-bar__x" title={t("groupChat.reply.cancel")}
              aria-label={t("groupChat.reply.cancel")} onClick={() => setReplyTo(null)}>×</button>
          </div>
        )}
        {files.length > 0 && (
          <div className={`chat-att-row chat-att-row--pending ${styles.pendingFiles}`}>
            {files.map((file) => (
              <div key={file.id} data-status={file.status}
                className={file.preview ? "chat-att-chip" : "chat-att-chip chat-att-chip--file"}
                title={file.status === "error" ? t("groupChat.attach.failed") : file.status === "uploading"
                  ? t("groupChat.attach.uploading", { name: file.name }) : file.name}>
                {file.preview ? <img src={file.preview} alt={file.name} />
                  : <span className="chat-att-chip__open"><ChatFileLabel name={file.name} /></span>}
                <button type="button" className="chat-att-x" onClick={() => removeFile(file.id)}
                  title={t("common.remove")} aria-label={`${t("common.remove")} ${file.name}`}>
                  <span aria-hidden="true">×</span>
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea ref={textareaRef} className="chat-composer__input" value={draft} disabled={archived || !journalReady}
          aria-label={t("groupChat.composer.message")}
          role="combobox" aria-autocomplete="list" aria-haspopup="listbox"
          aria-expanded={Boolean(mention && candidates.length > 0)}
          aria-controls={mention && candidates.length > 0 ? mentionMenuId : undefined}
          aria-activedescendant={mention && candidates.length > 0
            ? `${mentionMenuId}-${candidates[Math.min(mentionIndex, candidates.length - 1)].id}` : undefined}
          onChange={(event) => updateDraft(event.target.value, event.target.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={archived ? undefined : onPaste}
          onBlur={() => setMention(null)} />
        <input ref={fileInputRef} type="file" multiple hidden
          onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
        <div className="chat-composer__bar">
          <div className="chat-composer__left">
            <button type="button" className="chat-pill chat-pill--ghost" disabled={archived || !journalReady}
              onClick={() => setReferenceOpen(true)}>{t("groupChat.reference.open")}</button>
            <button type="button" className="chat-pill chat-pill--ghost" disabled={archived || !journalReady}
              title={t("groupChat.composer.mention")} onClick={openMentions}
              onMouseDown={(event) => event.preventDefault()}>
              <span className={styles.mentionIcon} aria-hidden="true">@</span>{t("groupChat.composer.mention")}
            </button>
            <span className={styles.composerHint} id={composerHintId}>{t("groupChat.composer.hint")}</span>
          </div>
          <div className="chat-composer__right">
            <button type="button" className="chat-iconbtn" title={t("chat.attachFile")} aria-label={t("chat.attachFile")}
              disabled={archived || !journalReady || files.length >= MAX_INSPIRATION_ATTACHMENTS} onClick={() => fileInputRef.current?.click()}>
              <IconClip />
            </button>
            {(canStopDiscussion || stopPending || stoppingTurns.length > 0) ? (
              <button type="button" className="chat-iconbtn chat-send chat-stop"
                title={t(stopPending ? "groupChat.stopState.requesting" : !canStopDiscussion ? "groupChat.stopState.confirming" : "groupChat.stop")}
                aria-label={t(stopPending ? "groupChat.stopState.requesting" : !canStopDiscussion ? "groupChat.stopState.confirming" : "groupChat.stop")}
                disabled={stopPending || !canStopDiscussion} aria-busy={stopPending}
                onClick={() => void stopDiscussion()}><IconStop /></button>
            ) : (
              <button type="button" className="chat-iconbtn chat-send" title={t("groupChat.send")} aria-label={t("groupChat.send")}
                onClick={() => void send()} disabled={(!draft.trim() && files.length === 0) || filesBusy || sending || archived || !journalReady || !!journalError || sameDraftPending}>
                <IconSend />
              </button>
            )}
          </div>
        </div>
      </div>
      {fullMessage && <GroupChatFullMessage key={`${scopeKey}:${fullMessage.id}`} groupId={groupId} message={fullMessage} onClose={() => { if (currentScope()) setFullMessage(null); }} />}
      {messageMenu?.scope === scopeKey && <ChatMessageContextMenu x={messageMenu.x} y={messageMenu.y}
        onClose={() => setMessageMenu(null)} onCopy={messageText(messageMenu.message) ? () => void copyMessage(messageMenu.message) : undefined}
        onQuote={() => quote(messageMenu.message)} quoteDisabled={archived || !journalReady}
        onPin={() => pinMessage(messageMenu.message)} pinned={presentation.pins.some(pin => pin.id === messageMenu.message.id)}
        onDelete={() => hideMessage(messageMenu.message)} />}
      </div>
      {lightbox && (
        <div className="chat-lightbox" role="dialog" aria-modal="true" onClick={() => setLightbox(null)}>
          <img className="chat-lightbox__img" src={lightbox} alt="" onClick={(event) => event.stopPropagation()} />
        </div>
      )}
    </div>
  );
}

/** 群头像：两人横叠、三人三角、四人及以上四角叠放；沿用真实成员头像。 */
export function GroupChatAvatar({ view, className }: { view: GroupChatView; className?: string }) {
  const shown = view.members.filter((member) => member.state === "active").slice(0, 4);
  return (
    <span className={`${styles.groupAvatar}${className ? ` ${className}` : ""}`} data-group-avatar-count={shown.length} aria-hidden="true">
      {shown.map((member) => (
        <AgentAvatar key={member.id} agentId={member.agentId} name={member.displayName} className={styles.groupAvatarItem} />
      ))}
    </span>
  );
}
