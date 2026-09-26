import { writeInspirationMedia } from '../api/client';
import type { InspirationAttachment } from '../types';

export const MAX_INSPIRATION_ATTACHMENTS = 8;
export const MAX_INSPIRATION_MEDIA_BYTES = 10 * 1024 * 1024;
export const MAX_INSPIRATION_VIDEO_BYTES = 50 * 1024 * 1024;
export const INSPIRATION_DOCUMENT_TYPES: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', json: 'application/json',
  pdf: 'application/pdf', rtf: 'application/rtf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  odt: 'application/vnd.oasis.opendocument.text', odp: 'application/vnd.oasis.opendocument.presentation',
  ods: 'application/vnd.oasis.opendocument.spreadsheet', zip: 'application/zip',
};
export const INSPIRATION_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'image/heic', 'image/heif', 'video/mp4', 'video/webm', 'video/quicktime',
  'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav',
  ...Object.values(INSPIRATION_DOCUMENT_TYPES), 'application/octet-stream'];
const FILE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', ...INSPIRATION_DOCUMENT_TYPES };
export const INSPIRATION_MEDIA_ACCEPT = '*/*';
export const inspirationMediaUrl = (id: string, preview = false) => `/__api/inspirations/media?id=${encodeURIComponent(id)}${preview ? '&preview=1' : ''}`;
export const normalizeMediaType = (type: string, name = '') => {
  const mime = type.split(';')[0].toLowerCase();
  const extension = name.split('.').pop()?.toLowerCase() || '';
  const normalized = INSPIRATION_DOCUMENT_TYPES[extension]
    || ({ 'audio/x-wav': 'audio/wav', 'audio/x-m4a': 'audio/mp4', 'video/x-m4v': 'video/mp4' }[mime]
    || ((!mime || mime === 'application/octet-stream') ? FILE_TYPES[extension] : mime));
  return normalized && INSPIRATION_MEDIA_TYPES.includes(normalized) ? normalized : 'application/octet-stream';
};
export const isInspirationDocument = (type: string) => !/^(image|audio|video)\//.test(type);
export const inspirationMediaLimit = (type: string) => type.startsWith('video/') || isInspirationDocument(type) ? MAX_INSPIRATION_VIDEO_BYTES : MAX_INSPIRATION_MEDIA_BYTES;

export type InspirationMediaGroup = { item: InspirationAttachment; motion?: InspirationAttachment };
export function groupInspirationMedia(attachments: InspirationAttachment[]): InspirationMediaGroup[] {
  const stem = (item: InspirationAttachment) => item.name.replace(/\.[^.]+$/, '').normalize('NFC').toLowerCase();
  const still = (item: InspirationAttachment) => ['image/jpeg', 'image/heic', 'image/heif'].includes(item.mimeType);
  const pairs = new Map<string, InspirationAttachment>();
  for (const item of attachments.filter(still)) {
    const photos = attachments.filter(other => still(other) && stem(other) === stem(item));
    const movies = attachments.filter(other => other.mimeType === 'video/quicktime' && stem(other) === stem(item)
      && (other.textOffset ?? 0) === (item.textOffset ?? 0));
    // Exported Live Photos contain a still and a same-name MOV. Ambiguous names stay separate.
    if (photos.length === 1 && movies.length === 1) pairs.set(item.id, movies[0]);
  }
  const motions = new Set([...pairs.values()].map(item => item.id));
  return attachments.filter(item => !motions.has(item.id)).map(item => ({ item, motion: pairs.get(item.id) }));
}

export function middleEllipsis(name: string, width: number, measure: (text: string) => number): string {
  if (width <= 0 || measure(name) <= width) return name;
  const chars = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(name), item => item.segment);
  let low = 0, high = chars.length - 1, best = '…';
  while (low <= high) {
    const count = Math.floor((low + high) / 2), head = Math.ceil(count / 2), tail = Math.floor(count / 2);
    const candidate = chars.slice(0, head).join('') + '…' + (tail ? chars.slice(-tail).join('') : '');
    if (measure(candidate) <= width) { best = candidate; low = count + 1; } else high = count - 1;
  }
  return best;
}

export function formatInspirationMediaTime(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0'00''";
  const seconds = Math.floor(value), hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return `${hours ? `${hours}h` : ''}${hours ? String(minutes).padStart(2, '0') : minutes}'${String(seconds % 60).padStart(2, '0')}''`;
}

export function validDraftAttachments(value: unknown): value is InspirationAttachment[] {
  return Array.isArray(value) && value.length <= MAX_INSPIRATION_ATTACHMENTS && value.every(item => item
    && typeof item.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item.id)
    && typeof item.name === 'string' && item.name.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(item.name)
    && new TextEncoder().encode(JSON.stringify(item.name)).length <= 256
    && INSPIRATION_MEDIA_TYPES.includes(item.mimeType) && Number.isSafeInteger(item.size) && item.size > 0 && item.size <= inspirationMediaLimit(item.mimeType)
    && (item.textOffset === undefined || (Number.isSafeInteger(item.textOffset) && item.textOffset >= 0 && item.textOffset <= 16 * 1024)))
    && new Set(value.map(item => item.id)).size === value.length;
}

export async function uploadInspirationMedia(file: File, id: string, alive: () => boolean, mimeType = normalizeMediaType(file.type, file.name)): Promise<InspirationAttachment | null> {
  const attachment = { id, name: file.name, mimeType, size: file.size };
  const chunkBytes = 24 * 1024;
  for (let offset = 0; offset < file.size; offset += chunkBytes) {
    if (!alive()) return null;
    const bytes = new Uint8Array(await file.slice(offset, offset + chunkBytes).arrayBuffer());
    if (!alive()) return null;
    const content = btoa(String.fromCharCode(...bytes));
    const result = await writeInspirationMedia({ attachment, offset, content });
    if (result.nextOffset !== offset + bytes.length || result.attachment.id !== id) throw new Error('Invalid attachment response');
  }
  return alive() ? attachment : null;
}
