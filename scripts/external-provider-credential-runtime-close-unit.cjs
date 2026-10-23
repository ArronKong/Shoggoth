"use strict";
// The sealed-candidate cases keep the actual production Worker filename and
// arguments. NativeWorker subclasses only observe behavior and actual exits.
// Tiny-error cases execute the same Runtime module bytes under a private dirname
// to select a real tiny Worker; they do not claim code/Host attestation.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const Module = require("node:module"), { Worker: NativeWorker } = require("node:worker_threads");
const repo = process.env.EXTERNAL_PROVIDER_CLOSE_FIXTURE_REPO || path.resolve(__dirname, "..");
const stateDir = process.argv[2];
const sourceFile = path.join(repo, "app/agent-service/external-provider-credential-runtime.js");
const sourceFiles = ["app/agent-service/external-provider-credential-runtime.js", "app/agent-service/external-provider-credential-writer-worker.js",
  "app/managed-plugin-host-runtime.js", "app/managed-openclaw-runtime-pins.json", "scripts/external-provider-credential-runtime-close-unit.cjs"];
const hashes = () => Object.fromEntries(sourceFiles.map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(path.join(repo, file))).digest("hex")]));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(next => { resolve = next; }); return { promise, resolve }; };
const roots = new Set(), tests = [], observations = [];
const test = (name, run) => tests.push({ name, run });
const rejected = (promise, code) => assert.rejects(promise, error => error.code === code);
const closeCode = "EXTERNAL_PROVIDER_RUNTIME_CLOSE_UNVERIFIED", retired = "EXTERNAL_PROVIDER_RUNTIME_RETIRED";
const resourcesRoot = path.join(repo, "resources/external-plugin-host-patches");
function loadAttestor(moduleDirectory = path.dirname(sourceFile)) {
  const rows = [], own = new WeakSet();
  class ObservedWorker extends NativeWorker {
    constructor(file, options) {
      super(file, options);
      own.add(this);
      const exited = deferred(), online = deferred();
      const row = { worker: this, file, options, actualThreadId: this.threadId, nativeInstance: this instanceof NativeWorker,
        exitCode: null, exited, online, exitAt: null, errorEvents: 0, terminateCalls: 0, terminateExitCodes: [], posts: [], createdAt: performance.now() };
      rows.push(row);
      this.once("online", () => online.resolve());
      this.on("error", () => { row.errorEvents += 1; });
      this.once("exit", code => { row.exitCode = code; row.exitAt = performance.now(); exited.resolve(code); });
    }
    postMessage(message, ...rest) {
      const row = rows.find(value => value.worker === this); row.posts.push({ type: message.type, at: performance.now() });
      return super.postMessage(message, ...rest);
    }
    terminate() {
      const row = rows.find(value => value.worker === this); row.terminateCalls += 1;
      const result = super.terminate(); result.then(code => row.terminateExitCodes.push(code), () => {}); return result;
    }
  }
  const source = fs.readFileSync(sourceFile, "utf8"), originalRequire = Module.createRequire(sourceFile);
  const loaded = new Module(path.join(moduleDirectory, "external-provider-credential-runtime.js"), module);
  loaded.filename = path.join(moduleDirectory, "external-provider-credential-runtime.js");
  loaded.paths = Module._nodeModulePaths(path.dirname(sourceFile));
  loaded.require = name => name === "node:worker_threads" ? { Worker: ObservedWorker } : originalRequire(name);
  loaded._compile(source, loaded.filename);
  return { create: loaded.exports.createExternalProviderRuntimeAttestor, rows, own };
}
function publicRow(row) {
  return { actualThreadId: row.actualThreadId, nativeInstance: row.nativeInstance, exitCode: row.exitCode, errorEvents: row.errorEvents,
    terminateCalls: row.terminateCalls, terminateExitCodes: row.terminateExitCodes, posts: row.posts.map(value => value.type),
    actualExitObserved: row.exitAt !== null, classification: row.terminateCalls ? "controlled cancellation; non-natural Worker exit"
      : row.errorEvents || row.exitCode !== 0 || !row.posts.some(value => value.type === "close") ? "actual error/unexpected exit" : "natural Worker exit 0" };
}
function trackVerify(attestor, writer) {
  const result = { guardsPublished: 0, errorCode: null, settled: false };
  result.promise = attestor.verify(writer).then(guard => { result.settled = true; result.guardsPublished += 1; result.guard = guard; },
    error => { result.settled = true; result.errorCode = error.code; });
  return result;
}
function candidate() {
  assert(stateDir && path.isAbsolute(stateDir) && fs.realpathSync(stateDir) === stateDir, "supply an existing sealed app-state root");
  const root = path.join(stateDir, "external-plugin-host-runtimes", "openclaw");
  const pointer = JSON.parse(fs.readFileSync(path.join(root, "active.json"), "utf8")); assert.match(pointer.candidateId, /^[a-f0-9]{64}$/u);
  const directory = path.join(root, "candidates", pointer.candidateId);
  const descriptor = JSON.parse(fs.readFileSync(path.join(directory, "descriptor.json"), "utf8"));
  const pin = require(path.join(repo, "app/managed-openclaw-runtime-pins.json")).hosts.openclaw;
  return { id: pointer.candidateId, writer: { runtimeRoot: path.join(directory, "runtime"), runtimeTreeSha256: pin.outputTreeSha256,
    interpreterPath: descriptor.interpreter.path, entryPath: path.join(directory, "runtime", pin.entryRelative) } };
}
function tiny(kind) {
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-runtime-close-error-")); roots.add(root); fs.chmodSync(root, 0o700);
  const actions = {
    "error-before": "setTimeout(() => { throw new Error('synthetic readonly Worker failure'); }, 25);",
    "error-during": "parentPort.on('message', value => { if (value.type === 'close') setTimeout(() => { throw new Error('synthetic close-time Worker failure'); }, 25); });",
    "nonzero-during": "parentPort.on('message', value => { if (value.type === 'close') setImmediate(() => process.exit(7)); });",
    "zero-before": "setTimeout(() => process.exit(0), 25);",
  };
  fs.writeFileSync(path.join(root, "external-provider-credential-writer-worker.js"),
    "'use strict'; const { parentPort } = require('node:worker_threads'); parentPort.on('message', () => {}); " + actions[kind] + "\n", { mode: 0o600 });
  const loaded = loadAttestor(root), attestor = loaded.create({ stateDir: root, resourcesRoot });
  return { root, loaded, attestor, writer: { runtimeRoot: "/private/tmp/tiny-no-runtime", interpreterPath: "/usr/bin/false" },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); roots.delete(root); } };
}

