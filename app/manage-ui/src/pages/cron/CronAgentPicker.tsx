import AgentAvatarView from "../../components/AgentAvatar";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Popover } from "@base-ui/react/popover";
import { Tabs } from "@base-ui/react/tabs";
import type { BackendDescriptor, UnifiedAgent } from "../../types";
import { cronAgentAvailable } from "./cronCreateDraft";
import styles from "./CronAgentPicker.module.css";

type Assistant = { backendId: string; agentId: string };
const RUNTIME_ORDER = ["shoggoth", "hermes", "codex", "claude-code", "grok-build", "deepseek-harness"];

function AgentAvatar({ agent }: { agent: UnifiedAgent }) {
  return <AgentAvatarView agentId={agent.id} name={agent.name} className={styles.avatar}
    fallback={Array.from(agent.name || agent.id).slice(0, 2).join("").toUpperCase()} />;
}

// Reuse the automation picker's runtime glyphs, avatars and list styling.
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
  const runtimes = [...backends].sort((a, b) =>
    (RUNTIME_ORDER.indexOf(a.id) < 0 ? 99 : RUNTIME_ORDER.indexOf(a.id))
    - (RUNTIME_ORDER.indexOf(b.id) < 0 ? 99 : RUNTIME_ORDER.indexOf(b.id)));
  const activeBackend = runtimes.some((item) => item.id === backend) ? backend : runtimes[0]?.id || "";
  const selected = backends.some((item) => item.id === value.backendId)
    ? agents[value.backendId]?.find((agent) => agent.id === value.agentId) : undefined;
  const backendName = (id: string) => backends.find((item) => item.id === id)?.name || id;
  const selectedLabel = selected ? `${selected.name || selected.id} · ${backendName(value.backendId)}` : t("cronForm.agentPlaceholder");

  return <div className="field">
    <span id={labelId} className="field-label">{t("cron.agentLabel")} <span className={styles.required} aria-hidden="true">*</span></span>
    <Popover.Root open={open && !disabled} onOpenChange={(next) => {
      if (disabled) return;
      if (next) setBackend(value.backendId || runtimes.find((item) => agents[item.id]?.some(cronAgentAvailable))?.id || "");
      setOpen(next);
    }}>
      <Popover.Trigger type="button" className={`field-input ${styles.trigger}`} disabled={disabled}
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
                  className={styles.runtime} data-runtime={runtime.id} aria-label={runtime.name} title={runtime.name}>
                  {RUNTIME_ORDER.includes(runtime.id) ? <span className={styles.glyph} aria-hidden="true" />
                    : <span className={styles.runtimeName}>{runtime.name}</span>}
                </Tabs.Tab>)}
              </Tabs.List>}
              {runtimes.map((runtime) => <Tabs.Panel key={runtime.id} value={runtime.id}>
                <div className={styles.agents} role="group" aria-label={t("cronForm.agentRequiredLabel")}>
                  {(agents[runtime.id] || []).map((agent) => {
                    const checked = value.backendId === runtime.id && value.agentId === agent.id;
                    const available = cronAgentAvailable(agent);
                    const label = `${agent.name || agent.id} · ${runtime.name}${available ? "" : ` · ${t("inspiration.unavailable")}`}`;
                    return <button key={agent.id} type="button" className={styles.agent}
                      aria-pressed={checked} aria-label={label} title={label} disabled={!available}
                      onClick={() => { onChange({ backendId: runtime.id, agentId: agent.id }); setOpen(false); }}>
                      <AgentAvatar agent={agent} />
                      <span className={styles.agentName}>{agent.name || agent.id} · {runtime.name}</span>
                      {checked && <span className={`${styles.glyph} ${styles.check}`} aria-hidden="true" />}
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
