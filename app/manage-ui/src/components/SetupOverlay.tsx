// 首启引导浮层：自动探测两个后端，替代已退役的原生 gateway-config 弹窗。
// 黄金路径零输入——getStatus() 每次轮询都会尝试重连（openclaw-backend 的
// _connect），所以卡片会随环境就绪自动变绿；结算窗内全绿则自动盖章收起。
// 出问题时按状态给指引（本机指令 / 暂不使用），[进入控制台]
// 永远可点：任何离开路径都写 setupCompletedAt，浮层此后不再自动出现
// （连接健康与全部字段常驻「设置」页）。
// 仅当 config.setupCompletedAt===0 且 token==="" 时出现一次；token 已配置
// 的老安装升级后不会看到它。

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getConfig,
  getShoggothProductStatus,
  getShoggothProviders,
  getOpenclawHost,
  getStatus,
  listDiscoveredGateways,
  startOpenclawGateway,
  testConnection,
  updateConfig,
  runShoggothBackgroundAction,
} from "../api/client";
import type {
  AppConfig,
  BackendStatus,
  ConnTestResult,
  DiscoveredGateway,
  OpenclawHostInfo,
  ShoggothProductStatus,
  ShoggothProviderSnapshot,
} from "../types";
import { Field, TextInput } from "./Field";
import { useToast } from "./ui";
import { ShoggothProviderSetup } from "./ShoggothProviderSetup";
import { REMOTE_CONNECTIONS_ENABLED } from "../lib/connectionOptions";
import styles from "./SetupOverlay.module.css";

// 结算窗：窗内全绿 → 自动收起；窗外转绿只更新卡片，由用户自己离开，
// 避免正读指引/填表单时浮层突然消失。
const SETTLE_MS = 5000;
const POLL_MS = 1500;
const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18792";

type Tone = "detecting" | "ok" | "warn" | "skipped";

// 认证类失败 vs 网关不在线：只有文案分叉用，误判也只是指引不够准，
// 卡片仍显示原始错误全文兜底。
const AUTH_ERR = /auth|token|denied|unauthorized|forbidden|pairing|401|403|身份|认证|配对/i;
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

// S1 classifyAuthError 机器码 → 指引文案键;正则分类只剩保底。
function reasonKey(reason?: string): string | null {
  switch (reason) {
    case "token_mismatch":
    case "token_missing":
      return "setup.reasonToken";
    case "device_token_stale":
      return "setup.reasonDeviceStale";
    case "pairing_required":
      return "setup.reasonPairing";
    case "origin_denied":
      return "setup.reasonOrigin";
    case "unreachable":
    case "timeout":
      return "setup.reasonUnreachable";
    default:
      return null;
  }
}

