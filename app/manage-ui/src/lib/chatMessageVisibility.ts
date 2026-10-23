export interface ChatMessageVisibilityFacts {
  role: string;
  local?: boolean;
  automation?: "cron" | "continuation";
  provenance?: { kind?: string; sourceTool?: string } | null;
}

// Inter-session inputs are retained in transcript/model history, but they are not
// messages the human typed into this task and must not render as user bubbles.
export function isInterSessionUserMessage(
  message: ChatMessageVisibilityFacts,
  text = "",
): boolean {
  if (message.role !== "user" || message.local === true) return false;
  if (message.provenance?.kind === "inter_session") return true;
  const normalized = text.trimStart();
  return normalized.startsWith("[Inter-session message]")
    || text.includes("[Inter-session message] sourceSession=");
}

// Match producer metadata first. Older external transcripts carry explicit
// scheduler envelopes. A Cron session can also contain ordinary human follow-ups;
// session kind alone must never hide those messages.
export function isScheduledCronUserMessage(message: ChatMessageVisibilityFacts, text = ""): boolean {
  if (message.role !== "user" || message.local === true) return false;
  if (message.automation === "cron"
    || message.provenance?.kind === "internal_system" && message.provenance.sourceTool === "cron") return true;
  const opening = text.trimStart();
  return opening.startsWith("[IMPORTANT: You are running as a scheduled cron job.")
    || /^\[cron:[^\]\n]+\]/i.test(opening)
    || opening.startsWith("A scheduled reminder has been triggered. The reminder content is:")
    || opening.startsWith("A scheduled cron event was triggered, but no event content was found.");
}
