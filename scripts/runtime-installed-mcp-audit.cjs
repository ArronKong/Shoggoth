#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { resolveCanonicalServicePaths } = require("../app/agent-service/paths");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const { SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");
const { assertStableAppPaths } = require("../app/agent-service/bundle-paths");
const { assertCodeIdentity, CODEX_TEAM_IDENTIFIER, CODEX_DESIGNATED_REQUIREMENT } = require("../app/agent-service/code-identity");
const { CodexJsonlRpcClient } = require("../app/agent-service/codex-jsonl-rpc");
const { descendantIdentities, stillOwned, killOwnedProcesses } = require("./runtime-v2-live-acceptance.cjs");

const fail = code => Object.assign(new Error(code), { code });
function parseOptions(args) {
  const accepted = new Set(["--mode", "--app", "--profile-id", "--binding-id", "--expected-version", "--output"]);
  const data = new Map();
  for (let index = 0; index < args.length; index += 2) {
    if (!accepted.has(args[index]) || data.has(args[index]) || !args[index + 1] || args[index + 1].startsWith("--")) throw fail("AUDIT_ARGS_INVALID");
    data.set(args[index], args[index + 1]);
  }
  const mode = data.get("--mode") || "plan", appPath = data.get("--app") || "/Applications/Shoggoth.app";
  if (!["plan", "live"].includes(mode) || path.dirname(appPath) !== "/Applications" || !/^[^/]+\.app$/u.test(path.basename(appPath))) throw fail("AUDIT_ARGS_INVALID");
  for (const name of ["--profile-id", "--binding-id"]) if (data.has(name)
    && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(data.get(name))) throw fail("AUDIT_ARGS_INVALID");
  const output = data.get("--output"), version = data.get("--expected-version");
  if ((output && !path.isAbsolute(output)) || (version && !/^\d+\.\d+\.\d+$/u.test(version))
    || (mode === "live" && (!output || !version || !data.has("--profile-id")))) throw fail("AUDIT_ARGS_INVALID");
  return { mode, appPath, output, version, profileId: data.get("--profile-id"), bindingId: data.get("--binding-id") };
}

async function resolveBinding(call, options) {
  let cursor = null, profile = null;
  for (let page = 0; page < 100; page++) {
    const result = await call("profile.list", { backendId: "shoggoth", cursor, limit: 100, enabledOnly: true });
    profile = result.profiles.find(item => item.id === options.profileId) || profile;
    if (profile || !result.nextCursor) break;
    cursor = result.nextCursor;
  }
  if (!profile?.enabled) throw fail("AUDIT_PROFILE_UNAVAILABLE");
  const state = await call("agent.binding.list", { profileId: options.profileId });
  const bindings = state.bindings.filter(binding => binding.enabled && binding.runtime === "codex"
    && binding.runtimeAccountId === SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID
    && (!options.bindingId || binding.id === options.bindingId));
  if (bindings.length !== 1) throw fail("AUDIT_INTERNAL_CODEX_BINDING_REQUIRED");
  await requireIdle(call, options.profileId);
  return bindings[0];
}
async function requireIdle(call, profileId) {
  const impact = await call("service.stopImpact", {});
  const queued = await call("run.list", { profileId, sessionKey: null, status: "queued", cursor: null, limit: 1 });
  if (impact.availability !== "available" || impact.totalCount !== 0 || queued.runs.length !== 0) throw fail("AUDIT_SERVICE_BUSY");
}

