import { useEffect, useState } from "react";

const KEY = "shoggoth:pending-connectors:v1";
const EVENT = "shoggoth:pending-connectors-changed";

// Only catalog identities belong here. Configuration and credentials continue
// to cross the existing Service APIs after the user completes setup.
export function readPendingConnectors(storage: Pick<Storage, "getItem">): string[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(KEY) || "[]");
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && /^(preset|registry|device):[A-Za-z0-9._/-]{1,200}$/.test(id)))].slice(0, 128) : [];
  } catch { return []; }
}

export function usePendingConnectors() {
  const [ids, setIds] = useState(() => readPendingConnectors(window.localStorage));
  useEffect(() => {
    const refresh = () => setIds(readPendingConnectors(window.localStorage));
    window.addEventListener(EVENT, refresh); window.addEventListener("storage", refresh);
    return () => { window.removeEventListener(EVENT, refresh); window.removeEventListener("storage", refresh); };
  }, []);
  const change = (id: string, added: boolean) => {
    const current = readPendingConnectors(window.localStorage);
    const next = added ? [...new Set([...current, id])] : current.filter(value => value !== id);
    // A failed write stays visible as an error; never claim a durable addition.
    window.localStorage.setItem(KEY, JSON.stringify(next));
    setIds(next); window.dispatchEvent(new Event(EVENT));
  };
  return { ids, add: (id: string) => change(id, true), remove: (id: string) => change(id, false) };
}
