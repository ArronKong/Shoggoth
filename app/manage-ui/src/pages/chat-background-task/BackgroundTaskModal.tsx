import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Modal from "../../components/Modal";
import ChatMarkdown from "../../components/ChatMarkdown";
import ChatPromptCard, { type ChatPromptEntry, type ChatPromptResponse } from "../ChatPromptCard";
import { controlBackgroundTask, getBackgroundTask } from "../../api/client";
import type { BackgroundTaskControl, BackgroundTaskDetail, BackgroundTaskStatus } from "../../types";
import { backgroundTaskTone } from "./BackgroundTaskCard";
import styles from "./BackgroundTaskModal.module.css";

const LIVE: BackgroundTaskStatus[] = ["starting", "queued", "running", "stopping", "waiting_approval", "waiting_input", "needs_verification"];
const STOPPABLE: BackgroundTaskStatus[] = ["starting", "queued", "running", "waiting_approval", "waiting_input"];

function errorText(t: (key: string, options?: Record<string, unknown>) => string, error: unknown) {
  const code = (error as { code?: string } | null)?.code;
  if (code && ["BACKGROUND_TASK_WAITING", "BACKGROUND_TASK_STOPPING", "BACKGROUND_TASK_NOT_FOUND"].includes(code)) {
    return t(`backgroundTask.errors.${code}`);
  }
  return error instanceof Error && error.message ? error.message : t("backgroundTask.loadFailed");
}

/** Details of one background task opened from its card or report in the source chat. */
export default function BackgroundTaskModal({ sessionKey, taskId, agentName, revision, onChanged, onClose }: {
  sessionKey: string;
  taskId: string;
  agentName?: string;
  /** Changes when the Service reports a task change for this chat. */
  revision: number;
  /** A control changed the task; the chat refreshes its cards. */
  onChanged?: () => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [detail, setDetail] = useState<BackgroundTaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"send" | "stop" | "respond" | null>(null);
  const [reload, setReload] = useState(0);
  const pending = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    let current = true, timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    alive.current = true;
    const load = async () => {
      try {
        const value = await getBackgroundTask(sessionKey, taskId, controller.signal);
        if (!current) return;
        setDetail(value); setError(null);
        if (LIVE.includes(value.task.status)) timer = setTimeout(() => void load(), 2000);
      } catch (cause) {
        if (current && !controller.signal.aborted) setError(errorText(t, cause));
      }
    };
    void load();
    return () => { current = false; alive.current = false; controller.abort(); clearTimeout(timer); };
  }, [sessionKey, taskId, revision, reload, t]);

  const control = useCallback(async (kind: "send" | "stop" | "respond", value: BackgroundTaskControl) => {
    if (pending.current) return;
    pending.current = true; setBusy(kind);
    try {
      await controlBackgroundTask(sessionKey, taskId, crypto.randomUUID(), value);
      if (!alive.current) return;
      if (kind === "send") setMessage("");
      setError(null); setReload(next => next + 1); onChanged?.();
    } catch (cause) {
      if (alive.current) setError(errorText(t, cause));
      if (kind === "respond") throw cause;
    } finally {
      pending.current = false;
      if (alive.current) setBusy(null);
    }
  }, [sessionKey, taskId, t, onChanged]);

  const respond = async (entry: ChatPromptEntry, data: ChatPromptResponse) => {
    const requestId = "requestId" in entry && typeof entry.requestId === "string" ? entry.requestId : entry.id;
    if (data.choice !== undefined) {
      await control("respond", { action: "approval", requestId, choice: data.choice });
    } else {
      await control("respond", { action: "input", requestId, inputAction: data.action === "cancel" ? "cancel" : "submit",
        answers: data.action === "cancel" ? {} : data.answers || {} });
    }
  };

  const task = detail?.task;
  const when = (value: number | null) => value ? new Date(value).toLocaleString(i18n.language) : "";
  const finished = task && !LIVE.includes(task.status);
  const subtitle = task ? [
    t(`backgroundTask.status.${task.status}`),
    t("backgroundTask.runtime", { runtime: task.runtime }),
    task.generation > 1 ? t("backgroundTask.run", { n: task.generation }) : "",
    task.startedAt ? t("backgroundTask.startedAt", { time: when(task.startedAt) }) : "",
    task.finishedAt ? t("backgroundTask.finishedAt", { time: when(task.finishedAt) }) : "",
  ].filter(Boolean).join(" · ") : undefined;
  const fileLinks = detail?.files.filter(file => file.url).map(file => `- [${file.name.replace(/[\\[\]]/gu, "\\$&")}](${file.url})`).join("\n");

  return <Modal open title={task?.title || t("backgroundTask.detailTitle")} subtitle={subtitle} width={720} onClose={onClose}
    footer={task ? <div className={styles.footer}>
      <textarea className={styles.input} rows={2} value={message} disabled={busy !== null}
        placeholder={t("backgroundTask.supplementPlaceholder")} aria-label={t("backgroundTask.supplementPlaceholder")}
        onChange={event => setMessage(event.target.value)}
        onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && message.trim()) {
            event.preventDefault(); void control("send", { action: "send", message: message.trim() });
          }
        }} />
      <div className={styles.actions}>
        {STOPPABLE.includes(task.status) ? <button type="button" className="btn" disabled={busy !== null}
          onClick={() => void control("stop", { action: "cancel" })}>
          {busy === "stop" ? t("backgroundTask.stoppingAction") : t("backgroundTask.stop")}</button> : null}
        <button type="button" className="btn-primary" disabled={busy !== null || !message.trim()}
          onClick={() => void control("send", { action: "send", message: message.trim() })}>
          {busy === "send" ? t("backgroundTask.sending") : t("backgroundTask.send")}</button>
      </div>
    </div> : undefined}>
    <div className={styles.body} data-tone={task ? backgroundTaskTone(task.status) : undefined}>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {!detail && !error ? <p className={styles.muted}>{t("backgroundTask.loading")}</p> : null}
      {detail?.queueReason && task?.status === "queued" ? <p className={styles.muted}>{t("backgroundTask.queueReason", { reason: detail.queueReason })}</p> : null}
      {detail?.interaction ? <section className={styles.section}>
        <p className={styles.hint}>{t("backgroundTask.waitingHint")}</p>
        <ChatPromptCard entry={{ ...detail.interaction.payload, id: detail.interaction.payload.requestId }} onRespond={respond}
          agentName={agentName} />
      </section> : null}
      {detail ? <section className={styles.section} aria-label={t("backgroundTask.progress")}>
        {detail.messages.length ? detail.messages.map((item, index) => {
          const label = item.role === "user" ? index === 0 ? t("backgroundTask.brief") : t("backgroundTask.supplement")
            : item.activity ? t("backgroundTask.progress") : t("backgroundTask.reply");
          return <article key={item.id} className={styles.message} data-role={item.role} data-activity={item.activity || undefined}>
            <header className={styles.messageHead}><span>{label}</span><time>{when(item.at)}</time></header>
            <ChatMarkdown className="chat-md" text={item.text} />
          </article>;
        }) : <p className={styles.muted}>{t("backgroundTask.noMessages")}</p>}
      </section> : null}
      {fileLinks ? <section className={styles.section}>
        <h3 className={styles.heading}>{t("backgroundTask.files")}</h3>
        <ChatMarkdown className="chat-md" text={fileLinks} />
      </section> : null}
      {finished ? <p className={styles.muted}>{t("backgroundTask.continueHint")}</p> : null}
    </div>
  </Modal>;
}
