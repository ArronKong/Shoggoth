// Visual spacing block. Padding/margin live in the box model diagram above, so
// what's left here is the OTHER source of spacing — and in this codebase it's the
// dominant one: flex/grid `gap`. Two preview strips show the real gap width/height
// to scale, next to a scrub-and-type value.
//
// The payoff case: you click a card, every padding/margin reads 0, and the space
// you're looking at actually belongs to the PARENT's gap. So when the selected
// element isn't a flex/grid container, this block says so and offers a jump to the
// parent that owns the spacing.

import type { TFunction } from "i18next";
import { Cell } from "./BoxModel";
import styles from "./DebugInspector.module.css";

interface Props {
  el: HTMLElement;
  read: (prop: string) => string;
  set: (prop: string, value: string) => void;
  onSelect: (el: HTMLElement) => void;
  // `t` is passed in, not pulled from useTranslation: the panel has its own
  // language switch and this block has to follow it, not the app's locale.
  t: TFunction;
}

const num = (v: string): number => Math.max(0, parseFloat(v) || 0);
const isContainer = (display: string): boolean => /flex|grid/.test(display);

function GapRow({
  label,
  prop,
  value,
  vertical,
  set,
}: {
  label: string;
  prop: string;
  value: string;
  vertical?: boolean;
  set: (prop: string, value: string) => void;
}) {
  // Preview is 1:1 with the real gap up to 40px, then clamps — past that the strip
  // would blow out the panel and the exact number is right there anyway.
  const size = Math.max(2, Math.min(num(value), 40));
  return (
    <div className={styles.gapRow}>
      <span className={styles.gapLabel}>{label}</span>
      <div className={vertical ? styles.gapVizV : styles.gapViz}>
        <span className={styles.gapBlock} />
        <span className={styles.gapSpace} style={vertical ? { height: size } : { width: size }} />
        <span className={styles.gapBlock} />
      </div>
      <Cell prop={prop} value={value} onChange={(v) => set(prop, v)} className={`${styles.bmCell} ${styles.gapCell}`} />
    </div>
  );
}

export function SpacingGap({ el, read, set, onSelect, t }: Props) {
  // Two independent facts, and you usually want both: the gap this element hands to
  // its own children, and the gap the PARENT puts between it and its siblings — the
  // second is what "why are these cards 12px apart" actually resolves to.
  const ownsChildren = isContainer(read("display"));
  const parent = el.parentElement;
  const pcs = parent ? getComputedStyle(parent) : null;
  const pGap = pcs ? Math.max(num(pcs.columnGap), num(pcs.rowGap)) : 0;
  const fromParent = parent && pcs && isContainer(pcs.display) && pGap > 0;

  return (
    <>
      {ownsChildren ? (
        <>
          <GapRow label={t("debug.gapCol")} prop="column-gap" value={read("column-gap")} set={set} />
          <GapRow label={t("debug.gapRow")} prop="row-gap" value={read("row-gap")} vertical set={set} />
        </>
      ) : (
        <div className={styles.gapHint}>{t("debug.gapNotContainer")}</div>
      )}
      {fromParent && (
        <div className={styles.gapHint}>
          {t("debug.gapFromParent", {
            sel: parent!.classList[0] ? `.${parent!.classList[0]}` : parent!.tagName.toLowerCase(),
            gap: `${pGap}px`,
          })}{" "}
          <button className={styles.gapParentBtn} onClick={() => onSelect(parent!)}>
            {t("debug.selectParent")}
          </button>
        </div>
      )}
    </>
  );
}
