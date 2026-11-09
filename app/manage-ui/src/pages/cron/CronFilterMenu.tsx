import { useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import type { CronAgentScope } from "../../api/client";
import AgentAvatar from "../../components/AgentAvatar";
import BackendTabIcon, { sortBackendTabs } from "../../components/BackendTabIcon";
import LiquidPill from "../../components/LiquidPill";
import { useScrollFade } from "../../lib/useScrollFade";
import type { BackendDescriptor, UnifiedAgent } from "../../types";
import { IconAgent } from "./cronIcons";
import styles from "./CronFilterMenu.module.css";

function TriggerContent({ icon, text, count = 0 }: { icon: ReactNode; text: string; count?: number }) {
  return <>
    <span className={styles.icon}>{icon}</span>
    <span className={styles.text}>{text}</span>
    {count > 1 && <span className={styles.count}>{count}</span>}
  </>;
}

const sameAgent = (a: CronAgentScope, b: CronAgentScope) => a.backendId === b.backendId && a.agentId === b.agentId;

export function CronAgentFilter({ backends, agents, value, legacyAgentIds, onChange }: {
  backends: BackendDescriptor[];
  agents: Record<string, UnifiedAgent[]>;
  value?: CronAgentScope[];
  legacyAgentIds?: string[];
  onChange: (value: CronAgentScope[]) => void;
}) {
  const { t } = useTranslation();
  const label = t("cronForm.filtersAgent");
  const popupRef = useRef<HTMLDivElement>(null);
  const [backend, setBackend] = useState("");
  const groups = useMemo(() => sortBackendTabs(backends).flatMap(({ id, name }) => {
    const names = new Map<string, string>();
    for (const agent of agents[id] ?? []) {
      if (!names.has(agent.id)) names.set(agent.id, agent.name || agent.id);
    }
    const options = Array.from(names, ([agentId, label]) => ({ scope: { backendId: id, agentId }, label }));
    return options.length ? [{ id, name, options }] : [];
  }), [backends, agents]);
  const activeGroup = groups.find((group) => group.id === backend) ?? groups[0];
  const hasBackendTabs = groups.length > 1;
  const scrollFade = useScrollFade(true, (activeGroup?.options.length ?? 0) + Number(!hasBackendTabs), activeGroup?.id);
  const options = groups.flatMap((group) => group.options);
  const selected = value ?? options.filter(({ scope }) => legacyAgentIds?.includes(scope.agentId)).map(({ scope }) => scope);
  const isSelected = (scope: CronAgentScope) => selected.some((item) => sameAgent(item, scope));
  const checkedOptions = options.filter(({ scope }) => isSelected(scope));
  const allChecked = options.length > 0 && checkedOptions.length === options.length;
  const triggerText = checkedOptions.length === 1 ? checkedOptions[0].label : label;
  const selectAll = (
    <button type="button" role="checkbox" aria-checked={allChecked}
      className={hasBackendTabs ? `${styles.item} ${styles.headerSelectAll}` : styles.item}
      onClick={() => onChange(allChecked ? [] : options.map(({ scope }) => scope))}>
      <span className={styles.itemText}>{t("cronForm.filtersSelectAllAgents")}</span>
      {allChecked && <span className={styles.indicator} aria-hidden="true" />}
    </button>
  );

  return (
    <Popover.Root modal>
      <Popover.Trigger className={styles.trigger}>
        <TriggerContent icon={<IconAgent />} text={triggerText} count={checkedOptions.length} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className={styles.positioner} sideOffset={6} align="start" collisionPadding={14}>
          <Popover.Popup ref={popupRef} initialFocus={popupRef} className={styles.popup} data-agent-picker aria-label={label}>
            {activeGroup && hasBackendTabs && (
              <div className={styles.backendHeader}>
                <div className={styles.backendTabs} role="group" aria-label={t("cronForm.filtersBackend")}>
                  <LiquidPill key={JSON.stringify(groups.map(({ id }) => id))} value={activeGroup.id}
                    activeSelector='[aria-pressed="true"]' className={styles.backendPill} />
                  {groups.map(({ id, name }) => (
                    <button key={id} type="button" className={styles.backendTab} aria-label={name} title={name}
                      aria-pressed={activeGroup.id === id} onClick={() => setBackend(id)}>
                      <BackendTabIcon backend={id} label={name} />
                    </button>
                  ))}
                </div>
                {selectAll}
              </div>
            )}
            {activeGroup ? (
              <div key={activeGroup.id} className={`${styles.options} ${styles.agentOptions}`}
                role="group" aria-label={activeGroup.name} {...scrollFade}>
                {!hasBackendTabs && selectAll}
                {activeGroup.options.map(({ scope, label }) => {
                  const checked = isSelected(scope);
                  return (
                    <button key={scope.agentId} type="button" role="checkbox" className={styles.item} aria-checked={checked}
                      onClick={() => onChange(checked ? selected.filter((item) => !sameAgent(item, scope)) : [...selected, scope])}>
                      <AgentAvatar agentId={scope.agentId} className={styles.avatar} loading="lazy" />
                      <span className={styles.itemText} title={label}>{label}</span>
                      {checked && <span className={styles.indicator} aria-hidden="true" />}
                    </button>
                  );
                })}
              </div>
            ) : <div className={styles.empty}>{t("cronForm.filtersNoAgents")}</div>}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export default function CronFilterMenu({ icon, label, options, value, onChange }: {
  icon: ReactNode;
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  const selected = value !== "all" ? options.find((option) => option.value === value) : undefined;
  return (
    <Menu.Root>
      <Menu.Trigger className={styles.trigger}>
        <TriggerContent icon={icon} text={selected?.label ?? label} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className={styles.positioner} sideOffset={6} align="start" collisionPadding={14}>
          <Menu.Popup className={styles.popup}>
            <Menu.RadioGroup className={styles.options} value={value} onValueChange={(v) => onChange(String(v))}>
              {options.map((option) => (
                <Menu.RadioItem key={option.value} className={styles.item} value={option.value} closeOnClick>
                  <span className={styles.itemText}>{option.label}</span>
                  <Menu.RadioItemIndicator className={styles.indicator} aria-hidden="true" />
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
