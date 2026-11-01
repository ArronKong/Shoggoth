"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { serviceError } = require("./security");

const OFFICIAL_SKILL_PROVIDERS = require("../core/official-skill-connector-dto").OFFICIAL_SKILL_IDS;
const BRIDGE_ENTRY = path.join(__dirname, "official-skill-mcp-bridge.js");
const INSTALLATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function matchOfficialSkillBridgeLaunch(command, args, { paths } = {}) {
  if (command !== process.execPath || !paths?.stateDir || !Array.isArray(args) || args.length !== 7
    || args[0] !== BRIDGE_ENTRY || args[1] !== "--provider" || !OFFICIAL_SKILL_PROVIDERS.includes(args[2])
    || args[3] !== "--root" || args[5] !== "--home" || typeof args[4] !== "string" || typeof args[6] !== "string") return null;
  const provider = args[2], root = args[4], home = args[6], installationId = path.basename(root);
  const base = path.join(paths.stateDir, "runtime-bin", "official-skills");
  if (!path.isAbsolute(root) || !INSTALLATION_ID.test(installationId)
    || root !== path.join(base, provider, installationId) || home !== path.join(root, "home")) return null;
  return { provider, root, home, base, entry: BRIDGE_ENTRY };
}

function validateOfficialSkillBridgeLaunch(command, args, { paths, fsModule = fs } = {}) {
  const match = matchOfficialSkillBridgeLaunch(command, args, { paths });
  const invalid = () => { throw serviceError("MCP_SERVER_PATH_INVALID", "官方 Skill 连接器启动路径无效"); };
  if (!match) invalid();
  try {
    const script = fsModule.lstatSync(match.entry);
    if (script.isSymbolicLink() || !script.isFile()
      || fsModule.realpathSync(match.entry) !== path.join(fsModule.realpathSync(__dirname), path.basename(match.entry))) invalid();
    // The payload is validated by the bridge itself. Before allowing the host
    // executable here, ensure every installation directory remains private and
    // cannot redirect to a different payload or user home through a symlink.
    let current = paths.stateDir;
    for (const segment of [null, "runtime-bin", "official-skills", match.provider, path.basename(match.root), "home"]) {
      if (segment !== null) current = path.join(current, segment);
      const stat = fsModule.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0
        || typeof process.getuid === "function" && stat.uid !== process.getuid()) invalid();
    }
    const expected = path.join(fsModule.realpathSync(paths.stateDir), "runtime-bin", "official-skills", match.provider, path.basename(match.root), "home");
    if (fsModule.realpathSync(match.home) !== expected) invalid();
  } catch { invalid(); }
  return match;
}

function officialSkillBridgeEnvironment(command, args, options = {}) {
  if (!matchOfficialSkillBridgeLaunch(command, args, options)) return {};
  const match = validateOfficialSkillBridgeLaunch(command, args, options);
  return { ELECTRON_RUN_AS_NODE: "1", HOME: match.home };
}

function validateOfficialSkillBridgeCredentials(transport, secrets = {}, options = {}) {
  if (transport?.kind !== "stdio-command") return;
  const match = matchOfficialSkillBridgeLaunch(transport.command, transport.args, options);
  if (!match) return;
  const invalid = () => { throw serviceError("MCP_SECRET_INVALID", "官方 Skill 连接器仅接受指定凭据字段"); };
  const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
  if (!plain(secrets) || Object.entries(secrets).some(([key, value]) => key !== "env" && value !== null && value !== undefined)) invalid();
  const env = secrets.env ?? {};
  const fields = new Set(require("./official-skill-providers").getOfficialSkillProvider(match.provider).fields.map(field => field.name));
  if (!plain(env) || Object.entries(env).some(([key, value]) => !fields.has(key) || typeof value !== "string"
    || !value.isWellFormed() || value.includes("\0") || value.length > 16384)) invalid();
}

module.exports = { OFFICIAL_SKILL_PROVIDERS, BRIDGE_ENTRY, matchOfficialSkillBridgeLaunch, validateOfficialSkillBridgeLaunch, officialSkillBridgeEnvironment, validateOfficialSkillBridgeCredentials };
