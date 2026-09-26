// Centered modal dialog — base-ui Dialog styled as a centered popup. **本项目唯一
// 的浮层形态**：R370 起全站退役右侧抽屉，详情 / 编辑 / 新建一律走这里（见
// ARCHITECTURE.md §5「UI 组件层」）。Focus-trap / scroll-lock / Escape + backdrop
// dismiss / ARIA come from base-ui; centered chrome lives in Modal.module.css.

import { type ReactNode, useLayoutEffect, useRef } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { useTranslation } from "react-i18next";
import styles from "./Modal.module.css";

export default function Modal({
  open,
  title,
  subtitle,
  onClose,
  onOpenChangeComplete,
  children,
  footer,
  // 设计稿 7108:896「内容大弹窗」是 800 宽；已显式传宽的调用方保持自己的取值。
  width = 800,
  dismissible = true,
  className,
}: {
  open: boolean;
  title?: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  // Base UI 在入场/退场过渡结束后调用；页面可据此延后重内容加载或状态清理。
  onOpenChangeComplete?: (open: boolean) => void;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
  // 提交中的表单用它锁住 Escape / 遮罩 / 关闭键，避免半途关窗。
  dismissible?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const wasOpenRef = useRef(false);
  const currentContent = { title, subtitle, children, footer };
  const retainedContent = useRef(currentContent);
  // React 18 尚未把 inert 当布尔属性处理；空字符串既符合 HTML 的 presence
  // 语义，也能避免 inert={true} 被 React 丢弃而让退场表单继续响应键盘。
  const closingInteractionProps: { inert?: "" } = { inert: open ? undefined : "" };

  // open 时始终读取最新 props，保证受控表单和异步内容实时更新；只有退场阶段
  // 才回放最后一次已提交的内容，避免调用方立即清空 payload 导致面板先坍缩再淡出。
  const visibleContent = open ? currentContent : retainedContent.current;

  useLayoutEffect(() => {
    if (open) {
      // 只缓存已经 commit 的子树；render 阶段写 ref 会把并发渲染中被放弃的内容带进退场。
      retainedContent.current = currentContent;
    }
  });

  useLayoutEffect(() => {
    wasOpenRef.current = open;
  }, [open]);

  const handleOpenChangeComplete = (nextOpen: boolean) => {
    // 被快速反转的旧生命周期回调不能清掉当前这次入场的内容快照。
    if (nextOpen === wasOpenRef.current) {
      if (!nextOpen) {
        retainedContent.current = {
          title: undefined,
          subtitle: undefined,
          children: undefined,
          footer: undefined,
        };
      }
      onOpenChangeComplete?.(nextOpen);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && dismissible) onClose();
      }}
      onOpenChangeComplete={handleOpenChangeComplete}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={styles.overlay} />
        <Dialog.Popup
          {...closingInteractionProps}
          className={[styles.panel, className].filter(Boolean).join(' ')}
          style={{ width }}
        >
          <header className={styles.head}>
            <div className={styles.titles}>
              <Dialog.Title className={styles.title}>{visibleContent.title}</Dialog.Title>
              {visibleContent.subtitle && (
                <Dialog.Description className={styles.subtitle}>
                  {visibleContent.subtitle}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close
              className={styles.close}
              aria-label={t("common.close")}
              disabled={!dismissible}
            >
              ✕
            </Dialog.Close>
          </header>
          <div className={styles.body}>{visibleContent.children}</div>
          {visibleContent.footer && (
            <footer className={styles.foot}>{visibleContent.footer}</footer>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// Titled section inside a modal body.
export function ModalSection({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <section className={styles.section}>
      {title && <h4 className={styles.sectionTitle}>{title}</h4>}
      {children}
    </section>
  );
}

// A label/value row for read-only detail.
export function DetailRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.detailRow}>
      <span className={styles.detailLabel}>{label}</span>
      <span className={styles.detailValue}>{children}</span>
    </div>
  );
}
