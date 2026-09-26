const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const RESERVED_APP_PATHS = ["/__api", "/__chatws", "/__media", "/__widget", "/avatar"];
const LOCAL_FILESYSTEM_ROOTS = [
  "/Users/", "/Volumes/", "/Applications/", "/private/", "/tmp/", "/var/", "/opt/", "/home/",
  "/Library/", "/System/", "/etc/", "/usr/", "/bin/", "/sbin/",
];

function withoutSourceLocation(value: string): string {
  return value.replace(/(?::\d+(?::\d+)?|#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/, "");
}

function isLocalPath(value: string): boolean {
  return !/[\u0000-\u001f\u007f]/.test(value)
    && (value.startsWith("~/") || LOCAL_FILESYSTEM_ROOTS.some((prefix) => value.startsWith(prefix)));
}

function decodePath(value: string): string | null {
  try {
    const decoded = withoutSourceLocation(decodeURIComponent(value));
    if (RESERVED_APP_PATHS.some((prefix) => decoded === prefix || decoded.startsWith(`${prefix}/`))) return null;
    return isLocalPath(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/** Decode a local-file href; the host expands home-relative paths when opening. */
export function localFilePathFromHref(href: string): string | null {
  const raw = String(href || "").trim();
  if (!raw) return null;
  if (raw.startsWith("/") || raw.startsWith("~/")) return decodePath(raw);
  try {
    const url = new URL(raw);
    if (url.protocol === "file:" && (!url.host || LOOPBACK_HOSTS.has(url.hostname))) {
      return decodePath(url.pathname);
    }
    if ((url.protocol === "http:" || url.protocol === "https:")
      && LOOPBACK_HOSTS.has(url.hostname)
      && LOCAL_FILESYSTEM_ROOTS.some((prefix) => url.pathname.startsWith(prefix))) {
      return decodePath(url.pathname);
    }
  } catch {
    return null;
  }
  return null;
}

/** Plain paths retain literal percent signs; only file URLs are URI-decoded. */
function localFilePathFromText(text: string): string | null {
  if (/^file:\/\//i.test(text)) return localFilePathFromHref(text);
  const value = withoutSourceLocation(text);
  return isLocalPath(value) ? value : null;
}

export type LocalFileLink = { start: number; end: number; path: string };

/** Find paths in prose or inline code, leaving display text and punctuation intact. */
export function findLocalFileLinks(text: string, wholePath = false): LocalFileLink[] {
  if (wholePath) {
    const path = localFilePathFromText(text);
    if (path) return [{ start: 0, end: text.length, path }];
  }
  const links: LocalFileLink[] = [];
  const starts = /file:\/\/(?:localhost|127\.0\.0\.1|\[::1\])?\/|~\/|\//gi;
  let consumed = 0;
  for (const match of text.matchAll(starts)) {
    const start = match.index!;
    if (start < consumed || (start > 0 && /[\w/\\.:~%+@-]/.test(text[start - 1]))) continue;
    const tail = text.slice(start);
    // Quotes make spaces unambiguous, as does a code span containing just a path.
    const quote = ({ '"': '"', "'": "'", "“": "”", "‘": "’", "《": "》" } as Record<string, string>)[text[start - 1]];
    const quoteEnd = quote ? tail.indexOf(quote) : -1;
    const quoted = quoteEnd >= 0 && !/[\r\n]/.test(tail.slice(0, quoteEnd));
    let label = quoted
      ? tail.slice(0, quoteEnd)
      : tail.match(/^[^\s<>"'`，。；：！？、（）【】《》“”‘’]+/)?.[0] || "";
    if (!quoted) {
      // Keep balanced parentheses in filenames, but exclude surrounding prose.
      const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
      const balance: Record<string, number> = {};
      for (const [close, open] of Object.entries(pairs)) {
        balance[close] = label.split(open).length - label.split(close).length;
      }
      let end = label.length;
      while (end > 0) {
        const ch = label[end - 1];
        if (/[.,;:!?]/.test(ch)) { end--; continue; }
        if (pairs[ch] && balance[ch] < 0) { balance[ch]++; end--; continue; }
        break;
      }
      label = label.slice(0, end);
    }
    const path = localFilePathFromText(label);
    if (!path) continue;
    consumed = start + label.length;
    links.push({ start, end: consumed, path });
  }
  return links;
}
