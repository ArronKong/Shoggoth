import type { InspirationAttachment } from '../types';

// A note is plain text with no title/body split. A note saved while titles existed, or titled through
// the MCP tools, shows that title as its first line; attachments keep their places in the text.
export function inspirationNoteContent(note: { title?: string | null; body: string; attachments?: InspirationAttachment[] }) {
  const attachments = note.attachments || [];
  if (!note.title) return { body: note.body, attachments };
  const prefix = note.body || attachments.length ? `${note.title}\n` : note.title;
  return { body: prefix + note.body,
    attachments: attachments.map(item => ({ ...item, textOffset: (item.textOffset ?? 0) + prefix.length })) };
}
