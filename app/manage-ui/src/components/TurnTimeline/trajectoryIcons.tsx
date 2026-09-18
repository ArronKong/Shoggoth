// Agent Trajectory 图标集 —— 1:1 取自 Figma 设计稿(文件 5F4ifCxAU3fAhIDsGGBLXA,
// node 7132-183 的 Agent Trajectory 卡)导出 SVG,仅剥掉画布背景、stroke 改
// currentColor,几何路径原样保留。着色一律走 currentColor,由使用处的语义色决定。
import type { ReactNode } from "react";

// 主图标「cpu」:半脑+电路,用在卡片标题与输入框的 Agent Trajectory 开关(node 7167:512)。
export function IconTrajectory({ size = 16 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4.5 8.99976C3.67158 8.99976 3 9.67131 3 10.4998C3 11.3282 3.67158 11.9998 4.5 11.9998C4.67532 11.9998 4.84361 11.9697 5 11.9144" />
        <path d="M3.13194 9.80243C2.46213 9.47923 2 8.79363 2 8.00013C2 7.39428 2.26936 6.85138 2.69487 6.48462" />
        <path d="M2.71027 6.44386C2.57745 6.2453 2.5 6.00657 2.5 5.74976C2.5 5.0594 3.05965 4.49976 3.75 4.49976C4.03146 4.49976 4.29119 4.59278 4.50012 4.74976" />
        <path d="M4.61884 4.78267C4.54262 4.62108 4.5 4.44051 4.5 4.25C4.5 3.55964 5.05964 3 5.75 3C6.44035 3 7 3.55964 7 4.25V12" />
        <path d="M5 12C5 12.5523 5.44771 13 6 13C6.5523 13 7 12.5523 7 12" />
      </g>
      <g stroke="currentColor">
        <path d="M7 11H8.34C8.77754 11 9.203 11.1435 9.55119 11.4084L10 11.75" />
        <path d="M7 5C7.53379 5 7.90845 5 8.33993 5C8.77747 5 9.203 4.85652 9.55119 4.59155L10 4.25" />
        <path d="M7 8L11 8" />
        <rect x="11" y="6.5" width="3" height="3" rx="1" />
        <rect x="10" y="2" width="3" height="3" rx="1" />
        <rect x="10" y="11" width="3" height="3" rx="1" />
      </g>
    </svg>
  );
}

// 步骤类型图标(16×16,tool 节点)。Thinking=灯泡(7167:542)。
export function TrajGlyphThinking(): ReactNode {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden>
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6.5 12.5H9.5" />
        <path d="M7 14H9" />
        <path d="M8 2C6.93913 2 5.92172 2.39509 5.17157 3.09835C4.42143 3.80161 4 4.75544 4 5.75C4 7.59441 6.5 9 6.44138 11H9.55862C9.5 9 12 7.59441 12 5.75C12 4.75544 11.5786 3.80161 10.8284 3.09835C10.0783 2.39509 9.06087 2 8 2Z" />
      </g>
    </svg>
  );
}

// Read=竖版文档(7167:590)。
export function TrajGlyphRead(): ReactNode {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="4" y="3" width="9" height="10" rx="2" stroke="currentColor" />
      <path d="M6.2002 5.29163H10.5335M6.2002 7.45829H10.5335M6.2002 9.62496H8.90853" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Workboard=方框对勾(7167:630,Hermes Kanban 与 OpenClaw workboard 通用)。
export function TrajGlyphWorkboard(): ReactNode {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M5.5 8L7.16667 9.5L10.5 6.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="3" y="3" width="10" height="10" rx="2" stroke="currentColor" />
    </svg>
  );
}

// Exec=终端(7167:677)。
export function TrajGlyphExec(): ReactNode {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="3" y="3" width="10" height="9" rx="2" stroke="currentColor" />
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 5.5L7 7.5L5 9.5" />
        <path d="M8 9.5H11" />
      </g>
    </svg>
  );
}

// 展开/行尾箭头(7167:560 的 login 图标,24px 盒里的一条圆滑 chevron,稿即 24 盒)。
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
