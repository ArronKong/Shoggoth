import { useState } from "react";
import { useTranslation } from "react-i18next";
import { openPluginApp } from "../api/client";

// A result reference is only a UI hint. The Service verifies the durable call,
// current conversation, account and Grants again before the native prompt.
export function pluginAppCallReference(output: string | undefined): string | null {
  if (!output || output.length > 256 * 1024) return null;
  let value: unknown;
  try { value = JSON.parse(output); } catch { return null; }
  const visit = (node: unknown, depth = 0): string | null => {
    if (depth > 5 || !node || typeof node !== "object") return null;
    const object = node as Record<string, unknown>;
    const reference = object.shoggothPluginApp as { callId?: unknown } | undefined;
    if (reference && typeof reference.callId === "string" && /^runtime-[a-f0-9]{64}$/.test(reference.callId)) return reference.callId;
    if (object.result) return visit(object.result, depth + 1);
    if (Array.isArray(object.content)) {
      for (const entry of object.content.slice(0, 8)) {
        if (entry?.type === "text" && typeof entry.text === "string") {
          try { const result = visit(JSON.parse(entry.text), depth + 1); if (result) return result; } catch { /* text fallback */ }
        }
      }
    }
    return null;
  };
  return visit(value);
}

export function PluginAppCard({ callId, backendId, sessionKey }: { callId: string; backendId: string; sessionKey: string }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return <div>
    <button type="button" className="btn-secondary" disabled={busy}
      onClick={async () => {
        setBusy(true); setFailed(false);
        try { await openPluginApp({ backendId, sessionKey, callId }); }
        catch { setFailed(true); } finally { setBusy(false); }
      }}>{t(busy ? "plugins.appOpening" : "plugins.appOpen")}</button>
    {failed && <p role="status">{t("plugins.appUnavailable")}</p>}
  </div>;
}
