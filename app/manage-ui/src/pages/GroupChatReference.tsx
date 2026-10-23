import '../i18n/groupReferenceResources';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../components/Modal';
import { searchGlobalChats } from '../api/client';
import type { GlobalChatSearchHit, GlobalChatSearchResult } from '../types';
import { groupReferenceExcerpt } from '../lib/groupReferenceExcerpt';
import styles from './GroupChatReference.module.css';

export default function GroupChatReference({ onClose, onInsert }: { onClose(): void; onInsert(text: string): boolean }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<GlobalChatSearchResult | null>(null);
  const [selected, setSelected] = useState<{ hit: GlobalChatSearchHit; collectedAt: string } | null>(null);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);
  const search = async (more = false) => {
    const q = more ? page?.query : query.trim();
    if (!q || more && (!page?.hasMore || page.nextOffset === undefined)) return;
    controller.current?.abort(); const token = ++generation.current;
    const abort = new AbortController(); controller.current = abort;
    setLoading(true); setError(null); setSelected(null); setText('');
    if (!more) setPage(null);
    try {
      const next = await searchGlobalChats(q, { limit: 20, offset: more ? page!.nextOffset : 0, signal: abort.signal });
      if (token !== generation.current || abort.signal.aborted) return;
      if (next.query !== q || !Array.isArray(next.results)) throw new Error(t('groupChat.reference.invalid'));
      setPage(previous => ({ ...next, results: more && previous?.query === q ? [...previous.results, ...next.results] : next.results }));
    } catch (cause) {
      if (token === generation.current && !abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (token === generation.current) setLoading(false); }
  };
  const excerpt = selected ? groupReferenceExcerpt(selected.hit, text, selected.collectedAt, {
    title: t('groupChat.reference.excerptTitle'), scope: t('groupChat.reference.scope'), source: t('groupChat.reference.source'),
    session: t('groupChat.reference.session'), message: t('groupChat.reference.message'), time: t('groupChat.reference.time'), unknown: t('groupChat.reference.unknown'),
  }) : null;
  return <Modal open width={760} title={t('groupChat.reference.title')} onClose={onClose}
    footer={<><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
      <button type="button" className="btn" disabled={!excerpt || loading} onClick={() => { if (excerpt && onInsert(excerpt)) onClose(); }}>{t('groupChat.reference.insert')}</button></>}>
    <p>{t('groupChat.reference.hint')}</p>
    <form className={styles.search} onSubmit={event => { event.preventDefault(); void search(); }}>
      <input aria-label={t('groupChat.reference.query')} value={query} maxLength={200} onChange={event => {
        controller.current?.abort(); generation.current++; setLoading(false); setQuery(event.target.value); setPage(null); setSelected(null); setText(''); setError(null);
      }} />
      <button type="submit" className="btn" disabled={!query.trim() || loading}>{t(loading ? 'groupChat.reference.searching' : 'groupChat.reference.search')}</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {page && (page.failedAgents > 0 || page.unsupportedAgents > 0 || page.truncated) && <p role="status">{t('groupChat.reference.partial')}</p>}
    {page && !page.results.length && <p>{t('groupChat.reference.empty')}</p>}
    <div className={styles.results}>{page?.results.map((hit, index) => <article key={`${hit.backendId}:${hit.agentId}:${hit.key}:${hit.messageId ?? index}`}>
      <strong>{hit.agentName}</strong><span> · {hit.backendId}</span>
      <p className={styles.snippet}>{hit.snippet}</p>
      <button type="button" className="btn-sm" disabled={loading} onClick={() => {
        setSelected({ hit, collectedAt: new Date().toISOString() }); setText(hit.snippet);
      }}>{t('groupChat.reference.choose')}</button>
    </article>)}</div>
    {page?.hasMore && <button type="button" className="btn-sm" disabled={loading} onClick={() => void search(true)}>{t('groupChat.reference.more')}</button>}
    {selected && <label className={styles.editor}>{t('groupChat.reference.selected')}
      <textarea rows={7} value={text} onChange={event => setText(event.target.value)} />
      <small>{t('groupChat.reference.limit')}</small>{!excerpt && <small role="alert">{t('groupChat.reference.invalid')}</small>}
    </label>}
  </Modal>;
}
