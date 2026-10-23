import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { chatUiRequest } from "../api/client";
import { nativeUiSummary, type NativeUiArtifactPart } from "../lib/chatUiContent";
import { attachNativeUiEntry, desktopUiReply, nativeUiDesktopBridge, nativeUiPoolEntry, openNativeUiEntry, updateNativeUiEntry } from "../lib/chatUiDesktop";
import { createUiPendingStore } from "../lib/chatUiPending";
import "./ChatUiArtifact.css";

const pending = createUiPendingStore(() => localStorage);
type Props = { part: NativeUiArtifactPart; backend: string; agentId: string; sessionKey: string; visible: boolean; autoActivate?: boolean;
  pluginSelection?: Array<{ installationId: string; revision: number }>; onCancel?: (runId: string) => Promise<unknown> };
export default function ChatUiArtifact({ part, backend, agentId, sessionKey, visible, autoActivate = true, pluginSelection = [], onCancel }: Props) {
  const { i18n } = useTranslation(), slot = useRef<HTMLDivElement>(null), slotId = useRef(Symbol("native-ui-slot"));
  const entry = useMemo(() => nativeUiPoolEntry({ backend, agentId, sessionKey, part }), [backend, agentId, sessionKey, part.sourceEventId, part.segmentId, part.artifactId]);
  const state = useSyncExternalStore(useCallback(listener => attachNativeUiEntry(entry, listener), [entry]), () => entry.value);
  const [source, setSource] = useState<string | null>(null), [sourceBusy, setSourceBusy] = useState(false), [expanded, setExpanded] = useState(false);
  useEffect(() => { if (state.sourceUnavailable) setSource(null); }, [state.sourceUnavailable]);
  const bridge = nativeUiDesktopBridge();
  const theme = (): "light" | "dark" => document.documentElement.dataset.theme === "dark"
    || document.documentElement.classList.contains("dark") ? "dark" : "light";
  const activate = useCallback(() => openNativeUiEntry(entry, theme(), i18n.language).catch(() => {}), [entry, i18n.language]);
  useEffect(() => {
    // Settled publications and history load without a click. Surface handover
    // preserves the card the user selected in the meantime.
    if (!bridge || !visible || !autoActivate || entry.autoActivationConsumed || entry.value.sourceUnavailable) return;
    entry.autoActivationConsumed = true;
    if (!entry.value.active && !entry.opening) void activate();
  }, [entry, bridge, visible, autoActivate, activate]);
  useLayoutEffect(() => {
    if (!visible || !state.active || !slot.current || !bridge) return;
    const ownSlot = slotId.current; entry.ownerSlot = ownSlot; entry.ownerElement = slot.current; let raf: number | null = null;
    const observed = new Set<Element>();
    const measure = () => {
      raf = null; const element = slot.current; if (!element || entry.ownerSlot !== ownSlot) return;
      const rect = element.getBoundingClientRect();
      let left = 0, top = 0, right = window.innerWidth, bottom = window.innerHeight;
      const resizeTargets = new Set<Element>([element]);
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
        resizeTargets.add(parent);
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
      }
      // The scrolling thread also extends behind floating controls. These
      // edges belong to its current surface, including the immersive handover.
      const surface = element.closest("[data-native-ui-surface]");
      surface?.querySelectorAll<HTMLElement>("[data-native-ui-clip-edge]").forEach(edge => {
        if (edge.closest("[data-native-ui-surface]") !== surface) return;
        resizeTargets.add(edge);
        const bounds = edge.getBoundingClientRect(), style = getComputedStyle(edge);
        if (!edge.getClientRects().length || style.visibility === "hidden" || bounds.width <= 0 || bounds.height <= 0
          || bounds.right <= Math.max(left, rect.left) || bounds.left >= Math.min(right, rect.right)) return;
        if (edge.dataset.nativeUiClipEdge === "top") top = Math.max(top, bounds.bottom);
        if (edge.dataset.nativeUiClipEdge === "bottom") bottom = Math.min(bottom, bounds.top);
      });
      for (const target of observed) if (!resizeTargets.has(target)) { resize.unobserve(target); observed.delete(target); }
      for (const target of resizeTargets) if (!observed.has(target)) { resize.observe(target); observed.add(target); }
      const occluded = !!document.querySelector('[aria-modal="true"], [role="menu"], [role="listbox"], .chat-ctxmenu, .session-menu, .model-menu, .slash-menu, .chat-artifacts-popover');
      void desktopUiReply(bridge.layout({ mountId: entry.mountId, layout: { generation: ++entry.generation,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        clip: { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }, occluded } })).catch(() => {});
    };
    const schedule = () => { if (raf === null) raf = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule), mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "hidden", "aria-modal", "data-native-ui-clip-edge"] });
    document.addEventListener("scroll", schedule, true); window.addEventListener("resize", schedule); measure();
    return () => { resize.disconnect(); mutations.disconnect(); document.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule);
      if (raf !== null) cancelAnimationFrame(raf);
      if (entry.ownerSlot === ownSlot) { entry.ownerSlot = null; entry.ownerElement = null;
        void bridge.layout({ mountId: entry.mountId, layout: { generation: ++entry.generation,
          rect: { x: 0, y: 0, width: 0, height: 0 }, clip: { x: 0, y: 0, width: 0, height: 0 }, occluded: true } }).catch(() => {}); }
    };
  }, [entry, bridge, visible, state.active, state.height, expanded, source]);
  useEffect(() => {
    if (!state.active || !bridge) return;
    const update = () => { void bridge.theme({ mountId: entry.mountId, theme: theme() }).catch(() => {}); };
    const observer = new MutationObserver(update); observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    update(); return () => observer.disconnect();
  }, [bridge, entry, state.active]);
  useEffect(() => {
    const originals = pending.read().filter(row => row.backendId === backend && row.agentId === agentId && row.sessionKey === sessionKey
      && row.artifactId === part.artifactId && row.revision === part.revision && row.sourceEventId === part.sourceEventId);
    if (!originals.length) return;
    updateNativeUiEntry(entry, { operation: { actionRequestId: originals.at(-1)!.actionRequestId, uncertain: true } });
    let canceled = false;
    void Promise.all(originals.map(async row => {
      try {
        const receipt = await chatUiRequest(backend, agentId, sessionKey, "operation", { actionRequestId: row.actionRequestId });
        if (!canceled && receipt.supported) {
          updateNativeUiEntry(entry, { operation: receipt });
          if (receipt.operationId) pending.accepted(row.actionRequestId, receipt.operationId);
          if (["completed", "failed", "cancelled", "expired"].includes(receipt.status)) pending.forget(row.actionRequestId);
        }
      } catch { /* Query again when the user reopens; never replay the action. */ }
    })); return () => { canceled = true; };
  }, [backend, agentId, sessionKey, part.artifactId, part.revision, part.sourceEventId, entry]);
  useEffect(() => {
    const operation = state.operation;
    if (!operation?.actionRequestId || operation.pending || ["completed", "failed", "cancelled", "expired"].includes(operation.status)) return;
    let canceled = false;
    const timer = setInterval(() => {
      void chatUiRequest(backend, agentId, sessionKey, "operation", { actionRequestId: operation.actionRequestId }).then(receipt => {
        if (canceled || !receipt.supported) return;
        updateNativeUiEntry(entry, { operation: receipt });
        if (bridge && state.active) void bridge.operation({ mountId: entry.mountId, actionRequestId: operation.actionRequestId }).catch(() => {});
        if (receipt.operationId) pending.accepted(operation.actionRequestId, receipt.operationId);
        if (["completed", "failed", "cancelled", "expired"].includes(receipt.status)) pending.forget(operation.actionRequestId);
      }).catch(error => {
        if (!canceled && (error as { code?: string }).code === "UI_OPERATION_EXPIRED") {
          if (bridge && state.active) void bridge.operation({ mountId: entry.mountId, actionRequestId: operation.actionRequestId }).catch(() => {});
          pending.forget(operation.actionRequestId); updateNativeUiEntry(entry, { operation: { ...operation, uncertain: false, status: "expired" } });
        }
      });
    }, 2000);
    return () => { canceled = true; clearInterval(timer); };
  }, [backend, agentId, sessionKey, entry, state.operation, state.active, bridge]);
  const readSource = async () => {
    if (source !== null) { setSource(null); return; }
    if (entry.value.sourceUnavailable) return;
    const revocationGeneration = entry.revocationGeneration; setSourceBusy(true);
    try {
      const chunks: Uint8Array[] = []; let offset = 0, hash = "", total = 0;
      do {
        if (entry.revocationGeneration !== revocationGeneration || entry.value.sourceUnavailable) return;
        const value = await chatUiRequest(backend, agentId, sessionKey, "export", { artifactId: part.artifactId, revision: part.revision, sourceEventId: part.sourceEventId, offset });
        if (!value.supported || value.offset !== offset || value.nextOffset <= offset || value.htmlBytes > 2097152 || (hash && hash !== value.htmlHash)) throw new Error("卡片源码无法核验");
        chunks.push(Uint8Array.from(atob(value.data), char => char.charCodeAt(0))); hash = value.htmlHash; total = value.htmlBytes; offset = value.nextOffset;
        if (value.done) break;
      } while (offset < 2097152);
      const bytes = new Uint8Array(offset); let start = 0; for (const chunk of chunks) { bytes.set(chunk, start); start += chunk.length; }
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(n => n.toString(16).padStart(2, "0")).join("");
      if (offset !== total || digest !== hash) throw new Error("卡片源码无法核验");
      if (entry.revocationGeneration !== revocationGeneration || entry.value.sourceUnavailable) return;
      setSource(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (error) { if (entry.revocationGeneration !== revocationGeneration || entry.value.sourceUnavailable) return; updateNativeUiEntry(entry, { error: error instanceof Error ? error.message : "源码暂时不可用" }); }
    finally { setSourceBusy(false); }
  };
  const action = async (event: React.MouseEvent, actionId: string) => {
    if (!event.nativeEvent.isTrusted || !bridge || !visible || state.loading || state.readOnly || entry.value.operation?.pending || entry.value.operation?.uncertain || entry.value.operation?.status === "unknown") return;
    const actionRequestId = crypto.randomUUID();
    if (!pending.remember({ backendId: backend, agentId, sessionKey, artifactId: part.artifactId, revision: part.revision,
      sourceEventId: part.sourceEventId, actionRequestId })) { updateNativeUiEntry(entry, { error: "无法记录这次操作，请先恢复本地存储" }); return; }
    updateNativeUiEntry(entry, { operation: { pending: true, actionRequestId } });
    try {
      const receipt = await desktopUiReply(bridge.action({ mountId: entry.mountId, actionId, actionRequestId, draftId: state.draftId, pluginSelection }));
      if (receipt.operationId) pending.accepted(actionRequestId, receipt.operationId);
      if (["completed", "failed", "cancelled", "expired"].includes(receipt.status)) pending.forget(actionRequestId);
      updateNativeUiEntry(entry, { operation: receipt, error: null });
    } catch (error) {
      const code = (error as { code?: string }).code;
      const definite = ["CODEX_DESKTOP_BUSY", "UI_HOST_REQUIRED", "UI_STATE_CONFLICT", "UI_SOURCE_EXPIRED", "UI_FEATURE_DISABLED", "UI_ACTION_INVALID"].includes(code || "");
      if (definite) pending.forget(actionRequestId);
      updateNativeUiEntry(entry, { error: error instanceof Error ? error.message : "操作结果待确认", operation: definite ? null : { actionRequestId, uncertain: true } });
    }
  };
  const summary = state.descriptor?.actions.flatMap(action => action.stateFields.map(key => `${key}: ${JSON.stringify(state.localState[key])}`)).filter((value, index, all) => all.indexOf(value) === index).join(" · ");
  const displayPart = state.sourceUnavailable ? { ...part, title: "卡片来源已失效", summary: "请重新生成交互卡片" } : part;
  return <section className={`chat-ui-artifact${expanded ? " is-expanded" : ""}`} data-native-ui-source={part.sourceEventId} aria-label={displayPart.title}>
    <header><div><strong>{displayPart.title}</strong><p>{displayPart.summary}</p></div><div className="chat-ui-artifact__tools">
      <button type="button" onClick={() => setExpanded(value => !value)}>{expanded ? "收起" : "展开"}</button>
      <button type="button" disabled={sourceBusy || state.sourceUnavailable} onClick={() => void readSource()}>{sourceBusy ? "读取中…" : source === null ? "源码" : "界面"}</button>
      {source !== null && !state.sourceUnavailable && <button type="button" onClick={() => {
        const url = URL.createObjectURL(new Blob([source], { type: "text/html;charset=utf-8" }));
        const link = document.createElement("a"); link.href = url; link.download = `shoggoth-ui-${part.artifactId}-v${part.revision}.html`;
        link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }}>导出 HTML</button>}
      {state.active && <button type="button" onClick={async () => { await bridge?.release({ mountId: entry.mountId }); updateNativeUiEntry(entry, { active: false }); void activate(); }}>重新加载</button>}
    </div></header>
    {source !== null && !state.sourceUnavailable ? <pre className="chat-ui-artifact__source">{source}</pre> : <div ref={slot} className="chat-ui-artifact__slot" style={{ height: expanded ? Math.max(560, state.height) : state.height }}>
      {!state.active && <div className="chat-ui-artifact__placeholder"><span>{state.sourceUnavailable ? "来源已失效，请重新生成" : state.loading ? "正在加载交互内容…" : bridge ? "交互内容暂未显示" : "在桌面应用中可操作这张卡片"}</span>
        {bridge && <button type="button" disabled={state.loading || state.sourceUnavailable || !visible} onClick={() => void activate()}>{state.loading ? "加载中…" : state.error ? "重新加载" : "显示交互卡片"}</button>}</div>}
    </div>}
    {state.error && <div className="chat-ui-artifact__notice" role="status">{state.error}</div>}
    {state.readOnly && <div className="chat-ui-artifact__notice">{state.readOnlyReason === "CODEX_DESKTOP_BUSY" ? "Codex 客户端正在运行，完成后可继续操作这张卡片" : "这张卡片当前仅供查看"}</div>}
    {summary && <div className="chat-ui-artifact__selection" title={summary}>{summary}</div>}
    {state.descriptor?.actions.map(item => <div className="chat-ui-artifact__action" key={item.actionId}>
      <span>{item.instruction}</span><button type="button" className={state.hintedAction === item.actionId ? "is-highlighted" : ""}
        disabled={!visible || !state.active || state.readOnly || state.operation?.pending === true || state.operation?.uncertain === true || state.operation?.status === "unknown"} onClick={event => void action(event, item.actionId)}>{item.label}</button>
    </div>)}
    {state.legacyPrompt && <div className="chat-ui-artifact__legacy-prompt"><span>卡片提供的待提交内容</span><pre>{state.legacyPrompt}</pre>
      <button type="button" onClick={() => { void navigator.clipboard.writeText(state.legacyPrompt || ""); }}>复制内容</button></div>}
    {state.operation && <div className="chat-ui-artifact__receipt" role="status">{state.operation.errorMessage || (state.operation.uncertain || state.operation.status === "unknown" ? "正在查询原操作的结果" : state.operation.pending ? "正在确认当前参数…" : ({ queued: "已排队", running: "正在分析", completed: "已完成", failed: "操作未完成", cancelled: "已取消", expired: "原操作已过期" } as Record<string, string>)[state.operation.status] || "操作已受理")}</div>}
    {onCancel && state.operation?.runId && ["queued", "accepted", "running"].includes(state.operation.status) && <button type="button"
      className="chat-ui-artifact__cancel" onClick={() => { void onCancel(state.operation.runId).catch(error => updateNativeUiEntry(entry, { error: error instanceof Error ? error.message : "暂时无法取消" })); }}>取消这次操作</button>}
    <span className="chat-ui-artifact__fallback" aria-hidden="true">{nativeUiSummary(displayPart)}</span>
  </section>;
}
