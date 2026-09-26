import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { respondBackendPrompt } from "../../api/client";
import { useToast } from "../../components/ui";
import AgentAvatarView from "../../components/AgentAvatar";
import { approvalOptionIsVisible } from "../../lib/approvalOptions";
import type { DashboardApprovalItem, DashboardRunningItem, InteractiveApprovalChoice, InteractiveRequestV1 } from "../../types";
import ChatPromptCard, { type ChatPromptEntry, type ChatPromptResponse } from "../ChatPromptCard";
import { fmtMs } from "../usage/charts";
import { isDashboardTaskSource } from "./activityStatusRows";
import styles from "./ApprovalRow.module.css";

// Reuse the same request/card as Inspiration, retaining the owning run and native choices.
function promptFor(item: DashboardApprovalItem): InteractiveRequestV1 & { id: string } {
  const request = item.interactiveRequest;
  const choices = (request?.approvalChoices || item.allowedDecisions || []).filter((choice): choice is InteractiveApprovalChoice => {
    if (item.kind === "input" && !["once", "deny", "cancel"].includes(choice)) return false;
    if (item.kind === "approval" && !item.allowedDecisions?.includes(choice)) return false;
    const option = request?.approvalOptions?.find(candidate => candidate.choice === choice);
    if (option) return approvalOptionIsVisible(option);
    return ["once", "session", "deny", "cancel"].includes(choice);
  });
  return {
    version: 1, id: item.id, runId: item.runId || "", requestId: item.requestId || "",
    kind: request?.kind || (item.kind === "input" ? "user_input" : "runtime_approval"),
    title: request?.title || "", message: request?.message || item.message || "",
    fields: request?.fields || item.questions || [],
    approvalChoices: choices,
    approvalOptions: request?.approvalOptions?.filter(option => choices.includes(option.choice)),
    approvalDetails: {
      ...request?.approvalDetails,
      command: request?.approvalDetails?.command || item.commandText || item.commandPreview,
    },
    expiresAt: request?.expiresAt ?? item.expiresAtMs ?? null,
  };
}

const requestKey = (backendId?: string, runId?: string, requestId?: string) => JSON.stringify([backendId, runId, requestId]);

