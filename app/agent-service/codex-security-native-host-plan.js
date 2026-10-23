"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { BundledPluginCatalog } = require("../core/bundled-plugin-catalog");
const { PluginStore } = require("./plugin-store");
const { PluginComponentResolver } = require("./plugin-component-resolver");
const { ProductStore } = require("./product-store");
const { HostCapabilityIssuer } = require("./host-capability-issuer");
const { RuntimeAccountAdmission } = require("./runtime-account-admission");
const { RuntimeAccountResolver } = require("./runtime-account-resolver");
const { validateRuntimeAccount } = require("./runtime-account");
const { runtimeBinding } = require("./runtime-adapter");
const { CodexRuntimeHost } = require("./codex-runtime-host");
const { CodexSecurityNativeJobStore } = require("./codex-security-native-job-store");
const { ACTIVE_WORK_RUN_STATUSES, canonicalWorkspace } = require("./work-run");
const { inspectExecutable } = require("./plugin-dependency-registry");
const { assertPrivateDirectory, ensurePrivateDirectoryTree, serviceError } = require("./security");

const SOURCE = "bundled:codex-security", VERSION = "0.1.24";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ENV_INVENTORY = Object.freeze([
  ["CODEX_HOME", "service-path"], ["CODEX_SQLITE_HOME", "service-path"], ["CODEX_API_KEY", "account-secret"],
  ["CODEX_SAFETY_IDENTIFIER", "account-identity"], ["CODEX_BROWSER_USE_NODE_PATH", "service-executable"],
  ["CODEX_CLI_PATH", "service-executable"], ["CODEX_ELECTRON_RESOURCES_PATH", "optional-service-path"],
  ["CODEX_MANAGED_PACKAGE_ROOT", "service-path"], ["CODEX_MCP_NODE_PATH", "service-executable"],
  ["OPENAI_API_KEY", "account-secret"], ["OPENROUTER_API_KEY", "account-secret"], ["FIREWORKS_API_KEY", "account-secret"],
  ["AWS_BEARER_TOKEN_BEDROCK", "account-secret"], ["AWS_ACCESS_KEY_ID", "account-secret"],
  ["AWS_SECRET_ACCESS_KEY", "account-secret"], ["AWS_SESSION_TOKEN", "account-secret"],
  ["AWS_PROFILE", "account-parameter"], ["AWS_REGION", "account-parameter"], ["AWS_DEFAULT_REGION", "account-parameter"],
  ["AWS_CONFIG_FILE", "credential-file"], ["AWS_SHARED_CREDENTIALS_FILE", "credential-file"],
  ["AWS_ROLE_ARN", "account-parameter"], ["AWS_ROLE_SESSION_NAME", "account-parameter"],
  ["AWS_WEB_IDENTITY_TOKEN_FILE", "credential-file"], ["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "credential-endpoint"],
  ["AWS_CONTAINER_CREDENTIALS_FULL_URI", "credential-endpoint"], ["AWS_CONTAINER_AUTHORIZATION_TOKEN", "account-secret"],
  ["AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE", "credential-file"], ["PYTHON", "service-executable"],
  ["PYTHONUTF8", "fixed-flag"], ["CODEX_SECURITY_KNOWLEDGE_BASE", "user-file"],
  ["CODEX_SECURITY_DEEP_SCAN_CONFIG_PATH", "user-file"], ["CODEX_SECURITY_SCAN_ROOT", "owning-workspace"],
  ["CODEX_SECURITY_STATE_DIR", "service-path"], ["CODEX_SECURITY_SURFACE", "user-parameter"],
  ["HTTP_PROXY", "network-policy"], ["HTTPS_PROXY", "network-policy"], ["ALL_PROXY", "network-policy"],
  ["NO_PROXY", "network-policy"], ["SSL_CERT_FILE", "trust-file"], ["REQUESTS_CA_BUNDLE", "trust-file"],
  ["NODE_EXTRA_CA_CERTS", "trust-file"], ["XDG_CACHE_HOME", "service-path"],
].map(([name, kind]) => Object.freeze({ name, kind })));
const ENV_NAMES = Object.freeze(ENV_INVENTORY.map(item => item.name));
const SPEC_FIELDS = Object.freeze(["command", "args", "cwd", "env_vars", "startup_timeout_sec", "tool_timeout_sec"]);
const hash = value => crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const fail = code => { throw serviceError(`CODEX_SECURITY_NATIVE_${code}`, "Codex Security 专用宿主、所属任务或原配置尚未准入/已变化"); };
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const d = Object.getOwnPropertyDescriptor(value, key); return d?.enumerable && Object.hasOwn(d, "value");
  });
