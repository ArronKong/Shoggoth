"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { atomicWritePrivateFile } = require("./agent-service/private-file");
const { ensurePrivateDirectoryTree } = require("./agent-service/security");
const { ensureCredential } = require("./agent-service/external-plugin-adapter-auth");
const { assertAdapterProtocol } = require("./external-plugin-adapter-protocol");
const { discoverHermesProfiles } = require("./federation-mcp-registrar");

const FILES = Object.freeze({
  openclaw: ["index.mjs", "transport.mjs", "package.json", "openclaw.plugin.json"],
  hermes: ["__init__.py", "transport.py", "plugin.yaml"],
});
const HERMES_PLUGIN = "shoggoth_shared_capabilities";
const OPENCLAW_PLUGIN = "shoggoth-shared-capabilities";
const HERMES_PROFILE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const COMMAND_TIMEOUT_MS = 15_000;
const OPENCLAW_TOOLS = Object.freeze([
  "group_member_role_read", "group_messages_read", "group_task", "group_collaborate",
  "shoggoth_capability_search", "shoggoth_skill_read",
  "shoggoth_skill_file_read", "shoggoth_plugin_resource_read", "shoggoth_plugin_call",
]);

function readPackagedFiles(root, backend) {
  const directory = path.join(root, backend);
  const actual = fs.readdirSync(directory).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...FILES[backend]].sort())) {
    throw new Error(`Shoggoth ${backend} adapter resource changed`);
  }
  const files = FILES[backend].map(name => {
    const file = path.join(directory, name);
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || before.size > 64 * 1024) throw new Error(`Shoggoth ${backend} adapter file unsafe`);
    const bytes = fs.readFileSync(file);
    const after = fs.lstatSync(file);
    if (after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error(`Shoggoth ${backend} adapter file changed`);
    }
    return [name, bytes];
  });
  assertAdapterProtocol(backend, files.find(([name]) => name.startsWith("transport."))[1].toString("utf8"));
  return files;
}

