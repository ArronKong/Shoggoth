"use strict";

// Shared, path-injected config store for the desktop app and the dev harness.
//
// Single source of truth for the on-disk config.json schema. main.js binds it
// to Electron's userData path; scripts/manage-serve.cjs binds it to a dev path
// so the 设置 page is editable without Electron. HermesBackend reads it to pick
// local-spawn vs remote-dashboard mode.
//
// Schema:
//   gatewayUrl     ws:// URL of the OpenClaw gateway (may be remote)
//   token          operator token for the gateway (re-seeded into the UI)
//   locale         "" follow-system | "zh-CN" | "en"
//   theme          "light" (default) | "dark" | "system" follow-OS
//   hermesMode     "local"  → spawn `hermes dashboard` per profile (default)
//                  "remote" → connect to already-running remote dashboards
//   hermesRemotes  [{ profile, baseUrl, token }] used when hermesMode==="remote"
//   hermesKeepAlive  true (default) → app 正常退出时保留自己 spawn 的 dashboard，
//                  下次启动认领复用（冷启动 ~10s 变 ~0.5s，代价是关掉 app 后
//                  每 profile 留一个 Python 进程，本机实测 5 个共 255MB）。
//                  false → 退出即杀。显式 false 仍会落盘；缺字段视为 true；
//                  非布尔脏值 fail-closed 为 false（不能被脏值带成开）。
//                  只在「app 正常退出」这一条路径生效；断开连接/自更新/模式切换
//                  仍然真杀（语义不同，见 ARCHITECTURE §9）。
//   disabledBackends  backend id 列表（如 ["hermes"]）：用户在设置页「断开连接」
//                  的后端。registry 聚合/路由跳过它们，UI 隐藏对应切换项。
//   notifications  { chat, cron, task } per-category desktop-notification toggles
//                  (all on by default; task also includes Inspiration)
//   setupCompletedAt  epoch ms when the first-run setup overlay was completed or
//                  dismissed; 0 = never. The SPA auto-shows the overlay only when
//                  this is 0 AND token is empty (pre-existing installs skip it).
//   windowBounds   { width, height } of the desktop window, persisted on resize so
//                  the next launch reopens at the size the user left it.
//   nativeConcurrency { maxActive: 1..100, startupConcurrency: 1..16, revision }
//   runtimeFrameworkFlags four explicit booleans; new installs enable the shipped framework, revisioned with
//                  nativeConcurrency and projected to the Service over IPC.

const fs = require("node:fs");
const path = require("node:path");
const { normalizeInspirationShortcut, DEFAULT_INSPIRATION_SHORTCUT } = require("../desktop-inspiration-shortcut");
const { DEFAULT_RUNTIME_FRAMEWORK_FLAGS, resolveRuntimeFrameworkFlags } = require("../agent-service/runtime-framework-flags");
const { validateNativeRuntimeConfigProjection, NATIVE_RUNTIME_CONFIG_PUBLIC_MESSAGES } = require("../agent-service/native-runtime-config-protocol");

const SUPPORTED_LOCALES = new Set(["", "zh-CN", "en"]);
const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18792";
// 窗口尺寸：默认值与下限都住在这里（schema 唯一源），main.js 直接消费这两个常量。
const DEFAULT_WINDOW_BOUNDS = { width: 1728, height: 1117 };
const MIN_WINDOW_BOUNDS = { width: 720, height: 560 };
const DEFAULT_NATIVE_CONCURRENCY = Object.freeze({ maxActive: 100, startupConcurrency: 8, revision: 0 });
// These features are part of the current unpublished App baseline. Low-level
// Service defaults remain disabled until Core supplies its authenticated config.
// Preserve explicit saved choices and keep invalid configuration fail-closed.
const DEFAULT_NATIVE_RUNTIME_FLAGS = Object.freeze({
  runtimeAdmissionV1: true,
  runtimeContextLifecycleV1: true,
  runtimeMultiBinding: true,
  runtimeConversationHandoff: true,
});

function projectNativeRuntimeConfig(config) {
  return validateNativeRuntimeConfigProjection({
    ...config.nativeConcurrency,
    flags: config.runtimeFrameworkFlags,
  });
}

function normalizeNativeRuntimeConfig(parsed) {
  try {
    return validateNativeRuntimeConfigProjection({
      ...(parsed.nativeConcurrency === undefined ? DEFAULT_NATIVE_CONCURRENCY : parsed.nativeConcurrency),
      flags: parsed.runtimeFrameworkFlags === undefined
        ? DEFAULT_NATIVE_RUNTIME_FLAGS : resolveRuntimeFrameworkFlags(parsed.runtimeFrameworkFlags),
    });
  } catch {
    // Invalid persisted capacity must not turn a corrupt value into an enabled
    // higher limit. Retain safe defaults with every experimental path disabled.
    const revision = Number.isSafeInteger(parsed.nativeConcurrency?.revision)
      && parsed.nativeConcurrency.revision >= 0 ? parsed.nativeConcurrency.revision : 0;
    return Object.freeze({ ...DEFAULT_NATIVE_CONCURRENCY, revision, flags: DEFAULT_RUNTIME_FRAMEWORK_FLAGS });
  }
}

