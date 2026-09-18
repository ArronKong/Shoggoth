// OpenClaw-derived code: MIT. Copyright and full terms:
// resources/legal/licenses/source/OPENCLAW.txt
// Markdown → sanitized HTML, ported near-verbatim from the OpenClaw Control UI
// (ui/src/ui/markdown.ts) so chat content renders identically: markdown-it +
// GFM strikethrough/task-lists, www-only linkify with CJK-tail trimming, raw
// HTML escaped, base64-only inline images, code blocks with copy button + JSON
// collapse, and a DOMPurify allowlist + link-safety hook. The only changes vs.
// upstream are inlining its two tiny helper imports (truncateText, lowercase).

import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import markdownItTaskLists from "markdown-it-task-lists";
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/github.css";
import i18n from "../i18n";
import { internalAppHashFromHref } from "./appLinks";
import { findLocalFileLinks, localFilePathFromHref } from "./sessionArtifacts";

function truncateText(value: string, limit: number): { text: string; truncated: boolean; total: number } {
  if (value.length <= limit) return { text: value, truncated: false, total: value.length };
  return { text: value.slice(0, limit), truncated: true, total: value.length };
}
function lc(value?: string | null): string {
  return (value ?? "").toLowerCase();
}

const allowedTags = [
  "a", "b", "blockquote", "br", "button", "code", "del", "details", "div", "em",
  "h1", "h2", "h3", "h4", "hr", "i", "input", "li", "ol", "p", "pre", "s", "span",
  "strong", "summary", "table", "tbody", "td", "th", "thead", "tr", "ul", "img",
];
const allowedAttrs = [
  "checked", "class", "disabled", "href", "rel", "target", "title", "start",
  "src", "alt", "data-code", "data-html", "data-view", "data-local-path", "type", "aria-label",
];
const sanitizeOptions = {
  ALLOWED_TAGS: allowedTags,
  ALLOWED_ATTR: allowedAttrs,
  ADD_DATA_URI_TAGS: ["img"],
};

let hooksInstalled = false;
const MARKDOWN_CHAR_LIMIT = 140_000;
const MARKDOWN_PARSE_LIMIT = 40_000;
const MARKDOWN_CACHE_LIMIT = 200;
const MARKDOWN_CACHE_MAX_CHARS = 50_000;
const INLINE_DATA_IMAGE_RE = /^data:image\/[a-z0-9.+-]+;base64,/i;
const markdownCache = new Map<string, string>();
// Cached HTML includes translated copy/JSON controls, so a live locale switch
// must regenerate them even when the message text has not changed.
i18n.on("languageChanged", () => markdownCache.clear());
const TAIL_LINK_BLUR_CLASS = "chat-link-tail-blur";

// CJK ranges for URL boundary detection (RFC 3986: raw CJK is not valid in URLs).
const CJK_RE =
  /[⺀-⿿　-〿぀-ゟ゠-ヿ㐀-䶿一-鿿가-힯豈-﫿！-｠]/;

function getCachedMarkdown(key: string): string | null {
  const cached = markdownCache.get(key);
  if (cached === undefined) return null;
  markdownCache.delete(key);
  markdownCache.set(key, cached);
  return cached;
}
function setCachedMarkdown(key: string, value: string) {
  markdownCache.set(key, value);
  if (markdownCache.size <= MARKDOWN_CACHE_LIMIT) return;
  const oldest = markdownCache.keys().next().value;
  if (oldest) markdownCache.delete(oldest);
}

function installHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (!(node instanceof HTMLAnchorElement)) return;
    const encodedLocalPath = node.getAttribute("data-local-path");
    if (encodedLocalPath) {
      node.setAttribute("href", "#");
      node.removeAttribute("rel");
      node.removeAttribute("target");
      return;
    }
    const href = node.getAttribute("href");
    if (!href) return;
    const appRoute = internalAppHashFromHref(href, window.location.href);
    if (appRoute) {
      node.setAttribute("href", appRoute);
      node.removeAttribute("rel");
      node.removeAttribute("target");
      return;
    }
    try {
      const url = new URL(href, window.location.href);
      if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") {
        node.removeAttribute("href");
        return;
      }
    } catch {
      /* relative URLs fine; DOMPurify already strips javascript: */
    }
    node.setAttribute("rel", "noreferrer noopener");
    node.setAttribute("target", "_blank");
    if (lc(href).includes("tail")) node.classList.add(TAIL_LINK_BLUR_CLASS);
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function normalizeMarkdownImageLabel(text?: string | null): string {
  const trimmed = text?.trim();
  return trimmed ? trimmed : "image";
}

