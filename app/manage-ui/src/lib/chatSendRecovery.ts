// Pending operations are observation records, never replayable chat payloads.
// Keep the native v1 key so an update retains an earlier uncertain operation.
export const PENDING_CHAT_SENDS_KEY = "shoggoth.chat.pending-native-sends.v1";
export type RecoveryConnectorSelection = string;
export type RecoveryLegacyPluginSelection = { installationId: string; revision: number };
export type PendingChatSend = { key: string; idem: string; at: number;
  selection?: RecoveryConnectorSelection[]; legacySelection?: RecoveryLegacyPluginSelection[];
  accepted?: true; terminalObserved?: true; backendId?: "shoggoth" | "openclaw" | "hermes" };
type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function chatVerificationNoticeKey(pending?: PendingChatSend) {
  return pending?.accepted ? "chat.executionNeedsVerification"
    : pending ? "chat.sendNeedsVerification" : "chat.observeNeedsVerification";
}
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const legacySelectionValid = (value: unknown): value is RecoveryLegacyPluginSelection[] => Array.isArray(value)
  && value.length > 0 && value.length <= 4 && value.every(item => item && typeof item === "object"
    && Object.keys(item).sort().join(",") === "installationId,revision"
    && typeof item.installationId === "string" && ID.test(item.installationId)
    && Number.isSafeInteger(item.revision) && item.revision > 0);
const selectionValid = (value: unknown): value is RecoveryConnectorSelection[] => Array.isArray(value)
  && value.length > 0 && value.length <= 64 && value.every(item => typeof item === "string" && ID.test(item))
  && new Set(value).size === value.length;
const entryValid = (entry: any): entry is PendingChatSend => entry && typeof entry.key === "string"
  && entry.key.length > 0 && entry.key.length <= 256 && typeof entry.idem === "string" && ID.test(entry.idem)
  && Number.isSafeInteger(entry.at) && entry.at > 0 && (entry.accepted === undefined || entry.accepted === true)
  && (entry.selection === undefined || selectionValid(entry.selection))
  && (entry.legacySelection === undefined || legacySelectionValid(entry.legacySelection))
  && !(entry.selection && entry.legacySelection)
  && Object.keys(entry).every(key => ["key", "idem", "at", "selection", "legacySelection", "accepted", "terminalObserved", "backendId"].includes(key))
  && (entry.terminalObserved === undefined || (entry.terminalObserved === true && entry.backendId !== undefined))
  && (entry.backendId === undefined || ["shoggoth", "openclaw", "hermes"].includes(entry.backendId));

