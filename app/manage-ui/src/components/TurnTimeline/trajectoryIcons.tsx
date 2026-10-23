// 共享轨迹图标：16×16 画布、1px 有效描边、12px 视觉范围，圆头圆角。
// 保留原有轮廓；固定绘图边界来自 SVG 几何，不在渲染时读取 DOM。
import type { ReactNode } from "react";

interface IconShape {
  bounds: readonly [number, number, number, number];
  drawing: ReactNode;
}

const SHAPES = {
  trajectory: {
    bounds: [2, 2, 12, 12],
    drawing: <>
      <g>
        <path d="M4.5 8.99976C3.67158 8.99976 3 9.67131 3 10.4998C3 11.3282 3.67158 11.9998 4.5 11.9998C4.67532 11.9998 4.84361 11.9697 5 11.9144" />
        <path d="M3.13194 9.80243C2.46213 9.47923 2 8.79363 2 8.00013C2 7.39428 2.26936 6.85138 2.69487 6.48462" />
        <path d="M2.71027 6.44386C2.57745 6.2453 2.5 6.00657 2.5 5.74976C2.5 5.0594 3.05965 4.49976 3.75 4.49976C4.03146 4.49976 4.29119 4.59278 4.50012 4.74976" />
        <path d="M4.61884 4.78267C4.54262 4.62108 4.5 4.44051 4.5 4.25C4.5 3.55964 5.05964 3 5.75 3C6.44035 3 7 3.55964 7 4.25V12" />
        <path d="M5 12C5 12.5523 5.44771 13 6 13C6.5523 13 7 12.5523 7 12" />
      </g>
      <g>
        <path d="M7 11H8.34C8.77754 11 9.203 11.1435 9.55119 11.4084L10 11.75" />
        <path d="M7 5C7.53379 5 7.90845 5 8.33993 5C8.77747 5 9.203 4.85652 9.55119 4.59155L10 4.25" />
        <path d="M7 8L11 8" />
        <rect x="11" y="6.5" width="3" height="3" rx="1" />
        <rect x="10" y="2" width="3" height="3" rx="1" />
        <rect x="10" y="11" width="3" height="3" rx="1" />
      </g>
    </>,
  },
  thinking: {
    bounds: [4, 2, 8, 12],
    drawing: <>
      <g>
        <path d="M6.5 12.5H9.5" />
        <path d="M7 14H9" />
        <path d="M8 2C6.93913 2 5.92172 2.39509 5.17157 3.09835C4.42143 3.80161 4 4.75544 4 5.75C4 7.59441 6.5 9 6.44138 11H9.55862C9.5 9 12 7.59441 12 5.75C12 4.75544 11.5786 3.80161 10.8284 3.09835C10.0783 2.39509 9.06087 2 8 2Z" />
      </g>
    </>,
  },
  gather: {
    bounds: [4, 4, 16, 16],
    drawing: <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>,
  },
  read: {
    bounds: [4, 3, 9, 10],
    drawing: <>
      <rect x="4" y="3" width="9" height="10" rx="2" />
      <path d="M6.2002 5.29163H10.5335M6.2002 7.45829H10.5335M6.2002 9.62496H8.90853" />
    </>,
  },
  execute: {
    bounds: [3, 3, 10, 9],
    drawing: <>
      <rect x="3" y="3" width="10" height="9" rx="2" />
      <g>
        <path d="M5 5.5L7 7.5L5 9.5" />
        <path d="M8 9.5H11" />
      </g>
    </>,
  },
  workboard: {
    bounds: [3, 3, 10, 10],
    drawing: <>
      <path d="M5.5 8L7.16667 9.5L10.5 6.5" />
      <rect x="3" y="3" width="10" height="10" rx="2" />
    </>,
  },
  cron: {
    bounds: [2, 2, 12, 12],
    drawing: <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8L10.5 9.5" transform="translate(-0.35 0.35)" />
    </>,
  },
  inspiration: {
    // Same seed outline as assets/nav-icons/inspiration.svg.
    bounds: [0.49995167, 0.49994064, 15.56606498, 15.99996665],
    drawing: <>
      <path d="M12.8405 0.837529C15.7466 2.38743 16.7927 5.75847 15.5528 9.09076C13.9254 13.508 9.70194 16.6853 5.43971 16.4915C2.22366 16.3365 0.286287 14.3604 0.518773 11.2219C0.790005 7.61835 3.50233 3.82109 7.33834 1.80622C9.43071 0.721286 11.4068 0.0625776 12.8405 0.837529Z" />
      <path d="M10.2048 4.71199C8.49986 5.60319 7.0662 7.19184 6.2525 9.05172C5.86503 9.90417 5.67129 10.6791 5.63254 11.4153" />
    </>,
  },
  message: {
    bounds: [3, 4, 18, 16],
    drawing: <>
      <path d="M21 4 3 11l7 2 2 7 9-16Z" />
    </>,
  },
  plan: {
    bounds: [4, 3.5, 16, 17],
    drawing: <>
      <path d="m4 6 2 2 3-3M4 13l2 2 3-3M4 20l2 2 3-3" transform="translate(0,-1.5)" />
      <path d="M13 6h7M13 13h7M13 20h7" transform="translate(0,-1.5)" />
    </>,
  },
  prompt: {
    bounds: [3, 3, 18, 18],
    drawing: <>
      <path d="M9.5 9a2.5 2.5 0 1 1 3.4 2.3c-.8.3-.9 1-.9 1.7" />
      <path d="M12 17h.01" />
      <circle cx="12" cy="12" r="9" />
    </>,
  },
  status: {
    bounds: [4, 4, 16, 16],
    drawing: <>
      <path d="M8 4v6l-3 3M16 20v-6l3-3" />
      <path d="M4 13h6M14 11h6" />
    </>,
  },
  error: {
    bounds: [3, 3, 18, 18],
    drawing: <>
      <path d="M12 7v6M12 17h.01" />
      <circle cx="12" cy="12" r="9" />
    </>,
  },
  final: {
    bounds: [6, 8, 12, 8],
    drawing: <>
      <path d="m6 12 4 4 8-8" />
    </>,
  },
  text: {
    // Retain the alignment frame while shortening each progress line slightly.
    bounds: [4, 6, 16, 12],
    drawing: <>
      <path d="M5 6h14M5 12h14M5 18h7.875" />
    </>,
  },
  user: {
    bounds: [4, 4, 16, 17],
    drawing: <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
    </>,
  },
} satisfies Record<string, IconShape>;

