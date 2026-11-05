import AgentAvatarView from "../components/AgentAvatar";
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { InspirationAgent, InspirationExecution } from '../types';
import { toolActivityTitle } from '../lib/turnTimeline';
import { useInspirationActivity } from './use-inspiration-activity';
import { inspirationRunTone, latestInspirationStep } from './inspiration-run-status';
import styles from './InspirationRunBar.module.css';

const oneLine = (text?: string) => text?.replace(/\s+/gu, ' ').trim() || '';

export default function InspirationRunBar({ ideaId, execution, agent, onOpen }: {
  ideaId: string; execution: InspirationExecution; agent?: InspirationAgent; onOpen: () => void;
}) {
  const { t } = useTranslation();
  const element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!element.current) return;
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)));
    observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  const { activity, error, live } = useInspirationActivity(ideaId, execution, visible);
  useEffect(() => {
    if (!visible || !live) return;
    setNow(Date.now());
    const timer = window.setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 1000);
    return () => window.clearInterval(timer);
  }, [visible, live, execution.runId]);
  const step = useMemo(() => latestInspirationStep(activity?.trajectory.parts || [], live), [activity, live]);
  const tone = inspirationRunTone(execution);
  const expired = execution.attention?.request.expiresAt != null && execution.attention.request.expiresAt <= now;
  const name = agent?.name || execution.agentId;
  const status = t(`inspiration.status.${execution.status === 'canceled' ? 'failed' : execution.status}`);
  let detail = '';
  if (step?.kind === 'tool') {
    detail = toolActivityTitle(step.toolName, step.args, t);
    if (step.status === 'error' || step.isError) detail += ` · ${t('turnLab.failed')}`;
  } else if (step?.kind === 'plan') {
    detail = step.planEntries?.find(entry => entry.status === 'in_progress')?.content
      || step.planEntries?.at(-1)?.content || t('turnLab.stepPlan');
  } else detail = oneLine(step?.text);
  const needsAttention = tone === 'attention';
  const waitingForInput = execution.attention?.active ? execution.attention.request.kind === 'user_input' : execution.status === 'waiting_input';
  const line = expired && needsAttention ? t('inspiration.expired') : needsAttention ? t(waitingForInput
    ? 'inspiration.status.waiting_input' : 'inspiration.status.waiting_approval')
    : tone === 'error' ? status
      : error ? t('inspiration.activityUnavailable') : detail || status;
  const label = tone === 'running' ? line : `${name} · ${line}`;
  const seconds = Math.max(0, Math.floor(((execution.finishedAt ?? now) - execution.createdAt) / 1000));
  const elapsed = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;
  return <div ref={element} className={styles.root} data-inspiration-run-bar data-tone={tone} data-card-interactive>
    <button type="button" className={styles.header} data-inspiration-run-header
      aria-label={label} aria-haspopup="dialog" title={label} onClick={onOpen}>
      <AgentAvatarView agentId={execution.agentId} name={name} className={styles.avatar} />
      {tone !== 'running' && <span className={styles.name}>{name}</span>}
      <span className={styles.line} role="status" aria-live="polite" aria-atomic="true">{line}</span>
      {tone === 'running' && <span className={styles.elapsed}>{elapsed}</span>}
    </button>
  </div>;
}
