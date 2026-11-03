import { memo, useContext, useLayoutEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toSanitizedMarkdownHtml, type HtmlArtifactPolicy } from "../lib/markdown";
import { ChatMediaContext } from "./ChatMediaContext";
import "./ChatMarkdown.css";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Keep settled HTML with its mounted message. The shared Markdown LRU can evict
// old entries, but typing, opening a menu or streaming another reply must not
// reparse the entire transcript. Locale changes still refresh code-block controls.
const ChatMarkdown = memo(function ChatMarkdown({ text, className, htmlArtifactPolicy = "source", streamingCursor = false, "data-qp": quotePart }: {
  text: string;
  className: string;
  "data-qp"?: number;
  htmlArtifactPolicy?: HtmlArtifactPolicy;
  streamingCursor?: boolean;
}) {
  const { i18n } = useTranslation();
  const imageContext = useContext(ChatMediaContext);
  const html = useMemo(() => toSanitizedMarkdownHtml(text, true, imageContext, htmlArtifactPolicy), [text, imageContext, htmlArtifactPolicy, i18n.language, i18n.resolvedLanguage]);
  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!streamingCursor || !root) return;
    // The sanitized Markdown owns the text. Anchor the decoration to its last
    // visible grapheme, keeping formatting and natural line wrapping intact.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!node.textContent?.trim() || parent?.closest("button, .code-block-header, [aria-hidden='true']")) return NodeFilter.FILTER_REJECT;
        const closed = parent?.closest("details:not([open])");
        if (closed && !closed.querySelector("summary")?.contains(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const lastText = walker.lastChild() as Text | null;
    if (!lastText) return;
    const content = lastText.data.trimEnd();
    const last = graphemes.segment(content).containing(content.length - 1);
    if (!last) return;
    const range = document.createRange();
    range.setStart(lastText, last.index);
    range.setEnd(lastText, content.length);
    const tail = document.createElement("span");
    tail.className = "chat-cursor-tail";
    const cursor = document.createElement("span");
    cursor.className = "chat-cursor";
    cursor.setAttribute("aria-hidden", "true");
    tail.append(range.extractContents(), cursor);
    range.insertNode(tail);
    const parent = tail.parentNode;
    return () => {
      cursor.remove();
      tail.replaceWith(...tail.childNodes);
      parent?.normalize();
    };
  }, [html, streamingCursor]);
  return <div ref={rootRef} className={className} data-qp={quotePart} onClick={event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".code-block-copy");
    if (!button || !event.currentTarget.contains(button)) return;
    // Own the interaction here so Markdown also works outside the Chat page.
    event.preventDefault(); event.stopPropagation();
    const decoder = document.createElement("textarea");
    decoder.innerHTML = button.getAttribute("data-code") || "";
    void navigator.clipboard?.writeText(decoder.value).then(() => {
      button.classList.add("copied");
      setTimeout(() => button.classList.remove("copied"), 1500);
    }).catch(() => {});
  }} dangerouslySetInnerHTML={{ __html: html }} />;
});

export default ChatMarkdown;
