import AgentAvatarView from "../components/AgentAvatar";
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { getIdleInspirationAgents } from '../api/client';
import type { InspirationAgent } from '../types';
import styles from './InspirationAgentChatter.module.css';

const agentKey = (agent: InspirationAgent) => JSON.stringify([agent.backendId, agent.id]);
const gap = () => 12000 + Math.random() * 12000;
type Speech = { agent: InspirationAgent; line: number; leaving: boolean };

export default function InspirationAgentChatter({ paused = false }: { paused?: boolean }) {
  const { t } = useTranslation();
  const presetLines = t('inspiration.chatter.lines', { returnObjects: true });
  const lineCount = Array.isArray(presetLines) ? presetLines.length : 0;
  const [speech, setSpeech] = useState<Speech | null>(null);
  const dismiss = useRef<() => void>(() => {});
  const previous = useRef({ agent: '', line: -1 });

  useEffect(() => {
    setSpeech(null);
    if (paused || !lineCount) return;
    let mounted = true;
    let timer: number | undefined;
    let checkTimer: number | undefined;
    let request: AbortController | undefined;
    let current: InspirationAgent | null = null;
    let epoch = 0;
    const clear = () => {
      epoch++;
      window.clearTimeout(timer);
      window.clearTimeout(checkTimer);
      request?.abort();
    };
    const readIdle = async () => {
      const controller = new AbortController();
      request = controller;
      try {
        const { agents } = await getIdleInspirationAgents(AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]));
        return mounted && !document.hidden && !controller.signal.aborted ? agents : null;
      } catch { return null; }
    };
    const hide = (delay = gap()) => {
      if (!current) return;
      clear();
      current = null;
      setSpeech((value) => value ? { ...value, leaving: true } : null);
      // The next speaker is scheduled only after the exit has finished.
      timer = window.setTimeout(() => {
        setSpeech(null);
        timer = window.setTimeout(() => { void show(); }, delay);
      }, 220);
    };
    const show = async () => {
      if (!mounted || document.hidden) return;
      const started = epoch;
      const agents = await readIdle();
      if (!mounted || document.hidden || started !== epoch) return;
      if (!agents?.length) {
        timer = window.setTimeout(() => { void show(); }, gap());
        return;
      }
      const others = agents.filter((agent) => agentKey(agent) !== previous.current.agent);
      const candidates = others.length ? others : agents;
      const agent = candidates[Math.floor(Math.random() * candidates.length)];
      const lines = Array.from({ length: lineCount }, (_, line) => line)
        .filter(line => lineCount === 1 || line !== previous.current.line);
      const line = lines[Math.floor(Math.random() * lines.length)];
      current = agent;
      previous.current = { agent: agentKey(agent), line };
      setSpeech({ agent, line, leaving: false });
      timer = window.setTimeout(() => hide(), 10000);
      // Withdraw the greeting if the speaker starts work while it is visible.
      const checkIdle = async () => {
        const idle = await readIdle();
        if (!mounted || current !== agent) return;
        if (!idle?.some((value) => agentKey(value) === agentKey(agent))) hide();
        else checkTimer = window.setTimeout(() => { void checkIdle(); }, 3000);
      };
      checkTimer = window.setTimeout(() => { void checkIdle(); }, 3000);
    };
    const visibility = () => {
      clear();
      current = null;
      setSpeech(null);
      if (!document.hidden) timer = window.setTimeout(() => { void show(); }, 3000);
    };
    dismiss.current = () => hide(60000);
    if (!document.hidden) timer = window.setTimeout(() => { void show(); }, 2500 + Math.random() * 1500);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      mounted = false;
      clear();
      dismiss.current = () => {};
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [paused, lineCount]);

  if (!speech || paused) return null;
  const { agent, line, leaving } = speech;
  return createPortal(<aside className={styles.chatter} data-inspiration-chatter data-agent={agentKey(agent)}
    data-leaving={leaving || undefined} aria-label={t('inspiration.chatter.label')}>
    <AgentAvatarView agentId={agent.id} name={agent.name} className={styles.avatar}
      fallback={Array.from(agent.name).slice(0, 2).join('').toUpperCase()} />
    <div className={styles.bubble} data-inspiration-chatter-bubble>
      <div className={styles.byline}><strong>{agent.name}</strong></div>
      <p>{t(`inspiration.chatter.lines.${line}`)}</p>
      <button type="button" className={styles.close} aria-label={t('inspiration.chatter.dismiss')}
        title={t('inspiration.chatter.dismiss')} onClick={() => dismiss.current()}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
      </button>
    </div>
  </aside>, document.body);
}
