import type { GroupChatMember } from "../types";
import { BROADCAST_HANDLES, findMentionSpans } from "../../../agent-service/group-mentions";
import { GROUP_MESSAGE_MAX_BYTES } from "./groupReferenceExcerpt";

type Candidate = { name: string; member: GroupChatMember | null };
// null is an acknowledged broadcast; undefined is literal text.
export type GroupMentionPart = { text: string; member?: GroupChatMember | null };
export type GroupDraftMention = { start: number; end: number; memberId: string | null };
export type GroupDraftText = { text: string; mentions: GroupDraftMention[] };
const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("en-US");
const word = /[A-Za-z0-9_-]/u;

/** Handles are authoritative; a display name is usable only when it identifies one member. */
export function groupMentionCandidates(members: GroupChatMember[], broadcast = false): Candidate[] {
  const handles = new Map<string, GroupChatMember | null>();
  const names = new Map<string, GroupChatMember | null>();
  for (const member of members) {
    if (member.handle) handles.set(normalize(member.handle), member);
    const name = normalize(member.displayName);
    if (name) names.set(name, names.has(name) && names.get(name)?.id !== member.id ? null : member);
  }
  if (broadcast) for (const name of BROADCAST_HANDLES) handles.set(name, null);
  for (const [name, member] of names) if (member && !handles.has(name)) handles.set(name, member);
  return [...handles].map(([name, member]) => ({ name, member })).sort((a, b) => b.name.length - a.name.length);
}

/** Display-only links: no mention metadata, invitations or task actions are changed. */
export function splitGroupMentions(text: string, candidates: Candidate[]): GroupMentionPart[] {
  if (!candidates.length || !text.includes("@")) return [{ text }];
  const parts: GroupMentionPart[] = [];
  const maxLength = candidates[0].name.length;
  let consumed = 0;
  for (const site of text.matchAll(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+|@/giu)) {
    const at = site.index!;
    if (site[0] !== "@" || at < consumed || (at > 0 && /[A-Za-z0-9_.+%/\\-]/u.test(text[at - 1]))) continue;
    const suffix = normalize(text.slice(at + 1, at + 1 + maxLength * 2 + 2));
    const candidate = candidates.find(value => suffix.startsWith(value.name)
      && !(word.test(value.name.at(-1)!) && word.test(suffix[value.name.length] ?? "")));
    if (!candidate) continue;
    // NFKC may change character counts. Keep the original visible spelling and exact boundary.
    let end = at + 1;
    while (end < text.length && normalize(text.slice(at + 1, end)).length < candidate.name.length) {
      end += String.fromCodePoint(text.codePointAt(end)!).length;
    }
    if (normalize(text.slice(at + 1, end)) !== candidate.name) continue;
    if (at > consumed) parts.push({ text: text.slice(consumed, at) });
    parts.push({ text: text.slice(at, end), member: candidate.member });
    consumed = end;
  }
  if (consumed < text.length) parts.push({ text: text.slice(consumed) });
  return parts;
}

/** Older drafts stored selected member IDs without the positions of their handles. */
export function restoreDraftMentions(text: string, members: GroupChatMember[], selected: string[]): GroupDraftMention[] {
  if (!selected.length) return [];
  const ids = new Set(selected);
  const candidates = groupMentionCandidates(members).filter(({ name, member }) => member && ids.has(member.id) && name === normalize(member.handle));
  let end = 0;
  return splitGroupMentions(text, candidates).flatMap(({ text: part, member }) => {
    const start = end;
    end += part.length;
    return member ? [{ start, end, memberId: member.id }] : [];
  });
}

export function replaceGroupDraftText(draft: GroupDraftText, start: number, end: number, text: string,
  mention?: { length: number; memberId: string | null }): GroupDraftText {
  const shift = text.length - (end - start);
  return {
    text: draft.text.slice(0, start) + text + draft.text.slice(end),
    mentions: [
      ...draft.mentions.filter(span => span.end <= start),
      ...(mention ? [{ start, end: start + mention.length, memberId: mention.memberId }] : []),
      ...draft.mentions.filter(span => span.start >= end).map(span => ({ ...span, start: span.start + shift, end: span.end + shift })),
    ],
  };
}

/** Keep normal pastes native unless the inserted text contains a complete mention. */
export function pasteGroupDraftText(draft: GroupDraftText, start: number, end: number, text: string,
  members: GroupChatMember[]): GroupDraftText | null {
  if (!text.includes("@") || draft.text.length - (end - start) + text.length > GROUP_MESSAGE_MAX_BYTES) return null;
  const next = replaceGroupDraftText(draft, start, end, text);
  const remaining = 2048 - next.mentions.length;
  if (remaining <= 0) return null;
  // Scan the resulting draft so a paste inside an existing code block stays literal.
  const roster = members.map(member => ({ memberId: member.id, handle: member.handle }));
  const insertEnd = start + text.length;
  const pasted = findMentionSpans(next.text, roster).filter(span => span.start >= start && span.end <= insertEnd).slice(0, remaining);
  if (!pasted.length) return null;
  return { text: next.text, mentions: [...next.mentions, ...pasted].sort((left, right) => left.start - right.start) };
}

/** Keep the Markdown as written unless a chip's boundary would change its recipient. */
export function groupDraftBody({ text, mentions }: GroupDraftText, members: GroupChatMember[] = []): string {
  if (!mentions.length) return text.trim();
  const parsed = text.length <= GROUP_MESSAGE_MAX_BYTES
    ? findMentionSpans(text, members.map(member => ({ memberId: member.id, handle: member.handle }))) : [];
  const originalSpans = new Map(parsed.map(span => [span.start, span]));
  let body = "", end = 0;
  for (const span of mentions) {
    body += text.slice(end, span.start);
    const original = originalSpans.get(span.start);
    const alreadyDelimited = original?.end === span.end && original.memberId === span.memberId;
    if (!alreadyDelimited && /[A-Za-z0-9_.+%/\\-]/u.test(body.at(-1) ?? "")) body += " ";
    body += text.slice(span.start, span.end);
    const next = text.codePointAt(span.end);
    if (!alreadyDelimited && next !== undefined && /[\p{L}\p{N}\p{M}_@-]/u.test(String.fromCodePoint(next))) body += " ";
    end = span.end;
  }
  return (body + text.slice(end)).trim();
}
