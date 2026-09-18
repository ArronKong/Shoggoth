// 纯展示 SVG 图表组件 + 数字格式化助手。手写零依赖（spec §4 用户拍板）。
// R162：参考 OpenRouter rankings 图表语言做的交互层——HTML 色点图例（hover
// 联动聚焦系列）、跟随指针的自定义 tooltip（全系列读数、值为主）、hover 光标带。
// R197：按 Figma 6994-135 严格还原视觉层——去掉 y 轴刻度/网格线/均值线/末点
// 胶囊/成本副轴等图表装饰，堆叠柱改细柱半圆顶（黑/品牌黄/灰，值在
// UsagePage.css 的 --uc-*），排行条改 4px 黑条；tooltip/hover 交互层保持不变。
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Meter } from "@base-ui/react/meter";

export const fmtTokens = (n: number): string =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)}B`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)}M`
      : n >= 1e3
        ? `${(n / 1e3).toFixed(1)}K`
        : String(Math.round(n));

export const fmtCost = (n: number): string => `$${n.toFixed(2)}`;

export const fmtMs = (ms: number): string =>
  ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : ms >= 1_000 ? `${(ms / 1_000).toFixed(1)}s` : `${Math.round(ms)}ms`;

// 模型堆叠图的 8 色序列（固定顺序不循环重排；变量定义在 pages/usage/UsagePage.css）
export const SERIES_COLORS = [
  "var(--uc-c0)",
  "var(--uc-c1)",
  "var(--uc-c2)",
  "var(--uc-c3)",
  "var(--uc-c4)",
  "var(--uc-c5)",
  "var(--uc-c6)",
  "var(--uc-c7)",
];

interface Pt {
  x: number;
  y: number;
}

// 单调三次插值（Fritsch–Carlson，d3 curveMonotone 同款）：平滑但数学保证
// 段内单调、绝不过冲——曲线只经过真实数据点、相邻两点间不鼓出假峰（R216
// 换掉 Catmull-Rom：后者为求圆滑会在两点间过冲，鼓出比数据颗粒更细的假峰，
// 用户实测「07-13/14 之间有个 hover 选不到的峰」即此）。clampY 仍兜底夹绘图带。
export function smoothPath(pts: Pt[], clampY?: [number, number]): string {
  if (pts.length < 2) return "";
  const cl = (v: number) => (clampY ? Math.min(Math.max(v, clampY[0]), clampY[1]) : v);
  const n = pts.length;
  const dx: number[] = [];
  const slope: number[] = []; // 相邻点割线斜率
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1].x - pts[i].x || 1;
    slope[i] = (pts[i + 1].y - pts[i].y) / dx[i];
  }
  const m: number[] = new Array(n); // 各点切线斜率
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    // 局部极值（左右割线变号）切线取 0：峰谷处平滑落点、不冲过头
    m[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  }
  // Fritsch–Carlson 约束：切线不超过割线 3 倍，杜绝过冲
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / slope[i];
    const b = m[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * slope[i];
      m[i + 1] = t * b * slope[i];
    }
  }
  // 受控过冲混合（用户拍板「还想更圆」，接受轻微假峰回归）：把切线向无约束的
  // Catmull-Rom 中心差分回混 SMOOTH 比例。0=严格单调（峰谷切线0+3倍割线帽，
  // 绝不过冲）；1=全 Catmull-Rom（最圆，但两点间鼓出 hover 选不到的假峰）。
  // 过冲幅度随系数线性可控；clampY 仍兜底不越绘图带。
  const SMOOTH = 0.35;
  for (let i = 0; i < n; i++) {
    const cr = i === 0 ? slope[0] : i === n - 1 ? slope[n - 2] : (slope[i - 1] + slope[i]) / 2;
    m[i] += (cr - m[i]) * SMOOTH;
  }
  // 控制点水平距离比例：>1/3 让转角（尤其峰顶）圆弧更宽更圆润；只拉 x 方向、
  // 0.5 = 几何上限（两侧控制点到段中点），再大控制点交叉曲线开始变形。
  const KX = 0.5;
  const d: string[] = [`M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`];
  for (let i = 0; i < n - 1; i++) {
    const c1x = pts[i].x + dx[i] * KX;
    const c1y = cl(pts[i].y + (m[i] * dx[i]) / 3);
    const c2x = pts[i + 1].x - dx[i] * KX;
    const c2y = cl(pts[i + 1].y - (m[i + 1] * dx[i]) / 3);
    d.push(
      `C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${pts[i + 1].x.toFixed(2)} ${pts[i + 1].y.toFixed(2)}`,
    );
  }
  return d.join(" ");
}

