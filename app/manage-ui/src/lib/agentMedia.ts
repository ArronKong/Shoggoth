// Parse OpenClaw `MEDIA:<path-or-url>` directive lines out of agent message text.
//
// OpenClaw agents are instructed (system prompt) to attach media to their final reply
// by emitting a `MEDIA:<ref>` line of their own. The gateway's chat.history returns that
// text verbatim, so — unlike OpenClaw's own Telegram/console delivery, which strips the
// marker and renders a real attachment — our chat UI would otherwise show the raw
// `MEDIA:/…/foo.png` line. We render the referenced image ourselves instead:
//   • local absolute paths  → served back through the static server's read-only
//     `/__media?path=` route (see app/static-server.js),
//   • http(s) / data: URLs   → loaded directly by the browser.
// Refs we can't resolve client-side (e.g. `media://` canonical handles) are left in the
// visible text untouched. Only lines that resolve to an image src are stripped, so a
// stray "MEDIA:" mention in prose is preserved.

// Own-line marker, mirroring OpenClaw's line-level directive (leading whitespace + the
// `MEDIA:` prefix). The `m` flag anchors ^/$ per line; the capture is the trimmed ref.
const MEDIA_LINE_RE = /^[ \t]*MEDIA:[ \t]*(\S[^\n]*?)[ \t]*$/gim;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|svg|bmp|avif)$/i;

export interface AgentMediaContext {
  backendId: string;
  sessionKey: string;
}

export interface AgentMedia {
  /** Message text with resolved MEDIA: directive lines removed. */
  text: string;
  /** Image srcs to render, in document order. */
  srcs: string[];
}

export function extractAgentMedia(text: string, context?: AgentMediaContext): AgentMedia {
  // 与后续 /i 正则保持一致，避免小写 media: 被快速路径提前漏掉。
  if (!text || !/MEDIA:/i.test(text)) return { text, srcs: [] };
  const srcs: string[] = [];
  const stripped = text.replace(MEDIA_LINE_RE, (match, ref: string) => {
    const src = mediaRefToSrc(ref, context);
    if (!src) return match; // unresolvable → keep the original line
    srcs.push(src);
    return ""; // resolved → drop the directive line from the visible text
  });
  if (!srcs.length) return { text, srcs: [] };
  // Removing whole lines can leave runs of blank lines behind; collapse them.
  const cleaned = stripped.replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
  return { text: cleaned, srcs };
}

export function mediaRefToSrc(ref: string, context?: AgentMediaContext): string | null {
  const r = ref.trim();
  if (!r || /[\u0000-\u001f\u007f]/.test(r)) return null;
  if (/^https?:\/\//i.test(r)) return r;
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(r)) return r;
  if (/^file:\/\//i.test(r)) {
    try {
      const url = new URL(r);
      if (url.hostname && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
      return localPathSrc(decodeURIComponent(url.pathname), context);
    } catch {
      return null;
    }
  }
  if (r.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(r)) return null;
  if (context || r.startsWith("/")) return localPathSrc(r, context);
  return null;
}

// Forward only genuine image paths to the /__media route. The static server enforces the
// real containment + type guard; this is just a cheap client-side filter so non-image
// MEDIA lines stay as text.
function localPathSrc(absPath: string, context?: AgentMediaContext): string | null {
  if (!IMAGE_EXT_RE.test(absPath) || /[\u0000-\u001f\u007f]/.test(absPath)) return null;
  if (context) {
    return `/__api/sessions/image?${new URLSearchParams({ backend: context.backendId, key: context.sessionKey, ref: absPath })}`;
  }
  return `/__media?path=${encodeURIComponent(absPath)}`;
}
