import { createElement, memo, useContext, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import GroupChatMention from "./GroupChatMention";
import { ChatMediaContext } from "../components/ChatMediaContext";
import { toSanitizedMarkdownHtml } from "../lib/markdown";
import { groupMentionCandidates, splitGroupMentions } from "../lib/groupMentions";
import type { GroupChatMember, InspirationAttachment } from "../types";

const NO_MENTIONS = new Set(["a", "pre", "code", "button", "img"]);
const ATTR_NAMES: Record<string, string> = { class: "className", referrerpolicy: "referrerPolicy" };
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Only suppress files that already have an actionable link in the visible body. */
export function groupAttachmentsOutsideMarkdown(text: string, attachments: InspirationAttachment[]): InspirationAttachment[] {
  if (!text.trim() || !attachments.some(file => !file.mimeType.startsWith("image/"))) return attachments;
  const template = document.createElement("template");
  template.innerHTML = toSanitizedMarkdownHtml(text, true);
  const linkedIds = new Set<string>(), linkedNames = new Set<string>(), nameCounts = new Map<string, number>();
  for (const file of attachments) {
    const name = file.name.normalize("NFC");
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  for (const link of template.content.querySelectorAll("a")) {
    const localPath = link.getAttribute("data-local-path");
    if (localPath) {
      try {
        const path = decodeURIComponent(localPath).replace(/\/+$/, "");
        linkedNames.add(path.slice(path.lastIndexOf("/") + 1).normalize("NFC"));
      } catch { /* Keep the attachment when the inline path cannot be decoded. */ }
      continue;
    }
    try {
      const base = new URL(window.location.href), url = new URL(link.getAttribute("href") || "", base);
      if (url.origin === base.origin && url.protocol === base.protocol && url.host === base.host && url.pathname === "/__api/inspirations/media") {
        const id = url.searchParams.get("id");
        if (id) linkedIds.add(id);
      }
    } catch { /* An invalid link cannot replace an attachment button. */ }
  }
  return attachments.filter(file => file.mimeType.startsWith("image/") || !linkedIds.has(file.id)
    && !(nameCounts.get(file.name.normalize("NFC")) === 1 && linkedNames.has(file.name.normalize("NFC"))));
}

/** Decorate only sanitized visible text. Links, code and their copy/preview controls stay intact. */
const GroupChatMarkdown = memo(function GroupChatMarkdown({ text, className, members = [], onMemberClick, lead, streamingCursor = false }: {
  text: string; className: string; members?: GroupChatMember[]; onMemberClick?(memberId: string): void; lead?: ReactNode; streamingCursor?: boolean;
}) {
  const { i18n } = useTranslation();
  const imageContext = useContext(ChatMediaContext);
  const html = useMemo(() => toSanitizedMarkdownHtml(text, true, imageContext), [text, imageContext, i18n.language, i18n.resolvedLanguage]);
  const candidates = useMemo(() => groupMentionCandidates(members), [members]);
  const content = useMemo(() => {
    if (!lead && !streamingCursor && (!onMemberClick || !candidates.length || !html.includes("@"))) return null;
    const template = document.createElement("template");
    template.innerHTML = html;
    const cursorText = streamingCursor ? document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT, { acceptNode(node) {
      const parent = node.parentElement;
      if (!node.textContent?.trim() || parent?.closest("button, .code-block-header, [aria-hidden='true']")) return NodeFilter.FILTER_REJECT;
      const closed = parent?.closest("details:not([open])");
      return closed && !closed.querySelector("summary")?.contains(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    } }).lastChild() : null;
    let matched = false, leadPlaced = false;
    const render = (node: Node, key: number, blocked = false): ReactNode => {
      if (node.nodeType === Node.TEXT_NODE) {
        const value = node.textContent ?? "";
        const parts: ReactNode[] = blocked || !onMemberClick ? [value] : splitGroupMentions(value, candidates).map((part, index) => {
          if (!part.member) return part.text;
          matched = true;
          return <GroupChatMention key={index} member={part.member} text={part.text} onOpen={onMemberClick} />;
        });
        if (node === cursorText) {
          const last = parts.pop();
          const value = typeof last === "string" ? last.trimEnd() : "";
          const tail = value ? graphemes.segment(value).containing(value.length - 1) : null;
          if (tail) parts.push(value.slice(0, tail.index));
          parts.push(<span key="streaming-cursor" className="chat-cursor-tail">{tail ? value.slice(tail.index) : last}
            <span className="chat-cursor" aria-hidden="true" /></span>);
          if (typeof last === "string") parts.push(last.slice(value.length));
        }
        return parts;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return null;
      const element = node as Element, tag = element.tagName.toLowerCase();
      const props: Record<string, unknown> = { key };
      for (const { name, value } of element.attributes) props[ATTR_NAMES[name] ?? name] = name === "disabled" ? true : value;
      if (tag === "input") { props.checked = element.hasAttribute("checked"); props.readOnly = true; }
      const children = Array.from(element.childNodes, (child, index) => render(child, index, blocked || NO_MENTIONS.has(tag)));
      if (lead && tag === "p" && element === template.content.firstElementChild) {
        children.unshift(lead); leadPlaced = true;
      }
      return createElement(tag, props, ...children);
    };
    const result = Array.from(template.content.childNodes, (node, index) => render(node, index));
    if (lead && !leadPlaced) result.unshift(<p key="assignment-target">{lead}</p>);
    return matched || lead || streamingCursor ? result : null;
  }, [html, candidates, onMemberClick, lead, streamingCursor]);
  return content ? <div className={className}>{content}</div>
    : <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
});

export default GroupChatMarkdown;
