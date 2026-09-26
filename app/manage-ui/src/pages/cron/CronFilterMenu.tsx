import type { ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import styles from "./CronFilterMenu.module.css";

export interface CronFilterOption {
  value: string;
  label: string;
}

// Cron 工具栏的筛选胶囊：单选走 RadioItem、多选走 CheckboxItem，外观共用一套。
// 多选以「空数组 = 不筛选」表达全部；单选以哨兵值 "all" 表达全部。
type Props = {
  icon: ReactNode;
  label: string;
  options: CronFilterOption[];
  emptyHint?: string;
} & (
  | { multiple?: false; value: string; onChange: (value: string) => void }
  | { multiple: true; value: string[]; onChange: (value: string[]) => void }
);

export default function CronFilterMenu(props: Props) {
  const { icon, label, options, emptyHint } = props;
  const selected = props.multiple ? props.value : props.value === "all" ? [] : [props.value];
  const activeLabels = options.filter((o) => selected.includes(o.value)).map((o) => o.label);
  // 恰好一项时直接显示它，多项收成计数，避免按钮被长 agent 名撑破一排布局。
  const triggerText = activeLabels.length === 1 ? activeLabels[0] : label;

  return (
    <Menu.Root>
      <Menu.Trigger
        className={styles.trigger}
        disabled={options.length === 0 && !emptyHint}
      >
        <span className={styles.icon}>{icon}</span>
        <span className={styles.text}>{triggerText}</span>
        {activeLabels.length > 1 && <span className={styles.count}>{activeLabels.length}</span>}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className={styles.positioner} sideOffset={6} align="start">
          <Menu.Popup className={styles.popup}>
            {options.length === 0 ? (
              <div className={styles.empty}>{emptyHint}</div>
            ) : props.multiple ? (
              options.map((option) => (
                <Menu.CheckboxItem
                  key={option.value}
                  className={styles.item}
                  checked={props.value.includes(option.value)}
                  onCheckedChange={(checked) =>
                    props.onChange(
                      checked
                        ? [...props.value, option.value]
                        : props.value.filter((v) => v !== option.value),
                    )
                  }
                  closeOnClick={false}
                >
                  <span className={styles.itemText}>{option.label}</span>
                  <Menu.CheckboxItemIndicator className={styles.indicator}>✓</Menu.CheckboxItemIndicator>
                </Menu.CheckboxItem>
              ))
            ) : (
              <Menu.RadioGroup value={props.value} onValueChange={(v) => props.onChange(String(v))}>
                {options.map((option) => (
                  // base-ui 的 RadioItem 默认不关闭菜单；单选选完即定，顺手收起。
                  <Menu.RadioItem key={option.value} className={styles.item} value={option.value} closeOnClick>
                    <span className={styles.itemText}>{option.label}</span>
                    <Menu.RadioItemIndicator className={styles.indicator}>✓</Menu.RadioItemIndicator>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