test("archived before-fix evidence and counter preserve original exact bytes and failed close scope", async () => {
  const files = [
    ["docs/architecture/plugin-managed-openclaw-code-attestation-close-before-evidence-2026-09-28.json", "41d5a914f0488abcbddc2e213404ade8b0f134a85dee0199e439cfaa22b92a2a"],
    ["docs/architecture/plugin-managed-openclaw-code-attestation-close-before-counter-2026-09-28.cjs", "db9915d58d2c788f52eb80075e6273f85c7950cadbd7688d1de2c68466157bac"],
  ];
  for (const [file, hash] of files) assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(repo, file))).digest("hex"), hash);
  const before = JSON.parse(fs.readFileSync(path.join(repo, files[0][0]), "utf8"));
  assert.equal(before.reproduction, true); assert.equal(before.pendingAtClose, true); assert.equal(before.closeCode, closeCode);
  assert.equal(before.sourceHashesBefore["app/agent-service/external-provider-credential-runtime.js"], "50e21b3201fffad33522dc97ac511fca2bfbd6ef9e80b12500947e9b8d309b91");
  assert.deepEqual(before.sourceHashesBefore, before.sourceHashesAfter);
  observations.push({ case: "archived before-fix bytes", hashes: Object.fromEntries(files), historicalOnly: true, counterRerun: false });
});

test("empty close is idempotent and later verify has no Worker or authority", async () => {
  const loaded = loadAttestor(), attestor = loaded.create({ stateDir, resourcesRoot });
  const first = attestor.close(); assert.strictEqual(attestor.close(), first); await first;
  await rejected(attestor.verify(candidate().writer), retired); assert.equal(loaded.rows.length, 0);
  observations.push({ case: "empty", workerStarts: 0, guardsPublished: 0 });
});

