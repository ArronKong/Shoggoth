import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ChatMarkdown from "../components/ChatMarkdown";
import { usePageCache } from "../lib/usePageCache";
import { readAllAgentInspirationPages } from "./inspiration-wall-pages";
import { inspirationContentParts } from "./inspiration-content";
import { inspirationNoteContent } from "./inspiration-note-text";
import InspirationStatusIcon from "./InspirationStatusIcon";
import { IconAttachmentFolder } from "./chatIcons";
import styles from "./ChatAgentPanel.module.css";

export default function ChatAgentNotes({ backendId, agentId }: { backendId: string; agentId: string }) {
  const { t } = useTranslation();
  const pages = useRef(1);
  const page = usePageCache(`chat-agent-notes:${JSON.stringify([backendId, agentId])}`,
    () => readAllAgentInspirationPages(pages.current, { backendId, agentId }));
  if (page.data) pages.current = Math.max(pages.current, page.data.pageCount);
  const [loadingMore, setLoadingMore] = useState(false);
  const moreRequest = useRef<Promise<void> | null>(null);
  const loadMore = async () => {
    if (moreRequest.current || !page.data?.hasMore) return;
    pages.current = page.data.pageCount + 1;
    setLoadingMore(true);
    const request = page.refresh();
    moreRequest.current = request;
    try { await request; }
    finally { if (moreRequest.current === request) { moreRequest.current = null; setLoadingMore(false); } }
  };
  return <section aria-label={t("agents.tabInspiration")}>
    {page.loading && !page.data && <p className={styles.note} role="status">{t("common.loading")}</p>}
    {page.error && <p className={styles.error} role="alert">{page.error}</p>}
    {!page.loading && !page.error && page.data?.items.length === 0 && <p className={styles.note}>
      {t("agents.inspirationEmpty")}
    </p>}
    {page.data?.items.map(idea => <details key={idea.id} className={styles.idea} data-inspiration-id={idea.id}>
      <summary className={styles.ideaSummary}>
        <InspirationStatusIcon status={idea.status} archived={idea.archivedAt !== null} />
        <span className={styles.ideaPreview}>{inspirationNoteContent(idea).body.replace(/\s+/g, " ").trim()
          || idea.attachments?.[0]?.name || t("chat.agentNoteContents")}</span>
        <span className={styles.ideaOpenTitle}>{t("chat.agentNoteContents")}</span>
        <span className={styles.state}>{t(idea.archivedAt !== null ? "inspiration.filters.archived" : `inspiration.status.${idea.status}`)}</span>
        <svg className={styles.chevron} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="m5 6 3 3 3-3" /></svg>
      </summary>
      <div className={styles.ideaContents} data-note-content>
        {inspirationContentParts(inspirationNoteContent(idea)).map(part => part.kind === "text"
          ? <ChatMarkdown key={part.key} text={part.text} className={`chat-md ${styles.soul}`} />
          : <div key={part.key} className={styles.attachments}>{part.attachments.map(attachment =>
            <a key={attachment.id} className={styles.attachment} title={attachment.name}
              href={`#/inspirations?${new URLSearchParams({ id: idea.id })}`}>
              <IconAttachmentFolder /><span>{attachment.name}</span><span aria-hidden="true">↗</span>
            </a>)}</div>)}
        <a className={styles.noteLink} href={`#/inspirations?${new URLSearchParams({ id: idea.id })}`}>{t("chat.agentNoteOpen")} ↗</a>
      </div>
    </details>)}
    {page.data?.hasMore && <button type="button" className={`btn-subtle ${styles.more}`} disabled={loadingMore}
      onClick={() => { void loadMore(); }}>{t(loadingMore ? "common.loading" : "dashboard.loadMore")}</button>}
  </section>;
}
