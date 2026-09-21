import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { getBoards, getConfig, getInspiration, getTask, getTaskBoard, listCronJobs, listInspirations } from "../api/client";
import type { NotificationPrefs } from "../types";
import { useToast } from "./ui";
import { useEnabledBackends } from "../lib/backends";
import { createAgentNameIndex, findAgentDisplayName, type AgentNameSource } from "../lib/agentDisplay";
import { usesExplicitBoardIdentity } from "../lib/shoggothDomainUi";
import { inspirationNotificationStatus, readInspirationNotifications, type InspirationNotificationSnapshot } from "../lib/inspiration-notifications";
import {
  agentOf,
  chatNotificationFor,
  fireNotification,
  onOpenTarget,
  snippet,
  type NotifyCategory,
  type NotifyTarget,
  type TaskNotificationTarget,
} from "../lib/notify";

// App-level, always-mounted notification driver. Lives OUTSIDE the router so it
// survives page switches (ChatPage — the only other /__chatws consumer —
// unmounts and drops its socket when you navigate away). This is the SINGLE
// source of desktop notifications; ChatPage never fires them.
//
//  - chat  → realtime: its own /__chatws subscription, on each `chat` final from
//            a UI-driven session.
//  - cron  → polled: listCronJobs(), notify when a job's lastRunAt advances.
//  - task  → polled: backend boards and Inspiration, notify on new items / state changes.
//
// All categories default on; cron/task poll only while their toggle is on. Suppression (don't
// notify while the window is focused) + the authoritative toggle check live in
// the Electron main process; the Web fallback re-checks focus itself.

const POLL_MS = 30000;
const PENDING_CHAT_KEY = "openclaw.pendingChatSession";
const DEFAULT_PREFS: NotificationPrefs = { chat: true, cron: true, task: true };
let navigationSequence = 0;

async function navigateForTarget(category: NotifyCategory, target: NotifyTarget | null, unavailable: (failed: boolean) => void) {
  const sequence = ++navigationSequence;
  if (category === "chat" && typeof target === "string" && target) {
    try {
      sessionStorage.setItem(PENDING_CHAT_KEY, target);
    } catch {
      /* ignore */
    }
    window.location.hash = "#/chat";
    // If ChatPage is already mounted, nudge it to open the session now.
    window.dispatchEvent(new CustomEvent("openclaw:open-chat-session", { detail: target }));
  } else if (category === "cron") {
    const jobId = typeof target === "string" ? target : target?.kind === "cron" ? target.jobId : null;
    const backendId = typeof target === "object" && target?.kind === "cron" ? target.backendId : null;
    // Each click can reopen the same task after its detail modal was dismissed.
    window.location.hash = jobId ? `#/cron?job=${encodeURIComponent(jobId)}${backendId ? `&backend=${encodeURIComponent(backendId)}` : ""}&notification=${sequence}` : "#/cron";
  } else if (category === "task") {
    if (typeof target === "string" && target.startsWith("inspiration:")) {
      window.location.hash = `#/inspirations?id=${encodeURIComponent(target.slice("inspiration:".length))}`;
      return;
    }
    if (typeof target === "object" && target?.kind === "task") {
      try {
        let sessionKey = target.sessionKey;
        if (!sessionKey) {
          const task = await getTask(target.backendId, target.taskId, target.boardId);
          sessionKey = task.sessionKey || task.execution?.sessionKey;
        }
        if (sequence !== navigationSequence) return;
        if (sessionKey) {
          window.location.hash = `#/chat?backend=${encodeURIComponent(target.backendId)}&session=${encodeURIComponent(sessionKey)}`;
          return;
        }
      } catch {
        if (sequence === navigationSequence) unavailable(true);
        return;
      }
    }
    unavailable(false);
  }
}

