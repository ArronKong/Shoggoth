import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { ChatPlanEntry } from "../lib/chatPlan";
import ChatMarkdown from "./ChatMarkdown";
import "./ChatPlanDock.css";

export default function ChatPlanDock({ entries, expanded, onToggle }: {
  entries: readonly ChatPlanEntry[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const contentId = useId();
  if (!entries.length) return null;
  const progress = entries.find((entry) => entry.progressRevision !== undefined);
  const steps = entries.filter((entry) => entry.content.trim());
  const done = steps.filter((entry) => entry.status === "completed").length;
  const markdown = progress?.progressMarkdown;
  const heading = markdown?.split("\n").find((line) => /^#{1,6}\s+/.test(line))
    ?.replace(/^#{1,6}\s+/, "").replace(/[*_`]/g, "");
  const current = steps.find((entry) => entry.status === "in_progress")
    ?? steps.find((entry) => entry.status !== "completed");
  const summary = current?.content || heading || (steps.length ? t("chat.planComplete") : t("chat.planDetails"));
  return (
    <section className="chat-plan-dock" data-chat-plan-dock data-progress-revision={progress?.progressRevision}
      aria-label={t("chat.planTitle")}>
      <button type="button" className="chat-plan-dock__toggle" aria-expanded={expanded}
        aria-controls={contentId} onClick={onToggle} title={t(expanded ? "chat.planCollapse" : "chat.planExpand")}>
        <svg className="chat-plan-dock__icon" viewBox="0 0 20 20" fill="none" stroke="currentColor"
          strokeWidth="1.4" aria-hidden="true">
          <path d="m3 5 1.5 1.5L7 4M9 5h8M3 11h3M9 11h8M3 16h3M9 16h8" />
        </svg>
        <span className="chat-plan-dock__label">{t("chat.planTitle")}</span>
        <span className="chat-plan-dock__summary">{summary}</span>
        {steps.length > 0 && <span className={`chat-plan-dock__count${done === steps.length ? " is-completed" : ""}`}
          aria-label={t("chat.planProgress", { done, total: steps.length })}>{done}/{steps.length}</span>}
        <svg className="chat-plan-dock__chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor"
          strokeWidth="1.5" aria-hidden="true"><path d="m4 10 4-4 4 4" /></svg>
      </button>
      <div id={contentId} className="chat-plan-dock__body" hidden={!expanded}>
        {markdown && <ChatMarkdown className="chat-plan-dock__markdown chat-md" text={markdown} />}
        {steps.length > 0 && <ol className="chat-plan-dock__steps">
          {steps.map((entry, index) => <li key={index} className={`chat-plan-dock__step is-${entry.status}`}>
            <span className="chat-plan-dock__mark" aria-label={t(`chat.planStatus.${entry.status}`, {
              defaultValue: t("chat.planStatus.pending"),
            })}>{entry.status === "completed" ? "✓" : entry.status === "in_progress" ? "▸" : "○"}</span>
            <span>{entry.content}</span>
          </li>)}
        </ol>}
      </div>
    </section>
  );
}
