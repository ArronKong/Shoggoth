import { useSyncExternalStore } from 'react';

const KEY = 'shoggoth.inspiration.return.v1'; // gitleaks:allow -- localStorage key name, not a credential
type ReturnPoint = { ideaId: string; sessionHref: string; returnTo?: string };
let memory: ReturnPoint | null = null;
let activeSession: { backendId: string; sessionKey: string } | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

// Chat consumes deep-link parameters and keeps the selected Session in memory.
// Publish that selection so navigation also updates when the user switches it.
export function setInspirationChatSession(session: typeof activeSession) {
  if (activeSession?.backendId === session?.backendId && activeSession?.sessionKey === session?.sessionKey) return;
  activeSession = session;
  notify();
}

function read(): ReturnPoint | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (value && typeof value.ideaId === 'string' && /^[0-9a-f-]{36}$/.test(value.ideaId)
      && typeof value.sessionHref === 'string' && value.sessionHref.startsWith('/chat?')) return value;
  } catch { /* The current tab still works when browser storage is unavailable. */ }
  return memory;
}

export function rememberInspirationReturn(ideaId: string, sessionHref: string, filter = 'saved') {
  memory = { ideaId, sessionHref, returnTo: `/inspirations?filter=${encodeURIComponent(filter)}&id=${encodeURIComponent(ideaId)}` };
  try { sessionStorage.setItem(KEY, JSON.stringify(memory)); } catch { /* Keep the in-memory return point. */ }
  notify();
}

export function forgetInspirationReturn(ideaId: string) {
  if (read()?.ideaId !== ideaId) return;
  memory = null;
  try { sessionStorage.removeItem(KEY); } catch { /* Storage may be unavailable. */ }
  notify();
}

export function inspirationReturnTarget(pathname: string, search: string) {
  const saved = read();
  if (!saved || !['/chat', '/'].includes(pathname)) return '/inspirations';
  const current = new URLSearchParams(search);
  const origin = new URLSearchParams(saved.sessionHref.split('?')[1]);
  const sessionKey = current.get('session') || activeSession?.sessionKey;
  const backendId = current.has('session') ? current.get('backend') : activeSession?.backendId;
  if (!sessionKey || sessionKey !== origin.get('session') || backendId !== origin.get('backend')) return '/inspirations';
  return typeof saved.returnTo === 'string' && saved.returnTo.startsWith('/inspirations?') && new URLSearchParams(saved.returnTo.split('?')[1]).get('id') === saved.ideaId
    ? saved.returnTo : `/inspirations?id=${encodeURIComponent(saved.ideaId)}`;
}

export function useInspirationReturnTarget(pathname: string, search: string) {
  return useSyncExternalStore(subscribe, () => inspirationReturnTarget(pathname, search));
}
