import AgentAvatarView from "../components/AgentAvatar";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { getInspirationAgentDock } from '../api/client';
import type { InspirationDockAgent } from '../types';
import type { InspirationDropTarget } from './inspiration-card-drag';
import styles from './InspirationAgentDock.module.css';

export interface InspirationAgentDockHandle {
  prepare: () => void;
  targets: () => InspirationDropTarget[];
  scrollElement: () => HTMLElement | null;
}
const identity = (agent: InspirationDockAgent) => JSON.stringify([agent.backendId, agent.id]);

// `onPick` opens the same dock for a click choice (a card's send button) instead of a drop.
export default forwardRef<InspirationAgentDockHandle, { active: boolean; onPick?: (agent: InspirationDockAgent) => void;
  onCancel?: () => void }>(function InspirationAgentDock({ active, onPick, onCancel }, ref) {
  const { t } = useTranslation();
  const track = useRef<HTMLDivElement>(null);
  const cached = useRef<InspirationDockAgent[] | null>(null);
  const current = useRef<InspirationDockAgent[] | null>(null);
  const held = useRef(active); held.current = active;
  const request = useRef<AbortController | null>(null);
  const [agents, setAgents] = useState<InspirationDockAgent[] | null>(null);
  const byIdentity = useMemo(() => new Map((agents ?? []).map(agent => [identity(agent), agent])), [agents]);
  const [failed, setFailed] = useState(false);
  const prepare = useCallback(() => {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller;
    setFailed(false);
    void getInspirationAgentDock(AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]))
      .then(result => {
        if (controller.signal.aborted) return;
        cached.current = result.agents;
        // Once targets are visible, preserve their identities and positions until
        // release. New counts/roster changes take effect on the next pickup.
        if (held.current && current.current === null) {
          current.current = result.agents; setAgents(result.agents);
        }
      }).catch(() => { if (!controller.signal.aborted) setFailed(true); })
      .finally(() => { if (request.current === controller) request.current = null; });
  }, []);
  useEffect(() => {
    prepare();
    return () => { request.current?.abort(); request.current = null; };
  }, [prepare]);
  useLayoutEffect(() => {
    current.current = active ? cached.current : null;
    setAgents(current.current);
    if (track.current) track.current.scrollLeft = 0;
  }, [active]);
  useImperativeHandle(ref, () => ({
    prepare,
    scrollElement: () => track.current,
    targets: () => [...(track.current?.querySelectorAll<HTMLElement>('[data-inspiration-agent-target]') ?? [])]
      .flatMap(element => {
        const agent = byIdentity.get(element.dataset.inspirationAgentTarget!);
        return agent?.capabilities.execute ? [{ element, agent,
          hint: element.querySelector<HTMLElement>('[data-inspiration-drop-hint]') }] : [];
      }),
  }), [prepare, byIdentity]);

  useEffect(() => {
    if (!active || !onCancel) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [active, onCancel]);

  if (!active) return null;
  const picking = Boolean(onPick);
  const labelOf = (agent: InspirationDockAgent) => `${agent.name}${agent.capabilities.execute ? ''
    : ` · ${t(agent.capabilities.reason === 'backend-unavailable' ? 'inspiration.unavailable' : 'inspiration.unsupported')}`}`;
  return createPortal(<>
    {picking && <div className={styles.scrim} aria-hidden="true" onClick={onCancel} />}
    <aside className={styles.dock} data-inspiration-agent-dock data-picking={picking || undefined} aria-label={t('inspiration.agentDock.label')}>
    <div className={styles.track} ref={track} data-inspiration-agent-scroll role="list" aria-label={t('inspiration.agentDock.label')}>
      {agents?.map(agent => {
        const face = <>
          <AgentAvatarView agentId={agent.id} name={agent.name} className={styles.avatar}
            fallback={Array.from(agent.name).slice(0, 2).join('').toUpperCase()} />
          <span className={styles.name}>{agent.name}</span>
        </>;
        return <div key={identity(agent)} role="listitem" className={styles.agent}
          data-inspiration-agent-target={identity(agent)} aria-disabled={!agent.capabilities.execute || undefined}
          aria-label={picking ? undefined : labelOf(agent)}
          title={`${agent.name} · ${t('inspiration.agentDock.executions', { count: agent.executionCount })}`}>
          {picking ? <button type="button" className={styles.pick} disabled={!agent.capabilities.execute}
            aria-label={labelOf(agent)} onClick={() => onPick?.(agent)}>{face}</button> : face}
          <span className={styles.dropHint} data-inspiration-drop-hint role="status">{t('inspiration.agentDock.dropHint')}</span>
        </div>;
      })}
      {(!agents || agents.length === 0) && <p className={styles.empty} role="status">{t(agents ? 'inspiration.noAgent'
        : failed ? 'inspiration.agentDock.failed' : 'inspiration.agentDock.loading')}</p>}
    </div>
    <p className={styles.dragHint} role="status">{t(picking ? 'inspiration.agentDock.pickHint' : 'inspiration.agentDock.dragHint')}</p>
  </aside></>, document.body);
});
