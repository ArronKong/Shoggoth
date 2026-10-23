import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { chatUiRequest } from "../api/client";
import { normalizeNativeUiPart, type NativeUiArtifactPart } from "../lib/chatUiContent";
import { legacyHtmlBlocks } from "../lib/chatUiLegacy.mjs";
import ChatUiArtifact from "./ChatUiArtifact";

type LegacyEntry = { parts: Record<number, NativeUiArtifactPart>; listeners: Set<() => void> };
const imported = new Map<string, LegacyEntry>();
function entryFor(key: string): LegacyEntry {
  let entry = imported.get(key); if (entry) return entry;
  if (imported.size >= 128) for (const [oldKey, old] of imported) if (!old.listeners.size) { imported.delete(oldKey); if (imported.size < 128) break; }
  entry = { parts: {}, listeners: new Set() }; imported.set(key, entry); return entry;
}
export default function LegacyChatUi({ text, sourceEventId, backend, agentId, sessionKey, visible }: {
  text: string; sourceEventId: string; backend: string; agentId: string; sessionKey: string; visible: boolean;
}) {
  const blocks = useMemo(() => legacyHtmlBlocks(text).filter(block => block.runnable), [text]);
  const entry = useMemo(() => entryFor(`${backend}:${agentId}:${sessionKey}:${sourceEventId}`), [backend, agentId, sessionKey, sourceEventId]);
  const parts = useSyncExternalStore(useCallback(listener => { entry.listeners.add(listener); return () => { entry.listeners.delete(listener); }; }, [entry]), () => entry.parts);
  const [busy, setBusy] = useState<number | null>(null), [error, setError] = useState<string | null>(null);
  const preview = async (blockIndex: number) => {
    setBusy(blockIndex); setError(null);
    try {
      const result = await chatUiRequest(backend, agentId, sessionKey, "import", { sourceEventId, blockIndex });
      const part = normalizeNativeUiPart(result.part);
      if (!result.supported || !part || part.sourceEventId !== sourceEventId) throw new Error("历史界面暂时无法读取");
      entry.parts = { ...entry.parts, [blockIndex]: part }; for (const listener of entry.listeners) listener();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "历史界面暂时无法读取"); }
    finally { setBusy(null); }
  };
  if (!blocks.length) return null;
  return <div className="chat-ui-legacy">{blocks.map(block => parts[block.blockIndex]
    ? <ChatUiArtifact key={block.blockIndex} part={parts[block.blockIndex]} backend={backend} agentId={agentId} sessionKey={sessionKey} visible={visible} autoActivate />
    : <button type="button" key={block.blockIndex} disabled={busy !== null} onClick={() => void preview(block.blockIndex)}>
      {busy === block.blockIndex ? "正在读取历史界面…" : `预览历史界面${blocks.length > 1 ? ` ${block.blockIndex + 1}` : ""}`}</button>)}
    {error && <p role="status">{error}</p>}</div>;
}
