#!/usr/bin/env node
"use strict";
// Fixed npm Host, sealed candidate and default Service physical verifier.
// Test-only replacements are two narrow fault deliveries: one verifyTarget
// verdict and one settlement ACK. No code seal, owner, receipt or key is forged.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const http = require("node:http"), { spawnSync } = require("node:child_process"), { Worker, MessageChannel } = require("node:worker_threads");
const REPO = path.resolve(__dirname, ".."), NODE = (process.env.SHOGGOTH_TEST_OPENCLAW_NODE || require('node:path').join(require('node:os').homedir(), '.local', 'share', 'node', 'v24.21.0', 'bin', 'node'));
const SOURCE = "/opt/homebrew/lib/node_modules/openclaw", CANDIDATE = "c57e0025979b2dab098c3dde4dd603e5eaed9f6f8059a8d023016355ce19d99a";
const RESERVE = 2 * 1024 ** 3, MODEL = "credential-local", SPARE = "credential-unused", PROVIDER = "probe";
const HEX = /^[a-f0-9]{64}$/u, OP = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = code => Object.assign(new Error(code), { code });
const need = (condition, code) => { if (!condition) throw fail(code); };
function privateDir(dir) {
  const stat = fs.lstatSync(dir);
  need(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && stat.uid === process.getuid()
    && fs.realpathSync(dir) === dir, "CREDENTIAL_REAL_PRIVATE_DIRECTORY_UNSAFE"); return stat;
}
function privateJson(file) {
  const before = fs.lstatSync(file);
  need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size < 1024 * 1024
    && before.uid === process.getuid() && (before.mode & 0o077) === 0, "CREDENTIAL_REAL_PRIVATE_FILE_UNSAFE");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const held = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.lstatSync(file);
    need([held, after, fs.fstatSync(fd)].every(s => ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every(k => s[k] === before[k])),
      "CREDENTIAL_REAL_PRIVATE_FILE_CHANGED"); return { bytes, value: JSON.parse(bytes) };
  } finally { fs.closeSync(fd); }
}
function processStart(pid) {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 1500, maxBuffer: 4096 });
  need(!result.error && !result.signal, "CREDENTIAL_REAL_PROCESS_IDENTITY_UNAVAILABLE");
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  if (result.status === 1 && !result.stdout.trim() && !result.stderr.trim()) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return null; }
  }
  throw fail("CREDENTIAL_REAL_PROCESS_IDENTITY_UNAVAILABLE");
}
function stateBytes(dataRoot) {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = path.join(dataRoot, "state/state/openclaw.sqlite" + suffix);
    if (!fs.existsSync(file)) continue;
    const stat = fs.lstatSync(file); need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
      && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, "CREDENTIAL_REAL_DATABASE_UNSAFE"); total += stat.size;
  }
  need(total <= 512 * 1024 * 1024, "CREDENTIAL_REAL_DATABASE_TOO_LARGE"); return total;
}
function budget(availableBytes, executableBytes, snapshotBytes) {
  need([availableBytes, executableBytes, snapshotBytes].every(n => Number.isSafeInteger(n) && n >= 0), "CREDENTIAL_REAL_BUDGET_INVALID");
  const requiredBytes = RESERVE + executableBytes + snapshotBytes;
  return { reserveBytes: RESERVE, executableBytes, snapshotBytes, requiredBytes, availableBytes,
    sufficient: availableBytes >= requiredBytes, missingBytes: Math.max(0, requiredBytes - availableBytes) };
}
function diskBudget(dataRoot) {
  const space = fs.statfsSync("/private/tmp");
  return budget(Number(space.bavail) * Number(space.bsize), fs.lstatSync(NODE).size, stateBytes(dataRoot));
}
function preflight(candidateRoot, repo = REPO) {
  need(typeof candidateRoot === "string" && candidateRoot.startsWith("/private/tmp/sg-managed-openclaw-model-")
    && path.normalize(candidateRoot) === candidateRoot, "CREDENTIAL_REAL_CANDIDATE_ROOT_INVALID");
  privateDir(candidateRoot); const stateDir = path.join(candidateRoot, "app-state"); privateDir(stateDir);
  const root = path.join(stateDir, "external-plugin-host-runtimes/openclaw");
  for (const dir of [path.dirname(root), root, path.join(root, "candidates")]) privateDir(dir);
  need(!fs.existsSync(path.join(root, ".mutation-lock")), "CREDENTIAL_REAL_MUTATION_OWNER_UNKNOWN");
  const pointer = privateJson(path.join(root, "candidate.json")).value;
  need(pointer.version === 1 && pointer.backendId === "openclaw" && pointer.candidateId === CANDIDATE && HEX.test(pointer.descriptorDigest),
    "CREDENTIAL_REAL_CANDIDATE_CHANGED");
  const dir = path.join(root, "candidates", CANDIDATE); privateDir(dir);
  const descriptor = privateJson(path.join(dir, "descriptor.json")), pin = require(path.join(repo, "app/managed-openclaw-runtime-pins.json")).hosts.openclaw;
  need(sha(descriptor.bytes) === pointer.descriptorDigest && descriptor.value.candidateId === CANDIDATE
    && descriptor.value.backendId === "openclaw" && descriptor.value.policyDigest === sha(JSON.stringify(pin))
    && descriptor.value.runtimeTreeSha256 === pin.outputTreeSha256 && descriptor.value.inputTreeSha256 === pin.inputTreeSha256,
  "CREDENTIAL_REAL_DESCRIPTOR_CHANGED");
  privateDir(path.join(dir, "runtime"));
  const interpreter = fs.lstatSync(NODE); need(interpreter.isFile() && !interpreter.isSymbolicLink(), "CREDENTIAL_REAL_INTERPRETER_UNSAFE");
  need(sha(fs.readFileSync(NODE)) === pin.interpreter.sha256, "CREDENTIAL_REAL_INTERPRETER_CHANGED");
  const after = fs.lstatSync(NODE); need(["dev", "ino", "size", "mtimeMs", "ctimeMs"].every(k => after[k] === interpreter[k]), "CREDENTIAL_REAL_INTERPRETER_CHANGED");
  // Existing private configuration may contain credentials from another owner.
  // This fixture only creates a previously absent default formal Host root.
  const dataRoot = path.join(stateDir, "external-plugin-host-data/openclaw/v1");
  need(!fs.existsSync(path.join(stateDir, "external-plugin-host-data")), "CREDENTIAL_REAL_DATA_OWNER_EXISTS");
  for (const name of ["encrypted-secrets.json", "external-provider-credentials.json"])
    need(!fs.existsSync(path.join(stateDir, name)), "CREDENTIAL_REAL_SERVICE_STATE_EXISTS");
  let historicalWriter = null;
  if (fs.existsSync(path.join(root, "active.json"))) {
    const old = privateJson(path.join(root, "active.json")).value;
    if (old.writer) {
      need(Number.isSafeInteger(old.writer.pid) && old.writer.pid > 0 && typeof old.writer.startIdentity === "string", "CREDENTIAL_REAL_HISTORICAL_OWNER_INVALID");
      const actual = processStart(old.writer.pid);
      need(actual !== old.writer.startIdentity, "CREDENTIAL_REAL_HISTORICAL_OWNER_ALIVE");
      historicalWriter = { pid: old.writer.pid, startIdentity: old.writer.startIdentity, originalProcessAbsent: actual === null,
        originalIncarnationEnded: actual !== old.writer.startIdentity, adopted: false };
    }
  }
  return { candidateRoot, stateDir, dataRoot, candidateId: CANDIDATE, descriptorDigest: pointer.descriptorDigest,
    runtimeRoot: path.join(dir, "runtime"), runtimeTreeSha256: pin.outputTreeSha256, fixedNodeSha256: pin.interpreter.sha256,
    historicalWriter, budget: diskBudget(dataRoot), metadataOnly: true, fullTreeSealRequiredInActualWorker: true };
}
function outputFile(file) {
  need(path.isAbsolute(file) && path.normalize(file) === file && file.startsWith("/private/tmp/"), "CREDENTIAL_REAL_OUTPUT_INVALID");
  need(!fs.existsSync(file), "CREDENTIAL_REAL_OUTPUT_ALREADY_EXISTS"); privateDir(path.dirname(file)); return file;
}
const SOURCE_FILES = [
  "app/managed-plugin-host-runtime.js", "app/managed-openclaw-runtime-pins.json", "app/managed-openclaw-host-client.js",
  "app/managed-openclaw-host-worker.js", "app/managed-openclaw-host-supervisor.js", "app/managed-openclaw-product-host.js",
  "app/managed-openclaw-product-model-api.js", "app/managed-openclaw-product-auth.js", "app/managed-openclaw-model-policy.js",
  "app/managed-openclaw-config-source-ledger.js", "app/managed-openclaw-config-revision.js", "app/managed-openclaw-provider-credential.js",
  "app/managed-openclaw-provider-credential-schema.js", "app/managed-openclaw-provider-credential-client.js",
  "app/managed-openclaw-provider-credential-policy.js", "app/managed-openclaw-provider-credential-finish.js",
  "app/managed-openclaw-provider-terminal-recovery.js", "app/managed-openclaw-provider-credential-broker.js",
  "app/core/managed-openclaw-model-apply.js", "app/core/openclaw-backend.js", "app/core/openclaw-local-runtime-scope.js",
  "app/core/openclaw-model-change.js", "app/core/openclaw-model-references.js", "app/core/openclaw-agent-config.js",
  "app/core/model-change-validation.js", "app/core/work-admission-gate.js", "app/core/upstream-endpoint-generation.js", "app/core/device-auth.js",
  "app/agent-service/server.js", "app/agent-service/paths.js", "app/agent-service/client.js", "app/agent-service/service-protocol-version.js",
  "app/agent-service/external-provider-credential-rpc.js", "app/agent-service/external-provider-credential-controller.js",
  "app/agent-service/external-provider-credential-writer.js", "app/agent-service/external-provider-credential-runtime.js",
  "app/agent-service/external-provider-credential-writer-worker.js", "app/agent-service/external-provider-credential-reconciliation.js",
  "app/agent-service/encrypted-secret-store.js", "app/agent-service/private-file.js", "app/agent-service/instance-state.js", "app/agent-service/security.js",
  ...["index.mjs", "transport.mjs", "package.json", "openclaw.plugin.json"].map(f => "resources/external-plugin-adapters/openclaw/" + f),
  "resources/external-plugin-host-patches/openclaw/2026.9.5-managed-v2/openclaw-2026.9.5-managed.json",
  "resources/external-plugin-host-patches/openclaw/2026.9.5-managed-v2/shoggoth-managed-runtime.mjs",
  "scripts/plugin-managed-openclaw-provider-credential-real-host-fixture.cjs",
];
function sourceHashes() { return Object.fromEntries(SOURCE_FILES.map(file => [file, sha(fs.readFileSync(path.join(REPO, file)))])); }
// Only observation is added to the actual default verifier's code Worker.
// Original stat/watch objects, listeners, guards, seals and replies are retained.
function observedAttestorBootstrap(config) {
  const fs = require("node:fs"), path = require("node:path"), { parentPort, workerData, threadId } = require("node:worker_threads");
  const write = row => { try { fs.appendFileSync(config.traceFile, JSON.stringify(row) + "\n", { mode: 0o600 }); } catch { /* no effect substitution */ } };
  const scope = path.join(workerData.stateDir, "external-plugin-host-runtimes/openclaw"), records = new Map();
  const eligible = target => typeof target === "string" && (target === scope || target.startsWith(scope + path.sep) || target === config.node);
  const label = target => target === config.node ? "fixed-interpreter" : path.relative(scope, target) || ".";
  const actualLstat = fs.lstatSync, actualWatch = fs.watch;
  fs.lstatSync = function(target, ...args) {
    const result = actualLstat.call(this, target, ...args);
    try { if (eligible(target) && args[0]?.bigint) {
      const keys = ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs", "uid"], current = Object.fromEntries(keys.map(key => [key, String(result[key])]));
      const previous = records.get(target), fields = previous ? keys.filter(key => current[key] !== previous.metadata[key]) : [];
      if (fields.length) write({ kind: "runtime-attestor-stat-change", path: label(target), fields });
      records.set(target, { metadata: current, kind: result.isDirectory() ? "directory" : result.isSymbolicLink() ? "link" : "file" });
    } } catch { /* metadata diagnosis cannot change the original stat */ }
    return result;
  };
  fs.watch = function(target, ...args) {
    const index = args.findIndex(value => typeof value === "function");
    if (index >= 0 && eligible(target)) { const original = args[index]; args[index] = function(event, filename) {
      write({ kind: "runtime-attestor-watch", path: label(target), event, file: typeof filename === "string" ? filename : null });
      return original.apply(this, arguments);
    }; }
    const watcher = actualWatch.call(this, target, ...args);
    if (eligible(target)) watcher.on("error", error => write({ kind: "runtime-attestor-watch-error", path: label(target),
      code: /^[A-Z][A-Z0-9_]{0,127}$/u.test(error.code || "") ? error.code : "WATCH_ERROR_UNCLASSIFIED" }));
    return watcher;
  };
  const limit = require("node:child_process").spawnSync("/bin/sh", ["-c", "ulimit -Sn"], { encoding: "utf8", timeout: 1500, maxBuffer: 128 });
  write({ kind: "runtime-attestor-worker", pid: process.pid, threadId, platform: process.platform, nodeVersion: process.versions.node,
    softFdLimit: limit.status === 0 && /^[0-9]+$/u.test(limit.stdout.trim()) ? Number(limit.stdout.trim()) : null,
    limitErrorCode: /^[A-Z][A-Z0-9_]{0,127}$/u.test(limit.error?.code || "") ? limit.error.code : null });
  parentPort.on("message", frame => { if (frame?.type === "close") write({ kind: "runtime-attestor-inventory", paths: records.size,
    directories: [...records.values()].filter(value => value.kind === "directory").length,
    files: [...records.values()].filter(value => value.kind === "file").length, links: [...records.values()].filter(value => value.kind === "link").length }); });
  require(path.join(config.repo, "app/agent-service/external-provider-credential-writer-worker.js"));
}
function observeAttestorWorkers(config) {
  const Module = require("node:module"), actualLoad = Module._load;
  const runtimeModule = path.join(config.repo, "app/agent-service/external-provider-credential-runtime.js"),
    workerModule = path.join(config.repo, "app/agent-service/external-provider-credential-writer-worker.js");
  Module._load = function(request, parent, isMain) {
    const actual = actualLoad.call(this, request, parent, isMain);
    if (request !== "node:worker_threads" || parent?.filename !== runtimeModule) return actual;
    return { ...actual, Worker: class extends actual.Worker {
      constructor(filename, options) { super(filename === workerModule ? config.bootstrap : filename, options); }
    } };
  };
  return () => { Module._load = actualLoad; };
}
// Transparent Worker-only observation. Real Host and default Service verifier
// are unmodified. The single ACK fault runs AFTER the real Service result.
function observedWorkerBootstrap(config) {
  const fs = require("node:fs"), path = require("node:path"), Module = require("node:module");
  const channelFile = path.join(config.repo, "app/managed-openclaw-provider-credential-client.js"), actualLoad = Module._load;
  const write = row => { try { fs.appendFileSync(config.traceFile, JSON.stringify(row) + "\n", { mode: 0o600 }); }
    catch { /* observational trace failures never replace the original transport effect */ } };
  const cp = require("node:child_process"), spawn = cp.spawnSync;
  cp.spawnSync = function(file, ...args) {
    const startedAt = Date.now(), result = spawn.call(this, file, ...args);
    if (typeof file === "string" && file.startsWith("/private/tmp/sg-managed-config-proof-") && Array.isArray(args[0])
      && typeof args[0][1] === "string" && args[0][1].includes("SELECT hmac_key FROM config_revision_keys WHERE id = 1")) {
      let stdoutClosedBool = false;
      try { const dto = JSON.parse(result.stdout); stdoutClosedBool = dto && Object.getPrototypeOf(dto) === Object.prototype
        && Object.keys(dto).length === 1 && typeof dto.matches === "boolean"; } catch { /* no stdout content is recorded */ }
      write({ kind: "revision-observer-exit", pid: result.pid || null, status: result.status, signal: result.signal || null,
        code: /^[A-Z][A-Z0-9_]{0,127}$/u.test(result.error?.code || "") ? result.error.code : null,
        durationMs: Date.now() - startedAt, stdoutBytes: Buffer.byteLength(result.stdout || ""), stderrBytes: Buffer.byteLength(result.stderr || ""),
        stdoutClosedBool, observerSafeFailureCount: (result.stderr || "").split("MANAGED_CONFIG_REVISION_OBSERVER_FAILED").length - 1 });
    }
    return result;
  };
  const ws = require(path.join(config.repo, "node_modules/ws")), send = ws.prototype.send;
  ws.prototype.send = function(bytes, ...args) {
    try { const frame = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes);
      if (frame.method?.startsWith("gateway.shoggoth.managed.")) write({ kind: "control-dispatch", method: frame.method,
        operationId: frame.params.operationId, generation: frame.params.generation, nonce: frame.params.nonce });
    } catch { /* no payload or credentials are logged */ }
    return send.call(this, bytes, ...args);
  };
  Module._load = function(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain), actual = actualLoad.call(Module, request, parent, isMain);
    if (resolved !== channelFile) return actual;
    return { ...actual, createManagedOpenClawProviderCredentialClient(options) {
      const channel = actual.createManagedOpenClawProviderCredentialClient(options), wrapped = {};
      for (const method of ["read", "assert", "settle", "observeTerminal"]) wrapped[method] = async (...args) => {
        const permit = args[0], writer = permit.writer;
        write({ kind: "service-channel", method, operationId: permit.scope.operationId,
          phase: ["read", "assert"].includes(method) ? args[1] : null,
          writerState: method === "observeTerminal" ? args[2] : null,
          physical: { pid: writer.pid, startIdentity: writer.startIdentity, nonce: writer.nonce, generation: writer.generation,
            expiresAt: writer.expiresAt, operationId: writer.operationId, requestDigest: writer.requestDigest } });
        const result = await channel[method](...args);
        if (method === "settle" && fs.existsSync(config.faultFile)) {
          const fault = JSON.parse(fs.readFileSync(config.faultFile));
          if (fault.kind === "settle-ack" && fault.operationId === permit.scope.operationId) {
            fs.unlinkSync(config.faultFile); write({ kind: "settle-ack-suppressed", operationId: permit.scope.operationId });
            throw Object.assign(new Error("fixture settlement delivery suppressed"), { code: "FIXTURE_SETTLEMENT_ACK_SUPPRESSED" });
          }
        }
        return result;
      };
      return Object.freeze(wrapped);
    } };
  };
  require(path.join(config.repo, "app/managed-openclaw-host-worker.js"));
}
function observeCall(observe, method, operationId, effect) {
  if (!observe) return effect();
  const startedAt = Date.now(), record = (state, error) => {
    const row = { method, operationId: typeof operationId === "string" && OP.test(operationId) ? operationId : null,
      state, durationMs: Date.now() - startedAt };
    if (error) row.code = /^[A-Za-z][A-Za-z0-9_:-]{0,127}$/u.test(error.code || "") ? error.code : "DIAGNOSTIC_EFFECT_FAILED";
    try { observe(row); } catch { /* diagnosis cannot change the original effect */ }
  };
  record("begin");
  try {
    const value = effect();
    if (value && typeof value.then === "function") value.then(() => record("ok"), error => record("error", error));
    else record("ok");
    return value;
  } catch (error) { record("error", error); throw error; }
}
function observeBroker(api, observe) {
  return Object.freeze(Object.fromEntries(Object.entries(api).map(([method, effect]) => [method,
    typeof effect === "function" ? (...args) => observeCall(observe, "broker." + method,
      args[0]?.scope?.operationId || args[0]?.operationId, () => effect(...args)) : effect])));
}
function injectOneVerifyFailure(api, fault, observe) {
  const originals = new WeakMap();
  return Object.freeze({ ...api,
    async acquireModelLease(args) {
      const lease = await observeCall(observe, "modelApi.acquireModelLease", args.operationId, () => api.acquireModelLease(args));
      if (args.operationId !== fault.operationId && !observe) return lease;
      const wrapped = {};
      for (const key of Object.keys(lease)) {
        if (key === "expiresAt") Object.defineProperty(wrapped, key, { enumerable: true, get: () => lease.expiresAt });
        else if (key === "verifyTarget") wrapped[key] = async (...params) => {
          const actual = await observeCall(observe, "lease." + key, args.operationId, () => lease.verifyTarget(...params));
          if (args.operationId === fault.operationId && fault.armed) { fault.armed = false; fault.injected++; return false; }
          return actual;
        };
        else if (typeof lease[key] === "function") wrapped[key] = (...params) => observeCall(observe,
          "lease." + key, args.operationId, () => lease[key](...params));
        else wrapped[key] = lease[key];
      }
      Object.freeze(wrapped); originals.set(wrapped, lease); return wrapped;
    },
    assertModelLease(lease, identity) { return observeCall(observe, "modelApi.assertModelLease", identity.operationId,
      () => api.assertModelLease(originals.get(lease) || lease, identity)); },
  });
}
async function until(action, label, ms = 45000) {
  const deadline = Date.now() + ms; while (Date.now() < deadline) { if (await action()) return; await delay(100); }
  throw fail("CREDENTIAL_REAL_TIMEOUT_" + label);
}
function safeIdentity(value) {
  return Object.fromEntries(["pid", "startIdentity", "nonce", "generation", "operationId", "requestDigest", "expiresAt"]
    .filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}
async function run(candidateRoot, reportFile, onlyPreflight) {
  const before = sourceHashes(), checked = preflight(candidateRoot), output = outputFile(reportFile);
  const report = { version: 1, status: "PENDING", verified: false, preflight: checked, groups: [], phase: "preflight", sourceBefore: before,
    modelRequests: 0, acceptedModelRequests: 0, rejectedModelRequests: 0, directNegativeCredentialRequests: 0, physicalChildren: [], operations: [], privateWorkerErrors: [], diagnosticCalls: [], globalWrites: 0, candidateCopies: 0,
    defaultPhysicalVerifier: true, testOnlyFaults: ["one verifyTarget false after actual verification", "one settle ACK suppressed after actual result"],
    boundary: "Actual fixed npm 2026.9.5 managed-v2 Host, sealed code, fixed Node, Product/Auth/Backend/Core/Main/Worker/default physical Service verifier and AES synthetic credentials; no Keychain/real provider/Electron UI/Coordinator proof" };
  if (onlyPreflight || !checked.budget.sufficient) {
    report.status = checked.budget.sufficient ? "READY_FOR_EXPLICIT_RUN" : "PENDING_SPACE";
    report.sourceAfter = sourceHashes(); assert.deepEqual(report.sourceAfter, before);
    report.sourceUnchanged = true; report.hostStarts = 0;
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    process.stdout.write(JSON.stringify({ status: report.status, verified: false, hostStarts: 0, budget: checked.budget, evidence: output }) + "\n"); return;
  }
  const { resolveServicePaths } = require("../app/agent-service/paths");
  const { requestService, readClientToken } = require("../app/agent-service/client"), { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
  const { createManagedOpenClawHostClient } = require("../app/managed-openclaw-host-client"), { createManagedOpenClawProductHost } = require("../app/managed-openclaw-product-host");
  const { createManagedOpenClawProductAuth } = require("../app/managed-openclaw-product-auth"), { OpenClawBackend } = require("../app/core/openclaw-backend");
  const { createManagedOpenClawProviderCredentialBroker } = require("../app/managed-openclaw-provider-credential-broker");
  const { createManagedOpenClawModelApply } = require("../app/core/managed-openclaw-model-apply"), { createWorkAdmissionGate } = require("../app/core/work-admission-gate");
  const { normalizeModelChangeRequest, modelChangeRequestDigest } = require("../app/core/model-change-validation");
  const { client: gatewayClient } = require("./plugin-managed-openclaw-real-host-fixture.cjs");
  const fixtureRoot = fs.realpathSync(fs.mkdtempSync(path.join(candidateRoot, "credential-fixture-"))); fs.chmodSync(fixtureRoot, 0o700);
  const userDataRoot = path.join(fixtureRoot, "service"); fs.mkdirSync(userDataRoot, { mode: 0o700 });
  const paths = resolveServicePaths({ userDataRoot, stateRoot: checked.stateDir, profileRoot: path.join(userDataRoot, "profile"), cacheRoot: path.join(userDataRoot, "cache"), trustedRoot: candidateRoot });
  const traceFile = path.join(fixtureRoot, "worker-safe-trace.jsonl"), faultFile = path.join(fixtureRoot, "one-delivery-fault.json");
  fs.writeFileSync(traceFile, "", { mode: 0o600 });
  const bootstrap = path.join(fixtureRoot, "observed-worker.cjs");
  fs.writeFileSync(bootstrap, "(" + observedWorkerBootstrap.toString() + ")(" + JSON.stringify({ repo: REPO, traceFile, faultFile }) + ");\n", { mode: 0o600 });
  report.fixtureRoot = fixtureRoot; report.workerBootstrapSha256 = sha(fs.readFileSync(bootstrap));
  const attestorBootstrap = path.join(fixtureRoot, "observed-default-attestor.cjs");
  fs.writeFileSync(attestorBootstrap, "(" + observedAttestorBootstrap.toString() + ")(" + JSON.stringify({ repo: REPO, traceFile, node: NODE }) + ");\n", { mode: 0o600 });
  report.attestorBootstrapSha256 = sha(fs.readFileSync(attestorBootstrap));
  const restoreAttestorLoader = observeAttestorWorkers({ repo: REPO, bootstrap: attestorBootstrap });
  const { createAgentService } = require("../app/agent-service/server");
  const trace = () => fs.readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).map(row => JSON.parse(row));
  const physical = new Map(), remember = writer => { if (writer?.pid && writer.startIdentity) physical.set(writer.pid + ":" + writer.startIdentity, safeIdentity(writer)); };
  const collect = () => { remember(worker?.getStatus()?.identity); for (const row of trace()) if (row.physical) remember(row.physical); };
  let worker, service, host, backend, broker, core, ordinary = null, closedService = true, cleanupVerified = false;
  let phase = "compose", mode = "existing", generation = 0, legacyCalls = 0, serviceEpoch = 0, modelFailure = null, expectedKey;
  const keyOne = "synthetic-fixture-" + crypto.randomBytes(12).toString("hex"), keyTwo = "synthetic-fixture-" + crypto.randomBytes(12).toString("hex");
  const keyCompensated = "synthetic-fixture-" + crypto.randomBytes(12).toString("hex"), keyThree = "synthetic-fixture-" + crypto.randomBytes(12).toString("hex");
  const keyRevoked = "synthetic-fixture-" + crypto.randomBytes(12).toString("hex"), keys = [keyOne, keyTwo, keyCompensated, keyThree, keyRevoked];
  const aesKey = crypto.randomBytes(32), cryptoCounts = { encrypt: 0, decrypt: 0 }, serviceIdentities = [];
  const cryptoBroker = { async open() {}, async close() {}, async encrypt(bytes) { cryptoCounts.encrypt++; const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
    return Buffer.concat([iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]); }, async decrypt(bytes) { cryptoCounts.decrypt++; const cipher = crypto.createDecipheriv("aes-256-gcm", aesKey, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]); } };
  const model = http.createServer((req, res) => {
    let bytes = 0, chunks = [];
    req.on("data", chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) { modelFailure = "MODEL_INPUT_BOUND"; req.destroy(); } else chunks.push(chunk); });
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")); chunks = [];
        need(req.method === "POST" && req.url === "/v1/chat/completions" && body.model === MODEL, "CREDENTIAL_REAL_MODEL_PROTOCOL");
        report.modelRequests++;
        const headerMatches = expectedKey === undefined ? req.headers.authorization === undefined : req.headers.authorization === "Bearer " + expectedKey;
        if (!headerMatches) { report.rejectedModelRequests++; res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "fixture authorization rejected", type: "authentication_error" } })); return; }
        report.acceptedModelRequests++;
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const [delta, finish_reason] of [[{ role: "assistant", content: "Formal credential Host model completed." }, null], [{}, "stop"]])
          res.write("data: " + JSON.stringify({ id: "credential-fixture", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta, finish_reason }] }) + "\n\n");
        res.end("data: [DONE]\n\n");
      } catch (error) { modelFailure = error.code || "MODEL_PROTOCOL_INVALID"; res.writeHead(500); res.end("fixture model protocol rejected"); }
    });
  });
  const guard = () => { need(!modelFailure, "CREDENTIAL_REAL_MODEL_PROTOCOL"); collect(); const current = diskBudget(checked.dataRoot);
    need(current.sufficient, "CREDENTIAL_REAL_DISK_RESERVE"); assert.deepEqual(sourceHashes(), before); return current; };
  const direct = (method, params) => requestService(paths, { id: crypto.randomUUID(), version: SERVICE_PROTOCOL_VERSION,
    token: readClientToken(paths), method: "external.provider.credential." + method, params }, { timeoutMs: 15000 });
  const liveConfig = () => privateJson(path.join(checked.dataRoot, "openclaw.json"));
  const provider = () => liveConfig().value.models.providers[PROVIDER];
  const control = async operationId => {
    const descriptor = privateJson(path.join(checked.dataRoot, "managed-control.json")).value, config = liveConfig().value;
    const connection = await gatewayClient("ws://127.0.0.1:" + config.gateway.port, config.gateway.auth.token);
    try { const actual = await connection.request("gateway.shoggoth.managed.status", { version: 1, controlToken: descriptor.controlToken,
      nonce: descriptor.nonce, operationId, deadlineAt: Date.now() + 10000, generation: worker.getStatus().generation });
      assert.equal(actual.runtimeRoot, checked.runtimeRoot); assert.equal(actual.runtimeTreeSha256, checked.runtimeTreeSha256);
      assert.equal(processStart(actual.pid), worker.getStatus().identity.startIdentity); remember({ ...actual, startIdentity: worker.getStatus().identity.startIdentity }); return actual;
    } finally { connection.close(); }
  };
  const normalChat = async (label, keyless = false) => {
    guard(); const baseline = report.acceptedModelRequests, rejected = report.rejectedModelRequests;
    await backend.listAgents(); const sessionKey = "agent:main:credential-" + label;
    let terminalState = null, actualRunId = null, historyResult = null;
    const socket = backend._ws, observe = bytes => {
      try { const frame = JSON.parse(bytes.toString("utf8"));
        if (frame.type === "event" && frame.event === "chat" && frame.payload?.sessionKey === sessionKey
          && frame.payload.runId === actualRunId && ["final", "error", "aborted"].includes(frame.payload.state)) terminalState = frame.payload.state;
      } catch { /* only exact authenticated Run event state is observed */ }
    };
    socket.on("message", observe);
    try {
      const operationId = crypto.randomUUID(), receipt = await backend.request("chat.send", {
        sessionKey, message: "Verify this private model credential.", idempotencyKey: operationId }, 15000);
      actualRunId = receipt.runId; need(typeof actualRunId === "string" && OP.test(actualRunId), "CREDENTIAL_REAL_CHAT_RECEIPT_INVALID");
      await until(async () => {
        const history = await backend.request("chat.history", { sessionKey, limit: 20 });
        const text = JSON.stringify(history);
        if (text.includes("Formal credential Host model completed.")) { historyResult = "model-completed"; return true; }
        if (keyless && (text.includes("No API key") || text.includes("api key") || terminalState === "error")) {
          historyResult = "host-requires-credential"; return true;
        }
        return false;
      }, "MODEL_HISTORY", 60000);
    } finally { socket.removeListener("message", observe); }
    await until(async () => (await control("observe-" + label)).snapshot?.idle === true, "MODEL_IDLE");
    assert.equal(report.rejectedModelRequests, rejected, "Host must not use an old or unbound credential");
    if (!keyless || historyResult === "model-completed") assert.equal(report.acceptedModelRequests, baseline + 1);
    else assert.equal(report.acceptedModelRequests, baseline);
    guard(); return { result: historyResult, actualAcceptedModels: report.acceptedModelRequests - baseline, oldKeySent: false };
  };
  async function startService() {
    service = createAgentService({ paths, repoRoot: REPO, prewarmMcpAuth: false, cryptoBroker, version: "fixed-host-credential-joint" });
    await service.start(); closedService = false; serviceEpoch++;
    const status = await requestService(paths, { id: crypto.randomUUID(), version: SERVICE_PROTOCOL_VERSION, token: readClientToken(paths), method: "service.status", params: {} });
    assert.equal(status.healthy, true); serviceIdentities.push(Object.fromEntries(["instanceNonce", "pid", "startedAt", "protocolVersion"].map(key => [key, status[key]])));
  }
  async function contextFor(spec, operationId) {
    guard(); await backend.listAgents(); const preview = await core.preview(spec), journal = [], signal = new AbortController();
    assert.deepEqual(preview.blockers, [], "formal preview blocker codes: " + JSON.stringify(preview.blockers.map(x => x.code)));
    const identity = { operationId, requestDigest: modelChangeRequestDigest(spec) };
    const context = { ...identity, journal, journalEntry: { fingerprints: preview.fingerprints, commitState: "precommit" }, providerLeaseSignal: signal.signal,
      assertProviderLease() { signal.signal.throwIfAborted(); return true; }, async recordStage(stage, data) { journal.push({ stage, data }); },
      async recordStep(data) { journal.push({ stage: "step", data }); }, async markCommitting(data) { journal.push({ stage: "committing", data }); },
      async markCommitted(data) { journal.push({ stage: "committed", data }); } };
    return { context, signal, scope: { backendId: "openclaw", providerKey: PROVIDER, baseUrl, api: "openai-completions", ...identity } };
  }
  async function apply(spec, operationId, secret, expected = "applied") {
    const op = await contextFor(spec, operationId), original = worker.getStatus().identity;
    const result = await core.apply(spec, op.context, secret === undefined ? undefined : { apiKey: secret }); collect();
    report.operations.push({ operationId, requestDigest: op.context.requestDigest, kind: spec.kind,
      result: Object.fromEntries(["status", "code", "stage", "needsVerification"].filter(k => result[k] !== undefined).map(k => [k, result[k]])),
      journalStages: op.context.journal.map(row => row.stage) });
    assert.equal(result.status, expected, "formal Core status " + result.status + ":" + result.code);
    for (const key of keys) assert.equal(JSON.stringify({ result, journal: op.context.journal }).includes(key), false);
    if (expected === "applied" || expected === "compensated") {
      assert.equal(host.getStatus().state, "running"); assert.equal((await control(operationId)).paused, false);
      assert.equal(gate.snapshot("openclaw").draining, false); assert.equal(processStart(original.pid), null);
    }
    guard(); return { ...op, result, original };
  }
  let baseUrl, gate; const verificationFault = { operationId: "fixed-credential-compensate", armed: false, injected: 0 };
  try {
    phase = "start-model"; await new Promise(resolve => model.listen(0, "127.0.0.1", resolve)); baseUrl = "http://127.0.0.1:" + model.address().port + "/v1";
    const models = [MODEL, SPARE].map(id => ({ id, name: id, input: ["text"], reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }));
    const gatewayConfiguration = { models: { mode: "replace", providers: { [PROVIDER]: { baseUrl, agentRuntime: { id: "openclaw" }, models } } },
      agents: { defaults: { model: { primary: PROVIDER + "/" + MODEL }, heartbeat: { every: "0m" } } }, tools: { profile: "minimal" } };
    host = createManagedOpenClawProductHost({ getMode: () => mode, setManagedMode: () => { mode = "managed"; }, getEnabled: () => true,
      createClient() { need(!worker, "CREDENTIAL_REAL_SECOND_WORKER_FORBIDDEN"); worker = createManagedOpenClawHostClient({ stateDir: checked.stateDir,
        supervisorStateDir: checked.stateDir, serviceUserDataRoot: userDataRoot, resourcesRoot: path.join(REPO, "resources/external-plugin-host-patches"),
        adapterResourcesRoot: path.join(REPO, "resources/external-plugin-adapters"), sourceRoot: SOURCE, interpreterPath: NODE, architecture: "arm64", gatewayConfiguration,
        workerFactory(_file, options) {
          const outer = options.workerData.port, { port1, port2 } = new MessageChannel(), commands = new Map();
          const actual = new Worker(bootstrap, { ...options, workerData: { ...options.workerData, port: port2 }, transferList: [port2] });
          outer.on("message", frame => {
            if (frame.type === "command") commands.set(frame.id, { command: frame.command, action: frame.args?.action || null,
              method: frame.args?.action === "rpc" ? frame.args.params?.method : null,
              operationId: frame.args?.operationId || frame.args?.binding?.operationId || null });
            try { port1.postMessage(frame); } catch { /* real disconnected port remains a failure */ }
          });
          port1.on("message", frame => {
            if (frame.type === "response") { const command = commands.get(frame.id); commands.delete(frame.id);
              if (frame.ok === false) report.privateWorkerErrors.push({ ...command,
                code: /^[A-Z][A-Z0-9_]{0,127}$/u.test(frame.error?.code || "") ? frame.error.code : "PRIVATE_WORKER_FAILED" });
            }
            try { outer.postMessage(frame); } catch { /* observer never substitutes a receipt */ }
          });
          const terminate = actual.terminate.bind(actual); actual.terminate = async () => { outer.close(); port1.close(); return terminate(); };
          return actual;
        } }); worker.onProgress(() => collect()); return worker; },
      async onUnavailable() { generation++; ordinary?.close(); ordinary = null; await backend?.stop(); },
      async onReady() { generation++; await backend?.start(); },
    });
    const legacy = { getGatewayUrl() { legacyCalls++; throw fail("CREDENTIAL_REAL_LEGACY_ACCESS"); }, resolveConnectAuth() { legacyCalls++; throw fail("CREDENTIAL_REAL_LEGACY_ACCESS"); },
      async resolveConnectAuthAsync() { legacyCalls++; throw fail("CREDENTIAL_REAL_LEGACY_ACCESS"); }, storeDeviceToken() { legacyCalls++; throw fail("CREDENTIAL_REAL_LEGACY_ACCESS"); }, clearDeviceToken() { legacyCalls++; throw fail("CREDENTIAL_REAL_LEGACY_ACCESS"); } };
    const auth = createManagedOpenClawProductAuth({ host, legacyResolver: legacy, credentialsDir: path.join(fixtureRoot, "operator-credentials"), dataRoot: checked.dataRoot, getGatewayGeneration: () => generation });
    backend = new OpenClawBackend({ getUpstreamUrl: () => host.getEndpoint()?.url || "", getOrigin: () => "http://127.0.0.1", authResolver: auth, getManagedExecution: () => host.getExecution() });
    phase = "start-formal-service"; await startService(); guard();
    phase = "activate-fixed-candidate"; host.prepare({ operationId: "fixed-credential-boot" });
    assert.equal((await host.waitForOperation("fixed-credential-boot")).state, "running"); collect();
    assert.equal(worker.getExecution().runtimeRoot, checked.runtimeRoot); assert.equal(worker.getStatus().dataRoot, checked.dataRoot);
    assert.equal(Object.hasOwn(provider(), "apiKey"), false); assert.equal(report.modelRequests, 0);
    const diagnose = row => report.diagnosticCalls.push(row);
    const modelApi = injectOneVerifyFailure(host.getModelApplyApi(), verificationFault, diagnose);
    broker = observeBroker(createManagedOpenClawProviderCredentialBroker({ paths, modelController: modelApi, timeoutMs: 15000 }), diagnose);
    gate = createWorkAdmissionGate(); core = createManagedOpenClawModelApply({ backend, modelController: modelApi, admissionGate: gate, credentialBroker: broker });
    const ownerContext = broker.createContext({ modelOwner: modelApi.captureModelOwner(), assertProviderLease: () => true });
    const providerSpec = () => ({ kind: "update-provider", providerKey: PROVIDER, patch: {} });
    report.groups.push("formal default Service verifier and real Worker activate the current sealed v2 candidate in the exact default stateDir data root; no initial key or model request");
    phase = "unmodified-set"; await apply(providerSpec(), "fixed-credential-set", keyOne); assert.equal(provider().apiKey, keyOne); expectedKey = keyOne;
    assert.equal((await direct("observe", { scope: { backendId: "openclaw", providerKey: PROVIDER, baseUrl, api: "openai-completions",
      operationId: "fixed-credential-set", requestDigest: modelChangeRequestDigest(providerSpec()) } })).hasSecret, true);
    const setModel = await normalChat("set"); assert.equal(setModel.result, "model-completed");
    report.groups.push("unmodified Core/Main/Service permit sets synthetic key; exact real Host paused restart/advance and authenticated resume drive one actual model with that key");
    phase = "cold-aes-reopen"; const cipherBefore = sha(fs.readFileSync(paths.encryptedSecretsPath)), decryptBefore = cryptoCounts.decrypt;
    for (const key of keys) assert.equal(fs.readFileSync(paths.encryptedSecretsPath, "utf8").includes(key), false);
    await service.stop(); closedService = true; await startService(); assert(cryptoCounts.decrypt > decryptBefore);
    assert.equal(sha(fs.readFileSync(paths.encryptedSecretsPath)), cipherBefore); assert.notEqual(serviceIdentities[0].instanceNonce, serviceIdentities[1].instanceNonce);
    report.groups.push("formal Service cold-reopens real AES-GCM Store and exact previous binding, changes Service nonce and leaves Host configuration untouched");
    phase = "rotate"; await apply(providerSpec(), "fixed-credential-rotate", keyTwo); assert.equal(provider().apiKey, keyTwo); expectedKey = keyTwo;
    await normalChat("rotate");
    const reject = await fetch(baseUrl + "/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + keyOne }, body: JSON.stringify({ model: MODEL, messages: [] }) }); assert.equal(reject.status, 401); report.directNegativeCredentialRequests++;
    report.groups.push("rotation after cold decrypt uses new key in actual Host model request and rejects the old synthetic credential at the local model endpoint");
    phase = "original-previous-compensation"; const configBefore = liveConfig().value, restoredModel = structuredClone(provider().models);
    const compensationSpec = normalizeModelChangeRequest({ providerKey: PROVIDER, sourceModelId: SPARE, model: { id: SPARE, name: "Must Be Compensated" } }).safeSpec;
    verificationFault.armed = true; await apply(compensationSpec, verificationFault.operationId, keyCompensated, "compensated");
    assert.equal(verificationFault.injected, 1); assert.equal(provider().apiKey, keyTwo); assert.deepEqual(provider().models, restoredModel);
    assert.deepEqual(liveConfig().value.agents, configBefore.agents); expectedKey = keyTwo; await normalChat("compensated");
    assert(trace().some(row => row.method === "read" && row.phase === "previous" && row.operationId === verificationFault.operationId));
    report.groups.push("one explicit verification failure triggers actual Core undo(previous); original Service credential restores exact old key/model/Agent domain, real paused restart/advance resumes usable old model");
    phase = "original-terminal-ack-loss"; const unknownSpec = providerSpec(), op = await contextFor(unknownSpec, "fixed-credential-terminal-unknown");
    fs.writeFileSync(faultFile, JSON.stringify({ kind: "settle-ack", operationId: op.context.operationId }), { flag: "wx", mode: 0o600 });
    const unknownResult = await core.apply(unknownSpec, op.context, { apiKey: keyThree }); collect();
    assert.equal(unknownResult.status, "cleanup_pending"); assert.equal(unknownResult.needsVerification, true);
    const paused = await control(op.context.operationId), rawBefore = liveConfig().bytes;
    assert.equal(paused.paused, true); assert.equal(paused.operationId, op.context.operationId); assert.equal(host.getEndpoint(), null); assert.equal(worker.getEndpoint(), null);
    const beforeObserve = trace().length, resumeCount = () => trace().filter(row => row.kind === "control-dispatch" && row.method.endsWith(".resume") && row.operationId === op.context.operationId).length;
    const initialResumes = resumeCount(); const observed = await broker.observe(op.scope, ownerContext);
    assert.equal(observed.state, "applied"); assert.equal((await control(op.context.operationId)).paused, true); assert.equal(resumeCount(), initialResumes);
    await assert.rejects(async () => core.apply(unknownSpec, op.context, { apiKey: keyThree }));
    await assert.rejects(async () => host.getModelApplyApi().recoverCredentialTerminal({ operationId: op.context.operationId, requestDigest: "a".repeat(64) }));
    assert.equal(resumeCount(), initialResumes); assert.deepEqual(liveConfig().bytes, rawBefore);
    const settlements = () => trace().filter(row => row.kind === "service-channel" && row.method === "settle" && row.operationId === op.context.operationId).length;
    assert.equal(settlements(), 1);
    const entry = { operationId: op.context.operationId, requestDigest: op.context.requestDigest, providerKey: PROVIDER, kind: unknownSpec.kind,
      source: { modelId: null }, secretStep: true, commitState: "committed" };
    phase = "original-terminal-explicit-recovery"; const recoverBaseline = trace().length;
    const recovered = await core.recover(entry, { ...op.context, journalEntry: entry }); assert.equal(recovered.status, "applied", "terminal recovery " + recovered.code);
    const resumed = await control(op.context.operationId); assert.equal(resumed.paused, false);
    for (const key of ["pid", "nonce", "generation"]) assert.equal(resumed[key], paused[key]);
    assert.equal(resumeCount(), initialResumes + 1); assert.equal(settlements(), 1); assert.deepEqual(liveConfig().bytes, rawBefore);
    const recoveryPhases = trace().slice(recoverBaseline).filter(row => row.kind === "service-channel").map(row => row.method);
    assert.deepEqual(recoveryPhases, ["observeTerminal", "observeTerminal"]); assert.equal(gate.snapshot("openclaw").draining, false);
    expectedKey = keyThree; await normalChat("terminal-recovered");
    report.terminalRecovery = { originalState: unknownResult.status, recoveredState: recovered.status, sameCapturedWriter: true,
      originalSettlementInvocations: settlements(), extraResumeDispatches: 1, newCredentialAuthority: 0, configReplayed: false,
      publicObservationResumeDispatches: 0, wrongDigestResumeDispatches: 0, safeObserverTraceRows: trace().length - beforeObserve };
    report.groups.push("original actual Service settle ACK suppression re-pauses exact Host; public observation/wrong digest/reapply execute zero effects; original Core journal recovery verifies paused/resumed physical proof and permits exactly one same-writer resume with zero key/config/settle replay");
    phase = "clear"; const clearSpec = { kind: "update-provider", providerKey: PROVIDER, patch: { clearApiKey: true } };
    await apply(clearSpec, "fixed-credential-clear"); assert.equal(Object.hasOwn(provider(), "apiKey"), false); expectedKey = undefined;
    const clearScope = { backendId: "openclaw", providerKey: PROVIDER, baseUrl, api: "openai-completions", operationId: "fixed-credential-clear", requestDigest: modelChangeRequestDigest(clearSpec) };
    assert.equal((await direct("observe", { scope: clearScope })).hasSecret, false);
    report.clearActualModel = await normalChat("clear", true);
    report.groups.push("bound clear removes actual provider key and Service secret; actual keyless model outcome is reported without claiming credential-free support or sending an old key");
    phase = "revoked-owner-fail-closed"; await backend.listAgents(); ordinary = await gatewayClient(host.getEndpoint().url, host.getEndpoint().token);
    const revokeSpec = normalizeModelChangeRequest({ providerKey: PROVIDER, sourceModelId: SPARE, model: { id: SPARE, name: "Revoked Must Not Write" } }).safeSpec;
    const identity = { operationId: "fixed-credential-revoked", requestDigest: modelChangeRequestDigest(revokeSpec) };
    const lease = await host.getModelApplyApi().acquireModelLease({ ...identity, safeSpec: revokeSpec }), writer = await lease.getCredentialOwner(); remember(writer);
    const ctx = broker.createContext({ modelOwner: host.getModelApplyApi().captureModelOwner(), assertProviderLease: () => true });
    const permit = await broker.prepareAndOpen({ scope: { backendId: "openclaw", providerKey: PROVIDER, baseUrl, api: "openai-completions", ...identity }, writer, action: "set", secret: keyRevoked }, ctx);
    await assert.rejects(async () => lease.bindCredentialPermit({ ...permit, scope: { ...permit.scope, operationId: "foreign-operation" } }));
    assert.equal(await lease.bindCredentialPermit(permit), true);
    const config = await lease.modelRpc("config.get", {}), exactBefore = liveConfig().bytes, wrong = { models: { providers: { [PROVIDER]: { apiKey: keyRevoked } } } };
    await assert.rejects(async () => lease.modelRpc("config.patch", { raw: JSON.stringify(wrong), baseHash: config.hash, replacePaths: [] }, { credentialPhase: "candidate" }));
    await direct("owner.close", { owner: permit.owner });
    const updatedModels = structuredClone(provider().models); updatedModels.find(m => m.id === SPARE).name = "Must Not Apply";
    await assert.rejects(async () => lease.modelRpc("config.patch", { raw: JSON.stringify({ models: { providers: { [PROVIDER]: { models: updatedModels } } } }), baseHash: config.hash,
      replacePaths: ["models.providers." + PROVIDER + ".models"] }, { credentialPhase: "candidate" }));
    assert.deepEqual(liveConfig().bytes, exactBefore); assert.equal((await control(identity.operationId)).paused, true);
    assert.equal(host.getEndpoint(), null); const modelBefore = report.modelRequests;
    // Acquire synchronously retires the product's ordinary connections. Use a
    // separately authenticated fixed Gateway connection to verify Host gating.
    const cfg = liveConfig().value, cached = await gatewayClient("ws://127.0.0.1:" + cfg.gateway.port, cfg.gateway.auth.token);
    try { await assert.rejects(cached.request("chat.send", { sessionKey: "agent:main:credential-revoked", message: "must remain paused", idempotencyKey: crypto.randomUUID() })); }
    finally { cached.close(); }
    assert.equal(report.modelRequests, modelBefore); assert.equal(legacyCalls, 0);
    report.groups.push("foreign permit, wire key and revoked original owner cannot authorize actual config patch; exact file bytes stay unchanged and real paused Host rejects ordinary model with zero fallback");
    phase = "owned-stop"; collect(); await host.close({ operationId: "fixed-credential-final-close", timeoutMs: 60000 });
    assert.equal(worker.getStatus().state, "closed"); assert.equal(worker.getStatus().ownership, "absent"); assert.equal(host.getEndpoint(), null);
    assert.equal(fs.existsSync(path.join(checked.dataRoot, "writer.fence")), false); collect();
    for (const child of physical.values()) assert.equal(processStart(child.pid), null);
    await service.stop(); closedService = true; await backend.stop(); cleanupVerified = true;
    report.groups.push("every captured fixed Host incarnation exits naturally via owned stop; Worker closes, default fence releases and formal Service stops; no global host or historical profile adoption");
    report.status = "PASS"; report.verified = true; report.sourceAfter = sourceHashes(); assert.deepEqual(report.sourceAfter, before);
    report.sourceUnchanged = true; report.cryptoCounts = cryptoCounts; report.serviceIdentities = serviceIdentities;
    report.physicalChildren = [...physical.values()].map(child => ({ ...child, exitConfirmed: true }));
    report.actualFixedHostStarts = physical.size; report.legacyCalls = legacyCalls; report.cleanupVerified = cleanupVerified;
    report.finalBudget = diskBudget(checked.dataRoot); report.phase = "completed";
    report.traceCounts = Object.fromEntries(["read", "assert", "settle", "observeTerminal"].map(method => [method, trace().filter(row => row.kind === "service-channel" && row.method === method).length]));
  } catch (error) {
    report.status = "FAIL"; report.verified = false; report.phase = phase;
    report.code = /^[A-Za-z][A-Za-z0-9_:-]{0,127}$/u.test(error.code || "") ? error.code : "CREDENTIAL_REAL_ASSERTION_FAILED";
    report.failureLocations = String(error.stack || "").split("\n").map(line => line.trim()).filter(line => line.startsWith("at ")).slice(0, 5);
    throw error;
  } finally {
    ordinary?.close(); broker?.retire();
    if (!cleanupVerified) {
      try { collect(); await host?.close({ operationId: "fixed-credential-failure-close", timeoutMs: 60000 });
        cleanupVerified = worker ? worker.getStatus().ownership === "absent" && worker.getStatus().state === "closed" : true;
      } catch (error) { cleanupVerified = false; report.cleanupCode = error.code || "CREDENTIAL_REAL_CLEANUP_UNVERIFIED"; }
      try { await backend?.stop(); } catch { cleanupVerified = false; }
      if (service && !closedService) try { await service.stop(); closedService = true; } catch { cleanupVerified = false; }
    }
    collect(); report.physicalChildren = [...physical.values()].map(child => { let exited = false; try { exited = processStart(child.pid) === null; } catch { /* retain unknown */ }
      return { ...child, exitConfirmed: exited }; }); cleanupVerified &&= report.physicalChildren.every(child => child.exitConfirmed);
    report.cleanupVerified = cleanupVerified; report.retainedOwnDataRoot = checked.dataRoot; report.originalCandidatePreserved = true;
    report.revisionObservers = trace().filter(row => row.kind === "revision-observer-exit");
    report.attestorDiagnostics = trace().filter(row => row.kind.startsWith("runtime-attestor-"));
    report.actualHostModelHttpRequests = report.modelRequests - report.directNegativeCredentialRequests;
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); aesKey.fill(0);
    restoreAttestorLoader();
    report.sourceAfter = sourceHashes(); report.sourceUnchanged = JSON.stringify(before) === JSON.stringify(report.sourceAfter);
    const encoded = JSON.stringify(report, null, 2) + "\n";
    for (const key of keys) assert.equal(encoded.includes(key), false, "synthetic material must not enter report");
    const safeTrace = fs.readFileSync(traceFile, "utf8"); for (const key of keys) assert.equal(safeTrace.includes(key), false);
    assert.equal(safeTrace.includes("controlToken"), false); assert.equal(safeTrace.includes("apiKey"), false);
    fs.writeFileSync(output, encoded, { flag: "wx", mode: 0o600 });
    process.stdout.write(JSON.stringify({ status: report.status, verified: report.verified, groups: report.groups.length,
      modelRequests: report.modelRequests, physicalChildren: report.physicalChildren.length, cleanupVerified, evidence: output }) + "\n");
  }
}
module.exports = { budget, preflight, privateDir, stateBytes, injectOneVerifyFailure, observedWorkerBootstrap, observeCall, observeBroker };
if (require.main === module) {
  const args = process.argv.slice(2), onlyPreflight = args[0] === "--preflight", offset = onlyPreflight ? 1 : 0;
  need(args.length === 2 + offset, "CREDENTIAL_REAL_ARGUMENTS_REQUIRED");
  run(args[offset], args[offset + 1], onlyPreflight).catch(error => {
    process.stderr.write(JSON.stringify({ status: "FAIL", code: /^[A-Za-z][A-Za-z0-9_:-]{0,127}$/u.test(error.code || "") ? error.code : "CREDENTIAL_REAL_ASSERTION_FAILED" }) + "\n");
    process.exitCode = 1;
  });
}
