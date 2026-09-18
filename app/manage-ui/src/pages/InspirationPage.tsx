import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHead } from '../components/PageHead';
import FilterTabs from '../components/FilterTabs';
import SearchCapsule from '../components/SearchCapsule';
import Modal from '../components/Modal';
import { Field, TextArea, TextInput, Select, Option } from '../components/Field';
import { useConfirm, useToast } from '../components/ui';
import { usePageCache } from '../lib/usePageCache';
import { useRegisterPageLoading, useRegisterPageRefresh } from '../lib/page-refresh';
import { useNavigationGuard } from '../lib/navigation-guard';
import { toSanitizedMarkdownHtml } from '../lib/markdown';
import { rememberInspirationReturn, forgetInspirationReturn } from '../lib/inspiration-navigation';
import { createInspiration, listInspirations, getInspiration, getInspirationAgents,
  getInspirationExecutions, updateInspiration, startInspiration, respondInspiration,
  cancelInspiration, deleteInspiration } from '../api/client';
import type { InspirationIdea, InspirationExecution, InspirationFilter, InspirationPatch, InspirationAttachment, InspirationAgent } from '../types';
import ChatPromptCard, { type ChatPromptResponse } from './ChatPromptCard';
import InspirationStatusIcon, { inspirationGrowthStage } from './InspirationStatusIcon';
import InspirationActionIcon from './InspirationActionIcon';
import InspirationActivity from './InspirationActivity';
import InspirationRunBar from './InspirationRunBar';
import InspirationTypewriter from './InspirationTypewriter';
import InspirationArchiveControls from './InspirationArchiveControls';
import InspirationCapture from './InspirationCapture';
import InspirationMediaEditor from './InspirationMedia';
import InspirationContent from './InspirationContent';
import { draftBytes as bytes, pickNextPaperTone, useInspirationDraft } from './inspiration-draft';
import InspirationAutoGrowth from './InspirationAutoGrowth';
import InspirationAgentChatter from './InspirationAgentChatter';
import InspirationAgentDock, { type InspirationAgentDockHandle } from './InspirationAgentDock';
import { prepareInspirationPaperFlight, type InspirationPaperFlight } from './inspiration-paper-motion';
import { readInspirationWallPages } from './inspiration-wall-pages';
import { beginInspirationCardDrag, type InspirationDropTarget } from './inspiration-card-drag';
import { attachInspirationScrollStages } from './inspiration-scroll-stages';
import { canStartInspiration, defaultInspirationAgent, inspirationStartFields } from './inspiration-execution';
import paperStyles from './InspirationPaper.module.css';
import pillStyles from '../components/PillTabs.module.css';
import styles from './InspirationPage.module.css';

const ACTIVE = new Set(['queued', 'starting', 'running', 'waiting_input', 'waiting_approval', 'unknown']);
const FILTERS: InspirationFilter[] = ['saved', 'active', 'result', 'archived', 'favorite'];
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const titleOf = (idea: InspirationIdea) => idea.title || idea.body.trim().split('\n')[0].slice(0, 80) || idea.attachments?.[0]?.name || '';
const displayStatusOf = (status: InspirationIdea['status'], execution?: InspirationExecution) =>
  execution?.attention?.active && execution.attention.request.kind !== 'user_input' ? 'waiting_approval'
    : status === 'canceled' ? 'failed' : status;
// Keep the original four-color mapping for notes saved before paperTone existed.
const paperToneOf = (idea: InspirationIdea) => idea.paperTone
  ?? [...idea.id].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 4;

