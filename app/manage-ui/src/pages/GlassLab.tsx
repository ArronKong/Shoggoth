import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PageHead } from "../components/PageHead";
import { LiquidGlassGL, DEFAULT_CONFIG, type GlassConfig } from "./glass/liquidGlassGL";
import { drawVideoCover } from "./glass/scene";
import styles from "./GlassLab.module.css";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_W = 90;
const MIN_H = 70;
const PRESETS_KEY = "shoggoth.glasslab.presets.v1";
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// 每次同步 backing store 时读取当前屏幕 DPR，窗口跨屏后无需重载模块。
export function readGlassDpr(): number {
  return Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
}

// 同步可见尺寸与物理像素尺寸；返回本帧实际使用的 DPR。
export function syncGlassBackingStore(
  canvas: HTMLCanvasElement,
  texture: HTMLCanvasElement,
  width: number,
  height: number,
): number {
  const dpr = readGlassDpr();
  const backingWidth = Math.round(width * dpr);
  const backingHeight = Math.round(height * dpr);
  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
    texture.width = backingWidth;
    texture.height = backingHeight;
  }
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  return dpr;
}

// Snap a dragged value onto the step grid and strip float noise (e.g. 0.6499999 → 0.65).
function snap(n: number, step: number): number {
  const dec = (String(step).split(".")[1] || "").length;
  return Number((Math.round(n / step) * step).toFixed(dec));
}

