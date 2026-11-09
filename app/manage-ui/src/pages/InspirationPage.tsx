import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHead } from '../components/PageHead';
import FilterTabs from '../components/FilterTabs';
import SearchCapsule from '../components/SearchCapsule';
import AgentAvatarView from '../components/AgentAvatar';
import { useConfirm, useToast } from '../components/ui';
import { usePageCache } from '../lib/usePageCache';
import { useRegisterPageLoading, useRegisterPageRefresh } from '../lib/page-refresh';
import { useNavigationGuard } from '../lib/navigation-guard';
import { rememberInspirationReturn, forgetInspirationReturn } from '../lib/inspiration-navigation';
import { createInspiration, listInspirations, getInspiration, getInspirationAgents,
  getInspirationExecutions, updateInspiration, startInspiration, deleteInspiration } from '../api/client';
import type { InspirationIdea, InspirationExecution, InspirationFilter, InspirationPatch, InspirationAgent } from '../types';
import InspirationStatusIcon, { inspirationGrowthStage } from './InspirationStatusIcon';
import InspirationActionIcon from './InspirationActionIcon';
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
import { readAllAgentInspirationPages, readInspirationWallPages } from './inspiration-wall-pages';
import { beginInspirationCardDrag, type InspirationDropTarget } from './inspiration-card-drag';
import { attachInspirationScrollStages } from './inspiration-scroll-stages';
import { canStartInspiration, defaultInspirationAgent, inspirationStartFields } from './inspiration-execution';
import { inspirationNoteContent } from './inspiration-note-text';
import { ACTIVE, IdeaDetail, displayStatusOf, messageOf, paperToneOf } from './InspirationThread';
import paperStyles from './InspirationPaper.module.css';
import pillStyles from '../components/PillTabs.module.css';
import styles from './InspirationPage.module.css';

export { IdeaDetail };
const FILTERS: InspirationFilter[] = ['saved', 'active', 'result', 'archived', 'favorite'];
const titleOf = (idea: InspirationIdea) => inspirationNoteContent(idea).body.trim().split('\n')[0].slice(0, 80) || idea.attachments?.[0]?.name || '';

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

// `icon` is the compact form that sits with favorite and delete.
function SessionLink({ execution, icon = false }: { execution: InspirationExecution; icon?: boolean }) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  return execution.sessionHref ? <Link className={icon ? `${styles.iconButton} ${styles.sessionButton}` : styles.link} to={execution.sessionHref}
    aria-label={icon ? t('inspiration.openSession') : undefined} title={icon ? t('inspiration.openSession') : undefined}
    onClick={() => rememberInspirationReturn(execution.ideaId, execution.sessionHref!, params.get('filter') || 'saved')}>
    {icon ? <InspirationActionIcon name="session" /> : <>{t('inspiration.openSession')} ↗</>}
  </Link> : null;
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
      <InspirationActionIcon name="delete" />{!compact && t('inspiration.delete')}
    </button>
  </span>;
}

