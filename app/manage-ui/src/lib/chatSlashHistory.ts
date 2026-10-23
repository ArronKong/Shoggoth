interface SlashMessage {
  role: string;
  ts?: number;
  id?: string;
  parts: unknown[];
  pending?: boolean;
  localSlashId?: string;
}

// Slash output is not part of the backend transcript. Keep the submitted pair
// in its original session/position when a live turn reloads canonical history.
export function createChatSlashHistory<T extends SlashMessage>() {
  type Entry = { messages: T[]; after?: T };
  const sessions = new Map<string, Map<string, Entry>>();
  const sameMessage = (a: T, b: T) => a.id && b.id ? a.id === b.id
    : a.role === b.role && a.ts === b.ts && JSON.stringify(a.parts) === JSON.stringify(b.parts);
  return {
    begin(key: string, id: string, messages: T[], previous: T[]) {
      const entries = sessions.get(key) ?? new Map<string, Entry>();
      entries.set(id, { messages, after: previous.slice().reverse().find(message => !message.localSlashId && !message.pending) });
      sessions.set(key, entries);
    },
    has(key: string, id: string) { return sessions.get(key)?.has(id) === true; },
    finish(key: string, id: string, result: T) {
      const entry = sessions.get(key)?.get(id);
      if (entry) entry.messages = [entry.messages[0], result];
    },
    forget(key: string, id?: string) {
      if (id) sessions.get(key)?.delete(id);
      else sessions.delete(key);
    },
    merge(key: string, history: T[]): T[] {
      const entries = sessions.get(key);
      if (!entries?.size && !history.some(message => message.localSlashId)) return history;
      // Discard stale cached projections after clear/reset or component teardown.
      const next = history.filter(message => !message.localSlashId || entries?.has(message.localSlashId));
      let floor = 0;
      for (const [id, entry] of entries ?? []) {
        let index = next.findIndex(message => message.localSlashId === id);
        if (index >= 0) {
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i].localSlashId === id) next.splice(i, 1);
          }
        } else {
          const ts = entry.messages[0].ts ?? 0;
          index = next.findIndex(message => !message.localSlashId && typeof message.ts === "number" && message.ts >= ts);
          if (index < 0) index = next.length;
          const anchor = entry.after ? next.findIndex(message => sameMessage(message, entry.after!)) : -1;
          index = Math.max(index, anchor + 1);
        }
        index = Math.max(index, floor);
        next.splice(index, 0, ...entry.messages);
        floor = index + entry.messages.length;
      }
      return next;
    },
  };
}
