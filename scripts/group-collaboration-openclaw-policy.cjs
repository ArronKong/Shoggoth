"use strict";
// Test-only policy loaded by the official, unchanged OpenClaw plugin loader.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = code => Object.assign(new Error(code), { code });
const PLUGIN_ID = "synthetic-owned-workspace", POLICY_ID = "fixed-workspace";
const SDK_REGISTRY = "/opt/homebrew/lib/node_modules/openclaw/dist/plugins/hook-runner-global.js";
const plain = value => value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function checkRoot(root) {
  const stat = fs.lstatSync(root);
  if (!path.isAbsolute(root) || !root.startsWith("/private/tmp/sggroup-") || fs.realpathSync(root) !== root
    || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw fail("GROUP_LIVE_OPENCLAW_POLICY_ROOT_UNSAFE");
  return root;
}
function fileBytes(file, mode = 0o400) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid()
    || !(Array.isArray(mode) ? mode : [mode]).includes(before.mode & 0o777) || before.size > 64 * 1024) throw fail("GROUP_LIVE_OPENCLAW_POLICY_FILE_UNSAFE");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size || bytes.length !== opened.size
      || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) throw fail("GROUP_LIVE_OPENCLAW_POLICY_FILE_CHANGED");
    return bytes;
  } finally { fs.closeSync(fd); }
}
function load(file, expectedDigest) {
  const bytes = fileBytes(file);
  if (sha(bytes) !== expectedDigest) throw fail("GROUP_LIVE_OPENCLAW_POLICY_CHANGED");
  const policy = JSON.parse(bytes);
  if (policy.version !== 1 || policy.agentId !== "main" || !Array.isArray(policy.readRoots) || !policy.readRoots.length
    || !Array.isArray(policy.groupTools) || policy.groupTools.length < 3 || policy.groupTools.length > 4
    || policy.groupTools.some(name => !/^group_(?:messages_read|member_role_read|task|collaborate)$/u.test(name)))
    throw fail("GROUP_LIVE_OPENCLAW_POLICY_INVALID");
  checkRoot(policy.root); checkRoot(policy.workspace); policy.readRoots.forEach(checkRoot);
  if (!policy.workspace.startsWith(policy.root + "/") || policy.readRoots.some(root => !root.startsWith(policy.root + "/"))
    || policy.logPath !== file + ".decisions.jsonl" || policy.attestationPath !== file + ".loaded.json")
    throw fail("GROUP_LIVE_OPENCLAW_POLICY_SCOPE_INVALID");
  return policy;
}
function ownedFile(value, root, missing) {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\0\\]/u.test(value)
    || value.startsWith("~") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) || value.split("/").includes("..")) return null;
  const target = path.resolve(root, value);
  if (target === root || !target.startsWith(root + path.sep)) return null;
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || stat.uid !== process.getuid() || !stat.isDirectory() && !stat.isFile()) return null;
      if (current !== target && !stat.isDirectory()) return null;
    } catch (error) { if (error.code !== "ENOENT" || !missing) return null; }
  }
  return target;
}
function decision(policy, event, ctx) {
  if (!plain(event) || !plain(event.params) || !plain(ctx) || ctx.agentId !== policy.agentId
    || typeof ctx.sessionId !== "string" || !ctx.sessionId || typeof ctx.runId !== "string" || !ctx.runId
    || typeof ctx.toolCallId !== "string" || !ctx.toolCallId || event.toolCallId !== ctx.toolCallId || event.runId !== ctx.runId)
    return { block: true, blockReason: "GROUP_LIVE_OPENCLAW_TOOL_CONTEXT_UNBOUND" };
  const name = event.toolName;
  if (policy.groupTools.some(tool => name === "shoggoth-group__" + tool)) return {};
  const schemas = {
    read: { keys: ["path", "file_path", "offset", "limit"], write: false },
    write: { keys: ["path", "file_path", "content"], write: true },
    edit: { keys: ["path", "file_path", "oldText", "newText", "old_string", "new_string"], write: true },
  };
  const schema = schemas[name], args = event.params;
  if (!schema || Object.keys(args).some(key => !schema.keys.includes(key))
    || schema.write && policy.caseId !== "implementation-review"
    || !schema.write && !["implementation-review", "approval-wait"].includes(policy.caseId))
    return { block: true, blockReason: "GROUP_LIVE_OPENCLAW_TOOL_OUTSIDE_FIXED_SCOPE" };
  if (args.path !== undefined && args.file_path !== undefined && args.path !== args.file_path)
    return { block: true, blockReason: "GROUP_LIVE_OPENCLAW_FILE_PATH_AMBIGUOUS" };
  const value = args.path ?? args.file_path;
  // Relative paths have one authoritative meaning. Rewriting to the checked
  // absolute path prevents a different native command cwd from widening it.
  const roots = schema.write ? [policy.workspace] : policy.readRoots;
  const target = roots.map(root => ownedFile(value, root, schema.write)).find(Boolean);
  if (!target) return { block: true, blockReason: "GROUP_LIVE_OPENCLAW_FILE_OUTSIDE_OWNED_WORKSPACE" };
  if (schema.write && target !== path.join(policy.workspace, "sum-valid.cjs"))
    return { block: true, blockReason: "GROUP_LIVE_OPENCLAW_FILE_NOT_FIXED_ARTIFACT" };
  return { params: { ...args, path: target, ...(args.file_path !== undefined ? { file_path: target } : {}) } };
}
function append(policy, event, ctx, result) {
  const row = { at: Date.now(), pid: process.pid, toolName: event?.toolName ?? null, agentId: ctx?.agentId ?? null,
    runId: ctx?.runId ?? null, sessionId: ctx?.sessionId ?? null, toolCallId: ctx?.toolCallId ?? null,
    decision: result.block ? "blocked" : "allowed", reason: result.blockReason ?? null, argumentsDigest: sha(JSON.stringify(event?.params ?? null)) };
  const fd = fs.openSync(policy.logPath, fs.constants.O_APPEND | fs.constants.O_WRONLY | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw fail("GROUP_LIVE_OPENCLAW_POLICY_LOG_UNSAFE");
    fs.writeFileSync(fd, JSON.stringify(row) + "\n");
  } finally { fs.closeSync(fd); }
}
function evaluate(file, digest, event, ctx) {
  try { const policy = load(file, digest), result = decision(policy, event, ctx); append(policy, event, ctx, result); return result; }
  catch { return { block: true, blockReason: "GROUP_LIVE_OPENCLAW_POLICY_UNAVAILABLE" }; }
}
function register(api, file, digest) {
  const policy = load(file, digest), declared = api.config?.agents?.list?.find(agent => agent.id === policy.agentId),
    normalized = api.config?.agents?.entries?.[policy.agentId], selected = normalized ?? declared,
    effectiveWorkspace = selected?.workspace ?? api.config?.agents?.defaults?.workspace;
  // The official Gateway normalizes legacy list entries into agents.entries.
  // Both forms must resolve to this same explicitly-owned role workspace.
  if (!plain(selected) || effectiveWorkspace !== policy.workspace
    || declared?.workspace && declared.workspace !== policy.workspace
    || api.config?.agents?.defaults?.workspace !== policy.workspace
    || typeof api.registerTrustedToolPolicy !== "function") {
    // Bounded metadata only; never serialize the Gateway config or auth.
    const observed = value => typeof value === "string" && value.startsWith(policy.root + "/") ? value : value === undefined ? null : { sha256: sha(String(value)) };
    fs.writeFileSync(file + ".registration-diagnostic.json", JSON.stringify({ version: 1, pid: process.pid,
      apiConfigKeys: Object.keys(api.config ?? {}), agentsKeys: Object.keys(api.config?.agents ?? {}),
      selectedWorkspace: observed(selected?.workspace), effectiveWorkspace: observed(effectiveWorkspace),
      defaultWorkspace: observed(api.config?.agents?.defaults?.workspace),
      expectedWorkspace: policy.workspace, hasTrustedPolicyApi: typeof api.registerTrustedToolPolicy === "function" }) + "\n", { flag: "wx", mode: 0o600 });
    throw fail("GROUP_LIVE_OPENCLAW_POLICY_HOST_SCOPE_INVALID");
  }
  api.registerTrustedToolPolicy({ id: POLICY_ID, description: "Restrict this isolated synthetic group evaluation to its fixed artifacts and group tools.",
    evaluate: (event, ctx) => evaluate(file, digest, event, ctx) });
  // Registration may report an error without throwing. Publish readiness only
  // after the official registry actually contains this accepted policy.
  api.on("gateway_start", () => attestRegistration(file, digest));
}
async function attestRegistration(file, digest) {
  const policy = load(file, digest);
  if (sha(fs.readFileSync(SDK_REGISTRY)) !== policy.sdkRegistrySha256) throw fail("GROUP_LIVE_OPENCLAW_SDK_REGISTRY_CHANGED");
  const sdk = await import(require("node:url").pathToFileURL(SDK_REGISTRY).href), registry = sdk.getGlobalPluginRegistry();
  const entries = (registry?.trustedToolPolicies ?? []).filter(row => row.pluginId === PLUGIN_ID && row.policy?.id === POLICY_ID);
  if (entries.length !== 1 || typeof entries[0].policy.evaluate !== "function") throw fail("GROUP_LIVE_OPENCLAW_POLICY_REGISTRATION_UNPROVEN");
  const data = { version: 1, pid: process.pid, policySha256: digest, registryContainsAcceptedPolicy: true,
    policyId: POLICY_ID, pluginId: PLUGIN_ID, workspace: policy.workspace, mechanism: "official-explicitly-enabled-declared-trusted-tool-policy" };
  if (fs.existsSync(policy.attestationPath)) {
    const previous = JSON.parse(fileBytes(policy.attestationPath, 0o600));
    if (JSON.stringify(previous) !== JSON.stringify(data)) throw fail("GROUP_LIVE_OPENCLAW_POLICY_ATTESTATION_CONFLICT");
  } else fs.writeFileSync(policy.attestationPath, JSON.stringify(data) + "\n", { mode: 0o600, flag: "wx" });
  return data;
}
function prepareGuard({ root, workspace, readRoots, caseId, groupTools }) {
  checkRoot(root); checkRoot(workspace); readRoots.forEach(checkRoot);
  const directory = path.join(root, "policy/openclaw-guard"); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "policy.json"), policy = { version: 1, root, workspace, readRoots, caseId,
    groupTools, agentId: "main", sdkRegistrySha256: sha(fs.readFileSync(SDK_REGISTRY)), logPath: file + ".decisions.jsonl", attestationPath: file + ".loaded.json" };
  const bytes = JSON.stringify(policy) + "\n", digest = sha(bytes);
  fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o400 }); load(file, digest);
  const plugin = path.join(directory, "index.cjs"), manifest = path.join(directory, "openclaw.plugin.json"), packageFile = path.join(directory, "package.json");
  const source = '"use strict";const policy=require(' + JSON.stringify(__filename) + ');module.exports={id:' + JSON.stringify(PLUGIN_ID)
    + ',name:"Synthetic owned workspace",register(api){policy.register(api,' + JSON.stringify(file) + ',' + JSON.stringify(digest) + ');}};\n';
  const manifestBytes = JSON.stringify({ id: PLUGIN_ID, name: "Synthetic owned workspace", version: "1.0.0",
    contracts: { trustedToolPolicies: [POLICY_ID] }, configSchema: { type: "object", additionalProperties: false, properties: {} } }) + "\n";
  const packageBytes = JSON.stringify({ name: PLUGIN_ID, version: "1.0.0", type: "commonjs", openclaw: { extensions: ["./index.cjs"] } }) + "\n";
  for (const [destination, data] of [[plugin, source], [manifest, manifestBytes], [packageFile, packageBytes]])
    fs.writeFileSync(destination, data, { flag: "wx", mode: 0o400 });
  return { configOverlay: { plugins: { enabled: true, allow: [PLUGIN_ID], load: { paths: [directory] }, entries: { [PLUGIN_ID]: { enabled: true } } },
    tools: { toolSearch: false, fs: { workspaceOnly: true } } },
    policyEvidence: { method: "official-declared-trusted-tool-policy-before-real-tool-body", policyFile: file, policySha256: digest,
      module: __filename, moduleSha256: sha(fs.readFileSync(__filename)), plugin, pluginSha256: sha(source), manifest, manifestSha256: sha(manifestBytes),
      packageFile, packageSha256: sha(packageBytes), workspace, attestationPath: policy.attestationPath }, policy };
}
function verifyGuard(evidence, gatewayPid) {
  if (sha(fileBytes(evidence.module, [0o400, 0o644])) !== evidence.moduleSha256) throw fail("GROUP_LIVE_OPENCLAW_POLICY_MODULE_CHANGED");
  for (const [file, digest] of [[evidence.plugin, evidence.pluginSha256], [evidence.manifest, evidence.manifestSha256], [evidence.packageFile, evidence.packageSha256]])
    if (sha(fileBytes(file)) !== digest) throw fail("GROUP_LIVE_OPENCLAW_POLICY_PLUGIN_CHANGED");
  const policy = load(evidence.policyFile, evidence.policySha256), attestation = JSON.parse(fileBytes(policy.attestationPath, 0o600));
  if (attestation.pid !== gatewayPid || attestation.policySha256 !== evidence.policySha256 || attestation.workspace !== policy.workspace
    || attestation.policyId !== POLICY_ID || attestation.pluginId !== PLUGIN_ID || attestation.registryContainsAcceptedPolicy !== true)
    throw fail("GROUP_LIVE_OPENCLAW_POLICY_REGISTRATION_UNPROVEN");
  return attestation;
}
module.exports = { PLUGIN_ID, POLICY_ID, prepareGuard, verifyGuard, evaluate, register, attestRegistration, decision, ownedFile };
