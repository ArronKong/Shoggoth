import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AppConfig,
  BackendSelfUpdate,
  BackendStatus,
  BackendVersionStatus,
  RuntimeStatus,
  ConnTestResult,
  HermesRemote,
  LanDiscoveryState,
  SelfUpdateRun,
  ShoggothProductStatus,
  StandingGrant,
  StandingGrantList,
} from "../types";
import {
  getConfig,
  getLanDiscovery,
  getSelfUpdates,
  getShoggothProductStatus,
  getStatus,
  getRuntimeStatuses,
  getVersions,
  listStandingGrants,
  revokeStandingGrant,
  runSelfUpdate,
  runShoggothBackgroundAction,
  setLanDiscovery,
  testConnection,
  updateConfig,
} from "../api/client";
import { Field, Switch, TextInput } from "../components/Field";
import { useConfirm, useToast } from "../components/ui";
import { applyConfiguredLocale } from "../i18n";
import { setTheme } from "../lib/theme";
import { createSettingsLifecycleGuard } from "../lib/lowUiLifecycle";
import { isLocalGatewayUrl, REMOTE_CONNECTIONS_ENABLED } from "../lib/connectionOptions";
import {
  recoverShoggothStartup,
  shouldRecoverShoggothStartup,
} from "../lib/shoggothStartupRecovery";
import { setDebugEnabled, useDebugEnabled } from "../components/debug/store";
import { PageHead } from "../components/PageHead";
import SettingsPreferences from "./settings/SettingsPreferences";
import BackendOverview from "./settings/BackendOverview";
import ServiceSettings from "./settings/ServiceSettings";
import NativeCapacityCard from "./settings/NativeCapacityCard";
import RuntimeStatusList from "./settings/RuntimeStatusList";
import BackgroundStopDialog from "./settings/BackgroundStopDialog";
import { useRegisterPageRefresh, useRegisterPageLoading } from "../lib/page-refresh";
import { applyDisabledBackends, useBackendCatalog } from "../lib/backends";
import "./SettingsPage.css";
import "./settings/SettingsLayout.css";
import "./settings/SettingsOperations.css";

const SHOGGOTH_POST_START_REFRESH_DELAYS_MS = [250, 500, 1_000, 2_000] as const;
// Keep writes ordered even when Settings is left and reopened before a response.
let settingsSaveQueue: Promise<void> = Promise.resolve();

export function updateActionForCapabilityReview(status?: SelfUpdateRun): "update" | "repair" {
  return status?.operation === "repair" ? "repair" : "update";
}

export function isActionableUpdatePhase(status?: SelfUpdateRun): boolean {
  return status?.phase === "repair_required" || status?.phase === "capability_review_required";
}

// REST 已把 standing grants 白名单化；组件再只取展示所需身份与生命周期字段，
// 防止未来扩展 API 字段时被无意渲染。
export function standingGrantView(grant: StandingGrant) {
  return {
    title: grant.cronJobName || grant.agentId,
    agentId: grant.agentId,
    createdAtMs: grant.createdAtMs,
    expiresAtMs: grant.expiresAtMs,
    useCount: grant.useCount,
  };
}

function cloneConfig(c: AppConfig): AppConfig {
  return {
    ...c,
    hermesRemotes: (c.hermesRemotes || []).map((remote) => ({ ...remote })),
    disabledBackends: [...(c.disabledBackends || [])],
    notifications: { ...c.notifications },
  };
}

const EMPTY: AppConfig = {
  gatewayUrl: "",
  token: "",
  locale: "",
  theme: "light",
  hermesMode: "local",
  hermesRemotes: [],
  hermesKeepAlive: true,
  disabledBackends: [],
  notifications: { chat: true, cron: true, task: true },
  setupCompletedAt: 0,
};

type RemoteProfileValidationIssue =
  | { kind: "missing-url"; row: number }
  | { kind: "duplicate-profile"; profile: string };

// 保存前按 Hermes 最终 agent id 校验 remote 行；返回结构化问题，由页面负责翻译。
// 归一规则与 backend 的 agentIdForProfile 一致，并由跨层回归向量持续锁定。
export function validateRemoteProfilesForSave(
  remotes: ReadonlyArray<Pick<HermesRemote, "profile" | "baseUrl">>,
): RemoteProfileValidationIssue | null {
  const seenIdentities = new Set<string>();
  for (let i = 0; i < remotes.length; i += 1) {
    const remote = remotes[i];
    if (!String(remote.baseUrl || "").trim()) return { kind: "missing-url", row: i + 1 };
    const profile = String(remote.profile || "").trim() || "default";
    const safe = profile
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const identity = `hermes-${safe || "default"}`;
    if (seenIdentities.has(identity)) return { kind: "duplicate-profile", profile };
    seenIdentities.add(identity);
  }
  return null;
}

