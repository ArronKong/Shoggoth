import type { GroupChatMessage, InspirationAttachment } from "../types";
import { projectJournalRecovery, type GroupJournalRecoveryPage } from "../../../group-journal-recovery";
export type { GroupJournalRecoveryPage } from "../../../group-journal-recovery";

export type GroupSendInput = {
  clientMessageId: string; body: string; mentions: string[]; replyTo?: number | null; taskId?: string;
  attachments?: InspirationAttachment[]; requestMode?: "auto" | "new" | "append" | "replace";
  discussionId?: string; summaryMemberId?: string; expectedPolicyVersion?: number; ownerScope?: string;
};
export type ComposerFile = { id: string; name: string; status: "uploading" | "ready" | "error"; attachment: InspirationAttachment | null };
export type GroupComposer = { text: string; mentionIds: string[]; replyTo: GroupChatMessage | null;
  replyTask: { id: string; objective: string } | null; requestRef: { id: string; label: string; mode: "append" | "replace" } | null;
  newRequest: boolean; summaryMemberId: string; files: ComposerFile[] };
export type ComposerSnapshot = { version: 1; key: string; ownerScope: string; groupId: string; draftId: string;
  revision: number; storageRevision: number; composer: GroupComposer; updatedAt: number; detached?: true };
export type SendPhase = "prepared" | "submitting" | "accepted_awaiting_echo" | "observed" | "rejected" | "needs_verification";
export type GroupSendRecord = { journalVersion: 1; key: string; ownerScope: string; groupId: string; clientMessageId: string;
  payloadDigest: string; inputSnapshot: GroupSendInput; draftId: string; draftRevision: number; composerSnapshot: GroupComposer;
  attachmentRefs: string[]; phase: SendPhase; revision: number; createdAt: number; lastCheckedAt: number | null;
  lastError: string | null; acceptedMessageId: string | null; acceptedSeq: number | null; discussionId: string | null };

