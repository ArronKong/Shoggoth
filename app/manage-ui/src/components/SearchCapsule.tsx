// SearchCapsule —— 一级工具栏/页头的 48px 玻璃胶囊搜索框。
// 灵感与定时任务使用可折叠版本；默认直接显示输入框。
import { useRef, useState } from "react";
import styles from "./SearchCapsule.module.css";

function IconSearch() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="1 1 14 14"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 12C9.76142 12 12 9.76142 12 7C12 4.23858 9.76142 2 7 2C4.23858 2 2 4.23858 2 7C2 9.76142 4.23858 12 7 12Z" />
      <path d="M10.667 11.1133L14.0537 14.5" />
    </svg>
  );
}

export default function SearchCapsule({
  value,
  onChange,
  placeholder,
  ariaLabel,
  className,
  collapsible = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  collapsible?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const label = ariaLabel || placeholder;
  const boxClassName = [styles.box, collapsible && styles.collapsible, className].filter(Boolean).join(" ");
  if (collapsible && !expanded && !value) return (
    <button ref={trigger} type="button" className={`${boxClassName} ${styles.collapsed}`}
      aria-label={label} title={label} aria-expanded={false} onClick={() => setExpanded(true)}>
      <IconSearch />
    </button>
  );
  return (
    <label className={boxClassName} title={label}>
      <IconSearch />
      <input
        className={styles.input}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel || placeholder}
        autoFocus={collapsible}
        onBlur={collapsible ? (event) => {
          if (!value && !event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) setExpanded(false);
        } : undefined}
        onKeyDown={collapsible ? (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault(); event.stopPropagation();
          onChange(''); setExpanded(false);
          requestAnimationFrame(() => trigger.current?.focus());
        } : undefined}
      />
    </label>
  );
}
