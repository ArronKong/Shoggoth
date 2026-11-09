import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import AgentAvatarView from '../components/AgentAvatar';
import TurnTimeline from '../components/TurnTimeline/TurnTimeline';
import { TrajChevron, TrajGlyph } from '../components/TurnTimeline/trajectoryIcons';
import { formatTurnElapsed, stepsFromParts, toolActivityTitle, turnElapsedMs, type TurnStep } from '../lib/turnTimeline';
import type { InspirationExecution } from '../types';
import { InspirationArtifacts } from './InspirationActivity';
import { inspirationRunTone, latestInspirationStep } from './inspiration-run-status';
import { useInspirationActivity } from './use-inspiration-activity';
import styles from './InspirationRunCard.module.css';

const oneLine = (text?: string) => text?.replace(/\s+/gu, ' ').trim() || '';

// The round's run card in the idea detail: a black bar that opens into the full trajectory, below the
// Session's own prompt card while a live approval / input request waits. `children` sits between the
// card and the files the round produced, which share the card's single activity read.
export default function InspirationRunCard({ ideaId, execution, agentName, attention, children }: {
  ideaId: string; execution: InspirationExecution; agentName: string;
  /** A live request the user must answer; it takes the card's place and the bar moves below it. */
  attention?: ReactNode; children?: ReactNode;
}) {
  const { t } = useTranslation();
  const { activity, error, live, retry } = useInspirationActivity(ideaId, execution);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = window.setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 1000);
    return () => window.clearInterval(timer);
  }, [live, execution.runId]);
  const parts = activity?.trajectory.parts;
  const steps = useMemo(() => stepsFromParts(parts || [], { live, includeText: true }), [parts, live]);
  const step = useMemo(() => latestInspirationStep(parts || [], live), [parts, live]);
  // As on the wall's cards, a failed or stopped round shows a red bar even when nothing was recorded;
  // any other finished round with nothing recorded has no trajectory to open.
  const tone = inspirationRunTone(execution);
  const unrecorded = tone !== 'error' && Boolean(activity && !live && !error && !steps.length && !activity.trajectory.reason);
  const status = t(`inspiration.status.${execution.status === 'canceled' ? 'failed' : execution.status}`);
  let detail = '';
  if (step?.kind === 'tool') {
    detail = toolActivityTitle(step.toolName, step.args, t);
    if (step.status === 'error' || step.isError) detail += ` · ${t('turnLab.failed')}`;
  } else if (step?.kind === 'plan') {
    detail = step.planEntries?.find(entry => entry.status === 'in_progress')?.content
      || step.planEntries?.at(-1)?.content || t('turnLab.stepPlan');
  } else detail = oneLine(step?.text);
  const summary = t('turnLab.processSummary', { steps: steps.length, tools: steps.filter(value => value.kind === 'tool').length });
  // A running round names its latest step; a finished one sums its trajectory up.
  const line = error ? t('inspiration.activityUnavailable') : live ? detail || status
    : tone === 'error' ? (steps.length ? `${status} · ${summary}` : status)
      : steps.length ? `${t('turnLab.processLabel')} · ${summary}` : status;
  const elapsed = formatTurnElapsed(turnElapsedMs(execution.createdAt, execution.finishedAt ?? (live ? now : undefined)));
  const glyph = (value: TurnStep) => value.kind === 'tool' ? value.category ?? 'execute' : value.kind;
  const showDurations = steps.some(value => typeof value.durationS === 'number' && value.durationS > 0);
  const emptyText = t(error ? 'inspiration.activityUnavailable' : !activity ? 'common.loading'
    : live && (!activity.trajectory.reason || activity.trajectory.reason === 'preparing') ? 'inspiration.trajectoryWaiting'
      : activity.trajectory.reason ? 'inspiration.trajectoryUnavailable' : 'inspiration.trajectoryEmpty');
  const label = `${agentName} · ${line}`;
  return <>
    {attention && <section className={styles.request} aria-label={status} data-inspiration-run-request>{attention}</section>}
    {execution.status !== 'completed' && !unrecorded && (open ? <section className={styles.card} aria-label={t('turnLab.processLabel')} data-inspiration-run-card>
      <button type="button" className={styles.cardHead} aria-expanded="true" title={label} onClick={() => setOpen(false)}>
        <AgentAvatarView agentId={execution.agentId} name={agentName} className={styles.avatar} />
        <span className={styles.name}>{agentName}</span>
        <span className={styles.elapsed}>{elapsed}</span>
        <span className={styles.chevron} data-open="true"><TrajChevron /></span>
      </button>
      {steps.length ? <TurnTimeline steps={steps} status={live ? 'running' : 'done'} showDurations={showDurations}
        autoFollow={live} className={styles.timeline} />
        : <p className={styles.empty} role="status">{emptyText}</p>}
      {activity?.trajectory.truncated && <p className={styles.note}>{t('inspiration.trajectoryTruncated')}</p>}
      {error && steps.length > 0 && <p className={styles.note} role="status">{t('inspiration.activityUnavailable')}</p>}
      {error && <button type="button" className={styles.retry} onClick={retry}>{t('common.retry')}</button>}
    </section> : <button type="button" className={styles.pill} aria-expanded="false" aria-label={label} title={label}
      data-inspiration-detail-bar data-tone={tone} onClick={() => setOpen(true)}>
      <AgentAvatarView agentId={execution.agentId} name={agentName} className={styles.avatar} />
      {live && step && detail && <span className={styles.stepIcon}><TrajGlyph kind={glyph(step)} /></span>}
      <span className={styles.line} role="status" aria-live="polite" aria-atomic="true">{line}</span>
      {live && <span className={styles.elapsed}>{elapsed}</span>}
      <span className={styles.chevron}><TrajChevron /></span>
    </button>)}
    {children}
    <InspirationArtifacts activity={activity} />
  </>;
}
