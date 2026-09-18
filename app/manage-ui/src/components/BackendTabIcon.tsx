import styles from "./BackendTabIcon.module.css";

// Figma 251:1385 / 252:3077. Unknown registry entries keep their own identity.
const BACKEND_ORDER = [
  "shoggoth", "hermes", "openclaw", "codex", "claude-code", "grok-build",
  "antigravity", "deepseek-harness", "pi",
];

export function sortBackendTabs<T extends { id: string }>(backends: readonly T[]): T[] {
  const rank = (id: string) => {
    const index = BACKEND_ORDER.indexOf(id);
    return index < 0 ? BACKEND_ORDER.length : index;
  };
  return [...backends].sort((a, b) => rank(a.id) - rank(b.id));
}

export default function BackendTabIcon({ backend, label }: { backend: string; label: string }) {
  const hasIcon = BACKEND_ORDER.includes(backend);
  return (
    <span className={`${styles.icon}${hasIcon ? ` ${styles.glyph}` : ""}`} data-backend-icon={backend} aria-hidden="true">
      {!hasIcon && Array.from(label).slice(0, 2).join("").toUpperCase()}
    </span>
  );
}
