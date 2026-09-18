"use strict";

// Hermes backend.
//
// Hermes profiles are isolated (separate SessionDB per profile dir), so we run
// ONE `hermes dashboard` per profile — default at `startPort`, bull/horse on
// the next free ports. Each dashboard mints an ephemeral session token and
// injects it into its served HTML (`window.__HERMES_SESSION_TOKEN__`); we
// scrape it the same way the real web UI reads it. Profiles → agents,
// sessions list / message history come from /api/profiles, /api/sessions,
// /api/sessions/{id}/messages. Chat goes through ACP (`hermes acp` per profile)
// with session/load to resume historical Hermes sessions.

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createHash, randomUUID, randomBytes } = require("node:crypto");
const { WebSocket } = require("ws");
const {
  annotateFederationPrompt,
  federationInputProvenanceFromPrompt,
  hasFederationPromptMarker,
  normalizeFederationInputProvenance,
} = require("../federation-chat-provenance");
const { AcpClient } = require("./acp-client");
const { parseCliCommandNames } = require("./openclaw-backend");
const { hermesKanbanEventToActivity } = require("./dashboard-activity");
const { normalizeArtifactRoots, walkArtifactRoots, resolveArtifactPreviewPath } = require("./artifact-scan");
const { collectSessionOutputArtifacts, sessionArtifactHistory } = require("./session-output-artifacts");
const { assertHttpUrl, normalizeOptionalString } = require("./model-validation");
const { createHermesModelMutationGate } = require("./hermes-model-mutation");
const { gatewayRpc, modelSwitchValue, HermesGatewaySocket } = require("./hermes-gateway-rpc");
const {
  buildHermesModelCatalogState,
  commitHermesModelCatalogState,
} = require("./hermes-model-catalog-state");

// Hermes tool names whose argument carries a host shell command (vs. code
// sandbox / web / file tools). `terminal` is the shell tool; the rest future-proof.
const HERMES_CLI_TOOLS = new Set(["terminal", "bash", "shell", "exec"]);
// Hermes 的技能加载工具（args {name}）。`skills_list`/`skill_manage` 是浏览与
// 增删，不算「用过」。
const HERMES_SKILL_VIEW_TOOL = "skill_view";
const { AgentBackend, dirCreatedAtMs, sortAgentsByCreatedAt } = require("./agent-backend");
const { SelfUpdater } = require("./self-updater");
const { readHermesUsageHistory } = require("./hermes-usage-history");

const DEFAULT_PORT = 9119;
const HERMES_CATALOG_UNAVAILABLE_CODE = "ERR_HERMES_CATALOG_UNAVAILABLE";

// ---- gateway chat (S2) constants ----
// `source` stamps who created/resumed the session; "desktop" keeps our sessions
// in the same sidebar bucket the official desktop uses (and out of deny-lists).
const GW_SOURCE = "desktop";
const GW_COLS = 120; // server renders/wraps some output to this width
// prompt.submit acks immediately; the TURN completes via events. Safety net for
// a completion event that never arrives (official desktop allows 30 min).
const GW_TURN_TIMEOUT_MS = 30 * 60_000;
// After a transport-level gateway failure, sends fall back to ACP and the
// gateway is re-probed after this long.
const GW_CHAT_RETRY_MS = 60_000;
// Attachment uploads (image/file): server-side workspace resolution + disk
// write, and a cold dashboard is busy with its model-catalog fetch at the same
// time. 120s, matching pdf.attach's own budget.
const GW_ATTACH_TIMEOUT_MS = 120_000;
const HERMES_IDEMPOTENCY_TTL_MS = 10 * 60_000;
const HERMES_IDEMPOTENCY_MAX = 256;
const CHAT_HOOK_METHODS = Object.freeze([
  "delta", "final", "error", "interim", "thinking", "tool", "plan",
  "status", "prompt", "promptExpire",
]);
// Hermes reasoning-effort vocabulary (hermes_constants.VALID_REASONING_EFFORTS
// + the "none" sentinel the Thinking toggle uses). Surfaces as the chat page's
// thinking-level picker for reasoning-capable models.
const HERMES_THINKING_LEVELS = Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

/** Hermes strict 模型目录无法形成完整快照时使用的稳定服务错误。 */
class HermesCatalogUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "HermesCatalogUnavailableError";
    this.code = HERMES_CATALOG_UNAVAILABLE_CODE;
    this.statusCode = 503;
  }
}

/** 创建统一的 strict 目录不可用错误，避免各读取分支丢失 REST 状态契约。 */
function catalogUnavailable(message) {
  return new HermesCatalogUnavailableError(message);
}

// 模型目录允许不同 provider 暴露同名模型，因此目录与元数据统一使用复合身份。
// Hermes 的 providers.*.models 支持 dict 形状（{id, context_length}）。它自己在
// custom-endpoints / model options 里对这种条目做过 str()，于是模型 id 会变成一串
// Python repr："{'id': 'gpt-5.6-terra', 'context_length': 1000000}"。这串东西一旦
// 进了表单再存回去，就被固化成真正的 model 键（用户的 5 份 config.yaml 都中招）。
// 读到就地还原成裸 id，堵住这条回写通路。
const PY_REPR_ID_RE = /^\s*\{\s*['"]id['"]\s*:\s*['"]([^'"]+)['"]/;
function normalizeModelId(raw) {
  if (raw && typeof raw === "object") {
    const id = raw.id ?? raw.name ?? "";
    return String(id).trim();
  }
  const s = String(raw ?? "").trim();
  const m = PY_REPR_ID_RE.exec(s);
  return m ? m[1] : s;
}

function modelCatalogKey(provider, modelId) {
  return JSON.stringify([String(provider || ""), String(modelId || "")]);
}

// GUI-launched .app inherits only the system PATH (no ~/.local/bin etc.), so
// spawn("hermes",...) ENOENTs from Finder/Dock even though `which hermes` works
// in a terminal. Resolve the absolute path up-front from known install locations.
function resolveHermesBin() {
  if (process.env.HERMES_BIN) return process.env.HERMES_BIN;
  const home = process.env.HOME || os.homedir();
  const candidates = [
    path.join(home, ".local", "bin", "hermes"),
    path.join(home, ".hermes", "hermes-agent", "venv", "bin", "hermes"),
    "/opt/homebrew/bin/hermes",
    "/usr/local/bin/hermes",
    "/usr/bin/hermes",
  ];
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() || stat.isSymbolicLink()) return candidate;
    } catch {
      /* not present, try next */
    }
  }
  return "hermes"; // last resort — will ENOENT if PATH lacks it
}
const HERMES_BIN = resolveHermesBin();
const READY_TIMEOUT_MS = 30_000;
const ID_PREFIX = "hermes-";
const SESSIONS_REFRESH_MS = 30_000;
const SESSIONS_PER_PROFILE_LIMIT = 200;
const CRON_DASHBOARD_SUMMARY_LIMIT = 100;
// How far past a profile's preferred port to look when that port is held by a
// dashboard belonging to some OTHER profile (orphan from a hard kill, etc).
const DASHBOARD_PORT_SCAN = 12;
const DASHBOARD_EXIT_GRACE_MS = 5000;
// start() 失败后由 getStatus 轮询驱动的重试冷却：SetupOverlay 1.5s 一轮，
// 不能每轮都扫端口+spawn。
const RESTART_COOLDOWN_MS = 10_000;
// web_dist（dashboard 前端）是 gitignore 的本机构建产物，git 安装不自带——
// 新机器上只要没人跑过一次不带 --skip-build 的构建就永远缺（R131 真机根因）。
// CLI 对这种情况 print 这个签名后 exit 1；命中则去掉 --skip-build 重试一次，
// 让 CLI 就地构建（npm install + vite build，一次性、分钟级）。
const WEB_DIST_MISSING = /no web dist found/i;
const BUILD_READY_TIMEOUT_MS = 300_000; // 构建路径的就绪窗（含 npm install）
const BUILD_RETRY_COOLDOWN_MS = 10 * 60_000; // 构建失败后的再试冷却（防自愈循环反复跑分钟级构建）
// Hermes 0.18+ 把 named-profile 的 dashboard 默认「统一路由」到机器级 server：
// CLI 自己 re-exec 成 `-p default dashboard --open-profile <name>`，HERMES_HOME
// 钉回机器根 ~/.hermes——于是每个 profile 端口上跑的都是 default 数据的
// dashboard，三个 agent 的 sessions/cron 串成同一份（0.18.2 真机实证）。
// `--isolated` 是官方逃生口，保住 per-profile server。老版 CLI 没有该 flag，
// argparse 直接 exit 2 并打印这个签名——命中则去掉 --isolated 重试一次
// （老版本没有统一路由，本来就是 per-profile 的）。
const UNRECOGNIZED_ISOLATED = /unrecognized arguments.*--isolated/i;

// Where Hermes puts a profile's state — mirrors its own layout: $HERMES_HOME (or
// ~/.hermes) for `default`, and <base>/profiles/<name> for a named profile. Used
// to prove a dashboard we didn't spawn is really serving the profile we want.
function hermesHomeForProfile(profile) {
  const base = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
  return profile === "default" ? base : path.join(base, "profiles", profile);
}

// Profile 名单的磁盘预测：`<base>/profiles/` 的子目录名 + default。权威来源仍是
// default dashboard 的 /api/profiles（只有它带 model/provider），但那要先把 default
// 起起来才能问 —— 于是 N 个进程的冷启动被排成两波。磁盘先给一份预测，让所有
// dashboard 一次并行拉起，default 就绪后再用权威列表校正（见 _reconcileProfiles）。
// 返回 null = 目录读不到（全新安装只有 default），调用方回退串行路径。
// **顺序必须确定**：profile→端口的映射跨启动要稳定，否则复用会整体错位、进程翻倍。
function discoverProfilesFromDisk() {
  const base = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
  let entries;
  try {
    entries = fs.readdirSync(path.join(base, "profiles"), { withFileTypes: true });
  } catch {
    return null;
  }
  const named = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
  return ["default", ...named];
}

function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => {
    try {
      return fs.realpathSync(String(p));
    } catch {
      return path.resolve(String(p));
    }
  };
  return norm(a) === norm(b);
}

function dashboardProcessGroupAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// Dashboards are spawned detached, making their PID the process-group id. Kill
// that group so CLI helpers/grandchildren cannot survive a cancelled lifecycle.
// Test doubles and non-POSIX fall back to ChildProcess.kill / positive PID.
function signalDashboardProcess(target, signal = "SIGTERM") {
  const pid = Number(typeof target === "number" ? target : target?.pid);
  if (Number.isInteger(pid) && pid > 1) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      /* no detached group / unsupported platform: fall through */
    }
  }
  try {
    if (typeof target?.kill === "function") return target.kill(signal) !== false;
    if (Number.isInteger(pid) && pid > 1) {
      process.kill(pid, signal);
      return true;
    }
  } catch {
    /* already gone */
  }
  return false;
}

// Resolve once the whole detached group is really gone. Waiting only for the
// direct child can leave its dashboard helpers alive after stop/reconfigure.
function waitForExit(proc, timeoutMs = DASHBOARD_EXIT_GRACE_MS) {
  const pid = Number(proc?.pid);
  if (!Number.isInteger(pid) || pid <= 1) {
    if (proc.exitCode !== null || proc.signalCode) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signalDashboardProcess(proc, "SIGKILL");
        resolve();
      }, timeoutMs);
      proc.once("exit", done);
      proc.once("error", done);
    });
  }
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let forcedAt = 0;
    let timer = null;
    const done = () => {
      if (timer) clearTimeout(timer);
      proc.removeListener?.("exit", check);
      proc.removeListener?.("error", check);
      resolve();
    };
    const check = () => {
      if (!dashboardProcessGroupAlive(pid)) {
        done();
        return;
      }
      const now = Date.now();
      if (!forcedAt && now - startedAt >= timeoutMs) {
        forcedAt = now;
        signalDashboardProcess(proc, "SIGKILL");
      } else if (forcedAt && now - forcedAt >= 1000) {
        done(); // bounded even if OS refuses the signal
        return;
      }
      timer = setTimeout(check, 25);
    };
    proc.once("exit", check);
    proc.once("error", check);
    check();
  });
}

// hermesRemotes[].baseUrl is documented as an http(s):// origin, but node:http
// throws on an https: URL and http.request() would happily talk plaintext to
// port 80. Pick the module (and therefore the default port) by protocol.
function requestModule(url) {
  try {
    return new URL(url).protocol === "https:" ? https : http;
  } catch {
    return http;
  }
}

/** 只保留条件写/分页协议需要的响应头，禁止把任意上游 header 扩散到业务层。 */
function responseHeaders(headers = {}) {
  const out = {};
  for (const key of ["etag", "x-hermes-conditional-write", "x-hermes-mutation-version", "x-total-count"]) {
    const value = headers[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** 附件下载额外需要的实体元数据；JSON 管道仍保持原白名单。 */
function rawResponseHeaders(headers = {}) {
  const out = responseHeaders(headers);
  for (const key of ["content-type", "content-disposition"]) {
    const value = headers[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

const HERMES_TEXT_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const HERMES_RAW_RESPONSE_MAX_BYTES = 25 * 1024 * 1024;

function hermesHttpError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Node request.setTimeout() 只约束 socket 静默时长，持续滴流可永久占住请求。
// 这里从发起请求起计绝对 deadline，并按原始字节累计响应上限。
function performHttpRequest(
  method,
  url,
  { headers = {}, payload = null, timeoutMs, maxResponseBytes, raw = false } = {},
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (error) reject(error);
      else resolve(value);
    };
    const req = requestModule(url).request(url, { method, headers }, (res) => {
      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxResponseBytes) {
        const error = hermesHttpError(
          "HERMES_RESPONSE_TOO_LARGE",
          `Hermes 响应超过 ${maxResponseBytes} 字节上限`,
        );
        finish(error);
        res.destroy();
        return;
      }
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        if (settled) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > maxResponseBytes) {
          const error = hermesHttpError(
            "HERMES_RESPONSE_TOO_LARGE",
            `Hermes 响应超过 ${maxResponseBytes} 字节上限`,
          );
          finish(error);
          res.destroy();
          req.destroy();
          return;
        }
        chunks.push(bytes);
      });
      res.on("aborted", () => finish(hermesHttpError("HERMES_RESPONSE_ABORTED", "Hermes 响应被中断")));
      res.on("error", (error) => finish(error));
      res.on("end", () => {
        const data = Buffer.concat(chunks, size);
        finish(null, {
          status: res.statusCode ?? 0,
          ...(raw ? { data } : { body: data.toString("utf8") }),
          headers: raw ? rawResponseHeaders(res.headers) : responseHeaders(res.headers),
        });
      });
    });
    req.on("error", (error) => finish(error));
    deadline = setTimeout(() => {
      const error = hermesHttpError(
        "HERMES_HTTP_DEADLINE_EXCEEDED",
        `Hermes 请求超过 ${timeoutMs}ms 总时限`,
      );
      req.destroy(error);
      finish(error);
    }, timeoutMs);
    if (payload) req.write(payload);
    req.end();
  });
}

/** GET helper 返回状态、正文和白名单响应头。 */
function httpGet(url, { token, timeoutMs = 4000, maxResponseBytes = HERMES_TEXT_RESPONSE_MAX_BYTES } = {}) {
  return performHttpRequest("GET", url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    timeoutMs,
    maxResponseBytes,
  });
}

// POST/PUT/DELETE with optional JSON body. (httpGet stays GET-only.)
function httpRequest(
  method,
  url,
  { token, body, timeoutMs = 6000, extraHeaders = {}, maxResponseBytes = HERMES_TEXT_RESPONSE_MAX_BYTES } = {},
) {
  const payload = body != null ? Buffer.from(JSON.stringify(body)) : null;
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (payload) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = payload.length;
  }
  for (const [name, value] of Object.entries(extraHeaders || {})) {
    const normalized = name.toLowerCase();
    if (["authorization", "content-length", "content-type"].includes(normalized)) {
      return Promise.reject(new TypeError(`禁止覆盖受保护请求头: ${normalized}`));
    }
    if (typeof value !== "string") {
      return Promise.reject(new TypeError("extraHeaders 只能包含字符串值"));
    }
    headers[name] = value;
  }
  return performHttpRequest(method, url, { headers, payload, timeoutMs, maxResponseBytes });
}

// 上游是 FastAPI，错误体形如 {"detail": "..."}。剥出人话，别把 HTTP 管道
// 原样甩给用户（官方前端的 parseApiErrorMessage 同款）。
function kanbanDetail(body) {
  try {
    const j = JSON.parse(body);
    if (typeof j?.detail === "string") return j.detail;
    if (typeof j?.detail?.message === "string") return j.detail.message;
  } catch { /* 非 JSON → 原样截断 */ }
  return String(body || "").slice(0, 300);
}

// 原始字节收发（附件用）：httpRequest 只会 JSON.stringify + 拼字符串响应，
// 二进制会被 UTF-8 解码毁掉。这里自带 Content-Type、Buffer 请求体与 Buffer 响应。
function httpRaw(
  method,
  url,
  { token, contentType, payload, timeoutMs = 30000, maxResponseBytes = HERMES_RAW_RESPONSE_MAX_BYTES } = {},
) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (payload) {
    headers["Content-Type"] = contentType || "application/octet-stream";
    headers["Content-Length"] = payload.length;
  }
  return performHttpRequest(method, url, {
    headers,
    payload,
    timeoutMs,
    maxResponseBytes,
    raw: true,
  });
}

// multipart/form-data 单文件体。Hermes 的上传端点是 `file: UploadFile = File(...)`，
// 只认 multipart——不能用 raw body 顶替。
function multipartFile(field, { filename, contentType, data }) {
  const boundary = `----shoggoth${randomBytes(12).toString("hex")}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${field}"; filename="${String(filename || "file").replace(/"/g, "")}"\r\n` +
    `Content-Type: ${contentType || "application/octet-stream"}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { contentType: `multipart/form-data; boundary=${boundary}`, payload: Buffer.concat([head, data, tail]) };
}

// 上游 kanban_db.KANBAN_ATTACHMENT_MAX_BYTES（25 MiB）。本地先拦一道，
// 免得白传 25MB 再被 413 打回来。
const HERMES_ATTACHMENT_MAX_BYTES = HERMES_RAW_RESPONSE_MAX_BYTES;

function attachmentFilename(disposition, fallback) {
  const value = String(disposition || "");
  const extended = /filename\*\s*=\s*(?:UTF-8)?'[^']*'([^;]+)/i.exec(value);
  if (extended) {
    const encoded = extended[1].trim().replace(/^"|"$/g, "");
    try {
      const decoded = decodeURIComponent(encoded);
      if (decoded) return decoded;
    } catch {
      // malformed RFC 5987 value: fall through to the basic filename/fallback
    }
  }
  const basic = /filename\s*=\s*(?:"((?:\\.|[^"])*)"|([^;]+))/i.exec(value);
  const decoded = (basic?.[1] || basic?.[2] || "").trim().replace(/\\"/g, '"');
  return decoded || fallback;
}

function hermesAttachments(rows) {
  return (Array.isArray(rows) ? rows : []).filter(Boolean).map((a) => ({
    id: String(a.id ?? ""),
    filename: a.filename || "",
    size: typeof a.size === "number" ? a.size : undefined,
    contentType: a.content_type || undefined,
    uploadedBy: a.uploaded_by || undefined,
    createdAt: epochSecToMs(a.created_at),
  }));
}

function cronTsToMs(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

// Same calendar day in local time (dashboard + UI share one machine).
function sameLocalDay(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

// Kanban timestamps are epoch SECONDS (int), not cron's ISO strings. Convert to
// JS ms; tolerate a value that's already in ms (>= ~1e12). undefined when absent.
function epochSecToMs(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
}

// Hermes 原始任务字段是 snake_case，这里统一转成前端可控的 camelCase 补丁。
function buildHermesCronUpdates(src = {}) {
  const updates = {};
  if (typeof src.name === "string") updates.name = src.name;
  if (typeof src.prompt === "string") updates.prompt = src.prompt;
  if (typeof src.deliver === "string") updates.deliver = src.deliver;
  if (typeof src.model === "string") updates.model = src.model || null;
  if (typeof src.provider === "string") updates.provider = src.provider || null;
  if (typeof src.baseUrl === "string") updates.base_url = src.baseUrl || null;
  if (typeof src.script === "string") updates.script = src.script || null;
  if (typeof src.noAgent === "boolean") updates.no_agent = src.noAgent;
  if (Array.isArray(src.skills)) updates.skills = src.skills;
  if (Array.isArray(src.contextFrom)) updates.context_from = src.contextFrom;
  if (Array.isArray(src.enabledToolsets)) updates.enabled_toolsets = src.enabledToolsets;
  if (typeof src.workdir === "string") updates.workdir = src.workdir || null;
  if (typeof src.profile === "string") updates.profile = src.profile || null;
  if ("repeat" in src) {
    if (typeof src.repeat === "number") {
      updates.repeat = { times: src.repeat > 0 ? src.repeat : null, completed: 0 };
    } else if (src.repeat && typeof src.repeat === "object") {
      updates.repeat = src.repeat;
    } else if (src.repeat === null) {
      updates.repeat = { times: null, completed: 0 };
    }
  }
  if (src.schedule) {
    updates.schedule = typeof src.schedule === "string" ? src.schedule : unifiedScheduleToHermesString(src.schedule);
  }
  return updates;
}

// 根据 Hermes 自动化字段生成 UI 可读的能力标签。
function hermesCronCapabilityTags(job) {
  const tags = [];
  if (job?.no_agent) tags.push("no-agent");
  if (job?.script) tags.push("script");
  const skills = Array.isArray(job?.skills) ? job.skills : job?.skill ? [job.skill] : [];
  if (skills.length) tags.push("skills");
  if (job?.workdir) tags.push("workdir");
  if (job?.profile) tags.push("profile");
  if (job?.context_from) tags.push("chained");
  return tags;
}

// Hermes job → UnifiedCronJob. Hermes schedule kinds (cron/interval/once) and
// ISO timestamps are mapped onto the unified superset (cron/every/at + ms).
function normalizeHermesCronJob(job, agentId) {
  const localId = String(job.id || "");
  const sched = job.schedule || {};
  let schedule;
  if (sched.kind === "interval") {
    schedule = { kind: "every", everyMs: (Number(sched.minutes) || 0) * 60000 };
  } else if (sched.kind === "once") {
    schedule = { kind: "at", at: sched.run_at || null };
  } else {
    schedule = { kind: "cron", expr: sched.expr || job.schedule_display || "" };
  }
  const skills = Array.isArray(job.skills) ? job.skills : job.skill ? [job.skill] : [];
  const contextFrom = Array.isArray(job.context_from)
    ? job.context_from
    : typeof job.context_from === "string"
      ? [job.context_from]
      : [];
  const enabledToolsets = Array.isArray(job.enabled_toolsets) ? job.enabled_toolsets : [];
  const capabilityTags = hermesCronCapabilityTags(job);
  return {
    id: `${agentId}:${localId}`,
    backendId: "hermes",
    agentId,
    name: job.name || localId,
    description: job.description || undefined,
    prompt: typeof job.prompt === "string" ? job.prompt : undefined,
    schedule,
    scheduleDisplay: job.schedule_display || sched.display || undefined,
    enabled: job.enabled !== false,
    state: job.state || undefined,
    stateLabel: job.state || (job.enabled === false ? "paused" : "scheduled"),
    // best-effort：Hermes cron 的 created_at 字段未实测，缺失则 null → 日历不按
    // 创建时间裁剪（行为不变）。与同域 last_run_at 一样按 ISO 解析。
    createdAt: cronTsToMs(job.created_at),
    lastRunAt: cronTsToMs(job.last_run_at),
    lastStatus: job.last_status || undefined,
    lastError: job.last_error || undefined,
    nextRunAt: cronTsToMs(job.next_run_at),
    model: job.model || undefined,
    provider: job.provider || undefined,
    baseUrl: job.base_url || undefined,
    deliver: job.deliver || undefined,
    script: job.script || undefined,
    noAgent: job.no_agent === true,
    repeat: job.repeat || undefined,
    skills,
    contextFrom,
    enabledToolsets,
    workdir: job.workdir || undefined,
    profile: job.profile || job.profile_name || undefined,
    backendDetails: {
      capabilityTags,
      profile: job.profile || job.profile_name || undefined,
      hermesHome: job.hermes_home || undefined,
      raw: {
        no_agent: job.no_agent,
        origin: job.origin,
        last_delivery_error: job.last_delivery_error,
        // Keep only the correlation fields; process ownership details from the
        // execution ledger are irrelevant to the management UI.
        latest_execution: job.latest_execution && typeof job.latest_execution === "object"
          ? {
              status: job.latest_execution.status,
              claimed_at: job.latest_execution.claimed_at,
              started_at: job.latest_execution.started_at,
              finished_at: job.latest_execution.finished_at,
            }
          : undefined,
      },
    },
    rawCapabilities: capabilityTags,
  };
}

// 官方 GET /api/cron/jobs/{id}/runs 的行是"会话"（SessionInfo）：started_at/ended_at
// 秒级 epoch、preview 摘要、无 per-run status。统一转 ms；无 started_at 的行丢弃。
function normalizeHermesRunRow(row) {
  const startedRaw = Number(row?.started_at) || 0;
  const startedAt = startedRaw > 1e12 ? startedRaw : startedRaw * 1000;
  if (!startedAt) return null;
  const endedRaw = Number(row?.ended_at) || 0;
  return {
    startedAt,
    finishedAt: endedRaw ? (endedRaw > 1e12 ? endedRaw : endedRaw * 1000) : undefined,
    summary: row.preview || undefined,
    sessionKey: row.id != null ? String(row.id) : undefined,
  };
}

const HERMES_CRON_LAST_RUN_GRACE_MS = 60_000;
const HERMES_CRON_EXECUTION_CLOCK_GRACE_MS = 1_000;

// Hermes' dashboard /runs endpoint is session-backed, while the scheduler's
// last_* fields are execution-backed. A run can fail before any session exists
// (model preflight, no-agent script, etc.), so an empty session list must still
// expose the authoritative latest execution outcome.
function synthesizeHermesLastRun(job) {
  const lastRunAt = Number.isFinite(job?.lastRunAt)
    ? Number(job.lastRunAt)
    : cronTsToMs(job?.last_run_at);
  const status = job?.lastStatus || job?.last_status || undefined;
  if (!lastRunAt && !status) return null;
  const execution = job?.latest_execution || job?.backendDetails?.raw?.latest_execution;
  const executionStatus = String(execution?.status || "").toLowerCase();
  const executionStartedAt = cronTsToMs(execution?.started_at || execution?.claimed_at);
  const executionFinishedAt = cronTsToMs(execution?.finished_at);
  // New Hermes versions expose a durable execution ledger. Use its full
  // interval only when it is terminal and clearly describes the same last_*
  // stamp; this makes arbitrarily slow delivery attributable without guessing.
  const executionBacked = !!(
    ["completed", "failed", "unknown"].includes(executionStatus)
    && executionStartedAt
    && executionFinishedAt
    && lastRunAt
    && Math.abs(executionFinishedAt - lastRunAt) <= 60_000
    && lastRunAt >= executionStartedAt - HERMES_CRON_EXECUTION_CLOCK_GRACE_MS
    && lastRunAt <= executionFinishedAt + HERMES_CRON_EXECUTION_CLOCK_GRACE_MS
  );
  const run = {
    startedAt: executionBacked ? executionStartedAt : lastRunAt || undefined,
    finishedAt: executionBacked ? executionFinishedAt : lastRunAt || undefined,
    status,
    error: job?.lastError || job?.last_error || undefined,
    deliveryStatus: (job?.backendDetails?.raw?.last_delivery_error || job?.last_delivery_error) ? "error" : undefined,
    deliveryError: job?.backendDetails?.raw?.last_delivery_error || job?.last_delivery_error || undefined,
    synthesized: true,
  };
  Object.defineProperty(run, "executionBacked", { value: executionBacked });
  return run;
}

// job.last_run_at is written when execution bookkeeping finishes, while a
// session row spans started_at..ended_at. New Hermes supplies a matching
// execution interval; older versions get a conservative ended-row + short
// grace fallback. An open row is never proof of identity (real stale NULL-ended
// rows exist), and a long ambiguous legacy delivery may duplicate a row rather
// than corrupt an unrelated historical run.
function mergeHermesLatestExecution(runs, latest) {
  if (!latest) return false;
  const latestStartedAt = Number(latest.startedAt);
  const latestFinishedAt = Number(latest.finishedAt);
  const match = runs.find((run) => {
    const startedAt = Number(run?.startedAt);
    const finishedAt = Number(run?.finishedAt);
    if (!(Number.isFinite(startedAt) && startedAt > 0
      && Number.isFinite(finishedAt) && finishedAt > 0)) return false;
    if (latest.executionBacked) {
      return startedAt >= latestStartedAt - HERMES_CRON_EXECUTION_CLOCK_GRACE_MS
        && startedAt <= latestFinishedAt + HERMES_CRON_EXECUTION_CLOCK_GRACE_MS;
    }
    return Number.isFinite(latestStartedAt) && latestStartedAt > 0
      && latestStartedAt >= startedAt
      && latestStartedAt <= finishedAt + HERMES_CRON_LAST_RUN_GRACE_MS;
  });
  if (match) {
    for (const field of ["status", "error", "deliveryStatus", "deliveryError"]) {
      if (latest[field] !== undefined) match[field] = latest[field];
    }
    return false;
  }
  runs.push(latest);
  runs.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return true;
}

// UnifiedCronJob.schedule → the schedule STRING Hermes' create endpoint expects.
function unifiedScheduleToHermesString(schedule) {
  const s = schedule || {};
  if (s.kind === "every" && Number(s.everyMs) > 0) {
    return `every ${Math.round(Number(s.everyMs) / 60000)}m`;
  }
  if (s.kind === "at" && s.at) {
    return String(s.at);
  }
  return String(s.expr || "").trim();
}

const SESSION_TOKEN_RE = /__HERMES_SESSION_TOKEN__="([^"]+)"/;

async function scrapeToken(baseUrl) {
  const { status, body } = await httpGet(`${baseUrl}/`);
  if (status !== 200) {
    return null;
  }
  const match = SESSION_TOKEN_RE.exec(body);
  return match ? match[1] : null;
}

// ACP `session/load` can only RESUME sessions the acp adapter itself created
// (source=acp, UUID ids). Sessions from other Hermes platforms — telegram/cli
// (ids like "20260529_114930_…") and cron ("cron_…") — are reported "not found"
// by the adapter, but only as a WARNING, so the load looks like it succeeds and
// the next prompt silently refuses with zero output → the opaque "returned no
// text" error. So only a UUID tail is resumable; for anything else we start a
// fresh acp session (which actually works) instead of trying to load it.
function isResumableAcpSessionId(tail) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(tail || ""));
}

// Flatten an ACP tool_call(_update) `content` (ToolCallContent[] — text blocks,
// diffs, etc.) into a display string. Best-effort: falls back to JSON so the chat
// tool card always shows *something* even for shapes we don't special-case.
function acpToolText(content) {
  if (content == null) return undefined;
  if (typeof content === "string") return content;
  try {
    if (Array.isArray(content)) {
      const texts = content
        .map((c) => c?.content?.text ?? c?.text ?? (typeof c === "string" ? c : ""))
        .filter(Boolean);
      if (texts.length) return texts.join("\n");
    }
    return JSON.stringify(content);
  } catch {
    return undefined;
  }
}

// Extract a file-edit diff from an ACP tool_call content array, if present.
// Hermes emits FileEditToolCallContent {type:"diff", path, oldText, newText} for
// write_file/patch when the edit is auto-approved (acp/helpers.tool_diff_content).
function acpToolDiff(content) {
  if (!Array.isArray(content)) return undefined;
  const d = content.find((c) => c && c.type === "diff");
  if (!d) return undefined;
  return {
    path: String(d.path ?? d.location ?? ""),
    oldText: String(d.oldText ?? d.old_text ?? ""),
    newText: String(d.newText ?? d.new_text ?? ""),
  };
}

// ---- MoA 配置 camel↔snake 转换（R286）----
// 只转换已知字段；未知字段原样透传（round-trip 不丢）；presets 的键是用户起的
// 预设名（数据不是字段），绝不做大小写转换。
const MOA_PRESET_KEY_PAIRS = [
  ["aggregator_temperature", "aggregatorTemperature"],
  ["degraded_reference_policy", "degradedReferencePolicy"],
  ["max_tokens", "maxTokens"],
  ["reference_temperature", "referenceTemperature"],
  ["reference_max_tokens", "referenceMaxTokens"],
  ["reference_timeout", "referenceTimeout"],
];

function moaSlotToCamel(slot) {
  if (!slot || typeof slot !== "object") return { provider: "", model: "" };
  const { reasoning_effort: reasoningEffort, ...rest } = slot;
  return {
    ...rest,
    provider: String(slot.provider || ""),
    model: String(slot.model || ""),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  };
}

function moaSlotToSnake(slot) {
  if (!slot || typeof slot !== "object") return { provider: "", model: "" };
  const { reasoningEffort, ...rest } = slot;
  return {
    ...rest,
    provider: String(slot.provider || ""),
    model: String(slot.model || ""),
    ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
  };
}

function moaPresetConvert(preset, toCamel) {
  if (!preset || typeof preset !== "object") return preset;
  const out = { ...preset };
  for (const [snake, camel] of MOA_PRESET_KEY_PAIRS) {
    const from = toCamel ? snake : camel;
    const to = toCamel ? camel : snake;
    if (from in out) {
      out[to] = out[from];
      delete out[from];
    }
  }
  const slotsFrom = toCamel ? "reference_models" : "referenceModels";
  const slotsTo = toCamel ? "referenceModels" : "reference_models";
  if (slotsFrom in out) {
    const slots = Array.isArray(out[slotsFrom]) ? out[slotsFrom] : [];
    out[slotsTo] = slots.map((slot) => (toCamel ? moaSlotToCamel(slot) : moaSlotToSnake(slot)));
    delete out[slotsFrom];
  }
  if ("aggregator" in out) {
    out.aggregator = toCamel ? moaSlotToCamel(out.aggregator) : moaSlotToSnake(out.aggregator);
  }
  return out;
}

function moaConfigToCamel(j) {
  if (!j || typeof j !== "object") return null;
  // 顶层沿用官方形状：presets 字典 + default/active 指针 + 顶层遗留平铺字段。
  const out = moaPresetConvert(j, true);
  if ("default_preset" in out) {
    out.defaultPreset = String(out.default_preset || "");
    delete out.default_preset;
  }
  if ("active_preset" in out) {
    out.activePreset = String(out.active_preset || "");
    delete out.active_preset;
  }
  const presets = {};
  if (out.presets && typeof out.presets === "object") {
    for (const [name, preset] of Object.entries(out.presets)) {
      presets[name] = moaPresetConvert(preset, true);
    }
  }
  out.presets = presets;
  delete out.ok; // PUT 响应的 ok 标志不属于配置本体
  return out;
}

function moaConfigToSnake(config) {
  if (!config || typeof config !== "object") return {};
  const out = moaPresetConvert(config, false);
  if ("defaultPreset" in out) {
    out.default_preset = String(out.defaultPreset || "");
    delete out.defaultPreset;
  }
  if ("activePreset" in out) {
    out.active_preset = String(out.activePreset || "");
    delete out.activePreset;
  }
  const presets = {};
  if (out.presets && typeof out.presets === "object") {
    for (const [name, preset] of Object.entries(out.presets)) {
      presets[name] = moaPresetConvert(preset, false);
    }
  }
  out.presets = presets;
  return out;
}

// Agent ids must survive the UI's normalizeAgentId() unchanged so chat routing
// matches: lowercase, [a-z0-9-] only.
function agentIdForProfile(name) {
  const safe = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${ID_PREFIX}${safe || "default"}`;
}

// Hermes kanban 端点的可选 ?board=（多板贯穿，KAN-005/006）。joiner 视已有
// query 传 "?" 或 "&"；无 board 时返回空串（current board 语义不变）。
function kanbanBoardQ(opts, joiner = "?") {
  const b = opts?.board;
  return b ? `${joiner}board=${encodeURIComponent(b)}` : "";
}

function rowFromSession(session, agentId) {
  const hermesId = String(session.id || "");
  const title = typeof session.title === "string" && !hasFederationPromptMarker(session.title)
    ? session.title.trim() : "";
  const preview = typeof session.preview === "string" && !hasFederationPromptMarker(session.preview)
    ? session.preview.trim() : "";
  const displayName =
    title ||
    preview.slice(0, 60) ||
    hermesId;
  const updatedAt = Math.round(
    (Number(session.last_active) || Number(session.started_at) || 0) * 1000,
  );
  return {
    key: `agent:${agentId}:${hermesId}`,
    backendId: "hermes",
    agentId,
    kind: session.source === "cron" ? "cron" : "direct",
    label: displayName,
    displayName,
    subject: preview ? preview.slice(0, 200) : undefined,
    updatedAt: updatedAt || null,
    sessionId: hermesId,
    startedAt: Number(session.started_at) ? Math.round(session.started_at * 1000) : undefined,
    endedAt: Number(session.ended_at) ? Math.round(session.ended_at * 1000) : undefined,
    model: typeof session.model === "string" ? session.model : undefined,
    permissionMode: session.yolo === true ? "yolo" : "inherit",
    inputTokens: Number(session.input_tokens) || undefined,
    outputTokens: Number(session.output_tokens) || undefined,
    totalTokens:
      (Number(session.input_tokens) || 0) + (Number(session.output_tokens) || 0) || undefined,
  };
}

class HermesBackend extends AgentBackend {
  get id() { return "hermes"; }
  get name() { return "Hermes"; }

  getBackendDescriptor() {
    return {
      id: this.id,
      name: this.name,
      connectionMode: "managed-service",
      disconnectable: true,
      agentLifecycle: {
        create: true, update: true, remove: true, archive: false, restore: false, readStates: false,
      },
      surfaces: {
        chat: true,
        agents: true,
        models: true,
        skills: true,
        usage: true,
        oauth: true,
        dashboardRuns: false,
        agentHarness: false,
        cron: { kind: "hermes" },
        kanban: { kind: "hermes" },
      },
    };
  }

  constructor({ port = DEFAULT_PORT, bin = HERMES_BIN, getConfig, modelMutationGate } = {}) {
    super();
    // 所有 Provider/Main/Aux/Cron 模型写共享一个 per-profile gate；条件快照只在
    // fresh GET 后建立，dashboard 拓扑变化或缺 header 时保持 fail-closed。
    this._modelMutationGate = modelMutationGate || createHermesModelMutationGate();
    this._providerMutationSnapshots = new Map();
    this._modelChangeAdapter = null;
    this.startPort = port;
    this.bin = bin;
    // Connection mode comes from app config: "local" spawns dashboards, "remote"
    // connects to already-running ones (see reconfigure()/_remoteDashboards()).
    this._getConfig = typeof getConfig === "function" ? getConfig : () => ({ hermesMode: "local", hermesRemotes: [] });
    this.agents = [];
    this.profileById = new Map(); // agentId -> profileName
    this._profileNames = new Set(); // authoritative raw names, including identities rejected as ambiguous
    this.profileIdentityCollisions = [];
    this._cliUsageCache = null; // { sig, at, data }; smooths the per-session terminal-tool scan
    this._cliUsageScanInFlight = null; // Promise | null; 单飞后台重扫（SWR，R106）
    this._skillUsageCache = null; // { sig, at, data }; 同上，用于 skill_view 扫描
    this._skillUsageScanInFlight = null; // Promise | null; 同上
    // 已结束 cron session 的最终 assistant 摘要不可变；Dashboard 总览与活动流
    // 会连续读取两次，缓存可避免每轮轮询重复 fan-out 到 messages 端点。
    this._cronRunSummaryCache = new Map(); // baseUrl+profile+sessionId -> ≤2000 chars
    this._cronRunSummaryInflight = new Map(); // 同 key 的并发请求单飞
    // One dashboard per profile: profileName -> { port, token, proc, spawned }.
    this.dashboards = new Map();
    // 最近一次 start 失败原因（如「未找到 hermes 命令」），getStatus 在未连通时
    // 透出为 info.error，SetupOverlay/设置页据此给指引；连通后清空。
    this.lastError = null;
    this._restartInFlight = null; // 自愈重启单飞句柄（见 _retryStartSoon）
    this._lastRestartAt = 0;
    this._startingAt = 0; // start() 进行中的时间戳，getStatus 报「正在启动」用
    this._webBuildAttemptAt = 0; // 最近一次 web_dist 缺失 fallback 构建的时间（冷却用）
    // Chat (ACP) state — one ACP client per profile, lazy.
    this.acpClients = new Map();
    this.acpSessionByKey = new Map(); // sessionKey -> { profile, acpSessionId }
    this.transcripts = new Map();     // sessionKey -> [{role, content:[{type:"text",text}]}]
    // Canonical sessions created eagerly but not persisted until their first
    // prompt is accepted. Rename/delete must keep treating them as local-only
    // until then, even though gateway/ACP runtime mappings already exist.
    this.freshSessionKeys = new Set();
    // Runtime mappings may disappear on a child/socket exit. Keep the minting
    // transport separately so a fresh canonical key can never be rebound to a
    // second stored identity before its first prompt persists it.
    this.freshSessionTransports = new Map(); // sessionKey -> "gateway" | "acp"
    this.sessionWorkspaceByKey = new Map(); // sessionKey -> confirmed execution cwd
    // Per-session send queue: chains sendMessage calls so concurrent sends are
    // serialized (second message waits for first ACP round-trip to finish).
    this.sendQueues = new Map();      // sessionKey -> Promise (tail of queue)
    this._idempotentSends = new Map(); // JSON([sessionKey,key]) -> in-flight/settled execution
    // Chat (gateway /api/ws) state — S2: the official desktop's transport. One
    // persistent socket per profile; ACP above stays as the fallback when the
    // dashboard predates /api/ws (or SHOGGOTH_HERMES_CHAT=acp forces it).
    this.gwSockets = new Map();       // profile -> HermesGatewaySocket
    this.gwRuntimeByKey = new Map();  // sessionKey -> { profile, runtimeId, storedId, generation }
    this.gwKeyByRuntime = new Map();  // runtimeId -> sessionKey (event routing)
    this.gwTurns = new Map();         // runtimeId -> live turn state (hooks, accumulators)
    this.gwUsageByKey = new Map();    // sessionKey -> last cumulative usage snapshot (per-turn deltas)
    this.gwChatDisabledUntil = new Map(); // profile -> ts;网关拨号失败后的 ACP 降级 TTL
    this.sessionLiveMeta = new Map(); // sessionKey -> {model, reasoningEffort, fast, contextUsed, contextMax} (session.info)
    this.sessionRows = [];            // aggregated GatewaySessionRow[] across profiles
    // false = 当前 rows 只是启动/失败窗口里的局部快照，proxy 必须让 UI 保留缓存中
    // 尚未出现的 Hermes 行；只有 start 全流程完成后才转 true。
    this._sessionRowsComplete = false;
    this.sessionsRefreshTimer = null;
    this._lifecycleGeneration = 0;     // stop/reconfigure 代际，阻止旧异步结果回写新模式
    this._startInFlight = null;        // { generation, promise }，同代际 start 单飞
    this._pendingDashboardProcs = new Set(); // spawn 后、写入 dashboards 前也受 stop 管理
    // status 探测单飞同时绑定 lifecycle 与 dashboard 对象身份；旧进程的 200
    // 迟到时不能映射到新一代同名 profile（否则发送门禁会被错误放开）。
    this._statusRowsInFlight = null;   // { generation, topology, promise<snapshot> } | null
    // ModelChoice[] aggregated from each profile's /api/model/options so the
    // OpenClaw chat-model dropdown can resolve + display Hermes models.
    this.modelChoices = [];
    // Shared in-flight refreshModelChoices() promise (null when idle), so
    // concurrent callers coalesce instead of stacking parallel fan-outs.
    this._modelsRefreshing = null;
    // 运行时目录刷新代际与提交屏障：迟到的旧刷新只能返回自身结果，不能覆盖新缓存。
    this._modelCatalogRefreshGeneration = 0;
    this._modelCatalogCommittedGeneration = 0;
    this._modelCatalogEpoch = 0; // apply 成功推进；旧 refresh 捕获的 epoch 不得回写。
    this.catalogRevision = null;
    // profile name -> string[] of model ids available in that profile, used to
    // populate each agent's model.fallbacks so the UI can filter the dropdown
    // per active agent.
    this.modelsByProfile = new Map();
    // profile -> Set<provider+modelId 复合键>。对外 fallback 仍使用裸 id，但删除
    // 单个 provider 的同名模型时必须依赖这份身份集合按 profile 精确重新派生。
    this.modelsByProfileIdentity = new Map();
    // profile -> 上一轮已提交的 per-profile snapshot。commit 是整体替换，缺席的
    // profile 会被清空，所以本轮失败的 profile 要靠它补位（见 _refreshModelChoicesNow）。
    this._modelCatalogProfileSnapshots = new Map();
    // 自定义 providers 配置的 SWR 缓存（profile -> providers dict）+ in-flight 合并，
    // 见 _readProvidersByProfile。
    this._providersByProfile = null;
    this._providersRefreshing = null;
    // token 续期的单飞表（baseUrl -> in-flight Promise），见 _renewDashToken。
    this._tokenRenewals = new Map();
    // Provider 配置读取使用独立代际/提交屏障，避免普通 SWR 迟到覆盖 strict fresh 真值。
    this._providerRefreshGeneration = 0;
    this._providerCommittedGeneration = 0;
    // 仅在某 Profile 已证明支持 /api/env 后，后续严格目录读取失败才 fail-closed；
    // 从未支持该端点的旧 dashboard 保持稳定无 env 摘要。
    this._envCatalogSupportedProfiles = new Set();
    // 官方 `hermes update` 只换磁盘上的代码（git pull + 重装依赖）；本地 spawn
    // 的 dashboard 进程要重启才跑新版本，所以成功后 stop+start 一轮。
    // 状态落盘：更新失败的原因不能随 app 重启蒸发。
    this._selfUpdater = new SelfUpdater({
      command: () => ({ cmd: this.bin, args: ["update", "--yes"] }),
      statePath: path.join(os.homedir(), ".shoggoth", "self-update", "hermes.json"),
      onSuccess: async () => {
        if (this._getConfig().hermesMode === "remote") return;
        await this.stop();
        // start() 失败返回 false 不抛错（聚合层的 fail-soft 口径）；更新收尾
        // 必须把「服务没回来」上报成失败，否则用户只看到卡片裸连接错。
        const ok = await this.start();
        if (!ok) throw new Error(this.lastError || "hermes dashboard did not come back after update");
      },
    });
  }

  // 保持既有 agent ID 编码不变；一旦两个原名归一化到同一 ID，就把该 ID 的
  // 所有候选都从路由表移除（fail-closed），避免 last-wins 把请求发给错误 profile。
  _installProfileRows(rows) {
    const byName = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const source = typeof row === "string" ? { name: row } : row;
      const name = String(source?.name || "").trim();
      if (!name) continue;
      byName.set(name, { ...source, name });
    }
    this._profileNames = new Set(byName.keys());
    const namesById = new Map();
    for (const name of this._profileNames) {
      const id = agentIdForProfile(name);
      const names = namesById.get(id) || [];
      names.push(name);
      namesById.set(id, names);
    }
    this.profileIdentityCollisions = [...namesById.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([agentId, profiles]) => ({ agentId, profiles: [...profiles].sort() }))
      .sort((a, b) => a.agentId.localeCompare(b.agentId));
    const ambiguous = new Set(this.profileIdentityCollisions.map((row) => row.agentId));
    this.profileById = new Map();
    this.agents = [];
    for (const profile of byName.values()) {
      const id = agentIdForProfile(profile.name);
      if (ambiguous.has(id)) continue;
      this.profileById.set(id, profile.name);
      this.agents.push({
        id,
        name: `${profile.name} · Hermes`,
        model: typeof profile.model === "string" ? profile.model : undefined,
        provider: typeof profile.provider === "string" ? profile.provider : undefined,
      });
    }
  }

  _assertProfileIdentityAvailable(name, exceptProfile = null) {
    const candidate = String(name || "").trim();
    const agentId = agentIdForProfile(candidate);
    const conflict = [...this._profileNames].find(
      (profile) => profile !== exceptProfile && agentIdForProfile(profile) === agentId,
    );
    if (!conflict) return;
    const error = new Error(`hermes: profile「${candidate}」与现有 profile 的 agent ID ${agentId} 冲突`);
    error.code = "ERR_HERMES_PROFILE_ID_COLLISION";
    error.agentId = agentId;
    throw error;
  }

  // 包装出「启动中」窗口：getStatus 在窗口内报「正在启动」而不是
  // 「未检测到」（spawn→ready 有数秒窗，误报会让首启用户以为失败）。
  async start(hooks) {
    const generation = this._lifecycleGeneration;
    if (this._startInFlight?.generation === generation) return this._startInFlight.promise;
    this._sessionRowsComplete = false;
    this._startingAt = Date.now();
    let promise;
    promise = this._startImpl(hooks, generation)
      .then((ready) => {
        if (generation !== this._lifecycleGeneration) return false;
        this._sessionRowsComplete = ready === true;
        return ready;
      })
      .finally(() => {
        if (this._startInFlight?.promise === promise) this._startInFlight = null;
        if (generation === this._lifecycleGeneration) this._startingAt = 0;
      });
    this._startInFlight = { generation, promise };
    return promise;
  }

  // 分批就绪的发布器（契约 AgentBackend.start 的 onPartialReady）：本地模式下
  // 每个 profile 是一个独立的 Python dashboard 进程，冷启动各要数秒，串行等完
  // 全部才广播的话 UI 要空等一二十秒。每有一个 dashboard 认领成功就重拉一次
  // 会话（聊天页的 agent 名单是从 sessions 派生的，光有 getAgents 不够）并广播。
  // 串行成链 + 合并抖动：refreshSessions 是「遍历当前 dashboards 全量重建」，
  // 串行保证晚的结果不被早的覆盖，抖动让同时就绪的多个 profile 只重拉一次。
  _makeReadyPublisher(hooks, generation = this._lifecycleGeneration) {
    const notify = hooks?.onPartialReady;
    if (typeof notify !== "function") {
      const publish = () => {};
      publish.drain = () => Promise.resolve();
      return publish;
    }
    let chain = Promise.resolve();
    let queued = false;
    const publish = () => {
      if (generation !== this._lifecycleGeneration) return;
      if (queued) return; // 已排队的那次会带上届时最新的 dashboards
      queued = true;
      chain = chain.then(async () => {
        queued = false;
        if (generation !== this._lifecycleGeneration) return;
        await this.refreshSessions().catch(() => {});
        if (generation !== this._lifecycleGeneration) return;
        try { notify(); } catch { /* 广播失败不影响启动 */ }
      });
    };
    // 最终权威刷新必须等所有局部刷新落盘，避免慢的旧结果反向覆盖完整列表。
    publish.drain = () => chain;
    return publish;
  }

  async _startImpl(hooks, generation = this._lifecycleGeneration) {
    const cfg = this._getConfig();
    if (cfg.hermesMode === "remote") {
      return this._startRemote(cfg, generation);
    }
    console.log(`[hermes] bin=${this.bin}`);
    this.lastError = null;
    // Ports reserved by this start() pass, so parallel scans don't collide.
    const claimed = new Set();
    const publishReady = this._makeReadyPublisher(hooks, generation);
    // 1-3) 全部 dashboard 就绪。磁盘能给出 profile 名单就一次并行拉起；给不出
    // （目录不存在=只有 default）就走原来的串行路径。
    const predicted = discoverProfilesFromDisk();
    const defaultDash = predicted
      ? await this._startDashboardsParallel(predicted, claimed, publishReady, generation)
      : await this._startDashboardsSerial(claimed, publishReady, generation);
    if (generation !== this._lifecycleGeneration) return false;
    if (!defaultDash) {
      if (!this.lastError) this.lastError = "本地 hermes dashboard 启动失败";
      return false;
    }
    // 4) sessions + model choices across all dashboards.
    await publishReady.drain();
    if (generation !== this._lifecycleGeneration) return false;
    await Promise.all([
      this.refreshSessions().catch(() => {}),
      this.refreshModelChoices().catch(() => {}),
    ]);
    if (generation !== this._lifecycleGeneration) return false;
    if (this.sessionsRefreshTimer) clearInterval(this.sessionsRefreshTimer);
    this.sessionsRefreshTimer = setInterval(
      () => this.refreshSessions().catch(() => {}),
      SESSIONS_REFRESH_MS,
    );
    return true;
  }

  // 原串行路径：default 起来 → 问它要 profile 名单 → 再起其余。磁盘给不出名单时
  // （全新安装还没有 profiles/ 目录）用它，此时通常也只有 default 一个，等价。
  // 返回 default 的 dashboard，失败返回 null。
  async _discardStartedDashboard(dash) {
    if (!dash?.spawned || !dash.proc) return;
    const exited = waitForExit(dash.proc);
    signalDashboardProcess(dash.proc);
    await exited;
  }

  async _commitStartedDashboard(profile, dash, generation) {
    if (!dash) return false;
    if (generation !== this._lifecycleGeneration) {
      await this._discardStartedDashboard(dash);
      return false;
    }
    this.dashboards.set(profile, dash);
    return true;
  }

  async _startDashboardsSerial(claimed, publishReady, generation) {
    const defaultDash = await this._spawnOrReuseDashboard("default", this.startPort, claimed, generation);
    if (!defaultDash) return null;
    if (!(await this._commitStartedDashboard("default", defaultDash, generation))) return null;
    // 非 default profile 失败只降级为少一个 agent，不算后端级错误。
    this.lastError = null;
    await this._refreshAgentsFor(defaultDash, generation).catch(() => {});
    if (generation !== this._lifecycleGeneration) return null;
    // default 已能服务：先让它的 agent/会话在 UI 露面，别陪其余 profile 冷启动等。
    publishReady();
    const others = [...this._profileNames].filter((p) => p !== "default");
    await Promise.all(
      others.map(async (profile, idx) => {
        try {
          const dash = await this._spawnOrReuseDashboard(profile, this.startPort + 1 + idx, claimed, generation);
          if (await this._commitStartedDashboard(profile, dash, generation)) {
            publishReady();
          }
        } catch {
          /* skip on failure */
        }
      }),
    );
    return defaultDash;
  }

  // 并行路径：profile 名单来自磁盘预测，所有 dashboard 一次拉起，不必先等 default
  // 就绪再问 /api/profiles —— 那一问把 N 个 Python 进程的冷启动排成两波。
  // 端口沿用既有映射（default=startPort，其余按名单序 +1…），跨启动稳定才复用得上。
  async _startDashboardsParallel(profiles, claimed, publishReady, generation) {
    // 临时 agent 表（只有名字，没有 model/provider）：publishReady → refreshSessions
    // 靠 profileById 反查 agentId，不先填这份，比 default 先就绪的 profile 会整个
    // 查不到、白就绪一次。default 就绪后 _refreshAgentsFor 用权威列表重建并补 model。
    if (generation !== this._lifecycleGeneration) return null;
    this._installProfileRows(profiles);
    let defaultDash = null;
    let defaultError = null;
    await Promise.all(
      profiles.map(async (profile, idx) => {
        let dash = null;
        try {
          dash = await this._spawnOrReuseDashboard(profile, this.startPort + idx, claimed, generation);
        } catch (e) {
          if (profile === "default") defaultError = e?.message || String(e);
          return;
        }
        if (!dash) {
          if (profile === "default") defaultError = this.lastError;
          return;
        }
        if (!(await this._commitStartedDashboard(profile, dash, generation))) return;
        if (profile === "default") {
          defaultDash = dash;
          // 非 default profile 失败只降级为少一个 agent，不算后端级错误。
          this.lastError = null;
          // 权威校正：model/provider 只有 /api/profiles 有，profile 集合也以它为准。
          await this._refreshAgentsFor(dash, generation).catch(() => {});
          if (generation !== this._lifecycleGeneration) return;
        }
        publishReady();
      }),
    );
    if (!defaultDash) {
      this.lastError = defaultError || this.lastError;
      return null;
    }
    await this._reconcileProfiles(profiles.length, claimed, publishReady, generation);
    return defaultDash;
  }

  // 磁盘预测与 /api/profiles 权威列表的差集兜底（实测两者一致，这里只防边界）：
  // 权威有而没起的补拉；起了但权威不认的停掉——否则会留下一个不在任何列表里、
  // 谁也管不到的孤儿进程。
  async _reconcileProfiles(predictedCount, claimed, publishReady, generation = this._lifecycleGeneration) {
    if (generation !== this._lifecycleGeneration) return;
    const authoritative = new Set(this._profileNames);
    const missing = [...authoritative].filter((p) => !this.dashboards.has(p));
    const extra = [...this.dashboards.keys()].filter((p) => !authoritative.has(p));
    if (missing.length === 0 && extra.length === 0) return;
    console.log(
      `[hermes] profile 磁盘预测与权威列表不一致 → 补拉 [${missing.join(",")}] / 停掉 [${extra.join(",")}]`,
    );
    for (const profile of extra) {
      const dash = this.dashboards.get(profile);
      this.dashboards.delete(profile);
      if (dash?.spawned && dash.proc) {
        const exited = waitForExit(dash.proc);
        signalDashboardProcess(dash.proc);
        await exited;
      }
    }
    await Promise.all(
      missing.map(async (profile, idx) => {
        try {
          const dash = await this._spawnOrReuseDashboard(
            profile,
            this.startPort + predictedCount + idx,
            claimed,
            generation,
          );
          if (await this._commitStartedDashboard(profile, dash, generation)) {
            publishReady();
          }
        } catch {
          /* 少一个 agent，不算后端失败 */
        }
      }),
    );
  }

  // Remote mode: connect to already-running dashboards (no spawn). Each config
  // remote {profile, baseUrl, token} becomes one agent/profile.
  async _startRemote(cfg, generation = this._lifecycleGeneration) {
    const remotes = Array.isArray(cfg.hermesRemotes) ? cfg.hermesRemotes : [];
    if (remotes.length === 0) {
      console.warn("[hermes] remote 模式但未配置任何远程 dashboard");
      this.lastError = "remote 模式未配置任何远程 dashboard";
      this.dashboards = new Map();
      this._installProfileRows([]);
      return false;
    }
    this.lastError = null;
    const dashboards = new Map();
    const profileRows = [];
    await Promise.all(
      remotes.map(async (r) => {
        const baseUrl = String(r.baseUrl || "").replace(/\/+$/, "");
        if (!baseUrl) return;
        let token = r.token || null;
        if (!token) token = await scrapeToken(baseUrl).catch(() => null);
        const profile = r.profile || "default";
        dashboards.set(profile, { profile, baseUrl, token, proc: null, spawned: false });
        profileRows.push({ name: profile });
      }),
    );
    if (generation !== this._lifecycleGeneration) return false;
    this.dashboards = dashboards;
    this._installProfileRows(profileRows);
    console.log(`[hermes] remote 模式: ${dashboards.size} 个 dashboard`);
    await Promise.all([
      this.refreshSessions().catch(() => {}),
      this.refreshModelChoices().catch(() => {}),
    ]);
    if (generation !== this._lifecycleGeneration) return false;
    if (this.sessionsRefreshTimer) clearInterval(this.sessionsRefreshTimer);
    this.sessionsRefreshTimer = setInterval(
      () => this.refreshSessions().catch(() => {}),
      SESSIONS_REFRESH_MS,
    );
    return dashboards.size > 0;
  }

  // Apply a config change (local↔remote, or edited remotes) on the fly.
  async reconfigure() {
    await this.stop();
    return this.start();
  }

  // Probe a candidate connection without persisting (设置 page Test button).
  async testConnection(spec = {}) {
    const baseUrl = String(spec.baseUrl || "").replace(/\/+$/, "");
    if (baseUrl) {
      let token = spec.token || (await scrapeToken(baseUrl).catch(() => null));
      const { status } = await httpGet(`${baseUrl}/api/status`, { token, timeoutMs: 5000 }).catch(
        () => ({ status: 0 }),
      );
      if (status === 200) return { ok: true, info: { baseUrl, tokenResolved: !!token } };
      // Reached the host but got rejected → auth, not "no response". Saying
      // "无响应" for a 401 sends the user chasing the wrong problem.
      if (status === 401 || status === 403) {
        return { ok: false, error: `远程 dashboard 鉴权失败 (HTTP ${status})，请检查 Token` };
      }
      return {
        ok: false,
        error: status === 0 ? "远程 dashboard 无响应（连接失败或超时）" : `远程 dashboard 无响应 (HTTP ${status})`,
      };
    }
    // No baseUrl → probe the live local default dashboard.
    const dash = this._defaultDash();
    if (!dash) return { ok: false, error: "本地没有运行中的 Hermes dashboard" };
    const { status } = await httpGet(`${dash.baseUrl}/api/status`, { token: dash.token }).catch(
      () => ({ status: 0 }),
    );
    return status === 200
      ? { ok: true, info: { baseUrl: dash.baseUrl } }
      : { ok: false, error: `本地 dashboard 无响应 (HTTP ${status})` };
  }

  /**
   * Pull each profile's `/api/model/options` (provider list with their model
   * ids) and flatten into ModelChoice[] for the proxy to merge into the
   * OpenClaw `models.list` response. Dedup by provider + id across profiles.
   */
  async refreshModelChoices({ fresh = false, requireComplete = false, returnSnapshot = false } = {}) {
    // strict fresh 必须独占一轮真实 fan-out，不能复用普通 SWR 的 in-flight。
    // 否则 GET snapshot 可能把普通刷新捕获的旧/残缺目录误当 fresh 真值。
    if (fresh && requireComplete) {
      return this._refreshModelChoicesNow({ requireComplete: true, returnSnapshot });
    }
    // Coalesce concurrent refreshes onto one in-flight pass. getModels fires a
    // background refresh per /__api/models hit (= one per session click in the
    // chat UI); overlapping passes would race last-writer-wins on
    // modelChoices/modelMeta, letting a stale/partial late finisher overwrite a
    // newer complete catalog.
    if (!this._modelsRefreshing) {
      this._modelsRefreshing = this._refreshModelChoicesNow().finally(() => {
        this._modelsRefreshing = null;
      });
    }
    return this._modelsRefreshing;
  }

  async _refreshModelChoicesNow({ requireComplete = false, returnSnapshot = false } = {}) {
    // 每轮在首个 await 前领取唯一代际；提交时只允许不早于当前屏障的结果。
    const refreshGeneration = ++this._modelCatalogRefreshGeneration;
    const modelCatalogEpoch = this._modelCatalogEpoch;
    // strict 一旦领取代际就建立提交屏障；即使本轮随后 503，旧 ordinary 也不能回写。
    if (requireComplete) {
      this._modelCatalogCommittedGeneration = Math.max(
        this._modelCatalogCommittedGeneration,
        refreshGeneration,
      );
    }
    const all = [];
    const catalogRows = [];
    const seen = new Set();
    const byProfile = new Map();
    const identitiesByProfile = new Map();
    const meta = new Map(); // provider+modelId -> { pricing, reasoning }（仅模型管理页）
    const snapshotsByProfile = new Map(); // profile -> 本轮独立解析结果，完成后再稳定折叠
    const failedProfiles = [];
    let okDashboards = 0; // dashboards that answered (200 + parseable)
    // 在首个 await 前捕获 profile 与 dashboard 身份，strict 完成后必须仍完全一致。
    const dashboardEntries = [...this.dashboards.entries()];
    const capturedDashboards = new Map(
      dashboardEntries.map(([profile, dashboard]) => [
        profile,
        {
          ref: dashboard,
          baseUrl: dashboard?.baseUrl,
          token: dashboard?.token,
        },
      ]),
    );
    await Promise.all(
      dashboardEntries.map(async ([profile, dash]) => {
        try {
          // /api/model/options runs with pricing=True server-side, which does a
          // models.dev pricing fetch + Nous tier check — cold it can exceed the
          // 4s default and we'd silently get 0 models (and an empty chat model
          // dropdown). Give it generous room.
          const { status, body } = await this._dashGet(dash, "/api/model/options", {
            timeoutMs: 20000,
          });
          if (status !== 200) {
            failedProfiles.push(profile);
            return;
          }
          const parsed = JSON.parse(body);
          okDashboards += 1;
          const providers = Array.isArray(parsed.providers) ? parsed.providers : [];
          const profileModels = new Set();
          const profileIdentities = new Set();
          const profileChoices = [];
          const profileCatalogRows = [];
          const profileMeta = new Map();
          for (const p of providers) {
            const providerSlug = String(p.slug || p.name || "hermes");
            // 用户自定义 provider（config.yaml providers.*）不在 Hermes 的内置
            // provider 名单里：ACP `/model <slug>:<id>` 不认 slug，会把整串当模型名
            // 发给当前 provider（404 且被持久化）。正确形态是 triple 语法
            // `custom:<slug>:<id>`——这里给 choice 记下该用的 ref，聊天页组命令用。
            const acpProviderRef =
              p.is_user_defined === true || p.source === "user-config"
                ? `custom:${providerSlug}`
                : undefined;
            const models = Array.isArray(p.models) ? p.models : [];
            // /api/model/options ships pricing=True & capabilities=True: parallel
            // maps keyed by model id (models itself stays a string[]).
            const pricing = p.pricing && typeof p.pricing === "object" ? p.pricing : {};
            const caps = p.capabilities && typeof p.capabilities === "object" ? p.capabilities : {};
            for (const id of models) {
              const modelId = normalizeModelId(id);
              if (!modelId) continue;
              profileModels.add(modelId);
              const catalogKey = modelCatalogKey(providerSlug, modelId);
              profileIdentities.add(catalogKey);
              const cap = caps[modelId];
              // 每个 Profile 先独立收集；等待全部 HTTP 后再按稳定 Profile 顺序折叠。
              profileCatalogRows.push({
                id: modelId,
                name: modelId,
                provider: providerSlug,
                backendId: "hermes",
                profile,
                reasoning: typeof cap?.reasoning === "boolean" ? cap.reasoning : undefined,
                ...(typeof cap?.fast === "boolean" ? { fast: cap.fast } : {}),
                pricing: pricing[modelId] || undefined,
                acpProviderRef,
              });
              profileChoices.push({
                id: modelId,
                name: modelId,
                provider: providerSlug,
                ...(acpProviderRef ? { acpProviderRef } : {}),
              });
              if (!profileMeta.has(catalogKey)) {
                profileMeta.set(catalogKey, {
                  pricing: pricing[modelId] || undefined,
                  reasoning: typeof cap?.reasoning === "boolean" ? cap.reasoning : undefined,
                  // fast-mode capability (service-tier param 型)：官方 Edit 子菜单的
                  // ⚡ 开关按它门控；我们的聊天页同款。
                  ...(typeof cap?.fast === "boolean" ? { fast: cap.fast } : {}),
                });
              }
            }
          }
          snapshotsByProfile.set(profile, {
            choices: profileChoices,
            catalogRows: profileCatalogRows,
            meta: profileMeta,
            models: [...profileModels],
            identities: profileIdentities,
          });
        } catch {
          failedProfiles.push(profile);
        }
      }),
    );
    // 失败 profile 用上一轮已提交的 snapshot 补位：既不把它的模型从聚合目录里清掉，
    // 也不让它把健康 profile 的更新一起冻住。requireComplete 在下面照旧对失败抛错。
    for (const profile of failedProfiles) {
      const previous = this._modelCatalogProfileSnapshots.get(profile);
      if (previous) snapshotsByProfile.set(profile, previous);
    }
    // 网络完成顺序不能决定同身份模型的 UI 元数据；固定由字典序最小 Profile 胜出。
    const orderedProfiles = [...snapshotsByProfile.keys()].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    for (const profile of orderedProfiles) {
      const snapshot = snapshotsByProfile.get(profile);
      byProfile.set(profile, snapshot.models);
      identitiesByProfile.set(profile, snapshot.identities);
      catalogRows.push(...snapshot.catalogRows);
      for (const choice of snapshot.choices) {
        const catalogKey = modelCatalogKey(choice.provider, choice.id);
        if (seen.has(catalogKey)) continue;
        seen.add(catalogKey);
        all.push(choice);
        meta.set(catalogKey, snapshot.meta.get(catalogKey));
      }
    }
    // generation 之外还要验证本轮捕获的 dashboard 身份，阻止后发 ordinary 提交旧拓扑。
    const topologyChanged = this._dashboardTopologyChanged(capturedDashboards);
    if (requireComplete) {
      if (topologyChanged) {
        throw catalogUnavailable("hermes 运行时目录读取期间 dashboard 拓扑变化，请重试");
      }
      if (dashboardEntries.length === 0) {
        throw catalogUnavailable("hermes 运行时目录读取不完整，当前没有可用 dashboard");
      }
      if (failedProfiles.length > 0) {
        throw catalogUnavailable(
          `hermes 运行时目录读取不完整，失败 profile：${failedProfiles.sort().join(", ")}`,
        );
      }
      if (byProfile.size !== dashboardEntries.length) {
        throw catalogUnavailable("hermes 运行时目录读取不完整，未覆盖全部当前 profile");
      }
    }
    // Every dashboard failed (down/restarting): keep the warm cache instead of
    // wiping it — committing [] would throw the next getModels back onto the
    // blocking cold path. A partial fan-out is safe to commit because the failed
    // profiles were back-filled above. A dashboard answering 200 with zero models
    // is a real result and still commits below.
    if (okDashboards === 0 && this.modelChoices.length > 0) {
      return this.modelChoices;
    }
    // 先开始的 ordinary 若晚于 strict 返回，只能丢弃缓存回写；较新一轮仍可正常提交。
    const catalogState = buildHermesModelCatalogState(snapshotsByProfile);
    if (!topologyChanged && refreshGeneration >= this._modelCatalogCommittedGeneration
      && commitHermesModelCatalogState(this, catalogState, modelCatalogEpoch)) {
      this._modelCatalogCommittedGeneration = refreshGeneration;
      this._modelCatalogProfileSnapshots = snapshotsByProfile;
    }
    return returnSnapshot
      ? { choices: catalogState.modelChoices, meta: catalogState.modelMeta, catalogRows: catalogState.catalogRows }
      : catalogState.modelChoices;
  }

  // ---- dashboard process management ----

  // Ports used to be handed out by profile-list index and any dashboard answering
  // on the port was reused blind. Add or remove a profile and the indexes shift —
  // so agent X could end up reading and writing profile Y's sessions/cron/SOUL via
  // an orphaned dashboard. Now: scan upward from the preferred port and only reuse
  // a dashboard that PROVES it serves this profile. Unverifiable → never reuse.
  // `claimed` reserves a port synchronously so concurrent profile scans can't
  // both settle on the same one.
  async _spawnOrReuseDashboard(
    profile,
    preferredPort,
    claimed = new Set(),
    generation = this._lifecycleGeneration,
  ) {
    for (let port = preferredPort; port < preferredPort + DASHBOARD_PORT_SCAN; port++) {
      if (generation !== this._lifecycleGeneration) return null;
      if (claimed.has(port)) continue;
      claimed.add(port); // reserve before any await
      const baseUrl = `http://127.0.0.1:${port}`;
      // 端口三态，不能把后两种混为「空闲」（R131 实证：往被占端口 spawn，
      // 新 dashboard listen 时 EADDRINUSE 崩溃）：
      //   连接失败        → 真空闲，spawn；
      //   响应但无 token   → 被其它服务/异版 dashboard 占用，跳过该端口；
      //   有 token        → 校验 profile 归属后 reuse。
      const probe = await httpGet(`${baseUrl}/`, { timeoutMs: 2000 }).catch(() => null);
      if (generation !== this._lifecycleGeneration) return null;
      if (!probe) return this._spawnDashboard(profile, port, { generation });
      const existing = probe.status === 200 ? (SESSION_TOKEN_RE.exec(probe.body)?.[1] ?? null) : null;
      if (existing) {
        const ident = await this._dashboardIdentity(baseUrl, existing);
        if (generation !== this._lifecycleGeneration) return null;
        if (ident && samePath(ident.home, hermesHomeForProfile(profile))) {
          // 版本守卫（R279 遗留）：跨过 Hermes 升级仍在跑的旧 dashboard 会被无条件
          // 复用，而 /api/ws 等新能力在旧进程上直接失败（0.18.2+--isolated 甚至 500）。
          // 复用前比对进程自报版本与本机 CLI 版本；不一致时——仅当该进程可证明是
          // 我们 spawn 的（端口 PID 的 env 带我们注入的 HERMES_DASHBOARD_SESSION_TOKEN
          // 且命令行是 hermes dashboard）——终止并原端口重拉。手动跑的永不被杀：
          // 证明不了归属就跳过该端口另起（沿用「被占端口」语义）。
          const installed = await this._installedCliVersion();
          const versionStale = installed && ident.version && ident.version !== installed;
          // cwd 守卫：profile config 的 `cwd: .` 按 dashboard 进程工作目录解析，
          // 落在 `/` 时附件目录 = `/.hermes` → 只读，file.attach 全灭。我们现在
          // 总是锚到家目录 spawn，所以 cwd=`/` 的必是修复前的陈旧进程——单纯
          // 重启 app 不会换掉它（这个复用分支会把它接回来），必须主动重拉。
          const rootCwd = await this._dashboardCwdIsRoot(port);
          if (!versionStale && !rootCwd) {
            return { profile, port, baseUrl, token: existing, proc: null, spawned: false };
          }
          const why = versionStale ? `v${ident.version} ≠ CLI v${installed}` : "工作目录为 /（附件目录不可写）";
          const reaped = await this._reapStaleDashboard(port, profile, why);
          if (generation !== this._lifecycleGeneration) return null;
          if (reaped) return this._spawnDashboard(profile, port, { generation });
          console.warn(
            `[hermes] profile ${profile}: 端口 ${port} 上的 dashboard 需重启（${why}）但无法证明归属，保留并换端口`,
          );
        }
      }
      // Held by another profile's dashboard (or one too old to identify itself).
    }
    this.lastError = `从端口 ${preferredPort} 起连续 ${DASHBOARD_PORT_SCAN} 个端口都不可用`;
    console.warn(`[hermes] profile ${profile}: ${this.lastError}`);
    return null;
  }

  // /api/status reports the hermes_home the process resolved at launch, and
  // `--profile` is what decides it — so it identifies the dashboard's profile.
  // Also carries the process's `version`, which the reuse path compares against
  // the installed CLI. Returns null when the endpoint doesn't answer/parse
  // (identity unprovable → caller must not reuse).
  async _dashboardIdentity(baseUrl, token) {
    const { status, body } = await httpGet(`${baseUrl}/api/status`, { token, timeoutMs: 3000 }).catch(
      () => ({ status: 0, body: "" }),
    );
    if (status !== 200) return null;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
    const home = parsed?.hermes_home;
    if (typeof home !== "string" || !home) return null; // older build → unprovable
    const version = /^(\d+\.\d+\.\d+)/.exec(String(parsed?.version || "").trim())?.[1];
    return { home, version };
  }

  // dashboard 换了进程，首页里的 session token 就换了，而 `dash.token` 是 start()
  // 那一刻抓的（`_spawnOrReuseDashboard`）、此后再没人刷新——之后每个请求都 401，
  // 对外表现是「provider 配置读取不完整，失败 profile：X」这类整页 503，而 dashboard
  // 本身完全健康（实测直连同端点 200/3ms）。这里就地补一次。
  // **必须重新验证身份**：端口可能已被另一个 profile 的 dashboard 占走，只换 token
  // 不校验 hermes_home 会静默串号（读到别人的配置还以为是自己的）。
  // `dash` 是 `this.dashboards` 里的同一个对象，原地改 token 后全部调用点自动受益。
  async _renewDashToken(dash) {
    if (!dash?.baseUrl) return false;
    const inflight = this._tokenRenewals.get(dash.baseUrl);
    if (inflight) return inflight; // 单飞：多个读路径同时撞 401 只探一次首页
    const run = (async () => {
      const token = await scrapeToken(dash.baseUrl).catch(() => null);
      // token 没变说明 401 另有原因（真的没权限），重试也是白重试。
      if (!token || token === dash.token) return false;
      const ident = await this._dashboardIdentity(dash.baseUrl, token);
      if (!ident || !samePath(ident.home, hermesHomeForProfile(dash.profile))) return false;
      dash.token = token;
      console.warn(`[hermes] profile ${dash.profile}: dashboard token 已失效，就地续期成功`);
      return true;
    })();
    this._tokenRenewals.set(dash.baseUrl, run);
    return run.finally(() => this._tokenRenewals.delete(dash.baseUrl));
  }

  // 带 401 自愈的 GET：认证失败就续一次 token 再重试，其余状态原样返回。
  // 读路径专用——写路径的重试要连同条件写 If-Match 一起考虑，别顺手套上来。
  async _dashGet(dash, endpoint, opts = {}) {
    const res = await httpGet(`${dash.baseUrl}${endpoint}`, { token: dash.token, ...opts });
    if (res.status !== 401 && res.status !== 403) return res;
    if (!(await this._renewDashToken(dash))) return res;
    return httpGet(`${dash.baseUrl}${endpoint}`, { token: dash.token, ...opts });
  }

  // Installed `hermes --version` → "0.19.0" (first semver in the banner).
  // Cached for the process lifetime — upgrades restart the app anyway. Returns
  // null when the CLI can't answer (missing/broken install): the version guard
  // then stands down and reuse behaves as before.
  _installedCliVersion() {
    if (!this._cliVersionPromise) {
      this._cliVersionPromise = new Promise((resolve) => {
        const proc = spawn(this.bin, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        const timer = setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch { /* gone */ }
          resolve(null);
        }, 10_000);
        proc.stdout.on("data", (c) => { out += c; });
        proc.on("error", () => { clearTimeout(timer); resolve(null); });
        proc.on("exit", () => {
          clearTimeout(timer);
          resolve(/v?(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null);
        });
      }).then((v) => {
        if (!v) this._cliVersionPromise = null; // transient failure → retry next time
        return v;
      });
    }
    return this._cliVersionPromise;
  }

  // Terminate a stale-version dashboard on `port` — ONLY when the listener is
  // provably one of ours: its command line is a hermes dashboard for this
  // profile AND its environment carries the HERMES_DASHBOARD_SESSION_TOKEN we
  // inject at spawn (manual runs don't set that env; web_server mints its own
  // token internally). Any doubt → false, caller leaves the process alone.
  // 端口上的监听进程工作目录是否为 `/`（见 _spawnOrReuseDashboard 的 cwd 守卫）。
  // 查不到时返回 false —— 拿不准就不动别人的进程。
  async _dashboardCwdIsRoot(port) {
    const out = await new Promise((resolve) => {
      const p = spawn("sh", ["-c", `lsof -a -p $(lsof -ti :${port} -sTCP:LISTEN | head -1) -d cwd -Fn 2>/dev/null | grep '^n' | cut -c2-`], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let buf = "";
      p.stdout.on("data", (c) => { buf += c; });
      p.on("error", () => resolve(""));
      p.on("exit", () => resolve(buf.trim()));
    });
    return out === "/";
  }

  async _reapStaleDashboard(port, profile, why) {
    const run = (cmd, args) =>
      new Promise((resolve) => {
        const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        p.stdout.on("data", (c) => { out += c; });
        p.on("error", () => resolve(""));
        p.on("exit", () => resolve(out));
      });
    const pidOut = await run("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"]);
    const pid = Number(pidOut.trim().split("\n")[0]);
    if (!Number.isInteger(pid) || pid <= 1) return false;
    // Command line (no env) for the what-is-it checks; env dump for the whose-is-it check.
    const cmdline = await run("ps", ["-o", "command=", "-p", String(pid)]);
    const envOut = await run("ps", ["eww", String(pid)]);
    const isHermesDash = /hermes/.test(cmdline) && /\bdashboard\b/.test(cmdline);
    const hasOurEnv = /HERMES_DASHBOARD_SESSION_TOKEN=/.test(envOut);
    const profileMatches = profile === "default"
      ? !/--profile\s/.test(cmdline)
      : new RegExp(`--profile\\s+${profile}(\\s|$)`).test(cmdline);
    if (!isHermesDash || !hasOurEnv || !profileMatches) return false;
    console.log(
      `[hermes] profile ${profile}: 端口 ${port} 的 dashboard (pid ${pid}) 需重启（${why}），且可证明是本应用 spawn 的 —— 终止后重拉`,
    );
    if (!signalDashboardProcess(pid, "SIGTERM")) return false;
    // Wait for the listener to actually vacate the port (SIGTERM is async).
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      const still = (await run("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"])).trim();
      if (!still) return true;
    }
    signalDashboardProcess(pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 500));
    return (await run("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"])).trim() === "";
  }

  async _spawnDashboard(
    profile,
    port,
    { skipBuild = true, isolated = true, generation = this._lifecycleGeneration } = {},
  ) {
    const baseUrl = `http://127.0.0.1:${port}`;
    // Mint the session token ourselves and inject it via
    // HERMES_DASHBOARD_SESSION_TOKEN (web_server.py reads this env and only falls
    // back to its own random token when unset). This replaces the fragile "poll the
    // served HTML until the __HERMES_SESSION_TOKEN__ regex matches" handshake with
    // a token we control before the process even starts.
    let token = randomBytes(32).toString("base64url");
    // 常态带 --skip-build（标准安装 stamp 判定会误判需构建、npm build 必失败
    // 刷屏 30s+，R130 实证）；仅 web_dist 缺失的 fallback 重试去掉它（见下）。
    const args = [
      ...(profile === "default" ? [] : ["--profile", profile]),
      "dashboard",
      // named profile 必须 --isolated，否则 0.18+ CLI re-exec 成机器级 dashboard
      // （default 数据），各 profile 的会话/cron 串成同一份（见 UNRECOGNIZED_ISOLATED）。
      ...(profile !== "default" && isolated ? ["--isolated"] : []),
      "--no-open",
      ...(skipBuild ? ["--skip-build"] : []),
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
    ];
    // stdout/stderr 必须 pipe 而不是 ignore：CLI 的启动期报错（web_dist 缺失、
    // venv 损坏、auth gate…）全部 print 后 exit 1，丢掉输出就只剩裸「exit 1」，
    // 新机器上的安装性问题无从诊断（真机 R130 实证）。listener 终身保留——
    // pipe 无消费会背压塞死长命 dashboard 的 stdout。
    const proc = spawn(this.bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      // 自成 process group：不 detached 时子进程与 app 同组，从终端 `npm start`
      // 起的 app 被 Ctrl+C 时 SIGINT 会广播到整组，把 dashboard 一起带走——
      // hermesKeepAlive 想保留的进程就白留了。停止时按这个独立 process group
      // 发信号，确保 dashboard 的后代进程也一起回收。
      detached: true,
      // cwd 必须显式给：profile config 的 `cwd: .` 是**相对**路径，服务端按
      // dashboard 进程的工作目录解析它。从 Finder 启动的 .app 其 cwd 是 `/`，
      // 于是会话工作区 = `/`，附件目录 = `/.hermes/desktop-attachments` →
      // 真机实测 `[Errno 30] Read-only file system: '/.hermes'`，file.attach 全灭
      // （开发态从项目目录起进程时反而正常，所以只有打包版会中招）。锚到家目录
      // 让相对 cwd 落在可写位置。
      cwd: os.homedir(),
      env: { ...process.env, HERMES_DASHBOARD_SESSION_TOKEN: token },
    });
    this._pendingDashboardProcs.add(proc);
    let spawnErr = null; // hermes not installed etc. — surfaced via lastError
    const stopSpawned = async () => {
      const hasPid = Number.isInteger(Number(proc.pid)) && Number(proc.pid) > 1;
      if (!hasPid && (proc.exitCode !== null || proc.signalCode || spawnErr)) {
        signalDashboardProcess(proc);
        return;
      }
      const exited = waitForExit(proc);
      signalDashboardProcess(proc);
      await exited;
    };
    try {
    let outTail = "";
    const keepTail = (chunk) => {
      outTail = (outTail + chunk).slice(-2000);
    };
    proc.stdout.on("data", keepTail);
    proc.stderr.on("data", keepTail);
    proc.on("error", (e) => {
      spawnErr = e;
    });
    // Ready = /api/status answers 200 to OUR token. If it never does, an older
    // build may ignore the env — fall back to scraping the token it minted.
    // 进程 spawn 失败/提前退出时立即放弃，不空等 READY_TIMEOUT（新机器没装
    // CLI 时 ENOENT 是首启常态路径）。
    const dead = () => spawnErr !== null || proc.exitCode !== null || proc.signalCode !== null;
    const readyTimeoutMs = skipBuild ? READY_TIMEOUT_MS : BUILD_READY_TIMEOUT_MS;
    const ready = await this._waitForDashboard(baseUrl, token, dead, readyTimeoutMs);
    if (generation !== this._lifecycleGeneration) {
      await stopSpawned();
      return null;
    }
    if (!ready) {
      const scraped = dead() ? null : await scrapeToken(baseUrl).catch(() => null);
      if (!scraped) {
        await stopSpawned();
        // 老版 CLI（无统一路由）不认识 --isolated：argparse exit 2。去掉该
        // flag 重试——老版本 dashboard 本来就是 per-profile 的，不需要它。
        if (isolated && profile !== "default" && UNRECOGNIZED_ISOLATED.test(outTail)) {
          console.log(`[hermes] profile ${profile}: CLI 不支持 --isolated（老版本），去掉该 flag 重试`);
          return this._spawnDashboard(profile, port, { skipBuild, isolated: false, generation });
        }
        // 本机从未构建过 dashboard 前端 → 去掉 --skip-build 让 CLI 就地构建。
        // 单飞 + 冷却：构建失败后 10 分钟内自愈重试只报错，不再反复跑构建。
        if (skipBuild && WEB_DIST_MISSING.test(outTail) && Date.now() - this._webBuildAttemptAt > BUILD_RETRY_COOLDOWN_MS) {
          this._webBuildAttemptAt = Date.now();
          console.log(`[hermes] profile ${profile}: web_dist 缺失，去掉 --skip-build 重试（首次构建，分钟级）`);
          return this._spawnDashboard(profile, port, { skipBuild: false, isolated, generation });
        }
        // CLI 输出尾部（报错和「怎么办」指引都在最后几行）随退出码一起透出。
        const tail = outTail.trim().split("\n").slice(-6).join("\n").slice(-400);
        console.warn(
          `[hermes] profile ${profile}: dashboard 未就绪 (port ${port}, ` +
            `${spawnErr ? spawnErr.code || spawnErr.message : proc.exitCode !== null ? `exit ${proc.exitCode}` : `timeout ${readyTimeoutMs / 1000}s`}` +
            `${skipBuild ? "" : ", 构建模式"})${tail ? ` — ${tail.split("\n").at(-1)}` : ""}`,
        );
        this.lastError =
          spawnErr?.code === "ENOENT"
            ? `未找到 hermes 命令（${this.bin}）`
            : spawnErr
              ? String(spawnErr.message || spawnErr)
              : proc.exitCode !== null
                ? `hermes dashboard 进程退出（exit ${proc.exitCode}）${tail ? `\n${tail}` : ""}`
                : `hermes dashboard ${readyTimeoutMs / 1000}s 内未就绪`;
        return null;
      }
      token = scraped;
    }
    // 防御：token 就绪 ≠ 身份正确——本次串号 bug 即 spawn 后不校验，统一路由
    // re-exec 出的 dashboard 静默服务 default 数据。不匹配只告警不拒绝：老版
    // build 的 /api/status 没有 hermes_home 字段，拒绝会误杀正确的老 dashboard。
    const ident = await this._dashboardIdentity(baseUrl, token);
    if (generation !== this._lifecycleGeneration) {
      await stopSpawned();
      return null;
    }
    if (!ident) {
      console.warn(
        `[hermes] profile ${profile}: dashboard(port ${port})身份校验未通过——` +
          "版本过老或未返回 hermes_home，无法验证 profile 归属",
      );
    } else if (!samePath(ident.home, hermesHomeForProfile(profile))) {
      console.warn(
        `[hermes] profile ${profile}: dashboard(port ${port})的 hermes_home 不匹配，拒绝接入`,
      );
      await stopSpawned();
      return null;
    }
    return { profile, port, baseUrl, token, proc, spawned: true };
    } catch (error) {
      await stopSpawned();
      throw error;
    } finally {
      this._pendingDashboardProcs.delete(proc);
    }
  }

  // Poll /api/status until the dashboard authenticates `token` (200), the
  // process dies (isDead), or time out.
  async _waitForDashboard(baseUrl, token, isDead, timeoutMs = READY_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (isDead?.()) return false;
      const { status } = await httpGet(`${baseUrl}/api/status`, {
        token,
        timeoutMs: 3000,
      }).catch(() => ({ status: 0 }));
      if (status === 200) return true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }

  async _refreshAgentsFor(dash, generation = this._lifecycleGeneration) {
    // In remote mode the agent table is derived from the hermesRemotes config —
    // one agent per configured remote, keyed into `dashboards` by that profile
    // name. Rebuilding it from ONE remote's /api/profiles (which lists every
    // profile on that host) would drop the configured agents and mint new ones
    // with no dashboard behind them: sessions/cron go empty, chat can't route.
    if (this._getConfig().hermesMode === "remote") return;
    const { status, body } = await httpGet(`${dash.baseUrl}/api/profiles`, {
      token: dash.token,
    });
    if (status !== 200) return;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return;
    }
    if (generation !== this._lifecycleGeneration) return;
    const profiles = Array.isArray(parsed.profiles) ? parsed.profiles : [];
    this._installProfileRows(profiles);
  }

  // ---- sessions ----

  async refreshSessions({ limit = SESSIONS_PER_PROFILE_LIMIT } = {}) {
    const generation = this._lifecycleGeneration;
    const aggregated = [];
    await Promise.all(
      [...this.dashboards.entries()].map(async ([profile, dash]) => {
        const agentId = [...this.profileById.entries()].find(([, n]) => n === profile)?.[0];
        if (!agentId) return;
        const rows = await this._fetchSessionsForDashboard(dash, agentId, limit).catch(() => []);
        // 聊天列表的 agent 行按 sessions 分组派生——零会话的新 profile 会整个隐身
        // （设置页 N 实例 vs 聊天少几个的分裂，R275 真机 coder/owl）。合成一条
        // main 聚合占位行兜底：main 键的空历史种子（getMessages）、首条消息开新
        // ACP 会话（sendMessage）、rename/delete 拒绝，均是既有语义。
        if (rows.length === 0) {
          rows.push({
            key: `agent:${agentId}:main`,
            backendId: "hermes",
            agentId,
            kind: "direct",
            updatedAt: null,
            model: this.agents.find((a) => a.id === agentId)?.model,
          });
        }
        aggregated.push(...rows);
      }),
    );
    // stop/reconfigure 已经开始时丢弃旧 dashboard 的迟到结果。
    if (generation !== this._lifecycleGeneration) return this.sessionRows;
    // 思考档能力（S4）：reasoning 能力模型（官方缺省即 true）给出与官方 Edit
    // 子菜单一致的档位表；UI 复用 OpenClaw 既有 picker（thinkingOptions 驱动，
    // 零后端特判）。缺省档 = medium（官方语义：空即 medium）。
    for (const row of aggregated) {
      if (this._modelSupportsReasoning(row.model)) {
        row.thinkingOptions = [...HERMES_THINKING_LEVELS];
        row.thinkingDefault = "medium";
      }
    }
    this.sessionRows = aggregated;
    // 重建后的行是 REST 快照（无窗口占用/无 live 模型）；把网关 session.info /
    // message.complete 学到的实时元数据重新叠上去。
    for (const key of this.sessionLiveMeta.keys()) this._applyLiveMetaToRow(key);
    return this.sessionRows;
  }

  async _fetchSessionsForDashboard(dash, agentId, limit) {
    // Hermes 0.20.4 把单页 limit 收紧到 100；继续传旧值 200 会让所有 profile
    // 返回 422，refreshSessions 随后误判成零会话并只合成 main，前端就没有可切换列表。
    // 保留原来的每 profile 总上限，通过 offset 分页取齐；老 dashboard 若忽略 offset，
    // seen/no-progress 守卫会在第二页停止，不会重复或死循环。
    const requested = Number.isFinite(Number(limit)) ? Math.max(0, Math.floor(Number(limit))) : SESSIONS_PER_PROFILE_LIMIT;
    if (requested === 0) return [];
    const sessions = [];
    const seen = new Set();
    let offset = 0;
    while (sessions.length < requested) {
      const pageLimit = Math.min(100, requested - sessions.length);
      const { status, body } = await httpGet(
        `${dash.baseUrl}/api/sessions?limit=${pageLimit}&offset=${offset}`,
        { token: dash.token },
      );
      if (status !== 200) break;
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        break;
      }
      const page = Array.isArray(parsed.sessions) ? parsed.sessions : [];
      let added = 0;
      for (const session of page) {
        const id = String(session?.id || "");
        if (seen.has(id)) continue;
        seen.add(id);
        sessions.push(session);
        added += 1;
        if (sessions.length >= requested) break;
      }
      if (page.length < pageLimit || added === 0) break;
      offset += pageLimit;
    }
    return sessions.map((s) => rowFromSession(s, agentId));
  }

  // ---- AgentBackend interface ----

  ownsAgentId(agentId) {
    return typeof agentId === "string" && this.profileById.has(agentId);
  }

  // 静态命名空间：Hermes 的 agent 恒为 `hermes-<profile>`（agentIdForProfile），所以
  // `hermes-` 前缀从注册那一刻就是 Hermes 的地盘，不随 dashboard 是否就绪翻转。
  // proxy 用它在启动竞态窗口正确判定归属（防 session-write 漏给上游网关建孤儿、
  // 滤掉上游返回的同名孤儿 agent/session）。见 agent-backend.claimsAgentId。
  claimsAgentId(agentId) {
    return typeof agentId === "string" && agentId.startsWith("hermes-");
  }

  async ownsResourceId(kind, id) {
    const value = String(id || "");
    if (kind === "cron") {
      const separator = value.indexOf(":");
      return separator > 0 && this.claimsAgentId(value.slice(0, separator));
    }
    if (kind !== "kanban" || !value) return false;
    const localId = value.startsWith("hermes:") ? value.slice("hermes:".length) : value;
    try {
      const task = await this.getTask(localId);
      return task?.id === localId;
    } catch {
      return false;
    }
  }

  // ChatPage 的历史缓存必须跟 Hermes 的真实数据源绑定。这里只做本地规范化与
  // SHA-256，不读取 dashboard 状态，避免缓存首屏反过来等待冷启动；摘要之外的
  // home、远程 URL 与 token 都不会越过 backend 边界。
  getChatCacheScope() {
    const cfg = this._getConfig() || {};
    const mode = cfg.hermesMode === "remote" ? "remote" : "local";
    let source;
    if (mode === "remote") {
      const remotes = (Array.isArray(cfg.hermesRemotes) ? cfg.hermesRemotes : [])
        .map((remote) => ({
          profile: String(remote?.profile || "default").trim() || "default",
          baseUrl: String(remote?.baseUrl || "").trim().replace(/\/+$/, ""),
          token: typeof remote?.token === "string" ? remote.token : "",
        }))
        .filter((remote) => remote.baseUrl)
        .sort((left, right) => (
          left.profile.localeCompare(right.profile)
          || left.baseUrl.localeCompare(right.baseUrl)
          || left.token.localeCompare(right.token)
        ));
      source = { mode, remotes };
    } else {
      const configuredHome = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
      let hermesHome;
      try {
        hermesHome = fs.realpathSync(configuredHome);
      } catch {
        hermesHome = path.resolve(configuredHome);
      }
      source = { mode, hermesHome };
    }
    return createHash("sha256").update(JSON.stringify(source)).digest("hex");
  }

  getAgents() {
    return this.agents;
  }

  getSessionRows() {
    return this.sessionRows;
  }

  getSessionRowsSnapshot() {
    return { rows: this.sessionRows, complete: this._sessionRowsComplete };
  }

  getModelChoices() {
    return this.modelChoices;
  }

  /**
   * 将一次运行时 choice/meta 快照映射为 UnifiedModel[]，普通读与 strict source 共用。
   * @param {Array<object>} choices
   * @param {Map<string, object>} meta
   * @returns {Array<object>}
   */
  _runtimeModelsFromChoices(choices, meta) {
    return choices.map((choice) => {
      const modelMeta = (meta && meta.get(modelCatalogKey(choice.provider, choice.id))) || {};
      return {
        id: choice.id,
        name: choice.name,
        provider: choice.provider,
        backendId: "hermes",
        reasoning:
          typeof modelMeta.reasoning === "boolean" ? modelMeta.reasoning : undefined,
        ...(typeof modelMeta.fast === "boolean" ? { fast: modelMeta.fast } : {}),
        pricing: modelMeta.pricing || undefined,
        acpProviderRef: choice.acpProviderRef || undefined,
      };
    });
  }

  // Does this model expose reasoning (thinking/effort controls)? Mirrors the
  // official picker's `caps?.reasoning ?? true` — an uncatalogued model
  // DEFAULTS to true; only an explicit false hides the controls.
  _modelSupportsReasoning(modelId) {
    if (!modelId) return true;
    let sawExplicit = null;
    for (const choice of this.modelChoices) {
      if (choice.id !== modelId) continue;
      const m = this.modelMeta?.get?.(modelCatalogKey(choice.provider, choice.id));
      if (m && typeof m.reasoning === "boolean") {
        if (m.reasoning) return true;
        sawExplicit = false;
      }
    }
    return sawExplicit === null;
  }

  /**
   * 捕获当前 dashboard 引用与连接身份，供双来源快照识别两轮之间的拓扑切换。
   * @returns {Map<string, object>}
   */
  _captureModelCatalogTopology() {
    return new Map(
      [...this.dashboards.entries()].map(([profile, dashboard]) => [
        profile,
        {
          ref: dashboard,
          baseUrl: dashboard?.baseUrl,
          token: dashboard?.token,
        },
      ]),
    );
  }

  /**
   * 判断 dashboard 集合、对象引用或连接字段是否偏离捕获快照。
   * @param {Map<string, object>} captured
   * @returns {boolean}
   */
  _dashboardTopologyChanged(captured) {
    if (captured.size !== this.dashboards.size) return true;
    return [...this.dashboards.entries()].some(([profile, current]) => {
      const previous = captured.get(profile);
      return (
        !previous ||
        previous.ref !== current ||
        previous.baseUrl !== current?.baseUrl ||
        previous.token !== current?.token
      );
    });
  }

  // 模型 management page: refresh from each profile's /api/model/options, then
  // shape as UnifiedModel[] tagged with this backend.
  async getModels() {
    // 缓存优先：start() 已预热 modelChoices。/api/model/options 冷启动会跑 pricing
    // 抓取，最长 20s（见 refreshModelChoices），绝不能让它阻塞每次切到 Hermes agent
    // 时的下拉请求——否则前端 fetch 一直 pending、会沿用上一个后端的目录。有缓存：
    // 立即返回 + 后台刷新（refreshModelChoices 自带 in-flight 合并，连点不堆并发；
    // 全失败不覆盖热缓存）。无缓存（预热失败/dashboard 不可达）：每次调用都等当轮
    // 刷新，直到某次成功填上缓存；失败返回空列表，前端渲染空、不串别的后端。
    const refreshing = this.refreshModelChoices().catch(() => {});
    if (this.modelChoices.length === 0) await refreshing;
    return this._runtimeModelsFromChoices(this.modelChoices, this.modelMeta);
  }

  /**
   * 模型 apply 完成后推进目录 epoch，并用独立 strict refresh 构造/提交完整新 state。
   * apply 前已启动的 ordinary refresh 因 epoch 不匹配只能返回自身结果，不能回写。
   */
  async commitVerifiedHermesModelCatalog() {
    this._modelCatalogEpoch += 1;
    return this.refreshModelChoices({ fresh: true, requireComplete: true, returnSnapshot: true });
  }

  /** Task 13 adapter 与回归通过该闭包取得不可伪造 Provider 写 capability。 */
  async _withModelChangeCoordinatorContext(operationId, run) {
    return this._modelMutationGate.withCoordinatorContext(operationId, run);
  }

  /** 返回组合根注入的单例 mutation gate，adapter 不得另建锁域。 */
  getModelMutationGate() {
    return this._modelMutationGate;
  }

  /** 注入 Hermes model-change adapter；backend 只负责委托契约。 */
  attachModelChangeAdapter(adapter) {
    if (!adapter
      || typeof adapter.getCapabilities !== "function"
      || typeof adapter.preview !== "function"
      || typeof adapter.apply !== "function"
      || typeof adapter.recover !== "function") {
      throw new TypeError("modelChangeAdapter 必须提供 getCapabilities/preview/apply/recover");
    }
    this._modelChangeAdapter = adapter;
  }

  /** 预览只委托已注入 adapter。 */
  async previewModelChange(safeSpec) {
    if (!this._modelChangeAdapter) return super.previewModelChange(safeSpec);
    return this._modelChangeAdapter.preview(safeSpec);
  }

  /** apply 只委托已注入 adapter。 */
  async applyModelChange(safeSpec, context, secretEnvelope) {
    if (!this._modelChangeAdapter) return super.applyModelChange(safeSpec, context, secretEnvelope);
    return this._modelChangeAdapter.apply(safeSpec, context, secretEnvelope);
  }

  /** recovery 只委托已注入 adapter。 */
  async recoverModelChange(entry, context) {
    if (!this._modelChangeAdapter) return super.recoverModelChange(entry, context);
    return this._modelChangeAdapter.recover(entry, context);
  }

  /**
   * 引用 scanner 的受限原始读取桥接：只允许五个已注册 store，并保留白名单响应头。
   * scanner 不接触 dashboard token，也不能指定任意 URL。
   */
  async readHermesModelReferenceStore(profile, store, options = {}) {
    const dash = this.dashboards.get(profile);
    if (!dash) throw new Error("hermes reference profile unavailable");
    const allowed = new Set(["provider", "main", "auxiliary", "cron", "sessions"]);
    if (!allowed.has(store)) throw new Error("hermes reference store unsupported");
    let endpoint;
    if (store === "provider") endpoint = "/api/config";
    else if (store === "main") endpoint = "/api/model/info";
    else if (store === "auxiliary") endpoint = "/api/model/auxiliary";
    else if (store === "cron") {
      const query = new URLSearchParams({ profile });
      if (Number.isSafeInteger(options.limit) && options.limit > 0) query.set("limit", String(options.limit));
      if (Number.isSafeInteger(options.offset) && options.offset >= 0) query.set("offset", String(options.offset));
      endpoint = `/api/cron/jobs?${query}`;
    } else {
      const query = new URLSearchParams({ profile });
      if (Number.isSafeInteger(options.limit) && options.limit > 0) query.set("limit", String(options.limit));
      if (Number.isSafeInteger(options.offset) && options.offset >= 0) query.set("offset", String(options.offset));
      endpoint = `/api/sessions?${query}`;
    }
    return this._dashGet(dash, endpoint, { timeoutMs: 15000 });
  }

  /** 按 scanner referenceKey 回读单项权威值，供写后 verify/补偿前检查。 */
  async readHermesModelReference(reference) {
    const response = await this.readHermesModelReferenceStore(reference.profile, reference.store);
    if (response.status !== 200) throw new Error("hermes reference read failed");
    const body = typeof response.body === "string" ? JSON.parse(response.body) : response.body;
    if (reference.store === "provider") {
      const [, providerKey, modelId] = String(reference.referenceKey).split(":");
      const provider = body?.providers?.[providerKey];
      const model = this._hermesModelEntries(provider?.models).find((item) => item.id === modelId);
      return model ? { profile: reference.profile, provider: providerKey, modelId, model } : null;
    }
    if (reference.store === "main") {
      return { profile: reference.profile, provider: String(body?.provider || ""), model: String(body?.model || "") };
    }
    if (reference.store === "auxiliary") {
      const taskName = String(reference.referenceKey).slice(String(reference.profile).length + 1);
      const task = (Array.isArray(body?.tasks) ? body.tasks : []).find((item) => String(item?.task || "") === taskName);
      return task ? { profile: reference.profile, task: taskName, provider: String(task.provider || ""), model: String(task.model || "") } : null;
    }
    if (reference.store === "cron") {
      const jobId = String(reference.referenceKey).slice(String(reference.profile).length + 1);
      const jobs = Array.isArray(body) ? body : Array.isArray(body?.jobs) ? body.jobs : [];
      const job = jobs.find((item) => String(item?.id || "") === jobId);
      return job ? {
        profile: reference.profile,
        id: jobId,
        provider: String(job.provider || ""),
        model: String(job.model || ""),
        fallbacks: Array.isArray(job.fallbacks) ? job.fallbacks.map(String) : [],
      } : null;
    }
    return null;
  }

  /** Main/Aux/Cron 单引用条件写；Provider 模型数组必须由 Task 13 批量 stage。 */
  async writeHermesModelReference(reference, value) {
    if (reference.store === "provider") {
      const error = new Error("Provider 引用必须使用完整 models 子树批量写");
      error.code = "hermes_provider_batch_required";
      throw error;
    }
    const dash = this.dashboards.get(reference.profile);
    if (!dash) throw new Error("hermes reference profile unavailable");
    const extraHeaders = this._modelMutationGate.conditionalHeaders(reference.snapshot);
    let response;
    if (reference.store === "main") {
      response = await httpRequest("POST", `${dash.baseUrl}/api/model/set`, {
        token: dash.token,
        extraHeaders,
        body: { scope: "main", provider: value.provider, model: value.model, task: "" },
      });
    } else if (reference.store === "auxiliary") {
      response = await httpRequest("POST", `${dash.baseUrl}/api/model/set`, {
        token: dash.token,
        extraHeaders,
        body: { scope: "auxiliary", task: value.task, provider: value.provider, model: value.model },
      });
    } else if (reference.store === "cron") {
      response = await httpRequest(
        "PUT",
        `${dash.baseUrl}/api/cron/jobs/${encodeURIComponent(value.id)}?profile=${encodeURIComponent(reference.profile)}`,
        { token: dash.token, extraHeaders, body: { updates: { provider: value.provider, model: value.model, fallbacks: value.fallbacks } } },
      );
    } else {
      const error = new Error("Hermes Session 模型引用不可安全改写");
      error.code = "hermes_session_write_unsupported";
      throw error;
    }
    this._modelMutationGate.assertConditionalSuccess(response, reference.snapshot);
    // 同一 store 的后续写/补偿必须使用本次响应声明的新版本，禁止沿用扫描时 ETag。
    reference.snapshot = {
      ...this._modelMutationGate.inspectStore(response, reference.store),
      profile: reference.profile,
    };
    return response;
  }

  /** 读取全部 Profile 的 fresh Provider 条件能力，缺一项即关闭所有模型 CRUD。 */
  async getModelChangeCapabilities() {
    // perAgentModelSettings 是**静态事实**：Hermes 的每个 profile 就是一个 agent，
    // 各持一份独立 config（主模型/默认参数/辅助模型/MoA/回退链），所以那些设置归
    // 「代理」页的每个 agent，「模型」页只留跨 agent 的凭证层。它与下面两条路径的
    // 运行时探测成败无关 → 在外层统一注入，adapter 路径也不漏；探测失败（supported
    // false）时它照样为 true，否则一次 provider 读取失败会把页面形态整个翻转。
    const base = this._modelChangeAdapter
      ? await this._modelChangeAdapter.getCapabilities()
      : await this.getHermesConditionalWriteCapabilities();
    return { ...base, perAgentModelSettings: true };
  }

  /** adapter 使用的底层条件写能力，避免委托 getModelChangeCapabilities 形成递归。 */
  async getHermesConditionalWriteCapabilities() {
    let supported = false;
    try {
      await this._readProvidersByProfile({ fresh: true, requireComplete: true });
      const profiles = [...this.dashboards.keys()];
      supported = profiles.length > 0 && profiles.every((profile) => (
        this._providerMutationSnapshots.get(profile)?.supported === true
      ));
    } catch {
      supported = false;
    }
    return {
      supported,
      create: supported,
      update: supported,
      rename: supported,
      delete: supported,
      updateProvider: supported,
      blockers: supported ? [] : ["hermes_conditional_write_unsupported"],
    };
  }

  /**
   * config-only 写能力（R272）：官方 dashboard/desktop 同款无锁深合并 PUT。
   * 上游 /api/config 无 ETag/If-Match（源码核实），条件写 fail-closed 是常态，
   * 因此把 hermes_conditional_write_unsupported 列为全 kind 可绕；枚举/消歧类
   * 照 R172 分级——create/update/update-provider 与引用扫描完整性无关可绕，
   * delete 必须完整枚举，引用拦截仅 force 后可绕。零 I/O：页面加载高频调用，
   * dashboard 挂掉时写入自然失败并以错误上抛。
   */
  async getModelConfigWriteCapabilities() {
    if (this.dashboards.size === 0) {
      return {
        supported: false, create: false, update: false, delete: false, updateProvider: false,
        activation: null, bypassBlockerCodes: [], blockers: ["no_dashboard"],
      };
    }
    const enumerationBypass = [
      "session_enumeration_incomplete",
      "cron_enumeration_incomplete",
      "main_enumeration_incomplete",
      "auxiliary_enumeration_incomplete",
      "ambiguous_auto_provider",
      "cron_owner_ambiguous",
    ];
    return {
      supported: true, create: true, update: true, delete: true, updateProvider: true,
      // 官方语义：PUT 落盘即对新会话生效（mtime 缓存自失效），无需重启动作。
      activation: null,
      bypassBlockerCodes: {
        "*": ["hermes_conditional_write_unsupported"],
        create: enumerationBypass,
        update: enumerationBypass,
        "update-provider": enumerationBypass,
        "delete-model:forced": [...enumerationBypass, "references_exist", "session_model_reference"],
        "delete-provider:forced": [...enumerationBypass, "references_exist", "session_model_reference"],
      },
      blockers: [],
    };
  }

  /**
   * config-only 写（R272）：官方同款无锁深合并 PUT。复用 full 路线的 unlocked
   * CRUD（参数映射对齐 hermes-model-change.js applyOtherKind），仅写通道换成
   * conditional:false。同 spec 重放幂等：深合并对已写 profile 是无害覆盖；
   * delete 类在目标已消失时直接判 applied（partial 续提的收敛终点），
   * partial 后 coordinator 以同 operationId 重放即可收敛。
   */
  async applyModelChangeConfigOnly(safeSpec = {}, context = {}, secretEnvelope = null) {
    const operationId = String(context?.operationId || "").trim() || "config-only";
    const opts = { conditional: false };
    return this._modelMutationGate.withCoordinatorContext(operationId, () =>
      this._modelMutationGate.withProfiles([...this.dashboards.keys()], operationId, async () => {
        let out;
        try {
          if (safeSpec.kind === "create" || safeSpec.kind === "update") {
            out = await this._addModelConfigUnlocked({
              providerKey: safeSpec.providerKey,
              providerMode: safeSpec.providerMode,
              baseUrl: safeSpec.baseUrl,
              api: safeSpec.api,
              model: safeSpec.model,
              ...(secretEnvelope?.apiKey ? { apiKey: secretEnvelope.apiKey } : {}),
            }, opts);
          } else if (safeSpec.kind === "delete-model") {
            if (await this._configOnlyDeleteAlreadyConverged(safeSpec)) {
              return { status: "applied", stage: "config-write" };
            }
            out = await this._removeModelConfigUnlocked(
              { providerKey: safeSpec.providerKey, modelId: safeSpec.sourceModelId },
              opts,
            );
          } else if (safeSpec.kind === "delete-provider") {
            // 不做 config 收敛短路：poolOnly/env 类 provider 的「清除凭证」正是
            // config 无此键的场景，必须走 unlocked 的 env 分支清池+删变量。
            // 重放幂等由「没有可清除的凭证」→ applied 兜住。
            try {
              out = await this._removeModelProviderUnlocked(safeSpec.providerKey, opts);
            } catch (error) {
              if (error?.code === "hermes_no_credentials_to_clear") {
                return { status: "applied", stage: "config-write" };
              }
              throw error;
            }
          } else if (safeSpec.kind === "update-provider") {
            if (safeSpec.patch?.renameTo) {
              const error = new Error("Hermes config-only 不支持 provider 改名");
              error.code = "config_only_kind_unsupported";
              throw error;
            }
            out = await this._updateModelProviderUnlocked(safeSpec.providerKey, {
              ...safeSpec.patch,
              ...(secretEnvelope?.apiKey ? { apiKey: secretEnvelope.apiKey } : {}),
            }, opts);
          } else {
            const error = new Error(`config-only 不支持的变更类型: ${safeSpec.kind}`);
            error.code = "config_only_kind_unsupported";
            throw error;
          }
        } catch (error) {
          if (error?.code === "config_only_kind_unsupported") throw error;
          // 多 profile 部分成功：unlocked 把 partialProfiles 挂在错误上；深合并幂等，
          // 返回 retryable 让 coordinator 同 operationId 重放收敛，不算终态失败。
          if (Array.isArray(error?.partialProfiles) && error.partialProfiles.length > 0) {
            return {
              status: "partial", stage: "config-write", code: "hermes_partial_profiles",
              retryable: true, message: String(error?.message || error),
            };
          }
          throw error;
        }
        if (Array.isArray(out?.warnings) && out.warnings.length > 0) {
          return {
            status: "partial", stage: "config-write", code: "hermes_partial_profiles",
            retryable: true, message: out.warnings.join("; "),
          };
        }
        return { status: "applied", stage: "config-write" };
      }),
    );
  }

  /** config-only 启动恢复（R272）：只读回配置判定是否已写入，绝不盲重放。 */
  async recoverModelChangeConfigOnly(entry = {}) {
    const applied = { status: "applied", stage: "recovery" };
    const notWritten = { status: "failed", code: "config_write_not_applied", stage: "recovery", retryable: true };
    let byProfile;
    try {
      byProfile = await this._readProvidersByProfile({ fresh: true, requireComplete: true });
    } catch {
      return { status: "partial", code: "recovery_config_unreadable", stage: "recovery", retryable: true };
    }
    const key = String(entry.providerKey || "").trim();
    const providerRows = [...byProfile.values()]
      .map((providers) => providers?.[key])
      .filter((row) => row && typeof row === "object");
    const hasModel = (id) => providerRows.some((row) =>
      this._hermesModelEntries(row.models).some((model) => String(model.id) === String(id)));
    switch (entry.kind) {
      case "create":
      case "update": {
        const targetId = entry.target?.modelId;
        return targetId && hasModel(targetId) ? applied : notWritten;
      }
      case "delete-model": {
        const sourceId = entry.source?.modelId;
        if (providerRows.length === 0) return applied; // 删空连带删 provider
        return sourceId && hasModel(sourceId) ? notWritten : applied;
      }
      case "delete-provider":
        return providerRows.length > 0 ? notWritten : applied;
      default:
        // update-provider：端点/密钥原文不入 journal，无法读回比对；重试幂等无害。
        return notWritten;
    }
  }

  /** delete-model config-only 的幂等终点判定：目标已不在任何 profile 即视为已收敛。
   *  delete-provider 不走此短路（poolOnly/env 类的清凭证语义在 config 之外）。 */
  async _configOnlyDeleteAlreadyConverged(safeSpec) {
    const key = String(safeSpec.providerKey || "").trim();
    const byProfile = await this._readProvidersByProfile({ fresh: true, requireComplete: true });
    const providerRows = [...byProfile.values()]
      .map((providers) => providers?.[key])
      .filter((row) => row && typeof row === "object");
    if (safeSpec.kind === "delete-provider") return providerRows.length === 0;
    const id = String(safeSpec.sourceModelId || "").trim();
    return !providerRows.some((row) =>
      this._hermesModelEntries(row.models).some((model) => String(model.id) === id));
  }

  /**
   * 读取 Hermes 配置真值与运行时目录的严格双快照；失败不回退任何热缓存。
   * @param {{fresh?: boolean}} [options]
   * @returns {Promise<{models: Array<object>, config: Array<object>, runtime: Array<object>}>}
   */
  async getModelCatalogSources({ fresh = true } = {}) {
    // Hermes source 接口只提供可验证快照，fresh:false 也不允许退回普通 SWR 缓存。
    void fresh;
    const captured = this._captureModelCatalogTopology();
    const byProfile = await this._readProvidersByProfile({ fresh: true, requireComplete: true });
    if (this._dashboardTopologyChanged(captured)) {
      throw catalogUnavailable("hermes 模型双来源读取期间 dashboard 拓扑变化，请重试");
    }
    const { catalogRows: configRows } = this._modelConfigFromProfiles(byProfile);
    // env Provider 不可条件写，但其端点覆盖仍属于目录配置真值；仅加入不可逆安全摘要。
    const envConfigRows = await this._envProviderCatalogRows();
    const config = [...configRows, ...envConfigRows];
    const runtimeSnapshot = await this.refreshModelChoices({
      fresh: true,
      requireComplete: true,
      returnSnapshot: true,
    });
    const models = this._runtimeModelsFromChoices(
      runtimeSnapshot.choices,
      runtimeSnapshot.meta,
    );
    // runtime 摘要使用逐 profile 行；UI models 继续使用已去重的 choice 映射。
    return { models, config, runtime: runtimeSnapshot.catalogRows };
  }

  // 聚合只能暴露可从 agent ID 唯一反解回当前 profile 的 dashboard。
  // _installProfileRows 会移除归一化 ID 碰撞项；这里统一 fail-closed，避免
  // 后续聚合重新用 agentIdForProfile() 把两个 profile 合并到同一身份。
  _agentIdForRoutableProfile(profile) {
    const agentId = agentIdForProfile(profile);
    return this.profileById.get(agentId) === profile ? agentId : null;
  }

  // Active (main) model per profile, from each dashboard's /api/model/info.
  async getActiveModel() {
    const byScope = {};
    const providerByScope = {};
    await Promise.all(
      [...this.dashboards.entries()].map(async ([profile, dash]) => {
        const scope = this._agentIdForRoutableProfile(profile);
        if (!scope) return;
        try {
          const { status, body } = await httpGet(`${dash.baseUrl}/api/model/info`, {
            token: dash.token,
          });
          if (status !== 200) return;
          const j = JSON.parse(body);
          if (j.model) byScope[scope] = j.model;
          if (j.provider) providerByScope[scope] = j.provider;
        } catch {
          /* skip */
        }
      }),
    );
    return { byScope, providerByScope };
  }

  _profileForActiveModelScope(scope) {
    if (!scope) return "default";
    const profile = this.profileById.get(scope);
    if (profile) return profile;
    const error = new Error(`hermes: 未知 agent scope ${scope}`);
    error.code = "ERR_HERMES_UNKNOWN_AGENT_SCOPE";
    throw error;
  }

  // Set the main model for a profile. opts.scope = "hermes-<profile>" agent id.
  async setActiveModel(modelId, opts = {}) {
    const agentId = opts.scope;
    const profile = this._profileForActiveModelScope(agentId);
    return this._modelMutationGate.withProfiles(
      [profile],
      `main:${randomUUID()}`,
      () => this._setActiveModelUnlocked(modelId, opts),
    );
  }

  /** 已持 Profile gate 的主模型写入。 */
  async _setActiveModelUnlocked(modelId, opts = {}) {
    const agentId = opts.scope;
    const profile = this._profileForActiveModelScope(agentId);
    const dash = this.dashboards.get(profile);
    if (!dash) throw new Error("hermes: 没有可用的 dashboard");
    const provider = opts.provider || (modelId.includes("/") ? modelId.split("/")[0] : "");
    const { status, body } = await httpRequest("POST", `${dash.baseUrl}/api/model/set`, {
      token: dash.token,
      body: { scope: "main", provider, model: modelId, task: "" },
    });
    if (status >= 300) throw new Error(`hermes set model failed: ${status} ${body}`);
    return { ok: true, model: modelId, scope: agentId || "default" };
  }

  // ---- custom model config (management UI) ----
  // 每 profile 的 config.yaml providers 段（snake_case）。读 GET /api/config
  // （providers 原样带出），写 PUT /api/config——服务端深合并：dict 并入、
  // list 整体替换、null 删键（运行时 _normalize_custom_provider_entry 安全跳过，
  // yaml 里残留 `<key>: null` 无害）。写所有 profile（2026-07-10 用户确认），
  // 单 profile 失败进 warnings、全挂才抛错（铁律 4）。

  // providers 配置读取走 modelChoices 同款 SWR：冷启动时 /api/model/options 的
  // 重刷新会压住 dashboard，/api/config 可能整体超时——直接返回空会让模型页把
  // 「无自定义 provider」缓存住（自定义标签/删除按钮全消失）。有热缓存：立即
  // 返回 + 后台刷新；全失败不覆盖热缓存。写路径必须同时 fresh + requireComplete
  //（陈旧或残缺 byProfile 做合并都会复活/漏写条目）；只读 reveal 仅 fresh，允许降级。
  async _readProvidersByProfile(opts = {}) {
    if (!opts.fresh && this._providersByProfile && this._providersByProfile.size > 0) {
      this._refreshProvidersByProfile().catch(() => {});
      return this._providersByProfile;
    }
    // requireComplete 必须独立发起本轮读取，不能复用普通 SWR 的 in-flight；同时先
    // 禁止底层提交，待完整性与拓扑校验全部通过后再原子替换热缓存。
    const snapshot = opts.requireComplete
      ? await this._readProvidersByProfileNow({ commit: false, invalidateOlder: true })
      : await this._refreshProvidersByProfile();
    // in-flight 读取可能由旧 dashboard 拓扑发起；写操作复用它之前，捕获 profile 集
    // 必须与当前 profile 集精确一致，新增或删除任一 profile 都要拒绝旧快照。
    const currentProfiles = new Set(this.dashboards.keys());
    // 与 runtime 共用同一身份校验：Profile 集、对象引用、baseUrl、token 任一变化都拒绝。
    const topologyChanged = this._dashboardTopologyChanged(snapshot.capturedDashboards);
    if (opts.requireComplete && topologyChanged) {
      throw catalogUnavailable("hermes provider 配置读取期间 dashboard 拓扑变化，请重试");
    }
    // 稳态空集合与空快照在集合比较上会被误判为“完整”；拓扑变化优先报告后，
    // strict 仍须证明至少有一个 dashboard，且不能用空 Map 覆盖旧 Provider 热缓存。
    if (opts.requireComplete && currentProfiles.size === 0) {
      throw catalogUnavailable("hermes provider 配置读取不完整，当前没有可用 dashboard");
    }
    // requireComplete 仅被配置写路径使用；任何 profile 缺失都必须在首个 PUT 前中止，
    // 不能拿残缺 Map 合并写回，更不能在全失败时拿热缓存冒充 fresh 数据。
    if (opts.requireComplete && snapshot.failedProfiles.length > 0) {
      throw catalogUnavailable(
        `hermes provider 配置读取不完整，失败 profile：${snapshot.failedProfiles.join(", ")}`,
      );
    }
    // 即使调用方构造了无 failedProfiles 的异常快照，写路径也必须证明本轮结果逐项
    // 覆盖当前 dashboard；不能仅凭“失败列表为空”推导完整。
    const snapshotProfiles = new Set(snapshot.currentProviders.keys());
    const snapshotIncomplete =
      currentProfiles.size !== snapshotProfiles.size ||
      [...currentProfiles].some((profile) => !snapshotProfiles.has(profile));
    if (opts.requireComplete && snapshotIncomplete) {
      throw catalogUnavailable("hermes provider 配置读取不完整，未覆盖全部当前 profile");
    }
    if (
      opts.requireComplete &&
      snapshot.refreshGeneration >= this._providerCommittedGeneration
    ) {
      // strict 完整性与拓扑校验通过后，才推进已提交水位并原子替换缓存。
      this._providerCommittedGeneration = snapshot.refreshGeneration;
      this._providersByProfile = snapshot.currentProviders;
    }
    // fresh 只读（reveal）必须看到本轮健康 profile 的新值；普通读继续使用 fallback
    // providers，以免页面在部分失败时被残缺目录覆盖。
    return opts.fresh ? snapshot.currentProviders : snapshot.providers;
  }

  _refreshProvidersByProfile() {
    if (!this._providersRefreshing) {
      this._providersRefreshing = this._readProvidersByProfileNow().finally(() => {
        this._providersRefreshing = null;
      });
    }
    return this._providersRefreshing;
  }

  async _readProvidersByProfileNow({ commit = true, invalidateOlder = false } = {}) {
    // 每轮读取领取唯一代际；严格调用会在上层校验后再提交该代际。
    const refreshGeneration = ++this._providerRefreshGeneration;
    // strict 启动即取消更早 ordinary 的提交资格；失败也必须保持进入前完整热缓存。
    if (invalidateOlder) {
      this._providerCommittedGeneration = Math.max(
        this._providerCommittedGeneration,
        refreshGeneration,
      );
    }
    const out = new Map(); // profile -> providers 原始 dict
    const failedProfiles = [];
    // 在任何 await 前固定本轮拓扑，供 requireComplete 调用方识别 in-flight 期间的增删。
    const dashboardEntries = [...this.dashboards.entries()];
    const capturedProfiles = dashboardEntries.map(([profile]) => profile);
    // token 仅保存在本轮内存快照中用于等值判断，禁止拼入日志或错误消息。
    const capturedDashboards = new Map(
      dashboardEntries.map(([profile, dashboard]) => [
        profile,
        {
          ref: dashboard,
          baseUrl: dashboard?.baseUrl,
          token: dashboard?.token,
        },
      ]),
    );
    await Promise.all(
      dashboardEntries.map(async ([profile, dash]) => {
        try {
          const response = await this._dashGet(dash, "/api/config", { timeoutMs: 15000 });
          const { status, body } = response;
          if (status !== 200) {
            this._providerMutationSnapshots.delete(profile);
            failedProfiles.push(profile);
            return;
          }
          this._providerMutationSnapshots.set(
            profile,
            this._modelMutationGate.inspectStore(response, "provider"),
          );
          const cfg = JSON.parse(body);
          out.set(
            profile,
            cfg && typeof cfg.providers === "object" && cfg.providers ? cfg.providers : {},
          );
        } catch {
          this._providerMutationSnapshots.delete(profile);
          failedProfiles.push(profile);
        }
      }),
    );
    // ordinary 同样必须验证捕获拓扑；拓扑已换时只返回本轮结果，绝不提交旧 dashboard 数据。
    const topologyChanged = this._dashboardTopologyChanged(capturedDashboards);

    // 只把完整结果写入热缓存。普通读在部分/全失败时优先沿用上次完整缓存；
    // 没有热缓存时仍可返回本轮读到的部分数据，以保留 getModelConfig 的读侧降级。
    if (failedProfiles.length === 0) {
      if (
        commit &&
        !topologyChanged &&
        refreshGeneration >= this._providerCommittedGeneration
      ) {
        this._providerCommittedGeneration = refreshGeneration;
        this._providersByProfile = out;
      }
      return {
        providers: out,
        currentProviders: out,
        failedProfiles,
        capturedProfiles,
        capturedDashboards,
        refreshGeneration,
      };
    }
    const providers =
      this._providersByProfile && this._providersByProfile.size > 0
        ? this._providersByProfile
        : out;
    return {
      providers,
      currentProviders: out,
      failedProfiles,
      capturedProfiles,
      capturedDashboards,
      refreshGeneration,
    };
  }

  // config.yaml 的 models 有三种在野形状：字符串数组、[{id, context_length}] 数组、
  // 以及官方 CLI/desktop 写的 canonical dict（{modelId: {context_length?…}}，无 meta
  // 时值为 {} 或手写留空的 null）。上游 normalizer 只把 dict 当第一公民（老版
  // Hermes 对数组形状直接静默丢弃、显示 0 模型）——读侧三种都收，统一成
  // [{id, ...meta}]；否则官方工具建的 provider 在模型页会凭空显示没有模型。
  _hermesModelEntries(raw) {
    if (Array.isArray(raw)) {
      return raw
        .map((x) => (typeof x === "string" ? { id: x.trim() } : x))
        .filter((x) => x && typeof x === "object" && x.id);
    }
    if (raw && typeof raw === "object") {
      return Object.entries(raw)
        .map(([id, meta]) => ({
          id: String(id).trim(),
          ...(meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {}),
        }))
        .filter((x) => x.id);
    }
    return [];
  }

  /**
   * 将各 profile 的 providers 配置合并为模型页 Provider 行；不读取凭证池或环境变量。
   * @param {Map<string, object>} byProfile
   * 同时返回不去重的公开 catalogRows，让 revision 感知不同 profile 的配置差异。
   * @returns {{providers: Array<object>, catalogRows: Array<object>}}
   */
  _modelConfigFromProfiles(byProfile) {
    const merged = new Map(); // key -> 聚合行
    const catalogRows = [];
    for (const [profile, providers] of byProfile) {
      for (const [key, raw] of Object.entries(providers)) {
        if (!raw || typeof raw !== "object") continue;
        const baseUrl = String(raw.base_url || raw.baseUrl || raw.url || raw.api || "").trim();
        if (!baseUrl) continue;
        const providerConfigDigest = createHash("sha256")
          .update(JSON.stringify({ baseUrl, apiMode: String(raw.api_mode || "") }))
          .digest("hex");
        let slot = merged.get(key);
        if (!slot) {
          slot = {
            key,
            name: typeof raw.name === "string" ? raw.name : undefined,
            baseUrl,
            api: typeof raw.api_mode === "string" ? raw.api_mode : undefined,
            hasApiKey: Boolean(
              String(raw.api_key || "").trim() || String(raw.key_env || "").trim(),
            ),
            profiles: [],
            models: [],
            _ids: new Set(),
          };
          merged.set(key, slot);
        }
        slot.profiles.push(profile);
        for (const m of this._hermesModelEntries(raw.models)) {
          const id = String(m.id);
          // revision 必须保留每个 profile 的真实行，不能被 UI 的 provider/id 去重吞掉差异。
          catalogRows.push({
            id,
            name: typeof m.name === "string" ? m.name : undefined,
            provider: key,
            backendId: "hermes",
            profile,
            providerConfigDigest,
            contextWindow:
              Number(m.context_length || m.contextLength) > 0
                ? Number(m.context_length || m.contextLength)
                : undefined,
            maxTokens:
              Number(m.max_tokens || m.maxTokens) > 0
                ? Number(m.max_tokens || m.maxTokens)
                : undefined,
            reasoning: typeof m.reasoning === "boolean" ? m.reasoning : undefined,
          });
          if (slot._ids.has(id)) continue;
          slot._ids.add(id);
          slot.models.push({
            id,
            name: typeof m.name === "string" ? m.name : undefined,
            contextWindow:
              Number(m.context_length || m.contextLength) > 0
                ? Number(m.context_length || m.contextLength)
                : undefined,
            maxTokens:
              Number(m.max_tokens || m.maxTokens) > 0
                ? Number(m.max_tokens || m.maxTokens)
                : undefined,
            reasoning: typeof m.reasoning === "boolean" ? m.reasoning : undefined,
            catalogId: id,
          });
        }
        if (this._hermesModelEntries(raw.models).length === 0) {
          catalogRows.push({
            id: "__provider_config__",
            provider: key,
            backendId: "hermes",
            profile,
            providerConfigDigest,
          });
        }
      }
    }
    return {
      providers: [...merged.values()].map(({ _ids, ...provider }) => ({
        ...provider,
        source: "config",
        editable: true,
      })),
      catalogRows,
    };
  }

  /**
   * 为各 Profile 的 env Provider 端点覆盖生成不可逆目录摘要。
   * API Key/password 行完全排除，输出中不保留变量值、URL 或 dashboard token。
   */
  async _envProviderCatalogRows() {
    const rows = [];
    for (const [profile, dash] of [...this.dashboards.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const vars = await this._listEnvVarsOf(dash);
      if (!Array.isArray(vars)) {
        if (this._envCatalogSupportedProfiles.has(profile)) {
          throw catalogUnavailable(`hermes env Provider 读取不完整: ${profile}`);
        }
        // 从未证明支持 /api/env 的旧 dashboard 使用稳定“无此来源”语义。
        continue;
      }
      this._envCatalogSupportedProfiles.add(profile);
      const grouped = new Map();
      for (const item of vars) {
        if (item?.category !== "provider" || !item.provider || item.isPassword === true) continue;
        const current = grouped.get(item.provider) || [];
        let valueDigest = "unset";
        if (item.isSet === true) {
          const revealed = await this._revealEnvVarOf(dash, item.key);
          valueDigest = createHash("sha256").update(String(revealed)).digest("hex");
        }
        current.push({ key: String(item.key || ""), isSet: item.isSet === true, valueDigest });
        grouped.set(item.provider, current);
      }
      for (const [provider, values] of grouped) {
        const providerConfigDigest = createHash("sha256")
          .update(JSON.stringify({ profile, provider, values: values.sort((a, b) => a.key.localeCompare(b.key)) }))
          .digest("hex");
        rows.push({ id: "__provider_env__", provider, backendId: "hermes", profile, providerConfigDigest });
      }
    }
    return rows;
  }

  /** 单 Profile 读取一个非 password env 端点明文；调用方只允许立即哈希，不得返回或缓存。 */
  async _revealEnvVarOf(dash, key) {
    const { status, body } = await httpRequest("POST", `${dash.baseUrl}/api/env/reveal`, {
      token: dash.token,
      body: { key },
      timeoutMs: 10000,
    });
    if (status >= 300) throw catalogUnavailable("hermes env Provider 摘要读取失败");
    try {
      const parsed = JSON.parse(body);
      return String(parsed.value ?? parsed.redacted_value ?? "");
    } catch {
      throw catalogUnavailable("hermes env Provider 摘要响应无效");
    }
  }

  /**
   * 读取模型页 Provider 配置；普通读取保留原有 SWR，fresh 调用可要求完整快照。
   * @param {{fresh?: boolean, requireComplete?: boolean}} [options]
   * @returns {Promise<{providers: Array<object>}>}
   */
  async getModelConfig({ fresh = false, requireComplete = false } = {}) {
    const byProfile = await this._readProvidersByProfile({ fresh, requireComplete });
    const { providers: baseConfigProviders } = this._modelConfigFromProfiles(byProfile);
    // 凭证池条数（第三层凭证）：copilot 这类「.env 里没变量却能用」的真相所在
    const pool = await this._readPool();
    const poolCountFor = (key, source) => {
      const id = this._poolIdFor(key, source);
      return (pool.get(id) || pool.get(key) || []).length;
    };
    const configProviders = baseConfigProviders.map((provider) => ({
      ...provider,
      poolCount: poolCountFor(provider.key, "config"),
    }));
    // 内置目录 provider：凭证在 .env 里。config.yaml 同名条目优先（用户显式覆盖）。
    const taken = new Set(configProviders.map((p) => p.key));
    const envProviders = (await this._envProviders())
      .filter((p) => !taken.has(p.key))
      .map((p) => ({ ...p, poolCount: poolCountFor(p.key, "env") }));
    // 只有池条目、没有 env 变量的 provider（openai-codex / xai-oauth / qwen-oauth …）：
    // 没有可编辑的 Key/端点，但池条目可以删——不纳入就等于「看得见用得着却管不了」。
    // editable:false 是 UI 的承重信号：Key/端点由 OAuth/CLI 工具管理，编辑表单不该
    // 渲染（保存必失败）；删除=只清凭证池。
    for (const p of [...configProviders, ...envProviders]) taken.add(p.key);
    const authed = new Set(this.modelChoices.map((c) => c.provider));
    const poolOnly = [...pool.entries()]
      .filter(([id, entries]) => !id.startsWith("custom:") && !taken.has(id) && entries.length > 0)
      .map(([id, entries]) => ({
        key: id,
        name: id,
        authenticated: authed.has(id),
        baseUrl: "",
        hasApiKey: false,
        hasBaseUrl: false,
        source: "env",
        editable: false,
        poolCount: entries.length,
        models: [],
      }));
    return { providers: [...configProviders, ...envProviders, ...poolOnly] };
  }

  // ---- credential pool（auth.json → credential_pool）----
  // Hermes 的第三层凭证：轮换 key 池。条目的 source 说明 key 从哪来
  // （env:XXX_API_KEY / gh_cli / manual / claude_code / qwen-cli …），所以
  // 「.env 里没有变量」不等于「没有凭证」。自定义 provider 在池里带 custom: 前缀。
  _poolIdFor(providerKey, source) {
    return source === "config" ? `custom:${providerKey}` : providerKey;
  }

  async _readPoolOf(dash) {
    const { status, body } = await httpGet(`${dash.baseUrl}/api/credentials/pool`, {
      token: dash.token,
      timeoutMs: 10000,
    });
    if (status !== 200) return null;
    const j = JSON.parse(body);
    const map = new Map();
    for (const p of Array.isArray(j.providers) ? j.providers : []) {
      map.set(String(p.provider), Array.isArray(p.entries) ? p.entries : []);
    }
    return map;
  }

  // 读失败不返回空——PUT /api/config 会触发 dashboard reconfigure，紧随的读会超时。
  // 空结果会让模型页瞬间丢掉所有 provider 的编辑入口（同 _readProvidersByProfile 的教训）。
  async _readPool() {
    const dash = this._envDash();
    if (!dash) return this._poolCache || new Map();
    try {
      const map = await this._readPoolOf(dash);
      if (!map) return this._poolCache || new Map();
      this._poolCache = map;
      return map;
    } catch {
      return this._poolCache || new Map();
    }
  }

  _mapPoolEntry(e) {
    return {
      index: Number(e.index) || 0,
      id: e.id || undefined,
      label: e.label || undefined,
      authType: e.auth_type || undefined,
      source: e.source || undefined,
      lastStatus: e.last_status || undefined,
      requestCount: Number(e.request_count) || 0,
      hasRefresh: e.has_refresh === true,
      tokenPreview: e.token_preview || undefined,
    };
  }

  async listProviderCredentials(providerKey) {
    const key = String(providerKey || "").trim();
    if (!key) return [];
    const pool = await this._readPool();
    // 先按裸 slug 找（内置 provider），再按 custom: 前缀找（自定义 provider）
    const entries = pool.get(key) || pool.get(`custom:${key}`) || [];
    return entries.map((e) => this._mapPoolEntry(e));
  }

  async _deletePoolEntry(poolId, index) {
    const dash = this._envDash();
    if (!dash) throw new Error("hermes: 没有可用的 dashboard");
    return this._deletePoolEntryOf(dash, poolId, index);
  }

  async _deletePoolEntryOf(dash, poolId, index) {
    const { status, body } = await httpRequest(
      "DELETE",
      `${dash.baseUrl}/api/credentials/pool/${encodeURIComponent(poolId)}/${index}`,
      { token: dash.token, timeoutMs: 8000 },
    );
    if (status >= 300) throw new Error(`${status} ${String(body).slice(0, 120)}`);
  }

  async removeProviderCredential(providerKey, index) {
    const key = String(providerKey || "").trim();
    const i = Number(index);
    if (!key || !Number.isInteger(i) || i < 1) throw new Error("缺少 providerKey/index");
    const pool = await this._readPool();
    const poolId = pool.has(key) ? key : pool.has(`custom:${key}`) ? `custom:${key}` : null;
    if (!poolId) throw new Error(`provider ${key} 没有凭证池条目`);
    // env:VAR 引用条目：只删池条目会被 dashboard load_pool 从 .env 立即回种
    //（「删除即撤销授权」变成假动作）。撤销 = 删池条目 + 删掉 .env 里的源变量。
    const entrySource = String((pool.get(poolId) || [])[i - 1]?.source || "");
    await this._deletePoolEntry(poolId, i);
    const warnings = [];
    if (entrySource.startsWith("env:")) {
      const envVar = entrySource.slice("env:".length).trim();
      if (envVar) {
        try {
          const r = await this.deleteEnvVar(envVar);
          if (r?.warnings?.length) warnings.push(...r.warnings.map((w) => `${envVar}: ${w}`));
        } catch (err) {
          warnings.push(`${envVar}: ${err?.message || err}`);
        }
      }
    }
    return warnings.length ? { ok: true, warnings } : { ok: true };
  }

  // 清空某 provider 的整个池。DELETE 用 1-based index，删一条后其后条目会前移
  // → 必须倒序删，否则会漏删/错删。isolated dashboard 各有一份 auth.json/池，
  // 所以逐 dashboard 清（只清 default 会让 provider 在其它 profile 上"复活"）。
  async _clearProviderPool(providerKey, source) {
    const poolId = this._poolIdFor(providerKey, source);
    let removed = 0;
    const failures = [];
    // env:VAR 引用条目只删池不删变量会被 dashboard load_pool 从 .env 回种；
    // 收集删除成功条目的变量名，调用方级联删 .env 才是真正的「撤销」。
    const envVars = new Set();
    for (const dash of this._envDashes()) {
      let pool;
      try {
        pool = await this._readPoolOf(dash);
      } catch {
        pool = null;
      }
      const tag = dash.profile || dash.baseUrl;
      if (!pool) {
        failures.push(`${tag}: 凭证池读取失败`);
        continue;
      }
      const usedId = pool.has(poolId) ? poolId : providerKey;
      const entries = pool.get(usedId) || [];
      for (let i = entries.length; i >= 1; i--) {
        try {
          await this._deletePoolEntryOf(dash, usedId, i);
          removed += 1;
          const entrySource = String(entries[i - 1]?.source || "");
          if (entrySource.startsWith("env:")) {
            const envVar = entrySource.slice("env:".length).trim();
            if (envVar) envVars.add(envVar);
          }
        } catch (err) {
          failures.push(`${tag} pool#${i}: ${err?.message || err}`);
        }
      }
    }
    return { removed, failures, envVars: [...envVars] };
  }

  // provider slug -> 它的 API Key / Base URL 环境变量。映射来自 /api/env 每条自带的
  // provider 归属（上游 provider_catalog 生成），不硬编码 provider 名单。
  // 端点默认值由上游决定，我们只在 *_BASE_URL 被显式设置时才知道 → baseUrl 留空。
  async _envProviders() {
    let vars;
    try {
      vars = await this.listEnvVars();
    } catch {
      vars = [];
    }
    // listEnvVars 读挂/超时会返回 [] → provider 列表会整体塌成空，模型页丢失全部
    // 编辑入口。热缓存兜底：只在真读到东西时更新。
    if (vars.some((v) => v.category === "provider")) this._envVarsCache = vars;
    else if (this._envVarsCache) vars = this._envVarsCache;
    else return [];
    const bySlug = new Map();
    for (const v of vars) {
      if (v.category !== "provider" || !v.provider) continue;
      let slot = bySlug.get(v.provider);
      if (!slot) {
        slot = { key: v.provider, name: v.providerLabel || v.provider, keyVars: [], urlVars: [] };
        bySlug.set(v.provider, slot);
      }
      (v.isPassword ? slot.keyVars : slot.urlVars).push(v);
    }
    const pick = (rows) => rows.find((r) => r.isSet) || rows[0];
    // 目录里有模型 ⇒ 该 provider 已经能用（可能靠 OAuth/CLI/中转认证，未必靠 env Key）
    const authed = new Set(this.modelChoices.map((c) => c.provider));
    return [...bySlug.values()]
      .filter((s) => s.keyVars.length > 0 || s.urlVars.length > 0)
      .map((s) => {
        const keyVar = s.keyVars.length ? pick(s.keyVars) : null;
        const urlVar = s.urlVars.length ? pick(s.urlVars) : null;
        return {
          key: s.key,
          name: s.name,
          authenticated: authed.has(s.key),
          // /api/env 的 redacted_value 连 URL 也截断 → 明文随 reveal 一起给；
          // 未覆盖时上游用内置默认端点，这里不猜。
          baseUrl: "",
          hasBaseUrl: !!urlVar?.isSet,
          hasApiKey: !!keyVar?.isSet,
        source: "env",
        // env 广播没有 ETag/CAS 与可逆 journal，统一只读，避免借用 config capability。
        editable: false,
          keyEnv: keyVar?.key,
          baseUrlEnv: urlVar?.key,
          models: [], // 目录由上游给，不可在此增删
        };
      });
  }

  /** 使用 fresh GET 建立的 Profile ETag 执行 Provider 条件写；config-only 传
   *  conditional:false 走官方同款无锁深合并 PUT（last-write-wins，与官方
   *  dashboard/desktop 行为一致），不读也不更新 ETag 快照。 */
  async _putProviderEntry(dash, key, entry, { conditional = true } = {}) {
    const profile = [...this.dashboards.entries()].find(([, candidate]) => candidate === dash)?.[0];
    const snapshot = this._providerMutationSnapshots.get(profile);
    // conditionalHeaders 对未声明条件写的 dashboard 会直接抛错，无条件路径不得触碰。
    const response = await httpRequest("PUT", `${dash.baseUrl}/api/config`, {
      token: dash.token,
      body: { config: { providers: { [key]: entry } } },
      timeoutMs: 10000,
      ...(conditional ? { extraHeaders: this._modelMutationGate.conditionalHeaders(snapshot) } : {}),
    });
    if (!conditional) {
      if (response.status < 200 || response.status >= 300) {
        const error = new Error(`hermes config 写入失败 (HTTP ${response.status})`);
        error.code = "hermes_config_write_failed";
        error.status = response.status;
        throw error;
      }
      return;
    }
    this._modelMutationGate.assertConditionalSuccess(response, snapshot);
    // 成功响应必须重新声明下一版本；缺 header 时下次写 fail-closed，不沿用旧 ETag。
    this._providerMutationSnapshots.set(
      profile,
      this._modelMutationGate.inspectStore(response, "provider"),
    );
  }

  /** Provider 新增只能在 coordinator context 内，并锁住本轮全部 Profile。 */
  async addModelConfig(spec = {}) {
    const { operationId } = this._modelMutationGate.assertCoordinatorContext();
    return this._modelMutationGate.withProfiles(
      [...this.dashboards.keys()],
      operationId,
      () => this._addModelConfigUnlocked(spec),
    );
  }

  /** 已持 gate 的 Provider 新增实现；首次写仍由 If-Match 条件保护（config-only 传 opts 降级为无条件写）。 */
  async _addModelConfigUnlocked(spec = {}, opts = {}) {
    const key = String(spec.providerKey || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) throw new Error("providerKey 非法");
    const m = spec.model || {};
    const id = String(m.id || "").trim();
    if (!id) throw new Error("缺少模型 id");
    const requestedBaseUrl = normalizeOptionalString(spec.baseUrl, "baseUrl");
    // 显式端点必须在读取任一 profile 配置前校验，保证非法请求绝不触发配置 I/O。
    if (requestedBaseUrl) assertHttpUrl(requestedBaseUrl, "baseUrl");
    if (this.dashboards.size === 0) throw new Error("hermes: 没有可用的 dashboard");
    const byProfile = await this._readProvidersByProfile({ fresh: true, requireComplete: true });
    // 端点字段：spec 优先，否则从任一已有该 provider 的 profile 复制
    let template = null;
    for (const providers of byProfile.values()) {
      if (providers[key] && typeof providers[key] === "object") {
        template = providers[key];
        break;
      }
    }
    const baseUrl = requestedBaseUrl || String(template?.base_url || "").trim();
    if (!baseUrl) throw new Error(`provider ${key} 不存在，新建需提供 baseUrl`);
    // 没有模板表示正在新建 provider；最终采用的端点必须满足同一后端约束。
    if (!template) assertHttpUrl(baseUrl, "baseUrl");
    const failures = [];
    const targets = [...this.dashboards.entries()];
    const writes = await Promise.allSettled(
      targets.map(async ([profile, dash]) => {
        try {
          const cur = byProfile.get(profile)?.[key];
          const base =
            cur && typeof cur === "object"
              ? { ...cur }
              : template && typeof template === "object"
                ? { ...template }
                : {};
          const models = this._hermesModelEntries(base.models).filter((x) => x.id !== id);
          models.push({
            id,
            ...(Number(m.contextWindow) > 0 ? { context_length: Number(m.contextWindow) } : {}),
          });
          const entry = {
            ...base,
            base_url: baseUrl,
            ...(String(spec.apiKey || "").trim() ? { api_key: String(spec.apiKey).trim() } : {}),
            ...(String(spec.api || "").trim() ? { api_mode: String(spec.api).trim() } : {}),
            models,
          };
          await this._putProviderEntry(dash, key, entry, opts);
        } catch (err) {
          if (err?.code === "hermes_conditional_write_unsupported" || err?.code === "hermes_write_conflict") throw err;
          failures.push(`${profile}: ${err?.message || err}`);
        }
      }),
    );
    const failedIndex = writes.findIndex((result) => result.status === "rejected");
    if (failedIndex >= 0) {
      const error = writes[failedIndex].reason;
      // Adapter 必须在异常返回前知道哪些 Profile 已落 target，才能持久化可恢复阶段。
      error.partialProfiles = targets.filter((_, index) => writes[index].status === "fulfilled").map(([profile]) => profile);
      error.failedProfiles = targets.filter((_, index) => writes[index].status === "rejected").map(([profile]) => profile);
      throw error;
    }
    if (failures.length === this.dashboards.size) {
      throw new Error(`hermes 全部 profile 写入失败：${failures.join("; ")}`);
    }
    this._providersByProfile = null; // 写后失效，让下一次 getModelConfig 阻塞取新
    return failures.length ? { warnings: failures } : {};
  }

  /** Provider 模型删除只能在 coordinator context 内执行。 */
  async removeModelConfig(ref = {}) {
    const { operationId } = this._modelMutationGate.assertCoordinatorContext();
    return this._modelMutationGate.withProfiles(
      [...this.dashboards.keys()],
      operationId,
      () => this._removeModelConfigUnlocked(ref),
    );
  }

  /** 已持 gate 的模型删除实现。 */
  async _removeModelConfigUnlocked(ref = {}, opts = {}) {
    const key = String(ref.providerKey || "").trim();
    const id = String(ref.modelId || "").trim();
    if (!key || !id) throw new Error("缺少 providerKey/modelId");
    const byProfile = await this._readProvidersByProfile({ fresh: true, requireComplete: true });
    const holders = [...byProfile.entries()].filter(([, providers]) => {
      const e = providers[key];
      return (
        e &&
        typeof e === "object" &&
        this._hermesModelEntries(e.models).some((x) => String(x.id) === id)
      );
    });
    if (holders.length === 0) {
      throw new Error(`模型 ${key}/${id} 不在任何 profile 的自定义配置里`);
    }
    const failures = [];
    const writes = await Promise.allSettled(
      holders.map(async ([profile, providers]) => {
        const dash = this.dashboards.get(profile);
        // fresh 快照完成后 dashboard 仍可能被重配置移除；这同样属于删除失败，
        // 不能静默计作成功并清掉客户端目录缓存。
        if (!dash) {
          failures.push(`${profile}: dashboard 不可用`);
          return;
        }
        try {
          const cur = providers[key];
          const models = this._hermesModelEntries(cur.models).filter((x) => String(x.id) !== id);
          // 删空 → 整个 provider 置 null（删键）
          const entry = models.length === 0 ? null : { ...cur, models };
          await this._putProviderEntry(dash, key, entry, opts);
        } catch (err) {
          if (err?.code === "hermes_conditional_write_unsupported" || err?.code === "hermes_write_conflict") throw err;
          failures.push(`${profile}: ${err?.message || err}`);
        }
      }),
    );
    const conditionalFailure = writes.find((result) => result.status === "rejected");
    if (conditionalFailure?.status === "rejected") throw conditionalFailure.reason;
    if (failures.length === holders.length) {
      throw new Error(`hermes 删除失败：${failures.join("; ")}`);
    }
    this._providersByProfile = null;
    if (failures.length === 0) {
      const catalogKey = modelCatalogKey(key, id);
      await this._syncRemovedModelCache(
        holders.map(([profile]) => profile),
        (identity) => identity === catalogKey,
      );
    }
    return failures.length ? { warnings: failures } : {};
  }

  /**
   * 配置删除完全成功后同步裁剪 Hermes 模型目录缓存。
   * matcher 接收 provider+id 复合键，因此单模型与整 provider 删除共用同一套消歧逻辑。
   */
  async _syncRemovedModelCache(holderProfiles, matcher) {
    // 删除期间若已有目录刷新在途，必须先等它提交；否则旧请求晚到会覆盖本次裁剪。
    // 刷新失败不应反向让已经成功的配置写入报错。
    const refreshing = this._modelsRefreshing;
    if (refreshing) await refreshing.catch(() => {});

    for (const profile of holderProfiles) {
      // 上一轮快照里还留着刚删掉的模型；留着它，下次该 profile 刷新失败时补位会把
      // 删除撤销掉。丢弃即可——补位只是「宁可旧也别清空」，没有它退回缺席语义。
      this._modelCatalogProfileSnapshots.delete(profile);
      // 缺失身份集合表示该 profile 的 options 本轮失败，此时不能制造“已知为空”的快照。
      if (!this.modelsByProfileIdentity.has(profile)) continue;
      const identities = this.modelsByProfileIdentity.get(profile);
      const nextIdentities = new Set([...identities].filter((identity) => !matcher(identity)));
      this.modelsByProfileIdentity.set(profile, nextIdentities);

      // 对外继续保持裸 id 协议，并按复合身份的出现顺序去重派生 fallback。
      const nextModels = [
        ...new Set([...nextIdentities].map((identity) => String(JSON.parse(identity)[1] || ""))),
      ].filter(Boolean);
      this.modelsByProfile.set(profile, nextModels);

      // agent.fallbacks 与 modelsByProfile 是同一目录快照的派生状态，必须原子式更新。
      const agentId = [...this.profileById.entries()].find(([, name]) => name === profile)?.[0];
      const agent = this.agents.find((row) => row.id === agentId);
      if (agent) agent.fallbacks = nextModels;
    }

    // 只有完整身份快照才能证明某个复合身份已不被任何 profile 暴露；未知必须保守保留。
    const identitySnapshotComplete =
      this.modelsByProfileIdentity.size === this.dashboards.size &&
      [...this.dashboards.keys()].every((profile) =>
        this.modelsByProfileIdentity.has(profile),
      );
    if (!identitySnapshotComplete) return;

    const exposed = new Set(
      [...this.modelsByProfileIdentity.values()].flatMap((identities) => [...identities]),
    );
    this.modelChoices = this.modelChoices.filter((model) => {
      const identity = modelCatalogKey(model.provider, model.id);
      return !matcher(identity) || exposed.has(identity);
    });
    if (this.modelMeta) {
      for (const identity of this.modelMeta.keys()) {
        if (matcher(identity) && !exposed.has(identity)) this.modelMeta.delete(identity);
      }
    }
  }

  /** Provider 更新只能由 coordinator 进入，并与其它模型写共享 Profile 锁。 */
  async updateModelProvider(providerKey, patch = {}) {
    const { operationId } = this._modelMutationGate.assertCoordinatorContext();
    return this._modelMutationGate.withProfiles(
      [...this.dashboards.keys()],
      operationId,
      () => this._updateModelProviderUnlocked(providerKey, patch),
    );
  }

  /** 已持 gate 的 Provider 更新实现。 */
  async _updateModelProviderUnlocked(providerKey, patch = {}, opts = {}) {
    const key = String(providerKey || "").trim();
    if (!key) throw new Error("缺少 providerKey");
    const fields = {};
    const requestedBaseUrl = normalizeOptionalString(patch.baseUrl, "baseUrl");
    // 更新入口先校验端点，避免在 UI 之外调用时绕过约束并触发配置读取。
    if (requestedBaseUrl) {
      assertHttpUrl(requestedBaseUrl, "baseUrl");
      fields.base_url = requestedBaseUrl;
    }
    if (String(patch.apiKey || "").trim()) fields.api_key = String(patch.apiKey).trim();
    if (String(patch.api || "").trim()) fields.api_mode = String(patch.api).trim();
    if (Object.keys(fields).length === 0) return {};
    const byProfile = await this._readProvidersByProfile({ fresh: true, requireComplete: true });
    // 只更新已有该 provider 的 profile（深合并只并入端点字段，不碰 models）
    const holders = [...byProfile.entries()].filter(
      ([, providers]) => providers[key] && typeof providers[key] === "object",
    );
    // config.yaml 里没有 → 内置目录 provider，凭证写它的环境变量
    if (holders.length === 0) {
      // config-only 只服务 config 类 provider；env provider 由 preview 的
      // hermes_env_provider_read_only blocker 拦截，到达这里说明快照竞态。
      if (opts.conditional === false) throw new Error(`provider ${key} 不在任何 profile 的 config 里`);
      return this._updateEnvProvider(key, patch);
    }
    const failures = [];
    const writes = await Promise.allSettled(
      holders.map(async ([profile]) => {
        const dash = this.dashboards.get(profile);
        if (!dash) return;
        try {
          await this._putProviderEntry(dash, key, fields, opts);
        } catch (err) {
          if (err?.code === "hermes_conditional_write_unsupported" || err?.code === "hermes_write_conflict") throw err;
          failures.push(`${profile}: ${err?.message || err}`);
        }
      }),
    );
    const failedIndex = writes.findIndex((result) => result.status === "rejected");
    if (failedIndex >= 0) {
      const error = writes[failedIndex].reason;
      error.partialProfiles = holders.filter((_, index) => writes[index].status === "fulfilled").map(([profile]) => profile);
      error.failedProfiles = holders.filter((_, index) => writes[index].status === "rejected").map(([profile]) => profile);
      throw error;
    }
    if (failures.length === holders.length) {
      throw new Error(`hermes provider 更新失败：${failures.join("; ")}`);
    }
    this._providersByProfile = null;
    return failures.length ? { warnings: failures } : {};
  }

  // 内置目录 provider：Key/端点是 .env 变量（isolated dashboard 各一份，写走广播）。
  async _updateEnvProvider(providerKey, patch = {}) {
    const row = (await this._envProviders()).find((p) => p.key === providerKey);
    // 没有 env 变量行 = 纯 OAuth/CLI/池类 provider（openai-codex、copilot…）——
    // 不是"不存在"，是没有可写的变量。报错要说人话，UI 也据 editable:false 不再放行到这。
    if (!row) {
      throw new Error(
        `provider ${providerKey} 没有可写的 API Key/端点变量——它走 OAuth / CLI 授权，请在对应登录工具里管理`,
      );
    }
    const writes = [];
    const apiKey = String(patch.apiKey || "").trim();
    // 私有 env 写路径也复用严格归一化，避免未来新增调用点重新引入隐式强转。
    const baseUrl = normalizeOptionalString(patch.baseUrl, "baseUrl");
    if (apiKey) {
      if (!row.keyEnv) throw new Error(`${providerKey} 走授权登录，没有可写的 API Key 变量`);
      writes.push([row.keyEnv, apiKey]);
    }
    if (baseUrl) {
      if (!row.baseUrlEnv) throw new Error(`${providerKey} 没有可覆盖的端点变量`);
      writes.push([row.baseUrlEnv, baseUrl]);
    }
    // 端点覆盖被显式清空 → 删掉该变量，回落上游默认端点（写空串会留下空值）
    const clearUrl = patch.clearBaseUrl === true && !baseUrl && row.baseUrlEnv && row.hasBaseUrl;
    if (writes.length === 0 && !clearUrl) return {};
    // failures = 整个变量一台 dashboard 都没写上（广播层 throw）；warnings = 广播的
    // 部分 dashboard 失败。全失败判定只看 failures，否则 warnings 会把「部分成功」
    // 误判成全失败。
    const failures = [];
    const warnings = [];
    for (const [k, v] of writes) {
      try {
        const r = await this.setEnvVar(k, v);
        if (r?.warnings?.length) warnings.push(...r.warnings.map((w) => `${k}: ${w}`));
      } catch (err) {
        failures.push(`${k}: ${err?.message || err}`);
      }
    }
    if (clearUrl) {
      try {
        const r = await this.deleteEnvVar(row.baseUrlEnv);
        if (r?.warnings?.length) warnings.push(...r.warnings.map((w) => `${row.baseUrlEnv}: ${w}`));
      } catch (err) {
        failures.push(`${row.baseUrlEnv}: ${err?.message || err}`);
      }
    }
    // clear 也是一次真实写操作：分母必须覆盖 set + clear，才能区分全失败与部分失败。
    const operationCount = writes.length + (clearUrl ? 1 : 0);
    if (failures.length === operationCount) {
      throw new Error(`hermes 环境变量写入失败：${failures.join("; ")}`);
    }
    const combined = [...failures, ...warnings];
    return combined.length ? { warnings: combined } : {};
  }

  /** Provider 删除只能由 coordinator 进入。 */
  async removeModelProvider(providerKey) {
    const { operationId } = this._modelMutationGate.assertCoordinatorContext();
    return this._modelMutationGate.withProfiles(
      [...this.dashboards.keys()],
      operationId,
      () => this._removeModelProviderUnlocked(providerKey),
    );
  }

  /** 已持 gate 的 Provider 删除实现。 */
  async _removeModelProviderUnlocked(providerKey, opts = {}) {
    const key = String(providerKey || "").trim();
    if (!key) throw new Error("缺少 providerKey");
    const byProfile = await this._readProvidersByProfile({ fresh: true, requireComplete: true });
    const holders = [...byProfile.entries()].filter(
      ([, providers]) => providers[key] && typeof providers[key] === "object",
    );
    if (holders.length > 0) {
      // config 类：从所有含它的 profile 移除整条（null 删键）+ 清掉它的池条目
      const failures = [];
      const writes = await Promise.allSettled(
        holders.map(async ([profile]) => {
          const dash = this.dashboards.get(profile);
          // fresh 快照后 dashboard 仍可能消失；必须计为失败，不能伪装为完整删除。
          if (!dash) {
            failures.push(`${profile}: dashboard 不可用`);
            return;
          }
          try {
            await this._putProviderEntry(dash, key, null, opts);
          } catch (err) {
            if (err?.code === "hermes_conditional_write_unsupported" || err?.code === "hermes_write_conflict") throw err;
            failures.push(`${profile}: ${err?.message || err}`);
          }
        }),
      );
      const conditionalFailure = writes.find((result) => result.status === "rejected");
      if (conditionalFailure?.status === "rejected") throw conditionalFailure.reason;
      if (failures.length === holders.length) {
        throw new Error(`hermes 删除 provider 失败：${failures.join("; ")}`);
      }
      this._providersByProfile = null;
      // 只有所有 holder 都删除成功才隐藏该 provider 的模型；部分失败时真实目录仍存在。
      if (failures.length === 0) {
        await this._syncRemovedModelCache(
          holders.map(([profile]) => profile),
          (identity) => {
            try {
              return JSON.parse(identity)[0] === key;
            } catch {
              return false;
            }
          },
        );
      }
      const pooled = await this._clearProviderPool(key, "config");
      failures.push(...pooled.failures);
      return failures.length ? { warnings: failures } : {};
    }
    // env 类：清掉 .env 里的凭证变量 + 凭证池条目。凭证未必两者都有——copilot/
    // openai-codex 只有池条目（source=gh_cli/device_code），alibaba 的池条目又只是
    // 对 env 变量的引用。所以 env 行缺失不是错误：带着空 targets 继续清池，
    // 两边都空才报「没有可清除的凭证」。
    const row = (await this._envProviders()).find((p) => p.key === key);
    const pooled = await this._clearProviderPool(key, "env");
    // env 变量目标 = /api/env 元数据归属的行 ∪ 池条目 source=env:VAR 提取的变量
    // （xiaomi 这类变量缺 provider 归属标注时，后者是唯一的变量名来源）。
    const targets = [...new Set([
      ...(row
        ? [
            row.hasApiKey ? row.keyEnv : null,
            row.hasBaseUrl ? row.baseUrlEnv : null,
          ].filter(Boolean)
        : []),
      ...(pooled.envVars || []),
    ])];
    if (targets.length === 0 && pooled.removed === 0 && pooled.failures.length === 0) {
      const error = new Error(`provider ${key} 没有可清除的凭证（可能走 OAuth / CLI 登录，请在对应工具里撤销）`);
      error.code = "hermes_no_credentials_to_clear";
      throw error;
    }
    // envFailures = 该变量在所有 dashboard 上都没删掉（广播层 throw）；
    // warnings = 只有部分 dashboard 失败。全失败判定只看 envFailures。
    const envFailures = [];
    const warnings = [];
    for (const envVar of targets) {
      try {
        const r = await this.deleteEnvVar(envVar);
        if (r?.warnings?.length) warnings.push(...r.warnings.map((w) => `${envVar}: ${w}`));
      } catch (err) {
        envFailures.push(`${envVar}: ${err?.message || err}`);
      }
    }
    if (targets.length > 0 && envFailures.length === targets.length && pooled.removed === 0) {
      throw new Error(`hermes 清除凭证失败：${[...envFailures, ...pooled.failures].join("; ")}`);
    }
    const combined = [...pooled.failures, ...envFailures, ...warnings];
    return combined.length ? { warnings: combined } : {};
  }

  // config 类：/api/config 直接回明文 api_key（loopback dashboard）。
  // env 类：Key/端点明文走 /api/env/reveal。
  async revealModelProviderKey(providerKey) {
    const key = String(providerKey || "").trim();
    if (!key) throw new Error("缺少 providerKey");
    const byProfile = await this._readProvidersByProfile({ fresh: true });
    for (const providers of byProfile.values()) {
      const entry = providers[key];
      if (!entry || typeof entry !== "object") continue;
      const raw = entry.api_key ?? entry.apiKey;
      if (typeof raw === "string" && raw.trim()) return { apiKey: raw };
      const envVar = entry.key_env || entry.api_key_env || entry.keyEnv;
      if (typeof envVar === "string" && envVar.trim()) {
        return { apiKey: null, reason: "env", envVar: envVar.trim() };
      }
    }
    const row = (await this._envProviders()).find((p) => p.key === key);
    if (!row) return { apiKey: null, reason: "none" };
    const read = async (envVar, isSet) => {
      if (!envVar || !isSet) return "";
      try {
        const { value } = await this.revealEnvVar(envVar);
        return value || "";
      } catch {
        return "";
      }
    };
    const [apiKey, baseUrl] = await Promise.all([
      read(row.keyEnv, row.hasApiKey),
      read(row.baseUrlEnv, row.hasBaseUrl),
    ]);
    if (!apiKey) {
      // 有 Key 变量但没填 = "none"；压根没有 Key 变量 = 走 OAuth/CLI 登录 = "managed"
      return {
        apiKey: null,
        baseUrl,
        reason: row.keyEnv ? "none" : "managed",
        envVar: row.keyEnv,
      };
    }
    return { apiKey, baseUrl };
  }

  // Per-task auxiliary model slots (config.auxiliary). provider "auto" = inherit
  // the main model. Read from /api/model/auxiliary; write via /api/model/set with
  // scope:"auxiliary" (task "__reset__" resets all). Config is global → default dash.
  /**
   * 模型设置面的 profile → dashboard 解析。显式传入的 profile 必须存在（写错
   * 目标是正确性问题，不静默回退）；缺省时取 default（无 default 取第一个）。
   */
  _settingsDash(profile) {
    if (typeof profile === "string" && profile.trim()) {
      const name = profile.trim();
      const dash = this.dashboards.get(name);
      if (!dash) throw new Error(`hermes: 未知 profile ${name}`);
      return { name, dash };
    }
    const def = this.dashboards.get("default");
    if (def) return { name: "default", dash: def };
    const first = [...this.dashboards.entries()][0];
    return first ? { name: first[0], dash: first[1] } : { name: "default", dash: null };
  }

  /** 单 dashboard GET+JSON，失败一律 null（聚合读的降级单元）。 */
  // 带 401/403 自愈的 dashboard 请求（GET 之外也要）：续期沿用 _renewDashToken——
  // 它多做了两件必要的事：重抓后校验 hermes_home 身份（端口可能已被另一个 profile
  // 的 dashboard 占走，只换 token 会串号）、以及单飞。
  // OAuth 的 start/submit/poll/DELETE 都不是条件写（无 If-Match），重放安全，
  // 所以这里可以像 _dashGet 一样重试一次；真正的条件写别套用这条。
  async _dashFetch(dash, method, path, { body, timeoutMs, extraHeaders } = {}) {
    const once = () =>
      method === "GET"
        ? httpGet(`${dash.baseUrl}${path}`, { token: dash.token, timeoutMs })
        : httpRequest(method, `${dash.baseUrl}${path}`, {
            token: dash.token,
            ...(body !== undefined ? { body } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            ...(extraHeaders ? { extraHeaders } : {}),
          });
    let r = await once().catch((err) => ({ status: 0, body: err?.message || String(err) }));
    if (r.status === 401 || r.status === 403) {
      if (await this._renewDashToken(dash)) {
        r = await once().catch((err) => ({ status: 0, body: err?.message || String(err) }));
      }
    }
    return r;
  }

  async _settingsGet(dash, path, timeoutMs = 10000) {
    const { status, body } = await this._dashFetch(dash, "GET", path, { timeoutMs }).catch(() => ({
      status: 0,
      body: "",
    }));
    if (status !== 200) return null;
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }

  /** /api/model/auxiliary 原始响应 → 统一 slots/main 形状。 */
  _normalizeAuxiliary(j) {
    if (!j || typeof j !== "object") return { slots: [], main: {} };
    const slots = (Array.isArray(j.tasks) ? j.tasks : []).map((t) => ({
      task: String(t.task || ""),
      provider: String(t.provider || "auto"),
      model: String(t.model || ""),
    }));
    const main =
      j.main && typeof j.main === "object"
        ? { provider: String(j.main.provider || ""), model: String(j.main.model || "") }
        : {};
    return { slots, main };
  }

  async getAuxiliaryModels(opts = {}) {
    let dash = null;
    try {
      ({ dash } = this._settingsDash(opts.profile));
    } catch {
      return { slots: [], main: {} };
    }
    if (!dash) return { slots: [], main: {} };
    return this._normalizeAuxiliary(await this._settingsGet(dash, "/api/model/auxiliary"));
  }

  // 官方 App 同款直写（POST /api/model/set，无条件锁——R272 用户定案的写路线）；
  // withProfiles 只用于和本进程内其它模型写互斥，不构成跨进程锁。
  async setAuxiliaryModel(task, provider, model, opts = {}) {
    const { name } = this._settingsDash(opts.profile);
    return this._modelMutationGate.withProfiles(
      [name],
      `aux:${randomUUID()}`,
      () => this._setAuxiliaryModelUnlocked(task, provider, model, opts),
    );
  }

  /** 已持 Profile gate 的辅助模型写入。 */
  async _setAuxiliaryModelUnlocked(task, provider, model, opts = {}) {
    const { dash } = this._settingsDash(opts.profile);
    if (!dash) throw new Error("hermes: 没有可用的 dashboard");
    const { status, body } = await httpRequest("POST", `${dash.baseUrl}/api/model/set`, {
      token: dash.token,
      body: { scope: "auxiliary", task, provider: provider || "", model: model || "" },
      timeoutMs: 15000,
    });
    if (status >= 300) throw new Error(`hermes set auxiliary failed: ${status} ${body}`);
    return { ok: true };
  }

  // ---- model settings（官方「模型」+「提供方」设置整合面，R286）----
  // 全部照官方 desktop（apps/desktop/src/hermes.ts）同款 dashboard HTTP 端点，
  // per-profile 作用域（官方 profileScoped 语义）；snake_case 进出都在这层转换。

  async getModelSettings(opts = {}) {
    let resolved;
    try {
      resolved = this._settingsDash(opts.profile);
    } catch {
      return { supported: false };
    }
    const { name, dash } = resolved;
    if (!dash) return { supported: false };
    // 官方 refresh 同款并发拉取；moa/config 任一失败不拖垮整体（铁律 4）。
    // options 带 include_unconfigured=1：全宇宙 provider（未配置的 authenticated:false，
    // 供行内激活/OAuth 引导）；explicit_only=1 与官方默认一致。
    const [info, options, auxiliary, moa, config] = await Promise.all([
      this._settingsGet(dash, "/api/model/info"),
      this._settingsGet(dash, "/api/model/options?include_unconfigured=1&explicit_only=1", 20000),
      this._settingsGet(dash, "/api/model/auxiliary"),
      this._settingsGet(dash, "/api/model/moa"),
      this._settingsGet(dash, "/api/config"),
    ]);
    const providers = (Array.isArray(options?.providers) ? options.providers : []).map((p) => ({
      name: String(p.name || p.slug || ""),
      slug: String(p.slug || ""),
      models: Array.isArray(p.models) ? p.models.map((m) => String(m)) : [],
      ...(typeof p.total_models === "number" ? { totalModels: p.total_models } : {}),
      ...(typeof p.authenticated === "boolean" ? { authenticated: p.authenticated } : {}),
      ...(typeof p.auth_type === "string" && p.auth_type ? { authType: p.auth_type } : {}),
      ...(typeof p.key_env === "string" && p.key_env ? { keyEnv: p.key_env } : {}),
      ...(p.is_user_defined === true ? { isUserDefined: true } : {}),
      ...(p.is_current === true ? { isCurrent: true } : {}),
      ...(typeof p.warning === "string" && p.warning ? { warning: p.warning } : {}),
      ...(typeof p.free_tier === "boolean" ? { freeTier: p.free_tier } : {}),
      ...(Array.isArray(p.unavailable_models)
        ? { unavailableModels: p.unavailable_models.map((m) => String(m)) }
        : {}),
      ...(p.capabilities && typeof p.capabilities === "object" ? { capabilities: p.capabilities } : {}),
      ...(p.pricing && typeof p.pricing === "object" ? { pricing: p.pricing } : {}),
    }));
    const agent = config && typeof config.agent === "object" && config.agent ? config.agent : {};
    const fallbacks = (Array.isArray(config?.fallback_providers) ? config.fallback_providers : [])
      .map((entry) => {
        if (entry && typeof entry === "object") {
          return { provider: String(entry.provider || ""), model: String(entry.model || "") };
        }
        // 兼容遗留字符串形态 "provider/model"（官方 normalizeEntries 同款防御）
        if (typeof entry === "string") {
          const slash = entry.indexOf("/");
          return slash > 0
            ? { provider: entry.slice(0, slash), model: entry.slice(slash + 1) }
            : { provider: "", model: entry };
        }
        return { provider: "", model: "" };
      });
    return {
      supported: true,
      profile: name,
      profiles: [...this.dashboards.keys()],
      main: {
        provider: String(info?.provider || ""),
        model: String(info?.model || ""),
      },
      providers,
      auxiliary: this._normalizeAuxiliary(auxiliary),
      defaults: {
        reasoningEffort: String(agent.reasoning_effort ?? "").trim(),
        serviceTier: String(agent.service_tier ?? "").trim(),
      },
      fallbacks,
      moa: moa ? moaConfigToCamel(moa) : null,
    };
  }

  async applyMainModel(opts = {}) {
    const provider = String(opts.provider || "").trim();
    const model = String(opts.model || "").trim();
    if (!provider || !model) throw new Error("hermes: provider 与 model 必填");
    const { name, dash } = this._settingsDash(opts.profile);
    if (!dash) throw new Error("hermes: 没有可用的 dashboard");
    return this._modelMutationGate.withProfiles([name], `main:${randomUUID()}`, async () => {
      const { status, body } = await httpRequest("POST", `${dash.baseUrl}/api/model/set`, {
        token: dash.token,
        body: { scope: "main", provider, model, task: "" },
        timeoutMs: 20000,
      });
      if (status >= 300) throw new Error(`hermes set model failed: ${status} ${body}`);
      let j = {};
      try { j = JSON.parse(body); } catch { /* 非 JSON 响应按成功兜底 */ }
      return {
        ok: true,
        provider: String(j.provider || provider),
        model: String(j.model || model),
        // 官方切主模型响应带 stale_aux：仍钉在其它 provider 上的辅助槽
        staleAux: (Array.isArray(j.stale_aux) ? j.stale_aux : []).map((s) => ({
          task: String(s.task || ""),
          provider: String(s.provider || ""),
          model: String(s.model || ""),
        })),
      };
    });
  }

  /** 深合并 PUT /api/config 单键写（官方整份回环的等价最小面；无条件写，R272 路线）。 */
  async _putConfigPatch(dash, configPatch) {
    const { status, body } = await httpRequest("PUT", `${dash.baseUrl}/api/config`, {
      token: dash.token,
      body: { config: configPatch },
      timeoutMs: 15000,
    });
    if (status < 200 || status >= 300) {
      const error = new Error(`hermes config 写入失败 (HTTP ${status}) ${String(body || "").slice(0, 200)}`);
      error.code = "hermes_config_write_failed";
      error.status = status;
      throw error;
    }
    return { ok: true };
  }

  async setModelDefaults(opts = {}) {
    const agent = {};
    if (typeof opts.reasoningEffort === "string" && opts.reasoningEffort.trim()) {
      agent.reasoning_effort = opts.reasoningEffort.trim();
    }
    if (typeof opts.serviceTier === "string" && opts.serviceTier.trim()) {
      agent.service_tier = opts.serviceTier.trim();
    }
    if (Object.keys(agent).length === 0) return { ok: true };
    const { name, dash } = this._settingsDash(opts.profile);
    if (!dash) throw new Error("hermes: 没有可用的 dashboard");
    return this._modelMutationGate.withProfiles(
      [name],
      `defaults:${randomUUID()}`,
      () => this._putConfigPatch(dash, { agent }),
    );
  }

  async setFallbackModels(entries, opts = {}) {
    const list = (Array.isArray(entries) ? entries : [])
      .map((entry) => ({
        provider: String(entry?.provider || "").trim(),
        model: String(entry?.model || "").trim(),
      }))
      .filter((entry) => entry.provider && entry.model);
    const { name, dash } = this._settingsDash(opts.profile);
    if (!dash) throw new Error("hermes: 没有可用的 dashboard");
    // 深合并对 list 是整体替换（R272 核实）——顺序即优先级，空数组=清空链。
    return this._modelMutationGate.withProfiles(
      [name],
      `fallbacks:${randomUUID()}`,
      () => this._putConfigPatch(dash, { fallback_providers: list }),
    );
  }

  async saveMoaConfig(config, opts = {}) {
    const { name, dash } = this._settingsDash(opts.profile);
    if (!dash) throw new Error("hermes: 没有可用的 dashboard");
    return this._modelMutationGate.withProfiles([name], `moa:${randomUUID()}`, async () => {
      const { status, body } = await httpRequest("PUT", `${dash.baseUrl}/api/model/moa`, {
        token: dash.token,
        body: moaConfigToSnake(config),
        timeoutMs: 15000,
      });
      if (status >= 300) throw new Error(`hermes save moa failed: ${status} ${String(body || "").slice(0, 300)}`);
      try {
        return moaConfigToCamel(JSON.parse(body));
      } catch {
        return moaConfigToCamel(moaConfigToSnake(config));
      }
    });
  }

  async getRecommendedDefaultModel(provider, opts = {}) {
    const slug = String(provider || "").trim();
    if (!slug) return { provider: "", model: "", freeTier: null };
    let dash = null;
    try {
      ({ dash } = this._settingsDash(opts.profile));
    } catch {
      return { provider: slug, model: "", freeTier: null };
    }
    if (!dash) return { provider: slug, model: "", freeTier: null };
    const j = await this._settingsGet(
      dash,
      `/api/model/recommended-default?provider=${encodeURIComponent(slug)}`,
    );
    return {
      provider: String(j?.provider || slug),
      model: String(j?.model || ""),
      freeTier: typeof j?.free_tier === "boolean" ? j.free_tier : null,
    };
  }

  // ---- custom endpoints（官方「提供方 → 自定义端点」五端点，R286）----

  _customEndpointToCamel(e) {
    return {
      id: String(e?.id || ""),
      name: String(e?.name || ""),
      baseUrl: String(e?.base_url || ""),
      model: normalizeModelId(e?.model),
      models: Array.isArray(e?.models)
        ? [...new Set(e.models.map(normalizeModelId).filter(Boolean))]
        : [],
      hasApiKey: !!e?.has_api_key,
      apiKeyPreview: typeof e?.api_key_preview === "string" ? e.api_key_preview : null,
      contextLength: typeof e?.context_length === "number" ? e.context_length : null,
      discoverModels: e?.discover_models !== false,
      isCurrent: e?.is_current === true,
      ...(typeof e?.source === "string" && e.source ? { source: e.source } : {}),
    };
  }

  _customEndpointsResponse(j) {
    return {
      supported: true,
      ...(typeof j?.id === "string" && j.id ? { id: j.id } : {}),
      current: j?.current && typeof j.current === "object"
        ? {
            provider: String(j.current.provider || ""),
            model: String(j.current.model || ""),
            baseUrl: String(j.current.base_url || ""),
          }
        : undefined,
      endpoints: (Array.isArray(j?.endpoints) ? j.endpoints : []).map((e) => this._customEndpointToCamel(e)),
    };
  }

  _customEndpointToSnake(endpoint = {}) {
    const contextLength = Number(endpoint.contextLength);
    return {
      ...(typeof endpoint.id === "string" && endpoint.id.trim() ? { id: endpoint.id.trim() } : {}),
      name: String(endpoint.name || "").trim(),
      base_url: String(endpoint.baseUrl || "").trim(),
      model: String(endpoint.model || "").trim(),
      ...(typeof endpoint.apiKey === "string" && endpoint.apiKey.trim()
        ? { api_key: endpoint.apiKey.trim() }
        : {}),
      ...(Number.isFinite(contextLength) && contextLength > 0
        ? { context_length: Math.floor(contextLength) }
        : {}),
      discover_models: endpoint.discoverModels !== false,
      make_default: endpoint.makeDefault === true,
    };
  }

  // 全部 dashboard（default 最前），带 profile 名——端点的读/写都要跨 profile。
  _settingsDashes() {
    const rest = [...this.dashboards.entries()].filter(([profile]) => profile !== "default");
    const def = this.dashboards.get("default");
    return def ? [["default", def], ...rest] : rest;
  }

  // 自定义端点是**跨 profile** 的：写广播到每台 dashboard（R296），读也必须聚合，
  // 否则单读 default 会漏掉只存在于别的 profile 的端点（历史漂移，例如 xm 缺 default）。
  // 显式传 profile 仍走单台（REST ?profile= 与契约保留）。
  async listCustomEndpoints(opts = {}) {
    if (typeof opts.profile === "string" && opts.profile.trim()) {
      let dash = null;
      try {
        ({ dash } = this._settingsDash(opts.profile));
      } catch {
        return { supported: false, endpoints: [] };
      }
      if (!dash) return { supported: false, endpoints: [] };
      const j = await this._settingsGet(dash, "/api/providers/custom-endpoints");
      if (!j) return { supported: false, endpoints: [] };
      return this._customEndpointsResponse(j);
    }
    const entries = this._settingsDashes();
    if (!entries.length) return { supported: false, endpoints: [] };
    const per = await Promise.all(
      entries.map(async ([name, dash]) => {
        try {
          const j = await this._settingsGet(dash, "/api/providers/custom-endpoints");
          return j ? { name, snap: this._customEndpointsResponse(j) } : null;
        } catch {
          return null; // 一台 dashboard 挂掉不拖垮聚合（铁律 4）
        }
      }),
    );
    const live = per.filter(Boolean);
    if (!live.length) return { supported: false, endpoints: [] };
    const byId = new Map();
    for (const { name, snap } of live) {
      for (const ep of snap.endpoints) {
        const row = byId.get(ep.id) || { ...ep, isCurrent: false, profiles: [], activeIn: [] };
        row.profiles.push(name);
        // is_current 是各 profile 自己的主模型判定 → 聚合成「在哪些 profile 里启用」
        if (ep.isCurrent) row.activeIn.push(name);
        byId.set(ep.id, row);
      }
    }
    return {
      supported: true,
      current: live[0].snap.current,
      profiles: live.map((e) => e.name),
      endpoints: [...byId.values()],
    };
  }

  // 多选保存（R314 端点弹窗）：models = 选中的模型 id 集合，落盘后它就是该端点在
  // 聊天列表里的**唯一真相**。三个形状决策都有上游语义背书，别改：
  //
  // 1. `discover_models` 强制 false——Hermes 对带 api_key 的自定义 provider 会用
  //    live /models **整体替换**配置里的子集（model_switch.py §4 注释原话），不关
  //    这个开关，「只显示选中的」会被打穿。
  // 2. models 写**纯字符串数组**：PUT /api/config 深合并里数组=覆盖（dict=并入、
  //    删不掉键），一次写就让选中集合成为全集。不能写对象数组——Hermes 端点列表
  //    API 对 list 项直接 str()（web_server._models_from_custom_endpoint_entry），
  //    对象会读成 "{'id':…}" 垃圾串。读侧三处（picker _declared_model_ids /
  //    端点列表 / context 覆盖读取）都实测容忍字符串数组。
  // 3. 代价：providers.<id>.models 里手写的 per-model context_length 会被压平
  //    （字符串带不了 meta）。顶层键经 {...existing} 展开全数保留；per-model
  //    上下文走运行时自动解析（模型页 R313 前后已确认该链路），要精确控制的
  //    直接写 config.yaml。
  //
  // 写路径复用 _removeModelConfigUnlocked 的成熟组合：fresh 读建立条件写快照 →
  // 逐 profile _putProviderEntry（条件写 + 失败聚合，铁律 4）。
  async _saveCustomEndpointModels(endpoint, base) {
    const selected = [...new Set(endpoint.models.map((m) => String(m || "").trim()).filter(Boolean))];
    if (!selected.length) throw new Error("models 不能为空");
    if (!selected.includes(base.model)) selected.unshift(base.model);
    // id 规则与 Hermes _custom_endpoint_id 一致（非字母数字折 -，去首尾，小写）
    const id = String(endpoint.id || endpoint.name || "")
      .trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").toLowerCase() || "custom";
    const byProfile = await this._readProvidersByProfile({ fresh: true, requireComplete: true });
    // 与 R272 的能力降级同语义：dashboard 声明了条件写才走 ETag 条件路，否则
    // 官方同款无锁深合并 PUT（当前线上 Hermes 就是这一档，条件路会直接抛
    // 「未声明安全条件写能力」）。
    const conditionalSupported = [...byProfile.keys()].every(
      (profile) => this._providerMutationSnapshots.get(profile)?.supported === true,
    );
    const opts = { conditional: conditionalSupported };
    const failures = [];
    const writes = await Promise.allSettled(
      [...byProfile.entries()].map(async ([profile, providers]) => {
        const dash = this.dashboards.get(profile);
        if (!dash) {
          failures.push(`${profile}: dashboard 不可用`);
          return;
        }
        try {
          const existing = providers[id] && typeof providers[id] === "object" ? providers[id] : {};
          const entry = {
            ...existing,
            name: base.name,
            base_url: base.base_url,
            model: base.model,
            models: selected,
            discover_models: false,
            ...(base.api_key ? { api_key: base.api_key } : {}),
            ...(base.context_length ? { context_length: base.context_length } : {}),
          };
          await this._putProviderEntry(dash, id, entry, opts);
        } catch (err) {
          if (err?.code === "hermes_conditional_write_unsupported" || err?.code === "hermes_write_conflict") throw err;
          failures.push(`${profile}: ${err?.message || err}`);
        }
      }),
    );
    const conditionalFailure = writes.find((result) => result.status === "rejected");
    if (conditionalFailure?.status === "rejected") throw conditionalFailure.reason;
    if (failures.length === byProfile.size) {
      throw new Error(`hermes save endpoint failed: ${failures.join("; ")}`);
    }
    this._providersByProfile = null;
    const snap = await this.listCustomEndpoints();
    return { ...snap, id, ...(failures.length ? { warnings: failures } : {}) };
  }

  // 保存 = 广播到全部 profile（R296：端点跨 profile 同步）。
  // make_default 是**唯一不广播**的字段——它改的是那个 profile 的主模型，广播等于
  // 一次性换掉每个 agent 的主模型。只对显式指定的 profile 放行，其余强制 false。
  async saveCustomEndpoint(endpoint, opts = {}) {
    const entries = this._settingsDashes();
    if (!entries.length) throw new Error("hermes: 没有可用的 dashboard");
    const target = typeof opts.profile === "string" && opts.profile.trim() ? opts.profile.trim() : null;
    const base = this._customEndpointToSnake(endpoint);
    // 带 models 数组 = 端点弹窗的多选保存，走整条目条件写；单模型老形状走下面的
    // 官方 POST（保持 crud-smoke 与旧调用方不变）。
    if (Array.isArray(endpoint.models) && endpoint.models.length) {
      return this._modelMutationGate.withProfiles(
        entries.map(([name]) => name),
        `endpoint:${randomUUID()}`,
        () => this._saveCustomEndpointModels(endpoint, base),
      );
    }
    return this._modelMutationGate.withProfiles(
      entries.map(([name]) => name),
      `endpoint:${randomUUID()}`,
      async () => {
        const failures = [];
        let primary = null;
        const writes = await Promise.all(
          entries.map(async ([name, dash]) => {
            // discover_models=true 时服务端会真探测端点 → 给足余量
            const body = { ...base, make_default: base.make_default === true && name === target };
            try {
              const r = await httpRequest("POST", `${dash.baseUrl}/api/providers/custom-endpoints`, {
                token: dash.token,
                body,
                timeoutMs: 30000,
              });
              if (r.status >= 300) throw new Error(`${r.status} ${String(r.body || "").slice(0, 200)}`);
              return { name, snap: this._customEndpointsResponse(JSON.parse(r.body)) };
            } catch (err) {
              failures.push(`${name}: ${err?.message || err}`);
              return null;
            }
          }),
        );
        for (const w of writes) {
          if (!w) continue;
          if (!primary || w.name === (target || "default")) primary = w.snap;
        }
        if (!primary) throw new Error(`hermes save endpoint failed: ${failures.join("; ")}`);
        return failures.length ? { ...primary, warnings: failures } : primary;
      },
    );
  }

  async validateCustomEndpoint(endpoint, opts = {}) {
    const { dash } = this._settingsDash(opts.profile);
    if (!dash) throw new Error("hermes: 没有可用的 dashboard");
    const { status, body } = await httpRequest(
      "POST",
      `${dash.baseUrl}/api/providers/custom-endpoints/validate`,
      { token: dash.token, body: this._customEndpointToSnake(endpoint), timeoutMs: 30000 },
    );
    if (status >= 300) throw new Error(`hermes validate endpoint failed: ${status} ${String(body || "").slice(0, 300)}`);
    let j = {};
    try { j = JSON.parse(body); } catch { /* 保底空对象 */ }
    return {
      ok: j.ok === true,
      reachable: j.reachable === true,
      message: String(j.message || ""),
      models: Array.isArray(j.models) ? j.models.map((m) => String(m)) : [],
    };
  }

  async activateCustomEndpoint(id, opts = {}) {
    const endpointId = String(id || "").trim();
    if (!endpointId) throw new Error("hermes: endpoint id 必填");
    const { name, dash } = this._settingsDash(opts.profile);
    if (!dash) throw new Error("hermes: 没有可用的 dashboard");
    return this._modelMutationGate.withProfiles([name], `endpoint:${randomUUID()}`, async () => {
      const { status, body } = await httpRequest(
        "POST",
        `${dash.baseUrl}/api/providers/custom-endpoints/${encodeURIComponent(endpointId)}/activate`,
        { token: dash.token, body: {}, timeoutMs: 20000 },
      );
      if (status >= 300) throw new Error(`hermes activate endpoint failed: ${status} ${String(body || "").slice(0, 300)}`);
      let j = {};
      try { j = JSON.parse(body); } catch { /* 保底空对象 */ }
      return { ok: true, provider: String(j.provider || endpointId), model: String(j.model || "") };
    });
  }

  // 删除也必须广播：只删 default 的话，端点在别的 profile 里还活着，下次聚合读又
  // 「漂」回来——正是 R139 记的 env 老坑（在一处删掉、被另一处复活）。
  // 404 = 那个 profile 本来就没有这条，按成功计。
  async deleteCustomEndpoint(id, opts = {}) {
    const endpointId = String(id || "").trim();
    if (!endpointId) throw new Error("hermes: endpoint id 必填");
    const entries = this._settingsDashes();
    if (!entries.length) throw new Error("hermes: 没有可用的 dashboard");
    return this._modelMutationGate.withProfiles(
      entries.map(([name]) => name),
      `endpoint:${randomUUID()}`,
      async () => {
        const failures = [];
        let ok = false;
        await Promise.all(
          entries.map(async ([name, dash]) => {
            try {
              const r = await httpRequest(
                "DELETE",
                `${dash.baseUrl}/api/providers/custom-endpoints/${encodeURIComponent(endpointId)}`,
                { token: dash.token, timeoutMs: 15000 },
              );
              if (r.status === 404) { ok = true; return; }
              if (r.status >= 300) throw new Error(`${r.status} ${String(r.body || "").slice(0, 200)}`);
              ok = true;
            } catch (err) {
              failures.push(`${name}: ${err?.message || err}`);
            }
          }),
        );
        if (!ok) throw new Error(`hermes delete endpoint failed: ${failures.join("; ")}`);
        const snap = await this.listCustomEndpoints();
        return failures.length ? { ...snap, warnings: failures } : snap;
      },
    );
  }

  // ---- env / API keys (Hermes config .env) ----
  // NOT machine-global: since the R132 `--isolated` spawn each named-profile
  // dashboard serves its own HERMES_HOME (~/.hermes/profiles/<name>) with its own
  // .env. Reads aggregate across every dashboard and writes broadcast to all of
  // them — a delete that only hits default leaves the provider alive (still
  // credentialed) on bull/horse, which is exactly the "deleted alibaba but it's
  // still listed" incident of 2026-07-14.
  _envDash() {
    return this.dashboards.get("default") || [...this.dashboards.values()][0] || null;
  }
  // default 排最前：聚合基准行（描述/顺序）以 default 为准，其它 profile 只并状态。
  _envDashes() {
    const rest = [...this.dashboards.entries()]
      .filter(([profile]) => profile !== "default")
      .map(([, dash]) => dash);
    const def = this.dashboards.get("default");
    return def ? [def, ...rest] : rest;
  }
  async _listEnvVarsOf(dash) {
    // 301 条 + PUT /api/config 后的 reconfigure 窗口 → 默认 4s 会超时（模型页据此
    // 判定 provider 是否可编辑，读挂代价大）
    const { status, body } = await this._dashGet(dash, "/api/env", { timeoutMs: 10000 })
      .catch(() => ({ status: 0, body: "" }));
    if (status !== 200) return null;
    try {
      const j = JSON.parse(body);
      return Object.entries(j).map(([key, v]) => ({
        key,
        isSet: !!v.is_set,
        redactedValue: v.redacted_value || null,
        description: v.description || "",
        url: v.url || null,
        category: v.category || "",
        isPassword: !!v.is_password,
        advanced: !!v.advanced,
        // 用到该 key 的工具名（密钥面板照官方渲染成 chip）
        tools: Array.isArray(v.tools) ? v.tools.map(String) : [],
        // 渠道页拥有的平台凭证 → 密钥面板隐藏，避免和更完整的渠道配置 UI 重复
        channelManaged: !!v.channel_managed,
        // 用户自己写进 .env、不在任何目录里的键（官方「自定义密钥」区）
        custom: !!v.custom,
        // provider 归属：模型页据此把内置 provider 的 Key/端点归到对应 provider 组
        provider: typeof v.provider === "string" ? v.provider : undefined,
        providerLabel: typeof v.provider_label === "string" ? v.provider_label : undefined,
      }));
    } catch {
      return null;
    }
  }
  async listEnvVars() {
    const dashes = this._envDashes();
    if (dashes.length === 0) return [];
    const perDash = await Promise.all(dashes.map((d) => this._listEnvVarsOf(d)));
    // 聚合：任一 profile is_set 即视为已配置（provider 可编辑性/删除目标都要看全体）。
    const byKey = new Map();
    for (const rows of perDash) {
      if (!rows) continue; // 该 dashboard 本轮读失败 → 静默降级（铁律 4）
      for (const row of rows) {
        const cur = byKey.get(row.key);
        if (!cur) {
          byKey.set(row.key, row);
        } else if (row.isSet && !cur.isSet) {
          byKey.set(row.key, { ...cur, isSet: true, redactedValue: cur.redactedValue ?? row.redactedValue });
        }
      }
    }
    return [...byKey.values()];
  }
  // 写广播：全部 dashboard 失败才抛；部分失败返回 warnings（与 addModelConfig 同口径）。
  async _broadcastEnv(method, payload, label) {
    const dashes = this._envDashes();
    if (dashes.length === 0) throw new Error("hermes: 没有可用的 dashboard");
    const failures = [];
    await Promise.all(
      dashes.map(async (dash) => {
        const { status, body } = await httpRequest(method, `${dash.baseUrl}/api/env`, {
          token: dash.token,
          body: payload,
        }).catch((err) => ({ status: 0, body: err?.message || String(err) }));
        if (status >= 200 && status < 300) return;
        // DELETE 是幂等的：Hermes 对 .env 里不存在的键返回 404「not found in .env」。
        // isolated dashboard 各存一份 .env——只在 default 配过的键（如 DEEPSEEK_API_KEY）
        // 在 bull/horse 上本就不存在，删它是无操作、不是失败。若把 404 当失败上报，
        // 「删除 provider」就会误报「部分写入失败」，即使 default 已删净（2026-07-14 事故）。
        if (method === "DELETE" && status === 404) return;
        failures.push(`${dash.profile || dash.baseUrl}: ${status} ${String(body).slice(0, 120)}`);
      }),
    );
    if (failures.length === dashes.length) {
      throw new Error(`hermes ${label} failed: ${failures.join("; ")}`);
    }
    return failures.length ? { ok: true, warnings: failures } : { ok: true };
  }
  async setEnvVar(key, value) {
    return this._broadcastEnv("PUT", { key, value: String(value ?? "") }, "set env");
  }
  async deleteEnvVar(key) {
    return this._broadcastEnv("DELETE", { key }, "delete env");
  }
  async revealEnvVar(key) {
    const dashes = this._envDashes();
    if (dashes.length === 0) throw new Error("hermes: 没有可用的 dashboard");
    // default 优先；default 未设置时逐个 profile 找第一份明文（isolated 后各存一份）。
    // 任一 dashboard 成功应答即算查询成功（空值=真没配）；全部失败才抛。
    let lastErr = null;
    let answered = false;
    for (const dash of dashes) {
      try {
        const { status, body } = await httpRequest("POST", `${dash.baseUrl}/api/env/reveal`, {
          token: dash.token,
          body: { key },
        });
        if (status >= 300) {
          lastErr = new Error(`hermes reveal env failed: ${status} ${body}`);
          continue;
        }
        answered = true;
        const j = JSON.parse(body);
        const value = String(j.value ?? j.redacted_value ?? "");
        if (value) return { value };
      } catch (err) {
        lastErr = err;
      }
    }
    if (!answered && lastErr) throw lastErr;
    return { value: "" };
  }
  // Hermes 答的是 {ok, reachable, message}，契约要的是 {supported, valid, error}
  // ——直接 spread 会让 `valid` 恒 undefined，于是**每一次校验都报失败**，包括那 27 家
  // 根本没有探针的 provider（`_CREDENTIAL_PROBES` 只覆盖 openrouter/openai/xai/gemini）。
  // 语义对照：
  //   ok=true,  reachable=false → 没探针，验不了（≠ 失败）→ supported:false
  //   ok=true,  reachable=true  → 真的有效
  //   ok=false, reachable=true  → key 被拒
  //   ok=false, reachable=false → 网络没打通，message 会说明
  async validateProviderCredential(key, value) {
    const dash = this._envDash();
    if (!dash) return { supported: false };
    const { status, body } = await httpRequest("POST", `${dash.baseUrl}/api/providers/validate`, {
      token: dash.token,
      body: { key, value: String(value ?? "") },
    });
    if (status >= 300) return { supported: true, valid: false, error: String(body).slice(0, 200) };
    try {
      const j = JSON.parse(body);
      const noProbe = j.ok === true && j.reachable === false;
      return {
        supported: !noProbe,
        valid: j.ok === true,
        error: String(j.message || ""),
      };
    } catch {
      return { supported: true };
    }
  }

  // ---- OAuth provider logins (Hermes /api/providers/oauth) ----
  // 登录态和 .env 一样是 per-HERMES_HOME 的：读聚合（connectedProfiles 说明哪几个
  // profile 连上了）、登出广播；但**登录流三步不能广播**——session_id / PKCE
  // code_verifier 存在单个 dashboard 的进程内存里，start/submit/poll/cancel 必须
  // 打同一个，所以它们带 profile 参数由调用方指定落到哪个 profile。
  _oauthDash(profile) {
    if (!profile) return this._envDash();
    return this.dashboards.get(profile) || null;
  }
  _oauthStatus(s = {}) {
    return {
      loggedIn: !!s.logged_in,
      source: s.source || null,
      sourceLabel: s.source_label || null,
      tokenPreview: s.token_preview || null,
      expiresAt: s.expires_at || null,
      hasRefreshToken: !!s.has_refresh_token,
      error: s.error || null,
    };
  }
  async listOAuthProviders() {
    const dashes = this._envDashes();
    if (dashes.length === 0) return { providers: [], profiles: [] };
    const perDash = await Promise.all(
      dashes.map(async (dash) => {
        // 实测每台 dashboard 这个接口要 6.4~9s（它逐个探 provider 授权态），
        // 五路并发时互相拖慢会一起越过 10s → 整张卡降级成空。给足 25s。
        const { status, body } = await this._dashFetch(dash, "GET", "/api/providers/oauth", {
          timeoutMs: 25000,
        }).catch(() => ({ status: 0, body: "" }));
        if (status !== 200) return null; // 铁律 4：该 dashboard 读挂 → 静默降级
        try {
          return { profile: dash.profile || "default", providers: JSON.parse(body).providers || [] };
        } catch {
          return null;
        }
      }),
    );
    const byId = new Map();
    for (const entry of perDash) {
      if (!entry) continue;
      for (const p of entry.providers) {
        let row = byId.get(p.id);
        if (!row) {
          row = {
            id: p.id,
            name: p.name || p.id,
            flow: p.flow || "external",
            cliCommand: p.cli_command || "",
            docsUrl: p.docs_url || "",
            disconnectHint: p.disconnect_hint || null,
            disconnectCommand: p.disconnect_command || null,
            disconnectable: p.disconnectable !== false,
            status: this._oauthStatus(p.status),
            connectedProfiles: [],
          };
          byId.set(p.id, row);
        }
        if (p.status?.logged_in) {
          row.connectedProfiles.push(entry.profile);
          // 已登录那份状态信息更全（token 预览 / 过期时间），优先留它
          if (!row.status.loggedIn) row.status = this._oauthStatus(p.status);
        }
      }
    }
    return { providers: [...byId.values()], profiles: dashes.map((d) => d.profile || "default") };
  }
  // 登出：不带 profile = 广播全部（同 deleteEnvVar，避免只清 default 时别的 profile 复活）。
  async disconnectOAuthProvider(providerId, profile) {
    const dashes = profile ? [this._oauthDash(profile)].filter(Boolean) : this._envDashes();
    if (dashes.length === 0) throw new Error("hermes: 没有可用的 dashboard");
    const failures = [];
    let cleared = false;
    await Promise.all(
      dashes.map(async (dash) => {
        const { status, body } = await this._dashFetch(
          dash,
          "DELETE",
          `/api/providers/oauth/${encodeURIComponent(providerId)}`,
        ).catch((err) => ({ status: 0, body: err?.message || String(err) }));
        if (status >= 200 && status < 300) {
          try {
            if (JSON.parse(body).ok) cleared = true;
          } catch { /* 非 JSON 也算这一台成功 */ }
          return;
        }
        // 400 = 该 profile 本就没连（或该 provider 归外部 CLI 管）→ 无操作，不是失败
        if (status === 400 || status === 404) return;
        failures.push(`${dash.profile || dash.baseUrl}: ${status} ${String(body).slice(0, 120)}`);
      }),
    );
    if (failures.length === dashes.length) {
      throw new Error(`hermes oauth disconnect failed: ${failures.join("; ")}`);
    }
    return failures.length ? { ok: cleared, warnings: failures } : { ok: cleared };
  }
  async _oauthCall(method, profile, path, body) {
    const dash = this._oauthDash(profile);
    if (!dash) throw new Error(`hermes: profile ${profile || "default"} 没有可用的 dashboard`);
    const { status, body: resp } = await this._dashFetch(dash, method, path, {
      ...(body ? { body } : {}),
      timeoutMs: 20000,
    });
    let parsed = null;
    try {
      parsed = JSON.parse(resp);
    } catch { /* 非 JSON 由下面的错误分支处理 */ }
    if (status >= 300) {
      throw new Error(parsed?.detail || `hermes oauth ${status}: ${String(resp).slice(0, 200)}`);
    }
    return parsed ?? {};
  }
  async startOAuthLogin(providerId, profile) {
    const r = await this._oauthCall("POST", profile, `/api/providers/oauth/${encodeURIComponent(providerId)}/start`, {});
    // snake_case → 前端统一形状；两种 flow 的字段并集（pkce: authUrl / device_code: userCode）
    return {
      sessionId: r.session_id || "",
      flow: r.flow || "",
      expiresIn: Number(r.expires_in) || 0,
      authUrl: r.auth_url || null,
      verificationUrl: r.verification_url || null,
      userCode: r.user_code || null,
      profile: profile || "default",
    };
  }
  async submitOAuthCode(providerId, sessionId, code, profile) {
    const r = await this._oauthCall(
      "POST",
      profile,
      `/api/providers/oauth/${encodeURIComponent(providerId)}/submit`,
      { session_id: sessionId, code },
    );
    return { ok: !!r.ok, status: r.status || "", message: r.message || "" };
  }
  async pollOAuthSession(providerId, sessionId, profile) {
    const r = await this._oauthCall(
      "GET",
      profile,
      `/api/providers/oauth/${encodeURIComponent(providerId)}/poll/${encodeURIComponent(sessionId)}`,
    );
    return { status: r.status || "", errorMessage: r.error_message || "" };
  }
  async cancelOAuthSession(sessionId, profile) {
    const r = await this._oauthCall(
      "DELETE",
      profile,
      `/api/providers/oauth/sessions/${encodeURIComponent(sessionId)}`,
    );
    return { ok: !!r.ok };
  }

  // ---- token usage (management UI) ----

  // Hermes analytics 使用 snake_case；这里统一转成前端契约的 token 分项字段。
  _usageParts(row) {
    return {
      inputTokens: Number(row?.input_tokens) || 0,
      outputTokens: Number(row?.output_tokens) || 0,
      cacheReadTokens: Number(row?.cache_read_tokens) || 0,
      reasoningTokens: Number(row?.reasoning_tokens) || 0,
    };
  }

  // Hermes analytics 会把缺失的 actual_cost 聚合成数值 0；此时 `??` 不会回退，
  // 导致已有 estimated_cost 的模型仍显示 $0。统一按“非零实际值优先，否则估算值”
  // 选择，并兼容 analytics 行与 session 行的两套字段名。
  _usageCost(row) {
    // Local full-history SQL resolves actual-vs-estimated per session before
    // aggregation. Honor its explicit zero as well as mixed paid/estimated rows.
    if (row?.resolved_cost != null && Number.isFinite(Number(row.resolved_cost))) return Number(row.resolved_cost);
    const actual = Number(row?.actual_cost ?? row?.actual_cost_usd);
    if (Number.isFinite(actual) && actual !== 0) return actual;
    const estimated = Number(row?.estimated_cost ?? row?.estimated_cost_usd ?? row?.cost);
    return Number.isFinite(estimated) ? estimated : 0;
  }

  // 把 token 分项累加到目标聚合对象，避免 daily/model/profile 三处重复计算。
  _addUsageParts(target, parts) {
    target.inputTokens = (Number(target.inputTokens) || 0) + parts.inputTokens;
    target.outputTokens = (Number(target.outputTokens) || 0) + parts.outputTokens;
    target.cacheReadTokens = (Number(target.cacheReadTokens) || 0) + parts.cacheReadTokens;
    target.reasoningTokens = (Number(target.reasoningTokens) || 0) + parts.reasoningTokens;
  }

  // Aggregate /api/analytics/usage across all profile dashboards into daily
  // points + per-model/profile totals. Snake_case fields are the Hermes contract.
  // Hermes analytics 端点只认 days 整数（trailing 窗口 now - days*86400），不认
  // range 字符串——旧代码传 ?range= 一直被忽略、恒为默认 30 天，此处一并修正。
  // "today" 取最近 24 小时（端点无自然日概念，见 agent-backend 契约说明）；
  // "all" 只读本地权威数据库；远端无全历史接口时明确不可用。
  _usageRangeDays(range) {
    switch (range) {
      case "today":
        return 1;
      case "7d":
        return 7;
      case "30d":
        return 30;
      case "90d":
        return 90;
      case "1y":
        return 365;
      case "all":
        return null;
      default:
        return 30;
    }
  }

  async _fetchLifetimeUsage(profile) {
    if (this._getConfig().hermesMode === "remote") throw new Error("Hermes remote lifetime usage is unavailable");
    this._usageHistoryPending ||= new Map();
    if (!this._usageHistoryPending.has(profile)) {
      const pending = readHermesUsageHistory(path.join(hermesHomeForProfile(profile), "state.db"))
        .finally(() => this._usageHistoryPending.delete(profile));
      this._usageHistoryPending.set(profile, pending);
    }
    return this._usageHistoryPending.get(profile);
  }

  async _fetchUsageAnalytics(range) {
    const daily = new Map();
    const byModel = new Map();
    const bySource = new Map();
    let failures = 0;
    const qs = `?days=${this._usageRangeDays(range)}`;
    await Promise.all(
      [...this.dashboards.entries()].map(async ([profile, dash]) => {
        const agentId = this._agentIdForRoutableProfile(profile);
        if (!agentId) return;
        try {
          let j;
          if (range === "all") j = await this._fetchLifetimeUsage(profile);
          else {
            const { status, body } = await httpGet(`${dash.baseUrl}/api/analytics/usage${qs}`, { token: dash.token });
            if (status !== 200) throw new Error("Hermes usage unavailable");
            j = JSON.parse(body);
          }
          if (!Array.isArray(j?.daily)) throw new Error("Hermes usage response invalid");
          const source =
            bySource.get(agentId) ||
            {
              id: agentId,
              label: `${profile} · Hermes`,
              kind: "profile",
              backendId: "hermes",
              profile,
              totalTokens: 0,
              totalCost: 0,
            };
          for (const d of Array.isArray(j.daily) ? j.daily : []) {
            const date = String(d.day || d.date || "");
            if (!date) continue;
            const parts = this._usageParts(d);
            const tok = parts.inputTokens + parts.outputTokens + parts.cacheReadTokens + parts.reasoningTokens;
            const cost = this._usageCost(d);
            const cur = daily.get(date) || { date, totalTokens: 0, totalCost: 0 };
            cur.totalTokens += tok;
            cur.totalCost += cost;
            this._addUsageParts(cur, parts);
            daily.set(date, cur);
            source.totalTokens += tok;
            source.totalCost += cost;
            this._addUsageParts(source, parts);
          }
          bySource.set(agentId, source);
          for (const m of Array.isArray(j.by_model) ? j.by_model : []) {
            const name = m.model || m.name || "unknown";
            const parts = this._usageParts(m);
            const tok =
              Number(m.total_tokens) ||
              parts.inputTokens + parts.outputTokens + parts.cacheReadTokens + parts.reasoningTokens;
            const cost = this._usageCost(m);
            const cur = byModel.get(name) || { model: name, provider: m.provider || undefined, totalTokens: 0, totalCost: 0 };
            cur.totalTokens += tok;
            cur.totalCost += cost;
            this._addUsageParts(cur, parts);
            byModel.set(name, cur);
          }
        } catch {
          failures += 1;
        }
      }),
    );
    return { daily, byModel, bySource, availability: !bySource.size ? "unavailable" : failures ? "partial" : "complete",
      ...(range === "all" && this._getConfig().hermesMode === "remote" ? { availabilityReason: "unsupported-range" } : {}) };
  }

  async getUsageSeries(range = "30d") {
    const { daily, availability, availabilityReason } = await this._fetchUsageAnalytics(range);
    const rows = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
    // totals 直接由 daily 汇总，保证曲线和 KPI 使用同一时间口径。
    const totals = rows.reduce(
      (acc, d) => {
        acc.totalTokens += Number(d.totalTokens) || 0;
        acc.totalCost += Number(d.totalCost) || 0;
        this._addUsageParts(acc, this._usageParts({
          input_tokens: d.inputTokens,
          output_tokens: d.outputTokens,
          cache_read_tokens: d.cacheReadTokens,
          reasoning_tokens: d.reasoningTokens,
        }));
        return acc;
      },
      { totalTokens: 0, totalCost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 },
    );
    return {
      daily: rows,
      totals,
      availability,
      ...(availabilityReason ? { availabilityReason } : {}),
    };
  }

  // 本地日期串（YYYY-MM-DD）：会话按天分桶要与 analytics daily 的 day 键对齐。
  _usageDayStr(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // R209: 补齐与 OpenClaw 同构的 breakdown 扩展段。数据源三路（每 dashboard 并发）：
  //   /api/analytics/usage   → 日聚合 tokens/cost + tools 调用榜（daily 无消息数）
  //   /api/analytics/models  → 模型榜全分项（cache_read/reasoning/provider/api_calls,
  //                            usage.by_model 缺 cache 字段,老版本缺此端点时回退）
  //   /api/sessions          → Top 会话（逐会话 token 全分项/标题/最后活跃）+
  //                            每日活动的消息数/工具数（按会话起始日分桶）+
  //                            按模型×日趋势（近似:整段会话记到起始日、记到会话
  //                            billing 模型上;Hermes 无逐日逐模型矩阵,这是最优解）
  // 已知缺口（做不到,如实降级）：错误数——Hermes 会话无错误信号（end_reason 只有
  // cron_complete/cli_close/session_reset）→ dailyActivity.errors 恒 0。
  async _fetchUsageExtras(range) {
    const days = this._usageRangeDays(range);
    const cutoffSec = range === "all" ? 0 : Date.now() / 1000 - days * 86400;
    const toolAgg = new Map(); // name -> count
    const modelFull = new Map(); // model -> rank row（analytics/models 全分项）
    const dayAct = new Map(); // date -> {messages, toolCalls}
    const modelDay = new Map(); // `${date}|${model}` -> {date, model, tokens, cost}
    const top = [];
    await Promise.all(
      [...this.dashboards.entries()].map(async ([profile, dash]) => {
        const agentId = this._agentIdForRoutableProfile(profile);
        if (!agentId) return;
        const get = (path, timeoutMs = 6000) =>
          httpGet(`${dash.baseUrl}${path}`, { token: dash.token, timeoutMs })
            .then(({ status, body }) => (status === 200 ? JSON.parse(body) : null))
            .catch(() => null);
        const lifetime = range === "all" ? await this._fetchLifetimeUsage(profile).catch(() => null) : null;
        const [usage, models, sess] = range === "all" ? [lifetime, lifetime, lifetime] : await Promise.all([
          get(`/api/analytics/usage?days=${days}`),
          get(`/api/analytics/models?days=${days}`),
          // 单页 1000 条覆盖当前量级（实测 total 两百级）;total 超出即截断,
          // Top 会话/活动计数按已取页近似。
          get(`/api/sessions?limit=1000`, 10000),
        ]);
        for (const a of lifetime?.day_activity || []) {
          const act = dayAct.get(a.date) || { messages: 0, toolCalls: 0 };
          act.messages += Number(a.messages) || 0;
          act.toolCalls += Number(a.toolCalls) || 0;
          dayAct.set(a.date, act);
        }
        for (const m of lifetime?.model_daily || []) {
          const key = `${m.date}|${m.model}`;
          const row = modelDay.get(key) || { date: m.date, model: m.model, tokens: 0, cost: 0 };
          row.tokens += Object.values(this._usageParts(m)).reduce((sum, value) => sum + value, 0);
          row.cost += this._usageCost(m);
          modelDay.set(key, row);
        }
        for (const t of Array.isArray(usage?.tools) ? usage.tools : []) {
          const name = String(t.tool || t.name || "");
          if (!name) continue;
          toolAgg.set(name, (toolAgg.get(name) || 0) + (Number(t.count) || 0));
        }
        for (const m of Array.isArray(models?.models) ? models.models : []) {
          const name = m.model || "unknown";
          const parts = this._usageParts(m);
          const cur =
            modelFull.get(name) ||
            { model: name, provider: m.provider || undefined, count: 0, totalTokens: 0, totalCost: 0 };
          this._addUsageParts(cur, parts);
          cur.totalTokens +=
            parts.inputTokens + parts.outputTokens + parts.cacheReadTokens + parts.reasoningTokens;
          cur.totalCost += this._usageCost(m);
          cur.count += Number(m.api_calls) || 0;
          if (!cur.provider && m.provider) cur.provider = m.provider;
          modelFull.set(name, cur);
        }
        const rows = Array.isArray(sess?.sessions) ? sess.sessions : [];
        for (const s of rows) {
          const startSec = Number(s.started_at) || 0;
          const lastSec = Number(s.last_active) || startSec;
          if (cutoffSec && lastSec < cutoffSec) continue; // 窗口外（按最后活跃）
          // 起始日早于窗口的长命会话:仍计入 Top 会话（窗口内活跃,token 是
          // 会话生涯累计——Hermes 无法按时间切分）,但不进日分桶,免得把
          // 窗口前的日期混进活动/模型×日图拉歪 x 轴。
          const inWindow = !lifetime && (!cutoffSec || startSec >= cutoffSec);
          const inTok = Number(s.input_tokens) || 0;
          const outTok = Number(s.output_tokens) || 0;
          const cacheR = Number(s.cache_read_tokens) || 0;
          const cacheW = Number(s.cache_write_tokens) || 0;
          const reason = Number(s.reasoning_tokens) || 0;
          const tok = inTok + outTok + cacheR + cacheW + reason;
          const cost = this._usageCost(s);
          const date = this._usageDayStr((startSec || lastSec) * 1000);
          if (inWindow) {
            const act = dayAct.get(date) || { messages: 0, toolCalls: 0 };
            act.messages += Number(s.message_count) || 0;
            act.toolCalls += Number(s.tool_call_count) || 0;
            dayAct.set(date, act);
            const model = s.model || "unknown";
            if (tok > 0) {
              const key = `${date}|${model}`;
              const md = modelDay.get(key) || { date, model, tokens: 0, cost: 0 };
              md.tokens += tok;
              md.cost += cost;
              modelDay.set(key, md);
            }
          }
          if (tok > 0) {
            top.push({
              key: `${profile}:${s.id}`,
              label: s.title || s.display_name || String(s.id).slice(0, 8),
              // title 只发真实会话标题（label 的兜底链可能是 id 截断，不算主题）
              title: s.title || undefined,
              sessionId: String(s.id),
              agentId,
              channel: s.source || undefined,
              model: s.model || undefined,
              totalTokens: tok,
              totalCost: cost,
              updatedAt: Math.round(lastSec * 1000),
            });
          }
        }
      }),
    );
    return { toolAgg, modelFull, dayAct, modelDay, top };
  }

  async getUsageBreakdown(range = "30d") {
    const [{ daily, byModel, bySource, availability, availabilityReason }, extras] = await Promise.all([
      this._fetchUsageAnalytics(range),
      this._fetchUsageExtras(range),
    ]);
    // 模型榜优先用 analytics/models 的全分项行（带 cache/provider）,端点缺失
    // （老版本 Hermes）时回退 usage.by_model 聚合。窗口内 0 用量的行过滤掉
    // ——models 端点会把终身用过的模型都列出来,与 OpenClaw 榜口径对齐(R211)。
    const modelRows = extras.modelFull.size ? extras.modelFull : byModel;
    const models = [...modelRows.values()]
      .filter((m) => (Number(m.totalTokens) || 0) > 0)
      .sort((a, b) => b.totalTokens - a.totalTokens);
    const sources = [...bySource.values()].sort((a, b) => b.totalTokens - a.totalTokens);
    const totalRows = sources.length ? sources : models;
    const totals = totalRows.reduce(
      (acc, row) => {
        acc.totalTokens += Number(row.totalTokens) || 0;
        acc.totalCost += Number(row.totalCost) || 0;
        this._addUsageParts(acc, {
          inputTokens: Number(row.inputTokens) || 0,
          outputTokens: Number(row.outputTokens) || 0,
          cacheReadTokens: Number(row.cacheReadTokens) || 0,
          reasoningTokens: Number(row.reasoningTokens) || 0,
        });
        return acc;
      },
      { totalTokens: 0, totalCost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 },
    );
    // 每日活动 = analytics daily 的 tokens/cost + 会话分桶的消息/工具数（日期并集）。
    const actDates = new Set([...daily.keys(), ...extras.dayAct.keys()]);
    const dailyActivity = [...actDates]
      .sort()
      .map((date) => {
        const tok = daily.get(date);
        const act = extras.dayAct.get(date);
        return {
          date,
          messages: act?.messages || 0,
          toolCalls: act?.toolCalls || 0,
          // errors 字段整个省略：Hermes 无错误信号（见 _fetchUsageExtras 注释），
          // UI 据缺省隐藏整条错误线（R211 用户拍板，替代恒 0 贴地线）。
          tokens: Number(tok?.totalTokens) || 0,
          cost: Number(tok?.totalCost) || 0,
        };
      })
      .filter((d) => d.messages > 0 || d.toolCalls > 0 || d.tokens > 0);
    const modelDaily = [...extras.modelDay.values()].sort((a, b) => a.date.localeCompare(b.date));
    const toolStats = [...extras.toolAgg.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
    const topSessions = extras.top.sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 12);
    return {
      byModel: models,
      byAgent: sources.map((s) => ({
        agentId: s.id,
        totalTokens: s.totalTokens,
        totalCost: s.totalCost,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        cacheReadTokens: s.cacheReadTokens,
        reasoningTokens: s.reasoningTokens,
      })), // Hermes 没有会话级 agent 拆分；这里兼容旧字段，语义仍是 profile。
      bySource: sources,
      tools: toolStats.length
        ? {
            totalCalls: toolStats.reduce((s, t) => s + t.count, 0),
            uniqueTools: toolStats.length,
            tools: toolStats,
          }
        : undefined,
      dailyActivity: dailyActivity.length ? dailyActivity : undefined,
      modelDaily: modelDaily.length ? modelDaily : undefined,
      topSessions: topSessions.length ? topSessions : undefined,
      totals,
      sourceKind: "profile",
      availability,
      ...(availabilityReason ? { availabilityReason } : {}),
    };
  }

  // ---- skills (management UI, read-only) ----

  // Aggregate /api/skills across profile dashboards, deduped by name.
  async getSkills() {
    const seen = new Set();
    const out = [];
    await Promise.all(
      [...this.dashboards.values()].map(async (dash) => {
        try {
          const { status, body } = await httpGet(`${dash.baseUrl}/api/skills`, {
            token: dash.token,
          });
          if (status !== 200) return;
          const j = JSON.parse(body);
          const arr = Array.isArray(j) ? j : Array.isArray(j.skills) ? j.skills : [];
          for (const s of arr) {
            const name = s.name || "";
            if (!name || seen.has(name)) continue;
            seen.add(name);
            out.push({
              name,
              description: typeof s.description === "string" ? s.description : "",
              enabled: s.enabled !== false,
              category: s.category || undefined,
              backendId: "hermes",
            });
          }
        } catch {
          /* skip dashboard on failure */
        }
      }),
    );
    return out;
  }

  // Toggle is global (config-level disabled set); apply via the default dashboard.
  async setSkillEnabled(name, enabled) {
    const dash = this.dashboards.get("default") || [...this.dashboards.values()][0];
    if (!dash) throw new Error("hermes: 没有可用的 dashboard");
    const { status, body } = await httpRequest(
      "PUT",
      `${dash.baseUrl}/api/skills/toggle`,
      { token: dash.token, body: { name, enabled: !!enabled } },
    );
    if (status >= 300) throw new Error(`hermes toggle skill failed: ${status} ${body}`);
    return { name, enabled: !!enabled };
  }

  // Hermes only supports enable/disable (no per-skill apiKey/env via dashboard).
  async updateSkill(name, patch) {
    if (typeof patch?.enabled === "boolean") return this.setSkillEnabled(name, patch.enabled);
    return { name };
  }

  // ---- tasks / kanban (management UI) ----
  // Kanban is a dashboard plugin (single shared kanban.db); read its board off
  // the default dashboard. Returns an empty board when the plugin is disabled.
  async getTaskBoard(opts) {
    const dash = this.dashboards.get("default") || [...this.dashboards.values()][0];
    if (!dash) return { columns: [] };
    try {
      const params = new URLSearchParams();
      if (opts?.includeArchived) params.set("include_archived", "true");
      if (opts?.board) params.set("board", opts.board);
      const qs = params.toString() ? `?${params.toString()}` : "";
      const { status, body } = await httpGet(
        `${dash.baseUrl}/api/plugins/kanban/board${qs}`,
        { token: dash.token },
      );
      if (status !== 200) return { columns: [] }; // plugin disabled / unavailable
      const j = JSON.parse(body);
      const cols = Array.isArray(j.columns) ? j.columns : [];
      return {
        columns: cols.map((c) => ({
          id: String(c.name),
          name: String(c.name),
          tasks: (Array.isArray(c.tasks) ? c.tasks : []).map((t) => ({
            id: String(t.id ?? ""),
            title: t.title || t.name || String(t.id ?? ""),
            excerpt: typeof t.body === "string" ? t.body.replace(/\s+/g, " ").slice(0, 140) : "",
            column: String(c.name),
            assignee: t.assignee || undefined,
            agentId: t.assignee ? agentIdForProfile(t.assignee) : undefined,
            priority: typeof t.priority === "number" ? t.priority : undefined,
            tenant: t.tenant || undefined,
            commentCount: typeof t.comment_count === "number" ? t.comment_count : undefined,
            linkCount: t.link_counts
              ? { parents: Number(t.link_counts.parents || 0), children: Number(t.link_counts.children || 0) }
              : undefined,
            progress: t.progress && typeof t.progress.total === "number"
              ? { done: Number(t.progress.done || 0), total: Number(t.progress.total || 0) }
              : undefined,
            warnings: t.warnings && t.warnings.count
              ? { count: Number(t.warnings.count), highestSeverity: String(t.warnings.highest_severity || "warning") }
              : undefined,
            createdAt: epochSecToMs(t.created_at),
            scheduledAt: epochSecToMs(t.scheduled_at ?? t.scheduled_for ?? t.not_before),
            age: t.age
              ? {
                  createdAgeSeconds: typeof t.age.created_age_seconds === "number" ? t.age.created_age_seconds : undefined,
                  startedAgeSeconds: typeof t.age.started_age_seconds === "number" ? t.age.started_age_seconds : undefined,
                }
              : undefined,
            backendId: "hermes",
          })),
        })),
        // Hermes kanban = full parity surface; the UI gates every control off these flags
        // (no backend special-casing). drag = move (status change), archive = soft-delete.
        capabilities: {
          kind: "hermes", drag: true, archive: true, hardDelete: true,
          boards: true, orchestration: true, tenants: true, lanes: true,
          diagnostics: true, dispatch: true, links: true, progress: true, archived: true,
          // 官方 kanban 独有的几件事，各只被 UI 消费一次，不做无谓的通用化：
          attachments: true,        // 抽屉附件区（上传/下载/删）
          modelOverride: true,      // 每任务模型覆盖（/model-options 目录）
          boardSettings: true,      // 板设置对话框（名/描述/项目目录）
          profiles: true,           // 编排面板的 profile 描述编辑
          homeChannels: true,       // 每任务的 home 频道通知开关
          completionSummary: true,  // 移到 done 必须填完成摘要
          bulkDelete: true,         // 批量永久删除 / 垃圾桶拖放
          workspaceKinds: ["scratch", "worktree", "dir"],
          // 官方 update_task 直接可设状态白名单：running 走 dispatcher/claim、
          // review 由 worker 提交产生，都不可直接 PATCH（KAN-004）。
          moveTargets: ["triage", "todo", "ready", "scheduled", "blocked", "done", "archived"],
        },
        tenants: Array.isArray(j.tenants) ? j.tenants.map(String) : [],
        assignees: Array.isArray(j.assignees) ? j.assignees.map(String) : [],
      };
    } catch {
      return { columns: [] };
    }
  }

  // 官方 GET /diagnostics：有活跃诊断的任务清单（板头 attention strip 的数据源，
  // GAP-002）。诊断项形状与 getTask 的 t.diagnostics 映射保持一致。
  async getTaskDiagnostics(opts) {
    const dash = this._kanbanDash();
    if (!dash) return null;
    const qs = new URLSearchParams();
    if (opts?.board) qs.set("board", opts.board);
    if (opts?.severity) qs.set("severity", opts.severity);
    const q = qs.toString() ? `?${qs.toString()}` : "";
    const { status, body } = await httpGet(this._kanbanUrl(dash, `/diagnostics${q}`), { token: dash.token });
    if (status !== 200) throw new Error(`hermes diagnostics failed: ${status}`);
    const rows = JSON.parse(body);
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      taskId: String(r.task_id ?? ""),
      taskTitle: r.task_title || "",
      taskStatus: r.task_status || undefined,
      taskAssignee: r.task_assignee || undefined,
      diagnostics: (Array.isArray(r.diagnostics) ? r.diagnostics : []).map((d) => ({
        severity: d.severity || "info",
        kind: d.kind || "",
        message: d.message || d.detail || d.hint || "",
      })),
    }));
  }

  // ---- multi-board (Slice 4) ----
  async getBoards() {
    const dash = this._kanbanDash();
    if (!dash) return [];
    try {
      const { status, body } = await httpGet(this._kanbanUrl(dash, "/boards"), { token: dash.token });
      if (status !== 200) return [];
      const j = JSON.parse(body);
      const arr = Array.isArray(j) ? j : Array.isArray(j.boards) ? j.boards : [];
      return arr.map((b) => ({
        slug: String(b.slug ?? ""),
        name: b.name || b.slug || "",
        description: b.description || undefined,
        icon: b.icon || undefined,
        total: typeof b.total === "number"
          ? b.total
          : b.counts ? Object.values(b.counts).reduce((s, n) => s + Number(n || 0), 0) : 0,
        current: !!b.is_current,
        backendId: "hermes",
        // 板级项目目录 + 由它推导的工作区类型（git 仓 → worktree，普通目录 → dir，
        // 未配置 → scratch）；建卡表单的默认值来源。
        defaultWorkdir: b.default_workdir || undefined,
        defaultWorkspaceKind: b.default_workspace_kind || undefined,
      }));
    } catch {
      return [];
    }
  }

  async createBoard(spec) {
    const dash = this._kanbanDash();
    if (!dash) throw new Error("hermes: 没有可用的看板");
    const slug = String(spec?.slug || "").trim();
    if (!slug) throw new Error("看板 slug 不能为空");
    const { status, body } = await httpRequest("POST", this._kanbanUrl(dash, "/boards"), {
      token: dash.token,
      body: {
        slug,
        name: spec?.name || undefined,
        description: spec?.description || undefined,
        icon: spec?.icon || undefined,
        default_workdir: spec?.defaultWorkdir || undefined,
        switch: spec?.switch !== false,
      },
    });
    if (status >= 300) throw new Error(kanbanDetail(body));
    let j = {};
    try { j = JSON.parse(body); } catch { /* tolerate empty */ }
    return { slug: String(j.slug || slug), name: j.name || spec?.name || slug };
  }

  async switchBoard(slug) {
    const dash = this._kanbanDash();
    if (!dash) throw new Error("hermes: 没有可用的看板");
    const { status, body } = await httpRequest("POST", this._kanbanUrl(dash, `/boards/${encodeURIComponent(slug)}/switch`), { token: dash.token });
    if (status >= 300) throw new Error(`hermes switch board failed: ${status} ${body}`);
    return { ok: true };
  }

  async deleteBoard(slug, hard = false) {
    const dash = this._kanbanDash();
    if (!dash) throw new Error("hermes: 没有可用的看板");
    if (slug === "default") throw new Error("default 看板不可删除");
    const { status, body } = await httpRequest("DELETE", this._kanbanUrl(dash, `/boards/${encodeURIComponent(slug)}${hard ? "?delete=true" : ""}`), { token: dash.token });
    if (status >= 300) throw new Error(`hermes delete board failed: ${status} ${body}`);
    return { ok: true };
  }

  // ---- orchestration (Slice 5) ----
  async getOrchestration() {
    const dash = this._kanbanDash();
    if (!dash) return { autoDecompose: false, autoPromoteChildren: false };
    const { status, body } = await httpGet(this._kanbanUrl(dash, "/orchestration"), { token: dash.token });
    if (status !== 200) throw new Error(`hermes orchestration failed: ${status}`);
    const j = JSON.parse(body);
    return {
      orchestratorProfile: j.orchestrator_profile || undefined,
      defaultAssignee: j.default_assignee || undefined,
      autoDecompose: !!j.auto_decompose,
      autoPromoteChildren: !!j.auto_promote_children,
      resolvedOrchestratorProfile: j.resolved_orchestrator_profile || undefined,
      resolvedDefaultAssignee: j.resolved_default_assignee || undefined,
      activeProfile: j.active_profile || undefined,
    };
  }

  async setOrchestration(patch) {
    const dash = this._kanbanDash();
    if (!dash) throw new Error("hermes: 没有可用的看板");
    const body = {};
    if (patch.orchestratorProfile !== undefined) body.orchestrator_profile = patch.orchestratorProfile || null;
    if (patch.defaultAssignee !== undefined) body.default_assignee = patch.defaultAssignee || null;
    if (typeof patch.autoDecompose === "boolean") body.auto_decompose = patch.autoDecompose;
    if (typeof patch.autoPromoteChildren === "boolean") body.auto_promote_children = patch.autoPromoteChildren;
    const { status, body: resp } = await httpRequest("PUT", this._kanbanUrl(dash, "/orchestration"), { token: dash.token, body });
    if (status >= 300) throw new Error(`hermes set orchestration failed: ${status} ${resp}`);
    return this.getOrchestration();
  }

  // ---- detail-drawer extras (Slice 6) ----
  async addTaskLink(parent, child, opts) {
    const dash = this._kanbanDash();
    if (!dash) throw new Error("hermes: 没有可用的看板");
    if (!parent || !child) throw new Error("依赖需要父/子任务 id");
    const { status, body } = await httpRequest("POST", this._kanbanUrl(dash, `/links${kanbanBoardQ(opts)}`), {
      token: dash.token, body: { parent_id: String(parent), child_id: String(child) },
    });
    if (status >= 300) throw new Error(`hermes add link failed: ${status} ${body}`);
    return { ok: true };
  }
  async removeTaskLink(parent, child, opts) {
    const dash = this._kanbanDash();
    if (!dash) throw new Error("hermes: 没有可用的看板");
    // DELETE /links takes parent_id/child_id as QUERY params (not a body).
    const q = `?parent_id=${encodeURIComponent(String(parent))}&child_id=${encodeURIComponent(String(child))}${kanbanBoardQ(opts, "&")}`;
    const { status, body } = await httpRequest("DELETE", this._kanbanUrl(dash, `/links${q}`), { token: dash.token });
    if (status >= 300) throw new Error(`hermes remove link failed: ${status} ${body}`);
    return { ok: true };
  }
  async reassignTask(id, assignee, reclaim, opts) {
    const dash = this._kanbanDash();
    if (!dash) throw new Error("hermes: 没有可用的看板");
    // 官方 ReassignBody 是 {profile, reclaim_first}（""/null = 解除指派）；旧的
    // {assignee, reclaim} 键会被上游静默忽略，等效 profile=None → 每次"重新指派"
    // 实际执行解除指派（KAN-002）。
    const { status, body } = await httpRequest("POST", this._kanbanUrl(dash, `/tasks/${encodeURIComponent(id)}/reassign${kanbanBoardQ(opts)}`), {
      token: dash.token, body: { profile: assignee || null, reclaim_first: !!reclaim },
    });
    if (status >= 300) throw new Error(`hermes reassign failed: ${status} ${body}`);
    return { ok: true };
  }
  async reclaimTask(id, opts) {
    const dash = this._kanbanDash();
    if (!dash) throw new Error("hermes: 没有可用的看板");
    // 官方 reclaim_task_endpoint 的 ReclaimBody 是必需 body 参数——不带 JSON body
    // 一律 422（KAN-003）。字段全可选，body 本身不能省。
    const { status, body } = await httpRequest("POST", this._kanbanUrl(dash, `/tasks/${encodeURIComponent(id)}/reclaim${kanbanBoardQ(opts)}`), {
      token: dash.token, body: { reason: "dashboard" },
    });
    if (status >= 300) throw new Error(`hermes reclaim failed: ${status} ${body}`);
    return { ok: true };
  }
  // 官方 GET /tasks/{id}/log?tail= → {exists, content, size_bytes, truncated, path}。
  // 旧实现读不存在的 `j.log`，一路兜底成整个 JSON 文本回吐给 <pre>（抽屉里显示的是
  // 原始 JSON 而不是日志）。官方前端固定 tail=100000（100KB 尾巴）。
  async getTaskLog(id, opts) {
    const dash = this._kanbanDash();
    if (!dash) return { content: "", exists: false };
    const tail = Number(opts?.tail) > 0 ? Number(opts.tail) : 100000;
    const q = `?tail=${tail}${kanbanBoardQ(opts, "&")}`;
    const { status, body } = await httpGet(this._kanbanUrl(dash, `/tasks/${encodeURIComponent(id)}/log${q}`), { token: dash.token });
    if (status !== 200) return { content: "", exists: false };
    try {
      const j = JSON.parse(body);
      return {
        content: typeof j.content === "string" ? j.content : "",
        exists: !!j.exists,
        sizeBytes: typeof j.size_bytes === "number" ? j.size_bytes : undefined,
        truncated: !!j.truncated,
        path: j.path || undefined,
      };
    } catch {
      return { content: "", exists: false };
    }
  }

  // Bulk update (multi-select on the board) —— 官方 POST /tasks/bulk：一次请求、
  // 每 id 独立执行、返回 per-id 成败（一张卡失败不中断兄弟，天然满足铁律 4）。
  // 早期版本没有这个端点，旧实现是 N 次单任务扇出（已核实现在实活）。
  async bulkUpdateTasks(ids, patch, opts) {
    const dash = this._kanbanDash();
    if (!dash) throw new Error("hermes: 没有可用的看板");
    if (!Array.isArray(ids) || !ids.length) throw new Error("bulk: 没有选中任务");
    const p = patch || {};
    const payload = { ids: ids.map(String) };
    if (typeof p.status === "string" && p.status) payload.status = p.status;
    // "" = 解除指派（官方语义），所以只判 undefined/null 而不是真值。
    if (p.assignee !== undefined && p.assignee !== null) payload.assignee = String(p.assignee);
    if (typeof p.priority === "number") payload.priority = p.priority;
    if (p.archive) payload.archive = true;
    if (typeof p.result === "string") payload.result = p.result;
    if (typeof p.summary === "string") payload.summary = p.summary;
    if (p.reclaimFirst) payload.reclaim_first = true;
    if (typeof p.modelOverride === "string") payload.model_override = p.modelOverride;
    if (typeof p.providerOverride === "string") payload.provider_override = p.providerOverride;
    if (p.clearModelOverride) payload.clear_model_override = true;
    const { status, body } = await httpRequest("POST", this._kanbanUrl(dash, `/tasks/bulk${kanbanBoardQ(opts)}`), {
      token: dash.token, body: payload, timeoutMs: 30000,
    });
    if (status >= 300) throw new Error(`hermes bulk failed: ${kanbanDetail(body)}`);
    let rows = [];
    try { rows = JSON.parse(body).results || []; } catch { /* 容忍空体 */ }
    const failedRows = rows.filter((r) => r && r.ok === false);
    return {
      ok: true,
      total: rows.length || ids.length,
      failed: failedRows.length,
      failedIds: failedRows.map((r) => String(r.id)),
      errors: failedRows.slice(0, 3).map((r) => `${r.id}: ${r.error || "failed"}`),
    };
  }

  // 批量永久删除：官方 BulkActionBar 的 Delete 是 N 次 DELETE /tasks/{id}
  // （bulk 端点不含删除）。allSettled 保证一张失败不拖垮整批。
  async bulkDeleteTasks(ids, opts) {
    if (!Array.isArray(ids) || !ids.length) throw new Error("bulk: 没有选中任务");
    const results = await Promise.allSettled(ids.map((id) => this.deleteTask(String(id), opts)));
    const failed = results
      .map((r, i) => (r.status === "rejected" ? { id: String(ids[i]), reason: String(r.reason?.message || r.reason) } : null))
      .filter(Boolean);
    return {
      ok: true,
      total: ids.length,
      failed: failed.length,
      failedIds: failed.map((f) => f.id),
      errors: failed.slice(0, 3).map((f) => `${f.id}: ${f.reason}`),
    };
  }

  // ---- 看板前端偏好 / 板设置 / profile 描述 / 模型目录 / 附件 / home 订阅 ----

  // 官方 GET /config：UI 的筛选默认值来源（注意 lane_by_profile 官方默认 true）。
  async getTaskBoardConfig() {
    const dash = this._kanbanDash();
    if (!dash) return null;
    try {
      const { status, body } = await httpGet(this._kanbanUrl(dash, "/config"), { token: dash.token });
      if (status !== 200) return null;
      const j = JSON.parse(body);
      return {
        defaultTenant: j.default_tenant || "",
        laneByProfile: j.lane_by_profile !== false,
        includeArchivedByDefault: !!j.include_archived_by_default,
        renderMarkdown: j.render_markdown !== false,
      };
    } catch {
      return null;
    }
  }

  async updateBoard(slug, patch) {
    const dash = this._kanbanDash();
    if (!dash) throw new Error("hermes: 没有可用的看板");
    if (!slug) throw new Error("看板 slug 不能为空");
    const body = {};
    if (patch?.name !== undefined) body.name = patch.name || undefined;
    if (patch?.description !== undefined) body.description = patch.description || undefined;
    if (patch?.icon !== undefined) body.icon = patch.icon || undefined;
    // 官方：default_workdir 无条件送——""=清除，绝对路径=服务端校验后设置。
    if (patch?.defaultWorkdir !== undefined) body.default_workdir = String(patch.defaultWorkdir ?? "");
    const { status, body: resp } = await httpRequest(
      "PATCH", this._kanbanUrl(dash, `/boards/${encodeURIComponent(slug)}`), { token: dash.token, body },
    );
    if (status >= 300) throw new Error(kanbanDetail(resp));
    return { ok: true };
  }

  async getBoardProfiles() {
    const dash = this._kanbanDash();
    if (!dash) return [];
    try {
      const { status, body } = await httpGet(this._kanbanUrl(dash, "/profiles"), { token: dash.token });
      if (status !== 200) return [];
      const j = JSON.parse(body);
      const arr = Array.isArray(j) ? j : Array.isArray(j.profiles) ? j.profiles : [];
      return arr.map((p) => ({
        name: String(p.name ?? ""),
        description: p.description || "",
        descriptionAuto: !!p.description_auto,
        isDefault: !!p.is_default,
        model: p.model || undefined,
        provider: p.provider || undefined,
        skillCount: typeof p.skill_count === "number" ? p.skill_count : undefined,
      }));
    } catch {
      return [];
    }
  }

  async updateBoardProfile(name, patch) {
    const dash = this._kanbanDash();
    if (!dash) throw new Error("hermes: 没有可用的看板");
    if (!name) throw new Error("profile 名不能为空");
    const { status, body } = await httpRequest(
      "PATCH", this._kanbanUrl(dash, `/profiles/${encodeURIComponent(name)}`),
      { token: dash.token, body: { description: String(patch?.description ?? "") } },
    );
    if (status >= 300) throw new Error(kanbanDetail(body));
    return { ok: true };
  }

  // ⚗ 自动生成描述：走 auxiliary LLM，可能几十秒；非 OK 不是 HTTP 错误，
  // 官方把 reason 内联展示（我们照抄：返回 {ok, reason}，由 UI 决定提示口吻）。
  async describeBoardProfileAuto(name, overwrite) {
    const dash = this._kanbanDash();
    if (!dash) throw new Error("hermes: 没有可用的看板");
    if (!name) throw new Error("profile 名不能为空");
    const { status, body } = await httpRequest(
      "POST", this._kanbanUrl(dash, `/profiles/${encodeURIComponent(name)}/describe-auto`),
      { token: dash.token, body: { overwrite: !!overwrite }, timeoutMs: 180000 },
    );
    if (status >= 300) throw new Error(kanbanDetail(body));
    try {
      const j = JSON.parse(body);
      return { ok: !!j.ok, reason: j.reason || undefined, description: j.description || undefined };
    } catch {
      return { ok: true };
    }
  }

  // 任务级模型覆盖的候选目录。官方目录取不到时返回空 providers，
  // 前端退化成自由文本输入——所以这里失败也只回空，不抛。
  async getTaskModelOptions() {
    const dash = this._kanbanDash();
    if (!dash) return { providers: [] };
    try {
      const { status, body } = await httpGet(this._kanbanUrl(dash, "/model-options"), { token: dash.token, timeoutMs: 15000 });
      if (status !== 200) return { providers: [] };
      const j = JSON.parse(body);
      return {
        providers: (Array.isArray(j.providers) ? j.providers : []).map((p) => ({
          slug: String(p.slug ?? ""),
          label: p.label || p.slug || "",
          models: (Array.isArray(p.models) ? p.models : []).map(String),
        })).filter((p) => p.slug && p.models.length),
      };
    } catch {
      return { providers: [] };
    }
  }

  async listTaskAttachments(id, opts) {
    const dash = this._kanbanDash();
    if (!dash) return [];
    try {
      const { status, body } = await httpGet(
        this._kanbanUrl(dash, `/tasks/${encodeURIComponent(id)}/attachments${kanbanBoardQ(opts)}`), { token: dash.token },
      );
      if (status !== 200) return [];
      return hermesAttachments(JSON.parse(body).attachments);
    } catch {
      return [];
    }
  }

  async addTaskAttachment(id, file, opts) {
    const dash = this._kanbanDash();
    if (!dash) throw new Error("hermes: 没有可用的看板");
    if (!file?.data?.length) throw new Error("附件为空");
    if (file.data.length > HERMES_ATTACHMENT_MAX_BYTES) {
      throw new Error(`附件超过 ${HERMES_ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB 上限`);
    }
    const { contentType, payload } = multipartFile("file", file);
    const { status, data } = await httpRaw(
      "POST", this._kanbanUrl(dash, `/tasks/${encodeURIComponent(id)}/attachments${kanbanBoardQ(opts)}`),
      { token: dash.token, contentType, payload, timeoutMs: 120000 },
    );
    const text = data.toString("utf8");
    if (status >= 300) throw new Error(kanbanDetail(text));
    try {
      return hermesAttachments([JSON.parse(text).attachment])[0] || { id: "", filename: file.filename };
    } catch {
      return { id: "", filename: file.filename };
    }
  }

  async readTaskAttachment(attachmentId, opts) {
    const dash = this._kanbanDash();
    if (!dash) throw new Error("hermes: 没有可用的看板");
    const { status, data, headers } = await httpRaw(
      "GET", this._kanbanUrl(dash, `/attachments/${encodeURIComponent(attachmentId)}${kanbanBoardQ(opts)}`),
      { token: dash.token, timeoutMs: 120000, maxResponseBytes: HERMES_ATTACHMENT_MAX_BYTES },
    );
    if (status >= 300) throw new Error(kanbanDetail(data.toString("utf8")));
    const disp = String(headers?.["content-disposition"] || "");
    return {
      filename: attachmentFilename(disp, `attachment-${attachmentId}`),
      contentType: String(headers?.["content-type"] || "application/octet-stream"),
      data,
    };
  }

  async deleteTaskAttachment(attachmentId, opts) {
    const dash = this._kanbanDash();
    if (!dash) throw new Error("hermes: 没有可用的看板");
    const { status, body } = await httpRequest(
      "DELETE", this._kanbanUrl(dash, `/attachments/${encodeURIComponent(attachmentId)}${kanbanBoardQ(opts)}`),
      { token: dash.token },
    );
    if (status >= 300) throw new Error(kanbanDetail(body));
    return { ok: true };
  }

  // 官方 GET /home-channels?task_id=：列出配置了 home 的平台 + 本任务订阅状态。
  // 端点在旧网关上可能缺席，官方前端静默忽略 → 我们也回空数组。
  async getTaskHomeChannels(id, opts) {
    const dash = this._kanbanDash();
    if (!dash) return [];
    try {
      const q = `?task_id=${encodeURIComponent(id)}${kanbanBoardQ(opts, "&")}`;
      const { status, body } = await httpGet(this._kanbanUrl(dash, `/home-channels${q}`), { token: dash.token });
      if (status !== 200) return [];
      const j = JSON.parse(body);
      return (Array.isArray(j.home_channels) ? j.home_channels : []).map((c) => ({
        platform: String(c.platform ?? ""),
        name: c.name || undefined,
        chatId: c.chat_id != null ? String(c.chat_id) : undefined,
        threadId: c.thread_id ? String(c.thread_id) : undefined,
        subscribed: !!c.subscribed,
      })).filter((c) => c.platform);
    } catch {
      return [];
    }
  }

  async setTaskHomeSubscription(id, platform, subscribed, opts) {
    const dash = this._kanbanDash();
    if (!dash) throw new Error("hermes: 没有可用的看板");
    if (!platform) throw new Error("缺少平台");
    const url = this._kanbanUrl(
      dash,
      `/tasks/${encodeURIComponent(id)}/home-subscribe/${encodeURIComponent(platform)}${kanbanBoardQ(opts)}`,
    );
    const { status, body } = await httpRequest(subscribed ? "POST" : "DELETE", url, { token: dash.token });
    if (status >= 300) throw new Error(kanbanDetail(body));
    return { ok: true };
  }

  _kanbanDash() {
    return this.dashboards.get("default") || [...this.dashboards.values()][0] || null;
  }
  _kanbanUrl(dash, suffix = "") {
    return `${dash.baseUrl}/api/plugins/kanban${suffix}`;
  }

  // 健康采样目标：整体 + 每 profile dashboard（registry 通用消费，铁律 1：
  // registry/UI 不特判 Hermes）。启动窗（R130 _startingAt）产出 unknown，
  // journal 忽略之——spawn→ready 期间不应记成断连。
  async getHealthTargets() {
    if (this._startingAt) {
      return [{ targetType: "backend", targetId: this.id, backendId: this.id, state: "unknown" }];
    }
    const rows = await this._getDashboardStatusRows();
    const overall = rows.some((d) => d.connected);
    const targets = [{
      targetType: "backend",
      targetId: this.id,
      backendId: this.id,
      state: overall ? "connected" : "disconnected",
      reason: overall ? undefined : this.lastError || undefined,
    }];
    for (const d of rows) {
      targets.push({
        targetType: "profile-dashboard",
        targetId: `hermes:${d.profile}`,
        backendId: this.id,
        state: d.connected ? "connected" : "disconnected",
      });
    }
    return targets;
  }

  // 无注入 journal（旧 dev harness 直 new 本类）时的进程内暂存兜底
  _ensureDashboardJournal() {
    if (this._dashboardJournal) return this._dashboardJournal;
    if (!this._memDashboardJournal) {
      const cursors = new Map();
      const events = new Map();
      this._memDashboardJournal = {
        getKanbanCursor: (k) => cursors.get(k),
        setKanbanCursor: (k, v) => { if (Number.isFinite(v)) cursors.set(k, v); },
        appendKanbanEvents: (k, rows, { dayStartMs = 0 } = {}) => {
          const merged = new Map();
          for (const row of [...(events.get(k) || []), ...(rows || [])]) {
            if (!row || row.id == null) continue;
            const at = Number(row.created_at) || 0;
            if ((at > 1e12 ? at : at * 1000) < dayStartMs) continue;
            merged.set(row.id, row);
          }
          events.set(k, [...merged.values()].sort((a, b) => (a.id > b.id ? 1 : -1)).slice(-2000));
        },
        getKanbanEvents: (k) => (events.get(k) || []).slice(),
      };
    }
    return this._memDashboardJournal;
  }

  // 看板活动源（统一动态流）：事件回放只有 WebSocket
  // （/api/plugins/kanban/events?since=<int事件id>，无 REST GET；cursor 是
  // per-profile 全局自增 id，无服务端时间过滤）。做法：/board 快照拿
  // latest_event_id + 标题映射 → 起点 = journal cursor ?? max(0, latest-5000)
  // （冷启动有界回放）→ WS 短连 drain 到追平快照或 deadline（默认 5s，绝不
  // 吊死 45s 轮询）→ 事件与 cursor 都写 journal（重启后当天动态不丢）。
  // kanban 与 Tasks 页同源：_kanbanDash 的那一个 dashboard（默认 default）。
  async getRecentKanbanActivities({ sinceMs = 0 } = {}) {
    const entry = this.dashboards.has("default")
      ? ["default", this.dashboards.get("default")]
      : [...this.dashboards.entries()][0] || null;
    if (!entry || !entry[1] || !entry[1].baseUrl) {
      return { supported: false, reason: "unavailable", items: [] };
    }
    const [profile, dash] = entry;
    const agentId = this._agentIdForRoutableProfile(profile);
    if (!agentId) return { supported: true, items: [] };
    let board;
    try {
      // include_archived：归档任务的标题也要能查到（今天的 archived 事件很常见）
      board = await this._httpGetJson(this._kanbanUrl(dash, "/board?include_archived=true"), dash.token);
    } catch {
      return { supported: false, reason: "unavailable", items: [] };
    }
    if (board.status === 404) return { supported: false, reason: "unsupported", items: [] }; // 插件禁用
    if (board.status !== 200 || !board.json) return { supported: false, reason: "unavailable", items: [] };
    const latest = Number(board.json.latest_event_id) || 0;
    const titleByTaskId = new Map();
    for (const col of Array.isArray(board.json.columns) ? board.json.columns : []) {
      for (const t of Array.isArray(col?.tasks) ? col.tasks : []) {
        if (t && t.id != null) titleByTaskId.set(String(t.id), t.title || "");
      }
    }
    const journal = this._ensureDashboardJournal();
    const key = `hermes:${profile}`;
    let truncated = false;
    const storedCursor = journal.getKanbanCursor(key);
    const start = Number.isFinite(storedCursor) ? storedCursor : Math.max(0, latest - 5000);
    if (!Number.isFinite(storedCursor) && latest > 5000) truncated = true; // 有界回放跳过更早历史
    if (latest > start) {
      const wsBase = String(dash.baseUrl).replace(/^http/i, "ws");
      const drained = await this._drainKanbanEvents({
        wsUrl: `${wsBase}/api/plugins/kanban/events`,
        token: dash.token || "",
        since: start,
        latest,
        deadlineMs: this._kanbanDrainDeadlineMs || 5000,
      });
      if (drained.rows.length) journal.appendKanbanEvents(key, drained.rows, { dayStartMs: sinceMs });
      if (drained.cursor > start) journal.setKanbanCursor(key, drained.cursor);
      if (!drained.complete) truncated = true;
    }
    const items = [];
    for (const row of journal.getKanbanEvents(key)) {
      const a = hermesKanbanEventToActivity(row, { profile, backendId: this.id, titleByTaskId, agentId });
      if (a && a.occurredAt >= sinceMs) items.push(a);
    }
    const res = { supported: true, items };
    if (truncated) res.truncated = true;
    return res;
  }

  // WS 短连 drain：收帧 {events[], cursor} 直到 cursor ≥ latest 或 deadline。
  _drainKanbanEvents({ wsUrl, token, since, latest, deadlineMs }) {
    return new Promise((resolve) => {
      const rows = [];
      let cursor = since;
      let settled = false;
      let ws = null;
      let timer = null;
      const done = (complete) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try { if (ws) ws.close(); } catch { /* closing */ }
        resolve({ rows, cursor, complete });
      };
      const q = new URLSearchParams({ since: String(since) });
      if (token) q.set("token", token);
      try {
        ws = new WebSocket(`${wsUrl}?${q.toString()}`);
      } catch {
        return done(false);
      }
      timer = setTimeout(() => done(false), deadlineMs);
      if (typeof timer.unref === "function") timer.unref();
      ws.on("message", (data) => {
        try {
          const frame = JSON.parse(data.toString());
          if (Array.isArray(frame.events)) rows.push(...frame.events);
          if (Number.isFinite(frame.cursor)) cursor = Math.max(cursor, frame.cursor);
        } catch { /* 非 JSON 帧忽略 */ }
        if (cursor >= latest) done(true);
      });
      ws.on("error", () => done(false));
      ws.on("close", () => done(cursor >= latest));
    });
  }

  // WS target for the live kanban event stream (Slice 9 broker). Hermes-only;
  // returns null when no dashboard is up so the broker degrades gracefully.
  getKanbanEventsTarget() {
    const dash = this._kanbanDash();
    if (!dash || !dash.baseUrl) return null;
    const wsBase = String(dash.baseUrl).replace(/^http/i, "ws");
    return { wsUrl: `${wsBase}/api/plugins/kanban/events`, token: dash.token || "" };
  }

  async getTask(id, opts) {
    const dash = this._kanbanDash();
    if (!dash) throw new Error("hermes: 没有可用的看板");
    const { status, body } = await httpGet(this._kanbanUrl(dash, `/tasks/${encodeURIComponent(id)}${kanbanBoardQ(opts)}`), {
      token: dash.token,
    });
    if (status !== 200) throw new Error(`hermes get task failed: ${status}`);
    const j = JSON.parse(body);
    const t = j.task || {};
    return {
      id: String(t.id ?? id),
      title: t.title || "",
      body: typeof t.body === "string" ? t.body : "",
      column: t.status || "",
      assignee: t.assignee || undefined,
      priority: typeof t.priority === "number" ? t.priority : undefined,
      summary: t.summary || t.latest_summary || undefined,
      tenant: t.tenant || undefined,
      result: typeof t.result === "string" ? t.result : undefined,
      workspaceKind: t.workspace_kind || undefined,
      workspacePath: t.workspace_path || undefined,
      skills: Array.isArray(t.skills) && t.skills.length ? t.skills.map(String) : undefined,
      goalMode: !!t.goal_mode,
      goalMaxTurns: typeof t.goal_max_turns === "number" ? t.goal_max_turns : undefined,
      createdBy: t.created_by || undefined,
      // 每任务模型覆盖（官方抽屉的 Model 行）。provider 可空 = 只覆盖模型名。
      modelOverride: t.model_override || undefined,
      providerOverride: t.provider_override || undefined,
      // 官方 Result 区取 result || latest_summary，两者分开留给 UI 区分标题。
      latestSummary: t.latest_summary || undefined,
      blockReason: t.block_reason || undefined,
      createdAt: epochSecToMs(t.created_at),
      startedAt: epochSecToMs(t.started_at),
      completedAt: epochSecToMs(t.completed_at),
      comments: (Array.isArray(j.comments) ? j.comments : []).map((c) => ({
        author: c.author || c.assignee || "",
        body: c.body || c.text || "",
        createdAt: c.created_at || undefined,
      })),
      runs: (Array.isArray(j.runs) ? j.runs : []).map((r) => ({
        id: r.id != null ? String(r.id) : undefined,
        status: r.outcome || r.status || undefined,
        outcome: r.outcome || undefined,
        startedAt: epochSecToMs(r.started_at),
        finishedAt: epochSecToMs(r.ended_at),
        summary: r.summary || undefined,
        error: r.error || undefined,
        profile: r.profile || undefined,
        metadata: r.metadata && typeof r.metadata === "object" ? r.metadata : undefined,
      })),
      events: (Array.isArray(j.events) ? j.events : []).map((e) => ({
        id: e.id != null ? String(e.id) : undefined,
        kind: e.kind || "",
        at: epochSecToMs(e.created_at) || 0,
        payload: e.payload && typeof e.payload === "object" ? e.payload : undefined,
      })),
      linkIds: j.links
        ? {
            parents: Array.isArray(j.links.parents) ? j.links.parents.map(String) : [],
            children: Array.isArray(j.links.children) ? j.links.children.map(String) : [],
          }
        : undefined,
      // 子任务结果：官方抽屉的 Child Results 区（父卡自己往往没有 result）。
      childResults: (Array.isArray(j.child_results) ? j.child_results : []).map((c) => ({
        id: String(c.id ?? ""),
        title: c.title || "",
        status: c.status || "",
        result: c.result || undefined,
        latestSummary: c.latest_summary || undefined,
      })),
      attachments: hermesAttachments(j.attachments),
      // 诊断的 title/detail/data/actions 是恢复动作行的全部输入（官方 DiagnosticCard）。
      // message 保留为旧字段名的向后兼容别名。
      diagnostics: (Array.isArray(t.diagnostics) ? t.diagnostics : []).map((d) => ({
        severity: d.severity || "info",
        kind: d.kind || "",
        message: d.title || d.message || d.detail || d.hint || "",
        title: d.title || undefined,
        detail: d.detail || undefined,
        data: d.data && typeof d.data === "object" ? d.data : undefined,
        actions: (Array.isArray(d.actions) ? d.actions : []).map((a) => ({
          kind: String(a.kind ?? ""),
          label: a.label || String(a.kind ?? ""),
          suggested: !!a.suggested,
          payload: a.payload && typeof a.payload === "object" ? a.payload : undefined,
        })),
      })),
      backendId: "hermes",
    };
  }

  async addTaskComment(id, body, author, opts) {
    const dash = this._kanbanDash();
    if (!dash) throw new Error("hermes: 没有可用的看板");
    if (!body || !String(body).trim()) throw new Error("评论不能为空");
    const { status, body: resp } = await httpRequest(
      "POST",
      this._kanbanUrl(dash, `/tasks/${encodeURIComponent(id)}/comments${kanbanBoardQ(opts)}`),
      { token: dash.token, body: { body: String(body), author: author || "dashboard" } },
    );
    if (status >= 300) throw new Error(`hermes add comment failed: ${status} ${resp}`);
    return { ok: true };
  }

  // specify / decompose run an auxiliary LLM, so they can take a while.
  async taskAction(id, action, opts) {
    const dash = this._kanbanDash();
    if (!dash) throw new Error("hermes: 没有可用的看板");
    if (action !== "specify" && action !== "decompose") {
      throw new Error(`hermes: 未知的任务操作 ${action}`);
    }
    // ?board= 贯穿：不带时官方在 current board 找任务，非当前板的任务会
    // 返回 200 + ok:false "unknown task id"（KAN-006）。
    const { status, body } = await httpRequest(
      "POST",
      this._kanbanUrl(dash, `/tasks/${encodeURIComponent(id)}/${action}${kanbanBoardQ(opts)}`),
      { token: dash.token, body: { author: "dashboard" }, timeoutMs: 180000 },
    );
    if (status >= 300) throw new Error(`hermes ${action} failed: ${status} ${body}`);
    try {
      return JSON.parse(body); // { ok, task_id, reason?, new_title? }
    } catch {
      return { ok: true };
    }
  }

  // Nudge dispatcher: claim + spawn up to `max` ready tasks immediately (don't wait
  // for the ~60s background tick). dryRun=true plans WITHOUT spawning — smoke uses it
  // so it never burns real workers/tokens.
  async nudgeDispatcher(opts) {
    const dash = this._kanbanDash();
    if (!dash) throw new Error("hermes: 没有可用的看板");
    const max = Number(opts?.max) > 0 ? Number(opts.max) : 8;
    const dryRun = opts?.dryRun ? "true" : "false";
    const { status, body } = await httpRequest(
      "POST",
      this._kanbanUrl(dash, `/dispatch?max=${max}&dry_run=${dryRun}`),
      { token: dash.token },
    );
    if (status >= 300) throw new Error(`hermes dispatch failed: ${status} ${body}`);
    let j = {};
    try { j = JSON.parse(body); } catch { /* tolerate empty body */ }
    return {
      claimed: Number(j.claimed || 0),
      spawned: Number(j.spawned || 0),
      spawnErrors: Number(j.spawn_errors || 0),
      oldestReadyAgeSeconds: typeof j.oldest_ready_age_seconds === "number" ? j.oldest_ready_age_seconds : undefined,
    };
  }

  async createTask(spec, opts) {
    const dash = this._kanbanDash();
    if (!dash) throw new Error("hermes: 没有可用的看板");
    const { status, body } = await httpRequest("POST", this._kanbanUrl(dash, `/tasks${kanbanBoardQ(opts)}`), {
      token: dash.token,
      body: {
        title: spec?.title || "(无标题)",
        body: spec?.body || undefined,
        assignee: spec?.assignee || undefined,
        priority: typeof spec?.priority === "number" ? spec.priority : 0,
        tenant: spec?.tenant || undefined,
        skills: Array.isArray(spec?.skills) && spec.skills.length ? spec.skills : undefined,
        goal_mode: spec?.goalMode || undefined,
        goal_max_turns: typeof spec?.goalMaxTurns === "number" ? spec.goalMaxTurns : undefined,
        // 工作区：scratch=完成即删（官方默认），worktree/dir=保留。只在非默认时送，
        // 与官方保持同样的小请求体（旧 dispatcher 忽略未知键更安全）。
        workspace_kind: spec?.workspaceKind && spec.workspaceKind !== "scratch" ? spec.workspaceKind : undefined,
        workspace_path: spec?.workspacePath || undefined,
        parents: Array.isArray(spec?.parents) && spec.parents.length ? spec.parents.map(String) : undefined,
        // triage=true 让上游把卡放进 triage 列（列 + 建卡时由调用方按列传）。
        triage: spec?.triage || undefined,
        model_override: spec?.modelOverride || undefined,
        provider_override: spec?.providerOverride || undefined,
      },
    });
    if (status >= 300) throw new Error(`hermes create task failed: ${status} ${body}`);
    const t = (JSON.parse(body).task) || {};
    const id = String(t.id ?? "");
    // The kanban POST /tasks API takes no status/column (only `triage`), so the
    // column the user picked in the create form has to be applied as a follow-up
    // move. Without it the task silently lands in the server's default column
    // while the UI reports success. (column == status in Hermes' kanban.)
    const wanted = spec?.status ?? spec?.column;
    if (id && typeof wanted === "string" && wanted && wanted !== t.status) {
      try {
        await this.updateTask(id, { status: wanted }, opts);
      } catch (err) {
        throw new Error(
          `hermes: 任务已创建(${id})，但移动到「${wanted}」列失败：${err?.message || err}`,
        );
      }
      return { id, title: t.title || spec?.title || "", column: wanted, backendId: "hermes" };
    }
    return {
      id,
      title: t.title || spec?.title || "",
      column: t.status || "",
      backendId: "hermes",
    };
  }

  async updateTask(id, patch, opts) {
    const dash = this._kanbanDash();
    if (!dash) throw new Error("hermes: 没有可用的看板");
    // 官方 UpdateTaskBody 没有 tenant/skills/goal_*（它们只在 CreateTaskBody 里）。
    // 上游 pydantic 会静默丢弃未知键 → "200 但没更新"（KAN-001）。响亮拒绝，
    // 不许静默丢数据。
    const createOnly = ["tenant", "skills", "goalMode", "goalMaxTurns"].filter((k) => patch?.[k] !== undefined);
    if (createOnly.length) {
      throw new Error(`hermes: ${createOnly.join("/")} 仅创建时可设置（官方 PATCH 不支持修改）`);
    }
    const upd = {};
    if (typeof patch?.title === "string") upd.title = patch.title;
    if (typeof patch?.body === "string") upd.body = patch.body;
    if (typeof patch?.assignee === "string") upd.assignee = patch.assignee;
    if (typeof patch?.priority === "number") upd.priority = patch.priority;
    // 完成摘要：官方把 status=done 的转换和 result/summary 一起 PATCH 过去
    // （complete_task 收下它们做结构化交接）。少了它 result 永远是空的。
    if (typeof patch?.result === "string") upd.result = patch.result;
    if (typeof patch?.summary === "string") upd.summary = patch.summary;
    if (patch?.metadata && typeof patch.metadata === "object") upd.metadata = patch.metadata;
    if (typeof patch?.blockReason === "string") upd.block_reason = patch.blockReason;
    // 模型覆盖：clear 必须显式送 true——PATCH 里 Optional[str]=None 表示"没传"，
    // 不是"设为 NULL"（官方 UpdateTaskBody 注释）。
    if (typeof patch?.modelOverride === "string") upd.model_override = patch.modelOverride;
    if (typeof patch?.providerOverride === "string") upd.provider_override = patch.providerOverride;
    if (patch?.clearModelOverride) upd.clear_model_override = true;
    // column == status in Hermes' kanban.
    const targetStatus = patch?.status ?? patch?.column;
    if (typeof targetStatus === "string") upd.status = targetStatus;
    const { status, body } = await httpRequest("PATCH", this._kanbanUrl(dash, `/tasks/${encodeURIComponent(id)}${kanbanBoardQ(opts)}`), {
      token: dash.token,
      body: upd,
    });
    if (status >= 300) throw new Error(kanbanDetail(body));
    return this.getTask(id, opts);
  }

  // Move a card to another column. Hermes column == status; position is ignored
  // (Hermes' kanban applies its own stable per-column ordering server-side).
  async moveTask(id, status, _position, opts) {
    const dash = this._kanbanDash();
    if (!dash) throw new Error("hermes: 没有可用的看板");
    if (typeof status !== "string" || !status) throw new Error("hermes moveTask: 缺少目标列");
    const patch = { status };
    // 移到 done 时官方强制带完成摘要（写进 result+summary）；调用方在 opts 里带上。
    if (typeof opts?.result === "string") patch.result = opts.result;
    if (typeof opts?.summary === "string") patch.summary = opts.summary;
    const { status: code, body } = await httpRequest(
      "PATCH",
      this._kanbanUrl(dash, `/tasks/${encodeURIComponent(id)}${kanbanBoardQ(opts)}`),
      { token: dash.token, body: patch },
    );
    if (code >= 300) throw new Error(kanbanDetail(body));
    return this.getTask(id, opts);
  }

  // 真删除：官方已提供 DELETE /tasks/{id}（早期版本没有，彼时本方法伪装成
  // PATCH archived——两个"归档"按钮的语义撞车即源于此，KAN-007/GAP-001）。
  // 软删除走 archiveTask。
  async deleteTask(id, opts) {
    const dash = this._kanbanDash();
    if (!dash) throw new Error("hermes: 没有可用的看板");
    const { status, body } = await httpRequest("DELETE", this._kanbanUrl(dash, `/tasks/${encodeURIComponent(id)}${kanbanBoardQ(opts)}`), {
      token: dash.token,
    });
    if (status >= 300) throw new Error(`hermes delete task failed: ${status} ${body}`);
  }

  // Archive drops the card off the visible board (status "archived"); un-archive
  // returns it to "todo". Hard delete is deleteTask (official DELETE verb).
  async archiveTask(id, archived = true, opts) {
    const dash = this._kanbanDash();
    if (!dash) throw new Error("hermes: 没有可用的看板");
    const { status: code, body } = await httpRequest(
      "PATCH",
      this._kanbanUrl(dash, `/tasks/${encodeURIComponent(id)}${kanbanBoardQ(opts)}`),
      { token: dash.token, body: { status: archived ? "archived" : "todo" } },
    );
    if (code >= 300) throw new Error(`hermes ${archived ? "archive" : "unarchive"} task failed: ${code} ${body}`);
    return this.getTask(id, opts);
  }

  // ---- agents (management UI) ----
  // Reuse the profile-derived agent list, shaped as UnifiedAgent[].
  async listAgents() {
    const local = this._getConfig().hermesMode !== "remote";
    return sortAgentsByCreatedAt(this.getAgents().map((a) => {
      const profile = this.profileById.get(a.id);
      return {
        id: a.id,
        name: a.name,
        kanbanAssignee: profile || undefined,
        model: a.model || undefined,
        provider: a.provider || undefined,
        createdAt: local && profile ? dirCreatedAtMs(hermesHomeForProfile(profile)) : null,
        backendId: "hermes",
      };
    }));
  }

  _defaultDash() {
    return this.dashboards.get("default") || [...this.dashboards.values()][0] || null;
  }

  // 统一产生可诊断的 dashboard 缺失错误，避免调用方只看到 null.baseUrl TypeError。
  _requireDashboard(dash, operation) {
    if (!dash) throw new Error(`hermes: ${operation} 失败，没有可用的 dashboard`);
    return dash;
  }

  async getAgent(id) {
    const a = this.agents.find((x) => x.id === id);
    const profile = this.profileById.get(id);
    if (!a || !profile) throw new Error(`hermes: 未找到 agent ${id}`);
    return {
      id: a.id,
      name: a.name,
      model: a.model || undefined,
      provider: a.provider || undefined,
      profile,
      workspace: `~/.hermes/profiles/${profile}`,
      files: [{ name: "SOUL.md" }],
      backendId: "hermes",
    };
  }

  async createAgent(spec) {
    const dash = this._defaultDash();
    if (!dash) throw new Error("hermes: 没有可用的 dashboard");
    if (!spec?.name) throw new Error("hermes: 创建 profile 需要 name");
    this._assertProfileIdentityAvailable(spec.name);
    const { status, body } = await httpRequest("POST", `${dash.baseUrl}/api/profiles`, {
      token: dash.token,
      body: {
        name: spec.name,
        clone_from_default: !!spec.cloneFromDefault,
        no_skills: !!spec.noSkills,
      },
    });
    if (status >= 300) throw new Error(`hermes create profile failed: ${status} ${body}`);
    await this._refreshAgentsFor(dash).catch(() => {});
    return { ok: true, name: spec.name };
  }

  // Hermes profiles support rename here; model is set via the 模型 page, SOUL via files.
  async updateAgent(id, patch) {
    const profile = this.profileById.get(id);
    if (!profile) throw new Error(`hermes: 未找到 agent ${id}`);
    const newName = typeof patch?.name === "string" ? patch.name.trim() : "";
    if (newName && newName !== profile) {
      this._assertProfileIdentityAvailable(newName, profile);
      const dash = this._requireDashboard(this._defaultDash(), "重命名 profile");
      const { status, body } = await httpRequest(
        "PATCH",
        `${dash.baseUrl}/api/profiles/${encodeURIComponent(profile)}`,
        { token: dash.token, body: { new_name: newName } },
      );
      if (status >= 300) throw new Error(`hermes rename profile failed: ${status} ${body}`);
      await this._refreshAgentsFor(dash).catch(() => {});
      // The agent id is derived from the profile name, so a rename re-keys it.
      // Hand the new id back — the old one no longer resolves.
      return { ok: true, id: agentIdForProfile(newName) };
    }
    return { ok: true, id };
  }

  async deleteAgent(id) {
    const profile = this.profileById.get(id);
    if (!profile) throw new Error(`hermes: 未找到 agent ${id}`);
    if (profile === "default") throw new Error("hermes: 不能删除 default profile");
    const dash = this._requireDashboard(this._defaultDash(), "删除 profile");
    const { status, body } = await httpRequest(
      "DELETE",
      `${dash.baseUrl}/api/profiles/${encodeURIComponent(profile)}`,
      { token: dash.token },
    );
    if (status >= 300) throw new Error(`hermes delete profile failed: ${status} ${body}`);
    await this._refreshAgentsFor(dash).catch(() => {});
  }

  async listAgentFiles() {
    return [{ name: "SOUL.md" }];
  }

  async getAgentFile(id) {
    const profile = this.profileById.get(id);
    if (!profile) throw new Error(`hermes: 未找到 agent ${id}`);
    const dash = this._requireDashboard(
      this.dashboards.get(profile) || this._defaultDash(),
      "读取 agent 文件",
    );
    const { status, body } = await httpGet(
      `${dash.baseUrl}/api/profiles/${encodeURIComponent(profile)}/soul`,
      { token: dash.token },
    );
    if (status !== 200) return { name: "SOUL.md", content: "", missing: true };
    const j = JSON.parse(body);
    return { name: "SOUL.md", content: j.content || "", missing: j.exists === false };
  }

  async setAgentFile(id, _file, content) {
    const profile = this.profileById.get(id);
    if (!profile) throw new Error(`hermes: 未找到 agent ${id}`);
    const dash = this._requireDashboard(
      this.dashboards.get(profile) || this._defaultDash(),
      "写入 agent 文件",
    );
    const { status, body } = await httpRequest(
      "PUT",
      `${dash.baseUrl}/api/profiles/${encodeURIComponent(profile)}/soul`,
      { token: dash.token, body: { content } },
    );
    if (status >= 300) throw new Error(`hermes set soul failed: ${status} ${body}`);
    return { ok: true };
  }

  // 设置页与版本检查共用 dashboard 探测，避免同一字段在两处用不同口径解析。
  // 单飞：UI 首屏 status 拉取与 45s 健康采样共享同一轮探测
  _dashboardStatusIdentityIsCurrent(generation, topology) {
    return generation === this._lifecycleGeneration && !this._dashboardTopologyChanged(topology);
  }

  async _getDashboardStatusSnapshot() {
    const generation = this._lifecycleGeneration;
    const existing = this._statusRowsInFlight;
    if (
      existing
      && existing.generation === generation
      && this._dashboardStatusIdentityIsCurrent(generation, existing.topology)
    ) {
      return existing.promise;
    }

    // 与模型目录的拓扑屏障同一身份口径：profile 集、对象引用、baseUrl、token。
    // token/baseUrl 可能在对象上原地更新，不能只保存 dashboard 引用。
    const topology = new Map(
      [...this.dashboards.entries()].map(([profile, dashboard]) => [
        profile,
        {
          ref: dashboard,
          baseUrl: dashboard?.baseUrl,
          token: dashboard?.token,
        },
      ]),
    );
    const dashboardEntries = [...topology.entries()].map(([profile, identity]) => [
      profile,
      identity.ref,
    ]);
    let promise;
    promise = this._computeDashboardStatusRows(dashboardEntries)
      .then((rows) => {
        const stale = !this._dashboardStatusIdentityIsCurrent(generation, topology);
        return {
          rows: stale ? [] : rows,
          stale,
          generation,
        };
      })
      .finally(() => {
        // 旧 lifecycle/身份的请求可能晚于新请求结束；只允许拥有当前槽位的
        // promise 清理自己，绝不能把新一代的单飞句柄置空。
        if (this._statusRowsInFlight?.promise === promise) this._statusRowsInFlight = null;
      });
    this._statusRowsInFlight = { generation, topology, promise };
    return promise;
  }

  // 既有内部调用只消费 dashboard 行；getStatus 额外读取 snapshot.stale，避免把
  // lifecycle 失效产生的空行误当成本地启动失败并触发自愈重启。
  async _getDashboardStatusRows() {
    const snapshot = await this._getDashboardStatusSnapshot();
    return snapshot.rows;
  }

  async _computeDashboardStatusRows(dashboardEntries = [...this.dashboards.entries()]) {
    const dashboards = [];
    await Promise.all(
      dashboardEntries.map(async ([profile, d]) => {
        let connected = false;
        let version;
        try {
          const { status, body } = await httpGet(`${d.baseUrl}/api/status`, {
            token: d.token,
          });
          connected = status === 200;
          if (connected) {
            try {
              const j = JSON.parse(body);
              version = j.version || j.hermes_version || undefined;
            } catch {
              /* non-JSON status */
            }
          }
        } catch {
          /* dashboard unreachable */
        }
        dashboards.push({ profile, port: d.port || 0, baseUrl: d.baseUrl, connected, version });
      }),
    );
    dashboards.sort((a, b) => a.profile.localeCompare(b.profile));
    return dashboards;
  }

  // ---- status (management UI / 设置) ----
  // Per-profile dashboards are the "instances"; ping each /api/status.
  async getStatus() {
    const { rows: dashboards, stale } = await this._getDashboardStatusSnapshot();
    const mode = this._getConfig().hermesMode === "remote" ? "remote" : "local";
    const connected = dashboards.some((d) => d.connected);
    const connectedProfiles = new Set(
      dashboards.filter((dashboard) => dashboard.connected).map((dashboard) => dashboard.profile),
    );
    const readyAgentIds = [...this.profileById.entries()]
      .filter(([, profile]) => connectedProfiles.has(profile))
      .map(([agentId]) => agentId);
    const info = { mode, profiles: dashboards.length, dashboards, readyAgentIds };
    if (this.profileIdentityCollisions.length) {
      info.profileIdentityCollisions = this.profileIdentityCollisions.map((row) => ({
        agentId: row.agentId,
        profiles: [...row.profiles],
      }));
    }
    if (!connected) {
      if (stale) {
        // stop/reconfigure 或 dashboard 身份切换后的迟到结果只负责 fail closed；
        // 它不是一次当前 lifecycle 的“未检测到”，不得启动任何恢复动作。
      } else if (this._startingAt) {
        // spawn→ready 的启动窗（含重试）：结构化 starting 让 UI 显示「检测中」
        // 而不是报错——首启用户在正常等待期看到「未检测到」会误以为已失败。
        info.starting = true;
      } else {
        // 失败原因透出为 info.error（契约见 agent-backend.js getStatus）：
        // SetupOverlay 靠文本分类给「装 CLI / 连远程」指引，缺了只能干瞪红点。
        info.error =
          this.lastError ||
          (dashboards.length > 0
            ? mode === "remote"
              ? "远程 dashboard 无响应（连接失败或超时）"
              : "本地 dashboard 无响应"
            : mode === "remote"
              ? "remote 模式未配置任何远程 dashboard"
              : "未检测到本机 Hermes dashboard");
        // 自愈：local start 失败后 dashboards 为空且没有定时器兜底——借设置页/
        // 首启浮层的 status 轮询驱动重试，装好 CLI 后卡片才能真的「自动变绿」。
        if (mode === "local" && dashboards.length === 0) this._retryStartSoon();
      }
    }
    return { id: this.id, name: this.name, connected, info };
  }

  // 单飞 + 冷却的后台重启；由 getStatus 轮询触发，不自建定时器。
  _retryStartSoon() {
    if (this._restartInFlight || Date.now() - this._lastRestartAt < RESTART_COOLDOWN_MS) return;
    this._lastRestartAt = Date.now();
    this._restartInFlight = this.start()
      .catch(() => {})
      .finally(() => {
        this._restartInFlight = null;
      });
  }

  async _getDashboardUpdateInfo(dash) {
    try {
      const { status, body } = await this._dashGet(
        dash,
        "/api/hermes/update/check?force=true",
        { timeoutMs: 15000 },
      );
      if (status !== 200) return { error: `Hermes update check failed: HTTP ${status}` };

      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return { error: "Hermes update check returned invalid JSON" };
      }

      const current = String(parsed?.current_version || "").trim() || undefined;
      const behind = parsed?.behind;
      if (typeof behind !== "number" || !Number.isFinite(behind)) {
        return {
          ...(current ? { current } : {}),
          error: parsed?.message || "Hermes update check unavailable",
        };
      }
      return {
        ...(current ? { current } : {}),
        updateAvailable: behind !== 0,
      };
    } catch (err) {
      return { error: err?.message || String(err) };
    }
  }

  // 更新判断以 dashboard 的官方 Git 检查为准；展示版本和日志链接由 registry 从 PyPI/GitHub 补齐。
  async getVersionInfo() {
    const dashboards = await this._getDashboardStatusRows();
    const connected = dashboards.filter((dashboard) => dashboard.connected);
    const updates = new Map();
    const mode = this._getConfig().hermesMode === "remote" ? "remote" : "local";

    if (mode === "local" && connected.length > 0) {
      // 本地 profile 共用同一份 Hermes 安装，只向官方源检查一次。
      const representative = this.dashboards.get(connected[0].profile);
      const update = representative
        ? await this._getDashboardUpdateInfo(representative)
        : { error: "Hermes dashboard unavailable" };
      for (const dashboard of connected) updates.set(dashboard.profile, update);
    } else {
      await Promise.all(
        connected.map(async (dashboard) => {
          const descriptor = this.dashboards.get(dashboard.profile);
          const update = descriptor
            ? await this._getDashboardUpdateInfo(descriptor)
            : { error: "Hermes dashboard unavailable" };
          updates.set(dashboard.profile, update);
        }),
      );
    }

    const versionDashboards = dashboards.map((dashboard) => {
      const update = updates.get(dashboard.profile);
      const current = update?.current || dashboard.version;
      return {
        profile: dashboard.profile,
        port: dashboard.port,
        baseUrl: dashboard.baseUrl,
        connected: dashboard.connected,
        ...(current ? { current } : {}),
        ...(typeof update?.updateAvailable === "boolean"
          ? { updateAvailable: update.updateAvailable }
          : {}),
        ...(update?.error ? { error: update.error } : {}),
      };
    });
    const versions = [
      ...new Set(
        versionDashboards
          .filter((dashboard) => dashboard.connected && dashboard.current)
          .map((dashboard) => String(dashboard.current)),
      ),
    ];
    const connectedVersions = versionDashboards.filter((dashboard) => dashboard.connected);
    const anyUpdate = connectedVersions.some((dashboard) => dashboard.updateAvailable === true);
    const allCompared = connectedVersions.length > 0
      && connectedVersions.every((dashboard) => typeof dashboard.updateAvailable === "boolean");
    const updateAvailable = anyUpdate ? true : allCompared ? false : undefined;
    const updateError = connectedVersions.find((dashboard) => dashboard.error)?.error;
    return {
      id: this.id,
      name: this.name,
      current: versions.length === 1 ? versions[0] : undefined,
      currentSource: "dashboard",
      ...(typeof updateAvailable === "boolean" ? { updateAvailable } : {}),
      ...(updateAvailable !== true && updateError ? { error: updateError } : {}),
      dashboards: versionDashboards,
    };
  }

  // ---- self-update（设置页「立即更新」，契约见 agent-backend.js）----
  // remote 模式连的是别处的 dashboard，本机 `hermes update` 更新不到它们。
  runSelfUpdate() {
    if (this._getConfig().hermesMode === "remote") return { supported: false, reason: "remote" };
    return { supported: true, actions: ["update"], status: this._selfUpdater.run() };
  }

  getSelfUpdateStatus() {
    if (this._getConfig().hermesMode === "remote") return { supported: false, reason: "remote" };
    return { supported: true, actions: ["update"], status: this._selfUpdater.status() };
  }

  /** Async dispatcher: synthetic "main" → empty seed; historical → fetched from the right dashboard. */
  /**
   * Create a fresh empty session for a Hermes agent — intercepts UI's
   * `sessions.create` so it doesn't hit OpenClaw (which doesn't know hermes-*
   * agents). Return the transport's canonical stored id so the later REST row
   * converges on the same identity (ACP persists at session/new; gateway may
   * expose its row only after the first accepted prompt).
   * @param {string} agentId  e.g. "hermes-default"
   * @param {{model?: string, provider?: string, acpProviderRef?: string, workspace?: string|null, freezeWorkspace?: boolean}} [options]
   * @returns {Promise<string>} canonical new sessionKey
   */
  async createSession(agentId, options = {}) {
    const profile = this.profileById.get(agentId);
    if (!profile) throw new Error(`hermes-backend: unknown agent ${agentId}`);
    const dash = this.dashboards.get(profile);
    if (!dash) throw new Error(`hermes: 未找到 agent ${agentId} 的 dashboard`);
    const generation = this._lifecycleGeneration;
    const model = String(options?.model || "").trim();
    const provider = String(options?.provider || "").trim();
    const acpProviderRef = String(options?.acpProviderRef || "").trim();
    const workspace = options?.workspace == null ? null : options.workspace;
    const freezeWorkspace = options?.freezeWorkspace === true;
    if (workspace !== null && (typeof workspace !== "string" || !path.isAbsolute(workspace)
      || !workspace.isWellFormed() || workspace.includes("\0"))) {
      throw new Error("hermes: 工作目录必须为绝对路径");
    }

    if (this._gatewayChatEnabled(profile)) {
      const sock = this._gwSocket(profile, dash);
      let res;
      try {
        res = await sock.request("session.create", {
          cols: GW_COLS,
          source: GW_SOURCE,
          ...(model ? { model } : {}),
          ...(provider ? { provider } : {}),
          ...(workspace !== null ? { cwd: workspace } : {}),
        });
      } catch (err) {
        // A served JSON-RPC error is authoritative. Only transport failure may
        // fall back to the existing ACP channel.
        if (err?.jsonRpc === true) throw err;
        this.gwChatDisabledUntil.set(profile, Date.now() + GW_CHAT_RETRY_MS);
        console.warn(`[hermes] profile ${profile}: 新会话网关不可用（${err?.message || err}），回落 ACP`);
        res = null;
      }
      if (res) {
        if (generation !== this._lifecycleGeneration) {
          throw new Error("hermes: 会话创建期间连接配置已变化，请重试");
        }
        const runtimeId = String(res.session_id || "");
        const storedId = String(res.stored_session_id || "");
        if (!runtimeId || !storedId) {
          throw new Error("hermes: 新会话响应缺少 session_id/stored_session_id");
        }
        let actualWorkspace = typeof res.info?.cwd === "string" ? res.info.cwd : null;
        if (freezeWorkspace || workspace !== null) {
          try {
            if (!actualWorkspace || !path.isAbsolute(actualWorkspace)
              || (workspace !== null && actualWorkspace !== workspace)) {
              throw new Error("hermes: 网关未确认请求的工作目录");
            }
            if (workspace === null) {
              // Make the actual default explicit for this session only. A
              // profile/global cwd change must not move a prepared execution.
              const frozen = await sock.request("session.cwd.set", {
                session_id: runtimeId, cwd: actualWorkspace,
              });
              if (frozen?.cwd !== actualWorkspace) throw new Error("hermes: 会话工作目录冻结失败");
            }
            if (generation !== this._lifecycleGeneration) throw new Error("hermes: 会话创建期间连接配置已变化，请重试");
          } catch (error) {
            await sock.request("session.close", { session_id: runtimeId }).catch(() => {});
            throw error;
          }
        }
        const sessionKey = `agent:${agentId}:${storedId}`;
        this.transcripts.set(sessionKey, []);
        this.gwRuntimeByKey.set(sessionKey, {
          profile,
          runtimeId,
          storedId,
          generation: sock.generation,
          resumed: false,
          agentBuilt: res?.info?.lazy !== true,
        });
        this.gwKeyByRuntime.set(runtimeId, sessionKey);
        this.freshSessionKeys.add(sessionKey);
        this.freshSessionTransports.set(sessionKey, "gateway");
        if (actualWorkspace && path.isAbsolute(actualWorkspace)) {
          this.sessionWorkspaceByKey.set(sessionKey, actualWorkspace);
        }
        return sessionKey;
      }
    }

    const client = this._clientForProfile(profile);
    const acpWorkspace = workspace ?? os.tmpdir();
    if (workspace !== null && !fs.statSync(acpWorkspace).isDirectory()) {
      throw new Error("hermes: 工作目录不存在");
    }
    const acpSessionId = String(await client.newSession(acpWorkspace) || "");
    if (!acpSessionId) throw new Error("hermes: ACP 新会话未返回 sessionId");
    try {
      if (generation !== this._lifecycleGeneration) {
        throw new Error("hermes: 会话创建期间连接配置已变化，请重试");
      }
      // ACP session/new persists immediately. Apply the inherited model before
      // exposing the key, and remove that durable row if setup fails.
      if (model) {
        await client.setSessionModel(
          acpSessionId,
          this._acpModelRef(model, provider, acpProviderRef),
        );
      }
      if (generation !== this._lifecycleGeneration) {
        throw new Error("hermes: 会话创建期间连接配置已变化，请重试");
      }
      const sessionKey = `agent:${agentId}:${acpSessionId}`;
      this.transcripts.set(sessionKey, []);
      this.acpSessionByKey.set(sessionKey, { profile, acpSessionId });
      this.freshSessionKeys.add(sessionKey);
      this.freshSessionTransports.set(sessionKey, "acp");
      this.sessionWorkspaceByKey.set(sessionKey, acpWorkspace);
      return sessionKey;
    } catch (err) {
      await this._deleteServerSession(dash, acpSessionId).catch((cleanupErr) => {
        console.warn(
          `[hermes] ACP 新会话 ${acpSessionId} 初始化失败后的清理也失败：${cleanupErr?.message || cleanupErr}`,
        );
      });
      throw err;
    }
  }

  async getHistory(sessionKey) {
    const generation = this._lifecycleGeneration;
    if (!this.transcripts.has(sessionKey)) {
      const tail = String(sessionKey || "").split(":").slice(2).join(":") || "main";
      // ":main" and eagerly-created keys bind to their stored session through
      // gateway/ACP mappings. Resolving the server id here lets post-final cache
      // invalidation refetch canonical history (including tool/thinking rows).
      const serverTail = this._serverSessionId(sessionKey, tail);
      const seed = serverTail === "main" ? [] : this._stitchLastFinalMeta(sessionKey, await this._fetchHistoricalMessages(sessionKey, serverTail));
      // 历史读取跨过 stop/reconfigure 时明确失败且不缓存，下一代可重新读取。
      if (generation !== this._lifecycleGeneration) {
        throw new Error("hermes: history lifecycle changed while loading");
      }
      this.transcripts.set(sessionKey, seed);
    }
    const messages = this.transcripts.get(sessionKey);
    // Stamp a stable local id on any message still lacking one — live-appended turns
    // (transcript.push in _sendMessageInner) have no dashboard autoincrement id yet.
    // Index-based + written once (the `!m.id` guard) so it stays put across the repeated
    // chat.history reloads a session does; re-minting per call would break the UI's pin /
    // local-hide persistence. Historical rows already carry `hermes-msg-<id>` and are skipped.
    messages.forEach((m, i) => {
      if (!m.id) m.id = `hermes-local-${i}`;
    });
    return { messages };
  }

  // Parse "agent:<id>:<tail>" → { agentId, tail, profile, dash }. Throws when the
  // agent isn't ours or its dashboard is gone (callers surface the message as-is).
  _sessionTarget(sessionKey) {
    const m = /^agent:([^:]+):(.+)$/.exec(String(sessionKey || ""));
    if (!m) throw new Error(`hermes: 非法会话 key ${sessionKey}`);
    const [, agentId, tail] = m;
    const profile = this.profileById.get(agentId);
    const dash = profile ? this.dashboards.get(profile) : null;
    if (!dash) throw new Error(`hermes: 未找到 agent ${agentId} 的 dashboard`);
    return { agentId, tail, profile, dash };
  }

  // The server-side session id for a key. New gateway/ACP sessions now use the
  // canonical stored id in the key and preload their runtime mapping; historical
  // keys carry the real id in the tail and have no mapping.
  _serverSessionId(sessionKey, tail) {
    return (
      this.gwRuntimeByKey.get(sessionKey)?.storedId ||
      this.acpSessionByKey.get(sessionKey)?.acpSessionId ||
      tail
    );
  }

  // ACP model refs use `provider:model`, except user-defined providers which
  // require `custom:<slug>:<model>`. Prefer the catalog-carried transport ref;
  // callers may also pass it explicitly when inheriting a selected model.
  _acpModelRef(model, provider, explicitRef) {
    const modelId = String(model || "").trim();
    const providerId = String(provider || "").trim();
    const catalogRef = providerId
      ? this.modelChoices.find((choice) =>
        choice?.id === modelId && choice?.provider === providerId)?.acpProviderRef
      : "";
    const providerRef = String(explicitRef || catalogRef || providerId || "").trim();
    return providerRef ? `${providerRef}:${modelId}` : modelId;
  }

  async _deleteServerSession(dash, serverId) {
    const { status, body } = await httpRequest(
      "DELETE",
      `${dash.baseUrl}/api/sessions/${encodeURIComponent(serverId)}`,
      { token: dash.token },
    );
    // 404 = already gone server-side; callers still clear their local state.
    if (status >= 300 && status !== 404) {
      throw new Error(`hermes delete session failed: ${status} ${body}`);
    }
  }

  // Switch a session's model = `config.set` on the dashboard's /api/ws JSON-RPC
  // (what the official Hermes desktop app drives), NOT a `/model` message on the
  // chat stream.
  //
  // Two reasons the chat-stream route is wrong. It needs a live ACP session, so
  // an agent whose configured provider is broken can never be repaired from the
  // UI — the one case where switching IS the fix (2026-07-24: three profiles
  // pinned to a deleted `xiaomi` provider, every send died in session/new). And
  // REST can't stand in: /api/model/set only takes scope main|auxiliary, so it
  // cannot target a session at all.
  //
  // `--provider` matters beyond disambiguation: Hermes only force-builds the
  // agent first when no explicit provider is given (tui_gateway/server.py), so
  // passing it keeps the switch off that door. The flip side is that the agent
  // must ALREADY be built — with agent None the gateway pins the override in
  // memory and answers ok without persisting anything (see _gwRequireAgent).
  async setSessionModel(sessionKey, opts = {}) {
    const model = String(opts.model || "").trim();
    if (!model) throw new Error("hermes: 缺少 model");
    const freshTransport = this.freshSessionTransports.get(sessionKey);
    if (freshTransport === "acp") {
      const mapping = this.acpSessionByKey.get(sessionKey);
      if (!mapping) {
        throw new Error("hermes: 新会话的 ACP 连接已失效，请重新创建会话");
      }
      const generation = this._lifecycleGeneration;
      const provider = String(opts.provider || "").trim();
      const acpProviderRef = String(opts.acpProviderRef || "").trim();
      const client = this._clientForProfile(mapping.profile);
      await client.setSessionModel(
        mapping.acpSessionId,
        this._acpModelRef(model, provider, acpProviderRef),
      );
      if (generation !== this._lifecycleGeneration) {
        throw new Error("hermes: 模型切换期间连接配置已变化，请重试");
      }
      const meta = this.sessionLiveMeta.get(sessionKey) || {};
      meta.model = model;
      if (provider) meta.provider = provider;
      this.sessionLiveMeta.set(sessionKey, meta);
      this._applyLiveMetaToRow(sessionKey);
      return { model, scope: "session" };
    }
    // 切模型 = **会话级覆写**，对齐官方桌面（use-model-controls.ts 永远发
    // `--session` + 显式 `--provider` + 打到 live session_id，从不写 profile 全局
    // 默认）。旧实现在没 live session 时降级 `--global`（只改 config.yaml
    // model.default），是这个 bug 的根源：Hermes 的模型解析里 session 的
    // `model_override`（非 None）**完胜** config.default，`_sync_agent_model_with_config`
    // 见到 override 就 early-return 拒绝采纳新默认（server.py:3687-3694）；而 resume
    // 历史会话会从 state.db 重建陈旧 override（如失效的 xiaomi/mimo-v2.5-pro），于是
    // 「config 一样、每个会话报各自旧 provider 的错」。
    //
    // 正解（三点缺一不可）：① 建/复用 runtime session（_gwEnsureRuntime：历史 resume /
    // main·fresh create，都是 lazy build，不依赖坏 agent 可初始化 → 守 R279）；② 打到
    // 该 live session_id 发 `--session`，**覆写** session["model_override"]（立刻遮蔽
    // 陈旧旧模型，且切换成功即 _persist_live_session_runtime 落 state.db，重启后 resume
    // 恢复的是新值）；③ 带显式 `--provider` 让网关跳过「在当前(可能已坏的)provider 上
    // 先 build agent」那道门（server.py:12307）——凭证失效但 provider 还在 config 里的
    // 会话照样切得成（构造 client 不校验 key）；provider 整个没了的会话另说，见 ⑤。
    // setSessionModel 与 sendMessage 共享 gwRuntimeByKey，切完发消息即用新 override。
    // ④ `eagerBuild`：resume 必须把 agent 一并建出来，否则 override 只钉在内存里、
    // 被随后的延迟构建按 state.db 的陈旧身份覆盖（见 _gwEnsureRuntime 注释）。
    const { m, sock } = await this._gwEnsureRuntime(sessionKey, { allowCreate: true, eagerBuild: true });
    // ⑤ agent 没建出来就别发了：那样只会拿到一个「回 ok 但什么都没落」的假成功（R303）。
    await this._gwRequireAgent(m, sock);
    let result;
    try {
      result = await sock.request("config.set", {
        session_id: m.runtimeId,
        key: "model",
        value: modelSwitchValue(model, opts.provider, "session"),
      });
    } catch (err) {
      // 4009 = 轮次进行中的服务端忙守卫（官方桌面同款拒绝）。
      if (err?.code === 4009) throw new Error("当前轮次仍在进行，请等本轮结束后再切换模型。");
      throw err;
    }
    // 会话级覆写即时反映到会话行的 live 模型（footer / 模型胶囊）。
    const meta = this.sessionLiveMeta.get(sessionKey) || {};
    meta.model = model;
    if (opts.provider) meta.provider = opts.provider;
    this.sessionLiveMeta.set(sessionKey, meta);
    this._applyLiveMetaToRow(sessionKey);
    return {
      model: String(result?.value || model),
      scope: "session",
      warning: String(result?.warning || "") || undefined,
    };
  }

  // Shared config.set relay for session-scoped controls (reasoning/fast).
  // 与 setSessionModel 同款根治：建/复用 live session（_gwEnsureRuntime）再打到该
  // session_id，写**会话级** override。旧实现在没 live session 时 session_id="" →
  // 网关 throwaway 分支只改 config 全局默认，会被会话自身的陈旧 reasoning/fast
  // override 遮蔽（同 model 的遮蔽机理）→「切了当前会话不生效」。
  async _sessionConfigSet(sessionKey, key, value) {
    // eagerBuild 同 setSessionModel：agent 没建出来时 reasoning/fast 也只是钉在内存的
    // create_*_override，同样被 resume_runtime_overrides 分支丢掉。
    const { m, sock } = await this._gwEnsureRuntime(sessionKey, { allowCreate: true, eagerBuild: true });
    await this._gwRequireAgent(m, sock);
    let result;
    try {
      result = await sock.request("config.set", { session_id: m.runtimeId, key, value });
    } catch (err) {
      if (err?.code === 4009) throw new Error("当前轮次仍在进行，请等本轮结束后再切换。");
      throw err;
    }
    return { result, scope: "session" };
  }

  // Set the session's reasoning effort. "none" disables thinking (the official
  // Thinking toggle's sentinel); null/empty resets to the default (medium).
  // proxy routes the UI's sessions.patch {thinkingLevel} here.
  async setSessionThinking(sessionKey, opts = {}) {
    const level = String(opts.level ?? "").trim() || "medium";
    if (!HERMES_THINKING_LEVELS.includes(level)) {
      throw new Error(`hermes: 未知思考档「${level}」`);
    }
    const { scope } = await this._sessionConfigSet(sessionKey, "reasoning", level);
    const meta = this.sessionLiveMeta.get(sessionKey) || {};
    meta.reasoningEffort = level;
    this.sessionLiveMeta.set(sessionKey, meta);
    this._applyLiveMetaToRow(sessionKey);
    return { level, scope };
  }

  // Toggle fast mode (the service-tier request param — 官方 ⚡ 的 param 型；
  // `-fast` variant 型模型走普通换模型，无需此方法)。proxy routes the UI's
  // sessions.patch {fastMode} here.
  async setSessionFast(sessionKey, opts = {}) {
    const fast = opts.fast === true;
    const { scope } = await this._sessionConfigSet(sessionKey, "fast", fast ? "fast" : "normal");
    const meta = this.sessionLiveMeta.get(sessionKey) || {};
    meta.fast = fast;
    this.sessionLiveMeta.set(sessionKey, meta);
    return { fast, scope };
  }

  async setSessionPermission(sessionKey, opts = {}) {
    const mode = String(opts.mode || "").trim();
    if (!["inherit", "yolo"].includes(mode)) {
      throw new Error(`hermes: 未知权限模式「${mode}」`);
    }
    const { scope } = await this._sessionConfigSet(sessionKey, "yolo", mode === "yolo" ? "1" : "0");
    const meta = this.sessionLiveMeta.get(sessionKey) || {};
    meta.permissionMode = mode;
    this.sessionLiveMeta.set(sessionKey, meta);
    this._applyLiveMetaToRow(sessionKey);
    return { mode, scope };
  }

  // Rename a session = PATCH /api/sessions/{id} {title}. The synthetic "main"
  // aggregate and locally-minted (not yet persisted) sessions have no Hermes
  // record to rename — fail with a legible reason instead of a silent no-op.
  async renameSession(sessionKey, label) {
    const { tail, dash } = this._sessionTarget(sessionKey);
    if (tail === "main") throw new Error("hermes: 主会话是聚合占位，不支持重命名");
    if (this.freshSessionKeys.has(sessionKey)) {
      throw new Error("hermes: 该会话还没有任何消息，发送一条后才能重命名");
    }
    const serverId = this._serverSessionId(sessionKey, tail);
    const { status, body } = await httpRequest(
      "PATCH",
      `${dash.baseUrl}/api/sessions/${encodeURIComponent(serverId)}`,
      { token: dash.token, body: { title: String(label ?? "").trim() } },
    );
    if (status >= 300) throw new Error(`hermes rename session failed: ${status} ${body}`);
    await this.refreshSessions().catch(() => {});
  }

  // Delete a session = DELETE /api/sessions/{id}. Gateway fresh mints remain
  // local-only until prompt.submit accepts them; ACP session/new persists
  // immediately and must therefore be deleted server-side even before send.
  // Always clears local chat state so the UI's row removal sticks.
  async deleteSession(sessionKey) {
    const { tail, dash } = this._sessionTarget(sessionKey);
    if (tail === "main") throw new Error("hermes: 主会话是聚合占位，不支持删除");
    const localOnly =
      this.freshSessionKeys.has(sessionKey)
      && this.freshSessionTransports.get(sessionKey) === "gateway";
    if (!localOnly) {
      const serverId = this._serverSessionId(sessionKey, tail);
      await this._deleteServerSession(dash, serverId);
    }
    this.freshSessionKeys.delete(sessionKey);
    this.freshSessionTransports.delete(sessionKey);
    this.sessionWorkspaceByKey.delete(sessionKey);
    this.transcripts.delete(sessionKey);
    this.acpSessionByKey.delete(sessionKey);
    this.sendQueues.delete(sessionKey);
    const gw = this.gwRuntimeByKey.get(sessionKey);
    if (gw) {
      this.gwKeyByRuntime.delete(gw.runtimeId);
      this.gwRuntimeByKey.delete(sessionKey);
    }
    this.sessionLiveMeta.delete(sessionKey);
    this.gwUsageByKey.delete(sessionKey);
    this.gwLastFinalMeta?.delete?.(sessionKey);
    this.sessionRows = this.sessionRows.filter((r) => r.key !== sessionKey);
    if (!localOnly) await this.refreshSessions().catch(() => {});
  }

  // Stop the in-flight turn for a session (UI Stop button / chat.abort).
  // Gateway sessions → session.interrupt (the turn then completes with
  // status "interrupted"). ACP fallback → session/cancel notification; the
  // running prompt resolves with stopReason "cancelled".
  async abortChat(sessionKey) {
    const gw = this.gwRuntimeByKey.get(sessionKey);
    const sock = gw ? this.gwSockets.get(gw.profile) : null;
    if (gw && sock && this.gwTurns.has(gw.runtimeId)) {
      try {
        await sock.request("session.interrupt", { session_id: gw.runtimeId });
        return;
      } catch (err) {
        console.warn(`[hermes] session.interrupt failed (${sessionKey}):`, err?.message || err);
      }
    }
    const mapping = this.acpSessionByKey.get(sessionKey);
    if (!mapping) return; // nothing in flight (or process already gone)
    const client = this.acpClients.get(mapping.profile);
    if (client) client.cancel(mapping.acpSessionId);
  }

  async getCliUsage() {
    if (this._getConfig().hermesMode === "remote") {
      return { supported: false, reason: "remote", commands: {} };
    }
    const generation = this._lifecycleGeneration;
    // Signature reads now yield too, so cold callers must share the whole scan.
    if (!this._cliUsageCache) {
      if (this._cliUsageScanInFlight) {
        return this._readToolUsageInCurrentScope("getCliUsage", generation, this._cliUsageScanInFlight);
      }
      const tracked = this._getLocalCliUsage().finally(() => {
        if (this._cliUsageScanInFlight === tracked) this._cliUsageScanInFlight = null;
      });
      this._cliUsageScanInFlight = tracked;
      return this._readToolUsageInCurrentScope("getCliUsage", generation, tracked);
    }
    return this._readToolUsageInCurrentScope("getCliUsage", generation, this._getLocalCliUsage());
  }

  async _readToolUsageInCurrentScope(method, generation, request) {
    const current = () => generation === this._lifecycleGeneration
      && this._getConfig().hermesMode !== "remote";
    try {
      const result = await request;
      // Async scans can finish after stop/reconfigure. Both success and failure
      // belong to their original scope; the public response must use today's.
      return current() ? result : this[method]();
    } catch (error) {
      if (!current()) return this[method]();
      throw error;
    }
  }

  async _getLocalCliUsage() {
    // Local Hermes stores structured session transcripts on disk. The dashboard
    // REST history also carries tool_calls now (S1), but this scan predates that
    // and reads the JSONL files directly for the `terminal` tool's shell
    // commands — cheaper than paging every session over HTTP. Remote Hermes has
    // no local files.
    if (this._getConfig().hermesMode === "remote") {
      return { supported: false, reason: "remote", commands: {} };
    }
    const generation = this._lifecycleGeneration;
    const home = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
    // Per-profile sessions: default → <home>/sessions, others → <home>/profiles/<p>/sessions.
    // Key counts by the hermes agent id (hermes-<profile>) so they merge with OpenClaw's.
    const profileDirs = [];
    for (const [agentId, profile] of this.profileById.entries()) {
      const base = profile === "default" ? home : path.join(home, "profiles", profile);
      profileDirs.push({ agentId, dir: path.join(base, "sessions") });
    }
    // Cache signature: each sessions-dir mtime (a new session bumps it) + 60s TTL.
    const sigParts = [];
    for (const { dir } of profileDirs) {
      try { sigParts.push(`${dir}:${Math.round((await fs.promises.stat(dir)).mtimeMs)}`); }
      catch { /* no sessions dir for this profile */ }
    }
    const sig = sigParts.join("|");
    const cached = this._cliUsageCache;
    if (cached && cached.sig === sig && Date.now() - cached.at < 60_000) return cached.data;
    if (cached) {
      // R106 SWR：先回旧数据，后台单飞重扫；异步 IO 与解析批次让其它请求继续。
      if (!this._cliUsageScanInFlight) {
        const tracked = new Promise((resolve) => setImmediate(resolve))
          .then(() => this._scanCliUsage(profileDirs, sig, generation))
          .catch((err) => console.error("[hermes] cli usage rescan failed:", err?.message || err))
          .finally(() => {
            if (this._cliUsageScanInFlight === tracked) this._cliUsageScanInFlight = null;
          });
        this._cliUsageScanInFlight = tracked;
      }
      return cached.data;
    }
    return this._scanCliUsage(profileDirs, sig, generation); // 进程首扫：只能等
  }

  // 两种会话落法都要扫（`.jsonl` + `session_*.json`），去重与排除 `request_*.json`
  // 的理由同 _scanSkillUsage 的段头注释（R367）。
  async _scanCliUsage(profileDirs, sig, generation = this._lifecycleGeneration) {
    const commands = {}; // commandName -> { agentId -> count }
    let scannedMessages = 0;
    const countMessage = (o, agentId) => {
      if (!o || !Array.isArray(o.tool_calls)) return;
      for (const tc of o.tool_calls) {
        const fn = tc && tc.function;
        if (!fn || !HERMES_CLI_TOOLS.has(fn.name)) continue;
        let cmd;
        try { cmd = JSON.parse(fn.arguments || "{}").command; } catch { cmd = null; }
        if (typeof cmd !== "string" || !cmd.trim()) continue;
        for (const cn of parseCliCommandNames(cmd)) {
          const byAgent = commands[cn] || (commands[cn] = {});
          byAgent[agentId] = (byAgent[agentId] || 0) + 1;
        }
      }
    };
    for (const { agentId, dir } of profileDirs) {
      let names;
      try { names = await fs.promises.readdir(dir); } catch { continue; }
      const seen = new Set(); // 已计过的 sessionId
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        seen.add(name.slice(0, -".jsonl".length));
        let raw;
        try { raw = await fs.promises.readFile(path.join(dir, name), "utf8"); } catch { continue; }
        for (const line of raw.split("\n")) {
          if (++scannedMessages % 128 === 0) await new Promise((resolve) => setImmediate(resolve));
          if (!line.trim()) continue;
          let o;
          try { o = JSON.parse(line); } catch { continue; }
          countMessage(o, agentId);
        }
      }
      for (const name of names) {
        if (!name.startsWith("session_") || !name.endsWith(".json")) continue;
        let raw;
        try { raw = await fs.promises.readFile(path.join(dir, name), "utf8"); } catch { continue; }
        let o;
        try { o = JSON.parse(raw); } catch { continue; }
        const sid = o && typeof o.session_id === "string" ? o.session_id : "";
        if (!sid || seen.has(sid)) continue; // 同一会话已从 .jsonl 计过
        seen.add(sid);
        for (const m of Array.isArray(o.messages) ? o.messages : []) {
          if (++scannedMessages % 128 === 0) await new Promise((resolve) => setImmediate(resolve));
          countMessage(m, agentId);
        }
      }
    }
    const data = { supported: true, commands };
    if (generation === this._lifecycleGeneration && this._getConfig().hermesMode !== "remote") {
      this._cliUsageCache = { sig, at: Date.now(), data };
    }
    return data;
  }

  // Which skills have this machine's Hermes profiles actually loaded? Hermes has
  // a first-class `skill_view` tool (args {name}), so unlike OpenClaw — where the
  // signal is a read of SKILL.md — the skill name is right there in the call.
  // Same local-files constraint and cache shape as getCliUsage.
  async getSkillUsage() {
    if (this._getConfig().hermesMode === "remote") {
      return { supported: false, reason: "remote", skills: {} };
    }
    const generation = this._lifecycleGeneration;
    if (!this._skillUsageCache) {
      if (this._skillUsageScanInFlight) {
        return this._readToolUsageInCurrentScope("getSkillUsage", generation, this._skillUsageScanInFlight);
      }
      const tracked = this._getLocalSkillUsage().finally(() => {
        if (this._skillUsageScanInFlight === tracked) this._skillUsageScanInFlight = null;
      });
      this._skillUsageScanInFlight = tracked;
      return this._readToolUsageInCurrentScope("getSkillUsage", generation, tracked);
    }
    return this._readToolUsageInCurrentScope("getSkillUsage", generation, this._getLocalSkillUsage());
  }

  async _getLocalSkillUsage() {
    if (this._getConfig().hermesMode === "remote") {
      return { supported: false, reason: "remote", skills: {} };
    }
    const generation = this._lifecycleGeneration;
    const home = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
    const profileDirs = [];
    for (const [agentId, profile] of this.profileById.entries()) {
      const base = profile === "default" ? home : path.join(home, "profiles", profile);
      profileDirs.push({ agentId, dir: path.join(base, "sessions") });
    }
    const sigParts = [];
    for (const { dir } of profileDirs) {
      try { sigParts.push(`${dir}:${Math.round((await fs.promises.stat(dir)).mtimeMs)}`); }
      catch { /* no sessions dir for this profile */ }
    }
    const sig = sigParts.join("|");
    const cached = this._skillUsageCache;
    if (cached && cached.sig === sig && Date.now() - cached.at < 60_000) return cached.data;
    if (cached) {
      if (!this._skillUsageScanInFlight) {
        const tracked = new Promise((resolve) => setImmediate(resolve))
          .then(() => this._scanSkillUsage(profileDirs, sig, generation))
          .catch((err) => console.error("[hermes] skill usage rescan failed:", err?.message || err))
          .finally(() => {
            if (this._skillUsageScanInFlight === tracked) this._skillUsageScanInFlight = null;
          });
        this._skillUsageScanInFlight = tracked;
      }
      return cached.data;
    }
    return this._scanSkillUsage(profileDirs, sig, generation); // 进程首扫：只能等
  }

  // Hermes 的会话在磁盘上有**两种**存法，只扫 `.jsonl` 会漏掉大半：
  //   `<sessionId>.jsonl`                流式追加的转录（本机 33 个）
  //   `session_<sessionId>_<ts>.json`    整份会话记录（含 messages 数组，154 个）
  // 两者按 sessionId 去重（`.jsonl` 优先，它是活动会话的权威形态），只存在于
  // `.json` 里的 121 个会话——多为 cron 跑批——以前完全没被统计到。
  // **`request_*.json` 刻意排除**：那是重试耗尽后的失败请求转储，body 里带着当时
  // 的完整对话，算进来就是把同一批 tool_call 重放着数第二遍（同 OpenClaw 侧不数
  // trajectory 重放、不数 .bak 副本的道理）。
  async _scanSkillUsage(profileDirs, sig, generation = this._lifecycleGeneration) {
    const skills = {}; // skillName -> { agentId -> count }
    let scannedMessages = 0;
    const countMessage = (o, agentId) => {
      if (!o || !Array.isArray(o.tool_calls)) return;
      for (const tc of o.tool_calls) {
        const fn = tc && tc.function;
        if (!fn || fn.name !== HERMES_SKILL_VIEW_TOOL) continue;
        let skillName;
        try { skillName = JSON.parse(fn.arguments || "{}").name; } catch { skillName = null; }
        if (typeof skillName !== "string" || !skillName.trim()) continue;
        const byAgent = skills[skillName.trim()] || (skills[skillName.trim()] = {});
        byAgent[agentId] = (byAgent[agentId] || 0) + 1;
      }
    };
    for (const { agentId, dir } of profileDirs) {
      let names;
      try { names = await fs.promises.readdir(dir); } catch { continue; }
      const seen = new Set(); // 已计过的 sessionId
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        seen.add(name.slice(0, -".jsonl".length));
        let raw;
        try { raw = await fs.promises.readFile(path.join(dir, name), "utf8"); } catch { continue; }
        for (const line of raw.split("\n")) {
          if (++scannedMessages % 128 === 0) await new Promise((resolve) => setImmediate(resolve));
          // 前置字符串判定：技能加载是稀疏事件，绝大多数行不必 JSON.parse。
          if (!line.includes(HERMES_SKILL_VIEW_TOOL)) continue;
          let o;
          try { o = JSON.parse(line); } catch { continue; }
          countMessage(o, agentId);
        }
      }
      for (const name of names) {
        if (!name.startsWith("session_") || !name.endsWith(".json")) continue;
        let raw;
        try { raw = await fs.promises.readFile(path.join(dir, name), "utf8"); } catch { continue; }
        if (!raw.includes(HERMES_SKILL_VIEW_TOOL)) continue;
        let o;
        try { o = JSON.parse(raw); } catch { continue; }
        const sid = o && typeof o.session_id === "string" ? o.session_id : "";
        if (!sid || seen.has(sid)) continue; // 同一会话已从 .jsonl 计过
        seen.add(sid);
        for (const m of Array.isArray(o.messages) ? o.messages : []) {
          if (++scannedMessages % 128 === 0) await new Promise((resolve) => setImmediate(resolve));
          countMessage(m, agentId);
        }
      }
    }
    const data = { supported: true, skills };
    if (generation === this._lifecycleGeneration && this._getConfig().hermesMode !== "remote") {
      this._skillUsageCache = { sig, at: Date.now(), data };
    }
    return data;
  }

  // Full-text search across the agent's sessions via the dashboard's FTS5
  // endpoint (GET /api/sessions/search). Returns unified rows keyed by our
  // sessionKey shape so the UI can open a hit directly.
  async searchChat(agentId, query, opts = {}) {
    const profile = this.profileById.get(agentId);
    const dash = profile ? this.dashboards.get(profile) : null;
    if (!dash) return { supported: false, reason: "no-dashboard", results: [] };
    const q = String(query || "").trim();
    if (!q) return { supported: true, results: [] };
    const limit = Number(opts.limit) > 0 ? Math.min(Number(opts.limit), 100) : 30;
    const { status, body } = await httpGet(
      `${dash.baseUrl}/api/sessions/search?q=${encodeURIComponent(q)}&limit=${limit}`,
      { token: dash.token, timeoutMs: 10000 },
    );
    if (status !== 200) return { supported: false, reason: `http-${status}`, results: [] };
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { supported: false, reason: "bad-json", results: [] };
    }
    const rows = Array.isArray(parsed.results) ? parsed.results : [];
    return {
      supported: true,
      ...(rows.length >= limit ? { truncated: true } : {}),
      results: rows.map((r) => ({
        key: `agent:${agentId}:${r.session_id}`,
        sessionId: typeof r.session_id === "string" ? r.session_id : undefined,
        // hermes_state.search_messages wraps FTS5/trigram matches in >>>…<<<
        // (verified in web_server.py / hermes_state.py); strip to plain text.
        snippet: String(r.snippet || "").replace(/>>>|<<</g, ""),
        ts: Number(r.session_started) ? Math.round(Number(r.session_started) * 1000) : null,
        role: r.role || undefined,
      })),
    };
  }

  async _fetchHistoricalMessages(sessionKey, overrideTail) {
    const m = /^agent:([^:]+):(.+)$/.exec(String(sessionKey || ""));
    if (!m) throw new Error(`hermes history: 非法会话 key ${sessionKey}`);
    const [, agentId, keyTail] = m;
    const tail = String(overrideTail || keyTail);
    const profile = this.profileById.get(agentId);
    if (!profile) throw new Error(`hermes history: 未找到 agent ${agentId}`);
    const dash = this.dashboards.get(profile);
    if (!dash) throw new Error(`hermes history: 未找到 agent ${agentId} 的 dashboard`);
    let response;
    try {
      response = await httpGet(
        `${dash.baseUrl}/api/sessions/${encodeURIComponent(tail)}/messages`,
        { token: dash.token },
      );
    } catch (error) {
      throw new Error(`hermes history request failed: ${error?.message || String(error)}`);
    }
    const { status, body } = response;
    if (status !== 200) throw new Error(`hermes history request failed: HTTP ${status}`);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error(`hermes history response invalid JSON: ${error?.message || String(error)}`);
    }
    if (!Array.isArray(parsed.messages)) {
      throw new Error("hermes history response missing messages array");
    }
    const raw = parsed.messages;
    // The endpoint returns RAW `messages` table rows (hermes_state.get_messages):
    // role user/assistant/system/tool, `tool_calls` (parsed JSON on assistant
    // rows), `tool_name` (on tool-result rows), `reasoning`/`reasoning_content`,
    // per-message `token_count`, and `display_kind` timeline metadata. The old
    // mapping kept only user/assistant text — which is why Hermes tool cards and
    // thinking rendered live but VANISHED on every history reload. Preserve them
    // into the UI's part vocabulary (thinking/toolCall parts + toolResult rows),
    // mirroring what OpenClaw history already ships.
    const textOf = (content) =>
      typeof content === "string" ? content : content == null ? "" : JSON.stringify(content);
    // The dashboard returns each message's `timestamp` (SQLite REAL, epoch
    // SECONDS). The chat UI's ts convention is epoch MS (Date.now / OpenClaw
    // transcript ms), so scale seconds→ms; a magnitude guard leaves a value that
    // is already ms untouched, in case a Hermes version returns ms.
    const tsOf = (v) => {
      const rawTs = Number(v);
      return Number.isFinite(rawTs) && rawTs > 0
        ? Math.round(rawTs < 1e12 ? rawTs * 1000 : rawTs)
        : undefined;
    };
    const out = [];
    for (const msg of raw) {
      if (!msg || typeof msg !== "object") continue;
      if (msg.display_kind === "hidden") continue;
      // Preserve the dashboard's stable autoincrement message id (SQLite PK,
      // server returns `ORDER BY id`) so the chat UI's pin / local-hide — both
      // keyed by message id — work for Hermes like OpenClaw.
      const id = msg.id != null ? `hermes-msg-${msg.id}` : undefined;
      const ts = tsOf(msg.timestamp);
      // Timeline rows (model switches etc.) render as quiet system lines; their
      // role varies, so branch on display_kind before role.
      //
      // 内容是**写给模型看的**注入串（"[System: The active model for this chat has
      // changed to X via provider Y. From this point forward, …]"，网关在 in-place
      // 切模型后按 role:user 追加，见 server.py `_append_model_switch_marker`）。
      // 原样丢给 UI 会被当成 system 行渲染成**红色报错气泡**——用户看到的「切完模型多
      // 出一条报错」就是它。官方桌面同样不显示原文，折成一句时间线标签
      // （chat-messages.ts `timelineDisplayContent` → 'model changed'）。这里带上
      // notice 类型与解析出的模型/提供方，让 UI 拼自己的文案；原文留在 content 里
      // 供 hover 排障。
      if (msg.display_kind === "model_switch") {
        const text = textOf(msg.content).trim();
        if (!text) continue;
        const parsed = /changed to (.+?)(?: via provider (.+?))?\. From this point/.exec(text);
        out.push({
          role: "system",
          id,
          notice: "modelSwitch",
          ...(parsed?.[1] ? { model: parsed[1] } : {}),
          ...(parsed?.[2] ? { provider: parsed[2] } : {}),
          content: [{ type: "text", text }],
          ...(ts != null ? { timestamp: ts } : {}),
        });
        continue;
      }
      if (msg.role === "user") {
        const text = textOf(msg.content);
        const provenance = federationInputProvenanceFromPrompt(text);
        out.push({
          role: "user",
          id,
          content: [{ type: "text", text }],
          ...(provenance ? { provenance } : {}),
          ...(ts != null ? { timestamp: ts } : {}),
        });
        continue;
      }
      if (msg.role === "tool") {
        // Tool RESULT row → the UI's toolResult role (own collapsed group, same
        // as OpenClaw's history tool results).
        const text = textOf(msg.content);
        if (!text.trim()) continue;
        out.push({
          role: "toolResult",
          id,
          toolName: typeof msg.tool_name === "string" && msg.tool_name ? msg.tool_name : undefined,
          content: [{ type: "text", text }],
          ...(ts != null ? { timestamp: ts } : {}),
        });
        continue;
      }
      if (msg.role !== "assistant") continue; // system prompt / internal rows never render
      const parts = [];
      const reasoning =
        (typeof msg.reasoning_content === "string" && msg.reasoning_content.trim()) ||
        (typeof msg.reasoning === "string" && msg.reasoning.trim()) ||
        "";
      if (reasoning) parts.push({ type: "thinking", thinking: reasoning });
      for (const tc of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
        // OpenAI shape {id, function:{name, arguments}} — `arguments` is a JSON
        // string; parse for the card title, fall back to the raw string.
        const fn = tc && typeof tc === "object" ? tc.function || tc : null;
        const name = (fn && typeof fn.name === "string" && fn.name) || "tool";
        let args = fn ? fn.arguments : undefined;
        if (typeof args === "string" && args.trim()) {
          try { args = JSON.parse(args); } catch { /* keep the raw string */ }
        }
        parts.push({ type: "toolCall", toolName: name, arguments: args });
      }
      const text = textOf(msg.content);
      if (text.trim()) parts.push({ type: "text", text });
      if (!parts.length) continue; // nothing renderable (empty placeholder row)
      const tokenCount = Number(msg.token_count) || 0;
      out.push({
        role: "assistant",
        id,
        content: parts,
        ...(ts != null ? { timestamp: ts } : {}),
        // Per-message token_count (the DB stores it; even the official app
        // doesn't surface it) → footer "N tok" via the UI's usage.totalTokens.
        ...(tokenCount > 0 ? { usage: { totalTokens: tokenCount } } : {}),
      });
    }
    return out;
  }

  // Top 会话行点击的「聊了什么」预览：复用 dashboard 的
  // GET /api/sessions/{id}/messages（_fetchHistoricalMessages），取头部文本轮次。
  async getSessionPreview(agentId, sessionKey, opts = {}) {
    // 分页窗口（UI 滑动逐步加载）：默认首屏 100，上限 200。
    const limit = Math.min(Math.max(Number(opts?.limit) || 100, 1), 200);
    const offset = Math.max(Number(opts?.offset) || 0, 0);
    const MAX_TEXT = 2000;
    // usage top 行的 key 形状是 "<profile>:<serverId>"；显式 sessionId 优先。
    const raw = String(sessionKey || "");
    const tail = String(opts?.sessionId || "").trim() || (raw.includes(":") ? raw.slice(raw.indexOf(":") + 1) : raw);
    if (!agentId || !tail) return { supported: false, reason: "error", messages: [] };
    let history;
    try {
      history = await this._fetchHistoricalMessages(`agent:${agentId}:${tail}`);
    } catch (err) {
      console.error("[hermes] session preview failed:", err?.message || err);
      return { supported: false, reason: "unavailable", messages: [] };
    }
    const messages = [];
    let total = 0;
    let title;
    for (const m of history) {
      // 预览只看对话轮次：S1 起历史里还有 toolResult / system(model_switch) 行，
      // 混进预览会把工具输出当成聊天内容。
      if (m.role !== "user" && m.role !== "assistant") continue;
      // 保留换行：块级 markdown（标题/列表/代码围栏）靠换行，压平会退化成行内文字
      const text = (Array.isArray(m.content) ? m.content : [])
        .filter((c) => c && c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n")
        .trim();
      if (!text) continue;
      total += 1;
      if (!title && m.role === "user") title = text.replace(/\s+/g, " ").slice(0, 140);
      // 窗口 [offset, offset+limit)：total 已含当前条，故下标 = total-1
      if (total - 1 >= offset && messages.length < limit) {
        messages.push({
          role: m.role,
          text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text,
          ...(m.timestamp ? { timestamp: m.timestamp } : {}),
        });
      }
    }
    return { supported: true, title, totalMessages: total, offset, truncated: offset + messages.length < total, messages };
  }

  // ---- chat (ACP) ----

  // Is this profile's dashboard on THIS machine? A "remote" dashboard may still be
  // loopback (one the user starts by hand), in which case the local acp subprocess
  // is the right thing to talk to.
  _dashboardIsLoopback(profile) {
    const dash = this.dashboards.get(profile);
    if (!dash) return false;
    try {
      const host = new URL(dash.baseUrl).hostname.toLowerCase();
      return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
    } catch {
      return false;
    }
  }

  _clientForProfile(profile) {
    // Chat always runs through a LOCAL `hermes acp` subprocess. When the dashboard
    // actually lives on another host, spawning it here answers out of THIS machine's
    // SessionDB (or ENOENTs when hermes isn't installed locally) while the UI shows
    // the remote session list — a silently wrong answer that also writes the turn to
    // the wrong place. Refuse instead of lying. (Real remote chat needs an ACP
    // channel to that host, which this backend has no transport for.)
    if (this._getConfig().hermesMode === "remote" && !this._dashboardIsLoopback(profile)) {
      throw new Error(
        "hermes: remote 模式的聊天暂不支持——ACP 只能连本机，发到这里的消息不会落在远程 dashboard 上。",
      );
    }
    let client = this.acpClients.get(profile);
    if (client) return client;
    const args = profile === "default" ? ["acp"] : ["--profile", profile, "acp"];
    client = new AcpClient({
      bin: this.bin,
      args,
      cwd: os.tmpdir(),
      // If the acp subprocess dies, drop the cached client and its session
      // mappings so the next send re-spawns and re-resolves cleanly instead of
      // reusing a dead process / an acp session id the new process never loaded.
      onExit: () => {
        if (this.acpClients.get(profile) === client) this.acpClients.delete(profile);
        for (const [key, m] of this.acpSessionByKey) {
          if (m.profile === profile) this.acpSessionByKey.delete(key);
        }
      },
    });
    this.acpClients.set(profile, client);
    return client;
  }

  /**
   * @param {string} sessionKey
   * @param {string} message
   * @param {string|undefined} idempotencyKey
   * @param {{ delta?: (t:string)=>void, final?: (t:string, errored?:boolean)=>void }} [hooks]
   * @param {{ attachments?: Array<object>, inputProvenance?: {
   *   kind: "inter_session", sourceTool: string
   * } }} [opts] chat.send wire-shape attachments and trusted internal-input provenance
   */
  _pruneIdempotentSends(now = Date.now()) {
    for (const [key, entry] of this._idempotentSends) {
      if (entry.settledAt && now - entry.settledAt >= HERMES_IDEMPOTENCY_TTL_MS) {
        this._idempotentSends.delete(key);
      }
    }
    if (this._idempotentSends.size < HERMES_IDEMPOTENCY_MAX) return;
    for (const [key, entry] of this._idempotentSends) {
      if (!entry.settledAt) continue;
      this._idempotentSends.delete(key);
      if (this._idempotentSends.size < HERMES_IDEMPOTENCY_MAX) break;
    }
  }

  _replayIdempotentTerminal(entry, hooks) {
    if (!entry.terminal) return;
    const fn = hooks?.[entry.terminal.method];
    if (typeof fn !== "function") return;
    queueMicrotask(() => {
      try { fn(...entry.terminal.args); } catch { /* consumer hook failure */ }
    });
  }

  _enqueueMessage(sessionKey, message, idempotencyKey, hooks, opts) {
    const generation = this._lifecycleGeneration;
    // Serialize per-session: chain onto the tail of the queue so concurrent
    // sends (rapid user input before the previous ACP round-trip finishes) are
    // processed in order rather than racing to create/load the same session.
    const prev = this.sendQueues.get(sessionKey) ?? Promise.resolve();
    const next = prev.then(() => {
      if (generation !== this._lifecycleGeneration) {
        throw new Error("hermes: send lifecycle changed before execution");
      }
      return this._sendMessageInner(sessionKey, message, idempotencyKey, hooks, opts, generation);
    });
    // Store a settled tail so a failed send doesn't block subsequent messages.
    const tail = next.catch(() => {});
    this.sendQueues.set(sessionKey, tail);
    void tail.then(() => {
      if (this.sendQueues.get(sessionKey) === tail) this.sendQueues.delete(sessionKey);
    });
    return next;
  }

  sendMessage(sessionKey, message, idempotencyKey, hooks = {}, opts = {}) {
    if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
      return this._enqueueMessage(sessionKey, message, undefined, hooks, opts);
    }
    const cacheKey = JSON.stringify([sessionKey, idempotencyKey]);
    const existing = this._idempotentSends.get(cacheKey);
    if (
      existing
      && (!existing.settledAt || Date.now() - existing.settledAt < HERMES_IDEMPOTENCY_TTL_MS)
    ) {
      // Map insertion order is the LRU order. Refresh a hit before capacity eviction.
      this._idempotentSends.delete(cacheKey);
      this._idempotentSends.set(cacheKey, existing);
      if (existing.terminal) this._replayIdempotentTerminal(existing, hooks);
      else existing.listeners.add(hooks);
      return existing.promise;
    }
    if (existing) this._idempotentSends.delete(cacheKey);
    this._pruneIdempotentSends();
    if (this._idempotentSends.size >= HERMES_IDEMPOTENCY_MAX) {
      const error = new Error("hermes: 同时进行中的幂等消息过多，请稍后重试");
      error.code = "ERR_HERMES_IDEMPOTENCY_CAPACITY";
      return Promise.reject(error);
    }
    const entry = {
      listeners: new Set([hooks]),
      terminal: null,
      settledAt: 0,
      promise: null,
    };
    const fanout = {};
    for (const method of CHAT_HOOK_METHODS) {
      fanout[method] = (...args) => {
        if ((method === "final" || method === "error") && !entry.terminal) {
          entry.terminal = { method, args };
        }
        for (const listener of entry.listeners) {
          try { listener?.[method]?.(...args); } catch { /* one socket must not break the turn */ }
        }
      };
    }
    entry.promise = this._enqueueMessage(
      sessionKey,
      message,
      idempotencyKey,
      fanout,
      opts,
    ).finally(() => {
      entry.settledAt = Date.now();
      entry.listeners.clear();
    });
    this._idempotentSends.set(cacheKey, entry);
    return entry.promise;
  }

  // chat.send wire attachments → typed upload lists. Images keep the ACP
  // ImageContentBlock shape ({type:"image", data, mimeType}) — both wire
  // spellings accepted: manage-ui's {source:{type:"base64", media_type, data}}
  // and the official Control UI's top-level {content, mimeType}. pdf/file
  // (S5, gateway-only) carry {name, mimeType, data}. OpenClaw 2026.8.1 names
  // these fields `fileName`/`content`; accepting both envelopes keeps the
  // shared composer transport-neutral. Unparseable entries are
  // counted in `bad` — the caller refuses the send instead of silently
  // dropping.
  _parseAttachments(attachments) {
    const images = [];
    const pdfs = [];
    const files = [];
    let bad = 0;
    for (const a of Array.isArray(attachments) ? attachments : []) {
      const data = typeof a?.source?.data === "string" && a.source.data ? a.source.data
        : typeof a?.content === "string" && a.content ? a.content
        : null;
      if (!data) {
        bad += 1;
        continue;
      }
      const mime = a?.source?.media_type || a?.mimeType || "";
      const rawName = typeof a?.fileName === "string" ? a.fileName : a?.name;
      const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : "";
      // `video` 是 UI 侧的展示类别（可播放预览），传输上等同 file —— 漏掉它会
      // 让视频掉进 image 分支，当成图片上传给模型。
      const kind =
        a?.type === "pdf" || mime === "application/pdf"
          ? "pdf"
          : a?.type === "file" || a?.type === "audio" || a?.type === "video"
              || mime.startsWith("audio/") || mime.startsWith("video/")
            ? "file"
            : "image";
      if (kind === "pdf") pdfs.push({ name: name || "attachment.pdf", data });
      else if (kind === "file") files.push({ name: name || "attachment.bin", mimeType: mime || "application/octet-stream", data });
      else images.push({ type: "image", data, mimeType: mime || "image/png" });
    }
    return { images, pdfs, files, bad, total: images.length + pdfs.length + files.length + bad };
  }

  // Chat-surface capabilities (composer 按此渲染 accept/预检)。网关聊天可用 →
  // 官方全量（图片 25MB / PDF 50MB·25页 / 任意文件）；ACP 降级窗口 → 图片-only
  // （ACP prompt 只有 image block）。
  getChatCapabilities(agentId) {
    const profile = this.profileById.get(agentId);
    // 区分两种「只有图片」的降级，别混为一谈（这是命令/附件永久退化的直接成因）：
    //  ① profileById 还没这个 agent —— dashboard 冷启动竞态窗口，是**未就绪**，
    //     UI 必须重取而不是把它当终态缓存。属于 Hermes 命名空间（claimsAgentId）
    //     才打 notReady；真未知 agent 不打（就是普通空能力）。
    //  ② profile 在、但 _gatewayChatEnabled 为 false —— ACP 降级窗口，网关聊天面
    //     暂不可用，image-only 是**正确终态**（ACP prompt 只有图片附件），不重取。
    if (!profile) {
      return { attachments: { image: {} }, notReady: this.claimsAgentId(agentId) };
    }
    if (!this._gatewayChatEnabled(profile)) {
      return { attachments: { image: {} } };
    }
    return {
      attachments: {
        image: { maxBytes: 25 * 1024 * 1024 },
        pdf: { maxBytes: 50 * 1024 * 1024, maxPages: 25 },
        file: { maxBytes: 25 * 1024 * 1024 },
      },
      // 网关 slash 面（commands.catalog / slash.exec）可用 → UI 把未在本地
      // 处理的 / 命令交给它执行，而不是当聊天消息发出。
      slash: true,
      permissions: {
        scope: "session",
        apply: "next-turn",
        defaultMode: "inherit",
        options: [
          { id: "inherit", label: "Inherit", description: "Use the Hermes profile approval mode.", risk: "standard" },
          { id: "yolo", label: "YOLO", description: "Approve all tool actions for this session.", risk: "danger", requiresConfirmation: true },
        ],
      },
    };
  }

  // ---- slash commands (S6): the gateway's command surface ----

  _slashDash(agentId) {
    const profile = this.profileById.get(agentId);
    const dash = profile ? this.dashboards.get(profile) : null;
    if (!dash || !this._gatewayChatEnabled(profile)) return null;
    return dash;
  }

  // Full command catalog (hermes_cli COMMAND_REGISTRY + TUI extras + skill /
  // quick commands), categorized. Feeds the composer palette for this agent.
  async listSlashCommands(agentId) {
    const dash = this._slashDash(agentId);
    if (!dash) return { supported: false, commands: [] };
    let res;
    try {
      res = await gatewayRpc(dash, "commands.catalog", {});
    } catch (err) {
      return { supported: false, reason: err?.message || String(err), commands: [] };
    }
    const commands = [];
    const seen = new Set();
    const push = (name, desc, category) => {
      const n = String(name || "").replace(/^\//, "").trim();
      if (!n || seen.has(n)) return;
      seen.add(n);
      commands.push({
        name: n,
        description: String(desc || ""),
        ...(category ? { category: String(category) } : {}),
      });
    };
    // categories: [{name|category, pairs|commands: [[name, desc]…]}] — shape is
    // defensive; fall back to the flat pairs list.
    for (const c of Array.isArray(res?.categories) ? res.categories : []) {
      const catName = typeof c?.name === "string" ? c.name : typeof c?.category === "string" ? c.category : "";
      for (const p of Array.isArray(c?.pairs) ? c.pairs : Array.isArray(c?.commands) ? c.commands : []) {
        if (Array.isArray(p)) push(p[0], p[1], catName);
      }
    }
    for (const p of Array.isArray(res?.pairs) ? res.pairs : []) {
      if (Array.isArray(p)) push(p[0], p[1]);
    }
    return { supported: true, commands };
  }

  // Argument-stage completion (`complete.slash {text}` — skills/bundles/options).
  async completeSlash(agentId, text) {
    const dash = this._slashDash(agentId);
    if (!dash) return { supported: false, items: [] };
    try {
      const res = await gatewayRpc(dash, "complete.slash", { text: String(text || "") });
      const items = (Array.isArray(res?.items) ? res.items : [])
        .map((it) =>
          typeof it === "string"
            ? { value: it }
            : {
                value: String(it?.value ?? it?.text ?? ""),
                label: typeof it?.label === "string" ? it.label : undefined,
                group: typeof it?.group === "string" ? it.group : undefined,
              },
        )
        .filter((i) => i.value);
      return {
        supported: true,
        items,
        replaceFrom: Number.isInteger(res?.replace_from) ? res.replace_from : undefined,
      };
    } catch {
      return { supported: false, items: [] };
    }
  }

  // Execute a slash command server-side (slash.exec → 进程内直答 /
  // command.dispatch typed / persistent slash worker)。Typed dispatch results
  // map to UI actions: send → ride chat.send; prefill → fill the composer;
  // alias → re-resolve (bounded); everything else → output text.
  async execSlash(agentId, sessionKey, text, depth = 0) {
    const dash = this._slashDash(agentId);
    if (!dash) throw new Error("hermes: 该 agent 的命令执行面当前不可用");
    const { m, sock } = await this._gwEnsureRuntime(sessionKey, { allowCreate: true });
    const command = String(text || "").trim();
    const res = await sock.request(
      "slash.exec",
      { session_id: m.runtimeId, command: command.startsWith("/") ? command : `/${command}` },
      { timeoutMs: 60_000 },
    );
    if (typeof res?.type === "string") {
      if (res.type === "send") return { kind: "send", text: String(res.message ?? "") };
      if (res.type === "prefill") return { kind: "prefill", text: String(res.text ?? res.message ?? "") };
      if (res.type === "alias" && depth < 3) {
        return this.execSlash(agentId, sessionKey, String(res.target || ""), depth + 1);
      }
      return { kind: "output", text: String(res.output ?? "") || "(no output)" };
    }
    return {
      kind: "output",
      text: String(res?.output ?? "") || "(no output)",
      ...(typeof res?.warning === "string" && res.warning ? { warning: res.warning } : {}),
    };
  }

  // ---- chat (gateway /api/ws) — S2 ----
  //
  // The official Hermes desktop's chat transport, adopted as OUR primary:
  // session.create / session.resume bind a runtime session, prompt.submit acks
  // immediately, and the turn streams back as `event` frames on the persistent
  // socket. ACP (below) remains the fallback for dashboards without /api/ws.
  // What this unlocks vs ACP: resume of ANY stored session (telegram/cli/cron
  // included — ACP could only load acp-source UUIDs), incremental deltas, tool
  // duration/diff/todos, usage (context window %), compaction status, and the
  // blocking approval/clarify/sudo/secret prompts.

  _gatewayChatEnabled(profile) {
    const mode = String(process.env.SHOGGOTH_HERMES_CHAT || "").toLowerCase();
    if (mode === "acp") return false;
    if (mode === "gateway") return true;
    return Date.now() >= (this.gwChatDisabledUntil.get(profile) || 0);
  }

  _gwSocket(profile, dash) {
    const existing = this.gwSockets.get(profile);
    if (
      existing &&
      !existing._closed &&
      existing.dash?.baseUrl === dash.baseUrl &&
      existing.dash?.token === dash.token
    ) {
      return existing;
    }
    if (existing) {
      try { existing.close(); } catch { /* already closed */ }
    }
    const sock = new HermesGatewaySocket(dash, {
      label: profile,
      onEvent: (params) => {
        try {
          this._onGwEvent(profile, params);
        } catch (err) {
          console.error(`[hermes] gw event handler (${profile}):`, err?.message || err);
        }
      },
      onReconnect: () => this._onGwReconnect(profile),
    });
    this.gwSockets.set(profile, sock);
    return sock;
  }

  // After a reconnect the gateway no longer routes session events to us (the
  // transport binding died with the old socket). Re-issue session.resume for
  // every live turn so the remaining stream re-binds to the new socket.
  _onGwReconnect(profile) {
    const sock = this.gwSockets.get(profile);
    if (!sock) return;
    for (const [runtimeId, turn] of this.gwTurns) {
      const m = this.gwRuntimeByKey.get(turn.sessionKey);
      if (!m || m.profile !== profile) continue;
      if (turn.requiredTransport === "gateway") {
        // Reconnection cannot prove what happened to an inspiration turn, and
        // resume may execute a crash-recovery continuation without user input.
        turn.failObservation("Hermes 执行连接已断开，需要核对运行状态");
        continue;
      }
      sock
        .request("session.resume", { session_id: m.storedId || runtimeId, cols: GW_COLS, source: GW_SOURCE })
        .then((res) => {
          const newId = String(res?.session_id || "");
          if (newId && newId !== runtimeId) {
            this.gwTurns.delete(runtimeId);
            this.gwTurns.set(newId, turn);
            this.gwKeyByRuntime.delete(runtimeId);
            this.gwKeyByRuntime.set(newId, turn.sessionKey);
            m.runtimeId = newId;
          }
          m.generation = sock.generation;
        })
        .catch(() => { /* 轮次超时兜底会收尾 */ });
    }
  }

  _gwSessionKeyFor(profile, sessionId) {
    if (!sessionId) return null;
    const direct = this.gwKeyByRuntime.get(sessionId);
    if (direct) return direct;
    for (const [key, m] of this.gwRuntimeByKey) {
      if (m.profile === profile && m.storedId === sessionId) return key;
    }
    return null;
  }

  _onGwEvent(profile, params) {
    const type = String(params?.type || "");
    const sid = String(params?.session_id || "");
    const payload = params?.payload && typeof params.payload === "object" ? params.payload : {};
    if (type === "session.title") {
      // Async auto-titler push — sid is the STORED id. Update the row in place;
      // the next sessions refresh re-reads it from the server anyway.
      const row = this.sessionRows.find((r) => r.sessionId === sid);
      if (row && typeof payload.title === "string" && payload.title.trim()) {
        row.label = payload.title.trim();
        row.displayName = payload.title.trim();
      }
      return;
    }
    const sessionKey = this._gwSessionKeyFor(profile, sid);
    if (!sessionKey) return;
    if (type === "session.info") {
      this._gwApplySessionInfo(sessionKey, payload);
      return;
    }
    if (type === "terminal.read.request") {
      // We hold no terminal buffer to serve — answer empty immediately so the
      // agent thread doesn't park for the tool's full 30s timeout.
      if (payload.request_id) {
        this.gwSockets.get(profile)?.request("terminal.read.respond", { request_id: payload.request_id, text: "" }).catch(() => {});
      }
      return;
    }
    const turn = this.gwTurns.get(sid);
    if (!turn) return;
    const hooks = turn.hooks;
    switch (type) {
      case "message.delta":
        turn.accumulated += String(payload.text ?? "");
        hooks.delta?.(turn.accumulated);
        break;
      case "message.interim": {
        // Interim = the server sealing the current streaming buffer as its own
        // segment (commentary alongside tools / a pre-nudge answer);
        // message.complete only carries the LAST segment.
        const text = String(payload.text ?? "");
        if (!text.trim()) break;
        this.transcripts.get(turn.sessionKey)?.push({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() });
        hooks.interim?.(text);
        turn.sealed += 1;
        turn.accumulated = "";
        turn.thought = "";
        break;
      }
      case "reasoning.delta":
        turn.thought += String(payload.text ?? "");
        hooks.thinking?.(turn.thought);
        break;
      case "reasoning.available":
        if (typeof payload.text === "string" && payload.text.trim()) {
          turn.thought = payload.text;
          hooks.thinking?.(turn.thought);
        }
        break;
      case "thinking.delta":
        break; // spinner-status noise — the official client ignores it too
      case "tool.start": {
        let args;
        if (typeof payload.args_text === "string" && payload.args_text.trim().startsWith("{")) {
          try { args = JSON.parse(payload.args_text); } catch { /* still streaming */ }
        }
        hooks.tool?.({
          toolCallId: String(payload.tool_id || ""),
          name: typeof payload.name === "string" && payload.name ? payload.name : "tool",
          args,
          phase: "start",
        });
        break;
      }
      case "tool.progress":
        if (payload.tool_id) hooks.tool?.({ toolCallId: String(payload.tool_id), phase: "update" });
        break;
      case "tool.complete": {
        const resultText =
          typeof payload.result_text === "string" && payload.result_text
            ? payload.result_text
            : payload.result;
        hooks.tool?.({
          toolCallId: String(payload.tool_id || ""),
          name: typeof payload.name === "string" && payload.name ? payload.name : undefined,
          args: payload.args,
          phase: "result",
          result: resultText,
          durationS: Number(payload.duration_s) > 0 ? Number(payload.duration_s) : undefined,
          diffText: typeof payload.inline_diff === "string" && payload.inline_diff ? payload.inline_diff : undefined,
        });
        if (Array.isArray(payload.todos) && payload.todos.length) {
          hooks.plan?.(payload.todos.map((td) => ({
            content: String(td?.content ?? td?.text ?? td ?? ""),
            status: typeof td?.status === "string" ? td.status : undefined,
          })));
        }
        break;
      }
      case "status.update":
        if (payload.kind === "compacting" || payload.kind === "compacted") {
          hooks.status?.({ kind: payload.kind, text: typeof payload.text === "string" ? payload.text : "" });
        }
        break;
      case "clarify.request":
        hooks.prompt?.({
          kind: "clarify",
          requestId: String(payload.request_id || ""),
          question: String(payload.question || ""),
          choices: Array.isArray(payload.choices) && payload.choices.length ? payload.choices.map(String) : undefined,
        });
        break;
      case "approval.request":
        // Approvals resolve FIFO per session — no request_id on the wire.
        hooks.prompt?.({
          kind: "approval",
          command: typeof payload.command === "string" ? payload.command : undefined,
          description: typeof payload.description === "string" ? payload.description : undefined,
          choices: Array.isArray(payload.choices) && payload.choices.length ? payload.choices.map(String) : ["once", "deny"],
        });
        break;
      case "sudo.request":
        hooks.prompt?.({ kind: "sudo", requestId: String(payload.request_id || "") });
        break;
      case "secret.request":
        hooks.prompt?.({
          kind: "secret",
          requestId: String(payload.request_id || ""),
          question: String(payload.prompt || payload.env_var || ""),
        });
        break;
      case "clarify.expire":
      case "sudo.expire":
      case "secret.expire":
        hooks.promptExpire?.({ requestId: String(payload.request_id || "") });
        break;
      case "message.complete":
        this._gwComplete(sessionKey, sid, turn, payload);
        break;
      case "error":
        this._gwTurnError(sessionKey, sid, turn, String(payload.message || "assistant 轮次失败"));
        break;
      default:
        break; // moa.* / subagent.* / notification.* — 尚未消费
    }
  }

  _gwApplySessionInfo(sessionKey, p) {
    const meta = this.sessionLiveMeta.get(sessionKey) || {};
    if (typeof p.model === "string" && p.model) meta.model = p.model;
    if (typeof p.provider === "string" && p.provider) meta.provider = p.provider;
    if (typeof p.reasoning_effort === "string") meta.reasoningEffort = p.reasoning_effort;
    if (typeof p.fast === "boolean") meta.fast = p.fast;
    if (typeof p.yolo === "boolean") meta.permissionMode = p.yolo ? "yolo" : "inherit";
    const u = p.usage;
    if (u && typeof u === "object") {
      if (Number(u.context_used) > 0) meta.contextUsed = Number(u.context_used);
      if (Number(u.context_max) > 0) meta.contextMax = Number(u.context_max);
      // Only a payload carrying the cumulative counters may become the next
      // turn's delta baseline; a context-only session.info would zero it and
      // make the next turn report the whole session total as its own delta.
      const cum = (v) => (v == null || v === "" ? NaN : Number(v));
      if (Number.isFinite(cum(u.input)) || Number.isFinite(cum(u.output))) {
        this.gwUsageByKey.set(sessionKey, u);
      }
    }
    this.sessionLiveMeta.set(sessionKey, meta);
    this._applyLiveMetaToRow(sessionKey);
  }

  // Fold live gateway metadata (current model / context occupancy) into the
  // aggregated session row so the UI's meter + model pill reflect reality
  // between full refreshes. refreshSessions re-applies after each rebuild.
  _applyLiveMetaToRow(sessionKey) {
    const meta = this.sessionLiveMeta.get(sessionKey);
    if (!meta) return;
    const row = this.sessionRows.find((r) => r.key === sessionKey);
    if (!row) return;
    if (meta.model) row.model = meta.model;
    if (meta.provider) row.modelProvider = meta.provider;
    if (Number(meta.contextMax) > 0) row.contextTokens = meta.contextMax;
    if (Number(meta.contextUsed) > 0) {
      row.totalTokens = meta.contextUsed;
      row.totalTokensFresh = true;
    }
    if (typeof meta.reasoningEffort === "string" && meta.reasoningEffort) row.thinkingLevel = meta.reasoningEffort;
    if (typeof meta.permissionMode === "string") row.permissionMode = meta.permissionMode;
  }

  // Cumulative→per-turn usage: the gateway reports session-cumulative counters;
  // diff against the pre-turn snapshot for the message footer's ↑/↓, and pass
  // the context-window trio through for the ctx% display.
  _gwTurnUsageMeta(sessionKey, turn, usage) {
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const prev = turn.usageBefore || {};
    const dIn = Math.max(0, num(usage.input) - num(prev.input));
    const dOut = Math.max(0, num(usage.output) - num(prev.output));
    this.gwUsageByKey.set(sessionKey, usage);
    const meta = this.sessionLiveMeta.get(sessionKey) || {};
    if (num(usage.context_used) > 0) meta.contextUsed = num(usage.context_used);
    if (num(usage.context_max) > 0) meta.contextMax = num(usage.context_max);
    if (typeof usage.model === "string" && usage.model) meta.model = usage.model;
    this.sessionLiveMeta.set(sessionKey, meta);
    this._applyLiveMetaToRow(sessionKey);
    return {
      usage: {
        ...(dIn > 0 ? { input: dIn } : {}),
        ...(dOut > 0 ? { output: dOut } : {}),
        ...(num(usage.context_used) > 0 ? { contextUsed: num(usage.context_used) } : {}),
        ...(num(usage.context_max) > 0 ? { contextMax: num(usage.context_max) } : {}),
        ...(num(usage.context_percent) > 0 ? { contextPercent: num(usage.context_percent) } : {}),
      },
      model: typeof usage.model === "string" && usage.model ? usage.model : undefined,
    };
  }

  // Post-final: drop the in-memory transcript so the UI's reload-on-final
  // refetches the canonical dashboard history — which (S1) carries the turn's
  // tool rows + thinking. Only when a real server id exists to refetch from.
  _gwInvalidateTranscript(sessionKey) {
    const tail = String(sessionKey || "").split(":").slice(2).join(":") || "main";
    const serverId = this._serverSessionId(sessionKey, tail);
    if (serverId && serverId !== "main") this.transcripts.delete(sessionKey);
  }

  // The reload-on-final replaces the live message (which carried per-turn
  // usage/model) with REST rows that only have token_count — the footer's
  // ↑/↓/%ctx would flash once and vanish. Stitch the last turn's meta back
  // onto the refetched history's final assistant row.
  _stitchLastFinalMeta(sessionKey, messages) {
    const meta = this.gwLastFinalMeta?.get?.(sessionKey);
    if (!meta || !Array.isArray(messages)) return messages;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m?.role !== "assistant") continue;
      if (!m.usage || m.usage.totalTokens != null) {
        messages[i] = { ...m, usage: { ...(m.usage || {}), ...meta.usage }, ...(meta.model ? { model: meta.model } : {}) };
      }
      break;
    }
    return messages;
  }

  _gwEndTurn(runtimeId, turn) {
    if (!turn || turn.ended) return;
    turn.ended = true;
    if (turn.timer) clearTimeout(turn.timer);
    turn.timer = null;
    if (this.gwTurns.get(runtimeId) === turn) this.gwTurns.delete(runtimeId);
    turn.resolve?.();
    turn.resolve = null;
  }

  _gwComplete(sessionKey, runtimeId, turn, payload) {
    const status = String(payload.status || "complete");
    const text = String(payload.text ?? "");
    const usage = payload.usage && typeof payload.usage === "object" ? payload.usage : null;
    const meta = usage ? this._gwTurnUsageMeta(sessionKey, turn, usage) : undefined;
    const transcript = this.transcripts.get(sessionKey);
    const stamp = meta ? { usage: meta.usage, ...(meta.model ? { model: meta.model } : {}) } : {};
    if (status === "error") {
      // 按信息量排序，不按字段名排：text 是网关拼好的全文（额度墙时含 provider
      // 原话 + 充值链接），billing.message 是同一段文案的结构化副本，
      // failure_reason 只是裸枚举（"billing" / "rate_limit"…）且只在额度墙时才有
      // ——它排第一会把唯一数据最全的一类错误压成一个单词。
      const reason = String(
        text.trim() || payload?.billing?.message || payload.failure_reason || "assistant 轮次失败",
      );
      // stopReason:"error" 让重载后的历史行仍按红色错误气泡渲染——error hook 的
      // 红气泡只是内存态，下一次 loadHistory 会被这里的转录行整体替换。
      transcript?.push({ role: "assistant", content: [{ type: "text", text: `[${reason}]` }], timestamp: Date.now(), stopReason: "error" });
      turn.hooks.error?.(reason);
      this._gwEndTurn(runtimeId, turn);
      return;
    }
    if (status === "interrupted") {
      const note = text.trim() || turn.accumulated || "[已停止生成]";
      transcript?.push({ role: "assistant", content: [{ type: "text", text: note }], timestamp: Date.now(), ...stamp });
      this._gwInvalidateTranscript(sessionKey);
      turn.hooks.final?.(note, false, { ...meta, stopReason: "cancelled" });
      this._gwEndTurn(runtimeId, turn);
      return;
    }
    if (!text.trim() && !turn.sealed) {
      // Empty successful turn → surface as error (an empty chat:final would
      // loop the UI's reload-on-final; same policy as the ACP path).
      const reason = String(payload.warning || "模型没有返回任何内容（可能是模型配置或额度问题）。");
      transcript?.push({ role: "assistant", content: [{ type: "text", text: `[${reason}]` }], timestamp: Date.now(), stopReason: "error" });
      turn.hooks.error?.(reason);
      this._gwEndTurn(runtimeId, turn);
      return;
    }
    if (text.trim()) {
      transcript?.push({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now(), ...stamp });
    }
    if (meta) {
      if (!this.gwLastFinalMeta) this.gwLastFinalMeta = new Map();
      this.gwLastFinalMeta.set(sessionKey, meta);
    }
    this._gwInvalidateTranscript(sessionKey);
    turn.hooks.final?.(text, false, meta);
    this._gwEndTurn(runtimeId, turn);
  }

  _gwTurnError(sessionKey, runtimeId, turn, message) {
    this.transcripts.get(sessionKey)?.push({ role: "assistant", content: [{ type: "text", text: `[${message}]` }], timestamp: Date.now(), stopReason: "error" });
    turn.hooks.error?.(message);
    this._gwEndTurn(runtimeId, turn);
  }

  // Answer a blocking agent prompt (approval / clarify / sudo / secret) —
  // routed here from the proxy's `chat.respond`. Approval resolves FIFO per
  // session (no request_id); the rest correlate by request_id.
  async respondChatPrompt(sessionKey, data = {}) {
    const m = this.gwRuntimeByKey.get(sessionKey);
    const sock = m ? this.gwSockets.get(m.profile) : null;
    if (!m || !sock) throw new Error("hermes: 该会话没有进行中的网关轮次，无法回应");
    const kind = String(data.kind || "");
    if (kind === "approval") {
      return sock.request("approval.respond", {
        session_id: m.runtimeId,
        choice: String(data.choice || "deny"),
        all: data.all === true,
      });
    }
    const requestId = String(data.requestId || "");
    if (!requestId) throw new Error("hermes: 缺少 requestId");
    if (kind === "clarify") return sock.request("clarify.respond", { request_id: requestId, answer: String(data.value ?? "") });
    if (kind === "sudo") return sock.request("sudo.respond", { request_id: requestId, password: String(data.value ?? "") });
    if (kind === "secret") return sock.request("secret.respond", { request_id: requestId, value: String(data.value ?? "") });
    throw new Error(`hermes: 未知的 prompt 类型「${kind}」`);
  }

  // Ensure a runtime session binding for non-send operations (compact / slash
  // exec / session-scoped config). Resume when the key maps to stored content;
  // `allowCreate` lets commands run on a fresh chat (session.create is lazy —
  // no DB row until a prompt), which /help-style commands need.
  //
  // `eagerBuild` = build the agent INSIDE the resume（网关的 `eager_build`）。
  // 默认的冷 resume 是「先还历史、50ms 后台定时器再建 agent」：RPC 一返回
  // `session["agent"]` 还是 None（实测 info 只有 lazy 那几个字段），而紧跟其后的
  // `config.set` 在 agent 未建时**只**把 override 钉进内存 session dict——随后的
  // 延迟构建走的是 `resume_runtime_overrides` 分支（state.db 里那份**陈旧**身份），
  // 把这次钉的 override 整个丢掉（server.py `_start_agent_build`）。表现就是
  // 「切模型提示成功、下一条消息仍用旧模型、模型胶囊被回吐的旧模型覆盖」。
  // 建好 agent 再切 = 走 `_apply_model_switch` 的 in-place 分支（换 client + 落
  // state.db + 追加切换标记），此后 resume 恢复的也是新值。实测 owl 上 eager
  // resume 仅 ~230ms（冷 resume 52ms），远在 UI 那 20s RPC 预算内。
  async _gwEnsureRuntime(sessionKey, { allowCreate = false, eagerBuild = false } = {}) {
    const freshTransport = this.freshSessionTransports.get(sessionKey);
    if (freshTransport === "acp") {
      throw new Error("hermes: 该新会话已绑定 ACP；请先发送首条消息再使用网关会话操作");
    }
    if (freshTransport === "gateway" && !this.gwRuntimeByKey.has(sessionKey)) {
      throw new Error("hermes: 新会话的网关连接已失效，请重新创建会话");
    }
    const { tail, profile, dash } = this._sessionTarget(sessionKey);
    const sock = this._gwSocket(profile, dash);
    let m = this.gwRuntimeByKey.get(sessionKey);
    if (m && m.generation !== sock.generation) m = null;
    if (m) return { m, sock };
    // fresh key 还没有持久化的消息；旧式本地 key 在服务端不存在，resume 会
    // session not found，因此和 main 一样需要 create。新式 canonical key 通常已
    // 预装 runtime 映射，会在上面的快速路径直接返回。
    const isFresh = this.freshSessionKeys.has(sessionKey);
    const target = this.gwRuntimeByKey.get(sessionKey)?.storedId || (tail === "main" || isFresh ? "" : tail);
    if (!target && !allowCreate) throw new Error("hermes: 该会话还没有任何内容");
    const resume = (eager) =>
      sock.request(
        "session.resume",
        { session_id: target, cols: GW_COLS, source: GW_SOURCE, ...(eager ? { eager_build: true } : {}) },
        { timeoutMs: 60_000 },
      );
    let res;
    let eagerError = null;
    if (target) {
      try {
        res = await resume(eagerBuild);
      } catch (err) {
        // 预热失败只有一个原因：这条会话存着的 provider/凭证已经构不出 agent
        // （`_make_agent` 当场抛）。冷 resume 仍然会成功——它只还历史、把构建丢给后台
        // 定时器（在那儿静默失败）——所以只读操作（compact/slash/取转录）照旧可用；
        // 但**切模型/思考档不能靠它**：agent 为 None 时网关只把 override 钉进内存就回
        // ok，什么都没落盘 = 假成功。把原因带出去交给 `_gwRequireAgent` 抛。
        if (!eagerBuild) throw err;
        eagerError = err;
        res = await resume(false);
      }
    } else {
      res = await sock.request("session.create", { cols: GW_COLS, source: GW_SOURCE });
    }
    const runtimeId = String(res?.session_id || "");
    if (!runtimeId) throw new Error("hermes: 会话恢复失败（网关未返回 session_id）");
    m = {
      profile,
      runtimeId,
      storedId: String(res?.resumed || res?.stored_session_id || target) || undefined,
      generation: sock.generation,
      resumed: !!target,
      // agent 在网关侧建好了没有：`info` 是 lazy 形状（`_lazy_resume_info` 带 lazy:true）
      // = 还没建。老网关不回 info → 按「已建」放行（宽松兜底，别把能切的挡住）。
      agentBuilt: !eagerError && res?.info?.lazy !== true,
      eagerError,
    };
    this.gwRuntimeByKey.set(sessionKey, m);
    this.gwKeyByRuntime.set(runtimeId, sessionKey);
    return { m, sock };
  }

  // 坐实 agent 真的建好了，否则拒绝「切模型/思考档」这类会话级覆写（R303）。
  // 病理：网关的 `_apply_model_switch` 在 `session["agent"]` 为 None 时**只**把 override
  // 钉进内存就回 ok（不换 client、不落 state.db、不追加切换标记），而
  // `_persist_live_session_runtime` 见 agent 为 None 直接 early-return —— UI 于是弹
  // 「已切换」，下一条消息仍走会话存的旧身份（用户视角 = 每个 agent 报各自旧 provider
  // 的 401）。两种建不出来，都在这里坐实：
  //   ① 预热 resume 已经抛了 → 网关给的就是真实原因（provider 不在 config 里 /
  //      凭证没了）。这条会话换任何模型都救不了：改模型也得先按旧身份把 agent 建出来。
  //   ② resume 命中「已 live」快路时 `eager_build` 被整个忽略（server.py 里
  //      `_find_live_session_by_key` 早退），若那条 live 会话的 agent 恰是 None（上一次
  //      构建失败留下的），info 就是 lazy 形状 → 用**只读**的 `process.list` 逼网关同步
  //      构建（它走 `_sess` = `_start_agent_build` + `_wait_agent`），建成了就继续切。
  // create 出来的新会话不走这里：它没有陈旧 override，钉进内存的 override 会被延迟构建
  // 原样采纳——R279「切模型不依赖坏 agent 能初始化」那条路一步都不能丢。
  async _gwRequireAgent(m, sock) {
    if (m.agentBuilt || !m.resumed) return;
    const dangling = (err) => {
      const raw = String(err?.message || err || "").replace(/^resume failed:\s*/i, "").trim();
      return new Error(
        `这条会话存的模型身份已构不出来${raw ? `（${raw}）` : ""}——网关得先按旧身份` +
          "建出 agent 才能改模型。请补回该 provider / 凭证，或新建一条会话。",
      );
    };
    if (m.eagerError) throw dangling(m.eagerError);
    try {
      await sock.request("process.list", { session_id: m.runtimeId }, { timeoutMs: 40_000 });
    } catch (err) {
      // 老网关没有这个方法 → 按「已建」放行，别拿探针把本来能切的挡下来。
      if (err?.code === -32601) {
        m.agentBuilt = true;
        return;
      }
      throw dangling(err);
    }
    m.agentBuilt = true;
  }

  // Compact the session's context = the gateway's session.compress (what the
  // official /compress command calls; 120s LLM budget server-side). The
  // compacted transcript replaces history — invalidate ours so the UI's reload
  // shows it.
  async compactSession(sessionKey) {
    const { m, sock } = await this._gwEnsureRuntime(sessionKey);
    const res = await sock.request("session.compress", { session_id: m.runtimeId }, { timeoutMs: 130_000 });
    this._gwInvalidateTranscript(sessionKey);
    const summary = res?.summary && typeof res.summary === "object" ? res.summary : {};
    return {
      headline: typeof summary.headline === "string" && summary.headline ? summary.headline : undefined,
      tokenLine: typeof summary.token_line === "string" && summary.token_line ? summary.token_line : undefined,
    };
  }

  async _sendViaGateway({ sessionKey, message, hooks, atts, transcript, profile, assertCurrentGeneration,
    requiredTransport }, retried = false) {
    const { tail, dash } = this._sessionTarget(sessionKey);
    const sock = this._gwSocket(profile, dash);
    const unavailable = (err) => {
      const e = new Error(err?.message || String(err));
      e.code = "GW_UNAVAILABLE";
      return e;
    };
    // —— ensure a runtime session (create for main/fresh keys, resume otherwise)
    let m = this.gwRuntimeByKey.get(sessionKey);
    if (m && m.generation !== (this.gwSockets.get(profile)?.generation ?? -1)) m = null;
    if (!m && requiredTransport === "gateway") {
      // session.resume can execute a crash-recovery continuation by itself.
      // An inspiration turn must keep its prepared runtime identity and cannot
      // silently recover that session before submitting another prompt.
      hooks.error?.("Hermes 已准备的执行会话需要重新核对", { executionUncertain: true });
      return;
    }
    if (!m) {
      const prior = this.gwRuntimeByKey.get(sessionKey);
      const isFresh = this.freshSessionKeys.has(sessionKey);
      const useCreate = !prior?.storedId && (tail === "main" || isFresh);
      let res;
      try {
        res = useCreate
          ? await sock.request("session.create", { cols: GW_COLS, source: GW_SOURCE })
          : await sock.request(
              "session.resume",
              { session_id: prior?.storedId || tail, cols: GW_COLS, source: GW_SOURCE },
              { timeoutMs: 60_000 },
            );
      } catch (err) {
        // Transport-level failure (dial/timeout/drop — anything the server did
        // NOT answer) → let the caller fall back to ACP. A served JSON-RPC
        // error (bad session id…) is real and must surface.
        if (err?.jsonRpc !== true) throw unavailable(err);
        assertCurrentGeneration();
        const errText = `[Hermes session init error: ${err.message}]`;
        transcript.push({ role: "assistant", content: [{ type: "text", text: errText }], timestamp: Date.now() });
        hooks.final?.(errText, true);
        return;
      }
      assertCurrentGeneration();
      const runtimeId = String(res?.session_id || "");
      if (!runtimeId) {
        const errText = "[Hermes session init error: 网关未返回 session_id]";
        transcript.push({ role: "assistant", content: [{ type: "text", text: errText }], timestamp: Date.now() });
        hooks.final?.(errText, true);
        return;
      }
      m = {
        profile,
        runtimeId,
        storedId: String(res?.stored_session_id || res?.resumed || (useCreate ? "" : prior?.storedId || tail)) || undefined,
        generation: sock.generation,
      };
      this.gwRuntimeByKey.set(sessionKey, m);
      this.gwKeyByRuntime.set(runtimeId, sessionKey);
    }
    // —— attachments: upload-then-submit (official style). Images/PDF pages
    // queue into this turn server-side; files stage under the workspace and
    // return an @file: ref that must ride the prompt TEXT.
    let fileRefs = "";
    const uploadFail = (label, err) => {
      const errText = `${label}上传失败：${err?.message || err}，消息未发送。`;
      transcript.push({ role: "assistant", content: [{ type: "text", text: `[${errText}]` }], timestamp: Date.now() });
      hooks.error?.(errText);
    };
    // 上传超时统一放宽到 GW_ATTACH_TIMEOUT_MS：服务端要解析工作区、探 git、落盘，
    // 而 dashboard 冷启动期还并行着模型目录抓取（/api/model/options 可达 20s），
    // 排队后极易超过默认 30s——真机实测「file.attach 超时」即出自此，同一调用在
    // 暖机后只要 3s。
    for (const img of atts.images) {
      try {
        const ext = /\/(\w+)/.exec(String(img.mimeType || ""))?.[1] || "png";
        await sock.request("image.attach_bytes", {
          session_id: m.runtimeId,
          content_base64: img.data,
          filename: `attach-${Date.now()}.${ext === "jpeg" ? "jpg" : ext}`,
        }, { timeoutMs: GW_ATTACH_TIMEOUT_MS });
      } catch (err) {
        assertCurrentGeneration();
        uploadFail("图片", err);
        return;
      }
    }
    for (const pdf of atts.pdfs) {
      try {
        // pdftoppm renders each page to an image server-side — minutes-scale on
        // big documents; give it room.
        await sock.request("pdf.attach", { session_id: m.runtimeId, content_base64: pdf.data }, { timeoutMs: 120_000 });
      } catch (err) {
        assertCurrentGeneration();
        uploadFail(`PDF「${pdf.name}」`, err);
        return;
      }
    }
    for (const f of atts.files) {
      try {
        const r = await sock.request("file.attach", {
          session_id: m.runtimeId,
          name: f.name,
          data_url: `data:${f.mimeType};base64,${f.data}`,
        }, { timeoutMs: GW_ATTACH_TIMEOUT_MS });
        if (typeof r?.ref_text === "string" && r.ref_text) fileRefs += `\n\n${r.ref_text}`;
      } catch (err) {
        assertCurrentGeneration();
        uploadFail(`文件「${f.name}」`, err);
        return;
      }
    }
    assertCurrentGeneration();
    // —— register the turn BEFORE submitting (events may start before the ack),
    // then wait for message.complete/error via the turn promise.
    const turn = {
      sessionKey,
      requiredTransport,
      hooks,
      accumulated: "",
      thought: "",
      sealed: 0,
      usageBefore: this.gwUsageByKey.get(sessionKey) || null,
      resolve: null,
      timer: null,
    };
    const pendingHooks = [];
    if (requiredTransport === "gateway") {
      // Events may precede the submit acknowledgement. Hermes can queue or
      // steer a busy session instead of starting this turn, so only release
      // these observations once it confirms a new streaming submission.
      turn.submissionState = "pending";
      turn.hooks = Object.fromEntries(Object.entries(hooks).map(([name, fn]) => [name,
        typeof fn !== "function" ? fn : (...args) => {
          if (turn.submissionState === "pending") pendingHooks.push(() => fn(...args));
          else if (turn.submissionState === "accepted") fn(...args);
        }]));
      turn.failObservation = (message) => {
        turn.submissionState = "rejected";
        pendingHooks.length = 0;
        hooks.error?.(message, { executionUncertain: true });
        this._gwEndTurn(m.runtimeId, turn);
      };
    }
    const doneP = new Promise((resolve) => { turn.resolve = resolve; });
    turn.timer = setTimeout(() => {
      if (turn.failObservation) return turn.failObservation("轮次超时：30 分钟内未收到完成事件。");
      hooks.error?.("轮次超时：30 分钟内未收到完成事件。", { executionUncertain: true });
      this._gwEndTurn(m.runtimeId, turn);
    }, GW_TURN_TIMEOUT_MS);
    this.gwTurns.set(m.runtimeId, turn);
    try {
      // @file: refs (staged uploads) ride the prompt text — that's how the
      // agent learns about them (official desktop inlines them the same way).
      const acknowledgement = await sock.request("prompt.submit", { session_id: m.runtimeId, text: `${message}${fileRefs}` });
      if (requiredTransport === "gateway") {
        if (turn.submissionState === "rejected") return;
        if (acknowledgement?.status !== "streaming") {
          turn.failObservation("Hermes 未确认本轮独立执行，需要核对运行状态");
          return;
        }
        turn.submissionState = "accepted";
        for (const notify of pendingHooks.splice(0)) notify();
      }
      // Hermes starts persisting the canonical stored session once the prompt
      // has been accepted. Keep it local-only if submission itself fails.
      this.freshSessionKeys.delete(sessionKey);
      this.freshSessionTransports.delete(sessionKey);
    } catch (err) {
      if (requiredTransport === "gateway") {
        turn.submissionState = "rejected";
        pendingHooks.length = 0;
      }
      this._gwEndTurn(m.runtimeId, turn);
      // Stale runtime (gateway restarted between turns) → one clean retry with
      // a fresh resume; the official desktop does the same.
      if (requiredTransport !== "gateway" && !retried && err?.jsonRpc === true && /session not found/i.test(String(err.message))) {
        this.gwKeyByRuntime.delete(m.runtimeId);
        this.gwRuntimeByKey.set(sessionKey, { ...m, generation: -1 });
        return this._sendViaGateway({ sessionKey, message, hooks, atts, transcript, profile, assertCurrentGeneration }, true);
      }
      assertCurrentGeneration();
      const errText = `[Hermes 发送失败: ${err?.message || err}]`;
      transcript.push({ role: "assistant", content: [{ type: "text", text: errText }], timestamp: Date.now() });
      hooks.final?.(errText, true, { executionUncertain: true });
      return;
    }
    await doneP;
    assertCurrentGeneration();
  }

  // ---- chat send dispatch ----

  async _sendMessageInner(sessionKey, message, idempotencyKey, hooks = {}, opts = {}, generation = this._lifecycleGeneration) {
    const requiredTransport = opts.requiredTransport;
    if (requiredTransport !== undefined && !["gateway", "acp"].includes(requiredTransport)) {
      throw new Error("hermes: 未知的会话执行通道");
    }
    // 每个跨 await 写点前复核代际，防止旧回调污染 reconfigure 后的新状态。
    const assertCurrentGeneration = () => {
      if (generation !== this._lifecycleGeneration) {
        throw new Error("hermes: send lifecycle changed while running");
      }
    };
    assertCurrentGeneration();
    const agentId = /^agent:([^:]+)/.exec(sessionKey ?? "")?.[1];
    const profile = agentId ? this.profileById.get(agentId) : null;
    if (!profile) throw new Error(`hermes-backend: unknown agent in sessionKey ${sessionKey}`);

    const atts = this._parseAttachments(opts.attachments);
    const inputProvenance = normalizeFederationInputProvenance(opts.inputProvenance);
    const submittedMessage = annotateFederationPrompt(message, inputProvenance);
    const transcript = this.transcripts.get(sessionKey) ?? [];
    // Local transcript copy notes the attachments (the real bytes travel on the
    // transport; markers are only for the reloaded-history display).
    const markers = [];
    if (atts.images.length) markers.push(`[image ×${atts.images.length}]`);
    for (const p of atts.pdfs) markers.push(`[pdf: ${p.name}]`);
    for (const f of atts.files) markers.push(`[file: ${f.name}]`);
    const transcriptText = markers.length
      ? `${submittedMessage}${submittedMessage ? "\n" : ""}${markers.join(" ")}`
      : submittedMessage;
    // Every live-appended transcript entry (this user turn + the assistant turn /
    // error notes below) stamps `timestamp: Date.now()` so getHistory's in-memory
    // messages carry a time the chat footer can show.
    transcript.push({
      role: "user",
      content: [{ type: "text", text: transcriptText }],
      timestamp: Date.now(),
      ...(inputProvenance ? { provenance: inputProvenance } : {}),
    });
    this.transcripts.set(sessionKey, transcript);

    // Refuse unparseable attachments instead of silently sending without them —
    // the model would answer as if no attachment existed. (Transport-agnostic.)
    if (atts.bad > 0) {
      const errText = `有 ${atts.bad} 个附件无法解析，消息未发送。请重新附加后再试。`;
      transcript.push({ role: "assistant", content: [{ type: "text", text: `[${errText}]` }], timestamp: Date.now() });
      hooks.error?.(errText);
      return;
    }

    // A canonical /new key is bound to whichever transport created it until
    // the first prompt persists that identity. Switching transports in this
    // window would create a second stored id while the UI keeps the first key.
    const isFresh = this.freshSessionKeys.has(sessionKey);
    const freshTransport = this.freshSessionTransports.get(sessionKey);
    if (requiredTransport && freshTransport && requiredTransport !== freshTransport) {
      hooks.error?.("hermes: 已准备的会话执行通道已变化");
      return;
    }
    if (isFresh && freshTransport === "acp" && !this.acpSessionByKey.has(sessionKey)) {
      const errText = "新会话的 ACP 连接在首条消息前已失效；为避免会话身份错乱，请重新创建会话。";
      transcript.push({ role: "assistant", content: [{ type: "text", text: `[${errText}]` }], timestamp: Date.now() });
      hooks.error?.(errText);
      return;
    }
    if (isFresh && freshTransport === "gateway" && !this.gwRuntimeByKey.has(sessionKey)) {
      const errText = "新会话的 Hermes 网关连接在首条消息前已失效；为避免会话身份错乱，请重新创建会话。";
      transcript.push({ role: "assistant", content: [{ type: "text", text: `[${errText}]` }], timestamp: Date.now() });
      hooks.error?.(errText);
      return;
    }
    const freshAcpBinding = isFresh
      && (freshTransport === "acp" || (!freshTransport && this.acpSessionByKey.has(sessionKey)));
    const freshGatewayBinding = isFresh
      && (freshTransport === "gateway" || (!freshTransport && this.gwRuntimeByKey.has(sessionKey)));

    // Gateway transport first (the official desktop's own); ACP only as the
    // fallback when the dial itself fails and no fresh gateway identity is at
    // risk. An ACP-created fresh session stays on ACP for its first prompt even
    // if the gateway retry TTL has already elapsed.
    if (requiredTransport !== "acp" && !freshAcpBinding
      && (requiredTransport === "gateway" || freshGatewayBinding || this._gatewayChatEnabled(profile))) {
      try {
        return await this._sendViaGateway({
          sessionKey,
          message: submittedMessage,
          hooks,
          atts,
          transcript,
          profile,
          assertCurrentGeneration,
          requiredTransport,
        });
      } catch (err) {
        if (err?.code !== "GW_UNAVAILABLE") throw err;
        this.gwChatDisabledUntil.set(profile, Date.now() + GW_CHAT_RETRY_MS);
        if (freshGatewayBinding || requiredTransport === "gateway") {
          assertCurrentGeneration();
          const errText = `新会话已绑定 Hermes 网关，但首条消息暂时无法提交（${err.message}）。请稍后重试。`;
          transcript.push({ role: "assistant", content: [{ type: "text", text: `[${errText}]` }], timestamp: Date.now() });
          hooks.error?.(errText, { executionUncertain: true });
          return;
        }
        console.warn(`[hermes] profile ${profile}: 网关聊天不可用（${err.message}），本次回落 ACP`);
      }
    }
    return this._sendViaAcp({
      sessionKey,
      message: submittedMessage,
      hooks,
      atts,
      transcript,
      profile,
      generation,
      assertCurrentGeneration,
    });
  }

  // ---- chat send via ACP (fallback transport) ----

  async _sendViaAcp({ sessionKey, message, hooks, atts, transcript, profile, generation, assertCurrentGeneration }) {
    // ACP prompt 只有 image block 一种附件载体 — PDF/文件是网关上传 RPC 的能力，
    // 降级窗口里明确拒绝（能力接口也同步收窄，见 getChatCapabilities）。
    if (atts.pdfs.length || atts.files.length) {
      const errText = "当前处于 ACP 降级通道，仅支持图片附件；PDF/文件请稍后（网关恢复）再发。";
      transcript.push({ role: "assistant", content: [{ type: "text", text: `[${errText}]` }], timestamp: Date.now() });
      hooks.error?.(errText);
      return;
    }
    const imageBlocks = atts.images;
    const client = this._clientForProfile(profile);
    // Refuse images the agent can't accept BEFORE sending — a silent drop would
    // make the model answer as if no image existed. (Capability is known after
    // initialize; start() resolves inside newSession/loadSession/prompt.)
    if (imageBlocks.length) {
      try {
        await client.start();
      } catch (err) {
        assertCurrentGeneration();
        const errText = `[Hermes ACP error: ${err && err.message ? err.message : String(err)}]`;
        transcript.push({ role: "assistant", content: [{ type: "text", text: errText }], timestamp: Date.now() });
        hooks.final?.(errText, true);
        return;
      }
      assertCurrentGeneration();
      if (!client.supportsImages()) {
        const errText = "当前 Hermes ACP 不支持图片附件，消息未发送。请去掉图片后重试。";
        transcript.push({ role: "assistant", content: [{ type: "text", text: `[${errText}]` }], timestamp: Date.now() });
        hooks.error?.(errText);
        return;
      }
    }
    let mapping = this.acpSessionByKey.get(sessionKey);
    const tail = String(sessionKey || "").split(":").slice(2).join(":") || "main";
    console.log(`[HERMES-DEBUG] sendMessage profile=${profile} sessionKey=${sessionKey} tail=${tail} reuseMapping=${!!mapping}`);
    const isFresh = this.freshSessionKeys.has(sessionKey);
    if (!mapping) {
      try {
        // Resume only genuinely-resumable acp sessions; for "main", freshly
        // minted keys, or non-acp historical sessions (telegram/cli/cron) start
        // a new acp session — loadSession would silently fail on those.
        const useNew = tail === "main" || isFresh || !isResumableAcpSessionId(tail);
        const workspace = this.sessionWorkspaceByKey.get(sessionKey) ?? os.tmpdir();
        const acpSessionId = useNew
          ? await client.newSession(workspace)
          : await client.loadSession(tail, workspace);
        assertCurrentGeneration();
        console.log(`[HERMES-DEBUG] ${useNew ? "newSession" : "loadSession"} ok → acpSessionId=${acpSessionId} (isFresh=${isFresh})`);
        mapping = { profile, acpSessionId };
        this.acpSessionByKey.set(sessionKey, mapping);
      } catch (err) {
        assertCurrentGeneration();
        console.log(`[HERMES-DEBUG] session-init FAILED: ${err && err.message ? err.message : String(err)}`);
        const errText = `[Hermes session init error: ${err && err.message ? err.message : String(err)}]`;
        transcript.push({ role: "assistant", content: [{ type: "text", text: errText }], timestamp: Date.now() });
        hooks.final?.(errText, true);
        return;
      }
    }

    let accumulated = "";
    let thought = "";
    let updateCount = 0;
    let promptRes;
    try {
      // Consume the ACP session/update stream. Besides answer text we now also
      // surface streamed reasoning (agent_thought_chunk) and tool lifecycle
      // (tool_call / tool_call_update) so the chat shows thinking + tool cards
      // live, instead of only after the final history reload. Field names are
      // camelCase on the wire (acp serializes session_update→sessionUpdate etc).
      const promptContent = imageBlocks.length
        ? [...(message ? [{ type: "text", text: message }] : []), ...imageBlocks]
        : message;
      promptRes = await client.prompt(mapping.acpSessionId, promptContent, (update) => {
        if (generation !== this._lifecycleGeneration) return;
        updateCount += 1;
        const su = update?.sessionUpdate;
        if (su === "agent_message_chunk" && update.content?.type === "text" && typeof update.content.text === "string") {
          accumulated += update.content.text;
          hooks.delta?.(accumulated);
        } else if (su === "agent_thought_chunk" && update.content?.type === "text" && typeof update.content.text === "string") {
          thought += update.content.text;
          hooks.thinking?.(thought);
        } else if (su === "tool_call") {
          hooks.tool?.({
            toolCallId: update.toolCallId,
            name: update.title || update.kind || "tool",
            args: update.rawInput,
            diff: acpToolDiff(update.content),
            phase: "start",
            isError: update.status === "failed",
          });
        } else if (su === "tool_call_update") {
          const done = update.status === "completed" || update.status === "failed";
          hooks.tool?.({
            toolCallId: update.toolCallId,
            phase: done ? "result" : "update",
            result: acpToolText(update.content),
            isError: update.status === "failed",
          });
        } else if (su === "plan") {
          // ACP plan = the agent's todo list (Hermes translates its `todo` tool into this).
          hooks.plan?.(Array.isArray(update.entries) ? update.entries : []);
        }
      });
      assertCurrentGeneration();
      // ACP also persists lazily: a resolved prompt means rename/delete may
      // now address the canonical server session instead of local-only state.
      this.freshSessionKeys.delete(sessionKey);
      this.freshSessionTransports.delete(sessionKey);
      console.log(`[HERMES-DEBUG] prompt resolved updates=${updateCount} accumulatedLen=${accumulated.length} response=${JSON.stringify(promptRes).slice(0, 300)}`);
    } catch (err) {
      assertCurrentGeneration();
      console.log(`[HERMES-DEBUG] prompt REJECTED updates=${updateCount}: ${err && err.message ? err.message : String(err)}`);
      const errText = `[Hermes ACP error: ${err && err.message ? err.message : String(err)}]`;
      transcript.push({ role: "assistant", content: [{ type: "text", text: errText }], timestamp: Date.now() });
      hooks.final?.(errText, true, { executionUncertain: true });
      return;
    }

    // User-initiated stop (abortChat → ACP session/cancel): the prompt resolves
    // NORMALLY with stopReason "cancelled" — that's a deliberate stop, not a
    // model failure, so it must not fall into the empty-reply error path below
    // (which would flash a red "模型没有返回任何内容" bubble right after the user
    // pressed Stop). Keep any partial answer; else record a quiet stopped note.
    if (promptRes?.stopReason === "cancelled") {
      const note = accumulated || "[已停止生成]";
      transcript.push({ role: "assistant", content: [{ type: "text", text: note }], timestamp: Date.now() });
      hooks.final?.(note, false, { stopReason: "cancelled" });
      return;
    }
    if (accumulated === "") {
      // ACP resolved but produced zero text chunks (some profiles fail this
      // way — model misconfigured, refusal, etc.). Emitting an empty chat:final
      // makes the UI's `shouldReloadHistoryForFinalEvent` fire (because the
      // message is "not renderable"), looping chat.history reloads. Surface as
      // chat:error instead — UI shows lastError + skips reload.
      const errText = this._emptyReplyReason(client, promptRes);
      transcript.push({ role: "assistant", content: [{ type: "text", text: `[${errText}]` }], timestamp: Date.now() });
      hooks.error?.(errText);
      return;
    }
    transcript.push({ role: "assistant", content: [{ type: "text", text: accumulated }], timestamp: Date.now() });
    hooks.final?.(accumulated, false);
  }

  // Turn an empty ACP reply into a legible reason from the agent's recent stderr
  // + the prompt stopReason, so the user sees "模型鉴权失败 401" instead of the
  // opaque "returned no text" (the #1 confusing symptom of Hermes chat).
  _emptyReplyReason(client, promptRes) {
    const stderr = Array.isArray(client?.stderrTail) ? client.stderrTail.join("\n") : "";
    if (/\b401\b|api key is invalid|invalid api key|out of funds|unauthor|AuthenticationError/i.test(stderr)) {
      return "模型鉴权失败（API key 无效或欠费，HTTP 401）。请在 Hermes 对应 profile 重新配置模型密钥后再试。";
    }
    if (/\b429\b|rate limit|quota|insufficient/i.test(stderr)) {
      return "模型额度不足或被限流（429）。请稍后再试或更换模型。";
    }
    if (promptRes?.stopReason === "refusal") {
      return "该历史会话无法继续（可能已失效）。请新建会话后再发送。";
    }
    return "模型没有返回任何内容（可能是模型配置或额度问题）。";
  }

  // ---- cron (management UI) ----

  // Parse a unified cron id "hermes-<profile>:<jobId>" into its dashboard + jobId.
  _cronTarget(id) {
    const idx = String(id || "").indexOf(":");
    const agentId = idx >= 0 ? id.slice(0, idx) : "";
    const jobId = idx >= 0 ? id.slice(idx + 1) : "";
    const profile = this.profileById.get(agentId);
    const dash = profile ? this.dashboards.get(profile) : null;
    if (!dash || !jobId) throw new Error(`hermes-backend: unknown cron id ${id}`);
    return { dash, jobId, agentId, profile };
  }

  // ---- 当天文件（dashboard 产出区，契约见 agent-backend.getRecentArtifacts） ----
  //
  // 根清单按 Hermes 源码核实（懒创建目录不存在即跳过；hook_outputs ≠ hooks
  // 脚本目录，不扫 hooks）；绝不扫描整个 ~/.hermes。外加 cron job 显式声明的
  // 绝对 workdir 与 kanban 任务的 workspace_path（worktree/dir 才有）。
  async _artifactRoots() {
    const candidates = [];
    const subdirs = [
      "cron/output", "output", "images", "image_cache", "audio_cache",
      "cache/images", "cache/documents", "cache/screenshots", "cache/videos", "hook_outputs",
    ];
    for (const profile of this.dashboards.keys()) {
      const agentId = this._agentIdForRoutableProfile(profile);
      if (!agentId) continue;
      const home = hermesHomeForProfile(profile);
      for (const sub of subdirs) {
        candidates.push({ path: path.join(home, sub), area: `${profile}/${sub}`, agentId });
      }
    }
    try {
      const jobs = await this.getCronJobs();
      for (const job of Array.isArray(jobs) ? jobs : []) {
        let wd = typeof job?.workdir === "string" ? job.workdir.trim() : "";
        if (wd.startsWith("~/")) wd = path.join(os.homedir(), wd.slice(2));
        if (wd && path.isAbsolute(wd)) candidates.push({ path: wd, area: "cron-workdir", agentId: job.agentId });
      }
    } catch { /* cron 不可达 → 静态根即可 */ }
    try {
      const entry = this.dashboards.has("default")
        ? ["default", this.dashboards.get("default")]
        : [...this.dashboards.entries()][0] || null;
      const [profile, dash] = entry || [];
      if (dash?.baseUrl && this._agentIdForRoutableProfile(profile)) {
        const { status, json } = await this._httpGetJson(this._kanbanUrl(dash, "/board"), dash.token);
        if (status === 200 && json) {
          for (const col of Array.isArray(json.columns) ? json.columns : []) {
            for (const t of Array.isArray(col?.tasks) ? col.tasks : []) {
              const wp = typeof t?.workspace_path === "string" ? t.workspace_path.trim() : "";
              if (wp && path.isAbsolute(wp)) candidates.push({ path: wp, area: "kanban-workspace" });
            }
          }
        }
      }
    } catch { /* kanban 插件缺席 → 忽略 */ }
    return normalizeArtifactRoots(candidates);
  }

  async getRecentArtifacts({ limit = 20, sinceMs = 0 } = {}) {
    if (this._getConfig().hermesMode === "remote") return { supported: false, reason: "remote", items: [] };
    const roots = await this._artifactRoots();
    if (!roots.length) return { supported: true, items: [] };
    const clamp = (data) => ({
      ...data,
      items: data.items.filter((x) => x.mtimeMs >= sinceMs).slice(0, Math.max(1, limit)),
    });
    const now = Date.now();
    if (this._artifactsCache && now - this._artifactsCache.at < 60_000) {
      return clamp(this._artifactsCache.data);
    }
    if (!this._artifactsScanInFlight) {
      this._artifactsScanInFlight = walkArtifactRoots(roots, {
        maxStats: 2000,
        keep: 100,
        excludeDirs: new Set(["node_modules"]), // workdir/workspace 根可能是代码仓
      })
        .then((items) => {
          const data = { supported: true, items };
          this._artifactsCache = { at: Date.now(), data };
          return data;
        })
        .finally(() => { this._artifactsScanInFlight = null; });
    }
    return clamp(await this._artifactsScanInFlight);
  }

  // 单个 agent(profile) 的产出文件：_artifactRoots 已经给每个根打了 agentId
  // （profile 的 output/images/cache… 与该 profile 的 cron workdir），按它过滤即可。
  async listAgentArtifacts(agentId, { limit = 100 } = {}) {
    if (this._getConfig().hermesMode === "remote") return { supported: false, reason: "remote", items: [] };
    const roots = (await this._artifactRoots()).filter((r) => r.agentId === agentId);
    if (!roots.length) return { supported: true, items: [], total: 0 };
    // 同 OpenClaw：先不截断以得到真实总数，再自己切给 UI 渲染。
    const all = await walkArtifactRoots(roots, {
      maxStats: 2000,
      keep: Number.MAX_SAFE_INTEGER,
      excludeDirs: new Set(["node_modules"]),
    });
    return { supported: true, total: all.length, items: all.slice(0, Math.max(1, limit)) };
  }

  async listSessionArtifacts(agentId, sessionKey, { limit = 50 } = {}) {
    if (this._getConfig().hermesMode === "remote") {
      return { supported: false, reason: "remote", items: [] };
    }
    if (!this.profileById.has(agentId) || !String(sessionKey).startsWith(`agent:${agentId}:`)) {
      return { supported: false, reason: "invalid-request", items: [] };
    }
    const row = this.sessionRows.find((candidate) => candidate.key === sessionKey);
    const sinceMs = Number.isFinite(Number(row?.startedAt)) && Number(row.startedAt) > 0
      ? Number(row.startedAt) : 0;
    if (!sinceMs) {
      return { supported: false, reason: "session-time-unavailable", items: [] };
    }
    let matched;
    try {
      const target = this._sessionTarget(sessionKey);
      const serverId = this._serverSessionId(sessionKey, target.tail);
      const { status, json } = await this._httpGetJson(
        `${target.dash.baseUrl}/api/sessions/${encodeURIComponent(serverId)}/messages`, target.dash.token,
      );
      if (status !== 200 || !Array.isArray(json?.messages)) throw new Error("History unavailable");
      const roots = (await this._artifactRoots()).filter((root) => root.agentId === agentId);
      const home = hermesHomeForProfile(target.profile);
      matched = await collectSessionOutputArtifacts({
        ...sessionArtifactHistory(json.messages, sinceMs), workspace: home, runtimeHome: home,
        outputRoots: roots, sessionCreatedAt: sinceMs, agentId,
      });
    } catch {
      return { supported: false, reason: "provenance-unavailable", items: [] };
    }
    const take = Math.min(Math.max(Math.floor(Number(limit) || 50), 1), 100);
    return {
      supported: true,
      approximate: false,
      sinceMs,
      total: matched.length,
      items: matched.slice(0, take),
    };
  }

  async resolveArtifactPreview(reqPath) {
    if (this._getConfig().hermesMode === "remote") return null;
    const roots = await this._artifactRoots();
    return resolveArtifactPreviewPath(reqPath, roots);
  }

  // GET+JSON 小包装（单测注入点）
  async _httpGetJson(url, token) {
    const { status, body } = await httpGet(url, { token });
    let json = null;
    try { json = JSON.parse(body); } catch { /* 非 JSON 响应 */ }
    return { status, json };
  }

  async _getCronRunSummary(dash, profile, sessionKey) {
    if (!dash || !profile || !sessionKey) return undefined;
    const key = `${dash.baseUrl}\0${profile}\0${sessionKey}`;
    if (this._cronRunSummaryCache.has(key)) return this._cronRunSummaryCache.get(key);
    if (this._cronRunSummaryInflight.has(key)) return this._cronRunSummaryInflight.get(key);
    const pending = (async () => {
      try {
        const { status, json } = await this._httpGetJson(
          `${dash.baseUrl}/api/sessions/${encodeURIComponent(sessionKey)}/messages?profile=${encodeURIComponent(profile)}`,
          dash.token,
        );
        if (status !== 200 || !Array.isArray(json?.messages)) return undefined;
        for (let i = json.messages.length - 1; i >= 0; i -= 1) {
          const message = json.messages[i];
          if (message?.role !== "assistant" || message.display_kind === "hidden") continue;
          if (typeof message.content !== "string") continue;
          const text = message.content.trim();
          if (!text) continue;
          const summary = text.slice(0, 2000);
          this._cronRunSummaryCache.set(key, summary);
          // 结果只服务两行活动摘要；限制条目数，避免长期运行后无界持有历史。
          while (this._cronRunSummaryCache.size > 500) {
            this._cronRunSummaryCache.delete(this._cronRunSummaryCache.keys().next().value);
          }
          return summary;
        }
      } catch {
        // session 仍在落盘、旧版 dashboard 或短暂网络失败：本轮留空且不缓存，
        // 下次 Dashboard 刷新可以自然重试。
      }
      return undefined;
    })().finally(() => this._cronRunSummaryInflight.delete(key));
    this._cronRunSummaryInflight.set(key, pending);
    return pending;
  }

  async _fillCronRunSummaries(runs) {
    const queue = (Array.isArray(runs) ? runs : []).filter((run) => {
      // `/runs.preview` 是 scheduler 注入的用户提示（通常以 [IMPORTANT…]
      // 开头），绝不能作为产出。无论能否恢复转录都先移除它。
      delete run.summary;
      const failed = ["error", "failed"].includes(String(run.status || "").toLowerCase());
      return !failed && run.finishedAt && run.sessionKey && run.agentId;
    });
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        const run = queue[cursor++];
        const profile = this.profileById.get(run.agentId);
        const dash = profile ? this.dashboards.get(profile) : null;
        const summary = await this._getCronRunSummary(dash, profile, run.sessionKey);
        if (summary) run.summary = summary;
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));
  }

  // Dashboard 活动流：真实 per-run 历史。GET /api/cron/jobs/{id}/runs 是
  // v2026.6.19+ 才有的端点（旧版 404 或执行先于 session 创建而返回空行 →
  // 退回 job 级 last-run 合成行并标 latestOnly）；limit 上限 100 且无 offset——这是每次请求的分页上限，
  // 历史本身无限增长，整页 100 条且最旧仍在今天 → truncated。
  // 行 = sessions 行：started_at/ended_at 为秒、无 status/output 字段 →
  // 最新一条合并 job 级 last_status/last_error（否则比旧合成行丢状态）。
  async getRecentCronRuns({ sinceMs = 0, limit = 50 } = {}) {
    let jobs;
    try {
      jobs = await this.getCronJobs();
    } catch {
      return { runs: [] };
    }
    const out = [];
    let latestOnly = false;
    let truncated = false;
    const synthesizeFromJob = (job) => {
      if (!(typeof job?.lastRunAt === "number" && job.lastRunAt >= sinceMs)) return [];
      const latest = synthesizeHermesLastRun(job);
      if (!latest) return [];
      Object.assign(latest, {
        backendId: job.backendId || this.id,
        jobId: job.id,
        jobName: job.name || undefined,
        agentId: job.agentId || undefined,
      });
      return [latest];
    };
    await Promise.all(
      (Array.isArray(jobs) ? jobs : []).map(async (job) => {
        const profile = this.profileById.get(job.agentId);
        const dash = profile ? this.dashboards.get(profile) : null;
        if (!dash) return; // 找不到归属 dashboard 的 job 静默跳过
        const unified = String(job.id || "");
        const localId = unified.includes(":") ? unified.slice(unified.indexOf(":") + 1) : unified;
        try {
          const { status, json } = await this._httpGetJson(
            `${dash.baseUrl}/api/cron/jobs/${encodeURIComponent(localId)}/runs?limit=100`,
            dash.token,
          );
          if (status === 404) {
            latestOnly = true;
            out.push(...synthesizeFromJob(job));
            return;
          }
          if (status !== 200) return; // 单 job 失败静默（铁律 4）
          const rows = Array.isArray(json?.runs) ? json.runs : [];
          const kept = [];
          for (const row of rows) {
            const base = normalizeHermesRunRow(row);
            if (!base || base.startedAt < sinceMs) continue;
            kept.push({
              backendId: this.id,
              jobId: job.id,
              jobName: job.name || undefined,
              agentId: job.agentId || undefined,
              ...base,
            });
          }
          kept.sort((a, b) => b.startedAt - a.startedAt);
          if (rows.length >= 100 && kept.length === rows.length) truncated = true;
          const latest = synthesizeFromJob(job)[0] || null;
          const synthesized = mergeHermesLatestExecution(kept, latest);
          if (synthesized) latestOnly = true;
          out.push(...kept);
        } catch {
          /* 单 job 失败静默 */
        }
      }),
    );
    out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    const capped = Math.max(1, limit);
    if (out.length > capped) truncated = true;
    const selected = out.slice(0, capped);
    // runs.preview 是调度输入，不是产出；全量清掉，但只为首屏最近 100 条 fan-out
    // messages 摘要，避免 Dashboard 的 limit=5000 把冷请求放大成数千次 HTTP。
    for (const run of selected) delete run.summary;
    await this._fillCronRunSummaries(selected.slice(0, CRON_DASHBOARD_SUMMARY_LIMIT));
    const result = { runs: selected };
    if (truncated) result.truncated = true;
    if (latestOnly) result.latestOnly = true;
    return result;
  }

  async getCronJobs() {
    // 官方 GET /api/cron/jobs 默认 ?profile=all（全机聚合）：每个 dashboard 都会
    // 返回所有 profile 的 job，按 dashboard 循环推入就是 1→N 幽灵行（CRON-001）。
    // 每个 dashboard 只查它自己的 ?profile=<name>——owner 即查询目标，天然无重。
    const perDash = await Promise.all(
      [...this.dashboards.entries()].map(async ([profile, dash]) => {
        const agentId = this._agentIdForRoutableProfile(profile);
        if (!agentId) return [];
        try {
          const { status, body } = await httpGet(
            `${dash.baseUrl}/api/cron/jobs?profile=${encodeURIComponent(profile)}`,
            { token: dash.token },
          );
          if (status !== 200) return [];
          const parsed = JSON.parse(body);
          // The HTTP endpoint returns a bare array (list_jobs() -> List[Dict]);
          // the {jobs:[...]} wrapper is only the on-disk file shape.
          const list = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed?.jobs)
              ? parsed.jobs
              : [];
          return list.map((j) => normalizeHermesCronJob(j, agentId));
        } catch {
          return []; /* skip dashboard on failure */
        }
      }),
    );
    // 兜底：旧版 dashboard 忽略 ?profile= 仍返回全机聚合 → 按 raw job id 去重
    // （job id 全局唯一），dashboards 声明顺序首见者赢。归属可能退化到首个
    // dashboard，但操作端点服务端会自动定位属主 profile，不影响可用性。
    const seen = new Set();
    const jobs = [];
    for (const list of perDash) {
      for (const job of list) {
        const rawId = job.id.slice(job.id.indexOf(":") + 1);
        if (seen.has(rawId)) continue;
        seen.add(rawId);
        jobs.push(job);
      }
    }
    return jobs;
  }

  async createCronJob(spec) {
    const agentId = spec?.agentId;
    const profile = agentId ? this.profileById.get(agentId) : null;
    return this._modelMutationGate.withProfiles(
      [profile || "default"],
      `cron-create:${randomUUID()}`,
      () => this._createCronJobUnlocked(spec),
    );
  }

  /** 已持 Profile gate 的 Cron 创建与创建后补丁。 */
  async _createCronJobUnlocked(spec) {
    const agentId = spec?.agentId;
    const profile = agentId ? this.profileById.get(agentId) : null;
    const dash = profile ? this.dashboards.get(profile) : null;
    if (!dash) throw new Error(`hermes-backend: unknown agent ${agentId}`);
    const schedule = unifiedScheduleToHermesString(spec.schedule);
    if (!schedule) throw new Error("hermes-backend: cron spec needs a schedule");
    const q = `?profile=${encodeURIComponent(profile)}`;
    // 官方 CronJobCreate 一次性接受全部自动化字段；"prompt|skills|script 至少一个"
    // 的校验发生在这次 POST——纯脚本任务的 script 必须在首次请求里（CRON-004），
    // 不能创建后再 PUT 补。?profile= 决定归属 home：不传恒落 default。
    const createBody = { prompt: spec.prompt || "", schedule, name: spec.name || "", deliver: spec.deliver || "local" };
    if (typeof spec.script === "string" && spec.script) createBody.script = spec.script;
    if (typeof spec.noAgent === "boolean") createBody.no_agent = spec.noAgent;
    if (Array.isArray(spec.skills) && spec.skills.length) createBody.skills = spec.skills;
    if (typeof spec.model === "string" && spec.model) createBody.model = spec.model;
    if (typeof spec.provider === "string" && spec.provider) createBody.provider = spec.provider;
    if (typeof spec.baseUrl === "string" && spec.baseUrl) createBody.base_url = spec.baseUrl;
    if (Array.isArray(spec.contextFrom) && spec.contextFrom.length) createBody.context_from = spec.contextFrom;
    if (Array.isArray(spec.enabledToolsets) && spec.enabledToolsets.length) createBody.enabled_toolsets = spec.enabledToolsets;
    if (typeof spec.workdir === "string" && spec.workdir) createBody.workdir = spec.workdir;
    const { status, body } = await httpRequest(
      "POST",
      `${dash.baseUrl}/api/cron/jobs${q}`,
      { token: dash.token, body: createBody },
    );
    if (status >= 300) throw new Error(`hermes create cron failed: ${status} ${body}`);
    const created = JSON.parse(body);
    const jobId = created.id;
    // CronJobCreate 不含的字段（repeat、执行 profile 字段）仍需创建后 PUT 补齐。
    const advanced = buildHermesCronUpdates({ repeat: spec.repeat, profile: spec.profile });
    try {
      if (Object.keys(advanced).length) {
        const upd = await httpRequest(
          "PUT",
          `${dash.baseUrl}/api/cron/jobs/${encodeURIComponent(jobId)}${q}`,
          { token: dash.token, body: { updates: advanced } },
        );
        if (upd.status >= 300) throw new Error(`hermes advanced cron update failed: ${upd.status} ${upd.body}`);
      }
      if (spec.enabled === false) {
        const paused = await httpRequest(
          "POST",
          `${dash.baseUrl}/api/cron/jobs/${encodeURIComponent(jobId)}/pause${q}`,
          { token: dash.token },
        );
        if (paused.status >= 300) throw new Error(`hermes pause cron failed: ${paused.status} ${paused.body}`);
      }
      const latest = await httpGet(
        `${dash.baseUrl}/api/cron/jobs/${encodeURIComponent(jobId)}${q}`,
        { token: dash.token },
      );
      if (latest.status !== 200) throw new Error(`hermes get cron after create failed: ${latest.status}`);
      return normalizeHermesCronJob(JSON.parse(latest.body), agentId);
    } catch (err) {
      try {
        await httpRequest(
          "DELETE",
          `${dash.baseUrl}/api/cron/jobs/${encodeURIComponent(jobId)}${q}`,
          { token: dash.token },
        );
      } catch {
        /* 回滚失败时保留原始错误，避免掩盖创建后补丁失败的根因。 */
      }
      throw err;
    }
  }

  async updateCronJob(id, patch) {
    const target = this._cronTarget(id);
    return this._modelMutationGate.withProfiles(
      [target.profile],
      `cron-update:${randomUUID()}`,
      () => this._updateCronJobUnlocked(id, patch),
    );
  }

  /** 已持 Profile gate 的 Cron 更新。 */
  async _updateCronJobUnlocked(id, patch) {
    const { dash, jobId, agentId, profile } = this._cronTarget(id);
    // 官方 job 端点的 ?profile= 可选（不传则服务端全机扫描定位属主）；
    // 传上它把操作置顶到 unified id 声明的属主 home（CRON-001）。
    const q = `?profile=${encodeURIComponent(profile)}`;
    const src = patch || {};
    // enable/disable maps to Hermes' dedicated pause/resume endpoints.
    if (typeof src.enabled === "boolean") {
      const action = src.enabled ? "resume" : "pause";
      const { status, body } = await httpRequest(
        "POST",
        `${dash.baseUrl}/api/cron/jobs/${encodeURIComponent(jobId)}/${action}${q}`,
        { token: dash.token },
      );
      if (status >= 300) throw new Error(`hermes ${action} cron failed: ${status} ${body}`);
    }
    // Hermes wants raw storage field names for its dashboard update endpoint.
    const rest = buildHermesCronUpdates(src);
    delete rest.enabled;
    if (Object.keys(rest).length) {
      const { status, body } = await httpRequest(
        "PUT",
        `${dash.baseUrl}/api/cron/jobs/${encodeURIComponent(jobId)}${q}`,
        { token: dash.token, body: { updates: rest } },
      );
      if (status >= 300) throw new Error(`hermes update cron failed: ${status} ${body}`);
    }
    const { status, body } = await httpGet(
      `${dash.baseUrl}/api/cron/jobs/${encodeURIComponent(jobId)}${q}`,
      { token: dash.token },
    );
    if (status !== 200) throw new Error(`hermes get cron after update failed: ${status}`);
    return normalizeHermesCronJob(JSON.parse(body), agentId);
  }

  async deleteCronJob(id) {
    const target = this._cronTarget(id);
    return this._modelMutationGate.withProfiles(
      [target.profile],
      `cron-delete:${randomUUID()}`,
      () => this._deleteCronJobUnlocked(id),
    );
  }

  /** 已持 Profile gate 的 Cron 删除。 */
  async _deleteCronJobUnlocked(id) {
    const { dash, jobId, profile } = this._cronTarget(id);
    const { status, body } = await httpRequest(
      "DELETE",
      `${dash.baseUrl}/api/cron/jobs/${encodeURIComponent(jobId)}?profile=${encodeURIComponent(profile)}`,
      { token: dash.token },
    );
    if (status >= 300) throw new Error(`hermes delete cron failed: ${status} ${body}`);
  }

  async runCronJob(id) {
    const { dash, jobId, agentId, profile } = this._cronTarget(id);
    const { status, body } = await httpRequest(
      "POST",
      `${dash.baseUrl}/api/cron/jobs/${encodeURIComponent(jobId)}/trigger?profile=${encodeURIComponent(profile)}`,
      { token: dash.token },
    );
    if (status >= 300) throw new Error(`hermes trigger cron failed: ${status} ${body}`);
    try {
      return normalizeHermesCronJob(JSON.parse(body), agentId);
    } catch {
      return null;
    }
  }

  // 详情页 run 历史：官方 GET /api/cron/jobs/{id}/runs 是真实 per-run 记录（行=会话，
  // 无 per-run status——只把 job 的 last_* 叠加到最新一条，与 getRecentCronRuns 同一
  // 世界观）。旧版 Hermes 无该端点，或执行在创建 session 前失败而返回 200 空行
  // 时，退回 last_* 合成单条。
  // filters 本地应用：status/deliveryStatus/limit/offset/sortDir。
  async getCronRuns(id, options = {}) {
    try {
      const { dash, jobId, profile } = this._cronTarget(id);
      const q = `?profile=${encodeURIComponent(profile)}`;
      const jobResp = await httpGet(
        `${dash.baseUrl}/api/cron/jobs/${encodeURIComponent(jobId)}${q}`,
        { token: dash.token },
      );
      if (jobResp.status !== 200) return { runs: [] };
      let job = JSON.parse(jobResp.body);
      try {
        const listResp = await httpGet(`${dash.baseUrl}/api/cron/jobs${q}`, { token: dash.token });
        if (listResp.status === 200) {
          const parsed = JSON.parse(listResp.body);
          const list = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed?.jobs)
              ? parsed.jobs
              : [];
          const listed = list.find((item) => String(item?.id || "") === String(jobId));
          if (listed) job = { ...job, ...listed };
        }
      } catch {
        // Older dashboards may not expose a usable list snapshot here. Keep the
        // detail response and fall back to conservative legacy correlation.
      }
      const runsResp = await httpGet(
        `${dash.baseUrl}/api/cron/jobs/${encodeURIComponent(jobId)}/runs${q}&limit=100`,
        { token: dash.token },
      );
      let runs;
      if (runsResp.status === 200) {
        let rows = [];
        try {
          const j = JSON.parse(runsResp.body);
          rows = Array.isArray(j?.runs) ? j.runs : Array.isArray(j) ? j : [];
        } catch {
          rows = [];
        }
        runs = rows
          .map((r) => normalizeHermesRunRow(r))
          .filter(Boolean)
          .map((run) => ({
            ...run,
            durationMs: run.finishedAt ? run.finishedAt - run.startedAt : undefined,
          }));
        runs.sort((a, b) => b.startedAt - a.startedAt);
        mergeHermesLatestExecution(runs, synthesizeHermesLastRun(job));
      } else {
        const synthesized = synthesizeHermesLastRun(job);
        runs = synthesized ? [synthesized] : [];
      }
      if (options.status) runs = runs.filter((r) => r.status === options.status);
      if (options.deliveryStatus) runs = runs.filter((r) => r.deliveryStatus === options.deliveryStatus);
      if (options.sortDir === "asc") runs.reverse();
      const offset = Number(options.offset) > 0 ? Number(options.offset) : 0;
      const limit = Number(options.limit) > 0 ? Number(options.limit) : 20;
      return { runs: runs.slice(offset, offset + limit) };
    } catch {
      return { runs: [] };
    }
  }

  async getCronLatestDelivery(id, atMs) {
    try {
      const { agentId } = this._cronTarget(id);
      const { runs } = await this.getCronRuns(id);
      const run = runs[0];
      // Delivery info only exists on the newest run (the job's last_* overlay).
      // A click on an occurrence from a different day has no matching report to
      // show, so don't pass off the last run as that day's.
      if (
        run &&
        typeof atMs === "number" &&
        Number.isFinite(atMs) &&
        typeof run.startedAt === "number" &&
        !sameLocalDay(run.startedAt, atMs)
      ) {
        return { source: "none" };
      }
      if (!run) return { source: "none" };
      const base = {
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        durationMs: run.durationMs,
        model: run.model,
        provider: run.provider,
        sessionKey: run.sessionKey,
        error: run.error,
        deliveryStatus: run.deliveryStatus,
      };
      // 失败运行的最后一条 assistant 可能只是中间进度，不能冒充最终报告。
      const failed = ["error", "failed"].includes(String(run.status || "").toLowerCase());
      if (failed || !run.sessionKey) {
        return { ...base, fullText: null, source: "none" };
      }
      try {
        const messages = await this._fetchHistoricalMessages(`agent:${agentId}:${run.sessionKey}`);
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          const message = messages[i];
          if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
          const text = message.content
            .filter((part) => part?.type === "text" && typeof part.text === "string")
            .map((part) => part.text)
            .join("\n")
            .trim();
          if (text) return { ...base, fullText: text, source: "transcript" };
        }
      } catch {
        // 旧版 dashboard 或已清理的 session 没有 messages：保留运行状态并安全降级。
      }
      return {
        ...base,
        fullText: null,
        source: "none",
      };
    } catch {
      return { source: "none" };
    }
  }

  // Hermes cron run 是普通 session；dashboard 的 messages 端点保留 reasoning、
  // tool_calls、tool_call_id 与消息时间戳，足以映射成和 OpenClaw 相同的轨迹契约。
  async getCronRunTrajectory(id, { sessionKey } = {}) {
    if (!sessionKey) return { supported: false, reason: "no-session", parts: [] };
    let target;
    try {
      target = this._cronTarget(id);
    } catch {
      return { supported: false, reason: "unavailable", parts: [] };
    }
    let response;
    try {
      response = await httpGet(
        `${target.dash.baseUrl}/api/sessions/${encodeURIComponent(sessionKey)}/messages?profile=${encodeURIComponent(target.profile)}`,
        { token: target.dash.token },
      );
    } catch {
      return { supported: false, reason: "unavailable", parts: [] };
    }
    if (response.status === 404) return { supported: false, reason: "no-transcript", parts: [] };
    if (response.status !== 200) return { supported: false, reason: "unavailable", parts: [] };
    let messages;
    try {
      const parsed = JSON.parse(response.body);
      messages = Array.isArray(parsed?.messages) ? parsed.messages : null;
    } catch {
      messages = null;
    }
    if (!messages) return { supported: false, reason: "invalid", parts: [] };

    const CAP = 4000;
    const clip = (value) => typeof value === "string" ? value.slice(0, CAP) : "";
    const tsOf = (value) => {
      const raw = Number(value);
      if (!Number.isFinite(raw) || raw <= 0) return undefined;
      return Math.round(raw < 1e12 ? raw * 1000 : raw);
    };
    const parts = [];
    for (const message of messages) {
      if (!message || typeof message !== "object" || message.display_kind === "hidden") continue;
      const ts = tsOf(message.timestamp);
      if (message.role === "assistant") {
        const reasoning =
          (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) ||
          (typeof message.reasoning === "string" && message.reasoning.trim()) ||
          "";
        if (reasoning) parts.push({ type: "thinking", text: clip(reasoning), ts });
        for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
          if (!call || typeof call !== "object") continue;
          const fn = call.function && typeof call.function === "object" ? call.function : call;
          let toolArgs;
          const rawArgs = fn.arguments;
          if (typeof rawArgs === "string" && rawArgs.trim()) {
            try {
              const parsed = JSON.parse(rawArgs);
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) toolArgs = parsed;
            } catch {
              /* 无法解析的参数不阻断整条轨迹。 */
            }
          } else if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
            toolArgs = rawArgs;
          }
          parts.push({
            type: "toolCall",
            toolCallId: typeof call.id === "string" ? call.id : typeof call.call_id === "string" ? call.call_id : undefined,
            toolName: typeof fn.name === "string" && fn.name ? fn.name : undefined,
            toolArgs,
            ts,
          });
        }
        if (typeof message.content === "string" && message.content.trim()) {
          parts.push({ type: "text", text: clip(message.content), ts });
        }
      } else if (message.role === "tool") {
        let text = "";
        if (typeof message.content === "string") {
          text = message.content;
        } else if (message.content != null) {
          try { text = JSON.stringify(message.content); } catch { /* 留空 */ }
        }
        parts.push({
          type: "toolResult",
          toolCallId: typeof message.tool_call_id === "string" ? message.tool_call_id : undefined,
          toolName: typeof message.tool_name === "string" && message.tool_name ? message.tool_name : undefined,
          text: clip(text),
          ...((message.is_error === true || message.isError === true) ? { isError: true } : {}),
          ts,
        });
      }
    }
    if (!parts.length) return { supported: false, reason: "empty", parts: [] };
    return { supported: true, parts };
  }

  // ---- lifecycle ----

  // Awaits the spawned dashboards' exit. kill() is asynchronous, and a caller that
  // restarts immediately (reconfigure / post-update) would otherwise scrape a token
  // off the still-dying process, "reuse" it, and be left with no dashboard when it
  // finally exits.
  // keepProcesses（仅 app 正常退出且用户开了 hermesKeepAlive 时为 true）：保留自己
  // spawn 的 dashboard 进程留给下次启动认领复用——冷启动是这里最贵的一段（每个
  // profile 一个 Python 进程，真机 default 约 9s）。保留的只是**进程**：下面的连接/
  // 会话/代际清理照旧全做，重启后一切从 _spawnOrReuseDashboard 的复用分支重新建立。
  // 注意复用来的 dashboard（spawned=false, proc=null）本来就不在杀的范围内。
  async stop({ keepProcesses = false } = {}) {
    // 先切代际并清空所有跨模式聊天状态；后续迟到的旧异步任务会据此放弃回写。
    this._lifecycleGeneration += 1;
    this._cliUsageCache = null;
    this._cliUsageScanInFlight = null;
    this._skillUsageCache = null;
    this._skillUsageScanInFlight = null;
    this._startingAt = 0;
    this._startInFlight = null;
    this._sessionRowsComplete = false;
    this.sessionRows = [];
    this.transcripts.clear();
    this.freshSessionKeys.clear();
    this.freshSessionTransports.clear();
    this.sessionWorkspaceByKey.clear();
    this.sendQueues.clear();
    this._idempotentSends.clear();
    this.acpSessionByKey.clear();
    for (const [runtimeId, turn] of [...this.gwTurns]) this._gwEndTurn(runtimeId, turn);
    for (const sock of this.gwSockets.values()) {
      try { sock.close(); } catch { /* already closed */ }
    }
    this.gwSockets.clear();
    this.gwRuntimeByKey.clear();
    this.gwKeyByRuntime.clear();
    this.gwTurns.clear();
    this.gwUsageByKey.clear();
    this.gwChatDisabledUntil.clear();
    this.sessionLiveMeta.clear();
    this.gwLastFinalMeta?.clear?.();
    if (this.sessionsRefreshTimer) {
      clearInterval(this.sessionsRefreshTimer);
      this.sessionsRefreshTimer = null;
    }
    const exits = [];
    const terminating = new Set();
    for (const proc of this._pendingDashboardProcs) {
      if (!proc || terminating.has(proc)) continue;
      terminating.add(proc);
      exits.push(waitForExit(proc));
      signalDashboardProcess(proc);
    }
    this._pendingDashboardProcs.clear();
    let kept = 0;
    for (const dash of this.dashboards.values()) {
      if (dash.spawned && dash.proc) {
        if (keepProcesses) {
          // 脱离本进程的等待：不 unref 的话 Electron 主进程会为了子进程赖着不退。
          try { dash.proc.unref(); } catch { /* already gone */ }
          kept += 1;
          continue;
        }
        if (terminating.has(dash.proc)) continue;
        terminating.add(dash.proc);
        exits.push(waitForExit(dash.proc));
        signalDashboardProcess(dash.proc);
      }
    }
    if (kept > 0) console.log(`[hermes] 保留 ${kept} 个 dashboard 进程供下次启动复用（hermesKeepAlive）`);
    this.dashboards.clear();
    // ACP 子进程即使 keepProcesses 也照杀：它是聊天降级路径按需拉起的，不承载状态，
    // 留着只是白占内存（dashboard 才是启动耗时的大头）。
    for (const client of this.acpClients.values()) {
      try {
        client.stop();
      } catch {
        /* already stopped */
      }
    }
    this.acpClients.clear();
    await Promise.all(exits);
  }
}

module.exports = {
  HermesBackend,
  HermesCatalogUnavailableError,
  agentIdForProfile,
  normalizeHermesCronJob,
  buildHermesCronUpdates,
  __test: {
    http: { httpGet, httpRequest, httpRaw },
  },
};
