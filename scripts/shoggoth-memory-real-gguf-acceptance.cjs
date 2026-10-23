"use strict";

// Explicit opt-in acceptance: downloads the fixed official assets, executes
// the verified native installer/server and indexes only invented local text.
// It never starts a production Service or reads an existing user's memory.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const { core, ShoggothMemoryHost } = require("../app/agent-service/shoggoth-memory/host.cjs");
const { withMemoryHost } = require("../app/agent-service/shoggoth-memory/host-bridge.cjs");
const { MemoryDatabase } = require("../app/agent-service/shoggoth-memory/database.cjs");
const { MemorySearchIndex } = require("../app/agent-service/shoggoth-memory/search-index.cjs");
const { MemoryLocalEmbeddingHost } = require("../app/agent-service/shoggoth-memory/local-embedding-host.cjs");
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const root = "/private/tmp/shoggoth-memory-real-gguf-20261008";
const expectedModelHash = "6fa0c02a9c302be6f977521d399b4de3a46310a4f2621ee0063747881b673f67";

async function main() {
  if (process.argv[2] !== "--download-and-run") throw new Error("Explicit --download-and-run is required");
  if (process.argv.length > 3 && (process.argv.length !== 4 || process.argv[3] !== "--preloaded-assets")) throw new Error("Unknown acceptance option");
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This acceptance requires macOS arm64");
  if (fs.existsSync(root)) {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
      || (stat.mode & 0o777) !== 0o700 || fs.realpathSync.native(root) !== root) throw new Error("Acceptance root is not private and owned");
  } else fs.mkdirSync(root, { mode: 0o700 });
  const disk = fs.statfsSync(root);
  if (disk.bavail * disk.bsize < 2 * 1024 ** 3) throw new Error("Acceptance requires at least 2 GiB free");
  const paths = { trustedRoot: root, stateDir: path.join(root, "state"), agentsDir: path.join(root, "agents") };
  const cacheDir = path.join(paths.stateDir, "models/llama.cpp");
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const setupHost = { assertCurrent() {}, resolveStateDir: () => paths.stateDir };
  const signal = AbortSignal.timeout(10 * 60_000);
  let lastProgress = 0;
  const progress = status => {
    if (Date.now() - lastProgress < 5000) return;
    lastProgress = Date.now();
    console.log(JSON.stringify({ stage: "download", downloadedBytes: status.downloadedSize,
      totalBytes: status.totalSize, bytesPerSecond: status.bytesPerSecond }));
  };
  let index, database, resources;
  let preload;
  if (process.argv[3] === "--preloaded-assets") {
    const source = path.join(root, "public-assets.json"), stat = fs.lstatSync(source);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid());
    preload = JSON.parse(fs.readFileSync(source, "utf8"));
    assert.equal(preload.format, "shoggoth-real-gguf-public-preload");
    assert.equal(preload.assets.find(value => value.name === "model").sha256, expectedModelHash);
    const archive = preload.assets.find(value => value.name === "archive");
    assert.equal(archive.path, path.join(root, "llama-b10809-bin-macos-arm64.tar.gz"));
    assert.equal(archive.sha256, "7d692df9e1e386e62f1c12b843903218041e6cd74c9415aa39a7ed3176f9eaa2");
    assert.equal(sha256(fs.readFileSync(archive.path)), archive.sha256);
    assert.ok(preload.command.startsWith(root + path.sep));
    assert.equal(fs.realpathSync.native(preload.command), preload.command);
    assert.equal(sha256(fs.readFileSync(preload.command)), preload.commandSha256);
  }
  const receipt = { format: "shoggoth-real-gguf-acceptance", upstreamRevision: "c10679395819ede78bb073f979f95c157e165bfa",
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" }).trim(),
    coreSha256: sha256(fs.readFileSync(path.join(__dirname, "../app/agent-service/shoggoth-memory/core.cjs"))),
    platform: process.platform, architecture: process.arch, root,
    productionOwnerSelected: false, userDataRead: false, externalInference: false, accepted: false };
  receipt.acquisition = preload ? { publicPreload: path.join(root, "public-assets.json"),
    publicPreloadSha256: sha256(fs.readFileSync(path.join(root, "public-assets.json"))), nativeAutomaticDownloadVerified: false }
    : { mode: "native-download-or-verified-cache" };
  receipt.sourceFiles = Object.fromEntries([__filename,
    path.join(__dirname, "../app/agent-service/shoggoth-memory/local-embedding-host.cjs"),
    path.join(__dirname, "../app/agent-service/shoggoth-memory/search-index.cjs")]
    .map(file => [path.relative(path.resolve(__dirname, ".."), file), sha256(fs.readFileSync(file))]));
  try {
    const modelPath = await withMemoryHost(setupHost, () => core.ensureLlamaCppModel({
      source: core.DEFAULT_LLAMA_CPP_EMBEDDING_MODEL, cacheDir, download: true, signal, onProgress: progress }));
    const modelHash = sha256(fs.readFileSync(modelPath));
    assert.equal(modelHash, expectedModelHash);
    receipt.model = { source: core.DEFAULT_LLAMA_CPP_EMBEDDING_MODEL, path: modelPath,
      bytes: fs.statSync(modelPath).size, sha256: modelHash };
    console.log(JSON.stringify({ stage: "model-verified", ...receipt.model }));
    const server = await withMemoryHost(setupHost, () => core.prepareManagedLlamaServer({
      chatModel: { mode: "remove" }, embeddingModelPath: modelPath, embeddingModelIsDefault: true,
      ...(preload ? { localService: { command: preload.command } } : {}),
      isolated: true, signal, onProgress: progress }));
    const versionCheck = spawnSync(server.command, ["--version"], { encoding: "utf8", timeout: 15000 });
    assert.equal(versionCheck.status, 0);
    const version = (versionCheck.stdout + versionCheck.stderr).trim();
    assert.match(version.split(/\r?\n/u, 1)[0], /^version: .+ \(build 10809, commit 5266f24da\)$/u);
    receipt.server = { ...server, commandSha256: sha256(fs.readFileSync(server.command)), version };
    console.log(JSON.stringify({ stage: "server-verified", ...receipt.server }));
    const workspace = fs.mkdtempSync(path.join(root, "workspace-")); fs.chmodSync(workspace, 0o700);
    fs.mkdirSync(path.join(workspace, "memory"), { mode: 0o700 });
    const docs = { "observatory.md": "# Observatory\nThe invented Amber telescope station is located on the northern mountain ridge. Its calibration code is zircon-47.\n",
      "tea.md": "# Tea\nThe invented cafe sells jasmine tea and lemon cookies every afternoon.\n" };
    for (const [name, text] of Object.entries(docs)) fs.writeFileSync(path.join(workspace, "memory", name), text, { mode: 0o600 });
    const cfg = { memory: { search: { provider: "local", sources: ["memory"], cache: { enabled: true } } },
      models: { providers: { "llama-cpp": { baseUrl: server.baseUrl, models: [], params: { modelCacheDir: cacheDir },
        localService: { command: server.command, args: server.args, healthUrl: server.healthUrl,
          readyTimeoutMs: 120_000, idleStopMs: 0 } } } } };
    database = new MemoryDatabase({ paths, databasePath: path.join(workspace, "index.sqlite") }); database.open();
    const host = new ShoggothMemoryHost({ database, paths, profileId: "acceptance", workspaceDir: workspace,
      roster: () => [{ id: "acceptance", workspace }], sessions: { list: () => [] } });
    resources = new MemoryLocalEmbeddingHost({ getConfig: id => { assert.equal(id, "acceptance"); return cfg; },
      assertCurrent: id => { assert.equal(id, "acceptance"); signal.throwIfAborted(); } });
    index = new MemorySearchIndex({ host, databasePath: database.path, sharedDatabase: true, getConfig: () => cfg,
      acquireLocalService: resources.acquireLocalService, assertLocalEmbeddingConfig: resources.assertLocalEmbeddingConfig,
      runLocalEmbedding: resources.runLocalEmbedding, backgroundSync: false,
      logger: { debug() {}, warn(message) { console.log(JSON.stringify({ stage: "index-warning", message })); } } });
    await index.sync({ signal });
    const chunks = database.db.prepare("SELECT path,model,embedding FROM memory_index_chunks ORDER BY path").all();
    assert.equal(chunks.length, 2);
    for (const row of chunks) {
      assert.equal(row.model, core.DEFAULT_LLAMA_CPP_EMBEDDING_MODEL);
      const vector = core.decodeMemoryEmbedding(row.embedding);
      assert.equal(vector.length, 768); assert.ok(vector.every(Number.isFinite));
      assert.ok(vector.some(value => value !== 0));
    }
    const results = await index.search("Where is the telescope station located?", { signal, minScore: 0, record: false });
    assert.ok(results.length > 0); assert.equal(results[0].path, "memory/observatory.md");
    const provider = index.searchOwner.provider;
    const a = await host.run(() => provider.embed("Invented telescope on a mountain", { signal }));
    const b = await host.run(() => provider.embed("Invented jasmine tea and lemon cookies", { signal }));
    assert.equal(a.length, 768); assert.equal(b.length, 768); assert.notDeepEqual(a, b);
    const facts = provider[Symbol.for("openclaw.localEmbeddingRuntimeFacts")]();
    assert.equal(fs.realpathSync.native(facts.model.path), fs.realpathSync.native(modelPath));
    receipt.index = { chunks: chunks.length, dimensions: a.length, model: index.model,
      metadata: core.readMemoryIndexMetadata(database.db).meta, queryResults: results, runtimeFacts: facts,
      distinctVectors: true, documentEmbeddingsVerified: true };
    console.log(JSON.stringify({ stage: "inference-verified", chunks: chunks.length, dimensions: a.length,
      model: index.model, topResult: results[0].path }));
    await index.close(); index = undefined;
    await resources.close(); resources = undefined;
    database.close(); database = undefined;
    assert.deepEqual(core.getManagedProviderLocalServiceDiagnosticsForTest(), []);
    receipt.naturalResourceRetirement = true; receipt.accepted = true;
  } catch (error) {
    receipt.error = { name: error.name, code: error.code, message: error.message };
    throw error;
  } finally {
    const cleanupErrors = [];
    for (const close of [() => index?.close(), () => resources?.close(), () => database?.close()]) {
      try { await close(); } catch (error) { cleanupErrors.push({ name: error.name, code: error.code, message: error.message }); }
    }
    if (cleanupErrors.length) {
      receipt.accepted = false; receipt.cleanupErrors = cleanupErrors;
      process.exitCode = 1;
    }
    fs.writeFileSync(path.join(root, "acceptance.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify({ stage: "receipt", path: path.join(root, "acceptance.json"), accepted: receipt.accepted }));
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
