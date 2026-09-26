"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const {
  FEDERATION_MAX_FRAME_BYTES,
  FEDERATION_PROTOCOL_VERSION,
  isPublicExternalInspirationError,
  validateFederationParams,
  validateFederationResult,
} = require("./federation-host-protocol");
const { EXTERNAL_INSPIRATION_METHODS } = require("./external-inspiration-protocol");
const { atomicWritePrivateFile } = require("./agent-service/private-file");
const {
  ensurePrivateDirectoryTree,
  rejectSymlink,
  serviceError,
} = require("./agent-service/security");

const MAX_OPERATIONS = 1024;
const PUBLIC_ERROR_CODES = new Set([
  "APP_HOST_INVALID_REQUEST", "APP_HOST_UNAVAILABLE", "BACKEND_UNAVAILABLE",
  "AGENT_NOT_FOUND", "AGENT_OPERATION_FAILED", "AGENT_RUN_TIMEOUT",
  "FEDERATION_OPERATION_CONFLICT", "FEDERATION_RESPONSE_INVALID",
  "FEDERATION_TASK_NOT_FOUND", "FEDERATION_TASK_STATE_CONFLICT",
  "FEDERATION_COMMIT_UNCERTAIN",
]);

function exactObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function hostError(code) {
  return serviceError(PUBLIC_ERROR_CODES.has(code) ? code : "AGENT_OPERATION_FAILED", code);
}

function sameToken(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  try { return a.length === b.length && crypto.timingSafeEqual(a, b); } finally {
    a.fill(0); b.fill(0);
  }
}

function text(value, maxBytes = 512, nullable = false) {
  if (nullable && value == null) return null;
  if (typeof value !== "string" || !value.isWellFormed() || value.includes("\0")) return null;
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  for (let end = maxBytes; end >= Math.max(0, maxBytes - 3); end -= 1) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)); } catch {}
  }
  return "";
}

function finite(value, fallback = null) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function publicStatus(value) {
  const id = value?.id;
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id)) {
    throw hostError("FEDERATION_RESPONSE_INVALID");
  }
  const disabled = value?.disabled === true;
  const connected = value?.connected === true && !disabled;
  const info = value?.info && typeof value.info === "object" ? value.info : {};
  const profileRows = Array.isArray(info.profiles) ? info.profiles : [];
  return {
    id,
    name: text(value.name, 256) || id,
    connected,
    disabled,
    health: disabled ? "disabled" : connected ? "connected" : "disconnected",
    version: text(info.version ?? value.version, 128, true),
    agentCount: Number.isSafeInteger(info.agentCount) && info.agentCount >= 0 ? info.agentCount : null,
    profiles: profileRows.slice(0, 64).map((row) => ({
      id: text(row?.id ?? row?.profile ?? row?.name, 128) || "unknown",
      connected: row?.connected === true || row?.healthy === true,
      model: text(row?.model, 512, true),
      provider: text(row?.provider, 256, true),
    })),
  };
}

function publicFile(value) {
  const name = text(value?.name, 256);
  if (!name) throw hostError("FEDERATION_RESPONSE_INVALID");
  return {
    name,
    size: Number.isSafeInteger(value?.size) && value.size >= 0 ? value.size : null,
    modifiedAt: Number.isSafeInteger(value?.modifiedAt) && value.modifiedAt >= 0
      ? value.modifiedAt : null,
  };
}

function publicAgent(value, backendId, detail = false) {
  const id = text(value?.id, 128);
  if (!id) throw hostError("FEDERATION_RESPONSE_INVALID");
  const out = {
    id,
    name: text(value?.name, 256) || id,
    backendId,
    model: text(value?.model, 512, true),
    provider: text(value?.provider, 256, true),
    isDefault: value?.isDefault === true,
  };
  if (detail) {
    out.workspace = text(value?.workspace, 4096, true);
    out.profile = text(value?.profile, 128, true);
    out.emoji = text(value?.emoji, 32, true);
    out.fallbacks = Array.isArray(value?.fallbacks)
      ? value.fallbacks.slice(0, 16).map((item) => text(item, 512)).filter(Boolean)
      : [];
    out.files = Array.isArray(value?.files) ? value.files.slice(0, 128).map(publicFile) : [];
  }
  return out;
}