async function inspectHandshake(rpc, workspace, expectedVersion, signal) {
  await rpc.request("initialize", { clientInfo: { name: "shoggoth-mcp-readonly-audit", version: "1" },
    capabilities: { experimentalApi: false, requestAttestation: false } }, { signal });
  await rpc.notify("initialized");
  const started = await rpc.request("thread/start", { cwd: workspace, ephemeral: true,
    approvalPolicy: "never", sandbox: "read-only", threadSource: "shoggoth:chat" }, { signal });
  if (typeof started.thread?.id !== "string") throw fail("AUDIT_EPHEMERAL_THREAD_INVALID");
  const status = await rpc.request("mcpServerStatus/list", { threadId: started.thread.id,
    detail: "toolsAndAuthOnly", limit: 100, cursor: null }, { signal });
  const server = status.data?.find(item => item.name === "shoggoth");
  const names = server?.tools && Object.keys(server.tools);
  if (!server || server.serverInfo?.name !== "shoggoth" || server.serverInfo.version !== expectedVersion
    || !["unknown", "unsupported", "notLoggedIn", "bearerToken", "oAuth"].includes(server.authStatus)
    || !names?.length || names.some(name => !/^[A-Za-z0-9_.:-]{1,128}$/u.test(name))) throw fail("AUDIT_MCP_CATALOG_INVALID");
  return { helperVersion: server.serverInfo.version, toolCount: names.length,
    authStatus: server.authStatus, positiveAuthenticatedCatalog: true, ephemeralThread: true,
    modelTurnsSubmitted: 0, businessToolCalls: 0 };
}

