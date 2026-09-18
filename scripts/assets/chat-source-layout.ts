import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { t } from "../../i18n/index.ts";
import type { AppViewState } from "../app-view-state.ts";
import { icons } from "../icons.ts";
import { isCronSessionKey } from "../session-display.ts";
import {
  buildAgentMainSessionKey,
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../session-key.ts";
import type { GatewaySessionRow } from "../types.ts";
import { handleChatManualRefresh } from "../app-render.helpers.ts";
import { renderChatModelSelect, renderChatThinkingSelect } from "./session-controls.ts";
import { renderChatRunStatusIndicator } from "./status-indicators.ts";

const AGENT_SESSION_STORAGE_KEY = "openclaw-skin:agent-session:v1";
const SESSION_PREVIEW_STORAGE_KEY = "openclaw-skin:session-preview:v4";
const AGENT_AVATAR_STORAGE_KEY = "openclaw-skin:agent-avatar:v1";
const PREVIEW_CACHE_MAX_ENTRIES = 200;
const ALL_SESSIONS_CACHE_MS = 30_000;
const HISTORY_PREVIEW_TTL_MS = 30_000;
const MAX_AVATAR_FILE_BYTES = 10_000_000;
const AVATAR_MAX_DIMENSION = 128;
const AVATAR_JPEG_QUALITY = 0.82;

type HostState = AppViewState & { requestUpdate?: () => void };
type SwitchSessionHandler = (sessionKey: string) => void;
type SourceAgent = {
  id: string;
  name: string;
  subtitle: string;
  avatarUrl: string;
  selected: boolean;
  lastMessageAt: number;
  formattedTime: string;
  preview: string;
  latestSessionKey: string;
};
type PreviewCacheEntry = { text?: string; ts?: number; lastMsgAt?: number };

let allSessionsCache: GatewaySessionRow[] | null = null;
let allSessionsCacheAt = 0;
let allSessionsRefreshPending = false;
let lastTrackedSessionKey: string | null = null;
let avatarFileInput: HTMLInputElement | null = null;
let pendingAvatarUploadAgentId: string | null = null;
let pendingAvatarUpdateHost: HostState | null = null;
const historyPreviewPending = new Set<string>();
const historyPreviewAt = new Map<string, number>();

// renderApp 每帧都会调用这里；只在状态偏离时写回，避免无意义重渲染。
export function ensureChatSourceLayoutState(state: AppViewState): void {
  if (
    state.settings.chatFocusMode ||
    state.settings.chatAutoScroll !== "always" ||
    !state.settings.navCollapsed
  ) {
    state.applySettings({
      ...state.settings,
      chatFocusMode: false,
      chatAutoScroll: "always",
      navCollapsed: true,
    });
  }
  if (state.sessionsHideCron !== true) {
    state.sessionsHideCron = true;
    requestHostUpdate(state);
  }
  if (state.navDrawerOpen) {
    state.navDrawerOpen = false;
    requestHostUpdate(state);
  }
  if (state.chatHeaderControlsHidden) {
    state.chatHeaderControlsHidden = false;
    requestHostUpdate(state);
  }
  trackSourceSession(state);
  // 官方状态仍可能被其它入口写入较窄的 sessionsResult；每次渲染前都幂等补回全量缓存。
  mergeFullHistoryIntoSessionsResult(state);
  scheduleAllSessionsRefresh(state);
}

// Agent 面板只在多 agent 时启用，这样单 agent 页面不会留下空白左列。
export function hasChatSourceAgentPanel(state: AppViewState): boolean {
  return resolveBaseAgents(state).length > 1;
}

// 左侧 agent 列表用 Lit 模板直接输出，替代运行时 createElement/appendChild。
export function renderChatSourceAgentPanel(
  state: AppViewState,
  onSwitchSession: SwitchSessionHandler,
): TemplateResult | typeof nothing {
  const agents = enrichAndSortAgents(state);
  if (agents.length <= 1) {
    return nothing;
  }
  return html`
    <aside class="chat-agent-list-panel" aria-label="Agent list">
      <div class="chat-agent-list__header">
        <div class="chat-agent-list__title">Agent</div>
        <div class="chat-agent-list__count">${agents.length} Agent</div>
      </div>
      <div
        class="chat-agent-list__list"
        role="listbox"
        aria-label="Switch chat agent"
        @keydown=${handleAgentListKeydown}
      >
        ${repeat(
          agents,
          (agent) => agent.id,
          (agent) => renderAgentItem(state, agent, onSwitchSession),
        )}
      </div>
    </aside>
  `;
}

// Header 中的头像和 agent 名称改为源码模板输出，继续复用旧 class 和头像缓存 key。
export function renderChatSourceHeaderAgent(state: AppViewState): TemplateResult | typeof nothing {
  const agent = resolveCurrentSourceAgent(state);
  if (!agent) {
    return nothing;
  }
  return html`
    <button
      type="button"
      class="chat-agent-header-avatar"
      data-agent-id=${agent.id}
      title="Upload avatar"
      aria-label=${`Upload avatar for ${agent.name}`}
      @click=${(event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        openAvatarUpload(agent.id, state);
      }}
    >
      <span class="chat-agent-header-avatar__visual" aria-hidden="true">
        ${renderAvatarContent(agent, "chat-agent-header-avatar__visual")}
      </span>
    </button>
    <div class="chat-agent-header-name" title=${agent.name}>${agent.name}</div>
  `;
}

// Header run status 只显示当前 session 的进行中/中断状态；Done 在源码层直接不渲染。
export function renderChatSourceRunStatus(state: AppViewState): TemplateResult | typeof nothing {
  const sessionKey = String(state.sessionKey || "").trim();
  if (!sessionKey) {
    return nothing;
  }
  if (state.chatRunId || state.chatSending || state.chatStream !== null) {
    return renderChatRunStatusIndicator({ phase: "in-progress", sessionKey });
  }
  const status = state.chatRunStatus;
  if (!status || status.sessionKey !== sessionKey || status.phase === "done") {
    return nothing;
  }
  if (status.phase === "in-progress" || status.phase === "interrupted") {
    return renderChatRunStatusIndicator(status);
  }
  return nothing;
}

// 顶栏刷新按钮：源码化前由旧 skin JS 从官方 chat-controls 搬进 header，现直接渲染并复用官方刷新逻辑。
export function renderChatSourceRefresh(state: AppViewState): TemplateResult {
  const refreshLabel = t("chat.refreshTitle");
  const refreshDisabled =
    !state.connected ||
    state.chatLoading ||
    state.chatSending ||
    Boolean(state.chatRunId) ||
    state.chatStream !== null;
  return html`
    <div class="chat-controls">
      <button
        class="btn btn--sm btn--icon"
        ?disabled=${refreshDisabled}
        title=${refreshLabel}
        aria-label=${refreshLabel}
        data-tooltip=${refreshLabel}
        @click=${() =>
          void handleChatManualRefresh(
            state as unknown as Parameters<typeof handleChatManualRefresh>[0],
          )}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path>
          <path d="M21 3v5h-5"></path>
        </svg>
      </button>
    </div>
  `;
}

// Composer 左侧控件顺序：Model、Thinking Level、思考开关、工具开关。
export function renderChatSourceComposerControls(state: AppViewState): TemplateResult {
  const disableToggle = state.onboarding;
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const showToolCalls = state.onboarding ? true : state.settings.chatShowToolCalls;
  const thinkingLabel = disableToggle ? t("chat.onboardingDisabled") : t("chat.thinkingToggle");
  const toolCallsLabel = disableToggle ? t("chat.onboardingDisabled") : t("chat.toolCallsToggle");
  return html`
    ${renderChatModelSelect(state)} ${renderChatThinkingSelect(state)}
    <button
      class="btn btn--sm btn--icon ${showThinking ? "active" : ""}"
      ?disabled=${disableToggle}
      aria-pressed=${showThinking}
      title=${thinkingLabel}
      aria-label=${thinkingLabel}
      data-tooltip=${thinkingLabel}
      @click=${() => {
        if (disableToggle) {
          return;
        }
        state.applySettings({
          ...state.settings,
          chatShowThinking: !state.settings.chatShowThinking,
        });
      }}
    >
      ${icons.brain}
    </button>
    <button
      class="btn btn--sm btn--icon ${showToolCalls ? "active" : ""}"
      ?disabled=${disableToggle}
      aria-pressed=${showToolCalls}
      title=${toolCallsLabel}
      aria-label=${toolCallsLabel}
      data-tooltip=${toolCallsLabel}
      @click=${() => {
        if (disableToggle) {
          return;
        }
        state.applySettings({
          ...state.settings,
          chatShowToolCalls: !state.settings.chatShowToolCalls,
        });
      }}
    >
      ${icons.wrench}
    </button>
  `;
}

function requestHostUpdate(state: AppViewState): void {
  (state as HostState).requestUpdate?.();
}

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

// localStorage 读取统一容错，隐私模式或 data: 测试夹具下不可用时回退空对象。
function readJsonStorage(key: string): Record<string, unknown> {
  try {
    const raw = safeStorage()?.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function writeJsonStorage(key: string, value: Record<string, unknown>): void {
  try {
    safeStorage()?.setItem(key, JSON.stringify(value));
  } catch {
    // 缓存写入失败不影响聊天主路径。
  }
}

function loadAgentSessionMap(): Record<string, string> {
  const raw = readJsonStorage(AGENT_SESSION_STORAGE_KEY);
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && value.trim()) {
      next[key] = value;
    }
  }
  return next;
}

function saveAgentSession(agentId: string, sessionKey: string): void {
  const id = normalizeAgentId(agentId);
  const key = String(sessionKey || "").trim();
  if (!id || !key) {
    return;
  }
  const map = loadAgentSessionMap();
  if (map[id] === key) {
    return;
  }
  map[id] = key;
  writeJsonStorage(AGENT_SESSION_STORAGE_KEY, map);
}

// 记忆归属优先从真实 sessionKey 解析，避免 agent 切换中间态覆盖用户记忆。
function saveSessionForResolvedAgent(state: AppViewState, sessionKey: string): void {
  const parsed = parseAgentSessionKey(sessionKey);
  const fallback = resolveActiveAgentId(state);
  saveAgentSession(parsed?.agentId ?? fallback, sessionKey);
}

function loadPreviewCache(): Record<string, PreviewCacheEntry> {
  const raw = readJsonStorage(SESSION_PREVIEW_STORAGE_KEY);
  const next: Record<string, PreviewCacheEntry> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    next[key] = value as PreviewCacheEntry;
  }
  return next;
}