export function createPendingChatSendStore(storage: () => StorageLike, now = Date.now) {
  const decode = (): PendingChatSend[] | null => {
    try {
      const raw = JSON.parse(storage().getItem(PENDING_CHAT_SENDS_KEY) || "[]");
      if (!Array.isArray(raw)) return null;
      // Retain old uncertain-operation barriers without translating their old
      // installation IDs into connector accounts or replayable send payloads.
      const entries = raw.map(entry => {
        if (!legacySelectionValid(entry?.selection)) return entry;
        const { selection, ...record } = entry;
        return { ...record, legacySelection: selection };
      });
      return Array.isArray(entries) && entries.length <= 256 && entries.every(entryValid) ? entries : null;
    } catch { return null; }
  };
  const write = (entries: PendingChatSend[]) => {
    if (entries.length > 256) return false;
    try { storage().setItem(PENDING_CHAT_SENDS_KEY, JSON.stringify(entries)); return true; } catch { return false; }
  };
  const read = () => decode() ?? [];
  return {
    read,
    has: (key: string) => read().some(entry => entry.key === key),
    remember(key: string, idem: string, _historicalSelection?: readonly RecoveryConnectorSelection[], backendId?: string) {
      if (_historicalSelection?.length) return false; // Retired selections are never accepted for a new send.
      const entries = decode();
      if (!entries || entries.some(entry => entry.key === key && entry.idem !== idem)) return false;
      const previous = entries.find(entry => entry.key === key && entry.idem === idem);
      if (previous?.backendId && backendId && previous.backendId !== backendId) return false;
      const entry = previous ?? { key, idem, at: now(), ...(backendId ? { backendId } : {}) };
      return entryValid(entry) && write([...entries.filter(item => item.key !== key || item.idem !== idem), entry]);
    },
    accepted(key: string, idem: string) {
      const entries = decode();
      if (!entries) return false;
      return write(entries.map(entry => entry.key === key && entry.idem === idem ? { ...entry, accepted: true } : entry));
    },
    observeTerminal(key: string, idem: string, backendId: string) {
      const entries = decode();
      if (!entries?.some(entry => entry.key === key && entry.idem === idem && entry.backendId === backendId)) return false;
      return write(entries.map(entry => entry.key === key && entry.idem === idem && entry.backendId === backendId
        ? { ...entry, terminalObserved: true } : entry));
    },
    clearTerminalObservation(key: string, idem: string, backendId: string) {
      const entries = decode();
      if (!entries?.some(entry => entry.key === key && entry.idem === idem && entry.backendId === backendId)) return false;
      return write(entries.map(entry => {
        if (entry.key !== key || entry.idem !== idem || entry.backendId !== backendId) return entry;
        const { terminalObserved: _, ...active } = entry;
        return active;
      }));
    },
    forget(key: string, idem?: string) {
      const entries = decode();
      return entries !== null && write(entries.filter(entry => entry.key !== key || (idem !== undefined && entry.idem !== idem)));
    },
  };
}

export function shouldTrackChatSend(backendId: string, _historicalSelection?: readonly RecoveryConnectorSelection[]) {
  return backendId === "shoggoth";
}

export function classifyChatSendObservation(result: any, wasAccepted = false, terminalObserved = false, reconciled = false, nativeService = false) {
  if (reconciled && result?.status === "not_admitted" && result.run === null && !wasAccepted) {
    return { state: "terminal", accepted: false } as const;
  }
  if (result?.status !== "found" || !result.run) return { state: "verification", accepted: wasAccepted } as const;
  const status = result.run.status;
  const accepted = wasAccepted || result.admissionAccepted === true || result.run.admissionAccepted === true
    || ["accepted", "queued", "running", "completed"].includes(status);
  if (status === "needs_verification") return { state: "verification", accepted } as const;
  if (["completed", "failed", "canceled", "interrupted", "skipped"].includes(status)) {
    return { state: "terminal", accepted } as const;
  }
  // External Host receipts can lag their terminal event. Native Service writes
  // the WorkRun before publishing terminal events, so a fresh, identity-checked
  // lookup supersedes an old observer hint (including one restored on reload).
  // ChatPage fences queries superseded by newer live events before calling us.
  if (terminalObserved && !nativeService) return { state: "verification", accepted } as const;
  if (["accepted", "queued", "starting", "running", "waiting_input", "waiting_approval"].includes(status)) {
    return { state: "active", accepted } as const;
  }
  return { state: "verification", accepted } as const;
}

export function isUncertainChatSendReceipt(error: any) {
  return error?.receiptUncertain === true || error?.code === "PLUGIN_SELECTION_NEEDS_VERIFICATION"
    || error?.code === "CONNECTOR_SELECTION_NEEDS_VERIFICATION"
    || error?.code === "UPSTREAM_NEEDS_VERIFICATION";
}

export function isExplicitChatSendRejection(error: any) {
  // UNAVAILABLE is the Proxy's preflight-only, definitely-not-sent contract.
  // Busy/lost ACK/transport changes use NEEDS_VERIFICATION instead.
  if (isUncertainChatSendReceipt(error)) return false;
  return error?.requestNotSent === true || error?.admissionAccepted === false
    || error?.code === "PLUGIN_SELECTION_UNAVAILABLE" || error?.code === "CONNECTOR_SELECTION_UNAVAILABLE"
    || error?.code === "PLUGIN_PLATFORM_RETIRED";
}
