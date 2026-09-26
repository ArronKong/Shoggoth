"use strict";

// Uses the locally verified Pi 0.84.4 RPC launch shape. A caller must explicitly
// supply a CLI and a private credential config. No real account/home discovery.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function providerFailureCode(value) {
  const text = typeof value === "string" ? value : "";
  if (/quota|rate.?limit|too many requests|usage limit|insufficient[_ ]quota|\b429\b/iu.test(text)) return "HANDOFF_PROVIDER_LIMIT";
  if (/unauthori[sz]ed|authentication|invalid[_ ]grant|expired.*token|missing.*(?:credential|api.?key)|not logged|\b401\b|\b403\b/iu.test(text)) return "HANDOFF_PROVIDER_AUTH_FAILED";
  if (/HANDOFF_OTHER_ENDPOINT_DENIED|fetch failed|network|ENOTFOUND|EAI_AGAIN|ECONN|ETIMEDOUT|certificate|socket|TLS/iu.test(text)) return "HANDOFF_PROVIDER_NETWORK_FAILED";
  if (/unknown model|model.*not found|no.*model.*found|model.*unavailable|model.*not.*support/iu.test(text)) return "HANDOFF_PROVIDER_MODEL_UNAVAILABLE";
  if (/unknown option|invalid.*models\.json|invalid.*configuration|config.*invalid|cannot.*provider/iu.test(text)) return "HANDOFF_CLI_CONFIG_FAILED";
  return null;
}

function validateProxy(value) {
  if (value === undefined) return undefined;
  let proxy;
  try { proxy = new URL(value); } catch { throw new Error("HANDOFF_PROXY_INVALID"); }
  if (!["http:", "https:"].includes(proxy.protocol) || !["127.0.0.1", "[::1]", "localhost"].includes(proxy.hostname)
    || proxy.username || proxy.password || proxy.search || proxy.hash || proxy.pathname !== "/"
    || !proxy.port) throw new Error("HANDOFF_PROXY_INVALID");
  return proxy.origin;
}

function explicitProxyEnv(value) {
  const proxy = validateProxy(value);
  return proxy ? { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy,
    NO_PROXY: "", no_proxy: "", NODE_USE_ENV_PROXY: "1", SHOGGOTH_HANDOFF_PROXY: proxy } : {};
}

function readConfig(configPath) {
  const stat = fs.lstatSync(configPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384
    || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("HANDOFF_PRIVATE_CONFIG_REQUIRED");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!config || Object.keys(config).sort().join(",") !== "apiKey,baseUrl,contextWindow,model"
    || typeof config.apiKey !== "string" || !config.apiKey.trim() || config.apiKey.startsWith("!")
    || /[\r\n\0]/u.test(config.apiKey) || config.apiKey.length > 8192
    || typeof config.model !== "string" || !/^[a-zA-Z0-9._:/-]{1,256}$/u.test(config.model)
    || !Number.isSafeInteger(config.contextWindow) || config.contextWindow < 8192 || config.contextWindow > 2_000_000) throw new Error("HANDOFF_CONFIG_INVALID");
  const endpoint = new URL(config.baseUrl);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !(endpoint.protocol === "https:" || (endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1"))) throw new Error("HANDOFF_ENDPOINT_INVALID");
  return config;
}

function readPiAuth(authPath) {
  const stat = fs.lstatSync(authPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024
    || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("HANDOFF_PRIVATE_AUTH_REQUIRED");
  const source = JSON.parse(fs.readFileSync(authPath, "utf8"));
  const entry = source?.["openai-codex"];
  if (!entry || Object.getPrototypeOf(entry) !== Object.prototype || entry.type !== "oauth"
    || Object.keys(entry).some(key => !["type", "access", "refresh", "expires", "accountId"].includes(key))
    || ![entry.access, entry.refresh].every(value => typeof value === "string" && value.length > 0
      && value.length <= 65536 && !/[\r\n\0]/u.test(value))
    || !Number.isFinite(entry.expires) || entry.expires <= 0
    || (entry.accountId !== undefined && (typeof entry.accountId !== "string" || !/^[a-zA-Z0-9_-]{1,256}$/u.test(entry.accountId)))) {
    throw new Error("HANDOFF_OAUTH_INVALID");
  }
  return structuredClone(entry);
}

function writePiOAuthHome(agentDir, auth, model, { maxTokens = 1024 } = {}) {
  if (!/^[a-zA-Z0-9._:/-]{1,256}$/u.test(model)) throw new Error("HANDOFF_OAUTH_MODEL_INVALID");
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) throw new Error("HANDOFF_OAUTH_MODEL_INVALID");
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": auth }), { flag: "wx", mode: 0o600 });
  // Keep OAuth supplied by Pi's built-in provider, but explicitly define the
  // requested model so a fresh offline HOME does not need a remote model cache.
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "openai-codex": {
    baseUrl: "https://chatgpt.com/backend-api", api: "openai-codex-responses",
    models: [{ id: model, name: model, contextWindow: 128000, maxTokens, reasoning: true, input: ["text"] }],
  } } }), { flag: "wx", mode: 0o600 });
}

