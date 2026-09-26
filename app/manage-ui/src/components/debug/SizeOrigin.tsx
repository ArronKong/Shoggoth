// "max-width: none" on the selected element is usually the truth AND useless: the
// cap lives on an ancestor. Chat bubbles are the textbook case — `.chat-bubble` sets
// no max-width at all and hugs its content, while `.chat-group__stack` above it caps
// the column at min(560px, 100% - 80px). Reading `none` on the bubble makes the
// panel look broken when it is simply reporting the element you picked.
//
// So when a max-* is unset here, walk up and name the ancestor that actually caps it,
// with a jump — same treatment SpacingGap gives to a parent's gap.

import type { TFunction } from "i18next";
import styles from "./DebugInspector.module.css";

interface Props {
  el: HTMLElement;
  t: TFunction;
  onSelect: (el: HTMLElement) => void;
}

// `100%` is the "don't actually constrain me" idiom — skipping it keeps the hint
// pointed at the ancestor carrying a real number.
const uninformative = (v: string) => !v || v === "none" || v === "100%";

function findCap(el: HTMLElement, prop: "maxWidth" | "maxHeight"): { node: HTMLElement; v: string } | null {
  let node = el.parentElement;
  for (let hops = 0; node && node !== document.body && hops < 8; hops++, node = node.parentElement) {
    const v = getComputedStyle(node)[prop];
    if (!uninformative(v)) return { node, v };
  }
  return null;
}

const label = (n: HTMLElement) => (n.classList[0] ? `.${n.classList[0]}` : n.tagName.toLowerCase());

export function SizeOrigin({ el, t, onSelect }: Props) {
  const cs = getComputedStyle(el);
  const caps: { key: "w" | "h"; node: HTMLElement; v: string }[] = [];
  if (uninformative(cs.maxWidth)) {
    const c = findCap(el, "maxWidth");
    if (c) caps.push({ key: "w", ...c });
  }
  if (uninformative(cs.maxHeight)) {
    const c = findCap(el, "maxHeight");
    if (c) caps.push({ key: "h", ...c });
  }
  if (!caps.length) return null;

  return (
    <>
      {caps.map((c) => (
        <div className={styles.gapHint} key={c.key}>
          {t(c.key === "w" ? "debug.maxWFromAncestor" : "debug.maxHFromAncestor", { sel: label(c.node), v: c.v })}{" "}
          <button className={styles.gapParentBtn} onClick={() => onSelect(c.node)}>
            {t("debug.selectParent")}
          </button>
        </div>
      ))}
    </>
  );
}
