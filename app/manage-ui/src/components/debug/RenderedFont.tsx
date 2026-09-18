// Which font is ACTUALLY rendering this text — not the stack that was declared.
//
// The two are routinely different, and this project has been bitten by exactly
// that (ARCHITECTURE §9): `"SF Mono"` / `SFMono-Regular` / `ui-monospace` are
// unreachable or unrecognized in Chromium and silently fall through to Menlo;
// `"SF Pro Text"` silently falls through to PingFang SC on machines without the
// static slices. `getComputedStyle().fontFamily` reports the declared stack in
// all those cases, so it can't tell you anything went wrong.
//
// Detection is metric probing: a family is present if adding it in front of a
// baseline generic changes the measured width of the element's own text. The first
// present family in the stack is what renders. Approximate by nature (a family
// with metrics identical to the baseline reads as absent), hence "probed" in the
// tooltip — but it catches the whole class of bugs above.

import { useMemo } from "react";
import type { TFunction } from "i18next";
import styles from "./DebugInspector.module.css";

// Keywords that always resolve, so the walk stops at the first one. Deliberately
// only the ones CHROMIUM honors: `ui-monospace`/`ui-sans-serif`/`ui-serif`/
// `ui-rounded` and `-apple-system` are Safari-only and must NOT be listed here —
// left out, they fall to the metric probe, get quoted as plain family names,
// resolve to nothing, and are correctly skipped (which is what the engine does).
const GENERIC = /^(system-ui|sans-serif|serif|monospace|cursive|fantasy|BlinkMacSystemFont)$/i;

let ctx: CanvasRenderingContext2D | null = null;
function measure(font: string, text: string): number {
  if (!ctx) ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return 0;
  ctx.font = font;
  return ctx.measureText(text).width;
}

function detect(stack: string[], sample: string): string {
  // Two baselines: a family that happens to match one of them still differs from
  // the other, so a single unlucky metric collision doesn't hide a present font.
  const baselines = ["monospace", "serif"];
  for (const fam of stack) {
    if (GENERIC.test(fam)) return fam;
    const present = baselines.some((b) => measure(`32px "${fam}", ${b}`, sample) !== measure(`32px ${b}`, sample));
    if (present) return fam;
  }
  return stack[0] || "";
}

// `t` comes from the panel (which has its own language switch), not useTranslation.
export function RenderedFont({ el, t }: { el: HTMLElement; t: TFunction }) {
  const declared = getComputedStyle(el).fontFamily;
  const text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 16);

  const { rendered, fellThrough } = useMemo(() => {
    const stack = declared
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    // Probe with the element's own text: CJK resolves through the system cascade,
    // so measuring Latin sample text would answer a question you didn't ask.
    const hit = detect(stack, text || "Ag 中 09");
    return { rendered: hit, fellThrough: stack.length > 1 && hit !== stack[0] };
  }, [declared, text]);

  return (
    <div className={styles.row} title={t("debug.renderedFontHint")}>
      <span className={styles.rowLabel}>{t("debug.renderedFont")}</span>
      <code className={fellThrough ? `${styles.renderedFont} ${styles.renderedFontWarn}` : styles.renderedFont}>
        {rendered}
        {fellThrough ? ` ${t("debug.fontFellThrough")}` : ""}
      </code>
    </div>
  );
}
