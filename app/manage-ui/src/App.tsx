import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useInspirationReturnTarget } from "./lib/inspiration-navigation";
import agentsIcon from "./assets/nav-icons/agents.svg";
import inspirationIcon from "./assets/nav-icons/inspiration.svg";
import chatIcon from "./assets/nav-icons/chat.svg";
import cliIcon from "./assets/nav-icons/cli.svg";
import componentsIcon from "./assets/nav-icons/components.svg";
import cronIcon from "./assets/nav-icons/cron.svg";
import dashboardIcon from "./assets/nav-icons/dashboard.svg";
import modelsIcon from "./assets/nav-icons/models.svg";
import pluginsIcon from "./assets/nav-icons/plugins.svg";
import settingsIcon from "./assets/nav-icons/settings.svg";
import skillsIcon from "./assets/nav-icons/skills.svg";
import tokenIcon from "./assets/nav-icons/token.svg";
import DebugInspector from "./components/debug/DebugInspector";
import FusionLoader from "./components/FusionLoader";
import Notifier from "./components/Notifier";
import ScrollbarProvider from "./components/ScrollbarProvider";
import SetupOverlay from "./components/SetupOverlay";
import { useToast } from "./components/ui";
import { getShoggothProductStatus } from "./api/client";
import { useDebugEnabled } from "./components/debug/store";
import {
  INITIAL_AGENT_SERVICE_RESTART_STATE,
  observeAgentService,
} from "./lib/agentServiceRestart";
import { useNavigationRequest } from "./lib/navigation-guard";
import { runPageRefresh, useHasPageRefresh, usePageLoading } from "./lib/page-refresh";
import { NAV_ICON_COMPONENTS } from "./components/NavIcons";
import { installProductActivityListener } from "./lib/productTelemetry";
import { loadInspirationFonts } from "./pages/inspiration-fonts";

