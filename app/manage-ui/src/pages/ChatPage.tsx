import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type WheelEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { formatChatTime as absTime } from "../lib/chatTime";
import { validPluginAppCallId } from "../lib/turnTimeline";
import { observedChatTerminal } from "../lib/chatTerminalObservation";
import { codexDesktopWriterHintKey, type CodexDesktopWriterState } from "../lib/codexDesktopWriter";
import { ChatRunWait, chatRunWaitState, type ChatRunWaitState } from "../components/ChatRunWait";
import ChatContextUsage from "../components/ChatContextUsage";
import { useSessionRuntimeModels } from "../lib/useSessionRuntimeModels";
import type { RuntimeContextUsage, RuntimeContextCapabilities, ProductContextState, ChatResponseMetadata as ResponseMetadata } from "../types";
import ChatResponseMetadata from "./ChatResponseMetadata";
import { compactConversation } from "../api/client";
import { setInspirationChatSession } from "../lib/inspiration-navigation";
import { toSanitizedMarkdownHtml, formatReasoningMarkdown } from "../lib/markdown";
import ChatMarkdown from "../components/ChatMarkdown";
import ChatPlanDock from "../components/ChatPlanDock";
import { chatMessagesWithoutPlans, latestChatPlan, withoutPlanSteps, type ChatPlanEntry as PlanEntry } from "../lib/chatPlan";
import ChatUiArtifact from "../components/ChatUiArtifact";
import LegacyChatUi from "../components/LegacyChatUi";
import { revokeNativeUiEntries } from "../lib/chatUiDesktop";
import { normalizeNativeUiPart, nativeUiSummary, groupNativeUiHistory, nativeUiLegacySources, type NativeUiArtifactPart } from "../lib/chatUiContent";
import { createNativeChatFrameAssembler } from "../lib/nativeChatUiFrames";
import { ChatMediaContext } from "../components/ChatMediaContext";
import { installHtmlArtifacts, setSendPromptHandler, setHtmlArtifactScope } from "../lib/htmlArtifacts";
import { readXHighCache, writeXHighCache, probeXHigh } from "../lib/thinkingCapability";
import { resizeToSquarePng, uploadAvatar } from "../lib/avatar";
import AgentAvatarView from "../components/AgentAvatar";
import { imgCacheKey, putImages, getImages, fileCacheKey, putFiles, getFiles } from "../lib/imageCache";
import {
  clearCachedChatHistoryExcept,
  deleteCachedChatHistory,
  getCachedChatHistory,
  putCachedChatHistory,
} from "../lib/chatHistoryCache";
import { CHAT_HISTORY_PAGE_SIZE, createChatHistoryPager } from "../lib/chatHistoryPager";
import {
  canSendSession as canSendSessionByReadiness,
  createChatHistoryController as createHistoryController,
  createChatSendController as createSendController,
  type ChatSendController,
} from "../lib/chatHistoryRuntime";
import { extractAgentMedia } from "../lib/agentMedia";
import { SlashCatalogStore } from "../lib/slashCatalog";
import { translateSlashDescription } from "../lib/slashDescription";
import {
  canRunSlashDuringTurn,
  canRunServerSlashDuringTurn,
  filterSlashCommands,
  isSlashCommandInput,
  mergeNativeSlashCommands,
  parseSlashInput,
  recoverySlashCommandsForBackend,
  shouldHandleSlashLocally,
  slashArgQuery,
  slashQuery,
  CATEGORY_LABELS,
  SLASH_COMMANDS,
  type SlashCommand,
} from "../lib/slashCommands";
import { translateGatewayError } from "../lib/gatewayErrors";
import { createExecApprovalController, isOpenClawExecApproval } from "../lib/openclawExecApprovals";
import {
  buildChatSendParams,
  nativeChatMedia,
  buildCompactParams,
  clearLiveTurnState,
  createLatestRequestGuard,
  findChatSearchGroupKey,
  keyedChatChildren,
  keyedChatGroups,
  keyedChatMessages,
  gatewayRequestPayloadBudget,
  parseQuoteFromText,
  rejectPendingRpcForSocket,
  retryChatAttachments,
  takePendingRpc,
  type ChatAttachment,
  type ChatMediaFact,
  type PendingRpcEntry,
  normalizeOpenClawMediaFacts,
} from "../lib/chatRuntime";
import {
  normalizeChatCanvasWidgetPart,
  normalizeChatCanvasWidgetParts,
} from "../lib/chatWidget";
import ChatModelMenu from "./ChatModelMenu";
import ChatSessionMenu from "./ChatSessionMenu";
import { readChatUnread, writeChatUnread, sessionReadAt, hasUnreadReply,
  observeSessionReply, readSessionThrough, supportsSessionUnread, anchorUnreadMessage } from "../lib/chatUnread";
import ChatAgentPanel, { type ChatAgentPanelKind } from "./ChatAgentPanel";
import ChatPluginPicker, { type ChatPluginSelection } from "./ChatPluginPicker";
import { usePluginSelectionReadiness } from "../lib/usePluginSelectionReadiness";
import { createPendingChatSendStore, shouldTrackChatSend, classifyChatSendObservation,
  isExplicitChatSendRejection, isUncertainChatSendReceipt } from "../lib/chatSendRecovery";
import { createOptimisticChatHistory } from "../lib/chatOptimisticHistory";
import { createChatSlashHistory } from "../lib/chatSlashHistory";
import { createOpenClawPreambles, openClawPreambleIds, openClawPreambleKey } from "../lib/openclawPreambles";
import ChatPromptCard, {
  chatPromptAttentionOf,
  interruptedApprovalEntry,
  type ChatPromptAttention,
  type ChatPromptEntry,
  type ChatPromptResponse,
} from "./ChatPromptCard";
import ChatWidget from "../components/ChatWidget";
import Modal from "../components/Modal";
import { useConfirm } from "../components/ui";
import SessionAdvancedModal from "./chat-session-advanced/SessionAdvancedModal";
import {
  forkEditorDraft,
  forkEntryIdAt,
  shouldApplySessionResult,
} from "./chat-session-advanced/sessionAdvancedModel";
import SessionBoardView from "./chat-session-board/SessionBoardView";
import {
  canPinCanvasToBoard,
  canReadSessionBoard,
  sameSessionBoardWidgetIdentity,
  sessionBoardScopeKey,
  shouldAdoptSessionBoardRevision,
  shouldApplySessionBoardResult,
  shouldRefreshSessionBoardEvent,
  type SessionBoardViewMode,
} from "./chat-session-board/sessionBoardModel";
import FusionLoader from "../components/FusionLoader";
import ChatTypingText from "../components/ChatTypingText";
import TurnProcess from "../components/TurnTimeline/TurnProcess";
import TurnTimeline from "../components/TurnTimeline/TurnTimeline";
import { IconTrajectory } from "../components/TurnTimeline/trajectoryIcons";
import { createTimeline, reduceTimeline, stepsFromParts, mergeToolArgs, toolActivityTitle, toolResultFailed, type TimelinePartLike, type TurnEvent, type TurnStep, type TurnTimelineState } from "../lib/turnTimeline";
import { isBackgroundSession, isVisibleSession, sessionKindOf } from "../lib/sessionKind";
import { createSubagentActivity } from "../lib/chatSubagentActivity";
import { consumeCronChatHandoff } from "../lib/cronChatHandoff";
import { applyChatSessionAgentNames, mergeLinkedSessionRows, openChatSessionLink } from "../lib/chatSessionNavigation";
import { mergeIncompleteSessionRows } from "../lib/sessionListCompleteness";
import { sessionDisplayPreview, sessionDisplayTitle } from "../lib/sessionDisplay";
import { isInterSessionUserMessage, isScheduledCronUserMessage } from "../lib/chatMessageVisibility";
import { createAgentNameIndex, type AgentNameIndex } from "../lib/agentDisplay";
import { isChatAgentListed, updateChatAgentRoster, type ChatAgentRoster } from "../lib/chatAgentRoster";
import {
  backendOfAgentRows,
  backendOfSessionRows,
  isLiveChatState,
  mergeLiveText,
  projectSteeredLiveText,
  supportsBackendAttachments,
  supportsBackendSlash,
  upsertPromptEntry,
  type ChatBackendId,
} from "../lib/chatBackend";
import { useRegisterPageRefresh } from "../lib/page-refresh";
import ImmersiveChat, { type ImmersiveMessage } from "./immersive/ImmersiveChat";
import ChatPermissionMenu from "./ChatPermissionMenu";
import ChatThinkFastMenu from "./ChatThinkFastMenu";
import { localizePermissionMode } from "../lib/permissionModeText";
import type { ImmersivePhase } from "./immersive/immersiveBg";
import type { ImmersiveLiveStatus, ImmersiveLiveTool } from "./immersive/ImmersiveStatusLine";
import { IconSend, IconClip, IconSearch, IconClock, IconMic, IconStop } from "./chatIcons";
import ChatFileButton, { ChatFileLabel } from "../components/ChatFileButton";
import "./ChatPage.css";
import GroupChatPanel, { GroupChatAvatar } from "./GroupChatPanel";
import { ChatMessageContextMenu, ChatPinnedMessages, IconCopy, IconPin, IconTrash, MESSAGE_PINNING_ENABLED } from "./ChatMessageActions";
import { createGroupPanelCache } from "../lib/groupPanelCache";
import GroupChatCreateModal from "./GroupChatCreateModal";
import { emitGroupConnection } from "../lib/groupSendJournal";
import {
  emitGroupChanged, GROUP_MEMBER_BACKEND_IDS, GROUP_NATIVE_BACKEND_ID, groupChatActivity, groupChatPreview, useGroupChats, type GroupCandidateAgent,
} from "../lib/groupChat";
import type {
  ChatCanvasWidgetPart,
  ChatCanvasWidgetPreview,
  ChatCapabilities,
  ChatPermissionModeOption,
  GlobalChatSearchHit,
  GlobalChatSearchResult,
  OpenClawProgressCard,
  OpenClawQuestion,
  OpenClawQuestionPromptEntry,
  SessionAdvancedDescription,
  SessionArtifactsResult,
  SessionBoardOp,
  SessionBoardResult,
  SessionBoardWidget,
  UnifiedModel,
} from "../types";
import { useBackendCatalog, useEnabledBackends } from "../lib/backends";
import {
  describeSession,
  execSlashCommand,
  forkSessionAtEntry,
  getChatCacheScope,
  getChatCapabilities,
  getModelCatalog,
  listSessionArtifacts,
  getSessionBoard,
  grantSessionBoardWidget,
  listSlashCommands,
  pinSessionCanvas,
  searchGlobalChats,
  updateSessionBoard,
  revealAttachment,
  revealPath,
} from "../api/client";
import {
  readModelCatalog,
  revalidateModelCatalog,
  subscribeModelCatalog,
} from "../model-catalog-store";
import { defaultModelForScope } from "../model-identity";
import { createModelCatalogRefresh } from "./chat-model-refresh";

export const createChatHistoryController = createHistoryController;
export const createChatSendController = createSendController;

// 暂时隐藏普通/沉浸聊天共用菜单的分叉入口，保留底层能力。
const SHOW_SESSION_FORK = false;
// 隐藏上下文状态和手动压缩入口，自动压缩继续由 Service 管理。
const SHOW_CHAT_CONTEXT_USAGE = false;

// Native React chat over the loopback /__chatws broker. The broker auto-performs
// the device-auth handshake against the federating proxy, so here we just speak
// the plain gateway protocol: sessions.list / chat.history / chat.send + `chat`
// stream events. No browser-side crypto/pairing.
//
// The rendering reproduces the legacy "liquid glass" chat skin (ChatPage.css),
// driven entirely by the real gateway frame shapes (verified live): sessions
// carry model/provider/thinking/totalTokens/contextTokens/updatedAt; messages
// carry role (user|assistant|toolResult), a string-or-parts `content`
// (text|thinking|toolCall), timestamp, model, usage, stopReason, errorMessage.

// Live activity status shown as a dot+label in the chat header / agent list.
// 首次连接与已连接后的中断分开呈现；后端曾就绪的证据只保留在本次页面生命周期。
// Hermes 的精确就绪状态仍只用于 composer 门禁，不占用 Agent 行的缓存预览。
type LiveStatus = "queued" | "running" | "online" | "offline" | "connecting" | "reconnecting";
type AgentListStatus = LiveStatus | ChatPromptAttention;

interface SessionRow {
  spawnedBy?: string;
  parentSessionKey?: string;
  lastRunId?: string;
  lastRunError?: string;
  inspirationId?: string;
  kind?: string;
  source?: string;
  codexDesktopSourceError?: string;
  codexDesktopWriter?: CodexDesktopWriterState;
  key: string;
  sessionId?: string; // host-owned physical id; never derive from the routing key
  backendId?: string;
  displayName?: string;
  label?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  subject?: string;
  title?: string;
  name?: string;
  agentId?: string;
  agentName?: string;
  updatedAt?: number;
  model?: string;
  modelProvider?: string;
  thinkingDefault?: string;
  thinkingLevel?: string;
  thinkingOptions?: string[];
  fastMode?: boolean;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  contextTokens?: number;
  contextUsage?: RuntimeContextUsage | null;
  contextCapabilities?: RuntimeContextCapabilities;
  productContext?: ProductContextState;
  status?: string;
  hasActiveRun?: boolean;
  permissionMode?: string;
}
/** A history snapshot can contain commentary while the reply is still running. */
function isSessionReplyPending(session?: Pick<SessionRow, "hasActiveRun" | "status">): boolean {
  return session?.hasActiveRun ?? ["queued", "starting", "running", "waiting_approval", "waiting_input",
    "reconnecting", "needs_verification"].includes(session?.status ?? "");
}
interface SessionListSnapshot {
  rows: SessionRow[];
  degradedBackends: Set<string>;
}
interface SessionArtifactState {
  key: string;
  status: "idle" | "loading" | "done" | "error";
  result: SessionArtifactsResult | null;
}
interface SessionArtifactPopoverPosition {
  top: number;
  right: number;
  maxHeight: number;
}
const GLOBAL_SEARCH_PAGE_SIZE = 50;
interface PendingSearchJump extends GlobalChatSearchHit {
  query: string;
  token: number;
}

function globalSearchHitIdentity(hit: GlobalChatSearchHit): string {
  return [
    hit.backendId,
    hit.agentId,
    hit.key,
    hit.sessionId || "",
    hit.messageId || "",
    hit.role || "",
    hit.ts ?? "",
    hit.snippet,
  ].join("\u0000");
}

type PartType = "text" | "thinking" | "toolCall" | "toolResult" | "plan" | "prompt" | "timeline" | "canvas" | "ui_artifact";

interface GatewayContractSnapshot {
  protocol: number;
  server: { version: string; buildId?: string };
  features: { methods: string[]; events: string[]; capabilities: string[] };
  auth: { role: string; scopes: string[] };
  policy: {
    maxPayload: number;
    maxBufferedBytes: number;
    attachments?: { maxBytes: number; maxImageBytes: number };
    allowedSessionVisibilities?: string[];
  };
}

function gatewayAdvertises(
  snapshot: GatewayContractSnapshot | null,
  kind: "methods" | "events",
  value: string,
): boolean {
  return snapshot?.features[kind].includes(value) === true;
}

function gatewayHasScope(snapshot: GatewayContractSnapshot | null, scope: string): boolean {
  return snapshot?.auth.scopes.includes(scope) === true;
}

function gatewaySupportsQuestions(snapshot: GatewayContractSnapshot | null): boolean {
  return gatewayHasScope(snapshot, "operator.questions")
    && gatewayAdvertises(snapshot, "methods", "question.list")
    && gatewayAdvertises(snapshot, "methods", "question.resolve")
    && gatewayAdvertises(snapshot, "events", "question.requested")
    && gatewayAdvertises(snapshot, "events", "question.resolved");
}

function gatewaySupportsProgressCards(snapshot: GatewayContractSnapshot | null): boolean {
  return gatewayHasScope(snapshot, "operator.read")
    && gatewayAdvertises(snapshot, "methods", "progressCard.get")
    && gatewayAdvertises(snapshot, "events", "progressCard.changed");
}

function normalizeGatewayContract(raw: unknown): GatewayContractSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, any>;
  if (
    !Number.isInteger(value.protocol)
    || typeof value.server?.version !== "string"
    || !Array.isArray(value.features?.methods)
    || !Array.isArray(value.features?.events)
    || !Array.isArray(value.features?.capabilities)
    || typeof value.auth?.role !== "string"
    || !Array.isArray(value.auth?.scopes)
    || !Number.isInteger(value.policy?.maxPayload)
    || !Number.isInteger(value.policy?.maxBufferedBytes)
  ) return null;
  const strings = (items: unknown[]) => items.filter((item): item is string => typeof item === "string");
  return {
    protocol: value.protocol,
    server: {
      version: value.server.version,
      ...(typeof value.server.buildId === "string" ? { buildId: value.server.buildId } : {}),
    },
    features: {
      methods: strings(value.features.methods),
      events: strings(value.features.events),
      capabilities: strings(value.features.capabilities),
    },
    auth: { role: value.auth.role, scopes: strings(value.auth.scopes) },
    policy: {
      maxPayload: value.policy.maxPayload,
      maxBufferedBytes: value.policy.maxBufferedBytes,
      ...(Number.isInteger(value.policy.attachments?.maxBytes)
        && Number.isInteger(value.policy.attachments?.maxImageBytes)
        ? { attachments: {
          maxBytes: value.policy.attachments.maxBytes,
          maxImageBytes: value.policy.attachments.maxImageBytes,
        } }
        : {}),
      ...(Array.isArray(value.policy.allowedSessionVisibilities)
        ? { allowedSessionVisibilities: strings(value.policy.allowedSessionVisibilities) }
        : {}),
    },
  };
}

function normalizeOpenClawQuestion(raw: unknown): OpenClawQuestion | null {
  if (!raw || typeof raw !== "object") return null;
  const question = raw as Record<string, unknown>;
  if (
    typeof question.questionId !== "string" || !question.questionId
    || typeof question.header !== "string"
    || typeof question.question !== "string"
    || !Array.isArray(question.options)
  ) return null;
  const options = question.options.map((rawOption) => {
    if (!rawOption || typeof rawOption !== "object") return null;
    const option = rawOption as Record<string, unknown>;
    if (typeof option.label !== "string" || !option.label) return null;
    return {
      label: option.label,
      ...(typeof option.description === "string" ? { description: option.description } : {}),
    };
  });
  if (options.some((option) => option === null)) return null;
  const secretStore = question.secretStore && typeof question.secretStore === "object"
    ? question.secretStore as Record<string, unknown>
    : null;
  if (secretStore && (
    typeof secretStore.name !== "string" || !secretStore.name
    || (secretStore.kind !== "secret" && secretStore.kind !== "env")
  )) return null;
  const secretStoreExisting = question.secretStoreExisting && typeof question.secretStoreExisting === "object"
    ? question.secretStoreExisting as Record<string, unknown>
    : null;
  if (secretStoreExisting && !Number.isInteger(secretStoreExisting.updatedAtMs)) return null;
  return {
    questionId: question.questionId,
    header: question.header,
    question: question.question,
    options: options as OpenClawQuestion["options"],
    ...(typeof question.multiSelect === "boolean" ? { multiSelect: question.multiSelect } : {}),
    ...(typeof question.isOther === "boolean" ? { isOther: question.isOther } : {}),
    ...(typeof question.isSecret === "boolean" ? { isSecret: question.isSecret } : {}),
    ...(secretStore ? {
      secretStore: {
        name: secretStore.name as string,
        kind: secretStore.kind as "secret" | "env",
        ...(Array.isArray(secretStore.allowedHosts)
          ? { allowedHosts: secretStore.allowedHosts.filter((host): host is string => typeof host === "string") }
          : {}),
        ...(typeof secretStore.reason === "string" ? { reason: secretStore.reason } : {}),
      },
    } : {}),
    ...(secretStoreExisting ? {
      secretStoreExisting: {
        updatedAtMs: secretStoreExisting.updatedAtMs as number,
        ...(typeof secretStoreExisting.updatedBy === "string"
          ? { updatedBy: secretStoreExisting.updatedBy }
          : {}),
      },
    } : {}),
  };
}

function normalizeOpenClawQuestionPrompt(raw: unknown, now = Date.now()): OpenClawQuestionPromptEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (
    typeof record.id !== "string" || !record.id
    || typeof record.sessionKey !== "string" || !record.sessionKey
    || record.status !== "pending"
    || !Number.isInteger(record.createdAtMs)
    || !Number.isInteger(record.expiresAtMs)
    || (record.expiresAtMs as number) <= now
    || !Array.isArray(record.questions)
  ) return null;
  const questions = record.questions.map(normalizeOpenClawQuestion);
  if (!questions.length || questions.some((question) => question === null)) return null;
  return {
    id: record.id,
    kind: "openclaw_question",
    questions: questions as OpenClawQuestion[],
    sessionKey: record.sessionKey,
    ...(typeof record.agentId === "string" ? { agentId: record.agentId } : {}),
    ...(typeof record.runId === "string" ? { runId: record.runId } : {}),
    createdAtMs: record.createdAtMs as number,
    expiresAtMs: record.expiresAtMs as number,
    status: "pending",
  };
}

function isOpenClawQuestionPrompt(entry: ChatPromptEntry): entry is OpenClawQuestionPromptEntry {
  return entry.kind === "openclaw_question" && "questions" in entry && "expiresAtMs" in entry;
}

function openClawQuestionResolveParams(
  id: string,
  response: ChatPromptResponse,
): { id: string; cancel: true } | { id: string; answers: { answers: Record<string, string[]> } } {
  if (response.action === "cancel") return { id, cancel: true };
  if (!response.questionAnswers) throw new Error("question answers required");
  // OpenClaw 2026.8.1 intentionally wraps the answer map in QuestionAnswers.
  return { id, answers: { answers: response.questionAnswers } };
}

function progressCardPlan(card: OpenClawProgressCard): PlanEntry[] {
  // A durable card may remain available after its turn has finished. Once every
  // concrete step is complete it is historical, not live state for the next turn.
  if (card.steps?.length && card.steps.every((step) => step.status === "completed")) return [];
  const entries: PlanEntry[] = (card.steps ?? []).map((step) => ({
    content: step.step,
    status: step.status,
  }));
  if (!entries.length) entries.push({ content: "", status: "pending" });
  entries[0] = {
    ...entries[0],
    progressRevision: card.revision,
    progressUpdatedAt: card.updatedAt,
    ...(card.markdown ? { progressMarkdown: card.markdown } : {}),
  };
  return entries;
}

function normalizeOpenClawProgressCard(raw: unknown, expectedSessionKey: string): OpenClawProgressCard | null {
  if (!raw || typeof raw !== "object") return null;
  const card = raw as Record<string, unknown>;
  if (
    card.sessionKey !== expectedSessionKey
    || !Number.isInteger(card.revision) || (card.revision as number) < 1
    || !Number.isInteger(card.updatedAt)
    || (card.markdown !== undefined && typeof card.markdown !== "string")
    || (card.steps !== undefined && !Array.isArray(card.steps))
  ) return null;
  const steps = Array.isArray(card.steps) ? card.steps.map((rawStep) => {
    if (!rawStep || typeof rawStep !== "object") return null;
    const step = rawStep as Record<string, unknown>;
    if (
      typeof step.step !== "string"
      || (step.status !== "pending" && step.status !== "in_progress" && step.status !== "completed")
    ) return null;
    return { step: step.step, status: step.status };
  }) : undefined;
  if (steps?.some((step) => step === null)) return null;
  return {
    sessionKey: expectedSessionKey,
    revision: card.revision as number,
    updatedAt: card.updatedAt as number,
    ...(typeof card.markdown === "string" ? { markdown: card.markdown } : {}),
    ...(steps ? { steps: steps as OpenClawProgressCard["steps"] } : {}),
  };
}
interface Part {
  type: PartType;
  activity?: boolean; // explicit public progress, distinct from answer text
  uiArtifact?: NativeUiArtifactPart;
  segmentId?: string;
  sourceEventId?: string;
  preview?: ChatCanvasWidgetPreview;
  rawText?: string;
  text?: string;
  planEntries?: PlanEntry[]; // plan part: the agent's todo list (ACP plan event)
  diff?: { path: string; oldText: string; newText: string }; // file-edit diff (write/patch)
  diffText?: string; // unified diff text (Hermes gateway inline_diff)
  durationS?: number; // tool runtime seconds (Hermes gateway tool.complete)
  promptEntry?: ChatPromptEntry; // prompt part: blocking agent request card
  toolName?: string;
  toolCallId?: string;
  toolArgs?: unknown; // toolCall arguments → rendered into the card title (url/query/…)
  pluginAppCallId?: string;
  isError?: boolean; // toolResult: the tool failed (→ "Tool error …" red card)
  steps?: TurnStep[]; // timeline part(R339): 回合过程步骤(吸收自 thinking/toolCall/toolResult/plan)
}
interface Usage {
  totalTokens?: number;
  input?: number; // gateway field names (verified live); *Tokens kept as fallback aliases
  output?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  contextUsed?: number; // Hermes gateway: current context-window occupancy
  contextMax?: number; //  … window size
  contextPercent?: number; //  … occupancy percent (server-computed)
  cost?: { total?: number };
}
interface ChatFile extends Omit<Partial<ChatMediaFact>, "kind"> {
  name: string;
  kind: string;
  src?: string;
  path?: string;
}
interface ChatMsg {
  role: "user" | "assistant" | "toolResult" | "system";
  parts: Part[];
  nativeDisplayId?: string;
  nativeRunId?: string;
  turnStartId?: string; // display action identity of this reply's saved process
  activityRunId?: string; // canonical history owner, independent of native display identity
  openclawPreambleIds?: string[];
  openclawPreambleKey?: string; // public stream item identity, not a canonical message id
  openclawLivePreamble?: boolean;
  historySource?: "hermes";
  automation?: "cron" | "continuation";
  sourceEventIds?: string[];
  canonicalSourceEventId?: string;
  id?: string; // canonical gateway identity — kept separate from local UI actions
  actionId?: string; // per-session hide/pin identity, including messages without a gateway id
  ts?: number;
  model?: string;
  provider?: string;
  usage?: Usage;
  responseMetadata?: ResponseMetadata;
  stopReason?: string;
  errorMessage?: string;
  toolName?: string;
  isError?: boolean;
  images?: string[];
  // 非图片附件（PDF / 任意文件 / 视频）随用户气泡显示。带 `src` 的视频渲染成可
  // 播放的预览窗（点击进 lightbox 播放），其余渲染成文件 chip。图片仍走 `images`。
  files?: ChatFile[];
  nativeAttachments?: ChatAttachment[];
  retryAttachments?: ChatAttachment[];
  pluginSelection?: ChatPluginSelection[];
  pluginSelectionSnapshot?: Array<ChatPluginSelection & { packageName: string; declaredVersion: string | null }>;
  localSendId?: string;
  localSlashId?: string;
  idempotencyKey?: string;
  pending?: boolean;
  settledPending?: boolean; // stopped live tail awaiting its terminal frame or canonical history
  keepLiveLayout?: boolean; // this turn's rendered text keeps its layout through history replacement
  ephemeral?: "progressCard";
  local?: boolean; // client-generated (slash-command result) — rendered as a neutral info bubble
  provenance?: { kind?: string; sourceTool?: string } | null; // gateway message provenance (e.g. kind:"inter_session" = routed from another session/tool, not typed by the user)
  repeat?: number; // >1 ⇒ this bubble stands in for N consecutive identical failed turns (see collapseErrorRuns)
  errPrefix?: string; // system error bubble: i18n key wrapping the raw gateway error (parts hold the RAW string; translation happens at render so it follows language switches)
  divider?: { sealedAt: number | null; fromReset: boolean; truncated?: boolean }; // archive segment boundary — not a real message; renders as a reset divider line
  // Backend timeline row (not a turn): renders as a quiet one-line divider like
  // `divider`, NOT as the red system/error bubble. For model switches, `model`
  // carries the new model; `parts` keep the backend's raw text for the hover title.
  notice?: "modelSwitch" | "runInterrupted";
}

// ---- pure helpers -------------------------------------------------------

// "agent:maya:main" → "maya"; the avatar id + display name derive from this.
function agentOf(key: string): string {
  const segs = String(key || "").split(":");
  return segs[1] || segs[0] || key;
}
function openClawChatModels(raw: unknown): UnifiedModel[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const model = entry as Partial<UnifiedModel>;
    const id = typeof model.id === "string" ? model.id.trim() : "";
    if (!id) return [];
    return [{
      ...model,
      id,
      name: typeof model.name === "string" && model.name.trim() ? model.name : id,
      provider: typeof model.provider === "string" ? model.provider : "",
      backendId: "openclaw",
    }];
  });
}
function inheritedModelChoice(
  models: UnifiedModel[],
  modelId: string | null | undefined,
  backendId: string,
  provider?: string,
): UnifiedModel | undefined {
  if (!modelId) return undefined;
  const candidates = models.filter((m) => m.id === modelId && m.backendId === backendId);
  if (provider) return candidates.find((m) => m.provider === provider);
  return candidates.length === 1 ? candidates[0] : undefined;
}
// 刚发生 reset 的会话通常只剩极短的新尾巴；此时自动补回归档，其余会话仍按上滑按需加载。
const AUTO_ARCHIVE_MESSAGE_LIMIT = 5;
// 双发去重窗口：同一会话内相同正文在此窗口内再次发送 → 判为一次逻辑发送被双触发
// （重连清 inFlight / 一次 Enter 走了两条 submit 路径），复用同一 idempotencyKey 让网关折叠。
// 取 15s 覆盖已观测到的 ~13s 重连间隔；代价仅是 15s 内故意重发的同一句会被并成一条。
const DUP_SEND_WINDOW_MS = 15_000;
const pendingChatSendStore = createPendingChatSendStore(() => localStorage);
const readPendingTrackedSends = pendingChatSendStore.read;
const rememberPendingTrackedSend = pendingChatSendStore.remember;
const hasPendingTrackedSend = pendingChatSendStore.has;
const forgetPendingTrackedSend = pendingChatSendStore.forget;
// Preflight uses a fixed-width UUID sample; the real idempotency key generated
// immediately before chat.send has the same ASCII byte length.
const CHAT_SEND_IDEMPOTENCY_SAMPLE = "00000000-0000-4000-8000-000000000000";
const PLUGIN_SELECTION_DRAFT_KEY = "shoggoth.chat.plugin-selection.v1";
function readPluginSelectionDrafts(): Record<string, ChatPluginSelection[]> {
  try {
    const stored = JSON.parse(localStorage.getItem(PLUGIN_SELECTION_DRAFT_KEY) || "{}");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    return Object.fromEntries(Object.entries(stored).slice(0, 20).flatMap(([key, value]) =>
      key.length <= 256 && Array.isArray(value) && value.length <= 4
        && value.every(item => item && typeof item === "object"
          && typeof item.installationId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(item.installationId)
          && Number.isSafeInteger(item.revision) && item.revision > 0)
        ? [[key, value as ChatPluginSelection[]]] : []));
  } catch { return {}; }
}
function writePluginSelectionDrafts(value: Record<string, ChatPluginSelection[]>): boolean {
  try {
    const active = Object.fromEntries(Object.entries(value).filter(([, rows]) => rows.length).slice(-20));
    localStorage.setItem(PLUGIN_SELECTION_DRAFT_KEY, JSON.stringify(active));
    return true;
  } catch { return false; }
}
// 回合终结 → 补发待发队列队首的延迟：躲开 final 分支 loadHistory(refresh) 的重拉窗口，
// 减少刚补发的 user 气泡被旧历史覆盖的闪烁（session.message 的 300ms 合并重拉会兜底恢复）。
const QUEUE_FLUSH_DELAY_MS = 400;
// 待发队列条目（R357）：生成中回车的消息排队，回合终结后按 FIFO 链式补发。
type QueuedMsg = { id: string; text: string; atts: ChatAttachment[]; pluginSelection?: ChatPluginSelection[]; pluginGeneration?: number };
// First text part of a normalized message (user/system/assistant-text live there).
function msgText(m: ChatMsg): string {
  return m.parts.find((p) => typeof p.text === "string")?.text?.trim() ?? "";
}

// ---- 附件在历史里的还原 ----
//
// OpenClaw 2026.8.1 在 `__openclaw.media` 提供安全的结构化媒体事实；Hermes 仍通过
// 转录 marker（`[image ×N]` / `[pdf: x]` / `[file: x]`）与 Attached Context 表达。
// IndexedDB 只作为发送后尚未拿到权威历史、旧转录或可播放视频 bytes 的本机回退。
const ATTACH_MARKER_RE = /\[(?:image ×(\d+)|(pdf|file): ([^\]]+))\]/g;
// Hermes 服务端把 `@file:` 引用**展开**进用户消息的权威转录：原文之后跟一段
//   --- Attached Context ---
//   📄 @file:.hermes/desktop-attachments/x.md (4 tokens)
//   <文件全文>
// final 之后我们重取权威历史，本地那份 `[file: x]` marker 就被它取代了。
// 这一大段对用户是纯噪音（他自己发的文件），剥掉、只留 chip。
const ATTACHED_CONTEXT_RE = /\n*---\s*Attached Context\s*---\n([\s\S]*)$/;
const FILE_REF_RE = /@file:([^\s()]+)/g;
// OpenClaw 网关给「只有媒体、没有文字」的用户消息写的固定占位串。它不是用户输入，
// 显示出来毫无意义（截图实证），且会让缓存 key 对不上（发送时文本是空）。
const OPENCLAW_MEDIA_PLACEHOLDER = "[User sent media without caption]";
// 文件 dataURL 的缓存上限（base64 字符数，~12MB 原始字节）。超过就只缓存文件名，
// 重载后回落成 chip —— 预览很好，但不值得为它塞爆浏览器存储配额。
const FILE_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const MEDIA_METADATA_TIMEOUT_MS = 2_000;

function readBrowserMediaMetadata(file: File, kind: ChatAttachment["kind"]): Promise<Pick<ChatAttachment, "durationMs" | "width" | "height">> {
  if ((kind !== "audio" && kind !== "video") || !URL?.createObjectURL) return Promise.resolve({});
  return new Promise((resolve) => {
    const source = URL.createObjectURL(file);
    const media = document.createElement(kind === "video" ? "video" : "audio");
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      URL.revokeObjectURL(source);
      const durationMs = Number.isFinite(media.duration) && media.duration >= 0 ? Math.round(media.duration * 1000) : undefined;
      const video = kind === "video" ? media as HTMLVideoElement : null;
      resolve({
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(video && video.videoWidth > 0 ? { width: video.videoWidth } : {}),
        ...(video && video.videoHeight > 0 ? { height: video.videoHeight } : {}),
      });
    };
    const timer = setTimeout(finish, MEDIA_METADATA_TIMEOUT_MS);
    media.onloadedmetadata = finish;
    media.onerror = finish;
    media.preload = "metadata";
    media.src = source;
  });
}

function attachmentChipTitle(file: ChatFile): string {
  const meta: string[] = [];
  if (typeof file.sizeBytes === "number") meta.push(`${Math.round(file.sizeBytes / 1024)} KB`);
  if (typeof file.durationMs === "number") meta.push(`${(file.durationMs / 1000).toFixed(1)}s`);
  if (file.width && file.height) meta.push(`${file.width}×${file.height}`);
  return meta.length ? `${file.name} · ${meta.join(" · ")}` : file.name;
}

/** 历史里只剩文件名时，按扩展名判类别（决定 chip 图标；视频能否播放另看有无 src）。 */
function kindFromFilename(name: string): string {
  if (/\.pdf$/i.test(name)) return "pdf";
  if (/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(name)) return "video";
  return "file";
}

/**
 * 从历史文本里剥出附件信息，返回 {纯文本, files}。两种来源都认：服务端展开的
 * 「Attached Context」区块（权威，Hermes），和我们本地转录写的 `[file: x]`
 * marker（转录尚未被权威历史取代时）。都没有就原样返回。
 */
function extractAttachmentMarkers(text: string): { text: string; files: ChatFile[] } {
  const files: ChatFile[] = [];
  let body = text;
  const ctx = ATTACHED_CONTEXT_RE.exec(body);
  if (ctx) {
    body = body.slice(0, ctx.index);
    for (const m of ctx[1].matchAll(FILE_REF_RE)) {
      const ref = String(m[1]);
      const name = ref.split("/").pop()?.trim();
      if (!name) continue;
      const kind = kindFromFilename(name);
      // 视频直接从服务端取（附件就存在那儿），预览因此不依赖浏览器本地缓存——
      // 后者按 origin 隔离，换端口/换设备/清缓存就没了。`rel` 是相对家目录的
      // 引用路径，服务端补全并做包含性校验。
      const src = kind === "video" && !ref.startsWith("/") ? `/__media?rel=${encodeURIComponent(ref)}` : undefined;
      const path = ref.startsWith("/") || ref.startsWith("~/") ? ref
        : ref.startsWith(".hermes/desktop-attachments/") ? `~/${ref}` : undefined;
      files.push({ name, kind, ...(src ? { src } : {}), ...(path ? { path } : {}) });
    }
  }
  let imageCount = 0;
  body = body.replace(ATTACH_MARKER_RE, (_m, imgN, kind, name) => {
    if (imgN) imageCount += Number(imgN) || 0;
    else if (name) {
      const n = String(name).trim();
      if (!files.some((f) => f.name === n)) files.push({ name: n, kind: String(kind) });
    }
    return "";
  });
  // `[image ×N]` 只说明有 N 张图；真图走 images/缓存，这里不造 chip，仅剥文本。
  void imageCount;
  return { text: body.replace(/[ \t]+$/gm, "").trim(), files };
}
// Envelope/heartbeat records: the agent's "alive, nothing to report" ack (HEARTBEAT_OK /
// NO_REPLY) plus its paired "[OpenClaw …]" poll/envelope prompt. The gateway returns these
// RAW in chat.history — upstream's own Control UI omits them at *render* time, not the
// server (docs/web/control-ui.md: "omits assistant entries whose whole visible text is only
// … HEARTBEAT_OK"). We mirror that: applied at the display chokepoint (the `groups` memo) so
// every source — initial load, grafted older region, stream finalize, refresh — is covered.
// Upstream's heartbeat-ack cutoff (control-ui `_p` default maxAckChars): after the token is
// stripped, a remainder this short or shorter still counts as "nothing meaningful to report",
// so the whole turn is omitted — e.g. "HEARTBEAT_OK — OPEN 3 / IN-PROGRESS 2…". >300 ⇒ survives.
const HEARTBEAT_ACK_MAX_CHARS = 300;
// Strip the HEARTBEAT_OK / NO_REPLY ack token from a line's edges — a lean port of the gateway's
// stripHeartbeatToken (upstream src/auto-reply/heartbeat.ts). A bare "HEARTBEAT_OK" → "";
// "HEARTBEAT_OK\n\nOPEN 3 positions" → "OPEN 3 positions"; a token-free line passes through. The
// caller (isHeartbeatNoise / the list preview) decides whether what's left is short enough to be
// just an ack.
function stripHeartbeatToken(raw: string): string {
  if (!/\b(?:HEARTBEAT_OK|NO_REPLY)\b/.test(raw)) return raw.trim();
  let t = raw.replace(/<[^>]*>/g, " ").trim();
  for (const tok of ["HEARTBEAT_OK", "NO_REPLY"]) {
    const bare = t.replace(/^[*`~_\s]+|[*`~_\s]+$/g, "");
    if (bare === tok) return "";
    if (bare.startsWith(tok)) t = bare.slice(tok.length).replace(/^[\s\-–—:：.。,，、*`~_]+/, "").trim();
    else if (bare.endsWith(tok)) t = bare.slice(0, bare.length - tok.length).replace(/[\s\-–—:：.。,，、*`~_]+$/, "").trim();
  }
  return t.trim();
}
// Heartbeat/envelope noise the gateway returns raw in chat.history but upstream's Control UI
// omits at *render* time (docs/web/control-ui.md): a "[OpenClaw …]" poll/envelope prompt, or an
// assistant turn whose whole visible answer is just the HEARTBEAT_OK / NO_REPLY ack.
function isHeartbeatNoise(m: ChatMsg): boolean {
  if (m.role === "user") {
    const t = msgText(m);
    return t === "[OpenClaw heartbeat poll]" || t.startsWith("[OpenClaw ");
  }
  if (m.role === "assistant") {
    // Mirror upstream's control-ui render omit (bundle `bp`→`_p`): test the VISIBLE text only
    // (text parts concatenated; thinking/reasoning ignored, exactly like upstream `yp`), and never
    // drop a turn that did real work — a tool call/result is visible non-text content, so it's a
    // genuine turn. An ack = the token was stripped AND what's left is nothing meaningful: empty
    // OR a short ≤300-char trailer ("HEARTBEAT_OK — OPEN 3 / IN-PROGRESS 2…"). A long (>300) report
    // survives — it said something substantive.
    if (m.parts.some((p) => p.type === "toolCall" || p.type === "toolResult")) return false;
    const visible = m.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    if (!visible) return false;
    const rest = stripHeartbeatToken(visible);
    return rest !== visible && rest.length <= HEARTBEAT_ACK_MAX_CHARS;
  }
  return false;
}
// Raw-text twin of isHeartbeatNoise's assistant branch — used at the live `chat` final event
// (we have raw reply text there, not a ChatMsg). Empty or a bare/short heartbeat ack ⇒ noise
// (don't flag unread); real text ⇒ a genuine new message worth a dot.
function isHeartbeatAckText(text: string): boolean {
  const v = (text || "").trim();
  if (!v) return true;
  const rest = stripHeartbeatToken(v);
  return rest !== v && rest.length <= HEARTBEAT_ACK_MAX_CHARS;
}
// System-injected user-role prompts (cron heartbeats, automation envelopes):
// "[System: 自动TODO巡检] …", "[Tue 2026-05-19 00:00 GMT+8] [System: 自动任务触发] …",
// and the gateway's custom heartbeat prompt body ("Read HEARTBEAT.md …"). They ARE
// user-role messages in the transcript, but rendering them as the user's own yellow
// bubbles floods the thread ("黄墙") — so the thread collapses them to a compact
// expandable row, and list previews / real-activity times skip them like heartbeats.
// Conservative on purpose: only clearly machine-marked openings match.
function isInjectedPrompt(m: ChatMsg): boolean {
  if (m.role !== "user" || m.local) return false;
  const t0 = msgText(m);
  if (!t0) return false;
  // 后台完成通知没有跨会话 provenance 时仍按机器注入折叠。
  if (t0.startsWith("A background task completed.")) return true;
  // cron / system / 心跳自动 prompt（[System: …] / [OpenClaw …] / Read HEARTBEAT.md）
  if (/^\s*(?:\[[^\]\n]{0,80}\]\s*)?\[(?:System|OpenClaw)\b[^\]]*\]/i.test(t0)) return true;
  // 网关把 cron 产出/系统事件镜像成一条 user-role 消息时，每行加「裸」System:/OpenClaw:
  // 前缀（无方括号，如 "System: [2026-07-01 …] 好的，数据采集完成…"）→ 也折叠，别铺成黄墙。
  if (/^\s*(?:\[[^\]\n]{0,80}\]\s*)?(?:System|OpenClaw):\s/i.test(t0)) return true;
  if (t0.startsWith("Read HEARTBEAT.md")) return true;
  // 机器注入到 transcript 的 user-role 文本——都不是用户在输入框打的，一律折叠：
  // Claude Code Skill 工具加载头（"Base directory for this skill: …" + skill 正文）、
  // SessionStart hook / <system-reminder> / superpowers 注入。保守：只匹配明确的机器开头。
  if (t0.startsWith("Base directory for this skill:")) return true;
  if (/^\s*<(?:system-reminder|EXTREMELY[_-]IMPORTANT|SUBAGENT-STOP)\b/i.test(t0)) return true;
  if (t0.startsWith("You have superpowers")) return true;
  return false;
}
// claude-cli/Claude Code 系运行时在手动 Stop 时把中断标记写进 transcript（user-role
// 的 "[Request interrupted by user]" / "…for tool use]"）。它是协议内部标记，不是用户
// 打的字——官方 UI 也不渲染；线程/归档/预览一律整条隐藏（R358，用户反馈）。中断这个
// 事实由 Trajectory 时间线的 aborted 步表达，气泡区不需要它。精确全等匹配，避免误伤
// 用户真打的内容。
const INTERRUPT_MARKERS = new Set(["[Request interrupted by user]", "[Request interrupted by user for tool use]"]);
function isInterruptMarker(m: ChatMsg): boolean {
  return m.role === "user" && !m.local && INTERRUPT_MARKERS.has(msgText(m));
}
// Everything previews / row-times should skip: gateway heartbeat noise, hidden
// inter-session inputs, and the injected automation prompts above. Other injected
// prompts stay visible in the thread as compact rows.
function isNoiseForPreview(m: ChatMsg): boolean {
  return isHeartbeatNoise(m)
    || isScheduledCronUserMessage(m, msgText(m))
    || m.automation === "continuation"
    || isInterSessionUserMessage(m, msgText(m))
    || isInjectedPrompt(m)
    || isInterruptMarker(m);
}

// Count the same body messages shown by the thread, after native display-run
// grouping. Transport/tool/thinking rows do not consume the product page size.
// Keep the process immediately before the first answer with that answer.
export function chatHistoryWindow(raw: unknown[], size: number, key: string) {
  const hidden = readIdSet(HIDDEN_PREFIX, key);
  const projected = groupNativeUiHistory(raw.map((row, index) => ({
    ...(row as object), __historyIndex: index,
  }))).map(row => ({ index: row.__historyIndex as number, message: normalize(row) }));
  const actionIds = keyedChatMessages(projected.map(row => row.message)).map(({ item, key: renderKey }) => item.id || `local:${renderKey}`);
  const visible = projected.filter(({ message: m }, index) =>
    (m.role === "user" || m.role === "assistant") && !m.notice && !isNoiseForPreview(m)
    && !hidden.has(actionIds[index])
    && (m.parts.some(part => (part.type === "text" && !!part.text?.trim()) || part.type === "ui_artifact" || part.type === "canvas")
      || !!m.images?.length || !!m.files?.length || !!m.errorMessage));
  const first = visible[Math.max(0, visible.length - size)];
  if (!first) return { start: 0, count: 0, needsEarlier: true };
  let at = projected.indexOf(first);
  const priorVisible = new Set(visible.slice(0, -size).map(item => item.index));
  if (first.message.role !== "user") {
    while (at > 0) {
      const previous = projected[at - 1];
      if (priorVisible.has(previous.index) || previous.message.role === "user" || previous.message.notice) break;
      at--;
    }
  }
  return { start: projected[at].index, count: visible.length,
    needsEarlier: at === 0 && first.message.role !== "user" };
}

function rawHistoryId(raw: unknown): string {
  const row = raw as { id?: string | number; __openclaw?: { id?: string } };
  return String(row?.__openclaw?.id ?? row?.id ?? JSON.stringify(raw));
}
// One-line preview sanitizer: drop markdown DECORATION that reads as garbage in
// a single-line row ("**CTO Heartbeat 巡检**" → "CTO Heartbeat 巡检") without
// eating legitimate characters in prose ("C#", "a*b", snake_case): only paired
// emphasis/code wrappers and line-leading heading/quote markers are stripped.
function stripPreviewMd(text: string): string {
  return text
    .replace(/```[a-zA-Z]*\s?/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|\*|_|`)(\S(?:[\s\S]*?\S)?)\1/g, "$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}
function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
export function chatAgentDisplayName(agentId: string): string {
  if (agentId.toLowerCase().startsWith("hermes-")) {
    return agentId.slice("hermes-".length) || "default";
  }
  return cap(agentId);
}
export function shouldRefreshChatAvatars(pathname: string): boolean {
  return pathname === "/" || pathname === "/chat";
}
function sessionName(s: SessionRow): string {
  return s.agentName || chatAgentDisplayName(agentOf(s.key)) || s.displayName || s.label || s.title || s.name || s.key;
}
// the part after the agent id ("main", "dashboard:…") shown as a quiet subtitle
function sessionSub(s: SessionRow): string {
  const segs = String(s.key || "").split(":");
  return segs.slice(2).join(":") || segs[0] || "";
}
type TFn = (key: string, opts?: Record<string, unknown>) => string;
function friendlySessionLabel(s: SessionRow, t: TFn): string {
  return sessionDisplayTitle(s, t);
}
// 后台会话分类与列表可见性统一在 lib/sessionKind.ts。
// 子代理归入父会话的实时动态；控制命令保留完整记录，未读按可打开的会话计算。

function fmtTokens(n?: number): string {
  if (!n || n <= 0) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}
// 思考强度等级名固定用英文标准名（不随界面语言切换）——模型技术参数统一英文，
// 与 gateway 的 /think <off|low|medium|high|xhigh> 协议词一致。
const THINK_LEVEL_LABELS: Record<string, string> = {
  off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High",
  xhigh: "Extra high", maximum: "Maximum", adaptive: "Adaptive", on: "On",
  // Hermes reasoning-effort vocabulary (none = thinking off sentinel)
  none: "Off", max: "Max", ultra: "Ultra",
};
function relTime(ts: number | undefined, justNow: string): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const m = Math.round(diff / 60000);
  if (m < 1) return justNow;
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return new Date(ts).toLocaleDateString();
}

// Cache the sessions list in localStorage so the agent list paints instantly on
// the next open (in-app nav AND app restart — the loopback origin :18799 is
// fixed, so localStorage persists). Seeded into state on mount, then overwritten
// wholesale by the live WS fetch (stale-while-revalidate).
const SESSIONS_CACHE_KEY = "shoggoth.chat.sessions.v1";
function readSessionCache(): SessionRow[] {
  try {
    const raw = localStorage.getItem(SESSIONS_CACHE_KEY);
    const arr = raw ? JSON.parse(raw) : null;
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function writeSessionCache(rows: SessionRow[]): void {
  try {
    localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify(rows));
  } catch {
    /* ignore quota / availability errors */
  }
}

// Last opened session, restored on the next mount so a reload/restart lands the
// user back where they were working instead of on whichever agent's heartbeat
// fired last (the old "most-recent activity" landing, kept only as fallback).
const LAST_ACTIVE_KEY = "shoggoth.chat.lastActive.v1";
function readLastActive(): string | null {
  try {
    return localStorage.getItem(LAST_ACTIVE_KEY);
  } catch {
    return null;
  }
}
function writeLastActive(key: string): void {
  try {
    localStorage.setItem(LAST_ACTIVE_KEY, key);
  } catch {
    /* ignore quota / availability errors */
  }
}

// Per-agent sticky session choice: the left-list row keeps previewing/opening the session
// the user last opened for that agent（不随 rep/updatedAt 翻转回 main），until the user
// opens another one or a session of that agent receives a NEW (non-noise) message — then
// the row follows that session. Persisted so reloads keep the user's mental map stable.
// v2：v1 没有新鲜度门槛，被 gateway 重置/重放的旧消息广播污染过，直接弃用。
const CHOSEN_SESSIONS_KEY = "shoggoth.chat.chosenSessions.v2";
function readChosenSessions(): Record<string, string> {
  try {
    const raw = localStorage.getItem(CHOSEN_SESSIONS_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}
function writeChosenSessions(map: Record<string, string>): void {
  try {
    localStorage.setItem(CHOSEN_SESSIONS_KEY, JSON.stringify(map));
  } catch {
    /* ignore quota / availability errors */
  }
}

// The gateway stamps SessionRow.updatedAt at session creation / sessions.patch only;
// messages arriving via a channel (e.g. Telegram delivery) never advance it, so a busy
// session can show a days-old time and sort wrong. We can't afford a chat.history per
// session, but whenever one IS loaded we learn its true last-message time and remember
// it here (key -> ms epoch), then raise updatedAt by it on every list fetch. Accuracy
// grows as you browse and persists across reloads.
// v2：v1 时代持久化的是含心跳/工具段/错误的 raw 最后消息时间，且存储单调只增（永不回落）——
// 跑过旧版的机器里那些虚高值会永久污染真实时间排序（点击进出位置来回跳）。升版本整体废弃 v1。
const ACTIVITY_KEY = "shoggoth.chat.activity.v2";
try { localStorage.removeItem("shoggoth.chat.activity.v1"); } catch { /* ignore */ }
function readActivity(): Record<string, number> {
  try {
    const raw = localStorage.getItem(ACTIVITY_KEY);
    const obj = raw ? JSON.parse(raw) : null;
    return obj && typeof obj === "object" ? (obj as Record<string, number>) : {};
  } catch {
    return {};
  }
}
function recordActivity(key: string, at: number): void {
  if (!key || !(at > 0)) return;
  try {
    const map = readActivity();
    if ((map[key] ?? 0) >= at) return;
    map[key] = at;
    localStorage.setItem(ACTIVITY_KEY, JSON.stringify(map));
  } catch {
    /* ignore quota / availability errors */
  }
}

// Assistant replies and incoming channel messages count; injected cron prompts do not.
function isUnreadReply(key: string, m: ChatMsg): boolean {
  return (m.role === "assistant" || sessionKindOf(key) === "channel" && m.role === "user" && !m.local)
    && !m.pending && !isNoiseForPreview(m)
    && !!(!isHeartbeatAckText(msgText(m)) || m.parts.some(p => p.type === "canvas" || p.type === "ui_artifact") || m.images?.length || m.files?.length);
}
function latestUnreadReplyTime(key: string, messages: ChatMsg[]): number {
  return messages.reduce((latest, m) => isUnreadReply(key, m) ? Math.max(latest, m.ts ?? 0) : latest, 0);
}
function latestHistoryPreview(messages: ChatMsg[]): { text: string; ts: number } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if ((m.role !== "user" && m.role !== "assistant") || isNoiseForPreview(m)) continue;
    const text = stripPreviewMd(lastText(m.parts));
    if (text) return { text: m.isError || m.stopReason === "error" ? `⚠ ${text}` : text, ts: m.ts ?? 0 };
  }
  return { text: "", ts: 0 };
}

// Per-session client-side message-id sets (hidden = locally deleted, pinned), keyed
// by session key in localStorage. Like upstream's deleted-messages/pinned-messages.
const HIDDEN_PREFIX = "shoggoth.chat.hidden.";
const PINNED_PREFIX = "shoggoth.chat.pinned.";
function readIdSet(prefix: string, key: string): Set<string> {
  try {
    const raw = localStorage.getItem(prefix + key);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}
function writeIdSet(prefix: string, key: string, set: Set<string>): void {
  try {
    if (set.size) localStorage.setItem(prefix + key, JSON.stringify([...set]));
    else localStorage.removeItem(prefix + key);
  } catch {
    /* ignore */
  }
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const cc = c as { type?: string; text?: string; thinking?: string };
        const ui = normalizeNativeUiPart(c);
        return ui ? nativeUiSummary(ui) : cc?.text ?? cc?.thinking ?? "";
      })
      .join("");
  }
  if (content && typeof content === "object") {
    const cc = content as { text?: string };
    if (typeof cc.text === "string") return cc.text;
  }
  return "";
}

// claude-cli 通道（agentRuntime:claude-cli 的模型，如 claude-opus-4-8）的历史是
// Anthropic 原生方言，块名与 pi-ai 通道不同：工具结果是 snake_case 的
// `tool_result`（字段 content/is_error/name），且并行调用的结果落成 role:"user"
// 的独立消息。normalize 按块形状归一，两种方言渲染成同一套 parts。
function isToolResultBlock(b: unknown): boolean {
  const t = (b as { type?: string } | null)?.type;
  return t === "tool_result" || t === "toolResult";
}
// tool_result 的 content：字符串直接用；数组（Anthropic 允许 text/image 混排）拼 text 块。
function toolResultBlockText(b: unknown): string {
  const c = (b as { content?: unknown } | null)?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (typeof (x as { text?: string })?.text === "string" ? (x as { text: string }).text : "")).join("");
  return "";
}

function toolResultBlockDuration(b: unknown): number | undefined {
  const duration = (b as { durationS?: unknown } | null)?.durationS;
  return typeof duration === "number" && duration > 0 && duration < 3600 ? duration : undefined;
}

function toolResultBlockArgs(b: unknown): unknown {
  const value = b as { arguments?: unknown; args?: unknown; input?: unknown } | null;
  return value?.arguments ?? value?.args ?? value?.input;
}

function planEntriesFromBlock(b: unknown): PlanEntry[] {
  const entries = (b as { planEntries?: unknown } | null)?.planEntries;
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => {
    if (!entry || typeof entry !== "object") return null;
    const value = entry as { content?: unknown; step?: unknown; status?: unknown };
    const content = typeof value.content === "string" ? value.content
      : typeof value.step === "string" ? value.step : "";
    if (!content) return null;
    return {
      content,
      status: typeof value.status === "string" ? value.status : "pending",
    };
  }).filter((entry): entry is PlanEntry => entry !== null);
}

// Raw gateway message → normalized ChatMsg.
// The gateway records a failed turn (stopReason "error") as a placeholder assistant
// message whose ONLY content is this fixed string, with the real cause carried on
// `errorMessage` (e.g. "401 … api key … invalid"). Treat it as non-renderable so the
// errorMessage swap below surfaces the actual error instead of this opaque text.
const STREAM_ERROR_FALLBACK_TEXT = "[assistant turn failed before producing content]";

function normalize(raw: any): ChatMsg {
  if (raw?.__archiveDivider) return { role: "system", parts: [], divider: raw.__archiveDivider };
  // Custom display records belong to the assistant's output. In particular,
  // empty nested-tool receipts must not become user boundaries between an
  // outer call and its result, or enter the user's attachment-cache lookup.
  let role = raw?.role === "custom" ? "assistant"
    : raw?.role === "assistant" || raw?.role === "toolResult" || raw?.role === "system"
    ? raw.role
    : "user";
  // claude-cli 通道：并行工具调用的结果是 role:"user" 且 content 全为 tool_result 块的
  // 消息。不归一的话它会渲染成右侧空白用户气泡，还会被图片回填按「空文本」缓存键
  // 错配上历史旧图（幽灵图片）。只在全块都是 tool_result 时才转，混排保持 user。
  const rawContent = raw?.content;
  if (role === "user" && Array.isArray(rawContent) && rawContent.length && rawContent.every(isToolResultBlock)) {
    role = "toolResult";
  }
  const preambleIds = openClawPreambleIds(raw);
  const base: ChatMsg = {
    role,
    openclawPreambleIds: preambleIds.length ? preambleIds : undefined,
    openclawPreambleKey: preambleIds.length === 1 ? openClawPreambleKey(raw.__openclaw.runId, preambleIds[0]) : undefined,
    parts: [],
    historySource: raw?.historySource === "hermes" ? "hermes" : undefined,
    automation: raw?.automation === "continuation" ? "continuation"
      : raw?.automation === "cron" || role === "user" && raw?.shoggoth?.source === "cron" ? "cron" : undefined,
    nativeDisplayId: raw?.shoggoth?.nativeUiVersion === 1 && typeof raw.shoggoth.displayId === "string" ? raw.shoggoth.displayId : undefined,
    nativeRunId: raw?.shoggoth?.nativeUiVersion === 1 && typeof raw.shoggoth.runId === "string" ? raw.shoggoth.runId : undefined,
    activityRunId: typeof raw?.__openclaw?.runId === "string" && raw.__openclaw.runId.trim() ? raw.__openclaw.runId : undefined,
    canonicalSourceEventId: raw?.shoggoth?.contextExcluded !== true && typeof raw?.shoggoth?.sourceEventId === "string" ? raw.shoggoth.sourceEventId : undefined,
    sourceEventIds: Array.isArray(raw?.shoggoth?.sourceEventIds) ? raw.shoggoth.sourceEventIds.filter((id: unknown) => typeof id === "string") : undefined,
    id: raw?.__openclaw?.id ?? (typeof raw?.id === "string" ? raw.id : undefined),
    idempotencyKey: typeof raw?.idempotencyKey === "string" ? raw.idempotencyKey
      : typeof raw?.__openclaw?.idempotencyKey === "string" ? raw.__openclaw.idempotencyKey : undefined,
    ts: typeof raw?.timestamp === "number" ? raw.timestamp : undefined,
    model: raw?.model,
    provider: raw?.provider,
    usage: raw?.usage,
    responseMetadata: raw?.responseMetadata,
    stopReason: raw?.stopReason,
    errorMessage: raw?.errorMessage,
    toolName: raw?.toolName,
    isError: raw?.isError === true,
    provenance: raw?.provenance && typeof raw.provenance === "object" ? raw.provenance : undefined,
    notice: raw?.notice === "modelSwitch" || raw?.notice === "runInterrupted" ? raw.notice : undefined,
  };
  if (raw?.role === "custom" && (raw.display === false || raw.content === "")) return base;
  const media = normalizeOpenClawMediaFacts(raw?.__openclaw?.media);
  if (media.length) base.files = media;
  const nativeMedia = nativeChatMedia(raw?.shoggoth?.attachments);
  if (role === "user" && Array.isArray(raw?.shoggoth?.pluginSelection)) {
    base.pluginSelection = raw.shoggoth.pluginSelection.filter((item: unknown): item is ChatPluginSelection =>
      !!item && typeof item === "object" && typeof (item as ChatPluginSelection).installationId === "string"
      && Number.isSafeInteger((item as ChatPluginSelection).revision));
  }
  if (role === "user" && Array.isArray(raw?.shoggoth?.pluginSelectionSnapshot)) {
    base.pluginSelectionSnapshot = raw.shoggoth.pluginSelectionSnapshot.slice(0, 4)
      .filter((item: unknown): item is ChatPluginSelection & { packageName: string; declaredVersion: string | null } =>
        !!item && typeof item === "object" && typeof (item as { packageName?: unknown }).packageName === "string"
        && typeof (item as ChatPluginSelection).installationId === "string"
        && Number.isSafeInteger((item as ChatPluginSelection).revision)
        && ((item as { declaredVersion?: unknown }).declaredVersion === null
          || typeof (item as { declaredVersion?: unknown }).declaredVersion === "string"));
  }
  if (nativeMedia.attachments.length) base.nativeAttachments = nativeMedia.attachments;
  if (nativeMedia.images.length) base.images = nativeMedia.images;
  if (nativeMedia.files.length) base.files = nativeMedia.files;
  const interruptedApproval = role === "assistant" ? interruptedApprovalEntry(raw?.shoggoth?.interruptedApproval) : null;
  if (interruptedApproval) {
    base.parts = [{ type: "prompt", promptEntry: interruptedApproval }];
    return base;
  }
  if (role === "toolResult") {
    // pi-ai 通道：content=[{type:"text"}]、工具名在消息级 toolName；claude-cli 通道：
    // content=[{type:"tool_result", content, is_error, name}]，并行时一条消息多块。
    const trBlocks = Array.isArray(rawContent) ? rawContent.filter(isToolResultBlock) : [];
    base.parts = trBlocks.length
      ? trBlocks.map((b: any) => ({
          type: "toolResult" as const,
          text: toolResultBlockText(b),
          toolName: typeof b?.name === "string" ? b.name : raw?.toolName,
          toolCallId: typeof b?.toolCallId === "string" ? b.toolCallId
            : typeof raw?.toolCallId === "string" ? raw.toolCallId : undefined,
          toolArgs: toolResultBlockArgs(b),
          isError: typeof b?.is_error === "boolean" ? b.is_error
            : typeof raw?.isError === "boolean" ? raw.isError : undefined,
          durationS: toolResultBlockDuration(b),
          pluginAppCallId: validPluginAppCallId(b?.pluginAppCallId),
        }))
      : [{ type: "toolResult", text: contentToText(raw?.content), toolName: raw?.toolName,
          toolCallId: typeof raw?.toolCallId === "string" ? raw.toolCallId : undefined,
          isError: typeof raw?.isError === "boolean" ? raw.isError : undefined }];
    return base;
  }
  if (role === "user" || role === "system") {
    base.parts = [{ type: "text", text: contentToText(raw?.content) }];
    return base;
  }
  // assistant: split the content array into typed parts
  const content = raw?.content;
  if (Array.isArray(content)) {
    for (const c of content) {
      const cc = c as { type?: string; id?: unknown; toolCallId?: unknown; text?: string; thinking?: string; toolName?: string; name?: string; arguments?: unknown; args?: unknown; input?: unknown; is_error?: boolean; durationS?: unknown; planEntries?: unknown; pluginAppCallId?: unknown };
      const uiArtifact = normalizeNativeUiPart(cc);
      if (uiArtifact) base.parts.push({ type: "ui_artifact", uiArtifact, segmentId: uiArtifact.segmentId, sourceEventId: uiArtifact.sourceEventId });
      else if (cc?.type === "thinking") base.parts.push({ type: "thinking", text: cc.thinking ?? "" });
      else if (cc?.type === "plan") {
        const planEntries = planEntriesFromBlock(cc);
        // Empty snapshots retire a previous plan and must survive history normalization.
        if (Array.isArray(cc.planEntries)) base.parts.push({ type: "plan", planEntries });
      }
      else if (cc?.type === "canvas") {
        const widget = normalizeChatCanvasWidgetPart(cc);
        base.parts.push(widget ?? { type: "canvas" });
      }
      // 工具调用块名三方言：pi-ai "toolCall"、claude-cli "toolcall"、Anthropic 标准 "tool_use"。
      else if (cc?.type === "toolCall" || cc?.type === "toolcall" || cc?.type === "tool_use") base.parts.push({
        type: "toolCall", toolName: cc.toolName ?? cc.name ?? "tool",
        toolCallId: typeof cc.id === "string" ? cc.id : typeof cc.toolCallId === "string" ? cc.toolCallId : undefined,
        toolArgs: cc.arguments ?? cc.args ?? cc.input });
      // claude-cli 通道把串行工具的结果直接嵌进 assistant 消息（pi-ai 是独立 toolResult 消息）。
      else if (isToolResultBlock(cc)) base.parts.push({
        type: "toolResult",
        text: toolResultBlockText(cc),
        toolName: typeof cc.name === "string" ? cc.name : undefined,
        toolCallId: typeof cc.toolCallId === "string" ? cc.toolCallId : undefined,
        toolArgs: toolResultBlockArgs(cc),
        isError: typeof cc.is_error === "boolean" ? cc.is_error : undefined,
        durationS: toolResultBlockDuration(cc),
        pluginAppCallId: validPluginAppCallId(cc.pluginAppCallId),
      });
      else if (typeof cc?.text === "string") base.parts.push({ type: "text", text: cc.text,
        ...((cc as any).activity === true ? { activity: true } : {}),
        ...(typeof (cc as any).segmentId === "string" ? { segmentId: (cc as any).segmentId } : {}),
        ...(typeof (cc as any).sourceEventId === "string" ? { sourceEventId: (cc as any).sourceEventId } : {}) });
    }
  } else if (content && typeof content === "object" && (content as { type?: unknown }).type === "canvas") {
    const widget = normalizeChatCanvasWidgetPart(content);
    base.parts.push(widget ?? { type: "canvas" });
  } else if (typeof content === "string") {
    base.parts.push({ type: "text", text: content });
  }
  // A failed/aborted turn often arrives as content:[{type:"text",text:""}] — an
  // empty string, NOT an empty array — with the real cause only in errorMessage
  // (e.g. "LLM idle timeout (120s): no response from model" from a stalled model).
  // That empty text part makes parts.length>0, so the old `!parts.length` guard
  // missed it and the bubble rendered blank. Surface errorMessage whenever nothing
  // renderable was produced, replacing the empty part(s), and flag it so it renders
  // as an error bubble instead of a silent blank.
  const hasRenderable = base.parts.some(
    (p) =>
      p.type === "toolCall" ||
      p.type === "toolResult" ||
      (p.type === "plan" && !!p.planEntries?.length) ||
      p.type === "canvas" || p.type === "ui_artifact" ||
      (!!p.text?.trim() && p.text.trim() !== STREAM_ERROR_FALLBACK_TEXT),
  );
  if (base.parts.some(part => part.type === "ui_artifact") && typeof raw?.errorMessage === "string") {
    base.parts.push({ type: "text", text: `⚠ ${raw.errorMessage}`, segmentId: `${base.nativeDisplayId}:terminal-error` });
  }
  if (!hasRenderable && raw?.errorMessage) {
    base.parts = [...base.parts.filter((part) => part.type === "plan"), { type: "text", text: raw.errorMessage }];
    base.isError = true;
  }
  return base;
}

// Live tool entries streamed during a turn (gateway `agent`/`session.tool` events,
// stream==="tool", phases start|update|result). Tracked per session, rendered as
// tool cards on the in-progress assistant bubble alongside the streaming text.
// (Reasoning/thinking is NOT streamed — only tools + answer text are — so it still
// arrives only with the final message; see the `final` reload-on-final handler.)
interface ToolEntry {
  id: string;
  name: string;
  args?: unknown; // call arguments (from the `start` phase) → rendered in the card title
  phase?: "start" | "update" | "result";
  output?: string; // partial output does not imply completion
  pluginAppCallId?: string;
  isError?: boolean; // the tool failed
  diff?: { path: string; oldText: string; newText: string }; // write/patch file-edit diff
  diffText?: string; // unified diff text (Hermes gateway inline_diff)
  durationS?: number; // runtime seconds (Hermes gateway tool.complete)
}
function formatToolOutput(v: unknown): string {
  if (v == null) return "";
  let s: string;
  if (typeof v === "string") s = v;
  else {
    try {
      s = JSON.stringify(v, null, 2);
    } catch {
      s = String(v);
    }
  }
  return s.length > 4000 ? s.slice(0, 4000) + "\n…" : s;
}
// Heuristic "product view" of a tool result: turn a JSON blob into one human line
// (prefer message/title/summary/status; arrays → count + first items). Returns null
// when there's nothing better than the raw text (the card then shows raw only).
function formatToolResultSummary(text?: string): string | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  if (!(raw.startsWith("{") || raw.startsWith("["))) {
    return raw.length <= 200 ? null : raw.slice(0, 200) + "…";
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null; // truncated/partial JSON — keep the raw view only
  }
  if (Array.isArray(obj)) {
    const head = obj.slice(0, 3).map((x) => (typeof x === "string" ? x : (x as Record<string, unknown>)?.title || (x as Record<string, unknown>)?.name || (x as Record<string, unknown>)?.id || "…"));
    return obj.length ? `${obj.length} 项:${head.join("、")}${obj.length > 3 ? "…" : ""}` : "(空)";
  }
  if (obj && typeof obj === "object") {
    const o = obj as Record<string, unknown>;
    for (const k of ["message", "title", "summary"]) {
      if (typeof o[k] === "string" && (o[k] as string).trim()) return (o[k] as string).trim().slice(0, 240);
    }
    for (const arrKey of ["results", "items", "matches", "data"]) {
      if (Array.isArray(o[arrKey])) return `${(o[arrKey] as unknown[]).length} ${arrKey}`;
    }
    if (typeof o.status === "string") return `status: ${o.status}`;
    const keys = Object.keys(o);
    if (keys.length) return keys.slice(0, 4).map((k) => `${k}: ${typeof o[k] === "object" ? "…" : String(o[k]).slice(0, 32)}`).join(" · ");
  }
  return null;
}
function toolEntryToPart(e: ToolEntry): Part {
  const base: Part =
    e.phase === "result" || (e.phase === undefined && (e.output != null || e.pluginAppCallId != null))
      ? { type: "toolResult", toolName: e.name, toolArgs: e.args, text: e.output, isError: e.isError }
      : { type: "toolCall", toolName: e.name, toolArgs: e.args };
  base.toolCallId = e.id;
  if (e.diff) base.diff = e.diff;
  if (e.diffText) base.diffText = e.diffText;
  if (e.durationS != null) base.durationS = e.durationS;
  if (e.pluginAppCallId) base.pluginAppCallId = e.pluginAppCallId;
  return base;
}
function lastText(parts: Part[]): string {
  for (let i = parts.length - 1; i >= 0; i -= 1) if (parts[i].type === "text") return parts[i].text ?? "";
  return "";
}
// pending assistant parts = [live tool cards…, streaming text]. A trailing text part
// is always present (even empty) so the blinking cursor has somewhere to sit.
function composePendingParts(
  tools: ToolEntry[],
  text: string,
  thinking = "",
  plan: PlanEntry[] = [],
  prompts: ChatPromptEntry[] = [],
  canvas: Part[] = [],
): Part[] {
  return [
    ...(plan.length ? [{ type: "plan", planEntries: plan } as Part] : []),
    ...(thinking.trim() ? [{ type: "thinking", text: thinking } as Part] : []),
    ...tools.map(toolEntryToPart),
    ...prompts.map((pe) => ({ type: "prompt", promptEntry: pe } as Part)),
    ...canvas,
    { type: "text", text },
  ];
}

function applyNativeUiDelta(prev: ChatMsg[], raw: any, tools: ToolEntry[], thinking: string, plan: PlanEntry[], prompts: ChatPromptEntry[]): ChatMsg[] {
  const norm = normalize({ ...raw, role: "assistant" });
  const process = composePendingParts(tools, "", thinking, plan, prompts).filter(part => part.type !== "text");
  const message = { ...norm, parts: [...process, ...norm.parts], pending: true, keepLiveLayout: true };
  const out: ChatMsg[] = []; let inserted = false;
  let boundary = -1;
  for (let index = 0; index < prev.length; index++) if (prev[index].role === "user") boundary = index;
  prev.forEach((value, index) => {
    if (index > boundary && value.role === "assistant" && (value.pending || value.nativeRunId === norm.nativeRunId)) {
      if (!inserted) { out.push({ ...message, ts: value.ts ?? norm.ts }); inserted = true; }
    } else out.push(value);
  });
  if (!inserted) out.push(message); return out;
}

function canvasPartsFromContent(content: unknown): Part[] {
  return normalizeChatCanvasWidgetParts(content).map((part) => part ?? { type: "canvas" });
}

// streaming: update the accumulated text of the trailing pending assistant, keeping
// any live tool cards already attached to it.
function applyDelta(
  prev: ChatMsg[],
  text: string,
  tools: ToolEntry[],
  thinking = "",
  plan: PlanEntry[] = [],
  prompts: ChatPromptEntry[] = [],
  canvas: Part[] = [],
): ChatMsg[] {
  const out = prev.slice();
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i].role === "assistant" && out[i].pending) {
      const cur = lastText(out[i].parts);
      const next = mergeLiveText(cur, text);
      const liveCanvas = canvas.length ? canvas : out[i].parts.filter((part) => part.type === "canvas");
      out[i] = { ...out[i], parts: composePendingParts(tools, next, thinking, plan, prompts, liveCanvas) };
      return out;
    }
  }
  for (let i = 0; i < out.length; i += 1) {
    if (out[i].keepLiveLayout) out[i] = { ...out[i], keepLiveLayout: false };
  }
  return [...out, { role: "assistant", parts: composePendingParts(tools, text, thinking, plan, prompts, canvas), pending: true }];
}
// A streamed tool lifecycle event mutated `tools`; re-render the pending assistant
// (creating one if the turn started outside our own send), keeping its streamed text.
function applyToolStream(prev: ChatMsg[], tools: ToolEntry[], thinking = "", plan: PlanEntry[] = [], prompts: ChatPromptEntry[] = []): ChatMsg[] {
  const out = prev.slice();
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i].role === "assistant" && out[i].pending) {
      const native = out[i].parts.some(part => part.type === "ui_artifact");
      const canvas = out[i].parts.filter((part) => part.type === "canvas");
      out[i] = { ...out[i], parts: native
        ? [...composePendingParts(tools, "", thinking, plan, prompts).filter(part => part.type !== "text"),
          ...out[i].parts.filter(part => part.type === "text" || part.type === "ui_artifact")]
        : composePendingParts(tools, lastText(out[i].parts), thinking, plan, prompts, canvas) };
      return out;
    }
  }
  for (let i = 0; i < out.length; i += 1) {
    if (out[i].keepLiveLayout) out[i] = { ...out[i], keepLiveLayout: false };
  }
  return [...out, { role: "assistant", parts: composePendingParts(tools, "", thinking, plan, prompts), pending: true }];
}
function settlePendingAssistant(prev: ChatMsg[], liveSteps?: TurnStep[]): ChatMsg[] {
  const compactionSteps = liveSteps?.some((step) => step.kind === "status")
    ? withoutPlanSteps(liveSteps).filter((step) => step.kind !== "user" && step.kind !== "final" && (step.kind !== "text" || step.activity)) : undefined;
  return prev.flatMap((message) => {
    if (message.role !== "assistant" || !message.pending) return [message];
    let parts = message.parts.filter((part) => part.type !== "prompt"
      && (part.type !== "text" || !!part.text?.trim()));
    // Bind a terminal compaction receipt to this tail, rather than letting a
    // later turn's live timeline update the stopped activity.
    if (compactionSteps?.length) parts = [{ type: "timeline", steps: compactionSteps },
      ...parts.filter((part) => !["thinking", "toolCall", "toolResult", "plan", "timeline"].includes(part.type))];
    // A stop receipt can arrive before the terminal event/history. Keep the
    // visible text and process in place while retiring prompts and empty cursors.
    return parts.length || message.images?.length || message.files?.length
      ? [{ ...message, parts, pending: false, settledPending: !compactionSteps?.length, keepLiveLayout: true }] : [];
  });
}
function retainLiveLayout(previous: ChatMsg[], history: ChatMsg[]): ChatMsg[] {
  const textOf = (message: ChatMsg) => message.parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
  const remaining = new Map<string, number>();
  for (const message of previous) {
    if (message.role !== "assistant" || !message.keepLiveLayout) continue;
    const text = textOf(message);
    if (text.trim()) remaining.set(text, (remaining.get(text) ?? 0) + 1);
  }
  const next = history.slice();
  // Match from the tail, consuming each occurrence once. Canonical ids and
  // timestamps stay intact; an older identical reply keeps history optimization.
  for (let index = next.length - 1; index >= 0 && remaining.size; index -= 1) {
    const message = next[index];
    if (message.role !== "assistant") continue;
    const text = textOf(message);
    const count = remaining.get(text) ?? 0;
    if (!count) continue;
    next[index] = { ...message, keepLiveLayout: true };
    if (count === 1) remaining.delete(text);
    else remaining.set(text, count - 1);
  }
  // Status-only stopped turns have no assistant text to match. Keep their
  // in-memory receipt only while the canonical history has the same user tail.
  const previousUser = [...previous].reverse().find((message) => message.role === "user");
  const historyUser = [...history].reverse().find((message) => message.role === "user");
  const sameUser = previousUser && historyUser && (previousUser.id && historyUser.id
    ? previousUser.id === historyUser.id
    : previousUser.ts != null && previousUser.ts === historyUser.ts && textOf(previousUser) === textOf(historyUser));
  const previousUserIndex = previousUser ? previous.indexOf(previousUser) : -1;
  if (sameUser) for (const message of previous.slice(previousUserIndex + 1)) {
    if (message.role === "assistant" && message.keepLiveLayout && !textOf(message).trim()
      && message.parts.some((part) => part.type === "timeline" && part.steps?.some((step) => step.kind === "status"))) {
      next.push(message);
    }
  }
  return next;
}
function finalizeAssistant(prev: ChatMsg[], finalMsg: any, streamedTextOverride?: string, preserveLiveProcess = false): ChatMsg[] {
  // Normalize the completed turn the SAME way loadHistory does, so a streamed reply
  // renders identically to a reloaded one. The old path flattened content via
  // contentToText into a single text part, which dropped the thinking/text split:
  // a reasoning turn never rendered as a Reasoning card live — it only appeared
  // after switching agents away and back re-ran normalize. Reuse normalize to keep
  // the typed parts (thinking/toolCall/text) + the R14 empty-turn error handling.
  // (finalMsg may be a message object or a bare content value; force the assistant
  // role since normalize defaults unknown roles to "user".)
  const raw =
    finalMsg && typeof finalMsg === "object" && !Array.isArray(finalMsg)
      ? finalMsg.type === "canvas"
        ? { role: "assistant", content: finalMsg }
        : { ...finalMsg, role: "assistant" }
      : { role: "assistant", content: finalMsg };
  const norm = normalize(raw);
  const out = prev.slice();
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i].role === "user") break;
    if (out[i].role === "assistant" && (out[i].pending || out[i].settledPending)) {
      if (streamedTextOverride !== undefined) {
        const streamed = out[i];
        const parts = streamed.parts.slice();
        let textIndex = -1;
        for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
          if (parts[partIndex].type === "text") {
            textIndex = partIndex;
            break;
          }
        }
        const nextText = mergeLiveText(lastText(parts), streamedTextOverride);
        if (textIndex >= 0) parts[textIndex] = { ...parts[textIndex], text: nextText };
        else parts.push({ type: "text", text: nextText });
        out[i] = {
          ...streamed,
          ...norm,
          // A steered final is still the full runtime item. Preserve the already
          // projected live segment instead of replacing it with that full text.
          parts,
          pending: false,
          settledPending: false,
          keepLiveLayout: true,
          ts: norm.ts ?? streamed.ts ?? Date.now(),
        };
        return out;
      }
      const finalParts = norm.parts.some((part) => part.type !== "text" || !!part.text?.trim())
        ? norm.parts : out[i].parts;
      const isProcess = (part: Part) => ["thinking", "toolCall", "toolResult", "plan", "timeline"].includes(part.type);
      // Text-only final frames arrive before the canonical history. Keep the
      // live process here so its row does not disappear and then reappear when
      // that history arrives. A structured final already owns its process.
      const liveProcess = preserveLiveProcess && !finalParts.some(isProcess) ? out[i].parts.filter(isProcess) : [];
      out[i] = {
        ...norm,
        nativeDisplayId: norm.nativeDisplayId ?? out[i].nativeDisplayId,
        nativeRunId: norm.nativeRunId ?? out[i].nativeRunId,
        keepLiveLayout: true,
        // if the final frame carried nothing renderable, keep what streamed in
        parts: [...liveProcess, ...finalParts],
        model: norm.model ?? out[i].model,
        provider: norm.provider ?? out[i].provider,
        usage: norm.usage ?? out[i].usage,
        responseMetadata: norm.responseMetadata ?? out[i].responseMetadata,
        // Local-clock fallback: if the final frame carried no numeric timestamp
        // (some backends omit it / send an ISO string that normalize's number gate
        // drops), stamp the real moment this turn landed so the footer always has a
        // time. This is the actual receipt time, not a fabricated value.
        ts: norm.ts ?? out[i].ts ?? Date.now(),
      };
      return out;
    }
  }
  return norm.parts.length ? [...out, { ...norm, keepLiveLayout: true }] : out;
}

function appendSteeringMessage(prev: ChatMsg[], text: string): ChatMsg[] {
  const out = prev.slice();
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i].role === "assistant" && out[i].pending) {
      const hasContent = out[i].parts.some((part) => (
        part.type !== "text" || (part.text ?? "").length > 0
      ));
      if (hasContent) out[i] = { ...out[i], pending: false };
      else out.splice(i, 1);
      break;
    }
  }
  return [
    ...out,
    { role: "user", parts: [{ type: "text", text }], ts: Date.now() },
    { role: "assistant", parts: composePendingParts([], ""), pending: true },
  ];
}

export function canSteerActiveChat(
  capabilities: Pick<ChatCapabilities, "steer"> | undefined,
  runStatus: string | undefined,
  attachmentCount: number,
): boolean {
  return capabilities?.steer === true && runStatus === "running" && attachmentCount === 0;
}

// consecutive same-role messages collapse into one visual group.
interface Group {
  role: ChatMsg["role"];
  msgs: ChatMsg[];
  ts?: number;
}
// A failed assistant turn (stopReason "error", or the R14 isError swap). Used to
// collapse repeats below.
function isErrorTurn(m: ChatMsg): boolean {
  return (m.role === "assistant" && (m.stopReason === "error" || m.isError === true))
    || (m.role === "system" && (m.errPrefix === "chat.errorPrefix" || m.errPrefix === "chat.sendFailed"));
}
// 「真实对话活动」正向判定 —— 列表时间/排序的唯一口径：用户真实发言，或 agent 成功产出的正文
// 回复。心跳/注入 prompt（isNoiseForPreview）与错误泡（isErrorTurn：402/限流/连接错误）都不算——
// 否则 agent 一收到心跳或错误就按其时间跳到列表前显示「刚刚」，点开却没有新对话。新增噪音类型
// 一律在这里挡，别再去各时间源加排除条件。注意：仅时间/排序用；副标题预览刻意不同——错误仍以
// ⚠ 前缀显示，让人一眼看到 agent 出错了。
function isRealActivity(m: ChatMsg): boolean {
  if (m.role !== "user" && m.role !== "assistant") return false;
  if (isNoiseForPreview(m) || isErrorTurn(m)) return false;
  // assistant 还要求「说了话」（非空正文）：心跳轮的中间段是 thinking+toolCall、无正文
  // （[OpenClaw heartbeat poll] → 查板工具调用 → HEARTBEAT_OK ack）——ack 被上面的噪音判定排掉，
  // 但工具段不含心跳记号、单看无法识别，每 30 分钟把 agent 顶成「刚刚」。锚定正文后它自然不算；
  // 真实轮次最终都会落一条正文回复，时间锚到那条，分钟级无差。
  if (m.role === "assistant") {
    return m.parts.some((p) => p.type === "canvas" || p.type === "ui_artifact" || (p.type === "text" && !!p.text?.trim()));
  }
  return true;
}
// Fold a run of consecutive IDENTICAL failed turns into one bubble carrying a ×N
// count. A scheduled agent whose model key/quota is dead red-bubbles on every wake
// (e.g. a 30-min heartbeat → dozens of identical "401 … key invalid" turns), which
// otherwise floods the thread. Distinct errors (different text) stay separate, each
// with its own count. Time advances to the latest occurrence. Operates on the
// already-filtered list, so heartbeat-prompt user turns between failures are gone →
// the failures are adjacent. Copies before mutating so React state isn't touched.
function collapseErrorRuns(msgs: ChatMsg[]): ChatMsg[] {
  const out: ChatMsg[] = [];
  for (const m of msgs) {
    const prev = out[out.length - 1];
    if (prev && isErrorTurn(prev) && isErrorTurn(m) && msgText(prev) === msgText(m)) {
      prev.repeat = (prev.repeat ?? 1) + 1;
      prev.ts = m.ts ?? prev.ts;
      continue;
    }
    out.push({ ...m });
  }
  return out;
}

function groupMessages(msgs: ChatMsg[]): Group[] {
  const groups: Group[] = [];
  for (const m of msgs) {
    const last = groups[groups.length - 1];
    // Group consecutive same-role messages into one visual block — INCLUDING
    // toolResults (was excluded), so a turn's tool-output cards stack tightly in
    // one group with a single footer instead of each becoming a separate, spaced,
    // individually-footered group (matches OpenClaw's compact tool rendering).
    // Archive dividers + backend timeline notices never merge (in either
    // direction) — each is its own one-line row.
    const standalone = (x: ChatMsg) => !!x.divider || !!x.notice;
    const lastIsDivider = last && standalone(last.msgs[last.msgs.length - 1]);
    if (last && last.role === m.role && !lastIsDivider && !standalone(m)) {
      last.msgs.push(m);
      // g.ts 保留组内 FIRST 条的时间，但只作 footer 的兜底：footer 实际显示组内最后一条
      // 「可见」消息的时间（见 footer 渲染处 footerTs）。被隐藏的 heartbeat 会让不同时间的
      // 同-role turn 相邻合并，纯 delivery-mirror 会话甚至整段历史合成一个组——此时组首时间
      // 可能比末条早数周，与列表/头部 badge（updatedAt≈末条活动）对不上，用户会误判数据丢失。
      last.ts = last.ts ?? m.ts;
    } else {
      groups.push({ role: m.role, msgs: [m], ts: m.ts });
    }
  }
  return groups;
}

// R339:把已完成回合的过程(thinking/toolCall/toolResult/plan parts)折成一个
// `timeline` part,挂到该回合首条 assistant 消息最前;被吸收的 parts 与纯
// toolResult 消息从流中移除,正文/错误 text part 原样保留。分段边界:user 消息、
// 分隔线/notice、本地 slash 结果、pending(直播轮 S2 另有实时管道)。
// 已知 Run ID 优先决定回合归属;只有缺少身份时才用 > 90s 的时间间隙兜底。
// heartbeat 等隐藏项会让 cron/delivery-mirror 历史中的不同回合同 role 消息
// 粘连,但同一个已知 Run 的慢工具/审批等待不能被间隙拆开。
const TURN_GAP_MS = 90_000;
function absorbTurnTimelines(msgs: ChatMsg[], lastLiveSteps?: TurnStep[]): ChatMsg[] {
  const isBoundary = (x: ChatMsg) => x.role === "user" || !!x.divider || !!x.notice || x.local === true || x.pending === true;
  const isProcessPart = (p: Part) => p.type === "thinking" || p.type === "toolCall" || p.type === "toolResult" || p.type === "plan"
    || (p.type === "text" && p.activity === true);
  const out: ChatMsg[] = [];
  const trackCalls = (open: Set<string>, message: ChatMsg) => {
    for (const part of message.parts) if (part.toolCallId) {
      if (part.type === "toolCall") open.add(part.toolCallId);
      if (part.type === "toolResult") open.delete(part.toolCallId);
    }
  };
  let i = 0;
  while (i < msgs.length) {
    if (isBoundary(msgs[i])) {
      out.push(msgs[i]);
      i += 1;
      continue;
    }
    // 连续产出先按已知 Run 归属分段,缺少身份才用时间间隙兜底。
    const seg: ChatMsg[] = [msgs[i]];
    let runId = msgs[i].nativeRunId ?? msgs[i].activityRunId;
    const openToolIds = new Set<string>();
    trackCalls(openToolIds, msgs[i]);
    i += 1;
    while (i < msgs.length && !isBoundary(msgs[i])) {
      const prev = seg[seg.length - 1];
      const nextRunId = msgs[i].nativeRunId ?? msgs[i].activityRunId;
      if (runId && nextRunId && runId !== nextRunId) break;
      const sameRun = !!runId && runId === nextRunId;
      // Hermes persists real user boundaries (including Cron inputs). Tool
      // latency or a transport continuation inside that turn is not a new run.
      const hermesTurn = prev.historySource === "hermes" && msgs[i].historySource === "hermes";
      const results = msgs[i].parts.filter(part => part.type === "toolResult");
      const completesCall = results.length > 0 && results.every(part => part.toolCallId && openToolIds.has(part.toolCallId));
      if (!sameRun && !hermesTurn && !completesCall && prev.ts && msgs[i].ts && msgs[i].ts! - prev.ts! > TURN_GAP_MS) break;
      runId ||= nextRunId;
      trackCalls(openToolIds, msgs[i]);
      seg.push(msgs[i]);
      i += 1;
    }
    // 带上「这个 part 属于哪条消息」的时间戳,供下面推算耗时(R350)。
    const partSeq: (TimelinePartLike & { ts?: number })[] = [];
    for (const sm of seg) for (const p of sm.parts) if (isProcessPart(p)) partSeq.push({ ...(p as TimelinePartLike), ts: sm.ts });
    const compactionSnapshot = seg.flatMap((message) => message.parts).find((part) => part.type === "timeline"
      && part.steps?.some((step) => step.kind === "status"));
    if ((!partSeq.length && !compactionSnapshot) || !seg.some((sm) => sm.role === "assistant")) {
      out.push(...seg);
      continue;
    }
    // R350:转录不存 per-tool 耗时,但每条消息有时间戳 → 用「结果消息时刻 − 发起调用
    // 的消息时刻」还原(与 cron 运行轨迹 R345 同一招)。配对口径与 stepsFromParts 一致
    // (FIFO,历史无 toolCallId)。同一条 assistant 消息里并行发起的多个工具共享起点
    // (偏保守);后端自带 durationS(Hermes)优先,负值/超 1h 的异常差值丢弃。
    const openCalls: (TimelinePartLike & { ts?: number })[] = [];
    for (const p of partSeq) {
      if (p.type === "toolCall") {
        openCalls.push(p);
      } else if (p.type === "toolResult") {
        const callIndex = p.toolCallId ? openCalls.findIndex(call => call.toolCallId === p.toolCallId) : 0;
        const call = callIndex >= 0 ? openCalls.splice(callIndex, 1)[0] : undefined;
        if (p.durationS == null && typeof call?.ts === "number" && typeof p.ts === "number") {
          const d = (p.ts - call.ts) / 1000;
          if (d > 0 && d < 3600) p.durationS = d;
        }
      }
    }
    const steps = compactionSnapshot?.steps ?? stepsFromParts(partSeq);
    const turnStartId = seg.find(message => message.role === "assistant")?.actionId;
    let attached = false;
    for (const sm of seg) {
      if (sm.role === "toolResult") continue; // 内容已进 steps
      // Public commentary is both a process record and a durable chat message.
      const rest = sm.parts.filter((p) => (p.type === "text" || !isProcessPart(p)) && (!compactionSnapshot || p.type !== "timeline"));
      if (!attached && sm.role === "assistant") {
        out.push({ ...sm, turnStartId, parts: [{ type: "timeline", steps }, ...rest] });
        attached = true;
      } else if (rest.length || sm.images?.length || sm.files?.length) {
        out.push({ ...sm, turnStartId, parts: rest });
      }
      // else:纯过程消息被吸收后只剩空壳 → 丢弃(回合 footer 取组尾消息,不受影响)
    }
  }
  // 最近一轮 stitch:history 是降级数据(无相位/耗时),刚结束那轮的直播步骤还在
  // 内存里 → 工具数吻合时,把线程里最后一条 timeline 换成富数据版(user/final/text
  // 步滤掉,与吸收版口径一致)。数目不吻合(转录截断/口径漂移)就保持降级,不硬贴。
  if (lastLiveSteps?.length) {
    const rich = withoutPlanSteps(lastLiveSteps).filter((s) => s.kind !== "user" && s.kind !== "final" && (s.kind !== "text" || s.activity));
    const richTools = rich.filter((s) => s.kind === "tool").length;
    if (richTools > 0) {
      for (let j = out.length - 1; j >= 0; j--) {
        const ti = out[j].parts.findIndex((p) => p.type === "timeline");
        if (ti < 0) continue;
        const absorbed = out[j].parts[ti].steps ?? [];
        if (absorbed.filter((s) => s.kind === "tool").length === richTools) {
          const parts = out[j].parts.slice();
          parts[ti] = { ...parts[ti], steps: rich };
          out[j] = { ...out[j], parts };
        }
        break;
      }
    }
  }
  return out;
}

// Size the send-anchor stream spacer so the thread's MAX scroll position puts the
// anchored user bubble at the top of the viewport (same rest offset as the inner
// padding-top under the floating header) — i.e. reserve exactly one viewport of
// standing room below the bubble, minus whatever the growing reply already fills.
// Returns the anchor's target scrollTop. Runs pre-paint per message pass: as the
// reply streams in the spacer shrinks 1:1, so scrollHeight — and therefore the
// user's viewport — holds perfectly still; once the reply overflows, the spacer
// stays 0 and growth simply extends below the fold (no scrolling).
// ≈4 条上文气泡的高度：发送后自己的消息不顶死在头部下沿，上方保留一段刚读过的
// 上下文再锚定（R280 用户校准——"留出4个气泡的高度，不直接顶到最上面"）。
const SEND_ANCHOR_CONTEXT_PX = 280;

function sizeStreamSpacer(thread: HTMLDivElement, spacer: HTMLDivElement, anchorTop: number): number {
  const inner = spacer.parentElement;
  const padTop = inner ? parseFloat(getComputedStyle(inner).paddingTop) || 0 : 0;
  const target = Math.max(0, anchorTop - padTop - SEND_ANCHOR_CONTEXT_PX);
  const heightSansSpacer = thread.scrollHeight - spacer.offsetHeight;
  // never reserve more than one viewport: standing room is at most "bubble at top,
  // rest blank" — the cap bounds the damage if a measurement ever goes off the rails
  const h = Math.min(thread.clientHeight, Math.max(0, target + thread.clientHeight - heightSansSpacer));
  spacer.style.height = `${h}px`;
  return target;
}

// One-line plain-text snippet of a group (visible text parts, whitespace collapsed,
// capped). Display + legacy jump-matching only（R152 起引用载荷改用下面的
// groupQuoteText 全文）。Visible answer text ONLY — thinking used to be included
// and (coming first in parts) ate the 200-char cap, so quotes went out as the
// model's English reasoning instead of the message the user meant, derailing
// replies (R151: main "16:24下午茶"/"老板说画" incidents traced to this).
function groupSnippet(g: Group): string {
  const txt = g.msgs
    .flatMap((m) => m.parts.filter((p) => p.type === "text").map((p) => p.text || ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return txt.length > 200 ? `${txt.slice(0, 200)}…` : txt;
}

// 引用的实际载荷：可见正文**全文**（保留换行，段落间空行）。老设计是 200 字快照当
// 「指针」——赌被引用的原文还在模型上下文里；会话被 gateway reset/压缩后指针悬空，
// 模型看不到原文只能瞎接（R152，Maya topic-3 事故）。全文随消息发出后与模型上下文
// 无关，reset 免疫。上限仅防病态长文（正常回复远够不到）。R154 拆出 parts 级实现：
// 右键引用按落点气泡/消息取文（连续同角色消息会归组，整组取文会把相邻消息串进引用）。
function quoteTextOfParts(parts: Part[]): string {
  const txt = parts
    .filter((p) => p.type === "text")
    .map((p) => (p.text || "").trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return txt.length > 20000 ? `${txt.slice(0, 20000)}…` : txt;
}
function groupQuoteText(g: Group): string {
  return quoteTextOfParts(g.msgs.flatMap((m) => m.parts));
}

// 右键复制按气泡取原始 Markdown；没有气泡落点时才退到消息/整组。
function groupCopyText(g: Group, msgIndex?: number, partIndex?: number): string {
  const message = msgIndex != null ? g.msgs[msgIndex] : undefined;
  const part = message && partIndex != null ? message.parts[partIndex] : undefined;
  const parts = part ? [part] : message ? message.parts : g.msgs.flatMap((m) => m.parts);
  return parts.map((p) => p.text || "").join("\n").trim();
}

// ---- small components ---------------------------------------------------

function Avatar({
  agentId,
  name,
  className,
  version,
  editable,
  onUploaded,
}: {
  agentId: string;
  name: string;
  className: string;
  version?: number;
  editable?: boolean;
  onUploaded?: () => void;
}) {
  const { t } = useTranslation();
  const [ver, setVer] = useState(0); // local cache-buster, bumped after a successful upload
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => setVer(0), [agentId, version]);

  // Both the external version and local uploads refresh the shared image state.
  const inner = <AgentAvatarView agentId={agentId} name={name} className={className} version={ver || version} />;

  if (!editable) return inner;

  const onPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file later
    if (!file || !agentId) return;
    setBusy(true);
    try {
      const png = await resizeToSquarePng(file);
      await uploadAvatar(agentId, png);
      // Force the <img> to refetch the freshly-written file. Prefer notifying the
      // parent so SIBLING avatars (the agent list) re-fetch too; fall back to a
      // local-only cache-bust when this Avatar is used standalone.
      if (onUploaded) onUploaded();
      else setVer(Date.now());
    } catch (err) {
      alert(t("chat.avatarUploadFailed", { msg: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="avatar-edit">
      {inner}
      <button
        type="button"
        className="avatar-edit__btn"
        title={t("chat.changeAvatar")}
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? "…" : t("chat.change")}
      </button>
      <input ref={inputRef} type="file" accept="image/*" hidden onChange={onPick} />
    </span>
  );
}

// ---- ANSI (SGR) → HTML（R1 终端渲染）----
// 工具输出（terminal/execute_code）常带 ANSI 颜色码；纯 <pre> 里是一坨 \u001b[31m
// 乱码。这里做最小 SGR 子集：0 重置 / 1 加粗 / 30-37·90-97 前景色；38/48 扩展色
// 按参数长度整段跳过（不猜色，只保证后续解析不错位）。先整体 HTML 转义再插
// span，杜绝注入。
const ANSI_PATTERN = /\u001b\[[0-9;]*m/;
function ansiToHtml(raw: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let html = "";
  let openCount = 0;
  const closeAll = () => {
    while (openCount > 0) {
      html += "</span>";
      openCount -= 1;
    }
  };
  for (const piece of raw.split(/(\u001b\[[0-9;]*m)/)) {
    const m = /^\u001b\[([0-9;]*)m$/.exec(piece);
    if (!m) {
      html += esc(piece);
      continue;
    }
    const codes = (m[1] === "" ? "0" : m[1]).split(";").map((n) => Number(n) || 0);
    for (let i = 0; i < codes.length; i += 1) {
      const c = codes[i];
      if (c === 38 || c === 48) {
        // 扩展色序列：38;5;N（跳 2）或 38;2;R;G;B（跳 4）——不渲染但必须跳对位。
        i += codes[i + 1] === 2 ? 4 : 2;
        continue;
      }
      if (c === 0) closeAll();
      else if (c === 1) {
        html += '<span class="chat-ansi chat-ansi-b">';
        openCount += 1;
      } else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) {
        html += `<span class="chat-ansi chat-ansi-${c}">`;
        openCount += 1;
      }
      // 其余（背景色/下划线/斜体…）忽略——聊天卡片里保持克制。
    }
  }
  closeAll();
  return html;
}

function Card({
  icon,
  name,
  status,
  body,
  summary,
  diff,
  diffText,
  isError,
  defaultOpen,
}: {
  icon: ReactNode;
  name: string;
  status?: string;
  body?: string;
  summary?: string | null;
  diff?: { path: string; oldText: string; newText: string };
  diffText?: string; // unified diff text (Hermes gateway inline_diff) — per-line ± tinting
  isError?: boolean;
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(!!defaultOpen);
  const [raw, setRaw] = useState(false); // false = product (summary), true = technical (raw body)
  const hasBody = !!body;
  const expandable = hasBody || !!diff || !!diffText;
  const showRaw = raw || !summary;
  return (
    <div className={`chat-card${open ? " is-open" : ""}${isError ? " is-error" : ""}`}>
      <button className="chat-card__head" onClick={() => expandable && setOpen((o) => !o)} disabled={!expandable}>
        <span className="chat-card__ico">{icon}</span>
        <span className="chat-card__name">{name}</span>
        {status && <span className="chat-card__status">{status}</span>}
        {expandable && <span className="chat-card__chevron">›</span>}
      </button>
      {open && expandable && (
        <div className="chat-card__bodywrap">
          {diffText ? (
            <div className="chat-diff">
              <pre className="chat-diff__body">
                {diffText.split("\n").map((l, i) => (
                  <div
                    key={i}
                    className={
                      l.startsWith("+") && !l.startsWith("+++")
                        ? "chat-diff__add"
                        : l.startsWith("-") && !l.startsWith("---")
                          ? "chat-diff__del"
                          : l.startsWith("@@")
                            ? "chat-diff__hunk"
                            : "chat-diff__ctx"
                    }
                  >
                    {l || " "}
                  </div>
                ))}
              </pre>
            </div>
          ) : diff ? (
            <div className="chat-diff">
              {diff.path && <div className="chat-diff__path mono">{diff.path}</div>}
              <pre className="chat-diff__body">
                {diff.oldText
                  ? diff.oldText.split("\n").map((l, i) => (
                      <div key={`o${i}`} className="chat-diff__del">- {l}</div>
                    ))
                  : null}
                {diff.newText.split("\n").map((l, i) => (
                  <div key={`n${i}`} className="chat-diff__add">+ {l}</div>
                ))}
              </pre>
            </div>
          ) : (
            <>
              {summary && (
                <div className="chat-card__views">
                  <button type="button" className={!raw ? "is-on" : ""} onClick={() => setRaw(false)}>
                    {t("chat.toolSummary")}
                  </button>
                  <button type="button" className={raw ? "is-on" : ""} onClick={() => setRaw(true)}>
                    {t("chat.toolRaw")}
                  </button>
                </div>
              )}
              {showRaw ? (
                body && ANSI_PATTERN.test(body) ? (
                  <pre className="chat-card__body" dangerouslySetInnerHTML={{ __html: ansiToHtml(body) }} />
                ) : (
                  <pre className="chat-card__body">{body}</pre>
                )
              ) : (
                <div className="chat-card__summary">{summary}</div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Collapsed rendering for system-injected user prompts (see isInjectedPrompt):
// one dim row with the first line; click to expand the full markdown.
function InjectedRow({ text }: { text: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const head = text.replace(/\s+/g, " ").trim();
  return (
    <>
      <button
        type="button"
        className={open ? "chat-sysline is-open" : "chat-sysline"}
        title={open ? t("chat.injectedCollapse") : t("chat.injectedExpand")}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="chat-sysline__ico">⚙</span>
        <span className="chat-sysline__text">{head.length > 96 ? `${head.slice(0, 96)}…` : head}</span>
        <span className="chat-sysline__chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <ChatMarkdown
          className="chat-bubble chat-md is-injected"
          text={text}
        />
      )}
    </>
  );
}

function IconRetry() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 11A8 8 0 106.3 16.7M20 4v7h-7" />
    </svg>
  );
}

// header tools + composer icons (Figma 6377:264 — drawn to match, wired only where the feature exists)。
// 与沉浸模式共用的那批（Send/Clip/Search/Clock/Archive/Mic/Command/Stop/Pencil）在 ./chatIcons.tsx。
function IconNote() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 3.5h14a1.5 1.5 0 0 1 1.5 1.5v10.5L15.5 21H5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 5 3.5Z" />
      <path d="M15.5 21v-5.5H21M8 8h8M8 12h5" />
    </svg>
  );
}
function IconBulb() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18h6M10 21h4M12 3a6 6 0 00-4 10.5c.6.6 1 1.4 1 2.3h6c0-.9.4-1.7 1-2.3A6 6 0 0012 3z" />
    </svg>
  );
}
function IconWrench() {
  // exact Figma vector (16×16)
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8.15698 5.26448C8.06057 5.36284 8.00657 5.49508 8.00657 5.63281C8.00657 5.77054 8.06057 5.90278 8.15698 6.00113L8.99887 6.84302C9.09722 6.93943 9.22946 6.99343 9.36719 6.99343C9.50492 6.99343 9.63716 6.93943 9.73552 6.84302L11.7192 4.85933C11.9838 5.44401 12.0639 6.09544 11.9489 6.72681C11.8338 7.35818 11.5291 7.93949 11.0753 8.39329C10.6215 8.84708 10.0402 9.1518 9.40884 9.26684C8.77747 9.38187 8.12604 9.30176 7.54135 9.03718L3.90546 12.6731C3.69613 12.8824 3.41223 13 3.11619 13C2.82016 13 2.53625 12.8824 2.32693 12.6731C2.1176 12.4637 2 12.1798 2 11.8838C2 11.5878 2.1176 11.3039 2.32693 11.0945L5.96282 7.45865C5.69824 6.87396 5.61813 6.22253 5.73316 5.59116C5.8482 4.9598 6.15292 4.37848 6.60671 3.92469C7.06051 3.47089 7.64182 3.16617 8.27319 3.05114C8.90456 2.9361 9.55599 3.01621 10.1407 3.28079L8.16224 5.25922L8.15698 5.26448Z" />
    </svg>
  );
}

function IconArtifacts() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7.5h6l2 2h8v9.5a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 19V7.5z" />
      <path d="M4 7.5V5a1.5 1.5 0 011.5-1.5H10l2 2h6" />
    </svg>
  );
}
function IconImmersive() {
  // 沉浸模式入口：四角扩展（fullscreen/expand）。原先占位用 IconBulb，与「显示思考」开关撞图标。
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 4H6a2 2 0 0 0-2 2v3" />
      <path d="M15 4h3a2 2 0 0 1 2 2v3" />
      <path d="M9 20H6a2 2 0 0 1-2-2v-3" />
      <path d="M15 20h3a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}
function IconFolderReveal() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
      <path d="M9 13h6M13 10l3 3-3 3" />
    </svg>
  );
}
function IconFork() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="5" r="2" />
      <circle cx="18" cy="7" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M8 5h2a4 4 0 014 4v5a4 4 0 004 4M14 10a4 4 0 014-3" />
    </svg>
  );
}

// Per-command icons for the slash palette. The keys mirror OpenClaw's icon names
// (slash-commands.ts COMMAND_ICON_OVERRIDES); unknown keys fall back to a terminal
// glyph. One <svg> wrapper, body switched by key, to avoid 16 separate components.
function SlashIcon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {slashIconBody(name)}
    </svg>
  );
}
function slashIconBody(name: string) {
  switch (name) {
    case "stop":
      return <rect x="6" y="6" width="12" height="12" rx="2" />;
    case "refresh":
      return <path d="M20 11A8 8 0 106.3 16.7M20 4v7h-7" />;
    case "plus":
      return <path d="M12 5v14M5 12h14" />;
    case "loader":
      return <path d="M12 3v3M12 18v3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M3 12h3M18 12h3M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />;
    case "trash":
      return <path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13" />;
    case "brain":
      return <path d="M12 5a3 3 0 00-5 2 3 3 0 00-1.5 5.5A3 3 0 008 18a3 3 0 004 1.5M12 5a3 3 0 015 2 3 3 0 011.5 5.5A3 3 0 0116 18a3 3 0 01-4 1.5M12 5v14" />;
    case "zap":
      return <path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" />;
    case "book":
      return <path d="M5 4h11a2 2 0 012 2v14H7a2 2 0 00-2 2zM18 18H7" />;
    case "barChart":
      return <path d="M5 20V10M12 20V4M19 20v-7" />;
    case "download":
      return <path d="M12 4v10M8 11l4 4 4-4M5 19h14" />;
    case "volume2":
      return <path d="M4 9v6h4l5 4V5L8 9zM16 8.5a4 4 0 010 7M19 6a8 8 0 010 12" />;
    case "folder":
      return <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />;
    case "monitor":
      return <path d="M4 5h16v11H4zM9 20h6M12 16v4" />;
    case "x":
      return <path d="M6 6l12 12M18 6L6 18" />;
    case "send":
      return <path d="M4 12l16-8-6 16-3-7-7-1z" />;
    case "terminal":
    default:
      return <path d="M5 7l4 4-4 4M12 15h7" />;
  }
}

// ---- main ---------------------------------------------------------------

function ChatPageApp() {
  const routerLocation = useLocation();
  const { t } = useTranslation();
  const confirm = useConfirm();
  const chatBackendCatalog = useBackendCatalog("chat");
  const enabledChatBackends = useEnabledBackends("chat");
  const chatBackendScopeKey = [...enabledChatBackends].sort().join(",");
  const chatBackendDescriptors = useMemo(
    () => new Map(chatBackendCatalog.map((descriptor) => [descriptor.id, descriptor])),
    [chatBackendCatalog],
  );
  const wsRef = useRef<WebSocket | null>(null);
  const pending = useRef<Map<string, PendingRpcEntry<WebSocket>>>(new Map());
  const reqId = useRef(1);
  const activeKeyRef = useRef<string | null>(null);
  // App-owned, broker-sanitized hello snapshot. It is intentionally kept in
  // memory only: negotiated methods/scopes/policy change with each connection,
  // and persisting them would turn stale capabilities into authority.
  const [gatewayContract, setGatewayContract] = useState<GatewayContractSnapshot | null>(null);
  const gatewayContractRef = useRef<GatewayContractSnapshot | null>(null);
  const progressCardsRef = useRef<Map<string, OpenClawProgressCard>>(new Map());
  const progressEventEpochRef = useRef<Map<string, number>>(new Map());
  // Session keys with an in-flight generation. Per-session so switching away
  // doesn't freeze other sessions' composers, and switching back can restore
  // the streaming placeholder. `sending` mirrors this for the ACTIVE session.
  const inFlightRef = useRef<Set<string>>(new Set(readPendingTrackedSends().filter(entry => entry.terminalObserved !== true).map(entry => entry.key)));

  const [connected, setConnected] = useState(false);
  // 曾经成功连上过（onopen 落一次，之后不回退）——断线横幅据此在「连接中…」（冷启动）
  // 与「连接已断开，正在重连…」（掉线自愈）之间选词。
  const [everConnected, setEverConnected] = useState(false);
  // Cache seed gets the SAME persisted last-activity corrections the live fetch
  // applies, so the first paint's times/order aren't a wall of stale "13h" rows
  // that visibly snap once the WS list lands.
  const [allSessions, setSessions] = useState<SessionRow[]>(() => {
    const act = readActivity();
    return readSessionCache()
      .map((s) => {
        const known = act[s.key] ?? 0;
        return known > (s.updatedAt ?? 0) ? { ...s, updatedAt: known } : s;
      })
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  });
  // Keep source metadata for old links, while cache, live refresh and immersive
  // mode share the same visible list for selection, previews and unread counts.
  const sessions = useMemo(() => allSessions.filter(isVisibleSession), [allSessions]);
  const sessionsRef = useRef<SessionRow[]>(allSessions);
  sessionsRef.current = allSessions;
  // sessions.list carries stable ids but OpenClaw does not guarantee a current
  // agentName. Seed from cache, then replace from agents.list on each list refresh.
  const agentNamesRef = useRef<AgentNameIndex>(createAgentNameIndex(
    sessions.flatMap((row) => row.agentName
      ? [{ id: agentOf(row.key), name: row.agentName }]
      : []),
  ));
  // Session history is retained independently of current Agent membership.
  // Unknown/partial rosters keep cached entries until removal is confirmed.
  const [agentRoster, setAgentRoster] = useState<ChatAgentRoster>(() => new Map());
  const backendOfSession = useCallback(
    (key: string) => backendOfSessionRows(sessionsRef.current, key, agentOf(key)),
    [],
  );
  const backendOfKnownAgent = useCallback(
    (agentId: string) => backendOfAgentRows(sessionsRef.current, agentId),
    [],
  );
  // False until the first live sessions.list lands — cache-painted times/models
  // render dimmed (is-stale) so stale values read as provisional, not truth.
  const [listLive, setListLive] = useState(false);
  // Set of backend ids that are currently CONNECTED, from the same /__api/status
  // the 设置 page uses. The agent list / session caches (localStorage + the proxy's
  // injected Hermes rows) keep painting agents from disconnected backends; this is
  // the live truth we filter the list against. `null` = not probed yet → don't
  // filter (preserves the stale-while-revalidate instant paint); once probed it's a
  // real set, so a fully-offline backend yields an empty set and its agents vanish.
  const [connectedBackends, setConnectedBackends] = useState<Set<string> | null>(null);
  const connectedOnceBackendsRef = useRef(new Set<string>());
  // 正在启动的后端（status 的 info.starting，契约见 agent-backend.js getStatus）。
  // 冷启动要拉起多个 dashboard 进程的后端（Hermes）在这个窗口里 connected=false
  // 却不是故障，若按离线过滤，缓存里它的 agent 会整组消失、就绪后再凭空冒出来
  // ——看起来像「加载不出来」。所以列表可见性 = connected ∪ starting，而在线灰点
  // 仍只认 connected：行留在原位、暗着，等它转绿。
  const [startingBackends, setStartingBackends] = useState<Set<string>>(new Set());
  const [recoveryBackends, setRecoveryBackends] = useState<Set<string>>(new Set());
  // Hermes 可用性按 profile/agent 精确到会话；历史重试只在目标 agent ready 后触发。
  const [readyAgentIds, setReadyAgentIds] = useState<Set<string>>(new Set());
  // 用户保存的连接配置立即生效，不等待下一次 status 轮询。
  // 这是**明确意图**，与意外断线语义相反：它的 agent 行照旧整组消失，不留灰行。
  const disabledBackends = useMemo(() => new Set(chatBackendCatalog
    .filter(backend => !enabledChatBackends.includes(backend.id)).map(backend => backend.id)),
  [chatBackendCatalog, enabledChatBackends]);
  const canSendActiveSession = (key: string | null | undefined): boolean =>
    (!key || isChatAgentListed(agentRoster, backendOfSession(key), agentOf(key)))
    && !(sessionsRef.current.find(row => row.key === key && row.source === "codex-desktop")?.codexDesktopWriter?.state === "busy")
    && canSendSessionByReadiness(key, {
      backendOfSession,
      agentOfSession: agentOf,
      readyAgentIds,
      connected,
      connectedBackends,
      disabledBackends,
    });
  const sendController = createSendController(canSendActiveSession);
  const sendControllerRef = useRef<ChatSendController>(sendController);
  sendControllerRef.current = sendController;
  // WS 的 onmessage 闭包（agents.changed）要触发状态复查 → 把探测函数镜像进 ref。
  const refreshStatusRef = useRef<(() => Promise<void>) | null>(null);
  // 降级窗口里 proxy 本地合成的 sessions.list 会**整段缺掉**不可达后端的行，它自报
  // `degradedBackends`。记下最近一次的缺席名单，setSessions 据此保留那些后端的旧行——
  // 否则网关一重启 agent 整组蒸发，连 localStorage 缓存都被残缺列表覆盖（重开也看不到）。
  const degradedBackendsRef = useRef<Set<string>>(new Set());
  const sessionListGuardRef = useRef<ReturnType<typeof createLatestRequestGuard> | null>(null);
  if (!sessionListGuardRef.current) sessionListGuardRef.current = createLatestRequestGuard();
  const sessionListGuard = sessionListGuardRef.current;
  // 上面那个合并要读「上一份列表」，而它发生在 WS 事件闭包里 → render-time 镜像成 ref
  // （与 refreshStatusRef / historyErrorRef 同款模式）。
  // Refresh after uploads or returning from management, not on window focus:
  // changing the version remounts every avatar and discards its loaded image.
  const [avatarVersion, setAvatarVersion] = useState(0);
  // 沉浸模式开关：fixed 覆盖层盖在 .chat-shell 之上，底下 ChatPage 保活不卸载。localStorage 持久。
  const [immersive, setImmersive] = useState<boolean>(() => {
    try { return localStorage.getItem("shoggoth.chat.immersive.v1") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("shoggoth.chat.immersive.v1", immersive ? "1" : "0"); } catch { /* ignore */ }
  }, [immersive]);
  // 沉浸 composer 的 textarea + 沉浸态镜像 ref：focusComposer / type-anywhere 在沉浸打开时
  // 必须落焦沉浸层的输入框——普通 composer 被覆盖层盖住，聚焦它等于把键击打进看不见的框。
  const immersiveInputRef = useRef<HTMLTextAreaElement | null>(null);
  // 本地发送单调计数：沉浸层 R280 mirror 的「发送即锚定」触发信号（见 sendChatMessage）。
  const [immersiveSendSeq, setImmersiveSendSeq] = useState(0);
  const immersiveRef = useRef(immersive);
  immersiveRef.current = immersive;
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // 群聊：从 Agent 右键建群；打开的群面板替换右侧对话区（对话区只隐藏不卸载）。
  // 记下打开群时的 activeKey——任何入口切换到别的会话都会自动回到普通聊天。
  const [openGroup, setOpenGroup] = useState<{ groupId: string; activeKey: string | null } | null>(null);
  const [agentMenu, setAgentMenu] = useState<{ x: number; y: number; agent: GroupCandidateAgent } | null>(null);
  const [createGroupFor, setCreateGroupFor] = useState<GroupCandidateAgent | null>(null);
  const { groups: allGroupChats, enabled: groupChatEnabled, refresh: refreshGroupChats } = useGroupChats();
  const [groupPanelCache] = useState(createGroupPanelCache);
  // 群功能关闭时不显示群，但内部会话的排除仍按全部群计算（见 groupInternalKeys）。
  const groupChats = useMemo(() => (groupChatEnabled ? allGroupChats : []), [groupChatEnabled, allGroupChats]);
  const activeGroupId = openGroup && openGroup.activeKey === activeKey
    && groupChats.some((gc) => gc.group.id === openGroup.groupId) ? openGroup.groupId : null;
  const groupCacheScope = groupChats.find(group => group.group.id === activeGroupId)?.ownerScope;
  // Click-to-zoom overlay for chat media (agent MEDIA: images + user-sent images
  // and videos). Holds what to show full-size, null = closed. Videos play with
  // native controls; images render as before.
  const [lightbox, setLightbox] = useState<{ src: string; kind: "image" | "video" } | null>(null);
  // The expanded view follows the selected reducer instance through its terminal
  // event. A new turn may reuse step IDs, but must not replace the selected turn.
  const [timelineModal, setTimelineModal] = useState<{
    sessionKey: string; steps: TurnStep[]; ts?: number; runId?: string; timeline?: TurnTimelineState;
  } | null>(null);
  const openTimelineModal = (steps: TurnStep[], ts?: number, live = false, runId?: string) => {
    const sessionKey = activeKeyRef.current;
    if (!sessionKey) return;
    setTimelineModal({ sessionKey, steps, ts,
      runId: runId ?? (live ? observedRunBySessionRef.current.get(sessionKey) : undefined),
      timeline: live ? liveTimelinesRef.current.get(sessionKey) : undefined });
  };
  useEffect(() => { setTimelineModal(null); }, [activeKey, activeGroupId]);
  const visibleTimelineSteps = (steps: TurnStep[]) => withoutPlanSteps(steps).filter((s) =>
    s.kind !== "user" && s.kind !== "final" && (s.kind !== "text" || s.activity) && (showThinking || s.kind !== "thinking"));
  // R343:进行中气泡的直播时间线步骤(过滤掉 user/final/text——正文另有气泡,
  // 思考步随 💡 开关)。独立成函数是为了在消息层渲染一次、用固定 key:live parts
  // 每个流事件都重建,若把 TurnProcess 键在 part 内容哈希上会整组件反复重挂,
  // 行进场动画从 opacity 0 反复重播 → 时间线大面积空白/频闪(Hermes 思考流实测)。
  const liveStepsFor = (m: ChatMsg): TurnStep[] => {
    if (!m.pending && !m.settledPending) return [];
    const tl = liveTimelinesRef.current.get(activeKeyRef.current || "");
    if (!tl?.steps.length) return [];
    return subagentActivity.project(activeKeyRef.current || "", visibleTimelineSteps(tl.steps), observedRunBySessionRef.current.get(activeKeyRef.current || ""));
  };
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const messagesRef = useRef<ChatMsg[]>(messages);
  messagesRef.current = messages;
  // composer 选择器显示「实际在用」的模型时，记录用户刚手动选的模型，使其在下一条
  // 回答回来前不被上一条回答的实际模型盖掉（见 displayModel / 下方清除 effect）。
  const [pickedModel, setPickedModel] = useState<string | null>(null);
  // True once the active session's history load has SUCCEEDED — distinguishes a
  // genuinely empty session (show "no messages") from the load-in-flight window
  // (where messages is also [] but we must stay blank). Reset on every openSession,
  // set only in loadHistory's success path (errors stay false → blank, self-heals
  // on reconnect). Empty-state also gates on !sending so a session mid-first-turn
  // doesn't flash it.
  const [historyLoaded, setHistoryLoaded] = useState(false);
  // 缓存已可见不等于权威 history 已加载；归档、空态和活动记账只认 historyLoaded。
  const [historyVisible, setHistoryVisible] = useState(false);
  const historyLoadedRef = useRef(false);
  const historyVisibleRef = useRef(false);
  // Initial chat.history failure for the open session. Rendered as an explicit
  // error + retry instead of a silent blank thread — a wiped screen after an
  // agent switch reads as "my message vanished" (2026-07-14 incident).
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [earlierHistory, setEarlierHistory] = useState<{ key: string; cursor: string | null; loading: boolean; error: boolean }>({ key: "", cursor: null, loading: false, error: false });
  const earlierHistoryRef = useRef(earlierHistory);
  earlierHistoryRef.current = earlierHistory;
  // onmessage 闭包（agents.changed）里要读当前错误态 → render-time 镜像成 ref。
  const historyErrorRef = useRef<string | null>(null);
  historyErrorRef.current = historyError;
  // Sealed/reset archive (older physical transcripts of the active session) —
  // loaded on demand and prepended above the live thread. Keyed to the session it
  // belongs to so switching sessions resets the control.
  const [archive, setArchive] = useState<{
    key: string;
    status: "idle" | "loading" | "loaded" | "empty" | "unsupported" | "error";
    count?: number;
    hasMore?: boolean;
    error?: string;
  }>({ key: "", status: "idle" });
  // Set just before an archive prepend so the scroll handler keeps the prior
  // viewport anchored (older messages were inserted ABOVE) instead of jumping.
  const prependAnchorRef = useRef<{ height: number; node?: HTMLElement; top?: number; messageKey?: string; bubbleIndex?: number } | null>(null);
  // Synchronous re-entrancy guard so a burst of scroll/wheel events fires the
  // archive fetch at most once (state updates are async).
  // 跨会话搜索命中的会话可能不在 sessions.list 里（Hermes FTS 覆盖整库，列表按 profile 截断），
  // 此时会为它合成一行。但 onopen / agents.changed / refreshChat 都用 fetchAllSessions 的结果
  // 整体覆盖 sessions —— 合成行被抹掉后 active 变 null，面板退回「请选择会话」，而 activeKey
  // 仍非空导致自动落位 effect 也不重选。这里记住合成行，整体覆盖时并回去。
  const syntheticRowsRef = useRef<Map<string, SessionRow>>(new Map());
  const mergeSynthetic = useCallback((rows: SessionRow[], authoritativeRows?: SessionRow[]): SessionRow[] =>
    mergeLinkedSessionRows(rows, syntheticRowsRef.current, authoritativeRows), []);
  // 落地一份新拉的 sessions：先把降级窗口里缺席后端的旧行接回（见 degradedBackendsRef），
  // 再并回合成行、写状态与缓存。onopen / agents.changed / 手动刷新 / 深链共用这一条路径，
  // 状态与 localStorage 缓存因此永不分叉——「残缺列表污染缓存、重开 app 也看不到 agent」
  // 那个坑就是分头写出来的。
  const commitSessions = useCallback(
    (all: SessionRow[], authoritative = false): void => {
      const merged = mergeIncompleteSessionRows(
        sessionsRef.current,
        all,
        degradedBackendsRef.current,
        (row) => backendOfSessionRows([row], row.key || "", agentOf(row.key || "")),
      );
      // Only a real sessions.list response may retire a linked placeholder.
      // agents.list can arrive first with sessionsRef (including placeholders).
      // Enrich after merging: a new/forked/linked session can be absent from
      // sessions.list until its first turn, but still belongs to the same agent.
      const named = applyChatSessionAgentNames(
        mergeSynthetic(merged, authoritative ? all : undefined),
        agentNamesRef.current,
        sessionsRef.current,
      );
      sessionsRef.current = named;
      setSessions(named);
      writeSessionCache(named);
    },
    [mergeSynthetic],
  );

  // 深链入口可能指向尚未出现在 sessions.list 的会话。先补一条合成行，保证 active
  // 能解析到目标；后续服务端列表收录该 key 时，mergeSynthetic 会自动移除合成副本。
  const ensureSessionRow = useCallback((
    rawKey: string,
    updatedAt?: number | null,
    seed?: Partial<SessionRow>,
  ): void => {
    const key = String(rawKey || "").trim();
    if (!key) return;
    // 先同步登记，再排队更新 React state：即使本地缓存当前已有该行，紧随其后的
    // sessions.list 整体刷新也会通过 mergeSynthetic 把目标并回去。
    const existing = syntheticRowsRef.current.get(key);
    const [row] = applyChatSessionAgentNames<SessionRow>([{
      ...(existing ?? {}),
      ...(seed ?? {}),
      key,
      ...(updatedAt != null ? { updatedAt } : {}),
    }], agentNamesRef.current, sessionsRef.current);
    syntheticRowsRef.current.set(key, row);
    // Global search can jump across backends. Seed the ownership row into the
    // synchronous ref before openSession reads it; waiting for React's next
    // render would briefly mis-route an unknown key through the legacy fallback.
    const current = sessionsRef.current;
    const index = current.findIndex((session) => session.key === key);
    sessionsRef.current = index >= 0
      ? current.map((session, i) => (i === index ? { ...session, ...row } : session))
      : [...current, row];
    writeSessionCache(sessionsRef.current);
    setSessions((prev) => {
      const rowIndex = prev.findIndex((session) => session.key === key);
      return rowIndex >= 0
        ? prev.map((session, i) => (i === rowIndex ? { ...session, ...row } : session))
        : [...prev, row];
    });
  }, []);

  const archiveLoadingRef = useRef(false);
  const archiveGenerationRef = useRef(0);
  // 已加载的归档段（含 reset 分隔线）。归档只存在于 messages 里，而 loadHistory 成功时
  // 会用 chat.history 的结果整体替换 messages —— 活跃会话任何一次刷新（final / session.message）
  // 都会把归档静默抹掉，且 archive.status 还停在 "loaded"，既不再显示「加载更早历史」入口，
  // maybeLoadArchive 也拒绝重载。把归档前缀单独记下来，每次刷新后重新贴回去。
  const archivePrefixRef = useRef<{ key: string; msgs: ChatMsg[] }>({ key: "", msgs: [] });
  const archivePagesRef = useRef<{ key: string; raw: any[]; start: number } | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  // 待发队列（per-session，R357）：ref 为唯一真相（事件回调同步读写），queueTick 只负责
  // 触发渲染——liveToolsRef 同款模式。刷新即丢，与输入框草稿同命（有意不持久化：
  // localStorage 会带来「重开 app 旧队列复活自动发送」的风险）。
  const sendQueueRef = useRef<Map<string, QueuedMsg[]>>(new Map());
  const optimisticHistoryRef = useRef(createOptimisticChatHistory<ChatMsg>());
  const localSlashHistoryRef = useRef(createChatSlashHistory<ChatMsg>());
  const openclawPreamblesRef = useRef(createOpenClawPreambles<ChatMsg>(item => ({
    role: "assistant", parts: [{ type: "text", text: item.text }], ts: item.ts,
    activityRunId: item.runId, openclawPreambleKey: item.key, openclawLivePreamble: true, keepLiveLayout: true,
  })));
  const [queueTick, setQueueTick] = useState(0);
  // A selection is a one-shot draft intent scoped to the federated session key.
  // Reserve its generation while queued/sending; clear only on the Service's
  // durable "accepted" event, never on the proxy's early "started" response.
  const [pluginSelections, setPluginSelections] = useState<Record<string, ChatPluginSelection[]>>(readPluginSelectionDrafts);
  useEffect(() => { writePluginSelectionDrafts(pluginSelections); }, [pluginSelections]);
  const pluginSelectionsRef = useRef(pluginSelections);
  pluginSelectionsRef.current = pluginSelections;
  // A one-shot choice restored from localStorage is already a real draft.
  // Give it a generation before the first submit; otherwise the visible chip
  // would be silently omitted from chat.send until the user toggled it again.
  const pluginGenerationRef = useRef<Map<string, number>>(new Map(
    Object.entries(pluginSelections).filter(([, selected]) => selected.length > 0)
      .map(([key]) => [key, 1]),
  ));
  const pluginReservationRef = useRef<Map<string, number>>(new Map());
  const pluginValidityRef = useRef<Map<string, { backendId: string; selection: string;
    valid: boolean | null }>>(new Map());
  const onPluginSelectionValidity = useCallback((key: string, backendId: string,
    selection: ChatPluginSelection[], valid: boolean | null) => {
    pluginValidityRef.current.set(key, { backendId, selection: JSON.stringify(selection), valid });
  }, []);
  const pendingPluginSendRef = useRef<Map<string, { key: string; generation: number; text: string;
    atts: ChatAttachment[]; selection: ChatPluginSelection[] }>>(new Map());
  const setPluginSelectionFor = (key: string, selection: ChatPluginSelection[]) => {
    const next = { ...pluginSelectionsRef.current, [key]: selection };
    pluginSelectionsRef.current = next;
    pluginGenerationRef.current.set(key, (pluginGenerationRef.current.get(key) ?? 0) + 1);
    const persisted = writePluginSelectionDrafts(next);
    setPluginSelections(next);
    return persisted;
  };
  const clearAcceptedPluginSelection = (key: string, generation: number) => {
    if (pluginReservationRef.current.get(key) !== generation) return true;
    pluginReservationRef.current.delete(key);
    return pluginGenerationRef.current.get(key) !== generation || setPluginSelectionFor(key, []);
  };
  const acceptTrackedPluginSend = (key: string, idem: string) => {
    const entry = readPendingTrackedSends().find(item => item.key === key && item.idem === idem);
    if (!entry) return false; // Foreign/late run events cannot consume a one-shot choice.
    if (entry.accepted) return true; // Never consume a newly chosen draft twice.
    let consumed = true;
    const pendingKey = `${key}\0${idem}`;
    const pendingSend = pendingPluginSendRef.current.get(pendingKey);
    if (pendingSend) {
      pendingPluginSendRef.current.delete(pendingKey);
      consumed = clearAcceptedPluginSelection(key, pendingSend.generation);
    } else if (entry.selection && JSON.stringify(pluginSelectionsRef.current[key]) === JSON.stringify(entry.selection)) {
      // A reload loses in-memory generations, but not the exact captured choice.
      pluginReservationRef.current.delete(key);
      consumed = setPluginSelectionFor(key, []);
    }
    // Persist choice consumption before the accepted marker. On crash/reload a
    // newer identical choice then remains a new intent, not the old operation's.
    if (consumed) pendingChatSendStore.accepted(key, idem);
    return true;
  };
  const restoreRejectedPluginSend = (runId: string, key: string) => {
    optimisticHistoryRef.current.forget(key, runId);
    const pendingSend = pendingPluginSendRef.current.get(`${key}\0${runId}`);
    if (!pendingSend) return false;
    pendingPluginSendRef.current.delete(`${key}\0${runId}`);
    if (pluginReservationRef.current.get(key) === pendingSend.generation) pluginReservationRef.current.delete(key);
    if (pendingSend.selection.length && pendingSend.generation < 0 && !pluginSelectionsRef.current[key]?.length) {
      setPluginSelectionFor(key, pendingSend.selection);
    }
    if (activeKeyRef.current === key) {
      setInput(current => current.trim() ? `${pendingSend.text}\n${current}` : pendingSend.text);
      if (pendingSend.atts.length) setComposerAttachments(current => [...pendingSend.atts, ...current]);
      setMessages(current => current.filter(message => message.localSendId !== runId));
    } else {
      const current = draftsRef.current.get(key) || "";
      draftsRef.current.set(key, current.trim() ? `${pendingSend.text}\n${current}` : pendingSend.text);
      if (pendingSend.atts.length) attachmentDraftsRef.current.set(key,
        [...pendingSend.atts, ...(attachmentDraftsRef.current.get(key) ?? [])]);
    }
    return true;
  };
  // markInFlight 是 useCallback([])，经 ref 转接拿到最新 flushQueue（sendChatMessageRef 同款）。
  const flushQueueRef = useRef<((key: string) => void) | null>(null);
  // Reactive mirror of inFlightRef so the live-status dots (header + agent list)
  // re-render the moment a turn starts/ends. inFlightRef stays the synchronous
  // source of truth; markInFlight keeps both in lock-step.
  const [runningKeys, setRunningKeys] = useState<Set<string>>(new Set());
  const [verificationKeys, setVerificationKeys] = useState<Set<string>>(
    () => new Set(readPendingTrackedSends().map((entry) => entry.key)));
  const [runWaitBySession, setRunWaitBySession] = useState<Record<string, ChatRunWaitState>>({});
  const runStatusBySessionRef = useRef<Map<string, string>>(new Map());
  const observedRunBySessionRef = useRef<Map<string, string>>(new Map());
  const sendObservationEpochRef = useRef<Map<string, number>>(new Map());
  const terminalObservedSendRef = useRef<Map<string, { operationId: string; backendId: string; agentId: string;
    attempts: number; timer: ReturnType<typeof setTimeout> | null }>>(new Map(
      readPendingTrackedSends().filter(entry => entry.terminalObserved && entry.backendId).map(entry =>
        [entry.key, { operationId: entry.idem, backendId: entry.backendId!, agentId: agentOf(entry.key), attempts: 0, timer: null }] as const)));
  const verifyTrackedSendRef = useRef<((key?: string) => Promise<void>) | null>(null);
  useEffect(() => () => {
    for (const entry of terminalObservedSendRef.current.values()) if (entry.timer) clearTimeout(entry.timer);
    terminalObservedSendRef.current.clear();
  }, []);

  // Last send per session (text + idempotencyKey + timestamp), for double-fire
  // dedup. A reconnect clears inFlightRef mid-turn (see ws onopen), so the composer
  // unlocks while the gateway turn is still alive; a re-fire then sends the SAME
  // composed message again with a fresh idempotencyKey and the gateway appends two
  // identical user turns. Reusing the key inside DUP_SEND_WINDOW_MS lets the gateway
  // collapse the duplicate (findTranscriptMessageByIdempotencyKey) into one.
  const recentSendRef = useRef<Map<string, { text: string; selectionKey: string; idem: string; at: number }>>(new Map());
  const markInFlight = useCallback((key: string, on: boolean) => {
    // Terminal observation ends the generation UI, while the persisted pending
    // record still blocks every send/queue path until its exact receipt settles.
    const terminal = terminalObservedSendRef.current.get(key);
    const sameTerminal = terminal && terminal.backendId === backendOfSession(key)
      && terminal.agentId === agentOf(key) && readPendingTrackedSends().some(entry => entry.key === key
        && entry.idem === terminal.operationId && entry.backendId === terminal.backendId);
    const pending = readPendingTrackedSends().find(entry => entry.key === key);
    // A persisted terminal observation only closes generation controls. It
    // neither proves completion nor permits a send; the pending record remains.
    const keepVerification = sameTerminal || pending?.terminalObserved === true
      || (!!pending?.backendId && pending.backendId !== backendOfSession(key));
    on = !keepVerification && (on || hasPendingTrackedSend(key));
    if (!on) setRunWaitBySession((previous) => {
      if (!previous[key]) return previous;
      const next = { ...previous }; delete next[key]; return next;
    });
    if (on) inFlightRef.current.add(key);
    else {
      inFlightRef.current.delete(key);
      if (!keepVerification) runStatusBySessionRef.current.delete(key);
      // R342:回合已终结（final / error / aborted / chat.send reject）→ 同一句再发是
      // **用户主动重试**，不是双触发，必须换新 idempotencyKey。留着这条记录的话，重试
      // 会复用失败那次的 key，而网关把 chat.send 的结果（含失败）按 key 缓存 5 分钟
      // （server-maintenance 的 `now - ts > 3e5` 清理），直接回放上次的错误、根本不起新
      // run——连刚切好的模型都不会被用到。而重试分支既不画气泡也不报错（catch 吞掉），
      // 于是界面对每次回车毫无反应。注意：reconnect 那条路径是直接清 inFlightRef、绕开
      // 这里的（见 ws onopen），所以「重连后重发」的折叠保护不受影响。
      recentSendRef.current.delete(key);
      // 回合终结（final/error/aborted/send-reject 全路径收敛于此）→ 延迟补发该会话的
      // 待发队首。用户定案：无论回合怎么终结都链式续发。flush 自校验（活跃会话/不
      // inFlight/队列非空）。reconnect 直清 inFlightRef 不走这里——故意不自动补发
      // （网关轮次可能还活着），滞留队列等用户下次回车时保序恢复。
      setTimeout(() => flushQueueRef.current?.(key), QUEUE_FLUSH_DELAY_MS);
    }
    setRunningKeys(new Set(inFlightRef.current));
  }, []);
  // Last real (non-heartbeat) message preview per NON-active agent's rep session key
  // (left-list sub-line). Captured by the deep heartbeat-filtering scan that also seeds
  // realTimes; the ACTIVE agent uses `activeRealPreview` from the live thread instead.
  const [previews, setPreviews] = useState<Record<string, string>>({});
  // 行时间显示用：previews 文本所属那条消息的时间戳（= 线程底部可见的最后一条，错误泡也算），
  // 与副标题永远说同一条消息；排序仍走 rank（真实对话口径），显示与排序职责拆开。
  const [previewTimes, setPreviewTimes] = useState<Record<string, number>>({});
  const canonicalPreviewTimesRef = useRef<Record<string, number>>({});
  const recordHistoryPreview = useCallback((key: string, msgs: ChatMsg[]) => {
    const preview = latestHistoryPreview(msgs);
    if (preview.ts < (canonicalPreviewTimesRef.current[key] ?? 0)) return;
    canonicalPreviewTimesRef.current[key] = preview.ts;
    setPreviews(prev => prev[key] === preview.text ? prev : { ...prev, [key]: preview.text });
    if (preview.ts > 0) setPreviewTimes(prev => prev[key] === preview.ts ? prev : { ...prev, [key]: preview.ts });
  }, []);
  // Agents whose `:main` true last-activity we've already probed this mount (so the
  // most-recent landing isn't fooled by main's stale sessions.list updatedAt). See
  // the probe effect below.
  const mainActivityProbedRef = useRef<Set<string>>(new Set());
  // Per-session last REAL (non-heartbeat) message time for the agent-row time + sort, so an
  // idle-but-heartbeating agent shows its true last-chat time instead of being pinned to the top.
  // Seeded once per non-active rep by a deeper scan (heartbeat acks run deep); opening
  // history and receiving real replies also write the per-session time. See the probe below.
  const [realTimes, setRealTimes] = useState<Record<string, number>>(() => readActivity());
  // 「窗口内没扫到真实消息」时的上界（该会话的真实活动早于此时间）：心跳刷屏的会话 150/1000 条
  // 窗口可能全是机械段，没有上界就只能落到被心跳抬高的 updatedAt（→ 弹顶）。仅内存；取扫过的
  // 最早记录时间（min-write 保留最紧的界）；精确值（realTimes）优先于它。
  const [realTimeBounds, setRealTimeBounds] = useState<Record<string, number>>({});
  const realTimeFetchedRef = useRef<Map<string, number>>(new Map());
  // Unread is independent of sidebar ranking and of the Agent's selected session.
  const [unreadState, setUnreadState] = useState(() => readChatUnread(localStorage));
  // Freeze the read watermark at navigation, before rendering can acknowledge it.
  const unreadLandingRef = useRef<{ key: string; after: number; pending: boolean } | null>(null);
  const [unreadAnchor, setUnreadAnchor] = useState<{ key: string; messageId: string | null; pending: boolean } | null>(null);
  const unreadScrollCleanupRef = useRef<(() => void) | null>(null);
  // Filled by the shared projection below before layout effects run.
  const turnStartByMessageRef = useRef<ReadonlyMap<string, string>>(new Map());
  const unreadStateRef = useRef(unreadState);
  unreadStateRef.current = unreadState;
  useEffect(() => { writeChatUnread(localStorage, unreadState); }, [unreadState]);
  const observeReply = useCallback((key: string, at: number) => {
    if (inFlightRef.current.has(key) || isSessionReplyPending(sessionsRef.current.find(row => row.key === key))) return false;
    setUnreadState(prev => observeSessionReply(prev, key, at));
    return true;
  }, []);
  // Suppress the viewed session immediately, including during history loading.
  // Read acknowledgements below still require focused, authoritative content.
  const viewedSessionKey = shouldRefreshChatAvatars(routerLocation.pathname) && !activeGroupId ? activeKey : null;
  const showSessionUnread = useCallback((row: SessionRow) => row.key !== viewedSessionKey
    && !runningKeys.has(row.key) && !isSessionReplyPending(row)
    && supportsSessionUnread(row.key, row.kind) && hasUnreadReply(unreadState, row.key, row.kind),
  [viewedSessionKey, runningKeys, unreadState]);
  useEffect(() => {
    const markVisible = () => {
      if (!shouldRefreshChatAvatars(routerLocation.pathname) || !activeKey || activeGroupId || !historyVisible || !historyLoaded || unreadLandingRef.current?.pending || document.visibilityState === "hidden" || !document.hasFocus()) return;
      // Live frames may carry a proxy emission clock. Only acknowledge through a
      // canonical reply that is also covered by the visible history/stream.
      const through = Math.min(latestUnreadReplyTime(activeKey, messages), unreadState.replies[activeKey] ?? 0);
      setUnreadState(prev => readSessionThrough(prev, activeKey, through, sessionsRef.current.find(row => row.key === activeKey)?.kind));
    };
    markVisible();
    window.addEventListener("focus", markVisible);
    document.addEventListener("visibilitychange", markVisible);
    return () => {
      window.removeEventListener("focus", markVisible);
      document.removeEventListener("visibilitychange", markVisible);
    };
  }, [activeKey, activeGroupId, historyVisible, historyLoaded, messages, routerLocation.pathname, unreadState.replies, unreadAnchor]);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<UnifiedModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState(false);
  // Which backend the current `models` belong to, so an agent switch can clear a
  // stale other-backend list before the new fetch lands (avoids cross-backend bleed).
  const modelsBackendRef = useRef<string>("");
  // OpenClaw's configured catalog is agent-scoped. Keep it out of the backend-wide
  // management cache so switching agents cannot reuse another agent's choices.
  const openClawModelCacheRef = useRef<Map<string, UnifiedModel[]>>(new Map());
  const refreshActiveModelsRef = useRef<(() => Promise<void>) | null>(null);
  const runtimeModelsBackend = activeKey ? backendOfSession(activeKey) : "";
  const usesRuntimeModelPicker = chatBackendDescriptors.get(runtimeModelsBackend)?.surfaces.sessionRuntimeSwitch === true;
  // Backend recovery can leave the browser's Proxy socket open. Retire its old
  // catalog on a ready event independently of attachment-capability retries.
  const [runtimeModelsEpoch, setRuntimeModelsEpoch] = useState(0);
  const runtimeModels = useSessionRuntimeModels(runtimeModelsBackend, activeKey ? agentOf(activeKey) : "",
    activeKey, usesRuntimeModelPicker,
    connected && (connectedBackends === null || connectedBackends.has(runtimeModelsBackend)), runtimeModelsEpoch);
  const runtimeModelsRef = useRef({ key: activeKey, data: runtimeModels.data });
  runtimeModelsRef.current = { key: activeKey, data: runtimeModels.data };
  const refreshModelMenu = useCallback(() => {
    if (usesRuntimeModelPicker) void runtimeModels.refresh();
    else void refreshActiveModelsRef.current?.().catch(() => {});
  }, [usesRuntimeModelPicker, runtimeModels.refresh]);
  // Learned xhigh support keyed by `provider:model` (see the probe effect below).
  const [xhighOk, setXhighOk] = useState<Record<string, boolean>>({});
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const attachmentDraftsRef = useRef<Map<string, ChatAttachment[]>>(new Map());
  const setComposerAttachments = (
    update: ChatAttachment[] | ((current: ChatAttachment[]) => ChatAttachment[]),
  ) => {
    const next = typeof update === "function" ? update(attachmentsRef.current) : update;
    attachmentsRef.current = next;
    setAttachments(next);
  };
  // 聊天面能力（附件种类/上限）按 agent 缓存；ref 供事件回调读取最新值。
  const [chatCaps, setChatCaps] = useState<Record<string, ChatCapabilities>>({});
  const chatCapsRef = useRef(chatCaps);
  chatCapsRef.current = chatCaps;
  const capabilitiesForSession = useCallback((key: string) => runtimeModelsRef.current.key === key && runtimeModelsRef.current.data
    ? runtimeModelsRef.current.data.capabilities : chatCapsRef.current[agentOf(key)], []);
  // 服务端斜杠目录按 session 隔离：Grok/Claude 的目录可能由当前工作区、skills
  // 与会话状态动态决定，不能按 agentId 跨会话复用。
  const [slashCatalogStore] = useState(() => new SlashCatalogStore(listSlashCommands));
  const slashCatalogs = useSyncExternalStore(slashCatalogStore.subscribe, slashCatalogStore.getSnapshot);
  // 能力拉取的重试世代：后端就绪广播（agents.changed）时 +1，让首个打开的 agent
  // 在启动竞态里失败后能自动重取——否则 composer 会一直停在 image-only 基线，
  // 用户只有切走再切回才会恢复（真机症状：打开就选中的那个 agent 不能选多格式）。
  const [capsEpoch, setCapsEpoch] = useState(0);
  // 拉取失败的自动补偿：后端重启窗口里切过去的 agent 收不到 agents.changed
  // （广播早于切换），只能自己退避重试。每 agent 最多 3 次，成功即停。
  const capsRetryRef = useRef<Record<string, number>>({});
  const [listening, setListening] = useState(false);
  const [toast, setToast] = useState<{
    text: string;
    kind: "pending" | "success" | "error";
    // Optional inline action (e.g. 撤销 after a local hide).
    action?: { label: string; run: () => void };
  } | null>(null);
  useEffect(() => {
    if (toast?.kind !== "error") return;
    // Some failure paths have no local timer. Every error still expires, while
    // existing shorter timers and long-running pending notices keep their policy.
    const timer = window.setTimeout(() => setToast((current) => current === toast ? null : current), 7000);
    return () => window.clearTimeout(timer);
  }, [toast]);
  const [sessionArtifactsOpen, setSessionArtifactsOpen] = useState(false);
  const [agentHeaderPanel, setAgentHeaderPanel] = useState<{ scope: string; kind: ChatAgentPanelKind } | null>(null);
  const agentHeaderRef = useRef<HTMLElement | null>(null);
  const agentHeaderTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [sessionArtifactReload, setSessionArtifactReload] = useState(0);
  const [sessionArtifactPopoverPosition, setSessionArtifactPopoverPosition] = useState<SessionArtifactPopoverPosition | null>(null);
  const [sessionArtifactState, setSessionArtifactState] = useState<SessionArtifactState>({
    key: "",
    status: "idle",
    result: null,
  });
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const sessionArtifactsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  // Always points at the latest sendChatMessage, so a widget's sendPrompt (wired
  // once at mount) forwards through the current closure rather than a stale one.
  const sendChatMessageRef = useRef<((text: string, atts: ChatAttachment[], isSlash?: boolean, displayText?: string) => Promise<void>) | null>(null);
  const recognitionRef = useRef<any>(null);
  // Watchdog timers, per session, for a slash command sent as a chat message: if the
  // backend streams no reply within the window, clear the stuck pending/sending state.
  const slashWatchdogRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Sessions whose history should be re-fetched once their current turn finalizes —
  // used by /new and /reset, which reset the session IN PLACE (same key, server
  // history wiped), so the UI must resync instead of keeping the pre-reset messages.
  const reloadOnFinalRef = useRef<Set<string>>(new Set());
  // Live tool-call entries per session, accumulated from the gateway's streamed
  // `agent`/`session.tool` lifecycle events and rendered as cards on the in-flight
  // assistant bubble. Cleared when the turn starts/ends (history then owns them).
  const liveToolsRef = useRef<Map<string, ToolEntry[]>>(new Map());
  // Per-session accumulated streamed reasoning (Hermes acp agent_thought_chunk),
  // rendered as a live thinking part on the pending assistant until the turn settles.
  const pendingThinkingRef = useRef<Map<string, string>>(new Map());
  // Raw runtime text is cumulative within one output item. A successful steer
  // snapshots it so the next local bubble renders only the post-steer suffix.
  const liveTextRef = useRef<Map<string, string>>(new Map());
  const steerTextBaselineRef = useRef<Map<string, string>>(new Map());
  // Session-scoped plan snapshots feed the composer dock, independently of the thread.
  const pendingPlanRef = useRef<Map<string, PlanEntry[]>>(new Map());
  const [expandedPlans, setExpandedPlans] = useState<Record<string, boolean>>({});
  // Blocking agent prompts (approval/clarify/sudo/secret cards) per session —
  // pushed by `chat` state:"prompt", answered via chat.respond, cleared on
  // final/error/expire.
  const pendingPromptsRef = useRef<Map<string, ChatPromptEntry[]>>(new Map());
  // Reactive projection of pendingPromptsRef for the left agent list. The ref
  // remains the synchronous source used by stream rendering; this map only
  // makes pending approval/input visible even when its session is not active.
  const [promptAttentionByKey, setPromptAttentionByKey] = useState<Record<string, ChatPromptAttention>>({});
  const replacePendingPrompts = useCallback((sessionKey: string, entries: ChatPromptEntry[]) => {
    if (entries.length) pendingPromptsRef.current.set(sessionKey, entries);
    else pendingPromptsRef.current.delete(sessionKey);
    const attention = chatPromptAttentionOf(entries);
    setPromptAttentionByKey((previous) => {
      if (attention ? previous[sessionKey] === attention : previous[sessionKey] === undefined) return previous;
      const next = { ...previous };
      if (attention) next[sessionKey] = attention;
      else delete next[sessionKey];
      return next;
    });
  }, []);
  // A question.list recovery must not overwrite a newer live requested/resolved
  // event that arrived while its RPC was in flight.
  const questionEventEpochRef = useRef(0);
  // R339 直播时间线:per-session 当前回合的 reducer 状态(与上面三个 live 容器平行,
  // 不替代它们——immersive 派生仍读 parts)。final/error/aborted 时把过程步骤留档到
  // lastTurnStepsRef,供 reload 后最近一轮的降级时间线 stitch 回富数据(耗时/相位)。
  const liveTimelinesRef = useRef<Map<string, TurnTimelineState>>(new Map());
  const lastTurnStepsRef = useRef<Map<string, TurnStep[]>>(new Map());
  const timelineFeed = useCallback((sk: string, ev: TurnEvent) => {
    const map = liveTimelinesRef.current;
    let tl = map.get(sk);
    const terminal = ev.kind === "final" || ev.kind === "error" || ev.kind === "aborted";
    // 上一轮已终结、又来了新事件 → 新回合从零开始(外部发起的 turn 没有 user 事件)。
    if (!tl || ((tl.status === "done" || tl.status === "error") && !terminal)) {
      tl = createTimeline();
      if (!terminal && stoppedScrollKeyRef.current === sk) stoppedScrollKeyRef.current = null;
    }
    const previous = tl;
    tl = reduceTimeline(tl, ev, performance.now());
    map.set(sk, tl);
    const timeline = tl;
    setTimelineModal(current => current?.sessionKey === sk && current.timeline === previous
      ? { ...current, timeline } : current);
    if ((tl.status === "done" || tl.status === "error") && tl.steps.some((s) => s.kind === "tool" || s.kind === "thinking")) {
      lastTurnStepsRef.current.set(sk, tl.steps);
    }
  }, []);
  // Turn-complete 后 300ms 合并重拉会话列表（官方桌面同款节流）：接住异步自动
  // 命名的新标题与刚落库的新会话行。
  const sessionsRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 同款节流，用于 session.message 触发的活跃会话历史重拉（见该处注释）。
  const historyRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 合并窗口内最后一个真的收到过 session.message 的会话（开火时的重拉目标）。
  const historyRefreshKeyRef = useRef<string | null>(null);

  // Slash-command palette: open while the composer holds "/partial" (no space yet).
  // Selecting fills the composer with "/<name> "; on submit, recognized commands run
  // via dispatchSlash (OpenClaw = client-side RPC / local render, Hermes = sent as a
  // message for its ACP adapter to intercept).
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashItems, setSlashItems] = useState<SlashCommand[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);

  // Composer toolbar toggles (💡 thinking / 🔧 tool cards) — hide those parts when off.
  // R353/R355:原「💡思考」「🔧工具」两个开关合并成一个 Agent Trajectory 开关
  // (Figma node 7132:401),语义=整个 Agent Trajectory 的显示/隐藏(用户定案):
  // 关 → 时间线卡(含摘要行)、直播实时卡、散排回退卡全部不渲染,只留正文;
  // 开 → 完整过程(思考+工具)可见。下游读取点保留旧名作别名。
  const [showTraj, setShowTraj] = useState(true);
  const showThinking = showTraj;
  const showTools = showTraj;
  // Single page-level search entry: all active backends × all visible agents.
  // The modal owns no message filtering state, so closing it cannot leave the
  // active thread invisibly filtered.
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [globalSearchQuery, setGlobalSearchQuery] = useState("");
  const [globalSearch, setGlobalSearch] = useState<{
    status: "idle" | "loading" | "done" | "error";
    data: GlobalChatSearchResult | null;
    loadingMore: boolean;
    loadMoreError: boolean;
  }>({ status: "idle", data: null, loadingMore: false, loadMoreError: false });
  const globalSearchResultsRef = useRef<HTMLDivElement | null>(null);
  const globalSearchSentinelRef = useRef<HTMLDivElement | null>(null);
  const globalSearchMoreAbortRef = useRef<AbortController | null>(null);
  const globalSearchTokenRef = useRef(0);
  const [pendingSearchJump, setPendingSearchJump] = useState<PendingSearchJump | null>(null);
  const pendingSearchJumpKeyRef = useRef<string | null>(null);
  const searchJumpTokenRef = useRef(0);
  const searchJumpRequestTokenRef = useRef<number | null>(null);
  const searchHistoryWindowKeyRef = useRef<string | null>(null);
  const [searchTargetGroupKey, setSearchTargetGroupKey] = useState<string | null>(null);
  const searchTargetClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Auto-stick depends on proximity to the bottom; the jump pill independently
  // depends on whether any part of the latest rendered message is visible.
  const [showJump, setShowJump] = useState(false);
  const atBottomRef = useRef(true);
  const stoppedScrollKeyRef = useRef<string | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const latestMessagePartsRef = useRef<Element[]>([]);
  // Send-anchor (R280): on my own send, park the sent user bubble at the TOP of the
  // viewport in ONE deliberate reposition and open a spacer below it, so the reply
  // streams into standing room instead of stick-to-bottom yanking the thread up
  // under whoever is still reading. sendAnchorRef = one-shot request armed by
  // sendChatMessage, consumed by the scroll layout-effect. anchoredRef = anchored
  // mode: no auto-stick until the next send / session switch (the jump pill covers
  // "take me down"). The anchor itself is NOT stored — every pass re-resolves the
  // last `.chat-group.is-user` element and measures it fresh, because the thread is
  // rebuilt under us mid-turn (reload-on-final + archive re-paste) and any stored
  // coordinate/element goes stale there (live-tested: a stored content-y drifted by
  // a whole archive prepend and blew the spacer up to 15k px of blank). streamSpacerRef
  // = the spacer div at the end of the thread, sized imperatively pre-paint (no
  // state, no re-render per delta).
  const sendAnchorRef = useRef(false);
  const anchoredRef = useRef(false);
  const streamSpacerRef = useRef<HTMLDivElement | null>(null);
  // Per-session composer drafts: switching agents preserves the half-typed message.
  const inputRef = useRef("");
  const draftsRef = useRef<Map<string, string>>(new Map());
  // Slash arg-picker submenu (e.g. /verbose → on|off).
  const [slashMode, setSlashMode] = useState<"command" | "args">("command");
  const [slashArgItems, setSlashArgItems] = useState<string[]>([]);
  const [slashArgCmd, setSlashArgCmd] = useState<SlashCommand | null>(null);
  // Per-session sent-input history for ↑/↓ recall.
  const histRef = useRef<Map<string, string[]>>(new Map());
  const histPosRef = useRef(-1);
  const histDraftRef = useRef("");
  // Per-session locally-hidden (deleted) + pinned message ids (persisted).
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [pinnedOnly, setPinnedOnly] = useState(false);
  // Which pinned message the single-line carousel is showing (index into pinnedList,
  // clamped at render). The quoted message shown above the composer (full visible
  // text, prepended as a `> ` blockquote on send — R152). The right-click menu.
  const [pinNavIndex, setPinNavIndex] = useState(0);
  // Quote is pinned to the session it was taken from: a quote captured in one
  // session never rides a send in another (defends the cross-session race the
  // QA round saw once — the bar already clears on switch, this closes the gap).
  const [quote, setQuote] = useState<{ key: string; text: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; group: Group; copyText: string; msgIndex?: number; partIndex?: number } | null>(null);
  const [advancedProbe, setAdvancedProbe] = useState<{
    key: string;
    backendId: string;
    agentId: string;
    description: SessionAdvancedDescription;
  } | null>(null);
  const [advancedModalOpen, setAdvancedModalOpen] = useState(false);
  const advancedProbeEpochRef = useRef(0);
  const forkRequestEpochRef = useRef(0);
  const [sessionBoardProbe, setSessionBoardProbe] = useState<{
    scope: string;
    result: SessionBoardResult;
  } | null>(null);
  const [sessionBoardLoading, setSessionBoardLoading] = useState(false);
  const [sessionBoardStale, setSessionBoardStale] = useState(false);
  const [sessionBoardReload, setSessionBoardReload] = useState(0);
  const [sessionBoardMutating, setSessionBoardMutating] = useState(false);
  const [sessionBoardViewMode, setSessionBoardViewMode] = useState<SessionBoardViewMode>("chat");
  const sessionBoardProbeEpochRef = useRef(0);
  const sessionBoardMutationEpochRef = useRef(0);
  const sessionBoardMutationChainRef = useRef<Promise<void>>(Promise.resolve());
  const sessionBoardProbeRef = useRef<typeof sessionBoardProbe>(null);
  const activeSessionBoardRef = useRef<SessionBoardResult | null>(null);
  const sessionBoardStaleRef = useRef(false);
  const activeSessionBoardScopeRef = useRef("");
  const sessionBoardRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Per-message-id DOM refs so the pin carousel can scroll a message into view.
  const groupRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const send = useCallback((method: string, params: unknown) => {
    return new Promise<any>((resolve, reject) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return reject(Object.assign(new Error(t("chat.notConnected")), { requestNotSent: true }));
      const id = String(reqId.current++);
      const timer = setTimeout(() => {
        const entry = takePendingRpc(pending.current, id, ws);
        if (entry) entry.reject(Object.assign(new Error(t("chat.requestTimeout", { method })),
          { receiptUncertain: true }));
      }, 20000);
      pending.current.set(id, { socket: ws, timer, resolve, reject });
      try {
        ws.send(JSON.stringify({ type: "req", id, method, params }));
      } catch (error) {
        const entry = takePendingRpc(pending.current, id, ws);
        if (entry) entry.reject(Object.assign(error instanceof Error ? error : new Error(String(error)),
          { receiptUncertain: true }));
      }
    });
  }, []);

  const [subagentRevision, setSubagentRevision] = useState(0);
  const subagentActivity = useMemo(() => createSubagentActivity({ request: send, normalize,
    changed: () => setSubagentRevision(value => value + 1) }), [send]);
  useEffect(() => { subagentActivity.sessions(allSessions); }, [allSessions, subagentActivity]);
  useEffect(() => { subagentActivity.watch(activeKey || ""); }, [activeKey, subagentActivity]);
  const displayPromptsFor = useCallback((key: string) =>
    subagentActivity.relatedKeys(key).flatMap(owner => pendingPromptsRef.current.get(owner) || []), [subagentActivity]);

  // Metadata activity schedules refreshes; real message activity advances the
  // separate heartbeat-safe sidebar clock below.
  const bumpSession = useCallback((key: string, at: number) => {
    setSessions((prev) => {
      let touched = false;
      const next = prev.map((s) => {
        if (s.key === key && (s.updatedAt ?? 0) < at) {
          touched = true;
          return { ...s, updatedAt: at };
        }
        return s;
      });
      if (!touched) return prev;
      next.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      return next;
    });
  }, []);

  const advanceRealActivity = useCallback((key: string, at: number) => {
    if (!(at > 0)) return;
    recordActivity(key, at);
    setRealTimes(previous => (previous[key] ?? 0) >= at ? previous : { ...previous, [key]: at });
    bumpSession(key, at);
  }, [bumpSession]);

  // 该 agent 行跟随的会话（手动打开 / 收到真实新消息时更新）；写穿 localStorage。
  const [chosenSessions, setChosenSessions] = useState<Record<string, string>>(() => readChosenSessions());
  const rememberChosen = useCallback((key: string) => {
    const a = agentOf(key);
    setChosenSessions((prev) => {
      if (prev[a] === key) return prev;
      const next = { ...prev, [a]: key };
      writeChosenSessions(next);
      return next;
    });
  }, []);

  // 缓存和 chat.history 共用同一条 raw → 可见消息路径，避免 Hermes 冷启动首屏与
  // 随后权威替换在附件 marker、心跳过滤或本地媒体恢复上出现两套口径。
  const prepareHistoryMessages = useCallback(async (key: string, raw: unknown[]): Promise<ChatMsg[]> => {
    const msgs = groupNativeUiHistory(raw).map(normalize).filter((m: ChatMsg) => !isInterruptMarker(m));
    await Promise.all(
      msgs.map(async (m: ChatMsg) => {
        if (m.role !== "user") return;
        const textPart = m.parts.find((p) => typeof p.text === "string");
        let lookupText = msgText(m);
        if (textPart?.text) {
          const parsed = extractAttachmentMarkers(textPart.text);
          if (parsed.files.length || parsed.text !== textPart.text.trim()) {
            textPart.text = parsed.text;
            lookupText = parsed.text;
            if (parsed.files.length && !m.files?.length) m.files = parsed.files;
          }
          if (textPart.text.trim() === OPENCLAW_MEDIA_PLACEHOLDER) {
            textPart.text = "";
            lookupText = "";
          }
        }
        if (!m.images?.length) {
          const cached = await getImages(imgCacheKey(key, lookupText));
          if (cached?.length) m.images = cached;
        }
        const cachedFiles = await getFiles(fileCacheKey(key, lookupText));
        if (!cachedFiles?.length) return;
        if (!m.files?.length) m.files = cachedFiles;
        else {
          const byName = new Map<string, typeof cachedFiles>();
          for (const cached of cachedFiles) byName.set(cached.name, [...(byName.get(cached.name) || []), cached]);
          m.files = m.files.map((f) => {
            const cached = byName.get(f.name)?.shift();
            return cached ? { ...f, kind: f.kind || cached.kind, src: f.src ?? cached.src } : f;
          });
        }
      }),
    );
    return msgs;
  }, []);

  const historyControllerRef = useRef<ReturnType<typeof createHistoryController<ChatMsg>> | null>(null);
  const loadHistory = useCallback(async (key: string, _opts?: { refresh?: boolean }) => {
    await historyControllerRef.current?.load(key);
  }, []);

  const decorateHistoryWithLiveState = useCallback((key: string, history: ChatMsg[]): ChatMsg[] => {
    history = localSlashHistoryRef.current.merge(key, history);
    history = openclawPreamblesRef.current.merge(key, history);
    const tools = liveToolsRef.current.get(key) || [];
    const thinking = pendingThinkingRef.current.get(key) || "";
    const plan = pendingPlanRef.current.get(key) || [];
    const prompts = displayPromptsFor(key);
    const withoutProgressProjection = history.filter((message) => message.ephemeral !== "progressCard");
    if (!tools.length && !thinking.trim() && !prompts.length && !inFlightRef.current.has(key)) {
      return withoutProgressProjection.filter((message) => !message.pending);
    }
    return applyToolStream(withoutProgressProjection, tools, thinking, plan, prompts);
  }, [displayPromptsFor]);

  const historyPager = useMemo(() => createChatHistoryPager<unknown>({
    request: async (key, cursor) => {
      const response = await send("chat.history", { sessionKey: key, page: true, limit: 100, ...(cursor ? { cursor } : {}) });
      return response?.payload;
    },
    window: chatHistoryWindow,
    id: rawHistoryId,
  }), [send]);
  const clearArchiveForSource = useCallback((key: string) => {
    archivePrefixRef.current = { key: "", msgs: [] };
    archivePagesRef.current = null;
    archiveGenerationRef.current++;
    archiveLoadingRef.current = false;
    setArchive({ key, status: "idle" });
  }, []);

  const commitCanonicalHistory = useCallback((key: string, msgs: ChatMsg[]) => {
    subagentActivity.observeHistory(key, msgs);
    observeReply(key, latestUnreadReplyTime(key, msgs));
    if (searchHistoryWindowKeyRef.current === key) {
      searchHistoryWindowKeyRef.current = null;
      setArchive({ key, status: "idle" });
    }
    const arc = archivePrefixRef.current.key === key ? archivePrefixRef.current.msgs : [];
    const history = arc.length ? [...arc, ...msgs] : msgs;
    const canonicalMessages = backendOfSession(key) === "openclaw"
      ? optimisticHistoryRef.current.merge(key, history) : history;
    const visibleMessages = retainLiveLayout(messagesRef.current, decorateHistoryWithLiveState(key, canonicalMessages));
    messagesRef.current = visibleMessages;
    setMessages(visibleMessages);
    historyLoadedRef.current = true;
    historyVisibleRef.current = true;
    setHistoryLoaded(true);
    setHistoryVisible(true);
    setHistoryError(null);

    let realTs = 0;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (isRealActivity(msgs[i])) {
        realTs = msgs[i].ts ?? 0;
        break;
      }
    }
    if (realTs > 0) {
      advanceRealActivity(key, realTs);
    } else if (msgs.length) {
      const oldest = msgs.find((m) => typeof m.ts === "number")?.ts ?? 0;
      if (oldest > 0) setRealTimeBounds((p) => ({ ...p, [key]: Math.min(p[key] ?? Infinity, oldest) }));
    }
  }, [advanceRealActivity, decorateHistoryWithLiveState, observeReply, subagentActivity]);

  const commitOpenedHistory = useCallback((key: string, msgs: ChatMsg[], cacheVisible: boolean) => {
    if (!isVisibleSession(sessionsRef.current.find(row => row.key === key) || { key })) return;
    const prevKey = activeKeyRef.current;
    unreadLandingRef.current = { key, after: sessionReadAt(unreadStateRef.current, key), pending: true };
    setUnreadAnchor({ key, messageId: null, pending: true });
    if (prevKey && prevKey !== key) {
      draftsRef.current.set(prevKey, inputRef.current);
      attachmentDraftsRef.current.set(prevKey, attachmentsRef.current);
    }
    // Reopening the current session can finish after the user starts typing.
    // Its history must not restore an older draft or attachment snapshot.
    if (prevKey !== key) {
      const restored = draftsRef.current.get(key) ?? "";
      setInput(restored);
      inputRef.current = restored;
      setComposerAttachments(supportsBackendAttachments(backendOfSession(key), capabilitiesForSession(key))
        ? attachmentDraftsRef.current.get(key) ?? [] : []);
    }
    setSlashOpen(false);
    setSlashMode("command");
    histPosRef.current = -1;
    setHiddenIds(readIdSet(HIDDEN_PREFIX, key));
    setPinnedIds(readIdSet(PINNED_PREFIX, key));
    setPinnedOnly(false);
    setPinNavIndex(0);
    setQuote(null);
    setMenu(null);
    atBottomRef.current = true;
    activeKeyRef.current = key;
    stoppedScrollKeyRef.current = null;
    setActiveKey(key);
    const restoredMessages = backendOfSession(key) === "openclaw"
      ? optimisticHistoryRef.current.merge(key, msgs) : msgs;
    const visibleMessages = decorateHistoryWithLiveState(key, restoredMessages);
    messagesRef.current = visibleMessages;
    setMessages(visibleMessages);
    historyLoadedRef.current = false;
    historyVisibleRef.current = cacheVisible;
    setHistoryLoaded(false);
    setHistoryVisible(cacheVisible);
    setHistoryError(null);
    setArchive({ key, status: "idle" });
    historyPager.reset(key);
    const earlier = { key, cursor: null, loading: false, error: false };
    earlierHistoryRef.current = earlier; setEarlierHistory(earlier);
    archivePrefixRef.current = { key: "", msgs: [] };
    archivePagesRef.current = null;
    archiveGenerationRef.current++;
    archiveLoadingRef.current = false;
    writeLastActive(key);
    rememberChosen(key);
    setSending(inFlightRef.current.has(key));
  }, [decorateHistoryWithLiveState, historyPager, rememberChosen]);

  const chatHistoryController = useMemo(() => createHistoryController<ChatMsg>({
    backendOfSession,
    agentOfSession: agentOf,
    getCacheScope: async (backendId) => {
      const value = await getChatCacheScope(backendId);
      return value.backendId === backendId ? value.cacheScope : undefined;
    },
    getCached: async (scope, key) => {
      const cached = await getCachedChatHistory(scope, key);
      return cached?.slice(chatHistoryWindow(cached, CHAT_HISTORY_PAGE_SIZE, key).start);
    },
    putCached: putCachedChatHistory,
    deleteCached: deleteCachedChatHistory,
    clearCachedExcept: clearCachedChatHistoryExcept,
    prepare: prepareHistoryMessages,
    requestCanonical: key => historyPager.refresh(key),
    releaseCanonical: raw => historyPager.release(raw),
    isInFlight: (key) => inFlightRef.current.has(key),
    commitOpen: commitOpenedHistory,
    commitCanonical: (key, msgs, raw) => {
      const previousSource = historyPager.current?.sourceId;
      if (!historyPager.commit(raw)) return;
      if (previousSource && previousSource !== historyPager.current?.sourceId) clearArchiveForSource(key);
      commitCanonicalHistory(key, msgs);
      if (activeKeyRef.current === key && !(earlierHistoryRef.current.key === key && earlierHistoryRef.current.loading)) {
        const next = { key, cursor: historyPager.hasMore ? historyPager.current!.token : null, loading: false, error: false };
        earlierHistoryRef.current = next; setEarlierHistory(next);
      }
    },
    commitFailure: (key, error) => {
      if (activeKeyRef.current !== key || historyLoadedRef.current) return;
      setHistoryError(error instanceof Error ? error.message : String(error));
    },
  }), [clearArchiveForSource, commitCanonicalHistory, commitOpenedHistory, historyPager, prepareHistoryMessages]);
  historyControllerRef.current = chatHistoryController;


  const verifyPendingTrackedSends = useCallback(async (onlyKey?: string): Promise<void> => {
    const entries = readPendingTrackedSends().filter((entry) => !onlyKey || entry.key === onlyKey);
    if (onlyKey && entries.length === 0) {
      await loadHistory(onlyKey, { refresh: true });
      setVerificationKeys((previous) => {
        if (!previous.has(onlyKey)) return previous;
        const next = new Set(previous); next.delete(onlyKey); return next;
      });
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const epoch = (sendObservationEpochRef.current.get(entry.key) ?? 0) + 1;
      sendObservationEpochRef.current.set(entry.key, epoch);
      try {
        if (entry.backendId && entry.backendId !== backendOfSession(entry.key)) throw new Error("original operation owner changed");
        let response = await send("chat.operation.get", {
          sessionKey: entry.key, idempotencyKey: entry.idem,
          ...(backendOfSession(entry.key) === "openclaw" ? { operationKind: entry.selection?.length ? "plugin-selection" : "chat" } : {}),
        });
        let reconciled = false;
        if (sendObservationEpochRef.current.get(entry.key) !== epoch) return;
        const beforeRecovery = readPendingTrackedSends().find(item => item.key === entry.key && item.idem === entry.idem);
        if (!beforeRecovery) return;
        if (entry.backendId && entry.backendId !== backendOfSession(entry.key)) throw new Error("original operation owner changed");
        if (response?.payload?.status === "unresolved" && response.payload.canReconcile === true && !beforeRecovery.accepted) {
          // The owner must persist a fence before proving non-admission. A
          // missing lookup or an already accepted operation never unlocks it.
          response = await send("chat.operation.reconcile", {
            sessionKey: entry.key, idempotencyKey: entry.idem, createdAt: entry.at,
          });
          reconciled = true;
        }
        // A newer query or live uncertainty event supersedes an older lookup.
        if (sendObservationEpochRef.current.get(entry.key) !== epoch) return;
        // Do not apply an old lookup after a matching terminal event removed it.
        const currentEntry = readPendingTrackedSends().find(item => item.key === entry.key && item.idem === entry.idem);
        if (!currentEntry) return;
        if (entry.backendId && entry.backendId !== backendOfSession(entry.key)) throw new Error("original operation owner changed");
        const terminal = terminalObservedSendRef.current.get(entry.key);
        const terminalObserved = currentEntry.terminalObserved === true || (!!terminal && terminal.operationId === entry.idem
          && terminal.backendId === entry.backendId && terminal.backendId === backendOfSession(entry.key)
          && terminal.agentId === agentOf(entry.key));
        const observation = classifyChatSendObservation(response?.payload, currentEntry.accepted === true,
          terminalObserved, reconciled, entry.backendId === "shoggoth" && response?.payload?.stateAuthority === "native-service");
        if (observation.accepted) acceptTrackedPluginSend(entry.key, entry.idem);
        if (observation.state === "verification") throw new Error("operation unresolved");
        if (observation.state === "terminal" && !forgetPendingTrackedSend(entry.key, entry.idem)) {
          throw new Error("operation tracking unavailable");
        }
        if (response?.payload?.status === "not_admitted" && !observation.accepted) {
          restoreRejectedPluginSend(entry.idem, entry.key);
        }
        if (observation.state === "active" && currentEntry.terminalObserved) {
          if (entry.backendId !== "shoggoth"
            || !pendingChatSendStore.clearTerminalObservation(entry.key, entry.idem, entry.backendId)) {
            throw new Error("operation tracking unavailable");
          }
        }
        if (terminal?.operationId === entry.idem
          && (observation.state === "terminal" || observation.state === "active")) {
          if (terminal.timer) clearTimeout(terminal.timer);
          terminalObservedSendRef.current.delete(entry.key);
        }
        if (observation.state === "active") runStatusBySessionRef.current.set(entry.key, response.payload.run.status);
        markInFlight(entry.key, observation.state !== "terminal");
        setVerificationKeys((previous) => {
          if (!previous.has(entry.key)) return previous;
          const next = new Set(previous); next.delete(entry.key); return next;
        });
        if (activeKeyRef.current === entry.key) {
          setSending(inFlightRef.current.has(entry.key));
          void loadHistory(entry.key, { refresh: true });
        }
      } catch {
        // not_found, unknown status and failed observation never authorize replay.
        if (sendObservationEpochRef.current.get(entry.key) !== epoch || !hasPendingTrackedSend(entry.key)) return;
        runStatusBySessionRef.current.set(entry.key, "needs_verification");
        const terminal = terminalObservedSendRef.current.get(entry.key);
        const sameTerminal = terminal?.operationId === entry.idem && terminal.backendId === entry.backendId
          && terminal.backendId === backendOfSession(entry.key) && terminal.agentId === agentOf(entry.key);
        if (sameTerminal && !terminal.timer && terminal.attempts < 3) {
          const delay = [100, 400, 1600][terminal.attempts++];
          terminal.timer = setTimeout(() => {
            terminal.timer = null;
            if (terminalObservedSendRef.current.get(entry.key) !== terminal
              || terminal.backendId !== backendOfSession(entry.key) || terminal.agentId !== agentOf(entry.key)
              || !readPendingTrackedSends().some(current => current.key === entry.key && current.idem === entry.idem
                && current.backendId === terminal.backendId)) return;
            void verifyTrackedSendRef.current?.(entry.key);
          }, delay);
        }
        markInFlight(entry.key, true);
        setVerificationKeys((previous) => new Set(previous).add(entry.key));
        if (activeKeyRef.current === entry.key) {
          setSending(inFlightRef.current.has(entry.key));
          // An idle history observer requests verification too. Refreshing
          // history on an unresolved lookup would feed that observer forever;
          // only a resolved observation or a separate history event refreshes.
        }
      }
    }));
  }, [send, markInFlight, loadHistory, backendOfSession]);
  verifyTrackedSendRef.current = verifyPendingTrackedSends;

  // sessions.list is paginated (the gateway caps each page at 200; totalCount can
  // be 1000+). Page through with offset so each agent's session list is complete.
  const fetchAllSessions = useCallback(async (): Promise<SessionListSnapshot> => {
    // Dedup by key: the federating proxy merges OpenClaw + Hermes lists, so
    // paging by offset can re-emit the same session across pages (observed:
    // Hermes rows appearing twice). A Map keyed on session key keeps the latest.
    const byKey = new Map<string, SessionRow>();
    // 本轮列表缺了谁（proxy 降级时自报）。满血响应不带这个字段 → 保持空集，恢复后
    // 上一轮保留下来的旧行会被新列表正常覆盖。
    const degraded = new Set<string>();
    let offset = 0;
    // 老网关(≤2026.5.x)的 sessions.list 没有分页参数,严格 schema 校验直接拒
    // ("invalid sessions.list params: unexpected property 'offset'",R127 真机踩过)。
    // 首次被拒后退化为无参单页拉取(老网关会话量本就在其单页上限内)。
    let paged = true;
    for (let i = 0; i < 30; i += 1) {
      let res;
      try {
        res = await send("sessions.list", paged
          ? { limit: 200, offset, includeDerivedTitles: true, includeLastMessage: true }
          : {});
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (paged && /unexpected property/i.test(msg)) {
          paged = false;
          continue;
        }
        throw e;
      }
      const p = res?.payload || {};
      const rows: SessionRow[] = p.sessions || p.rows || [];
      for (const r of rows) if (r?.key) byKey.set(r.key, r);
      if (Array.isArray(p.degradedBackends))
        for (const id of p.degradedBackends) if (typeof id === "string" && id) degraded.add(id);
      if (!paged) break; // 单页兼容模式:老网关不分页
      const nextOffset = typeof p.nextOffset === "number" ? p.nextOffset : offset + rows.length;
      // stop on: no more, empty page, or an offset that fails to advance (guards
      // against a proxy that ignores offset and would otherwise loop forever).
      if (!p.hasMore || rows.length === 0 || nextOffset <= offset) break;
      offset = nextOffset;
    }
    // The gateway's updatedAt is stamped at create / sessions.patch only — channel
    // (Telegram) deliveries never advance it, so raise each row by the true
    // last-message time we learned from any prior chat.history load (recordActivity).
    const activity = readActivity();
    const all = Array.from(byKey.values()).map((s) => {
      const known = activity[s.key] ?? 0;
      return known > (s.updatedAt ?? 0) ? { ...s, updatedAt: known } : s;
    });
    all.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return { rows: all, degradedBackends: degraded };
  }, [send]);

  const fetchAgentDirectory = useCallback(async () => {
    const response = await send("agents.list", {});
    const roster = response?.payload;
    // A malformed successful reply is a failed read, never an empty roster.
    updateChatAgentRoster(new Map(), roster, []);
    const rows = roster.agents;
    // Chat agent ids are the federating gateway's routing namespace, so keep
    // this lookup unscoped. Management pages use backend-scoped ids below.
    return { roster, names: createAgentNameIndex(rows.map((row: any) => ({
      id: row?.id,
      name: row?.name,
      identity: row?.identity,
    }))) };
  }, [send]);

  const refreshSessions = useCallback(async (): Promise<void> => {
    const ticket = sessionListGuard.begin();
    let fetchedRows: SessionRow[] | null = null;
    // Roster reads remain independent: a slow/failing backend cannot block history.
    void fetchAgentDirectory()
      .then(({ names, roster }) => {
        if (!sessionListGuard.isCurrent(ticket)) return;
        agentNamesRef.current = names;
        setAgentRoster(previous => updateChatAgentRoster(previous, roster, chatBackendCatalog.map(backend => backend.id)));
        commitSessions(fetchedRows || sessionsRef.current);
      })
      .catch(() => {});
    try {
      const next = await fetchAllSessions();
      if (!sessionListGuard.isCurrent(ticket)) return;
      fetchedRows = next.rows;
      degradedBackendsRef.current = next.degradedBackends;
      commitSessions(next.rows, true);
      setListLive(true);
    } catch (error) {
      if (sessionListGuard.isCurrent(ticket)) throw error;
    }
  }, [commitSessions, fetchAgentDirectory, fetchAllSessions, sessionListGuard, chatBackendCatalog]);

  useEffect(
    () => () => {
      sessionListGuard.invalidate();
    },
    [sessionListGuard],
  );
  // Model / thinking changes go through sessions.patch (allowed for our
  // CONTROL_UI client id); refresh the list afterwards to reflect the new value.
  const patchSession = useCallback(
    async (patch: Record<string, unknown>, label: string) => {
      const key = activeKeyRef.current;
      if (!key) return false;
      setToast({ text: t("chat.switchingLabel", { label }), kind: "pending" });
      try {
        const res = await send("sessions.patch", { key, ...patch });
        // patch just the active row from the response (cheaper than re-paging 1000+ sessions)
        const resolved = res?.payload?.resolved || {};
        const entry = res?.payload?.entry || {};
        setSessions((prev) =>
          prev.map((s) =>
            s.key === key
              ? {
                  ...s,
                  ...("model" in patch
                    ? { model: resolved.model ?? (patch.model as string) ?? s.model, modelProvider: resolved.modelProvider ?? s.modelProvider }
                    : {}),
                  ...("thinkingLevel" in patch
                    ? { thinkingLevel: (Object.hasOwn(entry, "thinkingLevel") ? entry.thinkingLevel : patch.thinkingLevel) ?? undefined }
                    : {}),
                  ...("fastMode" in patch ? { fastMode: entry.fastMode ?? patch.fastMode as boolean } : {}),
                  ...("permissionMode" in patch
                    ? { permissionMode: entry.permissionMode ?? (patch.permissionMode as string) ?? s.permissionMode }
                    : {}),
                }
              : s,
          ),
        );
        // thinkingOptions/thinkingDefault are computed per-model by the gateway and only
        // ship via sessions.list (the patch response's raw entry has neither), so a model
        // switch leaves the thinking-level list stale (e.g. gpt-5.5 missing "Extra high").
        // Re-fetch the active row's thinking fields for the new model.
        if ("model" in patch) {
          try {
            const lr = await send("sessions.list", { limit: 200 });
            const fresh = ((lr?.payload?.sessions || lr?.payload?.rows || []) as SessionRow[]).find((r) => r.key === key);
            if (fresh) {
              setSessions((prev) =>
                prev.map((s) =>
                  s.key === key
                    ? { ...s, thinkingOptions: fresh.thinkingOptions, thinkingDefault: fresh.thinkingDefault,
                      thinkingLevel: fresh.thinkingLevel, fastMode: fresh.fastMode }
                    : s,
                ),
              );
            }
          } catch {
            /* leave stale until the next full refresh */
          }
        }
        // R279 缺口补齐（D3.5）：如实转述后端实际落点——scope "persist" 表示当时
        // 没有活会话、写进了全局配置；warning 是网关给的补充说明（如昂贵模型提示）。
        const scope = res?.payload?.scope;
        const warning = typeof res?.payload?.warning === "string" && res.payload.warning ? res.payload.warning : "";
        const switchedText = inFlightRef.current.has(key) && scope !== "persist" ? t("chat.settingsNextTurn")
          : scope === "persist" ? t("chat.switchedPersisted", { label }) : t("chat.switchedLabel", { label });
        setToast({ text: warning ? `${switchedText}（${warning}）` : switchedText, kind: "success" });
        setTimeout(() => setToast(null), warning ? 3200 : 1600);
        return true;
      } catch (e) {
        // 切换失败的文案可能很长（后端会把网关的真实原因带进来，如「provider 已不在
        // config 里」+ 怎么修），2.6s 读不完 → 按长度给到 7s。
        const msg = e instanceof Error ? e.message : String(e);
        setToast({ text: t("chat.switchFailed", { msg }), kind: "error" });
        setTimeout(() => setToast(null), msg.length > 40 ? 7000 : 2600);
        return false;
      }
    },
    [send],
  );

  const renderLiveStateForSession = useCallback((sessionKey: string) => {
    const active = activeKeyRef.current;
    if (!active || !subagentActivity.relatedKeys(active).includes(sessionKey)) return;
    setMessages((previous) => decorateHistoryWithLiveState(active, previous));
  }, [decorateHistoryWithLiveState, subagentActivity]);

  const execApprovals = useMemo(() => createExecApprovalController({
    request: send,
    changed: (sessionKey, entries) => {
      const other = (pendingPromptsRef.current.get(sessionKey) ?? []).filter(entry => !isOpenClawExecApproval(entry));
      replacePendingPrompts(sessionKey, [...other, ...entries]);
      renderLiveStateForSession(sessionKey);
    },
  }), [send, replacePendingPrompts, renderLiveStateForSession]);
  useEffect(() => () => execApprovals.dispose(), [execApprovals]);

  const recoverOpenClawQuestions = useCallback(async (sessionKey: string) => {
    const contract = gatewayContractRef.current;
    if (!gatewaySupportsQuestions(contract)) return;
    const eventEpoch = questionEventEpochRef.current;
    try {
      const response = await send("question.list", {});
      if (gatewayContractRef.current !== contract || questionEventEpochRef.current !== eventEpoch) return;
      const rawQuestions = response?.payload?.questions;
      if (!Array.isArray(rawQuestions)) return;
      const normalized = rawQuestions.map((record: unknown) => normalizeOpenClawQuestionPrompt(record));
      for (const owner of subagentActivity.relatedKeys(sessionKey)) {
        const recovered = normalized.filter((record: OpenClawQuestionPromptEntry | null): record is OpenClawQuestionPromptEntry => record?.sessionKey === owner);
        const legacy = (pendingPromptsRef.current.get(owner) ?? []).filter(entry => !isOpenClawQuestionPrompt(entry));
        replacePendingPrompts(owner, [...legacy, ...recovered]);
      }
      renderLiveStateForSession(sessionKey);
    } catch {
      // Reconnect recovery is best effort. The live requested event remains the
      // primary path and a later gateway.ready/session switch retries the list.
    }
  }, [renderLiveStateForSession, replacePendingPrompts, send, subagentActivity]);

  const clearOpenClawProgressCard = useCallback((sessionKey: string) => {
    progressCardsRef.current.delete(sessionKey);
    const plan = pendingPlanRef.current.get(sessionKey);
    if (plan?.some((entry) => entry.progressRevision !== undefined)) {
      // Keep an explicit empty override until the next snapshot/turn so the dock
      // cannot recover the cleared card from a just-finalized live message.
      pendingPlanRef.current.set(sessionKey, []);
    }
    renderLiveStateForSession(sessionKey);
  }, [renderLiveStateForSession]);

  const refreshOpenClawProgressCard = useCallback(async (
    sessionKey: string,
    expectedRevision?: number,
    eventEpoch = progressEventEpochRef.current.get(sessionKey) ?? 0,
  ) => {
    const contract = gatewayContractRef.current;
    if (!gatewaySupportsProgressCards(contract)) return;
    try {
      const response = await send("progressCard.get", { sessionKey });
      if (gatewayContractRef.current !== contract) return;
      if ((progressEventEpochRef.current.get(sessionKey) ?? 0) !== eventEpoch) return;
      if (response?.payload?.card == null) {
        clearOpenClawProgressCard(sessionKey);
        return;
      }
      const card = normalizeOpenClawProgressCard(response.payload.card, sessionKey);
      if (!card || (expectedRevision !== undefined && card.revision < expectedRevision)) return;
      const previous = progressCardsRef.current.get(sessionKey);
      if (previous && previous.revision > card.revision) return;
      progressCardsRef.current.set(sessionKey, card);
      pendingPlanRef.current.set(sessionKey, progressCardPlan(card));
      renderLiveStateForSession(sessionKey);
    } catch {
      // Durable progress stays at the last acknowledged revision until a later
      // changed event/reconnect can refresh it; never replace it with partial data.
    }
  }, [clearOpenClawProgressCard, renderLiveStateForSession, send]);

  // Answer a blocking agent prompt card (approval/clarify/sudo/secret). Keep
  // the card until the backend acknowledges the exact request: optimistic
  // removal made a transient relay failure impossible to retry.
  const respondPrompt = useCallback(
    async (entry: ChatPromptEntry, data: ChatPromptResponse) => {
      const activeSessionKey = activeKeyRef.current;
      const openClawQuestion = isOpenClawQuestionPrompt(entry) ? entry : null;
      const execApproval = isOpenClawExecApproval(entry) ? entry : null;
      const sk = execApproval?.sessionKey || openClawQuestion?.sessionKey || activeSessionKey;
      if (!sk) return;
      try {
        if (execApproval) {
          await execApprovals.respond(execApproval, data.choice);
          return;
        }
        if (openClawQuestion) {
          if (!gatewaySupportsQuestions(gatewayContractRef.current)) {
            throw new Error(t("chat.notConnected"));
          }
          await send("question.resolve", openClawQuestionResolveParams(openClawQuestion.id, data));
        } else {
          await send("chat.respond", "version" in entry
            ? { sessionKey: sk, requestId: entry.requestId, ...data }
            : { sessionKey: sk, kind: entry.kind, requestId: entry.requestId, ...data });
        }
        const arr = (pendingPromptsRef.current.get(sk) ?? []).filter((e) => e.id !== entry.id);
        replacePendingPrompts(sk, arr);
        if (!openClawQuestion) {
          // R339:时间线里的等待确认步落定为「已确认:<choice>」(密钥类不带值,只记应答)。
          timelineFeed(sk, { kind: "promptAnswer", requestId: entry.requestId, choice: data.choice });
        }
        renderLiveStateForSession(sk);
      } catch (e) {
        const secretQuestion = openClawQuestion?.questions.some((question) => question.isSecret) === true;
        const message = secretQuestion ? t("chat.requestFailed") : e instanceof Error ? e.message : String(e);
        setToast({ text: t("chat.promptRespondFailed", { msg: message }), kind: "error" });
        setTimeout(() => setToast(null), 2600);
        throw secretQuestion ? new Error(t("chat.requestFailed")) : e;
      }
    },
    [execApprovals, renderLiveStateForSession, replacePendingPrompts, send],
  );

  // Switch the model — one path for every backend: `sessions.patch {model}`.
  // OpenClaw sessions go upstream to the gateway; foreign (e.g. Hermes) ones are
  // routed by the proxy to the owning backend's setSessionModel(). Hermes used to
  // be special-cased here into a `/model …` chat message, which needed a live
  // session and so could never repair an agent whose model config was broken —
  // and reported success as soon as the message was *delivered*, regardless of
  // whether the switch landed. patchSession() awaits the real result.
  const changeModel = useCallback(
    async (modelId: string | null, pickedProvider?: string) => {
      const key = activeKeyRef.current;
      if (!key) return;
      // 用户主动选的模型立即反映到选择器（在下一条回答回来前不被实际模型覆盖）。
      setPickedModel(modelId);
      // 同一个 id 可能横跨多个 provider（如 deepseek-v4-flash 同时在 deepseek/xiaomi/
      // volcengine）。优先使用 Agent 能力声明的 scope/provider，再使用菜单里
      // 用户实际点中的 provider；只有候选唯一时才自动继承。
      const modelCaps = capabilitiesForSession(key);
      const scopedProvider = modelCaps?.modelProvider;
      const requestedProvider = pickedProvider
        && (!scopedProvider || pickedProvider === scopedProvider)
        ? pickedProvider
        : scopedProvider;
      const scopedModels = models.filter((model) =>
        (!modelCaps?.modelScope || model.modelScopes?.includes(modelCaps.modelScope))
        && (!scopedProvider || model.provider === scopedProvider),
      );
      const selectedModel = inheritedModelChoice(
        scopedModels,
        modelId,
        modelsBackendRef.current,
        requestedProvider,
      );
      const provider = requestedProvider ?? selectedModel?.provider;
      // UI keeps the raw model id and its identity metadata separate. The proxy
      // adapts that neutral shape at each backend protocol boundary.
      const patch = {
        model: modelId,
        ...(provider ? { modelProvider: provider } : {}),
        ...(selectedModel?.acpProviderRef ? { acpProviderRef: selectedModel.acpProviderRef } : {}),
      };
      const switched = await patchSession(patch, t("chat.labelModel"));
      if (!switched && activeKeyRef.current === key) setPickedModel(null);
    },
    [patchSession, models],
  );

  // Use persisted session settings when available, with a transient fallback
  // for backends that do not echo fastMode. Only reflect successful changes.
  const [fastByKey, setFastByKey] = useState<Record<string, boolean>>({});

  useEffect(() => {
    // Connection lifecycle: auto-reconnect with a flat 3s backoff. A dropped
    // socket (gateway restart, broker blip) self-heals instead of leaving the
    // page dead-offline until a manual reload; onopen re-pulls the list and the
    // active history. Cold start renders a neutral "连接中…" banner — the hard
    // "连接出错" error only appears for a connection that had been established
    // (or once retries keep failing past the grace window).
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let hadConnected = false;
    let failedAttempts = 0;
    const connect = () => {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      // 每次建立新 socket 都从干净的实时轮次开始；主动发送前仍会按当前 session 再清一次。
      clearLiveTurnState(liveToolsRef.current, pendingThinkingRef.current, pendingPlanRef.current);
      liveTextRef.current.clear();
      steerTextBaselineRef.current.clear();
      // R339:半截的直播时间线同样不能跨连接继承(留档的 lastTurnStepsRef 保留——
      // 它只描述已终结的回合,与连接无关)。
      liveTimelinesRef.current.clear();
      const ws = new WebSocket(`${proto}://${location.host}/__chatws`);
      wsRef.current = ws;
      const nativeFrames = createNativeChatFrameAssembler();
      let incoming = Promise.resolve();
      ws.onopen = async () => {
      const isReconnect = hadConnected;
      hadConnected = true;
      failedAttempts = 0;
      setConnected(true);
      subagentActivity.connect([]);
      setEverConnected(true);
      emitGroupConnection();
      setError(null);
      void refreshGroupChats();
      if (isReconnect) {
        // In-flight marks belong to the DEAD socket: their final/error events
        // are gone (Hermes runs emit only to the old connection; a restarted
        // gateway killed the run). Without this the composer shows "生成中"
        // forever. A still-running gateway turn's outcome re-arrives via
        // session.message / the loadHistory below regardless.
        inFlightRef.current = new Set(readPendingTrackedSends().filter(entry => entry.terminalObserved !== true).map(entry => entry.key));
        runStatusBySessionRef.current.clear();
        observedRunBySessionRef.current.clear();
        setRunningKeys(new Set(inFlightRef.current));
        setSending(inFlightRef.current.has(activeKeyRef.current || ""));
      }
      try {
        await send("chat.ui.capabilities", { nativeUiArtifactsV1: true }).catch(() => {});
        await refreshSessions();
        // Subscribe this connection to session-scoped events so the gateway streams
        // `session.tool` (live tool lifecycle) to us — without it the gateway only
        // sends tool events to run-scoped recipients, and tool cards never appear
        // until the turn finalizes. Connection-wide (no sessionKey); we filter by
        // active session in the handler. CONTROL_UI is in the same scope as sessions.list.
        void send("sessions.subscribe", {}).catch(() => {});
        // If a session was already auto-selected from the cache before the
        // socket opened, its first loadHistory rejected ("未连接"); load it now.
        // Also reloads the active session's history on any reconnect.
        if (activeKeyRef.current) void loadHistory(activeKeyRef.current);
        void verifyPendingTrackedSends();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    };
      ws.onclose = () => {
        // close 必须结算该 socket 的请求；随后再核对身份，避免旧 close 改写新连接状态。
        rejectPendingRpcForSocket(pending.current, ws,
          Object.assign(new Error(t("chat.connectionError")), { receiptUncertain: true }));
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        gatewayContractRef.current = null;
        subagentActivity.connect(null);
        execApprovals.connect(null);
        setGatewayContract(null);
        setConnected(false);
        if (!closed) retryTimer = setTimeout(connect, 3000);
      };
      ws.onerror = () => {
        failedAttempts += 1;
        // 曾经连上过 → 这是**掉线**，不是错误：3s 自动重连就在跑，横幅走下面 `!connected`
        // 那支中性的「正在重连」。此前这里一律翻红「连接出错」，让一次几秒就自愈的抖动
        // 看起来像需要用户动手修的故障。只有冷启动连续失败（≈9s 仍连不上）才算真出错。
        if (!hadConnected && failedAttempts >= 3) setError(t("chat.connectionError"));
      };
      const consumeMessage = async (ev: MessageEvent) => {
      let f: any;
      try {
        f = await nativeFrames.accept(JSON.parse(ev.data));
        if (!f || wsRef.current !== ws) return;
      } catch {
        return;
      }
      if (f.type === "event" && ["chat", "agent", "session.tool", "session.message"].includes(f.event)
        && subagentActivity.event(f.event, f.payload)) {
        if ((f.event === "chat" && ["final", "error", "aborted"].includes(f.payload?.state))
          || (f.event === "agent" && f.payload?.stream === "lifecycle")) {
          if (sessionsRefreshTimerRef.current) clearTimeout(sessionsRefreshTimerRef.current);
          sessionsRefreshTimerRef.current = setTimeout(() => {
            sessionsRefreshTimerRef.current = null;
            void refreshSessions().catch(() => {});
          }, 150);
        }
        return;
      }
      const terminalObservation = observedChatTerminal(f,
        observedRunBySessionRef.current.get(f.payload?.sessionKey));
      if (terminalObservation) {
        if (f.event === "sessions.changed") {
          if (sessionsRefreshTimerRef.current) clearTimeout(sessionsRefreshTimerRef.current);
          sessionsRefreshTimerRef.current = setTimeout(() => {
            sessionsRefreshTimerRef.current = null;
            void refreshSessions().catch(() => {});
          }, 150);
        }
        // Reuse the ordinary terminal handler, including exact durable send
        // verification. Closing the animation must not authorize a replay.
        f = terminalObservation;
      }
      if (f.type === "res" && f.id != null) {
        const p = takePendingRpc(pending.current, String(f.id), ws);
        if (!p) return;
        if (f.ok === false) p.reject(Object.assign(new Error(f.error?.message || t("chat.requestFailed")), {
          ...(typeof f.error?.code === "string" ? { code: f.error.code } : {}),
          ...(f.error?.admissionAccepted === false ? { admissionAccepted: false } : {}),
          ...(f.error?.receiptUncertain === true ? { receiptUncertain: true } : {}),
          ...(f.error?.requestNotSent === true ? { requestNotSent: true } : {}),
        }));
        else p.resolve(f);
        return;
      }
      if (f.type === "event" && f.event === "gateway.ready") {
        const contract = f.payload?.degraded === true ? null : normalizeGatewayContract(f.payload);
        gatewayContractRef.current = contract;
        subagentActivity.connect(contract?.features.methods ?? null);
        execApprovals.connect(contract);
        setGatewayContract(contract);
        return;
      }
      if (f.type === "event" && ["exec.approval.requested", "exec.approval.resolved"].includes(f.event)) {
        execApprovals.event(f.event, f.payload);
        return;
      }
      if (
        f.type === "event"
        && f.event === "question.requested"
        && gatewaySupportsQuestions(gatewayContractRef.current)
      ) {
        const prompt = normalizeOpenClawQuestionPrompt(f.payload);
        if (!prompt?.sessionKey) return;
        questionEventEpochRef.current += 1;
        const entries = pendingPromptsRef.current.get(prompt.sessionKey) ?? [];
        replacePendingPrompts(prompt.sessionKey, [
          ...entries.filter((entry) => !isOpenClawQuestionPrompt(entry) || entry.id !== prompt.id),
          prompt,
        ]);
        // Questions, especially secrets, are transient control-plane state. Do
        // not feed them into the timeline, toast, console, or browser storage.
        renderLiveStateForSession(prompt.sessionKey);
        return;
      }
      if (
        f.type === "event"
        && f.event === "question.resolved"
        && gatewaySupportsQuestions(gatewayContractRef.current)
        && typeof f.payload?.id === "string"
        && (f.payload?.status === "answered" || f.payload?.status === "cancelled" || f.payload?.status === "expired")
      ) {
        questionEventEpochRef.current += 1;
        let changedActive = false;
        for (const [sessionKey, entries] of pendingPromptsRef.current) {
          const next = entries.filter((entry) => !isOpenClawQuestionPrompt(entry) || entry.id !== f.payload.id);
          if (next.length === entries.length) continue;
          replacePendingPrompts(sessionKey, next);
          if (activeKeyRef.current && subagentActivity.relatedKeys(activeKeyRef.current).includes(sessionKey)) changedActive = true;
        }
        if (changedActive && activeKeyRef.current) renderLiveStateForSession(activeKeyRef.current);
        return;
      }
      if (
        f.type === "event"
        && f.event === "progressCard.changed"
        && gatewaySupportsProgressCards(gatewayContractRef.current)
        && typeof f.payload?.sessionKey === "string"
      ) {
        const progressSessionKey = f.payload.sessionKey;
        const eventEpoch = (progressEventEpochRef.current.get(progressSessionKey) ?? 0) + 1;
        progressEventEpochRef.current.set(progressSessionKey, eventEpoch);
        if (f.payload.revision === null) {
          clearOpenClawProgressCard(progressSessionKey);
        } else if (Number.isInteger(f.payload.revision) && f.payload.revision >= 1) {
          void refreshOpenClawProgressCard(progressSessionKey, f.payload.revision, eventEpoch);
        }
        return;
      }
      if (f.type === "event" && shouldRefreshSessionBoardEvent(
        gatewayContractRef.current?.features.events ?? [],
        f.event,
        f.payload?.sessionKey,
        activeKeyRef.current,
      )) {
        const currentKey = activeKeyRef.current;
        if (currentKey && agentOf(f.payload.sessionKey) === agentOf(currentKey)) {
          // The event carries only a revision, not a snapshot. Freeze writes
          // immediately and invalidate any older board.get before it can clear
          // stale state or briefly remount an obsolete HTML document.
          sessionBoardProbeEpochRef.current += 1;
          setSessionBoardLoading(false);
          sessionBoardStaleRef.current = true;
          setSessionBoardStale(true);
          if (!sessionBoardRefreshTimerRef.current) {
            sessionBoardRefreshTimerRef.current = setTimeout(() => {
              sessionBoardRefreshTimerRef.current = null;
              if (activeKeyRef.current === currentKey) setSessionBoardReload((value) => value + 1);
            }, 80);
          }
        }
        return;
      }
      // M7b.1 intentionally defers board.command: applying remote dock/focus commands
      // needs the ticketed board host and an explicit UI mapping, neither exists yet.
      if (
        f.type === "event"
        && typeof f.event === "string"
        && gatewayAdvertises(gatewayContractRef.current, "events", f.event)
        && /^workboard(?:\.|$).*changed$/.test(f.event)
      ) {
        window.dispatchEvent(new CustomEvent("shoggoth:surface-changed", {
          detail: { surface: "kanban", event: f.event, payload: f.payload },
        }));
        return;
      }
      if (f.type === "event" && f.event === "group.changed") {
        if (typeof f.payload?.groupId === "string") emitGroupChanged(f.payload.groupId);
        return;
      }
      if (f.type === "event" && f.event === "sessions.changed") {
        if (sessionsRefreshTimerRef.current) clearTimeout(sessionsRefreshTimerRef.current);
        sessionsRefreshTimerRef.current = setTimeout(() => {
          sessionsRefreshTimerRef.current = null;
          void refreshSessions().catch(() => {});
        }, 150);
        return;
      }
      if (f.type === "event" && f.event === "chat.ui.revoked") {
        const payload = f.payload;
        if (typeof payload?.sessionKey === "string") revokeNativeUiEntries(payload.sessionKey, payload.artifactId, payload.revision, payload.reason);
        return;
      }
      if (f.type === "event" && f.event === "chat.ui.operation") {
        const key = f.payload?.sessionKey;
        if (typeof key === "string" && f.payload?.operation?.runId) {
          bumpSession(key, Date.now());
          if (key === activeKeyRef.current) void loadHistory(key, { refresh: true });
        }
        return;
      }
      if (f.type === "event" && f.event === "agents.changed") {
        // Service 恢复不一定重连 Proxy，也不一定产生 group.changed。
        void refreshGroupChats();
        // Backend topology changed: the proxy emits this when the gateway goes
        // degraded / comes back, and when a slow backend (Hermes) finishes
        // starting. Re-pull the list so agents appear/disappear without a reload.
        void refreshSessions().catch(() => {});
        // A Service can recover without closing this Proxy socket. Recheck
        // durable originals after an earlier lookup failed during its restart.
        void verifyPendingTrackedSends();
        // 启动竞态自愈：Hermes 后端就绪前发出的 chat.history 会落进上游兜底而失败，横幅
        // 停在残留错误上。backend.ready 广播的这条事件说明归属表已就绪 —— 若仍挂着错误就
        // 重试一次，让横幅自动消失，不必等用户手点「重新加载」。
        if (historyErrorRef.current && activeKeyRef.current) {
          chatHistoryController.markNeedsRevalidate(activeKeyRef.current);
        }
        // 后端就绪 → 重取聊天面能力：启动竞态里首个打开的 agent 那次拉取多半失败，
        // 不重取的话 composer 会一直停在 image-only（真机症状：打开就选中的那个
        // agent 只能选图片，切走再切回才恢复）。
        setCapsEpoch((n) => n + 1);
        setRuntimeModelsEpoch((n) => n + 1);
        // 同时复查连通状态：分批启动的后端刚从 starting 翻成 connected，靠这次探测
        // 让灰点立刻转绿，不必等 15s 轮询。
        void refreshStatusRef.current?.();
        return;
      }
      if (f.type === "event" && f.event === "chat.operation.accepted") {
        const { sessionKey: key, runId } = f.payload || {};
        const pending = readPendingTrackedSends().find(entry => entry.key === key && entry.idem === runId
          && !entry.selection?.length && (!entry.backendId || entry.backendId === "openclaw"));
        // Receipt recovery must not replace the live run with the id of an
        // ordinary input queued behind it. Only a retained original is observed.
        if (pending && backendOfSession(key) === "openclaw") {
          acceptTrackedPluginSend(key, runId);
          void verifyPendingTrackedSends(key);
        }
        return;
      }
      if (f.type === "event" && f.event === "chat") {
        const p = f.payload || {};
        const sk: string | undefined = p.sessionKey;
        const isActive = sk === activeKeyRef.current;
        if (sk && typeof p.runId === "string"
          && ["accepted", "delta", "interim", "thinking", "plan", "prompt"].includes(p.state)) {
          observedRunBySessionRef.current.set(sk, p.runId);
        }
        const trackedEvent = sk && typeof p.runId === "string"
          ? readPendingTrackedSends().find(entry => entry.key === sk && entry.idem === p.runId) : undefined;
        // An exact operation id cannot let another backend/Agent consume its
        // draft or turn a foreign rejection into a resendable original input.
        if (trackedEvent && sk && ((trackedEvent.backendId && trackedEvent.backendId !== backendOfSession(sk))
          || (p.agentId !== undefined && p.agentId !== agentOf(sk))
          || (p.backendId !== undefined && p.backendId !== (trackedEvent.backendId || backendOfSession(sk))))) return;
        if (sk && backendOfSession(sk) === "openclaw" && ["final", "error", "aborted"].includes(p.state)) {
          openclawPreamblesRef.current.finish(sk, p.runId);
        }
        if (sk && typeof p.runId === "string" && p.state === "accepted") {
          const matched = acceptTrackedPluginSend(sk, p.runId);
          if (matched && runStatusBySessionRef.current.get(sk) === "needs_verification") {
            void verifyPendingTrackedSends(sk);
          }
          if (matched && runStatusBySessionRef.current.get(sk) !== "needs_verification") setVerificationKeys(previous => {
            if (!previous.has(sk)) return previous;
            const next = new Set(previous); next.delete(sk); return next;
          });
        }
        if (sk && ["final", "error", "aborted"].includes(p.state) && hasPendingTrackedSend(sk)) {
          const tracked = readPendingTrackedSends().find(entry => entry.key === sk && entry.idem === p.runId);
          const rejected = p.state === "error" && isExplicitChatSendRejection({
            code: p.errorCode, admissionAccepted: p.admissionAccepted, receiptUncertain: p.receiptUncertain,
          });
          if (tracked?.backendId && tracked.backendId === backendOfSession(sk)
            && (p.agentId === undefined || p.agentId === agentOf(sk))
            && (p.backendId === undefined || p.backendId === tracked.backendId)
            && !(rejected && !tracked.accepted)) {
            pendingChatSendStore.observeTerminal(sk, tracked.idem, tracked.backendId);
            const previous = terminalObservedSendRef.current.get(sk);
            if (!previous || previous.operationId !== tracked.idem || previous.backendId !== tracked.backendId) {
              if (previous?.timer) clearTimeout(previous.timer);
              terminalObservedSendRef.current.set(sk, { operationId: tracked.idem, backendId: tracked.backendId,
                agentId: agentOf(sk), attempts: 0, timer: null });
            }
            // Fence earlier running lookups before this authenticated event.
            sendObservationEpochRef.current.set(sk, (sendObservationEpochRef.current.get(sk) ?? 0) + 1);
          }
          if (tracked && rejected && !tracked.accepted) {
            forgetPendingTrackedSend(sk, tracked.idem);
            restoreRejectedPluginSend(tracked.idem, sk);
          } // Accepted execution errors still require the original durable operation lookup.
          if (hasPendingTrackedSend(sk)) {
            setVerificationKeys(previous => new Set(previous).add(sk));
            void verifyPendingTrackedSends(sk);
          } else setVerificationKeys(previous => {
            if (!previous.has(sk)) return previous;
            const next = new Set(previous); next.delete(sk); return next;
          });
        }
        if (sk) {
          if (p.state === "status" && typeof p.statusKind === "string") {
            runStatusBySessionRef.current.set(sk, p.statusKind);
            if (p.statusKind === "needs_verification") {
              sendObservationEpochRef.current.set(sk, (sendObservationEpochRef.current.get(sk) ?? 0) + 1);
              setVerificationKeys((previous) => new Set(previous).add(sk));
            } else if (p.statusKind !== "reconnecting" && !hasPendingTrackedSend(sk)) {
              setVerificationKeys((previous) => {
                if (!previous.has(sk)) return previous;
                const next = new Set(previous); next.delete(sk); return next;
              });
            }
          } else if (["delta", "interim", "thinking", "plan"].includes(p.state)) {
            runStatusBySessionRef.current.set(sk, "running");
          } else if (p.state === "prompt") {
            runStatusBySessionRef.current.set(
              sk,
              ["approval", "runtime_approval", "product_confirmation"].includes(p.prompt?.kind)
                ? "waiting_approval" : "waiting_input",
            );
          } else if (["final", "error", "aborted"].includes(p.state)) {
            runStatusBySessionRef.current.delete(sk);
          }
        }
        if (sk) setRunWaitBySession((previous) => {
          const wait = p.state === "status" ? chatRunWaitState(p) : null;
          if (wait) {
            const old = previous[sk];
            if (old?.kind === wait.kind && old.reason === wait.reason) {
              wait.since = Math.min(old.since, wait.since);
              if (old.since === wait.since) return previous;
            }
            return { ...previous, [sk]: wait };
          }
          if (!previous[sk]) return previous;
          const next = { ...previous }; delete next[sk]; return next;
        });
        if (sk && isLiveChatState(p.state, p.statusKind)) markInFlight(sk, true);
        if (sk && p.state === "status" && p.statusKind === "idle") {
          // A successful session observation clears stale generation UI. The
          // original pending operation still guards sends inside markInFlight.
          markInFlight(sk, false);
          if (isActive && !inFlightRef.current.has(sk)) setSending(false);
          if (terminalObservation && !inFlightRef.current.has(sk)) {
            liveToolsRef.current.delete(sk);
            pendingThinkingRef.current.delete(sk);
            const durableProgress = progressCardsRef.current.get(sk);
            if (durableProgress) pendingPlanRef.current.set(sk, progressCardPlan(durableProgress));
            else pendingPlanRef.current.delete(sk);
            replacePendingPrompts(sk, []);
            liveTextRef.current.delete(sk);
            steerTextBaselineRef.current.delete(sk);
            if (isActive) {
              setMessages(settlePendingAssistant);
              void loadHistory(sk, { refresh: true });
            }
          }
          // Idle is an observation hint, not proof that a particular send ended.
          if (hasPendingTrackedSend(sk)) void verifyPendingTrackedSends(sk);
        }
        if (sk) {
          // a real reply is arriving → cancel any slash-command watchdog for this session
          const wd = slashWatchdogRef.current.get(sk);
          if (wd) {
            clearTimeout(wd);
            slashWatchdogRef.current.delete(sk);
          }
        }
        if (p.state === "delta") {
          const nativeUi = p.message?.shoggoth?.nativeUiVersion === 1
            && p.message?.content?.some?.((part: unknown) => normalizeNativeUiPart(part));
          if (nativeUi) {
            for (const part of p.message.content) {
              if (sk && part?.type === "text" && part.activity === true && typeof part.segmentId === "string" && typeof part.text === "string")
                timelineFeed(sk, { kind: "progress", text: part.text, activityId: part.segmentId });
            }
            if (isActive) setMessages(prev => applyNativeUiDelta(prev, p.message,
              (sk && liveToolsRef.current.get(sk)) || [], (sk && pendingThinkingRef.current.get(sk)) || "",
              (sk && pendingPlanRef.current.get(sk)) || [], (sk && displayPromptsFor(sk)) || []));
            return;
          }
          const full = contentToText(p.message?.content) || contentToText(p.message);
          if (sk) timelineFeed(sk, { kind: "delta", text: full });
          const projected = sk
            ? projectSteeredLiveText(
                liveTextRef.current.get(sk) || "",
                full,
                steerTextBaselineRef.current.get(sk),
              )
            : { accumulated: full, visible: full };
          if (sk) liveTextRef.current.set(sk, projected.accumulated);
          if (isActive)
            setMessages((prev) =>
              applyDelta(
                prev,
                projected.visible,
                (sk && liveToolsRef.current.get(sk)) || [],
                (sk && pendingThinkingRef.current.get(sk)) || "",
                (sk && pendingPlanRef.current.get(sk)) || [],
                (sk && displayPromptsFor(sk)) || [],
                canvasPartsFromContent(p.message?.content ?? p.message),
              ),
            );
        } else if (p.state === "interim") {
          // 中场封段（Hermes 网关 message.interim）：当前 pending 气泡定稿成一条
          // 完整消息（工具卡/思考随之落定），再开新的 pending 继续接本轮余下的流。
          if (sk) {
            const full = contentToText(p.message?.content) || contentToText(p.message);
            const wasSteered = steerTextBaselineRef.current.has(sk);
            const projected = projectSteeredLiveText(
              liveTextRef.current.get(sk) || "",
              full,
              steerTextBaselineRef.current.get(sk),
            );
            const progress = p.message?.content?.find?.((part: any) => part?.type === "text" && part.activity === true);
            timelineFeed(sk, { kind: "interim", text: projected.visible,
              ...(progress ? { activity: true, activityId: progress.segmentId } : {}) });
            liveToolsRef.current.delete(sk);
            pendingThinkingRef.current.delete(sk);
            if (isActive) {
              setMessages((prev) => [
                ...finalizeAssistant(prev, p.message, wasSteered ? projected.visible : undefined, true),
                { role: "assistant", parts: [{ type: "text", text: "" }], pending: true },
              ]);
            }
            // Commentary/interim seals the current runtime text item. The next
            // item starts a fresh accumulator and no longer needs the steer cut.
            liveTextRef.current.delete(sk);
            steerTextBaselineRef.current.delete(sk);
          }
        } else if (p.state === "status") {
          // 压缩归入当前会话的实时动态；纯 status 流也要创建/刷新 pending 气泡。
          if (sk && typeof p.statusKind === "string" && p.statusKind !== "idle") {
            timelineFeed(sk, { kind: "status", status: { kind: p.statusKind, text: typeof p.text === "string" ? p.text : undefined } });
            if (["compacting", "compacted", "recalling", "recalled"].includes(p.statusKind)) renderLiveStateForSession(sk);
          }
        } else if (p.state === "prompt") {
          // agent 阻塞等待用户回应（审批/澄清/sudo/密钥）→ pending 气泡上出交互卡。
          if (sk && p.prompt && typeof p.prompt === "object") {
            const arr = (pendingPromptsRef.current.get(sk) ?? []).slice();
            const prompt = p.prompt as Omit<ChatPromptEntry, "id">;
            const known = typeof prompt.requestId === "string"
              && arr.some((entry) => entry.requestId === prompt.requestId);
            if (!known) timelineFeed(sk, { kind: "prompt", prompt });
            const nextPrompts = upsertPromptEntry(arr, {
              ...prompt,
              id: `p${Date.now()}-${arr.length}`,
            });
            replacePendingPrompts(sk, nextPrompts);
            if (isActive)
              setMessages((prev) =>
                applyToolStream(prev, liveToolsRef.current.get(sk) || [], pendingThinkingRef.current.get(sk) || "", pendingPlanRef.current.get(sk) || [], nextPrompts),
              );
          }
        } else if (p.state === "promptExpire") {
          if (sk && typeof p.requestId === "string") {
            timelineFeed(sk, { kind: "promptExpire", requestId: p.requestId });
            const arr = (pendingPromptsRef.current.get(sk) ?? []).filter((e) => e.requestId !== p.requestId);
            replacePendingPrompts(sk, arr);
            if (isActive)
              setMessages((prev) =>
                applyToolStream(prev, liveToolsRef.current.get(sk) || [], pendingThinkingRef.current.get(sk) || "", pendingPlanRef.current.get(sk) || [], arr),
              );
          }
        } else if (p.state === "thinking") {
          // Streamed reasoning (Hermes). Accumulate + re-render the pending bubble's
          // thinking part live; the final history reload then owns the settled card.
          if (sk && typeof p.thinking === "string") {
            timelineFeed(sk, { kind: "thinking", text: p.thinking });
            pendingThinkingRef.current.set(sk, p.thinking);
            if (isActive)
              setMessages((prev) => applyToolStream(prev, liveToolsRef.current.get(sk) || [], p.thinking, pendingPlanRef.current.get(sk) || [], displayPromptsFor(sk)));
          }
        } else if (p.state === "plan") {
          // All backends use the same plan dock; tool/thinking visibility is independent.
          if (sk && Array.isArray(p.plan)) {
            timelineFeed(sk, { kind: "plan", entries: p.plan });
            pendingPlanRef.current.set(sk, p.plan);
            if (isActive)
              setMessages((prev) => applyToolStream(prev, liveToolsRef.current.get(sk) || [], pendingThinkingRef.current.get(sk) || "", p.plan, displayPromptsFor(sk)));
          }
        } else if (p.state === "final" && p.outputDisposition === "silent") {
          // A completed background check owns no user-visible reply. Clear its
          // transient state without advancing activity/preview/unread clocks.
          if (sk) {
            markInFlight(sk, false);
            liveToolsRef.current.delete(sk);
            pendingThinkingRef.current.delete(sk);
            pendingPlanRef.current.delete(sk);
            liveTimelinesRef.current.delete(sk);
            liveTextRef.current.delete(sk);
            steerTextBaselineRef.current.delete(sk);
            replacePendingPrompts(sk, []);
            reloadOnFinalRef.current.delete(sk);
            if (isActive) {
              setMessages(prev => prev.filter(message => !message.pending));
              setSending(false);
              void loadHistory(sk, { refresh: true });
            }
          }
        } else if (p.state === "final") {
          const fullFinalText = contentToText(p.message?.content) || contentToText(p.message) || "";
          const wasSteered = !!sk && steerTextBaselineRef.current.has(sk);
          const projectedFinal = sk
            ? projectSteeredLiveText(
                liveTextRef.current.get(sk) || "",
                fullFinalText,
                steerTextBaselineRef.current.get(sk),
              )
            : { accumulated: fullFinalText, visible: fullFinalText };
          if (sk) {
            markInFlight(sk, false);
            liveToolsRef.current.delete(sk); // turn done → history (via the reload below) owns the tool cards
            pendingThinkingRef.current.delete(sk);
            const durableProgress = progressCardsRef.current.get(sk);
            if (durableProgress) pendingPlanRef.current.set(sk, progressCardPlan(durableProgress));
            else pendingPlanRef.current.delete(sk);
            replacePendingPrompts(sk, []);
            const finishedAt = Date.now();
            bumpSession(sk, finishedAt); // reply finished → float this agent to the top
            rememberChosen(sk); // 完成的回复 = 新消息 → 该 agent 行跟随这个会话
            const finalText = fullFinalText;
            const isRealReply = canvasPartsFromContent(p.message?.content ?? p.message).length > 0 || !isHeartbeatAckText(finalText);
            // Final/session.message timestamps can be proxy emission times. bumpSession
            // schedules an authority probe; only chat.history advances unread watermarks.
            // bumpSession 只推进 updatedAt，而行时间/排序的口径早已换成 realTimes/previewTimes
            // （updatedAt 只是冷启动兜底）。深扫探针按 key 去重、成功后永不重扫，所以一个扫过的
            // 非活跃 agent 收到真实回复后：红点亮起，行时间却仍显示「5 小时前」，位置也不上浮。
            // 这里把真实回复同样写穿三处记账，和 loadHistory / 探针保持一个口径。
            if (isRealReply) {
              advanceRealActivity(sk, finishedAt);
              setPreviewTimes((prev) => ({ ...prev, [sk]: finishedAt }));
              if (finalText) setPreviews((prev) => ({ ...prev, [sk]: finalText }));
            }
            // Hermes final 带上下文占用三元组 → 就地点亮该行的底部计量条与模型，
            // 不等下一次全量列表刷新（OpenClaw final 无 usage，等价 no-op）。
            const fu = (p.message?.usage ?? {}) as Usage;
            timelineFeed(sk, {
              kind: "final",
              text: finalText,
              meta: { usage: fu, model: typeof p.message?.model === "string" ? p.message.model : undefined },
            });
            if (fu.contextMax || fu.contextUsed) {
              setSessions((prev) =>
                prev.map((s) =>
                  s.key === sk
                    ? {
                        ...s,
                        ...(fu.contextMax ? { contextTokens: fu.contextMax } : {}),
                        ...(fu.contextUsed ? { totalTokens: fu.contextUsed, totalTokensFresh: true } : {}),
                        ...(typeof p.message?.model === "string" && p.message.model ? { model: p.message.model } : {}),
                      }
                    : s,
                ),
              );
            }
            // Turn-complete 合并刷新（300ms）：新会话行/自动命名标题随之出现。
            if (sessionsRefreshTimerRef.current) clearTimeout(sessionsRefreshTimerRef.current);
            sessionsRefreshTimerRef.current = setTimeout(() => {
              sessionsRefreshTimerRef.current = null;
              void refreshSessions().catch(() => {});
            }, 300);
            liveTextRef.current.delete(sk);
            steerTextBaselineRef.current.delete(sk);
          }
          if (isActive) {
            // Preserve the current reading position while the sealed bubbles
            // are replaced by canonical history. The next turn resumes follow.
            stoppedScrollKeyRef.current = sk;
            setMessages((prev) => finalizeAssistant(
              prev,
              p.message,
              wasSteered ? projectedFinal.visible : undefined,
              true,
            ));
            if (sk && progressCardsRef.current.has(sk)) renderLiveStateForSession(sk);
            setSending(false);
          }
          // Reasoning/thinking blocks are persisted to the transcript but NOT streamed in
          // the chat events (verified live: delta+final carry only the answer text), so they
          // never render during the turn — they only appeared after an agent-switch reload
          // re-ran normalize. Re-fetch the canonical history on final (the SAME loadHistory
          // the session switch uses) so a completed turn shows its Reasoning card (+ any other
          // history-only parts) in place, no switch needed. The gateway persists the transcript
          // before broadcasting final (append-then-broadcast), so history already has this turn.
          // Also subsumes the /new|/reset resync that reloadOnFinalRef did.
          if (sk && (isActive || reloadOnFinalRef.current.has(sk))) {
            reloadOnFinalRef.current.delete(sk);
            void loadHistory(sk, { refresh: true });
          }
        } else if (p.state === "error") {
          if (sk) {
            timelineFeed(sk, { kind: "error", message: typeof p.errorMessage === "string" ? p.errorMessage : "" });
            markInFlight(sk, hasPendingTrackedSend(sk));
            liveToolsRef.current.delete(sk);
            pendingThinkingRef.current.delete(sk);
            const durableProgress = progressCardsRef.current.get(sk);
            if (durableProgress) pendingPlanRef.current.set(sk, progressCardPlan(durableProgress));
            else pendingPlanRef.current.delete(sk);
            replacePendingPrompts(sk, []);
            liveTextRef.current.delete(sk);
            steerTextBaselineRef.current.delete(sk);
          }
          if (isActive) {
            // Store the RAW gateway error; render-time wraps it with errPrefix +
            // translateGatewayError so the bubble follows live language switches.
            setMessages((prev) => [
              ...settlePendingAssistant(prev, sk ? liveTimelinesRef.current.get(sk)?.steps : undefined),
              { role: "system", parts: [{ type: "text", text: p.errorMessage || "" }], errPrefix: "chat.errorPrefix" },
            ]);
            if (sk && progressCardsRef.current.has(sk)) renderLiveStateForSession(sk);
            setSending(false);
          }
        } else if (p.state === "aborted") {
          // R339/S3:此前 aborted 整帧被丢弃,pending 气泡悬空等 session.message 兜底。
          // 按「终止版 final」处理:落定局部文本(线上 message 只在有缓冲文本时存在)、
          // 清 in-flight、重载历史;时间线把仍在跑的步骤收敛为「中断」。
          if (sk) {
            timelineFeed(sk, { kind: "aborted", message: typeof p.errorMessage === "string" && p.errorMessage ? p.errorMessage : undefined });
            markInFlight(sk, false);
            liveToolsRef.current.delete(sk);
            pendingThinkingRef.current.delete(sk);
            const durableProgress = progressCardsRef.current.get(sk);
            if (durableProgress) pendingPlanRef.current.set(sk, progressCardPlan(durableProgress));
            else pendingPlanRef.current.delete(sk);
            replacePendingPrompts(sk, []);
          }
          if (isActive) {
            const full = contentToText(p.message?.content) || contentToText(p.message) || "";
            const wasSteered = !!sk && steerTextBaselineRef.current.has(sk);
            const projected = sk
              ? projectSteeredLiveText(
                  liveTextRef.current.get(sk) || "",
                  full,
                  steerTextBaselineRef.current.get(sk),
                )
              : { accumulated: full, visible: full };
            setMessages((prev) => (p.message
              ? finalizeAssistant(prev, p.message, wasSteered ? projected.visible : undefined, true)
              : settlePendingAssistant(prev, sk ? liveTimelinesRef.current.get(sk)?.steps : undefined)));
            if (sk && progressCardsRef.current.has(sk)) renderLiveStateForSession(sk);
            setSending(false);
          }
          if (sk) {
            liveTextRef.current.delete(sk);
            steerTextBaselineRef.current.delete(sk);
          }
          if (sk && (isActive || reloadOnFinalRef.current.has(sk))) {
            reloadOnFinalRef.current.delete(sk);
            void loadHistory(sk, { refresh: true });
          }
        }
        return;
      }
      // Live tool cards: the gateway streams tool lifecycle on `agent`(stream:"tool")
      // and the session-scoped `session.tool` event — NOT on the `chat` stream. Track
      // each call by toolCallId and attach cards to the in-flight assistant bubble so
      // tools render as they run (start → result). The `final` reload-on-final then
      // replaces them with the canonical history render. (Reasoning is never streamed,
      // so there's nothing live to show for it — it arrives only with the final message.)
      if (f.type === "event" && (f.event === "session.tool" || (f.event === "agent" && f.payload?.stream === "tool"))) {
        const p = f.payload || {};
        const sk: string | undefined = p.sessionKey;
        const d = p.data || p; // session.tool/agent both carry the tool fields under data
        const id: string | undefined = d?.toolCallId || d?.id;
        if (sk && id) {
          const arr = liveToolsRef.current.get(sk) ?? [];
          let entry = arr.find((x) => x.id === id);
          if (entry?.phase === "result" && d.phase !== "result") return;
          if (typeof p.runId === "string") observedRunBySessionRef.current.set(sk, p.runId);
          runStatusBySessionRef.current.set(sk, "running");
          if (d.phase !== "result") markInFlight(sk, true);
          if (!entry) {
            entry = { id, name: typeof d.name === "string" && d.name ? d.name : "tool" };
            arr.push(entry);
          } else if (typeof d.name === "string" && d.name) {
            entry.name = d.name;
          }
          entry.phase = d.phase === "result" ? "result" : d.phase === "update" ? "update" : "start";
          if (d.args !== undefined) entry.args = mergeToolArgs(entry.args, d.args);
          if (entry.diff === undefined && d.diff) entry.diff = d.diff; // file-edit diff (write/patch start)
          if (entry.diffText === undefined && typeof d.diffText === "string" && d.diffText) entry.diffText = d.diffText; // Hermes inline_diff
          if (typeof d.durationS === "number" && d.durationS > 0) entry.durationS = d.durationS; // Hermes tool runtime
          if (d.phase === "result" && d.result !== undefined) entry.output = formatToolOutput(d.result);
          else if (d.phase === "update" && d.partialResult !== undefined) entry.output = formatToolOutput(d.partialResult);
          if (d.phase === "result") entry.pluginAppCallId = validPluginAppCallId(d.pluginAppCallId);
          if (typeof d.isError === "boolean") entry.isError = d.isError;
          else if (d.phase === "result") entry.isError = entry.isError === true || toolResultFailed(d.result);
          liveToolsRef.current.set(sk, arr);
          // R339 直播时间线:同一事件并行喂 reducer(字段与钩子契约同名直传)。
          timelineFeed(sk, {
            kind: "tool",
            toolCallId: id,
            name: typeof d.name === "string" && d.name ? d.name : undefined,
            args: d.args,
            phase: d.phase === "result" ? "result" : d.phase === "update" ? "update" : "start",
            result: d.result,
            pluginAppCallId: validPluginAppCallId(d.pluginAppCallId),
            partialResult: d.partialResult,
            isError: typeof d.isError === "boolean" ? d.isError : undefined,
            durationS: typeof d.durationS === "number" ? d.durationS : undefined,
            diff: d.diff,
            diffText: typeof d.diffText === "string" && d.diffText ? d.diffText : undefined,
          });
          if (sk === activeKeyRef.current) setMessages((prev) => applyToolStream(prev, arr, pendingThinkingRef.current.get(sk) || "", pendingPlanRef.current.get(sk) || [], displayPromptsFor(sk)));
        }
        return;
      }
      // R339/S3:OpenClaw `stream:"item"` 带服务端毫秒级起止时刻(Date.now 域)。
      // kind:"tool" 项与 stream:"tool" 共享 toolCallId;command/patch 是同一调用的
      // 衍生项(同 toolCallId),跳过防止双记。只吃 end 相(start 的时刻在 end 帧里
      // 以 startedAt 复带)。
      if (f.type === "event" && f.event === "agent" && f.payload?.stream === "item") {
        const p = f.payload || {};
        const d = p.data || {};
        const sk: string | undefined = p.sessionKey;
        if (sk && backendOfSession(sk) === "openclaw" && (p.backendId === undefined || p.backendId === "openclaw")
          && openclawPreamblesRef.current.ingest(p)) {
          observedRunBySessionRef.current.set(sk, p.runId);
          markInFlight(sk, true);
          if (sk === activeKeyRef.current) {
            setMessages(previous => decorateHistoryWithLiveState(sk, previous));
          }
        }
        if (sk && d.kind === "tool" && d.toolCallId && d.phase === "end") {
          timelineFeed(sk, {
            kind: "toolTiming",
            toolCallId: String(d.toolCallId),
            startedAt: typeof d.startedAt === "number" ? d.startedAt : undefined,
            endedAt: typeof d.endedAt === "number" ? d.endedAt : undefined,
            failed: d.status === "failed" ? true : undefined,
            error: typeof d.error === "string" && d.error ? d.error : undefined,
          });
        }
        return;
      }
      if (f.type === "event" && f.event === "session.message") {
        const sk: string | undefined = f.payload?.sessionKey;
        if (sk) {
          bumpSession(sk, Date.now()); // any session's new message floats its agent up
          // 真实「新」消息（user/assistant、非心跳噪音、且时间戳在 2 分钟内）→ 该 agent 行改为
          // 跟随这个会话。实测 gateway 会因 role-order 自愈重置/重放把旧消息再次以
          // session.message 广播（dashboard/acp/gateway-fallback 等系统会话几分钟内能把所有
          // agent 的记忆全部改写）——新鲜度门槛挡掉幻影旧消息，刚送达的真实消息（如 TG 投递
          // 镜像）原样通过。
          try {
            const nm = f.payload?.message;
            const rawTs = nm?.timestamp;
            const mts = typeof rawTs === "number" ? rawTs : typeof rawTs === "string" ? Date.parse(rawTs) || 0 : 0;
            if (nm && (nm.role === "user" || nm.role === "assistant")
              && isRealActivity(normalize({ ...nm, timestamp: mts }))) {
              advanceRealActivity(sk, mts);
            }
            if (
              nm &&
              (nm.role === "user" || nm.role === "assistant") &&
              mts >= Date.now() - 120_000 &&
              !isNoiseForPreview(normalize(nm))
            )
              rememberChosen(sk);
          } catch {
            /* 消息形状异常 → 保持当前选择 */
          }
          // A turn that errors/aborts BEFORE producing content (e.g. a model 401 / auth
          // failure, or an idle-timeout abort) is persisted to the transcript and emitted
          // here as session.message, but the gateway SKIPS its live `chat` final/error
          // broadcast for chat.send-initiated runs that have no chatLink
          // (server-chat `skipChatErrorFinal = isChatSendRunActive && !chatLink`). With no
          // final/error event, inFlightRef never clears, so the pending bubble blinks
          // forever and this handler's reload below is gated off — the error only surfaced
          // after a manual agent-switch reload. Treat such a terminal-error assistant
          // message as the missing final: drop the in-flight mark (+ watchdog) and unlock
          // the composer, so the reload fires and the persisted error bubble renders in place.
          if (sk === activeKeyRef.current && inFlightRef.current.has(sk)) {
            const m = f.payload?.message;
            if (m?.role === "assistant" && (m.errorMessage || m.stopReason === "error" || m.stopReason === "aborted")) {
              markInFlight(sk, false);
              liveToolsRef.current.delete(sk);
              replacePendingPrompts(sk, []);
              const wd = slashWatchdogRef.current.get(sk);
              if (wd) {
                clearTimeout(wd);
                slashWatchdogRef.current.delete(sk);
              }
              setSending(false);
            }
          }
          // {refresh:true}：这是一次**后台重载**，线程里已经有完整历史。不带这个标志时
          // loadHistory 的失败分支会 setMessages([])，一次 chat.history 超时就把整屏消息
          // 清空，让已有对话突然变成空白。
          // 一次重拉 = chat.history(1000) + 每条 user 消息一次 IndexedDB 查询；镜像投递的
          // 忙碌会话（TG 群）会按消息条数把它乘起来，全压在单条 loopback WS 上 → 300ms 合并
          // 一次。开火时条件可能已变（切走/新一轮开始），所以复判一遍。
          if (sk === activeKeyRef.current && !inFlightRef.current.has(sk)) {
            // 记下「窗口内真的收到过消息」的会话：窗口期间切走时，新会话由 openSession
            // 自己拉历史，这里不能替它再拉一遍（那是纯浪费的整段重取）。
            historyRefreshKeyRef.current = sk;
            // 窗口一旦开着就不重排——重排会让「消息比 300ms 更密」的忙碌会话永远等不到开火。
            if (!historyRefreshTimerRef.current) {
              historyRefreshTimerRef.current = setTimeout(() => {
                historyRefreshTimerRef.current = null;
                const k = historyRefreshKeyRef.current;
                historyRefreshKeyRef.current = null;
                // 开火时条件可能已变（切走/新一轮开始），复判后才拉。
                if (k && k === activeKeyRef.current && !inFlightRef.current.has(k)) {
                  void loadHistory(k, { refresh: true });
                }
              }, 300);
            }
          }
        }
      }
      };
      ws.onmessage = ev => { incoming = incoming.then(() => consumeMessage(ev)).catch(() => {
        nativeFrames.clear(); setError("聊天内容暂时无法恢复，请重新加载会话");
      }); };
    };
    connect();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      const currentSocket = wsRef.current;
      if (currentSocket) {
        rejectPendingRpcForSocket(pending.current, currentSocket, new Error(t("chat.connectionError")));
      }
      try {
        currentSocket?.close();
      } catch {
        /* ignore */
      }
      if (wsRef.current === currentSocket) wsRef.current = null;
      gatewayContractRef.current = null;
      subagentActivity.connect(null);
      execApprovals.connect(null);
      setGatewayContract(null);
      slashWatchdogRef.current.forEach((t) => clearTimeout(t));
      slashWatchdogRef.current.clear();
      if (historyRefreshTimerRef.current) {
        clearTimeout(historyRefreshTimerRef.current);
        historyRefreshTimerRef.current = null;
      }
      historyRefreshKeyRef.current = null;
      if (sessionBoardRefreshTimerRef.current) {
        clearTimeout(sessionBoardRefreshTimerRef.current);
        sessionBoardRefreshTimerRef.current = null;
      }
    };
  }, [
    send,
    loadHistory,
    refreshSessions,
    bumpSession,
    advanceRealActivity,
    rememberChosen,
    chatHistoryController,
    clearOpenClawProgressCard,
    refreshOpenClawProgressCard,
    renderLiveStateForSession,
    execApprovals,
    replacePendingPrompts,
    verifyPendingTrackedSends,
  ]);

  // A new negotiated connection or a session switch restores only capabilities
  // the 8.1 hello actually advertised. Both calls use the ordinary request-id
  // map, so disconnects reject promptly and late responses cannot cross sockets.
  useEffect(() => {
    if (!activeKey || !gatewayContract) return;
    void execApprovals.refresh();
    if (gatewaySupportsQuestions(gatewayContract)) {
      void recoverOpenClawQuestions(activeKey);
    }
    if (gatewaySupportsProgressCards(gatewayContract)) {
      void refreshOpenClawProgressCard(activeKey);
    }
  }, [activeKey, gatewayContract, execApprovals, recoverOpenClawQuestions, refreshOpenClawProgressCard]);

  // Keep the latest draft text in a ref so openSession can stash it per session
  // without making the (stable) callback depend on `input`.
  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  // Scroll orchestration. Session switch → jump instantly to the bottom before
  // paint (no top→bottom slide). My own send → ONE deliberate reposition: park the
  // sent bubble at the top and open the stream spacer below (see sizeStreamSpacer),
  // then stay anchored — streaming deltas never move the viewport; the user scrolls
  // the overflow themselves (R280, was: stick-to-bottom on every delta, which kept
  // yanking unread content up). Otherwise (no anchor) keep the messenger behavior:
  // auto-stick only when already near the bottom.
  const updateJumpVisibility = useCallback(() => {
    const thread = threadRef.current;
    const parts = latestMessagePartsRef.current;
    if (!thread?.clientHeight || !parts.length) {
      setShowJump(false);
      return;
    }
    const viewport = thread.getBoundingClientRect();
    const style = getComputedStyle(thread);
    const header = thread.parentElement?.querySelector(".chat-topdock")?.getBoundingClientRect();
    const composer = (thread.parentElement?.querySelector("[data-chat-plan-dock]")
      ?? thread.parentElement?.querySelector(".chat-composer"))?.getBoundingClientRect();
    // The thread extends behind the floating docks. Fully masked/covered
    // content does not count, but even one visible pixel of a long reply does.
    const top = Math.max(viewport.top + (parseFloat(style.getPropertyValue("--chat-fade-top")) || 0), header?.bottom ?? viewport.top);
    const bottom = Math.min(viewport.bottom - (parseFloat(style.getPropertyValue("--chat-fade-bottom")) || 0), composer?.top ?? viewport.bottom);
    const visible = parts.some((part) => {
      const rect = part.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > top && rect.top < bottom
        && rect.right > viewport.left && rect.left < viewport.right;
    });
    // An older search window does not contain the actual latest message.
    setShowJump(!visible || searchHistoryWindowKeyRef.current === activeKeyRef.current);
  }, []);
  const settledKeyRef = useRef<string | null>(null);
  const initialScrollFrameRef = useRef<number | null>(null);
  const cancelInitialScroll = useCallback(() => {
    unreadScrollCleanupRef.current?.(); unreadScrollCleanupRef.current = null;
    if (initialScrollFrameRef.current != null) cancelAnimationFrame(initialScrollFrameRef.current);
    initialScrollFrameRef.current = null;
  }, []);
  useEffect(() => cancelInitialScroll, [cancelInitialScroll]);

  const capturePrependAnchor = useCallback(() => {
    const thread = threadRef.current;
    const bounds = thread?.getBoundingClientRect();
    const node = thread && bounds ? Array.from(thread.querySelectorAll<HTMLElement>(".chat-bubble")).find(bubble => {
      const rect = bubble.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom;
    }) : undefined;
    const messageNode = node?.closest<HTMLElement>("[data-message-key]");
    prependAnchorRef.current = {
      height: thread?.scrollHeight ?? 0, node, top: node?.getBoundingClientRect().top,
      messageKey: messageNode?.dataset.messageKey,
      bubbleIndex: node && messageNode ? Array.from(messageNode.querySelectorAll(".chat-bubble")).indexOf(node) : undefined,
    };
  }, []);

  const loadEarlierHistory = useCallback(async () => {
    const state = earlierHistoryRef.current;
    const key = activeKeyRef.current;
    if (!key || state.key !== key || !state.cursor || state.loading) return;
    const loading = { ...state, loading: true, error: false };
    earlierHistoryRef.current = loading; setEarlierHistory(loading);
    const previous = historyPager.current;
    let raw: unknown[] | undefined;
    try {
      raw = await historyPager.earlier(key);
      const anchor = previous?.messages[0];
      const sameSource = previous?.sourceId === historyPager.sourceOf(raw);
      const index = sameSource && anchor ? raw.findIndex(message => rawHistoryId(message) === rawHistoryId(anchor)) : -1;
      const prepared = await prepareHistoryMessages(key, index >= 0 ? raw.slice(0, index) : raw);
      if (activeKeyRef.current !== key || earlierHistoryRef.current !== loading || !historyPager.commit(raw)) return;
      if (!unreadLandingRef.current?.pending) capturePrependAnchor();
      cancelInitialScroll(); atBottomRef.current = false;
      if (!sameSource) clearArchiveForSource(key);
      if (index < 0) commitCanonicalHistory(key, prepared);
      else {
        // Prepend only: preserve prompts, deltas and optimistic user bubbles
        // that arrived while the older page was being fetched/prepared.
        const at = archivePrefixRef.current.key === key ? archivePrefixRef.current.msgs.length : 0;
        const current = messagesRef.current;
        const visible = [...current.slice(0, at), ...prepared, ...current.slice(at)];
        messagesRef.current = visible; setMessages(visible);
      }
      const next = { key, cursor: historyPager.hasMore ? historyPager.current!.token : null, loading: false, error: false };
      earlierHistoryRef.current = next; setEarlierHistory(next);
    } catch {
      if (activeKeyRef.current === key && earlierHistoryRef.current === loading) {
        const failed = { ...state, loading: false, error: true };
        earlierHistoryRef.current = failed; setEarlierHistory(failed);
      }
    } finally {
      if (raw) historyPager.release(raw);
      if (earlierHistoryRef.current === loading) {
        const settled = { ...state, loading: false };
        earlierHistoryRef.current = settled; setEarlierHistory(settled);
      }
    }
  }, [cancelInitialScroll, capturePrependAnchor, clearArchiveForSource, commitCanonicalHistory, historyPager, prepareHistoryMessages]);

  useLayoutEffect(() => {
    const el = threadRef.current;
    const landing = unreadLandingRef.current;
    if (landing?.key === activeKey && landing.pending) {
      // Cached paint is provisional. Wait for canonical history and, when needed,
      // page back to the read boundary before choosing the first unread reply.
      if (!historyLoaded) return;
      const replies = keyedChatMessages(messages).filter(({ item, key }) =>
        isUnreadReply(activeKey, item) && !hiddenIds.has(item.id || `local:${key}`));
      const first = replies.find(({ item }) => (item.ts ?? 0) > landing.after);
      const boundaryLoaded = replies.some(({ item }) => (item.ts ?? 0) <= landing.after);
      if (first && !boundaryLoaded && earlierHistory.key === activeKey && earlierHistory.cursor) {
        if (!earlierHistory.loading && !earlierHistory.error) void loadEarlierHistory();
        return;
      }
      const replyId = first ? first.item.id || `local:${first.key}` : null;
      const id = replyId && showTraj ? turnStartByMessageRef.current.get(replyId) || replyId : replyId;
      landing.pending = false;
      setUnreadAnchor({ key: activeKey, messageId: id, pending: false });
      if (id) {
        cancelInitialScroll();
        sendAnchorRef.current = false; anchoredRef.current = false; atBottomRef.current = false;
        if (streamSpacerRef.current) streamSpacerRef.current.style.height = "0px";
        settledKeyRef.current = activeKey;
        const owner = el?.querySelector(`[data-chat-message-id="${CSS.escape(id)}"]`);
        const reply = replyId ? el?.querySelector(`[data-chat-message-id="${CSS.escape(replyId)}"]`) : null;
        const node = owner?.querySelector<HTMLElement>("[data-chat-process]")
          ?? owner?.querySelector<HTMLElement>(".chat-bubble, .chat-att-row")
          ?? reply?.querySelector<HTMLElement>(".chat-bubble, .chat-att-row");
        if (el && node) unreadScrollCleanupRef.current = anchorUnreadMessage(el, node);
        return;
      }
    }
    // Archive prepend: older messages were inserted ABOVE, so hold the previously
    // visible bubble in place. Total height is not a reliable anchor when
    // offscreen bubbles have estimated sizes or native scroll anchoring ran.
    if (prependAnchorRef.current != null && el) {
      cancelInitialScroll();
      const anchor = prependAnchorRef.current;
      prependAnchorRef.current = null;
      // Prepending the same role can rebuild the first group. Recover its
      // message by stable key instead of measuring the detached old node.
      const node = anchor.node?.isConnected ? anchor.node : anchor.messageKey
        ? el.querySelector(`[data-message-key="${CSS.escape(anchor.messageKey)}"]`)
          ?.querySelectorAll<HTMLElement>(".chat-bubble")[anchor.bubbleIndex ?? 0]
        : undefined;
      if (node && anchor.top != null) {
        const top = anchor.top;
        const restore = () => {
          const offset = node.getBoundingClientRect().top - top;
          if (Math.abs(offset) > 1) el.scrollTop += offset;
          return Math.abs(offset) <= 1;
        };
        restore();
        let attempts = 0;
        let stableFrames = 0;
        const settle = () => {
          initialScrollFrameRef.current = null;
          if (activeKeyRef.current !== activeKey || !node.isConnected || !el.clientHeight) return;
          stableFrames = restore() ? stableFrames + 1 : 0;
          if (++attempts < 8 && stableFrames < 2) initialScrollFrameRef.current = requestAnimationFrame(settle);
        };
        initialScrollFrameRef.current = requestAnimationFrame(settle);
      } else {
        el.scrollTop += el.scrollHeight - anchor.height;
      }
      return;
    }
    const initialLoad = settledKeyRef.current !== activeKey;
    if (initialLoad && messages.length > 0) settledKeyRef.current = activeKey;
    const spacer = streamSpacerRef.current;
    // fresh measure every pass — the thread gets rebuilt mid-turn (reload-on-final,
    // archive re-paste), so nothing about the anchor is cached across passes
    const lastUserBubble = () => {
      const bubbles = el ? el.querySelectorAll<HTMLElement>(".chat-group.is-user") : [];
      return bubbles[bubbles.length - 1];
    };
    const topOf = (bubble: HTMLElement) =>
      bubble.getBoundingClientRect().top - el!.getBoundingClientRect().top + el!.scrollTop;
    if (initialLoad) {
      cancelInitialScroll();
      // the anchor belongs to the previous thread — drop it with its spacer
      sendAnchorRef.current = false;
      anchoredRef.current = false;
      if (spacer) spacer.style.height = "0px";
    } else if (sendAnchorRef.current && el && spacer) {
      cancelInitialScroll();
      sendAnchorRef.current = false;
      const sent = lastUserBubble();
      if (sent) {
        anchoredRef.current = true;
        el.scrollTop = sizeStreamSpacer(el, spacer, topOf(sent));
        atBottomRef.current = true; // the anchor IS the (spacer-extended) max scroll
        return;
      }
      // filtered thread (search/pinned-only) may hide the sent bubble — fall back
      // to the pre-R280 "my send reveals itself" stick below
      atBottomRef.current = true;
    }
    // Anchored mode: keep the spacer absorbing the growing reply (scrollHeight
    // holds still → zero viewport motion) and never auto-stick; late messages eat
    // the reserved blank first.
    // scrollTop is deliberately NOT touched here — the browser's own scroll
    // anchoring keeps the visible content stable through thread rebuilds.
    if (anchoredRef.current && el && spacer) {
      const sent = lastUserBubble();
      if (sent) {
        sizeStreamSpacer(el, spacer, topOf(sent));
        const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        atBottomRef.current = near;
        return;
      }
      // anchor bubble gone (filtered/cleared) → leave anchored mode
      anchoredRef.current = false;
      spacer.style.height = "0px";
    }
    if (!initialLoad && stoppedScrollKeyRef.current === activeKey) return;
    if (initialLoad || atBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: initialLoad ? "auto" : "smooth" });
      atBottomRef.current = true;
      if (initialLoad && el) {
        // content-visibility resolves the newly visible tail after the first
        // layout. Re-anchor until two frames agree (bounded); never fight user
        // input, a search/pin jump, a session switch or an unmounted thread.
        let attempts = 0;
        let stableFrames = 0;
        const settle = () => {
          initialScrollFrameRef.current = null;
          if (activeKeyRef.current !== activeKey || !el.isConnected || !el.clientHeight) return;
          const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
          stableFrames = Math.abs(gap) <= 1 ? stableFrames + 1 : 0;
          if (stableFrames === 0) el.scrollTop = el.scrollHeight;
          atBottomRef.current = true;
          if (++attempts < 8 && stableFrames < 2) initialScrollFrameRef.current = requestAnimationFrame(settle);
        };
        initialScrollFrameRef.current = requestAnimationFrame(settle);
      }
    }
  }, [messages, activeKey, historyLoaded, earlierHistory, hiddenIds, loadEarlierHistory, cancelInitialScroll, showTraj]);

  // Track whether the thread is near its bottom (drives auto-scroll only).
  // Scroll-up loads the sealed/reset archive (no button): when the user reaches the
  // top of a settled OpenClaw thread, fetch it once. Found → prepend; none → a note.
  // Gated by status (idle/error only) + a sync ref so a scroll burst fires it once.
  const maybeLoadArchive = () => {
    const key = activeKeyRef.current;
    if (!key || backendOfSession(key) !== "openclaw") return;
    // Initial-load gate. NOT settledKeyRef — that ref is only written for
    // sessions with ≥1 message, so a wiped/phantom (0-message) session — the
    // exact case the explicit entry button exists for — would never pass it.
    if (!historyLoaded) return;
    if (archiveLoadingRef.current) return;
    if (archive.key === key && archive.status !== "idle" && archive.status !== "error"
      && !(archive.status === "loaded" && archive.hasMore)) return;
    archiveLoadingRef.current = true;
    const generation = archiveGenerationRef.current;
    void loadArchive().finally(() => {
      if (generation === archiveGenerationRef.current) archiveLoadingRef.current = false;
    });
  };

  // 短尾 reset 会话无需用户先上滑就恢复旧历史。只在 idle 自动尝试一次；失败后保留
  // 既有滚轮上滑重试入口，避免临时网络错误触发无限请求循环。
  useEffect(() => {
    if (!historyLoaded || messages.length >= AUTO_ARCHIVE_MESSAGE_LIMIT || archive.status !== "idle") return;
    maybeLoadArchive();
  }, [activeKey, archive.status, historyLoaded, messages.length]);

  const onThreadScroll = () => {
    const el = threadRef.current;
    if (!el) return;
    updateJumpVisibility();
    if (initialScrollFrameRef.current != null) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottomRef.current = near;
  };
  // Archive load fires on WHEEL (genuine user "scroll up"), NOT on the scroll event:
  // switching a tall→short thread clamps scrollTop to 0 and fires a spurious scroll,
  // which would auto-load on open. Wheel only fires on real input, so it cleanly means
  // "the user pulled up". Works for short (non-overflowing) threads too — they emit no
  // scroll event but still emit wheel. Triggers near the top while pulling upward.
  const onThreadWheel = (e: WheelEvent<HTMLDivElement>) => {
    cancelInitialScroll();
    stoppedScrollKeyRef.current = null;
    const el = threadRef.current;
    if (el && e.deltaY < 0 && el.scrollTop < 60) maybeLoadArchive();
  };
  const jumpToLatest = () => {
    cancelInitialScroll();
    stoppedScrollKeyRef.current = null;
    // explicit "take me down" = opt back OUT of the send-anchor mode: close the
    // standing room first so the jump lands on real content, not reserved blank,
    // and let the classic stick-to-bottom resume for whatever streams next (R280)
    anchoredRef.current = false;
    if (streamSpacerRef.current) streamSpacerRef.current.style.height = "0px";
    atBottomRef.current = true;
    setShowJump(false);
    const key = activeKeyRef.current;
    if (key && searchHistoryWindowKeyRef.current === key) {
      searchHistoryWindowKeyRef.current = null;
      setArchive({ key, status: "idle" });
      void loadHistory(key);
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  // Probe live backend connectivity (same /__api/status the 设置 page uses) so the
  // agent list can hide agents whose backend is offline — the list is built from
  // caches (localStorage sessions + the proxy's injected Hermes rows) that don't
  // notice a backend going away. Re-probe on mount + window refocus (catches a
  // gateway fixed/dropped while away). A failed probe keeps the prior set rather
  // than blanking the list.
  useEffect(() => {
    let cancelled = false;
    let statusSequence = 0;
    // A backend that is starting, busy or lost is re-probed every 3s for up to
    // 2 minutes, so its recovery shows at once; otherwise every 15s.
    let unsettledSince: number | null = null;
    const markSettled = (settled: boolean) => {
      if (settled) unsettledSince = null;
      else unsettledSince ??= Date.now();
    };
    const refreshStatus = async () => {
      const sequence = ++statusSequence;
      try {
        const r = await fetch("/__api/status");
        if (!r.ok) { markSettled(false); return; }
        const d = await r.json();
        if (!Array.isArray(d?.backends)) return;
        const rows: { id?: string; connected?: boolean; disabled?: boolean; info?: { starting?: boolean; busy?: boolean; readyAgentIds?: string[]; recoveryCode?: string } }[] =
          Array.isArray(d?.backends) ? d.backends : [];
        markSettled(rows.every((b) => !b?.id || b.disabled === true || (b.connected === true && b.info?.busy !== true)));
        const set = new Set(rows.filter((b) => b?.connected && b.id).map((b) => b.id as string));
        const starting = new Set(
          rows.filter((b) => !b?.connected && b?.info?.starting && b.id).map((b) => b.id as string),
        );
        const ready = new Set(rows.flatMap((b) => Array.isArray(b.info?.readyAgentIds) ? b.info.readyAgentIds : []));
        if (!cancelled && sequence === statusSequence) {
          for (const b of rows) {
            if (!b?.id) continue;
            if (b.disabled === true) connectedOnceBackendsRef.current.delete(b.id);
            else if (b.connected === true) connectedOnceBackendsRef.current.add(b.id);
          }
          setConnectedBackends(set);
          setStartingBackends(starting);
          setRecoveryBackends(current => {
            const next = new Set(current);
            for (const b of rows) {
              if (!b?.id) continue;
              if (!b.connected && b.info?.recoveryCode === "SERVICE_RECOVERY_REQUIRED") next.add(b.id);
              else if (b.connected === true || b.disabled === true) next.delete(b.id);
            }
            return next;
          });
          setReadyAgentIds(ready);
        }
      } catch {
        /* offline / fetch failed → keep prior set */
        markSettled(false);
      }
    };
    void refreshStatus();
    // 后端就绪广播（agents.changed）要能就地复查状态，否则一个刚启动完的后端要
    // 等下一个 15s tick 才从 starting 转 connected——行可见但一直灰着。
    refreshStatusRef.current = refreshStatus;
    // Light periodic re-probe so the "offline" dot flips reasonably fast even while
    // focused (focus/visibility events alone miss a backend dropping mid-session).
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (cancelled) return;
      const fast = unsettledSince !== null && Date.now() - unsettledSince < 120_000;
      timer = setTimeout(() => { void refreshStatus().finally(schedule); }, fast ? 3000 : 15000);
    };
    schedule();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshStatus();
    };
    window.addEventListener("focus", refreshStatus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      refreshStatusRef.current = null;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", refreshStatus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [chatBackendScopeKey]);

  useEffect(() => {
    void chatHistoryController.revalidateReady(readyAgentIds);
  }, [chatHistoryController, readyAgentIds]);

  useEffect(() => {
    if (!connectedBackends) return;
    void chatHistoryController.revalidateConnected(connectedBackends);
  }, [chatHistoryController, connectedBackends]);

  const sendCanvasWidgetPrompt = useCallback((ownerSessionKey: string, text: string) => {
    if (activeKeyRef.current !== ownerSessionKey) return;
    sendControllerRef.current.widget(ownerSessionKey, () => {
      void sendChatMessageRef.current?.(text, []);
    });
  }, []);

  // Legacy previews retain their owning external session. Native HTML uses the
  // persistent isolated card host; a late old frame cannot target a new chat.
  useEffect(() => {
    installHtmlArtifacts();
    const key = activeKey;
    const descriptor = key ? chatBackendDescriptors.get(backendOfSession(key)) : undefined;
    const allowed = !!key && !!descriptor && descriptor.surfaces.agentHarness !== true;
    setHtmlArtifactScope(allowed ? key : null);
    setSendPromptHandler(allowed ? (text, scope) => {
      if (scope !== key || activeKeyRef.current !== key) return;
      const sendController = sendControllerRef.current;
      sendController.widget(key, () => { void sendChatMessageRef.current?.(text, []); });
    } : null);
    return () => { setSendPromptHandler(null); setHtmlArtifactScope(null); };
  }, [activeKey, chatBackendDescriptors]);

  // Delegated handler for the code-block copy buttons emitted by markdown.ts.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement)?.closest?.(".code-block-copy") as HTMLElement | null;
      if (!btn) return;
      const ta = document.createElement("textarea"); // un-escape the HTML-escaped data-code
      ta.innerHTML = btn.getAttribute("data-code") || "";
      navigator.clipboard?.writeText(ta.value).catch(() => {});
      btn.classList.add("copied");
      setTimeout(() => btn.classList.remove("copied"), 1500);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  const activeModelsBackend = activeKey ? backendOfSession(activeKey) : "";
  const activeModelsAgentId = activeKey
    ? agentOf(activeKey)
    : "";

  // OpenClaw 官方聊天面读取当前 agent 的 configured catalog；管理页才读取全量 all。
  // 其它后端继续消费 backend-scoped revision store，保持既有模型目录与缓存语义。
  useEffect(() => {
    if (!activeModelsBackend || usesRuntimeModelPicker) return;
    const backend = activeModelsBackend;
    let active = true;
    setModelsError(false);

    if (backend === "openclaw") {
      const agentId = activeModelsAgentId;
      if (!agentId) return;
      const cached = openClawModelCacheRef.current.get(agentId);
      modelsBackendRef.current = backend;
      setModels(cached || []);
      setModelsLoading(!cached);
      let requestGeneration = 0;
      const refreshModels = async () => {
        const generation = ++requestGeneration;
        const result = await send("models.list", { view: "configured", agentId });
        if (!active || generation !== requestGeneration) return;
        const next = openClawChatModels(result?.payload?.models);
        openClawModelCacheRef.current.set(agentId, next);
        setModels(next);
        setModelsLoading(false);
      };
      refreshActiveModelsRef.current = refreshModels;
      // 管理目录的 revision 只使当前 agent 快照失效；不能把 all 目录写进聊天菜单。
      const unsubscribe = subscribeModelCatalog(backend, (snapshot) => {
        if (!active || !connected || snapshot.backendId !== backend || snapshot.legacyPlaceholder) return;
        void refreshModels().catch(() => {});
      });
      // 瞬时失败保留当前 agent 快照；没有快照时继续显示既有 loading 状态。
      if (connected) void refreshModels().catch(() => {});
      return () => {
        active = false;
        unsubscribe();
        if (refreshActiveModelsRef.current === refreshModels) refreshActiveModelsRef.current = null;
      };
    }

    const cached = readModelCatalog(backend);
    if (modelsBackendRef.current !== backend) {
      setModels(cached?.models || []);
      modelsBackendRef.current = backend;
    }
    const hasVerified = !!cached && !cached.legacyPlaceholder;
    setModelsLoading(!hasVerified);
    const unsubscribe = subscribeModelCatalog(backend, (snapshot) => {
      if (!active || snapshot.backendId !== backend || snapshot.legacyPlaceholder) return;
      setModels(snapshot.models);
      setModelsLoading(false);
      setModelsError(false);
    });
    const refresh = createModelCatalogRefresh({
      load: async () => {
        const snapshot = await revalidateModelCatalog(
          backend,
          (knownRevision) => getModelCatalog(backend, knownRevision),
        );
        if (!active || snapshot.backendId !== backend || snapshot.legacyPlaceholder) return;
        setModels(snapshot.models);
      },
      onState: ({ loading, error }) => {
        if (!active) return;
        setModelsLoading(loading);
        setModelsError(error);
      },
    });
    const refreshModels = refresh.refresh;
    refreshActiveModelsRef.current = refreshModels;
    // 失败保留已有目录，显示可重试状态；冷启动失败只做两次自动重试。
    void refreshModels().catch(() => {});
    return () => {
      active = false;
      refresh.dispose();
      unsubscribe();
      if (refreshActiveModelsRef.current === refreshModels) refreshActiveModelsRef.current = null;
    };
  }, [activeModelsAgentId, activeModelsBackend, usesRuntimeModelPicker, connected, send]);

  const sessionOpenIntentRef = useRef(0);
  const openSession = useCallback((key: string) => {
    sessionOpenIntentRef.current += 1;
    if (!isVisibleSession(sessionsRef.current.find(row => row.key === key) || { key })) return Promise.resolve();
    if (pendingSearchJumpKeyRef.current && pendingSearchJumpKeyRef.current !== key) {
      searchJumpTokenRef.current += 1;
      pendingSearchJumpKeyRef.current = null;
      searchJumpRequestTokenRef.current = null;
      setPendingSearchJump(null);
      setSearchTargetGroupKey(null);
    }
    if (searchHistoryWindowKeyRef.current && searchHistoryWindowKeyRef.current !== key) {
      searchHistoryWindowKeyRef.current = null;
    }
    // Hermes 手动切换先保持旧线程稳定，等目标缓存读取完成后再一次性提交 active+messages。
    const opening = chatHistoryController.open(key);
    void opening.then(() => {
      if (activeKeyRef.current === key && inFlightRef.current.has(key)) {
        setMessages((prev) =>
          prev.some((m) => m.pending)
            ? prev
            : [...prev, { role: "assistant", parts: [{ type: "text", text: "" }], pending: true }],
        );
      }
    });
    return opening;
  }, [chatHistoryController]);

  // 会话深链 #/chat?session=<key>（工作板「打开会话」/官方 onOpenSession 语义）。
  // ChatPage 是保活常驻页（App.tsx 只挂一次且在 Router 内），react-router 的跳转走
  // History API 不触发 hashchange，所以用 useLocation 接路由变化；消费后立刻
  // replace 清掉查询串，避免刷新/回退重复触发。
  const openSessionDeepRef = useRef(openSession);
  openSessionDeepRef.current = openSession;
  const deepLinkDepsRef = useRef({ ensureSessionRow, refreshSessions });
  deepLinkDepsRef.current = { ensureSessionRow, refreshSessions };
  const handledSessionLocationRef = useRef<string | null>(null);
  const routerNavigate = useNavigate();
  const browsePlugins = useCallback((installationId?: string) => {
    routerNavigate(installationId
      ? `/plugins?installationId=${encodeURIComponent(installationId)}` : "/plugins");
  }, [routerNavigate]);
  useEffect(() => {
    if (!shouldRefreshChatAvatars(routerLocation.pathname)) return;
    setAvatarVersion(Date.now());
    // ChatPage is kept alive while management routes unmount. Re-entering Chat
    // after an Agent rename must therefore refresh the roster explicitly.
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      void deepLinkDepsRef.current.refreshSessions().catch(() => {});
    }
  }, [routerLocation.key, routerLocation.pathname]);
  useEffect(() => {
    if (routerLocation.pathname !== "/chat") return;
    const params = new URLSearchParams(routerLocation.search);
    const key = params.get("session");
    const rawDeepLinkBackend = params.get("backend")?.trim() || "";
    const deepLinkBackend = rawDeepLinkBackend;
    if (!key) return;
    if ((deepLinkBackend || backendOfSession(key)) === "shoggoth" && !connected) return;
    // StrictMode 会重放同一 location 的 effect；ref 在首次执行中同步落闸，避免第二次
    // openSession 清掉刚设置的 quote。新导航即便 URL 相同也有新的 location.key。
    const locationIdentity = `${routerLocation.key}:${routerLocation.search}`;
    if (handledSessionLocationRef.current === locationIdentity) return;
    handledSessionLocationRef.current = locationIdentity;
    const handoff = consumeCronChatHandoff(rawDeepLinkBackend || backendOfSession(key), key)
      || (deepLinkBackend !== rawDeepLinkBackend ? consumeCronChatHandoff(deepLinkBackend, key) : null);
    routerNavigate("/chat", { replace: true });
    // 深链多半指向**刚刚**建出来的会话（工作板点「运行」→ 后端在网关新建 per-card
    // subagent 会话 → 立刻跳过来），它还不在 sessions 里。而面板挂在
    // `active = sessions.find(key)` 上，找不到就整个不渲染 =「选择左侧一个会话开始」。
    // sessions 又只在 WS onopen / agents.changed / 手动刷新时才整体重拉，不会自己收录
    // 新会话 —— 于是空白一直挂着。先补一条合成行让面板立刻可用（与通知点击入口同一套
    // 兜底），再拉一次真列表把合成行换成真行（mergeSynthetic 会自动清理合成副本）。
    const { ensureSessionRow: ensure, refreshSessions: refreshList } = deepLinkDepsRef.current;
    const openLink = (seed?: SessionRow) => openChatSessionLink(key, {
      ensureSession: () => ensure(key, undefined, seed || (deepLinkBackend ? { backendId: deepLinkBackend } : undefined)),
      openSession: (targetKey) => openSessionDeepRef.current(targetKey),
      refreshSessions: refreshList,
      isCurrent: () => handledSessionLocationRef.current === locationIdentity && activeKeyRef.current === key,
      onOpened: () => {
        if (!handoff) return;
        setQuote({ key, text: handoff.report });
        window.setTimeout(() => {
          if (activeKeyRef.current === key) composerRef.current?.focus();
        }, 60);
      },
      onError: (error) => setError(error instanceof Error ? error.message : String(error)),
    });
    const known = sessionsRef.current.find(row => row.key === key);
    if (!isVisibleSession(known || { key })) return;
    if (!known && (deepLinkBackend || backendOfSession(key)) === "shoggoth") {
      // Check source before creating a placeholder: automatic selection and
      // preview probes must never treat an undiscovered Desktop link as App.
      const openIntent = sessionOpenIntentRef.current;
      void fetchAllSessions().then(snapshot => {
        if (handledSessionLocationRef.current !== locationIdentity || sessionOpenIntentRef.current !== openIntent) return;
        const row = snapshot.rows.find(session => session.key === key);
        if (isVisibleSession(row)) void openLink(row);
      }).catch(error => {
        if (handledSessionLocationRef.current === locationIdentity && sessionOpenIntentRef.current === openIntent) setError(error instanceof Error ? error.message : String(error));
      });
    } else void openLink();
  }, [routerLocation, routerNavigate, connected]);

  // 沉浸激活且位于聊天路由时给 <body> 打 data-immersive——styles.css 靠它把左侧
  // 导航抬到覆盖层之上并换暗玻璃底（Figma：沉浸模式导航栏保持可见可点）。
  // pathname 守卫 + cleanup 双保险：沉浸中切去别的页面、退出沉浸、组件卸载都必须
  // 摘掉标记，否则其它页面的侧栏会一直挂着沉浸配色。路由条件与 App.tsx 的 onChat
  // 同口径（/chat 与 /）。
  useEffect(() => {
    const onChatRoute = routerLocation.pathname === "/chat" || routerLocation.pathname === "/";
    if (immersive && onChatRoute) document.body.dataset.immersive = "1";
    else delete document.body.dataset.immersive;
    return () => {
      delete document.body.dataset.immersive;
    };
  }, [immersive, routerLocation.pathname]);

  // Load the active session's sealed/reset archive (older physical transcripts the
  // gateway rotated out on role-ordering-conflict resets — see the management-plane
  // /__api/sessions/archive route) and PREPEND it above the live thread, each
  // segment introduced by a reset divider. On-demand (keeps first paint fast);
  // OpenClaw + local gateway only (the backend reads its on-disk session store).
  const loadArchive = useCallback(async () => {
    const key = activeKeyRef.current;
    if (!key) return;
    const generation = archiveGenerationRef.current;
    const agent = agentOf(key);
    if (backendOfKnownAgent(agent) !== "openclaw") {
      setArchive({ key, status: "unsupported" });
      return;
    }
    setArchive({ key, status: "loading" });
    try {
      let pages = archivePagesRef.current;
      if (!pages || pages.key !== key) {
        const q = new URLSearchParams({ backend: "openclaw", agentId: agent, key });
        const r = await fetch(`/__api/sessions/archive?${q.toString()}`);
        const data = (await r.json()) as {
          archive?: { supported: boolean; reason?: string; segments: Array<{ sealedAt: number | null; fromReset: boolean; truncated?: boolean; messages: unknown[] }> };
        };
        if (activeKeyRef.current !== key || generation !== archiveGenerationRef.current) return;
        const arc = data.archive;
        if (!r.ok || !arc) throw new Error("archive unavailable");
        if (!arc.supported) {
          setArchive({ key, status: "unsupported", error: arc.reason });
          return;
        }
        if (!arc.segments.length) {
          setArchive({ key, status: "empty" });
          return;
        }
        const raw = arc.segments.flatMap(seg => [
          { role: "system", __archiveDivider: { sealedAt: seg.sealedAt, fromReset: seg.fromReset, truncated: seg.truncated } },
          ...seg.messages,
        ]);
        pages = { key, raw, start: raw.length };
      }
      let start = chatHistoryWindow(pages.raw.slice(0, pages.start), CHAT_HISTORY_PAGE_SIZE, key).start;
      if (!chatHistoryWindow(pages.raw.slice(0, start), 1, key).count) start = 0;
      const selected = pages.raw.slice(start);
      // A partial archive page still identifies the physical reset segment.
      const divider = pages.raw.slice(0, start).reverse().find(row => row.__archiveDivider);
      if (divider && !selected[0]?.__archiveDivider) selected.unshift(divider);
      const prepend = await prepareHistoryMessages(key, selected);
      if (activeKeyRef.current !== key || generation !== archiveGenerationRef.current) return;
      capturePrependAnchor();
      const previousLength = archivePrefixRef.current.key === key ? archivePrefixRef.current.msgs.length : 0;
      archivePagesRef.current = { ...pages, start };
      archivePrefixRef.current = { key, msgs: prepend }; // 供后续 loadHistory 刷新后贴回
      const visible = [...prepend, ...messagesRef.current.slice(previousLength)];
      messagesRef.current = visible; setMessages(visible);
      setArchive({ key, status: "loaded", count: chatHistoryWindow(selected, 1, key).count, hasMore: start > 0 });
    } catch (e) {
      if (activeKeyRef.current === key && generation === archiveGenerationRef.current) setArchive({ key, status: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }, [capturePrependAnchor, prepareHistoryMessages]);

  // Inject a local (client-generated) info/result message — used to render slash
  // command output that OpenClaw handles client-side (its gateway sends no echo).
  const pushLocal = (text: string) =>
    setMessages((prev) => [
      ...prev,
      { role: "system", local: true, parts: [{ type: "text", text }], ts: Date.now() },
    ]);

  const helpText = (commands: SlashCommand[]) =>
    `**${t("chat.availableCommands")}**\n` +
    commands.map((c) => `- \`/${c.name}${c.args ? " " + c.args : ""}\` — ${translateSlashDescription(c.description, t)}`).join("\n");

  const formatPayloadSize = (bytes: number) => bytes < 1024 * 1024
    ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  const maxPayloadForSession = (key: string) => {
    const caps = capabilitiesForSession(key);
    return (caps?.gatewayPolicy ? gatewayContractRef.current?.policy.maxPayload : undefined)
      ?? caps?.maxPayloadBytes;
  };
  const inspectChatSendPayload = (key: string, text: string, atts: readonly ChatAttachment[],
    pluginSelection?: readonly ChatPluginSelection[]) => {
    const maxPromptBytes = capabilitiesForSession(key)?.maxPromptBytes;
    const promptBytes = new TextEncoder().encode(JSON.stringify(text)).byteLength;
    if (maxPromptBytes && promptBytes > maxPromptBytes) {
      return { allowed: false, payloadBytes: promptBytes, maxPayload: maxPromptBytes };
    }
    return gatewayRequestPayloadBudget(
      String(reqId.current),
      "chat.send",
      buildChatSendParams(key, text, CHAT_SEND_IDEMPOTENCY_SAMPLE, atts, pluginSelection),
      maxPayloadForSession(key),
    );
  };
  const inspectChatSteerPayload = (key: string, text: string) => {
    const maxPromptBytes = capabilitiesForSession(key)?.maxPromptBytes;
    const promptBytes = new TextEncoder().encode(JSON.stringify(text)).byteLength;
    if (maxPromptBytes && promptBytes > maxPromptBytes) {
      return { allowed: false, payloadBytes: promptBytes, maxPayload: maxPromptBytes };
    }
    return gatewayRequestPayloadBudget(
      String(reqId.current),
      "chat.steer",
      { sessionKey: key, message: text },
      maxPayloadForSession(key),
    );
  };
  const showPayloadLimit = (translationKey: string, payloadBytes: number, maxPayload?: number) => {
    setToast({
      text: t(translationKey, {
        size: formatPayloadSize(payloadBytes),
        limit: formatPayloadSize(maxPayload ?? 0),
      }),
      kind: "error",
    });
    setTimeout(() => setToast(null), 4200);
  };

  // Send text (+ optional attachments) as a chat message via chat.send. `isSlash`
  // arms a watchdog so a command the backend silently ignores can't wedge the
  // composer in the "sending" state forever (a `chat` event for the session cancels it).
  const sendChatMessage = async (
    text: string,
    atts: ChatAttachment[],
    isSlash = false,
    displayText = text,
    pluginSelection?: ChatPluginSelection[],
    pluginGeneration?: number,
  ) => {
    const key = activeKeyRef.current;
    // 防御性门禁：即使某个新入口绕过 submit，也不能在 Hermes profile 尚未 ready
    // 时制造 RPC、乐观气泡或缓存写入。
    if (!key || !sendController.canSend(key) || inFlightRef.current.has(key)
      || hasPendingTrackedSend(key)) return;
    const originalBackend = backendOfSession(key);
    const trackedSend = shouldTrackChatSend(originalBackend, pluginSelection);
    const inputBudget = inspectChatSendPayload(key, text, atts, pluginSelection);
    if (!inputBudget.allowed) {
      showPayloadLimit("chat.sendPayloadTooLarge", inputBudget.payloadBytes, inputBudget.maxPayload);
      return;
    }

    // Double-fire dedup (recentSendRef): once inFlightRef is clear (a reconnect wiped
    // it mid-turn, or the turn already finished), the same composed message can reach
    // here twice. An identical text re-sent to this session inside DUP_SEND_WINDOW_MS
    // is that one logical send firing again — resend it with the ORIGINAL
    // idempotencyKey so the gateway collapses it into a single turn (no duplicate user
    // message, no phantom bubble, no composer churn), while a genuinely-lost original
    // still gets delivered. Attachment sends opt out (richer payload, own key).
    const nowTs = Date.now();
    const selectionKey = JSON.stringify((pluginSelection ?? []).slice().sort((a, b) => a.installationId.localeCompare(b.installationId)));
    const recent = atts.length ? undefined : recentSendRef.current.get(key);
    if (recent && recent.text === text && recent.selectionKey === selectionKey && nowTs - recent.at < DUP_SEND_WINDOW_MS) {
      const recentParams = buildChatSendParams(key, text, recent.idem, atts, pluginSelection);
      const payloadBudget = gatewayRequestPayloadBudget(
        String(reqId.current),
        "chat.send",
        recentParams,
        maxPayloadForSession(key),
      );
      if (!payloadBudget.allowed) {
        showPayloadLimit("chat.sendPayloadTooLarge", payloadBudget.payloadBytes, payloadBudget.maxPayload);
        return;
      }
      recent.at = nowTs;
      if (trackedSend && !rememberPendingTrackedSend(key, recent.idem, pluginSelection, originalBackend)) {
        setError(t("chat.sendTrackingUnavailable"));
        return;
      }
      if (trackedSend) {
        markInFlight(key, true);
        setVerificationKeys(previous => new Set(previous).add(key));
        void verifyPendingTrackedSends(key);
      } else void send("chat.send", recentParams).catch(() => {});
      return;
    }
    const idem = crypto.randomUUID();

    const params = buildChatSendParams(key, text, idem, atts, pluginSelection);
    const payloadBudget = gatewayRequestPayloadBudget(
      String(reqId.current),
      "chat.send",
      params,
      maxPayloadForSession(key),
    );
    if (!payloadBudget.allowed) {
      showPayloadLimit("chat.sendPayloadTooLarge", payloadBudget.payloadBytes, payloadBudget.maxPayload);
      return;
    }
    if (!atts.length) recentSendRef.current.set(key, { text, selectionKey, idem, at: nowTs });
    if (trackedSend && !rememberPendingTrackedSend(key, idem, pluginSelection, originalBackend)) {
      setError(t("chat.sendTrackingUnavailable"));
      return;
    }

    // Send straight into the active session, INCLUDING a ":main" tail. "main" is a
    // real, persistent session: the gateway canonicalizes it (resolveMainSessionKey)
    // and APPENDS the turn, so selecting "main" keeps the whole conversation in main.
    // The model rides main's own entry (kept current by changeModel → sessions.patch),
    // so no per-send session minting is needed. (R13 used to sessions.create a fresh
    // `dashboard:<uuid>` here to carry the picked model — but that spawned a new session
    // on every main-send, the opposite of what choosing "main" should do. Removed in
    // R20; the gateway already honors main's entry model on a plain chat.send.)

    // 本地气泡缩略/缓存只针对图片；PDF/文件走 files chip。
    const imgs = atts.filter((a) => !a.kind || a.kind === "image").map((a) => a.dataUrl);
    const nonImageAtts = atts.filter((a) => a.kind && a.kind !== "image");
    runStatusBySessionRef.current.set(key, "starting");
    markInFlight(key, true);
    liveToolsRef.current.delete(key); // fresh turn → drop any prior turn's live tool cards
    pendingThinkingRef.current.delete(key);
    liveTextRef.current.delete(key);
    steerTextBaselineRef.current.delete(key);
    const durableProgress = progressCardsRef.current.get(key);
    if (durableProgress) pendingPlanRef.current.set(key, progressCardPlan(durableProgress));
    else pendingPlanRef.current.delete(key);
    // R339:新回合的直播时间线从零开始(上一轮若悬空未终结,这里硬切)。
    liveTimelinesRef.current.delete(key);
    timelineFeed(key, { kind: "user", text: displayText });
    setSending(true);
    // An explicit user message is real activity before the long-running reply
    // finishes. updatedAt alone cannot override an already learned realTimes entry.
    advanceRealActivity(key, nowTs);
    stoppedScrollKeyRef.current = null;
    sendAnchorRef.current = true; // my own send repositions ONCE: park the sent bubble at the top, reply streams into the space below (no continuous auto-follow — R280)
    setImmersiveSendSeq((s) => s + 1); // 沉浸层的 R280 mirror 用这个单调计数当「本次发送要锚定」信号
    const nextMessages: ChatMsg[] = [
      ...messagesRef.current.map((message) => message.keepLiveLayout ? { ...message, keepLiveLayout: false } : message),
      {
        role: "user",
        parts: [{ type: "text", text: displayText }],
        images: imgs.length ? imgs : undefined,
        retryAttachments: atts.length ? atts : undefined,
        pluginSelection: pluginSelection?.length ? pluginSelection : undefined,
        localSendId: originalBackend === "openclaw" || pluginSelection?.length ? idem : undefined,
        // 非图片附件在气泡里以 chip 呈现（此前完全不显示——发出去后用户看不到
        // 自己附了什么）。
        // 视频带上 dataURL：气泡里渲染可播放的预览窗（点击进 lightbox）。
        files: nonImageAtts.length
          ? nonImageAtts.map((a) => ({
              name: a.name,
              kind: a.kind || "file",
              src: a.dataUrl,
              ...(a.sizeBytes !== undefined ? { sizeBytes: a.sizeBytes } : {}),
              ...(a.durationMs !== undefined ? { durationMs: a.durationMs } : {}),
              ...(a.width !== undefined ? { width: a.width } : {}),
              ...(a.height !== undefined ? { height: a.height } : {}),
            }))
          : undefined,
        ts: nowTs,
      },
      {
        role: "assistant",
        parts: composePendingParts([], "", "", pendingPlanRef.current.get(key) || []),
        pending: true,
      },
    ];
    if (originalBackend === "openclaw") optimisticHistoryRef.current.remember(key, nextMessages[nextMessages.length - 2]);
    messagesRef.current = nextMessages;
    chatHistoryController.markSend(key, nextMessages);
    setMessages(nextMessages);
    // 落本地缓存：gateway 不持久化用户图片，重开后靠这份缓存 + 「会话::文本」键还原（lib/imageCache）。
    if (imgs.length) void putImages(imgCacheKey(key, text), imgs);
    // 保留文件来源，切回会话后仍可打开；权威历史提供的来源优先于本地缓存。
    if (nonImageAtts.length) {
      // 大文件可能几十 MB，超过 FILE_CACHE_MAX_BYTES 只保留元数据，
      // 原生附件引用和 Hermes 路径仍由权威历史恢复。
      void putFiles(
        fileCacheKey(key, text),
        nonImageAtts.map((a) => ({
          name: a.name,
          kind: a.kind || "file",
          ...(a.dataUrl.length <= FILE_CACHE_MAX_BYTES ? { src: a.dataUrl } : {}),
        })),
      );
    }
    // 2026.8.1: each attachment carries raw base64 at top level. Hermes already
    // accepts this public envelope, so the page stays transport-neutral.
    if (isSlash) {
      const timer = setTimeout(() => {
        slashWatchdogRef.current.delete(key);
        if (!inFlightRef.current.has(key)) return;
        markInFlight(key, false);
        if (activeKeyRef.current === key) {
          setSending(false);
          setMessages((prev) =>
            prev.some((m) => m.pending)
              ? [
                  ...prev.filter((m) => !m.pending),
                  { role: "system", local: true, parts: [{ type: "text", text: t("chat.commandNoReply") }], ts: Date.now() },
                ]
              : prev,
          );
        }
      }, 18000);
      slashWatchdogRef.current.set(key, timer);
    }
    if (trackedSend) {
      // Original text/attachments stay only in this renderer's memory. Unknown
      // receipts never turn this recovery payload into a queued/replayable send.
      pendingPluginSendRef.current.set(`${key}\0${idem}`, { key, generation: pluginGeneration ?? -2, text, atts,
        selection: pluginSelection ?? [] });
    }
    try {
      await send("chat.send", params);
    } catch (e) {
      const uncertain = isUncertainChatSendReceipt(e)
        || (!!pluginSelection?.length && !isExplicitChatSendRejection(e));
      const observedSend = trackedSend || (uncertain && ["shoggoth", "openclaw", "hermes"].includes(originalBackend));
      if (observedSend && uncertain) {
        // A dispatched ordinary message can lose its ACK during an upstream
        // change too. Pin its original owner/key; never restore a replayable
        // draft or derive a replacement operation from the new upstream.
        const retained = trackedSend || rememberPendingTrackedSend(key, idem, undefined, originalBackend);
        runStatusBySessionRef.current.set(key, "needs_verification");
        markInFlight(key, true);
        setVerificationKeys((previous) => new Set(previous).add(key));
        if (retained) void verifyPendingTrackedSends(key);
        else setError(t("chat.sendTrackingUnavailable"));
        return;
      }
      if (trackedSend) forgetPendingTrackedSend(key, idem);
      restoreRejectedPluginSend(idem, key);
      markInFlight(key, false);
      const timer = slashWatchdogRef.current.get(key);
      if (timer) {
        clearTimeout(timer);
        slashWatchdogRef.current.delete(key);
      }
      if (activeKeyRef.current === key) {
        setSending(false);
        setMessages((prev) => [
          ...prev.filter((m) => !m.pending),
          // raw error + errPrefix — translated at render time (follows language switches)
          { role: "system", parts: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], errPrefix: "chat.sendFailed" },
        ]);
      }
    }
  };
  sendChatMessageRef.current = sendChatMessage; // keep the widget sendPrompt bridge current

  const sendSteeringMessage = async (key: string, text: string) => {
    const payloadBudget = inspectChatSteerPayload(key, text);
    if (!payloadBudget.allowed) {
      showPayloadLimit("chat.sendPayloadTooLarge", payloadBudget.payloadBytes, payloadBudget.maxPayload);
      return false;
    }
    try {
      await send("chat.steer", { sessionKey: key, message: text });
      steerTextBaselineRef.current.set(key, liveTextRef.current.get(key) || "");
      liveToolsRef.current.delete(key);
      pendingThinkingRef.current.delete(key);
      pendingPlanRef.current.delete(key);
      advanceRealActivity(key, Date.now());
      if (activeKeyRef.current !== key) return true;
      const nextMessages = appendSteeringMessage(messagesRef.current, text);
      messagesRef.current = nextMessages;
      setMessages(nextMessages);
      setImmersiveSendSeq((sequence) => sequence + 1);
      return true;
    } catch (error) {
      if (activeKeyRef.current === key) {
        setInput((current) => current.trim() ? `${text}\n${current}` : text);
        setToast({
          text: t("chat.steerFailedRestored", {
            msg: error instanceof Error ? error.message : String(error),
          }),
          kind: "error",
        });
        setTimeout(() => setToast(null), 3200);
      } else {
        const current = draftsRef.current.get(key) || "";
        draftsRef.current.set(key, current.trim() ? `${text}\n${current}` : text);
      }
      return false;
    }
  };

  // ── 待发队列操作（R357）────────────────────────────────────────────────
  // 队列此刻能不能往外发：WS 通着 **且** 目标会话所属后端在线。两个条件缺一不可——
  // 网关重启时 proxy 会降级保活浏览器 socket（`connected` 仍为 true），只判 WS 会让
  // 队首消息打进降级面并撞回 UPSTREAM_DOWN。connectedBackends 为 null = 首次探测还没
  // 回来，乐观放行（与 agent 列表的乐观显示同口径）。
  const queueSendable = (key: string): boolean =>
    connected && (connectedBackends == null || connectedBackends.has(backendOfSession(key)));
  const bumpQueue = () => setQueueTick((t) => t + 1);
  const enqueueMessage = (key: string, text: string, atts: ChatAttachment[],
    pluginSelection?: ChatPluginSelection[], pluginGeneration?: number) => {
    const q = sendQueueRef.current.get(key) ?? [];
    q.push({ id: crypto.randomUUID(), text, atts, pluginSelection, pluginGeneration });
    if (pluginSelection?.length && pluginGeneration !== undefined) pluginReservationRef.current.set(key, pluginGeneration);
    sendQueueRef.current.set(key, q);
    bumpQueue();
    // 沉浸模式看不到 chips（v1 未接入沉浸层）——真正滞留时给个 toast，防「回车没反应」
    // 错觉；空闲即发路径（enqueue 后同 tick 立即 flush）不打扰。滞留有两种：生成中，
    // 以及断线等重连（后者同样发不出去，沉浸模式下更需要这声提示）。
    if (immersive && (inFlightRef.current.has(key) || !queueSendable(key))) {
      setToast({ text: t("chat.queuedToast"), kind: "success" });
      setTimeout(() => setToast(null), 1800);
    }
  };
  // 队首补发。每次触发都重新校验：仅活跃会话（sendChatMessage 写死 activeKey，背景
  // 会话终结不发、切回时由 effect 补）、无进行中回合、队列非空。回合终结时
  // recentSendRef 已清（R342），链式补发不会被 DUP_SEND_WINDOW_MS 折叠误伤。
  const flushQueue = (key: string) => {
    if (!key || key !== activeKeyRef.current) return;
    // 必须早于读取/shift 队首；其他 Hermes profile ready 不能吃掉当前 profile 的消息。
    if (!sendController.flushQueue(key, () => true)) return;
    if (inFlightRef.current.has(key)) return;
    if (hasPendingTrackedSend(key)) return;
    // 连不上就**不出队**：此时 chat.send 必抛错（WS 断 →「未连接」；网关降级 →
    // UPSTREAM_DOWN），队首消息会被红错泡吃掉、内容彻底丢失。留在队列里（chip 照常
    // 显示、可取回编辑、可删），等连接回来再补发——用户在断线那几十秒里打的字不白打。
    if (!queueSendable(key)) return;
    // 会话可能在断线期间被删掉 / 被网关自愈重置。别往一个已不存在的 key 上打——留在
    // 队列里等用户处理（chip 可取回编辑）比静默发进一条野会话好。
    if (!sessionsRef.current.some((s) => s.key === key)) return;
    const q = sendQueueRef.current.get(key);
    if (!q?.length) return;
    const item = q[0]!;
    const payloadBudget = inspectChatSendPayload(key, item.text, item.atts, item.pluginSelection);
    if (!payloadBudget.allowed) {
      showPayloadLimit("chat.queuedPayloadTooLarge", payloadBudget.payloadBytes, payloadBudget.maxPayload);
      return;
    }
    q.shift();
    bumpQueue();
    void sendChatMessage(item.text, item.atts, false, item.text, item.pluginSelection, item.pluginGeneration);
  };
  flushQueueRef.current = flushQueue;
  // 点击 chip 取回编辑：出队，文本回输入框（有草稿则换行拼接不覆盖），附件并回附件区。
  const reclaimQueued = (id: string) => {
    const key = activeKeyRef.current;
    if (!key) return;
    const q = sendQueueRef.current.get(key) ?? [];
    const idx = q.findIndex((m) => m.id === id);
    if (idx < 0) return;
    const [item] = q.splice(idx, 1);
    if (item.pluginGeneration !== undefined && pluginReservationRef.current.get(key) === item.pluginGeneration)
      pluginReservationRef.current.delete(key);
    bumpQueue();
    setInput((prev) => (prev.trim() ? `${prev}\n${item.text}` : item.text));
    if (item.atts.length) setComposerAttachments((prev) => [...prev, ...item.atts]);
    if (item.pluginSelection?.length) setPluginSelectionFor(key, item.pluginSelection);
    visibleComposerEl()?.focus();
  };
  const removeQueued = (id: string) => {
    const key = activeKeyRef.current;
    if (!key) return;
    const q = sendQueueRef.current.get(key) ?? [];
    const idx = q.findIndex((m) => m.id === id);
    if (idx < 0) return;
    const [item] = q.splice(idx, 1);
    if (item.pluginGeneration !== undefined && pluginReservationRef.current.get(key) === item.pluginGeneration)
      pluginReservationRef.current.delete(key);
    bumpQueue();
  };
  const clearQueue = () => {
    const key = activeKeyRef.current;
    if (!key) return;
    for (const item of sendQueueRef.current.get(key) ?? []) {
      if (item.pluginGeneration !== undefined && pluginReservationRef.current.get(key) === item.pluginGeneration)
        pluginReservationRef.current.delete(key);
    }
    sendQueueRef.current.delete(key);
    bumpQueue();
  };
  // 当前会话的待发队列（渲染用）；queueTick 驱动重算。
  const activeQueue = useMemo(
    () => (activeKey ? sendQueueRef.current.get(activeKey) ?? [] : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queueTick, activeKey],
  );
  // 补发钩子，两件事共用一条路径（flushQueue 自校验，多触发无害）：
  // ① 背景会话回合终结时 flush 被跳过（非活跃），切回来补一次；
  // ② 断线期间滞留的队列，在连接/后端恢复的那一刻自动发出——deps 里的 connected 与
  //    connectedBackends 就是恢复信号，覆盖 WS 重连**和**网关降级翻回满血两条路径
  //    （后者 WS 全程没断过，只靠 onopen 挂钩会漏）。延迟同出队钩子。
  useEffect(() => {
    if (!activeKey) return;
    const timer = setTimeout(() => flushQueueRef.current?.(activeKey), QUEUE_FLUSH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [activeKey, connected, connectedBackends, readyAgentIds]);

  // Run a recognized slash command. OpenClaw agents → handle client-side (RPC /
  // local render), mirroring OpenClaw's own Control UI (its gateway does NOT execute
  // commands arriving via chat.send — verified: they get stored with no reply).
  // Returns true when fully handled here; false → the caller sends it as a message
  // (Hermes, whose ACP adapter intercepts slash commands, and any OpenClaw command
  // we don't special-case).
  const dispatchSlash = async (cmd: SlashCommand, args: string, raw: string): Promise<boolean> => {
    const key = activeKeyRef.current;
    if (!key) return false;
    // Hermes：能力通用的命令（模型/停止/压缩/用量/状态/清屏/新会话——全走通用 RPC）在
    // 本地处理，与 OpenClaw 同一条路径；其余仍作为消息发出（S6 起接网关执行）。
    const nativeAgent = chatBackendDescriptors.get(backendOfSession(key))
      ?.surfaces.agentHarness === true;
    if (nativeAgent && cmd.execution === "cli") {
      pushLocal(t("chat.slashRequiresCli", { name: cmd.name, source: cmd.source || "CLI" }));
      return true;
    }
    if (nativeAgent && cmd.execution === "runtime") return false;
    const localName = nativeAgent ? cmd.name.replace(/^shoggoth:/, "") : cmd.name;
    if (!(nativeAgent && cmd.execution === "client")
      && !shouldHandleSlashLocally(agentOf(key), localName, nativeAgent)) return false;
    const echo = () =>
      setMessages((prev) => [...prev, { role: "user", parts: [{ type: "text", text: raw }], ts: Date.now() }]);

    // Native /clear (including /new aliases) starts a conversation. Shoggoth’s
    // /shoggoth:clear only clears the local display, just as its description says.
    let action = localName;
    if (nativeAgent && cmd.execution === "client" && cmd.name === "clear") {
      if (args && cmd.source?.startsWith("Claude Code")) {
        try { await send("sessions.patch", { key, label: args }); }
        catch (error) { pushLocal(String(error)); return true; }
      } else if (args) {
        pushLocal(`Usage: /${cmd.name}`);
        return true;
      }
      args = "";
      action = "new";
    }
    switch (action) {
      case "permission": {
        if (!args) {
          pushLocal(`${activePermissionMode}\n${permissionOptions.map((option) => `${option.id}: ${option.label}`).join("\n")}`);
        } else {
          const option = permissionOptions.find((candidate) => candidate.id === args);
          if (!option) pushLocal(`Usage: /permission <${permissionOptions.map((candidate) => candidate.id).join("|")}>`);
          else await changePermissionMode(option);
        }
        return true;
      }
      case "rename":
      case "name":
        if (nativeAgent && args === "--auto") pushLocal(t("chat.slashRequiresCli", { name: cmd.name, source: cmd.source || "CLI" }));
        else if (args) await renameSessionTo(args);
        else { setInput(`/${cmd.name} `); focusComposer(cmd.name.length + 2); }
        return true;
      case "copy": {
        if (args && !/^[1-9][0-9]*$/u.test(args)) {
          pushLocal(t("chat.slashRequiresCli", { name: cmd.name, source: cmd.source || "CLI" }));
          return true;
        }
        const index = args ? Number(args) : 1;
        const replies = messages.filter((message) => message.role === "assistant");
        const reply = Number.isSafeInteger(index) && index > 0 ? replies.at(-index) : undefined;
        const text = reply?.parts.filter((part) => part.type === "text").map((part) => part.text || "").join("\n");
        if (!text) pushLocal(t("chat.commandNoReply"));
        else {
          try { await navigator.clipboard.writeText(text); }
          catch (error) { pushLocal(String(error)); }
        }
        return true;
      }
      case "model":
        echo();
        if (args) void changeModel(args);
        else pushLocal(t("chat.currentModel", { model: active?.model || t("chat.notSet") }));
        return true;
      case "models":
        echo();
        pushLocal(
          models.length
            ? `**${t("chat.availableModels")}**\n` + models.map((m) => `- \`${m.id}\`${m.name && m.name !== m.id ? ` — ${m.name}` : ""}`).join("\n")
            : t("chat.noModels"),
        );
        return true;
      case "think":
        echo();
        if (args) void patchSession({ thinkingLevel: args }, t("chat.labelThinking"));
        else pushLocal(t("chat.currentThinking", { level: active?.thinkingLevel ?? active?.thinkingDefault ?? t("chat.defaultLevel") }));
        return true;
      case "verbose":
        echo();
        if (args) void patchSession({ verboseLevel: args }, "verbose");
        else pushLocal(t("chat.usageVerbose"));
        return true;
      // `/fast` 的 argOptions 里有 "status"（查询语义）。原来只判 `args === "on"`，
      // 于是 `/fast status` 变成 fastMode:false —— 想查状态反而把 fast 关了，还提示切换成功。
      case "fast": {
        echo();
        const mode = args.trim().toLowerCase();
        if (mode === "on" || mode === "off") {
          const next = mode === "on";
          if (await patchSession({ fastMode: next }, "fast")) {
            setFastByKey((m) => ({ ...m, [key]: next }));
          }
        } else if (mode === "status") {
          pushLocal(t("chat.fastStatus", { state: t((active?.fastMode ?? fastByKey[key]) ? "chat.fastOn" : "chat.fastOff") }));
        } else {
          pushLocal(t("chat.usageFast"));
        }
        return true;
      }
      case "stop":
        echo();
        try {
          await send("chat.abort", { sessionKey: key });
          markInFlight(key, false);
          if (activeKeyRef.current === key) setSending(false);
          pushLocal(t("chat.stopRequested"));
        } catch (e) {
          pushLocal(t("chat.stopFailed", { msg: e instanceof Error ? e.message : String(e) }));
        }
        return true;
      case "clear":
        optimisticHistoryRef.current.forget(key);
        openclawPreamblesRef.current.forget(key);
        localSlashHistoryRef.current.forget(key);
        setMessages([{ role: "system", local: true, parts: [{ type: "text", text: t("chat.localCleared") }], ts: Date.now() }]);
        return true;
      case "compact":
        echo();
        setToast({ text: t("chat.compacting"), kind: "pending" });
        try {
          const res = await send("sessions.compact", buildCompactParams(key, args));
          const r = res?.payload?.result || {};
          // OpenClaw 回 tokensBefore/After 数字；Hermes(session.compress) 回
          // token_line/headline 展示串——两种都接。
          const detail =
            typeof r.tokensBefore === "number" && typeof r.tokensAfter === "number"
              ? t("chat.compactDetail", { before: fmtTokens(r.tokensBefore), after: fmtTokens(r.tokensAfter) })
              : r.tokenLine || r.headline
                ? `（${r.tokenLine || r.headline}）`
                : "";
          setToast(null);
          pushLocal(t("chat.compacted", { detail }));
          // 压缩重写了服务端转录 → 重载让 UI 显示压缩后的历史。
          void loadHistory(key, { refresh: true });
        } catch (e) {
          setToast(null);
          pushLocal(t("chat.compactFailed", { msg: e instanceof Error ? e.message : String(e) }));
        }
        return true;
      case "usage": {
        echo();
        const tot = active?.totalTokens;
        const lim = active?.contextTokens;
        pushLocal(
          tot
            ? t("chat.sessionUsage", {
                used: fmtTokens(tot),
                limit: lim ? t("chat.usageLimitSuffix", { limit: fmtTokens(lim), pct: Math.min(100, Math.round((tot / lim) * 100)) }) : "",
              })
            : t("chat.noUsage"),
        );
        return true;
      }
      case "status": {
        echo();
        const a = active;
        if (!a) {
          pushLocal(t("chat.noActiveSession"));
          return true;
        }
        const lim = a.contextTokens;
        const lines = [
          t("chat.statusSession", { key: a.key }),
          t("chat.statusModel", { model: a.model || t("chat.defaultModel"), provider: a.modelProvider ? t("chat.providerSuffix", { provider: a.modelProvider }) : "" }),
          a.thinkingLevel || a.thinkingDefault ? t("chat.statusThinking", { level: a.thinkingLevel ?? a.thinkingDefault }) : "",
          a.totalTokens ? t("chat.statusUsage", { used: fmtTokens(a.totalTokens), limit: lim ? ` / ${fmtTokens(lim)}` : "" }) : "",
          a.status ? t("chat.statusState", { state: a.status }) : "",
          a.hasActiveRun ? t("chat.statusRunning") : "",
        ].filter(Boolean);
        pushLocal(lines.join("\n"));
        return true;
      }
      case "agents":
        echo();
        try {
          const r = await fetch("/__api/agents?backend=openclaw");
          const d = await r.json();
          const list = Array.isArray(d?.agents) ? d.agents : Array.isArray(d) ? d : [];
          pushLocal(
            list.length ? "**" + t("chat.agentsHeading") + "**\n" + list.map((a: any) => `- ${a.id || a.name}`).join("\n") : t("chat.noAgents"),
          );
        } catch {
          pushLocal(t("chat.agentsFailed"));
        }
        return true;
      case "help":
      case "commands":
        echo();
        pushLocal(helpText(slashPool()));
        return true;
      // ---- per-session settings (all valid sessions.patch fields, like verbose/fast) ----
      case "trace":
        echo();
        if (args) void patchSession({ traceLevel: args }, "trace");
        else pushLocal(t("chat.usageTrace"));
        return true;
      case "reasoning":
        echo();
        if (args) void patchSession({ reasoningLevel: args }, t("chat.labelReasoning"));
        else pushLocal(t("chat.usageReasoning"));
        return true;
      case "elevated":
        echo();
        if (args) void patchSession({ elevatedLevel: args }, t("chat.labelElevated"));
        else pushLocal(t("chat.usageElevated"));
        return true;
      case "exec": {
        echo();
        if (!args) {
          pushLocal(t("chat.usageExec"));
          return true;
        }
        const [host, security, ask, node] = args.split(/\s+/);
        const patch: Record<string, unknown> = {};
        if (host) patch.execHost = host;
        if (security) patch.execSecurity = security;
        if (ask) patch.execAsk = ask;
        if (node) patch.execNode = node;
        void patchSession(patch, "exec");
        return true;
      }
      // ---- subagent / run control ----
      case "subagents": {
        echo();
        const aId = agentOf(key);
        const subs = sessionsRef.current
          .filter((s) => agentOf(s.key) === aId && sessionKindOf(s.key, s.kind) === "subagent")
          .sort((a, b) => Number(!!b.hasActiveRun) - Number(!!a.hasActiveRun) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
        if (!subs.length) {
          pushLocal(t("chat.noSubagents"));
          return true;
        }
        const activeCount = subs.filter((s) => s.hasActiveRun).length;
        const shown = subs.slice(0, 20);
        const more = subs.length - shown.length;
        pushLocal(
          t("chat.subagentsHeader", { total: subs.length, running: activeCount, truncated: more > 0 ? t("chat.subagentsTruncated") : "" }) + "\n" +
            shown.map((s) => `- \`${s.key.split(":").slice(2).join(":")}\`${s.hasActiveRun ? t("chat.runningSuffix") : ""}`).join("\n") +
            (more > 0 ? "\n" + t("chat.subagentsMore", { count: more }) : "") +
            "\n\n" + t("chat.subagentsKillHint"),
        );
        return true;
      }
      case "kill": {
        echo();
        const aId = agentOf(key);
        const subs = sessionsRef.current.filter((s) => agentOf(s.key) === aId && sessionKindOf(s.key, s.kind) === "subagent");
        const target = args.trim().toLowerCase();
        // "all" / no-arg → only the RUNNING subagents; otherwise match by id substring.
        const victims = !target || target === "all" ? subs.filter((s) => s.hasActiveRun) : subs.filter((s) => s.key.toLowerCase().includes(target));
        if (!victims.length) {
          pushLocal(target && target !== "all" ? t("chat.subagentNotFound", { target }) : t("chat.noRunningSubagents"));
          return true;
        }
        try {
          await Promise.all(victims.map((s) => send("chat.abort", { sessionKey: s.key }).catch(() => {})));
          pushLocal(t("chat.killRequested", { count: victims.length }));
        } catch (e) {
          pushLocal(t("chat.killFailed", { msg: e instanceof Error ? e.message : String(e) }));
        }
        return true;
      }
      case "steer":
        if (!args) {
          echo();
          pushLocal(t("chat.usageSteer"));
          return true;
        }
        if (nativeAgent) {
          if (!canSteerActiveChat(
            capabilitiesForSession(key),
            runStatusBySessionRef.current.get(key),
            0,
          )) {
            echo();
            pushLocal(t("chat.steerUnavailable"));
            return true;
          }
          if (await sendSteeringMessage(key, args)) pushLocal(t("chat.steerInjected"));
          return true;
        }
        echo();
        try {
          await send("chat.send", { sessionKey: key, message: args, deliver: false, idempotencyKey: crypto.randomUUID() });
          pushLocal(t("chat.steerInjected"));
        } catch (e) {
          pushLocal(t("chat.steerFailed", { msg: e instanceof Error ? e.message : String(e) }));
        }
        return true;
      case "redirect":
        echo();
        if (!args) {
          pushLocal(t("chat.usageRedirect"));
          return true;
        }
        try {
          await send("sessions.steer", { key, message: args });
          pushLocal(t("chat.redirected"));
        } catch (e) {
          pushLocal(t("chat.redirectFailed", { msg: e instanceof Error ? e.message : String(e) }));
        }
        return true;
      case "new": {
        // OpenClaw's own /new resets the CURRENT session in place (verified: Control UI
        // sends "/new" to the gateway — ui/src/ui/app-chat.ts). The user wants a fresh
        // session that leaves the old one intact, so we create one via the gateway's
        // official `sessions.create` RPC (same scope as chat.send, so our CONTROL_UI
        // client may call it). It mints the canonical `agent:<id>:dashboard:<uuid>` key —
        // the SAME shape as the other webchat sessions — persists it server-side, and
        // inherits the current model. Then switch to it; the old session stays untouched.
        const agentId = agentOf(key);
        const nativeSession = chatBackendDescriptors.get(backendOfSession(key))
          ?.surfaces.agentHarness === true;
        const workspace = args.trim();
        const inheritedChoice = inheritedModelChoice(
          models,
          active?.model,
          modelsBackendRef.current,
          active?.modelProvider,
        );
        const inheritedProvider = active?.modelProvider || inheritedChoice?.provider;
        const creationHints = !active?.model
          ? {}
          : {
              model: active.model,
              ...(inheritedProvider ? { modelProvider: inheritedProvider } : {}),
              ...(inheritedChoice?.acpProviderRef
                ? { acpProviderRef: inheritedChoice.acpProviderRef }
                : {}),
            };
        setToast({ text: t("chat.creatingSession"), kind: "pending" });
        try {
          const res = await send("sessions.create", {
            agentId,
            // Keep the parent's model selection. Native /new explicitly uses
            // the Agent default workspace when no path was supplied.
            parentSessionKey: key,
            // The proxy adapts this backend-neutral identity to the owning
            // transport; raw model ids may themselves contain `/`.
            ...creationHints,
            ...(nativeSession ? { workspace: workspace || null } : {}),
          });
          const newKey: string | undefined = res?.payload?.key;
          if (!newKey) {
            setToast(null);
            pushLocal(t("chat.createSessionNoKey"));
            return true;
          }
          // A newly minted canonical id may not appear in the periodic
          // sessions.list snapshot immediately. Keep its row synthetic
          // until that same key appears in the authoritative list; otherwise
          // the post-final refresh can erase the active session for ~30s.
          ensureSessionRow(newKey, Date.now(), {
            backendId: backendOfSession(key),
            model: active?.model,
            modelProvider: inheritedProvider,
            thinkingLevel: active?.thinkingLevel,
            thinkingDefault: active?.thinkingDefault,
            thinkingOptions: active?.thinkingOptions,
            contextTokens: active?.contextTokens,
          });
          openSession(newKey);
          setToast({ text: t("chat.sessionCreated"), kind: "success" });
          setTimeout(() => setToast(null), 1600);
        } catch (e) {
          setToast({ text: t("chat.createSessionFailed", { msg: e instanceof Error ? e.message : String(e) }), kind: "error" });
          setTimeout(() => setToast(null), 2600);
        }
        return true;
      }
      case "reset": {
        // The operator session RPC enforces gateway scopes and session ownership.
        // Sending this as channel text instead also applies commands.allowFrom,
        // whose Telegram identities cannot identify the authenticated desktop user.
        // Keep argument-bearing commands (including /reset soft) with the runtime.
        if (args.trim()) {
          reloadOnFinalRef.current.add(key);
          await sendChatMessage(raw, [], true);
          return true;
        }
        const resetToast = { text: t("chat.resettingSession"), kind: "pending" as const };
        setToast(resetToast);
        try {
          await send("sessions.reset", { key, reason: "reset" });
          optimisticHistoryRef.current.forget(key);
          openclawPreamblesRef.current.forget(key);
          localSlashHistoryRef.current.forget(key);
          // A reset must not flush queued prompts into the fresh conversation.
          inFlightRef.current.delete(key);
          runStatusBySessionRef.current.delete(key);
          recentSendRef.current.delete(key);
          setRunningKeys(new Set(inFlightRef.current));
          liveToolsRef.current.delete(key);
          pendingThinkingRef.current.delete(key);
          pendingPlanRef.current.delete(key);
          replacePendingPrompts(key, []);
          historyControllerRef.current?.markNeedsRevalidate(key);
          if (activeKeyRef.current === key) {
            setSending(false);
            archivePrefixRef.current = { key: "", msgs: [] };
            setArchive({ key, status: "idle" });
            await loadHistory(key, { refresh: true });
          }
          void refreshSessions().catch(() => {});
          if (activeKeyRef.current === key) setToast({ text: t("chat.sessionReset"), kind: "success" });
          else setToast((current) => current === resetToast ? null : current);
        } catch (error) {
          if (activeKeyRef.current === key) {
            setToast({ text: t("chat.resetSessionFailed", { msg: error instanceof Error ? error.message : String(error) }), kind: "error" });
          } else setToast((current) => current === resetToast ? null : current);
        }
        setTimeout(() => setToast(null), 2600);
        return true;
      }
      default:
        // OpenClaw's webchat only implements a subset of commands client-side — its own
        // Control UI returns "Unknown command" for the rest, the gateway has no generic
        // command-execution RPC, and chat.send doesn't run them. So instead of silently
        // sending a no-op message, give immediate feedback. (Hermes already returned
        // false above → still sent as a message for its ACP adapter to intercept.)
        // Defensive: the palette is curated to executable commands, so this shouldn't
        // be reached for OpenClaw. If it is, give feedback rather than a silent no-op.
        echo();
        pushLocal(t("chat.commandNotSupported", { name: cmd.name }));
        return true;
    }
  };

  // Reserve the command/result pair at submission, before any asynchronous RPC.
  // Completions update that pair even when a later chat turn refreshed history.
  const execServerSlash = async (key: string, raw: string) => {
    const id = crypto.randomUUID();
    const submittedAt = Date.now();
    const history = localSlashHistoryRef.current;
    const resultMessage = (text: string): ChatMsg => ({
      role: "system", local: true, localSlashId: id,
      parts: [{ type: "text", text }], ts: Date.now(),
    });
    const publish = () => {
      if (activeKeyRef.current !== key) return;
      messagesRef.current = history.merge(key, messagesRef.current);
      setMessages(previous => {
        if (activeKeyRef.current !== key) return previous;
        const next = history.merge(key, previous);
        messagesRef.current = next;
        return next;
      });
    };
    const finish = (text: string) => { history.finish(key, id, resultMessage(text)); publish(); };
    history.begin(key, id, [
      { role: "user", localSlashId: id, parts: [{ type: "text", text: raw }], ts: submittedAt },
      resultMessage(t("chat.slashRunning")),
    ], messagesRef.current);
    messagesRef.current = history.merge(key, messagesRef.current);
    setMessages(messagesRef.current);
    const runningToast = { text: t("chat.slashRunning"), kind: "pending" as const };
    setToast(runningToast);
    const clearToast = () => setToast(current => current === runningToast ? null : current);
    try {
      const r = await execSlashCommand(agentOf(key), key, raw);
      clearToast();
      if (!history.has(key, id)) return; // clear/reset/delete retired this operation
      if ((r.kind === "send" && r.text) || r.kind === "prefill") {
        if (activeKeyRef.current !== key || inputRef.current.trim()
          || (r.kind === "send" && (inFlightRef.current.has(key) || !sendController.canSend(key)))) {
          finish(t("chat.slashUnsent", { msg: r.text || raw }));
          if (activeKeyRef.current !== key && !draftsRef.current.has(key)) draftsRef.current.set(key, raw);
          return;
        }
        // Typed actions hand their provisional echo over to chat/the composer.
        history.forget(key, id);
        publish();
        if (r.kind === "send") await sendChatMessage(r.text!, [], true, raw);
        else {
          setInput(r.text || "");
          inputRef.current = r.text || "";
          focusComposer((r.text || "").length);
        }
        return;
      }
      if (r.executionUncertain) {
        finish(t("chat.slashUncertain", { msg: r.text || "" }));
        return;
      }
      const out = (r.text || "").trim();
      const body = out ? "```\n" + out + "\n```" : t("chat.commandNoReply");
      finish(r.warning ? `${body}\n\n> ${r.warning}` : body);
    } catch (e) {
      clearToast();
      if (!history.has(key, id)) return;
      finish(t("chat.slashFailed", { msg: e instanceof Error ? e.message : String(e) }));
    }
  };

  const submit = async (overrideText?: string) => {
    const key = activeKeyRef.current;
    // 第一条可执行逻辑就是 readiness 门禁：拒绝时草稿、引用、附件、历史和队列均不动。
    if (!sendController.composerButton(key, () => true)) return;
    if (attachments.length && key
      && !supportsBackendAttachments(backendOfSession(key), capabilitiesForSession(key))) {
      const name = attachments[0]?.name ?? "";
      setComposerAttachments([]);
      setToast({ text: t("chat.attachKindUnsupported", { name }), kind: "error" });
      setTimeout(() => setToast(null), 2600);
      return;
    }
    const text = (overrideText ?? input).trim();
    if ((!text && !attachments.length) || !key) return;
    // 轮次控制命令与故障恢复用的 /new 必须能穿过 in-flight 守卫；
    // 其余 slash 仍在当前轮次结束前拦截。
    const visibleSlashPool = slashPool();
    const backendId = backendOfSession(key);
    const hasServerSlashSurface = supportsBackendSlash(
      backendId,
      capabilitiesForSession(key),
    ) || chatBackendDescriptors.get(backendId)?.surfaces.agentHarness === true;
    const recoverySlashPool = recoverySlashCommandsForBackend(
      hasServerSlashSurface,
      SLASH_COMMANDS,
    ).filter((command) => !visibleSlashPool.some((visible) => visible.name === command.name));
    const parsedSlash = !attachments.length && text.startsWith("/")
      ? parseSlashInput(text, [...visibleSlashPool, ...recoverySlashPool])
      : null;
    const concurrentServerSlash = !!parsedSlash && canRunServerSlashDuringTurn(parsedSlash.command);
    const isRunControl = !!parsedSlash && (canRunSlashDuringTurn(parsedSlash.command.name)
      || concurrentServerSlash
      || (parsedSlash.command.name === "clear" && parsedSlash.command.execution === "client"
        && parsedSlash.command.source !== "Shoggoth"));
    const inFlight = inFlightRef.current.has(key);
    // R357：生成中仅拦 slash 形态（识别与否都维持原「静默忽略」，run-control 照旧放行）；
    // 普通消息放行 → 走下方统一入队路径（排队，回合终结后链式补发）。
    const looksSlash = !attachments.length && (parsedSlash !== null || isSlashCommandInput(text));
    if (inFlight && looksSlash && !isRunControl) return;
    const atts = attachments;

    // record the sent input for ↑/↓ recall (per session, dedup consecutive, cap 50)
    if (text) {
      const h = histRef.current.get(key) ?? [];
      if (h[h.length - 1] !== text) {
        h.push(text);
        if (h.length > 50) h.shift();
        histRef.current.set(key, h);
      }
      histPosRef.current = -1;
    }

    // Slash-command interception (only a bare command, no attachments). Recognized
    // commands on OpenClaw run client-side; otherwise the command rides chat.send
    // (Hermes ACP intercepts it; an unrecognized "/x" goes as plain text).
    if (parsedSlash) {
      if (!sendController.slash(key, () => true)) return;
      setInput("");
      setSlashOpen(false);
      setQuote(null); // slash commands don't carry a quote
      const handled = await dispatchSlash(parsedSlash.command, parsedSlash.args, text);
      if (handled) return;
      // 未被客户端处理。生成中不把它当普通消息排队发出去——那既不会停下当前
      // 轮次，也会在 transcript 里留下一条莫名其妙的用户消息。
      if (inFlight && !concurrentServerSlash) {
        pushLocal(t("chat.busySlash"));
        return;
      }
      // 声明 slash 能力的后端（Hermes 网关）→ 服务端执行面（官方 slash worker
      // 同款），typed 结果分派；否则命令随 chat.send 出（OpenClaw 兜底语义）。
      if (hasServerSlashSurface) {
        await execServerSlash(key, text);
        return;
      }
      await sendChatMessage(text, [], true); // recognized but not client-handled → message + watchdog
      return;
    }
    // 未识别的 / 输入：有服务端执行面就交给它（覆盖官方全量命令与 skills 命令），
    // 否则按普通消息发出。
    if (isSlashCommandInput(text) && !attachments.length && hasServerSlashSurface) {
      setInput("");
      setSlashOpen(false);
      setQuote(null);
      if (inFlight) {
        pushLocal(t("chat.busySlash"));
        return;
      }
      await execServerSlash(key, text);
      return;
    }
    // unrecognized slash → fall through and send as a normal message

    // Prepend the quoted message as a markdown blockquote (every line gets `>` so
    // a multi-line quote — e.g. a whole cron report — stays one quote block).
    // Session-pinned: a quote captured in another session never rides this send.
    // Skipped when the draft already opens with this exact quote block — pasting
    // a sent quote-carrying message back in while the quote bar is armed would
    // otherwise stack a second `> ` prefix (R115).
    const q = quote && quote.key === key ? quote : null;
    const prefix = q ? `${q.text.split("\n").map((l) => `> ${l}`).join("\n")}\n\n` : "";
    const outgoing = prefix && !text.startsWith(prefix) ? `${prefix}${text}` : text;
    const selectedDraft = pluginSelectionsRef.current[key];
    const selectionGeneration = pluginGenerationRef.current.get(key);
    if (selectedDraft?.length && selectionGeneration === undefined) {
      setToast({ text: t("chat.pluginSelectionStale"), kind: "error" });
      return;
    }
    const knownValidity = pluginValidityRef.current.get(key);
    if (selectedDraft?.length && knownValidity?.backendId === backendOfSession(key)
      && knownValidity.selection === JSON.stringify(selectedDraft)
      && knownValidity.valid === false) {
      setToast({ text: t("chat.pluginSelectionStale"), kind: "error" });
      return;
    }
    const selectedPlugins = selectionGeneration !== undefined
      && pluginReservationRef.current.get(key) !== selectionGeneration
      ? selectedDraft?.slice() : undefined;
    const shouldSteer = inFlight && canSteerActiveChat(
      capabilitiesForSession(key),
      runStatusBySessionRef.current.get(key),
      atts.length,
    ) && !selectedPlugins?.length
      && (!selectedDraft?.length || !["openclaw", "hermes"].includes(backendOfSession(key)));
    const payloadBudget = shouldSteer
      ? inspectChatSteerPayload(key, outgoing)
      : inspectChatSendPayload(key, outgoing, atts, selectedPlugins);
    if (!payloadBudget.allowed) {
      showPayloadLimit("chat.sendPayloadTooLarge", payloadBudget.payloadBytes, payloadBudget.maxPayload);
      return;
    }
    if (hasPendingTrackedSend(key) && (verificationKeys.has(key)
      || runStatusBySessionRef.current.get(key) === "needs_verification")) {
      setToast({ text: t("chat.sendNeedsVerification"), kind: "error" });
      return;
    }
    setInput("");
    setComposerAttachments([]);
    setQuote(null);
    if (shouldSteer) {
      await sendSteeringMessage(key, outgoing);
      return;
    }
    // 空闲时立即新开一轮；Runtime 不支持 steering、Run 尚未 running，
    // 或消息带附件时继续使用待发队列，保持原有保序与断线恢复语义。
    enqueueMessage(key, outgoing, atts, selectedPlugins, selectionGeneration);
    flushQueue(key);
  };

  // 当前「可见」的 composer 输入框：沉浸模式开着时是沉浸层的 textarea，否则是普通 composer。
  const visibleComposerEl = () =>
    (immersiveRef.current ? immersiveInputRef.current : null) ?? composerRef.current;

  const focusComposer = (caret?: number) =>
    requestAnimationFrame(() => {
      const el = visibleComposerEl();
      if (!el) return;
      el.focus();
      const pos = caret ?? el.value.length;
      el.setSelectionRange(pos, pos);
    });

  // Type-anywhere: a printable keystroke while focus sits outside any editable
  // control focuses the composer so the character lands in it. Focus must happen
  // synchronously inside keydown — focusComposer's rAF would run after the
  // character is inserted and silently drop the first keystroke.
  useEffect(() => {
    const onTypeAnywhere = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return; // keep shortcuts as shortcuts
      if (e.isComposing) return;
      if (e.key.length !== 1) return; // printable characters only (skips Enter/Escape/F-keys/arrows…)
      const t = e.target;
      if (t instanceof HTMLElement) {
        if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable) return;
        if (t.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return; // don't steal focus from open popups
        if (t.closest(".chat-header")) return; // keep Space/Enter on the capsule's buttons and note summaries
      }
      const el = visibleComposerEl();
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length); // append after the current draft
    };
    document.addEventListener("keydown", onTypeAnywhere);
    return () => document.removeEventListener("keydown", onTypeAnywhere);
  }, []);

  // Recompute the palette from the composer text. "/partial" → command list; a
  // recognized "/cmd " (or "/cmd part") whose command has fixed options → the
  // arg-picker submenu; anything else → closed.
  const updateSlashMenu = (value: string) => {
    const q = slashQuery(value);
    if (q !== null) {
      const items = filterSlashCommands(q, slashPool(), (cmd) => translateSlashDescription(cmd.description, t));
      setSlashMode("command");
      setSlashItems(items);
      setSlashOpen(true);
      setSlashIndex(0);
      return;
    }
    const aq = slashArgQuery(value);
    if (aq) {
      const cmd = slashPool().find((c) => c.name === aq.name || c.aliases?.some((a) => a.toLowerCase() === aq.name));
      if (cmd?.argOptions?.length) {
        const partial = aq.argPartial.toLowerCase();
        const opts = partial ? cmd.argOptions.filter((o) => o.toLowerCase().startsWith(partial)) : cmd.argOptions;
        if (opts.length) {
          setSlashMode("args");
          setSlashArgCmd(cmd);
          setSlashArgItems(opts);
          setSlashOpen(true);
          setSlashIndex(0);
          return;
        }
      }
    }
    setSlashOpen(false);
  };

  // Pick a command: fill "/cmd " (then open its arg-picker if it has fixed options)
  // or "/cmd" for no-arg commands. Never auto-sends.
  const applySlashCommand = (cmd: SlashCommand) => {
    const next = cmd.args ? `/${cmd.name} ` : `/${cmd.name}`;
    setInput(next);
    inputRef.current = next;
    if (cmd.args) updateSlashMenu(next);
    else setSlashOpen(false);
    focusComposer(next.length);
  };

  // Pick an option from the arg-picker submenu. Tab fills "/cmd opt"; Enter fills + runs.
  const applySlashArg = (opt: string, run: boolean) => {
    const name = slashArgCmd?.name ?? "";
    const next = `/${name} ${opt}`;
    setInput(next);
    inputRef.current = next;
    setSlashOpen(false);
    setSlashMode("command");
    if (run) void submit(next);
    else focusComposer(next.length);
  };

  // ↑/↓ recall of previously-sent messages (per session). dir -1 = older, 1 = newer.
  const recallHistory = (dir: -1 | 1): boolean => {
    const key = activeKeyRef.current;
    if (!key) return false;
    const hist = histRef.current.get(key) ?? [];
    if (!hist.length) return false;
    if (dir === -1) {
      if (histPosRef.current === -1) {
        histDraftRef.current = inputRef.current;
        histPosRef.current = hist.length - 1;
      } else if (histPosRef.current > 0) {
        histPosRef.current -= 1;
      }
    } else {
      if (histPosRef.current === -1) return false;
      if (histPosRef.current < hist.length - 1) {
        histPosRef.current += 1;
      } else {
        histPosRef.current = -1;
        const d = histDraftRef.current;
        setInput(d);
        inputRef.current = d;
        focusComposer(d.length);
        return true;
      }
    }
    const v = hist[histPosRef.current];
    setInput(v);
    inputRef.current = v;
    focusComposer(v.length);
    return true;
  };

  // 普通 composer 与沉浸 composer 共享的输入处理：值变更（slash 菜单联动 + 历史召回退出）
  // 与键盘（IME 组合守卫 / slash 导航 / ↑↓ 召回 / Enter 发送）。沉浸层独立 textarea 若不走
  // 这套，会丢 IME 守卫（中文选词 Enter 直接把拼音发出去）和 slash/召回能力。
  const composerChange = (v: string) => {
    setInput(v);
    inputRef.current = v;
    histPosRef.current = -1; // typing exits history recall
    updateSlashMenu(v);
  };
  const composerKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.nativeEvent as { isComposing?: boolean }).isComposing) return; // mid-IME (中文输入法) → don't send/navigate
    if (slashOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashOpen(false);
        return;
      }
      const len = slashMode === "args" ? slashArgItems.length : slashItems.length;
      if (len > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashIndex((i) => (i + 1) % len);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashIndex((i) => (i - 1 + len) % len);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          if (slashMode === "args") applySlashArg(slashArgItems[slashIndex], e.key === "Enter");
          else applySlashCommand(slashItems[slashIndex]);
          return;
        }
      }
    } else {
      // history recall (↑ at caret start / ↓ while recalling)——用事件自身的 textarea，
      // 普通/沉浸两个输入框都各自成立
      const el = e.currentTarget;
      if (e.key === "ArrowUp" && el.selectionStart === 0 && el.selectionEnd === 0) {
        if (recallHistory(-1)) {
          e.preventDefault();
          return;
        }
      }
      if (e.key === "ArrowDown" && histPosRef.current !== -1) {
        if (recallHistory(1)) {
          e.preventDefault();
          return;
        }
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const key = activeKeyRef.current;
      if (immersiveRef.current) sendController.immersiveEnter(key, () => { void submit(); });
      else sendController.composerEnter(key, () => { void submit(); });
    }
  };

  // Stop the active session's run (composer Stop button → chat.abort).
  const abortActive = async () => {
    const key = activeKeyRef.current;
    if (!key) return;
    const previousScrollKey = stoppedScrollKeyRef.current;
    stoppedScrollKeyRef.current = key;
    // Stop keeps the reading position even if a terminal notice grows the tail.
    const thread = threadRef.current;
    thread?.scrollTo({ top: thread.scrollTop, behavior: "instant" });
    try {
      await send("chat.abort", { sessionKey: key });
    } catch (error) {
      if (stoppedScrollKeyRef.current === key) stoppedScrollKeyRef.current = previousScrollKey;
      setError(error instanceof Error ? error.message : String(error));
      return;
    }
    markInFlight(key, false);
    if (activeKeyRef.current === key) {
      setSending(false);
      setMessages(settlePendingAssistant);
    }
  };

  // Manual refresh: re-pull sessions, groups, active history, and the current model menu.
  // 等历史也落地再 resolve —— 导航栏刷新（lib/page-refresh）靠这个 promise 决定
  // 什么时候弹「已刷新」，提前 resolve 会让 toast 跑在内容前面。
  const refreshChatOrThrow = async () => {
    await Promise.all([refreshSessions(), refreshGroupChats()]);
    if (activeKeyRef.current) await loadHistory(activeKeyRef.current);
    await refreshActiveModelsRef.current?.();
  };
  // 沉浸模式的刷新键沿用「失败就静默」的老语义；导航栏刷新走会抛的那个——它要拿
  // 失败去弹红 toast，吞掉的话 WS 断了也照报「已刷新」（R371）。
  const refreshChat = async () => {
    try {
      await refreshChatOrThrow();
    } catch {
      /* ignore */
    }
  };
  useRegisterPageRefresh("/chat", refreshChatOrThrow);

  // Rename the active session to a given label (sessions.patch)。沉浸模式的自绘重命名
  // 输入框直接调这里——Electron 渲染进程不支持 window.prompt。
  const renameSessionTo = async (next: string, key = activeKeyRef.current): Promise<boolean> => {
    if (!key) return false;
    const label = next.trim();
    try {
      await send("sessions.patch", { key, label: label || null });
      setSessions((prev) => prev.map((s) => (s.key === key ? { ...s, label: label || undefined } : s)));
      setToast({ text: t("chat.renamed"), kind: "success" });
      setTimeout(() => setToast(null), 1600);
      return true;
    } catch (e) {
      setToast({ text: t("chat.renameFailed", { msg: e instanceof Error ? e.message : String(e) }), kind: "error" });
      setTimeout(() => setToast(null), 2600);
      return false;
    }
  };

  // Delete / archive the active session (sessions.delete), then fall back to auto-select.
  const deleteActiveSession = async () => {
    const key = activeKeyRef.current;
    if (!key) return;
    if (!window.confirm(t("chat.deleteSessionConfirm"))) return;
    try {
      await send("sessions.delete", { key });
    } catch (e) {
      setToast({ text: t("chat.deleteFailed", { msg: e instanceof Error ? e.message : String(e) }), kind: "error" });
      setTimeout(() => setToast(null), 2600);
      return;
    }
    await chatHistoryController.delete(key);
    optimisticHistoryRef.current.forget(key);
    openclawPreamblesRef.current.forget(key);
    localSlashHistoryRef.current.forget(key);
    markInFlight(key, false);
    draftsRef.current.delete(key);
    syntheticRowsRef.current.delete(key); // 删了就别再被 mergeSynthetic 复活
    replacePendingPrompts(key, []);
    if (pendingPlanRef.current.get(key)?.some((entry) => entry.progressRevision !== undefined)) {
      pendingPlanRef.current.delete(key);
    }
    progressCardsRef.current.delete(key);
    progressEventEpochRef.current.delete(key);
    setSessions((prev) => prev.filter((s) => s.key !== key));
    // Stay with the SAME agent: land on its next most-recent session instead of
    // bouncing to whichever other agent was last active (the old auto-land).
    const sibling = activeAgentSessions.find((s) => s.key !== key);
    if (sibling) {
      openSession(sibling.key);
    } else {
      setActiveKey(null);
      activeKeyRef.current = null;
      setMessages([]);
    }
    setToast({ text: t("chat.sessionDeleted"), kind: "success" });
    setTimeout(() => setToast(null), 1600);
  };

  const copyText = (md: string) => {
    navigator.clipboard?.writeText(md).catch(() => {});
    setToast({ text: t("chat.copied"), kind: "success" });
    setTimeout(() => setToast(null), 1200);
  };

  // Un-hide specific message ids of a GIVEN session (the undo toast). Keyed
  // explicitly — the toast outlives session switches, so resolving the key at
  // click time would silently write the wrong session's hidden set.
  const unhideIds = (key: string, ids: string[]) => {
    if (!key || !ids.length) return;
    const n = readIdSet(HIDDEN_PREFIX, key);
    ids.forEach((id) => n.delete(id));
    writeIdSet(HIDDEN_PREFIX, key, n);
    if (activeKeyRef.current === key) setHiddenIds(new Set(n));
  };
  // Hide (locally delete) a group's messages — persisted per session (server
  // untouched). Reversible only through the undo toast right away.
  const deleteGroup = (g: Group) => {
    const key = activeKeyRef.current;
    if (!key) return;
    const ids = g.msgs.map((m) => m.actionId).filter((x): x is string => Boolean(x));
    if (!ids.length) return;
    setHiddenIds((prev) => {
      const n = new Set(prev);
      ids.forEach((id) => n.add(id));
      writeIdSet(HIDDEN_PREFIX, key, n);
      return n;
    });
    // Undo targets THIS session even if the user switches away meanwhile; the
    // auto-dismiss compares identity so a later hide's toast isn't cleared by
    // an earlier hide's timer.
    const undoToast = {
      text: t("chat.hiddenN", { count: ids.length }),
      kind: "success" as const,
      action: { label: t("chat.undo"), run: () => unhideIds(key, ids) },
    };
    setToast(undoToast);
    setTimeout(() => setToast((cur) => (cur === undoToast ? null : cur)), 6000);
  };
  // Re-send the user message that preceded a failed assistant turn (the error
  // bubble's ↻). Locates the failed turn in the raw thread, walks back to the
  // nearest user text, and sends it again as a fresh turn.
  const retryErrorGroup = (g: Group) => {
    const key = activeKeyRef.current;
    if (!key || !sendController.retry(key, () => true) || inFlightRef.current.has(key) || hasPendingTrackedSend(key)) return;
    const first = g.msgs[0];
    let idx = messages.findIndex(
      (m) => (first.id ? m.id === first.id : m.ts === first.ts && msgText(m) === msgText(first)),
    );
    if (idx < 0) idx = messages.length;
    for (let i = idx - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.role === "user") {
        const txt = msgText(m);
        const atts = m.retryAttachments?.length ? m.retryAttachments
          : m.nativeAttachments?.length ? m.nativeAttachments : retryChatAttachments(m.images ?? []);
        if (txt || atts.length) {
          recentSendRef.current.delete(key); // explicit retry = a real new turn; opt out of double-fire dedup
          void sendChatMessage(txt, atts, false, txt, m.pluginSelection,
            m.pluginSelection?.length ? -1 : undefined);
          return;
        }
      }
    }
    setToast({ text: t("chat.retryNoSource"), kind: "error" });
    setTimeout(() => setToast(null), 2200);
  };
  // Toggle the group's saved pin, or pin its first actionable message — persisted per session.
  // On add, jump the carousel to the just-pinned item (its thread-order position
  // among the pinned groups) so the bar reflects what you pinned.
  const pinGroup = (g: Group) => {
    const key = activeKeyRef.current;
    if (!key) return;
    const id = g.msgs.find((m) => m.actionId && pinnedIds.has(m.actionId))?.actionId
      ?? g.msgs.find((m) => m.actionId)?.actionId;
    if (!id) return;
    const adding = !pinnedIds.has(id);
    const n = new Set(pinnedIds);
    if (adding) n.add(id);
    else n.delete(id);
    setPinnedIds(n);
    writeIdSet(PINNED_PREFIX, key, n);
    if (adding) {
      const pos = groups.filter((gg) => gg.msgs.some((m) => m.actionId && n.has(m.actionId))).findIndex((gg) => gg.msgs.some((m) => m.actionId === id));
      if (pos >= 0) setPinNavIndex(pos);
    } else if (n.size === 0) {
      setPinnedOnly(false); // last pin gone → don't strand the thread in a now-toggle-less pinned-only view
    }
  };
  // Unpin a specific id (the pin carousel's × button).
  const unpinId = (id: string) => {
    const key = activeKeyRef.current;
    if (!key) return;
    const n = new Set(pinnedIds);
    n.delete(id);
    setPinnedIds(n);
    writeIdSet(PINNED_PREFIX, key, n);
    if (n.size === 0) setPinnedOnly(false);
  };
  // Quote a group: stash the FULL visible text (prepended as a `> ` blockquote on
  // send) and focus the composer. R152 前只发 200 字快照当指针（赌原文还在模型上下文
  // 里）；会话被 reset/压缩后指针悬空、模型接不上（Maya topic-3 事故），改为全文随发。
  // R154：优先取右键落点的那条气泡（part）→ 那条消息 → 整组，逐级回退——组是渲染
  // 归并的产物，用户引用的语义单位是气泡。
  const quoteGroup = (g: Group, msgIndex?: number, partIndex?: number) => {
    const m = msgIndex != null ? g.msgs[msgIndex] : undefined;
    const p = m && partIndex != null ? m.parts[partIndex] : undefined;
    const s =
      (p && p.type === "text" ? quoteTextOfParts([p]) : "") ||
      (m ? quoteTextOfParts(m.parts) : "") ||
      groupQuoteText(g);
    setMenu(null);
    const key = activeKeyRef.current;
    if (!s || !key) return;
    setQuote({ key, text: s });
    requestAnimationFrame(() => composerRef.current?.focus());
  };
  // Scroll a pinned message into view (the carousel thumbnail click).
  const scrollToMessage = (id: string) => {
    cancelInitialScroll();
    groupRefs.current.get(id)?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  // Jump to the message a quote refers to — best-effort: match the quoted text to a
  // loaded group's full text（R152 全文引用），或旧格式的 200 字快照（历史消息里的
  // 存量引用），或前缀探针包含匹配（R154：按气泡引用/history 截断后引用只是组全文
  // 的子串）。R155：锚点从「组内首个 message id」改成渲染 key（keyedChatGroups：有 id
  // 用 id，无 id 用内容哈希，重复内容用 occurrence 消歧）——cron 投递等无 id 消息以前
  // 拿不到 id 就永远跳不了。搜 keyedShownGroups 而非 groups：只跳向真的渲染出来的组
  // （被搜索/仅置顶过滤掉的没有 DOM 节点，跳了也白跳）。History carries no reply id;
  // no-op if the referenced message isn't in the loaded thread (e.g. reset-archived).
  const jumpToQuoted = (snippet: string) => {
    const probe = snippet.slice(0, 200);
    const hit = keyedShownGroups.find(
      ({ item: g }) =>
        groupQuoteText(g) === snippet ||
        groupSnippet(g) === snippet ||
        (probe.length >= 20 && groupQuoteText(g).includes(probe)),
    );
    if (hit) scrollToMessage(hit.key);
  };
  // Right-click context menu (复制/引用/置顶/删除) on a message group.
  const openMenu = (e: ReactMouseEvent<HTMLDivElement>, g: Group, copyTextOverride?: string) => {
    e.preventDefault();
    // R154：从事件目标向上找 data-mi（消息序号）/ data-qp（文本气泡的 part 序号），
    // 记录右键落点。引用按落点气泡取文——连续同角色消息归组渲染，整组取文会把
    // 相邻消息（如 cron 投递前的另一条回复）串进引用（Maya topic-3 事故）。
    const el = e.target instanceof HTMLElement ? e.target : null;
    const mi = Number(el?.closest("[data-mi]")?.getAttribute("data-mi") ?? NaN);
    const pi = Number(el?.closest("[data-qp]")?.getAttribute("data-qp") ?? NaN);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      group: g,
      copyText: copyTextOverride ?? groupCopyText(g, mi, pi),
      msgIndex: Number.isNaN(mi) ? undefined : mi,
      partIndex: Number.isNaN(pi) ? undefined : pi,
    });
  };
  const closeMenu = () => setMenu(null);
  // Close the context menu on Escape (clicks/scroll close via its backdrop).
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  const forkFromEntry = async (sourceKey: string, entryId: string) => {
    if (!sourceKey || activeKeyRef.current !== sourceKey) return;
    const backendId = backendOfSession(sourceKey);
    const agentId = agentOf(sourceKey);
    const source = sessionsRef.current.find((session) => session.key === sourceKey);
    const ticket = ++forkRequestEpochRef.current;
    const pendingToast = { text: t("chat.advanced.forking"), kind: "pending" as const };
    const clearPendingToast = () => {
      setToast((current) => current === pendingToast ? null : current);
    };
    setMenu(null);
    setToast(pendingToast);
    try {
      const result = await forkSessionAtEntry(backendId, agentId, sourceKey, entryId);
      if (!shouldApplySessionResult(ticket, forkRequestEpochRef.current, sourceKey, activeKeyRef.current)) {
        clearPendingToast();
        return;
      }
      if (result.supported !== true || result.methods["sessions.fork"] !== true || !result.sessionKey) {
        throw new Error(result.reason || t("chat.advanced.unsupported"));
      }

      const newKey = result.sessionKey;
      const draft = forkEditorDraft(result);
      ensureSessionRow(newKey, Date.now(), {
        backendId,
        model: source?.model,
        modelProvider: source?.modelProvider,
        thinkingLevel: source?.thinkingLevel,
        thinkingDefault: source?.thinkingDefault,
        thinkingOptions: source?.thinkingOptions,
        contextTokens: source?.contextTokens,
      });
      await openSession(newKey);
      if (!shouldApplySessionResult(ticket, forkRequestEpochRef.current, newKey, activeKeyRef.current)) {
        clearPendingToast();
        return;
      }

      draftsRef.current.set(newKey, draft.text);
      setInput(draft.text);
      inputRef.current = draft.text;
      setComposerAttachments(draft.attachments);
      setQuote(null);
      requestAnimationFrame(() => composerRef.current?.focus());
      const successToast = {
        text: draft.attachmentsOmitted
          ? t("chat.advanced.forkedAttachmentsOmitted")
          : t("chat.advanced.forked"),
        kind: "success" as const,
      };
      setToast(successToast);
      setTimeout(() => setToast((current) => current === successToast ? null : current), 2400);
    } catch (error) {
      if (!shouldApplySessionResult(ticket, forkRequestEpochRef.current, sourceKey, activeKeyRef.current)) {
        clearPendingToast();
        return;
      }
      const failureToast = {
        text: t("chat.advanced.forkFailed", { msg: error instanceof Error ? error.message : String(error) }),
        kind: "error" as const,
      };
      setToast(failureToast);
      setTimeout(() => setToast((current) => current === failureToast ? null : current), 4200);
    }
  };

  // export the open conversation as a markdown file (client-side, no backend).
  const exportChat = () => {
    if (!activeKey || !messages.length) return;
    const lines = messages.map((m) => {
      const who = m.role === "user" ? "🧑 User" : m.role === "assistant" ? "🤖 Assistant" : m.role;
      const body = m.parts.map((p) => p.text || "").join("\n").trim();
      return `### ${who}${m.ts ? ` · ${new Date(m.ts).toLocaleString()}` : ""}\n\n${body}\n`;
    });
    const blob = new Blob([`# ${activeKey}\n\n${lines.join("\n")}`], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${activeKey.replace(/[^\w.-]+/g, "_")}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };
  // Export button was removed from the composer to match the Figma design, but the
  // logic is intentionally kept for future re-wiring. Reference it so noUnusedLocals
  // stays happy without deleting the feature.
  void exportChat;

  // attachments: read picked files to base64 data URLs (FileReader). Kinds are
  // capability-driven (getChatCapabilities): image is the universal baseline;
  // pdf / arbitrary file only where the backend's transport can deliver them.
  // Oversized files are refused up-front with backend-declared limits.
  const activeBackend = activeKey ? backendOfSession(activeKey) : "openclaw";
  const pluginSelectionReadiness = usePluginSelectionReadiness(activeBackend,
    activeKey ? agentOf(activeKey) : null, activeKey, connected);
  const duplicateToolCallIds = useMemo(() => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const message of messages) for (const part of message.parts) {
      if (part.type !== "toolCall" || !part.toolCallId) continue;
      if (seen.has(part.toolCallId)) duplicates.add(part.toolCallId);
      else seen.add(part.toolCallId);
    }
    return duplicates;
  }, [messages]);
  const activePluginConversation = activeKey ? {
    backendId: activeBackend,
    sessionKey: activeKey,
    agentId: agentOf(activeKey),
    sessionId: listLive && !degradedBackendsRef.current.has(activeBackend)
      ? sessions.find(row => row.key === activeKey)?.sessionId : undefined,
    duplicateToolCallIds,
  } : undefined;
  const activeBackendDescriptor = chatBackendDescriptors.get(activeBackend);
  const imageContext = useMemo(() => activeKey && activeBackendDescriptor?.surfaces.agentHarness
    ? { backendId: activeBackend, sessionKey: activeKey } : undefined,
  [activeKey, activeBackend, activeBackendDescriptor?.surfaces.agentHarness]);
  const activeLegacyHtmlPolicy = useMemo(() => activeBackendDescriptor && activeBackendDescriptor.surfaces.agentHarness !== true && activeKey
    ? { mode: "legacy-preview" as const, scope: activeKey } : "source" as const,
  [activeKey, !!activeBackendDescriptor, activeBackendDescriptor?.surfaces.agentHarness]);
  // Negotiated transport limits already arrive through the generic capability;
  // the composer never branches on a concrete backend to apply them.
  const activeCaps: ChatCapabilities | undefined = runtimeModels.data?.capabilities ?? (activeKey ? chatCaps[agentOf(activeKey)] : undefined);
  const selectableModels = useMemo(
    () => usesRuntimeModelPicker ? runtimeModels.data?.models ?? [] : activeCaps?.modelScope
      ? models.filter((model) => model.modelScopes?.includes(activeCaps.modelScope!))
      : activeCaps?.modelProvider
        ? models.filter((model) => model.provider === activeCaps.modelProvider)
        : models,
    [usesRuntimeModelPicker, runtimeModels.data?.models, activeCaps?.modelProvider, activeCaps?.modelScope, models],
  );
  // Capability discovery gates uploads, including native Service media chunks.
  const supportsActiveAttachments = supportsBackendAttachments(activeBackend, activeCaps);
  const attachAccept = activeCaps?.attachments.file
    ? undefined // 任意文件
    : activeCaps?.attachments.pdf
      ? "image/*,.pdf,application/pdf"
      : "image/*";
  const addFile = (file: File) => {
    const targetKey = activeKeyRef.current;
    const caps = activeKeyRef.current ? capabilitiesForSession(activeKeyRef.current) : undefined;
    const backend = activeKeyRef.current ? backendOfSession(activeKeyRef.current) : "openclaw";
    const atts = caps?.attachments ?? (supportsBackendAttachments(backend, undefined) ? { image: {} } : {});
    const kind: ChatAttachment["kind"] = file.type.startsWith("image/")
      ? "image"
      : file.type === "application/pdf" || /\.pdf$/i.test(file.name)
        ? "pdf"
        : file.type.startsWith("audio/")
          ? "audio"
        : file.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.name)
          ? "video"
          : "file";
    if (kind === "image" && !atts.image) {
      setToast({ text: t("chat.attachKindUnsupported", { name: file.name }), kind: "error" });
      setTimeout(() => setToast(null), 2600);
      return;
    }
    if (kind === "pdf" && !atts.pdf) {
      setToast({ text: t("chat.attachKindUnsupported", { name: file.name }), kind: "error" });
      setTimeout(() => setToast(null), 2600);
      return;
    }
    // video 走的是 file 通道（后端没有独立的视频上传），只是 UI 侧给它可播放的
    // 预览窗——所以能力与上限都按 file 判定。
    if ((kind === "file" || kind === "audio" || kind === "video") && !atts.file) {
      setToast({ text: t("chat.attachKindUnsupported", { name: file.name }), kind: "error" });
      setTimeout(() => setToast(null), 2600);
      return;
    }
    const limit = kind === "image" ? atts.image?.maxBytes : kind === "pdf" ? atts.pdf?.maxBytes : atts.file?.maxBytes;
    if (limit && file.size > limit) {
      setToast({ text: t("chat.attachTooLarge", { name: file.name, limit: `${Math.round(limit / 1024 / 1024)}MB` }), kind: "error" });
      setTimeout(() => setToast(null), 2600);
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = String(reader.result || "");
      if (dataUrl) {
        const mediaMetadata = await readBrowserMediaMetadata(file, kind);
        if (activeKeyRef.current !== targetKey) return;
        if ((caps?.maxAttachments && attachmentsRef.current.length >= caps.maxAttachments)
          || (caps?.maxAttachmentBytes && attachmentsRef.current.reduce((sum, item) => sum + (item.sizeBytes || 0), file.size) > caps.maxAttachmentBytes)) {
          setToast({ text: t("chat.attachBatchLimit", { count: caps.maxAttachments,
            limit: Math.round((caps.maxAttachmentBytes || 0) / 1024 / 1024) }), kind: "error" });
          return;
        }
        const next = [
          ...attachmentsRef.current,
          {
            id: crypto.randomUUID(),
            dataUrl,
            mimeType: file.type || "application/octet-stream",
            name: file.name,
            kind,
            sizeBytes: file.size,
            ...mediaMetadata,
          } satisfies ChatAttachment,
        ];
        const key = activeKeyRef.current;
        const payloadBudget = key ? inspectChatSendPayload(key, inputRef.current.trim(), next) : null;
        if (payloadBudget && !payloadBudget.allowed) {
          showPayloadLimit("chat.attachPayloadTooLarge", payloadBudget.payloadBytes, payloadBudget.maxPayload);
          return;
        }
        setComposerAttachments(next);
      }
    };
    reader.readAsDataURL(file);
  };
  const onPickFiles = (files: FileList | null) => {
    if (files) Array.from(files).forEach(addFile);
  };
  // 聊天面能力懒取（失败静默 → 回落 image-only 基线）。
  useEffect(() => {
    const ag = activeKey ? agentOf(activeKey) : "";
    if (!ag || (chatCapsRef.current[ag] && !chatCapsRef.current[ag].notReady)) return;
    let alive = true;
    getChatCapabilities(ag, backendOfKnownAgent(ag))
      .then((caps) => {
        if (!alive || !caps?.attachments) return;
        // notReady = 后端冷启动竞态返回的临时能力。先保存它，让 gatewayPolicy
        // 可使用当前连接的安全 hello 上限；但 early-return 会跳过 notReady，定时器
        // 仍持续重取，直到后端返回完整终态能力。
        if (caps.notReady) {
          setChatCaps((prev) => ({ ...prev, [ag]: caps }));
          const n = (capsRetryRef.current[ag] ?? 0) + 1;
          if (n > 6) return; // 冷启动 5 dashboard + 模型目录抓取可达 20s+，给足重试轮次
          capsRetryRef.current[ag] = n;
          setTimeout(() => {
            if (chatCapsRef.current[ag]?.notReady) setCapsEpoch((e) => e + 1);
          }, Math.min(n * 3000, 8000));
          return;
        }
        setChatCaps((prev) => ({ ...prev, [ag]: caps }));
      })
      .catch(() => {
        // 后端重启/未就绪 → 退避重试（3s/6s/9s），拿到能力即停。不重试的话
        // composer 会一直停在 image-only，用户得切走再切回才恢复。
        const n = (capsRetryRef.current[ag] ?? 0) + 1;
        if (n > 3) return;
        capsRetryRef.current[ag] = n;
        setTimeout(() => {
          if (!chatCapsRef.current[ag]) setCapsEpoch((e) => e + 1);
        }, n * 3000);
      });
    return () => {
      alive = false;
    };
  }, [activeKey, capsEpoch]);

  // Runtime command catalogs are session/workspace scoped. Store-owned requests
  // survive session/capability updates and safely populate only their own scope.
  const slashCatalogSessionUpdatedAt = activeKey
    ? sessions.find((session) => session.key === activeKey)?.updatedAt
    : undefined;
  useEffect(() => {
    const key = activeKey;
    const ag = key ? agentOf(key) : "";
    const caps = key ? capabilitiesForSession(key) : undefined;
    if (!key || !ag || !caps?.slash || caps.notReady) return;
    void slashCatalogStore.load(ag, backendOfKnownAgent(ag), key);
  }, [activeKey, slashCatalogSessionUpdatedAt, chatCaps, runtimeModels.data?.selection.bindingId, capsEpoch, slashCatalogStore]);

  useEffect(() => {
    const value = inputRef.current;
    if (slashOpen && value.startsWith("/")) updateSlashMenu(value);
  }, [slashCatalogs, activeKey, slashOpen, t]);

  const activeSlashAgent = activeKey ? agentOf(activeKey) : "";
  const activeSlashBackend = activeSlashAgent ? backendOfKnownAgent(activeSlashAgent) : "";
  const activeNativeSlash = chatBackendDescriptors.get(activeSlashBackend)?.surfaces.agentHarness === true;
  const activeSlashCatalog = activeKey ? slashCatalogs[
    SlashCatalogStore.key(activeSlashAgent, activeSlashBackend, activeKey)
  ] : undefined;
  const retrySlashCatalog = () => {
    if (activeKey) void slashCatalogStore.load(activeSlashAgent, activeSlashBackend, activeKey, true);
  };

  // CLI 名称和别名优先；冲突的应用命令保留在显式 shoggoth: 命名空间。
  const slashPool = (): SlashCommand[] => {
    const key = activeKeyRef.current;
    const ag = key ? agentOf(key) : "";
    if (!ag) return SLASH_COMMANDS;
    const backend = backendOfKnownAgent(ag);
    const server = key ? slashCatalogStore.getSnapshot()[SlashCatalogStore.key(ag, backend, key)]?.commands : undefined;
    const nativeAgent = chatBackendDescriptors.get(backend)?.surfaces.agentHarness === true;
    if (nativeAgent) return mergeNativeSlashCommands(server || []);
    if (server?.length) return server;
    if (supportsBackendSlash(backend, chatCapsRef.current[ag])) return SLASH_COMMANDS;
    return [];
  };

  // Paste all clipboard files; addFile enforces the active backend's types and limits.
  const onPasteImages = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.items || [])
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
    if (files.length) {
      e.preventDefault();
      files.forEach(addFile);
      return;
    }
    // Finder file copies can expose only an OS pasteboard URL, not a DOM File.
    const desktop = (window as unknown as { openclawDesktop?: {
      readClipboardFiles?: () => Promise<Array<{ fileName: string; mimeType: string; content: string }>>;
    } }).openclawDesktop;
    if (desktop?.readClipboardFiles) {
      const pastedText = e.clipboardData.getData("text/plain");
      const before = e.currentTarget.value;
      const start = e.currentTarget.selectionStart;
      const end = e.currentTarget.selectionEnd;
      const withText = before.slice(0, start) + pastedText + before.slice(end);
      if (!pastedText) e.preventDefault();
      const key = activeKeyRef.current;
      void desktop.readClipboardFiles().then(items => {
        if (activeKeyRef.current !== key || !items.length) return;
        // Finder may also supply a plain-text filename. Remove only that default
        // insertion; never overwrite edits made while the IPC request was pending.
        if (pastedText && inputRef.current === withText) setInput(before);
        for (const item of items) {
          const bytes = Uint8Array.from(atob(item.content), value => value.charCodeAt(0));
          addFile(new File([bytes], item.fileName, { type: item.mimeType }));
        }
      }).catch(error => {
        if (activeKeyRef.current !== key) return;
        setToast({ text: String(error.message || error), kind: "error" });
      });
    }
  };
  // drag-and-drop image files onto the composer
  const onDropFiles = (e: DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer?.files?.length) {
      e.preventDefault();
      onPickFiles(e.dataTransfer.files);
    }
  };
  const removeAttachment = (id: string) => setComposerAttachments((prev) => prev.filter((a) => a.id !== id));

  // Talk: browser-native Web Speech API speech-to-text (client-only, like the official UI).
  const sttSupported =
    typeof window !== "undefined" && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  const toggleTalk = () => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        /* ignore */
      }
      recognitionRef.current = null;
      setListening(false);
      return;
    }
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setError(t("chat.sttUnsupported"));
      return;
    }
    const rec = new SR();
    rec.lang = navigator.language || "zh-CN";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (ev: any) => {
      let finalText = "";
      for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
        if (ev.results[i].isFinal) finalText += ev.results[i][0].transcript;
      }
      if (finalText) setInput((prev) => (prev ? `${prev}${finalText}` : finalText));
    };
    rec.onend = () => {
      recognitionRef.current = null;
      setListening(false);
    };
    rec.onerror = () => {
      recognitionRef.current = null;
      setListening(false);
    };
    recognitionRef.current = rec;
    setListening(true);
    try {
      rec.start();
    } catch {
      recognitionRef.current = null;
      setListening(false);
    }
  };

  const active = useMemo(() => sessions.find((s) => s.key === activeKey) || null, [sessions, activeKey]);
  useEffect(() => {
    if (!activeKey || isVisibleSession(allSessions.find(row => row.key === activeKey) || { key: activeKey })) return;
    activeKeyRef.current = null;
    setActiveKey(null);
    messagesRef.current = [];
    setMessages([]);
  }, [allSessions, activeKey]);
  useEffect(() => {
    setInspirationChatSession(activeKey ? { backendId: activeBackend, sessionKey: activeKey } : null);
    return () => setInspirationChatSession(null);
  }, [activeKey, activeBackend]);
  useEffect(() => {
    setAdvancedModalOpen(false);
  }, [activeKey]);
  const activeSessionBoardScope = activeKey
    ? sessionBoardScopeKey(activeBackend, agentOf(activeKey), activeKey)
    : "";
  activeSessionBoardScopeRef.current = activeSessionBoardScope;
  useEffect(() => {
    setSessionBoardViewMode("chat");
    setSessionBoardStale(false);
    sessionBoardMutationEpochRef.current += 1;
    setSessionBoardMutating(false);
  }, [activeSessionBoardScope]);
  useEffect(() => {
    const key = activeKey;
    const backendId = key ? backendOfSession(key) : "";
    const agentId = key ? agentOf(key) : "";
    const epoch = ++advancedProbeEpochRef.current;
    const controller = new AbortController();
    setAdvancedProbe(null);
    if (!key || !backendId || !agentId) return () => controller.abort();
    void describeSession(backendId, agentId, key, controller.signal)
      .then((description) => {
        if (
          advancedProbeEpochRef.current === epoch
          && !controller.signal.aborted
          && activeKeyRef.current === key
        ) {
          setAdvancedProbe({ key, backendId, agentId, description });
        }
      })
      .catch(() => {
        // Capability discovery is fail-soft. A later connection/status epoch retries it.
      });
    return () => {
      controller.abort();
      advancedProbeEpochRef.current += 1;
    };
  }, [activeKey, backendOfSession, capsEpoch, connected]);
  useEffect(() => {
    const scope = activeSessionBoardScope;
    const key = activeKey;
    const backendId = key ? activeBackend : "";
    const agentId = key ? agentOf(key) : "";
    const ticket = ++sessionBoardProbeEpochRef.current;
    const controller = new AbortController();
    setSessionBoardProbe((current) => current?.scope === scope ? current : null);
    if (!scope || !key || !backendId || !agentId) {
      setSessionBoardLoading(false);
      return () => controller.abort();
    }
    setSessionBoardLoading(true);
    void getSessionBoard(backendId, agentId, key, controller.signal)
      .then((result) => {
        if (!shouldApplySessionBoardResult(
          ticket,
          sessionBoardProbeEpochRef.current,
          scope,
          activeSessionBoardScopeRef.current,
        )) return;
        if (result.snapshot && result.snapshot.sessionKey !== key) return;
        const current = sessionBoardProbeRef.current?.scope === scope
          ? sessionBoardProbeRef.current.result
          : null;
        const adopt = shouldAdoptSessionBoardRevision(current, result);
        if (adopt) setSessionBoardProbe({ scope, result });
        const retainedAfterError = !adopt && result.supported !== true && result.reason === "error"
          && canReadSessionBoard(current);
        setSessionBoardStale(retainedAfterError);
        if (adopt && !canReadSessionBoard(result)) setSessionBoardViewMode("chat");
      })
      .catch(() => {
        if (!shouldApplySessionBoardResult(
          ticket,
          sessionBoardProbeEpochRef.current,
          scope,
          activeSessionBoardScopeRef.current,
        )) return;
        const current = sessionBoardProbeRef.current?.scope === scope
          ? sessionBoardProbeRef.current.result
          : null;
        if (canReadSessionBoard(current)) setSessionBoardStale(true);
      })
      .finally(() => {
        if (shouldApplySessionBoardResult(
          ticket,
          sessionBoardProbeEpochRef.current,
          scope,
          activeSessionBoardScopeRef.current,
        )) setSessionBoardLoading(false);
      });
    return () => {
      controller.abort();
      sessionBoardProbeEpochRef.current += 1;
    };
  }, [activeBackend, activeKey, activeSessionBoardScope, capsEpoch, connected, sessionBoardReload]);

  const activeSessionBoard = sessionBoardProbe?.scope === activeSessionBoardScope
    ? sessionBoardProbe.result
    : null;
  sessionBoardProbeRef.current = sessionBoardProbe;
  activeSessionBoardRef.current = activeSessionBoard;
  sessionBoardStaleRef.current = sessionBoardStale;
  const sessionBoardForDisplay = sessionBoardStale && activeSessionBoard ? {
    ...activeSessionBoard,
    methods: {
      ...activeSessionBoard.methods,
      "board.update": false,
      "board.widget.put": false,
      "board.widget.grant": false,
    },
    capabilities: { "board-widget-put-canvas-doc": false as const },
  } : activeSessionBoard;
  const showSessionBoard = canReadSessionBoard(sessionBoardForDisplay);
  const canPinActiveCanvas = !sessionBoardStale && canPinCanvasToBoard(activeSessionBoard);
  const pinnedSessionBoardWidgets = new Set(
    activeSessionBoard?.snapshot?.widgets.map((widget) => widget.name) ?? [],
  );

  const queueSessionBoardMutation = (
    scope: string,
    mutate: () => Promise<SessionBoardResult>,
    successText: string,
  ) => {
    const ticket = ++sessionBoardMutationEpochRef.current;
    sessionBoardProbeEpochRef.current += 1;
    setSessionBoardLoading(false);
    setSessionBoardMutating(true);
    const run = async () => {
      if (activeSessionBoardScopeRef.current !== scope) return;
      if (sessionBoardStaleRef.current) throw new Error(t("chat.board.mutationUnsupported"));
      try {
        const result = await mutate();
        if (!shouldApplySessionBoardResult(
          ticket,
          sessionBoardMutationEpochRef.current,
          scope,
          activeSessionBoardScopeRef.current,
        )) return;
        if (!canReadSessionBoard(result) || result.snapshot?.sessionKey !== activeKeyRef.current) {
          throw new Error(result.reason || t("chat.board.mutationUnsupported"));
        }
        setSessionBoardProbe((current) => shouldAdoptSessionBoardRevision(
          current?.scope === scope ? current.result : null,
          result,
        ) ? { scope, result } : current);
        // board.changed arrives on a different WebSocket from this RPC. If it
        // already froze the board, this response may be older than that event;
        // only the event-triggered verified GET may clear the stale state.
        if (!sessionBoardStaleRef.current) setSessionBoardStale(false);
        const successToast = { text: successText, kind: "success" as const };
        setToast(successToast);
        setTimeout(() => setToast((current) => current === successToast ? null : current), 1800);
      } catch (error) {
        if (activeSessionBoardScopeRef.current === scope) {
          sessionBoardStaleRef.current = true;
          setSessionBoardStale(true);
        }
        throw error;
      }
    };
    const queued = sessionBoardMutationChainRef.current.then(run, run);
    sessionBoardMutationChainRef.current = queued.catch(() => undefined);
    void queued.catch((error) => {
      if (!shouldApplySessionBoardResult(
        ticket,
        sessionBoardMutationEpochRef.current,
        scope,
        activeSessionBoardScopeRef.current,
      )) return;
      const failureToast = {
        text: t("chat.board.mutationFailed", { msg: error instanceof Error ? error.message : String(error) }),
        kind: "error" as const,
      };
      setToast(failureToast);
      setTimeout(() => setToast((current) => current === failureToast ? null : current), 4200);
    }).finally(() => {
      if (ticket === sessionBoardMutationEpochRef.current) setSessionBoardMutating(false);
    });
  };

  const mutateSessionBoardLayout = (ops: SessionBoardOp[], successText: string) => {
    if (sessionBoardStale || !activeKey || !activeSessionBoardScope
      || activeSessionBoard?.methods["board.update"] !== true) return;
    const backendId = activeBackend;
    const agentId = agentOf(activeKey);
    const sessionKey = activeKey;
    queueSessionBoardMutation(
      activeSessionBoardScope,
      () => updateSessionBoard(backendId, agentId, sessionKey, ops),
      successText,
    );
  };

  const moveSessionBoardWidget = (widget: SessionBoardWidget, position: number) => {
    mutateSessionBoardLayout(
      [{ kind: "widget_move", name: widget.name, position: Math.max(0, position) }],
      t("chat.board.layoutUpdated"),
    );
  };

  const removeSessionBoardWidget = async (widget: SessionBoardWidget) => {
    const scope = activeSessionBoardScope;
    const boardRevision = activeSessionBoard?.snapshot?.revision;
    const accepted = await confirm({
      title: t("chat.board.removeConfirmTitle"),
      message: t("chat.board.removeConfirmMessage", { name: widget.title || widget.name }),
      confirmLabel: t("chat.board.remove"),
      danger: true,
    });
    const currentWidget = activeSessionBoardRef.current?.snapshot?.widgets.find(
      (candidate) => candidate.name === widget.name,
    );
    const currentBoardRevision = activeSessionBoardRef.current?.snapshot?.revision;
    if (!accepted || scope !== activeSessionBoardScopeRef.current || sessionBoardStaleRef.current
      || currentBoardRevision !== boardRevision
      || !sameSessionBoardWidgetIdentity(widget, currentWidget)) return;
    mutateSessionBoardLayout(
      [{ kind: "widget_remove", name: widget.name }],
      t("chat.board.removed"),
    );
  };

  const decideSessionBoardGrant = async (
    widget: SessionBoardWidget,
    decision: "granted" | "rejected",
  ) => {
    const scope = activeSessionBoardScope;
    const key = activeKey;
    if (!key || !scope || activeSessionBoard?.methods["board.widget.grant"] !== true || !widget.instanceId) return;
    if (decision === "granted" && !widget.accessSummary) return;
    const requestedAccess = widget.accessSummary;
    const accepted = await confirm({
      title: t(decision === "granted" ? "chat.board.grantConfirmTitle" : "chat.board.rejectConfirmTitle"),
      message: decision === "granted"
        ? <div className="chat-board-grant-confirm">
          <p>{t("chat.board.grantConfirmMessage", { name: widget.title || widget.name })}</p>
          {requestedAccess && (requestedAccess.networkOrigins.length > 0 || requestedAccess.tools.length > 0) ? <>
            {requestedAccess.networkOrigins.length > 0 ? <section>
              <strong>{t("chat.board.networkAccess", { count: requestedAccess.networkOrigins.length })}</strong>
              <ul>{requestedAccess.networkOrigins.map((origin) => <li key={origin}><code>{origin}</code></li>)}</ul>
            </section> : null}
            {requestedAccess.tools.length > 0 ? <section>
              <strong>{t("chat.board.toolAccess", { count: requestedAccess.tools.length })}</strong>
              <ul>{requestedAccess.tools.map((tool) => <li key={tool}><code>{tool}</code></li>)}</ul>
            </section> : null}
          </> : <span>{t("chat.board.noRequestedAccess")}</span>}
        </div>
        : t("chat.board.rejectConfirmMessage", { name: widget.title || widget.name }),
      confirmLabel: t(decision === "granted" ? "chat.board.allow" : "chat.board.reject"),
      danger: decision === "rejected",
    });
    const currentWidget = activeSessionBoardRef.current?.snapshot?.widgets.find(
      (candidate) => candidate.name === widget.name,
    );
    if (!accepted || scope !== activeSessionBoardScopeRef.current || sessionBoardStaleRef.current
      || !sameSessionBoardWidgetIdentity(widget, currentWidget)) return;
    const backendId = activeBackend;
    const agentId = agentOf(key);
    queueSessionBoardMutation(
      scope,
      () => grantSessionBoardWidget(backendId, agentId, key, {
        name: widget.name,
        revision: widget.revision,
        instanceId: widget.instanceId as string,
        decision,
      }),
      t(decision === "granted" ? "chat.board.granted" : "chat.board.rejected"),
    );
  };

  const pinCanvasWidget = (spec: { name: string; docId: string }) => {
    const key = activeKey;
    const scope = activeSessionBoardScope;
    if (!key || !scope || !canPinActiveCanvas) return;
    const backendId = activeBackend;
    const agentId = agentOf(key);
    queueSessionBoardMutation(
      scope,
      () => pinSessionCanvas(backendId, agentId, key, spec),
      t("chat.widgetPinned"),
    );
  };
  const activeAdvancedDescription = advancedProbe?.key === activeKey
    ? advancedProbe.description
    : null;
  const activeAdvancedMethods = activeAdvancedDescription?.methods;
  const activeRunInFlight = sending || (activeKey ? runningKeys.has(activeKey) : false);
  const activeSessionArtifactResult = sessionArtifactState.key === activeKey
    ? sessionArtifactState.result
    : null;
  const sessionArtifactItems = activeSessionArtifactResult?.items ?? [];
  const sessionArtifactCount = activeSessionArtifactResult?.total ?? sessionArtifactItems.length;
  const agentHeaderScope = JSON.stringify([activeBackend, activeKey]);
  const activeAgentHeaderPanel = agentHeaderPanel?.scope === agentHeaderScope && !immersive
    ? agentHeaderPanel.kind : null;
  const toggleAgentHeaderPanel = (kind: ChatAgentPanelKind, trigger: HTMLButtonElement) => {
    agentHeaderTriggerRef.current = trigger;
    setSessionArtifactsOpen(false);
    setAgentHeaderPanel(activeAgentHeaderPanel === kind ? null : { scope: agentHeaderScope, kind });
  };

  useEffect(() => { setAgentHeaderPanel(null); }, [activeKey, activeBackend, immersive]);
  useLayoutEffect(() => {
    if (!activeAgentHeaderPanel) return;
    const header = agentHeaderRef.current;
    const conversation = header?.closest<HTMLElement>(".chat-conv");
    const row = header?.querySelector<HTMLElement>(".chat-header__row");
    if (!header || !conversation || !row) return;
    const composerDock = conversation.querySelector<HTMLElement>(".chat-botdock");
    const measure = () => {
      const composer = (composerDock?.querySelector<HTMLElement>("[data-chat-plan-dock]")
        ?? composerDock?.querySelector<HTMLElement>(".chat-composer"))?.getBoundingClientRect();
      const context = composerDock?.querySelector<HTMLElement>(".chat-ctx")?.getBoundingClientRect();
      // Always reserve the latest-message pill's 30px height and 20px gap.
      // Measuring the dock itself would make expansion and pill visibility
      // repeatedly resize each other when the last message is partly covered.
      const bottom = composer?.height ? (context?.height ? context.top : composer.top) - 50
        : conversation.getBoundingClientRect().bottom;
      // Leave room for the expansion's margins, header padding and a gap above
      // the composer, including its taller narrow-window / attachment states.
      const available = Math.max(0, Math.floor(bottom - row.getBoundingClientRect().bottom - 40));
      const value = `${available}px`;
      if (header.style.getPropertyValue("--chat-agent-panel-max-height") !== value) {
        header.style.setProperty("--chat-agent-panel-max-height", value);
      }
    };
    measure();
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => { frame = null; measure(); });
    });
    observer.observe(conversation);
    observer.observe(row);
    if (composerDock) observer.observe(composerDock);
    return () => { observer.disconnect(); if (frame !== null) cancelAnimationFrame(frame); };
  }, [activeAgentHeaderPanel]);
  useEffect(() => {
    if (!activeAgentHeaderPanel) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".chat-header, [role='dialog']")) return;
      setAgentHeaderPanel(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented
        || document.querySelector("[role='dialog'][aria-modal='true'], .session-menu")) return;
      setAgentHeaderPanel(null);
      agentHeaderTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [activeAgentHeaderPanel]);

  useEffect(() => {
    setSessionArtifactsOpen(false);
  }, [activeKey]);

  useLayoutEffect(() => {
    if (!sessionArtifactsOpen) return;
    const updatePosition = () => {
      const rect = sessionArtifactsTriggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const panelWidth = Math.min(380, window.innerWidth - 32);
      const maxRight = Math.max(16, window.innerWidth - panelWidth - 16);
      const right = Math.min(Math.max(window.innerWidth - rect.right, 16), maxRight);
      const top = Math.max(16, Math.min(rect.bottom + 10, window.innerHeight - 160));
      setSessionArtifactPopoverPosition({
        top,
        right,
        maxHeight: Math.min(560, Math.max(144, window.innerHeight - top - 16)),
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    return () => window.removeEventListener("resize", updatePosition);
  }, [sessionArtifactsOpen]);

  useEffect(() => {
    if (!sessionArtifactsOpen) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.(".chat-artifacts-popover, .chat-artifacts-trigger")) return;
      setSessionArtifactsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSessionArtifactsOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [sessionArtifactsOpen]);

  useEffect(() => {
    if (!sessionArtifactsOpen || !activeKey || activeRunInFlight) return;
    const controller = new AbortController();
    const key = activeKey;
    setSessionArtifactState((current) => ({
      key,
      status: "loading",
      result: current.key === key ? current.result : null,
    }));
    void listSessionArtifacts(activeBackend, agentOf(key), key, {
      limit: 50,
      signal: controller.signal,
    }).then((result) => {
      if (controller.signal.aborted || activeKeyRef.current !== key) return;
      setSessionArtifactState({ key, status: "done", result });
    }).catch((error) => {
      if (controller.signal.aborted || activeKeyRef.current !== key) return;
      setSessionArtifactState({
        key,
        status: "error",
        result: { supported: false, reason: error instanceof Error ? error.message : "error", items: [] },
      });
    });
    return () => controller.abort();
  }, [activeBackend, activeKey, activeRunInFlight, sessionArtifactReload, sessionArtifactsOpen]);

  const revealAttachmentFile = useCallback(async (file: { name: string; src?: string; path?: string }) => {
    try {
      if (file.path) await revealPath(file.path);
      else if (file.src) await revealAttachment(file.name, file.src);
      else throw new Error(t("chat.attachmentSourceMissing"));
    } catch (error) {
      setToast({ text: t("chat.artifactsRevealFailed", { msg: error instanceof Error ? error.message : String(error) }), kind: "error" });
      setTimeout(() => setToast(null), 2600);
    }
  }, [t]);

  const revealLocalFile = useCallback(async (filePath: string) => {
    try {
      await revealPath(filePath);
    } catch (error) {
      setToast({
        text: t("chat.artifactsRevealFailed", { msg: error instanceof Error ? error.message : String(error) }),
        kind: "error",
      });
      setTimeout(() => setToast(null), 2600);
    }
  }, [t]);

  useEffect(() => {
    const onMarkdownImageClick = (event: MouseEvent) => {
      const image = (event.target as HTMLElement)?.closest?.("img.markdown-inline-image") as HTMLImageElement | null;
      if (image) {
        event.preventDefault();
        if (image.complete && image.naturalWidth > 0) setLightbox({ src: image.src, kind: "image" });
        return;
      }
    };
    document.addEventListener("click", onMarkdownImageClick);
    return () => document.removeEventListener("click", onMarkdownImageClick);
  }, []);

  const nativeModelSelectionDisabled = activeBackendDescriptor?.surfaces.agentHarness === true
    && (runtimeModels.pending || !connected);
  const selectComposerModel = async (id: string, provider?: string, bindingId?: string) => {
    if (!usesRuntimeModelPicker) { await changeModel(id, provider); return; }
    if (!active || !bindingId || nativeModelSelectionDisabled) return;
    const key = active.key;
    if (await runtimeModels.select(id, bindingId, active.permissionMode ?? null)) {
      if (activeKeyRef.current === key) setPickedModel(null);
      await runtimeModels.refresh();
      await refreshSessions();
    }
  };
  // A conversation with no model of its own, and whose runtime marks none as its
  // default, starts on that runtime's first model, exactly as if it were picked
  // in the menu; a later manual choice replaces it. Tried once per conversation.
  const autoModelSessionsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const data = runtimeModels.data;
    if (!usesRuntimeModelPicker || !active || !data || data.selection.model || nativeModelSelectionDisabled
      || autoModelSessionsRef.current.has(active.key)) return;
    const choices = data.models.filter((model) => model.bindingId === data.selection.bindingId);
    if (choices.length === 0 || choices.some((model) => model.isDefault)) return;
    autoModelSessionsRef.current.add(active.key);
    void runtimeModels.select(choices[0].id, data.selection.bindingId, active.permissionMode ?? null, { quiet: true })
      .then((selected) => (selected ? refreshSessions() : undefined));
  }, [usesRuntimeModelPicker, active, runtimeModels, nativeModelSelectionDisabled, refreshSessions]);
  useEffect(() => {
    if (usesRuntimeModelPicker) void runtimeModels.refresh();
  }, [usesRuntimeModelPicker, runtimeModels.refresh, active?.thinkingLevel, active?.fastMode, active?.permissionMode]);
  const permissionOptions = (activeCaps?.permissions?.options ?? []).map((option) => localizePermissionMode(option, t));
  const activePermissionMode = active?.permissionMode
    || activeCaps?.permissions?.defaultMode
    || permissionOptions[0]?.id
    || "";
  const changePermissionMode = async (option: ChatPermissionModeOption) => {
    if (!activeKey) return;
    await patchSession({ permissionMode: option.id }, t("chat.labelPermission"));
  };
  const activeSendReady = canSendActiveSession(active?.key);
  const writerHintKey = active?.source === "codex-desktop" ? codexDesktopWriterHintKey(active.codexDesktopWriter) : null;
  const activeWriterHint = writerHintKey ? t(writerHintKey) : null;
  const activeRecoveryRequired = activeGroupId ? recoveryBackends.has(GROUP_NATIVE_BACKEND_ID)
    : active ? recoveryBackends.has(backendOfSession(active.key)) : recoveryBackends.size > 0;
  const recoveryNotice = activeRecoveryRequired
    ? `${t("settings.serviceRecoveryRequired")}. ${t("settings.serviceRecoveryHint")}` : null;
  useEffect(() => {
    if (!connected || active?.source !== "codex-desktop") return;
    const timer = window.setInterval(() => { void refreshSessions().catch(() => {}); }, 5000);
    return () => window.clearInterval(timer);
  }, [connected, active?.key, active?.source, refreshSessions]);
  const activeRecoveryHint = !active || activeSendReady
    ? null
    : activeBackendDescriptor?.connectionMode === "managed-service"
      ? t("chat.hermesConnecting")
      : activeBackendDescriptor?.connectionMode === "builtin-service"
          || activeBackendDescriptor?.connectionMode === "native-runtime"
        ? t("chat.backendRecovering", { backend: activeBackendDescriptor.name })
        : null;

  // composer 选择器显示「最近实际在用」的模型：OpenClaw 的 plan 可能逐条把请求路由/
  // 降级到不同底层模型，每条回答都记录了自己实际用的 model（与 footer 同一个值）。
  const lastAssistantModel = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && m.model && m.model !== "gateway-injected") return m.model;
    }
    return null;
  }, [messages]);
  const inheritedRuntimeDefault = useMemo(
    () => active?.model
      ? undefined
      : defaultModelForScope(selectableModels, activeCaps?.modelScope),
    [active?.model, activeCaps?.modelScope, selectableModels],
  );
  // 优先级：用户刚手动选的 > 最近回答的实际模型 > 会话配置模型 > 原生运行时默认模型。
  const selectedRuntimeModel = runtimeModels.data?.models.find(model => model.bindingId === runtimeModels.data?.selection.bindingId
    && (runtimeModels.data.selection.model ? model.id === runtimeModels.data.selection.model : model.isDefault));
  const displayModel = usesRuntimeModelPicker
    ? runtimeModels.data?.selection.model ?? selectedRuntimeModel?.id ?? active?.model ?? ""
    : pickedModel ?? lastAssistantModel ?? active?.model ?? inheritedRuntimeDefault?.id ?? "";
  const displayModelProvider = active?.modelProvider ?? inheritedRuntimeDefault?.provider;
  // 新回答回来后让位给实际模型；切换会话时重置手动选择。
  useEffect(() => {
    setPickedModel(null);
  }, [lastAssistantModel, activeKey]);

  // A cached session is not evidence that this backend has connected in this page.
  // Only a successful status sample can distinguish cold startup from a later loss.
  // Confirmed storage faults keep their separate recovery notice and send gate.
  const statusOf = (key: string): LiveStatus => {
    const backend = backendOfSession(key);
    if (disabledBackends.has(backend) || recoveryBackends.has(backend)) return "offline";
    if (!connected) return everConnected ? "reconnecting" : "connecting";
    if (startingBackends.has(backend) || !connectedBackends?.has(backend)) {
      return connectedOnceBackendsRef.current.has(backend) ? "reconnecting" : "connecting";
    }
    return runningKeys.has(key) ? (runStatusBySessionRef.current.get(key) === "queued" ? "queued" : "running") : "online";
  };
  const activeHeaderStatus = active ? statusOf(active.key) : null;
  // Agent-level (left rail): the agent is "running" if ANY of its sessions is.
  const agentStatusOf = (rows: SessionRow[]): LiveStatus => {
    if (!rows.length) return "offline";
    const activeRows = rows.filter((s) => runningKeys.has(s.key));
    if (activeRows.some((s) => runStatusBySessionRef.current.get(s.key) !== "queued")) return "running";
    if (activeRows.length) return "queued";
    return statusOf(rows[0].key);
  };
  // Pretty label for a thinking level (off→Off, xhigh→Extra high, …); unknown
  // levels fall back to capitalized raw so a newer gateway level still renders.
  const thinkLabel = (lvl: string) =>
    t(`chat.thinkLevel.${lvl}`, {
      defaultValue: THINK_LEVEL_LABELS[lvl] ?? lvl.charAt(0).toUpperCase() + lvl.slice(1),
    });
  // Compute anonymous identities before hiding/folding messages, so deleting one
  // duplicate cannot change another's key. Keep backend ids intact for search/fork.
  const actionableMessages = useMemo(() => keyedChatMessages(messages).map(({ item, key }) => ({
    ...item,
    actionId: item.id || (item.pending || item.divider || item.notice ? undefined : `local:${key}`),
  })), [messages]);
  // Retain transcript snapshots for recovery/search, but render plans only above the input.
  const historyPlan = useMemo(() => latestChatPlan(messages), [messages]);
  const activePlan = activeKey ? pendingPlanRef.current.get(activeKey) ?? historyPlan : [];
  const planDock = activeKey && activePlan.length ? (
    <ChatPlanDock key={activeKey} entries={activePlan} expanded={expandedPlans[activeKey] ?? false}
      onToggle={() => setExpandedPlans((previous) => ({ ...previous, [activeKey]: !previous[activeKey] }))} />
  ) : null;

  useLayoutEffect(() => {
    const thread = threadRef.current;
    const dock = thread?.parentElement?.querySelector<HTMLElement>(".chat-botdock");
    if (!thread || !dock || immersive) return;
    const headerRow = thread.parentElement?.querySelector<HTMLElement>(".chat-header__row");
    // Exclude the optional jump pill: its visibility must not move its own measurement boundary.
    const measure = () => {
      const inputTop = dock.querySelector<HTMLElement>(".chat-composer")?.getBoundingClientRect().top;
      if (inputTop != null) {
        const headerBottom = headerRow?.getBoundingClientRect().bottom ?? thread.getBoundingClientRect().top + 116;
        const space = Math.max(0, inputTop - headerBottom);
        // On a short/narrow conversation, reserve readable message space above the plan.
        dock.style.setProperty("--chat-plan-body-max", `${Math.max(24, Math.floor(space - 56 - Math.min(220, space * .7)))}px`);
      }
      const top = (dock.querySelector<HTMLElement>("[data-chat-plan-dock]")
        ?? dock.querySelector<HTMLElement>(".chat-composer"))?.getBoundingClientRect().top;
      if (top == null) return;
      const clearance = Math.max(0, Math.ceil(thread.getBoundingClientRect().bottom - top));
      const value = `${clearance}px`;
      if (thread.style.getPropertyValue("--chat-fade-bottom") === value) return;
      const wasAtBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 32;
      thread.style.setProperty("--chat-fade-bottom", value);
      thread.style.setProperty("--chat-thread-bottom", `${clearance + 44}px`);
      if (wasAtBottom && !sendAnchorRef.current) thread.scrollTop = thread.scrollHeight;
      updateJumpVisibility();
    };
    measure();
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => { frame = null; measure(); });
    });
    observer.observe(dock);
    observer.observe(thread);
    if (headerRow) observer.observe(headerRow);
    return () => { observer.disconnect(); if (frame !== null) cancelAnimationFrame(frame); };
  }, [activeKey, immersive, sessionBoardViewMode, updateJumpVisibility]);
  const groups = useMemo(
    () => {
      const grouped = groupMessages(
        collapseErrorRuns(
          // R339:先吸收已完成回合的过程为 timeline part,再折叠错误重复。
          // lastTurnStepsRef 是 ref(不进 deps):final 后的 loadHistory 会 setMessages,
          // 本 memo 随之重算并读到最新留档,时序天然成立。
          absorbTurnTimelines(
            chatMessagesWithoutPlans(actionableMessages.filter((m) => !(m.actionId && hiddenIds.has(m.actionId)) && !isHeartbeatNoise(m) && m.automation !== "continuation")),
            lastTurnStepsRef.current.get(activeKeyRef.current || ""),
          ),
        ),
      );
      // Keep hidden inter-session inputs through turn folding/grouping so they still
      // separate adjacent assistant turns, then remove only their visual projection.
      return grouped.flatMap((group) => {
        const msgs = group.msgs.filter(
          (message) => !isInterSessionUserMessage(message, msgText(message))
            && !isScheduledCronUserMessage(message, msgText(message)),
        );
        return msgs.length > 0 ? [{ ...group, msgs, ts: msgs[0].ts }] : [];
      });
    },
    [actionableMessages, hiddenIds],
  );
  turnStartByMessageRef.current = useMemo(() => new Map(groups.flatMap(group => group.msgs.flatMap(message =>
    message.actionId && message.turnStartId ? [[message.actionId, message.turnStartId] as const] : []))), [groups]);
  // The thread only has its explicit pinned-only filter. Global search lives in
  // a modal and never mutates the active message projection.
  const shownGroups = useMemo(
    () => MESSAGE_PINNING_ENABLED && pinnedOnly
      ? groups.filter((g) => g.msgs.some((m) => m.actionId && pinnedIds.has(m.actionId)))
      : groups,
    [groups, pinnedOnly, pinnedIds],
  );
  // 先按稳定内容生成基础身份，再只对同级碰撞追加局部 occurrence；普通与沉浸模式共用同一份 key。
  const keyedShownGroups = useMemo(() => keyedChatGroups(shownGroups), [shownGroups]);
  const modalTimeline = timelineModal?.sessionKey === activeKey ? timelineModal : null;
  const modalSteps = modalTimeline ? subagentActivity.project(modalTimeline.sessionKey,
    modalTimeline.timeline ? visibleTimelineSteps(modalTimeline.timeline.steps) : modalTimeline.steps, modalTimeline.runId) : [];
  const modalStatus = modalTimeline?.timeline?.status ?? "done";
  // The native host shows one document per window. Restore the newest card
  // directly instead of letting older history mounts replace it asynchronously.
  const latestNativeUiSourceEventId = useMemo(() => {
    for (let gi = shownGroups.length - 1; gi >= 0; gi--) {
      const messages = shownGroups[gi].msgs;
      for (let mi = messages.length - 1; mi >= 0; mi--) {
        const parts = messages[mi].parts;
        for (let pi = parts.length - 1; pi >= 0; pi--) {
          const part = parts[pi];
          if (part.type === "ui_artifact" && part.uiArtifact) return part.uiArtifact.sourceEventId;
        }
      }
    }
    return undefined;
  }, [shownGroups]);
  // A part key hashes its complete structured payload, including hidden tool
  // timelines. Composer and toolbar state must not repeatedly serialize the
  // settled transcript. Rebuild only when its projection changes; keep the same
  // key helpers so streaming slots, duplicate ids and archive prepends retain
  // their existing identity rules.
  const keyedThreadGroups = useMemo(() => keyedShownGroups.map((group) => ({
    ...group,
    messages: keyedChatMessages(group.item.msgs).map((message) => ({
      ...message,
      images: message.item.images?.length ? keyedChatChildren(message.item, "image", message.item.images) : [],
      files: message.item.files?.length ? keyedChatChildren(message.item, "file", message.item.files) : [],
      parts: keyedChatChildren(message.item, "part", message.item.parts),
    })),
  })), [keyedShownGroups]);
  const latestAssistantMessageKey = useMemo(() => {
    for (let gi = keyedThreadGroups.length - 1; gi >= 0; gi -= 1) {
      const group = keyedThreadGroups[gi];
      if (group.item.role !== "assistant") continue;
      for (let mi = group.messages.length - 1; mi >= 0; mi -= 1) {
        const message = group.messages[mi];
        if (message.item.parts.some((part) => part.type === "text" && part.text?.trim())) return message.key;
      }
    }
    return undefined;
  }, [keyedThreadGroups]);
  const matchedSearchTargetGroupKey = useMemo(() => {
    if (!pendingSearchJump || activeKey !== pendingSearchJump.key) return undefined;
    return findChatSearchGroupKey(keyedShownGroups, pendingSearchJump);
  }, [activeKey, keyedShownGroups, pendingSearchJump]);

  // Consume a search jump only after canonical history has rendered. Ref
  // callbacks are committed before layout effects, so this lands on the exact
  // group without a visible bottom-to-target flash.
  useLayoutEffect(() => {
    if (!pendingSearchJump || !historyLoaded || activeKey !== pendingSearchJump.key
      || !matchedSearchTargetGroupKey) return;
    const target = groupRefs.current.get(matchedSearchTargetGroupKey);
    if (!target) return;
    cancelInitialScroll();
    if (searchTargetClearTimerRef.current) clearTimeout(searchTargetClearTimerRef.current);
    setSearchTargetGroupKey(matchedSearchTargetGroupKey);
    target.scrollIntoView({ block: "center", behavior: "auto" });
    atBottomRef.current = false;
    pendingSearchJumpKeyRef.current = null;
    searchJumpRequestTokenRef.current = null;
    setPendingSearchJump(null);
    searchTargetClearTimerRef.current = setTimeout(() => setSearchTargetGroupKey(null), 1600);
  }, [activeKey, historyLoaded, matchedSearchTargetGroupKey, pendingSearchJump]);

  useLayoutEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    // Message wrappers use display:contents, so measure their rendered children.
    // Skip empty (hidden tool/thinking) messages, without treating an entire
    // same-role group as the last message.
    const messageNodes = thread.querySelectorAll("[data-message-key]");
    latestMessagePartsRef.current = [];
    for (let i = messageNodes.length - 1; i >= 0; i--) {
      const parts = Array.from(messageNodes[i].children).filter((part) => part.getClientRects().length > 0);
      if (!parts.length) continue;
      latestMessagePartsRef.current = parts;
      break;
    }
    updateJumpVisibility();
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => { frame = null; updateJumpVisibility(); });
    });
    const targets = [thread, thread.firstElementChild,
      thread.parentElement?.querySelector(".chat-topdock"),
      thread.parentElement?.querySelector(".chat-botdock")];
    for (const target of targets) if (target) observer.observe(target);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      latestMessagePartsRef.current = [];
    };
  }, [activeKey, keyedThreadGroups, showThinking, showTools, showTraj, immersive, sessionBoardViewMode, updateJumpVisibility]);

  useEffect(() => () => {
    if (searchTargetClearTimerRef.current) clearTimeout(searchTargetClearTimerRef.current);
  }, []);

  // A normal tail page may not contain an older OpenClaw hit. Backends that
  // return physical session/message ids can use the same chat.history RPC to
  // request a bounded window around that exact message. Backends without those
  // ids rely on the snippet matcher above after their full history loads.
  useEffect(() => {
    if (!pendingSearchJump || !historyLoaded || activeKey !== pendingSearchJump.key
      || matchedSearchTargetGroupKey) return;
    const target = pendingSearchJump;
    if (!target.sessionId || !target.messageId) {
      pendingSearchJumpKeyRef.current = null;
      setPendingSearchJump(null);
      setToast({ text: t("chat.globalSearchLocateFailed"), kind: "error" });
      setTimeout(() => setToast(null), 2600);
      return;
    }
    if (searchJumpRequestTokenRef.current === target.token) return;
    searchJumpRequestTokenRef.current = target.token;
    void (async () => {
      try {
        const response = await send("chat.history", {
          sessionKey: target.key,
          agentId: target.agentId,
          sessionId: target.sessionId,
          messageId: target.messageId,
          limit: 1000,
        });
        const raw = response?.payload?.messages;
        if (!Array.isArray(raw)) throw new Error("chat.history returned no messages array");
        const prepared = await prepareHistoryMessages(target.key, raw);
        if (!prepared.some((message) => message.id === target.messageId)) {
          throw new Error("target message missing from history window");
        }
        if (searchJumpTokenRef.current !== target.token || activeKeyRef.current !== target.key) return;
        const visible = decorateHistoryWithLiveState(target.key, prepared);
        archivePrefixRef.current = { key: "", msgs: [] };
        archivePagesRef.current = null;
        archiveGenerationRef.current++;
        historyPager.reset(target.key);
        const earlier = { key: target.key, cursor: null, loading: false, error: false };
        earlierHistoryRef.current = earlier; setEarlierHistory(earlier);
        setArchive({ key: target.key, status: "loaded", count: 0 });
        messagesRef.current = visible;
        setMessages(visible);
        historyLoadedRef.current = true;
        historyVisibleRef.current = true;
        setHistoryLoaded(true);
        setHistoryVisible(true);
        setHistoryError(null);
        searchHistoryWindowKeyRef.current = target.key;
      } catch {
        if (searchJumpTokenRef.current !== target.token || activeKeyRef.current !== target.key) return;
        pendingSearchJumpKeyRef.current = null;
        searchJumpRequestTokenRef.current = null;
        setPendingSearchJump(null);
        setToast({ text: t("chat.globalSearchLocateFailed"), kind: "error" });
        setTimeout(() => setToast(null), 2600);
      }
    })();
  }, [activeKey, decorateHistoryWithLiveState, historyLoaded, matchedSearchTargetGroupKey,
    historyPager, pendingSearchJump, prepareHistoryMessages, send, t]);
  // 沉浸模式消息流：把 shownGroups 预渲染成简单判别联合（ImmersiveMessage），避免 ImmersiveChat
  // 耦合 ChatPage 内部 Group/ChatMsg 类型。正文/图片/非图附件之外，错误泡（×N/hover 原文/重试）、
  // 注入灰条（per-message 判定——旧版整组丢弃会连累相邻真实消息一起消失）、封存/模型切换分隔线、
  // 审批卡、流式光标及已保存回合动态随判别字段带过去；直播过程仍由轻量状态行呈现。
  // 交互用无参闭包（onRetry），Group 本体不出 ChatPage；闭包不进 deps——memo 随 keyedShownGroups
  // （即 messages）重算，捕获的总是当轮的新函数。
  const immersiveMessages = useMemo(() => {
    if (!immersive) return [];
    const out: ImmersiveMessage[] = [];
    for (const { item: g, key: groupRenderKey } of keyedShownGroups) {
      // 封存分隔线 / 模型切换提示行（parts 为空，旧版被「有正文才保留」过滤吃掉）
      if (g.msgs.length === 1 && (g.msgs[0].divider || g.msgs[0].notice)) {
        const n = g.msgs[0];
        const d = n.divider;
        const when = d?.sealedAt ? absTime(d.sealedAt) : "";
        out.push({
          id: groupRenderKey,
          role: "system",
          kind: "divider",
          html: "",
          images: [],
          footer: "",
          dividerLabel: d
            ? `${d.fromReset ? t("chat.archiveResetAt", { time: when }) : t("chat.archiveEarlierAt", { time: when })}${d.truncated ? ` · ${t("chat.archiveTruncated")}` : ""}`
            : n.notice === "runInterrupted" ? t("chat.runInterruptedNotice")
              : `${t("chat.modelSwitchedNotice")}${n.model ? ` · ${n.model}` : ""}`,
          dividerTitle: d ? undefined : n.parts.find((p) => p.text)?.text || undefined,
        });
        continue;
      }
      // 逐条分类：错误 / 本地 slash 结果 / 注入伪 user 各自成段，普通对话连续消息并成一段
      type Seg = { cls: "chat" | "injected" | "error" | "local"; msgs: ChatMsg[] };
      const segs: Seg[] = [];
      for (const m of g.msgs) {
        const cls: Seg["cls"] =
          m.local
            ? "local"
            : m.role === "system" || isErrorTurn(m)
              ? "error"
              : m.role === "user" && isInjectedPrompt(m)
                ? "injected"
                : "chat";
        const lastSeg = segs[segs.length - 1];
        if (lastSeg && lastSeg.cls === "chat" && cls === "chat" && m.actionId !== unreadAnchor?.messageId
          && !m.parts.some(part => part.type === "timeline")) lastSeg.msgs.push(m);
        else segs.push({ cls, msgs: [m] });
      }
      // 时间常显，模型随消息操作显隐；挂在组的最后一个保留段上。
      const last = g.msgs[g.msgs.length - 1];
      const ts = g.ts ?? last?.ts;
      const model = last?.model && last.model !== "gateway-injected" ? last.model : "";
      const metadata = [...g.msgs].reverse().find(message => message.responseMetadata)?.responseMetadata;
      const footer = ts ? absTime(ts) : "";
      const footerModel = metadata?.models?.length || model
        ? <ChatResponseMetadata metadata={metadata} fallbackModel={model} /> : undefined;

      const entries: ImmersiveMessage[] = [];
      segs.forEach((seg, si) => {
        const segId = segs.length === 1 ? groupRenderKey : `${groupRenderKey}:s${si}`;
        const m0 = seg.msgs[0];
        const segText = seg.msgs
          .flatMap((m) => m.parts.filter((p) => p.type === "text").map((p) => p.text || ""))
          .join("\n")
          .trim();
        if (seg.cls === "injected") {
          if (!segText) return;
          const head = segText.replace(/\s+/g, " ").trim();
          entries.push({
            id: segId,
            role: "user",
            kind: "injected",
            html: toSanitizedMarkdownHtml(segText, true),
            images: [],
            footer: "",
            injectedHead: head.length > 96 ? `${head.slice(0, 96)}…` : head,
          });
          return;
        }
        if (seg.cls === "error") {
          if (!segText && !m0.errPrefix) return;
          // 与普通模式同一套渲染时翻译：已知网关错误串 i18n 化，英文原文留 hover
          const translated = segText ? translateGatewayError(segText, t) : "";
          entries.push({
            id: segId,
            role: String(m0.role),
            kind: "error",
            unreadStart: m0.actionId === unreadAnchor?.messageId,
            html: "",
            images: [],
            footer: "",
            errorText: m0.errPrefix ? t(m0.errPrefix, { msg: translated || t("chat.unknown") }) : translated,
            errorRaw: translated !== segText && segText ? segText : undefined,
            errorRepeat: m0.repeat,
            onRetry: () => retryErrorGroup(g),
            onCopy: segText ? () => copyText(segText) : undefined,
            onDelete: g.msgs.some((m) => m.actionId) ? () => deleteGroup(g) : undefined,
            onCtx: (e) => openMenu(e, g, segText),
          });
          return;
        }
        // chat / local：assistant 的 MEDIA:<path/url> 指令行 → 图片（与普通模式同一解析）
        const media = g.role === "assistant" && seg.cls === "chat" ? extractAgentMedia(segText, imageContext) : { text: segText, srcs: [] as string[] };
        const segImages = seg.msgs.flatMap((m) => m.images ?? []);
        const segFiles = seg.msgs.flatMap((m) => m.files ?? []);
        const prompts = seg.msgs.flatMap((m) =>
          m.parts.filter((p) => p.type === "prompt" && p.promptEntry).map((p) => p.promptEntry as ChatPromptEntry),
        );
        const liveMessage = seg.msgs.find(message => message.pending || message.settledPending);
        const liveSteps = liveMessage ? liveStepsFor(liveMessage) : [];
        const liveToolIds = new Set(liveSteps.map(step => step.toolCallId).filter(Boolean));
        const processes = showTraj ? seg.msgs.flatMap(message => keyedChatChildren(message, "part", message.parts)
          .flatMap(({ item: part, key }) => {
            if (part.type !== "timeline" || !part.steps?.length) return [];
            const tools = part.steps.filter(step => step.kind === "tool");
            if (tools.length && tools.every(step => step.toolCallId && liveToolIds.has(step.toolCallId))) return [];
            if (!tools.length && part.steps.every(step => step.activity && liveSteps.some(live => live.id === step.id))) return [];
            const steps = subagentActivity.project(activeKey || "", part.steps, message.activityRunId || message.nativeRunId);
            return [<TurnProcess key={key} steps={steps} onOpenLargeView={() => openTimelineModal(steps, message.ts, false, message.activityRunId || message.nativeRunId)} />];
          })) : [];
        if (showTraj && liveSteps.length) processes.push(<TurnProcess key={`${segId}:live-trajectory`} steps={liveSteps}
          live={liveMessage?.pending} defaultOpen onOpenLargeView={() => openTimelineModal(liveSteps, liveMessage?.ts, true)} />);
        const hasId = g.msgs.some((m) => m.actionId);
        entries.push({
          id: segId,
          role: String(g.role),
          kind: seg.cls === "local" ? "local" : "chat",
          unreadStart: seg.msgs.some(m => m.actionId === unreadAnchor?.messageId),
          process: processes.length ? processes : undefined,
          html: media.text.trim() ? toSanitizedMarkdownHtml(media.text, true, imageContext,
            g.role === "assistant" && seg.cls === "chat" ? activeLegacyHtmlPolicy : "source") : "",
          images: [...segImages, ...media.srcs],
          files: segFiles.length ? segFiles : undefined,
          pluginSelectionLabel: seg.msgs.some(m => m.pluginSelection?.length)
            ? `${t("chat.pluginChosen")} · ${seg.msgs.flatMap(m =>
              m.pluginSelectionSnapshot?.map(item => `${item.packageName}${item.declaredVersion ? ` ${item.declaredVersion}` : ""}`) ?? []).join("、")
                || seg.msgs.flatMap(m => m.pluginSelection ?? []).length}` : undefined,
          footer: "",
          content: seg.msgs.some(m => m.parts.some(p => p.type === "ui_artifact"))
            || (activeBackendDescriptor?.surfaces.agentHarness === true && g.role === "assistant" && seg.cls === "chat")
            ? seg.msgs.flatMap(m => [
              ...keyedChatChildren(m, "part", m.parts).flatMap(({ item: p, key }) =>
                p.type === "ui_artifact" && p.uiArtifact
                  ? [<ChatUiArtifact key={key} part={p.uiArtifact} backend={activeBackend} agentId={agentOf(activeKey || "")} sessionKey={activeKey || ""} visible autoActivate={p.uiArtifact.sourceEventId === latestNativeUiSourceEventId} onCancel={runId => send("chat.abort", { sessionKey: activeKey, runId })} />]
                  : p.type === "text" && p.text ? [<ChatMarkdown key={key} text={p.text} htmlArtifactPolicy="source" className="chat-md" />] : []),
              ...(activeBackendDescriptor?.surfaces.agentHarness === true
                ? nativeUiLegacySources(m).map(({ text, sourceEventId }) => <LegacyChatUi key={`legacy:${sourceEventId}`} text={text}
                  sourceEventId={sourceEventId} backend={activeBackend} agentId={agentOf(activeKey || "")} sessionKey={activeKey || ""} visible />) : []),
            ]) : undefined,
          pending: (seg.msgs.some((m) => m.pending) && !chatPromptAttentionOf(prompts)) || undefined,
          prompts: prompts.length ? prompts : undefined,
          // 悬浮操作/右键：无参闭包捕获 Group，动作与普通模式同一套 handler
          onCopy: segText ? () => copyText(segText) : undefined,
          onPin: MESSAGE_PINNING_ENABLED && hasId ? () => pinGroup(g) : undefined,
          pinned: MESSAGE_PINNING_ENABLED && hasId ? g.msgs.some((m) => m.actionId && pinnedIds.has(m.actionId)) : undefined,
          onDelete: hasId ? () => deleteGroup(g) : undefined,
          onCtx: (e) => openMenu(e, g, segText),
        });
      });
      // 空段（纯 thinking/工具轮次）不保留；审批卡在正文之前到达时靠 prompts 保住 pending 段
      const kept = entries.filter((e) =>
        e.kind !== "chat" && e.kind !== "local"
          ? true
          : !!e.process || !!e.html || !!e.content || e.images.length > 0 || (e.files?.length ?? 0) > 0 || (e.prompts?.length ?? 0) > 0,
      );
      if (kept.length && (footer || footerModel)) kept[kept.length - 1] = { ...kept[kept.length - 1], footer, footerModel };
      out.push(...kept);
    }
    return out;
  }, [immersive, keyedShownGroups, unreadAnchor, latestNativeUiSourceEventId, pinnedIds, t, imageContext, activeLegacyHtmlPolicy, activeBackend, activeKey, activeBackendDescriptor?.surfaces.agentHarness, showTraj, subagentRevision, subagentActivity]);
  // 沉浸模式的 agent 状态相位（背景媒体层 + 轻量状态行共用）。判据全部是「事件到没到」，
  // 零后端特判（铁律 1）：OpenClaw 不发 thinking/prompt 事件 → 对应相位自然不出现，由
  // 素材回退链兜退化。这是未滞回的原始相位——防抖/最短展示在 ImmersiveBackdrop 内做
  // （状态行要跟手，背景要稳，两边取用不同）。
  const immersivePhase = useMemo((): ImmersivePhase => {
    if (!active) return "offline";
    const backend = backendOfSession(active.key);
    if (!connected) return "offline";
    if (connectedBackends != null && !connectedBackends.has(backend)) {
      return "offline";
    }
    const last = messages[messages.length - 1];
    if (last?.pending) {
      const parts = last.parts;
      if (parts.some((p) => p.type === "prompt")) return "waiting"; // 阻塞等审批/澄清/sudo/密钥
      if (parts.some((p) => p.type === "toolCall")) return "tool"; // 有未完成的工具调用
      if (parts.some((p) => p.type === "text" && !!p.text?.trim())) return "responding";
      if (parts.some((p) => p.type === "thinking" && !!p.text?.trim())) return "thinking";
      return "waiting"; // 已发出、事件还没到
    }
    if (sending) return "waiting";
    if (last && !last.notice && (last.role === "system" || isErrorTurn(last))) return "error";
    return "idle";
  }, [active, connected, connectedBackends, startingBackends, messages, sending]);
  // 轻量状态行的原料：末尾 pending 泡 parts 里的工具/思考流。liveToolsRef/
  // pendingThinkingRef 的每次变更都经 applyToolStream 回流进 messages，这里纯派生、
  // 零新订阅。没有过程信息（OpenClaw 首包前）返回 null → 沉浸层继续用三点等待。
  const immersiveLive = useMemo((): ImmersiveLiveStatus | null => {
    if (activeKey && activeRunInFlight && runWaitBySession[activeKey]?.kind === "retrying") {
      return { tools: [], wait: runWaitBySession[activeKey] };
    }
    const last = messages[messages.length - 1];
    if (!last?.pending) return null;
    const tools: ImmersiveLiveTool[] = stepsFromParts(last.parts, { live: true }).filter(step => step.kind === "tool").map(step => ({
      name: step.toolName || "", title: toolActivityTitle(step.toolName, step.args, t),
      done: step.status !== "running", isError: step.isError, durationS: step.durationS,
    }));
    let thinkingText = "";
    for (const p of last.parts) {
      if (p.type === "thinking" && p.text?.trim()) thinkingText = p.text;
    }
    if (!tools.length && !thinkingText) return null;
    return { tools, thinkingText: thinkingText || undefined };
  }, [messages, activeKey, activeRunInFlight, runWaitBySession, t]);
  // Loaded pinned messages, in thread order, for the single-line pin carousel. Pins to
  // not-yet-loaded (very old) messages simply don't appear until scrolled into range.
  const pinnedList = useMemo(
    () =>
      groups
        .map((g) => {
          const id = g.msgs.find((m) => m.actionId && pinnedIds.has(m.actionId))?.actionId;
          return id ? { id, text: groupSnippet(g) } : null;
        })
        .filter((x): x is { id: string; text: string } => !!x),
    [groups, pinnedIds],
  );

  // Thinking dropdown is model-aware. `reasoning` rides on the model catalog
  // (UnifiedModel) → only reasoning models get a thinking selector. xhigh is a
  // per-model gateway decision with no read RPC, so it's probed + cached at runtime
  // (lib/thinkingCapability). Scoped to OpenClaw — Hermes rejects sessions.patch.
  const activeModelInfo = useMemo(
    () => usesRuntimeModelPicker ? selectedRuntimeModel : selectableModels.find((m) => m.id === (active?.model ?? inheritedRuntimeDefault?.id)),
    [usesRuntimeModelPicker, selectedRuntimeModel, active?.model, inheritedRuntimeDefault?.id, selectableModels],
  );
  const activeThinkingOptions = usesRuntimeModelPicker ? activeModelInfo?.thinkingOptions : active?.thinkingOptions ?? activeModelInfo?.thinkingOptions;
  const activeThinkingDefault = usesRuntimeModelPicker ? activeModelInfo?.thinkingDefault : active?.thinkingDefault ?? activeModelInfo?.thinkingDefault;
  const activeIsReasoning = activeModelInfo?.reasoning === true;
  // ⚡ 显示门槛（能力驱动，无后端特判）：目录声明 fast 能力（Hermes capabilities.fast）
  // 直接开；能力未知（OpenClaw 不带该字段）沿用旧口径 reasoning 模型才显示；
  // 显式 false（Hermes 非 fast 模型）隐藏。
  const activeFastCapable =
    activeModelInfo?.fast === true || (activeModelInfo?.fast === undefined && activeIsReasoning);
  const activeIsOpenClaw = !!activeKey && backendOfSession(activeKey) === "openclaw";
  const xhighKey = active?.model
    ? `${active.modelProvider || activeModelInfo?.provider || ""}:${active.model}`
    : "";
  const xhighSupported = xhighKey ? xhighOk[xhighKey] === true : false;

  // Learn xhigh support for the active OpenClaw reasoning model once, then cache it.
  useEffect(() => {
    if (!activeIsOpenClaw || !activeIsReasoning || !xhighKey || xhighKey in xhighOk) return;
    const cached = readXHighCache(xhighKey);
    if (cached !== undefined) {
      setXhighOk((m) => ({ ...m, [xhighKey]: cached }));
      return;
    }
    const key = active?.key;
    if (!key) return;
    const priorLevel = active?.thinkingLevel ?? null;
    let cancelled = false;
    void (async () => {
      try {
        const supported = await probeXHigh(send, key, priorLevel);
        if (cancelled) return;
        writeXHighCache(xhighKey, supported);
        setXhighOk((m) => ({ ...m, [xhighKey]: supported }));
      } catch {
        // transient (network / unrelated error) → leave unknown, retry on next focus
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeIsOpenClaw, activeIsReasoning, xhighKey, xhighOk, send, active?.key, active?.thinkingLevel]);

  // Debounce the first page and invalidate every older page request when the
  // modal closes or the query changes.
  useEffect(() => {
    const q = globalSearchQuery.trim();
    const token = ++globalSearchTokenRef.current;
    globalSearchMoreAbortRef.current?.abort();
    globalSearchMoreAbortRef.current = null;
    if (!globalSearchOpen || !q) {
      setGlobalSearch({ status: "idle", data: null, loadingMore: false, loadMoreError: false });
      return;
    }
    const controller = new AbortController();
    setGlobalSearch({ status: "loading", data: null, loadingMore: false, loadMoreError: false });
    const timer = setTimeout(async () => {
      try {
        const data = await searchGlobalChats(q, {
          limit: GLOBAL_SEARCH_PAGE_SIZE,
          offset: 0,
          signal: controller.signal,
        });
        if (!controller.signal.aborted && globalSearchTokenRef.current === token) {
          setGlobalSearch({ status: "done", data, loadingMore: false, loadMoreError: false });
        }
      } catch (error) {
        if (!controller.signal.aborted && globalSearchTokenRef.current === token
          && (error as { name?: string })?.name !== "AbortError") {
          setGlobalSearch({ status: "error", data: null, loadingMore: false, loadMoreError: false });
        }
      }
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [globalSearchOpen, globalSearchQuery]);

  const loadMoreGlobalSearch = useCallback(async () => {
    const q = globalSearchQuery.trim();
    const data = globalSearch.data;
    if (!globalSearchOpen || !q || globalSearch.status !== "done" || !data?.hasMore
      || data.nextOffset == null || globalSearch.loadingMore) return;
    const token = globalSearchTokenRef.current;
    const controller = new AbortController();
    globalSearchMoreAbortRef.current?.abort();
    globalSearchMoreAbortRef.current = controller;
    setGlobalSearch((current) => ({ ...current, loadingMore: true, loadMoreError: false }));
    try {
      const page = await searchGlobalChats(q, {
        limit: GLOBAL_SEARCH_PAGE_SIZE,
        offset: data.nextOffset,
        signal: controller.signal,
      });
      if (controller.signal.aborted || globalSearchTokenRef.current !== token) return;
      setGlobalSearch((current) => {
        if (current.status !== "done" || !current.data || current.data.query !== page.query) return current;
        const seen = new Set(current.data.results.map(globalSearchHitIdentity));
        const appended = page.results.filter((hit) => !seen.has(globalSearchHitIdentity(hit)));
        return {
          status: "done",
          loadingMore: false,
          loadMoreError: false,
          data: { ...page, offset: 0, results: [...current.data.results, ...appended] },
        };
      });
    } catch (error) {
      if (!controller.signal.aborted && globalSearchTokenRef.current === token
        && (error as { name?: string })?.name !== "AbortError") {
        setGlobalSearch((current) => ({ ...current, loadingMore: false, loadMoreError: true }));
      }
    } finally {
      if (globalSearchMoreAbortRef.current === controller) globalSearchMoreAbortRef.current = null;
    }
  }, [globalSearch.data, globalSearch.loadingMore, globalSearch.status, globalSearchOpen, globalSearchQuery]);

  // The existing results box is the scroll container. A bottom sentinel avoids
  // per-pixel scroll handlers and loads exactly one page at a time.
  useEffect(() => {
    if (!globalSearchOpen || globalSearch.status !== "done" || !globalSearch.data?.hasMore
      || globalSearch.loadingMore || globalSearch.loadMoreError) return;
    const root = globalSearchResultsRef.current;
    const sentinel = globalSearchSentinelRef.current;
    if (!root || !sentinel) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void loadMoreGlobalSearch();
    }, { root, rootMargin: "120px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [globalSearch.data?.hasMore, globalSearch.loadMoreError, globalSearch.loadingMore,
    globalSearch.status, globalSearchOpen, loadMoreGlobalSearch]);

  // The active session's last REAL (non-heartbeat, non-error) message time, straight from the
  // loaded thread (accurate + live). Used by the selected session's header/menu;
  // the agent list ranks across foreground sessions independently of this selection.
  const activeRealTime = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (isRealActivity(m)) return m.ts ?? 0;
    }
    return 0;
  }, [messages]);
  // The active agent's sub-line + ROW TIME, derived from the SAME live thread (no separate
  // fetch): the last thread-VISIBLE message with text（错误泡也算——点开看到什么，行就预览什么、
  // 标什么时候）。返回 {text, ts}：text 进副标题，ts 进行时间显示——两者永远说同一条消息。
  // agents memo 的 rowTime 只用于活跃行的时间显示；排序由跨前台会话的 rank 决定。
  const activeRealPreview = useMemo(() => latestHistoryPreview(messages), [messages]);
  // The left list shows one entry PER AGENT (sessions grouped by agent id); the
  // active agent's individual sessions are switched from the header instead.
  // 活跃线程加载后，把它的预览文本/时间写穿到 previews/previewTimes（探针跳过活跃 agent，
  // 否则刚切换过会话的 agent 在变为非活跃的瞬间查不到 previewTimes[chosenKey]，行会闪一下
  // 跌到 rank、再被探针补扫拉回）。写穿后活跃→非活跃切换两个分支读到同一个值，零跳变。
  useEffect(() => {
    if (!activeKey || !historyLoaded) return;
    recordHistoryPreview(activeKey, messages);
  }, [activeKey, historyLoaded, messages, recordHistoryPreview]);

  // 群成员在群里用的内部会话不进入普通会话列表（原生的由服务端过滤，外部后端的在这里排除）。
  const groupInternalKeys = useMemo(() => new Set(allGroupChats.flatMap((gc) => Array.isArray(gc.internalSessionKeys)
    ? gc.internalSessionKeys : [])), [allGroupChats]);
  // updatedAt only schedules an authority read: metadata and heartbeat acks are not unread.
  // Only catalogued sessions qualify, so broadcast-only cron keys cannot create phantom badges.
  const unreadProbedRef = useRef(new Map<string, number>());
  useEffect(() => {
    if (!connected || !listLive) return;
    let stopped = false;
    void (async () => {
      for (const row of sessions) {
        if (stopped) break;
        const revision = row.updatedAt ?? 0;
        if (runningKeys.has(row.key) || isSessionReplyPending(row)) {
          unreadProbedRef.current.delete(row.key); // Completion may retain the same list timestamp.
          continue;
        }
        if (groupInternalKeys.has(row.key) || !supportsSessionUnread(row.key, row.kind)
          // Old Cron results still supply latest-result navigation; the unread cutoff
          // is applied separately when displaying badges.
          || (sessionKindOf(row.key, row.kind) !== "cron"
            && revision <= sessionReadAt(unreadStateRef.current, row.key, row.kind))
          || unreadProbedRef.current.get(row.key) === revision) continue;
        unreadProbedRef.current.set(row.key, revision);
        try {
          const res = await send("chat.history", { sessionKey: row.key, limit: 150, maxChars: 320 });
          if (!Array.isArray(res?.payload?.messages)) throw new Error("Missing history");
          if (sessionsRef.current.some(s => s.key === row.key)) {
            const msgs = res.payload.messages.map(normalize);
            if (!observeReply(row.key, latestUnreadReplyTime(row.key, msgs))) unreadProbedRef.current.delete(row.key);
            recordHistoryPreview(row.key, msgs);
          }
        } catch {
          unreadProbedRef.current.delete(row.key); // Retry on a later authoritative refresh.
        }
      }
    })();
    return () => { stopped = true; };
  }, [connected, listLive, sessions, groupInternalKeys, runningKeys, send, observeReply, recordHistoryPreview]);
  const agents = useMemo(() => {
    const map = new Map<string, SessionRow[]>();
    for (const s of sessions) {
      if (groupInternalKeys.has(s.key)) continue;
      const a = agentOf(s.key);
      if (!isChatAgentListed(agentRoster, backendOfSessionRows([s], s.key, a), a)) continue;
      const arr = map.get(a);
      if (arr) arr.push(s);
      else map.set(a, [s]);
    }
    const list = Array.from(map.entries()).map(([agentId, ss]) => {
      const sorted = ss.slice().sort((x, y) => (y.updatedAt ?? 0) - (x.updatedAt ?? 0));
      // sessions = 全量（R266：切换器要能看到并打开 cron/子代理/dream/心跳，靠 Tab 分流）。
      // foreground = 挑「行代表会话 / 行时间 / 排序」的候选池，仍排除后台会话——否则心跳
      // phantom 会当上代表：行反复浮顶、点开永远空白（R153 Vincent 事故）。全是后台会话
      // 的 agent 退回全量，行才不会空着。
      const foreground = sorted.filter((s) => !isBackgroundSession(s.key, s.kind));
      return { agentId, sessions: sorted, foreground: foreground.length ? foreground : sorted };
    });
    const aAgent = activeKey ? agentOf(activeKey) : null;
    // Foreground activity keeps the existing heartbeat-safe ordering. Cron joins only
    // after a real reply has been observed; a schedule/metadata bump is not a message.
    const activityOf = (s: SessionRow) => isBackgroundSession(s.key, s.kind)
      ? unreadState.replies[s.key] ?? 0
      : realTimes[s.key] ?? realTimeBounds[s.key] ?? s.updatedAt ?? 0;
    const rankOf = (g: { foreground: SessionRow[]; sessions: SessionRow[] }) => {
      const foregroundTime = Math.max(0, ...g.foreground.map(s => realTimes[s.key] ?? realTimeBounds[s.key] ?? 0))
        || (g.foreground[0]?.updatedAt ?? 0);
      return Math.max(foregroundTime, ...g.sessions.filter(s => sessionKindOf(s.key, s.kind) === "cron")
        .map(s => unreadState.replies[s.key] ?? 0));
    };
    // Clicking an Agent returns to its latest result, even after its unread badge clears.
    // Explicit selection in the session menu remains stable until the user clicks again.
    const latestKeyOf = (g: { agentId: string; sessions: SessionRow[]; foreground: SessionRow[] }) =>
      g.sessions.filter(s => supportsSessionUnread(s.key, s.kind)
        && (!isBackgroundSession(s.key, s.kind) || (unreadState.replies[s.key] ?? 0) > 0))
        .sort((a, b) => activityOf(b) - activityOf(a) || a.key.localeCompare(b.key))[0]?.key
        || g.foreground.find(s => s.key === chosenSessions[g.agentId])?.key || g.foreground[0]?.key || "";
    // rowTime = 行上「显示」的时间：活跃 agent 用实时线程预览；openSession 清空 messages 到
    // loadHistory 落地的间隙 ts=0，先落该行原本显示的 previewTimes[shownKey]（防止点击瞬间
    // 切到空预览的闪跳），都没有才落 rank。rowTime 跟随预览，只用于显示；
    // 排序使用跨会话的真实消息时间，不因选中旧会话而下沉。
    const rowTimeOf = (g: { agentId: string; sessions: SessionRow[] }, shownKey: string, rank: number) =>
      (g.agentId === aAgent && shownKey === activeKey && !activeGroupId ? activeRealPreview.ts : 0)
        || previewTimes[shownKey] || unreadState.replies[shownKey] || rank;
    const ranked = list.map((g) => {
      const rank = rankOf(g);
      const latestKey = latestKeyOf(g);
      // A blocking prompt outranks the ordinary row preview. Prefer an approval
      // over free-form input, and route the row click to the exact session that
      // owns the card so users do not have to hunt through the session menu.
      const approvalKey = g.foreground.find((s) => promptAttentionByKey[s.key] === "approval")?.key;
      const inputKey = g.foreground.find((s) => promptAttentionByKey[s.key] === "input")?.key;
      const attentionKey = approvalKey || inputKey || "";
      const attention = attentionKey ? promptAttentionByKey[attentionKey] : undefined;
      const unreadKey = g.sessions.filter(showSessionUnread)
        .sort((a, b) => (unreadState.replies[b.key] ?? 0) - (unreadState.replies[a.key] ?? 0))[0]?.key;
      const targetKey = attentionKey || unreadKey || latestKey;
      const previewKey = g.agentId === aAgent && !activeGroupId && activeKey
        && g.sessions.some(s => s.key === activeKey) ? activeKey : targetKey;
      return { ...g, rank, previewKey, targetKey, attentionKey, attention,
        rowTime: rowTimeOf(g, previewKey, rank), unread: !!unreadKey, unreadKey };
    });
    ranked.sort((a, b) => b.rank - a.rank || a.agentId.localeCompare(b.agentId));
    // 只隐藏用户在设置页**主动断开**的后端——那是明确意图，留一堆灰行反而碍事。
    // 意外断线（网关重启、抖动）不再隐藏：行留在原位、**位置不变**（不做离线下沉，
    // 排序仍按最近消息），由 statusOf 灰下去。此前按 connected 过滤，
    // 网关一重启整组 agent 当场蒸发，是「聊着聊着 AI 全没了」的最后一刀。
    // 正在启动（startingBackends）本来就不该隐藏，现在天然涵盖。
    return disabledBackends.size ? ranked.filter((g) => !disabledBackends.has(backendOfKnownAgent(g.agentId))) : ranked;
  }, [sessions, agentRoster, groupInternalKeys, disabledBackends, realTimes, realTimeBounds, activeKey, activeGroupId, previewTimes, activeRealPreview, chosenSessions, unreadState, promptAttentionByKey, showSessionUnread]);
  // 单聊与群聊共用按最新消息倒序的列表。群资料修改不推进排序；无消息的群以创建时间兜底。
  const chatList = useMemo(() => [
    ...groupChats.map((group) => ({ kind: "group" as const, group, key: "group:" + group.group.id,
      time: group.lastMessage?.createdAt ?? group.group.createdAt })),
    ...agents.map((agent) => ({ kind: "agent" as const, agent, key: "agent:" + agent.agentId, time: agent.rank })),
  ].sort((a, b) => b.time - a.time || a.key.localeCompare(b.key)), [groupChats, agents]);
  const agentListRef = useRef<HTMLDivElement>(null);
  const updateAgentListFade = useCallback(() => {
    const list = agentListRef.current;
    if (!list) return;
    const overflow = list.scrollHeight - list.clientHeight;
    // Match the Inspiration growth list without rerendering chat on scroll.
    list.toggleAttribute("data-scrolled", overflow > 1 && list.scrollTop > 1);
    list.toggleAttribute("data-more", overflow > 1 && list.scrollTop < overflow - 1);
  }, []);
  useLayoutEffect(() => {
    const list = agentListRef.current;
    if (!list) return;
    updateAgentListFade();
    const observer = new ResizeObserver(updateAgentListFade);
    observer.observe(list);
    return () => observer.disconnect();
  }, [chatList.length, updateAgentListFade]);

  const activeAgentId = activeKey ? agentOf(activeKey) : null;
  const activeAgentSessions = useMemo(
    () => agents.find((g) => g.agentId === activeAgentId)?.sessions ?? [],
    [agents, activeAgentId],
  );
  // 会话切换器（普通 header 的 ChatSessionMenu + 沉浸模式的浮层）共用的一份行数据。
  // 时间口径与 agent 行一致：选中会话用线程底部可见的最后一条（含错误泡），其余按已学到
  // 的 preview/真实时间 —— 行、头部、菜单三处永不互相矛盾。
  const sessionMenuRows = useMemo(
    () =>
      activeAgentSessions.map((s) => {
        const ts =
          (s.key === activeKey ? activeRealPreview.ts || activeRealTime : 0) ||
          previewTimes[s.key] ||
          realTimes[s.key] ||
          s.updatedAt;
        const title = friendlySessionLabel(s, t);
        return {
          key: s.key,
          kind: s.kind,
          source: s.source,
          codexDesktopSourceError: s.codexDesktopSourceError,
          codexDesktopWriter: s.codexDesktopWriter,
          inspirationId: s.inspirationId,
          title,
          sub: sessionDisplayPreview(s, title),
          time: ts ? relTime(ts, t("chat.justNow")) : "",
          ts: ts ?? 0,
          unread: showSessionUnread(s),
        };
      }),
    [activeAgentSessions, activeKey, activeRealPreview, activeRealTime, previewTimes, realTimes, showSessionUnread, t],
  );
  // Missing session metadata means an unknown window. The list-level default
  // can be a generic 200k fallback or belong to another model/backend.
  const ctxLimit = active?.contextTokens;
  const ctxPct =
    active && active.totalTokensFresh !== false && active.totalTokens && ctxLimit
      ? Math.min(100, Math.round((active.totalTokens / ctxLimit) * 100))
      : null;

  // Once the agent list is ready (seeded from cache or fetched over WS), land
  // the user back in the LAST SESSION they had open (persisted per origin) —
  // falling back to the first (most-recent) agent's most-recent session when
  // there's no record or it no longer exists (deleted / backend offline).
  // activeKey becomes non-null after the first pick, so it never re-selects
  // (selection stays sticky when the list reorders/refreshes).
  useEffect(() => {
    if (activeKeyRef.current || agents.length === 0) return;
    // A deep-link placeholder has no authoritative source yet. Its explicit
    // open resolves that first; automatic restoration must not race it.
    const restorableSessions = agents.flatMap(group => group.sessions)
      .filter(session => !syntheticRowsRef.current.has(session.key));
    if (!restorableSessions.length) return;
    const last = readLastActive();
    const restorable = last && restorableSessions.some(session => session.key === last);
    void chatHistoryController.bootstrap(restorable ? (last as string) : restorableSessions[0].key);
  }, [agents, activeKey, chatHistoryController]);

  // One-shot hand-off from a CLICKED chat desktop notification: the app-level
  // <Notifier/> stashed the session key in sessionStorage and navigated to
  // #/chat. Open it on mount (wins the initial selection, like the handoff above),
  // and also while ChatPage is already mounted via the custom event the Notifier
  // dispatches. ChatPage itself never fires notifications — it only consumes the click.
  useEffect(() => {
    const PENDING = "openclaw.pendingChatSession";
    try {
      const pending = sessionStorage.getItem(PENDING);
      if (pending) {
        sessionStorage.removeItem(PENDING);
        if (isVisibleSession(sessionsRef.current.find(row => row.key === pending) || { key: pending })) {
          ensureSessionRow(pending);
          openSession(pending);
        }
      }
    } catch { /* ignore */ }
    const onOpen = (e: Event) => {
      const key = (e as CustomEvent<string>).detail;
      try { sessionStorage.removeItem(PENDING); } catch { /* ignore */ }
      if (typeof key === "string" && key) {
        if (!isVisibleSession(sessionsRef.current.find(row => row.key === key) || { key })) return;
        ensureSessionRow(key);
        openSession(key);
      }
    };
    window.addEventListener("openclaw:open-chat-session", onOpen as EventListener);
    return () => window.removeEventListener("openclaw:open-chat-session", onOpen as EventListener);
  }, [ensureSessionRow, openSession]);

  // (The sub-line preview is no longer a separate shallow fetch — for the ACTIVE agent
  // it derives from the live thread via `activeRealPreview`; for every OTHER agent it is
  // captured by the deep heartbeat-filtering scan below, the SAME pass that seeds the row
  // time. One scan feeds both, so a heartbeat-saturated agent's last real line is found
  // instead of falling back to the session count.)

  // Seed each NON-active agent's row time + sort with its last REAL (non-heartbeat) message time,
  // so an idle-but-heartbeating agent shows its true last-chat time and stops being pinned to the
  // top by heartbeats. Heartbeat acks run deep (Ada's last real line was ~123 back) so scan wider
  // (limit 150); skip ALL `isHeartbeatNoise` (bare + status acks + `[OpenClaw]` polls). Found →
  // record (max-write survives races); not found (real chat >150 back) → leave unset, the row
  // falls back to updatedAt. Deduped per key (heartbeats don't re-trigger). The ACTIVE agent is
  // skipped — its history load and live replies already write the per-session time.
  //
  // This SAME deep scan also captures the row's sub-line PREVIEW (one fetch feeds both): filtering
  // 30 messages couldn't see past a heartbeat run, so heartbeat-heavy agents fell back to "N
  // sessions" — the depth, not the filter, was the gap. Preview + time use the SAME filter
  // (`isHeartbeatNoise`, both roles) = the thread's filter, so the row shows the agent's last
  // GENUINE message (heartbeat acks never leak into the row, matching the thread).
  useEffect(() => {
    let stop = false;
    // Run the scans SEQUENTIALLY (one in-flight at a time) so a dozen deep fetches don't saturate
    // the single chat WS and starve loadHistory on first paint. `stop` halts starting new scans
    // when this effect re-runs; the in-flight one still writes (max-write is race-safe).
    void (async () => {
      for (const g of agents) {
        if (stop) break;
        if (g.agentId === activeAgentId) continue;
        const key = g.previewKey || g.sessions[0]?.key; // 扫行实际展示的会话（记住的选择→rep）
        const revision = g.sessions.find(session => session.key === key)?.updatedAt ?? 0;
        if (!key || realTimeFetchedRef.current.get(key) === revision) continue;
        realTimeFetchedRef.current.set(key, revision);
        try {
          const res: any = await send("chat.history", { sessionKey: key, limit: 150, maxChars: 320 });
          const msgs: any[] = res?.payload?.messages || [];
          observeReply(key, latestUnreadReplyTime(key, msgs.map(normalize)));
          const normalized = msgs.map(normalize);
          recordHistoryPreview(key, normalized);
          const ts = [...normalized].reverse().find(isRealActivity)?.ts ?? 0;
          if (ts > 0) {
            setRealTimes((p) => ({ ...p, [key]: Math.max(p[key] ?? 0, ts) }));
            recordActivity(key, ts); // 持久化探针学到的真实时间 → 冷启动/refetch 首屏即按真实时间排序
          } else {
            // 150 条窗口全是机械段（心跳 30min×4 条/轮 ≈ 18h 刷满）：记上界，别落回心跳 updatedAt。
            const oldest = msgs.find((x) => typeof x?.timestamp === "number")?.timestamp ?? 0;
            if (oldest > 0) setRealTimeBounds((p) => ({ ...p, [key]: Math.min(p[key] ?? Infinity, oldest) }));
          }
        } catch {
          realTimeFetchedRef.current.delete(key); // failed → retry next pass
        }
      }
    })();
    return () => {
      stop = true;
    };
  }, [agents, activeAgentId, send, observeReply, recordHistoryPreview]);

  // Keep the most-recent landing honest about the persistent `:main` thread. The
  // gateway's sessions.list `updatedAt` for `:main` is stale — channel (Telegram) /
  // heartbeat appends never advance it (§9) — so a freshly-minted side session (e.g.
  // a `/new` dashboard:<uuid>) can outrank main, and opening the agent then lands on
  // that side session while main's history appears to vanish. For each agent whose
  // main session ISN'T already on top, probe its TRUE last-message time once and
  // bump+record it (the same correction loadHistory does on open, but proactive) so
  // main sorts by real activity. If a channel session is GENUINELY newer, main still
  // sits below it (R10.7 land-on-most-recent preserved). Recorded to the persistent
  // activity map so later loads self-correct before first paint.
  useEffect(() => {
    let cancelled = false;
    for (const g of agents) {
      const mainKey = `agent:${g.agentId}:main`;
      if (g.sessions[0]?.key === mainKey) continue; // already on top → ranked right
      if (mainActivityProbedRef.current.has(mainKey)) continue; // one-shot per mount
      if (!g.sessions.some((s) => s.key === mainKey)) continue; // no visible main session
      mainActivityProbedRef.current.add(mainKey);
      void (async () => {
        try {
          // maxChars 8 会把 HEARTBEAT_OK 截成识别不了的普通文本，旧版据此把 raw 心跳时间写进
          // 单调只增的持久化 activity——永久污染真实口径。提高 maxChars 用 isRealActivity 分类：
          // 持久化只收真实时间；bumpSession 仍用 raw ts（落地/rep 选择要的就是「最近发生过事」）。
          const res: any = await send("chat.history", { sessionKey: mainKey, limit: 8, maxChars: 400 });
          const msgs: any[] = res?.payload?.messages || [];
          const ts = msgs.reduce((m, x) => (typeof x?.timestamp === "number" && x.timestamp > m ? x.timestamp : m), 0);
          let realTs = 0;
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (isRealActivity(normalize(msgs[i]))) { realTs = typeof msgs[i]?.timestamp === "number" ? msgs[i].timestamp : 0; break; }
          }
          if (!cancelled && ts > 0) {
            if (realTs > 0) recordActivity(mainKey, realTs);
            bumpSession(mainKey, ts);
          }
        } catch {
          if (!cancelled) mainActivityProbedRef.current.delete(mainKey); // failed → retry next pass
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [agents, send, bumpSession]);

  // slash 命令菜单（command 列表 + arg 子菜单）。同一份节点渲染进普通 composer 和沉浸
  // composer——两处都是 position 容器，.slash-menu 的 absolute bottom:100% 各自就位。
  const slashMenuNode = (
    <>
      {slashOpen && slashMode === "command" && (
        <div
          className="slash-menu"
          role="listbox"
          aria-label={t("chat.slashCommands")}
          onMouseDown={(e) => e.preventDefault()} /* keep focus in the textarea on item click */
        >
          {(activeSlashCatalog || activeNativeSlash) && (
            <div className="slash-menu__catalog" role="status">
              <span>{!activeSlashCatalog ? t("chat.slashWaiting")
                : activeSlashCatalog.status === "loading" ? t("chat.slashLoading")
                : activeSlashCatalog.status === "error" ? t("chat.slashLoadFailed", { message: activeSlashCatalog.message })
                : activeSlashCatalog.status === "unsupported" ? activeSlashCatalog.message
                : activeSlashCatalog.message || t("chat.slashCatalogReady", { count: activeSlashCatalog.commands.length })}</span>
              {activeSlashCatalog?.status !== "loading" && (
                <button type="button" onClick={retrySlashCatalog}>{t("chat.slashRefresh")}</button>
              )}
            </div>
          )}
          {slashItems.length === 0 && <div className="slash-menu__label">{t("chat.slashNoMatches")}</div>}
          {slashItems.map((cmd, idx) => {
            const showLabel = idx === 0 || slashItems[idx - 1].category !== cmd.category
              || (slashItems[idx - 1].source === "Shoggoth") !== (cmd.source === "Shoggoth");
            const isActive = idx === slashIndex;
            return (
              <Fragment key={cmd.name}>
                {showLabel && (
                  <div className="slash-menu__label">
                    {cmd.source === "Shoggoth" ? "Shoggoth · " : ""}{t(`chat.slashCategory.${cmd.category}`, { defaultValue: CATEGORY_LABELS[cmd.category] ?? cmd.category })}
                  </div>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  className={isActive ? "slash-menu__item is-active" : "slash-menu__item"}
                  onMouseEnter={() => setSlashIndex(idx)}
                  onClick={() => applySlashCommand(cmd)}
                >
                  <span className="slash-menu__icon">
                    <SlashIcon name={cmd.icon} />
                  </span>
                  <span className="slash-menu__name">/{cmd.name}</span>
                  {cmd.args && <span className="slash-menu__args">{cmd.args}</span>}
                  <span className="slash-menu__desc" title={cmd.description}>{translateSlashDescription(cmd.description, t)}</span>
                  {cmd.source && <span className="slash-menu__badge" title={cmd.source}>{cmd.source}</span>}
                  {cmd.execution === "cli" && <span className="slash-menu__badge">{t("chat.slashCliOnly")}</span>}
                  {cmd.argOptions?.length ? (
                    <span className="slash-menu__badge">{t("chat.slashOptionCount", { count: cmd.argOptions.length })}</span>
                  ) : cmd.instant ? (
                    <span className="slash-menu__badge">{t("chat.slashInstant")}</span>
                  ) : null}
                </button>
              </Fragment>
            );
          })}
          <div className="slash-menu__footer">
            <kbd>↑↓</kbd> {t("chat.kbdNavigate")}　<kbd>Tab</kbd> {t("chat.kbdFill")}　<kbd>Enter</kbd> {t("chat.kbdSelect")}　<kbd>Esc</kbd> {t("chat.kbdClose")}
          </div>
        </div>
      )}
      {slashOpen && slashMode === "args" && slashArgItems.length > 0 && (
        <div
          className="slash-menu"
          role="listbox"
          aria-label={t("chat.argOptions")}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="slash-menu__label">
            /{slashArgCmd?.name} — {slashArgCmd && translateSlashDescription(slashArgCmd.description, t)}
          </div>
          {slashArgItems.map((opt, idx) => {
            const isActive = idx === slashIndex;
            return (
              <button
                key={opt}
                type="button"
                role="option"
                aria-selected={isActive}
                className={isActive ? "slash-menu__item is-active" : "slash-menu__item"}
                onMouseEnter={() => setSlashIndex(idx)}
                onClick={() => applySlashArg(opt, true)}
              >
                <span className="slash-menu__name">{opt}</span>
                <span className="slash-menu__desc">/{slashArgCmd?.name} {opt}</span>
              </button>
            );
          })}
          <div className="slash-menu__footer">
            <kbd>↑↓</kbd> {t("chat.kbdNavigate")}　<kbd>Tab</kbd> {t("chat.kbdFill")}　<kbd>Enter</kbd> {t("chat.kbdRun")}　<kbd>Esc</kbd> {t("chat.kbdClose")}
          </div>
        </div>
      )}
    </>
  );
  const menuForkEntryId = menu
    ? forkEntryIdAt(menu.group.msgs, menu.msgIndex, activeAdvancedMethods)
    : null;
  const closeGlobalSearch = () => {
    globalSearchTokenRef.current += 1;
    globalSearchMoreAbortRef.current?.abort();
    globalSearchMoreAbortRef.current = null;
    setGlobalSearchOpen(false);
    setGlobalSearchQuery("");
    setGlobalSearch({ status: "idle", data: null, loadingMore: false, loadMoreError: false });
  };
  const historyControl = !historyLoaded && historyError ? (
    activeRecoveryHint ? <div className="chat-archive-bar is-note">{activeRecoveryHint}</div> : <>
      <div className="chat-archive-bar is-note">{t("chat.historyLoadFailed", { msg: historyError })}</div>
      <button type="button" className="chat-archive-bar is-action" data-testid="chat-history-retry"
        onClick={() => {
          setHistoryError(null);
          if (activeKeyRef.current) void loadHistory(activeKeyRef.current);
        }}>{t("chat.historyRetry")}</button>
    </>
  ) : historyLoaded && activeKey && searchHistoryWindowKeyRef.current !== activeKey ? <>
    {earlierHistory.key === activeKey && (earlierHistory.cursor ? (
      <button type="button" className="chat-archive-bar is-action" data-testid="chat-history-earlier"
        disabled={earlierHistory.loading} onClick={loadEarlierHistory}>
        {t(earlierHistory.loading ? "chat.historyLoadingEarlier" : earlierHistory.error ? "chat.historyRetryEarlier" : "chat.historyLoadEarlier")}
      </button>
    ) : messages.length > 0 ? <div className="chat-archive-bar is-note" data-testid="chat-history-complete">{t("chat.historyAllLoaded")}</div> : null)}
    {backendOfSession(activeKey) === "openclaw" && (() => {
      const st = archive.key === activeKey ? archive : { status: "idle" as const, hasMore: false, error: undefined };
      // Empty chats stay blank while the archive probe distinguishes a fresh
      // session from a reset transcript. Found history still restores normally;
      // failures retain the retry entry even when the current transcript is empty.
      if (messages.length === 0 && st.status !== "error") return null;
      if (st.status === "idle" || (st.status === "loaded" && st.hasMore) || st.status === "error" || st.status === "loading")
        return <button type="button" className="chat-archive-bar is-action" data-testid="chat-history-archive"
          disabled={st.status === "loading"} onClick={maybeLoadArchive}>
          {t(st.status === "loading" ? "chat.archiveLoading" : st.status === "error" ? "chat.archiveRetry" : "chat.archiveLoadEarlier")}
        </button>;
      if (st.status === "empty") return <div className="chat-archive-bar is-note">{t("chat.archiveNone")}</div>;
      if (st.status === "unsupported" && st.error === "remote") return <div className="chat-archive-bar is-note">{t("chat.archiveRemote")}</div>;
      return null;
    })()}
  </> : null;

  return (
    <ChatMediaContext.Provider value={imageContext}>
    {advancedProbe && advancedProbe.key === activeKey ? (
      <SessionAdvancedModal
        key={`${advancedProbe.backendId}:${advancedProbe.key}`}
        open={advancedModalOpen}
        backendId={advancedProbe.backendId}
        agentId={advancedProbe.agentId}
        sessionKey={advancedProbe.key}
        initialDescription={advancedProbe.description}
        onClose={() => setAdvancedModalOpen(false)}
      />
    ) : null}
    <Modal
      open={globalSearchOpen}
      title={t("chat.globalSearchTitle")}
      subtitle={t("chat.globalSearchSubtitle", { count: agents.length })}
      onClose={closeGlobalSearch}
      width={760}
    >
      <div className="chat-global-search">
        <label className="chat-global-search__field">
          <span aria-hidden><IconSearch /></span>
          <input
            autoFocus
            maxLength={4096}
            value={globalSearchQuery}
            onChange={(event) => setGlobalSearchQuery(event.target.value)}
            placeholder={t("chat.globalSearchPlaceholder")}
            aria-label={t("chat.globalSearchTitle")}
          />
        </label>
        <div ref={globalSearchResultsRef} className="chat-global-search__results" aria-live="polite">
          {globalSearch.status === "loading" && (
            <div className="chat-global-search__note">{t("chat.globalSearchSearching")}</div>
          )}
          {globalSearch.status === "error" && (
            <div className="chat-global-search__note is-error">{t("chat.globalSearchFailed")}</div>
          )}
          {globalSearch.status === "done" && globalSearch.data && (() => {
            const data = { ...globalSearch.data, results: globalSearch.data.results.filter(hit =>
              isVisibleSession(allSessions.find(row => row.key === hit.key) || { key: hit.key })) };
            const unavailable = data.unsupportedAgents + data.failedAgents;
            return (
              <>
                {unavailable > 0 && (
                  <div className="chat-global-search__note">
                    {t("chat.globalSearchPartial", { count: unavailable })}
                  </div>
                )}
                {data.results.length === 0 && (
                  <div className="chat-global-search__note">
                    {data.searchedAgents === 0
                      ? t("chat.globalSearchUnavailable")
                      : t("chat.globalSearchEmpty")}
                  </div>
                )}
                {data.results.map((hit) => {
                  const row = sessions.find((session) => session.key === hit.key);
                  const label = row
                    ? friendlySessionLabel(row, t)
                    : hit.key.split(":").slice(2).join(":") || hit.key;
                  return (
                    <button
                      key={globalSearchHitIdentity(hit)}
                      type="button"
                      className="chat-global-search__item"
                      title={hit.key}
                      onClick={() => {
                        const token = ++searchJumpTokenRef.current;
                        pendingSearchJumpKeyRef.current = hit.key;
                        searchJumpRequestTokenRef.current = null;
                        searchHistoryWindowKeyRef.current = null;
                        setSearchTargetGroupKey(null);
                        setPendingSearchJump({ ...hit, query: data.query, token });
                        ensureSessionRow(hit.key, hit.ts, {
                          backendId: hit.backendId,
                          agentId: hit.agentId,
                          agentName: hit.agentName,
                        });
                        openSession(hit.key);
                        closeGlobalSearch();
                      }}
                    >
                      <span className="chat-global-search__identity">
                        <span className="chat-global-search__agent">{hit.agentName}</span>
                        <span className="chat-global-search__session">{label}</span>
                      </span>
                      <span className="chat-global-search__snippet">{hit.snippet}</span>
                      {hit.ts ? <span className="chat-global-search__time">{absTime(hit.ts)}</span> : null}
                    </button>
                  );
                })}
                {data.hasMore && (
                  <div ref={globalSearchSentinelRef} className="chat-global-search__sentinel">
                    {globalSearch.loadingMore && t("chat.globalSearchLoadingMore")}
                    {globalSearch.loadMoreError && (
                      <>
                        <span>{t("chat.globalSearchLoadMoreFailed")}</span>
                        <button type="button" onClick={() => void loadMoreGlobalSearch()}>
                          {t("chat.globalSearchRetry")}
                        </button>
                      </>
                    )}
                  </div>
                )}
                {!data.hasMore && data.truncated && data.results.length > 0 && (
                  <div className="chat-global-search__note">{t("chat.globalSearchSourceLimited")}</div>
                )}
              </>
            );
          })()}
        </div>
      </div>
    </Modal>
    <Modal
      open={!!modalTimeline}
      title={t("turnLab.processLabel")}
      subtitle={modalTimeline?.ts ? absTime(modalTimeline.ts) : undefined}
      onClose={() => setTimelineModal(null)}
      width={640}
    >
      {modalTimeline ? (
        <TurnTimeline
          steps={modalSteps}
          status={modalStatus}
          showDurations={modalSteps.some((s) => typeof s.durationS === "number" && s.durationS > 0)}
          autoFollow={modalStatus === "running"}
          pluginConversation={activePluginConversation}
        />
      ) : null}
    </Modal>
    {lightbox ? (
      <div
        className="chat-lightbox"
        role="dialog"
        aria-modal="true"
        onClick={() => setLightbox(null)}
      >
        {lightbox.kind === "video" ? (
          <video
            className="chat-lightbox__video"
            src={lightbox.src}
            controls
            autoPlay
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <img
            className="chat-lightbox__img"
            src={lightbox.src}
            alt=""
            onClick={(e) => e.stopPropagation()}
          />
        )}
      </div>
    ) : null}
    <div className="chat-shell">
      <aside className="chat-aside">
        <div className="chat-aside__head">
          <div className="chat-aside__title-row">
            <div className="chat-aside__title">{t("chat.title")}</div>
            <button
              type="button"
              className="chat-aside__search"
              title={t("chat.globalSearchTitle")}
              aria-label={t("chat.globalSearchTitle")}
              aria-pressed={globalSearchOpen}
              onClick={() => setGlobalSearchOpen(true)}
            >
              <IconSearch />
            </button>
          </div>
          <div className="chat-aside__count">
            {agents.length > 0 ? t("chat.agentCount", { count: agents.length }) : connected ? t("chat.agentCount", { count: 0 }) : t("chat.connecting")}
          </div>
        </div>
        <div ref={agentListRef} className="chat-aside__list" onScroll={updateAgentListFade}>
          {chatList.map((item) => {
            if (item.kind === "group") {
              const gc = item.group;
              return (
                <button
                  key={item.key}
                  className={activeGroupId === gc.group.id ? "chat-agent is-active" : "chat-agent"}
                  onClick={() => setOpenGroup({ groupId: gc.group.id, activeKey })}
                  title={gc.group.name}
                >
                  <GroupChatAvatar view={gc} className="chat-agent__avatar" />
                  <span className="chat-agent__body">
                    <span className="chat-agent__top">
                      <span className="chat-agent__name">{gc.group.name}</span>
                      <span className="chat-agent__time">{relTime(item.time, t("chat.justNow"))}</span>
                    </span>
                    <span className="chat-agent__sub">
                      {groupChatActivity(gc) === "running" ? (
                        <ChatTypingText className="chat-agent__subtext" text={t("chat.liveStatus.running")} />
                      ) : (
                        <span className="chat-agent__subtext">{groupChatPreview(gc, t)}</span>
                      )}
                    </span>
                  </span>
                </button>
              );
            }
            const g = item.agent;
            const rep = g.sessions[0];
            const name = rep.agentName || chatAgentDisplayName(g.agentId);
            const isActive = !activeGroupId && g.agentId === activeAgentId;
            // The sub-line for the agent you're viewing follows the session you've selected
            // (header switcher), mirroring the preview-fetch key; others preview their newest.
            // 正在阅读时保留当前会话的预览；其他行跟随最新未读/最新结果。
            // 点击统一使用 g.targetKey，列表位置独立按真实消息时间排序。
            const previewKey = g.previewKey || rep.key;
            const rowTime = g.rowTime;
            // 行上的「运行中」仍只看前台会话：后台 cron/心跳跑起来不该把每个 agent 行
            // 都染成运行中（也会连带压掉红点）。后台跑没跑在切换器对应 Tab 里看。
            const st: AgentListStatus = g.attention ?? agentStatusOf(g.foreground);
            return (
              <button
                key={item.key}
                className={!activeGroupId && isActive ? "chat-agent is-active" : "chat-agent"}
                onClick={() => {
                  setOpenGroup(null);
                  void openSession(g.targetKey || g.sessions[0].key);
                }}
                onContextMenu={(e) => {
                  // 右键菜单目前只有「创建群组」；群功能关闭时不弹。
                  if (!groupChatEnabled) return;
                  e.preventDefault();
                  setAgentMenu({ x: e.clientX, y: e.clientY,
                    agent: { backendId: backendOfKnownAgent(g.agentId), agentId: g.agentId, name } });
                }}
                title={g.agentId}
              >
                <Avatar agentId={g.agentId} name={name} className="chat-agent__avatar" version={avatarVersion} />
                <span className="chat-agent__body">
                  <span className="chat-agent__top">
                    <span className="chat-agent__name">{name}</span>
                    {g.unread ? (
                      <span className="chat-agent__unread-dot" role="img" aria-label={t("chat.unread")} title={t("chat.unread")} />
                    ) : (
                      <span className={listLive ? "chat-agent__time" : "chat-agent__time is-stale"}>{relTime(rowTime, t("chat.justNow"))}</span>
                    )}
                  </span>
                  <span className="chat-agent__sub">
                    {st === "approval" || st === "input" ? (
                      <>
                        <span className="chat-agent__attention-dot" aria-hidden="true" />
                        <span className="chat-agent__subtext is-attention">{t(`chat.liveStatus.${st}`)}</span>
                      </>
                    ) : st === "running" ? (
                      <ChatTypingText className="chat-agent__subtext" text={t("chat.liveStatus.running")} />
                    ) : st === "queued" ? (
                      <span className="chat-agent__subtext">{t("chat.liveStatus.queued")}</span>
                    ) : (
                      <span className="chat-agent__subtext">
                        {(isActive ? activeRealPreview.text || previews[previewKey] : previews[previewKey]) || (g.sessions.length > 1 ? t("chat.sessionCount", { count: g.sessions.length }) : rep.model || sessionSub(rep))}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      {activeGroupId && (
        <section className="chat-conv">
          {recoveryNotice && <div className="chat-banner" role="alert">{recoveryNotice}</div>}
          <GroupChatPanel key={`${groupCacheScope}:${activeGroupId}`} groupId={activeGroupId} cache={groupPanelCache} cacheScope={groupCacheScope}
            onArchived={() => { setOpenGroup(null); void refreshGroupChats(); }}
            agents={agents.map((g) => ({ backendId: backendOfKnownAgent(g.agentId), agentId: g.agentId,
              name: g.sessions[0].agentName || chatAgentDisplayName(g.agentId) }))} />
        </section>
      )}
      <section className={`chat-conv is-board-${showSessionBoard ? sessionBoardViewMode : "chat"}`} data-native-ui-surface
        style={activeGroupId ? { display: "none" } : undefined}>
        {recoveryNotice ? (
          <div className="chat-banner" role="alert">{recoveryNotice}</div>
        ) : error ? (
          <div className="chat-banner" title={error ?? undefined}>{t("chat.errorPrefix", { msg: error ? translateGatewayError(error, t) : error })}</div>
        ) : !connected ? (
          // Cold start / reconnecting: a neutral state, not an error flash.
          // 分词：冷启动是「连接中…」，掉线自愈是「连接已断开，正在重连…」——后者要让
          // 用户知道有东西在自己跑，不必刷新页面。
          <div className="chat-banner is-info">
            {everConnected ? t("chat.reconnectingBanner") : t("chat.connecting")}
          </div>
        ) : null}
        {activeKey && verificationKeys.has(activeKey) && (
          <div className="chat-banner is-info chat-verification-banner" role="status">
            <span>{t(hasPendingTrackedSend(activeKey)
              ? "chat.sendNeedsVerification" : "chat.observeNeedsVerification")}</span>
            <button type="button" disabled={!connected}
              onClick={() => void verifyPendingTrackedSends(activeKey)}>
              {t(hasPendingTrackedSend(activeKey) ? "chat.verifyOriginalSend" : "chat.retryObserve")}
            </button>
          </div>
        )}
        {toast && (
          <div className={`chat-toast chat-toast--${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"}>
            <span className="chat-toast__text" title={toast.text}>{toast.text}</span>
            {toast.action && (
              <button
                type="button"
                className="chat-toast__act"
                onClick={() => {
                  toast.action?.run();
                  setToast(null);
                }}
              >
                {toast.action.label}
              </button>
            )}
            {toast.kind === "error" && (
              <button
                type="button"
                className="chat-toast__dismiss"
                aria-label={t("common.close")}
                title={t("common.close")}
                onClick={() => setToast(null)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                  <path d="m6 6 12 12M18 6 6 18" />
                </svg>
              </button>
            )}
          </div>
        )}
        {!active ? (
          <div className="chat-empty">{t("chat.emptySelect")}</div>
        ) : (
          <>
            {/* top dock: header + search + pinbar float above the full-height thread */}
            <div className="chat-topdock" data-native-ui-clip-edge="top">
            <header ref={agentHeaderRef} className="chat-header" data-agent-panel={activeAgentHeaderPanel ?? undefined}>
              <div className="chat-header__row">
              <button type="button" className="chat-header__avatar-trigger"
                title={t("chat.agentPanelProfile")} aria-label={t("chat.agentPanelProfile")}
                aria-expanded={activeAgentHeaderPanel === "profile"} aria-controls="chat-agent-panel"
                onClick={event => toggleAgentHeaderPanel("profile", event.currentTarget)}>
                <Avatar agentId={agentOf(active.key)} name={sessionName(active)} className="chat-header__avatar" version={avatarVersion} />
              </button>
              <div className="chat-header__id">
                <button type="button" className="chat-header__name"
                  title={t("chat.agentPanelProfile")} aria-expanded={activeAgentHeaderPanel === "profile"}
                  aria-controls="chat-agent-panel"
                  onClick={event => toggleAgentHeaderPanel("profile", event.currentTarget)}>{sessionName(active)}</button>
                <div className="chat-header__statusline">
                {(activeHeaderStatus === "queued" || activeHeaderStatus === "connecting" || activeHeaderStatus === "reconnecting" || activeHeaderStatus === "offline") && (
                  <span className={`chat-status chat-status--${activeHeaderStatus}`}>
                    <span className="status-dot" />
                    <span className="chat-status__label">{t(activeRecoveryRequired ? "settings.serviceRecoveryRequired" : `chat.liveStatus.${activeHeaderStatus}`)}</span>
                  </span>
                )}
                {activeAgentSessions.length > 1 ? (
                  <ChatSessionMenu
                    sessions={sessionMenuRows}
                    activeKey={activeKey || ""}
                    onSelect={openSession}
                  />
                ) : (
                  <div className="chat-header__meta" title={sessionSub(active)}>{friendlySessionLabel(active, t)}</div>
                )}
                </div>
                {SHOW_CHAT_CONTEXT_USAGE && active.contextCapabilities && <ChatContextUsage usage={active.contextUsage ?? null}
                  capabilities={active.contextCapabilities} product={active.productContext} busy={!connected || activeRunInFlight}
                  onCompact={async () => {
                    if (active.productContext?.automatic !== "enabled" || !activeAgentId || !activeKey) { void sendChatMessage("/compact", [], true); return; }
                    try {
                      const result = await compactConversation(activeBackend, activeAgentId, activeKey, `summary-${crypto.randomUUID()}`);
                      setToast({ kind: result.status === "unchanged" ? "success" : "pending", text: t(result.status === "unchanged" ? "chat.productContextUnchanged" : "chat.productContextPending") });
                      await refreshSessions();
                    } catch (error) { setToast({ kind: "error", text: error instanceof Error ? error.message : String(error) }); }
                  }} />}

              </div>
              {/* tool actions (Figma layout; wired to real features) */}
              <div className="chat-header__tools">
                <button
                  ref={sessionArtifactsTriggerRef}
                  type="button"
                  className={sessionArtifactsOpen ? "chat-headbtn is-active chat-artifacts-trigger" : "chat-headbtn chat-artifacts-trigger"}
                  title={t("chat.artifactsTitle")}
                  aria-label={t("chat.artifactsTitle")}
                  aria-expanded={sessionArtifactsOpen}
                  aria-controls="chat-session-artifacts"
                  onClick={() => { setAgentHeaderPanel(null); setSessionArtifactsOpen((value) => !value); }}
                >
                  <IconArtifacts />
                  {sessionArtifactCount > 0 ? (
                    <span className="chat-artifacts-badge">{Math.min(sessionArtifactCount, 99)}</span>
                  ) : null}
                </button>
                {sessionArtifactsOpen ? (
                  <div
                    id="chat-session-artifacts"
                    className="chat-artifacts-popover"
                    role="dialog"
                    aria-label={t("chat.artifactsTitle")}
                    style={sessionArtifactPopoverPosition
                      ? sessionArtifactPopoverPosition
                      : { visibility: "hidden" }}
                  >
                    <div className="chat-artifacts-head">
                      <div>
                        <div className="chat-artifacts-title">{t("chat.artifactsTitle")}</div>
                        <div className="chat-artifacts-subtitle">
                          {activeSessionArtifactResult?.approximate
                            ? t("chat.artifactsApproximate")
                            : t("chat.artifactsProduced")}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="chat-artifacts-refresh"
                        title={t("chat.artifactsRefresh")}
                        aria-label={t("chat.artifactsRefresh")}
                        disabled={sessionArtifactState.status === "loading" || activeRunInFlight}
                        onClick={() => setSessionArtifactReload((value) => value + 1)}
                      >
                        ↻
                      </button>
                    </div>
                    {sessionArtifactState.status === "loading" && sessionArtifactItems.length === 0 ? (
                      <div className="chat-artifacts-note">{t("chat.artifactsLoading")}</div>
                    ) : null}
                    {activeSessionArtifactResult?.supported === false ? (
                      <div className="chat-artifacts-note">
                        {activeSessionArtifactResult.reason === "remote"
                          ? t("chat.artifactsRemote")
                          : activeSessionArtifactResult.reason === "session-time-unavailable"
                            ? t("chat.artifactsSessionTimeUnavailable")
                            : t("chat.artifactsUnavailable")}
                      </div>
                    ) : null}
                    {sessionArtifactItems.length === 0
                      && sessionArtifactState.status !== "loading"
                      && activeSessionArtifactResult?.supported !== false ? (
                      <div className="chat-artifacts-empty">{t("chat.artifactsEmpty")}</div>
                    ) : (
                      <div className="chat-artifacts-list">
                        {sessionArtifactItems.map((artifact) => (
                          <div className="chat-artifact-row" key={artifact.path}>
                            <button
                              type="button"
                              className="chat-artifact-open"
                              title={`${t("chat.artifactsRevealInFolder")} · ${artifact.path}`}
                              disabled={!activeSessionArtifactResult || activeSessionArtifactResult.reason === "remote"}
                              onClick={() => { void revealLocalFile(artifact.path); }}
                            >
                              <span className="chat-artifact-icon" aria-hidden="true">
                                {artifact.kind === "image" ? "▧" : artifact.kind === "doc" ? "▤" : artifact.kind === "data" ? "⌗" : "◇"}
                              </span>
                              <span className="chat-artifact-body">
                                <span className="chat-artifact-name">{artifact.name}</span>
                                <span className="chat-artifact-path">{artifact.path}</span>
                                <span className="chat-artifact-meta">
                                  {artifact.mtimeMs ? relTime(artifact.mtimeMs, t("chat.justNow")) : ""}
                                </span>
                              </span>
                            </button>
                            <button
                              type="button"
                              className="chat-artifact-reveal"
                              title={t("chat.artifactsRevealInFolder")}
                              aria-label={t("chat.artifactsRevealInFolder")}
                              onClick={() => { void revealLocalFile(artifact.path); }}
                            >
                              <IconFolderReveal />
                            </button>
                            <button
                              type="button"
                              className="chat-artifact-copy"
                              title={t("chat.artifactsCopyPath")}
                              aria-label={t("chat.artifactsCopyPath")}
                              onClick={() => {
                                void navigator.clipboard?.writeText(artifact.path).then(() => {
                                  setToast({ text: t("chat.artifactsPathCopied"), kind: "success" });
                                  setTimeout(() => setToast(null), 1200);
                                }).catch(() => {});
                              }}
                            >
                              <IconCopy />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
                {/* 原生卡片开关启用后显示已有沉浸入口；能力未知或关闭时保持隐藏。 */}
                <button hidden={activeCaps?.nativeUiArtifactsV1 !== true} type="button" className="chat-headbtn" data-testid="chat-immersive-enter" title={t("chat.immersiveEnter")} onClick={() => setImmersive(true)}>
                  <IconImmersive />
                </button>
                <button type="button" className={`chat-headbtn${activeAgentHeaderPanel === "cron" ? " is-active" : ""}`}
                  title={t("chat.agentPanelCron")} aria-label={t("chat.agentPanelCron")}
                  aria-expanded={activeAgentHeaderPanel === "cron"} aria-controls="chat-agent-panel"
                  onClick={event => toggleAgentHeaderPanel("cron", event.currentTarget)}><IconClock /></button>
                <button type="button" className={`chat-headbtn${activeAgentHeaderPanel === "inspiration" ? " is-active" : ""}`}
                  title={t("agents.tabInspiration")} aria-label={t("agents.tabInspiration")}
                  aria-expanded={activeAgentHeaderPanel === "inspiration"} aria-controls="chat-agent-panel"
                  onClick={event => toggleAgentHeaderPanel("inspiration", event.currentTarget)}><IconNote /></button>
              </div>
              </div>
              <ChatAgentPanel key={agentHeaderScope} kind={activeAgentHeaderPanel} backendId={activeBackend}
                agentId={agentOf(active.key)} name={sessionName(active)}
                renderAvatar={name => <Avatar agentId={agentOf(active.key)} name={name} className="chat-header__avatar"
                  version={avatarVersion} editable onUploaded={() => setAvatarVersion(v => v + 1)} />}
                onClose={() => { setAgentHeaderPanel(null); agentHeaderTriggerRef.current?.focus(); }} />
            </header>

            <ChatPinnedMessages items={pinnedList} index={pinNavIndex} onIndex={setPinNavIndex}
              onJump={scrollToMessage} onUnpin={unpinId} pinnedOnly={pinnedOnly} onToggle={() => setPinnedOnly(value => !value)} />
            </div>

            <div className="chat-thread" ref={threadRef} onScroll={onThreadScroll} onWheel={onThreadWheel}
              onPointerDownCapture={() => { cancelInitialScroll(); stoppedScrollKeyRef.current = null; }}
              onKeyDownCapture={() => { cancelInitialScroll(); stoppedScrollKeyRef.current = null; }}>
              <div className="chat-thread__inner">
                {historyControl}
                {keyedThreadGroups.map(({ item: g, key: groupRenderKey, messages: keyedMessages }) => {
                  if (g.msgs.length === 1 && g.msgs[0].divider) {
                    const d = g.msgs[0].divider;
                    const when = d.sealedAt ? absTime(d.sealedAt) : "";
                    return (
                      <div key={groupRenderKey} className="chat-reset-divider">
                        <span className="chat-reset-divider__label">
                          {d.fromReset ? t("chat.archiveResetAt", { time: when }) : t("chat.archiveEarlierAt", { time: when })}
                          {d.truncated ? ` · ${t("chat.archiveTruncated")}` : ""}
                        </span>
                      </div>
                    );
                  }
                  // Backend timeline notice — a quiet divider line, same
                  // shape as the archive divider. The backend's raw marker text (the
                  // string the MODEL sees) stays on the hover title only.
                  if (g.msgs.length === 1 && g.msgs[0].notice) {
                    const n = g.msgs[0];
                    return (
                      <div key={groupRenderKey} className="chat-reset-divider">
                        <span className="chat-reset-divider__label" title={n.parts.find((p) => p.text)?.text || undefined}>
                          {t(n.notice === "runInterrupted" ? "chat.runInterruptedNotice" : "chat.modelSwitchedNotice")}
                          {n.notice === "modelSwitch" && n.model ? ` · ${n.model}` : ""}
                        </span>
                      </div>
                    );
                  }
                  const last = g.msgs[g.msgs.length - 1];
                  const cls = g.role === "user" ? "is-user" : g.role === "toolResult" ? "is-tool" : "is-assistant";
                  // A saved pin can belong to any message after groups merge.
                  const pinIds = g.msgs.map((m) => m.actionId).filter((id): id is string => !!id);
                  const metadata = [...g.msgs].reverse().find(message => message.responseMetadata)?.responseMetadata;
                  // A group whose parts are ALL hidden by the 💡/🔧 toggles (a reasoning-only
                  // or tool-only turn) would render an empty body but still show its footer
                  // (time/model) — a dangling meta line in the thread. Skip the whole
                  // group when nothing is visible. Pending turns + any non-blank text count.
                  const isMsgVisible = (m: ChatMsg) =>
                    m.pending ||
                    (m.images?.length ?? 0) > 0 ||
                    (m.files?.length ?? 0) > 0 ||
                    m.parts.some((p) =>
                      p.type === "canvas" || p.type === "ui_artifact"
                        ? true
                        : p.type === "prompt"
                        ? !!p.promptEntry
                        : p.type === "thinking"
                        ? showThinking && !!p.text?.trim()
                        : p.type === "toolCall" || p.type === "toolResult"
                          ? showTools
                          : p.type === "timeline"
                            ? showTraj && !!p.steps?.length
                            : !!p.text?.trim(),
                    );
                  const hasVisible = g.msgs.some(isMsgVisible);
                  if (!hasVisible) return null;
                  // Footer 时间 = 组内最后一条可见消息的时间（不是组首 g.ts）：footer 渲染在组尾，
                  // 必须与用户看到的末条内容、以及列表/头部 badge 的 updatedAt 对齐。组首兜底仅在
                  // 全组消息都无 ts 时生效。
                  const footerTs = [...g.msgs].reverse().find((m) => isMsgVisible(m) && m.ts)?.ts ?? g.ts;
                  // 直播时间线属于整轮 assistant 输出，不属于会被 Hermes interim 反复
                  // 定稿/新建的 pending 消息。固定放在组顶部，后续中间回复只更新步骤内容，
                  // 不再把卡片逐段推到最新 pending 消息下面。
                  const liveMessage = g.msgs.find((message) => message.pending || message.settledPending);
                  const groupLiveSteps = liveMessage ? liveStepsFor(liveMessage) : [];
                  const groupLiveToolIds = new Set(groupLiveSteps.flatMap((step) => step.toolCallId ? [step.toolCallId] : []));
                  return (
                    <div
                      key={groupRenderKey}
                      ref={(el) => {
                        // 渲染 key 恒有 → 无 id 组（cron 投递等）也能被引用跳转锚定（R155）。
                        // 同时注册各条消息的操作 ID，让已有置顶在组归并后仍能定位。
                        if (el) {
                          groupRefs.current.set(groupRenderKey, el);
                          pinIds.forEach((id) => groupRefs.current.set(id, el));
                        } else {
                          groupRefs.current.delete(groupRenderKey);
                          pinIds.forEach((id) => groupRefs.current.delete(id));
                        }
                      }}
                      onContextMenu={(e) => openMenu(e, g)}
                    >
                      <div className={`chat-group ${cls}${searchTargetGroupKey === groupRenderKey ? " is-search-target" : ""}`}>
                        <div className="chat-group__stack">
                          {showTraj && groupLiveSteps.length ? (
                            <TurnProcess
                              key={`${groupRenderKey}:live-trajectory`}
                              steps={groupLiveSteps}
                              pluginConversation={activePluginConversation}
                              live={liveMessage?.pending === true}
                              defaultOpen
                              onOpenLargeView={() => openTimelineModal(groupLiveSteps, liveMessage?.ts ?? g.ts, true)}
                            />
                          ) : null}
                          {/* display:contents 包装不产生盒子（stack 的 flex/gap 不受影响），
                              只为右键菜单提供 data-mi 落点定位（R154 按气泡引用） */}
                          {keyedMessages.map(({ item: m, key: messageRenderKey, images: keyedImages, files: keyedFiles, parts: keyedParts }, mi) => (
                            <div key={messageRenderKey} data-mi={mi} data-message-key={messageRenderKey} data-chat-message-id={m.actionId} style={{ display: "contents" }}>
                              {m.images?.length ? (
                                <div className="chat-att-row">
                                  {keyedImages.map(({ item: src, key: imageRenderKey }) => (
                                    <img
                                      key={imageRenderKey}
                                      className="chat-att-thumb"
                                      src={src}
                                      alt=""
                                      onClick={() => setLightbox({ src, kind: "image" })}
                                    />
                                  ))}
                                </div>
                              ) : null}
                              {m.files?.length ? (
                                <div className="chat-att-row">
                                  {keyedFiles.map(({ item: f, key: fileRenderKey }) =>
                                    // 视频（带 src）= 可播放的预览窗，点击进 lightbox；
                                    // 其余（含大到没缓存 src 的视频）= 文件 chip。
                                    f.kind === "video" && f.src ? (
                                      <span
                                        key={fileRenderKey}
                                        className="chat-att-videowrap"
                                        title={attachmentChipTitle(f)}
                                        onClick={() => setLightbox({ src: f.src as string, kind: "video" })}
                                      >
                                        <video
                                          className="chat-att-thumb chat-att-video"
                                          src={f.src}
                                          preload="metadata"
                                          muted
                                          playsInline
                                        />
                                        <span className="chat-att-play">▶</span>
                                      </span>
                                    ) : (
                                      <ChatFileButton key={fileRenderKey} name={f.name}
                                        title={`${t("chat.artifactsRevealInFolder")} · ${attachmentChipTitle(f)}`}
                                        onClick={() => void revealAttachmentFile(f)} />
                                    ),
                                  )}
                                </div>
                              ) : null}
                              {m.role === "user" && m.pluginSelection?.length ? (
                                <div className="chat-plugin-selection-badge" title={t("chat.pluginChosenHint")}>
                                  {t("chat.pluginChosen")} · {m.pluginSelectionSnapshot?.length
                                    ? m.pluginSelectionSnapshot.map(item => `${item.packageName}${item.declaredVersion ? ` ${item.declaredVersion}` : ""}`).join("、")
                                    : m.pluginSelection.length}
                                </div>
                              ) : null}
                              {m === liveMessage && activeRunInFlight && activeKey && runWaitBySession[activeKey]?.kind === "retrying" && (
                                <div className="chat-bubble is-error" data-testid="chat-retry-status">
                                  <ChatRunWait state={runWaitBySession[activeKey]} />
                                </div>
                              )}
                              {keyedParts.map(({ item: p, key: k }, pi) => {
                              if (p.type === "timeline") {
                                // R355:开关语义=整个 Agent Trajectory 的显示/隐藏(用户定案)。
                                // 关 → 连摘要行都不渲染;开 → 摘要行+可展开,时间线含完整过程
                                // (思考+工具,不再单独过滤思考步)。
                                if (!showTraj || !p.steps?.length) return null;
                                // Interim messages retain their process for settlement.
                                // The current live trajectory already displays these calls.
                                const tools = p.steps.filter((step) => step.kind === "tool");
                                if (tools.length && tools.every((step) => step.toolCallId && groupLiveToolIds.has(step.toolCallId))) return null;
                                if (!tools.length && p.steps.every(step => step.activity && groupLiveSteps.some(live => live.id === step.id))) return null;
                                const steps = subagentActivity.project(activeKey || "", p.steps, m.activityRunId || m.nativeRunId);
                                return <TurnProcess key={k} steps={steps} pluginConversation={activePluginConversation} onOpenLargeView={() => openTimelineModal(steps, m.ts, false, m.activityRunId || m.nativeRunId)} />;
                              }
                              if (p.type === "ui_artifact" && p.uiArtifact) {
                                return <ChatUiArtifact key={k} part={p.uiArtifact} backend={activeBackend}
                                  agentId={agentOf(activeKey || "")} sessionKey={activeKey || ""} visible={!immersive} autoActivate={p.uiArtifact.sourceEventId === latestNativeUiSourceEventId} onCancel={runId => send("chat.abort", { sessionKey: activeKey, runId })} />;
                              }
                              if (p.type === "canvas") {
                                return (
                                  <ChatWidget
                                    key={`${activeKey ?? ""}:${k}`}
                                    part={p.preview ? p as ChatCanvasWidgetPart : null}
                                    backendId={activeBackend}
                                    sessionKey={activeKey ?? ""}
                                    onSendPrompt={sendCanvasWidgetPrompt}
                                    canPin={canPinActiveCanvas}
                                    pinned={p.preview?.boardWidgetName
                                      ? pinnedSessionBoardWidgets.has(p.preview.boardWidgetName)
                                      : false}
                                    pinning={sessionBoardMutating}
                                    onPinCanvas={pinCanvasWidget}
                                  />
                                );
                              }
                              // Live thought/tool activity stays in the timeline; plans use the composer dock.
                              if (m.pending && (p.type === "thinking" || p.type === "toolCall" || p.type === "toolResult")) {
                                if (liveStepsFor(m).length) return null;
                              }
                              if (p.type === "prompt") {
                                if (!p.promptEntry) return null;
                                return <ChatPromptCard key={k} entry={p.promptEntry} onRespond={respondPrompt}
                                  agentName={active ? sessionName(active) : undefined} />;
                              }
                              if (p.type === "thinking") {
                                if (!showThinking || !p.text?.trim()) return null;
                                return (
                                  <div key={k} className="chat-thinking">
                                    <span className="chat-thinking__ico"><IconBulb /></span>
                                    <ChatMarkdown
                                      className="chat-thinking__body chat-md"
                                      text={formatReasoningMarkdown(p.text)}
                                    />
                                  </div>
                                );
                              }
                              if (p.type === "toolCall") {
                                if (!showTools) return null;
                                const title = toolActivityTitle(p.toolName, p.toolArgs, t);
                                // …and make the card expandable to reveal the raw input args
                                // (OpenClaw's "TOOL INPUT" panel), like the output cards.
                                const argsBody =
                                  p.toolArgs && typeof p.toolArgs === "object" && Object.keys(p.toolArgs).length
                                    ? JSON.stringify(p.toolArgs, null, 2)
                                    : undefined;
                                return (
                                  <Card
                                    key={k}
                                    icon={<IconWrench />}
                                    name={title}
                                    body={argsBody}
                                    diff={p.diff}
                                    diffText={p.diffText}
                                  />
                                );
                              }
                              if (p.type === "toolResult") {
                                if (!showTools) return null;
                                // Per-part error flag (set by normalize/live), NOT the message's —
                                // a failed tool renders the red "Tool error <name>" card, matching
                                // OpenClaw; a success renders "Tool output <name>".
                                const err = toolResultFailed(p.text, p.isError ?? (m.isError ? true : undefined));
                                const action = toolActivityTitle(p.toolName, p.toolArgs, t);
                                const name = err
                                  ? p.toolName
                                    ? t("chat.toolErrorNamed", { tool: action })
                                    : t("chat.toolError")
                                  : p.toolName
                                    ? t("chat.toolOutputNamed", { tool: action })
                                    : t("chat.toolOutput");
                                return (
                                  <Card
                                    key={k}
                                    icon={<IconWrench />}
                                    name={name}
                                    status={err ? t("common.error") : p.durationS != null ? `${p.durationS >= 10 ? Math.round(p.durationS) : p.durationS.toFixed(1)}s` : undefined}
                                    body={p.text}
                                    summary={formatToolResultSummary(p.text)}
                                    diff={p.diff}
                                    diffText={p.diffText}
                                    isError={err}
                                  />
                                );
                              }
                              // local (client-generated) slash-command result → neutral markdown info bubble
                              if (m.local) {
                                if (!p.text?.trim()) return null;
                                return (
                                  <ChatMarkdown
                                    key={k}
                                    className="chat-bubble chat-md is-local"
                                    data-qp={pi}
                                    text={p.text}
                                  />
                                );
                              }
                              // text part: settled text renders as markdown; while streaming we now
                              // also render markdown (so code blocks/lists/bold take shape live), with
                              // the cursor trailing the rendered HTML.
                              if (m.pending) {
                                const waitingForPrompt = m.parts.some(part => part.type === "prompt" && part.promptEntry
                                  && chatPromptAttentionOf([part.promptEntry]));
                                if (waitingForPrompt && !p.text?.trim()) return null;
                                return (
                                  <div key={k} className="chat-bubble is-streaming" data-qp={pi}>
                                    {p.text?.trim() ? (
                                      <ChatMarkdown
                                        className="chat-md"
                                        text={p.text}
                                        htmlArtifactPolicy={m.role === "assistant" ? activeLegacyHtmlPolicy : "source"}
                                      />
                                    ) : null}
                                    {/* 等首字节 = 双球融合（"在思考"）；已出字 = 打字光标（"在输出"） */}
                                    {!waitingForPrompt && pi === m.parts.length - 1 &&
                                      (p.text?.trim() ? <span className="chat-cursor">●</span> : <FusionLoader size="sm" ariaLabel={t("chat.liveStatus.running")} />)}
                                  </div>
                                );
                              }
                              if (m.role === "system" || m.stopReason === "error" || m.isError) {
                                // Known gateway error strings are rewritten via i18n at render
                                // time (so they follow language switches); raw English stays on
                                // the hover title for triage. Unknown strings pass through as-is.
                                const rawErr = p.text ?? "";
                                const translated = rawErr ? translateGatewayError(rawErr, t) : "";
                                const shownErr = m.errPrefix ? t(m.errPrefix, { msg: translated || t("chat.unknown") }) : translated;
                                return (
                                  <div key={k} className="chat-bubble is-error" data-qp={pi} title={translated !== rawErr && rawErr ? rawErr : undefined}>
                                    {shownErr}
                                    {pi === m.parts.length - 1 && (m.repeat ?? 1) > 1 ? (
                                      <span
                                        className="chat-bubble__repeat"
                                        title={t("chat.repeatedErrors", { count: m.repeat })}
                                      >
                                        ×{m.repeat}
                                      </span>
                                    ) : null}
                                  </div>
                                );
                              }
                              if (!p.text?.trim()) return null;
                              // System-injected automation prompt (cron/heartbeat envelope) →
                              // compact expandable row instead of a giant user bubble (黄墙).
                              if (m.role === "user" && isInjectedPrompt(m)) {
                                return <InjectedRow key={k} text={p.text} />;
                              }
                              // A sent user message that carries a quote → collapse each leading
                              // blockquote to one clickable line (jump to the quoted message) and
                              // render the body normally, instead of a full markdown blockquote.
                              const qr = m.role === "user" ? parseQuoteFromText(p.text) : null;
                              if (qr) {
                                return (
                                  <Fragment key={k}>
                                    {keyedChatChildren(m, "quote", qr.quotes).map(({ item: q, key: quoteRenderKey }) => (
                                      <button
                                        key={quoteRenderKey}
                                        type="button"
                                        className="chat-quote-ref"
                                        // 悬停展示引用文本核对（R152 全文引用可达 2 万字，显示层限长——
                                        // 行 300 / tooltip 600，payload 不受影响），再附跳转提示
                                        title={`${q.length > 600 ? `${q.slice(0, 600)}…` : q}\n\n${t("chat.jumpToQuoted")}`}
                                        onClick={() => jumpToQuoted(q)}
                                      >
                                        <span className="chat-quote-ref__ico">↩</span>
                                        <span className="chat-quote-ref__text">{q.length > 300 ? `${q.slice(0, 300)}…` : q}</span>
                                      </button>
                                    ))}
                                    {qr.body.trim() ? (
                                      <ChatMarkdown
                                        className="chat-bubble chat-md"
                                        data-qp={pi}
                                        text={qr.body}
                                      />
                                    ) : null}
                                  </Fragment>
                                );
                              }
                              // Agent replies may carry OpenClaw `MEDIA:<path/url>` directive
                              // lines (its way of attaching images); the gateway returns them as
                              // raw text, so pull them out and render the images ourselves (local
                              // paths via /__media, URLs directly). See lib/agentMedia.ts.
                              const media =
                                m.role === "assistant"
                                  ? extractAgentMedia(p.text, imageContext)
                                  : { text: p.text, srcs: [] as string[] };
                              return (
                                <Fragment key={k}>
                                  {media.srcs.length ? (
                                    <div className="chat-att-row">
                                      {keyedChatChildren(m, "media", media.srcs).map(({ item: src, key: mediaRenderKey }) => (
                                        <img
                                      key={mediaRenderKey}
                                      className="chat-att-thumb"
                                      src={src}
                                      alt=""
                                      onClick={() => setLightbox({ src, kind: "image" })}
                                    />
                                      ))}
                                    </div>
                                  ) : null}
                                  {media.text.trim() ? (
                                    <ChatMarkdown
                                      className={`chat-bubble chat-md${messageRenderKey === latestAssistantMessageKey ? " is-latest-reply" : ""}${m.keepLiveLayout ? " is-streamed-reply" : ""}`}
                                      data-qp={pi} /* R154：右键引用按这条气泡取文 */
                                      text={media.text}
                                      htmlArtifactPolicy={m.role === "assistant" ? activeLegacyHtmlPolicy : "source"}
                                    />
                                  ) : null}
                                  {activeBackendDescriptor?.surfaces.agentHarness === true && pi === m.parts.map(part => part.type).lastIndexOf("text")
                                    ? nativeUiLegacySources(m).map(({ text, sourceEventId }) => <LegacyChatUi key={`legacy:${sourceEventId}`} text={text}
                                      sourceEventId={sourceEventId} backend={activeBackend} agentId={agentOf(activeKey || "")} sessionKey={activeKey || ""} visible={!immersive} />) : null}
                                </Fragment>
                              );
                              })}
                            </div>
                          ))}
                        </div>
                        {g.role !== "toolResult" && (
                        <div className="chat-group__footer">
                          {footerTs ? (
                            <>
                              <span className="dot">·</span>
                              <span>{absTime(footerTs)}</span>
                            </>
                          ) : null}
                          <ChatResponseMetadata metadata={metadata} fallbackModel={last.model} />
                          {!last.pending && isErrorTurn(last) && (
                            <button
                              type="button"
                              className="chat-copybtn chat-retrybtn"
                              title={t("chat.retry")}
                              disabled={sending}
                              onClick={() => retryErrorGroup(g)}
                            >
                              <IconRetry />
                            </button>
                          )}
                          {!last.pending && g.msgs.some((m) => m.parts.some((p) => p.text?.trim())) && (
                            <button
                              type="button"
                              className="chat-copybtn"
                              title={t("chat.copyAsMarkdown")}
                              onClick={() => copyText(groupCopyText(g))}
                            >
                              <IconCopy />
                            </button>
                          )}
                          {!last.pending && g.msgs.some((m) => m.actionId) && (
                            <>
                              {MESSAGE_PINNING_ENABLED && <button
                                type="button"
                                className={g.msgs.some((m) => m.actionId && pinnedIds.has(m.actionId)) ? "chat-copybtn is-pinned" : "chat-copybtn"}
                                title={g.msgs.some((m) => m.actionId && pinnedIds.has(m.actionId)) ? t("chat.unpin") : t("chat.pin")}
                                onClick={() => pinGroup(g)}
                              >
                                <IconPin />
                              </button>}
                              <button type="button" className="chat-copybtn" title={t("chat.deleteLocal")} onClick={() => deleteGroup(g)}>
                                <IconTrash />
                              </button>
                            </>
                          )}
                        </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                {/* send-anchor standing room — height driven imperatively by sizeStreamSpacer */}
                <div ref={streamSpacerRef} className="chat-stream-spacer" aria-hidden="true" />
                <div ref={bottomRef} />
              </div>
            </div>

            {showSessionBoard && sessionBoardViewMode !== "chat" ? (
              <div className="chat-board-pane">
                <SessionBoardView
                  key={activeSessionBoardScope}
                  result={sessionBoardForDisplay}
                  backendId={activeBackend}
                  agentId={agentOf(activeKey || "")}
                  sessionKey={activeKey || ""}
                  hostGeneration={`${connected ? "connected" : "disconnected"}:${capsEpoch}`}
                  loading={sessionBoardLoading}
                  mutating={sessionBoardMutating}
                  stale={sessionBoardStale}
                  onRefresh={() => setSessionBoardReload((value) => value + 1)}
                  onMove={moveSessionBoardWidget}
                  onRemove={(widget) => { void removeSessionBoardWidget(widget); }}
                  onGrant={(widget, decision) => { void decideSessionBoardGrant(widget, decision); }}
                />
              </div>
            ) : null}

            {/* The plan and input share the bottom dock, outside the scrollable conversation. */}
            <div className="chat-botdock" data-native-ui-clip-edge="bottom">
            {showJump && (
              <button type="button" className="chat-jump" onClick={jumpToLatest} title={t("chat.jumpToLatest")}>
                ↓ {t("chat.latestMessage")}
              </button>
            )}
            {/* bottom context meter: only surfaced once the window is nearly full (>80%) */}
            {ctxPct != null && ctxPct > 80 && (
              <div className="chat-ctx">
                <span className="chat-ctx__meter">
                  <span className="chat-ctx__fill" style={{ width: `${ctxPct}%` }} />
                </span>
                <span>
                  {ctxPct}% · {fmtTokens(active.totalTokens)} / {fmtTokens(ctxLimit)}
                </span>
              </div>
            )}

            {!immersive && planDock}
            <div
              className="chat-composer"
              data-chat-composer
              onDrop={supportsActiveAttachments ? onDropFiles : undefined}
              onDragOver={supportsActiveAttachments ? (e) => e.preventDefault() : undefined}
            >
              {!immersive && slashMenuNode}
              {/* 待发队列（R357）：生成中回车的消息排在这里，回合终结后自动链式补发。
                  chip 主体可点=取回编辑；×=单删；≥2 条时出「清空排队」。 */}
              {activeQueue.length > 0 && (
                <div className="chat-queue">
                  {/* 连不上时说明队列为什么不动——否则「排了一堆没反应」看着像卡死。 */}
                  {activeKey && !queueSendable(activeKey) && (
                    <span className="chat-queue__pending">{t("chat.queuePendingReconnect")}</span>
                  )}
                  {activeQueue.map((m, i) => (
                    <div key={m.id} className="chat-queue__chip">
                      <span className="chat-queue__idx">{i + 1}</span>
                      <button
                        type="button"
                        className="chat-queue__text"
                        title={t("chat.queueEditHint")}
                        onClick={() => reclaimQueued(m.id)}
                      >
                        {m.text.length > 200 ? `${m.text.slice(0, 200)}…` : m.text || "📎"}
                        {m.atts.length > 0 && <span className="chat-queue__att">📎{m.atts.length}</span>}
                      </button>
                      <button type="button" className="chat-queue__x" title={t("common.remove")} onClick={() => removeQueued(m.id)}>
                        ×
                      </button>
                    </div>
                  ))}
                  {activeQueue.length >= 2 && (
                    <button type="button" className="chat-queue__clear" onClick={clearQueue}>
                      {t("chat.queueClearAll")}
                    </button>
                  )}
                </div>
              )}
              {quote && (
                <div className="chat-quote-bar">
                  <span className="chat-quote-bar__ico">↩</span>
                  {/* title = 悬停核对将随消息发出的引用文本（显示层限长 300/600，payload 全文不受影响） */}
                  <span
                    className="chat-quote-bar__text"
                    title={quote.text.length > 600 ? `${quote.text.slice(0, 600)}…` : quote.text}
                  >
                    {quote.text.length > 300 ? `${quote.text.slice(0, 300)}…` : quote.text}
                  </span>
                  <button type="button" className="chat-quote-bar__x" title={t("chat.removeQuote")} onClick={() => setQuote(null)}>
                    ×
                  </button>
                </div>
              )}
              {attachments.length > 0 && (
                <div className="chat-att-row chat-att-row--pending">
                  {attachments.map((a) => (
                    <div
                      key={a.id}
                      className={
                        !a.kind || a.kind === "image" || a.kind === "video"
                          ? "chat-att-chip"
                          : "chat-att-chip chat-att-chip--file"
                      }
                    >
                      {!a.kind || a.kind === "image" ? (
                        <img src={a.dataUrl} alt={a.name} />
                      ) : a.kind === "video" ? (
                        // 待发区也给视频真预览（首帧），而不是一个看不出内容的文件名。
                        <video src={a.dataUrl} title={a.name} preload="metadata" muted playsInline />
                      ) : (
                        <button type="button" className="chat-att-chip__open" title={`${t("chat.artifactsRevealInFolder")} · ${a.name}`}
                          onClick={() => void revealAttachmentFile({ name: a.name, src: a.dataUrl })}>
                          <ChatFileLabel name={a.name} />
                        </button>
                      )}
                      <button type="button" className="chat-att-x" onClick={() => removeAttachment(a.id)}
                        title={t("common.remove")} aria-label={`${t("common.remove")} ${a.name}`}>
                        <span aria-hidden="true">{a.kind && a.kind !== "image" && a.kind !== "video" ? "✕" : "×"}</span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                ref={composerRef}
                className="chat-composer__input"
                value={input}
                placeholder={activeWriterHint || t("chat.composerPlaceholder", { name: sessionName(active) })}
                aria-describedby={activeWriterHint ? "chat-codex-writer-status" : undefined}
                onPaste={supportsActiveAttachments ? onPasteImages : undefined}
                onChange={(e) => composerChange(e.target.value)}
                onKeyDown={composerKeyDown}
              />
              {activeWriterHint && <div id="chat-codex-writer-status" role="status" className={input ? "chat-composer__writer-status" : "chat-composer__writer-status is-empty"}>{activeWriterHint}</div>}
              <input
                ref={fileInputRef}
                type="file"
                accept={attachAccept}
                multiple
                hidden
                onChange={(e) => {
                  onPickFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <div className="chat-composer__bar">
                <div className="chat-composer__left" title={activeRunInFlight ? t("chat.settingsNextTurn") : undefined}>
                  <div className="chat-composer__model-controls">
                    {!immersive && <ChatPluginPicker
                      sessionKey={activeKey}
                      backendId={activeBackend}
                      selectionSupported={pluginSelectionReadiness.supported}
                      selectionChecking={pluginSelectionReadiness.checking}
                      onRetryReadiness={pluginSelectionReadiness.refresh}
                      selected={activeKey ? pluginSelections[activeKey] ?? [] : []}
                      onChange={(selection) => { if (activeKey) setPluginSelectionFor(activeKey, selection); }}
                      onSelectionValidity={onPluginSelectionValidity}
                      onBrowse={browsePlugins}
                    />}
                    <span className={listLive ? undefined : "is-stale"}>
                      <ChatModelMenu
                        models={usesRuntimeModelPicker ? selectableModels.map(model => ({ ...model, disabled: !runtimeModels.data?.selection.canSwitch
                          && (model as import("../types").SessionRuntimeModel).bindingId !== runtimeModels.data?.selection.bindingId })) : selectableModels}
                        activeModel={displayModel}
                        activeProvider={displayModelProvider}
                        activeBindingId={runtimeModels.data?.selection.bindingId}
                        runtimeGroups={usesRuntimeModelPicker ? runtimeModels.data?.runtimes ?? [] : undefined}
                        onSelect={selectComposerModel}
                        loading={usesRuntimeModelPicker ? runtimeModels.loading : modelsLoading}
                        loadError={usesRuntimeModelPicker ? runtimeModels.error : modelsError}
                        onRefresh={refreshModelMenu}
                        disabled={nativeModelSelectionDisabled}
                      />
                    </span>
                  </div>
                  {(activeThinkingOptions?.length || activeThinkingDefault || activeFastCapable) && (
                    <ChatThinkFastMenu
                      key={active.key}
                      levels={
                        (activeThinkingOptions?.length || activeThinkingDefault)
                          ? (activeThinkingOptions ?? [
                              "off",
                              "minimal",
                              "low",
                              "medium",
                              "high",
                              ...(xhighSupported ? ["xhigh"] : []),
                              "adaptive",
                            ])
                          : []
                      }
                      value={active.thinkingLevel ?? ""}
                      defaultValue={activeThinkingDefault}
                      defaultLabel={t("chat.defaultLevel")}
                      levelLabel={thinkLabel}
                      fastCapable={!!activeFastCapable}
                      fastOn={!!(active.fastMode ?? (activeKey ? fastByKey[activeKey] : false))}
                      disabled={!connected}
                      onChangeThinking={(level) => {
                        return patchSession({ thinkingLevel: level || null }, t("chat.labelThinking"));
                      }}
                      onChangeFast={(next) => {
                        const key = activeKeyRef.current;
                        if (!key) return;
                        const previous = sessionsRef.current.find((row) => row.key === key)?.fastMode ?? fastByKey[key] ?? false;
                        if (next === previous) return;
                        void (async () => {
                          if (await patchSession({ fastMode: next }, "fast")) {
                            setFastByKey((m) => ({ ...m, [key]: next }));
                          }
                        })();
                      }}
                    />
                  )}
                  <ChatPermissionMenu
                    options={permissionOptions}
                    activeMode={activePermissionMode}
                    onSelect={(option) => { void changePermissionMode(option); }}
                    disabled={!connected}
                  />
                  <button
                    type="button"
                    className={showTraj ? "chat-iconbtn is-active" : "chat-iconbtn"}
                    title={showTraj ? t("chat.hideTrajectory") : t("chat.showTrajectory")}
                    aria-pressed={showTraj}
                    onClick={() => setShowTraj((v) => !v)}
                  >
                    <IconTrajectory />
                  </button>
                </div>
                <div className="chat-composer__right">
                  <button
                    className={listening ? "chat-iconbtn is-active" : "chat-iconbtn"}
                    onClick={toggleTalk}
                    disabled={!sttSupported}
                    aria-pressed={listening}
                    title={sttSupported ? (listening ? t("chat.stopTalk") : t("chat.startTalk")) : t("chat.sttUnsupported")}
                  >
                    <IconMic />
                  </button>
                  {supportsActiveAttachments && (
                    <button
                      className="chat-iconbtn"
                      onClick={() => fileInputRef.current?.click()}
                      title={t(activeCaps?.attachments.file || activeCaps?.attachments.pdf ? "chat.attachFile" : "chat.attachImage")}
                    >
                      <IconClip />
                    </button>
                  )}
                  {activeRunInFlight ? (
                    <button
                      type="button"
                      className="chat-iconbtn chat-send chat-stop"
                      onClick={abortActive}
                      title={t("chat.stopGenerating")}
                    >
                      <IconStop />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="chat-iconbtn chat-send"
                      data-send-entry="composerButton"
                      onClick={() => sendController.composerButton(activeKeyRef.current, () => { void submit(); })}
                      disabled={!activeSendReady || (!input.trim() && !attachments.length)}
                      title={t("chat.send")}
                    >
                      <IconSend />
                    </button>
                  )}
                </div>
              </div>
            </div>
            </div>
          </>
        )}
      </section>
    </div>
    {/* 右键菜单：提升到 Fragment 顶层（.chat-shell 外）供普通/沉浸两模式共用——
        position:fixed + state 驱动，DOM 位置不影响视觉；z 抬到沉浸层(1000)之上
        （ChatPage.css .chat-ctxmenu* 1199/1200）。 */}
    {agentMenu && (
      <>
        <div className="chat-ctxmenu__backdrop" onClick={() => setAgentMenu(null)} onWheel={() => setAgentMenu(null)}
          onContextMenu={(e) => { e.preventDefault(); setAgentMenu(null); }} />
        <div className="chat-ctxmenu" style={{ left: Math.min(agentMenu.x, window.innerWidth - 184),
          top: Math.min(agentMenu.y, window.innerHeight - 80) }}>
          <button type="button" className="chat-ctxmenu__item"
            disabled={!GROUP_MEMBER_BACKEND_IDS.has(agentMenu.agent.backendId)}
            title={!GROUP_MEMBER_BACKEND_IDS.has(agentMenu.agent.backendId) ? t("groupChat.unsupportedBackend") : undefined}
            onClick={() => { setCreateGroupFor(agentMenu.agent); setAgentMenu(null); }}>
            <span>{t("groupChat.createFromAgent")}</span>
          </button>
        </div>
      </>
    )}
    {createGroupFor && (
      <GroupChatCreateModal
        initial={createGroupFor}
        agents={agents.map((g) => ({ backendId: backendOfKnownAgent(g.agentId), agentId: g.agentId,
          name: g.sessions[0].agentName || chatAgentDisplayName(g.agentId) }))}
        onClose={() => setCreateGroupFor(null)}
        onCreated={(groupId) => { void refreshGroupChats(); setOpenGroup({ groupId, activeKey }); }}
      />
    )}
    {menu && <ChatMessageContextMenu x={menu.x} y={menu.y} onClose={closeMenu}
      onCopy={menu.copyText ? () => copyText(menu.copyText) : undefined}
      onQuote={groupSnippet(menu.group) ? () => quoteGroup(menu.group, menu.msgIndex, menu.partIndex) : undefined}
      onPin={menu.group.msgs.some(message => message.actionId) ? () => pinGroup(menu.group) : undefined}
      pinned={menu.group.msgs.some(message => message.actionId && pinnedIds.has(message.actionId))}
      onDelete={menu.group.msgs.some(message => message.actionId) ? () => deleteGroup(menu.group) : undefined}
      extra={SHOW_SESSION_FORK && menuForkEntryId && activeKey ? <button type="button" role="menuitem"
        className="chat-ctxmenu__item" disabled={runningKeys.has(activeKey)}
        onClick={() => { closeMenu(); void forkFromEntry(activeKey, menuForkEntryId); }}>
        <IconFork /><span>{t("chat.advanced.forkHere")}</span>
      </button> : undefined} />}

    {immersive && (
        <ImmersiveChat
          onExit={() => setImmersive(false)}
          phase={immersivePhase}
          live={immersiveLive}
          sendSeq={immersiveSendSeq}
          onNearTop={maybeLoadArchive}
          historyControl={historyControl}
          unreadAnchor={unreadAnchor ?? undefined}
          onDropFiles={onDropFiles}
          input={input}
          setInput={composerChange}
          inputElRef={immersiveInputRef}
          onInputKeyDown={composerKeyDown}
          onInputPaste={onPasteImages}
          submit={(overrideText) => {
            sendController.immersiveButton(activeKeyRef.current, () => { void submit(overrideText); });
          }}
          sending={activeRunInFlight}
          abortActive={abortActive}
          hasActiveSession={!!active}
          canSend={activeSendReady}
          writerHint={activeWriterHint}
          recoveryNotice={recoveryNotice}
          slashMenu={slashMenuNode}
          planDock={planDock}
          slashOpen={slashOpen}
          pluginPicker={<ChatPluginPicker
            sessionKey={activeKey}
            backendId={activeBackend}
            selectionSupported={pluginSelectionReadiness.supported}
            selectionChecking={pluginSelectionReadiness.checking}
            onRetryReadiness={pluginSelectionReadiness.refresh}
            selected={activeKey ? pluginSelections[activeKey] ?? [] : []}
            onChange={(selection) => { if (activeKey) setPluginSelectionFor(activeKey, selection); }}
            onSelectionValidity={onPluginSelectionValidity}
            onBrowse={browsePlugins}
          />}
          attachments={attachments}
          removeAttachment={removeAttachment}
          quoteText={quote && quote.key === activeKey ? quote.text : null}
          clearQuote={() => setQuote(null)}
          sessionTitle={active ? sessionName(active) : ""}
          sessionMeta={active ? friendlySessionLabel(active, t) : ""}

          liveStatusKind={active ? statusOf(active.key) : "offline"}
          activeAgentId={activeKey ? agentOf(activeKey) : null}
          activeBackendId={activeBackend}
          avatarVersion={avatarVersion}
          sessions={sessionMenuRows.map((s) => ({ ...s, active: s.key === activeKey }))}
          openSession={openSession}
          onRefresh={refreshChat}
          sessionLabel={active?.label ?? ""}
          onRenameSubmit={(label) => void renameSessionTo(label)}
          onDelete={deleteActiveSession}
          openLightbox={(src: string, kind?: "image" | "video") => setLightbox({ src, kind: kind ?? "image" })}
          revealAttachmentFile={revealAttachmentFile}
          lightboxOpen={!!lightbox}
          onRespondPrompt={respondPrompt}
          messages={immersiveMessages}
          models={usesRuntimeModelPicker ? selectableModels.map(model => ({ ...model, disabled: !runtimeModels.data?.selection.canSwitch
                        && (model as import("../types").SessionRuntimeModel).bindingId !== runtimeModels.data?.selection.bindingId })) : selectableModels}
          displayModel={displayModel}
          changeModel={selectComposerModel}
          activeBindingId={runtimeModels.data?.selection.bindingId}
          runtimeGroups={usesRuntimeModelPicker ? runtimeModels.data?.runtimes ?? [] : undefined}
          activeModelProvider={displayModelProvider}
          modelsLoading={usesRuntimeModelPicker ? runtimeModels.loading : modelsLoading}
          modelsError={usesRuntimeModelPicker ? runtimeModels.error : modelsError}
          refreshModels={refreshModelMenu}
          modelSelectionDisabled={nativeModelSelectionDisabled}
          permissionOptions={permissionOptions}
          permissionMode={activePermissionMode}
          changePermissionMode={(option) => { void changePermissionMode(option); }}
          permissionSelectionDisabled={!connected}
          listLive={listLive}
          thinkingLevel={active?.thinkingLevel ? thinkLabel(active.thinkingLevel) : ""}
          ctxSummary={ctxPct != null ? `${ctxPct}% · ${fmtTokens(active?.totalTokens)}/${fmtTokens(ctxLimit)}` : ""}
          listening={listening}
          toggleTalk={toggleTalk}
          sttSupported={sttSupported}
          onAttachClick={() => fileInputRef.current?.click()}
          supportsAttachments={supportsActiveAttachments}
        />
    )}
    </ChatMediaContext.Provider>
  );
}

type HistoryFixtureMessage = { id?: string; text?: string };
type HistoryFixtureSession = { key: string; title?: string; backendId?: string };

interface HistoryFixtureSnapshot {
  activeKey: string | null;
  messages: HistoryFixtureMessage[];
}

interface ChatPageTestDeps {
  subscribe(listener: () => void): () => void;
  getSnapshot(): HistoryFixtureSnapshot;
  controller: ReturnType<typeof createHistoryController<HistoryFixtureMessage>>;
  lastActive: string;
  sendHarness?: {
    snapshot(): {
      draft: string;
      attachments: Array<{ id: string; dataUrl?: string; name?: string }>;
      quote: { id?: string; text?: string } | null;
      immersive: boolean;
      canSend: boolean;
    };
    setDraft(value: string): void;
    invoke(entry: ChatSendEntry): void;
  };
}

type ChatSendEntry = "composerButton" | "composerEnter" | "immersiveButton" | "immersiveEnter";

function ChatPageHistoryFixture({ deps }: { deps: ChatPageTestDeps }) {
  const [snapshot, setSnapshot] = useState(deps.getSnapshot);
  const immersiveInputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => deps.subscribe(() => setSnapshot(deps.getSnapshot())), [deps]);
  useEffect(() => {
    void deps.controller.bootstrap(deps.lastActive);
  }, [deps]);
  const send = deps.sendHarness?.snapshot();
  const composer = send ? (
    <>
      <textarea
        value={send.draft}
        onChange={(event) => deps.sendHarness?.setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            deps.sendHarness?.invoke("composerEnter");
          }
        }}
      />
      <button
        type="button"
        data-send-entry="composerButton"
        disabled={!send.canSend || (!send.draft.trim() && !send.attachments.length)}
        onClick={() => deps.sendHarness?.invoke("composerButton")}
      >
        Send
      </button>
    </>
  ) : null;
  return (
    <div data-active-session={snapshot.activeKey ?? undefined}>
      {snapshot.messages.map((message, index) => <div key={message.id ?? index}>{message.text ?? ""}</div>)}
      {composer}
      {send?.immersive && (
        <ImmersiveChat
          onExit={() => {}}
          phase="offline"
          live={null}
          sendSeq={0}
          onNearTop={() => {}}
          onDropFiles={(event) => event.preventDefault()}
          messages={[]}
          input={send.draft}
          setInput={(value) => deps.sendHarness?.setDraft(value)}
          inputElRef={immersiveInputRef}
          onInputKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              deps.sendHarness?.invoke("immersiveEnter");
            }
          }}
          onInputPaste={() => {}}
          submit={() => deps.sendHarness?.invoke("immersiveButton")}
          sending={false}
          abortActive={() => {}}
          hasActiveSession={!!snapshot.activeKey}
          canSend={send.canSend}
          slashMenu={null}
          slashOpen={false}
          models={[]}
          displayModel=""
          changeModel={() => {}}
          modelSelectionDisabled={false}
          listLive
          thinkingLevel=""
          ctxSummary=""
          listening={false}
          toggleTalk={() => {}}
          sttSupported={false}
          onAttachClick={() => {}}
          supportsAttachments
          attachments={send.attachments.map((item) => ({ id: item.id, dataUrl: item.dataUrl ?? "", name: item.name ?? item.id }))}
          removeAttachment={() => {}}
          quoteText={send.quote?.text ?? null}
          clearQuote={() => {}}
          sessionTitle="Hermes"
          sessionMeta=""
          liveStatusKind="connecting"
          activeAgentId={snapshot.activeKey ? agentOf(snapshot.activeKey) : null}
          activeBackendId="hermes"
          avatarVersion={0}
          sessions={[]}
          openSession={() => {}}
          onRefresh={() => {}}
          sessionLabel=""
          onRenameSubmit={() => {}}
          onDelete={() => {}}
          openLightbox={() => {}}
          lightboxOpen={false}
          onRespondPrompt={() => {}}
        />
      )}
    </div>
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** 仅供真实 BrowserWindow 回归驱动；生产页面仍走上面的同一个 controller。 */
export function createChatPageTestFixture(options: {
  lastActive: string;
  sessions: HistoryFixtureSession[];
  cache?: Record<string, HistoryFixtureMessage[]>;
  historyRpc?: Record<string, "deferred">;
  [key: string]: unknown;
}) {
  const sessions = [...options.sessions];
  const cache = new Map<string, HistoryFixtureMessage[]>(Object.entries(options.cache ?? {}));
  const cacheReads = new Map<string, ReturnType<typeof deferred<HistoryFixtureMessage[] | undefined>>>();
  const historyRequests = new Map<string, Array<ReturnType<typeof deferred<unknown>>>>();
  const queuedHistoryResults = new Map<string, { ok: boolean; value: unknown }>();
  const requestCounts = new Map<string, number>();
  const listeners = new Set<() => void>();
  const inFlight = new Set<string>();
  let snapshot: HistoryFixtureSnapshot = { activeKey: null, messages: [] };
  let activeSignal = deferred<void>();
  let historyCommitSignal = deferred<void>();
  let historySettledSignal = deferred<void>();
  let historyRequestedSignal = deferred<void>();
  let archive: HistoryFixtureMessage[] = [];
  let canonicalLoaded = false;
  type FixtureSendState = {
    draft: string;
    attachments: Array<{ id: string; dataUrl?: string; name?: string }>;
    quote: { id?: string; text?: string } | null;
  };
  const initialSendState = options.sendState as Partial<FixtureSendState> | undefined;
  let sendState: FixtureSendState = {
    draft: initialSendState?.draft ?? "",
    attachments: structuredClone(initialSendState?.attachments ?? []),
    quote: structuredClone(initialSendState?.quote ?? null),
  };
  let sendConnected = options.connected !== false;
  let sendReadyAgentIds = new Set(Array.isArray(options.readyAgentIds) ? options.readyAgentIds as string[] : []);
  let sendImmersive = false;
  const sendQueues = new Map<string, Array<{ id: string; text: string; atts: unknown[] }>>();
  const rpcCalls: Array<{ key: string; id: string; text: string }> = [];
  const enqueued: Array<{ key: string; id: string; text: string }> = [];
  const sentIds: string[] = [];
  let queueFlushedSignal = deferred<void>();

  const notify = () => listeners.forEach((listener) => listener());
  const setSnapshot = (next: HistoryFixtureSnapshot) => {
    snapshot = next;
    notify();
  };
  const requestCanonical = (key: string): Promise<unknown> => {
    const request = deferred<unknown>();
    const list = historyRequests.get(key) ?? [];
    list.push(request);
    historyRequests.set(key, list);
    requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
    historyRequestedSignal.resolve();
    const queued = queuedHistoryResults.get(key);
    if (queued) {
      queuedHistoryResults.delete(key);
      list.pop();
      if (queued.ok) request.resolve(queued.value);
      else request.reject(queued.value);
    }
    return request.promise;
  };
  const fixtureBackendOf = (key: string): ChatBackendId =>
    backendOfSessionRows(sessions, key, agentOf(key));
  const controller = createHistoryController<HistoryFixtureMessage>({
    backendOfSession: fixtureBackendOf,
    agentOfSession: agentOf,
    getCacheScope: async () => "fixture-scope",
    getCached: async (_scope, key) => {
      if (cache.has(key)) return structuredClone(cache.get(key));
      const pendingRead = cacheReads.get(key);
      return pendingRead ? pendingRead.promise : undefined;
    },
    putCached: async (_scope, key, messages) => {
      cache.set(key, structuredClone(messages) as HistoryFixtureMessage[]);
    },
    deleteCached: async (_scope, key) => {
      cache.delete(key);
    },
    clearCachedExcept: async () => {},
    prepare: async (_key, messages) => structuredClone(messages) as HistoryFixtureMessage[],
    requestCanonical,
    isInFlight: (key) => inFlight.has(key),
    commitOpen: (key, messages) => {
      canonicalLoaded = false;
      setSnapshot({ activeKey: key, messages });
      requestAnimationFrame(() => activeSignal.resolve());
    },
    commitCanonical: (key, messages) => {
      canonicalLoaded = true;
      setSnapshot({ activeKey: key, messages });
      requestAnimationFrame(() => {
        historyCommitSignal.resolve();
        historySettledSignal.resolve();
      });
    },
    commitFailure: (_key, _error, cacheVisible) => {
      if (!cacheVisible && snapshot.messages.length === 0) setSnapshot({ ...snapshot, messages: [] });
      historySettledSignal.resolve();
    },
  });

  const fixtureCanSend = (key: string | null | undefined) => canSendSessionByReadiness(key, {
    backendOfSession: fixtureBackendOf,
    agentOfSession: agentOf,
    readyAgentIds: sendReadyAgentIds,
    connected: sendConnected,
    connectedBackends: new Set(["openclaw", ...sessions.map((session) => fixtureBackendOf(session.key))]),
  });
  const fixtureSendController = createSendController(fixtureCanSend);
  const fixtureTransportReady = (key: string) => sendConnected && fixtureCanSend(key);
  const flushFixtureQueue = (key: string) => {
    fixtureSendController.flushQueue(key, () => {
      if (!fixtureTransportReady(key)) return;
      const queue = sendQueues.get(key);
      if (!queue?.length) return;
      const item = queue.shift()!;
      rpcCalls.push({ key, id: item.id, text: item.text });
      sentIds.push(item.id);
      queueFlushedSignal.resolve();
      notify();
    });
  };
  const invokeFixtureSend = (entry: ChatSendEntry) => {
    const key = snapshot.activeKey;
    const action = () => {
      if (!key || (!sendState.draft.trim() && !sendState.attachments.length)) return;
      const text = sendState.draft.trim();
      const item = { id: crypto.randomUUID(), text, atts: structuredClone(sendState.attachments) };
      const queue = sendQueues.get(key) ?? [];
      queue.push(item);
      sendQueues.set(key, queue);
      enqueued.push({ key, id: item.id, text });
      sendState = { draft: "", attachments: [], quote: null };
      flushFixtureQueue(key);
      notify();
    };
    fixtureSendController[entry](key, action);
  };

  const fixture = {
    deps: {
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getSnapshot: () => snapshot,
      controller,
      lastActive: options.lastActive,
      ...(initialSendState ? {
        sendHarness: {
          snapshot: () => ({
            ...structuredClone(sendState),
            immersive: sendImmersive,
            canSend: fixtureCanSend(snapshot.activeKey),
          }),
          setDraft(value: string) {
            sendState = { ...sendState, draft: value };
            setSnapshot({ ...snapshot });
          },
          invoke: invokeFixtureSend,
        },
      } : {}),
    } satisfies ChatPageTestDeps,
    get committedActive() { return activeSignal.promise; },
    get historyCommitted() { return historyCommitSignal.promise; },
    get historySettled() { return historySettledSignal.promise; },
    get historyRequested() { return historyRequestedSignal.promise; },
    resolveHistory(key: string, messages: HistoryFixtureMessage[]) {
      historyCommitSignal = deferred<void>();
      historySettledSignal = deferred<void>();
      const request = historyRequests.get(key)?.shift();
      if (request) request.resolve(messages);
      else queuedHistoryResults.set(key, { ok: true, value: messages });
    },
    rejectHistory(key: string, error: Error) {
      historySettledSignal = deferred<void>();
      const request = historyRequests.get(key)?.shift();
      if (request) request.reject(error);
      else queuedHistoryResults.set(key, { ok: false, value: error });
    },
    requestHistory(key: string) {
      void controller.load(key);
    },
    readCache: async (key: string) => structuredClone(cache.get(key) ?? []),
    seedCache(key: string, messages: HistoryFixtureMessage[]) {
      cache.set(key, structuredClone(messages));
      if (snapshot.activeKey === key) setSnapshot({ activeKey: key, messages: structuredClone(messages) });
    },
    addSession(session: HistoryFixtureSession) {
      sessions.push(session);
    },
    selectSession(key: string) {
      activeSignal = deferred<void>();
      if (agentOf(key).startsWith("hermes-") && !cache.has(key)) cacheReads.set(key, deferred());
      void controller.open(key);
    },
    resolveCachedSelection(key: string, messages: HistoryFixtureMessage[]) {
      cache.set(key, structuredClone(messages));
      cacheReads.get(key)?.resolve(structuredClone(messages));
      cacheReads.delete(key);
    },
    async resolveCanonicalOutOfOrder(key: string, newest: HistoryFixtureMessage[], oldest: HistoryFixtureMessage[]) {
      void controller.load(key);
      void controller.load(key);
      for (let attempt = 0; attempt < 20 && (historyRequests.get(key)?.length ?? 0) < 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const list = historyRequests.get(key) ?? [];
      const pending = list.splice(0);
      const newerRequest = pending.pop();
      if (!newerRequest || !pending.length) throw new Error(`missing out-of-order requests for ${key}`);
      newerRequest.resolve(newest);
      pending.forEach((request) => request.resolve(oldest));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    },
    beginOptimisticSend(key: string, message: HistoryFixtureMessage) {
      void controller.load(key);
      inFlight.add(key);
      const messages = [...snapshot.messages, message];
      controller.markSend(key, messages);
      setSnapshot({ activeKey: key, messages });
    },
    resolvePreSendHistory(messages: HistoryFixtureMessage[]) {
      const key = snapshot.activeKey ?? "";
      const request = historyRequests.get(key)?.shift();
      if (request) request.resolve(messages);
      else queuedHistoryResults.set(key, { ok: true, value: messages });
    },
    markNeedsRevalidate(key: string) {
      requestCounts.set(key, 0);
      historyRequestedSignal = deferred<void>();
      controller.markNeedsRevalidate(key);
    },
    setReadyAgentIds(ids: string[]) {
      sendReadyAgentIds = new Set(ids);
      setSnapshot({ ...snapshot });
      if (snapshot.activeKey) flushFixtureQueue(snapshot.activeKey);
      void controller.revalidateReady(ids);
    },
    historyRequestsFor: (key: string) => requestCounts.get(key) ?? 0,
    seedArchive(messages: HistoryFixtureMessage[]) {
      archive = structuredClone(messages);
    },
    releaseArchive() {
      if (canonicalLoaded) setSnapshot({ ...snapshot, messages: [...archive, ...snapshot.messages] });
    },
    rpcCalls,
    enqueued,
    sentIds,
    get queue() { return structuredClone(sendQueues.get(snapshot.activeKey ?? "") ?? []); },
    readSendState: () => structuredClone(sendState),
    openImmersive() {
      sendImmersive = true;
      setSnapshot({ ...snapshot });
    },
    triggerWidget() {
      fixtureSendController.widget(snapshot.activeKey, () => invokeFixtureSend("composerButton"));
    },
    triggerSlash() {
      fixtureSendController.slash(snapshot.activeKey, () => invokeFixtureSend("composerButton"));
    },
    triggerRetry() {
      fixtureSendController.retry(snapshot.activeKey, () => invokeFixtureSend("composerButton"));
    },
    triggerFlushQueue() {
      flushFixtureQueue(snapshot.activeKey ?? "");
    },
    setConnected(value: boolean) {
      sendConnected = value;
      setSnapshot({ ...snapshot });
      if (value && snapshot.activeKey) flushFixtureQueue(snapshot.activeKey);
    },
    queueMessage(message: { id: string; text: string; atts?: unknown[] }) {
      const key = snapshot.activeKey ?? "";
      const queue = sendQueues.get(key) ?? [];
      queue.push({ id: message.id, text: message.text, atts: structuredClone(message.atts ?? []) });
      sendQueues.set(key, queue);
      queueFlushedSignal = deferred<void>();
      setSnapshot({ ...snapshot });
    },
    get queueFlushed() { return queueFlushedSignal.promise; },
  };
  return fixture;
}

export default function ChatPage({ testDeps }: { testDeps?: ChatPageTestDeps } = {}) {
  return testDeps ? <ChatPageHistoryFixture deps={testDeps} /> : <ChatPageApp />;
}
