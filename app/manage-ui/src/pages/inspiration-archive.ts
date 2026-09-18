import { zip, strToU8 } from 'fflate';
import { listInspirations } from '../api/client';
import type { InspirationAttachment, InspirationIdea } from '../types';
import { inspirationMediaUrl, validDraftAttachments } from './inspiration-media';

export const MAX_INSPIRATION_ARCHIVE_BYTES = 256 * 1024 * 1024;
export const MAX_INSPIRATION_ARCHIVE_NOTES = 1000;
export type ArchiveDraft = { body: string; attachments?: InspirationAttachment[]; paperTone?: number };
type ArchiveNote = Pick<InspirationIdea, 'id' | 'body' | 'title' | 'favorite' | 'archivedAt' | 'acceptedAt' | 'createdAt' | 'updatedAt'> & {
  paperTone: number; attachments: InspirationAttachment[];
};
const error = (code: string): never => { throw new Error(code); };
const safeName = (name: string) => name.replace(/[\\/<>:"|?*\x00-\x1f\x7f]/g, '_').replace(/^\.+$/, '_');

export async function collectInspirationNotes(draft: ArchiveDraft): Promise<ArchiveNote[]> {
  const notes = new Map<string, ArchiveNote>();
  // The normal "all" page intentionally excludes archived notes.
  for (const filter of ['all', 'archived'] as const) {
    let cursor: string | null = null;
    const cursors = new Set<string>();
    do {
      const page = await listInspirations({ query: '', filter, cursor, limit: 50 });
      for (const idea of page.items) notes.set(idea.id, {
        id: idea.id, body: idea.body, title: idea.title, favorite: idea.favorite, archivedAt: idea.archivedAt,
        acceptedAt: idea.acceptedAt, createdAt: idea.createdAt, updatedAt: idea.updatedAt,
        paperTone: idea.paperTone ?? 0, attachments: idea.attachments ?? [],
      });
      if (notes.size > MAX_INSPIRATION_ARCHIVE_NOTES) error('archiveTooLarge');
      cursor = page.hasMore ? page.nextCursor : null;
      if (page.hasMore && (!cursor || cursors.has(cursor))) error('archiveReadFailed');
      if (cursor) cursors.add(cursor);
    } while (cursor);
  }
  if (draft.body.trim() || draft.attachments?.length) {
    const at = Date.now(), id = crypto.randomUUID();
    notes.set(id, { id, body: draft.body, title: null, favorite: false, archivedAt: null, acceptedAt: null,
      createdAt: at, updatedAt: at, paperTone: draft.paperTone ?? 0, attachments: draft.attachments ?? [] });
  }
  if (!notes.size) error('archiveEmpty');
  if (notes.size > MAX_INSPIRATION_ARCHIVE_NOTES) error('archiveTooLarge');
  return [...notes.values()];
}

export async function buildInspirationArchive(notes: ArchiveNote[], onProgress: (done: number, total: number) => void = () => {}): Promise<Uint8Array> {
  const entries: Record<string, Uint8Array> = Object.create(null);
  const files = new Map<string, InspirationAttachment & { path: string; sha256: string }>();
  const descriptors = new Map<string, InspirationAttachment>();
  if (!notes.length || notes.length > MAX_INSPIRATION_ARCHIVE_NOTES) error('archiveTooLarge');
  for (const note of notes) {
    if (new TextEncoder().encode(JSON.stringify(note.body)).length > 16 * 1024 || !validDraftAttachments(note.attachments)
      || note.attachments.some(item => (item.textOffset ?? 0) > note.body.length)) error('archiveReadFailed');
    for (const item of note.attachments) {
      const previous = descriptors.get(item.id);
      if (previous && ['name', 'size', 'mimeType'].some(key => previous[key as keyof InspirationAttachment] !== item[key as keyof InspirationAttachment])) error('archiveReadFailed');
      descriptors.set(item.id, item);
    }
  }
  let bytes = 0, done = 0;
  for (const item of descriptors.values()) {
    bytes += item.size;
    if (bytes > MAX_INSPIRATION_ARCHIVE_BYTES) error('archiveTooLarge');
    const response = await fetch(inspirationMediaUrl(item.id));
    if (!response.ok) error('archiveReadFailed');
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.length !== item.size) error('archiveReadFailed');
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), byte => byte.toString(16).padStart(2, '0')).join('');
    const path = `files/${item.id}/${safeName(item.name)}`;
    entries[path] = data;
    files.set(item.id, { id: item.id, name: item.name, mimeType: item.mimeType, size: item.size, path, sha256 });
    onProgress(++done, descriptors.size);
  }
  // The manifest is authoritative; Markdown is a convenient, readable copy.
  for (const note of notes) {
    let body = '', cursor = 0;
    const attachments = note.attachments.map((item, index) => ({ item, index })).sort((a, b) =>
      (a.item.textOffset ?? 0) - (b.item.textOffset ?? 0) || a.index - b.index);
    for (const { item } of attachments) {
      const offset = item.textOffset ?? 0;
      body += note.body.slice(cursor, offset);
      body += `\n\n[${item.name.replace(/[\\[\]]/g, '\\$&')}](../${files.get(item.id)!.path.split('/').map(encodeURIComponent).join('/')})\n\n`;
      cursor = offset;
    }
    entries[`notes/${note.id}.md`] = strToU8((note.title ? `# ${note.title}\n\n` : '') + body + note.body.slice(cursor));
  }
  entries['manifest.json'] = strToU8(JSON.stringify({ format: 'shoggoth.inspirations', version: 1, createdAt: Date.now(), notes, files: [...files.values()] }, null, 2));
  entries['README.txt'] = strToU8('Shoggoth Inspiration Archive v1\n\nmanifest.json preserves note text, attachment positions and metadata.\nnotes/ contains readable Markdown copies; files/ contains unmodified originals.\nLive Photos retain both their still image and same-name MOV.\nAgent execution history, sessions and credentials are not included.\n');
  const expandedSize = Object.values(entries).reduce((total, value) => total + value.length, 0);
  if (expandedSize > MAX_INSPIRATION_ARCHIVE_BYTES) error('archiveTooLarge');
  const output = await new Promise<Uint8Array>((resolve, reject) => zip(entries, { level: 0 }, (failure, value) => failure ? reject(failure) : resolve(value)));
  if (output.length > MAX_INSPIRATION_ARCHIVE_BYTES) error('archiveTooLarge');
  return output;
}