// Chat is loaded on its first visit, then App keeps that mounted instance across
// routes. A direct Dashboard/Settings launch therefore does not download the
// markdown/chat runtime, while leaving and returning to Chat still preserves its
// WebSocket/session state.
const ChatPage = lazy(() => import("./pages/ChatPage"));
const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const InspirationPage = lazy(async () => {
  const page = await import("./pages/InspirationPage");
  await loadInspirationFonts();
  return page;
});
const CronPage = lazy(() => import("./pages/CronPage"));
const ComponentsPage = lazy(() => import("./pages/ComponentsPage"));
const TasksPage = lazy(() => import("./pages/FederatedTasksPage"));
const ModelsPage = lazy(() => import("./pages/ModelsPage"));
const UsagePage = lazy(() => import("./pages/UsagePage"));
const SkillsPage = lazy(() => import("./pages/SkillsPage"));
const PluginsPage = lazy(() => import("./pages/PluginsPage"));
const CliPage = lazy(() => import("./pages/CliPage"));
const AgentsPage = lazy(() => import("./pages/AgentsPage"));
const GlassLab = lazy(() => import("./pages/GlassLab"));
const TurnLabPage = lazy(() => import("./pages/turnlab/TurnLabPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));

type NavEntry = { to: string; labelKey: string; iconSrc: string };

// 顶部导航顺序 = Figma 7036:1497 自上而下（Components 是设计图之外的自建页，垫在 CLI 之后）。
// 看板暂时移出主导航；/tasks 页面及内部深链保留，恢复步骤见 docs/kanban-resume.md。
// 玻璃实验台暂时移出主导航；保留 /glass 页面，方便后续恢复入口。
const PRIMARY_NAV: NavEntry[] = [
  { to: "/dashboard", labelKey: "nav.dashboard", iconSrc: dashboardIcon },
  { to: "/chat", labelKey: "nav.chat", iconSrc: chatIcon },
  { to: "/inspirations", labelKey: "nav.inspiration", iconSrc: inspirationIcon },
  { to: "/cron", labelKey: "nav.cron", iconSrc: cronIcon },
  { to: "/agents", labelKey: "nav.agents", iconSrc: agentsIcon },
  { to: "/token", labelKey: "nav.token", iconSrc: tokenIcon },
  { to: "/models", labelKey: "nav.models", iconSrc: modelsIcon },
  { to: "/skills", labelKey: "nav.skills", iconSrc: skillsIcon },
  { to: "/plugins", labelKey: "nav.plugins", iconSrc: pluginsIcon },
  { to: "/cli", labelKey: "nav.cli", iconSrc: cliIcon },
  { to: "/components", labelKey: "nav.components", iconSrc: componentsIcon },
];

// 设置入口固定在导航栏底部，匹配 Figma 中独立贴底的齿轮按钮。
const BOTTOM_NAV: NavEntry[] = [{ to: "/settings", labelKey: "nav.settings", iconSrc: settingsIcon }];

// 选中态的黄色圆背景不再由 .nav-link.active 自己画，而是这一颗在导航项之间「流」过去
// （R236，与 PillTabs R235 同一套运动语言，参数也同一组）：外层管位移、内层管形变，
// 形变以「前缘」为 transform-origin —— 前缘先冲到位、尾巴被拖在后面再收回。
// 全程只动 transform（合成层），不碰布局；导航栏在每个页面上都常驻，不能拖累重页面。
const BLOB_SIZE = 40; // 与 .nav-link 同宽高
const BLOB_LEAD_MS = 250; // 前缘（位移）到位
const BLOB_LAG_MS = 330; // 尾巴收回 = 整体完成
const BLOB_LEAD_EASE = "cubic-bezier(0.22, 0.61, 0.36, 1)";
const BLOB_STRETCH = 0.32; // 拉长量 = 行程的 32%（PillTabs 两条边的最大进度差）
const BLOB_STRETCH_MAX = 34; // px。导航项跨度能到 500px+，不封顶会拉成一条黄带
const BLOB_NARROW = 0.34; // 纵向拉多长，横向按比例收多窄（体积守恒的错觉）

function NavActiveBlob() {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const fillRef = useRef<HTMLSpanElement>(null);
  const prevY = useRef<number | null>(null);
  const running = useRef<Animation[]>([]);
  const { pathname } = useLocation();

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const fill = fillRef.current;
    if (!wrap || !fill) return;
    const nav = wrap.parentElement;
    if (!nav) return;

    // 量的是「当前选中项在 .nav 里的纵向位置」——.nav 是唯一 position:relative 的祖先，
    // 所以 offsetTop 就是我们要的 y；窗口高度变化会改 padding/gap，故还要跟着 resize 重量。
    const place = (animate: boolean) => {
      const active = nav.querySelector<HTMLElement>(".nav-link.active");
      if (!active) {
        wrap.style.opacity = "0";
        prevY.current = null;
        return;
      }
      wrap.style.opacity = "1";
      const y = active.offsetTop;
      const from = prevY.current;
      prevY.current = y;
      wrap.style.transform = `translateY(${y}px)`;
      if (!animate || from === null || from === y) return;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

      running.current.forEach((a) => a.cancel());
      const down = y > from;
      const stretch = Math.min(Math.abs(y - from) * BLOB_STRETCH, BLOB_STRETCH_MAX);
      const sy = (BLOB_SIZE + stretch) / BLOB_SIZE;
      const sx = 1 - (sy - 1) * BLOB_NARROW;
      // 原点放在前缘：拉长时只往「来的方向」长出去 = 尾巴，前缘始终跟着位移曲线。
      fill.style.transformOrigin = down ? "center bottom" : "center top";
      running.current = [
        wrap.animate(
          [{ transform: `translateY(${from}px)` }, { transform: `translateY(${y}px)` }],
          { duration: BLOB_LEAD_MS, easing: BLOB_LEAD_EASE },
        ),
        fill.animate(
          [
            { transform: "scaleY(1) scaleX(1)" },
            { transform: `scaleY(${sy}) scaleX(${sx})`, offset: 0.19 },
            { transform: "scaleY(1) scaleX(1)" },
          ],
          { duration: BLOB_LAG_MS, easing: "ease-in-out" },
        ),
      ];
    };

    place(true);
    const ro = new ResizeObserver(() => place(false));
    ro.observe(nav);
    return () => ro.disconnect();
  }, [pathname]);

  return (
    <span className="nav-blob" ref={wrapRef} aria-hidden="true">
      <span className="nav-blob-fill" ref={fillRef} />
    </span>
  );
}

