// Preview-only state. Never opens IndexedDB or the desktop journal bridge.
import type { ComposerSnapshot, GroupComposer, GroupSendInput, GroupSendRecord } from "../../app/manage-ui/src/lib/groupSendJournal";
import { emptyGroupComposer, groupSendDigest } from "../../app/manage-ui/src/lib/groupSendJournal";
import type { GroupChatMessage } from "../../app/manage-ui/src/types";

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const drafts = new Map<string, ComposerSnapshot>(), sends = new Map<string, GroupSendRecord>();
export const previewJournal = {
  async read(ownerScope: string, groupId: string) {
    return clone({ sends: [...sends.values()].filter(row => row.ownerScope === ownerScope && row.groupId === groupId),
      draft: [...drafts.values()].find(row => row.ownerScope === ownerScope && row.groupId === groupId) ?? null, foreignPending: 0 });
  },
  async saveComposer(ownerScope: string, groupId: string, draftId: string, revision: number, composer: GroupComposer,
    expectedStorageRevision: number, detached = false) {
    const key = JSON.stringify([ownerScope, groupId, draftId]);
    const snapshot: ComposerSnapshot = { version: 1, key, ownerScope, groupId, draftId, revision,
      storageRevision: expectedStorageRevision + 1, composer: clone(composer), updatedAt: Date.now(), ...(detached ? { detached: true } : {}) };
    drafts.set(key, snapshot); return clone(snapshot);
  },
  async prepare(ownerScope: string, groupId: string, input: GroupSendInput, draft: ComposerSnapshot) {
    const key = JSON.stringify([ownerScope, groupId, input.clientMessageId]);
    if (sends.has(key)) return clone(sends.get(key)!);
    const record: GroupSendRecord = { journalVersion: 1, key, ownerScope, groupId, clientMessageId: input.clientMessageId,
      inputSnapshot: clone(input), payloadDigest: await groupSendDigest(groupId, input), draftId: draft.draftId,
      draftRevision: draft.revision, composerSnapshot: clone(draft.composer), attachmentRefs: [], phase: "prepared", revision: 1,
      createdAt: Date.now(), lastCheckedAt: null, lastError: null, acceptedMessageId: null, acceptedSeq: null, discussionId: null };
    sends.set(key, record); return clone(record);
  },
  async update(record: GroupSendRecord, patch: Partial<GroupSendRecord>) {
    const next = { ...record, ...patch, revision: record.revision + 1 }; sends.set(record.key, next); return clone(next);
  },
  async accepted(record: GroupSendRecord, message: GroupChatMessage, discussionId: string | null) {
    const next = await previewJournal.update(record, { phase: "observed", acceptedMessageId: message.id, acceptedSeq: message.seq, discussionId });
    const key = JSON.stringify([record.ownerScope, record.groupId, record.draftId]);
    let draft = drafts.get(key) ?? null;
    if (draft?.revision === record.draftRevision) {
      draft = { ...draft, composer: emptyGroupComposer(), revision: draft.revision + 1, storageRevision: draft.storageRevision + 1 };
      drafts.set(key, draft);
    }
    return clone({ record: next, draft });
  },
  async recover() { throw new Error("PREVIEW_JOURNAL_RECOVERY_NOT_APPLICABLE"); },
  async close() {},
};
