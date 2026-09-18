// FilterTabs — 全站统一的「一排筛选胶囊」（Dashboard 活动流筛选 R237 的完成品抽出）。
// 选中态的黑胶囊不由选中项自己画，而是 LiquidPill 在项之间流过去（与 PillTabs R235、
// 左侧导航 R236 同一套运动语言）。
//
// 与 PillTabs 的分工：PillTabs 是**带容器底**的 48px 大切换（后端切换、区间切换）；
// FilterTabs 是**无容器**的轻量筛选行，直接浮在内容上。
//
// 皮肤可调项走 CSS 变量（--ft-*），使用方在自己的作用域里覆盖即可，不必穿透 Module。
import { useEffect, useRef, type ReactNode } from "react";
import { Tooltip } from "@base-ui/react/tooltip";
import LiquidPill from "./LiquidPill";
import styles from "./FilterTabs.module.css";

export interface FilterTabItem {
  /** 选中值；空串通常代表「全部」 */
  value: string;
  label: string;
  /** 图标筛选仍使用 label 作为可访问名称。 */
  icon?: ReactNode;
  /** 悬浮提示（provider 名过长时用） */
  title?: string;
}

export default function FilterTabs({
  value,
  onChange,
  items,
  ariaLabel,
  scrollable,
  toggleOff,
  className,
  showTooltips,
}: {
  value: string;
  onChange: (v: string) => void;
  items: FilterTabItem[];
  ariaLabel?: string;
  /** 项多到放不下时横向滚动（隐藏滚动条 + 竖直滚轮转横滑）。 */
  scrollable?: boolean;
  /** 再点一次当前选中项 → 回落到这个值（模型菜单的「点掉筛选回全部」）。 */
  toggleOff?: string;
  className?: string;
  /** 用浮层显示功能名，同时支持鼠标悬停和键盘聚焦。 */
  showTooltips?: boolean;
}) {
  const rowRef = useRef<HTMLDivElement>(null);

  // 竖直滚轮横滑（无横向滚轮的鼠标也能翻看溢出项）。非被动监听才能 preventDefault，
  // 免得顺带滚动下方列表/页面。依赖 items.length：项后到时是二次挂载，需重绑。
  useEffect(() => {
    const el = rowRef.current;
    if (!scrollable || !el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0 || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scrollable, items.length]);

  const cls = [styles.row, scrollable ? styles.scrollable : "", className].filter(Boolean).join(" ");

  return (
    <Tooltip.Provider delay={300}>
    <div
      className={cls}
      role="tablist"
      aria-label={ariaLabel}
      ref={rowRef}
      data-scrollbar={scrollable ? "hidden" : undefined}
    >
      {/* activeSelector 必须落在本组件自己的类上：使用方换皮肤也不会认错选中项 */}
      <LiquidPill value={value} activeSelector={`.${styles.on}`} className={styles.pill} />
      {items.map((it) => {
        const tab = (
        <button
          key={it.value || "__all__"}
          type="button"
          role="tab"
          aria-selected={value === it.value}
          aria-label={it.icon ? it.label : undefined}
          title={showTooltips ? undefined : it.title || (it.icon ? it.label : undefined)}
          className={value === it.value ? `${styles.tab} ${styles.on}` : styles.tab}
          onClick={() =>
            onChange(toggleOff !== undefined && value === it.value ? toggleOff : it.value)
          }
        >
          {it.icon || it.label}
        </button>
        );
        return showTooltips ? <Tooltip.Root key={it.value || "__all__"}>
          <Tooltip.Trigger render={tab} />
          <Tooltip.Portal>
            <Tooltip.Positioner side="top" sideOffset={10} className={styles.tooltipPositioner}>
              <Tooltip.Popup className={styles.tooltipPopup}>{it.title || it.label}</Tooltip.Popup>
            </Tooltip.Positioner>
          </Tooltip.Portal>
        </Tooltip.Root> : tab;
      })}
    </div>
    </Tooltip.Provider>
  );
}
