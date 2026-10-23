import '../i18n/groupCollaborationResources';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../components/Modal';
import { groupSendJournal, type GroupJournalRecoveryPage } from '../lib/groupSendJournal';
import styles from './GroupChatJournalRecovery.module.css';

export default function GroupChatJournalRecovery({ ownerScope, groupId, onClose }: {
  ownerScope: string; groupId: string; onClose(): void;
}) {
  const { t } = useTranslation();
  const [page, setPage] = useState<GroupJournalRecoveryPage | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState(false);
  const generation = useRef(0), currentScope = useRef('');
  const scope = JSON.stringify([ownerScope, groupId]); currentScope.current = scope;
  const read = async (previous: GroupJournalRecoveryPage | null = null) => {
    const id = ++generation.current, captured = scope;
    setLoading(true); setError(false); if (!previous) setPage(null);
    try {
      const next = await groupSendJournal.recover(ownerScope, groupId, previous?.nextOffset ?? 0, previous?.snapshotDigest ?? null);
      if (id !== generation.current || captured !== currentScope.current) return;
      if (previous && next.snapshotDigest !== previous.snapshotDigest) throw Error('changed recovery snapshot');
      setPage({ ...next, skipped: (previous?.skipped ?? 0) + next.skipped,
        collectionTruncated: next.collectionTruncated || previous?.collectionTruncated === true });
    } catch {
      if (id === generation.current && captured === currentScope.current) setError(true);
    } finally { if (id === generation.current && captured === currentScope.current) setLoading(false); }
  };
  useEffect(() => { void read(); return () => { generation.current++; }; }, [scope]); // Explicitly opened recovery only.
  const shown = page?.ownerScope === ownerScope && page.groupId === groupId ? page : null;
  return <Modal open width={760} title={t('groupChat.sendJournal.recoveryTitle')} onClose={onClose}
    footer={<button type="button" className="btn" onClick={onClose}>{t('common.close')}</button>}>
    <div className={styles.root} data-group-journal-recovery>
      <p role="status">{t('groupChat.sendJournal.recoveryHint')}</p>
      <button type="button" className="btn-sm" disabled={loading} onClick={() => void read()}>{t('groupChat.sendJournal.recoveryRefresh')}</button>
      {loading && <p role="status">{t('groupChat.sendJournal.recoveryLoading')}</p>}
      {error && <p role="alert">{t('groupChat.sendJournal.recoveryUnavailable')}</p>}
      {shown?.items.map((item, index) => <article key={JSON.stringify([item.kind, item.id, index])}>
        <strong>{t(`groupChat.sendJournal.${item.kind === 'send' ? 'recoverySend' : 'recoveryDraft'}`)}</strong>
        <small>{item.id}</small>
        <textarea rows={5} readOnly aria-label={t('groupChat.sendJournal.recoveryText')} value={item.text}
          onFocus={event => event.currentTarget.select()} />
        {item.attachmentNames.map((name, n) => <p key={n}>{name}</p>)}
        {item.truncated && <p>{t('groupChat.sendJournal.recoveryTruncated')}</p>}
      </article>)}
      {shown && !shown.items.length && !loading && <p>{t('groupChat.sendJournal.recoveryEmpty')}</p>}
      {shown && (shown.skipped > 0 || shown.collectionTruncated) && <p>{t('groupChat.sendJournal.recoveryPartial')}</p>}
      {shown?.hasMore && <button type="button" className="btn-sm" disabled={loading} onClick={() => void read(shown)}>{t('groupChat.sendJournal.recoveryMore')}</button>}
    </div>
  </Modal>;
}
