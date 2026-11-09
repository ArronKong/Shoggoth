interface OptimisticChatMessage {
  role: string;
  localSendId?: string;
  idempotencyKey?: string;
  inspirationSendOperationId?: string;
}

type PendingPrompt<T> = { message: T; inspirationOperationId?: string };

export async function openClawInspirationSendOperationId(key: string, clientId: string): Promise<string> {
  // Same scoped identity as sendOperationId in the App's Inspiration bridge.
  const input = new TextEncoder().encode(`shoggoth-chat-send\0openclaw:${key}\0${clientId}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return `send-${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Renderer-only prompts awaiting transcript confirmation; never a send queue. */
export function createOptimisticChatHistory<T extends OptimisticChatMessage>() {
  const pending = new Map<string, Map<string, PendingPrompt<T>>>();
  return {
    remember(key: string, message: T, inspirationOperationId?: string) {
      if (message.role !== "user" || !message.localSendId) return;
      const entries = pending.get(key) ?? new Map<string, PendingPrompt<T>>();
      entries.set(message.localSendId, { message, inspirationOperationId });
      pending.set(key, entries);
    },
    merge(key: string, history: T[]): T[] {
      const entries = pending.get(key);
      if (!entries?.size) return history;
      const users = history.filter(message => message.role === "user");
      const confirmed = new Set(users.map(message => message.idempotencyKey));
      const confirmedInspiration = new Set(users.map(message => message.inspirationSendOperationId));
      for (const [id, { inspirationOperationId }] of entries) {
        // Inspiration sends use a separate Run ID in OpenClaw's transcript.
        // Their history projection links that Run back to the submitted operation.
        if (confirmed.has(id) || confirmed.has(`${id}:user`)
          || (inspirationOperationId && confirmedInspiration.has(inspirationOperationId))) entries.delete(id);
      }
      if (!entries.size) {
        pending.delete(key);
        return history;
      }
      // Reopening a running session can restore its existing local snapshot.
      // Keep those placeholders pending without appending them a second time.
      const localIds = new Set(users.map(message => message.localSendId));
      const missing = [...entries.values()].map(entry => entry.message).filter(message => !localIds.has(message.localSendId));
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