export const md: MarkdownIt = new MarkdownIt({ html: true, breaks: true, linkify: true });
md.enable("strikethrough");
md.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  const token = tokens[index];
  const href = token.attrGet("href") || "";
  const localPath = localFilePathFromHref(href);
  if (localPath) {
    token.attrSet("href", "#");
    token.attrSet("data-local-path", encodeURIComponent(localPath));
    token.attrSet("title", localPath);
  }
  return renderer.renderToken(tokens, index, options);
};
md.linkify.set({ fuzzyLink: false });
md.linkify.add("www", {
  validate(text: string, pos: number) {
    const tail = text.slice(pos);
    const match = tail.match(
      /^\.(?:[a-zA-Z0-9-]+\.?)+[^\s<⺀-⿿　-〿぀-ゟ゠-ヿ㐀-䶿一-鿿가-힯豈-﫿！-｠]*/,
    );
    if (!match) return 0;
    let len = match[0].length;
    const balancePairs: Record<string, string> = { ")": "(", "]": "[", "}": "{", '"': '"', "'": "'" };
    const balance: Record<string, number> = {};
    for (const [close, open] of Object.entries(balancePairs)) {
      balance[close] = 0;
      for (let i = 0; i < len; i++) {
        const c = tail[i];
        if (open === close) {
          if (c === open) balance[close] = balance[close] === 0 ? 1 : 0;
        } else if (c === open) balance[close]++;
        else if (c === close) balance[close]--;
      }
    }
    while (len > 0) {
      const ch = tail[len - 1];
      if (/[?!.,:*_~]/.test(ch)) { len--; continue; }
      if (ch === ";") {
        let j = len - 2;
        while (j >= 0 && /[a-zA-Z0-9]/.test(tail[j])) j--;
        if (j >= 0 && tail[j] === "&" && j < len - 2) { len = j; continue; }
        break;
      }
      const open = balancePairs[ch];
      if (open !== undefined) {
        if (open === ch) {
          if (balance[ch] !== 0) { balance[ch] = 0; len--; continue; }
        } else if (balance[ch] < 0) { balance[ch]++; len--; continue; }
      }
      break;
    }
    return len;
  },
  normalize(match: { url: string }) {
    match.url = "http://" + match.url;
  },
});
md.validateLink = () => true;

md.core.ruler.after("linkify", "linkify-cjk-trim", (state) => {
  for (const blockToken of state.tokens) {
    if (blockToken.type !== "inline" || !blockToken.children) continue;
    const children = blockToken.children;
    for (let i = children.length - 1; i >= 0; i--) {
      const token = children[i];
      if (token.type !== "link_open" || token.markup !== "linkify") continue;
      const textToken = children[i + 1];
      if (!textToken || textToken.type !== "text") continue;
      const displayText = textToken.content;
      let cjkIdx = displayText.length;
      while (cjkIdx > 0 && CJK_RE.test(displayText[cjkIdx - 1])) cjkIdx--;
      if (cjkIdx <= 0 || cjkIdx === displayText.length) continue;
      const trimmedDisplay = displayText.slice(0, cjkIdx);
      const cjkTail = displayText.slice(cjkIdx);
      const href = token.attrGet("href") ?? "";
      const prefixLen = href.indexOf(displayText);
      const hrefPrefix = prefixLen > 0 ? href.slice(0, prefixLen) : "";
      token.attrSet("href", hrefPrefix + trimmedDisplay);
      textToken.content = trimmedDisplay;
      for (let j = i + 1; j < children.length; j++) {
        if (children[j].type === "link_close") {
          const tailToken = new state.Token("text", "", 0);
          tailToken.content = cjkTail;
          children.splice(j + 1, 0, tailToken);
          break;
        }
      }
    }
  }
});

