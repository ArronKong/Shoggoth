// DevTools-style box model diagram — the one view that answers "what are this
// element's four-sided margin / border / padding?" at a glance, instead of eight
// look-alike number rows further down the panel.
//
// Colors match the on-page overlay (margin orange → border yellow → padding green
// → content blue), so a value in here maps to a band you can see on the element.
//
// Each edge is drag-to-scrub (same feel as ScrubNumber) and click-to-type; the
// center is read-only and shows the content box size.

import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { parse } from "./ScrubNumber";
import styles from "./DebugInspector.module.css";

interface Props {
  read: (prop: string) => string;
  set: (prop: string, value: string) => void;
}

// "16px" → "16", "0px" → "-" (DevTools convention: zero reads as a dash so the
// non-zero edges pop), anything else (auto / calc(...)) stays verbatim.
function short(value: string): string {
  const v = value.trim();
  const m = /^(-?[\d.]+)px$/.exec(v);
  if (!m) return v || "-";
  const n = Math.round(parseFloat(m[1]) * 100) / 100;
  return n === 0 ? "-" : String(n);
}

// The cell shows a bare number, so the editor must open on a bare number too —
// otherwise the natural edit (see "8", type "12") writes `padding: 12`, which is
// invalid CSS that silently does nothing and then ships out via export/save.
function editable(value: string): string {
  const m = /^(-?[\d.]+)px$/.exec(value.trim());
  return m ? m[1] : value.trim();
}

// …and the same asymmetry on the way back: a bare number means px.
function withUnit(raw: string): string {
  const v = raw.trim();
  return /^-?[\d.]+$/.test(v) ? `${v}px` : v;
}

export function Cell({ prop, value, onChange, className }: { prop: string; value: string; onChange: (v: string) => void; className: string }) {
  const [editing, setEditing] = useState(false);
  const drag = useRef<{ num: number; unit: string; moved: boolean } | null>(null);

  if (editing) {
    return (
      <input
        className={`${className} ${styles.bmInput}`}
        defaultValue={editable(value)}
        autoFocus
        spellCheck={false}
        onBlur={(e) => {
          setEditing(false);
          const next = withUnit(e.target.value);
          if (next !== value.trim()) onChange(next); // "" clears the override
        }}
        // Escape unmounts the input before blur fires → the edit is dropped.
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          else if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  }

  const onDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    drag.current = { ...parse(value, "px"), moved: false };
    try {
      (e.target as Element).setPointerCapture(e.pointerId);
    } catch {
      /* capture is an optimization for the drag; the click path works without it */
    }
  };
  const onMove = (e: ReactPointerEvent) => {
    if (!drag.current || !e.movementX) return;
    drag.current.moved = true;
    drag.current.num += e.movementX * (e.shiftKey ? 10 : 1);
    onChange(`${Math.round(drag.current.num * 1000) / 1000}${drag.current.unit}`);
  };
  const onUp = (e: ReactPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    try {
      (e.target as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (d && !d.moved) setEditing(true); // a click (no drag) opens the editor
  };

  return (
    <span className={className} title={`${prop}: ${value}`} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
      {short(value)}
    </span>
  );
}

export function BoxModel({ read, set }: Props) {
  const cell = (prop: string, edge: string) => (
    <Cell prop={prop} value={read(prop)} onChange={(v) => set(prop, v)} className={`${styles.bmCell} ${edge}`} />
  );
  const w = read("width");
  const h = read("height");

  return (
    <div className={`${styles.bmBox} ${styles.bmMargin}`}>
      <span className={styles.bmTag}>margin</span>
      {cell("margin-top", styles.bmTop)}
      {cell("margin-left", styles.bmLeft)}
      {cell("margin-right", styles.bmRight)}
      {cell("margin-bottom", styles.bmBottom)}

      <div className={`${styles.bmBox} ${styles.bmBorder}`}>
        <span className={styles.bmTag}>border</span>
        {cell("border-top-width", styles.bmTop)}
        {cell("border-left-width", styles.bmLeft)}
        {cell("border-right-width", styles.bmRight)}
        {cell("border-bottom-width", styles.bmBottom)}

        <div className={`${styles.bmBox} ${styles.bmPadding}`}>
          <span className={styles.bmTag}>padding</span>
          {cell("padding-top", styles.bmTop)}
          {cell("padding-left", styles.bmLeft)}
          {cell("padding-right", styles.bmRight)}
          {cell("padding-bottom", styles.bmBottom)}

          <div className={styles.bmContent} title={`${w} × ${h}`}>
            {short(w)} × {short(h)}
          </div>
        </div>
      </div>
    </div>
  );
}