export default function Notifier() {
  const { t } = useTranslation();
  const toast = useToast();
  const kanbanBackends = useEnabledBackends("kanban");
  const tRef = useRef(t);
  tRef.current = t;
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const navigate = (category: NotifyCategory, target: NotifyTarget | null) => navigateForTarget(category, target, failed => {
    if (failed) toastRef.current.error(tRef.current("notif.taskSessionFailed"));
    else toastRef.current.info(tRef.current("notif.taskSessionUnavailable"));
  });

  const prefsRef = useRef<NotificationPrefs>(DEFAULT_PREFS);
  const prefsReadyRef = useRef(false);
  const prefsGeneration = useRef(0);
  const pollRef = useRef<(() => void) | null>(null);

  // Load the live notification prefs (config-store is the source).
  //
  // Don't assume a config save reloads the window: Electron's applyConfigChange only
  // reloads when gateway/hermes connections change, so toggling a notification (or the
  // theme) leaves this component mounted with stale prefs — and the cron/task polls
  // are gated on prefsRef, so they'd never even start. SettingsPage emits
  // `openclaw:config-changed` on every save; focus is cheap insurance on top.
  useEffect(() => {
    let alive = true;
    let sequence = 0;
    const load = () => {
      const request = ++sequence;
      return getConfig()
        .then((c) => {
          if (!alive || request !== sequence) return;
          const next = { ...DEFAULT_PREFS, ...c.notifications };
          if ((Object.keys(DEFAULT_PREFS) as Array<keyof NotificationPrefs>).some(key => next[key] !== prefsRef.current[key])) {
            prefsGeneration.current += 1;
          }
          prefsRef.current = next;
          prefsReadyRef.current = true;
          pollRef.current?.();
        })
        .catch(() => {});
    };
    load();
    const onFocus = () => load();
    const onConfigChanged = () => load();
    window.addEventListener("focus", onFocus);
    window.addEventListener("openclaw:config-changed", onConfigChanged);
    return () => {
      alive = false;
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("openclaw:config-changed", onConfigChanged);
    };
  }, []);

  // Click-through from a native (main-process) notification → navigate.
  useEffect(() => onOpenTarget((p) => { void navigate(p.category, p.target); }), []);

  // --- chat: realtime /__chatws subscription -------------------------------
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closedByUs = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reqId = 0;
    const seen = new Set<string>(); // dedup chat finals by sessionKey:ts
    let agentNames = createAgentNameIndex([]);
    let pendingNames: { id: string; promise: Promise<void>; finish: () => void } | null = null;

    // Use the same federated roster as ChatPage, keyed by the full routing id
    // (not a backend-local id). Refresh before delivery so renames take effect
    // even while the always-mounted Notifier is on another page.
    const refreshAgentNames = (): Promise<void> => {
      if (pendingNames) return pendingNames.promise;
      if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve();
      const id = `notif-agents-${++reqId}`;
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      const finish = () => {
        clearTimeout(timer);
        if (pendingNames?.id === id) pendingNames = null;
        resolve();
      };
      // Name lookup must not swallow a reply when the gateway is unavailable.
      const timer = setTimeout(finish, 3000);
      pendingNames = { id, promise, finish };
      try {
        ws.send(JSON.stringify({ type: "req", id, method: "agents.list", params: {} }));
      } catch {
        finish();
      }
      return promise;
    };

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${proto}://${location.host}/__chatws`);
      ws = socket;
      socket.onopen = () => {
        reqId += 1;
        try {
          ws?.send(JSON.stringify({ type: "req", id: `notif-sub-${reqId}`, method: "sessions.subscribe", params: {} }));
        } catch {
          /* ignore */
        }
        void refreshAgentNames();
      };
      socket.onmessage = (ev) => {
        if (closedByUs || ws !== socket) return;
        let f: { type?: string; id?: string; ok?: boolean; event?: string;
          payload?: { agents?: AgentNameSource[]; state?: string; sessionKey?: string; message?: unknown } };
        try {
          f = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (f.type === "res" && f.id === pendingNames?.id) {
          if (f.ok && Array.isArray(f.payload?.agents)) {
            // Preserve known names through a partial/degraded roster, as Chat
            // does for session rows, while current names override old values.
            agentNames = { ...agentNames, ...createAgentNameIndex(f.payload.agents.map(row => ({
              id: row?.id, name: row?.name, identity: row?.identity,
            }))) };
          }
          pendingNames?.finish();
          return;
        }
        if (f.type === "event" && f.event === "agents.changed") {
          void refreshAgentNames();
          return;
        }
        if (f.type !== "event" || f.event !== "chat" || f.payload?.state !== "final") return;
        const sk = f.payload.sessionKey;
        const msg = f.payload.message as { timestamp?: number } | undefined;
        if (!sk) return;
        const dedup = `${sk}:${msg?.timestamp ?? ""}`;
        if (seen.has(dedup)) return;
        seen.add(dedup);
        if (seen.size > 200) seen.delete(seen.values().next().value as string);
        if (!prefsReadyRef.current || !prefsRef.current.chat) return;
        const payload = chatNotificationFor(msg, sk);
        if (!payload) return;
        const generation = prefsGeneration.current;
        void refreshAgentNames().then(() => {
          if (closedByUs || !prefsRef.current.chat || generation !== prefsGeneration.current) return;
          const title = findAgentDisplayName(agentNames, agentOf(sk)) || payload.title;
          void fireNotification({ ...payload, title }, { onClick: () => { void navigate("chat", sk); } });
        });
      };
      socket.onclose = () => {
        if (ws !== socket) return;
        pendingNames?.finish();
        if (closedByUs) return;
        reconnectTimer = setTimeout(connect, 4000);
      };
      socket.onerror = () => {
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      };
    };
    connect();
    return () => {
      closedByUs = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      pendingNames?.finish();
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    };
  }, []);

  // --- cron + task: polled, only while their toggle is on ------------------
  useEffect(() => {
    let alive = true;
    const cronLastRun = new Map<string, number>();
    const taskState = new Map<string, { column: string; title: string }>();
    // 按后端分别记「已建立基线」。整体一个 taskSeeded 会在首轮某后端拿不到看板时
    // 就把它标成已 seed，下一轮它的任务全成了「新任务」。
    const taskSeeded = new Set<string>();
    let cronSeeded = false;
    let inspirationSnapshot: InspirationNotificationSnapshot | null = null;
    let cronPending = false, taskPending = false, inspirationPending = false;

    const pollCron = async () => {
      if (cronPending) return;
      cronPending = true;
      const generation = prefsGeneration.current;
      try {
        const jobs = await listCronJobs();
        if (!alive || !prefsRef.current.cron || generation !== prefsGeneration.current) return;
        for (const j of jobs) {
          const last = j.lastRunAt ?? 0;
          const prev = cronLastRun.get(j.id);
          cronLastRun.set(j.id, last);
          // Notify only when a KNOWN job's run timestamp advances (seed silently;
          // a brand-new job that already ran is not announced).
          if (cronSeeded && prev !== undefined && last > prev) {
            const status = j.lastStatus ? ` · ${j.lastStatus}` : "";
            const target: NotifyTarget = { kind: "cron", jobId: j.id, backendId: j.backendId };
            fireNotification({
              category: "cron",
              title: tRef.current("notif.cronTitle", { name: j.name || j.id }),
              body: `${tRef.current("notif.cronRan")}${status}`,
              target,
            }, { onClick: () => { void navigate("cron", target); } });
          }
        }
        cronSeeded = true;
      } catch {
        /* gateway down / no cron — skip this tick */
      } finally {
        cronPending = false;
      }
    };

    // 每个后端独立比对、独立更新快照。原来把两个后端的结果合成一张表再整体重建：
    // 某个后端（Hermes dashboard 重启一下就够）这一 tick 拿不到看板，它的任务就从
    // 快照里被抹掉；下一 tick 后端恢复，这些任务全部命中「!prev」→ 每条弹一个
    // 「新任务」通知，一个中等看板就是几十条洪水。失败的后端必须保留旧快照。
    const pollTask = async () => {
      if (taskPending) return;
      taskPending = true;
      const generation = prefsGeneration.current;
      try {
        const results = await Promise.all(
          kanbanBackends.map((backendId) =>
            getBoards(backendId)
              .then(async (boards) => {
                if (!usesExplicitBoardIdentity(boards)) return getTaskBoard(backendId);
                const snapshots = await Promise.all(boards.map((board) =>
                  getTaskBoard(backendId, { board: board.id, readOnly: true }),
                ));
                return { columns: snapshots.flatMap((snapshot, index) => (snapshot.columns || []).map(column => ({
                  ...column, tasks: column.tasks.map(task => ({ ...task, sourceBoard: boards[index].id })),
                }))) };
              })
              .then((board) => ({ backendId, board }))
              .catch(() => ({ backendId, board: null })),
          ),
        );
        if (!alive || !prefsRef.current.task || generation !== prefsGeneration.current) return;
        for (const { backendId, board } of results) {
          if (!board) continue; // 这一轮没拿到 ≠ 任务被删光
          const next = new Map<string, { column: string; title: string; colName: string; target: TaskNotificationTarget }>();
          for (const col of board.columns) {
            for (const tk of col.tasks) {
              next.set(`${backendId}:${tk.sourceBoard || ""}:${tk.id}`, { column: tk.column, title: tk.title, colName: col.name,
                target: { kind: "task", backendId, taskId: tk.id, boardId: tk.sourceBoard, sessionKey: tk.sessionKey },
              });
            }
          }
          if (taskSeeded.has(backendId)) {
            for (const [id, cur] of next) {
              const prev = taskState.get(id);
              if (!prev) {
                fireNotification({ category: "task", title: tRef.current("notif.taskNew", { title: snippet(cur.title, 60) }), body: cur.colName, target: cur.target },
                  { onClick: () => { void navigate("task", cur.target); } });
              } else if (prev.column !== cur.column) {
                fireNotification({ category: "task", title: tRef.current("notif.taskMoved", { title: snippet(cur.title, 60) }), body: `→ ${cur.colName}`, target: cur.target },
                  { onClick: () => { void navigate("task", cur.target); } });
              }
            }
          }
          // 只替换该后端那一片快照，别动另一个（可能失败的）后端。
          for (const id of [...taskState.keys()]) {
            if (id.startsWith(`${backendId}:`)) taskState.delete(id);
          }
          for (const [id, cur] of next) taskState.set(id, { column: cur.column, title: cur.title });
          taskSeeded.add(backendId);
        }
      } finally {
        taskPending = false;
      }
    };

    const pollInspiration = async () => {
      if (inspirationPending) return;
      inspirationPending = true;
      const generation = prefsGeneration.current;
      try {
        const result = await readInspirationNotifications(inspirationSnapshot, { list: listInspirations, get: getInspiration });
        if (!alive || !prefsRef.current.task || generation !== prefsGeneration.current) return;
        inspirationSnapshot = result.snapshot;
        for (const idea of result.changed) {
          const target = `inspiration:${idea.id}`;
          const title = idea.title || idea.body.trim().split('\n')[0] || idea.attachments?.[0]?.name || tRef.current('nav.inspiration');
          fireNotification({
            category: "task", target,
            title: tRef.current("notif.inspirationUpdated", { title: snippet(title, 60) }),
            body: tRef.current(`inspiration.status.${inspirationNotificationStatus(idea)}`),
          }, { onClick: () => { void navigate("task", target); } });
        }
      } catch {
        /* Keep the previous snapshot when the service is temporarily unavailable. */
      } finally {
        inspirationPending = false;
      }
    };

    const tick = () => {
      if (!prefsReadyRef.current) return;
      if (prefsRef.current.cron) void pollCron();
      else { cronLastRun.clear(); cronSeeded = false; }
      if (prefsRef.current.task) {
        void pollTask();
        void pollInspiration();
      } else {
        taskState.clear(); taskSeeded.clear(); inspirationSnapshot = null;
      }
    };
    pollRef.current = tick;
    tick(); // seed snapshots immediately (silent)
    const timer = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
      if (pollRef.current === tick) pollRef.current = null;
    };
  }, [kanbanBackends]);

  return null;
}
