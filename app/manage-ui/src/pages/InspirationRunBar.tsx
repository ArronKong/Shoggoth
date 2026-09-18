import AgentAvatarView from "../components/AgentAvatar";
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { InspirationAgent, InspirationExecution } from '../types';
import { summarizeArgs, toolLabelKey } from '../lib/turnTimeline';
import { useInspirationActivity } from './use-inspiration-activity';
import { inspirationRunTone, latestInspirationStep } from './inspiration-run-status';
import styles from './InspirationRunBar.module.css';

const oneLine = (text?: string) => text?.replace(/\s+/gu, ' ').trim() || '';

export default function InspirationRunBar({ ideaId, execution, agent, attention, onOpen }: {
  ideaId: string; execution: InspirationExecution; agent?: InspirationAgent; attention: ReactNode; onOpen: () => void;
}) {
  const { t } = useTranslation();
  const element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
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
  useEffect(() => { setHovered(false); setFocused(false); setPinned(false); }, [execution.runId, execution.attention?.request.requestId]);
  const step = useMemo(() => latestInspirationStep(activity?.trajectory.parts || [], live), [activity, live]);
  const tone = inspirationRunTone(execution);
  const expired = execution.attention?.request.expiresAt != null && execution.attention.request.expiresAt <= now;
  const expandable = Boolean(execution.attention?.active && !expired);
  const expanded = expandable && (hovered || focused || pinned);
  const name = agent?.name || execution.agentId;
  const status = t(`inspiration.status.${execution.status === 'canceled' ? 'failed' : execution.status}`);
  let detail = '';
  if (step?.kind === 'tool') {
    const tool = t(toolLabelKey(step.toolName || 'tool'), { defaultValue: '' }) || step.toolName;
    detail = [tool, oneLine(step.output) || summarizeArgs(step.toolName, step.args)].filter(Boolean).join(' · ');
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
  const panelId = `inspiration-attention-${execution.id}`;
  return <div ref={element} className={styles.root} data-inspiration-run-bar data-tone={tone} data-expanded={expanded}
    data-card-interactive onPointerEnter={event => { if (event.pointerType === 'mouse') setHovered(true); }}
    onPointerLeave={() => setHovered(false)}
    onFocus={event => { if (event.target.matches(':focus-visible')) setFocused(true); }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { setFocused(false); setPinned(false); } }}
    onKeyDown={event => { if (event.key === 'Escape') {
      event.stopPropagation(); element.current?.querySelector('button')?.focus();
      setHovered(false); setFocused(false); setPinned(false);
    } }}>
    <button type="button" className={styles.header} data-inspiration-run-header
      aria-label={label} aria-expanded={expandable ? expanded : undefined}
      aria-controls={expandable ? panelId : undefined} title={label}
      onClick={() => { if (expandable) setPinned(value => !value); else onOpen(); }}>
      <AgentAvatarView agentId={execution.agentId} name={name} className={styles.avatar} />
      {tone !== 'running' && <span className={styles.name}>{name}</span>}
      <span className={styles.line} role="status" aria-live="polite" aria-atomic="true">{line}</span>
      {tone === 'running' && <span className={styles.elapsed}>{elapsed}</span>}
    </button>
    {expandable && <div id={panelId} className={styles.expansion} hidden={!expanded} data-inspiration-run-attention
      data-approval={execution.attention?.request.fields.length === 0}>{attention}</div>}
  </div>;
}