// 刷新反馈至少播满这么久；数据没变化时这段动画就是唯一的可见反馈（R371）。
// 1200ms 是**动画契约的基准周期**，不是随手取的数：styles.css 里每个图标动画的周期
// 都是它的整数分之一（1200 / 600 / 400 / 300），且首尾关键帧都等于静止态——两条合起来
// 保证动画停下的那一刻正好落在原位，不会跳一下（R373 用户要求）。改这个数就要同步
// 复核那一整组周期。
const SPIN_MS = 1200;
const AGENT_SERVICE_STATUS_POLL_MS = 5_000;

// 统一渲染图标按钮，避免导航项之间的尺寸和可访问性属性漂移。
// 再点一次已选中的那颗 = 刷新本页数据（R361：全站唯一刷新入口，页面上不再各摆
// 一颗刷新按钮）。查 lib/page-refresh 的登记表，跑完弹右上角 toast；没登记的页
//（玻璃/组件这类无数据自建页）静默无操作。刷新同样过 requestNavigation
// 这道门，白拿「有页面正在提交就阻断 + 有未保存改动先确认」两条现成保护。
function GuardedNavLink({ entry, label }: { entry: NavEntry; label: string }) {
  const { t } = useTranslation();
  const requestNavigation = useNavigationRequest();
  const toast = useToast();
  const { pathname, search } = useLocation();
  const inspirationDestination = useInspirationReturnTarget(pathname, search);
  const destination = entry.to === "/inspirations" ? inspirationDestination : entry.to;
  const busyRef = useRef(false);
  const [minPlay, setMinPlay] = useState(false);
  // "/" 会被重定向到 /chat，两者都算聊天页的「当前」态。
  const isCurrent = pathname === entry.to || (entry.to === "/chat" && pathname === "/");
  const refreshable = useHasPageRefresh(entry.to);
  const InlineIcon = NAV_ICON_COMPONENTS[entry.to];
  // 页面自报的加载态。只在「当前页」采信：ChatPage 在路由间常驻不卸载，它后台的
  // 加载不该让聊天图标在别的页面上自己动起来。
  const pageLoading = usePageLoading(entry.to);
  const minPlayTimerRef = useRef<number | null>(null);
  const minPlayGenerationRef = useRef(0);

  // 最短播放只有一份 timer 所有权；新一代开始或离页时，旧回调不得再改写 minPlay。
  const clearMinPlayTimer = useCallback(() => {
    if (minPlayTimerRef.current !== null) {
      window.clearTimeout(minPlayTimerRef.current);
      minPlayTimerRef.current = null;
    }
  }, []);
  const beginMinPlay = useCallback((): number => {
    const generation = minPlayGenerationRef.current + 1;
    minPlayGenerationRef.current = generation;
    clearMinPlayTimer();
    setMinPlay(true);
    return generation;
  }, [clearMinPlayTimer]);
  const finishMinPlay = useCallback((generation: number, startedAt: number) => {
    if (minPlayGenerationRef.current !== generation) return;
    clearMinPlayTimer();
    minPlayTimerRef.current = window.setTimeout(() => {
      if (minPlayGenerationRef.current !== generation) return;
      minPlayTimerRef.current = null;
      setMinPlay(false);
    }, Math.max(0, SPIN_MS - (Date.now() - startedAt)));
  }, [clearMinPlayTimer]);
  const cancelMinPlay = useCallback(() => {
    minPlayGenerationRef.current += 1;
    clearMinPlayTimer();
    setMinPlay(false);
  }, [clearMinPlayTimer]);

  // GuardedNavLink 平时常驻，但 App 卸载时仍要作废异步刷新留下的完成回调。
  useEffect(() => () => {
    minPlayGenerationRef.current += 1;
    clearMinPlayTimer();
  }, [clearMinPlayTimer]);

  // 切到这一页就播一轮（R373 用户定案：切 tab 也要有反馈）。数据还没到位的话，
  // pageLoading 会接着把动画撑住，直到加载完成——「快页闪一下、慢页一直转」是同一套
  // 逻辑的两种表现，不需要各写一份。
  useEffect(() => {
    if (!isCurrent) {
      cancelMinPlay();
      return;
    }
    const startedAt = Date.now();
    const generation = beginMinPlay();
    finishMinPlay(generation, startedAt);
    return () => {
      // 若手动刷新已接管播放代次，这个进页 effect 的 cleanup 不能误清新的 timer。
      if (minPlayGenerationRef.current !== generation) return;
      minPlayGenerationRef.current += 1;
      clearMinPlayTimer();
    };
  }, [beginMinPlay, cancelMinPlay, clearMinPlayTimer, finishMinPlay, isCurrent]);

  const wantSpin = minPlay || (isCurrent && pageLoading);
  const [spinning, setSpinning] = useState(false);
  const spinStartRef = useRef(0);

  // 收尾必须落在**整轮边界**上。加载结束的时刻不由我们决定，直接摘 class 会把动画掐死
  // 在任意角度——那同样是跳跃，只是触发条件比「一次动画」隐蔽。所有动画周期都整除
  // SPIN_MS，所以「播放已进行的时长 % SPIN_MS == 0」这一刻它们全都在自己的整轮边界上，
  // 一次对齐通吃十个图标。
  useEffect(() => {
    if (wantSpin) {
      if (!spinning) {
        spinStartRef.current = Date.now();
        setSpinning(true);
      }
      return;
    }
    if (!spinning) return;
    const elapsed = Date.now() - spinStartRef.current;
    const timer = window.setTimeout(
      () => setSpinning(false),
      (SPIN_MS - (elapsed % SPIN_MS)) % SPIN_MS,
    );
    return () => window.clearTimeout(timer);
  }, [wantSpin, spinning]);

  const refreshHere = () => {
    if (busyRef.current) return; // 刷新途中连点：忽略，别叠 toast
    const running = runPageRefresh(entry.to);
    if (!running) return;
    busyRef.current = true;
    const startedAt = Date.now();
    const generation = beginMinPlay();
    void running
      .then(
        () => toast.success(t("common.refreshed")),
        (e: unknown) =>
          toast.error(t("common.refreshFailed", { msg: e instanceof Error ? e.message : String(e) })),
      )
      .finally(() => {
        busyRef.current = false;
        // 至少播满一轮再停：后端数据本来就没变时，这段动画是「确实刷了」唯一的可见
        // 证据（否则页面一动不动，用户只能怀疑刷新是假的）。
        finishMinPlay(generation, startedAt);
      });
  };

  return (
    <NavLink
      key={entry.to}
      to={destination}
      className={({ isActive }) =>
        `nav-link${isActive ? " active" : ""}${spinning ? " is-refreshing" : ""}`
      }
      aria-label={label}
      title={isCurrent && refreshable ? `${label} · ${t("nav.clickToRefresh")}` : label}
      onClick={(event) => {
        event.preventDefault();
        requestNavigation(isCurrent ? refreshHere : destination);
      }}
    >
      {/* 有专属刷新动画的图标走内联 SVG（外部 CSS 才够得到内部节点）；其余仍是
          <img>，靠 styles.css 里 `img.nav-icon` 的整体旋转（定时任务/设置）。 */}
      {InlineIcon ? (
        <InlineIcon className="nav-icon" />
      ) : (
        <img className="nav-icon" src={entry.iconSrc} alt="" aria-hidden="true" />
      )}
    </NavLink>
  );
}

