"use strict";

// Owned temporary files and a memory-only AES-GCM broker; no Keychain/Vault.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { EncryptedSecretStore } = require("../app/agent-service/encrypted-secret-store");
const { resolveServicePaths } = require("../app/agent-service/paths");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sg-memory-secret-delete-")); fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const key = crypto.randomBytes(32), gates = new Set(); let gate;
  const broker = {
    async encrypt(plain) {
      if (gate) { const captured = gate; gate = null; captured.entered.resolve(); await captured.release.promise; gates.delete(captured); }
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    async decrypt(value) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]);
    },
  };
  const store = new EncryptedSecretStore({ paths, cryptoBroker: broker, ...options }); await store.open();
  t.after(async () => { for (const pending of gates) pending.release.resolve(); await store.close(); key.fill(0); fs.rmSync(root, { recursive: true, force: true }); });
  const bytes = () => fs.readFileSync(paths.encryptedSecretsPath);
  const proof = ref => ({ kind: store.listMetadata().find(row => row.credentialRef === ref).kind, fingerprint: store.getCredentialFingerprint(ref) });
  return { root, paths, store, bytes, proof, broker, gate: () => { const value = { entered: deferred(), release: deferred() }; gate = value; gates.add(value); return value; } };
}
const ref = "memory-provider-credential-synthetic-one";
test("atomic delete removes the proved key, keeps unrelated entries and persists private ciphertext", async t => {
  const f = await fixture(t);
  await f.store.putIfRevision(ref, "synthetic-memory-secret-first", { kind: "external-provider-api-key" }, null);
  await f.store.putIfRevision("unrelated-token", "synthetic-unrelated-kept", { kind: "mcp-bearer" }, null);
  const cached = f.store.plaintextCache.get(ref), proof = f.proof(ref), revision = f.store.container.revision;
  assert.equal(await f.store.deleteIfFingerprint(ref, proof), true);
  assert.equal(f.store.container.revision, revision + 1); assert.equal(await f.store.get(ref), null);
  assert.ok(cached.every(byte => byte === 0)); assert.equal(f.store.matchesPlaintext("synthetic-memory-secret-first"), false);
  assert.equal(await f.store.get("unrelated-token"), "synthetic-unrelated-kept");
  const disk = JSON.parse(f.bytes()); assert.equal(Object.hasOwn(disk.credentials, ref), false);
  assert.equal(f.bytes().includes(Buffer.from("synthetic-")), false);
  assert.equal(fs.statSync(f.paths.encryptedSecretsPath).mode & 0o777, 0o600);
  await f.store.close(); await f.store.open(); assert.equal(await f.store.get(ref), null);
  assert.equal(await f.store.deleteIfFingerprint(ref, proof), false);
  assert.equal(f.store.container.revision, revision + 1);
});
test("kind/fingerprint mismatch and absent IDs preserve all bytes, revision and cache", async t => {
  const f = await fixture(t); await f.store.put(ref, "synthetic-memory-preserved", { kind: "external-provider-api-key" });
  const proof = f.proof(ref), before = f.bytes(), revision = f.store.container.revision, cached = f.store.plaintextCache.get(ref);
  await assert.rejects(f.store.deleteIfFingerprint(ref, { ...proof, kind: "mcp-bearer" }), { code: "SECRET_REVISION_CONFLICT" });
  await assert.rejects(f.store.deleteIfFingerprint(ref, { ...proof, fingerprint: "0".repeat(64) }), { code: "SECRET_REVISION_CONFLICT" });
  for (const absent of ["missing-ref", "constructor", "toString"]) assert.equal(await f.store.deleteIfFingerprint(absent, proof), false);
  assert.deepEqual(f.bytes(), before); assert.equal(f.store.container.revision, revision);
  assert.equal(f.store.plaintextCache.get(ref), cached); assert.equal(await f.store.get(ref), "synthetic-memory-preserved");
});
test("an earlier queued overwrite wins and an old delete cannot remove its replacement", async t => {
  const f = await fixture(t); await f.store.put(ref, "synthetic-memory-old", { kind: "external-provider-api-key" });
  const proof = f.proof(ref), gate = f.gate();
  const overwrite = f.store.put(ref, "synthetic-memory-new", { kind: "external-provider-api-key" });
  const deletion = f.store.deleteIfFingerprint(ref, proof), rejected = assert.rejects(deletion, { code: "SECRET_REVISION_CONFLICT" });
  await gate.entered.promise; gate.release.resolve(); await overwrite; await rejected;
  assert.equal(await f.store.get(ref), "synthetic-memory-new"); assert.equal(f.store.container.revision, 2);
  assert.notEqual(f.proof(ref).fingerprint, proof.fingerprint);
});
test("unrelated queued writes do not invalidate a per-entry deletion proof", async t => {
  const f = await fixture(t); await f.store.put(ref, "synthetic-memory-target", { kind: "external-provider-api-key" });
  const proof = f.proof(ref), gate = f.gate();
  const other = f.store.put("unrelated-ref", "synthetic-other-new", { kind: "plugin-secret" });
  const deletion = f.store.deleteIfFingerprint(ref, proof);
  await gate.entered.promise; gate.release.resolve(); await other; assert.equal(await deletion, true);
  assert.equal(await f.store.get("unrelated-ref"), "synthetic-other-new"); assert.equal(f.store.container.revision, 3);
});
test("caller mutation of an admitted proof cannot change the queued deletion", async t => {
  const f = await fixture(t); await f.store.put(ref, "synthetic-memory-proof", { kind: "external-provider-api-key" });
  const expected = f.proof(ref), gate = f.gate();
  const other = f.store.put("blocker", "synthetic-blocker", { kind: "plugin-secret" });
  const deletion = f.store.deleteIfFingerprint(ref, expected);
  expected.kind = "mcp-bearer"; expected.fingerprint = "0".repeat(64);
  await gate.entered.promise; gate.release.resolve(); await other; assert.equal(await deletion, true);
});
test("invalid deletion proofs cannot execute getters or enter the write queue", async t => {
  const f = await fixture(t); await f.store.put(ref, "synthetic-memory-invalid", { kind: "external-provider-api-key" });
  const proof = f.proof(ref), before = f.bytes(); let getters = 0;
  const accessor = { fingerprint: proof.fingerprint }; Object.defineProperty(accessor, "kind", { enumerable: true, get() { getters++; return proof.kind; } });
  const symbol = { ...proof, [Symbol("extra")]: true }, hidden = { ...proof }; Object.defineProperty(hidden, "extra", { value: true });
  for (const expected of [null, [], {}, { ...proof, unknown: true }, accessor, symbol, hidden, { ...proof, fingerprint: "invalid" }, { ...proof, kind: "unsupported" }]) {
    await assert.rejects(Promise.resolve().then(() => f.store.deleteIfFingerprint(ref, expected)), { code: "SECRET_REVISION_CONFLICT" });
  }
  assert.equal(getters, 0); assert.deepEqual(f.bytes(), before); assert.equal(f.store.container.revision, 1);
});
test("delete/recreate ABA changes the encrypted-entry proof even for the same synthetic plaintext", async t => {
  const f = await fixture(t); await f.store.put(ref, "synthetic-same-value", { kind: "external-provider-api-key" }); const old = f.proof(ref);
  await f.store.delete(ref); await f.store.put(ref, "synthetic-same-value", { kind: "external-provider-api-key" }); const before = f.bytes();
  await assert.rejects(f.store.deleteIfFingerprint(ref, old), { code: "SECRET_REVISION_CONFLICT" }); assert.deepEqual(f.bytes(), before);
  assert.equal(await f.store.deleteIfFingerprint(ref, f.proof(ref)), true);
});
test("failed atomic write preserves the proved key and a later retry can delete it", async t => {
  let broken = false; const injectedFs = Object.create(fs);
  injectedFs.renameSync = (...args) => { if (broken) throw Object.assign(new Error("synthetic rename failure"), { code: "EIO" }); return fs.renameSync(...args); };
  const f = await fixture(t, { fs: injectedFs }); await f.store.put(ref, "synthetic-delete-write-failure", { kind: "external-provider-api-key" });
  const proof = f.proof(ref), before = f.bytes(); broken = true;
  await assert.rejects(f.store.deleteIfFingerprint(ref, proof), { code: "SECRET_WRITE_FAILED" }); assert.deepEqual(f.bytes(), before);
  assert.equal(f.store.container.revision, 1); assert.equal(await f.store.get(ref), "synthetic-delete-write-failure");
  broken = false; assert.equal(await f.store.deleteIfFingerprint(ref, proof), true);
});
test("an earlier uncertain commit fences a queued conditional delete and retains its evidence", async t => {
  let broken = false; const injectedFs = Object.create(fs);
  injectedFs.fsyncSync = fd => { if (broken && fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error("synthetic directory failure"), { code: "EIO" }); return fs.fsyncSync(fd); };
  const f = await fixture(t, { fs: injectedFs }); await f.store.put(ref, "synthetic-uncertain-retained", { kind: "external-provider-api-key" });
  const proof = f.proof(ref); broken = true;
  const other = f.store.put("uncertain-other", "synthetic-uncertain-other", { kind: "plugin-secret" });
  const otherRejected = assert.rejects(other, { code: "SECRET_COMMIT_UNCERTAIN" });
  const deletion = f.store.deleteIfFingerprint(ref, proof), deletionRejected = assert.rejects(deletion, { code: "credentials_locked" });
  await otherRejected; await deletionRejected;
  assert.equal(f.store.commitUncertain, true); assert.ok(Object.hasOwn(f.store.container.credentials, ref));
  assert.ok(Object.hasOwn(JSON.parse(f.bytes()).credentials, ref));
});
test("close joins already admitted conditional deletion and denies later calls", async t => {
  const f = await fixture(t); await f.store.put(ref, "synthetic-close-target", { kind: "external-provider-api-key" });
  const proof = f.proof(ref), gate = f.gate();
  const other = f.store.put("close-blocker", "synthetic-close-blocker", { kind: "plugin-secret" });
  const deletion = f.store.deleteIfFingerprint(ref, proof), closing = f.store.close();
  await gate.entered.promise; gate.release.resolve(); await other; assert.equal(await deletion, true); await closing;
  assert.throws(() => f.store.deleteIfFingerprint(ref, proof), { code: "SECRET_STORE_CLOSED" });
  assert.equal(Object.hasOwn(JSON.parse(f.bytes()).credentials, ref), false);
});

