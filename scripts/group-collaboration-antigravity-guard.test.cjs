"use strict";

const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const guard = require("./group-collaboration-antigravity-guard.cjs");
const { prepareAntigravityGuard, prepareAntigravityGuardBootstrap, startAntigravityGuardSession,
  publishAntigravityGuardSession, schemasFromCapturedSdkRequest } = require("./group-collaboration-antigravity-guard-manifest.cjs");
const fakeFileSchema = { authority: "OWNED_FAKE_CANARY_NOT_NATIVE_SCHEMA_PROOF", parameters: { type: "object", properties: {
  TargetFile: { type: "string" }, CodeContent: { type: "string", maxLength: 65536 } }, required: ["TargetFile", "CodeContent"], additionalProperties: false } };
function fixture({ caseId = "implementation-review", schemas = { create_file: fakeFileSchema, edit_file: fakeFileSchema }, options = {} } = {}) {
  const root = fs.mkdtempSync("/private/tmp/sggroup-agy-guard-unit-"), workspace = path.join(root, "role-workspace"), sdkHome = path.join(root, "fresh-sdk-home"), geminiHome = path.join(sdkHome, ".gemini");
  for (const file of [workspace, geminiHome]) fs.mkdirSync(file, { mode: 0o700, recursive: true });
  const binding = { sessionId: "owned-session-1", runtimeProfileId: "owned-profile-1", runtimeAccountId: "owned-account-1", runId: "owned-run-1", requestId: "owned-request-1" };
  const appDataDir = guard.officialAppDataDir(geminiHome), cachedFile = path.join(appDataDir, "brain", binding.sessionId, "mcp/shoggoth/group_messages_read.json");
  fs.mkdirSync(path.dirname(cachedFile), { mode: 0o700, recursive: true }); fs.writeFileSync(cachedFile, '{"name":"group_messages_read","inputSchema":{"type":"object"}}\n', { mode: 0o600 });
  const prepared = prepareAntigravityGuard({ root, workspace, sdkHome, geminiHome, caseId, roleId: "owned-implementer", binding, appDataDir,
    builtinSchemas: schemas, schemaAuthority: "owned-fake-unit-canary;not-native-proof", cachedSchemas: [{ toolName: "group_messages_read", file: cachedFile, sha256: guard.sha(fs.readFileSync(cachedFile)) }], ...options });
  const loaded = guard.loadManifest(prepared.manifestPath, prepared.digest, prepared.nonce);
  const input = (name, args) => ({ toolCall: { name, args }, stepIdx: 1, conversationId: binding.sessionId, workspacePaths: prepared.manifest.workspacePaths,
    transcriptPath: prepared.manifest.transcriptPath, artifactDirectoryPath: prepared.manifest.artifactDirectoryPath });
  const cli = (value, overrides = {}) => spawnSync(process.execPath, [prepared.guardPath, "--manifest", prepared.manifestPath, "--digest", prepared.digest,
    "--nonce", overrides.nonce || prepared.nonce, ...(overrides.extraArgs || [])], { cwd: overrides.cwd || workspace,
    env: { PATH: "/usr/bin:/bin", HOME: prepared.manifest.guardHome, TMPDIR: prepared.manifest.guardTmp, ...(overrides.env || {}) },
    input: typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value), encoding: "utf8", timeout: 5000 });
  return { root, workspace, sdkHome, geminiHome, cachedFile, prepared, loaded, input, cli };
}
function cliAnswer(result) {
  assert.equal(result.status, 0, result.stderr); const rows = result.stdout.trim().split("\n"); assert.equal(rows.length, 1);
  const answer = JSON.parse(rows[0]); assert.equal(typeof answer.allowTool, "boolean");
  assert.ok(Object.keys(answer).every(key => ["allowTool", "denyReason"].includes(key))); return answer;
}

