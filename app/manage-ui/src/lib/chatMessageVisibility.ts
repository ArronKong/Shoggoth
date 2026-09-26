export interface ChatMessageVisibilityFacts {
  role: string;
  local?: boolean;
  provenance?: { kind?: string } | null;
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
