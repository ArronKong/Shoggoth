import { useLayoutEffect, useState } from "react";

export interface GroupMessagePin { id: string; seq: number; text: string }
interface Presentation { hidden: string[]; pins: GroupMessagePin[] }
const PREFIX = "shoggoth.groupChat.messagePresentation.v1.";
const empty = (): Presentation => ({ hidden: [], pins: [] });

function read(key: string | null): Presentation {
  try {
    const value = key ? JSON.parse(window.localStorage.getItem(key) || "null") : null;
    if (!value) return empty();
    const hidden = Array.isArray(value.hidden) ? value.hidden.filter((id: unknown) => typeof id === "string") : [];
    const pins = Array.isArray(value.pins) ? value.pins.filter((pin: GroupMessagePin) => pin && typeof pin.id === "string"
      && Number.isSafeInteger(pin.seq) && pin.seq > 0 && typeof pin.text === "string") : [];
    return { hidden: [...new Set<string>(hidden)], pins: [...new Map<string, GroupMessagePin>(pins.map((pin: GroupMessagePin) => [pin.id, pin])).values()] };
  } catch { return empty(); }
}

/** Client presentation only. Canonical group history and execution are untouched. */
export function useGroupMessagePresentation(ownerScope: string | null, groupId: string) {
  const key = ownerScope ? PREFIX + JSON.stringify([ownerScope, groupId]) : null;
  const [state, setState] = useState(() => ({ key, value: read(key) }));
  const value = state.key === key ? state.value : read(key);
  useLayoutEffect(() => { setState(previous => previous.key === key ? previous : { key, value: read(key) }); }, [key]);
  const update = (change: (previous: Presentation) => Presentation) => {
    if (!key) return;
    setState(previous => {
      const next = change(previous.key === key ? previous.value : read(key));
      try { window.localStorage.setItem(key, JSON.stringify(next)); } catch { /* Keep the current view usable when storage is unavailable. */ }
      return { key, value: next };
    });
  };
  return {
    hidden: new Set(value.hidden), pins: value.pins,
    hide(id: string) { update(previous => ({ ...previous, hidden: [...new Set([...previous.hidden, id])] })); },
    restore(id: string) { update(previous => ({ ...previous, hidden: previous.hidden.filter(value => value !== id) })); },
    pin(pin: GroupMessagePin) { update(previous => ({ ...previous, pins: [...previous.pins.filter(value => value.id !== pin.id), pin].sort((a, b) => a.seq - b.seq) })); },
    unpin(id: string) { update(previous => ({ ...previous, pins: previous.pins.filter(value => value.id !== id) })); },
  };
}
