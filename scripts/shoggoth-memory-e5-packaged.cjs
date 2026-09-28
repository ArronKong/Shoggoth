#!/usr/bin/env node
"use strict";

// Execute the packaged production modules with the selected App's Electron.
// The fixture owns its temporary Profile and denies network access to both
// Electron and the production inference child. It never opens user data.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

function options(argv) {
  const value = { child: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--child") { value.child = true; continue; }
    if (!["--app", "--output", "--root"].includes(key) || !argv[i + 1]) throw new Error("Invalid arguments");
    const name = key.slice(2), input = argv[++i];
    if (value[name] || !path.isAbsolute(input) || input.includes("\0") || !input.isWellFormed()) throw new Error("An absolute path is required");
    value[name] = path.normalize(input);
  }
  if (!value.app || !value.output || (value.child && !value.root) || (!value.child && value.root)) {
    throw new Error("Usage: node scripts/shoggoth-memory-e5-packaged.cjs --app /absolute/Shoggoth.app --output /absolute/report.json");
  }
  return value;
}

async function childMain(value) {
  const moduleRoot = path.join(value.app, "Contents", "Resources", "app.asar", "app", "agent-service");
  const load = name => require(path.join(moduleRoot, name));
  const { resolveServicePaths } = load("paths.js");
  const { AgentDefinitionStore } = load("agent-definition-store.js");
  const { MemoryStore } = load("memory-store.js");
  const { MemoryEngine, workspaceMemoryRef } = load("memory-engine.js");
  const { NativeMemorySemanticService } = load("native-memory-semantic-service.js");
  const { LocalEmbeddingService } = load("local-embedding-service.js");
  const { TranscriptStore } = load("transcript-store.js");
  const { ConversationRecallService } = load("conversation-recall-service.js");
  const { openDatabase } = load("inspiration-database.js");
  const { E5_MODEL, e5AssetDirectory } = load("e5-model-contract.js");
  const rootStat = fs.lstatSync(value.root);
  assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink() && (rootStat.mode & 0o077) === 0);
  assert.ok(path.basename(value.root).startsWith("shoggoth-e5-package-"));
  assert.equal(e5AssetDirectory(), path.join(value.app, "Contents", "Resources", "embedding", "model"));
  globalThis.fetch = async () => { throw new Error("Fixture forbids downloads"); };
  const paths = resolveServicePaths({ stateRoot: path.join(value.root, "state"),
    profileRoot: path.join(value.root, "profile"), cacheRoot: path.join(value.root, "cache"), trustedRoot: value.root });
  let clock = Date.now(), serial = 0;
  const now = () => clock++;
  const randomUUID = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`;
  const profileId = "e5-package-fixture", workspace = "/synthetic/package-workspace";
  const definitions = new AgentDefinitionStore({ paths, now, randomUUID });
  const store = new MemoryStore({ paths });
  let engine, semantic, transcripts, recall, missing;
  const checks = [];
  try {
    definitions.open(); definitions.ensureProfile({ profileId }); store.open();
    engine = new MemoryEngine({ store, definitionStore: definitions, now, randomUUID }); engine.open([profileId]);
    semantic = new NativeMemorySemanticService({ paths, memoryEngine: engine }); engine.setSemanticSearchService(semantic);
    const add = (content, extra = {}) => engine.propose({ profileId, content, scope: "user", type: "semantic",
      sourceRefs: [randomUUID()], classification: "explicit", ...extra });
    const target = add("我养的宠物是一只叫栗子的仓鼠。");
    for (const text of ["城东的花店每周二休息。", "我喜欢用钢笔写字。", "My bicycle has a red frame.",
      "The conference begins at nine.", "我的茶壶容量是六百毫升。"]) add(text);
    const other = add("我养的宠物是一只叫瓜子的仓鼠。", { scope: "project",
      sourceRefs: [randomUUID(), workspaceMemoryRef("/synthetic/other-workspace")] });
    const ready = async () => {
      const job = semantic.ensureMemory(profileId); await job.promise;
      assert.equal(job.state, "ready", JSON.stringify(semantic.status(profileId)));
    };
    const search = query => semantic.searchMemory({ profileId, query, workspace, maxSensitivity: "normal", limit: 10 });
    await ready();
    const found = await search("What is my hamster called?");
    assert.equal(found.semantic.status, "ready"); assert.equal(found.items[0].id, target.id);
    assert.ok(found.items[0].semanticScore >= 0.7);
    assert.ok(!found.items.some(item => item.id === other.id));
    checks.push("packaged ASAR worker, tokenizer and native ONNX bilingual recall; workspace filter");

    transcripts = new TranscriptStore({ paths, assertSecretSafe: () => true }); transcripts.open();
    const sessions = [0, 1].map(() => ({ id: randomUUID(), sessionKey: randomUUID(), profileId, workspace, status: "ready" }));
    for (const session of sessions) transcripts.ensureSession({ profileId, sessionId: session.id });
    const runs = sessions.map(session => ({ id: randomUUID(), profileId, source: "chat", sourceId: session.sessionKey, workspace, status: "running" }));
    const original = transcripts.appendEvent({ id: randomUUID(), profileId, sessionId: sessions[0].id,
      runId: runs[0].id, kind: "user", content: { text: "我的观鸟望远镜采用八倍放大和四十二毫米口径。" } });
    transcripts.appendEvent({ id: randomUUID(), profileId, sessionId: sessions[1].id,
      runId: runs[1].id, kind: "user", content: { text: "查询以前的设备参数" } });
    const sessionsStore = { listSessions: () => structuredClone(sessions),
      getSession: key => structuredClone(sessions.find(session => session.sessionKey === key)),
      getCronSessionOrigin: () => null, getRevision: () => 1 };
    engine.transcriptStore = transcripts; engine.chatSessionStore = sessionsStore;
    recall = new ConversationRecallService({ paths, transcriptStore: transcripts, chatSessionStore: sessionsStore,
      workDispatcher: { getRun: key => runs.find(run => run.id === key) }, getRunSessionKey: run => run.sourceId,
      recallPolicy: engine.recallPolicy, memoryStore: store, semanticSearch: semantic, now });
    const job = recall._ensureSemantic(profileId); await job.promise; assert.equal(job.state, "ready");
    const args = { source: "chat", sourceId: runs[1].sourceId, query: "What magnification do my binoculars use?", limit: 5 };
    const conversation = await recall.searchWithSemantic({ profileId, args, run: runs[1] });
    assert.ok(conversation.results.some(item => item.eventId === original.id && item.semanticEvidence && item.snippet.includes("八倍")));
    recall.assertResultCurrent({ name: "conversation_search", profileId, args, run: runs[1], result: conversation });
    transcripts.setContextExcluded({ profileId, sessionId: sessions[0].id, eventId: original.id, contextExcluded: true });
    assert.throws(() => recall.assertResultCurrent({ name: "conversation_search", profileId, args, run: runs[1], result: conversation }));
    checks.push("packaged conversation semantics and authoritative source revocation");

    engine.delete({ profileId, id: target.id, reason: "forgotten" });
    assert.ok(!(await search("What is my hamster called?")).items.some(item => item.id === target.id));
    await ready();
    const indexFile = path.join(paths.agentsDir, profileId, "native-memory-semantic.sqlite");
    const db = openDatabase(indexFile);
    assert.ok(!db.prepare("SELECT source FROM documents WHERE domain='memory'").all()
      .some(row => JSON.parse(row.source).sourceId === target.id));
    db.prepare("DELETE FROM vectors WHERE domain='memory'").run(); db.close();
    assert.equal((await search("钢笔")).semantic.status, "unavailable");
    await ready(); assert.equal((await search("钢笔")).semantic.status, "ready");
    checks.push("forgotten primary and vector removal; corrupt cache fallback and automatic rebuild");

    missing = new NativeMemorySemanticService({ paths, memoryEngine: engine,
      embeddingFactory: () => new LocalEmbeddingService({ paths, assetDirectory: path.join(value.root, "missing-model") }) });
    const fallback = await missing.searchMemory({ profileId, query: "钢笔", workspace, maxSensitivity: "normal" });
    assert.ok(["unavailable", "timeout"].includes(fallback.semantic.status));
    assert.ok(fallback.items.some(item => item.content.includes("钢笔")));
    const missingJob = missing.ensureMemory(profileId); await missingJob.promise;
    assert.equal(missingJob.state, "unavailable");
    const settledFallback = await missing.searchMemory({ profileId, query: "钢笔", workspace, maxSensitivity: "normal" });
    assert.equal(settledFallback.semantic.status, "unavailable");
    assert.ok(settledFallback.items.some(item => item.content.includes("钢笔")));
    checks.push("missing bundled model preserves lexical retrieval without downloading");
    await missing.close(); missing = null;
    const stats = await semantic.embedding.request("stats", {});
    const model = semantic.embedding.model;
    await semantic.close(); assert.deepEqual(semantic.embedding.lastExit, { code: 0, signal: null });
    const report = { verified: true, app: value.app, packagedModules: moduleRoot,
      architecture: process.arch, versions: { electron: process.versions.electron, node: process.versions.node },
      model, modelRevision: E5_MODEL.revision, assetDirectory: e5AssetDirectory(),
      networkDenied: true, inferenceNaturalExit: semantic.embedding.lastExit, worker: stats, checks };
    fs.writeFileSync(value.output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  } finally {
    recall?.close(); transcripts?.close(); await missing?.close(); await semantic?.close();
    engine?.close(); store.close(); definitions.close();
  }
}

async function parentMain(value) {
  const appStat = fs.lstatSync(value.app);
  assert.ok(appStat.isDirectory() && !appStat.isSymbolicLink());
  assert.equal(fs.realpathSync(value.app), value.app);
  if (fs.existsSync(value.output)) throw new Error("Output already exists; choose a new report path");
  const executable = path.join(value.app, "Contents", "MacOS", "Shoggoth");
  assert.ok(fs.lstatSync(executable).isFile());
  fs.mkdirSync(path.dirname(value.output), { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-e5-package-")); fs.chmodSync(root, 0o700);
  for (const name of ["home", "tmp"]) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  let timedOut = false;
  try {
    const env = { ELECTRON_RUN_AS_NODE: "1", HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"),
      PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };
    const child = spawn("/usr/bin/sandbox-exec", ["-p", "(version 1) (allow default) (deny network*)",
      executable, __filename, "--child", "--app", value.app, "--output", value.output, "--root", root],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
    const timeout = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 120000);
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal }));
    }).finally(() => clearTimeout(timeout));
    assert.equal(timedOut, false, "Packaged inference timed out");
    assert.deepEqual(exit, { code: 0, signal: null }, "Packaged Electron must exit naturally");
    const report = JSON.parse(fs.readFileSync(value.output, "utf8")); assert.equal(report.verified, true);
    report.electronNaturalExit = exit;
    fs.writeFileSync(value.output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify(report));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const value = options(process.argv.slice(2));
(value.child ? childMain(value) : parentMain(value)).catch(error => { console.error(error); process.exitCode = 1; });