const statIdentity = stat => Object.fromEntries(["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeMs", "ctimeMs"].map(key => [key, stat[key]]));

function sourceSnapshot(root, privateCopy = false) {
  const files = [], payloads = []; let total = 0;
  const walk = (directory, prefix = "") => {
    const before = fs.lstatSync(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) fail("SOURCE_CHANGED");
    if (privateCopy) assertPrivateDirectory(directory);
    for (const name of fs.readdirSync(directory).sort()) {
      if (!name || [".", ".."].includes(name) || name.includes("\\") || name.includes("\0")) fail("SOURCE_CHANGED");
      const relative = prefix ? `${prefix}/${name}` : name, target = path.join(directory, name), stat = fs.lstatSync(target);
      if (stat.isDirectory() && !stat.isSymbolicLink()) { walk(target, relative); continue; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024
        || (total += stat.size) > 16 * 1024 * 1024 || files.length >= 256
        || (privateCopy && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) fail("SOURCE_CHANGED");
      const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      let bytes;
      try {
        if (hash(statIdentity(stat)) !== hash(statIdentity(fs.fstatSync(fd)))) fail("SOURCE_CHANGED");
        bytes = fs.readFileSync(fd);
        if (bytes.length !== stat.size || hash(statIdentity(stat)) !== hash(statIdentity(fs.fstatSync(fd)))
          || hash(statIdentity(stat)) !== hash(statIdentity(fs.lstatSync(target)))) fail("SOURCE_CHANGED");
      } finally { fs.closeSync(fd); }
      files.push({ path: relative, bytes: bytes.length, sha256: hash(bytes), executable: (stat.mode & 0o111) !== 0 });
      payloads.push({ path: relative, bytes, executable: (stat.mode & 0o111) !== 0 });
    }
    const after = fs.lstatSync(directory);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) fail("SOURCE_CHANGED");
  };
  walk(root); return { files, payloads, digest: hash(files) };
}
function stageOriginalSource(installation, directory, paths) {
  const root = path.join(directory, `original-${installation.pin.sourceDigest}`);
  if (fs.existsSync(root)) {
    if (sourceSnapshot(root, true).digest !== installation.pin.sourceDigest) fail("SOURCE_CHANGED");
    return root;
  }
  const snapshot = sourceSnapshot(installation.root);
  if (snapshot.digest !== installation.pin.sourceDigest) fail("SOURCE_CHANGED");
  ensurePrivateDirectoryTree(root, paths.trustedRoot);
  const directories = new Set([root]);
  for (const file of snapshot.payloads) {
    const target = path.join(root, file.path), parent = path.dirname(target);
    if (parent !== root) ensurePrivateDirectoryTree(parent, paths.trustedRoot);
    let cursor = parent;
    while (cursor !== root) { directories.add(cursor); cursor = path.dirname(cursor); }
    const fd = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try { fs.writeFileSync(fd, file.bytes); fs.fchmodSync(fd, file.executable ? 0o500 : 0o400); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try { fs.fchmodSync(fd, 0o500); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  if (sourceSnapshot(root, true).digest !== installation.pin.sourceDigest
    || sourceSnapshot(installation.root).digest !== installation.pin.sourceDigest) fail("SOURCE_CHANGED");
  return root;
}

// A dedicated Service metadata operation, not the generic session initializer.
// All original fields/env names are preserved. No API accepts caller _meta,
// thread IDs, environment values, account-readiness flags, grants or paths.
class CodexSecurityNativeHostPlanFactory {
  #plans = new WeakMap();
  #operations = new Map();
  #closed = false;

  constructor({ paths, store, resolver, bundledCatalog, productStore, dispatcher, capabilityIssuer,
    runtimeAccountAdmission, runtimeAccountResolver, jobStore, nodePath, pythonPath, repoRoot,
    onNativeHost = null } = {}) {
    if (!paths?.stateDir || !paths.trustedRoot || !(store instanceof PluginStore)
      || !(resolver instanceof PluginComponentResolver) || resolver.store !== store
      || !(bundledCatalog instanceof BundledPluginCatalog) || !(productStore instanceof ProductStore)
      || typeof dispatcher?.getRun !== "function" || !(capabilityIssuer instanceof HostCapabilityIssuer)
      || !(runtimeAccountAdmission instanceof RuntimeAccountAdmission)
      || !(runtimeAccountResolver instanceof RuntimeAccountResolver)
      || !(jobStore instanceof CodexSecurityNativeJobStore) || typeof repoRoot !== "string"
      || (onNativeHost !== null && typeof onNativeHost !== "function")) throw new TypeError("Trusted Service factory dependencies required");
    this.paths = Object.freeze({ ...paths }); this.store = store; this.resolver = resolver;
    this.bundledCatalog = bundledCatalog; this.productStore = productStore; this.dispatcher = dispatcher;
    this.capabilityIssuer = capabilityIssuer; this.runtimeAccountAdmission = runtimeAccountAdmission;
    this.runtimeAccountResolver = runtimeAccountResolver; this.jobStore = jobStore; this.repoRoot = repoRoot;
    // Constructor-only, local executable selection. Never a renderer or RPC field.
    this.node = freeze(this.#executable(nodePath)); this.python = freeze(this.#executable(pythonPath));
    this.onNativeHost = onNativeHost;
  }

  #executable(selectedPath) {
    const pin = inspectExecutable(selectedPath);
    return { ...pin, identity: statIdentity(fs.lstatSync(pin.canonicalPath)) };
  }
  #checkExecutable(pin) {
    if (fs.realpathSync(pin.selectedPath) !== pin.canonicalPath
      || hash(statIdentity(fs.lstatSync(pin.canonicalPath))) !== hash(pin.identity)) fail("DEPENDENCY_CHANGED");
    const { identity, ...executable } = pin;
    if (hash(inspectExecutable(pin.selectedPath)) !== hash(executable)) fail("DEPENDENCY_CHANGED");
  }
  #owner(lease) {
    if (this.#closed) fail("CLOSED");
    const identity = this.capabilityIssuer.assert(lease, { kind: "mcp" });
    const run = this.dispatcher.getRun(identity.runId);
    if (!run || hash(run) !== hash(this.productStore.getWorkRun(identity.runId))
      || !ACTIVE_WORK_RUN_STATUSES.has(run.status) || run.profileId !== identity.profileId
      || run.workspace !== identity.workspace || canonicalWorkspace(run.workspace) !== run.workspace) fail("OWNER_INVALID");
    const profile = this.productStore.resolveAgentRuntimeProfile(identity.profileId, identity.bindingId);
    const account = validateRuntimeAccount(this.productStore.getRuntimeAccount(profile.runtimeAccountId));
    if (!profile.enabled || profile.runtime !== "codex" || identity.runtime !== profile.runtime
      || profile.runtimeAccountId !== identity.runtimeAccountId || account.kind !== "shoggoth-managed"
      || account.runtime !== "codex" || !Number.isSafeInteger(identity.accountGeneration) || identity.accountGeneration < 1) fail("OWNER_INVALID");
    this.runtimeAccountAdmission.assertRunAdmitted({ runtimeAccountId: account.id, runId: run.id, generation: identity.accountGeneration });
    return freeze({ runId: run.id, profileId: run.profileId, bindingId: identity.bindingId, runtimeProfileId: profile.runtimeProfileId,
      runtimeAccountId: profile.runtimeAccountId, attemptId: identity.attemptId, accountGeneration: identity.accountGeneration,
      workspace: run.workspace, contextSnapshotId: run.contextSnapshotId });
  }
  #installation(installationId) {
    const bundle = this.bundledCatalog.assertCurrent("codex-security");
    const installation = this.resolver.verifyInstallation(installationId);
    const release = this.store.getRelease(installation.sourceIdentity, installation.releaseDigest);
    if (installation.sourceIdentity !== SOURCE || installation.desiredState !== "enabled"
      || this.store.hasPendingInstallationDisable(installationId) || release?.declaredVersion !== VERSION
      || release.name !== "codex-security" || bundle.version !== VERSION || release.contentDigest !== installation.releaseDigest) fail("INSTALLATION_INVALID");
    // The generic installed release contains only the converted Skills.
    // The original stdio program is a separately pinned metadata source, NOT an installed MCP component.
    const root = this.bundledCatalog.packagePath("codex-security");
    if (fs.realpathSync(root) !== root) fail("INSTALLATION_INVALID");
    const manifest = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
    if (!exact(manifest, ["mcpServers"]) || !exact(manifest.mcpServers, ["codex-security"])) fail("CONFIG_CHANGED");
    const spec = manifest.mcpServers["codex-security"];
    if (!exact(spec, SPEC_FIELDS) || spec.command !== "./scripts/launch_codex_security_mcp" || hash(spec.args) !== hash(["--stdio"])
      || spec.cwd !== "." || hash(spec.env_vars) !== hash(ENV_NAMES) || spec.startup_timeout_sec !== 120
      || spec.tool_timeout_sec !== 349200) fail("CONFIG_CHANGED");
    // Catalog verification above covers every original source file; installation verification covers the converted release. These explicit
    // hashes also bind the native launch closure to the unchanged original bytes.
    const files = [".mcp.json", ".codex-plugin/plugin.json", "scripts/launch_codex_security_mcp", "mcp/server.mjs"];
    const sourceFiles = Object.fromEntries(files.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
    return { root, spec: structuredClone(spec), sourceFiles,
      pin: { installationId, revision: installation.revision, releaseDigest: installation.releaseDigest,
        sourceDigest: bundle.sourceDigest, sourceIdentity: SOURCE },
      authorityIncarnation: this.store.getAuthorityIncarnation(), releaseDigest: hash(release) };
  }
  #binding(owner) { return runtimeBinding({ runtime: "codex", runtimeProfileId: owner.runtimeProfileId, runtimeAccountId: owner.runtimeAccountId }); }
  #record(plan, lease) {
    const record = this.#plans.get(plan);
    if (!record || record.lease !== lease || record.retired || this.#closed) fail("PLAN_INVALID");
    return record;
  }
  #assertCurrent(record, { dependencies = false } = {}) {
    if (record.retired || this.#closed || hash(this.#owner(record.lease)) !== hash(record.owner)) fail("OWNER_CHANGED");
    const installation = this.#installation(record.input.installationId);
    if (hash(installation) !== hash(record.installation)) fail("INSTALLATION_CHANGED");
    const account = this.productStore.getRuntimeAccount(record.owner.runtimeAccountId);
    if (hash(account) !== record.accountDigest) fail("ACCOUNT_CHANGED");
    const environment = this.runtimeAccountResolver.resolve(this.#binding(record.owner), account);
    if (hash(environment) !== hash(record.environment)) fail("ACCOUNT_CHANGED");
    assertPrivateDirectory(record.directory); assertPrivateDirectory(record.home);
    if (sourceSnapshot(record.originalRoot, true).digest !== record.installation.pin.sourceDigest) fail("SOURCE_CHANGED");
    if (fs.existsSync(path.join(environment.home, "auth.json")) || fs.existsSync(path.join(environment.home, "config.toml"))) fail("CREDENTIALLESS_HOME_REQUIRED");
    for (const pin of [this.node, this.python, record.codex]) {
      if (dependencies) this.#checkExecutable(pin);
      else if (fs.realpathSync(pin.selectedPath) !== pin.canonicalPath
        || hash(statIdentity(fs.lstatSync(pin.canonicalPath))) !== hash(pin.identity)) fail("DEPENDENCY_CHANGED");
    }
    this.jobStore.assertHandle(record.job);
    return true;
  }

  prepare(input, lease) {
    if (!exact(input, ["operationId", "installationId"]) || !ID.test(input.operationId || "") || !ID.test(input.installationId || "")) fail("INVALID");
    const request = Object.freeze({ operationId: input.operationId, installationId: input.installationId });
    const owner = this.#owner(lease), installation = this.#installation(request.installationId);
    const account = this.productStore.getRuntimeAccount(owner.runtimeAccountId);
    const environment = this.runtimeAccountResolver.resolve(this.#binding(owner), account);
    if (fs.readdirSync(environment.home).length !== 0) fail("CREDENTIALLESS_HOME_REQUIRED");
    const codex = freeze(this.#executable(environment.binaryPath));
    this.#checkExecutable(this.node); this.#checkExecutable(this.python);
    const directory = path.join(this.paths.stateDir, "codex-security-native-hosts", hash([request.operationId, owner.runtimeAccountId]));
    for (const child of ["home", "cache", "sqlite", "security-state", "tmp"]) ensurePrivateDirectoryTree(path.join(directory, child), this.paths.trustedRoot);
    const home = path.join(directory, "home");
    const originalRoot = stageOriginalSource(installation, directory, this.paths);
    const derived = freeze({ CODEX_SQLITE_HOME: path.join(directory, "sqlite"), CODEX_BROWSER_USE_NODE_PATH: this.node.canonicalPath,
      CODEX_CLI_PATH: codex.canonicalPath, CODEX_MANAGED_PACKAGE_ROOT: originalRoot, CODEX_MCP_NODE_PATH: this.node.canonicalPath,
      PYTHON: this.python.canonicalPath, PYTHONUTF8: "1", CODEX_SECURITY_SCAN_ROOT: owner.workspace,
      CODEX_SECURITY_STATE_DIR: path.join(directory, "security-state"), XDG_CACHE_HOME: path.join(directory, "cache") });
    const spec = freeze({ ...installation.spec, command: path.join(originalRoot, "scripts/launch_codex_security_mcp"), cwd: originalRoot });
    const planDigest = hash({ version: 1, owner, installation, spec, derived, codex, node: this.node, python: this.python,
      directory, home, environment });
    const requestDigest = hash({ kind: "codex-security-native-metadata", request, owner, installation: installation.pin });
    const existing = this.#operations.get(request.operationId);
    if (existing) {
      if (existing.lease !== lease || existing.requestDigest !== requestDigest || existing.planDigest !== planDigest) fail("OPERATION_MISMATCH");
      this.#assertCurrent(existing); return existing.plan;
    }
    const job = this.jobStore.prepare({ operationId: request.operationId, requestDigest, owner, installation: installation.pin, planDigest });
    const plan = Object.freeze({ version: 1, kind: "codex-security-native-host-plan" });
    const record = { plan, input: request, lease, owner, installation, accountDigest: hash(account), environment, codex,
      directory, home, originalRoot, derived, spec, planDigest, requestDigest, job, host: null, threadId: null, starting: null,
      closing: null, retired: false, tools: null };
    this.#plans.set(plan, record); this.#operations.set(request.operationId, record);
    this.#assertCurrent(record, { dependencies: true }); return plan;
  }

  describe(plan, lease) {
    const record = this.#record(plan, lease); this.#assertCurrent(record);
    return freeze({ version: 1, operationId: record.input.operationId, purpose: "original-plugin-metadata-only",
      sourceVersion: VERSION, environmentNameCount: ENV_NAMES.length, originalFieldCount: SPEC_FIELDS.length,
      startupTimeoutSec: 120, toolTimeoutSec: 349200,
      fullPluginUsable: false, modelTurnStarted: false, scanStarted: false, originalToolsUnlocked: false,
      blockers: ["INSTALLED_ORIGINAL_MCP_COMPONENT_REQUIRED", "BINDING_CONNECTION_GRANT_REQUIRED",
        "OWNING_NATIVE_TURN_ADAPTER_REQUIRED", "DEEP_SDK_AUTHORIZATION_REQUIRED", "DURABLE_SCAN_PROTOCOL_REQUIRED", "REDISTRIBUTION_APPROVAL_PENDING"] });
  }
  // Private Core import preparation, never a permission or a public installation.
  originalComponentCandidate(plan, lease) {
    const record = this.#record(plan, lease); this.#assertCurrent(record);
    return freeze({ name: "codex-security", declaredVersion: VERSION, sourceIdentity: SOURCE,
      installation: structuredClone(record.installation.pin), sourceFiles: structuredClone(record.installation.sourceFiles),
      sourceSpec: structuredClone(record.installation.spec), spec: structuredClone(record.spec),
      descriptorDigest: hash(record.installation.spec), intendedToolCount: 45,
      registered: this.store.getRelease(SOURCE, record.installation.pin.releaseDigest).components.mcpServers.some(item => item.name === "codex-security"),
      fullPluginUsable: false });
  }
  observe(plan, lease) {
    const record = this.#record(plan, lease); this.#assertCurrent(record);
    return this.jobStore.observe({ operationId: record.input.operationId, requestDigest: record.requestDigest, owner: record.owner });
  }
  async startMetadata(plan, lease) {
    const record = this.#record(plan, lease);
    if (record.starting) return record.starting;
    this.#assertCurrent(record, { dependencies: true });
    if (record.threadId) { this.jobStore.assertHandle(record.job, "native_ready"); return this.observe(plan, lease); }
    this.jobStore.markStarting(record.job); // durable write BEFORE native process/thread effects
    const parentEnv = { HOME: record.home, PATH: "/usr/bin:/bin", TMPDIR: path.join(record.directory, "tmp"),
      XDG_CONFIG_HOME: record.home, XDG_DATA_HOME: record.home, XDG_CACHE_HOME: record.derived.XDG_CACHE_HOME };
    const host = new CodexRuntimeHost({ paths: this.paths, repoRoot: this.repoRoot, cwd: record.owner.workspace,
      runtimeBinding: this.#binding(record.owner), runtimeEnvironment: record.environment, parentEnv,
      sessionStartTimeoutMs: 130_000, requestTimeoutMs: 130_000,
      prepareRuntime: async () => { this.#assertCurrent(record, { dependencies: true }); return {
        spawnEnv: { ...record.derived }, registeredSecrets: [],
        // These are actual pinned CLI features (features list): metadata inspection
        // uses only the explicit original MCP, never the default remote marketplace.
        configArgs: ["-c", "features.plugins=false", "-c", "features.remote_plugin=false"], assertCurrent: () => this.#assertCurrent(record, { dependencies: true }) }; } });
    record.host = host;
    record.starting = (async () => {
      try {
        this.onNativeHost?.(host); // trusted local observer; not passed by operation callers
        await host.initialize(); this.#assertCurrent(record);
        const account = await host.accountRead({ refreshToken: false }); this.#assertCurrent(record);
        if (account.account !== null || account.requiresOpenaiAuth !== true) fail("CREDENTIALLESS_HOME_REQUIRED");
        const started = await host.threadStart({ cwd: record.owner.workspace, ephemeral: false,
          approvalPolicy: "never", sandbox: "read-only", config: { mcp_servers: { "codex-security": structuredClone(record.spec) } } }, { signal: lease.signal });
        this.#assertCurrent(record);
        if (typeof started?.thread?.id !== "string" || !started.thread.id || started.thread.id.length > 512) fail("NATIVE_THREAD_INVALID");
        record.threadId = started.thread.id; this.jobStore.bindNativeThread(record.job, record.threadId);
        return this.observe(plan, lease);
      } catch (error) {
        try { this.jobStore.markUncertain(record.job, "NATIVE_START_OUTCOME_UNKNOWN"); } catch {}
        try { await host.stop(); } catch {}
        throw error;
      }
    })();
    return record.starting;
  }
  async listNativeTools(plan, lease) {
    const record = this.#record(plan, lease); this.#assertCurrent(record);
    this.jobStore.assertHandle(record.job, "native_ready");
    const response = await record.host.mcpServerStatusList({ threadId: record.threadId, detail: "toolsAndAuthOnly", limit: 100 }, { signal: lease.signal });
    this.#assertCurrent(record, { dependencies: true });
    const server = response.data.find(item => item.name === "codex-security");
    const tools = server?.tools;
    if (!tools || Object.getPrototypeOf(tools) !== Object.prototype || Object.keys(tools).length !== 45
      || Buffer.byteLength(JSON.stringify(tools)) > 2 * 1024 * 1024
      || Object.entries(tools).some(([key, item]) => typeof key !== "string" || key.length > 256
        || !item || typeof item.name !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(item.name))) fail("ORIGINAL_CATALOG_INVALID");
    record.tools = freeze(structuredClone(tools));
    return freeze({ version: 1, operationId: record.input.operationId, toolCount: 45,
      toolNames: Object.values(record.tools).map(tool => tool.name).sort(),
      sourceVersion: VERSION, fullPluginUsable: false, modelTurnStarted: false, scanStarted: false, originalToolsUnlocked: false });
  }
  // There is deliberately no raw tool-call or caller metadata escape hatch.
  // A future dedicated conversion must register the ORIGINAL component and use
  // CapabilityDispatcher.dispatch/authorizeEgress, plus the real owning turn.
  assertFullToolEgress(plan, lease) {
    const record = this.#record(plan, lease); this.#assertCurrent(record);
    const release = this.store.getRelease(SOURCE, record.installation.pin.releaseDigest);
    if (!release.components.mcpServers.some(item => item.name === "codex-security")) fail("ORIGINAL_COMPONENT_NOT_REGISTERED");
    fail("NATIVE_TURN_AND_DISPATCH_TICKET_REQUIRED");
  }
  async closeMetadata(plan, lease) {
    const record = this.#plans.get(plan);
    if (!record || record.lease !== lease) fail("PLAN_INVALID");
    if (record.closing) return record.closing;
    record.retired = true; // synchronously prevents late startup/list publication
    record.closing = (async () => {
      if (!record.host) { this.jobStore.failUnsent(record.job); return true; }
      await record.host.stop();
      if (record.host.cleanupIncomplete || !["stopped", "failed"].includes(record.host.state) || record.host.child !== null) fail("CLEANUP_UNCONFIRMED");
      if (this.jobStore.assertHandle(record.job).state === "native_ready") this.jobStore.closeMetadata(record.job);
      else this.jobStore.markUncertain(record.job, "NATIVE_START_OUTCOME_UNKNOWN");
      return true;
    })(); return record.closing;
  }
  async close() {
    if (this.#closed) return false;
    this.#closed = true;
    const results = await Promise.allSettled([...this.#operations.values()].map(record => this.closeMetadata(record.plan, record.lease)));
    if (results.some(result => result.status === "rejected")) fail("CLEANUP_UNCONFIRMED");
    return true;
  }
}

module.exports = { CodexSecurityNativeHostPlanFactory, CODEX_SECURITY_NATIVE_ENV_INVENTORY: ENV_INVENTORY,
  CODEX_SECURITY_NATIVE_ENV_NAMES: ENV_NAMES, CODEX_SECURITY_NATIVE_SPEC_FIELDS: SPEC_FIELDS };
