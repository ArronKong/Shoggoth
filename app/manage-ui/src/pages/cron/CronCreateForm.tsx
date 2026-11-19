import type { Dispatch, SetStateAction } from "react";
import type { BackendDescriptor, UnifiedAgent } from "../../types";
import CronAgentPicker from "./CronAgentPicker";
import { CronScheduleField, CronTaskNameRow, CronTaskPromptField } from "./CronFormLayout";
import { CronTaskModelField } from "./CronModelPicker";
import type { CronCreateDraft } from "./cronCreateDraft";

export default function CronCreateForm({ draft, setDraft, backends, agents, loading, failedBackends, onRetry, disabled }: {
  draft: CronCreateDraft;
  setDraft: Dispatch<SetStateAction<CronCreateDraft>>;
  backends: BackendDescriptor[];
  agents: Record<string, UnifiedAgent[]>;
  loading: boolean;
  failedBackends: string[];
  onRetry: () => void;
  disabled: boolean;
}) {
  const set = <K extends keyof CronCreateDraft>(key: K, value: CronCreateDraft[K]) => setDraft(current => ({ ...current, [key]: value }));
  const kind = backends.find((backend) => backend.id === draft.backendId)?.surfaces.cron?.kind;
  const minInterval = kind === "openclaw" ? 1 / 60 : 1;
  const agentModel = agents[draft.backendId]?.find((agent) => agent.id === draft.agentId)?.model;
  return <div className="cron-form">
    <CronTaskNameRow name={draft.name} onChange={(name) => set("name", name)} />
    <CronTaskPromptField value={draft.prompt} onChange={(prompt) => set("prompt", prompt)} required />
    <div className="field-row">
      <CronAgentPicker value={draft} onChange={(assistant) => setDraft(current => (
        assistant.backendId === current.backendId && assistant.agentId === current.agentId
          ? current : { ...current, ...assistant, taskModel: null }
      ))} backends={backends} agents={agents} loading={loading} failedBackends={failedBackends} onRetry={onRetry} disabled={disabled} />
      <CronTaskModelField backendId={draft.backendId} agentId={draft.agentId} kind={kind} value={draft.taskModel}
        defaultModelHint={agentModel} onChange={(value) => set("taskModel", value)} disabled={disabled} />
    </div>
    <CronScheduleField draft={draft} onChange={(patch) => setDraft(current => ({ ...current, ...patch }))} minInterval={minInterval} />
  </div>;
}
