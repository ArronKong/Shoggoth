import type { ButtonHTMLAttributes, ReactNode } from "react";
import ArtifactThumb from "./ArtifactThumb";
import styles from "./ChatFileGrid.module.css";

export function ChatFileGrid({ children }: { children: ReactNode }) {
  return <div className={styles.list} data-chat-file-grid>{children}</div>;
}

function fileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function ChatFileCard({ name, detail, size, timestamp, timeLabel, className, ...button }: {
  name: string; detail: string; size?: number; timestamp?: number; timeLabel?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...button} type="button" className={`${styles.file}${className ? ` ${className}` : ""}`}>
    <ArtifactThumb name={name} />
    <span className={styles.body}>
      <span className={styles.name}>{name}</span>
      <span className={styles.detail}>{detail}</span>
      {(size !== undefined || timestamp !== undefined) && <span className={styles.meta}>
        {size !== undefined && <span>{fileSize(size)}</span>}
        {timestamp !== undefined && <time dateTime={new Date(timestamp).toISOString()}>{timeLabel}</time>}
      </span>}
    </span>
  </button>;
}