export default function GlassLab() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<GlassConfig>(DEFAULT_CONFIG);
  const [presets, setPresets] = useState<GlassConfig[]>([]);
  const [rect, setRect] = useState<Rect>({ x: 60, y: 60, w: 380, h: 250 });
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [failed, setFailed] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const glRef = useRef<HTMLCanvasElement>(null);
  const texRef = useRef<HTMLCanvasElement | null>(null);
  const renderer = useRef<LiquidGlassGL | null>(null);
  const inited = useRef(false);
  const drag = useRef<{ mode: "move" | "resize"; sx: number; sy: number; start: Rect } | null>(null);
  const hitRef = useRef<HTMLDivElement>(null);

  // Refs the render loop reads so it always sees the latest lens / params.
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const configRef = useRef(config);
  configRef.current = config;

  // Load saved presets.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PRESETS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setPresets(parsed);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const persistPresets = (next: GlassConfig[]) => {
    setPresets(next);
    try {
      localStorage.setItem(PRESETS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  // Init the WebGL renderer + the offscreen texture canvas once.
  useEffect(() => {
    if (!glRef.current) return;
    texRef.current = document.createElement("canvas");
    try {
      renderer.current = new LiquidGlassGL(glRef.current, {
        // 恢复阶段重新编译资源失败时显示现有 CSS 降级提示。
        onContextFailure: () => setFailed(true),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message === "WebGL not available") console.info("[GlassLab] WebGL unavailable; using fallback");
      else console.error("[GlassLab] WebGL init failed:", e);
      setFailed(true);
    }
    const v = videoRef.current;
    if (v) {
      v.muted = true; // required for autoplay
      v.play().catch(() => undefined);
    }
    return () => {
      renderer.current?.dispose();
      renderer.current = null;
    };
  }, []);

  // Track stage size.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (cr) setStage({ w: Math.round(cr.width), h: Math.round(cr.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Size the GL + texture canvases to the stage; position the lens.
  useEffect(() => {
    if (stage.w === 0 || stage.h === 0) return;
    const gc = glRef.current;
    const tex = texRef.current;
    if (!gc || !tex) return;
    syncGlassBackingStore(gc, tex, stage.w, stage.h);

    if (!inited.current) {
      inited.current = true;
      const w = Math.min(380, stage.w * 0.5);
      const h = Math.min(250, stage.h * 0.4);
      setRect({ x: (stage.w - w) / 2, y: clamp(stage.h * 0.16, 16, Math.max(16, stage.h - h)), w, h });
    } else {
      setRect((r) => {
        const w = Math.min(r.w, stage.w);
        const h = Math.min(r.h, stage.h);
        return { w, h, x: clamp(r.x, 0, stage.w - w), y: clamp(r.y, 0, stage.h - h) };
      });
    }
  }, [stage]);

  // Render loop: each frame, redraw the cover-fitted video into the texture canvas,
  // upload it, and composite the glass panel.
  useEffect(() => {
    let raf = 0;
    let lastT = -1;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const v = videoRef.current;
      const tex = texRef.current;
      const r = renderer.current;
      if (!v || !tex || !r || tex.width === 0) return;
      const gc = glRef.current;
      const currentStage = stageRef.current;
      if (!gc || !currentStage) return;
      // RAF 中也检查 DPR，覆盖窗口仅跨屏、CSS 尺寸未变化的场景。
      const previousTextureWidth = tex.width;
      const previousTextureHeight = tex.height;
      const dpr = syncGlassBackingStore(gc, tex, currentStage.clientWidth, currentStage.clientHeight);
      // resize 会清空离屏 2D 画布，强制同一视频时间戳重新绘制一帧。
      if (tex.width !== previousTextureWidth || tex.height !== previousTextureHeight) lastT = -1;
      if (v.readyState >= 2 && v.currentTime !== lastT) {
        const ctx = tex.getContext("2d");
        if (ctx && drawVideoCover(ctx, v, tex.width, tex.height)) {
          lastT = v.currentTime;
          r.setScene(tex);
        }
      }
      const rc = rectRef.current;
      r.render([{ cx: rc.x + rc.w / 2, cy: rc.y + rc.h / 2, w: rc.w, h: rc.h }], configRef.current, dpr);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const begin = (mode: "move" | "resize") => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (mode === "resize") e.stopPropagation();
    hitRef.current?.setPointerCapture(e.pointerId);
    drag.current = { mode, sx: e.clientX, sy: e.clientY, start: { ...rect } };
    e.preventDefault();
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (d.mode === "move") {
      setRect({
        ...d.start,
        x: clamp(d.start.x + dx, 0, Math.max(0, stage.w - d.start.w)),
        y: clamp(d.start.y + dy, 0, Math.max(0, stage.h - d.start.h)),
      });
    } else {
      setRect({
        ...d.start,
        w: clamp(d.start.w + dx, MIN_W, Math.max(MIN_W, stage.w - d.start.x)),
        h: clamp(d.start.h + dy, MIN_H, Math.max(MIN_H, stage.h - d.start.y)),
      });
    }
  };
  const end = (e: React.PointerEvent) => {
    drag.current = null;
    hitRef.current?.releasePointerCapture?.(e.pointerId);
  };

  const set = <K extends keyof GlassConfig>(key: K, value: GlassConfig[K]) => setConfig((p) => ({ ...p, [key]: value }));

  return (
    <div className={`page management-page ${styles.lab}`}>
      <PageHead title={t("glassLab.title")} subtitle={t("glassLab.subtitle")} />

      <div className={styles.body}>
        <div className={styles.stage} ref={stageRef}>
          <video ref={videoRef} className={styles.video} src="/glass-bg.mp4" autoPlay loop muted playsInline aria-hidden="true" />
          <canvas ref={glRef} className={styles.gl} aria-hidden="true" />
          {failed && <div className={styles.failed}>{t("glassLab.noWebgl")}</div>}
          <div
            ref={hitRef}
            className={styles.lensHit}
            style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
            onPointerDown={begin("move")}
            onPointerMove={onMove}
            onPointerUp={end}
            onPointerCancel={end}
          >
            <div className={styles.handle} onPointerDown={begin("resize")} />
          </div>
        </div>

        <aside className={styles.panel}>
          <Slider label={t("glassLab.strength")} value={config.refraction} min={0} max={10} step={0.01} onChange={(v) => set("refraction", v)} />
          <Slider label={t("glassLab.bevel")} value={config.zRadius} min={4} max={450} step={1} onChange={(v) => set("zRadius", v)} />
          <Slider label={t("glassLab.radius")} value={config.cornerRadius} min={0} max={600} step={1} onChange={(v) => set("cornerRadius", v)} />
          <Slider label={t("glassLab.chroma")} value={config.chromAberration} min={0} max={1.5} step={0.005} onChange={(v) => set("chromAberration", v)} />
          <Slider label={t("glassLab.specular")} value={config.specular} min={0} max={10} step={0.05} onChange={(v) => set("specular", v)} />
          <Slider label={t("glassLab.fresnel")} value={config.fresnel} min={0} max={10} step={0.05} onChange={(v) => set("fresnel", v)} />
          <Slider label={t("glassLab.highlight")} value={config.edgeHighlight} min={0} max={10} step={0.05} onChange={(v) => set("edgeHighlight", v)} />
          <Slider label={t("glassLab.blur")} value={config.blurAmount} min={0} max={5} step={0.02} onChange={(v) => set("blurAmount", v)} />

          <div className={styles.actions}>
            <button type="button" className={styles.saveBtn} onClick={() => persistPresets([...presets, config])}>
              {t("glassLab.save")}
            </button>
            <button type="button" className={styles.resetBtn} onClick={() => setConfig(DEFAULT_CONFIG)}>
              {t("glassLab.reset")}
            </button>
          </div>

          {presets.length > 0 && (
            <div className={styles.presets}>
              {presets.map((p, i) => (
                <span key={i} className={styles.preset}>
                  <button type="button" className={styles.presetLoad} onClick={() => setConfig(p)}>
                    {t("glassLab.presetN", { n: i + 1 })}
                  </button>
                  <button
                    type="button"
                    className={styles.presetDel}
                    aria-label={t("glassLab.delPreset")}
                    onClick={() => persistPresets(presets.filter((_, idx) => idx !== i))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <p className={styles.hint}>{t("glassLab.hint")}</p>
        </aside>
      </div>
    </div>
  );
}

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}

function Slider({ label, value, min, max, step, onChange }: SliderProps) {
  const labelId = useId();
  return (
    <div className={styles.slider}>
      <span className={styles.sliderHead}>
        <span id={labelId}>{label}</span>
        <input
          className={styles.num}
          type="number"
          aria-labelledby={labelId}
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") return;
            const n = Number(raw);
            if (Number.isFinite(n)) onChange(clamp(n, min, max));
          }}
        />
      </span>
      <input
        className={styles.range}
        type="range"
        aria-labelledby={labelId}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(clamp(snap(Number(e.target.value), step), min, max))}
      />
    </div>
  );
}
