import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import styles from "./ImmersiveOverlay.module.css";

// 沉浸模式共享玻璃浮层壳（cron/kanban/档案三面板复用）：右侧竖版玻璃面板 +
// 点外关闭背板。Esc 关闭由 ImmersiveChat 的分层退出链统一处理（overlay 档先于
// picker/退出）。面板本体挂 data-glass-panel 参与 WebGL 折射，GL 不可用时靠
// backdrop-filter 毛玻璃兜底。
export default function ImmersiveOverlay({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <>
      <div className={styles.backdrop} onMouseDown={onClose} />
      <div className={styles.panel} data-glass-panel role="dialog" aria-label={title}>
        <div className={styles.head}>
          <div className={styles.title}>{title}</div>
          <button type="button" className={styles.close} onClick={onClose} title={t("common.close")}>
            ×
          </button>
        </div>
        <div className={styles.body}>{children}</div>
      </div>
    </>
  );
}
