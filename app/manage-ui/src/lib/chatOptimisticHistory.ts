interface OptimisticChatMessage {
  role: string;
  localSendId?: string;
  idempotencyKey?: string;
}

/** Renderer-only prompts awaiting transcript confirmation; never a send queue. */
export function createOptimisticChatHistory<T extends OptimisticChatMessage>() {
  const pending = new Map<string, Map<string, T>>();
  return {
    remember(key: string, message: T) {
      if (message.role !== "user" || !message.localSendId) return;
      const entries = pending.get(key) ?? new Map<string, T>();
      entries.set(message.localSendId, message);
      pending.set(key, entries);
    },
    merge(key: string, history: T[]): T[] {
      const entries = pending.get(key);
      if (!entries?.size) return history;
      const confirmed = new Set(history.filter(message => message.role === "user")
        .map(message => message.idempotencyKey).filter((id): id is string => !!id));
      for (const id of entries.keys()) {
        // OpenClaw records the submitted operation as <operationId>:user.
        // Repeated text and a different run's final are not confirmation.
        if (confirmed.has(id) || confirmed.has(`${id}:user`)) entries.delete(id);
      }
      if (!entries.size) {
        pending.delete(key);
        return history;
      }
      // Reopening a running session can restore its existing local snapshot.
      // Keep those placeholders pending without appending them a second time.
      const localIds = new Set(history.filter(message => message.role === "user")
        .map(message => message.localSendId));
      const missing = [...entries.values()].filter(message => !localIds.has(message.localSendId));
      return missing.length ? [...history, ...missing] : history;
    },
    forget(key: string, id?: string) {
      if (id === undefined) pending.delete(key);
      else {
        const entries = pending.get(key);
        entries?.delete(id);
        if (!entries?.size) pending.delete(key);
      }
    },
  };
}
