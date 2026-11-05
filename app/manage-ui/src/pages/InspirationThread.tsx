import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Popover } from '@base-ui/react/popover';
import Modal from '../components/Modal';
import AgentAvatarView from '../components/AgentAvatar';
import ArtifactThumb from '../components/ArtifactThumb';
import BackendTabIcon, { sortBackendTabs } from '../components/BackendTabIcon';
import LiquidPill from '../components/LiquidPill';
import TurnTimeline from '../components/TurnTimeline/TurnTimeline';
import { IconTrajectory } from '../components/TurnTimeline/trajectoryIcons';
import { useConfirm, useToast } from '../components/ui';
import { usePageCache } from '../lib/usePageCache';
import { useNavigationGuard } from '../lib/navigation-guard';
import { toSanitizedMarkdownHtml } from '../lib/markdown';
import { rememberInspirationReturn } from '../lib/inspiration-navigation';
import { useBackendCatalog } from '../lib/backends';
import { useSessionRuntimeModels } from '../lib/useSessionRuntimeModels';
import { stepsFromParts } from '../lib/turnTimeline';
import { getInspiration, getInspirationAgents, getIdleInspirationAgents, getInspirationExecutions, updateInspiration,
  startInspiration, respondInspiration, cancelInspiration, revealPath } from '../api/client';
import type { InspirationAgent, InspirationAttachment, InspirationExecution, InspirationIdea } from '../types';
import ChatPromptCard, { type ChatPromptResponse } from './ChatPromptCard';
import ChatModelMenu from './ChatModelMenu';
import { IconAttachmentFolder, IconModel, IconSend, IconStop } from './chatIcons';
import InspirationStatusIcon from './InspirationStatusIcon';
import InspirationActionIcon from './InspirationActionIcon';
import InspirationMediaEditor from './InspirationMedia';
import InspirationContent from './InspirationContent';
import { draftBytes as bytes } from './inspiration-draft';
import { defaultInspirationAgent, inspirationStartFields } from './inspiration-execution';
import { clearQueuedInspirationStep, queueInspirationStep, useQueuedInspirationStep } from './inspiration-next-step';
import { inspirationNoteContent } from './inspiration-note-text';
import { useInspirationActivity } from './use-inspiration-activity';
import paperStyles from './InspirationPaper.module.css';
import pickerStyles from './InspirationAutoGrowth.module.css';
import styles from './InspirationThread.module.css';

export const ACTIVE = new Set(['queued', 'starting', 'running', 'waiting_input', 'waiting_approval', 'unknown']);
export const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
// Keep the original four-color mapping for notes saved before paperTone existed.
export const paperToneOf = (idea: InspirationIdea) => idea.paperTone
  ?? [...idea.id].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 4;
export const displayStatusOf = (status: InspirationIdea['status'], execution?: InspirationExecution) =>
  execution?.attention?.active && execution.attention.request.kind !== 'user_input' ? 'waiting_approval'
    : status === 'canceled' ? 'failed' : status;

const EXTERNAL = new Set(['openclaw', 'hermes']);
const keyOf = (value: { backendId: string; id: string }) => `${value.backendId}/${value.id}`;
type ExecutionOwner = Pick<InspirationExecution, 'backendId' | 'agentId'>;
const ownerOf = (execution: ExecutionOwner) => `${execution.backendId}/${execution.agentId}`;
// The wall files an idea by its latest round; the thread's track follows the same four stages.
const GROWTH_STAGES = ['saved', 'active', 'result', 'archived'] as const;
const GROWTH_GLYPHS = { saved: 'saved', active: 'running', result: 'completed', archived: 'completed' } as const;
const growthStageOf = (idea: InspirationIdea) => idea.archivedAt !== null ? 3 : idea.status === 'completed' ? 2
  : idea.status === 'saved' || idea.status === 'skipped' ? 0 : 1;
const toneOf = (status: InspirationIdea['status'], archived: boolean) => archived ? 'fruit'
  : status === 'completed' ? 'result' : status === 'starting' || status === 'running' || status === 'queued' ? 'live'
    : status === 'waiting_input' ? 'input' : status === 'waiting_approval' ? 'approval'
      : status === 'failed' || status === 'interrupted' || status === 'canceled' ? 'wilted' : status === 'unknown' ? 'unknown' : 'seed';
const elapsedOf = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;
};
// A round's Session lives in its Chat link; the model menu needs that Session's key.
const sessionKeyOf = (execution: InspirationExecution) => execution.sessionHref
  ? new URLSearchParams(execution.sessionHref.split('?')[1] || '').get('session') : null;
const stableIndex = (value: string, size: number) => [...value].reduce((sum, character) => sum + character.charCodeAt(0), 0) % size;

