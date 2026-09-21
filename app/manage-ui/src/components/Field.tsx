// Small, unopinionated form primitives shared by the edit/create modals.
// Field/TextInput/TextArea stay native (controlled, styled via .field-* in
// styles.css). Switch + Select are built on base-ui (proper a11y + a styled
// dropdown); their styling is colocated in Field.module.css. Select keeps a
// native-<select>-like API: <Select value onChange><Option value>…</Option>.

import { Children, forwardRef, isValidElement, type ReactNode } from "react";
import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { Select as BaseSelect } from "@base-ui/react/select";
import styles from "./Field.module.css";

export function Field({
  label,
  hint,
  error,
  errorId,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  errorId?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error" id={errorId} role="alert">{error}</span>}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="field-input" {...props} />;
}

// forwardRef：调用方要能拿到真实 <textarea>（看板诊断的「去评论」动作要滚动+聚焦它）。
export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function TextArea(props, ref) {
    return <textarea ref={ref} className="field-textarea" {...props} />;
  },
);

export function Select({
  value,
  onChange,
  children,
  disabled,
  invalid,
  triggerClassName = styles.trigger,
  popupClassName,
  title,
  side = "bottom",
  hideIcon = false,
}: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  disabled?: boolean;
  invalid?: boolean;
  triggerClassName?: string;
  popupClassName?: string;
  title?: string;
  side?: "top" | "bottom";
  hideIcon?: boolean;
}) {
  // Resolve the trigger label from the <Option> children — base-ui's Select.Value
  // shows the raw value otherwise.
  const labels: Record<string, ReactNode> = {};
  Children.toArray(children).forEach((child) => {
    if (isValidElement(child)) {
      const p = child.props as { value?: string; children?: ReactNode };
      if (p.value !== undefined) labels[p.value] = p.children;
    }
  });
  return (
    <BaseSelect.Root
      value={value}
      onValueChange={(v) => onChange((v ?? "") as string)}
      disabled={disabled}
    >
      {/* 仅转发校验语义与视觉状态，不改变选值行为。 */}
      <BaseSelect.Trigger
        className={triggerClassName}
        aria-invalid={invalid || undefined}
        aria-label={title}
        title={title}
      >
        <BaseSelect.Value className={styles.value}>
          {(val) =>
            typeof val === "string" && labels[val] !== undefined ? labels[val] : val
          }
        </BaseSelect.Value>
        {!hideIcon && <BaseSelect.Icon className={styles.icon}>▾</BaseSelect.Icon>}
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner
          className={styles.positioner}
          side={side}
          sideOffset={4}
          alignItemWithTrigger={false}
        >
          <BaseSelect.Popup className={[styles.popup, popupClassName].filter(Boolean).join(" ")}>
            <BaseSelect.List>{children}</BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}

export function Option({ value, children, disabled }: { value: string; children: ReactNode; disabled?: boolean }) {
  return (
    <BaseSelect.Item value={value} className={styles.item} disabled={disabled}>
      <BaseSelect.ItemText>{children}</BaseSelect.ItemText>
      <BaseSelect.ItemIndicator className={styles.indicator}>✓</BaseSelect.ItemIndicator>
    </BaseSelect.Item>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  ariaLabel,
  ariaLabelledBy,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  ariaLabel?: string;
  ariaLabelledBy?: string;
}) {
  return (
    <label className={disabled ? `${styles.switch} ${styles.switchDisabled}` : styles.switch}>
      <BaseSwitch.Root
        checked={checked}
        onCheckedChange={(v) => onChange(v)}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        className={styles.switchRoot}
      >
        <BaseSwitch.Thumb className={styles.switchThumb} />
      </BaseSwitch.Root>
      {label && <span className={styles.switchLabel}>{label}</span>}
    </label>
  );
}
