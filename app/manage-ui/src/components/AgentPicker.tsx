import type { CSSProperties } from "react";
import AgentAvatar from "./AgentAvatar";
import BackendTabIcon from "./BackendTabIcon";
import LiquidPill from "./LiquidPill";
import checkMask from "../assets/inspiration/check.svg";
import styles from "./Picker.module.css";

const checkStyle = { "--picker-check-mask": `url(${JSON.stringify(checkMask)})` } as CSSProperties;

export function AgentPickerTabs({ items, value, onChange, label, disabled }: {
  items: readonly { id: string; name: string }[];
  value?: string;
  onChange: (id: string) => void;
  label: string;
  disabled?: boolean;
}) {
  if (items.length < 2) return null;
  return <div className={styles.backendTabs} role="group" aria-label={label}>
    <LiquidPill key={JSON.stringify(items.map(item => item.id))} value={value ?? ""}
      activeSelector='[aria-pressed="true"]' className={styles.backendPill} />
    {items.map(item => <button key={item.id} type="button" className={styles.backendTab}
      aria-label={item.name} title={item.name} aria-pressed={item.id === value}
      data-runtime={item.id} disabled={disabled} onClick={() => onChange(item.id)}>
      <BackendTabIcon backend={item.id} label={item.name} />
    </button>)}
  </div>;
}

export function AgentPickerOption({ agentId, name, label, detail, checked, disabled, onClick }: {
  agentId: string;
  name: string;
  label: string;
  detail?: string;
  checked: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return <button type="button" className={styles.agentOption} role="checkbox" aria-checked={checked}
    aria-label={label} title={label} disabled={disabled} onClick={onClick}>
    <AgentAvatar agentId={agentId} name={name} className={styles.avatar} />
    <span className={styles.label}>{name}</span>
    {detail && <span className={styles.optionDetail}>{detail}</span>}
    {checked && <span className={styles.agentCheck} style={checkStyle} aria-hidden="true" />}
  </button>;
}
