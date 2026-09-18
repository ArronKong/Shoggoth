// PillTabs — 统一胶囊切换组件（Figma 6999-633）。后端切换（BackendTabs）与
// usage 区间切换共用同一份视觉与交互；base-ui Tabs（方向键导航 + roving
// tabindex），受控——父组件持有当前值。
import { useEffect, useRef, type ReactNode, type Ref } from "react";
import { Tabs } from "@base-ui/react/tabs";
import { Tooltip } from "@base-ui/react/tooltip";
import styles from "./PillTabs.module.css";
import tooltipStyles from "./FilterTabs.module.css";

export interface PillTabItem {
  value: string;
  label: string;
  icon?: ReactNode;
  id?: string;
  panelId?: string;
}

/** 液体形变的竖向一半：横向被拉长时压扁一点，落位时回弹一下（体积守恒的错觉）。
    横向拉伸在 CSS 里（左右边不同曲线），这里只补 scaleY——它需要每次切换重新
    起播，CSS transition/animation 在同方向连点时不会重启，故走 WAAPI。 */
const SQUASH: Keyframe[] = [
  { transform: "scaleY(1)" },
  { transform: "scaleY(0.9)", offset: 0.2 }, // 拉最长的那一刻压最扁
  { transform: "scaleY(1.045)", offset: 0.58 },
  { transform: "scaleY(1)" },
];
/** 与 PillTabs.module.css 的 --pill-lag 对齐（后缘落位 = 形变结束，不能拖在后面
    继续弹，否则胶囊看着「到位了还在动」）。 */
const SQUASH_MS = 330;

export default function PillTabs({
  value,
  onChange,
  items,
  ariaLabel,
  listRef,
}: {
  value: string;
  onChange: (v: string) => void;
  items: PillTabItem[];
  ariaLabel?: string;
  /** 拿到承载胶囊的那个盒子（Root 是 display:contents，量不到宽度）。 */
  listRef?: Ref<HTMLDivElement>;
}) {
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const prevValue = useRef(value);
  const iconOnly = items.length > 0 && items.every((item) => item.icon);

  useEffect(() => {
    const changed = prevValue.current !== value;
    prevValue.current = value;
    if (!changed || !indicatorRef.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    indicatorRef.current.animate(SQUASH, { duration: SQUASH_MS, easing: "ease-in-out" });
  }, [value]);

  return (
    <Tooltip.Provider delay={300}>
      <Tabs.Root value={value} onValueChange={(v) => onChange(v as string)} className={styles.root}>
        <Tabs.List
          ref={listRef}
          className={`${styles.tabs}${iconOnly ? ` ${styles.iconTabs}` : ""}`}
          aria-label={ariaLabel}
          data-scrollbar={iconOnly ? "hidden" : undefined}
        >
          <Tabs.Indicator ref={indicatorRef} className={styles.indicator} />
          {items.map((it) => {
            const tab = (
              <Tabs.Tab
                key={it.value}
                id={it.id}
                aria-controls={it.panelId}
                aria-label={it.icon ? it.label : undefined}
                value={it.value}
                className={[styles.tab, value === it.value ? styles.tabOn : "", it.icon ? styles.iconTab : ""].filter(Boolean).join(" ")}
              >
                {it.icon || it.label}
              </Tabs.Tab>
            );
            return it.icon ? (
              <Tooltip.Root key={it.value}>
                <Tooltip.Trigger render={tab} />
                <Tooltip.Portal>
                  <Tooltip.Positioner side="top" sideOffset={10} className={tooltipStyles.tooltipPositioner}>
                    <Tooltip.Popup className={tooltipStyles.tooltipPopup}>{it.label}</Tooltip.Popup>
                  </Tooltip.Positioner>
                </Tooltip.Portal>
              </Tooltip.Root>
            ) : tab;
          })}
        </Tabs.List>
      </Tabs.Root>
    </Tooltip.Provider>
  );
}
