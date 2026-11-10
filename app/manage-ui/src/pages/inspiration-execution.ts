import type { InspirationAgent, InspirationIdea, InspirationModels } from '../types';

const ACTIVE = new Set(['queued', 'starting', 'running', 'waiting_input', 'waiting_approval', 'unknown']);

export function canStartInspiration(idea: InspirationIdea) {
  return idea.archivedAt === null && !ACTIVE.has(idea.status);
}

export function defaultInspirationAgent(agents: InspirationAgent[], idea?: InspirationIdea) {
  return agents.find(agent => agent.capabilities.execute && agent.id === idea?.latestExecution?.agentId
    && agent.backendId === idea.latestExecution.backendId) || agents.find(agent => agent.capabilities.execute);
}

export function defaultInspirationModel(data?: InspirationModels): InspirationModels['models'][number] | undefined {
  if (!data) return undefined;
  const { defaultModel, defaultBindingId, defaultProvider, models } = data;
  if (defaultBindingId) {
    return models.find(model => 'bindingId' in model && model.bindingId === defaultBindingId && !model.modelProviderRef
      && (defaultModel ? model.id === defaultModel : model.isDefault));
  }
  if (!defaultModel) return undefined;
  const sameId = models.filter(model => model.id === defaultModel);
  const qualified = models.find(model => model.provider && (!defaultProvider || model.provider === defaultProvider)
    && `${model.provider}/${model.id}` === defaultModel);
  if (defaultProvider) return sameId.find(model => model.provider === defaultProvider) ?? qualified;
  return qualified ?? (sameId.length === 1 ? sameId[0] : undefined);
}

export function inspirationStartFields(idea: InspirationIdea, agent: InspirationAgent, instruction = '') {
  const external = agent.backendId === 'openclaw' || agent.backendId === 'hermes';
  const sameAgent = agent.id === idea.latestExecution?.agentId && agent.backendId === idea.latestExecution.backendId;
  return { expectedRevision: idea.revision, agentId: agent.id, backendId: agent.backendId, instruction,
    workspace: !external && sameAgent ? idea.latestExecution!.workspace : null };
}