// Link prose and inline-code paths without touching URLs, existing links, images
// or fenced code. Reuse the same local-open marker as explicit Markdown links.
md.core.ruler.after("linkify-cjk-trim", "local-file-links", (state) => {
  if (!state.env?.localFiles) return;
  for (const block of state.tokens) {
    if (block.type !== "inline" || !block.children) continue;
    let linkDepth = 0;
    block.children = block.children.flatMap((token) => {
      if (token.type === "link_open") linkDepth++;
      if (token.type === "link_close") linkDepth--;
      if (linkDepth || (token.type !== "text" && token.type !== "code_inline")) return [token];
      const links = findLocalFileLinks(token.content, token.type === "code_inline");
      if (!links.length) return [token];
      const result = [];
      let offset = 0;
      const part = (value: string) => {
        const child = new state.Token(token.type, token.tag, 0);
        child.content = value;
        child.markup = token.markup;
        return child;
      };
      for (const link of links) {
        if (link.start > offset) result.push(part(token.content.slice(offset, link.start)));
        const open = new state.Token("link_open", "a", 1);
        open.attrSet("href", "#");
        open.attrSet("data-local-path", encodeURIComponent(link.path));
        open.attrSet("title", link.path);
        result.push(open, part(token.content.slice(link.start, link.end)), new state.Token("link_close", "a", -1));
        offset = link.end;
      }
      if (offset < token.content.length) result.push(part(token.content.slice(offset)));
      return result;
    });
  }
});

md.use(markdownItTaskLists, { enabled: false, label: false });
md.core.ruler.after("github-task-lists", "task-list-allowlist", (state) => {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    if (tokens[i].type !== "inline" || !tokens[i].children) continue;
    if (tokens[i - 1].type !== "paragraph_open") continue;
    if (tokens[i - 2].type !== "list_item_open") continue;
    const cls = tokens[i - 2].attrGet("class") ?? "";
    if (!cls.includes("task-list-item")) continue;
    for (const child of tokens[i].children!) {
      if (child.type === "html_inline" && /^<input\s/i.test(child.content)) {
        child.meta = { taskListPlugin: true };
        break;
      }
    }
  }
});

md.renderer.rules.html_block = (tokens, idx) => escapeHtml(tokens[idx].content) + "\n";
md.renderer.rules.html_inline = (tokens, idx) => {
  const token = tokens[idx];
  if (token.meta?.taskListPlugin === true) return token.content;
  return escapeHtml(token.content);
};
md.renderer.rules.image = (tokens, idx) => {
  const token = tokens[idx];
  const src = token.attrGet("src")?.trim() ?? "";
  const alt = normalizeMarkdownImageLabel(token.content);
  if (!INLINE_DATA_IMAGE_RE.test(src)) return escapeHtml(alt);
  return `<img class="markdown-inline-image" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">`;
};

