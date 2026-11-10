import { CronClockGlyph } from "../../components/NavIcons";

// Cron 工具栏图标使用 16×16 图框。
// 设计稿里 stroke 写死 black；这里换成 currentColor，让暗色主题跟着文字反色。

const BASE = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

// Agent（6886:762）：天线 + 头顶圆 + 机身圆角矩形 + 两点眼睛。
export function IconAgent() {
  return (
    <svg {...BASE}>
      <path d="M8 7V4" />
      <path d="M8 4C8.82843 4 9.5 3.32843 9.5 2.5C9.5 1.67157 8.82843 1 8 1C7.17157 1 6.5 1.67157 6.5 2.5C6.5 3.32843 7.17157 4 8 4Z" />
      <path d="M5 10H5.00667" strokeWidth="1.5" />
      <path d="M11 10H11.0067" strokeWidth="1.5" />
      <rect x="2" y="7" width="12" height="7" rx="2.5" />
    </svg>
  );
}

// 状态筛选的三段滑杆（7018:126）。
export function IconSliders() {
  return (
    <svg {...BASE}>
      <path d="M14 2.66667H9.33333" />
      <path d="M6.66667 2.66667H2" />
      <path d="M14 8H8" />
      <path d="M5.33333 8H2" />
      <path d="M14 13.3333H10.6667" />
      <path d="M8 13.3333H2" />
      <path d="M9.33333 1.33333V4" />
      <path d="M5.33333 6.66667V9.33333" />
      <path d="M10.6667 12V14.6667" />
    </svg>
  );
}

// 计划沿用导航时钟轮廓，描边由筛选按钮的样式统一设置。
export function IconSchedule() {
  return (
    <svg {...BASE} viewBox="9 9 22 22">
      <CronClockGlyph />
    </svg>
  );
}

// 新建按钮的加号（7018:188）。
export function IconPlus() {
  return (
    <svg {...BASE}>
      <path d="M14 8L2 8" />
      <path d="M8 2V14" />
    </svg>
  );
}

export function IconCalendar() {
  return (
    <svg {...BASE} strokeWidth="1.25">
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
      <path d="M5 2.5v2M11 2.5v2M2.5 6.5h11" />
    </svg>
  );
}

export function IconCalendarChevron({ direction }: { direction: "left" | "right" }) {
  const path = direction === "left" ? "M9.75 4 6.25 8 9.75 12" : "M6.25 4 9.75 8 6.25 12";
  return (
    <svg {...BASE} strokeWidth="1.8">
      <path d={path} />
    </svg>
  );
}
