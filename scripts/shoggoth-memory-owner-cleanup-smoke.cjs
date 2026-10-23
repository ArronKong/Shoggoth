"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));

// Fresh Product/SecretStore paths and an invented encryption key. The native
// shoggoth-e5 adapter receives only this in-process synthetic encoder: no real
// model, Runtime, Keychain, production config or network endpoint is accessed.
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "shoggoth-owner-cleanup-")); fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  const key = crypto.randomBytes(32), gates = [], calls = [];
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString(value) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([iv, cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]); },
    decryptString(value) { const bytes = Buffer.from(value), decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8"); } };
  const service = createAgentService({ paths, safeStorage, memoryCore: true, prewarmMcpAuth: false,
    version: "synthetic-memory-owner-cleanup", memoryCoreConfig: { memory: { search: { provider: "shoggoth-e5" } } } });
  await service.start();
  const engine = service.memoryEngine, profileId = DEFAULT_AGENT_PROFILE_ID;
  let queryGate = null;
  engine.embedding = { identity: "synthetic-owner-cleanup-v1", encode: async (text, purpose) => {
    calls.push({ text, purpose });
    if (queryGate && purpose === "query") { const current = queryGate; current.entered.resolve(); await current.gate.promise; }
    return [1, 0];
  } };
  const f = { root, paths, service, engine, profileId, calls,
    gate() { const value = deferred(); gates.push(value); return value; },
    holdQuery() { queryGate = { entered: deferred(), gate: f.gate() }; return queryGate; },
    async index(id = profileId) {
      engine.store.ensureProfile(id);
      await engine.propose({ profileId: id, scope: "agent", classification: "explicit", sourceRefs: [`user:cleanup-${id}`],
        content: "Amber observatory remembers the violet telescope." });
      const host = engine.host(id); await host.searchIndex.sync(); return host;
    },
    peer(id) { const peer = { ...service.productStore.getAgentProfile(profileId), id, agentId: `${id}-agent`,
      name: "Synthetic cleanup peer", isDefault: false, runtimeProfileId: `${id}-runtime` };
      for (const field of ["bindings", "bindingOperations", "bindingsRevision", "defaultBindingId"]) delete peer[field];
      service.productStore.putAgentProfile(peer); return id; },
  };
  t.after(async () => {
    for (const gate of gates) gate.resolve();
    try { await service.stop({ notify: false }); }
    finally { key.fill(0); fs.rmSync(root, { recursive: true, force: true }); }
  });
  return f;
}

test("revoked management admission still joins the actual held native provider before retirement returns", { timeout: 20_000 }, async t => {
  const f = await fixture(t), host = await f.index(), index = host.searchIndex;
  const unopened = f.peer("cleanup-unopened"), file = path.join(f.paths.agentsDir, unopened, "memory-core.sqlite");
  const existed = fs.existsSync(file), rows = index.db.prepare("SELECT * FROM memory_index_chunks ORDER BY id").all();
  const beforeQueries = f.calls.filter(value => value.purpose === "query").length;
  const original = index.searchOwner, query = f.holdQuery();
  const probing = index.search("synthetic cleanup comet", { record: false, minScore: 0 }).then(result => ({ result }), error => ({ error }));
  await Promise.race([query.entered.promise, probing.then(() => assert.fail("native query returned before reaching its physical gate"))]);
  const controller = new AbortController(); controller.abort(new Error("management admission withdrawn"));
  let returned = false;
  const retiring = f.engine.retireProviderOwners({ agentIds: [f.profileId, unopened], signal: controller.signal }).then(() => { returned = true; });
  try { await turn(); await turn(); assert.equal(returned, false); assert.ok(index.db.isOpen); }
  finally { query.gate.resolve(); }
  await retiring; await probing;
  assert.equal(original.closed, true); assert.equal(index.searchOwner, null);
  assert.equal(index.embeddingExecutor, null); assert.equal(f.engine.hosts.has(unopened), false);
  assert.equal(fs.existsSync(file), existed);
  assert.deepEqual(index.db.prepare("SELECT * FROM memory_index_chunks ORDER BY id").all(), rows);
  assert.equal(f.calls.filter(value => value.purpose === "query").length, beforeQueries + 1, "retirement cannot acquire or probe a replacement provider");
});