function materialize(paths, resourcesRoot, backend) {
  const files = readPackagedFiles(resourcesRoot, backend);
  const digest = crypto.createHash("sha256");
  for (const [name, bytes] of files) digest.update(name).update("\0").update(bytes);
  const target = path.join(paths.stateDir, "external-plugin-adapters", backend, digest.digest("hex"));
  ensurePrivateDirectoryTree(target, paths.trustedRoot);
  const expected = new Set(FILES[backend]);
  const existing = fs.readdirSync(target);
  if (existing.some(name => !expected.has(name))) throw new Error("Shoggoth adapter directory changed");
  for (const [name, bytes] of files) {
    const destination = path.join(target, name);
    if (!fs.existsSync(destination)) {
      atomicWritePrivateFile(destination, bytes, { trustedRoot: paths.trustedRoot });
    }
    const stat = fs.lstatSync(destination);
    const actual = fs.readFileSync(destination);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || (stat.mode & 0o077) !== 0 || !actual.equals(bytes)) {
      throw new Error(`Shoggoth ${backend} adapter copy changed`);
    }
  }
  return target;
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    (options.execFile || execFile)(command, args, {
      env: options.env || process.env, timeout: options.timeoutMs || COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024, windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
      else resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function parseOptionalConfig(output, key, valid, unset) {
  let data;
  try { data = JSON.parse(output); } catch { throw new Error(`OpenClaw ${key} response invalid`); }
  if (data?.ok === false && data.error?.type === "cli_error"
    && typeof data.error.message === "string"
    && data.error.message.startsWith(`Config path is valid but unset: ${key}.`)) {
    return unset;
  }
  if (data?.ok !== false && valid(data)) return data;
  throw new Error(`OpenClaw ${key} response invalid`);
}

function parseOptionalList(output, key, valid) {
  return parseOptionalConfig(output, key,
    data => Array.isArray(data) && data.length <= 1024 && data.every(valid), []);
}

function parsePaths(output) {
  return parseOptionalList(output, "plugins.load.paths",
    item => typeof item === "string" && path.isAbsolute(item));
}

function parseToolAllowList(output) {
  return parseOptionalList(output, "tools.alsoAllow",
    item => typeof item === "string" && item.length > 0 && item.length <= 128);
}

function parsePluginPolicy(output) {
  const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const plugins = parseOptionalConfig(output, "plugins", record, {});
  const invalid = () => { throw new Error("OpenClaw plugins policy response invalid"); };
  if (plugins.enabled !== undefined && typeof plugins.enabled !== "boolean") invalid();
  for (const key of ["allow", "deny"]) {
    if (plugins[key] !== undefined && (!Array.isArray(plugins[key]) || plugins[key].length > 1024
      || !plugins[key].every(item => typeof item === "string" && item.trim().length > 0
        && item.length <= 128))) invalid();
  }
  if (plugins.entries !== undefined && !record(plugins.entries)) invalid();
  const ownEntries = Object.entries(plugins.entries || {})
    .filter(([id]) => id.trim().toLowerCase() === OPENCLAW_PLUGIN);
  if (ownEntries.some(([, entry]) => !record(entry)
    || (entry.enabled !== undefined && typeof entry.enabled !== "boolean"))) invalid();
  const blockedBy = plugins.enabled === false ? "plugins.enabled=false"
    : (plugins.deny || []).some(id => id.trim().toLowerCase() === OPENCLAW_PLUGIN) ? "plugins.deny"
      : ownEntries.some(([, entry]) => entry.enabled === false) ? `plugins.entries.${OPENCLAW_PLUGIN}.enabled=false`
        : null;
  if (blockedBy) throw new Error(`OpenClaw ${OPENCLAW_PLUGIN} blocked by ${blockedBy}`);
  return plugins.allow || [];
}

function includesOpenClawPlugin(allow) {
  return allow.some(id => id.trim().toLowerCase() === OPENCLAW_PLUGIN);
}

function symlinkHermes(profileHome, target, managedRoot) {
  const parent = path.join(profileHome, "plugins");
  const homeStat = fs.lstatSync(profileHome);
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink()
    || homeStat.uid !== process.getuid()) {
    throw new Error("Hermes profile directory unsafe");
  }
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) {
    throw new Error("Hermes plugin directory unsafe");
  }
  const link = path.join(parent, HERMES_PLUGIN);
  let previous = null;
  try {
    const current = fs.lstatSync(link);
    if (!current.isSymbolicLink() || current.uid !== process.getuid()) {
      throw new Error("Hermes Shoggoth adapter name already belongs to another plugin");
    }
    previous = fs.readlinkSync(link);
    if (!path.isAbsolute(previous) || !previous.startsWith(managedRoot + path.sep)) {
      throw new Error("Hermes Shoggoth adapter link is not owned by Shoggoth");
    }
    if (previous === target) return { path: link, created: false };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const staged = path.join(parent, `.shoggoth-adapter-${crypto.randomUUID()}`);
  fs.symlinkSync(target, staged);
  try { fs.renameSync(staged, link); }
  finally { try { fs.unlinkSync(staged); } catch {} }
  return { path: link, created: previous === null };
}

function createExternalPluginAdapterRegistrar(options = {}) {
  if (!options.paths?.stateDir || !options.paths?.trustedRoot
    || typeof options.resourcesRoot !== "string" || !path.isAbsolute(options.resourcesRoot)
    || (options.getHermesMode !== undefined && typeof options.getHermesMode !== "function")
    || (options.getOpenClawMode !== undefined && typeof options.getOpenClawMode !== "function")) {
    throw new TypeError("External plugin adapter registrar 配置无效");
  }
  const settings = { openclawBin: "openclaw", hermesBin: "hermes",
    hermesHome: path.join(os.homedir(), ".hermes"), ...options };
  const execute = (command, args) => run(command, args, settings);
  const readPluginPolicy = () => execute(settings.openclawBin, ["config", "get", "plugins", "--json"])
    .then(result => parsePluginPolicy(result.stdout),
      error => parsePluginPolicy(String(error.stdout || error.stderr || "")));
  return Object.freeze({
    async reconcile() {
      if (settings.packaged !== true) return { skipped: "not-packaged", openclaw: false, hermes: [] };
      const outcome = { skipped: null, openclaw: false, hermes: [], errors: {} };
      if (settings.getOpenClawMode?.() !== "managed") try {
        // Respect explicit user refusals before registering paths or tool grants.
        const pluginAllow = await readPluginPolicy();
        const existing = await execute(settings.openclawBin, ["config", "get", "plugins.load.paths", "--json"])
          .then(result => parsePaths(result.stdout), error => parsePaths(String(error.stdout || error.stderr || "")));
        const target = materialize(settings.paths, settings.resourcesRoot, "openclaw");
        const managed = path.join(settings.paths.stateDir, "external-plugin-adapters", "openclaw") + path.sep;
        const paths = [...existing.filter(item => !item.startsWith(managed)), target];
        ensureCredential(settings.paths, "openclaw");
        if (JSON.stringify(existing) !== JSON.stringify(paths)) {
          await execute(settings.openclawBin, ["config", "set", "plugins.load.paths", JSON.stringify(paths)]);
        }
        // An absent/empty list is unrestricted. Creating a one-plugin allowlist
        // there would disable unrelated plugins. Extend only an existing list,
        // and fail on concurrent edits so the next reconcile can read them anew.
        if (pluginAllow.length > 0 && !includesOpenClawPlugin(pluginAllow)) {
          await execute(settings.openclawBin, ["config", "set", "plugins.allow",
            JSON.stringify([...pluginAllow, OPENCLAW_PLUGIN]), "--strict-json",
            "--expect-current-json", JSON.stringify(pluginAllow)]);
        }
        // A loaded plugin can still be absent from a limited profile's model
        // tool surface. Add only our exact tool names; explicit deny and
        // sandbox restrictions in the user's OpenClaw policy still win.
        const allowed = await execute(settings.openclawBin,
          ["config", "get", "tools.alsoAllow", "--json"])
          .then(result => parseToolAllowList(result.stdout),
            error => parseToolAllowList(String(error.stdout || error.stderr || "")));
        const nextAllowed = [...new Set([...allowed, ...OPENCLAW_TOOLS])];
        if (JSON.stringify(allowed) !== JSON.stringify(nextAllowed)) {
          await execute(settings.openclawBin,
            ["config", "set", "tools.alsoAllow", JSON.stringify(nextAllowed)]);
        }
        const verifiedPluginAllow = await readPluginPolicy();
        if (verifiedPluginAllow.length > 0 && !includesOpenClawPlugin(verifiedPluginAllow)) {
          throw new Error(`OpenClaw ${OPENCLAW_PLUGIN} missing from plugins.allow after registration`);
        }
        outcome.openclaw = true;
      } catch (error) { outcome.errors.openclaw = error.message; }

      if (!["remote", "managed"].includes(settings.getHermesMode?.() || "local")) {
        try { await execute(settings.hermesBin, ["plugins", "--help"]); }
        catch (error) {
          outcome.errors.hermes = error.message;
          return outcome;
        }
        let profiles;
        try { profiles = settings.listHermesProfiles
          ? await settings.listHermesProfiles()
          : discoverHermesProfiles(settings.hermesHome); }
        catch { profiles = ["default"]; }
        const names = [...new Set(Array.isArray(profiles) ? profiles : [])]
          .filter(name => HERMES_PROFILE.test(name));
        if (!names.includes("default")) names.unshift("default");
        for (const profile of names) {
          try {
            const target = materialize(settings.paths, settings.resourcesRoot, "hermes");
            const profileHome = profile === "default" ? settings.hermesHome
              : path.join(settings.hermesHome, "profiles", profile);
            const link = symlinkHermes(profileHome, target,
              path.join(settings.paths.stateDir, "external-plugin-adapters", "hermes"));
            ensureCredential(settings.paths, "hermes");
            if (link.created) await execute(settings.hermesBin, [
              ...(profile === "default" ? [] : ["--profile", profile]),
              "plugins", "enable", HERMES_PLUGIN,
            ]);
            outcome.hermes.push(profile);
          } catch (error) { outcome.errors[`hermes:${profile}`] = error.message; }
        }
      }
      return outcome;
    },
  });
}

module.exports = { createExternalPluginAdapterRegistrar, materialize,
  parsePaths, parseToolAllowList, symlinkHermes };
