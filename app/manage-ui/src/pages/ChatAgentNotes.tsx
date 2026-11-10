import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePageCache } from "../lib/usePageCache";
import { readAllAgentInspirationPages } from "./inspiration-wall-pages";
import { inspirationNoteContent } from "./inspiration-note-text";
import InspirationStatusIcon from "./InspirationStatusIcon";
import { IdeaDetail } from "./InspirationThread";
import styles from "./ChatAgentPanel.module.css";

export default function ChatAgentNotes({ backendId, agentId }: { backendId: string; agentId: string }) {
  const { t } = useTranslation();
  const pages = useRef(1);
  const page = usePageCache(`chat-agent-notes:${JSON.stringify([backendId, agentId])}`,
    () => readAllAgentInspirationPages(pages.current, { backendId, agentId }));
  if (page.data) pages.current = Math.max(pages.current, page.data.pageCount);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
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
    {page.data?.items.map(idea => <div key={idea.id} className={styles.idea}>
      <button type="button" className={styles.ideaButton}
        data-inspiration-id={idea.id} aria-haspopup="dialog" title={t("chat.agentNoteOpen")}
        onClick={() => { setDetailId(idea.id); setDetailOpen(true); }}>
        <InspirationStatusIcon status={idea.status} archived={idea.archivedAt !== null} />
        <span className={styles.ideaPreview}>{inspirationNoteContent(idea).body.replace(/\s+/g, " ").trim()
          || idea.attachments?.[0]?.name || t("chat.agentNoteContents")}</span>
        <span className={styles.state}>{t(idea.archivedAt !== null ? "inspiration.filters.archived" : `inspiration.status.${idea.status}`)}</span>
        <svg className={styles.chevron} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
      </button>
    </div>)}
    {page.data?.hasMore && <button type="button" className={`btn-subtle ${styles.more}`} disabled={loadingMore}
      onClick={() => { void loadMore(); }}>{t(loadingMore ? "common.loading" : "dashboard.loadMore")}</button>}
    {detailId && <IdeaDetail key={detailId} id={detailId} open={detailOpen}
      onClose={() => setDetailOpen(false)} onOpenChangeComplete={open => { if (!open) setDetailId(null); }}
      onChange={page.refresh} />}
  </section>;
}
