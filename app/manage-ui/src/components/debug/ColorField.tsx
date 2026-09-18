// Color editor, Figma-style: swatch + text field, click the swatch for a popover
// with an SV square, hue and alpha rails, an eyedropper, and HEX/RGB/HSB readouts.
//
// Replaces <input type="color">, which cannot express ALPHA — and computed styles
// here are full of rgba(). The native picker silently dropped it on every edit.
//
// Hue is held in local state rather than derived from RGB on every render: at v=0
// or s=0 the RGB triple carries no hue, so round-tripping through it would snap the
// rail back to red the moment you drag into black.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChangeEvent, PointerEvent as ReactPointerEvent } from "react";
import styles from "./DebugInspector.module.css";

interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const hx = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");

let probe: CanvasRenderingContext2D | null = null;

// Computed colors arrive as rgb()/rgba()/color(srgb …)/#hex/named. The first three
// are parsed directly; anything else goes through a canvas fillStyle round-trip,
// which normalizes named colors and hsl() without shipping a color library.
function parse(css: string): RGBA {
  const s = css.trim();
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (rgb) {
    const parts = rgb[1].split(/[,/]/).map((p) => parseFloat(p.trim()));
    return { r: parts[0] || 0, g: parts[1] || 0, b: parts[2] || 0, a: parts[3] === undefined ? 1 : parts[3] };
  }
  const srgb = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/i.exec(s);
  if (srgb) {
    return {
      r: parseFloat(srgb[1]) * 255,
      g: parseFloat(srgb[2]) * 255,
      b: parseFloat(srgb[3]) * 255,
      a: srgb[4] === undefined ? 1 : parseFloat(srgb[4]),
    };
  }
  const hex = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
    const n = (i: number) => parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return { r: n(0), g: n(1), b: n(2), a: h.length === 8 ? n(3) / 255 : 1 };
  }
  if (!probe) probe = document.createElement("canvas").getContext("2d");
  if (probe) {
    probe.fillStyle = "#000";
    probe.fillStyle = s;
    const out = probe.fillStyle;
    if (out !== s && /^(#|rgb)/i.test(out)) return parse(out);
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

// Opaque colors go back as #hex (shorter, and what people paste); anything with
// alpha has to stay rgba() to survive.
function format(c: RGBA): string {
  if (c.a >= 1) return `#${hx(c.r)}${hx(c.g)}${hx(c.b)}`;
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${Math.round(c.a * 100) / 100})`;
}

function rgbToHsv({ r, g, b }: RGBA): { h: number; s: number; v: number } {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  let h = 0;
  if (d) {
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? (d / max) * 100 : 0, v: max * 100 };
}

function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const S = s / 100, V = v / 100;
  const c = V * S, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = V - c;
  const t = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ][Math.floor((h % 360) / 60)];
  return { r: (t[0] + m) * 255, g: (t[1] + m) * 255, b: (t[2] + m) * 255 };
}

type Mode = "HEX" | "RGB" | "HSB";

// Colors embedded in a compound value (`box-shadow: rgba(0,0,0,.2) 0 1px 3px`).
// Computed values are always normalized to rgb()/rgba()/color(srgb …), so matching
// those three is enough — no need to guess whether a bare word is a named color.
const EMBEDDED = /rgba?\([^)]*\)|color\(\s*srgb[^)]*\)/i;

export function ColorField({
  value,
  onChange,
  compound = false,
}: {
  value: string;
  onChange: (v: string) => void;
  // true = `value` is a compound declaration; edit only its color part and keep the
  // rest (offsets, blur, spread, inset) untouched.
  compound?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("HEX");
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const swatchRef = useRef<HTMLButtonElement>(null);

  // In compound mode the picker edits only the matched color; everything else in the
  // declaration rides along untouched.
  const hit = compound ? EMBEDDED.exec(value) : null;
  const colorPart = compound ? (hit ? hit[0] : "") : value;
  const rgba = parse(colorPart);
  const hsv = rgbToHsv(rgba);
  const [hue, setHue] = useState(hsv.h);
  const lastEmit = useRef<string>("");

  // An edit from elsewhere (element reselected, undo) must move the hue rail; our
  // own emits must not, or dragging into grey would reset it.
  useEffect(() => {
    if (value !== lastEmit.current) {
      const part = compound ? (EMBEDDED.exec(value)?.[0] ?? "") : value;
      setHue(rgbToHsv(parse(part)).h);
    }
  }, [value, compound]);

  const emit = (next: RGBA) => {
    const css = format(next);
    // Splice the new color back into the declaration (append if it had none, e.g.
    // `0 1px 3px` which defaults to currentColor).
    const out = compound ? (hit ? value.replace(hit[0], css) : `${value} ${css}`.trim()) : css;
    lastEmit.current = out;
    onChange(out);
  };
  const setHsv = (h: number, s: number, v: number, a = rgba.a) => {
    setHue(h);
    emit({ ...hsvToRgb(h, s, v), a });
  };

  // close on outside click
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      // `contains`, not `!==`: the swatch has an inner fill span, and a mousedown on
      // THAT would close the popover a moment before the button's click reopened it,
      // making the swatch unable to toggle the picker shut.
      if (t && !t.closest("[data-debug-color]") && !swatchRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open]);

  const toggle = () => {
    const r = swatchRef.current?.getBoundingClientRect();
    if (r) {
      // Coordinates are viewport coordinates, which only hold because the popover is
      // portalled to <body>. Rendered inside the panel it would inherit the panel's
      // `transform` as its containing block and land a full panel-offset away.
      const W = 232, H = 300;
      setPos({
        top: r.bottom + 6 + H > window.innerHeight ? Math.max(8, r.top - H - 6) : r.bottom + 6,
        left: Math.min(Math.max(8, r.right - W), window.innerWidth - W - 8),
      });
    }
    setOpen((o) => !o);
  };

  // drag helpers: track on the whole document so the pointer can leave the box
  const dragBox = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const move = (cx: number, cy: number) => {
      const s = clamp(((cx - box.left) / box.width) * 100, 0, 100);
      const v = clamp((1 - (cy - box.top) / box.height) * 100, 0, 100);
      setHsv(hue, s, v);
    };
    move(e.clientX, e.clientY);
    const onMove = (ev: PointerEvent) => move(ev.clientX, ev.clientY);
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  const dragRail = (e: ReactPointerEvent<HTMLDivElement>, apply: (ratio: number) => void) => {
    const box = e.currentTarget.getBoundingClientRect();
    const move = (cx: number) => apply(clamp((cx - box.left) / box.width, 0, 1));
    move(e.clientX);
    const onMove = (ev: PointerEvent) => move(ev.clientX);
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  const pickScreen = async () => {
    const Dropper = (window as unknown as { EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper;
    if (!Dropper) return;
    try {
      const res = await new Dropper().open();
      const c = parse(res.sRGBHex);
      setHue(rgbToHsv(c).h);
      emit({ ...c, a: rgba.a });
    } catch {
      /* user cancelled */
    }
  };

  const num = (v: number) => Math.round(v);
  const fields: { tag: string; val: string; set: (n: number) => void }[] =
    mode === "RGB"
      ? [
          { tag: "R", val: String(num(rgba.r)), set: (n) => emit({ ...rgba, r: clamp(n, 0, 255) }) },
          { tag: "G", val: String(num(rgba.g)), set: (n) => emit({ ...rgba, g: clamp(n, 0, 255) }) },
          { tag: "B", val: String(num(rgba.b)), set: (n) => emit({ ...rgba, b: clamp(n, 0, 255) }) },
        ]
      : mode === "HSB"
        ? [
            { tag: "H", val: String(num(hue)), set: (n) => setHsv(clamp(n, 0, 360), hsv.s, hsv.v) },
            { tag: "S", val: String(num(hsv.s)), set: (n) => setHsv(hue, clamp(n, 0, 100), hsv.v) },
            { tag: "B", val: String(num(hsv.v)), set: (n) => setHsv(hue, hsv.s, clamp(n, 0, 100)) },
          ]
        : [];

  const solid = `rgb(${num(rgba.r)}, ${num(rgba.g)}, ${num(rgba.b)})`;

  return (
    <div className={styles.color}>
      <button
        ref={swatchRef}
        type="button"
        className={styles.colorSwatch}
        onClick={toggle}
        title={value}
        aria-label={value}
      >
        <span className={styles.colorSwatchFill} style={{ background: colorPart || "transparent" }} />
      </button>
      <input
        className={styles.scrubInput}
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        spellCheck={false}
      />

      {open && createPortal(
        <div className={styles.picker} data-debug-ui="picker" data-debug-color="1" style={{ top: pos.top, left: pos.left }}>
          <div
            className={styles.pickerSv}
            style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hue} 100% 50%))` }}
            onPointerDown={dragBox}
          >
            <span className={styles.pickerKnob} style={{ left: `${hsv.s}%`, top: `${100 - hsv.v}%`, background: solid }} />
          </div>

          <div className={styles.pickerRails}>
            <button type="button" className={styles.pickerEye} onClick={pickScreen} title="吸管">
              ⌖
            </button>
            <div className={styles.pickerRailCol}>
              <div className={styles.pickerHue} onPointerDown={(e) => dragRail(e, (r) => setHsv(r * 360, hsv.s, hsv.v))}>
                <span className={styles.pickerKnob} style={{ left: `${(hue / 360) * 100}%`, top: "50%", background: `hsl(${hue} 100% 50%)` }} />
              </div>
              <div
                className={styles.pickerAlpha}
                style={{ backgroundImage: `linear-gradient(to right, transparent, ${solid}), var(--checker)` }}
                onPointerDown={(e) => dragRail(e, (r) => emit({ ...rgba, a: Math.round(r * 100) / 100 }))}
              >
                <span className={styles.pickerKnob} style={{ left: `${rgba.a * 100}%`, top: "50%", background: colorPart }} />
              </div>
            </div>
          </div>

          <div className={styles.pickerFoot}>
            <select className={styles.pickerMode} value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
              <option>HEX</option>
              <option>RGB</option>
              <option>HSB</option>
            </select>
            {mode === "HEX" ? (
              <input
                className={styles.pickerNum}
                value={`#${hx(rgba.r)}${hx(rgba.g)}${hx(rgba.b)}`}
                onChange={(e) => {
                  const c = parse(e.target.value);
                  setHue(rgbToHsv(c).h);
                  emit({ ...c, a: rgba.a });
                }}
                spellCheck={false}
              />
            ) : (
              fields.map((f) => (
                <input
                  key={f.tag}
                  className={styles.pickerNum}
                  value={f.val}
                  title={f.tag}
                  onChange={(e) => f.set(parseFloat(e.target.value) || 0)}
                  spellCheck={false}
                />
              ))
            )}
            <input
              className={`${styles.pickerNum} ${styles.pickerAlphaNum}`}
              value={Math.round(rgba.a * 100)}
              title="alpha %"
              onChange={(e) => emit({ ...rgba, a: clamp((parseFloat(e.target.value) || 0) / 100, 0, 1) })}
              spellCheck={false}
            />
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
