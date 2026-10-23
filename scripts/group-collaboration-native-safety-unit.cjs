#!/usr/bin/env node
"use strict";

// Execute the current helpers with closed fake adapters. No Service, SDK, auth
// reader, MCP, Provider, subprocess or network entrypoint is available here.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const syntheticError = code => Object.assign(new Error("synthetic failure"), { code });
const forbidden = label => () => { throw new Error(`Unexpected real boundary: ${label}`); };
const fakeHome = "/native-safety-fixture-home";
const fakeProcess = () => ({ getuid: () => 1000, exitCode: 0 });

function sandboxedHelper(name, modules, process = fakeProcess()) {
  const filename = path.join(__dirname, name);
  const source = fs.readFileSync(filename, "utf8");
  const module = { exports: {} };
  const closedRequire = name => {
    assert.ok(Object.hasOwn(modules, name), `Unapproved module in pure fixture: ${name}`);
    return modules[name];
  };
  closedRequire.main = null; // Never execute the worker command-line entrypoint.
  vm.runInNewContext(source, {
    module, exports: module.exports, require: closedRequire, process, Buffer,
    __filename: filename, __dirname: path.dirname(filename),
  }, { filename, timeout: 1000 });
  return module.exports;
}

function nativeReaderFixture({ automaticRefresh = false } = {}) {
  const wire = [], reads = [], hosts = [];
  const process = fakeProcess();
  const result = { status: "passed", codexNativeDefaults: {
    sourceConfigPath: path.join(fakeHome, ".codex", "config.toml"),
  } };
  const auth = {
    _createHost() {
      const host = {
        runtimeEnvironment: { home: path.join(fakeHome, ".codex") },
        options: { nativeAuthSource: true },
        spawnProcess: forbidden("native host spawn"),
        async initialize() { return {}; },
        rpc: { request(method, params) { wire.push({ method, params }); return {}; } },
      };
      hosts.push(host);
      return host;
    },
    async read(options) {
      reads.push(options);
      if (automaticRefresh) {
        const host = this._createHost();
        await host.initialize();
        await host.rpc.request("account/read", { refreshToken: false });
        await host.rpc.request("getAuthStatus", { includeToken: true, refreshToken: false });
        // Source-shaped near-expiry retry: the public read(false) must not
        // authorize this internal getAuthStatus(true) at the fake wire boundary.
        await host.rpc.request("account/read", { refreshToken: false });
        await host.rpc.request("getAuthStatus", { includeToken: true, refreshToken: true });
      }
      return { chatgptAccountId: "synthetic-account" };
    },
  };
  const api = sandboxedHelper("group-collaboration-live-worker.cjs", {
    "node:fs": { existsSync: forbidden("filesystem") },
    "node:path": path,
    "node:os": { homedir: () => fakeHome },
    "node:crypto": crypto,
    "node:child_process": { execFileSync: forbidden("subprocess") },
    "./group-collaboration-live-codes.cjs": {
      diagnosticCode: error => ({ errorCode: error?.code ?? "SYNTHETIC_ERROR" }),
    },
    "./group-collaboration-live-external.cjs": {
      captureOwnedProcesses: forbidden("process capture"),
      async verifyOwnedProcessesStopped(records) {
        assert.equal(records.length, 0);
        return { stopped: true, processEvidence: [] };
      },
    },
    "./group-collaboration-codex-defaults.cjs": {
      finalObservation: () => ({ sourceConfigUnchanged: true,
        metadataUnchanged: true, providerDefaultProofUnchanged: true }),
    },
  }, process);
  const originalCreate = auth._createHost, originalRead = auth.read;
  const service = { runtimePool: {
    hostFactory: forbidden("runtime acquisition"), options: { nativeAuth: auth },
  } };
  const observer = api.observeOwnedNativeProcesses({ service,
    profiles: [{ runtime: "codex", runtimeProfileId: "synthetic-profile" }], result });
  return { api, auth, hosts, wire, reads, result, process, observer,
    originalCreate, originalRead };
}

async function assertLatched(f, host) {
  assert.equal(f.result.codexAuthority.nativeReaderPolicyViolation, true);
  const wireCount = f.wire.length, readCount = f.reads.length;
  const reader = host || f.auth._createHost();
  if (!host) await reader.initialize();
  assert.throws(() => reader.rpc.request("account/read", { refreshToken: false }),
    { code: "GROUP_LIVE_CODEX_NATIVE_AUTH_POLICY_ALREADY_VIOLATED" });
  await assert.rejects(() => f.auth.read({ refreshToken: false }),
    { code: "GROUP_LIVE_CODEX_NATIVE_AUTH_POLICY_ALREADY_VIOLATED" });
  assert.equal(f.wire.length, wireCount);
  assert.equal(f.reads.length, readCount);
  f.api.finishCodexObservation(f.result, {});
  assert.equal(f.result.status, "failed");
  assert.equal(f.result.errorCode, "GROUP_LIVE_CODEX_NATIVE_AUTH_POLICY_ALREADY_VIOLATED");
  assert.equal(f.process.exitCode, 1);
  assert.equal(f.result.codexAuthority.automaticRefreshObserved, false);
  const cleanup = await f.observer.finish();
  assert.equal(cleanup.stopped, true);
  assert.equal(f.auth._createHost, f.originalCreate);
  assert.equal(f.auth.read, f.originalRead);
  assert.equal(f.result.status, "failed", "successful cleanup must not promote a policy violation");
}