export default function SettingsPage() {
  const { t, i18n } = useTranslation();
  const backendCatalog = useBackendCatalog();
  const backendDescriptors = useMemo(
    () => new Map(backendCatalog.map((descriptor) => [descriptor.id, descriptor])),
    [backendCatalog],
  );
  const [backends, setBackends] = useState<BackendStatus[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([]);
  const [runtimesLoading, setRuntimesLoading] = useState(true);
  const [runtimesError, setRuntimesError] = useState(false);
  const [cfg, setCfg] = useState<AppConfig>(EMPTY);
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const [versions, setVersions] = useState<BackendVersionStatus[]>([]);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [selfUpdates, setSelfUpdates] = useState<BackendSelfUpdate[]>([]);
  const [standingGrants, setStandingGrants] = useState<Record<string, StandingGrantList>>({});
  const [revokingGrant, setRevokingGrant] = useState<string | null>(null);
  const [shoggothStatus, setShoggothStatus] = useState<ShoggothProductStatus | null>(null);
  const [stopDialogOpen, setStopDialogOpen] = useState(false);
  const shoggothStatusRef = useRef(shoggothStatus);
  shoggothStatusRef.current = shoggothStatus;
  const [shoggothError, setShoggothError] = useState(false);
  const [shoggothBusy, setShoggothBusy] = useState<"install" | "start" | "stop" | "repair" | null>(null);
  const serviceRetrySequence = useRef(0);
  const [loading, setLoading] = useState(true);
  const [themeLoaded, setThemeLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // LAN 发现开关(S3):独立小状态,加载失败静默隐藏(不影响其余设置)。
  const [lan, setLan] = useState<LanDiscoveryState | null>(null);
  const [lanBusy, setLanBusy] = useState(false);
  const [configFailed, setConfigFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [togglingBackend, setTogglingBackend] = useState(false);
  const backendConnectionBusy = useRef(false);
  const [reconnectingBackends, setReconnectingBackends] = useState<string[]>([]);
  const savedConfigRef = useRef<AppConfig | null>(null);
  const pendingSavesRef = useRef(0);
  const editVersionsRef = useRef<Partial<Record<keyof AppConfig, number>>>({});
  const connectionSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingConnectionRef = useRef<Partial<AppConfig>>({});
  const [tests, setTests] = useState<Record<string, ConnTestResult | "testing">>({});
  // Stable per-row ids for the remote list so test results + React keys don't
  // shift when a row above is removed (a bare array index would). Not persisted.
  const [remoteUids, setRemoteUids] = useState<string[]>([]);
  const uidSeq = useRef(0);
  const nextUid = () => String((uidSeq.current += 1));
  const lifecycleGuardRef = useRef<ReturnType<typeof createSettingsLifecycleGuard> | null>(null);
  if (!lifecycleGuardRef.current) lifecycleGuardRef.current = createSettingsLifecycleGuard();
  const lifecycleGuard = lifecycleGuardRef.current;

  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const confirm = useConfirm();
  const debugOn = useDebugEnabled();
  const versionsById = useMemo(() => new Map(versions.map((v) => [v.id, v])), [versions]);
  const selfUpdatesById = useMemo(() => new Map(selfUpdates.map((u) => [u.id, u])), [selfUpdates]);

  // Only write edited fields, in order. A slow response must not replace a newer
  // choice or another control's independently persisted configuration.
  const persistSettings = useCallback((patch: Partial<AppConfig>) => {
    const keys = Object.keys(patch) as Array<keyof AppConfig>;
    if (keys.length === 0) return settingsSaveQueue;
    const versions = { ...editVersionsRef.current };
    pendingSavesRef.current += 1;
    if (lifecycleGuard.isMounted()) setSaving(true);
    const reconcile = (values: AppConfig) => {
      const current = { ...cfgRef.current };
      for (const key of keys) {
        if (editVersionsRef.current[key] === versions[key]) {
          Object.assign(current, { [key]: values[key] });
        }
      }
      cfgRef.current = current;
      if (lifecycleGuard.isMounted()) setCfg(current);
    };
    settingsSaveQueue = settingsSaveQueue.then(async () => {
      try {
        const saved = await updateConfig({
          ...patch, setupCompletedAt: savedConfigRef.current?.setupCompletedAt || Date.now(),
        });
        const confirmed = { ...savedConfigRef.current!, setupCompletedAt: saved.setupCompletedAt };
        for (const key of keys) Object.assign(confirmed, { [key]: saved[key] });
        savedConfigRef.current = cloneConfig(confirmed);
        reconcile(saved);
        if ("theme" in patch) setTheme(saved.theme);
        if ("locale" in patch) await applyConfiguredLocale(saved.locale);
        window.dispatchEvent(new CustomEvent("openclaw:config-changed"));
        if (lifecycleGuard.isMounted() && ("gatewayUrl" in patch || "hermesMode" in patch || "hermesRemotes" in patch)) {
          const ids = ["gatewayUrl" in patch ? "openclaw" : "hermes"];
          if ("hermesMode" in patch || "hermesRemotes" in patch) ids.push("hermes");
          setReconnectingBackends((current) => [...new Set([...current, ...ids])]);
        }
      } catch (e) {
        if (savedConfigRef.current) {
          reconcile(savedConfigRef.current);
          if ("theme" in patch) setTheme(savedConfigRef.current.theme);
        }
        toastRef.current.error(i18n.t("settings.autoSaveFailed", { msg: e instanceof Error ? e.message : String(e) }));
      } finally {
        pendingSavesRef.current -= 1;
        if (lifecycleGuard.isMounted()) setSaving(pendingSavesRef.current > 0);
      }
    });
    return settingsSaveQueue;
  }, [i18n, lifecycleGuard]);

  const flushConnectionChanges = useCallback(() => {
    if (connectionSaveTimerRef.current !== null) clearTimeout(connectionSaveTimerRef.current);
    connectionSaveTimerRef.current = null;
    const patch = pendingConnectionRef.current;
    // Incomplete text stays in the editor, while unrelated preferences can save.
    if (patch.gatewayUrl !== undefined && !REMOTE_CONNECTIONS_ENABLED && !isLocalGatewayUrl(patch.gatewayUrl)) return;
    if (REMOTE_CONNECTIONS_ENABLED && cfgRef.current.hermesMode === "remote"
      && validateRemoteProfilesForSave(cfgRef.current.hermesRemotes)) return;
    pendingConnectionRef.current = {};
    void persistSettings(patch);
  }, [persistSettings]);

  const changeSettings = (patch: Partial<AppConfig>, textInput = false) => {
    if (loading || configFailed) return;
    const changed = Object.fromEntries(Object.entries(patch)
      .filter(([key, value]) => JSON.stringify(cfgRef.current[key as keyof AppConfig]) !== JSON.stringify(value))) as Partial<AppConfig>;
    if (Object.keys(changed).length === 0) return;
    for (const key of Object.keys(changed) as Array<keyof AppConfig>) {
      editVersionsRef.current[key] = (editVersionsRef.current[key] || 0) + 1;
    }
    cfgRef.current = { ...cfgRef.current, ...changed };
    setCfg(cfgRef.current);
    if (textInput) {
      pendingConnectionRef.current = { ...pendingConnectionRef.current, ...changed };
      if (connectionSaveTimerRef.current !== null) clearTimeout(connectionSaveTimerRef.current);
      connectionSaveTimerRef.current = setTimeout(flushConnectionChanges, 500);
    } else {
      void persistSettings(changed);
    }
  };

  const refresh = useCallback(async () => {
    if (!lifecycleGuard.isMounted()) return;
    const refreshTicket = lifecycleGuard.beginRefresh();
    serviceRetrySequence.current += 1;
    setTests({});
    setStandingGrants({});
    // 每个异步分支落状态前都复用同一判定，避免旧实例覆盖新页面。
    const isCurrentRefresh = () => lifecycleGuard.isRefreshCurrent(refreshTicket);
    setLoading(true);
    setError(null);
    setConfigFailed(false);
    // Config is a local file read (instant) — load it FIRST and unblock the form,
    // so the editable fields appear even when a backend is unreachable (getStatus
    // can block ~8s on a dead gateway). A config-load failure disables editing so we
    // never PUT an empty form back over the user's real settings.
    try {
      flushConnectionChanges();
      await settingsSaveQueue;
      if (!isCurrentRefresh()) return;
      const c = await getConfig();
      if (!isCurrentRefresh()) return;
      const nextConfig = { ...EMPTY, ...c };
      savedConfigRef.current = cloneConfig(nextConfig);
      setThemeLoaded(true);
      setTheme(nextConfig.theme);
      cfgRef.current = nextConfig;
      setCfg(nextConfig);
      pendingConnectionRef.current = {};
      setRemoteUids((c.hermesRemotes || []).map(() => nextUid()));
    } catch (e) {
      if (!isCurrentRefresh()) return;
      setConfigFailed(true);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (isCurrentRefresh()) setLoading(false);
    }
    if (!isCurrentRefresh()) return;
    // Status + versions fill in asynchronously; neither blocks editing/saving.
    setRuntimesLoading(true);
    setRuntimesError(false);
    getRuntimeStatuses().then((items) => { if (isCurrentRefresh()) setRuntimes(items); })
      .catch(() => { if (isCurrentRefresh()) setRuntimesError(true); })
      .finally(() => { if (isCurrentRefresh()) setRuntimesLoading(false); });
    getStatus()
      .then((next) => {
        if (!isCurrentRefresh()) return;
        setBackends(next.map((backend) => ({ ...backend,
          disabled: backendDescriptors.get(backend.id)?.disconnectable !== false && cfgRef.current.disabledBackends.includes(backend.id),
          connected: (backendDescriptors.get(backend.id)?.disconnectable === false || !cfgRef.current.disabledBackends.includes(backend.id)) && backend.connected,
        })));
        void Promise.all(next.filter((backend) => !backend.disabled).map(async (backend) => {
          try {
            return [backend.id, await listStandingGrants(backend.id)] as const;
          } catch {
            return null;
          }
        })).then((items) => {
          if (!isCurrentRefresh()) return;
          setStandingGrants(Object.fromEntries(items.filter((item): item is readonly [string, StandingGrantList] => !!item)));
        });
      })
      .catch(() => { if (isCurrentRefresh()) setBackends([]); });
    getShoggothProductStatus()
      .then((nextStatus) => {
        if (!isCurrentRefresh()) return;
        setShoggothStatus(nextStatus);
        setShoggothError(false);
      })
      .catch(() => {
        if (isCurrentRefresh()) setShoggothError(true);
      });
    setVersionError(null);
    getVersions()
      .then((next) => { if (isCurrentRefresh()) setVersions(next); })
      .catch((e) => { if (isCurrentRefresh()) setVersionError(e instanceof Error ? e.message : String(e)); });
    // 找回切页前仍在跑的更新（轮询 effect 见下），失败静默——按钮降级为不显示进度。
    getSelfUpdates()
      .then((next) => { if (isCurrentRefresh()) setSelfUpdates(next); })
      .catch(() => {});
  }, [flushConnectionChanges, lifecycleGuard]);

  const shoggothRetry = useCallback(() => {
    // Retry service diagnostics without replacing the user's connection draft.
    const sequence = ++serviceRetrySequence.current;
    const isCurrent = () => lifecycleGuard.isMounted() && serviceRetrySequence.current === sequence;
    setShoggothStatus(null);
    setShoggothError(false);
    void getShoggothProductStatus().then((next) => {
      if (!isCurrent()) return;
      setShoggothStatus(next);
    }).catch(() => {
      if (isCurrent()) setShoggothError(true);
    });
  }, [lifecycleGuard]);

  const runShoggothAction = async (action: "install" | "start" | "stop" | "repair") => {
    if (action === "stop") { setStopDialogOpen(true); return; }
    serviceRetrySequence.current += 1;
    setShoggothBusy(action);
    try {
      const next = await runShoggothBackgroundAction(action);
      if (!lifecycleGuard.isMounted()) return;
      setShoggothStatus(next);
      setShoggothError(false);
      if (next.service.healthy === true && next.service.pendingCommandsLocked) {
        // 待执行命令的加密状态可能晚于 Service 健康收敛，有限回读一次。
        // MCP 凭据按需初始化，不参与 Service 的启动就绪判定。
        for (const delayMs of SHOGGOTH_POST_START_REFRESH_DELAYS_MS) {
          await new Promise((resolve) => window.setTimeout(resolve, delayMs));
          if (!lifecycleGuard.isMounted()) return;
          try {
            const settledStatus = await getShoggothProductStatus();
            if (!lifecycleGuard.isMounted()) return;
            setShoggothStatus(settledStatus);
            if (!settledStatus.service.pendingCommandsLocked) break;
          } catch {
            break;
          }
        }
      }
      toast.success(t("settings.shoggothActionDone"));
    } catch {
      if (!lifecycleGuard.isMounted()) return;
      // launchctl 的 stop/repair 是异步收敛：动作响应可能在权威状态已经变化后
      // 仍返回失败。立即回读一次，让页面保留“启动/重新连接”出口；错误 toast
      // 继续显示，不能把权限失败等真实错误伪报成成功。
      try {
        const recoveredStatus = await getShoggothProductStatus();
        if (!lifecycleGuard.isMounted()) return;
        setShoggothStatus(recoveredStatus);
        setShoggothError(false);
      } catch {
        if (!lifecycleGuard.isMounted()) return;
        setShoggothError(true);
      }
      toast.error(t("settings.shoggothActionFailed"));
    } finally {
      if (lifecycleGuard.isMounted()) setShoggothBusy(null);
    }
  };

  useEffect(() => {
    lifecycleGuard.mount();
    void refresh();
    return () => {
      lifecycleGuard.unmount();
      // Navigation must not discard the last debounced edit. The queue finishes
      // without writing component state after unmount.
      flushConnectionChanges();
    };
  }, [flushConnectionChanges, lifecycleGuard, refresh]);
  const shoggothStartupRecoveryNeeded = shoggothBusy === null
    && shouldRecoverShoggothStartup(shoggothStatus);
  useEffect(() => {
    const initialStatus = shoggothStatusRef.current;
    if (!shoggothStartupRecoveryNeeded || !initialStatus) return;
    let current = true;
    void recoverShoggothStartup({
      initialStatus,
      getStatus: getShoggothProductStatus,
      isCurrent: () => current && lifecycleGuard.isMounted(),
      onStatus: (status) => {
        setShoggothStatus(status);
        setShoggothError(false);
      },
    }).catch(() => {});
    return () => { current = false; };
  }, [lifecycleGuard, shoggothStartupRecoveryNeeded]);
  useRegisterPageRefresh("/settings", refresh);
  useRegisterPageLoading("/settings", loading);

  // 自更新是后台长操作：有 running 时轮询进度；跑完的那一沿弹结果并刷新版本号。
  const prevUpdatingRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const running = new Set(selfUpdates.filter((u) => u.status?.running).map((u) => u.id));
    for (const id of prevUpdatingRef.current) {
      if (running.has(id)) continue;
      const u = selfUpdatesById.get(id);
      if (!u?.status) continue;
      const name = u.name || id;
      if (isActionableUpdatePhase(u.status)) {
        // Repair/capability review are deliberate user decision points rendered
        // inline below. Do not misreport them as a terminal update failure.
        continue;
      } else if (!u.status.ok) {
        // exitCode 0 + postUpdateError = 更新命令成功但服务没回来（健康检查失败）。
        const serviceDown = !!u.status.postUpdateError && u.status.exitCode === 0;
        const msg = u.status.postUpdateError || u.status.error || `exit ${u.status.exitCode}`;
        toast.error(t(serviceDown ? "settings.updateRestartFailed" : "settings.updateFailed", { name, msg }));
      } else {
        toast.success(t("settings.updateDone", { name }));
      }
      getVersions().then(setVersions).catch(() => {});
      getStatus().then(setBackends).catch(() => {});
    }
    prevUpdatingRef.current = running;
    if (running.size === 0) return;
    const timer = setInterval(() => {
      getSelfUpdates().then(setSelfUpdates).catch(() => {});
    }, 2500);
    return () => clearInterval(timer);
  }, [selfUpdates, selfUpdatesById, toast, t]);

  // Every updater action is backend-advertised. Capability widening can only
  // enter through the explicit second confirmation rendered after review.
  const startUpdate = async (
    target: Pick<BackendVersionStatus, "id" | "name">,
    action: "update" | "repair" = "update",
    acceptCapabilities = false,
  ) => {
    const okToRun = await confirm({
      title: t(
        acceptCapabilities
          ? "settings.capabilityReviewConfirmTitle"
          : action === "repair"
            ? "settings.repairConfirmTitle"
            : "settings.updateConfirmTitle",
        { name: target.name },
      ),
      message: t(
        acceptCapabilities
          ? "settings.capabilityReviewConfirmMessage"
          : action === "repair"
            ? "settings.repairConfirmMessage"
            : "settings.updateConfirmMessage",
      ),
      confirmLabel: t(
        acceptCapabilities
          ? "settings.acceptCapabilities"
          : action === "repair"
            ? "settings.repairNow"
            : "settings.updateNow",
      ),
      danger: acceptCapabilities,
    });
    if (!okToRun) return;
    try {
      const r = await runSelfUpdate(target.id, { action, acceptCapabilities });
      if (!r.supported) {
        toast.error(t("settings.updateUnsupportedRemote"));
        return;
      }
      setSelfUpdates((prev) => [...prev.filter((u) => u.id !== r.id), r]);
      toast.success(t(action === "repair" ? "settings.repairStarted" : "settings.updateStarted", { name: target.name }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const revokeGrant = async (backend: Pick<BackendStatus, "id" | "name">, grant: StandingGrant) => {
    const view = standingGrantView(grant);
    const ok = await confirm({
      title: t("settings.revokeGrantConfirmTitle"),
      message: t("settings.revokeGrantConfirmMessage", { name: view.title }),
      confirmLabel: t("settings.revokeGrant"),
      danger: true,
    });
    if (!ok) return;
    const busyKey = `${backend.id}:${grant.grantId}`;
    setRevokingGrant(busyKey);
    try {
      const result = await revokeStandingGrant(backend.id, grant.grantId);
      if (!result.supported) {
        setStandingGrants((current) => ({
          ...current,
          [backend.id]: { supported: false, reason: result.reason, grants: [] },
        }));
        toast.info(t("settings.standingGrantsUnavailable", { name: backend.name }));
        return;
      }
      const next = await listStandingGrants(backend.id);
      setStandingGrants((current) => ({ ...current, [backend.id]: next }));
      toast.success(t("settings.grantRevoked"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRevokingGrant(null);
    }
  };

  // 输入变化会立即作废该行的旧测试结果和所有在途响应。
  const invalidateTest = (key: string) => {
    lifecycleGuard.invalidateTest(key);
    setTests((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const setRemote = (i: number, patch: Partial<HermesRemote>) => {
    const next = cfg.hermesRemotes.slice();
    next[i] = { ...next[i], ...patch };
    const uid = remoteUids[i];
    if (uid && ("baseUrl" in patch || "token" in patch)) invalidateTest(`hermes-${uid}`);
    changeSettings({ hermesRemotes: next }, true);
  };
  const addRemote = () => {
    changeSettings({ hermesRemotes: [...cfg.hermesRemotes, { profile: "default", baseUrl: "", token: "" }] }, true);
    setRemoteUids((u) => [...u, nextUid()]);
  };
  const removeRemote = (i: number) => {
    const uid = remoteUids[i];
    changeSettings({ hermesRemotes: cfg.hermesRemotes.filter((_, idx) => idx !== i) }, true);
    setRemoteUids((u) => u.filter((_, idx) => idx !== i));
    if (uid) invalidateTest(`hermes-${uid}`);
  };

  // PUT 前阻止无 URL 或最终 agent identity 碰撞，避免后端清洗后行静默消失。
  const validateRemotes = (): string | null => {
    if (!REMOTE_CONNECTIONS_ENABLED || cfg.hermesMode !== "remote") return null;
    const issue = validateRemoteProfilesForSave(cfg.hermesRemotes);
    if (!issue) return null;
    if (issue.kind === "missing-url") return t("settings.remoteUrlRequired", { n: issue.row });
    return t("settings.remoteDuplicateProfile", { profile: issue.profile });
  };

  // LAN 发现:进页拉一次;切换写网关 plugins.allow(重启网关生效,toast 提示)。
  useEffect(() => {
    if (!REMOTE_CONNECTIONS_ENABLED) return;
    getLanDiscovery("openclaw")
      .then(setLan)
      .catch(() => setLan(null));
  }, []);
  const onToggleLan = async (v: boolean) => {
    setLanBusy(true);
    try {
      const r = await setLanDiscovery("openclaw", v);
      setLan((s) => (s ? { ...s, enabled: r.enabled } : s));
      if (r.requiresRestart) toast.success(t("settings.lanRestartHint"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLanBusy(false);
    }
  };

  // The host applies connection changes after responding to the config write.
  // Reconcile reconnecting rows without refreshing the form or its UI state.
  useEffect(() => {
    if (reconnectingBackends.length === 0) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + 75_000;
    const poll = async () => {
      try {
        const statuses = await getStatus();
        if (!active) return;
        setBackends((items) => items.map((backend) => {
          if (!reconnectingBackends.includes(backend.id)) return backend;
          const status = statuses.find((item) => item.id === backend.id);
          if (!status) return backend;
          const disabled = backendDescriptors.get(backend.id)?.disconnectable !== false && cfgRef.current.disabledBackends.includes(backend.id);
          return { ...status, disabled, connected: !disabled && status.connected };
        }));
        const completed = reconnectingBackends.filter((id) =>
          cfgRef.current.disabledBackends.includes(id) || statuses.some((status) => status.id === id && status.connected));
        if (completed.length > 0) {
          setReconnectingBackends((ids) => ids.filter((id) => !completed.includes(id)));
        }
      } catch { /* Keep the saved connection intent; a later sample may recover. */ }
      if (!active) return;
      if (Date.now() < deadline) timer = setTimeout(() => void poll(), 1_000);
      else setReconnectingBackends((ids) => ids.filter((id) => !reconnectingBackends.includes(id)));
    };
    timer = setTimeout(() => void poll(), 250);
    return () => { active = false; clearTimeout(timer); };
  }, [reconnectingBackends]);

  // Only persist disabledBackends. Draft fields, tabs and expanded rows stay in place.
  const isDisconnectable = useCallback((b: BackendStatus) => {
    const descriptor = backendDescriptors.get(b.id);
    if (descriptor) return descriptor.disconnectable;
    return ["gateway", "managed-service", "native-runtime", "builtin-service"].includes(b.info.connectionMode || "");
  }, [backendDescriptors]);
  const enabledCount = backends.filter((b) => !b.disabled).length;
  const toggleBackendConnection = async (b: BackendStatus) => {
    if (!isDisconnectable(b) || loading || configFailed || saving || backendConnectionBusy.current) return;
    const disconnect = !b.disabled;
    if (disconnect && enabledCount <= 1) return;
    if (disconnect) {
      const mode = backendDescriptors.get(b.id)?.connectionMode || b.info.connectionMode;
      const native = mode === "native-runtime" || mode === "builtin-service";
      const ok = await confirm({
        title: t("settings.disconnectConfirmTitle", { name: b.name }),
        message: t(native ? "settings.disconnectNativeConfirmMessage" : "settings.disconnectConfirmMessage", { name: b.name }),
        confirmLabel: t("settings.disconnect"),
      });
      if (!ok) return;
    }
    await applyBackendConnection(b, disconnect);
  };

  const toggleRuntimeConnection = async (runtime: RuntimeStatus) => {
    if (loading || configFailed || saving || backendConnectionBusy.current || !runtime.releaseEnabled) return;
    if (runtime.enabled && !await confirm({
      title: t("settings.disconnectConfirmTitle", { name: runtime.name }),
      message: t("settings.disconnectNativeConfirmMessage", { name: runtime.name }),
      confirmLabel: t("settings.disconnect"),
    })) return;
    await applyBackendConnection({ id: runtime.runtime, name: runtime.name }, runtime.enabled);
  };

  const applyBackendConnection = async (b: Pick<BackendStatus, "id" | "name">, disconnect: boolean) => {
    if (saving || backendConnectionBusy.current) return;
    const current = cfgRef.current.disabledBackends || [];
    const next = disconnect ? [...new Set([...current, b.id])] : current.filter((id) => id !== b.id);
    if (disconnect && !backends.some((backend) => !next.includes(backend.id))) return;
    backendConnectionBusy.current = true;
    setTogglingBackend(true);
    try {
      const saved = await updateConfig({ disabledBackends: next });
      applyDisabledBackends(saved.disabledBackends);
      if (!lifecycleGuard.isMounted()) return;
      cfgRef.current = { ...cfgRef.current, disabledBackends: saved.disabledBackends };
      setCfg(cfgRef.current);
      if (savedConfigRef.current) savedConfigRef.current.disabledBackends = [...saved.disabledBackends];
      setBackends((items) => items.map((backend) => ({ ...backend,
        disabled: backendDescriptors.get(backend.id)?.disconnectable !== false && saved.disabledBackends.includes(backend.id),
        connected: (backendDescriptors.get(backend.id)?.disconnectable === false || !saved.disabledBackends.includes(backend.id)) && backend.connected,
      })));
      if (backendDescriptors.has(b.id)) setReconnectingBackends((ids) => disconnect ? ids.filter((id) => id !== b.id) : [...new Set([...ids, b.id])]);
      toast.success(
        disconnect
          ? t("settings.disconnectedToast", { name: b.name })
          : t("settings.reconnectingToast", { name: b.name }),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      backendConnectionBusy.current = false;
      if (lifecycleGuard.isMounted()) setTogglingBackend(false);
    }
  };

  // 测试开始时领取序号，只有当前行最后发出的请求可以落状态。
  const runTest = async (key: string, spec: Parameters<typeof testConnection>[0]) => {
    const testTicket = lifecycleGuard.beginTest(key);
    setTests((t) => ({ ...t, [key]: "testing" }));
    const isCurrentTest = () => lifecycleGuard.isTestCurrent(testTicket);
    try {
      const r = await testConnection(spec);
      if (!isCurrentTest()) return;
      setTests((t) => ({ ...t, [key]: r }));
    } catch (e) {
      if (!isCurrentTest()) return;
      setTests((t) => ({ ...t, [key]: { ok: false, error: e instanceof Error ? e.message : String(e) } }));
    }
  };

  const renderTest = (key: string) => {
    const r = tests[key];
    if (!r) return null;
    if (r === "testing") return <span className="muted">{t("common.testing")}</span>;
    return r.ok ? (
      <span className="status-ok">{t("settings.testOk")}</span>
    ) : (
      <span className="status-error">✗ {r.error}</span>
    );
  };

  // 版本为空时用统一占位，避免不同后端失败时出现空白行。
  const formatVersion = (value?: string) => value || t("settings.versionUnknown");

  // 根据后端返回的比较结果生成状态文案；无法比较时不误报更新。
  const versionStateText = (v?: BackendVersionStatus) => {
    if (!v) return versionError ? t("settings.versionCheckFailed") : t("settings.versionUnknown");
    if (v.updateAvailable === true) return t("settings.updateAvailable");
    if (v.updateAvailable === false) return t("settings.upToDate");
    if (v.error) return t("settings.versionCheckFailed");
    return t("settings.versionUnableToCompare");
  };

  // 状态颜色只表达确定结论：有更新=告警，已最新=绿色，其它保持弱提示。
  const versionStateClass = (v?: BackendVersionStatus) => {
    if (v?.updateAvailable === true) return "status-version-warn";
    if (v?.updateAvailable === false) return "status-ok";
    if (v?.error || versionError) return "status-error";
    return "muted";
  };

  const updatePhaseText = (status: SelfUpdateRun) => {
    switch (status.phase) {
      case "updating": return t("settings.updatePhaseUpdating");
      case "finalizing": return t("settings.updatePhaseFinalizing");
      case "restart_pending": return t("settings.updatePhaseRestartPending");
      case "verifying": return t("settings.updatePhaseVerifying");
      case "repair_required": return t("settings.updatePhaseRepairRequired");
      case "capability_review_required": return t("settings.updatePhaseCapabilityReview");
      case "completed": return t("settings.updatePhaseCompleted");
      case "failed": return t("settings.updatePhaseFailed");
      default: return status.running ? t("settings.updating") : t("settings.versionUnknown");
    }
  };

  const updateOperationText = (operation?: SelfUpdateRun["operation"]) => {
    switch (operation) {
      case "update": return t("settings.updateOperationUpdate");
      case "repair": return t("settings.updateOperationRepair");
      case "doctor": return t("settings.updateOperationDoctor");
      case "gateway_status": return t("settings.updateOperationGatewayStatus");
      default: return t("settings.versionUnknown");
    }
  };

  // 「立即更新」动作只消费后端声明的 actions；不存在能力时不猜、不显示。
  const renderUpdateAction = (v?: BackendVersionStatus) => {
    if (!v) return null;
    const u = selfUpdatesById.get(v.id);
    if (u?.status?.running) return null;
    if (v.updateAvailable !== true || !u?.supported || !u.actions?.includes("update")) return null;
    return (
      <button className="ui-cbtn ui-cbtn--sm" onClick={() => startUpdate(v, "update")}>
        {t("settings.updateNow")}
      </button>
    );
  };

  const renderUpdaterStatus = (target: Pick<BackendVersionStatus, "id" | "name">) => {
    const update = selfUpdatesById.get(target.id);
    const status = update?.status;
    if (!status) return null;
    const reviewAction = updateActionForCapabilityReview(status);
    const canContinueReview = !!update?.supported && !!update.actions?.includes(reviewAction);
    const canRepair = !!update?.supported && !!update.actions?.includes("repair");
    const failure = !status.running && status.ok === false && !isActionableUpdatePhase(status);
    const at = status.finishedAt ? new Date(status.finishedAt).toLocaleString() : "";
    const reason = [status.error, status.postUpdateError, status.reason].filter(Boolean).join("; ");
    return (
      <div className={`update-state update-state--${status.phase || "unknown"}`}>
        <div className="status-row">
          <span className="status-label">{t("settings.updateProgress")}</span>
          <span className={failure ? "status-error" : "muted"}>
            {updatePhaseText(status)} · {updateOperationText(status.operation)}
          </span>
        </div>
        {failure && (
          <div className="update-failure">
            <div className="status-error">
              {status.interrupted
                ? t("settings.lastUpdateInterrupted")
                : t("settings.lastUpdateFailed", { at })}
            </div>
            {!status.interrupted && !!reason && <div className="update-failure-reason">{reason}</div>}
          </div>
        )}
        {!!status.progressTail && (
          <details className="update-log" open={status.running}>
            <summary>{t("settings.updateProgressTail")}</summary>
            <pre>{status.progressTail}</pre>
          </details>
        )}
        {status.phase === "repair_required" && (
          <div className="update-decision">
            <p>{t("settings.updateRepairRequired")}</p>
            {(status.findings?.length || status.pluginWarnings?.length || status.pluginVersionDrift?.length) ? (
              <p className="muted">
                {t("settings.updateRepairIssueCount", {
                  count: (status.findings?.length || 0)
                    + (status.pluginWarnings?.length || 0)
                    + (status.pluginVersionDrift?.length || 0),
                })}
              </p>
            ) : null}
            {canRepair && (
              <button className="ui-cbtn ui-cbtn--sm" onClick={() => startUpdate(target, "repair")}>
                {t("settings.repairNow")}
              </button>
            )}
          </div>
        )}
        {status.phase === "capability_review_required" && (
          <div className="update-decision update-decision--warning">
            <p>{t("settings.capabilityReviewRequired")}</p>
            <ul className="update-capability-list">
              {(status.capabilityReviews || []).map((review, index) => (
                <li key={`${review.pluginId || "plugin"}-${index}`}>
                  <strong>{review.pluginId || t("settings.unknownPlugin")}</strong>
                  {review.message && <span>{review.message}</span>}
                </li>
              ))}
            </ul>
            {canContinueReview && (
              <button
                className="ui-cbtn ui-cbtn--sm ui-cbtn--danger"
                onClick={() => startUpdate(target, reviewAction, true)}
              >
                {t("settings.acceptCapabilities")}
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderStandingGrants = (backend: Pick<BackendStatus, "id" | "name">) => {
    const result = standingGrants[backend.id];
    if (!result?.supported) return null;
    const active = result.grants.filter((grant) => !grant.revokedAtMs);
    return (
      <div className="standing-grants">
        <div className="standing-grants__head">
          <span>{t("settings.standingGrants")}</span>
          <span className="muted">{active.length}</span>
        </div>
        {active.length === 0 ? (
          <p className="ui-hint">{t("settings.noStandingGrants")}</p>
        ) : (
          <div className="standing-grants__list">
            {active.map((grant) => {
              const view = standingGrantView(grant);
              const busyKey = `${backend.id}:${grant.grantId}`;
              return (
                <div className="standing-grant" key={grant.grantId}>
                  <div className="standing-grant__body">
                    <strong>{view.title}</strong>
                    <span className="muted">{t("settings.grantAgent", { agent: view.agentId })}</span>
                    <span className="muted">
                      {view.expiresAtMs
                        ? t("settings.grantExpires", { at: new Date(view.expiresAtMs).toLocaleString() })
                        : t("settings.grantNoExpiry")}
                      {" · "}{t("settings.grantUseCount", { count: view.useCount })}
                    </span>
                  </div>
                  <button
                    className="ui-cbtn ui-cbtn--sm ui-cbtn--danger"
                    disabled={revokingGrant === busyKey}
                    onClick={() => void revokeGrant(backend, grant)}
                  >
                    {t("settings.revokeGrant")}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  // 后端级版本行：OpenClaw 显示当前+最新；Hermes 多实例时当前版本放在实例行里。
  const renderBackendVersion = (
    v: BackendVersionStatus | undefined,
    backend: Pick<BackendStatus, "id" | "name">,
  ) => {
    if (!v && !versionError && !selfUpdatesById.get(backend.id)?.status) return null;
    const hasDashboardVersions = !!v?.dashboards?.length;
    const showVersionComparison = v?.comparisonSupported !== false;
    // 三行 label/value 压成一条版本条：左边「当前 · 最新」，右边状态 + 更新动作。
    return (
      <>
        {(v || versionError) && <div className="status-version">
          <span className="status-version-nums">
            {(!hasDashboardVersions || v?.current) && (
              <span className="status-version-pair">
                <span className="status-version-label">{t("settings.currentVersion")}</span>
                <span className="mono">{formatVersion(v?.current)}</span>
              </span>
            )}
            {showVersionComparison && (
              <span className="status-version-pair">
                <span className="status-version-label">{t("settings.latestVersion")}</span>
                <span className="mono">{formatVersion(v?.latest)}</span>
              </span>
            )}
          </span>
          {showVersionComparison && (
            <span className="status-version-state">
              <span className={versionStateClass(v)}>{versionStateText(v)}</span>
              {/* 有更新时给出 GitHub 更新日志入口，让用户先看清这版改了什么再点更新。 */}
              {v?.updateAvailable === true && !!v.releaseNotesUrl && (
                <a className="status-release-notes" href={v.releaseNotesUrl} target="_blank" rel="noreferrer">
                  {t("settings.releaseNotes")}
                </a>
              )}
              {renderUpdateAction(v)}
            </span>
          )}
        </div>}
        {renderUpdaterStatus(backend)}
      </>
    );
  };

  const gatewayUrlError = !REMOTE_CONNECTIONS_ENABLED && !loading && !configFailed && !isLocalGatewayUrl(cfg.gatewayUrl)
    ? t("settings.localGatewayUrlRequired") : null;

  return (
    <div className="page management-page settings-page">
      <PageHead
        title={t("settings.pageTitle")}
        subtitle={
          <span className="settings-sub">
            <span>{t("settings.pageSubtitle")}</span>
          </span>
        }
      />

      {configFailed ? (
        <div className="error">{t("settings.loadFailed")}</div>
      ) : (
        error && <div className="error">{t("settings.error", { msg: error })}</div>
      )}

      <div className="settings-stack">
        <div className="settings-group" id="settings-connections">
        <BackendOverview
          backends={backends} descriptors={backendDescriptors} versions={versionsById} loading={loading || saving || togglingBackend}
          attention={(id) => {
            const status = selfUpdatesById.get(id)?.status;
            return !!status && (status.running || status.ok === false || isActionableUpdatePhase(status));
          }}
          renderDetails={(b) => <>{renderBackendVersion(versionsById.get(b.id), b)}{renderStandingGrants(b)}</>}
          isDisconnectable={isDisconnectable} enabledCount={enabledCount} configFailed={configFailed}
          onToggle={(b) => void toggleBackendConnection(b)}
          onConfigure={(id) => {
            if (id === "openclaw" || (REMOTE_CONNECTIONS_ENABLED && id === "hermes")) {
              const target = document.getElementById(`settings-${id}`);
              if (target instanceof HTMLDetailsElement) target.open = true;
              target?.scrollIntoView({ block: "start" });
              target?.querySelector<HTMLElement>("input, [role='switch']")?.focus({ preventScroll: true });
            }
          }}
        />

        {backendCatalog.some((descriptor) => descriptor.surfaces.runtimeStatus === true) && <RuntimeStatusList
          runtimes={runtimes.map((runtime) => ({ ...runtime,
            enabled: loading || configFailed ? runtime.enabled : !cfg.disabledBackends.includes(runtime.runtime) }))}
          loading={runtimesLoading} error={runtimesError} busy={loading || saving || togglingBackend || configFailed}
          onToggle={(runtime) => void toggleRuntimeConnection(runtime)} />}

        {backendCatalog.filter((descriptor) => descriptor.aliases?.length).flatMap((descriptor) =>
          [descriptor.id, ...(descriptor.surfaces.runtimeStatus ? [] : descriptor.aliases!)].filter((id) => cfg.disabledBackends.includes(id)).map((id) => (
            <div className="settings-inline-state" key={`legacy-disabled:${id}`}>
              <div><strong>{t("settings.legacyRuntimeDisabled", { name: id })}</strong><p>{t("settings.legacyRuntimeDisabledHint")}</p></div>
              <button className="ui-cbtn ui-cbtn--sm" disabled={loading || saving || togglingBackend || configFailed}
                onClick={() => void applyBackendConnection({ id, name: id }, false)}>{t("settings.reconnect")}</button>
            </div>
          ))) }
        <ServiceSettings
          status={shoggothStatus} error={shoggothError} busy={shoggothBusy}
          onRetry={shoggothRetry} onAction={(action) => void runShoggothAction(action)}
        />
        {backendCatalog.some((descriptor) => descriptor.surfaces.nativeCapacity === true) && <NativeCapacityCard />}
        </div>
        <div className="settings-group" id="settings-general">
          <SettingsPreferences cfg={cfg} onChange={changeSettings} disabled={loading || configFailed} themeLoaded={themeLoaded} />
          <details className="settings-advanced" id="settings-debug">
            <summary className="settings-advanced-summary">
              <div><h3 className="settings-h">{t("debug.section")}</h3><p className="settings-sech">{t("settings.debugSectionDesc")}</p></div>
              <span className="settings-count">{t("settings.immediateEffect")}</span>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m5 6 3 3 3-3" /></svg>
            </summary>
            <div className="settings-card settings-debug-card">
              <div className="settings-heading-row">
                <div><h4 id="settings-debug-label">{t("debug.toggleLabel")}</h4><p>{t("settings.debugPurpose")}</p></div>
                <Switch checked={debugOn} onChange={setDebugEnabled} ariaLabelledBy="settings-debug-label" />
              </div>
              <div className="settings-debug-guide">
                <p>{t("settings.debugInstructions")} <kbd>Shift</kbd> + {t("settings.debugClick")}</p>
              </div>
              {debugOn && <p className="ui-hint" role="status">{t("debug.toggleHint")}</p>}
            </div>
          </details>
        </div>

        <div className="settings-group">
        <div className="settings-connection-tools">
        {/* OpenClaw connection */}
        <details className="settings-section settings-connection-editor" id="settings-openclaw">
          <summary className="settings-section-head">
            <h3 className="settings-h">{t("settings.openclawGateway")}</h3>
            <p className="settings-sech">{t("settings.openclawGatewayDesc")}</p>
          </summary>
          <div className="settings-card">
            <Field label={t("settings.gatewayUrl")} hint={t("settings.gatewayUrlHint")}
              error={gatewayUrlError} errorId="settings-gateway-url-error">
              <TextInput
                id="settings-gateway-url"
                className="field-input field-mono"
                aria-invalid={!!gatewayUrlError}
                aria-describedby={gatewayUrlError ? "settings-gateway-url-error" : undefined}
                disabled={loading || configFailed}
                value={cfg.gatewayUrl}
                onBlur={flushConnectionChanges}
                onChange={(e) => {
                  invalidateTest("openclaw");
                  changeSettings({ gatewayUrl: e.target.value }, true);
                }}
                placeholder="ws://127.0.0.1:18792"
              />
            </Field>
            <Field label="Token" hint={t("settings.tokenHint")}>
              <TextInput
                type="password"
                className="field-input field-mono"
                disabled={loading || configFailed}
                value={cfg.token}
                onBlur={flushConnectionChanges}
                onChange={(e) => {
                  invalidateTest("openclaw");
                  changeSettings({ token: e.target.value }, true);
                }}
                autoComplete="off"
              />
            </Field>
            <div className="settings-actions">
              <button
                className="ui-cbtn ui-cbtn--sm"
                disabled={loading || configFailed || !!gatewayUrlError}
                onClick={() => runTest("openclaw", { backend: "openclaw", gatewayUrl: cfg.gatewayUrl })}
              >
                {t("common.test")}
              </button>
              {renderTest("openclaw")}
            </div>
            {/* LAN 发现开关(S3):managed=false=无白名单默认已开(只读);写后重启网关生效 */}
            {REMOTE_CONNECTIONS_ENABLED && lan?.supported &&
              (lan.managed ? (
                <div className="settings-actions">
                  <Switch
                    checked={!!lan.enabled}
                    onChange={(v) => {
                      if (!lanBusy) void onToggleLan(v);
                    }}
                    label={t("settings.lanDiscovery")}
                  />
                  <span className="ui-hint">{t("settings.lanDiscoveryHint")}</span>
                </div>
              ) : (
                <p className="ui-hint">{t("settings.lanDefaultOn")}</p>
              ))}
            {REMOTE_CONNECTIONS_ENABLED && <p className="ui-hint">
              {t("settings.tunnelNote1")}
              <span className="mono"> ssh -L 18792:127.0.0.1:18792 user@host</span>
              {t("settings.tunnelNote2")}
              <span className="mono"> ws://127.0.0.1:18792</span>
              {t("settings.tunnelNote3")}
            </p>}
          </div>
        </details>

        {/* Local Hermes is managed automatically; only remote connections need an editor. */}
        {REMOTE_CONNECTIONS_ENABLED && <details className="settings-section settings-connection-editor" id="settings-hermes">
          <summary className="settings-section-head">
            <h3 className="settings-h">{t("settings.hermesConn")}</h3>
            <p className="settings-sech">{t("settings.hermesConnDesc")}</p>
          </summary>
          <div className="settings-card">
            {validateRemotes() && (
              <div className="error" role="alert">{validateRemotes()}</div>
            )}
            <Switch
              checked={cfg.hermesMode === "remote"}
              disabled={loading || configFailed}
              onChange={(v) => changeSettings({ hermesMode: v ? "remote" : "local" }, true)}
              label={cfg.hermesMode === "remote" ? t("settings.hermesRemoteMode") : t("settings.hermesLocalMode")}
            />
            {cfg.hermesMode === "remote" && (
              <div className="remotes">
                {cfg.hermesRemotes.length === 0 && <p className="muted">{t("settings.noRemotes")}</p>}
                {cfg.hermesRemotes.map((r, i) => {
                  const uid = remoteUids[i] ?? String(i);
                  const testKey = `hermes-${uid}`;
                  return (
                    <div key={uid} className="remote-row">
                      <div className="field-row">
                        <Field label={t("common.profile")}>
                          <TextInput
                            value={r.profile}
                            onChange={(e) => setRemote(i, { profile: e.target.value })}
                            placeholder="default"
                          />
                        </Field>
                        <Field label={t("settings.remoteDashboardUrl")}>
                          <TextInput
                            className="field-input field-mono"
                            value={r.baseUrl}
                            onChange={(e) => setRemote(i, { baseUrl: e.target.value })}
                            placeholder="http://host:9119"
                          />
                        </Field>
                      </div>
                      <Field label="Token" hint={t("settings.remoteTokenHint")}>
                        <TextInput
                          type="password"
                          className="field-input field-mono"
                          value={r.token || ""}
                          onChange={(e) => setRemote(i, { token: e.target.value })}
                          autoComplete="off"
                        />
                      </Field>
                      <div className="settings-actions">
                        <button
                          className="ui-cbtn ui-cbtn--sm"
                          onClick={() => {
                            // Empty URL → the backend would silently probe the LOCAL
                            // default dashboard and could report a misleading ✓. Refuse.
                            if (!r.baseUrl.trim()) {
                              setTests((prev) => ({
                                ...prev,
                                [testKey]: { ok: false, error: t("settings.remoteUrlRequired", { n: i + 1 }) },
                              }));
                              return;
                            }
                            runTest(testKey, { backend: "hermes", baseUrl: r.baseUrl, token: r.token });
                          }}
                        >
                          {t("common.test")}
                        </button>
                        {renderTest(testKey)}
                        <button className="ui-cbtn ui-cbtn--sm ui-cbtn--danger" onClick={() => removeRemote(i)}>
                          {t("common.remove")}
                        </button>
                      </div>
                    </div>
                  );
                })}
                <button className="ui-cbtn ui-cbtn--sm" onClick={addRemote}>{t("settings.addRemote")}</button>
              </div>
            )}
          </div>
        </details>}
        </div>
        </div>
      </div>

      {stopDialogOpen && <BackgroundStopDialog
        onCancel={() => setStopDialogOpen(false)}
        onStopped={(status) => {
          serviceRetrySequence.current += 1;
          setShoggothStatus(status);
          setShoggothError(false);
          setStopDialogOpen(false);
          toast.success(t("settings.shoggothActionDone"));
        }}
      />}

    </div>
  );
}
