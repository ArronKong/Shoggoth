"use strict";

// Minimal loopback HTTP server for the built Control UI bundle.
//
// The official Control UI MUST be served from an http://127.0.0.1 origin
// (not file://): it needs a secure context for crypto.subtle / @noble/ed25519
// device identity, derives the gateway WebSocket URL + loopback detection from
// window.location, and ships a same-origin CSP. file:// breaks all of that.

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { UI_CONTENT_SECURITY_POLICY } = require("./ui-content-security");
const { randomUUID } = require("node:crypto");
const { createChatAttachmentOpener, validAttachmentName, MAX_OPEN_ATTACHMENT_BYTES } = require("./chat-attachment-open");
const {
  AVATAR_EXTS: AGENT_AVATAR_EXTS,
  BG_STATES: IMMERSIVE_BG_STATES,
  BG_VIDEO_EXTS: IMMERSIVE_BG_VIDEO_EXTS,
  BG_IMAGE_EXTS: IMMERSIVE_BG_IMAGE_EXTS,
  resolveDesktopAssetPaths, resolveDesktopAssetFile, validAssetName,
  resolveBuiltinAgentAvatarFile,
  ensureAssetDirectory, migrateLegacyDesktopAssets,
} = require("./desktop-assets");
const { scanInstalledClis, resolveCliVersion, resolveCliInfo, CLI_CATEGORIES } = require("./cli-scanner");
const { detectOpenclawHost, startOpenclawGateway } = require("./openclaw-host");
const { browseOpenclawGateways } = require("./core/mdns-browser");
const { attachChatBroker, CHAT_WS_PATH, isAllowedBrowserOrigin } = require("./core/chat-broker");
const { attachKanbanBroker, KANBAN_WS_PATH } = require("./core/kanban-broker");
const { ModelValidationError } = require("./core/model-validation");
const { ModelChangeError } = require("./core/model-change-validation");
const { ModelChangeJournalError } = require("./core/model-change-journal");
const { HermesCatalogUnavailableError } = require("./core/hermes-backend");
const { WorkAdmissionError } = require("./core/work-admission-gate");
const {
  projectWidgetResourceResult,
  projectStandingGrantListForBrowser,
  projectStandingGrantRevokeForBrowser,
} = require("./core/agent-backend");
const {
  projectSessionBoardEnvelope,
  normalizeSessionBoardAgentId,
  normalizeSessionBoardSessionKey,
  normalizeSessionBoardOps,
  normalizeSessionBoardCanvasSpec,
  normalizeSessionBoardGrantSpec,
} = require("./core/session-board-projection");

const WS_CLOSE_GRACE_MS = 100;
const CLI_EXECUTION_LIMIT = 2;

/**
 * REST 数据面统一从 active 集合取后端。最后的 Map 回退只服务不实现
 * BackendRegistry 接口的轻量测试桩；生产 registry 必须经过 disabled gate。
 */
function getActiveBackend(registry, backendId) {
  if (typeof registry?.getBackend === "function") return registry.getBackend(backendId);
  if (typeof registry?._activeGet === "function") return registry._activeGet(backendId);
  return registry?.backends?.get(backendId) || null;
}

function hasAgentScopedSkills(backend) {
  if (typeof backend?.getBackendDescriptor !== "function") return false;
  try {
    return backend.getBackendDescriptor()?.surfaces?.agentHarness === true;
  } catch {
    // A broken capability descriptor cannot prove that profile-less access is safe.
    return true;
  }
}

function canonicalExecutablePath(candidate) {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) return null;
  try {
    const canonical = fs.realpathSync.native(candidate);
    const stat = fs.statSync(canonical);
    fs.accessSync(canonical, fs.constants.X_OK);
    return stat.isFile() ? canonical : null;
  } catch {
    return null;
  }
}

/** 每个 loopback server 独立维护最近一次 /cli 扫描的可执行文件白名单。 */
function createCliExecutionGate() {
  let allowlist = new Map();
  let active = 0;
  return {
    remember(tools) {
      const next = new Map();
      for (const tool of Array.isArray(tools) ? tools : []) {
        const canonical = canonicalExecutablePath(tool?.path);
        if (!canonical || next.has(canonical)) continue;
        next.set(canonical, {
          name: String(tool?.name || path.basename(canonical)),
          path: canonical,
        });
      }
      allowlist = next;
    },
    resolve(candidate) {
      const canonical = canonicalExecutablePath(candidate);
      return canonical ? allowlist.get(canonical) || null : null;
    },
    acquire() {
      if (active >= CLI_EXECUTION_LIMIT) return null;
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active -= 1;
      };
    },
  };
}

function closeWebSocketServer(wss) {
  if (!wss) return Promise.resolve();
  const clients = [...wss.clients];
  for (const client of clients) {
    try { client.close(1001, "server shutdown"); } catch { /* already closed */ }
  }
  return new Promise((resolve) => {
    const forceTimer = setTimeout(() => {
      for (const client of clients) {
        try { client.terminate(); } catch { /* already closed */ }
      }
    }, WS_CLOSE_GRACE_MS);
    wss.close(() => {
      clearTimeout(forceTimer);
      resolve();
    });
  });
}

// 只有稳定且明确列入映射的服务错误可以控制 HTTP 状态；任意 statusCode 一律忽略。
const TRUSTED_API_ERROR_STATUS = new Map([
  [
    "ERR_HERMES_CATALOG_UNAVAILABLE",
    { status: 503, ErrorType: HermesCatalogUnavailableError },
  ],
]);

/** 解析可信 API 错误；类型、code 与 statusCode 必须同时精确匹配固定映射。 */
function trustedApiError(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  const contract = TRUSTED_API_ERROR_STATUS.get(code);
  if (
    !contract ||
    !(error instanceof contract.ErrorType) ||
    error?.statusCode !== contract.status
  ) {
    return null;
  }
  return { code, status: contract.status };
}

const MODEL_CHANGE_DETAIL_KEYS = new Set([
  "operations", "operationId", "code", "backendId", "providerKey", "stage", "reason", "retryable",
  "profiles", "failedProfiles", "references", "blockers", "store", "referenceKey", "current", "target",
]);

/** details 只输出协议声明字段与 JSON primitive，未知键（尤其凭证字段）全部丢弃。 */
function safeModelChangeDetails(value, key = null, seen = new Set()) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    if (/\b(?:bearer|basic)\s+\S+/i.test(value)
      || /\b(?:api[\s_-]?key|token|password|authorization)\b\s*[:=]/i.test(value)
      || /https?:\/\/[^\s/@]+:[^\s/@]+@/i.test(value)) return undefined;
    return value.length <= 500 ? value : value.slice(0, 500);
  }
  if (!value || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => safeModelChangeDetails(item, key, seen)).filter((item) => item !== undefined);
    }
    const out = {};
    for (const [childKey, child] of Object.entries(value)) {
      if (!MODEL_CHANGE_DETAIL_KEYS.has(childKey)) continue;
      const safe = safeModelChangeDetails(child, childKey, seen);
      if (safe !== undefined) out[childKey] = safe;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/** mutation 路由的统一 readiness 门；未注入与恢复中使用相同稳定 503。 */
function requireReadyCoordinator(modelChangeCoordinator) {
  if (!modelChangeCoordinator) {
    throw new ModelChangeError("model_change_recovering", "模型变更服务尚未就绪", {
      stage: "recovery",
      status: 503,
    });
  }
  if (typeof modelChangeCoordinator.requireReady === "function") {
    modelChangeCoordinator.requireReady();
  } else if (typeof modelChangeCoordinator.isReady !== "function" || !modelChangeCoordinator.isReady()) {
    throw new ModelChangeError("model_change_recovering", "模型变更恢复尚未完成", {
      stage: "recovery",
      status: 503,
    });
  }
  return modelChangeCoordinator;
}

/**
 * 用同一个 backend admission gate 包住一次短启动请求。leave 始终在调用结束后执行，
 * 不把 HTTP 请求误当成后台任务的完整生命周期。
 */
async function withWorkAdmission(workAdmissionGate, backendId, kind, run) {
  const leave = workAdmissionGate?.enter?.(backendId, kind);
  try {
    return await run();
  } finally {
    leave?.();
  }
}

/** blocker 属于可预期冲突，HTTP 用 409；其它阶段结果由客户端按 status 渲染。 */
function sendModelChangeResult(res, result) {
  const status = result?.status === "blocked" ? 409 : 200;
  return sendJson(res, status, result);
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  // 聊天里的视频附件按真实 MIME 送出——落成 application/octet-stream 时
  // <video> 不会播（实测 webm 就是这么哑掉的）。
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeFor(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

// Agent avatars. The gateway returns avatar URLs as `/avatar/<agentId>`, but
// the page origin is THIS loopback server (not the gateway), so those requests
// land here and 404 by default — leaving a broken <img> that the browser fills
// with its alt text (the agent name). Serve the real avatar files so the
// pictures show and the alt-text name disappears.
// Paths are scoped to each server's Shoggoth userDataRoot, injected by Electron.
const DEFAULT_AVATAR_TEXTURE_DIR = path.join(__dirname, "manage-ui", "src", "assets", "avatar-backgrounds");
const defaultAvatarTextures = new Map();

function defaultAgentAvatarSvg(agentId) {
  // Keep the seeded choice aligned with manage-ui/src/lib/avatar-background.ts.
  let hash = 2166136261;
  for (const char of agentId || "?") {
    hash = Math.imul(hash ^ char.codePointAt(0), 16777619) >>> 0;
  }
  const texture = `texture-${String(hash % 17 + 1).padStart(2, "0")}.webp`;
  let image = defaultAvatarTextures.get(texture);
  if (image === undefined) {
    try { image = fs.readFileSync(path.join(DEFAULT_AVATAR_TEXTURE_DIR, texture)).toString("base64"); }
    catch { image = ""; } // A missing packaged asset must not terminate the HTTP server.
    defaultAvatarTextures.set(texture, image);
  }
  const base = agentId.startsWith("hermes-") ? agentId.slice("hermes-".length) : agentId;
  const letter = (Array.from(base)[0] || "?").toUpperCase()
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Keep the source square; each view owns its crop (agent cards vs. round avatars).
  const background = image
    ? `<image width="40" height="40" preserveAspectRatio="xMidYMid slice" href="data:image/webp;base64,${image}"/>`
    : '<rect width="40" height="40" fill="#000000"/>';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">${background}<text x="20" y="27" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="18" font-weight="600" fill="#ffffff" text-anchor="middle">${letter}</text></svg>`;
}

// Map a single-segment agent id to its avatar file, trying known image
// extensions. New assets win across extensions; legacy reads keep avatars visible
// if migration is temporarily blocked (for example, by a full disk).
function resolveAgentAvatarFile(agentId, assetPaths) {
  if (!validAssetName(agentId)) return null;
  for (const directory of [assetPaths.avatarDir, assetPaths.legacyAvatarDir]) {
    for (const ext of AGENT_AVATAR_EXTS) {
      const candidate = resolveDesktopAssetFile(directory, agentId + ext);
      if (candidate) return candidate;
    }
  }
  return resolveBuiltinAgentAvatarFile(agentId);
}

// 沉浸模式背景素材（用户自定义）：Shoggoth userDataRoot/immersive-bg/<state>.<ext>。
// 与 agent-avatars 同款「桌面本地静态资产」——只读、扩展名白名单、basename 防穿越，
// 不进 /__api registry（非后端能力）。manifest 列出每个状态可用的素材（同状态多个
// 扩展名并存时取 mtime 最新那个），UI 端 pages/immersive/immersiveBg.ts 消费；
// 状态词表与 UI 的 ImmersivePhase 枚举一一对应。
function listImmersiveBgManifest(assetPaths) {
  const out = {};
  for (const directory of [assetPaths.immersiveBgDir, assetPaths.legacyImmersiveBgDir]) {
    const preferredStates = new Set(Object.keys(out));
    let names;
    try { names = fs.readdirSync(directory); } catch { continue; }
    for (const name of names) {
      const ext = path.extname(name).toLowerCase();
      const state = path.basename(name, path.extname(name)).toLowerCase();
      if (!IMMERSIVE_BG_STATES.has(state) || preferredStates.has(state)) continue;
      const isVideo = IMMERSIVE_BG_VIDEO_EXTS.has(ext);
      if (!isVideo && !IMMERSIVE_BG_IMAGE_EXTS.has(ext)) continue;
      const file = resolveDesktopAssetFile(directory, name);
      if (!file) continue;
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      const prev = out[state];
      if (!prev || stat.mtimeMs > prev.mtime) {
        out[state] = { file: name, type: isVideo ? "video" : "image", mtime: stat.mtimeMs };
      }
    }
  }
  return out;
}

// Agent-generated media. OpenClaw agents attach images to their final reply via a
// `MEDIA:<path>` directive line (see manage-ui/src/lib/agentMedia.ts). The gateway returns
// that text verbatim, so the UI rewrites local paths to `/__media?path=…` and we serve the
// file here — read-only, confined to the OpenClaw tree and to image types, mirroring the
// /avatar route above. Remote (http/https) MEDIA refs are loaded by the browser directly,
// not through this route.
const MEDIA_ROOT = path.join(os.homedir(), ".openclaw");
// Hermes 的聊天附件落点（session cwd 锚在家目录，见 hermes-backend._spawnDashboard）。
// 单独列出而不是把整个 ~/.hermes 开进来：那棵树里有 config.yaml / .env / auth.json /
// transcripts，只靠扩展名白名单挡不够稳妥。这里只暴露用户自己上传的附件目录。
const HERMES_ATTACH_ROOT = path.join(os.homedir(), ".hermes", "desktop-attachments");
const MEDIA_ROOTS = [MEDIA_ROOT, HERMES_ATTACH_ROOT];
const MEDIA_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".bmp",
  // 视频：聊天里的视频附件从服务端取，预览才不依赖浏览器本地缓存（后者按 origin
  // 隔离，换端口/换设备就没了）。
  ".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi",
]);

// Resolve a requested media path to a real file inside one of MEDIA_ROOTS, or null.
// Guards: media-extension allowlist (so config/secrets/transcripts under the tree are
// never served — none are media), realpath containment (blocks ../ and symlink
// escapes), and regular-file-only.
function resolveMediaFile(rawPath) {
  if (!rawPath || typeof rawPath !== "string") return null;
  if (!MEDIA_EXTS.has(path.extname(rawPath).toLowerCase())) return null;
  let real;
  try {
    real = fs.realpathSync(rawPath);
  } catch {
    return null;
  }
  const inSomeRoot = MEDIA_ROOTS.some((root) => {
    let rootReal;
    try {
      rootReal = fs.realpathSync(root);
    } catch {
      return false;
    }
    return real === rootReal || real.startsWith(rootReal + path.sep);
  });
  if (!inSomeRoot) return null;
  try {
    if (!fs.statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return real;
}

// --- avatar upload (write side, symmetric with the GET route below) -------
// Avatars are a static-server filesystem resource (not registry/backend data),
// so the write endpoint lives here next to the read route — NOT under /__api.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// The client downscales to a ~768px PNG (hundreds of KB ~ low MB); this cap is
// just a guard. Raised with AVATAR_SIZE 256→768 (manage-ui/src/lib/avatar.ts):
// 9× the pixels needs headroom, and the old 3MB rejected legit big-source PNGs.
const MAX_AVATAR_BYTES = 8_000_000;

// Canonical on-disk write path for an agent avatar (always .png), reusing the
// same id guards as resolveAgentAvatarFile.
function avatarWritePath(agentId, avatarDir) {
  return validAssetName(agentId) ? path.join(avatarDir, agentId + ".png") : null;
}

// Read a binary request body up to maxBytes. Resolves null on overflow/error.
function readBinaryBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(size ? Buffer.concat(chunks) : null));
    req.on("error", () => resolve(null));
  });
}

// PUT/POST /avatar/<id>: store a (client-downscaled) PNG as the agent's avatar,
// replacing any prior file. Deletes other-extension variants so the GET — which
// tries .png first — can never serve a stale image.
async function handleAvatarUpload(req, res, agentId, avatarDir) {
  const writePath = avatarWritePath(agentId, avatarDir);
  if (!writePath) {
    return sendJson(res, 400, { error: "bad agent id" });
  }
  const body = await readBinaryBody(req, MAX_AVATAR_BYTES);
  if (!body) {
    return sendJson(res, 413, { error: "missing or oversized body (max 3MB)" });
  }
  if (body.length < 8 || !body.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return sendJson(res, 415, { error: "expected a PNG image" });
  }
  const temporary = path.join(avatarDir, `.upload-${randomUUID()}.tmp`);
  try {
    ensureAssetDirectory(avatarDir);
    fs.writeFileSync(temporary, body, { flag: "wx" });
    fs.renameSync(temporary, writePath);
    for (const ext of AGENT_AVATAR_EXTS) {
      if (ext === ".png") continue;
      try {
        fs.rmSync(path.join(avatarDir, agentId + ext), { force: true });
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    return sendJson(res, 500, { error: err && err.message ? err.message : "write failed" });
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* upload failure already reported */ }
  }
  return sendJson(res, 200, { ok: true });
}

// React control-plane UI (the primary UI), built by `npm run build:manage`
// into app/manage-ui/dist. Served at the loopback root; it owns the 10-section
// nav + router (chat is native React over the /__chatws broker).
const MANAGE_DIR = path.join(__dirname, "manage-ui", "dist");

// Reject non-loopback Host headers (DNS-rebinding guard). The server binds
// 127.0.0.1, but a page whose domain was rebound to 127.0.0.1 still sends its
// OWN host in the header — so a request claiming any other host isn't really us
// and must not reach /__api/config (operator token) or /__api/env/reveal (keys).
function isLoopbackHost(hostHeader) {
  const name = String(hostHeader || "")
    .trim()
    .replace(/:\d+$/, "")
    .toLowerCase();
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]" || name === "::1";
}

// Shoggoth 原生 Service/LaunchAgent mutation 比旧管理面更高权：只接受真实
// 浏览器 loopback Origin。全局管理面为兼容本机 CLI 允许缺 Origin；这里不能沿用。
function hasShoggothMutationOrigin(req) {
  return typeof req.headers.origin === "string"
    && isAllowedBrowserOrigin(req.headers.origin);
}

const SHOGGOTH_PROFILE_PUBLIC_CODES = new Set([
  "PROFILE_AUTH_REQUIRED",
  "PROFILE_MODEL_NOT_AVAILABLE",
  "PROFILE_MODEL_CATALOG_UNAVAILABLE",
  "PROFILE_OPERATION_CONFLICT",
  "PROFILE_OPERATION_EXPIRED",
  "PROFILE_COMMIT_UNCERTAIN",
]);

