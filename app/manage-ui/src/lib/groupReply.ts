import type { GroupChatMessage } from "../types";

/** Presentation only; stored text and digests remain unchanged. Match the established quote exactly. */
export function groupReplyBody(message: GroupChatMessage, text = message.replyMessages?.length ? message.replyMessages.map(item => item.text).join("\n\n") : message.body): string {
  return message.author.kind === "member" && message.replyTo
    ? text.replace(new RegExp(`^\\s*(?:回复|引用)[ \\t]*#${message.replyTo.seq}[ \\t]*(?:\\r?\\n|$)\\s*`, "u"), "")
    : text;
}

export function groupReplyBubbles(message: GroupChatMessage): Array<{ id: string; text: string }> {
  return (message.replyMessages?.length ? message.replyMessages : [{ id: message.id, text: message.body }])
    .map(item => ({ ...item, text: groupReplyBody(message, item.text) })).filter(item => item.text.trim());
}