function prunePreviewCache(
  cache: Record<string, PreviewCacheEntry>,
  maxEntries: number,
): Record<string, PreviewCacheEntry> {
  const keys = Object.keys(cache);
  if (keys.length <= maxEntries) {
    return cache;
  }
  const kept = keys
    .map((key) => [key, cache[key]?.ts ?? 0] as const)
    .toSorted((left, right) => right[1] - left[1])
    .slice(0, maxEntries);
  const next: Record<string, PreviewCacheEntry> = {};
  for (const [key] of kept) {
    const value = cache[key];
    if (value) {
      next[key] = value;
    }
  }
  return next;
}

// 预览缓存必须有界，否则会顶满 localStorage 并连带影响头像 dataURL 保存。
function saveSessionPreview(
  sessionKey: string,
  text: string,
  timestamp: number,
  lastMsgAt?: number,
): void {
  const key = String(sessionKey || "").trim();
  const preview = truncatePreview(text);
  if (!key || !preview) {
    return;
  }
  const cache = loadPreviewCache();
  const existing = cache[key];
  const nextLastMsgAt =
    Number.isFinite(lastMsgAt) && Number(lastMsgAt) > 0 ? Number(lastMsgAt) : existing?.lastMsgAt;
  if (
    existing?.text === preview &&
    existing?.ts === timestamp &&
    existing?.lastMsgAt === nextLastMsgAt
  ) {
    return;
  }
  cache[key] = { text: preview, ts: timestamp || Date.now(), lastMsgAt: nextLastMsgAt };
  writeJsonStorage(SESSION_PREVIEW_STORAGE_KEY, prunePreviewCache(cache, PREVIEW_CACHE_MAX_ENTRIES));
}

