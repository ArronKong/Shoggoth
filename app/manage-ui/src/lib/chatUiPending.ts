// Observation identities are durable before a trusted button sends a request.
// They cannot replay a prompt, patch, action declaration or plugin selection.
export const CHAT_UI_PENDING_KEY = "shoggoth.chat.pending-ui-actions.v1";
export type PendingUiAction = { backendId: string; agentId: string; sessionKey: string;
  artifactId: string; revision: number; sourceEventId: string; actionRequestId: string;
  at: number; accepted?: true; operationId?: string };
type StorageLike = Pick<Storage, "getItem" | "setItem">;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const required = ["backendId", "agentId", "sessionKey", "artifactId", "revision", "sourceEventId", "actionRequestId", "at"];
const valid = (value: any): value is PendingUiAction => value && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).every(key => [...required, "accepted", "operationId"].includes(key))
  && required.every(key => Object.hasOwn(value, key))
  && ["backendId", "agentId", "sessionKey", "artifactId", "sourceEventId", "actionRequestId"].every(key => typeof value[key] === "string" && ID.test(value[key]))
  && Number.isSafeInteger(value.revision) && value.revision > 0 && Number.isSafeInteger(value.at) && value.at >= 0
  && (value.accepted === undefined || value.accepted === true)
  && (value.operationId === undefined || (value.accepted === true && typeof value.operationId === "string" && ID.test(value.operationId)));
export function createUiPendingStore(storage: () => StorageLike, now = Date.now) {
  const decode = (): PendingUiAction[] | null => {
    try {
      const list = JSON.parse(storage().getItem(CHAT_UI_PENDING_KEY) || "[]");
      return Array.isArray(list) && list.length <= 128 && list.every(valid)
        && new Set(list.map(row => row.actionRequestId)).size === list.length ? list : null;
    } catch { return null; }
  };
  const write = (list: PendingUiAction[]) => {
    if (list.length > 128) return false;
    try { storage().setItem(CHAT_UI_PENDING_KEY, JSON.stringify(list)); return true; } catch { return false; }
  };
  return {
    read: () => decode() || [],
    remember(identity: Omit<PendingUiAction, "at" | "accepted" | "operationId">) {
      const list = decode(), value = { ...identity, at: now() };
      if (!list || !valid(value)) return false;
      const previous = list.find(row => row.actionRequestId === value.actionRequestId);
      if (previous) return required.filter(key => key !== "at").every(key => previous[key as keyof PendingUiAction] === value[key as keyof PendingUiAction]);
      return write([...list, value]);
    },
    accepted(actionRequestId: string, operationId: string) {
      const list = decode(), entry = list?.find(row => row.actionRequestId === actionRequestId);
      if (!entry || (entry.operationId && entry.operationId !== operationId)) return false;
      const next = { ...entry, accepted: true as const, operationId };
      return valid(next) && write(list!.map(row => row === entry ? next : row));
    },
    forget(actionRequestId: string) {
      const list = decode(); return list !== null && write(list.filter(row => row.actionRequestId !== actionRequestId));
    },
  };
}
