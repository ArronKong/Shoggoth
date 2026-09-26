import { useEffect, useRef, type RefObject } from "react";
import { LiquidGlassGL, DEFAULT_CONFIG, type Panel } from "../glass/liquidGlassGL";
import { drawMediaCover, type MediaSource } from "../glass/scene";

// 沉浸模式的 WebGL 编排：底层背景媒体帧（视频/图片，由 ImmersiveBackdrop 提供当前
// 前台元素）→ 折射玻璃面板（composer + 视口内消息卡）。每帧从 DOM 收集
// [data-glass-panel] 的实时矩形喂给渲染器，所以滚动/resize/流式增长都跟手。
// active=false（退出沉浸）时停 RAF + dispose，不占 GPU。
export function useGlassRenderer(opts: {
  // 当前应作为折射纹理源的媒体元素（Backdrop 的前台槽；换背景时元素身份变化）。
  getSource: () => MediaSource | null;
  canvasRef: RefObject<HTMLCanvasElement>;
  active: boolean;
  panelSelector: string;
  onFail?: () => void;
}) {
  const { getSource, canvasRef, active, panelSelector, onFail } = opts;
  // onFail/getSource 走 ref、不进 effect deps：调用方传的是内联箭头（每次渲染新身份），
  // 进 deps 会导致每敲一个字/每条流式 delta 都 dispose + 重建渲染器（重编译 shader）。
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;
  const getSourceRef = useRef(getSource);
  getSourceRef.current = getSource;
  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const tex = document.createElement("canvas");
    let renderer: LiquidGlassGL | null = null;
    try {
      renderer = new LiquidGlassGL(canvas, {
        // context restore 重建失败时复用沉浸模式既有 CSS 降级路径。
        onContextFailure: () => onFailRef.current?.(),
      });
    } catch (e) {
      console.error("[immersive] WebGL init failed:", e);
      onFailRef.current?.();
      return;
    }

    let raf = 0;
    let lastT = -1;
    let lastSource: MediaSource | null = null;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const r = renderer;
      if (!r) return;
      // keep-alive 隐藏（路由切走 → 祖先 display:none）时 RAF 仍在跑：canvas 无布局
      // 尺寸即整帧空转，不上传纹理不渲染，别白烧 GPU。
      if (!canvas.clientWidth) return;
      // 画布尺寸跟随视口（CSS px → backing px）。DPR 每帧读——窗口拖到另一块屏（retina↔外接）时跟上。
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const vw = Math.round(window.innerWidth);
      const vh = Math.round(window.innerHeight);
      const bw = Math.round(vw * dpr);
      const bh = Math.round(vh * dpr);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
        canvas.style.width = vw + "px";
        canvas.style.height = vh + "px";
        tex.width = bw;
        tex.height = bh;
      }
      // 纹理更新判据：视频帧推进（currentTime 变）或源身份变化（换背景/图片源）。
      // 图片源只在身份变化时重画一次——静态图状态下每帧 2D drawImage 是纯浪费。
      const media = getSourceRef.current();
      if (media && tex.width > 0) {
        const isVideo = media instanceof HTMLVideoElement;
        const ready = isVideo ? media.readyState >= 2 : media.complete && media.naturalWidth > 0;
        const changed = media !== lastSource || (isVideo && media.currentTime !== lastT);
        if (ready && changed) {
          const ctx = tex.getContext("2d");
          if (ctx && drawMediaCover(ctx, media, tex.width, tex.height)) {
            lastSource = media;
            lastT = isVideo ? media.currentTime : -1;
            r.setScene(tex);
          }
        }
      }
      // 收集视口内的玻璃面板矩形（getBoundingClientRect = 相对视口 = 相对 fixed canvas）。
      // 位于滚动容器（[data-glass-clip] 祖先）内的面板带上容器矩形作裁剪框：DOM 文字被
      // overflow 裁在容器内，玻璃背景必须在同一边界截断，否则滚出显示范围的消息卡会以
      // 「无字玻璃」盖到容器外（顶部身份区 / 底部 composer 区）。
      const els = document.querySelectorAll<HTMLElement>(panelSelector);
      const panels: Panel[] = [];
      els.forEach((el) => {
        const b = el.getBoundingClientRect();
        if (b.width < 2 || b.height < 2) return;
        if (b.bottom < 0 || b.top > vh) return; // 视口裁剪：只渲染看得见的
        let clip: Panel["clip"];
        const clipEl = el.closest("[data-glass-clip]") as HTMLElement | null;
        if (clipEl && clipEl !== el) {
          const c = clipEl.getBoundingClientRect();
          if (b.bottom <= c.top || b.top >= c.bottom || b.right <= c.left || b.left >= c.right) return; // 完全滚出容器
          clip = { x: c.left, y: c.top, w: c.width, h: c.height };
        }
        panels.push({ cx: b.left + b.width / 2, cy: b.top + b.height / 2, w: b.width, h: b.height, clip });
      });
      r.render(panels, DEFAULT_CONFIG, dpr);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      renderer?.dispose();
      renderer = null;
    };
  }, [active, panelSelector, canvasRef]);
}
