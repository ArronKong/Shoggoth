"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { budget, privateDir, stateBytes, injectOneVerifyFailure, observeCall, observeBroker } = require("./plugin-managed-openclaw-provider-credential-real-host-fixture.cjs");
async function main() {
  const groups = [], minimum = 2 * 1024 ** 3 + 122129232 + 90;
  assert.equal(budget(minimum, 122129232, 90).sufficient, true);
  assert.equal(budget(minimum - 1, 122129232, 90).sufficient, false);
  assert.equal(budget(minimum - 1, 122129232, 90).missingBytes, 1);
  groups.push("exact original 2 GiB + pinned executable + three state-file snapshot threshold, one byte short rejected");
  for (const value of [-1, NaN, Infinity, 1.1]) assert.throws(() => budget(value, 10, 0), { code: "CREDENTIAL_REAL_BUDGET_INVALID" });
  groups.push("invalid or fractional budget inputs cannot lower reserve");
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-credential-real-preflight-")); fs.chmodSync(root, 0o700);
  try {
    assert.equal(privateDir(root).uid, process.getuid());
    const child = path.join(root, "child"), link = path.join(root, "symlink"); fs.mkdirSync(child, { mode: 0o700 }); fs.symlinkSync(child, link);
    assert.throws(() => privateDir(link), { code: "CREDENTIAL_REAL_PRIVATE_DIRECTORY_UNSAFE" });
    fs.chmodSync(child, 0o755); assert.throws(() => privateDir(child), { code: "CREDENTIAL_REAL_PRIVATE_DIRECTORY_UNSAFE" });
    groups.push("private root UID/mode/canonical no-symlink checks reject linked and relaxed root");
    const state = path.join(root, "state/state"); fs.mkdirSync(state, { mode: 0o700, recursive: true });
    for (const [suffix, size] of [["", 20], ["-wal", 30], ["-shm", 40]]) fs.writeFileSync(path.join(state, "openclaw.sqlite" + suffix), Buffer.alloc(size), { mode: 0o600 });
    assert.equal(stateBytes(root), 90); fs.unlinkSync(path.join(state, "openclaw.sqlite-shm")); fs.symlinkSync(path.join(state, "openclaw.sqlite"), path.join(state, "openclaw.sqlite-shm"));
    assert.throws(() => stateBytes(root), { code: "CREDENTIAL_REAL_DATABASE_UNSAFE" });
    groups.push("DB/WAL/SHM byte accounting is additive and refuses symlink state artifact without SQLite access");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  let expiry = Date.now() + 10000, verifications = 0, brandChecks = 0, finishCalls = 0;
  const original = Object.freeze({ get expiresAt() { return expiry; }, async verifyTarget() { verifications++; return true; },
    async finish(identity) { assert.equal(identity.operationId, "target"); finishCalls++; return true; } });
  const api = Object.freeze({ async acquireModelLease() { return original; }, async assertModelLease(lease) { assert.equal(lease, original); brandChecks++; return true; } });
  const fault = { operationId: "target", armed: true, injected: 0 }, wrapped = injectOneVerifyFailure(api, fault);
  assert.equal(await wrapped.acquireModelLease({ operationId: "ordinary" }), original);
  const lease = await wrapped.acquireModelLease({ operationId: "target" });
  assert.equal(await wrapped.assertModelLease(lease, { operationId: "target" }), true); assert.equal(brandChecks, 1);
  assert.equal(await lease.verifyTarget(), false); assert.equal(verifications, 1); assert.equal(fault.injected, 1);
  assert.equal(await lease.verifyTarget(), true); assert.equal(verifications, 2); assert.equal(fault.injected, 1);
  expiry += 123; assert.equal(lease.expiresAt, expiry); assert.equal(await lease.finish({ operationId: "target" }), true); assert.equal(finishCalls, 1);
  groups.push("test fault facade keeps original frozen Product brand/deadline/effects, performs real verification first and suppresses exactly one verdict");
  const calls = [], traced = injectOneVerifyFailure(api, fault, row => calls.push(row));
  const tracedLease = await traced.acquireModelLease({ operationId: "ordinary" });
  assert.notEqual(tracedLease, original); assert.equal(await traced.assertModelLease(tracedLease, { operationId: "ordinary" }), true);
  assert.equal(await tracedLease.verifyTarget(), true); assert.equal(tracedLease.expiresAt, expiry);
  assert.equal(calls.some(row => row.method === "lease.verifyTarget" && row.state === "ok"), true);
  const failure = Object.assign(new Error("private test data that must not be copied"), { code: "boundary_lowercase_error" });
  const raw = Promise.reject(failure); assert.equal(observeCall(row => calls.push(row), "raw.effect", "ordinary", () => raw), raw);
  await assert.rejects(raw, error => error === failure); await Promise.resolve();
  assert.equal(calls.some(row => row.code === failure.code && row.state === "error"), true);
  assert.equal(JSON.stringify(calls).includes(failure.message), false);
  const context = Object.freeze(Object.create(null));
  const originalBroker = Object.freeze({ createContext: () => context, observe: () => raw });
  const tracedBroker = observeBroker(originalBroker, row => calls.push(row));
  assert.equal(tracedBroker.createContext({ modelOwner: Object.freeze({}) }), context);
  assert.equal(tracedBroker.observe({ operationId: "ordinary", secret: failure.message }), raw);
  assert.equal(JSON.stringify(calls).includes(failure.message), false);
  assert.equal(observeCall(() => { throw failure; }, "observer.throw", "ordinary", () => original), original);
  groups.push("transparent safe diagnosis preserves original promise/object/error/lease brands and never records arguments or message text");
  process.stdout.write(JSON.stringify({ status: "PASS", groups: groups.length, cases: groups, hostStarts: 0, candidateCopies: 0 }) + "\n");
}
main().catch(error => { process.stderr.write(JSON.stringify({ status: "FAIL", code: error.code || "PREFLIGHT_ASSERTION_FAILED" }) + "\n"); process.exitCode = 1; });
