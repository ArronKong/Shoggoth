#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { ModelChangeCoordinator } = require("../app/core/model-change-coordinator");
const { createEntry, createModelChangeJournal } = require("../app/core/model-change-journal");
const { normalizeModelChangeRequest, modelChangeRequestDigest } = require("../app/core/model-change-validation");
const hash = text => crypto.createHash("sha256").update(text).digest("hex");
const tests = [], test = (name, action) => tests.push({ name, action });
function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-model-observation-"));
  const file = path.join(root, "journal.json"), journal = createModelChangeJournal(file, options), calls = [];
  const backend = { id: "openclaw",
    async getModelChangeCapabilities() { calls.push("capabilities"); return { supported: true, create: true, blockers: [] }; },
    async previewModelChange() { calls.push("preview"); return { references: [], blockers: [], runtimeApply: "hot", fingerprints: {} }; },
    async applyModelChange() { calls.push("apply"); return { status: "applied", stage: "verify-ready" }; },
  };
  const registry = { _activeGet(id) { calls.push("backend"); return id === "openclaw" ? backend : null; },
    async listModelsSnapshot() { calls.push("catalog"); return { models: [], catalogRevision: hash("catalog") }; },
  };
  // The coordinator stamps journal entries; it must share the journal's (possibly fake) clock.
  const clock = options.now ? { now: options.now } : {};
  const create = () => new ModelChangeCoordinator({ journal: createModelChangeJournal(file, options), registry, tokenSecret: Buffer.alloc(32, 9), ...clock });
  const coordinator = new ModelChangeCoordinator({ journal, registry, tokenSecret: Buffer.alloc(32, 9), ...clock });
  const seed = async (id, status) => journal.withExclusiveLock(`seed:${id}`, () => {
    journal.begin(createEntry({ operationId: id, requestDigest: hash(id), previewTokenDigest: hash(`preview:${id}`), backendId: "openclaw",
      providerKey: "test-provider", kind: "create", source: null, target: { provider: "test-provider", modelId: "test-model" },
      modelDiff: { before: null, after: { id: "test-model", name: "Test" } }, fingerprints: { privateInternal: "canary-internal-reference" } }, options.now?.()));
    journal.finish(id, status, { operationId: id, status, stage: "verify-ready", code: "controlled_status" });
  });
  const observe = id => coordinator.observeOperation("openclaw", { operationId: id, providerKey: "test-provider" });
  return { root, file, journal, calls, coordinator, backend, create, seed, observe, cleanup() { fs.rmSync(root, { recursive: true, force: true }); } };
}
test("lost successful apply response is observed from the real durable journal without a second effect", async () => {
  const f = fixture(); try {
    f.coordinator.markReady();
    const result = await f.coordinator.applyCompat("openclaw", { providerKey: "test-provider", providerMode: "existing", model: { id: "test-model", name: "Test" } }, { operationId: "lost-model-response" });
    assert.equal(result.status, "applied"); const before = [...f.calls], bytes = fs.readFileSync(f.file);
    const observed = f.observe("lost-model-response"); assert.equal(observed.status, "applied"); assert.equal(observed.terminal, true);
    assert.deepEqual(f.calls, before); assert.deepEqual(fs.readFileSync(f.file), bytes); assert.equal(f.calls.filter(name => name === "apply").length, 1);
    assert.equal(Object.hasOwn(observed, "catalog"), false);
  } finally { f.cleanup(); }
});
test("a fresh unready coordinator observes the exact persisted terminal receipt without backend readiness", async () => {
  const f = fixture(); try { await f.seed("reopened-applied", "applied"); const before = fs.readFileSync(f.file), next = f.create();
    assert.equal(next.isReady(), false); const result = next.observeOperation("openclaw", { operationId: "reopened-applied", providerKey: "test-provider" });
    assert.equal(result.status, "applied"); assert.equal(result.terminal, true); assert.deepEqual(f.calls, []); assert.deepEqual(fs.readFileSync(f.file), before);
  } finally { f.cleanup(); }
});
test("an absent original that is not being processed is a terminal not-admitted failure, never success or a new operation", async () => {
  const f = fixture(); try { assert.deepEqual(f.observe("absent-original"), { version: 1, backendId: "openclaw", operationId: "absent-original", providerKey: "test-provider", status: "failed", stage: "observation", code: "operation_not_admitted", terminal: true });
    assert.equal(fs.existsSync(f.file), false); assert.deepEqual(f.calls, []);
  } finally { f.cleanup(); }
});
test("an original still being processed stays nonterminal until its own request settles", async () => {
  const f = fixture(); let release; const gate = new Promise(resolve => { release = resolve; });
  try { f.coordinator.markReady(); f.backend.previewModelChange = async () => { f.calls.push("preview"); await gate; return { references: [], blockers: [], runtimeApply: "hot", fingerprints: {} }; };
    const pending = f.coordinator.applyCompat("openclaw", { providerKey: "test-provider", providerMode: "existing", model: { id: "test-model", name: "Test" } }, { operationId: "in-flight-original" });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.observe("in-flight-original"), { version: 1, backendId: "openclaw", operationId: "in-flight-original", providerKey: "test-provider", status: "not_found", stage: "observation", terminal: false });
    release(); assert.equal((await pending).status, "applied");
    const settled = f.observe("in-flight-original"); assert.equal(settled.status, "applied"); assert.equal(settled.terminal, true);
  } finally { release(); f.cleanup(); }
});
test("a preflight rejection that never reached the journal settles as a terminal failure with its own code", async () => {
  const f = fixture(); try { f.coordinator.markReady();
    f.backend.previewModelChange = async () => ({ references: [], blockers: [{ code: "provider_exists", stage: "preflight" }], runtimeApply: "hot", fingerprints: {} });
    const result = await f.coordinator.applyCompat("openclaw", { providerKey: "test-provider", providerMode: "existing", model: { id: "test-model", name: "Test" } }, { operationId: "rejected-original" });
    assert.equal(result.status, "blocked"); assert.equal(f.journal.get("rejected-original"), null);
    assert.deepEqual(f.observe("rejected-original"), { version: 1, backendId: "openclaw", operationId: "rejected-original", providerKey: "test-provider", status: "failed", stage: "preflight", code: "provider_exists", terminal: true });
    assert.throws(() => f.coordinator.observeOperation("openclaw", { operationId: "rejected-original", providerKey: "other-provider" }), { code: "operation_scope_mismatch", status: 404 });
    await assert.rejects(f.coordinator.updateProviderCompat("openclaw", "test-provider", { renameTo: "bad/name" }, { operationId: "invalid-original" }), { code: "invalid_provider" });
    assert.equal(f.observe("invalid-original").status, "failed"); assert.equal(f.observe("invalid-original").code, "invalid_provider");
  } finally { f.cleanup(); }
});
test("an unjournaled batch write settles as its real terminal receipt so the recovery ACK can release it", async () => {
  const f = fixture(); try { f.coordinator.markReady();
    f.backend.getModelConfigWriteCapabilities = async () => ({ supported: true, batch: true, activation: null });
    f.backend.applyModelChangeConfigOnlyBatch = async () => { f.calls.push("batch"); return { status: "applied", stage: "config-write", restartRequired: false }; };
    const result = await f.coordinator.batchCompat("openclaw", [{ providerKey: "test-provider", model: { id: "added" } }], { operationId: "batch-original" });
    assert.equal(result.status, "applied"); assert.equal(f.journal.get("batch-original"), null, "batch writes stay outside the journal");
    assert.deepEqual(f.observe("batch-original"), { version: 1, backendId: "openclaw", operationId: "batch-original", providerKey: "test-provider", status: "applied", stage: "config-write", terminal: true });
    assert.equal(f.calls.filter(name => name === "batch").length, 1);
  } finally { f.cleanup(); }
});
test("an explicit abandon settles only a journaled config-only pending original, without backend calls or rollback", async () => {
  const f = fixture(); try { await f.seed("needs-key-original", "needs_secret");
    await assert.rejects(f.coordinator.abandonOperation("openclaw", { operationId: "needs-key-original", providerKey: "test-provider" }), { code: "abandon_unsupported", status: 409 });
    await f.journal.withExclusiveLock("seed:config-only", () => {
      f.journal.begin(createEntry({ operationId: "config-only-original", requestDigest: hash("config-only-original"), previewTokenDigest: hash("preview:config-only-original"),
        backendId: "openclaw", providerKey: "test-provider", kind: "update-provider", mode: "config-only", source: null, target: { provider: "renamed" },
        modelDiff: null, fingerprints: {}, secretStep: "pending" }));
      f.journal.finish("config-only-original", "needs_secret", { operationId: "config-only-original", status: "needs_secret", stage: "provider-rename", code: "recovery_input_required" });
    });
    const calls = [...f.calls];
    const receipt = await f.coordinator.abandonOperation("openclaw", { operationId: "config-only-original", providerKey: "test-provider" });
    assert.deepEqual(receipt, { version: 1, backendId: "openclaw", operationId: "config-only-original", providerKey: "test-provider", status: "failed", stage: "preflight", code: "abandoned_by_user", terminal: true });
    assert.deepEqual(f.calls, calls); assert.equal(f.journal.listPending().some(entry => entry.operationId === "config-only-original"), false);
    const again = await f.coordinator.abandonOperation("openclaw", { operationId: "config-only-original", providerKey: "test-provider" }); assert.equal(again.code, "abandoned_by_user");
  } finally { f.cleanup(); }
});
test("the original operation cannot be observed as another backend or provider", async () => {
  const f = fixture(); try { await f.seed("scoped-original", "applied");
    for (const [backendId, providerKey] of [["hermes", "test-provider"], ["openclaw", "different-provider"]]) assert.throws(() => f.coordinator.observeOperation(backendId, { operationId: "scoped-original", providerKey }), { code: "operation_scope_mismatch", status: 404 });
    assert.deepEqual(f.calls, []);
  } finally { f.cleanup(); }
});
test("blocked, partial and cleanup receipts remain pending and expose no internal recovery details", async () => {
  const f = fixture(); try { for (const status of ["blocked", "partial", "cleanup_pending", "needs_secret", "in_progress"]) {
    await f.seed(`pending-${status}`, status); const value = f.observe(`pending-${status}`); assert.equal(value.status, status); assert.equal(value.terminal, false);
    assert.deepEqual(Object.keys(value).sort(), ["version", "backendId", "operationId", "providerKey", "status", "stage", "terminal", "code"].sort());
    assert.equal(JSON.stringify(value).includes("canary-internal-reference"), false); assert(Object.isFrozen(value));
  } assert.deepEqual(f.calls, []); } finally { f.cleanup(); }
});
test("failed and compensated outcomes remain accurate terminal outcomes rather than successful application", async () => {
  const f = fixture(); try { for (const status of ["failed", "compensated"]) { await f.seed(`terminal-${status}`, status); const value = f.observe(`terminal-${status}`);
    assert.equal(value.status, status); assert.equal(value.terminal, true); } assert.deepEqual(f.calls, []);
  } finally { f.cleanup(); }
});
test("closed observation identity rejects extra keys, accessors, symbols, invalid or unbounded ids before reading the journal", async () => {
  const f = fixture(); try {
    let reads = 0; f.coordinator.journal = { get() { reads++; throw Error("journal must not be read"); } };
    const good = { operationId: "original", providerKey: "test-provider" }, getter = { providerKey: "test-provider" };
    Object.defineProperty(getter, "operationId", { enumerable: true, get() { throw Error("getter must not run"); } });
    for (const value of [{ ...good, extra: true }, { ...good, [Symbol("extra")]: true }, getter, { ...good, operationId: "a".repeat(129) }, { ...good, operationId: "bad/id" }, { ...good, providerKey: "a".repeat(129) }, null, []]) assert.throws(() => f.coordinator.observeOperation("openclaw", value), { code: "invalid_operation_observation", status: 400 });
    assert.throws(() => f.coordinator.observeOperation("bad/backend", good), { code: "invalid_operation_observation" }); assert.equal(reads, 0);
  } finally { f.cleanup(); }
});
test("a corrupt durable journal fails closed instead of inferring absence or success", async () => {
  const f = fixture(); try { fs.writeFileSync(f.file, "{broken", { mode: 0o600 }); assert.throws(() => f.observe("original-corrupt"), { code: "journal_corrupt" }); assert.deepEqual(f.calls, []); }
  finally { f.cleanup(); }
});
test("a terminal entry with a mismatched result identity or outcome cannot authorize terminal UI release", async () => {
  const f = fixture(); try { await f.seed("original-mismatched", "applied"); const data = JSON.parse(fs.readFileSync(f.file));
    data.operations[0].result.operationId = "foreign-result"; fs.writeFileSync(f.file, JSON.stringify(data));
    assert.throws(() => f.observe("original-mismatched"), { code: "operation_receipt_unverified", status: 503 });
    data.operations[0].result.operationId = "original-mismatched"; data.operations[0].result.status = "failed"; fs.writeFileSync(f.file, JSON.stringify(data));
    assert.throws(() => f.observe("original-mismatched"), { code: "operation_receipt_unverified", status: 503 });
  } finally { f.cleanup(); }
});
test("actual loopback HTTP observes a persisted terminal receipt before coordinator readiness without backend calls", async () => {
  const { startStaticServer } = require("../app/static-server"); const f = fixture(); let server;
  try { await f.seed("http-original", "applied"); server = await startStaticServer(0, { registry: { backends: new Map() }, modelChangeCoordinator: f.coordinator });
    const url = `${server.url}/__api/models/config/operation?backend=openclaw&operationId=http-original&provider=test-provider`;
    const before = fs.readFileSync(f.file), response = await fetch(url); assert.equal(response.status, 200); const value = await response.json();
    assert.equal(value.status, "applied"); assert.equal(value.terminal, true); assert.equal(value.operationId, "http-original");
    assert.deepEqual(fs.readFileSync(f.file), before); assert.deepEqual(f.calls, []);
    const wrong = await fetch(url.replace("provider=test-provider", "provider=foreign-provider")); assert.equal(wrong.status, 404);
    assert.equal((await wrong.json()).code, "operation_scope_mismatch");
  } finally { await server?.close(); f.cleanup(); }
});
test("actual HTTP accepts only the closed GET observation query and rejects mutations, duplicates and extra data", async () => {
  const { startStaticServer } = require("../app/static-server"); const f = fixture(); let server;
  try { server = await startStaticServer(0, { registry: { backends: new Map() }, modelChangeCoordinator: f.coordinator });
    const base = `${server.url}/__api/models/config/operation`, good = "?backend=openclaw&operationId=absent-http&provider=test-provider";
    for (const suffix of ["", "?backend=openclaw&operationId=absent-http", good+"&provider=second", good+"&unexpected=value", "?backend=bad%2Fbackend&operationId=original&provider=test-provider"]) {
      const response = await fetch(base+suffix); assert.equal(response.status, 400); assert.equal((await response.json()).code, "invalid_operation_observation");
    }
    for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await fetch(base+good, { method })).status, 405);
    const response = await fetch(base+good); assert.equal(response.status, 200); const value = await response.json();
    assert.equal(value.status, "failed"); assert.equal(value.code, "operation_not_admitted"); assert.equal(value.terminal, true); assert.deepEqual(f.calls, []); assert.equal(fs.existsSync(f.file), false);
  } finally { await server?.close(); f.cleanup(); }
});
test("actual HTTP missing observer returns unavailable instead of treating an empty pending list as success", async () => {
  const { startStaticServer } = require("../app/static-server"); const server = await startStaticServer(0, { registry: { backends: new Map() } });
  try { const response = await fetch(`${server.url}/__api/models/config/operation?backend=openclaw&operationId=missing-observer&provider=test-provider`);
    assert.equal(response.status, 503); assert.equal((await response.json()).code, "operation_observation_unavailable");
  } finally { await server.close(); }
});
test("restart recovery receives only durable pending identities before readiness, independent of catalog and backend", async () => {
  const f = fixture(); try {
    for (const status of ["in_progress", "partial", "blocked", "needs_secret", "cleanup_pending"]) await f.seed(`restart-${status}`, status);
    await f.seed("restart-done", "applied"); const before = fs.readFileSync(f.file), next = f.create();
    const value = next.listPendingIdentities("openclaw"); assert.equal(next.isReady(), false);
    assert.deepEqual(Object.keys(value), ["version", "backendId", "operations"]); assert.equal(value.version, 1); assert.equal(value.backendId, "openclaw");
    assert.equal(value.operations.length, 5); for (const entry of value.operations) {
      assert.deepEqual(Object.keys(entry), ["operationId", "providerKey", "status", "stage", "code"]);
      assert.equal(entry.operationId.startsWith("restart-"), true); assert.equal(Object.isFrozen(entry), true);
    }
    assert.equal(Object.isFrozen(value.operations), true); assert.equal(Object.isFrozen(value), true);
    for (const field of ["requestDigest", "previewTokenDigest", "source", "target", "fingerprints", "modelDiff", "canary-internal-reference"])
      assert.equal(JSON.stringify(value).includes(field), false);
    assert.deepEqual(next.listPendingIdentities("hermes"), { version: 1, backendId: "hermes", operations: [] });
    assert.deepEqual(f.calls, []); assert.deepEqual(fs.readFileSync(f.file), before);
  } finally { f.cleanup(); }
});
test("invalid, unavailable, corrupt or over-capacity pending identity lists remain errors, never inferred empty", async () => {
  const f = fixture(); try {
    let reads = 0; f.coordinator.journal = { listPending() { reads++; return []; } };
    for (const backend of [null, "", "bad/backend", "b".repeat(129)]) assert.throws(() => f.coordinator.listPendingIdentities(backend), { code: "invalid_pending_observation" });
    assert.equal(reads, 0);
    const entry = { backendId: "openclaw", operationId: "pending-one", providerKey: "test-provider", status: "blocked", stage: "verify-ready" };
    for (const patch of [{ operationId: "bad/id" }, { providerKey: "bad/provider" }, { stage: "bad stage" }, { status: "applied" }]) {
      f.coordinator.journal = { listPending() { return [{ ...entry, ...patch }]; } };
      assert.throws(() => f.coordinator.listPendingIdentities("openclaw"), { code: "pending_observation_unverified", status: 503 });
    }
    f.coordinator.journal = { listPending() { return Array.from({ length: 513 }, (_, i) => ({ ...entry, operationId: `pending-${i}` })); } };
    assert.throws(() => f.coordinator.listPendingIdentities("openclaw"), { code: "pending_observation_unavailable", status: 503 });
    f.coordinator.journal = f.journal; fs.writeFileSync(f.file, "{corrupt", { mode: 0o600 });
    assert.throws(() => f.coordinator.listPendingIdentities("openclaw"), { code: "journal_corrupt" });
  } finally { f.cleanup(); }
});
test("actual HTTP pending identity projection is closed GET-only and unavailable cannot masquerade as empty", async () => {
  const { startStaticServer } = require("../app/static-server"); const f = fixture(); let server, absent;
  try {
    await f.seed("http-restart-pending", "cleanup_pending"); server = await startStaticServer(0, { registry: { backends: new Map() }, modelChangeCoordinator: f.coordinator });
    const base = `${server.url}/__api/models/config/pending-identities`, before = fs.readFileSync(f.file);
    const response = await fetch(base+"?backend=openclaw"); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), f.coordinator.listPendingIdentities("openclaw"));
    for (const suffix of ["", "?backend=", "?backend=bad%2Fbackend", "?backend=openclaw&backend=hermes", "?backend=openclaw&secret=ignored"]) {
      const invalid = await fetch(base+suffix); assert.equal(invalid.status, 400); assert.equal((await invalid.json()).code, "invalid_pending_observation");
    }
    for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await fetch(base+"?backend=openclaw", { method })).status, 405);
    absent = await startStaticServer(0, { registry: { backends: new Map() } });
    const missing = await fetch(`${absent.url}/__api/models/config/pending-identities?backend=openclaw`);
    assert.equal(missing.status, 503); assert.equal((await missing.json()).code, "pending_observation_unavailable");
    assert.deepEqual(f.calls, []); assert.deepEqual(fs.readFileSync(f.file), before);
  } finally { await server?.close(); await absent?.close(); f.cleanup(); }
});
test("explicit original recovery uses one provider-fenced durable operation, concurrent callers never repeat a completed recovery", async () => {
  const f = fixture(); try {
    await f.seed("explicit-recovery", "cleanup_pending"); f.coordinator.markReady();
    f.backend.recoverModelChange = async (entry, context) => { f.calls.push("recover"); assert.equal(entry.operationId, "explicit-recovery");
      assert.equal(context.operationId, entry.operationId); return { status: "applied", stage: "verify-ready" }; };
    const identity = { operationId: "explicit-recovery", providerKey: "test-provider" };
    const values = await Promise.all([f.coordinator.recoverOperation("openclaw", identity), f.coordinator.recoverOperation("openclaw", identity)]);
    assert.ok(values.every(v => v.status === "applied" && v.terminal && v.operationId === identity.operationId));
    assert.equal(f.calls.filter(v => v === "recover").length, 1); assert.equal(f.calls.includes("apply"), false);
    const before = fs.readFileSync(f.file); assert.equal((await f.coordinator.recoverOperation("openclaw", identity)).status, "applied");
    assert.deepEqual(fs.readFileSync(f.file), before); assert.equal(f.calls.filter(v => v === "recover").length, 1);
  } finally { f.cleanup(); }
});
test("a queued original recovery rejects a pruned-and-reused journal incarnation before backend lookup or any mutation", async () => {
  for (const variant of ["other-domain", "same-domain-new-digest", "same-request-new-incarnation"]) {
    let clock = Date.now(), release; const gate = new Promise(resolve => { release = resolve; });
    const f = fixture({ now: () => clock }); let blocked, queued;
    try {
      const id = `queued-${variant}`; await f.seed(id, "cleanup_pending"); f.coordinator.markReady();
      const original = f.journal.get(id);
      blocked = f.coordinator._withKeyedMutex("openclaw\0test-provider", () => gate);
      queued = f.coordinator.recoverOperation("openclaw", { operationId: id, providerKey: "test-provider" });
      // Attach rejection handling before releasing the FIFO to avoid a detached rejection.
      const rejection = assert.rejects(queued, { code: "operation_scope_mismatch", status: 404 });
      await f.journal.withExclusiveLock(`retire:${id}`, () => f.journal.finish(id, "compensated", { operationId: id, status: "compensated", stage: "verify-ready" }));
      clock += 31 * 24 * 60 * 60 * 1000;
      await f.journal.withExclusiveLock(`prune:${id}`, () => f.journal.prune()); assert.equal(f.journal.get(id), null);
      const providerKey = variant === "other-domain" ? "replacement-provider" : original.providerKey;
      await f.journal.withExclusiveLock(`replace:${id}`, () => f.journal.begin(createEntry({
        operationId: id, backendId: variant === "other-domain" ? "hermes" : original.backendId, providerKey,
        requestDigest: variant === "same-request-new-incarnation" ? original.requestDigest : hash(`replacement:${id}`),
        previewTokenDigest: variant === "same-request-new-incarnation" ? original.previewTokenDigest : hash(`replacement-preview:${id}`),
        kind: original.kind, mode: original.mode, source: original.source, target: { provider: providerKey, modelId: "replacement-model" },
      }, clock)));
      const before = fs.readFileSync(f.file); release(); await blocked; await rejection;
      assert.deepEqual(f.calls, []); assert.deepEqual(fs.readFileSync(f.file), before);
      assert.equal(f.journal.get(id).status, "in_progress");
    } finally { release(); await blocked?.catch(() => {}); await queued?.catch(() => {}); f.cleanup(); }
  }
});
test("compat continuation never returns or recovers a different backend's original operation in full or config-only modes", async () => {
  for (const mode of ["full", "config-only"]) for (const status of ["partial", "cleanup_pending", "needs_secret", "applied", "compensated"]) {
    const f = fixture(); try {
      const id = `scoped-compat-${mode}-${status}`, spec = { providerKey: "test-provider", providerMode: "existing", model: { id: "test-model", name: "Test" } };
      const { safeSpec } = normalizeModelChangeRequest(spec);
      await f.journal.withExclusiveLock(`seed:${id}`, () => {
        f.journal.begin(f.coordinator._createJournalEntry({ backendId: "openclaw", safeSpec, operationId: id,
          requestDigest: modelChangeRequestDigest(safeSpec), previewTokenDigest: hash(`preview:${id}`), fingerprints: {}, hasSecret: false, mode }));
        f.journal.finish(id, status, { operationId: id, status, stage: "verify-ready" });
      });
      const before = fs.readFileSync(f.file);
      await assert.rejects(f.coordinator.applyCompat("hermes", spec, { operationId: id }), { code: "operation_scope_mismatch", status: 404 });
      await assert.rejects(f.coordinator.apply("hermes", spec, { operationId: id }), { code: "operation_scope_mismatch", status: 404 });
      assert.deepEqual(f.calls, []); assert.deepEqual(fs.readFileSync(f.file), before);
    } finally { f.cleanup(); }
  }
});
test("queued compat continuation cannot recover an identically scoped request after its original journal incarnation was pruned", async () => {
  let clock = Date.now(), release; const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ now: () => clock }); let blocked, queued;
  try {
    const id = "compat-reused-incarnation", spec = { providerKey: "test-provider", providerMode: "existing", model: { id: "test-model", name: "Test" } };
    const { safeSpec } = normalizeModelChangeRequest(spec);
    const candidate = f.coordinator._createJournalEntry({ backendId: "openclaw", safeSpec, operationId: id,
      requestDigest: modelChangeRequestDigest(safeSpec), previewTokenDigest: hash(`preview:${id}`), fingerprints: {}, hasSecret: false, mode: "full" });
    await f.journal.withExclusiveLock(`seed:${id}`, () => { f.journal.begin(candidate); f.journal.finish(id, "cleanup_pending", { operationId: id, status: "cleanup_pending", stage: "recovery" }); });
    blocked = f.coordinator._withKeyedMutex("openclaw\0test-provider", () => gate);
    queued = f.coordinator.applyCompat("openclaw", spec, { operationId: id });
    const rejection = assert.rejects(queued, { code: "operation_scope_mismatch", status: 404 });
    await f.journal.withExclusiveLock(`retire:${id}`, () => f.journal.finish(id, "compensated", { operationId: id, status: "compensated", stage: "verify-ready" }));
    clock += 31 * 24 * 60 * 60 * 1000;
    await f.journal.withExclusiveLock(`prune:${id}`, () => f.journal.prune()); assert.equal(f.journal.get(id), null);
    await f.journal.withExclusiveLock(`replace:${id}`, () => f.journal.begin(createEntry({ operationId: id, backendId: candidate.backendId,
      providerKey: candidate.providerKey, requestDigest: candidate.requestDigest, previewTokenDigest: candidate.previewTokenDigest,
      kind: candidate.kind, mode: candidate.mode, source: candidate.source, target: candidate.target, modelDiff: candidate.modelDiff }, clock)));
    const before = fs.readFileSync(f.file); release(); await blocked; await rejection;
    assert.deepEqual(f.calls, []); assert.deepEqual(fs.readFileSync(f.file), before); assert.equal(f.journal.get(id).status, "in_progress");
  } finally { release(); await blocked?.catch(() => {}); await queued?.catch(() => {}); f.cleanup(); }
});
test("a different backend admitted during preview cannot supply the original backend's terminal receipt or receive its apply", async () => {
  const f = fixture(), effects = [], previews = new Map(); let enter, release, watchdog, original;
  const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
  const make = id => ({ id,
    async getModelChangeCapabilities() { return { supported: true, create: true, blockers: [] }; },
    async previewModelChange() { const count = (previews.get(id) || 0) + 1; previews.set(id, count);
      if (id === "openclaw" && count === 2) { enter(); await held; }
      return { references: [], blockers: [], runtimeApply: "hot", fingerprints: {} }; },
    async applyModelChange(_spec, context) { context.assertProviderLease(); effects.push(id); return { status: "applied", stage: "verify-ready" }; },
  });
  const backends = new Map(["openclaw", "hermes"].map(id => [id, make(id)]));
  f.coordinator.registry._activeGet = id => backends.get(id);
  f.coordinator.registry.listModelsSnapshot = async id => ({ models: [{ backendId: id, provider: "test-provider", id: "test-model" }], catalogRevision: hash(`catalog:${id}`) });
  try {
    f.coordinator.markReady(); const operationId = "preview-racing-operation", spec = { providerKey: "test-provider", providerMode: "existing", model: { id: "test-model", name: "Test" } };
    original = f.coordinator.applyCompat("openclaw", spec, { operationId });
    const rejected = assert.rejects(original, { code: "operation_scope_mismatch", status: 404 });
    await Promise.race([entered, new Promise((_, reject) => { watchdog = setTimeout(() => reject(Error("preview interleave timeout")), 5000); })]);
    clearTimeout(watchdog); assert.equal(f.journal.get(operationId), null);
    const concurrent = await f.coordinator.applyCompat("hermes", spec, { operationId }); assert.equal(concurrent.status, "applied");
    const before = fs.readFileSync(f.file); release(); await rejected;
    assert.deepEqual(effects, ["hermes"]); assert.deepEqual(fs.readFileSync(f.file), before); assert.equal(f.journal.get(operationId).backendId, "hermes");
  } finally { clearTimeout(watchdog); release(); await original?.catch(() => {}); f.cleanup(); }
});
test("absent, foreign or malformed original recovery cannot create an operation, and foreign backend receipt remains nonterminal", async () => {
  const f = fixture(); try {
    const identity = { operationId: "no-original", providerKey: "test-provider" };
    const absent = await f.coordinator.recoverOperation("openclaw", identity);
    assert.equal(absent.status, "failed"); assert.equal(absent.code, "operation_not_admitted"); assert.equal(absent.terminal, true);
    assert.equal(fs.existsSync(f.file), false); assert.deepEqual(f.calls, []);
    await f.seed("foreign-recovery", "cleanup_pending");
    await assert.rejects(f.coordinator.recoverOperation("hermes", { ...identity, operationId: "foreign-recovery" }), { code: "operation_scope_mismatch" });
    await assert.rejects(f.coordinator.recoverOperation("openclaw", { ...identity, operationId: "foreign-recovery", spec: {} }), { code: "invalid_operation_observation" });
    f.backend.recoverModelChange = async () => ({ status: "applied", stage: "verify-ready", operationId: "different-original" });
    const result = await f.coordinator.recoverOperation("openclaw", { ...identity, operationId: "foreign-recovery" });
    assert.equal(result.status, "partial"); assert.equal(result.terminal, false); assert.equal(result.code, "recovery_receipt_identity_mismatch");
  } finally { f.cleanup(); }
});
test("actual HTTP recovery requires explicit closed POST and ready provider fencing; GET and observations never resume", async () => {
  const { startStaticServer } = require("../app/static-server"); const f = fixture(); let server;
  try {
    await f.seed("http-original-recovery", "cleanup_pending");
    f.backend.recoverModelChange = async () => { f.calls.push("recover"); return { status: "compensated", stage: "verify-ready" }; };
    server = await startStaticServer(0, { registry: { backends: new Map() }, modelChangeCoordinator: f.coordinator });
    const path = `${server.url}/__api/models/config/operation/recover`, query = "?backend=openclaw&operationId=http-original-recovery&provider=test-provider";
    for (const method of ["GET", "PUT", "DELETE"]) assert.equal((await fetch(path+query, { method })).status, 405);
    for (const suffix of ["", query+"&provider=other", query+"&spec=ignored"]) assert.equal((await fetch(path+suffix, { method: "POST" })).status, 400);
    for (const body of ["null", "[]", '{"apiKey":"fixture-unwanted"}', '{"spec":{}}'])
      assert.equal((await fetch(path+query, { method: "POST", body, headers: { "Content-Type": "application/json" } })).status, 400);
    assert.notEqual((await fetch(path+query, { method: "POST" })).status, 200); assert.deepEqual(f.calls, []);
    f.coordinator.markReady(); const response = await fetch(path+query, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.status, "compensated");
    assert.equal(result.terminal, true); assert.equal(result.operationId, "http-original-recovery");
    assert.equal(f.calls.filter(v => v === "recover").length, 1); assert.equal(f.calls.includes("apply"), false);
  } finally { await server?.close(); f.cleanup(); }
});
(async () => { const passed = []; for (const { name, action } of tests) { await action(); passed.push(name); }
  console.log(JSON.stringify({ verified: true, groups: passed.length, tests: passed, boundary: "production coordinator and actual durable journal/HTTP; GET observations cause zero backend calls and zero file mutations; explicit original-operation POST recovery uses one controlled backend recovery, never a new apply; no actual Host/model/remote provider" }));
})().catch(error => { console.error(JSON.stringify({ verified: false, code: error.code || "OBSERVATION_UNIT_FAILED", message: error.message, stack: error.stack })); process.exitCode = 1; });
