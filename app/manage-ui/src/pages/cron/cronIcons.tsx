// Cron 工具栏图标 —— path 1:1 取自设计稿（Figma 6458-121 的 16×16 图标节点）。
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

// Statuses / Schedules 共用同一个三段滑杆图标（7018:126 与 7018:142 完全一致）。
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

// 搜索（7018:175）。放大镜的圆只有 ⌀10，摆在 16 的框里比同排 sliders(⌀12 满框)
// 明显小一圈——收紧 viewBox 让图形填满，视觉重量对齐，尺寸仍是 16。
export function IconSearch() {
  return (
    <svg {...BASE} viewBox="1 1 14 14">
      <path d="M7 12C9.76142 12 12 9.76142 12 7C12 4.23858 9.76142 2 7 2C4.23858 2 2 4.23858 2 7C2 9.76142 4.23858 12 7 12Z" />
      <path d="M10.667 11.1133L14.0537 14.5" />
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