test("Original account/read and getAuthStatus accept only explicit false at the fake wire", async () => {
  const f = nativeReaderFixture(), host = f.auth._createHost();
  await host.initialize();
  await host.rpc.request("account/read", { refreshToken: false });
  await host.rpc.request("getAuthStatus", { includeToken: true, refreshToken: false });
  assert.deepEqual(f.wire.map(row => row.method), ["account/read", "getAuthStatus"]);
  assert.ok(f.wire.every(row => row.params.refreshToken === false));
  assert.equal(f.result.codexAuthority.nativeReaderPolicyViolation, false);
  assert.equal(f.result.codexAuthority.blockedNativeReaderRequests, 0);
  await f.observer.finish();
});

test("read(false) reaches the fake authority adapter and records only synthetic identity", async () => {
  const f = nativeReaderFixture();
  await f.auth.read({ refreshToken: false });
  assert.equal(f.reads.length, 1);
  assert.equal(f.result.codexAuthority.accountIdentitySha256, sha("synthetic-account"));
  assert.equal(f.result.codexAuthority.credentialsExported, false);
  await f.observer.finish();
});

for (const method of ["account/read", "getAuthStatus"]) {
  for (const [label, params] of [["true", { refreshToken: true }],
    ["undefined field", { refreshToken: undefined }], ["undefined params", undefined],
    ["null", { refreshToken: null }], ["zero", { refreshToken: 0 }]]) {
    test(`${method} with ${label} is rejected before fake wire and latches failure`, async () => {
      const f = nativeReaderFixture(), host = f.auth._createHost();
      await host.initialize();
      assert.throws(() => host.rpc.request(method, params),
        { code: "GROUP_LIVE_CODEX_NATIVE_AUTH_REFRESH_FORBIDDEN" });
      assert.equal(f.wire.length, 0);
      assert.equal(f.result.codexAuthority.blockedNativeReaderRequests, 1);
      await assertLatched(f, host);
    });
  }
}

test("Original config/read is rejected before fake wire and cannot recover into success", async () => {
  const f = nativeReaderFixture(), host = f.auth._createHost();
  await host.initialize();
  assert.throws(() => host.rpc.request("config/read", { refreshToken: false }),
    { code: "GROUP_LIVE_CODEX_NATIVE_AUTH_METHOD_FORBIDDEN" });
  assert.equal(f.wire.length, 0);
  await assertLatched(f, host);
});

test("explicit read(true) is rejected before the authority adapter and latches failure", async () => {
  const f = nativeReaderFixture();
  await assert.rejects(() => f.auth.read({ refreshToken: true }),
    { code: "GROUP_LIVE_CODEX_NATIVE_AUTH_REFRESH_FORBIDDEN" });
  assert.equal(f.reads.length, 0);
  assert.equal(f.hosts.length, 0);
  assert.equal(f.wire.length, 0);
  await assertLatched(f);
});

test("Source-shaped automatic refresh is blocked despite an outer read(false)", async () => {
  const f = nativeReaderFixture({ automaticRefresh: true });
  await assert.rejects(() => f.auth.read({ refreshToken: false }),
    { code: "GROUP_LIVE_CODEX_NATIVE_AUTH_REFRESH_FORBIDDEN" });
  assert.equal(f.reads.length, 1);
  assert.deepEqual(f.wire.map(row => row.method), ["account/read", "getAuthStatus", "account/read"]);
  assert.ok(f.wire.every(row => row.params.refreshToken === false));
  assert.equal(f.result.codexAuthority.blockedNativeReaderRequests, 1);
  await assertLatched(f, f.hosts[0]);
});