// 顶部圆角矩形（整根堆叠柱的圆顶剪裁形）；r 受柱宽/柱高约束防反弧。
function topRoundedRect(xx: number, yy: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return [
    `M ${xx.toFixed(2)} ${(yy + h).toFixed(2)}`,
    `L ${xx.toFixed(2)} ${(yy + rr).toFixed(2)}`,
    `Q ${xx.toFixed(2)} ${yy.toFixed(2)}, ${(xx + rr).toFixed(2)} ${yy.toFixed(2)}`,
    `L ${(xx + w - rr).toFixed(2)} ${yy.toFixed(2)}`,
    `Q ${(xx + w).toFixed(2)} ${yy.toFixed(2)}, ${(xx + w).toFixed(2)} ${(yy + rr).toFixed(2)}`,
    `L ${(xx + w).toFixed(2)} ${(yy + h).toFixed(2)}`,
    "Z",
  ].join(" ");
}

export interface ChartSeries {
  label: string;
  color: string; // CSS 颜色（约定传 var(--uc-*) 引用，图例色点与 SVG 填充共用）
}

export interface StackBucket {
  key: string;
  label: string;
  parts: number[]; // 与 series 一一对应的堆叠段
}

// —— hover tooltip / 图例（OpenRouter 式交互层，三个图表共用） ——

interface TipRow {
  color?: string;
  label: string;
  value: string;
}

interface TipState {
  x: number;
  y: number;
  flip: boolean; // 指针过容器中线后向左翻，防止溢出
  title: string;
  rows: TipRow[];
  foot?: TipRow[];
}