const replacementRef = "memory-provider-credential-synthetic-replacement";
async function withReplacement(t) {
  const f = await fixture(t);
  await f.store.put(ref, "synthetic-previous-binding", { kind: "external-provider-api-key" });
  await f.store.put(replacementRef, "synthetic-replacement-binding", { kind: "external-provider-api-key" });
  return { ...f, expected: { ...f.proof(ref), retained: [{ credentialRef: replacementRef, ...f.proof(replacementRef) }] } };
}
test("conditional rotation cleanup deletes only the old entry while retaining the proved replacement", async t => {
  const f = await withReplacement(t);
  assert.equal(await f.store.deleteIfFingerprint(ref, f.expected), true);
  assert.equal(await f.store.get(ref), null);
  assert.equal(await f.store.get(replacementRef), "synthetic-replacement-binding");
  assert.equal(f.store.container.revision, 3);
});
test("a queued replacement overwrite preserves the old entry when rotation cleanup runs", async t => {
  const f = await withReplacement(t), gate = f.gate();
  const overwrite = f.store.put(replacementRef, "synthetic-replacement-newer", { kind: "external-provider-api-key" });
  const rejected = assert.rejects(f.store.deleteIfFingerprint(ref, f.expected), { code: "SECRET_REVISION_CONFLICT" });
  await gate.entered.promise; gate.release.resolve(); await overwrite; await rejected;
  assert.equal(await f.store.get(ref), "synthetic-previous-binding");
  assert.equal(await f.store.get(replacementRef), "synthetic-replacement-newer");
  assert.equal(f.store.container.revision, 3);
});
test("a queued replacement revocation prevents deleting the only remaining binding", async t => {
  const f = await withReplacement(t);
  const revoked = f.store.delete(replacementRef);
  const rejected = assert.rejects(f.store.deleteIfFingerprint(ref, f.expected), { code: "SECRET_REVISION_CONFLICT" });
  await revoked; await rejected;
  assert.equal(await f.store.get(ref), "synthetic-previous-binding");
  assert.equal(f.store.container.revision, 3);
});
test("all retained proofs are checked and mismatches do not touch disk or cache", async t => {
  const f = await withReplacement(t), before = f.bytes(), cached = f.store.plaintextCache.get(ref);
  for (const retained of [
    [{ credentialRef: replacementRef, ...f.proof(replacementRef), fingerprint: "0".repeat(64) }],
    [{ credentialRef: replacementRef, ...f.proof(replacementRef), kind: "plugin-secret" }],
    [f.expected.retained[0], { credentialRef: "absent-ref", ...f.proof(ref) }],
  ]) await assert.rejects(f.store.deleteIfFingerprint(ref, { ...f.proof(ref), retained }), { code: "SECRET_REVISION_CONFLICT" });
  assert.deepEqual(f.bytes(), before); assert.equal(f.store.plaintextCache.get(ref), cached);
  assert.equal(f.store.container.revision, 2);
});
test("caller mutation of retained proofs cannot alter a queued conditional cleanup", async t => {
  const f = await withReplacement(t), gate = f.gate();
  const other = f.store.put("retained-blocker", "synthetic-retained-blocker", { kind: "plugin-secret" });
  const deletion = f.store.deleteIfFingerprint(ref, f.expected);
  f.expected.retained[0].fingerprint = "0".repeat(64); f.expected.retained[0].credentialRef = "absent"; f.expected.retained.length = 0;
  await gate.entered.promise; gate.release.resolve(); await other; assert.equal(await deletion, true);
  assert.equal(await f.store.get(replacementRef), "synthetic-replacement-binding");
});
test("invalid retained schemas cannot execute getters or join the mutation queue", async t => {
  const f = await withReplacement(t), before = f.bytes(); let getters = 0;
  const accessor = {}; Object.defineProperty(accessor, "credentialRef", { enumerable: true, get() { getters++; return replacementRef; } });
  Object.assign(accessor, f.proof(replacementRef));
  const getterArray = []; Object.defineProperty(getterArray, "0", { enumerable: true, get() { getters++; return f.expected.retained[0]; } });
  const sparse = new Array(1), extra = [...f.expected.retained]; extra.extra = true;
  const symbolRow = { ...f.expected.retained[0], [Symbol("hidden")]: true };
  const topAccessor = { ...f.proof(ref) }; Object.defineProperty(topAccessor, "retained", { enumerable: true, get() { getters++; return []; } });
  const invalid = [null, {}, [accessor], getterArray, sparse, extra, [symbolRow], [f.expected.retained[0], f.expected.retained[0]],
    [{ credentialRef: ref, ...f.proof(ref) }], Array.from({ length: 129 }, (_, index) => ({ credentialRef: `ref-${index}`, ...f.proof(ref) }))];
  for (const retained of invalid) await assert.rejects(Promise.resolve().then(() => f.store.deleteIfFingerprint(ref, { ...f.proof(ref), retained })), { code: "SECRET_REVISION_CONFLICT" });
  await assert.rejects(f.store.deleteIfFingerprint(ref, topAccessor), { code: "SECRET_REVISION_CONFLICT" });
  assert.equal(getters, 0); assert.deepEqual(f.bytes(), before); assert.equal(f.store.container.revision, 2);
});