async function evaluatePi({ cliPath, configPath, authPath, model, context, questions, proxy }) {
  if (!path.isAbsolute(cliPath) || !fs.statSync(cliPath).isFile()) throw new Error("HANDOFF_CLI_INVALID");
  if (!!configPath === !!authPath) throw new Error("HANDOFF_AUTH_MODE_INVALID");
  const oauth = authPath ? readPiAuth(authPath) : null;
  const config = oauth ? { model, baseUrl: "https://chatgpt.com/backend-api" } : readConfig(configPath);
  const provider = oauth ? "openai-codex" : "handoff-evaluation";
  const secrets = oauth ? [oauth.access, oauth.refresh] : [config.apiKey];
  const proxyEnv = explicitProxyEnv(proxy);
  const scratch = fs.mkdtempSync("/tmp/sghandoff-pi-");
  fs.chmodSync(scratch, 0o700);
  const agentDir = path.join(scratch, "agent");
  fs.mkdirSync(agentDir, { mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ enableInstallTelemetry: false,
    defaultProjectTrust: "never", compaction: { enabled: false } }), { mode: 0o600 });
  if (oauth) writePiOAuthHome(agentDir, oauth, model);
  else fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "handoff-evaluation": {
    baseUrl: config.baseUrl, api: "openai-completions", apiKey: config.apiKey,
    models: [{ id: config.model, name: "Explicit handoff evaluation target", contextWindow: config.contextWindow,
      maxTokens: 1024, reasoning: false, input: ["text"] }],
  } } }), { mode: 0o600 });
  let child, timer, exitTimer, killTimer, failure, diagnosticCode = null;
  let closed = false;
  const events = [];
  let notify = null;
  let byteCount = 0, pending = "";
  const fail = code => { failure ||= new Error(code); notify?.(); };
  try {
    child = spawn(process.execPath, ["--require", path.join(__dirname, "fixtures/runtime-handoff-network-guard.cjs"), cliPath,
      "--mode", "rpc", "--no-session", "--offline", "--no-tools", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--provider", provider,
      "--model", config.model, "--thinking", "off"], { cwd: scratch, env: {
      HOME: scratch, PI_CODING_AGENT_DIR: agentDir, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: "en_US.UTF-8",
      PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
      SHOGGOTH_HANDOFF_ENDPOINT_ORIGIN: new URL(config.baseUrl).origin,
      ...(oauth ? { SHOGGOTH_HANDOFF_OAUTH: "openai-codex" } : {}),
      ...proxyEnv,
    }, stdio: ["pipe", "pipe", "pipe"] });
    const exit = new Promise(resolve => child.once("close", (code, signal) => { closed = true; resolve({ code, signal }); notify?.(); }));
    child.on("error", () => fail("HANDOFF_CLI_SPAWN_FAILED"));
    child.stdin.on("error", () => fail("HANDOFF_CLI_INPUT_FAILED"));
    child.stderr.on("data", chunk => {
      byteCount += chunk.length;
      diagnosticCode ||= providerFailureCode(chunk.toString("utf8"));
      if (byteCount > 2 * 1024 * 1024) fail("HANDOFF_CLI_OUTPUT_LIMIT");
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      byteCount += Buffer.byteLength(chunk);
      if (byteCount > 2 * 1024 * 1024) { fail("HANDOFF_CLI_OUTPUT_LIMIT"); return; }
      pending += chunk;
      for (let newline; (newline = pending.indexOf("\n")) >= 0;) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch { fail("HANDOFF_CLI_PROTOCOL_INVALID"); }
      }
      notify?.();
    });
    const next = async (predicate, timeoutMs) => {
      let expired = false;
      timer = setTimeout(() => { expired = true; notify?.(); }, timeoutMs);
      try {
        for (;;) {
          if (failure) throw failure;
          while (events.length) { const event = events.shift(); if (predicate(event)) return event; }
          if (closed) throw new Error(diagnosticCode || "HANDOFF_CLI_EARLY_EXIT");
          if (expired) throw new Error("HANDOFF_CLI_TIMEOUT");
          await new Promise(resolve => { notify = resolve; });
        }
      } finally { clearTimeout(timer); notify = null; }
    };
    child.stdin.write('{"id":"state","type":"get_state"}\n');
    const state = await next(event => event.id === "state" && event.type === "response", 30_000);
    if (state.success !== true || state.data?.model?.provider !== provider
      || state.data.model.id !== config.model || state.data.model.baseUrl !== config.baseUrl) throw new Error("HANDOFF_MODEL_ISOLATION_FAILED");
    const answers = {};
    for (const [index, question] of questions.entries()) {
      const message = (index === 0 ? `${context}\n\n` : "")
        + `Answer this question from the retained conversation. Do not use tools. If a fact is missing say unknown. Use a concise plain-text answer.\n${question.question}`;
      child.stdin.write(`${JSON.stringify({ id: question.id, type: "prompt", message })}\n`);
      const ended = await next(event => {
        if (event.type === "response" && event.success === false) throw new Error(providerFailureCode(event.error) || "HANDOFF_PROVIDER_REQUEST_FAILED");
        return event.type === "agent_end";
      }, 120_000);
      const assistantError = (ended.messages || []).find(message => message.role === "assistant"
        && ["error", "aborted"].includes(message.stopReason));
      if (assistantError) throw new Error(providerFailureCode(assistantError.errorMessage) || "HANDOFF_PROVIDER_RESPONSE_FAILED");
      const text = (ended.messages || []).filter(message => message.role === "assistant")
        .flatMap(message => message.content || []).filter(part => part.type === "text").map(part => part.text).join("\n");
      if (!text || Buffer.byteLength(text) > 4096 || secrets.some(secret => text.includes(secret))) throw new Error("HANDOFF_MODEL_ANSWER_INVALID");
      answers[question.id] = text;
    }
    child.stdin.end();
    const exited = await Promise.race([exit, new Promise((_, reject) => {
      exitTimer = setTimeout(() => reject(new Error("HANDOFF_CLI_EXIT_TIMEOUT")), 5000);
    })]);
    if (exited.code !== 0 || exited.signal !== null) throw new Error("HANDOFF_CLI_EXIT_FAILED");
    return { answers, provider, model: config.model, naturalExitCode: exited.code, billedCost: "unmeasured" };
  } finally {
    clearTimeout(timer); clearTimeout(exitTimer);
    if (child && !closed) {
      child.kill("SIGTERM");
      await new Promise(resolve => {
        child.once("close", resolve);
        killTimer = setTimeout(() => { child.kill("SIGKILL"); }, 1000);
      });
    }
    clearTimeout(killTimer);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

module.exports = { readConfig, readPiAuth, writePiOAuthHome, providerFailureCode, validateProxy, explicitProxyEnv, evaluatePi };
