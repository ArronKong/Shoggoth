import type { ReactNode } from "react";
import inspirationIcon from "../assets/nav-icons/inspiration.svg";

// 导航图标的内联版本（R372）。
//
// 为什么不继续用 `<img src="…svg">`：刷新反馈要做成**每个图标自己的加载动画**
// （总览的卡片高低起伏、聊天的三点、看板的勾生长…），这些都得给 SVG 内部节点挂
// class + keyframes——外部 CSS 进不到 `<img>` 引用的隔离文档里。需要专属动画的这 9 个
// 内联；灵感直接用 Figma 导出的种子 SVG，在固定容器里做舒展回摆。设置仍走 `<img>`
// （整张图旋转就够，见 styles.css 里 `img.nav-icon`），玻璃/组件没有刷新登记，保持静止。
//
// stroke 照抄原文件的 `var(--stroke-0, black)`（该变量全站未定义，走 black fallback，
// 与 `<img>` 隔离文档里的表现一致），线宽/端点样式提到 <g> 上继承。深色反相仍由
// .nav-icon 的 filter 管。
//
// 描边粗细（R374）：1 → **1.2**，用户在三档对比页（1 / 1.5 / 2）里定的——1 在真机上偏
// 细，尤其深色下反相把描边压到 ~#d4d4d8、对比度还要再低一档。**只动了这一个参数**，
// 图形尺寸/路径/留白全未变。
// 圆点类元素（聊天三点、代理双眼）是 stroke-width 2 倍的圆头零长度路径，必须跟着等比
// 到 2.4，否则加粗后点会相对变小、比例失调。
// assets/nav-icons/*.svg 里 12 个源文件也同步到了 1.2/2.4——那些只服务仍是 `<img>` 的
// 图标，但保持一致才不会让人误以为实际渲染是 1。
const STROKE = {
  stroke: "var(--stroke-0, black)",
  strokeWidth: 1.2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};
/** 圆点类元素的描边：基础的 2 倍，与源文件的 stroke-width="2.4" 对齐。 */
const DOT_STROKE = 2.4;

type IconProps = { className?: string };

function Frame({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <svg
      className={className}
      preserveAspectRatio="none"
      overflow="visible"
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
    >
      <g {...STROKE}>{children}</g>
    </svg>
  );
}

// 总览：两列各一高一矮，刷新时每列内部高低互换。四块的 y+height 是配对写死的，
// 换算后两列跨度恒为 13→27、块间距恒为 2px——「总高度和间距不变」是硬约束。
function DashboardIcon({ className }: IconProps) {
  return (
    <Frame className={className}>
      <rect className="ni-card ni-card--tallA" x="13" y="13" width="6" height="9" rx="2" />
      <rect className="ni-card ni-card--tallB" x="21" y="18" width="6" height="9" rx="2" />
      <rect className="ni-card ni-card--shortB" x="21" y="13" width="6" height="3" rx="1.5" />
      <rect className="ni-card ni-card--shortA" x="13" y="24" width="6" height="3" rx="1.5" />
    </Frame>
  );
}

// 聊天：气泡不动，里面三个点依次跳（经典 typing indicator）。
function ChatIcon({ className }: IconProps) {
  return (
    <Frame className={className}>
      <path d="M12 19C12 15.6863 14.6863 13 18 13H22C25.3137 13 28 15.6863 28 19V21C28 24.3137 25.3137 27 22 27H12V19Z" />
      <path className="ni-dot ni-dot--1" d="M16 20H16.01" strokeWidth={DOT_STROKE} />
      <path className="ni-dot ni-dot--2" d="M20 20H20.01" strokeWidth={DOT_STROKE} />
      <path className="ni-dot ni-dot--3" d="M24 20H24.01" strokeWidth={DOT_STROKE} />
    </Frame>
  );
}