// Syntax-highlight a code block with highlight.js (common-languages bundle).
// Only highlight when the fence names a grammar we know; otherwise return escaped
// plain text (no highlightAuto — it's slow and mis-detects short snippets). hljs
// emits <span class="hljs-*"> which the DOMPurify allowlist already permits.
function highlightCode(text: string, lang: string): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    } catch {
      /* unknown grammar edge case — fall back to escaped plain text */
    }
  }
  return escapeHtml(text);
}
function renderCodeChrome(text: string, lang: string): string {
  const langClass = lang ? ` class="hljs language-${escapeHtml(lang)}"` : ` class="hljs"`;
  const safeText = escapeHtml(text); // raw text for the copy button's data-code
  const codeBlock = `<pre><code${langClass}>${highlightCode(text, lang)}</code></pre>`;
  const langLabel = lang ? `<span class="code-block-lang">${escapeHtml(lang)}</span>` : "";
  const copyBtn = `<button type="button" class="code-block-copy" data-code="${safeText}" aria-label="Copy code"><span class="code-block-copy__idle">${i18n.t("markdown.copy")}</span><span class="code-block-copy__done">${i18n.t("markdown.copied")}</span></button>`;
  const header = `<div class="code-block-header">${langLabel}${copyBtn}</div>`;
  const trimmed = text.trim();
  const isJson =
    lang === "json" ||
    (!lang && ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))));
  if (isJson) {
    const lineCount = text.split("\n").length;
    const label = lineCount > 1 ? i18n.t("markdown.jsonLines", { count: lineCount }) : "JSON";
    return `<details class="json-collapse"><summary>${label}</summary><div class="code-block-wrapper">${header}${codeBlock}</div></details>`;
  }
  return `<div class="code-block-wrapper">${header}${codeBlock}</div>`;
}
// A ```html fence renders as a live, sandboxed preview (upgraded client-side by
// lib/htmlArtifacts.ts). Until that upgrader runs — or on any surface that never
// installs it — data-view="source" shows the fallback code block below, so the
// HTML is never silently swallowed. The raw source is URI-encoded into data-html:
// encodeURIComponent output is attribute-safe and survives DOMPurify as data-*.
function renderHtmlArtifact(text: string): string {
  return `<div class="chat-html-artifact" data-view="source" data-html="${encodeURIComponent(text)}">${renderCodeChrome(text, "html")}</div>`;
}
// A ```html block becomes a live preview ONLY when it's a self-contained,
// runnable document — it has a doctype / <html>, or brings its own <script> or
// <style>. Plain HTML snippets (documentation markup an agent is *showing*, not
// demoing) stay a normal highlighted code block, so previews don't mis-fire.
const RUNNABLE_HTML_RE = /<!doctype\s|<html[\s>]|<script[\s>]|<style[\s>]/i;
md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const lang = token.info.trim().split(/\s+/)[0] || "";
  const body = token.content;
  if (lang.toLowerCase() === "html" && body.trim() && RUNNABLE_HTML_RE.test(body)) return renderHtmlArtifact(body);
  return renderCodeChrome(body, lang);
};
md.renderer.rules.code_block = (tokens, idx) => renderCodeChrome(tokens[idx].content, "");

function renderEscapedPlainTextHtml(value: string): string {
  return `<div class="markdown-plain-text-fallback">${escapeHtml(value.replace(/\r\n?/g, "\n"))}</div>`;
}

export function toSanitizedMarkdownHtml(markdown: string, localFiles = false): string {
  const input = markdown.trim();
  if (!input) return "";
  installHooks();
  const cacheKey = `${localFiles ? "local:" : "standard:"}${input}`;
  if (input.length <= MARKDOWN_CACHE_MAX_CHARS) {
    const cached = getCachedMarkdown(cacheKey);
    if (cached !== null) return cached;
  }
  const truncated = truncateText(input, MARKDOWN_CHAR_LIMIT);
  const suffix = truncated.truncated
    ? i18n.t("markdown.truncated", { total: truncated.total, shown: truncated.text.length })
    : "";
  if (truncated.text.length > MARKDOWN_PARSE_LIMIT) {
    const html = renderEscapedPlainTextHtml(`${truncated.text}${suffix}`);
    const sanitized = DOMPurify.sanitize(html, sanitizeOptions);
    if (input.length <= MARKDOWN_CACHE_MAX_CHARS) setCachedMarkdown(cacheKey, sanitized);
    return sanitized;
  }
  let rendered: string;
  try {
    rendered = md.render(`${truncated.text}${suffix}`, { localFiles });
  } catch (err) {
    console.warn("[markdown] md.render failed, falling back to plain text:", err);
    rendered = `<pre class="code-block">${escapeHtml(`${truncated.text}${suffix}`)}</pre>`;
  }
  const sanitized = DOMPurify.sanitize(rendered, sanitizeOptions);
  if (input.length <= MARKDOWN_CACHE_MAX_CHARS) setCachedMarkdown(cacheKey, sanitized);
  return sanitized;
}

// Thinking/reasoning text → italic markdown with a "Reasoning" prefix, matching
// the upstream formatReasoningMarkdown() shape.
export function formatReasoningMarkdown(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const body = lines.filter(Boolean).map((l) => `_${l}_`);
  return [`_${i18n.t("markdown.reasoningPrefix")}_`, ...body].join("\n");
}
