"use strict";

// 成员每次发言收到的输入（群聊单一机制，见 docs/architecture/group-room-single-mechanism-2026-10-17.md）：
// 群名、成员、自上次以来别人说的话（"名字: 正文"）、本轮发言顺序和"你是第几位"、几条回复规则。
// 不带协议字段、编号或摘要；同伴说的话是对话内容，不是给当前成员的指令。

// 一次发言最多直接带给运行时的附件数（与私聊的 chat.send 上限一致）。
const MAX_TURN_ATTACHMENTS = 8;
// 单条消息给成员看的最多字数；更长的截断并注明总字数。
const MAX_LINE_CHARS = 8000;
const MAX_ROLE_CHARS = 24;

const chars = (text) => Array.from(String(text ?? ""));
function cut(text, max) {
  const all = chars(text);
  return all.length <= max ? all.join("") : `${all.slice(0, max).join("")}… (truncated; ${all.length} characters total)`;
}

/** 系统事件在群里的一句话；旧机制留下的事件（任务、协调者等）不再给成员看，返回 null。 */
function systemText(message, nameOf) {
  const system = message.system || {};
  const name = nameOf(system.memberId);
  if (system.eventType === "renamed") return `Group renamed to "${system.name}"`;
  if (system.eventType === "member_added") return `${name} joined the group`;
  if (system.eventType === "member_removed") return `${name} left the group`;
  if (system.eventType === "turn_failed") return system.errorCode === "GROUP_TURN_TIMEOUT" ? `${name} did not respond` : `${name} could not answer`;
  if (system.eventType === "turn_stopped") return `The user stopped ${name}'s work`;
  if (system.eventType === "work_done") return `${name} finished the assigned work`;
  return null;
}

/**
 * 这次输入里用户和同伴的消息带的附件。最新的 MAX_TURN_ATTACHMENTS 个直接交给成员，更早的只在消息行里列出文件名。
 * @returns {{ attachments: object[], omitted: number }}
 */
function turnAttachments(messages) {
  const all = [];
  const seen = new Set();
  for (const message of messages) {
    if (message.author.kind === "system") continue;
    for (const item of message.attachments ?? []) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      all.push({ ...item, seq: message.seq });
    }
  }
  const kept = all.slice(-MAX_TURN_ATTACHMENTS);
  return { attachments: kept, omitted: all.length - kept.length };
}

function messageLine(message, nameOf, selfId) {
  if (message.author.kind === "system") {
    const text = systemText(message, nameOf);
    return text && `[${text}]`;
  }
  const speaker = message.author.kind === "user" ? "user"
    : `${nameOf(message.author.memberId)}${message.author.memberId === selfId ? " (you)" : ""}`;
  const quoted = message.replyTo
    ? ` (reply to ${message.replyTo.author?.kind === "user" ? "user" : nameOf(message.replyTo.author?.memberId)} "${cut(message.replyTo.excerpt ?? "", 60)}")`
    : "";
  const files = message.attachments?.length ? ` [Files: ${message.attachments.map(item => item.name).join(", ")}]` : "";
  // 正文的后续行缩进两格：每位发言者都从行首开始，正文里写的"用户: …"不会被当成另一个人。
  const body = cut(message.body ?? "", MAX_LINE_CHARS).split(/\r?\n/u).join("\n  ");
  return `${speaker}${quoted}: ${body}${files}`;
}

const STATUS_TEXT = { posted: "posted", passed: "passed", missed: "no response", failed: "failed", working: "working",
  approval: "awaiting approval", busy: "busy", stopped: "stopped", left: "left" };

/**
 * @param {{ group: {name: string, purpose?: string}, member: object, members: object[], ownerId: string|null,
 *   earlier: object[], current: object[], omitted?: number, spokeThisRound?: boolean,
 *   order: {memberId: string, status: string|null}[], position: number,
 *   working?: {memberId: string, since: number}[], note: string, now?: number,
 *   attachmentPath?: (attachment: object) => string|null, readHistory?: boolean }} input
 *   order 里当前发言者的 status 为 "speaking"；attachmentPath 只给没有原生附件通道的外部成员；
 *   readHistory 表示成员有 group_messages_read 可以回查没列出的消息（原生成员）。
 */