function InspirationIcon({ className }: IconProps) {
  return (
    <span className={`${className ?? ""} nav-icon--inspiration`} aria-hidden="true">
      <img className="ni-seed" src={inspirationIcon} width={16.565} height={17} alt="" />
    </span>
  );
}

// 看板：外框不动，里面的勾按笔顺生长。
function TasksIcon({ className }: IconProps) {
  return (
    <Frame className={className}>
      <path d="M24.4444 12H15.5556C13.5919 12 12 13.5919 12 15.5556V24.4444C12 26.4081 13.5919 28 15.5556 28H24.4444C26.4081 28 28 26.4081 28 24.4444V15.5556C28 13.5919 26.4081 12 24.4444 12Z" />
      <path className="ni-check" d="M16 20L19 23L25 17" />
    </Frame>
  );
}

// 定时任务：表盘不动，两根针各转整一圈（0.6s）；快慢差靠速度曲线而非圈数——分针匀速、
// 时针 ease-in 全程落后，详见 styles.css 的 ni-hand 段。
// 原文件里两根针是**一条折线** `M20 15V20L23 23`——要给两根不同速度曲线就必须拆开。
// 交点仍在表心 (20,20)，两个 round cap 叠在一起，与原本的 round join 视觉无异。
function CronIcon({ className }: IconProps) {
  return (
    <Frame className={className}>
      <path d="M20 29C24.9706 29 29 24.9706 29 20C29 15.0294 24.9706 11 20 11C15.0294 11 11 15.0294 11 20C11 24.9706 15.0294 29 20 29Z" />
      <path className="ni-minute" d="M20 20V15" />
      <path className="ni-hour" d="M20 20L23 23" />
    </Frame>
  );
}

// 代理：眼睛眨 + 头顶天线伸缩。天线杆以**根部**为原点做 scaleY（垂直线只改长度、
// 不改描边粗细），顶端的球同步位移到杆的新端点——杆长 4，scaleY 1.5 时顶端从 y=14
// 抬到 y=12，所以球正好走 -2px，两者始终连着。
function AgentsIcon({ className }: IconProps) {
  return (
    <Frame className={className}>
      <path d="M24 18H16C13.7909 18 12 19.7909 12 22V24C12 26.2091 13.7909 28 16 28H24C26.2091 28 28 26.2091 28 24V22C28 19.7909 26.2091 18 24 18Z" />
      <path className="ni-antenna" d="M20 18V14" />
      <path className="ni-bulb" d="M20 14C21.1046 14 22 13.1046 22 12C22 10.8954 21.1046 10 20 10C18.8954 10 18 10.8954 18 12C18 13.1046 18.8954 14 20 14Z" />
      <path className="ni-eye ni-eye--l" d="M16 22H16.01" strokeWidth={DOT_STROKE} />
      <path className="ni-eye ni-eye--r" d="M24 22H24.01" strokeWidth={DOT_STROKE} />
    </Frame>
  );
}

// Token 用量：圆圈不动，里面的货币符号绕垂直中心线做 3D 旋转一整圈。
// 实测（Chromium）：transform 落成 matrix3d 且保留 perspective 分量（m34 = ±1/90，
// 正好对应 perspective(90px)），半程 cosY 精确到 -1——是真 3D 旋转，不是被降级成
// 水平压缩。只是符号高约 11px，近大远小的纵深看起来会很微妙。后半圈显示镜像：
// 转满 360° 本该看到背面，物理上是对的。
function TokenIcon({ className }: IconProps) {
  return (
    <Frame className={className}>
      <path d="M20 29C24.9705 29 29 24.9705 29 20C29 15.0294 24.9705 11 20 11C15.0294 11 11 15.0294 11 20C11 24.9705 15.0294 29 20 29Z" />
      <path
        className="ni-symbol"
        d="M20 23.8019C21.3826 23.8516 22.7 23.1899 22.7 21.65C22.7 18.95 17.75 20.3 17.75 17.6C17.75 16.133 18.8128 15.5959 20 15.6278C20.9978 15.6547 22.0835 16.0835 22.7 16.7M20 15.6278V14M17.3 22.55C17.88 23.3234 18.9585 23.7645 20 23.8019M20 23.8019V25.7"
      />
    </Frame>
  );
}

