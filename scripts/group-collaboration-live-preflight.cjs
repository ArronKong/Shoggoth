#!/usr/bin/env node
"use strict";

// Read-only L3 inventory. This does not instantiate a Backend or Runtime,
// refresh authentication, send a model request, create a group, or stop a run.
// Only allowlisted metadata is returned; credential text and control nonces are
// never serialized. Presence/format is explicitly weaker than Provider proof.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { resolveCanonicalServicePaths } = require("../app/agent-service/paths");
const { createRuntimeCliAuth, AUTH_SPECS } = require("../app/runtime-cli-auth");
const { DEFAULT_RUNTIME_ACCOUNTS } = require("../app/agent-service/runtime-account");
const { isRuntimeAvailable } = require("../app/runtime-availability");
const { resolveCodexRuntimeLayout } = require("../app/agent-service/codex-runtime-paths");
const { resolveOpenclawBin, resolveOpenclawProgram } = require("../app/cli-runtime/openclaw");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { PROTOCOL_VERSION } = require("../app/agent-service/server");
const yaml = require("js-yaml");
const REPO = path.resolve(__dirname, "..");
const terminal = new Set(["completed", "failed", "canceled", "interrupted", "skipped"]);
const safeCode = error => /^[A-Z][A-Z0-9_]{0,100}$/u.test(error?.code || "") ? error.code : "UNAVAILABLE";
const opaque = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value) ? value : null;
const model = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,200}$/u.test(value)
  && !value.includes("://") ? value : null;