// 与 HermesBackend.agentIdForProfile 完全一致的最终路由身份；专项回归会把
// 两侧实现逐向量对照，防止 CJS 配置层与 backend 规则以后静默漂移。
function remoteProfileIdentity(profile) {
  const safe = String(profile || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `hermes-${safe || "default"}`;
}

// Coerce the remote-dashboard list to {profile, baseUrl, token}[]; drop entries
// without a baseUrl. baseUrl is an http(s):// origin (no trailing slash kept).
function sanitizeRemotes(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seenIdentities = new Set();
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const profile = typeof r.profile === "string" ? r.profile.trim() : "";
    let baseUrl = typeof r.baseUrl === "string" ? r.baseUrl.trim() : "";
    const token = typeof r.token === "string" ? r.token.trim() : "";
    if (!baseUrl) continue;
    baseUrl = baseUrl.replace(/\/+$/, "");
    const normalizedProfile = profile || "default";
    const identity = remoteProfileIdentity(normalizedProfile);
    // 多种 profile 文本可能塌缩到同一 agent id；只让首个合法项占用该身份。
    if (seenIdentities.has(identity)) continue;
    seenIdentities.add(identity);
    out.push({ profile: normalizedProfile, baseUrl, token });
  }
  return out;
}

// 用户显式断开的后端 id 列表；去重、丢弃非字符串。不校验 id 是否已注册——
// 后端可插拔（铁律 1），未知 id 只是不命中任何后端，无副作用。
function sanitizeDisabledBackends(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const id = v.trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

// All categories default on. Keep explicit saved choices, including false.
function sanitizeNotifications(raw) {
  const n = raw && typeof raw === "object" ? raw : {};
  return {
    chat: typeof n.chat === "boolean" ? n.chat : true,
    cron: typeof n.cron === "boolean" ? n.cron : true,
    task: typeof n.task === "boolean" ? n.task : true,
  };
}

// 只接受不小于窗口下限的有限数；坏值/缺字段一律回落默认，绝不让窗口开成 0×0。
function sanitizeWindowBounds(raw) {
  const b = raw && typeof raw === "object" ? raw : {};
  const pick = (value, min, fallback) =>
    Number.isFinite(value) && value >= min ? Math.round(value) : fallback;
  return {
    width: pick(b.width, MIN_WINDOW_BOUNDS.width, DEFAULT_WINDOW_BOUNDS.width),
    height: pick(b.height, MIN_WINDOW_BOUNDS.height, DEFAULT_WINDOW_BOUNDS.height),
  };
}

// Normalize any parsed object to the full, defaulted schema. Never throws.
function normalizeConfig(parsed) {
  const p = parsed && typeof parsed === "object" ? parsed : {};
  const localeRaw = typeof p.locale === "string" ? p.locale : "";
  const native = normalizeNativeRuntimeConfig(p);
  return {
    gatewayUrl: typeof p.gatewayUrl === "string" ? p.gatewayUrl : "",
    token: typeof p.token === "string" ? p.token : "",
    locale: SUPPORTED_LOCALES.has(localeRaw) ? localeRaw : "",
    theme: p.theme === "dark" || p.theme === "system" ? p.theme : "light",
    hermesMode: p.hermesMode === "remote" ? "remote" : "local",
    hermesRemotes: sanitizeRemotes(p.hermesRemotes),
    hermesKeepAlive: typeof p.hermesKeepAlive === "boolean"
      ? p.hermesKeepAlive
      : !Object.prototype.hasOwnProperty.call(p, "hermesKeepAlive"),
    disabledBackends: sanitizeDisabledBackends(p.disabledBackends),
    notifications: sanitizeNotifications(p.notifications),
    setupCompletedAt: Number.isFinite(p.setupCompletedAt) && p.setupCompletedAt > 0 ? p.setupCompletedAt : 0,
    windowBounds: sanitizeWindowBounds(p.windowBounds),
    inspirationShortcut: normalizeInspirationShortcut(p.inspirationShortcut) || DEFAULT_INSPIRATION_SHORTCUT,
    nativeConcurrency: { maxActive: native.maxActive, startupConcurrency: native.startupConcurrency, revision: native.revision },
    runtimeFrameworkFlags: { ...native.flags },
  };
}

/**
 * Build a config store bound to a file path.
 * @param {string} configPath absolute path to config.json
 * @param {{ defaultGatewayUrl?: string }} [opts]
 */
function createConfigStore(configPath, { defaultGatewayUrl = DEFAULT_GATEWAY_URL } = {}) {
  // Distinguish "no file yet" (normal first run) from "file is there but
  // unparseable". Both yield defaults so callers never have to handle a throw,
  // but only the latter must block a read-merge-write from baking those defaults
  // in on top of a real token / remote list.
  function readParsed() {
    let raw;
    try {
      raw = fs.readFileSync(configPath, "utf8");
    } catch (error) {
      const missing = error?.code === "ENOENT";
      return { config: normalizeConfig(missing ? {} : {
        runtimeFrameworkFlags: DEFAULT_RUNTIME_FRAMEWORK_FLAGS,
      }), corrupt: !missing };
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      return { config: normalizeConfig(parsed), corrupt: false };
    } catch {
      return { config: normalizeConfig({ runtimeFrameworkFlags: DEFAULT_RUNTIME_FRAMEWORK_FLAGS }), corrupt: true };
    }
  }

  function read() {
    return readParsed().config;
  }

  // Read-only health projection for optional desktop telemetry. Keep the normal
  // config/default/write semantics unchanged, but never confuse a failed read
  // with a new install. No configuration values cross this interface.
  function getReadStatus() {
    let fd;
    try {
      fd = fs.openSync(configPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1) return "read_error";
      if (before.size > 1024 * 1024) return "invalid";
      const bytes = Buffer.alloc(before.size + 1);
      const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
      const after = fs.fstatSync(fd);
      if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return "read_error";
      let parsed;
      try { parsed = JSON.parse(bytes.subarray(0, length).toString("utf8")); }
      catch { return "parse_error"; }
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? "ok" : "invalid";
    } catch (error) {
      return error?.code === "ENOENT" ? "missing" : "read_error";
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* health-only read */ } }
    }
  }

  // Partial update: provided fields override current, everything else persists.
  function write(patch) {
    const { config: current, corrupt } = readParsed();
    if (corrupt) {
      // The values may still be recoverable by hand; discarding a user's operator
      // token because one byte got truncated is worse than an orphaned backup.
      const backup = `${configPath}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(configPath, backup);
        console.warn(`[config] ${configPath} was unreadable; preserved at ${backup}`);
      } catch {
        /* best-effort */
      }
    }
    const next = normalizeConfig({ ...current, ...(patch || {}) });
    next.gatewayUrl = next.gatewayUrl.trim();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    // Atomic: write-then-rename. A crash or ENOSPC mid-write leaves the previous
    // file intact rather than a truncated one that reads back as "unconfigured"
    // and gets overwritten with defaults on the next save.
    const tmp = `${configPath}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, configPath);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
      throw err;
    }
    return next;
  }

  function writeNativeRuntimeConfig(input) {
    const { config: current, corrupt } = readParsed();
    if (corrupt) {
      throw Object.assign(new Error(NATIVE_RUNTIME_CONFIG_PUBLIC_MESSAGES.NATIVE_RUNTIME_CONFIG_INVALID), {
        code: "NATIVE_RUNTIME_CONFIG_INVALID",
      });
    }
    if (!Number.isSafeInteger(input?.expectedRevision)
      || input.expectedRevision !== current.nativeConcurrency.revision) {
      throw Object.assign(new Error(NATIVE_RUNTIME_CONFIG_PUBLIC_MESSAGES.NATIVE_RUNTIME_CONFIG_STALE), {
        code: "NATIVE_RUNTIME_CONFIG_STALE",
      });
    }
    const projection = validateNativeRuntimeConfigProjection({
      revision: current.nativeConcurrency.revision + 1,
      maxActive: input.maxActive, startupConcurrency: input.startupConcurrency, flags: input.flags,
    });
    return write({
      nativeConcurrency: { revision: projection.revision, maxActive: projection.maxActive, startupConcurrency: projection.startupConcurrency },
      runtimeFrameworkFlags: projection.flags,
    });
  }

  // First run: drop an editable file with the default gateway pre-filled.
  function ensure() {
    if (fs.existsSync(configPath)) return;
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(
        configPath,
        JSON.stringify(normalizeConfig({ gatewayUrl: defaultGatewayUrl }), null, 2),
        { mode: 0o600 },
      );
    } catch {
      /* best-effort */
    }
  }

  return { read, write, writeNativeRuntimeConfig, ensure, getReadStatus, path: configPath };
}

module.exports = {
  createConfigStore,
  normalizeConfig,
  remoteProfileIdentity,
  sanitizeRemotes,
  sanitizeNotifications,
  sanitizeDisabledBackends,
  sanitizeWindowBounds,
  SUPPORTED_LOCALES,
  DEFAULT_GATEWAY_URL,
  DEFAULT_WINDOW_BOUNDS,
  MIN_WINDOW_BOUNDS,
  DEFAULT_NATIVE_CONCURRENCY,
  projectNativeRuntimeConfig,
};