// One regression fixture checks both queued new-ref admission and unconditional deletion.
test("final committed parent-fsync uncertainty fences queued new-ref put and unconditional delete", async t => {
  let armed = false, backupRemoved = false, failures = 0, checkpoint, encryptedPath;
  const injectedFs = Object.create(fs);
  injectedFs.unlinkSync = target => {
    const result = fs.unlinkSync(target);
    if (armed && target.startsWith(encryptedPath + ".backup-")) backupRemoved = true;
    return result;
  };
  injectedFs.fsyncSync = fd => {
    if (armed && backupRemoved && fs.fstatSync(fd).isDirectory()) {
      armed = false; failures++; checkpoint = fs.readFileSync(encryptedPath);
      throw Object.assign(new Error("synthetic final parent fsync failure"), { code: "EIO" });
    }
    return fs.fsyncSync(fd);
  };
  const f = await fixture(t, { fs: injectedFs }); encryptedPath = f.paths.encryptedSecretsPath;
  const kept = "memory-provider-credential-final-fsync-kept", queued = "memory-provider-credential-final-fsync-queued";
  const first = "final-fsync-uncertain-first", kind = { kind: "external-provider-api-key" };
  await f.store.putIfRevision(kept, "synthetic-final-fsync-retained", kind, null);
  const gate = f.gate(); armed = true;
  const uncertain = f.store.putIfRevision(first, "synthetic-final-fsync-committed", kind, null);
  const firstRejected = assert.rejects(uncertain, error => error.code === "SECRET_COMMIT_UNCERTAIN" && error.committedUncertain === true);
  await gate.entered.promise;
  // These calls are admitted while the first encryption is physically held.
  const putRejected = assert.rejects(f.store.putIfRevision(queued, "synthetic-final-fsync-queued", kind, null), { code: "credentials_locked" });
  const deleteRejected = assert.rejects(f.store.delete(kept), { code: "credentials_locked" });
  gate.release.resolve(); await Promise.all([firstRejected, putRejected, deleteRejected]);
  assert.equal(failures, 1); assert.equal(backupRemoved, true); assert.equal(f.store.commitUncertain, true);
  assert.equal(fs.readdirSync(f.paths.stateDir).some(name => name.startsWith("encrypted-secrets.json.backup-") || name.endsWith(".tmp")), false);
  const disk = JSON.parse(f.bytes());
  assert.equal(disk.revision, 2); assert.equal(f.store.container.revision, 2); assert.deepEqual(f.bytes(), checkpoint);
  assert.ok(Object.hasOwn(disk.credentials, first)); assert.ok(Object.hasOwn(disk.credentials, kept));
  assert.equal(Object.hasOwn(disk.credentials, queued), false);
  // A stopped reopen verifies the actual Store parser can read the retained commit.
  await f.store.close(); await f.store.open(); assert.equal(f.store.commitUncertain, false);
  assert.equal(f.store.container.revision, 2); assert.equal(await f.store.get(kept), "synthetic-final-fsync-retained");
});
