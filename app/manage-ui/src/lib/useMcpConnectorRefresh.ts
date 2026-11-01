import { useEffect, useRef } from "react";
import { MCP_CHANGE_EVENT } from "../api/mcpConnectors";

// Agent tools mutate the Service without passing through this renderer's API.
// Refresh visible lists as well as UI-originated writes; serialize polls and
// stop on unmount so a slow check cannot accumulate background requests.
export function useMcpConnectorRefresh(refresh: () => Promise<void>) {
  const current = useRef(refresh); current.current = refresh;
  useEffect(() => {
    let pending = false, active = true;
    const changed = async () => {
      if (!active || pending || document.visibilityState === "hidden") return;
      pending = true;
      try { await current.current(); } catch { /* The list owns its visible error state. */ } finally { pending = false; }
    };
    const timer = window.setInterval(() => void changed(), 2000);
    window.addEventListener(MCP_CHANGE_EVENT, changed);
    document.addEventListener("visibilitychange", changed);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener(MCP_CHANGE_EVENT, changed); document.removeEventListener("visibilitychange", changed); };
  }, []);
}
