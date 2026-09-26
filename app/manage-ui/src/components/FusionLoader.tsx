import { useId } from "react";
import styles from "./FusionLoader.module.css";

export interface FusionLoaderProps {
  /** sm = 36×18px 行内；md = 72×36px 卡片级。 */
  size?: FusionLoaderSize;
  /** 说明文字由调用方负责国际化；省略时组件仅作为装饰。 */
  label?: string;
  /** 只供辅助技术播报、不显示在界面中的状态文案。 */
  ariaLabel?: string;
  className?: string;
}

export type FusionLoaderSize = "sm" | "md";

/** 两颗球通过 SVG alpha 阈值滤镜形成真正连续的液态融合边缘。 */
export default function FusionLoader({ size = "md", label, ariaLabel, className }: FusionLoaderProps) {
  const filterId = `fusion-loader-${useId().replace(/:/g, "")}`;
  const a11y = label || ariaLabel
    ? ({ role: "status", "aria-live": "polite", ...(ariaLabel ? { "aria-label": ariaLabel } : {}) } as const)
    : ({ "aria-hidden": true } as const);

  return (
    <span {...a11y} className={[styles.root, styles[size], className].filter(Boolean).join(" ")}>
      <svg className={styles.motion} viewBox="0 0 72 36" aria-hidden="true">
        <defs>
          <filter id={filterId} x="-25%" y="-50%" width="150%" height="200%" colorInterpolationFilters="sRGB">
            <feGaussianBlur in="SourceGraphic" stdDeviation="4.2" result="blur" />
            <feColorMatrix
              in="blur"
              type="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -10"
            />
          </filter>
        </defs>
        <g filter={`url(#${filterId})`}>
          <g className={styles.leftTrack}>
            <circle className={styles.leftBall} cx="36" cy="18" r="9" />
          </g>
          <g className={styles.rightTrack}>
            <circle className={styles.rightBall} cx="36" cy="18" r="9" />
          </g>
        </g>
      </svg>
      {label ? <span className={styles.label}>{label}</span> : null}
    </span>
  );
}
