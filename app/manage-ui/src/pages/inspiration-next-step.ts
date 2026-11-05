import { useSyncExternalStore } from 'react';
import { ApiError, getInspiration, startInspiration } from '../api/client';
import type { InspirationIdea, InspirationStartInput } from '../types';
import { canStartInspiration } from './inspiration-execution';

type StepInput = Pick<InspirationStartInput, 'agentId' | 'backendId' | 'instruction' | 'workspace'>;
type StepStatus = 'waiting' | 'sending' | 'paused' | 'uncertain';
type Step = StepInput & { status: StepStatus };
type Entry = {
  step: Step;
  afterRunId: string;
  operationId: string;
  timer?: ReturnType<typeof setTimeout>;
};

// A queued step belongs to this renderer, including while its dialog is closed.
// The predecessor and the instruction are fixed at the user's Enter gesture.
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const publish = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

function setStatus(entry: Entry, status: StepStatus) {
  entry.step = { ...entry.step, status };
  publish();
}

function schedule(id: string, entry: Entry) {
  entry.timer = setTimeout(() => { void check(id, entry); }, 3000);
}

async function check(id: string, entry: Entry) {
  let idea: InspirationIdea;
  try {
    ({ idea } = await getInspiration(id, AbortSignal.timeout(10000)));
  } catch (error) {
    if (entries.get(id) !== entry) return;
    if (error instanceof ApiError && error.status === 404) setStatus(entry, 'paused');
    else schedule(id, entry);
    return;
  }
  if (entries.get(id) !== entry) return;
  if (idea.archivedAt !== null || idea.latestExecution?.runId !== entry.afterRunId) {
    setStatus(entry, 'paused');
    return;
  }
  if (!canStartInspiration(idea)) {
    schedule(id, entry);
    return;
  }
  if (idea.status !== 'completed' || idea.latestExecution.status !== 'completed') {
    setStatus(entry, 'paused');
    return;
  }
  const { agentId, backendId, workspace, instruction } = entry.step;
  setStatus(entry, 'sending');
  try {
    await startInspiration(id, { agentId, backendId, workspace, instruction,
      expectedRevision: idea.revision, operationId: entry.operationId });
  } catch (error) {
    // Only known pre-admission failures are safe to turn back into a draft.
    const rejected = error instanceof ApiError && ['INSPIRATION_REVISION_CONFLICT',
      'INSPIRATION_ARCHIVED', 'INSPIRATION_BUSY', 'INSPIRATION_NOT_FOUND', 'INSPIRATION_INVALID',
    ].includes(error.code ?? '');
    setStatus(entry, rejected ? 'paused' : 'uncertain');
    return;
  }
  entries.delete(id);
  publish();
}

export function queueInspirationStep(id: string, afterRunId: string, { agentId, backendId, instruction, workspace }: StepInput) {
  if (entries.has(id)) return false;
  const entry: Entry = { step: { agentId, backendId, instruction, workspace, status: 'waiting' },
    afterRunId, operationId: crypto.randomUUID() };
  entries.set(id, entry);
  publish();
  void check(id, entry);
  return true;
}

export function clearQueuedInspirationStep(id: string) {
  const entry = entries.get(id);
  if (!entry || entry.step.status === 'sending') return;
  clearTimeout(entry.timer);
  entries.delete(id);
  publish();
}

export function useQueuedInspirationStep(id: string) {
  return useSyncExternalStore(subscribe, () => entries.get(id)?.step ?? null);
}
