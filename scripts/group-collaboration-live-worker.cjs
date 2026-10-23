#!/usr/bin/env node
"use strict";

// Explicit real-model test worker. Only newly-created disposable Product,
// Profiles, groups, sessions, workspaces and Runtime processes belong to it.
// Native credentials follow the selected source's RuntimeAccount/overlay policy;
// they are not exported, copied between accounts, or used as a prior pass.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const SOURCE_CURRENT = path.resolve(__dirname, "..");
const SOURCE_MAIN = path.join(os.homedir(), "Documents", "claude", "Shoggoth");
const TIMEOUT_MS = 240_000;
const fail = code => Object.assign(new Error(code), { code });
const codeCatalogue = require("./group-collaboration-live-codes.cjs");
const codeOf = error => codeCatalogue.diagnosticCode(error).errorCode;
function recordExecutionFailure(result,error) { result.status="failed"; Object.assign(result,codeCatalogue.diagnosticCode(error)); result.failedPhase=result.phase; return result; }
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const hashFile = file => sha(fs.readFileSync(file));
const TERMINAL = new Set(["completed", "failed", "canceled", "interrupted", "skipped"]);
const RUNTIMES = new Set(["codex", "grok-build", "antigravity", "pi", "opencode", "deepseek-harness"]);
const SOURCE_FACT = "合成资料 S0：三笔试验记录的数值分别为4、5、6，总和为15。";
function parse(args) {
  const values = new Map(), keys = new Set(["--sourceRepo", "--source", "--runtime", "--workspace", "--output", "--descriptor", "--case", "--group", "--round", "--thresholds", "--hermesRuntimeRoot", "--codexDefaults"]);
  for (let index = 0; index < args.length; index += 2) {
    if (!keys.has(args[index]) || values.has(args[index]) || !args[index + 1] || args[index + 1].startsWith("--")) throw fail("GROUP_LIVE_ARGS_INVALID");
    values.set(args[index], args[index + 1]);
  }
  if (!values.has("--sourceRepo") || !values.has("--workspace") || !values.has("--output")) throw fail("GROUP_LIVE_ARGS_INVALID");
  const requestedSource = values.get("--sourceRepo"), sourceRepo = requestedSource === "main" ? SOURCE_MAIN
    : requestedSource === "candidate" ? SOURCE_CURRENT : requestedSource;
  const matrix = values.has("--descriptor");
  if (!path.isAbsolute(sourceRepo) || (!matrix && !RUNTIMES.has(values.get("--runtime")))) throw fail("GROUP_LIVE_SOURCE_OR_RUNTIME_INVALID");
  if (matrix && (values.has("--runtime") || !["--case", "--group", "--round", "--source"].every(key => values.has(key)))) throw fail("GROUP_LIVE_MATRIX_ARGS_INVALID");
  for (const key of ["--workspace", "--output"]) if (!path.isAbsolute(values.get(key))
    || !path.resolve(values.get(key)).startsWith("/private/tmp/") || path.resolve(values.get(key)) !== values.get(key)) throw fail("GROUP_LIVE_TEMP_PATH_REQUIRED");
  for (const key of ["--descriptor", "--thresholds", "--hermesRuntimeRoot", "--codexDefaults"]) if (values.has(key) && (!path.isAbsolute(values.get(key)) || path.resolve(values.get(key)) !== values.get(key))) throw fail("GROUP_LIVE_EVALUATION_PATH_INVALID");
  return { sourceRepo: fs.realpathSync(sourceRepo), runtime: values.get("--runtime") ?? null, workspace: values.get("--workspace"), output: values.get("--output"),
    matrix, sourceVersion: values.get("--source") ?? null, descriptor: values.get("--descriptor") ?? null,
    case: values.get("--case") ?? null, group: values.get("--group") ?? null, round: values.has("--round") ? Number(values.get("--round")) : null,
    thresholds: values.get("--thresholds") ?? null, hermesRuntimeRoot: values.get("--hermesRuntimeRoot") ?? null, codexDefaults: values.get("--codexDefaults") ?? null };
}
function privateDirectory(target, { create = false, empty = false } = {}) {
  if (!fs.existsSync(target) && create) fs.mkdirSync(target, { mode: 0o700 });
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(target) !== target || (stat.mode & 0o077) !== 0
    || process.getuid && stat.uid !== process.getuid() || empty && fs.readdirSync(target).length) throw fail("GROUP_LIVE_PRIVATE_DIRECTORY_REQUIRED");
  return target;
}
function metadata(sourceRepo) {
  for (const relative of ["app/agent-service/server.js", "app/shoggoth-mcp-helper.js", "app/agent-service/group-chat-service.js", "package.json"])
    if (!fs.lstatSync(path.join(sourceRepo, relative)).isFile()) throw fail("GROUP_LIVE_SOURCE_INVALID");
  let gitSha, sourceKind = "git-checkout", snapshot = null;
  try {
    const top = fs.realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: sourceRepo, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim());
    if (top !== sourceRepo) throw fail("GROUP_LIVE_SOURCE_ROOT_MISMATCH");
    gitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRepo, encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    const file = path.join(sourceRepo, ".group-collaboration-source-snapshot.json");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 || process.getuid && stat.uid !== process.getuid()) throw fail("GROUP_LIVE_SNAPSHOT_METADATA_INVALID");
    snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
    if (snapshot.version !== 1 || !/^[a-f0-9]{40}$/u.test(snapshot.gitSha || "")
      || execFileSync("git", ["cat-file", "-t", snapshot.gitSha], { cwd: SOURCE_MAIN, encoding: "utf8", timeout: 5000 }).trim() !== "commit")
      throw fail("GROUP_LIVE_SNAPSHOT_METADATA_INVALID");
    gitSha = snapshot.gitSha; sourceKind = "owned-git-archive-snapshot";
  }
  if (!/^[a-f0-9]{40}$/u.test(gitSha)) throw fail("GROUP_LIVE_SOURCE_SHA_INVALID");
  const files = [];
  const walkSource = relative => {
    const full = path.join(sourceRepo, relative);
    if (!fs.existsSync(full)) return;
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) return; // dependency links are recorded separately, never attributed to source.
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(full).sort()) {
        if (entry === "node_modules" || relative === "app" && entry === "manage-ui") continue;
        walkSource(path.join(relative, entry));
      }
    } else if (stat.isFile() && /\.(?:js|cjs|mjs|json|json5|py|toml|yaml|yml|md|txt|html|css|sh|ts|tsx)$/u.test(relative)) files.push(relative);
  };
  for (const relative of ["app", "schemas", "resources", "build/codex-runtime-manifest.json", "package.json", "package-lock.json"]) walkSource(relative);
  // One immutable tree inventory avoids thousands of subprocess launches. Each
  // byte sequence is verified against its committed Git blob and then hashed
  // for the common source digest; no candidate business code enters baseline.
  const committedBlobs = new Map();
  if (snapshot) {
    const tree = execFileSync("git", ["ls-tree", "-r", "-z", "--full-tree", gitSha], {
      cwd: SOURCE_MAIN, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }).toString("utf8");
    for (const row of tree.split("\0")) {
      if (!row) continue;
      const tab = row.indexOf("\t"), header = row.slice(0, tab).split(" ");
      if (tab < 0 || header.length !== 3 || !/^[a-f0-9]{40}$/u.test(header[2])) throw fail("GROUP_LIVE_SNAPSHOT_TREE_INVALID");
      if (header[1] === "blob" && ["100644", "100755"].includes(header[0])) committedBlobs.set(row.slice(tab + 1), header[2]);
    }
  }
  const sourceFiles = Object.fromEntries(files.sort().map(relative => {
    const bytes = fs.readFileSync(path.join(sourceRepo, relative));
    if (snapshot) {
      const gitBlob = crypto.createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex");
      if (gitBlob !== committedBlobs.get(relative)) throw fail("GROUP_LIVE_SNAPSHOT_SOURCE_CHANGED");
    }
    return [relative, sha(bytes)];
  }));
  const packageVersion = JSON.parse(fs.readFileSync(path.join(sourceRepo, "package.json"), "utf8")).version;
  return { repo: sourceRepo, gitSha, sourceKind, packageVersion, sourceFiles, sourceDigest: sha(JSON.stringify(sourceFiles)),
    sourceFingerprintScope: "app runtime code excluding manage-ui/node_modules; all resources and schemas text/code; build and package metadata; native binaries separately",
    dependencyEnvironment: { nodeVersion: process.version, architecture: process.arch, nodeModulesRoot: fs.realpathSync(path.join(sourceRepo, "node_modules")), lockDigest: sourceFiles["package-lock.json"] ?? null },
    dirty: snapshot ? false : execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: sourceRepo, encoding: "utf8", timeout: 5000 }).trim().length > 0 };
}
function observeFrozenSource(result, source, read = () => metadata(source.repo)) {
  try {
    const after = read();
    result.sourceAfter = { gitSha: after.gitSha, sourceKind: after.sourceKind, sourceDigest: after.sourceDigest, dirty: after.dirty };
    result.sourceBytesUnchanged = after.sourceDigest === source.sourceDigest;
    result.sourceRevisionUnchanged = after.gitSha === source.gitSha && after.sourceKind === source.sourceKind;
    result.sourceUnchanged = result.sourceBytesUnchanged && result.sourceRevisionUnchanged;
  } catch (error) {
    const diagnostic=codeCatalogue.diagnosticCode(error); result.sourceAfter = { unavailable: true, code:diagnostic.errorCode, ...(diagnostic.errorCodeDigest?{codeDigest:diagnostic.errorCodeDigest,codeAvailability:diagnostic.errorCodeAvailability}:{}) };
    result.sourceBytesUnchanged = null; result.sourceRevisionUnchanged = null; result.sourceUnchanged = null;
  }
}
const checkpointOwners = new Map();
function writeEvidenceCheckpoint(output, result, safe = value => value) {
  const target = output + ".checkpoint.json", previous = checkpointOwners.get(target);
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (!previous || !stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
      || process.getuid && stat.uid !== process.getuid() || stat.dev !== previous.dev || stat.ino !== previous.ino || stat.size !== previous.size
      || stat.mtimeMs !== previous.mtimeMs || stat.ctimeMs !== previous.ctimeMs)
      throw fail("GROUP_LIVE_CHECKPOINT_OWNERSHIP_INVALID");
  }
  const temporary = target + "." + crypto.randomUUID(), fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(safe({ ...result, checkpoint: { version: 1, finalReport: false,
    savedBeforeCleanupCompletion: true, savedAt: Date.now() } }), null, 2) + "\n"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, target); checkpointOwners.set(target, fs.lstatSync(target)); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return target;
}
async function boundedStop(stop, timeoutMs = 30_000) {
  let timer;
  try {
    await Promise.race([Promise.resolve().then(stop), new Promise((resolve, reject) => {
      // Keep this timer referenced: an unresolved stop Promise alone cannot
      // keep Node alive to preserve the final evidence report.
      timer = setTimeout(() => reject(fail("GROUP_LIVE_OWNED_STOP_TIMEOUT")), timeoutMs);
    })]);
    return { stopped: true, completionProven: true, timeoutMs };
  } catch (error) { return { stopped: false, completionProven: false, timeoutMs, ...codeCatalogue.diagnosticCode(error) }; }
  finally { clearTimeout(timer); }
}
function terminalChainMissing({ runs, current, tasks }) {
  return runs.length > 0 && runs.every(run => TERMINAL.has(run.status)) && current.discussion?.status === "idle"
    && (current.activeTurns?.length ?? 0) === 0 && !tasks.some(task => !["succeeded", "failed", "canceled"].includes(task.status));
}
function installOwnedNativeToolPolicies({ service, root, profiles, sourceRepo, caseId, result, codexDefaults }) {
  if (profiles.some(profile => !["codex", "deepseek-harness"].includes(profile.runtime))) throw fail("GROUP_LIVE_RUNTIME_TOOL_POLICY_UNPROVEN");
  const policyModule = require("./group-collaboration-live-policy.cjs");
  const groupNames = new Set(sourceModule(sourceRepo, "app/agent-service/group-mcp-tools").GROUP_MCP_TOOL_DEFINITIONS.map(tool => tool.name));
  const groupTools = sourceModule(sourceRepo, "app/agent-service/mcp-product-tool-controller").DEFAULT_TOOL_REGISTRY.mcpDefinitions()
    .filter(tool => groupNames.has(tool.name)).map(tool => tool.name);
  const toolEvidence = result.toolEnvironment ??= { version: 1, executionPolicy: "official-runtime-body-guards-or-named-permissions;owned-test-only",
    runtimes: [], sourceModuleHashes: {} };
  toolEvidence.sourceModuleHashes[policyModulePath()] = hashFile(policyModulePath());
  const ownProfiles = new Map(profiles.map(profile => [profile.runtimeProfileId, profile]));
  if (profiles.some(profile => profile.runtime === "codex")) {
    if (!codexDefaults?.config) throw fail("GROUP_LIVE_CODEX_DEFAULTS_REQUIRED");
    const permissionsPath = path.join(__dirname, "codex-owned-permissions-fixture.cjs"), permissions = require(permissionsPath);
    toolEvidence.sourceModuleHashes[permissionsPath] = hashFile(permissionsPath);
    const pool = service.runtimePool;
    if (!pool?.hostFactory) throw fail("GROUP_LIVE_CODEX_POLICY_BINDING_INVALID");
    const createHost = pool.hostFactory;
    pool.hostFactory = options => {
      const profile = ownProfiles.get(options.runtimeProfileId);
      if (!profile || profile.runtime !== "codex") throw fail("GROUP_LIVE_OWNED_RUNTIME_PROFILE_REQUIRED");
      const environment = options.runtimeEnvironment;
      const managedPrefix = pool.paths.runtimeAccountsDir + path.sep;
      if (environment?.strategy !== "managed-shared" || typeof environment.home !== "string" || !environment.home.startsWith(managedPrefix)
        || environment.runtimeAccountId !== sourceModule(sourceRepo, "app/agent-service/runtime-account").SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID
        || fs.existsSync(path.join(environment.home, "auth.json"))) throw fail("GROUP_LIVE_CODEX_MANAGED_AUTH_HOME_UNPROVEN");
      const originalPrepare = options.prepareRuntime;
      if (typeof originalPrepare !== "function") throw fail("GROUP_LIVE_CODEX_POLICY_BINDING_INVALID");
      let actualConfig = null, evidence = null;
      const verifiedThreadIds = new Set();
      const host = createHost.call(pool, { ...options, prepareRuntime: async input => {
        if (input.codexHome !== environment.home) throw fail("GROUP_LIVE_CODEX_MANAGED_AUTH_HOME_UNPROVEN");
        const prepared = await originalPrepare(input), configFile = path.join(input.codexHome, "config.toml");
        let configBytes = Buffer.alloc(0), parsed = {};
        if (fs.existsSync(configFile)) { configBytes = require("./group-collaboration-live-external.cjs").privateFile(configFile, 1024 * 1024, true);
          parsed = require("node:module").createRequire(path.join(sourceRepo, "package.json"))("smol-toml").parse(configBytes.toString("utf8")); }
        const names = Object.keys(parsed.mcp_servers ?? {});
        if (names.length > 1600 || names.some(name => !/^[A-Za-z0-9_-]{1,128}$/u.test(name))) throw fail("GROUP_LIVE_CODEX_MCP_CONFIG_INVALID");
        actualConfig = permissions.namedPermissionConfig({ workspace: profile.defaultCwd,
          writable: ["implementation-review", "approval-wait"].includes(caseId), disabledMcpNames: names.filter(name => name !== "shoggoth") });
        Object.assign(actualConfig, codexDefaults.config);
        const shellTemporary = path.join(root, "policy/codex-shell-tmp");
        if (!fs.existsSync(path.dirname(shellTemporary))) fs.mkdirSync(path.dirname(shellTemporary), { mode: 0o700 });
        if (!fs.existsSync(shellTemporary)) fs.mkdirSync(shellTemporary, { mode: 0o700 });
        Object.assign(actualConfig, permissions.ownedShellEnvironmentConfig({ tempDirectory: shellTemporary,
          inheritedSetNames: Object.keys(parsed.shell_environment_policy?.set ?? {}) }));
        const instructionsFile = path.join(root, "policy/codex-synthetic-instructions.md");
        const instructions = "Only use this synthetic evaluation request, its admitted group tools, and its owned workspace. Finish the requested goal.\n";
        if (!fs.existsSync(instructionsFile)) fs.writeFileSync(instructionsFile, instructions, { flag: "wx", mode: 0o400 });
        else if (fs.readFileSync(instructionsFile, "utf8") !== instructions) throw fail("GROUP_LIVE_CODEX_INSTRUCTIONS_CHANGED");
        const disabledSkillPaths = (Array.isArray(parsed.skills?.config) ? parsed.skills.config : []).map(skill => skill?.path).filter(value => typeof value === "string");
        Object.assign(actualConfig, permissions.ownedContextConfig({ instructionsFile, disabledSkillPaths }));
        actualConfig["mcp_servers.shoggoth.enabled"] = true;
        actualConfig["mcp_servers.shoggoth.enabled_tools"] = groupTools;
        if (!["implementation-review", "approval-wait"].includes(caseId)) {
          actualConfig["features.shell_tool"] = false; actualConfig["features.unified_exec"] = false; actualConfig["features.apply_patch_freeform"] = false;
        }
        evidence = { runtime: "codex", profileId: profile.id, workspace: profile.defaultCwd,
          method: "official-prepareRuntime-cli-config-overrides-and-owned-host-thread-named-permission-wrapper",
          authentication: "production-NativeCodexAuth-borrowed-in-memory-into-fresh-internal-managed-Home",
          managedHome: environment.home, runtimeAccountId: environment.runtimeAccountId, sourceDefaultProjection: codexDefaults.projection,
          sourceConfigSha256: codexDefaults.sourceConfigSha256, providerDefaultProof: codexDefaults.providerDefaultProof,
          inheritedConfigPath: configFile, inheritedConfigSha256: sha(configBytes), disabledInheritedMcpNames: names.filter(name => name !== "shoggoth").sort(),
          groupTools, configDigest: sha(JSON.stringify(actualConfig)), config: actualConfig, hostRequests: [], actualRuntimeVerified: false };
        toolEvidence.runtimes.push(evidence);
        return { ...prepared, configArgs: [...(prepared.configArgs ?? []), ...permissions.permissionConfigArgs(actualConfig)] };
      } });
      for (const method of ["threadStart", "threadResume"]) {
        const original = host[method].bind(host);
        host[method] = async (params, options) => {
          if (typeof params.threadId === "string") verifiedThreadIds.delete(params.threadId);
          if (!actualConfig || !evidence) throw fail("GROUP_LIVE_CODEX_POLICY_UNPREPARED");
          if (params.cwd !== profile.defaultCwd || params.model !== codexDefaults.config.model
            || params.modelProvider !== undefined && params.modelProvider !== codexDefaults.config.model_provider)
            throw fail("GROUP_LIVE_CODEX_FROZEN_THREAD_REQUEST_MISMATCH");
          const facade = { threadStart: method === "threadStart" ? original : async () => {},
            threadResume: method === "threadResume" ? original : async () => {} };
          const allowShell = ["implementation-review", "approval-wait"].includes(caseId);
          const beforeFeatures = await collectOwnedCodexFeatures(host);
          const threadConfig = { ...actualConfig, ...permissions.boundedLocalFeatureConfig(beforeFeatures, { allowShell }) };
          permissions.wrapOwnedPermissionHost(facade, threadConfig, evidence.hostRequests);
          evidence.beforeFeatureInventory = beforeFeatures;
          evidence.threadConfigDigest = sha(JSON.stringify(threadConfig));
          const sandbox = params.sandbox;
          const response = await facade[method]({ ...params, modelProvider: codexDefaults.config.model_provider }, options);
          const threadId = response.thread?.id;
          if (threadId) verifiedThreadIds.delete(threadId);
          if (!threadId || response.activePermissionProfile?.id !== actualConfig.default_permissions) throw fail("GROUP_LIVE_CODEX_NAMED_PROFILE_UNVERIFIED");
          if (response.thread.cwd !== profile.defaultCwd || response.model !== codexDefaults.config.model
            || response.modelProvider !== codexDefaults.config.model_provider) throw fail("GROUP_LIVE_CODEX_FROZEN_THREAD_RESPONSE_UNPROVEN");
          if (!Array.isArray(response.instructionSources) || response.instructionSources.some(file => typeof file !== "string"
            || !path.isAbsolute(file) || path.resolve(file) !== file || !file.startsWith(root + path.sep)
            || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink() || fs.realpathSync(file) !== file))
            throw fail("GROUP_LIVE_CODEX_PRIVATE_INSTRUCTION_SOURCE_UNPROVEN");
          const configRead = await host.configRead({ includeLayers: false, cwd: profile.defaultCwd });
          const actualModelConfig = Object.fromEntries(Object.keys(codexDefaults.config).map(key => [key, configRead.config?.[key] ?? null]));
          if (Object.keys(codexDefaults.config).some(key => actualModelConfig[key] !== codexDefaults.config[key]))
            throw fail("GROUP_LIVE_CODEX_FROZEN_THREAD_PARAMETERS_UNPROVEN");
          evidence.actualOwnedThreadModelParameters ??= [];
          evidence.actualOwnedThreadModelParameters.push({ threadId, model: response.model, modelProvider: response.modelProvider,
            reasoningEffort: response.reasoningEffort ?? null, serviceTier: response.serviceTier ?? null, actualModelConfig,
            instructionSources: response.instructionSources,
            provenance: "actual-owned-Host-effective-configRead-by-cwd-plus-thread-model-provider-response;no-pinned-thread-layer-or-original-Home-resolution-claim" });
          const afterFeatures = await collectOwnedCodexFeatures(host, threadId);
          permissions.assertOwnedFeatureInventory(afterFeatures, { allowShell });
          evidence.afterFeatureInventories ??= [];
          evidence.afterFeatureInventories.push({ threadId, features: afterFeatures, digest: sha(JSON.stringify(afterFeatures)) });
          const inventory = await collectOwnedCodexMcpInventory(host, threadId);
          if (inventory.some(server => server.name !== "shoggoth" && (server.runtimeStatus !== "disabled" || Object.keys(server.tools ?? {}).length !== 0)))
            throw fail("GROUP_LIVE_CODEX_MCP_INVENTORY_UNVERIFIED");
          const exposed = inventory.filter(server => server.name === "shoggoth").flatMap(server => Object.values(server.tools ?? {}).map(tool => tool.name));
          if (exposed.length !== groupTools.length || groupTools.some(name => !exposed.includes(name))) throw fail("GROUP_LIVE_CODEX_GROUP_INVENTORY_UNVERIFIED");
          evidence.hostRequests.push({ method, removedLegacySandbox: sandbox ?? null, threadId, namedProfile: response.activePermissionProfile,
            approvalPolicy: response.approvalPolicy, cwd: response.thread.cwd ?? null, groupTools: exposed, inventoryDigest: sha(JSON.stringify(inventory)), disabledInventoryNames: inventory.filter(server => server.name !== "shoggoth").map(server => server.name) });
          const account = await host.accountRead({ refreshToken: false }), accountIdentitySha256 = typeof host.nativeAccountId === "string" ? sha(host.nativeAccountId) : null;
          if (account.authSource !== "native-codex" || account.account?.type !== "chatgpt" || !accountIdentitySha256
            || accountIdentitySha256 !== result.codexAuthority?.accountIdentitySha256
            || codexDefaults.expectedSourceAccountIdentitySha256 && accountIdentitySha256 !== codexDefaults.expectedSourceAccountIdentitySha256)
            throw fail("GROUP_LIVE_CODEX_BORROWED_AUTH_UNPROVEN");
          evidence.borrowedAuthority ??= [];
          evidence.borrowedAuthority.push({ threadId, authSource: account.authSource, kind: account.account.type, accountIdentitySha256,
            sourceNativeIdentityMatched: true, credentialValuesExported: false });
          verifiedThreadIds.add(threadId);
          evidence.actualRuntimeVerified = true;
          return response;
        };
      }
      const originalTurn = host.turnStart.bind(host);
      host.turnStart = async (params, options) => {
        if (!evidence?.actualRuntimeVerified || !verifiedThreadIds.has(params.threadId) || params.model !== codexDefaults.config.model || params.cwd !== profile.defaultCwd
          || params.effort !== undefined && params.effort !== codexDefaults.config.model_reasoning_effort
          || params.serviceTier !== undefined && params.serviceTier !== codexDefaults.config.service_tier)
          throw fail("GROUP_LIVE_CODEX_FROZEN_TURN_PARAMETERS_MISMATCH");
        const account = await host.accountRead({ refreshToken: false }), accountIdentitySha256 = typeof host.nativeAccountId === "string" ? sha(host.nativeAccountId) : null;
        if (account.authSource !== "native-codex" || account.account?.type !== "chatgpt" || !accountIdentitySha256
          || accountIdentitySha256 !== result.codexAuthority?.accountIdentitySha256
          || codexDefaults.expectedSourceAccountIdentitySha256 && accountIdentitySha256 !== codexDefaults.expectedSourceAccountIdentitySha256)
          throw fail("GROUP_LIVE_CODEX_BORROWED_AUTH_UNPROVEN");
        const input = { ...params, ...(codexDefaults.config.model_reasoning_effort !== undefined ? { effort: codexDefaults.config.model_reasoning_effort } : {}),
          ...(codexDefaults.config.service_tier !== undefined ? { serviceTier: codexDefaults.config.service_tier } : {}) };
        evidence.turnRequests ??= [];
        evidence.turnRequests.push({ threadId: input.threadId, model: input.model, effort: input.effort ?? null,
          serviceTier: input.serviceTier ?? null, cwd: input.cwd, inputDigest: sha(JSON.stringify(input.input ?? [])) });
        return originalTurn(input, options);
      };
      return host;
    };
  }
  if (profiles.some(profile => profile.runtime === "deepseek-harness")) {
    const pool = service.deepSeekHarnessRuntimePool, createHost = pool.hostFactory, policies = new Map();
    for (const profile of profiles.filter(profile => profile.runtime === "deepseek-harness")) {
      const prepared = policyModule.preparePolicy({ root, workspace: profile.defaultCwd, readRoots: profiles.map(profile => profile.defaultCwd),
        runtime: profile.runtime, caseId, groupTools });
      const plugin = policyModule.writeDeepSeekPlugin({ root, prepared });
      const row = { runtime: profile.runtime, profileId: profile.id, workspace: profile.defaultCwd, policyFile: prepared.file,
        policySha256: prepared.sha256, plugin: plugin.plugin, pluginSha256: plugin.sha256, method: "official-ToolRuntime-monotonic-guard-before-tool-body-in-owned-Cordis-patch", launches: [] };
      toolEvidence.runtimes.push(row); policies.set(profile.runtimeProfileId, { prepared, plugin, row });
    }
    pool.hostFactory = options => {
      const binding = policies.get(options.runtimeProfileId);
      if (!binding) throw fail("GROUP_LIVE_OWNED_RUNTIME_PROFILE_REQUIRED");
      const host = createHost.call(pool, options), spawn = host.spawnProcess;
      host.spawnProcess = (file, args, spawnOptions) => {
        if (deepSeekVersionProbe(host, file, args)) {
          binding.row.versionProbes ??= [];
          binding.row.versionProbes.push({ command: file, args, cwd: spawnOptions.cwd, method: "unchanged-official-cli-version-only;no-profile-or-model" });
          return spawn.call(host, file, args, spawnOptions);
        }
        const profileIndex = args.indexOf("--profile");
        const contextComposition = policyModule.verifyDeepSeekContextComposition({ binaryPath: host.binaryPath, home: spawnOptions.env?.DSH_HOME, profile: args[profileIndex + 1] });
        const index = args.indexOf("--patch");
        if (index < 0 || !args[index + 1] || !args.includes("shoggoth-deepseek-harness-launcher")) throw fail("GROUP_LIVE_DEEPSEEK_PATCH_BINDING_INVALID");
        const original = args[index + 1];
        if (!original.startsWith(root + path.sep) || fs.realpathSync(original) !== original) throw fail("GROUP_LIVE_DEEPSEEK_PATCH_BINDING_INVALID");
        const base = fs.readFileSync(original, "utf8"), patch = path.join(root, "policy/deepseek-patch-" + crypto.randomUUID() + ".yml"),
          addition = "\n- insert:\n    - id: synthetic-owned-tool-guard\n      name: '" + require("node:url").pathToFileURL(binding.plugin.plugin).href.replaceAll("'", "''") + "'\n";
        fs.writeFileSync(patch, base + addition, { flag: "wx", mode: 0o400 });
        const actualArgs = [...args]; actualArgs[index + 1] = patch;
        binding.row.launches.push({ originalPatchDigest: sha(base), ownedPatch: patch, ownedPatchDigest: hashFile(patch), controlInstance: options.controlInstance === true,
          actualWorkspace: spawnOptions.cwd, contextComposition, pluginSha256: hashFile(binding.plugin.plugin) });
        return spawn.call(host, file, actualArgs, spawnOptions);
      };
      return host;
    };
  }
}
function deepSeekVersionProbe(host, file, args) {
  return typeof host?.launch?.command === "string" && file === host.launch.command && Array.isArray(host.launch.argsPrefix)
    && Array.isArray(args) && JSON.stringify(args) === JSON.stringify([...host.launch.argsPrefix, "--version"]);
}
function runtimeSdkObservation(result) {
  const rows=(result.toolEnvironment?.runtimes??[]).filter(row=>row.runtime==="deepseek-harness"),files=rows.flatMap(row=>row.launches??[]).flatMap(launch=>launch.contextComposition?.sdkFiles??[]);
  if(rows.length && (!files.length || rows.some(row=>!(row.launches?.length))))return {availability:"unavailable-no-admitted-sdk-launch",unchanged:null,observedFiles:0};
  try {return {availability:files.length?"actual-before-after-sdk-files":"not-applicable",unchanged:files.every(file=>hashFile(file.path)===file.sha256),observedFiles:files.length};}
  catch(error){return {availability:"unavailable-final-sdk-file-read",unchanged:null,observedFiles:files.length,...codeCatalogue.diagnosticCode(error)};}
}
async function collectOwnedCodexFeatures(host, threadId = null) {
  const features = [], cursors = new Set(); let cursor = null;
  do {
    if (cursors.has(cursor) || cursors.size >= 32) throw fail("GROUP_LIVE_CODEX_FEATURE_PAGINATION_INVALID"); cursors.add(cursor);
    const response = await host.experimentalFeatureList({ cursor, limit: 100, ...(threadId ? { threadId } : {}) });
    if (!Array.isArray(response?.data) || features.length + response.data.length > 2048) throw fail("GROUP_LIVE_CODEX_FEATURE_INVENTORY_UNAVAILABLE");
    features.push(...response.data.map(row => ({ name: row.name, enabled: row.enabled })));
    cursor = response.nextCursor ?? null;
    if (cursor !== null && (typeof cursor !== "string" || !cursor)) throw fail("GROUP_LIVE_CODEX_FEATURE_PAGINATION_INVALID");
  } while (cursor !== null);
  return features;
}
async function collectOwnedCodexMcpInventory(host, threadId) {
  const servers = [], names = new Set(), cursors = new Set(); let cursor = null;
  do {
    if (cursors.has(cursor) || cursors.size >= 32) throw fail("GROUP_LIVE_CODEX_MCP_PAGINATION_INVALID"); cursors.add(cursor);
    const response = await host.mcpServerStatusList({ threadId, cursor, limit: 100, detail: "toolsAndAuthOnly" });
    if (!Array.isArray(response?.data) || servers.length + response.data.length > 2048) throw fail("GROUP_LIVE_CODEX_MCP_INVENTORY_UNVERIFIED");
    for (const server of response.data) { if (typeof server.name !== "string" || !server.name || names.has(server.name)) throw fail("GROUP_LIVE_CODEX_MCP_INVENTORY_UNVERIFIED");
      names.add(server.name); servers.push(server); }
    cursor = response.nextCursor ?? null;
    if (cursor !== null && (typeof cursor !== "string" || !cursor)) throw fail("GROUP_LIVE_CODEX_MCP_PAGINATION_INVALID");
  } while (cursor !== null);
  return servers;
}
function observeOwnedNativeProcesses({ service, profiles, result, identify }) {
  const external = require("./group-collaboration-live-external.cjs"), records = [];
  const ownIds = new Set(profiles.map(profile => profile.runtimeProfileId)), restore = [];
  for (const [runtime, name] of [["codex", "runtimePool"], ["deepseek-harness", "deepSeekHarnessRuntimePool"], ["antigravity", "antigravityRuntimePool"]]) {
    if (!profiles.some(profile => profile.runtime === runtime)) continue;
    const pool = service[name], factory = pool?.hostFactory;
    if (typeof factory !== "function") throw fail("GROUP_LIVE_NATIVE_PROCESS_OBSERVER_UNAVAILABLE");
    const wrapped = function(options) {
      if (!ownIds.has(options.runtimeProfileId)) throw fail("GROUP_LIVE_NATIVE_PROCESS_PROFILE_UNOWNED");
      const host = factory.call(pool, options), spawn = host?.spawnProcess;
      if (typeof spawn !== "function") throw fail("GROUP_LIVE_NATIVE_PROCESS_OBSERVER_UNAVAILABLE");
      host.spawnProcess = function(file, args, spawnOptions) {
        const proc = spawn.call(host, file, args, spawnOptions);
        records.push(...external.captureOwnedProcesses({ ownedNativeProcesses: [{ proc, kind: "owned-native-" + runtime,
          detached: spawnOptions?.detached === true }], ...(identify ? { identify } : {}) }));
        return proc;
      };
      return host;
    };
    pool.hostFactory = wrapped; restore.push(() => { if (pool.hostFactory !== wrapped) throw fail("GROUP_LIVE_NATIVE_PROCESS_OBSERVER_CHANGED"); pool.hostFactory = factory; });
  }
  if (profiles.some(profile => profile.runtime === "codex")) {
    const nativeAuth = service.runtimePool.options?.nativeAuth;
    if (typeof nativeAuth?._createHost !== "function" || typeof nativeAuth.read !== "function") throw fail("GROUP_LIVE_CODEX_NATIVE_AUTH_OBSERVER_UNAVAILABLE");
    const create = nativeAuth._createHost, read = nativeAuth.read;
    const authority = result.codexAuthority ??= { method: "unchanged-production-NativeCodexAuth-reader-and-owned-internal-managed-runtime",
      nativeReaderRpc: [], reads: [], accountIdentitySha256: null, credentialsExported: false };
    authority.nativeReaderPolicyViolation = false; authority.blockedNativeReaderRequests = 0;
    const denyNativeReader = code => { authority.nativeReaderPolicyViolation = true; authority.blockedNativeReaderRequests++; throw fail(code); };
    const createObserved = function() {
      const host = create.call(this);
      if (!host) return host;
      if (result.codexNativeDefaults && host.runtimeEnvironment?.home !== path.dirname(result.codexNativeDefaults.sourceConfigPath))
        throw fail("GROUP_LIVE_CODEX_NATIVE_AUTH_HOME_MISMATCH");
      const spawn = host.spawnProcess, initialize = host.initialize;
      if (typeof spawn !== "function" || typeof initialize !== "function" || host.options.nativeAuthSource !== true)
        throw fail("GROUP_LIVE_CODEX_NATIVE_AUTH_OBSERVER_UNAVAILABLE");
      host.spawnProcess = function(file, args, spawnOptions) {
        const proc = spawn.call(host, file, args, spawnOptions);
        records.push(...external.captureOwnedProcesses({ ownedNativeProcesses: [{ proc, kind: "owned-native-codex-auth-reader",
          detached: spawnOptions?.detached === true }], ...(identify ? { identify } : {}) }));
        return proc;
      };
      host.initialize = async function(...args) {
        authority.nativeReaderRpc.push({ method: "initialize", metadataOnly: true });
        const response = await initialize.apply(host, args), request = host.rpc?.request;
        if (typeof request !== "function") throw fail("GROUP_LIVE_CODEX_NATIVE_AUTH_OBSERVER_UNAVAILABLE");
        host.rpc.request = function(method, params, ...rest) {
          if (authority.nativeReaderPolicyViolation) return denyNativeReader("GROUP_LIVE_CODEX_NATIVE_AUTH_POLICY_ALREADY_VIOLATED");
          if (!["account/read", "getAuthStatus"].includes(method)) return denyNativeReader("GROUP_LIVE_CODEX_NATIVE_AUTH_METHOD_FORBIDDEN");
          if (params?.refreshToken !== false) return denyNativeReader("GROUP_LIVE_CODEX_NATIVE_AUTH_REFRESH_FORBIDDEN");
          authority.nativeReaderRpc.push({ method, refreshToken: typeof params?.refreshToken === "boolean" ? params.refreshToken : null, metadataOnly: true });
          return request.call(this, method, params, ...rest);
        };
        return response;
      };
      return host;
    };
    const readObserved = async function(options = {}) {
      if (authority.nativeReaderPolicyViolation) return denyNativeReader("GROUP_LIVE_CODEX_NATIVE_AUTH_POLICY_ALREADY_VIOLATED");
      if (options.refreshToken === true) return denyNativeReader("GROUP_LIVE_CODEX_NATIVE_AUTH_REFRESH_FORBIDDEN");
      const tokens = await read.call(this, options), identity = tokens ? sha(tokens.chatgptAccountId) : null;
      if (identity && authority.accountIdentitySha256 && identity !== authority.accountIdentitySha256) throw fail("GROUP_LIVE_CODEX_NATIVE_ACCOUNT_CHANGED");
      if (identity) authority.accountIdentitySha256 = identity;
      authority.reads.push({ refreshRequested: options.refreshToken === true, previousAccountSpecified: typeof options.previousAccountId === "string",
        returnedAuthority: Boolean(tokens), accountIdentitySha256: identity });
      return tokens;
    };
    nativeAuth._createHost = createObserved; nativeAuth.read = readObserved;
    restore.push(() => {
      if (nativeAuth._createHost !== createObserved || nativeAuth.read !== readObserved) throw fail("GROUP_LIVE_NATIVE_PROCESS_OBSERVER_CHANGED");
      nativeAuth._createHost = create; nativeAuth.read = read;
    });
  }
  result.nativeProcessObservation = { method: "actual-owned-pool-host-spawn-returned-childprocess-handles-and-os-identity", supportedRuntimes: profiles.map(profile => profile.runtime) };
  return { records,
    snapshot() { return records.map(record => ({ kind: record.kind, pid: record.pid, before: record.before, detachedGroup: record.detachedGroup,
      ownershipUnverified: Boolean(record.ownershipUnverified), exitObserved: record.exitObserved, closeObserved: record.closeObserved })); },
    async finish(options) { const evidence = await external.verifyOwnedProcessesStopped(records, options);
      for (const undo of restore.reverse()) undo(); return evidence; }
  };
}
function policyModulePath() { return path.join(__dirname, "group-collaboration-live-policy.cjs"); }
function sourceModule(sourceRepo, relative) { return require(path.join(sourceRepo, relative)); }
function finishCodexObservation(result, snapshot) {
  if (!snapshot) return;
  result.codexDefaultsFinalObservation = require("./group-collaboration-codex-defaults.cjs").finalObservation(snapshot);
  if (result.codexSdkLayout) {
    try { result.codexDefaultsFinalObservation.layoutManifestUnchanged = hashFile(path.join(result.codexSdkLayout.layoutRepo, "build/codex-runtime-manifest.json")) === result.codexSdkLayout.layoutManifestSha256; }
    catch { result.codexDefaultsFinalObservation.layoutManifestUnchanged = null; }
    for (const [name, file, expected] of [["codeModeHostUnchanged", result.codexSdkLayout.hostPath, result.codexSdkLayout.hostSha256],
      ["packageMetadataUnchanged", result.codexSdkLayout.packageMetadataPath, result.codexSdkLayout.packageMetadataSha256]]) {
      try { result.codexDefaultsFinalObservation[name] = hashFile(file) === expected; } catch { result.codexDefaultsFinalObservation[name] = null; }
    }
  }
  const rows = result.toolEnvironment?.runtimes?.filter(row => row.runtime === "codex") ?? [];
  result.codexManagedHomeAuthFileObservation = rows.length ? rows.map(row => ({ home: row.managedHome,
    authFileAbsent: !fs.existsSync(path.join(row.managedHome, "auth.json")) })) : null;
  if (Object.values(result.codexDefaultsFinalObservation).some(value => value !== true)
    || result.codexManagedHomeAuthFileObservation?.some(row => !row.authFileAbsent)) {
    result.status = "failed"; result.errorCode ??= "GROUP_LIVE_CODEX_DEFAULTS_OR_AUTH_HOME_CHANGED"; process.exitCode = 1;
  }
  if (result.codexAuthority) result.codexAuthority.automaticRefreshObserved = result.codexAuthority.nativeReaderRpc.some(row => row.refreshToken === true);
  if (result.codexAuthority?.nativeReaderPolicyViolation === true) {
    result.status = "failed"; result.errorCode ??= "GROUP_LIVE_CODEX_NATIVE_AUTH_POLICY_ALREADY_VIOLATED"; process.exitCode = 1;
  }
}
function bindOwnedCodexSdkLayout({ service, sourceRepo, selectedBinary, layoutRepo = SOURCE_MAIN }) {
  const pool = service.runtimePool, resolver = pool?.runtimeAccountResolver, nativeAuth = pool?.options?.nativeAuth;
  if (typeof resolver?.resolve !== "function" || typeof nativeAuth?._createHost !== "function") throw fail("GROUP_LIVE_CODEX_LAYOUT_BINDING_INVALID");
  const sourceManifest = hashFile(path.join(sourceRepo, "build/codex-runtime-manifest.json")), layoutManifest = hashFile(path.join(layoutRepo, "build/codex-runtime-manifest.json"));
  if (sourceManifest !== layoutManifest) throw fail("GROUP_LIVE_CODEX_SOURCE_BINARY_VERSION_MISMATCH");
  const layout = sourceModule(sourceRepo, "app/agent-service/codex-runtime-paths").resolveCodexRuntimeLayout({ repoRoot: layoutRepo });
  const packageMetadataPath = path.join(layout.packageRoot, "codex-package.json"), hostSha256 = hashFile(layout.hostPath), packageMetadataSha256 = hashFile(packageMetadataPath);
  if (layout.runtimePath !== selectedBinary || hostSha256 !== "ed79fbc9e1683feb29d73fb421f3e16932d178a459f63741754014c6c7ea6107"
    || packageMetadataSha256 !== "824178a0339491c83a5b74d045e7aa1874102dfb66552a9ab787ebbd5accbff1") throw fail("GROUP_LIVE_CODEX_COMPANION_BINARY_PIN_MISMATCH");
  const sourceSchema = new (sourceModule(sourceRepo, "app/agent-service/codex-schema-contract").CodexSchemaContract)({ repoRoot: sourceRepo });
  const resolve = resolver.resolve, create = nativeAuth._createHost;
  resolver.resolve = function(binding, account, options = {}) {
    const resolved = resolve.call(this, binding, account, binding.runtime === "codex" && account.kind === "shoggoth-managed"
      ? { ...options, repoRoot: layoutRepo, packaged: false } : options);
    if (binding.runtime === "codex" && account.kind === "shoggoth-managed" && resolved.binaryPath !== selectedBinary)
      throw fail("GROUP_LIVE_CODEX_SOURCE_BINARY_VERSION_MISMATCH");
    return resolved;
  };
  nativeAuth._createHost = function() {
    const prior = this.options;
    this.options = { ...prior, repoRoot: layoutRepo, packaged: false, schemaContract: sourceSchema };
    try {
      const host = create.call(this);
      if (host) {
        if (host.runtimeEnvironment?.binaryPath !== selectedBinary) throw fail("GROUP_LIVE_CODEX_SOURCE_BINARY_VERSION_MISMATCH");
        host.options.repoRoot = sourceRepo;
      }
      return host;
    } finally { this.options = prior; }
  };
  return { method: "unchanged-Source-resolver-and-NativeAuth-factory;only-public-pinned-layout-repo-overridden;Source-schema-and-host-retained",
    layoutRepo, selectedBinary, sourceManifestSha256: sourceManifest, layoutManifestSha256: layoutManifest,
    hostPath: layout.hostPath, hostSha256, packageMetadataPath, packageMetadataSha256,
    sourceSchemaRetained: true, sourcePoolClosuresRetained: true };
}
// This binds a disposable test directory, not the production MCP identity.
// Keep the runtime gate, parent verification and Service relay authoritative.
function helperRootBinding(root, sourceRepo, ownership = null, expected = null) {
  const canonical = value => typeof value === "string" && path.isAbsolute(value)
    && path.resolve(value) === value && !value.includes("\0");
  const ownObject = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
      const property = Object.getOwnPropertyDescriptor(value, key);
      return property?.enumerable === true && Object.hasOwn(property, "value");
    });
  const rootKeys = ["dev", "ino", "uid", "mode"];
  const sameRoot = (left, right) => rootKeys.every(key => left[key] === right[key]);
  const validRoot = stat => stat.isDirectory() && !stat.isSymbolicLink()
    && rootKeys.every(key => Number.isSafeInteger(stat[key]) && stat[key] >= 0)
    && typeof process.getuid === "function" && stat.uid === process.getuid() && (stat.mode & 0o077) === 0;
  if (!canonical(root) || path.dirname(root) !== "/private/tmp" || !canonical(sourceRepo)
    || ownership === null && !root.startsWith("/private/tmp/sggroup-live-")) throw fail("GROUP_LIVE_HELPER_ROOT_INVALID");
  if (ownership !== null && (!ownObject(ownership, ["root", "sourceRepo", "markerPath", "markerSha256"])
    || ownership.root !== root || ownership.sourceRepo !== sourceRepo || !canonical(ownership.markerPath)
    || path.dirname(ownership.markerPath) !== root || !/^[a-f0-9]{64}$/u.test(ownership.markerSha256))) {
    throw fail("GROUP_LIVE_HELPER_OWNERSHIP_INVALID");
  }
  const stat = fs.lstatSync(root);
  if (!validRoot(stat) || fs.realpathSync(root) !== root || fs.realpathSync(sourceRepo) !== sourceRepo) throw fail("GROUP_LIVE_HELPER_ROOT_INVALID");
  const identity = Object.fromEntries(rootKeys.map(key => [key, stat[key]]));
  if (expected && (!sameRoot(identity, expected.identity) || expected.root !== root || expected.sourceRepo !== sourceRepo
    || JSON.stringify(expected.ownership) !== JSON.stringify(ownership))) throw fail("GROUP_LIVE_HELPER_ROOT_CHANGED");
  if (ownership !== null) {
    const file = ownership.markerPath, before = fs.lstatSync(file);
    const fileKeys = ["dev", "ino", "uid", "mode", "nlink", "size", "mtimeMs", "ctimeMs"];
    const stable = value => fileKeys.every(key => before[key] === value[key]);
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== identity.uid || before.nlink !== 1
      || (before.mode & 0o077) !== 0 || !Number.isSafeInteger(before.size) || before.size < 1 || before.size > 65536
      || fs.realpathSync(file) !== file) throw fail("GROUP_LIVE_HELPER_MARKER_INVALID");
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let bytes;
    try {
      const opened = fs.fstatSync(fd);
      if (!stable(opened)) throw fail("GROUP_LIVE_HELPER_MARKER_INVALID");
      bytes = fs.readFileSync(fd);
      const after = fs.fstatSync(fd), named = fs.lstatSync(file);
      if (!Buffer.isBuffer(bytes) || bytes.length !== before.size || !stable(after) || !stable(named) || named.isSymbolicLink()
        || crypto.createHash("sha256").update(bytes).digest("hex") !== ownership.markerSha256) throw fail("GROUP_LIVE_HELPER_MARKER_INVALID");
    } finally { try { fs.closeSync(fd); } finally { bytes?.fill(0); } }
  }
  const after = fs.lstatSync(root);
  if (!validRoot(after) || !sameRoot(identity, after) || fs.realpathSync(root) !== root) throw fail("GROUP_LIVE_HELPER_ROOT_CHANGED");
  return { root, sourceRepo, ownership: ownership === null ? null : { root, sourceRepo,
    markerPath: ownership.markerPath, markerSha256: ownership.markerSha256 }, identity };
}
function writeHelper(root, sourceRepo, ownership = null) {
  const rootBinding = helperRootBinding(root, sourceRepo, ownership);
  const bootstrap = path.join(root, "group-mcp-bootstrap.cjs");
  const text = `"use strict";
const root=${JSON.stringify(root)},sourceRepo=${JSON.stringify(sourceRepo)},rootBinding=${JSON.stringify(rootBinding)};
let phase="builtins",key=null,record=null,failureReported=false,input=null,output=null,signalFailure;
const failureSignal=new Promise(resolve=>{signalFailure=resolve;});
const fail=code=>Object.assign(new Error(code),{code});
const publicCodes=new Set(["GROUP_LIVE_HELPER_ROOT_INVALID","GROUP_LIVE_HELPER_OWNERSHIP_INVALID","GROUP_LIVE_HELPER_ROOT_CHANGED","GROUP_LIVE_HELPER_MARKER_INVALID","GROUP_LIVE_HELPER_KEY_INVALID","GROUP_LIVE_HELPER_TOOLS_MISSING","GROUP_LIVE_HELPER_FRAME_TOO_LARGE","BOOTSTRAP_ROLE_REJECTED","BOOTSTRAP_CODE_IDENTITY_TIMEOUT","BOOTSTRAP_CODE_IDENTITY_INVALID","BOOTSTRAP_MCP_START_FAILED","MCP_HELPER_ARGUMENTS_INVALID","MCP_HELPER_AUTH_FAILED","MCP_HELPER_FAILED","MCP_HELPER_SERVICE_UNAVAILABLE","MCP_HELPER_SERVICE_RECOVERY_REQUIRED"]);
const reportFailure=error=>{if(failureReported)return;failureReported=true;let code="GROUP_LIVE_HELPER_FAILED";try{const property=Object.getOwnPropertyDescriptor(error,"code");if(property&&Object.hasOwn(property,"value")&&publicCodes.has(property.value))code=property.value;}catch{}const diagnostic={phase,errorCode:code};try{record?.({direction:"harness",method:"helper.failure",...diagnostic});}catch{}try{process.stderr.write(JSON.stringify(diagnostic)+"\\n");}catch{}if(Buffer.isBuffer(key))key.fill(0);process.exitCode=1;signalFailure();try{process.stdin.unpipe(input);}catch{}for(const stream of [input,output])try{stream?.destroy(fail("GROUP_LIVE_HELPER_FAILED"));}catch{};};
const run=async()=>{
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),{Transform}=require("node:stream");
${helperRootBinding.toString()}
phase="root";helperRootBinding(root,sourceRepo,rootBinding.ownership,rootBinding);
record=entry=>{helperRootBinding(root,sourceRepo,rootBinding.ownership,rootBinding);fs.appendFileSync(path.join(root,"helper-observations.jsonl"),JSON.stringify(entry)+"\\n",{mode:0o600});};
phase="key";
const keyFile=path.join(root,"mcp-key.bin"),stat=fs.lstatSync(keyFile);
if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size!==32||(stat.mode&0o077)!==0||stat.uid!==process.getuid()||fs.realpathSync(keyFile)!==keyFile)throw fail("GROUP_LIVE_HELPER_KEY_INVALID");
const keyFd=fs.openSync(keyFile,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),keyFields=["dev","ino","uid","mode","nlink","size","mtimeMs","ctimeMs"];
try{const opened=fs.fstatSync(keyFd);if(!keyFields.every(field=>stat[field]===opened[field]))throw fail("GROUP_LIVE_HELPER_KEY_INVALID");key=fs.readFileSync(keyFd);const after=fs.fstatSync(keyFd),named=fs.lstatSync(keyFile);if(!Buffer.isBuffer(key)||key.length!==32||named.isSymbolicLink()||!keyFields.every(field=>stat[field]===after[field]&&stat[field]===named[field]))throw fail("GROUP_LIVE_HELPER_KEY_INVALID");}finally{fs.closeSync(keyFd);}
helperRootBinding(root,sourceRepo,rootBinding.ownership,rootBinding);
const safeStorage={isEncryptionAvailable:()=>true,encryptString(value){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv("aes-256-gcm",key,iv);const bytes=Buffer.concat([cipher.update(value,"utf8"),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),bytes]);},decryptString(bytes){const cipher=crypto.createDecipheriv("aes-256-gcm",key,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString("utf8");}};
phase="source";
const {resolveServicePaths}=require(path.join(sourceRepo,"app/agent-service/paths"));
const {startShoggothMcpHelper}=require(path.join(sourceRepo,"app/shoggoth-mcp-helper"));
const {DEFAULT_TOOL_REGISTRY}=require(path.join(sourceRepo,"app/agent-service/mcp-product-tool-controller"));
const toolDefinitions=DEFAULT_TOOL_REGISTRY.mcpDefinitions().filter(tool=>["group_member_role_read","group_messages_read","group_task","group_collaborate"].includes(tool.name));
if(!["group_member_role_read","group_messages_read"].every(name=>toolDefinitions.some(tool=>tool.name===name)))throw fail("GROUP_LIVE_HELPER_TOOLS_MISSING");
const paths=resolveServicePaths({homeDir:root});
const listRequests=new Set();
const shape=(value,depth=0)=>depth>=5?typeof value:Array.isArray(value)?value.length?[shape(value[0],depth+1)]:[]:value&&typeof value==="object"?Object.fromEntries(Object.entries(value).slice(0,48).map(([key,item])=>[key,shape(item,depth+1)])):typeof value;
const observe=direction=>{let pending=Buffer.alloc(0);return new Transform({transform(chunk,encoding,done){
  try{
    if(failureReported)return done(fail("GROUP_LIVE_HELPER_FAILED"));
    const priorPhase=phase;phase="root";helperRootBinding(root,sourceRepo,rootBinding.ownership,rootBinding);phase=priorPhase;
    pending=Buffer.concat([pending,chunk]);const frames=[];
    for(let end;(end=pending.indexOf(10))>=0;){
      let bytes=pending.subarray(0,end+1);pending=pending.subarray(end+1);let frame=null;
      try{frame=JSON.parse(bytes.subarray(0,-1).toString("utf8"));}catch{}
      if(frame&&typeof frame==="object"){
        const entry={direction,method:frame.method??"response",frameId:frame.id??null};
        if(direction==="runtime"&&frame.method==="tools/list")listRequests.add(JSON.stringify(frame.id));
        if(frame.method==="tools/call"){entry.name=frame.params?.name;if(typeof frame.params?.arguments?.action==="string")entry.action=frame.params.arguments.action;}
        if(direction==="helper"&&listRequests.has(JSON.stringify(frame.id))&&Array.isArray(frame.result?.tools)){
          listRequests.delete(JSON.stringify(frame.id));const original=frame.result.tools;
          entry.originalToolNames=original.map(tool=>tool.name);entry.originalInventoryDigest=crypto.createHash("sha256").update(JSON.stringify(original)).digest("hex");
          frame.result.tools=original.filter(tool=>toolDefinitions.some(definition=>definition.name===tool.name));
          entry.groupToolsAvailable=frame.result.tools.map(tool=>tool.name);entry.catalogFilter="transparent-response-inventory-group-tools-only;definitions-preserved";bytes=Buffer.from(JSON.stringify(frame)+"\\n");
        }
        if(frame.method==="elicitation/create"){entry.parameterShape=shape(frame.params);entry.parameterDigest=crypto.createHash("sha256").update(JSON.stringify(frame.params)).digest("hex");}
        if(frame.result)entry.resultShape=shape(frame.result);if(frame.error)entry.rpcError=true;
        record(entry);
      }
      frames.push(bytes);
    }
    if(pending.length>1024*1024)throw fail("GROUP_LIVE_HELPER_FRAME_TOO_LARGE");
    done(null,Buffer.concat(frames));
  }catch(error){reportFailure(error);done(fail("GROUP_LIVE_HELPER_FAILED"));}
}});};
phase="streams";input=observe("runtime");output=observe("helper");input.on("error",reportFailure);output.on("error",reportFailure);process.stdin.pipe(input);output.pipe(process.stdout);
const start=async()=>{if(process.env.SHOGGOTH_RUNTIME_MCP_GATE_FILE!==undefined){record({direction:"harness",method:"helper.route",route:"production-bootstrap-role-runtime-gate-relay",canonicalRoot:"owned-test-home",parentIdentity:"actual-process-fields"});const bootstrap=require(path.join(sourceRepo,"app/bootstrap-role"));const relay=require(path.join(sourceRepo,"app/runtime-mcp-relay"));return bootstrap.main(process.argv.slice(1),process.env,{userInfo:()=>({...require("node:os").userInfo(),homedir:root})},{runtimeMcpRelay:bridge=>{if(failureReported){bridge.socket?.destroy();throw fail("GROUP_LIVE_HELPER_FAILED");}return relay.startRuntimeMcpRelay({...bridge,input,output});}});}record({direction:"harness",method:"helper.route",route:"production-standalone-helper-runtime-binding",bindRuntimeCalls:true});return startShoggothMcpHelper({paths,safeStorage,toolDefinitions,input,output,electronApp:{whenReady:async()=>{},quit(){}},serviceVersion:"group-collaboration-real-native-worker"});};
if(failureReported)throw fail("GROUP_LIVE_HELPER_FAILED");
phase="start";return Promise.race([start(),failureSignal.then(()=>{throw fail("GROUP_LIVE_HELPER_FAILED");})]);
};
run().catch(reportFailure).finally(()=>{if(Buffer.isBuffer(key))key.fill(0);});
`;
  helperRootBinding(root, sourceRepo, ownership, rootBinding);
  fs.writeFileSync(bootstrap, text, { flag: "wx", mode: 0o600 });
  return bootstrap;
}
function sourcePrompt(collaborative, sourceSeq) {
  const shared = `这是专用隔离测试。唯一需要复述的源事实是：${SOURCE_FACT}\n`
    + "不得读取工作区以外的文件、凭据或历史，不使用网络、浏览器、终端、文件写入或其他业务工具，不联系外部对象。只完成一次有界群工具链。\n"
    + `必须先实际调用 group_messages_read，messageSeq 使用这条原始请求的真实序号 ${sourceSeq}、offset 为 0；digest 从宿主输入清单或当前事项来源引用取得。读取回执后再交结果，不能只根据已见正文跳过该工具。\n`;
  return shared + (collaborative
    ? "补读后使用 group_collaborate finish，clientActionId 固定为 source-handoff-result，summary 完整复述上述源事实。调用成功后停止本轮，最终正文使用同一份 summary；不新增分工、不调用其他终结动作，不另开阶段。"
    : `当前源版本未提供 group_collaborate。补读后使用 group_task propose，target 是你自己的 @handle，仅创建一个自身正式任务。objective 明确要求：在正式执行回合实际调用 group_messages_read 按原始请求序号 ${sourceSeq} 和固定 digest 补读，然后用 group_task complete 提交完整 summary，逐字保留上述源事实。inputs 放该事实，constraints 写只用这两个群工具且禁止其他操作。提出后本讨论回合停止，可返回 (pass)。系统随后启动的正式任务只完成上述读取与 complete，summary 完整复述源事实，artifacts 为空。不得再提出第二个任务。`
  );
}
function makeSafeStorage(key) {
  return { isEncryptionAvailable: () => true,
    encryptString(value) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([iv, ...(() => { const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return [cipher.getAuthTag(), bytes]; })()]); },
    decryptString(bytes) { const cipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8"); } };
}
function configureProfile(service, base, runtime, runtimeAccountId, workspace, name, defaultModel = null) {
  const fields = ["id", "backendId", "agentId", "name", "runtime", "runtimeProfileId", "runtimeAccountId", "providerRef", "defaultModel", "defaultCwd", "permissionPolicy", "concurrency", "isDefault", "enabled", "createdAt", "updatedAt"];
  const profile = Object.fromEntries(fields.map(key => [key, base[key]]));
  const id = crypto.randomUUID();
  Object.assign(profile, { id, backendId: "shoggoth", agentId: `group-live-${id}`, name, runtime,
    runtimeProfileId: `group-live-${id}`, runtimeAccountId, providerRef: null, defaultModel,
    defaultCwd: workspace, permissionPolicy: { approvalPolicy: "on-request", sandbox: runtime === "opencode" ? "danger-full-access" : runtime === "deepseek-harness" ? "workspace-write" : "read-only" },
    concurrency: { maxActive: 1, maxWorkspaceWrites: 1 }, isDefault: false, enabled: true });
  const saved = service.productStore.putAgentProfile(profile);
  service.agentDefinitionStore.ensureProfile({ profileId: id, profileName: name });
  service.memoryStore.ensureProfile(id); service.nativeSkillStore.ensureProfile(id);
  return saved;
}
async function bindInstalledAntigravityVerifier({ service, paths, installedPaths, selectedBinary, verifyServer }) {
  const pool = service.antigravityRuntimePool;
  if (!pool?.options || typeof verifyServer !== "function" || !path.isAbsolute(selectedBinary)
    || paths === installedPaths) throw fail("GROUP_LIVE_ANTIGRAVITY_VERIFIER_BINDING_INVALID");
  const selected = fs.realpathSync(selectedBinary);
  const verified = await verifyServer({ paths: installedPaths });
  if (fs.realpathSync(verified.serverPath) !== selected) throw fail("GROUP_LIVE_ANTIGRAVITY_VERIFIED_BINARY_MISMATCH");
  // Ledger and execution paths remain disposable. Only the unchanged source
  // distribution verifier reads the existing installed server+harness, with
  // its full release hashes and Google code-signature checks still in force.
  pool.options.verifyServer = async input => {
    if (input?.paths !== paths) throw fail("GROUP_LIVE_ANTIGRAVITY_OWNED_PATHS_MISMATCH");
    const current = await verifyServer({ ...input, paths: installedPaths });
    if (fs.realpathSync(current.serverPath) !== selected) throw fail("GROUP_LIVE_ANTIGRAVITY_VERIFIED_BINARY_MISMATCH");
    return current;
  };
  return { method: "selected-source-full-release-hash-and-google-signature-verifier-existing-install",
    version: verified.version, serverPath: verified.serverPath, serverSha256: hashFile(verified.serverPath),
    harnessPath: verified.harnessPath, harnessSha256: hashFile(verified.harnessPath),
    executionAndLedgerPathsRemainOwned: true };
}
function prepareExistingAntigravityAuthSelector({ paths, installedPaths, accountId, sourceRepo }) {
  const { runtimeAccountIntegrationRoot } = sourceModule(sourceRepo, "app/agent-service/runtime-account-resolver");
  const { prepareAntigravityRuntimeAccountHome } = sourceModule(sourceRepo, "app/agent-service/antigravity-runtime-paths");
  const { antigravityAcpAuthType, prepareAntigravityAcpHome } = sourceModule(sourceRepo, "app/agent-service/antigravity-runtime-config");
  const { atomicWritePrivateFile } = sourceModule(sourceRepo, "app/agent-service/private-file");
  const originalSettings = path.join(runtimeAccountIntegrationRoot(installedPaths, "antigravity", accountId), "home", ".gemini/antigravity-acp/settings.json");
  const before = fs.lstatSync(originalSettings);
  const selected = antigravityAcpAuthType({ settingsPath: originalSettings, trustedRoot: installedPaths.trustedRoot });
  if (selected === null) throw fail("GROUP_LIVE_ANTIGRAVITY_AUTH_SELECTOR_MISSING");
  const originalSha = hashFile(originalSettings), after = fs.lstatSync(originalSettings);
  if ([before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs].join(":")
    !== [after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs].join(":")) throw fail("GROUP_LIVE_ANTIGRAVITY_AUTH_SELECTOR_CHANGED");
  const home = prepareAntigravityRuntimeAccountHome(paths, accountId);
  const owned = prepareAntigravityAcpHome({ home, trustedRoot: paths.trustedRoot });
  if (!owned.settingsPath.startsWith(paths.trustedRoot + path.sep) || fs.existsSync(owned.settingsPath))
    throw fail("GROUP_LIVE_ANTIGRAVITY_AUTH_SELECTOR_OWNED_TARGET_INVALID");
  const body = JSON.stringify({ auth: { type: selected } }) + "\n";
  atomicWritePrivateFile(owned.settingsPath, body, { trustedRoot: paths.trustedRoot });
  if (antigravityAcpAuthType({ settingsPath: owned.settingsPath, trustedRoot: paths.trustedRoot }) !== selected)
    throw fail("GROUP_LIVE_ANTIGRAVITY_AUTH_SELECTOR_COPY_FAILED");
  return { originalSettingsPath: originalSettings, originalSettingsSha256: originalSha,
    originalSettingsBytes: before.size, originalSettingsMtimeMs: before.mtimeMs, originalSettingsCtimeMs: before.ctimeMs,
    ownedSettingsPath: owned.settingsPath, ownedSettingsSha256: sha(body), selectedMethodPresent: true,
    copiedFields: ["auth.type"], credentialFieldsCopied: false, credentialValidity: "not-yet-authenticated",
    originalSettingsModifiedByHarness: false };
}
function recordCalls(service, profiles, events, startedAt) {
  const original = service.groupChatService.callTool.bind(service.groupChatService);
  service.groupChatService.callTool = async (name, args, run, profileId, ...rest) => {
    const record = { atMs: Date.now() - startedAt, name, action: typeof args.action === "string" ? args.action : null,
      runId: run?.id ?? null, profileId, arguments: require("./group-collaboration-live-matrix.cjs").safeEvidence(args),
      nativeRunBound: Boolean(run?.id && profiles.some(profile => profile.id === profileId)),
      runtime: run?.runtimeSessionRef?.runtime ?? null,
      ...(name === "group_messages_read" ? { sourceSeq: args.messageSeq ?? null, sourceOffset: args.offset ?? 0, requestedDigest: args.digest ?? null } : {}) };
    try { const result = await original(name, args, run, profileId, ...rest);
      record.ok = result?.ok !== false; record.code = null; if (result?.ok === false) { const diagnostic=codeCatalogue.diagnosticCode({code:result.code},null); record.code=diagnostic.errorCode; if(diagnostic.errorCodeDigest)record.codeDigest=diagnostic.errorCodeDigest; if(diagnostic.errorCodeAvailability)record.codeAvailability=diagnostic.errorCodeAvailability; }
      if (name === "group_messages_read" && result?.page) record.readReceipt = { digest: result.page.digest,
        offset: result.page.offset, totalBytes: result.page.totalBytes, providedBytes: Buffer.byteLength(result.page.text), nextOffset: result.page.nextOffset };
      events.push(record); return result;
    } catch (error) { record.ok = false; const diagnostic=codeCatalogue.diagnosticCode(error); record.code=diagnostic.errorCode; if(diagnostic.errorCodeDigest)record.codeDigest=diagnostic.errorCodeDigest; if(diagnostic.errorCodeAvailability)record.codeAvailability=diagnostic.errorCodeAvailability; events.push(record); throw error; }
  };
  return () => { service.groupChatService.callTool = original; };
}
async function executeSmoke(options) {
  const matrix = require("./group-collaboration-live-matrix.cjs");
  const disk = fs.statfsSync("/private/tmp");
  if (disk.bavail * disk.bsize < 1024 ** 3) throw fail("GROUP_LIVE_DISK_SPACE_LOW");
  if (path.dirname(options.output) !== "/private/tmp") privateDirectory(path.dirname(options.output));
  if (fs.existsSync(options.output)) throw fail("GROUP_LIVE_OUTPUT_EXISTS");
  privateDirectory(options.workspace, { create: true, empty: true });
  const source = metadata(options.sourceRepo);
  const { createAgentService, PROTOCOL_VERSION } = sourceModule(options.sourceRepo, "app/agent-service/server");
  const { resolveServicePaths, resolveCanonicalServicePaths } = sourceModule(options.sourceRepo, "app/agent-service/paths");
  const { requestService, readClientToken } = sourceModule(options.sourceRepo, "app/agent-service/client");
  const { RuntimeMcpGateIssuer } = sourceModule(options.sourceRepo, "app/agent-service/runtime-mcp-gate");
  const { DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME, SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID } = sourceModule(options.sourceRepo, "app/agent-service/runtime-account");
  const { GROUP_MCP_TOOL_DEFINITIONS } = sourceModule(options.sourceRepo, "app/agent-service/group-mcp-tools");
  const { isRuntimeAvailable } = sourceModule(options.sourceRepo, "app/runtime-availability");
  const { createRuntimeCliAuth } = sourceModule(options.sourceRepo, "app/runtime-cli-auth");
  if (!isRuntimeAvailable(options.runtime)) throw fail("GROUP_LIVE_RUNTIME_RELEASE_DISABLED");
  const codexDefaults = options.runtime === "codex" ? require("./group-collaboration-codex-defaults.cjs").load(options.codexDefaults,
    { sdkVersion: sourceModule(options.sourceRepo, "app/agent-service/codex-schema-contract").CODEX_VERSION }) : null;
  const authority = createRuntimeCliAuth({ paths: resolveCanonicalServicePaths(), repoRoot: options.sourceRepo, homedir: os.homedir() })
    .find(item => item.runtime === options.runtime && item.accountKind === "native-user");
  if (!authority?.binaryPath) throw fail("GROUP_LIVE_RUNTIME_NOT_INSTALLED");
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sggroup-live-")); fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ homeDir: root });
  const key = crypto.randomBytes(32); fs.writeFileSync(path.join(root, "mcp-key.bin"), key, { flag: "wx", mode: 0o600 });
  const bootstrapPath = writeHelper(root, options.sourceRepo), command = fs.realpathSync(process.execPath);
  const mcpHelperLaunch = { command, argsPrefix: [bootstrapPath] };
  const parentEnv = { ...process.env };
  const runtimeBinary = { selected: authority.binaryPath, sha256: hashFile(authority.binaryPath), origin: "installed-native-runtime" };
  if (options.runtime === "codex") {
    const { resolveCodexRuntimeLayout } = sourceModule(options.sourceRepo, "app/agent-service/codex-runtime-paths");
    const { CODEX_VERSION } = sourceModule(options.sourceRepo, "app/agent-service/codex-schema-contract");
    const pinned = resolveCodexRuntimeLayout({ repoRoot: SOURCE_MAIN });
    if (pinned.version !== CODEX_VERSION) throw fail("GROUP_LIVE_CODEX_SOURCE_BINARY_VERSION_MISMATCH");
    const pinHash = hashFile(pinned.runtimePath), nativeFixture = fs.readFileSync(path.join(SOURCE_MAIN, "scripts/codex-mcp-tool-call-native-fixture.cjs"), "utf8");
    const expected = /EXPECTED_BINARY_SHA\s*=\s*'([a-f0-9]{64})'/u.exec(nativeFixture)?.[1];
    if (!expected || pinHash !== expected) throw fail("GROUP_LIVE_CODEX_BINARY_HASH_MISMATCH");
    const bin = path.join(root, "bin"); fs.mkdirSync(bin, { mode: 0o700 }); fs.symlinkSync(pinned.runtimePath, path.join(bin, "codex"));
    parentEnv.PATH = `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
    Object.assign(runtimeBinary, { selected: pinned.runtimePath, sha256: pinHash, origin: "main-vendor-pinned-only", version: pinned.version });
  }
  const optionNames = { "grok-build": "grokBuildBinaryPath", antigravity: "antigravityBinaryPath", pi: "piBinaryPath",
    opencode: "openCodeBinaryPath", "deepseek-harness": "deepSeekHarnessBinaryPath" };
  const service = createAgentService({ paths, repoRoot: options.sourceRepo, version: source.packageVersion,
    parentEnv, runtimeStorageHomedir: os.homedir(), safeStorage: makeSafeStorage(key), prewarmMcpAuth: false,
    mcpHelperLaunch, runtimeMcpGateIssuer: new RuntimeMcpGateIssuer({ paths, mcpHelperLaunch, bootstrapPath }),
    ...(optionNames[options.runtime] ? { [optionNames[options.runtime]]: authority.binaryPath } : {}) });
  options.ownedServiceConstructed = true;
  const codexSdkLayout = codexDefaults ? bindOwnedCodexSdkLayout({ service, sourceRepo: options.sourceRepo, selectedBinary: runtimeBinary.selected }) : null;
  const installedAntigravityVerifier = options.runtime === "antigravity" ? await bindInstalledAntigravityVerifier({
    service, paths, installedPaths: resolveCanonicalServicePaths(), selectedBinary: runtimeBinary.selected,
    verifyServer: sourceModule(options.sourceRepo, "app/agent-service/antigravity-acp-distribution").verifyAntigravityAcpServer }) : null;
  const existingAntigravityAuthSelector = options.runtime === "antigravity" ? prepareExistingAntigravityAuthSelector({
    paths, installedPaths: resolveCanonicalServicePaths(), accountId: DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME.antigravity, sourceRepo: options.sourceRepo }) : null;
  const startedAt = Date.now(), result = { reportVersion: 1, status: "failed", diagnosticCodeCatalogue: codeCatalogue.evidence, evidence: "isolated-source-service-real-native-provider-and-production-group-mcp",
    source, worker: { path: __filename, sha256: hashFile(__filename) }, runtime: options.runtime, runtimeBinary, codexNativeDefaults: codexDefaults, codexSdkLayout,
    ...(codexDefaults ? { codexAuthority: { method: "unchanged-production-NativeCodexAuth-reader-and-owned-internal-managed-runtime",
      sourceRuntimeAccountId: DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME.codex, executionRuntimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
      authoritySemantics: "same-native-chatgpt-account-borrowed-in-memory;managed-account-identifies-execution-home-only", nativeReaderRpc: [], reads: [], accountIdentitySha256: null, credentialsExported: false } } : {}),
    installedAntigravityVerifier, existingAntigravityAuthSelector, nativeAuth: { classification: "existing-native-authority-reused-by-source-adapter", valuesExported: false,
      accountKind: authority.accountKind, providerVerified: false },
    isolation: { root, workspace: options.workspace, productProfilesGroupsSessionsAndServiceState: "disposable-only",
      originalProfilesGroupsAndRunsModified: false, nativeHomeUsesExistingAuthority: true,
      thirdPartyNativeHistoryBoundary: "The source RuntimeAccount policy may persist its own native CLI history/auth refresh in its original home; Product sessions and ledgers remain disposable." },
    capabilityBranch: GROUP_MCP_TOOL_DEFINITIONS.some(tool => tool.name === "group_collaborate") ? "collaboration-v2" : "legacy-group-task",
    groupCalls: [], helperInventoryEvidence: [], runOutcomes: [], finalMessages: [], phase: "start", serviceStopped: false, providerCalls: null,
    overallMatrixComplete: false, remainingMatrix: "eight scenarios x three mixed groups x three rounds; all supported adapters require own actual chain" };
  options.executionResult = result;
  let profiles = [], groupId = null, undoCalls = null, undoRuntime = null, nativeProcesses = null, aborted = false;
  undoRuntime = matrix.observeRuntime(service, result);
  const interrupt = () => { aborted = true; };
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  const call = (method, params) => requestService(paths, { token: readClientToken(paths), version: PROTOCOL_VERSION, method, params }, { timeoutMs: 15000 });
  const stage = value => { result.phase = value; process.stdout.write(`GROUP_LIVE_STAGE ${value}\n`); };
  try {
    options.ownedExecutionMayHaveStarted = true;
    await service.start(); stage("configure-disposable-profiles");
    const base = service.productStore.listAgentProfiles()[0], account = options.runtime === "codex" ? SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID : DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME[options.runtime];
    profiles = ["Reader", "Observer"].map(name => {
      const workspace = path.join(options.workspace, name.toLowerCase()); fs.mkdirSync(workspace, { mode: 0o700 });
      return configureProfile(service, base, options.runtime, account, workspace, name, codexDefaults?.config.model ?? null);
    });
    result.effectivePolicies = profiles.map(profile => ({ profileId: profile.id, runtime: profile.runtime,
      runtimeAccountId: profile.runtimeAccountId, workspace: profile.defaultCwd, requestedModel: profile.defaultModel,
      declaredPermissionPolicy: profile.permissionPolicy, nativeReadOnlyProven: null,
      proofStatus: "profile-declaration-only;actual-runtime-response-fields-recorded-separately" }));
    installOwnedNativeToolPolicies({ service, root, profiles, sourceRepo: options.sourceRepo, caseId: "source-handoff", result, codexDefaults });
    nativeProcesses = observeOwnedNativeProcesses({ service, profiles, result });
    undoCalls = recordCalls(service, profiles, result.groupCalls, startedAt);
    const collaborative = result.capabilityBranch === "collaboration-v2";
    stage("create-disposable-group");
    const created = await call("group.create", { operationId: "isolated-native-group-create", name: "Isolated native source handoff",
      purpose: "Real source-read/group-tool/result chain; bounded local acceptance only", ...(collaborative ? { mode: "collaborative" } : {}),
      members: profiles.map(profile => ({ backendId: "shoggoth", agentId: profile.agentId })) });
    groupId = created.group.id; result.ownedGroupId = groupId;
    const member = created.members.find(item => item.agentId === profiles[0].agentId);
    if (!member) throw fail("GROUP_LIVE_READER_MEMBER_MISSING");
    const expectedSourceSeq = created.group.lastSeq + 1;
    const prompt = sourcePrompt(collaborative, expectedSourceSeq); result.sourceMessageDigest = sha(prompt);
    stage("submit-source-handoff");
    const sent = await call("group.send", { groupId, clientMessageId: "isolated-native-source-handoff", body: prompt,
      mentions: [member.id], replyTo: null, attachments: [], ...(collaborative ? { expectedPolicyVersion: created.group.policyVersion } : {}) });
    result.sourceMessageSeq = sent.message.seq; result.ownedRequestId = sent.discussionId;
    if (sent.message.seq !== expectedSourceSeq) throw fail("GROUP_LIVE_SOURCE_SEQUENCE_INVALID");
    stage("await-real-tool-result");
    const deadline = Date.now() + TIMEOUT_MS;
    let completed = false, terminalMissingSince = null;
    while (Date.now() < deadline && !aborted) {
      const tasks = service.groupChatStore.listTasks(groupId);
      const history = service.groupChatStore.listMessages({ groupId, limit: 200 });
      const published = history.messages.filter(message => message.author.kind === "member" && message.body.includes(SOURCE_FACT));
      const reads = result.groupCalls.filter(event => event.name === "group_messages_read" && event.ok && event.nativeRunBound
        && event.sourceSeq === result.sourceMessageSeq && event.readReceipt?.digest === result.sourceMessageDigest
        && event.readReceipt.offset === 0 && event.readReceipt.nextOffset === null);
      const controls = result.groupCalls.filter(event => event.ok && event.nativeRunBound && (collaborative
        ? event.name === "group_collaborate" && event.action === "finish" : event.name === "group_task" && event.action === "complete"));
      const current = service.groupChatStore.getGroup(groupId);
      const ownRuns = service.workRunCoordinator.listRuns().filter(run => profiles.some(profile => profile.id === run.profileId));
      const unfinished = ownRuns.filter(run => !TERMINAL.has(run.status));
      if (current.pendingInteractions?.length) { result.pendingInteractionCount = current.pendingInteractions.length; throw fail("GROUP_LIVE_USER_INTERACTION_REQUIRED"); }
      if (reads.length && controls.length && published.length && unfinished.length === 0 && (collaborative
        ? current.collaboration?.requests?.some(request => request.completion?.state === "completed") || current.discussion?.completion?.state === "completed"
        : tasks.some(task => task.status === "succeeded" && task.result?.summary?.includes(SOURCE_FACT)))) { completed = true; break; }
      const failed = ownRuns.find(run => ["failed", "interrupted", "canceled"].includes(run.status));
      if (failed && !unfinished.length) { const diagnostic = codeCatalogue.diagnosticCode({ code: failed.errorCode }, "GROUP_LIVE_RUN_FAILED"); throw Object.assign(fail(diagnostic.errorCode), { codeDigest: diagnostic.errorCodeDigest, codeAvailability: diagnostic.errorCodeAvailability }); }
      if (terminalChainMissing({ runs: ownRuns, current, tasks })) {
        terminalMissingSince ??= Date.now();
        if (Date.now() - terminalMissingSince >= 1000) throw fail("GROUP_LIVE_TERMINAL_CHAIN_MISSING");
      } else terminalMissingSince = null;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!completed) throw fail(aborted ? "GROUP_LIVE_INTERRUPTED" : "GROUP_LIVE_TIMEOUT");
    result.nativeAuth.providerVerified = true; result.status = "passed"; result.completedAtMs = Date.now() - startedAt;
    stage("verified-real-chain");
  } catch (error) { recordExecutionFailure(result,error); process.exitCode = 1; }
  finally {
    try {
      result.runOutcomes = service.workRunCoordinator.listRuns().filter(run => profiles.some(profile => profile.id === run.profileId)).map(run => ({
        id: run.id, profileId: run.profileId, status: run.status, runtime: run.runtimeSessionRef?.runtime ?? null,
        runtimeSessionRef: run.runtimeSessionRef ?? null, runtimeTurnRef: run.runtimeTurnRef ?? null,
        startedAt: run.startedAt ?? null, finishedAt: run.finishedAt ?? null,
        ...codeCatalogue.diagnosticCode({ code: run.errorCode }, null),
        resultContainsSourceFact: run.resultSummary?.includes(SOURCE_FACT) === true }));
      result.providerUsage = profiles.flatMap(profile => service.tokenUsageStore.list({ profileId: profile.id }));
      result.maintenanceUsage = service.tokenUsageStore.list().filter(record => !profiles.some(profile => profile.id === record.profileId));
      result.usageAvailability = { native: result.providerUsage.length ? "raw-product-runtime-usage-records" : "unavailable",
        providerRequestCount: null, note: "WorkRun or zero token counts do not reveal internal Provider request count." };
      result.effectiveModelEvidence = result.runOutcomes.map(run => {
        const models = [...new Set(result.providerUsage.filter(row => row.runId === run.id && row.model).map(row => row.model))];
        const sessions = [...new Set((result.runtimeOperationEvidence || []).filter(row => row.runtimeProfileId === run.runtimeSessionRef?.runtimeProfileId
          && row.session?.model).map(row => row.session.model))];
        return { runId: run.id, runtimeUsageReportedModels: models, runtimeSessionReportedModels: sessions,
          completed: run.status === "completed", effectiveModel: run.status === "completed" && models.length === 1 ? models[0] : null,
          unavailableEffectiveModel: run.status !== "completed" || models.length !== 1, provenance: "runtime-reported-usage-and-session-values" };
      });
      if (groupId) {
        const history = service.groupChatStore.listMessages({ groupId, limit: 200 });
        result.finalMessages = history.messages.filter(message => message.author.kind === "member").map(message => ({ seq: message.seq,
          body: message.body, digest: sha(message.body), sourceFactIncluded: message.body.includes(SOURCE_FACT) }));
        result.tasks = service.groupChatStore.listTasks(groupId).map(task => ({ status: task.status,
          sourceFactIncluded: task.result?.summary?.includes(SOURCE_FACT) === true, attempts: task.attempts.length }));
        const current = service.groupChatStore.getGroup(groupId);
        result.requestCompletion = current.collaboration?.requests?.map(request => request.completion?.state ?? null) ?? [current.discussion?.completion?.state ?? null];
      }
      const file = path.join(root, "helper-observations.jsonl");
      result.helperInventoryEvidence = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
    } catch { result.observationUnavailable = true; }
    result.nativeOwnedProcessSnapshot = nativeProcesses?.snapshot() ?? null;
    result.serviceStopped = null;
    try { observeFrozenSource(result, source); result.checkpointPath = writeEvidenceCheckpoint(options.output, result, matrix.safeEvidence); }
    catch (error) { result.checkpointUnavailable = true; const diagnostic=codeCatalogue.diagnosticCode(error); result.checkpointErrorCode=diagnostic.errorCode; if(diagnostic.errorCodeDigest)result.checkpointErrorCodeDigest=diagnostic.errorCodeDigest; if(diagnostic.errorCodeAvailability)result.checkpointErrorCodeAvailability=diagnostic.errorCodeAvailability; }
    stage("stop-owned-service");
    result.serviceStopEvidence = await boundedStop(() => service.stop({ notify: false }));
    result.nativeStopEvidence = nativeProcesses ? await nativeProcesses.finish() : null;
    result.serviceStopped = result.serviceStopEvidence.stopped && result.nativeStopEvidence?.stopped === true;
    if (!result.serviceStopped) { result.status = "failed"; result.cleanupErrorCodes = [...(result.cleanupErrorCodes ?? []), result.serviceStopEvidence.errorCode ?? "GROUP_LIVE_NATIVE_PROCESS_STOP_UNPROVEN"];
      result.errorCode ??= "GROUP_LIVE_OWNED_SERVICE_STOP_FAILED"; process.exitCode = 1; }
    undoCalls?.(); undoRuntime?.(); key.fill(0); process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
    result.durationMs = Date.now() - startedAt;
    observeFrozenSource(result, source);
    result.runtimeBinaryUnchanged = hashFile(runtimeBinary.selected) === runtimeBinary.sha256
      && (!installedAntigravityVerifier || hashFile(installedAntigravityVerifier.harnessPath) === installedAntigravityVerifier.harnessSha256);
    if (!result.sourceUnchanged || !result.runtimeBinaryUnchanged) { result.status = "failed"; result.errorCode = "GROUP_LIVE_SOURCE_OR_BINARY_CHANGED"; process.exitCode = 1; }
    finishCodexObservation(result, codexDefaults);
    fs.writeFileSync(options.output, `${JSON.stringify(matrix.safeEvidence(result), null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  return result;
}
function matrixOwnedLayout(requestedWorkspace) {
  privateDirectory(requestedWorkspace, { create: true, empty: true });
  const root=fs.realpathSync(fs.mkdtempSync("/private/tmp/sggroup-live-"));fs.chmodSync(root,0o700);
  const workspace=path.join(root,"workspace");privateDirectory(workspace,{create:true,empty:true});
  return {root,workspace,requestedWorkspace,requestedWorkspaceUsage:"validated-empty-declaration-only;all-runtime-workspaces-artifacts-and-approvals-use-the-new-owned-root-workspace"};
}
async function executeMatrix(options) {
  const matrix = require("./group-collaboration-live-matrix.cjs"), externalModule = require("./group-collaboration-live-external.cjs");
  const disk = fs.statfsSync("/private/tmp");
  if (disk.bavail * disk.bsize < 1024 ** 3) throw fail("GROUP_LIVE_DISK_SPACE_LOW");
  const evaluated = matrix.evaluation(options);
  if (path.dirname(options.output) !== "/private/tmp") privateDirectory(path.dirname(options.output));
  if (fs.existsSync(options.output)) throw fail("GROUP_LIVE_OUTPUT_EXISTS");
  const source = metadata(options.sourceRepo);
  if (options.sourceVersion === "baseline" && source.gitSha !== evaluated.descriptor.sourcePolicy.baselineGit) throw fail("GROUP_LIVE_BASELINE_SOURCE_MISMATCH");
  const { createAgentService, PROTOCOL_VERSION } = sourceModule(options.sourceRepo, "app/agent-service/server");
  const { resolveServicePaths, resolveCanonicalServicePaths } = sourceModule(options.sourceRepo, "app/agent-service/paths");
  const { requestService, readClientToken } = sourceModule(options.sourceRepo, "app/agent-service/client");
  const { RuntimeMcpGateIssuer } = sourceModule(options.sourceRepo, "app/agent-service/runtime-mcp-gate");
  const { DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME, SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID } = sourceModule(options.sourceRepo, "app/agent-service/runtime-account");
  const { GROUP_MCP_TOOL_DEFINITIONS } = sourceModule(options.sourceRepo, "app/agent-service/group-mcp-tools");
  const { isRuntimeAvailable } = sourceModule(options.sourceRepo, "app/runtime-availability");
  const { createRuntimeCliAuth } = sourceModule(options.sourceRepo, "app/runtime-cli-auth");
  const capabilities = GROUP_MCP_TOOL_DEFINITIONS.some(tool => tool.name === "group_collaborate");
  if (options.sourceVersion === "candidate" && !capabilities) throw fail("GROUP_LIVE_CANDIDATE_PROTOCOL_MISSING");
  if (evaluated.roles.some(role => role.runtime === "hermes")) {
    if (!options.hermesRuntimeRoot) throw fail("GROUP_LIVE_HERMES_ARCHIVE_REQUIRED");
    require("./group-collaboration-hermes-runtime.cjs").loadArchive(options.hermesRuntimeRoot);
  }
  const nativeRoles = evaluated.roles.filter(role => RUNTIMES.has(role.runtime));
  const codexDefaults = nativeRoles.some(role => role.runtime === "codex")
    ? require("./group-collaboration-codex-defaults.cjs").load(options.codexDefaults, { sdkVersion: sourceModule(options.sourceRepo, "app/agent-service/codex-schema-contract").CODEX_VERSION }) : null;
  if (nativeRoles.length + evaluated.roles.filter(role => ["hermes", "openclaw"].includes(role.runtime)).length !== evaluated.roles.length) throw fail("GROUP_LIVE_MATRIX_RUNTIME_INVALID");
  const auth = createRuntimeCliAuth({ paths: resolveCanonicalServicePaths(), repoRoot: options.sourceRepo, homedir: os.homedir() });
  const authorities = nativeRoles.map(role => {
    if (!isRuntimeAvailable(role.runtime)) throw fail("GROUP_LIVE_RUNTIME_RELEASE_DISABLED");
    const authority = auth.find(item => item.runtime === role.runtime && item.accountKind === "native-user");
    if (!authority?.binaryPath) throw fail("GROUP_LIVE_RUNTIME_NOT_INSTALLED");
    return { role, authority };
  });
  const layout = matrixOwnedLayout(options.workspace), root = layout.root;
  options.workspace = layout.workspace;
  const paths = resolveServicePaths({ homeDir: root });
  const key = crypto.randomBytes(32); fs.writeFileSync(path.join(root, "mcp-key.bin"), key, { flag: "wx", mode: 0o600 });
  const bootstrapPath = writeHelper(root, options.sourceRepo), command = fs.realpathSync(process.execPath), mcpHelperLaunch = { command, argsPrefix: [bootstrapPath] };
  const parentEnv = { ...process.env }, runtimeBinaries = [], runtimeOptions = {};
  const optionNames = { "grok-build": "grokBuildBinaryPath", antigravity: "antigravityBinaryPath", pi: "piBinaryPath", opencode: "openCodeBinaryPath", "deepseek-harness": "deepSeekHarnessBinaryPath" };
  for (const { role, authority } of authorities) {
    let binaryPath = authority.binaryPath, origin = "installed-native-runtime", version = null;
    if (role.runtime === "codex") {
      const { resolveCodexRuntimeLayout } = sourceModule(options.sourceRepo, "app/agent-service/codex-runtime-paths");
      const { CODEX_VERSION } = sourceModule(options.sourceRepo, "app/agent-service/codex-schema-contract");
      const pin = resolveCodexRuntimeLayout({ repoRoot: SOURCE_MAIN });
      const fixture = fs.readFileSync(path.join(SOURCE_MAIN, "scripts/codex-mcp-tool-call-native-fixture.cjs"), "utf8");
      const expected = /EXPECTED_BINARY_SHA\s*=\s*'([a-f0-9]{64})'/u.exec(fixture)?.[1];
      if (pin.version !== CODEX_VERSION || !expected || hashFile(pin.runtimePath) !== expected) throw fail("GROUP_LIVE_CODEX_SOURCE_BINARY_VERSION_MISMATCH");
      binaryPath = pin.runtimePath; origin = "main-vendor-pinned-binary-only"; version = pin.version;
      const bin = path.join(root, "bin"); fs.mkdirSync(bin, { mode: 0o700 }); fs.symlinkSync(binaryPath, path.join(bin, "codex"));
      parentEnv.PATH = bin + ":" + (process.env.PATH ?? "/usr/bin:/bin");
    } else runtimeOptions[optionNames[role.runtime]] = binaryPath;
    runtimeBinaries.push({ runtime: role.runtime, path: binaryPath, sha256: hashFile(binaryPath), origin, version });
  }
  const service = createAgentService({ paths, repoRoot: options.sourceRepo, version: source.packageVersion, parentEnv,
    runtimeStorageHomedir: os.homedir(), safeStorage: makeSafeStorage(key), prewarmMcpAuth: false, mcpHelperLaunch,
    runtimeMcpGateIssuer: new RuntimeMcpGateIssuer({ paths, mcpHelperLaunch, bootstrapPath }), ...runtimeOptions });
  options.ownedServiceConstructed = true;
  const codexSdkLayout = codexDefaults ? bindOwnedCodexSdkLayout({ service, sourceRepo: options.sourceRepo,
    selectedBinary: runtimeBinaries.find(row => row.runtime === "codex").path }) : null;
  const installedAntigravityVerifier = nativeRoles.some(role => role.runtime === "antigravity") ? await bindInstalledAntigravityVerifier({
    service, paths, installedPaths: resolveCanonicalServicePaths(), selectedBinary: runtimeBinaries.find(row => row.runtime === "antigravity").path,
    verifyServer: sourceModule(options.sourceRepo, "app/agent-service/antigravity-acp-distribution").verifyAntigravityAcpServer }) : null;
  const existingAntigravityAuthSelector = nativeRoles.some(role => role.runtime === "antigravity") ? prepareExistingAntigravityAuthSelector({
    paths, installedPaths: resolveCanonicalServicePaths(), accountId: DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME.antigravity, sourceRepo: options.sourceRepo }) : null;
  const startedAt = Date.now(), workerFiles = [__filename, ...["group-collaboration-live-matrix.cjs", "group-collaboration-live-external.cjs", "group-collaboration-hermes-runtime.cjs",
    "group-collaboration-live-policy.cjs", "codex-owned-permissions-fixture.cjs", "group-collaboration-codex-defaults.cjs", "group-collaboration-openclaw-policy.cjs", "group-collaboration-openclaw-auth.cjs", "group-collaboration-openclaw-auth-reader.cjs", "group-collaboration-live-cohort.cjs", "group-collaboration-live-codes.cjs"].map(name => path.join(__dirname,name))];
  const workerHashes = Object.fromEntries(workerFiles.map(file => [file, hashFile(file)]));
  const result = { reportVersion: 2, status: "failed", evidence: "fixed-synthetic-matrix-production-source-and-real-provider-transports",
    source, worker: { path: __filename, sha256: hashFile(__filename), files: workerHashes }, diagnosticCodeCatalogue: codeCatalogue.evidence,
    evaluation: { version: 1, sourceVersion: options.sourceVersion, caseId: options.case, groupId: options.group, round: options.round,
      descriptorPath: options.descriptor, descriptorSha256: evaluated.frozen.digest, thresholdsPath: options.thresholds,
      thresholdsSha256: evaluated.thresholds?.digest ?? null, partialCohort: evaluated.thresholds?.cohort ?? null, dataDigest: evaluated.dataDigest, roleDigest: evaluated.roleDigest, promptDigest: evaluated.promptDigest,
      runtimes: evaluated.roles.map(role => role.runtime), roles: evaluated.roles.map(role => ({ id: role.id, runtime: role.runtime, digest: sha(role.card) })) },
    capabilityBranch: capabilities ? "collaboration-v2" : "legacy-task-v1", runtimeBinaries, installedAntigravityVerifier, existingAntigravityAuthSelector,
    codexNativeDefaults: codexDefaults, codexSdkLayout, ...(codexDefaults ? { codexAuthority: { method: "unchanged-production-NativeCodexAuth-reader-and-owned-internal-managed-runtime",
      sourceRuntimeAccountId: DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME.codex, executionRuntimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
      authoritySemantics: "same-native-chatgpt-account-borrowed-in-memory;managed-account-identifies-execution-home-only", nativeReaderRpc: [], reads: [],
      accountIdentitySha256: null, credentialsExported: false } } : {}),
    isolation: { root, workspace: options.workspace, requestedWorkspace: layout.requestedWorkspace, requestedWorkspaceUsage: layout.requestedWorkspaceUsage, productProfilesGroupsSessionsAndServiceState: "disposable-only", originalProfilesGroupsAndRunsModified: false,
      nativeHomeUsesExistingAuthority: true, thirdPartyNativeHistoryBoundary: "Codex executes in a fresh managed Home with production borrowed native authority; its metadata-only native auth reader may refresh native auth. Other Source RuntimeAccount overlays reuse native auth homes. Product group/session/profile/ledger paths stay owned.",
      nativeReadOnlyBoundary: "Actual per-Runtime policy is recorded; OpenCode requires danger-full-access and DeepSeek requires writable sandbox, so no uniform native read-only assertion." },
    groupCalls: [], serviceStopped: false, providerCalls: null, overallMatrixComplete: false };
  options.executionResult = result;
  let profiles = [], external = null, groupId = null, undoCalls = null, undoRuntime = null, nativeProcesses = null, aborted = false;
  const interrupt = () => { aborted = true; };
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  const call = (method, params) => requestService(paths, { token: readClientToken(paths), version: PROTOCOL_VERSION, method, params }, { timeoutMs: 15000 });
  const stage = phase => { result.phase = phase; process.stdout.write("GROUP_LIVE_STAGE " + phase + "\n"); };
  try {
    options.ownedExecutionMayHaveStarted = true;
    await service.start(); stage("configure-owned-role-profiles");
    const base = service.productStore.listAgentProfiles()[0];
    profiles = nativeRoles.map(role => {
      const workspace = path.join(options.workspace, role.id); fs.mkdirSync(workspace, { mode: 0o700 });
      const saved = configureProfile(service, base, role.runtime, role.runtime === "codex" ? SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID : DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME[role.runtime], workspace, "Evaluation " + role.id,
        role.runtime === "codex" ? codexDefaults.config.model : null);
      const updated = service.productStore.putAgentProfile({ ...saved, permissionPolicy: matrix.permission(role.runtime, options.case) });
      const definitions = service.agentDefinitionStore.get(updated.id);
      service.agentDefinitionStore.update({ profileId: updated.id, expectedRevision: definitions.manifest.revision,
        documents: { IDENTITY: "# IDENTITY.md\n\n- 角色: " + role.id + "\n\n## 职责\n\n- " + role.card + "\n",
          SOUL: "# SOUL.md\n\n" + role.card + "\n" }, actor: "user", reason: "fixed-synthetic-evaluation-role" });
      return { ...updated, evaluationRoleId: role.id };
    });
    installOwnedNativeToolPolicies({ service, root, profiles, sourceRepo: options.sourceRepo, caseId: options.case, result, codexDefaults });
    nativeProcesses = observeOwnedNativeProcesses({ service, profiles, result });
    undoRuntime = matrix.observeRuntime(service, result);
    result.effectivePolicies = profiles.map(profile => ({ runtime: profile.runtime, role: profile.evaluationRoleId,
      policy: profile.permissionPolicy, profileDefaultCwd: profile.defaultCwd, workspace: profile.defaultCwd, nativeReadOnlyProven: null,
      proofStatus: "profile-declaration-only;actual-operation-request-and-response-evidence-recorded-separately" }));
    if (evaluated.roles.some(role => ["hermes", "openclaw"].includes(role.runtime))) {
      stage("start-owned-external-provider-bridge");
      external = await externalModule.begin({ root, sourceRepo: options.sourceRepo, paths, roles: evaluated.roles, workspace: options.workspace, hermesRuntimeRoot: options.hermesRuntimeRoot, caseId: options.case });
      result.external = external.evidence;
    }
    const members = evaluated.roles.map(role => {
      const native = profiles.find(profile => profile.evaluationRoleId === role.id);
      if (native) return { backendId: "shoggoth", agentId: native.agentId };
      const remote = external.members.find(member => member.roleId === role.id);
      if (!remote) throw fail("GROUP_LIVE_EXTERNAL_ROLE_MISSING");
      return { backendId: remote.backendId, agentId: remote.agentId, peerId: remote.peerId };
    });
    undoCalls = matrix.recordCalls(service, profiles, result.groupCalls, startedAt);
    stage("create-owned-evaluation-group");
    const created = await call("group.create", { operationId: "evaluation-group-create", name: "Evaluation " + options.case,
      purpose: "Frozen pure synthetic group collaboration evaluation", ...(capabilities ? { mode: "collaborative" } : {}), members });
    groupId = created.group.id; result.ownedGroupId = groupId;
    const mentions = evaluated.sample.requestKind === "all" ? created.members.map(member => member.id) : [];
    stage("submit-frozen-synthetic-request");
    const sent = await call("group.send", { groupId, clientMessageId: "evaluation-original-request", body: evaluated.body, mentions, replyTo: null, attachments: [], ...(capabilities ? { expectedPolicyVersion: created.group.policyVersion } : {}) });
    result.sourceMessageSeq = sent.message.seq; result.sourceMessageDigest = evaluated.promptDigest; result.ownedRequestId = sent.discussionId;
    stage("observe-real-provider-and-group-trajectory");
    await matrix.observe({ service, call, profiles, groupId, sent, evaluation: evaluated, workspace: options.workspace, result, startedAt, isAborted: () => aborted });
    stage("collected-trajectory-for-quality-review");
  } catch (error) { recordExecutionFailure(result,error); process.exitCode = 1; }
  finally {
    try { const observations = path.join(root, "helper-observations.jsonl"); result.helperInventoryEvidence = fs.existsSync(observations) ? fs.readFileSync(observations, "utf8").split("\n").filter(Boolean).map(JSON.parse) : []; } catch { result.helperInventoryUnavailable = true; }
    try { if (external?.observe) result.externalObservations = await external.observe({ groupId }); } catch { result.externalObservations = { availability: "unavailable" }; }
    result.nativeOwnedProcessSnapshot = nativeProcesses?.snapshot() ?? null;
    result.memberModelPairingEvidence = memberModelPairingEvidence(result, evaluated.roles, profiles);
    result.guardEnvironment = guardEnvironment(result, options.case);
    result.guardEnvironmentFingerprint = result.guardEnvironment?.sha256 ?? null;
    result.serviceStopped = null;
    try { observeFrozenSource(result, source); result.checkpointPath = writeEvidenceCheckpoint(options.output, result, matrix.safeEvidence); }
    catch (error) { result.checkpointUnavailable = true; const diagnostic=codeCatalogue.diagnosticCode(error); result.checkpointErrorCode=diagnostic.errorCode; if(diagnostic.errorCodeDigest)result.checkpointErrorCodeDigest=diagnostic.errorCodeDigest; if(diagnostic.errorCodeAvailability)result.checkpointErrorCodeAvailability=diagnostic.errorCodeAvailability; }
    stage("stop-owned-service");
    result.serviceStopEvidence = await boundedStop(() => service.stop({ notify: false }));
    result.nativeStopEvidence = nativeProcesses ? await nativeProcesses.finish() : null;
    result.serviceStopped = result.serviceStopEvidence.stopped && result.nativeStopEvidence?.stopped === true;
    if (!result.serviceStopped) { result.status = "failed"; result.cleanupErrorCodes = [...(result.cleanupErrorCodes ?? []), result.serviceStopEvidence.errorCode ?? "GROUP_LIVE_NATIVE_PROCESS_STOP_UNPROVEN"];
      result.errorCode ??= "GROUP_LIVE_OWNED_SERVICE_STOP_FAILED"; process.exitCode = 1; }
    try { if (external) { const stopped = await external.stop(); result.externalStopped = stopped.stopped; result.externalStopEvidence = stopped;
      if (!stopped.stopped) throw fail("GROUP_LIVE_OWNED_EXTERNAL_STOP_FAILED");
      if (stopped.hermesRuntimeArchiveUnchanged === false) throw fail("GROUP_LIVE_HERMES_ARCHIVE_CHANGED");
      if (stopped.runtimeBinariesUnchanged !== true) throw fail("GROUP_LIVE_EXTERNAL_RUNTIME_BINARY_CHANGED_OR_UNAVAILABLE"); } }
    catch (error) { result.externalStopped ??= false; result.status = "failed"; Object.assign(result, codeCatalogue.diagnosticCode(error)); process.exitCode = 1; }
    undoCalls?.(); undoRuntime?.(); key.fill(0); process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
    result.durationMs = Date.now() - startedAt;
    observeFrozenSource(result, source);
    result.workerUnchanged = workerFiles.every(file => hashFile(file) === workerHashes[file]);
    result.runtimeSdkSourceObservation = runtimeSdkObservation(result);
    result.runtimeSdkSourceUnchanged = result.runtimeSdkSourceObservation.unchanged;
    if (result.runtimeSdkSourceUnchanged === null) { result.status = "failed"; result.errorCode ??= "GROUP_LIVE_SDK_SOURCE_UNPROVEN"; result.comparisonEligibility = "confounded-sdk-source-observation-unavailable"; process.exitCode = 1; }
    result.runtimeBinaryUnchanged = runtimeBinaries.every(binary => hashFile(binary.path) === binary.sha256)
      && (!installedAntigravityVerifier || hashFile(installedAntigravityVerifier.harnessPath) === installedAntigravityVerifier.harnessSha256);
    result.descriptorUnchanged = hashFile(options.descriptor) === evaluated.frozen.digest;
    result.thresholdsUnchanged = !options.thresholds || hashFile(options.thresholds) === evaluated.thresholds.digest;
    finishCodexObservation(result, codexDefaults);
    if (!result.sourceUnchanged || !result.workerUnchanged || !result.runtimeBinaryUnchanged || result.runtimeSdkSourceUnchanged === false || !result.descriptorUnchanged || !result.thresholdsUnchanged) {
      result.status = "failed"; result.errorCode = "GROUP_LIVE_SOURCE_OR_EVALUATION_CHANGED"; process.exitCode = 1;
    }
    fs.writeFileSync(options.output, JSON.stringify(matrix.safeEvidence(result), null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }
  return result;
}
function memberModelPairingEvidence(result, roles, profiles) {
  const unique=values=>[...new Map(values.map(value=>[JSON.stringify(value),value])).values()];
  return roles.map(role=>{
    const profile=profiles.find(value=>value.evaluationRoleId===role.id), native=(profile&&result.runOutcomes?.filter(run=>run.profileId===profile.id))??[];
    if(profile) {
      const completed=native.filter(run=>run.status==="completed"), modelRows=completed.map(run=>result.effectiveModelEvidence?.find(row=>row.runId===run.id));
      const operations=(result.runtimeOperationEvidence??[]).filter(row=>row.runtimeProfileId===profile.runtimeProfileId);
      const requested=unique(operations.map(row=>({model:row.requested?.model??null,modelSettings:row.requested?.modelSettings??null,reasoningEffort:row.requested?.reasoningEffort??null,serviceTier:row.requested?.serviceTier??null})));
      const reported=unique(operations.map(row=>({model:row.session?.model??row.response?.model??null,provider:row.session?.modelProvider??row.session?.provider??row.response?.modelProvider??null,reasoningEffort:row.session?.reasoningEffort??row.response?.reasoningEffort??null,serviceTier:row.session?.serviceTier??row.response?.serviceTier??null})));
      return {roleId:role.id,runtime:role.runtime,completedRuns:completed.length,effectiveModels:[...new Set(modelRows.map(row=>row?.effectiveModel).filter(Boolean))].sort(),actualCompletedModelProof:completed.length>0&&modelRows.every(row=>Boolean(row?.effectiveModel)),requestedParameters:requested,runtimeReportedParameters:reported,parameterProof:"observed-native-request-and-response-fields;unreported-provider-defaults-remain-unknown"};
    }
    const observation=result.externalObservations?.members?.find(row=>row.backendId===role.runtime)??result.externalObservations?.find?.(row=>row.backendId===role.runtime);
    const sessions=observation?.sessions??[], bindings=sessions.flatMap(session=>session.history?.bindings??[]), completed=bindings.filter(binding=>sessions.some(session=>session.executions?.some(execution=>execution.runId===binding.runId&&execution.status==="completed")));
    const models=result.external?.models?.find(row=>row.backendId===role.runtime);
    return {roleId:role.id,runtime:role.runtime,completedRuns:completed.length,effectiveModels:[...new Set(completed.map(row=>row.effectiveModel).filter(Boolean))].sort(),actualCompletedModelProof:completed.length>0&&completed.every(row=>Boolean(row.effectiveModel)),configuredModel:models?.model??null,configuredProvider:models?.provider??null,configuredParameters:models?.parameters??null,sessionCumulativeModels:[...new Set(sessions.map(row=>row.model).filter(Boolean))].sort(),runtimeReportedParameters:unique(sessions.map(row=>row.rawRuntimeSession?.modelConfig??null)),parameterProof:"completed-bound-assistant-message-model-only;session-cumulative-and-selected-config-are-separate;missing-fields-remain-unknown"};
  });
}
function guardEnvironment(result, caseId) {
  // Deliberately exclude only the declared 3-to-4 product group protocol treatment.
  // Paths are normalized to owned roles; actual permissions and SDK generations remain.
  try {
    const roots=[{root:result.isolation?.workspace,label:"<OWNED-WORKSPACES>"},{root:result.isolation?.root,label:"<OWNED-SERVICE>"}].filter(row=>row.root).sort((a,b)=>b.root.length-a.root.length), native=result.toolEnvironment?.runtimes??[], external=result.external;
    const normalize=value=>typeof value==="string" ? roots.reduce((text,row)=>text.replaceAll(row.root,row.label),value)
      : Array.isArray(value)?value.map(normalize):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[normalize(key),normalize(item)])):value;
    const policies=[];
    for(const row of native) {
      if(row.runtime==="codex") {
        if(!row.actualRuntimeVerified || !row.afterFeatureInventories?.length) return null;
        const config={...row.config};delete config["mcp_servers.shoggoth.enabled_tools"];
        const features=[...new Map(row.afterFeatureInventories.map(value=>{const list=[...value.features].sort((a,b)=>a.name.localeCompare(b.name));return[JSON.stringify(list),list];})).values()];
        policies.push({runtime:row.runtime,method:row.method,config,features,disabledInheritedMcpNames:row.disabledInheritedMcpNames});
      } else if(row.runtime==="deepseek-harness") {
        if(!row.launches?.length || row.launches.some(launch=>!launch.contextComposition?.files?.every(file=>file.matchesInstalledTemplate))) return null;
        const policy=JSON.parse(fs.readFileSync(row.policyFile,"utf8"));delete policy.groupTools;delete policy.logPath;
        const compositions=[...new Map(row.launches.map(launch=>{const value={profile:launch.contextComposition.profile,homePatchPresent:launch.contextComposition.homePatchPresent,publicTemplateSourceSha256:launch.contextComposition.publicTemplateSourceSha256,files:launch.contextComposition.files,sdkFiles:launch.contextComposition.sdkFiles?.map(file=>({module:file.module,sha256:file.sha256}))??null};return[JSON.stringify(value),value];})).values()];
        policies.push({runtime:row.runtime,method:row.method,policy,compositions});
      } else return null;
    }
    for(const [runtime,row] of Object.entries(external?.toolPolicies??{})) {
      const policy=JSON.parse(fs.readFileSync(row.policyFile,"utf8"));delete policy.groupTools;delete policy.logPath;
      const actual=external.runtimeBinaryEvidence?.find(value=>value.runtime===runtime);
      if(!actual || runtime==="openclaw" && !actual.guardAttestation?.registryContainsAcceptedPolicy) return null;
      policies.push({runtime,method:row.method,policy,registryAttested:runtime==="openclaw"?true:null,contextPolicy:external.contextPolicies?.[runtime]??null});
    }
    if(!policies.length || new Set(result.evaluation?.runtimes??[]).size !== new Set(policies.map(row=>row.runtime)).size) return null;
    const moduleHashes=Object.fromEntries(["group-collaboration-live-policy.cjs","codex-owned-permissions-fixture.cjs","group-collaboration-codex-defaults.cjs","group-collaboration-openclaw-policy.cjs","group-collaboration-openclaw-auth.cjs","group-collaboration-openclaw-auth-reader.cjs", "group-collaboration-live-codes.cjs"].map(name=>[name,hashFile(path.join(__dirname,name))]));
    const installations=[...(result.runtimeBinaries??[]).map(row=>({runtime:row.runtime,sha256:row.sha256,version:row.version??null})),...(external?.runtimeBinaryEvidence??[]).map(row=>({runtime:row.runtime,sha256:row.sha256,archiveDigest:row.archive?.archiveDigest??null,entrySha256:row.entrySha256??null,interpreterSha256:row.interpreterSha256??null,sdkFiles:row.sdkFiles?.map(file=>({relative:file.relative,sha256:file.sha256}))??null}))];
    const codex=result.codexNativeDefaults?{sourceConfigSha256:result.codexNativeDefaults.sourceConfigSha256,projection:result.codexNativeDefaults.projection,
      publicProviderDefaultSourceSha256:result.codexNativeDefaults.providerDefaultProof.sha256,pinnedVersion:result.codexNativeDefaults.sdkVersion,
      publicCodeModeHostSha256:result.codexSdkLayout?.hostSha256,publicPackageMetadataSha256:result.codexSdkLayout?.packageMetadataSha256,
      originalHomeConfigReadSucceeded:false,providerProof:result.codexNativeDefaults.providerProof,
      sourceRuntimeAccountId:result.codexAuthority?.sourceRuntimeAccountId,executionRuntimeAccountId:result.codexAuthority?.executionRuntimeAccountId,
      authoritySemantics:result.codexAuthority?.authoritySemantics,accountIdentitySha256:result.codexAuthority?.accountIdentitySha256}:null;
    if(codex&&!codex.accountIdentitySha256)return null;
    const openclawModel=external?.models?.find(row=>row.backendId==="openclaw"),auth=openclawModel?.authAuthority,kernel=auth?.kernelReader;
    let openclawAuthority=null;
    if(openclawModel) {
      const sdkNames=["dist/store-runtime-j0iCH_e-.mjs","dist/store-BVWJOVBa.mjs","dist/order-BsYOMdUo.mjs","dist/sqlite-json-B-NT4SVB.mjs","dist/gateway-state-owner-YpBfU4aL.mjs","dist/paths-CtO6iw0c.mjs","dist/openclaw-state-db.paths-rJI64Ab5.mjs","dist/pid-alive-BYw_9KTp.mjs","dist/stale-lock-file-WwPWbFq9.mjs"];
      const expectedReadCapability={authSqliteFiles:2,authWalShmExactLiterals:4,lifecycleOwnerSidecarExactLiterals:2,sourceDirectoryDataRead:false};
      if(!kernel || auth.method!=="installed-SDK-readOnly-runtime-store-and-readOnly-auth-order;only-selected-api-key-in-owned-provider-config"
        || kernel.method!=="deny-default-seatbelt-original-auth-sqlite-read-only-no-original-write-no-network-no-fork-no-keychain;anonymous-FD3-only-selected-key"
        || kernel.credentialChannel!=="private-anonymous-FD3;no-stdout-stderr-env-file" || kernel.sourceOriginalWriteAllowed!==false || kernel.networkAllowed!==false || kernel.keychainAllowed!==false || kernel.forkAllowed!==false
        || kernel.ownedCodeByteEquality!==true || kernel.helperSourceSha256!==hashFile(path.join(__dirname,"group-collaboration-openclaw-auth.cjs")) || kernel.readerSourceSha256!==hashFile(path.join(__dirname,"group-collaboration-openclaw-auth-reader.cjs"))
        || JSON.stringify(normalize(kernel.readCapabilitySummary))!==JSON.stringify(normalize(expectedReadCapability))
        || !/^[a-f0-9]{64}$/u.test(kernel.sourceConfigSha256??"") || !Array.isArray(auth.sdkFiles) || auth.sdkFiles.length!==sdkNames.length
        || JSON.stringify(auth.sdkFiles.map(file=>file.relative))!==JSON.stringify(sdkNames)
        || auth.sdkFiles.some(file=>{const actual=path.join("/opt/homebrew/lib/node_modules/openclaw",file.relative),st=fs.lstatSync(actual);return !st.isFile()||st.isSymbolicLink()||!Number.isSafeInteger(file.bytes)||file.bytes!==st.size||hashFile(actual)!==file.sha256;})
        || hashFile(kernel.policyFile)!==kernel.policySha256)return null;
      openclawAuthority={provider:auth.provider,model:auth.model,profileIdDigest:auth.profileIdDigest,credentialType:auth.credentialType,
        sourceConfigSha256:kernel.sourceConfigSha256,sdkFiles:auth.sdkFiles.map(file=>({relative:file.relative,sha256:file.sha256})).sort((a,b)=>a.relative.localeCompare(b.relative)),
        kernel:{method:kernel.method,credentialChannel:kernel.credentialChannel,sourceOriginalWriteAllowed:kernel.sourceOriginalWriteAllowed,
          networkAllowed:kernel.networkAllowed,keychainAllowed:kernel.keychainAllowed,forkAllowed:kernel.forkAllowed,readCapabilitySummary:kernel.readCapabilitySummary,helperSourceSha256:kernel.helperSourceSha256,readerSourceSha256:kernel.readerSourceSha256}};
    }
    const scope=normalize({version:1,caseId,policies:policies.sort((a,b)=>a.runtime.localeCompare(b.runtime)),moduleHashes,installations:installations.sort((a,b)=>a.runtime.localeCompare(b.runtime)),codex,openclawAuthority,
      hermesMemory:external?.models?.some(row=>row.backendId==="hermes")?{memory_enabled:false,user_profile_enabled:false}:null,protocolTreatmentExcluded:"product-group-tools-3-versus-4-only"});
    return {version:1,sha256:sha(JSON.stringify(scope)),scope,coverage:"actual-launched-runtime-guard-config-and-install-generation;fixed-zero-provider-reports-reviewed-separately;not-model-parameter-or-pure-scheduling-proof"};
  } catch { return null; }
}
async function execute(options) { return options.matrix ? executeMatrix(options) : executeSmoke(options); }

async function main(args = process.argv.slice(2)) {
  const options = parse(args);
  let result;
  try { result = await execute(options); }
  catch (error) {
    let source = options.executionResult?.source;
    if (!source) { try { source = metadata(options.sourceRepo); } catch { source = { repo: options.sourceRepo, gitSha: null, sourceDigest: null, unavailable: true }; } }
    result = { ...(options.executionResult ?? {}), reportVersion: options.executionResult?.reportVersion ?? 1,
      status: options.ownedExecutionMayHaveStarted ? "failed" : "blocked", ...codeCatalogue.diagnosticCode(error),
      phase: options.executionResult ? "owned-evidence-finalization-failed" : options.ownedExecutionMayHaveStarted ? "owned-execution-failed" : "before-owned-service-start",
      runtime: options.runtime, source, worker: options.executionResult?.worker ?? { path: __filename, sha256: hashFile(__filename) },
      capabilityBranch: options.executionResult?.capabilityBranch ?? null, groupCalls: options.executionResult?.groupCalls ?? [],
      serviceStopped: options.executionResult?.serviceStopped ?? (options.ownedServiceConstructed ? null : true),
      providerCalls: options.executionResult?.providerCalls ?? (options.ownedExecutionMayHaveStarted ? null : 0), overallMatrixComplete: false };
    if (!fs.existsSync(options.output)) fs.writeFileSync(options.output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    process.exitCode = 1;
  }
  process.stdout.write(JSON.stringify({ status: result.status, runtime: result.runtime, sourceRepo: result.source.repo,
    sourceGitSha: result.source.gitSha, sourceDigest: result.source.sourceDigest, capabilityBranch: result.capabilityBranch,
    actualGroupCalls: result.groupCalls.length, errorCode: result.errorCode ?? null, serviceStopped: result.serviceStopped,
    output: options.output, overallMatrixComplete: false }) + "\n");
  return result;
}
if (require.main === module) main().catch(error => { process.stderr.write(JSON.stringify({ status: "failed", ...codeCatalogue.diagnosticCode(error) }) + "\n"); process.exitCode = 1; });
module.exports = { parse, metadata, sourcePrompt, writeHelper, makeSafeStorage, configureProfile, execute, executeSmoke, executeMatrix, main, SOURCE_FACT, bindInstalledAntigravityVerifier, bindOwnedCodexSdkLayout, finishCodexObservation, prepareExistingAntigravityAuthSelector, observeFrozenSource, writeEvidenceCheckpoint, boundedStop, terminalChainMissing, installOwnedNativeToolPolicies, observeOwnedNativeProcesses, collectOwnedCodexFeatures, collectOwnedCodexMcpInventory, guardEnvironment, memberModelPairingEvidence, matrixOwnedLayout, codeOf, recordExecutionFailure, deepSeekVersionProbe, runtimeSdkObservation };