type SaveHandle = { createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }> };
type ArchiveHost = { saveInspirationArchive?: (input: { name: string; bytes: Uint8Array }) => Promise<{ canceled?: boolean; ok: boolean; error?: string }> };

// Request browser file access in the click handler while activation is still live.
export async function chooseInspirationArchiveDestination(name: string): Promise<((bytes: Uint8Array) => Promise<boolean>) | null> {
  const host = (window as unknown as { openclawDesktop?: ArchiveHost }).openclawDesktop;
  if (host?.saveInspirationArchive) return async bytes => {
    const result = await host.saveInspirationArchive!({ name, bytes });
    if (!result.ok) error('archiveSaveFailed');
    return !result.canceled;
  };
  const picker = (window as unknown as { showSaveFilePicker?: (input: unknown) => Promise<SaveHandle> }).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({ suggestedName: name, types: [{ description: 'Shoggoth', accept: { 'application/zip': ['.zip'] } }] });
      return async bytes => {
        const writer = await handle.createWritable();
        try { await writer.write(bytes); await writer.close(); return true; }
        catch (failure) { await writer.abort().catch(() => {}); throw failure; }
      };
    } catch (failure) { if ((failure as Error).name === 'AbortError') return null; throw failure; }
  }
  return async bytes => {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/zip' }));
    const link = document.createElement('a'); link.href = url; link.download = name; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return true;
  };
}
