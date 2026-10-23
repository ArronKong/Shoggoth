import { nativeUiPartKey, type NativeUiArtifactPart } from "./chatUiContent";
export interface NativeUiAction { actionId: string; kind: "continue_agent"; label: string; instruction: string; stateFields: string[] }
export interface NativeUiDescriptor { supported: boolean; enabled: boolean; part: NativeUiArtifactPart; actions: NativeUiAction[];
  legacy: boolean; readOnly: boolean; readOnlyReason: string | null; htmlHash: string; htmlBytes: number }
export interface NativeUiSnapshot {
  active: boolean; loading: boolean; sourceUnavailable: boolean; error: string | null; height: number; state: Record<string, unknown>;
  localState: Record<string, unknown>; stateRevision: number; draftId: string; readOnly: boolean;
  readOnlyReason: string | null; descriptor: NativeUiDescriptor | null; hintedAction: string | null;
  operation: any | null; legacyPrompt: string | null;
}
export interface NativeUiDesktopBridge {
  mount(value: unknown): Promise<any>; layout(value: unknown): Promise<any>; theme(value: unknown): Promise<any>;
  release(value: unknown): Promise<any>; action(value: unknown): Promise<any>; operation(value: unknown): Promise<any>;
  subscribe(listener: (value: any) => void): () => void;
}
export const nativeUiDesktopBridge = () => (window as unknown as { openclawDesktop?: { chatUi?: NativeUiDesktopBridge } }).openclawDesktop?.chatUi;
export async function desktopUiReply(promise: Promise<any>) {
  const reply = await promise;
  if (reply?.ok !== true) throw Object.assign(new Error(reply?.error?.message || "卡片暂时不可用"), { code: reply?.error?.code });
  return reply.result;
}
type Owner = { backend: string; agentId: string; sessionKey: string; part: NativeUiArtifactPart };
export type NativeUiPoolEntry = Owner & { key: string; mountId: string; refs: number; ownerSlot: symbol | null; ownerElement: HTMLElement | null;
  generation: number; revocationGeneration: number; autoActivationConsumed: boolean; value: NativeUiSnapshot; listeners: Set<() => void>; closeTimer: ReturnType<typeof setTimeout> | null;
  opening?: Promise<void>; releaseEvents?: () => void };