async function execute(options) {
  if (options.mode === "plan") return { mode: "plan", evidence: "not-run", serviceRequests: 0,
    planned: "Read installed Service state, require idle, launch installed Codex ephemeral thread, list real signed MCP helper tools, exit.",
    forbidden: ["turn/start", "tools/call", "service.stop", "profile mutation"],
    limitation: "Positive MCP authentication/catalog only. No model request or business tool execution." };
  if (process.platform !== "darwin") throw fail("AUDIT_MACOS_REQUIRED");
  if (fs.existsSync(options.output)) throw fail("AUDIT_OUTPUT_ALREADY_EXISTS");
  const result = { version: 1, status: "failed", evidence: "installed-real-mcp-readonly-handshake",
    mutationScope: "Ephemeral native thread and transient MCP authentication session only; no product records or tools.",
    modelTurnsSubmitted: 0, businessToolCalls: 0 };
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/sg-mcp-audit-"));
  const owned = new Map();
  const abort = new AbortController();
  let child, rpc, exit, closed = false, interval, timeout;
  const capture = () => {
    if (!child?.pid || closed) return;
    for (const record of descendantIdentities(child.pid)) owned.set(record.pid, record);
  };
  const interrupted = () => { result.errorCode = "AUDIT_INTERRUPTED"; abort.abort(); };
  process.on("SIGTERM", interrupted); process.on("SIGINT", interrupted);
  try {
    fs.chmodSync(root, 0o700);
    const resourcesPath = path.join(options.appPath, "Contents", "Resources");
    const helper = path.join(options.appPath, "Contents", "MacOS", "Shoggoth");
    const codex = path.join(resourcesPath, "codex", "package", "bin", "codex");
    assertStableAppPaths({ appPath: options.appPath, executablePath: helper, resourcesPath,
      bootstrapPath: path.join(resourcesPath, "app.asar", "app", "bootstrap.js") });
    assertCodeIdentity(codex, { teamIdentifier: CODEX_TEAM_IDENTIFIER, designatedRequirement: CODEX_DESIGNATED_REQUIREMENT });
    const appVersion = spawnSync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-",
      path.join(options.appPath, "Contents", "Info.plist")], { encoding: "utf8", timeout: 5000, maxBuffer: 4096 });
    if (appVersion.status !== 0 || appVersion.stdout.trim() !== options.version) throw fail("AUDIT_APP_VERSION_MISMATCH");
    const paths = resolveCanonicalServicePaths();
    const token = readClientToken(paths);
    const call = (method, params) => requestService(paths, { version: SERVICE_PROTOCOL_VERSION, token, method, params }, { timeoutMs: 10000 });
    const before = await call("service.status", {});
    if (!before.healthy || before.serviceVersion !== options.version
      || before.protocolVersion !== SERVICE_PROTOCOL_VERSION) throw fail("AUDIT_SERVICE_VERSION_MISMATCH");
    const binding = await resolveBinding(call, options);
    const workspace = path.join(root, "workspace"), codexHome = path.join(root, "codex");
    fs.mkdirSync(workspace, { mode: 0o700 }); fs.mkdirSync(codexHome, { mode: 0o700 });
    const overrides = ["check_for_update_on_startup=false", "cli_auth_credentials_store=\"file\"",
      "features.memories=false", `mcp_servers.shoggoth.command=${JSON.stringify(helper)}`,
      `mcp_servers.shoggoth.args=${JSON.stringify(["--shoggoth-internal-role=mcp",
        `--shoggoth-runtime-profile=${binding.runtimeProfileId}`, `--shoggoth-runtime-account=${binding.runtimeAccountId}`])}`,
      "mcp_servers.shoggoth.required=true", "mcp_servers.shoggoth.startup_timeout_sec=60"];
    await requireIdle(call, options.profileId);
    if (abort.signal.aborted) throw fail("AUDIT_INTERRUPTED");
    child = spawn(codex, [...overrides.flatMap(value => ["-c", value]), "app-server", "--stdio"], {
      cwd: workspace, env: { HOME: os.userInfo().homedir, CODEX_HOME: codexHome, TMPDIR: root,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" },
      detached: true, stdio: ["pipe", "pipe", "pipe"] });
    exit = new Promise(resolve => child.once("close", (code, signal) => { closed = true; resolve({ code, signal }); }));
    child.on("error", () => abort.abort());
    capture(); interval = setInterval(() => { try { capture(); } catch { abort.abort(); } }, 250);
    timeout = setTimeout(() => { result.errorCode = "AUDIT_TOTAL_TIMEOUT"; abort.abort(); }, 90000);
    rpc = new CodexJsonlRpcClient(child, { requestTimeoutMs: 65000, maxFrameBytes: 4 * 1024 * 1024,
      serverRequestGuard: () => { throw fail("AUDIT_UNEXPECTED_SERVER_REQUEST"); } });
    result.handshake = await inspectHandshake(rpc, workspace, options.version, abort.signal);
    child.stdin.end();
    let exitTimer;
    try { result.naturalExit = await Promise.race([exit, new Promise((_, reject) => {
      exitTimer = setTimeout(() => reject(fail("AUDIT_NATIVE_EXIT_TIMEOUT")), 15000);
    })]); } finally { clearTimeout(exitTimer); }
    if (result.naturalExit.code !== 0 || result.naturalExit.signal !== null) throw fail("AUDIT_NATIVE_EXIT_FAILED");
    const after = await call("service.status", {});
    if (!after.healthy || after.pid !== before.pid || after.instanceNonce !== before.instanceNonce) throw fail("AUDIT_SERVICE_CHANGED");
    result.serviceUnchanged = true; result.serviceVersion = after.serviceVersion;
    result.status = "passed";
  } catch (error) {
    result.errorCode ||= /^AUDIT_[A-Z0-9_]+$/u.test(error?.code || "") ? error.code : "AUDIT_HANDSHAKE_FAILED";
    if (/^(?:MCP|BOOTSTRAP)_[A-Z0-9_]+$/u.test(error?.startupDiagnostic || "")) result.startupDiagnostic = error.startupDiagnostic;
  } finally {
    clearInterval(interval); clearTimeout(timeout);
    try { capture(); } catch {}
    await rpc?.terminate();
    result.remainingOwnedProcesses = [...owned.values()].filter(stillOwned).length;
    if (result.status === "passed" && result.remainingOwnedProcesses) {
      result.status = "failed"; result.errorCode = "AUDIT_NATIVE_CLEANUP_REQUIRED";
    }
    result.remainingAfterCleanup = await killOwnedProcesses([...owned.values()]);
    if (child && !closed) { try { child.kill("SIGKILL"); } catch {} await exit; }
    if (result.remainingAfterCleanup !== 0) { result.status = "failed"; result.errorCode = "AUDIT_CLEANUP_UNCONFIRMED"; }
    process.off("SIGTERM", interrupted); process.off("SIGINT", interrupted);
    fs.rmSync(root, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return result;
}

if (require.main === module) Promise.resolve().then(() => execute(parseOptions(process.argv.slice(2)))).then(result => {
  console.log(JSON.stringify(result)); if (result.status === "failed") process.exitCode = 1;
}).catch(error => { console.error(/^AUDIT_[A-Z0-9_]+$/u.test(error?.code || "") ? error.code : "AUDIT_LOCAL_FAILURE"); process.exitCode = 1; });
module.exports = { parseOptions, resolveBinding, requireIdle, inspectHandshake, execute };