const SHOGGOTH_RUNTIME_ACCOUNT_PUBLIC_CODES = new Set([
  "RUNTIME_ACCOUNT_NOT_FOUND",
  "RUNTIME_ACCOUNT_SERVICE_CLOSED",
  "RUNTIME_ACCOUNT_HOME_INVALID",
  "RUNTIME_ACCOUNT_HOME_MISSING",
  "RUNTIME_ACCOUNT_AUTH_UNSUPPORTED",
  "RUNTIME_STORAGE_CANDIDATE_NOT_RECLAIMABLE",
  "RUNTIME_STORAGE_CANDIDATE_IN_USE",
  "RUNTIME_STORAGE_CANDIDATE_CHANGED",
  "RUNTIME_STORAGE_PLAN_NOT_FOUND",
  "RUNTIME_STORAGE_PLAN_EXPIRED",
  "RUNTIME_STORAGE_SCAN_INCOMPLETE",
  "RUNTIME_STORAGE_DELETE_FAILED",
  "RUNTIME_STORAGE_CLEANUP_COMMITTED_AUDIT_FAILED",
  "RUNTIME_STORAGE_CLEANUP_COMMITTED_REFRESH_FAILED",
  "RUNTIME_BACKUP_CANDIDATE_NOT_RECLAIMABLE",
  "RUNTIME_BACKUP_CANDIDATE_IN_USE",
  "RUNTIME_BACKUP_CANDIDATE_CHANGED",
  "RUNTIME_BACKUP_CLEANUP_NOT_READY",
  "RUNTIME_BACKUP_PLAN_NOT_FOUND",
  "RUNTIME_BACKUP_PLAN_EXPIRED",
  "RUNTIME_BACKUP_SCAN_INCOMPLETE",
  "RUNTIME_BACKUP_DELETE_FAILED",
  "RUNTIME_BACKUP_CLEANUP_COMMITTED_AUDIT_FAILED",
  "RUNTIME_BACKUP_CLEANUP_COMMITTED_REFRESH_FAILED",
  "AUTH_LOGIN_IN_PROGRESS",
  "AUTH_LOGIN_NOT_FOUND",
  "AUTH_LOGIN_NOT_ACTIVE",
  "AUTH_LOGIN_TIMEOUT",
  "AUTH_LOGIN_CANCELED",
  "AUTH_CANCEL_FAILED",
  "RUNTIME_ACCOUNT_ACTIVE",
  "RUNTIME_ACCOUNT_MUTATION_BUSY",
]);

function safeShoggothProfileCode(error, fallback) {
  try {
    const descriptor = error && (typeof error === "object" || typeof error === "function")
      ? Object.getOwnPropertyDescriptor(error, "code") : null;
    const code = descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")
      ? descriptor.value : null;
    return SHOGGOTH_PROFILE_PUBLIC_CODES.has(code) ? code : fallback;
  } catch {
    return fallback;
  }
}

function safeShoggothRuntimeAccountCode(error, fallback) {
  try {
    const descriptor = error && (typeof error === "object" || typeof error === "function")
      ? Object.getOwnPropertyDescriptor(error, "code") : null;
    const code = descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")
      ? descriptor.value : null;
    return SHOGGOTH_RUNTIME_ACCOUNT_PUBLIC_CODES.has(code) ? code : fallback;
  } catch {
    return fallback;
  }
}

function exactJsonObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

const WIDGET_ROUTE_PREFIX = "/__widget/";
const WIDGET_RESPONSE_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "img-src data:",
  "connect-src 'none'",
  "font-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");
const WIDGET_PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=()",
  "camera=()",
  "clipboard-read=()",
  "clipboard-write=()",
  "display-capture=()",
  "encrypted-media=()",
  "fullscreen=()",
  "gamepad=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "idle-detection=()",
  "local-fonts=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "picture-in-picture=()",
  "publickey-credentials-get=()",
  "screen-wake-lock=()",
  "serial=()",
  "speaker-selection=()",
  "storage-access=()",
  "usb=()",
  "xr-spatial-tracking=()",
].join(", ");

function widgetResponseHeaders(contentType, contentLength) {
  return {
    "Content-Type": contentType,
    "Content-Length": contentLength,
    "Cache-Control": "no-store",
    "Content-Security-Policy": WIDGET_RESPONSE_CSP,
    "Permissions-Policy": WIDGET_PERMISSIONS_POLICY,
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
  };
}

function sendWidgetFailure(res, status, extraHeaders = {}) {
  const text = status === 404 ? "Not Found" : status === 405 ? "Method Not Allowed" : "Request Failed";
  const body = Buffer.from(text, "utf8");
  res.writeHead(status, {
    ...widgetResponseHeaders("text/plain; charset=utf-8", body.length),
    ...extraHeaders,
  });
  res.end(body);
}

function parseWidgetResourceTarget(rawTarget) {
  if (typeof rawTarget !== "string" || rawTarget.length > 4608
    || !rawTarget.startsWith(WIDGET_ROUTE_PREFIX)
    || rawTarget.includes("?") || rawTarget.includes("#")) return null;
  const rest = rawTarget.slice(WIDGET_ROUTE_PREFIX.length);
  const separator = rest.indexOf("/");
  if (separator <= 0) return null;
  let backendId;
  try {
    backendId = decodeURIComponent(rest.slice(0, separator));
  } catch {
    return null;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(backendId)) return null;
  return { backendId, resourcePath: rest.slice(separator) };
}

const WIDGET_FAILURE_STATUS = Object.freeze({
  "invalid-method": 405,
  "content-type": 415,
  "too-large": 413,
  timeout: 504,
  "upstream-rejected": 502,
  "upstream-error": 502,
});

async function handleWidgetResourceRequest(req, res, rawTarget, registry) {
  // A sandboxed iframe's top-level navigation is same-origin. Its opaque-origin
  // subresources are cross-site and intentionally rejected in M7a: official
  // show_widget output is a self-contained document. M7b needs capability
  // tickets, not a weaker Fetch-Metadata gate.
  if (String(req.headers["sec-fetch-site"] || "").toLowerCase() !== "same-origin") {
    sendWidgetFailure(res, 403);
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendWidgetFailure(res, 405, { Allow: "GET, HEAD" });
    return;
  }
  const target = parseWidgetResourceTarget(rawTarget);
  if (!target || typeof registry?.fetchWidgetResource !== "function") {
    sendWidgetFailure(res, 404);
    return;
  }

  const result = projectWidgetResourceResult(
    await registry.fetchWidgetResource(target.backendId, target.resourcePath, { method: req.method }),
    req.method,
  );
  if (result.supported !== true || result.ok !== true) {
    const status = WIDGET_FAILURE_STATUS[result.reason] || 404;
    sendWidgetFailure(res, status, status === 405 ? { Allow: "GET, HEAD" } : undefined);
    return;
  }

  res.writeHead(200, widgetResponseHeaders(result.contentType, result.contentLength));
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(result.body);
}

const MAX_JSON_BODY_BYTES = 1024 * 1024;

// 读取不超过 1 MiB 的 JSON body；畸形或中断输入返回 null，字节超限立即 reject。
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    // 所有事件共用一次性结算门，排空期间的 end/error/close 不得二次改写结果。
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      bytes += buffer.length;
      if (bytes > MAX_JSON_BODY_BYTES) {
        const error = new Error("JSON body too large");
        error.code = "BODY_TOO_LARGE";
        // 立即释放已经缓存的 Buffer，并排空后续 body；不能 destroy socket，
        // 否则路由虽已拿到 reject，也无法把 413 稳定写回客户端。
        chunks.length = 0;
        bytes = 0;
        settle(reject, error);
        try { req.resume(); } catch { /* 已结算，排空失败交给请求自身 close/error 收尾 */ }
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (settled) return;
      const data = Buffer.concat(chunks, bytes).toString("utf8");
      if (!data) return settle(resolve, {});
      try {
        settle(resolve, JSON.parse(data));
      } catch {
        settle(resolve, null);
      }
    });
    req.on("error", () => settle(resolve, null));
    req.on("aborted", () => settle(resolve, null));
    req.on("close", () => settle(resolve, null));
  });
}

// 看板附件上限 = 上游 kanban_db.KANBAN_ATTACHMENT_MAX_BYTES（25 MiB）。
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// 原始字节 body（附件上传）。readJsonBody 会把内容 UTF-8 解码 + JSON.parse，
// 二进制过它必毁；这里保留 Buffer，超限抛 BODY_TOO_LARGE 让路由回 413。
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      bytes += buffer.length;
      if (bytes > maxBytes) {
        const error = new Error("body too large");
        error.code = "BODY_TOO_LARGE";
        chunks.length = 0;
        settle(reject, error);
        try { req.resume(); } catch { /* 已结算，排空交给请求自身收尾 */ }
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => settle(resolve, Buffer.concat(chunks)));
    req.on("error", (err) => settle(reject, err));
    req.on("aborted", () => settle(reject, new Error("request aborted")));
  });
}

// Archive/search 的 agentId 必须是单一路径段；后端仍会再做 resolved containment。
function isSingleSegmentAgentId(agentId) {
  return (
    typeof agentId === "string" &&
    agentId.length > 0 &&
    agentId !== "." &&
    agentId !== ".." &&
    !/[\\/\0\x00-\x1f\x7f]/.test(agentId)
  );
}

function isBoundedApiString(value, maxLength = 4096) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !/[\0\r\n]/.test(value);
}

function hasExactApiKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function hasExactSearchParams(searchParams, keys) {
  const actual = [...searchParams.keys()];
  return actual.length === keys.length
    && keys.every((key) => actual.filter((candidate) => candidate === key).length === 1);
}

// Task B 的路径 helper 目前用普通 Error 表达非法 agentId；兼容未来的
// code/name 契约，同时只匹配明确前缀，避免把普通后端故障误降级成 400。
function isInvalidAgentIdError(error) {
  return (
    error?.code === "INVALID_AGENT_ID" ||
    error?.name === "InvalidAgentIdError" ||
    /^openclaw: invalid agent id(?:\s|$)/i.test(String(error?.message || ""))
  );
}

// --- debug inspector: persist live style tweaks into manage-ui/src/debug-overrides.css ---
// Both functions only ever handle our own generated format (`selector { prop: val; }`),
// so a regex round-trip is safe — no full CSS parser needed.
function parseOverridesCss(text) {
  const out = {}; // selector -> { prop: value }
  const blockRe = /([^{}]+)\{([^}]*)\}/g;
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, ""); // drop comments first
  let m;
  while ((m = blockRe.exec(clean))) {
    const sel = m[1].trim();
    if (!sel) continue;
    const decls = {};
    const declRe = /([\w-]+)\s*:\s*([^;]+);/g;
    let d;
    while ((d = declRe.exec(m[2]))) decls[d[1].trim()] = d[2].trim();
    if (Object.keys(decls).length) out[sel] = { ...(out[sel] || {}), ...decls };
  }
  return out;
}

function generateOverridesCss(map) {
  let css =
    "/* Auto-generated by the in-app debug inspector (设置 → 调试 → 保存到源码).\n" +
    "   Staging area: fold these into the real source rules, then delete them here. */\n\n";
  for (const sel of Object.keys(map)) {
    const props = Object.keys(map[sel] || {});
    if (!props.length) continue;
    css += `${sel} {\n`;
    for (const p of props) css += `  ${p}: ${map[sel][p]};\n`;
    css += "}\n";
  }
  return css;
}

