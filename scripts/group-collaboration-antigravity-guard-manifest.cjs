"use strict";

const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const guard = require("./group-collaboration-antigravity-guard.cjs");
const GROUP_TOOLS = ["group_member_role_read", "group_messages_read", "group_task", "group_collaborate"];
const SESSION_RECEIPTS = new WeakMap();
function directory(file, root) {
  if (!path.isAbsolute(file) || path.normalize(file) !== file || !guard.within(file, root)) throw guard.failure("AGY_GUARD_MANIFEST_SCOPE_UNSAFE");
  let current = root;
  for (const part of path.relative(root, file).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { const stat = fs.lstatSync(current); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw guard.failure("AGY_GUARD_PATH_LINK_OR_OWNER"); }
    catch (error) { if (error.code !== "ENOENT") throw error; fs.mkdirSync(current, { mode: 0o700 }); }
  }
  guard.noLinks(file, root); return file;
}
function immutable(file, bytes) { const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, 0o400); } finally { fs.closeSync(fd); }
  const fact = guard.readStable(file, { root: path.dirname(file), mode: 0o400 }); return { path: file, sha256: fact.sha256, identity: fact.identity }; }
function schemasFromCapturedSdkRequest({ file, sha256, root }) {
  const fact = guard.readStable(file, { root, expectedSha256: sha256, maxBytes: 16 * 1024 * 1024 });
  const body = guard.parseStrictJson(fact.bytes.toString("utf8"), { maxBytes: 16 * 1024 * 1024 });
  const request = guard.plain(body.request) ? body.request : body;
  if (!Array.isArray(request.tools)) throw guard.failure("AGY_GUARD_CAPTURE_SCHEMA_UNSUPPORTED");
  const found = {};
  for (const container of request.tools) {
    if (!guard.plain(container)) throw guard.failure("AGY_GUARD_CAPTURE_SCHEMA_UNSUPPORTED");
    const fields = ["functionDeclarations", "function_declarations"].filter(key => Object.hasOwn(container, key));
    if (fields.length !== 1 || !Array.isArray(container[fields[0]])) throw guard.failure("AGY_GUARD_CAPTURE_SCHEMA_UNSUPPORTED");
    for (const declaration of container[fields[0]]) {
      if (!guard.plain(declaration) || !guard.text(declaration.name, 128)) throw guard.failure("AGY_GUARD_CAPTURE_SCHEMA_UNSUPPORTED");
      if (!["create_file", "edit_file", "run_command"].includes(declaration.name)) continue;
      if (Object.hasOwn(found, declaration.name)) throw guard.failure("AGY_GUARD_CAPTURE_SCHEMA_DUPLICATE");
      const parameters = ["parameters", "parametersJsonSchema", "parameters_json_schema"].filter(key => Object.hasOwn(declaration, key));
      if (parameters.length !== 1 || !guard.plain(declaration[parameters[0]])) throw guard.failure("AGY_GUARD_CAPTURE_SCHEMA_UNSUPPORTED");
      found[declaration.name] = { authority: "captured-request-bytes;actual-SDK-ingress-origin-and-body-proof-must-be-verified-separately",
        capturedRequestPath: file, capturedRequestSha256: sha256, parameters: declaration[parameters[0]] };
    }
  }
  if (!Object.keys(found).length) throw guard.failure("AGY_GUARD_CAPTURE_SCHEMA_MISSING");
  return found;
}
function prepareAntigravityGuard(options) {
  const root = fs.realpathSync(options.root), workspace = fs.realpathSync(options.workspace), sdkHome = fs.realpathSync(options.sdkHome), geminiHome = fs.realpathSync(options.geminiHome);
  if (!root.startsWith("/private/tmp/sggroup-") || ![workspace, sdkHome, geminiHome].every(file => guard.within(file, root))
    || guard.within(sdkHome, workspace) || guard.within(geminiHome, workspace)) throw guard.failure("AGY_GUARD_MANIFEST_SCOPE_UNSAFE");
  const readRoots = (options.readRoots || [workspace]).map(file => fs.realpathSync(file));
  if (readRoots.some(file => !guard.within(file, root) || guard.within(sdkHome, file) || guard.within(geminiHome, file))) throw guard.failure("AGY_GUARD_MANIFEST_READ_SCOPE_UNSAFE");
  for (const file of [root, workspace, sdkHome, geminiHome, ...readRoots]) guard.noLinks(file, root);
  if (!guard.text(options.caseId, 128) || !guard.text(options.roleId, 128)) throw guard.failure("AGY_GUARD_BINDING_INVALID");
  const directoryPath = directory(path.join(root, "agy-pre-tool-policy"), root), guardHome = directory(path.join(directoryPath, "guard-home"), root), guardTmp = directory(path.join(directoryPath, "guard-tmp"), root);
  const sdkTmp = directory(options.sdkTmp || path.join(sdkHome, "tmp"), root);
  const appDataDir = directory(options.appDataDir || guard.officialAppDataDir(geminiHome), root);
  if (appDataDir !== guard.officialAppDataDir(geminiHome)) throw guard.failure("AGY_GUARD_OFFICIAL_METADATA_UNBOUND");
  if ([workspace, ...readRoots].some(candidate => [directoryPath, sdkHome, geminiHome, appDataDir]
    .some(control => guard.within(candidate, control) || guard.within(control, candidate)))) throw guard.failure("AGY_GUARD_MANIFEST_READ_SCOPE_UNSAFE");
  const manifestPath = path.join(directoryPath, "manifest.json"), guardPath = path.join(directoryPath, "guard.cjs");
  const sourceRoot = fs.realpathSync(options.repoSource || path.join(__dirname, "..")), protectedFiles = [];
  for (const [source, name] of [[__dirname + "/group-collaboration-antigravity-guard.cjs", "guard.cjs"], [__dirname + "/group-collaboration-live-policy.cjs", "live-policy.cjs"],
    [path.join(sourceRoot, "app/agent-service/group-mcp-tools.js"), "group-mcp-tools.js"], [path.join(sourceRoot, "app/agent-service/group-tool-grant.js"), "group-tool-grant.js"]]) {
    protectedFiles.push(immutable(path.join(directoryPath, name), fs.readFileSync(source)));
  }
  const binding = options.binding;
  if (!guard.plain(binding) || !["sessionId", "runtimeProfileId", "runtimeAccountId", "runId", "requestId"].every(key => guard.text(binding[key], 512))
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(binding.sessionId)) throw guard.failure("AGY_GUARD_BINDING_INVALID");
  const groupTools = options.groupTools || GROUP_TOOLS;
  if (![3, 4].includes(groupTools.length) || new Set(groupTools).size !== groupTools.length || groupTools.some(tool => !GROUP_TOOLS.includes(tool))) throw guard.failure("AGY_GUARD_GROUP_TOOLS_INVALID");
  const cachedSchemas = (options.cachedSchemas || []).map(({ toolName, file, sha256 }) => {
    const expected = path.join(appDataDir, "brain", binding.sessionId, "mcp", "shoggoth", toolName + ".json");
    if (!groupTools.includes(toolName) || file !== expected || !/^[a-f0-9]{64}$/u.test(sha256 || "")) throw guard.failure("AGY_GUARD_CACHED_SCHEMA_UNBOUND");
    const fact = guard.readStable(file, { root, expectedSha256: sha256, maxBytes: guard.MAX_INPUT || 64 * 1024 });
    return { toolName, path: file, sha256, identity: fact.identity };
  });
  const hooksConfigPath = path.join(directory(path.join(geminiHome, "config"), root), "hooks.json");
  const manifest = { version: 1, runtime: "antigravity", root, caseId: options.caseId, roleId: options.roleId, binding,
    nonce: options.nonce || crypto.randomBytes(32).toString("hex"), workspace, readRoots, workspacePaths: guard.officialWorkspacePaths(geminiHome, workspace),
    artifactPath: path.join(workspace, "sum-valid.cjs"), sdkHome, geminiHome, sdkTmp, guardHome, guardTmp, appDataDir,
    transcriptPath: guard.officialTranscript(geminiHome, binding.sessionId), artifactDirectoryPath: guard.officialArtifactDirectory(geminiHome),
    nodePath: fs.realpathSync(process.execPath), guardPath, hooksConfigPath, decisionLogPath: path.join(directoryPath, "decisions.jsonl"), sharedPolicyPath: path.join(directoryPath, "live-policy.cjs"),
    groupValidatorPath: path.join(directoryPath, "group-mcp-tools.js"), groupTools,
    groupSources: options.groupSources || [{ source: "chat", sourceId: binding.runId }], groupTokenDigests: options.groupTokenDigests || [], cachedSchemas,
    parentEnvironment: options.parentEnvironment || { PATH: "/usr/bin:/bin", HOME: sdkHome, GEMINI_HOME: geminiHome, TMPDIR: sdkTmp },
    builtinSchemas: { run_command: { authority: "pinned-source-known-minimal-fields;full-native-schema-not-yet-captured", parameters: {
      type: "object", properties: { CommandLine: { type: "string", maxLength: 2048 }, Cwd: { type: "string", maxLength: 4096 } }, required: ["CommandLine", "Cwd"], additionalProperties: false } }, ...(options.builtinSchemas || {}) },
    protectedFiles, rootIdentities: [...new Set([root, workspace, sdkHome, geminiHome, sdkTmp, appDataDir, ...readRoots])].map(file => ({ path: file, identity: guard.statIdentity(fs.lstatSync(file)) })),
    readiness: { realModelAdmission: "UNPROVEN", sameSessionHookRegistration: false, actualNativeToolBodyProof: false,
      finalSdkRequestCapture: false, originalNativeBuiltinSchemaComplete: false, credentialEnvironmentInActualToolShellProvenAbsent: false,
      originalHomeStartupFilesInActualToolShellProvenAbsent: false, childCredentialIpcOsIsolation: "UNPROVEN",
      suppliedSchemaAuthority: options.schemaAuthority || "none;unknown-original-builtin-fields-are-denied" } };
  guard.validateParentEnvironment(manifest.parentEnvironment, manifest);
  if (guard.startupFiles(sdkHome).some(file => { try { fs.lstatSync(file); return true; } catch (error) { return error.code !== "ENOENT"; } })) throw guard.failure("AGY_GUARD_STARTUP_FILE_PRESENT");
  const serialized = Buffer.from(JSON.stringify(manifest, null, 2) + "\n"), written = immutable(manifestPath, serialized);
  const config = immutable(hooksConfigPath, Buffer.from(JSON.stringify(guard.hookConfig(manifest, manifestPath, written.sha256), null, 2) + "\n"));
  const loaded = guard.loadManifest(manifestPath, written.sha256, manifest.nonce);
  return { manifestPath, digest: written.sha256, nonce: manifest.nonce, hooksConfigPath, hooksConfigSha256: config.sha256,
    guardPath, manifest: loaded.manifest, phase: "owned-official-hook-files-only-no-sdk-execution", sdkStarted: false, credentialRead: false, modelAdmission: "UNPROVEN" };
}
function prepareAntigravityGuardBootstrap(options) {
  const root = fs.realpathSync(options.root), sdkHome = fs.realpathSync(options.sdkHome), geminiHome = fs.realpathSync(options.geminiHome);
  if (!root.startsWith("/private/tmp/sggroup-") || ![sdkHome, geminiHome].every(file => guard.within(file, root))
    || !guard.text(options.runtimeAccountId, 512) || !Array.isArray(options.roles) || !options.roles.length) throw guard.failure("AGY_GUARD_BOOTSTRAP_INVALID");
  for (const file of [root, sdkHome, geminiHome]) guard.noLinks(file, root);
  const directoryPath = directory(path.join(root, "agy-pre-tool-policy"), root), guardHome = directory(path.join(directoryPath, "guard-home"), root), guardTmp = directory(path.join(directoryPath, "guard-tmp"), root);
  const admissionsDirectory = directory(path.join(directoryPath, "admissions"), root), sdkTmp = directory(options.sdkTmp || path.join(sdkHome, "tmp"), root);
  const appDataDir = directory(options.appDataDir || guard.officialAppDataDir(geminiHome), root);
  if (appDataDir !== guard.officialAppDataDir(geminiHome)) throw guard.failure("AGY_GUARD_OFFICIAL_METADATA_UNBOUND");
  const manifestPath = path.join(directoryPath, "manifest.json"), guardPath = path.join(directoryPath, "guard.cjs"), protectedFiles = [];
  const sourceRoot = fs.realpathSync(options.repoSource || path.join(__dirname, ".."));
  const sourceHostPath = path.join(sourceRoot, "app/agent-service/antigravity-acp-runtime-host.js");
  const sourceHostFact = guard.readStable(sourceHostPath, { root: sourceRoot });
  const sourceHostModule = { root: sourceRoot, path: sourceHostPath, sha256: sourceHostFact.sha256, identity: sourceHostFact.identity };
  for (const [source, name] of [[__dirname + "/group-collaboration-antigravity-guard.cjs", "guard.cjs"], [__dirname + "/group-collaboration-live-policy.cjs", "live-policy.cjs"],
    [path.join(sourceRoot, "app/agent-service/group-mcp-tools.js"), "group-mcp-tools.js"], [path.join(sourceRoot, "app/agent-service/group-tool-grant.js"), "group-tool-grant.js"]]) {
    protectedFiles.push(immutable(path.join(directoryPath, name), fs.readFileSync(source)));
  }
  const roles = options.roles.map(spec => {
    if (!guard.text(spec.roleId, 128) || !guard.text(spec.caseId, 128) || !guard.exact(spec.binding, ["runtimeProfileId", "runtimeAccountId", "runId", "requestId", "source"])) throw guard.failure("AGY_GUARD_ROLE_BINDING_INVALID");
    const workspace = fs.realpathSync(spec.workspace), readRoots = (spec.readRoots || [workspace]).map(file => fs.realpathSync(file));
    const groupTools = spec.groupTools || GROUP_TOOLS;
    if (![3, 4].includes(groupTools.length) || new Set(groupTools).size !== groupTools.length || groupTools.some(tool => !GROUP_TOOLS.includes(tool))) throw guard.failure("AGY_GUARD_GROUP_TOOLS_INVALID");
    for (const file of [workspace, ...readRoots]) guard.noLinks(file, root);
    if ([".agents", ".agent", "_agents", "_agent"].some(dot => guard.pathExists(path.join(workspace, dot, "hooks.json")))) throw guard.failure("AGY_GUARD_WORKSPACE_HOOK_PRESENT");
    return { roleId: spec.roleId, caseId: spec.caseId, binding: { ...spec.binding }, workspace, readRoots,
      workspacePaths: guard.officialWorkspacePaths(geminiHome, workspace),
      artifactPath: path.join(workspace, "sum-valid.cjs"), admissionPath: path.join(admissionsDirectory, crypto.randomBytes(16).toString("hex") + ".json"),
      groupTools, groupSources: spec.groupSources || [{ source: "chat", sourceId: spec.binding.runId }], groupTokenDigests: spec.groupTokenDigests || [],
      builtinSchemas: { run_command: { authority: "pinned-source-known-minimal-fields;full-native-schema-not-yet-captured", parameters: {
        type: "object", properties: { CommandLine: { type: "string", maxLength: 2048 }, Cwd: { type: "string", maxLength: 4096 } }, required: ["CommandLine", "Cwd"], additionalProperties: false } }, ...(spec.builtinSchemas || {}) },
      schemaAuthority: spec.schemaAuthority || "none;unknown-original-builtin-fields-are-denied" };
  });
  const hooksConfigPath = path.join(directory(path.join(geminiHome, "config"), root), "hooks.json");
  const manifest = { version: 2, runtime: "antigravity", root, binding: { runtimeAccountId: options.runtimeAccountId },
    nonce: options.nonce || crypto.randomBytes(32).toString("hex"), admissionKey: crypto.randomBytes(32).toString("hex"),
    roles, admissionsDirectory, sdkHome, geminiHome, sdkTmp, guardHome, guardTmp, appDataDir, sourceHostModule,
    nodePath: fs.realpathSync(process.execPath), guardPath, hooksConfigPath, decisionLogPath: path.join(directoryPath, "decisions.jsonl"),
    sharedPolicyPath: path.join(directoryPath, "live-policy.cjs"), groupValidatorPath: path.join(directoryPath, "group-mcp-tools.js"), protectedFiles,
    parentEnvironment: options.parentEnvironment || { PATH: "/usr/bin:/bin", HOME: sdkHome, GEMINI_HOME: geminiHome, TMPDIR: sdkTmp },
    rootIdentities: [...new Set([root, directoryPath, admissionsDirectory, guardHome, guardTmp, sdkHome, geminiHome, sdkTmp, appDataDir, ...roles.flatMap(role => [role.workspace, ...role.readRoots])])].map(file => ({ path: file, identity: guard.statIdentity(fs.lstatSync(file)) })),
    readiness: { realModelAdmission: "UNPROVEN", sameSessionHookRegistration: false, actualNativeToolBodyProof: false,
      finalSdkRequestCapture: false, originalNativeBuiltinSchemaComplete: false, childCredentialIpcOsIsolation: "UNPROVEN",
      admissionSource: "trusted-original-SourceHost-sessionStart-wrapper-only;hook-input-does-not-publish" } };
  guard.validateRouter(manifest); guard.validateParentEnvironment(manifest.parentEnvironment, manifest);
  if (guard.startupFiles(sdkHome).some(guard.pathExists)) throw guard.failure("AGY_GUARD_STARTUP_FILE_PRESENT");
  const written = immutable(manifestPath, Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
  const config = immutable(hooksConfigPath, Buffer.from(JSON.stringify(guard.hookConfig(manifest, manifestPath, written.sha256), null, 2) + "\n"));
  const loaded = guard.loadManifest(manifestPath, written.sha256, manifest.nonce);
  return { manifestPath, digest: written.sha256, nonce: manifest.nonce, hooksConfigPath, hooksConfigSha256: config.sha256, guardPath,
    manifest: loaded.manifest, phase: "deny-all-official-global-hook-bootstrap-before-session-new", sdkStarted: false, credentialRead: false, modelAdmission: "UNPROVEN" };
}

function originalSourceHostClass(manifest) {
  const source = manifest.sourceHostModule;
  if (!guard.exact(source, ["root", "path", "sha256", "identity"]) || source.path !== path.join(source.root, "app/agent-service/antigravity-acp-runtime-host.js")) throw guard.failure("AGY_GUARD_SOURCE_MODULE_UNBOUND");
  guard.readStable(source.path, { root: source.root, expectedSha256: source.sha256, identity: source.identity });
  const SourceHost = require(source.path).AntigravityAcpRuntimeHost;
  if (typeof SourceHost !== "function" || typeof SourceHost.prototype.sessionStart !== "function") throw guard.failure("AGY_GUARD_SOURCE_MODULE_UNBOUND");
  return SourceHost;
}

// This entry point invokes the original SourceHost method itself. A tool's
// conversationId, a caller-built session object, or a hook body is insufficient
// to obtain the private receipt needed by the publisher.
async function startAntigravityGuardSession(prepared, { roleId, host, input }) {
  const loaded = guard.loadManifest(prepared.manifestPath, prepared.digest, prepared.nonce), role = loaded.manifest.roles?.find(item => item.roleId === roleId);
  const SourceHost = originalSourceHostClass(loaded.manifest);
  const priorSession = host?.ledger?.snapshot()?.sessions?.some(item => item.source === role?.binding.source);
  if (!role || !(host instanceof SourceHost) || host.controlInstance || host.workspace !== role.workspace
    || host.runtimeProfileId !== role.binding.runtimeProfileId || host.runtimeAccountId !== role.binding.runtimeAccountId
    || host.mcpExecutionRunId !== role.binding.runId || input?.source !== role.binding.source
    || input?.cwd !== role.workspace || guard.pathExists(role.admissionPath) || priorSession
    || host.runtimeEnvironment?.spawnEnv?.HOME !== loaded.manifest.sdkHome || host.acpHome?.geminiHome !== loaded.manifest.geminiHome) throw guard.failure("AGY_GUARD_SOURCE_HOST_UNBOUND");
  const result = await SourceHost.prototype.sessionStart.call(host, input);
  // Recheck immutable configuration after the asynchronous session handshake.
  guard.loadManifest(prepared.manifestPath, prepared.digest, prepared.nonce);
  originalSourceHostClass(loaded.manifest);
  const session = result?.session, actual = host.ledger?.snapshot()?.sessions?.find(item => item.id === session?.id);
  if (!session || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(session.id || "") || session.source !== role.binding.source || session.cwd !== role.workspace
    || !actual || actual.source !== session.source || actual.cwd !== session.cwd || actual.archived || !Array.isArray(actual.turns) || actual.turns.length
    || host.activeTurns?.size || host.runtimeProfileId !== role.binding.runtimeProfileId || host.runtimeAccountId !== role.binding.runtimeAccountId
    || host.mcpExecutionRunId !== role.binding.runId || host.workspace !== role.workspace
    || host.runtimeEnvironment?.spawnEnv?.HOME !== loaded.manifest.sdkHome || host.acpHome?.geminiHome !== loaded.manifest.geminiHome) throw guard.failure("AGY_GUARD_SOURCE_SESSION_METADATA_UNBOUND");
  const receipt = Object.freeze({ roleId, sessionId: session.id });
  SESSION_RECEIPTS.set(receipt, { prepared, role, host, session: { id: session.id, source: session.source, cwd: session.cwd } });
  return { session: result.session, receipt, modelAdmission: "UNPROVEN", realSdkHookExecutionProven: false };
}
function publishAntigravityGuardSession(prepared, receipt, { cachedSchemas = [] } = {}) {
  const known = SESSION_RECEIPTS.get(receipt);
  if (!known || known.prepared !== prepared) throw guard.failure("AGY_GUARD_TRUSTED_SESSION_RECEIPT_REQUIRED");
  const loaded = guard.loadManifest(prepared.manifestPath, prepared.digest, prepared.nonce), router = loaded.manifest, role = router.roles.find(item => item.roleId === known.role.roleId);
  const { session, host } = known, actual = host.ledger?.snapshot()?.sessions?.find(item => item.id === session.id);
  if (!(host instanceof originalSourceHostClass(router)) || !actual || actual.source !== session.source || actual.cwd !== session.cwd || actual.archived || !Array.isArray(actual.turns) || actual.turns.length || host.activeTurns?.size
    || host.workspace !== role.workspace || host.runtimeProfileId !== role.binding.runtimeProfileId || host.runtimeAccountId !== role.binding.runtimeAccountId
    || host.mcpExecutionRunId !== role.binding.runId || host.runtimeEnvironment?.spawnEnv?.HOME !== router.sdkHome
    || host.acpHome?.geminiHome !== router.geminiHome) throw guard.failure("AGY_GUARD_SOURCE_SESSION_METADATA_UNBOUND");
  for (const other of router.roles) if (guard.pathExists(other.admissionPath)) {
    const record = guard.parseStrictJson(guard.readStable(other.admissionPath, { root: router.root, mode: 0o400 }).bytes.toString("utf8"));
    if (record.payload?.binding?.sessionId === session.id) throw guard.failure("AGY_GUARD_SESSION_ALREADY_ROUTED");
  }
  const records = cachedSchemas.map(({ toolName, file, sha256 }) => {
    const expected = path.join(router.appDataDir, "brain", session.id, "mcp", "shoggoth", toolName + ".json");
    if (!role.groupTools.includes(toolName) || file !== expected || !/^[a-f0-9]{64}$/u.test(sha256 || "")) throw guard.failure("AGY_GUARD_CACHED_SCHEMA_UNBOUND");
    const fact = guard.readStable(file, { root: router.root, expectedSha256: sha256, maxBytes: guard.MAX_INPUT });
    return { toolName, path: file, sha256, identity: fact.identity };
  });
  const payload = { version: 1, routerDigest: prepared.digest, roleId: role.roleId, roleDigest: guard.sha(JSON.stringify(role)),
    binding: { sessionId: session.id, runtimeProfileId: role.binding.runtimeProfileId, runtimeAccountId: role.binding.runtimeAccountId, runId: role.binding.runId, requestId: role.binding.requestId },
    sessionSource: session.source, sessionCwd: session.cwd, transcriptPath: guard.officialTranscript(router.geminiHome, session.id),
    artifactDirectoryPath: guard.officialArtifactDirectory(router.geminiHome), cachedSchemas: records, authority: "original-SourceHost.sessionStart-return-and-ledger" };
  guard.noLinks(path.dirname(role.admissionPath), router.root);
  const fd = fs.openSync(role.admissionPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try {
    const stat = fs.fstatSync(fd); payload.fileIdentity = { dev: stat.dev, ino: stat.ino, uid: stat.uid };
    fs.writeFileSync(fd, Buffer.from(JSON.stringify({ payload, mac: guard.admissionMac(router, payload) }, null, 2) + "\n")); fs.fchmodSync(fd, 0o400);
  } finally { fs.closeSync(fd); }
  const written = guard.readStable(role.admissionPath, { root: router.root, mode: 0o400 });
  SESSION_RECEIPTS.delete(receipt);
  return { admissionPath: role.admissionPath, admissionSha256: written.sha256, sessionId: session.id, roleId: role.roleId,
    sourceMetadataBindingPublished: true, sameSessionHookRegistration: false, actualNativeToolBodyProof: false, modelAdmission: "UNPROVEN" };
}
module.exports = { prepareAntigravityGuard, prepareAntigravityGuardBootstrap, startAntigravityGuardSession, publishAntigravityGuardSession, schemasFromCapturedSdkRequest };