const version = value => typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+.][A-Za-z0-9.-]+)?$/u.test(value) ? value : null;
function readText(target, { privateFile = false, maxBytes = 2 * 1024 * 1024 } = {}) {
  let fd;
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes || process.getuid && stat.uid !== process.getuid()
      || privateFile && (stat.mode & 0o077) !== 0) return { state: "unsafe" };
    fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | fs.constants.O_NONBLOCK);
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) return { state: "changed" };
    const text = fs.readFileSync(fd, "utf8"), current = fs.lstatSync(target);
    if (current.dev !== stat.dev || current.ino !== stat.ino || Buffer.byteLength(text) > maxBytes) return { state: "changed" };
    return { state: "read", text };
  } catch (error) { return { state: error?.code === "ENOENT" ? "missing" : "unavailable", errorCode: safeCode(error) }; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function readData(target, options = {}, format = "json") {
  const record = readText(target, options);
  if (record.state !== "read") return record;
  try { return { state: "parsed", data: format === "yaml" ? yaml.load(record.text) : JSON.parse(record.text) }; }
  catch { return { state: "invalid" }; }
}
function credentialPresent(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 6) return false;
  return Object.entries(value).slice(0, 512).some(([key, child]) => typeof child === "string" && child.length > 0
    && /^(?:.*(?:token|secret|api[_-]?key)|key|access|refresh)$/iu.test(key)
    || child && typeof child === "object" && credentialPresent(child, depth + 1));
}
function credentialProbe(descriptor) {
  const runtime = descriptor.runtime;
  const file = descriptor.credentialFile ? path.join(descriptor.accountHome, descriptor.credentialFile)
    : runtime === "opencode" ? path.join(descriptor.accountHome, "opencode", "auth.json")
      : runtime === "deepseek-harness" ? path.join(descriptor.accountHome, ".credentials.yaml") : null;
  if (!file) return { state: "runtime_auth_probe_required", providerValidated: false };
  const parsed = readData(file, { privateFile: true, maxBytes: 256 * 1024 }, file.endsWith(".yaml") ? "yaml" : "json");
  if (parsed.state !== "parsed") return { state: parsed.state === "missing" ? "no_local_credential_file"
    : `credential_file_${parsed.state}`, file, providerValidated: false };
  const data = parsed.data;
  const present = credentialPresent(data);
  let kind = "provider_credentials";
  if (runtime === "codex") kind = data?.auth_mode === "chatgpt" ? "chatgpt"
    : typeof data?.OPENAI_API_KEY === "string" && data.OPENAI_API_KEY.length ? "api_key" : "unknown";
  return { state: present ? "credential_present_unverified" : "no_recognized_credential", kind, file, providerValidated: false };
}
function executable(target) {
  try { const real = fs.realpathSync(target), stat = fs.lstatSync(real);
    if (!stat.isFile() || stat.isSymbolicLink()) return null; fs.accessSync(real, fs.constants.X_OK); return real;
  } catch { return null; }
}
function bundledCandidate(repoRoot, resourcesPath = null) {
  try { const layout = resolveCodexRuntimeLayout({ repoRoot, packaged: resourcesPath !== null,
    ...(resourcesPath ? { resourcesPath } : {}) });
    return { state: "installed", binaryPath: layout.runtimePath, version: layout.version }; }
  catch (error) { return { state: "unavailable", errorCode: safeCode(error) }; }
}
function configuredNativeModel(descriptor) {
  if (!descriptor) return null;
  if (["codex", "grok-build"].includes(descriptor.runtime)) {
    const record = readText(path.join(descriptor.accountHome, "config.toml"), { maxBytes: 256 * 1024 });
    if (record.state !== "read") return null;
    return model(/^model\s*=\s*["']([^"'\r\n]+)["']\s*(?:#.*)?$/mu.exec(record.text)?.[1]);
  }
  if (descriptor.runtime === "pi") {
    const record = readData(path.join(descriptor.accountHome, "settings.json"), { maxBytes: 256 * 1024 });
    return model(record.data?.defaultModel);
  }
  if (descriptor.runtime === "deepseek-harness") {
    const record = readData(path.join(descriptor.accountHome, "settings.yaml"), { maxBytes: 256 * 1024 }, "yaml");
    return model(record.data?.model?.default ?? record.data?.model);
  }
  return null;
}
function readConfig(paths) {
  const record = readData(path.join(paths.userDataRoot, "config.json"), { maxBytes: 1024 * 1024 });
  return { state: record.state, config: record.state === "parsed" && record.data && typeof record.data === "object" ? record.data : {} };
}
async function getHttp(url, headers = {}) {
  const target = new URL(url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || !["http:", "https:"].includes(target.protocol)
    || target.username || target.password || target.search || target.hash) return { state: "nonlocal_or_unsafe_not_probed" };
  try {
    const response = await fetch(target, { method: "GET", redirect: "error", headers, signal: AbortSignal.timeout(2000) });
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body ?? []) { bytes += chunk.length; if (bytes > 1024 * 1024) {
      await response.body?.cancel?.().catch(() => {}); return { state: "too_large", status: response.status }; }
      chunks.push(Buffer.from(chunk)); }
    return { state: "responded", status: response.status, text: Buffer.concat(chunks).toString("utf8") };
  } catch (error) { return { state: "unavailable", errorCode: error?.name === "TimeoutError" ? "TIMEOUT" : "CONNECTION_UNAVAILABLE" }; }
}
async function existingService(paths) {
  const report = { state: "unavailable", profiles: [], accounts: [], bindingCoverage: "unavailable", runs: { observed: 0, active: 0, coverage: "unavailable" } };
  let token;
  try { token = readClientToken(paths); } catch (error) { report.errorCode = safeCode(error); return report; }
  const allowed = new Set(["service.status", "profile.list", "runtime.account.list", "agent.binding.list", "run.list"]);
  const call = (method, params) => {
    if (!allowed.has(method)) throw Object.assign(new Error("readonly method required"), { code: "PREFLIGHT_METHOD_FORBIDDEN" });
    return requestService(paths, { token, version: PROTOCOL_VERSION, method, ...(params ? { params } : {}) }, { timeoutMs: 5000 });
  };
  try { const status = await call("service.status"); report.state = status.healthy === true ? "healthy" : "unhealthy";
    report.serviceVersion = version(status.serviceVersion); report.protocolVersion = status.protocolVersion;
    report.maintenanceQuiesced = status.maintenanceQuiesced === true;
  } catch (error) { report.errorCode = safeCode(error); return report; }
  for (const [method, key, fixed] of [["profile.list", "profiles", { backendId: "shoggoth", enabledOnly: false }],
    ["runtime.account.list", "accounts", {}]]) {
    let cursor = null; const seen = new Set();
    try { for (let page = 0; page < 20; page++) {
      const result = await call(method, { ...fixed, cursor, limit: 20 });
      for (const item of result[key] ?? []) report[key].push(key === "profiles" ? {
        id: opaque(item.id), agentId: opaque(item.agentId), runtime: model(item.runtime), runtimeProfileId: opaque(item.runtimeProfileId),
        runtimeAccountId: opaque(item.runtimeAccountId), enabled: item.enabled === true,
        defaultBindingId: opaque(item.defaultBindingId), defaultModel: model(item.defaultModel), providerRef: opaque(item.providerRef),
      } : { id: opaque(item.id), runtime: model(item.runtime), kind: model(item.kind) });
      report[`${key}Coverage`] = result.hasMore ? "partial_limit" : "complete";
      if (!result.hasMore || !result.nextCursor || seen.has(result.nextCursor)) break;
      cursor = result.nextCursor; seen.add(cursor);
    } } catch (error) { report[`${key}Coverage`] = "unavailable"; report[`${key}ErrorCode`] = safeCode(error); }
  }
  report.bindingCoverage = "complete";
  for (const profile of report.profiles.filter(item => item.enabled)) {
    try { const state = await call("agent.binding.list", { profileId: profile.id });
      profile.bindings = (state.bindings ?? []).map(binding => ({ id: opaque(binding.id), runtime: model(binding.runtime),
        runtimeAccountId: opaque(binding.runtimeAccountId), runtimeProfileId: opaque(binding.runtimeProfileId), enabled: binding.enabled === true,
        selectedDefault: binding.id === state.defaultBindingId, model: model(binding.defaultModel) }));
    } catch (error) { profile.bindingErrorCode = safeCode(error); report.bindingCoverage = "partial_error"; }
  }
  let cursor = null; const seen = new Set();
  try { for (let page = 0; page < 20; page++) {
    const result = await call("run.list", { profileId: null, sessionKey: null, status: null, cursor, limit: 20 });
    report.runs.observed += (result.runs ?? []).length;
    report.runs.active += (result.runs ?? []).filter(run => !terminal.has(run.status)).length;
    report.runs.coverage = result.hasMore ? "partial_limit" : "complete";
    if (!result.hasMore || !result.nextCursor || seen.has(result.nextCursor)) break;
    cursor = result.nextCursor; seen.add(cursor);
  } } catch (error) { report.runs.coverage = "unavailable"; report.runs.errorCode = safeCode(error); }
  return report;
}
function externalCredentials(home, kind) {
  if (kind === "openclaw") {
    const record = readData(path.join(home, "openclaw.json"), { privateFile: true, maxBytes: 2 * 1024 * 1024 });
    const config = record.state === "parsed" ? record.data : {};
    return { configState: record.state, providerCredentialPresent: credentialPresent(config?.models?.providers),
      gatewayCredentialPresent: credentialPresent(config?.gateway?.auth),
      configuredModel: model(config?.agents?.defaults?.model?.primary ?? config?.agents?.defaults?.model), providerValidated: false };
  }
  const auth = readData(path.join(home, "auth.json"), { privateFile: true, maxBytes: 512 * 1024 });
  const env = readText(path.join(home, ".env"), { privateFile: true, maxBytes: 256 * 1024 });
  const config = readData(path.join(home, "config.yaml"), { maxBytes: 1024 * 1024 }, "yaml");
  const envKeys = env.state === "read" ? env.text.split(/\r?\n/u).filter(line => /^\s*(?:export\s+)?[A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET)\s*=\s*\S/u.test(line)).length : 0;
  return { authState: auth.state, providerCredentialPresent: auth.state === "parsed" && credentialPresent(auth.data) || envKeys > 0,
    credentialEnvEntries: envKeys, envState: env.state, configState: config.state,
    configuredModel: model(config.data?.model?.default ?? config.data?.model), providerValidated: false };
}
async function externalInventory(paths, rawConfig) {
  const descriptorResult = await getHttp("http://127.0.0.1:18799/__api/backends");
  let descriptors = [];
  if (descriptorResult.status === 200) try { descriptors = JSON.parse(descriptorResult.text).backends ?? []; } catch {}
  const disabled = new Set(Array.isArray(rawConfig.disabledBackends) ? rawConfig.disabledBackends : []);
  const openclawHome = path.resolve(process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw"));
  const ocResolved = resolveOpenclawBin(), openclawBin = executable(ocResolved);
  const hermesHome = path.resolve(process.env.HERMES_HOME || path.join(os.homedir(), ".hermes"));
  const hermesBin = [process.env.HERMES_BIN, path.join(os.homedir(), ".local", "bin", "hermes"),
    path.join(hermesHome, "hermes-agent", "venv", "bin", "hermes"), "/opt/homebrew/bin/hermes", "/usr/local/bin/hermes"]
    .filter(Boolean).map(executable).find(Boolean) ?? null;
  let gateway = { state: "not_configured" };
  if (typeof rawConfig.gatewayUrl === "string" && rawConfig.gatewayUrl) try {
    const url = new URL(rawConfig.gatewayUrl); url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = "/healthz"; url.search = ""; url.hash = "";
    const response = await getHttp(url);
    gateway = { state: response.state, status: response.status ?? null, authenticatedProvider: false };
  } catch { gateway = { state: "invalid_configuration" }; }
  const dashboards = [];
  if (rawConfig.hermesMode !== "remote") {
    const profileDirs = (() => { try { return fs.readdirSync(path.join(hermesHome, "profiles"), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && /^[A-Za-z0-9._-]{1,128}$/u.test(entry.name) && !entry.name.startsWith("."))
      .map(entry => entry.name).sort(); } catch { return []; } })();
    for (const [index, name] of ["default", ...profileDirs].slice(0, 32).entries()) {
      const home = name === "default" ? hermesHome : path.join(hermesHome, "profiles", name);
      const baseUrl = `http://127.0.0.1:${9119 + index}`;
      const html = await getHttp(baseUrl);
      const token = html.status === 200 ? /__HERMES_SESSION_TOKEN__="([^"\r\n]{1,4096})"/u.exec(html.text)?.[1] : null;
      let status = { state: token ? "token_observed" : html.state, authenticatedDashboard: false, identityMatchesHome: false };
      if (token) {
        const response = await getHttp(`${baseUrl}/api/status`, { Authorization: `Bearer ${token}` });
        if (response.status === 200) try { const data = JSON.parse(response.text);
          status = { state: "responded", authenticatedDashboard: true,
            identityMatchesHome: typeof data.hermes_home === "string" && path.resolve(data.hermes_home) === home,
            version: version(data.version) };
        } catch { status.state = "invalid_response"; }
        else status = { state: response.state, status: response.status ?? null, authenticatedDashboard: false, identityMatchesHome: false };
      }
      dashboards.push({ profile: name, home, port: 9119 + index, status, credentials: externalCredentials(home, "hermes") });
    }
  }
  return [
    { adapter: "openclaw", enabled: !disabled.has("openclaw"), configuredHostMode: rawConfig.openclawPluginHostMode ?? "existing",
      observedConnectionMode: descriptors.find(item => item.id === "openclaw")?.connectionMode ?? null,
      installation: openclawBin ? { state: "installed", binaryPath: openclawBin, programPath: resolveOpenclawProgram(openclawBin).entryPath } : { state: "not_installed" },
      home: openclawHome, credentials: externalCredentials(openclawHome, "openclaw"), gateway,
      toolCollaboration: "requires_isolated_real_chain", providerValidated: false },
    { adapter: "hermes", enabled: !disabled.has("hermes"), configuredHostMode: rawConfig.hermesPluginHostMode ?? "existing",
      observedConnectionMode: descriptors.find(item => item.id === "hermes")?.connectionMode ?? null,
      installation: hermesBin ? { state: "installed", binaryPath: hermesBin } : { state: "not_installed" },
      home: hermesHome, mode: rawConfig.hermesMode === "remote" ? "remote" : "local", remoteCount: Array.isArray(rawConfig.hermesRemotes) ? rawConfig.hermesRemotes.length : 0,
      dashboards, toolCollaboration: "requires_isolated_real_chain", providerValidated: false },
  ];
}
async function collectReport() {
  const paths = resolveCanonicalServicePaths(), configRecord = readConfig(paths);
  const cli = createRuntimeCliAuth({ paths, repoRoot: REPO, homedir: os.homedir() });
  const service = await existingService(paths);
  const native = DEFAULT_RUNTIME_ACCOUNTS.map(account => {
    const descriptor = cli.find(item => item.runtimeAccountId === account.id);
    const profiles = service.profiles.filter(profile => profile.enabled
      && (profile.runtimeAccountId === account.id || profile.bindings?.some(binding => binding.enabled && binding.runtimeAccountId === account.id)));
    if (!isRuntimeAvailable(account.runtime)) return { runtime: account.runtime, runtimeAccountId: account.id,
      kind: account.kind, releaseSupported: false, classification: "release_policy_disabled", enabledProfileCount: profiles.length,
      installation: { state: "not_probed_disabled" }, auth: { state: "not_probed_disabled", providerValidated: false }, toolCollaboration: "unsupported" };
    const installed = descriptor?.binaryPath ? executable(descriptor.binaryPath) : null;
    const auth = descriptor ? credentialProbe(descriptor) : { state: "descriptor_unavailable", providerValidated: false };
    return { runtime: account.runtime, runtimeAccountId: account.id, kind: account.kind, releaseSupported: true,
      classification: !installed ? "source_executable_unavailable" : auth.state === "credential_present_unverified"
        ? "candidate_requires_live_auth_and_tool_chain" : auth.state === "no_local_credential_file"
          || auth.state === "no_recognized_credential" ? "local_auth_missing_requires_configuration_or_runtime_probe" : "auth_unconfirmed_requires_runtime_probe",
      enabledProfileCount: profiles.length, installation: { state: installed ? "installed" : "unavailable", binaryPath: installed },
      accountHome: descriptor?.accountHome ?? null, configuredModel: configuredNativeModel(descriptor), auth, toolCollaboration: "requires_isolated_real_chain", providerValidated: false };
  });
  return { reportVersion: 1, sampledAt: new Date().toISOString(), evidence: "read_only_real_local_metadata",
    mutationCount: 0, providerCalls: 0, runtimeProcessesStarted: 0, acceptedToolChains: 0,
    config: { state: configRecord.state, groupChatEnabled: configRecord.config.groupChatEnabled !== false,
      groupCollaborationEnabled: configRecord.config.groupCollaborationEnabled !== false },
    service, native, bundledCodex: { currentCheckout: bundledCandidate(REPO),
      primaryCheckout: bundledCandidate(path.join(os.homedir(), "Documents", "claude", "Shoggoth")),
      installedApp: bundledCandidate(REPO, "/Applications/Shoggoth.app/Contents/Resources") },
    external: await externalInventory(paths, configRecord.config),
    limitations: ["Credential presence is not successful authentication or model availability.",
      "No auth.read, login, model catalog, chat, group creation or stop endpoint was called.",
      "Hermes dashboard authentication proves transport identity only; it does not prove model credentials.",
      "All released adapters still require a separate isolated read-handoff/tool/result chain; no previous fixture pass is inherited.",
      "W8 remains eight scenarios times three mixed groups times three rounds, plus at least one actual chain per supported adapter."] };
}
function outputPath(args) {
  if (args.length !== 2 || args[0] !== "--output" || !path.isAbsolute(args[1]) || path.dirname(args[1]) !== "/private/tmp"
    || !/^group-collaboration-live-preflight-[A-Za-z0-9._-]+\.json$/u.test(path.basename(args[1])))
    throw Object.assign(new Error("fresh private tmp output required"), { code: "PREFLIGHT_OUTPUT_INVALID" });
  return args[1];
}
async function main(args = process.argv.slice(2)) {
  const output = outputPath(args), report = await collectReport();
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(JSON.stringify({ output, service: report.service.state, serviceVersion: report.service.serviceVersion,
    native: report.native.map(item => ({ runtime: item.runtime, runtimeAccountId: item.runtimeAccountId, classification: item.classification,
      enabledProfileCount: item.enabledProfileCount, auth: item.auth.state })),
    external: report.external.map(item => ({ adapter: item.adapter, installed: item.installation.state, mode: item.observedConnectionMode,
      providerValidated: item.providerValidated, authenticatedDashboards: item.dashboards?.filter(row => row.status.authenticatedDashboard && row.status.identityMatchesHome).length })),
    providerCalls: 0, acceptedToolChains: 0 }) + "\n");
  return report;
}
if (require.main === module) main().catch(error => { process.stderr.write(JSON.stringify({ status: "failed", errorCode: safeCode(error) }) + "\n"); process.exitCode = 1; });
module.exports = { readText, readData, credentialPresent, credentialProbe, existingService, collectReport, outputPath };
