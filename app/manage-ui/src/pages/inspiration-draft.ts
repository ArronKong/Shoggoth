import { useEffect, useRef, useState } from 'react';
import type { InspirationAttachment } from '../types';
import { validDraftAttachments } from './inspiration-media';

export const DRAFT_KEY = 'shoggoth.inspiration.capture.v1';
export type InspirationDraft = { body: string; operationId: string; paperTone?: number; attachments?: InspirationAttachment[] };
export const draftBytes = (value: string) => new TextEncoder().encode(JSON.stringify(value)).length;
export function pickNextPaperTone(previous: number): number {
  const choices = [0, 0, 1, 2, 3, 4, 5, 6, 7].filter(tone => tone !== previous);
  return choices[Math.floor(Math.random() * choices.length)];
}
export function readDraft(): InspirationDraft {
  try {
    const value = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    if (value && typeof value.body === 'string'
      && typeof value.operationId === 'string' && /^[0-9a-f-]{36}$/.test(value.operationId)
      && (value.attachments === undefined || validDraftAttachments(value.attachments))
      && (value.paperTone === undefined || (Number.isInteger(value.paperTone) && value.paperTone >= 0 && value.paperTone < 8))) {
      return { body: value.body, operationId: value.operationId,
        ...(value.attachments === undefined ? {} : { attachments: value.attachments }),
        ...(value.paperTone === undefined ? {} : { paperTone: value.paperTone }) };
    }
  } catch { /* The in-memory draft remains usable when storage is unavailable. */ }
  return { body: '', operationId: crypto.randomUUID(), paperTone: 0 };
}

// Main and desktop printers share a draft, but never clear a newer edit when an
// earlier save response arrives from the other window.
export function useInspirationDraft() {
  const [draft, setDraft] = useState(readDraft);
  const [draftStored, setDraftStored] = useState(true);
  const draftRef = useRef(draft); draftRef.current = draft;
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== DRAFT_KEY) return;
      const next = readDraft(); draftRef.current = next; setDraft(next); setDraftStored(true);
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  const storeDraft = (next: InspirationDraft) => {
    draftRef.current = next; setDraft(next);
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(next)); setDraftStored(true); } catch { setDraftStored(false); }
  };
  const updateDraft = (body: string, attachments = draftRef.current.attachments) => storeDraft({
    body, operationId: crypto.randomUUID(), paperTone: draftRef.current.paperTone ?? 0,
    ...(attachments === undefined ? {} : { attachments }),
  });
  const clearSavedDraft = (saved: InspirationDraft, nextTone: number) => {
    let latest = draftRef.current;
    try { if (localStorage.getItem(DRAFT_KEY)) latest = readDraft(); } catch { /* use memory */ }
    if (latest.operationId !== saved.operationId) {
      draftRef.current = latest; setDraft(latest); return false;
    }
    storeDraft({ body: '', operationId: crypto.randomUUID(), paperTone: nextTone });
    return true;
  };
  return { draft, draftRef, draftStored, updateDraft, clearSavedDraft };
}
