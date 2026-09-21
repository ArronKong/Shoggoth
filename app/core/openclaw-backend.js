"use strict";

// OpenClaw backend — a real gateway RPC client.
//
// The Control UI used to drive all OpenClaw traffic itself (the proxy just
// relayed the browser's WS frames). Now that the React control plane owns the
// management pages, OpenClaw data (cron, later skills/models/usage/agents) has
// no UI driving it — so this backend opens its OWN authenticated WS connection
// to the upstream gateway and calls `cron.*` etc. directly.
//
// Auth reuses the operator device identity already on disk
// (~/.openclaw/identity/device.json + device-auth.json). We replicate the
// gateway's device-auth v2 handshake (the same one the browser Control UI
// performs): connect → receive `connect.challenge {nonce}` → send a signed
// `connect` request → receive HelloOk. No interactive pairing.
//
// NOTE: chat / agents / models / sessions still flow through the passthrough
// proxy untouched, so getAgents()/getModelChoices()/getSessionRows() stay empty
// here — this backend only contributes the management RPC data the proxy can't.

const fs = require("node:fs");
const { providerPublicDigest } = require("./openclaw-model-change");
const { renameProvider, renameDigest, configReferences: providerRenameReferences, profileRef: renameProfileRef } = require("./openclaw-provider-rename");
const { projectKeyDigests, readCanonicalKeyDigests } = require("./openclaw-key-digests");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawnSync } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const { WebSocket } = require("ws");
const { pinyin } = require("pinyin-pro");
const {
  AgentBackend,
  dirCreatedAtMs,
  sortAgentsByCreatedAt,
  WIDGET_RESOURCE_MAX_BYTES,
  SESSION_BOARD_HTML_MAX_BYTES,
  normalizeWidgetResourceContentType,
  normalizeSessionBoardHtmlWidgetSpec,
  projectStandingGrantForBrowser,
  projectStandingGrantRevokeResult,
} = require("./agent-backend");
const { OpenClawUpdateController } = require("./openclaw-self-updater");
const { compareVersions } = require("./version-checker");
const { workboardCardToActivities } = require("./dashboard-activity");
const { normalizeArtifactRoots, walkArtifactRoots, resolveArtifactPreviewPath } = require("./artifact-scan");
const { collectSessionOutputArtifacts, sessionArtifactHistory } = require("./session-output-artifacts");
const { scanUsageCube, cubeToSeries, cubeToBreakdown } = require("./usage-file-scan");
const {
  buildConnectParams,
  classifyAuthError,
  createAuthResolver,
  safeParse,
} = require("./device-auth");
const {
  assertSupportedOpenClawHello,
  sanitizeOpenClawHello,
  hasGatewayMethod,
  hasGatewayScope,
  hasGatewayCapability,
} = require("./openclaw-2-contract");
const {
  advancedSessionMethodMap,
  unsupportedAdvancedSessionResult,
  projectEnvironmentInventory,
  projectSessionDescribeResult,
  projectSessionBranchesResult,
  projectSessionForkResult,
} = require("./session-advanced-projection");
const {
  CANVAS_DOCUMENT_CAPABILITY,
  sessionBoardMethodMap,
  sessionBoardCapabilityMap,
  unsupportedSessionBoardResult,
  projectSessionBoardResult,
  normalizeSessionBoardAgentId,
  normalizeSessionBoardSessionKey,
  normalizeSessionBoardOps,
  normalizeSessionBoardCanvasSpec,
  normalizeSessionBoardGrantSpec,
} = require("./session-board-projection");
const {
  readCanonicalAgentEntries,
  readDefaultModelPolicyAllow,
} = require("./openclaw-agent-config");

const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18792";
// OpenClaw 的 files.list 会省略 IDENTITY.md，但 files.get/set 仍支持它。
// 核心档案始终可选（不存在时由 get 返回 missing），其余条目保留网关清单。
const CORE_AGENT_FILE_NAMES = ["AGENTS.md", "IDENTITY.md", "SOUL.md", "USER.md", "MEMORY.md"];

// OpenClaw src/config/types.models.ts 的 MODEL_APIS；本仓不依赖其安装目录，
// 因此在 provider 元数据层保留一份冻结快照，供端点表单枚举合法协议。
const OPENCLAW_MODEL_APIS = Object.freeze([
  "openai-completions",
  "openai-responses",
  "openai-chatgpt-responses",
  "anthropic-messages",
  "google-generative-ai",
  "google-vertex",
  "github-copilot",
  "bedrock-converse-stream",
  "ollama",
  "azure-openai-responses",
]);

// GUI-launched .app 的 PATH 修复（main.js 灌 login-shell PATH）可能超时降级，
// 自更新命令照 hermes-backend resolveHermesBin 的模式先探已知安装位置。
function resolveOpenclawBin() {
  if (process.env.OPENCLAW_BIN) return process.env.OPENCLAW_BIN;
  const candidates = [
    "/opt/homebrew/bin/openclaw",
    "/usr/local/bin/openclaw",
    path.join(os.homedir(), ".npm-global", "bin", "openclaw"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile() || fs.lstatSync(candidate).isSymbolicLink()) return candidate;
    } catch {
      /* not present, try next */
    }
  }
  return "openclaw"; // last resort — relies on PATH
}

// gateway 的结构化日志目录（launchd 拉起时 stderr 常被丢进 /dev/null，启动
// 失败的真实原因只存在这里）。文件按天滚动：openclaw-YYYY-MM-DD.log。
const OPENCLAW_LOG_DIR = "/tmp/openclaw";
const OPENCLAW_LOG_SCAN_BYTES = 1024 * 1024; // 只读尾部。健康检查在失败后几十秒内跑，
// Reason 行就在末尾附近；1MB ≈ 正常流量一整天的量，留足崩溃循环的啰嗦余量。
const REASON_MARKER = "[openclaw] Reason:";
const REASON_MAX_CHARS = 700;

// 更新后 gateway 起不来时，从日志抓「拒绝就绪」的原因（如 startup migrations
// did not complete cleanly）。每行一个 JSON（tslog），原因全文在 "0" 字段。
// 只认 sinceMs 之后的行——别把历史事故的旧原因翻出来误导本次诊断。
function readGatewayFailureReason(sinceMs) {
  try {
    // 取最新两天的文件：崩溃可能发生在跨午夜滚动的边上。
    const files = fs
      .readdirSync(OPENCLAW_LOG_DIR)
      .filter((f) => /^openclaw-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .sort()
      .slice(-2);
    let reason = "";
    for (const file of files) {
      const full = path.join(OPENCLAW_LOG_DIR, file);
      const size = fs.statSync(full).size;
      const want = Math.min(size, OPENCLAW_LOG_SCAN_BYTES);
      if (!want) continue;
      const buf = Buffer.alloc(want);
      const fd = fs.openSync(full, "r");
      try {
        fs.readSync(fd, buf, 0, want, size - want);
      } finally {
        fs.closeSync(fd);
      }
      for (const line of buf.toString("utf8").split("\n")) {
        if (!line.includes(REASON_MARKER)) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue; // 尾部截读的首行可能只剩半截 JSON
        }
        const time = Date.parse(entry?.time || entry?._meta?.date || "");
        if (Number.isFinite(sinceMs) && Number.isFinite(time) && time < sinceMs) continue;
        const msg = typeof entry?.["0"] === "string" ? entry["0"] : "";
        const at = msg.indexOf(REASON_MARKER);
        if (at === -1) continue;
        reason = msg.slice(at + REASON_MARKER.length).trim(); // 留最后一条=最新
      }
    }
    return reason.length > REASON_MAX_CHARS ? `${reason.slice(0, REASON_MAX_CHARS)}…` : reason;
  } catch {
    return ""; // 日志读不到就退回连接层错误
  }
}

// Cap how many messages we lift out of each sealed/rotated transcript segment so
// a pathologically long archived session can't balloon one /__api response.
const ARCHIVE_MAX_PER_SEGMENT = 2000;
// 协议身份串(CLIENT_ID="openclaw-control-ui" 等)与 operator scopes 随握手迁到
// core/device-auth.js —— 没被删除,别在那边「清理」(见 ARCHITECTURE §9 雷区)。
const CONNECT_TIMEOUT_MS = 8000;
const REQUEST_TIMEOUT_MS = 10000;
// A full 9.1 catalog read may need to rebuild a stale gateway-owned generation.
// Give it a bounded budget separate from ordinary RPCs.
const MODEL_CATALOG_REFRESH_TIMEOUT_MS = 60000;
const WIDGET_RESOURCE_TIMEOUT_MS = 8000;
const CANVAS_WIDGET_PATH_PREFIX = "/__openclaw__/canvas/documents/";
const BOARD_WIDGET_PATH_PREFIX = "/__openclaw__/board/";
const BOARD_VIEW_TICKET_MAX_LENGTH = 2048;
const CRON_LIST_PAGE_SIZE = 200;
const CRON_LIST_MAX_PAGES = 50;
const CRON_LIST_MAX_SNAPSHOT_RESTARTS = 3;
const LOOPBACK_GATEWAY_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const INVALID_PROVIDER_ENDPOINT_DIGEST_INPUT = "[invalid-provider-endpoint]";

/**
 * Accept only the 8.1 canonical Canvas document namespace. Decode each path
 * segment exactly once for traversal/control checks, while retaining the raw
 * encoded path for the upstream request.
 */
function normalizeCanvasWidgetResourcePath(value) {
  if (typeof value !== "string" || value.length > 4096) return null;
  if (!value.startsWith(CANVAS_WIDGET_PATH_PREFIX) || value.includes("?") || value.includes("#")) {
    return null;
  }
  const rawSegments = value.slice(CANVAS_WIDGET_PATH_PREFIX.length).split("/");
  if (rawSegments.length < 2 || rawSegments.length > 32) return null;

  const decoded = [];
  for (const rawSegment of rawSegments) {
    if (!rawSegment || rawSegment.length > 768) return null;
    let segment;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return null;
    }
    if (
      !segment ||
      segment.length > 255 ||
      segment === "." ||
      segment === ".." ||
      /[\\/:\0\x00-\x1f\x7f]/.test(segment)
    ) {
      return null;
    }
    decoded.push(segment);
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(decoded[0])) return null;
  return value;
}

/** Build a Canvas HTTP URL exclusively from the configured gateway origin. */
function gatewayHttpResourceUrl(gatewayUrl, resourcePath) {
  const safePath = normalizeCanvasWidgetResourcePath(resourcePath);
  if (!safePath) return null;
  try {
    const target = new URL(String(gatewayUrl || ""));
    if ((target.protocol !== "ws:" && target.protocol !== "wss:")
      || !target.hostname || target.username || target.password) return null;
    target.protocol = target.protocol === "wss:" ? "https:" : "http:";
    target.pathname = safePath;
    target.search = "";
    target.hash = "";
    return target;
  } catch {
    return null;
  }
}

async function readWidgetResourceBody(response) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > WIDGET_RESOURCE_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function isStrictUtf8(value) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value).length
      <= SESSION_BOARD_HTML_MAX_BYTES;
  } catch {
    return false;
  }
}

async function readSessionBoardHtmlBody(response) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > SESSION_BOARD_HTML_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function gatewayHttpOrigin(gatewayUrl) {
  try {
    const target = new URL(String(gatewayUrl || ""));
    if ((target.protocol !== "ws:" && target.protocol !== "wss:")
      || !target.hostname || target.username || target.password) return null;
    target.protocol = target.protocol === "wss:" ? "https:" : "http:";
    return target.origin;
  } catch {
    return null;
  }
}

function isBoardViewTicket(value) {
  return typeof value === "string"
    && value.length >= 6
    && value.length <= BOARD_VIEW_TICKET_MAX_LENGTH
    && /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

function sessionBoardHtmlRequestUrl(gatewayUrl, frameUrl, sessionKey, name, viewTicket) {
  if (typeof frameUrl !== "string" || frameUrl.length === 0 || frameUrl.length > 8192
    || frameUrl !== frameUrl.trim() || /[\0\r\n]/.test(frameUrl)
    || !isBoardViewTicket(viewTicket)) return null;
  const origin = gatewayHttpOrigin(gatewayUrl);
  if (!origin) return null;
  try {
    const target = new URL(frameUrl, `${origin}/`);
    const expectedPath = `${BOARD_WIDGET_PATH_PREFIX}${encodeURIComponent(sessionKey)}`
      + `/${encodeURIComponent(name)}/index.html`;
    const query = [...target.searchParams.entries()];
    if (target.origin !== origin || target.username || target.password
      || target.pathname !== expectedPath || target.hash
      || query.length !== 1 || query[0][0] !== "bt" || query[0][1] !== viewTicket) {
      return null;
    }
    return target;
  } catch {
    return null;
  }
}

/**
 * 生成 Provider 端点摘要的无凭据输入。有效 URL 保留协议、主机、端口与路径，
 * 但剥离 userinfo/query/hash；无效 URL 统一拒绝进入摘要，避免误收任意凭据文本。
 */
function providerEndpointDigestInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return INVALID_PROVIDER_ENDPOINT_DIGEST_INPUT;
  }
}

// 统一解析本机 OpenClaw 数据根目录；所有磁盘型能力都必须尊重 OPENCLAW_HOME。
function resolveOpenClawHome() {
  return path.resolve(process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw"));
}

const OPENCLAW_AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const OPENCLAW_AGENT_ID_INVALID_RE = /[^a-z0-9_-]+/g;
const OPENCLAW_CREATE_EMOJIS = Object.freeze([
  "🦞", "🐙", "🦑", "🦀", "🦊", "🐺", "🐱", "🐶", "🐼", "🐨",
  "🐯", "🐸", "🦉", "🐧", "🐢", "🦋", "🐝", "🦕", "🐲", "🦄",
  "👻", "👽", "🌙", "⭐", "🔥", "❄️", "🍀", "🧿", "💎", "⚡",
]);

function normalizeOpenClawAgentId(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return "";
  const latin = /[\u4e00-\u9fff]/.test(trimmed)
    ? pinyin(trimmed, {
        toneType: "none",
        type: "string",
        separator: "",
        v: true,
        nonZh: "consecutive",
      })
    : trimmed;
  if (!latin) return "";
  const lower = latin.toLowerCase();
  return OPENCLAW_AGENT_ID_RE.test(latin)
    ? lower
    : lower.replace(OPENCLAW_AGENT_ID_INVALID_RE, "-").replace(/^-+/, "").replace(/-+$/, "").slice(0, 64);
}

function defaultOpenClawAgentWorkspace(name) {
  const id = normalizeOpenClawAgentId(name);
  if (!id || id === "main") return "";
  return path.join(resolveOpenClawHome(), "agents", id);
}

function randomOpenClawCreateEmoji() {
  const index = Math.floor(Math.random() * OPENCLAW_CREATE_EMOJIS.length);
  return OPENCLAW_CREATE_EMOJIS[index] || "🦞";
}

// agentId 只能是一个无控制字符的文件名单段，并在 path.resolve 后再次验证
// containment；这样即使调用层漏校验，也不能越出 <OPENCLAW_HOME>/agents。
function resolveOpenClawSessionsDir(agentId) {
  const id = typeof agentId === "string" ? agentId : "";
  if (
    !id ||
    id === "." ||
    id === ".." ||
    /[\\/\0\x00-\x1f\x7f]/.test(id)
  ) {
    throw new Error("openclaw: invalid agent id");
  }
  const agentsRoot = path.resolve(resolveOpenClawHome(), "agents");
  const agentRoot = path.resolve(agentsRoot, id);
  const relative = path.relative(agentsRoot, agentRoot);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("openclaw: invalid agent id containment");
  }
  return path.join(agentRoot, "sessions");
}

// URL.hostname 在不同 Node 版本里可能返回 ::1 或 [::1]，两种形式统一视为本机。
function isLoopbackGatewayUrl(url) {
  try {
    return LOOPBACK_GATEWAY_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

// 从当前 sessionFile 推导会话专属文件名后缀（例如 Telegram Topic 的
// "-topic-3"）。前代物理 session 复用该后缀；普通会话则只返回裸 UUID。
function archiveTranscriptStemCandidates(entry, sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) return [];
  const currentId = String(entry?.sessionId || "").trim();
  const sessionFile = typeof entry?.sessionFile === "string" ? path.basename(entry.sessionFile) : "";
  const extension = ".jsonl";
  let suffix = "";
  if (currentId && sessionFile.startsWith(currentId) && sessionFile.endsWith(extension)) {
    suffix = sessionFile.slice(currentId.length, -extension.length);
  }
  return suffix ? [...new Set([`${id}${suffix}`, id])] : [id];
}

// 只接受精确的 transcript 文件名或其 reset 归档前缀，避免把同 UUID 的
// `.trajectory.jsonl` sidecar 当成聊天 transcript 读取。
function findArchiveTranscriptFile(files, stems) {
  const names = Array.isArray(files) ? files.filter((file) => typeof file === "string") : [];
  const known = new Set(names);
  for (const rawStem of stems || []) {
    const stem = String(rawStem || "").trim();
    if (!stem) continue;
    const live = `${stem}.jsonl`;
    if (known.has(live)) return { file: live, fromReset: false };
    const resetPrefix = `${live}.reset.`;
    const sealed = names.find((file) => file.startsWith(resetPrefix));
    if (sealed) return { file: sealed, fromReset: true };
  }
  return null;
}
// The gateway enforces an Origin allowlist for webchat-mode connects, but grants
// a "local-loopback" pass to any local socket client presenting a loopback-host
// Origin (origin-check.ts). A bare loopback origin is the safe default; Electron
// overrides it with the real page origin so remote gateways match their allowlist.
const DEFAULT_ORIGIN = "http://127.0.0.1";

// Same calendar day in local time (the desktop app, gateway, and calendar UI
// all run on one machine, so local-day comparison is consistent across them).
function sameLocalDay(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

// ---- recent-artifacts scan rules (dashboard 产出文件区) ----

// Directories never entered (transcripts, agent memory, cloned repos' deps).
const ARTIFACT_EXCLUDE_DIRS = new Set(["sessions", "memory", "node_modules", "agent"]);
// Extensions that are process residue, not work products.
const ARTIFACT_EXCLUDE_EXTS = new Set([".jsonl", ".bak", ".lock", ".tmp", ".log"]);
// Agent identity/state scaffolding living at workspace roots — config, not output.
const ARTIFACT_IDENTITY_FILES = new Set([
  "SOUL.md", "IDENTITY.md", "AGENTS.md", "TOOLS.md", "USER.md", "HEARTBEAT.md",
  "MEMORY.md", "NOW.md", "DREAMS.md", "ONBOARDING.md", "BOOTSTRAP.md",
  "sessions.json", "openclaw-workspace-state.json",
]);
const ARTIFACT_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".heic"]);
const ARTIFACT_DOC_EXTS = new Set([".md", ".txt", ".pdf", ".html", ".docx", ".pptx"]);
const ARTIFACT_DATA_EXTS = new Set([".json", ".csv", ".xlsx", ".yaml", ".yml", ".toml", ".sqlite", ".db"]);

function artifactKind(ext) {
  if (ARTIFACT_IMAGE_EXTS.has(ext)) return "image";
  if (ARTIFACT_DOC_EXTS.has(ext)) return "doc";
  if (ARTIFACT_DATA_EXTS.has(ext)) return "data";
  return "other";
}

// "agent:<agentId>:…" → agentId (cron run sessionKeys carry the owning agent).
function agentIdFromSessionKey(sessionKey) {
  const m = /^agent:([^:]+):/.exec(String(sessionKey || ""));
  return m ? m[1] : undefined;
}

// ---- ed25519 device-auth crypto ----
// 已收拢到 core/device-auth.js(单一认证模块,偿还 ARCHITECTURE §12 重复债);
// 本文件只 require:buildConnectParams / classifyAuthError / createAuthResolver / safeParse。

// ---- cron normalization (CronJob → UnifiedCronJob) ----

function cronScheduleDisplay(schedule) {
  const s = schedule || {};
  if (s.kind === "cron") return s.expr || "";
  if (s.kind === "every") return `每 ${Math.round((Number(s.everyMs) || 0) / 60000)} 分钟`;
  if (s.kind === "at") return s.at ? `于 ${s.at}` : "一次性";
  if (s.kind === "on-exit") return `进程退出：${s.command || ""}`;
  if (s.kind === "stream") {
    const command = Array.isArray(s.command) ? s.command.join(" ") : "";
    return `持续流：${command}`;
  }
  return "";
}

// 根据 OpenClaw 原始任务形态生成 UI 可读的能力标签。
function openClawCronCapabilityTags(job) {
  const tags = [];
  const scheduleKind = job?.schedule?.kind;
  if (scheduleKind === "on-exit" || scheduleKind === "stream") tags.push(scheduleKind);
  const payloadKind = job?.payload?.kind;
  if (payloadKind) tags.push(payloadKind);
  const deliveryMode = job?.delivery?.mode;
  if (deliveryMode && deliveryMode !== "none") tags.push(deliveryMode);
  if (job?.failureAlert) tags.push("failure-alert");
  if (job?.sessionTarget && job.sessionTarget !== "main") tags.push(String(job.sessionTarget));
  if (job?.wakeMode === "now") tags.push("wake-now");
  if (job?.deleteAfterRun) tags.push("delete-after-run");
  return tags;
}

// OpenClaw CronJob → UnifiedCronJob. The gateway's CronSchedule
// (cron/every/at) is already the unified superset, so it passes through; the
// prompt comes from the agentTurn/systemEvent payload, and run state lives
// under job.state.
function normalizeOpenClawCronJob(job) {
  const localId = String(job?.id || "");
  const payload = job?.payload || {};
  const prompt =
    payload.kind === "agentTurn"
      ? payload.message
      : payload.kind === "systemEvent"
        ? payload.text
        : undefined;
  const state = job?.state || {};
  const schedule = job?.schedule && job.schedule.kind ? job.schedule : { kind: "cron", expr: "" };
  const stateLabel = job?.enabled === false ? "disabled" : state.status || "scheduled";
  const systemManaged = payload.kind === "heartbeat" || payload.kind === "skillCollectionReview";
  const capabilityTags = openClawCronCapabilityTags(job);
  return {
    id: `openclaw:${localId}`,
    backendId: "openclaw",
    agentId: job?.agentId || undefined,
    name: job?.name || localId,
    description: job?.description || undefined,
    prompt: typeof prompt === "string" ? prompt : undefined,
    schedule,
    scheduleDisplay: cronScheduleDisplay(schedule),
    enabled: job?.enabled !== false,
    state: state.status || undefined,
    stateLabel,
    actions: { edit: !systemManaged, toggle: !systemManaged, delete: !systemManaged, run: true,
      ...(systemManaged ? { reason: "system-managed" } : {}) },
    createdAt: typeof job?.createdAtMs === "number" ? job.createdAtMs : null,
    lastRunAt: typeof state.lastRunAtMs === "number" ? state.lastRunAtMs : null,
    lastStatus: state.lastRunStatus || state.lastStatus || undefined,
    lastError: state.lastError || undefined,
    nextRunAt: typeof state.nextRunAtMs === "number" ? state.nextRunAtMs : null,
    model: payload.kind === "agentTurn" ? payload.model : undefined,
    provider: undefined,
    deliver: job?.delivery && job.delivery.mode ? job.delivery.mode : undefined,
    deleteAfterRun: job?.deleteAfterRun === true,
    sessionTarget: job?.sessionTarget || undefined,
    wakeMode: job?.wakeMode || undefined,
    payload: job?.payload || undefined,
    delivery: job?.delivery || undefined,
    failureAlert: job?.failureAlert || null,
    backendDetails: {
      capabilityTags,
      deliveryStatus: state.lastDeliveryStatus || undefined,
      raw: {
        lastDeliveryError: state.lastDeliveryError,
        deliverySuppressionReason: state.deliverySuppressionReason,
        lastFailureNotificationDeliveryStatus: state.lastFailureNotificationDeliveryStatus,
        lastFailureNotificationDeliveryError: state.lastFailureNotificationDeliveryError,
        streamStatus: state.streamStatus,
        streamError: state.streamError,
        phase: state.phase,
      },
    },
    rawCapabilities: capabilityTags,
  };
}

// Gateway cron schema accepts failureAlert as `false` (disable) or an object
// (configure) only — never null. The unified UI layer uses null for "off", so
// translate it to `false` at the gateway boundary (anyOf [Literal(false), obj]).
function cronFailureAlertForGateway(value) {
  return value == null ? false : value;
}

class OpenClawBackend extends AgentBackend {
  /**
   * @param {object} [opts]
   * @param {() => string} [opts.getUpstreamUrl] resolves the upstream gateway ws URL (read fresh per connect)
   * @param {() => (string|undefined)} [opts.getOrigin] optional Origin header to present (mirrors the UI page origin)
   * @param {object} [opts.authResolver] device-auth createAuthResolver 实例(与 chat-broker 共享凭证)
   */
  constructor({ getUpstreamUrl, getOrigin, authResolver } = {}) {
    super();
    this._getUpstreamUrl = typeof getUpstreamUrl === "function" ? getUpstreamUrl : () => DEFAULT_GATEWAY_URL;
    this._getOrigin = typeof getOrigin === "function" ? getOrigin : () => DEFAULT_ORIGIN;
    this._ws = null;
    this._ready = false;
    this._connecting = null; // dedupe concurrent connects
    this._connectingAttempt = null; // 当前握手代际，防旧回调清掉新单飞 Promise
    this._pending = new Map(); // reqId -> { resolve, reject, socket }
    this._finalObservers = new Map(); // original agent RPC id -> socket-bound final observer
    // 统一凭证解析(config.token / operator 身份 / loopback 网关 token / 已存设备令牌)。
    // 无注入时自建缺省(独立脚本直接 new 本类的旧用法保持可跑)。
    this._authResolver =
      authResolver ||
      createAuthResolver({
        getConfig: () => ({ gatewayUrl: (this._getUpstreamUrl() || "").trim(), token: "" }),
        credentialsDir: path.join(os.homedir(), ".shoggoth", "credentials"),
      });
    this._breakdownCache = new Map(); // range -> { at, data }; smooths slow sessions.usage
    this._cliUsageCache = null; // { sig, at, data }; smooths the slow per-session CLI scan
    this._breakdownInFlight = new Map(); // range -> Promise; 单飞后台重扫（SWR，R106）
    this._cliUsageScanInFlight = null; // Promise | null; 同上
    this._skillUsageCache = null; // { sig, at, data }; 同 _cliUsageCache，用于 skill 加载扫描
    this._skillUsageScanInFlight = null; // Promise | null; 同上（SWR 单飞）
    this._skillNameByPath = new Map(); // SKILL.md 绝对路径 -> frontmatter name（跨扫描复用）
    this._artifactsCache = null; // { sig, at, data }; smooths the recent-artifacts disk scan
    this._artifactsScanInFlight = null; // Promise | null; 同上（SWR 单飞）
    this._usageCubeCache = null; // { sig, at, cube }; 本地 usage 文件扫描立方体（R173）
    this._usageCubeScanInFlight = null; // Promise | null; 同上（SWR 单飞）
    this._modelConfigCache = null; // 上次成功的 getModelConfig 结果；瞬断时回退用（读路径 only）
    this._gatewayVersion = null; // gateway hello-ok server.version，远程连接时比本机 CLI 更准确。
    this._openClawCliVersion = undefined; // 9.1 auth store 分界；undefined=尚未探测，null=探测失败。
    this._canonicalAuthProfiles = null; // 9.1 `models auth list` 的脱敏摘要缓存，不保存密钥。
    this._endpointAuthKeyProfiles = null; // Endpoint readback metadata, scoped to Gateway connection and Agent.
    this._gatewayHello = null; // 脱敏后的 8.1+ 协商结果；绝不保存 deviceToken/snapshot。
    this._connectionGeneration = 0; // 每次握手/断开递增，runtime hot allowlist 只对单代连接有效。
    this._modelRuntimeApply = null; // 由组合根注入；backend 不反向 import host controller。
    this._modelChangeAdapter = null; // 由组合根注入；所有模型变更契约只委托该实例。
    // 8.1 updater owns the complete update -> loaded-version -> doctor state
    // machine. A zero exit code alone is not success, and plugin capability
    // widening is only retried after a separate explicit user action.
    this._selfUpdater = new OpenClawUpdateController({
      bin: resolveOpenclawBin(),
      getGatewayUrl: () => (this._getUpstreamUrl() || DEFAULT_GATEWAY_URL).trim(),
      statePath: path.join(os.homedir(), ".shoggoth", "self-update", "openclaw.json"),
    });
  }

  get id() { return "openclaw"; }
  get name() { return "OpenClaw"; }

  getBackendDescriptor() {
    return {
      id: this.id,
      name: this.name,
      connectionMode: "gateway",
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
        cron: { kind: "openclaw" },
        kanban: { kind: "workboard" },
      },
    };
  }

  // Chat-surface capabilities. OpenClaw chat is a straight passthrough to the
  // gateway (this backend has no sendMessage — the proxy forwards the frame
  // verbatim), so what's deliverable is decided by the gateway's own chat.send:
  //   · attachments[] is Unknown-typed in the schema and normalized in code —
  //     NO MIME allowlist. Type is sniffed; anything unrecognized becomes
  //     application/octet-stream and still delivers.
  //   · chat.send is the ONE entrypoint that opts into non-images
  //     (`acceptNonImage: true`); the `agent` RPC and node events set it false.
  //   · non-image bytes are offloaded to the media store, staged into the
  //     agent's workspace, and surfaced as MediaPath/MediaType context vars
  //     (the agent reads them with its file tools / built-in `pdf` tool).
  // 8.1 advertises the live byte limits in hello.policy.attachments. Before a
  // handshake completes, retain conservative UI defaults; after negotiation the
  // Gateway policy is authoritative for both local and remote installations.
  getChatCapabilities(agentId) {
    const limits = this._gatewayHello?.policy?.attachments;
    const maxBytes = Number.isInteger(limits?.maxBytes) ? limits.maxBytes : 20 * 1024 * 1024;
    const maxImageBytes = Number.isInteger(limits?.maxImageBytes) ? limits.maxImageBytes : 6 * 1024 * 1024;
    const maxPayloadBytes = Number.isInteger(this._gatewayHello?.policy?.maxPayload)
      ? this._gatewayHello.policy.maxPayload
      : undefined;
    return {
      attachments: {
        image: { maxBytes: maxImageBytes },
        pdf: { maxBytes },
        file: { maxBytes },
      },
      ...(maxPayloadBytes !== undefined ? { maxPayloadBytes } : {}),
      gatewayPolicy: true,
      permissions: {
        scope: "session",
        apply: "next-turn",
        defaultMode: "guarded",
        options: [
          { id: "read-only", label: "Read only", description: "Read files without changing the workspace.", risk: "safe" },
          { id: "guarded", label: "Guarded", description: "Ask before sensitive commands or changes.", risk: "standard" },
          { id: "workspace", label: "Workspace", description: "Automatically allow changes inside the workspace.", risk: "elevated" },
          { id: "full", label: "Full access", description: "Run without approval or sandbox restrictions.", risk: "danger", requiresConfirmation: true },
        ],
      },
      ...(!this._gatewayHello ? { notReady: true } : {}),
    };
  }

  /**
   * Fetch one authenticated, self-contained OpenClaw Canvas document without
   * exposing its gateway URL or bearer credential to the renderer.
   */
  async fetchWidgetResource(resourcePath, { method = "GET" } = {}) {
    if (method !== "GET" && method !== "HEAD") {
      return { supported: true, ok: false, reason: "invalid-method" };
    }
    const safePath = normalizeCanvasWidgetResourcePath(resourcePath);
    if (!safePath) return { supported: true, ok: false, reason: "invalid-path" };

    try {
      await this._connect();
    } catch (err) {
      const reason = /timed?\s*out|timeout/i.test(String(err?.message || err)) ? "timeout" : "upstream-error";
      return { supported: true, ok: false, reason };
    }

    let auth;
    try {
      auth = this._loadAuth();
    } catch {
      return { supported: true, ok: false, reason: "upstream-rejected" };
    }
    const bearer = typeof (auth?.token ?? auth?.deviceToken) === "string"
      ? (auth.token ?? auth.deviceToken)
      : "";
    if (!bearer || /[\0\r\n]/.test(bearer)) {
      return { supported: true, ok: false, reason: "upstream-rejected" };
    }

    const target = gatewayHttpResourceUrl(
      (this._getUpstreamUrl() || "").trim() || DEFAULT_GATEWAY_URL,
      safePath,
    );
    if (!target) return { supported: true, ok: false, reason: "upstream-error" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WIDGET_RESOURCE_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await fetch(target, {
        method,
        redirect: "manual",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${bearer}`,
          Accept: "text/html",
        },
      });
      const rejectResponse = async (reason) => {
        try { await response.body?.cancel(); } catch { /* best-effort socket cleanup */ }
        return { supported: true, ok: false, reason };
      };
      if (response.status === 404) {
        return await rejectResponse("not-found");
      }
      if (response.status >= 300 && response.status < 500) {
        return await rejectResponse("upstream-rejected");
      }
      if (response.status < 200 || response.status >= 300) {
        return await rejectResponse("upstream-error");
      }

      const contentType = normalizeWidgetResourceContentType(response.headers.get("content-type"));
      if (!contentType) return await rejectResponse("content-type");
      const rawLength = response.headers.get("content-length");
      const declaredLength = rawLength === null || rawLength === "" ? null : Number(rawLength);
      if (declaredLength !== null
        && (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) {
        return await rejectResponse("upstream-error");
      }
      if (declaredLength !== null && declaredLength > WIDGET_RESOURCE_MAX_BYTES) {
        return await rejectResponse("too-large");
      }

      if (method === "HEAD") {
        return {
          supported: true,
          ok: true,
          contentType,
          contentLength: declaredLength ?? 0,
        };
      }
      const body = await readWidgetResourceBody(response);
      if (!body) return { supported: true, ok: false, reason: "too-large" };
      return {
        supported: true,
        ok: true,
        contentType,
        contentLength: body.length,
        body,
      };
    } catch (err) {
      const reason = controller.signal.aborted || err?.name === "AbortError"
        ? "timeout"
        : "upstream-error";
      return { supported: true, ok: false, reason };
    } finally {
      clearTimeout(timer);
    }
  }

  getGatewayContract() {
    return this._gatewayHello ? JSON.parse(JSON.stringify(this._gatewayHello)) : null;
  }

  hasGatewayMethod(method) {
    return hasGatewayMethod(this._gatewayHello, method);
  }

  _hasGatewayScope(required) {
    if (hasGatewayScope(this._gatewayHello, "operator.admin")) return true;
    if (required === "operator.read" && hasGatewayScope(this._gatewayHello, "operator.write")) return true;
    return hasGatewayScope(this._gatewayHello, required);
  }

  _advancedSessionMethods() {
    return advancedSessionMethodMap({
      "environments.list": this.hasGatewayMethod("environments.list")
        && this._hasGatewayScope("operator.read"),
      "sessions.describe": this.hasGatewayMethod("sessions.describe")
        && this._hasGatewayScope("operator.read"),
      "sessions.branches.list": this.hasGatewayMethod("sessions.branches.list")
        && this._hasGatewayScope("operator.read"),
      "sessions.fork": this.hasGatewayMethod("sessions.fork")
        && this._hasGatewayScope("operator.write"),
    });
  }

  async listEnvironments() {
    await this._connect();
    const methods = this._advancedSessionMethods();
    if (!methods["environments.list"]) {
      return { ...unsupportedAdvancedSessionResult("unsupported", methods), environments: [], profiles: [] };
    }
    try {
      return projectEnvironmentInventory(
        await this.request("environments.list", {}, 15000),
        methods,
      );
    } catch {
      return { ...unsupportedAdvancedSessionResult("error", methods), environments: [], profiles: [] };
    }
  }

  async describeSession(agentId, sessionKey) {
    await this._connect();
    const methods = this._advancedSessionMethods();
    if (!methods["sessions.describe"]) {
      return { ...unsupportedAdvancedSessionResult("unsupported", methods), session: null };
    }
    if (!agentId || agentIdFromSessionKey(sessionKey) !== agentId) {
      return { ...unsupportedAdvancedSessionResult("invalid-request", methods), session: null };
    }
    try {
      return projectSessionDescribeResult(
        await this.request("sessions.describe", {
          key: sessionKey,
          includeDerivedTitles: true,
          includeLastMessage: true,
        }, 15000),
        methods,
      );
    } catch {
      return { ...unsupportedAdvancedSessionResult("error", methods), session: null };
    }
  }

  async listSessionBranches(agentId, sessionKey) {
    await this._connect();
    const methods = this._advancedSessionMethods();
    if (!methods["sessions.branches.list"]) {
      return { ...unsupportedAdvancedSessionResult("unsupported", methods), branches: [] };
    }
    if (!agentId || agentIdFromSessionKey(sessionKey) !== agentId) {
      return { ...unsupportedAdvancedSessionResult("invalid-request", methods), branches: [] };
    }
    try {
      return projectSessionBranchesResult(
        await this.request("sessions.branches.list", {
          sessionKey,
          ...(agentId ? { agentId } : {}),
        }, 15000),
        methods,
      );
    } catch {
      return { ...unsupportedAdvancedSessionResult("error", methods), branches: [] };
    }
  }

  async forkSessionAtEntry(agentId, sessionKey, entryId) {
    await this._connect();
    const methods = this._advancedSessionMethods();
    if (!methods["sessions.fork"]) {
      return unsupportedAdvancedSessionResult("unsupported", methods);
    }
    if (!agentId || agentIdFromSessionKey(sessionKey) !== agentId) {
      return unsupportedAdvancedSessionResult("invalid-request", methods);
    }
    try {
      return projectSessionForkResult(
        await this.request("sessions.fork", {
          sessionKey,
          ...(agentId ? { agentId } : {}),
          entryId,
        }, 30000),
        methods,
      );
    } catch {
      return unsupportedAdvancedSessionResult("error", methods);
    }
  }

  _sessionBoardMethods() {
    return sessionBoardMethodMap({
      "board.get": this.hasGatewayMethod("board.get")
        && this._hasGatewayScope("operator.read"),
      "board.update": this.hasGatewayMethod("board.update")
        && this._hasGatewayScope("operator.write"),
      "board.widget.put": this.hasGatewayMethod("board.widget.put")
        && this._hasGatewayScope("operator.write"),
      "board.widget.grant": this.hasGatewayMethod("board.widget.grant")
        && this._hasGatewayScope("operator.approvals"),
    });
  }

  _sessionBoardCapabilities(methods) {
    return sessionBoardCapabilityMap({
      [CANVAS_DOCUMENT_CAPABILITY]: methods["board.widget.put"] === true
        && hasGatewayCapability(this._gatewayHello, CANVAS_DOCUMENT_CAPABILITY),
    });
  }

  async getSessionBoard(agentId, sessionKey) {
    await this._connect();
    const methods = this._sessionBoardMethods();
    const capabilities = this._sessionBoardCapabilities(methods);
    if (!methods["board.get"]) {
      return unsupportedSessionBoardResult("unsupported", methods, capabilities);
    }
    const safeAgentId = normalizeSessionBoardAgentId(agentId);
    const safeSessionKey = normalizeSessionBoardSessionKey(sessionKey);
    if (!safeAgentId || !safeSessionKey || agentIdFromSessionKey(safeSessionKey) !== safeAgentId) {
      return unsupportedSessionBoardResult("invalid-request", methods, capabilities);
    }
    try {
      return projectSessionBoardResult(
        await this.request("board.get", { sessionKey: safeSessionKey, agentId: safeAgentId }, 15000),
        methods,
        capabilities,
        safeSessionKey,
      );
    } catch {
      return unsupportedSessionBoardResult("error", methods, capabilities);
    }
  }

  async fetchSessionBoardHtmlWidget(agentId, sessionKey, spec) {
    const safeAgentId = normalizeSessionBoardAgentId(agentId);
    const safeSessionKey = normalizeSessionBoardSessionKey(sessionKey);
    const safeSpec = normalizeSessionBoardHtmlWidgetSpec(spec);
    if (!safeAgentId || !safeSessionKey || safeSessionKey.length > 512 || !safeSpec
      || agentIdFromSessionKey(safeSessionKey) !== safeAgentId) {
      return { supported: false, reason: "invalid-request" };
    }

    try {
      await this._connect();
    } catch (err) {
      const reason = /timed?\s*out|timeout/i.test(String(err?.message || err))
        ? "timeout"
        : "upstream-error";
      return { supported: true, ok: false, reason };
    }
    const methods = this._sessionBoardMethods();
    if (!methods["board.get"]) return { supported: false, reason: "unsupported" };

    let raw;
    try {
      raw = await this.request(
        "board.get",
        { sessionKey: safeSessionKey, agentId: safeAgentId },
        15000,
      );
    } catch (err) {
      const reason = /timed?\s*out|timeout/i.test(String(err?.message || err))
        ? "timeout"
        : "upstream-error";
      return { supported: true, ok: false, reason };
    }
    const projected = projectSessionBoardResult(
      raw,
      methods,
      this._sessionBoardCapabilities(methods),
      safeSessionKey,
    );
    if (projected.supported !== true) {
      return { supported: true, ok: false, reason: "invalid-response" };
    }

    const source = raw && typeof raw === "object" && !Array.isArray(raw)
      && raw.snapshot && typeof raw.snapshot === "object" && !Array.isArray(raw.snapshot)
      ? raw.snapshot
      : raw;
    const rawWidgets = Array.isArray(source?.widgets)
      ? source.widgets.filter((widget) => widget?.name === safeSpec.name)
      : [];
    const safeWidget = projected.snapshot.widgets.find((widget) => widget.name === safeSpec.name);
    if (rawWidgets.length !== 1 || !safeWidget) {
      return { supported: true, ok: false, reason: "widget-not-found" };
    }
    const widget = rawWidgets[0];
    if (safeWidget.revision !== safeSpec.revision
      || safeWidget.instanceId !== safeSpec.instanceId) {
      return { supported: true, ok: false, reason: "widget-stale" };
    }
    if (widget.contentKind !== "html"
      || (widget.contentOwner !== undefined && widget.contentOwner !== "html")
      || (widget.grantState !== "none" && widget.grantState !== "granted")) {
      return { supported: true, ok: false, reason: "widget-not-renderable" };
    }
    if (widget.viewGeneration !== safeSpec.instanceId || !/^[a-f0-9]{32}$/.test(widget.viewGeneration)) {
      return { supported: true, ok: false, reason: "ticket-invalid" };
    }

    const gatewayUrl = (this._getUpstreamUrl() || "").trim() || DEFAULT_GATEWAY_URL;
    const target = sessionBoardHtmlRequestUrl(
      gatewayUrl,
      widget.frameUrl,
      safeSessionKey,
      safeSpec.name,
      widget.viewTicket,
    );
    if (!target) return { supported: true, ok: false, reason: "ticket-invalid" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WIDGET_RESOURCE_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await fetch(target, {
        method: "GET",
        redirect: "manual",
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal,
        headers: { Accept: "text/html" },
      });
      const rejectResponse = async (reason) => {
        try { await response.body?.cancel(); } catch { /* best-effort socket cleanup */ }
        return { supported: true, ok: false, reason };
      };
      if (response.status >= 300 && response.status < 400) {
        return await rejectResponse("redirect");
      }
      if (response.status === 404) return await rejectResponse("not-found");
      if (response.status >= 400 && response.status < 500) {
        return await rejectResponse("upstream-rejected");
      }
      if (response.status !== 200) return await rejectResponse("upstream-error");

      if (!normalizeWidgetResourceContentType(response.headers.get("content-type"))) {
        return await rejectResponse("content-type");
      }
      const rawLength = response.headers.get("content-length");
      const declaredLength = rawLength === null || rawLength === "" ? null : Number(rawLength);
      if (declaredLength !== null
        && (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) {
        return await rejectResponse("upstream-error");
      }
      if (declaredLength !== null && declaredLength > SESSION_BOARD_HTML_MAX_BYTES) {
        return await rejectResponse("too-large");
      }

      const html = await readSessionBoardHtmlBody(response);
      if (!html) return { supported: true, ok: false, reason: "too-large" };
      if (!isStrictUtf8(html)) return { supported: true, ok: false, reason: "invalid-utf8" };
      return {
        supported: true,
        ok: true,
        html,
        boardRevision: projected.snapshot.revision,
        widgetIdentity: safeSpec,
        viewGeneration: widget.viewGeneration,
      };
    } catch (err) {
      const reason = controller.signal.aborted || err?.name === "AbortError"
        ? "timeout"
        : "upstream-error";
      return { supported: true, ok: false, reason };
    } finally {
      clearTimeout(timer);
    }
  }

  async updateSessionBoard(agentId, sessionKey, ops) {
    await this._connect();
    const methods = this._sessionBoardMethods();
    const capabilities = this._sessionBoardCapabilities(methods);
    if (!methods["board.update"]) {
      return unsupportedSessionBoardResult("unsupported", methods, capabilities);
    }
    const normalized = normalizeSessionBoardOps(ops);
    const safeAgentId = normalizeSessionBoardAgentId(agentId);
    const safeSessionKey = normalizeSessionBoardSessionKey(sessionKey);
    if (!safeAgentId || !safeSessionKey
      || agentIdFromSessionKey(safeSessionKey) !== safeAgentId || !normalized) {
      return unsupportedSessionBoardResult("invalid-request", methods, capabilities);
    }
    try {
      return projectSessionBoardResult(
        await this.request("board.update", {
          sessionKey: safeSessionKey,
          agentId: safeAgentId,
          ops: normalized,
        }, 30000),
        methods,
        capabilities,
        safeSessionKey,
      );
    } catch {
      return unsupportedSessionBoardResult("error", methods, capabilities);
    }
  }

  async pinSessionBoardCanvas(agentId, sessionKey, spec) {
    await this._connect();
    const methods = this._sessionBoardMethods();
    const capabilities = this._sessionBoardCapabilities(methods);
    if (!capabilities[CANVAS_DOCUMENT_CAPABILITY]) {
      return unsupportedSessionBoardResult("unsupported", methods, capabilities);
    }
    const normalized = normalizeSessionBoardCanvasSpec(spec);
    const safeAgentId = normalizeSessionBoardAgentId(agentId);
    const safeSessionKey = normalizeSessionBoardSessionKey(sessionKey);
    if (!safeAgentId || !safeSessionKey
      || agentIdFromSessionKey(safeSessionKey) !== safeAgentId || !normalized) {
      return unsupportedSessionBoardResult("invalid-request", methods, capabilities);
    }
    try {
      return projectSessionBoardResult(
        await this.request("board.widget.put", {
          sessionKey: safeSessionKey,
          agentId: safeAgentId,
          name: normalized.name,
          ...(normalized.title ? { title: normalized.title } : {}),
          content: { kind: "canvas-doc", docId: normalized.docId },
          ...(normalized.placement ? { placement: normalized.placement } : {}),
        }, 30000),
        methods,
        capabilities,
        safeSessionKey,
      );
    } catch {
      return unsupportedSessionBoardResult("error", methods, capabilities);
    }
  }

  async decideSessionBoardWidgetGrant(agentId, sessionKey, spec) {
    await this._connect();
    const methods = this._sessionBoardMethods();
    const capabilities = this._sessionBoardCapabilities(methods);
    if (!methods["board.widget.grant"]) {
      return unsupportedSessionBoardResult("unsupported", methods, capabilities);
    }
    const normalized = normalizeSessionBoardGrantSpec(spec);
    const safeAgentId = normalizeSessionBoardAgentId(agentId);
    const safeSessionKey = normalizeSessionBoardSessionKey(sessionKey);
    if (!safeAgentId || !safeSessionKey
      || agentIdFromSessionKey(safeSessionKey) !== safeAgentId || !normalized) {
      return unsupportedSessionBoardResult("invalid-request", methods, capabilities);
    }
    try {
      return projectSessionBoardResult(
        await this.request("board.widget.grant", {
          sessionKey: safeSessionKey,
          agentId: safeAgentId,
          ...normalized,
        }, 30000),
        methods,
        capabilities,
        safeSessionKey,
      );
    } catch {
      return unsupportedSessionBoardResult("error", methods, capabilities);
    }
  }

  _acceptGatewayHello(hello) {
    assertSupportedOpenClawHello(hello);
    this._gatewayHello = sanitizeOpenClawHello(hello);
    this._gatewayVersion = hello.server.version.trim();
    this._advanceModelRuntimeGeneration();
    return hello;
  }

  async start() { return true; }

  async stop() {
    this._ready = false;
    this._gatewayHello = null;
    this._connecting = null;
    this._connectingAttempt = null;
    const ws = this._ws;
    this._ws = null;
    this._advanceModelRuntimeGeneration();
    this._flushPending(new Error("openclaw: backend stopped"));
    if (ws) {
      try { ws.close(); } catch { /* already closing */ }
    }
  }

  /** 连接代际变化时同步失效 runtime apply 的版本能力缓存。 */
  _advanceModelRuntimeGeneration() {
    this._connectionGeneration += 1;
    this._modelRuntimeApply?.invalidateConnectionGeneration?.();
  }

  /** 组合根注入单例 runtime apply，供 Task 10 model-change adapter 使用。 */
  attachModelRuntimeApply(runtimeApply) {
    if (!runtimeApply
      || typeof runtimeApply.inspect !== "function"
      || typeof runtimeApply.acquireForApply !== "function") {
      throw new TypeError("runtimeApply 必须提供 inspect/acquireForApply");
    }
    this._modelRuntimeApply = runtimeApply;
  }

  /** 返回当前注入的 runtime apply；未注入时保持 null，不创建旁路实例。 */
  getModelRuntimeApply() {
    return this._modelRuntimeApply;
  }

  /** 组合根注入唯一 model-change adapter，禁止 backend 内部创建旁路实例。 */
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

  /** 未完成组合注入时明确拒绝，不能退回 legacy 配置写路径。 */
  _requireModelChangeAdapter() {
    if (!this._modelChangeAdapter) {
      const error = new Error("OpenClaw model-change adapter 未注入");
      error.code = "model_change_adapter_required";
      error.status = 503;
      throw error;
    }
    return this._modelChangeAdapter;
  }

  /** 模型变更能力委托注入 adapter；providerDirectory 是静态事实（本后端有「提供方」
      页签数据面），必须在运行时探测之外无条件并入（铁律 6，R324 教训：一次运行时
      读取失败不得翻转页面形态）。 */
  async getModelChangeCapabilities() {
    let caps;
    try { caps = await this._requireModelChangeAdapter().getCapabilities(); }
    catch { caps = { ...(await super.getModelChangeCapabilities()), blockers: ["capability_unavailable"] }; }
    return { ...caps, providerDirectory: true, manageAuthProfiles: this._isLocalGateway() };
  }

  /** 模型变更预览只委托注入 adapter。 */
  async previewModelChange(safeSpec) {
    const preview = await this._requireModelChangeAdapter().preview(safeSpec);
    if (safeSpec.kind === "update-provider" && safeSpec.patch?.renameTo) {
      // Provider rename has its own staged credential/reference migration;
      // the generic runtime adapter only understands provider field edits.
      preview.blockers.push({ code: "provider_rename_config_write", store: "config" });
      // The transaction repeats this check under the config hash before any
      // write. Here it gives the editor a zero-write, editable preflight result.
      const { parsed } = await this._configSnapshot();
      const providers = parsed?.models?.providers || {};
      if (providers[safeSpec.providerKey] && providers[safeSpec.patch.renameTo]) {
        preview.blockers.push({ code: "provider_exists", store: "config" });
      }
    }
    return preview;
  }

  /** 模型变更应用只委托注入 adapter。 */
  async applyModelChange(safeSpec, context, secretEnvelope) {
    return this._requireModelChangeAdapter().apply(safeSpec, context, secretEnvelope);
  }

  /** 模型变更恢复只委托注入 adapter。 */
  async recoverModelChange(entry, context) {
    return this._requireModelChangeAdapter().recover(entry, context);
  }

  /**
   * config-only 降级写能力：gateway 配置通道（config.patch）可达即可保存；
   * 聊天可用模型目录（models.list）不随 patch 热刷新，生效 = 重启网关。
   * rename 涉及引用迁移，永不降级（不在返回字段里）。
   */
  async getModelConfigWriteCapabilities() {
    try {
      await this._configSnapshot();
    } catch {
      return {
        supported: false, create: false, update: false, delete: false, updateProvider: false,
        activation: null, bypassBlockerCodes: [], blockers: ["gateway_unreachable"],
      };
    }
    return {
      supported: true, create: true, update: true, delete: true, updateProvider: true,
      // provider 改名要同步 auth-profiles/注册表/agent sqlite 文件层——远程网关这些
      // 文件不在本机,改了 config 层文件层断链,因此仅本机开放。
      renameProvider: this._isLocalGateway(),
      // 目录模型(config 不管定义)也可删:allowlist 键移除+引用收口即从可用列表消失
      deleteCatalogModel: true,
      // 目录模型 id 改名 = allowlist 搬键+引用改写(auth 型 provider 的模型条目
      // 本就只是 agents.defaults.modelPolicy.allow 的引用,裸写即生效)
      renameCatalogModel: true,
      // 批量合并写:N 个删除/目录改名/目录新增合成一次 config.patch(限流按请求数计)
      batch: true,
      preservePrimaryRefs: true,
      activation: { kind: "gateway_restart", available: this._isLocalGateway() },
      // 按 kind 分级：create/update/update-provider 不迁移引用，sessions/cron 枚举
      // 不完整与消歧失败与其无关，可绕过；delete 默认 fail-closed（漏检引用会悬空），
      // 但用户在确认框知情后（force）允许绕过——删除语义是硬删，引用失效由用户承担。
      bypassBlockerCodes: {
        "*": ["runtime_apply_unsupported"],
        create: ["session_enumeration_incomplete", "cron_enumeration_incomplete", "ambiguous_model_reference"],
        update: ["session_enumeration_incomplete", "cron_enumeration_incomplete", "ambiguous_model_reference"],
        // 目录模型改 ID(allowlist 搬键):引用改写只动 config 内引用,枚举类
        // 不完整与 create/update 同级可绕(会话/cron 里残留旧 id 的影响在确认框
        // 的引用预览里可见)。R183 首发漏配了这行 → 真机 preflight 直接 blocked。
        rename: ["session_enumeration_incomplete", "cron_enumeration_incomplete", "ambiguous_model_reference"],
        "update-provider": ["session_enumeration_incomplete", "cron_enumeration_incomplete", "ambiguous_model_reference", "provider_rename_config_write"],
        "delete-model:forced": ["session_enumeration_incomplete", "cron_enumeration_incomplete", "ambiguous_model_reference", "references_exist"],
        "delete-provider:forced": ["session_enumeration_incomplete", "cron_enumeration_incomplete", "ambiguous_model_reference", "references_exist"],
      },
      blockers: [],
    };
  }

  /** 仅写配置的模型变更；同 spec 重放幂等（upsert/删除/字段合并均收敛到同一终态）。 */
  async applyModelChangeConfigOnly(safeSpec, context, secretEnvelope) {
    const kind = safeSpec?.kind;
    let patchInfo;
    if (kind === "create" || kind === "update") {
      patchInfo = await this._configOnlyUpsertModel(safeSpec, secretEnvelope, context);
    } else if (kind === "rename") {
      patchInfo = await this._configOnlyRenameCatalogModel(safeSpec);
    } else if (kind === "delete-model") {
      patchInfo = await this._configOnlyDeleteModel(safeSpec);
    } else if (kind === "delete-provider") {
      patchInfo = await this._configOnlyDeleteProvider(safeSpec);
    } else if (kind === "update-provider") {
      patchInfo = await this._configOnlyUpdateProvider(safeSpec, secretEnvelope, context);
    } else {
      const error = new Error(`config-only 不支持 ${kind}`);
      error.code = "config_only_kind_unsupported";
      throw error;
    }
    // restartRequired=false ⇒ 本次写触达的路径全部热生效（config.schema.lookup 判定，
    // 见 _pathsNeedRestart），coordinator 据此不附 activation、UI 不弹重启横幅。
    // 拿不到判定（老路径/异常）保守视为需重启。
    await context?.recordStage?.("config-write", {
      ...(secretEnvelope?.apiKey ? { secretStep: "applied" } : {}),
    });
    return { status: "applied", stage: "config-write", restartRequired: patchInfo ? patchInfo.restart !== false : true };
  }

  /**
   * 批量仅写配置变更:N 个 spec 按序应用到同一份工作副本,diff 出【一次】
   * config.patch(控制面写 3 次/60s 限流按请求数计,批量绕开逐发等待)。
   * 支持 kind:delete-model(config/目录皆可)、rename(目录模型改 ID)、
   * create(受管 provider 的 allowlist 裸登记)。整批幂等:已收敛的子操作
   * 跳过;冲突/不存在抛错并带 batchIndex 定位到第几项。
   */
  async applyModelChangeConfigOnlyBatch(specs, { preservePrimaryRefs = false } = {}) {
    if (!Array.isArray(specs) || specs.length === 0) {
      throw new Error("批量变更为空");
    }
    const removedProviders = [];
    const registryModelSync = new Map(); // key -> 剩余 models(config 删除侧镜像)
    const patchInfo = await this._patchModelProviders((current, parsed) => {
      // hash 冲突会带着新快照重跑本闭包:累加器必须只反映最后一次成功的那轮
      removedProviders.length = 0;
      registryModelSync.clear();
      // 工作副本:所有子操作按序作用于同一份状态,互相可见(如先删 A 再把 B 改名为 A)
      const work = {
        providers: JSON.parse(JSON.stringify(current)),
        allow: Object.fromEntries((readDefaultModelPolicyAllow(parsed) || []).map((ref) => [ref, true])),
        defaultsModel: JSON.parse(JSON.stringify(parsed?.agents?.defaults?.model || {})),
        defaultsModels: JSON.parse(JSON.stringify(parsed?.agents?.defaults?.models || {})),
        list: JSON.parse(JSON.stringify(readCanonicalAgentEntries(parsed))),
      };
      const orig = {
        primary: work.defaultsModel.primary,
        fallbacks: JSON.stringify(work.defaultsModel.fallbacks ?? null),
        list: JSON.stringify(work.list),
      };
      const touchedProviders = new Set();
      const touchedAllow = new Set();
      const replacePaths = new Set();
      const workParsed = () => ({
        agents: {
          defaults: {
            model: work.defaultsModel,
            modelPolicy: { allow: Object.keys(work.allow) },
            models: work.defaultsModels,
          },
          entries: Object.fromEntries(work.list.map(({ id, ...entry }) => [id, entry])),
        },
        models: { providers: work.providers },
      });
      const applyRefs = ({ patchModelRefs }) => {
        if (!patchModelRefs) return;
        if (patchModelRefs.defaultsPrimary) work.defaultsModel.primary = patchModelRefs.defaultsPrimary;
        if (patchModelRefs.defaultsFallbacks) work.defaultsModel.fallbacks = patchModelRefs.defaultsFallbacks;
        if (patchModelRefs.entries) work.list = patchModelRefs.entries;
      };
      const applyMetadata = (options) => {
        const metadata = this._agentModelMetadataMutation(workParsed(), options);
        work.defaultsModels = metadata.nextDefaultsModels || {};
        work.list = metadata.nextEntries;
      };
      specs.forEach((spec, index) => {
        try {
          if (spec.kind === "delete-model") {
            const key = spec.providerKey;
            const id = spec.sourceModelId;
            const allowKey = `${key}/${id}`;
            const entry = work.providers[key] && typeof work.providers[key] === "object" ? work.providers[key] : null;
            const configModels = entry && Array.isArray(entry.models) ? entry.models : [];
            const inConfig = configModels.some((x) => x?.id === id);
            if (!inConfig && !(allowKey in work.allow)) return; // 已收敛(幂等重放)
            applyRefs(this._ghostRefCleanup(workParsed(), (ref) => ref === allowKey, `模型 ${allowKey}`, { preservePrimaryRefs }));
            applyMetadata({
              policyMatch: (ref) => ref === allowKey,
              settingsMatch: (ref) => ref === allowKey,
            });
            if (allowKey in work.allow) {
              delete work.allow[allowKey];
              touchedAllow.add(allowKey);
            }
            if (inConfig) {
              const models = configModels.filter((x) => x?.id !== id);
              replacePaths.add(`models.providers.${key}.models`);
              touchedProviders.add(key);
              if (models.length === 0) {
                // 删空 → 连 provider 移除,该前缀 allowlist 键全清(含历史残留)
                delete work.providers[key];
                for (const ref of Object.keys(work.allow)) {
                  if (ref.startsWith(`${key}/`)) {
                    delete work.allow[ref];
                    touchedAllow.add(ref);
                  }
                }
                removedProviders.push(key);
                registryModelSync.delete(key);
              } else {
                entry.models = models;
              }
            }
          } else if (spec.kind === "rename") {
            const key = spec.providerKey;
            const oldId = spec.sourceModelId;
            const newId = spec.model?.id;
            if (!oldId || !newId || oldId === newId) throw new Error("rename 需要不同的源/目标模型 id");
            const entry = work.providers[key] && typeof work.providers[key] === "object" ? work.providers[key] : null;
            const configModels = entry && Array.isArray(entry.models) ? entry.models : [];
            if (configModels.some((x) => x?.id === oldId)) {
              const error = new Error(`模型 ${key}/${oldId} 在 config 里有定义,不支持批量改名`);
              error.code = "config_only_kind_unsupported";
              throw error;
            }
            const oldRef = `${key}/${oldId}`;
            const newRef = `${key}/${newId}`;
            if (!(oldRef in work.allow)) {
              if (newRef in work.allow) return; // 已收敛
              throw new Error(`模型 ${oldRef} 不在可用列表里`);
            }
            if (newRef in work.allow || configModels.some((x) => x?.id === newId)) {
              const error = new Error(`模型 ${newRef} 已存在,不能重名`);
              error.code = "target_conflict";
              error.status = 409;
              throw error;
            }
            work.allow[newRef] = work.allow[oldRef] && typeof work.allow[oldRef] === "object" ? work.allow[oldRef] : {};
            delete work.allow[oldRef];
            touchedAllow.add(oldRef);
            touchedAllow.add(newRef);
            applyRefs(this._refRewrite(workParsed(), (ref) => ref === oldRef, () => newRef));
            applyMetadata({
              policyMatch: (ref) => ref === oldRef,
              settingsMatch: (ref) => ref === oldRef,
              rewrite: () => newRef,
            });
          } else if (spec.kind === "create") {
            const key = spec.providerKey;
            const m = spec.model || {};
            const id = m.id;
            if (!id) throw new Error("缺少模型 id");
            const entry = work.providers[key] && typeof work.providers[key] === "object" ? work.providers[key] : null;
            if (entry) {
              // config 型 provider:批量新增=config models 追加(条目形状与即时
              // 路径 _configOnlyUpsertModel 完全一致)+allowlist 登记
              const models = Array.isArray(entry.models) ? entry.models : [];
              if (models.some((x) => x?.id === id)) return; // 已收敛(同 id 已存在)
              models.push({
                id,
                name: String(m.name || "").trim() || id,
                ...(m.reasoning === true ? { reasoning: true } : {}),
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                ...(Number(m.contextWindow) > 0 ? { contextWindow: Number(m.contextWindow) } : {}),
                ...(Number(m.maxTokens) > 0 ? { maxTokens: Number(m.maxTokens) } : {}),
              });
              entry.models = models;
              touchedProviders.add(key);
              replacePaths.add(`models.providers.${key}.models`);
              const allowKey = `${key}/${id}`;
              if (!(allowKey in work.allow)) {
                work.allow[allowKey] = {};
                touchedAllow.add(allowKey);
              }
              return;
            }
            const managed = this._localAuthKeyProviders().has(key)
              || Object.keys(work.allow).some((ref) => ref.startsWith(`${key}/`));
            if (!managed) throw new Error(`provider ${key} 不存在，新建需提供 baseUrl`);
            const allowKey = `${key}/${id}`;
            if (allowKey in work.allow) return; // 已收敛
            work.allow[allowKey] = {};
            touchedAllow.add(allowKey);
          } else {
            const error = new Error(`批量不支持 ${spec.kind}`);
            error.code = "config_only_kind_unsupported";
            throw error;
          }
        } catch (err) {
          if (err.batchIndex === undefined) err.batchIndex = index;
          throw err;
        }
      });
      if (!touchedProviders.size && !touchedAllow.size) return null; // 全批已收敛 → 零写
      const patchProviders = {};
      for (const key of touchedProviders) {
        patchProviders[key] = key in work.providers ? work.providers[key] : null;
        // 仍存在的 provider 记录最终形态,patch 后统一镜像主注册表(agent 运行时定义)
        if (key in work.providers) {
          const e = work.providers[key];
          registryModelSync.set(key, {
            baseUrl: typeof e.baseUrl === "string" ? e.baseUrl : "",
            api: typeof e.api === "string" ? e.api : undefined,
            models: Array.isArray(e.models) ? e.models : [],
          });
        } else {
          registryModelSync.delete(key);
        }
      }
      const patchAgentModels = {};
      for (const ref of touchedAllow) {
        patchAgentModels[ref] = ref in work.allow ? work.allow[ref] : null;
      }
      const refs = {};
      if (work.defaultsModel.primary !== orig.primary) refs.defaultsPrimary = work.defaultsModel.primary;
      if (JSON.stringify(work.defaultsModel.fallbacks ?? null) !== orig.fallbacks) {
        refs.defaultsFallbacks = work.defaultsModel.fallbacks;
        replacePaths.add("agents.defaults.model.fallbacks");
      }
      if (JSON.stringify(work.list) !== orig.list) {
        refs.entries = work.list;
        for (const entry of work.list) {
          if (entry?.id) replacePaths.add(`agents.entries.${entry.id}.model.fallbacks`);
        }
      }
      return {
        patchProviders,
        replacePaths: [...replacePaths],
        patchAgentModels,
        patchModelRefs: Object.keys(refs).length ? refs : null,
        patchAgentMetadata: this._diffAgentModelMetadata(parsed, workParsed()),
      };
    });
    // 文件层同步(patch 成功后;失败仅告警的既有语义在各 helper 内)
    for (const key of removedProviders) {
      await this._dropAuthProfileKeyQuietly(key);
      this._syncRegistryProvider(key, null);
      this._purgeAgentShadowRegistries(key);
    }
    if (this._isLocalGateway()) {
      for (const [key, finalShape] of registryModelSync) {
        try {
          // _syncRegistryProvider 自身保留原条目 key 引用;端点缺省沿用注册表原值
          const { data } = this._readRegistry();
          const prev = data.providers?.[key];
          const mirror = {
            baseUrl: finalShape.baseUrl || (prev && typeof prev === "object" ? prev.baseUrl : "") || "",
            api: finalShape.api || (prev && typeof prev === "object" ? prev.api : undefined),
            models: finalShape.models,
          };
          if (mirror.api === undefined) delete mirror.api;
          this._syncRegistryProvider(key, mirror);
        } catch (err) {
          console.error(`[openclaw] 批量注册表镜像失败(${key}):`, err?.message || err);
        }
      }
    }
    return { status: "applied", stage: "config-write", restartRequired: patchInfo ? patchInfo.restart !== false : true };
  }

  /** 启动恢复只读回配置判定写入是否落盘；不重放（baseUrl/api 原文不入 journal）。 */
  async recoverModelChangeConfigOnly(entry) {
    let providers;
    let parsed;
    try {
      ({ parsed } = await this._configSnapshot());
      providers = parsed?.models?.providers && typeof parsed.models.providers === "object"
        ? parsed.models.providers
        : {};
    } catch {
      return { status: "partial", code: "recovery_config_unreadable", stage: "recovery", retryable: true };
    }
    const provider = providers[entry.providerKey] && typeof providers[entry.providerKey] === "object"
      ? providers[entry.providerKey]
      : null;
    const models = Array.isArray(provider?.models) ? provider.models : [];
    const applied = { status: "applied", stage: "recovery" };
    const notWritten = { status: "partial", code: "config_write_not_applied", stage: "recovery", retryable: true };
    switch (entry.kind) {
      case "update-provider":
        // config-write is recorded only after the whole provider/credential
        // mutation returns. Endpoint digests alone cannot prove a key write.
        if (entry.stage !== "config-write" || entry.secretStep === "pending"
          || !entry.providerDiff?.afterDigest) return notWritten;
        if (entry.target?.provider && entry.target.provider !== entry.providerKey) {
          return !provider && providerPublicDigest(providers[entry.target.provider]) === entry.providerDiff.afterDigest
            ? applied : notWritten;
        }
        return providerPublicDigest(provider) === entry.providerDiff.afterDigest ? applied : notWritten;
      case "create":
      case "update": {
        const target = entry.fingerprints?.configOnlyTarget;
        if (!target || !Array.isArray(target.modelFields) || !Array.isArray(target.providerFields)) return notWritten;
        const visible = (readDefaultModelPolicyAllow(parsed) || []).includes(`${entry.providerKey}/${entry.target?.modelId}`);
        const digest = this._configOnlyModelTargetDigest(provider, entry.target?.modelId, target);
        if (!visible || digest !== target.digest) return notWritten;
        // A lost patch response can skip the local definition mirror. Rebuild it
        // from the verified config; it never carries the provider's credential.
        if (provider) this._syncRegistryProvider(entry.providerKey, {
          baseUrl: provider.baseUrl || "", api: provider.api || "openai-completions", models,
        });
        return { ...applied, restartRequired: entry.fingerprints?.configOnlyRestartRequired === true
          || await this._pathsNeedRestart(["models.providers", "agents.defaults.modelPolicy"]) };
      }
      case "delete-model":
        if (!provider) return applied; // 删空连带删掉了 provider
        return models.some((m) => m?.id === entry.source?.modelId) ? notWritten : applied;
      case "delete-provider":
        return provider ? notWritten : applied;
      default:
        return notWritten;
    }
  }

  /** 生效动作：重启本机网关服务，让 models.list 目录重新加载。远程网关不支持。 */
  async activateModelConfig() {
    if (!this._isLocalGateway()) {
      const error = new Error("远程网关无法从本机重启，请在网关主机上重启 openclaw");
      error.code = "activation_remote_gateway";
      error.status = 409;
      throw error;
    }
    const bin = resolveOpenclawBin();
    await new Promise((resolve, reject) => {
      execFile(bin, ["--no-color", "gateway", "restart"], { timeout: 90000 }, (err, stdout, stderr) => {
        if (err) {
          const error = new Error(`gateway restart 失败: ${String(stderr || err.message).slice(0, 200)}`);
          error.code = "activation_restart_failed";
          return reject(error);
        }
        resolve(stdout);
      });
    });
    // 重启断开的 WS 由懒重连自愈；显式推进代际，避免旧连接的 runtime 能力缓存残留。
    this._advanceModelRuntimeGeneration();
    return { ok: true, restarted: true };
  }

  // ---- 授权 profile 管理 ----
  // 9.1 起共享凭证在 state DB，agent 仍可有同名覆盖；两层都通过官方 models auth CLI 读写。
  // 旧版本继续走 auth-profiles.json + agent sqlite 的兼容路径。

  _localOpenClawVersion() {
    if (this._openClawCliVersion !== undefined) return this._openClawCliVersion;
    try {
      const result = spawnSync(resolveOpenclawBin(), ["--version"], {
        encoding: "utf8",
        timeout: 10000,
      });
      const raw = String(result.stdout || result.stderr || "").trim();
      this._openClawCliVersion = result.status === 0 && raw ? raw : null;
    } catch {
      this._openClawCliVersion = null;
    }
    return this._openClawCliVersion;
  }

  _usesCanonicalModelAuthCli() {
    if (this._modelAuthCliVersionOverride !== undefined) {
      const compared = compareVersions(this._modelAuthCliVersionOverride, "2026.9.1");
      return compared !== null && compared >= 0;
    }
    const isCanonical = (version) => {
      const compared = compareVersions(version, "2026.9.1");
      return compared !== null && compared >= 0;
    };
    return isCanonical(this._gatewayVersion) || isCanonical(this._localOpenClawVersion());
  }

  _runModelAuthCli(args, options = {}) {
    const secret = typeof options.stdin === "string" ? options.stdin : "";
    const safeError = (message, code = "auth_cli_failed") => {
      const error = new Error(message);
      error.code = code;
      error.status = 503;
      return error;
    };
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = execFile(resolveOpenclawBin(), ["--no-color", ...args], {
          env: process.env,
          encoding: "utf8",
          timeout: 90000,
          maxBuffer: 1024 * 1024,
        }, (error, stdout, stderr) => {
          if (error) {
            let detail = String(stderr || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
            if (secret) detail = detail.split(secret).join("[redacted]");
            const message = error.killed
              ? "OpenClaw 授权命令超时"
              : detail ? `OpenClaw 授权命令失败：${detail.slice(-400)}` : "OpenClaw 授权命令失败";
            reject(safeError(message, error.killed ? "auth_cli_timeout" : "auth_cli_failed"));
            return;
          }
          if (options.json === true) {
            try {
              resolve(JSON.parse(stdout));
            } catch {
              reject(safeError("OpenClaw 授权命令返回了无效 JSON"));
            }
            return;
          }
          resolve({});
        });
      } catch {
        reject(safeError("OpenClaw 授权命令无法启动"));
        return;
      }
      child.stdin?.on("error", () => { /* callback owns the result */ });
      child.stdin?.end(secret ? `${secret}\n` : "");
    });
  }

  _modelAuthAgentIds() {
    if (Array.isArray(this._modelAuthAgentIdsOverride) && this._modelAuthAgentIdsOverride.length > 0) {
      return [...new Set(this._modelAuthAgentIdsOverride)];
    }
    const home = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
    const config = JSON.parse(fs.readFileSync(path.join(home, "openclaw.json"), "utf8"));
    const ids = readCanonicalAgentEntries(config).map((agent) => agent.id);
    return ids.includes("main") ? ["main", ...ids.filter((id) => id !== "main")] : ids.length ? ids : ["main"];
  }

  _modelAuthAgentId() {
    try {
      return this._modelAuthAgentIds()[0];
    } catch { /* CLI 的 main owner 作为兼容回退 */ }
    return "main";
  }

  async _loadCanonicalAuthProfiles(agentId = this._modelAuthAgentId()) {
    const result = await this._runModelAuthCli([
      "models", "auth", "list", "--agent", agentId, "--json",
    ], { json: true });
    if (!result || !Array.isArray(result.profiles)) {
      const error = new Error("OpenClaw 授权列表响应格式不兼容");
      error.code = "auth_cli_invalid_response";
      error.status = 503;
      throw error;
    }
    const profiles = result.profiles.flatMap((profile) => {
      if (!profile || typeof profile !== "object" || typeof profile.id !== "string") return [];
      const id = profile.id.trim();
      if (!id) return [];
      const row = {
        id,
        provider: String(profile.provider || id.split(":")[0] || ""),
        type: String(profile.type || "unknown"),
        source: "canonical",
      };
      if (typeof profile.label === "string" && profile.label) row.label = profile.label;
      if (typeof profile.email === "string" && profile.email) row.email = profile.email;
      if (typeof profile.displayName === "string" && profile.displayName) row.displayName = profile.displayName;
      const expires = typeof profile.expiresAt === "string" ? Date.parse(profile.expiresAt) : NaN;
      if (Number.isFinite(expires) && expires > 0) row.expires = expires;
      return [row];
    });
    if (agentId === this._modelAuthAgentId()) {
      this._canonicalAuthProfiles = profiles;
      this._canonicalAuthProfilesAgent = agentId;
    }
    return profiles;
  }

  _authProfilesPath() {
    return this._authProfilesPathOverride
      || path.join(os.homedir(), ".openclaw", "agents", "auth-profiles.json");
  }

  _readAuthProfiles() {
    const file = this._authProfilesPath();
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return { file, data: parsed && typeof parsed === "object" ? parsed : { profiles: {} } };
    } catch (err) {
      if (err?.code === "ENOENT") return { file, data: { profiles: {} } };
      throw new Error(`auth-profiles.json 读取失败: ${err?.message || err}`);
    }
  }

  _writeAuthProfiles(file, data) {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  /** 枚举各 agent sqlite 凭证库的 profile(gateway 登录流程直写 agent 库,不回写主文件)。 */
  _listAgentSqliteAuthProfiles() {
    const byId = new Map(); // id -> { profile, agents: [name] }
    const agentsDir = path.join(os.homedir(), ".openclaw", "agents");
    let names;
    try {
      names = fs.readdirSync(agentsDir);
    } catch {
      return byId;
    }
    for (const name of names) {
      const db = path.join(agentsDir, name, "agent", "openclaw-agent.sqlite");
      if (!fs.existsSync(db)) continue;
      try {
        const read = spawnSync("sqlite3", [db, "SELECT store_json FROM auth_profile_store WHERE store_key='primary';"], { encoding: "utf8", timeout: 10000 });
        if (read.status !== 0) continue;
        const raw = String(read.stdout || "").trim();
        if (!raw) continue;
        const store = JSON.parse(raw);
        for (const [id, p] of Object.entries(store?.profiles || {})) {
          if (!p || typeof p !== "object") continue;
          const entry = byId.get(id) || { profile: p, agents: [] };
          entry.agents.push(name);
          byId.set(id, entry);
        }
      } catch { /* 单库损坏跳过 */ }
    }
    return byId;
  }

  async listModelAuthProfiles() {
    if (!this._isLocalGateway()) return { supported: false, reason: "remote", profiles: [] };
    if (this._usesCanonicalModelAuthCli()) {
      return { supported: true, profiles: await this._loadCanonicalAuthProfiles() };
    }
    const { data } = this._readAuthProfiles();
    // 授权真身分布在两层:主 auth-profiles.json(模板/种子) + 各 agent sqlite
    // (gateway 的 CLI/OAuth 登录直写 agent 库,主文件里看不到——xai/anthropic 即此类)。
    // 聚合展示,标注来源;绝不携带 key/token 明文。
    const toRow = (id, p) => ({
      id,
      provider: String(p?.provider || id.split(":")[0] || ""),
      type: String(p?.type || "unknown"),
      ...(typeof p?.key === "string" && p.key ? { keyTail: p.key.slice(-4) } : {}),
      ...(typeof p?.email === "string" && p.email ? { email: p.email } : {}),
      ...(Number(p?.expires) > 0 ? { expires: Number(p.expires) } : {}),
    });
    const agentProfiles = this._listAgentSqliteAuthProfiles();
    const storeIds = new Set(Object.keys(data.profiles || {}));
    const profiles = Object.entries(data.profiles || {}).map(([id, p]) => ({
      ...toRow(id, p),
      source: agentProfiles.has(id) ? "both" : "store",
      agentCount: agentProfiles.get(id)?.agents.length || 0,
    }));
    for (const [id, entry] of agentProfiles) {
      if (storeIds.has(id)) continue;
      profiles.push({ ...toRow(id, entry.profile), source: "agents", agentCount: entry.agents.length });
    }
    return { supported: true, profiles };
  }

  /** api_key 型 profile 写入的共享实现;oauth 型拒绝覆盖。返回 profile id。 */
  async _writeAuthProfileKey(providerKey, apiKey) {
    const provider = String(providerKey || "").trim();
    const key = String(apiKey || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider)) throw new Error("provider 非法");
    if (!key) throw new Error("缺少 apiKey");
    const id = `${provider}:default`;
    if (this._usesCanonicalModelAuthCli()) {
      // 不允许 roster 读取失败时只写 main；否则会再次把局部成功报成全局保存成功。
      const agentIds = this._modelAuthAgentIds();
      let profiles;
      // 所有 agent 先检查类型，再开始任何写入；不同名的授权与 OAuth 均不覆盖。
      for (const agentId of agentIds) {
        const rows = await this._loadCanonicalAuthProfiles(agentId);
        if (agentId === agentIds[0]) profiles = rows;
        const existing = rows.find((profile) => profile.id === id);
        if (existing && existing.type !== "api_key") {
          const error = new Error(`${agentId} 的 ${id} 是 ${existing.type} 类型授权,不能用 API Key 覆盖;请先删除后用 CLI 重新授权`);
          error.code = "auth_type_mismatch";
          error.status = 409;
          throw error;
        }
      }
      for (const agentId of agentIds) {
        try {
          await this._runModelAuthCli([
            "models", "auth", "paste-api-key", "--provider", provider, "--profile-id", id,
            "--agent", agentId,
          ], { stdin: key });
        } catch (error) {
          error.message = `OpenClaw 凭据尚未同步到 Agent ${agentId}：${error.message}`;
          throw error;
        }
      }
      this._canonicalAuthProfiles = [
        ...profiles.filter((profile) => profile.id !== id),
        { id, provider, type: "api_key", source: "canonical" },
      ];
      return id;
    }
    const { file, data } = this._readAuthProfiles();
    if (!data.profiles || typeof data.profiles !== "object") data.profiles = {};
    const existing = data.profiles[id];
    if (existing && existing.type && existing.type !== "api_key") {
      const error = new Error(`${id} 是 ${existing.type} 类型授权,不能用 API Key 覆盖;请先删除后用 CLI 重新授权`);
      error.code = "auth_type_mismatch";
      error.status = 409;
      throw error;
    }
    data.profiles[id] = { type: "api_key", provider, key };
    this._writeAuthProfiles(file, data);
    // agent store 是一次性快照不自动继承——key 必须同步分发,否则 agent 侧 missing-provider-auth
    this._syncAgentSqliteAuthKey(id, { type: "api_key", provider, key });
    return id;
  }

  async setModelAuthProfileKey(providerKey, apiKey) {
    if (!this._isLocalGateway()) {
      const error = new Error("远程网关的授权文件不在本机,无法编辑");
      error.code = "auth_remote_gateway";
      error.status = 409;
      throw error;
    }
    const id = await this._writeAuthProfileKey(providerKey, apiKey);
    return { ok: true, id, activation: { kind: "gateway_restart", available: true } };
  }

  // ---- 主注册表 agents/models.json 同步(R179)----
  // agent 运行时的 provider 定义解析读主注册表,openclaw.json 只喂网关目录/UI;
  // App 增删模型必须镜像写注册表(纯定义,不带 key),否则 agent 一跑就
  // missing-provider-auth(2026-07-19 真机实测)。

  _registryPath() {
    return this._registryPathOverride
      || path.join(os.homedir(), ".openclaw", "agents", "models.json");
  }

  _readRegistry() {
    const file = this._registryPath();
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") {
        if (!parsed.providers || typeof parsed.providers !== "object") parsed.providers = {};
        return { file, data: parsed };
      }
    } catch (err) {
      if (err?.code !== "ENOENT") throw new Error(`agents/models.json 读取失败: ${err?.message || err}`);
    }
    return { file, data: { providers: {} } };
  }

  _writeRegistry(file, data) {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  /**
   * 把 provider 定义镜像进主注册表(entry=null 删除)。镜像永不携带 apiKey——
   * 若注册表原条目有 key/哨兵,保留原值(避免破坏 CLI 路径建的引用)。
   * 失败仅告警不阻断:config 写已成功,注册表滞后可手补,不能让保存整体失败。
   */
  _syncRegistryProvider(providerKey, entry) {
    if (!this._isLocalGateway()) return;
    try {
      const { file, data } = this._readRegistry();
      if (entry === null) {
        if (!(providerKey in data.providers)) return;
        delete data.providers[providerKey];
      } else {
        const prev = data.providers[providerKey];
        data.providers[providerKey] = {
          ...entry,
          ...(prev && typeof prev === "object" && prev.apiKey ? { apiKey: prev.apiKey } : {}),
        };
      }
      this._writeRegistry(file, data);
    } catch (err) {
      console.error(`[openclaw] 注册表同步失败(${providerKey}):`, err?.message || err);
    }
  }

  /** 删除 provider 时顺带清各 agent 分身注册表里的同名条目(CLI 时代的复制品,防幽灵)。 */
  _purgeAgentShadowRegistries(providerKey) {
    if (!this._isLocalGateway()) return;
    let pattern;
    try {
      pattern = path.join(os.homedir(), ".openclaw", "agents");
      for (const name of fs.readdirSync(pattern)) {
        const file = path.join(pattern, name, "agent", "models.json");
        if (!fs.existsSync(file)) continue;
        try {
          const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
          const target = parsed?.providers && typeof parsed.providers === "object" ? parsed.providers : parsed;
          if (target && typeof target === "object" && providerKey in target) {
            fs.copyFileSync(file, `${file}.bak`);
            delete target[providerKey];
            const tmp = `${file}.tmp-${process.pid}`;
            fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2), { mode: 0o600 });
            fs.renameSync(tmp, file);
          }
        } catch (err) {
          console.error(`[openclaw] 分身注册表清理失败(${name}):`, err?.message || err);
        }
      }
    } catch (err) {
      console.error("[openclaw] 分身注册表枚举失败:", err?.message || err);
      throw err;
    }
  }

  /**
   * 把 api_key profile 同步进每个 agent 的 sqlite auth store(credJson=null 删)。
   * agent store 是创建时的一次性快照,不自动继承主 store——不同步的话新 key 只有
   * 主 store 有,agent 一跑就 missing-provider-auth。用系统 sqlite3 CLI(Electron
   * 内置 Node 无 node:sqlite);失败仅告警。
   */
  _syncAgentSqliteAuthKey(profileId, cred) {
    if (!this._isLocalGateway()) return;
    const agentsDir = path.join(os.homedir(), ".openclaw", "agents");
    let names;
    try {
      names = fs.readdirSync(agentsDir);
    } catch {
      return;
    }
    for (const name of names) {
      const db = path.join(agentsDir, name, "agent", "openclaw-agent.sqlite");
      if (!fs.existsSync(db)) continue;
      try {
        const read = spawnSync("sqlite3", [db, "SELECT store_json FROM auth_profile_store WHERE store_key='primary';"], { encoding: "utf8", timeout: 10000 });
        if (read.status !== 0) throw new Error(read.stderr || `sqlite3 exit ${read.status}`);
        const raw = String(read.stdout || "").trim();
        const store = raw ? JSON.parse(raw) : { version: 1, profiles: {} };
        if (!store.profiles || typeof store.profiles !== "object") store.profiles = {};
        if (cred === null) {
          if (!(profileId in store.profiles)) continue;
          delete store.profiles[profileId];
        } else {
          store.profiles[profileId] = cred;
        }
        const sql = "INSERT INTO auth_profile_store(store_key, store_json, updated_at) VALUES('primary', '"
          + JSON.stringify(store).replace(/'/g, "''")
          + `', ${Date.now()}) ON CONFLICT(store_key) DO UPDATE SET store_json=excluded.store_json, updated_at=excluded.updated_at;`;
        const write = spawnSync("sqlite3", [db, sql], { encoding: "utf8", timeout: 10000 });
        if (write.status !== 0) throw new Error(write.stderr || `sqlite3 exit ${write.status}`);
      } catch (err) {
        console.error(`[openclaw] agent(${name}) auth store 同步失败:`, err?.message || err);
      }
    }
  }

  /** 本机 auth-profiles 里的 api_key profile，按 provider 保留 profile id。 */
  _localAuthKeyProfiles() {
    if (!this._isLocalGateway()) return new Map();
    if (this._usesCanonicalModelAuthCli()) {
      const out = new Map();
      for (const profile of this._canonicalAuthProfiles || []) {
        if (profile?.type !== "api_key" || !profile.provider || !profile.id) continue;
        const ids = out.get(profile.provider) || new Set();
        ids.add(profile.id);
        out.set(profile.provider, ids);
      }
      return out;
    }
    try {
      const { data } = this._readAuthProfiles();
      const out = new Map();
      for (const [id, p] of Object.entries(data.profiles || {})) {
        if (p?.type !== "api_key" || typeof p.key !== "string" || !p.key || !p.provider) continue;
        const ids = out.get(p.provider) || new Set();
        ids.add(id);
        out.set(p.provider, ids);
      }
      return out;
    } catch {
      return new Map();
    }
  }

  /** 本机 auth-profiles 里有 api_key 凭证的 provider 集合(hasApiKey 聚合用;失败空集)。 */
  _localAuthKeyProviders() {
    return new Set(this._localAuthKeyProfiles().keys());
  }

  async _loadLocalAuthKeyProfiles({ refresh = true } = {}) {
    if (!this._isLocalGateway()) return new Map();
    if (this._usesCanonicalModelAuthCli() && (refresh
      || !Array.isArray(this._canonicalAuthProfiles)
      || this._canonicalAuthProfilesAgent !== this._modelAuthAgentId())) {
      await this._loadCanonicalAuthProfiles();
    }
    return this._localAuthKeyProfiles();
  }

  /** Read endpoint credential metadata through the running Gateway, avoiding CLI startup on each page load. */
  async _loadEndpointAuthKeyProfiles({ refresh = true } = {}) {
    if (!this._isLocalGateway() || !this._usesCanonicalModelAuthCli()) {
      return this._loadLocalAuthKeyProfiles({ refresh });
    }
    const agentId = this._modelAuthAgentId();
    const identity = JSON.stringify({ ...this.getModelRuntimeIdentity(), agentId });
    if (!refresh && this._endpointAuthKeyProfiles?.identity === identity) {
      return this._endpointAuthKeyProfiles.profiles;
    }
    let profiles;
    try {
      // Explicit Agent scope matches `models auth list --agent`; refresh also
      // observes credentials edited outside Shoggoth. Never cache secret values.
      const status = await this.request("models.authStatus", { agentId, refresh: true }, 20000);
      if (status?.unavailable || !Array.isArray(status?.providers)) {
        throw new Error("OpenClaw auth status unavailable");
      }
      profiles = new Map();
      for (const provider of status.providers) {
        if (typeof provider?.provider !== "string" || !provider.provider.trim() || !Array.isArray(provider.profiles)) {
          throw new Error("OpenClaw auth status incompatible");
        }
        for (const profile of provider.profiles) {
          if (profile?.type !== "api_key") continue;
          if (typeof profile.profileId !== "string" || !profile.profileId.trim()) {
            throw new Error("OpenClaw auth profile incompatible");
          }
          const id = provider.provider.trim();
          const ids = profiles.get(id) || new Set();
          ids.add(profile.profileId.trim());
          profiles.set(id, ids);
        }
      }
    } catch {
      // Older Gateways may lack the scoped status RPC. Keep the official CLI
      // fallback strict: a failed read must not become an empty/stale key list.
      profiles = await this._loadLocalAuthKeyProfiles({ refresh: true });
    }
    if (identity === JSON.stringify({ ...this.getModelRuntimeIdentity(), agentId: this._modelAuthAgentId() })) {
      this._endpointAuthKeyProfiles = { identity, profiles };
    }
    return profiles;
  }

  async deleteModelAuthProfile(profileId) {
    if (!this._isLocalGateway()) {
      const error = new Error("远程网关的授权文件不在本机,无法编辑");
      error.code = "auth_remote_gateway";
      error.status = 409;
      throw error;
    }
    const id = String(profileId || "").trim();
    if (!id) throw new Error("缺少 profileId");
    if (this._usesCanonicalModelAuthCli()) {
      const profiles = await this._loadCanonicalAuthProfiles();
      if (!profiles.some((profile) => profile.id === id)) {
        const error = new Error(`授权 profile ${id} 不存在`);
        error.code = "auth_profile_not_found";
        error.status = 404;
        throw error;
      }
      await this._deleteCanonicalAuthProfile(id);
      return { ok: true, id, activation: { kind: "gateway_restart", available: true } };
    }
    const { file, data } = this._readAuthProfiles();
    const inStore = data.profiles && id in data.profiles;
    // 授权可能只存在于 agent sqlite(gateway 登录直写,如 xai oauth/anthropic:claude-cli)
    const inAgents = this._listAgentSqliteAuthProfiles().has(id);
    if (!inStore && !inAgents) {
      const error = new Error(`授权 profile ${id} 不存在`);
      error.code = "auth_profile_not_found";
      error.status = 404;
      throw error;
    }
    if (inStore) {
      delete data.profiles[id];
      this._writeAuthProfiles(file, data);
    }
    // 两层同删:主文件删了 agent 库不删,授权仍在生效(agent 只读自己的 sqlite)
    if (inAgents) this._syncAgentSqliteAuthKey(id, null);
    return { ok: true, id, activation: { kind: "gateway_restart", available: true } };
  }

  async _deleteCanonicalAuthProfile(profileId) {
    const owner = this._modelAuthAgentId();
    await this._runModelAuthCli(["models", "auth", "logout", profileId, "--yes", "--agent", owner]);
    if (Array.isArray(this._canonicalAuthProfiles)) {
      this._canonicalAuthProfiles = this._canonicalAuthProfiles.filter((profile) => profile.id !== profileId);
    }
  }

  /** 目录快照（生成+手工合并）；进程内缓存——文件是构建期产物，不热变。 */
  _providerCatalogSnapshot() {
    if (this._provCatalogCache) return this._provCatalogCache;
    const read = (f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, "data", f), "utf8"));
      } catch { return null; }
    };
    const gen = read("openclaw-provider-catalog.json");
    const manual = read("openclaw-provider-manual.json");
    const providers = {};
    // builtin = 出自生成快照（OpenClaw 插件目录的预设家）；目录卡只放这批。
    // declared/aliasOf/scopes/keyMethods 是 R369 新增的分类字段。老快照（重生成前的
    // 文件）没有这些键，此时 classified=false，_outOfDirectoryScope 整条规则让路退回旧
    // 行为——**不能**逐字段兜默认值：keyMethods 缺省成空数组会把 anthropic/openai 这类
    // 「能登录也能填 Key」的家误判成纯登录家，整片从目录卡消失。
    for (const [id, p] of Object.entries(gen?.providers || {})) {
      const m = manual?.providers?.[id] || {};
      providers[id] = {
        ...p, builtin: true, label: m.label || p.label || id, getKeyUrl: m.getKeyUrl || null,
        // 端点：生成快照优先，manual 兜底（R371——openrouter/xai 这类端点写死在上游
        // 插件代码里、快照抽不到的家，manual 补官方文档明载的固定地址，给「检测」
        // 按钮当探测目标；同 Hermes 本地带 hermes-endpoints.ts 的先例）。
        baseUrl: p.baseUrl || m.baseUrl || null,
        // 该家验 Key 的专用探针 path（如 openrouter 的 /key——它的 /models 公开，
        // 坏 key 也 200，拿去当检测会假阳性）。数据位，不是代码特判。
        keyProbePath: m.keyProbePath || null,
        classified: Array.isArray(p.keyMethods), declared: p.declared === true,
        aliasOf: p.aliasOf || null, scopes: Array.isArray(p.scopes) ? p.scopes : [],
        keyMethods: Array.isArray(p.keyMethods) ? p.keyMethods : [],
      };
    }
    // manual 里快照外的 id（deepseek/modelscope 等常见自定义 provider）也建条目，
    // 让 config-only provider 一样拿得到「获取密钥」链接与人话 label——但它们
    // **不是**预设家（builtin:false），归「自定义端点」卡（R359 用户定案：预设与
    // 自定义分卡，对齐 Hermes 页面结构）。
    for (const [id, m] of Object.entries(manual?.providers || {})) {
      if (id.startsWith("__") || providers[id]) continue;
      providers[id] = {
        builtin: false, label: m.label || id, icon: null, baseUrl: null, api: null,
        envKeys: [], defaultModels: [], oauth: [], getKeyUrl: m.getKeyUrl || null,
      };
    }
    this._provCatalogCache = { providers };
    return this._provCatalogCache;
  }

  /**
   * OAuth 登录卡数据：目录快照（哪些 provider 可登录）+ models.authStatus（状态/过期）
   * + config auth.profiles（email 做 token 摘要）。无 profile 维度（profiles 恒空）。
   * authStatus 有 60s 网关侧缓存——本方法同时是「我已登录」回查与断开后刷新的唯一
   * 入口，必须 refresh:true，否则回查读到旧缓存会误判未登录。
   */
  async listOAuthProviders() {
    const catalog = this._providerCatalogSnapshot().providers;
    const oauthIds = Object.keys(catalog).filter((id) => catalog[id].oauth.length > 0);
    if (!oauthIds.length) return { providers: [], profiles: [] };
    let status = null;
    let authProfiles = {};
    try {
      await this._connect();
      status = await this.request("models.authStatus", { refresh: true }, 20000);
    } catch { /* gateway 不可达 → 全部按未连接展示（列表仍可看，铁律 4） */ }
    try {
      const { parsed } = await this._configSnapshot();
      if (parsed?.auth?.profiles && typeof parsed.auth.profiles === "object") authProfiles = parsed.auth.profiles;
    } catch { /* 同上 */ }
    const statusRows = Array.isArray(status?.providers) ? status.providers : [];
    const statusByProvider = new Map(statusRows.map((p) => [p.provider, p]));
    // authStatus 的行按**存储 provider 名**分组，与目录 id 可能错位（实测 Claude CLI
    // 凭证挂在 "claude-cli" 行下，profileId 却是 "anthropic:claude-cli"）。所以除精确
    // 命中外，还按 profileId 前缀 `<id>:` 归集别名行，否则 anthropic 永远显示未连接。
    const rowsFor = (id) => {
      const rows = [];
      const direct = statusByProvider.get(id);
      if (direct) rows.push(direct);
      const prefix = `${id}:`;
      for (const row of statusRows) {
        if (row === direct) continue;
        const profs = Array.isArray(row.profiles) ? row.profiles : [];
        if (profs.some((pr) => typeof pr.profileId === "string" && pr.profileId.startsWith(prefix))) rows.push(row);
      }
      return rows;
    };
    const cliRunnable = this._isLocalGateway();
    const providers = oauthIds.sort().map((id) => {
      const cat = catalog[id];
      const rows = rowsFor(id);
      const oauthProfiles = rows
        .flatMap((row) => (Array.isArray(row.profiles) ? row.profiles : []))
        .filter((pr) => pr.type === "oauth");
      const best = oauthProfiles.find((pr) => pr.status === "ok" || pr.status === "expiring") || oauthProfiles[0] || null;
      // 承载状态/过期时间的行：优先 best profile 所在行，回落首行
      const st = rows.find((row) => (Array.isArray(row.profiles) ? row.profiles : []).includes(best)) || rows[0] || null;
      // token 摘要：config auth.profiles 里该 provider oauth 条目的 email，回落 profileId 尾段
      const metaEntry = Object.entries(authProfiles).find(([, v]) => v && v.provider === id && v.mode === "oauth");
      const email = metaEntry?.[1]?.email
        || (best?.profileId ? String(best.profileId).split(":").pop() : null);
      const loggedIn = !!best && (best.status === "ok" || best.status === "expiring");
      return {
        id,
        name: cat.label,
        flow: "external",
        cliCommand: `openclaw models auth login --provider ${id}`,
        cliRunnable,
        docsUrl: cat.getKeyUrl || "",
        disconnectHint: null,
        disconnectCommand: null,
        disconnectable: true,
        status: {
          loggedIn,
          source: best?.type || null,
          // sourceLabel 别再复述 email（tokenPreview 已带）；过期不进 error——
          // error 会盖过 UI 本地化的 oauthRowExpired 文案，过期态由 expiresAt 驱动。
          sourceLabel: null,
          tokenPreview: loggedIn ? email : null,
          expiresAt: (best?.expiry?.at ?? st?.expiry?.at)
            ? new Date(best?.expiry?.at ?? st.expiry.at).toISOString()
            : null,
          hasRefreshToken: false,
          error: null,
        },
        connectedProfiles: [],
      };
    });
    return { providers, profiles: [] };
  }

  /** 断开 = gateway models.authLogout（删该 provider 全部 auth profile + abort 在跑 run）。 */
  async disconnectOAuthProvider(providerId) {
    const id = String(providerId || "").trim();
    if (!id) throw new Error("缺少 provider");
    await this._connect();
    const r = await this.request("models.authLogout", { provider: id }, 15000);
    return { ok: true, removedProfiles: Array.isArray(r?.removedProfiles) ? r.removedProfiles : [] };
  }

  /**
   * 通用小配置写（models 域之外的路径，如 env.vars）：config.get 拿 hash →
   * config.patch，hash 冲突退避重试一轮 + 限流按提示等待一次（_patchModelProviders
   * 的精简版——那边的 mutate 闭包/数组保护是 models 专用形状，不复用）。
   * 返回 { restart }（按触达路径的 reloadKind 判定）。
   */
  async _patchConfigRaw(rawObj, touchedPaths) {
    let lastErr;
    const delaysMs = [0, 1500, 4000];
    let rateWaited = false;
    for (let attempt = 0; attempt < delaysMs.length; attempt++) {
      if (delaysMs[attempt] > 0) await new Promise((r) => setTimeout(r, delaysMs[attempt]));
      const { hash } = await this._configSnapshot();
      try {
        await this.request("config.patch", { raw: JSON.stringify(rawObj), baseHash: hash }, 15000);
        return { restart: await this._pathsNeedRestart(touchedPaths) };
      } catch (err) {
        lastErr = err;
        const msg = String(err?.message || err);
        if (/changed since last load/i.test(msg)) continue;
        const rate = /rate limit exceeded.*retry after\s*(\d+)/i.exec(msg);
        if (rate && !rateWaited) {
          rateWaited = true;
          await new Promise((r) => setTimeout(r, Math.min((Number(rate[1]) + 1) * 1000, 45000)));
          attempt -= 1;
          continue;
        }
        throw err;
      }
    }
    const error = new Error("网关正在应用上一次配置变更(热重载/写入限流),本次写入未成功,请稍候重试");
    error.code = "config_write_conflict";
    if (lastErr) error.cause = lastErr;
    throw error;
  }

  /**
   * 工具密钥（Hermes「工具密钥」卡的 OpenClaw 等价物）= config 顶层 env.vars 段
   * （网关注入给技能/工具的环境变量）。config.get 里值是脱敏哨兵 → isSet 判据；
   * 摘要/明文本机直读磁盘（同 _localKeyDigests 的路子）。
   */
  async listEnvVars() {
    let parsed;
    try {
      ({ parsed } = await this._configSnapshot());
    } catch {
      return [];
    }
    const vars = parsed?.env?.vars && typeof parsed.env.vars === "object" ? parsed.env.vars : {};
    const mask = (s) => (s.length >= 10 ? `${s.slice(0, 4)}...${s.slice(-4)}` : "••••••");
    let plainVars = null;
    if (this._isLocalGateway()) {
      try {
        const home = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
        const cfg = JSON.parse(fs.readFileSync(path.join(home, "openclaw.json"), "utf8"));
        if (cfg?.env?.vars && typeof cfg.env.vars === "object") plainVars = cfg.env.vars;
      } catch { /* 摘要缺席不影响列表 */ }
    }
    return Object.keys(vars).sort().map((key) => {
      const plain = typeof plainVars?.[key] === "string" ? plainVars[key] : null;
      return {
        key,
        isSet: true,
        redactedValue: plain ? mask(plain) : null,
        description: "",
        url: null,
        category: "tool",
        isPassword: true,
        advanced: false,
        custom: true,
      };
    });
  }

  /** 写 env.vars.<KEY>（env 段 reloadKind=restart → 返回 activation 提示重启生效）。 */
  async setEnvVar(key, value) {
    const k = String(key || "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k)) throw new Error("变量名只能是字母/数字/下划线/连字符，且不能以数字开头");
    if (typeof value !== "string" || !value.trim()) throw new Error("缺少变量值");
    const { restart } = await this._patchConfigRaw({ env: { vars: { [k]: value } } }, ["env"]);
    return { ok: true, activation: restart ? { kind: "gateway_restart", available: this._isLocalGateway() } : null };
  }

  /** 删 env.vars.<KEY>（RFC7386 null 删键）。 */
  async deleteEnvVar(key) {
    const k = String(key || "").trim();
    if (!k) throw new Error("缺少变量名");
    const { restart } = await this._patchConfigRaw({ env: { vars: { [k]: null } } }, ["env"]);
    return { ok: true, activation: restart ? { kind: "gateway_restart", available: this._isLocalGateway() } : null };
  }

  /** env.vars 明文（本机直读磁盘；config.get 只有脱敏哨兵）。 */
  async revealEnvVar(key) {
    const k = String(key || "").trim();
    if (!k) throw new Error("缺少变量名");
    if (!this._isLocalGateway()) throw new Error("远程网关的配置文件不在本机，无法查看明文");
    const home = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
    const cfg = JSON.parse(fs.readFileSync(path.join(home, "openclaw.json"), "utf8"));
    const v = cfg?.env?.vars?.[k];
    if (typeof v !== "string") throw new Error(`变量 ${k} 不存在`);
    return { value: v };
  }

  /**
   * 本机密钥摘要（sk-o...c2f8 形态，对齐 Hermes redacted_value 观感）：一次读盘
   * 建 provider→摘要 映射，目录卡读态显示用。明文源与 revealModelProviderKey
   * 同两层（config + 当前版本的授权库）。远程网关返回空表。
   */
  async _localKeyDigests({ refresh = true } = {}) {
    if (!this._isLocalGateway()) return new Map();
    const home = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
    let cfg = {};
    try {
      cfg = JSON.parse(fs.readFileSync(path.join(home, "openclaw.json"), "utf8"));
    } catch { /* 读不到磁盘按无摘要处理（目录照常） */ }
    if (this._usesCanonicalModelAuthCli()) {
      const agentId = this._modelAuthAgentId();
      const identity = JSON.stringify({ ...this.getModelRuntimeIdentity(), agentId, home });
      if (!refresh && this._canonicalKeyDigests?.identity === identity) return this._canonicalKeyDigests.digests;
      if (this._canonicalKeyDigestsInFlight?.identity === identity) return this._canonicalKeyDigestsInFlight.promise;
      const promise = (async () => {
        try {
          const sdk = path.join(path.dirname(fs.realpathSync(resolveOpenclawBin())), "dist", "plugin-sdk", "agent-runtime.js");
          const digests = await readCanonicalKeyDigests({ sdk, home, agentId });
          this._canonicalKeyDigests = { identity, digests };
          return digests;
        } catch { return new Map(projectKeyDigests(cfg)); }
      })();
      this._canonicalKeyDigestsInFlight = { identity, promise };
      try { return await promise; }
      finally {
        if (this._canonicalKeyDigestsInFlight?.promise === promise) this._canonicalKeyDigestsInFlight = null;
      }
    }
    try { return new Map(projectKeyDigests(cfg, this._readAuthProfiles().data)); }
    catch { return new Map(projectKeyDigests(cfg)); }
  }

  /**
   * 预设家是否该被目录卡（= API Key/端点那张卡）挡在外面。四条判据全部照抄上游
   * onboarding 的口径（`buildAuthChoiceGroups`）——CLI 的「Model/auth provider」列表
   * 就是这么筛出来的，我们只是把同一批家按登录/填 Key 分成两张卡：
   *   1. 只在 setup.envVars 里登记的（deepgram/voyage/azure-speech…）不是模型家，
   *      是工具密钥，归本页的「工具密钥」段；
   *   2. providerAuthAliases 的别名（byteplus-plan→byteplus）——网关查凭证时会归一到
   *      父家，单独占一行只会诱导用户往取不到的地方填 Key；
   *   3. onboardingScopes 不含 text-inference 的（fal/comfy/vydra 是图像/音乐家）；
   *   4. 纯登录家（github-copilot 只有设备码、google-gemini-cli 只有 OAuth）——它们在
   *      上面的 OAuth 卡，这里给个 Key 输入框是死路。
   * 自定义端点卡的条目（builtin:false）不受此约束。
   */
  _outOfDirectoryScope(cat) {
    if (!cat || !cat.builtin || !cat.classified) return false;
    if (!cat.declared || cat.aliasOf) return true;
    if (cat.scopes.length && !cat.scopes.includes("text-inference")) return true;
    return cat.oauth.length > 0 && cat.keyMethods.length === 0;
  }

  /**
   * 「提供方」页签目录卡：快照 ∪ config 合并。configured 判据（spec D8）=
   * config.models.providers 有该键，或 auth.profiles 有该 provider 条目（key 可能
   * 只在 auth 存储不进 config，如本机 openrouter/qwen/deepseek）。纯空壳快照条目
   * （无 env 无 oauth 无默认端点/模型的别名，如 novita-ai/copilot-proxy）不进目录。
   * 远程网关照常——全走 RPC 快照，不碰本机文件。
   *
   * R369 起目录卡 = 「填 Key / 配端点」那一半，与上方 OAuth 登录卡两分（上游
   * onboarding 同口径，见 _outOfDirectoryScope）。
   */
  async getProviderDirectory() {
    const catalog = this._providerCatalogSnapshot().providers;
    let parsed = null;
    try {
      ({ parsed } = await this._configSnapshot());
    } catch (err) {
      const e = new Error(`gateway 配置读取失败：${err?.message || err}`);
      e.status = 503;
      throw e;
    }
    const cfgProviders = parsed?.models?.providers && typeof parsed.models.providers === "object"
      ? parsed.models.providers : {};
    const authProfiles = parsed?.auth?.profiles && typeof parsed.auth.profiles === "object"
      ? parsed.auth.profiles : {};
    const authProviderSet = new Set(Object.values(authProfiles).map((v) => v?.provider).filter(Boolean));
    const defaultAuthProviderSet = new Set(Object.entries(authProfiles).flatMap(([profileId, value]) => {
      const provider = value?.provider;
      return provider && profileId === `${provider}:default` ? [provider] : [];
    }));
    const keyDigests = await this._localKeyDigests();
    let canUpdateProvider = false;
    try {
      const capabilities = await this.getModelChangeCapabilities();
      canUpdateProvider = capabilities?.supported === true && capabilities.updateProvider === true;
    } catch { /* adapter 不可用时继续检查 config-only 能力 */ }
    if (!canUpdateProvider) {
      try {
        const capabilities = await this.getModelConfigWriteCapabilities();
        canUpdateProvider = capabilities?.supported === true && capabilities.updateProvider === true;
      } catch { /* 两条能力链都不可读时 fail-closed */ }
    }
    // 三源并集：快照目录 ∪ config ∪ auth 存储（key 只进过 auth-profiles 的 provider
    // ——如 `openclaw models auth paste-api-key` 配的——也要在目录里可见可管）。
    const ids = new Set([...Object.keys(catalog), ...Object.keys(cfgProviders), ...authProviderSet]);
    const providers = [...ids].sort().flatMap((id) => {
      const cat = catalog[id] || null;
      const cfg = cfgProviders[id] || null;
      const emptyShell = cat && !cfg
        && !cat.envKeys.length && !cat.oauth.length && !cat.baseUrl && !cat.defaultModels.length;
      if (emptyShell) return [];
      const keyInConfig = !!(cfg && cfg.apiKey); // 哨兵/SecretRef/字符串皆真值
      const keyInAuth = authProviderSet.has(id);
      // 用户已在 config/auth 里配过的一律放行——分类再对也不能把用户配好的东西藏起来
      if (!cfg && !keyInAuth && this._outOfDirectoryScope(cat)) return [];
      return [{
        id,
        label: cat?.label || id,
        logoKey: id,
        getKeyUrl: cat?.getKeyUrl || null,
        // 保存分支判据：config 有条目走 update-provider；没有则 key 走 auth-profile
        // 直写、覆盖端点走 create（见 OpenClawProvidersPane 的 save）。
        inConfig: !!cfg,
        api: (cfg?.api || cat?.api) ?? null,
        baseUrl: {
          value: typeof cfg?.baseUrl === "string" ? cfg.baseUrl : null,
          defaultValue: cat?.baseUrl ?? null,
          editable: true,
        },
        key: {
          configured: keyInConfig || keyInAuth,
          clearable: keyInConfig
            ? canUpdateProvider
            : keyInAuth && this._isLocalGateway() && defaultAuthProviderSet.has(id),
          source: keyInConfig ? "config" : (keyInAuth ? "auth-profile" : null),
          // 本机才有摘要；远程 null → UI 退化显示「已设置」
          redacted: keyDigests.get(id) ?? null,
        },
        // 检测按钮的专用探针 path（见 manual 的 keyProbePath；null = 探 /models）
        keyProbePath: cat?.keyProbePath ?? null,
        configured: !!cfg || keyInAuth,
        // 自定义 = 不在 OpenClaw 插件目录（生成快照）里的条目：用户 config 自建
        // provider、paste-api-key 进 auth 的目录外家、manual 补元数据的常见家。
        custom: cat?.builtin !== true,
        modelsCount: Array.isArray(cfg?.models) ? cfg.models.length : (cat?.defaultModels?.length || 0),
        // 未配置目录 provider 首次「覆盖端点」要走 create（config 的 models 必填），
        // 用快照默认首模型起步；没有默认模型的家为 null（UI 回落 "default"）。
        defaultModelId: cat?.defaultModels?.[0]?.id ?? null,
        oauth: (cat?.oauth || []).map(({ choiceId, method, label }) => ({ choiceId, method, label })),
      }];
    });
    return { supported: true, providers };
  }

  /**
   * 自定义端点只读快照：只纳入 config 中目录外、具备有效 HTTP(S) 端点和模型的 provider。
   * Key 只输出本机安全摘要；明文、SecretRef 和远程凭证均不会进入响应。
   */
  async listCustomEndpoints({ refreshAuth = true } = {}) {
    const { parsed } = await this._configSnapshot();
    const catalog = this._providerCatalogSnapshot().providers;
    // Normal loads and key edits query fresh Gateway metadata. Model-only save
    // readback can reuse it while still reading fresh endpoint configuration.
    const [authKeyProfiles, keyDigests] = await Promise.all([
      this._loadEndpointAuthKeyProfiles({ refresh: refreshAuth }),
      this._localKeyDigests({ refresh: refreshAuth }),
    ]);
    let canUpdateProvider = false;
    try {
      const capabilities = await this.getModelChangeCapabilities();
      canUpdateProvider = capabilities?.supported === true && capabilities.updateProvider === true;
    } catch { /* 完整能力不可读时继续检查 config-only 能力 */ }
    if (!canUpdateProvider) {
      try {
        const capabilities = await this.getModelConfigWriteCapabilities();
        canUpdateProvider = capabilities?.supported === true && capabilities.updateProvider === true;
      } catch { /* 两条能力链都不可读时 fail-closed，不影响只读列表 */ }
    }

    const providers = parsed?.models?.providers && typeof parsed.models.providers === "object"
      ? parsed.models.providers
      : {};
    const primaryHolders = [
      { ref: parsed?.agents?.defaults?.model?.primary, isDefault: true },
      ...readCanonicalAgentEntries(parsed).map((agent) => ({ ref: agent.model?.primary, agentId: agent.id })),
    ];
    const modelOwners = new Map();
    for (const [providerId, value] of Object.entries(providers)) {
      for (const model of Array.isArray(value?.models) ? value.models : []) {
        if (typeof model?.id !== "string") continue;
        const owners = modelOwners.get(model.id) || new Set();
        owners.add(providerId);
        modelOwners.set(model.id, owners);
      }
    }
    const endpoints = Object.entries(providers).flatMap(([id, provider]) => {
      if (!provider || typeof provider !== "object" || Array.isArray(provider)) return [];
      const baseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl.trim() : "";
      try {
        const url = new URL(baseUrl);
        if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
          return [];
        }
      } catch {
        return [];
      }
      if (!Array.isArray(provider.models) || provider.models.length === 0) return [];
      if (catalog[id]?.builtin === true) return [];

      const models = provider.models
        .filter((model) => typeof model?.id === "string" && model.id.trim())
        .map((model) => model.id.trim());
      if (models.length === 0) return [];
      const configKey = provider.apiKey != null && provider.apiKey !== "";
      const providerAuthProfiles = authKeyProfiles.get(id);
      const authKey = Boolean(providerAuthProfiles?.size);
      const defaultAuthKey = providerAuthProfiles?.has(`${id}:default`) === true;
      const hasApiKey = configKey || authKey;
      const managedKey = provider.apiKey && typeof provider.apiKey === "object";
      const canRevealApiKey = hasApiKey
        && this._isLocalGateway()
        && !managedKey
        && (typeof provider.apiKey === "string" || defaultAuthKey);
      const canClearConfiguredKey = configKey || defaultAuthKey;
      // Include retained bindings after a confirmed deselection. Reopening the
      // editor should show their usage without selecting the removed model again.
      const usageModels = [...new Set([...models, ...primaryHolders.flatMap(({ ref }) =>
        typeof ref === "string" && ref.startsWith(`${id}/`) ? [ref.slice(id.length + 1)] : [])])];
      const primaryModelUsage = usageModels.flatMap((modelId) => {
        const holders = primaryHolders.filter(({ ref }) => ref === `${id}/${modelId}`
          || (ref === modelId && modelOwners.get(modelId)?.size === 1));
        return holders.length ? [{ modelId,
          isDefault: holders.some((holder) => holder.isDefault),
          agentIds: [...new Set(holders.map((holder) => holder.agentId).filter(Boolean))],
        }] : [];
      });

      return [{
        id,
        name: id,
        baseUrl,
        model: models[0] || "",
        models,
        ...(primaryModelUsage.length ? { primaryModelUsage } : {}),
        ...(typeof provider.api === "string" && provider.api.trim()
          ? { api: provider.api.trim() }
          : {}),
        hasApiKey,
        apiKeyPreview: keyDigests.get(id) ?? null,
        canRevealApiKey,
        canClearApiKey: canClearConfiguredKey && canUpdateProvider,
        discoverModels: false,
        source: "config",
      }];
    });
    return {
      supported: true,
      endpoints,
      form: {
        apiOptions: [...OPENCLAW_MODEL_APIS],
        defaultApi: "openai-completions",
        nameEditable: false,
        nameIsProviderId: true,
        providerIdEditable: canUpdateProvider && this._isLocalGateway(),
        firstModelIsDefault: false,
        batchModelSelection: true,
        allowPrimaryModelRemoval: true,
      },
    };
  }

  /**
   * 自定义 provider 的端点探测（R370；契约方法与 Hermes 的 validateCustomEndpoint 同形，
   * 所以 `/__api/models/endpoints/validate?backend=openclaw` 那条路由不用改）。
   *
   * 上游对「Custom Provider」的定义就是「任何 OpenAI / Anthropic 兼容端点」，所以探测
   * 就是去要一次目录：`GET {baseUrl}/models`（两家的响应都是 `{data:[{id}]}`）。Hermes
   * 那边这活儿是 dashboard 代劳的，OpenClaw 网关没有对应 RPC，我们自己发这一次 HTTP。
   *
   * **无副作用**：不写 config、不碰授权存储。失败也不抛——返回 `ok:false` + message，
   * 弹窗拿它当提示，用户仍可在底部手动补模型 ID（与 Hermes 弹窗同样的兜底）。
   */
  async validateCustomEndpoint(endpoint = {}) {
    const raw = String(endpoint.baseUrl || "").trim();
    if (!/^https?:\/\//i.test(raw)) {
      return { ok: false, reachable: false, message: "端点地址要以 http(s):// 开头", models: [] };
    }
    // probePath（R371）：验 Key 的专用探针 path，默认 /models。openrouter 这类
    // /models 公开（坏 key 也 200）的家用它自家的鉴权探针（/key，坏 key 401），
    // 检测按钮才不会假阳性。来源是 manual 快照的 keyProbePath 数据位。
    const probePath = typeof endpoint.probePath === "string" && endpoint.probePath.startsWith("/")
      ? endpoint.probePath : "/models";
    const url = `${raw.replace(/\/+$/, "")}${probePath}`;
    const key = String(endpoint.apiKey || "").trim();
    const headers = { accept: "application/json" };
    // OpenAI 兼容口用 Bearer；Anthropic 兼容口认 x-api-key，两个都带上，认哪个由端点决定
    if (key) {
      headers.authorization = `Bearer ${key}`;
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
    }
    let status = 0;
    let text = "";
    try {
      const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(12000) });
      status = res.status;
      text = await res.text();
    } catch (err) {
      const msg = err?.name === "TimeoutError" ? "端点 12s 内没有响应" : (err?.message || String(err));
      return { ok: false, reachable: false, message: `连不上 ${url}：${msg}`, models: [] };
    }
    if (status >= 300) {
      return {
        ok: false, reachable: true, models: [],
        message: `端点返回 ${status}${text ? `：${text.slice(0, 200)}` : ""}`,
      };
    }
    let body = null;
    try { body = JSON.parse(text); } catch { /* 非 JSON → 下面按空目录处理 */ }
    // 三种常见目录形状：OpenAI/Anthropic 的 {data:[…]}、{models:[…]}、裸数组
    const rows = Array.isArray(body) ? body
      : Array.isArray(body?.data) ? body.data
        : Array.isArray(body?.models) ? body.models : [];
    const models = [...new Set(rows
      .map((m) => (typeof m === "string" ? m : String(m?.id || m?.name || "")).trim())
      .filter(Boolean))].slice(0, 500);
    return {
      ok: true, reachable: true, models,
      // 走专用探针时响应本来就不是模型目录，别把「没目录」当异常提示
      message: models.length || probePath !== "/models" ? "" : "端点没有返回模型目录",
    };
  }

  /**
   * create/update 共用的同 id 覆盖写；新 provider 才写 baseUrl/api 端点字段。
   * 密钥收敛（R178 官方推荐形态）：本机网关时 apiKey 写 auth-profiles（先写
   * profile 再 patch config，profile 失败即零 config 写）；远程网关授权文件
   * 不可达，降级为旧行为把 key 放进 config provider。
   */
  _configOnlyModelTargetDigest(provider, modelId, target) {
    const pick = (value, fields) => Object.fromEntries(fields.map((field) => [field, value?.[field] ?? null]));
    const model = (provider?.models || []).find((item) => item.id === modelId);
    const stable = (value) => Array.isArray(value) ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
    return createHash("sha256").update(JSON.stringify(stable({
      model: pick(model ? { ...model, reasoning: model.reasoning === true } : null, target.modelFields),
      provider: pick({ baseUrl: provider?.baseUrl || "", api: provider?.api || "openai-completions" }, target.providerFields),
    }))).digest("hex");
  }

  async _configOnlyUpsertModel(safeSpec, secretEnvelope, context) {
    const key = safeSpec.providerKey;
    const m = safeSpec.model || {};
    const requestedBaseUrl = safeSpec.baseUrl || "";
    // Check the destination before touching credentials. A newly occupied name
    // is only replayable when this operation already witnessed that exact target.
    const { parsed: beforeAuth } = await this._configSnapshot();
    const initialProvider = beforeAuth?.models?.providers?.[key] || null;
    const witnessedTarget = context?.journalEntry?.fingerprints?.configOnlyTarget;
    const endpointFields = { modelFields: [], providerFields: ["baseUrl", "api"] };
    const endpointDigest = (provider) => this._configOnlyModelTargetDigest(provider, m.id, endpointFields);
    const assertProviderDestination = (provider) => {
      const isVerifiedReplay = witnessedTarget
        && this._configOnlyModelTargetDigest(provider, m.id, witnessedTarget) === witnessedTarget.digest;
      if ((safeSpec.providerMode === "new" && provider && !isVerifiedReplay)
        || (witnessedTarget?.providerDigest && (provider || safeSpec.providerMode !== "new")
          && endpointDigest(provider) !== witnessedTarget.providerDigest)
        || endpointDigest(provider) !== endpointDigest(initialProvider)) {
        const error = new Error("Provider changed before the configuration write");
        error.code = "provider_conflict";
        error.stage = "config-write";
        throw error;
      }
    };
    assertProviderDestination(initialProvider);
    const apiKey = String(secretEnvelope?.apiKey || "").trim();
    const keyToProfile = Boolean(apiKey) && this._isLocalGateway();
    let localAuthKeyProviders;
    if (keyToProfile) {
      await this._writeAuthProfileKey(key, apiKey);
      await context?.recordStage?.("credential-write", { secretStep: "applied" });
      localAuthKeyProviders = this._localAuthKeyProviders();
    } else {
      localAuthKeyProviders = new Set((await this._loadLocalAuthKeyProfiles()).keys());
    }
    let registryEntry = null;
    let configOnlyTarget = null;
    const patchInfo = await this._patchModelProviders((current, parsed) => {
      const existing = current[key] && typeof current[key] === "object" ? current[key] : null;
      assertProviderDestination(existing);
      if (!existing && !requestedBaseUrl) {
        // auth 型 provider(config 不管定义,如 openrouter):模型条目就是 allowlist 键,
        // 裸登记即生效(目录元数据由上游提供)——不建 config provider 条目。
        const managed = localAuthKeyProviders.has(key)
          || this._agentModelKeysOf(parsed, key).length > 0;
        if (managed) {
          configOnlyTarget = { modelFields: [], providerFields: ["baseUrl", "api"] };
          configOnlyTarget.providerDigest = endpointDigest(null);
          configOnlyTarget.digest = this._configOnlyModelTargetDigest(null, m.id, configOnlyTarget);
          return {
            patchProviders: {},
            replacePaths: [],
            patchAgentModels: { [`${key}/${m.id}`]: {} },
          };
        }
        throw new Error(`provider ${key} 不存在，新建需提供 baseUrl`);
      }
      const entry = {
        id: m.id,
        name: String(m.name || "").trim() || m.id,
        ...(m.reasoning === true ? { reasoning: true } : {}),
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        ...(Number(m.contextWindow) > 0 ? { contextWindow: Number(m.contextWindow) } : {}),
        ...(Number(m.maxTokens) > 0 ? { maxTokens: Number(m.maxTokens) } : {}),
      };
      const models = (Array.isArray(existing?.models) ? existing.models : []).filter(
        (x) => x?.id !== m.id,
      );
      models.push(entry);
      const patchProvider = existing
        ? { models, ...(apiKey && !keyToProfile ? { apiKey } : {}) }
        : {
            baseUrl: requestedBaseUrl,
            ...(apiKey && !keyToProfile ? { apiKey } : {}),
            api: String(safeSpec.api || "").trim() || "openai-completions",
            models,
          };
      // 注册表镜像 = 该 provider 的最终形态(端点+全部模型),永不带 key
      registryEntry = {
        baseUrl: existing ? String(existing.baseUrl || "") : requestedBaseUrl,
        api: (existing ? existing.api : null) || String(safeSpec.api || "").trim() || "openai-completions",
        models,
      };
      configOnlyTarget = {
        // Whole-array replacement also clears omitted optional fields. Bind those
        // absences and the endpoint so recovery cannot accept another edit or send
        // a resupplied credential to a provider whose destination has changed.
        modelFields: ["id", "name", "reasoning", "input", "cost", "contextWindow", "maxTokens"],
        providerFields: ["baseUrl", "api"],
        providerDigest: endpointDigest(registryEntry),
      };
      configOnlyTarget.digest = this._configOnlyModelTargetDigest(registryEntry, m.id, configOnlyTarget);
      return {
        patchProviders: { [key]: patchProvider },
        // 同 id 覆盖会移除既有数组元素 → 属破坏性变更，显式整体替换
        replacePaths: existing ? [`models.providers.${key}.models`] : [],
        // 允许列表登记（{} 并入不覆盖既有自定义值），否则重启网关后模型不进目录。
        patchAgentModels: { [`${key}/${m.id}`]: {} },
      };
    }, {
      beforeWrite: async () => context?.recordStage?.("config-write-pending", {
        fingerprints: { ...(context?.journalEntry?.fingerprints || {}), configOnlyTarget },
      }),
    });
    // agent 运行时读主注册表——config 写成功后必须镜像,否则 agent 侧 missing-provider-auth
    if (registryEntry) this._syncRegistryProvider(key, registryEntry);
    return patchInfo;
  }

  /**
   * 8.1 的模型可见性与展示设置是两层独立配置：modelPolicy.allow 管可见性，
   * models 只管 alias/settings。这里仅对精确 provider/model 键做搬移或删除；
   * bare alias、provider/* 等模式键不参与，目标已存在时以目标显式字段为准。
   */
  _agentModelMetadataMutation(parsed, { policyMatch, settingsMatch = policyMatch, rewrite = null }) {
    const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const mutateAllow = (allow) => {
      if (!Array.isArray(allow)) return allow;
      const next = [];
      for (const ref of allow) {
        if (!policyMatch(ref)) next.push(ref);
        else if (rewrite) next.push(rewrite(ref));
      }
      return [...new Set(next)];
    };
    const mutateModels = (models) => {
      if (!isObject(models)) return models;
      const next = clone(models);
      for (const oldRef of Object.keys(models)) {
        if (!settingsMatch(oldRef)) continue;
        const oldValue = models[oldRef];
        delete next[oldRef];
        if (!rewrite) continue;
        const newRef = rewrite(oldRef);
        if (newRef === oldRef) {
          next[oldRef] = oldValue;
          continue;
        }
        if (Object.hasOwn(next, newRef)) {
          const targetValue = next[newRef];
          next[newRef] = isObject(oldValue) && isObject(targetValue)
            ? { ...clone(oldValue), ...clone(targetValue) }
            : clone(targetValue);
        } else {
          next[newRef] = clone(oldValue);
        }
      }
      return next;
    };

    const defaults = parsed?.agents?.defaults || {};
    const nextDefaultsModels = mutateModels(defaults.models);
    const entries = readCanonicalAgentEntries(parsed);
    const nextEntries = entries.map((entry) => {
      const next = clone(entry);
      if (Array.isArray(entry?.modelPolicy?.allow)) {
        next.modelPolicy = { ...next.modelPolicy, allow: mutateAllow(entry.modelPolicy.allow) };
      }
      if (isObject(entry?.models)) next.models = mutateModels(entry.models);
      return next;
    });
    const nextParsed = {
      agents: {
        defaults: { ...defaults, ...(nextDefaultsModels === undefined ? {} : { models: nextDefaultsModels }) },
        ...(nextEntries.length
          ? { entries: Object.fromEntries(nextEntries.map(({ id, ...entry }) => [id, entry])) }
          : {}),
      },
    };
    return {
      ...this._diffAgentModelMetadata(parsed, nextParsed),
      nextDefaultsModels,
      nextEntries,
    };
  }

  _diffAgentModelMetadata(before, after) {
    const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const mapPatch = (oldMap, newMap) => {
      if (!isObject(oldMap) && !isObject(newMap)) return null;
      const beforeMap = isObject(oldMap) ? oldMap : {};
      const afterMap = isObject(newMap) ? newMap : {};
      const patch = {};
      for (const key of new Set([...Object.keys(beforeMap), ...Object.keys(afterMap)])) {
        if (!Object.hasOwn(afterMap, key)) patch[key] = null;
        else if (!Object.hasOwn(beforeMap, key) || !same(beforeMap[key], afterMap[key])) patch[key] = afterMap[key];
      }
      return Object.keys(patch).length ? patch : null;
    };

    const defaultsModels = mapPatch(before?.agents?.defaults?.models, after?.agents?.defaults?.models);
    const beforeEntries = new Map(readCanonicalAgentEntries(before).map((entry) => [entry.id, entry]));
    const afterEntries = new Map(readCanonicalAgentEntries(after).map((entry) => [entry.id, entry]));
    const entries = {};
    const replacePaths = [];
    for (const [id, next] of afterEntries) {
      const prev = beforeEntries.get(id) || { id };
      const patch = {};
      const prevAllow = prev?.modelPolicy?.allow;
      const nextAllow = next?.modelPolicy?.allow;
      if (!same(prevAllow, nextAllow)) {
        patch.modelPolicy = { ...(next.modelPolicy || {}), allow: nextAllow || [] };
        replacePaths.push(`agents.entries.${id}.modelPolicy.allow`);
      }
      const models = mapPatch(prev.models, next.models);
      if (models) patch.models = models;
      if (Object.keys(patch).length) entries[id] = patch;
    }
    return {
      defaultsModels,
      entries: Object.keys(entries).length ? entries : null,
      replacePaths,
    };
  }

  _isExactProviderModelSettingsRef(ref, providerKey) {
    if (typeof ref !== "string" || !ref.startsWith(`${providerKey}/`)) return false;
    const modelId = ref.slice(providerKey.length + 1);
    return Boolean(modelId) && !modelId.includes("*");
  }

  /** 枚举 agents.defaults.modelPolicy.allow 里属于某 provider 的引用。 */
  _agentModelKeysOf(parsed, providerKey) {
    return (readDefaultModelPolicyAllow(parsed) || [])
      .filter((item) => item.startsWith(`${providerKey}/`));
  }

  /**
   * 删除前的引用收口：普通删除保护 primary。端点模型重选经用户确认后可保留
   * primary 绑定，让 OpenClaw 按已有运行配置处理；不替用户选择新主模型。
   * fallbacks 引用随同一次 patch 剔除。整项 provider 删除仍要求先更换主模型。
   */
  _ghostRefCleanup(parsed, matches, label, { preservePrimaryRefs = false } = {}) {
    const defaultsModel = parsed?.agents?.defaults?.model || {};
    const primaryHolders = [];
    if (matches(defaultsModel.primary)) primaryHolders.push("defaults");
    const list = readCanonicalAgentEntries(parsed);
    for (const agent of list) {
      if (matches(agent?.model?.primary)) primaryHolders.push(agent?.id || "agent");
    }
    if (primaryHolders.length > 0 && !preservePrimaryRefs) {
      const error = new Error(
        `${label} 仍是 ${primaryHolders.join("/")} 的主模型，请先切换主模型再删除`,
      );
      error.code = "primary_model_in_use";
      error.status = 409;
      throw error;
    }
    const refs = {};
    const extraPaths = [];
    if (Array.isArray(defaultsModel.fallbacks) && defaultsModel.fallbacks.some(matches)) {
      refs.defaultsFallbacks = defaultsModel.fallbacks.filter((item) => !matches(item));
      extraPaths.push("agents.defaults.model.fallbacks");
    }
    if (list.some((agent) => Array.isArray(agent?.model?.fallbacks) && agent.model.fallbacks.some(matches))) {
      refs.entries = list.map((agent) => {
        if (!Array.isArray(agent?.model?.fallbacks) || !agent.model.fallbacks.some(matches)) return agent;
        return {
          ...agent,
          model: { ...agent.model, fallbacks: agent.model.fallbacks.filter((item) => !matches(item)) },
        };
      });
      for (const agent of list) {
        if (agent?.id && Array.isArray(agent?.model?.fallbacks) && agent.model.fallbacks.some(matches)) {
          extraPaths.push(`agents.entries.${agent.id}.model.fallbacks`);
        }
      }
    }
    return { patchModelRefs: Object.keys(refs).length ? refs : null, extraPaths };
  }

  async _configOnlyDeleteModel(safeSpec) {
    const key = safeSpec.providerKey;
    const id = safeSpec.sourceModelId;
    let providerRemoved = false;
    let remainingModels = null;
    const patchInfo = await this._patchModelProviders((current, parsed) => {
      // hash 冲突会带着新快照重跑本闭包:结论必须只反映最后一次成功的那轮
      providerRemoved = false;
      remainingModels = null;
      const existing = current[key] && typeof current[key] === "object" ? current[key] : null;
      const before = existing && Array.isArray(existing.models) ? existing.models : [];
      const inConfig = existing && before.some((x) => x?.id === id);
      if (!inConfig) {
        // 目录模型(config 不管定义,如 openrouter 内置目录):删除=从允许列表移除
        // + 引用收口。allowlist 没键也没引用 → 确实无从删起,报不存在。
        const allowKey = `${key}/${id}`;
        const allow = Object.fromEntries((readDefaultModelPolicyAllow(parsed) || []).map((ref) => [ref, true]));
        const matches = (ref) => ref === allowKey;
        const { patchModelRefs, extraPaths } = this._ghostRefCleanup(parsed, matches, `模型 ${allowKey}`);
        const patchAgentMetadata = this._agentModelMetadataMutation(parsed, {
          policyMatch: matches,
          settingsMatch: matches,
        });
        if (!(allowKey in allow) && !patchModelRefs) {
          throw new Error(existing ? `模型 ${id} 不在 ${key} 配置里` : `provider ${key} 不存在或不可编辑`);
        }
        return {
          patchProviders: {},
          replacePaths: extraPaths,
          patchAgentModels: { [allowKey]: null },
          patchModelRefs,
          patchAgentMetadata,
        };
      }
      const models = before.filter((x) => x?.id !== id);
      if (models.length === 0) {
        // 删空 → 连 provider 一起移除（null 删键），允许列表清掉该 provider 全部键
        // （含历史残留）。replacePaths 必须给被删对象之下的「精确数组路径」
        // （gateway 的破坏性检查按 exact path 匹配，不认前缀）。
        providerRemoved = true;
        const matches = (ref) => typeof ref === "string" && ref.startsWith(`${key}/`);
        const { patchModelRefs, extraPaths } = this._ghostRefCleanup(parsed, matches, `provider ${key}`);
        const patchAgentMetadata = this._agentModelMetadataMutation(parsed, {
          policyMatch: matches,
          settingsMatch: (ref) => this._isExactProviderModelSettingsRef(ref, key),
        });
        return {
          patchProviders: { [key]: null },
          replacePaths: [`models.providers.${key}.models`, ...extraPaths],
          patchAgentModels: Object.fromEntries(
            this._agentModelKeysOf(parsed, key).map((item) => [item, null]),
          ),
          patchModelRefs,
          patchAgentMetadata,
        };
      }
      const matches = (ref) => ref === `${key}/${id}`;
      const { patchModelRefs, extraPaths } = this._ghostRefCleanup(parsed, matches, `模型 ${key}/${id}`);
      const patchAgentMetadata = this._agentModelMetadataMutation(parsed, {
        policyMatch: matches,
        settingsMatch: matches,
      });
      remainingModels = models;
      return {
        patchProviders: { [key]: { models } },
        replacePaths: [`models.providers.${key}.models`, ...extraPaths],
        patchAgentModels: { [`${key}/${id}`]: null },
        patchModelRefs,
        patchAgentMetadata,
      };
    });
    if (providerRemoved) {
      await this._dropAuthProfileKeyQuietly(key);
      this._syncRegistryProvider(key, null);
      this._purgeAgentShadowRegistries(key);
    } else if (remainingModels) {
      // 注册表镜像剩余模型;条目不存在则跳过(纯 config 时代的老 provider 不强建)
      const { data } = this._isLocalGateway() ? this._readRegistry() : { data: null };
      const prev = data?.providers?.[key];
      if (prev && typeof prev === "object") {
        this._syncRegistryProvider(key, { ...prev, models: remainingModels });
      }
    }
    return patchInfo;
  }

  async _configOnlyDeleteProvider(safeSpec) {
    const key = safeSpec.providerKey;
    const localAuthKeyProviders = new Set((await this._loadLocalAuthKeyProfiles()).keys());
    const patchInfo = await this._patchModelProviders((current, parsed) => {
      const inConfig = current[key] && typeof current[key] === "object";
      if (!inConfig && !localAuthKeyProviders.has(key)) {
        throw new Error(`provider ${key} 不存在或不可编辑`);
      }
      const matches = (ref) => typeof ref === "string" && ref.startsWith(`${key}/`);
      const { patchModelRefs, extraPaths } = this._ghostRefCleanup(parsed, matches, `provider ${key}`);
      const patchAgentMetadata = this._agentModelMetadataMutation(parsed, {
        policyMatch: matches,
        settingsMatch: (ref) => this._isExactProviderModelSettingsRef(ref, key),
      });
      // 允许列表连同历史残留一起清（config 里没有但 allowlist 有的键同样属于该 provider）。
      const patchAgentModels = Object.fromEntries(
        this._agentModelKeysOf(parsed, key).map((item) => [item, null]),
      );
      if (!inConfig) {
        // auth-only(内置 provider):config 无条目,删除=撤销授权;引用/允许列表
        // 照常收口,全空则零 config 写(文件层清理在 patch 后照跑)。
        if (!Object.keys(patchAgentModels).length && !patchModelRefs && !extraPaths.length) return null;
        return { patchProviders: {}, replacePaths: extraPaths, patchAgentModels, patchModelRefs, patchAgentMetadata };
      }
      return {
        patchProviders: { [key]: null },
        replacePaths: [`models.providers.${key}.models`, ...extraPaths],
        patchAgentModels,
        patchModelRefs,
        patchAgentMetadata,
      };
    });
    await this._dropAuthProfileKeyQuietly(key);
    this._syncRegistryProvider(key, null);
    this._purgeAgentShadowRegistries(key);
    return patchInfo;
  }

  async _deleteCanonicalAuthKeysForProvider(providerKey) {
    const profiles = await this._loadCanonicalAuthProfiles();
    for (const profile of profiles) {
      if (profile.provider === providerKey && profile.type === "api_key") {
        await this._deleteCanonicalAuthProfile(profile.id);
      }
    }
  }

  /** 删除 provider 时顺带清它的 api_key profile（oauth 不动）；失败仅告警不阻断删除结果。 */
  async _dropAuthProfileKeyQuietly(providerKey) {
    if (!this._isLocalGateway()) return;
    try {
      if (this._usesCanonicalModelAuthCli()) {
        await this._deleteCanonicalAuthKeysForProvider(providerKey);
        return;
      }
      const { file, data } = this._readAuthProfiles();
      const id = `${providerKey}:default`;
      if (data.profiles?.[id]?.type === "api_key") {
        delete data.profiles[id];
        this._writeAuthProfiles(file, data);
        this._syncAgentSqliteAuthKey(id, null);
      }
    } catch (err) {
      console.error(`[openclaw] 清理 ${providerKey} 的授权 profile 失败:`, err?.message || err);
    }
  }

  async _providerRenameConfigKey(from, to, value) {
    if (typeof value === "string" && value.includes("REDACTED")) {
      const home = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
      const config = JSON.parse(fs.readFileSync(path.join(home, "openclaw.json"), "utf8"));
      const key = config.models?.providers?.[from]?.apiKey ?? config.models?.providers?.[to]?.apiKey;
      if (key === undefined) throw Object.assign(new Error("无法读取原端点密钥，尚未改名"), { code: "auth_read_failed" });
      return key;
    }
    return value;
  }

  async _loadProviderRenameAuth(from, to, agentIds = this._modelAuthAgentIds()) {
    // The installed SDK provides a read-only projection of canonical auth.
    // Writes still go through the official CLI, which owns the state DB.
    const sdk = path.join(path.dirname(fs.realpathSync(resolveOpenclawBin())), "dist", "plugin-sdk", "agent-runtime.js");
    const home = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
    const script = `
      import { pathToFileURL } from 'node:url';
      import path from 'node:path';
      const [sdk, home, from, to, agents] = process.argv.slice(1);
      const { loadAuthProfileStoreForSecretsRuntime, resolvePersistedAuthProfileOwnerAgentDir } = await import(pathToFileURL(sdk).href);
      const rows = [];
      const seen = new Set();
      for (const agent of JSON.parse(agents)) {
        const agentDir = path.join(home, 'agents', agent, 'agent');
        const store = loadAuthProfileStoreForSecretsRuntime(agentDir);
        for (const [id, profile] of Object.entries(store.profiles || {})) {
          if (profile.provider !== from && profile.provider !== to) continue;
          const owner = resolvePersistedAuthProfileOwnerAgentDir({ agentDir, profileId: id });
          const ownerAgent = owner ? path.basename(path.dirname(owner)) : JSON.parse(agents)[0];
          const identity = ownerAgent + ':' + id;
          if (seen.has(identity)) continue;
          seen.add(identity);
          rows.push({ agent: ownerAgent, id, provider: profile.provider,
            type: profile.type, key: profile.key, order: store.order?.[from] || [] });
        }
      }
      process.stdout.write(JSON.stringify(rows));
    `;
    return new Promise((resolve, reject) => {
      execFile("node", ["--input-type=module", "-e", script, sdk, home, from, to || "", JSON.stringify(agentIds)], {
        env: process.env, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
      }, (error, stdout) => {
        // Never put SDK stdout/stderr (which can contain credentials) in errors.
        if (error) return reject(Object.assign(new Error("无法读取原端点授权，尚未改名"), { code: "auth_read_failed" }));
        try { resolve(JSON.parse(stdout)); }
        catch { reject(Object.assign(new Error("端点授权读取失败"), { code: "auth_read_failed" })); }
      });
    });
  }

  async _readProviderRenameAuth(from, to, suppliedKey, clearKey, resumed = false) {
    const all = await this._loadProviderRenameAuth(from, to);
    const destination = all.filter(row => row.provider === to);
    if (!resumed && destination.length) throw Object.assign(new Error("该 Provider ID 已有授权，请使用其他 ID"), { code: "provider_exists" });
    const rows = all.filter(row => row.provider !== to);
    for (const row of rows) {
      if (row.type !== "api_key") throw Object.assign(new Error("该端点使用登录授权，不能迁移为自定义 Provider ID"), { code: "auth_profile_reauth_required" });
      if (!clearKey && !suppliedKey && (typeof row.key !== "string" || !row.key.trim())) {
        throw Object.assign(new Error("原密钥由外部凭证管理；改名时请填写 API Key"), { code: "auth_profile_reauth_required" });
      }
      if (suppliedKey) row.key = suppliedKey;
      row.clearKey = clearKey === true;
      const copied = destination.find(item => item.agent === row.agent && item.id === renameProfileRef(row.id, from, to));
      row.copied = Boolean(copied && copied.type === row.type && copied.key === row.key);
    }
    if (!rows.length && suppliedKey) for (const agent of this._modelAuthAgentIds()) {
      rows.push({ agent, id: `${from}:default`, type: "api_key", key: suppliedKey, order: [], created: true });
    }
    return rows;
  }

  async _copyProviderRenameAuth(rows, from, to, context = {}) {
    for (const row of rows) {
      if (row.clearKey || row.copied) continue;
      context.assertProviderLease?.();
      await this._runModelAuthCli(["models", "auth", "paste-api-key", "--provider", to,
        "--profile-id", renameProfileRef(row.id, from, to), "--agent", row.agent], { stdin: row.key });
    }
    for (const agent of [...new Set(rows.map(row => row.agent))]) {
      const row = rows.find(item => item.agent === agent && !item.clearKey && item.order?.length);
      context.assertProviderLease?.();
      if (row) await this._runModelAuthCli(["models", "auth", "order", "set", "--provider", to,
        "--agent", agent, ...row.order.map(id => renameProfileRef(id, from, to))]);
    }
  }

  async _finishProviderRenameAuth(rows, from, to, context = {}) {
    for (const row of rows) {
      // Non-prefixed profile IDs are stable identities whose provider binding
      // was updated in place; logging them out would remove the migrated key.
      if (!row.created && renameProfileRef(row.id, from, to) !== row.id) {
        context.assertProviderLease?.();
        await this._runModelAuthCli(["models", "auth", "logout", row.id, "--yes", "--agent", row.agent]);
      }
    }
    this._canonicalAuthProfiles = null;
    this._endpointAuthKeyProfiles = null;
  }

  async _configOnlyUpdateProvider(safeSpec, secretEnvelope, context) {
    const key = safeSpec.providerKey;
    const patch = safeSpec.patch || {};
    const renameTo = typeof patch.renameTo === "string" && patch.renameTo && patch.renameTo !== key
      ? patch.renameTo
      : null;
    if (renameTo && !this._isLocalGateway()) {
      const error = new Error("远程网关不支持改名(授权/注册表文件不在本机,无法同步迁移)");
      error.code = "rename_remote_gateway";
      error.status = 409;
      throw error;
    }
    const fields = {};
    if (patch.clearBaseUrl === true) fields.baseUrl = null; // null 删键，回退默认端点
    else if (patch.baseUrl) fields.baseUrl = patch.baseUrl;
    if (patch.api) fields.api = patch.api;
    if (renameTo) {
      if (patch.clearApiKey === true) fields.apiKey = null;
      let started = Boolean(context?.journalEntry?.fingerprints?.providerRename);
      try {
        return await renameProvider(this, safeSpec, fields, secretEnvelope, {
          ...context,
          recordStage: async (...args) => { started = true; return context?.recordStage?.(...args); },
        });
      } catch (error) {
        // Authentication/inventory failures before staging are proven zero-write.
        // Do not leave a pending operation that would lock the editor forever.
        if (!started) error.providerRenameNotStarted = true;
        throw error;
      }
    }
    // 清除密钥 = config 键与 auth-profile（api_key 型）两层都清干净（哪层有清哪层）
    const canonicalAuth = this._isLocalGateway() && this._usesCanonicalModelAuthCli();
    let dropKeyAfterPatch = false;
    if (patch.clearApiKey === true) {
      fields.apiKey = null;
      if (canonicalAuth) dropKeyAfterPatch = true;
      else await this._dropAuthProfileKeyQuietly(key);
    }
    const apiKey = String(secretEnvelope?.apiKey || "").trim();
    // 密钥收敛：本机网关 key 写 auth-profiles;config 里若还留着旧明文顺带清掉。
    const keyToProfile = Boolean(apiKey) && this._isLocalGateway();
    if (keyToProfile) {
      await this._writeAuthProfileKey(key, apiKey);
      fields.apiKey = null;
    } else if (apiKey) {
      fields.apiKey = apiKey;
    }
    if (Object.keys(fields).length === 0) return { restart: false, noop: true };
    const patchInfo = await this._patchModelProviders((current) => {
      if (!current[key] || typeof current[key] !== "object") {
        // auth-only(内置 provider,凭证型):config 本无条目,key 在 auth-profiles 层
        // (换 key 已写 profile / clearApiKey 已 drop profile),fields 只剩 apiKey
        // 清除项 → 零写返回(幂等:config 没键=已清);有端点字段则明确报错。
        const onlyKeyClear = Object.keys(fields).every((f) => f === "apiKey" && fields[f] === null);
        if (onlyKeyClear) return null;
        throw new Error(`provider ${key} 不存在或不可编辑`);
      }
      // 纯对象字段合并，不碰 models 数组 → 无需 replacePaths
      return { patchProviders: { [key]: fields }, replacePaths: [] };
    });
    if (dropKeyAfterPatch) await this._deleteCanonicalAuthKeysForProvider(key);
    // 端点字段变化镜像注册表(条目存在才;镜像不带 key,apiKey:null 清除项不进镜像)
    if ((fields.baseUrl !== undefined || fields.api !== undefined) && this._isLocalGateway()) {
      try {
        const { data } = this._readRegistry();
        const prev = data.providers?.[key];
        if (prev && typeof prev === "object") {
          const next = { ...prev };
          if (fields.baseUrl === null) delete next.baseUrl;
          else if (fields.baseUrl !== undefined) next.baseUrl = fields.baseUrl;
          if (fields.api !== undefined) next.api = fields.api;
          this._syncRegistryProvider(key, next);
        }
      } catch (err) {
        console.error(`[openclaw] 注册表端点镜像失败(${key}):`, err?.message || err);
      }
    }
    return patchInfo;
  }

  /**
   * provider 整体改名:config 搬键(旧删新建) + 允许列表前缀搬迁 + primary/fallbacks
   * 引用改写(改名不悬空,改写而非拒绝) + 主注册表/分身注册表整体迁移。
   * 旧版 auth-profiles/agent sqlite 一并搬迁；9.1 state DB 凭证由调用方经 CLI 重建。
   * fields 为随改名一并提交的端点变更(null=删键)。
   * 重试时配置已经搬走则只补齐本地镜像，不重复写配置。
   */
  async _configOnlyRenameProvider(oldKey, newKey, fields, {
    staged = false, clearMirroredKey = false, sourceDigest, targetDigest, beforeWrite,
  } = {}) {
    let renamedEntry = null;
    const patchInfo = await this._patchModelProviders((current, parsed) => {
      const existing = current[oldKey];
      if ((existing && sourceDigest && renameDigest(existing) !== sourceDigest)
        || (targetDigest && renameDigest(current[newKey]) !== targetDigest)) {
        throw Object.assign(new Error("端点在改名期间发生变化，请重新读取配置"), { code: "provider_changed", status: 409 });
      }
      if (!existing) {
        if (!current[newKey]) throw new Error(`provider ${oldKey} 不存在或不可编辑`);
        renamedEntry = current[newKey];
        return null;
      }
      if (current[newKey] && !staged) {
        throw Object.assign(new Error(`provider ${newKey} 已存在,不能重名`), { code: "provider_exists", status: 409 });
      }
      const entry = { ...(staged ? current[newKey] : existing) };
      for (const [key, value] of Object.entries(fields)) {
        if (value === null) delete entry[key];
        else entry[key] = value;
      }
      if (entry.apiKey) entry.apiKey = renameProfileRef(entry.apiKey, oldKey, newKey);
      renamedEntry = entry;
      const references = providerRenameReferences(parsed, oldKey, newKey);
      return {
        patchProviders: { [oldKey]: null, [newKey]: entry },
        replacePaths: [`models.providers.${oldKey}.models`, ...references.replacePaths],
        patchExtra: references.patch,
      };
    }, { beforeWrite });
    if (!this._usesCanonicalModelAuthCli()) this._renameAuthProfiles(oldKey, newKey);
    this._renameRegistryProvider(oldKey, newKey, renamedEntry, { clearMirroredKey });
    this._renameAgentShadowRegistries(oldKey, newKey, { clearMirroredKey });
    return patchInfo;
  }

  /** provider 改名版:primary/fallbacks 里 `old/…` 全部改写成 `new/…`。 */
  _refRename(parsed, oldKey, newKey) {
    const prefix = `${oldKey}/`;
    const hit = (ref) => typeof ref === "string" && ref.startsWith(prefix);
    const rewrite = (ref) => (hit(ref) ? `${newKey}/${ref.slice(prefix.length)}` : ref);
    return this._refRewrite(parsed, hit, rewrite);
  }

  /** 通用引用改写(与删除的剔除语义相对):hit(ref) 命中的 primary/fallbacks 引用改写为 rewrite(ref)。 */
  _refRewrite(parsed, hit, rewrite) {
    // rewrite 只对命中的引用调用;未命中的原样保留(调用方的 rewrite 无需自带条件)
    const apply = (ref) => (hit(ref) ? rewrite(ref) : ref);
    const refs = {};
    const extraPaths = [];
    const defaultsModel = parsed?.agents?.defaults?.model || {};
    if (hit(defaultsModel.primary)) refs.defaultsPrimary = rewrite(defaultsModel.primary);
    if (Array.isArray(defaultsModel.fallbacks) && defaultsModel.fallbacks.some(hit)) {
      refs.defaultsFallbacks = defaultsModel.fallbacks.map(apply);
      extraPaths.push("agents.defaults.model.fallbacks");
    }
    const list = readCanonicalAgentEntries(parsed);
    const touched = list.some((agent) => hit(agent?.model?.primary)
      || (Array.isArray(agent?.model?.fallbacks) && agent.model.fallbacks.some(hit)));
    if (touched) {
      refs.entries = list.map((agent) => {
        const m = agent?.model;
        if (!m || typeof m !== "object") return agent;
        const primaryHit = hit(m.primary);
        const fallbacksHit = Array.isArray(m.fallbacks) && m.fallbacks.some(hit);
        if (!primaryHit && !fallbacksHit) return agent;
        return {
          ...agent,
          model: {
            ...m,
            ...(primaryHit ? { primary: rewrite(m.primary) } : {}),
            ...(fallbacksHit ? { fallbacks: m.fallbacks.map(apply) } : {}),
          },
        };
      });
      for (const agent of list) {
        if (agent?.id && Array.isArray(agent?.model?.fallbacks) && agent.model.fallbacks.some(hit)) {
          extraPaths.push(`agents.entries.${agent.id}.model.fallbacks`);
        }
      }
    }
    return { patchModelRefs: Object.keys(refs).length ? refs : null, extraPaths };
  }

  /**
   * 目录模型 id 改名(auth 型/allowlist 驱动的 provider,如 openrouter):模型条目
   * 本体就是 agents.defaults.modelPolicy.allow 的引用——搬引用+ primary/fallbacks
   * 改写,config providers 不动。config 里有定义的模型不走此路(runtime rename)。
   * 重试幂等:旧键已搬走且新键存在 → 零写。
   */
  async _configOnlyRenameCatalogModel(safeSpec) {
    const key = safeSpec.providerKey;
    const oldId = safeSpec.sourceModelId;
    const newId = safeSpec.model?.id;
    if (!oldId || !newId || oldId === newId) throw new Error("rename 需要不同的源/目标模型 id");
    const oldRef = `${key}/${oldId}`;
    const newRef = `${key}/${newId}`;
    return await this._patchModelProviders((current, parsed) => {
      const entry = current[key] && typeof current[key] === "object" ? current[key] : null;
      const configModels = entry && Array.isArray(entry.models) ? entry.models : [];
      if (configModels.some((x) => x?.id === oldId)) {
        const error = new Error(`模型 ${oldRef} 在 config 里有定义,不支持 config-only 改名`);
        error.code = "config_only_kind_unsupported";
        throw error;
      }
      const allow = Object.fromEntries((readDefaultModelPolicyAllow(parsed) || []).map((ref) => [ref, true]));
      if (!(oldRef in allow)) {
        if (newRef in allow) return null; // 重试:已搬走
        throw new Error(`模型 ${oldRef} 不在可用列表里`);
      }
      if (newRef in allow || configModels.some((x) => x?.id === newId)) {
        const error = new Error(`模型 ${newRef} 已存在,不能重名`);
        error.code = "target_conflict";
        error.status = 409;
        throw error;
      }
      const hit = (ref) => ref === oldRef;
      const { patchModelRefs, extraPaths } = this._refRewrite(parsed, hit, () => newRef);
      const patchAgentMetadata = this._agentModelMetadataMutation(parsed, {
        policyMatch: hit,
        settingsMatch: hit,
        rewrite: () => newRef,
      });
      return {
        patchProviders: {},
        replacePaths: extraPaths,
        patchAgentModels: {
          [oldRef]: null,
          [newRef]: allow[oldRef] && typeof allow[oldRef] === "object" ? allow[oldRef] : {},
        },
        patchModelRefs,
        patchAgentMetadata,
      };
    });
  }

  /** auth-profiles 里属于旧名的 profile 整体搬到新名(id 前缀与 provider 字段同改),并逐 agent sqlite 同步。 */
  _renameAuthProfiles(oldKey, newKey) {
    if (!this._isLocalGateway()) return;
    try {
      const { file, data } = this._readAuthProfiles();
      const profiles = data.profiles && typeof data.profiles === "object" ? data.profiles : {};
      const moves = [];
      for (const [id, p] of Object.entries(profiles)) {
        const owned = p?.provider === oldKey || id === oldKey || id.startsWith(`${oldKey}:`);
        if (!owned) continue;
        moves.push({ oldId: id, newId: renameProfileRef(id, oldKey, newKey), profile: p });
      }
      if (!moves.length) return;
      for (const { oldId, newId, profile } of moves) {
        delete profiles[oldId];
        profiles[newId] = { ...profile, provider: newKey };
      }
      this._writeAuthProfiles(file, data);
      for (const { oldId, newId, profile } of moves) {
        this._syncAgentSqliteAuthKey(oldId, null);
        this._syncAgentSqliteAuthKey(newId, { ...profile, provider: newKey });
      }
    } catch (err) {
      console.error(`[openclaw] 授权 profile 改名失败(${oldKey}→${newKey}):`, err?.message || err);
      throw err;
    }
  }

  /** 主注册表条目搬键，并同步授权引用；换 Key 时清掉旧镜像密钥。 */
  _renameRegistryProvider(oldKey, newKey, configEntry, { clearMirroredKey = false } = {}) {
    if (!this._isLocalGateway()) return;
    try {
      const { file, data } = this._readRegistry();
      const prev = data.providers[oldKey] || data.providers[newKey];
      const mirror = {
        baseUrl: String(configEntry.baseUrl || (prev && typeof prev === "object" ? prev.baseUrl : "") || ""),
        api: configEntry.api || (prev && typeof prev === "object" ? prev.api : "") || "openai-completions",
        models: Array.isArray(configEntry.models)
          ? configEntry.models
          : (prev && Array.isArray(prev.models) ? prev.models : []),
        ...(!clearMirroredKey && prev && typeof prev === "object" && prev.apiKey ? { apiKey: renameProfileRef(prev.apiKey, oldKey, newKey) } : {}),
      };
      delete data.providers[oldKey];
      data.providers[newKey] = mirror;
      this._writeRegistry(file, data);
    } catch (err) {
      console.error(`[openclaw] 注册表改名失败(${oldKey}→${newKey}):`, err?.message || err);
      throw err;
    }
  }

  /** 分身注册表条目同步改名(CLI 时代复制品,不迁移会留旧名幽灵)。 */
  _renameAgentShadowRegistries(oldKey, newKey, { clearMirroredKey = false } = {}) {
    if (!this._isLocalGateway()) return;
    try {
      const agentsDir = path.join(process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw"), "agents");
      if (!fs.existsSync(agentsDir)) return;
      for (const name of fs.readdirSync(agentsDir)) {
        const file = path.join(agentsDir, name, "agent", "models.json");
        if (!fs.existsSync(file)) continue;
        try {
          const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
          const target = parsed?.providers && typeof parsed.providers === "object" ? parsed.providers : parsed;
          if (!target || typeof target !== "object" || !(oldKey in target)) continue;
          fs.copyFileSync(file, `${file}.bak`);
          if (!(newKey in target)) target[newKey] = target[oldKey];
          if (clearMirroredKey) delete target[newKey].apiKey;
          else if (target[newKey]?.apiKey) target[newKey].apiKey = renameProfileRef(target[newKey].apiKey, oldKey, newKey);
          delete target[oldKey];
          const tmp = `${file}.tmp-${process.pid}`;
          fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2), { mode: 0o600 });
          fs.renameSync(tmp, file);
        } catch (err) {
          console.error(`[openclaw] 分身注册表改名失败(${name}):`, err?.message || err);
      throw err;
      throw err;
        }
      }
    } catch (err) {
      console.error("[openclaw] 分身注册表枚举失败:", err?.message || err);
      throw err;
    }
  }

  /** runtime capability 缓存使用的版本 + URL + 连接代际身份。 */
  getModelRuntimeIdentity() {
    return {
      gatewayVersion: this._gatewayVersion || "",
      upstreamUrl: String(this._getUpstreamUrl?.() || ""),
      connectionGeneration: this._connectionGeneration,
    };
  }

  /** 当前生产 gateway 未声明模型 hot/restart 能力，allowlist 初始必须为 unknown。 */
  async getModelRuntimeApplyCapabilities() {
    return { mode: "unknown", verified: false };
  }

  /** 权威 tasks.list 探针保持原始 supported/truncation 字段，runtime controller 严格判定。 */
  async listModelRuntimeTasks({ limit = 201 } = {}) {
    await this._connect();
    return this.request("tasks.list", { limit }, 10000);
  }

  // OpenClaw's agents/models/sessions arrive through the passthrough proxy
  // (the real gateway answers those directly), so this backend injects nothing.
  ownsAgentId() { return false; }
  async ownsResourceId(kind, id) {
    const value = String(id || "");
    if (kind === "cron") return value.startsWith("openclaw:") && value.length > "openclaw:".length;
    if (kind !== "kanban") return false;
    const localId = value.startsWith("openclaw:") ? value.slice("openclaw:".length) : value;
    if (!localId) return false;
    try {
      const task = await this.getTask(localId);
      return task?.id === localId;
    } catch {
      return false;
    }
  }
  getAgents() { return []; }
  getModelChoices() { return []; }
  getSessionRows() { return []; }

  // ---- device-auth ----

  // 统一凭证解析(device-auth.createAuthResolver):config.token / operator 身份 /
  // loopback 本机网关 token / 已存设备令牌。每次连接现解析(三个小 JSON 读,成本
  // 可忽略),token 热更新即时生效,也避免旧版「失败缓存导致 backend 死到重启」问题。
  _loadAuth() {
    return this._authResolver.resolveConnectAuth((this._getUpstreamUrl() || "").trim() || DEFAULT_GATEWAY_URL);
  }

  // ---- connection / RPC ----

  _flushPending(err, socket = null) {
    for (const [id, entry] of this._pending) {
      // 旧 socket close 只终止它自己发出的 RPC，不能冲掉新连接的 pending。
      if (socket && entry.socket !== socket) continue;
      this._pending.delete(id);
      try { entry.reject(err); } catch { /* ignore */ }
    }
    for (const [id, entry] of this._finalObservers) {
      if (!socket || entry.socket === socket) this._closeFinalObserver(id);
    }
  }

  _closeFinalObserver(id, frame = null) {
    const entry = this._finalObservers.get(id);
    if (!entry) return;
    this._finalObservers.delete(id);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener("abort", entry.abort);
    try { if (frame) entry.onFinal(frame); else entry.onClose?.(); } catch { /* observer is isolated from RPC */ }
  }

  _observeFinalResponse(frame, socket) {
    const entry = this._finalObservers.get(frame.id);
    if (!entry || entry.socket !== socket) return;
    const payload = frame.payload;
    if (["accepted", "in_flight"].includes(payload?.status)) return;
    if (payload?.runId !== entry.runId
      || (payload.sessionKey !== undefined && payload.sessionKey !== entry.sessionKey)
      || (payload.agentId !== undefined && payload.agentId !== entry.agentId)
      || !["ok", "error", "timeout"].includes(payload.status)) {
      this._closeFinalObserver(frame.id);
      return;
    }
    this._closeFinalObserver(frame.id, frame);
  }

  /** Observe the final response of this exact agent RPC without delaying acceptance. */
  requestWithFinalObservation(method, params, observer, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (method !== "agent" || typeof params?.idempotencyKey !== "string"
      || typeof params?.sessionKey !== "string" || typeof observer?.onFinal !== "function") {
      return Promise.reject(new TypeError("openclaw: invalid final observer"));
    }
    return this.request(method, params, timeoutMs, observer);
  }

  /** Send an RPC request on the live socket. */
  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS, observer = null) {
    const ws = this._ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      try { observer?.onClose?.(); } catch { /* observer is isolated from RPC */ }
      return Promise.reject(new Error("openclaw: not connected"));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      if (observer?.signal?.aborted) { reject(new Error("openclaw: observation canceled")); return; }
      const timer = setTimeout(() => {
        if (this._pending.delete(id)) reject(new Error(`openclaw: ${method} timeout`));
      }, timeoutMs);
      this._pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
        socket: ws,
      });
      if (observer) {
        const entry = { ...observer, socket: ws, runId: params.idempotencyKey,
          sessionKey: params.sessionKey, agentId: params.agentId,
          abort: () => this._closeFinalObserver(id),
          timer: setTimeout(() => this._closeFinalObserver(id), 60 * 60 * 1000) };
        entry.timer.unref?.();
        this._finalObservers.set(id, entry);
        observer.signal?.addEventListener("abort", entry.abort, { once: true });
      }
      try { ws.send(JSON.stringify({ type: "req", id, method, params })); }
      catch (error) {
        this._pending.delete(id);
        clearTimeout(timer);
        this._closeFinalObserver(id);
        reject(error);
      }
    });
  }

  /** Ensure an authenticated connection; lazily (re)connects + handshakes. */
  _connect() {
    if (this._ready && this._ws && this._ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (this._connecting) return this._connecting;

    const attempt = Symbol("openclaw-connect");
    let resolveAttempt;
    let rejectAttempt;
    const connecting = new Promise((resolve, reject) => {
      resolveAttempt = resolve;
      rejectAttempt = reject;
    });
    this._connecting = connecting;
    this._connectingAttempt = attempt;

    // 只允许本次握手清理自己的单飞句柄，旧 socket 的迟到事件不碰新代际。
    const clearConnecting = () => {
      if (this._connectingAttempt !== attempt) return;
      this._connectingAttempt = null;
      this._connecting = null;
    };
    const auth = this._loadAuth();
    if (!auth) {
      clearConnecting();
      rejectAttempt(new Error("openclaw: device identity / operator token unavailable"));
      return connecting;
    }
    const url = (this._getUpstreamUrl() || "").trim() || DEFAULT_GATEWAY_URL;
    const origin = this._getOrigin() || DEFAULT_ORIGIN;

    let ws;
    try {
      ws = new WebSocket(url, origin ? { headers: { Origin: origin } } : undefined);
    } catch (err) {
      clearConnecting();
      rejectAttempt(err);
      return connecting;
    }
    this._ws = ws;

    let settled = false;
    let timer = null;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      clearConnecting();
      try { ws.close(); } catch { /* ignore */ }
      rejectAttempt(err);
    };
    const succeed = () => {
      if (settled) return;
      // 握手完成前连接已被替换时，本次结果已过期，不能把 _ready 写回 true。
      if (this._ws !== ws) {
        fail(new Error("openclaw: connection superseded"));
        return;
      }
      settled = true;
      if (timer) clearTimeout(timer);
      this._ready = true;
      clearConnecting();
      resolveAttempt();
    };
    timer = setTimeout(() => fail(new Error("openclaw: connect timeout")), CONNECT_TIMEOUT_MS);

    ws.on("message", (data) => {
      const frame = safeParse(data.toString());
      if (!frame) return;
      if (frame.type === "res") this._observeFinalResponse(frame, ws);
      // Resolve any pending RPC response (including the connect request).
      if (frame.type === "res" && this._pending.has(frame.id)) {
        const entry = this._pending.get(frame.id);
        if (entry.socket !== ws) return;
        this._pending.delete(frame.id);
        if (frame.ok) entry.resolve(frame.payload);
        else entry.reject(new Error(frame.error?.message || "gateway error"));
        return;
      }
      if (this._ws !== ws) return; // 旧 socket 的迟到 challenge 不得驱动新连接握手
      // Device-auth challenge → sign + send connect, then mark ready.
      if (frame.type === "event" && frame.event === "connect.challenge") {
        const nonce = frame.payload?.nonce;
        this._sendConnect(auth, nonce).then(succeed).catch((err) => {
          // 设备令牌陈旧(共享身份被别的客户端轮换)→ 清存储,下次连接自愈。
          if (classifyAuthError(err) === "device_token_stale") {
            try { this._authResolver.clearDeviceToken(url); } catch { /* 清不掉也不影响本次失败上抛 */ }
          }
          fail(err);
        });
        return;
      }
      // Other upstream events are irrelevant to the management RPC client.
    });
    ws.on("close", () => {
      const isCurrent = this._ws === ws;
      if (isCurrent) {
        this._ready = false;
        this._ws = null;
        this._gatewayHello = null;
      }
      this._flushPending(new Error("openclaw: connection closed"), ws);
      fail(new Error("openclaw: closed before handshake"));
    });
    ws.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
    return connecting;
  }

  async _sendConnect(auth, nonce) {
    if (!nonce) throw new Error("openclaw: connect challenge missing nonce");
    const params = buildConnectParams(auth, nonce);
    const hello = await this.request("connect", params, CONNECT_TIMEOUT_MS);
    this._acceptGatewayHello(hello);
    // 网关随 hello-ok 签发/轮换设备令牌 → 按 URL 持久化,下次连接凭它(token 轮换不断连)。
    const issued = hello?.auth?.deviceToken;
    if (typeof issued === "string" && issued) {
      try {
        this._authResolver.storeDeviceToken(issued, hello?.auth?.issuedAtMs, (this._getUpstreamUrl() || "").trim() || DEFAULT_GATEWAY_URL);
      } catch { /* 存储失败不影响本次连接 */ }
    }
    return hello;
  }

  // ---- cron (management UI) ----

  // Unified cron id is "openclaw:<localId>"; the gateway wants the bare localId.
  _localId(id) {
    const i = String(id || "").indexOf(":");
    return i >= 0 ? String(id).slice(i + 1) : String(id || "");
  }

  async getCronJobs() {
    try {
      await this._connect();
    } catch (err) {
      // Gateway not up / no identity → contribute no OpenClaw jobs (the merged
      // list still shows Hermes), mirroring Hermes' resilient empty behavior.
      console.error("[openclaw] cron.list skipped:", err?.message || err);
      return [];
    }
    try {
      for (let restart = 0; restart <= CRON_LIST_MAX_SNAPSHOT_RESTARTS; restart += 1) {
        try {
          const jobs = await this._listCronJobsSnapshot();
          return jobs.map(normalizeOpenClawCronJob);
        } catch (err) {
          if (err?.code !== "cron_snapshot_changed") throw err;
          if (restart === CRON_LIST_MAX_SNAPSHOT_RESTARTS) {
            throw new Error("openclaw: cron.list inventory changed repeatedly while paging");
          }
        }
      }
      throw new Error("openclaw: cron.list inventory changed repeatedly while paging");
    } catch (err) {
      console.error("[openclaw] cron.list failed:", err?.message || err);
      throw err;
    }
  }

  async _listCronJobsSnapshot() {
    let offset = 0;
    let snapshotRevision = null;
    let total = null;
    const jobs = [];
    const jobIds = new Set();

    for (let pageNumber = 0; pageNumber < CRON_LIST_MAX_PAGES; pageNumber += 1) {
      const page = await this.request("cron.list", {
        includeDisabled: true,
        limit: CRON_LIST_PAGE_SIZE,
        offset,
      });
      if (
        !page ||
        typeof page !== "object" ||
        !Array.isArray(page.jobs) ||
        page.jobs.length > CRON_LIST_PAGE_SIZE ||
        typeof page.snapshotRevision !== "string" ||
        page.snapshotRevision.length === 0 ||
        !Number.isSafeInteger(page.total) ||
        page.total < 0 ||
        !Number.isSafeInteger(page.offset) ||
        page.offset !== offset ||
        !Number.isSafeInteger(page.limit) ||
        page.limit < 1 ||
        page.limit > CRON_LIST_PAGE_SIZE ||
        page.jobs.length > page.limit ||
        typeof page.hasMore !== "boolean" ||
        (page.nextOffset !== null && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset < 0))
      ) {
        throw new Error("openclaw: cron.list returned an invalid inventory page");
      }

      if (snapshotRevision === null) {
        snapshotRevision = page.snapshotRevision;
        total = page.total;
      } else if (page.snapshotRevision !== snapshotRevision || page.total !== total) {
        const error = new Error("openclaw: cron.list snapshot changed while paging");
        error.code = "cron_snapshot_changed";
        throw error;
      }

      for (const job of page.jobs) {
        if (!job || typeof job.id !== "string" || job.id.length === 0) {
          throw new Error("openclaw: cron.list returned a job without a stable id");
        }
        if (jobIds.has(job.id)) {
          throw new Error(`openclaw: cron.list returned duplicate job id ${job.id}`);
        }
        jobIds.add(job.id);
        jobs.push(job);
      }

      const expectedNextOffset = offset + page.jobs.length;
      if (expectedNextOffset > page.total) {
        throw new Error("openclaw: cron.list returned an inconsistent inventory total");
      }
      if (!page.hasMore) {
        if (page.nextOffset !== null || expectedNextOffset !== page.total || jobs.length !== page.total) {
          throw new Error("openclaw: cron.list returned an inconsistent terminal inventory page");
        }
        return jobs;
      }
      if (
        page.nextOffset !== expectedNextOffset ||
        page.nextOffset <= offset ||
        page.nextOffset >= page.total
      ) {
        throw new Error("openclaw: cron.list pagination did not advance");
      }
      offset = page.nextOffset;
    }

    throw new Error("openclaw: cron.list pagination exceeded maximum pages");
  }

  // Map a unified patch (UI fields) → the gateway CronJobPatch shape.
  _buildCronPatch(patch) {
    const p = {};
    if (typeof patch?.name === "string") p.name = patch.name;
    if (typeof patch?.description === "string") p.description = patch.description;
    if (typeof patch?.enabled === "boolean") p.enabled = patch.enabled;
    if (patch?.schedule && patch.schedule.kind) p.schedule = patch.schedule;
    if (typeof patch?.deleteAfterRun === "boolean") p.deleteAfterRun = patch.deleteAfterRun;
    if (typeof patch?.sessionTarget === "string") p.sessionTarget = patch.sessionTarget;
    if (typeof patch?.wakeMode === "string") p.wakeMode = patch.wakeMode;
    if ("failureAlert" in (patch || {})) p.failureAlert = cronFailureAlertForGateway(patch.failureAlert);
    if (patch?.payload && patch.payload.kind) {
      p.payload = patch.payload;
    } else {
      const turn = {};
      if (typeof patch?.prompt === "string") turn.message = patch.prompt;
      if (typeof patch?.model === "string") turn.model = patch.model || undefined;
      if (Object.keys(turn).length) p.payload = { kind: "agentTurn", ...turn };
    }
    if (patch?.delivery && patch.delivery.mode) {
      p.delivery = patch.delivery;
    } else if (typeof patch?.deliver === "string") {
      p.delivery = { mode: patch.deliver };
    }
    return p;
  }

  async createCronJob(spec) {
    await this._connect();
    if (!spec?.schedule || !spec.schedule.kind) throw new Error("openclaw: cron 需要一个计划 (schedule)");
    const create = {
      name: spec.name || "",
      ...(spec.description ? { description: spec.description } : {}),
      schedule: spec.schedule,
      payload: spec.payload || {
        kind: "agentTurn",
        message: spec.prompt || "",
        ...(spec.model ? { model: spec.model } : {}),
      },
      enabled: spec.enabled !== false,
    };
    if (spec.agentId) create.agentId = spec.agentId;
    if (typeof spec.deleteAfterRun === "boolean") create.deleteAfterRun = spec.deleteAfterRun;
    if (spec.sessionTarget) create.sessionTarget = spec.sessionTarget;
    if (spec.wakeMode) create.wakeMode = spec.wakeMode;
    if ("failureAlert" in spec) create.failureAlert = cronFailureAlertForGateway(spec.failureAlert);
    create.delivery = spec.delivery || (
      spec.deliver && spec.deliver !== "none"
        ? { mode: spec.deliver, ...(spec.deliverChannel ? { channel: spec.deliverChannel } : {}) }
        : { mode: "none" }
    );
    const job = await this.request("cron.add", create);
    return normalizeOpenClawCronJob(job);
  }

  async updateCronJob(id, patch) {
    await this._connect();
    const jobId = this._localId(id);
    const job = await this.request("cron.update", { id: jobId, patch: this._buildCronPatch(patch) });
    return normalizeOpenClawCronJob(job);
  }

  async deleteCronJob(id) {
    await this._connect();
    await this.request("cron.remove", { id: this._localId(id) });
  }

  async runCronJob(id, _mode) {
    await this._connect();
    // cron.run responds with an enqueue result ({ ok, ran, ... }), not a job.
    return this.request("cron.run", { id: this._localId(id) });
  }

  async getCronRuns(id, options = {}) {
    try {
      await this._connect();
      const jobId = this._localId(id);
      const page = await this.request(
        "cron.runs",
        {
          id: jobId,
          scope: "job",
          limit: options.limit || 25,
          offset: options.offset || 0,
          sortDir: options.sortDir || "desc",
          ...(options.status ? { status: options.status } : {}),
          ...(options.deliveryStatus ? { deliveryStatus: options.deliveryStatus } : {}),
          ...(options.query ? { query: options.query } : {}),
        },
        12000,
      );
      const entries = Array.isArray(page?.entries) ? page.entries : [];
      return {
        runs: entries.map((e) => ({
          startedAt: typeof e.runAtMs === "number" ? e.runAtMs : typeof e.ts === "number" ? e.ts : null,
          finishedAt: typeof e.ts === "number" ? e.ts : null,
          status: e.status || undefined,
          completionStatus: e.completionStatus || undefined,
          error: e.error || undefined,
          errorReason: e.errorReason || undefined,
          summary: e.summary || undefined,
          durationMs: typeof e.durationMs === "number" ? e.durationMs : undefined,
          sessionKey: e.sessionKey || undefined,
          runId: e.runId || undefined,
          nextRunAt: typeof e.nextRunAtMs === "number" ? e.nextRunAtMs : undefined,
          deliveryStatus: e.deliveryStatus || undefined,
          deliveryError: e.deliveryError || undefined,
          deliverySuppressionReason: e.deliverySuppressionReason || undefined,
          failureNotificationDelivery: e.failureNotificationDelivery || undefined,
          diagnostics: e.diagnostics || undefined,
          model: e.model || undefined,
          provider: e.provider || undefined,
        })),
      };
    } catch (err) {
      console.error("[openclaw] cron.runs failed:", err?.message || err);
      return { runs: [] };
    }
  }

  // Cross-job recent runs (dashboard feed + 活动流当天回溯). `cron.runs`
  // scope:"all" 是全 job 聚合流（entry 自带 jobId+jobName）。gateway 每页上限
  // 200 且 RPC 无时间过滤参数 → 用 offset 逐页翻（entries 按 ts desc），翻到
  // 跨过 sinceMs 或攒够 limit 为止。返回 {runs, truncated?}：truncated=到
  // limit 时今天仍有更多行（KPI 全量口径由调用方给大 limit 消除截断）。
  async getRecentCronRuns({ sinceMs = 0, limit = 50 } = {}) {
    try {
      await this._connect();
    } catch (err) {
      console.error("[openclaw] cron.runs(all) skipped:", err?.message || err);
      return { runs: [], reason: "unavailable" };
    }
    const runs = [];
    let truncated = false;
    try {
      let offset = 0;
      pages: for (;;) {
        const page = await this.request(
          "cron.runs",
          { scope: "all", limit: 200, offset, sortDir: "desc" },
          12000,
        );
        const entries = Array.isArray(page?.entries) ? page.entries : [];
        for (const e of entries) {
          if (!e || !e.jobId) continue; // run-log entries always carry jobId; skip malformed rows
          // ts（运行结束时刻，必填）是 desc 排序键 → 跨过零点即可停止翻页；
          // 开始于昨天、结束于今天的运行仍属于今日完成数量。
          if (typeof e.ts === "number" && e.ts < sinceMs) break pages;
          const startedAt = typeof e.runAtMs === "number" ? e.runAtMs : typeof e.ts === "number" ? e.ts : null;
          if ((e.ts ?? startedAt ?? 0) < sinceMs) continue;
          if (runs.length >= limit) { truncated = true; break pages; }
          runs.push({
            backendId: "openclaw",
            jobId: `openclaw:${e.jobId}`,
            jobName: e.jobName || undefined,
            agentId: agentIdFromSessionKey(e.sessionKey),
            startedAt,
            finishedAt: typeof e.ts === "number" ? e.ts : null,
            status: e.status || undefined,
            completionStatus: e.completionStatus || undefined,
            error: e.error || undefined,
            errorReason: e.errorReason || undefined,
            summary: e.summary || undefined,
            durationMs: typeof e.durationMs === "number" ? e.durationMs : undefined,
            deliveryStatus: e.deliveryStatus || undefined,
            deliveryError: e.deliveryError || undefined,
            deliverySuppressionReason: e.deliverySuppressionReason || undefined,
            failureNotificationDelivery: e.failureNotificationDelivery || undefined,
            model: e.model || undefined,
            sessionKey: e.sessionKey || undefined,
            runId: e.runId || undefined,
          });
        }
        if (!page?.hasMore || entries.length === 0) break;
        offset = typeof page.nextOffset === "number" ? page.nextOffset : offset + entries.length;
        if (offset >= 10000) { truncated = !!page?.hasMore; break; } // 疯跑保险（5000 条上限由调用方 limit 承担）
      }
      return truncated ? { runs, truncated: true } : { runs };
    } catch (err) {
      console.error("[openclaw] cron.runs(all) failed:", err?.message || err);
      return { runs: [], reason: "unavailable" };
    }
  }

  // 看板活动源（统一动态流）：workboard.cards.list 本就返回全部卡（含已归档，
  // 无归档参数），每卡 events[] 上限 50 条；真实 kind 词表的映射器在
  // dashboard-activity.js（完成=moved→done、失败=attempt_updated+attempts
  // 命中 failed 等）。RPC 不可达/插件未启用 → unavailable 降级。
  async getRecentKanbanActivities({ sinceMs = 0 } = {}) {
    try {
      await this._connect();
      const res = await this.request("workboard.cards.list", {}, 12000);
      const cards = Array.isArray(res?.cards) ? res.cards : [];
      const items = [];
      for (const card of cards) {
        items.push(...workboardCardToActivities(card, { sinceMs, backendId: this.id }));
      }
      return { supported: true, items };
    } catch (err) {
      console.error("[openclaw] kanban activities unavailable:", err?.message || err);
      return { supported: false, reason: "unavailable", items: [] };
    }
  }

  async getCronLatestDelivery(id, atMs) {
    let run;
    try {
      if (typeof atMs === "number" && Number.isFinite(atMs)) {
        run = await this._findRunForOccurrence(id, atMs);
      } else {
        const { runs } = await this.getCronRuns(id, { limit: 1, sortDir: "desc" });
        run = runs[0];
      }
    } catch (err) {
      console.error("[openclaw] cron delivery runs failed:", err?.message || err);
    }
    if (!run) return { source: "none" };
    const base = {
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      model: run.model,
      provider: run.provider,
      durationMs: run.durationMs,
      summary: run.summary,
      sessionKey: run.sessionKey,
      error: run.error,
      deliveryStatus: run.deliveryStatus,
    };
    // The full untruncated output lives ONLY in the run's on-disk transcript —
    // the gateway's chat.history/sessions.get return nothing for cron run
    // sessions. Local gateway only: any failure (remote gateway, missing file,
    // parse error) silently degrades to the capped summary.
    const full = this._isLocalGateway() ? this._readCronTranscriptText(id, run.sessionKey) : "";
    if (full) return { ...base, fullText: full, source: "transcript" };
    return { ...base, fullText: null, source: run.summary ? "summary" : "none" };
  }

  // R342:单次 cron 运行的 Agent Trajectory——解析与 _readCronTranscriptText 同一份
  // per-run 本机转录(plain 格式;.trajectory.jsonl 是另一格式,不读)。行结构
  // (2026-07-28 实测):{type:"message", timestamp:ISO, message:{role, timestamp:ms,
  // content}};assistant.content 块 = thinking(文本在 .thinking)/text/toolCall
  // ({id,name,arguments});toolResult 是独立 role,自带 toolCallId+toolName。输出
  // 按行序 parts,ts 取消息级 ms 时间戳(缺了退线级 ISO)——UI 端可用 toolCall→
  // toolResult 的 ts 差推真实耗时。远程网关/无文件/空 → supported:false 静默降级。
  async getCronRunTrajectory(id, { sessionKey } = {}) {
    if (!this._isLocalGateway()) return { supported: false, reason: "remote", parts: [] };
    if (!sessionKey) return { supported: false, reason: "no-session", parts: [] };
    const file = this._cronRunTranscriptPath(id, sessionKey);
    if (!file) return { supported: false, reason: "invalid-session", parts: [] };
    let raw;
    try {
      raw = await fs.promises.readFile(file, "utf8");
    } catch {
      return { supported: false, reason: "no-transcript", parts: [] };
    }
    const CAP = 4000;
    const clip = (s) => (typeof s === "string" && s.length > CAP ? s.slice(0, CAP) : s);
    const parts = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const msg = o.message || o;
      const ts = typeof msg.timestamp === "number" ? msg.timestamp : Date.parse(o.timestamp || "") || undefined;
      const role = msg.role || o.role;
      if (role === "assistant" && Array.isArray(msg.content)) {
        for (const c of msg.content) {
          if (!c) continue;
          if (c.type === "thinking" && typeof c.thinking === "string" && c.thinking.trim()) {
            parts.push({ type: "thinking", text: clip(c.thinking), ts });
          } else if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
            parts.push({ type: "text", text: clip(c.text), ts });
          } else if (c.type === "toolCall") {
            parts.push({
              type: "toolCall",
              toolCallId: typeof c.id === "string" ? c.id : undefined,
              toolName: typeof c.name === "string" && c.name ? c.name : undefined,
              toolArgs: c.arguments && typeof c.arguments === "object" ? c.arguments : undefined,
              ts,
            });
          }
        }
      } else if (role === "toolResult") {
        let text = "";
        if (Array.isArray(msg.content)) {
          for (const c of msg.content) if (c?.type === "text" && typeof c.text === "string") text += (text ? "\n" : "") + c.text;
        } else if (typeof msg.content === "string") {
          text = msg.content;
        }
        parts.push({
          type: "toolResult",
          toolCallId: typeof msg.toolCallId === "string" ? msg.toolCallId : undefined,
          toolName: typeof msg.toolName === "string" && msg.toolName ? msg.toolName : undefined,
          text: clip(text),
          ...(msg.isError === true ? { isError: true } : {}),
          ts,
        });
      }
    }
    if (!parts.length) return { supported: false, reason: "empty", parts: [] };
    return { supported: true, parts };
  }

  // The run that fired for a clicked calendar occurrence: same local day as the
  // occurrence, startedAt closest to it. Runs come back newest-first, so page
  // back until the oldest fetched run predates the target day (every run that
  // day is then seen) — or a sane cap, after which we use the best match found.
  // No same-day run → undefined (the slot was predicted but never actually ran).
  async _findRunForOccurrence(id, atMs) {
    const dayStart = new Date(atMs);
    dayStart.setHours(0, 0, 0, 0);
    const dayStartMs = dayStart.getTime();
    const PAGE = 100;
    const MAX_PAGES = 6; // ≤600 runs scanned before falling back to best-so-far
    let best;
    let bestDelta = Infinity;
    for (let p = 0; p < MAX_PAGES; p += 1) {
      const { runs } = await this.getCronRuns(id, { limit: PAGE, offset: p * PAGE, sortDir: "desc" });
      if (!runs.length) return best;
      for (const r of runs) {
        const t = r.startedAt;
        if (typeof t !== "number" || !sameLocalDay(t, atMs)) continue;
        const delta = Math.abs(t - atMs);
        if (delta < bestDelta) {
          bestDelta = delta;
          best = r;
        }
      }
      const oldest = runs[runs.length - 1]?.startedAt;
      if (runs.length < PAGE || (typeof oldest === "number" && oldest < dayStartMs)) return best;
    }
    if (!best) {
      console.warn(`[openclaw] cron ${id}: no run within ${MAX_PAGES * PAGE} entries for occurrence ${new Date(atMs).toISOString()}`);
    }
    return best;
  }

  // The cron run's "delivered content" from its on-disk transcript. sessionKey
  // shape "agent:<agentId>:cron:<jobUuid>:run:<runUuid>" maps to
  // <home>/agents/<agentId>/sessions/<runUuid>.jsonl. Many agents DELIVER the
  // report via the `message` tool (arguments.message, action:"send") and then
  // end the turn with a short "task done" note — so the LAST assistant text is
  // that note, not the report. Prefer the longest outbound `message` payload
  // (the real report); fall back to the last non-empty assistant text. "" if
  // unreadable.
  // per-run 转录文件路径(sessionKey → 本机 .jsonl);形状不符返回 null。
  _cronRunTranscriptPath(id, sessionKey) {
    const m = /^agent:([^:]+):cron:([^:]+):run:([^:]+)$/.exec(String(sessionKey || ""));
    if (!m || m[2] !== this._localId(id)) return null;
    const safeSegment = (value) =>
      value !== "." && value !== ".." && !/[\\/\0\x00-\x1f\x7f]/.test(value);
    // job id 只参与与路由 id 的精确相等比较，不进入文件路径；它按既有契约可含
    // "/"。真正成为路径段的 run id 必须是单文件名，agent id 由 resolver 校验。
    if (!safeSegment(m[3])) return null;
    let sessionsDir;
    try {
      sessionsDir = resolveOpenClawSessionsDir(m[1]);
    } catch {
      return null;
    }
    const file = path.resolve(sessionsDir, `${m[3]}.jsonl`);
    const relative = path.relative(sessionsDir, file);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
      return null;
    }
    return file;
  }

  _readCronTranscriptText(id, sessionKey) {
    try {
      if (!this._isLocalGateway()) return "";
      const file = this._cronRunTranscriptPath(id, sessionKey);
      if (!file) return "";
      const raw = fs.readFileSync(file, "utf8");
      let lastText = ""; // last non-empty assistant text (fallback)
      let delivered = ""; // longest outbound `message`-tool payload (preferred)
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        const msg = o.message || o;
        if ((msg.role || o.role) !== "assistant") continue;
        const c = msg.content;
        if (typeof c === "string") {
          if (c.trim()) lastText = c;
        } else if (Array.isArray(c)) {
          let text = "";
          for (const p of c) {
            if (!p) continue;
            if (p.type === "text" && p.text) text += p.text;
            else if (p.type === "toolCall" && p.name === "message") {
              const sent = p.arguments?.message;
              if (typeof sent === "string" && sent.trim().length > delivered.length) delivered = sent;
            }
          }
          if (text.trim()) lastText = text;
        } else if (msg.text && String(msg.text).trim()) {
          lastText = String(msg.text);
        }
      }
      return delivered || lastText;
    } catch {
      return "";
    }
  }

  // ---- CLI usage (management UI: CLI page "agent 用过哪些" overlay) ----

  // Which host CLI commands have THIS machine's OpenClaw agents actually run?
  // The gateway's RPCs don't serve command-level history (local JSONL only,
  // same constraint as _readCronTranscriptText), so we read every agent's
  // on-disk session transcripts and tally the leading command of each
  // bash/exec toolCall's `arguments.command`. Remote gateway → not supported
  // (its transcripts live on another host).
  async getCliUsage() {
    if (!this._isLocalGateway()) return { supported: false, reason: "remote", commands: {} };
    // 冷启动从目录签名计算开始就单飞；否则首个扫描快速失败时，仍在 readdir 的
    // 第二个并发请求会绕过同一失败并悄悄发起另一轮扫描。
    if (!this._cliUsageCache) {
      if (this._cliUsageScanInFlight) return this._cliUsageScanInFlight;
      const tracked = this._getLocalCliUsage().finally(() => {
        if (this._cliUsageScanInFlight === tracked) this._cliUsageScanInFlight = null;
      });
      this._cliUsageScanInFlight = tracked;
      return tracked;
    }
    return this._getLocalCliUsage();
  }

  // 计算本机目录签名并按 cache/SWR 规则返回；冷启动的并发编排由 getCliUsage 负责。
  async _getLocalCliUsage() {
    const home = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
    const agentsDir = path.join(home, "agents");
    let entries;
    try {
      entries = await fs.promises.readdir(agentsDir);
    } catch {
      return { supported: true, commands: {} }; // no agents dir yet → empty, not an error
    }
    // Cheap cache signature: each agent's sessions-dir mtime (a new session file
    // bumps the dir mtime → instant invalidation). A 60s TTL backstops appends to
    // an existing session file (which need not bump the dir mtime). Mirrors
    // _breakdownCache. Reading every session file is ~10s+ and would block the
    // event loop on each /__api/cli/usage hit without this.
    const sigParts = [];
    for (const agentId of entries) {
      try {
        const st = await fs.promises.stat(path.join(agentsDir, agentId, "sessions"));
        sigParts.push(`${agentId}:${Math.round(st.mtimeMs)}`);
      } catch { /* no sessions dir for this agent */ }
    }
    const sig = sigParts.join("|");
    const cached = this._cliUsageCache;
    if (cached && cached.sig === sig && Date.now() - cached.at < 60_000) return cached.data;
    if (cached) {
      // R106 SWR：签名变/TTL 过期 → 先回旧数据（毫秒级），后台单飞重扫更新缓存
      // （setImmediate 让本次响应先写出去再扫）。下一个请求（前端 usePageCache
      // 的后台刷新）自然拿到新结果——除进程首扫外，任何请求都不再白等 10s+。
      if (!this._cliUsageScanInFlight) {
        this._cliUsageScanInFlight = new Promise((resolve) => setImmediate(resolve))
          .then(() => this._scanCliUsage(agentsDir, entries, sig))
          .catch((err) => console.error("[openclaw] cli usage rescan failed:", err?.message || err))
          .finally(() => { this._cliUsageScanInFlight = null; });
      }
      return cached.data;
    }
    return this._scanCliUsage(agentsDir, entries, sig); // 冷启动无旧数据，只能等待本轮扫描
  }

  async _scanCliUsage(agentsDir, entries, sig) {
    // Perf ceiling: scan at most this many newest de-duped sessions. With the
    // signature+TTL cache above, the full scan runs at most once per change, so a
    // cap above the live session count is a runaway guard, not a functional limit;
    // when it does fire, scanLimit surfaces it to the UI. NOTE: newest-mtime
    // ordering can under-report once truncation kicks in (recent sessions may be
    // heartbeat/cron runs with no commands) — smarter selection is the real fix
    // (spec §十二/§十五), deferred.
    const MAX_FILES = 12000;
    // Collect every session file with its agent + mtime, then dedupe by UUID
    // (the plain transcript is preferred over the trajectory for the same session —
    // see dedupeSessionFiles; R250 flipped this, "trajectory first" lost 91% of hits).
    // 退役转录（`.jsonl.reset.<ts>` / `.deleted.<ts>`）同样计入，规则与去重坑见
    // ARCHITECTURE §9 与 retiredSessionSyntheticName 的注释（R367）。
    const rawFiles = [];
    const realNameBy = new Map(); // `${agentId}\0${合成名}` -> 磁盘上的真实文件名
    for (const agentId of entries) {
      const sessDir = path.join(agentsDir, agentId, "sessions");
      let names;
      try { names = await fs.promises.readdir(sessDir); } catch { continue; }
      for (const name of names) {
        // 先按名字筛再 stat：目录里还堆着几千个 .trajectory-path.json / .bak
        const synthetic = name.endsWith(".jsonl") ? name : retiredSessionSyntheticName(name);
        if (!synthetic) continue;
        try {
          const st = await fs.promises.stat(path.join(sessDir, name));
          if (!st.isFile()) continue;
          rawFiles.push({ agentId, name: synthetic, mtime: st.mtimeMs });
          realNameBy.set(`${agentId}\0${synthetic}`, name);
        } catch { /* skip unreadable */ }
      }
    }
    const sessions = dedupeSessionFiles(rawFiles).sort((a, b) => b.mtime - a.mtime);
    const scanned = sessions.slice(0, MAX_FILES);
    const truncated = sessions.length - scanned.length;
    if (truncated > 0) {
      console.log(`[openclaw] getCliUsage: scanning newest ${MAX_FILES} of ${sessions.length} sessions (${truncated} older skipped)`);
    }
    const commands = {}; // commandName -> { agentId -> count }
    for (const s of scanned) {
      // s.name 可能是退役转录的合成名，读盘要换回真实文件名
      const realName = realNameBy.get(`${s.agentId}\0${s.name}`) || s.name;
      let raw;
      try { raw = await fs.promises.readFile(path.join(agentsDir, s.agentId, "sessions", realName), "utf8"); }
      catch { continue; }
      // A trajectory replays the whole conversation in every snapshot, so the same
      // call appears on many lines — count each tool-call id once. The plain
      // transcript appends one entry per call, so re-running a command genuinely
      // counts twice there and must NOT be de-duped.
      const seen = s.kind === "trajectory" ? new Set() : null;
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        for (const call of extractCliCommandsFromLine(o)) {
          if (seen) {
            const key = call.id || `cmd:${call.command}`; // id-less lines: fall back to the text
            if (seen.has(key)) continue;
            seen.add(key);
          }
          for (const name of parseCliCommandNames(call.command)) {
            const byAgent = commands[name] || (commands[name] = {});
            byAgent[s.agentId] = (byAgent[s.agentId] || 0) + 1;
          }
        }
      }
    }
    const data = { supported: true, commands, ...(truncated > 0 ? { scanLimit: MAX_FILES } : {}) };
    this._cliUsageCache = { sig, at: Date.now(), data };
    return data;
  }

  // Which SKILLS have this machine's OpenClaw agents actually loaded? Same
  // constraint and same cache/SWR shape as getCliUsage (local transcripts only),
  // but a different signal: OpenClaw skills are progressive-disclosure markdown,
  // so "used once" = one `read` toolCall on `<…>/skills/<dir>/SKILL.md`. The
  // skills CATALOG that rides along in every system prompt is NOT usage — which
  // is why this only ever looks at toolCall arguments, never at message text.
  async getSkillUsage() {
    if (!this._isLocalGateway()) return { supported: false, reason: "remote", skills: {} };
    if (!this._skillUsageCache) {
      if (this._skillUsageScanInFlight) return this._skillUsageScanInFlight;
      const tracked = this._getLocalSkillUsage().finally(() => {
        if (this._skillUsageScanInFlight === tracked) this._skillUsageScanInFlight = null;
      });
      this._skillUsageScanInFlight = tracked;
      return tracked;
    }
    return this._getLocalSkillUsage();
  }

  async _getLocalSkillUsage() {
    const home = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
    const agentsDir = path.join(home, "agents");
    let entries;
    try {
      entries = await fs.promises.readdir(agentsDir);
    } catch {
      return { supported: true, skills: {} };
    }
    const sigParts = [];
    for (const agentId of entries) {
      try {
        const st = await fs.promises.stat(path.join(agentsDir, agentId, "sessions"));
        sigParts.push(`${agentId}:${Math.round(st.mtimeMs)}`);
      } catch { /* no sessions dir for this agent */ }
    }
    const sig = sigParts.join("|");
    const cached = this._skillUsageCache;
    if (cached && cached.sig === sig && Date.now() - cached.at < 60_000) return cached.data;
    if (cached) {
      if (!this._skillUsageScanInFlight) {
        this._skillUsageScanInFlight = new Promise((resolve) => setImmediate(resolve))
          .then(() => this._scanSkillUsage(agentsDir, entries, sig))
          .catch((err) => console.error("[openclaw] skill usage rescan failed:", err?.message || err))
          .finally(() => { this._skillUsageScanInFlight = null; });
      }
      return cached.data;
    }
    return this._scanSkillUsage(agentsDir, entries, sig); // 进程首扫：只能等
  }

  async _scanSkillUsage(agentsDir, entries, sig) {
    // 比 _scanCliUsage 的 6000 高：这里多扫退役转录，而单文件成本又低一个量级
    // （命中 "SKILL.md" 的行才 JSON.parse）。
    const MAX_FILES = 12000;
    const rawFiles = [];
    const realNameBy = new Map(); // `${agentId}\0${合成名}` -> 磁盘上的真实文件名
    for (const agentId of entries) {
      const sessDir = path.join(agentsDir, agentId, "sessions");
      let names;
      try { names = await fs.promises.readdir(sessDir); } catch { continue; }
      for (const name of names) {
        // 先按名字筛再 stat：会话目录里还堆着几千个 .trajectory-path.json / .bak，
        // 对它们 stat 是纯浪费。
        const synthetic = name.endsWith(".jsonl") ? name : retiredSessionSyntheticName(name);
        if (!synthetic) continue;
        try {
          const st = await fs.promises.stat(path.join(sessDir, name));
          if (!st.isFile()) continue;
          rawFiles.push({ agentId, name: synthetic, mtime: st.mtimeMs });
          realNameBy.set(`${agentId}\0${synthetic}`, name);
        } catch { /* skip unreadable */ }
      }
    }
    const sessions = dedupeSessionFiles(rawFiles).sort((a, b) => b.mtime - a.mtime);
    const scanned = sessions.slice(0, MAX_FILES);
    const truncated = sessions.length - scanned.length;
    if (truncated > 0) {
      console.log(`[openclaw] getSkillUsage: scanning newest ${MAX_FILES} of ${sessions.length} sessions (${truncated} older skipped)`);
    }
    const hits = []; // { agentId, mdPath }; 名字解析推迟到扫完（去重后只读少量文件）
    for (const s of scanned) {
      // s.name 可能是退役转录的合成名，读盘要换回真实文件名
      const realName = realNameBy.get(`${s.agentId}\0${s.name}`) || s.name;
      let raw;
      try { raw = await fs.promises.readFile(path.join(agentsDir, s.agentId, "sessions", realName), "utf8"); }
      catch { continue; }
      // 只有含 "SKILL.md" 的行才值得 JSON.parse——技能加载是稀疏事件，这个前置
      // 字符串判定让本扫描比 _scanCliUsage（逐行解析）便宜一个量级。
      const seen = s.kind === "trajectory" ? new Set() : null; // trajectory 每快照重放全对话
      for (const line of raw.split("\n")) {
        if (!line.includes("SKILL.md")) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        for (const call of extractSkillLoadsFromLine(o)) {
          if (seen) {
            const key = call.id || `skill:${call.path}`;
            if (seen.has(key)) continue;
            seen.add(key);
          }
          hits.push({ agentId: s.agentId, mdPath: call.path });
        }
      }
    }
    const skills = {}; // skillName -> { agentId -> count }
    for (const h of hits) {
      const name = await this._resolveSkillName(h.mdPath);
      if (!name) continue;
      const byAgent = skills[name] || (skills[name] = {});
      byAgent[h.agentId] = (byAgent[h.agentId] || 0) + 1;
    }
    const data = { supported: true, skills, ...(truncated > 0 ? { scanLimit: MAX_FILES } : {}) };
    this._skillUsageCache = { sig, at: Date.now(), data };
    return data;
  }

  // transcript 给的是 SKILL.md 的路径，而 UI 要 join 的键是 getSkills() 的 name
  // （= gateway 的 skillKey，源头就是 SKILL.md frontmatter 的 `name:`）。目录名
  // 与 frontmatter name 在本机 548 个技能里有 11% 对不上（`binance-spot/` 的
  // name 是 `spot`），所以按路径读一次 frontmatter 才是权威；读不到（技能已删）
  // 才退回目录名。memo 常驻实例：一次扫描里不同 agent 命中同一技能很常见。
  async _resolveSkillName(mdPath) {
    const memo = this._skillNameByPath;
    if (memo.has(mdPath)) return memo.get(mdPath);
    const abs = mdPath.startsWith("~/") ? path.join(os.homedir(), mdPath.slice(2)) : mdPath;
    let name = path.basename(path.dirname(abs)) || null; // 兜底：目录名
    try {
      const head = (await fs.promises.readFile(abs, "utf8")).slice(0, 4096);
      const m = /^name:[ \t]*["']?([^"'\n]+?)["']?[ \t]*$/m.exec(head);
      if (m && m[1].trim()) name = m[1].trim();
    } catch { /* 技能已删/不可读 → 用目录名 */ }
    memo.set(mdPath, name);
    return name;
  }

  // ---- dashboard 总览 (running / approvals / artifacts) ----

  // Live work = the gateway's task ledger. `tasks.list {status:"running"}`
  // covers cron runs, agent turns and subagent tasks in one stream; response
  // shape { tasks: [...] } (tolerate items/bare-array variants — the shape
  // isn't pinned by our smoke).
  async getRunningWork() {
    try {
      await this._connect();
    } catch {
      return { supported: false, reason: "unavailable", items: [] };
    }
    try {
      const res = await this.request("tasks.list", { status: "running", limit: 50 }, 10000);
      const rows = Array.isArray(res?.tasks) ? res.tasks : Array.isArray(res?.items) ? res.items : Array.isArray(res) ? res : [];
      const items = rows
        .map((t) => ({
          id: String(t?.id || t?.taskId || ""),
          title: t?.title || undefined,
          kind: t?.kind || undefined,
          runtime: t?.runtime || undefined,
          status: t?.status || undefined,
          agentId: t?.agentId || agentIdFromSessionKey(t?.sessionKey),
          sessionKey: t?.sessionKey || undefined,
          runId: t?.runId || undefined,
          createdAt: typeof t?.createdAt === "number" ? t.createdAt : undefined,
          startedAt: typeof t?.startedAt === "number" ? t.startedAt : undefined,
          progressSummary: t?.progressSummary || undefined,
        }))
        .filter((t) => t.id);
      return { supported: true, items };
    } catch (err) {
      console.error("[openclaw] tasks.list failed:", err?.message || err);
      return { supported: false, reason: "error", items: [] };
    }
  }

  // Pending exec approvals. `exec.approval.list` returns a bare array of
  // { id, request, createdAtMs, expiresAtMs }; the display fields
  // (commandText/commandPreview/allowedDecisions) come from a per-id
  // `exec.approval.get`, which can race an expiry — a failed get keeps the
  // basics from the list row instead of dropping the item.
  async getPendingApprovals() {
    try {
      await this._connect();
    } catch {
      return { supported: false, reason: "unavailable", items: [] };
    }
    try {
      const res = await this.request("exec.approval.list", {}, 10000);
      const rows = Array.isArray(res) ? res : Array.isArray(res?.approvals) ? res.approvals : Array.isArray(res?.items) ? res.items : [];
      const items = [];
      for (const row of rows.slice(0, 20)) {
        const id = String((row && row.id) || (typeof row === "string" ? row : "") || "");
        if (!id) continue;
        const base = {
          id,
          agentId: row?.request?.agentId || undefined,
          commandText: typeof row?.request?.command === "string" ? row.request.command : undefined,
          createdAtMs: typeof row?.createdAtMs === "number" ? row.createdAtMs : undefined,
          expiresAtMs: typeof row?.expiresAtMs === "number" ? row.expiresAtMs : undefined,
        };
        try {
          const d = await this.request("exec.approval.get", { id }, 8000);
          items.push({
            ...base,
            commandText: d?.commandText || base.commandText,
            commandPreview: d?.commandPreview || undefined,
            allowedDecisions: Array.isArray(d?.allowedDecisions) ? d.allowedDecisions : undefined,
            agentId: d?.agentId || base.agentId,
            expiresAtMs: typeof d?.expiresAtMs === "number" ? d.expiresAtMs : base.expiresAtMs,
          });
        } catch {
          items.push(base); // expired/vanished mid-flight → keep the basics
        }
      }
      return { supported: true, items };
    } catch (err) {
      console.error("[openclaw] exec.approval.list failed:", err?.message || err);
      return { supported: false, reason: "error", items: [] };
    }
  }

  // Agent work products on the gateway host's disk: the shared workspace,
  // delivered media, each configured agent workspace. No gateway RPC serves
  // this — local FS only (remote gateway → "remote"), same constraint as
  // getCliUsage.
  async getRecentArtifacts({ limit = 20, sinceMs = 0 } = {}) {
    if (!this._isLocalGateway()) return { supported: false, reason: "remote", items: [] };
    const home = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
    const roots = await this._artifactRoots(home);
    if (!roots.length) return { supported: true, items: [] };
    // sinceMs（本地零点）在请求层过滤：缓存按 mtime desc 存 top-N，今天的文件
    // 必然是前缀，过滤不受缓存影响。
    const clamp = (data) => ({
      ...data,
      items: data.items.filter((x) => x.mtimeMs >= sinceMs).slice(0, Math.max(1, limit)),
    });
    // Cache signature: each root dir's mtime (a new file at a root bumps it);
    // the 60s TTL backstops changes inside subdirectories (which don't bump
    // the root mtime). Same SWR shape as _cliUsageCache (R106). The cache
    // holds the top-N scan independent of `limit`, so smoke (limit=5) and the
    // UI (default) share one entry.
    const sigParts = [];
    for (const root of roots) {
      try {
        const st = await fs.promises.stat(root.path);
        sigParts.push(`${root.path}:${Math.round(st.mtimeMs)}`);
      } catch { /* root vanished between listing and stat */ }
    }
    const sig = sigParts.join("|");
    const cached = this._artifactsCache;
    if (cached && cached.sig === sig && Date.now() - cached.at < 60_000) return clamp(cached.data);
    if (cached) {
      if (!this._artifactsScanInFlight) {
        this._artifactsScanInFlight = new Promise((resolve) => setImmediate(resolve))
          .then(() => this._scanArtifacts(roots, sig))
          .catch((err) => console.error("[openclaw] artifacts rescan failed:", err?.message || err))
          .finally(() => { this._artifactsScanInFlight = null; });
      }
      return clamp(cached.data);
    }
    return clamp(await this._scanArtifacts(roots, sig));
  }

  // Scan roots: <home>/workspace, <home>/media/outbound, plus every canonical
  // agents.entries.*.workspace from openclaw.json (config unreachable → the two
  // fixed roots). Roots are realpath'd + deduped; a non-directory root is
  // dropped. Symlinks are NOT followed past this point (lstat below), so the
  // scan can't be led outside the resolved roots — which also keeps every
  // returned path servable by /__media (realpath-confined to ~/.openclaw).
  async _artifactRoots(home) {
    const candidates = [
      { path: path.join(home, "workspace"), area: "workspace" },
      { path: path.join(home, "media", "outbound"), area: "media/outbound" },
    ];
    try {
      const { parsed } = await this._configSnapshot();
      const list = readCanonicalAgentEntries(parsed);
      for (const agent of list) {
        let ws = typeof agent?.workspace === "string" ? agent.workspace.trim() : "";
        if (ws.startsWith("~/")) ws = path.join(os.homedir(), ws.slice(2));
        const id = typeof agent?.id === "string" ? agent.id : "";
        if (ws && path.isAbsolute(ws)) {
          candidates.push({ path: ws, area: id ? `agents/${id}` : "agents", agentId: id || undefined });
        }
      }
    } catch { /* gateway/config unreachable → fixed roots only */ }
    return normalizeArtifactRoots(candidates);
  }

  async _scanArtifacts(roots, sig) {
    // 深度≤2、lstat 不追 symlink、2000 stat 上限的 walker 抽到 artifact-scan.js
    //（Hermes 共用）；OpenClaw 的黑名单/kind 词表原样传入，行为不变。
    const items = await walkArtifactRoots(roots, {
      maxStats: 2000, // hard runaway guard (workspaces can hold cloned repos)
      keep: 100, // cache the top-N by mtime; getRecentArtifacts slices per request
      excludeDirs: ARTIFACT_EXCLUDE_DIRS,
      excludeExts: ARTIFACT_EXCLUDE_EXTS,
      identityFiles: ARTIFACT_IDENTITY_FILES,
      kindForExt: artifactKind,
    });
    const data = { supported: true, items };
    this._artifactsCache = { sig, at: Date.now(), data };
    return data;
  }

  // Dashboard 缩略图预览重验证（契约见 agent-backend.js）：允许根与扫描同源，
  // realpath 包含 + 图片扩展 + 普通文件；远程网关一律拒绝。
  async resolveArtifactPreview(reqPath) {
    if (!this._isLocalGateway()) return null;
    const home = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
    const roots = await this._artifactRoots(home);
    return resolveArtifactPreviewPath(reqPath, roots, ARTIFACT_IMAGE_EXTS);
  }

  // ---- models (management UI) ----

  /**
   * 将 gateway `models.list` 原始行映射为公开运行时目录，供普通读取与 fresh 快照共用。
   * @param {*} raw
   * @returns {Array<object>}
   */
  _mapRuntimeModels(raw) {
    return (Array.isArray(raw) ? raw : []).map((m) => ({
      id: String(m?.id || ""),
      name: m?.name || m?.id || "",
      provider: m?.provider || "",
      backendId: "openclaw",
      contextWindow: typeof m?.contextWindow === "number" ? m.contextWindow : undefined,
      contextWindows: Array.isArray(m?.contextWindows) ? m.contextWindows : undefined,
      contextWindowDefault: typeof m?.contextWindowDefault === "string" ? m.contextWindowDefault : undefined,
      reasoning: m?.reasoning === true,
      thinkingLevels: Array.isArray(m?.thinkingLevels) ? m.thinkingLevels : undefined,
      thinkingDefault: typeof m?.thinkingDefault === "string" ? m.thinkingDefault : undefined,
      effectiveFastMode: m?.effectiveFastMode,
      supportsTools: typeof m?.supportsTools === "boolean" ? m.supportsTools : undefined,
      available: typeof m?.available === "boolean" ? m.available : undefined,
      unavailableReason: typeof m?.unavailableReason === "string" ? m.unavailableReason : undefined,
      unavailableUntil: typeof m?.unavailableUntil === "number" ? m.unavailableUntil : undefined,
      tags: Array.isArray(m?.tags) ? m.tags : undefined,
      alias: typeof m?.alias === "string" ? m.alias : undefined,
      agentRuntime: m?.agentRuntime && typeof m.agentRuntime === "object" ? m.agentRuntime : undefined,
      ...(typeof m?.maxTokens === "number" ? { maxTokens: m.maxTokens } : {}),
      ...(m?.pricing && typeof m.pricing === "object" ? { pricing: m.pricing } : {}),
      ...(typeof m?.acpProviderRef === "string" ? { acpProviderRef: m.acpProviderRef } : {}),
    }));
  }

  /**
   * 展平 config.get 的 Provider 模型真值，只保留 revision 所需公开字段。
   * @param {*} parsed
   * @returns {Array<object>}
   */
  _modelConfigRowsFromParsed(parsed) {
    const providers = parsed?.models?.providers;
    if (!providers || typeof providers !== "object") return [];
    const rows = [];
    for (const [provider, rawProvider] of Object.entries(providers)) {
      if (!rawProvider || typeof rawProvider !== "object") continue;
      // 端点/API mode 只进入不可逆 digest，不把 URL、userinfo 或凭证暴露给目录响应。
      const providerConfigDigest = createHash("sha256")
        .update(JSON.stringify({
          baseUrl: providerEndpointDigestInput(rawProvider.baseUrl || rawProvider.base_url),
          api: String(rawProvider.api || rawProvider.api_mode || ""),
        }))
        .digest("hex");
      for (const model of Array.isArray(rawProvider.models) ? rawProvider.models : []) {
        if (!model || !model.id) continue;
        rows.push({
          id: String(model.id),
          name: typeof model.name === "string" ? model.name : undefined,
          provider,
          backendId: "openclaw",
          contextWindow:
            typeof model.contextWindow === "number" ? model.contextWindow : undefined,
          maxTokens: typeof model.maxTokens === "number" ? model.maxTokens : undefined,
          reasoning: model.reasoning === true,
          providerConfigDigest,
        });
      }
      if (!Array.isArray(rawProvider.models) || rawProvider.models.length === 0) {
        rows.push({ id: "__provider_config__", provider, backendId: "openclaw", providerConfigDigest });
      }
    }
    return rows;
  }

  /**
   * 按配置 Provider 的模型真值过滤 gateway 残影，保持模型页既有语义。
   * @param {Array<object>} models
   * @param {*} parsed
   * @returns {Array<object>}
   */
  _mergeConfiguredModels(models, parsed) {
    const providers = parsed?.models?.providers;
    if (!providers || typeof providers !== "object") return models;
    const configured = new Map();
    for (const [key, provider] of Object.entries(providers)) {
      if (!provider || typeof provider !== "object") continue;
      const rows = (Array.isArray(provider.models) ? provider.models : [])
        .filter((model) => model?.id)
        .map((model) => ({
          id: String(model.id),
          name: typeof model.name === "string" ? model.name : String(model.id),
          provider: key,
          backendId: "openclaw",
          ...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
          ...(typeof model.maxTokens === "number" ? { maxTokens: model.maxTokens } : {}),
          reasoning: model.reasoning === true,
        }));
      // 配置真值显式声明 Provider 即拥有该身份空间；空 models 也必须屏蔽运行时残影。
      configured.set(key, rows);
    }
    const runtimeByIdentity = new Map(models.map((model) => [`${model.provider}\u0000${model.id}`, model]));
    const untouched = models.filter((model) => !configured.has(model.provider));
    const truth = [...configured.values()].flatMap((rows) => rows.map((row) => ({
      ...(runtimeByIdentity.get(`${row.provider}\u0000${row.id}`) || {}),
      ...row,
    })));
    return this._mergeAllowlistModels([...truth, ...untouched], parsed);
  }

  /**
   * allowlist 真值层(auth 型 provider,如 openrouter):可见性来自
   * agents.defaults.modelPolicy.allow；agents.defaults.models 只存 alias/settings。
   * 滞留、新 id 缺席,用户在残影卡片上继续操作必然 blocked。对「config 不管、
   * 本机有 api_key 凭证」的 provider,以 allowlist 键集为真值:滤掉不在列的
   * 目录行,补出目录还没有的键(裸行,重启后目录元数据接管)。
   */
  _mergeAllowlistModels(models, parsed) {
    const allow = readDefaultModelPolicyAllow(parsed);
    if (!Array.isArray(allow)) return models;
    let authProviders;
    try {
      authProviders = this._localAuthKeyProviders();
    } catch {
      return models;
    }
    if (!authProviders.size) return models;
    const configProviders = new Set(Object.keys(parsed?.models?.providers || {}));
    const allowByProvider = new Map();
    for (const ref of allow) {
      const slash = ref.indexOf("/");
      if (slash <= 0) continue;
      const provider = ref.slice(0, slash);
      if (configProviders.has(provider) || !authProviders.has(provider)) continue;
      if (!allowByProvider.has(provider)) allowByProvider.set(provider, new Set());
      allowByProvider.get(provider).add(ref.slice(slash + 1));
    }
    if (!allowByProvider.size) return models;
    const seen = new Set();
    const out = [];
    for (const m of models) {
      const ids = allowByProvider.get(m.provider);
      if (!ids) { out.push(m); continue; }
      if (ids.has(m.id)) {
        seen.add(`${m.provider}\u0000${m.id}`);
        out.push(m);
        continue;
      }
      // 目录行 id 可能自带 provider 前缀(如 openrouter 平台同名 org 的
      // "openrouter/owl-alpha"),对应 allowlist 键拆出的裸 id。保留元数据但把
      // 行 id 改写成裸 id——否则 UI 用带前缀 id 拼 allowlist 键会错位
      // (openrouter/openrouter/owl-alpha),删除/改名全 409(R188 真机教训)。
      const bare = m.id.startsWith(`${m.provider}/`) ? m.id.slice(m.provider.length + 1) : null;
      if (bare && ids.has(bare)) {
        seen.add(`${m.provider}\u0000${bare}`);
        out.push({ ...m, id: bare });
        continue;
      }
      // 残影(已删/已改名的旧 id)→ 滤除
    }
    for (const [provider, ids] of allowByProvider) {
      for (const id of ids) {
        if (seen.has(`${provider}\u0000${id}`)) continue;
        out.push({ id, name: id, provider, backendId: "openclaw", reasoning: false });
      }
    }
    return out;
  }

  async getModels() {
    try {
      await this._connect();
    } catch (err) {
      // Gateway down / no identity → contribute no OpenClaw models (the tab
      // shows empty), mirroring the resilient cron behavior.
      console.error("[openclaw] models.list skipped:", err?.message || err);
      return [];
    }
    try {
      const res = await this.request("models.list", {
        view: "all",
        includeProviderCapabilities: true,
      });
      // 8.1 models.list is the live catalog authority (availability, policy and
      // runtime metadata included). Do not overlay the old 7.1 config/allowlist
      // reconstruction, which can resurrect stale rows after a hot reload.
      return this._mapRuntimeModels(res?.models);
    } catch (err) {
      console.error("[openclaw] models.list failed:", err?.message || err);
      return [];
    }
  }

  /**
   * 强制读取配置真值和原始 gateway 目录；任一来源失败都显式报错且不降级旧缓存。
   * @param {{fresh?: boolean}} [options]
   * @returns {Promise<{models: Array<object>, config: Array<object>, runtime: Array<object>}>}
   */
  async getModelCatalogSources({ fresh = true } = {}) {
    // 当前 OpenClaw 来源没有热缓存；即使调用方传 fresh:false，也执行真实双读取。
    void fresh;
    let parsed;
    try {
      ({ parsed } = await this._configSnapshot());
    } catch (cause) {
      const error = new Error("openclaw: fresh model config unavailable", { cause });
      error.code = "ERR_MODEL_CATALOG_CONFIG";
      throw error;
    }

    let response;
    try {
      response = await this.request("models.list", {
        view: "all",
        includeProviderCapabilities: true,
        // This new RPC reads the gateway's current generation; config/auth
        // changes invalidate it upstream. refresh:true instead forces every
        // provider's network discovery even when that generation is current.
      }, MODEL_CATALOG_REFRESH_TIMEOUT_MS);
      if (!Array.isArray(response?.models)) throw new Error("models.list omitted its catalog");
    } catch (cause) {
      const error = new Error("openclaw: fresh runtime model catalog unavailable", { cause });
      error.code = "ERR_MODEL_CATALOG_RUNTIME";
      throw error;
    }
    const config = this._modelConfigRowsFromParsed(parsed);
    const runtime = this._mapRuntimeModels(response?.models);
    const models = runtime;
    return { models, config, runtime };
  }

  // OpenClaw has no single "active" model — each agent has a default. Expose the
  // per-agent defaults so the 模型 page can show which agents use each model.
  async getActiveModel() {
    try {
      await this._connect();
      const r = await this.request("agents.list", {}, 10000);
      const byScope = {};
      for (const a of Array.isArray(r?.agents) ? r.agents : []) {
        if (a?.id && a?.model?.primary) byScope[a.id] = a.model.primary;
      }
      return { byScope };
    } catch {
      return { byScope: {} };
    }
  }

  // ---- custom model config (management UI) ----
  // openclaw.json 的 models.providers 全部是用户自定义条目（内置目录不落配置），
  // 读走 config.get（parsed 已做密钥脱敏，只取结构），写走 config.patch——
  // RFC7386 merge-patch：对象深合并 / null 删键 / 数组整体替换；baseHash 乐观锁
  // 冲突自动重读重试一次；收缩既有数组必须在 replacePaths 里显式声明。
  // models 段在 gateway 的 reload 规则里是 hot，不触发重启。

  async _configSnapshot() {
    await this._connect();
    const res = await this.request("config.get", {}, 10000);
    const parsed = res && typeof res.parsed === "object" && res.parsed ? res.parsed : {};
    const hash = typeof res?.hash === "string" ? res.hash : "";
    if (!hash) throw new Error("openclaw: config.get 未返回 hash");
    return { parsed, hash };
  }

  async getModelConfig() {
    try {
      const { parsed } = await this._configSnapshot();
      const authKeyProviders = this._localAuthKeyProviders();
      const providers = parsed?.models?.providers && typeof parsed.models.providers === "object"
        ? parsed.models.providers
        : {};
      const rows = Object.entries(providers)
        .filter(([, p]) => p && typeof p === "object")
        .map(([key, p]) => ({
          key,
          baseUrl: typeof p.baseUrl === "string" ? p.baseUrl : "",
          api: typeof p.api === "string" ? p.api : undefined,
          // 密钥收敛后 key 常在 auth-profiles 而非 config;两处任一有即视为已配置
          hasApiKey: (p.apiKey != null && p.apiKey !== "") || authKeyProviders.has(key),
          // OpenClaw 的自定义 provider 端点+模型都在配置文件里，无 env 类
          source: "config",
          editable: true,
          models: (Array.isArray(p.models) ? p.models : [])
            .filter((m) => m && m.id)
            .map((m) => ({
              id: String(m.id),
              name: typeof m.name === "string" ? m.name : undefined,
              contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : undefined,
              maxTokens: typeof m.maxTokens === "number" ? m.maxTokens : undefined,
              reasoning: m.reasoning === true,
              // models.list 目录行的 id 就是条目裸 id（provider 是独立字段），
              // 页面用 `${provider}:${catalogId}` 复合键匹配卡片。
              catalogId: String(m.id),
            })),
        }));
      // 只有 api_key 授权、config 无条目的内置 provider(如 openrouter):端点由
      // 网关内置,key 在 auth-profiles——合成 source:"auth" 条目让它拿到「编辑端点」
      // 入口(换 Key/删除授权);端点字段展示注册表镜像值,没有则空=内置默认。
      const configKeys = new Set(rows.map((r) => r.key));
      let registryProviders = {};
      try {
        registryProviders = this._isLocalGateway() ? this._readRegistry().data.providers : {};
      } catch { /* 注册表读不到只影响端点展示 */ }
      for (const provider of authKeyProviders) {
        if (configKeys.has(provider)) continue;
        const reg = registryProviders[provider];
        rows.push({
          key: provider,
          baseUrl: reg && typeof reg.baseUrl === "string" ? reg.baseUrl : "",
          api: reg && typeof reg.api === "string" ? reg.api : undefined,
          hasApiKey: true,
          source: "auth",
          editable: true,
          models: [],
        });
      }
      this._modelConfigCache = { providers: rows };
      return this._modelConfigCache;
    } catch (err) {
      // gateway 瞬断/超时（典型：config.patch 触发热重载的窗口内紧跟 refresh）→
      // 回退上次成功快照而不是空，否则模型页的合成补卡/自定义标签/编辑入口会
      // 瞬间集体消失（同教训见 hermes-backend._readProvidersByProfile）。仅从未
      // 成功读过时才返回空。写路径（_patchModelProviders→_configSnapshot）不走
      // 此缓存：合并必须基于实时快照，陈旧快照会复活已删条目。
      console.error("[openclaw] getModelConfig skipped:", err?.message || err);
      return this._modelConfigCache || { providers: [] };
    }
  }

  // 读快照 → mutate(currentProviders, parsed) 算出 patch → config.patch；hash 冲突重试一次。
  // mutate 可选返回 patchAgentModels（modelPolicy.allow 的引用增删：{} 加入 / null 删除）——
  // 该段是模型可见性策略，增删模型必须与 provider 配置同一次 patch 原子完成。
  // 可选 patchModelRefs（_ghostRefCleanup 产出）：defaults/agents.entries 的 fallbacks 剔除，
  // 悬空引用留着会被网关 savior 自愈回滚复活已删 provider（R175 真机教训）。
  /**
   * 一组配置路径是否需要重启网关才生效。reloadKind 是网关版本级静态事实——
   * per-path 进程内缓存终身有效；查询失败保守返回「需要重启」（宁可多弹横幅，
   * 不可少提示导致用户以为已生效）。
   */
  async _pathsNeedRestart(paths) {
    this._reloadKindCache ||= new Map();
    for (const p of paths) {
      let kind = this._reloadKindCache.get(p);
      if (kind === undefined) {
        try {
          const r = await this.request("config.schema.lookup", { path: p }, 10000);
          kind = typeof r?.reloadKind === "string" ? r.reloadKind : "restart";
        } catch {
          return true; // 查不到不缓存，下次再试
        }
        this._reloadKindCache.set(p, kind);
      }
      if (kind !== "hot" && kind !== "none") return true;
    }
    return false;
  }

  async _patchModelProviders(mutate, { beforeWrite } = {}) {
    let lastErr;
    // config.patch 成功后网关热重载并自我回写配置,窗口内(可达几十秒)后续 patch
    // 的 baseHash 必然失配——立即重试大概率还在窗口里,带退避多试几轮;仍冲突则
    // 抛专属 code,UI 提示用户稍候重试(连续编辑多个模型是常规操作节奏)。
    const delaysMs = this._patchRetryDelaysMs || [0, 1500, 4000, 8000];
    let rateWaited = false;
    for (let attempt = 0; attempt < delaysMs.length; attempt++) {
      if (delaysMs[attempt] > 0) await new Promise((r) => setTimeout(r, delaysMs[attempt]));
      const { parsed, hash } = await this._configSnapshot();
      const current =
        parsed?.models?.providers && typeof parsed.models.providers === "object"
          ? parsed.models.providers
          : {};
      const mutation = mutate(current, parsed);
      // 幂等零写（如改名重试时旧键已搬走）：无 patch 发生 ⇒ 必然免重启
      if (mutation === null) return { restart: false, noop: true };
      const { patchProviders, replacePaths, patchAgentModels, patchModelRefs, patchAgentMetadata, patchExtra } = mutation;
      const effectiveReplacePaths = [...replacePaths, ...(patchAgentMetadata?.replacePaths || [])];
      const agentsPatch = {};
      if (patchAgentModels && Object.keys(patchAgentModels).length) {
        const allow = new Set(readDefaultModelPolicyAllow(parsed) || []);
        for (const [ref, value] of Object.entries(patchAgentModels)) {
          if (value === null) allow.delete(ref);
          else allow.add(ref);
        }
        agentsPatch.defaults = { modelPolicy: { allow: [...allow] } };
        effectiveReplacePaths.push("agents.defaults.modelPolicy.allow");
      }
      if (patchModelRefs?.defaultsFallbacks || patchModelRefs?.defaultsPrimary) {
        agentsPatch.defaults = {
          ...(agentsPatch.defaults || {}),
          model: {
            ...(patchModelRefs.defaultsPrimary ? { primary: patchModelRefs.defaultsPrimary } : {}),
            ...(patchModelRefs.defaultsFallbacks ? { fallbacks: patchModelRefs.defaultsFallbacks } : {}),
          },
        };
      }
      if (patchModelRefs?.entries) {
        agentsPatch.entries = Object.fromEntries(
          patchModelRefs.entries.map(({ id, ...entry }) => [id, entry]),
        );
      }
      if (patchAgentMetadata?.defaultsModels) {
        agentsPatch.defaults = {
          ...(agentsPatch.defaults || {}),
          models: patchAgentMetadata.defaultsModels,
        };
      }
      if (patchAgentMetadata?.entries) {
        agentsPatch.entries = agentsPatch.entries || {};
        for (const [id, entryPatch] of Object.entries(patchAgentMetadata.entries)) {
          agentsPatch.entries[id] = {
            ...(agentsPatch.entries[id] || {}),
            ...entryPatch,
          };
        }
      }
      try {
        await beforeWrite?.();
        await this.request(
          "config.patch",
          {
            raw: JSON.stringify({
              ...patchExtra,
              models: { providers: patchProviders },
              ...(Object.keys(agentsPatch).length ? { agents: agentsPatch } : {}),
            }),
            baseHash: hash,
            ...(effectiveReplacePaths.length
              ? { replacePaths: [...new Set(effectiveReplacePaths)] }
              : {}),
          },
          15000,
        );
        // 本次写触达的顶层配置路径 → 网关 reload 规则判定是否需要重启生效。
        // 实测（2026.7.1-2）patch 响应不带 restart 字段，权威来源是
        // config.schema.lookup 的 reloadKind（models.providers/agents.* 皆 hot）。
        const touched = ["models.providers"];
        if (agentsPatch.defaults?.modelPolicy) touched.push("agents.defaults.modelPolicy");
        if (agentsPatch.defaults?.model) touched.push("agents.defaults.model");
        if (agentsPatch.defaults?.models) touched.push("agents.defaults.models");
        if (agentsPatch.entries) touched.push("agents.entries");
        return { restart: await this._pathsNeedRestart(touched) };
      } catch (err) {
        lastErr = err;
        const msg = String(err?.message || err);
        if (msg === "config.patch persisted and updated the active Gateway, but a recovery restart is required; wait for the Gateway to restart, then run config.get to confirm the active revision") {
          // This exact 9.1 receipt acknowledges the write, but not final readiness.
          // Expose fixed metadata only; the coordinator still requires exact readback.
          const error = new Error("Gateway configuration requires recovery confirmation and restart");
          error.code = "config_restart_pending";
          error.stage = "config-write";
          error.configPersisted = true;
          error.restartRequired = true;
          throw error;
        }
        if (/changed since last load/i.test(msg)) continue; // hash 冲突 → 退避重试
        // 网关对 config.patch 有显式限流(500 "rate limit exceeded … retry after Ns"):
        // 按提示等待一次再试(封顶 45s;只等一次,免得请求无限挂着)。
        const rate = /rate limit exceeded.*retry after\s*(\d+)/i.exec(msg);
        if (rate && !rateWaited) {
          rateWaited = true;
          await new Promise((r) => setTimeout(r, Math.min((Number(rate[1]) + 1) * 1000, 45000)));
          attempt -= 1; // 限流等待不消耗重试轮次(只会发生一次)
          continue;
        }
        if (rate) break; // 等待后仍限流 → 走专属 code
        throw err;
      }
    }
    // 退避后仍冲突/限流:抛专属 code,UI 给「网关正忙,稍候重试」的可行动提示
    const error = new Error("网关正在应用上一次配置变更(热重载/写入限流),本次写入未成功,请稍候重试");
    error.code = "config_write_conflict";
    throw error;
  }

  // ---- LAN 发现开关(S3):plugins.allow 里的 bonjour ----
  // 官方 bonjour 扩展 darwin 默认启用;仅当用户配置了 plugins.allow 白名单时才由
  // 本开关管理(加/移 "bonjour")。无白名单时绝不创建——白名单会禁用所有未列插件。

  async getLanDiscovery() {
    try {
      const { parsed } = await this._configSnapshot();
      const allow = parsed?.plugins?.allow;
      if (!Array.isArray(allow)) return { supported: true, enabled: true, managed: false };
      return { supported: true, enabled: allow.includes("bonjour"), managed: true };
    } catch (err) {
      return { supported: false, error: err?.message || String(err) };
    }
  }

  async setLanDiscovery(enabled) {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { parsed, hash } = await this._configSnapshot();
      const allow = parsed?.plugins?.allow;
      if (!Array.isArray(allow)) throw new Error("openclaw: 无 plugins.allow 白名单,bonjour 默认已启用");
      const has = allow.includes("bonjour");
      if (has === !!enabled) return { enabled: has, requiresRestart: false };
      const next = enabled ? [...allow, "bonjour"] : allow.filter((p) => p !== "bonjour");
      try {
        await this.request(
          "config.patch",
          { raw: JSON.stringify({ plugins: { allow: next } }), baseHash: hash, replacePaths: ["plugins.allow"] },
          20000,
        );
        return { enabled: !!enabled, requiresRestart: true }; // 插件 onStartup 激活,重启生效
      } catch (err) {
        lastErr = err;
        if (!/changed since last load/i.test(String(err?.message || err))) throw err;
      }
    }
    throw lastErr;
  }

  /** legacy 模型写入口统一拒绝，防止脚本绕过 coordinator/journal。 */
  _rejectLegacyModelChangeWrite() {
    const error = new Error("模型变更必须由 ModelChangeCoordinator 执行");
    error.code = "model_change_coordinator_required";
    error.status = 409;
    throw error;
  }

  /** 兼容保留方法名，但禁止直接新增/覆盖模型。 */
  async addModelConfig() {
    return this._rejectLegacyModelChangeWrite();
  }

  /** 兼容保留方法名，但禁止直接删除 Provider。 */
  async removeModelProvider() {
    return this._rejectLegacyModelChangeWrite();
  }

  /** 兼容保留方法名，但禁止直接删除模型。 */
  async removeModelConfig() {
    return this._rejectLegacyModelChangeWrite();
  }

  /** 兼容保留方法名，但禁止直接更新 Provider。 */
  async updateModelProvider() {
    return this._rejectLegacyModelChangeWrite();
  }

  // config.get 无条件脱敏（apiKey 回来是 __OPENCLAW_REDACTED__），明文只在磁盘上。
  // 远程 gateway 时本机文件不是它的配置，明确降级而不是给出错的 key。
  async revealModelProviderKey(providerKey) {
    const key = String(providerKey || "").trim();
    if (!key) throw new Error("缺少 providerKey");
    if (!this._isLocalGateway()) return { apiKey: null, reason: "remote" };
    const home = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(path.join(home, "openclaw.json"), "utf8"));
    } catch {
      return { apiKey: null, reason: "remote" };
    }
    const entry = cfg?.models?.providers?.[key];
    const raw = entry && typeof entry === "object" ? entry.apiKey : undefined;
    // secret ref（{source:"env", id:"FOO"}）→ 明文在环境变量里，不落配置
    if (raw && typeof raw === "object" && raw.source === "env" && raw.id) {
      return { apiKey: null, reason: "env", envVar: String(raw.id) };
    }
    if (this._usesCanonicalModelAuthCli()) {
      // Renaming creates canonical profiles through the CLI; legacy JSON may
      // still contain the old ID/key. Discovery and explicit reveal must read
      // the same authoritative store as inference.
      if (!raw || (typeof raw === "string" && raw.includes(":"))) {
        const rows = await this._loadProviderRenameAuth(key, undefined, [this._modelAuthAgentId()]);
        const id = raw ? String(raw).replace(/^profile:/, "") : `${key}:default`;
        const profile = rows.find(row => row.id === id && row.agent === this._modelAuthAgentId())
          || rows.find(row => row.id === id);
        if (profile?.type === "api_key" && typeof profile.key === "string" && profile.key.trim()) return { apiKey: profile.key };
        if (!raw) return { apiKey: null, reason: "none" };
      }
      return typeof raw === "string" && raw.trim() ? { apiKey: raw } : { apiKey: null, reason: "none" };
    }
    if (typeof raw === "string" && raw.trim()) return { apiKey: raw };
    // 密钥收敛(R178)后 key 在 auth-profiles 而非 config——config 查不到再查 profile
    try {
      const { data } = this._readAuthProfiles();
      const profile = data.profiles?.[`${key}:default`];
      if (profile?.type === "api_key" && typeof profile.key === "string" && profile.key.trim()) {
        return { apiKey: profile.key };
      }
    } catch { /* 授权文件读不到按未配置处理 */ }
    return { apiKey: null, reason: "none" };
  }

  // ---- token usage (management UI) ----

  // usage.cost / sessions.usage 的 totals 形状相同（spec §1），统一映射成契约
  // camelCase；缺字段的老网关得到 0，不炸。
  _mapCostTotals(t) {
    return {
      totalTokens: Number(t?.totalTokens) || 0,
      totalCost: Number(t?.totalCost) || 0,
      inputTokens: Number(t?.input) || 0,
      outputTokens: Number(t?.output) || 0,
      cacheReadTokens: Number(t?.cacheRead) || 0,
      cacheWriteTokens: Number(t?.cacheWrite) || 0,
      inputCost: Number(t?.inputCost) || 0,
      outputCost: Number(t?.outputCost) || 0,
      cacheReadCost: Number(t?.cacheReadCost) || 0,
      cacheWriteCost: Number(t?.cacheWriteCost) || 0,
      missingCostEntries: Number(t?.missingCostEntries) || 0,
    };
  }

  // range → gateway usage 参数。一律带 mode:"gateway"，让网关按自己所在时区（=本机=
  // 用户本地日）分组 daily。否则默认 UTC 分组会把本地"今天"错配到 UTC 桶——按本地日期
  // 从 daily 里 find（Dashboard 今日/昨日 token、折线）会严重少算（见 PROGRESS R150）。
  // "today" 用 startDate/endDate 精确到当天自然日；其余走 gateway 原生 range 枚举
  // （7d/30d/90d/1y/all）。usage.cost 与 sessions.usage 服务端共用同一套 resolveDateRange。
  _usageRangeParams(range) {
    if (range === "today") {
      const now = new Date();
      const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      return { startDate: day, endDate: day, mode: "gateway", agentScope: "all" };
    }
    return { range, mode: "gateway", agentScope: "all" };
  }

  // 从 daily 汇总出 totals（动态累加除 date 外的所有数值字段：tokens/cost/各分项）。
  _sumDailyTotals(daily) {
    const out = { totalTokens: 0, totalCost: 0 };
    for (const d of daily) {
      for (const [k, v] of Object.entries(d)) {
        if (k === "date" || typeof v !== "number") continue;
        out[k] = (out[k] || 0) + v;
      }
    }
    return out;
  }

  // R173：本地 gateway 时 token 统计不再走 usage.cost/sessions.usage RPC——网关按
  // sessions.json 索引统计，索引与落盘错位（幽灵条目/孤儿 transcript）会丢真实计数，
  // trajectory-only 会话也不在其内。改为直接扫本地 session 文件（usage-file-scan.js，
  // 口径「落盘即算」，series/breakdown 出自同一份立方体）。远程 gateway 无本地文件，
  // 保留原 RPC 路径；本地扫描意外失败也回退 RPC（比空数据强）。
  async getUsageSeries(range = "1y") {
    if (this._isLocalGateway()) {
      try {
        const cube = await this._getUsageCube();
        if (cube?.scannedFiles > 0) return cubeToSeries(cube, range, Date.now());
      } catch (err) {
        console.error("[openclaw] usage file scan failed, falling back to RPC:", err?.message || err);
      }
    }
    return this._gatewayUsageSeries(range);
  }

  // 与 _getLocalCliUsage 同款 SWR：目录签名 + 60s TTL；过期先回旧立方体、后台单飞
  // 重扫；冷启动并发共享同一次扫描。立方体含全历史，所有 range/两个接口共用一份。
  async _getUsageCube() {
    const home = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
    const agentsDir = path.join(home, "agents");
    let entries;
    try {
      entries = await fs.promises.readdir(agentsDir);
    } catch {
      return null; // 无 agents 目录（尚未初始化）→ 让调用方走 RPC 兜底
    }
    const sigParts = [];
    for (const agentId of entries) {
      try {
        const st = await fs.promises.stat(path.join(agentsDir, agentId, "sessions"));
        sigParts.push(`${agentId}:${Math.round(st.mtimeMs)}`);
      } catch { /* 该 agent 无 sessions 目录 */ }
    }
    const sig = sigParts.join("|");
    const cached = this._usageCubeCache;
    if (cached && cached.sig === sig && Date.now() - cached.at < 60_000) return cached.cube;
    if (cached) {
      if (!this._usageCubeScanInFlight) {
        this._usageCubeScanInFlight = new Promise((resolve) => setImmediate(resolve))
          .then(() => scanUsageCube({ agentsDir }))
          .then((cube) => { this._usageCubeCache = { sig, at: Date.now(), cube }; })
          .catch((err) => console.error("[openclaw] usage cube rescan failed:", err?.message || err))
          .finally(() => { this._usageCubeScanInFlight = null; });
      }
      return cached.cube;
    }
    if (this._usageCubeScanInFlight) return this._usageCubeScanInFlight;
    const tracked = scanUsageCube({ agentsDir })
      .then((cube) => {
        this._usageCubeCache = { sig, at: Date.now(), cube };
        return cube;
      })
      .finally(() => {
        if (this._usageCubeScanInFlight === tracked) this._usageCubeScanInFlight = null;
      });
    this._usageCubeScanInFlight = tracked;
    return tracked;
  }

  async _gatewayUsageSeries(range) {
    try {
      await this._connect();
    } catch (err) {
      console.error("[openclaw] usage.cost skipped:", err?.message || err);
      return { daily: [], totals: { totalTokens: 0, totalCost: 0 }, availability: "unavailable" };
    }
    try {
      const cost = await this.request("usage.cost", this._usageRangeParams(range), 20000);
      const daily = Array.isArray(cost?.daily)
        ? cost.daily.map((d) => ({ date: String(d.date), ...this._mapCostTotals(d) }))
        : [];
      // 网关对单日查询(startDate=endDate，"today" 即是)会返回带数据的 daily 但顶层
      // totals 为空零；此时从 daily 汇总兜底，保证 KPI 与趋势图/排行同口径
      // （与 Hermes getUsageSeries 由 daily 汇总 totals 的做法一致）。
      let totals = this._mapCostTotals(cost?.totals);
      if (!totals.totalTokens && daily.length) totals = this._sumDailyTotals(daily);
      return {
        daily,
        totals,
        cacheStatus: cost?.cacheStatus?.status,
      };
    } catch (err) {
      console.error("[openclaw] usage.cost failed:", err?.message || err);
      return { daily: [], totals: { totalTokens: 0, totalCost: 0 }, availability: "unavailable" };
    }
  }

  async getUsageBreakdown(range = "7d") {
    // R173：本地 gateway 走文件扫描立方体（与 getUsageSeries 同一份，口径必然一致；
    // latency/dailyLatency 本地文件没有可靠数据，缺省——UI 对缺失区块本就隐藏，
    // 与网关冷扫描时的行为一致）。远程/扫描失败回退下方 gateway SWR 路径。
    if (this._isLocalGateway()) {
      try {
        const cube = await this._getUsageCube();
        if (cube?.scannedFiles > 0) return cubeToBreakdown(cube, range, Date.now());
      } catch (err) {
        console.error("[openclaw] usage file scan failed, falling back to RPC:", err?.message || err);
      }
    }
    // sessions.usage cold-scans every session in range and is slow + variable
    // (~10s at limit 100, tens of seconds higher), so cache the normalized result
    // briefly — tab-switches / revisits are then instant rather than re-scanning.
    const cached = this._breakdownCache.get(range);
    if (cached && Date.now() - cached.at < 60_000) return cached.data;
    if (cached) {
      // R106 SWR：TTL 过期 → 先回旧数据（毫秒级），后台单飞重拉该 range 更新
      // 缓存；下一个请求（前端 UsagePage 的后台刷新）自然拿到新结果。refreshing
      // （网关冷扫全零快照）在 _fetchUsageBreakdown 里本就不写缓存，行为不变。
      if (!this._breakdownInFlight.has(range)) {
        this._breakdownInFlight.set(
          range,
          new Promise((resolve) => setImmediate(resolve))
            .then(() => this._fetchUsageBreakdown(range))
            .catch((err) => console.error("[openclaw] breakdown rescan failed:", err?.message || err))
            .finally(() => this._breakdownInFlight.delete(range)),
        );
      }
      return cached.data;
    }
    return this._fetchUsageBreakdown(range); // 进程首拉：无旧数据可回，只能等
  }

  async _fetchUsageBreakdown(range) {
    try {
      await this._connect();
    } catch (err) {
      console.error("[openclaw] sessions.usage skipped:", err?.message || err);
      return { byModel: [], byAgent: [], totals: { totalTokens: 0, totalCost: 0 } };
    }
    try {
      // limit 100 ≈ 10s and still captures the dominant models (the UI shows the
      // top 12); higher limits balloon to 30-60s for marginal long-tail accuracy.
      const sess = await this.request("sessions.usage", { ...this._usageRangeParams(range), limit: 100 }, 45000);
      const agg = sess?.aggregates || {};
      // 网关聚合按「成本降序」排（计费口径）；模型多未配价时全零成本会把少数
      // 有价模型顶到最前，token 排名看着是乱的。这里统一规整成 token 降序，
      // 与 UI「占比排名」语义和 Hermes 后端的排序行为对齐。
      const byTokensDesc = (a, b) => b.totalTokens - a.totalTokens;
      const byModel = (Array.isArray(agg.byModel) ? agg.byModel : [])
        .map((m) => ({
          model: m.model || "unknown",
          provider: m.provider || undefined,
          count: Number(m.count) || 0,
          ...this._mapCostTotals(m.totals),
        }))
        .sort(byTokensDesc);
      const byAgent = (Array.isArray(agg.byAgent) ? agg.byAgent : [])
        .map((a) => ({
          agentId: a.agentId || "unknown",
          ...this._mapCostTotals(a.totals),
        }))
        .sort(byTokensDesc);
      // OpenClaw 的来源就是 agent；保留 byAgent，同时派生通用 bySource 给 dashboard 使用。
      const bySource = byAgent.map((a) => ({
        ...a,
        id: a.agentId,
        label: a.agentId,
        kind: "agent",
        backendId: "openclaw",
      }));
      const byChannel = (Array.isArray(agg.byChannel) ? agg.byChannel : [])
        .map((c) => ({
          channel: c.channel || "unknown",
          ...this._mapCostTotals(c.totals),
        }))
        .sort(byTokensDesc);
      const tools = {
        totalCalls: Number(agg.tools?.totalCalls) || 0,
        uniqueTools: Number(agg.tools?.uniqueTools) || 0,
        tools: (Array.isArray(agg.tools?.tools) ? agg.tools.tools : []).map((x) => ({
          name: String(x.name || ""),
          count: Number(x.count) || 0,
        })),
      };
      // 顶层 latency 网关可能不给（冷扫描）；实测 warm 时与 dailyLatency 同在，
      // 缺就缺（区块隐藏），不做加权回算（YAGNI，偏离 spec §3 的"可由"一句）。
      const latency = agg.latency
        ? {
            count: Number(agg.latency.count) || 0,
            avgMs: Number(agg.latency.avgMs) || 0,
            minMs: Number(agg.latency.minMs) || 0,
            maxMs: Number(agg.latency.maxMs) || 0,
            p95Ms: Number(agg.latency.p95Ms) || 0,
          }
        : undefined;
      const dailyLatency = (Array.isArray(agg.dailyLatency) ? agg.dailyLatency : []).map((d) => ({
        date: String(d.date),
        count: Number(d.count) || 0,
        avgMs: Number(d.avgMs) || 0,
        p95Ms: Number(d.p95Ms) || 0,
      }));
      const modelDaily = (Array.isArray(agg.modelDaily) ? agg.modelDaily : []).map((m) => ({
        date: String(m.date),
        model: m.model || "unknown",
        provider: m.provider || undefined,
        tokens: Number(m.tokens) || 0,
        cost: Number(m.cost) || 0,
      }));
      const dailyActivity = (Array.isArray(agg.daily) ? agg.daily : []).map((d) => ({
        date: String(d.date),
        messages: Number(d.messages) || 0,
        toolCalls: Number(d.toolCalls) || 0,
        errors: Number(d.errors) || 0,
        tokens: Number(d.tokens) || 0,
        cost: Number(d.cost) || 0,
      }));
      const messages = agg.messages
        ? {
            total: Number(agg.messages.total) || 0,
            user: Number(agg.messages.user) || 0,
            assistant: Number(agg.messages.assistant) || 0,
            toolCalls: Number(agg.messages.toolCalls) || 0,
            errors: Number(agg.messages.errors) || 0,
          }
        : undefined;
      // sessions[].usage 刚扫描时可为 null；零 token 行不进 Top。
      const topSessions = (Array.isArray(sess?.sessions) ? sess.sessions : [])
        .filter((s) => s && s.usage && (Number(s.usage.totalTokens) || 0) > 0)
        .map((s) => ({
          key: String(s.key || ""),
          label: s.label || undefined,
          agentId: s.agentId || undefined,
          channel: s.channel || undefined,
          model: s.modelOverride || s.model || undefined,
          totalTokens: Number(s.usage.totalTokens) || 0,
          totalCost: Number(s.usage.totalCost) || 0,
          updatedAt: Number(s.updatedAt) || undefined,
        }))
        .sort((a, b) => b.totalTokens - a.totalTokens)
        .slice(0, 20);
      const totals = this._mapCostTotals(sess?.totals);
      const data = {
        byModel,
        byAgent,
        bySource,
        byChannel,
        tools,
        latency,
        dailyLatency,
        modelDaily,
        dailyActivity,
        messages,
        topSessions,
        totals,
        missingCostEntries: totals.missingCostEntries,
        cacheStatus: sess?.cacheStatus?.status,
        sourceKind: "agent",
        scanLimit: 100,
      };
      // 冷扫描(refreshing)的结果是全零快照——不写 60s 缓存，否则 UI 自动重拉
      // 只会命中我们自己的陈旧缓存（spec §1.2）。
      if (data.cacheStatus !== "refreshing") {
        this._breakdownCache.set(range, { at: Date.now(), data });
      }
      return data;
    } catch (err) {
      console.error("[openclaw] sessions.usage failed:", err?.message || err);
      return { byModel: [], byAgent: [], totals: { totalTokens: 0, totalCost: 0 } };
    }
  }

  // ---- skills (management UI, read-only) ----

  async getSkills() {
    try {
      await this._connect();
    } catch (err) {
      console.error("[openclaw] skills.status skipped:", err?.message || err);
      return [];
    }
    try {
      const res = await this.request("skills.status", {}, 15000);
      const skills = Array.isArray(res?.skills) ? res.skills : [];
      return skills.map((s) => ({
        name: s.name || s.skillKey || "",
        description: typeof s.description === "string" ? s.description : "",
        enabled: s.disabled !== true, // gateway exposes `disabled`; invert it
        category: s.source || undefined,
        emoji: s.emoji || undefined,
        backendId: "openclaw",
      }));
    } catch (err) {
      console.error("[openclaw] skills.status failed:", err?.message || err);
      return [];
    }
  }

  async updateSkill(name, patch) {
    await this._connect();
    const p = { skillKey: name };
    if (typeof patch?.enabled === "boolean") p.enabled = patch.enabled;
    if (typeof patch?.apiKey === "string") p.apiKey = patch.apiKey;
    if (patch?.env && typeof patch.env === "object") p.env = patch.env;
    const res = await this.request("skills.update", p, 12000);
    return res || { name, ...patch };
  }

  async setSkillEnabled(name, enabled) {
    return this.updateSkill(name, { enabled: !!enabled });
  }

  // ---- tasks / kanban (management UI) ----
  // OpenClaw's board is the gateway `workboard` plugin (NOT a file board): all data
  // comes from `workboard.cards.*` over the same device-auth WS-RPC used for cron/agents.
  // Store: ~/.openclaw/plugin-state/state.sqlite (namespace workboard.cards).
  //
  // This section mirrors the 2026.8.1 Workboard RPC surface. Lifecycle is
  // projected from plugin-owned cards/tasks/sessions; list/refresh paths remain
  // read-only, while explicit user actions retain their dedicated write RPCs.

  // Engine→model map; mirrors the official control-ui workboard run buttons (keep in sync if upstream retires these).
  static OC_WB_RUN_MODELS = { codex: "openai/gpt-5.5", claude: "anthropic/claude-sonnet-4-6" };
  // status id → zh fallback label (official workboard.status.* zh-CN); UI re-translates by id.
  static OC_WB_STATUS_NAMES = {
    triage: "Triage", backlog: "待办池", todo: "待办", scheduled: "已计划", ready: "就绪",
    running: "运行中", review: "查看", blocked: "已阻挡", done: "已完成",
  };
  // Official status enum (workboard runtime `_d`) — the gateway's list response wins.
  static OC_WB_STATUSES = ["triage", "backlog", "todo", "scheduled", "ready", "running", "review", "blocked", "done"];
  static OC_WB_PRIORITIES = ["low", "normal", "high", "urgent"];
  static OC_WB_TEMPLATES = ["bugfix", "docs", "release", "pr_review", "plugin"];
  // Session with status "running" but hasActiveRun=false for 30min → stale (official Qd).
  static OC_WB_STALE_MS = 1800 * 1000;
  // tasks.list page size (official $d) and run→task discovery retry delays (official [0,...nf]).
  static OC_WB_TASK_PAGE = 500;
  static OC_WB_RUN_DISCOVER_DELAYS = [0, 100, 250, 500];

  _ocCapabilities() {
    return {
      kind: "workboard", drag: true, archive: true, hardDelete: true,
      sessionHandoff: true, labels: true, comments: true, dispatch: true,
      priorities: OpenClawBackend.OC_WB_PRIORITIES,
      templates: OpenClawBackend.OC_WB_TEMPLATES,
    };
  }

  // workboard card → UnifiedTask (board item). `ctx` ({sessByKey, tasksByCard}) attaches
  // the official lifecycle view (session/task linkage) the workboard UI renders from.
  _ocMapCard(c, ctx = null) {
    const md = c.metadata || {};
    const badges = {
      comments: (md.comments || []).length || undefined,
      attempts: (md.attempts || []).length || undefined,
      proof: (md.proof || []).length || undefined,
      artifacts: (md.artifacts || []).length || undefined,
      diagnostics: (md.diagnostics || []).length || undefined,
      links: (md.links || []).length || undefined,
      claimed: md.claim ? true : undefined,
      stale: md.stale ? true : undefined,
      failures: md.failureCount || undefined,
    };
    const lastEv = Array.isArray(c.events) && c.events.length ? c.events[c.events.length - 1] : null;
    return {
      id: c.id,
      title: c.title || "",
      excerpt: (c.notes || "").replace(/\s+/g, " ").slice(0, 140),
      column: c.status,
      priorityLevel: c.priority,
      labels: Array.isArray(c.labels) ? c.labels : [],
      agentId: c.agentId,
      sessionKey: c.sessionKey || c.execution?.sessionKey,
      position: typeof c.position === "number" ? c.position : 0,
      live: c.execution?.status === "running",
      updatedAt: c.updatedAt,
      badges,
      lastEvent: lastEv ? { kind: lastEv.kind, at: lastEv.at } : undefined,
      backendId: "openclaw",
      // Full official card (raw) + derived lifecycle — the 1:1 workboard view renders
      // exclusively from this; the flat fields above stay for legacy consumers.
      wb: {
        ...c,
        archived: !!md.archivedAt,
        ...(ctx ? { lifecycle: this._wbLifecycleView(c, ctx) } : {}),
      },
    };
  }

  // Lifecycle view attached per card (inputs of the official St/Ct/Ot/health helpers,
  // which the UI reimplements): resolved session row + linked gateway task + Vp state.
  _wbLifecycleView(c, ctx) {
    const task = ctx.tasksByCard.get(c.id) || null;
    const lc = this._wbLifecycle(c, ctx.sessByKey, task);
    const s = lc.session;
    return {
      state: lc.state,
      session: s
        ? {
            key: s.key,
            name: s.displayName || s.label || s.key,
            status: s.status,
            hasActiveRun: s.hasActiveRun,
            abortedLastRun: s.abortedLastRun,
            updatedAt: s.updatedAt,
          }
        : null,
      task: task
        ? {
            id: task.id,
            taskId: task.taskId,
            runtime: task.runtime,
            status: task.status,
            deliveryStatus: task.deliveryStatus,
            terminalOutcome: task.terminalOutcome,
            title: task.title,
            progressSummary: task.progressSummary,
            terminalSummary: task.terminalSummary,
            error: task.error,
            startedAt: task.startedAt,
            endedAt: task.endedAt,
            // run/session identity — the UI's failed-attempts health counter needs
            // these to dedupe a failed task already recorded as a card attempt (Lf).
            runId: task.runId,
            sessionKey: task.sessionKey,
            childSessionKey: task.childSessionKey,
            ownerKey: task.ownerKey,
          }
        : null,
    };
  }

  // workboard card → UnifiedTaskDetail (drawer)
  _ocMapDetail(c) {
    const md = c.metadata || {};
    const base = this._ocMapCard(c);
    return {
      ...base,
      body: c.notes || "",
      templateId: md.templateId,
      execution: c.execution,
      events: Array.isArray(c.events) ? c.events : [],
      proof: md.proof || [],
      artifacts: md.artifacts || [],
      links: md.links || [],
      comments: (md.comments || []).map((cm) => ({ author: "operator", body: cm.body, createdAt: cm.createdAt })),
      diagnostics: (md.diagnostics || []).map((d) => ({
        severity: d.severity, kind: d.kind, title: d.title, detail: d.detail,
        message: d.title, actions: Array.isArray(d.actions) ? d.actions : [],
      })),
      createdAt: c.createdAt, updatedAt: c.updatedAt,
      startedAt: c.startedAt, completedAt: c.completedAt,
      raw: JSON.stringify(c, null, 2),
    };
  }

  async _ocListCards() {
    await this._connect();
    const r = await this.request("workboard.cards.list", {});
    return {
      cards: Array.isArray(r?.cards) ? r.cards : [],
      // Order columns by the gateway-returned statuses (spec §5); fall back to our enum.
      statuses: Array.isArray(r?.statuses) && r.statuses.length ? r.statuses : OpenClawBackend.OC_WB_STATUSES,
    };
  }

  async getTaskBoard(opts = {}) {
    let cards = [];
    let statuses = OpenClawBackend.OC_WB_STATUSES;
    let refreshError;
    try {
      await this._connect();
      // Official refresh order: diagnostics.refresh (write path; errors non-fatal →
      // surfaced as refresh error), then cards.list.
      if (opts.refreshDiagnostics) {
        try {
          await this.request("workboard.cards.diagnostics.refresh", {}, 15000);
        } catch (e) {
          refreshError = e?.message || String(e);
        }
      }
      const r = await this._ocListCards();
      cards = r.cards;
      statuses = r.statuses;
    } catch (e) {
      // Plugin disabled / not connected → empty board + error string (the UI shows the
      // official "Workboard is disabled" callout for it). Silent degrade otherwise (§6.4).
      console.warn("[openclaw] workboard.cards.list failed:", e.message);
      return { columns: [], capabilities: {}, error: e?.message || String(e) };
    }
    // Lifecycle inputs — each degrades independently (§6.4): no sessions/tasks data
    // just means no live linkage this round, the board itself still renders.
    const [sessions, agents, gwTasks] = await Promise.all([
      this._wbListSessions().catch(() => []),
      this._wbListAgents().catch(() => null),
      this._wbListGatewayTasks().catch(() => null),
    ]);
    const sessByKey = new Map(sessions.map((s) => [s.key, s]));
    let tasksByCard = new Map();
    if (gwTasks) tasksByCard = await this._wbResolveTasks(cards, gwTasks);
    // 8.1 Workboard plugin owns persisted lifecycle transitions. A browser refresh
    // is a read and must never race the plugin by writing inferred card state back.
    // We still project the linked task/session below for live status badges.
    const ctx = { sessByKey, tasksByCard };
    const buckets = new Map(statuses.map((s) => [s, []]));
    for (const c of cards) {
      // Archived cards ship with an `archived` flag (official keeps them in the list
      // and lets the UI's show/hide-archived toggle filter client-side).
      if (!buckets.has(c.status)) buckets.set(c.status, []);
      buckets.get(c.status).push(c);
    }
    const columns = [];
    for (const s of statuses) {
      const list = (buckets.get(s) || []).sort((a, b) => (a.position || 0) - (b.position || 0));
      columns.push({ id: s, name: OpenClawBackend.OC_WB_STATUS_NAMES[s] || s, tasks: list.map((c) => this._ocMapCard(c, ctx)) });
    }
    return {
      columns,
      capabilities: this._ocCapabilities(),
      statuses,
      // Modal "session" select options + agent filter/assignment (official reads the
      // same gateway lists; trimmed to what the workboard view renders).
      sessions,
      agents: agents || undefined,
      ...(refreshError ? { refreshError } : {}),
    };
  }

  // sessions.list trimmed to the fields the workboard view needs (select options,
  // lifecycle matching, heartbeat filtering — official Ie/zp inputs).
  async _wbListSessions() {
    await this._connect();
    const r = await this.request("sessions.list", {}, 15000);
    const rows = Array.isArray(r?.sessions) ? r.sessions : [];
    return rows.map((s) => ({
      key: String(s?.key || ""),
      label: typeof s?.label === "string" ? s.label : undefined,
      displayName: typeof s?.displayName === "string" ? s.displayName : undefined,
      kind: typeof s?.kind === "string" ? s.kind : undefined,
      archived: s?.archived === true ? true : undefined,
      status: typeof s?.status === "string" ? s.status : undefined,
      hasActiveRun: typeof s?.hasActiveRun === "boolean" ? s.hasActiveRun : undefined,
      abortedLastRun: s?.abortedLastRun === true ? true : undefined,
      updatedAt: typeof s?.updatedAt === "number" ? s.updatedAt : undefined,
    })).filter((s) => s.key);
  }

  // agents.list incl. defaultId + per-agent ACP runtime id (official gates the
  // codex/claude engine buttons on runtime ∈ {openclaw, pi}).
  async _wbListAgents() {
    await this._connect();
    const r = await this.request("agents.list", {}, 15000);
    const agents = (Array.isArray(r?.agents) ? r.agents : []).map((a) => ({
      id: String(a?.id || ""),
      name: a?.name || a?.identity?.name || a?.id || "",
      runtimeId: typeof a?.agentRuntime?.id === "string" ? a.agentRuntime.id : undefined,
    })).filter((a) => a.id);
    return { defaultId: typeof r?.defaultId === "string" ? r.defaultId : undefined, agents };
  }

  // ---- workboard ↔ gateway-run linkage (official task/session matchers) ----

  _wbCardSession(c) { return c.sessionKey || c.execution?.sessionKey || undefined; }   // official Y
  _wbCardRun(c) { return c.runId || c.execution?.runId || undefined; }                 // official Bp
  _wbTrim(v) { return typeof v === "string" && v.trim() ? v.trim() : null; }           // official X

  // official ap: a gateway task's session matches the card's when equal, or when the
  // card runs as a workboard subagent and the task key ends with ":<subagent key>".
  _wbSessionMatches(taskSession, cardSession) {
    if (!taskSession || !cardSession) return false;
    if (taskSession === cardSession) return true;
    return cardSession.startsWith("subagent:workboard-") && taskSession.endsWith(`:${cardSession}`);
  }

  // official op (loose): explicit taskId, else sessionKey/childSessionKey/ownerKey, else runId.
  _wbTaskMatchesLoose(task, card) {
    const tid = this._wbTrim(card.taskId);
    if (tid && (task.taskId === tid || task.id === tid)) return true;
    const sess = this._wbCardSession(card);
    const bySession = sess
      ? [task.sessionKey, task.childSessionKey, task.ownerKey].some((k) => this._wbSessionMatches(k, sess))
      : false;
    const run = this._wbCardRun(card);
    if (run && task.runId === run) return sess ? bySession : true;
    return bySession;
  }

  // official sp (strict): explicit taskId wins outright; else runId must agree.
  _wbTaskMatchesStrict(task, card) {
    const tid = this._wbTrim(card.taskId);
    if (tid) return task.taskId === tid || task.id === tid;
    const run = this._wbCardRun(card);
    if (run && task.runId !== run) return false;
    return this._wbTaskMatchesLoose(task, card);
  }

  // official cp: strict unless the card's taskId is known-missing → loose fallback.
  _wbTaskMatches(task, card, missing) {
    const tid = this._wbTrim(card.taskId);
    if (tid && missing.has(tid)) return this._wbTaskMatchesLoose(task, card);
    return this._wbTaskMatchesStrict(task, card);
  }

  _wbTaskUpdatedAt(task) {                                                             // official np
    if (typeof task.updatedAt === "number") return task.updatedAt;
    if (typeof task.updatedAt === "string") {
      const ms = Date.parse(task.updatedAt);
      return Number.isFinite(ms) ? ms : 0;
    }
    return 0;
  }

  // Normalize a gateway task row (official $f — keep only the fields the board uses).
  _wbNormalizeTask(t) {
    if (!t || typeof t !== "object") return null;
    const id = this._wbTrim(t.id);
    const taskId = this._wbTrim(t.taskId) || id;
    const status = ["queued", "running", "completed", "failed", "cancelled", "timed_out"].includes(t.status) ? t.status : null;
    if (!id || !taskId || !status) return null;
    return {
      id, taskId, status,
      runtime: typeof t.runtime === "string" ? t.runtime : undefined,
      title: typeof t.title === "string" ? t.title : undefined,
      sessionKey: typeof t.sessionKey === "string" ? t.sessionKey : undefined,
      childSessionKey: typeof t.childSessionKey === "string" ? t.childSessionKey : undefined,
      ownerKey: typeof t.ownerKey === "string" ? t.ownerKey : undefined,
      runId: typeof t.runId === "string" ? t.runId : undefined,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      deliveryStatus: typeof t.deliveryStatus === "string" ? t.deliveryStatus : undefined,
      terminalOutcome: t.terminalOutcome === "succeeded" || t.terminalOutcome === "blocked"
        ? t.terminalOutcome
        : undefined,
      progressSummary: typeof t.progressSummary === "string" ? t.progressSummary : undefined,
      terminalSummary: typeof t.terminalSummary === "string" ? t.terminalSummary : undefined,
      error: typeof t.error === "string" ? t.error : undefined,
    };
  }

  // Full gateway tasks list (official tp: page through tasks.list with cursor guard).
  async _wbListGatewayTasks() {
    await this._connect();
    const out = [];
    const seen = new Set();
    let cursor = null;
    for (;;) {
      const r = await this.request("tasks.list", { limit: OpenClawBackend.OC_WB_TASK_PAGE, ...(cursor ? { cursor } : {}) }, 15000);
      const rows = Array.isArray(r?.tasks) ? r.tasks : [];
      for (const t of rows) {
        const n = this._wbNormalizeTask(t);
        if (n) out.push(n);
      }
      const next = this._wbTrim(r?.nextCursor);
      if (!next || seen.has(next)) return out;
      seen.add(next);
      cursor = next;
    }
  }

  // Match every card to its freshest gateway task (official gp/vp): explicit taskId
  // first (tasks.get probe → "task not found" marks it missing, official fp), then
  // runId/sessionKey. `_wbMissingTaskIds` persists across refreshes like the official
  // page state so vanished tasks stop being re-probed every poll.
  async _wbResolveTasks(cards, gwTasks) {
    this._wbMissingTaskIds ||= new Set();
    const missing = this._wbMissingTaskIds;
    const tasks = [...gwTasks];
    for (const t of tasks) {
      missing.delete(t.taskId);
      missing.delete(t.id);
    }
    const known = new Set(tasks.flatMap((t) => [t.id, t.taskId]));
    for (const card of cards) {
      const tid = this._wbTrim(card.taskId);
      if (!tid || known.has(tid) || missing.has(tid)) continue;
      try {
        const r = await this.request("tasks.get", { taskId: tid }, 12000);
        const n = this._wbNormalizeTask(r?.task);
        if (n) {
          tasks.push(n);
          known.add(n.id);
          known.add(n.taskId);
        }
      } catch (e) {
        if (/task not found/i.test(String(e?.message || e))) missing.add(tid);
      }
    }
    const byCard = new Map();
    for (const card of cards) {
      let best = null;
      for (const t of tasks) {
        if (!this._wbTaskMatches(t, card, missing)) continue;
        if (!best || this._wbTaskUpdatedAt(t) > this._wbTaskUpdatedAt(best)) best = t;
      }
      // No match（含 explicit-but-missing taskId）→ 保持未关联（official gp）。
      if (best) byCard.set(card.id, best);
    }
    return byCard;
  }

  // ---- workboard lifecycle projection ----

  // official zp: linked session claims "running" but has no active run and hasn't
  // reported activity for 30min → stale marker.
  _wbSessionStale(s) {
    if (
      s.status === "running" && s.hasActiveRun === false &&
      typeof s.updatedAt === "number" && Date.now() - s.updatedAt >= OpenClawBackend.OC_WB_STALE_MS
    ) {
      return {
        detectedAt: Date.now(),
        lastSessionUpdatedAt: s.updatedAt,
        reason: "Linked session has not reported recent activity.",
      };
    }
    return undefined;
  }

  _wbRunFailedStatus(status) { return status === "failed" || status === "killed" || status === "timeout"; } // official Rp

  // official Vp: lifecycle state for a card from its gateway task first, session second.
  //   → {state, session, targetStatus?, sourceUpdatedAt?}
  _wbLifecycle(card, sessByKey, task) {
    const key = this._wbCardSession(card);
    const session = key ? sessByKey.get(key) || null : null;
    const taskUpdated = task ? (this._wbTaskUpdatedAt(task) || undefined) : undefined;
    if (task) {
      switch (task.status) {
        case "queued":
        case "running":
          if (!(session && (session.abortedLastRun || session.status === "done" || this._wbRunFailedStatus(session.status)))) {
            return { session, state: "running", targetStatus: "running", sourceUpdatedAt: taskUpdated };
          }
          break;
        case "completed":
          if (task.terminalOutcome === "blocked") {
            return { session, state: "failed", targetStatus: "blocked", sourceUpdatedAt: taskUpdated };
          }
          return { session, state: "succeeded", targetStatus: "review", sourceUpdatedAt: taskUpdated };
        case "failed":
        case "cancelled":
        case "timed_out":
          return { session, state: "failed", targetStatus: "blocked", sourceUpdatedAt: taskUpdated };
      }
    }
    if (!key) return { session: null, state: "unlinked" };
    if (!session) return { session: null, state: "missing" };
    const sessUpdated = typeof session.updatedAt === "number" ? session.updatedAt : undefined;
    if (this._wbSessionStale(session)) return { session, state: "stale", targetStatus: "running", sourceUpdatedAt: sessUpdated };
    if (session.hasActiveRun === true || session.status === "running") {
      return { session, state: "running", targetStatus: "running", sourceUpdatedAt: sessUpdated };
    }
    if (session.abortedLastRun || this._wbRunFailedStatus(session.status)) {
      return { session, state: "failed", targetStatus: "blocked", sourceUpdatedAt: sessUpdated };
    }
    if (session.status === "done") return { session, state: "succeeded", targetStatus: "review", sourceUpdatedAt: sessUpdated };
    return { session, state: "idle" };
  }

  async getTask(id) {
    const { cards } = await this._ocListCards();
    const card = cards.find((c) => c.id === id);
    if (!card) throw new Error(`openclaw: 未找到工作板卡片 ${id}`);
    return this._ocMapDetail(card);
  }

  async createTask(spec = {}, _opts) {
    await this._connect();
    const params = {
      title: String(spec.title || "新卡片").trim(),
      notes: spec.body,
      status: spec.status || spec.column,            // page sends `column`
      priority: spec.priorityLevel,
      labels: spec.labels,
      agentId: spec.agentId,
      sessionKey: spec.sessionKey,
      templateId: spec.templateId,
    };
    const r = await this.request("workboard.cards.create", params);
    return this._ocMapDetail(r.card || r);
  }

  async updateTask(id, patch = {}) {
    await this._connect();
    const p = {};
    if (typeof patch.title === "string") p.title = patch.title;
    if (typeof patch.body === "string") p.notes = patch.body;
    if (typeof patch.column === "string") p.status = patch.column;
    if (typeof patch.status === "string") p.status = patch.status;
    if (patch.priorityLevel !== undefined) p.priority = patch.priorityLevel;
    if (Array.isArray(patch.labels)) p.labels = patch.labels;
    if (patch.agentId !== undefined) p.agentId = patch.agentId;
    if (patch.sessionKey !== undefined) p.sessionKey = patch.sessionKey;
    if (patch.templateId !== undefined) p.templateId = patch.templateId;
    const r = await this.request("workboard.cards.update", { id, patch: p });
    return this._ocMapDetail(r.card || r);
  }

  async moveTask(id, status, position) {
    await this._connect();
    const r = await this.request("workboard.cards.move", { id, status, position });
    return this._ocMapDetail(r.card || r);
  }

  async archiveTask(id, archived = true) {
    await this._connect();
    await this.request("workboard.cards.archive", { id, archived });
  }

  async deleteTask(id) {
    await this._connect();
    await this.request("workboard.cards.delete", { id });
  }

  async taskAction(id, action) {
    if (action === "unblock") {
      await this._connect();
      const r = await this.request("workboard.cards.unblock", { id });
      return { ok: true, card: r.card || r };
    }
    if (action === "stop") return this._wbStopCard(id);
    throw new Error(`openclaw: 不支持的 taskAction ${action}`);
  }

  // Operator note (official detail-drawer "Add note" → workboard.cards.comment).
  async addTaskComment(id, body) {
    await this._connect();
    const text = String(body || "").trim();
    if (!text) throw new Error("openclaw: 备注内容为空");
    const r = await this.request("workboard.cards.comment", { id, body: text }, 12000);
    return this._ocMapDetail(r.card || r);
  }

  // Official ⚡ Dispatch button (bm): workboard.cards.dispatch, summarized by array
  // lengths (Sp) — {started, failures, promoted, blocked, reclaimed, orchestrated}.
  async nudgeDispatcher() {
    await this._connect();
    const r = await this.request("workboard.cards.dispatch", {}, 30000);
    const count = (k) => (r && Array.isArray(r[k]) ? r[k].length : 0);
    return {
      started: count("started"),
      failures: count("startFailures"),
      promoted: count("promoted"),
      blocked: count("blocked"),
      reclaimed: count("reclaimed"),
      orchestrated: count("orchestrated"),
    };
  }

  // official Nm (stop): cancel the linked gateway task (if still active), abort the
  // linked chat run, then park the card in blocked. No-op ({ok:false}) when the card
  // has nothing stoppable — official silently returns in that case.
  async _wbStopCard(id) {
    await this._connect();
    const { cards } = await this._ocListCards();
    const card = cards.find((c) => c.id === id);
    if (!card) throw new Error(`openclaw: 未找到工作板卡片 ${id}`);
    const sessionKey = this._wbCardSession(card);
    this._wbMissingTaskIds ||= new Set();
    let taskId = this._wbTrim(card.taskId);
    let linkedTask = null;
    if (taskId && this._wbMissingTaskIds.has(taskId)) taskId = null;
    if (!taskId) {
      // Fall back to run/session discovery, same inputs the lifecycle matcher uses.
      try {
        const tasks = await this._wbListGatewayTasks();
        for (const t of tasks) {
          if (!this._wbTaskMatches(t, card, this._wbMissingTaskIds)) continue;
          if (!linkedTask || this._wbTaskUpdatedAt(t) > this._wbTaskUpdatedAt(linkedTask)) linkedTask = t;
        }
        if (linkedTask) taskId = linkedTask.taskId;
      } catch { /* degrade to session-only stop */ }
    }
    if (!sessionKey && !taskId) return { ok: false, reason: "no-session" };
    let cancelled = false;
    const taskActive = !linkedTask || linkedTask.status === "queued" || linkedTask.status === "running";
    if (taskId && taskActive) {
      try {
        const r = await this.request("tasks.cancel", { taskId, reason: "Stopped from Workboard." }, 12000);
        if (r && r.found === false) this._wbMissingTaskIds.add(taskId);
        cancelled = !!(r && r.cancelled === true);
      } catch (e) {
        if (/task not found/i.test(String(e?.message || e))) this._wbMissingTaskIds.add(taskId);
        else if (!sessionKey) throw e;
      }
    }
    let aborted = false;
    if (sessionKey) {
      aborted = await this._wbAbortChat(sessionKey, this._wbCardRun(card)).catch((e) => {
        if (!cancelled) throw e;
        return false;
      });
    }
    if (!cancelled && !aborted) return { ok: false, reason: "no-active-run" };
    const r = await this.request("workboard.cards.update", {
      id,
      patch: {
        status: "blocked",
        ...(card.execution
          ? { execution: { ...card.execution, status: "blocked", updatedAt: Date.now() } }
          : {}),
      },
    }, 12000);
    return { ok: true, card: r.card || r };
  }

  // official km: chat.abort with runId, retrying without it when nothing matched.
  async _wbAbortChat(sessionKey, runId) {
    let r = await this.request("chat.abort", { sessionKey, ...(runId ? { runId } : {}) }, 12000);
    const hit = (x) => !!(x && (x.aborted === true || (Array.isArray(x.runIds) && x.runIds.length > 0)));
    if (!hit(r) && runId) {
      r = await this.request("chat.abort", { sessionKey }, 12000);
    }
    return hit(r);
  }

  // official Cm: slug for session-key/idempotency segments.
  _wbSlug(v, fallback) {
    const s = (typeof v === "string" && v.trim() ? v : fallback)
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    return (s || fallback).slice(0, 96);
  }

  // official wm: deterministic per-card subagent session key (reused across runs).
  _wbSessionKeyFor(card) {
    const tail = `subagent:workboard-${this._wbSlug(card.metadata?.automation?.boardId, "default")}-${this._wbSlug(card.id, "card")}`;
    const key = card.agentId ? `agent:${this._wbSlug(card.agentId, "agent")}:${tail}` : tail;
    const current = this._wbCardSession(card);
    return current && current.trim() === key ? current.trim() : key;
  }

  // official Sm: session label "<title> (<id8>)", ≤512 chars.
  _wbRunLabel(card) {
    const id8 = String(card.id).trim().slice(0, 8) || "card";
    const title = String(card.title || "").trim() || "Workboard card";
    const suffix = ` (${id8})`;
    if (title.length + suffix.length <= 512) return `${title}${suffix}`;
    return `${title.slice(0, 512 - suffix.length - 3).trimEnd()}...${suffix}`;
  }

  // official xm: the worker kickoff prompt.
  _wbWorkerPrompt(card) {
    const lines = [`Work on this OpenClaw Workboard card: ${card.title || ""}`];
    if (card.notes && card.notes.trim()) lines.push("", card.notes.trim());
    if (Array.isArray(card.labels) && card.labels.length) lines.push("", `Labels: ${card.labels.join(", ")}`);
    const parents = (card.metadata?.links || [])
      .filter((l) => l.type === "parent" && l.targetCardId)
      .map((l) => l.targetCardId);
    if (parents.length) lines.push("", `Parents: ${parents.join(", ")}`);
    if (card.metadata?.automation?.skills?.length) {
      lines.push("", `Suggested skills: ${card.metadata.automation.skills.join(", ")}`);
    }
    if (card.metadata?.automation?.workspace) {
      const w = card.metadata.automation.workspace;
      lines.push("", `Workspace: ${w.kind}${w.path ? ` ${w.path}` : ""}`);
    }
    lines.push("", "When done, summarize what changed and what remains.");
    return lines.join("\n");
  }

  // official Em: scheduled cards can't start before their time.
  _wbIsScheduled(card, now = Date.now()) {
    const at = card.metadata?.automation?.scheduledAt;
    return typeof at === "number" ? at > now : card.status === "scheduled";
  }

  // official Om: after the `agent` call, find the gateway task it registered
  // (retry 0/100/250/500ms — task registration is async).
  async _wbDiscoverRunTask(card, sessionKey, runId) {
    const probe = { ...card, taskId: undefined, sessionKey, ...(runId ? { runId } : {}) };
    for (const delay of OpenClawBackend.OC_WB_RUN_DISCOVER_DELAYS) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      try {
        const tasks = await this._wbListGatewayTasks();
        let best = null;
        for (const t of tasks) {
          if (!this._wbTaskMatchesLoose(t, probe)) continue;
          if (!best || this._wbTaskUpdatedAt(t) > this._wbTaskUpdatedAt(best)) best = t;
        }
        if (best) return best;
      } catch { /* retry */ }
    }
    return null;
  }

  // official Mm (start card). autonomous: pre-move to running → gateway `agent` call on
  // the per-card subagent session (idempotencyKey workboard:<board>:<card>:<updatedAt>)
  // → discover the spawned gateway task → write session/run/task/execution back onto
  // the card; any failure aborts the run and reverts the card. manual: sessions.create
  // only (open a workspace session), never injects a kickoff message.
  async runTaskCard(id, opts = {}) {
    await this._connect();
    const { cards } = await this._ocListCards();
    const card = cards.find((c) => c.id === id);
    if (!card) throw new Error(`openclaw: 未找到工作板卡片 ${id}`);
    const engine = opts.engine === "codex" || opts.engine === "claude" ? opts.engine : null;
    const mode = opts.mode === "manual" ? "manual" : "autonomous";
    if (mode === "autonomous" && this._wbIsScheduled(card)) {
      throw new Error("Scheduled cards cannot start before their scheduled time.");
    }
    const clearScheduledAt = mode === "manual" && card.metadata?.automation?.scheduledAt !== undefined;
    const targetStatus = mode === "autonomous" ? "running" : card.status === "scheduled" ? "todo" : card.status;
    const execStatus = mode === "autonomous" ? "running" : "idle";
    const label = this._wbRunLabel(card);
    let working = card;
    let prePatched = false;
    let sessionKey = null;
    let runId;
    try {
      if (mode === "autonomous") {
        const r = await this.request("workboard.cards.update", { id, patch: { status: targetStatus } }, 12000);
        working = r.card || r;
        prePatched = true;
        const res = await this.request("agent", {
          sessionKey: this._wbSessionKeyFor(working),
          ...(working.agentId ? { agentId: working.agentId } : {}),
          label,
          ...(engine ? { model: OpenClawBackend.OC_WB_RUN_MODELS[engine] } : {}),
          message: this._wbWorkerPrompt(working),
          deliver: false,
          bootstrapContextMode: "lightweight",
          idempotencyKey: `workboard:${this._wbSlug(working.metadata?.automation?.boardId, "default")}:${this._wbSlug(working.id, "card")}:${working.updatedAt}`,
        }, 60000);
        sessionKey =
          (typeof res?.sessionKey === "string" && res.sessionKey.trim() && res.sessionKey.trim()) ||
          (typeof res?.key === "string" && res.key.trim() && res.key.trim()) ||
          this._wbSessionKeyFor(working);
        runId = typeof res?.runId === "string" && res.runId.trim() ? res.runId.trim() : undefined;
        if (!runId) throw new Error("Gateway agent method returned an invalid runId.");
      } else {
        // manual (official Cn = sessions.create). Fixed labels can collide on repeat
        // opens (KAN-009) — reuse the same-label session instead of surfacing the 500.
        const createParams = {
          ...(card.agentId ? { agentId: card.agentId } : {}),
          label,
          ...(engine ? { model: OpenClawBackend.OC_WB_RUN_MODELS[engine] } : {}),
        };
        try {
          const res = await this.request("sessions.create", createParams, 15000);
          sessionKey = typeof res?.key === "string" && res.key.trim() ? res.key.trim() : null;
          if (!sessionKey) throw new Error("sessions.create returned no key");
        } catch (err) {
          if (!/label already in use/i.test(String(err?.message || err))) throw err;
          const listed = await this.request("sessions.list", {}, 15000);
          const hit = (Array.isArray(listed?.sessions) ? listed.sessions : []).find((s) => s?.label === label);
          if (!hit || typeof hit.key !== "string" || !hit.key.trim()) throw err;
          sessionKey = hit.key.trim();
        }
      }
      const discovered = mode === "autonomous" && sessionKey
        ? await this._wbDiscoverRunTask(working, sessionKey, runId)
        : null;
      const now = Date.now();
      const r = await this.request("workboard.cards.update", {
        id,
        patch: {
          status: targetStatus,
          ...(clearScheduledAt ? { scheduledAt: null } : {}),
          ...(sessionKey ? { sessionKey } : {}),
          runId: runId ?? null,
          taskId: discovered?.taskId ?? null,
          execution: engine
            ? {
                id: working.execution?.id || `${working.id}:${engine}`,
                kind: "agent-session",
                engine,
                mode,
                status: execStatus,
                model: OpenClawBackend.OC_WB_RUN_MODELS[engine],
                startedAt: now,
                updatedAt: now,
                ...(sessionKey ? { sessionKey } : {}),
                ...(runId ? { runId } : {}),
              }
            : null,
        },
      }, 12000);
      const finalCard = r.card || r;
      return { sessionKey, runId, runStarted: mode === "autonomous" ? true : undefined, status: finalCard.status || targetStatus };
    } catch (err) {
      // official Mm catch: kill the run we may have started, restore the card.
      if (mode === "autonomous" && sessionKey) {
        try { await this._wbAbortChat(sessionKey, runId); } catch { /* best-effort */ }
      }
      if (prePatched) {
        try {
          await this.request("workboard.cards.update", {
            id,
            patch: {
              status: card.status,
              startedAt: card.startedAt ?? null,
              completedAt: card.completedAt ?? null,
              ...(card.execution === undefined ? {} : { execution: card.execution }),
            },
          }, 12000);
        } catch { /* leave as-is */ }
      }
      throw err;
    }
  }

  // ---- agents (management UI) ----

  async listAgents() {
    try {
      await this._connect();
    } catch (err) {
      console.error("[openclaw] agents.list skipped:", err?.message || err);
      return [];
    }
    try {
      const r = await this.request("agents.list", {}, 15000);
      const defaultId = r?.defaultId;
      const agents = Array.isArray(r?.agents) ? r.agents : [];
      const local = this._isLocalGateway();
      const home = local ? resolveOpenClawHome() : null;
      return sortAgentsByCreatedAt(agents.map((a) => {
        const id = String(a?.id || "");
        const workspace = a?.workspace || undefined;
        const createdAt = local
          ? dirCreatedAtMs(path.join(home, "agents", id)) ?? dirCreatedAtMs(workspace)
          : null;
        return {
          id,
          name: a?.name || a?.id || "",
          model: a?.model?.primary || undefined,
          fallbacks: Array.isArray(a?.model?.fallbacks) ? a.model.fallbacks : undefined,
          workspace,
          isDefault: a?.id != null && a.id === defaultId,
          createdAt,
          backendId: "openclaw",
        };
      }));
    } catch (err) {
      console.error("[openclaw] agents.list failed:", err?.message || err);
      return [];
    }
  }

  async getAgent(id) {
    await this._connect();
    const r = await this.request("agents.list", {}, 12000);
    const defaultId = r?.defaultId;
    const a = (Array.isArray(r?.agents) ? r.agents : []).find((x) => String(x?.id) === String(id));
    if (!a) throw new Error(`openclaw: 未找到 agent ${id}`);
    let files = [];
    try {
      files = await this.listAgentFiles(id);
    } catch {
      /* files optional */
    }
    return {
      id: String(a.id),
      name: a.name || a.id,
      model: a.model?.primary || undefined,
      fallbacks: Array.isArray(a.model?.fallbacks) ? a.model.fallbacks : undefined,
      workspace: a.workspace || undefined,
      emoji: a.identity?.emoji || a.emoji || undefined,
      isDefault: a.id != null && a.id === defaultId,
      files,
      backendId: "openclaw",
    };
  }

  async updateAgent(id, patch) {
    await this._connect();
    const p = { agentId: id };
    if (typeof patch?.name === "string" && patch.name.trim()) p.name = patch.name.trim();
    if (typeof patch?.emoji === "string") p.emoji = patch.emoji;
    if (typeof patch?.avatar === "string") p.avatar = patch.avatar;
    if (typeof patch?.workspace === "string" && patch.workspace.trim()) p.workspace = patch.workspace.trim();
    // model / fallbacks 不走 agents.update:该 RPC 的 model 参数 schema 是纯字符串,
    // 网关 applyAgentConfig 用它**整体替换** agent 的 model 节点 → fallbacks 被清空
    // (真机验证:main 被这样清成 "xiaomi/mimo-v2.5-pro" 裸串,而裸串在
    // resolveSelectedModelFallbacksOverride 里等于「显式空 fallback 链」,不是继承 defaults)。
    // 两者一起走 config.patch 写 {primary, fallbacks},保住整节点。
    if (typeof patch?.model === "string" || Array.isArray(patch?.fallbacks)) {
      await this._patchAgentModel(id, {
        ...(typeof patch.model === "string" ? { primary: patch.model } : {}),
        ...(Array.isArray(patch.fallbacks) ? { fallbacks: patch.fallbacks } : {}),
      });
    }
    if (Object.keys(p).length > 1) await this.request("agents.update", p, 15000);
    // OpenClaw agent ids are stable across renames; echo it back so callers can
    // uniformly re-select on the returned id (see AgentBackend.updateAgent).
    return { ok: true, id };
  }

  /**
   * 写 agents.entries.<id>.model = {primary, fallbacks}(缺省的那一半保留原值)。
   * 用 config.patch 而不是 agents.update —— 见 updateAgent 的注释。
   * 已收敛则零写(幂等):config.patch 有写限流 + 会触发网关热重载,不做无谓写入。
   */
  async _patchAgentModel(agentId, next) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 1500));
      const { parsed, hash } = await this._configSnapshot();
      const list = readCanonicalAgentEntries(parsed);
      const idx = list.findIndex((e) => e && String(e.id) === String(agentId));
      if (idx < 0) throw new Error(`openclaw: 配置里没有 agent ${agentId} 的条目`);
      // 既有形状有三种:{primary,fallbacks} / 裸串(= primary,空 fallback 链) / null(继承 defaults)。
      const raw = list[idx].model;
      const cur = typeof raw === "string"
        ? { primary: raw, fallbacks: [] }
        : raw && typeof raw === "object"
          ? { primary: raw.primary, fallbacks: Array.isArray(raw.fallbacks) ? raw.fallbacks : undefined }
          : {};
      const merged = {
        primary: next.primary !== undefined ? next.primary : cur.primary,
        fallbacks: next.fallbacks !== undefined ? next.fallbacks : cur.fallbacks,
      };
      if (merged.primary === undefined) delete merged.primary;
      if (merged.fallbacks === undefined) delete merged.fallbacks;
      // 零写:裸串与 {primary, fallbacks:[]} 语义等价,按值比而不是按 JSON 形状比。
      if (
        merged.primary === cur.primary &&
        JSON.stringify(merged.fallbacks ?? null) === JSON.stringify(cur.fallbacks ?? null)
      ) return;
      const nextList = list.map((e, i) => (i === idx ? { ...e, model: merged } : e));
      const nextEntryUnified = nextList[idx];
      const { id: canonicalId, ...entryPatch } = nextEntryUnified;
      try {
        await this.request(
          "config.patch",
          {
            raw: JSON.stringify({ agents: { entries: { [canonicalId]: entryPatch } } }),
            baseHash: hash,
            // 收缩既有数组必须显式声明,否则网关深合并、删不掉多余项。
            replacePaths: [`agents.entries.${canonicalId}.model.fallbacks`],
          },
          15000,
        );
        return;
      } catch (err) {
        lastErr = err;
        // 热重载窗口内 baseHash 必然失配 → 退避重读重试(同 _patchModelProviders 的语义)。
        if (/changed since last load/i.test(String(err?.message || err))) continue;
        throw err;
      }
    }
    const error = new Error("网关正在应用上一次配置变更,模型未写入,请稍候重试");
    error.code = "config_write_conflict";
    error.cause = lastErr;
    throw error;
  }

  async createAgent(spec) {
    await this._connect();
    const name = typeof spec?.name === "string" ? spec.name.trim() : "";
    if (!name) throw new Error("openclaw: 创建 agent 需要 name");
    const agentId = normalizeOpenClawAgentId(name);
    if (!agentId || agentId === "main") throw new Error("openclaw: 创建 agent 需要有效名称");
    const workspace = typeof spec?.workspace === "string" && spec.workspace.trim()
      ? spec.workspace.trim()
      : defaultOpenClawAgentWorkspace(name);
    if (!workspace) throw new Error("openclaw: 创建 agent 需要有效名称");
    // Gateway 用 name 生成 id；非规范名称先用稳定 ASCII id 创建，再写回展示名。
    const createName = OPENCLAW_AGENT_ID_RE.test(name) ? name : agentId;
    const emoji = typeof spec?.emoji === "string" && spec.emoji.trim()
      ? spec.emoji.trim()
      : randomOpenClawCreateEmoji();
    const p = { name: createName, workspace, emoji };
    if (spec.model) p.model = spec.model;
    if (spec.avatar) p.avatar = spec.avatar;
    const created = await this.request("agents.create", p, 20000);
    if (name !== createName) {
      await this.request("agents.update", { agentId, name, emoji, avatar: spec.avatar }, 15000);
    }
    return created;
  }

  async deleteAgent(id, opts = {}) {
    await this._connect();
    return this.request("agents.delete", { agentId: id, deleteFiles: opts.trash !== false }, 20000);
  }

  // 单个 agent 的产出文件：根收窄到它自己的 workspace（从 agents.list 拿已解析好的
  // 路径，main 的 workspace 就是 <home>/workspace，不必回配置里翻）。扫描规则与
  // dashboard 产出区完全一致（同一套黑名单/身份文件表 + 同一个 walker）。
  async listAgentArtifacts(agentId, { limit = 100 } = {}) {
    if (!this._isLocalGateway()) return { supported: false, reason: "remote", items: [] };
    await this._connect();
    const r = await this.request("agents.list", {}, 12000);
    const a = (Array.isArray(r?.agents) ? r.agents : []).find((x) => String(x?.id) === String(agentId));
    let ws = typeof a?.workspace === "string" ? a.workspace.trim() : "";
    if (ws.startsWith("~/")) ws = path.join(os.homedir(), ws.slice(2));
    if (!ws || !path.isAbsolute(ws)) return { supported: true, items: [] };
    const roots = await normalizeArtifactRoots([{ path: ws, area: `agents/${agentId}`, agentId }]);
    if (!roots.length) return { supported: true, items: [], total: 0 };
    // 不截断地拿全量再自己切：UI 要显示「共 N 个」，截断后的长度不是总数。
    // total 仍受 walker 的 stat 硬上限约束（2000，防跑飞），与 dashboard 同一约束。
    const all = await walkArtifactRoots(roots, {
      maxStats: 2000,
      keep: Number.MAX_SAFE_INTEGER,
      excludeDirs: ARTIFACT_EXCLUDE_DIRS,
      excludeExts: ARTIFACT_EXCLUDE_EXTS,
      identityFiles: ARTIFACT_IDENTITY_FILES,
      kindForExt: artifactKind,
    });
    return { supported: true, total: all.length, items: all.slice(0, Math.max(1, limit)) };
  }

  async listSessionArtifacts(agentId, sessionKey, { limit = 50 } = {}) {
    if (!this._isLocalGateway()) return { supported: false, reason: "remote", items: [] };
    if (!agentId || agentIdFromSessionKey(sessionKey) !== agentId) {
      return { supported: false, reason: "invalid-request", items: [] };
    }
    let sinceMs = 0;
    try {
      await this._connect();
      const listed = await this.request("sessions.list", {
        agentId: String(agentId),
        configuredAgentsOnly: true,
        limit: 500,
      }, 15000);
      const row = (Array.isArray(listed?.sessions) ? listed.sessions : [])
        .find((candidate) => candidate?.key === sessionKey);
      const startedAt = Number(row?.startedAt ?? row?.createdAt);
      if (Number.isFinite(startedAt) && startedAt > 0) sinceMs = startedAt;
    } catch { /* handled below: unscoped agent artifacts must not impersonate session output */ }
    if (!sinceMs) {
      return { supported: false, reason: "session-time-unavailable", items: [] };
    }
    let matched;
    try {
      const agents = await this.request("agents.list", {}, 12000);
      let workspace = agents?.agents?.find((agent) => agent.id === agentId)?.workspace;
      if (workspace?.startsWith("~/")) workspace = path.join(os.homedir(), workspace.slice(2));
      if (!workspace || !path.isAbsolute(workspace)) throw new Error("Workspace unavailable");
      const history = await this.request("chat.history", { sessionKey, limit: 1000 }, 15000);
      if (!Array.isArray(history?.messages)) throw new Error("History unavailable");
      matched = await collectSessionOutputArtifacts({
        ...sessionArtifactHistory(history.messages, sinceMs), workspace, runtimeHome: os.homedir(),
        sessionCreatedAt: sinceMs, agentId,
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

  // ---- 链接类工作区文件（symlink / hardlink）的本机兜底 ----
  // 网关的 agents.files.* 一律拒链接：read 传 hardlinks:"reject"、list 的 stat 要求
  // !isSymbolicLink && nlink<=1，于是软链文件读写报 `unsafe workspace file "<name>"`、
  // 列表里没有 size/时间。把身份文件软链到共享路径是常见用法，所以本机网关下按链接
  // 目标兜底。链接**自身**必须直属 workspace（挡 ../ 逃逸），目标指向哪儿不限——那正
  // 是软链的用途；范围仅限核心档案与网关返回的其他文件。

  /** 链接类文件的本机真实路径；非链接/非本机/名字越界都返回 null（继续走网关）。 */
  _linkedWorkspaceFilePath(workspaceDir, name) {
    if (!this._isLocalGateway()) return null;
    if (typeof workspaceDir !== "string" || !workspaceDir.trim()) return null;
    if (typeof name !== "string" || !name || name.startsWith(".")) return null;
    if (name.includes("/") || name.includes("\\")) return null;
    const dir = path.resolve(workspaceDir);
    const file = path.resolve(dir, name);
    if (path.dirname(file) !== dir) return null;
    try {
      const link = fs.lstatSync(file);
      if (!link.isSymbolicLink() && link.nlink <= 1) return null; // 普通文件网关自己能处理
      return fs.statSync(file).isFile() ? file : null; // 断链 / 指向目录都不接
    } catch {
      return null; // 不存在 → 保持网关的 missing 语义
    }
  }

  /** 定位一个链接类文件：仅核心档案或网关清单条目，workspace 必须由网关确认。 */
  async _resolveLinkedWorkspaceFile(id, name) {
    if (!this._isLocalGateway()) return null;
    try {
      const fr = await this.request("agents.files.list", { agentId: id }, 12000);
      const files = Array.isArray(fr?.files) ? fr.files : [];
      if (!CORE_AGENT_FILE_NAMES.includes(name) && !files.some((f) => f?.name === name)) return null;
      return this._linkedWorkspaceFilePath(fr?.workspace, name);
    } catch {
      return null;
    }
  }

  /** 补齐核心档案入口，并恢复本机链接文件被网关省略的 size/时间。 */
  _withLinkedFileStats(workspaceDir, files) {
    const entries = new Map((Array.isArray(files) ? files : []).map((f) => [f.name, f]));
    const names = new Set([...CORE_AGENT_FILE_NAMES, ...entries.keys()]);
    return [...names].map((name) => {
      const f = entries.get(name) || { name };
      const out = { name: f.name, size: f.size, modifiedAt: f.updatedAtMs };
      if (out.size != null) return out;
      const real = this._linkedWorkspaceFilePath(workspaceDir, f.name);
      if (!real) return out;
      try {
        const st = fs.statSync(real);
        return { name: f.name, size: st.size, modifiedAt: Math.floor(st.mtimeMs) };
      } catch {
        return out;
      }
    });
  }

  async listAgentFiles(id) {
    await this._connect();
    const fr = await this.request("agents.files.list", { agentId: id }, 12000);
    return this._withLinkedFileStats(fr?.workspace, Array.isArray(fr?.files) ? fr.files : []);
  }

  async getAgentFile(id, file) {
    await this._connect();
    try {
      const r = await this.request("agents.files.get", { agentId: id, name: file }, 12000);
      return { name: file, content: r?.file?.content ?? "", missing: r?.file?.missing === true };
    } catch (err) {
      const real = await this._resolveLinkedWorkspaceFile(id, file);
      if (!real) throw err;
      return { name: file, content: await fs.promises.readFile(real, "utf8"), missing: false };
    }
  }

  async setAgentFile(id, file, content) {
    await this._connect();
    try {
      await this.request("agents.files.set", { agentId: id, name: file, content }, 15000);
      return { ok: true };
    } catch (err) {
      const real = await this._resolveLinkedWorkspaceFile(id, file);
      if (!real) throw err;
      await fs.promises.writeFile(real, content, "utf8"); // 跟随链接写目标，链接本身不动
      return { ok: true };
    }
  }

  async getAgentChannels() {
    try {
      await this._connect();
      const r = await this.request("channels.status", {}, 12000);
      const list = Array.isArray(r?.channels) ? r.channels : Array.isArray(r) ? r : [];
      return list.map((c) => ({
        id: String(c.id ?? c.channel ?? c.type ?? ""),
        type: c.type || c.channel || undefined,
        status: c.status || (c.connected ? "connected" : undefined),
        label: c.label || c.name || undefined,
      }));
    } catch {
      return [];
    }
  }

  // ---- archived session history (local on-disk reset/rotation chain) ----

  // The .reset archive lives on the gateway HOST's disk; only readable when the
  // gateway is this machine (loopback). A remote gateway → not supported.
  _isLocalGateway() {
    return isLoopbackGatewayUrl((this._getUpstreamUrl() || "").trim() || DEFAULT_GATEWAY_URL);
  }

  async getSessionArchive(agentId, sessionKey) {
    if (!this._isLocalGateway()) return { supported: false, reason: "remote", segments: [] };
    if (!agentId || !sessionKey) return { supported: true, segments: [] };
    const dir = resolveOpenClawSessionsDir(agentId);
    let entry;
    try {
      const store = JSON.parse(fs.readFileSync(path.join(dir, "sessions.json"), "utf8"));
      entry = store && store[sessionKey];
    } catch {
      return { supported: true, segments: [] }; // no local store / unreadable → nothing to add
    }
    if (!entry) return { supported: true, segments: [] };
    const current = entry.sessionId;
    // usageFamilySessionIds is the ordered (oldest→newest) chain of physical
    // sessions that have served this logical key; the last is the live one.
    const chain = Array.isArray(entry.usageFamilySessionIds) ? entry.usageFamilySessionIds : [];
    const priorIds = chain.filter((id) => id && id !== current);
    if (priorIds.length === 0) return { supported: true, segments: [] };

    let files;
    try { files = fs.readdirSync(dir); } catch { return { supported: true, segments: [] }; }
    const segments = [];
    for (const id of priorIds) {
      // Transcript 优先沿当前 sessionFile 的后缀查找，再兼容老的裸 UUID 文件名。
      const resolved = findArchiveTranscriptFile(files, archiveTranscriptStemCandidates(entry, id));
      if (!resolved) continue; // transcript gone (deleted/compacted away) → skip
      const { file, fromReset } = resolved;
      let sealedAt = null;
      if (fromReset) {
        // suffix e.g. "2026-06-04T02-14-22.951Z" — un-mangle the time colons to parse
        const marker = ".jsonl.reset.";
        const iso = file.slice(file.indexOf(marker) + marker.length).replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3");
        const t = Date.parse(iso);
        sealedAt = Number.isFinite(t) ? t : null;
      }
      const full = path.join(dir, file);
      if (sealedAt == null) {
        try { sealedAt = fs.statSync(full).mtimeMs; } catch { /* leave null */ }
      }
      let raw;
      try { raw = fs.readFileSync(full, "utf8"); } catch { continue; }
      const msgs = [];
      for (const line of raw.split("\n")) {
        if (!line) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (rec.type !== "message") continue;
        const m = rec.message && typeof rec.message === "object" ? rec.message : rec;
        const role = m.role;
        // Keep only roles the client's normalize() renders cleanly (a bare "tool"
        // role would fall through to a user bubble); tool activity lives inside
        // assistant content parts anyway.
        if (role !== "user" && role !== "assistant" && role !== "system" && role !== "toolResult") continue;
        // Mirror chat.history's per-message shape so the client's normalize() renders
        // these identically (thinking cards, footers, error bubbles).
        msgs.push({
          id: rec.id || m.id,
          role,
          content: m.content,
          timestamp: rec.timestamp || m.timestamp || null,
          model: m.model,
          usage: m.usage,
          stopReason: m.stopReason,
          errorMessage: m.errorMessage,
        });
      }
      if (msgs.length === 0) continue;
      const truncated = msgs.length > ARCHIVE_MAX_PER_SEGMENT;
      segments.push({
        sessionId: id,
        sealedAt,
        fromReset,
        truncated,
        messages: truncated ? msgs.slice(-ARCHIVE_MAX_PER_SEGMENT) : msgs,
      });
    }
    return { supported: true, segments };
  }

  // ---- cross-session chat search (Gateway-owned index) ----

  // OpenClaw 2026.8.1 owns active transcript storage and its search index. Do
  // not read sessions.json/JSONL here: that silently diverges for remote hosts
  // and for the 8.1 SQLite store. The explicit sessionKeys keep the query in
  // the selected agent's visible scope (the Gateway requires them with an
  // agentId when that agent uses a configured store). The 8.1 schema caps each
  // search at 200 session keys and 25 results, so larger rosters are split into
  // bounded requests and merged locally.
  async searchChat(agentId, query, opts = {}) {
    const q = String(query || "").trim().slice(0, 4096);
    if (!agentId || !q) return { supported: true, results: [] };
    const limit = Number(opts.limit) > 0 ? Math.min(Math.floor(Number(opts.limit)), 25) : 25;
    await this._connect();
    const listed = await this.request("sessions.list", {
      agentId: String(agentId),
      configuredAgentsOnly: true,
      limit: 500,
    }, 15000);
    const sessionKeys = [...new Set((Array.isArray(listed?.sessions) ? listed.sessions : [])
      .map((entry) => (typeof entry?.key === "string" ? entry.key.trim() : ""))
      .filter(Boolean))];
    if (!sessionKeys.length) return { supported: true, results: [] };
    const chunks = [];
    for (let offset = 0; offset < sessionKeys.length; offset += 200) {
      chunks.push(sessionKeys.slice(offset, offset + 200));
    }
    const responses = await Promise.all(chunks.map((keys) => this.request("sessions.search", {
      agentId: String(agentId),
      sessionKeys: keys,
      query: q,
      limit,
    }, 20000)));
    const rawResults = responses.flatMap((response) => Array.isArray(response?.results) ? response.results : []);
    const results = rawResults.map((hit) => ({
      key: String(hit?.sessionKey || ""),
      sessionId: typeof hit?.sessionId === "string" ? hit.sessionId : undefined,
      messageId: typeof hit?.messageId === "string" ? hit.messageId : undefined,
      role: hit?.role === "assistant" ? "assistant" : "user",
      ts: Number.isFinite(hit?.timestamp) ? hit.timestamp : null,
      snippet: String(hit?.snippet || ""),
      score: Number.isFinite(hit?.score) ? hit.score : undefined,
    })).sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || (b.ts ?? 0) - (a.ts ?? 0));
    return {
      supported: true,
      ...(responses.some((response) => response?.indexing === true) ? { indexing: true } : {}),
      ...(responses.some((response) => response?.truncated === true) || results.length > limit ? { truncated: true } : {}),
      results: results.slice(0, limit),
    };
  }

  // ---- usage top-session preview (Gateway projection) ----

  // 8.1 `sessions.preview` deliberately returns a short, sanitized projection;
  // it is not a paginated transcript API. Expose that bounded result as one
  // page instead of pretending local files are the authoritative live store.
  async getSessionPreview(agentId, sessionKey, opts = {}) {
    if (!agentId || !sessionKey) return { supported: false, reason: "error", messages: [] };
    const limit = Math.min(Math.max(Number(opts?.limit) || 100, 1), 200);
    await this._connect();
    const response = await this.request("sessions.preview", {
      keys: [String(sessionKey)],
      limit,
      maxChars: 2000,
    }, 15000);
    const preview = (Array.isArray(response?.previews) ? response.previews : [])
      .find((entry) => String(entry?.key || "") === String(sessionKey));
    if (!preview || preview.status === "missing") {
      return { supported: true, reason: "not-found", messages: [], totalMessages: 0, offset: 0, truncated: false };
    }
    if (preview.status === "error") {
      return { supported: true, reason: "error", messages: [], totalMessages: 0, offset: 0, truncated: false };
    }
    const messages = (Array.isArray(preview.items) ? preview.items : [])
      .filter((item) => item?.role === "user" || item?.role === "assistant")
      .map((item) => ({ role: item.role, text: String(item?.text || "") }))
      .filter((item) => item.text);
    const title = messages.find((item) => item.role === "user")?.text.replace(/\s+/g, " ").slice(0, 140);
    return {
      supported: true,
      ...(title ? { title } : {}),
      totalMessages: messages.length,
      offset: 0,
      truncated: false,
      messages,
    };
  }

  // ---- status (management UI / 设置) ----

  async getStatus() {
    const info = {
      gatewayUrl: (this._getUpstreamUrl() || "").trim() || DEFAULT_GATEWAY_URL,
      hasIdentity: !!this._loadAuth(), // existence only — never expose key/token
    };
    let connected = false;
    try {
      await this._connect();
      connected = true;
    } catch (err) {
      info.error = err?.message || String(err);
      info.reason = classifyAuthError(err); // 结构化原因,S2 首启梯子/设置页共用
      return { id: this.id, name: this.name, connected, info };
    }
    if (this._gatewayVersion) info.version = this._gatewayVersion;
    try {
      const s = await this.request("cron.status", {}, 8000);
      if (s && typeof s.jobs === "number") info.cronJobs = s.jobs;
    } catch {
      /* best-effort */
    }
    try {
      const a = await this.request("agents.list", {}, 8000);
      if (Array.isArray(a?.agents)) info.agents = a.agents.length;
    } catch {
      /* best-effort */
    }
    return { id: this.id, name: this.name, connected, info };
  }

  // 版本检查只关心 gateway 运行版本；失败时保留错误并让前端降级展示。
  async getVersionInfo() {
    try {
      await this._connect();
      return {
        id: this.id,
        name: this.name,
        current: this._gatewayVersion || undefined,
        currentSource: "gateway",
      };
    } catch (err) {
      return {
        id: this.id,
        name: this.name,
        current: this._gatewayVersion || undefined,
        currentSource: "gateway",
        error: err?.message || String(err),
      };
    }
  }

  // ---- self-update（设置页「立即更新」，契约见 agent-backend.js）----
  // `openclaw update` 只能更新本机安装；gateway 配置指向别的机器时更新不到
  // 远端，明确返回不支持（reason 机器码，前端映射文案）。
  _selfUpdateGate() {
    const url = (this._getUpstreamUrl() || DEFAULT_GATEWAY_URL).trim();
    try {
      new URL(url);
      // 复用连接层的 loopback 口径，包含 Node 可能保留方括号的 IPv6 hostname。
      if (!isLoopbackGatewayUrl(url)) return { supported: false, reason: "remote" };
    } catch {
      /* 非法 URL 时按本机对待，让 update 自己报错 */
    }
    return null;
  }

  runSelfUpdate(options = {}) {
    const gate = this._selfUpdateGate();
    if (gate) return gate;
    return {
      supported: true,
      actions: ["update", "repair"],
      status: this._selfUpdater.run({
        operation: options.action || "update",
        acceptCapabilities: options.acceptCapabilities === true,
      }),
    };
  }

  getSelfUpdateStatus() {
    return this._selfUpdateGate() || {
      supported: true,
      actions: ["update", "repair"],
      status: this._selfUpdater.status(),
    };
  }

  async listStandingGrants({ limit = 100 } = {}) {
    await this._connect();
    if (!this.hasGatewayMethod("exec.approval.grants.list")) {
      return { supported: false, reason: "gateway-method-unavailable", grants: [] };
    }
    const response = await this.request("exec.approval.grants.list", {
      limit: Math.min(Math.max(Math.floor(Number(limit) || 100), 1), 500),
    }, 12000);
    const grants = (Array.isArray(response?.grants) ? response.grants : [])
      .map((grant) => projectStandingGrantForBrowser(grant, this.id))
      .filter((grant) => grant.grantId);
    return { supported: true, grants };
  }

  async revokeStandingGrant(grantId) {
    await this._connect();
    if (!this.hasGatewayMethod("exec.approval.grants.revoke")) {
      const error = new Error("openclaw: standing grant revoke unavailable");
      error.code = "gateway_method_unavailable";
      throw error;
    }
    const response = await this.request(
      "exec.approval.grants.revoke",
      { grantId: String(grantId || "") },
      12000,
    );
    const projected = projectStandingGrantRevokeResult(response);
    if (!projected.outcome) {
      const error = new Error("openclaw: standing grant revoke returned an invalid response");
      error.code = "invalid_gateway_response";
      throw error;
    }
    return projected;
  }

  // Probe a candidate gateway URL without disturbing the live connection. Uses a
  // throwaway instance so the full device-auth handshake is exercised; a remote
  // gateway that doesn't trust this device's identity surfaces as ok:false.
  async testConnection(spec = {}) {
    const url = (spec.gatewayUrl || this._getUpstreamUrl() || "").trim();
    if (!url) return { ok: false, error: "未配置网关 URL" };
    const probe = new OpenClawBackend({ getUpstreamUrl: () => url, getOrigin: this._getOrigin, authResolver: this._authResolver });
    try {
      await probe._connect();
      const info = { gatewayUrl: url };
      try {
        const s = await probe.request("cron.status", {}, 6000);
        if (s && typeof s.jobs === "number") info.cronJobs = s.jobs;
      } catch {
        /* liveness best-effort */
      }
      await probe.stop();
      return { ok: true, info };
    } catch (err) {
      try {
        await probe.stop();
      } catch {
        /* ignore */
      }
      return { ok: false, error: err?.message || String(err), reason: classifyAuthError(err) };
    }
  }
}

// Wrapper commands that merely prefix the real command — skip to find the tool.
const CLI_COMMAND_WRAPPERS = new Set([
  "sudo", "doas", "env", "time", "nice", "nohup", "xargs", "command", "builtin", "exec", "then", "do",
]);

// `/bin/zsh -lc '<inner>'`, `bash -c "<inner>"`, `sh -ic <inner>` → <inner>;
// trajectory tool.call commands run through a login shell, so the literal first
// token is the shell, not the real command. Unwrap (one level) before parsing.
function unwrapShellCommand(text) {
  const m = String(text).match(
    /^\s*(?:[^\s'"]*\/)?(?:zsh|bash|sh|dash|ksh)\s+-[a-z]*c\s+(['"])([\s\S]*)\1\s*$/,
  );
  return m ? m[2] : null;
}

// Extract invoked command names from one shell command string, best-effort.
// Splits on shell separators (| || && ; newline), strips `VAR=val` assignment
// prefixes and wrapper commands (sudo/env/...), then takes each segment's
// leading token's basename. Returns names WITH duplicates so callers can count.
// NOT filtered by $PATH — the CLI page joins these against the host scan.
function parseCliCommandNames(commandStr) {
  let text = String(commandStr || "");
  const inner = unwrapShellCommand(text);
  if (inner !== null) text = inner;
  if (!text.trim()) return [];
  const names = [];
  for (const segment of text.split(/\|\||&&|[;|\n]/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length) {
      const tok = tokens[i];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) { i++; continue; } // VAR=val
      if (CLI_COMMAND_WRAPPERS.has(tok.replace(/^.*\//, ""))) { i++; continue; }
      break;
    }
    if (i >= tokens.length) continue;
    const first = tokens[i];
    if (first.startsWith("(") || first.startsWith("$") || first.startsWith("{") || first.startsWith("-")) continue;
    const name = first.replace(/^.*\//, ""); // /usr/bin/git -> git
    if (name) names.push(name);
  }
  return names;
}

// Tool names whose `command` argument is a host CLI invocation (vs. agent-internal
// tools like web_search/read/message, which never touch $PATH). Spec §四.
const CLI_TOOL_NAMES = new Set(["bash", "exec", "process", "shell"]);

// Pull host-CLI tool calls out of ONE parsed JSONL line, as { id, command }
// (the id lets the caller de-dupe — see _scanCliUsage). Handles all three shapes:
//  · plain transcript:  { message:{ content:[ { type:"toolCall", id, name, arguments:{ command } } ] } }
//  · trajectory:        { type:"model.completed"|"context.compiled",
//                         data:{ messagesSnapshot|messages: [ { content:[ {type:"toolCall",…} ] } ] } }
//  · legacy `tool.call` event ({ type:"tool.call", data:{ name, arguments } }) — kept for back-compat.
// NOTE: the trajectory carries the WHOLE conversation in every snapshot, so one
// call recurs across lines; de-dupe by id before counting.
function extractCliCommandsFromLine(o) {
  const out = [];
  if (!o || typeof o !== "object") return out;
  const pushFromContent = (content) => {
    if (!Array.isArray(content)) return;
    for (const p of content) {
      if (!p || p.type !== "toolCall") continue;
      // toolCalls carry a `name` too (e.g. "exec"); require a CLI tool when
      // present, but still count a bare command string if name is absent (back-compat).
      if (p.name && !CLI_TOOL_NAMES.has(p.name)) continue;
      if (p.arguments && typeof p.arguments.command === "string") {
        out.push({ id: typeof p.id === "string" ? p.id : null, command: p.arguments.command });
      }
    }
  };
  if (o.type === "tool.call") {
    const d = o.data;
    if (d && CLI_TOOL_NAMES.has(d.name) && d.arguments && typeof d.arguments.command === "string") {
      out.push({ id: typeof d.id === "string" ? d.id : null, command: d.arguments.command });
    }
    return out;
  }
  // `o.message || o`: plain transcript wraps content under `message`; the bare
  // `o` fallback tolerates the legacy top-level-`content` shape.
  pushFromContent((o.message || o).content);
  const data = o.data;
  if (data && typeof data === "object") {
    for (const key of ["messagesSnapshot", "messages"]) {
      const arr = data[key];
      if (!Array.isArray(arr)) continue;
      for (const m of arr) pushFromContent(m && m.content);
    }
  }
  return out;
}

// A skill "load" is the agent reading the skill card into context. Only the file
// READER counts: `exec` also shows up with SKILL.md in its command (cp/ls while
// editing a skill) and that is authoring, not using.
const SKILL_READ_TOOL_NAMES = new Set(["read"]);
// `<anything>skills/<dir>/SKILL.md` — substring, so `plugin-skills/x/SKILL.md`
// matches too (it IS a skill root), while a loose `/tmp/foo/SKILL.md` does not.
const SKILL_MD_PATH_RE = /skills\/[^/\s"]+\/SKILL\.md$/;
// 上游只认 `path`（dist/agent-tools.before-tool-call 的 readToolPathCandidates），
// 但实测本机 3562 次 read 里有 56 次模型传的是 `file_path`（1 次 `file`）——文件照样
// 被读了，只是官方那个 skill.used 埋点漏掉了。我们把三个键都认，比上游更全。
const SKILL_READ_PATH_KEYS = ["path", "file_path", "file"];

// Pull skill-card reads out of ONE parsed JSONL line, as { id, path }. Mirrors
// extractCliCommandsFromLine's shape handling (plain transcript / trajectory
// snapshot / legacy tool.call event) — see its comment for the three layouts.
function extractSkillLoadsFromLine(o) {
  const out = [];
  if (!o || typeof o !== "object") return out;
  const push = (id, args) => {
    if (!args || typeof args !== "object") return;
    for (const key of SKILL_READ_PATH_KEYS) {
      const p = typeof args[key] === "string" ? args[key].trim() : "";
      if (p && SKILL_MD_PATH_RE.test(p)) {
        out.push({ id: typeof id === "string" ? id : null, path: p });
        return; // 同一次调用里 path/file_path 可能并存且同值，只记一次
      }
    }
  };
  const pushFromContent = (content) => {
    if (!Array.isArray(content)) return;
    for (const c of content) {
      if (!c || c.type !== "toolCall") continue;
      if (!SKILL_READ_TOOL_NAMES.has(c.name)) continue;
      push(c.id, c.arguments);
    }
  };
  if (o.type === "tool.call") {
    const d = o.data;
    if (d && SKILL_READ_TOOL_NAMES.has(d.name)) push(d.id, d.arguments);
    return out;
  }
  pushFromContent((o.message || o).content);
  const data = o.data;
  if (data && typeof data === "object") {
    for (const key of ["messagesSnapshot", "messages"]) {
      const arr = data[key];
      if (!Array.isArray(arr)) continue;
      for (const m of arr) pushFromContent(m && m.content);
    }
  }
  return out;
}

// Group raw session filenames by <agentId>/<uuid>, keeping ONE file per session
// and preferring the plain transcript when both formats exist. Both record the
// same toolCalls, but the transcript is append-only (one entry per call) while
// the trajectory repeats the whole conversation in every snapshot and is an
// order of magnitude larger — so plain is both cheaper and duplicate-free.
// The trajectory is still used for sessions that have no transcript.
// Input rows: { agentId, name, mtime }. Drops non-.jsonl entries.
// 「退役」转录：网关自愈会把冲突的转录改名成 `<uuid>.jsonl.reset.<ts>` 后另起一份
// （见 ARCHITECTURE §9 的角色顺序自愈），用户删会话则留下 `<uuid>.jsonl.deleted.<ts>`。
// 两者都是**真实发生过**的历史，只是不再是活动会话——按 `.jsonl` 后缀筛会整批漏掉
// （本机 1349 个）。**刻意不含 `.bak`**：那是同一份转录的副本，算进来等于把每次
// 工具调用数两遍。
//
// 同一会话可以被 reset 多次，各「代」内容互不相同、不能相互去重；而同一代的
// plain / trajectory 两种格式仍是同一份内容、必须去重。所以把退役后缀编进合成
// 文件名（`<uuid>__reset.<ts>[.trajectory].jsonl`），再交给 dedupeSessionFiles ——
// 它按「代」分组，代内照旧 plain 优先。
const RETIRED_SESSION_RE = /^(.+?)(\.trajectory)?\.jsonl\.((?:deleted|reset)\..+)$/;

function retiredSessionSyntheticName(name) {
  const m = RETIRED_SESSION_RE.exec(name);
  if (!m) return null;
  return `${m[1]}__${m[3]}${m[2] || ""}.jsonl`;
}

function dedupeSessionFiles(files) {
  const byKey = new Map();
  for (const f of files) {
    if (!f || typeof f.name !== "string" || !f.name.endsWith(".jsonl")) continue;
    const isTraj = f.name.endsWith(".trajectory.jsonl");
    const uuid = isTraj
      ? f.name.slice(0, -".trajectory.jsonl".length)
      : f.name.slice(0, -".jsonl".length);
    const kind = isTraj ? "trajectory" : "plain";
    // separator can't occur in an agentId dir name or a uuid filename
    const key = `${f.agentId}\0${uuid}`;
    const prev = byKey.get(key);
    if (!prev || (kind === "plain" && prev.kind !== "plain")) {
      byKey.set(key, { agentId: f.agentId, uuid, name: f.name, kind, mtime: f.mtime });
    }
  }
  return [...byKey.values()];
}

module.exports = {
  OpenClawBackend,
  normalizeOpenClawCronJob,
  parseCliCommandNames,
  extractCliCommandsFromLine,
  extractSkillLoadsFromLine,
  retiredSessionSyntheticName,
  dedupeSessionFiles,
  archiveTranscriptStemCandidates,
  findArchiveTranscriptFile,
  resolveOpenClawHome,
  normalizeOpenClawAgentId,
  defaultOpenClawAgentWorkspace,
  OPENCLAW_CREATE_EMOJIS,
  resolveOpenClawSessionsDir,
  isLoopbackGatewayUrl,
  normalizeCanvasWidgetResourcePath,
  gatewayHttpResourceUrl,
  resolveOpenclawBin,
  readGatewayFailureReason,
};
