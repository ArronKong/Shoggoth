"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { credentialOwner, OWNER_KEYS } = require("../app/managed-openclaw-provider-credential");
const { createManagedOpenClawHostClient, _protocol: managedHostBoundary } = require("../app/managed-openclaw-host-client");
const { normalizeModelChangeRequest, modelChangeRequestDigest } = require("../app/core/model-change-validation");
const safeSpec = normalizeModelChangeRequest({ providerKey: "local", sourceModelId: "owner-test", model: { id: "owner-test" } }).safeSpec;
const identity = { operationId: "owner-query-test", requestDigest: modelChangeRequestDigest(safeSpec) };
const owner = () => ({ version: 1, backendId: "openclaw", ...identity, pid: 12345, startIdentity: "synthetic private-port schema test",
  nonce: "a".repeat(64), generation: "test-generation", runtimeRoot: "/private/tmp/schema-runtime", runtimeTreeSha256: "b".repeat(64),
  dataRoot: "/private/tmp/schema-private-host", interpreterPath: "/private/tmp/external-node", entryPath: "/private/tmp/schema-runtime/openclaw.mjs", expiresAt: Date.now() + 120000 });
const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-model-owner-unit-")); fs.chmodSync(root, 0o700);
const repo = path.resolve(__dirname, "..");
function factory(mode, captured) { return (_file, { workerData: { port, channelId } }) => {
  const worker = new EventEmitter(); let paused = false; const binding = { token: "c".repeat(64), ...identity, generation: "test-generation", writerNonce: "a".repeat(64) };
  worker.terminate = async () => { port.close(); worker.emit("exit", 0); };
  const snapshot = () => ({ status: { backendId: "openclaw", state: paused ? "paused" : "absent", ownership: paused ? "managed" : "absent",
    dataRoot: owner().dataRoot, identity: paused ? { pid: 12345, startIdentity: owner().startIdentity, nonce: binding.writerNonce } : null,
    runtimeRoot: paused ? owner().runtimeRoot : null, candidateId: paused ? "d".repeat(64) : null, generation: paused ? binding.generation : null,
    selectionSupported: paused, adapterGeneration: paused ? "adapter" : null, adapterInstanceId: paused ? "instance" : null,
    counts: paused ? { totalActive: 0 } : null, operationId: paused ? identity.operationId : null }, endpoint: null, execution: null, observedAt: Date.now() });
  port.on("message", frame => { captured.push(frame); if (frame.type === "cancel") return;
    let value = true, result = null; const expiresAt = Date.now() + 120000;
    if (frame.command === "modelAcquire") paused = true;
    if (frame.command === "modelAction" && frame.args.action === "credentialOwner") {
      value = { ...owner(), expiresAt };
      if (mode === "pid") value.pid++;
      if (mode === "generation") value.generation = "foreign-generation";
      if (mode === "entry") value.entryPath = "/private/tmp/foreign/openclaw.mjs";
      if (mode === "extra") value.controlToken = "x";
    }
    if (["modelAcquire", "modelAction"].includes(frame.command)) result = { binding, expiresAt, value };
    if (frame.command === "stopOwned") { paused = false; result = { ownership: "absent" }; }
    port.postMessage({ type: "response", channelId, id: frame.id, ok: true, result, error: null, snapshot: snapshot() });
  }); queueMicrotask(() => port.postMessage({ type: "ready", channelId, snapshot: snapshot() })); return worker;
}; }
async function main() { const groups = [], clients = []; try {
  const valid = credentialOwner(owner()); assert.equal(Object.keys(valid).length, 14); assert(Object.isFrozen(valid));
  assert.notEqual(path.dirname(valid.interpreterPath), valid.runtimeRoot);
  groups.push("exact frozen14 owner keeps real external pinned interpreter path; data alone does not mint authority");
  for (const [key, value] of [["pid", "12345"], ["operationId", 12], ["generation", 12], ["expiresAt", Date.now() - 1], ["expiresAt", Date.now() + 400000], ["entryPath", "/private/tmp/other.mjs"], ["dataRoot", "/private/tmp/../tmp/x"], ["nonce", "a"]])
    assert.throws(() => credentialOwner({ ...owner(), [key]: value }), { code: "MANAGED_MODEL_CREDENTIAL_OWNER_INVALID" });
  const accessor = owner(); Object.defineProperty(accessor, "nonce", { enumerable: true, get() { throw new Error("must not read accessor"); } });
  for (const value of [{ ...owner(), controlToken: "x" }, Object.create(owner()), accessor, { ...owner(), [Symbol("authority")]: true }])
    assert.throws(() => credentialOwner(value), { code: "MANAGED_MODEL_CREDENTIAL_OWNER_INVALID" });
  groups.push("malformed owner, prototype/accessor/symbol/extra authority and escaped paths reject without effects");
  assert.deepEqual(OWNER_KEYS.length, 14);
  managedHostBoundary.argsFor("modelAction", { binding: { token: "c".repeat(64), ...identity, generation: "test-generation", writerNonce: "a".repeat(64) }, action: "credentialOwner", params: {} });
  assert.throws(() => managedHostBoundary.argsFor("modelAction", { binding: { token: "c".repeat(64), ...identity, generation: "test-generation", writerNonce: "a".repeat(64) }, action: "credentialOwner", params: { callerOwner: owner() } }));
  groups.push("owner action accepts zero params; caller-supplied physical authority cannot enter private command");
  for (const mode of ["valid", "pid", "generation", "entry", "extra"]) {
    const frames = [], client = createManagedOpenClawHostClient({ stateDir: path.join(root, mode), resourcesRoot: path.join(repo, "resources/external-plugin-host-patches"),
      adapterResourcesRoot: path.join(repo, "resources/external-plugin-adapters"), serviceUserDataRoot: root, sourceRoot: "/opt/homebrew/lib/node_modules/openclaw",
      interpreterPath: (process.env.SHOGGOTH_TEST_OPENCLAW_NODE || require('node:path').join(require('node:os').homedir(), '.local', 'share', 'node', 'v24.21.0', 'bin', 'node')), architecture: "arm64", gatewayConfiguration: {}, workerFactory: factory(mode, frames) });
    clients.push(client); await client.ready;
    const before = frames.length; await assert.rejects(client.modelApi.acquireModelLease({ ...identity, safeSpec, credentialPermit: {} }), { code: "MANAGED_MODEL_IDENTITY_INVALID" }); assert.equal(frames.length, before);
    const lease = await client.modelApi.acquireModelLease({ ...identity, safeSpec });
    if (mode === "valid") { const reported = await lease.getCredentialOwner(); assert.equal(reported.pid, 12345); assert.equal(reported.operationId, identity.operationId); }
    else await assert.rejects(lease.getCredentialOwner(), { code: "MANAGED_MODEL_CREDENTIAL_OWNER_INVALID" });
    assert.equal(client.getEndpoint(), null); assert.equal(client.getExecution(), null);
    await client.close({ operationId: "close-" + mode, timeoutMs: 1000 });
    await assert.rejects(lease.getCredentialOwner(), { code: "MANAGED_MODEL_LEASE_UNTRUSTED" });
  }
  groups.push("real MessagePort client binds owner to original WeakMap receipt/current paused snapshot; foreign PID/generation/entry/extra fields fail, public acquire stays unchanged");
  groups.push("owned close retires getter brand and ordinary caches remain closed; no credential RPC/key or Host/model invocation is claimed");
  process.stdout.write(JSON.stringify({ status: "PASS", groups: groups.length, cases: groups, hostStarts: 0, modelRequests: 0, secretRequests: 0, boundary: "synthetic private-port/owner DTO only; Service physical verification and real Host proof are separate" }) + "\n");
} finally { for (const client of clients) if (client.getStatus().state !== "closed") await client.close({ timeoutMs: 1000 }); fs.rmSync(root, { recursive: true, force: true }); } }
main().catch(error => { process.stderr.write(error.stack + "\n"); process.exitCode = 1; });
