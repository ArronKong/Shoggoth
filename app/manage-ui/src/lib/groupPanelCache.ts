import type { GroupChatMessage, GroupChatView } from "../types";

export type GroupPanelSnapshot = {
  view: GroupChatView;
  messages: GroupChatMessage[];
  hasOlder: boolean;
  lastSyncAt: number;
};

/** Disposable, page-local history. Drafts and send receipts remain in the durable journal. */
export function createGroupPanelCache() {
  const entries = new Map<string, GroupPanelSnapshot>();
  return {
    get(groupId: string, ownerScope?: string): GroupPanelSnapshot | undefined {
      const snapshot = entries.get(groupId);
      if (!ownerScope || snapshot?.view.ownerScope !== ownerScope) {
        entries.delete(groupId);
        return undefined;
      }
      entries.delete(groupId);
      entries.set(groupId, snapshot);
      return snapshot;
    },
    put(snapshot: GroupPanelSnapshot) {
      const { view, messages } = snapshot;
      entries.delete(view.group.id);
      if (!view.ownerScope || view.group.status !== "active") return;
      // Keep the most recent messages; older retained pages remain reachable through pagination.
      entries.set(view.group.id, { ...snapshot, messages: messages.slice(-200),
        hasOlder: snapshot.hasOlder || messages.length > 200 });
      while (entries.size > 8) entries.delete(entries.keys().next().value!);
    },
    delete(groupId: string) { entries.delete(groupId); },
  };
}

export type GroupPanelCache = ReturnType<typeof createGroupPanelCache>;
