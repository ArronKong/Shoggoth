import type { InspirationExecution } from '../types';

type Listener = { runId: string; changed: () => void };
const sessions = new Map<string, Set<Listener>>();
let socket: WebSocket | null = null;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let handshake: ReturnType<typeof setTimeout> | undefined;
let ready = false;
let sequence = 0;

export function inspirationActivitySession(execution: InspirationExecution): string | null {
  if (!execution.sessionKey) return null;
  // The server supplies the public Chat route, including native Agent ownership.
  if (execution.sessionHref) {
    try {
      const href = execution.sessionHref;
      return new URLSearchParams(href.slice(href.indexOf('?') + 1)).get('session');
    } catch { return null; }
  }
  return ['openclaw', 'hermes'].includes(execution.backendId) || execution.sessionKey.startsWith('agent:')
    ? execution.sessionKey : `agent:${execution.agentId}:${execution.sessionKey}`;
}

function send(method: string, params: object, id = `inspiration-${++sequence}`) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'req', id, method, params }));
}

function watch(sessionKey: string) {
  // A read attaches the same recovery observer used when opening an active Chat.
  send('chat.history', { sessionKey, limit: 1 });
}

function disconnect() {
  clearTimeout(reconnect);
  clearTimeout(handshake);
  const previous = socket;
  socket = null;
  ready = false;
  previous?.close(); // Also releases the broker's session observers.
}

function connect() {
  if (socket || !sessions.size || typeof WebSocket === 'undefined') return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/__chatws`);
  socket = ws;
  const listId = `inspiration-sessions-${++sequence}`;
  ws.onopen = () => {
    if (socket !== ws) return;
    send('sessions.list', {}, listId);
    handshake = setTimeout(() => ws.close(), 15000);
  };
  ws.onmessage = event => {
    if (socket !== ws) return;
    let frame;
    try { frame = JSON.parse(event.data); } catch { return; }
    if (frame.type === 'res' && frame.id === listId) {
      clearTimeout(handshake);
      if (frame.ok !== true) { ws.close(); return; }
      ready = true;
      send('sessions.subscribe', {});
      for (const [key, listeners] of sessions) {
        watch(key);
        for (const listener of listeners) listener.changed();
      }
      return;
    }
    if (frame.type !== 'event' || !['chat', 'session.tool', 'session.message', 'agent'].includes(frame.event)) return;
    const payload = frame.payload;
    const listeners = sessions.get(payload?.sessionKey);
    if (!listeners) return;
    for (const listener of listeners) {
      if (payload.runId && payload.runId !== listener.runId) continue;
      // Some Chat observers omit runId. They only invalidate the exact-run REST
      // projection; their unscoped content can never overwrite another run.
      listener.changed();
    }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    ready = false;
    clearTimeout(handshake);
    if (sessions.size) reconnect = setTimeout(connect, 3000);
  };
  ws.onerror = () => ws.close();
}

/** One read-only Chat connection shared by all visible cards and the detail panel. */
export function watchInspirationActivity(sessionKey: string, runId: string, changed: () => void) {
  const listener = { runId, changed };
  let listeners = sessions.get(sessionKey);
  if (!listeners) {
    listeners = new Set();
    sessions.set(sessionKey, listeners);
    if (ready) watch(sessionKey);
  }
  listeners.add(listener);
  connect();
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    sessions.delete(sessionKey);
    // Chat history observers live until socket close. Rebuild the remaining
    // subscriptions after viewport changes, so off-screen runs release them.
    disconnect();
    if (sessions.size) reconnect = setTimeout(connect, 100);
  };
}
