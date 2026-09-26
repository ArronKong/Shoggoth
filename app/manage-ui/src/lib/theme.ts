// Theme switching (light / dark / follow-system).
//
// The resolver always lands a CONCRETE value on <html data-theme="light|dark">:
// "system" only decides which one, and a matchMedia listener re-resolves when
// the OS theme flips. CSS keys off that single attribute two ways —
//   :root[data-theme="dark"] { color-scheme: dark; }  → every light-dark() pair
//   :root[data-theme="dark"] .foo { ... }             → explicit dark overrides
// index.html seeds the attribute from localStorage before first paint (no
// flash); config is the source of truth and re-syncs the cache on load/save.

export type ThemePref = "system" | "light" | "dark";

export const THEME_KEY = "openclaw.theme";

const media = window.matchMedia("(prefers-color-scheme: dark)");
let pref: ThemePref = "light"; // default matches config-store's schema default

function resolve(p: ThemePref): "light" | "dark" {
  return p === "system" ? (media.matches ? "dark" : "light") : p;
}

function apply() {
  document.documentElement.dataset.theme = resolve(pref);
}

media.addEventListener("change", () => {
  if (pref === "system") apply();
});

/**
 * Apply a theme to the DOM only (live preview) WITHOUT touching the boot cache.
 * Used by the 设置 page while the user is choosing — persisting happens on Save.
 */
export function applyTheme(p: ThemePref) {
  pref = p;
  apply();
}

/** Set + apply a theme preference AND persist the boot cache for index.html. */
export function setTheme(p: ThemePref) {
  applyTheme(p);
  try {
    if (p === "light") localStorage.removeItem(THEME_KEY); // default needs no seed
    else localStorage.setItem(THEME_KEY, p);
  } catch {
    /* ignore */
  }
}

/** Boot: apply the cached preference immediately (config re-syncs it later). */
export function initThemeFromCache() {
  let cached: ThemePref = "light";
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (raw === "dark" || raw === "system") cached = raw;
  } catch {
    /* ignore */
  }
  pref = cached;
  apply();
}
