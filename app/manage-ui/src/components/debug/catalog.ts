// The curated set of editable style properties shown grouped in the inspector,
// plus kind metadata that picks the right editor. "All ~350 computed props" is
// reachable via the panel's search box (inferKind drives those rows).

// "shadow" = a compound value with a color inside it (box-shadow, text-shadow): it
// gets the same swatch + picker as a plain color, editing only the color part.
export type PropKind = "length" | "number" | "color" | "shadow" | "text";

export interface PropDef {
  prop: string;
  kind: PropKind;
  // Short in-field tag. A group whose props ALL carry one renders as a Figma-style
  // two-column grid of tagged fields instead of label+input rows.
  short?: string;
}

export interface PropGroup {
  id: string; // → i18n debug.groups.<id>
  props: PropDef[];
}

export const CATALOG: PropGroup[] = [
  {
    id: "size",
    props: [
      { prop: "width", kind: "length", short: "W" },
      { prop: "height", kind: "length", short: "H" },
      { prop: "min-width", kind: "length", short: "min W" },
      { prop: "min-height", kind: "length", short: "min H" },
      { prop: "max-width", kind: "length", short: "max W" },
      { prop: "max-height", kind: "length", short: "max H" },
    ],
  },
  // No "spacing" group here on purpose: padding/margin are edited in the box model
  // diagram and gap in the SpacingGap block — both visual, both above this list.
  // Keeping duplicate number rows would mean two places to change one value.
  {
    id: "typography",
    props: [
      { prop: "font-family", kind: "text" },
      { prop: "font-size", kind: "length" },
      { prop: "font-weight", kind: "text" },
      { prop: "line-height", kind: "length" },
      { prop: "letter-spacing", kind: "length" },
      { prop: "text-align", kind: "text" },
      { prop: "color", kind: "color" },
    ],
  },
  {
    id: "border",
    props: [
      { prop: "background-color", kind: "color" },
      { prop: "border-width", kind: "length" },
      { prop: "border-style", kind: "text" },
      { prop: "border-color", kind: "color" },
      { prop: "border-radius", kind: "length" },
    ],
  },
  {
    id: "effects",
    props: [
      { prop: "box-shadow", kind: "shadow" },
      { prop: "opacity", kind: "number" },
      { prop: "transform", kind: "text" },
    ],
  },
];

// Replaced elements have no text of their own, so the typography group is pure
// noise on them — and what they CAN be styled with isn't in the list at all. An
// <img src="…svg"> in particular can only be recolored through `filter` (CSS
// can't reach the fill inside), which is exactly what you'd go looking for.
const IMAGE: PropGroup = {
  id: "image",
  props: [
    { prop: "object-fit", kind: "text" },
    { prop: "object-position", kind: "text" },
    { prop: "filter", kind: "text" },
  ],
};

const VECTOR: PropGroup = {
  id: "vector",
  props: [
    { prop: "fill", kind: "color" },
    { prop: "stroke", kind: "color" },
    { prop: "stroke-width", kind: "length" },
    { prop: "color", kind: "color" }, // drives currentColor
  ],
};

// Font-icon markup (<i> + ::before) stays on the default catalog on purpose:
// there font-size/color ARE the size and color controls.
export function catalogFor(el: HTMLElement | null): PropGroup[] {
  if (!el) return CATALOG;
  const swap = el.namespaceURI === "http://www.w3.org/2000/svg" ? VECTOR : el.tagName === "IMG" ? IMAGE : null;
  return swap ? CATALOG.map((g) => (g.id === "typography" ? swap : g)) : CATALOG;
}

const ALL_PROPS = new Set([...CATALOG, IMAGE, VECTOR].flatMap((g) => g.props.map((p) => p.prop)));

export function isCatalogProp(prop: string): boolean {
  return ALL_PROPS.has(prop);
}

// Pick an editor kind for an arbitrary computed property surfaced by search.
export function inferKind(prop: string, value: string): PropKind {
  const v = value.trim();
  // shadow before color: `box-shadow` matches neither the name nor the value test
  // below, and its value is a compound, so it needs the splice-in-place editor.
  if (/shadow/i.test(prop)) return "shadow";
  if (/color/i.test(prop) || /^(rgb|hsl|#)/i.test(v)) return "color";
  if (/^-?[\d.]+[a-z%]*$/i.test(v)) return /[a-z%]$/i.test(v) ? "length" : "number";
  return "text";
}