function publicChannel(value) {
  return {
    id: text(value?.id, 128) || "unknown",
    type: text(value?.type, 128, true),
    status: text(value?.status, 128, true),
    label: text(value?.label, 256, true),
  };
}

function publicArtifact(value) {
  return {
    path: text(value?.path, 4096, true),
    name: text(value?.name, 512) || "artifact",
    area: text(value?.area, 256, true),
    size: Number.isSafeInteger(value?.size) && value.size >= 0 ? value.size : null,
    mtimeMs: finite(value?.mtimeMs),
    ext: text(value?.ext, 64, true),
    kind: text(value?.kind, 128, true),
  };
}

function cronScheduleDisplay(value) {
  const explicit = text(value?.scheduleDisplay, 512, true);
  if (explicit !== null) return explicit;
  const schedule = value?.schedule && typeof value.schedule === "object" ? value.schedule : null;
  if (schedule?.kind === "cron") return text(schedule.expr, 512, true);
  if (schedule?.kind === "every" && Number.isSafeInteger(schedule.everyMs)
    && schedule.everyMs > 0) return `every ${schedule.everyMs}ms`;
  if (schedule?.kind === "at") {
    const at = typeof schedule.at === "number" ? String(schedule.at) : schedule.at;
    const safeAt = text(at, 256, true);
    return safeAt === null ? null : `at ${safeAt}`;
  }
  return null;
}

function publicCronJob(value, backendId) {
  const id = text(value?.id, 256);
  if (!id) throw hostError("FEDERATION_RESPONSE_INVALID");
  const lastStatus = text(value?.lastStatus, 128, true);
  const errorStatus = typeof lastStatus === "string"
    && /^(?:error|failed|failure|exhausted)$/iu.test(lastStatus.trim());
  return {
    id,
    backendId,
    agentId: text(value?.agentId, 128, true),
    name: text(value?.name, 256) || id,
    description: text(value?.description, 1024, true),
    scheduleDisplay: cronScheduleDisplay(value),
    enabled: value?.enabled !== false,
    state: text(value?.state, 128, true),
    stateLabel: text(value?.stateLabel, 256, true),
    createdAt: Number.isSafeInteger(value?.createdAt) && value.createdAt >= 0 ? value.createdAt : null,
    lastRunAt: Number.isSafeInteger(value?.lastRunAt) && value.lastRunAt >= 0 ? value.lastRunAt : null,
    lastStatus,
    nextRunAt: Number.isSafeInteger(value?.nextRunAt) && value.nextRunAt >= 0 ? value.nextRunAt : null,
    model: text(value?.model, 512, true),
    provider: text(value?.provider, 256, true),
    hasError: errorStatus || (typeof value?.lastError === "string" && value.lastError.length > 0),
  };
}

function operationFingerprint(method, params) {
  return crypto.createHash("sha256").update(JSON.stringify([method, params])).digest("hex");
}

async function terminalRun(backend, agentId, prompt, timeoutMs) {
  const sessionKey = await backend.createSession(agentId);
  if (typeof sessionKey !== "string" || !sessionKey) throw hostError("AGENT_OPERATION_FAILED");
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, output) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve({ sessionKey, text: text(output ?? "", 32 * 1024, true) || "" });
    };
    const timer = setTimeout(() => finish(hostError("AGENT_RUN_TIMEOUT")), timeoutMs);
    const hooks = {
      final: (output, errored) => finish(errored ? hostError("AGENT_OPERATION_FAILED") : null, output),
      error: () => finish(hostError("AGENT_OPERATION_FAILED")),
    };
    Promise.resolve(backend.sendMessage(sessionKey, prompt, undefined, hooks, {}))
      .catch(() => finish(hostError("AGENT_OPERATION_FAILED")));
  });
}

