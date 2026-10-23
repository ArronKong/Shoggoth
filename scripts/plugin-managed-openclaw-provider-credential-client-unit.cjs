#!/usr/bin/env node
"use strict";
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), { EventEmitter } = require("node:events");
const { createManagedOpenClawHostClient } = require("../app/managed-openclaw-host-client");
const { normalizeModelChangeRequest, modelChangeRequestDigest } = require("../app/core/model-change-validation");
const safeSpec = normalizeModelChangeRequest({ providerKey: "local", sourceModelId: "old", model: { id: "old" } }).safeSpec;
const identity = { operationId: "private-binding-test", requestDigest: modelChangeRequestDigest(safeSpec) };
const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-credential-brand-")); fs.chmodSync(root, 0o700); const repo = path.resolve(__dirname, "..");
function factory(mode, frames) { return (_file, { workerData: { port, channelId } }) => {
  let paused = false; const worker = new EventEmitter(), expiresAt = Date.now() + 120000;
  const binding = { token: "a".repeat(64), ...identity, generation: "physical-generation", writerNonce: "b".repeat(64) };
  const physical = { version: 1, backendId: "openclaw", ...identity, pid: 12345, startIdentity: "synthetic MessagePort only", nonce: binding.writerNonce,
    generation: binding.generation, runtimeRoot: "/private/tmp/schema-runtime", runtimeTreeSha256: "c".repeat(64), dataRoot: "/private/tmp/schema-host",
    interpreterPath: "/private/tmp/external-node", entryPath: "/private/tmp/schema-runtime/openclaw.mjs", expiresAt };
  const snapshot = () => ({ status: { backendId: "openclaw", state: paused ? "paused" : "absent", ownership: paused ? "managed" : "absent", dataRoot: physical.dataRoot,
    identity: paused ? { pid: physical.pid, startIdentity: physical.startIdentity, nonce: physical.nonce } : null, runtimeRoot: paused ? physical.runtimeRoot : null,
    candidateId: paused ? "d".repeat(64) : null, generation: paused ? physical.generation : null, selectionSupported: paused, adapterGeneration: paused ? "adapter" : null,
    adapterInstanceId: paused ? "instance" : null, counts: paused ? { totalActive: 0 } : null, operationId: paused ? identity.operationId : null }, endpoint: null, execution: null, observedAt: Date.now() });
  worker.terminate = async () => { port.close(); worker.emit("exit", 0); };
  port.on("message", frame => { frames.push(frame); if (frame.type === "cancel") return;
    let result = null;
    if (frame.command === "modelAcquire") { paused = true; result = { binding, expiresAt, value: true }; }
    if (frame.command === "modelAction") {
      if (frame.args.action === "credentialBind" && mode === "held") return;
      let value = frame.args.action === "credentialOwner" ? physical : true;
      if (frame.args.action === "credentialBind" && mode === "truthy") value = { accepted: true };
      if (frame.args.action === "credentialBind" && mode === "false") value = false;
      if (frame.args.action === "credentialBind" && mode === "absent") paused = false;
      result = { binding, expiresAt, value };
    }
    if (frame.command === "stopOwned") { paused = false; result = { ownership: "absent" }; }
    port.postMessage({ type: "response", channelId, id: frame.id, ok: true, result, error: null, snapshot: snapshot() });
  }); queueMicrotask(() => port.postMessage({ type: "ready", channelId, snapshot: snapshot() })); return worker;
}; }
function permit(owner) { return { version: 1, owner: { ownerId: "service-owner-one", capability: "e".repeat(64) },
  scope: { backendId: "openclaw", providerKey: "local", baseUrl: "https://model.example.test/v1", api: "openai-completions", ...identity },
  service: { instanceNonce: "f".repeat(48), pid: 23456, startedAt: Date.now() - 1000, protocolVersion: SERVICE_PROTOCOL_VERSION }, writer: owner }; }
const clients = [], groups = [];
async function setup(mode = "valid") { const frames = [], client = createManagedOpenClawHostClient({ stateDir: path.join(root, mode), serviceUserDataRoot: root,
  resourcesRoot: path.join(repo, "resources/external-plugin-host-patches"), adapterResourcesRoot: path.join(repo, "resources/external-plugin-adapters"),
  sourceRoot: "/opt/homebrew/lib/node_modules/openclaw", interpreterPath: (process.env.SHOGGOTH_TEST_OPENCLAW_NODE || require('node:path').join(require('node:os').homedir(), '.local', 'share', 'node', 'v24.21.0', 'bin', 'node')), architecture: "arm64", gatewayConfiguration: {}, workerFactory: factory(mode, frames) });
  clients.push(client); await client.ready; const lease = await client.modelApi.acquireModelLease({ ...identity, safeSpec }), owner = await lease.getCredentialOwner();
  return { client, lease, owner, frames }; }