function cachedLastMsgAt(sessionKey: string): number {
  const value = loadPreviewCache()[String(sessionKey || "").trim()]?.lastMsgAt;
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : 0;
}

function effectiveSessionTime(session: GatewaySessionRow | undefined): number {
  if (!session) {
    return 0;
  }
  const real = cachedLastMsgAt(session.key);
  return real > 0 ? real : (session.updatedAt ?? 0);
}

function scheduleAllSessionsRefresh(state: AppViewState): void {
  if (allSessionsRefreshPending) {
    return;
  }
  if (allSessionsCache && Date.now() - allSessionsCacheAt < ALL_SESSIONS_CACHE_MS) {
    return;
  }
  const client = state.client as {
    request?: (method: string, params?: unknown) => Promise<unknown>;
  } | null;
  if (!state.connected || typeof client?.request !== "function") {
    allSessionsCacheAt = 0;
    return;
  }
  allSessionsRefreshPending = true;
  client
    .request("sessions.list", {
      includeGlobal: state.sessionsIncludeGlobal ?? true,
      includeUnknown: state.sessionsIncludeUnknown ?? true,
      configuredAgentsOnly: true,
      limit: 500,
    })
    .then((result) => {
      const sessions = (result as { sessions?: unknown[] } | null)?.sessions;
      allSessionsCache = Array.isArray(sessions) ? (sessions as GatewaySessionRow[]) : [];
      allSessionsCacheAt = Date.now();
      mergeFullHistoryIntoSessionsResult(state);
      requestHostUpdate(state);
    })
    .catch((error: unknown) => {
      allSessionsCacheAt = 0;
      console.warn("[chat-source-layout] sessions.list failed; keeping last cache", error);
    })
    .finally(() => {
      allSessionsRefreshPending = false;
    });
}