const pool = new Map<string, NativeUiPoolEntry>();
export function nativeUiPoolEntry(owner: Owner): NativeUiPoolEntry {
  const key = `${owner.backend}:${owner.agentId}:${owner.sessionKey}:${nativeUiPartKey(owner.part)}`;
  let entry = pool.get(key);
  if (!entry) {
    if (pool.size >= 128) for (const [oldKey, old] of pool) if (!old.refs && !old.value.active && !old.opening) { pool.delete(oldKey); if (pool.size < 128) break; }
    entry = { ...owner, key, mountId: crypto.randomUUID(), refs: 0, ownerSlot: null, ownerElement: null, generation: 0, revocationGeneration: 0, autoActivationConsumed: false, listeners: new Set(), closeTimer: null,
      value: { active: false, loading: false, sourceUnavailable: false, error: null, height: 320, state: {}, localState: {}, stateRevision: 0,
        draftId: "", readOnly: false, readOnlyReason: null, descriptor: null, hintedAction: null, operation: null, legacyPrompt: null } };
    pool.set(key, entry);
  }
  return entry;
}
export function updateNativeUiEntry(entry: NativeUiPoolEntry, patch: Partial<NativeUiSnapshot>) {
  entry.value = { ...entry.value, ...patch }; for (const listener of entry.listeners) listener();
}
export function attachNativeUiEntry(entry: NativeUiPoolEntry, listener: () => void) {
  clearTimeout(entry.closeTimer || undefined); entry.closeTimer = null; entry.refs++; entry.listeners.add(listener);
  if (!entry.releaseEvents) entry.releaseEvents = nativeUiDesktopBridge()?.subscribe(value => {
    if (value.mountId !== entry.mountId) return;
    if (value.type === "state" && !entry.value.sourceUnavailable) updateNativeUiEntry(entry, { state: value.state, localState: value.localState,
      stateRevision: value.stateRevision, draftId: value.draftId, readOnly: value.readOnly, readOnlyReason: value.readOnlyReason });
    else if (value.type === "resize") updateNativeUiEntry(entry, { height: Math.max(120, Math.min(1200, value.height)) });
    else if (value.type === "revoked") {
      entry.revocationGeneration++;
      updateNativeUiEntry(entry, { active: false, loading: false, descriptor: null,
        sourceUnavailable: entry.value.sourceUnavailable || value.code !== "UI_FEATURE_DISABLED",
        state: {}, localState: {}, legacyPrompt: null, readOnly: true, readOnlyReason: value.code || "UI_SOURCE_EXPIRED", error: value.code === "UI_FEATURE_DISABLED" ? "交互功能当前不可用" : "卡片来源已失效" });
    }
    else if (value.type === "inactive") updateNativeUiEntry(entry, { active: false, loading: false });
    else if (value.type === "legacy-prompt" && typeof value.text === "string") updateNativeUiEntry(entry, { legacyPrompt: value.text });
    else if (value.type === "action-hint") updateNativeUiEntry(entry, { hintedAction: value.actionId });
    else if (value.type === "status" && value.code) updateNativeUiEntry(entry, { error: value.code === "UI_SCRIPT_ERROR"
      ? "卡片脚本出错，可以重新加载" : value.code === "UI_RENDERER_UNRESPONSIVE" ? "卡片暂时无响应，可以重新加载" : "卡片暂时不可用，可以重新加载" });
    else if (value.type === "focus-return") {
      const owner = entry.ownerElement; if (!owner?.isConnected) return;
      // Both surfaces can remain in the DOM during immersive handover. Focus
      // belongs to the currently visible slot, rather than the first composer.
      const surface = owner.closest("[data-native-ui-surface]");
      const composer = (surface || document).querySelector<HTMLTextAreaElement>(surface
        ? "[data-chat-composer] textarea" : ".chat-compose textarea, .chat-composer textarea, textarea.chat-input");
      if (composer?.isConnected && !composer.disabled) composer.focus();
    }
  });
  return () => {
    entry.listeners.delete(listener); entry.refs--;
    if (entry.refs) return;
    // React may move the same source from pending to final, from one display
    // group to another, or into immersive. Keep the native view through that
    // DOM handover; a real departure closes its renderer/port/lease.
    entry.closeTimer = setTimeout(() => {
      if (entry.refs) return;
      void nativeUiDesktopBridge()?.release({ mountId: entry.mountId }).catch(() => {});
      entry.releaseEvents?.(); entry.releaseEvents = undefined;
      // A real departure releases the view. Returning to this conversation
      // loads it again; a short ordinary/immersive handover keeps this flag.
      entry.autoActivationConsumed = false;
      updateNativeUiEntry(entry, { active: false, loading: false });
    }, 250);
  };
}
export function openNativeUiEntry(entry: NativeUiPoolEntry, theme: "light" | "dark", locale: string): Promise<void> {
  if (entry.opening) return entry.opening;
  const bridge = nativeUiDesktopBridge(); if (!bridge) return Promise.reject(new Error("请在 Shoggoth 桌面应用中操作这张卡片"));
  const revocationGeneration = entry.revocationGeneration;
  updateNativeUiEntry(entry, { loading: true, error: null });
  entry.opening = desktopUiReply(bridge.mount({ backend: entry.backend, agentId: entry.agentId, sessionKey: entry.sessionKey,
    part: entry.part, mountId: entry.mountId, theme, locale: locale.startsWith("zh") ? "zh-CN" : "en" })).then(value => {
    if (entry.revocationGeneration !== revocationGeneration) {
      void bridge.release({ mountId: entry.mountId }).catch(() => {});
      throw Object.assign(new Error("卡片来源已失效"), { code: entry.value.readOnlyReason || "UI_SOURCE_EXPIRED" });
    }
    updateNativeUiEntry(entry, { active: true, loading: false, sourceUnavailable: false, descriptor: value.descriptor, state: value.state,
      localState: value.state, stateRevision: value.stateRevision, draftId: value.draftId,
      readOnly: value.readOnly, readOnlyReason: value.readOnlyReason });
  }).catch(error => { updateNativeUiEntry(entry, { active: false, loading: false,
    sourceUnavailable: entry.value.sourceUnavailable || error.code === "UI_SOURCE_EXPIRED", error: error.message }); throw error; })
    .finally(() => { entry.opening = undefined; });
  return entry.opening;
}

export function revokeNativeUiEntries(sessionKey: string, artifactId: string | null, revision: number | null, reason: string) {
  for (const entry of pool.values()) if (entry.sessionKey === sessionKey && (!artifactId
    || entry.part.artifactId === artifactId && entry.part.revision === revision)) {
    entry.generation++; entry.revocationGeneration++;
    void nativeUiDesktopBridge()?.release({ mountId: entry.mountId }).catch(() => {});
    updateNativeUiEntry(entry, { active: false, loading: false, descriptor: null, state: {}, localState: {}, legacyPrompt: null,
      sourceUnavailable: entry.value.sourceUnavailable || reason !== "UI_FEATURE_DISABLED", readOnly: true, readOnlyReason: reason, error: reason === "UI_FEATURE_DISABLED" ? "交互功能当前不可用" : "卡片来源已失效" });
  }
}
