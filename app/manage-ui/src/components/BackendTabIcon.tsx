import styles from "./BackendTabIcon.module.css";
import { BACKEND_ORDER } from "../lib/backendTabOrder";

// Figma 251:1385 / 252:3077. Unknown registry entries keep their own identity.
export { sortBackendTabs } from "../lib/backendTabOrder";

export default function BackendTabIcon({ backend, label }: { backend: string; label: string }) {
  const hasIcon = BACKEND_ORDER.includes(backend);
  return (
    <span className={`${styles.icon}${hasIcon ? ` ${styles.glyph}` : ""}`} data-backend-icon={backend} aria-hidden="true">
      {!hasIcon && Array.from(label).slice(0, 2).join("").toUpperCase()}
    </span>
  );
}
