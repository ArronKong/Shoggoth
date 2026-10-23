#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { createManagedHermesProductHost, projectManagedHermesHostStatus } = require("../app/managed-hermes-product-host");
const { createManagedHermesProductAuth } = require("../app/managed-hermes-product-auth");
const { resolveManagedHermesProductInputs, prepareManagedHermesProductInput, materializeManagedHermesInput, _test } = require("../app/managed-hermes-product-inputs");
const { _protocol: supervisor } = require("../app/managed-hermes-host-supervisor");
function fixture({ healthy = true, waiting = false, closeFails = false, mismatch = false } = {}) {
  let mode = "existing", state = "absent", enabled = true, candidate = null;
  let copies = 0, activations = 0, stops = 0, clients = 0, unavailable = 0, ready = 0, release;
  const identity = { pid: 123, startIdentity: "captured start identity", nonce: "b".repeat(64) };
  const endpoint = { baseUrl: "http://127.0.0.1:9999", token: "e".repeat(64), identity,
    dataRoot: "/private/test/hermes", runtimeRoot: "/private/test/runtime", interpreterPath: "/private/test/runtime/venv/bin/python", entryPath: "/private/test/runtime/hermes_cli/main.py" };
  const execution = { runtimeRoot: endpoint.runtimeRoot, interpreterPath: endpoint.interpreterPath, entryPath: endpoint.entryPath,
    home: "/private/test/hermes/home", stateDir: endpoint.dataRoot, configPath: "/private/test/hermes/config.yaml", workspace: "/private/test/hermes/workspace", env: { TOKEN: endpoint.token } };
  const client = { ready: waiting ? new Promise(resolve => { release = resolve; }) : Promise.resolve(),
    getStatus: () => ({ state, ownership: state === "running" ? "managed" : "absent", selectionSupported: true,
      generation: "c".repeat(64), adapterGeneration: "adapter-current", identity: mismatch ? { ...identity, pid: 124 } : identity,
      dataRoot: endpoint.dataRoot, runtimeRoot: endpoint.runtimeRoot }),
    getEndpoint: () => state === "running" ? endpoint : null, getExecution: () => state === "running" ? execution : null,
    controller: { getCandidate: async args => { assert.deepEqual(args, {}); return candidate; },
      prepareCandidate: async args => { assert.deepEqual(args, {}); copies++; return candidate = { candidateId: "a".repeat(64) }; },
      activateCandidate: async args => { assert.equal(args.candidateId, candidate.candidateId); activations++; state = "running"; return { healthVerified: healthy }; },
      stopOwned: async args => { assert.equal(args.timeoutMs, 60000); stops++; state = "absent"; return { ownership: "absent" }; } },
    close: async () => { stops++; if (closeFails) { closeFails = false; throw Object.assign(Error("fixture failed"), { code: "MANAGED_HERMES_STOP_TIMEOUT" }); } state = "closed"; },
  };
  const host = createManagedHermesProductHost({ getMode: () => mode, setManagedMode: () => { mode = "managed"; },
    createClient: () => { clients++; state = "absent"; return client; }, getEnabled: () => enabled,
    onUnavailable: async () => { unavailable++; }, onReady: async () => { ready++; } });
  return { host, client, endpoint, release: () => release?.(), disconnect: () => { state = "unknown_writer"; }, setEnabled: value => { enabled = value; },
    counts: () => ({ copies, activations, stops, clients, unavailable, ready }) };
}
async function main() {
  const cases = [], f = fixture();
  assert.equal(f.host.getExecution(), undefined); assert.equal(f.counts().clients, 0);
  for (const input of [null, {}, { operationId: "bad/id" }, { operationId: "ok", sourceRoot: "/renderer" },
    { operationId: "ok", token: "secret" }, { operationId: "ok", authority: {} }, { operationId: "ok", policy: {} }]) {
    assert.throws(() => f.host.prepare(input), { code: "MANAGED_HOST_OPERATION_INVALID" });
  }
  const accessor = {}; Object.defineProperty(accessor, "operationId", { enumerable: true, get() { throw Error("getter invoked"); } });
  assert.throws(() => f.host.prepare(accessor), { code: "MANAGED_HOST_OPERATION_INVALID" }); assert.equal(f.counts().clients, 0);
  cases.push("existing mode is lazy; public operation cannot choose inputs/credential/authority or execute an accessor");
  f.host.prepare({ operationId: "prepare-one" }); assert.equal(f.host.getExecution(), null); assert.equal(f.host.getEndpoint(), null);
  f.host.prepare({ operationId: "prepare-one" }); assert.throws(() => f.host.restart({ operationId: "another" }), { code: "MANAGED_HOST_OPERATION_BUSY" });
  assert.throws(() => f.host.stop({ operationId: "prepare-one" }), { code: "MANAGED_HOST_OPERATION_CONFLICT" });
  assert.equal((await f.host.waitForOperation("prepare-one")).state, "running"); assert.equal(f.counts().copies, 1); assert.equal(f.counts().activations, 1);
  f.host.restart({ operationId: "restart-one" }); await f.host.waitForOperation("restart-one"); assert.equal(f.counts().copies, 1); assert.equal(f.counts().activations, 2);
  f.host.prepare({ operationId: "prepare-one" }); assert.equal(f.counts().activations, 2); assert.equal(f.host.getOperationStatus("prepare-one").selectionSupported, false);
  assert.throws(() => f.host.getOperationStatus("missing"), { code: "MANAGED_HOST_OPERATION_NOT_FOUND" });
  cases.push("original operation observes without another candidate/start; different operation busy/conflicting kind fail closed");
  const dto = f.host.getStatus(); assert.deepEqual(Object.keys(dto).sort(), ["version", "backendId", "mode", "state", "operationId", "selectionSupported", "errorCode"].sort());
  assert(!JSON.stringify(dto).includes("private")); assert(!JSON.stringify(dto).includes(f.endpoint.token)); assert.equal(dto.backendId, "hermes");
  assert.equal(projectManagedHermesHostStatus({ errorCode: "secret=value" }).errorCode, "MANAGED_HOST_ACTION_FAILED");
  assert.equal(projectManagedHermesHostStatus({ state: "running", selectionSupported: "true" }).selectionSupported, false);
  assert.equal(f.host.getModelApplyApi, undefined);
  cases.push("exact public DTO has no endpoint/token/paths/identity/model-apply API");
  const auth = createManagedHermesProductAuth({ host: f.host, legacyResolver: () => { throw Error("legacy called"); } });
  assert.equal(auth.getHttpHeaders(f.endpoint.baseUrl + "/api/config").Authorization, "Bearer " + f.endpoint.token);
  const ws = new URL(auth.getWebSocketUrl(f.endpoint.baseUrl)); assert.equal(ws.pathname, "/api/ws"); assert.equal(ws.searchParams.get("token"), f.endpoint.token);
  assert.throws(() => auth.getHttpHeaders("https://other.invalid/api/config"), { code: "MANAGED_HERMES_ENDPOINT_UNVERIFIED" });
  f.disconnect(); assert.equal(f.host.getStatus().state, "needs_verification"); assert.equal(f.host.getExecution(), null); assert.equal(f.host.getEndpoint(), null);
  assert.throws(() => auth.resolveEndpoint(), { code: "MANAGED_HERMES_ENDPOINT_UNVERIFIED" }); assert.equal(f.counts().clients, 1);
  cases.push("HTTP/WS authenticate only current private origin; lost exact ownership withdraws with no legacy fallback or replacement");
  for (const options of [{ healthy: "true" }, { mismatch: true }]) {
    const bad = fixture(options); bad.host.prepare({ operationId: "bad-proof" });
    assert.equal((await bad.host.waitForOperation("bad-proof")).state, "needs_verification"); assert.equal(bad.counts().ready, 0); assert.equal(bad.host.getEndpoint(), null);
    await bad.host.close();
  }
  cases.push("truthy health or changed PID identity cannot open product endpoint");
  await f.host.close(); assert.throws(() => f.host.prepare({ operationId: "after-close" }), { code: "MANAGED_HOST_CLOSING" });
  const retry = fixture({ closeFails: true }); retry.host.prepare({ operationId: "before-close" }); await retry.host.waitForOperation("before-close");
  await assert.rejects(retry.host.close(), { code: "MANAGED_HERMES_STOP_TIMEOUT" });
  assert.throws(() => retry.host.prepare({ operationId: "replace" }), { code: "MANAGED_HOST_CLOSING" });
  retry.host.stop({ operationId: "original-client-stop" }); assert.equal((await retry.host.waitForOperation("original-client-stop")).state, "stopped");
  assert.equal(retry.counts().clients, 1); assert.equal(retry.counts().activations, 1);
  const untouched = fixture(); untouched.host.prepare({ operationId: "before-worker" }); await untouched.host.close(); assert.equal(untouched.counts().clients, 0);
  cases.push("bounded owned close failure retains original owner; explicit stop reuses it; cancellation before lazy client starts no Worker");
  const disable = fixture(); disable.host.prepare({ operationId: "before-disable" }); await disable.host.waitForOperation("before-disable");
  disable.setEnabled(false); assert.equal(disable.host.getEndpoint(), null);
  assert.throws(() => disable.host.prepare({ operationId: "while-disabled" }), { code: "MANAGED_HOST_BACKEND_DISABLED" });
  await disable.host.suspend({ operationId: "disable-owned" }); disable.setEnabled(true);
  disable.host.prepare({ operationId: "explicit-enable" }); await disable.host.waitForOperation("explicit-enable"); assert.equal(disable.counts().clients, 2);
  const unknown = fixture({ closeFails: true }); unknown.host.prepare({ operationId: "unknown-disable" }); await unknown.host.waitForOperation("unknown-disable");
  unknown.setEnabled(false); await assert.rejects(unknown.host.suspend()); unknown.setEnabled(true);
  assert.throws(() => unknown.host.prepare({ operationId: "unsafe-enable" }), { code: "MANAGED_HOST_CLOSING" }); assert.equal(unknown.counts().clients, 1);
  unknown.host.stop({ operationId: "prove-old-exit" }); await unknown.host.waitForOperation("prove-old-exit"); unknown.host.prepare({ operationId: "safe-enable" }); await unknown.host.waitForOperation("safe-enable");
  assert.equal(unknown.counts().clients, 2); await disable.host.close(); await unknown.host.close();
  cases.push("disable withdraws immediately; only actual original owned exit permits a fresh explicit client");
  const current = { model: { default: "user-current", provider: "custom", base_url: "http://127.0.0.1:9", api_key: "private" },
    providers: { custom: { base_url: "http://127.0.0.1:9" } }, agent: { max_turns: 7 }, skills: { disabled: ["example"] },
    dashboard: { theme: "user", input_mode: "steer", process_isolation: { enabled: true } },
    plugins: { enabled: ["unknown"], entries: { shoggoth_shared_capabilities: { allow_selection_dispatch_gate: false } } },
    auxiliary: { summary: { model: "user-summary" }, title_generation: { enabled: true } } };
  const kept = supervisor.managedConfiguration({ model: { default: "stale-fixture" } }, current);
  assert.deepEqual(kept.model, current.model); assert.deepEqual(kept.providers, current.providers); assert.deepEqual(kept.agent, current.agent); assert.deepEqual(kept.skills, current.skills);
  assert.equal(kept.dashboard.theme, "user"); assert.equal(kept.dashboard.input_mode, "queue"); assert.equal(kept.dashboard.process_isolation.enabled, false);
  assert.deepEqual(kept.plugins.enabled, ["shoggoth_shared_capabilities"]); assert.equal(kept.plugins.entries.shoggoth_shared_capabilities.allow_selection_dispatch_gate, true);
  assert.equal(kept.auxiliary.title_generation.enabled, false); assert.deepEqual(kept.auxiliary.summary, current.auxiliary.summary);
  assert.equal(current.dashboard.input_mode, "steer"); assert.throws(() => supervisor.managedConfiguration({}, { model: new Date() }), { code: "MANAGED_HERMES_CONFIGURATION_INVALID" });
  cases.push("private current model/provider/agent/skills survive restart; trusted plugin/queue/isolation/title fences override without mutating input");
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sgh-hermes-product-unit-")); fs.chmodSync(root, 0o700);
  try {
    const source = path.join(root, ".hermes/hermes-agent");
    for (const dir of [".git", "venv/bin", ".hermes-runtime/python", "hermes_cli/web_dist"]) fs.mkdirSync(path.join(source, dir), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(source, "venv/bin/python"), "fake-not-run", { mode: 0o700 });
    fs.writeFileSync(path.join(source, "hermes_cli/main.py"), "fake-not-run"); fs.writeFileSync(path.join(source, "hermes_cli/web_dist/index.html"), "local");
    const found = resolveManagedHermesProductInputs({ homeDir: root, architecture: "arm64", runtimePath: "", hermesBin: "hermes" });
    assert.equal(found.sourceRoot, source); assert.equal(found.inputMode, "original"); assert(Object.isFrozen(found));
    assert.throws(() => resolveManagedHermesProductInputs({ homeDir: root, architecture: "x64" }), { code: "MANAGED_HERMES_LOCAL_RUNTIME_UNAVAILABLE" });
    assert.throws(() => resolveManagedHermesProductInputs({ homeDir: path.join(root, "missing"), architecture: "arm64" }), { code: "MANAGED_HERMES_LOCAL_RUNTIME_UNAVAILABLE" });
    await assert.rejects(prepareManagedHermesProductInput({ sourceRoot: source }), { code: "MANAGED_HERMES_NORMALIZATION_WORKER_REQUIRED" });
    await assert.rejects(materializeManagedHermesInput({ sourceRoot: source }), { code: "MANAGED_HERMES_NORMALIZATION_WORKER_REQUIRED" });
    const inventoryRoot = path.join(root, "inventory"); fs.mkdirSync(inventoryRoot, { mode: 0o700 });
    fs.writeFileSync(path.join(inventoryRoot, "allowed"), "local"); fs.mkdirSync(path.join(inventoryRoot, "__pycache__")); fs.writeFileSync(path.join(inventoryRoot, "__pycache__/excluded"), "cache");
    const inventory = _test.collect(inventoryRoot, () => {}); assert.deepEqual(inventory.records.map(row => row.path), ["allowed"]);
    fs.symlinkSync("/etc/hosts", path.join(inventoryRoot, "escape")); assert.throws(() => _test.collect(inventoryRoot, () => {}), { code: "HERMES_DEPENDENCY_LINK_ESCAPE" }); fs.unlinkSync(path.join(inventoryRoot, "escape"));
    let checks = 0; const copied = path.join(root, "copy");
    assert.throws(() => _test.copyRecords(inventoryRoot, copied, inventory, () => { if (++checks === 2) throw Object.assign(Error("cancel"), { code: "CANCELED" }); }), { code: "CANCELED" });
    assert.deepEqual(fs.readdirSync(copied), []);
    cases.push("main path discovery performs no Python/hash/copy; unknown/Intel inputs explicit unavailable; normalization main-thread call and escaping dependency reject; cancellation precedes file effect");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  process.stdout.write(JSON.stringify({ status: "PASS", groups: cases.length, cases, modelCalls: 0, globalWrites: 0, remoteCalls: 0 }) + "\n");
}
main().catch(error => { process.stderr.write(error.stack + "\n"); process.exitCode = 1; });
