import type { GlobalChatSearchHit } from '../types';

export const GROUP_REFERENCE_MAX_BYTES = 8192;
export const GROUP_MESSAGE_MAX_BYTES = 32 * 1024;
const bytes = (value: string) => new TextEncoder().encode(value).length;
const wellFormed = (value: string) => !/[\uD800-\uDFFF]/u.test(value);
const line = (value: string) => value.replace(/[\r\n\u0000]/gu, ' ');
export function groupReferenceExcerpt(hit: GlobalChatSearchHit, text: string, collectedAt: string,
  labels: { title: string; scope: string; source: string; session: string; message: string; time: string; unknown: string }): string | null {
  if (!text.trim() || !wellFormed(text) || text.includes('\0') || bytes(text) > GROUP_REFERENCE_MAX_BYTES) return null;
  if (![hit.agentName, hit.backendId, hit.agentId, hit.key].every(value => typeof value === 'string' && wellFormed(value))
    || hit.messageId !== undefined && (typeof hit.messageId !== 'string' || !wellFormed(hit.messageId))) return null;
  const rows = [labels.title, labels.scope, `${labels.source}: ${line(hit.agentName)} · ${line(hit.backendId)} / ${line(hit.agentId)}`,
    `${labels.session}: ${line(hit.key)}`, `${labels.message}: ${hit.messageId ? line(hit.messageId) : labels.unknown}`,
    `${labels.time}: ${collectedAt}`, '', text.replace(/\r\n?/gu, '\n')];
  return rows.join('\n').split('\n').map(value => `> ${value}`).join('\n');
}
export function appendGroupReference(draft: string, excerpt: string): string | null {
  const combined = `${draft}${draft ? '\n\n' : ''}${excerpt}`;
  return bytes(combined) <= GROUP_MESSAGE_MAX_BYTES ? combined : null;
}
