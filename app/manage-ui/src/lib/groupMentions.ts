import type { GroupChatMember } from "../types";

type Candidate = { name: string; member: GroupChatMember };
export type GroupMentionPart = { text: string; member?: GroupChatMember };
const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("en-US");
const word = /[A-Za-z0-9_-]/u;

/** Handles are authoritative; a display name is usable only when it identifies one member. */
export function groupMentionCandidates(members: GroupChatMember[]): Candidate[] {
  const handles = new Map<string, GroupChatMember>();
  const names = new Map<string, GroupChatMember | null>();
  for (const member of members) {
    if (member.handle) handles.set(normalize(member.handle), member);
    const name = normalize(member.displayName);
    if (name) names.set(name, names.has(name) && names.get(name)?.id !== member.id ? null : member);
  }
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
