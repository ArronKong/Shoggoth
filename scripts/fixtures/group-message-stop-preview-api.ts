// In-memory receipts for the isolated preview. No service, provider, or persisted chat is used.
import { groupSendDigest, type GroupSendInput } from "../../app/manage-ui/src/lib/groupSendJournal";
import type { GroupChatMessage, GroupChatView } from "../../app/manage-ui/src/types";

export function createPreviewSendApi(view: GroupChatView, messages: GroupChatMessage[]) {
  const receipts = new Map<string, { digest: string; message: GroupChatMessage; discussionId: string }>();
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
  const failed = (code: string) => json({ code, error: code }, 409);
  return async (request: URL, init: RequestInit): Promise<Response | null> => {
    if (request.pathname === "/__api/group-chats/messages/lookup") {
      const clientMessageId = request.searchParams.get("clientMessageId"), groupId = request.searchParams.get("id");
      const base = { ownerScope: view.ownerScope, groupId, clientMessageId, payloadMatches: null, message: null, discussionId: null };
      if (groupId !== view.group.id) return failed("GROUP_CHAT_NOT_FOUND");
      if (request.searchParams.get("ownerScope") !== view.ownerScope) return json({ ...base, status: "unknown", reason: "owner_changed" });
      const receipt = receipts.get(clientMessageId!);
      return json(receipt ? { ...base, status: "found", message: receipt.message, discussionId: receipt.discussionId,
        payloadDigest: receipt.digest, payloadMatches: receipt.digest === request.searchParams.get("payloadDigest") }
        : { ...base, status: "not_found" });
    }
    if (init.method === "POST" && request.pathname === "/__api/group-chats/messages") {
      if (request.searchParams.get("id") !== view.group.id) return failed("GROUP_CHAT_NOT_FOUND");
      const input = JSON.parse(String(init.body || "{}")) as GroupSendInput;
      if (!input.clientMessageId || typeof input.body !== "string" || (!input.body.trim() && !input.attachments?.length)) return failed("GROUP_CHAT_INVALID");
      if (input.ownerScope !== view.ownerScope) return failed("GROUP_CHAT_OWNER_CHANGED");
      const digest = await groupSendDigest(view.group.id, input), previous = receipts.get(input.clientMessageId);
      if (previous) return previous.digest === digest
        ? json({ message: previous.message, discussionId: previous.discussionId, duplicate: true }) : failed("GROUP_CHAT_MESSAGE_CONFLICT");
      if (view.group.status !== "active") return failed("GROUP_CHAT_ARCHIVED");
      if (input.expectedPolicyVersion !== view.group.policyVersion) return failed("GROUP_CHAT_POLICY_CHANGED");
      const quoted = input.replyTo == null ? null : messages.find(message => message.seq === input.replyTo);
      if (input.replyTo != null && !quoted) return failed("GROUP_CHAT_REPLY_NOT_FOUND");
      const seq = Math.max(view.group.lastSeq, ...messages.map(message => message.seq)) + 1;
      const discussionId = `preview-discussion-${input.clientMessageId}`;
      const message: GroupChatMessage = { id: `preview-message-${input.clientMessageId}`, groupId: view.group.id,
        seq, threadId: "main", author: { kind: "user" }, body: input.body,
        mentions: { memberIds: input.mentions, broadcast: false, unresolved: [] }, createdAt: Date.now(),
        attachments: input.attachments, origin: { discussionId }, revision: (view.group.messageRevision ?? 0) + 1,
        ...(quoted ? { replyTo: { seq: quoted.seq, messageId: quoted.id, author: quoted.author,
          excerpt: quoted.body.slice(0, 256), attachments: quoted.attachments } } : {}) };
      receipts.set(input.clientMessageId, { digest, message, discussionId });
      messages.push(message); view.group.lastSeq = seq; view.group.messageRevision = message.revision;
      return json({ message, discussionId, duplicate: false });
    }
    return null;
  };
}
