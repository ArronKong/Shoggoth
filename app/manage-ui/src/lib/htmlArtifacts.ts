// Upgrade markdown.ts's ```html placeholders into sandboxed, auto-height iframes
// — a local re-creation of the claude.ai inline-widget host (show_widget).
//
// A placeholder (`div.chat-html-artifact[data-html]`) renders as a plain code
// block until this runs, so any surface that doesn't install the upgrader simply
// shows the source — the HTML is never swallowed. On mount the raw HTML is wrapped
// into a full document we control, and rendered in an iframe that mirrors the real
// host's guarantees:
//
//   · sandbox="allow-scripts" ONLY (no allow-same-origin): the frame runs its own
//     JS/animation but cannot reach the parent DOM, storage, cookies, or the
//     loopback gateway identity.
//   · a strict CSP (injected as the FIRST node in <head>): default-src 'none',
//     connect-src 'none' (fetch/XHR/WS silently fail), scripts/styles inline +
//     a CDN allowlist (cdnjs / jsdelivr / unpkg). Network egress is truly locked.
//   · theme tokens injected so a widget follows the app's light/dark mode — the
//     same --ui-* values the app uses, plus --text-primary/--bg/--accent aliases,
//     with color-scheme kept in sync live when the user toggles the theme.
//   · a one-way reverse channel: window.sendPrompt(text) posts back to the parent,
//     which forwards it to the chat composer (registered via setSendPromptHandler).
//   · content-adaptive height, reported from inside the frame via postMessage.
//
// Mounting waits for the DOM to go quiet (MOUNT_SETTLE_MS) so a still-streaming
// message — React rewrites the bubble's innerHTML on every delta — isn't mounted
// mid-stream and restarted repeatedly.

let installed = false;
let sendPromptHandler: ((text: string) => void) | null = null;
// data-html values already mounted once. When the chat list re-renders (optimistic
// send → assistant pending → error swap), React rebuilds a bubble's DOM into a fresh
// source-view placeholder; without this, each rebuild flashes source→preview again.
// A known key re-mounts synchronously (before paint), so re-renders don't flicker.
const mountedKeys = new Set<string>();

const MOUNT_SETTLE_MS = 350;
const MIN_H = 60;
const MAX_H = 2400;
const INITIAL_H = 220;
const SENDPROMPT_MAX = 4000;

// CDN allowlist mirrors the real host. connect-src 'none' blocks all fetch/XHR/WS.
const CDN = "https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com";
const CSP =
  "default-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; " +
  `script-src 'unsafe-inline' ${CDN}; ` +
  `style-src 'unsafe-inline' ${CDN} https://fonts.googleapis.com; ` +
  "font-src data: https://fonts.gstatic.com https://cdnjs.cloudflare.com; " +
  `img-src data: blob: ${CDN}; media-src data: blob:; connect-src 'none'`;

// Theme tokens injected into every frame. light-dark() resolves against the
// color-scheme we stamp per the app's current theme; the frame's own <style>
// comes later in the document, so a widget that sets its own colors still wins.
function themeStyle(theme: "light" | "dark"): string {
  return (
    `<style>:root{color-scheme:${theme};` +
    "--bg:light-dark(#ffffff,#1f1f23);--surface:light-dark(#f3f3f3,#28282e);" +
    "--text-primary:light-dark(#1a1a1a,#e4e4e7);--text-secondary:light-dark(rgba(0,0,0,.5),rgba(255,255,255,.62));" +
    "--text-tertiary:light-dark(#7d8796,#a1a1aa);--border:light-dark(rgba(20,24,31,.12),rgba(228,230,235,.16));" +
    "--hairline:light-dark(rgba(20,24,31,.08),rgba(228,230,235,.1));--accent:light-dark(#2563eb,#60a5fa);" +
    "--success:light-dark(#047857,#34d399);--warning:light-dark(#b45309,#f59e0b);--error:light-dark(#b91c1c,#f87171);" +
    // app aliases so widgets can also use the exact --ui-* names the app ships
    "--ui-surface-1:var(--bg);--ui-surface-2:var(--surface);--ui-text-1:var(--text-primary);" +
    "--ui-text-2:var(--text-secondary);--ui-text-3:var(--text-tertiary);--ui-focus:var(--accent)}" +
    "html,body{background:var(--bg);color:var(--text-primary)}" +
    "body{margin:0;padding:16px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.5}</style>"
  );
}

// Runs FIRST (injected into <head>, before the widget's own scripts): the reverse
// channel + live theme sync must exist before widget code calls sendPrompt.
const HEAD_SCRIPT =
  "<script>" +
  "window.sendPrompt=function(t){try{parent.postMessage({__chatHtmlArtifact:'sendPrompt',text:String(t)},'*')}catch(_){}};" +
  "addEventListener('message',function(e){var d=e.data;if(d&&d.__chatHtmlArtifact==='theme'){var r=document.documentElement;r.style.colorScheme=d.theme;r.setAttribute('data-theme',d.theme)}});" +
  "</script>";
// Runs LAST (end of <body>): content-height reporting (needs the body laid out).
const BODY_SCRIPT =
  "<script>(function(){" +
  "function h(){var b=document.body;return b?Math.max(b.scrollHeight,b.offsetHeight):document.documentElement.scrollHeight}" +
  "function s(){try{parent.postMessage({__chatHtmlArtifact:'height',height:h()},'*')}catch(_){}}" +
  "try{new ResizeObserver(s).observe(document.body||document.documentElement)}catch(_){}" +
  "addEventListener('load',s);addEventListener('resize',s);setTimeout(s,60);setTimeout(s,300);setTimeout(s,1000);s();})();</script>";

