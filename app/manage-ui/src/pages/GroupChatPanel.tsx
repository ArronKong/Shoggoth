import { retainTelemetryOperation, startTelemetryOperation, useTelemetryOperations } from "../lib/productTelemetry";
import '../i18n/groupCollaborationResources';
import '../i18n/groupComposerResources';
import '../i18n/groupFilesResources';
import { type ClipboardEvent, type KeyboardEvent, type MouseEvent, lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import GroupMemberAvatar from "./GroupMemberAvatar";
import { GroupMentionAvatarStack } from "./GroupChatMention";
import GroupChatComposerInput, { type GroupComposerInputHandle, type GroupComposerSelection } from "./GroupChatComposerInput";
import ChatFileButton, { ChatFileLabel } from "../components/ChatFileButton";
import GroupChatMarkdown, { groupAttachmentsOutsideMarkdown } from "./GroupChatMarkdown";
import FusionLoader from "../components/FusionLoader";
import ChatLiveActivityBubble from "../components/ChatLiveActivityBubble";
import TurnTimeline from "../components/TurnTimeline/TurnTimeline";
import Modal from "../components/Modal";
import { useConfirm, usePrompt, useToast } from "../components/ui";
import {
  getGroupChat, listGroupChatMessages, lookupGroupChatSend, revealAttachment, respondGroupChatInteraction, retryGroupChatTurn,
  sendGroupChatMessage, stopGroupChatDiscussion, updateGroupChat, deleteGroupChat, updateGroupChatMembers,
} from "../api/client";
import ChatPromptCard, { type ChatPromptResponse } from "./ChatPromptCard";
import { IconClip, IconSend, IconStop } from "./chatIcons";
import groupFilesTrigger from "../assets/figma/group-chat/group-files-trigger.svg";
import {
  inspirationMediaLimit, inspirationMediaUrl, MAX_INSPIRATION_ATTACHMENTS, normalizeMediaType, uploadInspirationMedia,
} from "./inspiration-media";
import { onGroupChanged, GROUP_MIN_MEMBERS, type GroupCandidateAgent } from "../lib/groupChat";
import { createGroupPanelObserver } from "../lib/groupPanelObserver";
import type { GroupPanelCache } from "../lib/groupPanelCache";
import { emptyGroupComposer, GroupDraftSession, groupSendJournal, GROUP_CONNECTION_EVENT, GROUP_JOURNAL_CHANGED,
  type GroupComposer, type GroupSendInput, type GroupSendRecord, type GroupSendTargetLock } from "../lib/groupSendJournal";
import GroupChatFullMessage from "./GroupChatFullMessage";
import GroupChatRecovery from "./GroupChatRecovery";
import GroupChatSettings from "./GroupChatSettings";
import GroupChatReference from "./GroupChatReference";
import GroupChatJournalRecovery from "./GroupChatJournalRecovery";
import GroupChatSearch from "./GroupChatSearch";
import { composerPrefill, composerSendTarget, followLatestSpeaker, OWNER_TARGET, sendTargetMentions } from "./GroupChatSendTarget";
import { groupDraftBody, pasteGroupDraftText, replaceGroupDraftText, restoreDraftMentions, type GroupDraftMention, type GroupDraftText } from "../lib/groupMentions";
import { appendGroupReference } from "../lib/groupReferenceExcerpt";
import GroupChatActivityDialog, { boundGroupActivity, groupActivityEnded, groupActivitySteps,
  GroupChatMessageActivityDialog, type GroupMessageActivitySource } from "./GroupChatActivity";
import { IconTrajectory } from "../components/TurnTimeline/trajectoryIcons";
import type { GroupChatMember, GroupChatMessage, GroupChatView, InspirationAttachment } from "../types";
import { groupReplyBody, groupReplyBubbles } from "../lib/groupReply";
import { formatChatTime } from "../lib/chatTime";
import { orderGroupTimeline } from "../lib/groupTimeline";
import { ChatMessageContextMenu, ChatPinnedMessages, IconCopy, IconPin, IconQuote, IconTrash, MESSAGE_DELETION_ENABLED, MESSAGE_PINNING_ENABLED } from "./ChatMessageActions";
import { clipboardFile, desktopChatClipboard, writeChatClipboard, type ChatClipboardAttachment } from "../lib/chatClipboard";
import ChatResponseMetadata from "./ChatResponseMetadata";
import { useGroupMessagePresentation } from "../lib/groupMessagePresentation";
import "./ChatModelMenu.css";
import styles from "./GroupChatPanel.module.css";

const PAGE = 100;
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
type MentionPicker = { kind: "typed" | "selected"; start: number; end: number; query: string }
  | { kind: "prefill"; query: "" };

function mentionAtCaret({ text, mentions }: GroupDraftText, caret: number): MentionPicker | null {
  if (mentions.some(span => caret > span.start && caret <= span.end)) return null;
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  const query = before.slice(at + 1);
  if (/\s/u.test(query) || query.length > 32) return null;
  if (at > 0 && /[A-Za-z0-9_.+%/\\-]/u.test(before[at - 1]) && !mentions.some(span => span.end === at)) return null;
  return { kind: "typed", start: at, end: caret, query };
}

// 待发送的附件：选中或粘贴后立刻上传到媒体库，传完才能发送。
type PendingFile = { id: string; name: string; preview: string | null; status: "uploading" | "ready" | "error";
  attachment: InspirationAttachment | null };

function excerptOf(text: string, max = 80) {
  const flat = text.replace(/\s+/gu, " ").trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max).join("")}…`;
}

/** agents：可以加进群的 Agent（聊天页的 Agent 列表），用于「添加成员」。 */
export default function GroupChatPanel({ groupId, agents = [], backends = [], onArchived, cache, cacheScope, searchTarget, onSearchTargetHandled }: {
  groupId: string;
  agents?: GroupCandidateAgent[];
  backends?: readonly { id: string; name: string }[];
  onArchived(): void;
  cache?: GroupPanelCache;
  cacheScope?: string;
  searchTarget?: { ownerScope: string; message?: GroupChatMessage };
  onSearchTargetHandled?(): void;
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
  const latestViewRef = useRef(view);
  latestViewRef.current = view;
  const setView = (next: GroupChatView | null | ((previous: GroupChatView | null) => GroupChatView | null)) => {
    const epoch = ownerEpochRef.current;
    setOwnedView(previous => ({ view: typeof next === "function" ? next(previous.view) : next, epoch }));
  };
  const scopeKey = JSON.stringify([groupId, view?.ownerScope ?? null, ownerEpoch]);
  const presentation = useGroupMessagePresentation(view?.group.id === groupId ? view.ownerScope ?? null : null, groupId);
  const [messageMenu, setMessageMenu] = useState<{ scope: string; x: number; y: number; message: GroupChatMessage;
    attachment?: ChatClipboardAttachment } | null>(null);
  const [selectedActivityKey, setSelectedActivityKey] = useState<string | null>(null);
  const [messageActivity, setMessageActivity] = useState<{ scope: string; source: GroupMessageActivitySource } | null>(null);
  const [messageUndo, setMessageUndo] = useState<{ scope: string; id: string } | null>(null);
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [pinIndex, setPinIndex] = useState(0);
  const pinJumpRef = useRef(0);
  const [pinJumpTarget, setPinJumpTarget] = useState<{ scope: string; jump: number; seq: number } | null>(null);
  useEffect(() => { setMessageMenu(null); setSelectedActivityKey(null); setMessageActivity(null); setMessageUndo(null); setPinnedOnly(false); setPinIndex(0); setPinJumpTarget(null); pinJumpRef.current++; }, [scopeKey]);
  useEffect(() => {
    if (!messageUndo) return;
    const timer = setTimeout(() => setMessageUndo(previous => previous === messageUndo ? null : previous), 6000);
    return () => clearTimeout(timer);
  }, [messageUndo]);
  const pins = presentation.pins.filter(pin => !presentation.hidden.has(pin.id));
  useEffect(() => { if (!pins.length) setPinnedOnly(false); }, [pins.length]);
  const [messages, setMessages] = useState<GroupChatMessage[]>(cached?.messages ?? []);
  const [hasOlder, setHasOlder] = useState(cached?.hasOlder ?? false);
  const [olderLoadState, setOlderLoadState] = useState<"idle" | "loading" | "error">("idle");
  const olderRequestRef = useRef<symbol | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [mentionIds, setMentionIds] = useState<string[]>([]);
  const [mentionSpans, setMentionSpans] = useState<GroupDraftMention[] | null>(null);
  const [sending, setSending] = useState(false);
  const [stoppingScope, setStoppingScope] = useState<string | null>(null);
  const stoppingScopeRef = useRef<string | null>(null);
  const deletingScopeRef = useRef<string | null>(null);
  const [deletingScope, setDeletingScope] = useState<string | null>(null);
  const removingMemberScopeRef = useRef<string | null>(null);
  const [removingMemberScope, setRemovingMemberScope] = useState<string | null>(null);
  const [mention, setMention] = useState<MentionPicker | null>(null);
  // null follows the last speaker. An owner lock also records that a prefill was cleared.
  const [targetLock, setTargetLock] = useState<GroupSendTargetLock | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [adding, setAdding] = useState(false);
  const [expandedPanel, setExpandedPanel] = useState<"members" | "files" | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 引用回复：发送时带上被引用消息的序号。
  const [replyTo, setReplyTo] = useState<GroupChatMessage | null>(null);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [journalRecoveryOpen, setJournalRecoveryOpen] = useState(false);
  const [sendRecordsOpen, setSendRecordsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [fullMessage, setFullMessage] = useState<GroupChatMessage | null>(null);
  const [expiredSearchScope, setExpiredSearchScope] = useState<string | null>(null);
  const retryOps = useRef(new Map<number, string>());
  const telemetrySends = useTelemetryOperations();
  const [files, setFiles] = useState<PendingFile[]>([]);
  const filesRef = useRef(files);
  filesRef.current = files;
  const [lightbox, setLightbox] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const respondOps = useRef(new Map<string, { input: string; id: string }>());
  const lastSeqRef = useRef(0);
  const messageRevisionRef = useRef(cached?.messageRevision ?? 0);
  const messageUpdatesSupportedRef = useRef(cached?.view.group.messageRevision !== undefined);
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
  const dispatchingRef = useRef(new Set<string>());
  const listRef = useRef<HTMLDivElement>(null);
  const readingPositionRef = useRef<number | null>(null);
  const stickToBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const composerInput = useRef<GroupComposerInputHandle>(null);
  const mentionList = useRef<HTMLDivElement>(null);
  const mentionMenuId = useId();
  useLayoutEffect(() => {
    if (!pinJumpTarget || pinJumpTarget.scope !== scopeKey || pinJumpTarget.jump !== pinJumpRef.current) return;
    const target = listRef.current?.querySelector(`[data-seq="${pinJumpTarget.seq}"]`);
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    setPinJumpTarget(null);
  }, [messages, pinJumpTarget, scopeKey]);

  const membersById = useMemo(() => new Map((view?.members ?? []).map((member) => [member.id, member])), [view]);
  const activeMembers = useMemo(() => (view?.members ?? []).filter((member) => member.state === "active"), [view]);
  const mentionableMembers = useMemo(() => activeMembers.filter(member => !member.agentMissing), [activeMembers]);
  const draftText = useMemo(() => ({ text: draft, mentions: mentionSpans ?? restoreDraftMentions(draft, mentionableMembers, mentionIds) }),
    [draft, mentionSpans, mentionableMembers, mentionIds]);
  const messageAttachments = useMemo(() => new Map(messages.map(message => [message.id,
    message.author.kind === "member" && message.attachments?.length
      ? groupAttachmentsOutsideMarkdown(groupReplyBody(message), message.attachments) : message.attachments ?? []])), [messages]);
  const unavailableMembers = activeMembers.filter(member => member.card?.availability === "offline");
  const ownerId = view?.currentOwnerId ?? null;
  const latestSpeaker = useMemo(() => followLatestSpeaker(messages, mentionableMembers), [messages, mentionableMembers]);
  const { target: resolvedTarget, expired: lockExpired, invalid: lockInvalid } = composerSendTarget(targetLock, latestSpeaker, mentionableMembers, replyTo);
  const prefill = composerPrefill(resolvedTarget, ownerId, replyTo, Boolean(targetLock?.manual && !lockExpired && !lockInvalid));
  const prefillMember = prefill?.kind === "member" ? mentionableMembers.find(member => member.id === prefill.memberId) : undefined;
  const prefillKey = prefillMember?.id ?? (prefill?.kind === "all" ? "all" : null);
  const showPrefill = prefillKey !== null && journalReady && view?.group.status === "active";
  useEffect(() => {
    if (!targetLock) return;
    if (lockExpired) setTargetLock(lock => lock === targetLock ? null : lock);
    else if (lockInvalid) setTargetLock(lock => lock === targetLock ? { ...lock, target: OWNER_TARGET, manual: false } : lock);
  }, [targetLock, lockExpired, lockInvalid]);
  const holdTarget = () => setTargetLock(lock => lock?.afterSeq === null ? lock : {
    target: prefillKey !== null && prefill ? prefill : OWNER_TARGET,
    manual: Boolean(lock?.manual && !lockExpired && !lockInvalid), afterSeq: null,
  });
  const removePrefill = () => {
    setTargetLock({ target: OWNER_TARGET, manual: false, afterSeq: null });
  };

  const append = useCallback((incoming: GroupChatMessage[], updatesOnly = false) => {
    if (incoming.length === 0) return;
    // 分页游标在 React 批处理 state updater 前同步推进。
    for (const message of incoming) lastSeqRef.current = Math.max(lastSeqRef.current, message.seq);
    setMessages((prev) => {
      const known = new Map(prev.map(message => [message.seq, message]));
      for (const message of incoming) {
        const prior = known.get(message.seq);
        if (updatesOnly && !prior && message.seq < (prev[0]?.seq ?? 0)) continue;
        if (!prior || message.id === prior.id && message.groupId === prior.groupId && message.createdAt === prior.createdAt
          && message.author.kind === prior.author.kind && (message.author.kind !== "member" || prior.author.kind === "member" && message.author.memberId === prior.author.memberId)
          && (message.revision ?? 0) > (prior.revision ?? 0)) known.set(message.seq, message);
      }
      const merged = [...known.values()].sort((a, b) => a.seq - b.seq);
      lastSeqRef.current = merged.at(-1)?.seq ?? lastSeqRef.current;
      return merged;
    });
  }, []);

  const pull = useCallback(() => observerRef.current?.invalidate() ?? Promise.resolve(), []);
  const currentScope = useCallback(() => mountedRef.current && currentGroupRef.current === groupId
    && ownerScopeRef.current === (view?.ownerScope ?? null) && ownerEpochRef.current === ownerEpoch,
  [groupId, view?.ownerScope, ownerEpoch]);
  useEffect(() => {
    if (!searchTarget?.message || view?.group.id !== groupId || !currentScope()) return;
    const matches = searchTarget.ownerScope === view.ownerScope && searchTarget.message.groupId === groupId;
    setExpiredSearchScope(matches ? null : scopeKey);
    if (matches) setFullMessage(searchTarget.message);
    onSearchTargetHandled?.();
  }, [groupId, view, currentScope, scopeKey, searchTarget, onSearchTargetHandled]);
  const applyView = (next: GroupChatView) => {
    if (!currentScope() || next.group.id !== groupId || (next.ownerScope ?? null) !== (view?.ownerScope ?? null)) return;
    mutationRevisionRef.current++;
    setView(next); void pull();
  };

  useLayoutEffect(() => {
    if (view?.group.id === groupId && historyReadyRef.current && lastSyncAt !== null) {
      cache?.put({ view, messages, hasOlder, lastSyncAt, messageRevision: messageRevisionRef.current });
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
    olderRequestRef.current = null;
    setOlderLoadState("idle");
    historyReadyRef.current = !!cached;
    setLoadError(null);
    setSyncError(null); setLastSyncAt(cached?.lastSyncAt ?? null); setJournalReady(false); setJournalError(null); setSendRecords([]); setForeignPending(0);
    draftSessionRef.current = null;
    setSending(false);
    setDraft("");
    setMentionIds([]);
    setMention(null);
    setTargetLock(null); setMentionSpans(null);
    setReplyTo(null);
    setReferenceOpen(false); setSearchOpen(false); setJournalRecoveryOpen(false); setSendRecordsOpen(false);
    setFullMessage(null);
    setAdding(false);
    setSettingsOpen(false);
    setExpandedPanel(null);
    readingPositionRef.current = null;
    for (const file of filesRef.current) if (file.preview) URL.revokeObjectURL(file.preview);
    setFiles([]);
    setLightbox(null);
    lastSeqRef.current = cached?.messages.at(-1)?.seq ?? 0;
    messageRevisionRef.current = cached?.messageRevision ?? 0;
    messageUpdatesSupportedRef.current = cached?.view.group.messageRevision !== undefined;
    observedOwnerRef.current = cached?.view.ownerScope ?? null;
    ownerScopeRef.current = cached?.view.ownerScope ?? null;
    stickToBottomRef.current = true;
    setShowJump(false);
    const observer = createGroupPanelObserver({
      read: async () => {
        const mutationRevision = mutationRevisionRef.current;
        const initialHistory = !historyReadyRef.current;
        const [detail, page] = await Promise.all([getGroupChat(groupId), listGroupChatMessages(groupId,
          initialHistory ? { limit: PAGE } : { afterSeq: lastSeqRef.current, limit: 200,
            ...(messageUpdatesSupportedRef.current ? { afterRevision: messageRevisionRef.current } : {}) })]);
        if (mutationRevision !== mutationRevisionRef.current) throw new Error("GROUP_PANEL_READ_INVALIDATED");
        if (detail?.group?.id !== groupId || !Array.isArray(page?.messages) || typeof page.hasMore !== "boolean"
          || page.messages.some(message => message?.groupId !== groupId || !Number.isSafeInteger(message.seq) || message.seq <= 0)) {
          throw new Error("Invalid group chat response");
        }
        if (page.updates !== undefined && (!Array.isArray(page.updates) || page.updates.some(message => message?.groupId !== groupId
          || !Number.isSafeInteger(message.seq) || message.seq <= 0 || !Number.isSafeInteger(message.revision) || message.revision! <= 0))
          || page.revision !== undefined && (!Number.isSafeInteger(page.revision) || page.revision < 0)
          || page.hasMoreUpdates !== undefined && typeof page.hasMoreUpdates !== "boolean") throw new Error("Invalid group message updates");
        const nextSeq = page.messages.reduce((last, message) => Math.max(last, message.seq), lastSeqRef.current);
        if (!initialHistory && page.hasMore && nextSeq <= lastSeqRef.current) throw new Error("Invalid group chat response");
        if (!initialHistory && page.hasMoreUpdates && (page.revision ?? 0) <= messageRevisionRef.current
          && nextSeq <= lastSeqRef.current) throw new Error("Invalid group message updates");
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
          observedOwnerRef.current = detail.ownerScope ?? null; lastSeqRef.current = 0; messageRevisionRef.current = 0; setMessages([]); setHasOlder(false);
          olderRequestRef.current = null;
          setOlderLoadState("idle");
          setFullMessage(null); setLightbox(null);
          setSettingsOpen(false); setAdding(false); setExpandedPanel(null);
          setSearchOpen(false); setReferenceOpen(false); setJournalRecoveryOpen(false); setSendRecordsOpen(false);
          setJournalReady(false); draftSessionRef.current = null; setSendRecords([]); setForeignPending(0); setJournalError(null);
          setSending(false); setDraft(""); setMentionIds([]); setMention(null); setReplyTo(null);
          setTargetLock(null); setMentionSpans(null);
          for (const file of filesRef.current) if (file.preview) URL.revokeObjectURL(file.preview);
          setFiles([]); retryOps.current.clear(); respondOps.current.clear();
          setView(detail); void observer.invalidate(); return;
        }
        observedOwnerRef.current = detail.ownerScope ?? null;
        ownerScopeRef.current = detail.ownerScope ?? null;
        historyReadyRef.current = true;
        messageUpdatesSupportedRef.current = detail.group.messageRevision !== undefined;
        if (page.revision !== undefined) messageRevisionRef.current = Math.max(messageRevisionRef.current, page.revision);
        setView(previous => previous && previous.ownerScope === detail.ownerScope && previous.group.lastSeq > detail.group.lastSeq ? previous : detail);
        setLoadError(null); setSyncError(null); setLastSyncAt(Date.now());
        if (initialHistory) setHasOlder(page.hasMore);
        append(page.messages); append(page.updates ?? [], true);
        if (!initialHistory && (page.hasMore || page.hasMoreUpdates)) void observer.invalidate();
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
  const stoppedSpeech = (turn: GroupChatView["activeTurns"][number]) => turn.releasedReason === "stopped";
  const awaitingStop = (view?.activeTurns ?? []).some(turn => !stoppedSpeech(turn) && (turn.stopping || turn.recovery?.cancelRequested));
  const canStopDiscussion = Boolean(view?.round) || (view?.queuedMemberIds.length ?? 0) > 0
    || (view?.activeTurns ?? []).some(turn => !turn.stopping && !turn.recovery?.cancelRequested);
  const stopPending = stoppingScope === scopeKey;
  const showStop = canStopDiscussion || stopPending || awaitingStop;

  const applyComposer = useCallback((composer: GroupComposer) => {
    setDraft(composer.text); setMentionIds(composer.mentionIds); setMentionSpans(composer.mentionSpans ?? null); setReplyTo(composer.replyTo);
    setMention(null);
    // Older drafts used ordinary owner routing or their quoted member. Keep that intent on upgrade.
    setTargetLock(composer.sendTarget ?? (composer.text.length || composer.files.length || composer.replyTo
      ? { target: OWNER_TARGET, manual: false, afterSeq: null } : null));
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
    files: files.map(({ id, name, status, attachment }) => ({ id, name, status, attachment })),
    ...(targetLock ? { sendTarget: targetLock } : {}),
    ...(mentionSpans?.length ? { mentionSpans } : {}) };
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
      turn.activity?.streamGeneration, turn.activity?.phase, turn.stopping, turn.recovery, turn.released]),
    (view?.pendingInteractions ?? []).map(item => [item.opportunityId, item.request.requestId, item.status]),
    view?.queuedMemberIds, view?.round?.id,
  ]);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && list.clientHeight > 0 && expandedPanel === null) {
      if (stickToBottomRef.current) list.scrollTop = list.scrollHeight;
      else if (readingPositionRef.current !== null) list.scrollTop = readingPositionRef.current;
      readingPositionRef.current = null;
      setShowJump(list.scrollHeight - list.scrollTop - list.clientHeight >= 80);
    }
  }, [messages, activitySignature, expandedPanel]);

  // Match the direct-chat fade boundary and final-message clearance to the composer.
  // The optional jump button floats above this boundary and must not move it.
  useLayoutEffect(() => {
    const list = listRef.current;
    const composer = list?.parentElement?.querySelector<HTMLElement>("[data-chat-composer]");
    if (!list || !composer || expandedPanel !== null) return;
    const measure = () => {
      if (!list.clientHeight) return;
      const clearance = Math.max(0, Math.ceil(list.getBoundingClientRect().bottom - composer.getBoundingClientRect().top));
      const fade = `${clearance}px`;
      if (list.style.getPropertyValue("--chat-fade-bottom") !== fade) {
        list.style.setProperty("--chat-fade-bottom", fade);
        list.style.setProperty("--chat-thread-bottom", `${clearance + 44}px`);
      }
      if (stickToBottomRef.current) list.scrollTop = list.scrollHeight;
      setShowJump(list.scrollHeight - list.scrollTop - list.clientHeight >= 80);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; measure(); });
    });
    observer.observe(list);
    observer.observe(composer);
    const content = list.querySelector(".chat-thread__inner");
    if (content) observer.observe(content);
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [view?.group.id, expandedPanel]);

  const jumpToLatest = () => {
    const list = listRef.current;
    if (!list) return;
    pinJumpRef.current++;
    setPinJumpTarget(null);
    readingPositionRef.current = null;
    stickToBottomRef.current = true;
    list.scrollTop = list.scrollHeight;
    setShowJump(false);
  };

  const loadOlder = async () => {
    const first = messages[0]?.seq;
    if (!hasOlder || first === undefined || view?.group.id !== groupId || !currentScope() || olderRequestRef.current) return;
    const generation = generationRef.current;
    const request = Symbol();
    const currentRequest = () => currentScope() && generation === generationRef.current && olderRequestRef.current === request;
    olderRequestRef.current = request;
    setOlderLoadState("loading");
    try {
      const page = await listGroupChatMessages(groupId, { beforeSeq: first, limit: PAGE });
      if (!currentRequest()) return;
      if (!Array.isArray(page?.messages) || typeof page.hasMore !== "boolean" || (page.hasMore && !page.messages.length)
        || page.messages.some(message => message?.groupId !== groupId || !Number.isSafeInteger(message.seq) || message.seq <= 0 || message.seq >= first)) {
        throw new Error("Invalid group chat response");
      }
      const list = listRef.current;
      const previousHeight = list?.scrollHeight ?? 0;
      const previousTop = list?.scrollTop ?? 0;
      stickToBottomRef.current = false;
      setHasOlder(page.hasMore);
      append(page.messages);
      setOlderLoadState("idle");
      requestAnimationFrame(() => {
        if (list && listRef.current === list && currentScope() && generation === generationRef.current) {
          list.scrollTop = previousTop + list.scrollHeight - previousHeight;
        }
      });
    } catch {
      if (currentRequest()) setOlderLoadState("error");
    } finally {
      if (olderRequestRef.current === request) olderRequestRef.current = null;
    }
  };

  const candidates = useMemo(() => {
    if (!mention) return [];
    const query = normalize(mention.query);
    const members = mentionableMembers.filter(member => normalize(member.handle).includes(query)
      || normalize(member.displayName).includes(query));
    const allName = t("groupChat.target.all");
    return "all".includes(query) || normalize(allName).includes(query) ? [...members, null] : members;
  }, [mentionableMembers, mention, t]);
  const activeMentionIndex = Math.min(mentionIndex, candidates.length - 1);
  const activeMentionId = activeMentionIndex < 0 ? undefined : `${mentionMenuId}-${candidates[activeMentionIndex]?.id ?? "all"}`;
  useLayoutEffect(() => {
    const list = mentionList.current;
    const selected = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !selected) return;
    const viewport = list.getBoundingClientRect();
    const row = selected.getBoundingClientRect();
    if (row.top < viewport.top) list.scrollTop += row.top - viewport.top;
    else if (row.bottom > viewport.bottom) list.scrollTop += row.bottom - viewport.bottom;
  }, [activeMentionId, candidates.length]);

  const writeDraftText = ({ text, mentions }: GroupDraftText) => {
    setDraft(text);
    setMentionSpans(mentions);
    setMentionIds([...new Set(mentions.flatMap(span => span.memberId === null ? [] : [span.memberId]))]);
  };
  const updateDraft = (value: GroupDraftText, selection: GroupComposerSelection, removedPrefill: boolean, composing: boolean) => {
    writeDraftText(value);
    if (removedPrefill) removePrefill();
    else if (value.text.length) holdTarget();
    setMention(composing ? null : mentionAtCaret(value, selection.end));
    setMentionIndex(0);
  };
  const focusComposerAt = (position: number) => requestAnimationFrame(() => {
    if (!currentScope()) return;
    composerInput.current?.focus();
    composerInput.current?.moveCaret(position);
  });
  const composerSelection = () => composerInput.current?.selection() ?? { start: draft.length, end: draft.length, includesPrefill: false };
  const openTokenMention = (token: GroupDraftMention | "prefill") => {
    if (!journalReady || !currentScope()) return;
    const id = token === "prefill" ? prefillMember?.id ?? null : token.memberId;
    const index = id === null ? mentionableMembers.length : mentionableMembers.findIndex(member => member.id === id);
    setMentionIndex(Math.max(0, index));
    setMention(token === "prefill" ? { kind: "prefill", query: "" } : { kind: "selected", start: token.start, end: token.end, query: "" });
  };

  const openMentions = () => {
    const { start, end, includesPrefill } = composerSelection();
    const current = start === end && !includesPrefill ? mentionAtCaret(draftText, start) : null;
    if (current) { setMention(current); setMentionIndex(0); composerInput.current?.focus(); return; }
    const insert = `${start > 0 && !/\s/u.test(draft[start - 1]) ? " " : ""}@`;
    const caret = start + insert.length;
    updateDraft(replaceGroupDraftText(draftText, start, end, insert), { start: caret, end: caret, includesPrefill: false }, includesPrefill, false);
    focusComposerAt(caret);
  };

  const pickMention = (member: GroupChatMember | null) => {
    if (!mention || !currentScope()) return;
    setMention(null);
    if (mention.kind === "prefill") {
      setTargetLock({ target: member ? { kind: "member", memberId: member.id } : { kind: "all" }, manual: true, afterSeq: null });
      focusComposerAt(0);
      return;
    }
    const { start, end } = mention;
    const handle = `@${member?.handle ?? "all"}`;
    const hasSpace = draft[end] === " ";
    const separator = mention.kind === "typed" && !/\s/u.test(draft[end] ?? "") ? " " : "";
    holdTarget();
    writeDraftText(replaceGroupDraftText(draftText, start, end, handle + separator, { length: handle.length, memberId: member?.id ?? null }));
    focusComposerAt(start + handle.length + (separator || hasSpace ? 1 : 0));
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
      holdTarget();
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
  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const clipboard = event.clipboardData;
    if (archived || !journalReady || !currentScope() || !clipboard) return;
    const pasted = Array.from(clipboard.items).filter((item) => item.kind === "file")
      .map((item) => item.getAsFile()).filter((file): file is File => !!file);
    const desktop = desktopChatClipboard();
    if (pasted.length && !desktop?.readChatClipboard) {
      event.preventDefault();
      addFiles(pasted);
      return;
    }
    const text = clipboard.getData("text/plain").replace(/\r\n?/gu, "\n");
    const { start, end, includesPrefill } = composerSelection();
    const insertText = (value: string, intercepted = false) => {
      const next = pasteGroupDraftText(draftText, start, end, value, mentionableMembers)
        ?? (intercepted && value ? replaceGroupDraftText(draftText, start, end, value) : null);
      if (!next) return false;
      const caret = start + value.length;
      updateDraft(next, { start: caret, end: caret, includesPrefill: false }, includesPrefill, false);
      focusComposerAt(caret);
      return true;
    };
    if (desktop?.readChatClipboard && (pasted.length || !text || clipboard.types.includes("Files"))) {
      event.preventDefault();
      const session = draftSessionRef.current, id = session?.draftId, revision = session?.revision;
      const current = () => currentScope() && draftSessionRef.current === session && session?.draftId === id;
      void desktop.readChatClipboard(pasted.length > 0).then(({ files, caption }) => {
        if (!current()) return;
        if (session?.revision === revision) insertText(caption ?? (!files.length && !pasted.length ? text : ""), true);
        addFiles(files.length ? files.map(clipboardFile) : pasted);
      }).catch(() => { if (current()) addFiles(pasted); });
      return;
    }
    if (insertText(text)) event.preventDefault();
  };
  const filesBusy = files.some((file) => file.status !== "ready");
  const sameDraftPending = sendRecords.some(record => record.draftId === draftSessionRef.current?.draftId
    && record.draftRevision === draftSessionRef.current?.revision);
  const send = async () => {
    const body = groupDraftBody(draftText, mentionableMembers);
    const attachments = files.flatMap((file) => file.attachment ? [file.attachment] : []);
    const session = draftSessionRef.current;
    if (!currentScope() || (!body && attachments.length === 0) || filesBusy || sending || !view || view.group.status !== "active"
      || !journalReady || !session || !ownerScope || session.ownerScope !== ownerScope) return;
    const typed = draftText.mentions.flatMap(span => {
      const member = mentionableMembers.find(candidate => candidate.id === span.memberId);
      return member && normalize(draft.slice(span.start + 1, span.end)) === normalize(member.handle) ? [member.id] : [];
    });
    const mentions = [...new Set([...sendTargetMentions(prefillKey !== null ? prefill : null, mentionableMembers, ownerId), ...typed])];
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
      retainTelemetryOperation(telemetrySends, record.key, startTelemetryOperation("group_chat_send", "shoggoth"));
      await dispatchRecord(record, session, generation);
    } catch (cause) {
      if (currentScope() && generation === generationRef.current) { setJournalError(cause instanceof Error ? cause.message : String(cause)); toast.error(cause instanceof Error ? cause.message : String(cause)); }
    } finally {
      if (currentScope() && generation === generationRef.current) { setSending(false); void refreshSendRecords(); }
    }
  };

  const acceptRecord = async (record: GroupSendRecord, message: GroupChatMessage, discussionId: string | null,
    session: GroupDraftSession | null, generation: number) => {
    telemetrySends.get(record.key)?.finish("success");
    telemetrySends.delete(record.key);
    const consumed = session?.ownerScope === record.ownerScope && session.groupId === record.groupId
      ? await session.accepted(record, message, discussionId)
      : (await groupSendJournal.accepted(record, message, discussionId), false);
    if (!currentScope() || generation !== generationRef.current || currentGroupRef.current !== record.groupId
      || ownerScopeRef.current !== record.ownerScope) return;
    mutationRevisionRef.current++;
    if (consumed && draftSessionRef.current === session) {
      for (const file of filesRef.current) if (file.preview) URL.revokeObjectURL(file.preview);
      const sentTarget = record.composerSnapshot.sendTarget;
      applyComposer({ ...emptyGroupComposer(), ...(sentTarget ? { sendTarget: { ...sentTarget, afterSeq: message.seq } } : {}) });
      setMention(null);
    }
    stickToBottomRef.current = true; append([message]); void pull();
  };
  const dispatchRecord = async (record: GroupSendRecord, session: GroupDraftSession | null, generation: number) => {
    if (!currentScope() || dispatchingRef.current.has(record.key)) return;
    dispatchingRef.current.add(record.key);
    try {
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
        if (refused) {
          telemetrySends.get(record.key)?.finish("error", cause);
          telemetrySends.delete(record.key);
        }
        await groupSendJournal.update(submitting, { phase: refused ? "rejected" : "needs_verification",
          lastError: cause instanceof Error ? cause.message : String(cause), lastCheckedAt: Date.now() });
        if (currentScope() && generation === generationRef.current) toast.error(refused
          ? cause instanceof Error ? cause.message : String(cause)
          : t("groupChat.sendJournal.uncertainToast"));
      }
    } finally { dispatchingRef.current.delete(record.key); }
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
  const receiptSignature = sendRecords.map(record => `${record.key}:${record.phase}`).join("|");
  useEffect(() => {
    if (!journalReady || !ownerScope) return;
    let disposed = false, checking = false, again = false, attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Recovery checks originals only. Neither prepared nor uncertain entries are replayed.
    const check = () => {
      if (disposed || !currentScope()) return;
      clearTimeout(timer);
      if (checking) { again = true; return; }
      checking = true;
      let pendingReceipt = false;
      void groupSendJournal.read(ownerScope, groupId).then(async state => {
        if (disposed || !currentScope()) return;
        const pending = state.sends.filter(record => record.phase !== "observed" && record.phase !== "rejected"
          && !dispatchingRef.current.has(record.key));
        pendingReceipt = pending.length > 0;
        let index = 0;
        await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
          while (!disposed && currentScope() && index < pending.length) await verifyRecord(pending[index++]);
        }));
      }).catch(() => { pendingReceipt = true; }).finally(() => {
        checking = false;
        if (disposed || !currentScope()) return;
        if (again) { again = false; check(); }
        else if (pendingReceipt) timer = setTimeout(check, Math.min(30_000, 2_000 * 2 ** Math.min(attempts++, 4)));
      });
    };
    check();
    const off = onGroupChanged(changed => { if (changed === groupId) check(); });
    if (typeof window !== "undefined") { window.addEventListener("online", check); window.addEventListener("focus", check); window.addEventListener(GROUP_CONNECTION_EVENT, check); }
    return () => { disposed = true; clearTimeout(timer); off(); if (typeof window !== "undefined") { window.removeEventListener("online", check); window.removeEventListener("focus", check); window.removeEventListener(GROUP_CONNECTION_EVENT, check); } };
  }, [groupId, journalReady, ownerScope, verifyRecord, currentScope,
    receiptSignature]);
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
      retainTelemetryOperation(telemetrySends, prepared.key, startTelemetryOperation("group_chat_send", "shoggoth"));
      await dispatchRecord(prepared, null, generation);
    } catch (cause) { if (currentScope() && generation === generationRef.current) setJournalError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (currentScope() && generation === generationRef.current) { setSending(false); void refreshSendRecords(); } }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, selection: GroupComposerSelection) => {
    if (event.nativeEvent.isComposing) return;
    const { start, end, includesPrefill } = selection;
    const edit = (from: number, to: number, insert: string, clearPrefill: boolean) => {
      event.preventDefault();
      const caret = from + insert.length;
      updateDraft(replaceGroupDraftText(draftText, from, to, insert),
        { start: caret, end: caret, includesPrefill: false }, clearPrefill, false);
      focusComposerAt(caret);
    };
    if (event.key === "Backspace" || event.key === "Delete") {
      if (includesPrefill || showPrefill && start === 0 && end === 0 && (event.key === "Backspace" || !draft)) {
        edit(start, end, "", true);
        return;
      }
      if (start === end) {
        const token = draftText.mentions.find(span => event.key === "Delete" ? span.start === start
          : span.end === start || span.end + 1 === start && draft[span.end] === " ");
        if (token) {
          edit(token.start, token.end + (draft[token.end] === " " ? 1 : 0), "", false);
          return;
        }
      }
    }
    if (mention && candidates.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + candidates.length) % candidates.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pickMention(candidates[activeMentionIndex]);
        return;
      }
      if (event.key === "Escape") { event.preventDefault(); setMention(null); return; }
    }
    if (event.key === "Enter") {
      if (event.shiftKey) { edit(start, end, "\n", includesPrefill); return; }
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
    if (!view || !currentScope() || deletingScopeRef.current === scopeKey) return;
    const force = view.group.status === "deleting";
    deletingScopeRef.current = scopeKey; setDeletingScope(scopeKey);
    try {
      // A pending delete response changes the local status before its new revision is read.
      const target = force ? await getGroupChat(groupId) : view;
      if (!currentScope() || target.group.id !== groupId || target.ownerScope !== view.ownerScope) return;
      const forceOptions = force && target.group.status === "deleting" && target.ownerScope
        ? { force: true as const, ownerScope: target.ownerScope } : undefined;
      if (force && !forceOptions) { void pull(); return; }
      const title = t(force ? "groupChat.forceDelete" : "groupChat.delete");
      const ok = await confirm({ title, danger: true, ...(force ? { confirmLabel: title, focusCancel: true,
        message: t("groupChat.forceDeleteConfirm", { name: target.group.name }) } : { message: t("groupChat.deleteConfirm") }) });
      if (!ok || !currentScope()) return;
      mutationRevisionRef.current++;
      const revision = target.group.metadataRevision;
      const result = forceOptions ? await deleteGroupChat(groupId, revision, forceOptions) : await deleteGroupChat(groupId, revision);
      if (!currentScope()) return;
      mutationRevisionRef.current++;
      cache?.delete(groupId);
      if (result.status === "deleted") onArchived();
      else { setView(previous => previous && ({ ...previous, group: { ...previous.group, status: "deleting" } })); void pull(); }
    } catch (cause) {
      if (!currentScope()) return;
      if ((cause as { code?: string })?.code === "GROUP_CHAT_DELETED") { cache?.delete(groupId); onArchived(); return; }
      toast.error(cause instanceof Error ? cause.message : String(cause)); void pull();
    } finally {
      if (deletingScopeRef.current === scopeKey) { deletingScopeRef.current = null; if (currentScope()) setDeletingScope(null); }
    }
  };

  const removeMember = async (member: GroupChatMember) => {
    const canRemove = () => {
      const latest = latestViewRef.current;
      return currentScope() && latest?.group.status === "active" && deletingScopeRef.current !== scopeKey
        && latest.members.filter(item => item.state === "active").length > GROUP_MIN_MEMBERS
        && latest.members.some(item => item.id === member.id && item.state === "active");
    };
    if (!canRemove() || removingMemberScopeRef.current === scopeKey) return;
    removingMemberScopeRef.current = scopeKey; setRemovingMemberScope(scopeKey);
    try {
      const ok = await confirm({ title: t("groupChat.members.remove"), confirmLabel: t("common.confirm"), danger: true, focusCancel: true,
        message: t("groupChat.members.removeConfirm", { name: member.displayName }) });
      const latest = latestViewRef.current;
      if (!ok || !latest?.ownerScope || !canRemove()) return;
      mutationRevisionRef.current++;
      applyView(await updateGroupChatMembers(groupId, { ownerScope: latest.ownerScope,
        expectedRosterRevision: latest.group.rosterRevision, addMembers: [], removeMemberIds: [member.id],
      }));
    } catch (cause) {
      if (currentScope()) { toast.error(cause instanceof Error ? cause.message : String(cause)); void pull(); }
    } finally {
      if (removingMemberScopeRef.current === scopeKey) {
        removingMemberScopeRef.current = null;
        if (currentScope()) setRemovingMemberScope(null);
      }
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
    .filter(item => settledTurnMembers.get(item.opportunityId) !== item.memberId
      && !view.activeTurns.some(turn => turn.opportunityId === item.opportunityId && stoppedSpeech(turn)));
  const speaking = view.activeTurns.flatMap((turn) => {
    const member = membersById.get(turn.memberId);
    if (!member || stoppedSpeech(turn) || settledTurnMembers.get(turn.opportunityId) === turn.memberId) return [];
    const activity = boundGroupActivity(turn.activity, { groupId, memberId: member.id, opportunityId: turn.opportunityId });
    // A replacement run or stream starts a separate activity view even if it reuses tool IDs.
    const activityKey = activity ? JSON.stringify([scopeKey, member.id, turn.opportunityId,
      activity.runId, activity.executionGeneration, activity.streamGeneration]) : null;
    return [{ turn, member, activity, activityKey }];
  });
  const answering = speaking.filter((item) => {
    const phase = item.activity?.phase;
    return item.turn.dispatchState !== "queued" && !item.turn.recovery && !item.turn.stopping
      && !["queued", "preparing", "reconciling", "stopping", "completed", "failed", "cancelled", "waiting_approval", "waiting_input"].includes(phase ?? "")
      && !interactions.some(interaction => interaction.opportunityId === item.turn.opportunityId && interaction.status === "pending");
  });
  const speakingIds = new Set(speaking.map((item) => item.member.id));
  const archived = view.group.status !== "active";
  const selectedActivity = !archived && selectedActivityKey ? speaking.find(({ activityKey, activity, turn }) =>
    activityKey === selectedActivityKey && activity && !groupActivityEnded(activity.phase) && !turn.stopping && !turn.recovery) : undefined;
  const timeline = orderGroupTimeline([
    ...messages.filter(message => message.author.kind === "system" || (!presentation.hidden.has(message.id)
      && (!MESSAGE_PINNING_ENABLED || !pinnedOnly || pins.some(pin => pin.id === message.id))))
      .map(message => ({ key: `message:${message.id}`, kind: "message" as const, message, seq: message.seq, createdAt: message.createdAt })),
    ...speaking.map(item => ({ ...item, key: `turn:${item.turn.opportunityId}`, kind: "turn" as const,
      createdAt: item.turn.startedAt ?? 0 })),
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
  const quote = (message: GroupChatMessage) => {
    if (!journalReady || archived || !currentScope()) return;
    setReplyTo(message);
    // A member quote already provides its recipient; an explicit @ can still override it.
    if (message.author.kind === "member") removePrefill();
    else holdTarget();
    requestAnimationFrame(() => { if (currentScope()) composerInput.current?.focus(); });
  };
  const jumpTo = (seq: number) => listRef.current?.querySelector(`[data-seq="${seq}"]`)
    ?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  const openMessageMenu = (event: MouseEvent, message: GroupChatMessage) => {
    if (!currentScope()) return;
    event.preventDefault(); event.stopPropagation();
    const id = event.target && event.target instanceof Element ? event.target.closest("[data-chat-attachment]")?.getAttribute("data-chat-attachment") : null;
    const attachment = messageAttachments.get(message.id)?.find(item => item.id === id);
    setMessageMenu({ scope: scopeKey, x: event.clientX, y: event.clientY, message,
      attachment: attachment ? clipboardAttachment(attachment) : undefined });
  };
  const messageText = (message: GroupChatMessage) => message.author.kind === "member" ? groupReplyBody(message) : message.body;
  const clipboardAttachment = (item: InspirationAttachment): ChatClipboardAttachment => ({
    kind: item.mimeType.startsWith("image/") ? "image" : "file", name: item.name,
    src: inspirationMediaUrl(item.id), preview: item.mimeType.startsWith("image/") ? inspirationMediaUrl(item.id, true) : undefined,
  });
  const copyMessage = async (message: GroupChatMessage, attachment?: ChatClipboardAttachment) => {
    if (!currentScope()) return;
    const text = attachment ? "" : messageText(message);
    const media = attachment ? [attachment] : (messageAttachments.get(message.id) ?? []).map(clipboardAttachment);
    try {
      const copied = await writeChatClipboard(text, media, currentScope);
      if (copied && currentScope()) toast.success(t("chat.copied"));
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
    const hasAttachments = !!messageAttachments.get(message.id)?.length;
    const copyLabel = t(hasAttachments ? "chat.copy" : "chat.copyAsMarkdown");
    const origin = message.origin;
    const activitySource = ownerScope && message.author.kind === "member" && origin?.opportunityId && origin.runId
      && origin.discussionId && !origin.partial && !origin.streaming ? {
        ownerScope, groupId, messageId: message.id, seq: message.seq, memberId: message.author.memberId,
        opportunityId: origin.opportunityId, runId: origin.runId, discussionId: origin.discussionId,
      } : null;
    return <div className="chat-group__footer" data-group-message-footer={message.id}>
      {message.createdAt ? <time data-group-message-time={message.id} dateTime={new Date(message.createdAt).toISOString()}>{formatChatTime(message.createdAt)}</time> : null}
      {message.author.kind === "member" && <ChatResponseMetadata metadata={message.responseMetadata} />}
      {activitySource && <button type="button" className="chat-copybtn" data-chat-footer-icon="" aria-haspopup="dialog"
        title={t("turnLab.processOpen")} aria-label={t("turnLab.processOpen")}
        onClick={() => { if (currentScope()) { setSelectedActivityKey(null); setMessageActivity({ scope: scopeKey, source: activitySource }); } }}>
        <IconTrajectory />
      </button>}
      {(messageText(message).trim() || hasAttachments) && <button type="button" className="chat-copybtn" data-chat-footer-icon=""
        title={copyLabel} aria-label={copyLabel} onClick={() => void copyMessage(message)}><IconCopy /></button>}
      {!archived && <button type="button" className="chat-copybtn" data-chat-footer-icon="" title={t("chat.quote")}
        aria-label={t("chat.quote")} disabled={!journalReady} onClick={() => quote(message)}><IconQuote /></button>}
      {MESSAGE_PINNING_ENABLED && <button type="button" className={pinned ? "chat-copybtn is-pinned" : "chat-copybtn"}
        title={t(pinned ? "chat.unpin" : "chat.pin")} aria-label={t(pinned ? "chat.unpin" : "chat.pin")}
        aria-pressed={pinned} onClick={() => pinMessage(message)}><IconPin /></button>}
      {MESSAGE_DELETION_ENABLED && <button type="button" className="chat-copybtn" title={t("chat.deleteLocal")} aria-label={t("chat.deleteLocal")}
        onClick={() => hideMessage(message)}><IconTrash /></button>}
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
      <IconQuote className="chat-quote-icon" />
      <span className={styles.quoteAuthor}>{authorName(reply.author)}</span>
      {quotePreview(reply.excerpt, attachments)}
    </button>;
  };
  // 消息里的附件：样式与单聊一致（图片缩略图点开大图，其余是文件条）。
  const attachmentRow = (message: GroupChatMessage) => (messageAttachments.get(message.id)?.length ?? 0) > 0 && (
    <div className="chat-att-row">
      {messageAttachments.get(message.id)!.map((item) => item.mimeType.startsWith("image/") ? (
        <img key={item.id} className="chat-att-thumb" src={inspirationMediaUrl(item.id, true)} alt={item.name}
          data-chat-attachment={item.id}
          onClick={() => setLightbox(inspirationMediaUrl(item.id, true))} />
      ) : (
        <ChatFileButton key={item.id} name={item.name}
          data-chat-attachment={item.id}
          title={`${t("chat.artifactsRevealInFolder")} · ${item.name}`}
          onClick={() => void revealAttachment(item.name, inspirationMediaUrl(item.id))
            .catch((cause) => toast.error(t("chat.artifactsRevealFailed", { msg: cause instanceof Error ? cause.message : String(cause) })))} />
      ))}
    </div>
  );
  const visibleMessageIds = new Set<string>();
  for (const entry of timeline) {
    if (entry.kind === "message") visibleMessageIds.add(entry.message.id);
  }
  const authorHeader = (member: GroupChatMember | undefined) => (
    <span className={styles.author} data-group-author>
      <GroupMemberAvatar member={member} className={styles.authorAvatar} />
      <span className={styles.authorName}>{member?.displayName ?? t("groupChat.someMember")}</span>
    </span>
  );
  const expand = (panel: "members" | "files") => {
    readingPositionRef.current = listRef.current?.scrollTop ?? null;
    setMessageMenu(null);
    setExpandedPanel(panel);
  };

  return (
    <div className={styles.panel}>
      <GroupChatActivityDialog key={scopeKey} activity={selectedActivity?.activity ?? null}
        memberName={selectedActivity?.member.displayName} startedAt={selectedActivity?.turn.startedAt}
        onClose={() => setSelectedActivityKey(key => key === selectedActivityKey ? null : key)} />
      {messageActivity?.scope === scopeKey && <GroupChatMessageActivityDialog key={messageActivity.source.messageId}
        source={messageActivity.source} memberName={membersById.get(messageActivity.source.memberId)?.displayName}
        onClose={() => setMessageActivity(current => current === messageActivity ? null : current)} />}
      {settingsOpen && <GroupChatSettings key={`settings:${scopeKey}`} view={view} onView={applyView} onClose={() => { if (currentScope()) setSettingsOpen(false); }} />}
      {sendRecordsOpen && <Modal open width={680} title={t("groupChat.sendJournal.open")} onClose={() => setSendRecordsOpen(false)}>
        <div data-group-send-records>
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
          <p>{t("groupChat.sendJournal.backgroundHint")}</p>
          {[...sendRecords].sort((a, b) => b.createdAt - a.createdAt)
            .slice(Math.min(sendRecordPage, Math.floor((sendRecords.length - 1) / 20)) * 20, (Math.min(sendRecordPage, Math.floor((sendRecords.length - 1) / 20)) + 1) * 20)
            .map(record => <details key={record.key} data-send-id={record.clientMessageId}>
            <summary>{t(`groupChat.sendJournal.${record.phase}`)} · {excerptOf(record.inputSnapshot.body || record.inputSnapshot.attachments?.map(file => file.name).join("、") || "", 70)}</summary>
            <p data-selectable-text>{record.inputSnapshot.body}</p>
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
        {!sendRecords.length && <p className={styles.muted}>{t("groupChat.sendJournal.empty")}</p>}
        </div>
      </Modal>}
      {adding && (
        <Suspense fallback={null}><GroupChatAddMemberModal key={`add:${scopeKey}`} view={view} candidates={agents} backends={backends} isCurrentScope={currentScope}
          onView={applyView} onRefresh={pull} onClose={() => { if (currentScope()) setAdding(false); }} /></Suspense>
      )}
      {expandedPanel && <Suspense fallback={<div className={styles.expandedLoading} role="status"><FusionLoader size="sm" /></div>}>
        {expandedPanel === "members" ? <GroupChatDetails key={`details:${scopeKey}`} view={view}
          onClose={() => setExpandedPanel(null)}
          onAddMember={!archived ? () => setAdding(true) : undefined}
          onRemoveMember={member => void removeMember(member)} removingMember={removingMemberScope === scopeKey}
          onRename={() => void rename()} onSettings={() => setSettingsOpen(true)}
          onDelete={() => void removeGroup()} deleting={deletingScope === scopeKey} />
          : <GroupChatFiles key={`files:${scopeKey}`} view={view} onClose={() => setExpandedPanel(null)} />}
      </Suspense>}
      <div className={styles.chatContent} hidden={expandedPanel !== null}>
      <div className="chat-topdock">
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
          <button type="button" className={`chat-headbtn chat-artifacts-trigger ${styles.filesTrigger}`} data-group-files-trigger
            title={t("groupChat.files.open")} aria-label={t("groupChat.files.open")}
            aria-expanded={expandedPanel === "files"}
            onClick={() => expand("files")}>
            <img src={groupFilesTrigger} alt="" />
          </button>
        </div>
        {view.group.status === "deleting" && <p role="status" className={styles.muted}>{t("groupChat.deletingNotice")}</p>}
        {expiredSearchScope === scopeKey && <p role="alert" className={styles.error}>{t("chat.globalSearchGroupLocateFailed")}</p>}
        {unavailableMembers.length > 0 && <div className={styles.availability} role="status">
          {t("groupChat.owner.offline", { names: unavailableMembers.map(member => member.displayName).join("、") })}
        </div>}
      </header>
      <ChatPinnedMessages items={pins} index={pinIndex} onIndex={setPinIndex} onJump={id => void jumpToPin(id)}
        onUnpin={id => { if (currentScope()) presentation.unpin(id); }} pinnedOnly={pinnedOnly} onToggle={() => setPinnedOnly(value => !value)} />
      </div>
      {messageUndo?.scope === scopeKey && <div className="chat-toast chat-toast--success" role="status">
        <span className="chat-toast__text">{t("chat.hiddenN", { count: 1 })}</span>
        <button type="button" className="chat-toast__act" onClick={() => {
          if (!currentScope()) return;
          presentation.restore(messageUndo.id); setMessageUndo(null);
        }}>{t("chat.undo")}</button>
      </div>}
      {journalRecoveryOpen && ownerScope && <GroupChatJournalRecovery key={`journal:${scopeKey}`}
        ownerScope={ownerScope} groupId={groupId} onClose={() => { if (currentScope()) setJournalRecoveryOpen(false); setSendRecordsOpen(false); }} />}
      {searchOpen && <GroupChatSearch key={`search:${scopeKey}`} view={view} onClose={() => { if (currentScope()) setSearchOpen(false); }}
        onOpenMessage={message => { if (!currentScope()) return; setSearchOpen(false); setFullMessage(message); }} />}
      {referenceOpen && <GroupChatReference key={`reference:${scopeKey}`} onClose={() => { if (currentScope()) setReferenceOpen(false); }} onInsert={excerpt => {
        if (!journalReady || archived || !currentScope()) return false;
        const next = appendGroupReference(draft, excerpt);
        if (next === null) { toast.error(t("groupChat.reference.tooLarge")); return false; }
        setDraft(next); holdTarget(); composerInput.current?.focus(); return true;
      }} />}
      <div className={`chat-group-thread ${styles.timeline}`} data-group-timeline ref={listRef} onWheel={(event) => {
        if (event.deltaY < 0 && event.currentTarget.scrollTop < 60) void loadOlder();
      }} onScroll={(event) => {
        if (expandedPanel !== null || !event.currentTarget.clientHeight) return;
        const el = event.currentTarget;
        stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        setShowJump(!stickToBottomRef.current);
      }}>
      <div className="chat-thread__inner">
        {hasOlder && (olderLoadState === "loading" ? (
          <div className="chat-archive-bar is-note is-loading">
            <FusionLoader size="sm" label={t("chat.historyLoadingEarlier")} />
          </div>
        ) : (
          <button type="button" className={`chat-archive-bar ${olderLoadState === "error" ? "is-retry" : "is-action"}`} onClick={() => void loadOlder()}>
            {t(olderLoadState === "error" ? "groupChat.retryOlder" : "groupChat.loadOlder")}
          </button>
        ))}
        {messages.length === 0 && speaking.length === 0 && interactions.length === 0 && <div className={styles.empty}>{t("groupChat.emptyTimeline")}</div>}
        {timeline.map(entry => {
          if (entry.kind === "turn") {
            const { turn, member, activity, activityKey } = entry;
            const waitingForInteraction = interactions.some(item => item.opportunityId === turn.opportunityId && item.status === "pending");
            const stopping = Boolean(turn.stopping || turn.recovery?.cancelRequested);
            const phase = stopping ? "stopping" : turn.recovery ? "reconciling"
              : activity?.phase ?? (turn.dispatchState === "queued" ? "queued" : "running");
            const idleReleased = turn.released && turn.releasedReason === "idle" && !stopping;
            const quietRecovery = idleReleased || stopping || turn.recovery?.type === "execution";
            const canAnswer = answering.some(item => item.turn.opportunityId === turn.opportunityId);
            const publishedIds = new Set(messages.filter(message => message.origin?.opportunityId === turn.opportunityId)
              .flatMap(message => (message.replyMessages ?? []).map(item => item.id)));
            const replyMessages = (stopping || turn.individualMessages ? [] : activity?.textMessages?.length ? activity.textMessages
              : turn.floor && turn.draft?.trim() && !turn.recovery ? [{ id: "draft", text: turn.draft, pending: true }] : [])
              .filter(item => item.text.trim() && !publishedIds.has(item.id));
            const publishedStreaming = turn.individualMessages && messages.some(message => visibleMessageIds.has(message.id)
              && message.author.kind === "member" && message.author.memberId === member.id
              && message.origin?.opportunityId === turn.opportunityId && message.origin.streaming);
            const loading = !idleReleased && !publishedStreaming && !replyMessages.some(item => item.pending && canAnswer) && !waitingForInteraction
              && !turn.recovery && !stopping && turn.queueReason !== "execution_unconfirmed"
              && !groupActivityEnded(phase);
            const steps = loading && activity ? groupActivitySteps(activity) : [];
            const openActivity = activityKey && steps.length > 0
              ? () => { if (currentScope()) setSelectedActivityKey(activityKey); } : undefined;
            const notice = !quietRecovery && (turn.recovery?.type === "result" || turn.queueReason === "execution_unconfirmed");
            if (!replyMessages.length && !loading && !notice) return null;
            return (
          <div key={`turn:${turn.opportunityId}`} className="chat-group is-assistant"
            data-group-execution={turn.opportunityId} data-group-member={member.id}>
            <div className="chat-group__stack">
              {authorHeader(member)}
              {replyMessages.map(item => <div key={item.id} className={`chat-bubble${item.pending && canAnswer ? " is-streaming" : ""}`}
                data-group-reply-message={item.id} data-activity-phase={phase} aria-live={item.pending && canAnswer ? "polite" : undefined}>
                <GroupChatMarkdown text={item.text} className="chat-md" members={view.members}
                  streamingCursor={item.pending && canAnswer} />
              </div>)}
              {loading && <ChatLiveActivityBubble className="chat-bubble" activityPhase={phase} onOpen={openActivity}
                preview={openActivity && <TurnTimeline key={activityKey} steps={steps} status="running" onOpenPreview={openActivity} />} />}
              {notice && <div className="chat-bubble" data-activity-phase={phase}>
                {turn.queueReason === "execution_unconfirmed" && <p className={styles.muted}>{t("groupChat.queueBlocked")}</p>}
                {turn.recovery && <GroupChatRecovery recovery={turn.recovery} />}
              </div>}
            </div>
          </div>
        );
          }
          if (entry.kind === "interaction") {
            const { item } = entry;
          const member = membersById.get(item.memberId);
          const approval = item.request.fields?.length === 0;
          const prompt = <>
            {(!approval || item.status !== "pending") && <p className={styles.muted}>{t(item.status === "pending" ? "groupChat.interaction.waiting" : "groupChat.interaction.continuing",
              { name: member?.displayName ?? t("groupChat.someMember") })}</p>}
            {item.status === "pending" && (
              <>
                {item.context?.command && <pre className="chat-prompt__cmd">{item.context.command}</pre>}
                <ChatPromptCard key={item.request.requestId} compactInput
                  draftKey={`group:${item.opportunityId}:${item.request.requestId}`} agentName={member?.displayName}
                  entry={{ ...item.request, id: item.request.requestId }}
                  onRespond={(_entry, data) => respond(item.opportunityId, item.request.requestId, data)} />
              </>
            )}
          </>;
          return (
            <div key={`interaction:${item.opportunityId}:${item.request.requestId}`} className="chat-group is-assistant" data-card-interactive
              data-group-interaction={item.request.requestId} data-group-member={item.memberId}>
              <div className="chat-group__stack">
                {authorHeader(member)}
                {approval ? prompt : <div className={`chat-bubble ${styles.liveBubble}`}>{prompt}</div>}
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
                  {(message.body.trim() || message.mentions.memberIds.length > 0) && <GroupChatMarkdown text={message.body} className="chat-bubble chat-md"
                    members={view.members} addressedMemberIds={message.mentions.memberIds} broadcast={message.mentions.broadcast} />}
                  {attachmentRow(message)}
                  {fullResultNote}
                  {message.mentions.unresolved.length > 0 && (
                    <div className={styles.note}>{t("groupChat.unresolved", {
                      handles: message.mentions.unresolved.map((handle) => `@${handle}`).join("、") })}</div>
                  )}
                  {messageFooter(message)}
                </div>
              </div>
            );
          }
          const bubbles = groupReplyBubbles(message);
          const member = membersById.get(message.author.memberId);
          const streaming = Boolean(message.origin?.streaming && !view.activeTurns.some(turn =>
            turn.opportunityId === message.origin?.opportunityId
              && (stoppedSpeech(turn) || turn.stopping || turn.recovery?.cancelRequested)));
          return (
            <div key={message.seq} data-seq={message.seq} className={`chat-group is-assistant ${styles.msg}`}
              onContextMenu={event => openMessageMenu(event, message)}>
              <div className="chat-group__stack">
                {authorHeader(member)}
                {quoteBlock(message)}
                {bubbles.map(item => <GroupChatMarkdown key={item.id} text={item.text}
                  className={`chat-bubble chat-md${streaming ? " is-streaming" : ""}`}
                  members={view.members} broadcast={message.mentions.broadcast} streamingCursor={streaming} />)}
                {attachmentRow(message)}
                {fullResultNote}
                {messageFooter(message)}
              </div>
            </div>
          );

        })}
      </div>
      </div>

      <div className="chat-botdock">
      {showJump && <button type="button" className="chat-jump" data-group-jump-latest
        onClick={jumpToLatest} title={t("chat.jumpToLatest")}>
        ↓ {t("chat.latestMessage")}
      </button>}
      <div className={`chat-composer ${styles.composer}`} data-chat-composer
        onDragOver={archived || !journalReady ? undefined : (event) => event.preventDefault()}
        onDrop={archived || !journalReady ? undefined : (event) => {
          if (event.dataTransfer.files.length === 0) return;
          event.preventDefault(); addFiles(Array.from(event.dataTransfer.files));
        }}>
        {activeMentionId && (
          <div className={`chat-composer-menu-surface chat-mention-menu ${styles.mentionMenu}`} id={mentionMenuId} role="listbox"
            aria-label={t("groupChat.composer.mention")}>
            <div className="model-menu__list" ref={mentionList}>
              {candidates.map((member, index) => (
                <button type="button" key={member?.id ?? "all"} id={`${mentionMenuId}-${member?.id ?? "all"}`} role="option" tabIndex={-1}
                  aria-selected={index === activeMentionIndex} className={`model-menu__item${index === activeMentionIndex ? " is-active" : ""}`}
                  onMouseDown={(event) => event.preventDefault()} onClick={() => pickMention(member)}>
                  {member ? <GroupMemberAvatar member={member} className={styles.memberAvatar} />
                    : <GroupMentionAvatarStack members={mentionableMembers} />}
                  <span className="model-menu__name">{member?.displayName ?? t("groupChat.target.all")}</span>
                  <span className={styles.mentionHandle}>@{member?.handle ?? "all"}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {replyTo && (
          <div className={`chat-quote-bar ${styles.replyChip}`}>
            <IconQuote className="chat-quote-icon" />
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
        <GroupChatComposerInput ref={composerInput} value={draftText} members={membersById} mentionableMembers={mentionableMembers}
          disabled={archived || !journalReady} label={t("groupChat.composer.message")} menuId={mentionMenuId}
          prefill={showPrefill ? { memberId: prefillMember?.id ?? null, text: `@${prefillMember?.handle ?? "all"}` } : null}
          activeOption={activeMentionId}
          onChange={updateDraft} onOpenMention={openTokenMention} onKeyDown={onKeyDown} onPaste={onPaste} onDismissMenu={() => setMention(null)} />
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
          </div>
          <div className="chat-composer__right">
            <button type="button" className="chat-iconbtn" title={t("chat.attachFile")} aria-label={t("chat.attachFile")}
              disabled={archived || !journalReady || files.length >= MAX_INSPIRATION_ATTACHMENTS} onClick={() => fileInputRef.current?.click()}>
              <IconClip />
            </button>
            {showStop && (
              <button type="button" className="chat-iconbtn chat-send chat-stop"
                title={t(stopPending ? "groupChat.stopState.requesting" : !canStopDiscussion ? "groupChat.stopState.confirming" : "groupChat.stop")}
                aria-label={t(stopPending ? "groupChat.stopState.requesting" : !canStopDiscussion ? "groupChat.stopState.confirming" : "groupChat.stop")}
                disabled={stopPending || !canStopDiscussion} aria-busy={stopPending}
                onClick={() => void stopDiscussion()}><IconStop /></button>
            )}
            {!showStop && (
              <button type="button" className="chat-iconbtn chat-send" title={t("groupChat.send")} aria-label={t("groupChat.send")}
                onClick={() => void send()} disabled={(!draft.trim() && files.length === 0) || filesBusy || sending || archived || !journalReady || !!journalError || sameDraftPending}>
                <IconSend />
              </button>
            )}
          </div>
        </div>
      </div>
      </div>
      {fullMessage && <GroupChatFullMessage key={`${scopeKey}:${fullMessage.id}`} groupId={groupId} message={fullMessage} members={view.members}
        onClose={() => { if (currentScope()) setFullMessage(null); }} />}
      {messageMenu?.scope === scopeKey && <ChatMessageContextMenu x={messageMenu.x} y={messageMenu.y}
        onClose={() => setMessageMenu(null)} onCopy={messageText(messageMenu.message) || messageAttachments.get(messageMenu.message.id)?.length
          ? () => void copyMessage(messageMenu.message, messageMenu.attachment) : undefined}
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
        <GroupMemberAvatar key={member.id} member={member} className={styles.groupAvatarItem} />
      ))}
    </span>
  );
}
