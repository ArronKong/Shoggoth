import type { GroupChatMessage } from "../types";

/** Presentation only; stored text and digests remain unchanged. Match the established quote exactly. */
export function groupReplyBody(message: GroupChatMessage, text = message.body): string {
  return message.author.kind === "member" && message.replyTo
    ? text.replace(new RegExp(`^\\s*(?:回复|引用)[ \\t]*#${message.replyTo.seq}[ \\t]*(?:\\r?\\n|$)\\s*`, "u"), "")
    : text;
}
