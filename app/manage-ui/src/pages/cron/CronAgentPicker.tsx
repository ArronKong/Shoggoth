import AgentAvatarView from "../../components/AgentAvatar";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Popover } from "@base-ui/react/popover";
import { Tabs } from "@base-ui/react/tabs";
import BackendTabIcon, { sortBackendTabs } from "../../components/BackendTabIcon";
import type { BackendDescriptor, UnifiedAgent } from "../../types";
import { cronAgentAvailable } from "./cronCreateDraft";
import styles from "./CronAgentPicker.module.css";

type Assistant = { backendId: string; agentId: string };
type AssistantIdentity = Pick<UnifiedAgent, "id" | "name">;

function AgentAvatar({ agent }: { agent: AssistantIdentity }) {
  return <AgentAvatarView agentId={agent.id} name={agent.name} className={styles.avatar}
    fallback={Array.from(agent.name || agent.id).slice(0, 2).join("").toUpperCase()} />;
}

function assistantLabel(agent: AssistantIdentity, backendName: string) {
  return `${agent.name || agent.id} · ${backendName}`;
}

export function CronAssignedAgent({ agentId, agentName, backendName, noAgent }: {
  agentId?: string;
  agentName?: string;
  backendName: string;
  noAgent?: boolean;
}) {
  const { t } = useTranslation();
  const agent = !noAgent && agentId ? { id: agentId, name: agentName || agentId } : undefined;
  const label = agent ? assistantLabel(agent, backendName) : t(noAgent ? "cronForm.agentNotUsed" : "cronForm.agentUnspecified");
  return <div className="field">
    <span className="field-label">{t("cron.agentLabel")}</span>
    <div className={`field-input ${styles.control}`} title={label}>
      {agent && <AgentAvatar agent={agent} />}
      <span className={agent ? styles.value : styles.placeholder}>{label}</span>
    </div>
  </div>;
}

// Selecting a row commits one assistant and closes the popup immediately.
export default function CronAgentPicker({ value, onChange, backends, agents, loading, failedBackends, onRetry, disabled }: {
  value: Assistant;
  onChange: (value: Assistant) => void;
  backends: BackendDescriptor[];
  agents: Record<string, UnifiedAgent[]>;
  loading: boolean;
  failedBackends: string[];
  onRetry: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const labelId = useId();
  const [open, setOpen] = useState(false);
  const [backend, setBackend] = useState("");
  const runtimes = sortBackendTabs(backends);
  const activeBackend = runtimes.some((item) => item.id === backend) ? backend : runtimes[0]?.id || "";
  const selected = backends.some((item) => item.id === value.backendId)
    ? agents[value.backendId]?.find((agent) => agent.id === value.agentId) : undefined;
  const backendName = (id: string) => backends.find((item) => item.id === id)?.name || id;
  const selectedLabel = selected ? assistantLabel(selected, backendName(value.backendId)) : t("cronForm.agentPlaceholder");

  return <div className="field">
    <span id={labelId} className="field-label">{t("cron.agentLabel")} <span className={styles.required} aria-hidden="true">*</span></span>
    <Popover.Root open={open && !disabled} onOpenChange={(next) => {
      if (disabled) return;
      if (next) setBackend(value.backendId || runtimes.find((item) => agents[item.id]?.some(cronAgentAvailable))?.id || "");
      setOpen(next);
    }}>
      <Popover.Trigger type="button" className={`field-input ${styles.control} ${styles.trigger}`} disabled={disabled}
        aria-label={`${t("cronForm.agentRequiredLabel")} · ${selectedLabel}`}>
        {selected && <AgentAvatar agent={selected} />}
        <span className={selected ? styles.value : styles.placeholder}>{selectedLabel}</span>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className={styles.positioner} side="bottom" sideOffset={8} align="start" collisionPadding={12}>
          <Popover.Popup className={styles.popup} aria-labelledby={labelId}>
            <Tabs.Root value={activeBackend} onValueChange={(next) => setBackend(String(next))}>
              {runtimes.length > 1 && <Tabs.List className={styles.runtimes} aria-label={t("inspiration.growth.filterBackend")}>
                {runtimes.map((runtime) => <Tabs.Tab key={runtime.id} value={runtime.id}
                  className={styles.runtime} aria-label={runtime.name} title={runtime.name}>
                  <BackendTabIcon backend={runtime.id} label={runtime.name} />
                </Tabs.Tab>)}
              </Tabs.List>}
              {runtimes.map((runtime) => <Tabs.Panel key={runtime.id} value={runtime.id}>
                <div className={styles.agents} role="group" aria-label={t("cronForm.agentRequiredLabel")}>
                  {(agents[runtime.id] || []).map((agent) => {
                    const checked = value.backendId === runtime.id && value.agentId === agent.id;
                    const available = cronAgentAvailable(agent);
                    const name = assistantLabel(agent, runtime.name);
                    const label = available ? name : `${name} · ${t("inspiration.unavailable")}`;
                    return <button key={agent.id} type="button" className={styles.agent}
                      aria-pressed={checked} aria-label={label} title={label} disabled={!available}
                      onClick={() => { onChange({ backendId: runtime.id, agentId: agent.id }); setOpen(false); }}>
                      <AgentAvatar agent={agent} />
                      <span className={styles.agentName}>{name}</span>
                      {checked && <span className={styles.check} aria-hidden="true" />}
                    </button>;
                  })}
                  {failedBackends.includes(runtime.id) ? <div className={styles.empty} role="status">
                    {t("cronForm.agentsLoadFailed")}
                    <button type="button" className={styles.retry} disabled={loading} onClick={onRetry}>{t("common.retry")}</button>
                  </div> : !agents[runtime.id]?.length && <p className={styles.empty} role="status">
                    {t(loading ? "common.loading" : "inspiration.growth.noBackendAgents")}
                  </p>}
                </div>
              </Tabs.Panel>)}
              {runtimes.length === 0 && <p className={styles.empty} role="status">{t("cronForm.filtersNoAgents")}</p>}
            </Tabs.Root>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  </div>;
}