// 模型：12 根引脚同时生长，外框与内框轻微缩放呼吸。
// 「线始终连着外框」是硬约束：外框和 12 根线放在**同一个 <g> 里一起缩放**，几何
// 关系就恒定不变，绝不会出现框缩了、线还钉在原处的脱开。内框单独缩放，幅度略大
// 一点做出层次。（引脚外端在 11/29，×1.05 后到 10.55/29.45，仍在 viewBox 内。）
const MODEL_PINS = [
  "M16 13V11", "M20 13V11", "M25 13V11",       // 上
  "M27 16H29", "M27 20H29", "M27 25H29",       // 右
  "M25 27V29", "M20 27V29", "M16 27V29",       // 下
  "M13 25H11", "M13 20H11", "M13 16H11",       // 左
];

function ModelsIcon({ className }: IconProps) {
  return (
    <Frame className={className}>
      <g className="ni-chip">
        <path d="M23.8889 13H16.1111C14.3929 13 13 14.3929 13 16.1111V23.8889C13 25.6071 14.3929 27 16.1111 27H23.8889C25.6071 27 27 25.6071 27 23.8889V16.1111C27 14.3929 25.6071 13 23.8889 13Z" />
        {MODEL_PINS.map((d) => (
          <path key={d} className="ni-pin" d={d} />
        ))}
      </g>
      <path className="ni-core" d="M21.6667 17H18.3333C17.597 17 17 17.597 17 18.3333V21.6667C17 22.403 17.597 23 18.3333 23H21.6667C22.403 23 23 22.403 23 21.6667V18.3333C23 17.597 22.403 17 21.6667 17Z" />
    </Frame>
  );
}

// 技能：两颗星一闪一闪（错相，不同时亮）。
function SkillsIcon({ className }: IconProps) {
  return (
    <Frame className={className}>
      <path
        className="ni-star ni-star--a"
        d="M16 23C20.8747 23 23 20.949 23 16C23 20.949 25.1104 23 30 23C25.1104 23 23 25.1104 23 30C23 25.1104 20.8747 23 16 23Z"
      />
      <path
        className="ni-star ni-star--b"
        d="M10 14.5C13.1338 14.5 14.5 13.1815 14.5 10C14.5 13.1815 15.8567 14.5 19 14.5C15.8567 14.5 14.5 15.8567 14.5 19C14.5 15.8567 13.1338 14.5 10 14.5Z"
      />
    </Frame>
  );
}

// CLI：终端框不动，提示符 `>` 闪烁 + 后面那行像敲字一样打出来再清掉。
function CliIcon({ className }: IconProps) {
  return (
    <Frame className={className}>
      <path d="M25 12H15C12.7909 12 11 13.5919 11 15.5556V24.4444C11 26.4081 12.7909 28 15 28H25C27.2091 28 29 26.4081 29 24.4444V15.5556C29 13.5919 27.2091 12 25 12Z" />
      <path className="ni-caret" d="M15 17L18 20L15 23" />
      <path className="ni-typeline" d="M21 23H25" />
    </Frame>
  );
}

/** 路由 → 专属动画图标组件。表里没有的项由 App.tsx 回落到 `<img src>`。 */
export const NAV_ICON_COMPONENTS: Record<string, (p: IconProps) => ReactNode> = {
  "/dashboard": DashboardIcon,
  "/chat": ChatIcon,
  "/inspirations": InspirationIcon,
  "/cron": CronIcon,
  "/tasks": TasksIcon,
  "/agents": AgentsIcon,
  "/token": TokenIcon,
  "/models": ModelsIcon,
  "/skills": SkillsIcon,
  "/cli": CliIcon,
};
