// 首启引导：整窗白底页面（Figma 333:185 启动 / 333:409 识别中 / 333:472 没找到 /
// 421:289 找到的助理）。启动 Logo → 识别中（循环静音视频）→ 没找到可用助理时
// 引导配置模型（不提供跳过，配好后进入列表）；找到时列出本机助理（没装的
// Hermes / OpenClaw 不显示），从列表的「开始使用」进入 App。
// 检测沿用原浮层：getStatus() 每次轮询都会尝试重连（openclaw-backend 的
// _connect），所以列表随环境就绪自动更新。任何离开路径都写 setupCompletedAt，
// 此后不再出现（连接健康与全部字段常驻「设置」页）。
// 仅当 config.setupCompletedAt===0 且 token==="" 时出现一次；token 已配置
// 的老安装升级后不会看到它。

import { measureTelemetry, telemetryOnboardingStep } from "../lib/productTelemetry";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import {
  ApiError,
  bindShoggothEndpoint,
  getConfig,
  getShoggothProductStatus,
  getShoggothProviders,
  getOpenclawHost,
  getStatus,
  listCustomEndpoints,
  saveCustomEndpoint,
  startOpenclawGateway,
  startShoggothChatGptLogin,
  updateConfig,
  runShoggothBackgroundAction,
  validateCustomEndpoint,
} from "../api/client";
import type {
  BackendStatus,
  OpenclawHostInfo,
  ShoggothProductStatus,
  ShoggothProviderSnapshot,
} from "../types";
import { useToast } from "./ui";
import BackendTabIcon, { sortBackendTabs } from "./BackendTabIcon";
import FusionLoader from "./FusionLoader";
import { Field, TextInput } from "./Field";
import { providerOperationId } from "../lib/shoggothProvider";
import styles from "./SetupOverlay.module.css";

const SPLASH_MS = 1200; // Logo 页至少停留
const DETECT_MIN_MS = 2500; // 识别页至少停留，避免一闪而过
const DETECT_MAX_MS = 10000; // 仍在启动的后端到点后在列表里显示「启动中」
const POLL_MS = 1500;
const FADE_MS = 600; // 区块淡出后再卸载
const NOTHING_LEFT_MS = 3000; // 列表变空要持续这么久（约两轮轮询）才回到「没找到」页
const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18792";
// 本机标记：完成过首启的窗口不再先盖白屏 Logo；没有标记时先盖上，避免
// 读配置期间闪出主界面。读不到 storage 时按「已完成」处理，宁可不打扰。
const SEEN_KEY = "shoggoth.setup.seen";
// 舞台按 Figma 1380×900 的中心坐标排版；窗口放不下时整体等比缩小。
// 高度按最高的自定义模型配置页留 ±360。
const STAGE_W = 1060;
const STAGE_H = 720;

type Phase = "splash" | "detecting" | "setup" | "login" | "custom" | "found";

// 认证类失败 vs 网关不在线：只用于文案分叉，结构化 reason 优先，正则保底。
const AUTH_ERR = /auth|token|denied|unauthorized|forbidden|pairing|401|403|身份|认证|配对/i;
const AUTH_REASONS = new Set(["token_mismatch", "token_missing", "device_token_stale", "pairing_required", "origin_denied"]);
const MISSING_CLI_ERR = /enoent|not.?found|无法找到|未找到|不存在/i;

// 首启梯子(S2)：[启动网关] 只对 loopback 网关有意义(不能远程代启动)。
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
function isLoopback(url: string): boolean {
  try {
    return LOOPBACK.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function readSeen(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return true;
  }
}

function writeSeen() {
  try {
    window.localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* 只影响下次是否先盖白屏 */
  }
}

// 区块关掉后再保留一会儿，让淡出走完再卸载。
function useLatch(on: boolean, ms: number): boolean {
  const [latched, setLatched] = useState(on);
  useEffect(() => {
    if (on) {
      setLatched(true);
      return;
    }
    const timer = window.setTimeout(() => setLatched(false), ms);
    return () => window.clearTimeout(timer);
  }, [on, ms]);
  return on || latched;
}

// 视频静音循环；不在画面上时（等淡出完）暂停，重新出现时从头播放。
function useLoopVideo(ref: RefObject<HTMLVideoElement>, on: boolean) {
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (on) {
      video.currentTime = 0;
      void video.play().catch(() => {});
      return;
    }
    const timer = window.setTimeout(() => video.pause(), FADE_MS);
    return () => window.clearTimeout(timer);
  }, [ref, on]);
}

function fetchableUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol.startsWith("http") && Boolean(url.host);
  } catch {
    return false;
  }
}

// 自定义模型配置：和模型页「自定义端点」同一条通道。填好 URL（和 API Key）后
// 自动拉取模型列表，可多选也可手动添加；选中的都存进端点，第一个选中的设为 Shoggoth 的默认模型。
function CustomEndpointForm({ profileId, onConfigured }: {
  profileId: string | null;
  onConfigured: () => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [fetched, setFetched] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [manual, setManual] = useState("");
  const chipsRef = useRef<HTMLDivElement>(null);
  // 手动添加后要滚到的模型（新加的在最后；已在列表里的就滚到它所在位置）
  const revealRef = useRef<string | null>(null);
  const [revealTick, setRevealTick] = useState(0);
  const [fetching, setFetching] = useState(false);
  const [fetchNote, setFetchNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const url = baseUrl.trim();
  const key = apiKey.trim();
  const typed = manual.trim();

  // 与模型页端点弹窗一致：输入停顿 700ms 再拉取；改 URL / Key 作废上一次的结果（已选的保留）。
  useEffect(() => {
    setFetched([]);
    setFetchNote(null);
    setFetching(false);
    if (!fetchableUrl(url)) return;
    const abort = new AbortController();
    const timer = window.setTimeout(async () => {
      setFetching(true);
      try {
        const result = await validateCustomEndpoint("shoggoth", profileId ?? undefined, {
          name: "endpoint", baseUrl: url, model: "", api: "openai-responses",
          ...(key ? { apiKey: key } : {}),
        }, abort.signal);
        if (abort.signal.aborted) return;
        const found = result.models ?? [];
        setFetched(found);
        if (found.length === 1) setSelected((current) => current.length > 0 ? current : found);
        setFetchNote(!result.ok
          ? t(result.code === "authentication_failed"
            ? "models.settings.endpoints.fetchAuthFailed" : "models.settings.endpoints.fetchFailed")
          : found.length === 0 ? t("models.settings.endpoints.fetchEmpty") : null);
      } catch {
        if (!abort.signal.aborted) setFetchNote(t("models.settings.endpoints.fetchFailed"));
      } finally {
        if (!abort.signal.aborted) setFetching(false);
      }
    }, 700);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [url, key, profileId, t]);

  // 拉到的和已选的（含手动添加的）一起列出，点选切换；第一个选中的是默认模型。
  const chips = [...new Set([...fetched, ...selected])];
  const toggle = (id: string) => setSelected((current) =>
    current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]);
  const addManual = () => {
    if (!typed) return;
    revealRef.current = typed;
    setRevealTick((n) => n + 1);
    setSelected((current) => current.includes(typed) ? current : [...current, typed]);
    setManual("");
  };
  // 模型多时标签区会滚动，手动添加的不滑动看不到：渲染后把它滚进可见范围。
  useEffect(() => {
    const id = revealRef.current;
    const box = chipsRef.current;
    if (!id || !box) return;
    revealRef.current = null;
    const chip = [...box.children].find((el) => (el as HTMLElement).dataset.model === id) as HTMLElement | undefined;
    if (!chip) return;
    const top = chip.offsetTop;
    const bottom = top + chip.offsetHeight;
    const target = top < box.scrollTop ? top
      : bottom > box.scrollTop + box.clientHeight ? bottom - box.clientHeight : null;
    if (target === null) return;
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    box.scrollTo({ top: target, behavior: smooth ? "smooth" : "auto" });
  }, [revealTick]);
  const canSubmit = !busy && fetchableUrl(url) && selected.length > 0;

  const submit = async () => {
    if (!canSubmit) return;
    const telemetryEpoch = telemetryOnboardingStep("configuration_started");
    setBusy(true);
    setMessage(null);
    try {
      // 同一地址已有端点（比如上次保存后校验没通过）就沿用它并保留原有模型；
      // 否则按域名生成不重复的 Provider ID。
      const { endpoints } = await listCustomEndpoints("shoggoth", profileId ?? undefined, { refreshAuth: false });
      const bare = (value: string) => value.trim().replace(/\/+$/, "");
      const existing = endpoints.find((entry) => bare(entry.baseUrl) === bare(url));
      const host = new URL(url).hostname;
      const base = host.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").toLowerCase() || "custom-endpoint";
      let id = existing?.id ?? base;
      for (let n = 2; !existing && endpoints.some((entry) => entry.id === id); n += 1) id = `${base}-${n}`;
      await measureTelemetry("model_save", "shoggoth", async () => {
        await saveCustomEndpoint("shoggoth", profileId ?? undefined, {
          id,
          name: host || id,
          baseUrl: url,
          api: "openai-responses",
          model: selected[0],
          models: [...selected, ...(existing?.models ?? []).filter((entry) => !selected.includes(entry))],
          discoverModels: false,
          ...(key ? { apiKey: key } : {}),
        });
        await bindShoggothEndpoint({
          profileId,
          operationId: providerOperationId("endpoint-bind"),
          providerRef: id,
          defaultModel: selected[0],
          createdAt: Date.now(),
        });
      });
      if (await onConfigured()) telemetryOnboardingStep("connection_verified", telemetryEpoch);
    } catch (error) {
      setMessage(error instanceof ApiError && error.code === "CUSTOM_ENDPOINT_REJECTED" && error.message
        ? error.message
        : t("shoggothProvider.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.form}>
      <Field label={t("setup.url")} hint={t("setup.urlHint")}>
        <TextInput value={baseUrl} disabled={busy} placeholder="https://api.example.com/v1"
          spellCheck={false} autoComplete="off" onChange={(event) => setBaseUrl(event.target.value)} />
      </Field>
      <Field label={t("setup.apiKey")} hint={t("setup.apiKeyHint")}>
        <TextInput type="password" value={apiKey} disabled={busy} autoComplete="off"
          onChange={(event) => setApiKey(event.target.value)} />
      </Field>
      {/* 模型：和模型页自定义端点弹窗一样，点选（多选）+ 手动添加。 */}
      <div className={styles.models}>
        <span className="field-label">{t("models.settings.endpoints.modelsLabel")}</span>
        <span className="field-hint">{t("models.settings.endpoints.modelsHint")}</span>
        {(fetching || fetchNote) && (
          <span className="field-hint" role="status">
            {fetching ? t("models.settings.endpoints.fetching") : fetchNote}
          </span>
        )}
        {chips.length > 0 && (
          <div className={styles.chips} ref={chipsRef}>
            {chips.map((id) => (
              <button key={id} type="button" className={styles.chip} data-model={id} aria-pressed={selected.includes(id)}
                disabled={busy} onClick={() => toggle(id)}>
                {id}
                {selected[0] === id && (
                  <span className={styles.chipDefault}>{t("models.settings.endpoints.defaultBadge")}</span>
                )}
              </button>
            ))}
          </div>
        )}
        <div className={styles.manualRow}>
          <TextInput value={manual} disabled={busy} spellCheck={false} autoComplete="off"
            placeholder={t("models.settings.endpoints.manualPlaceholder")}
            onChange={(event) => setManual(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addManual();
              }
            }} />
          <button type="button" className="btn-secondary btn-md" disabled={busy || !typed} onClick={addManual}>
            {t("models.settings.endpoints.manualAdd")}
          </button>
        </div>
      </div>
      <div className={styles.formActions}>
        <button type="button" className={`btn-dark btn-md ${styles.submit}`} disabled={!canSubmit} onClick={() => void submit()}>
          {busy ? t("common.saving") : t("shoggothProvider.configure")}
        </button>
        {message && <span className="ui-hint" role="status">{message}</span>}
      </div>
    </div>
  );
}

export default function SetupOverlay() {
  const { t } = useTranslation();
  const toast = useToast();
  // cover：没有本机标记时首帧就盖上白屏 Logo；否则读到配置后再淡入。
  const [cover] = useState(() => !readSeen());
  const [phase, setPhase] = useState<Phase | null>(cover ? "splash" : null);
  const [active, setActive] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [fromFound, setFromFound] = useState(false);
  const [statuses, setStatuses] = useState<BackendStatus[] | null>(null);
  const [shoggothStatus, setShoggothStatus] = useState<ShoggothProductStatus | null>(null);
  const [shoggothProviders, setShoggothProviders] = useState<ShoggothProviderSnapshot | null>(null);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [shoggothError, setShoggothError] = useState(false);
  const [shoggothBusy, setShoggothBusy] = useState(false);
  const [ocUrl, setOcUrl] = useState(DEFAULT_GATEWAY_URL);
  const [saving, setSaving] = useState(false);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [loginFailed, setLoginFailed] = useState(false);
  const [scale, setScale] = useState(1);
  // 首启梯子(S2):本机 openclaw 侦察 + 一键启动状态
  const [ocHost, setOcHost] = useState<OpenclawHostInfo | null>(null);
  const [startState, setStartState] = useState<"idle" | "starting" | "failed">("idle");
  const [startOutput, setStartOutput] = useState("");
  const mountedAt = useRef(Date.now());
  const detectStartedAt = useRef(0);
  const stamped = useRef(false);
  const autoRepairAttempted = useRef(false);
  // 见过「找不到命令」就记为未安装：Hermes 每 10 秒重试启动，重试窗口里只报
  // starting 不带错误，不记住的话这一行会时隐时现。连上后清除。
  const missing = useRef<Record<string, boolean>>({});
  const videoRef = useRef<HTMLVideoElement>(null);
  const configuringRef = useRef<HTMLVideoElement>(null);

  // 只决定一次是否出现；配置拿不到（server 启动窗）宁可不打扰。
  useEffect(() => {
    let alive = true;
    getConfig()
      .then((cfg) => {
        if (!alive) return;
        if (cfg.setupCompletedAt || cfg.token) {
          // 已完成首启：遮罩立刻撤掉，不做淡出，别挡住主界面。
          writeSeen();
          setPhase(null);
          return;
        }
        setOcUrl(cfg.gatewayUrl.trim() || DEFAULT_GATEWAY_URL);
        setPhase((p) => p ?? "splash");
        setActive(true);
      })
      .catch(() => {
        if (alive) setPhase(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 淡出走完再卸载。
  useEffect(() => {
    if (!exiting) return;
    const timer = window.setTimeout(() => setPhase(null), FADE_MS);
    return () => window.clearTimeout(timer);
  }, [exiting]);

  // 窗口放不下 Figma 排版时整体等比缩小（最小窗口 720×560）。
  useEffect(() => {
    const fit = () =>
      setScale(Math.min(1, (window.innerWidth - 48) / STAGE_W, (window.innerHeight - 48) / STAGE_H));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  // Logo 页 → 识别中（Logo 缩放位移由 CSS 过渡完成）。
  useEffect(() => {
    if (!active || phase !== "splash") return;
    const wait = Math.max(0, SPLASH_MS - (Date.now() - mountedAt.current));
    const timer = window.setTimeout(() => {
      detectStartedAt.current = Date.now();
      setPhase("detecting");
    }, wait);
    return () => window.clearTimeout(timer);
  }, [active, phase]);

  // 首启页可见期间持续轮询；getStatus 自带重连尝试，就是列表「自动更新」的来源。
  useEffect(() => {
    if (!active || exiting) return;
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      await Promise.all([
        getShoggothProductStatus()
          .then((value) => {
            if (!alive) return;
            setShoggothStatus(value);
            setShoggothError(false);
          })
          .catch(() => {
            if (alive) setShoggothError(true);
          }),
        getShoggothProviders()
          .then((value) => {
            if (alive) setShoggothProviders(value);
          })
          .catch(() => {
            if (alive) setShoggothProviders(null);
          })
          .finally(() => {
            if (alive) setProvidersLoaded(true);
          }),
      ]);
      try {
        const s = await getStatus();
        // openclaw 未连通才做本机侦察(host 端点服务端缓存 3s,轮询不放大探测)。
        // 与状态一起写入，免得先渲染一拍「连不上」再变成「未安装」。
        const oc = s.find((b) => b.id === "openclaw");
        const host = oc && !oc.connected ? await getOpenclawHost().catch(() => null) : undefined;
        if (alive) {
          for (const b of s) {
            if (b.connected) missing.current[b.id] = false;
            else if (!b.info.starting && MISSING_CLI_ERR.test(b.info.error || "")) missing.current[b.id] = true;
          }
          setStatuses(s);
          if (host !== undefined) setOcHost(host);
        }
      } catch {
        /* 保持「识别中」，下一轮再试 */
      }
      if (alive) timer = window.setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [active, exiting]);

  const finish = useCallback(async () => {
    if (stamped.current) return;
    stamped.current = true;
    setSaving(true);
    try {
      await updateConfig({ setupCompletedAt: Date.now() });
      writeSeen();
      setExiting(true);
    } catch (e) {
      stamped.current = false;
      setSaving(false);
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, [toast]);

  // R125:本机网关真实端口与配置不一致(版本间默认端口漂移,如 2026.5.x 的
  // 18789)→ 自动采用检测到的地址,配置落盘后 backend 懒重连,轮询自动转绿。
  const adoptedUrl = useRef<string | null>(null);
  useEffect(() => {
    const oc = statuses?.find((b) => b.id === "openclaw");
    const localUrl = ocHost?.localGatewayUrl;
    if (!oc || oc.connected || !localUrl) return;
    const configured = (oc.info.gatewayUrl || "").trim();
    if (!isLoopback(configured) || configured === localUrl || adoptedUrl.current === localUrl) return;
    adoptedUrl.current = localUrl;
    void updateConfig({ gatewayUrl: localUrl })
      .then(() => setOcUrl(localUrl))
      .catch(() => {
        adoptedUrl.current = null; // 写失败允许下一轮重试
      });
  }, [statuses, ocHost]);

  // 一键启动:成功后什么都不用做——轮询会自动转绿;失败给第二级
  // 「安装服务并启动」(首装机器还没有 launchd 服务时的正路)。
  const pendingConnection = useRef<{ epoch: string; target: "native" | "openclaw" } | null>(null);
  const beginConnection = useCallback((target: "native" | "openclaw") => {
    const epoch = telemetryOnboardingStep("configuration_started");
    const pending = epoch ? { epoch, target } : null;
    pendingConnection.current = pending;
    return pending;
  }, []);
  const runStart = useCallback(async (mode: "start" | "install", userInitiated = false) => {
    const pending = userInitiated ? beginConnection("openclaw") : null;
    setStartState("starting");
    setStartOutput("");
    try {
      const r = await startOpenclawGateway(mode);
      if (r.ok) {
        setStartState("idle");
        return;
      }
      if (pending && pendingConnection.current === pending) pendingConnection.current = null;
      setStartState("failed");
      setStartOutput(r.output);
    } catch (e) {
      if (pending && pendingConnection.current === pending) pendingConnection.current = null;
      setStartState("failed");
      setStartOutput(e instanceof Error ? e.message : String(e));
    }
  }, [beginConnection]);

  // OpenClaw 新版会在 token 模式缺少持久 token 时用一次性的 runtime token
  // 启动：端口是通的，但任何外部客户端都会被拒绝。仅对明确的本机缺-token
  // 状态自动调用一次官方修复路径；已有 token、远程网关均不触碰。
  useEffect(() => {
    if (!active || autoRepairAttempted.current || startState !== "idle") return;
    const oc = statuses?.find((backend) => backend.id === "openclaw");
    if (!oc || oc.connected || oc.info.reason !== "token_missing") return;
    const configured = (oc.info.gatewayUrl || ocUrl).trim();
    if (!isLoopback(configured)
      || !ocHost?.binPath
      || !ocHost.gatewayRunning
      || !ocHost.localGatewayRunning
      || ocHost.localTokenReadable) return;
    autoRepairAttempted.current = true;
    void runStart("start");
  }, [active, statuses, ocHost, ocUrl, startState, runStart]);

  const runShoggothBackground = async (action: "install" | "start" | "repair") => {
    setShoggothBusy(true);
    try {
      const next = await runShoggothBackgroundAction(action);
      setShoggothStatus(next);
      setShoggothError(false);
    } catch {
      setShoggothError(true);
    } finally {
      setShoggothBusy(false);
    }
  };

  const startLogin = async () => {
    const pending = nativeReady ? null : beginConnection("native");
    setLoginFailed(false);
    setLoginUrl(null);
    setPhase("login");
    try {
      const login = await startShoggothChatGptLogin(shoggothProviders?.profile?.id ?? null);
      setLoginUrl(login.authUrl);
      window.open(login.authUrl, "_blank", "noopener,noreferrer");
    } catch {
      if (pending && pendingConnection.current === pending) pendingConnection.current = null;
      setLoginFailed(true);
    }
  };

  const serviceHealthy = shoggothStatus?.service.healthy === true;
  const nativeReady = serviceHealthy && shoggothProviders?.profile?.ready === true;
  const openClawReady = statuses?.some(row => row.id === "openclaw" && row.connected === true) === true;
  useEffect(() => {
    const pending = pendingConnection.current;
    if (!pending || !(pending.target === "native" ? nativeReady : openClawReady)) return;
    pendingConnection.current = null;
    telemetryOnboardingStep("connection_verified", pending.epoch);
  }, [nativeReady, openClawReady]);
  const externals = sortBackendTabs((statuses ?? []).filter((b) => !(b.id === "shoggoth")));
  // 没装的不显示：OpenClaw 以本机侦察为准，其余后端以「找不到命令」为准。
  const installed = (b: BackendStatus) =>
    b.connected || (b.id === "openclaw" ? Boolean(ocHost?.binPath) : !missing.current[b.id]);
  const shownExternals = externals.filter(installed);
  const settled = statuses !== null
    && providersLoaded
    && serviceHealthy
    && startState !== "starting"
    && !externals.some((b) => b.info.starting && !missing.current[b.id]);
  // 只有服务健康、模型没配、也没有任何本机助理时才是「没找到」页。
  const outcome: Phase = serviceHealthy && !nativeReady && shownExternals.length === 0 ? "setup" : "found";

  // 识别中 → 结果页：至少停 DETECT_MIN_MS；检测没收敛也最多等 DETECT_MAX_MS。
  useEffect(() => {
    if (phase !== "detecting") return;
    const elapsed = Date.now() - detectStartedAt.current;
    const ready = settled || elapsed >= DETECT_MAX_MS;
    const wait = ready ? Math.max(0, DETECT_MIN_MS - elapsed) : DETECT_MAX_MS - elapsed;
    const timer = window.setTimeout(() => setPhase(outcome), wait);
    return () => window.clearTimeout(timer);
  }, [phase, settled, outcome]);

  // 登录完成 / 自定义模型配好（或在别处就绪）→ 自动进入助理列表。
  useEffect(() => {
    if (nativeReady && (phase === "setup" || phase === "login" || phase === "custom")) {
      setFromFound(false);
      setPhase("found");
    }
  }, [nativeReady, phase]);

  // 列表上已经什么都没有（服务正常、Shoggoth 没配模型、本机助理也没了，比如修好服务后才
  // 发现没配模型，或 Hermes 启动中途报找不到命令）→ 回到「没找到」页，配好模型才能进入。
  // 正从列表进来配置的，列表已不存在，也改成「没找到」的样子（无返回、换配图）。
  // 要持续一段时间才生效，避开单次探测失败让某行暂时消失。
  useEffect(() => {
    if (outcome !== "setup" || (phase !== "found" && !fromFound)) return;
    const timer = window.setTimeout(() => {
      setFromFound(false);
      if (phase === "found") setPhase("setup");
    }, NOTHING_LEFT_MS);
    return () => window.clearTimeout(timer);
  }, [outcome, phase, fromFound]);

  // 识别中 → 助理列表是同一段视频接着循环（不切图片、不重新开始）。
  const videoOn = phase === "detecting" || phase === "login" || phase === "found";
  // 配置模型时：「没有找到可用 AI 助理」页用没找到插图；其余配置（从列表进来的配置页、
  // 自定义模型配置）用「配置中」视频。
  const mediaKind = videoOn ? "video" : phase === "splash" ? "none"
    : fromFound || phase === "custom" ? "configuring" : "notFound";
  useLoopVideo(videoRef, videoOn);
  useLoopVideo(configuringRef, mediaKind === "configuring");

  const customMounted = useLatch(phase === "custom", FADE_MS);

  if (phase === null) return null;

  const statusText = (key: string) => <span className={styles.status}>{t(`setup.status.${key}`)}</span>;
  const loader = <FusionLoader size="sm" className={styles.loader} />;
  // 标题行：需要返回时，返回箭头和标题合成一个按钮，整行可点。
  const titleRow = (text: ReactNode, onBack?: () => void) => (
    <div className={styles.titleRow}>
      {onBack ? (
        <button type="button" className={styles.backTitle} onClick={onBack} title={t("setup.back")}>
          <span className={styles.backIcon}>
            <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}
              strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 18l-6-6 6-6" />
            </svg>
            <span className={styles.srOnly}>{t("setup.back")}</span>
          </span>
          <span className={styles.headline}>{text}</span>
        </button>
      ) : (
        <p className={styles.headline}>{text}</p>
      )}
    </div>
  );
  const rowButton = (label: string, onClick: () => void, disabled = false) => (
    <button type="button" className={`btn-secondary btn-sm ${styles.rowBtn}`} onClick={onClick} disabled={disabled}>
      {label}
    </button>
  );

  // Shoggoth 内置，永远显示。
  const nativeAction = shoggothStatus?.background?.supported && shoggothStatus.background.needsRepair
    ? "repair"
    : shoggothStatus?.background?.supported && !shoggothStatus.background.loaded
      ? shoggothStatus.background.installed ? "start" : "install"
      : null;
  const providerName = (() => {
    const id = shoggothProviders?.profile?.configuredProviderId;
    return id ? shoggothProviders?.providers.find((p) => p.id === id)?.displayName ?? null : null;
  })();
  let nativeDesc: string;
  let nativeMark: ReactNode;
  if (!shoggothStatus && !shoggothError) {
    nativeDesc = t("setup.row.checking");
    nativeMark = loader;
  } else if (!serviceHealthy) {
    nativeDesc = t(nativeAction ? "setup.row.serviceDown" : "setup.row.serviceUnavailable");
    nativeMark = nativeAction
      ? rowButton(
        shoggothBusy ? t("setup.shoggothRepairing") : t(`setup.shoggothAction.${nativeAction}`),
        () => void runShoggothBackground(nativeAction),
        shoggothBusy,
      )
      : statusText("unavailable");
  } else if (nativeReady) {
    nativeDesc = providerName ? t("setup.row.shoggothProvider", { name: providerName }) : t("setup.row.shoggothCodex");
    nativeMark = statusText("ready");
  } else {
    nativeDesc = t("setup.row.needsModel");
    nativeMark = rowButton(t("setup.configureModel"), () => {
      setFromFound(true);
      setPhase("setup");
    });
  }

  const externalRow = (b: BackendStatus): { desc: string; title?: string; mark: ReactNode } => {
    const err = b.info.error || "";
    const failed = () => ({
      desc: err ? t("setup.row.failed", { msg: err.split("\n")[0] }) : t("setup.row.failedUnknown"),
      title: err || undefined,
      mark: statusText("error"),
    });
    if (b.connected) {
      return b.id === "openclaw"
        ? { desc: t("setup.ocConnected", { url: b.info.gatewayUrl || "" }), mark: statusText("ready") }
        : { desc: t("setup.row.dashboardManaged"), mark: statusText("ready") };
    }
    if (b.id !== "openclaw") {
      return b.info.starting ? { desc: t("setup.row.starting"), mark: loader } : failed();
    }
    if (startState === "starting") return { desc: t("setup.row.starting"), mark: loader };
    if (startState === "failed") {
      return {
        desc: t("setup.row.ocStartFailed"),
        title: startOutput || undefined,
        mark: rowButton(t("setup.installAndStart"), () => void runStart("install", true)),
      };
    }
    // localGatewayRunning=true 说明网关其实在跑只是端口不对——自动采用在途,别劝启动。
    // loopback 判定用 status 带回的 info.gatewayUrl(服务端探测所用的权威 config 值)。
    const stoppable = Boolean(ocHost?.binPath) && !ocHost?.gatewayRunning
      && !ocHost?.localGatewayRunning && isLoopback(b.info.gatewayUrl || ocUrl);
    if (stoppable) {
      return {
        desc: t("setup.ocNotRunning", { version: ocHost?.version ? ` ${ocHost.version}` : "" }),
        mark: rowButton(t("setup.startGateway"), () => void runStart("start", true)),
      };
    }
    if (ocHost?.gatewayRunning && (AUTH_REASONS.has(b.info.reason || "") || AUTH_ERR.test(err))) {
      return { desc: t("setup.row.ocAuth"), title: err || undefined, mark: statusText("action") };
    }
    return failed();
  };

  const rows = [
    { id: "shoggoth", name: "Shoggoth", desc: nativeDesc, title: undefined as string | undefined, mark: nativeMark },
    ...shownExternals.map((b) => ({ id: b.id, name: b.name, ...externalRow(b) })),
  ];

  const setupHeadline = fromFound ? t("setup.configureShoggoth") : t("setup.noneFound");

  return (
    <section
      className={styles.root}
      data-phase={phase}
      data-entry={cover ? undefined : "fade"}
      data-exiting={exiting ? "true" : undefined}
      aria-labelledby={active ? "setup-title" : undefined}
      style={{ "--setup-scale": scale } as CSSProperties}
    >
      {/* 读到配置、确认要走首启之前只是白屏 Logo 遮罩，不带首启标题。 */}
      {active && <h1 id="setup-title" className={styles.srOnly}>{t("setup.title")}</h1>}
      <div className={styles.stage}>
        <span className={styles.logo} role="img" aria-label="Shoggoth" />

        {/* 确认要走首启后再挂载，老安装只闪一下白屏遮罩时不去下载素材。 */}
        <div className={styles.media} data-kind={mediaKind} aria-hidden="true">
          {active && (
            <>
              <video
                ref={videoRef}
                className={`${styles.layer} ${styles.videoLayer}`}
                src="/onboarding/detecting.mp4"
                autoPlay
                loop
                muted
                playsInline
                preload="auto"
              />
              <img className={`${styles.layer} ${styles.notFoundLayer}`} src="/onboarding/not-found.jpg" alt="" />
              <video
                ref={configuringRef}
                className={`${styles.layer} ${styles.configuringLayer}`}
                src="/onboarding/configuring.mp4"
                loop
                muted
                playsInline
                preload="auto"
              />
            </>
          )}
        </div>

        <p className={`${styles.block} ${styles.detectText}`} data-on={phase === "detecting"} role="status">
          {t("setup.detectingLocal")}
          {/* 末尾的三个点依次起伏（文案本身不带省略号） */}
          <span className={styles.dots} aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>
        </p>

        <div className={`${styles.block} ${styles.column}`} data-on={phase === "setup"}>
          {titleRow(setupHeadline, fromFound ? () => setPhase("found") : undefined)}
          <div className={styles.buttons}>
            <button type="button" className={`btn-dark btn-md ${styles.cta}`} onClick={() => void startLogin()}>
              <span className={styles.gptIcon} aria-hidden="true" />
              {t("setup.chatgptLogin")}
            </button>
            <button type="button" className={`btn-dark btn-md ${styles.cta} ${styles.ctaWide}`} onClick={() => { telemetryOnboardingStep("configuration_started"); setPhase("custom"); }}>
              {t("setup.customModel")}
            </button>
          </div>
        </div>

        <div className={`${styles.block} ${styles.column}`} data-on={phase === "login"}>
          {titleRow(loginFailed ? t("setup.loginFailed") : t("setup.loginWaiting"), () => setPhase("setup"))}
          <div className={styles.buttons}>
            <button
              type="button"
              className={`btn-dark btn-md ${styles.cta} ${styles.ctaWide}`}
              disabled={!loginFailed && !loginUrl}
              onClick={() => {
                if (loginFailed || !loginUrl) void startLogin();
                else window.open(loginUrl, "_blank", "noopener,noreferrer");
              }}
            >
              {loginFailed ? t("setup.retry") : t("setup.loginReopen")}
            </button>
          </div>
        </div>

        <div className={`${styles.block} ${styles.column} ${styles.customColumn}`} data-on={phase === "custom"}>
          {titleRow(t("setup.customModel"), () => setPhase("setup"))}
          {customMounted && (
            <CustomEndpointForm
              profileId={shoggothProviders?.profile?.id ?? null}
              onConfigured={async () => {
                const next = await getShoggothProviders();
                setShoggothProviders(next);
                return next.profile?.ready === true;
              }}
            />
          )}
        </div>

        <div className={`${styles.block} ${styles.found}`} data-on={phase === "found"}>
          <ul className={styles.rows}>
            {rows.map((row, i) => (
              <li key={row.id} className={styles.row} style={{ "--i": i } as CSSProperties}>
                <span className={styles.iconCell}>
                  <BackendTabIcon backend={row.id} label={row.name} />
                </span>
                <span className={styles.meta}>
                  <span className={styles.name}>{row.name}</span>
                  <span className={styles.desc} title={row.title}>{row.desc}</span>
                </span>
                <span className={styles.mark}>{row.mark}</span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className={`btn-dark btn-md ${styles.cta} ${styles.ctaWide} ${styles.startBtn}`}
            style={{ "--i": rows.length } as CSSProperties}
            onClick={() => void finish()}
            disabled={saving}
          >
            {saving ? t("common.saving") : t("setup.start")}
          </button>
        </div>
      </div>
    </section>
  );
}