// 官方 active session 列表可能只有 120 分钟窗口；源码层把*全部* agent 的完整历史并回去。
// 只回填 active agent 会导致：用户切到另一个 agent 时它的历史也被 120-min slice 截短，
// 直到下一次 30s allSessionsCache 刷新才能恢复。这里改成遍历所有已知 agent。
function mergeFullHistoryIntoSessionsResult(state: AppViewState): void {
  if (!state.sessionsResult || !allSessionsCache?.length) {
    return;
  }
  const existing = Array.isArray(state.sessionsResult.sessions) ? state.sessionsResult.sessions : [];
  const existingKeys = new Set(existing.map((session) => session.key));
  const agentIds = new Set<string>();
  const activeAgentId = resolveActiveAgentId(state);
  if (activeAgentId) {
    agentIds.add(activeAgentId);
  }
  for (const agent of state.agentsList?.agents ?? []) {
    const id = normalizeAgentId(agent.id);
    if (id) {
      agentIds.add(id);
    }
  }
  const missing: GatewaySessionRow[] = [];
  for (const agentId of agentIds) {
    for (const session of getAgentSessions(state, agentId)) {
      if (!existingKeys.has(session.key)) {
        existingKeys.add(session.key);
        missing.push(session);
      }
    }
  }
  if (!missing.length) {
    return;
  }
  state.sessionsResult = {
    ...state.sessionsResult,
    sessions: [...existing, ...missing],
  };
}

function getKnownSessions(state: AppViewState): GatewaySessionRow[] {
  return allSessionsCache?.length ? allSessionsCache : (state.sessionsResult?.sessions ?? []);
}

function resolveActiveAgentId(state: AppViewState): string {
  return normalizeAgentId(
    parseAgentSessionKey(state.sessionKey)?.agentId ?? state.agentsList?.defaultId ?? "main",
  );
}

function defaultSessionKeyForAgent(agentId: string): string {
  return buildAgentMainSessionKey({ agentId: normalizeAgentId(agentId) || "main" });
}

function isDreamingSessionKey(sessionKey: string): boolean {
  const value = String(sessionKey || "").trim();
  if (value.startsWith("dreaming-narrative-")) {
    return true;
  }
  return Boolean(parseAgentSessionKey(value)?.rest?.startsWith("dreaming-narrative-"));
}

