// Drag-to-scrub numeric editor (DevTools/Figma style). Drag the ↔ grip to change
// the numeric part while preserving the unit; Shift = ×10. Typing in the field
// still works for arbitrary values (e.g. "auto", "calc(...)").

import { useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import styles from "./DebugInspector.module.css";

interface Props {
  value: string;
  onChange: (v: string) => void;
  defaultUnit?: string; // "px" for lengths, "" for unitless numbers
  step?: number;
  label?: string; // in-field tag (Figma style: "W" / "H"); defaults to the ↔ grip
  title?: string; // tooltip — carries the full property name when `label` shortens it
}

export function parse(value: string, defaultUnit: string): { num: number; unit: string } {
  const m = /^(-?[\d.]+)([a-z%]*)$/i.exec(value.trim());
  if (m) return { num: parseFloat(m[1]), unit: m[2] || defaultUnit };
  return { num: 0, unit: defaultUnit };
}

export function ScrubNumber({ value, onChange, defaultUnit = "px", step = 1, label, title }: Props) {
  const drag = useRef<{ num: number; unit: string } | null>(null);

  const onDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    drag.current = parse(value, defaultUnit);
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent) => {
    if (!drag.current) return;
    drag.current.num += e.movementX * step * (e.shiftKey ? 10 : 1);
    const r = Math.round(drag.current.num * 1000) / 1000;
    onChange(`${r}${drag.current.unit}`);
  };
  const onUp = (e: ReactPointerEvent) => {
    drag.current = null;
    try {
      (e.target as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  };

  // Expression values (min()/max()/calc()/clamp()/var()) can't be scrubbed: parse()
  // finds no leading number, so a drag would start from 0 and silently destroy the
  // whole expression. `auto`/`none` stay draggable on purpose — there dragging is how
  // you turn "unset" into a number.
  const expr = value.includes("(");
  const tip = title ? `${title}: ${value}` : value;

  return (
    <div className={styles.scrub} title={tip}>
      <span
        className={[styles.scrubGrip, label ? styles.scrubTag : "", expr ? styles.scrubGripOff : ""]
          .filter(Boolean)
          .join(" ")}
        onPointerDown={expr ? undefined : onDown}
        onPointerMove={expr ? undefined : onMove}
        onPointerUp={expr ? undefined : onUp}
        title={tip}
      >
        {label || "↔"}
      </span>
      <input className={styles.scrubInput} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
    </div>
  );
}