export const GROUP_JOURNAL_CHANGED = "shoggoth:group-journal-changed";
export const GROUP_CONNECTION_EVENT = "shoggoth:group-connection";
export function emitGroupConnection() { window.dispatchEvent(new Event(GROUP_CONNECTION_EVENT)); }
export const emptyGroupComposer = (): GroupComposer => ({ text: "", mentionIds: [], replyTo: null, replyTask: null,
  requestRef: null, newRequest: false, summaryMemberId: "", files: [] });
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
export function canonicalGroupSendPayload(groupId: string, input: GroupSendInput): string {
  return JSON.stringify({ groupId, clientMessageId: input.clientMessageId, body: input.body, mentions: input.mentions ?? [],
    replyTo: input.replyTo ?? null, taskId: input.taskId ?? null,
    attachments: (input.attachments ?? []).map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size })),
    requestMode: input.requestMode ?? "auto", discussionId: input.discussionId ?? null,
    summaryMemberId: input.summaryMemberId ?? null, expectedPolicyVersion: input.expectedPolicyVersion ?? null });
}
export async function groupSendDigest(groupId: string, input: GroupSendInput): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalGroupSendPayload(groupId, input)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
const part = (value: string) => typeof value === "string" && value.length > 0 && value.length <= 512;
const sendKey = (scope: string, groupId: string, id: string) => JSON.stringify([scope, groupId, id]);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const terminal = (record: GroupSendRecord) => record.phase === "observed" || record.phase === "rejected";
const phases = new Set<SendPhase>(["prepared", "submitting", "accepted_awaiting_echo", "observed", "rejected", "needs_verification"]);
function validAttachment(value: unknown): value is InspirationAttachment {
  const item = value as InspirationAttachment;
  return !!item && part(item.id) && typeof item.name === "string" && typeof item.mimeType === "string"
    && Number.isSafeInteger(item.size) && item.size > 0;
}
function validComposer(value: unknown): value is GroupComposer {
  const item = value as GroupComposer;
  return !!item && typeof item.text === "string" && Array.isArray(item.mentionIds) && item.mentionIds.every(part)
    && typeof item.newRequest === "boolean" && typeof item.summaryMemberId === "string" && Array.isArray(item.files)
    && item.files.length <= 8 && item.files.every(file => file && part(file.id) && typeof file.name === "string"
      && ["uploading", "ready", "error"].includes(file.status) && (file.attachment === null || validAttachment(file.attachment)))
    && (item.replyTo === null || (!!item.replyTo && Number.isSafeInteger(item.replyTo.seq) && item.replyTo.seq >= 0
      && typeof item.replyTo.body === "string" && !!item.replyTo.author && ["user", "member"].includes(item.replyTo.author.kind)))
    && (item.replyTask === null || (!!item.replyTask && part(item.replyTask.id) && typeof item.replyTask.objective === "string"))
    && (item.requestRef === null || (!!item.requestRef && part(item.requestRef.id) && typeof item.requestRef.label === "string"
      && ["append", "replace"].includes(item.requestRef.mode)));
}
function validDraft(value: unknown): value is ComposerSnapshot {
  const item = value as ComposerSnapshot;
  return !!item && item.version === 1 && part(item.ownerScope) && part(item.groupId) && part(item.draftId)
    && item.key === sendKey(item.ownerScope, item.groupId, item.draftId) && Number.isSafeInteger(item.revision) && item.revision >= 0
    && Number.isSafeInteger(item.storageRevision) && item.storageRevision > 0 && validComposer(item.composer)
    && (item.detached === undefined || item.detached === true);
}
function validSend(value: unknown): value is GroupSendRecord {
  const item = value as GroupSendRecord;
  return !!item && item.journalVersion === 1 && part(item.ownerScope) && part(item.groupId) && part(item.clientMessageId)
    && item.key === sendKey(item.ownerScope, item.groupId, item.clientMessageId) && /^[a-f0-9]{64}$/.test(item.payloadDigest)
    && Number.isSafeInteger(item.revision) && item.revision > 0 && phases.has(item.phase) && !!item.inputSnapshot
    && item.inputSnapshot.clientMessageId === item.clientMessageId && typeof item.inputSnapshot.body === "string"
    && Array.isArray(item.inputSnapshot.mentions) && item.inputSnapshot.mentions.every(part)
    && (item.inputSnapshot.attachments === undefined || (Array.isArray(item.inputSnapshot.attachments) && item.inputSnapshot.attachments.every(validAttachment)))
    && validComposer(item.composerSnapshot) && part(item.draftId) && Number.isSafeInteger(item.draftRevision) && item.draftRevision >= 0
    && Array.isArray(item.attachmentRefs) && item.attachmentRefs.every(part);
}
export class GroupJournalError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "GroupJournalError"; }
}
type NativeGroupJournalBridge = { call(method: string, value: unknown): Promise<{ ok: boolean; value?: unknown; error?: { code?: string } }>;
  subscribe?(listener: (scope: { ownerScope: string; groupId: string }) => void): () => void };

