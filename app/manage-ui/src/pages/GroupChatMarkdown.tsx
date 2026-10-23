import { createElement, memo, useContext, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import GroupChatMention from "./GroupChatMention";
import { ChatMediaContext } from "../components/ChatMediaContext";
import { toSanitizedMarkdownHtml } from "../lib/markdown";
import { groupMentionCandidates, splitGroupMentions } from "../lib/groupMentions";
import type { GroupChatMember } from "../types";

const NO_MENTIONS = new Set(["a", "pre", "code", "button", "img"]);
const ATTR_NAMES: Record<string, string> = { class: "className", referrerpolicy: "referrerPolicy" };

/** Decorate only sanitized visible text. Links, code and their copy/preview controls stay intact. */
const GroupChatMarkdown = memo(function GroupChatMarkdown({ text, className, members = [], onMemberClick, lead }: {
  text: string; className: string; members?: GroupChatMember[]; onMemberClick?(memberId: string): void; lead?: ReactNode;
}) {
  const { i18n } = useTranslation();
  const imageContext = useContext(ChatMediaContext);
  const html = useMemo(() => toSanitizedMarkdownHtml(text, true, imageContext), [text, imageContext, i18n.language, i18n.resolvedLanguage]);
  const candidates = useMemo(() => groupMentionCandidates(members), [members]);
  const content = useMemo(() => {
    if (!lead && (!onMemberClick || !candidates.length || !html.includes("@"))) return null;
    const template = document.createElement("template");
    template.innerHTML = html;
    let matched = false, leadPlaced = false;
    const render = (node: Node, key: number, blocked = false): ReactNode => {
      if (node.nodeType === Node.TEXT_NODE) {
        const value = node.textContent ?? "";
        if (blocked || !onMemberClick) return value;
        return splitGroupMentions(value, candidates).map((part, index) => {
          if (!part.member) return part.text;
          matched = true;
          return <GroupChatMention key={index} member={part.member} text={part.text} onOpen={onMemberClick} />;
        });
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
    return matched || lead ? result : null;
  }, [html, candidates, onMemberClick, lead]);
  return content ? <div className={className}>{content}</div>
    : <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
});

export default GroupChatMarkdown;