type IconName = keyof typeof SHAPES;

function TrajectoryIcon({ name, size = 16 }: { name: IconName; size?: number }): ReactNode {
  const { bounds: [x, y, width, height], drawing } = SHAPES[name];
  const scale = 12 / Math.max(width, height);
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round" data-trajectory-icon="" aria-hidden>
      <g transform={`translate(8 8) scale(${scale}) translate(${-x - width / 2} ${-y - height / 2})`}
        strokeWidth={1 / scale}>
        {drawing}
      </g>
    </svg>
  );
}

// 未匹配工具与 execute 共用终端轮廓；工具分类与状态仍由时间线保留。
export function TrajGlyph({ kind }: { kind: string }): ReactNode {
  const name = Object.prototype.hasOwnProperty.call(SHAPES, kind) ? kind as IconName : "execute";
  return <TrajectoryIcon name={name} />;
}

export function IconTrajectory({ size = 16 }: { size?: number }): ReactNode {
  return <TrajectoryIcon name="trajectory" size={size} />;
}

export function TrajGlyphThinking(): ReactNode { return <TrajGlyph kind="thinking" />; }
export function TrajGlyphRead(): ReactNode { return <TrajGlyph kind="read" />; }
export function TrajGlyphWorkboard(): ReactNode { return <TrajGlyph kind="workboard" />; }
export function TrajGlyphExec(): ReactNode { return <TrajGlyph kind="execute" />; }

// Auxiliary controls retain their original canvas, spacing and stroke inheritance.
export function TrajChevron({ size = 24 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M10 8L14.0239 11.2191C14.5243 11.6195 14.5243 12.3805 14.0239 12.7809L10 16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// 「放大查看」双角括号斜箭(7167:575 Group 318)。
export function TrajZoom({ size = 12 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" aria-hidden>
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5.65723 2.12161L8.35124 1.8767C8.97318 1.82016 9.49421 2.34119 9.43767 2.96313L9.19276 5.65714" />
        <path d="M2.12109 5.65713L1.87618 8.35115C1.81964 8.97308 2.34068 9.49411 2.96261 9.43757L5.65663 9.19266" />
      </g>
      <path d="M2.47461 8.83914L8.83857 2.47518" stroke="currentColor" />
    </svg>
  );
}