function sessionBelongsToAgent(
  state: AppViewState,
  session: GatewaySessionRow,
  agentId: string,
): boolean {
  const targetId = normalizeAgentId(agentId);
  const parsed = parseAgentSessionKey(session.key);
  if (parsed) {
    return normalizeAgentId(parsed.agentId) === targetId;
  }
  return targetId === normalizeAgentId(state.agentsList?.defaultId ?? "main");
}

function getAgentSessions(state: AppViewState, agentId: string): GatewaySessionRow[] {
  const hideCron = state.sessionsHideCron !== false;
  return getKnownSessions(state).filter((session) => {
    if (!sessionBelongsToAgent(state, session, agentId)) {
      return false;
    }
    if (session.kind === "global" || session.kind === "unknown") {
      return false;
    }
    if (hideCron && isCronSessionKey(session.key)) {
      return false;
    }
    if (isSubagentSessionKey(session.key) || session.spawnedBy) {
      return false;
    }
    if (isDreamingSessionKey(session.key)) {
      return false;
    }
    return true;
  });
}

function findLatestSessionForAgent(state: AppViewState, agentId: string): GatewaySessionRow | null {
  const sessions = getAgentSessions(state, agentId);
  if (!sessions.length) {
    return null;
  }
  return sessions.toSorted((left, right) => effectiveSessionTime(right) - effectiveSessionTime(left))[0] ?? null;
}

function isValidSessionForAgent(state: AppViewState, sessionKey: string, agentId: string): boolean {
  return getAgentSessions(state, agentId).some((session) => session.key === sessionKey);
}

// agent 切换优先顺序保持旧行为：记忆 session -> 最新 session -> agent main session。
function resolveSessionForAgent(state: AppViewState, agentId: string): string {
  const normalized = normalizeAgentId(agentId);
  const remembered = loadAgentSessionMap()[normalized];
  if (remembered && isValidSessionForAgent(state, remembered, normalized)) {
    return remembered;
  }
  const latest = findLatestSessionForAgent(state, normalized)?.key;
  return latest || defaultSessionKeyForAgent(normalized);
}

function trackSourceSession(state: AppViewState): void {
  const sessionKey = String(state.sessionKey || "").trim();
  if (!sessionKey) {
    return;
  }
  if (sessionKey !== lastTrackedSessionKey) {
    lastTrackedSessionKey = sessionKey;
    saveSessionForResolvedAgent(state, sessionKey);
  }
  const live = pickLastMessage(state.chatMessages);
  if (live.text) {
    const row = getKnownSessions(state).find((session) => session.key === sessionKey);
    saveSessionPreview(sessionKey, live.text, row?.updatedAt ?? Date.now(), live.at || undefined);
  }
}

function ensureSessionMessagePreview(state: AppViewState, sessionKey: string, updatedAt: number): void {
  const key = String(sessionKey || "").trim();
  if (!key || historyPreviewPending.has(key)) {
    return;
  }
  const cached = loadPreviewCache()[key];
  const fresh =
    cached?.text &&
    (cached.ts ?? 0) >= (updatedAt ?? 0) &&
    Number.isFinite(cached.lastMsgAt) &&
    Number(cached.lastMsgAt) > 0;
  if (fresh || Date.now() - (historyPreviewAt.get(key) ?? 0) < HISTORY_PREVIEW_TTL_MS) {
    return;
  }
  const client = state.client as {
    request?: (method: string, params?: unknown) => Promise<unknown>;
  } | null;
  if (typeof client?.request !== "function") {
    return;
  }
  historyPreviewPending.add(key);
  historyPreviewAt.set(key, Date.now());
  client
    .request("chat.history", { sessionKey: key, limit: 20, maxChars: 2000 })
    .then((result) => {
      const messages = (result as { messages?: unknown[] } | null)?.messages;
      const picked = pickLastMessage(Array.isArray(messages) ? messages : []);
      if (picked.text) {
        saveSessionPreview(key, picked.text, updatedAt || Date.now(), picked.at);
        requestHostUpdate(state);
      }
    })
    .catch(() => {})
    .finally(() => {
      historyPreviewPending.delete(key);
    });
}