function defaultsFixture(initialFault = null) {
  // These paths exist only in fakeFs; no real config, auth or proof file is read.
  const sourcePath = path.join(fakeHome, ".codex", "config.toml");
  const metadataPath = "/private/tmp/native-safety-fixture/metadata.json";
  const proofPath = "/private/tmp/native-safety-fixture/provider.rs";
  const sdkVersion = "synthetic-sdk";
  const source = Buffer.from("model = synthetic-model\nnon-secret synthetic config bytes\n");
  const proof = Buffer.from('required_model_provider().or(model_provider).or(cfg.model_provider).unwrap_or_else(|| "openai".to_string())');
  const record = { version: 1, path: sourcePath, sha256: sha(source),
    projection: { model: "synthetic-model", model_reasoning_effort: "high", service_tier: "default" },
    providerDefaultProof: { provider: "openai", pinnedVersion: sdkVersion, path: proofPath,
      sha256: sha(proof), originalHomeConfigReadSucceeded: false },
    unlistedConfigCopied: false, realModelRequests: 0 };
  const files = new Map([[sourcePath, source], [metadataPath, Buffer.from(JSON.stringify(record))], [proofPath, proof]]);
  const handles = new Map(), sourceBuffers = [];
  let nextFd = 1, fault = initialFault;
  const stat = file => ({ isFile: () => true, isSymbolicLink: () => false,
    uid: 1000, size: files.get(file).length, mode: 0o400, dev: 1,
    ino: [...files.keys()].indexOf(file) + 1, mtimeMs: 1, ctimeMs: 1 });
  const fakeFs = {
    constants: { O_RDONLY: 0, O_NOFOLLOW: 1 },
    lstatSync(file) { assert.ok(files.has(file)); return stat(file); },
    openSync(file) {
      assert.ok(files.has(file));
      const fd = nextFd++;
      handles.set(fd, { file, statCalls: 0 });
      return fd;
    },
    fstatSync(fd) {
      const handle = handles.get(fd);
      assert.ok(handle);
      handle.statCalls++;
      if (handle.file === sourcePath && handle.statCalls === 2) {
        if (fault === "post-read-fstat-error") throw syntheticError("SYNTHETIC_FSTAT");
        if (fault === "post-read-stat-drift") return { ...stat(handle.file), mtimeMs: 2 };
      }
      return stat(handle.file);
    },
    readFileSync(fd) {
      const handle = handles.get(fd);
      assert.ok(handle, "only fake file descriptors may be read");
      const bytes = Buffer.from(files.get(handle.file));
      if (handle.file === sourcePath) {
        if (fault === "hash-mismatch") bytes[0] ^= 1;
        assert.ok(bytes.some(byte => byte !== 0), "fixture must return nonzero config data");
        sourceBuffers.push(bytes); // Retain the actual Buffer returned to the helper.
      }
      return bytes;
    },
    closeSync(fd) {
      const handle = handles.get(fd);
      assert.ok(handle);
      handles.delete(fd);
      if (handle.file === sourcePath && fault === "close-error") throw syntheticError("SYNTHETIC_CLOSE");
    },
  };
  const api = sandboxedHelper("group-collaboration-codex-defaults.cjs", {
    "node:fs": fakeFs, "node:path": path, "node:crypto": crypto,
    "node:os": { homedir: () => fakeHome },
  });
  return { api, metadataPath, sdkVersion, sourceBuffers, handles,
    setFault(value) { fault = value; } };
}

function assertCleared(f, count) {
  assert.equal(f.sourceBuffers.length, count);
  for (const bytes of f.sourceBuffers) {
    assert.ok(Buffer.isBuffer(bytes));
    assert.ok(bytes.length > 0);
    assert.ok(bytes.every(byte => byte === 0), "every byte in each returned source Buffer must be zero");
  }
  assert.equal(f.handles.size, 0);
}

test("load and finalObservation clear both actual returned source Buffers on success", () => {
  const f = defaultsFixture();
  const snapshot = f.api.load(f.metadataPath, { sdkVersion: f.sdkVersion });
  assertCleared(f, 1);
  const result = f.api.finalObservation(snapshot);
  assert.equal(result.sourceConfigUnchanged, true);
  assert.equal(result.metadataUnchanged, true);
  assert.equal(result.providerDefaultProofUnchanged, true);
  assertCleared(f, 2);
});

const failures = [
  ["hash-mismatch", "GROUP_LIVE_CODEX_SOURCE_DEFAULTS_CHANGED"],
  ["post-read-fstat-error", "SYNTHETIC_FSTAT"],
  ["post-read-stat-drift", "GROUP_LIVE_CODEX_DEFAULTS_FILE_CHANGED"],
  ["close-error", "SYNTHETIC_CLOSE"],
];
for (const [fault, code] of failures) {
  test(`load clears its actual returned source Buffer after ${fault}`, () => {
    const f = defaultsFixture(fault);
    assert.throws(() => f.api.load(f.metadataPath, { sdkVersion: f.sdkVersion }), { code });
    assertCleared(f, 1);
  });
  test(`finalObservation clears its actual returned source Buffer after ${fault}`, () => {
    const f = defaultsFixture();
    const snapshot = f.api.load(f.metadataPath, { sdkVersion: f.sdkVersion });
    f.setFault(fault);
    const result = f.api.finalObservation(snapshot);
    assert.equal(result.sourceConfigUnchanged, fault === "hash-mismatch" ? false : null);
    if (fault !== "hash-mismatch") assert.equal(result.errorCode, code);
    assertCleared(f, 2);
  });
}

// Scope: only source Buffers returned by readFileSync are observable here.
// Node-internal buffers that were never returned are not claimed to be cleared.
