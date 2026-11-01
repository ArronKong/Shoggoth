"use strict";

// Explicit source paths only. No account discovery, installed Service writes,
// Keychain calls, plugins, hooks, or native conversation imports.
const fs = require("node:fs"), path = require("node:path");
const { readPiAuth } = require("./runtime-handoff-pi-evaluator.cjs");
const { modelConnectionConfig } = require("../app/agent-service/opencode-runtime-host");
const RUNTIMES = Object.freeze({ pi: ["pi", ".pi/agent/auth.json"], "grok-build": ["grok", ".grok/auth.json"],
  antigravity: ["agy", null], opencode: ["opencode", ".local/share/opencode/auth.json"], "deepseek-harness": ["dsh", ".dsh/.credentials.yaml"] });
const fail = code => { throw Object.assign(new Error(code), { code }); };
function readSource(target, credential = true) {
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024
    || process.getuid && stat.uid !== process.getuid() || credential && (stat.mode & 0o077) !== 0) fail("MEMORY_LIVE_SOURCE_UNSAFE");
  return fs.readFileSync(target);
}
function sources(options) {
  return [options.runtimeAuth, ...(options.runtimeConfig ? [options.runtimeConfig] : []),
    ...(options.runtime === "antigravity" ? [options.runtimeBin, path.join(path.dirname(options.runtimeBin), "localharness_external")] : [])];
}
async function prepare(root, options) {
  const selected = RUNTIMES[options.runtime]; if (!selected) fail("MEMORY_LIVE_RUNTIME_UNSUPPORTED");
  const [name, relative] = selected, copied = [];
  const write = (relativePath, bytes) => {
    const target = path.join(root, relativePath); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600 }); copied.push(relativePath);
  };
  const bytes = readSource(options.runtimeAuth);
  if (options.runtime === "antigravity") {
    return require("./shoggoth-memory-live-isolation.cjs").prepareAntigravityFileAccount(root, options, bytes);
  }
  let isolation;
  if (options.runtime === "grok-build" && options.runtimeSocketDirectory) {
    isolation = require("./shoggoth-memory-live-isolation.cjs").prepareGrokSocketDenyAlias(root, options.runtimeSocketDirectory);
  }
  if (options.runtime === "pi") {
    write(relative, JSON.stringify({ "openai-codex": readPiAuth(options.runtimeAuth) }));
    write(".pi/agent/settings.json", JSON.stringify({ enableInstallTelemetry: false, defaultProjectTrust: "never",
      compaction: { enabled: false }, defaultProvider: "openai-codex" }));
  } else if (options.runtime === "opencode") {
    if (!options.runtimeConfig) fail("MEMORY_LIVE_CONFIG_REQUIRED");
    const auth = JSON.parse(bytes.toString("utf8"));
    const config = JSON.parse(modelConnectionConfig(readSource(options.runtimeConfig, false)));
    const providers = {};
    for (const [id, provider] of Object.entries(config.provider || {})) {
      if (!Object.hasOwn(auth, id)) continue;
      if (!["@ai-sdk/openai-compatible", "@ai-sdk/openai"].includes(provider.npm)) continue;
      const endpoint = new URL(provider.options?.baseURL);
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) fail("MEMORY_LIVE_ENDPOINT_UNSAFE");
      providers[id] = { ...(typeof provider.name === "string" ? { name: provider.name } : {}), npm: provider.npm,
        options: { baseURL: endpoint.href }, models: provider.models };
    }
    const ids = Object.keys(providers); if (!ids.length) fail("MEMORY_LIVE_CONFIG_NO_AUTHENTICATED_PROVIDER");
    write(relative, JSON.stringify(Object.fromEntries(ids.map(id => [id, auth[id]]))));
    write(".config/opencode/opencode.json", JSON.stringify({ provider: providers, enabled_providers: ids,
      ...(typeof config.model === "string" && ids.some(id => config.model.startsWith(`${id}/`)) ? { model: config.model } : {}) }));
  } else {
    if (options.runtime === "deepseek-harness") require("js-yaml").load(bytes.toString("utf8"));
    else JSON.parse(bytes.toString("utf8"));
    write(relative, bytes);
  }
  fs.symlinkSync(fs.realpathSync(options.runtimeBin), path.join(root, "bin", name));
  fs.symlinkSync(process.execPath, path.join(root, "bin", "node"));
  return { runtime: options.runtime, authFiles: copied, ...(isolation ? { isolation } : {}) };
}
module.exports = { RUNTIMES, prepare, sources };
