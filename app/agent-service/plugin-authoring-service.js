"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { serviceError, ensurePrivateDirectoryTree, assertPrivateDirectory } = require("./security");
const { readPrivateFile } = require("./private-file");
const { hasSecret } = require("./memory-engine");
const { identifyLegacySource } = require("./plugin-legacy-source");
const { MANIFEST_PATH, DRAFT_ID, validatePluginAuthoringArguments } = require("./plugin-authoring-protocol");

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = code => { throw serviceError(code, "插件创建请求无效或草稿已变化，请重新校验"); };
const ownerOf = authority => hash(JSON.stringify([authority.profileId, authority.federationClient || "native"]));
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);

function writeFile(target, content, executable = false) {
  const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW || 0), executable ? 0o700 : 0o600);
  try { fs.writeFileSync(fd, content, "utf8"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
function syncDirectory(target) {
  const fd = fs.openSync(target, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// Drafts are Service-owned product state. They never become an execution
// authority: installation still uses the pinned converter/installer and all
// MCP dependencies, connections and grants keep their existing consent gates.
class PluginAuthoringService {
  constructor({ root, trustedRoot, controller, store, catalog, quickSetup = null }) {
    if (!path.isAbsolute(root) || !path.isAbsolute(trustedRoot)
      || typeof controller?.handle !== "function" || typeof store?.getBySource !== "function"
      || typeof catalog?.list !== "function") throw new TypeError("PluginAuthoringService requires Service-owned stores");
    Object.assign(this, { root, trustedRoot, controller, store, catalog, quickSetup });
  }

  #directory(draftId, authority) {
    if (typeof draftId !== "string" || !DRAFT_ID.test(draftId)) fail("PLUGIN_AUTHORING_INVALID");
    const owner = ownerOf(authority);
    const directory = path.join(this.root, owner, draftId);
    // Validate every managed ancestor without creating directories on a read.
    for (const target of [this.root, path.join(this.root, owner), directory]) assertPrivateDirectory(target);
    const record = JSON.parse(readPrivateFile(path.join(directory, "draft.json"), { maxBytes: 4096 }).toString("utf8"));
    if (record.owner !== owner || record.draftId !== draftId || record.format !== "codex-plugin"
      || !DRAFT_ID.test(record.fingerprint)) fail("PLUGIN_AUTHORING_INVALID");
    return { directory, record, source: { kind: "legacy-directory", path: path.join(directory, "package"),
      format: "codex-plugin", components: ["skills", "mcp-servers"] } };
  }

  async create(args, authority) {
    if (!validatePluginAuthoringArguments("plugin_create", args)) fail("PLUGIN_AUTHORING_INVALID");
    if ([args.description, ...args.files.map(file => file.content)].some(hasSecret)) fail("PLUGIN_AUTHORING_SECRET_REJECTED");
    const owner = ownerOf(authority);
    // One draft per caller and plugin name: recreating replaces the same source,
    // so installing it again updates the same installation instead of adding one.
    const draftId = hash(JSON.stringify([owner, "plugin", args.name]));
    const call = hash(JSON.stringify([owner, authority.callId]));
    const fingerprint = hash(canonical(args));
    const parent = path.join(this.root, owner);
    ensurePrivateDirectoryTree(parent, this.trustedRoot);
    const destination = path.join(parent, draftId);
    // Drafts are written synchronously by the single Service instance, so any
    // staging directory left here is from an interrupted create.
    for (const entry of fs.readdirSync(parent)) {
      if (/^\.(?:creating|retired)-/u.test(entry)) fs.rmSync(path.join(parent, entry), { recursive: true, force: true });
    }
    let calls = [];
    if (fs.existsSync(destination)) {
      const { record } = this.#directory(draftId, authority);
      calls = Array.isArray(record.calls) ? record.calls.filter(item => DRAFT_ID.test(item?.call || "")
        && DRAFT_ID.test(item?.fingerprint || "")).slice(-8) : [];
      // A replayed call returns the current draft and never restores older files.
      const previous = calls.find(item => item.call === call);
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail("REVISION_CONFLICT");
        return this.status({ draftId }, authority);
      }
    }
    const temporary = fs.mkdtempSync(path.join(parent, ".creating-"));
    fs.chmodSync(temporary, 0o700);
    try {
      const sourceRoot = path.join(temporary, "package");
      ensurePrivateDirectoryTree(path.join(sourceRoot, ".codex-plugin"), this.trustedRoot);
      const manifest = { name: args.name, description: args.description, version: args.version || "0.1.0",
        ...(args.files.some(file => file.path.startsWith("skills/")) ? { skills: "./skills/" } : {}),
        ...(args.files.some(file => file.path === ".mcp.json") ? { mcpServers: "./.mcp.json" } : {}) };
      writeFile(path.join(sourceRoot, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`);
      for (const file of args.files) {
        const target = path.join(sourceRoot, ...file.path.split("/"));
        ensurePrivateDirectoryTree(path.dirname(target), this.trustedRoot);
        writeFile(target, file.content, file.executable === true);
      }
      writeFile(path.join(temporary, "draft.json"), JSON.stringify({ draftId, owner, fingerprint, format: "codex-plugin",
        calls: [...calls, { call, fingerprint }].slice(-8) }));
      syncDirectory(sourceRoot);
      syncDirectory(temporary);
      if (fs.existsSync(destination)) {
        const retired = path.join(parent, `.retired-${crypto.randomUUID()}`);
        fs.renameSync(destination, retired);
        fs.renameSync(temporary, destination);
        syncDirectory(parent);
        fs.rmSync(retired, { recursive: true, force: true });
      } else {
        fs.renameSync(temporary, destination);
      }
      syncDirectory(parent);
    } catch (error) {
      fs.rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
    return this.status({ draftId }, authority);
  }

  async status({ draftId }, authority) {
    const { source } = this.#directory(draftId, authority);
    let preview;
    try { preview = await this.controller.handle("plugins.install.preview", { source }); }
    catch (error) {
      if (!/^(?:LEGACY_|PACKAGE_|SKILL_|MCP_)/u.test(error?.code || "")) throw error;
      return { draftId, format: "codex-plugin", sourcePath: source.path, installable: false,
        previewDigest: null, expectedRevision: null, installation: null, components: [],
        diagnostics: [{ scope: "package", reasonCode: error.code }], uiTarget: { href: "#/plugins" },
        nextSteps: ["repair_draft"] };
    }
    const diagnostics = [...preview.diagnostics];
    const declarations = preview.components.mcpServers.length
      ? JSON.parse(readPrivateFile(path.join(source.path, ".mcp.json"), { maxBytes: 48 * 1024 }).toString("utf8")).mcpServers : {};
    for (const server of preview.components.mcpServers) {
      // Parsing a command is not evidence that Shoggoth's contained launcher
      // supports it. npx/uv/arbitrary CLI names need a contained MCP adapter.
      const command = declarations[server.name]?.command;
      if (server.type === "stdio" && /^[^./\\\s][^/\\\s]*$/u.test(command || "")
        && !["node", "python", "python3"].includes(command)) {
        diagnostics.push({ scope: "mcp-server", name: server.name, reasonCode: "DEPENDENCY_INTERPRETER_UNSUPPORTED" });
      }
    }
    const nonEmpty = preview.components.skills.length > 0 || preview.components.mcpServers.length > 0;
    if (!nonEmpty) diagnostics.push({ scope: "package", reasonCode: "PLUGIN_COMPONENT_REQUIRED" });
    // Authoring is a complete-package workflow. A valid Skill must not mask a
    // rejected MCP declaration (or the reverse) and produce a partial install.
    const installable = preview.installable && nonEmpty && diagnostics.length === 0;
    const installed = this.store.getBySource(identifyLegacySource({
      sourcePath: source.path, format: source.format, components: source.components }).sourceIdentity);
    const row = installed && installed.desiredState !== "uninstalled"
      ? this.catalog.list().find(item => item.installationId === installed.installationId) : null;
    const components = row ? row.components.filter(item => item.kind !== "hook") : [];
    return { draftId, format: "codex-plugin", sourcePath: source.path,
      name: preview.name, declaredVersion: preview.declaredVersion, installable,
      previewDigest: preview.previewDigest, expectedRevision: preview.expectedRevision,
      previewComponents: preview.components, diagnostics,
      installation: row ? { installationId: row.installationId, releaseDigest: row.releaseDigest,
        declaredVersion: row.declaredVersion ?? null, desiredState: row.desiredState, revision: row.revision } : null,
      components, uiTarget: { href: row ? `#/plugins?installationId=${encodeURIComponent(row.installationId)}` : "#/plugins" },
      // A draft that differs from the installed release is an update to confirm.
      nextSteps: !installable ? ["repair_draft"]
        : !row || row.releaseDigest !== preview.previewDigest ? ["confirm_install"]
          : this.#setupSteps(row, components, authority) };
  }

  #setupSteps(row, components, authority) {
    if (this.quickSetup) {
      try { return this.quickSetup.inspect({ profileId: authority.profileId, installationId: row.installationId }).nextSteps; }
      catch { /* Fall back to the catalog view below. */ }
    }
    return row.desiredState !== "enabled" ? ["enable_in_plugins"]
      : components.some(item => item.kind === "mcp-server" && item.state !== "ready")
        ? ["prepare_dependencies_and_connect_in_plugins", "authorize_tools_in_plugins", "verify_live_tool_call"]
        : ["verify_in_next_agent_turn"];
  }

  // Updating an enabled installation disables and drains it inside the
  // confirmed install. The step's operation ID depends only on the
  // installation and its pre-update revision, so a replay or a later retry
  // resumes the same (possibly deferred) disable rather than starting another.
  async #prepareUpdate(current, args, sourceIdentity) {
    if (!current) return args.expectedRevision;
    const disableId = `author-update-${hash(JSON.stringify([current.installationId, args.expectedRevision])).slice(0, 48)}`;
    const prior = this.store.getOperation(disableId);
    if (prior?.phase === "completed") {
      if (!Number.isSafeInteger(prior.result?.revision)) fail("REVISION_CONFLICT");
      return prior.result.revision;
    }
    if (current.releaseDigest === args.previewDigest || current.desiredState !== "enabled") return args.expectedRevision;
    if (current.revision !== args.expectedRevision) fail("REVISION_CONFLICT");
    // Reinstalling an earlier release is a rollback; refuse it before disabling.
    if (this.store.getRelease(sourceIdentity, args.previewDigest)) {
      throw serviceError("PLUGIN_ROLLBACK_REQUIRES_PREVIEW", "新内容与此插件用过的旧版本相同");
    }
    const { installation } = await this.controller.handle("plugins.installations.set", {
      installationId: current.installationId, desiredState: "disabled",
      expectedRevision: current.revision, operationId: disableId });
    return installation.revision;
  }

  async install(args, authority) {
    if (!validatePluginAuthoringArguments("plugin_install", args) || authority.confirmation !== true) fail("MCP_TOOL_CONFIRMATION_REQUIRED");
    const { source } = this.#directory(args.draftId, authority);
    const status = await this.status({ draftId: args.draftId }, authority);
    // An exact confirmed retry may already have committed the installation.
    // The installer checks its original operation fingerprint on replay.
    if (!status.installable || status.previewDigest !== args.previewDigest) fail("REVISION_CONFLICT");
    const operationId = `author-install-${hash(canonical([ownerOf(authority), authority.callId, args])).slice(0, 48)}`;
    const sourceIdentity = identifyLegacySource({ sourcePath: source.path, format: source.format,
      components: source.components }).sourceIdentity;
    const expectedRevision = await this.#prepareUpdate(status.installation, args, sourceIdentity);
    const { installation } = await this.controller.handle("plugins.install", { source,
      previewDigest: args.previewDigest, expectedRevision, operationId });
    if (args.enable) await this.controller.handle("plugins.installations.set", {
      installationId: installation.installationId, desiredState: "enabled", expectedRevision: installation.revision,
      operationId: `${operationId}-enable` });
    return this.status({ draftId: args.draftId }, authority);
  }
}

module.exports = { PluginAuthoringService };