/** Scope comes from the authoritative Store. No transport calls or replay behavior live here. */
export class GroupSendJournal {
  private database: Promise<IDBDatabase> | null = null;
  private channel: BroadcastChannel | null = null;
  private nativeDetected = false;
  private legacyAdoption: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;
  constructor(private factory: IDBFactory | undefined = globalThis.indexedDB,
    private name = "shoggoth-group-journal", private limits = { records: 1000, drafts: 256, bytes: 16 * 1024 * 1024,
      entryBytes: 256 * 1024, confirmedRetentionMs: 30 * 24 * 60 * 60 * 1000 }) {
    const desktop = typeof window === "undefined" ? null : (window as unknown as { openclawDesktop?: { groupSendJournal?: NativeGroupJournalBridge } }).openclawDesktop;
    if (typeof window !== "undefined" && "openclawDesktop" in window) this.nativeDetected = true;
    if (typeof desktop?.groupSendJournal?.subscribe === "function") {
      this.unsubscribe = desktop.groupSendJournal.subscribe(scope => window.dispatchEvent(new CustomEvent(GROUP_JOURNAL_CHANGED, { detail: scope })));
    } else if (!this.nativeDetected && typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(`${name}:changed`);
      this.channel.onmessage = event => {
        if (part(event.data?.ownerScope) && part(event.data?.groupId)) window.dispatchEvent(new CustomEvent(GROUP_JOURNAL_CHANGED, { detail: event.data }));
      };
    }
  }
  private nativeBridge(): NativeGroupJournalBridge | null {
    if (typeof window === "undefined") return null;
    if ("openclawDesktop" in window) this.nativeDetected = true;
    if (!this.nativeDetected) return null;
    const bridge = (window as unknown as { openclawDesktop?: { groupSendJournal?: NativeGroupJournalBridge } }).openclawDesktop?.groupSendJournal;
    if (typeof bridge?.call !== "function") throw new GroupJournalError("GROUP_JOURNAL_NATIVE_UNAVAILABLE");
    return bridge;
  }
  private async nativeRaw(bridge: NativeGroupJournalBridge, method: string, value: unknown): Promise<unknown> {
    const result = await bridge.call(method, copy(value));
    if (result?.ok !== true || !Object.hasOwn(result, "value")) throw new GroupJournalError(result?.error?.code ?? "GROUP_JOURNAL_NATIVE_UNAVAILABLE");
    return result.value;
  }
  private async nativeCall(bridge: NativeGroupJournalBridge, method: string, value: unknown): Promise<unknown> {
    if (!this.legacyAdoption) {
      const adoption = (async () => {
        if (!this.factory) return;
        if (typeof this.factory.databases === "function" && !(await this.factory.databases()).some(database => database.name === this.name)) return;
        const old = await this.transaction("readonly", (sends, drafts) => ({ sends, drafts }));
        if (old.sends.length || old.drafts.length) await this.nativeRaw(bridge, "importLegacy", old);
        // The former origin store remains intact as migration evidence; every subsequent write uses Main only.
      })();
      this.legacyAdoption = adoption;
      void adoption.catch(() => { if (this.legacyAdoption === adoption) this.legacyAdoption = null; });
    }
    await this.legacyAdoption;
    return this.nativeRaw(bridge, method, value);
  }
  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      if (!this.factory) { reject(new GroupJournalError("GROUP_JOURNAL_UNAVAILABLE")); return; }
      const request = this.factory.open(this.name, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("send_journal", { keyPath: "key" });
        request.result.createObjectStore("composer_snapshots", { keyPath: "key" });
      };
      request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); this.database = null; }; resolve(request.result); };
      request.onerror = () => reject(request.error ?? new GroupJournalError("GROUP_JOURNAL_UNAVAILABLE"));
      request.onblocked = () => reject(new GroupJournalError("GROUP_JOURNAL_BLOCKED"));
    });
    this.database = opening;
    void opening.catch(() => { if (this.database === opening) this.database = null; });
    return opening;
  }
  async close() { const database = await this.database; database?.close(); this.database = null; this.channel?.close(); this.channel = null;
    this.unsubscribe?.(); this.unsubscribe = null; }
  private async transaction<T>(mode: IDBTransactionMode, apply: (sends: GroupSendRecord[], drafts: ComposerSnapshot[], tx: IDBTransaction) => T): Promise<T> {
    const database = await this.open();
    return new Promise<T>((resolve, reject) => {
      const tx = database.transaction(["send_journal", "composer_snapshots"], mode);
      const sendRequest = tx.objectStore("send_journal").getAll(), draftRequest = tx.objectStore("composer_snapshots").getAll();
      let value: T, failure: unknown, loaded = 0;
      const ready = () => {
        if (++loaded !== 2) return;
        try {
          if (!sendRequest.result.every(validSend) || !draftRequest.result.every(validDraft)) throw new GroupJournalError("GROUP_JOURNAL_CORRUPT");
          value = apply(sendRequest.result, draftRequest.result, tx);
        } catch (error) { failure = error; tx.abort(); }
      };
      sendRequest.onsuccess = ready; draftRequest.onsuccess = ready;
      tx.oncomplete = () => resolve(copy(value));
      tx.onabort = () => reject(failure ?? tx.error ?? new GroupJournalError("GROUP_JOURNAL_WRITE_FAILED"));
      tx.onerror = () => { /* onabort rejects after the transaction has rolled back */ };
    });
  }
  private bounded(sends: GroupSendRecord[], drafts: ComposerSnapshot[], tx: IDBTransaction) {
    const retained = sends.filter(row => !terminal(row) || Date.now() - (row.lastCheckedAt ?? row.createdAt) < this.limits.confirmedRetentionMs);
    for (const row of sends) if (!retained.includes(row)) tx.objectStore("send_journal").delete(row.key);
    if (retained.length > this.limits.records || drafts.length > this.limits.drafts
      || [...retained, ...drafts].some(row => bytes(row) > this.limits.entryBytes)
      || bytes(retained) + bytes(drafts) > this.limits.bytes) throw new GroupJournalError("GROUP_JOURNAL_FULL");
  }
  async read(ownerScope: string, groupId: string): Promise<{ sends: GroupSendRecord[]; draft: ComposerSnapshot | null; foreignPending: number }> {
    if (!part(ownerScope) || !part(groupId)) throw new GroupJournalError("GROUP_JOURNAL_SCOPE_UNAVAILABLE");
    const bridge = this.nativeBridge();
    if (bridge) {
      const result = await this.nativeCall(bridge, "read", { ownerScope, groupId }) as { sends: GroupSendRecord[]; draft: ComposerSnapshot | null; foreignPending: number };
      if (!result || !Array.isArray(result.sends) || result.sends.some(row => !validSend(row) || row.ownerScope !== ownerScope || row.groupId !== groupId)
        || result.draft !== null && (!validDraft(result.draft) || result.draft.ownerScope !== ownerScope || result.draft.groupId !== groupId)
        || !Number.isSafeInteger(result.foreignPending) || result.foreignPending < 0) throw new GroupJournalError("GROUP_JOURNAL_CORRUPT");
      for (const row of result.sends) if (await groupSendDigest(groupId, row.inputSnapshot) !== row.payloadDigest) throw new GroupJournalError("GROUP_JOURNAL_CORRUPT");
      return copy(result);
    }
    const result = await this.transaction("readonly", (sends, drafts) => ({ sends: sends.filter(row => row.ownerScope === ownerScope && row.groupId === groupId),
      foreignPending: sends.filter(row => row.ownerScope !== ownerScope && row.groupId === groupId && !terminal(row)).length,
      draft: drafts.filter(row => row.ownerScope === ownerScope && row.groupId === groupId && !row.detached).sort((a, b) => {
        const emptyA = JSON.stringify(a.composer) === JSON.stringify(emptyGroupComposer()), emptyB = JSON.stringify(b.composer) === JSON.stringify(emptyGroupComposer());
        return Number(emptyA) - Number(emptyB) || b.updatedAt - a.updatedAt;
      })[0] ?? null }));
    for (const row of result.sends) if (await groupSendDigest(groupId, row.inputSnapshot) !== row.payloadDigest) throw new GroupJournalError("GROUP_JOURNAL_CORRUPT");
    return result;
  }
  async recover(ownerScope: string, groupId: string, offset = 0, snapshotDigest: string | null = null): Promise<GroupJournalRecoveryPage> {
    if (!part(ownerScope) || !part(groupId) || !Number.isSafeInteger(offset) || offset < 0 || offset > 1256
      || !(snapshotDigest === null || /^[a-f0-9]{64}$/u.test(snapshotDigest))) throw new GroupJournalError("GROUP_JOURNAL_INVALID");
    const bridge = this.nativeBridge();
    let result: GroupJournalRecoveryPage;
    if (bridge) {
      // Explicit read only: a damaged legacy row must not trigger migration or block Main's recovery view.
      result = await this.nativeRaw(bridge, "recover", { ownerScope, groupId, offset, snapshotDigest }) as GroupJournalRecoveryPage;
    } else {
      if (!this.factory) throw new GroupJournalError("GROUP_JOURNAL_UNAVAILABLE");
      const state = await new Promise<{ version: 1; sends: unknown[]; drafts: unknown[]; truncated: boolean }>((resolve, reject) => {
        const request = this.factory!.open(this.name); let retired = false;
        const refused = () => { retired = true; reject(new GroupJournalError("GROUP_JOURNAL_RECOVERY_UNAVAILABLE")); };
        request.onupgradeneeded = () => { request.transaction?.abort(); refused(); };
        request.onerror = refused; request.onblocked = refused;
        request.onsuccess = () => {
          const database = request.result;
          if (retired || database.version !== 1 || !database.objectStoreNames.contains("send_journal")
            || !database.objectStoreNames.contains("composer_snapshots")) { database.close(); refused(); return; }
          const tx = database.transaction(["send_journal", "composer_snapshots"], "readonly");
          const state = { version: 1 as const, sends: [] as unknown[], drafts: [] as unknown[], truncated: false }; let used = 0;
          for (const [name, rows, max] of [["send_journal", state.sends, 1000], ["composer_snapshots", state.drafts, 256]] as const) {
            const cursor = tx.objectStore(name).openCursor();
            cursor.onsuccess = () => {
              const current = cursor.result; if (!current) return;
              if (rows.length >= max) { state.truncated = true; return; }
              let size = Infinity; try { size = bytes(current.value); } catch { /* damaged cyclic or non-JSON value */ }
              if (!Number.isFinite(size) || size > 256 * 1024) { rows.push(null); state.truncated = true; current.continue(); return; }
              if (used + size > 16 * 1024 * 1024) { state.truncated = true; return; }
              used += size; rows.push(current.value); current.continue();
            };
          }
          tx.oncomplete = () => { database.close(); resolve(state); };
          tx.onabort = () => { database.close(); refused(); }; tx.onerror = () => { /* abort owns the error */ };
        };
      });
      const data = JSON.stringify({ version: 1, sends: state.sends, drafts: state.drafts, truncated: state.truncated });
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
      const currentDigest = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      if (offset > 0 && snapshotDigest !== currentDigest) throw new GroupJournalError("GROUP_JOURNAL_RECOVERY_CHANGED");
      result = projectJournalRecovery(state, { ownerScope, groupId, offset, snapshotDigest: currentDigest });
      result.collectionTruncated ||= state.truncated;
    }
    if (!result || result.ownerScope !== ownerScope || result.groupId !== groupId || result.readOnly !== true
      || !/^[a-f0-9]{64}$/u.test(result.snapshotDigest) || !Array.isArray(result.items) || result.items.length > 20
      || !result.items.every(item => item && ["send", "draft"].includes(item.kind) && part(item.id) && typeof item.text === "string"
        && new TextEncoder().encode(item.text).length <= 32 * 1024 && item.unverified === true && typeof item.truncated === "boolean"
        && Array.isArray(item.attachmentNames) && item.attachmentNames.length <= 8
        && item.attachmentNames.every(name => typeof name === "string" && name.length <= 512))
      || !Number.isSafeInteger(result.skipped) || result.skipped < 0 || result.skipped > 256
      || typeof result.collectionTruncated !== "boolean" || typeof result.hasMore !== "boolean"
      || (result.hasMore ? !Number.isSafeInteger(result.nextOffset) || result.nextOffset! <= offset || result.nextOffset! > 1256 : result.nextOffset !== null)) {
      throw new GroupJournalError("GROUP_JOURNAL_CORRUPT");
    }
    return copy(result);
  }
  async saveComposer(ownerScope: string, groupId: string, draftId: string, revision: number, composer: GroupComposer,
    expectedStorageRevision: number, detached = false): Promise<ComposerSnapshot> {
    if (!part(ownerScope) || !part(groupId) || !part(draftId)) throw new GroupJournalError("GROUP_JOURNAL_SCOPE_UNAVAILABLE");
    const key = sendKey(ownerScope, groupId, draftId);
    if (!validComposer(composer)) throw new GroupJournalError("GROUP_JOURNAL_CORRUPT");
    const bridge = this.nativeBridge();
    if (bridge) {
      const saved = await this.nativeCall(bridge, "saveComposer", { ownerScope, groupId, draftId, revision, composer, expectedStorageRevision, ...(detached ? { detached: true } : {}) }) as ComposerSnapshot;
      if (!validDraft(saved) || saved.key !== key || saved.revision !== revision || !!saved.detached !== detached || JSON.stringify(saved.composer) !== JSON.stringify(copy(composer))) throw new GroupJournalError("GROUP_JOURNAL_CORRUPT");
      this.changed(ownerScope, groupId); return copy(saved);
    }
    const result = await this.transaction("readwrite", (sends, drafts, tx) => {
      const previous = drafts.find(row => row.key === key);
      if ((previous?.storageRevision ?? 0) !== expectedStorageRevision) throw new GroupJournalError("GROUP_DRAFT_CONFLICT");
      const snapshot: ComposerSnapshot = { version: 1, key, ownerScope, groupId, draftId, revision,
        storageRevision: expectedStorageRevision + 1, composer: copy(composer), updatedAt: Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1), ...(detached ? { detached: true as const } : {}) };
      const protectedIds = new Set(sends.filter(row => !terminal(row)).map(row => row.draftId));
      const next = drafts.filter(row => row.key !== key && !(row.ownerScope === ownerScope && row.groupId === groupId
        && !protectedIds.has(row.draftId) && JSON.stringify(row.composer) === JSON.stringify(emptyGroupComposer())));
      for (const row of drafts) if (row.key !== key && !next.includes(row)) tx.objectStore("composer_snapshots").delete(row.key);
      next.push(snapshot); this.bounded(sends, next, tx);
      tx.objectStore("composer_snapshots").put(snapshot);
      return snapshot;
    });
    this.changed(ownerScope, groupId); return result;
  }
  async prepare(ownerScope: string, groupId: string, input: GroupSendInput, draft: ComposerSnapshot): Promise<GroupSendRecord> {
    if (!part(ownerScope) || draft.ownerScope !== ownerScope || draft.groupId !== groupId) throw new GroupJournalError("GROUP_JOURNAL_SCOPE_UNAVAILABLE");
    const immutable = copy(input), payloadDigest = await groupSendDigest(groupId, immutable), key = sendKey(ownerScope, groupId, input.clientMessageId);
    const bridge = this.nativeBridge();
    if (bridge) {
      const result = await this.nativeCall(bridge, "prepare", { ownerScope, groupId, inputSnapshot: immutable, draft }) as GroupSendRecord;
      if (!validSend(result) || result.key !== key || result.payloadDigest !== payloadDigest
        || canonicalGroupSendPayload(groupId, result.inputSnapshot) !== canonicalGroupSendPayload(groupId, immutable)) throw new GroupJournalError("GROUP_SEND_PAYLOAD_CONFLICT");
      this.changed(ownerScope, groupId); return copy(result);
    }
    const result = await this.transaction("readwrite", (sends, drafts, tx) => {
      const existing = sends.find(row => row.key === key);
      if (existing) {
        if (existing.payloadDigest !== payloadDigest || canonicalGroupSendPayload(groupId, existing.inputSnapshot) !== canonicalGroupSendPayload(groupId, immutable)) {
          throw new GroupJournalError("GROUP_SEND_PAYLOAD_CONFLICT");
        }
        return existing;
      }
      const stored = drafts.find(row => row.key === draft.key);
      if (!stored || stored.storageRevision < draft.storageRevision || stored.revision < draft.revision
        || (stored.revision === draft.revision && JSON.stringify(stored.composer) !== JSON.stringify(draft.composer))) throw new GroupJournalError("GROUP_DRAFT_CONFLICT");
      const record: GroupSendRecord = { journalVersion: 1, key, ownerScope, groupId, clientMessageId: input.clientMessageId,
        payloadDigest, inputSnapshot: immutable, draftId: draft.draftId, draftRevision: draft.revision, composerSnapshot: copy(draft.composer),
        attachmentRefs: (input.attachments ?? []).map(item => item.id), phase: "prepared", revision: 1, createdAt: Date.now(),
        lastCheckedAt: null, lastError: null, acceptedMessageId: null, acceptedSeq: null, discussionId: null };
      this.bounded([...sends, record], drafts, tx);
      tx.objectStore("send_journal").add(record); return record;
    });
    this.changed(ownerScope, groupId); return result;
  }
  async update(record: GroupSendRecord, patch: Partial<Pick<GroupSendRecord, "phase" | "lastCheckedAt" | "lastError" | "acceptedMessageId" | "acceptedSeq" | "discussionId">>): Promise<GroupSendRecord> {
    const bridge = this.nativeBridge();
    if (bridge) {
      const next = await this.nativeCall(bridge, "update", { record, patch }) as GroupSendRecord;
      if (!validSend(next) || next.key !== record.key || next.payloadDigest !== record.payloadDigest) throw new GroupJournalError("GROUP_SEND_PAYLOAD_CONFLICT");
      this.changed(record.ownerScope, record.groupId); return copy(next);
    }
    const result = await this.transaction("readwrite", (sends, drafts, tx) => {
      const current = sends.find(row => row.key === record.key);
      if (!current || current.payloadDigest !== record.payloadDigest) throw new GroupJournalError("GROUP_SEND_PAYLOAD_CONFLICT");
      if (current.phase === "observed" || current.phase === "rejected") return current;
      if (current.revision !== record.revision && !(patch.phase === "observed" || patch.phase === "accepted_awaiting_echo")) return current;
      if (current.phase === "accepted_awaiting_echo" && !["observed", "accepted_awaiting_echo"].includes(patch.phase ?? current.phase)) return current;
      const next = { ...current, ...patch, lastError: patch.lastError === undefined ? current.lastError : patch.lastError?.slice(0, 2000) ?? null,
        revision: current.revision + 1 };
      this.bounded([...sends.filter(row => row.key !== next.key), next], drafts, tx);
      tx.objectStore("send_journal").put(next); return next;
    });
    this.changed(record.ownerScope, record.groupId); return result;
  }
  async accepted(record: GroupSendRecord, message: GroupChatMessage, discussionId: string | null): Promise<{ record: GroupSendRecord; draft: ComposerSnapshot | null }> {
    const bridge = this.nativeBridge();
    if (bridge) {
      const result = await this.nativeCall(bridge, "accepted", { record, message: { id: message.id, groupId: message.groupId, seq: message.seq }, discussionId }) as { record: GroupSendRecord; draft: ComposerSnapshot | null };
      if (!result || !validSend(result.record) || result.record.key !== record.key || result.record.payloadDigest !== record.payloadDigest
        || result.record.phase !== "observed" || result.record.acceptedMessageId !== message.id || result.record.acceptedSeq !== message.seq
        || result.draft !== null && (!validDraft(result.draft) || result.draft.ownerScope !== record.ownerScope || result.draft.groupId !== record.groupId)) throw new GroupJournalError("GROUP_SEND_LOOKUP_IDENTITY_MISMATCH");
      this.changed(record.ownerScope, record.groupId); return copy(result);
    }
    const result = await this.transaction("readwrite", (sends, drafts, tx) => {
      const current = sends.find(row => row.key === record.key);
      if (!current || current.payloadDigest !== record.payloadDigest) throw new GroupJournalError("GROUP_SEND_PAYLOAD_CONFLICT");
      if (message.groupId !== record.groupId || !part(message.id) || !Number.isSafeInteger(message.seq) || message.seq < 0
        || (current.acceptedMessageId !== null && current.acceptedMessageId !== message.id)
        || (current.acceptedSeq !== null && current.acceptedSeq !== message.seq)) throw new GroupJournalError("GROUP_SEND_LOOKUP_IDENTITY_MISMATCH");
      const next: GroupSendRecord = { ...current, phase: "observed", acceptedMessageId: message.id, acceptedSeq: message.seq,
        discussionId, lastCheckedAt: Date.now(), lastError: null, revision: current.revision + 1 };
      let draft = drafts.find(row => row.ownerScope === record.ownerScope && row.groupId === record.groupId && row.draftId === record.draftId) ?? null;
      if (draft && draft.revision === record.draftRevision && JSON.stringify(draft.composer) === JSON.stringify(record.composerSnapshot)) {
        draft = { ...draft, composer: emptyGroupComposer(), revision: draft.revision + 1, storageRevision: draft.storageRevision + 1, updatedAt: Date.now() };
        tx.objectStore("composer_snapshots").put(draft);
      }
      this.bounded([...sends.filter(row => row.key !== next.key), next], drafts.filter(row => row.key !== draft?.key).concat(draft ? [draft] : []), tx);
      tx.objectStore("send_journal").put(next); return { record: next, draft };
    });
    this.changed(record.ownerScope, record.groupId); return result;
  }
  private changed(ownerScope: string, groupId: string) {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(GROUP_JOURNAL_CHANGED, { detail: { ownerScope, groupId } }));
    this.channel?.postMessage({ ownerScope, groupId });
  }
}
export const groupSendJournal = new GroupSendJournal();

