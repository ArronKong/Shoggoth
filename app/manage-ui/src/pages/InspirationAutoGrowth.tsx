import AgentAvatarView from "../components/AgentAvatar";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { Popover } from '@base-ui/react/popover';
import { Switch } from '../components/Field';
import BackendTabIcon, { sortBackendTabs } from '../components/BackendTabIcon';
import LiquidPill from '../components/LiquidPill';
import { usePageCache } from '../lib/usePageCache';
import { useBackendCatalog } from '../lib/backends';
import { getInspirationAgents, getInspirationGrowth, getStatus, updateInspirationGrowth } from '../api/client';
import type { InspirationGrowthSettings } from '../types';
import InspirationGrowthIcon from './InspirationGrowthIcon';
import { useInspirationNoticeBadge } from './use-inspiration-notice-badge';
import styles from './InspirationAutoGrowth.module.css';

type Executor = InspirationGrowthSettings['executors'][number];
const keyOf = (value: Executor) => JSON.stringify([value.backendId, value.agentId]);

function AgentAvatar({ value, name }: { value: Executor; name: string }) {
  return <AgentAvatarView agentId={value.agentId} name={name} className={styles.avatar}
    fallback={Array.from(name).slice(0, 2).join('').toUpperCase()} />;
}

function GrowthPanel({ page, active, layout, onHeight, children }: {
  page: 'overview' | 'picker'; active: boolean; layout?: 'single-runtime' | 'single-agent';
  onHeight: (height: number) => void; children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = panel.current;
    if (!active || !element) return;
    // Measure inside the portal's mount lifecycle, including its first frame.
    // The page sizes independently of the shell, so its text never scales.
    const measure = () => onHeight(element.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, onHeight]);
  // React 18 needs the empty-string form of inert for the fading page.
  const inertProps: { inert?: '' } = { inert: active ? undefined : '' };
  return <div ref={panel} className={styles.panel} data-page={page} data-active={active} data-layout={layout}
    {...inertProps} aria-hidden={!active}>{children}</div>;
}

function useScrollFade(active: boolean, itemCount: number, resetKey?: string) {
  // A callback ref also covers lists mounted after the popover portal opens.
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [earlier, setEarlier] = useState(false);
  const [more, setMore] = useState(false);
  const checkOverflow = useCallback(() => {
    setEarlier(Boolean(element && element.scrollTop > 1));
    setMore(Boolean(element && element.scrollHeight - element.scrollTop > element.clientHeight + 1));
  }, [element]);
  useLayoutEffect(() => {
    if (active && element) element.scrollTop = 0;
  }, [active, element, resetKey]);
  useLayoutEffect(() => {
    if (!active || !element) return;
    checkOverflow();
    const observer = new ResizeObserver(checkOverflow);
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, element, itemCount, resetKey, checkOverflow]);
  return { ref: setElement, onScroll: checkOverflow, 'data-scrolled': earlier || undefined, 'data-more': more || undefined };
}

