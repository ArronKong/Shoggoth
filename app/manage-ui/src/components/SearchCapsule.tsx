// SearchCapsule —— 一级工具栏/页头右侧的搜索框（48px 玻璃胶囊，见
// docs/ui-design-spec.md §3/§4）。Cron 页那颗 .cron-search-box 是同一份配方的
// 先行实现（宽度要跟「月|周|日」等宽，绑了 ResizeObserver），保持原样不动；
// Workboard / Models / Skills 三页共用这一个组件。
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
  if (collapsible && !expanded && !value) return (
    <button ref={trigger} type="button" className={[styles.box, styles.collapsed, className].filter(Boolean).join(" ")}
      aria-label={label} title={label} aria-expanded={false} onClick={() => setExpanded(true)}>
      <IconSearch />
    </button>
  );
  return (
    <label className={[styles.box, className].filter(Boolean).join(" ")} title={label}>
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
