import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import Modal from "../../components/Modal";
import ChatMarkdown from "../../components/ChatMarkdown";
import type { ChatPromptEntry, ChatPromptResponse } from "../ChatPromptCard";
import { IconSend, IconStop } from "../chatIcons";
import { controlBackgroundTask, getBackgroundTask } from "../../api/client";
import type { BackgroundTaskControl, BackgroundTaskDetail, BackgroundTaskMessage, BackgroundTaskStatus } from "../../types";
import type { ConnectBackgroundChat } from "./backgroundTaskChat";
import { backgroundTaskTone } from "./BackgroundTaskCard";
import styles from "./BackgroundTaskModal.module.css";

const LIVE: BackgroundTaskStatus[] = ["starting", "queued", "running", "stopping", "waiting_approval", "waiting_input", "needs_verification"];
const STOPPABLE: BackgroundTaskStatus[] = ["starting", "queued", "running", "waiting_approval", "waiting_input"];

export interface BackgroundTaskConversationProps {
  sessionKey: string;
  taskId: string;
  detail: BackgroundTaskDetail;
  briefId?: string;
  setBrief(brief: BackgroundTaskMessage | null): void;
  refreshKey: string;
  scrollRef: RefObject<HTMLDivElement>;
  agentName?: string;
  respond(entry: ChatPromptEntry, response: ChatPromptResponse): Promise<void>;
  quote(text: string): void;
  connect?: ConnectBackgroundChat;
}

function errorText(t: (key: string, options?: Record<string, unknown>) => string, error: unknown) {
  const code = (error as { code?: string } | null)?.code;
  if (code && ["BACKGROUND_TASK_WAITING", "BACKGROUND_TASK_STOPPING", "BACKGROUND_TASK_NOT_FOUND"].includes(code)) {
    return t(`backgroundTask.errors.${code}`);
  }
  return error instanceof Error && error.message ? error.message : t("backgroundTask.loadFailed");
}