test("generated official config freezes nonce/hash/private files and never claims native admission", () => {
  const f = fixture(), config = JSON.parse(fs.readFileSync(f.prepared.hooksConfigPath));
  assert.equal(config["frozen-role-parameter-policy"].PreToolUse[0].hooks[0].type, "command");
  assert.ok(config["frozen-role-parameter-policy"].PreToolUse[0].hooks[0].command.includes("'-i'"));
  assert.equal(f.prepared.manifest.readiness.actualNativeToolBodyProof, false); assert.equal(f.prepared.modelAdmission, "UNPROVEN");
  for (const record of f.prepared.manifest.protectedFiles) assert.equal(fs.statSync(record.path).mode & 0o777, 0o400);
  assert.equal(fs.statSync(f.prepared.manifestPath).mode & 0o777, 0o400);
});
test("owned fake create/edit can operate only on frozen sum-valid.cjs; necessary capability remains", () => {
  const f = fixture(), artifact = path.join(f.workspace, "sum-valid.cjs"), source = 'module.exports = values => values.filter(Number.isFinite).reduce((a,b)=>a+b,0);';
  const create = cliAnswer(f.cli(f.input("create_file", { TargetFile: artifact, CodeContent: source }))); assert.equal(create.allowTool, true);
  // Deliberately a fake controlled body, never an original SDK tool body.
  fs.writeFileSync(artifact, source, { mode: 0o600 }); assert.equal(fs.readFileSync(artifact, "utf8"), source);
  assert.equal(cliAnswer(f.cli(f.input("edit_file", { TargetFile: artifact, CodeContent: source + "\n" }))).allowTool, true);
  assert.equal(cliAnswer(f.cli(f.input("create_file", { TargetFile: path.join(f.workspace, "hooks.json"), CodeContent: "{}" }))).allowTool, false);
});
test("source-confirmed view_file accepts each alias family and rejects ambiguous/extra fields", () => {
  const f = fixture(), file = path.join(f.workspace, "source.cjs"); fs.writeFileSync(file, "own-source\n", { mode: 0o600 });
  assert.equal(cliAnswer(f.cli(f.input("view_file", { absolute_path: file, start_line: 1, end_line: 2 }))).allowTool, true);
  assert.equal(cliAnswer(f.cli(f.input("view_file", { AbsolutePath: file, StartLine: 1 }))).allowTool, true);
  for (const args of [{ AbsolutePath: file, absolute_path: file }, { AbsolutePath: file, ctx: {} }, { AbsolutePath: file, StartLine: true }, { AbsolutePath: file, StartLine: 3, EndLine: 2 }]) {
    assert.equal(cliAnswer(f.cli(f.input("view_file", args))).allowTool, false);
  }
});
test("exact same-session cached schema is the only non-workspace read exception", () => {
  const f = fixture({ caseId: "source-handoff" });
  assert.equal(cliAnswer(f.cli(f.input("view_file", { AbsolutePath: f.cachedFile }))).allowTool, true);
  const secret = path.join(f.geminiHome, "synthetic-token.json"); fs.writeFileSync(secret, "OWNED_FAKE_SECRET", { mode: 0o600 });
  assert.equal(cliAnswer(f.cli(f.input("view_file", { AbsolutePath: secret }))).allowTool, false);
  fs.appendFileSync(f.cachedFile, "changed"); assert.equal(cliAnswer(f.cli(f.input("view_file", { AbsolutePath: f.cachedFile }))).allowTool, false);
});
test("cached schema hash-preserving replacement, symlink and hardlink are rejected", () => {
  for (const method of ["replace", "symlink", "hardlink"]) {
    const f = fixture(), bytes = fs.readFileSync(f.cachedFile), outside = path.join(f.root, "other-cache.json"); fs.writeFileSync(outside, bytes, { mode: 0o600 }); fs.unlinkSync(f.cachedFile);
    if (method === "replace") fs.writeFileSync(f.cachedFile, bytes, { mode: 0o600 });
    else if (method === "symlink") fs.symlinkSync(outside, f.cachedFile); else fs.linkSync(outside, f.cachedFile);
    assert.equal(cliAnswer(f.cli(f.input("view_file", { AbsolutePath: f.cachedFile }))).allowTool, false, method);
  }
});
test("outside, parent traversal, private synthetic file, directory and path links cannot be read/written", () => {
  const f = fixture(), outside = path.join(f.root, "synthetic-personal.json"); fs.writeFileSync(outside, "FAKE_PRIVATE_UNCHANGED", { mode: 0o600 });
  const linked = path.join(f.workspace, "outside-link"); fs.symlinkSync(outside, linked);
  for (const raw of [outside, linked, f.workspace, f.workspace + "/../synthetic-personal.json", "file://" + outside, "/Users/fixture/.gemini/settings.json"]) {
    assert.equal(cliAnswer(f.cli(f.input("view_file", { AbsolutePath: raw }))).allowTool, false);
    assert.equal(cliAnswer(f.cli(f.input("create_file", { TargetFile: raw, CodeContent: "ATTACK" }))).allowTool, false);
  }
  assert.equal(fs.readFileSync(outside, "utf8"), "FAKE_PRIVATE_UNCHANGED");
});
test("approval admits only exact descriptor/cwd and refuses target that already exists", () => {
  const f = fixture({ caseId: "approval-wait" }), command = "printf '%s' 'approval-evidence-v1' > 'approval-proof.txt'";
  assert.equal(cliAnswer(f.cli(f.input("run_command", { CommandLine: command, Cwd: f.workspace }))).allowTool, true);
  fs.writeFileSync(path.join(f.workspace, "approval-proof.txt"), "existing", { mode: 0o600 });
  assert.equal(cliAnswer(f.cli(f.input("run_command", { CommandLine: command, Cwd: f.workspace }))).allowTool, false);
});
test("Keychain, env and startup attacks are rejected as actual CLI guard decisions", () => {
  const f = fixture({ caseId: "approval-wait" });
  for (const command of ["security find-generic-password -w", "env", "printenv", "cat ~/.gemini/settings.json", "printf '%s' 'approval-evidence-v1' > 'approval-proof.txt'; env", "/bin/zsh -lc 'env'", "HOME=/Users/fixture env", "printf '%s' $(env) > approval-proof.txt"]) {
    assert.equal(cliAnswer(f.cli(f.input("run_command", { CommandLine: command, Cwd: f.workspace }))).allowTool, false, command);
  }
  const fixed = { CommandLine: "printf '%s' 'approval-evidence-v1' > 'approval-proof.txt'", Cwd: f.workspace };
  for (const extra of [{ Environment: { FAKE_API_KEY: "FAKE_SECRET_NOT_TO_LOG" } }, { IsDaemon: true }, { SafeToAutoRun: true }, { unknown: 1 }]) assert.equal(cliAnswer(f.cli(f.input("run_command", { ...fixed, ...extra }))).allowTool, false);
  assert.equal(cliAnswer(f.cli(f.input("run_command", fixed), { env: { FAKE_API_KEY: "FAKE_SECRET_NOT_TO_LOG" } })).allowTool, false);
  fs.writeFileSync(path.join(f.sdkHome, ".zshenv"), "FAKE_STARTUP_NO_EXECUTION", { mode: 0o600 });
  assert.equal(cliAnswer(f.cli(f.input("run_command", fixed))).allowTool, false);
});
test("captured-schema field names cannot authorize background/env/auto-run semantics", () => {
  const parameters = { type: "object", properties: { CommandLine: { type: "string" }, Cwd: { type: "string" },
    SafeToAutoRun: { type: "boolean" }, IsDaemon: { type: "boolean" }, WaitMsBeforeAsync: { type: "integer" },
    Environment: { type: "object", properties: { OWNED_FAKE_ENV: { type: "string" } } }, Description: { type: "string" } }, required: ["CommandLine", "Cwd"] };
  const f = fixture({ caseId: "approval-wait", options: { builtinSchemas: { run_command: { parameters, authority: "OWNED_FAKE_EXPANDED_SCHEMA_NOT_NATIVE" } } } });
  const fixed = { CommandLine: "printf '%s' 'approval-evidence-v1' > 'approval-proof.txt'", Cwd: f.workspace };
  assert.equal(cliAnswer(f.cli(f.input("run_command", fixed))).allowTool, true);
  for (const extra of [{ SafeToAutoRun: false }, { IsDaemon: false }, { WaitMsBeforeAsync: 1000 }, { Environment: { OWNED_FAKE_ENV: "own" } }, { Description: "extra controls remain unproved" }]) {
    assert.equal(cliAnswer(f.cli(f.input("run_command", { ...fixed, ...extra }))).allowTool, false);
  }
  const fileRule = structuredClone(fakeFileSchema); fileRule.parameters.properties.Environment = { type: "object", properties: { OWNED_FAKE_ENV: { type: "string" } } };
  const g = fixture({ schemas: { create_file: fileRule } }), args = { TargetFile: path.join(g.workspace, "sum-valid.cjs"), CodeContent: "const environment = 'source text remains valid';" };
  assert.equal(cliAnswer(g.cli(g.input("create_file", args))).allowTool, true);
  assert.equal(cliAnswer(g.cli(g.input("create_file", { ...args, Environment: { OWNED_FAKE_ENV: "own" } }))).allowTool, false);
});
test("MCP uses original source validator plus frozen server/tool and run authority", () => {
  const f = fixture(), input = f.input("call_mcp_tool", { ServerName: "shoggoth", ToolName: "group_messages_read", Arguments: { source: "chat", sourceId: "owned-run-1", messageSeq: 1, offset: 0 } });
  assert.equal(cliAnswer(f.cli(input)).allowTool, true);
  for (const changed of [
    { ...input, toolCall: { ...input.toolCall, args: { ...input.toolCall.args, ServerName: "other" } } },
    { ...input, toolCall: { ...input.toolCall, args: { ...input.toolCall.args, ToolName: "memory_save" } } },
    { ...input, toolCall: { ...input.toolCall, args: { ...input.toolCall.args, Description: "extra" } } },
    { ...input, toolCall: { ...input.toolCall, args: { ...input.toolCall.args, Arguments: { source: "chat", sourceId: "foreign-run", messageSeq: 1 } } } },
    { ...input, toolCall: { ...input.toolCall, args: { ...input.toolCall.args, Arguments: { source: "chat", sourceId: "owned-run-1", messageSeq: 1, unknown: true } } } },
  ]) assert.equal(cliAnswer(f.cli(changed)).allowTool, false);
});
test("session, declared/actual workspace, nonce and unknown hook fields reject", () => {
  const f = fixture(), valid = f.input("view_file", { AbsolutePath: f.cachedFile });
  for (const changed of [{ ...valid, conversationId: "foreign-session" }, { ...valid, workspacePaths: [f.root] }, { ...valid, nonce: f.prepared.nonce }, { ...valid, stepIdx: 0 }]) assert.equal(cliAnswer(f.cli(changed)).allowTool, false);
  assert.equal(cliAnswer(f.cli(valid, { nonce: "0".repeat(64) })).allowTool, false);
  assert.equal(cliAnswer(f.cli(valid, { cwd: f.root })).allowTool, false);
  assert.equal(cliAnswer(f.cli(valid, { extraArgs: ["--nonce", f.prepared.nonce] })).allowTool, false);
});
test("parse failures, duplicates/Unicode duplicate keys, nonfinite/oversize and invalid UTF8 always emit explicit bool", () => {
  const f = fixture();
  for (const raw of ["", "{", "{}", '[1]', '{"name":1,"n\\u0061me":2}', '{"a":1e999}', '{"__proto__":{}}', " ".repeat(70 * 1024), Buffer.from([0xff, 0xff])]) {
    const result = f.cli(raw), answer = cliAnswer(result); assert.equal(answer.allowTool, false); assert.equal(result.stdout.includes("FAKE_SECRET_NOT_TO_LOG"), false);
  }
});
test("changed guard/config/manifest and missing manifest fail closed", () => {
  for (const property of ["guardPath", "hooksConfigPath", "manifestPath"]) {
    const f = fixture(), file = f.prepared[property]; fs.chmodSync(file, 0o600); fs.appendFileSync(file, "\n"); fs.chmodSync(file, 0o400);
    assert.equal(cliAnswer(f.cli(f.input("view_file", { AbsolutePath: f.cachedFile }))).allowTool, false, property);
  }
  const f = fixture(); fs.unlinkSync(f.prepared.manifestPath); assert.equal(cliAnswer(f.cli("{}" )).allowTool, false);
});
test("decision records contain safe identity/digests and no args bodies or fake credential content", () => {
  const f = fixture(), file = path.join(f.workspace, "sum-valid.cjs"), content = "FAKE_SECRET_NOT_TO_LOG";
  assert.equal(cliAnswer(f.cli(f.input("create_file", { TargetFile: file, CodeContent: content }))).allowTool, true);
  const raw = fs.readFileSync(f.prepared.manifest.decisionLogPath, "utf8"), row = JSON.parse(raw.trim());
  assert.equal(raw.includes(content), false); assert.equal(row.toolBodyExecutedByGuard, false); assert.equal(row.realSdkHookExecutionProven, false);
  assert.equal(row.sessionId, "owned-session-1"); assert.deepEqual(row.argumentFields, ["CodeContent", "TargetFile"]);
});
test("unknown native schemas deny until explicitly supplied, and fake capture extraction stays unproven", () => {
  const f = fixture({ schemas: {} }), artifact = path.join(f.workspace, "sum-valid.cjs");
  assert.equal(cliAnswer(f.cli(f.input("create_file", { TargetFile: artifact, CodeContent: "public" }))).allowTool, false);
  const captured = path.join(f.root, "fake-final-sdk-body.json"), body = { request: { tools: [{ functionDeclarations: [{ name: "create_file", parameters: fakeFileSchema.parameters }] }] } };
  fs.writeFileSync(captured, JSON.stringify(body), { mode: 0o600 }); const schemas = schemasFromCapturedSdkRequest({ file: captured, root: f.root, sha256: guard.sha(fs.readFileSync(captured)) });
  assert.deepEqual(schemas.create_file.parameters, fakeFileSchema.parameters); assert.ok(schemas.create_file.authority.includes("verified-separately"));
  assert.throws(() => schemasFromCapturedSdkRequest({ file: captured, root: f.root, sha256: "0".repeat(64) }));
});
test("generator rejects fresh-home startup scripts and inherited API/proxy credentials", () => {
  for (const reason of ["startup", "api", "proxy"]) {
    const root = fs.mkdtempSync("/private/tmp/sggroup-agy-guard-rejected-"), workspace = path.join(root, "workspace"), sdkHome = path.join(root, "home"), geminiHome = path.join(sdkHome, ".gemini");
    for (const file of [workspace, geminiHome]) fs.mkdirSync(file, { recursive: true, mode: 0o700 });
    if (reason === "startup") fs.writeFileSync(path.join(sdkHome, ".zshenv"), "fake");
    const env = { PATH: "/usr/bin:/bin", HOME: sdkHome, GEMINI_HOME: geminiHome, TMPDIR: path.join(sdkHome, "tmp"),
      ...(reason === "api" ? { GEMINI_API_KEY: "FAKE" } : reason === "proxy" ? { HTTPS_PROXY: "https://fake-user:fake-secret@localhost:1" } : {}) };
    assert.throws(() => prepareAntigravityGuard({ root, workspace, sdkHome, geminiHome, caseId: "approval-wait", roleId: "role", parentEnvironment: env,
      binding: { sessionId: "owned-session", runtimeProfileId: "p", runtimeAccountId: "a", runId: "r", requestId: "q" } }));
  }
});

