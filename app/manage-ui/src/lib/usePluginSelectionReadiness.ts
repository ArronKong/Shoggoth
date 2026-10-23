import { useCallback, useEffect, useState } from "react";
import { getPluginSelectionReadiness } from "../api/client";

// This is a read-only protocol observation. Execution still revalidates the
// actual physical owner and Service lease after the user selects a plugin.
export function usePluginSelectionReadiness(backend: string, agent: string | null,
  sessionKey: string | null, connected: boolean) {
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<{ key: string; supported: boolean; checking: boolean }>({
    key: "", supported: false, checking: false,
  });
  const eligible = connected && !!agent && !!sessionKey && ["shoggoth", "openclaw", "hermes"].includes(backend);
  const key = `${backend}\0${agent}\0${sessionKey}\0${connected}\0${reload}`;
  useEffect(() => {
    let active = true;
    setState({ key, supported: false, checking: eligible });
    if (eligible) {
      void getPluginSelectionReadiness(backend, agent!, sessionKey!).then(result => {
        if (active) setState({ key, supported: result.supported === true, checking: false });
      }, () => { if (active) setState({ key, supported: false, checking: false }); });
    }
    return () => { active = false; };
  }, [key, eligible, backend, agent, sessionKey]);
  const refresh = useCallback(() => setReload(value => value + 1), []);
  return { supported: eligible && state.key === key && state.supported === true,
    checking: eligible && (state.key !== key || state.checking), refresh };
}
