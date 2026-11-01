"use strict";
const path = require("node:path");
const http = require("node:http");
const { parse, stringify } = require("smol-toml");
const { ensurePrivateDirectoryTree, serviceError } = require("./security");

// Keep the selected account's authentication and provider route, not its
// executable hooks, plugins, MCP servers, rules, sessions or project config.
async function prepareGrokModelOnly(host) {
  const fs = host.fs, parent = path.join(host.paths.stateDir, "runtime-integration", "grok-model-only");
  ensurePrivateDirectoryTree(parent, host.paths.trustedRoot);
  const root = fs.mkdtempSync(path.join(parent, "host-")); fs.chmodSync(root, 0o700);
  let titleGuard;
  const closeGuard = async () => { if (titleGuard) { titleGuard.closeAllConnections(); await new Promise(resolve => titleGuard.close(resolve)); titleGuard = null; } };
  try {
    const cwd = path.join(root, "workspace"), grokHome = path.join(root, "grok");
    for (const dir of [cwd, grokHome]) fs.mkdirSync(dir, { mode: 0o700 });
    let source = {};
    // Managed policy may contain executable hooks or mandatory provider,
    // permission and model restrictions. A private home must not silently
    // replace any of those requirements with this review's local policy.
    for (const policyPath of ["/etc/grok/requirements.toml", "/etc/grok/managed_config.toml",
      path.join(host.runtimeEnvironment.home, "requirements.toml"), path.join(host.runtimeEnvironment.home, "managed_config.toml")]) {
      try {
        const stat = fs.lstatSync(policyPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("unsafe policy");
        const policy = parse(fs.readFileSync(policyPath, "utf8"));
        if (Object.keys(policy).length)
          throw serviceError("MODEL_ONLY_POLICY_UNVERIFIED", "Managed execution policy requires separate verification");
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const configPath = path.join(host.runtimeEnvironment.home, "config.toml");
    try {
      const stat = fs.lstatSync(configPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("unsafe config");
      source = parse(fs.readFileSync(configPath, "utf8"));
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const config = Object.fromEntries(["model", "models", "model_providers", "endpoints", "auth", "grok_com_config", "auth_provider"]
      .filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]));
    // 1.0.73 unconditionally attempts initial title inference, even with
    // title_refresh disabled. Give that side-call a private rejecting route;
    // it must never use another model/account or consume an unmetered budget.
    titleGuard = http.createServer((req, res) => { req.resume(); res.writeHead(403, { "Content-Type": "application/json", Connection: "close" });
      res.end(JSON.stringify({ error: { message: "Background inference is disabled for this text review" } })); });
    await new Promise((resolve, reject) => { titleGuard.once("error", reject); titleGuard.listen(0, "127.0.0.1", resolve); });
    titleGuard.unref();
    if (Object.hasOwn(config.model || {}, "shoggoth-title-disabled")) throw serviceError("MODEL_ONLY_CONFIG_INVALID", "Reserved private model route conflicts");
    config.models = { ...config.models, session_summary: "shoggoth-title-disabled",
      hidden_models: [...new Set([...(source.models?.hidden_models || []), "shoggoth-title-disabled"])] };
    config.model = { ...config.model, "shoggoth-title-disabled": { model: "shoggoth-title-disabled", api_backend: "responses",
      base_url: `http://127.0.0.1:${titleGuard.address().port}/v1`, api_key: "disabled-local-route", max_retries: 0 } };
    Object.assign(config, { agent: { name: "shoggoth-review" }, cli: { auto_update: false }, managed_mcps: { enabled: false, gateway_tools_enabled: false },
      harness: { disable_workspace_teleport: true }, telemetry: { trace_upload: false },
      memory: { enabled: false }, memory_v2: { enabled: false }, session: { load_envrc: false },
      features: { subagent_bundle: false, title_refresh: false, turn_summary: false, telemetry: "off", managed_config: false, campaigns: false },
      permission: { default_mode: "dontAsk", deny: ["*"] } });
    fs.writeFileSync(path.join(grokHome, "config.toml"), stringify(config), { mode: 0o600 });
    // Native MCP discovery also sees generic .mcp.json sources. An empty
    // enforced allowlist blocks them before connection, not only at tool use.
    fs.writeFileSync(path.join(grokHome, "requirements.toml"), stringify({ allowed_mcp_servers: [],
      allow_managed_hooks_only: true, plugin_auto_update: false, strict_known_marketplaces: [],
      features: { title_refresh: false, turn_summary: false } }), { mode: 0o600 });
    // Use the native explicit auth path so atomic token refreshes remain in
    // the owning account. A symlink here would be replaced by native rename.
    const authPath = path.join(host.runtimeEnvironment.home, "auth.json");
    fs.mkdirSync(path.join(grokHome, "agents"), { mode: 0o700 });
    const profile = path.join(grokHome, "agents", "shoggoth-review.md");
    // 1.0.73 rejects an initially empty curated registry, and `tools: []`
    // inherits all. Declare one known entry, then remove it using the native
    // deny filter before registration. Default tool injection stays disabled.
    fs.writeFileSync(profile, "---\nname: shoggoth-review\ndescription: Bounded text review\npromptMode: full\ntoolConfig:\n  tools:\n    - id: GrokBuild:read_file\ninjectDefaultTools: false\ndisallowedTools: [read_file]\npermissionMode: dontAsk\nagentsMd: false\ndiscoverSkills: false\ninheritSkills: false\nskills: []\n---\nComplete the supplied text task. No tools or external actions are authorized.\n", { mode: 0o600 });
    const identity = fs.lstatSync(root); let disposed = false;
    return { cwd, grokHome, profile, authPath, async dispose() {
      if (disposed) return;
      await closeGuard();
      const current = fs.lstatSync(root);
      if (current.isSymbolicLink() || !current.isDirectory() || current.ino !== identity.ino || current.dev !== identity.dev)
        throw serviceError("MODEL_ONLY_CLEANUP_FAILED", "Model-only directory identity changed");
      fs.rmSync(root, { recursive: true });
      disposed = true;
    } };
  } catch (error) { await closeGuard(); fs.rmSync(root, { recursive: true, force: true }); throw error; }
}
module.exports = { prepareGrokModelOnly };
