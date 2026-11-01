import type { ReactNode } from "react";
import styles from "./ChatStatusNotice.module.css";

type Props = {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  tone?: "info" | "warning" | "error";
  role?: "status" | "alert";
  className?: string;
  testId?: string;
};

export default function ChatStatusNotice({ title, children, action, tone = "info", role = "status", className = "", testId }: Props) {
  return (
    <div className={`${styles.notice} ${className}`} data-tone={tone} role={role} data-testid={testId}>
      <div className={styles.heading}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d={tone === "info" ? "M12 11v6m0-10v1" : "M12 7v6m0 3v1"} />
        </svg>
        <strong>{title}</strong>
      </div>
      {children && <div className={styles.description}>{children}</div>}
      {action && <div className={styles.actions}>{action}</div>}
    </div>
  );
}
