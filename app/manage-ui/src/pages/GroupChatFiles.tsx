import '../i18n/groupFilesResources';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getGroupChat, listGroupChatMessages, revealAttachment } from '../api/client';
import type { GroupChatMessage, GroupChatView, InspirationAttachment } from '../types';
import { inspirationMediaUrl } from './inspiration-media';
import close from '../assets/figma/group-chat/group-files-close.svg';
import ArtifactThumb from '../components/ArtifactThumb';
import styles from './GroupChatFiles.module.css';

type GroupFile = { attachment: InspirationAttachment; author: GroupChatMessage['author']; createdAt: number; seq: number };
type FileState = { scope: string; items: GroupFile[]; loading: boolean; error: 'failed' | 'partial' | 'changed' | null };
const PAGE = 100;

function fileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** Group files come from this group's saved message attachments, including older pages and user uploads. */
export default function GroupChatFiles({ view, onClose }: { view: GroupChatView; onClose(): void }) {
  const { t, i18n } = useTranslation();
  const scope = JSON.stringify([view.group.id, view.ownerScope ?? null]);
  const liveScope = useRef(scope); liveScope.current = scope;
  const generation = useRef(0);
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<FileState>({ scope, items: [], loading: true, error: null });
  const [revealError, setRevealError] = useState<{ scope: string; error: string } | null>(null);
  const active = state.scope === scope ? state : { scope, items: [], loading: true, error: null };
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);

  useEffect(() => {
    const token = ++generation.current;
    let disposed = false;
    const current = () => !disposed && generation.current === token && liveScope.current === scope;
    setState({ scope, items: [], loading: true, error: null });
    setRevealError(null);
    void (async () => {
      const collected = new Map<string, GroupFile>();
      const items = () => [...collected.values()].sort((a, b) => b.seq - a.seq);
      let beforeSeq: number | undefined;
      let ownerChanged = false;
      const confirmOwner = async () => {
        const next = await getGroupChat(view.group.id);
        if (!current()) return false;
        if (next.group.id !== view.group.id || (next.ownerScope ?? null) !== (view.ownerScope ?? null)) {
          ownerChanged = true;
          throw Error('GROUP_FILES_SOURCE_CHANGED');
        }
        return true;
      };
      try {
        if (!await confirmOwner()) return;
        while (current()) {
          const result = await listGroupChatMessages(view.group.id, { beforeSeq, limit: PAGE });
          if (!current()) return;
          // History has no owner field. Recheck its authority before publishing each page.
          if (!await confirmOwner()) return;
          if (typeof result.hasMore !== 'boolean' || !Array.isArray(result.messages) || result.messages.some(message => message.groupId !== view.group.id
            || !Number.isSafeInteger(message.seq) || message.seq <= 0 || beforeSeq !== undefined && message.seq >= beforeSeq)) {
            throw Error('GROUP_FILES_INVALID_HISTORY');
          }
          for (const message of [...result.messages].sort((a, b) => b.seq - a.seq)) {
            if (message.author.kind === 'system') continue;
            for (const attachment of message.attachments ?? []) {
              if (!attachment.id || !attachment.name || typeof attachment.mimeType !== 'string'
                || !Number.isSafeInteger(attachment.size) || attachment.size < 0) throw Error('GROUP_FILES_INVALID_ATTACHMENT');
              // A reused media ID is one shared file; keep its latest public author and message time.
              if (!collected.has(attachment.id)) collected.set(attachment.id, { attachment, author: message.author, createdAt: message.createdAt, seq: message.seq });
            }
          }
          setState({ scope, items: items(), loading: result.hasMore, error: null });
          if (!result.hasMore) return;
          const nextBefore = Math.min(...result.messages.map(message => message.seq));
          if (!Number.isSafeInteger(nextBefore) || beforeSeq !== undefined && nextBefore >= beforeSeq) throw Error('GROUP_FILES_STALLED_HISTORY');
          beforeSeq = nextBefore;
        }
      } catch {
        if (current()) setState({ scope, items: ownerChanged ? [] : items(), loading: false,
          error: ownerChanged ? 'changed' : collected.size ? 'partial' : 'failed' });
      }
    })();
    return () => { disposed = true; generation.current++; };
  }, [scope, reload, view.group.id, view.ownerScope]);

  const relativeTime = (timestamp: number) => {
    const diff = Math.max(0, now - timestamp);
    if (diff < 60_000) return t('dashboard.justNow');
    if (diff < 3_600_000) return t('dashboard.minutesAgo', { count: Math.floor(diff / 60_000) });
    if (diff < 86_400_000) return t('dashboard.hoursAgo', { count: Math.floor(diff / 3_600_000) });
    if (diff < 7 * 86_400_000) return t('dashboard.daysAgo', { count: Math.floor(diff / 86_400_000) });
    return new Date(timestamp).toLocaleDateString(i18n.language);
  };
  const reveal = async (item: GroupFile) => {
    const token = generation.current;
    setRevealError(null);
    try {
      const latest = await getGroupChat(view.group.id);
      if (liveScope.current !== scope || generation.current !== token) return;
      if (latest.group.id !== view.group.id || (latest.ownerScope ?? null) !== (view.ownerScope ?? null)) {
        setState({ scope, items: [], loading: false, error: 'changed' });
        return;
      }
      await revealAttachment(item.attachment.name, inspirationMediaUrl(item.attachment.id));
    } catch {
      if (liveScope.current === scope && generation.current === token) setRevealError({ scope, error: t('groupChat.files.revealFailed') });
    }
  };

  return <section className={styles.panel} data-group-files aria-label={t('groupChat.files.open')}>
    <header className={styles.header}>
      <h2>{t('groupChat.files.title', { count: active.items.length })}</h2>
      <button className={styles.close} data-group-files-close type="button" onClick={onClose} aria-label={t('common.close')} title={t('common.close')}><img src={close} alt="" /></button>
    </header>
    <div className={styles.scroll} aria-busy={active.loading}>
      {active.loading && <p className={styles.note} role="status">{t('groupChat.files.loading', { count: active.items.length })}</p>}
      {active.error && <div className={styles.notice} role="alert"><p>{t(`groupChat.files.${active.error}`, { count: active.items.length })}</p>
        {active.error !== 'changed' && <button type="button" onClick={() => setReload(value => value + 1)}>{t('groupChat.files.retry')}</button>}</div>}
      {revealError?.scope === scope && <p className={styles.notice} role="alert">{revealError.error}</p>}
      {!active.loading && !active.error && !active.items.length && <p className={styles.empty}>{t('groupChat.files.empty')}</p>}
      <div className={styles.list}>
        {active.items.map(item => <button className={styles.file} data-group-file={item.attachment.id} key={item.attachment.id} type="button"
          title={t('groupChat.files.reveal', { name: item.attachment.name })} onClick={() => void reveal(item)}>
          <ArtifactThumb name={item.attachment.name} />
          <span className={styles.body}>
            <span className={styles.name}>{item.attachment.name}</span>
            <span className={styles.author}>{item.author.kind === 'user' ? t('groupChat.files.me')
              : view.members.find(member => item.author.kind === 'member' && member.id === item.author.memberId)?.displayName ?? t('groupChat.files.unknownMember')}</span>
            <span className={styles.meta}><span>{fileSize(item.attachment.size)}</span><time dateTime={new Date(item.createdAt).toISOString()}>{relativeTime(item.createdAt)}</time></span>
          </span>
        </button>)}
      </div>
    </div>
  </section>;
}