function Attention({ ideaId, execution, onChange, chat = false, agentName }: {
  ideaId: string; execution: InspirationExecution; onChange: () => Promise<void>;
  /** Use the Session's prompt card layout for a live request. */
  chat?: boolean;
  /** The execution's agent, the subject of its approval card. */
  agentName?: string;
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
  // A live approval card that can be allowed prints its own command, so the context only adds what the card leaves out.
  const { approvalChoices, approvalOptions, approvalDetails } = attention.request;
  const allowable = approvalChoices?.some((choice) => ['once', 'session', 'always'].includes(choice)
    || approvalOptions?.some((option) => option.choice === choice && option.kind.startsWith('allow_')));
  const printed = attention.active && allowable ? approvalDetails?.command : undefined;
  const context = <>
    {attention.command && attention.command !== printed
      && <pre className={styles.command}>{attention.command}</pre>}
    {attention.cwd && !(chat && approvalDetails?.cwd === attention.cwd)
      && <p className={styles.attentionPath}>{t('inspiration.workspace')}<span>{attention.cwd}</span></p>}
    {attention.details && <pre className={styles.command}>{attention.details}</pre>}
  </>;
  return <div className={chat ? styles.chatAttention : styles.attention} data-active={attention.active} data-card-interactive>
    {attention.active ? <ChatPromptCard key={attention.request.requestId}
      draftKey={`inspiration:${execution.runId}:${attention.request.requestId}`} agentName={agentName}
      entry={{ ...attention.request, id: attention.request.requestId }} onRespond={(_entry, data) => respond(data)} />
      : <><strong>{t('inspiration.expired')}</strong><p>{attention.request.message}</p>
        {attention.request.fields.map((field) => <p key={field.id}>{field.label}</p>)}
        <p className={styles.meta}>{t('inspiration.expiredHint')}</p></>}
    {context}
  </div>;
}

// Four growth stages named as on the wall's filters; a growing idea also counts its rounds.
function GrowthTrack({ idea, status, rounds }: { idea: InspirationIdea; status: InspirationIdea['status']; rounds: number }) {
  const { t } = useTranslation();
  const current = growthStageOf(idea);
  const archived = idea.archivedAt !== null;
  return <span className={styles.growthTrack}>
    {GROWTH_STAGES.map((stage, index) => index === current
      ? <span key={stage} className={styles.growthNow}>
        <InspirationStatusIcon className={styles.growthGlyph} archived={archived}
          status={index === 1 && !['starting', 'running', 'waiting_input', 'waiting_approval'].includes(status) ? 'running' : GROWTH_GLYPHS[stage]} />
        {(index === 1 || index === 2) && rounds > 0
          ? t('inspiration.thread.stageRound', { stage: t(`inspiration.filters.${stage}`), n: rounds }) : t(`inspiration.filters.${stage}`)}
      </span>
      : <span key={stage} className={styles.growthStep} data-reached={index < current || undefined} title={t(`inspiration.filters.${stage}`)}>
        <InspirationStatusIcon className={styles.growthGlyph} status={GROWTH_GLYPHS[stage]} archived={stage === 'archived'} />
      </span>)}
  </span>;
}

// Only a confirmed continuation can apply a model choice to the next round.
function ModelPill({ agent, workspace, executions, disabled }: {
  agent?: InspirationAgent; workspace: string | null; executions: InspirationExecution[]; disabled: boolean;
}) {
  const { t } = useTranslation();
  const catalog = useBackendCatalog();
  const switchable = Boolean(agent && catalog.find(item => item.id === agent.backendId)?.surfaces.sessionRuntimeSwitch);
  const session = agent && workspace !== null ? executions.find(value => value.agentId === agent.id
    && value.backendId === agent.backendId && value.workspace === workspace && value.reusableSession) : undefined;
  const sessionKey = session ? sessionKeyOf(session) : null;
  const models = useSessionRuntimeModels(agent?.backendId || '', agent?.id || '', sessionKey, switchable && Boolean(sessionKey), true);
  const data = models.data;
  if (!data || data.models.length === 0) {
    return <span className="chat-model-menu">
      <button type="button" className="chat-pill chat-pill--select chat-pill--icon-label chat-pill--model" disabled
        title={t('inspiration.thread.defaultModelHint')}>
        <span className="chat-pill__icon" aria-hidden="true"><IconModel /></span>
        <span className="chat-pill__label">{t('inspiration.thread.defaultModel')}</span>
      </button>
    </span>;
  }
  const active = data.selection.model ?? data.models.find(model => model.isDefault && model.bindingId === data.selection.bindingId)?.id ?? '';
  return <ChatModelMenu portalInDialog
    models={data.models.map(model => ({ ...model, disabled: !data.selection.canSwitch && model.bindingId !== data.selection.bindingId }))}
    activeModel={active} activeBindingId={data.selection.bindingId} activeModelProviderRef={data.selection.modelProviderRef}
    runtimeGroups={data.runtimes}
    onSelect={(id, _provider, bindingId, modelProviderRef) => {
      if (bindingId) void models.select(id, bindingId, null, { modelProviderRef }).then(() => models.refresh());
    }}
    loading={models.loading} loadError={models.error} onRefresh={() => { void models.refresh(); }}
    disabled={disabled || models.pending} />;
}

// Single choice, on the auto-nurture popover's "add an agent" page.
function AgentPicker({ agents, current, used, busyKeys, disabled, open, onOpenChange, onPick }: {
  agents: InspirationAgent[]; current?: InspirationAgent; used: Set<string>; busyKeys: Set<string>; disabled: boolean;
  open: boolean; onOpenChange: (open: boolean) => void; onPick: (agent: InspirationAgent) => void;
}) {
  const { t } = useTranslation();
  const [backend, setBackend] = useState<string | null>(null);
  const runtimes = sortBackendTabs([...new Map(agents.map(agent => [agent.backendId, { id: agent.backendId, name: agent.backendName }])).values()]);
  const activeBackend = runtimes.some(item => item.id === backend) ? backend! : current?.backendId || runtimes[0]?.id;
  const rows = agents.filter(agent => runtimes.length < 2 || agent.backendId === activeBackend)
    .sort((a, b) => Number(used.has(keyOf(b))) - Number(used.has(keyOf(a))));
  return <Popover.Root open={open} onOpenChange={value => { onOpenChange(value); if (value) setBackend(null); }}>
    <Popover.Trigger className={`chat-pill ${styles.mention}`} disabled={disabled}
      aria-label={t('inspiration.thread.mention', { name: current?.name || '' })}>
      {current && <AgentAvatarView agentId={current.id} name={current.name} className={styles.mentionAvatar}
        fallback={Array.from(current.name).slice(0, 2).join('').toUpperCase()} />}
      <span className={styles.mentionName}>{current?.name || t('inspiration.noAgent')}</span>
      <InspirationActionIcon name="chevron" className={styles.mentionChevron} />
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner className={pickerStyles.positioner} side="top" align="start" sideOffset={10} collisionPadding={14}>
        <Popover.Popup className={`${pickerStyles.popup} ${styles.pickerPopup}`} aria-labelledby="inspiration-thread-picker">
          <div className={`${pickerStyles.panel} ${styles.pickerPanel}`}>
            <div className={pickerStyles.pickerHeading}>
              <h2 id="inspiration-thread-picker" className={pickerStyles.title}>{t('inspiration.thread.pickerTitle')}</h2>
            </div>
            {runtimes.length > 1 && <div className={pickerStyles.runtimes} role="group" aria-label={t('inspiration.growth.filterBackend')}>
              <LiquidPill key={runtimes.map(runtime => runtime.id).join()} value={activeBackend || ''}
                activeSelector={`.${pickerStyles.runtime}[aria-pressed="true"]`} className={pickerStyles.runtimePill} />
              {runtimes.map(runtime => <button key={runtime.id} type="button" className={pickerStyles.runtime}
                aria-label={runtime.name} title={runtime.name} aria-pressed={runtime.id === activeBackend}
                data-runtime={runtime.id} onClick={() => setBackend(runtime.id)}>
                <BackendTabIcon backend={runtime.id} label={runtime.name} />
              </button>)}
            </div>}
            <div className={`${pickerStyles.agents} ${styles.pickerAgents}`} role="radiogroup" aria-label={t('inspiration.agent')}>
              {rows.map(agent => {
                const checked = current ? keyOf(agent) === keyOf(current) : false;
                const label = agent.name + (agent.capabilities.execute ? busyKeys.has(keyOf(agent)) ? ` · ${t('inspiration.thread.busyHint')}` : ''
                  : ` · ${t(agent.capabilities.reason === 'backend-unavailable' ? 'inspiration.unavailable' : 'inspiration.unsupported')}`);
                return <button key={keyOf(agent)} type="button" role="radio" aria-checked={checked} className={pickerStyles.agent}
                  title={label} aria-label={label} disabled={!agent.capabilities.execute} onClick={() => { onPick(agent); onOpenChange(false); }}>
                  <AgentAvatarView agentId={agent.id} name={agent.name} className={pickerStyles.avatar}
                    fallback={Array.from(agent.name).slice(0, 2).join('').toUpperCase()} />
                  <span className={pickerStyles.agentName}>{agent.name}</span>
                  {checked && <span className={`${pickerStyles.glyph} ${pickerStyles.check}`} aria-hidden="true" />}
                </button>;
              })}
              {rows.length === 0 && <p className={pickerStyles.empty} role="status">{t('inspiration.growth.noBackendAgents')}</p>}
            </div>
          </div>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}

type RoundProps = {
  ideaId: string; execution: InspirationExecution; number: number; agentName: string;
  latest: boolean; archived: boolean; busy: boolean; accepted: boolean; showTrajectory: boolean;
  onToggleTrajectory: () => void; onChange: () => Promise<void>; onAccept: () => void; onRelay: () => void;
  onRedo: () => void; onRetry: () => void; onCheck: () => void;
};

// One round: what the user asked for (black bubble), then the agent's reply under its name.
function Round({ ideaId, execution, number, agentName, latest, archived, busy, accepted, showTrajectory,
  onToggleTrajectory, onChange, onAccept, onRelay, onRedo, onRetry, onCheck }: RoundProps) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const live = ACTIVE.has(execution.status) && execution.status !== 'unknown';
  const completed = execution.status === 'completed';
  const { activity, error, retry } = useInspirationActivity(ideaId, execution, showTrajectory || completed);
  const steps = useMemo(() => stepsFromParts(activity?.trajectory.parts || [], { live, includeText: true }), [activity, live]);
  const [now, setNow] = useState(Date.now);
  const [revealing, setRevealing] = useState<string | null>(null);
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = window.setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 1000);
    return () => window.clearInterval(timer);
  }, [live, execution.runId]);
  const status = displayStatusOf(execution.status, execution);
  const tone = toneOf(status, false);
  const instruction = execution.instruction?.trim();
  const round = t('inspiration.thread.round', { n: number });
  const spent = Math.max(1, Math.round(((execution.finishedAt ?? now) - execution.createdAt) / 60000));
  const when = live ? elapsedOf(now - execution.createdAt) : completed
    ? t('inspiration.thread.duration', { round, time: spent < 60 ? t('inspiration.thread.minutes', { count: spent })
      : t('inspiration.thread.hours', { count: Math.round(spent / 60) }) }) : round;
  // Explain known service codes in the current language; keep unknown codes visible for support.
  const known = execution.errorCode ? `inspiration.growth.errors.${execution.errorCode}` : '';
  const reason = execution.status === 'canceled' ? t('inspiration.growth.errors.INSPIRATION_CANCELED')
    : known && i18n?.exists?.(known) ? t(known) : execution.errorCode || ['failed', 'interrupted'].includes(execution.status) ? t('inspiration.runError') : null;
  const code = execution.status !== 'canceled' && execution.errorCode && !(known && i18n?.exists?.(known)) ? execution.errorCode : null;
  const trajectoryLabel = t(showTrajectory ? 'inspiration.thread.hideTrajectory' : 'inspiration.thread.showTrajectory');
  const reveal = async (file: string) => {
    if (revealing) return;
    setRevealing(file);
    try { await revealPath(file); }
    catch (failure) { toast.error(t('chat.artifactsRevealFailed', { msg: messageOf(failure) })); }
    finally { setRevealing(null); }
  };
  const files = activity?.artifacts.items || [];
  return <>
    <div className={styles.turnYou}><div className={styles.userBubble}>{instruction || t('inspiration.thread.defaultIntent')}</div></div>
    <div className={styles.turnAi} data-inspiration-round={execution.runId}>
      <div className={styles.author}>
        <AgentAvatarView agentId={execution.agentId} name={agentName} className={styles.authorAvatar}
          fallback={Array.from(agentName).slice(0, 2).join('').toUpperCase()} />
        <span className={styles.authorName}>{agentName}</span>
        {!completed && <span className={styles.statusChip} data-tone={tone}>
          {live && <span className={styles.liveDot} data-still={tone !== 'live' || undefined} aria-hidden="true" />}
          {t(`inspiration.status.${status}`)}</span>}
        {completed && accepted && <span className={styles.statusChip} data-tone="adopted">{t('inspiration.thread.adopted')}</span>}
        <span className={styles.authorSide}>
          <span className={styles.when}>{when}</span>
          <button type="button" className={styles.trajectoryButton} aria-pressed={showTrajectory} title={trajectoryLabel}
            aria-label={trajectoryLabel} onClick={onToggleTrajectory}><IconTrajectory /></button>
        </span>
      </div>
      {showTrajectory && <section className={styles.trajectory} aria-label={t('turnLab.processLabel')}>
        {steps.length ? <TurnTimeline steps={steps} status={live ? 'running' : 'done'} autoFollow={live}
          showDurations={steps.some(value => typeof value.durationS === 'number' && value.durationS > 0)} className={styles.timeline} />
          : <p className={styles.meta} role="status">{t(error ? 'inspiration.activityUnavailable' : !activity ? 'common.loading'
            : live && (!activity.trajectory.reason || activity.trajectory.reason === 'preparing') ? 'inspiration.trajectoryWaiting'
              : activity.trajectory.reason ? 'inspiration.trajectoryUnavailable' : 'inspiration.trajectoryEmpty')}</p>}
        {activity?.trajectory.truncated && <p className={styles.meta}>{t('inspiration.trajectoryTruncated')}</p>}
        {error && <button type="button" className={styles.textAction} onClick={retry}>{t('common.retry')}</button>}
      </section>}
      {execution.attention?.active && <Attention ideaId={ideaId} execution={execution} onChange={onChange} chat agentName={agentName} />}
      {completed ? <div className={styles.aiCard} data-adopted={accepted || undefined}>
        {execution.attention && !execution.attention.active && <Attention ideaId={ideaId} execution={execution} onChange={onChange} agentName={agentName} />}
        {execution.resultSummary ? <div className={styles.markdown} dangerouslySetInnerHTML={{ __html: toSanitizedMarkdownHtml(execution.resultSummary, true) }} />
          : <p className={styles.progressHint}>{t('inspiration.progressHint.completed')}</p>}
        {files.length > 0 && <section aria-label={t('inspiration.artifacts')} className={styles.artifacts}>
          <div className={styles.sectionHeading}><h3>{t('inspiration.artifacts')}</h3><span>{t('chat.artifactsRevealInFolder')}</span></div>
          <ul className={styles.artifactList}>{files.map(file => <li key={file.path}>
            <button type="button" className={styles.artifact} disabled={revealing !== null} title={file.path}
              aria-label={t('inspiration.revealArtifact', { name: file.name })} onClick={() => { void reveal(file.path); }}>
              <span className={styles.artifactThumb}><ArtifactThumb name={file.name} /></span>
              <span className={styles.artifactName}><strong>{file.name}</strong><span>{file.path}</span></span>
            </button>
          </li>)}</ul>
          {activity?.artifacts.hasMore && <p className={styles.meta}>{t('inspiration.artifactsMore')}</p>}
        </section>}
        {activity?.artifacts.reason === 'remote' && <p className={styles.meta}>{t('inspiration.artifactsRemote')}</p>}
        {latest && !archived && <div className={styles.aiActions}>
          <button type="button" className={styles.acceptAction} aria-pressed={accepted} disabled={busy}
            title={t(accepted ? 'inspiration.thread.unadoptHint' : 'inspiration.thread.adoptHint')} onClick={onAccept}>
            <InspirationActionIcon name="check" />{t(accepted ? 'inspiration.thread.adopted' : 'inspiration.thread.adopt')}
          </button>
          <button type="button" className={`btn-subtle btn-sm ${styles.chip}`} disabled={busy} onClick={onRelay}>{t('inspiration.thread.relay')}</button>
          <button type="button" className={styles.textAction} disabled={busy} onClick={onRedo}>{t('inspiration.thread.redo')}</button>
        </div>}
      </div> : !live && <div className={styles.aiCard}>
        {execution.attention && !execution.attention.active && <Attention ideaId={ideaId} execution={execution} onChange={onChange} agentName={agentName} />}
        {execution.status === 'unknown' ? <p className={styles.progressHint}>{t('inspiration.progressHint.unknown')}</p>
          : reason || code ? <p className={styles.runFailure}><span className={styles.runFailureMark} aria-hidden="true">!</span>
            <span className={styles.runFailureText}>{reason && <span>{reason}</span>}{code && <code>{code}</code>}</span></p> : null}
        {latest && !archived && <div className={styles.aiActions}>
          {execution.status === 'unknown' ? <button type="button" className={`btn-subtle btn-sm ${styles.chip}`} disabled={busy} onClick={onCheck}>
            {t('inspiration.checkStatus')}</button> : <>
            <button type="button" className={`btn-dark btn-sm ${styles.chip}`} disabled={busy} onClick={onRetry}>{t('inspiration.thread.narrowRetry')}</button>
            <button type="button" className={`btn-subtle btn-sm ${styles.chip}`} disabled={busy} onClick={onRelay}>{t('inspiration.thread.switchAgent')}</button>
          </>}
        </div>}
      </div>}
    </div>
  </>;
}