async function main() { try {
  const f = await setup(); const original = permit(f.owner); const bind = f.lease.bindCredentialPermit(original); original.scope.providerKey = "caller-mutated";
  assert.equal(await bind, true); const bindFrame = f.frames.find(frame => frame.command === "modelAction" && frame.args.action === "credentialBind");
  assert.equal(bindFrame.args.params.permit.scope.providerKey, "local"); assert.deepEqual(Object.keys(bindFrame.args.params), ["permit"]);
  assert.equal(f.client.getEndpoint(), null); assert.equal(f.client.getExecution(), null);
  groups.push("original branded lease sends only captured closed permit and accepts exact true while ordinary endpoint/execution stay null");
  for (const patch of [{ operationId: "foreign" }, { requestDigest: "0".repeat(64) }]) {
    const bad = permit({ ...f.owner, ...patch }); Object.assign(bad.scope, patch); const before = f.frames.length;
    await assert.rejects(f.lease.bindCredentialPermit(bad)); assert.equal(f.frames.length, before);
  }
  for (const patch of [{ nonce: "0".repeat(64) }, { generation: "foreign" }]) { const before = f.frames.length;
    await assert.rejects(f.lease.bindCredentialPermit(permit({ ...f.owner, ...patch }))); assert.equal(f.frames.length, before); }
  groups.push("foreign operation/digest/nonce/generation cannot reach Worker even when permit schema itself is plausible");
  const before = f.frames.length;
  assert.throws(() => f.lease.modelRpc("config.get", {}, { credentialPhase: "candidate" }));
  assert.throws(() => f.lease.modelRpc("config.patch", { raw: "{}", baseHash: "1".repeat(64), replacePaths: [] }, { credentialPhase: "previous", secret: "x" }));
  assert.equal(f.frames.length, before);
  await f.lease.modelRpc("config.patch", { raw: "{}", baseHash: "1".repeat(64), replacePaths: [] }, { credentialPhase: "previous" });
  const phase = f.frames.at(-1); assert.equal(phase.args.params.credentialPhase, "previous"); assert.deepEqual(Object.keys(phase.args.params).sort(), ["credentialPhase", "method", "params"]);
  assert(!JSON.stringify(phase).includes("apiKey"));
  groups.push("private third phase is restricted to config.patch and travels outside public safeSpec/digest with zero plaintext key");
  await f.lease.modelRpc("config.get", {}, undefined); assert.deepEqual(Object.keys(f.frames.at(-1).args.params).sort(), ["method", "params"]);
  assert.throws(() => f.client.controller.request("external.provider.credential.lease.read", {}));
  groups.push("ordinary metadata RPC keeps old two-field contract and public supervisor request cannot forward credential Service methods");
  for (const mode of ["truthy", "false", "absent"]) { const other = await setup(mode);
    await assert.rejects(other.lease.bindCredentialPermit(permit(other.owner)), { code: "MANAGED_MODEL_CREDENTIAL_BINDING_INVALID" }); assert.equal(other.client.getEndpoint(), null); }
  groups.push("truthy/false/no-longer-paused binding receipt never authorizes ordinary readiness or fallback");
  const held = await setup("held"), pending = held.lease.bindCredentialPermit(permit(held.owner)); const rejected = assert.rejects(pending);
  await new Promise(resolve => setImmediate(resolve)); await held.client.close({ operationId: "close-held-binding", timeoutMs: 1000 }); await rejected;
  await assert.rejects(held.lease.getCredentialOwner(), { code: "MANAGED_MODEL_LEASE_UNTRUSTED" });
  assert(!held.frames.some(frame => frame.command === "modelAction" && frame.args.action === "rpc"));
  groups.push("owned close cancels pending binding and retires original brand before any config command or delayed credential continuation");
  process.stdout.write(JSON.stringify({ status: "PASS", groups: groups.length, cases: groups, hostStarts: 0, serviceRequests: 0, configWrites: 0,
    boundary: "real MessagePort with synthetic Worker receipts; actual Service owner verification and Host credential effects are separate" }) + "\n");
} finally { for (const client of clients) if (client.getStatus().state !== "closed") await client.close({ timeoutMs: 1000 }); fs.rmSync(root, { recursive: true, force: true }); } }
const watchdog = setTimeout(() => { process.stderr.write("credential client watchdog\n"); process.exit(2); }, 10000);
main().then(() => clearTimeout(watchdog), error => { clearTimeout(watchdog); process.stderr.write(error.stack + "\n"); process.exitCode = 1; });
