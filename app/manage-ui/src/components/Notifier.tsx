import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { getBoards, getConfig, getTaskBoard, listCronJobs } from "../api/client";
import type { NotificationPrefs } from "../types";
import { useEnabledBackends } from "../lib/backends";
import { usesExplicitBoardIdentity } from "../lib/shoggothDomainUi";
import {
  chatNotificationFor,
  fireNotification,
  onOpenTarget,
  snippet,
  type NotifyCategory,
} from "../lib/notify";

// App-level, always-mounted notification driver. Lives OUTSIDE the router so it
// survives page switches (ChatPage — the only other /__chatws consumer —
// unmounts and drops its socket when you navigate away). This is the SINGLE
// source of desktop notifications; ChatPage never fires them.
//
//  - chat  → realtime: its own /__chatws subscription, on each `chat` final from
//            a UI-driven session.
//  - cron  → polled: listCronJobs(), notify when a job's lastRunAt advances.
//  - task  → polled: getTaskBoard(both backends), notify on new task / column move.
//
// cron/task poll only while their toggle is on (default off). Suppression (don't
// notify while the window is focused) + the authoritative toggle check live in
// the Electron main process; the Web fallback re-checks focus itself.

const POLL_MS = 30000;
const PENDING_CHAT_KEY = "openclaw.pendingChatSession";
const DEFAULT_PREFS: NotificationPrefs = { chat: true, cron: false, task: false };

function navigateForTarget(category: NotifyCategory, target: string | null) {
  if (category === "chat" && target) {
    try {
      sessionStorage.setItem(PENDING_CHAT_KEY, target);
    } catch {
      /* ignore */
    }
    window.location.hash = "#/chat";
    // If ChatPage is already mounted, nudge it to open the session now.
    window.dispatchEvent(new CustomEvent("openclaw:open-chat-session", { detail: target }));
  } else if (category === "cron") {
    // Cron 通知附带统一任务 ID；编码后写入 HashRouter 查询参数，避免 ID 中的特殊字符破坏路由。
    window.location.hash = target ? `#/cron?job=${encodeURIComponent(target)}` : "#/cron";
  } else if (category === "task") {
    window.location.hash = "#/tasks";
  }
}

export default function Notifier() {
  const { t } = useTranslation();
  const kanbanBackends = useEnabledBackends("kanban");
  const tRef = useRef(t);
  tRef.current = t;

  const prefsRef = useRef<NotificationPrefs>(DEFAULT_PREFS);

  // Load the live notification prefs (config-store is the source).
  //
  // Don't assume a config save reloads the window: Electron's applyConfigChange only
  // reloads when gateway/hermes/locale changed, so toggling a notification (or the
  // theme) leaves this component mounted with stale prefs — and the cron/task polls
  // are gated on prefsRef, so they'd never even start. SettingsPage emits
  // `openclaw:config-changed` on every save; focus is cheap insurance on top.
  useEffect(() => {
    let alive = true;
    const load = () =>
      getConfig()
        .then((c) => {
          if (alive && c?.notifications) prefsRef.current = c.notifications;
        })
        .catch(() => {});
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
  useEffect(() => onOpenTarget((p) => navigateForTarget(p.category, p.target)), []);

  // --- chat: realtime /__chatws subscription -------------------------------
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closedByUs = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reqId = 0;
    const seen = new Set<string>(); // dedup chat finals by sessionKey:ts

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/__chatws`);
      ws.onopen = () => {
        reqId += 1;
        try {
          ws?.send(JSON.stringify({ type: "req", id: `notif-sub-${reqId}`, method: "sessions.subscribe", params: {} }));
        } catch {
          /* ignore */
        }
      };
      ws.onmessage = (ev) => {
        let f: { type?: string; event?: string; payload?: { state?: string; sessionKey?: string; message?: unknown } };
        try {
          f = JSON.parse(ev.data);
        } catch {
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
        if (!prefsRef.current.chat) return;
        const payload = chatNotificationFor(msg, sk);
        if (payload) fireNotification(payload, { onClick: () => navigateForTarget("chat", sk) });
      };
      ws.onclose = () => {
        if (closedByUs) return;
        reconnectTimer = setTimeout(connect, 4000);
      };
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
      };
    };
    connect();
    return () => {
      closedByUs = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
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

    const pollCron = async () => {
      try {
        const jobs = await listCronJobs();
        if (!alive) return;
        for (const j of jobs) {
          const last = j.lastRunAt ?? 0;
          const prev = cronLastRun.get(j.id);
          cronLastRun.set(j.id, last);
          // Notify only when a KNOWN job's run timestamp advances (seed silently;
          // a brand-new job that already ran is not announced).
          if (cronSeeded && prev !== undefined && last > prev) {
            const status = j.lastStatus ? ` · ${j.lastStatus}` : "";
            fireNotification({
              category: "cron",
              title: tRef.current("notif.cronTitle", { name: j.name || j.id }),
              body: `${tRef.current("notif.cronRan")}${status}`,
              // 传入统一任务 ID，供点击通知后自动打开该任务详情。
              target: j.id,
            });
          }
        }
        cronSeeded = true;
      } catch {
        /* gateway down / no cron — skip this tick */
      }
    };

    // 每个后端独立比对、独立更新快照。原来把两个后端的结果合成一张表再整体重建：
    // 某个后端（Hermes dashboard 重启一下就够）这一 tick 拿不到看板，它的任务就从
    // 快照里被抹掉；下一 tick 后端恢复，这些任务全部命中「!prev」→ 每条弹一个
    // 「新任务」通知，一个中等看板就是几十条洪水。失败的后端必须保留旧快照。
    const pollTask = async () => {
      const results = await Promise.all(
        kanbanBackends.map((backendId) =>
          getBoards(backendId)
            .then(async (boards) => {
              if (!usesExplicitBoardIdentity(boards)) return getTaskBoard(backendId);
              const snapshots = await Promise.all(boards.map((board) =>
                getTaskBoard(backendId, { board: board.id, readOnly: true }),
              ));
              return { columns: snapshots.flatMap((snapshot) => snapshot.columns || []) };
            })
            .then((board) => ({ backendId, board }))
            .catch(() => ({ backendId, board: null })),
        ),
      );
      if (!alive) return;
      for (const { backendId, board } of results) {
        if (!board) continue; // 这一轮没拿到 ≠ 任务被删光
        const next = new Map<string, { column: string; title: string; colName: string }>();
        for (const col of board.columns) {
          for (const tk of col.tasks) {
            next.set(`${backendId}:${tk.id}`, { column: tk.column, title: tk.title, colName: col.name });
          }
        }
        if (taskSeeded.has(backendId)) {
          for (const [id, cur] of next) {
            const prev = taskState.get(id);
            if (!prev) {
              fireNotification({ category: "task", title: tRef.current("notif.taskNew", { title: snippet(cur.title, 60) }), body: cur.colName, target: null });
            } else if (prev.column !== cur.column) {
              fireNotification({ category: "task", title: tRef.current("notif.taskMoved", { title: snippet(cur.title, 60) }), body: `→ ${cur.colName}`, target: null });
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
    };

    const tick = () => {
      if (prefsRef.current.cron) void pollCron();
      if (prefsRef.current.task) void pollTask();
    };
    tick(); // seed snapshots immediately (silent)
    const timer = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [kanbanBackends]);

  return null;
}