function renderRoomPrompt({ group, member, members, ownerId, earlier, current, omitted = 0, spokeThisRound = false,
  order, position, working = [], note, now = Date.now(), attachmentPath = null, readHistory = false }) {
  const byId = new Map(members.map(item => [item.id, item]));
  const nameOf = (id) => byId.get(id)?.displayName ?? "a former member";
  const leads = member.id === ownerId;
  const peers = members.filter(item => item.id !== member.id && item.state === "active").map(item => {
    const tags = [item.id === ownerId ? "owner" : null, item.card?.role ? cut(item.card.role, MAX_ROLE_CHARS) : null].filter(Boolean);
    return `${item.displayName}${tags.length ? ` (${tags.join(", ")})` : ""}`;
  });
  const lines = (list) => list.map(message => messageLine(message, nameOf, member.id)).filter(Boolean);
  const before = order.slice(0, position).length;
  const after = order.length - position - 1;
  const minutes = (since) => Math.max(1, Math.round((now - since) / 60_000));
  const parts = [
    `[Group "${group.name}" · ${note}]`,
    `Members: user${peers.length ? `, ${peers.join(", ")}` : ""} and you (${member.displayName}${leads ? ", owner" : ""}). `
      + "Speak one at a time; the next member sees your posted message. Use @Name to invite a reply or work; respond when their work returns. Omit @ for a mere mention.",
    leads ? "You are the owner. Answer ordinary unaddressed messages yourself. If the user asks everyone for separate replies, use @all or name every intended responder in this reply. Do not delegate inviting the next member. Invite only the requested people for a partial request." : "",
    group.purpose?.trim() ? `Group notice: ${group.purpose.trim()}` : "",
    earlier.length ? `Before this round (reference only):\n${lines(earlier).join("\n")}` : "",
    current.length
      ? `${spokeThisRound ? "Since your last turn this round" : "Round so far"} (oldest first):\n${lines(current).join("\n")}`
      : "No new messages since your last turn.",
    omitted > 0 ? `(${omitted} earlier messages not listed${readHistory ? "; read them with group_messages_read when needed" : ""})` : "",
    working.length ? `Still working; results will return: ${working.map(item => `${nameOf(item.memberId)} (${minutes(item.since)} min)`).join(", ")}.` : "",
    `Current speaking queue: ${order.map((slot, index) => (index === position ? "you (now)"
      : `${nameOf(slot.memberId)}${STATUS_TEXT[slot.status] ? ` (${STATUS_TEXT[slot.status]})` : ""}`)).join(" → ")}.`,
    `Your queued position: ${position + 1}/${order.length}; ${before === 0 ? "no earlier slots" : `${before} earlier slots`}`
      + `${after === 0 ? "; no members queued after you; invite others if the user requested it." : `; ${after} after you will see this message.`}`,
    "Reply in the user's language. Write the message without a name prefix; keep discussion brief. If asked to work, use tools now: the group can move on while you work. "
      + "Briefly state your intent, share material findings, then give results; do not promise to work later. With nothing new or nothing addressed to you, reply only (pass). "
      + "To share a file, end with a separate line: Attachment: file path.",
  ];
  if (attachmentPath) {
    const { attachments } = turnAttachments([...earlier, ...current]);
    if (attachments.length) parts.push(`Attached files (read these local paths when needed):\n${attachments.map(item =>
      `- ${item.name} (${item.mimeType}): ${attachmentPath(item) ?? "local path unavailable"}`).join("\n")}`);
  }
  return parts.filter(Boolean).join("\n\n");
}

module.exports = { MAX_TURN_ATTACHMENTS, renderRoomPrompt, systemText, turnAttachments };