test("a Profile stopping behind a held job still retires its actual provider before catalog cleanup can proceed", { timeout: 20_000 }, async t => {
  const f = await fixture(t), host = await f.index(), index = host.searchIndex, original = index.searchOwner;
  const query = f.holdQuery(), job = f.gate(); f.engine.jobs.set(f.profileId, job.promise);
  const probing = index.search("synthetic cleanup comet", { record: false, minScore: 0 }).then(result => ({ result }), error => ({ error }));
  await Promise.race([query.entered.promise, probing.then(() => assert.fail("native query returned before reaching its physical gate"))]);
  let stopped = false; const stopping = f.engine.stopProfile(f.profileId).then(() => { stopped = true; });
  assert.equal(f.engine.profileSignal(f.profileId).aborted, true); assert.equal(f.engine.hosts.get(f.profileId), host);
  let retired = false;
  const retiring = f.engine.retireProviderOwners({ agentIds: [f.profileId], signal: f.engine.profileSignal(f.profileId) }).then(() => { retired = true; });
  try { await turn(); await turn(); assert.equal(retired, false); assert.equal(stopped, false); }
  finally { query.gate.resolve(); }
  await retiring; await probing;
  assert.equal(original.closed, true); assert.equal(retired, true); assert.equal(stopped, false);
  assert.equal(f.engine.hosts.get(f.profileId), host); assert.ok(index.db.isOpen);
  job.resolve(); await stopping;
  assert.equal(f.engine.hosts.has(f.profileId), false); assert.equal(index.db, null);
});

test("Service cleanup reports failures only after every other native index and local cleanup tail physically joins", { timeout: 20_000 }, async t => {
  const f = await fixture(t), first = await f.index(), peerId = f.peer("cleanup-held-peer"), second = await f.index(peerId);
  const query = f.holdQuery(), local = f.gate(), localEntered = deferred();
  const probing = second.searchIndex.search("synthetic cleanup comet", { record: false, minScore: 0 }).then(result => ({ result }), error => ({ error }));
  await Promise.race([query.entered.promise, probing.then(() => assert.fail("native query returned before reaching its physical gate"))]);
  const firstClose = first.searchIndex.close.bind(first.searchIndex), maintenanceClose = f.engine.maintenance.close.bind(f.engine.maintenance);
  const localClose = f.engine.localEmbeddingHost.close.bind(f.engine.localEmbeddingHost);
  let indexFailure = true, maintenanceFailure = true;
  t.mock.method(first.searchIndex, "close", async () => { if (indexFailure) { indexFailure = false; throw new Error("synthetic first index close failure"); } return firstClose(); });
  t.mock.method(f.engine.maintenance, "close", async () => { await maintenanceClose(); if (maintenanceFailure) { maintenanceFailure = false; throw new Error("synthetic maintenance close failure"); } });
  t.mock.method(f.engine.localEmbeddingHost, "close", async () => { localEntered.resolve(); await local.promise; return localClose(); });
  let returned = false;
  const closing = f.engine.close();
  const rejected = assert.rejects(closing, error => error instanceof AggregateError
    && error.errors.some(value => /first index/u.test(value.message)) && error.errors.some(value => /maintenance/u.test(value.message)));
  closing.finally(() => { returned = true; }).catch(() => {});
  try {
    await turn(); await turn(); assert.equal(returned, false, "one rejected index cannot detach another held index");
    assert.ok(first.database.db.isOpen); assert.ok(second.database.db.isOpen);
    query.gate.resolve(); await probing; await localEntered.promise;
    assert.equal(returned, false, "local owner cleanup must also finish before Service close rejects");
    assert.ok(second.database.db.isOpen, "storage remains available until all physical cleanup succeeds");
  } finally { query.gate.resolve(); local.resolve(); }
  await rejected;
  assert.equal(second.searchIndex.db, null); assert.equal(f.engine.opened, false);
  assert.ok(first.database.db.isOpen); assert.ok(second.database.db.isOpen, "failed close preserves storage for an explicit cleanup retry");
  await f.engine.close();
  assert.equal(f.engine.hosts.size, 0); assert.equal(first.searchIndex.db, null);
});
