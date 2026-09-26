import type { ReactNode } from "react";
import styles from "./PageHead.module.css";

// 全站统一页头：左标题 + 副标题，右侧动作槽（Kanban/CLI/设置对齐后的 topbar 结构）。
// 除 module 类外挂全局锚点类 page-head*，页面级皮肤可按域覆盖（如设置页把
// actions 里的按钮胶囊化），不必穿透 CSS Module。
export function PageHead({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className={`page-head ${styles.head}`}>
      <div className={`page-head-titles ${styles.titles}`}>
        <h1 className={`page-head-title ${styles.title}`}>{title}</h1>
        {subtitle != null && <div className={`page-head-subtitle ${styles.subtitle}`}>{subtitle}</div>}
      </div>
      {actions != null && <div className={`page-head-actions ${styles.actions}`}>{actions}</div>}
    </header>
  );
}
