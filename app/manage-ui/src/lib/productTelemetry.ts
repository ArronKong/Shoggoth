import { getDesktopProductTelemetry } from "../api/client";

// This set is only a local eligibility check, never a page-usage collection.
// Include the shipped Dashboard/token route; exclude Gallery, Glass and Turn Lab.
const PRODUCT_PATHS = new Set(["/chat", "/dashboard", "/tasks", "/cron", "/models", "/skills", "/agents", "/token", "/cli", "/settings"]);
const INTERACTIONS = ["pointerdown", "keydown", "wheel"] as const;

export function installProductActivityListener(): () => void {
  const bridge = getDesktopProductTelemetry();
  if (!bridge) return () => {};
  let lastAt = -Infinity;
  let lastDay = "";
  const onInteraction = (event: Event) => {
    if (!event.isTrusted || document.visibilityState !== "visible" || !document.hasFocus()) return;
    const pathname = window.location.hash.slice(1).split("?", 1)[0];
    if (!PRODUCT_PATHS.has(pathname)) return;
    // Reserved for the later detailed-consent UI; interacting with its notice
    // or switch must not itself manufacture activity. Do not read DOM text/value.
    if (event.target instanceof Element && event.target.closest("[data-product-telemetry-exclude]")) return;
    const at = performance.now();
    const day = new Date().toISOString().slice(0, 10);
    if (day === lastDay && at - lastAt < 60_000) return;
    lastAt = at;
    lastDay = day;
    try { bridge.recordActivity(); } catch { /* one-way auxiliary signal */ }
  };
  // Do not listen for `scroll`: programmatic scrolling also generates trusted
  // browser scroll events. Wheel/key/scrollbar pointer interactions cover reading
  // without mistaking automatic chat bottom/anchor restoration for a human visit.
  for (const name of INTERACTIONS) document.addEventListener(name, onInteraction, { capture: true, passive: true });
  return () => { for (const name of INTERACTIONS) document.removeEventListener(name, onInteraction, true); };
}