export default function SetupOverlay() {
  const { t } = useTranslation();
  const toast = useToast();
  const [visible, setVisible] = useState(false);
  const [statuses, setStatuses] = useState<BackendStatus[] | null>(null);
  const [shoggothStatus, setShoggothStatus] = useState<ShoggothProductStatus | null>(null);
  const [shoggothProviders, setShoggothProviders] = useState<ShoggothProviderSnapshot | null>(null);
  const [shoggothError, setShoggothError] = useState(false);
  const [shoggothBusy, setShoggothBusy] = useState(false);
  const [skipped, setSkipped] = useState<Record<string, boolean>>({});
  const [remoteOpen, setRemoteOpen] = useState<Record<string, boolean>>({});
  const [ocUrl, setOcUrl] = useState(DEFAULT_GATEWAY_URL);
  const [ocToken, setOcToken] = useState("");
  const [hmUrl, setHmUrl] = useState("");
  const [hmToken, setHmToken] = useState("");
  const [tests, setTests] = useState<Record<string, ConnTestResult | "testing">>({});
  const [allReady, setAllReady] = useState(false);
  const [saving, setSaving] = useState(false);
  // 首启梯子(S2):本机 openclaw 侦察 + 一键启动状态
  const [ocHost, setOcHost] = useState<OpenclawHostInfo | null>(null);
  const [startState, setStartState] = useState<"idle" | "starting" | "failed">("idle");
  const [startOutput, setStartOutput] = useState("");
  // 局域网发现(S3):远程面板打开时扫一次,点选预填 URL
  const [lanScan, setLanScan] = useState<DiscoveredGateway[] | "scanning" | null>(null);
  const openedAt = useRef(0);
  const stamped = useRef(false);
  const autoRepairAttempted = useRef(false);

  // 只决定一次是否出现；配置拿不到（server 启动窗）宁可不打扰。
  useEffect(() => {
    let alive = true;
    getConfig()
      .then((cfg) => {
        if (!alive || cfg.setupCompletedAt || cfg.token) return;
        setOcUrl(cfg.gatewayUrl.trim() || DEFAULT_GATEWAY_URL);
        openedAt.current = Date.now();
        setVisible(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // 浮层可见期间持续轮询；getStatus 自带重连尝试，就是「自动变绿」的来源。
  useEffect(() => {
    if (!visible) return;
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
          }),
      ]);
      try {
        const s = await getStatus();
        if (alive) setStatuses(s);
        // openclaw 未连通才做本机侦察(host 端点服务端缓存 3s,轮询不放大探测)。
        const oc = s.find((b) => b.id === "openclaw");
        if (oc && !oc.connected) {
          const h = await getOpenclawHost().catch(() => null);
          if (alive) setOcHost(h);
        }
      } catch {
        /* 保持「检测中」，下一轮再试 */
      }
      if (alive) timer = window.setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [visible]);

  const finish = useCallback(
    async (patch: Partial<AppConfig>, note?: string) => {
      if (stamped.current) return;
      stamped.current = true;
      setSaving(true);
      try {
        await updateConfig({ ...patch, setupCompletedAt: Date.now() });
        if (note) toast.success(note);
        setVisible(false);
      } catch (e) {
        stamped.current = false;
        setSaving(false);
        toast.error(e instanceof Error ? e.message : String(e));
      }
    },
    [toast],
  );

  // 结算窗内全绿且用户没动过表单 → 亮一拍「全部就绪」再自动收起。
  // 定时器放 ref：armed 之后 setAllReady 引发的 effect 重跑不能把它 cleanup 掉
  // （否则 finish 永不执行，浮层卡在就绪态），只在组件卸载时清理。
  const autoClose = useRef<number | null>(null);
  useEffect(() => {
    if (!visible || autoClose.current !== null) return;
    const green = shoggothStatus?.service.healthy === true && shoggothProviders?.profile?.ready === true;
    const untouched = !Object.values(remoteOpen).some(Boolean);
    if (green && untouched && Date.now() - openedAt.current <= SETTLE_MS) {
      setAllReady(true);
      autoClose.current = window.setTimeout(() => void finish({}, t("setup.autoConnected")), 900);
    }
  }, [visible, shoggothStatus, shoggothProviders, remoteOpen, finish, t]);
  useEffect(
    () => () => {
      if (autoClose.current !== null) window.clearTimeout(autoClose.current);
    },
    [],
  );

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

  // 远程面板打开时扫一次局域网;刷新按钮手动重扫(服务端自带 5s 缓存)。
  const rescanLan = useCallback(async () => {
    setLanScan("scanning");
    try {
      setLanScan(await listDiscoveredGateways());
    } catch {
      setLanScan([]);
    }
  }, []);
  useEffect(() => {
    if (REMOTE_CONNECTIONS_ENABLED && remoteOpen.openclaw && lanScan === null) void rescanLan();
  }, [remoteOpen.openclaw, lanScan, rescanLan]);

  // 一键启动:成功后什么都不用做——轮询会自动转绿;失败给输出尾 + 第二级
  // 「安装服务并启动」(首装机器还没有 launchd 服务时的正路)。
  const runStart = useCallback(async (mode: "start" | "install") => {
    setStartState("starting");
    setStartOutput("");
    try {
      const r = await startOpenclawGateway(mode);
      if (r.ok) {
        setStartState("idle");
        return;
      }
      setStartState("failed");
      setStartOutput(r.output);
    } catch (e) {
      setStartState("failed");
      setStartOutput(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // OpenClaw 新版会在 token 模式缺少持久 token 时用一次性的 runtime token
  // 启动：端口是通的，但任何外部客户端都会被拒绝。仅对明确的本机缺-token
  // 状态自动调用一次官方修复路径；已有 token、远程网关和用户跳过均不触碰。
  useEffect(() => {
    if (!visible || autoRepairAttempted.current || skipped.openclaw || startState !== "idle") return;
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
  }, [visible, statuses, ocHost, ocUrl, skipped.openclaw, startState, runStart]);

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

  const runTest = async (key: string, spec: Parameters<typeof testConnection>[0]) => {
    setTests((m) => ({ ...m, [key]: "testing" }));
    try {
      const r = await testConnection(spec);
      setTests((m) => ({ ...m, [key]: r }));
    } catch (e) {
      setTests((m) => ({ ...m, [key]: { ok: false, error: e instanceof Error ? e.message : String(e) } }));
    }
  };

  const enter = () => {
    const patch: Partial<AppConfig> = {};
    if (REMOTE_CONNECTIONS_ENABLED && remoteOpen.openclaw && ocUrl.trim()) {
      patch.gatewayUrl = ocUrl.trim();
      if (ocToken.trim()) patch.token = ocToken.trim();
    }
    if (REMOTE_CONNECTIONS_ENABLED && remoteOpen.hermes && hmUrl.trim()) {
      patch.hermesMode = "remote";
      patch.hermesRemotes = [{ profile: "default", baseUrl: hmUrl.trim(), token: hmToken.trim() }];
    }
    void finish(patch);
  };

  if (!visible) return null;

  const tone = (b: BackendStatus): Tone => {
    if (b.connected) return "ok";
    if (skipped[b.id]) return "skipped";
    if (b.id === "openclaw" && startState === "starting") return "detecting";
    // starting = 后端 spawn→ready 启动窗（含自愈重试），按检测中渲染，
    // 不进 warn——正常等待期报错会让首启用户误以为失败。
    if (!statuses || b.info.starting) return "detecting";
    return "warn";
  };

  const statusLine = (b: BackendStatus, tn: Tone): string => {
    if (tn === "detecting") return t("setup.detecting");
    if (tn === "skipped") return t("setup.skipped");
    if (tn === "ok") {
      if (b.id === "openclaw") {
        const base = t("setup.ocConnected", { url: b.info.gatewayUrl || "" });
        return b.info.hasIdentity ? `${base} · ${t("setup.deviceAuthOk")}` : base;
      }
      return t("setup.hermesReady");
    }
    const err = b.info.error || "";
    if (b.id === "openclaw") {
      // S1 的结构化 reason 优先;老网关/未知错误回退正则粗分类。
      const r = b.info.reason;
      if (r === "token_mismatch" || r === "token_missing" || r === "device_token_stale" || r === "pairing_required") {
        return t("setup.ocAuthDenied");
      }
      if (r === "unreachable" || r === "timeout") return t("setup.ocUnreachable");
      return AUTH_ERR.test(err) ? t("setup.ocAuthDenied") : t("setup.ocUnreachable");
    }
    if (MISSING_CLI_ERR.test(err)) return t("setup.hermesMissing");
    // err 为空的兜底：光秃「连接失败：」不可行动，给通用指引。
    // 多行错误（exit 码 + CLI 输出尾）标题行只取首行，全文由下方 code 块显示。
    return err ? t("setup.backendError", { msg: err.split("\n")[0] }) : t("setup.hermesUnreachable");
  };

  const dotClass: Record<Tone, string> = {
    detecting: styles.dotDetecting,
    ok: styles.dotOk,
    warn: styles.dotWarn,
    skipped: styles.dotSkipped,
  };

  const renderTest = (key: string) => {
    const r = tests[key];
    if (!r) return null;
    if (r === "testing") return <span className={styles.testLine}>{t("common.testing")}</span>;
    return (
      <span className={`${styles.testLine} ${r.ok ? styles.testOk : styles.testBad}`}>
        {r.ok ? t("settings.testOk") : `✗ ${r.error || t("common.error")}`}
      </span>
    );
  };

  // 卡片按 getStatus() 返回的后端列表通用渲染；仅远程表单字段随后端分叉
  // （与设置页的分区一致：连接配置天然按后端分，数据仍全走通用 API）。
  const externalCards = (statuses && statuses.length > 0 ? statuses : null)
    ?.filter((b) => !(b.id === "shoggoth"))
    .map((b) => {
    const tn = tone(b);
    const isOc = b.id === "openclaw";
    const formOpen = REMOTE_CONNECTIONS_ENABLED && Boolean(remoteOpen[b.id]);
    const rk = isOc ? reasonKey(b.info.reason) : null;
    return (
      <section key={b.id} className={styles.card}>
        <div className={styles.cardHead}>
          <span className={`${styles.dot} ${dotClass[tn]}`} aria-hidden />
          <span className={styles.name}>{b.name}</span>
          <span className={styles.line}>{statusLine(b, tn)}</span>
        </div>
        {/* 首启梯子(S2):按本机侦察分状态给行动,而不是只报错。 */}
        {tn === "warn" && isOc && ocHost && !ocHost.binPath && (
          <div className={styles.form}>
            <p className={styles.hint}>
              {t("setup.ocNotInstalled")} · {t("setup.ocInstallHint")}
            </p>
            <code className={styles.err}>npm install -g openclaw@latest</code>
            <div className={styles.actions}>
              <button type="button" className={styles.btn} onClick={() => setOcHost(null)}>
                {t("setup.recheck")}
              </button>
            </div>
          </div>
        )}
        {/* loopback 判定用 status 带回的 info.gatewayUrl(服务端探测所用的权威 config 值,
            每轮刷新)——不用表单态 ocUrl,否则与 host 探测目标漂移(preview 实测踩过)。 */}
        {/* localGatewayRunning=true 说明网关其实在跑只是端口不对——自动采用在途,别劝启动 */}
        {tn === "warn" && isOc && ocHost?.binPath && !ocHost.gatewayRunning && !ocHost.localGatewayRunning && isLoopback(b.info.gatewayUrl || ocUrl) && (
          <div className={styles.actions}>
            <span className={styles.line}>
              {t("setup.ocNotRunning", { version: ocHost.version ? ` ${ocHost.version}` : "" })}
            </span>
            <button
              type="button"
              className={styles.btn}
              disabled={startState === "starting"}
              onClick={() => void runStart("start")}
            >
              {startState === "starting" ? t("setup.starting") : t("setup.startGateway")}
            </button>
          </div>
        )}
        {tn === "warn" && isOc && startState === "failed" && (
          <div className={styles.form}>
            <p className={styles.hint}>{t("setup.startFailed")}</p>
            {startOutput && <code className={styles.err}>{startOutput}</code>}
            <div className={styles.actions}>
              <button type="button" className={styles.btn} onClick={() => void runStart("install")}>
                {t("setup.installAndStart")}
              </button>
            </div>
          </div>
        )}
        {tn === "warn" && isOc && ocHost?.gatewayRunning && rk && <p className={styles.hint}>{t(rk)}</p>}
        {tn === "warn" && b.info.error && !MISSING_CLI_ERR.test(b.info.error) && (
          <code className={styles.err}>{b.info.error}</code>
        )}
        {tn === "warn" && (
          <div className={styles.actions}>
            {REMOTE_CONNECTIONS_ENABLED && <button
              type="button"
              className={styles.btn}
              onClick={() => setRemoteOpen((m) => ({ ...m, [b.id]: !formOpen }))}
            >
              {formOpen ? t("setup.remoteCollapse") : t("setup.remoteConnect")}
            </button>}
            <button
              type="button"
              className={styles.btn}
              onClick={() => {
                setSkipped((m) => ({ ...m, [b.id]: true }));
                setRemoteOpen((m) => ({ ...m, [b.id]: false }));
              }}
            >
              {t("setup.skip")}
            </button>
          </div>
        )}
        {tn === "warn" && formOpen && (
          <div className={styles.form}>
            {isOc ? (
              <>
                {/* 局域网发现(S3):列出广播中的网关,点选预填 URL,只补 token */}
                <div className={styles.actions}>
                  <span className={styles.line}>
                    {lanScan === "scanning"
                      ? t("setup.lanScanning")
                      : t("setup.lanFound", { n: Array.isArray(lanScan) ? lanScan.length : 0 })}
                  </span>
                  <button type="button" className={styles.btn} onClick={() => void rescanLan()}>
                    {t("setup.lanRefresh")}
                  </button>
                </div>
                {Array.isArray(lanScan) &&
                  lanScan.map((g) => (
                    <button key={g.url} type="button" className={styles.btn} onClick={() => setOcUrl(g.url)}>
                      {g.name} · {g.url}
                    </button>
                  ))}
                <Field label={t("setup.remoteGatewayUrl")} hint={t("setup.remoteGatewayUrlHint")}>
                  <TextInput value={ocUrl} onChange={(e) => setOcUrl(e.target.value)} autoFocus />
                </Field>
                <Field label={t("setup.tokenLabel")} hint={t("setup.ocTokenHint")}>
                  <TextInput type="password" value={ocToken} onChange={(e) => setOcToken(e.target.value)} />
                </Field>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => runTest(b.id, { backend: "openclaw", gatewayUrl: ocUrl.trim() })}
                  >
                    {t("common.test")}
                  </button>
                  {renderTest(b.id)}
                </div>
              </>
            ) : (
              <>
                <Field label={t("setup.remoteDashUrl")} hint={t("setup.remoteDashUrlHint")}>
                  <TextInput value={hmUrl} onChange={(e) => setHmUrl(e.target.value)} autoFocus />
                </Field>
                <Field label={t("setup.tokenLabel")} hint={t("setup.hermesTokenHint")}>
                  <TextInput type="password" value={hmToken} onChange={(e) => setHmToken(e.target.value)} />
                </Field>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => runTest(b.id, { backend: "hermes", baseUrl: hmUrl.trim(), token: hmToken.trim() })}
                  >
                    {t("common.test")}
                  </button>
                  {renderTest(b.id)}
                </div>
              </>
            )}
          </div>
        )}
      </section>
    );
    });

  const nativeReady = shoggothStatus?.service.healthy === true && shoggothProviders?.profile?.ready === true;
  const nativeDetecting = !shoggothStatus && !shoggothError;
  const nativeBackground = shoggothStatus?.background;
  const nativeAction = nativeBackground?.supported && nativeBackground.needsRepair
    ? "repair"
    : nativeBackground?.supported && !nativeBackground.loaded
      ? nativeBackground.installed ? "start" : "install"
      : null;
  const nativeTone: Tone = nativeReady ? "ok" : nativeDetecting ? "detecting" : "warn";
  const nativeCard = (
    <section className={styles.card} data-backend="shoggoth">
      <div className={styles.cardHead}>
        <span className={`${styles.dot} ${dotClass[nativeTone]}`} aria-hidden />
        <span className={styles.name}>Shoggoth</span>
        <span className={styles.line}>
          {nativeReady
            ? t("setup.shoggothReady")
            : nativeDetecting
              ? t("setup.detecting")
              : shoggothError || shoggothStatus?.service.healthy === false
                ? t("setup.shoggothUnavailable")
                : t("setup.shoggothProviderNeeded")}
        </span>
      </div>
      {!nativeReady && !nativeDetecting && (
        <>
          <div className={styles.actions}>
            {nativeAction && (
              <button
                type="button"
                className={styles.btn}
                disabled={shoggothBusy}
                onClick={() => void runShoggothBackground(nativeAction)}
              >
                {shoggothBusy ? t("setup.shoggothRepairing") : t(`setup.shoggothAction.${nativeAction}`)}
              </button>
            )}
            <button
              type="button"
              className={styles.btn}
              disabled={shoggothBusy}
              onClick={() => {
                setShoggothError(false);
                setShoggothStatus(null);
              }}
            >
              {t("setup.recheck")}
            </button>
          </div>
          {shoggothStatus?.service.healthy && (
            <ShoggothProviderSetup
              snapshot={shoggothProviders}
              onConfigured={async () => {
                const next = await getShoggothProviders();
                setShoggothProviders(next);
              }}
            />
          )}
        </>
      )}
    </section>
  );

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="setup-title">
      <div className={styles.panel}>
        <h1 id="setup-title" className={styles.title}>
          {allReady ? t("setup.allReady") : t("setup.title")}
        </h1>
        <p className={styles.subtitle}>{allReady ? t("setup.autoConnected") : t("setup.subtitle")}</p>
        <div className={styles.cards}>
          {nativeCard}
          {externalCards ?? (
            <section className={styles.card}>
              <div className={styles.cardHead}>
                <span className={`${styles.dot} ${styles.dotDetecting}`} aria-hidden />
                <span className={styles.line}>{t("setup.detecting")}</span>
              </div>
            </section>
          )}
        </div>
        <div className={styles.foot}>
          <span className={styles.hint}>{t("setup.footer")}</span>
          <button type="button" className={styles.primary} onClick={enter} disabled={saving}>
            {saving ? t("common.saving") : t("setup.enter")}
          </button>
        </div>
      </div>
    </div>
  );
}
