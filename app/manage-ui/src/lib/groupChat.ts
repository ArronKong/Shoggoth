// 群聊的页面侧数据：列表经 /__api 拉取；/__chatws 的 group.changed 由 ChatPage 转成
// 窗口事件，这里和群面板各自按需重拉（事件只说「哪个群变了」，不带内容）。
import { useCallback, useEffect, useRef, useState } from "react";
import { listGroupChats } from "../api/client";
import type { GroupChatView } from "../types";
import { groupReplyBody } from "./groupReply";

export const GROUP_CHANGED_EVENT = "shoggoth:group-changed";
export type GroupChangedDetail = { groupId: string };

export function emitGroupChanged(groupId: string) {
  window.dispatchEvent(new CustomEvent<GroupChangedDetail>(GROUP_CHANGED_EVENT, { detail: { groupId } }));
}

export function onGroupChanged(listener: (groupId: string) => void): () => void {
  const handler = (event: Event) => {
    const groupId = (event as CustomEvent<GroupChangedDetail>).detail?.groupId;
    if (typeof groupId === "string") listener(groupId);
  };
  window.addEventListener(GROUP_CHANGED_EVENT, handler);
  return () => window.removeEventListener(GROUP_CHANGED_EVENT, handler);
}

// 群内部会话 key 的共享缓存：聊天页的会话列表与通知都要排除它们。
let internalKeys = new Set<string>();
let internalKeysAt = 0;
let internalKeysLoading: Promise<void> | null = null;
// 安全提取群列表；列表加载另行区分无效响应与真正的空列表。
function groupsOf(result: unknown): GroupChatView[] {
  const groups = (result as { groups?: unknown } | null)?.groups;
  return Array.isArray(groups) ? groups.filter((group) => group && typeof group === "object" && group.group) : [];
}
function keysOf(group: GroupChatView): string[] {
  return Array.isArray(group.internalSessionKeys) ? group.internalSessionKeys : [];
}
function rememberInternalKeys(groups: GroupChatView[]) {
  internalKeys = new Set(groups.flatMap(keysOf));
  internalKeysAt = Date.now();
}
/** 会话是否属于某个群的内部会话；必要时先拉一次群列表（10 秒内复用）。 */
export async function isGroupInternalSession(sessionKey: string): Promise<boolean> {
  if (Date.now() - internalKeysAt > 10_000 && !internalKeysLoading) {
    internalKeysLoading = listGroupChats(true).then((result) => rememberInternalKeys(groupsOf(result)), () => {})
      .finally(() => { internalKeysLoading = null; });
  }
  if (internalKeysLoading) await internalKeysLoading;
  return internalKeys.has(sessionKey);
}

export function useGroupChats() {
  const [groups, setGroups] = useState<GroupChatView[]>([]);
  // 设置里关闭群功能后入口隐藏；群列表仍要拉，用来把群内部会话排除出普通会话列表。
  const [enabled, setEnabled] = useState(true);
  const refreshRef = useRef<(() => Promise<void>) | null>(null);
  const refresh = useCallback(() => refreshRef.current?.() ?? Promise.resolve(), []);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: Promise<void> | null = null;
    let refreshAgain = false;
    let retryDelay = 1000;
    const clearTimer = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const schedule = (delay: number) => {
      clearTimer();
      timer = setTimeout(() => { timer = null; void load(); }, delay);
    };
    const load = (): Promise<void> => {
      if (disposed) return Promise.resolve();
      clearTimer();
      // 建群或恢复事件可能发生在旧请求途中：合并成随后的一次读取，不能丢掉。
      if (inFlight) { refreshAgain = true; return inFlight; }
      inFlight = (async () => {
        do {
          refreshAgain = false;
          try {
            const result = await listGroupChats();
            if (disposed) return;
            if (!Array.isArray(result?.groups)) throw new Error("Invalid group list response");
            const nextGroups = groupsOf(result);
            setGroups(nextGroups);
            setEnabled(result.enabled !== false);
            internalKeys = new Set([...internalKeys, ...nextGroups.flatMap(keysOf)]);
            retryDelay = 1000;
          } catch {
            // UI 可能早于 Service 就绪。失败保留原列表，并退避重试；成功后停止轮询。
            if (!disposed && !refreshAgain && timer === null) {
              schedule(retryDelay);
              retryDelay = Math.min(retryDelay * 2, 30_000);
            }
          }
        } while (!disposed && refreshAgain);
      })().finally(() => { inFlight = null; });
      return inFlight;
    };
    refreshRef.current = load;
    void load();
    const off = onGroupChanged(() => schedule(150));
    const onFocus = () => { void load(); };
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      refreshRef.current = null;
      off();
      clearTimer();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return { groups, enabled, refresh };
}

// 群聊里可加入的候选：原生 Agent 与已连接的 Hermes / OpenClaw Agent。
export const GROUP_NATIVE_BACKEND_ID = "shoggoth";
export const GROUP_MAX_MEMBERS = 32;
export const GROUP_MEMBER_BACKEND_IDS = new Set(["shoggoth", "hermes", "openclaw"]);
export type GroupCandidateAgent = { backendId: string; agentId: string; name: string; peerId?: string; connected?: boolean };

/** 群列表与面板用相同的事实区分正在回答、等待用户和待核对。 */
export function groupChatActivity(view: GroupChatView): "waiting" | "checking" | "reading" | "stopping" | "running" | "queued" | "deleting" | null {
  if (view.group.status === "deleting") return "deleting";
  if (view.pendingInteractions?.length) return "waiting";
  if (view.activeTurns.some((turn) => turn.recovery?.type === "execution")) return "checking";
  if (view.activeTurns.some((turn) => turn.recovery?.type === "result")) return "reading";
  if (view.activeTurns.some((turn) => turn.stopping)) return "stopping";
  if (view.activeTurns.length) return view.activeTurns.every(turn => turn.dispatchState === "queued" || turn.activity?.phase === "queued"
    && turn.activity.groupId === view.group.id && turn.activity.memberId === turn.memberId
    && turn.activity.opportunityId === turn.opportunityId) ? "queued" : "running";
  return view.queuedMemberIds.length ? "queued" : null;
}

/** 侧边栏群行的一行预览：需处理的状态，或最后一条消息的作者和正文。 */
export function groupChatPreview(view: GroupChatView, t: (key: string, options?: Record<string, unknown>) => string): string {
  const activity = groupChatActivity(view);
  if (activity === "queued" && view.activeTurns.some(turn => turn.queueReason === "execution_unconfirmed")) return t("groupChat.sidebar.queueBlocked");
  if (activity) return t(activity === "checking" ? "groupChat.recovery.label" : activity === "running"
    ? "chat.liveStatus.running" : `groupChat.sidebar.${activity}`);
  const message = view.lastMessage;
  if (!message) return t("groupChat.memberCount", { count: view.members.filter((member) => member.state === "active").length });
  if (message.author.kind === "system") return t("groupChat.event.updated");
  const author = message.author.kind === "user" ? t("groupChat.you")
    : view.members.find((member) => member.id === (message.author as { memberId: string }).memberId)?.displayName
      ?? t("groupChat.someMember");
  // 只发了附件的消息没有正文：预览里写出文件名。
  const text = groupReplyBody(message).replace(/\s+/gu, " ").slice(0, 80)
    || (message.attachments?.length ? t("groupChat.attach.preview", { names: message.attachments.map((item) => item.name).join("、") }) : "");
  return `${author}：${text}`;
}