function useVisibleRefresh(refresh: () => Promise<void>, interval = 3000) {
  const latest = useRef(refresh); latest.current = refresh;
  useEffect(() => {
    let pending = false;
    const poll = async () => {
      if (document.hidden || pending) return;
      pending = true;
      try { await latest.current(); } finally { pending = false; }
    };
    const timer = window.setInterval(() => { void poll(); }, interval);
    window.addEventListener('focus', poll);
    document.addEventListener('visibilitychange', poll);
    return () => {
      window.clearInterval(timer); window.removeEventListener('focus', poll);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [interval]);
}

function RunStatus({ status, accepted = false, archived = false, execution }: { status: InspirationIdea['status']; accepted?: boolean; archived?: boolean; execution?: InspirationExecution }) {
  const { t } = useTranslation();
  const displayStatus = displayStatusOf(status, execution);
  const label = archived ? t('inspiration.filters.archived') : accepted ? t('inspiration.accepted') : t(`inspiration.status.${displayStatus}`);
  return <span className={styles.status} data-status={displayStatus} title={label}>
    <InspirationStatusIcon status={displayStatus} archived={archived} className={styles.statusIcon} />
    <span className={styles.statusText}>{label}</span>
  </span>;
}

function SessionLink({ execution }: { execution: InspirationExecution }) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  return execution.sessionHref ? <Link className={styles.link} to={execution.sessionHref}
    onClick={() => rememberInspirationReturn(execution.ideaId, execution.sessionHref!, params.get('filter') || 'saved')}>{t('inspiration.openSession')} ↗</Link> : null;
}

function DeleteIdeaButton({ idea, disabled, compact = false, onDeleted }: {
  idea: InspirationIdea; disabled?: boolean; compact?: boolean; onDeleted: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const operation = useRef({ revision: 0, id: '' });
  const blocked = ACTIVE.has(idea.status);
  const remove = async () => {
    if (pending.current || blocked || disabled) return;
    pending.current = true;
    try {
      if (!await confirm({ title: t('inspiration.deleteTitle'), message: t('inspiration.deleteHint'),
        confirmLabel: t('inspiration.delete'), danger: true })) return;
      setBusy(true);
      if (operation.current.revision !== idea.revision) operation.current = { revision: idea.revision, id: crypto.randomUUID() };
      await deleteInspiration(idea.id, { operationId: operation.current.id, expectedRevision: idea.revision });
      forgetInspirationReturn(idea.id);
      toast.success(t('inspiration.deleted'));
      await onDeleted();
    } catch (error) { toast.error(messageOf(error)); }
    finally { pending.current = false; setBusy(false); }
  };
  return <span title={t(blocked ? 'inspiration.deleteBlocked' : 'inspiration.delete')}>
    <button type="button" className={compact ? styles.deleteButton : `btn-subtle ${styles.deleteAction}`}
      aria-label={t('inspiration.delete')} disabled={disabled || busy || blocked} onClick={() => { void remove(); }}>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7" />
      </svg>{!compact && t('inspiration.delete')}
    </button>
  </span>;
}

function Attention({ ideaId, execution, onChange, compact = false }: {
  ideaId: string; execution: InspirationExecution; onChange: () => Promise<void>; compact?: boolean;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const operation = useRef({ input: '', id: '' });
  const attention = execution.attention;
  if (!attention) return null;
  const respond = async (response: ChatPromptResponse) => {
    const input = JSON.stringify([execution.runId, attention.request.requestId, response]);
    if (operation.current.input !== input) operation.current = { input, id: crypto.randomUUID() };
    try {
      await respondInspiration(ideaId, { operationId: operation.current.id, runId: execution.runId,
        requestId: attention.request.requestId, response });
      await onChange();
    } catch (error) {
      toast.error(messageOf(error)); await onChange(); throw error;
    }
  };
  const context = <>
    {attention.command && (!compact || attention.command !== attention.request.approvalDetails?.command)
      && <pre className={compact ? 'chat-prompt__cmd' : styles.command}>{attention.command}</pre>}
    {!compact && attention.cwd && <p className={styles.meta}>{t('inspiration.workspace')}: {attention.cwd}</p>}
    {attention.details && <pre className={compact ? 'chat-prompt__cmd' : styles.command}>{attention.details}</pre>}
  </>;
  return <div className={compact ? styles.compactAttention : styles.attention} data-active={attention.active} data-card-interactive>
    {!compact && context}
    {attention.active ? <ChatPromptCard key={attention.request.requestId}
      compactApproval={compact}
      draftKey={`inspiration:${execution.runId}:${attention.request.requestId}`}
      entry={{ ...attention.request, id: attention.request.requestId }} onRespond={(_entry, data) => respond(data)} />
      : <><strong>{t('inspiration.expired')}</strong><p>{attention.request.message}</p>
        {attention.request.fields.map((field) => <p key={field.id}>{field.label}</p>)}
        <p className={styles.meta}>{t('inspiration.expiredHint')}</p></>}
  </div>;
}

// Draft, search and drag state belong to the page; settled cards only need to
// render again when their own props or subscribed UI/translation context change.
const IdeaCard = memo(function IdeaCard({ idea, execution, agent, onOpen, onChange, onPress, starting = false }: {
  idea: InspirationIdea; execution?: InspirationExecution; agent?: InspirationAgent; onOpen: (id: string) => void;
  onChange: () => Promise<void>;
  onPress?: (event: ReactPointerEvent<HTMLElement>, idea: InspirationIdea) => void; starting?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const patch = async (value: InspirationPatch) => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try {
      await updateInspiration(idea.id, { operationId: crypto.randomUUID(), expectedRevision: idea.revision, patch: value });
      await onChange();
    } catch (error) { toast.error(messageOf(error)); await onChange(); }
    finally { pending.current = false; setBusy(false); }
  };
  const paperTone = paperToneOf(idea);
  const latest = execution?.runId === idea.latestExecution?.runId ? execution : idea.latestExecution;
  const rooting = Boolean(latest && idea.archivedAt === null
    && ['queued', 'starting', 'running', 'waiting_input', 'waiting_approval', 'failed', 'canceled', 'interrupted', 'unknown'].includes(idea.status));
  return <article className={`${paperStyles.surface} ${styles.card}`} data-inspiration-id={idea.id} data-paper={paperTone} data-has-media={Boolean(idea.attachments?.length) || undefined}
    data-rooting={rooting || undefined}
    data-inspiration-draggable={Boolean(onPress) && canStartInspiration(idea) && !busy && !starting || undefined}
    aria-busy={starting || undefined} onPointerDown={event => { if (!busy && !starting) onPress?.(event, idea); }} onClick={(event) => {
    if ((event.target as Element).closest('button, a, input, textarea, select, summary, [data-card-interactive]')
      || window.getSelection()?.toString()) return;
    onOpen(idea.id);
  }}>
    <div className={styles.cardActions} data-card-interactive>
      <button className={styles.iconButton} type="button" disabled={busy} aria-pressed={idea.favorite}
        aria-label={t(idea.favorite ? 'inspiration.unfavorite' : 'inspiration.favorite')}
        onClick={() => { void patch({ favorite: !idea.favorite }); }}><InspirationActionIcon name="favorite" filled={idea.favorite} /></button>
      <DeleteIdeaButton idea={idea} compact disabled={busy} onDeleted={onChange} />
    </div>
    {rooting && latest && <InspirationRunBar ideaId={idea.id} execution={latest} agent={agent} onOpen={() => onOpen(idea.id)}
      attention={<Attention ideaId={idea.id} execution={latest} onChange={onChange} compact />} />}
    <div className={styles.cardContent}>
      <InspirationContent body={idea.body} attachments={idea.attachments} compact onOpen={() => onOpen(idea.id)}
        renderText={(text, index) => ((index === 0 && idea.title) || text || !idea.attachments?.length) && <button className={styles.bodyButton} data-inspiration-body type="button"
        aria-label={`${t('inspiration.view')}：${titleOf(idea)}`} onClick={() => onOpen(idea.id)}>
        {index === 0 && idea.title && <h2>{idea.title}</h2>}<p>{text}</p>
      </button>} />
    </div>
    {!rooting && execution && <Attention ideaId={idea.id} execution={execution} onChange={onChange} />}
    {!rooting && idea.latestExecution?.resultSummary && <div className={styles.resultPreview}>
      <span className={styles.meta}>{t('inspiration.result')}</span>
      <p>{idea.latestExecution.resultSummary}</p>
    </div>}
    <div className={styles.cardFoot}>
      <RunStatus status={idea.status} accepted={idea.acceptedAt !== null} archived={idea.archivedAt !== null} execution={execution} />
      <div className={styles.cardTools} data-card-interactive>
        {idea.latestExecution && <SessionLink execution={idea.latestExecution} />}
        {idea.archivedAt !== null && <button className="btn-subtle" disabled={busy} onClick={() => { void patch({ archived: false }); }}>{t('inspiration.restore')}</button>}
        {idea.archivedAt === null && idea.status === 'completed' && <button className="btn-subtle" disabled={busy} onClick={() => { void patch({ archived: true }); }}>{t('inspiration.archive')}</button>}
      </div>
      <time className={styles.cardDate} dateTime={new Date(idea.updatedAt).toISOString()}>
        {new Date(idea.updatedAt).toLocaleDateString(i18n?.resolvedLanguage || i18n?.language, { year: 'numeric', month: 'short', day: 'numeric' })}
      </time>
    </div>
  </article>;
});

export function IdeaDetail({ id, open = true, onClose, onOpenChangeComplete, onChange }: {
  id: string; open?: boolean; onClose: () => void; onOpenChangeComplete?: (open: boolean) => void;
  onChange: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const detail = usePageCache(`inspiration-detail:${id}`, async () => {
    const [value, history] = await Promise.all([getInspiration(id), getInspirationExecutions(id)]);
    return { idea: value.idea, history };
  });
  const roster = usePageCache('inspiration-agents', getInspirationAgents);
  const [edit, setEdit] = useState<{ body: string; title: string; revision: number; attachments: InspirationAttachment[] } | null>(null);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [agent, setAgent] = useState('');
  const [instruction, setInstruction] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const operation = useRef({ input: '', id: '' });
  const [more, setMore] = useState<InspirationExecution[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadedMore, setLoadedMore] = useState(false);
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(() => new Set());
  const idea = detail.data?.idea;
  const dirty = Boolean(edit && (edit.body !== idea?.body || edit.title !== (idea?.title || '')
    || JSON.stringify(edit.attachments) !== JSON.stringify(idea?.attachments || []))) || instruction.trim().length > 0;
  useNavigationGuard({ dirty, busy: busy || mediaBusy, onDiscard: onClose });
  useVisibleRefresh(detail.refresh);
  useVisibleRefresh(roster.refresh, 15000);
  const refresh = async () => { await Promise.all([detail.refresh(), onChange()]); };
  const act = async (input: unknown, action: (operationId: string) => Promise<unknown>, done?: () => void) => {
    if (pending.current) return;
    const key = JSON.stringify(input);
    if (operation.current.input !== key) operation.current = { input: key, id: crypto.randomUUID() };
    pending.current = true; setBusy(true);
    try { await action(operation.current.id); operation.current = { input: '', id: '' }; done?.(); await refresh(); }
    catch (error) { toast.error(messageOf(error)); await refresh(); }
    finally { pending.current = false; setBusy(false); }
  };
  const close = async () => {
    if (busy || mediaBusy) return;
    if (dirty && !await confirm({ title: t('inspiration.discardTitle'), message: t('inspiration.discardHint'), confirmLabel: t('inspiration.discard') })) return;
    onClose();
  };
  const candidates = roster.data?.agents || [];
  const defaultAgent = defaultInspirationAgent(candidates, idea);
  const chosen = candidates.find((value) => `${value.backendId}/${value.id}` === agent) || (!agent ? defaultAgent : undefined);
  const externalAgent = chosen?.backendId === 'openclaw' || chosen?.backendId === 'hermes';
  const executions = [...(detail.data?.history.executions || []), ...more]
    .filter((value, index, values) => values.findIndex((item) => item.id === value.id) === index);
  const nextCursor = loadedMore ? cursor : detail.data?.history.nextCursor;
  const latest = executions[0];
  const displayStatus = idea ? displayStatusOf(idea.status, latest) : 'saved';
  const agentName = (execution: InspirationExecution) => candidates.find((value) => value.id === execution.agentId
    && value.backendId === execution.backendId)?.name || execution.agentId;
  const start = () => {
    if (!chosen?.capabilities.execute || !idea || ACTIVE.has(idea.status)) return;
    const input = { expectedRevision: idea.revision, agentId: chosen.id, backendId: chosen.backendId,
      instruction, workspace: externalAgent ? null : workspace.trim() || (chosen.id === idea.latestExecution?.agentId
        && chosen.backendId === idea.latestExecution?.backendId ? idea.latestExecution.workspace : null) };
    void act(['start', input], (operationId) => startInspiration(id, { ...input, operationId }),
      () => { setInstruction(''); setMore([]); setLoadedMore(false); });
  };
  return <Modal open={open} onOpenChangeComplete={onOpenChangeComplete} className={styles.detailModal}
    title={idea ? <span className={styles.detailTitle} data-status={displayStatus}>
      <InspirationStatusIcon status={displayStatus} archived={idea.archivedAt !== null} className={styles.detailGrowth} />
      <span className={styles.detailTitleText}>
        <span className={styles.detailEyebrow}>{t(idea.archivedAt !== null ? 'inspiration.filters.archived' : idea.acceptedAt ? 'inspiration.accepted' : `inspiration.status.${displayStatus}`)}
        </span>
        <span className={styles.detailHeading}>{titleOf(idea)}</span>
      </span>
    </span> : t('inspiration.title')}
    onClose={() => { void close(); }} dismissible={!busy && !mediaBusy}
    footer={idea && <div className={styles.detailFooter}>
      <div className={styles.detailTools}>
        <button type="button" className={styles.iconButton} disabled={busy || Boolean(edit)} aria-pressed={idea.favorite}
          aria-label={t(idea.favorite ? 'inspiration.unfavorite' : 'inspiration.favorite')}
          title={t(idea.favorite ? 'inspiration.unfavorite' : 'inspiration.favorite')}
          onClick={() => { void act(['favorite', idea.revision], (operationId) => updateInspiration(id,
            { operationId, expectedRevision: idea.revision, patch: { favorite: !idea.favorite } })); }}>
          <InspirationActionIcon name="favorite" filled={idea.favorite} />
        </button>
        {idea.archivedAt === null && idea.status === 'completed' && <button type="button" className={styles.iconButton}
          disabled={busy || Boolean(edit)} aria-label={t('inspiration.archive')} title={t('inspiration.archive')}
          onClick={() => { void act(['archive', idea.revision], (operationId) => updateInspiration(id,
            { operationId, expectedRevision: idea.revision, patch: { archived: true } })); }}><InspirationStatusIcon status="completed" archived /></button>}
        <DeleteIdeaButton idea={idea} compact disabled={busy || Boolean(edit)} onDeleted={async () => { onClose(); await onChange(); }} />
      </div>
      <div className={styles.detailPrimary}>
        {edit ? <>
          <button className="btn-subtle" disabled={busy || mediaBusy} onClick={() => setEdit(null)}>{t('common.cancel')}</button>
          <button className="btn-primary" disabled={busy || mediaBusy || (!edit.body.trim() && !edit.attachments.length) || bytes(edit.body) > 16 * 1024 || bytes(edit.title) > 512 || edit.revision !== idea.revision}
            onClick={() => { void act(['edit', edit], (operationId) => updateInspiration(id, { operationId, expectedRevision: edit.revision,
              patch: { body: edit.body, title: edit.title.trim() || null, attachments: edit.attachments } }), () => setEdit(null)); }}>{t('inspiration.saveEdit')}</button>
        </> : ACTIVE.has(idea.status) && idea.latestExecution ? <>
          {idea.status === 'unknown' && <button className="btn-secondary" disabled={busy}
            onClick={() => { void act(['refresh', idea.latestExecution?.runId], roster.refresh); }}>{t('inspiration.checkStatus')}</button>}
          <button className="btn-subtle" disabled={busy} onClick={() => { void act(['cancel', idea.latestExecution?.runId],
            (operationId) => cancelInspiration(id, { operationId, runId: idea.latestExecution!.runId })); }}>{t('inspiration.stop')}</button></>
          : idea.archivedAt !== null ? <button className="btn-secondary" disabled={busy} onClick={() => { void act(['restore', idea.revision],
            (operationId) => updateInspiration(id, { operationId, expectedRevision: idea.revision, patch: { archived: false } })); }}>{t('inspiration.restore')}</button>
            : <button className="btn-primary" disabled={busy || ACTIVE.has(idea.status) || !chosen?.capabilities.execute || bytes(instruction) > 16 * 1024} onClick={start}>
              {busy ? t('inspiration.starting') : t(idea.latestExecution ? 'inspiration.continue' : 'inspiration.start')}
              <InspirationActionIcon name="arrow" />
            </button>}
      </div>
    </div>}>
    {(detail.error || roster.error) && <p className={styles.error} role="alert">{detail.error || roster.error}</p>}
    {!idea ? <p role="status">{t('common.loading')}</p> : <div className={styles.detail}>
      <section className={styles.ideaNote}>
        <div className={styles.sectionHeading}>
          <h3>{t('inspiration.original')}</h3>
          {!edit && <button className={styles.textAction} disabled={busy} onClick={() => setEdit({ body: idea.body, title: idea.title || '', revision: idea.revision, attachments: idea.attachments || [] })}>
            <InspirationActionIcon name="edit" />{t('inspiration.edit')}</button>}
        </div>
        {edit ? <div className={styles.editFields}>
        <Field label={t('inspiration.optionalTitle')}><TextInput value={edit.title} disabled={busy} maxLength={160} onChange={(event) => setEdit({ ...edit, title: event.target.value })} /></Field>
        <InspirationMediaEditor body={edit.body} attachments={edit.attachments} disabled={busy} onBusyChange={setMediaBusy}
          onChange={update => setEdit(previous => previous ? { ...previous, ...update(previous) } : null)}
          inputProps={{ rows: 7, 'aria-label': t('inspiration.original') }} />
        {edit.revision !== idea.revision && <p role="alert" className={styles.error}>{t('inspiration.editConflict')}</p>}
        {edit.revision !== idea.revision && <button className="btn-subtle" disabled={busy} onClick={() => setEdit({ ...edit, revision: idea.revision })}>{t('inspiration.keepMyEdit')}</button>}
        </div> : <><InspirationContent body={idea.body} attachments={idea.attachments}
          renderText={text => text && <p className={styles.original}>{text}</p>} />
          <p className={styles.noteDate}>{t('inspiration.savedOn', { date: new Date(idea.createdAt).toLocaleDateString() })}</p></>}
      </section>
      {!edit && latest && <section className={styles.currentRun} data-completed={idea.status === 'completed'}>
        <div className={styles.sectionHeading}>
          <h3>{t(idea.status === 'completed' ? 'inspiration.result' : 'inspiration.currentRun')}</h3>
          <SessionLink execution={latest} />
        </div>
        {latest.attention ? <Attention ideaId={id} execution={latest} onChange={refresh} />
          : latest.resultSummary ? <div className={styles.markdown} dangerouslySetInnerHTML={{ __html: toSanitizedMarkdownHtml(latest.resultSummary) }} />
            : <p className={styles.progressHint}>{t(`inspiration.progressHint.${idea.status}`)}</p>}
        {(latest.status === 'canceled' || latest.errorCode) && <p className={styles.error}>{t('inspiration.runError')} · {latest.status === 'canceled'
          ? t('inspiration.growth.errors.INSPIRATION_CANCELED') : latest.errorCode}</p>}
        <InspirationActivity key={latest.runId} ideaId={id} execution={latest} />
        {idea.status === 'completed' && <div className={styles.resultFoot}>
          <span className={styles.meta}>{agentName(latest)} · {new Date(latest.createdAt).toLocaleDateString()}</span>
          <button className={styles.acceptAction} disabled={busy} aria-pressed={Boolean(idea.acceptedAt)}
            onClick={() => { void act(['accept', idea.revision], (operationId) => updateInspiration(id,
              { operationId, expectedRevision: idea.revision, patch: { accepted: !idea.acceptedAt } })); }}>
            <InspirationActionIcon name="check" />{t(idea.acceptedAt ? 'inspiration.undoAccept' : 'inspiration.accept')}
          </button>
        </div>}
      </section>}
      {!edit && !ACTIVE.has(idea.status) && idea.archivedAt === null && <section className={styles.startBox}>
        <div className={styles.startHead}><h3>{t('inspiration.nextStep')}</h3>
        <Field label={t('inspiration.agent')}>
          <Select value={chosen ? `${chosen.backendId}/${chosen.id}` : ''} disabled={busy} onChange={setAgent}>
            {!chosen && <Option value="" disabled>{t('inspiration.noAgent')}</Option>}
            {candidates.map((value) => <Option key={`${value.backendId}/${value.id}`} value={`${value.backendId}/${value.id}`} disabled={!value.capabilities.execute}>
              {value.name} · {value.backendName}{value.capabilities.execute ? '' : ` · ${t(value.capabilities.reason === 'backend-unavailable' ? 'inspiration.unavailable' : 'inspiration.unsupported')}`}
            </Option>)}
          </Select>
        </Field>
        </div>
        <Field label={t('inspiration.instruction')}><TextArea value={instruction} disabled={busy} rows={3}
          placeholder={t('inspiration.instructionPlaceholder')} onChange={(event) => setInstruction(event.target.value)} /></Field>
        {externalAgent ? <p className={styles.meta}>{t('inspiration.externalWorkspaceHint')}</p> : <details className={styles.workspaceDisclosure}><summary><InspirationActionIcon name="chevron" />{t('inspiration.workspace')}</summary>
          <Field label={t('inspiration.workspace')} hint={t('inspiration.workspaceHint')}><TextInput value={workspace} disabled={busy} placeholder={idea.latestExecution?.workspace || t('inspiration.defaultWorkspace')}
            onChange={(event) => setWorkspace(event.target.value)} /></Field>
        </details>}
        <p className={styles.meta}>{t('inspiration.sessionHint')}</p>
      </section>}
      {!edit && executions.length > 0 && <details className={styles.history}>
        <summary className={styles.historyHeading}><span>{t('inspiration.history')}<span className={styles.historyCount}>{executions.length}{nextCursor ? '+' : ''}</span></span>
          <InspirationActionIcon name="chevron" /></summary>
        {executions.map((execution) => <details key={execution.id} className={styles.run} onToggle={(event) => {
          const open = event.currentTarget.open;
          setExpandedRuns(previous => { const next = new Set(previous); if (open) next.add(execution.id); else next.delete(execution.id); return next; });
        }}>
          <summary className={styles.runSummary}>
            <RunStatus status={execution.status} execution={execution} />
            <span className={styles.meta}>{new Date(execution.createdAt).toLocaleString()} · {agentName(execution)}</span>
            <InspirationActionIcon name="chevron" />
          </summary>
          <div className={styles.runBody}>
            {execution.resultSummary && <div className={styles.markdown} dangerouslySetInnerHTML={{ __html: toSanitizedMarkdownHtml(execution.resultSummary) }} />}
            {execution.errorCode && <p className={styles.error}>{t('inspiration.runError')} · {execution.errorCode}</p>}
            <SessionLink execution={execution} />
            {execution.runId !== latest?.runId && expandedRuns.has(execution.id)
              && <InspirationActivity key={execution.runId} ideaId={id} execution={execution} />}
          </div>
        </details>)}
        {nextCursor && <button className="btn-subtle" disabled={busy} onClick={() => {
          void act(['history', nextCursor], async () => { const page = await getInspirationExecutions(id, nextCursor); setMore((previous) => [...previous, ...page.executions]); setCursor(page.nextCursor); setLoadedMore(true); });
        }}>{t('inspiration.moreHistory')}</button>}
      </details>}
    </div>}
  </Modal>;
}

export function AgentInspirationPanel({ backendId, agentId }: { backendId: string; agentId: string }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<InspirationFilter>('all');
  const [detailId, setDetailId] = useState<string | null>(null);
  const viewKey = JSON.stringify([backendId, agentId, filter]);
  const requestedPages = useRef({ key: viewKey, count: 1 });
  if (requestedPages.current.key !== viewKey) requestedPages.current = { key: viewKey, count: 1 };
  const page = usePageCache(`agent-inspirations:${viewKey}`, async () => ({
    ...await readInspirationWallPages('', filter, requestedPages.current.count, { backendId, agentId }), viewKey,
  }));
  if (page.data?.viewKey === viewKey) requestedPages.current.count = Math.max(requestedPages.current.count, page.data.pageCount);
  const roster = usePageCache('inspiration-agents', getInspirationAgents);
  const [loadingMore, setLoadingMore] = useState(false);
  const moreRequest = useRef<Promise<void> | null>(null);
  const refresh = useCallback(async () => {
    await moreRequest.current;
    await page.refresh();
  }, [page.refresh]);
  useVisibleRefresh(refresh);
  const loadMore = async () => {
    if (moreRequest.current || !page.data?.hasMore) return;
    requestedPages.current.count = page.data.pageCount + 1;
    setLoadingMore(true);
    const request = page.refresh();
    moreRequest.current = request;
    try { await request; }
    finally {
      if (moreRequest.current === request) { moreRequest.current = null; setLoadingMore(false); }
    }
  };
  useEffect(() => { moreRequest.current = null; setLoadingMore(false); }, [viewKey]);
  return <section className={styles.agentPanel} aria-label={t('agents.tabInspiration')}>
    <div className={styles.row}>
      <FilterTabs value={filter} onChange={value => setFilter(value as InspirationFilter)}
        ariaLabel={t('inspiration.filter')} items={(['all', 'archived'] as const)
          .map(value => ({ value, label: t(`inspiration.filters.${value}`) }))} scrollable />
      <button type="button" className="btn-subtle" onClick={() => { void refresh(); }}>{t('common.refresh')}</button>
    </div>
    {page.loading && <p className={styles.meta} role="status">{t('common.loading')}</p>}
    {page.error && <p className={styles.error} role="alert">{page.error}</p>}
    {!page.loading && !page.error && page.data?.items.length === 0 && <p className={styles.meta}>
      {t(filter === 'archived' ? 'agents.inspirationArchivedEmpty' : 'agents.inspirationEmpty')}
    </p>}
    <div className={styles.grid}>{page.data?.items.map(idea => <IdeaCard key={idea.id} idea={idea}
      agent={roster.data?.agents.find(agent => agent.id === idea.latestExecution?.agentId && agent.backendId === idea.latestExecution?.backendId)}
      onOpen={setDetailId} onChange={refresh} />)}</div>
    {page.data?.hasMore && <div className={styles.loadMore}>
      <button type="button" className="btn-subtle" disabled={loadingMore} onClick={() => { void loadMore(); }}>
        {t(loadingMore ? 'common.loading' : 'dashboard.loadMore')}
      </button>
    </div>}
    {detailId && <IdeaDetail key={detailId} id={detailId} onClose={() => setDetailId(null)} onChange={refresh} />}
  </section>;
}

export default function InspirationPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const { draft, draftRef, draftStored, updateDraft, clearSavedDraft } = useInspirationDraft();
  const [mediaBusy, setMediaBusy] = useState(false);
  const mediaBusyRef = useRef(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const archiveBusyRef = useRef(false);
  const changeArchiveBusy = (busy: boolean) => { archiveBusyRef.current = busy; setArchiveBusy(busy); };
  const changeMediaBusy = (busy: boolean) => { mediaBusyRef.current = busy; setMediaBusy(busy); };
  const [saving, setSaving] = useState(false);
  const [printJob, setPrintJob] = useState<InspirationIdea | null>(null);
  const [printing, setPrinting] = useState(false);
  const [typewriterExpanded, setTypewriterExpanded] = useState(true);
  const pageElement = useRef<HTMLDivElement>(null);
  const paperElement = useRef<HTMLDivElement>(null);
  const toolbarElement = useRef<HTMLDivElement>(null);
  const toolbarAnchor = useRef<HTMLDivElement>(null);
  const [growthNoticeTarget, setGrowthNoticeTarget] = useState<HTMLDivElement | null>(null);
  const moreElement = useRef<HTMLDivElement>(null);
  const paperFlight = useRef<InspirationPaperFlight | null>(null);
  const savingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [startingIdeas, setStartingIdeas] = useState<Set<string>>(() => new Set());
  const pendingStarts = useRef(new Set<string>());
  const startOperations = useRef(new Map<string, { input: string; operationId: string }>());
  const dragCancel = useRef<(() => void) | null>(null);
  const agentDock = useRef<InspirationAgentDockHandle>(null);
  const requestedFilter = params.get('filter') as InspirationFilter;
  const filter = FILTERS.includes(requestedFilter) ? requestedFilter : 'saved';
  const setFilter = (value: InspirationFilter) => setParams((previous) => {
    const next = new URLSearchParams(previous); next.set('filter', value); next.delete('id'); return next;
  });
  const openIdea = useCallback((id: string) => setParams((previous) => {
    const next = new URLSearchParams(previous); next.set('id', id); return next;
  }), [setParams]);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => { const timer = window.setTimeout(() => setQuery(search), 250); return () => window.clearTimeout(timer); }, [search]);
  const viewKey = JSON.stringify([query, filter]);
  const detailId = params.get('id');
  useEffect(() => () => { dragCancel.current?.(); dragCancel.current = null; }, [viewKey, detailId]);
  const visibleView = useRef(viewKey); visibleView.current = viewKey;
  const requestedPages = useRef({ key: viewKey, count: 1 });
  if (requestedPages.current.key !== viewKey) requestedPages.current = { key: viewKey, count: 1 };
  const [loadingMore, setLoadingMore] = useState(false);
  const moreRequest = useRef<Promise<void> | null>(null);
  const growthRequest = useRef(0);
  const growthCards = useRef<{ key: string; previous: InspirationIdea[]; leaving: Array<{ idea: InspirationIdea; until: number; index: number }> }>
    ({ key: '', previous: [], leaving: [] });
  const fetchPage = useCallback(async () => {
    const request = visibleView.current === viewKey ? ++growthRequest.current : 0;
    const page = await readInspirationWallPages(query, filter, requestedPages.current.key === viewKey ? requestedPages.current.count : 1);
    const executions = await Promise.all(page.items.filter((idea) => idea.latestExecution
      && ['waiting_input', 'waiting_approval', 'interrupted', 'failed', 'canceled'].includes(idea.status)).map(async (idea) => {
      const history = await getInspirationExecutions(idea.id, null, 1);
      return [idea.id, history.executions[0]] as const;
    }));
    // Retain a card only for a confirmed forward growth transition. Deletion,
    // search and pagination disappear normally; service state is immediate.
    let items = page.items;
    let growthDeadline: number | null = null;
    if (request && request === growthRequest.current && visibleView.current === viewKey) {
      if (growthCards.current.key !== viewKey) growthCards.current = { key: viewKey, previous: [], leaving: [] };
      const frame = growthCards.current;
      const stageOf = (idea: InspirationIdea) => inspirationGrowthStage(idea.status, idea.archivedAt !== null);
      const missing = ['saved', 'active', 'result'].includes(filter) ? frame.previous.filter((old) => !items.some((item) => item.id === old.id)
        && stageOf(old) >= 0 && stageOf(old) < 3) : [];
      const [changed, retained] = await Promise.all([Promise.all(missing.map(async (old) => {
        try {
          const { idea } = await getInspiration(old.id);
          return stageOf(idea) > stageOf(old)
            ? { idea, index: frame.previous.findIndex((item) => item.id === old.id), until: Date.now() + 1500 } : null;
        } catch { return null; }
      })), Promise.all(frame.leaving.filter((value) => value.until > Date.now()
        && !items.some((item) => item.id === value.idea.id)).map(async (leaving) => {
        try {
          const { idea } = await getInspiration(leaving.idea.id);
          return stageOf(idea) === stageOf(leaving.idea)
            ? { ...leaving, idea } : null;
        } catch { return null; }
      }))]);
      if (request === growthRequest.current && visibleView.current === viewKey && growthCards.current === frame) {
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        frame.leaving = reduced ? [] : [...retained, ...changed].filter((value) => value !== null);
        frame.previous = page.items;
        items = [...page.items];
        for (const leaving of frame.leaving) items.splice(Math.min(leaving.index, items.length), 0, leaving.idea);
        if (frame.leaving.length) growthDeadline = Math.min(...frame.leaving.map((value) => value.until));
      }
    }
    return { ...page, viewKey, items, total: page.total + items.length - page.items.length, growthDeadline, executions: Object.fromEntries(executions) };
  }, [query, filter, viewKey]);
  const page = usePageCache(`inspirations:${viewKey}`, fetchPage);
  const roster = usePageCache('inspiration-agents', getInspirationAgents);
  useVisibleRefresh(roster.refresh, 15000);
  if (page.data?.viewKey === viewKey) requestedPages.current.count = Math.max(requestedPages.current.count, page.data.pageCount);
  const total = usePageCache('inspiration-total', async () => {
    // "all" excludes the final (archived) stage; together these cover every
    // recorded idea, independently of the wall's filter, query and pagination.
    const [current, archived] = await Promise.all([
      listInspirations({ query: '', filter: 'all', cursor: null, limit: 1 }),
      listInspirations({ query: '', filter: 'archived', cursor: null, limit: 1 }),
    ]);
    return current.total + archived.total;
  });
  const refresh = useCallback(async () => {
    await moreRequest.current;
    await Promise.all([page.refresh(), total.refresh()]);
  }, [page.refresh, total.refresh]);
  const loadMore = useCallback(async () => {
    if (moreRequest.current || !page.data?.hasMore || !page.data.nextCursor) return;
    requestedPages.current.count = Math.max(requestedPages.current.count, page.data.pageCount + 1);
    setLoadingMore(true);
    const request = page.refresh();
    moreRequest.current = request;
    try { await request; }
    finally {
      if (moreRequest.current === request) { moreRequest.current = null; setLoadingMore(false); }
    }
  }, [page.data, page.refresh]);
  useEffect(() => { moreRequest.current = null; setLoadingMore(false); }, [viewKey]);
  useEffect(() => {
    const sentinel = moreElement.current;
    if (!sentinel || page.loading || page.error || loadingMore || !page.data?.hasMore) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); void loadMore(); }
    }, { root: pageElement.current?.closest('main') ?? null, rootMargin: '0px 0px 320px 0px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [page.loading, page.error, page.data?.hasMore, loadingMore, loadMore]);
  useEffect(() => {
    const toolbar = toolbarElement.current;
    const anchor = toolbarAnchor.current;
    const element = pageElement.current;
    if (toolbar && anchor && element) return attachInspirationScrollStages(element, toolbar, anchor, setTypewriterExpanded);
  }, []);
  useEffect(() => {
    if (!page.data?.growthDeadline) return;
    const timer = window.setTimeout(() => { void page.refresh(); }, Math.max(0, page.data.growthDeadline - Date.now()) + 40);
    return () => window.clearTimeout(timer);
  }, [page.data?.growthDeadline, page.refresh]);
  useVisibleRefresh(refresh);
  useRegisterPageRefresh('/inspirations', refresh);
  useRegisterPageLoading('/inspirations', page.loading);
  useNavigationGuard({ dirty: Boolean((draft.body || draft.attachments?.length) && !draftStored), busy: saving || mediaBusy || archiveBusy, onDiscard: () => {} });
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  const handToAgent = useCallback(async (idea: InspirationIdea, target: InspirationDropTarget) => {
    if (pendingStarts.current.has(idea.id) || !canStartInspiration(idea)) return;
    pendingStarts.current.add(idea.id); setStartingIdeas(new Set(pendingStarts.current));
    try {
      const { agents } = await getInspirationAgents();
      const agent = target.agent ? agents.find(value => value.id === target.agent!.id
        && value.backendId === target.agent!.backendId && value.capabilities.execute) : defaultInspirationAgent(agents, idea);
      if (!agent) throw new Error(t('inspiration.noAgent'));
      const fields = inspirationStartFields(idea, agent);
      const input = JSON.stringify(fields);
      let operation = startOperations.current.get(idea.id);
      if (operation?.input !== input) {
        operation = { input, operationId: crypto.randomUUID() }; startOperations.current.set(idea.id, operation);
      }
      await startInspiration(idea.id, { ...fields, operationId: operation.operationId });
      startOperations.current.delete(idea.id);
      await refreshRef.current();
    } catch (error) { toast.error(messageOf(error)); await refreshRef.current(); }
    finally { pendingStarts.current.delete(idea.id); setStartingIdeas(new Set(pendingStarts.current)); }
  }, [t, toast]);
  const pressIdea = useCallback((event: ReactPointerEvent<HTMLElement>, idea: InspirationIdea) => {
    if (!event.isPrimary || event.button !== 0 || !canStartInspiration(idea) || pendingStarts.current.has(idea.id)
      || printing || saving || (event.target as Element).closest('[data-card-interactive], a, input, textarea, select')) return;
    dragCancel.current?.();
    agentDock.current?.prepare();
    dragCancel.current = beginInspirationCardDrag(event.currentTarget, event, {
      onActive: setDragging,
      scrollContainer: () => agentDock.current?.scrollElement() ?? null,
      targets: () => {
        const targets: InspirationDropTarget[] = [];
        const tab = pageElement.current?.querySelector('[data-inspiration-default-drop]')?.closest('button');
        if (tab) targets.push({ element: tab, agent: null });
        targets.push(...(agentDock.current?.targets() ?? []));
        return targets;
      },
      onDrop: target => { void handToAgent(idea, target); },
    });
  }, [printing, saving, handToAgent]);
  const onSavedView = filter === 'saved' && !query;
  const wallItems = page.data?.items ?? [];
  const addPrintedIdea = printJob && onSavedView && !wallItems.some(idea => idea.id === printJob.id);
  const visibleIdeas = addPrintedIdea ? [printJob, ...wallItems] : wallItems;
  const wallTotal = (page.data?.total ?? 0) + (addPrintedIdea ? 1 : 0);

  useLayoutEffect(() => {
    if (!printJob) return;
    const flight = paperFlight.current;
    paperFlight.current = null;
    if (!onSavedView) {
      flight?.cancel(); setPrinting(false); setPrintJob(null);
      return;
    }
    // The POST already confirmed this record. Cache it before refreshing so a
    // slow/failed GET cannot make the arriving card disappear after landing.
    if (!wallItems.some(idea => idea.id === printJob.id)) {
      page.replace({ ...(page.data ?? { total: 0, hasMore: false, nextCursor: null, pageCount: 1, viewKey, executions: {}, growthDeadline: null }),
        items: [printJob, ...wallItems], total: wallTotal });
    }
    const destination = pageElement.current?.querySelector<HTMLElement>(`[data-inspiration-id="${printJob.id}"]`) ?? null;
    let active = true;
    const animation = flight?.play(destination) ?? Promise.resolve();
    paperElement.current?.querySelector('textarea')?.focus({ preventScroll: true });
    void animation.then(async () => {
      if (!active) return;
      setPrinting(false);
      await refreshRef.current();
      if (active) setPrintJob(null);
    });
    return () => { active = false; flight?.cancel(); };
    // Fetches may update the card while it travels; only a new save or view
    // change starts/interrupts the transfer.
  }, [printJob, viewKey]);

  const save = async () => {
    if (savingRef.current || printing || mediaBusyRef.current || archiveBusyRef.current || (!draft.body.trim() && !draft.attachments?.length) || bytes(draft.body) > 16 * 1024) return;
    savingRef.current = true; setSaving(true);
    const submitted = draftRef.current;
    try {
      const { idea } = await createInspiration(submitted);
      paperFlight.current = draftRef.current.operationId === submitted.operationId
        ? prepareInspirationPaperFlight(paperElement.current, pageElement.current) : null;
      setPrinting(Boolean(paperFlight.current));
      setPrintJob(idea);
      clearSavedDraft(submitted, pickNextPaperTone(paperToneOf(idea)));
      // The write is complete: release the navigation guard before switching tabs.
      setSaving(false);
      setFilter('saved'); setSearch(''); setQuery('');
      void total.refresh();
    } catch (error) { toast.error(messageOf(error)); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const draftError = bytes(draft.body) > 16 * 1024 ? t('inspiration.tooLong') : !draftStored ? t('inspiration.draftMemory') : '';
  return <div className={`page ${styles.page}`} ref={pageElement}>
    <div className={styles.titleLayer}><PageHead title={t('inspiration.title')} /></div>
    <div className={styles.workbench} data-inspiration-workbench>
      <InspirationTypewriter active={typewriterExpanded} saving={saving} paperRef={paperElement} paperTone={draft.paperTone ?? 0} ideaCount={total.data ?? null}
        accessory={<InspirationArchiveControls disabled={saving || printing || mediaBusy} ideaCount={total.data ?? null} getDraft={() => draftRef.current}
          openRequest={params.get('storage') === 'export' ? params.get('request') : null}
          onOpenRequestHandled={() => setParams(previous => { const next = new URLSearchParams(previous); next.delete('storage'); next.delete('request'); return next; }, { replace: true })}
          onBusyChange={changeArchiveBusy} />}>
        <InspirationCapture disabled={saving || printing || archiveBusy}>
          <InspirationMediaEditor capture body={draft.body} attachments={draft.attachments || []} disabled={saving || printing || archiveBusy} onBusyChange={changeMediaBusy}
            onChange={update => { const next = update({ body: draftRef.current.body, attachments: draftRef.current.attachments || [] }); updateDraft(next.body, next.attachments); }}
            inputProps={{ 'aria-label': t('inspiration.capture'), 'aria-keyshortcuts': 'Enter',
              'aria-describedby': draftError ? 'inspiration-capture-error' : undefined,
              rows: 1, placeholder: t('inspiration.placeholder'), onKeyDown: event => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              event.preventDefault();
              if (!event.repeat) void save();
            } }} />
        </InspirationCapture>
      </InspirationTypewriter>
      {draftError && <p id="inspiration-capture-error" role="alert" className={`${styles.captureError} ${styles.error}`}>{draftError}</p>}
    </div>
    <section className={styles.wall} aria-label={t('inspiration.wallTitle')}>
    <div className={styles.toolbarAnchor} ref={toolbarAnchor} aria-hidden="true" />
    <div className={styles.toolbar} ref={toolbarElement} data-inspiration-toolbar><div className={styles.filterGroup}><FilterTabs className={`${pillStyles.tabs} ${styles.filterTabs}`} value={filter} onChange={(value) => setFilter(value as InspirationFilter)}
      items={FILTERS.map((value) => ({ value, label: t(`inspiration.filters.${value}`),
        icon: value === 'favorite' ? <InspirationActionIcon className={styles.filterIcon} name="favorite" />
          : <span data-inspiration-default-drop={value === 'active' || undefined}><InspirationStatusIcon className={styles.filterIcon}
          status={value === 'saved' ? 'saved' : value === 'active' ? 'running' : 'completed'} archived={value === 'archived'} /></span> }))} ariaLabel={t('inspiration.filter')} scrollable showTooltips />
      <div ref={setGrowthNoticeTarget} className={styles.growthNoticeSlot} data-inspiration-notices-slot /></div>
      <div className={styles.wallControls}>
        <SearchCapsule className={styles.search} value={search} onChange={setSearch} placeholder={t('inspiration.search')} collapsible />
        <InspirationAutoGrowth noticeTarget={growthNoticeTarget} onOpen={openIdea} onChange={refresh} />
      </div></div>
    {page.loading && <p role="status" className={styles.meta}>{t('common.loading')}</p>}
    {page.data && visibleIdeas.length === 0 && <div className={styles.empty}><span className={styles.emptyMark} aria-hidden="true"><InspirationStatusIcon status="saved" /></span>
      <h2>{t(query || filter !== 'saved' ? 'inspiration.noMatches' : 'inspiration.empty')}</h2><p>{t(query || filter !== 'saved' ? 'inspiration.noMatchesHint' : 'inspiration.emptyHint')}</p></div>}
    <div className={styles.grid}>{visibleIdeas.map((idea) => <IdeaCard key={idea.id} idea={idea} execution={page.data?.executions[idea.id]}
      agent={roster.data?.agents.find(agent => agent.id === idea.latestExecution?.agentId && agent.backendId === idea.latestExecution?.backendId)}
      onPress={pressIdea} starting={startingIdeas.has(idea.id)}
      onOpen={openIdea} onChange={refresh} />)}</div>
    <div className={styles.loadMore} ref={moreElement} data-inspiration-load-more>
      {loadingMore && <span role="status" className={styles.meta}>{t('common.loading')}</span>}
      {page.error && <div role="alert" className={styles.error}>{page.error}
        <button type="button" className="btn-subtle" onClick={() => { void refresh(); }}>{t('common.refresh')}</button></div>}
    </div>
    </section>
    <InspirationAgentChatter paused={Boolean(params.get('id')) || Boolean(draft.body.trim()) || Boolean(draft.attachments?.length) || mediaBusy || archiveBusy || saving || printing || dragging} />
    <InspirationAgentDock ref={agentDock} active={dragging} />
    {params.get('id') && <IdeaDetail key={params.get('id')!} id={params.get('id')!} onClose={() => setParams((previous) => { const next = new URLSearchParams(previous); next.delete('id'); return next; })} onChange={refresh} />}
  </div>;
}