// 对聚合后的 cron 列表做轻量服务端筛选，保证列表和日历共享同一结果集。
function filterCronJobs(jobs, params) {
  let out = Array.isArray(jobs) ? [...jobs] : [];
  const backend = params.get("backend");
  const query = (params.get("query") || "").trim().toLowerCase();
  const enabled = params.get("enabled");
  const scheduleKind = params.get("scheduleKind");
  const lastStatus = params.get("lastStatus");
  // agentIds 是多选筛选：逗号分隔，命中任一即保留；空值等于不筛。
  const agentIds = (params.get("agentIds") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const sortBy = params.get("sortBy") || "nextRunAt";
  const sortDir = params.get("sortDir") === "desc" ? "desc" : "asc";
  if (backend && backend !== "all") out = out.filter((job) => job.backendId === backend);
  if (agentIds.length) out = out.filter((job) => agentIds.includes(job.agentId || ""));
  if (enabled === "enabled") out = out.filter((job) => job.enabled !== false);
  if (enabled === "disabled") out = out.filter((job) => job.enabled === false);
  if (scheduleKind && scheduleKind !== "all") out = out.filter((job) => job.schedule?.kind === scheduleKind);
  if (lastStatus && lastStatus !== "all") {
    out = out.filter((job) => (job.lastStatus || "unknown") === lastStatus);
  }
  if (query) {
    out = out.filter((job) => {
      const haystack = [
        job.name,
        job.description,
        job.prompt,
        job.deliver,
        job.delivery?.mode,
        ...(job.backendDetails?.capabilityTags || []),
        ...(job.rawCapabilities || []),
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(query);
    });
  }
  out.sort((a, b) => {
    let av;
    let bv;
    if (sortBy === "name") {
      av = a.name || "";
      bv = b.name || "";
      return sortDir === "desc" ? String(bv).localeCompare(String(av)) : String(av).localeCompare(String(bv));
    }
    av = a[sortBy] || 0;
    bv = b[sortBy] || 0;
    return sortDir === "desc" ? bv - av : av - bv;
  });
  return out;
}

// runs 查询参数保持为普通对象，交给各后端自行决定支持程度。
function cronRunOptionsFromQuery(params) {
  const limit = Number(params.get("limit"));
  const offset = Number(params.get("offset"));
  return {
    status: params.get("status") || undefined,
    deliveryStatus: params.get("deliveryStatus") || undefined,
    query: params.get("query") || undefined,
    sortDir: params.get("sortDir") === "asc" ? "asc" : "desc",
    limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    offset: Number.isFinite(offset) && offset >= 0 ? offset : undefined,
  };
}

async function resolveResourceBackend(registry, kind, id) {
  if (typeof registry?.resolveResourceOwner === "function") {
    return registry.resolveResourceOwner(kind, id);
  }
  // Compatibility for narrow test/dev registries created before the generic
  // ownership contract. Production BackendRegistry always uses the probe above.
  if (kind === "cron" && typeof registry?.routeByCronId === "function") {
    return registry.routeByCronId(id);
  }
  return null;
}

// Management REST plane. Bound to the same loopback origin as the UI; the
// registry (main-process aggregation layer) is the single source of truth.
//   GET    /__api/cron/jobs          aggregate/filter across backends
//   POST   /__api/cron/jobs          create (body.backendId | body.agentId picks backend)
//   PUT    /__api/cron/jobs/:id      update (id routes to its backend)
//   DELETE /__api/cron/jobs/:id      remove
//   POST   /__api/cron/jobs/:id/run  trigger now
//   GET    /__api/models[?backend=]  model catalog (per-backend tab, or merged)
//   GET/POST/PUT/DELETE /__api/models/config?backend=[&provider=&id=]  自定义模型配置 CRUD（PUT=改 provider 端点）
//   POST   /__api/models/config/reveal?backend=  已禁用；明文只经受信 Electron IPC
//   GET/DELETE /__api/models/credentials?backend=&provider=[&index=]  provider 凭证池（轮换 key）
//   GET    /__api/models/settings?backend=&profile=  模型设置聚合快照（主模型/目录含未配置/辅助/MoA/默认/后备链）
//   POST   /__api/models/settings/{main,defaults,fallbacks}  应用主模型 / 默认参数 / 后备链
//   PUT    /__api/models/settings/moa            MoA 配置整份保存
//   GET    /__api/models/settings/recommended?backend=&provider=  激活后推荐默认模型
//   GET/POST/DELETE /__api/models/endpoints?backend=[&id=]  自定义端点 CRUD（POST /validate 校验、POST /activate 激活）
//   GET    /__api/usage?backend=&range=          daily token/cost series (fast)
//   GET    /__api/usage/breakdown?backend=&range= by-model/by-agent rankings (slow)
//   GET    /__api/skills?backend=                 skill list (per-backend tab, read-only)
//   GET    /__api/skills/usage                    per-backend: which skills agents actually loaded (registry merge)
//   GET    /__api/tasks/federated?project=        unified project board across backends
//   POST   /__api/tasks/federated                 create, routed by composite Agent id
//   POST   /__api/tasks/federated/move            move on the task's owning backend
//   POST   /__api/tasks/projects                  create app-owned logical project
//   DELETE /__api/tasks/projects/:key             permanently delete supported backend project data
//   GET    /__api/tasks?backend=                  legacy per-backend kanban board
//   GET    /__api/cli                             local $PATH CLI scan (host-level, no backend)
//   GET    /__api/cli/usage                       per-backend: which CLI commands agents actually ran (registry merge)
//   GET    /__api/agents?backend=                 agent list (per-backend tab)
//   GET    /__api/status                          per-backend connection / overview status
//   GET    /__api/host/openclaw                   本机 openclaw 检测(装没装/跑没跑;host 能力)
//   GET    /__api/chat/cache-scope?backend=       opaque renderer history-cache identity
//   POST   /__api/host/openclaw/start             代跑网关启动 {mode:"start"|"install"}
//   POST   /__api/host/open-path                  用系统默认程序打开文件/目录
//   POST   /__api/host/open-attachment?name=       用系统默认程序打开附件字节的私有副本
//   POST   /__api/host/reveal-path                在系统文件管理器中定位文件
//   POST   /__api/host/terminal                   在系统终端里跑 provider 的登录/断开命令
//                                                 {backend,provider,kind:"cli"|"disconnect"} —— **不收命令串**
//   GET    /__api/discovery/openclaw              局域网 mDNS 浏览 OpenClaw 网关(host 能力)
//   GET/PUT /__api/discovery/state?backend=       LAN 发现开关(契约→registry;OpenClaw only)
//   GET    /__api/dashboard[?sinceMs=&runsLimit=&artifactsLimit=]  aggregated dashboard summary
//   GET    /__api/versions                        current + official latest versions
//   GET    /__api/updates                         per-backend self-update status (设置页轮询)
//   POST   /__api/updates/run?backend=            trigger official self-update (background)
// Segments come from the RAW url so an encoded "/" (%2F) inside an id survives
// splitting; each segment is then decoded individually (CRON-005). The `pathname`
// param stays the caller's fully-decoded form for non-segment uses.
// external provider 的终端命令白名单。`/__api` 是**无鉴权 loopback 面**，本机任何
// 进程都能 curl 它——所以 /host/terminal 只收 {provider,kind}，命令由服务端在这张
// 表里查。表在服务 GET /__api/oauth 时顺手记下（那次调用要 6~9s/dashboard，不能
// 每次执行都重拉）；查不到就现拉一次，仍无 → 400。key = `<backend>:<provider>`。
const oauthCommands = new Map();
function rememberOAuthCommands(backendId, snapshot) {
  for (const p of snapshot?.providers || []) {
    if (!p?.id) continue;
    oauthCommands.set(`${backendId}:${p.id}`, {
      cli: p.cliCommand || "",
      disconnect: p.disconnectCommand || "",
    });
  }
  return snapshot;
}

// `deps` carries optional capabilities: { configStore, hostOps, productHost,
// onConfigChanged, modelChangeCoordinator }。Task 6 的 mutation 路由只从该依赖进入协调器。
async function handleApiRequest(req, res, pathname, registry, deps = {}) {
  if (!registry) return sendJson(res, 503, { error: "registry unavailable" });
  const {
    configStore,
    hostOps,
    attachmentOpener,
    productHost,
    onConfigChanged,
    modelChangeCoordinator,
    workAdmissionGate,
    cliExecutionGate,
  } = deps;
  const method = req.method || "GET";
  let rawPath = pathname;
  let requestUrl = null;
  try {
    requestUrl = new URL(req.url, "http://127.0.0.1");
    rawPath = requestUrl.pathname;
  } catch {
    /* keep decoded pathname */
  }
  const segs = rawPath
    .slice("/__api/".length)
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try { return decodeURIComponent(s); } catch { return s; }
    });
  try {
    if (segs[0] === "inspirations") {
      try {
        const id = requestUrl?.searchParams.get("id") || "";
        const page = { cursor: requestUrl?.searchParams.get("cursor") || null,
          limit: Number(requestUrl?.searchParams.get("limit") || 20) };
        if (segs.length === 2 && segs[1] === "import" && method === "POST") return sendJson(res, 200,
          await registry.importInspirations(await readJsonBody(req)));
        if (segs.length === 2 && segs[1] === "media" && method === "POST") return sendJson(res, 200,
          await registry.writeInspirationMedia(await readJsonBody(req)));
        if (segs.length === 2 && segs[1] === "media" && method === "GET") {
          const preview = requestUrl?.searchParams.get("preview") === "1" ? { preview: true } : {};
          const first = await registry.readInspirationMedia({ id, offset: 0, ...preview });
          const { attachment } = first;
          let start = 0, end = attachment.size - 1;
          const range = req.headers.range;
          if (range) {
            const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
            if (!match || (!match[1] && !match[2])) {
              res.writeHead(416, { "Content-Range": `bytes */${attachment.size}` }); return res.end();
            }
            start = match[1] ? Number(match[1]) : Math.max(0, attachment.size - Number(match[2]));
            end = match[1] && match[2] ? Math.min(end, Number(match[2])) : end;
            if (!Number.isSafeInteger(start) || start < 0 || start > end) {
              res.writeHead(416, { "Content-Range": `bytes */${attachment.size}` }); return res.end();
            }
          }
          const { CHUNK_BYTES } = require("./agent-service/inspiration-media");
          const chunks = [];
          for (let offset = Math.floor(start / CHUNK_BYTES) * CHUNK_BYTES; offset <= end; offset += CHUNK_BYTES) {
            const chunk = offset === 0 ? first : await registry.readInspirationMedia({ id, offset, ...preview });
            chunks.push(Buffer.from(chunk.content, "base64").subarray(Math.max(0, start - offset), end - offset + 1));
          }
          res.writeHead(range ? 206 : 200, { "Content-Type": attachment.mimeType, "Content-Length": end - start + 1,
            ...(!/^(image|video|audio)\//u.test(attachment.mimeType) ? { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name).replace(/['()*]/gu, c => '%' + c.charCodeAt(0).toString(16))}` } : {}),
            "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=31536000, immutable", "Accept-Ranges": "bytes",
            ...(range ? { "Content-Range": `bytes ${start}-${end}/${attachment.size}` } : {}) });
          return res.end(Buffer.concat(chunks));
        }
        if (segs.length === 1 && method === "GET") return sendJson(res, 200, await registry.listInspirations({
          ...page, query: requestUrl?.searchParams.get("query") || "",
          filter: requestUrl?.searchParams.get("filter") || "all",
          ...(requestUrl?.searchParams.has("backendId") || requestUrl?.searchParams.has("agentId") ? {
            backendId: requestUrl.searchParams.get("backendId"), agentId: requestUrl.searchParams.get("agentId"),
          } : {}),
        }));
        if (segs.length === 1 && method === "POST") return sendJson(res, 200,
          await registry.createInspiration(await readJsonBody(req)));
        if (segs.length === 2 && segs[1] === "agents" && method === "GET") return sendJson(res, 200,
          await registry.getInspirationAgents());
        if (segs.length === 2 && segs[1] === "agent-dock" && method === "GET") return sendJson(res, 200,
          await registry.getInspirationAgentDock());
        if (segs.length === 2 && segs[1] === "idle-agents" && method === "GET") return sendJson(res, 200,
          await registry.getIdleInspirationAgents());
        if (segs.length === 2 && segs[1] === "growth" && method === "GET") return sendJson(res, 200,
          await registry.getInspirationGrowth());
        if (segs.length === 2 && segs[1] === "growth" && method === "PATCH") return sendJson(res, 200,
          await registry.updateInspirationGrowth(await readJsonBody(req)));
        if (segs.length === 2 && segs[1] === "detail" && method === "GET") return sendJson(res, 200,
          await registry.getInspiration(id));
        if (segs.length === 2 && segs[1] === "executions" && method === "GET") return sendJson(res, 200,
          await registry.getInspirationExecutions(id, page));
        if (segs.length === 2 && segs[1] === "activity" && method === "GET") return sendJson(res, 200,
          await registry.getInspirationActivity(id, requestUrl?.searchParams.get("runId") || ""));
        if (segs.length === 2 && segs[1] === "detail" && method === "PATCH") return sendJson(res, 200,
          await registry.updateInspiration(id, await readJsonBody(req)));
        if (segs.length === 2 && segs[1] === "detail" && method === "DELETE") return sendJson(res, 200,
          await registry.deleteInspiration(id, await readJsonBody(req)));
        if (segs.length === 2 && method === "POST" && ["start", "respond", "cancel"].includes(segs[1])) {
          const operation = { start: "startInspiration", respond: "respondInspiration", cancel: "cancelInspiration" }[segs[1]];
          return sendJson(res, 200, await registry[operation](id, await readJsonBody(req)));
        }
        return sendJson(res, 404, { error: "Unknown Inspiration endpoint" });
      } catch (error) {
        const code = /^INSPIRATION_[A-Z_]+$/u.test(error?.code || "") ? error.code : "INSPIRATION_UNAVAILABLE";
        const status = code === "INSPIRATION_NOT_FOUND" ? 404
          : /CONFLICT|BUSY|EXPIRED|ARCHIVED|NOT_COMPLETED/u.test(code) ? 409
            : /UNAVAILABLE|CORRUPT|UNCERTAIN/u.test(code) ? 503 : 400;
        return sendJson(res, status, { code, error: code === "INSPIRATION_UNAVAILABLE"
          ? "灵感服务暂不可用，输入仍保留在本机" : error.message });
      }
    }
    // Shoggoth 产品面只消费 Host/Backend 的安全 DTO；不得把 Service 原始
    // provider/profile/status（credentialRef、runtimeProfileId、路径等）直送 renderer。
    if (segs[0] === "shoggoth") {
      if (!productHost) return sendJson(res, 501, { error: "Shoggoth product host unavailable" });
      if (segs.length === 2 && segs[1] === "status" && method === "GET") {
        return sendJson(res, 200, await productHost.getStatus());
      }
      if (segs.length === 2 && segs[1] === "providers" && method === "GET") {
        return sendJson(res, 200, await productHost.listProviders({
          profileId: requestUrl?.searchParams.has("profileId")
            ? requestUrl.searchParams.get("profileId") : null,
        }));
      }
      if (segs.length === 2 && segs[1] === "runtime-accounts" && method === "GET") {
        try {
          return sendJson(res, 200, await productHost.listRuntimeAccounts());
        } catch (error) {
          return sendJson(res, 503, {
            error: "Shoggoth runtime accounts unavailable",
            code: safeShoggothRuntimeAccountCode(error, "RUNTIME_ACCOUNT_UNAVAILABLE"),
          });
        }
      }
      if (segs.length === 3 && segs[1] === "runtime-accounts"
        && segs[2] === "legacy-homes" && method === "GET") {
        try {
          return sendJson(res, 200, await productHost.listLegacyRuntimeHomes({
            runtimeAccountId: null,
          }));
        } catch (error) {
          return sendJson(res, 503, {
            error: "Shoggoth legacy runtime homes unavailable",
            code: safeShoggothRuntimeAccountCode(error, "RUNTIME_ACCOUNT_STORAGE_UNAVAILABLE"),
          });
        }
      }
      if (segs.length === 5 && segs[1] === "runtime-accounts"
        && segs[2] === "legacy-homes" && segs[3] === "cleanup"
        && ["prepare", "commit"].includes(segs[4]) && method === "POST") {
        if (!hasShoggothMutationOrigin(req)) return sendJson(res, 403, { error: "Forbidden" });
        try {
          const body = await readJsonBody(req);
          const field = segs[4] === "prepare" ? "entryId" : "planId";
          if (!exactJsonObject(body, [field])) throw new Error("invalid cleanup body");
          const result = segs[4] === "prepare"
            ? await productHost.prepareLegacyRuntimeHomeCleanup({ entryId: body.entryId })
            : await productHost.commitLegacyRuntimeHomeCleanup({ planId: body.planId });
          return sendJson(res, 200, result);
        } catch (error) {
          return sendJson(res, 409, {
            error: "Shoggoth legacy runtime cleanup rejected",
            code: safeShoggothRuntimeAccountCode(error, "RUNTIME_ACCOUNT_CLEANUP_REJECTED"),
          });
        }
      }
      if (segs.length === 3 && segs[1] === "runtime-accounts"
        && segs[2] === "backups" && method === "GET") {
        try {
          return sendJson(res, 200, await productHost.listRuntimeBackups());
        } catch (error) {
          return sendJson(res, 503, {
            error: "Shoggoth runtime backups unavailable",
            code: safeShoggothRuntimeAccountCode(error, "RUNTIME_ACCOUNT_STORAGE_UNAVAILABLE"),
          });
        }
      }
      if (segs.length === 5 && segs[1] === "runtime-accounts"
        && segs[2] === "backups" && segs[3] === "cleanup"
        && ["prepare", "commit"].includes(segs[4]) && method === "POST") {
        if (!hasShoggothMutationOrigin(req)) return sendJson(res, 403, { error: "Forbidden" });
        try {
          const body = await readJsonBody(req);
          const field = segs[4] === "prepare" ? "entryId" : "planId";
          if (!exactJsonObject(body, [field])) throw new Error("invalid backup cleanup body");
          const result = segs[4] === "prepare"
            ? await productHost.prepareRuntimeBackupCleanup({ entryId: body.entryId })
            : await productHost.commitRuntimeBackupCleanup({ planId: body.planId });
          return sendJson(res, 200, result);
        } catch (error) {
          return sendJson(res, 409, {
            error: "Shoggoth runtime backup cleanup rejected",
            code: safeShoggothRuntimeAccountCode(error, "RUNTIME_ACCOUNT_CLEANUP_REJECTED"),
          });
        }
      }
      if (segs.length === 3 && segs[1] === "runtime-accounts" && method === "GET") {
        try {
          return sendJson(res, 200, await productHost.readRuntimeAccount({
            runtimeAccountId: segs[2],
          }));
        } catch (error) {
          return sendJson(res, 503, {
            error: "Shoggoth runtime account unavailable",
            code: safeShoggothRuntimeAccountCode(error, "RUNTIME_ACCOUNT_UNAVAILABLE"),
          });
        }
      }
      if (segs.length === 4 && segs[1] === "runtime-accounts"
        && segs[3] === "auth" && method === "GET") {
        try {
          return sendJson(res, 200, await productHost.readRuntimeAccountAuth({
            runtimeAccountId: segs[2],
          }));
        } catch (error) {
          return sendJson(res, 503, {
            error: "Shoggoth runtime account auth unavailable",
            code: safeShoggothRuntimeAccountCode(error, "RUNTIME_ACCOUNT_AUTH_UNAVAILABLE"),
          });
        }
      }
      if (segs.length === 4 && segs[1] === "runtime-accounts"
        && segs[3] === "storage" && method === "GET") {
        try {
          return sendJson(res, 200, await productHost.readRuntimeAccountStorage({
            runtimeAccountId: segs[2],
          }));
        } catch (error) {
          return sendJson(res, 503, {
            error: "Shoggoth runtime account storage unavailable",
            code: safeShoggothRuntimeAccountCode(error, "RUNTIME_ACCOUNT_STORAGE_UNAVAILABLE"),
          });
        }
      }
      if (segs.length === 4 && segs[1] === "runtime-accounts"
        && segs[3] === "login" && method === "POST") {
        if (!hasShoggothMutationOrigin(req)) return sendJson(res, 403, { error: "Forbidden" });
        try {
          const body = await readJsonBody(req);
          if (!exactJsonObject(body, ["mode"])) throw new Error("invalid login body");
          return sendJson(res, 200, await productHost.startRuntimeAccountLogin({
            runtimeAccountId: segs[2],
            mode: body.mode,
          }));
        } catch (error) {
          return sendJson(res, 409, {
            error: "Shoggoth runtime account login rejected",
            code: safeShoggothRuntimeAccountCode(error, "RUNTIME_ACCOUNT_LOGIN_REJECTED"),
          });
        }
      }
      if (segs.length === 5 && segs[1] === "runtime-accounts"
        && segs[3] === "login" && segs[4] === "cancel" && method === "POST") {
        if (!hasShoggothMutationOrigin(req)) return sendJson(res, 403, { error: "Forbidden" });
        try {
          const body = await readJsonBody(req);
          if (!exactJsonObject(body, ["requestId"])) throw new Error("invalid cancel body");
          return sendJson(res, 200, await productHost.cancelRuntimeAccountLogin({
            runtimeAccountId: segs[2],
            requestId: body.requestId,
          }));
        } catch (error) {
          return sendJson(res, 409, {
            error: "Shoggoth runtime account login cancellation rejected",
            code: safeShoggothRuntimeAccountCode(error, "RUNTIME_ACCOUNT_LOGIN_CANCEL_REJECTED"),
          });
        }
      }
      if (segs.length === 4 && segs[1] === "runtime-accounts"
        && segs[3] === "logout" && method === "POST") {
        if (!hasShoggothMutationOrigin(req)) return sendJson(res, 403, { error: "Forbidden" });
        try {
          const body = await readJsonBody(req);
          if (!exactJsonObject(body, [])) throw new Error("invalid logout body");
          return sendJson(res, 200, await productHost.logoutRuntimeAccount({
            runtimeAccountId: segs[2],
          }));
        } catch (error) {
          return sendJson(res, 409, {
            error: "Shoggoth runtime account logout rejected",
            code: safeShoggothRuntimeAccountCode(error, "RUNTIME_ACCOUNT_LOGOUT_REJECTED"),
          });
        }
      }
      if (segs.length === 3 && segs[1] === "chatgpt" && segs[2] === "models"
        && method === "GET") {
        try {
          return sendJson(res, 200, await productHost.listChatGptModels({
            profileId: requestUrl?.searchParams.has("profileId")
              ? requestUrl.searchParams.get("profileId") : null,
          }));
        } catch (error) {
          return sendJson(res, 503, {
            error: "Shoggoth ChatGPT model catalog unavailable",
            code: safeShoggothProfileCode(error, "PROFILE_MODEL_CATALOG_UNAVAILABLE"),
          });
        }
      }
      if (segs.length === 3 && segs[1] === "providers" && segs[2] === "configure"
        && method === "POST") {
        if (!hasShoggothMutationOrigin(req)) return sendJson(res, 403, { error: "Forbidden" });
        try {
          const body = await readJsonBody(req);
          return sendJson(res, 200, await productHost.configureProvider(body));
        } catch {
          return sendJson(res, 409, {
            error: "Shoggoth provider configuration failed",
            code: "SHOGGOTH_PROVIDER_CONFIGURATION_FAILED",
          });
        }
      }
      if (segs.length === 3 && segs[1] === "chatgpt" && segs[2] === "bind"
        && method === "POST") {
        if (!hasShoggothMutationOrigin(req)) return sendJson(res, 403, { error: "Forbidden" });
        try {
          const body = await readJsonBody(req);
          return sendJson(res, 200, await productHost.bindChatGpt(body));
        } catch (error) {
          return sendJson(res, 409, {
            error: "Shoggoth ChatGPT binding failed",
            code: safeShoggothProfileCode(error, "SHOGGOTH_CHATGPT_BIND_FAILED"),
          });
        }
      }
      if (segs.length === 3 && segs[1] === "providers" && segs[2] === "clear"
        && method === "POST") {
        if (!hasShoggothMutationOrigin(req)) return sendJson(res, 403, { error: "Forbidden" });
        try {
          const body = await readJsonBody(req);
          return sendJson(res, 200, await productHost.clearProfileProvider(body));
        } catch (error) {
          return sendJson(res, 409, {
            error: "Shoggoth provider clear failed",
            code: safeShoggothProfileCode(error, "SHOGGOTH_PROVIDER_CLEAR_FAILED"),
          });
        }
      }
      if (segs.length === 3 && segs[1] === "chatgpt" && segs[2] === "login"
        && method === "POST") {
        if (!hasShoggothMutationOrigin(req)) return sendJson(res, 403, { error: "Forbidden" });
        try {
          const body = await readJsonBody(req);
          return sendJson(res, 200, await productHost.startChatGptLogin(body));
        } catch {
          return sendJson(res, 409, {
            error: "Shoggoth ChatGPT login failed",
            code: "SHOGGOTH_CHATGPT_LOGIN_FAILED",
          });
        }
      }
      if (segs.length === 3 && segs[1] === "background" && segs[2] === "stop-impact" && method === "GET") {
        try {
          return sendJson(res, 200, await productHost.getBackgroundStopImpact());
        } catch {
          return sendJson(res, 503, { error: "Shoggoth stop impact unavailable", code: "SHOGGOTH_STOP_IMPACT_UNAVAILABLE" });
        }
      }
      if (segs.length === 3 && segs[1] === "background" && method === "POST") {
        if (!hasShoggothMutationOrigin(req)) return sendJson(res, 403, { error: "Forbidden" });
        if (!["install", "start", "stop", "repair"].includes(segs[2])) {
          return sendJson(res, 404, { error: "unknown background action" });
        }
        try {
          const result = segs[2] === "stop"
            ? await productHost.stopBackground(await readJsonBody(req))
            : await productHost.runBackgroundAction(segs[2]);
          return sendJson(res, 200, result);
        } catch (error) {
          if (["SHOGGOTH_STOP_CONFIRMATION_REQUIRED", "SHOGGOTH_STOP_IMPACT_CHANGED"].includes(error?.code)) {
            return sendJson(res, 409, { error: "Shoggoth stop confirmation required", code: error.code });
          }
          return sendJson(res, 503, {
            error: "Shoggoth background action failed",
            code: "SHOGGOTH_BACKGROUND_ACTION_FAILED",
          });
        }
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }

    if (segs[0] === "dashboard" && segs[1] === "runs" && segs.length === 3) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const backendId = new URL(req.url, "http://127.0.0.1").searchParams.get("backend") || "";
      const backend = registry.getBackend(backendId);
      if (!backend) return sendJson(res, 404, { error: `unknown backend ${backendId}` });
      try {
        return sendJson(res, 200, await backend.getDashboardRunDetail(segs[2]));
      } catch {
        return sendJson(res, 409, {
          error: "Agent run detail unavailable",
          code: "AGENT_RUN_DETAIL_UNAVAILABLE",
        });
      }
    }

    if (segs[0] === "dashboard" && segs[1] === "prompts"
      && segs[2] === "respond" && segs.length === 3) {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      if (!hasShoggothMutationOrigin(req)) return sendJson(res, 403, { error: "Forbidden" });
      const backendId = new URL(req.url, "http://127.0.0.1").searchParams.get("backend") || "";
      const backend = registry.getBackend(backendId);
      if (!backend) return sendJson(res, 404, { error: `unknown backend ${backendId}` });
      const body = await readJsonBody(req);
      if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
      try {
        const result = await backend.respondDashboardPrompt(body);
        return sendJson(res, 200, { runId: result.run.id, status: result.run.status });
      } catch {
        return sendJson(res, 409, {
          error: "Agent prompt response rejected",
          code: "AGENT_PROMPT_RESPONSE_REJECTED",
        });
      }
    }

    // One-release compatibility alias for clients shipped before dashboard run
    // routing carried the owning backend id.
    if (segs[0] === "dashboard" && segs[1] === "shoggoth") {
      if (segs.length === 4 && segs[2] === "runs" && method === "GET") {
        const backend = await resolveResourceBackend(registry, "dashboard-run", segs[3]);
        if (!backend) return sendJson(res, 404, { error: "Agent run owner unavailable" });
        try {
          return sendJson(res, 200, await backend.getDashboardRunDetail(segs[3]));
        } catch {
          return sendJson(res, 409, {
            error: "Shoggoth run detail unavailable",
            code: "SHOGGOTH_RUN_DETAIL_UNAVAILABLE",
          });
        }
      }
      if (segs.length === 4 && segs[2] === "prompts" && segs[3] === "respond" && method === "POST") {
        if (!hasShoggothMutationOrigin(req)) return sendJson(res, 403, { error: "Forbidden" });
        const body = await readJsonBody(req);
        if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
        const backend = await resolveResourceBackend(registry, "dashboard-run", body.runId);
        if (!backend) return sendJson(res, 404, { error: "Agent run owner unavailable" });
        try {
          const result = await backend.respondDashboardPrompt(body);
          return sendJson(res, 200, { runId: result.run.id, status: result.run.status });
        } catch {
          return sendJson(res, 409, {
            error: "Shoggoth prompt response rejected",
            code: "SHOGGOTH_PROMPT_RESPONSE_REJECTED",
          });
        }
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }

    // 首启梯子的本机侦察(host 能力,与 /__api/cli 同族——不经 registry)。
    if (segs[0] === "host" && segs[1] === "openclaw") {
      if (segs.length === 2 && method === "GET") {
        const gatewayUrl = configStore?.read?.().gatewayUrl;
        return sendJson(res, 200, { host: await detectOpenclawHost({ gatewayUrl }) });
      }
      if (segs[2] === "start" && segs.length === 3 && method === "POST") {
        const body = await readJsonBody(req);
        return sendJson(res, 200, await startOpenclawGateway({ mode: body?.mode }));
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }

    // 局域网发现(host 能力):浏览 _openclaw-gw._tcp 广播,向导远程面板点选预填。
    if (segs[0] === "discovery" && segs[1] === "openclaw" && segs.length === 2) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      return sendJson(res, 200, { gateways: await browseOpenclawGateways() });
    }

    // App configuration (the 设置 page): read/update gateway URL, token, locale,
    // and the Hermes connection mode (local-spawn vs remote dashboards).
    if (segs[0] === "config" && segs.length === 1) {
      if (!configStore) return sendJson(res, 501, { error: "config store unavailable" });
      if (method === "GET") {
        return sendJson(res, 200, { config: configStore.read() });
      }
      if (method === "PUT") {
        const body = await readJsonBody(req);
        if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
        // windowBounds 由桌面壳在 resize 时写，不归 UI 管：设置页整份回写时带的是
        // 它打开那一刻的旧值，放行会把用户刚拖出来的尺寸覆盖回去。
        // The shortcut is committed by trusted desktop IPC only, after the OS
        // accepts the new binding. A stale Settings form must not revert it.
        const { windowBounds: _ignoredWindowBounds, inspirationShortcut: _ignoredInspirationShortcut, ...writable } = body;
        if (Array.isArray(writable.disabledBackends) && registry) {
          const disabled = new Set(writable.disabledBackends
            .filter((id) => typeof id === "string").map((id) => id.trim()));
          const descriptors = registry.listBackendDescriptors();
          if (descriptors.length > 0 && descriptors.every((backend) => backend.disconnectable && disabled.has(backend.id))) {
            return sendJson(res, 409, { code: "LAST_BACKEND_REQUIRED", error: "At least one connection must remain enabled." });
          }
        }
        const saved = configStore.write(writable);
        // Respond BEFORE applying: onConfigChanged may reload the Electron window,
        // which would abort THIS fetch mid-flight (the renderer navigates away
        // before it sees the 200), making a successful save look like it failed.
        sendJson(res, 200, { config: saved });
        if (typeof onConfigChanged === "function") {
          try { await onConfigChanged(saved); } catch (e) { console.error("[config] onConfigChanged:", e?.message || e); }
        }
        return;
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }

    // Static product catalog: page shape and connection controls depend on
    // backend-declared capabilities, never on backend ids in the renderer.
    if (segs[0] === "backends" && segs.length === 1) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      return sendJson(res, 200, { backends: registry.listBackendDescriptors() });
    }

    // 聊天历史缓存隔离摘要：只读、纯本地计算。registry 会过滤 disabled/unknown/
    // unsupported，并只允许固定 SHA-256 格式，响应绝不含 home、URL 或 token。
    if (segs[0] === "chat" && segs[1] === "cache-scope" && segs.length === 2) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const url = new URL(req.url, "http://127.0.0.1");
      const backendId = url.searchParams.get("backend") || "";
      const scope = backendId ? registry.getChatCacheScope(backendId) : null;
      if (!scope) return sendJson(res, 404, { error: `unknown or unsupported backend: ${backendId}` });
      return sendJson(res, 200, scope);
    }

    // 聊天面能力探查（附件种类/上限等）：按 agent 路由到 owning backend（契约
    // getChatCapabilities）；UI composer 据此渲染 accept 与预检。
    if (segs[0] === "chat" && segs[1] === "capabilities" && segs.length === 2) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const url = new URL(req.url, "http://127.0.0.1");
      const agentId = url.searchParams.get("agent") || "";
      // `agent=` 是常规路径（UI 用）。`backend=` 是回退：一个后端离线时它不认领
      // 自己的 agent（route 返回 null），可这些能力是**静态的传输属性**，与在线
      // 与否无关——不给回退的话，启动竞态窗口里 UI 会误以为只能传图片。
      const backendId = url.searchParams.get("backend") || "";
      const backend = (agentId ? registry.route(agentId) : null) || (backendId ? getActiveBackend(registry, backendId) : null);
      if (!backend) return sendJson(res, 404, { error: `unknown agent ${agentId || backendId}` });
      return sendJson(res, 200, backend.getChatCapabilities(agentId));
    }

    // 斜杠命令三件套（S6）：目录 / 参数补全 / 服务端执行。按 agent 路由；无
    // 服务端命令面的后端回 {supported:false}，UI 回落内置表。
    if (segs[0] === "chat" && segs[1] === "slash") {
      const url = new URL(req.url, "http://127.0.0.1");
      if (segs.length === 2 && method === "GET") {
        const agentId = url.searchParams.get("agent") || "";
        // 同 capabilities：目录读取允许 backend= 回退（离线后端也能如实回答
        // 「我没有服务端命令面」）。complete/exec 不给回退——它们要真会话。
        const backendId = url.searchParams.get("backend") || "";
        const backend = (agentId ? registry.route(agentId) : null) || (backendId ? getActiveBackend(registry, backendId) : null);
        if (!backend) return sendJson(res, 404, { error: `unknown agent ${agentId || backendId}` });
        return sendJson(res, 200, await backend.listSlashCommands(
          agentId,
          url.searchParams.get("session") || undefined,
        ));
      }
      if (segs[2] === "complete" && segs.length === 3 && method === "GET") {
        const agentId = url.searchParams.get("agent") || "";
        const backend = registry.route(agentId);
        if (!backend) return sendJson(res, 404, { error: `unknown agent ${agentId}` });
        return sendJson(res, 200, await backend.completeSlash(agentId, url.searchParams.get("text") || ""));
      }
      if (segs[2] === "exec" && segs.length === 3 && method === "POST") {
        if (!hasShoggothMutationOrigin(req)) return sendJson(res, 403, { error: "Forbidden" });
        const body = await readJsonBody(req);
        const agentId = String(body?.agentId || "");
        const sessionKey = String(body?.sessionKey || "");
        const text = String(body?.text || "");
        if (!agentId || !sessionKey || !text) {
          return sendJson(res, 400, { error: "agentId, sessionKey and text required" });
        }
        const backend = registry.route(agentId);
        if (!backend) return sendJson(res, 404, { error: `unknown agent ${agentId}` });
        return sendJson(res, 200, await backend.execSlash(agentId, sessionKey, text));
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }

    // Test a connection without persisting it (POST body = candidate config).
    if (segs[0] === "status" && segs[1] === "test" && segs.length === 2) {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      const body = await readJsonBody(req);
      if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
      const result = await registry.testConnection(body);
      return sendJson(res, 200, result);
    }
    // LAN 发现开关(标准链路:契约→registry;目前 OpenClaw only)。
    if (segs[0] === "discovery" && segs[1] === "state" && segs.length === 2) {
      const url = new URL(req.url, "http://127.0.0.1");
      const backendId = url.searchParams.get("backend") || "openclaw";
      if (method === "GET") return sendJson(res, 200, await registry.getLanDiscovery(backendId));
      if (method === "PUT") {
        if (!getActiveBackend(registry, backendId)) {
          return sendJson(res, 404, { error: `unknown backend ${backendId}` });
        }
        const body = await readJsonBody(req);
        if (!body || typeof body.enabled !== "boolean") return sendJson(res, 400, { error: "enabled 必须是布尔" });
        return sendJson(res, 200, await registry.setLanDiscovery(backendId, body.enabled));
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }
    if (segs[0] === "cron" && segs[1] === "jobs") {
      const url = new URL(req.url, "http://127.0.0.1");
      const qid = url.searchParams.get("id");
      if (segs.length === 2 && qid) {
        // Item ops in query form (?id=&action=) — cron ids may contain "/"
        // (OpenClaw), so they can't be a path segment (ARCHITECTURE §9).
        const backend = await resolveResourceBackend(registry, "cron", qid);
        if (!backend) return sendJson(res, 404, { error: `no backend for cron id ${qid}` });
        const action = url.searchParams.get("action");
        if (method === "GET" && action === "runs") {
          return sendJson(res, 200, await backend.getCronRuns(qid, cronRunOptionsFromQuery(url.searchParams)));
        }
        if (method === "GET" && action === "delivery") {
          const atRaw = url.searchParams.get("at");
          const at = atRaw != null ? Number(atRaw) : NaN;
          return sendJson(res, 200, await backend.getCronLatestDelivery(qid, Number.isFinite(at) ? at : undefined));
        }
        if (method === "GET" && action === "trajectory") {
          const sessionKey = url.searchParams.get("sessionKey") || undefined;
          const runId = url.searchParams.get("runId") || undefined;
          return sendJson(res, 200, await backend.getCronRunTrajectory(qid, { sessionKey, runId }));
        }
        if (method === "GET" && action === "detail") {
          if (typeof backend.getCronJob !== "function") {
            return sendJson(res, 501, {
              error: "cron detail unsupported",
              code: "CRON_DETAIL_UNSUPPORTED",
            });
          }
          return sendJson(res, 200, {
            job: await backend.getCronJob(qid, { includePrompt: true }),
          });
        }
        if (method === "POST" && action === "run") {
          const body = await readJsonBody(req);
          if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
          const job = await withWorkAdmission(
            workAdmissionGate,
            backend.id,
            "cron.run",
            () => backend.runCronJob(qid, body.mode),
          );
          return sendJson(res, 200, { job });
        }
        if (method === "PUT") {
          const patch = await readJsonBody(req);
          if (!patch) return sendJson(res, 400, { error: "invalid JSON body" });
          return sendJson(res, 200, { job: await backend.updateCronJob(qid, patch) });
        }
        if (method === "DELETE") {
          await backend.deleteCronJob(qid);
          return sendJson(res, 200, { ok: true });
        }
        return sendJson(res, 405, { error: "method not allowed" });
      }
      if (segs.length === 2) {
        if (method === "GET") {
          return sendJson(res, 200, { jobs: filterCronJobs(await registry.aggregateCronJobs(), url.searchParams) });
        }
        if (method === "POST") {
          const spec = await readJsonBody(req);
          if (!spec) return sendJson(res, 400, { error: "invalid JSON body" });
          const backend = spec.backendId
            ? getActiveBackend(registry, spec.backendId)
            : spec.agentId
              ? registry.route(spec.agentId)
              : null;
          if (!backend) return sendJson(res, 400, { error: "cannot resolve backend for create" });
          return sendJson(res, 200, { job: await backend.createCronJob(spec) });
        }
        return sendJson(res, 405, { error: "method not allowed" });
      }
      const id = segs[2];
      const backend = await resolveResourceBackend(registry, "cron", id);
      if (!backend) return sendJson(res, 404, { error: `no backend for cron id ${id}` });
      if (segs.length === 3) {
        if (method === "PUT") {
          const patch = await readJsonBody(req);
          if (!patch) return sendJson(res, 400, { error: "invalid JSON body" });
          return sendJson(res, 200, { job: await backend.updateCronJob(id, patch) });
        }
        if (method === "DELETE") {
          await backend.deleteCronJob(id);
          return sendJson(res, 200, { ok: true });
        }
        return sendJson(res, 405, { error: "method not allowed" });
      }
      if (segs.length === 4 && segs[3] === "run" && method === "POST") {
        const body = await readJsonBody(req);
        if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
        const job = await withWorkAdmission(
          workAdmissionGate,
          backend.id,
          "cron.run",
          () => backend.runCronJob(id, body.mode),
        );
        return sendJson(res, 200, { job });
      }
      if (segs.length === 4 && segs[3] === "runs" && method === "GET") {
        return sendJson(res, 200, await backend.getCronRuns(id, cronRunOptionsFromQuery(url.searchParams)));
      }
      if (segs.length === 4 && segs[3] === "delivery" && method === "GET") {
        const atRaw = url.searchParams.get("at");
        const at = atRaw != null ? Number(atRaw) : NaN;
        return sendJson(res, 200, await backend.getCronLatestDelivery(id, Number.isFinite(at) ? at : undefined));
      }
      if (segs.length === 4 && segs[3] === "trajectory" && method === "GET") {
        const sessionKey = url.searchParams.get("sessionKey") || undefined;
        const runId = url.searchParams.get("runId") || undefined;
        return sendJson(res, 200, await backend.getCronRunTrajectory(id, { sessionKey, runId }));
      }
    }
    if (segs[0] === "models" && segs.length === 1) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const params = new URL(req.url, "http://127.0.0.1").searchParams;
      const backendParam = params.get("backend");
      // 显式 backend 必须来自 active 集合；已断开与未知后端统一 404，且零 sources I/O。
      if (backendParam !== null && !getActiveBackend(registry, backendParam)) {
        return sendJson(res, 404, { error: `unknown backend ${backendParam}` });
      }
      const backendId = backendParam === null ? undefined : backendParam;
      const snapshot = await registry.listModelsSnapshot(backendId, { fresh: true });
      const knownRevision = params.get("knownRevision") || "";
      // knownRevision 只在 fresh 读取完成后压缩响应，不能成为跳过后端校验的缓存命中。
      if (/^[0-9a-f]{64}$/i.test(knownRevision)
        && knownRevision.toLowerCase() === snapshot.catalogRevision) {
        return sendJson(res, 200, {
          catalogRevision: snapshot.catalogRevision,
          unchanged: true,
        });
      }
      return sendJson(res, 200, {
        models: snapshot.models,
        catalogRevision: snapshot.catalogRevision,
        unchanged: false,
      });
    }
    if (segs[0] === "models" && segs[1] === "active" && segs.length === 2) {
      const url = new URL(req.url, "http://127.0.0.1");
      const backendId = url.searchParams.get("backend") || "openclaw";
      const backend = getActiveBackend(registry, backendId);
      if (!backend) return sendJson(res, 404, { error: `unknown backend ${backendId}` });
      if (method === "GET") {
        return sendJson(res, 200, await backend.getActiveModel());
      }
      if (method === "POST") {
        const body = await readJsonBody(req);
        if (!body || !body.modelId) return sendJson(res, 400, { error: "missing modelId" });
        return sendJson(res, 200, await backend.setActiveModel(body.modelId, {
          scope: body.scope,
          provider: body.provider,
        }));
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }
    if (segs[0] === "models" && segs[1] === "auxiliary" && segs.length === 2) {
      const url = new URL(req.url, "http://127.0.0.1");
      const backendId = url.searchParams.get("backend") || "hermes";
      const backend = getActiveBackend(registry, backendId);
      if (!backend) return sendJson(res, 404, { error: `unknown backend ${backendId}` });
      const profile = url.searchParams.get("profile") || undefined;
      if (method === "GET") {
        return sendJson(res, 200, await backend.getAuxiliaryModels({ profile }));
      }
      if (method === "POST") {
        // R286：写授权归后端自己（官方同款直写；不支持的后端契约默认抛错），
        // 不再挂 coordinator 条件写门。
        const body = await readJsonBody(req);
        if (!body || !body.task) return sendJson(res, 400, { error: "missing task" });
        return sendJson(res, 200, await backend.setAuxiliaryModel(body.task, body.provider, body.model, {
          profile: body.profile || profile,
        }));
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }
    // ---- 模型设置整合面（官方「模型」+「提供方」，R286）----
    //   GET  /__api/models/settings?backend=&profile=       聚合快照
    //   POST /__api/models/settings/main                    应用主模型（回 staleAux）
    //   POST /__api/models/settings/defaults                agent.reasoning_effort / service_tier
    //   POST /__api/models/settings/fallbacks               fallback_providers 链整体替换
    //   PUT  /__api/models/settings/moa                     MoA 配置整份保存
    //   GET  /__api/models/settings/recommended?provider=   激活后的推荐默认模型
    if (segs[0] === "models" && segs[1] === "settings" && (segs.length === 2 || segs.length === 3)) {
      const url = new URL(req.url, "http://127.0.0.1");
      const backendId = url.searchParams.get("backend") || "hermes";
      const backend = getActiveBackend(registry, backendId);
      if (!backend) return sendJson(res, 404, { error: `unknown backend ${backendId}` });
      const queryProfile = url.searchParams.get("profile") || undefined;
      if (segs.length === 2) {
        if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
        return sendJson(res, 200, await backend.getModelSettings({ profile: queryProfile }));
      }
      if (segs[2] === "recommended") {
        if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
        const provider = url.searchParams.get("provider") || "";
        if (!provider) return sendJson(res, 400, { error: "missing provider" });
        return sendJson(res, 200, await backend.getRecommendedDefaultModel(provider, { profile: queryProfile }));
      }
      if (segs[2] === "moa") {
        if (method !== "PUT") return sendJson(res, 405, { error: "method not allowed" });
        const body = await readJsonBody(req);
        if (!body || typeof body.config !== "object" || !body.config) {
          return sendJson(res, 400, { error: "missing config" });
        }
        return sendJson(res, 200, {
          config: await backend.saveMoaConfig(body.config, { profile: body.profile || queryProfile }),
        });
      }
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      const body = await readJsonBody(req);
      if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
      const profile = body.profile || queryProfile;
      if (segs[2] === "main") {
        if (!body.provider || !body.model) return sendJson(res, 400, { error: "missing provider/model" });
        return sendJson(res, 200, await backend.applyMainModel({
          profile,
          provider: body.provider,
          model: body.model,
        }));
      }
      if (segs[2] === "defaults") {
        return sendJson(res, 200, await backend.setModelDefaults({
          profile,
          reasoningEffort: body.reasoningEffort,
          serviceTier: body.serviceTier,
        }));
      }
      if (segs[2] === "fallbacks") {
        if (!Array.isArray(body.entries)) return sendJson(res, 400, { error: "missing entries" });
        return sendJson(res, 200, await backend.setFallbackModels(body.entries, { profile }));
      }
      return sendJson(res, 404, { error: "unknown settings action" });
    }
    // ---- 自定义端点（官方「提供方 → 自定义端点」，R286）----
    //   GET    /__api/models/endpoints?backend=&profile=    列表
    //   POST   /__api/models/endpoints                      新建/更新（body=端点字段）
    //   DELETE /__api/models/endpoints?id=                  删除（id 走 query，不进 path）
    //   POST   /__api/models/endpoints/validate             连通性校验（无副作用）
    //   POST   /__api/models/endpoints/activate             激活为主模型（body.id）
    if (segs[0] === "models" && segs[1] === "endpoints" && (segs.length === 2 || segs.length === 3)) {
      const url = new URL(req.url, "http://127.0.0.1");
      const backendId = url.searchParams.get("backend") || "hermes";
      const backend = getActiveBackend(registry, backendId);
      if (!backend) return sendJson(res, 404, { error: `unknown backend ${backendId}` });
      const queryProfile = url.searchParams.get("profile") || undefined;
      if (segs.length === 2) {
        if (method === "GET") {
          return sendJson(res, 200, await backend.listCustomEndpoints({
            profile: queryProfile,
            ...(url.searchParams.get("refreshAuth") === "false" ? { refreshAuth: false } : {}),
          }));
        }
        if (method === "POST") {
          const body = await readJsonBody(req);
          if (!body || !body.name || !body.baseUrl || !body.model) {
            return sendJson(res, 400, { error: "missing name/baseUrl/model" });
          }
          return sendJson(res, 200, await backend.saveCustomEndpoint(body, {
            profile: body.profile || queryProfile,
          }));
        }
        if (method === "DELETE") {
          const id = url.searchParams.get("id") || "";
          if (!id) return sendJson(res, 400, { error: "missing id" });
          return sendJson(res, 200, await backend.deleteCustomEndpoint(id, { profile: queryProfile }));
        }
        return sendJson(res, 405, { error: "method not allowed" });
      }
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      const body = await readJsonBody(req);
      if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
      const profile = body.profile || queryProfile;
      if (segs[2] === "validate") {
        if (!body.baseUrl) return sendJson(res, 400, { error: "missing baseUrl" });
        return sendJson(res, 200, await backend.validateCustomEndpoint(body, { profile }));
      }
      if (segs[2] === "activate") {
        if (!body.id) return sendJson(res, 400, { error: "missing id" });
        return sendJson(res, 200, await backend.activateCustomEndpoint(body.id, { profile }));
      }
      return sendJson(res, 404, { error: "unknown endpoints action" });
    }
    // 批量模型变更:草稿层一次性提交(N 个无凭证操作合并成一次网关配置写)
    if (segs[0] === "models" && segs[1] === "config" && segs[2] === "batch" && segs.length === 3) {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      const backendId = new URL(req.url, "http://127.0.0.1").searchParams.get("backend") || "";
      const coordinator = requireReadyCoordinator(modelChangeCoordinator);
      const body = await readJsonBody(req);
      if (!body || !Array.isArray(body.items)) return sendJson(res, 400, { error: "missing items" });
      return sendModelChangeResult(res, await coordinator.batchCompat(backendId, body.items, {
        operationId: typeof body.operationId === "string" && body.operationId ? body.operationId : undefined,
        confirmReferences: body.confirmReferences === true,
        force: body.force === true,
        preservePrimaryRefs: body.preservePrimaryRefs === true,
      }));
    }
    if (segs[0] === "models" && segs[1] === "config" && segs[2] === "capabilities" && segs.length === 3) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const backendId = new URL(req.url, "http://127.0.0.1").searchParams.get("backend") || "";
      // 能力端点是纯只读查询，不触发 coordinator、preview 或 journal。
      const backend = getActiveBackend(registry, backendId);
      if (!backend) return sendJson(res, 404, { error: `unknown backend ${backendId}` });
      const full = await backend.getModelChangeCapabilities();
      // config-only 降级能力附在同一响应里；backend 未实现或探测失败时静默省略。
      let configWrite = null;
      if (typeof backend.getModelConfigWriteCapabilities === "function") {
        try {
          configWrite = await backend.getModelConfigWriteCapabilities();
        } catch {
          configWrite = null;
        }
      }
      return sendJson(res, 200, configWrite ? { ...full, configWrite } : full);
    }
    if (segs[0] === "models" && segs[1] === "auth-profiles" && segs.length === 2) {
      const url = new URL(req.url, "http://127.0.0.1");
      const backendId = url.searchParams.get("backend") || "";
      const backend = getActiveBackend(registry, backendId);
      if (!backend) return sendJson(res, 404, { error: `unknown backend ${backendId}` });
      if (method === "GET") {
        if (typeof backend.listModelAuthProfiles !== "function") {
          return sendJson(res, 200, { supported: false, profiles: [] });
        }
        return sendJson(res, 200, await backend.listModelAuthProfiles());
      }
      if (method === "PUT") {
        if (typeof backend.setModelAuthProfileKey !== "function") {
          return sendJson(res, 409, { error: "auth profile edit not supported", code: "auth_unsupported" });
        }
        const body = await readJsonBody(req);
        if (!body?.provider || !body?.apiKey) return sendJson(res, 400, { error: "missing provider/apiKey" });
        return sendJson(res, 200, await backend.setModelAuthProfileKey(body.provider, body.apiKey));
      }
      if (method === "DELETE") {
        if (typeof backend.deleteModelAuthProfile !== "function") {
          return sendJson(res, 409, { error: "auth profile delete not supported", code: "auth_unsupported" });
        }
        const id = url.searchParams.get("id") || "";
        if (!id) return sendJson(res, 400, { error: "missing id" });
        return sendJson(res, 200, await backend.deleteModelAuthProfile(id));
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }
    if (segs[0] === "models" && segs[1] === "provider-directory" && segs.length === 2) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const backendId = new URL(req.url, "http://127.0.0.1").searchParams.get("backend") || "";
      const backend = getActiveBackend(registry, backendId);
      if (!backend) return sendJson(res, 404, { error: `unknown backend ${backendId}` });
      return sendJson(res, 200, await backend.getProviderDirectory());
    }
    if (segs[0] === "models" && segs[1] === "config" && segs[2] === "activate" && segs.length === 3) {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      requireReadyCoordinator(modelChangeCoordinator);
      const backendId = new URL(req.url, "http://127.0.0.1").searchParams.get("backend") || "";
      const backend = getActiveBackend(registry, backendId);
      if (!backend) return sendJson(res, 404, { error: `unknown backend ${backendId}` });
      if (typeof backend.activateModelConfig !== "function") {
        return sendJson(res, 409, { error: "activation not supported", code: "activation_unsupported" });
      }
      return sendJson(res, 200, await backend.activateModelConfig());
    }
    if (segs[0] === "models" && segs[1] === "config" && segs[2] === "pending" && segs.length === 3) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      if (!modelChangeCoordinator || typeof modelChangeCoordinator.listPending !== "function") {
        return sendJson(res, 200, { operations: [] });
      }
      const backendId = new URL(req.url, "http://127.0.0.1").searchParams.get("backend") || "";
      return sendJson(res, 200, { operations: modelChangeCoordinator.listPending(backendId) });
    }
    if (segs[0] === "models" && segs[1] === "config" && segs[2] === "preview" && segs.length === 3) {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      const coordinator = requireReadyCoordinator(modelChangeCoordinator);
      const backendId = new URL(req.url, "http://127.0.0.1").searchParams.get("backend") || "";
      const body = await readJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return sendJson(res, 400, { error: "invalid JSON body" });
      }
      return sendJson(res, 200, await coordinator.preview(backendId, body));
    }
    if (segs[0] === "models" && segs[1] === "config" && segs[2] === "model" && segs.length === 3) {
      if (method !== "PUT") return sendJson(res, 405, { error: "method not allowed" });
      const coordinator = requireReadyCoordinator(modelChangeCoordinator);
      const backendId = new URL(req.url, "http://127.0.0.1").searchParams.get("backend") || "";
      const body = await readJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return sendJson(res, 400, { error: "invalid JSON body" });
      }
      const { previewToken, operationId, ...safeInput } = body;
      if (typeof previewToken !== "string" || !previewToken || typeof operationId !== "string" || !operationId) {
        return sendJson(res, 400, { error: "missing previewToken/operationId" });
      }
      return sendModelChangeResult(
        res,
        await coordinator.apply(backendId, safeInput, { previewToken, operationId }),
      );
    }
    if (segs[0] === "models" && segs[1] === "config" && segs.length === 2) {
      const url = new URL(req.url, "http://127.0.0.1");
      const backendId = url.searchParams.get("backend") || "";
      if (method === "GET") {
        const backend = getActiveBackend(registry, backendId);
        if (!backend) return sendJson(res, 404, { error: `unknown backend ${backendId}` });
        return sendJson(res, 200, await backend.getModelConfig());
      }
      if (method === "POST") {
        const coordinator = requireReadyCoordinator(modelChangeCoordinator);
        const body = await readJsonBody(req);
        if (!body || !body.providerKey || !body.model || !body.model.id) {
          return sendJson(res, 400, { error: "missing providerKey/model.id" });
        }
        // 旧 POST 也支持显式幂等键；operationId 属于执行选项，不能混入模型 spec 摘要。
        const { operationId, ...safeInput } = body;
        return sendModelChangeResult(res, await coordinator.applyCompat(backendId, safeInput, {
          operationId: typeof operationId === "string" && operationId ? operationId : undefined,
        }));
      }
      if (method === "PUT") {
        const coordinator = requireReadyCoordinator(modelChangeCoordinator);
        const body = await readJsonBody(req);
        if (!body || !body.providerKey) return sendJson(res, 400, { error: "missing providerKey" });
        return sendModelChangeResult(res, await coordinator.updateProviderCompat(backendId, body.providerKey, {
          baseUrl: body.baseUrl,
          apiKey: body.apiKey,
          api: body.api,
          clearBaseUrl: body.clearBaseUrl === true,
          clearApiKey: body.clearApiKey === true,
          ...(typeof body.renameTo === "string" && body.renameTo ? { renameTo: body.renameTo } : {}),
        }, {
          operationId: body.operationId,
        }));
      }
      if (method === "DELETE") {
        const coordinator = requireReadyCoordinator(modelChangeCoordinator);
        const provider = url.searchParams.get("provider") || "";
        const id = url.searchParams.get("id") || "";
        const operationId = url.searchParams.get("operationId") || undefined;
        // force=1 = 用户已在确认框知情引用将失效；跳过 references_exist 拦截照删。
        const force = url.searchParams.get("force") === "1";
        if (!provider) return sendJson(res, 400, { error: "missing provider" });
        // 带 id 删单个模型；不带 id 删整个 provider
        return sendModelChangeResult(res, await coordinator.deleteCompat(backendId, {
          providerKey: provider,
          ...(id ? { modelId: id } : {}),
        }, { operationId, force }));
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }
    // provider 凭证池（Hermes credential_pool）：GET 列出，DELETE 删一条（index 1-based）
    if (segs[0] === "models" && segs[1] === "credentials" && segs.length === 2) {
      const url = new URL(req.url, "http://127.0.0.1");
      const backend = getActiveBackend(registry, url.searchParams.get("backend") || "");
      if (!backend) return sendJson(res, 404, { error: "unknown backend" });
      const provider = url.searchParams.get("provider") || "";
      if (!provider) return sendJson(res, 400, { error: "missing provider" });
      if (method === "GET") {
        return sendJson(res, 200, { entries: await backend.listProviderCredentials(provider) });
      }
      if (method === "DELETE") {
        const index = Number(url.searchParams.get("index"));
        if (!Number.isInteger(index) || index < 1) return sendJson(res, 400, { error: "missing index" });
        return sendJson(res, 200, await backend.removeProviderCredential(provider, index));
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }
    if (segs[0] === "models" && segs[1] === "config" && segs[2] === "reveal" && segs.length === 3) {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      // loopback 不等于权限边界：同一用户下任何进程都能 curl 本端口。明文只允许
      // 当前 BrowserWindow 的 preload 经受信 IPC 读取，HTTP 面永远不触发 backend。
      return sendJson(res, 403, {
        error: "Desktop bridge required",
        code: "DESKTOP_BRIDGE_REQUIRED",
      });
    }
    if (segs[0] === "env" && segs.length === 1) {
      const url = new URL(req.url, "http://127.0.0.1");
      const backend = getActiveBackend(registry, url.searchParams.get("backend") || "hermes");
      if (!backend) return sendJson(res, 404, { error: "unknown backend" });
      if (method === "GET") return sendJson(res, 200, { vars: await backend.listEnvVars() });
      const body = await readJsonBody(req);
      if (!body || !body.key) return sendJson(res, 400, { error: "missing key" });
      if (method === "PUT") return sendJson(res, 200, await backend.setEnvVar(body.key, body.value));
      if (method === "DELETE") return sendJson(res, 200, await backend.deleteEnvVar(body.key));
      return sendJson(res, 405, { error: "method not allowed" });
    }
    if (segs[0] === "env" && (segs[1] === "reveal" || segs[1] === "validate") && segs.length === 2) {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      if (segs[1] === "reveal") {
        return sendJson(res, 403, {
          error: "Desktop bridge required",
          code: "DESKTOP_BRIDGE_REQUIRED",
        });
      }
      const url = new URL(req.url, "http://127.0.0.1");
      const backend = getActiveBackend(registry, url.searchParams.get("backend") || "hermes");
      if (!backend) return sendJson(res, 404, { error: "unknown backend" });
      const body = await readJsonBody(req);
      if (!body || !body.key) return sendJson(res, 400, { error: "missing key" });
      return sendJson(res, 200, await backend.validateProviderCredential(body.key, body.value));
    }
    // OAuth provider 登录：列表是 GET，其余五个动作统一 POST + JSON body
    // （provider id / session id 不进 path 段，同 task/cron id 的规矩）。
    if (segs[0] === "oauth" && (segs.length === 1 || segs.length === 2)) {
      const url = new URL(req.url, "http://127.0.0.1");
      const backend = getActiveBackend(registry, url.searchParams.get("backend") || "hermes");
      if (!backend) return sendJson(res, 404, { error: "unknown backend" });
      if (segs.length === 1) {
        if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
        const backendId = url.searchParams.get("backend") || "hermes";
        return sendJson(res, 200, rememberOAuthCommands(backendId, await backend.listOAuthProviders()));
      }
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      const body = (await readJsonBody(req)) || {};
      const profile = body.profile || undefined;
      if (segs[1] === "cancel") {
        if (!body.sessionId) return sendJson(res, 400, { error: "missing sessionId" });
        return sendJson(res, 200, await backend.cancelOAuthSession(body.sessionId, profile));
      }
      if (!body.provider) return sendJson(res, 400, { error: "missing provider" });
      if (segs[1] === "disconnect") {
        return sendJson(res, 200, await backend.disconnectOAuthProvider(body.provider, profile));
      }
      if (segs[1] === "start") {
        return sendJson(res, 200, await backend.startOAuthLogin(body.provider, profile));
      }
      if (!body.sessionId) return sendJson(res, 400, { error: "missing sessionId" });
      if (segs[1] === "submit") {
        if (!body.code) return sendJson(res, 400, { error: "missing code" });
        return sendJson(res, 200, await backend.submitOAuthCode(body.provider, body.sessionId, body.code, profile));
      }
      if (segs[1] === "poll") {
        return sendJson(res, 200, await backend.pollOAuthSession(body.provider, body.sessionId, profile));
      }
      return sendJson(res, 404, { error: "unknown oauth action" });
    }
    if (segs[0] === "usage" && (segs.length === 1 || (segs.length === 2 && segs[1] === "breakdown"))) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const url = new URL(req.url, "http://127.0.0.1");
      const backendId = url.searchParams.get("backend") || "openclaw";
      const range = url.searchParams.get("range") || undefined;
      if (segs.length === 2) {
        return sendJson(res, 200, {
          breakdown: await registry.getUsageBreakdown(backendId, range || "all"),
        });
      }
      return sendJson(res, 200, { series: await registry.getUsageSeries(backendId, range || "all") });
    }
    // Per-backend aggregate: which skills have agents actually loaded. Same
    // merge/fail-soft shape as GET /__api/cli/usage; the page joins it against
    // GET /__api/skills. Must precede the `segs.length === 1` skills route.
    if (segs[0] === "skills" && segs[1] === "usage" && segs.length === 2) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      return sendJson(res, 200, { backends: await registry.listSkillUsage() });
    }
    if (segs[0] === "skills" && segs[1] === "preview" && segs.length === 2) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const url = new URL(req.url, "http://127.0.0.1");
      const backendId = url.searchParams.get("backend") || "shoggoth";
      const name = url.searchParams.get("name");
      if (!name) return sendJson(res, 400, { error: "missing ?name=" });
      const backend = getActiveBackend(registry, backendId);
      if (!backend) return sendJson(res, 400, { error: `unknown backend ${backendId}` });
      const agentId = url.searchParams.get("agentId") || undefined;
      if (hasAgentScopedSkills(backend) && !agentId) {
        return sendJson(res, 400, { error: "missing agentId", code: "SKILL_AGENT_ID_REQUIRED" });
      }
      return sendJson(res, 200, { preview: await backend.previewSkill(name, {
        agentId,
        id: url.searchParams.get("id") || undefined,
        source: url.searchParams.get("source") || undefined,
        version: url.searchParams.get("version") || undefined,
      }) });
    }
    if (segs[0] === "skills" && segs[1] === "install" && segs.length === 2) {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      const body = (await readJsonBody(req)) || {};
      const backendId = body.backend || "shoggoth";
      const backend = getActiveBackend(registry, backendId);
      if (!backend) return sendJson(res, 400, { error: `unknown backend ${backendId}` });
      const agentId = body.agentId || undefined;
      if (hasAgentScopedSkills(backend) && !agentId) {
        return sendJson(res, 400, { error: "missing agentId", code: "SKILL_AGENT_ID_REQUIRED" });
      }
      if (!hostOps || typeof hostOps.selectSkillPackage !== "function") {
        return sendJson(res, 501, { error: "Skill package picker unavailable" });
      }
      const selected = await hostOps.selectSkillPackage();
      if (!selected) return sendJson(res, 200, { canceled: true });
      const result = await backend.installSkill(selected, {
        agentId,
        operationId: body.operationId || undefined,
        expectedRevision: body.expectedRevision || undefined,
      });
      return sendJson(res, 200, { canceled: false, result });
    }
    if (segs[0] === "skills" && segs.length === 1) {
      const url = new URL(req.url, "http://127.0.0.1");
      const backendId = url.searchParams.get("backend") || "openclaw";
      if (method === "GET") {
        const backend = getActiveBackend(registry, backendId);
        const agentId = url.searchParams.get("agentId") || undefined;
        if (hasAgentScopedSkills(backend) && !agentId) {
          return sendJson(res, 400, { error: "missing agentId", code: "SKILL_AGENT_ID_REQUIRED" });
        }
        return sendJson(res, 200, { skills: await registry.listSkills(backendId, {
          agentId,
        }) });
      }
      // PUT /__api/skills?backend=&name=  body { enabled?, apiKey?, env? }
      if (method === "PUT") {
        const name = url.searchParams.get("name");
        if (!name) return sendJson(res, 400, { error: "missing ?name=" });
        const backend = getActiveBackend(registry, backendId);
        if (!backend) return sendJson(res, 400, { error: `unknown backend ${backendId}` });
        const body = await readJsonBody(req);
        if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
        const agentId = url.searchParams.get("agentId") || undefined;
        if (hasAgentScopedSkills(backend) && !agentId) {
          return sendJson(res, 400, { error: "missing agentId", code: "SKILL_AGENT_ID_REQUIRED" });
        }
        return sendJson(res, 200, { skill: await backend.updateSkill(name, body, {
          agentId,
        }) });
      }
      if (method === "DELETE") {
        const name = url.searchParams.get("name");
        if (!name) return sendJson(res, 400, { error: "missing ?name=" });
        const backend = getActiveBackend(registry, backendId);
        if (!backend) return sendJson(res, 400, { error: `unknown backend ${backendId}` });
        const agentId = url.searchParams.get("agentId") || undefined;
        if (hasAgentScopedSkills(backend) && !agentId) {
          return sendJson(res, 400, { error: "missing agentId", code: "SKILL_AGENT_ID_REQUIRED" });
        }
        return sendJson(res, 200, { result: await backend.uninstallSkill(name, {
          agentId,
          id: url.searchParams.get("id") || undefined,
          source: url.searchParams.get("source") || undefined,
          version: url.searchParams.get("version") || undefined,
          expectedRevision: Number(url.searchParams.get("expectedRevision")) || undefined,
        }) });
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }
    if (segs[0] === "tasks" && segs[1] === "federated") {
      if (segs.length === 2 && method === "GET") {
        const url = new URL(req.url, "http://127.0.0.1");
        return sendJson(res, 200, {
          board: await registry.getFederatedKanban({
            project: url.searchParams.get("project") || "default",
          }),
        });
      }
      if (segs.length === 2 && method === "POST") {
        const body = await readJsonBody(req);
        if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
        const task = await registry.createFederatedTask(body.project, body.agentKey, body.task);
        return sendJson(res, 200, { task });
      }
      if (segs.length === 3 && segs[2] === "move" && method === "POST") {
        const body = await readJsonBody(req);
        if (!body?.task || !body?.status) return sendJson(res, 400, { error: "task and status required" });
        const result = await registry.moveFederatedTask(
          body.task,
          body.status,
          body.position,
          body.completion,
        );
        return sendJson(res, 200, { result });
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }
    if (segs[0] === "tasks" && segs[1] === "projects") {
      if (segs.length === 2 && method === "POST") {
        const body = await readJsonBody(req);
        if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
        return sendJson(res, 200, { project: registry.createFederatedKanbanProject(body) });
      }
      if (segs.length === 3 && method === "DELETE") {
        return sendJson(res, 200, { result: await registry.deleteFederatedKanbanProject(segs[2]) });
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }
    if (segs[0] === "tasks" && segs[1] === "orchestration" && segs.length === 2) {
      const url = new URL(req.url, "http://127.0.0.1");
      const backendId = url.searchParams.get("backend") || "openclaw";
      const backend = getActiveBackend(registry, backendId);
      if (!backend) return sendJson(res, 400, { error: `unknown backend ${backendId}` });
      if (method === "GET") return sendJson(res, 200, { orchestration: await backend.getOrchestration() });
      if (method === "PUT") {
        const body = await readJsonBody(req);
        if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
        return sendJson(res, 200, { orchestration: await backend.setOrchestration(body) });
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }
    if (segs[0] === "tasks" && segs[1] === "boards") {
      // Hermes multi-board: GET list / POST create at .../boards;
      // POST .../boards/:slug/switch; DELETE .../boards/:slug.
      const url = new URL(req.url, "http://127.0.0.1");
      const backendId = url.searchParams.get("backend") || "openclaw";
      const backend = getActiveBackend(registry, backendId);
      if (!backend) return sendJson(res, 400, { error: `unknown backend ${backendId}` });
      if (segs.length === 2 && method === "GET") {
        return sendJson(res, 200, { boards: await backend.getBoards() });
      }
      if (segs.length === 2 && method === "POST") {
        const body = await readJsonBody(req);
        if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
        return sendJson(res, 200, { board: await backend.createBoard(body) });
      }
      if (segs.length === 4 && segs[3] === "switch" && method === "POST") {
        return sendJson(res, 200, { ok: true, result: await backend.switchBoard(segs[2]) });
      }
      if (segs.length === 3 && method === "PATCH") {
        const body = await readJsonBody(req);
        if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
        return sendJson(res, 200, { ok: true, result: await backend.updateBoard(segs[2], body) });
      }
      if (segs.length === 3 && method === "DELETE") {
        return sendJson(res, 200, { ok: true, result: await backend.deleteBoard(segs[2], url.searchParams.get("hard") === "1") });
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }
    // 看板前端偏好（默认租户/分泳道/显示归档/渲染 markdown）。
    if (segs[0] === "tasks" && segs[1] === "config" && segs.length === 2) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const url = new URL(req.url, "http://127.0.0.1");
      const backend = getActiveBackend(registry, url.searchParams.get("backend") || "openclaw");
      if (!backend) return sendJson(res, 400, { error: "unknown backend" });
      return sendJson(res, 200, { config: await backend.getTaskBoardConfig() });
    }
    // 任务级模型覆盖的候选目录（provider → models）。
    if (segs[0] === "tasks" && segs[1] === "model-options" && segs.length === 2) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const url = new URL(req.url, "http://127.0.0.1");
      const backend = getActiveBackend(registry, url.searchParams.get("backend") || "openclaw");
      if (!backend) return sendJson(res, 400, { error: "unknown backend" });
      return sendJson(res, 200, { options: await backend.getTaskModelOptions() });
    }
    // 编排 profile 名单 + 描述编辑 + ⚗ 自动生成。
    if (segs[0] === "tasks" && segs[1] === "profiles") {
      const url = new URL(req.url, "http://127.0.0.1");
      const backend = getActiveBackend(registry, url.searchParams.get("backend") || "openclaw");
      if (!backend) return sendJson(res, 400, { error: "unknown backend" });
      if (segs.length === 2 && method === "GET") {
        return sendJson(res, 200, { profiles: await backend.getBoardProfiles() });
      }
      if (segs.length === 3 && method === "PATCH") {
        const body = (await readJsonBody(req)) || {};
        return sendJson(res, 200, { result: await backend.updateBoardProfile(segs[2], body) });
      }
      if (segs.length === 4 && segs[3] === "describe-auto" && method === "POST") {
        const body = (await readJsonBody(req)) || {};
        return sendJson(res, 200, { result: await backend.describeBoardProfileAuto(segs[2], body.overwrite) });
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }
    // 附件：列表 / 上传（原始字节 + ?filename=）/ 下载（二进制直吐）/ 删除。
    // 上传不走 readJsonBody——浏览器直接 PUT 文件字节，服务端再组 multipart 给上游，
    // 省掉本地解析 multipart 这一层。
    if (segs[0] === "tasks" && segs[1] === "attachments") {
      const url = new URL(req.url, "http://127.0.0.1");
      const backend = getActiveBackend(registry, url.searchParams.get("backend") || "openclaw");
      if (!backend) return sendJson(res, 400, { error: "unknown backend" });
      const board = url.searchParams.get("board") || undefined;
      const bOpts = board ? { board } : undefined;
      const id = url.searchParams.get("id");
      if (segs.length === 2 && method === "GET") {
        if (!id) return sendJson(res, 400, { error: "missing ?id=" });
        return sendJson(res, 200, { attachments: await backend.listTaskAttachments(id, bOpts) });
      }
      if (segs.length === 2 && method === "POST") {
        if (!id) return sendJson(res, 400, { error: "missing ?id=" });
        const filename = url.searchParams.get("filename") || "attachment";
        const contentType = url.searchParams.get("contentType") || "application/octet-stream";
        let data;
        try {
          data = await readRawBody(req, MAX_ATTACHMENT_BYTES);
        } catch (err) {
          if (err?.code === "BODY_TOO_LARGE") return sendJson(res, 413, { error: "attachment too large" });
          throw err;
        }
        const attachment = await backend.addTaskAttachment(id, { filename, contentType, data }, bOpts);
        return sendJson(res, 200, { attachment });
      }
      if (segs.length === 3 && method === "GET") {
        const file = await backend.readTaskAttachment(segs[2], bOpts);
        res.writeHead(200, {
          "Content-Type": file.contentType || "application/octet-stream",
          "Content-Length": file.data.length,
          // 一律当附件下载：内容是用户上传的任意文件，绝不能在同源页面里内联渲染。
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
          "X-Content-Type-Options": "nosniff",
        });
        return res.end(file.data);
      }
      if (segs.length === 3 && method === "DELETE") {
        return sendJson(res, 200, { result: await backend.deleteTaskAttachment(segs[2], bOpts) });
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }
    // 每任务的 home 频道通知订阅开关。
    if (segs[0] === "tasks" && segs[1] === "home-channels" && segs.length === 2) {
      const url = new URL(req.url, "http://127.0.0.1");
      const backend = getActiveBackend(registry, url.searchParams.get("backend") || "openclaw");
      if (!backend) return sendJson(res, 400, { error: "unknown backend" });
      const board = url.searchParams.get("board") || undefined;
      const bOpts = board ? { board } : undefined;
      const id = url.searchParams.get("id");
      if (!id) return sendJson(res, 400, { error: "missing ?id=" });
      if (method === "GET") {
        return sendJson(res, 200, { channels: await backend.getTaskHomeChannels(id, bOpts) });
      }
      if (method === "POST" || method === "DELETE") {
        const platform = url.searchParams.get("platform");
        if (!platform) return sendJson(res, 400, { error: "missing ?platform=" });
        return sendJson(res, 200, {
          result: await backend.setTaskHomeSubscription(id, platform, method === "POST", bOpts),
        });
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }
    if (segs[0] === "tasks" && segs.length === 1) {
      // Item ops use ?backend=&id= (OpenClaw task ids contain "/", so they can't
      // be a path segment). No id on GET → return the whole board.
      const url = new URL(req.url, "http://127.0.0.1");
      const backendId = url.searchParams.get("backend") || "openclaw";
      const id = url.searchParams.get("id");
      const action = url.searchParams.get("action");
      // Hermes 多板：?board= 贯穿全部 item 操作（KAN-005/006）；缺省 = current 板。
      const board = url.searchParams.get("board") || undefined;
      const bOpts = board ? { board } : undefined;
      if (method === "GET") {
        if (id && action === "log") {
          const backend = getActiveBackend(registry, backendId);
          if (!backend) return sendJson(res, 404, { error: `unknown backend ${backendId}` });
          return sendJson(res, 200, { log: await backend.getTaskLog(id, bOpts) });
        }
        if (!id && action === "diagnostics") {
          const backend = getActiveBackend(registry, backendId);
          if (!backend) return sendJson(res, 404, { error: `unknown backend ${backendId}` });
          const severity = url.searchParams.get("severity") || undefined;
          return sendJson(res, 200, { diagnostics: await backend.getTaskDiagnostics({ board, severity }) });
        }
        if (id) {
          const backend = getActiveBackend(registry, backendId);
          if (!backend) return sendJson(res, 404, { error: `unknown backend ${backendId}` });
          return sendJson(res, 200, { task: await backend.getTask(id, bOpts) });
        }
        return sendJson(res, 200, { board: await registry.getTaskBoard(backendId, {
          includeArchived: url.searchParams.get("archived") === "1",
          board,
          // Workboard manual refresh recomputes diagnostics first (official behavior).
          refreshDiagnostics: url.searchParams.get("refreshDiagnostics") === "1",
          // Legacy client hint retained for compatibility; 8.1 board reads are
          // always pure projections and never perform lifecycle write-back.
          readOnly: url.searchParams.get("readOnly") === "1",
        }) });
      }
      const backend = getActiveBackend(registry, backendId);
      if (!backend) return sendJson(res, 400, { error: `unknown backend ${backendId}` });
      if (method === "POST") {
        // Task-level actions on an existing task (Hermes kanban).
        if (id && action) {
          if (action === "comment") {
            const body = await readJsonBody(req);
            if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
            return sendJson(res, 200, { result: await backend.addTaskComment(id, body.body, body.author, bOpts) });
          }
          if (action === "move") {
            const body = await readJsonBody(req);
            if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
            // 移到 done 时带完成摘要（result/summary）一起过去，和官方一次 PATCH 同形。
            const moveOpts = { ...(bOpts || {}) };
            if (typeof body.result === "string") moveOpts.result = body.result;
            if (typeof body.summary === "string") moveOpts.summary = body.summary;
            return sendJson(res, 200, { task: await backend.moveTask(id, body.status, body.position, moveOpts) });
          }
          if (action === "archive") {
            const body = (await readJsonBody(req)) || {};
            await backend.archiveTask(id, body.archived !== false, bOpts);
            return sendJson(res, 200, { ok: true });
          }
          if (action === "run") {
            const body = (await readJsonBody(req)) || {};
            const result = await withWorkAdmission(
              workAdmissionGate,
              backendId,
              "task.run",
              () => backend.runTaskCard(id, body),
            );
            return sendJson(res, 200, { result });
          }
          if (action === "link" || action === "unlink") {
            const body = (await readJsonBody(req)) || {};
            const fn = action === "link" ? "addTaskLink" : "removeTaskLink";
            return sendJson(res, 200, { result: await backend[fn](body.parent, body.child, bOpts) });
          }
          if (action === "reassign") {
            const body = (await readJsonBody(req)) || {};
            return sendJson(res, 200, { result: await backend.reassignTask(id, body.assignee, body.reclaim, bOpts) });
          }
          if (action === "reclaim") {
            return sendJson(res, 200, { result: await backend.reclaimTask(id, bOpts) });
          }
          return sendJson(res, 200, { result: await backend.taskAction(id, action, bOpts) }); // specify|decompose|unblock
        }
        // Board-level action (no id): Nudge dispatcher.
        if (action === "dispatch") {
          const body = (await readJsonBody(req)) || {};
          const result = await withWorkAdmission(
            workAdmissionGate,
            backendId,
            "task.dispatch",
            () => backend.nudgeDispatcher(body),
          );
          return sendJson(res, 200, { result });
        }
        if (action === "bulk") {
          const body = (await readJsonBody(req)) || {};
          return sendJson(res, 200, { result: await backend.bulkUpdateTasks(body.ids, body.patch, bOpts) });
        }
        if (action === "bulkDelete") {
          const body = (await readJsonBody(req)) || {};
          return sendJson(res, 200, { result: await backend.bulkDeleteTasks(body.ids, bOpts) });
        }
        const spec = await readJsonBody(req);
        if (!spec) return sendJson(res, 400, { error: "invalid JSON body" });
        return sendJson(res, 200, { task: await backend.createTask(spec, bOpts) });
      }
      if (method === "PUT") {
        if (!id) return sendJson(res, 400, { error: "missing ?id=" });
        const patch = await readJsonBody(req);
        if (!patch) return sendJson(res, 400, { error: "invalid JSON body" });
        return sendJson(res, 200, { task: await backend.updateTask(id, patch, bOpts) });
      }
      if (method === "DELETE") {
        if (!id) return sendJson(res, 400, { error: "missing ?id=" });
        await backend.deleteTask(id, bOpts);
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }
    if (segs[0] === "cli" && segs.length === 1) {
      // Host-level: the loopback server runs on the OpenClaw machine, so scan
      // its $PATH directly (no backend involved). Versions omitted (slow).
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const tools = await scanInstalledClis();
      cliExecutionGate?.remember(tools);
      return sendJson(res, 200, { tools, categories: CLI_CATEGORIES });
    }
    // Lazy per-tool reference info (version + whatis summary + --help), fetched
    // when the detail drawer opens. Runs the binary, so validate the path first.
    if (segs[0] === "cli" && segs[1] === "info" && segs.length === 2) {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      const body = await readJsonBody(req);
      const toolPath = typeof body?.path === "string" ? body.path : "";
      if (!path.isAbsolute(toolPath)) return sendJson(res, 400, { error: "path must be absolute" });
      const tool = cliExecutionGate?.resolve(toolPath);
      if (!tool) return sendJson(res, 403, { error: "CLI path not in latest scan" });
      const release = cliExecutionGate.acquire();
      if (!release) return sendJson(res, 429, { error: "too many CLI executions" });
      try {
        return sendJson(res, 200, await resolveCliInfo(tool.name, tool.path));
      } finally {
        release();
      }
    }
    // Lazy version resolution (on drawer open) — runs `<tool> --version` etc.
    if (segs[0] === "cli" && segs[1] === "version" && segs.length === 2) {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      const body = await readJsonBody(req);
      const toolPath = typeof body?.path === "string" ? body.path : "";
      if (!toolPath) return sendJson(res, 400, { error: "missing path" });
      const tool = cliExecutionGate?.resolve(toolPath);
      if (!tool) return sendJson(res, 403, { error: "CLI path not in latest scan" });
      const release = cliExecutionGate.acquire();
      if (!release) return sendJson(res, 429, { error: "too many CLI executions" });
      try {
        return sendJson(res, 200, { version: await resolveCliVersion(tool.path) });
      } finally {
        release();
      }
    }
    // Reveal the binary in the OS file manager (Electron host only).
    if (segs[0] === "cli" && segs[1] === "reveal" && segs.length === 2) {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      const body = await readJsonBody(req);
      if (!body || !body.path) return sendJson(res, 400, { error: "missing path" });
      if (!hostOps || typeof hostOps.reveal !== "function") {
        return sendJson(res, 501, { error: "reveal unavailable (non-Electron host)" });
      }
      return sendJson(res, 200, { ok: hostOps.reveal(body.path) !== false });
    }
    if (segs[0] === "host" && segs[1] === "open-attachment" && segs.length === 2) {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      const name = requestUrl?.searchParams.get("name");
      if (!validAttachmentName(name)) return sendJson(res, 400, { error: "invalid attachment name" });
      if (!attachmentOpener) return sendJson(res, 501, { error: "openPath unavailable (non-Electron host)" });
      const bytes = await readRawBody(req, MAX_OPEN_ATTACHMENT_BYTES);
      const failure = await attachmentOpener.open(name, bytes);
      if (failure) return sendJson(res, 500, { ok: false, error: failure });
      return sendJson(res, 200, { ok: true });
    }
    // Open a folder/file with the OS default handler (Electron host only) — the
    // agent 页 workspace row. Host-side capability like /cli/reveal, never the registry.
    if (segs[0] === "host" && segs[1] === "open-path" && segs.length === 2) {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      const body = await readJsonBody(req);
      if (!body || !body.path) return sendJson(res, 400, { error: "missing path" });
      if (!hostOps || typeof hostOps.openPath !== "function") {
        return sendJson(res, 501, { error: "openPath unavailable (non-Electron host)" });
      }
      // shell.openPath resolves to "" on success, else the OS error message.
      const failure = await hostOps.openPath(body.path);
      if (failure) return sendJson(res, 500, { ok: false, error: failure });
      return sendJson(res, 200, { ok: true });
    }
    // Reveal a file in the OS file manager without opening it. This is the
    // generic host route used by chat artifacts; /cli/reveal remains for the
    // existing CLI page contract.
    if (segs[0] === "host" && segs[1] === "reveal-path" && segs.length === 2) {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      const body = await readJsonBody(req);
      if (!body || !isBoundedApiString(body.path, 4096)) {
        return sendJson(res, 400, { error: "missing or invalid path" });
      }
      if (!hostOps || typeof hostOps.reveal !== "function") {
        return sendJson(res, 501, { error: "reveal unavailable (non-Electron host)" });
      }
      const ok = hostOps.reveal(body.path) !== false;
      return sendJson(res, ok ? 200 : 500, { ok });
    }
    // 在系统终端里跑 external provider 的登录/断开命令（官方桌面版用内置终端，
    // 我们没有）。**故意不接受命令串**：只收 {provider,kind}，真实命令从 oauth
    // 目录里查——否则这就是一个本机任意进程可达的命令执行口子。
    if (segs[0] === "host" && segs[1] === "terminal" && segs.length === 2) {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      const body = (await readJsonBody(req)) || {};
      const kind = body.kind === "disconnect" ? "disconnect" : "cli";
      const backendId = body.backend || "hermes";
      if (!body.provider) return sendJson(res, 400, { error: "missing provider" });
      const cacheKey = `${backendId}:${body.provider}`;
      if (!oauthCommands.has(cacheKey)) {
        // 冷启动/进程重启后表是空的：现拉一次目录再查（慢，但只走这一次）。
        const backend = getActiveBackend(registry, backendId);
        if (backend) {
          await backend
            .listOAuthProviders()
            .then((snap) => rememberOAuthCommands(backendId, snap))
            .catch(() => {});
        }
      }
      const command = oauthCommands.get(cacheKey)?.[kind] || "";
      if (!command) return sendJson(res, 400, { error: `no ${kind} command for ${body.provider}` });
      if (!hostOps || typeof hostOps.runInTerminal !== "function") {
        return sendJson(res, 501, { error: "runInTerminal unavailable (non-Electron host)", command });
      }
      const err = await hostOps.runInTerminal(command);
      if (err) return sendJson(res, 500, { ok: false, command, error: err });
      return sendJson(res, 200, { ok: true, command });
    }
    // Per-backend aggregate: which host CLI commands have agents actually run
    // (bash/exec tool calls). registry merges all backends; a backend without
    // on-disk command transcripts contributes { supported:false }. Front-end
    // joins this against the $PATH scan from GET /__api/cli.
    if (segs[0] === "cli" && segs[1] === "usage" && segs.length === 2) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      return sendJson(res, 200, { backends: await registry.listCliUsage() });
    }
    if (segs[0] === "agents") {
      const url = new URL(req.url, "http://127.0.0.1");
      const backendId = url.searchParams.get("backend") || "openclaw";
      const backend = getActiveBackend(registry, backendId);
      // collection: list + create
      if (segs.length === 1) {
        if (method === "GET") {
          return sendJson(res, 200, { agents: await registry.listAgents(backendId, {
            lifecycle: url.searchParams.get("lifecycle") || "active",
          }) });
        }
        if (method === "POST") {
          if (!backend) return sendJson(res, 400, { error: `unknown backend ${backendId}` });
          const spec = await readJsonBody(req);
          if (!spec) return sendJson(res, 400, { error: "invalid JSON body" });
          return sendJson(res, 200, { result: await backend.createAgent(spec) });
        }
        return sendJson(res, 405, { error: "method not allowed" });
      }
      if (!backend) return sendJson(res, 400, { error: `unknown backend ${backendId}` });
      const id = segs[1]; // agent ids are [a-z0-9-]; safe as a path segment
      // item: detail / update / delete
      if (segs.length === 2) {
        if (method === "GET") return sendJson(res, 200, { agent: await backend.getAgent(id) });
        if (method === "PUT") {
          const patch = await readJsonBody(req);
          if (!patch) return sendJson(res, 400, { error: "invalid JSON body" });
          return sendJson(res, 200, { result: await backend.updateAgent(id, patch) });
        }
        if (method === "DELETE") {
          const expectedUpdatedAtValue = url.searchParams.get("expectedUpdatedAt");
          const createdAtValue = url.searchParams.get("createdAt");
          await backend.deleteAgent(id, {
            operationId: url.searchParams.get("operationId") || undefined,
            expectedUpdatedAt: expectedUpdatedAtValue === null
              ? undefined : Number(expectedUpdatedAtValue),
            createdAt: createdAtValue === null ? undefined : Number(createdAtValue),
          });
          return sendJson(res, 200, { ok: true });
        }
        return sendJson(res, 405, { error: "method not allowed" });
      }
      if (segs.length === 3 && segs[2] === "restore") {
        if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        const body = await readJsonBody(req);
        if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
        return sendJson(res, 200, { result: await backend.restoreAgent(id, body) });
      }
      // file: get / set (file name in ?file=)
      if (segs.length === 3 && segs[2] === "file") {
        const file = url.searchParams.get("file");
        if (!file) return sendJson(res, 400, { error: "missing ?file=" });
        if (method === "GET") return sendJson(res, 200, { file: await backend.getAgentFile(id, file) });
        if (method === "PUT") {
          const body = await readJsonBody(req);
          if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
          return sendJson(res, 200, { result: await backend.setAgentFile(id, file, body.content || "", {
            expectedRevision: body.expectedRevision,
            reason: body.reason,
          }) });
        }
        return sendJson(res, 405, { error: "method not allowed" });
      }
      // Persistent Agent Harness controls. Unsupported backends answer through
      // AgentBackend defaults; static-server never branches on backend id.
      if (segs.length === 3 && segs[2] === "definition") {
        if (method === "GET") {
          const format = url.searchParams.get("format");
          return sendJson(res, 200, format === "export"
            ? { definition: await backend.exportAgentDefinition(id) }
            : { definition: await backend.getAgentDefinition(id) });
        }
        if (method === "POST") {
          const body = await readJsonBody(req);
          if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
          if (body.action === "restore") {
            return sendJson(res, 200, { result: await backend.restoreAgentDefinition(
              id, body.revision, body.expectedRevision,
            ) });
          }
          if (body.action === "import") {
            return sendJson(res, 200, { result: await backend.importAgentDefinition(
              id, body.bundle, body.expectedRevision,
            ) });
          }
          return sendJson(res, 400, { error: "unknown definition action" });
        }
        return sendJson(res, 405, { error: "method not allowed" });
      }
      if (segs.length === 3 && segs[2] === "memories") {
        if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
        return sendJson(res, 200, { memories: await backend.listAgentMemories(id, {
          status: url.searchParams.get("status") || undefined,
          scope: url.searchParams.get("scope") || undefined,
          cursor: Number(url.searchParams.get("cursor")) || 0,
          limit: Number(url.searchParams.get("limit")) || 50,
        }) });
      }
      if (segs.length === 3 && segs[2] === "memory") {
        if (!["POST", "PUT", "DELETE"].includes(method)) {
          return sendJson(res, 405, { error: "method not allowed" });
        }
        const body = await readJsonBody(req);
        if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
        const { action: requestedAction, ...input } = body;
        if (requestedAction !== undefined && (method !== "POST" || requestedAction !== "create")) {
          return sendJson(res, 400, { error: "unknown memory action" });
        }
        const action = method === "POST" ? requestedAction || "confirm" : method === "PUT" ? "update" : "delete";
        return sendJson(res, 200, { result: await backend.mutateAgentMemory(id, action, input) });
      }
      if (segs.length === 3 && segs[2] === "transcripts") {
        if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
        return sendJson(res, 200, { transcripts: await backend.listAgentTranscripts(id, {
          sessionId: url.searchParams.get("sessionId") || undefined,
          cursor: Number(url.searchParams.get("cursor")) || 0,
          limit: Number(url.searchParams.get("limit")) || 50,
        }) });
      }
      if (segs.length === 3 && segs[2] === "transcript-context") {
        if (method !== "PUT") return sendJson(res, 405, { error: "method not allowed" });
        const body = await readJsonBody(req);
        if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
        return sendJson(res, 200, { result: await backend.setAgentTranscriptContext(id, body) });
      }
      if (segs.length === 3 && segs[2] === "tools") {
        if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
        return sendJson(res, 200, { tools: await backend.listAgentTools(id) });
      }
      if (segs.length === 3 && segs[2] === "tool-permission") {
        if (method !== "PUT") return sendJson(res, 405, { error: "method not allowed" });
        const body = await readJsonBody(req);
        if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
        return sendJson(res, 200, { result: await backend.setAgentToolPermission(id, body) });
      }
      if (segs.length === 3 && segs[2] === "computer") {
        if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
        return sendJson(res, 200, { computer: await backend.getAgentComputerState(id) });
      }
      // channels (read-only)
      if (segs.length === 3 && segs[2] === "channels" && method === "GET") {
        return sendJson(res, 200, { channels: await backend.getAgentChannels(id) });
      }
      // artifacts：该 agent 的产出文件（read-only，本地磁盘扫描）
      if (segs.length === 3 && segs[2] === "artifacts" && method === "GET") {
        const limit = Number(url.searchParams.get("limit")) || undefined;
        return sendJson(res, 200, { artifacts: await backend.listAgentArtifacts(id, limit ? { limit } : {}) });
      }
    }
    if (segs[0] === "environments" && segs.length === 1) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const backendId = new URL(req.url, "http://127.0.0.1").searchParams.get("backend") || "";
      if (!isBoundedApiString(backendId, 64)) return sendJson(res, 400, { error: "missing or invalid ?backend=" });
      return sendJson(res, 200, await registry.listEnvironments(backendId));
    }
    if (segs[0] === "session-board" && segs.length === 1) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const url = new URL(req.url, "http://127.0.0.1");
      const backendId = url.searchParams.get("backend") || "";
      const agentId = url.searchParams.get("agentId") || "";
      const sessionKey = url.searchParams.get("sessionKey") || "";
      const safeAgentId = normalizeSessionBoardAgentId(agentId);
      const safeSessionKey = normalizeSessionBoardSessionKey(sessionKey);
      if (!hasExactSearchParams(url.searchParams, ["backend", "agentId", "sessionKey"])
        || !isBoundedApiString(backendId, 64) || !safeAgentId || !safeSessionKey) {
        return sendJson(res, 400, { error: "missing or invalid backend, agentId, or sessionKey" });
      }
      return sendJson(res, 200, projectSessionBoardEnvelope(
        await registry.getSessionBoard(backendId, safeAgentId, safeSessionKey),
        safeSessionKey,
      ));
    }
    if (segs[0] === "session-board" && segs[1] === "ops" && segs.length === 2) {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      const body = await readJsonBody(req);
      const safeAgentId = normalizeSessionBoardAgentId(body?.agentId);
      const safeSessionKey = normalizeSessionBoardSessionKey(body?.sessionKey);
      if (!hasExactApiKeys(body, ["backend", "agentId", "sessionKey", "ops"])
        || !isBoundedApiString(body.backend, 64) || !safeAgentId || !safeSessionKey) {
        return sendJson(res, 400, { error: "invalid session board request" });
      }
      const ops = normalizeSessionBoardOps(body.ops);
      if (!ops) return sendJson(res, 400, { error: "invalid session board ops" });
      return sendJson(res, 200, projectSessionBoardEnvelope(
        await registry.updateSessionBoard(body.backend, safeAgentId, safeSessionKey, ops),
        safeSessionKey,
      ));
    }
    if (segs[0] === "session-board" && segs[1] === "pin-canvas" && segs.length === 2) {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      const body = await readJsonBody(req);
      const safeAgentId = normalizeSessionBoardAgentId(body?.agentId);
      const safeSessionKey = normalizeSessionBoardSessionKey(body?.sessionKey);
      if (!hasExactApiKeys(body, ["backend", "agentId", "sessionKey", "spec"])
        || !isBoundedApiString(body.backend, 64) || !safeAgentId || !safeSessionKey) {
        return sendJson(res, 400, { error: "invalid session board request" });
      }
      const spec = normalizeSessionBoardCanvasSpec(body.spec);
      if (!spec) return sendJson(res, 400, { error: "invalid session board canvas spec" });
      return sendJson(res, 200, projectSessionBoardEnvelope(
        await registry.pinSessionBoardCanvas(body.backend, safeAgentId, safeSessionKey, spec),
        safeSessionKey,
      ));
    }
    if (segs[0] === "session-board" && segs[1] === "grant" && segs.length === 2) {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      const body = await readJsonBody(req);
      const safeAgentId = normalizeSessionBoardAgentId(body?.agentId);
      const safeSessionKey = normalizeSessionBoardSessionKey(body?.sessionKey);
      if (!hasExactApiKeys(body, ["backend", "agentId", "sessionKey", "spec"])
        || !isBoundedApiString(body.backend, 64) || !safeAgentId || !safeSessionKey) {
        return sendJson(res, 400, { error: "invalid session board request" });
      }
      const spec = normalizeSessionBoardGrantSpec(body.spec);
      if (!spec) return sendJson(res, 400, { error: "invalid session board grant spec" });
      return sendJson(res, 200, projectSessionBoardEnvelope(
        await registry.decideSessionBoardWidgetGrant(body.backend, safeAgentId, safeSessionKey, spec),
        safeSessionKey,
      ));
    }
    if (segs[0] === "sessions" && segs[1] === "describe" && segs.length === 2) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const url = new URL(req.url, "http://127.0.0.1");
      const backendId = url.searchParams.get("backend") || "";
      const agentId = url.searchParams.get("agentId") || "";
      const key = url.searchParams.get("key") || "";
      if (!isBoundedApiString(backendId, 64) || !isSingleSegmentAgentId(agentId)
        || !isBoundedApiString(key)) {
        return sendJson(res, 400, { error: "missing or invalid backend, agentId, or key" });
      }
      return sendJson(res, 200, await registry.describeSession(backendId, agentId, key));
    }
    if (segs[0] === "sessions" && segs[1] === "artifacts" && segs.length === 2) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const url = new URL(req.url, "http://127.0.0.1");
      const backendId = url.searchParams.get("backend") || "";
      const agentId = url.searchParams.get("agentId") || "";
      const key = url.searchParams.get("key") || "";
      const limitRaw = Number(url.searchParams.get("limit") || 50);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 100) : 50;
      if (!isBoundedApiString(backendId, 64) || !isSingleSegmentAgentId(agentId)
        || !isBoundedApiString(key)) {
        return sendJson(res, 400, { error: "missing or invalid backend, agentId, or key" });
      }
      return sendJson(res, 200, {
        artifacts: await registry.listSessionArtifacts(backendId, agentId, key, { limit }),
      });
    }
    if (segs[0] === "sessions" && segs[1] === "branches" && segs.length === 2) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const url = new URL(req.url, "http://127.0.0.1");
      const backendId = url.searchParams.get("backend") || "";
      const agentId = url.searchParams.get("agentId") || "";
      const key = url.searchParams.get("key") || "";
      if (!isBoundedApiString(backendId, 64) || !isSingleSegmentAgentId(agentId)
        || !isBoundedApiString(key)) {
        return sendJson(res, 400, { error: "missing or invalid backend, agentId, or key" });
      }
      return sendJson(res, 200, await registry.listSessionBranches(backendId, agentId, key));
    }
    if (segs[0] === "sessions" && segs[1] === "fork" && segs.length === 2) {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      const body = await readJsonBody(req);
      if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
      const { backend, agentId, key, entryId } = body;
      if (!isBoundedApiString(backend, 64) || !isSingleSegmentAgentId(agentId)
        || !isBoundedApiString(key) || !isBoundedApiString(entryId, 1024)) {
        return sendJson(res, 400, { error: "missing or invalid backend, agentId, key, or entryId" });
      }
      return sendJson(res, 200, await registry.forkSessionAtEntry(backend, agentId, key, entryId));
    }
    if (segs[0] === "sessions" && segs[1] === "archive" && segs.length === 2) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const url = new URL(req.url, "http://127.0.0.1");
      const backendId = url.searchParams.get("backend") || "openclaw";
      const agentId = url.searchParams.get("agentId") || "";
      // session keys contain ":" (agent:sara:main) → always a query param, never a path seg
      const key = url.searchParams.get("key") || "";
      if (!agentId || !key) return sendJson(res, 400, { error: "missing ?agentId= or ?key=" });
      if (!isSingleSegmentAgentId(agentId)) return sendJson(res, 400, { error: "invalid agent id" });
      return sendJson(res, 200, { archive: await registry.getSessionArchive(backendId, agentId, key) });
    }
    // Usage Top 会话的 transcript 头部预览；query-param 约定同上（key 含 ":"）。
    if (segs[0] === "sessions" && segs[1] === "preview" && segs.length === 2) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const url = new URL(req.url, "http://127.0.0.1");
      const backendId = url.searchParams.get("backend") || "openclaw";
      const agentId = url.searchParams.get("agentId") || "";
      const key = url.searchParams.get("key") || "";
      const sessionId = url.searchParams.get("sid") || undefined;
      const offset = Number(url.searchParams.get("offset")) || 0;
      const limit = Number(url.searchParams.get("limit")) || undefined;
      if (!agentId || !key) return sendJson(res, 400, { error: "missing ?agentId= or ?key=" });
      if (!isSingleSegmentAgentId(agentId)) return sendJson(res, 400, { error: "invalid agent id" });
      return sendJson(res, 200, { preview: await registry.getSessionPreview(backendId, agentId, key, { sessionId, offset, limit }) });
    }
    // Global chat search across every active backend and agent. The registry
    // owns fan-out/fail-soft aggregation; the renderer makes one bounded call.
    if (segs[0] === "chat" && segs[1] === "search" && segs.length === 2) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const url = new URL(req.url, "http://127.0.0.1");
      const q = url.searchParams.get("q") || "";
      const limit = Number(url.searchParams.get("limit")) || undefined;
      const offset = Number(url.searchParams.get("offset")) || 0;
      if (!isBoundedApiString(q) || !q.trim()) return sendJson(res, 400, { error: "missing or invalid ?q=" });
      return sendJson(res, 200, { search: await registry.searchAllChat(q, { limit, offset }) });
    }
    if (segs[0] === "status" && segs.length === 1) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      return sendJson(res, 200, { backends: await registry.getStatus() });
    }
    // Dashboard 总览：registry 聚合（fail-soft，绝不 throw）。生产 UI 无参调用
    // （服务端取本地 0 点）；smoke 传 sinceMs=0 保证离线确定性断言。
    if (segs[0] === "dashboard" && segs[1] === "live" && segs.length === 2) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      return sendJson(res, 200, await registry.getDashboardLiveWork());
    }

    if (segs[0] === "dashboard" && segs.length === 1) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const url = new URL(req.url, "http://127.0.0.1");
      const num = (key) => {
        const raw = url.searchParams.get(key);
        if (raw == null || raw === "") return undefined;
        const n = Number(raw);
        return Number.isFinite(n) ? n : undefined;
      };
      const summary = await registry.getDashboardSummary({
        sinceMs: num("sinceMs"),
        ...(num("runsLimit") != null ? { runsLimit: num("runsLimit") } : {}),
        ...(num("artifactsLimit") != null ? { artifactsLimit: num("artifactsLimit") } : {}),
      });
      return sendJson(res, 200, { summary });
    }
    // Dashboard 文件缩略图：由对应 backend 重验证（realpath 落在允许根内 +
    // 图片扩展 + 普通文件）后才回流；聊天 /__media 的边界不动。
    if (segs[0] === "dashboard" && segs[1] === "preview" && segs.length === 2) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const url = new URL(req.url, "http://127.0.0.1");
      const backendId = url.searchParams.get("backend") || "";
      const reqPath = url.searchParams.get("path") || "";
      if (!backendId || !reqPath) return sendJson(res, 400, { error: "backend and path required" });
      const backend = getActiveBackend(registry, backendId);
      if (!backend) return sendJson(res, 400, { error: `unknown backend: ${backendId}` });
      let resolved = null;
      try {
        resolved = await backend.resolveArtifactPreview(reqPath);
      } catch { /* 验证失败按 404 */ }
      if (!resolved || !resolved.absPath) return sendJson(res, 404, { error: "not found" });
      const ext = path.extname(resolved.absPath).toLowerCase();
      const mime = {
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
        ".webp": "image/webp", ".svg": "image/svg+xml", ".heic": "image/heic",
      }[ext] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" });
      fs.createReadStream(resolved.absPath)
        .on("error", () => { try { res.destroy(); } catch { /* closing */ } })
        .pipe(res);
      return;
    }
    // 统一活动流分页：cron/kanban/health 合并（30s 单飞缓存在 registry），
    // opaque cursor 稳定分页；非法 cursor/kind/backend → 400。
    if (segs[0] === "dashboard" && segs[1] === "activities" && segs.length === 2) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const url = new URL(req.url, "http://127.0.0.1");
      const num = (key) => {
        const raw = url.searchParams.get(key);
        if (raw == null || raw === "") return undefined;
        const n = Number(raw);
        return Number.isFinite(n) ? n : undefined;
      };
      try {
        const page = await registry.getDashboardActivityPage({
          sinceMs: num("sinceMs"),
          limit: num("limit"),
          cursor: url.searchParams.get("cursor") || undefined,
          backend: url.searchParams.get("backend") || undefined,
          kind: url.searchParams.get("kind") || undefined,
        });
        return sendJson(res, 200, page);
      } catch (err) {
        return sendJson(res, 400, { error: err?.message || "bad request" });
      }
    }
    if (segs[0] === "versions" && segs.length === 1) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      return sendJson(res, 200, { versions: await registry.getVersions() });
    }
    // 设置页「立即更新」：POST run 触发官方自更新（后台执行，立即返回），
    // GET 轮询全部后端的更新状态。更新是分钟级操作，不能同步等在 REST 上。
    if (segs[0] === "updates" && segs.length === 1) {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      return sendJson(res, 200, { updates: registry.getSelfUpdateStatuses() });
    }
    if (segs[0] === "updates" && segs[1] === "run" && segs.length === 2) {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      const url = new URL(req.url, "http://127.0.0.1");
      const backendId = url.searchParams.get("backend") || "";
      const action = url.searchParams.get("action") || "update";
      if (action !== "update" && action !== "repair") {
        return sendJson(res, 400, { error: "action must be update or repair" });
      }
      const acceptCapabilities = url.searchParams.get("acceptCapabilities") === "true";
      if (!backendId) return sendJson(res, 400, { error: "missing ?backend=" });
      if (!getActiveBackend(registry, backendId)) {
        return sendJson(res, 404, { error: `unknown backend ${backendId}` });
      }
      const update = registry.runSelfUpdate(backendId, { action, acceptCapabilities });
      if (!update) return sendJson(res, 404, { error: `unknown backend ${backendId}` });
      return sendJson(res, 200, { update });
    }
    if (segs[0] === "approval-grants" && segs.length === 1) {
      const url = new URL(req.url, "http://127.0.0.1");
      const backendId = url.searchParams.get("backend") || "";
      if (!backendId) return sendJson(res, 400, { error: "missing ?backend=" });
      if (method === "GET") {
        const limitRaw = Number(url.searchParams.get("limit") || 100);
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 500) : 100;
        const result = await registry.listStandingGrants(backendId, { limit });
        return sendJson(res, 200, projectStandingGrantListForBrowser(result, backendId));
      }
      if (method === "DELETE") {
        const grantId = url.searchParams.get("id") || "";
        if (!grantId) return sendJson(res, 400, { error: "missing ?id=" });
        const result = await registry.revokeStandingGrant(backendId, grantId);
        return sendJson(res, 200, projectStandingGrantRevokeForBrowser(result));
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }
    // Dev-only: the in-app debug inspector (设置 → 调试) persists its live tweaks here.
    // Merges into manage-ui/src/debug-overrides.css so saves accumulate. NOT a backend
    // capability → handled host-side like /config and /cli/reveal, never via the registry.
    // Only works in a source checkout; the packaged app has no editable src (→ 400).
    if (segs[0] === "debug" && segs[1] === "overrides" && segs.length === 2) {
      const file = path.join(__dirname, "manage-ui", "src", "debug-overrides.css");
      // "Can save" means a real, writable source checkout — NOT the packaged app.
      // electron-builder bundles app/manage-ui/src INTO app.asar, so fs.existsSync is
      // true there too, yet the asar is read-only and writes throw. Gate on the .asar
      // path so the packaged app reports canSave:false (UI hides the button; PUT 400s
      // cleanly instead of failing later with a confusing read-only fs error).
      const canSave = !__dirname.includes(".asar") && fs.existsSync(path.dirname(file));
      // GET = capability probe. The packaged app can't persist, so the UI hides
      // "save to source" and only offers "copy for AI" when canSave is false.
      if (method === "GET") return sendJson(res, 200, { canSave });
      if (method !== "PUT") return sendJson(res, 405, { error: "method not allowed" });
      const body = await readJsonBody(req);
      const incoming = body && body.overrides;
      if (!incoming || typeof incoming !== "object") return sendJson(res, 400, { error: "missing overrides" });
      if (!canSave) {
        return sendJson(res, 400, { error: "source not available (packaged build) — use Export CSS instead" });
      }
      let existing = "";
      try { existing = fs.readFileSync(file, "utf8"); } catch { /* first write */ }
      const merged = parseOverridesCss(existing);
      for (const sel of Object.keys(incoming)) {
        merged[sel] = { ...(merged[sel] || {}), ...incoming[sel] };
      }
      fs.writeFileSync(file, generateOverridesCss(merged), "utf8");
      return sendJson(res, 200, { ok: true, path: file, selectors: Object.keys(merged).length });
    }
    return sendJson(res, 404, { error: "not found" });
  } catch (err) {
    // 参数/路径边界错误保持客户端 400；请求体溢出用 413，其余运行时故障保持 500。
    const trusted = trustedApiError(err);
    const modelChangeError = err instanceof ModelChangeError || err instanceof ModelChangeJournalError;
    const admissionError = err instanceof WorkAdmissionError
      && err.code === "gateway_draining"
      && err.status === 409;
    const modelChangeStatus = modelChangeError && Number.isInteger(err.status) && err.status >= 400 && err.status <= 599
      ? err.status
      : null;
    const status =
      modelChangeStatus ||
      (admissionError ? 409 : null) ||
      trusted?.status ||
      (err instanceof ModelValidationError || isInvalidAgentIdError(err)
        ? 400
        : err?.code === "BODY_TOO_LARGE"
          ? 413
          : 500);
    const safeDetails = modelChangeError ? safeModelChangeDetails(err.details) : undefined;
    return sendJson(res, status, {
      error: err?.message || String(err),
      ...(modelChangeError ? {
        code: err.code,
        stage: err.stage,
        ...(typeof err.field === "string" ? { field: err.field } : {}),
        ...(safeDetails && Object.keys(safeDetails).length > 0 ? { details: safeDetails } : {}),
      } : {}),
      ...(trusted ? { code: trusted.code } : {}),
      ...(admissionError ? { code: err.code } : {}),
    });
  }
}