// One persistent frame for running work and its current approval. Chat only
// supplies an approval, so it disappears after the response is acknowledged.
export default function ApprovalRow({ item, running, agentName, canRespond, onResponded, onOpenRun }: {
  item?: DashboardApprovalItem;
  running?: DashboardRunningItem;
  agentName: string;
  canRespond: boolean;
  onResponded: () => Promise<void>;
  onOpenRun?: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const header = useRef<HTMLButtonElement>(null);
  const expansion = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState(0);
  const panelId = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [responding, setResponding] = useState(false);
  const acceptedRef = useRef(new Set<string>());
  const [accepted, setAccepted] = useState(acceptedRef.current);
  // Retain the outgoing details while their height/opacity transitions finish.
  const [detailItem, setDetailItem] = useState(item);
  if (item && item !== detailItem) setDetailItem(item);
  const respondingRef = useRef(false);
  const [now, setNow] = useState(Date.now);
  const prompt = detailItem ? promptFor(detailItem) : undefined;
  const expiresAt = prompt?.expiresAt;
  const expired = expiresAt != null && expiresAt <= now;
  useEffect(() => {
    if (expiresAt == null || expiresAt <= now) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(Math.max(0, expiresAt - Date.now()), 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [expiresAt, now]);
  const currentKey = item ? requestKey(item.backendId, item.runId, item.requestId || item.id) : "";
  const detailKey = detailItem ? requestKey(detailItem.backendId, detailItem.runId, detailItem.requestId || detailItem.id) : "";
  const pending = !!item && !accepted.has(currentKey);
  const runWaiting = ["waiting_approval", "waiting_input"].includes(running?.status || "")
    && (!running?.waitingRequestId || !accepted.has(requestKey(running.backendId, running.runId, running.waitingRequestId)));
  const waiting = pending || (runWaiting && (!item || (!!running?.waitingRequestId && running.waitingRequestId !== item.requestId)));
  const source = running?.kind || item?.source || detailItem?.source;
  const showRunning = source !== "chat" && (!!running || isDashboardTaskSource(source));
  const ownsRequest = !detailItem?.interactiveRequest || (detailItem.interactiveRequest.runId === detailItem.runId
    && detailItem.interactiveRequest.requestId === detailItem.requestId);
  const canRenderActions = canRespond && ownsRequest && !!detailItem && !detailItem.interactionInvalid && !expired
    && !!detailItem.backendId && !!detailItem.runId && !!detailItem.requestId && ["approval", "input"].includes(detailItem.kind || "");
  const detailAccepted = accepted.has(detailKey);
  useLayoutEffect(() => {
    const content = expansion.current?.querySelector<HTMLElement>(".chat-prompt__content, .chat-prompt--input, [data-approval-content]");
    if (!content) { setContentHeight(0); return; }
    const measure = () => setContentHeight(content.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [detailKey, canRenderActions, detailAccepted]);
  const actionable = pending && canRenderActions;
  const expandable = pending;
  const expanded = expandable && (hovered || focused || pinned || responding);
  const waitingForInput = pending ? item?.kind === "input" : running?.status === "waiting_input";
  const attentionStatus = t(expired && pending ? "dashboard.expired" : waitingForInput
    ? "chat.promptNeedsInput" : "chat.promptNeedsApproval");
  const command = prompt?.approvalDetails?.command;
  const attentionSummary = ((pending && (prompt?.message || command)) || attentionStatus).replace(/\s+/gu, " ").trim();
  const kind = t(source === "cron" ? "dashboard.kindCron" : source === "kanban" ? "dashboard.kindKanban"
    : source === "inspiration" ? "dashboard.kindInspiration" : "dashboard.kindTask");
  const runningSummary = running?.progressSummary || (running?.title && !["Cron", "Kanban", "Inspiration"].includes(running.title) ? running.title : kind);
  const runningStatus = t("dashboard.runningNow", { kind, time: typeof running?.startedAt === "number" ? fmtMs(Math.max(0, Date.now() - running.startedAt)) : "" });
  const status = waiting ? attentionStatus : runningStatus;
  const summary = waiting ? attentionSummary : runningSummary;

  const respond = async (_entry: ChatPromptEntry, response: ChatPromptResponse) => {
    if (!actionable || !item || !prompt || respondingRef.current || acceptedRef.current.has(currentKey)
      || (expiresAt != null && expiresAt <= Date.now())) return;
    const { choice } = response;
    if (choice && !prompt.approvalChoices.includes(choice as InteractiveApprovalChoice)) return;
    if (item.kind === "approval" && !choice) return;
    const action = response.action || (choice === "once" ? "submit" : ["deny", "cancel"].includes(choice || "") ? "cancel" : undefined);
    if (item.kind === "input" && !action) return;
    respondingRef.current = true;
    setResponding(true);
    try {
      const result = await respondBackendPrompt(item.backendId!, item.kind === "approval"
        ? { kind: "approval", runId: item.runId!, requestId: item.requestId!, choice: choice as InteractiveApprovalChoice }
        : { kind: "input", runId: item.runId!, requestId: item.requestId!, action: action!, answers: action === "cancel" ? {} : response.answers || {} });
      if (result.runId !== item.runId || result.status !== "running") throw new Error("Unexpected prompt response");
      acceptedRef.current = new Set([...acceptedRef.current, currentKey]);
      setAccepted(acceptedRef.current);
      if (typeof document !== "undefined" && header.current?.parentElement?.contains(document.activeElement)) {
        header.current.focus({ preventScroll: true });
      }
      setPinned(false);
      setFocused(false);
    } catch (error) {
      setPinned(true);
      toast.error(t("dashboard.approvalRespondFailed"));
      throw error;
    } finally {
      respondingRef.current = false;
      setResponding(false);
    }
    toast.success(t("dashboard.approvalResponded"));
    await onResponded();
  };
  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(command || "");
      toast.success(t("dashboard.copied"));
    } catch { toast.error(t("dashboard.copyFailed")); }
  };
  if (!waiting && !showRunning) return null;

  return <div className={styles.root} data-dashboard-status data-dashboard-approval={waiting || undefined}
    style={{ "--approval-content-height": `${contentHeight}px` } as CSSProperties}
    data-tone={waiting ? "attention" : "running"} data-run-id={running?.runId || item?.runId}
    data-expanded={expanded} data-keyboard={focused}
    onPointerEnter={event => { if (event.pointerType === "mouse") setHovered(true); }}
    onPointerLeave={() => setHovered(false)}
    onFocus={event => {
      const target = event.target as HTMLElement;
      if (target !== header.current || target.matches(":focus-visible")) setFocused(true);
    }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { setFocused(false); setPinned(false); } }}
    onKeyDown={event => { if (event.key === "Escape") {
      event.stopPropagation(); header.current?.focus();
      setHovered(false); setFocused(false); setPinned(false);
    } }}>
    <button ref={header} type="button" className={styles.header} data-dashboard-status-header
      aria-expanded={expandable ? expanded : undefined} aria-controls={expandable ? panelId : undefined}
      disabled={!expandable && !onOpenRun}
      aria-label={`${agentName} · ${status} · ${summary}`} onClick={() => { if (expandable) setPinned(value => !value); else onOpenRun?.(); }}>
      <AgentAvatarView agentId={running?.agentId || item?.agentId} name={agentName} className={styles.avatar} />
      <span className={styles.name}>{agentName}</span>
      <span className={styles.summary} aria-hidden="true">
        <span data-status-copy="running">{runningSummary}</span>
        <span data-status-copy="attention">{attentionSummary}</span>
      </span>
      <span className={styles.status} role="status" aria-live="polite" aria-atomic="true">
        <span data-status-copy="running" aria-hidden={waiting}>{runningStatus}</span>
        <span data-status-copy="attention" aria-hidden={!waiting}>{attentionStatus}</span>
      </span>
    </button>
    <div id={panelId} className={styles.reveal} aria-hidden={!expanded} {...(!expanded ? { inert: "" } : {})}>
      <div className={styles.clip}><div ref={expansion} className={styles.expansion}>
      {prompt && (canRenderActions ? <ChatPromptCard
        key={`${detailKey}:${detailAccepted}`}
        entry={prompt} compactApproval onRespond={respond} />
        : <div className={styles.readonly} data-approval-content>
          {prompt.message && <p>{prompt.message}</p>}
          {command && <pre>{command}</pre>}
          {(detailItem?.interactionInvalid || !ownsRequest) && <p>{t("chat.promptUnavailableHint")}</p>}
        </div>)}
      {(command || onOpenRun) && <div className={styles.utilities}>
        {command && <button type="button" disabled={responding} onClick={() => void copyCommand()}>{t("dashboard.copyCommand")}</button>}
        {onOpenRun && <button type="button" disabled={responding} onClick={onOpenRun}>{t("dashboard.openRunDetail")}</button>}
      </div>}
      </div></div>
    </div>
  </div>;
}
