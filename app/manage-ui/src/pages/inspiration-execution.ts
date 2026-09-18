import type { InspirationAgent, InspirationIdea } from '../types';

const ACTIVE = new Set(['queued', 'starting', 'running', 'waiting_input', 'waiting_approval', 'unknown']);

export function canStartInspiration(idea: InspirationIdea) {
  return idea.archivedAt === null && !ACTIVE.has(idea.status);
}

export function defaultInspirationAgent(agents: InspirationAgent[], idea?: InspirationIdea) {
  return agents.find(agent => agent.capabilities.execute && agent.id === idea?.latestExecution?.agentId
    && agent.backendId === idea.latestExecution.backendId) || agents.find(agent => agent.capabilities.execute);
}

export function inspirationStartFields(idea: InspirationIdea, agent: InspirationAgent) {
  const external = agent.backendId === 'openclaw' || agent.backendId === 'hermes';
  return { expectedRevision: idea.revision, agentId: agent.id, backendId: agent.backendId, instruction: '',
    workspace: !external && agent.id === idea.latestExecution?.agentId && agent.backendId === idea.latestExecution.backendId
      ? idea.latestExecution.workspace : null };
}