function getAgentActivity(
  state: AppViewState,
  agentId: string,
): Pick<SourceAgent, "lastMessageAt" | "preview" | "latestSessionKey"> {
  const sessions = getAgentSessions(state, agentId);
  if (!sessions.length) {
    return { lastMessageAt: 0, preview: "", latestSessionKey: defaultSessionKeyForAgent(agentId) };
  }
  for (const session of sessions) {
    ensureSessionMessagePreview(state, session.key, session.updatedAt ?? 0);
  }
  const activeKey = String(state.sessionKey || "").trim();
  let chosen: GatewaySessionRow | undefined;
  if (activeKey && normalizeAgentId(agentId) === resolveActiveAgentId(state)) {
    chosen =
      sessions.find((session) => session.key === activeKey) ??
      getKnownSessions(state).find((session) => session.key === activeKey);
  }
  if (!chosen) {
    const remembered = resolveSessionForAgent(state, agentId);
    chosen =
      sessions.find((session) => session.key === remembered) ??
      sessions.toSorted((left, right) => effectiveSessionTime(right) - effectiveSessionTime(left))[0];
  }
  const key = chosen?.key ?? defaultSessionKeyForAgent(agentId);
  return {
    lastMessageAt: effectiveSessionTime(chosen),
    preview: getSessionPreview(state, key),
    latestSessionKey: key,
  };
}

function resolveBaseAgents(state: AppViewState): SourceAgent[] {
  const seen = new Set<string>();
  const agents: SourceAgent[] = [];
  const add = (agentId: string, name?: string, subtitle?: string, avatarUrl?: string) => {
    const id = normalizeAgentId(agentId);
    if (!id || seen.has(id)) {
      return;
    }
    seen.add(id);
    const displayName = String(name || "").trim() || id;
    agents.push({
      id,
      name: displayName,
      subtitle: String(subtitle || id).trim() || id,
      avatarUrl: resolveAvatarUrl(id, avatarUrl),
      selected: id === resolveActiveAgentId(state),
      lastMessageAt: 0,
      formattedTime: "",
      preview: "",
      latestSessionKey: defaultSessionKeyForAgent(id),
    });
  };

  const defaultId = state.agentsList?.defaultId ?? "main";
  add(defaultId, defaultId, defaultId);
  for (const agent of state.agentsList?.agents ?? []) {
    add(
      agent.id,
      agent.identity?.name ?? agent.name ?? agent.id,
      agent.id,
      agent.identity?.avatarUrl,
    );
  }
  add(resolveActiveAgentId(state));
  return agents;
}

function enrichAndSortAgents(state: AppViewState): SourceAgent[] {
  return resolveBaseAgents(state)
    .map((agent) => {
      const activity = getAgentActivity(state, agent.id);
      return {
        ...agent,
        lastMessageAt: activity.lastMessageAt,
        formattedTime: formatMessageTime(activity.lastMessageAt),
        preview: activity.preview,
        latestSessionKey: activity.latestSessionKey,
      };
    })
    .toSorted((left, right) => {
      const delta = (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0);
      if (delta !== 0) {
        return delta;
      }
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    });
}

function resolveCurrentSourceAgent(state: AppViewState): SourceAgent | null {
  const activeId = resolveActiveAgentId(state);
  return enrichAndSortAgents(state).find((agent) => agent.id === activeId) ?? null;
}

function renderAgentItem(
  state: AppViewState,
  agent: SourceAgent,
  onSwitchSession: SwitchSessionHandler,
): TemplateResult {
  return html`
    <button
      type="button"
      class="chat-agent-list__item ${agent.selected ? "chat-agent-list__item--active" : ""}"
      data-agent-id=${agent.id}
      role="option"
      aria-selected=${agent.selected ? "true" : "false"}
      title=${`${agent.name} (${agent.id})`}
      @click=${() => switchSourceAgent(state, agent.id, onSwitchSession)}
    >
      <span class="chat-agent-list__avatar">
        ${renderAvatarContent(agent, "chat-agent-list__avatar")}
      </span>
      <span class="chat-agent-list__body">
        <span class="chat-agent-list__top">
          <span class="chat-agent-list__name">${agent.name}</span>
          <span class="chat-agent-list__time">${agent.formattedTime}</span>
        </span>
        <span class="chat-agent-list__preview">${agent.preview || agent.subtitle}</span>
      </span>
    </button>
  `;
}