// App 只负责壳层和路由，页面功能保持原有组件实现。
export default function App() {
  const { t } = useTranslation();
  const toast = useToast();
  const debugOn = useDebugEnabled();
  useEffect(installProductActivityListener, []);
  const agentServiceRestartState = useRef(INITIAL_AGENT_SERVICE_RESTART_STATE);
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const sample = async () => {
      if (inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const status = await getShoggothProductStatus(AbortSignal.timeout(10_000));
        if (cancelled) return;
        const observed = observeAgentService(agentServiceRestartState.current, status.service, status.background);
        agentServiceRestartState.current = observed.state;
        if (observed.notice === "recovering") toast.error(t("common.agentServiceRecovering"));
        else if (observed.notice === "restarted") toast.info(t("common.agentServiceRestarted"));
      } catch {
        if (cancelled) return;
        const observed = observeAgentService(agentServiceRestartState.current, null);
        agentServiceRestartState.current = observed.state;
        if (observed.notice === "recovering") toast.error(t("common.agentServiceRecovering"));
      } finally {
        inFlight = false;
      }
    };
    void sample();
    const interval = window.setInterval(() => void sample(), AGENT_SERVICE_STATUS_POLL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void sample(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [t, toast]);
  // ChatPage 在路由间保活：切到别的功能时只隐藏不卸载，WS 连接与列表/排序等内存态全部冻结，
  // 切回零重建（不再重拉 sessions.list / chat.history，左侧列表也不会重排跳动）。其余页面仍按需挂载/卸载。
  const location = useLocation();
  const onChat = location.pathname === "/chat" || location.pathname === "/";
  const [chatMounted, setChatMounted] = useState(onChat);
  useEffect(() => {
    if (onChat) setChatMounted(true);
  }, [onChat]);
  // Electron 菜单「设置连接…」经 preload 的 onNavigate 桥送进来一个应用内路径
  //（原生 gateway-config 弹窗已退役，连接设置只有设置页一处）。
  const requestNavigation = useNavigationRequest();
  useEffect(() => {
    const host = (window as unknown as { openclawDesktop?: { onNavigate?: (cb: (p: string) => void) => () => void } })
      .openclawDesktop;
    if (!host?.onNavigate) return;
    return host.onNavigate((p) => {
      if (typeof p === "string" && p.startsWith("/")) requestNavigation(p);
    });
  }, [requestNavigation]);
  return (
    <div className="app">
      <ScrollbarProvider />
      <Notifier />
      <SetupOverlay />
      {debugOn && <DebugInspector />}
      <aside className="sidebar" aria-label={t("a11y.mainNav")}>
        <nav className="nav" aria-label={t("a11y.mainNav")}>
          <NavActiveBlob />
          <div className="nav-primary">{PRIMARY_NAV.map((entry) => <GuardedNavLink key={entry.to} entry={entry} label={t(entry.labelKey)} />)}</div>
          <div className="nav-bottom">{BOTTOM_NAV.map((entry) => <GuardedNavLink key={entry.to} entry={entry} label={t(entry.labelKey)} />)}</div>
        </nav>
      </aside>
      <main className="content">
        {/* 常驻保活：display:contents 让 .chat-shell 仍是 .content 的直接子（不破坏其 grid/flex 布局），隐藏时彻底不占位。 */}
        {(chatMounted || onChat) && (
          <Suspense fallback={onChat ? <div className="page page-loading"><FusionLoader ariaLabel={t("common.loading")} /></div> : null}>
            <div style={{ display: onChat ? "contents" : "none" }}>
              <ChatPage />
            </div>
          </Suspense>
        )}
        <Suspense fallback={<div className="page page-loading"><FusionLoader ariaLabel={t("common.loading")} /></div>}>
          <Routes>
            <Route path="/" element={<Navigate to="/chat" replace />} />
            {/* /chat 由上方常驻渲染；此处占位，避免 * 兜底把 /chat 重定向成死循环。 */}
            <Route path="/chat" element={null} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/inspirations" element={<InspirationPage />} />
            <Route
              path="/cron"
              element={
                <div className="page">
                  <CronPage />
                </div>
              }
            />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/token" element={<UsagePage />} />
            <Route path="/skills" element={<SkillsPage />} />
            <Route path="/plugins" element={<PluginsPage />} />
            <Route path="/cli" element={<CliPage />} />
            <Route path="/models" element={<ModelsPage />} />
            <Route path="/glass" element={<GlassLab />} />
            <Route path="/components" element={<ComponentsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            {/* Turn Lab:回合过程可视化的临时演示页 —— 故意不进 PRIMARY_NAV(隐藏路由,直达 #/turnlab)。 */}
            <Route path="/turnlab" element={<TurnLabPage />} />
            <Route path="*" element={<Navigate to="/chat" replace />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}