export default function InspirationAutoGrowth({ onOpen, onChange, noticeTarget }: {
  onOpen: (id: string) => void; onChange: () => Promise<unknown>; noticeTarget?: HTMLElement | null;
}) {
  const { t } = useTranslation();
  const data = usePageCache('inspiration-growth', getInspirationGrowth);
  const roster = usePageCache('inspiration-agents', getInspirationAgents);
  const connections = usePageCache('inspiration-backends', getStatus);
  const catalog = useBackendCatalog('agents');
  const [open, setOpen] = useState(false);
  const [noticesOpen, setNoticesOpen] = useState(false);
  const { unreadCount, markRead } = useInspirationNoticeBadge(data.data?.failures, noticesOpen);
  const [view, setView] = useState<'overview' | 'picker'>('overview');
  const [selected, setSelected] = useState<Executor[]>([]);
  const [editRevision, setEditRevision] = useState<number | null>(null);
  const [backend, setBackend] = useState('shoggoth');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState('');
  const addButton = useRef<HTMLButtonElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const [panelHeight, setPanelHeight] = useState<number>();
  const settings = data.data?.settings;
  const executors = settings?.executors || [];
  const agents = roster.data?.agents || [];
  const choices = agents.map(agent => ({ value: { agentId: agent.id, backendId: agent.backendId },
    name: agent.name, backendName: agent.backendName, available: agent.capabilities.execute }));
  for (const value of executors) {
    if (!choices.some(choice => keyOf(choice.value) === keyOf(value))) {
      choices.push({ value, name: value.agentId, backendName: value.backendId, available: false });
    }
  }
  const nameOf = (value: Executor) => choices.find(choice => keyOf(choice.value) === keyOf(value))?.name || value.agentId;
  // Descriptors include every supported backend, even ones never connected.
  // Keep saved offline executors discoverable while filtering those unused tabs.
  const connectedRuntimeIds = new Set(connections.data
    ? connections.data.filter(item => item.connected && !item.disabled).map(item => item.id)
    : agents.map(agent => agent.backendId));
  const runtimeIds = new Set(connectedRuntimeIds);
  for (const value of executors) runtimeIds.add(value.backendId);
  const runtimeChoices = catalog.filter(item => runtimeIds.has(item.id))
    .map(item => ({ id: item.id, name: item.name }));
  for (const choice of choices) {
    if (runtimeIds.has(choice.value.backendId) && !runtimeChoices.some(item => item.id === choice.value.backendId)) {
      runtimeChoices.push({ id: choice.value.backendId, name: choice.backendName });
    }
  }
  const runtimes = sortBackendTabs(runtimeChoices);
  const activeBackend = runtimes.some(item => item.id === backend) ? backend : runtimes[0]?.id;
  const hasRuntimeTabs = runtimes.filter(item => connectedRuntimeIds.has(item.id)).length > 1;
  const visibleAgents = choices.filter(choice => hasRuntimeTabs ? choice.value.backendId === activeBackend
    : runtimeIds.has(choice.value.backendId));
  const pickerLayout = hasRuntimeTabs ? undefined : visibleAgents.length === 1 ? 'single-agent' : 'single-runtime';
  const overviewScroll = useScrollFade(open && view === 'overview', executors.length);
  const pickerScroll = useScrollFade(open && view === 'picker', visibleAgents.length, activeBackend);
  const selectionChanged = view === 'picker' && editRevision !== null && settings?.revision !== editRevision;
  const serviceError = data.error || (data.data?.errorCode && data.data.errorCode !== 'INSPIRATION_EXECUTOR_UNAVAILABLE'
    ? t('inspiration.growth.serviceError', { code: data.data.errorCode }) : '');
  const needsAttention = Boolean(data.data?.failures.length);
  useEffect(() => { if (!needsAttention) setNoticesOpen(false); }, [needsAttention]);

  useEffect(() => {
    const refresh = () => { if (!document.hidden && !saving.current) void data.refresh(); };
    const timer = window.setInterval(refresh, 5000);
    window.addEventListener('focus', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [data.refresh]);

  useEffect(() => {
    if (open && view === 'picker') backButton.current?.focus();
  }, [open, view]);

  const showOverview = () => {
    // Keep the exiting picker intact; showPicker restores saved selections on entry.
    setView('overview'); setEditRevision(null); setError('');
    requestAnimationFrame(() => addButton.current?.focus());
  };
  const showPicker = () => {
    if (!settings || saving.current) return;
    setSelected(settings.executors); setEditRevision(settings.revision); setError('');
    setBackend(runtimes.find(runtime => agents.some(agent => agent.backendId === runtime.id && agent.capabilities.execute))?.id
      || runtimes[0]?.id || 'shoggoth');
    setView('picker'); void roster.refresh(); void connections.refresh();
  };
  const save = async (enabled: boolean, nextExecutors: Executor[], expectedRevision = settings?.revision) => {
    if (!settings || saving.current || expectedRevision === undefined || (enabled && nextExecutors.length === 0)) return;
    saving.current = true; setBusy(true); setError('');
    try {
      const result = await updateInspirationGrowth({ expectedRevision, enabled, executors: nextExecutors });
      // Replace invalidates in-flight polls so a late GET cannot undo this save in the UI.
      data.replace(result);
      if (view === 'picker') showOverview();
      await onChange();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      await data.refresh();
    } finally { saving.current = false; setBusy(false); }
  };

  const feedback = <>
    {selectionChanged && <p className={styles.waiting} role="status">{t('inspiration.growth.selectionChanged')}
      <button type="button" className={styles.retry} disabled={busy} onClick={() => {
        if (!settings) return;
        setSelected(settings.executors); setEditRevision(settings.revision); setError('');
      }}>{t('inspiration.growth.refreshSelection')}</button>
    </p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {serviceError && <p className={styles.error} role="alert">{serviceError}
      <button type="button" className={styles.retry} onClick={() => { void data.refresh(); }}>{t('common.refresh')}</button></p>}
    {data.data?.errorCode === 'INSPIRATION_EXECUTOR_UNAVAILABLE' && <p role="status" className={styles.waiting}>
      {t('inspiration.growth.waitingExecutor')}</p>}
    {view === 'picker' && roster.error && <p className={styles.error} role="alert">{roster.error}
      <button type="button" className={styles.retry} onClick={() => { void roster.refresh(); }}>{t('common.refresh')}</button>
    </p>}
  </>;

  return <><Popover.Root open={open} onOpenChange={value => {
    if (saving.current) return;
    setOpen(value);
    if (value) {
      setNoticesOpen(false);
      setView('overview'); setSelected([]); setEditRevision(null); setError('');
      void roster.refresh(); void data.refresh(); void connections.refresh();
    }
  }} onOpenChangeComplete={value => {
    if (!value) setPanelHeight(undefined);
  }}>
    <Popover.Trigger className={styles.trigger} aria-label={t('inspiration.growth.title')} title={t('inspiration.growth.title')}>
      <InspirationGrowthIcon enabled={settings?.enabled || false} />
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner className={styles.positioner} side="left" sideOffset={8} align="start" collisionPadding={14}
        collisionAvoidance={{ side: 'flip', align: 'shift', fallbackAxisSide: 'end' }}>
        <Popover.Popup className={styles.popup} data-view={view} aria-busy={busy} style={{ height: panelHeight }}
          aria-labelledby={view === 'overview' ? 'inspiration-growth-label' : 'inspiration-growth-picker-label'}
          aria-describedby={view === 'overview' && executors.length === 0 ? 'inspiration-growth-hint' : undefined}>
          <GrowthPanel page="overview" active={view === 'overview'} onHeight={setPanelHeight}>
            <div className={styles.heading}>
              <h2 id="inspiration-growth-label" className={styles.title}>{t('inspiration.growth.title')}</h2>
              <Switch checked={settings?.enabled || false} disabled={busy || !settings || (!settings.enabled && executors.length === 0)}
                ariaLabelledBy="inspiration-growth-label" onChange={value => { void save(value, executors); }} />
            </div>
            {executors.length === 0
              ? <p id="inspiration-growth-hint" className={styles.hint}>{t('inspiration.growth.offHint')}</p>
              : <div id="inspiration-growth-active-executors" className={styles.executors + ' ' + styles.scrollFade}
                {...overviewScroll} aria-label={t('inspiration.growth.title')} role="list">
                {executors.map(value => <div key={keyOf(value)} className={styles.executor} role="listitem">
                  <AgentAvatar value={value} name={nameOf(value)} />
                  <span className={styles.agentName} title={nameOf(value) + ' · ' + value.backendId}>{nameOf(value)}</span>
                  <button type="button" className={styles.remove} disabled={busy} aria-label={t('inspiration.growth.removeAgent', { name: nameOf(value) })}
                    onClick={() => {
                      const remaining = executors.filter(item => keyOf(item) !== keyOf(value));
                      void save(Boolean(settings?.enabled && remaining.length), remaining);
                    }}><span className={styles.glyph + ' ' + styles.minus} aria-hidden="true" /></button>
                </div>)}
              </div>}
            <button ref={addButton} type="button" className={styles.action} disabled={busy || !settings}
              aria-label={t('inspiration.growth.addAgent')} title={t('inspiration.growth.addAgent')} onClick={showPicker}>
              <span className={styles.glyph + ' ' + styles.plus} aria-hidden="true" />
            </button>
            {view === 'overview' && feedback}
          </GrowthPanel>
          <GrowthPanel page="picker" active={view === 'picker'} layout={pickerLayout} onHeight={setPanelHeight}>
            <div className={styles.pickerHeading}>
              <h2 id="inspiration-growth-picker-label" className={styles.title}>
                <button ref={backButton} type="button" className={styles.back} disabled={busy} onClick={showOverview}>
                  <span className={styles.glyph + ' ' + styles.backIcon} aria-hidden="true" />{t('inspiration.growth.addAgent')}
                </button>
              </h2>
              {selected.length > 0 && <span className={styles.count} role="status" aria-label={t('inspiration.growth.selectedCount', { count: selected.length })}>{selected.length}</span>}
            </div>
            {hasRuntimeTabs && <div className={styles.runtimes} role="group" aria-label={t('inspiration.growth.filterBackend')}>
              <LiquidPill key={JSON.stringify(runtimes.map(runtime => runtime.id))} value={activeBackend || ''}
                activeSelector={`.${styles.runtime}[aria-pressed="true"]`} className={styles.runtimePill} />
              {runtimes.map(runtime => <button key={runtime.id} type="button" className={styles.runtime}
                aria-label={runtime.name} title={runtime.name} aria-pressed={runtime.id === activeBackend}
                data-runtime={runtime.id} disabled={busy} onClick={() => setBackend(runtime.id)}>
                <BackendTabIcon backend={runtime.id} label={runtime.name} />
              </button>)}
            </div>}
            <div id="inspiration-growth-executors" className={styles.agents + ' ' + styles.scrollFade} {...pickerScroll}
              role="group" aria-label={t('inspiration.growth.executors')}>
              {visibleAgents.map(choice => {
                const checked = selected.some(value => keyOf(value) === keyOf(choice.value));
                const label = choice.name + ' · ' + choice.backendName + (choice.available ? '' : ' · ' + t('inspiration.unavailable'));
                return <button key={keyOf(choice.value)} type="button" className={styles.agent} role="checkbox" aria-checked={checked}
                  aria-label={label} title={label} disabled={busy || (!choice.available && !checked)} onClick={() => {
                    if (saving.current || (!choice.available && !checked)) return;
                    setSelected(values => checked ? values.filter(value => keyOf(value) !== keyOf(choice.value)) : [...values, choice.value]);
                  }}>
                  <AgentAvatar value={choice.value} name={choice.name} />
                  <span className={styles.agentName}>{choice.name}</span>
                  {checked && <span className={styles.glyph + ' ' + styles.check} aria-hidden="true" />}
                </button>;
              })}
              {visibleAgents.length === 0 && <p className={styles.empty} role="status">{t(roster.loading ? 'common.loading' : 'inspiration.growth.noBackendAgents')}</p>}
            </div>
            <button type="button" className={styles.action} disabled={busy || !settings || selectionChanged}
              aria-label={t('inspiration.growth.confirmAgents')} title={t('inspiration.growth.confirmAgents')}
              onClick={() => {
                if (selectionChanged || !settings) return;
                // Adding agents changes the roster; the switch controls new assignments.
                void save(settings.enabled && selected.length > 0, selected, editRevision ?? settings.revision);
              }}><span className={styles.glyph + ' ' + styles.check} aria-hidden="true" /></button>
            {view === 'picker' && feedback}
          </GrowthPanel>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>
  {noticeTarget && needsAttention && createPortal(<Popover.Root open={noticesOpen} onOpenChange={value => {
    setNoticesOpen(value);
    if (value) { markRead(); setOpen(false); void data.refresh(); }
  }}>
    <Popover.Trigger className={`${styles.trigger} ${styles.noticeTrigger}`} data-inspiration-notices
      aria-describedby={unreadCount ? 'inspiration-notices-unread' : undefined}
      aria-label={t('inspiration.growth.needsYou')} title={t('inspiration.growth.needsYou')}>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <circle cx="12" cy="12" r="9" /><path d="M12 7v6" strokeLinecap="round" /><circle cx="12" cy="17" r=".8" fill="currentColor" stroke="none" />
      </svg>
      {unreadCount > 0 && <span id="inspiration-notices-unread" className={styles.alertMark} data-inspiration-notices-badge
        aria-label={t('inspiration.growth.unreadCount', { count: unreadCount })}>{unreadCount}</span>}
    </Popover.Trigger>
    <Popover.Portal><Popover.Positioner className={styles.positioner} side="bottom" sideOffset={12} align="start" collisionPadding={14}>
      <Popover.Popup className={`${styles.popup} ${styles.noticesPopup}`} aria-labelledby="inspiration-notices-title">
        <h2 id="inspiration-notices-title" className={styles.noticesTitle}>{t('inspiration.growth.needsYou')}</h2>
        <div className={styles.failures}>
          {data.data?.failures.map(failure => <button key={failure.ideaId} type="button" onClick={() => {
            setNoticesOpen(false); onOpen(failure.ideaId);
          }}>
            <span>{failure.title}</span><small>{failure.errorCode !== 'INSPIRATION_CANCELED' && <>
              {t(failure.attempts === 2 ? 'inspiration.growth.retryFailed' : 'inspiration.growth.startFailed')}{' · '}
            </>}{t('inspiration.growth.errors.' + failure.errorCode, { defaultValue: failure.errorCode })}</small><span aria-hidden="true">↗</span>
          </button>)}
        </div>
      </Popover.Popup>
    </Popover.Positioner></Popover.Portal>
  </Popover.Root>, noticeTarget)}
  </>;
}