function ChartTip({ tip }: { tip: TipState }) {
  return (
    <div className={tip.flip ? "uc-tip uc-tip--flip" : "uc-tip"} style={{ left: tip.x, top: tip.y }}>
      <div className="uc-tip-title">{tip.title}</div>
      {tip.rows.map((r, i) => (
        <div className="uc-tip-row" key={`${r.label}-${i}`}>
          {r.color && <span className="uc-tip-key" style={{ background: r.color }} />}
          <span className="uc-tip-label">{r.label}</span>
          <span className="uc-tip-v">{r.value}</span>
        </div>
      ))}
      {tip.foot && tip.foot.length > 0 && (
        <div className="uc-tip-foot">
          {tip.foot.map((r, i) => (
            <div className="uc-tip-row" key={`${r.label}-${i}`}>
              <span className="uc-tip-label">{r.label}</span>
              <span className="uc-tip-v">{r.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface LegendItem {
  label: string;
  color: string;
}

// HTML 图例：色键 + 名称，hover 聚焦对应系列（其余淡出）。仅按模型堆叠图使用。
function ChartLegend({
  items,
  focus,
  onFocus,
}: {
  items: LegendItem[];
  focus: number | null;
  onFocus: (i: number | null) => void;
}) {
  return (
    <div className="uc-legend" onMouseLeave={() => onFocus(null)}>
      {items.map((it, i) => (
        <span
          key={`${it.label}-${i}`}
          className={focus != null && focus !== i ? "uc-legend-item uc-fade" : "uc-legend-item"}
          onMouseEnter={() => onFocus(i)}
        >
          <span className="uc-sw" style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

// 容器级指针跟踪：tooltip 用容器内像素坐标定位（与 SVG viewBox 缩放无关）。
function useTipPos() {
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0, flip: false });
  const onMove = (e: ReactMouseEvent) => {
    const r = boxRef.current?.getBoundingClientRect();
    if (!r) return;
    const x = e.clientX - r.left;
    setPos({ x, y: e.clientY - r.top, flip: x > r.width * 0.55 });
  };
  return { boxRef, pos, onMove };
}

// 容器实测尺寸（ResizeObserver）：图表 viewBox 用它 1:1 渲染,内容(柱宽/字号/线宽)
// 像素恒定,窗口拉宽只变横向间距、不等比放大;高度由卡片布局固定(R210)。
function useSize(boxRef: { current: Element | null }, svgRef: { current: Element | null }) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    // 观察 HTML 容器(div,ResizeObserver 可靠)取宽;高取 svg 实际渲染高(flex 撑)。
    // 直接 observe SVG 元素在 Chromium 下 resize 后不稳定触发,故观察 div。
    const update = () => setSize({ w: box.clientWidth, h: svgRef.current?.clientHeight ?? 0 });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(box);
    return () => ro.disconnect();
  }, [boxRef, svgRef]);
  return size;
}

const calmed = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// 生长动效（R238）：图表首次进视口时从零长到终态，换一套数据（切时间范围/tab）
// 重播一次。时长/缓动对齐 UsagePage.tsx 的 CountUp（900ms / easeOutCubic），
// 让「左边数字滚动 + 右边图表生长」踩同一个节拍。
//
// 三态而非两态：""=不播(prefers-reduced-motion，直接终态)、wait=零态待播、
// grow=播放。必须有 wait 这一帧——否则滚到时会先看见终态再被打回零态重长。
// 重播靠 grow→wait→grow 的 class 切换（移除再添加 animation 是重放的可靠手段，
// 改属性不会重放）；IO 在元素仍处视口时重新 observe 会立刻再次回调，故无需手动排程。
export function useGrow(boxRef: { current: Element | null }, sig: string): (kind: string) => string {
  // 初值也要判：默认 "wait" 会让 reduced-motion 用户先吃一帧零态空白再跳终态。
  const [st, setSt] = useState<"wait" | "grow" | "">(() => (calmed() ? "" : "wait"));
  useEffect(() => {
    if (calmed()) {
      setSt("");
      return;
    }
    const box = boxRef.current;
    if (!box) return;
    setSt("wait");
    const io = new IntersectionObserver(
      (es) => {
        if (!es.some((e) => e.isIntersecting)) return;
        io.disconnect(); // 只长一次，回滚上去不重播
        setSt("grow");
      },
      { threshold: 0.15 },
    );
    io.observe(box);
    return () => io.disconnect();
  }, [boxRef, sig]);
  // kind 区分生长形态（bar/line/area/…），各自 keyframes 在 UsagePage.css。
  return (kind: string) => (st ? `uc-${st}-${kind}` : "");
}

// x 轴日期标签：step 采样 + 末点必标（与末点太近的采样点让位防叠字）。
// 设计稿无末点胶囊，一律平文本；首标左对齐、末标右对齐防出画布。
function XLabels({
  n,
  x,
  half,
  step,
  h,
  fx,
  labelOf,
  bottomGap = 10,
}: {
  n: number;
  x: (i: number) => number;
  half: number; // 柱半宽（折线图传 0）
  step: number;
  h: number;
  fx: number;
  labelOf: (i: number) => string;
  bottomGap?: number; // x 轴标签基线距底距离（默认 10；hero 传 2 使日期贴底对齐左侧统计）
}) {
  const items: ReactNode[] = [];
  for (let i = 0; i < n; i++) {
    const isLast = i === n - 1;
    const sampled = i % step === 0 && n - 1 - i >= Math.ceil(step * 0.75);
    if (!isLast && !sampled) continue;
    items.push(
      <text
        key={i}
        x={isLast ? x(i) + half : i === 0 ? x(i) - half : x(i)}
        y={h - bottomGap}
        className="uc-xlabel"
        fontSize={fx}
        textAnchor={isLast ? "end" : i === 0 ? "start" : "middle"}
      >
        {labelOf(i)}
      </text>,
    );
  }
  return <>{items}</>;
}

// 堆叠柱（Figma 6994-135）：细柱 + 最上段半圆顶，无坐标轴装饰。
// 用量趋势（hero 卡）/ 按模型趋势共用；w/h 定 viewBox 比例（600 窄幅 / 1188 全宽）。
export function StackedBars({
  buckets,
  series,
  w = 760,
  h = 260,
  legend,
  minSeg = 0,
  contentShiftY = 0,
}: {
  buckets: StackBucket[];
  series: ChartSeries[];
  w?: number;
  h?: number;
  /** 渲染 HTML 图例（仅多模型堆叠需要；hero 三色构成靠 tooltip 自明） */
  legend?: boolean;
  /** 非零段的最小可见高度（viewBox 单位）。hero 趋势图用：输出占比极小时
   *  黄条仍像设计稿一样可见（多扣回最高段，总高不变；真值在 tooltip）。 */
  minSeg?: number;
  /** hero 卡专用：柱区整体下移量（P.t+/P.b−，柱高不变），配合 x 轴 bottomGap
   *  使柱+日期一起下移、贴底对齐左侧统计，间距不变。 */
  contentShiftY?: number;
}) {
  const { t } = useTranslation();
  const { boxRef, pos, onMove } = useTipPos();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hi, setHi] = useState<number | null>(null); // hover 的 bucket
  const [fs, setFs] = useState<number | null>(null); // 图例聚焦：series 下标
  // 圆顶 clipPath 的 id 前缀：多图实例不串（必须在条件 return 之前调用）。
  const gid = useId().replace(/[^a-zA-Z0-9_-]/g, "g");
  const { w: mw, h: mh } = useSize(boxRef, svgRef);
  // 数据签名：桶数/首尾日期/系列名——切时间范围或 tab 必变，同范围刷新不变（不白重播）。
  const growCls = useGrow(
    boxRef,
    `${buckets.length}:${buckets[0]?.key ?? ""}:${buckets[buckets.length - 1]?.key ?? ""}:${series.map((s) => s.label).join(",")}`,
  );
  if (buckets.length === 0) return <p className="muted">{t("usage.noRangeData")}</p>;
  const W = Math.round(mw) || w;
  const H = Math.round(mh) || h;
  const P = { l: 8, r: 8, t: 6 + contentShiftY, b: 30 - contentShiftY };
  const iw = W - P.l - P.r;
  const ih = H - P.t - P.b;
  const n = buckets.length;
  const max = Math.max(1, ...buckets.map((b) => b.parts.reduce((s, v) => s + v, 0)));
  const colW = iw / Math.max(1, n);
  // 设计稿柱宽 12px（30 桶：hero 20px 步距 / 全宽 40px 步距下同为 12），桶多时收窄。
  const bw = Math.max(2, Math.min(12, colW * 0.6));
  const x = (i: number) => P.l + bw / 2 + (n <= 1 ? (iw - bw) / 2 : (i / (n - 1)) * (iw - bw));
  // 标签数随实测宽自适应（每枚 ~52px），窄幅(手机)自动减少防挤叠；上限 8 同设计稿
  const step = Math.max(1, Math.ceil(n / Math.max(2, Math.min(8, Math.floor(iw / 52)))));
  const fx = W <= 700 ? 10 : 12; // 轴标签字号随图幅（hero 10px / 全宽 12px，同设计稿）
  // 图例聚焦时其余系列淡出；无聚焦一律全饱和（设计稿平铺单色调）。
  const segOp = (si: number) => (fs != null ? (fs === si ? 1 : 0.1) : 1);

  const hover = hi != null && hi < n ? buckets[hi] : null;
  const tip: TipState | null = hover
    ? (() => {
        const rows = series
          .map((s, si) => ({ color: s.color, label: s.label, value: fmtTokens(hover.parts[si] ?? 0), v: hover.parts[si] ?? 0 }))
          .filter((r) => r.v > 0);
        const foot: TipRow[] = [];
        const total = hover.parts.reduce((s, v) => s + v, 0);
        if (rows.length > 1) foot.push({ label: t("usage.totalTokens"), value: fmtTokens(total) });
        return { ...pos, title: hover.key, rows, foot };
      })()
    : null;

  return (
    <div className="uc-box" ref={boxRef} onMouseMove={onMove} onMouseLeave={() => setHi(null)}>
      <svg ref={svgRef} className="usage-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img">
        {hi != null && hi < n && (
          <rect x={x(hi) - colW / 2} y={P.t} width={colW} height={ih} className="uc-cursor" />
        )}
        {buckets.map((b, i) => {
          // 段高：先按真值算，再把非零小段抬到 minSeg、从高段扣回（总高不变）。
          const hs = b.parts.map((v) => (v > 0 ? (v / max) * ih : 0));
          if (minSeg > 0) {
            let deficit = 0;
            for (let si = 0; si < hs.length; si++) {
              if (hs[si] > 0 && hs[si] < minSeg) {
                deficit += minSeg - hs[si];
                hs[si] = minSeg;
              }
            }
            for (const si of hs.map((_, k) => k).sort((a2, b2) => hs[b2] - hs[a2])) {
              if (deficit <= 0) break;
              const give = Math.min(deficit, hs[si] - minSeg);
              if (give > 0) {
                hs[si] -= give;
                deficit -= give;
              }
            }
          }
          let yy = P.t + ih;
          const segs = hs.map((sh, si) => {
            yy -= sh;
            return { si, y1: yy, h: sh };
          });
          const stackH = P.t + ih - yy; // 调整后的整柱高度（yy 已走到柱顶）
          if (stackH <= 0) return null;
          const left = x(i) - bw / 2;
          const clipId = `${gid}-b${i}`;
          return (
            // 生长：整根柱（含圆顶 clip）一起 scaleY，逐根错峰——clip 与被裁内容
            // 同处这层 transform 下，一起缩放，半圆头不会在动画中变形。
            <g key={b.key} className={growCls("bar")} style={{ "--i": i } as CSSProperties}>
              {/* 圆顶属于整根柱：rounded clip 统一裁出半圆头，段一律方角矩形。
                  顶段再薄也不退化成直角（半径只受整柱高度约束，与设计稿一致）。 */}
              <clipPath id={clipId}>
                <path d={topRoundedRect(left, yy, bw, stackH, bw / 2)} />
              </clipPath>
              <g clipPath={`url(#${clipId})`}>
                {segs.map((sg) =>
                  sg.h <= 0 ? null : (
                    <rect
                      key={sg.si}
                      x={left}
                      y={sg.y1}
                      width={bw}
                      height={sg.h}
                      fill={series[sg.si].color}
                      className="uc-seg"
                      opacity={segOp(sg.si)}
                    />
                  ),
                )}
              </g>
            </g>
          );
        })}
        <XLabels n={n} x={x} half={bw / 2} step={step} h={H} fx={fx} labelOf={(i) => buckets[i].label} bottomGap={2} />
        {buckets.map((b, i) => (
          <rect
            key={`h${b.key}`}
            x={x(i) - colW / 2}
            y={P.t}
            width={colW}
            height={ih}
            fill="transparent"
            onMouseEnter={() => setHi(i)}
          />
        ))}
      </svg>
      {legend && (
        <ChartLegend items={series.map((s) => ({ label: s.label, color: s.color }))} focus={fs} onFocus={setFs} />
      )}
      {tip && <ChartTip tip={tip} />}
    </div>
  );
}

// 100% 堆叠面积（按模型份额，Usage by model 用户拍板形态）：每列归一化到 100%，
// 看构成漂移（谁在蚕食谁）；绝对量由 hero 卡承担，tooltip 仍给原始 token 兜底。
// percent=false 时为绝对量堆叠面积。平滑用 smoothPath；band 上沿曲线 + 下沿反向闭合。
export function StackedArea({
  buckets,
  series,
  w = 1188,
  h = 246,
  percent = false,
  legend = false,
}: {
  buckets: StackBucket[];
  series: ChartSeries[];
  w?: number;
  h?: number;
  /** 每列归一化到 100%（份额视图）；false 为绝对量堆叠面积 */
  percent?: boolean;
  legend?: boolean;
}) {
  const { t } = useTranslation();
  const { boxRef, pos, onMove } = useTipPos();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hi, setHi] = useState<number | null>(null); // hover 的日期列
  const [fs, setFs] = useState<number | null>(null); // 图例聚焦：series 下标
  const { w: mw, h: mh } = useSize(boxRef, svgRef);
  const growCls = useGrow(
    boxRef,
    `${buckets.length}:${buckets[0]?.key ?? ""}:${buckets[buckets.length - 1]?.key ?? ""}:${series.map((s) => s.label).join(",")}`,
  );
  if (buckets.length === 0) return <p className="muted">{t("usage.noRangeData")}</p>;
  const W = Math.round(mw) || w;
  const H = Math.round(mh) || h;
  const P = { l: 8, r: 8, t: 8, b: 30 };
  const iw = W - P.l - P.r;
  const ih = H - P.t - P.b;
  const n = buckets.length;
  const base = P.t + ih;
  const x = (i: number) => P.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  // 标签数随实测宽自适应（每枚 ~52px），窄幅(手机)自动减少防挤叠；上限 8 同设计稿
  const step = Math.max(1, Math.ceil(n / Math.max(2, Math.min(8, Math.floor(iw / 52)))));
  const fx = W <= 700 ? 10 : 12;

  const totals = buckets.map((b) => b.parts.reduce((s, v) => s + Math.max(0, v), 0));
  const norm = (i: number, v: number) => (percent ? (totals[i] > 0 ? Math.max(0, v) / totals[i] : 0) : Math.max(0, v));
  // cum[i][k] = 第 i 列前 k+1 段的累积高度（percent 下累积到 1）。
  const cum = buckets.map((b, i) => {
    let acc = 0;
    return b.parts.map((v) => (acc += norm(i, v)));
  });
  const max = percent ? 1 : Math.max(1, ...totals);
  const y = (v: number) => P.t + ih - (v / max) * ih;

  // 第 k 段的面积带：上沿=cum[k] 平滑曲线，下沿=cum[k-1] 反向闭合（k=0 落基线）。
  const bandPath = (k: number): string => {
    const top = cum.map((c, i) => ({ x: x(i), y: y(c[k]) }));
    const under = k === 0 ? null : cum.map((c, i) => ({ x: x(i), y: y(c[k - 1]) })).reverse();
    const topD = smoothPath(top, [P.t, base]);
    if (!under) return `${topD} L ${x(n - 1).toFixed(2)} ${base} L ${x(0).toFixed(2)} ${base} Z`;
    return `${topD} ${smoothPath(under, [P.t, base]).replace(/^M/, "L")} Z`;
  };

  const colW = iw / Math.max(1, n);
  const hover = hi != null && hi < n ? buckets[hi] : null;
  const tip: TipState | null = hover
    ? (() => {
        const rows = series
          .map((s, si) => ({
            color: s.color,
            label: s.label,
            value: percent
              ? `${(norm(hi as number, hover.parts[si] ?? 0) * 100).toFixed(1)}%`
              : fmtTokens(hover.parts[si] ?? 0),
            v: hover.parts[si] ?? 0,
          }))
          .filter((r) => r.v > 0);
        // 份额图丢了绝对量：footer 恒补当列总 token。
        const foot: TipRow[] = rows.length > 0 ? [{ label: t("usage.totalTokens"), value: fmtTokens(totals[hi as number]) }] : [];
        return { ...pos, title: hover.key, rows, foot };
      })()
    : null;
  const segOp = (si: number) => (fs != null ? (fs === si ? 1 : 0.1) : 1);

  return (
    <div className="uc-box" ref={boxRef} onMouseMove={onMove} onMouseLeave={() => setHi(null)}>
      <svg ref={svgRef} className="usage-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img">
        {hi != null && hi < n && <line x1={x(hi)} y1={P.t} x2={x(hi)} y2={base} className="uc-cross" />}
        {/* 生长：整叠一起从基线 scaleY 撑开（逐条各自缩放会彼此错位，堆叠面积必须整组动） */}
        <g className={growCls("area")}>
          {series.map((s, si) => (
            <path key={`${s.label}-${si}`} className="uc-seg" d={bandPath(si)} fill={s.color} opacity={segOp(si)} />
          ))}
        </g>
        <XLabels n={n} x={x} half={0} step={step} h={H} fx={fx} labelOf={(i) => buckets[i].label} />
        {buckets.map((b, i) => (
          <rect
            key={`h${b.key}`}
            x={x(i) - colW / 2}
            y={P.t}
            width={colW}
            height={ih}
            fill="transparent"
            onMouseEnter={() => setHi(i)}
          />
        ))}
      </svg>
      {legend && <ChartLegend items={series.map((s) => ({ label: s.label, color: s.color }))} focus={fs} onFocus={setFs} />}
      {tip && <ChartTip tip={tip} />}
    </div>
  );
}

export interface LinePoint {
  label: string;
  full?: string; // tooltip 标题用的完整日期（label 通常已截短）
  values: (number | null)[];
}

// 多序列折线（每日活动 消息/工具/错误）：曲线 + 渐变面积 + 末端锚点，无坐标轴装饰。
export function MultiLine({
  points,
  series,
  yFmt,
  w = 760,
  h = 220,
  legend = false,
}: {
  points: LinePoint[];
  series: ChartSeries[];
  yFmt: (n: number) => string;
  w?: number;
  h?: number;
  /** 渲染 HTML 图例（多系列如按模型必需；hover 聚焦对应线其余淡出） */
  legend?: boolean;
}) {
  const { t } = useTranslation();
  const { boxRef, pos, onMove } = useTipPos();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hi, setHi] = useState<number | null>(null);
  const [fs, setFs] = useState<number | null>(null); // 图例聚焦：series 下标
  // 渐变 id 前缀：useId 去掉非法字符，保证多图实例不串色（必须在条件 return 之前调用）。
  const gid = useId().replace(/[^a-zA-Z0-9_-]/g, "g");
  const { w: mw, h: mh } = useSize(boxRef, svgRef);
  const growCls = useGrow(
    boxRef,
    `${points.length}:${points[0]?.label ?? ""}:${points[points.length - 1]?.label ?? ""}:${series.map((s) => s.label).join(",")}`,
  );
  if (points.length === 0) return <p className="muted">{t("usage.noRangeData")}</p>;
  const W = Math.round(mw) || w;
  const H = Math.round(mh) || h;
  const P = { l: 8, r: 8, t: 8, b: 30 };
  const iw = W - P.l - P.r;
  const ih = H - P.t - P.b;
  const n = points.length;
  const max = Math.max(1, ...points.flatMap((p) => p.values.map((v) => v ?? 0)));
  const x = (i: number) => P.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => P.t + ih - (v / max) * ih;
  const base = P.t + ih;
  const colW = iw / Math.max(1, n);
  // 标签数随实测宽自适应（每枚 ~52px），窄幅(手机)自动减少防挤叠；上限 8 同设计稿
  const step = Math.max(1, Math.ceil(n / Math.max(2, Math.min(8, Math.floor(iw / 52)))));
  const fx = W <= 700 ? 10 : 12;
  // 按 null 切段：每段独立平滑（顺带修掉旧 polyline 跨空档直连的问题）。
  const runsOf = (si: number): Pt[][] => {
    const runs: Pt[][] = [];
    let cur: Pt[] = [];
    points.forEach((p, i) => {
      const v = p.values[si];
      if (v == null) {
        if (cur.length) runs.push(cur);
        cur = [];
      } else {
        cur.push({ x: x(i), y: y(v) });
      }
    });
    if (cur.length) runs.push(cur);
    return runs;
  };

  const hover = hi != null && hi < n ? points[hi] : null;
  const tip: TipState | null = hover
    ? {
        ...pos,
        title: hover.full ?? hover.label,
        // 悬浮层按当前值降序、隐藏 0/空行（用户拍板：不再按系列固定顺序）
        rows: series
          .map((s, si) => ({ color: s.color, label: s.label, v: hover.values[si] }))
          .filter((r) => r.v != null && (r.v as number) > 0)
          .sort((a, b) => (b.v as number) - (a.v as number))
          .map((r) => ({ color: r.color, label: r.label, value: yFmt(r.v as number) })),
      }
    : null;
  const segOp = (si: number) => (fs != null ? (fs === si ? 1 : 0.1) : 1);

  return (
    <div className="uc-box" ref={boxRef} onMouseMove={onMove} onMouseLeave={() => setHi(null)}>
      <svg ref={svgRef} className="usage-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img">
        <defs>
          {/* 曲线下渐变面积（stop-color 直接吃 series.color） */}
          {series.map((s, si) => (
            <linearGradient key={`${s.label}${si}`} id={`${gid}-g${si}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" style={{ stopColor: s.color, stopOpacity: 0.18 }} />
              <stop offset="1" style={{ stopColor: s.color, stopOpacity: 0 }} />
            </linearGradient>
          ))}
        </defs>
        {hi != null && hi < n && <line x1={x(hi)} y1={P.t} x2={x(hi)} y2={base} className="uc-cross" />}
        {series.map((s, si) => (
          // --i 逐条错峰；生长 class 在子元素上各取所需（线描边/面积淡入/点弹出）。
          <g key={`${s.label}-${si}`} className="uc-seg" opacity={segOp(si)} style={{ "--i": si } as CSSProperties}>
            {runsOf(si).map((run, ri) => (
              <g key={ri}>
                {run.length > 1 && (
                  <path
                    className={growCls("fill")}
                    fill={`url(#${gid}-g${si})`}
                    d={`${smoothPath(run, [P.t, base])} L ${run[run.length - 1].x.toFixed(2)} ${base} L ${run[0].x.toFixed(2)} ${base} Z`}
                  />
                )}
                {run.length > 1 ? (
                  // pathLength=1 把路径长度归一化，dashoffset 1→0 即「从头描到尾」，
                  // 不用测真实长度（getTotalLength 要 DOM，实测在 React 里必然慢一帧）。
                  <path className={`uc-l ${growCls("line")}`} pathLength={1} stroke={s.color} d={smoothPath(run, [P.t, base])} />
                ) : (
                  <circle className={growCls("dot")} fill={s.color} cx={run[0].x} cy={run[0].y} r={3} />
                )}
              </g>
            ))}
            {(() => {
              // 末端常显圆点：当前值锚点（设计稿右缘三色圆点）。
              for (let i = n - 1; i >= 0; i--) {
                const v = points[i].values[si];
                if (v != null) {
                  // 末端锚点跟着线一起入场（hover 点是交互产物，不参与生长）。
                  return <circle className={`uc-dot ${growCls("dot")}`} fill={s.color} cx={x(i)} cy={y(v)} r={3.5} />;
                }
              }
              return null;
            })()}
            {hi != null && hi < n && points[hi].values[si] != null && (
              <circle className="uc-dot" fill={s.color} cx={x(hi)} cy={y(points[hi].values[si] as number)} r={4} />
            )}
          </g>
        ))}
        <XLabels n={n} x={x} half={0} step={step} h={H} fx={fx} labelOf={(i) => points[i].label} />
        {points.map((p, i) => (
          <rect
            key={`h${p.label}${i}`}
            x={x(i) - colW / 2}
            y={P.t}
            width={colW}
            height={ih}
            fill="transparent"
            onMouseEnter={() => setHi(i)}
          />
        ))}
      </svg>
      {legend && <ChartLegend items={series.map((s) => ({ label: s.label, color: s.color }))} focus={fs} onFocus={setFs} />}
      {tip && <ChartTip tip={tip} />}
    </div>
  );
}

export interface RankRow {
  label: string;
  value: number;
  /** hover 浮层明细行（与图表 tooltip 同一壳）；不传则该行无浮层。 */
  tipRows?: { label: string; value: string }[];
}

// 排行条（Figma 6994-135）：名称 + 右对齐读数一行，下压 4px 黑色进度条。
export function RankBars({
  rows,
  totalValue,
  fmt = fmtTokens,
}: {
  rows: RankRow[];
  /** 完整排行总量；列表截断为 top N 时仍用它计算真实占比。 */
  totalValue?: number;
  fmt?: (n: number) => string;
}) {
  const { t } = useTranslation();
  const { boxRef, pos, onMove } = useTipPos();
  const [hi, setHi] = useState<number | null>(null); // hover 的行
  const growCls = useGrow(boxRef, `${rows.length}:${rows.map((r) => r.label).join(",")}`);
  if (rows.length === 0) return <p className="muted">{t("usage.noData")}</p>;
  const max = Math.max(1, ...rows.map((r) => r.value));
  const total = (totalValue ?? rows.reduce((s, r) => s + r.value, 0)) || 1;
  const hovered = hi != null ? rows[hi] : null;
  return (
    <div className="rank" ref={boxRef} onMouseMove={onMove} onMouseLeave={() => setHi(null)}>
      {rows.map((r, i) => (
        // key 用 label+index：label（模型名等）跨 provider 可能重名，单用 label 会
        // 触发 React duplicate key（实测 token 页 deepseek-v4-flash 重复）。
        <Meter.Root
          key={`${r.label}-${i}`}
          className="rank-row"
          value={r.value}
          max={max}
          onMouseEnter={() => setHi(i)}
        >
          <div className="rank-head">
            <Meter.Label className="rank-name" title={r.label}>
              {r.label}
            </Meter.Label>
            <span className="rank-val">
              {fmt(r.value)} · {((r.value / total) * 100).toFixed(1)}%
            </span>
          </div>
          <Meter.Track className="rank-bar">
            {/* 生长：条从左伸展（--i 逐行错峰）。base-ui 用 inline width 定长度，
                这里只叠一层 scaleX，不碰它算出来的宽度。 */}
            <Meter.Indicator className={`rank-fill ${growCls("rank")}`} style={{ "--i": i } as CSSProperties} />
          </Meter.Track>
        </Meter.Root>
      ))}
      {hovered?.tipRows && (
        <ChartTip tip={{ x: pos.x, y: pos.y, flip: pos.flip, title: hovered.label, rows: hovered.tipRows }} />
      )}
    </div>
  );
}
