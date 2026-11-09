import type { GroupChatMember, GroupChatMessage } from "../types";
import type { GroupSendTarget, GroupSendTargetLock } from "../lib/groupSendJournal";

export type { GroupSendTarget } from "../lib/groupSendJournal";
export const OWNER_TARGET: GroupSendTarget = Object.freeze({ kind: "owner" });

/**
 * 最近一位发言的成员。seq 是最后一条成员消息的序号（用来判断「之后有没有人再发言」）；
 * target 跳过已移出的成员，保留发言者身份；还没人发言时交给群主。
 */
export function followLatestSpeaker(messages: GroupChatMessage[], active: GroupChatMember[]) {
  const activeIds = new Set(active.map(member => member.id));
  let seq = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const author = messages[index].author;
    if (author.kind !== "member") continue;
    seq ||= messages[index].seq;
    if (!activeIds.has(author.memberId)) continue;
    return { seq, target: { kind: "member", memberId: author.memberId } as GroupSendTarget };
  }
  return { seq, target: OWNER_TARGET };
}

/** A held mention disappears if its member leaves; it must not silently switch recipients. */
export function composerSendTarget(
  lock: GroupSendTargetLock | null, latest: ReturnType<typeof followLatestSpeaker>,
  active: GroupChatMember[], replyTo: GroupChatMessage | null,
): { target: GroupSendTarget; expired: boolean; invalid: boolean } {
  const expired = lock?.afterSeq != null && latest.seq > lock.afterSeq;
  const target = lock && !expired ? lock.target : replyTo?.author.kind === "member" ? OWNER_TARGET : latest.target;
  const invalid = target.kind === "member" && !active.some(member => member.id === target.memberId);
  return { target: invalid ? OWNER_TARGET : target, expired, invalid };
}

/** Implicit owner and quote routes need no chip. A member chosen from the picker is explicit. */
export function composerPrefill(
  target: GroupSendTarget, ownerId: string | null, replyTo: GroupChatMessage | null, manual: boolean,
): Exclude<GroupSendTarget, { kind: "owner" }> | null {
  if (target.kind === "all") return target;
  if (target.kind === "member" && manual) return target;
  const quoteId = replyTo?.author.kind === "member" ? replyTo.author.memberId : null;
  const memberId = target.kind === "member" ? target.memberId : manual && quoteId ? ownerId : null;
  return memberId && memberId !== quoteId && (memberId !== ownerId || manual && quoteId)
    ? { kind: "member", memberId } : null;
}

/** Structured mentions keep the original Markdown and byte budget, including for older drafts. */
export function sendTargetMentions(prefill: ReturnType<typeof composerPrefill>, active: GroupChatMember[], ownerId: string | null): string[] {
  if (!prefill) return [];
  if (prefill.kind === "member") return [prefill.memberId];
  const roster = [...active].sort((a, b) => a.position - b.position);
  return [...roster.filter(member => member.id === ownerId), ...roster.filter(member => member.id !== ownerId)].map(member => member.id);
}