// Serve a built SPA directory with a hash-router-friendly fallback: unknown
// non-asset paths resolve to index.html. `relPath` is the request path already
// stripped of any route prefix. Shows a build hint when the bundle is missing.
function serveSpaDir(res, baseDir, relPath, { buildHint = "" } = {}) {
  const rel = (relPath || "").replace(/^\/+/, "");
  let target = rel ? path.resolve(baseDir, rel) : path.join(baseDir, "index.html");
  // Path-traversal guard: resolved file must stay within baseDir.
  if (target !== baseDir && !target.startsWith(baseDir + path.sep)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  let stat = null;
  try {
    stat = fs.statSync(target);
    if (stat.isDirectory()) {
      target = path.join(target, "index.html");
      stat = fs.statSync(target);
    }
  } catch {
    stat = null;
  }

  // SPA fallback: unknown non-asset routes get index.html.
  if (!stat) {
    if (path.extname(rel)) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    target = path.join(baseDir, "index.html");
    try {
      stat = fs.statSync(target);
    } catch {
      const hint = buildHint ? `运行 <code>${buildHint}</code> 后刷新。` : "请先构建后刷新。";
      const msg =
        '<!doctype html><meta charset="utf-8"><body style="font:14px -apple-system,sans-serif;padding:2rem;color:#555">' +
        `UI 尚未构建。${hint}</body>`;
      const b = Buffer.from(msg, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": b.length,
        "Cache-Control": "no-store",
        "Content-Security-Policy": UI_CONTENT_SECURITY_POLICY,
        "X-Content-Type-Options": "nosniff",
      });
      res.end(b);
      return;
    }
  }

  res.writeHead(200, {
    "Content-Type": contentTypeFor(target),
    "Content-Length": stat.size,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    ...(path.extname(target) === ".html"
      ? { "Content-Security-Policy": UI_CONTENT_SECURITY_POLICY } : {}),
  });
  fs.createReadStream(target).pipe(res);
}

