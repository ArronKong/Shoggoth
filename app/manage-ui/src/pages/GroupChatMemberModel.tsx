import '../i18n/groupModelResources';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Field } from '../components/Field';
import { getGroupChatMemberModels, setGroupChatMemberModel } from '../api/groupMemberModel';
import type { GroupChatMember, GroupChatMemberModels, GroupChatModelSelection, GroupChatView } from '../types';
import ChatModelMenu from './ChatModelMenu';
import styles from './GroupChatPanel.module.css';

export default function GroupChatMemberModel({ member, view, onView, isCurrentScope, disabled = false }: {
  member: GroupChatMember; view: GroupChatView; onView(view: GroupChatView): void;
  isCurrentScope(): boolean; disabled?: boolean;
}) {
  const { t } = useTranslation();
  const key = `${view.ownerScope ?? ''}:${view.group.id}:${member.id}`;
  const scope = useRef(key); scope.current = key;
  const currentScope = useRef(isCurrentScope); currentScope.current = isCurrentScope;
  const generation = useRef(0), mounted = useRef(false), saving = useRef(false);
  const [catalog, setCatalog] = useState<{ key: string; data: GroupChatMemberModels } | null>(null);
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const data = catalog?.key === key ? catalog.data : null;
  const current = () => mounted.current && scope.current === key && currentScope.current();
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true); setLoadError(false);
    try {
      const result = await getGroupChatMemberModels(view.group.id, member.id);
      if (mounted.current && scope.current === key && currentScope.current() && request === generation.current) setCatalog({ key, data: result });
    } catch {
      if (mounted.current && scope.current === key && currentScope.current() && request === generation.current) setLoadError(true);
    } finally {
      if (mounted.current && scope.current === key && currentScope.current() && request === generation.current) setLoading(false);
    }
  }, [key, member.id, view.group.id]);
  useEffect(() => {
    mounted.current = true; void refresh();
    return () => { mounted.current = false; generation.current++; };
  }, [refresh]);
  const selection = member.modelSelection ?? null;
  const choose = async (next: GroupChatModelSelection | null) => {
    // Opening the menu refreshes its catalog. A visible cached choice may still
    // be submitted: the Service validates it against the fresh member catalog.
    if (!current() || disabled || saving.current || (next !== null && (loadError || !data))) return;
    saving.current = true; setBusy(true); setError(null);
    try {
      const updated = await setGroupChatMemberModel(view.group.id, { memberId: member.id,
        expectedRosterRevision: view.group.rosterRevision, modelSelection: next });
      if (current()) { onView(updated); void refresh(); }
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      saving.current = false;
      if (current()) setBusy(false);
    }
  };
  const available = selection && data?.models.find(item => item.id === selection.model && item.provider === selection.provider);
  return <div data-group-member-model={member.id} aria-busy={busy || loading}>
    <Field label={t('groupChat.model.label')} hint={t('groupChat.model.hint')}>
      <ChatModelMenu models={(data?.models ?? []).map(item => ({ ...item, provider: item.provider ?? undefined }))}
        activeModel={selection?.model ?? ''} activeProvider={selection?.provider ?? undefined}
        triggerLabel={selection ? available?.name ?? selection.model : t('groupChat.model.follow')}
        emptyLabel={t('groupChat.model.follow')} portalInDialog disabled={disabled || busy}
        loading={loading} loadError={loadError} onRefresh={() => void refresh()}
        onSelect={(model, provider) => void choose(model ? { model, provider: provider ?? null } : null)} />
    </Field>
    {!selection && data?.defaultModel && <p className={styles.muted}>{t('groupChat.model.currentDefault', { model: data.defaultModel })}</p>}
    {selection && <button type="button" className="btn-sm" disabled={disabled || busy} onClick={() => void choose(null)}>{t('groupChat.model.follow')}</button>}
    {loading && <p className={styles.muted} role="status">{t('groupChat.model.loading')}</p>}
    {loadError && <p className={styles.error} role="alert">{t('groupChat.model.loadError')}{' '}
      <button type="button" className="btn-sm" disabled={busy} onClick={() => void refresh()}>{t('groupChat.model.retry')}</button></p>}
    {!loading && !loadError && selection && data && !available && <p className={styles.muted}>{t('groupChat.model.missing')}</p>}
    {busy && <p className={styles.muted} role="status">{t('groupChat.model.saving')}</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </div>;
}