/** Details of one background task opened from its card or report in the source chat. */
export default function BackgroundTaskModal({ sessionKey, taskId, agentName, revision, onChanged, onClose, initialFocus, Conversation, connectChat }: {
  sessionKey: string;
  taskId: string;
  agentName?: string;
  initialFocus?: boolean;
  Conversation: ComponentType<BackgroundTaskConversationProps>;
  connectChat?: ConnectBackgroundChat;
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
  const [canonicalBrief, setBrief] = useState<BackgroundTaskMessage | null | undefined>(undefined);
  const pending = useRef(false);
  const alive = useRef(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollBody, setScrollBody] = useState<HTMLDivElement | null>(null);
  const attachScrollBody = useCallback((element: HTMLDivElement | null) => {
    scrollRef.current = element;
    setScrollBody(element);
  }, []);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    if (!scrollBody) return;
    const updateFade = () => {
      const { scrollTop, scrollHeight, clientHeight } = scrollBody;
      scrollBody.toggleAttribute("data-scrolled", scrollTop > 1);
      scrollBody.toggleAttribute("data-more", scrollHeight - scrollTop > clientHeight + 1);
    };
    updateFade();
    const observer = new ResizeObserver(updateFade);
    observer.observe(scrollBody);
    if (scrollBody.firstElementChild) observer.observe(scrollBody.firstElementChild);
    scrollBody.addEventListener("scroll", updateFade, { passive: true });
    return () => {
      observer.disconnect();
      scrollBody.removeEventListener("scroll", updateFade);
    };
  }, [scrollBody]);

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
      const { task: updatedTask } = await controlBackgroundTask(sessionKey, taskId, crypto.randomUUID(), value);
      if (!alive.current) return;
      if (value.action === "send") setMessage(draft => draft.trim() === value.message ? "" : draft);
      setDetail(current => current && updatedTask.generation >= current.task.generation ? { ...current, task: updatedTask } : current);
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
  const messages = detail?.messages ?? [];
  const brief = canonicalBrief === undefined ? messages[0]?.role === "user" ? messages[0] : null : canonicalBrief;
  const when = (value: number | null) => value ? new Date(value).toLocaleString(i18n.language) : "";
  const finished = task && !LIVE.includes(task.status);
  const sending = busy === "send";
  const stopping = busy === "stop" || task?.status === "stopping";
  const showStop = task && (stopping || sending || STOPPABLE.includes(task.status));
  const sendLabel = t("backgroundTask.send");
  const stopLabel = t(stopping ? "backgroundTask.stoppingAction" : sending ? "backgroundTask.sending" : "backgroundTask.stop");
  const draft = message.trim();
  const sendDraft = () => {
    if (draft) void control("send", { action: "send", message: draft });
  };
  const subtitle = task ? [
    t(`backgroundTask.status.${task.status}`),
    t("backgroundTask.runtime", { runtime: task.runtime }),
    task.generation > 1 ? t("backgroundTask.run", { n: task.generation }) : "",
    task.startedAt ? t("backgroundTask.startedAt", { time: when(task.startedAt) }) : "",
    task.finishedAt ? t("backgroundTask.finishedAt", { time: when(task.finishedAt) }) : "",
  ].filter(Boolean).join(" · ") : undefined;
  const fileLinks = detail?.files.filter(file => file.url).map(file => `- [${file.name.replace(/[\\[\]]/gu, "\\$&")}](${file.url})`).join("\n");

  return <Modal open title={task?.title || t("backgroundTask.detailTitle")} subtitle={subtitle} width={720} onClose={onClose}
    className={`chat-surface ${styles.panel}`} initialFocus={initialFocus} bodyRef={attachScrollBody} bodyClassName={styles.scrollBody}
    footer={task ? <div className={`chat-surface chat-composer ${styles.composer}`}>
      <textarea ref={inputRef} className="chat-composer__input" rows={2} value={message}
        placeholder={t("backgroundTask.supplementPlaceholder")} aria-label={t("backgroundTask.supplementPlaceholder")}
        onChange={event => setMessage(event.target.value)}
        onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault(); sendDraft();
          }
        }} />
      <div className="chat-composer__bar">
        <div className="chat-composer__right">
          {showStop ? (
            <button type="button" className="chat-iconbtn chat-send chat-stop" disabled={busy !== null || stopping}
              aria-label={stopLabel} title={stopLabel} aria-busy={stopping || sending}
              onClick={() => void control("stop", { action: "cancel" })}>
              <IconStop />
            </button>
          ) : (
            <button type="button" className="chat-iconbtn chat-send" disabled={busy !== null || !draft}
              aria-label={sendLabel} title={sendLabel} onClick={sendDraft}>
              <IconSend />
            </button>
          )}
        </div>
      </div>
    </div> : undefined}>
    <div className={styles.body} data-tone={task ? backgroundTaskTone(task.status) : undefined}>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {!detail && !error ? <p className={styles.muted}>{t("backgroundTask.loading")}</p> : null}
      {detail?.queueReason && task?.status === "queued" ? <p className={styles.muted}>{t("backgroundTask.queueReason", { reason: detail.queueReason })}</p> : null}
      {detail?.queuedFollowUps ? <p className={styles.hint} role="status">{t("backgroundTask.queuedFollowUps", { count: detail.queuedFollowUps })}</p> : null}
      {detail ? <section className={styles.section} aria-label={t("backgroundTask.progress")}>
        {brief && <article className={styles.message} data-role="user">
          <header className={styles.messageHead}><span>{t("backgroundTask.brief")}</span><time>{when(brief.at)}</time></header>
          <ChatMarkdown className="chat-md" text={brief.text} />
        </article>}
        {detail.interaction && <p className={styles.hint}>{t("backgroundTask.waitingHint")}</p>}
        <div className={styles.conversation}>
          <Conversation sessionKey={sessionKey} taskId={taskId} detail={detail} briefId={brief?.id} setBrief={setBrief}
            refreshKey={`${revision}:${reload}:${detail.task.generation}:${detail.task.status}`}
            scrollRef={scrollRef} agentName={agentName} respond={respond} connect={connectChat}
            quote={text => {
              if (!text.trim()) return;
              const block = text.trim().split("\n").map(line => `> ${line}`).join("\n");
              setMessage(value => `${block}\n\n${value}`);
              inputRef.current?.focus();
            }} />
        </div>
        {!messages.length && <p className={styles.muted}>{t("backgroundTask.noMessages")}</p>}
      </section> : null}
      {fileLinks ? <section className={styles.section}>
        <h3 className={styles.heading}>{t("backgroundTask.files")}</h3>
        <ChatMarkdown className="chat-md" text={fileLinks} />
      </section> : null}
      {finished ? <p className={styles.muted}>{t("backgroundTask.continueHint")}</p> : null}
    </div>
  </Modal>;
}