function routerFixture({ count = 3, caseId = "implementation-review", changeRoles, separateGeminiHome = false, repoSource } = {}) {
  const root = fs.mkdtempSync("/private/tmp/sggroup-agy-guard-router-unit-"), sdkHome = path.join(root, "fresh-sdk-home"), geminiHome = separateGeminiHome ? path.join(root, "separate-gemini-home") : path.join(sdkHome, ".gemini");
  fs.mkdirSync(sdkHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(geminiHome, { recursive: true, mode: 0o700 });
  const roles = Array.from({ length: count }, (_, index) => {
    const workspace = path.join(root, "role-" + index); fs.mkdirSync(workspace, { mode: 0o700 });
    return { caseId, roleId: "owned-role-" + index, workspace, builtinSchemas: { create_file: fakeFileSchema, edit_file: fakeFileSchema },
      schemaAuthority: "OWNED_FAKE_CANARY_NOT_NATIVE_SCHEMA_PROOF", binding: { runtimeProfileId: "owned-profile-" + index,
        runtimeAccountId: "owned-shared-account", runId: "owned-run-" + index, requestId: "owned-request-" + index, source: "owned-source-" + index } };
  });
  if (changeRoles) changeRoles(roles, { root, sdkHome, geminiHome });
  const prepared = prepareAntigravityGuardBootstrap({ root, sdkHome, geminiHome, runtimeAccountId: "owned-shared-account", roles, repoSource });
  const input = (index, name, args, sessionId = "owned-session-" + index) => ({ toolCall: { name, args }, stepIdx: 1,
    conversationId: sessionId, workspacePaths: prepared.manifest.roles[index].workspacePaths,
    transcriptPath: guard.officialTranscript(geminiHome, sessionId), artifactDirectoryPath: guard.officialArtifactDirectory(geminiHome) });
  const cli = (index, value, overrides = {}) => spawnSync(process.execPath, [prepared.guardPath, "--manifest", prepared.manifestPath,
    "--digest", prepared.digest, "--nonce", overrides.nonce || prepared.nonce], { cwd: overrides.cwd || roles[index].workspace,
    env: { PATH: "/usr/bin:/bin", HOME: prepared.manifest.guardHome, TMPDIR: prepared.manifest.guardTmp, ...(overrides.env || {}) }, input: JSON.stringify(value), encoding: "utf8", timeout: 5000 });
  // Run the original SourceHost.sessionStart method against a task-owned fake
  // RPC and ledger. This proves sequencing/binding logic, not any native SDK.
  const host = (index, { sessionId = "owned-session-" + index, afterResponse } = {}) => {
    const { AntigravityAcpRuntimeHost } = require(prepared.manifest.sourceHostModule.path), role = roles[index];
    const sourceHost = Object.create(AntigravityAcpRuntimeHost.prototype), data = { sessions: [], pendingSessions: [] };
    Object.assign(sourceHost, { state: "ready", controlInstance: false, workspace: role.workspace, runtimeProfileId: role.binding.runtimeProfileId,
      runtimeAccountId: role.binding.runtimeAccountId, mcpExecutionRunId: role.binding.runId, permissionPolicy: undefined, now: Date.now,
      runtimeEnvironment: { spawnEnv: { HOME: sdkHome } }, acpHome: { geminiHome },
      requestTimeoutMs: 100, activeTurns: new Map(), sessionConfigs: new Map(), ledger: { snapshot: () => structuredClone(data), update: callback => callback(data) },
      rpc: { preflightRequest() {}, async request(method) { assert.equal(method, "session/new"); if (afterResponse) await afterResponse(sourceHost); return { sessionId }; } },
      _validateModel: () => undefined, _acpMode: () => undefined, _mcpServers: async () => [], _rememberConfig() {}, _applyConfig: async () => {},
      // The wrapper must call the original prototype even if this convenience
      // method has been replaced; a fake return value cannot issue a receipt.
      sessionStart: async () => { throw new Error("OWNED_FAKE_OVERRIDE_MUST_NOT_BE_CALLED"); } });
    return sourceHost;
  };
  const start = (index, sourceHost = host(index)) => startAntigravityGuardSession(prepared, { roleId: roles[index].roleId, host: sourceHost,
    input: { source: roles[index].binding.source, cwd: roles[index].workspace } });
  return { root, sdkHome, geminiHome, roles, prepared, input, cli, host, start };
}

test("one immutable official shared-home bootstrap denies every role before trusted session metadata publication", async () => {
  const f = routerFixture(), configBytes = fs.readFileSync(f.prepared.hooksConfigPath), manifestBytes = fs.readFileSync(f.prepared.manifestPath);
  assert.equal(f.prepared.manifest.roles.length, 3); assert.equal(f.prepared.phase, "deny-all-official-global-hook-bootstrap-before-session-new");
  for (let index = 0; index < 3; index += 1) {
    const artifact = path.join(f.roles[index].workspace, "sum-valid.cjs"), value = f.input(index, "create_file", { TargetFile: artifact, CodeContent: "owned-fake-canary" });
    assert.equal(cliAnswer(f.cli(index, value)).denyReason, "AGY_GUARD_SESSION_NOT_ADMITTED");
    const started = await f.start(index);
    assert.equal(cliAnswer(f.cli(index, value)).allowTool, false, "source metadata alone does not publish admission");
    const published = publishAntigravityGuardSession(f.prepared, started.receipt);
    assert.equal(published.modelAdmission, "UNPROVEN"); assert.equal(published.sameSessionHookRegistration, false);
    assert.equal(cliAnswer(f.cli(index, value)).allowTool, true);
    assert.deepEqual(fs.readFileSync(f.prepared.hooksConfigPath), configBytes); assert.deepEqual(fs.readFileSync(f.prepared.manifestPath), manifestBytes);
  }
});
test("hook-supplied/caller-built session metadata cannot publish admission; receipt is bound and one-use", async () => {
  const f = routerFixture();
  assert.throws(() => publishAntigravityGuardSession(f.prepared, { roleId: f.roles[0].roleId, sessionId: "owned-session-0" }), /TRUSTED_SESSION_RECEIPT_REQUIRED/u);
  const started = await f.start(0), other = routerFixture();
  assert.throws(() => publishAntigravityGuardSession(other.prepared, started.receipt), /TRUSTED_SESSION_RECEIPT_REQUIRED/u);
  publishAntigravityGuardSession(f.prepared, started.receipt);
  assert.throws(() => publishAntigravityGuardSession(f.prepared, started.receipt), /TRUSTED_SESSION_RECEIPT_REQUIRED/u);
  assert.equal(cliAnswer(f.cli(1, f.input(1, "view_file", { AbsolutePath: path.join(f.roles[0].workspace, "sum-valid.cjs") }, started.session.id))).allowTool, false);
});
test("same shared account never permits cross-role session/cwd/workspace/run or fabricated admission", async () => {
  const f = routerFixture();
  for (let index = 0; index < 3; index += 1) publishAntigravityGuardSession(f.prepared, (await f.start(index)).receipt);
  const source = path.join(f.roles[0].workspace, "source.cjs"); fs.writeFileSync(source, "owned source", { mode: 0o600 });
  const own = f.input(0, "view_file", { AbsolutePath: source }); assert.equal(cliAnswer(f.cli(0, own)).allowTool, true);
  for (const changed of [{ ...own, conversationId: "owned-session-1" }, { ...own, workspacePaths: [f.roles[1].workspace] },
    { ...own, toolCall: { name: "view_file", args: { AbsolutePath: f.prepared.manifestPath } } }]) assert.equal(cliAnswer(f.cli(0, changed)).allowTool, false);
  assert.equal(cliAnswer(f.cli(0, own, { cwd: f.roles[1].workspace })).allowTool, false);
  assert.equal(cliAnswer(f.cli(0, own, { nonce: "0".repeat(64) })).allowTool, false);
  const admission = f.prepared.manifest.roles[0].admissionPath, record = JSON.parse(fs.readFileSync(admission));
  record.payload.binding.runId = "foreign-run"; fs.chmodSync(admission, 0o600); fs.writeFileSync(admission, JSON.stringify(record)); fs.chmodSync(admission, 0o400);
  assert.equal(cliAnswer(f.cli(0, own)).denyReason, "AGY_GUARD_ADMISSION_CHANGED");
});
test("signed admission cannot be replayed through hash-preserving inode replacement or path links", async () => {
  for (const method of ["replace", "symlink", "hardlink"]) {
    const f = routerFixture({ count: 1 }), started = await f.start(0); publishAntigravityGuardSession(f.prepared, started.receipt);
    const admission = f.prepared.manifest.roles[0].admissionPath, bytes = fs.readFileSync(admission), alternate = path.join(f.root, "alternate-admission.json");
    fs.writeFileSync(alternate, bytes, { mode: 0o400 }); fs.unlinkSync(admission);
    if (method === "replace") fs.writeFileSync(admission, bytes, { mode: 0o400 }); else if (method === "symlink") fs.symlinkSync(alternate, admission); else fs.linkSync(alternate, admission);
    assert.equal(cliAnswer(f.cli(0, f.input(0, "create_file", { TargetFile: path.join(f.roles[0].workspace, "sum-valid.cjs"), CodeContent: "owned-fake" }))).allowTool, false, method);
  }
});
test("SourceHost binding and metadata changes before publication reject even with original method receipt", async () => {
  const f = routerFixture(), wrong = f.host(0); wrong.runtimeProfileId = "foreign-profile";
  await assert.rejects(() => f.start(0, wrong), /SOURCE_HOST_UNBOUND/u);
  await assert.rejects(() => f.start(0, {}), /SOURCE_HOST_UNBOUND/u);
  const wrongHome = f.host(0); wrongHome.runtimeEnvironment.spawnEnv.HOME = f.root; await assert.rejects(() => f.start(0, wrongHome), /SOURCE_HOST_UNBOUND/u);
  const wrongGemini = f.host(0); wrongGemini.acpHome.geminiHome = f.root; await assert.rejects(() => f.start(0, wrongGemini), /SOURCE_HOST_UNBOUND/u);
  const existing = f.host(0); existing.ledger.update(data => data.sessions.push({ id: "owned-old-session", source: f.roles[0].binding.source, cwd: f.roles[0].workspace, archived: false, turns: [] }));
  await assert.rejects(() => f.start(0, existing), /SOURCE_HOST_UNBOUND/u);
  const host = f.host(0), started = await f.start(0, host);
  host.ledger.update(data => data.sessions[0].turns.push({ id: "owned-fake-turn" }));
  assert.throws(() => publishAntigravityGuardSession(f.prepared, started.receipt), /SOURCE_SESSION_METADATA_UNBOUND/u);
  assert.equal(cliAnswer(f.cli(0, f.input(0, "run_command", { CommandLine: "env", Cwd: f.roles[0].workspace }))).allowTool, false);
});
test("bootstrap and each hook invocation reject workspace hook injection and overlapping role scopes", async () => {
  assert.throws(() => routerFixture({ changeRoles: roles => { roles[1].workspace = roles[0].workspace; } }), /ROUTER_INVALID/u);
  assert.throws(() => routerFixture({ changeRoles: roles => { roles[0].readRoots = [path.dirname(roles[0].workspace)]; } }), /ROUTER_SCOPE/u);
  assert.throws(() => routerFixture({ changeRoles: roles => { const foreignSubdir = path.join(roles[1].workspace, "src"); fs.mkdirSync(foreignSubdir); roles[0].readRoots = [foreignSubdir]; } }), /ROUTER_SCOPE_OVERLAP/u);
  assert.throws(() => routerFixture({ changeRoles: roles => { const dir = path.join(roles[0].workspace, ".agents"); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "hooks.json"), "{}"); } }), /WORKSPACE_HOOK_PRESENT/u);
  const f = routerFixture(), started = await f.start(0); publishAntigravityGuardSession(f.prepared, started.receipt);
  const directory = path.join(f.roles[0].workspace, ".agents"); fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "hooks.json"), "{}");
  assert.equal(cliAnswer(f.cli(0, f.input(0, "create_file", { TargetFile: path.join(f.roles[0].workspace, "sum-valid.cjs"), CodeContent: "owned-fake" }))).denyReason, "AGY_GUARD_WORKSPACE_HOOK_PRESENT");
});
test("private control descendants and separated SDK/Gemini homes cannot become workspace/read roots", () => {
  for (const component of ["guard-home", "guard-tmp", "admissions"]) {
    assert.throws(() => routerFixture({ count: 1, changeRoles: (roles, { root }) => { roles[0].readRoots = [path.join(root, "agy-pre-tool-policy", component)]; } }), /ROUTER_SCOPE_UNSAFE/u, component);
  }
  assert.throws(() => routerFixture({ count: 1, changeRoles: (roles, { root }) => { roles[0].workspace = path.join(root, "agy-pre-tool-policy", "guard-home"); } }), /ROUTER_SCOPE_UNSAFE/u);
  assert.throws(() => routerFixture({ count: 1, separateGeminiHome: true, changeRoles: (roles, { geminiHome }) => { roles[0].readRoots = [geminiHome]; } }), /ROUTER_SCOPE_UNSAFE/u);
  assert.throws(() => routerFixture({ count: 1, separateGeminiHome: true, changeRoles: (roles, { geminiHome }) => { roles[0].workspace = geminiHome; } }), /ROUTER_SCOPE_UNSAFE/u);
});
function ownedSourceCopy() {
  const originalRoot = path.join(__dirname, ".."), copiedRoot = fs.mkdtempSync("/private/tmp/sggroup-agy-guard-source-unit-"), seen = new Set();
  const copy = source => {
    const relative = path.relative(originalRoot, source); assert.ok(relative && !relative.startsWith("..") && [".js", ".cjs", ".json"].includes(path.extname(source)));
    if (seen.has(source)) return; seen.add(source);
    const bytes = fs.readFileSync(source), target = path.join(copiedRoot, relative); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.writeFileSync(target, bytes, { mode: 0o400 });
    if (path.extname(source) === ".json") return;
    for (const match of bytes.toString("utf8").matchAll(/require\(["'](\.[^"']+)["']\)/gu)) copy(require.resolve(path.resolve(path.dirname(source), match[1])));
  };
  for (const relative of ["app/agent-service/antigravity-acp-runtime-host.js", "app/agent-service/group-mcp-tools.js", "app/agent-service/group-tool-grant.js"]) copy(path.join(originalRoot, relative));
  return copiedRoot;
}
test("selected immutable source supplies its original Host class, never candidate Host fallback", async () => {
  const repoSource = ownedSourceCopy(), f = routerFixture({ count: 1, repoSource }), copiedPath = f.prepared.manifest.sourceHostModule.path;
  const candidate = require("../app/agent-service/antigravity-acp-runtime-host.js").AntigravityAcpRuntimeHost;
  const original = require(copiedPath).AntigravityAcpRuntimeHost; assert.notEqual(original, candidate);
  assert.equal(guard.sha(fs.readFileSync(copiedPath)), guard.sha(fs.readFileSync(path.join(__dirname, "../app/agent-service/antigravity-acp-runtime-host.js"))));
  const wrongClass = f.host(0); Object.setPrototypeOf(wrongClass, candidate.prototype);
  await assert.rejects(() => f.start(0, wrongClass), /SOURCE_HOST_UNBOUND/u);
  const started = await f.start(0); publishAntigravityGuardSession(f.prepared, started.receipt);
  assert.equal(cliAnswer(f.cli(0, f.input(0, "create_file", { TargetFile: path.join(f.roles[0].workspace, "sum-valid.cjs"), CodeContent: "owned-fake" }))).allowTool, true);
  // Same bytes but a changed file identity cannot become the selected Source.
  const after = routerFixture({ count: 1, repoSource }), pending = await after.start(0), bytes = fs.readFileSync(copiedPath);
  fs.chmodSync(copiedPath, 0o600); fs.unlinkSync(copiedPath); fs.writeFileSync(copiedPath, bytes, { mode: 0o400 });
  assert.throws(() => publishAntigravityGuardSession(after.prepared, pending.receipt), /FILE_CHANGED/u);
});
test("pinned official Hook metadata includes skills paths without giving them read authority", async () => {
  const f = routerFixture({ count: 1, separateGeminiHome: true }), started = await f.start(0); publishAntigravityGuardSession(f.prepared, started.receipt);
  assert.deepEqual(f.prepared.manifest.roles[0].workspacePaths, [f.roles[0].workspace, path.join(f.geminiHome, "config/skills"),
    path.join(f.roles[0].workspace, ".gemini/skills"), path.join(f.geminiHome, "antigravity-cli/skills"), path.join(f.roles[0].workspace, ".agents/skills")]);
  assert.equal(f.prepared.manifest.appDataDir, path.join(f.geminiHome, "antigravity-acp"));
  const privateSkill = path.join(f.geminiHome, "config/skills/owned-fake-private.txt"); fs.mkdirSync(path.dirname(privateSkill), { recursive: true, mode: 0o700 }); fs.writeFileSync(privateSkill, "FAKE_PRIVATE_SKILL", { mode: 0o600 });
  assert.equal(cliAnswer(f.cli(0, f.input(0, "view_file", { AbsolutePath: privateSkill }))).allowTool, false);
  const artifact = path.join(f.roles[0].workspace, "sum-valid.cjs"), valid = f.input(0, "create_file", { TargetFile: artifact, CodeContent: "owned-fake" });
  assert.equal(valid.artifactDirectoryPath, path.join(f.geminiHome, "artifacts")); assert.equal(cliAnswer(f.cli(0, valid)).allowTool, true);
  assert.equal(cliAnswer(f.cli(0, { ...valid, workspacePaths: [f.roles[0].workspace] })).allowTool, false);
});
test("later same-session exact schema identity/hash exception is captured only by trusted publisher", async () => {
  const f = routerFixture({ caseId: "source-handoff" }), started = await f.start(0), sessionId = started.session.id;
  const file = path.join(f.prepared.manifest.appDataDir, "brain", sessionId, "mcp/shoggoth/group_messages_read.json");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, '{"ownedFakeSchema":true}', { mode: 0o600 });
  publishAntigravityGuardSession(f.prepared, started.receipt, { cachedSchemas: [{ toolName: "group_messages_read", file, sha256: guard.sha(fs.readFileSync(file)) }] });
  assert.equal(cliAnswer(f.cli(0, f.input(0, "view_file", { AbsolutePath: file }))).allowTool, true);
  assert.equal(cliAnswer(f.cli(0, f.input(0, "view_file", { AbsolutePath: path.join(f.geminiHome, "synthetic-token.json") }))).allowTool, false);
  fs.appendFileSync(file, "changed"); assert.equal(cliAnswer(f.cli(0, f.input(0, "view_file", { AbsolutePath: file }))).allowTool, false);
});
test("dangling symlink target counts as existing for exact approval and cannot be artifact-write bypass", () => {
  const approval = fixture({ caseId: "approval-wait" }), target = path.join(approval.workspace, "approval-proof.txt");
  fs.symlinkSync(path.join(approval.root, "missing-personal-target"), target);
  assert.equal(cliAnswer(approval.cli(approval.input("run_command", { CommandLine: "printf '%s' 'approval-evidence-v1' > 'approval-proof.txt'", Cwd: approval.workspace }))).allowTool, false);
  const f = fixture(), artifact = path.join(f.workspace, "sum-valid.cjs"); fs.symlinkSync(path.join(f.root, "missing-personal-target"), artifact);
  assert.equal(cliAnswer(f.cli(f.input("create_file", { TargetFile: artifact, CodeContent: "owned" }))).allowTool, false);
});
