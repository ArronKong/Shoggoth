const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export function managedAgentFileFromHref(href: string, currentHref: string) {
  try {
    const current = new URL(currentHref);
    const target = new URL(href, current);
    if (target.origin !== current.origin || !/^https?:$/u.test(target.protocol)) return null;
    const match = /^\/__api\/agents\/([^/]+)\/managed-files\/([a-f0-9]{64})\/content$/u.exec(target.pathname);
    const backend = target.searchParams.get("backend");
    return match && backend ? { agentId: decodeURIComponent(match[1]), fileId: match[2], backend } : null;
  } catch { return null; }
}

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