test("actual sealed first attestation close immediately retires all pending; actual owned exit confirms cancellation and repeated close", async () => {
  const actual = candidate(), loaded = loadAttestor(), attestor = loaded.create({ stateDir, resourcesRoot });
  const first = trackVerify(attestor, actual.writer), queued = trackVerify(attestor, actual.writer);
  const startedAt = performance.now(); let closed = false;
  try {
    assert.equal(loaded.rows.length, 1); const row = loaded.rows[0]; assert.equal(loaded.own.has(row.worker), true);
    assert.equal(row.file, path.join(repo, "app/agent-service/external-provider-credential-writer-worker.js"));
    assert.deepEqual(row.options.workerData, { stateDir, resourcesRoot }); await row.online.promise;
    await sleep(Math.max(1, 1000 - (performance.now() - startedAt)));
    assert.equal(first.settled, false, "first real inventory must still be in flight at close"); assert.equal(queued.settled, false);
    const closingAt = performance.now(), done = attestor.close().then(() => { closed = true; });
    const originalClose = attestor.close(); assert.strictEqual(attestor.close(), originalClose);
    await Promise.all([first.promise, queued.promise]); const immediateRetirementMs = performance.now() - closingAt;
    assert.equal(first.errorCode, retired); assert.equal(queued.errorCode, retired); assert.equal(first.guardsPublished + queued.guardsPublished, 0);
    assert.equal(closed, false); assert.ok(immediateRetirementMs < 250, "retirement cannot await tree completion");
    await done; assert.equal(row.exitAt !== null, true, "close must observe the captured actual exit before resolve");
    const observedExit = await row.exited.promise; assert.equal(row.errorEvents, 0);
    if (row.terminateCalls) { assert.equal(row.terminateCalls, 1); assert.deepEqual(row.terminateExitCodes, [observedExit]); assert.ok([0, 1].includes(observedExit)); }
    else assert.equal(observedExit, 0);
    assert.strictEqual(attestor.close(), originalClose); await rejected(attestor.verify(actual.writer), retired);
    await sleep(25); assert.equal(first.guardsPublished + queued.guardsPublished, 0);
    observations.push({ case: "actual sealed inflight", candidateId: actual.id, closeRequestedAfterMs: closingAt - startedAt,
      immediateRetirementMs, closeMs: performance.now() - closingAt, guardsPublished: 0, ...publicRow(row) });
  } finally { await attestor.close(); }
});

test("actual sealed idle close is naturally exit zero and previously issued stamp retires immediately", async () => {
  const actual = candidate(), loaded = loadAttestor(), attestor = loaded.create({ stateDir, resourcesRoot });
  try {
    const guard = await attestor.verify(actual.writer); assert.equal(guard(), true); const row = loaded.rows[0];
    const closed = attestor.close(); assert.throws(guard, error => error.code === retired); assert.strictEqual(attestor.close(), closed);
    await closed; assert.equal(row.exitAt !== null, true); assert.equal(await row.exited.promise, 0); assert.equal(row.terminateCalls, 0); assert.equal(row.errorEvents, 0);
    observations.push({ case: "actual sealed idle", candidateId: actual.id, publishedStampRetired: true, ...publicRow(row) });
  } finally { await attestor.close(); }
});

for (const kind of ["error-before", "error-during", "nonzero-during", "zero-before"]) {
  test("real tiny Worker " + kind + " is never masked as controlled cancellation", async () => {
    const value = tiny(kind), pending = trackVerify(value.attestor, value.writer), row = value.loaded.rows[0];
    try {
      await row.online.promise;
      if (kind.endsWith("before")) await row.exited.promise; else await sleep(50);
      const closing = value.attestor.close(); assert.strictEqual(value.attestor.close(), closing);
      await rejected(closing, closeCode); await pending.promise; const exited = await row.exited.promise;
      assert.equal(row.terminateCalls, 0); assert.equal(pending.guardsPublished, 0); assert.equal(row.exitAt !== null, true);
      assert.equal(row.errorEvents, kind.startsWith("error-") ? 1 : 0);
      assert.equal(exited, kind === "zero-before" ? 0 : kind === "nonzero-during" ? 7 : 1);
      await rejected(value.attestor.verify(value.writer), retired); assert.strictEqual(value.attestor.close(), closing);
      observations.push({ case: "tiny " + kind, boundary: "actual native Worker error/exit injection; no code/Host attestation claim", closeRejected: closeCode,
        guardsPublished: 0, ...publicRow(row) });
    } finally { try { await value.attestor.close(); } catch {} await row.exited.promise; value.cleanup(); }
  });
}

const watchdog = setTimeout(() => { throw Error("bounded runtime close fixture did not finish in 60 seconds"); }, 60000);
(async () => {
  const sourceHashesBefore = hashes(), results = [];
  for (const { name, run } of tests) { try { await run(); results.push({ name, status: "PASS" }); }
    catch (error) { results.push({ name, status: "FAIL", code: error.code || error.name }); console.error(name + "\n" + error.stack); } }
  const sourceHashesAfter = hashes(); assert.deepEqual(sourceHashesAfter, sourceHashesBefore); assert.equal(roots.size, 0);
  const passed = results.every(row => row.status === "PASS"); process.stdout.write(JSON.stringify({ status: passed ? "PASS" : "FAIL", groups: results.length,
    results, observations, sourceHashesBefore, sourceHashesAfter, sourcesUnchanged: true,
    boundary: "actual sealed code first/idle close plus isolated real tiny Worker faults; no Host/model/vault/dataRoot/copy",
    hostStarts: 0, modelRequests: 0, secretReads: 0, runtimeCopies: 0 }) + "\n"); if (!passed) process.exitCode = 1;
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