function createFederationHostServer(options = {}) {
  if (!options.paths?.runtimeDir || !options.paths?.trustedRoot
    || !options.paths?.federationSocketPath || !options.paths?.federationTokenPath
    || !options.registry || typeof options.registry.getStatus !== "function"
    || typeof options.registry.getBackend !== "function"
    || (options.delegateRun !== undefined && typeof options.delegateRun !== "function")
    || (options.taskRunner !== undefined && (!options.taskRunner
      || ["run", "message", "get", "cancel"].some(
        (method) => typeof options.taskRunner[method] !== "function",
      )))
    || (options.inspirationRunner !== undefined && (!options.inspirationRunner
      || ["prepare", "start", "get", "respond", "cancel", "reset"].some(
        (method) => typeof options.inspirationRunner[method] !== "function",
      )))) {
    throw new TypeError("Federation Host 配置无效");
  }
  const paths = options.paths;
  const registry = options.registry;
  const delegateRun = options.delegateRun || null;
  const taskRunner = options.taskRunner || null;
  const inspirationRunner = options.inspirationRunner || null;
  const sockets = new Set();
  const operations = new Map();
  let server = null;
  let token = null;
  let socketIdentity = null;
  let tokenIdentity = null;

  const statuses = async () => {
    const rows = await registry.getStatus();
    const byId = new Map((Array.isArray(rows) ? rows : []).map((row) => [row?.id, row]));
    const ids = new Set(["openclaw", "hermes", ...byId.keys()].filter((id) => (
      typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id)
    )));
    return [...ids].map((id) => publicStatus(
      byId.get(id) || { id, name: id, connected: false, info: {} },
    ));
  };

  const requireBackend = async (backendId) => {
    const row = (await statuses()).find((item) => item.id === backendId);
    const backend = registry.getBackend(backendId);
    if (!row || row.disabled || !row.connected || !backend) throw hostError("BACKEND_UNAVAILABLE");
    return { row, backend };
  };

  const getAgent = async (backend, backendId, agentId) => {
    let value;
    try { value = await backend.getAgent(agentId); } catch { throw hostError("AGENT_NOT_FOUND"); }
    const agent = publicAgent(value, backendId, true);
    if (agent.id !== agentId) throw hostError("FEDERATION_RESPONSE_INVALID");
    return agent;
  };

  const resolveCreatedAgent = async (backend, backendId, spec, raw) => {
    const directId = text(raw?.id ?? raw?.agentId ?? raw?.result?.id, 128, true);
    if (directId) return getAgent(backend, backendId, directId);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, attempt * 100));
      const rows = await backend.listAgents();
      const matches = (Array.isArray(rows) ? rows : []).filter((row) => row?.name === spec.name);
      if (matches.length === 1) return getAgent(backend, backendId, String(matches[0].id));
    }
    throw hostError("FEDERATION_RESPONSE_INVALID");
  };

  const perform = async (method, params) => {
    if (method === "inspiration.executor.ready") {
      return registry.getInspirationExecutorReadiness(params);
    }
    if (EXTERNAL_INSPIRATION_METHODS.includes(method)) {
      if (!inspirationRunner) throw hostError("APP_HOST_UNAVAILABLE");
      return inspirationRunner[method.split(".").at(-1)](params);
    }
    if (method === "backend.status") return { backends: await statuses() };
    if (method === "backend.require") {
      const { row } = await requireBackend(params.backendId);
      return { backend: row };
    }
    if (method === "federation.task.get" || method === "federation.task.cancel") {
      if (!taskRunner) throw hostError("APP_HOST_UNAVAILABLE");
      const task = method === "federation.task.get"
        ? taskRunner.get(params) : await taskRunner.cancel(params);
      return { task };
    }
    const { backend } = await requireBackend(params.backendId);
    if (method === "federation.run" || method === "federation.message") {
      if (!taskRunner) throw hostError("APP_HOST_UNAVAILABLE");
      const task = method === "federation.run"
        ? await taskRunner.run(params) : await taskRunner.message(params);
      return { task };
    }
    if (method === "cron.list") {
      if (typeof backend.getCronJobs !== "function") throw hostError("BACKEND_UNAVAILABLE");
      const rows = await backend.getCronJobs();
      if (!Array.isArray(rows)) throw hostError("FEDERATION_RESPONSE_INVALID");
      const jobs = rows.map((row) => publicCronJob(row, params.backendId))
        .filter((job) => params.enabled === null || job.enabled === params.enabled)
        .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
      return {
        backendId: params.backendId,
        total: jobs.length,
        jobs: jobs.slice(0, params.limit),
      };
    }
    if (method === "agent.list") {
      const rows = await backend.listAgents();
      return {
        backendId: params.backendId,
        agents: (Array.isArray(rows) ? rows : []).slice(0, 128)
          .map((row) => publicAgent(row, params.backendId, false)),
      };
    }
    if (method === "agent.get") {
      return { agent: await getAgent(backend, params.backendId, params.agentId) };
    }
    if (method === "agent.file.list") {
      const rows = await backend.listAgentFiles(params.agentId);
      return { files: (Array.isArray(rows) ? rows : []).slice(0, 128).map(publicFile) };
    }
    if (method === "agent.file.read") {
      const value = await backend.getAgentFile(params.agentId, params.file);
      return { file: {
        name: text(value?.name, 256) || params.file,
        content: text(value?.content, 32 * 1024, true) || "",
        missing: value?.missing === true,
      } };
    }
    if (method === "agent.channels") {
      const rows = await backend.getAgentChannels(params.agentId);
      return { channels: (Array.isArray(rows) ? rows : []).slice(0, 128).map(publicChannel) };
    }
    if (method === "agent.artifacts") {
      const value = await backend.listAgentArtifacts(params.agentId, { limit: params.limit });
      return { artifacts: {
        supported: value?.supported === true,
        reason: text(value?.reason, 128, true),
        total: Number.isSafeInteger(value?.total) && value.total >= 0 ? value.total : null,
        items: (Array.isArray(value?.items) ? value.items : []).slice(0, params.limit).map(publicArtifact),
      } };
    }
    if (method === "agent.create") {
      const raw = await backend.createAgent(params.spec);
      return { agent: await resolveCreatedAgent(backend, params.backendId, params.spec, raw) };
    }
    if (method === "agent.update") {
      const raw = await backend.updateAgent(params.agentId, params.patch);
      const nextId = text(raw?.id, 128, true) || params.agentId;
      return { agent: await getAgent(backend, params.backendId, nextId) };
    }
    if (method === "agent.delete") {
      await backend.deleteAgent(params.agentId, { trash: true });
      return { backendId: params.backendId, agentId: params.agentId, deleted: true };
    }
    if (method === "agent.file.write") {
      await backend.setAgentFile(params.agentId, params.file, params.content);
      const value = await backend.getAgentFile(params.agentId, params.file);
      return { file: {
        name: text(value?.name, 256) || params.file,
        content: text(value?.content, 32 * 1024, true) || "",
        missing: value?.missing === true,
      } };
    }
    if (method === "agent.run") {
      const terminal = delegateRun
        ? await delegateRun({ backend, backendId: params.backendId, agentId: params.agentId,
          prompt: params.prompt, timeoutMs: params.timeoutMs, operationId: params.operationId })
        : await terminalRun(backend, params.agentId, params.prompt, params.timeoutMs);
      return {
        backendId: params.backendId,
        agentId: params.agentId,
        sessionKey: text(terminal?.sessionKey, 512) || "unknown",
        text: text(terminal?.text, 32 * 1024, true) || "",
      };
    }
    throw hostError("APP_HOST_INVALID_REQUEST");
  };

  const route = async (method, params) => {
    if (!Object.prototype.hasOwnProperty.call(params, "operationId")) return perform(method, params);
    const key = EXTERNAL_INSPIRATION_METHODS.includes(method) ? `${method}:${params.operationId}` : params.operationId;
    const fingerprint = operationFingerprint(method, params);
    const existing = operations.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw hostError("FEDERATION_OPERATION_CONFLICT");
      return existing.promise;
    }
    if (operations.size >= MAX_OPERATIONS) {
      const settled = [...operations.entries()].find(([, record]) => record.settled);
      if (!settled) throw hostError("APP_HOST_UNAVAILABLE");
      operations.delete(settled[0]);
    }
    const record = { fingerprint, settled: false, promise: null };
    record.promise = Promise.resolve().then(() => perform(method, params))
      .finally(() => { record.settled = true; });
    operations.set(key, record);
    return record.promise;
  };

  const write = (socket, payload) => {
    const frame = `${JSON.stringify(payload)}\n`;
    if (Buffer.byteLength(frame, "utf8") > FEDERATION_MAX_FRAME_BYTES) {
      socket.end(`${JSON.stringify({ id: payload.id, ok: false, error: { code: "FEDERATION_RESPONSE_INVALID" } })}\n`);
      return;
    }
    socket.end(frame);
  };

  const onConnection = (socket) => {
    sockets.add(socket);
    let buffered = Buffer.alloc(0);
    let handled = false;
    socket.on("data", (chunk) => {
      if (handled) { socket.destroy(); return; }
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > FEDERATION_MAX_FRAME_BYTES) { handled = true; socket.destroy(); return; }
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      handled = true;
      if (newline !== buffered.length - 1) { socket.destroy(); return; }
      let request;
      try { request = JSON.parse(buffered.subarray(0, newline).toString("utf8")); } catch {
        write(socket, { id: null, ok: false, error: { code: "APP_HOST_INVALID_REQUEST" } });
        return;
      }
      const id = request?.id;
      if (!exactObject(request, ["id", "token", "version", "method", "params"])
        || (typeof id !== "string" && !Number.isSafeInteger(id))
        || request.version !== FEDERATION_PROTOCOL_VERSION || !sameToken(request.token, token)
        || !validateFederationParams(request.method, request.params)) {
        write(socket, { id, ok: false, error: { code: "APP_HOST_INVALID_REQUEST" } });
        return;
      }
      Promise.resolve(route(request.method, request.params)).then((result) => {
        if (!validateFederationResult(request.method, result, request.params)) throw hostError("FEDERATION_RESPONSE_INVALID");
        write(socket, { id, ok: true, result });
      }).catch((error) => {
        const code = PUBLIC_ERROR_CODES.has(error?.code) || (EXTERNAL_INSPIRATION_METHODS.includes(request.method)
          && isPublicExternalInspirationError(error?.code)) ? error.code : "AGENT_OPERATION_FAILED";
        write(socket, { id, ok: false, error: { code } });
      });
    });
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  };

  return {
    async start() {
      if (server) return this;
      try {
        ensurePrivateDirectoryTree(paths.runtimeDir, paths.trustedRoot);
        const stale = rejectSymlink(paths.federationSocketPath);
        if (stale) {
          if (!stale.isSocket() || (typeof process.getuid === "function" && stale.uid !== process.getuid())
            || (stale.mode & 0o077) !== 0) throw hostError("APP_HOST_UNAVAILABLE");
          fs.unlinkSync(paths.federationSocketPath);
        }
        token = crypto.randomBytes(32).toString("base64url");
        atomicWritePrivateFile(paths.federationTokenPath, `${token}\n`, {
          trustedRoot: paths.trustedRoot,
        });
        tokenIdentity = fs.lstatSync(paths.federationTokenPath);
        server = net.createServer(onConnection);
        await new Promise((resolve, reject) => {
          const failed = (error) => { server?.off("listening", ready); reject(error); };
          const ready = () => { server?.off("error", failed); resolve(); };
          server.once("error", failed);
          server.once("listening", ready);
          server.listen(paths.federationSocketPath);
        });
        fs.chmodSync(paths.federationSocketPath, 0o600);
        socketIdentity = fs.lstatSync(paths.federationSocketPath);
        if (!socketIdentity.isSocket() || (socketIdentity.mode & 0o077) !== 0) {
          throw hostError("APP_HOST_UNAVAILABLE");
        }
        return this;
      } catch {
        // 监听后校验失败也必须收回 socket/token；否则下次启动会把半初始化
        // Host 当成可信端点，或让旧 socket 长时间占用路径。
        try { await this.stop(); } catch {}
        throw hostError("APP_HOST_UNAVAILABLE");
      }
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      const active = server;
      server = null;
      if (active) await new Promise((resolve) => active.close(() => resolve()));
      for (const [target, identity] of [
        [paths.federationSocketPath, socketIdentity], [paths.federationTokenPath, tokenIdentity],
      ]) {
        try {
          const current = fs.lstatSync(target);
          if (identity && current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(target);
        } catch (error) { if (error?.code !== "ENOENT") throw error; }
      }
      socketIdentity = null; tokenIdentity = null; token = null; operations.clear();
      try { taskRunner?.reset?.(); } catch {}
      try { await inspirationRunner?.reset(); } catch {}
    },
  };
}

module.exports = { createFederationHostServer };