// Draft, search and drag state belong to the page; settled cards only need to
// render again when their own props or subscribed UI/translation context change.
const IdeaCard = memo(function IdeaCard({ idea, execution, agent, roster, onOpen, onChange, onPress, onSend, starting = false }: {
  idea: InspirationIdea; execution?: InspirationExecution; agent?: InspirationAgent; roster?: InspirationAgent[];
  onOpen: (id: string) => void; onChange: () => Promise<void>;
  onPress?: (event: ReactPointerEvent<HTMLElement>, idea: InspirationIdea) => void;
  /** Hands the idea to an agent picked from the dock, as a drop would. */
  onSend?: (idea: InspirationIdea) => void; starting?: boolean;
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
  const content = inspirationNoteContent(idea);
  const latest = execution?.runId === idea.latestExecution?.runId ? execution : idea.latestExecution;
  const rooting = Boolean(latest && idea.archivedAt === null
    && ['queued', 'starting', 'running', 'waiting_input', 'waiting_approval', 'failed', 'canceled', 'interrupted', 'unknown'].includes(idea.status));
  const sendable = Boolean(onSend) && canStartInspiration(idea) && !busy && !starting;
  const rounds = idea.rounds?.count ?? (idea.latestExecution ? 1 : 0);
  const workers = idea.rounds?.agents ?? (idea.latestExecution ? [{ backendId: idea.latestExecution.backendId, agentId: idea.latestExecution.agentId }] : []);
  const nameOf = (value: { backendId: string; agentId: string }) => roster?.find(item => item.id === value.agentId
    && item.backendId === value.backendId)?.name || value.agentId;
  return <article className={`${paperStyles.surface} ${styles.card}`} data-inspiration-id={idea.id} data-paper={paperTone} data-has-media={Boolean(idea.attachments?.length) || undefined}
    data-rooting={rooting || undefined}
    data-inspiration-draggable={Boolean(onPress) && canStartInspiration(idea) && !busy && !starting || undefined}
    aria-busy={starting || undefined} onPointerDown={event => { if (!busy && !starting) onPress?.(event, idea); }} onClick={(event) => {
    if ((event.target as Element).closest('button, a, input, textarea, select, summary, [data-card-interactive]')
      || window.getSelection()?.toString()) return;
    onOpen(idea.id);
  }}>
    {rooting && latest && <InspirationRunBar ideaId={idea.id} execution={latest} agent={agent} onOpen={() => onOpen(idea.id)} />}
    <div className={styles.cardContent}>
      <InspirationContent body={content.body} attachments={content.attachments} compact onOpen={() => onOpen(idea.id)}
        renderText={text => (text || !content.attachments.length) && <button className={styles.bodyButton} data-inspiration-body type="button"
        aria-label={`${t('inspiration.view')}：${titleOf(idea)}`} onClick={() => onOpen(idea.id)}>
        <p>{text}</p>
      </button>} />
    </div>
    <div className={styles.cardFoot}>
      <RunStatus status={idea.status} accepted={idea.acceptedAt !== null} archived={idea.archivedAt !== null} execution={execution} />
      {rounds > 0 && <span className={styles.cardStack}>
        {workers.map(value => <AgentAvatarView key={`${value.backendId}/${value.agentId}`}
          agentId={value.agentId} name={nameOf(value)} className={styles.cardStackAvatar}
          fallback={Array.from(nameOf(value)).slice(0, 2).join('').toUpperCase()} />)}
        <span className={styles.cardRounds}>{t('inspiration.thread.rounds', { count: rounds })}</span>
      </span>}
      {/* The date gives way to the card's tools on hover, in the same place. */}
      <span className={styles.footEnd}>
        <time className={styles.cardDate} dateTime={new Date(idea.updatedAt).toISOString()}>
          {new Date(idea.updatedAt).toLocaleDateString(i18n?.resolvedLanguage || i18n?.language, { year: 'numeric', month: 'short', day: 'numeric' })}
        </time>
        <span className={styles.cardActions} data-card-interactive>
          {sendable && <button type="button" className={styles.iconButton} aria-label={t('inspiration.start')} title={t('inspiration.start')}
            onClick={() => onSend?.(idea)}><InspirationActionIcon name="send" /></button>}
          {idea.latestExecution && <SessionLink execution={idea.latestExecution} icon />}
          <button className={styles.iconButton} type="button" disabled={busy} aria-pressed={idea.favorite}
            aria-label={t(idea.favorite ? 'inspiration.unfavorite' : 'inspiration.favorite')} title={t(idea.favorite ? 'inspiration.unfavorite' : 'inspiration.favorite')}
            onClick={() => { void patch({ favorite: !idea.favorite }); }}><InspirationActionIcon name="favorite" filled={idea.favorite} toolbar /></button>
          <DeleteIdeaButton idea={idea} compact disabled={busy} onDeleted={onChange} />
        </span>
      </span>
    </div>
  </article>;
});

export function AgentInspirationPanel({ backendId, agentId }: { backendId: string; agentId: string }) {
  const { t } = useTranslation();
  const [detailId, setDetailId] = useState<string | null>(null);
  const viewKey = JSON.stringify([backendId, agentId]);
  const requestedPages = useRef({ key: viewKey, count: 1 });
  if (requestedPages.current.key !== viewKey) requestedPages.current = { key: viewKey, count: 1 };
  const page = usePageCache(`agent-inspirations:${viewKey}`, async () => ({
    ...await readAllAgentInspirationPages(requestedPages.current.count, { backendId, agentId }), viewKey,
  }));
  if (page.data?.viewKey === viewKey) requestedPages.current.count = Math.max(requestedPages.current.count, page.data.pageCount);
  const roster = usePageCache('inspiration-agents:agent-panel', getInspirationAgents);
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
    {page.loading && <p className={styles.meta} role="status">{t('common.loading')}</p>}
    {page.error && <p className={styles.error} role="alert">{page.error}</p>}
    {!page.loading && !page.error && page.data?.items.length === 0 && <p className={styles.meta}>
      {t('agents.inspirationEmpty')}
    </p>}
    <div className={styles.grid}>{page.data?.items.map(idea => <IdeaCard key={idea.id} idea={idea} roster={roster.data?.agents}
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
  // A card's send button opens the same dock for a click choice.
  const [picking, setPicking] = useState<InspirationIdea | null>(null);
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
  useEffect(() => () => { dragCancel.current?.(); dragCancel.current = null; setPicking(null); }, [viewKey, detailId]);
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
  const sendIdea = useCallback((idea: InspirationIdea) => {
    if (!canStartInspiration(idea) || pendingStarts.current.has(idea.id)) return;
    dragCancel.current?.(); agentDock.current?.prepare(); setPicking(idea);
  }, []);
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
        <SearchCapsule value={search} onChange={setSearch} placeholder={t('inspiration.search')} collapsible />
        <InspirationAutoGrowth noticeTarget={growthNoticeTarget} onOpen={openIdea} onChange={refresh} />
      </div></div>
    {page.loading && <p role="status" className={styles.meta}>{t('common.loading')}</p>}
    {page.data && visibleIdeas.length === 0 && <div className={styles.empty}><span className={styles.emptyMark} aria-hidden="true"><InspirationStatusIcon status="saved" /></span>
      <h2>{t(query || filter !== 'saved' ? 'inspiration.noMatches' : 'inspiration.empty')}</h2><p>{t(query || filter !== 'saved' ? 'inspiration.noMatchesHint' : 'inspiration.emptyHint')}</p></div>}
    <div className={styles.grid}>{visibleIdeas.map((idea) => <IdeaCard key={idea.id} idea={idea} execution={page.data?.executions[idea.id]}
      agent={roster.data?.agents.find(agent => agent.id === idea.latestExecution?.agentId && agent.backendId === idea.latestExecution?.backendId)}
      roster={roster.data?.agents} onPress={pressIdea} onSend={sendIdea} starting={startingIdeas.has(idea.id)}
      onOpen={openIdea} onChange={refresh} />)}</div>
    <div className={styles.loadMore} ref={moreElement} data-inspiration-load-more>
      {loadingMore && <span role="status" className={styles.meta}>{t('common.loading')}</span>}
      {page.error && <div role="alert" className={styles.error}>{page.error}
        <button type="button" className="btn-subtle" onClick={() => { void refresh(); }}>{t('common.refresh')}</button></div>}
    </div>
    </section>
    <InspirationAgentChatter paused={Boolean(params.get('id')) || Boolean(draft.body.trim()) || Boolean(draft.attachments?.length) || mediaBusy || archiveBusy || saving || printing || dragging || Boolean(picking)} />
    <InspirationAgentDock ref={agentDock} active={dragging || Boolean(picking)} onCancel={picking ? () => setPicking(null) : undefined}
      onPick={picking ? agent => { const idea = picking; setPicking(null); void handToAgent(idea, { element: document.body, agent }); } : undefined} />
    {params.get('id') && <IdeaDetail key={params.get('id')!} id={params.get('id')!} onClose={() => setParams((previous) => { const next = new URLSearchParams(previous); next.delete('id'); return next; })} onChange={refresh} />}
  </div>;
}