/**
 * Serves the React control-plane UI at the loopback root, the /__api management
 * plane, the backend-routed /__widget document proxy, agent avatars, and the
 * native-chat /__chatws broker.
 * @param {number} [preferredPort] fixed port for a stable origin (so the UI's
 *   localStorage / device identity persist across launches). Falls back to an
 *   OS-assigned port if the preferred one is taken.
 * @param {{ registry?: object, modelChangeCoordinator?: object, workAdmissionGate?: object, homeDir?: string, userDataRoot?: string }} [options] management-plane dependencies and Shoggoth asset roots.
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>}>}
 */
function startStaticServer(
  preferredPort,
  {
    registry,
    chatUpstreamUrl,
    chatOrigin,
    configStore,
    hostOps,
    productHost,
    onConfigChanged,
    authResolver,
    modelChangeCoordinator,
    workAdmissionGate,
    homeDir = os.homedir(),
    userDataRoot,
  } = {},
) {
  const assetPaths = resolveDesktopAssetPaths({ homeDir, userDataRoot });
  let assetsMigrated = false;
  function prepareDesktopAssets() {
    if (assetsMigrated) return;
    migrateLegacyDesktopAssets(assetPaths);
    assetsMigrated = true;
  }
  const cliExecutionGate = createCliExecutionGate();
  const attachmentOpener = typeof hostOps?.openPath === "function"
    ? createChatAttachmentOpener((file) => hostOps.openPath(file)) : null;
  const apiDeps = {
    configStore,
    hostOps,
    attachmentOpener,
    productHost,
    onConfigChanged,
    modelChangeCoordinator,
    workAdmissionGate,
    cliExecutionGate,
  };
  const server = http.createServer((req, res) => {
    const rawTarget = typeof req.url === "string" ? req.url : "/";

    // Widget paths must be parsed from the raw request target: URL/pathname
    // normalization would erase encoded traversal evidence before the backend
    // contract validates each Canvas segment.
    const isWidgetTarget = rawTarget === "/__widget"
      || rawTarget.startsWith("/__widget/")
      || rawTarget.startsWith("/__widget?")
      || rawTarget.startsWith("/__widget#");
    if (isWidgetTarget) {
      if (!isLoopbackHost(req.headers.host)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      handleWidgetResourceRequest(req, res, rawTarget, registry).catch(() => {
        if (!res.headersSent) {
          sendWidgetFailure(res, 502);
        } else {
          res.destroy();
        }
      });
      return;
    }

    let pathname = "/";
    try {
      pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    } catch {
      res.writeHead(400);
      res.end("Bad Request");
      return;
    }

    // DNS-rebinding guard: this is a loopback-only origin, so anything claiming a
    // non-loopback Host is a cross-origin attacker (see isLoopbackHost).
    if (!isLoopbackHost(req.headers.host)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    // Management REST plane (cron/tasks/agents). Async; manages its own response.
    if (pathname.startsWith("/__api/")) {
      // CSRF guard: Host 检查挡不住 evil.com 直接 POST 本机(它发的正是本机 Host)。
      // 这里故意不锁端口:dev 下 UI 跑在 vite(5173)并把 /__api 代理到本服务,
      // 转发过来的 Origin 是 5173,锁端口会打断 dev 链路;非环回一律拒。
      const fetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
      if (!isAllowedBrowserOrigin(req.headers.origin) || fetchSite === "cross-site") {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      handleApiRequest(req, res, pathname, registry, apiDeps);
      return;
    }

    // 沉浸模式背景素材（Shoggoth 自定义目录清单 + 文件本体）。
    if (pathname === "/__immersive/bg-manifest" || pathname.startsWith("/__immersive/bg/")) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Method Not Allowed");
        return;
      }
      prepareDesktopAssets();
      if (pathname === "/__immersive/bg-manifest") {
        const body = JSON.stringify(listImmersiveBgManifest(assetPaths));
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
          "Cache-Control": "no-cache",
        });
        res.end(body);
        return;
      }
      let name = "";
      try {
        name = decodeURIComponent(pathname.slice("/__immersive/bg/".length));
      } catch {
        name = "";
      }
      const ext = path.extname(name).toLowerCase();
      const okExt = IMMERSIVE_BG_VIDEO_EXTS.has(ext) || IMMERSIVE_BG_IMAGE_EXTS.has(ext);
      const filePath = okExt && (resolveDesktopAssetFile(assetPaths.immersiveBgDir, name)
        || resolveDesktopAssetFile(assetPaths.legacyImmersiveBgDir, name));
      if (!filePath) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }
      let bgStat;
      try {
        bgStat = fs.statSync(filePath);
      } catch {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }
      if (!bgStat.isFile()) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }
      // 单段 Range（bytes=a-b / a- / -n）：Chromium 媒体栈按 Range 拉视频，
      // seek / moov-at-end 的 mp4 缺 206 会退化成整文件下载甚至不可播。
      const rangeHeader = String(req.headers.range || "");
      const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
      if (rangeMatch && (rangeMatch[1] || rangeMatch[2]) && req.method === "GET") {
        let start = rangeMatch[1] ? parseInt(rangeMatch[1], 10) : NaN;
        let end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : bgStat.size - 1;
        if (!rangeMatch[1]) {
          // 后缀形态 -n = 末尾 n 字节
          start = Math.max(0, bgStat.size - parseInt(rangeMatch[2], 10));
          end = bgStat.size - 1;
        }
        end = Math.min(end, bgStat.size - 1);
        if (!Number.isFinite(start) || start < 0 || start > end) {
          res.writeHead(416, { "Content-Range": `bytes */${bgStat.size}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          "Content-Type": contentTypeFor(filePath),
          "Content-Length": end - start + 1,
          "Content-Range": `bytes ${start}-${end}/${bgStat.size}`,
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-cache",
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, {
        "Content-Type": contentTypeFor(filePath),
        "Content-Length": bgStat.size,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache",
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // Agent avatars belong to Shoggoth, independently of the agent's backend.
    if (pathname.startsWith("/avatar/")) {
      prepareDesktopAssets();
      const agentId = pathname.slice("/avatar/".length);
      if (req.method === "PUT" || req.method === "POST") {
        handleAvatarUpload(req, res, agentId, assetPaths.avatarDir);
        return;
      }
      const avatarPath = resolveAgentAvatarFile(agentId, assetPaths);
      if (!avatarPath) {
        // No on-disk avatar (Hermes synthetic agents, or an OpenClaw agent that
        // never got one) — synthesize a textured initial SVG so the UI gets a
        // 200 instead of spamming 404s in the console for every render. The id
        // guards mirror resolveAgentAvatarFile's (reject traversal-ish ids).
        if (validAssetName(agentId)) {
          const svg = defaultAgentAvatarSvg(agentId);
          res.writeHead(200, {
            "Content-Type": "image/svg+xml; charset=utf-8",
            "Content-Length": Buffer.byteLength(svg),
            "Cache-Control": "no-cache",
          });
          res.end(svg);
          return;
        }
        res.writeHead(404);
        res.end("Not Found");
        return;
      }
      let avatarStat;
      try {
        avatarStat = fs.statSync(avatarPath);
      } catch {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": contentTypeFor(avatarPath),
        "Content-Length": avatarStat.size,
        "Cache-Control": "no-cache",
      });
      fs.createReadStream(avatarPath).pipe(res);
      return;
    }

    // Agent-attached media: the UI rewrites OpenClaw `MEDIA:<localPath>` directives to
    // `/__media?path=<abs>` (see lib/agentMedia.ts); serve the on-disk image here.
    if (pathname === "/__media") {
      const q = new URL(req.url, "http://127.0.0.1").searchParams;
      // `rel` = 相对家目录的路径（Hermes 附件引用 `.hermes/desktop-attachments/x`
      // 就是这个形状——浏览器不知道家目录在哪，由服务端补全）。逃逸仍由
      // resolveMediaFile 的 realpath 包含性检查兜住。
      const rel = q.get("rel");
      const wanted = rel ? path.join(os.homedir(), rel) : q.get("path");
      const mediaPath = resolveMediaFile(wanted);
      if (!mediaPath) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }
      let mediaStat;
      try {
        mediaStat = fs.statSync(mediaPath);
      } catch {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": contentTypeFor(mediaPath),
        "Content-Length": mediaStat.size,
        "Cache-Control": "no-cache",
      });
      fs.createReadStream(mediaPath).pipe(res);
      return;
    }

    // React control-plane UI at the loopback root; the React app owns its shell.
    serveSpaDir(res, MANAGE_DIR, pathname, { buildHint: "npm run build:manage" });
  });

  const activeUpgradePaths = new Set();
  const brokerServers = [];
  let closePromise = null;

  // Native React chat: a /__chatws broker that auto-auths to the federating
  // proxy so the browser speaks the plain gateway protocol without device auth.
  if (chatUpstreamUrl) {
    brokerServers.push(attachChatBroker(server, {
      getUpstreamUrl: () => chatUpstreamUrl,
      getOrigin: () => chatOrigin,
      authResolver,
    }));
    activeUpgradePaths.add(CHAT_WS_PATH);
  }
  // Hermes kanban live event stream (Slice 9): relay the dashboard's
  // /api/plugins/kanban/events WS so the board updates without polling.
  if (registry) {
    brokerServers.push(attachKanbanBroker(server, { registry }));
    activeUpgradePaths.add(KANBAN_WS_PATH);
  }
  // 必须注册在两个已知 broker 之后：双方都不认领的 upgrade 若无人销毁，
  // 原始 socket 会永久悬挂；已启用的已知路径继续完全交给各自 handler。
  server.on("upgrade", (req, socket) => {
    let pathname;
    try {
      pathname = new URL(req.url, "http://127.0.0.1").pathname;
    } catch {
      pathname = req.url;
    }
    if (activeUpgradePaths.has(pathname)) return;
    try { socket.destroy(); } catch { /* ignore */ }
  });

  return new Promise((resolve, reject) => {
    const finish = () => {
      const { port } = server.address();
      const close = () => {
        if (closePromise) return closePromise;
        closePromise = (async () => {
          const httpClosed = new Promise((resolveClose) => {
            if (!server.listening) {
              resolveClose();
              return;
            }
            server.close(() => resolveClose());
          });
          const forceHttpTimer = setTimeout(() => {
            try { server.closeAllConnections(); } catch { /* already closed */ }
          }, WS_CLOSE_GRACE_MS);
          await Promise.all(brokerServers.map((wss) => closeWebSocketServer(wss)));
          await httpClosed;
          clearTimeout(forceHttpTimer);
          attachmentOpener?.dispose();
        })();
        return closePromise;
      };
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        close,
      });
    };
    let triedFallback = false;
    server.on("error", (err) => {
      if (err && err.code === "EADDRINUSE" && preferredPort && !triedFallback) {
        triedFallback = true;
        server.listen(0, "127.0.0.1", finish);
        return;
      }
      reject(err);
    });
    server.listen(preferredPort || 0, "127.0.0.1", finish);
  });
}

module.exports = { startStaticServer };
