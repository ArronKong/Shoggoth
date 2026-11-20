import type { BackgroundTaskControl, BackgroundTaskDetail } from "../../../app/manage-ui/src/types";
import { csv, fileName, fileUrl, makeDetail, turnMessage } from "./scenes";
import type { ConnectBackgroundChat } from "../../../app/manage-ui/src/pages/chat-background-task/backgroundTaskChat";

const samples = new Map<string, BackgroundTaskDetail>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const heldErrors = new WeakSet<BackgroundTaskDetail>();

export const connectPreviewChat: ConnectBackgroundChat = ({ taskId }, handlers) => {
  let closed = false;
  queueMicrotask(() => { if (!closed) handlers.ready(); });
  return {
    async history() {
      const { task, messages } = samples.get(taskId) ?? makeDetail(taskId);
      const runId = messages.at(-1)?.runId ?? "preview-run";
      const rows: unknown[] = [];
      let includedTool = false;
      for (const message of messages) {
        const shoggoth = { nativeUiVersion: 1, runId: message.runId, sourceEventId: message.id };
        if (message.activity && !includedTool) {
          includedTool = true;
          rows.push({ id: "tool-market-data", role: "assistant", timestamp: message.at - 48_000, shoggoth,
            content: [{ type: "toolCall", toolName: "web_search", toolCallId: "pricing", arguments: { query: "三款方案公开定价" } }] });
          rows.push({ id: "result-market-data", role: "toolResult", timestamp: message.at - 40_000, shoggoth,
            content: [{ type: "toolResult", name: "web_search", toolCallId: "pricing", content: "找到三份公开价目表。", durationS: 8 }] });
        }
        rows.push({ id: message.id, role: message.role, timestamp: message.at, shoggoth,
          content: [{ type: "text", text: message.text, activity: message.activity, segmentId: message.id }] });
      }
      const active = ["starting", "queued", "running", "stopping", "waiting_input", "waiting_approval"].includes(task.status);
      setTimeout(() => {
        if (closed) return;
        handlers.event({ event: "chat", payload: { state: "status", statusKind: active ? task.status : "idle", nativeRunId: runId } });
        if (taskId === "running" && task.status === "running") {
          handlers.event({ event: "session.tool", payload: { nativeRunId: runId, data: {
            toolCallId: "verify-pricing", name: "web_search", phase: "start", args: { query: "核对团队版月度计费" },
          } } });
        }
      }, 0);
      return { messages: rows, hasMore: false, nextCursor: null, sourceId: `gallery:${taskId}`,
        brief: messages[0]?.role === "user" ? messages[0] : null };
    },
    close() { closed = true; },
  };
};
export function resetSample(id: string) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  samples.delete(id);
}
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const fault = (code: string, error: string, status = 409) => response({ code, error }, status);
function wait(ms: number, signal?: AbortSignal | null) {
  return new Promise<void>((resolve, reject) => {
    const end = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(end, ms);
    const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}
function update(id: string, detail: BackgroundTaskDetail, action: BackgroundTaskControl) {
  const { task } = detail;
  if (id === "approval-error" && action.action === "approval" && !heldErrors.has(detail)) {
    heldErrors.add(detail);
    return fault("BACKGROUND_TASK_UNAVAILABLE", "审批提交失败，请重试。", 503);
  }
  heldErrors.delete(detail);
  if (action.action === "send") {
    if (id === "wait-error" && detail.interaction || id === "stop-error" && task.status === "stopping") heldErrors.add(detail);
    if (task.status === "waiting_input" || task.status === "waiting_approval") return fault("BACKGROUND_TASK_WAITING", "");
    if (task.status === "stopping") return fault("BACKGROUND_TASK_STOPPING", "");
    if (task.status === "needs_verification") return fault("BACKGROUND_TASK_UNAVAILABLE", "任务状态待核对，请稍后再试。");
    if (["queued", "starting"].includes(task.status) || task.runtime === "opencode" && task.status === "running") {
      detail.queuedFollowUps = (detail.queuedFollowUps || 0) + 1;
    } else {
      if (["completed", "failed", "canceled", "interrupted"].includes(task.status)) {
        task.status = "running"; task.generation++; task.finishedAt = null; task.report = "none";
      }
      detail.messages.push({ ...turnMessage(crypto.randomUUID(), "user", action.message, 0), at: Date.now() });
    }
  } else if (action.action === "cancel") {
    task.status = "stopping"; detail.interaction = null; detail.queuedFollowUps = 0;
    timers.set(id, setTimeout(() => {
      task.status = "canceled"; task.report = "withheld"; task.finishedAt = Date.now(); timers.delete(id);
    }, 800));
  } else {
    if (!detail.interaction || detail.interaction.payload.requestId !== action.requestId) return fault("BACKGROUND_TASK_NOT_FOUND", "", 404);
    const fields = detail.interaction.payload.fields;
    detail.interaction = null;
    task.status = "running";
    const text = action.action === "approval" ? (action.choice === "deny" ? "已拒绝本次请求。" : "已收到审批答复。")
      : action.inputAction === "cancel" ? "已取消这次输入。"
      : fields.map(f => f.secret ? "已提供隐藏回答。" : action.answers[f.id]).filter(Boolean).join(" · ");
    detail.messages.push({ ...turnMessage(crypto.randomUUID(), "user", text, 0), at: Date.now() });
  }
  return response({ task });
}

// The production modal uses its normal REST client; this isolated page owns every response.
export function installPreviewTransport() {
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.origin !== location.origin) return fault("PREVIEW_ONLY", "该地址不属于预览。", 404);
    if (url.pathname === "/__api/background-tasks/detail") {
      const id = url.searchParams.get("taskId") || "";
      const previous = samples.get(id);
      // Keep the selected error on screen for review until the next action or reset.
      if (id === "loading" || previous && heldErrors.has(previous)) await wait(2 ** 30, init?.signal);
      await wait(90, init?.signal);
      if (id === "load-error") return fault("PREVIEW_READ_FAILED", "无法读取后台任务", 503);
      if (id === "not-found") return fault("BACKGROUND_TASK_NOT_FOUND", "", 404);
      if (!samples.has(id)) samples.set(id, makeDetail(id));
      return response(samples.get(id));
    }
    if (url.pathname === "/__api/background-tasks/control" && init?.method === "POST") {
      const control = JSON.parse(String(init.body)) as BackgroundTaskControl & { taskId: string };
      const detail = samples.get(control.taskId);
      // Let the reviewer inspect transient button labels before the simulated reply arrives.
      await wait(control.taskId.startsWith("slow-") ? 12_000 : 600, init.signal);
      if (!detail || samples.get(control.taskId) !== detail) return fault("BACKGROUND_TASK_NOT_FOUND", "", 404);
      return update(control.taskId, detail, control);
    }
    return fault("PREVIEW_ONLY", "这个样例没有对应的数据。", 404);
  };
  document.addEventListener("click", event => {
    const a = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[href]");
    if (!a || new URL(a.href).pathname !== fileUrl.split("?")[0]) return;
    event.preventDefault();
    const blob = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
    const download = document.createElement("a");
    download.href = blob; download.download = fileName; download.click();
    setTimeout(() => URL.revokeObjectURL(blob), 1000);
  }, true);
}
