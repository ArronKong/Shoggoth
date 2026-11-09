import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import styles from "./Skeleton.module.css";

export function SkeletonShape({ className = "", style }: { className?: string; style?: CSSProperties }) {
  return <span className={`${styles.shape} ${className}`} style={style} aria-hidden="true" />;
}

export function SkeletonStatus({ children, className = "" }: { children: ReactNode; className?: string }) {
  const { t } = useTranslation();
  return (
    <div className={`${styles.status} ${className}`} role="status" aria-label={t("common.loading")} aria-busy="true">
      {children}
    </div>
  );
}
