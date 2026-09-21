import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type WheelEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChatRunWait, chatRunWaitState, type ChatRunWaitState } from "../components/ChatRunWait";
import { setInspirationChatSession } from "../lib/inspiration-navigation";
import { toSanitizedMarkdownHtml, formatReasoningMarkdown } from "../lib/markdown";
import ChatMarkdown from "../components/ChatMarkdown";
import { installHtmlArtifacts, setSendPromptHandler } from "../lib/htmlArtifacts";
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
import ChatSessionRenameModal, { type SessionRenameTarget } from "./ChatSessionRenameModal";
import ChatPromptCard, {
  chatPromptAttentionOf,
  interruptedApprovalEntry,
  type ChatPromptAttention,
  type ChatPromptEntry,
  type ChatPromptResponse,
} from "./ChatPromptCard";
import ChatWidget from "../components/ChatWidget";
import { Select, Option } from "../components/Field";
import Modal from "../components/Modal";
import { useConfirm } from "../components/ui";
import SessionAdvancedModal from "./chat-session-advanced/SessionAdvancedModal";
import {
  forkEditorDraft,
  forkEntryIdAt,
  hasAdvancedSessionDetails,
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
import TurnProcess from "../components/TurnTimeline/TurnProcess";
import TurnTimeline from "../components/TurnTimeline/TurnTimeline";
import { IconTrajectory } from "../components/TurnTimeline/trajectoryIcons";
import { createTimeline, reduceTimeline, stepsFromParts, summarizeArgs, toolLabelKey, type TimelinePartLike, type TurnEvent, type TurnStep, type TurnTimelineState } from "../lib/turnTimeline";
import { isBackgroundSession } from "../lib/sessionKind";
import { consumeCronChatHandoff } from "../lib/cronChatHandoff";
import { applyChatSessionAgentNames, mergeLinkedSessionRows, openChatSessionLink } from "../lib/chatSessionNavigation";
import { mergeIncompleteSessionRows } from "../lib/sessionListCompleteness";
import { sessionDisplayPreview, sessionDisplayTitle } from "../lib/sessionDisplay";
import { isInterSessionUserMessage } from "../lib/chatMessageVisibility";
import { createAgentNameIndex, type AgentNameIndex } from "../lib/agentDisplay";
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
import { localizePermissionMode } from "../lib/permissionModeText";
import type { ImmersivePhase } from "./immersive/immersiveBg";
import type { ImmersiveLiveStatus, ImmersiveLiveTool } from "./immersive/ImmersiveStatusLine";
import { IconSend, IconClip, IconAttachmentFolder, IconSearch, IconClock, IconArchive, IconMic, IconFast, IconStop, IconPencil } from "./chatIcons";
import "./ChatPage.css";
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
  openPath,
  openAttachment,
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
// 冷启动与已连接后的意外中断统一呈现为 reconnecting；Hermes 的精确就绪状态只用于
// composer 门禁，不再占用 Agent 行的缓存预览。offline 只留给用户主动断开。
type LiveStatus = "running" | "online" | "offline" | "reconnecting";
type AgentListStatus = LiveStatus | ChatPromptAttention;

interface SessionRow {
  inspirationId?: string;
  kind?: string;
  source?: string;
  key: string;
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
  status?: string;
  hasActiveRun?: boolean;
  permissionMode?: string;
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

type PartType = "text" | "thinking" | "toolCall" | "toolResult" | "plan" | "prompt" | "timeline" | "canvas";
interface PlanEntry {
  content: string;
  status: string;
  // OpenClaw progress cards reuse the existing plan surface. The first entry
  // carries the durable card metadata so revision/markdown survive subsequent
  // tool/thinking re-renders without creating a second plan state machine.
  progressRevision?: number;
  progressUpdatedAt?: number;
  progressMarkdown?: string;
}

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
  preview?: ChatCanvasWidgetPreview;
  rawText?: string;
  text?: string;
  planEntries?: PlanEntry[]; // plan part: the agent's todo list (ACP plan event)
  diff?: { path: string; oldText: string; newText: string }; // file-edit diff (write/patch)
  diffText?: string; // unified diff text (Hermes gateway inline_diff)
  durationS?: number; // tool runtime seconds (Hermes gateway tool.complete)
  promptEntry?: ChatPromptEntry; // prompt part: blocking agent request card
  toolName?: string;
  toolArgs?: unknown; // toolCall arguments → rendered into the card title (url/query/…)
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
  id?: string; // canonical gateway identity — kept separate from local UI actions
  actionId?: string; // per-session hide/pin identity, including messages without a gateway id
  ts?: number;
  model?: string;
  provider?: string;
  usage?: Usage;
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
  pending?: boolean;
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
// chat.history caps at the last ~1000 messages (server hardMax) and has no offset;
// sessions.get has neither cap. When the sanitized chat.history result looks
// near-capped, we backfill the older overflow from sessions.get (OpenClaw only).
const FULL_HISTORY_TRIGGER = 900; // sanitized count near chat.history's 1000 window
const FULL_HISTORY_LIMIT = 5000; // bound the sessions.get payload (far above any real session)
// 刚发生 reset 的会话通常只剩极短的新尾巴；此时自动补回归档，其余会话仍按上滑按需加载。
const AUTO_ARCHIVE_MESSAGE_LIMIT = 5;
// 双发去重窗口：同一会话内相同正文在此窗口内再次发送 → 判为一次逻辑发送被双触发
// （重连清 inFlight / 一次 Enter 走了两条 submit 路径），复用同一 idempotencyKey 让网关折叠。
// 取 15s 覆盖已观测到的 ~13s 重连间隔；代价仅是 15s 内故意重发的同一句会被并成一条。
const DUP_SEND_WINDOW_MS = 15_000;
// Preflight uses a fixed-width UUID sample; the real idempotency key generated
// immediately before chat.send has the same ASCII byte length.
const CHAT_SEND_IDEMPOTENCY_SAMPLE = "00000000-0000-4000-8000-000000000000";
// 回合终结 → 补发待发队列队首的延迟：躲开 final 分支 loadHistory(refresh) 的重拉窗口，
// 减少刚补发的 user 气泡被旧历史覆盖的闪烁（session.message 的 300ms 合并重拉会兜底恢复）。
const QUEUE_FLUSH_DELAY_MS = 400;
// 待发队列条目（R357）：生成中回车的消息排队，回合终结后按 FIFO 链式补发。
type QueuedMsg = { id: string; text: string; atts: ChatAttachment[] };
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

function attachmentChipIcon(kind: string): ReactNode {
  if (kind === "image") return "🖼️";
  if (kind === "audio") return "🔊";
  if (kind === "video") return "🎬";
  return <IconAttachmentFolder />;
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
    || isInterSessionUserMessage(m, msgText(m))
    || isInjectedPrompt(m)
    || isInterruptMarker(m);
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
// cron / subagent / dreaming / 心跳 = 后台会话。R266 起它们**不再从切换器里消失**
// （工作板「运行」跳过来的 subagent 会话曾因此在 UI 里无处可寻）——判定挪到
// lib/sessionKind.ts，切换器全量显示 + 按类型分 Tab，这里只保留它剩下的两个用途：
// 挑 agent 行的代表会话（心跳 phantom 当代表 = 行反复浮顶、点开永远空白，R153
// Vincent 事故）和未读红点（后台 final 也会广播过来，R245）。

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
function absTime(ts?: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleString([], {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
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

// Per-agent "last read" time for the left-list unread dot (R81): set when the user opens a
// session of this agent. An agent shows an unread dot when its latest activity (rank, or a
// live non-heartbeat reply) is newer than this. Persisted, so unread survives reloads and
// backfills messages that arrived while the app was closed.
const READ_AT_KEY = "shoggoth.chat.readAt.v1";
function readReadAt(): Record<string, number> {
  try {
    const raw = localStorage.getItem(READ_AT_KEY);
    const obj = raw ? JSON.parse(raw) : null;
    return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Record<string, number>) : {};
  } catch {
    return {};
  }
}
function writeReadAt(map: Record<string, number>): void {
  try {
    localStorage.setItem(READ_AT_KEY, JSON.stringify(map));
  } catch {
    /* ignore quota / availability errors */
  }
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
        return cc?.text ?? cc?.thinking ?? "";
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
  let role = raw?.role === "assistant" || raw?.role === "toolResult" || raw?.role === "system"
    ? raw.role
    : "user";
  // claude-cli 通道：并行工具调用的结果是 role:"user" 且 content 全为 tool_result 块的
  // 消息。不归一的话它会渲染成右侧空白用户气泡，还会被图片回填按「空文本」缓存键
  // 错配上历史旧图（幽灵图片）。只在全块都是 tool_result 时才转，混排保持 user。
  const rawContent = raw?.content;
  if (role === "user" && Array.isArray(rawContent) && rawContent.length && rawContent.every(isToolResultBlock)) {
    role = "toolResult";
  }
  const base: ChatMsg = {
    role,
    parts: [],
    id: raw?.__openclaw?.id ?? (typeof raw?.id === "string" ? raw.id : undefined),
    ts: typeof raw?.timestamp === "number" ? raw.timestamp : undefined,
    model: raw?.model,
    provider: raw?.provider,
    usage: raw?.usage,
    stopReason: raw?.stopReason,
    errorMessage: raw?.errorMessage,
    toolName: raw?.toolName,
    isError: raw?.isError === true,
    provenance: raw?.provenance && typeof raw.provenance === "object" ? raw.provenance : undefined,
    notice: raw?.notice === "modelSwitch" || raw?.notice === "runInterrupted" ? raw.notice : undefined,
  };
  const media = normalizeOpenClawMediaFacts(raw?.__openclaw?.media);
  if (media.length) base.files = media;
  const nativeMedia = nativeChatMedia(raw?.shoggoth?.attachments);
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
          toolArgs: toolResultBlockArgs(b),
          isError: b?.is_error === true || raw?.isError === true,
          durationS: toolResultBlockDuration(b),
        }))
      : [{ type: "toolResult", text: contentToText(raw?.content), toolName: raw?.toolName, isError: raw?.isError === true }];
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
      const cc = c as { type?: string; text?: string; thinking?: string; toolName?: string; name?: string; arguments?: unknown; args?: unknown; input?: unknown; is_error?: boolean; durationS?: unknown; planEntries?: unknown };
      if (cc?.type === "thinking") base.parts.push({ type: "thinking", text: cc.thinking ?? "" });
      else if (cc?.type === "plan") {
        const planEntries = planEntriesFromBlock(cc);
        if (planEntries.length) base.parts.push({ type: "plan", planEntries });
      }
      else if (cc?.type === "canvas") {
        const widget = normalizeChatCanvasWidgetPart(cc);
        base.parts.push(widget ?? { type: "canvas" });
      }
      // 工具调用块名三方言：pi-ai "toolCall"、claude-cli "toolcall"、Anthropic 标准 "tool_use"。
      else if (cc?.type === "toolCall" || cc?.type === "toolcall" || cc?.type === "tool_use") base.parts.push({ type: "toolCall", toolName: cc.toolName ?? cc.name ?? "tool", toolArgs: cc.arguments ?? cc.args ?? cc.input });
      // claude-cli 通道把串行工具的结果直接嵌进 assistant 消息（pi-ai 是独立 toolResult 消息）。
      else if (isToolResultBlock(cc)) base.parts.push({
        type: "toolResult",
        text: toolResultBlockText(cc),
        toolName: typeof cc.name === "string" ? cc.name : undefined,
        toolArgs: toolResultBlockArgs(cc),
        isError: cc.is_error === true,
        durationS: toolResultBlockDuration(cc),
      });
      else if (typeof cc?.text === "string") base.parts.push({ type: "text", text: cc.text });
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
      p.type === "plan" ||
      p.type === "canvas" ||
      (!!p.text?.trim() && p.text.trim() !== STREAM_ERROR_FALLBACK_TEXT),
  );
  if (!hasRenderable && raw?.errorMessage) {
    base.parts = [{ type: "text", text: raw.errorMessage }];
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
  output?: string; // set once a partial/final result arrives → card flips to a result card
  isError?: boolean; // the tool failed
  diff?: { path: string; oldText: string; newText: string }; // write/patch file-edit diff
  diffText?: string; // unified diff text (Hermes gateway inline_diff)
  durationS?: number; // runtime seconds (Hermes gateway tool.complete)
}
// Tool-call card title from name + args, matching OpenClaw's Control UI:
// web_search → `for "<query>" (top <count>)`, web_fetch → `from <url> (max N chars)`,
// otherwise the primary human-readable command/path/target. Empty string → caller shows a plain label.
function formatToolTitle(name?: string, args?: unknown): string {
  return summarizeArgs(name, args);
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
    e.output != null
      ? { type: "toolResult", toolName: e.name, text: e.output, isError: e.isError }
      : { type: "toolCall", toolName: e.name, toolArgs: e.args };
  if (e.diff) base.diff = e.diff;
  if (e.diffText) base.diffText = e.diffText;
  if (e.durationS != null) base.durationS = e.durationS;
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
  return [...out, { role: "assistant", parts: composePendingParts(tools, text, thinking, plan, prompts, canvas), pending: true }];
}
// A streamed tool lifecycle event mutated `tools`; re-render the pending assistant
// (creating one if the turn started outside our own send), keeping its streamed text.
function applyToolStream(prev: ChatMsg[], tools: ToolEntry[], thinking = "", plan: PlanEntry[] = [], prompts: ChatPromptEntry[] = []): ChatMsg[] {
  const out = prev.slice();
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i].role === "assistant" && out[i].pending) {
      const canvas = out[i].parts.filter((part) => part.type === "canvas");
      out[i] = { ...out[i], parts: composePendingParts(tools, lastText(out[i].parts), thinking, plan, prompts, canvas) };
      return out;
    }
  }
  return [...out, { role: "assistant", parts: composePendingParts(tools, "", thinking, plan, prompts), pending: true }];
}
function finalizeAssistant(prev: ChatMsg[], finalMsg: any, streamedTextOverride?: string): ChatMsg[] {
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
    if (out[i].role === "assistant" && out[i].pending) {
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
          ts: norm.ts ?? streamed.ts ?? Date.now(),
        };
        return out;
      }
      out[i] = {
        ...norm,
        // if the final frame carried nothing renderable, keep what streamed in
        parts: norm.parts.length ? norm.parts : out[i].parts,
        model: norm.model ?? out[i].model,
        provider: norm.provider ?? out[i].provider,
        usage: norm.usage ?? out[i].usage,
        // Local-clock fallback: if the final frame carried no numeric timestamp
        // (some backends omit it / send an ISO string that normalize's number gate
        // drops), stamp the real moment this turn landed so the footer always has a
        // time. This is the actual receipt time, not a fabricated value.
        ts: norm.ts ?? out[i].ts ?? Date.now(),
      };
      return out;
    }
  }
  return norm.parts.length ? [...out, norm] : out;
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
    return m.parts.some((p) => p.type === "canvas" || (p.type === "text" && !!p.text?.trim()));
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
// 分隔线/notice、本地 slash 结果、pending(直播轮 S2 另有实时管道)——另加相邻消息
// 时间差 > 90s 的启发式切分:heartbeat 等隐藏项会让不同回合的同 role 消息粘连
// (见 groupMessages 内注释),没有这刀,cron/delivery-mirror 会话的整段历史会被
// 折成一条巨型时间线。
const TURN_GAP_MS = 90_000;
function absorbTurnTimelines(msgs: ChatMsg[], lastLiveSteps?: TurnStep[]): ChatMsg[] {
  const isBoundary = (x: ChatMsg) => x.role === "user" || !!x.divider || !!x.notice || x.local === true || x.pending === true;
  const isProcessPart = (p: Part) => p.type === "thinking" || p.type === "toolCall" || p.type === "toolResult" || p.type === "plan";
  const out: ChatMsg[] = [];
  let i = 0;
  while (i < msgs.length) {
    if (isBoundary(msgs[i])) {
      out.push(msgs[i]);
      i += 1;
      continue;
    }
    // 一段连续的非边界消息 ≈ 一个回合的产出侧(时间间隙再切)
    const seg: ChatMsg[] = [msgs[i]];
    i += 1;
    while (i < msgs.length && !isBoundary(msgs[i])) {
      const prev = seg[seg.length - 1];
      if (prev.ts && msgs[i].ts && msgs[i].ts! - prev.ts! > TURN_GAP_MS) break;
      seg.push(msgs[i]);
      i += 1;
    }
    // 带上「这个 part 属于哪条消息」的时间戳,供下面推算耗时(R350)。
    const partSeq: (TimelinePartLike & { ts?: number })[] = [];
    for (const sm of seg) for (const p of sm.parts) if (isProcessPart(p)) partSeq.push({ ...(p as TimelinePartLike), ts: sm.ts });
    if (!partSeq.length || !seg.some((sm) => sm.role === "assistant")) {
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
        const call = openCalls.shift();
        if (p.durationS == null && typeof call?.ts === "number" && typeof p.ts === "number") {
          const d = (p.ts - call.ts) / 1000;
          if (d > 0 && d < 3600) p.durationS = d;
        }
      }
    }
    const steps = stepsFromParts(partSeq);
    let attached = false;
    for (const sm of seg) {
      if (sm.role === "toolResult") continue; // 内容已进 steps
      const rest = sm.parts.filter((p) => !isProcessPart(p));
      if (!attached && sm.role === "assistant") {
        out.push({ ...sm, parts: [{ type: "timeline", steps }, ...rest] });
        attached = true;
      } else if (rest.length || sm.images?.length || sm.files?.length) {
        out.push({ ...sm, parts: rest });
      }
      // else:纯过程消息被吸收后只剩空壳 → 丢弃(回合 footer 取组尾消息,不受影响)
    }
  }
  // 最近一轮 stitch:history 是降级数据(无相位/耗时),刚结束那轮的直播步骤还在
  // 内存里 → 工具数吻合时,把线程里最后一条 timeline 换成富数据版(user/final/text
  // 步滤掉,与吸收版口径一致)。数目不吻合(转录截断/口径漂移)就保持降级,不硬贴。
  if (lastLiveSteps?.length) {
    const rich = lastLiveSteps.filter((s) => s.kind !== "user" && s.kind !== "final" && s.kind !== "text");
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
function IconCheckSquare() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="4" />
      <path d="M8 12l3 3 5-6" />
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
function IconCopy() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 012-2h8" />
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
function IconPin() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6zM12 16v5" />
    </svg>
  );
}
function IconTrash() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13" />
    </svg>
  );
}
function IconFilter() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5h16l-6 8v6l-4-2v-4z" />
    </svg>
  );
}
function IconQuote() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 14L4 9l5-5M4 9h11a5 5 0 015 5v4" />
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
  const inFlightRef = useRef<Set<string>>(new Set());

  const [connected, setConnected] = useState(false);
  // 曾经成功连上过（onopen 落一次，之后不回退）——断线横幅据此在「连接中…」（冷启动）
  // 与「连接已断开，正在重连…」（掉线自愈）之间选词。
  const [everConnected, setEverConnected] = useState(false);
  // Cache seed gets the SAME persisted last-activity corrections the live fetch
  // applies, so the first paint's times/order aren't a wall of stale "13h" rows
  // that visibly snap once the WS list lands.
  const [sessions, setSessions] = useState<SessionRow[]>(() => {
    const act = readActivity();
    return readSessionCache()
      .map((s) => {
        const known = act[s.key] ?? 0;
        return known > (s.updatedAt ?? 0) ? { ...s, updatedAt: known } : s;
      })
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  });
  const sessionsRef = useRef<SessionRow[]>(sessions);
  sessionsRef.current = sessions;
  // sessions.list carries stable ids but OpenClaw does not guarantee a current
  // agentName. Seed from cache, then replace from agents.list on each list refresh.
  const agentNamesRef = useRef<AgentNameIndex>(createAgentNameIndex(
    sessions.flatMap((row) => row.agentName
      ? [{ id: agentOf(row.key), name: row.agentName }]
      : []),
  ));
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
  // 正在启动的后端（status 的 info.starting，契约见 agent-backend.js getStatus）。
  // 冷启动要拉起多个 dashboard 进程的后端（Hermes）在这个窗口里 connected=false
  // 却不是故障，若按离线过滤，缓存里它的 agent 会整组消失、就绪后再凭空冒出来
  // ——看起来像「加载不出来」。所以列表可见性 = connected ∪ starting，而在线灰点
  // 仍只认 connected：行留在原位、暗着，等它转绿。
  const [startingBackends, setStartingBackends] = useState<Set<string>>(new Set());
  // Hermes 可用性按 profile/agent 精确到会话；历史重试只在目标 agent ready 后触发。
  const [readyAgentIds, setReadyAgentIds] = useState<Set<string>>(new Set());
  // 用户保存的连接配置立即生效，不等待下一次 status 轮询。
  // 这是**明确意图**，与意外断线语义相反：它的 agent 行照旧整组消失，不留灰行。
  const disabledBackends = useMemo(() => new Set(chatBackendCatalog
    .filter(backend => !enabledChatBackends.includes(backend.id)).map(backend => backend.id)),
  [chatBackendCatalog, enabledChatBackends]);
  const canSendActiveSession = (key: string | null | undefined): boolean =>
    canSendSessionByReadiness(key, {
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
  const [sessionRenameTarget, setSessionRenameTarget] = useState<SessionRenameTarget | null>(null);
  // Click-to-zoom overlay for chat media (agent MEDIA: images + user-sent images
  // and videos). Holds what to show full-size, null = closed. Videos play with
  // native controls; images render as before.
  const [lightbox, setLightbox] = useState<{ src: string; kind: "image" | "video" } | null>(null);
  // R339:回合过程抽屉(大视图)——摘要行的 ⤢ 打开,承载同一份 TurnStep[]
  const [timelineModal, setTimelineModal] = useState<{ steps: TurnStep[]; ts?: number } | null>(null);
  // R340 工具显示名:中文模式把标识符映射成人话(turnLab.tools),en 映射值=原标识符,
  // 未收录(MCP 长名等)回退原名。
  const toolDisp = useCallback(
    (name?: string): string => {
      const raw = (name || "").trim();
      if (!raw) return t("chat.tool");
      return t(toolLabelKey(raw), { defaultValue: "" }) || raw;
    },
    [t],
  );
  // R343:进行中气泡的直播时间线步骤(过滤掉 user/final/text——正文另有气泡,
  // 思考步随 💡 开关)。独立成函数是为了在消息层渲染一次、用固定 key:live parts
  // 每个流事件都重建,若把 TurnProcess 键在 part 内容哈希上会整组件反复重挂,
  // 行进场动画从 opacity 0 反复重播 → 时间线大面积空白/频闪(Hermes 思考流实测)。
  const liveStepsFor = (m: ChatMsg): TurnStep[] => {
    if (!m.pending) return [];
    const tl = liveTimelinesRef.current.get(activeKeyRef.current || "");
    if (!tl?.steps.length) return [];
    return tl.steps.filter((s) => s.kind !== "user" && s.kind !== "final" && s.kind !== "text" && (showThinking || s.kind !== "thinking"));
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
  // 已加载的归档段（含 reset 分隔线）。归档只存在于 messages 里，而 loadHistory 成功时
  // 会用 chat.history 的结果整体替换 messages —— 活跃会话任何一次刷新（final / session.message）
  // 都会把归档静默抹掉，且 archive.status 还停在 "loaded"，既不再显示「加载更早历史」入口，
  // maybeLoadArchive 也拒绝重载。把归档前缀单独记下来，每次刷新后重新贴回去。
  const archivePrefixRef = useRef<{ key: string; msgs: ChatMsg[] }>({ key: "", msgs: [] });
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  // 待发队列（per-session，R357）：ref 为唯一真相（事件回调同步读写），queueTick 只负责
  // 触发渲染——liveToolsRef 同款模式。刷新即丢，与输入框草稿同命（有意不持久化：
  // localStorage 会带来「重开 app 旧队列复活自动发送」的风险）。
  const sendQueueRef = useRef<Map<string, QueuedMsg[]>>(new Map());
  const [queueTick, setQueueTick] = useState(0);
  // markInFlight 是 useCallback([])，经 ref 转接拿到最新 flushQueue（sendChatMessageRef 同款）。
  const flushQueueRef = useRef<((key: string) => void) | null>(null);
  // Reactive mirror of inFlightRef so the live-status dots (header + agent list)
  // re-render the moment a turn starts/ends. inFlightRef stays the synchronous
  // source of truth; markInFlight keeps both in lock-step.
  const [runningKeys, setRunningKeys] = useState<Set<string>>(new Set());
  const [runWaitBySession, setRunWaitBySession] = useState<Record<string, ChatRunWaitState>>({});
  const runStatusBySessionRef = useRef<Map<string, string>>(new Map());
  // Last send per session (text + idempotencyKey + timestamp), for double-fire
  // dedup. A reconnect clears inFlightRef mid-turn (see ws onopen), so the composer
  // unlocks while the gateway turn is still alive; a re-fire then sends the SAME
  // composed message again with a fresh idempotencyKey and the gateway appends two
  // identical user turns. Reusing the key inside DUP_SEND_WINDOW_MS lets the gateway
  // collapse the duplicate (findTranscriptMessageByIdempotencyKey) into one.
  const recentSendRef = useRef<Map<string, { text: string; idem: string; at: number }>>(new Map());
  const markInFlight = useCallback((key: string, on: boolean) => {
    if (!on) setRunWaitBySession((previous) => {
      if (!previous[key]) return previous;
      const next = { ...previous }; delete next[key]; return next;
    });
    if (on) inFlightRef.current.add(key);
    else {
      inFlightRef.current.delete(key);
      runStatusBySessionRef.current.delete(key);
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
  // Agents whose `:main` true last-activity we've already probed this mount (so the
  // most-recent landing isn't fooled by main's stale sessions.list updatedAt). See
  // the probe effect below.
  const mainActivityProbedRef = useRef<Set<string>>(new Set());
  // Per-session last REAL (non-heartbeat) message time for the agent-row time + sort, so an
  // idle-but-heartbeating agent shows its true last-chat time instead of being pinned to the top.
  // Seeded once per non-active rep by a deeper scan (heartbeat acks run deep); the active agent
  // uses `activeRealTime` from the live thread instead. See the probe effect below.
  const [realTimes, setRealTimes] = useState<Record<string, number>>(() => readActivity());
  // 「窗口内没扫到真实消息」时的上界（该会话的真实活动早于此时间）：心跳刷屏的会话 150/1000 条
  // 窗口可能全是机械段，没有上界就只能落到被心跳抬高的 updatedAt（→ 弹顶）。仅内存；取扫过的
  // 最早记录时间（min-write 保留最紧的界）；精确值（realTimes）优先于它。
  const [realTimeBounds, setRealTimeBounds] = useState<Record<string, number>>({});
  const realTimeFetchedRef = useRef<Set<string>>(new Set());
  // Left-list unread dots (R81). readAt[agentId] = when the user last opened this agent
  // (persisted); liveMsgAt[agentId] = a real (non-heartbeat) reply seen arriving this session
  // (in-memory — a reload recovers unread via the rank-vs-readAt backfill). An agent is unread
  // when max(rank, liveMsgAt) > readAt and it isn't the active agent.
  const [readAt, setReadAt] = useState<Record<string, number>>(() => readReadAt());
  const [liveMsgAt, setLiveMsgAt] = useState<Record<string, number>>({});
  const markAgentRead = useCallback((agentId: string) => {
    if (!agentId) return;
    setReadAt((prev) => {
      const next = { ...prev, [agentId]: Date.now() };
      writeReadAt(next);
      return next;
    });
  }, []);
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
  const refreshModelMenu = useCallback(() => {
    void refreshActiveModelsRef.current?.().catch(() => {});
  }, []);
  // Learned xhigh support keyed by `provider:model` (see the probe effect below).
  const [xhighOk, setXhighOk] = useState<Record<string, boolean>>({});
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
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
  // Per-session ACP plan (todo list) — rendered as a pinned checklist on the pending bubble.
  const pendingPlanRef = useRef<Map<string, PlanEntry[]>>(new Map());
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
    if (!tl || ((tl.status === "done" || tl.status === "error") && !terminal)) tl = createTimeline();
    tl = reduceTimeline(tl, ev, performance.now());
    map.set(sk, tl);
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
      if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error(t("chat.notConnected")));
      const id = String(reqId.current++);
      const timer = setTimeout(() => {
        const entry = takePendingRpc(pending.current, id, ws);
        if (entry) entry.reject(new Error(t("chat.requestTimeout", { method })));
      }, 20000);
      pending.current.set(id, { socket: ws, timer, resolve, reject });
      try {
        ws.send(JSON.stringify({ type: "req", id, method, params }));
      } catch (error) {
        const entry = takePendingRpc(pending.current, id, ws);
        if (entry) entry.reject(error);
      }
    });
  }, []);

  // Bump a session's updatedAt so the agent list re-sorts it to the top on any new
  // activity (sent message, streamed reply, push session.message, or a corrected
  // last-message time learned in loadHistory). Stamp is passed in so render never
  // calls Date.now(). Defined above loadHistory because loadHistory calls it.
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

  // Backfill the messages older than chat.history's window from sessions.get (no
  // cap / no byte budget; the gateway resolves the transcript path on its side, so
  // this works for any install location and for remote gateways too). Prepend only
  // the pre-window region; the recent window keeps chat.history's clean version.
  const backfillFullHistory = useCallback(
    async (key: string, clean: ChatMsg[]) => {
      try {
        const res = await send("sessions.get", { key, limit: FULL_HISTORY_LIMIT });
        const full: ChatMsg[] = (res?.payload?.messages || []).map(normalize).filter((m: ChatMsg) => !isInterruptMarker(m));
        if (full.length <= clean.length) return; // nothing beyond the clean window
        // 完整 transcript 在手——补准「最后真实活动」记账：心跳重灾会话（每 30min 巡检的 main）
        // 最后 1000 条可能全是机械段，loadHistory 的窗口扫不到真实消息（realTs=0 不写 realTimes），
        // 排名跌回被心跳抬高的 updatedAt → 取消选中行就弹顶。全量里扫到的才是真值，写穿三处记账。
        let realTs = 0;
        for (let i = full.length - 1; i >= 0; i--) {
          const m = full[i];
          if (isRealActivity(m)) { realTs = m.ts ?? 0; break; }
        }
        if (realTs > 0) {
          recordActivity(key, realTs);
          bumpSession(key, realTs);
          setRealTimes((p) => ({ ...p, [key]: Math.max(p[key] ?? 0, realTs) }));
        }
        const known = new Set(clean.map((m) => m.id).filter(Boolean) as string[]);
        let tMin = Infinity;
        for (const m of clean) if (typeof m.ts === "number" && m.ts < tMin) tMin = m.ts;
        const older = full.filter(
          (m) => !isHeartbeatNoise(m) && (m.ts ?? 0) < tMin && !(m.id && known.has(m.id)),
        );
        if (older.length && activeKeyRef.current === key) {
          setMessages((prev) => {
            if (activeKeyRef.current !== key) return prev;
            // 只 prepend「更早的一段」，绝不用 clean 快照整体替换 prev。sessions.get 往返
            // 可能要几秒，其间用户发的消息 + 那条 pending 助手气泡都在 prev 里；一旦被替换掉，
            // 后续 delta 在 applyDelta 里找不到 pending 气泡会被静默丢弃，整轮流式不可见。
            const have = new Set(prev.map((m) => m.id).filter(Boolean) as string[]);
            const add = older.filter((m) => !(m.id && have.has(m.id)));
            if (!add.length) return prev;
            // 归档段（reset 之前的旧 transcript）永远排在最前，回填的这一段属于当前
            // transcript 的更早区域，要插在归档之后。
            const at = archivePrefixRef.current.key === key ? archivePrefixRef.current.msgs.length : 0;
            return [...prev.slice(0, at), ...add, ...prev.slice(at)];
          });
        }
      } catch {
        // keep the chat.history result on any sessions.get error/timeout — no regression
      }
    },
    [send, bumpSession],
  );

  // 缓存和 chat.history 共用同一条 raw → 可见消息路径，避免 Hermes 冷启动首屏与
  // 随后权威替换在附件 marker、心跳过滤或本地媒体恢复上出现两套口径。
  const prepareHistoryMessages = useCallback(async (key: string, raw: unknown[]): Promise<ChatMsg[]> => {
    const msgs = raw.map(normalize).filter((m: ChatMsg) => !isInterruptMarker(m));
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
    const tools = liveToolsRef.current.get(key) || [];
    const thinking = pendingThinkingRef.current.get(key) || "";
    const plan = pendingPlanRef.current.get(key) || [];
    const prompts = pendingPromptsRef.current.get(key) || [];
    const withoutProgressProjection = history.filter((message) => message.ephemeral !== "progressCard");
    if (!tools.length && !thinking.trim() && !plan.length && !prompts.length && !inFlightRef.current.has(key)) {
      return withoutProgressProjection.filter((message) => !message.pending);
    }
    const durableProgressOnly = !tools.length
      && !thinking.trim()
      && !prompts.length
      && !inFlightRef.current.has(key)
      && plan.some((entry) => entry.progressRevision !== undefined);
    if (durableProgressOnly) {
      return [
        ...withoutProgressProjection.filter((message) => !message.pending),
        { role: "assistant", parts: [{ type: "plan", planEntries: plan }], ephemeral: "progressCard" },
      ];
    }
    return applyToolStream(withoutProgressProjection, tools, thinking, plan, prompts);
  }, []);

  const commitCanonicalHistory = useCallback((key: string, msgs: ChatMsg[]) => {
    if (searchHistoryWindowKeyRef.current === key) {
      searchHistoryWindowKeyRef.current = null;
      setArchive({ key, status: "idle" });
    }
    const arc = archivePrefixRef.current.key === key ? archivePrefixRef.current.msgs : [];
    const canonicalMessages = arc.length ? [...arc, ...msgs] : msgs;
    const visibleMessages = decorateHistoryWithLiveState(key, canonicalMessages);
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
      recordActivity(key, realTs);
      bumpSession(key, realTs);
      setRealTimes((p) => ({ ...p, [key]: Math.max(p[key] ?? 0, realTs) }));
    } else if (msgs.length) {
      const oldest = msgs.find((m) => typeof m.ts === "number")?.ts ?? 0;
      if (oldest > 0) setRealTimeBounds((p) => ({ ...p, [key]: Math.min(p[key] ?? Infinity, oldest) }));
    }
    if (backendOfSession(key) === "openclaw" && msgs.length >= FULL_HISTORY_TRIGGER) {
      void backfillFullHistory(key, msgs);
    }
  }, [backfillFullHistory, bumpSession, decorateHistoryWithLiveState]);

  const commitOpenedHistory = useCallback((key: string, msgs: ChatMsg[], cacheVisible: boolean) => {
    const prevKey = activeKeyRef.current;
    if (prevKey && prevKey !== key) draftsRef.current.set(prevKey, inputRef.current);
    const restored = draftsRef.current.get(key) ?? "";
    setInput(restored);
    inputRef.current = restored;
    setSlashOpen(false);
    setSlashMode("command");
    histPosRef.current = -1;
    setHiddenIds(readIdSet(HIDDEN_PREFIX, key));
    setPinnedIds(readIdSet(PINNED_PREFIX, key));
    setPinnedOnly(false);
    setPinNavIndex(0);
    setQuote(null);
    if (!supportsBackendAttachments(backendOfSession(key), chatCapsRef.current[agentOf(key)])) {
      setComposerAttachments([]);
    }
    setMenu(null);
    atBottomRef.current = true;
    activeKeyRef.current = key;
    setActiveKey(key);
    const visibleMessages = decorateHistoryWithLiveState(key, msgs);
    messagesRef.current = visibleMessages;
    setMessages(visibleMessages);
    historyLoadedRef.current = false;
    historyVisibleRef.current = cacheVisible;
    setHistoryLoaded(false);
    setHistoryVisible(cacheVisible);
    setHistoryError(null);
    setArchive({ key, status: "idle" });
    archivePrefixRef.current = { key: "", msgs: [] };
    archiveLoadingRef.current = false;
    writeLastActive(key);
    rememberChosen(key);
    markAgentRead(agentOf(key));
    setSending(inFlightRef.current.has(key));
  }, [decorateHistoryWithLiveState, markAgentRead, rememberChosen]);

  const chatHistoryController = useMemo(() => createHistoryController<ChatMsg>({
    backendOfSession,
    agentOfSession: agentOf,
    getCacheScope: async (backendId) => {
      const value = await getChatCacheScope(backendId);
      return value.backendId === backendId ? value.cacheScope : undefined;
    },
    getCached: getCachedChatHistory,
    putCached: putCachedChatHistory,
    deleteCached: deleteCachedChatHistory,
    clearCachedExcept: clearCachedChatHistoryExcept,
    prepare: prepareHistoryMessages,
    requestCanonical: async (key) => {
      const response = await send("chat.history", { sessionKey: key, limit: 1000 });
      const raw = response?.payload?.messages;
      if (!Array.isArray(raw)) throw new Error("chat.history returned no messages array");
      return raw;
    },
    isInFlight: (key) => inFlightRef.current.has(key),
    commitOpen: commitOpenedHistory,
    commitCanonical: (key, msgs) => commitCanonicalHistory(key, msgs),
    commitFailure: (key, error, cacheVisible) => {
      if (activeKeyRef.current !== key || cacheVisible || historyVisibleRef.current || historyLoadedRef.current) return;
      setHistoryError(error instanceof Error ? error.message : String(error));
    },
  }), [commitCanonicalHistory, commitOpenedHistory, prepareHistoryMessages, send]);
  historyControllerRef.current = chatHistoryController;

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

  const fetchAgentNames = useCallback(async (): Promise<AgentNameIndex> => {
    const response = await send("agents.list", {});
    const rows = Array.isArray(response?.payload?.agents) ? response.payload.agents : [];
    // Chat agent ids are the federating gateway's routing namespace, so keep
    // this lookup unscoped. Management pages use backend-scoped ids below.
    return createAgentNameIndex(rows.map((row: any) => ({
      id: row?.id,
      name: row?.name,
      identity: row?.identity,
    })));
  }, [send]);

  const refreshSessions = useCallback(async (): Promise<void> => {
    const ticket = sessionListGuard.begin();
    let fetchedRows: SessionRow[] | null = null;
    // 名称请求独立结算：慢/失败都不能挡住会话列表和首个 history 加载。
    void fetchAgentNames()
      .then((currentNames) => {
        if (!sessionListGuard.isCurrent(ticket)) return;
        agentNamesRef.current = currentNames;
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
  }, [commitSessions, fetchAgentNames, fetchAllSessions, sessionListGuard]);

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
        const switchedText = scope === "persist" ? t("chat.switchedPersisted", { label }) : t("chat.switchedLabel", { label });
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
    if (activeKeyRef.current !== sessionKey) return;
    setMessages((previous) => decorateHistoryWithLiveState(sessionKey, previous));
  }, [decorateHistoryWithLiveState]);

  const recoverOpenClawQuestions = useCallback(async (sessionKey: string) => {
    const contract = gatewayContractRef.current;
    if (!gatewaySupportsQuestions(contract)) return;
    const eventEpoch = questionEventEpochRef.current;
    try {
      const response = await send("question.list", {});
      if (gatewayContractRef.current !== contract || questionEventEpochRef.current !== eventEpoch) return;
      const rawQuestions = response?.payload?.questions;
      if (!Array.isArray(rawQuestions)) return;
      const recovered = rawQuestions
        .map((record: unknown) => normalizeOpenClawQuestionPrompt(record))
        .filter((record: OpenClawQuestionPromptEntry | null): record is OpenClawQuestionPromptEntry => (
          record?.sessionKey === sessionKey
        ));
      const legacy = (pendingPromptsRef.current.get(sessionKey) ?? [])
        .filter((entry) => !isOpenClawQuestionPrompt(entry));
      replacePendingPrompts(sessionKey, [...legacy, ...recovered]);
      renderLiveStateForSession(sessionKey);
    } catch {
      // Reconnect recovery is best effort. The live requested event remains the
      // primary path and a later gateway.ready/session switch retries the list.
    }
  }, [renderLiveStateForSession, replacePendingPrompts, send]);

  const clearOpenClawProgressCard = useCallback((sessionKey: string) => {
    progressCardsRef.current.delete(sessionKey);
    const plan = pendingPlanRef.current.get(sessionKey);
    if (plan?.some((entry) => entry.progressRevision !== undefined)) {
      pendingPlanRef.current.delete(sessionKey);
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
      const sk = openClawQuestion?.sessionKey || activeSessionKey;
      if (!sk) return;
      try {
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
    [renderLiveStateForSession, replacePendingPrompts, send],
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
      const modelCaps = chatCapsRef.current[agentOf(key)];
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
  const toggleFast = useCallback(async () => {
    const key = activeKeyRef.current;
    if (!key) return;
    const previous = sessionsRef.current.find(row => row.key === key)?.fastMode ?? fastByKey[key] ?? false;
    if (await patchSession({ fastMode: !previous }, "fast")) {
      setFastByKey((m) => ({ ...m, [key]: !previous }));
    }
  }, [fastByKey, patchSession]);

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
      ws.onopen = async () => {
      const isReconnect = hadConnected;
      hadConnected = true;
      failedAttempts = 0;
      setConnected(true);
      setEverConnected(true);
      setError(null);
      if (isReconnect) {
        // In-flight marks belong to the DEAD socket: their final/error events
        // are gone (Hermes runs emit only to the old connection; a restarted
        // gateway killed the run). Without this the composer shows "生成中"
        // forever. A still-running gateway turn's outcome re-arrives via
        // session.message / the loadHistory below regardless.
        inFlightRef.current.clear();
        runStatusBySessionRef.current.clear();
        setRunningKeys(new Set());
        setSending(false);
      }
      try {
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
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    };
      ws.onclose = () => {
        // close 必须结算该 socket 的请求；随后再核对身份，避免旧 close 改写新连接状态。
        rejectPendingRpcForSocket(pending.current, ws, new Error(t("chat.connectionError")));
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        gatewayContractRef.current = null;
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
      ws.onmessage = (ev) => {
      let f: any;
      try {
        f = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (f.type === "res" && f.id != null) {
        const p = takePendingRpc(pending.current, String(f.id), ws);
        if (!p) return;
        if (f.ok === false) p.reject(new Error(f.error?.message || t("chat.requestFailed")));
        else p.resolve(f);
        return;
      }
      if (f.type === "event" && f.event === "gateway.ready") {
        const contract = f.payload?.degraded === true ? null : normalizeGatewayContract(f.payload);
        gatewayContractRef.current = contract;
        setGatewayContract(contract);
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
          if (sessionKey === activeKeyRef.current) changedActive = true;
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
      if (f.type === "event" && f.event === "agents.changed") {
        // Backend topology changed: the proxy emits this when the gateway goes
        // degraded / comes back, and when a slow backend (Hermes) finishes
        // starting. Re-pull the list so agents appear/disappear without a reload.
        void refreshSessions().catch(() => {});
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
        // 同时复查连通状态：分批启动的后端刚从 starting 翻成 connected，靠这次探测
        // 让灰点立刻转绿，不必等 15s 轮询。
        void refreshStatusRef.current?.();
        return;
      }
      if (f.type === "event" && f.event === "chat") {
        const p = f.payload || {};
        const sk: string | undefined = p.sessionKey;
        const isActive = sk === activeKeyRef.current;
        if (sk) {
          if (p.state === "status" && typeof p.statusKind === "string") {
            runStatusBySessionRef.current.set(sk, p.statusKind);
          } else if (["delta", "interim", "thinking", "plan"].includes(p.state)) {
            runStatusBySessionRef.current.set(sk, "running");
          } else if (p.state === "prompt") {
            runStatusBySessionRef.current.set(
              sk,
              p.prompt?.kind === "approval" ? "waiting_approval" : "waiting_input",
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
        if (sk && isLiveChatState(p.state)) markInFlight(sk, true);
        if (sk) {
          // a real reply is arriving → cancel any slash-command watchdog for this session
          const wd = slashWatchdogRef.current.get(sk);
          if (wd) {
            clearTimeout(wd);
            slashWatchdogRef.current.delete(sk);
          }
        }
        if (p.state === "delta") {
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
                (sk && pendingPromptsRef.current.get(sk)) || [],
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
            timelineFeed(sk, { kind: "interim", text: projected.visible });
            liveToolsRef.current.delete(sk);
            pendingThinkingRef.current.delete(sk);
            if (isActive) {
              setMessages((prev) => [
                ...finalizeAssistant(prev, p.message, wasSteered ? projected.visible : undefined),
                { role: "assistant", parts: [{ type: "text", text: "" }], pending: true },
              ]);
            }
            // Commentary/interim seals the current runtime text item. The next
            // item starts a fresh accumulator and no longer needs the steer cut.
            liveTextRef.current.delete(sk);
            steerTextBaselineRef.current.delete(sk);
          }
        } else if (p.state === "status") {
          // 执行等待在会话状态和 pending 气泡显示，压缩仍使用轻量 toast。
          if (sk && typeof p.statusKind === "string") timelineFeed(sk, { kind: "status", status: { kind: p.statusKind, text: typeof p.text === "string" ? p.text : undefined } });
          if (p.statusKind === "compacting") {
            setToast({ text: t("chat.compactingCtx"), kind: "pending" });
          } else if (p.statusKind === "compacted") {
            setToast({ text: t("chat.compactedCtx"), kind: "success" });
            setTimeout(() => setToast(null), 1800);
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
              setMessages((prev) => applyToolStream(prev, liveToolsRef.current.get(sk) || [], p.thinking, pendingPlanRef.current.get(sk) || [], pendingPromptsRef.current.get(sk) || []));
          }
        } else if (p.state === "plan") {
          // ACP plan event = the agent's todo list. Pin it as a checklist on the pending bubble.
          if (sk && Array.isArray(p.plan)) {
            timelineFeed(sk, { kind: "plan", entries: p.plan });
            pendingPlanRef.current.set(sk, p.plan);
            if (isActive)
              setMessages((prev) => applyToolStream(prev, liveToolsRef.current.get(sk) || [], pendingThinkingRef.current.get(sk) || "", p.plan, pendingPromptsRef.current.get(sk) || []));
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
            // 未读红点（R81）：非活跃 agent 收到真实（非心跳）回复 → 标记未读；活跃 agent → 顺手已读。
            // 后台会话（cron/subagent/dream/heartbeat）不点红点（R245）：网关把后台运行的 final 也广播到
            // 这里（isControlUiVisible 默认 true），而 cron 的 per-run key（`…:cron:<jobId>:run:<uuid>`）
            // 根本不在 sessions.list，chat.history 返 0 条。红点于是只能落到该 agent 的代表会话上 =
            // 点开全是旧消息。未读的另一半（rank）本来就只算前台会话，这里补齐同一口径。
            // （R266 把这些会话放回了切换器，但「不点红点」的理由不变：红点指的是该 agent 行，
            // 而行代表的是前台会话；后台产出去切换器对应的 Tab 或 Cron 页运行记录里看。）
            const ag = agentOf(sk);
            const finalText = fullFinalText;
            const isRealReply = canvasPartsFromContent(p.message?.content ?? p.message).length > 0 || !isHeartbeatAckText(finalText);
            const finalSessionKind = p.message?.shoggoth?.source === "cron" ? "cron"
              : sessionsRef.current.find((row) => row.key === sk)?.kind;
            if (ag && ag === agentOf(activeKeyRef.current || "")) markAgentRead(ag);
            else if (ag && isRealReply && !isBackgroundSession(sk, finalSessionKind)) setLiveMsgAt((prev) => ({ ...prev, [ag]: finishedAt }));
            // bumpSession 只推进 updatedAt，而行时间/排序的口径早已换成 realTimes/previewTimes
            // （updatedAt 只是冷启动兜底）。深扫探针按 key 去重、成功后永不重扫，所以一个扫过的
            // 非活跃 agent 收到真实回复后：红点亮起，行时间却仍显示「5 小时前」，位置也不上浮。
            // 这里把真实回复同样写穿三处记账，和 loadHistory / 探针保持一个口径。
            if (isRealReply) {
              recordActivity(sk, finishedAt);
              setRealTimes((prev) => ({ ...prev, [sk]: Math.max(prev[sk] ?? 0, finishedAt) }));
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
            setMessages((prev) => finalizeAssistant(
              prev,
              p.message,
              wasSteered ? projectedFinal.visible : undefined,
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
            markInFlight(sk, false);
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
              ...prev.filter((m) => !m.pending),
              { role: "system", parts: [{ type: "text", text: p.errorMessage || "" }], errPrefix: "chat.errorPrefix" },
            ]);
            if (sk && progressCardsRef.current.has(sk)) renderLiveStateForSession(sk);
            setSending(false);
            // 用户正看着这个会话的失败回执 → 顺手已读。错误轮次不走 final 分支，
            // 缺这笔 readAt 推进的话，错误的活动时间 > 打开时刻，切走后误亮红点（R81）。
            markAgentRead(agentOf(sk || ""));
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
              ? finalizeAssistant(prev, p.message, wasSteered ? projected.visible : undefined)
              : prev.filter((m) => !m.pending)));
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
          runStatusBySessionRef.current.set(sk, "running");
          const arr = liveToolsRef.current.get(sk) ?? [];
          let entry = arr.find((x) => x.id === id);
          if (!entry) {
            entry = { id, name: typeof d.name === "string" && d.name ? d.name : "tool" };
            arr.push(entry);
          } else if (typeof d.name === "string" && d.name) {
            entry.name = d.name;
          }
          if (entry.args === undefined && d.args !== undefined) entry.args = d.args; // call args (start phase) → card title
          if (entry.diff === undefined && d.diff) entry.diff = d.diff; // file-edit diff (write/patch start)
          if (entry.diffText === undefined && typeof d.diffText === "string" && d.diffText) entry.diffText = d.diffText; // Hermes inline_diff
          if (typeof d.durationS === "number" && d.durationS > 0) entry.durationS = d.durationS; // Hermes tool runtime
          if (d.phase === "result" && d.result !== undefined) entry.output = formatToolOutput(d.result);
          else if (d.phase === "update" && d.partialResult !== undefined) entry.output = formatToolOutput(d.partialResult);
          if (d.isError === true || (entry.output && /"status"\s*:\s*"error"/.test(entry.output))) entry.isError = true;
          liveToolsRef.current.set(sk, arr);
          // R339 直播时间线:同一事件并行喂 reducer(字段与钩子契约同名直传)。
          timelineFeed(sk, {
            kind: "tool",
            toolCallId: id,
            name: typeof d.name === "string" && d.name ? d.name : undefined,
            args: d.args,
            phase: d.phase === "result" ? "result" : d.phase === "update" ? "update" : "start",
            result: d.result,
            partialResult: d.partialResult,
            isError: d.isError === true ? true : undefined,
            durationS: typeof d.durationS === "number" ? d.durationS : undefined,
            diff: d.diff,
            diffText: typeof d.diffText === "string" && d.diffText ? d.diffText : undefined,
          });
          if (sk === activeKeyRef.current) setMessages((prev) => applyToolStream(prev, arr, pendingThinkingRef.current.get(sk) || "", pendingPlanRef.current.get(sk) || [], pendingPromptsRef.current.get(sk) || []));
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
              // 活跃会话里的失败回执（error 事件被 skip、只有 session.message 到达的
              // skipChatErrorFinal 路径）同样顺手已读，防切走后误亮红点（R81）。
              markAgentRead(agentOf(sk));
            }
          }
          // {refresh:true}：这是一次**后台重载**，线程里已经有完整历史。不带这个标志时
          // loadHistory 的失败分支会 setMessages([])，一次 chat.history 超时就把整屏消息
          // 清空、并因 historyLoaded 已为 true 而显示「此会话暂无消息记录」。
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
    rememberChosen,
    chatHistoryController,
    clearOpenClawProgressCard,
    refreshOpenClawProgressCard,
    renderLiveStateForSession,
    replacePendingPrompts,
  ]);

  // A new negotiated connection or a session switch restores only capabilities
  // the 8.1 hello actually advertised. Both calls use the ordinary request-id
  // map, so disconnects reject promptly and late responses cannot cross sockets.
  useEffect(() => {
    if (!activeKey || !gatewayContract) return;
    if (gatewaySupportsQuestions(gatewayContract)) {
      void recoverOpenClawQuestions(activeKey);
    }
    if (gatewaySupportsProgressCards(gatewayContract)) {
      void refreshOpenClawProgressCard(activeKey);
    }
  }, [activeKey, gatewayContract, recoverOpenClawQuestions, refreshOpenClawProgressCard]);

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
    const composer = thread.parentElement?.querySelector(".chat-composer")?.getBoundingClientRect();
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
    if (initialScrollFrameRef.current != null) cancelAnimationFrame(initialScrollFrameRef.current);
    initialScrollFrameRef.current = null;
  }, []);
  useEffect(() => cancelInitialScroll, [cancelInitialScroll]);
  useLayoutEffect(() => {
    const el = threadRef.current;
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
  }, [messages, activeKey]);

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
    if (archive.key === key && archive.status !== "idle" && archive.status !== "error") return;
    archiveLoadingRef.current = true;
    void loadArchive().finally(() => {
      archiveLoadingRef.current = false;
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
    const el = threadRef.current;
    if (el && e.deltaY < 0 && el.scrollTop < 60) maybeLoadArchive();
  };
  const jumpToLatest = () => {
    cancelInitialScroll();
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
    const refreshStatus = async () => {
      try {
        const r = await fetch("/__api/status");
        if (!r.ok) return;
        const d = await r.json();
        const rows: { id?: string; connected?: boolean; disabled?: boolean; info?: { starting?: boolean; readyAgentIds?: string[] } }[] =
          Array.isArray(d?.backends) ? d.backends : [];
        const set = new Set(rows.filter((b) => b?.connected && b.id).map((b) => b.id as string));
        const starting = new Set(
          rows.filter((b) => !b?.connected && b?.info?.starting && b.id).map((b) => b.id as string),
        );
        const ready = new Set(rows.flatMap((b) => Array.isArray(b.info?.readyAgentIds) ? b.info.readyAgentIds : []));
        if (!cancelled) {
          setConnectedBackends(set);
          setStartingBackends(starting);
          setReadyAgentIds(ready);
        }
      } catch {
        /* offline / fetch failed → keep prior set */
      }
    };
    void refreshStatus();
    // 后端就绪广播（agents.changed）要能就地复查状态，否则一个刚启动完的后端要
    // 等下一个 15s tick 才从 starting 转 connected——行可见但一直灰着。
    refreshStatusRef.current = refreshStatus;
    // Light periodic re-probe so the "offline" dot flips reasonably fast even while
    // focused (focus/visibility events alone miss a backend dropping mid-session).
    const iv = setInterval(refreshStatus, 15000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshStatus();
    };
    window.addEventListener("focus", refreshStatus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      refreshStatusRef.current = null;
      clearInterval(iv);
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

  // Upgrade ```html fences into live sandboxed previews (see lib/htmlArtifacts.ts).
  // A widget's window.sendPrompt(text) forwards here → sends as if the user typed it.
  useEffect(() => {
    installHtmlArtifacts();
    setSendPromptHandler((text) => {
      const key = activeKeyRef.current;
      const sendController = sendControllerRef.current;
      sendController.widget(key, () => { void sendChatMessageRef.current?.(text, []); });
    });
  }, []);

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
    if (!activeModelsBackend) return;
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
  }, [activeModelsAgentId, activeModelsBackend, connected, send]);

  const openSession = useCallback((key: string) => {
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
  const routerLocation = useLocation();
  const routerNavigate = useNavigate();
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
    const deepLinkBackend = params.get("backend")?.trim() || "";
    if (!key) return;
    // StrictMode 会重放同一 location 的 effect；ref 在首次执行中同步落闸，避免第二次
    // openSession 清掉刚设置的 quote。新导航即便 URL 相同也有新的 location.key。
    const locationIdentity = `${routerLocation.key}:${routerLocation.search}`;
    if (handledSessionLocationRef.current === locationIdentity) return;
    handledSessionLocationRef.current = locationIdentity;
    const handoff = consumeCronChatHandoff(deepLinkBackend || backendOfSession(key), key);
    routerNavigate("/chat", { replace: true });
    // 深链多半指向**刚刚**建出来的会话（工作板点「运行」→ 后端在网关新建 per-card
    // subagent 会话 → 立刻跳过来），它还不在 sessions 里。而面板挂在
    // `active = sessions.find(key)` 上，找不到就整个不渲染 =「选择左侧一个会话开始」。
    // sessions 又只在 WS onopen / agents.changed / 手动刷新时才整体重拉，不会自己收录
    // 新会话 —— 于是空白一直挂着。先补一条合成行让面板立刻可用（与通知点击入口同一套
    // 兜底），再拉一次真列表把合成行换成真行（mergeSynthetic 会自动清理合成副本）。
    const { ensureSessionRow: ensure, refreshSessions: refreshList } = deepLinkDepsRef.current;
    void openChatSessionLink(key, {
      ensureSession: () => ensure(key, undefined, deepLinkBackend ? { backendId: deepLinkBackend } : undefined),
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
  }, [routerLocation, routerNavigate]);

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
    const agent = agentOf(key);
    if (backendOfKnownAgent(agent) !== "openclaw") {
      setArchive({ key, status: "unsupported" });
      return;
    }
    setArchive({ key, status: "loading" });
    try {
      const q = new URLSearchParams({ backend: "openclaw", agentId: agent, key });
      const r = await fetch(`/__api/sessions/archive?${q.toString()}`);
      const data = (await r.json()) as {
        archive?: { supported: boolean; reason?: string; segments: Array<{ sealedAt: number | null; fromReset: boolean; truncated?: boolean; messages: unknown[] }> };
      };
      if (activeKeyRef.current !== key) return; // switched away mid-fetch
      const arc = data.archive;
      if (!r.ok || !arc) {
        setArchive({ key, status: "error" });
        return;
      }
      if (!arc.supported) {
        setArchive({ key, status: "unsupported", error: arc.reason });
        return;
      }
      if (!arc.segments.length) {
        setArchive({ key, status: "empty" });
        return;
      }
      const prepend: ChatMsg[] = [];
      let count = 0;
      for (const seg of arc.segments) {
        prepend.push({ role: "system", parts: [], divider: { sealedAt: seg.sealedAt, fromReset: seg.fromReset, truncated: seg.truncated } });
        for (const raw of seg.messages) {
          const nm = normalize(raw);
          if (isInterruptMarker(nm)) continue; // 归档段同样隐藏中断标记（R358）
          prepend.push(nm);
          count += 1;
        }
      }
      // Keep a visible bubble's actual position; content-visibility makes the
      // full scrollHeight an estimate until offscreen content is visited.
      const thread = threadRef.current;
      const bounds = thread?.getBoundingClientRect();
      const node = thread && bounds ? Array.from(thread.querySelectorAll<HTMLElement>(".chat-bubble")).find((bubble) => {
        const rect = bubble.getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom;
      }) : undefined;
      const messageNode = node?.closest<HTMLElement>("[data-message-key]");
      prependAnchorRef.current = {
        height: thread?.scrollHeight ?? 0, node, top: node?.getBoundingClientRect().top,
        messageKey: messageNode?.dataset.messageKey,
        bubbleIndex: node && messageNode ? Array.from(messageNode.querySelectorAll(".chat-bubble")).indexOf(node) : undefined,
      };
      archivePrefixRef.current = { key, msgs: prepend }; // 供后续 loadHistory 刷新后贴回
      setMessages((prev) => [...prepend, ...prev]);
      setArchive({ key, status: "loaded", count });
    } catch (e) {
      if (activeKeyRef.current === key) setArchive({ key, status: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }, []);

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
    const caps = chatCapsRef.current[agentOf(key)];
    return (caps?.gatewayPolicy ? gatewayContractRef.current?.policy.maxPayload : undefined)
      ?? caps?.maxPayloadBytes;
  };
  const inspectChatSendPayload = (key: string, text: string, atts: readonly ChatAttachment[]) => {
    const maxPromptBytes = chatCapsRef.current[agentOf(key)]?.maxPromptBytes;
    const promptBytes = new TextEncoder().encode(JSON.stringify(text)).byteLength;
    if (maxPromptBytes && promptBytes > maxPromptBytes) {
      return { allowed: false, payloadBytes: promptBytes, maxPayload: maxPromptBytes };
    }
    return gatewayRequestPayloadBudget(
      String(reqId.current),
      "chat.send",
      buildChatSendParams(key, text, CHAT_SEND_IDEMPOTENCY_SAMPLE, atts),
      maxPayloadForSession(key),
    );
  };
  const inspectChatSteerPayload = (key: string, text: string) => {
    const maxPromptBytes = chatCapsRef.current[agentOf(key)]?.maxPromptBytes;
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
  ) => {
    const key = activeKeyRef.current;
    // 防御性门禁：即使某个新入口绕过 submit，也不能在 Hermes profile 尚未 ready
    // 时制造 RPC、乐观气泡或缓存写入。
    if (!key || !sendController.canSend(key) || inFlightRef.current.has(key)) return;
    const inputBudget = inspectChatSendPayload(key, text, atts);
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
    const recent = atts.length ? undefined : recentSendRef.current.get(key);
    if (recent && recent.text === text && nowTs - recent.at < DUP_SEND_WINDOW_MS) {
      const recentParams = buildChatSendParams(key, text, recent.idem, atts);
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
      void send("chat.send", recentParams).catch(() => {});
      return;
    }
    const idem = crypto.randomUUID();

    const params = buildChatSendParams(key, text, idem, atts);
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
    if (!atts.length) recentSendRef.current.set(key, { text, idem, at: nowTs });

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
    bumpSession(key, Date.now()); // my own send floats this agent to the top immediately
    sendAnchorRef.current = true; // my own send repositions ONCE: park the sent bubble at the top, reply streams into the space below (no continuous auto-follow — R280)
    setImmersiveSendSeq((s) => s + 1); // 沉浸层的 R280 mirror 用这个单调计数当「本次发送要锚定」信号
    const nextMessages: ChatMsg[] = [
      ...messagesRef.current,
      {
        role: "user",
        parts: [{ type: "text", text: displayText }],
        images: imgs.length ? imgs : undefined,
        retryAttachments: atts.length ? atts : undefined,
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
        ts: Date.now(),
      },
      {
        role: "assistant",
        parts: composePendingParts([], "", "", pendingPlanRef.current.get(key) || []),
        pending: true,
      },
    ];
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
    try {
      await send("chat.send", params);
    } catch (e) {
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
      if (activeKeyRef.current !== key) return true;
      const nextMessages = appendSteeringMessage(messagesRef.current, text);
      messagesRef.current = nextMessages;
      setMessages(nextMessages);
      bumpSession(key, Date.now());
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
  const enqueueMessage = (key: string, text: string, atts: ChatAttachment[]) => {
    const q = sendQueueRef.current.get(key) ?? [];
    q.push({ id: crypto.randomUUID(), text, atts });
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
    const payloadBudget = inspectChatSendPayload(key, item.text, item.atts);
    if (!payloadBudget.allowed) {
      showPayloadLimit("chat.queuedPayloadTooLarge", payloadBudget.payloadBytes, payloadBudget.maxPayload);
      return;
    }
    q.shift();
    bumpQueue();
    void sendChatMessage(item.text, item.atts);
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
    bumpQueue();
    setInput((prev) => (prev.trim() ? `${prev}\n${item.text}` : item.text));
    if (item.atts.length) setComposerAttachments((prev) => [...prev, ...item.atts]);
    visibleComposerEl()?.focus();
  };
  const removeQueued = (id: string) => {
    const key = activeKeyRef.current;
    if (!key) return;
    const q = sendQueueRef.current.get(key) ?? [];
    const idx = q.findIndex((m) => m.id === id);
    if (idx < 0) return;
    q.splice(idx, 1);
    bumpQueue();
  };
  const clearQueue = () => {
    const key = activeKeyRef.current;
    if (!key) return;
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
        const subs = sessions
          .filter((s) => agentOf(s.key) === aId && /:subagent[:-]/i.test(s.key))
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
        const subs = sessions.filter((s) => agentOf(s.key) === aId && /:subagent[:-]/i.test(s.key));
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
            chatCapsRef.current[agentOf(key)],
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
            // The owning backend inherits explicit project directories; native
            // generated directories get a new private workspace for this session.
            parentSessionKey: key,
            // The proxy adapts this backend-neutral identity to the owning
            // transport; raw model ids may themselves contain `/`.
            ...creationHints,
            ...(nativeSession && workspace ? { workspace } : {}),
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

  // 服务端斜杠执行（capability 驱动）：回显命令 → REST exec → typed 结果分派。
  const execServerSlash = async (key: string, raw: string) => {
    const echo = () => setMessages((prev) => [
      ...prev,
      { role: "user", parts: [{ type: "text", text: raw }], ts: Date.now() },
    ]);
    setToast({ text: t("chat.slashRunning"), kind: "pending" });
    try {
      const r = await execSlashCommand(agentOf(key), key, raw);
      setToast(null);
      if (activeKeyRef.current !== key) {
        if (r.kind === "send" || r.kind === "prefill") draftsRef.current.set(key, raw);
        return;
      }
      if (r.kind === "send" && r.text) {
        await sendChatMessage(r.text, [], true, raw);
        return;
      }
      if (r.kind === "prefill") {
        setInput(r.text || "");
        inputRef.current = r.text || "";
        focusComposer((r.text || "").length);
        return;
      }
      echo();
      const out = (r.text || "").trim();
      const body = out ? "```\n" + out + "\n```" : t("chat.commandNoReply");
      pushLocal(r.warning ? `${body}\n\n> ${r.warning}` : body);
    } catch (e) {
      setToast(null);
      if (activeKeyRef.current !== key) { draftsRef.current.set(key, raw); return; }
      echo();
      pushLocal(t("chat.slashFailed", { msg: e instanceof Error ? e.message : String(e) }));
    }
  };

  const submit = async (overrideText?: string) => {
    const key = activeKeyRef.current;
    // 第一条可执行逻辑就是 readiness 门禁：拒绝时草稿、引用、附件、历史和队列均不动。
    if (!sendController.composerButton(key, () => true)) return;
    if (attachments.length && key
      && !supportsBackendAttachments(backendOfSession(key), chatCapsRef.current[agentOf(key)])) {
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
      chatCapsRef.current[agentOf(key)],
    ) || chatBackendDescriptors.get(backendId)?.surfaces.agentHarness === true;
    const recoverySlashPool = recoverySlashCommandsForBackend(
      hasServerSlashSurface,
      SLASH_COMMANDS,
    ).filter((command) => !visibleSlashPool.some((visible) => visible.name === command.name));
    const parsedSlash = !attachments.length && text.startsWith("/")
      ? parseSlashInput(text, [...visibleSlashPool, ...recoverySlashPool])
      : null;
    const isRunControl = !!parsedSlash && (canRunSlashDuringTurn(parsedSlash.command.name)
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
      if (inFlight) {
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
    const shouldSteer = inFlight && canSteerActiveChat(
      chatCapsRef.current[agentOf(key)],
      runStatusBySessionRef.current.get(key),
      atts.length,
    );
    const payloadBudget = shouldSteer
      ? inspectChatSteerPayload(key, outgoing)
      : inspectChatSendPayload(key, outgoing, atts);
    if (!payloadBudget.allowed) {
      showPayloadLimit("chat.sendPayloadTooLarge", payloadBudget.payloadBytes, payloadBudget.maxPayload);
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
    enqueueMessage(key, outgoing, atts);
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
    try {
      await send("chat.abort", { sessionKey: key });
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      return;
    }
    markInFlight(key, false);
    if (activeKeyRef.current === key) {
      setSending(false);
      setMessages((prev) => prev.filter((m) => !m.pending));
    }
  };

  // Manual refresh: re-pull sessions, active history, and the current model menu.
  // 等历史也落地再 resolve —— 导航栏刷新（lib/page-refresh）靠这个 promise 决定
  // 什么时候弹「已刷新」，提前 resolve 会让 toast 跑在内容前面。
  const refreshChatOrThrow = async () => {
    await refreshSessions();
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

  const renameActiveSession = () => {
    const key = activeKeyRef.current;
    if (!key) return;
    setSessionRenameTarget({ key, label: sessionsRef.current.find((row) => row.key === key)?.label ?? "" });
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
    if (!key || !sendController.retry(key, () => true) || inFlightRef.current.has(key)) return;
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
          void sendChatMessage(txt, atts);
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
  const activeBackendDescriptor = chatBackendDescriptors.get(activeBackend);
  // Negotiated transport limits already arrive through the generic capability;
  // the composer never branches on a concrete backend to apply them.
  const activeCaps: ChatCapabilities | undefined = activeKey ? chatCaps[agentOf(activeKey)] : undefined;
  const selectableModels = useMemo(
    () => activeCaps?.modelScope
      ? models.filter((model) => model.modelScopes?.includes(activeCaps.modelScope!))
      : activeCaps?.modelProvider
        ? models.filter((model) => model.provider === activeCaps.modelProvider)
        : models,
    [activeCaps?.modelProvider, activeCaps?.modelScope, models],
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
    const caps = activeKeyRef.current ? chatCapsRef.current[agentOf(activeKeyRef.current)] : undefined;
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
    const caps = ag ? chatCaps[ag] : undefined;
    if (!key || !ag || !caps?.slash || caps.notReady) return;
    void slashCatalogStore.load(ag, backendOfKnownAgent(ag), key);
  }, [activeKey, slashCatalogSessionUpdatedAt, chatCaps, capsEpoch, slashCatalogStore]);

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
  const showAdvancedSessionDetails = hasAdvancedSessionDetails(activeAdvancedMethods);
  const activeRunInFlight = sending || (activeKey ? runningKeys.has(activeKey) : false);
  const activeCanSteer = activeKey
    ? canSteerActiveChat(activeCaps, runStatusBySessionRef.current.get(activeKey), 0)
    : false;
  const activeSessionArtifactResult = sessionArtifactState.key === activeKey
    ? sessionArtifactState.result
    : null;
  const sessionArtifactItems = activeSessionArtifactResult?.items ?? [];
  const sessionArtifactCount = activeSessionArtifactResult?.total ?? sessionArtifactItems.length;

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

  const openLocalFile = useCallback(async (filePath: string) => {
    try {
      await openPath(filePath);
    } catch (error) {
      setToast({
        text: t("chat.artifactsOpenFailed", { msg: error instanceof Error ? error.message : String(error) }),
        kind: "error",
      });
      setTimeout(() => setToast(null), 2600);
    }
  }, [t]);

  const openAttachmentFile = useCallback(async (file: { name: string; src?: string; path?: string }) => {
    try {
      if (file.path) await openPath(file.path);
      else if (file.src) await openAttachment(file.name, file.src);
      else throw new Error(t("chat.attachmentSourceMissing"));
    } catch (error) {
      setToast({ text: t("chat.artifactsOpenFailed", { msg: error instanceof Error ? error.message : String(error) }), kind: "error" });
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
    const onLocalFileClick = (event: MouseEvent) => {
      const anchor = (event.target as HTMLElement)?.closest?.("a[data-local-path]") as HTMLAnchorElement | null;
      if (!anchor) return;
      event.preventDefault();
      const encoded = anchor.getAttribute("data-local-path") || "";
      let filePath = "";
      try { filePath = decodeURIComponent(encoded); } catch { /* invalid marker stays inert */ }
      if (filePath) void openLocalFile(filePath);
    };
    document.addEventListener("click", onLocalFileClick);
    return () => document.removeEventListener("click", onLocalFileClick);
  }, [openLocalFile]);

  const nativeModelSelectionDisabled = activeBackendDescriptor?.surfaces.agentHarness === true
    && activeRunInFlight;
  const permissionOptions = (activeCaps?.permissions?.options ?? []).map((option) => localizePermissionMode(option, t));
  const activePermissionMode = active?.permissionMode
    || activeCaps?.permissions?.defaultMode
    || permissionOptions[0]?.id
    || "";
  const changePermissionMode = async (option: ChatPermissionModeOption) => {
    const key = activeKey;
    if (!key || activeRunInFlight) return;
    if (option.requiresConfirmation) {
      const accepted = await confirm({
        title: t("chat.permissionConfirmTitle", { mode: option.label }),
        message: t("chat.permissionConfirmMessage", { mode: option.label }),
        confirmLabel: t("chat.permissionConfirmAction"),
        danger: true,
      });
      if (!accepted || activeKeyRef.current !== key) return;
    }
    await patchSession({ permissionMode: option.id }, t("chat.labelPermission"));
  };
  const activeSendReady = canSendActiveSession(active?.key);
  const activeConnectingHint = !active || activeSendReady
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
  const displayModel = pickedModel ?? lastAssistantModel ?? active?.model ?? inheritedRuntimeDefault?.id ?? "";
  const displayModelProvider = active?.modelProvider ?? inheritedRuntimeDefault?.provider;
  // 新回答回来后让位给实际模型；切换会话时重置手动选择。
  useEffect(() => {
    setPickedModel(null);
  }, [lastAssistantModel, activeKey]);

  // Live activity status, derived from push signals (no backend changes):
  //   offline      = 用户在设置页主动断开了这个后端（唯一需要用户动手的状态）
  //   reconnecting = WS 断了，或后端暂时不在 /__api/status 的 connected 集合里
  //                  （网关重启 / 后端启动中）—— 两者都在自愈循环里跑着：UI 的 WS 3s
  //                  重连、proxy 每 4s 重拨上游。显示「离线」会让用户以为得自己修，
  //                  而实际上什么都不用做，等几秒就好。
  //   running      = a turn is in flight for this session (inFlightRef → runningKeys)
  //   online       = connected & idle
  const statusOf = (key: string): LiveStatus => {
    const backend = backendOfSession(key);
    if (disabledBackends.has(backend)) return "offline";
    if (startingBackends.has(backend)) return "reconnecting";
    if (!connected) return "reconnecting";
    if (connectedBackends != null && !connectedBackends.has(backend)) return "reconnecting";
    return runningKeys.has(key) ? "running" : "online";
  };
  const activeHeaderStatus = active ? statusOf(active.key) : null;
  // Agent-level (left rail): the agent is "running" if ANY of its sessions is.
  const agentStatusOf = (rows: SessionRow[]): LiveStatus => {
    if (!rows.length) return "offline";
    if (rows.some((s) => runningKeys.has(s.key))) return "running";
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
  const groups = useMemo(
    () => {
      const grouped = groupMessages(
        collapseErrorRuns(
          // R339:先吸收已完成回合的过程为 timeline part,再折叠错误重复。
          // lastTurnStepsRef 是 ref(不进 deps):final 后的 loadHistory 会 setMessages,
          // 本 memo 随之重算并读到最新留档,时序天然成立。
          absorbTurnTimelines(
            actionableMessages.filter((m) => !(m.actionId && hiddenIds.has(m.actionId)) && !isHeartbeatNoise(m)),
            lastTurnStepsRef.current.get(activeKeyRef.current || ""),
          ),
        ),
      );
      // Keep hidden inter-session inputs through turn folding/grouping so they still
      // separate adjacent assistant turns, then remove only their visual projection.
      return grouped.flatMap((group) => {
        const msgs = group.msgs.filter(
          (message) => !isInterSessionUserMessage(message, msgText(message)),
        );
        return msgs.length > 0 ? [{ ...group, msgs, ts: msgs[0].ts }] : [];
      });
    },
    [actionableMessages, hiddenIds],
  );
  // The thread only has its explicit pinned-only filter. Global search lives in
  // a modal and never mutates the active message projection.
  const shownGroups = useMemo(
    () => pinnedOnly
      ? groups.filter((g) => g.msgs.some((m) => m.actionId && pinnedIds.has(m.actionId)))
      : groups,
    [groups, pinnedOnly, pinnedIds],
  );
  // 先按稳定内容生成基础身份，再只对同级碰撞追加局部 occurrence；普通与沉浸模式共用同一份 key。
  const keyedShownGroups = useMemo(() => keyedChatGroups(shownGroups), [shownGroups]);
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
    const observer = new ResizeObserver(updateJumpVisibility);
    const targets = [thread, thread.firstElementChild,
      thread.parentElement?.querySelector(".chat-topdock"),
      thread.parentElement?.querySelector(".chat-composer")];
    for (const target of targets) if (target) observer.observe(target);
    return () => {
      observer.disconnect();
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
    pendingSearchJump, prepareHistoryMessages, send, t]);
  // 沉浸模式消息流：把 shownGroups 预渲染成简单判别联合（ImmersiveMessage），避免 ImmersiveChat
  // 耦合 ChatPage 内部 Group/ChatMsg 类型。正文/图片/非图附件之外，错误泡（×N/hover 原文/重试）、
  // 注入灰条（per-message 判定——旧版整组丢弃会连累相邻真实消息一起消失）、封存/模型切换分隔线、
  // 审批卡、流式光标都随判别字段带过去；工具卡/thinking 由轻量状态行呈现（S4），置顶/右键在 S7。
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
          m.role === "system" || isErrorTurn(m)
            ? "error"
            : m.local
              ? "local"
              : m.role === "user" && isInjectedPrompt(m)
                ? "injected"
                : "chat";
        const lastSeg = segs[segs.length - 1];
        if (lastSeg && lastSeg.cls === "chat" && cls === "chat") lastSeg.msgs.push(m);
        else segs.push({ cls, msgs: [m] });
      }
      // footer 与普通模式同口径（时间 · ↑↓token · ctx% · 模型），挂在组的最后一个保留段上
      const last = g.msgs[g.msgs.length - 1];
      const ts = g.ts ?? last?.ts;
      const model = last?.model && last.model !== "gateway-injected" ? last.model : "";
      const u = last?.usage;
      const inTok = u?.input ?? u?.inputTokens ?? 0;
      const outTok = u?.output ?? u?.outputTokens ?? 0;
      const cacheTok = u?.cacheRead ?? 0;
      const totalTok = u?.totalTokens ?? 0;
      const promptTok = inTok + cacheTok + (u?.cacheWrite ?? 0);
      const lim = active?.contextTokens ?? 0;
      // Hermes 网关直接给出服务端算好的 contextPercent；OpenClaw 仍按 prompt/窗口推算。
      const ctxPctMsg =
        u?.contextPercent != null
          ? Math.min(Math.round(u.contextPercent), 100)
          : lim && promptTok > 0
            ? Math.min(Math.round((promptTok / lim) * 100), 100)
            : null;
      const footer = [
        ts ? absTime(ts) : "",
        inTok > 0 ? `↑${fmtTokens(inTok)}` : "",
        outTok > 0 ? `↓${fmtTokens(outTok)}` : "",
        inTok === 0 && outTok === 0 && totalTok > 0 ? `${fmtTokens(totalTok)} tok` : "",
        ctxPctMsg != null ? `${ctxPctMsg}% ctx` : "",
        model,
      ]
        .filter(Boolean)
        .join(" · ");

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
        const media = g.role === "assistant" && seg.cls === "chat" ? extractAgentMedia(segText) : { text: segText, srcs: [] as string[] };
        const segImages = seg.msgs.flatMap((m) => m.images ?? []);
        const segFiles = seg.msgs.flatMap((m) => m.files ?? []);
        const prompts = seg.msgs.flatMap((m) =>
          m.parts.filter((p) => p.type === "prompt" && p.promptEntry).map((p) => p.promptEntry as ChatPromptEntry),
        );
        const hasId = g.msgs.some((m) => m.actionId);
        entries.push({
          id: segId,
          role: String(g.role),
          kind: seg.cls === "local" ? "local" : "chat",
          html: media.text.trim() ? toSanitizedMarkdownHtml(media.text, true) : "",
          images: [...segImages, ...media.srcs],
          files: segFiles.length ? segFiles : undefined,
          footer: "",
          pending: seg.msgs.some((m) => m.pending) || undefined,
          prompts: prompts.length ? prompts : undefined,
          // 悬浮操作/右键：无参闭包捕获 Group，动作与普通模式同一套 handler
          onCopy: segText ? () => copyText(segText) : undefined,
          onPin: hasId ? () => pinGroup(g) : undefined,
          pinned: hasId ? g.msgs.some((m) => m.actionId && pinnedIds.has(m.actionId)) : undefined,
          onDelete: hasId ? () => deleteGroup(g) : undefined,
          onCtx: (e) => openMenu(e, g, segText),
        });
      });
      // 空段（纯 thinking/工具轮次）不保留；审批卡在正文之前到达时靠 prompts 保住 pending 段
      const kept = entries.filter((e) =>
        e.kind !== "chat" && e.kind !== "local"
          ? true
          : !!e.html || e.images.length > 0 || (e.files?.length ?? 0) > 0 || (e.prompts?.length ?? 0) > 0,
      );
      if (kept.length && footer) kept[kept.length - 1] = { ...kept[kept.length - 1], footer };
      out.push(...kept);
    }
    return out;
  }, [immersive, keyedShownGroups, active?.contextTokens, pinnedIds, t]);
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
    if (activeKey && activeRunInFlight && runWaitBySession[activeKey]) {
      return { tools: [], wait: runWaitBySession[activeKey] };
    }
    const last = messages[messages.length - 1];
    if (!last?.pending) return null;
    const tools: ImmersiveLiveTool[] = [];
    let thinkingText = "";
    for (const p of last.parts) {
      if (p.type === "thinking" && p.text?.trim()) thinkingText = p.text;
      else if (p.type === "toolCall") {
        tools.push({ name: p.toolName || "", title: formatToolTitle(p.toolName, p.toolArgs) || undefined, done: false });
      } else if (p.type === "toolResult") {
        tools.push({ name: p.toolName || "", done: true, isError: p.isError, durationS: p.durationS });
      }
    }
    if (!tools.length && !thinkingText) return null;
    return { tools, thinkingText: thinkingText || undefined };
  }, [messages, activeKey, activeRunInFlight, runWaitBySession]);
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
    () => selectableModels.find((m) => m.id === (active?.model ?? inheritedRuntimeDefault?.id)),
    [active?.model, inheritedRuntimeDefault?.id, selectableModels],
  );
  const activeThinkingOptions = active?.thinkingOptions ?? activeModelInfo?.thinkingOptions;
  const activeThinkingDefault = active?.thinkingDefault ?? activeModelInfo?.thinkingDefault;
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
  // loaded thread (accurate + live). Drives the active agent's row time + sort so heartbeats and
  // error bubbles never bump it, and it follows whichever session you've selected.
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
  // agents memo 的 rowTime 用它作活跃行的「显示+排序」口径——显示什么就按什么排。
  const activeRealPreview = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "user" && m.role !== "assistant") continue;
      if (isNoiseForPreview(m)) continue;
      const t = stripPreviewMd(lastText(m.parts));
      // Error turns get a ⚠ marker so "Connection error." in a row reads as a
      // failure, not as something the agent said.
      if (t) return { text: m.isError || m.stopReason === "error" ? `⚠ ${t}` : t, ts: m.ts ?? 0 };
    }
    return { text: "", ts: 0 };
  }, [messages]);
  // The left list shows one entry PER AGENT (sessions grouped by agent id); the
  // active agent's individual sessions are switched from the header instead.
  // 活跃线程加载后，把它的预览文本/时间写穿到 previews/previewTimes（探针跳过活跃 agent，
  // 否则刚切换过会话的 agent 在变为非活跃的瞬间查不到 previewTimes[chosenKey]，行会闪一下
  // 跌到 rank、再被探针补扫拉回）。写穿后活跃→非活跃切换两个分支读到同一个值，零跳变。
  useEffect(() => {
    if (!activeKey || !historyLoaded) return;
    const { text, ts } = activeRealPreview;
    if (ts > 0) setPreviewTimes((p) => (p[activeKey] === ts ? p : { ...p, [activeKey]: ts }));
    if (text) setPreviews((p) => (p[activeKey] === text ? p : { ...p, [activeKey]: text }));
  }, [activeKey, historyLoaded, activeRealPreview]);

  const agents = useMemo(() => {
    const map = new Map<string, SessionRow[]>();
    for (const s of sessions) {
      const a = agentOf(s.key);
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
    // rank = 该 agent 已知的最大真实活动时间：跨其所有会话取 realTimes 的 max（不取 sessions[0]
    // 单点——rep 由 updatedAt 决定、会被各种 bump 翻转），活跃 agent 由 activeRealTime 抬高，
    // 完全没学到才落 updatedAt（冷启动首屏，探针几秒内自愈）。它现在只作 rowTime 的兜底。
    // 排序/行时间一律走 foreground：后台会话（cron 每次跑完、心跳每 30m）会把行不断
    // 顶到最上面，而行显示的又是另一条会话的预览——位置与内容对不上（R245 的 rank 口径）。
    const rankOf = (g: { agentId: string; foreground: SessionRow[] }) => {
      let rt = 0;
      for (const s of g.foreground) {
        const v = realTimes[s.key] ?? realTimeBounds[s.key] ?? 0;
        if (v > rt) rt = v;
      }
      if (g.agentId === aAgent && activeRealTime > rt) rt = activeRealTime;
      return rt || (g.foreground[0]?.updatedAt ?? 0);
    };
    // shownKey = 该行展示/点开的会话：活跃 agent 跟随当前打开的 activeKey（全量里找——
    // 用户从切换器点开一条 cron/子代理会话时，行就该跟着它走）；其余优先用户记住的选择，
    // 但只认前台会话（后台 final 也会 rememberChosen，认了它行就被 cron 劫持），
    // 否则落前台的 rep。
    const shownKeyOf = (g: { agentId: string; sessions: SessionRow[]; foreground: SessionRow[] }) => {
      if (g.agentId === aAgent && activeKey && g.sessions.some((s) => s.key === activeKey)) return activeKey;
      const c = chosenSessions[g.agentId];
      if (c && g.foreground.some((s) => s.key === c)) return c;
      return g.foreground[0]?.key ?? "";
    };
    // rowTime = 行上「显示」的时间：活跃 agent 用实时线程预览；openSession 清空 messages 到
    // loadHistory 落地的间隙 ts=0，先落该行原本显示的 previewTimes[shownKey]（防止点击瞬间
    // 跌到 rank 位、加载完再跳回的闪跳），都没有才落 rank。排序直接用 rowTime ——
    // 显示什么时间就按什么排，徽标与位置永远一致；选中旧会话该行就按旧时间沉下去（WYSIWYG）。
    const rowTimeOf = (g: { agentId: string; sessions: SessionRow[] }, shownKey: string, rank: number) =>
      (g.agentId === aAgent ? activeRealPreview.ts || previewTimes[shownKey] : previewTimes[shownKey]) || rank;
    const ranked = list.map((g) => {
      const rank = rankOf(g);
      const previewKey = shownKeyOf(g);
      // A blocking prompt outranks the ordinary row preview. Prefer an approval
      // over free-form input, and route the row click to the exact session that
      // owns the card so users do not have to hunt through the session menu.
      const approvalKey = g.foreground.find((s) => promptAttentionByKey[s.key] === "approval")?.key;
      const inputKey = g.foreground.find((s) => promptAttentionByKey[s.key] === "input")?.key;
      const attentionKey = approvalKey || inputKey || "";
      const attention = attentionKey ? promptAttentionByKey[attentionKey] : undefined;
      // 未读红点（R81）：非活跃 agent，且 max(rank, 实时新消息) 晚于「上次已读」。缺 readAt 记录
      // 视为已读（?? Infinity），避免首屏/新 agent 把历史消息误标未读（种子 effect 随后补 now）。
      const unread = g.agentId !== aAgent && Math.max(rank, liveMsgAt[g.agentId] ?? 0) > (readAt[g.agentId] ?? Infinity);
      return { ...g, rank, previewKey, attentionKey, attention, rowTime: rowTimeOf(g, previewKey, rank), unread };
    });
    ranked.sort((a, b) => b.rowTime - a.rowTime);
    // 只隐藏用户在设置页**主动断开**的后端——那是明确意图，留一堆灰行反而碍事。
    // 意外断线（网关重启、抖动）不再隐藏：行留在原位、**位置不变**（不做离线下沉，
    // 排序仍是上面那次 rowTime 排序），由 statusOf 灰下去。此前按 connected 过滤，
    // 网关一重启整组 agent 当场蒸发，是「聊着聊着 AI 全没了」的最后一刀。
    // 正在启动（startingBackends）本来就不该隐藏，现在天然涵盖。
    return disabledBackends.size ? ranked.filter((g) => !disabledBackends.has(backendOfKnownAgent(g.agentId))) : ranked;
  }, [sessions, disabledBackends, realTimes, realTimeBounds, activeRealTime, activeKey, previewTimes, activeRealPreview, chosenSessions, readAt, liveMsgAt, promptAttentionByKey]);
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
  }, [agents.length, updateAgentListFade]);

  // Seed readAt=now for agents we haven't tracked yet, so pre-existing history isn't shown as
  // unread; only activity after first sighting (incl. while-closed, backfilled via rank) flags
  // the dot. Computes missing inside the setter so it doesn't depend on readAt. (R81)
  useEffect(() => {
    setReadAt((prev) => {
      let changed = false;
      const next = { ...prev };
      const now = Date.now();
      for (const g of agents) if (next[g.agentId] === undefined) { next[g.agentId] = now; changed = true; }
      if (!changed) return prev;
      writeReadAt(next);
      return next;
    });
  }, [agents]);
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
          inspirationId: s.inspirationId,
          title,
          sub: sessionDisplayPreview(s, title),
          time: ts ? relTime(ts, t("chat.justNow")) : "",
          ts: ts ?? 0,
        };
      }),
    [activeAgentSessions, activeKey, activeRealPreview, activeRealTime, previewTimes, realTimes, t],
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
    const last = readLastActive();
    const restorable = last && agents.some((g) => g.sessions.some((s) => s.key === last));
    void chatHistoryController.bootstrap(restorable ? (last as string) : agents[0].sessions[0].key);
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
        ensureSessionRow(pending);
        openSession(pending);
      }
    } catch { /* ignore */ }
    const onOpen = (e: Event) => {
      const key = (e as CustomEvent<string>).detail;
      try { sessionStorage.removeItem(PENDING); } catch { /* ignore */ }
      if (typeof key === "string" && key) {
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
  // skipped — it uses `activeRealTime` straight from the live thread.
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
        if (!key || realTimeFetchedRef.current.has(key)) continue;
        realTimeFetchedRef.current.add(key);
        try {
          const res: any = await send("chat.history", { sessionKey: key, limit: 150, maxChars: 320 });
          const msgs: any[] = res?.payload?.messages || [];
          let ts = 0;
          let text = "";
          let previewTs = 0;
          for (let i = msgs.length - 1; i >= 0 && (!ts || !text); i--) {
            const m = msgs[i];
            if (m?.role !== "user" && m?.role !== "assistant") continue;
            const nm = normalize(m);
            if (isNoiseForPreview(nm)) continue; // skip heartbeats AND injected cron prompts
            // 时间只认真实对话（错误泡不算，见 isRealActivity）；预览不同——错误仍以 ⚠ 显示。
            if (!ts && isRealActivity(nm)) ts = typeof m?.timestamp === "number" ? m.timestamp : 0;
            if (!text) {
              const raw = stripPreviewMd(lastText(nm.parts));
              text = raw && (nm.isError || nm.stopReason === "error") ? `⚠ ${raw}` : raw;
              if (text) previewTs = typeof m?.timestamp === "number" ? m.timestamp : 0;
            }
          }
          if (ts > 0) {
            setRealTimes((p) => ({ ...p, [key]: Math.max(p[key] ?? 0, ts) }));
            recordActivity(key, ts); // 持久化探针学到的真实时间 → 冷启动/refetch 首屏即按真实时间排序
          } else {
            // 150 条窗口全是机械段（心跳 30min×4 条/轮 ≈ 18h 刷满）：记上界，别落回心跳 updatedAt。
            const oldest = msgs.find((x) => typeof x?.timestamp === "number")?.timestamp ?? 0;
            if (oldest > 0) setRealTimeBounds((p) => ({ ...p, [key]: Math.min(p[key] ?? Infinity, oldest) }));
          }
          if (text) setPreviews((p) => ({ ...p, [key]: text }));
          if (text && previewTs > 0) setPreviewTimes((p) => ({ ...p, [key]: previewTs }));
        } catch {
          realTimeFetchedRef.current.delete(key); // failed → retry next pass
        }
      }
    })();
    return () => {
      stop = true;
    };
  }, [agents, activeAgentId, send]);

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

  return (
    <>
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
            const data = globalSearch.data;
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
      open={!!timelineModal}
      title={t("turnLab.processLabel")}
      subtitle={timelineModal?.ts ? absTime(timelineModal.ts) : undefined}
      onClose={() => setTimelineModal(null)}
      width={640}
    >
      {timelineModal ? (
        <TurnTimeline
          steps={timelineModal.steps}
          status="done"
          showDurations={timelineModal.steps.some((s) => typeof s.durationS === "number" && s.durationS > 0)}
          autoFollow={false}
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
          {agents.map((g) => {
            const rep = g.sessions[0];
            const name = rep.agentName || chatAgentDisplayName(g.agentId);
            const isActive = g.agentId === activeAgentId;
            // The sub-line for the agent you're viewing follows the session you've selected
            // (header switcher), mirroring the preview-fetch key; others preview their newest.
            // 行预览/行时间/点开目标都用 memo 算好的 g.previewKey（活跃=activeKey，其余=记住的
            // 选择→rep）+ g.rowTime —— 列表排序用的就是同一个值，显示、位置、点开永远一致。
            const previewKey = g.previewKey || rep.key;
            const rowTime = g.rowTime;
            // 行上的「运行中」仍只看前台会话：后台 cron/心跳跑起来不该把每个 agent 行
            // 都染成运行中（也会连带压掉红点）。后台跑没跑在切换器对应 Tab 里看。
            const st: AgentListStatus = g.attention ?? agentStatusOf(g.foreground);
            return (
              <button
                key={g.agentId}
                className={isActive ? "chat-agent is-active" : "chat-agent"}
                onClick={() => openSession(g.attentionKey || g.previewKey || g.sessions[0].key)}
                title={g.agentId}
              >
                <Avatar agentId={g.agentId} name={name} className="chat-agent__avatar" version={avatarVersion} />
                <span className="chat-agent__body">
                  <span className="chat-agent__top">
                    <span className="chat-agent__name">{name}</span>
                    {g.unread && st !== "running" ? (
                      // 红点=有「已完成」的未读回复；agent 还在「思考中」(running) 时不亮，
                      // turn 真正结束后才显示（R81.1：避免回复未完成就冒红点）。
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
                      <>
                        <FusionLoader size="sm" className="chat-thinking-dots" />
                        <span className="chat-agent__subtext">{t("chat.liveStatus.running")}</span>
                      </>
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

      <section className={`chat-conv is-board-${showSessionBoard ? sessionBoardViewMode : "chat"}`}>
        {error ? (
          <div className="chat-banner" title={error ?? undefined}>{t("chat.errorPrefix", { msg: error ? translateGatewayError(error, t) : error })}</div>
        ) : !connected ? (
          // Cold start / reconnecting: a neutral state, not an error flash.
          // 分词：冷启动是「连接中…」，掉线自愈是「连接已断开，正在重连…」——后者要让
          // 用户知道有东西在自己跑，不必刷新页面。
          <div className="chat-banner is-info">
            {everConnected ? t("chat.reconnectingBanner") : t("chat.connecting")}
          </div>
        ) : null}
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
            <div className="chat-topdock">
            <header className="chat-header">
              <Avatar agentId={agentOf(active.key)} name={sessionName(active)} className="chat-header__avatar" version={avatarVersion} editable onUploaded={() => setAvatarVersion((v) => v + 1)} />
              <div className="chat-header__id">
                <div className="chat-header__name">{sessionName(active)}</div>
                <div className="chat-header__statusline">
                {activeRunInFlight && runWaitBySession[active.key] && (
                  <ChatRunWait state={runWaitBySession[active.key]} compact />
                )}
                {(activeHeaderStatus === "reconnecting" || activeHeaderStatus === "offline") && (
                  <span className={`chat-status chat-status--${activeHeaderStatus}`}>
                    <span className="status-dot" />
                    <span className="chat-status__label">{t(`chat.liveStatus.${activeHeaderStatus}`)}</span>
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
                  onClick={() => setSessionArtifactsOpen((value) => !value)}
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
                              title={artifact.path}
                              disabled={!activeSessionArtifactResult || activeSessionArtifactResult.reason === "remote"}
                              onClick={() => { void openLocalFile(artifact.path); }}
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
                {/* 暂时隐藏沉浸模式入口，保留功能以便后续恢复。 */}
                <button hidden type="button" className="chat-headbtn" title={t("chat.immersiveEnter")} onClick={() => setImmersive(true)}>
                  <IconImmersive />
                </button>
                {showAdvancedSessionDetails ? (
                  <button
                    type="button"
                    className="chat-headbtn"
                    title={t("chat.advanced.openDetails")}
                    onClick={() => setAdvancedModalOpen(true)}
                  >
                    <IconClock />
                  </button>
                ) : null}
                <button className="chat-headbtn" disabled title={t("chat.tasksNotImplemented")}><IconCheckSquare /></button>
                <button type="button" className="chat-headbtn" title={t("chat.renameSession")} onClick={renameActiveSession}><IconPencil /></button>
                <button type="button" className="chat-headbtn" title={t("chat.deleteSession")} onClick={deleteActiveSession}><IconArchive /></button>
              </div>
            </header>

            {pinnedList.length > 0 && (() => {
              const idx = Math.min(pinNavIndex, pinnedList.length - 1);
              const cur = pinnedList[idx];
              return (
                <div className="chat-pinbar">
                  <button
                    type="button"
                    className="chat-pinbar__jump"
                    title={t("chat.jumpToPinned")}
                    onClick={() => scrollToMessage(cur.id)}
                  >
                    <span className="chat-pinbar__ico"><IconPin /></span>
                    <span className="chat-pinbar__text">{cur.text}</span>
                  </button>
                  {pinnedList.length > 1 && (
                    <>
                      <span className="chat-pinbar__count">{idx + 1}/{pinnedList.length}</span>
                      <span className="chat-pinbar__nav">
                        <button
                          type="button"
                          title={t("chat.prevPin")}
                          disabled={idx === 0}
                          onClick={() => setPinNavIndex(Math.max(0, idx - 1))}
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          title={t("chat.nextPin")}
                          disabled={idx === pinnedList.length - 1}
                          onClick={() => setPinNavIndex(Math.min(pinnedList.length - 1, idx + 1))}
                        >
                          ▼
                        </button>
                      </span>
                    </>
                  )}
                  <button type="button" className="chat-pinbar__x" title={t("chat.unpin")} onClick={() => unpinId(cur.id)}>
                    ×
                  </button>
                  <button
                    type="button"
                    className={pinnedOnly ? "chat-pinbar__toggle is-active" : "chat-pinbar__toggle"}
                    title={pinnedOnly ? t("chat.showAll") : t("chat.showPinnedOnly")}
                    aria-pressed={pinnedOnly}
                    onClick={() => setPinnedOnly((v) => !v)}
                  >
                    <IconFilter />
                  </button>
                </div>
              );
            })()}
            </div>

            <div className="chat-thread" ref={threadRef} onScroll={onThreadScroll} onWheel={onThreadWheel}
              onPointerDownCapture={cancelInitialScroll} onKeyDownCapture={cancelInitialScroll}>
              <div className="chat-thread__inner">
                {/* Earlier-history entry point. Wheel-up at the top still loads it
                    (R34), but wheel alone was undiscoverable — and unreachable on
                    touch / short threads — so idle now ALSO shows a small explicit
                    pill (only visible when scrolled to the very top, which for a
                    wiped/short session is immediately). Post-trigger states keep
                    R34's behavior: notes only after an actual attempt. */}
                {historyLoaded && activeKey && backendOfSession(activeKey) === "openclaw" && (() => {
                  const st = archive.key === activeKey ? archive : { status: "idle" as const, error: undefined as string | undefined };
                  if (st.status === "idle")
                    return (
                      <button type="button" className="chat-archive-bar is-action" onClick={maybeLoadArchive}>
                        {t("chat.archiveLoadEarlier")}
                      </button>
                    );
                  if (st.status === "loading") return <div className="chat-archive-bar is-note">{t("chat.archiveLoading")}</div>;
                  if (st.status === "empty") return <div className="chat-archive-bar is-note">{t("chat.archiveNone")}</div>;
                  if (st.status === "error")
                    return (
                      <button type="button" className="chat-archive-bar is-action" onClick={maybeLoadArchive}>
                        {t("chat.archiveRetry")}
                      </button>
                    );
                  if (st.status === "unsupported")
                    return st.error === "remote" ? <div className="chat-archive-bar is-note">{t("chat.archiveRemote")}</div> : null;
                  return null; // loaded → dividers in the thread say it all
                })()}
                {/* 后端正在恢复时，首个 history 失败只是启动竞态：沿用 composer 的中性
                    恢复提示；就绪后仍失败才展示真实错误和手动重试，避免把自愈窗口误报
                    成需要用户处理的故障。 */}
                {!historyLoaded && !historyVisible && historyError && activeConnectingHint && (
                  <div className="chat-empty">{activeConnectingHint}</div>
                )}
                {!historyLoaded && !historyVisible && historyError && !activeConnectingHint && (
                  <>
                    <div className="chat-empty">{t("chat.historyLoadFailed", { msg: historyError })}</div>
                    <button
                      type="button"
                      className="chat-archive-bar is-action"
                      onClick={() => {
                        setHistoryError(null);
                        if (activeKeyRef.current) void loadHistory(activeKeyRef.current);
                      }}
                    >
                      {t("chat.historyRetry")}
                    </button>
                  </>
                )}
                {/* Session loaded with zero stored messages (e.g. a telegram session
                    registered in sessions.json but never given a transcript) — show an
                    explicit empty-state instead of a silent blank thread. Gated on
                    historyLoaded (not loading) + !sending (not mid-first-turn). */}
                {historyLoaded && !sending && messages.length === 0 && (
                  <div className="chat-empty">{t("chat.emptyHistory")}</div>
                )}
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
                  // Footer meta: ↑input ↓output Rcache N%ctx. N%ctx = the context occupancy
                  // *at the moment this turn was sent* = that turn's prompt size
                  // (fresh input + cache read + cache write) / window. It grows down the thread
                  // as the conversation fills the window, and the latest turn's prompt EXACTLY
                  // equals the bottom session meter's basis (gateway session.totalTokens = the
                  // last turn's input+cacheRead+cacheWrite — verified live). NOT bare `input`
                  // (≈0% under prompt caching — the original bug) and NOT usage.totalTokens
                  // (that adds output ↓, so it overshoots the meter).
                  const u = last.usage;
                  const inTok = u?.input ?? u?.inputTokens ?? 0;
                  const outTok = u?.output ?? u?.outputTokens ?? 0;
                  const cacheTok = u?.cacheRead ?? 0;
                  const cacheWriteTok = u?.cacheWrite ?? 0;
                  const totalTok = u?.totalTokens ?? 0;
                  const promptTok = inTok + cacheTok + cacheWriteTok;
                  // Hermes 网关消息带服务端算好的 contextPercent（当前窗口占用），
                  // 直接用；OpenClaw 消息仍按本轮 prompt/窗口推算。
                  const ctxPctMsg =
                    u?.contextPercent != null
                      ? Math.min(Math.round(u.contextPercent), 100)
                      : ctxLimit && promptTok > 0
                        ? Math.min(Math.round((promptTok / ctxLimit) * 100), 100)
                        : null;
                  const hasMeta = inTok > 0 || outTok > 0 || cacheTok > 0 || totalTok > 0;
                  // A group whose parts are ALL hidden by the 💡/🔧 toggles (a reasoning-only
                  // or tool-only turn) would render an empty body but still show its footer
                  // (time/token/model) — a dangling meta line in the thread. Skip the whole
                  // group when nothing is visible. Pending turns + any non-blank text count.
                  const isMsgVisible = (m: ChatMsg) =>
                    m.pending ||
                    (m.images?.length ?? 0) > 0 ||
                    (m.files?.length ?? 0) > 0 ||
                    m.parts.some((p) =>
                      p.type === "canvas"
                        ? true
                        : p.type === "prompt"
                        ? !!p.promptEntry
                        : p.type === "thinking"
                        ? showThinking && !!p.text?.trim()
                        : p.type === "toolCall" || p.type === "toolResult"
                          ? showTools
                          : p.type === "timeline"
                            ? showTraj && !!p.steps?.length
                            : p.type === "plan"
                              ? !!p.planEntries?.length
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
                  const liveMessage = g.msgs.find((message) => message.pending);
                  const groupLiveSteps = liveMessage ? liveStepsFor(liveMessage) : [];
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
                              live
                              defaultOpen
                              onOpenLargeView={() => setTimelineModal({ steps: groupLiveSteps, ts: liveMessage?.ts ?? g.ts })}
                            />
                          ) : null}
                          {/* display:contents 包装不产生盒子（stack 的 flex/gap 不受影响），
                              只为右键菜单提供 data-mi 落点定位（R154 按气泡引用） */}
                          {keyedMessages.map(({ item: m, key: messageRenderKey, images: keyedImages, files: keyedFiles, parts: keyedParts }, mi) => (
                            <div key={messageRenderKey} data-mi={mi} data-message-key={messageRenderKey} style={{ display: "contents" }}>
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
                                      <span key={fileRenderKey} className="chat-att-chip chat-att-chip--file is-sent" title={attachmentChipTitle(f)}>
                                        <button type="button" className="chat-att-chip__open" onClick={() => void openAttachmentFile(f)}>
                                          <span className="chat-att-chip__file">
                                            {attachmentChipIcon(f.kind)} {f.name}
                                          </span>
                                        </button>
                                      </span>
                                    ),
                                  )}
                                </div>
                              ) : null}
                              {keyedParts.map(({ item: p, key: k }, pi) => {
                              if (p.type === "timeline") {
                                // R355:开关语义=整个 Agent Trajectory 的显示/隐藏(用户定案)。
                                // 关 → 连摘要行都不渲染;开 → 摘要行+可展开,时间线含完整过程
                                // (思考+工具,不再单独过滤思考步)。
                                if (!showTraj || !p.steps?.length) return null;
                                return <TurnProcess key={k} steps={p.steps} onOpenLargeView={() => setTimelineModal({ steps: p.steps!, ts: m.ts })} />;
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
                              // R339/R343 直播:进行中气泡的思考/工具/临时 plan parts 由消息层的
                              // 实时时间线统一呈现。OpenClaw 带 revision 的持久进度卡仍独立展示。
                              if (m.pending && (p.type === "thinking" || p.type === "toolCall" || p.type === "toolResult")) {
                                if (liveStepsFor(m).length) return null;
                              }
                              if (p.type === "plan") {
                                if (!p.planEntries?.length) return null;
                                const progress = p.planEntries.find((entry) => entry.progressRevision !== undefined);
                                if (m.pending && showTraj && !progress && liveStepsFor(m).length) return null;
                                return (
                                  <div
                                    key={k}
                                    className="chat-plan"
                                    data-progress-revision={progress?.progressRevision}
                                  >
                                    <div className="chat-plan__title">
                                      {t("chat.planTitle")}
                                      {progress?.progressRevision !== undefined ? ` · r${progress.progressRevision}` : ""}
                                    </div>
                                    {progress?.progressMarkdown ? (
                                      <ChatMarkdown
                                        className="chat-plan__text chat-md"
                                        text={progress.progressMarkdown}
                                      />
                                    ) : null}
                                    {keyedChatChildren(m, "plan-entry", p.planEntries.filter((entry) => entry.content)).map(({ item: e, key: planEntryKey }) => (
                                      <div key={planEntryKey} className={`chat-plan__item is-${e.status}`}>
                                        <span className="chat-plan__mark">
                                          {e.status === "completed" ? "✓" : e.status === "in_progress" ? "▸" : "○"}
                                        </span>
                                        <span className="chat-plan__text">{e.content}</span>
                                      </div>
                                    ))}
                                  </div>
                                );
                              }
                              if (p.type === "prompt") {
                                if (!p.promptEntry) return null;
                                return <ChatPromptCard key={k} entry={p.promptEntry} onRespond={respondPrompt} />;
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
                                // Match OpenClaw: show the call's args as the title (web_fetch →
                                // "from <url> …", web_search → 'for "<query>" …'); fall back to a
                                // plain label when a tool carries no args.
                                const title = formatToolTitle(p.toolName, p.toolArgs);
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
                                    name={
                                      title
                                        ? `${toolDisp(p.toolName)} · ${title}`
                                        : t("chat.toolCall", { tool: toolDisp(p.toolName) })
                                    }
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
                                const err = p.isError ?? m.isError;
                                const name = err
                                  ? p.toolName
                                    ? t("chat.toolErrorNamed", { tool: toolDisp(p.toolName) })
                                    : t("chat.toolError")
                                  : p.toolName
                                    ? t("chat.toolOutputNamed", { tool: toolDisp(p.toolName) })
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
                                return (
                                  <div key={k} className="chat-bubble" data-qp={pi}>
                                    {!p.text?.trim() && activeKey && runWaitBySession[activeKey] && (
                                      <ChatRunWait state={runWaitBySession[activeKey]} />
                                    )}
                                    {p.text?.trim() ? (
                                      <ChatMarkdown
                                        className="chat-md"
                                        text={p.text}
                                      />
                                    ) : null}
                                    {/* 等首字节 = 双球融合（"在思考"）；已出字 = 打字光标（"在输出"） */}
                                    {pi === m.parts.length - 1 &&
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
                                  ? extractAgentMedia(p.text)
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
                                      className="chat-bubble chat-md"
                                      data-qp={pi} /* R154：右键引用按这条气泡取文 */
                                      text={media.text}
                                    />
                                  ) : null}
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
                          {hasMeta ? (
                            <>
                              <span className="dot">·</span>
                              {inTok > 0 ? <span title={t("chat.inputTokens")}>↑{fmtTokens(inTok)}</span> : null}
                              {outTok > 0 ? <span title={t("chat.outputTokens")}>↓{fmtTokens(outTok)}</span> : null}
                              {inTok === 0 && outTok === 0 && totalTok > 0 ? (
                                <span>{fmtTokens(totalTok)} tok</span>
                              ) : null}
                              {cacheTok > 0 ? <span title={t("chat.cacheTokens")}>R{fmtTokens(cacheTok)}</span> : null}
                              {ctxPctMsg != null ? (
                                <span title={t("chat.ctxUsage")}>{ctxPctMsg}% ctx</span>
                              ) : null}
                            </>
                          ) : null}
                          {last.model && last.model !== "gateway-injected" && (
                            <>
                              <span className="dot">·</span>
                              <span>{last.model}</span>
                            </>
                          )}
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
                              <button
                                type="button"
                                className={g.msgs.some((m) => m.actionId && pinnedIds.has(m.actionId)) ? "chat-copybtn is-pinned" : "chat-copybtn"}
                                title={g.msgs.some((m) => m.actionId && pinnedIds.has(m.actionId)) ? t("chat.unpin") : t("chat.pin")}
                                onClick={() => pinGroup(g)}
                              >
                                <IconPin />
                              </button>
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

            {/* bottom dock: latest-message pill + context capsule + composer float above the full-height thread */}
            <div className="chat-botdock">
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

            <div
              className="chat-composer"
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
                        <button type="button" className="chat-att-chip__open" title={a.name}
                          onClick={() => void openAttachmentFile({ name: a.name, src: a.dataUrl })}>
                          <span className="chat-att-chip__file"><IconAttachmentFolder /> {a.name}</span>
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
                placeholder={t("chat.composerPlaceholder", { name: sessionName(active) })}
                onPaste={supportsActiveAttachments ? onPasteImages : undefined}
                onChange={(e) => composerChange(e.target.value)}
                onKeyDown={composerKeyDown}
              />
              {activeConnectingHint && (
                <div className="chat-composer__connecting" data-testid="chat-connecting-hint">
                  {activeConnectingHint}
                </div>
              )}
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
                <div className="chat-composer__left">
                  <span className={listLive ? undefined : "is-stale"}>
                    <ChatModelMenu
                      models={selectableModels}
                      activeModel={displayModel}
                      activeProvider={displayModelProvider}
                      onSelect={(id, provider) => changeModel(id, provider)}
                      loading={modelsLoading}
                      loadError={modelsError}
                      onRefresh={refreshModelMenu}
                      disabled={nativeModelSelectionDisabled}
                    />
                  </span>
                  {(activeThinkingOptions?.length || activeThinkingDefault) && (
                    <Select
                      triggerClassName="chat-pill chat-pill--select chat-pill--think"
                      popupClassName="chat-composer-select-menu"
                      value={active.thinkingLevel ?? ""}
                      onChange={(value) => { void patchSession({ thinkingLevel: value || null }, t("chat.labelThinking")); }}
                      title={t("chat.switchThinking")}
                      disabled={activeRunInFlight}
                      side="top"
                      hideIcon
                    >
                      <Option value="">{activeThinkingDefault
                        ? t("chat.thinkingInherited", { level: thinkLabel(activeThinkingDefault) }) : t("chat.defaultLevel")}</Option>
                      {(activeThinkingOptions ?? [
                        "off",
                        "minimal",
                        "low",
                        "medium",
                        "high",
                        ...(xhighSupported ? ["xhigh"] : []),
                        "adaptive",
                      ]).map((lvl) => (
                        <Option key={lvl} value={lvl}>
                          {thinkLabel(lvl)}
                        </Option>
                      ))}
                    </Select>
                  )}
                  {activeFastCapable && (
                    <button
                      type="button"
                      className={(active.fastMode ?? (activeKey ? fastByKey[activeKey] : false)) ? "chat-pill chat-pill--ghost chat-pill--fast is-active" : "chat-pill chat-pill--ghost chat-pill--fast"}
                      title={t("chat.fastHint")}
                      aria-pressed={active.fastMode ?? (activeKey ? fastByKey[activeKey] : false)}
                      onClick={toggleFast}
                      disabled={activeRunInFlight}
                    >
                      <IconFast />
                      <span>{t("chat.fastLabel")}</span>
                    </button>
                  )}
                  <ChatPermissionMenu
                    options={permissionOptions}
                    activeMode={activePermissionMode}
                    onSelect={(option) => { void changePermissionMode(option); }}
                    disabled={activeRunInFlight}
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
                  {activeRunInFlight && activeCanSteer && (
                    <button
                      type="button"
                      className="chat-iconbtn chat-send"
                      data-send-entry="composerButton"
                      onClick={() => sendController.composerButton(activeKeyRef.current, () => { void submit(); })}
                      disabled={!activeSendReady || (!input.trim() && !attachments.length)}
                      title={t(attachments.length ? "chat.send" : "chat.steerCurrentTurn")}
                    >
                      <IconSend />
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
    {menu && (
      <>
        <div
          className="chat-ctxmenu__backdrop"
          onClick={closeMenu}
          onWheel={closeMenu}
          onContextMenu={(e) => {
            e.preventDefault();
            closeMenu();
          }}
        />
        <div
          className="chat-ctxmenu"
          style={{
            left: Math.min(menu.x, window.innerWidth - 184),
            top: Math.min(menu.y, window.innerHeight - 228),
          }}
        >
          {menu.copyText && (
            <button
              type="button"
              className="chat-ctxmenu__item"
              onClick={() => {
                copyText(menu.copyText);
                closeMenu();
              }}
            >
              <IconCopy />
              <span>{t("chat.copy")}</span>
            </button>
          )}
          {!!groupSnippet(menu.group) && (
            <button
              type="button"
              className="chat-ctxmenu__item"
              onClick={() => quoteGroup(menu.group, menu.msgIndex, menu.partIndex)}
            >
              <IconQuote />
              <span>{t("chat.quote")}</span>
            </button>
          )}
          {SHOW_SESSION_FORK && menuForkEntryId && activeKey ? (
            <button
              type="button"
              className="chat-ctxmenu__item"
              disabled={runningKeys.has(activeKey)}
              onClick={() => { void forkFromEntry(activeKey, menuForkEntryId); }}
            >
              <IconFork />
              <span>{t("chat.advanced.forkHere")}</span>
            </button>
          ) : null}
          {menu.group.msgs.some((m) => m.actionId) && (
            <>
              <button
                type="button"
                className="chat-ctxmenu__item"
                onClick={() => {
                  pinGroup(menu.group);
                  closeMenu();
                }}
              >
                <IconPin />
                <span>{menu.group.msgs.some((m) => m.actionId && pinnedIds.has(m.actionId)) ? t("chat.unpin") : t("chat.pin")}</span>
              </button>
              <button
                type="button"
                className="chat-ctxmenu__item is-danger"
                onClick={() => {
                  deleteGroup(menu.group);
                  closeMenu();
                }}
              >
                <IconTrash />
                <span>{t("chat.deleteLocal")}</span>
              </button>
            </>
          )}
        </div>
      </>
    )}
    {sessionRenameTarget && <ChatSessionRenameModal
      key={sessionRenameTarget.key}
      target={sessionRenameTarget}
      onClose={() => setSessionRenameTarget(null)}
      onSubmit={(key, label) => renameSessionTo(label, key)}
    />}
    {immersive && (
        <ImmersiveChat
          onExit={() => setImmersive(false)}
          phase={immersivePhase}
          live={immersiveLive}
          sendSeq={immersiveSendSeq}
          onNearTop={maybeLoadArchive}
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
          canSteer={activeCanSteer}
          abortActive={abortActive}
          hasActiveSession={!!active}
          canSend={activeSendReady}
          connectingHint={activeConnectingHint}
          slashMenu={slashMenuNode}
          slashOpen={slashOpen}
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
          openAttachmentFile={openAttachmentFile}
          lightboxOpen={!!lightbox}
          onRespondPrompt={respondPrompt}
          messages={immersiveMessages}
          models={selectableModels}
          displayModel={displayModel}
          changeModel={changeModel}
          activeModelProvider={displayModelProvider}
          modelsLoading={modelsLoading}
          modelsError={modelsError}
          refreshModels={refreshModelMenu}
          modelSelectionDisabled={nativeModelSelectionDisabled}
          permissionOptions={permissionOptions}
          permissionMode={activePermissionMode}
          changePermissionMode={(option) => { void changePermissionMode(option); }}
          permissionSelectionDisabled={activeRunInFlight}
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
    </>
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
      connectingHint: string | null;
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
      {send.connectingHint && <div data-testid="chat-connecting-hint">{send.connectingHint}</div>}
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
          canSteer={false}
          abortActive={() => {}}
          hasActiveSession={!!snapshot.activeKey}
          canSend={send.canSend}
          connectingHint={send.connectingHint}
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
          liveStatusKind="reconnecting"
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
            connectingHint: fixtureCanSend(snapshot.activeKey)
              ? null
              : snapshot.activeKey
                ? `正在连接 ${fixtureBackendOf(snapshot.activeKey)}…`
                : null,
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