function currentTheme(): "light" | "dark" {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

// Wrap the agent's HTML into a document we control: our <head> injections (CSP +
// charset + theme) go FIRST so they govern everything after; the frame script goes
// last. Works whether the agent wrote a full document, an <html> without <head>,
// or a bare fragment.
function buildSrcdoc(rawHtml: string, theme: "light" | "dark"): string {
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">${themeStyle(theme)}${HEAD_SCRIPT}`;
  const withEnd = (html: string) =>
    /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${BODY_SCRIPT}</body>`) : html + BODY_SCRIPT;

  const headOpen = rawHtml.match(/<head[^>]*>/i);
  if (headOpen) {
    const i = headOpen.index! + headOpen[0].length;
    return withEnd(rawHtml.slice(0, i) + head + rawHtml.slice(i));
  }
  const htmlOpen = rawHtml.match(/<html[^>]*>/i);
  if (htmlOpen) {
    const i = htmlOpen.index! + htmlOpen[0].length;
    return withEnd(`${rawHtml.slice(0, i)}<head>${head}</head>${rawHtml.slice(i)}`);
  }
  return `<!doctype html><html><head>${head}</head><body>${rawHtml}${BODY_SCRIPT}</body></html>`;
}

function mount(el: HTMLElement) {
  el.setAttribute("data-mounted", "1");
  mountedKeys.add(el.getAttribute("data-html") || "");
  const raw = decodeURIComponent(el.getAttribute("data-html") || "");

  const bar = document.createElement("div");
  bar.className = "chat-html-bar";
  const label = document.createElement("span");
  label.className = "chat-html-bar__label";
  label.textContent = "HTML";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "chat-html-toggle";
  toggle.textContent = "源码";
  bar.appendChild(label);
  bar.appendChild(toggle);

  const iframe = document.createElement("iframe");
  iframe.className = "chat-html-frame";
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("loading", "lazy");
  iframe.setAttribute("title", "HTML preview");
  iframe.style.height = `${INITIAL_H}px`;
  iframe.srcdoc = buildSrcdoc(raw, currentTheme());

  el.insertBefore(bar, el.firstChild);
  bar.insertAdjacentElement("afterend", iframe);
  el.setAttribute("data-view", "preview");
}

function sweep() {
  document
    .querySelectorAll<HTMLElement>(".chat-html-artifact:not([data-mounted])")
    .forEach(mount);
}

// Sync pass (runs in the observer microtask, before paint): re-mount only
// placeholders whose content we've already mounted once — a re-render rebuilt the
// DOM. New/streaming content is left for the debounced sweep, so a half-typed
// ```html isn't mounted mid-stream.
function remountKnown() {
  document.querySelectorAll<HTMLElement>(".chat-html-artifact:not([data-mounted])").forEach((el) => {
    if (mountedKeys.has(el.getAttribute("data-html") || "")) mount(el);
  });
}

// Registered by ChatPage so window.sendPrompt(text) inside a widget forwards to
// the chat composer (sends as if the user typed it, matching the real host).
export function setSendPromptHandler(fn: (text: string) => void): void {
  sendPromptHandler = fn;
}

export function installHtmlArtifacts(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;

  let timer: number | undefined;
  const schedule = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(sweep, MOUNT_SETTLE_MS);
  };
  new MutationObserver(() => {
    remountKnown(); // sync, before paint → re-renders of known artifacts don't flash source
    schedule(); // debounced → new/streaming artifacts mount once settled
  }).observe(document.body, { childList: true, subtree: true });

  // Messages from frames. A no-same-origin sandbox has an opaque origin, so match
  // the reporting frame by e.source, not by origin.
  window.addEventListener("message", (e) => {
    const d = e.data as { __chatHtmlArtifact?: string; height?: number; text?: string } | null;
    if (!d || typeof d.__chatHtmlArtifact !== "string") return;
    const frames = document.querySelectorAll<HTMLIFrameElement>("iframe.chat-html-frame");
    if (d.__chatHtmlArtifact === "height") {
      frames.forEach((f) => {
        if (f.contentWindow === e.source) {
          f.style.height = `${Math.max(MIN_H, Math.min(MAX_H, Number(d.height) || 0))}px`;
        }
      });
    } else if (d.__chatHtmlArtifact === "sendPrompt") {
      const fromOurFrame = Array.from(frames).some((f) => f.contentWindow === e.source);
      const text = String(d.text ?? "").slice(0, SENDPROMPT_MAX).trim();
      if (fromOurFrame && text && sendPromptHandler) sendPromptHandler(text);
    }
  });

  // Live theme sync: when the app flips data-theme on <html>, tell every frame.
  new MutationObserver(() => {
    const theme = currentTheme();
    document.querySelectorAll<HTMLIFrameElement>("iframe.chat-html-frame").forEach((f) => {
      f.contentWindow?.postMessage({ __chatHtmlArtifact: "theme", theme }, "*");
    });
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // Preview / source toggle (delegated, mirrors the code-block copy button).
  document.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement)?.closest?.(".chat-html-toggle") as HTMLElement | null;
    if (!btn) return;
    const art = btn.closest(".chat-html-artifact") as HTMLElement | null;
    if (!art) return;
    const showingSource = art.getAttribute("data-view") === "source";
    art.setAttribute("data-view", showingSource ? "preview" : "source");
    btn.textContent = showingSource ? "源码" : "预览";
  });

  sweep(); // messages already in the DOM (e.g. loaded from history)
}