function switchSourceAgent(
  state: AppViewState,
  agentId: string,
  onSwitchSession: SwitchSessionHandler,
): void {
  if (normalizeAgentId(agentId) === resolveActiveAgentId(state)) {
    return;
  }
  const currentKey = String(state.sessionKey || "").trim();
  if (currentKey) {
    saveSessionForResolvedAgent(state, currentKey);
  }
  const nextSession = resolveSessionForAgent(state, agentId);
  saveAgentSession(agentId, nextSession);
  onSwitchSession(nextSession);
}

function handleAgentListKeydown(event: KeyboardEvent): void {
  const keys = ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End", "Enter", " "];
  if (!keys.includes(event.key)) {
    return;
  }
  const host = event.currentTarget as HTMLElement | null;
  const buttons = Array.from(host?.querySelectorAll<HTMLButtonElement>(".chat-agent-list__item") ?? []);
  const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === "Enter" || event.key === " ") {
    if (document.activeElement && buttons.includes(document.activeElement as HTMLButtonElement)) {
      event.preventDefault();
      (document.activeElement as HTMLButtonElement).click();
    }
    return;
  }
  event.preventDefault();
  let nextIndex = currentIndex < 0 ? 0 : currentIndex;
  if (event.key === "ArrowDown" || event.key === "ArrowRight") {
    nextIndex = Math.min(buttons.length - 1, nextIndex + 1);
  } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
    nextIndex = Math.max(0, nextIndex - 1);
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = buttons.length - 1;
  }
  buttons[nextIndex]?.focus();
}

function renderAvatarContent(agent: SourceAgent, fallbackClass: string): TemplateResult {
  if (agent.avatarUrl) {
    return html`<img src=${agent.avatarUrl} alt="" loading="lazy" referrerpolicy="no-referrer" />`;
  }
  return html`<span class="${fallbackClass}--fallback">${getInitial(agent.name || agent.id)}</span>`;
}

function getInitial(value: string): string {
  return Array.from(String(value || "A").trim())[0]?.toLocaleUpperCase() || "A";
}

function loadAgentAvatarMap(): Record<string, string> {
  const raw = readJsonStorage(AGENT_AVATAR_STORAGE_KEY);
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && value.trim()) {
      next[key] = value;
    }
  }
  return next;
}

function saveAgentAvatarMap(map: Record<string, string>): boolean {
  const storage = safeStorage();
  if (!storage) {
    return false;
  }
  const payload = JSON.stringify(map);
  try {
    storage.setItem(AGENT_AVATAR_STORAGE_KEY, payload);
    return true;
  } catch (error) {
    try {
      writeJsonStorage(SESSION_PREVIEW_STORAGE_KEY, prunePreviewCache(loadPreviewCache(), 50));
      storage.setItem(AGENT_AVATAR_STORAGE_KEY, payload);
      return true;
    } catch (retryError) {
      console.warn(
        "[chat-source-layout] agent avatar save failed after pruning preview cache",
        retryError ?? error,
      );
      return false;
    }
  }
}

function getSkinAvatarUrl(agentId: string): string {
  return loadAgentAvatarMap()[normalizeAgentId(agentId)]?.trim() ?? "";
}

function resolveAvatarUrl(agentId: string, identityAvatarUrl?: string): string {
  return getSkinAvatarUrl(agentId) || String(identityAvatarUrl || "").trim();
}

function setSkinAvatarUrl(agentId: string, dataUrl: string): boolean {
  const map = loadAgentAvatarMap();
  const id = normalizeAgentId(agentId);
  if (!id) {
    return false;
  }
  if (dataUrl) {
    map[id] = dataUrl;
  } else {
    delete map[id];
  }
  return saveAgentAvatarMap(map);
}

