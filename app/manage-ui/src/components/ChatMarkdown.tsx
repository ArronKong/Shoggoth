import { memo, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toSanitizedMarkdownHtml, type HtmlArtifactPolicy } from "../lib/markdown";
import { ChatMediaContext } from "./ChatMediaContext";

// Keep settled HTML with its mounted message. The shared Markdown LRU can evict
// old entries, but typing, opening a menu or streaming another reply must not
// reparse the entire transcript. Locale changes still refresh code-block controls.
const ChatMarkdown = memo(function ChatMarkdown({ text, className, htmlArtifactPolicy = "source", "data-qp": quotePart }: {
  text: string;
  className: string;
  "data-qp"?: number;
  htmlArtifactPolicy?: HtmlArtifactPolicy;
}) {
  const { i18n } = useTranslation();
  const imageContext = useContext(ChatMediaContext);
  const html = useMemo(() => toSanitizedMarkdownHtml(text, true, imageContext, htmlArtifactPolicy), [text, imageContext, htmlArtifactPolicy, i18n.language, i18n.resolvedLanguage]);
  return <div className={className} data-qp={quotePart} dangerouslySetInnerHTML={{ __html: html }} />;
});

export default ChatMarkdown;