export function IdeaDetail({ id, open = true, onClose, onOpenChangeComplete, onChange }: {
  id: string; open?: boolean; onClose: () => void; onOpenChangeComplete?: (open: boolean) => void;
  onChange: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const [params] = useSearchParams();
  const detail = usePageCache(`inspiration-detail:${id}`, async () => {
    const [value, history] = await Promise.all([getInspiration(id), getInspirationExecutions(id)]);
    return { idea: value.idea, history };
  });
  // The wall can mount or refresh beside this dialog. Its cache request
  // generation must not discard the dialog's own roster response.
  const roster = usePageCache('inspiration-agents:detail', getInspirationAgents);
  const idle = usePageCache('inspiration-idle-agents:detail', () => getIdleInspirationAgents());
  const [edit, setEdit] = useState<{ body: string; revision: number; attachments: InspirationAttachment[] } | null>(null);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [agentKey, setAgentKey] = useState('');
  const [intent, setIntent] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const queued = useQueuedInspirationStep(id);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [trajectories, setTrajectories] = useState<Record<string, boolean>>({});
  const [planting, setPlanting] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const operation = useRef({ input: '', id: '' });
  const [more, setMore] = useState<InspirationExecution[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadedMore, setLoadedMore] = useState(false);
  const thread = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const noteGlyph = useRef<HTMLSpanElement>(null);
  const lineup = useRef<HTMLDivElement>(null);
  const idea = detail.data?.idea;
  const content = idea ? inspirationNoteContent(idea) : null;
  const dirty = Boolean(edit && (edit.body !== content?.body
    || JSON.stringify(edit.attachments) !== JSON.stringify(content?.attachments || []))) || text.trim().length > 0;
  useNavigationGuard({ dirty, busy: busy || mediaBusy, onDiscard: onClose });
  useVisibleRefresh(detail.refresh);
  useVisibleRefresh(roster.refresh, 15000);
  useVisibleRefresh(idle.refresh, 15000);
  const refresh = async () => { await Promise.all([detail.refresh(), onChange()]); };
  const act = async (key: unknown, action: (operationId: string) => Promise<unknown>, done?: () => void) => {
    if (pending.current) return false;
    const value = JSON.stringify(key);
    if (operation.current.input !== value) operation.current = { input: value, id: crypto.randomUUID() };
    pending.current = true; setBusy(true);
    try { await action(operation.current.id); operation.current = { input: '', id: '' }; done?.(); await refresh(); return true; }
    catch (error) { toast.error(messageOf(error)); await refresh(); return false; }
    finally { pending.current = false; setBusy(false); }
  };
  const close = async () => {
    if (busy || mediaBusy) return;
    if (dirty && !await confirm({ title: t('inspiration.discardTitle'), message: t('inspiration.discardHint'), confirmLabel: t('inspiration.discard') })) return;
    onClose();
  };

  const candidates = roster.data?.agents || [];
  const executions = [...(detail.data?.history.executions || []), ...more]
    .filter((value, index, values) => values.findIndex((item) => item.id === value.id) === index);
  const total = Math.max(detail.data?.history.total ?? 0, idea?.rounds?.count ?? 0, executions.length);
  const nextCursor = loadedMore ? cursor : detail.data?.history.nextCursor;
  const latest = executions[0];
  const archived = Boolean(idea && idea.archivedAt !== null);
  const running = Boolean(idea && ACTIVE.has(idea.status));
  const seeding = Boolean(idea && executions.length === 0 && !idea.latestExecution);
  const displayStatus = idea ? displayStatusOf(idea.status, latest) : 'saved';
  const tone = toneOf(displayStatus, archived);
  // Agents working on another idea; the one running this idea is not "busy" here.
  const busyKeys = new Set(idle.data ? candidates.filter(agent => agent.capabilities.execute
    && !idle.data!.agents.some(value => keyOf(value) === keyOf(agent))
    && !(running && latest && ownerOf(latest) === keyOf(agent))).map(keyOf) : []);
  const fallbackAgent = defaultInspirationAgent(candidates, idea);
  const chosen = candidates.find(value => keyOf(value) === agentKey) || (!agentKey ? fallbackAgent : undefined);
  const external = Boolean(chosen && EXTERNAL.has(chosen.backendId));
  const used = new Set(executions.map(ownerOf));
  const nameOf = (execution: ExecutionOwner) => candidates.find(value => value.id === execution.agentId
    && value.backendId === execution.backendId)?.name || execution.agentId;
  const intents = t(seeding ? 'inspiration.thread.intents' : 'inspiration.thread.followups', { returnObjects: true }) as unknown;
  const intentList = Array.isArray(intents) ? intents as string[] : [];
  const defaultIntent = t('inspiration.thread.defaultIntent');
  const locale = i18n?.resolvedLanguage || i18n?.language;
  const instructionOf = (choice: string | null, value: string) => {
    const body = value.trim();
    if (!choice) return body;
    if (choice === defaultIntent && !body) return '';
    return body ? t('inspiration.thread.intentWithText', { intent: choice, text: body }) : choice;
  };
  const instruction = instructionOf(intent, text);
  const ready = seeding || Boolean(text.trim() || intent);
  const tooLong = bytes(instruction) > 16 * 1024;

  // A seed opens with the first intent chosen; later rounds start from a blank composer.
  const seeded = useRef(false);
  useEffect(() => {
    if (!idea || seeded.current) return;
    seeded.current = true;
    if (seeding) setIntent(intentList[0] ?? defaultIntent);
  }, [idea, seeding, defaultIntent]);

  // New rounds keep the reader at the latest reply; reading back up is left alone.
  const lastRun = latest?.runId;
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const element = thread.current;
    if (!element || !idea) return;
    if (seeding) { element.scrollTop = 0; return; }
    if (pinned.current) element.scrollTop = element.scrollHeight;
  }, [idea?.id, lastRun, latest?.status, seeding, queued]);

  const startWith = async (agent: InspirationAgent | undefined, instruction: string) => {
    if (queued || !agent?.capabilities.execute || !idea || ACTIVE.has(idea.status) || idea.archivedAt !== null) return false;
    const fields = inspirationStartFields(idea, agent, instruction, workspace);
    pinned.current = true;
    return act(['start', fields], (operationId) => startInspiration(id, { ...fields, operationId }), () => {
      setMore([]); setLoadedMore(false);
    });
  };

  const send = () => {
    if (!idea || archived || busy || planting || queued || !chosen?.capabilities.execute || !ready || tooLong) return;
    const reset = () => { setText(''); setIntent(null); setAgentKey(''); setPickerOpen(false); };
    if (running) {
      if (idea.latestExecution && queueInspirationStep(id, idea.latestExecution.runId, inspirationStartFields(idea, chosen, instruction, workspace))) reset();
      return;
    }
    if (seeding) {
      // The seed flies from the note into the chosen agent, then the round starts.
      setPlanting(true);
      void plantSeed(noteGlyph.current, lineup.current?.querySelector<HTMLElement>(`[data-agent="${CSS.escape(keyOf(chosen))}"] [data-avatar]`) ?? null)
        .then(() => startWith(chosen, instruction)).then(started => { if (started) reset(); })
        .finally(() => setPlanting(false));
      return;
    }
    void startWith(chosen, instruction).then(started => { if (started) reset(); });
  };
  const restoreQueuedDraft = () => {
    if (queued?.status !== 'paused' || text.trim() || intent) return;
    setText(queued.instruction);
    setAgentKey(ownerOf(queued));
    setWorkspace(queued.workspace ?? '');
    clearQueuedInspirationStep(id);
    input.current?.focus({ preventScroll: true });
  };
  const stop = () => {
    if (!idea?.latestExecution) return;
    void act(['cancel', idea.latestExecution.runId], (operationId) => cancelInspiration(id, { operationId, runId: idea.latestExecution!.runId }));
  };
  const accept = () => {
    if (!idea) return;
    void act(['accept', idea.revision], (operationId) => updateInspiration(id,
      { operationId, expectedRevision: idea.revision, patch: { accepted: !idea.acceptedAt } }));
  };
  const harvest = () => {
    if (!idea) return;
    void act(['archive', idea.revision], (operationId) => updateInspiration(id,
      { operationId, expectedRevision: idea.revision, patch: { archived: true } }), () => toast.success(t('inspiration.thread.harvested')));
  };
  const regrow = () => {
    if (!idea) return;
    void act(['restore', idea.revision], (operationId) => updateInspiration(id,
      { operationId, expectedRevision: idea.revision, patch: { archived: false } }));
  };
  const favorite = () => {
    if (!idea) return;
    void act(['favorite', idea.revision], (operationId) => updateInspiration(id,
      { operationId, expectedRevision: idea.revision, patch: { favorite: !idea.favorite } }));
  };
  const relay = () => { setPickerOpen(true); input.current?.focus({ preventScroll: true }); };
  const executionAgent = (execution: InspirationExecution) => candidates.find(value => value.id === execution.agentId && value.backendId === execution.backendId);

  const harvestable = Boolean(idea && idea.status === 'completed');
  const placeholder = !chosen ? t('inspiration.noAgent') : running && latest
    ? t('inspiration.thread.placeholderLive', { name: nameOf(latest) })
    : seeding ? t('inspiration.thread.placeholderSeed', { name: chosen.name })
      : latest && ownerOf(latest) !== keyOf(chosen) ? t('inspiration.thread.placeholderSwitch', { name: chosen.name })
        : t('inspiration.thread.placeholderNext', { name: chosen.name });
  const greetings = t('inspiration.chatter.lines', { returnObjects: true }) as unknown;
  const greeting = chosen && Array.isArray(greetings) && greetings.length ? `${greetings[stableIndex(chosen.id, greetings.length)]}${t('inspiration.thread.greetingAsk')}` : '';
  const lineupAgents = [...candidates].sort((a, b) => Number(!a.capabilities.execute) - Number(!b.capabilities.execute)
    || Number(busyKeys.has(keyOf(a))) - Number(busyKeys.has(keyOf(b))));
  const sessionExecution = executions.find(value => value.sessionHref);
  const headButton = (label: string, onClick: () => void, icon: ReactNode, disabled = false, pressed?: boolean) =>
    <button type="button" className={styles.headButton} title={label} aria-label={label} disabled={disabled}
      aria-pressed={pressed} onClick={onClick}>{icon}</button>;

  return <Modal open={open} onOpenChangeComplete={onOpenChangeComplete} variant="report"
    className={`${styles.modal}${seeding || !idea ? ` ${styles.fit}` : ''}`}
    title={idea ? <span className={styles.title} data-tone={tone}><GrowthTrack idea={idea} status={displayStatus} rounds={total} /></span> : t('inspiration.title')}
    actions={idea && <>
      {archived ? headButton(t('inspiration.restore'), regrow, <InspirationStatusIcon status="completed" className={styles.headGlyph} />, busy)
        : !seeding && headButton(harvestable ? t(idea.acceptedAt ? 'inspiration.thread.harvestAdopted' : 'inspiration.thread.harvestLatest')
          : t('inspiration.thread.harvestBlocked'), harvest, <InspirationStatusIcon status="completed" archived className={styles.headGlyph} />, busy || !harvestable)}
      {headButton(t(idea.favorite ? 'inspiration.unfavorite' : 'inspiration.favorite'), favorite,
        <InspirationActionIcon name="favorite" filled={idea.favorite} toolbar />, busy || Boolean(edit), idea.favorite)}
      {sessionExecution?.sessionHref && <Link className={styles.headButton} to={sessionExecution.sessionHref}
        title={t('inspiration.thread.openSession')} aria-label={t('inspiration.thread.openSession')}
        onClick={() => rememberInspirationReturn(id, sessionExecution.sessionHref!, params.get('filter') || 'saved')}>
        <InspirationActionIcon name="session" /></Link>}
    </>}
    onClose={() => { void close(); }} dismissible={!busy && !mediaBusy}
    footer={idea && <div className={styles.foot}>
      {archived ? <div className={styles.harvested}><span>{t('inspiration.thread.harvestedHint')}</span>
        <button type="button" className={`btn-subtle btn-sm ${styles.chip}`} disabled={busy} onClick={regrow}>{t('inspiration.restore')}</button></div> : <>
        {!running && intentList.length > 0 && <div className={styles.chips} role="group" aria-label={t('inspiration.thread.intentsLabel')}>
          {intentList.map(value => <button key={value} type="button" className={`${intent === value ? 'btn-dark' : 'btn-subtle'} btn-sm ${styles.chip}`}
            aria-pressed={intent === value} disabled={busy || planting} onClick={() => setIntent(intent === value ? null : value)}>{value}</button>)}
        </div>}
        {workspaceOpen && !external && <label className={styles.workspaceRow}>
          <span>{t('inspiration.thread.workspace')}</span>
          <input value={workspace} disabled={busy} placeholder={idea.latestExecution?.workspace || t('inspiration.defaultWorkspace')}
            onChange={event => setWorkspace(event.target.value)} />
        </label>}
        <div className={styles.composer}>
          <label htmlFor="inspiration-thread-input" className={styles.srOnly}>{t('inspiration.thread.instructionLabel')}</label>
          <textarea id="inspiration-thread-input" ref={input} className={styles.input} rows={2} value={text} placeholder={placeholder}
            disabled={busy || planting} onChange={event => setText(event.target.value)} onKeyDown={event => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              event.preventDefault();
              if (!event.repeat) send();
            }} />
          <div className={styles.bar}>
            <div className={styles.barLeft}>
              {!seeding && <AgentPicker agents={candidates} current={chosen} used={used} busyKeys={busyKeys} disabled={busy || planting}
                open={pickerOpen} onOpenChange={setPickerOpen} onPick={agent => setAgentKey(keyOf(agent))} />}
              <ModelPill agent={chosen} workspace={chosen ? inspirationStartFields(idea, chosen, '', workspace).workspace : null}
                executions={executions} disabled={busy || planting || Boolean(queued)} />
              {!external && <button type="button" className={`chat-pill ${styles.workspacePill}`} aria-pressed={workspaceOpen}
                title={workspace.trim() || t('inspiration.workspaceHint')} aria-label={t('inspiration.thread.workspace')}
                onClick={() => setWorkspaceOpen(value => !value)}><IconAttachmentFolder /></button>}
            </div>
            <div className={styles.barRight}>
              {running ? <button type="button" className={`${styles.send} ${styles.stop}`} disabled={busy || !idea.latestExecution}
                aria-label={t('inspiration.stop')} title={t('inspiration.stop')} onClick={stop}><IconStop /></button>
                : <button type="button" className={styles.send} disabled={busy || planting || Boolean(queued) || !ready || !chosen?.capabilities.execute || tooLong}
                  aria-label={t('inspiration.thread.send')} title={t('inspiration.thread.send')} onClick={send}><IconSend /></button>}
            </div>
          </div>
        </div>
      </>}
    </div>}>
    {(detail.error || roster.error) && <p className={styles.alert} role="alert">{detail.error || roster.error}</p>}
    {!idea ? <div className={styles.loading} role="status" aria-label={t('common.loading')}><span /><span /></div>
      : <div className={styles.thread} ref={thread} data-tone={tone} onScroll={event => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
      }}>
        <section className={`${paperStyles.surface} ${styles.notePaper}`} data-paper={paperToneOf(idea)} data-editing={Boolean(edit) || undefined}
          aria-label={t('inspiration.original')}>
          {edit ? <div className={styles.noteInline}>
            <InspirationMediaEditor body={edit.body} attachments={edit.attachments} disabled={busy} onBusyChange={setMediaBusy}
              onChange={update => setEdit(previous => previous ? { ...previous, ...update(previous) } : null)}
              inputProps={{ rows: 1, autoFocus: true, 'aria-label': t('inspiration.original') }} />
            {edit.revision !== idea.revision && <p role="alert" className={styles.error}>{t('inspiration.editConflict')}</p>}
            {edit.revision !== idea.revision && <button type="button" className="btn-subtle" disabled={busy}
              onClick={() => setEdit({ ...edit, revision: idea.revision })}>{t('inspiration.keepMyEdit')}</button>}
          </div> : <div className={styles.noteBody}><InspirationContent body={content!.body} attachments={content!.attachments}
            renderText={value => value && <p className={styles.original}>{value}</p>} /></div>}
          <div className={styles.noteFoot}>
            <span ref={noteGlyph} className={styles.noteGlyphSlot}><InspirationStatusIcon className={styles.noteGlyph} status={displayStatus} archived={archived} /></span>
            {edit ? <>
              <button type="button" className={`${styles.noteEdit} ${styles.noteEditFirst}`} disabled={busy || mediaBusy} onClick={() => setEdit(null)}>{t('common.cancel')}</button>
              <button type="button" className={styles.noteEdit}
                disabled={busy || mediaBusy || (!edit.body.trim() && !edit.attachments.length) || bytes(edit.body) > 16 * 1024 || edit.revision !== idea.revision}
                onClick={() => { void act(['edit', edit], (operationId) => updateInspiration(id, { operationId, expectedRevision: edit.revision,
                  // The editor held a legacy title as the text's first line, so saving folds it into the text.
                  patch: { body: edit.body, attachments: edit.attachments, ...(idea.title ? { title: null } : {}) } }), () => setEdit(null)); }}>
                <InspirationActionIcon name="check" />{t('inspiration.saveEdit')}</button>
            </> : <button type="button" className={`${styles.noteEdit} ${styles.noteEditFirst}`} disabled={busy}
              onClick={() => setEdit({ ...content!, revision: idea.revision })}><InspirationActionIcon name="edit" />{t('inspiration.edit')}</button>}
            <time className={styles.noteDate} dateTime={new Date(idea.createdAt).toISOString()}
              title={t('inspiration.savedOn', { date: new Date(idea.createdAt).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' }) })}>
              {new Date(idea.createdAt).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' })}</time>
          </div>
        </section>
        {seeding && <section className={styles.plant} aria-label={t('inspiration.start')}>
          <p className={styles.plantHead}>{t('inspiration.thread.seedHeading')}</p>
          <div className={styles.lineup} ref={lineup} role="radiogroup" aria-label={t('inspiration.agent')}>
            {lineupAgents.map(agent => {
              const checked = chosen ? keyOf(agent) === keyOf(chosen) : false;
              const occupied = busyKeys.has(keyOf(agent));
              const label = agent.name + (!agent.capabilities.execute
                ? ` · ${t(agent.capabilities.reason === 'backend-unavailable' ? 'inspiration.unavailable' : 'inspiration.unsupported')}`
                : occupied ? ` · ${t('inspiration.thread.busyHint')}` : '');
              return <button key={keyOf(agent)} type="button" role="radio" className={styles.lineupAgent} data-agent={keyOf(agent)}
                aria-checked={checked} aria-label={label} title={label} disabled={!agent.capabilities.execute || busy || planting}
                onClick={() => setAgentKey(keyOf(agent))}>
                <span className={styles.lineupAvatar} data-avatar><AgentAvatarView agentId={agent.id} name={agent.name}
                  fallback={Array.from(agent.name).slice(0, 2).join('').toUpperCase()} /></span>
                <span className={styles.lineupName}>{agent.name}</span>
                {occupied && <span className={styles.lineupState}>{t('inspiration.thread.busy')}</span>}
              </button>;
            })}
            {candidates.length === 0 && <p className={styles.meta} role="status">{t(roster.loading ? 'common.loading' : 'inspiration.noAgent')}</p>}
          </div>
          {chosen && <div key={keyOf(chosen)} className={`${styles.turnAi} ${styles.greet}`}>
            <div className={styles.author}>
              <AgentAvatarView agentId={chosen.id} name={chosen.name} className={styles.authorAvatar}
                fallback={Array.from(chosen.name).slice(0, 2).join('').toUpperCase()} />
              <span className={styles.authorName}>{chosen.name}</span>
            </div>
            <div className={styles.aiCard}><p className={styles.greetLine}>{greeting}</p></div>
          </div>}
        </section>}
        {nextCursor && <button type="button" className={`btn-subtle btn-sm ${styles.more}`} disabled={busy} onClick={() => {
          void act(['history', nextCursor], async () => {
            const page = await getInspirationExecutions(id, nextCursor);
            setMore((previous) => [...previous, ...page.executions]); setCursor(page.nextCursor); setLoadedMore(true);
          });
        }}>{t('inspiration.moreHistory')}</button>}
        {[...executions].reverse().map((execution, index, list) => {
          const isLatest = execution.id === latest?.id;
          const live = ACTIVE.has(execution.status) && execution.status !== 'unknown';
          const agent = executionAgent(execution);
          return <Round key={execution.id} ideaId={id} execution={execution} number={total - (list.length - 1 - index)}
            agentName={nameOf(execution)} latest={isLatest} archived={archived} busy={busy || Boolean(queued)}
            accepted={isLatest && Boolean(idea.acceptedAt) && execution.status === 'completed'}
            showTrajectory={trajectories[execution.runId] ?? live}
            onToggleTrajectory={() => setTrajectories(previous => ({ ...previous, [execution.runId]: !(previous[execution.runId] ?? live) }))}
            onChange={refresh} onAccept={accept} onRelay={relay}
            onRedo={() => { void startWith(agent, execution.instruction || ''); }}
            onRetry={() => { void startWith(agent ?? chosen, t('inspiration.thread.narrowRetry')); }}
            onCheck={() => { void act(['refresh', execution.runId], async () => { await Promise.all([roster.refresh(), detail.refresh()]); }); }} />;
        })}
        {queued && <div className={`${styles.turnYou} ${styles.queued}`}>
          <span className={styles.turnMeta}>
            <span role="status">{t(`inspiration.thread.queue.${queued.status}`, { name: nameOf(queued) })}</span>
            {queued.status === 'paused' && <button type="button" className={styles.textAction}
              disabled={Boolean(text.trim() || intent)} onClick={restoreQueuedDraft}>{t('inspiration.thread.queue.restore')}</button>}
            {queued.status !== 'sending' && <button type="button" className={styles.textAction}
              onClick={() => clearQueuedInspirationStep(id)}>{t(queued.status === 'waiting' ? 'inspiration.thread.unqueue' : 'inspiration.thread.queue.dismiss')}</button>}
          </span>
          <div className={styles.userBubble}>{queued.instruction || defaultIntent}</div>
        </div>}
      </div>}
  </Modal>;
}

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

// A copy of the note's seed glyph arcs into the chosen avatar, which then gives a small pulse.
function plantSeed(from: HTMLElement | null, to: HTMLElement | null) {
  if (!from || !to || typeof from.animate !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return Promise.resolve();
  const start = from.getBoundingClientRect(), end = to.getBoundingClientRect();
  const seed = from.cloneNode(true) as HTMLElement;
  Object.assign(seed.style, { position: 'fixed', zIndex: '2000', left: `${start.left}px`, top: `${start.top}px`,
    width: `${start.width}px`, height: `${start.height}px`, margin: '0', pointerEvents: 'none' });
  document.body.append(seed);
  const dx = end.left + end.width / 2 - start.left - start.width / 2, dy = end.top + end.height / 2 - start.top - start.height / 2;
  return new Promise<void>(resolve => {
    const flight = seed.animate([
      { transform: 'translate(0, 0) scale(1) rotate(0deg)' },
      { transform: `translate(${dx * .45}px, ${dy * .45 - 90}px) scale(1.9) rotate(-25deg)`, offset: .45 },
      { transform: `translate(${dx}px, ${dy}px) scale(.7) rotate(10deg)`, opacity: .3 },
    ], { duration: 700, easing: 'cubic-bezier(.3, .7, .4, 1)' });
    const finish = () => {
      seed.remove();
      to.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.16)' }, { transform: 'scale(1)' }], { duration: 280, easing: 'ease-out' });
      window.setTimeout(resolve, 220);
    };
    flight.onfinish = finish; flight.oncancel = finish;
  });
}
