import type { InspirationAttachment } from '../types';
import { groupInspirationMedia } from './inspiration-media';

export type InspirationContentValue = { body: string; attachments: InspirationAttachment[] };
export type InspirationInsertionPoint = { offset: number; beforeId: string | null };
export type InspirationTextPart = {
  kind: 'text'; key: string; text: string; start: number; end: number;
  beforeId: string | null; precedingIds: string[];
};
type MediaPart = { kind: 'media'; key: string; attachments: InspirationAttachment[] };

export function inspirationContentParts({ body, attachments }: InspirationContentValue): Array<InspirationTextPart | MediaPart> {
  const groups = groupInspirationMedia(attachments).map(group => ({ ...group,
    offset: Math.min(body.length, group.item.textOffset ?? 0) }))
    .sort((a, b) => a.offset - b.offset);
  const parts: Array<InspirationTextPart | MediaPart> = [];
  const precedingIds: string[] = [];
  let start = 0, key = 'start';
  for (const { item, motion, offset } of groups) {
    parts.push({ kind: 'text', key, text: body.slice(start, offset), start, end: offset, beforeId: item.id, precedingIds: [...precedingIds] });
    const items = [item, ...(motion ? [motion] : [])];
    parts.push({ kind: 'media', key: item.id, attachments: items });
    precedingIds.push(...items.map(value => value.id));
    start = offset; key = item.id;
  }
  parts.push({ kind: 'text', key, text: body.slice(start), start, end: body.length, beforeId: null, precedingIds });
  return parts;
}

export function editInspirationText(content: InspirationContentValue, part: InspirationTextPart, text: string): InspirationContentValue {
  const body = content.body.slice(0, part.start) + text + content.body.slice(part.end);
  const delta = text.length - (part.end - part.start);
  return { body, attachments: content.attachments.map(item => part.precedingIds.includes(item.id) ? item
    : { ...item, textOffset: Math.max(0, Math.min(body.length, Math.min(content.body.length, item.textOffset ?? 0) + delta)) }) };
}

// Keep a recording/upload anchored while the user continues editing its text.
export function moveInspirationInsertion(point: InspirationInsertionPoint, part: InspirationTextPart, text: string): InspirationInsertionPoint {
  if (point.beforeId && part.precedingIds.includes(point.beforeId)) return point;
  let prefix = 0, suffix = 0;
  while (prefix < part.text.length && prefix < text.length && part.text[prefix] === text[prefix]) prefix++;
  while (suffix < part.text.length - prefix && suffix < text.length - prefix
    && part.text[part.text.length - 1 - suffix] === text[text.length - 1 - suffix]) suffix++;
  const from = part.start + prefix, to = part.end - suffix;
  const delta = text.length - part.text.length;
  return { ...point, offset: point.offset < from ? point.offset : point.offset >= to
    ? point.offset + delta : from + text.length - prefix - suffix };
}

export function insertInspirationMedia(content: InspirationContentValue, attachment: InspirationAttachment, point: InspirationInsertionPoint): InspirationContentValue {
  const items = [...content.attachments];
  const before = items.findIndex(item => item.id === point.beforeId);
  items.splice(before < 0 ? items.length : before, 0, { ...attachment, textOffset: Math.max(0, Math.min(content.body.length, point.offset)) });
  return { ...content, attachments: items };
}
