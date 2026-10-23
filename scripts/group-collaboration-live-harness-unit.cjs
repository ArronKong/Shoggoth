#!/usr/bin/env node
"use strict";
// Boundary checks for the real-provider harness; never starts a Service,
// Runtime, external dashboard, or Provider request.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const worker = require("./group-collaboration-live-worker.cjs"), matrix = require("./group-collaboration-live-matrix.cjs"), external = require("./group-collaboration-live-external.cjs"), hermesArchive = require("./group-collaboration-hermes-runtime.cjs"), policy = require("./group-collaboration-live-policy.cjs");
const root = fs.mkdtempSync(path.join("/private/tmp", "sggroup-harness-unit-")); fs.chmodSync(root, 0o700);
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const tests = [];
const test = (name, run) => tests.push({ name, run });
const rejects = (operation, code) => assert.throws(operation, error => error.code === code);
const write = (name, text, mode = 0o600) => { const file = path.join(root, name); fs.writeFileSync(file, text, { mode }); return file; };
const sourceRepo = fs.realpathSync(path.join(__dirname, ".."));
const descriptor = fs.readFileSync(path.join(__dirname, "fixtures/group-collaboration-live-evaluation.json"));
const descriptorFile = write("evaluation.json", descriptor);
const matrixOptions = { sourceVersion: "baseline", descriptor: descriptorFile, case: "user-supplement", group: "native-native", round: 2, thresholds: null };
test("worker paths and arguments are bounded before any model work", () => {
  const args = ["--sourceRepo", sourceRepo, "--runtime", "codex", "--workspace", path.join(root, "workspace"), "--output", path.join(root, "report.json")];
  assert.equal(worker.parse(args).runtime, "codex");
  rejects(() => worker.parse([...args, "--runtime", "pi"]), "GROUP_LIVE_ARGS_INVALID");
  rejects(() => worker.parse([...args, "--unknown", "x"]), "GROUP_LIVE_ARGS_INVALID");
  rejects(() => worker.parse(args.map(value => value === path.join(root, "workspace") ? root + "/../escape" : value)), "GROUP_LIVE_TEMP_PATH_REQUIRED");
  rejects(() => worker.parse(args.map(value => value === path.join(root, "report.json") ? "/Users/shared/report.json" : value)), "GROUP_LIVE_TEMP_PATH_REQUIRED");
  rejects(() => worker.parse(["--sourceRepo", sourceRepo, "--workspace", path.join(root, "work"), "--output", path.join(root, "o.json"), "--descriptor", descriptorFile]), "GROUP_LIVE_MATRIX_ARGS_INVALID");
  assert.match(worker.SOURCE_FACT, /^合成资料 S0：/u);
  assert(worker.sourcePrompt(true, 17).includes("真实序号 17"));
  assert(worker.sourcePrompt(false, 17).includes("group_task propose"));
});
test("candidate requires immutable thresholds matching the exact descriptor", () => {
  const evaluated = matrix.evaluation(matrixOptions);
  assert.equal(evaluated.roles.length, 2);
  assert(evaluated.body.includes("U1"));
  assert(!evaluated.body.includes('"U2"'));
  assert(!evaluated.body.includes(evaluated.sample.data.U2));
  const candidate = { ...matrixOptions, sourceVersion: "candidate" };
  rejects(() => matrix.evaluation(candidate), "GROUP_LIVE_CANDIDATE_THRESHOLDS_REQUIRED");
  const thresholds = { evaluationVersion: 1, descriptorSha256: sha(descriptor), baselineGit: evaluated.descriptor.sourcePolicy.baselineGit,
    baselineComplete: true, frozenBeforeCandidate: true, thresholds: { quality: "frozen-before-candidate" } };
  candidate.thresholds = write("thresholds.json", JSON.stringify(thresholds));
  assert.equal(matrix.evaluation(candidate).thresholds.data.baselineComplete, true);
  fs.writeFileSync(candidate.thresholds, JSON.stringify({ ...thresholds, descriptorSha256: "0".repeat(64) }));
  rejects(() => matrix.evaluation(candidate), "GROUP_LIVE_CANDIDATE_THRESHOLDS_INVALID");
  fs.writeFileSync(candidate.thresholds, JSON.stringify({ ...thresholds, baselineComplete: false }));
  rejects(() => matrix.evaluation(candidate), "GROUP_LIVE_CANDIDATE_THRESHOLDS_INVALID");
  rejects(() => matrix.evaluation({ ...matrixOptions, round: 0 }), "GROUP_LIVE_EVALUATION_INVALID");
  rejects(() => matrix.evaluation({ ...matrixOptions, round: 1.5 }), "GROUP_LIVE_EVALUATION_INVALID");
});
test("approval grants only the exact synthetic file write and once option", () => {
  const workspace = path.join(root, "owned-role");
  const request = { kind: "runtime_approval", runId: "owned-run", requestId: "owned-request", expiresAt: null,
    approvalDetails: { kind: "command", cwd: workspace, command: "printf '%s' 'approval-evidence-v1' > 'approval-proof.txt'" },
    approvalOptions: [{ kind: "allow_once", choice: "once" }], approvalChoices: ["once", "deny"] };
  assert.equal(matrix.exactWriteApproval(request, workspace)?.choice, "once");
  const wrapped = "/bin/zsh -c " + JSON.stringify(request.approvalDetails.command);
  assert.equal(matrix.exactWriteApproval({ ...request, approvalDetails: { ...request.approvalDetails, command: wrapped, commandActions: [{command:request.approvalDetails.command}] } }, workspace)?.nativeCommand,wrapped);
  const posixWrapped = "/bin/sh -c " + JSON.stringify(request.approvalDetails.command);
  assert.equal(matrix.exactWriteApproval({ ...request, approvalDetails: { ...request.approvalDetails, command: posixWrapped } }, workspace)?.nativeCommand,posixWrapped);
  assert.equal(matrix.exactWriteApproval({ ...request, approvalDetails: { ...request.approvalDetails, command: wrapped, commandActions: [{command:"cat /Users/private"}] } }, workspace),null);
  for(const prefix of ["/bin/bash -c ","zsh -c ","sh -c ","/bin/zsh -lc ","/bin/sh -lc "]) assert.equal(matrix.exactWriteApproval({ ...request, approvalDetails: { ...request.approvalDetails, command: prefix+JSON.stringify(request.approvalDetails.command) } }, workspace),null);
  assert.equal(matrix.exactWriteApproval({ ...request, approvalDetails: { ...request.approvalDetails, command: "/bin/zsh -c "+JSON.stringify(request.approvalDetails.command+"; true") } }, workspace),null);
  assert.equal(matrix.permission("codex","approval-wait").sandbox,"workspace-write");
  const altered = command => ({ ...request, approvalDetails: { ...request.approvalDetails, command } });
  for (const command of [
    "printf '%s' 'approval-evidence-v1' > '../approval-proof.txt'",
    "printf '%s' 'approval-evidence-v1' > 'approval-proof.txt'; rm x",
    "printf '%s' 'approval-evidence-v1' > 'approval-proof.txt' && true",
    "printf '%s' 'approval-evidence-v1' > 'approval-proof.txt'\ntrue",
    "printf '%s' 'approval-evidence-v1' > $HOME/approval-proof.txt",
    "echo approval-evidence-v1 > approval-proof.txt",
    '["sh","-c","printf %s approval-evidence-v1 > approval-proof.txt","ignored"]',
    "printf '%s' 'wrong' > 'approval-proof.txt'",
  ]) assert.equal(matrix.exactWriteApproval(altered(command), workspace), null, command);
  assert.equal(matrix.exactWriteApproval({ ...request, expiresAt: Date.now() - 1 }, workspace), null);
  assert.equal(matrix.exactWriteApproval({ ...request, approvalDetails: { ...request.approvalDetails, cwd: root } }, workspace), null);
  assert.equal(matrix.exactWriteApproval({ ...request, approvalChoices: ["always", "deny"] }, workspace), null);
});
test("artifact rubric runs isolated fixed cases and rejects host escape or looping code", () => {
  const valid = write("sum-valid.cjs", "module.exports = xs => xs.reduce((s, x) => s + (typeof x === 'number' && Number.isFinite(x) ? x : 0), 0);");
  assert.equal(matrix.artifactEvaluation(valid).status, "passed");
  assert.deepEqual(matrix.artifactEvaluation(valid).actualOutputs, [6, 0, -2]);
  for (const [name, text] of [
    ["escape.cjs", "module.exports = () => this.constructor.constructor('return process')().pid;"],
    ["require.cjs", "module.exports = () => require('node:fs').readFileSync('/etc/passwd');"],
    ["loop.cjs", "module.exports = () => { while (true) {} };"],
  ]) assert.equal(matrix.artifactEvaluation(write(name, text)).status, "failed");
  const link = path.join(root, "linked.cjs"); fs.symlinkSync(valid, link);
  assert.equal(matrix.artifactEvaluation(link).status, "unsafe");
  assert.equal(matrix.artifactEvaluation(write("large.cjs", " ".repeat(65537))).status, "unsafe");
});
test("evidence removes transport grants and credential values without converting unknown to zero", () => {
  const grant = "gt1.t.00000000-0000-0000-0000-000000000000." + "A".repeat(43);
  const safe = matrix.safeEvidence({ token: "secret", params: { api_key: "secret", body: "synthetic " + grant }, providerRequestCount: null });
  assert.equal(safe.token, "[credential-redacted]");
  assert.equal(safe.params.api_key, "[credential-redacted]");
  assert.equal(safe.params.body, "synthetic [group-grant-redacted]");
  assert.equal(safe.providerRequestCount, null);
});
test("external file reads require private regular files and reject symlinks", () => {
  const file = write("owned-auth.json", '{"providers":{}}');
  assert.equal(external.privateFile(file, 1024, true).toString(), '{"providers":{}}');
  fs.chmodSync(file, 0o644);
  rejects(() => external.privateFile(file, 1024, true), "GROUP_LIVE_EXTERNAL_AUTH_FILE_UNSAFE");
  fs.chmodSync(file, 0o600);
  const link = path.join(root, "linked-auth.json"); fs.symlinkSync(file, link);
  rejects(() => external.privateFile(link, 1024, true), "GROUP_LIVE_EXTERNAL_AUTH_FILE_UNSAFE");
  assert.deepEqual(external.selectedEntries({ api: 1, unrelated: 2 }, ["api"]), { api: 1 });
});
test("OpenClaw preserves only the selected model defaults and their full parameters", () => {
  const model = "provider/selected", entry = { alias: "chosen", streaming: false,
    params: { temperature: 0.2, maxTokens: 123, reasoningEffort: "high", nested: { enabled: true } } };
  const original = { agents: { defaults: { models: { [model]: entry, "provider/other": { params: { temperature: 0.9 } } } } } };
  const selected = external.selectedOpenclawModelDefaults(original, model);
  assert.deepEqual(selected.defaults, entry); assert.notEqual(selected.defaults, entry);
  selected.defaults.params.temperature = 0.4; assert.equal(entry.params.temperature, 0.2);
  assert.equal(selected.evidence.configured, true); assert.equal(selected.evidence.streaming, false);
  assert.equal(selected.evidence.parametersDigest, sha(JSON.stringify(entry.params)));
  const absent = external.selectedOpenclawModelDefaults(original, "provider/missing");
  assert.equal(absent.defaults, null); assert.equal(absent.evidence.configured, false); assert.deepEqual(absent.evidence.parameters, {});
  rejects(() => external.selectedOpenclawModelDefaults({ agents: { defaults: { models: { [model]: { instructions: "private" } } } } }, model), "GROUP_LIVE_OPENCLAW_MODEL_PARAMETERS_UNSUPPORTED");
  rejects(() => external.selectedOpenclawModelDefaults({ agents: { defaults: { models: { [model]: { params: [] } } } } }, model), "GROUP_LIVE_OPENCLAW_MODEL_PARAMETERS_UNSUPPORTED");
});
test("frozen Codex defaults reject extra authority and prove only the conditional SDK default", () => {
  const defaults = require("./group-collaboration-codex-defaults.cjs"), sourcePath = "/synthetic-native/config.toml";
  const projection = { model: "gpt-6-astra", model_reasoning_effort: "max", model_reasoning_summary: "detailed", model_verbosity: "medium", service_tier: "default" };
  const record = { version: 1, path: sourcePath, sha256: "a".repeat(64), projection, unlistedConfigCopied: false, realModelRequests: 0,
    providerDefaultProof: { provider: "openai", pinnedVersion: "0.159.2", path: "/private/tmp/public-proof.rs", sha256: "b".repeat(64), originalHomeConfigReadSucceeded: false } };
  const selected = defaults.validateFrozenRecord(record, { sourcePath, sdkVersion: "0.159.2" });
  assert.deepEqual(selected.projection, projection); assert.equal(selected.config.model_provider, "openai");
  assert.equal(selected.providerDefaultProof.originalHomeConfigReadSucceeded, false);
  for (const field of ["mcp_servers", "features", "model_providers", "developer_instructions", "env"]) rejects(() => defaults.safeNativeDefaults({ ...projection, [field]: {} }), "GROUP_LIVE_CODEX_DEFAULTS_INVALID");
  let accessed = false; const getter = { ...projection }; Object.defineProperty(getter, "model_provider", { enumerable: true, get() { accessed = true; return "openai"; } });
  rejects(() => defaults.safeNativeDefaults(getter), "GROUP_LIVE_CODEX_DEFAULTS_INVALID"); assert.equal(accessed, false);
  rejects(() => defaults.validateFrozenRecord({ ...record, providerDefaultProof: { ...record.providerDefaultProof, originalHomeConfigReadSucceeded: true } }, { sourcePath, sdkVersion: "0.159.2" }), "GROUP_LIVE_CODEX_PROVIDER_DEFAULT_UNPROVEN");
});
test("Codex layout binding preserves Source resolver, factory, schema and unrelated account inputs", () => {
  const publicRepo=path.join(os.homedir(),"Documents/claude/Shoggoth"),binary = require("../app/agent-service/codex-runtime-paths").resolveCodexRuntimeLayout({repoRoot:publicRepo}).runtimePath,
    calls = [], originalOptions = { repoRoot: sourceRepo, marker: "source-options" };
  const resolver = { resolve(binding, account, options) { assert.equal(this, resolver); calls.push({ binding, account, options }); return { binaryPath: binary }; } };
  const nativeAuth = { options: originalOptions, _createHost() { assert.equal(this, nativeAuth); assert.equal(this.options.marker, "source-options");
    return { options: { ...this.options }, runtimeEnvironment: { binaryPath: binary } }; } };
  const pool = { options: { nativeAuth }, runtimeAccountResolver: resolver }, service = { runtimePool: pool };
  const evidence = worker.bindOwnedCodexSdkLayout({ service, sourceRepo, selectedBinary: binary, layoutRepo: publicRepo });
  const managed = { runtime: "codex" }, account = { kind: "shoggoth-managed" }, options = { repoRoot: "/owned-archive", packaged: true, extra: "preserved" };
  resolver.resolve(managed, account, options); assert.equal(calls[0].options.repoRoot, publicRepo); assert.equal(calls[0].options.packaged, false); assert.equal(calls[0].options.extra, "preserved");
  resolver.resolve({ runtime: "deepseek-harness" }, { kind: "native-user" }, options); assert.equal(calls[1].options, options);
  const host = nativeAuth._createHost(); assert.equal(nativeAuth.options, originalOptions); assert.equal(host.options.repoRoot, sourceRepo);
  assert.equal(host.options.schemaContract.constructor.name, "CodexSchemaContract"); assert.equal(service.runtimePool, pool);
  assert.equal(evidence.sourceSchemaRetained, true); assert.equal(evidence.sourcePoolClosuresRetained, true);
});
test("Codex thread and turn gates require owned context, validated thread and same borrowed authority", async () => {
  const owned=fs.mkdtempSync("/private/tmp/sggroup-live-codex-gate-unit-"),workspace=path.join(owned,"workspace"),homes=path.join(owned,"runtime-accounts"),home=path.join(homes,"codex/internal/home");
  fs.mkdirSync(workspace,{mode:0o700});fs.mkdirSync(home,{recursive:true,mode:0o700});
  const account=require("../app/agent-service/runtime-account").SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,identity="synthetic-owned-account";
  const config={model:"gpt-6-astra",model_provider:"openai",model_reasoning_effort:"max",model_reasoning_summary:"detailed",model_verbosity:"medium",service_tier:"default"};
  const defaults={config,projection:{...config},sourceConfigSha256:"a".repeat(64),providerDefaultProof:{originalHomeConfigReadSucceeded:false}},profile={id:"owned",runtime:"codex",runtimeProfileId:"owned-runtime",runtimeAccountId:account,defaultCwd:workspace};
  let options,model="gpt-6-astra",sources=[],authSource="native-codex",rawTurns=0;
  const host={nativeAccountId:identity,async threadStart(params){return{thread:{id:"verified-thread",cwd:workspace},model,modelProvider:"openai",instructionSources:sources,activePermissionProfile:{id:params.config.default_permissions,extends:null},approvalPolicy:"on-request"};},async threadResume(params){return this.threadStart(params);},
    async configRead(params){assert.deepEqual(params,{includeLayers:false,cwd:workspace});return{config};},async experimentalFeatureList(){return{data:[{name:"shell_tool",enabled:false},{name:"unified_exec",enabled:false},{name:"skip_host_skill_discovery",enabled:true},{name:"code_mode_host",enabled:true},{name:"multi_agent_v2",enabled:false}],nextCursor:null};},
    async mcpServerStatusList(){return{data:[{name:"shoggoth",runtimeStatus:"ready",tools:Object.fromEntries(["group_member_role_read","group_messages_read"].map(name=>[name,{name}]))}],nextCursor:null};},
    async accountRead(params){assert.deepEqual(params,{refreshToken:false});return{authSource,account:{type:"chatgpt"}};},async turnStart(params){rawTurns++;return params;}};
  const pool={paths:{runtimeAccountsDir:homes},hostFactory(input){assert.equal(this,pool);options=input;return host;}},result={codexAuthority:{accountIdentitySha256:sha(identity)}};
  try{
    worker.installOwnedNativeToolPolicies({service:{runtimePool:pool},root:owned,profiles:[profile],sourceRepo,caseId:"simple-fact",result,codexDefaults:defaults});
    pool.hostFactory({runtimeProfileId:profile.runtimeProfileId,runtimeEnvironment:{strategy:"managed-shared",home,runtimeAccountId:account},prepareRuntime:async()=>({configArgs:[]})});
    await options.prepareRuntime({codexHome:home});const request={cwd:workspace,model:config.model,approvalPolicy:"on-request",sandbox:"read-only"};
    assert.deepEqual(result.toolEnvironment.runtimes[0].groupTools,["group_member_role_read","group_messages_read"],"owned overlays use the current model-visible group catalog, without retired tools");
    sources=["/Users/private/AGENTS.md"];await assert.rejects(()=>host.threadStart(request),e=>e.code==="GROUP_LIVE_CODEX_PRIVATE_INSTRUCTION_SOURCE_UNPROVEN");sources=[];
    authSource="api-key";await assert.rejects(()=>host.threadStart(request),e=>e.code==="GROUP_LIVE_CODEX_BORROWED_AUTH_UNPROVEN");authSource="native-codex";
    await host.threadStart(request);
    const turn={threadId:"verified-thread",cwd:workspace,model:config.model,input:[]};
    await assert.rejects(()=>host.turnStart({...turn,threadId:"unknown-thread"}),e=>e.code==="GROUP_LIVE_CODEX_FROZEN_TURN_PARAMETERS_MISMATCH");
    await assert.rejects(()=>host.turnStart({...turn,effort:"low"}),e=>e.code==="GROUP_LIVE_CODEX_FROZEN_TURN_PARAMETERS_MISMATCH");
    host.nativeAccountId="different-account";await assert.rejects(()=>host.turnStart(turn),e=>e.code==="GROUP_LIVE_CODEX_BORROWED_AUTH_UNPROVEN");host.nativeAccountId=identity;assert.equal(rawTurns,0);
    const actual=await host.turnStart(turn);assert.equal(actual.effort,"max");assert.equal(actual.serviceTier,"default");assert.equal(rawTurns,1);
    model="wrong-model";await assert.rejects(()=>host.threadStart(request),e=>e.code==="GROUP_LIVE_CODEX_FROZEN_THREAD_RESPONSE_UNPROVEN");
    await assert.rejects(()=>host.turnStart(turn),e=>e.code==="GROUP_LIVE_CODEX_FROZEN_TURN_PARAMETERS_MISMATCH");assert.equal(rawTurns,1);
  }finally{fs.rmSync(owned,{recursive:true,force:true});}
});
test("approval proof must be absent before the bound request and newly created with exact bytes", () => {
  const file = path.join(root, "approval-proof.txt"), absent = matrix.assertApprovalTargetAbsent(file);
  assert.equal(absent.absent, true);
  const trigger = { targetPath: file, targetBeforeApproval: absent, runId: "owned-run", requestId: "owned-request", respondedAt: absent.observedAt };
  assert.equal(matrix.approvalWriteObservation(trigger).availability, "missing");
  fs.writeFileSync(file, "approval-evidence-v1", { mode: 0o600 });
  const proof = matrix.approvalWriteObservation(trigger); assert.equal(proof.newlyCreated, true); assert.equal(proof.runId, "owned-run"); assert.equal(proof.requestId, "owned-request");
  rejects(() => matrix.assertApprovalTargetAbsent(file), "GROUP_LIVE_APPROVAL_TARGET_ALREADY_EXISTS");
  fs.writeFileSync(file, "wrong", { mode: 0o600 }); assert.equal(matrix.approvalWriteObservation(trigger).newlyCreated, false);
});
test("Runtime observer preserves handle, method identity, receiver and responses", async () => {
  const response = { session: { id: "owned-session", cwd: "/owned/role", model: "test-model", sandbox: "read-only" } };
  const handle = { runtime: "codex", runtimeProfileId: "owned-profile", runtimeAccountId: "native-account", stable: 3,
    async sessionStart(params) { assert.equal(this, handle); assert.equal(params.cwd, "/owned/role"); return response; },
    state() { assert.equal(this, handle); return this.stable; } };
  const manager = { async acquire() { assert.equal(this, manager); return handle; } }, service = { runtimeManager: manager }, result = {};
  const restore = matrix.observeRuntime(service, result);
  const first = await manager.acquire(), second = await manager.acquire();
  assert.equal(first, second); assert.equal(first.sessionStart, second.sessionStart);
  assert.equal(first.state, second.state); assert.equal(first.state(), 3);
  assert.equal("stable" in first, true); assert(Object.keys(first).includes("stable"));
  assert.equal(await first.sessionStart({ cwd: "/owned/role", model: "requested-model" }), response);
  assert.equal(result.runtimeOperationEvidence.length, 1);
  assert.equal(result.runtimeOperationEvidence[0].requested.cwd, "/owned/role");
  assert.equal(result.runtimeOperationEvidence[0].session.model, "test-model");
  assert.equal(result.runtimeOperationEvidence[0].session.sandbox, "read-only");
  restore(); assert.equal(await manager.acquire(), handle);
});
test("Antigravity keeps source verifier and owned ledger paths while reading the installed release", async () => {
  const server = write("verified-server.par", "fixture-server"), harness = write("verified-harness.par", "fixture-harness");
  const paths = { stateDir: "/owned-state" }, installedPaths = { stateDir: "/existing-installed-state" }, pool = { options: {} }, calls = [];
  const verified = { version: "1.2.1", serverPath: server, harnessPath: harness };
  const verifyServer = async input => { calls.push(input); assert.equal(input.paths, installedPaths); return verified; };
  const evidence = await worker.bindInstalledAntigravityVerifier({ service: { antigravityRuntimePool: pool }, paths, installedPaths, selectedBinary: server, verifyServer });
  assert.equal(evidence.executionAndLedgerPathsRemainOwned, true);
  assert.equal(evidence.serverSha256, sha("fixture-server"));
  assert.equal(await pool.options.verifyServer({ paths, fs, extra: "unchanged-source-input" }), verified);
  assert.equal(calls[1].extra, "unchanged-source-input"); assert.equal(calls[1].fs, fs);
  await assert.rejects(() => pool.options.verifyServer({ paths: installedPaths }), error => error.code === "GROUP_LIVE_ANTIGRAVITY_OWNED_PATHS_MISMATCH");
  await assert.rejects(() => worker.bindInstalledAntigravityVerifier({ service: { antigravityRuntimePool: { options: {} } }, paths, installedPaths,
    selectedBinary: harness, verifyServer }), error => error.code === "GROUP_LIVE_ANTIGRAVITY_VERIFIED_BINARY_MISMATCH");
});
test("shared Hermes Runtime snapshot rejects unknown roots, private paths and forged metadata before startup", () => {
  for (const relative of [".env", "auth.json", "SOUL.md", "USER.md", "../escape.py", "/absolute.py", "app/../escape.py", ".hermes/bin/hermes", ".venv/lib/site.py"])
    assert.equal(hermesArchive.relativeSafe(relative), false, relative);
  assert.equal(hermesArchive.relativeSafe("application/hermes_cli/main.py"), true);
  rejects(() => hermesArchive.loadArchive(undefined), "GROUP_LIVE_HERMES_ARCHIVE_ROOT_INVALID");
  rejects(() => hermesArchive.loadArchive(root), "GROUP_LIVE_HERMES_ARCHIVE_ROOT_INVALID");
  const owned = fs.mkdtempSync("/private/tmp/sggroup-hermes-runtime-unit-"); fs.chmodSync(owned, 0o700);
  try {
    fs.writeFileSync(path.join(owned, ".group-collaboration-owned-hermes-runtime.json"), JSON.stringify({ version: 1, owner: "someone-else" }), { mode: 0o400 });
    rejects(() => hermesArchive.loadArchive(owned), "GROUP_LIVE_HERMES_ARCHIVE_METADATA_INVALID");
  } finally { fs.rmSync(owned, { recursive: true, force: true }); }
});
test("Hermes archive inventory rejects extra shadow modules and changed directory or executable modes", () => {
  const owned = fs.mkdtempSync("/private/tmp/sggroup-hermes-runtime-unit-"); fs.chmodSync(owned, 0o700);
  const app = path.join(owned, "application"), fingerprints = { "application/main.py": sha("pass"), "entry.py": sha("pass"), hermes: sha("pass") },
    fileModes = { "application/main.py": 0o400, "entry.py": 0o400, hermes: 0o500 };
  fs.mkdirSync(app, { mode: 0o700 });
  for (const [relative, mode] of Object.entries(fileModes)) fs.writeFileSync(path.join(owned, relative), "pass", { mode });
  const marker = { version: 1, owner: "group-collaboration-live-evaluation", sourceCommit: "0".repeat(40), application: app,
    entry: path.join(owned, "entry.py"), launcher: path.join(owned, "hermes"), preparedByInvokingInstallOrModel: false,
    readOnlyRuntimeFileModes: true, fingerprints, fileModes, archiveDigest: sha(JSON.stringify({ fingerprints, fileModes })) };
  fs.writeFileSync(path.join(owned, ".group-collaboration-owned-hermes-runtime.json"), JSON.stringify(marker), { mode: 0o400 });
  const extra = path.join(app, "shadow.py"); fs.writeFileSync(extra, "pass", { mode: 0o400 }); fs.chmodSync(app, 0o500); fs.chmodSync(owned, 0o500);
  try {
    rejects(() => hermesArchive.loadArchive(owned), "GROUP_LIVE_HERMES_ARCHIVE_INVENTORY_CHANGED");
    fs.chmodSync(app, 0o700); fs.unlinkSync(extra);
    rejects(() => hermesArchive.loadArchive(owned), "GROUP_LIVE_HERMES_ARCHIVE_PERMISSIONS_CHANGED");
    fs.chmodSync(app, 0o500); fs.chmodSync(path.join(owned, "hermes"), 0o400);
    rejects(() => hermesArchive.loadArchive(owned), "GROUP_LIVE_HERMES_ARCHIVE_PERMISSIONS_CHANGED");
  } finally { fs.chmodSync(owned, 0o700); fs.chmodSync(app, 0o700); fs.rmSync(owned, { recursive: true, force: true }); }
});
test("source finalization records changed revisions and unavailable observations truthfully", () => {
  const before = { repo: "/owned/source", gitSha: "a".repeat(40), sourceKind: "git-checkout", sourceDigest: "b".repeat(64), dirty: true }, result = {};
  worker.observeFrozenSource(result, before, () => ({ ...before }));
  assert.equal(result.sourceUnchanged, true); assert.equal(result.sourceRevisionUnchanged, true);
  worker.observeFrozenSource(result, before, () => ({ ...before, gitSha: "c".repeat(40) }));
  assert.equal(result.sourceBytesUnchanged, true); assert.equal(result.sourceRevisionUnchanged, false); assert.equal(result.sourceUnchanged, false);
  worker.observeFrozenSource(result, before, () => { throw Object.assign(new Error("changed snapshot"), { code: "GROUP_LIVE_SNAPSHOT_SOURCE_CHANGED" }); });
  assert.equal(result.sourceUnchanged, null); assert.equal(result.sourceAfter.unavailable, true);
  assert.equal(result.sourceAfter.code, "GROUP_LIVE_SNAPSHOT_SOURCE_CHANGED");
});
test("external observations reject default and mismatched sessions and deduplicate exact Host bindings", async () => {
  const member = { backendId: "hermes", agentId: "owned-agent", workspace: "/private/tmp/owned-role" }, groupId = "owned-group", key = "agent:owned-agent:stored-session";
  const record = (id, prompt, summary) => { const identity = { executionId: id, runId: "run-" + id, backendId: member.backendId, agentId: member.agentId },
    binding = { sessionKey: key, workspace: member.workspace, mode: "gateway" };
    return { identity, groupId, binding, snapshot: { ...identity, ...binding, status: "completed", sequence: 4 },
      startInput: { ...identity, ...binding, prompt }, resultDigest: sha(summary) }; };
  const first = record("one", "input-one", "result-one"), second = record("two", "input-two", "result-two");
  const unrelated = { ...first, groupId: "different-group" }, main = { ...first, binding: { ...first.binding, sessionKey: "agent:owned-agent:main" } },
    spoof = { ...first, snapshot: { ...first.snapshot, runId: "spoofed" } };
  const selection = external.selectHostExecutions([first, second, unrelated, main, spoof], member, groupId);
  assert.equal(selection.executions.length, 2); assert.equal(selection.rejected.length, 2);
  rejects(() => external.selectHostExecutions([first], member, null), "GROUP_LIVE_EXTERNAL_OBSERVATION_SCOPE_REQUIRED");
  const host = { agent: member, db: { prepare(sql) { assert.equal(sql, "SELECT data FROM executions ORDER BY rowid"); return { all: () => [first, second, main].map(row => ({ data: JSON.stringify(row) })) }; } } }, calls = [];
  const messages = [{ role: "user", content: "input-one" }, { role: "assistant", content: "result-one", model: "actual-message-model" },
    { role: "user", content: "input-two" }, { role: "assistant", content: "result-two" }];
  const backend = { _sessionTarget(got) { assert.equal(got, key); return { agentId: member.agentId, tail: "stored-session", profile: "default", dash: { baseUrl: "http://127.0.0.1:1", token: "never-export" } }; },
    gwRuntimeByKey: new Map([[key, { runtimeId: "runtime-session", storedId: "stored-session", profile: "default" }]]),
    gwUsageByKey: new Map([[key, { input: 17, output: 2 }]]),
    async _httpGetJson(url, token) { assert.equal(token, "never-export"); calls.push(url);
      return url.includes("/messages?") ? { status: 200, json: { session_id: "stored-session", profile: "default", messages } }
        : { status: 200, json: { id: "stored-session", profile: "default", model: "actual-session-model", input_tokens: 17, output_tokens: 2,
          model_config: JSON.stringify({ provider: "actual-provider", model: "actual-session-model", api_key: "never-export" }) } }; } };
  const observed = await external.collectBoundSessions({ backend, host, member, groupId });
  assert.equal(observed.sessions.length, 1); assert.equal(calls.length, 2); assert.equal(observed.sessions[0].executions.length, 2);
  assert.equal(observed.sessions[0].model, "actual-session-model"); assert.equal(observed.sessions[0].rawRuntimeSession.input_tokens, 17);
  assert.equal(observed.sessions[0].rawRuntimeSession.modelConfig.api_key, undefined);
  assert.equal(observed.sessions[0].providerRequestCount, null); assert.equal(observed.sessions[0].rawProviderUsage, null);
  assert.equal(observed.sessions[0].history.bindings[0].effectiveModel, "actual-message-model");
  assert.equal(observed.sessions[0].history.bindings[1].effectiveModel, null);
  assert.equal(observed.sessions[0].history.bindings[1].uniqueInputResultPair, true);
  assert(observed.sessions[0].usageScope.includes("never-sum"));
  backend.gwRuntimeByKey.set(key, { storedId: "another-session" });
  const mismatch = await external.collectBoundSessions({ backend, host, member, groupId });
  assert.equal(mismatch.sessions[0].observationErrorCode, "GROUP_LIVE_EXTERNAL_SESSION_LINEAGE_MISMATCH"); assert.equal(calls.length, 2);
});
test("OpenClaw observations request the exact instance and never substitute a default row", async () => {
  const member = { backendId: "openclaw", agentId: "main", workspace: "/private/tmp/owned-claw" }, groupId = "claw-group", key = "agent:main:owned-new-session",
    identity = { executionId: "claw-exec", runId: "claw-run", backendId: "openclaw", agentId: "main" }, binding = { sessionKey: key, workspace: member.workspace, mode: "gateway" },
    record = { identity, groupId, binding, snapshot: { ...identity, ...binding, status: "completed" }, startInput: { ...identity, ...binding, prompt: "claw-input" }, resultDigest: sha("claw-result") },
    host = { agent: member, db: { prepare: () => ({ all: () => [{ data: JSON.stringify(record) }] }) } }, calls = [],
    backend = { async request(method, params) { calls.push({ method, params });
      if (method === "sessions.usage") return { sessions: [{ key: "agent:main:main", usage: { totalTokens: 999 } }, { key, usage: { totalTokens: 9 } }] };
      if (method === "sessions.list") return { sessions: [{ key: "agent:main:main", model: "wrong-default" }] };
      if (method === "chat.history") return { sessionKey: key, messages: [{ role: "user", content: "claw-input" }, { role: "assistant", content: "claw-result" }] };
      throw new Error("unexpected RPC"); } };
  const observed = await external.collectBoundSessions({ backend, host, member, groupId }), session = observed.sessions[0];
  assert.deepEqual(calls[0], { method: "sessions.usage", params: { key, agentId: "main", groupBy: "instance", limit: 1 } });
  assert.equal(calls[1].params.search, key); assert.equal(calls[2].params.sessionKey, key);
  assert.equal(session.rawSessionsUsage.session.usage.totalTokens, 9); assert.equal(session.model, null);
  assert.equal(session.rawRuntimeSession, null); assert.equal(session.history.bindings[0].uniqueInputResultPair, true);
});
test("supplemental Hermes evidence reads only owned execution-bound SQLite rows", () => {
  const owned = fs.mkdtempSync("/private/tmp/sggroup-live-offline-unit-"); fs.chmodSync(owned, 0o700);
  const directories = ["external", "external/hermes", "external/host-hermes"];
  for (const relative of directories) fs.mkdirSync(path.join(owned, relative), { mode: 0o700 });
  const member = { backendId: "hermes", agentId: "hermes-default", workspace: "/private/tmp/owned-supplement-role" },
    groupId = "supplement-group", key = "agent:hermes-default:owned-native-session", identity = { executionId: "owned-exec", runId: "owned-run", backendId: "hermes", agentId: "hermes-default" },
    binding = { sessionKey: key, workspace: member.workspace, mode: "gateway" },
    record = { identity, groupId, binding, snapshot: { ...identity, ...binding, status: "completed" }, startInput: { ...identity, ...binding, prompt: "owned-input" }, resultDigest: sha("owned-result") };
  const job = { version: 1, root: owned, configs: { hermes: { state: path.join(owned, "external/hermes") } }, members: [member] };
  fs.writeFileSync(path.join(owned, "external/bridge-job.json"), JSON.stringify(job), { mode: 0o600 });
  const { DatabaseSync } = require("node:sqlite"), hostFile = path.join(owned, "external/host-hermes/group-host.sqlite"), nativeFile = path.join(owned, "external/hermes/state.db"),
    host = new DatabaseSync(hostFile), native = new DatabaseSync(nativeFile);
  try {
    host.exec("CREATE TABLE executions(data TEXT)"); host.prepare("INSERT INTO executions VALUES(?)").run(JSON.stringify(record));
    native.exec("CREATE TABLE sessions(id TEXT,profile_name TEXT,model TEXT,cwd TEXT,input_tokens INTEGER,model_config TEXT); CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,finish_reason TEXT); CREATE TABLE session_model_usage(session_id TEXT,model TEXT,task TEXT,input_tokens INTEGER);");
    native.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?)").run("owned-native-session", "default", "owned-model", member.workspace, 7, '{"model":"owned-model","api_key":"do-not-store"}');
    native.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?)").run("main", "default", "wrong-main-model", member.workspace, 999, "{}");
    native.prepare("INSERT INTO messages VALUES(?,?,?,?,?)").run(1, "owned-native-session", "user", "owned-input", null);
    native.prepare("INSERT INTO messages VALUES(?,?,?,?,?)").run(2, "owned-native-session", "assistant", "owned-result", "stop");
    native.prepare("INSERT INTO session_model_usage VALUES(?,?,?,?)").run("owned-native-session", "owned-model", "", 7);
    native.prepare("INSERT INTO session_model_usage VALUES(?,?,?,?)").run("owned-native-session", "owned-model", "title_generation", 2);
    const evidence = external.observeOwnedHermesRoot(owned, groupId), session = evidence.sessions[0];
    assert.equal(evidence.providerCallsDuringObservation, 0); assert.equal(evidence.providerRequestCount, null);
    assert.equal(session.model, "owned-model"); assert.equal(session.rawRuntimeSession.input_tokens, 7);
    assert.equal(session.primaryTaskUsage[0].input_tokens, 7); assert.equal(session.auxiliaryTaskUsage[0].input_tokens, 2);
    assert.equal(session.history.bindings[0].uniqueInputResultPair, true); assert.equal(session.history.bindings[0].effectiveModel, null);
    assert.equal(session.rawRuntimeSession.modelConfig.api_key, undefined);
    assert.equal(external.observeOwnedHermesRoot(owned, "different-group").sessions.length, 0);
    native.prepare("UPDATE sessions SET cwd=? WHERE id=?").run("/Users/private", "owned-native-session");
    assert.equal(external.observeOwnedHermesRoot(owned, groupId).sessions[0].observationErrorCode, "GROUP_LIVE_EXTERNAL_SESSION_METADATA_MISMATCH");
  } finally { native.close(); host.close(); fs.rmSync(owned, { recursive: true, force: true }); }
  rejects(() => external.observeOwnedHermesRoot("/Users/private", groupId), "GROUP_LIVE_EXTERNAL_ROOT_INVALID");
});
test("external tool evidence preserves real failed requests and scrubs group authority", () => {
  const grant = "gt1.t.00000000-0000-0000-0000-000000000000." + "A".repeat(43), key = "owned-call";
  const history = external.historyEvidence([{ role: "assistant", tool_calls: JSON.stringify([{ id: key, function: { name: "group_messages_read", arguments: JSON.stringify({ sourceId: "wrong-source", groupToken: grant }) } }]) },
    { role: "tool", tool_call_id: key, tool_name: "group_messages_read", content: '{"error":"GROUP_HOST_TOOL_INVALID"}' }], []);
  assert.equal(history.actualToolCallCount, 1); assert.equal(history.actualToolCalls[0].name, "group_messages_read");
  assert.equal(history.actualToolCalls[0].resultIndex, 1); assert.deepEqual(history.actualToolCalls[0].errorCodes, ["GROUP_HOST_TOOL_INVALID"]);
  assert(history.actualToolCalls[0].arguments.includes("[group-grant-redacted]"));
  assert(history.actualToolCalls[0].arguments.includes("wrong-source"));
  assert.equal(history.trajectory[1].toolName, "group_messages_read");
});
test("external stop requires captured Hermes children and fails closed for live or unverified process groups", async () => {
  const { EventEmitter } = require("node:events"), proc = new EventEmitter();
  Object.assign(proc, { pid: 12345, exitCode: null, signalCode: null, kill() {} });
  const identity = { availability: "present", pid: proc.pid, parentPid: 2, processGroupId: proc.pid, startedAt: "fixed", commandDigest: "a".repeat(64) },
    backend = { dashboards: new Map([["default", { spawned: true, proc }]]), _pendingDashboardProcs: new Set([proc]), acpClients: new Map() },
    registry = { getBackend: () => backend }, members = [{ backendId: "hermes", agentId: "hermes-default" }];
  let records = external.captureOwnedProcesses({ registry, members, ownedProcesses: [], identify: () => identity });
  assert.equal(records.length, 1); assert.equal(records[0].kind, "owned-hermes-pending-dashboard");
  proc.exitCode = 0; proc.emit("exit", 0); proc.emit("close", 0);
  let proof = await external.verifyOwnedProcessesStopped(records, { identify: () => ({ availability: "absent", pid: proc.pid }), isGroupAlive: () => true, timeoutMs: 1 });
  assert.equal(proof.stopped, false); assert.equal(proof.processEvidence[0].exitObserved, true); assert.equal(proof.processEvidence[0].detachedGroupAlive, true);
  records = external.captureOwnedProcesses({ registry, members, ownedProcesses: [], identify: () => identity });
  proof = await external.verifyOwnedProcessesStopped(records, { identify: () => ({ availability: "absent", pid: proc.pid }), isGroupAlive: () => false, timeoutMs: 1 });
  assert.equal(proof.stopped, false); assert.equal(proof.processEvidence[0].closeObserved, false);
  backend.dashboards.set("default", { spawned: false, proc: null }); backend._pendingDashboardProcs.clear();
  records = external.captureOwnedProcesses({ registry, members, ownedProcesses: [], identify: () => identity });
  proof = await external.verifyOwnedProcessesStopped(records, { identify: () => ({ availability: "absent", pid: null }), timeoutMs: 1 });
  assert.equal(proof.stopped, false); assert.equal(proof.processEvidence[0].ownershipUnverified, true);
  assert.equal(external.processIdentity(1).availability, "unavailable");
});
test("actual owned child exit and OS absence provide stop proof without a global kill", async () => {
  const { spawn } = require("node:child_process"), proc = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  await new Promise((resolve, reject) => { proc.once("spawn", resolve); proc.once("error", reject); });
  const captured = external.captureOwnedProcesses({ registry: { getBackend: () => null }, members: [], ownedProcesses: [proc] });
  try {
    assert.equal(captured[0].before.availability, "present");
    proc.kill("SIGTERM");
    const proof = await external.verifyOwnedProcessesStopped(captured, { timeoutMs: 2000 });
    assert.equal(proof.stopped, true); assert.equal(proof.processEvidence[0].after.availability, "absent");
    assert.equal(proof.processEvidence[0].exitObserved, true); assert.equal(proof.processEvidence[0].closeObserved, true);
  } finally { if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM"); }
});
test("frozen owned tool policy rejects paths, symlinks, unknown tools and malformed runtime evidence", () => {
  const owned = fs.mkdtempSync("/private/tmp/sggroup-live-policy-unit-"); fs.chmodSync(owned, 0o700);
  const workspace = path.join(owned, "workspace"); fs.mkdirSync(workspace, { mode: 0o700 });
  const outside = path.join(owned, "outside.txt"); fs.writeFileSync(outside, "synthetic-canary", { mode: 0o600 });
  fs.symlinkSync(outside, path.join(workspace, "alias.txt"));
  const groupTools = ["group_member_role_read", "group_messages_read", "group_task"];
  try {
    const prepared = policy.preparePolicy({ root: owned, workspace, readRoots: [workspace], runtime: "hermes", caseId: "implementation-review", groupTools });
    assert.equal(policy.loadPolicy(prepared.file).digest, prepared.sha256);
    const testCall = (name, args, cwd = workspace) => policy.decide(prepared.policy, { name, arguments: args, cwd });
    assert.equal(testCall("mcp__shoggoth_group__group_messages_read", { messageSeq: 1, offset: 0 }), undefined);
    assert.equal(testCall("write_file", { path: "sum-valid.cjs", content: "module.exports=()=>0" }), undefined);
    assert.equal(testCall("write_file", { path: "package.json", content: "{}" }), "GROUP_LIVE_FILE_NOT_FROZEN_ARTIFACT");
    for (const target of [outside, "alias.txt", "../outside.txt", "file:///Users/private"]) {
      assert.equal(testCall("read_file", { path: target }), "GROUP_LIVE_FILE_PATH_OUTSIDE_OWNED_WORKSPACE");
    }
    for (const [name, args] of [["patch", { path: "sum-valid.cjs", mode: "v4a", patch: "unsafe" }],
      ["terminal", { command: "cat /Users/private" }], ["run_code", { code: "unknown" }], ["mcp__other__read_private", {}]]) {
      assert.equal(testCall(name, args), "GROUP_LIVE_TOOL_OR_FIELDS_OUTSIDE_FROZEN_SCOPE");
    }
    assert.equal(testCall("search_files", { path: ".", pattern: ".*" }), "GROUP_LIVE_SEARCH_ESCAPE_OR_UNVERIFIED_TREE");
    assert.equal(testCall("write_file", { path: "sum-valid.cjs", content: "safe" }, owned), "GROUP_LIVE_TOOL_CONTEXT_UNBOUND");
    const hook = policy.writeHermesHook({ root: owned, prepared, nodePath: process.execPath }), child = require("node:child_process");
    child.execFileSync(process.execPath, ["--check", hook.hook]);
    const stdin = { hook_event_name: "pre_tool_call", tool_name: "read_file", tool_input: { path: outside }, session_id: "own", cwd: workspace };
    const denied = JSON.parse(child.execFileSync(process.execPath, [hook.hook], { input: JSON.stringify(stdin) }));
    assert.equal(denied.action, "block");
    try { child.execFileSync(process.execPath, [hook.hook], { input: JSON.stringify({ ...stdin, cwd: owned }) }); assert.fail("unbound hook cwd accepted"); }
    catch (error) { assert.equal(error.status, 2); assert.equal(JSON.parse(error.stdout).action, "block"); }
    const plugin = policy.writeDeepSeekPlugin({ root: owned, prepared }); child.execFileSync(process.execPath, ["--check", plugin.plugin]);
    assert(policy.exactApprovalCommand("printf '%s' 'approval-evidence-v1' > 'approval-proof.txt'", workspace));
    assert(!policy.exactApprovalCommand("printf '%s' 'approval-evidence-v1' > 'approval-proof.txt'; cat /Users/private", workspace));
    const malformed = external.historyEvidence([{ role: "assistant", tool_calls: "{bad-json" }], []);
    assert.equal(malformed.actualToolCallCount, null); assert.equal(malformed.fullHistory, false);
    assert.equal(malformed.historyAvailability, "partial-malformed-native-tool-calls");
    const dsh = { ...prepared.policy, runtime: "deepseek-harness", caseId: "approval-wait" };
    assert.equal(policy.decide(dsh, { name: "bash", cwd: workspace, arguments: {
      command: "printf '%s' 'approval-evidence-v1' > 'approval-proof.txt'", description: "Create exact synthetic approval evidence", timeoutMs: 1000 } }), undefined);
  } finally { fs.rmSync(owned, { recursive: true, force: true }); }
});
test("native observer preserves actual factory and spawn receivers and requires OS stop proof", async () => {
  const EventEmitter = require("node:events"), proc = new EventEmitter(); proc.pid = 12345; proc.exitCode = null;
  const host = { spawnProcess(file, args, options) { assert.equal(this, host); return proc; } };
  const pool = { hostFactory(options) { assert.equal(this, pool); assert.equal(options.runtimeProfileId, "owned"); return host; } };
  const before = { availability: "present", pid: 12345, parentPid: 2, processGroupId: 12345, startedAt: "owned", commandDigest: "a" }, result = {};
  const observer = worker.observeOwnedNativeProcesses({ service: { deepSeekHarnessRuntimePool: pool }, profiles: [{ runtime: "deepseek-harness", runtimeProfileId: "owned" }], result, identify: () => before });
  assert.equal(pool.hostFactory({ runtimeProfileId: "owned" }), host);
  assert.equal(host.spawnProcess("owned", [], { detached: true }), proc);
  assert.equal(observer.snapshot()[0].detachedGroup, true);
  proc.exitCode = 0; proc.emit("exit", 0, null); proc.emit("close", 0, null);
  assert.equal((await observer.finish({ identify: () => ({ availability: "absent", pid: 12345 }), isGroupAlive: () => false, timeoutMs: 10 })).stopped, true);
});
test("Codex observer includes the unchanged native authority reader and forbids thread or model RPC", async () => {
  const EventEmitter = require("node:events"), proc = new EventEmitter(); Object.assign(proc, { pid: 12346, exitCode: null });
  const wire = [], tokens = { accessToken: "synthetic-native-token-never-exported", chatgptAccountId: "synthetic-account", expiresAt: Date.now() + 60000 };
  const authHost = { options: { nativeAuthSource: true }, spawnProcess() { assert.equal(this, authHost); return proc; }, async initialize() { assert.equal(this, authHost); },
    rpc: { request(method) { assert.equal(this, authHost.rpc); wire.push(method); return { same: true }; } } };
  const nativeAuth = { _createHost() { assert.equal(this, nativeAuth); return authHost; }, async read() {
    assert.equal(this, nativeAuth); const host = this._createHost(); host.spawnProcess("owned", [], {}); await host.initialize();
    host.rpc.request("account/read", { refreshToken: false }); host.rpc.request("getAuthStatus", { refreshToken: false }); return tokens;
  } };
  const pool = { options: { nativeAuth }, hostFactory() { return { spawnProcess() {} }; } }, result = {};
  const observer = worker.observeOwnedNativeProcesses({ service: { runtimePool: pool }, profiles: [{ runtime: "codex", runtimeProfileId: "owned" }], result,
    identify: pid => ({ availability: "present", pid, parentPid: 2, processGroupId: pid, startedAt: "owned", commandDigest: "a" }) });
  assert.equal(await nativeAuth.read({ refreshToken: false }), tokens);
  rejects(() => authHost.rpc.request("turn/start", {}), "GROUP_LIVE_CODEX_NATIVE_AUTH_METHOD_FORBIDDEN"); assert.deepEqual(wire, ["account/read", "getAuthStatus"]);
  assert.equal(result.codexAuthority.accountIdentitySha256, sha(tokens.chatgptAccountId)); assert(!JSON.stringify(result).includes(tokens.accessToken));
  assert.equal(observer.snapshot()[0].kind, "owned-native-codex-auth-reader");
  proc.exitCode = 0; proc.emit("exit", 0, null); proc.emit("close", 0, null);
  assert.equal((await observer.finish({ identify: pid => ({ availability: "absent", pid }), isGroupAlive: () => false, timeoutMs: 10 })).stopped, true);
});
test("generated native helper uses official gate relay and transparently filters only inventory", () => {
  const helperRoot = fs.mkdtempSync("/private/tmp/sggroup-live-helper-unit-"); fs.chmodSync(helperRoot, 0o700);
  try { const file = worker.writeHelper(helperRoot, sourceRepo), source = fs.readFileSync(file, "utf8");
    require("node:child_process").execFileSync(process.execPath, ["--check", file]);
    assert(source.includes("bootstrap.main(process.argv.slice(1),process.env"));
    assert(source.includes("relay.startRuntimeMcpRelay({...bridge,input,output})"));
    assert(source.includes("const paths=resolveServicePaths({homeDir:root})"));
    assert(!source.includes("parent:{")); assert(!source.includes("ancestor:{"));
    assert(source.includes('catalogFilter="transparent-response-inventory-group-tools-only;definitions-preserved"'));
    assert(source.includes("originalInventoryDigest")); assert(source.includes("frame.result.tools=original.filter"));
    assert(source.includes("return startShoggothMcpHelper"));
    assert.equal(source.includes('bindRuntimeCalls:false'), false);
    const mark = 'JSON.stringify(entry)+', at = source.indexOf(mark) + mark.length;
    assert.deepEqual([...source.slice(at, at + 4)].map(char => char.charCodeAt(0)), [34, 92, 110, 34]);
  } finally { fs.rmSync(helperRoot, { recursive: true, force: true }); }
});
test("evidence checkpoints survive a pending stop and preserve the original failure", async () => {
  const output = path.join(root, "pending-stop.json"), result = { status: "failed", errorCode: "GROUP_LIVE_TERMINAL_CHAIN_MISSING",
    serviceStopped: null, providerCalls: null, token: "do-not-store" };
  const checkpoint = worker.writeEvidenceCheckpoint(output, result, matrix.safeEvidence);
  const saved = JSON.parse(fs.readFileSync(checkpoint, "utf8"));
  assert.equal(saved.errorCode, result.errorCode); assert.equal(saved.providerCalls, null);
  assert.equal(saved.token, "[credential-redacted]"); assert.equal(saved.checkpoint.finalReport, false);
  const stopped = await worker.boundedStop(() => new Promise(() => {}), 20);
  assert.equal(stopped.stopped, false); assert.equal(stopped.completionProven, false);
  assert.equal(stopped.errorCode, "GROUP_LIVE_OWNED_STOP_TIMEOUT");
  worker.writeEvidenceCheckpoint(output, { ...result, serviceStopEvidence: stopped }, matrix.safeEvidence);
  assert.equal(JSON.parse(fs.readFileSync(checkpoint)).serviceStopEvidence.errorCode, stopped.errorCode);
  assert.equal((fs.statSync(checkpoint).mode & 0o777), 0o600);
  assert.equal((await worker.boundedStop(async () => {}, 20)).completionProven, true);
  const unknownStop = await worker.boundedStop(() => { throw Object.assign(new Error("stop failed"), { code: "STOP_FAILED" }); }, 20); assert.equal(unknownStop.stopped,false); assert.equal(unknownStop.errorCode,"GROUP_LIVE_DIAGNOSTIC_CODE_UNKNOWN"); assert.match(unknownStop.errorCodeDigest,/^[a-f0-9]{64}$/u);
  fs.unlinkSync(checkpoint); fs.writeFileSync(checkpoint, "unowned", { mode: 0o600 });
  rejects(() => worker.writeEvidenceCheckpoint(output, result), "GROUP_LIVE_CHECKPOINT_OWNERSHIP_INVALID");
});
test("smoke stops only after terminal work and a settled discussion cannot fulfill the chain", () => {
  const base = { runs: [{ status: "completed" }], current: { discussion: { status: "idle" }, activeTurns: [] }, tasks: [] };
  assert.equal(worker.terminalChainMissing(base), true);
  assert.equal(worker.terminalChainMissing({ ...base, runs: [] }), false);
  assert.equal(worker.terminalChainMissing({ ...base, current: { discussion: { status: "running" }, activeTurns: [] } }), false);
  assert.equal(worker.terminalChainMissing({ ...base, runs: [{ status: "running" }] }), false);
  assert.equal(worker.terminalChainMissing({ ...base, tasks: [{ status: "queued" }] }), false);
});
test("fixed public typed codes preserve failures and reject arbitrary code, message and fallback secrets", async () => {
  const codes=require("./group-collaboration-live-codes.cjs"), secret=["NATIVE","PRIVATE","TOKEN","ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ"].join("_");
  const expectedDigest=sha("string:"+secret);
  assert.equal(codes.evidence.nativeCanExtendCatalogue,false);
  assert.equal(codes.boundedCode("RUNTIME_START_TURN_START_FAILED").code,"RUNTIME_START_TURN_START_FAILED");
  assert.equal(codes.diagnosticCode(new Error("RUNTIME_START_TURN_START_FAILED")).errorCode,"RUNTIME_START_TURN_START_FAILED");
  assert.equal(codes.boundedCode("access_revoked").code,"access_revoked");
  assert.equal(codes.boundedCode(null).code,null); assert.deepEqual(codes.diagnosticCode({}),{errorCode:"GROUP_LIVE_EXECUTION_FAILED"});
  for(const value of [secret,secret+"_FAILED",secret.toLowerCase(),secret+"\nEPERM"]){const unknown=codes.boundedCode(value);assert.equal(unknown.code,codes.UNKNOWN);assert.match(unknown.codeDigest,/^[a-f0-9]{64}$/u);assert(!JSON.stringify(unknown).includes(value));}
  const fallback=codes.boundedCode(undefined,secret);assert.equal(fallback.code,codes.UNKNOWN);assert.equal(fallback.codeDigest,expectedDigest);
  assert.equal(codes.diagnosticCode({},secret).errorCodeDigest,expectedDigest);
  const message=codes.diagnosticCode(new Error(secret));assert.equal(message.errorCode,codes.UNKNOWN);assert.equal(message.errorCodeDigest,expectedDigest);
  let touched=false;const getter={get code(){touched=true;return secret;},get message(){touched=true;return secret;}};assert.equal(codes.diagnosticCode(getter).errorCode,codes.UNKNOWN);assert.equal(touched,false);
  const err=Object.assign(new Error(secret),{code:secret}), ipc=external.codeEvidence(err);assert.equal(ipc.code,codes.UNKNOWN);assert.equal(ipc.codeDigest,expectedDigest);
  const forwarded=Object.assign(new Error(ipc.code),ipc);assert.equal(codes.diagnosticCode(forwarded).errorCodeDigest,expectedDigest);
  const stopped=await worker.boundedStop(()=>{throw err;},20);assert.equal(stopped.stopped,false);assert.equal(stopped.errorCodeDigest,expectedDigest);assert(!JSON.stringify(stopped).includes(secret));
});
test("report, nested trajectories, JSON diagnostic text and error arrays cannot expose native code secrets", async () => {
  const codes=require("./group-collaboration-live-codes.cjs"), secret=["PRIVATE","ALLCAPS","API","AUTHORITY","999999999999999999999999"].join("_");
  const diagnosticJson=JSON.stringify({ok:false,code:secret,message:secret,errorCodes:[secret],child:{code:secret,message:secret,toolErrorCodes:[secret]}});
  const projectedJson=matrix.safeEvidence(diagnosticJson);assert(!projectedJson.includes(secret));assert.equal(JSON.parse(projectedJson).message,null);assert.equal(JSON.parse(projectedJson).child.message,null);assert.equal(JSON.parse(projectedJson).errorCodes[0],codes.UNKNOWN);
  const raw={status:"failed",providerCalls:null,errorCode:secret,stateTrajectories:[{runs:[{status:"failed",errorCode:secret}],view:{lastErrorCode:secret},events:[{content:JSON.stringify({ok:false,code:secret})}]}],cleanupErrorCodes:["EPERM",secret,null],toolErrorCodes:[secret],errorCodes:[secret],error:{code:secret,message:secret}};
  const safe=matrix.safeEvidence(raw),text=JSON.stringify(safe);assert(!text.includes(secret));assert.equal(safe.status,"failed");assert.equal(safe.providerCalls,null);assert.equal(safe.errorCode,codes.UNKNOWN);assert.equal(safe.stateTrajectories[0].runs[0].errorCodeDigest,sha("string:"+secret));assert.deepEqual(safe.cleanupErrorCodes,["EPERM",codes.UNKNOWN,null]);assert.equal(safe.error.message,null);assert.equal(JSON.parse(safe.stateTrajectories[0].events[0].content).code,codes.UNKNOWN);
  const err=Object.assign(new Error(secret),{code:secret}),events=[],service={groupChatService:{callTool:async()=>{throw err;}}};const undo=matrix.recordCalls(service,[{id:"owned-profile"}],events,Date.now());try{await assert.rejects(()=>service.groupChatService.callTool("group_task",{action:"get"},{id:"owned-run"},"owned-profile"),error=>error===err);}finally{undo();}assert.equal(events[0].ok,false);assert.equal(events[0].code,codes.UNKNOWN);assert.equal(events[0].codeDigest,sha("string:"+secret));assert(!JSON.stringify(events).includes(secret));
  assert.equal(codes.boundedCode(secret).code,codes.UNKNOWN);assert.equal(codes.evidence.nativeCanExtendCatalogue,false);
});
test("already passed observations become failed when a later execution phase throws and unknown external tool digests survive projections",()=>{
 const codes=require("./group-collaboration-live-codes.cjs"),secret=["PRIVATE","EXTERNAL","NATIVE","SECRET","XYXYXYXYXYXYXYXYXYXYXYXYXYXY","FAILED"].join("_"),result={status:"passed",phase:"after-runtime-observation",providerCalls:null};
 worker.recordExecutionFailure(result,Object.assign(new Error(secret),{code:secret}));assert.equal(result.status,"failed");assert.equal(result.errorCode,codes.UNKNOWN);assert.equal(result.errorCodeDigest,sha("string:"+secret));assert.equal(result.providerCalls,null);
 const text=JSON.stringify({ok:false,code:secret,message:secret,errorCodes:[secret]}),history=external.historyEvidence([{role:"assistant",tool_calls:[{id:"own-call",function:{name:"group_task",arguments:'{"action":"get"}'}}]},{role:"tool",tool_call_id:"own-call",tool_name:"group_task",content:text}],[]);
 assert(!JSON.stringify(history).includes(secret));assert.equal(history.actualToolCalls[0].errorCodes[0],codes.UNKNOWN);assert.equal(history.actualToolCalls[0].errorCodesDiagnostics[0].codeDigest,sha("string:"+secret));assert.equal(JSON.parse(history.actualToolCalls[0].resultText).message,null);
});
(async () => {
  try { for (const { name, run } of tests) { await run(); process.stdout.write("PASS " + name + "\n"); }
    process.stdout.write("group-collaboration-live-harness-unit: " + tests.length + "/" + tests.length + " passed; Provider calls 0\n");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { process.stderr.write((error.stack || error.message) + "\n"); process.exitCode = 1; });
