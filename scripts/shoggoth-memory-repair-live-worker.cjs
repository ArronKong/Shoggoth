"use strict";

// Stage 8. All Product state and native Runtime history live in the wrapper's
// disposable HOME. Only synthetic facts enter Provider requests. A mismatched
// scenario stops the suite; failures never become implicit retry authority.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { createAgentService, PROTOCOL_VERSION } = require("../app/agent-service/server");
const { resolveCanonicalServicePaths } = require("../app/agent-service/paths");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { AGENT_PROFILE_FIELDS } = require("../app/agent-service/product-store");
const { DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME } = require("../app/agent-service/runtime-account");
const { RuntimeMcpGateIssuer } = require("../app/agent-service/runtime-mcp-gate");
const { refsFromEvents } = require("../app/agent-service/shoggoth-memory/borrowed-memory-provenance.cjs");
const { core } = require("../app/agent-service/shoggoth-memory/host.cjs");
const { redactDiagnostic } = require("../app/agent-service/codex-rpc-safety");
const { runtimeFailureDetail } = require("../app/agent-service/runtime-failure-detail");
const DAY = 86400000, digest = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = code => Object.assign(new Error(code), { code });
const safeCode = error => /^[A-Z][A-Z0-9_]{0,100}$/u.test(error?.code || "") ? error.code : "MEMORY_REPAIR_LIVE_FAILED";
function check(ok, code) { if (!ok) throw fail(`MEMORY_REPAIR_${code}`); }
function writeLiveMcpLauncher(root) {
  const command = path.join(root, "mcp-helper-launch"), quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  // The protected native Runtime has its own empty HOME. Only this test helper
  // must retain the disposable Service home; production resolves it via userInfo.
  fs.writeFileSync(command, "#!/bin/sh\nHOME=" + quote(root) + " exec " + quote(process.execPath) + ' "$@" 2>'
    + quote(path.join(root, "mcp-stderr.log")) + "\n", { mode: 0o700 });
  return command;
}
function hasColorAnswer(answer, color) {
  const single = answer.trim().replace(/^[*_`"“”「」]+|[*_`"“”「」。.!！]+$/gu, "").trim();
  return answer.includes(`${color}色`) || single === color;
}
function terminalFailureDetail(events, runId, secrets = []) {
  const terminal = events.findLast(event => event.runId === runId && event.kind === "error"
    && event.content?.transcriptType === "terminal");
  return runtimeFailureDetail(terminal?.content?.failure, secrets);
}
// Synthetic live acceptance only: record structural facts, never response
// text, arbitrary keys, arguments, snippets or model-provided diagnostics.
function recallResponseShape(response) {
  const text = response?.text;
  const shape = { textPresent: typeof text === "string" };
  if (!shape.textPresent) return shape;
  shape.bytes = Buffer.byteLength(text);
  shape.codeFenced = /^\s*```/u.test(text);
  shape.bareNone = text.trim() === "NONE";
  if (shape.bytes > 65536) return { ...shape, overBudget: true };
  let value;
  try { value = JSON.parse(text); shape.validJson = true; }
  catch { return { ...shape, validJson: false }; }
  shape.object = value !== null && typeof value === "object" && !Array.isArray(value);
  if (!shape.object) return shape;
  const keys = ["summary", "tool", "arguments", "checkpoint"];
  shape.knownKeys = keys.filter(key => Object.hasOwn(value, key));
  shape.unknownKeyCount = Object.keys(value).filter(key => !keys.includes(key)).length;
  shape.summaryNone = value.summary === "NONE";
  shape.summaryString = typeof value.summary === "string";
  if (Object.hasOwn(value, "tool")) shape.tool = ["memory_search", "memory_get"].includes(value.tool) ? value.tool : "other";
  if (Object.hasOwn(value, "arguments")) {
    const args = value.arguments;
    shape.argumentsObject = args !== null && typeof args === "object" && !Array.isArray(args);
    if (shape.argumentsObject) {
      const fields = ["query", "maxResults", "minScore", "path", "from", "lines", "source", "sourceId", "id", "limit", "memoryScope", "checkpoint"];
      shape.argumentFields = fields.filter(key => Object.hasOwn(args, key));
      shape.unknownArgumentCount = Object.keys(args).filter(key => !fields.includes(key)).length;
      shape.queryString = typeof args.query === "string";
      shape.queryWithinLimit = shape.queryString && args.query.length <= 4096;
    }
  }
  return shape;
}
function createRuntimeProgress(now = Date.now) {
  const handles = new Map();
  const key = value => typeof value === "string" ? digest(value).slice(0, 16) : null;
  const types = new Set(["text_delta", "reasoning_delta", "text", "reasoning", "usage", "tool_start", "tool_result", "status", "context_compacted", "complete"]);
  const statuses = new Set(["running", "inProgress", "compacting", "completed", "failed", "interrupted"]);
  const commands = new Set(["auth/read", "session/start", "session/resume", "session/delete", "turn/start", "turn/steer", "turn/interrupt", "model/cancel", "model/resolve", "model/describe", "model/generate", "models/list", "commands/list", "command/execute"]);
  return {
    observe(handle) {
      if (handle?.runtime !== "deepseek-harness" || !handle.host || handles.has(handle.host)) return;
      const entry = { acquiredAt: now(), events: [] };
      handles.set(handle.host, entry);
      handle.subscribe(event => {
        if (event?.known !== true || !types.has(event.type)) return;
        const sessionKey = key(event.sessionId), turnKey = key(event.turnId);
        const status = statuses.has(event.status) ? event.status : null;
        let row = entry.events.find(value => value.sessionKey === sessionKey && value.turnKey === turnKey && value.type === event.type && value.status === status);
        if (!row) {
          if (entry.events.length >= 256) return;
          row = { sessionKey, turnKey, type: event.type, status, count: 0, firstAt: now() };
          entry.events.push(row);
        }
        row.count++; row.lastAt = now();
      });
    },
    snapshot() {
      return [...handles].slice(-16).map(([host, entry]) => ({ acquiredAt: entry.acquiredAt,
        observedAt: now(), events: entry.events.map(value => ({ ...value })),
        processClosed: host.process?.closed === true, processFailed: Boolean(host.processFailure),
        pendingCommands: [...(host.process?.pending?.values() || [])].slice(0, 32).map(value => commands.has(value.command) ? value.command : "other"),
        activeTurns: [...(host.activeTurns?.values() || [])].slice(0, 32).map(value => ({
          sessionKey: key(value.sessionId), turnKey: key(value.turnId), accepted: value.accepted === true,
          settled: value.settled === true, interruptRequested: value.interruptRequested === true,
        })),
      }));
    },
  };
}
// Observe native stop provenance without persisting HTTP routes, permissions'
// resources, tool arguments/results, message text, or arbitrary error strings.
function observeOpenCodeHost(handle, observations, now = Date.now) {
  const host = handle?.runtime === "opencode" && handle.host;
  if (!host?.client?.request) return;
  const tools = new Set(["glob", "grep", "read", "list", "bash", "edit", "external_directory",
    "shoggoth_memory_search", "shoggoth_memory_get", "shoggoth_memory_save", "shoggoth_memory_forget"]);
  const codes = new Set(["RUNTIME_CONNECTION_LOST", "RUNTIME_AUTH_REQUIRED", "RUNTIME_RATE_LIMITED",
    "RUNTIME_QUOTA_EXHAUSTED", "RUNTIME_UPSTREAM_UNAVAILABLE", "RUNTIME_TURN_OUTCOME_UNKNOWN",
    "OPENCODE_HTTP_PROTOCOL_INVALID", "OPENCODE_HTTP_REJECTED", "OPENCODE_NOT_FOUND",
    "OPENCODE_HTTP_RESPONSE_TOO_LARGE", "OPENCODE_TURN_TIMEOUT"]);
  const key = value => typeof value === "string" ? digest(value).slice(0, 16) : null;
  const rows = new Map();
  const record = (stage, facts = {}) => {
    const signature = JSON.stringify({ stage, ...facts });
    let row = rows.get(signature);
    if (!row) {
      if (observations.length >= 256) return;
      row = { stage, ...facts, count: 0, firstAt: now() };
      rows.set(signature, row); observations.push(row);
    }
    row.count++; row.lastAt = now();
  };
  const errorClass = value => {
    const text = typeof value === "string" ? value.slice(0, 8192) : "";
    if (/permission|denied|rejected/iu.test(text)) return "permission";
    if (/timeout|timed out/iu.test(text)) return "timeout";
    if (/abort|cancel/iu.test(text)) return "canceled";
    if (/not found|not available|unknown tool|not registered/iu.test(text)) return "unavailable";
    return text ? "other" : "absent";
  };
  const action = value => ({ tool: tools.has(value) ? value : "other",
    productTool: typeof value === "string" && value.startsWith("shoggoth_") });
  handle.subscribe(event => {
    if (event?.known !== true || event.type !== "complete") return;
    record("host-complete", { sessionKey: key(event.sessionId), turnKey: key(event.turnId),
      method: ["opencode/session.message", "opencode/interrupt", "opencode/failed"].includes(event.method) ? event.method : "other",
      status: ["completed", "failed", "interrupted"].includes(event.status) ? event.status : "other",
      errorCode: event.errorCode == null ? null : codes.has(event.errorCode) ? event.errorCode : "other" });
  });
  const request = host.client.request.bind(host.client);
  host.client.request = async (method, route, body, ...options) => {
    const messages = typeof route === "string" && /^\/session\/([^/?]+)\/message(?:\/|\?|$)/u.exec(route);
    const abort = typeof route === "string" && /^\/session\/([^/?]+)\/abort$/u.exec(route);
    const permission = typeof route === "string" && /^\/permission\/[^/?]+\/reply$/u.test(route);
    const routeKind = messages ? "messages" : abort ? "abort" : permission ? "permission-reply"
      : route === "/permission" ? "permissions" : route === "/session/status" ? "status" : "other";
    if (method === "POST" && abort) record("host-abort", { sessionKey: key(abort[1]) });
    if (method === "POST" && permission) record("permission-reply", {
      decision: ["once", "always", "reject"].includes(body?.reply) ? body.reply : "other" });
    try {
      const response = await request(method, route, body, ...options);
      if (method === "GET" && route === "/permission" && Array.isArray(response?.data)) {
        for (const item of response.data.slice(0, 100)) record("permission-visible", {
          sessionKey: key(item?.sessionID), requestKey: key(item?.id), ...action(item?.permission) });
      }
      if (method === "GET" && messages) {
        const entries = Array.isArray(response?.data) ? response.data : response?.data?.info ? [response.data] : [];
        for (const item of entries.slice(0, 100)) {
          if (item?.info?.role !== "assistant") continue;
          const identity = { sessionKey: key(item.info.sessionID), messageKey: key(item.info.id) };
          const native = item.info.error;
          if (native) record("native-error", { ...identity,
            name: ["MessageAbortedError", "APIError", "UnknownError", "ContextOverflowError", "MessageOutputLengthError"].includes(native.name) ? native.name : "other",
            errorClass: errorClass(native.data?.message ?? native.message) });
          for (const part of (Array.isArray(item.parts) ? item.parts : []).slice(0, 1000)) {
            if (part?.type === "tool" && part.state?.status === "error") record("native-tool-error", {
              ...identity, partKey: key(part.id), ...action(part.tool), errorClass: errorClass(part.state.error) });
          }
        }
      }
      return response;
    } catch (error) {
      record("request-error", { routeKind, code: codes.has(error?.code) ? error.code : "other" });
      throw error;
    }
  };
}
// Only fixed stage names, status codes and timings enter this live receipt.
// Request headers, route tokens, bodies and arbitrary error text stay private.
function observeModelGateway(gateway, observations, now = Date.now) {
  if (!gateway) return;
  const knownCodes = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ABORT_ERR",
    "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
    "UND_ERR_ABORTED", "SECRET_MODEL_REQUEST_INVALID", "SECRET_MODEL_INPUT_INVALID",
    "SECRET_MODEL_ROUTE_INVALID", "SECRET_MODEL_RESPONSE_INVALID", "SECRET_MODEL_CANCELED",
    "SECRET_MODEL_UPSTREAM_UNAVAILABLE", "SECRET_MODEL_PROXY_INVALID"]);
  const codes = error => {
    const values = [];
    for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth++) {
      values.push(knownCodes.has(current.code) ? current.code : "other");
    }
    return values;
  };
  const record = (stage, startedAt, facts = {}) => {
    if (observations.length < 256) observations.push({ stage, elapsedMs: now() - startedAt, ...facts });
  };
  const handle = gateway.handle.bind(gateway);
  gateway.handle = async (req, res) => {
    const startedAt = now(); record("local-request", startedAt);
    res.once("finish", () => record("local-finish", startedAt, { status: res.statusCode }));
    try { return await handle(req, res); }
    catch (error) { record("local-error", startedAt, { codes: codes(error), headersSent: res.headersSent }); throw error; }
  };
  const dispatch = gateway.dispatch.bind(gateway);
  gateway.dispatch = async (...args) => {
    const startedAt = now(); record("upstream-request", startedAt);
    try {
      const result = await dispatch(...args);
      const type = result.headers?.["content-type"]?.split(";")[0].trim().toLowerCase();
      const encoding = result.headers?.["content-encoding"] || "identity";
      record("upstream-headers", startedAt, { status: result.statusCode,
        contentType: typeof type === "string" && type.length <= 128 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(type) ? type : type === undefined ? "absent" : "other",
        contentEncoding: ["identity", "gzip", "br", "deflate", "zstd"].includes(encoding) ? encoding : "other" });
      result.body.once("error", error => record("upstream-error", startedAt, { codes: codes(error) }));
      result.body.once("end", () => record("upstream-end", startedAt));
      return result;
    } catch (error) { record("upstream-error", startedAt, { codes: codes(error) }); throw error; }
  };
  const receipt = gateway.receiptStream?.bind(gateway);
  if (receipt) gateway.receiptStream = (...args) => {
    const stream = receipt(...args), transform = stream._transform, flush = stream._flush, startedAt = now();
    let first = true, lastNewline = false;
    stream._transform = function(chunk, encoding, done) {
      const bytes = Buffer.from(chunk);
      if (first) {
        first = false;
        const prefix = bytes.subarray(0, 5).toString("ascii");
        record("receipt-first-chunk", startedAt, { sse: args[1] === true,
          format: bytes[0] === 31 && bytes[1] === 139 ? "gzip"
            : bytes.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd])) ? "zstd"
              : prefix.startsWith("data:") || prefix.startsWith("event") ? "sse"
                : prefix.startsWith("{") ? "json" : "other" });
      }
      lastNewline = bytes.at(-1) === 10;
      transform.call(this, chunk, encoding, (...values) => {
        if (values[0]) record("receipt-transform-error", startedAt, { codes: codes(values[0]) });
        done(...values);
      });
    };
    stream._flush = function(done) {
      flush.call(this, (...values) => {
        if (values[0]) record("receipt-flush-error", startedAt, { codes: codes(values[0]), lastNewline });
        done(...values);
      });
    };
    return stream;
  };
}
// A turn can spend the Product's full five-minute recall budget plus its
// ten-second setup grace before the main response starts.
function bounded(promise, ms = 360000) {
  let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(fail("MEMORY_REPAIR_WAIT_TIMEOUT")), ms); })])
    .finally(() => clearTimeout(timer));
}
function textTree(root) {
  if (!fs.existsSync(root)) return "";
  return fs.readdirSync(root, { withFileTypes: true }).map(entry => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? textTree(file) : entry.isFile() ? fs.readFileSync(file).toString() : "";
  }).join("\n");
}
function databaseContains(db, text) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().some(({ name }) =>
    db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().some(row => JSON.stringify(row).includes(text)));
}
function snapshots(paths, profileId, runId) {
  const root = path.join(paths.agentsDir, profileId, "context-snapshots");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(name => name.endsWith(".json")).map(name => JSON.parse(fs.readFileSync(path.join(root, name), "utf8")))
    .filter(value => value.runId === runId);
}
function configure(service, workspace, name, runtime = "codex") {
  const base = service.productStore.listAgentProfiles()[0];
  const fields = Object.fromEntries(AGENT_PROFILE_FIELDS.map(field => [field, base[field]])), id = crypto.randomUUID();
  const profile = service.productStore.putAgentProfile({ ...fields, id, agentId: id, name, runtime,
    runtimeProfileId: id, runtimeAccountId: DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME[runtime], providerRef: null, defaultModel: null,
    defaultCwd: workspace, isDefault: false, enabled: true,
    permissionPolicy: { approvalPolicy: "on-request", sandbox: "read-only" }, concurrency: { maxActive: 2, maxWorkspaceWrites: 0 } });
  service.agentDefinitionStore.ensureProfile({ profileId: id, profileName: name });
  service.memoryStore.ensureProfile(id); service.memoryEngine.recallPolicy.assertReady(id); service.nativeSkillStore.ensureProfile(id);
  return profile;
}

// Faults are injected at the completion boundary after the selected Runtime's
// real model route has resolved. They test Product diagnostics, not a Provider
// outage. No fault prompt is sent to a Provider and default live budgets stay
// unchanged outside these two explicitly controlled cases.
async function controlledRecallFaults(service, profile, makeSession, evidence = {}) {
  const owner = service.memoryEngine, originalConfig = owner.getConfig, originalComplete = owner.complete;
  evidence.kind = "controlled-completion-faults-after-runtime-model-resolution";
  evidence.providerCalls = 0;
  try {
    for (const kind of ["timeout", "failure"]) {
      const target = makeSession(), id = crypto.randomUUID(), query = `What do you remember about the nonexistent diagnostic ${kind} fixture?`;
      let calls = 0;
      const base = originalConfig.call(owner), entry = base.plugins?.entries?.["active-memory"] || {};
      const config = { ...base, plugins: { ...base.plugins, entries: { ...base.plugins?.entries,
        "active-memory": { ...entry, enabled: true, config: { ...entry.config, mode: "always", timeoutMs: kind === "timeout" ? 400 : 15000, setupGraceTimeoutMs: 0 } } } } };
      owner.getConfig = () => config;
      owner.complete = async request => {
        check(request.profileId === profile.id && request.sessionKey === target.sessionKey, "FAULT_SCOPE_INVALID");
        calls++;
        if (kind === "failure") throw fail("MEMORY_REPAIR_INJECTED_MODEL_FAILURE");
        request.signal.throwIfAborted();
        return new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
      };
      service.workDispatcher.enqueue({ id, profileId: profile.id, source: "chat", sourceId: target.sessionKey, idempotencyKey: id, workspace: profile.defaultCwd });
      service.transcriptStore.appendEvent({ profileId: profile.id, sessionId: target.id, id: `user-${id}`, runId: id,
        kind: "user", content: { text: query }, occurredAt: Date.now() });
      const input = { profile, session: target, run: service.workDispatcher.getRun(id), query };
      try {
        await bounded(owner.prepareActiveMemory(input), 30000); owner.takeActiveMemory(input);
      } finally {
        const admission = service.workDispatcher.admit(id, { writable: false });
        check(admission.disposition === "started", "FAULT_PARENT_ADMISSION_FAILED");
        service.workDispatcher.transition(id, "running");
        service.workDispatcher.transition(id, "completed");
        await owner.finishActiveMemoryRun(service.workDispatcher.getRun(id));
      }
      const records = owner.host(profile.id).database.db.prepare("SELECT value FROM memory_state WHERE namespace='active-memory-diagnostics' AND value IS NOT NULL")
        .all().map(row => JSON.parse(row.value)).filter(record => record.runKey === digest(id).slice(0, 16));
      const status = await owner.activeMemory.status.read({ profileId: profile.id, sessionKey: target.sessionKey, includeTrace: false });
      evidence[kind] = { calls, outcome: status.outcome, records };
      check(calls === 1, "FAULT_MODEL_BOUNDARY_NOT_REACHED");
      check(records.some(record => record.stage === "recall-result" && record.outcome === (kind === "timeout" ? "timeout" : "failed")), "FAULT_RESULT_DIAGNOSTIC_MISSING");
      check(records.some(record => record.stage === "recall-model" && (kind === "timeout"
        ? ["TIMEOUT", "ABORTED"].includes(record.code) : record.code === "MEMORY_REPAIR_INJECTED_MODEL_FAILURE")), "FAULT_CODE_DIAGNOSTIC_MISSING");
      check(!JSON.stringify(records).includes("nonexistent diagnostic"), "FAULT_DIAGNOSTIC_CONTAINS_TEXT");
    }
  } finally { owner.getConfig = originalConfig; owner.complete = originalComplete; }
  return evidence;
}

async function main() {
  const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8")), root = fs.realpathSync(config.root);
  const runtime = config.runtime || "codex";
  check(Object.hasOwn(DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME, runtime), "RUNTIME_INVALID");
  check(root.startsWith("/private/tmp/sgmemlive-") && fs.realpathSync(process.env.HOME) === root
    && process.env.CODEX_HOME === path.join(root, ".codex"), "ENV_INVALID");
  const paths = resolveCanonicalServicePaths({ userInfo: () => ({ homedir: root }) });
  const key = crypto.randomBytes(32); fs.writeFileSync(path.join(root, "mcp-key.bin"), key, { flag: "wx", mode: 0o600 });
  const secrets = [], collectSecrets = value => {
    if (typeof value === "string" && value.length >= 8) secrets.push(value);
    else if (value && typeof value === "object") Object.values(value).forEach(collectSecrets);
  };
  for (const relative of config.authFiles || [".codex/auth.json"]) {
    const target = path.resolve(root, relative); check(target.startsWith(root + path.sep), "AUTH_PATH_INVALID");
    const bytes = fs.readFileSync(target, "utf8");
    collectSecrets(relative.endsWith(".yaml") ? require("js-yaml").load(bytes) : JSON.parse(bytes));
  }
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString(value) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    decryptString(bytes) { const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"); } };
  const helperCommand = writeLiveMcpLauncher(root), helperPath = path.join(__dirname, "shoggoth-memory-live-mcp-helper.cjs");
  const memoryCoreConfig = { memory: { search: { provider: "none", sources: ["memory", "sessions"] } },
    plugins: { entries: { "active-memory": { enabled: true, config: { mode: "escalate" } } } },
    agents: { defaults: { compaction: { memoryFlush: { enabled: false } } } } };
  const serviceOptions = { paths, parentEnv: { ...process.env }, runtimeStorageHomedir: root, prewarmMcpAuth: false,
    version: "isolated-memory-repair-stage8", safeStorage, memoryCore: true, memorySharingFeatureReady: true, memoryCoreConfig,
    runtimeMcpGateIssuer: new RuntimeMcpGateIssuer({ paths, mcpHelperLaunch: { command: helperCommand, argsPrefix: [] }, bootstrapPath: helperPath }),
    mcpHelperLaunch: { command: helperCommand, argsPrefix: [helperPath] } };
  const result = { schemaVersion: 1, status: "failed", runtime, startedAt: new Date().toISOString(),
    isolation: config.isolation || null,
    evidence: config.preflightOnly ? "isolated-runtime-catalog-only" : "isolated-source-service-real-provider", productionStateWritten: false, realClock: true,
    scenarios: Object.fromEntries(["save-new-session", "chinese-recall", "correct-restart", "borrow-revoke", "distinct-question-signals", "forget-no-revival", "diagnostics"].map(name => [name, { status: "not_run" }])),
    rollback: { status: "not_run" }, turns: [], toolCalls: [], recallModelCalls: 0, modelGateway: [], openCodeRuntime: [] };
  let service, profile, first, second, original, corrected, daily, ordinal = 0, active = false;
  const runtimeProgress = createRuntimeProgress();
  const observedOpenCodeHosts = new WeakSet();
  const stage = name => { result.stage = name; process.stdout.write(`MEMORY_LIVE_STAGE repair-${name}\n`); };
  const start = async () => {
    if (runtime === "grok-build" && config.isolation) {
      require("./shoggoth-memory-live-isolation.cjs").assertGrokSocketDenyAlias(root, config.isolation);
    }
    if (runtime === "antigravity") {
      check(config.isolation?.kind === "antigravity-file-credentials", "ACCOUNT_ISOLATION_REQUIRED");
      check(config.isolation.osSandbox?.scope === "official-runtime-descendants"
        && config.isolation.sandboxPolicy === path.join(root, "antigravity-worker.sb"), "RUNTIME_SANDBOX_REQUIRED");
      const { spawn } = require("node:child_process");
      const isolatedSpawn = (command, args, options) => spawn("/usr/bin/sandbox-exec",
        ["-f", config.isolation.sandboxPolicy, command, ...args], options);
      const { AntigravityRuntimePool } = require("../app/agent-service/antigravity-runtime-pool");
      serviceOptions.antigravityRuntimePool = new AntigravityRuntimePool({ paths, parentEnv: { ...process.env }, homedir: root,
        mcpGateIssuer: serviceOptions.runtimeMcpGateIssuer,
        hostOptions: { credentialStorage: "file", spawnProcess: isolatedSpawn, securityExecFile: () => { throw fail("MEMORY_REPAIR_KEYCHAIN_ACCESS_FORBIDDEN"); } } });
    }
    service = createAgentService(serviceOptions);
    observeModelGateway(service.codexRuntimeAdapter?.secretGateway, result.modelGateway);
    await service.start(); active = true;
    const manager = service.runtimeManager, acquire = manager.acquire.bind(manager);
    manager.acquire = async (...args) => {
      try {
        const handle = await acquire(...args); runtimeProgress.observe(handle);
        if (handle.runtime === "opencode" && handle.host && !observedOpenCodeHosts.has(handle.host)) {
          observedOpenCodeHosts.add(handle.host); observeOpenCodeHost(handle, result.openCodeRuntime);
        }
        return handle;
      }
      catch (error) {
        const codes = [];
        for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth++) codes.push(safeCode(current));
        (result.runtimeErrors ||= []).push({ operation: "acquire", codes }); throw error;
      }
    };
    const complete = service.memoryEngine.complete.bind(service.memoryEngine);
    service.memoryEngine.complete = async request => {
      const recall = request.prompt.includes("Read-only host tool transport:");
      if (recall) result.recallModelCalls++;
      const response = await complete(request);
      if (recall && (result.recallResponseShapes ||= []).length < 150) result.recallResponseShapes.push({
        sessionKey: digest(request.sessionKey || "").slice(0, 16), shape: recallResponseShape(response),
      });
      return response;
    };
    // Borrowed tool transcripts deliberately discard arguments/results and
    // may show the generic memory_read placeholder. Observe only names and
    // outcomes at the actual controller boundary, retaining no tool bodies.
    const controller = service.mcpProductToolController, handle = controller.handle.bind(controller);
    controller.handle = async (name, args, authority, executionScope) => {
      const scope = executionScope || controller.executionContext.getStore();
      const runId = scope?.runId || scope?.mcpRun?.id;
      const record = outcome => {
        if (!runId || !["memory_search", "memory_get", "memory_save", "memory_forget"].includes(name)) return;
        const entry = { runId, callId: authority.callId, name, ...outcome };
        const index = result.toolCalls.findIndex(item => item.runId === runId && item.callId === authority.callId && item.name === name);
        if (index < 0) result.toolCalls.push(entry); else result.toolCalls[index] = entry;
      };
      try { const value = await handle(name, args, authority, executionScope);
        record({ status: "completed", ...(name === "memory_search" ? { returnedSources: (value?.results || []).map(item => ({ source: item.source, path: item.path, borrowed: item.borrowed === true })) } : {}) });
        return value; }
      catch (error) { record({ status: "failed", errorCode: safeCode(error) }); throw error; }
    };
  };
  const stop = async () => { if (active) { await bounded(service.stop({ notify: false }), 30000); active = false; } };
  const scenario = async (name, fn) => {
    stage(name); const value = result.scenarios[name]; value.status = "running";
    try { Object.assign(value, await fn(), { status: "passed" }); }
    catch (error) { value.status = "failed"; value.errorCode = safeCode(error); throw error; }
  };
  const productCall = (method, params) => requestService(paths, { id: crypto.randomUUID(), token: readClientToken(paths), version: PROTOCOL_VERSION, method, params }, { timeoutMs: 20000 });
  const session = () => {
    const created = service.chatSessionStore.createSession({ profileId: profile.id, workspace: profile.defaultCwd,
      operationId: crypto.randomUUID(), createdAt: Date.now() });
    return service.chatSessionStore.setModelOverride(created.sessionKey, result.model);
  };
  const hasTool = (turn, name) => result.toolCalls.some(call => call.runId === turn.run.id && call.name === name && call.status === "completed");
  const send = async (target, prompt, name) => {
    stage(name); const beforeCalls = result.recallModelCalls, startedAt = Date.now();
    const ack = await service.workRunCoordinator.send({ sessionKey: target.sessionKey, operationId: `repair-send-${++ordinal}`, prompt });
    let run;
    const approvals = runtime === "grok-build" && config.isolation?.kind === "grok-automatic-socket-deny"
      ? require("./shoggoth-memory-live-approvals.cjs").watchMemoryApprovals(service.workRunCoordinator,
        { runtime, runId: ack.run.id, profileId: profile.id, sessionKey: target.sessionKey,
        allowedSessionIds: service.chatSessionStore.listSessions().filter(row => row.profileId === profile.id).map(row => row.id) }, result.approvals ||= []) : null;
    try { const terminal = service.workRunCoordinator.waitForTerminal(ack.run.id);
      run = await bounded(approvals ? Promise.race([terminal, approvals.failure]) : terminal); await bounded(service.workRunCoordinator.waitForIdle(ack.run.id), 30000);
      // The terminal observer starts asynchronous signal commits. Runtime idle
      // does not include them; wait for the actual jobs instead of submitting
      // another finish notification or manufacturing a recall signal.
      await bounded(Promise.allSettled([...service.memoryEngine.signalCommits]), 20000); }
    catch (error) {
      const current = service.workDispatcher.getRun(ack.run.id);
      const nativeSession = current?.runtimeSessionRef?.sessionId ?? current?.runtimeSessionId;
      const nativeTurn = current?.runtimeTurnRef?.turnId;
      result.waitFailure = { runStatus: current?.status, errorCode: current?.errorCode,
        pendingKinds: [...service.workRunCoordinator.pendingRequests.values()].filter(value => value.runId === ack.run.id).map(value => value.kind),
        elapsedMs: Date.now() - startedAt, runtimeSessionKey: typeof nativeSession === "string" ? digest(nativeSession).slice(0, 16) : null,
        runtimeTurnKey: typeof nativeTurn === "string" ? digest(nativeTurn).slice(0, 16) : null,
        runtimeProgress: runtimeProgress.snapshot() };
      throw error;
    } finally { approvals?.stop(); }
    const events = service.transcriptStore.listEvents(profile.id, target.id).filter(event => event.runId === run.id);
    const tools = events.filter(event => event.kind === "tool_call").map(event => event.content?.tool?.name || event.content?.toolName || "unknown");
    const answer = events.filter(event => event.kind === "assistant" && typeof event.content?.text === "string").map(event => event.content.text).join("\n");
    const material = snapshots(paths, profile.id, run.id), recall = material.flatMap(value => value.blocks).filter(block => block.id === "active-memory").map(block => block.content).join("\n");
    result.turns.push({ name, runId: run.id, status: run.status, errorCode: run.errorCode,
      elapsedMs: Date.now() - startedAt,
      failure: terminalFailureDetail(events, run.id, secrets), tools,
      answer: redactDiagnostic(answer, secrets).slice(0, 8192), activeRecall: redactDiagnostic(recall, secrets).slice(0, 8192),
      recallModelCalls: result.recallModelCalls - beforeCalls, nativeSessionId: service.chatSessionStore.getSession(target.sessionKey).runtimeSessionId });
    check(run.status === "completed", run.errorCode || "TURN_FAILED");
    return { run, events, tools, answer, material, recall, recallModelCalls: result.recallModelCalls - beforeCalls,
      nativeSessionId: service.chatSessionStore.getSession(target.sessionKey).runtimeSessionId };
  };
  const search = async (query, run) => service.memoryEngine.searchMemory({ profileId: profile.id, workspace: profile.defaultCwd, maxSensitivity: "private", query, record: false, ...(run ? { run } : {}) });
  const recallEntries = async () => { const host = service.memoryEngine.host(profile.id); return host.run(() => core.readShortTermRecallEntries({ workspaceDir: host.workspaceDir, nowMs: Date.now() })); };
  const marker = `REPAIR${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  try {
    await start();
    const workspace = path.join(root, "workspaces", "repair"); fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    profile = configure(service, workspace, "记忆修复隔离验收", runtime);
    if (config.memoryText) {
      check(typeof config.memoryText.model === "string" && /^[a-zA-Z0-9._:/-]{1,256}$/u.test(config.memoryText.model), "MEMORY_MODEL_INVALID");
      const selected = service.productStore.addAgentRuntimeBinding(profile.id, { runtime: "codex",
        runtimeAccountId: DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME.codex }, { operationId: "repair-memory-model" });
      memoryCoreConfig.memory.textModel = { source: "binding", profileId: profile.id,
        bindingId: selected.binding.id, model: config.memoryText.model };
      result.memoryText = { runtime: "codex", model: config.memoryText.model, independent: true };
    }
    const runtimeConfig = service.nativeRuntimeConfig.read();
    service.nativeRuntimeConfig.apply({ ...runtimeConfig, revision: runtimeConfig.revision + 1,
      flags: { ...runtimeConfig.flags, runtimeAdmissionV1: true, runtimeContextLifecycleV1: true } });
    const catalog = await bounded(service.profileServiceController.handle("profile.models.list", { profileId: profile.id, cursor: null, limit: 100 }), 30000);
    const chosen = catalog.models.find(model => model.id === config.model) || catalog.models.find(model => model.isDefault) || catalog.models[0];
    check(chosen, "MODEL_CATALOG_EMPTY"); result.model = chosen.id;
    result.modelSelection = chosen.id === config.model ? "requested-model-in-live-catalog" : "live-catalog-default";
    if (config.preflightOnly === true) { result.preflightOnly = true; result.status = "passed"; return; }
    if (config.suite === "continuity") {
      await require("./shoggoth-memory-continuity-live-steps.cjs").runContinuity({ service, profile, result, send, scenario,
        session, check, redact: value => redactDiagnostic(value, secrets) });
      result.status = "passed"; return;
    }
    if (config.suite === "parity") {
      await require("./shoggoth-memory-parity-live-steps.cjs").runParity({ service, profile, root, runtime, result, send, scenario,
        productCall, check, redact: value => redactDiagnostic(value, secrets) });
      result.status = "passed"; return;
    }
    if (config.memoryText) {
      stage("host-memory-commands");
      const target = session(), fact = `The host-only canary is ${marker}HOST.`;
      const run = await send(target, `Remember: ${fact}`, "host-save");
      check(!run.run.runtimeSessionRef && !run.run.runtimeTurnRef && run.recallModelCalls === 0 && run.tools.length === 0, "HOST_MEMORY_USED_RUNTIME");
      const item = service.memoryStore.list(profile.id, { status: "active" }).find(row => row.content === fact);
      check(item, "HOST_MEMORY_SAVE_MISSING");
      const revised = `The host-only canary is ${marker}CHANGED.`;
      const correction = await send(target, `Correct memory: "${fact}" to "${revised}"`, "host-correct");
      check(!correction.run.runtimeSessionRef && correction.recallModelCalls === 0 && correction.tools.length === 0, "HOST_CORRECTION_USED_RUNTIME");
      check(service.memoryStore.list(profile.id, { status: "active" }).some(row => row.content === revised && row.supersedes === item.id), "HOST_CORRECTION_MISSING");
      const forgotten = await send(target, `Forget: "${revised}"`, "host-forget");
      check(!forgotten.run.runtimeSessionRef && forgotten.recallModelCalls === 0 && forgotten.tools.length === 0, "HOST_FORGET_USED_RUNTIME");
      check(!service.memoryStore.list(profile.id, { status: "active" }).some(row => row.content.includes(`${marker}HOST`) || row.content.includes(`${marker}CHANGED`)), "HOST_FORGET_MISSING");
      result.hostCommands = { status: "passed", nativeTurns: 0, modelCalls: 0, toolCalls: 0, linkedCorrection: true, forgotten: true };
    }
    await productCall("memory.sharing.config.apply", { revision: service.nativeMemorySharingConfig.read().revision + 1, config: { enabled: true, excludedProfiles: [] } });
    await scenario("save-new-session", async () => {
      first = session();
      const saved = await send(first, `我的验收计划 ${marker} 喜欢蓝色番茄。请调用 memory_save 保存这条明确偏好，content 为“用户的验收计划 ${marker} 喜欢蓝色番茄”，sourceQuote 为“我的验收计划 ${marker} 喜欢蓝色番茄”。`, "save");
      check(hasTool(saved, "memory_save"), "SAVE_TOOL_MISSING");
      original = service.memoryStore.list(profile.id, { status: "active" }).find(item => item.content.includes(marker));
      check(original, "SAVE_MISSING");
      second = session(); const recalled = await send(second, "我的验收计划喜欢哪种颜色的番茄？只回答颜色。", "new-session");
      check(hasColorAnswer(recalled.answer, "蓝"), "NEW_SESSION_ANSWER_WRONG");
      return { actualSaveTool: true, distinctSessions: first.id !== second.id, newSessionAnswered: true };
    });
    await scenario("chinese-recall", async () => {
      // Synthetic dated input exercises cold-memory retrieval; it is not an
      // elapsed-time claim for promotion. The clock and user events stay real.
      const oldDate = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10);
      const content = `琥珀望远镜每天傍晚校准，校准编号是 ${marker}TELESCOPE。`;
      daily = await service.memoryStore.upsert({ id: crypto.randomUUID(), profileId: profile.id, scope: "agent", type: "episodic", content,
        sourceRefs: [`user-edit:${digest(content)}`], confidence: 1, sensitivity: "normal", status: "active", supersedes: null,
        validFrom: Date.now(), validUntil: null, createdAt: Date.now(), updatedAt: Date.now(), memoryPath: `memory/${oldDate}.md` });
      const noise = await send(session(), "只回答十二，不要使用工具。", "intervening-session");
      check(noise.recallModelCalls === 0, "ORDINARY_QUESTION_STARTED_RECALL");
      for (const query of ["望远镜", "望遠鏡"]) check((await search(query)).results.some(row => row.path === daily.memoryPath), "CHINESE_SEARCH_MISSED");
      const recalled = await send(session(), "我之前说的琥珀望远镜什么时候校准，编号是什么？", "natural-chinese-recall");
      check(recalled.answer.includes(`${marker}TELESCOPE`), "CHINESE_ANSWER_WRONG");
      check(recalled.recall.includes(`${marker}TELESCOPE`) && recalled.recallModelCalls > 0, "ACTIVE_RECALL_NOT_INJECTED");
      check(!recalled.material.some(value => value.blocks.some(block => block.id === "memory" && block.content.includes(`${marker}TELESCOPE`))), "COLD_FACT_IN_HOT_MEMORY");
      return { chineseShortQueries: 2, deepRecallInjected: true, seededHistoricalDate: oldDate, realElapsedPromotionEvidence: false };
    });
    await scenario("correct-restart", async () => {
      const changed = await send(second, `更正偏好：我的验收计划 ${marker} 现在喜欢绿色番茄。请使用 memory_save 替换旧记忆 ${original.id}，supersedes 指向旧记忆，content 为“用户的验收计划 ${marker} 喜欢绿色番茄”，sourceQuote 为“我的验收计划 ${marker} 现在喜欢绿色番茄”。`, "correct");
      check(hasTool(changed, "memory_save"), "CORRECT_TOOL_MISSING");
      corrected = service.memoryStore.list(profile.id, { status: "active" }).find(item => item.content.includes(marker) && item.content.includes("绿色番茄"));
      check(corrected?.supersedes === original.id, "CORRECTION_NOT_LINKED");
      for (const [target, name] of [[first, "correct-old-session"], [session(), "correct-new-session"]]) {
        const reply = await send(target, "我的验收计划现在喜欢哪种颜色的番茄？只回答当前颜色，不解释历史。", name);
        check(hasColorAnswer(reply.answer, "绿") && !hasColorAnswer(reply.answer, "蓝"), "CORRECTED_ANSWER_WRONG");
      }
      await stop(); await start();
      const reply = await send(session(), "我的验收计划现在喜欢哪种颜色的番茄？只回答当前颜色。", "correct-after-restart");
      check(hasColorAnswer(reply.answer, "绿") && !hasColorAnswer(reply.answer, "蓝"), "RESTART_ANSWER_WRONG");
      return { supersedesLinked: true, oldAndNewSessions: true, serviceRestarted: true };
    });
    await scenario("borrow-revoke", async () => {
      const source = configure(service, profile.defaultCwd, "来源助理", runtime), borrowedCode = `${marker}FOREIGN`;
      await service.memoryEngine.propose({ profileId: source.id, scope: "agent", classification: "explicit", sourceRefs: ["user-edit:stage8-source"],
        content: `隔离银色灯塔的校准编号是 ${borrowedCode}。` });
      const target = session(); const reply = await send(target, "请使用 memory_search 和 memory_get 查找银色灯塔校准编号，回答确切编号，并注明来源助理与文件行号。", "borrow");
      check(hasTool(reply, "memory_search") && hasTool(reply, "memory_get") && reply.answer.includes(borrowedCode), "BORROW_ANSWER_WRONG");
      const refs = refsFromEvents(reply.events);
      check(refs.length && refs.every(ref => ref.ownerProfileId === source.id) && reply.answer.includes("来源助理"), "BORROW_PROVENANCE_MISSING");
      const host = service.memoryEngine.host(profile.id);
      const copies = { workspace: textTree(host.workspaceDir).includes(borrowedCode), database: databaseContains(host.database.db, borrowedCode),
        snapshot: textTree(path.join(paths.agentsDir, profile.id, "context-snapshots")).includes(borrowedCode),
        tools: JSON.stringify(reply.events.filter(event => ["tool_call", "tool_result"].includes(event.kind))).includes(borrowedCode) };
      check(Object.values(copies).every(value => !value), "BORROWED_COPY_FOUND");
      await productCall("memory.sharing.config.apply", { revision: service.nativeMemorySharingConfig.read().revision + 1, config: { enabled: true, excludedProfiles: [source.id] } });
      check(!service.memoryEngine.borrowedMemoryDependenciesCurrent(profile.id, target.id, refs), "REVOKED_DEPENDENCY_CURRENT");
      const after = await send(target, "来源已撤回，只回答已停止借阅，不调用工具或复述编号。", "borrow-after-revoke");
      check(after.nativeSessionId !== reply.nativeSessionId && !after.answer.includes(borrowedCode), "BORROW_SESSION_NOT_REBUILT");
      return { sourceProfileId: source.id, references: refs.length, persistedCopies: copies, nativeSessionRebuilt: true };
    });
    await scenario("distinct-question-signals", async () => {
      const find = entries => entries.find(entry => entry.path === daily.memoryPath);
      const before = find(await recallEntries()), target = session(); let last;
      for (const question of ["琥珀望远镜校准发生在什么时候", "琥珀望远镜的校准编号是什么", "琥珀望远镜多久校准一次"]) {
        last = await send(target, `请调用 memory_search 搜索“琥珀望远镜”，然后回答：${question}？`, `signal-${result.turns.length}`);
        check(hasTool(last, "memory_search"), "SIGNAL_SEARCH_MISSING");
      }
      const after = find(await recallEntries());
      Object.assign(result.scenarios["distinct-question-signals"], { beforeCount: before?.recallCount || 0,
        afterCount: after?.recallCount || 0, beforeDistinctQuestions: before?.userQueryHashes?.length || 0,
        afterDistinctQuestions: after?.userQueryHashes?.length || 0 });
      check(after?.recallCount >= (before?.recallCount || 0) + 3 && after?.userQueryHashes?.length >= (before?.userQueryHashes?.length || 0) + 3, "SIGNALS_NOT_GROWING");
      await service.memoryEngine.finishActiveMemoryRun(last.run);
      check(find(await recallEntries()).recallCount === after.recallCount, "DUPLICATE_TERMINAL_COUNTED");
      return { beforeCount: before?.recallCount || 0, afterCount: after.recallCount, distinctQuestions: after.userQueryHashes.length,
        duplicateTerminalDeduplicated: true, promotion: "not_accepted_real_time_span_insufficient" };
    });
    await scenario("forget-no-revival", async () => {
      const evidence = result.scenarios["forget-no-revival"];
      const originalChats = [first, second].map(target => path.join(paths.agentsDir, profile.id, "transcripts", target.id, "events.jsonl"))
        .map(file => ({ file, hash: digest(fs.readFileSync(file)) }));
      const checkIndex = async stageName => {
        const rows = (await search("琥珀望远镜")).results.concat((await search("验收计划")).results);
        evidence[stageName] = rows.map(row => ({ source: row.source, path: row.path, startLine: row.startLine, endLine: row.endLine,
          containsForgottenMarker: String(row.snippet || "").includes(marker) }));
        check(!evidence[stageName].some(row => row.containsForgottenMarker), "FORGOTTEN_INDEX_VISIBLE");
      };
      const checkPromotion = async stageName => {
        const host = service.memoryEngine.host(profile.id), retained = (await recallEntries()).filter(entry => entry.snippet?.includes(marker));
        const options = { workspaceDir: host.workspaceDir, nowMs: Date.now() };
        const eligible = await host.run(() => core.rankShortTermPromotionCandidates(options));
        const ranked = eligible.filter(entry => entry.snippet?.includes(marker));
        let reconstructable = 0;
        for (const candidate of retained) if (await host.run(() => core.rehydratePromotionCandidate(host.workspaceDir, candidate))) reconstructable++;
        evidence[stageName] = { retainedCounters: retained.length, totalRecallCount: retained.reduce((sum, entry) => sum + entry.recallCount, 0),
          rankedAtDefaultThresholds: ranked.length, reconstructable };
        // The core keeps historical counters after source deletion. Their
        // existence is not promotion authority: rehydration must fail even
        // if the score were to qualify later. Also run the actual default
        // apply path on any currently qualifying forgotten candidates.
        check(reconstructable === 0, "FORGOTTEN_PROMOTION_SOURCE_VISIBLE");
        const canonical = path.join(host.workspaceDir, "MEMORY.md"), before = digest(fs.readFileSync(canonical));
        const outcome = await host.runWithSourceEvidence(() => core.applyShortTermPromotions({ ...options, agentId: profile.id, candidates: ranked }));
        Object.assign(evidence[stageName], { applied: outcome.applied, canonicalUnchanged: digest(fs.readFileSync(canonical)) === before });
        check(outcome.applied === 0 && evidence[stageName].canonicalUnchanged, "FORGOTTEN_PROMOTION_REVIVED");
        check([original.id, corrected.id, daily.id].every(id => service.memoryStore.get(profile.id, id)?.status !== "active"), "FORGOTTEN_RECORD_ACTIVE");
      };
      const target = session();
      const forgotten = await send(target, `请忘记验收计划和琥珀望远镜校准信息。请分别调用 memory_forget 撤回记忆 ${corrected.id} 和 ${daily.id}，两次 sourceQuote 都使用“请忘记验收计划和琥珀望远镜校准信息”。`, "forget");
      check(hasTool(forgotten, "memory_forget"), "FORGET_TOOL_MISSING");
      check([original.id, corrected.id, daily.id].every(id => service.memoryStore.get(profile.id, id)?.status !== "active"), "FORGOTTEN_RECORD_ACTIVE");
      const reply = await send(session(), "我之前验收计划的颜色和琥珀望远镜校准编号是什么？若已遗忘请回答不知道。", "after-forget");
      check(!reply.answer.includes(marker) && !reply.recall.includes(marker), "FORGOTTEN_CONTEXT_VISIBLE");
      await checkIndex("afterForgetSources");
      await checkPromotion("afterForgetPromotion");
      await service.memoryEngine.finishActiveMemoryRun(forgotten.run);
      await checkPromotion("afterDuplicatePromotion");
      check(evidence.afterDuplicatePromotion.totalRecallCount === evidence.afterForgetPromotion.totalRecallCount, "FORGOTTEN_DUPLICATE_COUNTED");
      await checkIndex("afterDuplicateSources");
      await stop(); await start(); await checkIndex("afterRestartSources");
      const restarted = await send(session(), "我之前验收计划的颜色和琥珀望远镜校准编号是什么？若已遗忘请回答不知道。", "after-forget-restart");
      check(!restarted.answer.includes(marker) && !restarted.recall.includes(marker), "FORGOTTEN_RESTART_CONTEXT_VISIBLE");
      await checkPromotion("afterRestartPromotion");
      check(originalChats.every(({ file, hash }) => digest(fs.readFileSync(file)) === hash), "FORGET_CHANGED_ORIGINAL_CHAT");
      return { activeRecords: 0, indexedOrInjected: false, duplicateTerminalRevived: false, serviceRestarted: true, originalChatFilesUnchanged: true };
    });
    await scenario("diagnostics", async () => {
      const target = session();
      const empty = await send(target, "你还记得我之前用来校准不存在的紫色冰山的机器型号吗？找不到就回答不知道。", "no-result");
      const host = service.memoryEngine.host(profile.id), records = host.database.db.prepare("SELECT value FROM memory_state WHERE namespace='active-memory-diagnostics' AND value IS NOT NULL").all().map(row => JSON.parse(row.value));
      const runKey = digest(empty.run.id).slice(0, 16), own = records.filter(record => record.runKey === runKey);
      const status = await service.memoryEngine.activeMemory.status.read({ profileId: profile.id, sessionKey: target.sessionKey, includeTrace: false });
      const evidence = result.scenarios.diagnostics;
      evidence.liveNoResult = { outcome: status.outcome, errors: own, sessionKey: digest(target.sessionKey).slice(0, 16) };
      check(["empty", "no_relevant_memory"].includes(status.outcome) && !own.some(record => ["failed", "timeout", "error"].includes(record.outcome)), "NO_RESULT_DIAGNOSTIC_MISSING");
      evidence.controlledFaults = {};
      await controlledRecallFaults(service, profile, session, evidence.controlledFaults);
      return { liveNoResult: evidence.liveNoResult, controlledFaults: evidence.controlledFaults };
    });
    if (config.rollbackSource) {
      stage("downgrade");
      const before = digest(JSON.stringify(service.memoryStore._files(profile.id))); await stop();
      const old = require(path.join(config.rollbackSource, "app/agent-service/server.js")).createAgentService({ ...serviceOptions,
        memoryCoreConfig: { memory: { search: { provider: "none" } }, plugins: { entries: { "active-memory": { enabled: false } } } } });
      try {
        await old.start(); const oldHost = old.memoryEngine.host(profile.id); await oldHost.searchIndex.sync();
        check(digest(JSON.stringify(old.memoryStore._files(profile.id))) === before, "DOWNGRADE_SOURCE_CHANGED");
        result.rollback = { status: "passed", source: config.rollbackSource, indexRebuilt: true, canonicalFilesUnchanged: true,
          retainedNamespaces: oldHost.database.db.prepare("SELECT DISTINCT namespace FROM memory_state WHERE namespace IN ('active-memory-diagnostics','recall-signal-receipts')").all().map(row => row.namespace) };
      } finally { await old.stop({ notify: false }); result.serviceStopped = true; }
    }
    result.status = "passed";
  } catch (error) { result.errorCode = safeCode(error); }
  finally {
    result.runtimeProgress = runtimeProgress.snapshot();
    if (service && active) {
      try {
        if (profile) result.diagnostics = service.memoryEngine.host(profile.id).database.db.prepare("SELECT value FROM memory_state WHERE namespace='active-memory-diagnostics' AND value IS NOT NULL").all().map(row => JSON.parse(row.value));
        await stop(); result.serviceStopped = true;
      } catch (error) { result.stopErrorCode = safeCode(error); result.status = "failed"; }
    }
    const evidencePath = path.join(root, "mcp-fixture-io.jsonl");
    if (fs.existsSync(evidencePath)) {
      const scrub = value => typeof value === "string" ? redactDiagnostic(value, secrets)
        : Array.isArray(value) ? value.map(scrub)
          : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)])) : value;
      const bytes = fs.readFileSync(evidencePath);
      if (bytes.length <= 4 * 1024 * 1024) result.mcpEvidence = bytes.toString("utf8").trim().split("\n").filter(Boolean).map(line => scrub(JSON.parse(line)));
      else { result.evidenceErrorCode = "MEMORY_REPAIR_EVIDENCE_TOO_LARGE"; result.status = "failed"; }
    }
    key.fill(0); result.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
    if (result.status !== "passed") process.exitCode = 1;
  }
}

if (require.main === module) main().catch(error => { process.stderr.write(safeCode(error) + "\n"); process.exitCode = 1; });
module.exports = { controlledRecallFaults, hasColorAnswer, terminalFailureDetail, recallResponseShape, createRuntimeProgress, observeOpenCodeHost, observeModelGateway, writeLiveMcpLauncher };