/** Each session serializes its own writes. Cross-window collisions fail visibly rather than overwriting another draft. */
export class GroupDraftSession {
  draftId: string; revision: number; composer: GroupComposer;
  lastError: string | null = null;
  private storageRevision: number; private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly ownerScope: string, readonly groupId: string, snapshot: ComposerSnapshot | null,
    private journal = groupSendJournal) {
    this.draftId = snapshot?.draftId ?? crypto.randomUUID(); this.revision = snapshot?.revision ?? 0;
    this.storageRevision = snapshot?.storageRevision ?? 0; this.composer = copy(snapshot?.composer ?? emptyGroupComposer());
  }
  update(composer: GroupComposer) {
    if (JSON.stringify(composer) !== JSON.stringify(this.composer)) { this.composer = copy(composer); this.revision++; }
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation); this.queue = result.catch(() => {}); return result;
  }
  persist(): Promise<ComposerSnapshot> {
    const id = this.draftId, revision = this.revision, composer = copy(this.composer);
    return this.enqueue(async () => {
      if (id !== this.draftId) throw new GroupJournalError("GROUP_DRAFT_CONFLICT");
      try {
        const saved = await this.journal.saveComposer(this.ownerScope, this.groupId, id, revision, composer, this.storageRevision);
        this.storageRevision = saved.storageRevision; this.lastError = null; return saved;
      } catch (error) { this.lastError = error instanceof Error ? error.message : String(error); throw error; }
    });
  }
  async saveAsNewDraft() {
    await this.queue; this.draftId = crypto.randomUUID(); this.revision = 0; this.storageRevision = 0;
    return this.persist();
  }
  accepted(record: GroupSendRecord, message: GroupChatMessage, discussionId: string | null): Promise<boolean> {
    return this.enqueue(async () => {
      const result = await this.journal.accepted(record, message, discussionId);
      if (result.draft?.draftId === this.draftId) this.storageRevision = result.draft.storageRevision;
      if (this.draftId !== record.draftId || this.revision !== record.draftRevision) return false;
      this.composer = emptyGroupComposer(); this.revision++; return true;
    });
  }
}