function openAvatarUpload(agentId: string, state: AppViewState): void {
  pendingAvatarUploadAgentId = agentId;
  pendingAvatarUpdateHost = state as HostState;
  getAvatarFileInput().click();
}

function getAvatarFileInput(): HTMLInputElement {
  if (avatarFileInput && document.body.contains(avatarFileInput)) {
    return avatarFileInput;
  }
  avatarFileInput = document.createElement("input");
  avatarFileInput.type = "file";
  avatarFileInput.accept = "image/*";
  avatarFileInput.setAttribute("data-skin-avatar-input", "true");
  avatarFileInput.style.display = "none";
  avatarFileInput.addEventListener("change", onAvatarFileInputChange);
  document.body.appendChild(avatarFileInput);
  return avatarFileInput;
}

function onAvatarFileInputChange(event: Event): void {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0] ?? null;
  input.value = "";
  const agentId = pendingAvatarUploadAgentId;
  pendingAvatarUploadAgentId = null;
  if (!file || !agentId) {
    return;
  }
  compressImageFile(file)
    .then((dataUrl) => {
      if (!setSkinAvatarUrl(agentId, dataUrl)) {
        throw new Error("Avatar cache quota exceeded");
      }
      pendingAvatarUpdateHost?.requestUpdate?.();
    })
    .catch((error: unknown) => {
      console.warn("[chat-source-layout] avatar upload failed", error);
      window.alert(`Avatar upload failed: ${error instanceof Error ? error.message : String(error)}`);
    });
}

// 头像先压到 128px JPEG，避免旧缓存 key 写入过大的 dataURL。
function compressImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error("Please pick an image file."));
      return;
    }
    if (file.size > MAX_AVATAR_FILE_BYTES) {
      reject(new Error("Image is too large."));
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.addEventListener("load", () => {
      URL.revokeObjectURL(objectUrl);
      const maxSide = Math.max(image.naturalWidth, image.naturalHeight) || 1;
      const scale = Math.min(1, AVATAR_MAX_DIMENSION / maxSide);
      const width = Math.max(1, Math.round(image.naturalWidth * scale));
      const height = Math.max(1, Math.round(image.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("Cannot process image."));
        return;
      }
      context.drawImage(image, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/jpeg", AVATAR_JPEG_QUALITY);
      if (!dataUrl.startsWith("data:image/")) {
        reject(new Error("Cannot generate avatar data."));
        return;
      }
      resolve(dataUrl);
    });
    image.addEventListener("error", () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Cannot read image."));
    });
    image.src = objectUrl;
  });
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatMessageTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "";
  }
  const date = new Date(timestamp);
  const now = new Date();
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  const monthDay = `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())}`;
  if (date.toDateString() === now.toDateString()) {
    return time;
  }
  if (date.getFullYear() === now.getFullYear()) {
    return `${monthDay} ${time}`;
  }
  return `${date.getFullYear()}/${monthDay} ${time}`;
}

function truncatePreview(text: string, maxLength = 72): string {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function getSessionPreview(state: AppViewState, sessionKey: string): string {
  const cached = loadPreviewCache()[sessionKey];
  if (cached?.text) {
    return cached.text;
  }
  if (state.sessionKey === sessionKey) {
    const live = pickLastMessage(state.chatMessages).text;
    if (live) {
      return truncatePreview(live);
    }
  }
  const session = getKnownSessions(state).find((item) => item.key === sessionKey);
  return truncatePreview(session?.label || session?.displayName || "");
}

function parseMsgTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function extractMessageText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const record = message as Record<string, unknown>;
  const content = record.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && (part as Record<string, unknown>).type === "text"
          ? String((part as Record<string, unknown>).text ?? "")
          : "",
      )
      .join(" ");
  }
  return typeof record.text === "string" ? record.text : "";
}

function pickLastMessage(messages: unknown[]): { text: string; at: number } {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as Record<string, unknown>;
    const role = String(record.role || "").trim().toLowerCase();
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const text = extractMessageText(record).replace(/\s+/g, " ").trim();
    if (text) {
      return {
        text,
        at: parseMsgTimestamp(record.timestamp ?? record.ts ?? record.createdAt),
      };
    }
  }
  return { text: "", at: 0 };
}
