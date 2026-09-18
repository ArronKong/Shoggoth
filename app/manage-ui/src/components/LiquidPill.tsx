// LiquidPill — 选中态胶囊在「同排项」之间流过去（与 PillTabs R235、左侧导航 R236
// 同一套运动语言）：朝行进方向的那条边先到位、另一条慢半拍再追上，途中被拉长、
// 落位时收回，配合竖向的轻微挤压回弹 = 液体形变。
//
// 只管运动，不带皮肤：底色/圆角以外的样式由使用方通过 className 叠上去。
// 用法：放进「同排项」的直接父容器里（父容器需 position: relative，同排项需
// z-index 抬到胶囊之上），value 变了就滑；尺寸/位置自己从选中项身上量。
//
// 为什么走 left/right 而不是导航那套 transform：这里的项是**变宽度**的，用
// scaleX 撑宽度会把 999px 的圆角端压成椭圆。导航项个个 40×40 才能用 transform。
import { useLayoutEffect, useRef } from "react";
import styles from "./LiquidPill.module.css";

/** 与 LiquidPill.module.css 的 --pill-lag 对齐（后缘落位 = 形变结束）。 */
const SQUASH_MS = 330;
const SQUASH: Keyframe[] = [
  { transform: "scaleY(1)" },
  { transform: "scaleY(0.9)", offset: 0.2 }, // 拉最长的那一刻压最扁
  { transform: "scaleY(1.045)", offset: 0.58 },
  { transform: "scaleY(1)" },
];

export default function LiquidPill({
  value,
  activeSelector,
  className,
}: {
  /** 当前选中值；变了就滑过去 */
  value: string;
  /** 在父容器里认「选中项」的选择器，如 FilterTabs 传的 `.${styles.on}` */
  activeSelector: string;
  /** 使用方的皮肤（底色等） */
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const prevLeft = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const box = el?.parentElement;
    if (!el || !box) return;

    // 位置/尺寸一律现量：语言切换、字体加载、窗口缩放都会改项的宽度，
    // 所以除了 value 变化，还挂 ResizeObserver 跟着重量（重量不带动画）。
    const place = (animate: boolean) => {
      const active = box.querySelector<HTMLElement>(activeSelector);
      if (!active) {
        el.style.opacity = "0";
        prevLeft.current = null;
        return;
      }
      const left = active.offsetLeft;
      // 用 clientWidth 不是 scrollWidth：绝对定位的包含块是父容器的 padding 盒
      // （= clientWidth），横向滚动的那种（聊天页 provider Tab 行）content 比它宽，
      // 用 scrollWidth 算出来的 right 会把胶囊挤窄一截。胶囊自己会跟着内容一起滚。
      const right = box.clientWidth - left - active.offsetWidth;
      const top = active.offsetTop;
      const height = active.offsetHeight;
      // 量出来和现在一模一样就什么都别碰：ResizeObserver 在 observe() 的当下会
      // 立刻响一次，此时若照常写一遍 data-flow="none"（= transition:none），
      // 会把同一帧里刚起步的滑动当场掐死。
      // 没有选中项时会隐藏；重新选回相同位置仍需要恢复可见性。
      if (
        el.style.opacity === "1"
        && el.style.left === `${left}px` && el.style.right === `${right}px`
        && el.style.top === `${top}px` && el.style.height === `${height}px`
      ) return;

      el.style.opacity = "1";
      const from = prevLeft.current;
      prevLeft.current = left;
      // 首帧（from === null）必须标 none，否则胶囊会从容器左边缘飞进来
      el.dataset.flow = !animate || from === null || from === left
        ? "none"
        : left > from ? "right" : "left";
      el.style.left = `${left}px`;
      el.style.right = `${right}px`;
      el.style.top = `${top}px`;
      el.style.height = `${height}px`;
      if (el.dataset.flow === "none") return;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      el.animate(SQUASH, { duration: SQUASH_MS, easing: "ease-in-out" });
    };

    place(true);
    const ro = new ResizeObserver(() => place(false));
    ro.observe(box);
    return () => ro.disconnect();
  }, [value, activeSelector]);

  return (
    <span
      ref={ref}
      aria-hidden="true"
      className={className ? `${styles.pill} ${className}` : styles.pill}
    />
  );
}
