const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

/** Return a safe HashRouter route when a link targets this App origin. */
export function internalAppHashFromHref(href: string, currentHref: string): string | null {
  const rawHref = href.trim();
  if (!rawHref || CONTROL_CHARACTER_PATTERN.test(rawHref)) return null;
  if (rawHref.startsWith("#/")) return rawHref;
  try {
    const current = new URL(currentHref);
    const target = new URL(rawHref, current);
    if (target.origin === current.origin && target.hash.startsWith("#/")) {
      return target.hash;
    }
  } catch {
    // Malformed URLs are not App routes.
  }
  return null;
}
