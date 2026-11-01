interface PromptMessage {
  id?: string;
  role: string;
  pending?: boolean;
  parts: { type: string; segmentId?: string; promptEntry?: { requestId?: string } }[];
}
const containsPrompt = (message: PromptMessage, requestId: string) =>
  message.parts.some(part => part.type === "prompt" && part.promptEntry?.requestId === requestId);
const identity = (message: PromptMessage) => message.id ? `id:${message.id}`
  : message.parts.find(part => part.segmentId)?.segmentId;

// Capture the request's position before awaiting its acknowledgement. Text may
// resume, seal another bubble and expire the card before that RPC returns.
export function promptHistoryAnchor<T extends PromptMessage>(messages: T[], requestId: string): T[] {
  const index = messages.findIndex(message => containsPrompt(message, requestId));
  return index < 0 ? [] : messages.slice(0, index);
}

export function applyPromptHistory<T extends PromptMessage>(previous: T[], requestId: string, receipt: T[], anchors: T[]): T[] {
  if (receipt.length !== 2 || receipt[0].role !== "assistant" || receipt[1].role !== "user"
    || !receipt[0].id || !receipt[1].id || previous.some(message => message.id === receipt[1].id)) return previous;
  let at = previous.findIndex(message => containsPrompt(message, requestId));
  if (at < 0) {
    for (const anchor of [...anchors].reverse()) {
      const key = identity(anchor);
      const index = previous.findIndex(message => key ? identity(message) === key : message === anchor);
      if (index >= 0) { at = index + 1; break; }
    }
  }
  // A cleared/replaced conversation must not be revived by an old receipt.
  if (at < 0) return previous;
  const clean = previous.map(message => containsPrompt(message, requestId)
    ? { ...message, parts: message.parts.filter(part => part.promptEntry?.requestId !== requestId) } : message);
  const missing = receipt.filter(message => !previous.some(item => item.id === message.id));
  return [...clean.slice(0, at), ...missing, ...clean.slice(at)];
}
