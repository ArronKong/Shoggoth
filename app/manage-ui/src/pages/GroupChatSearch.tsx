import '../i18n/groupSearchResources';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../components/Modal';
import { searchGroupChatMessages, type GroupChatSearchResult } from '../api/groupReads';
import type { GroupChatView, GroupChatMessage } from '../types';
import { groupReplyBody } from '../lib/groupReply';
import styles from './GroupChatSearch.module.css';

export default function GroupChatSearch({ view, onClose, onOpenMessage }: {
  view: GroupChatView; onClose(): void; onOpenMessage(message: GroupChatMessage): void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState(''), [author, setAuthor] = useState('');
  const [result, setResult] = useState<{ scope: string; page: GroupChatSearchResult } | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null), generation = useRef(0);
  const scope = JSON.stringify([view.ownerScope ?? '', view.group.id, query, author]);
  const liveScope = useRef(scope); liveScope.current = scope;
  const page = result?.scope === scope ? result.page : null;
  useEffect(() => { generation.current++; controller.current?.abort(); setResult(null); setLoading(false); setError(null); }, [scope]);
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);
  const search = async (more = false) => {
    const q = query.trim();
    if (!q || more && (!page?.hasMore || !page.nextCursor)) return;
    controller.current?.abort(); const token = ++generation.current;
    const abort = new AbortController(); controller.current = abort;
    setLoading(true); setError(null); if (!more) setResult(null);
    const authorKind = author === 'user' ? 'user' : author ? 'member' : null;
    const memberId = author && author !== 'user' ? author.slice(7) : null;
    try {
      const next = await searchGroupChatMessages(view.group.id, { query: q, discussionId: null,
        authorKind, memberId, cursor: more ? page!.nextCursor : null, signal: abort.signal });
      if (token !== generation.current || liveScope.current !== scope || abort.signal.aborted) return;
      if (next.groupId !== view.group.id || next.query !== q || next.discussionId !== null
        || next.authorKind !== authorKind || next.memberId !== memberId
        || more && next.upperSeq !== page!.upperSeq || next.hits.some(hit => hit.message.groupId !== view.group.id)) throw Error(t('groupChat.search.invalid'));
      setResult({ scope, page: { ...next, hits: more ? [...page!.hits, ...next.hits] : next.hits } });
    } catch { if (token === generation.current && liveScope.current === scope && !abort.signal.aborted) setError(t('groupChat.search.failed')); }
    finally { if (token === generation.current && liveScope.current === scope) setLoading(false); }
  };
  return <Modal open width={760} title={t('groupChat.search.title')} onClose={onClose}>
    <div className={styles.root} data-group-search>
      <p>{t('groupChat.search.hint')}</p>
      <form className={styles.form} onSubmit={event => { event.preventDefault(); void search(); }}>
        <label className={styles.query}>{t('groupChat.search.query')}<input maxLength={200} value={query} onChange={event => setQuery(event.target.value)} /></label>
        <label>{t('groupChat.search.author')}<select value={author} onChange={event => setAuthor(event.target.value)}>
          <option value="">{t('groupChat.search.allAuthors')}</option><option value="user">{t('groupChat.search.user')}</option>
          {view.members.map(member => <option key={member.id} value={`member:${member.id}`}>{member.displayName}</option>)}
        </select></label>
        <button className="btn" type="submit" disabled={!query.trim() || loading}>{t(loading ? 'groupChat.search.searching' : 'groupChat.search.search')}</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {page && <><p>{t('groupChat.search.snapshot', { seq: page.upperSeq })}</p>
        {page.partial && <p role="status">{t('groupChat.search.partial')}</p>}
        <div className={styles.results}>{page.hits.map(hit => <article key={hit.message.id}>
          <strong>{hit.message.author.kind === 'user' ? t('groupChat.search.user') : view.members.find(member => hit.message.author.kind === 'member' && member.id === hit.message.author.memberId)?.displayName ?? '—'} · {t('groupChat.search.sequence', { seq: hit.message.seq })}</strong>
          <p className={styles.snippet}>{hit.snippetOffset > 0 ? '…' : ''}{hit.snippetOffset === 0 ? groupReplyBody(hit.message, hit.snippet) : hit.snippet}</p>
          {hit.partial && <small>{t('groupChat.search.partialHit')}</small>}
          <button className="btn-sm" type="button" onClick={() => { if (liveScope.current === scope) onOpenMessage(hit.message); }}>{t('groupChat.search.read')}</button>
        </article>)}</div>
        {!page.hits.length && <p>{t('groupChat.search.empty')}</p>}
        {page.hasMore ? <button className="btn-sm" type="button" disabled={loading} onClick={() => void search(true)}>{t(loading ? 'groupChat.search.searching' : 'groupChat.search.more')}</button> : <p>{t('groupChat.search.finished')}</p>}
      </>}
    </div>
  </Modal>;
}
