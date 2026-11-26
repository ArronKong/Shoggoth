"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { test } = require("node:test");
const { resolveCanonicalServicePaths, resolveServicePaths } = require("../app/agent-service/paths");
const { recordBootstrapFailure, recordServiceProcessFailure, summarizeBootstrapError, localDiagnosticSummary } = require("../app/bootstrap-diagnostics");
const { markMcpFailureStage } = require("../app/agent-service/mcp-helper-diagnostics");

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-bootstrap-diagnostics-")));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, "run");
  return { root, paths: { runtimeDir, trustedRoot: root }, target: path.join(runtimeDir, "bootstrap-diagnostics.json") };
}

test("startup diagnostics retain source locations without private content", (t) => {
  const f = fixture(t);
  const error = Object.assign(new Error("PRIVATE_PROMPT credential=PRIVATE_TOKEN"), { code: "PRIVATE_TOKEN" });
  error.stack = `Error: PRIVATE_PROMPT\n    at PRIVATE_FUNCTION (${path.resolve(__dirname, "../app/bootstrap.js")}:18:9)\n    at /private/PRIVATE_PATH.js:4:2`;
  assert.equal(recordBootstrapFailure(error, { paths: f.paths, argv: ["--shoggoth-internal-role=agent-service"] }), true);
  const body = fs.readFileSync(f.target, "utf8");
  assert.doesNotMatch(body, /PRIVATE_|\/Users\/|\/private\//u);
  const record = JSON.parse(body).records[0];
  assert.equal(record.errors[0].code, "UNKNOWN_STARTUP_ERROR");
  assert.deepEqual(record.errors[0].locations, [{ file: "bootstrap.js", line: 18, column: 9 }]);
  assert.equal(fs.statSync(f.target).mode & 0o777, 0o600);
});

test("manual export counts recorded incidents across both sources and keeps the latest UTC time for each stage", t => {
  const f = fixture(t);
  const early = "2026-11-25T23:59:59.000Z", middle = "2026-11-26T00:00:00.000Z", late = "2026-11-26T00:02:00.000Z";
  let at = early;
  t.mock.method(Date, "now", () => Date.parse(at));
  const error = Object.assign(new Error("SECRET_CANARY"), { code: "ENOSPC" });
  error.cause = Object.assign(new Error("SECRET_CANARY"), { code: "ENOSPC" });
  error.stack = `Error: SECRET_CANARY\n    at privateFunction (${path.resolve(__dirname, "../app/bootstrap.js")}:18:9)`;
  assert.ok(recordServiceProcessFailure(error, { paths: f.paths, origin: "uncaughtException" }));
  at = late;
  const mcp = { paths: f.paths, argv: ["--shoggoth-internal-role=mcp"] };
  markMcpFailureStage(error, null, "cache");
  assert.ok(recordBootstrapFailure(error, mcp));
  at = middle;
  assert.ok(recordBootstrapFailure(error, mcp));
  const unknown = Object.assign(new Error("SECRET_CANARY"), { code: "PRIVATE_ACCOUNT_ID", stage: "PRIVATE_STAGE" });
  assert.ok(recordBootstrapFailure(unknown, { paths: f.paths, argv: [] }));
  const text = localDiagnosticSummary(f.paths.runtimeDir, "1.0.0", "darwin");
  assert.doesNotMatch(text, /SECRET_|PRIVATE_|bootstrap\.js|locations|privateFunction/u);
  assert.deepEqual(JSON.parse(text), {
    app_version: "1.0.0", os_family: "macos", error_codes: ["ENOSPC", "UNKNOWN_STARTUP_ERROR"], record_limit_per_source: 8,
    error_details: [
      { code: "ENOSPC", count: 3, last_seen_at: late, stages: [
        { stage: "mcp.cache_setup", count: 2, last_seen_at: late },
        { stage: "agent-service.runtime.uncaughtException", count: 1, last_seen_at: early },
      ] },
      { code: "UNKNOWN_STARTUP_ERROR", count: 1, last_seen_at: middle,
        stages: [{ stage: "ui.startup", count: 1, last_seen_at: middle }] },
    ],
  });
});

test("legacy records use the observed process and phase; invalid times and arbitrary stages do not enter an export", t => {
  const f = fixture(t);
  const failure = (timeMs, stage) => ({ timeMs, role: "mcp", errors: [{ code: "MCP_HELPER_STORAGE_FULL", stage }] });
  fs.mkdirSync(f.paths.runtimeDir, { mode: 0o700 });
  fs.writeFileSync(f.target, JSON.stringify({ version: 1,
    records: [failure(0), failure(3000, "PRIVATE_PATH"), failure(Number.MAX_SAFE_INTEGER)] }), { mode: 0o600 });
  const { error_details: details } = JSON.parse(localDiagnosticSummary(f.paths.runtimeDir, "1.0.0", "darwin"));
  assert.deepEqual(details, [{ code: "MCP_HELPER_STORAGE_FULL", count: 2, last_seen_at: "1970-01-01T00:00:03.000Z",
    stages: [{ stage: "mcp.startup", count: 2, last_seen_at: "1970-01-01T00:00:03.000Z" }] }]);
});

test("a cause inherits the observed MCP operation unless it has a more specific recorded stage", () => {
  const timeout = Object.assign(new Error(), { code: "MCP_RELAY_BRIDGE_TIMEOUT" });
  const credential = Object.assign(new Error(), { code: "MCP_HELPER_STORAGE_FULL" });
  markMcpFailureStage(credential, null, "credential");
  const outer = Object.assign(new AggregateError([timeout, credential]), { code: "BOOTSTRAP_ROLE_REJECTED" });
  markMcpFailureStage(outer, null, "bridge");
  assert.deepEqual(summarizeBootstrapError(outer).map(({ code, stage }) => [code, stage]), [
    ["BOOTSTRAP_ROLE_REJECTED", "mcp.service_bridge"], ["MCP_RELAY_BRIDGE_TIMEOUT", "mcp.service_bridge"],
    ["MCP_HELPER_STORAGE_FULL", "mcp.credential_read"],
  ]);
});

test("causes, aggregate errors and repeated failures remain bounded", (t) => {
  const f = fixture(t);
  const error = new AggregateError(Array.from({ length: 30 }, () => Object.assign(new Error("secret"), { code: "ENOSPC" })), "secret");
  error.cause = error;
  for (let index = 0; index < 20; index++) assert.equal(recordBootstrapFailure(error, { paths: f.paths }), true);
  const value = JSON.parse(fs.readFileSync(f.target, "utf8"));
  assert.equal(value.records.length, 8);
  assert.equal(value.records[0].errors.length, 8);
  assert.equal(value.records[0].errors[1].code, "ENOSPC");
  assert.ok(fs.statSync(f.target).size <= 16 * 1024);
  const { error_details: details } = JSON.parse(localDiagnosticSummary(f.paths.runtimeDir, "1.0.0", "darwin"));
  assert.equal(details.find(row => row.code === "ENOSPC").count, 8);
});

test("when long failure records fill the byte budget the most recent occurrence is retained", t => {
  const f = fixture(t);
  const source = path.join(f.root, "fixture-" + "x".repeat(180) + ".js");
  fs.writeFileSync(source, "");
  const cause = () => Object.assign(new Error(), { code: "ENOSPC", stack: "Error\n" + `    at ${source}:18:9\n`.repeat(6) });
  const failure = new AggregateError(Array.from({ length: 7 }, cause));
  let timeMs = 1000;
  t.mock.method(Date, "now", () => timeMs);
  for (let n = 0; n < 8; n++) {
    timeMs += 1000;
    assert.ok(recordBootstrapFailure(failure, { paths: f.paths, argv: [], sourceRoot: f.root }));
  }
  const retained = JSON.parse(fs.readFileSync(f.target)).records;
  assert.ok(retained.length > 0 && retained.length < 8);
  assert.ok(fs.statSync(f.target).size <= 16 * 1024);
  const { error_details: details } = JSON.parse(localDiagnosticSummary(f.paths.runtimeDir, "1.0.0", "darwin"));
  const full = details.find(row => row.code === "ENOSPC");
  assert.equal(full.count, retained.length);
  assert.equal(full.last_seen_at, new Date(timeMs).toISOString());
});

test("failed diagnostics leave a symlink target untouched", (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.paths.runtimeDir, { mode: 0o700 });
  const other = path.join(f.root, "retained.txt");
  fs.writeFileSync(other, "retained", { mode: 0o600 });
  fs.symlinkSync(other, f.target);
  assert.equal(recordBootstrapFailure(new Error("secret"), { paths: f.paths }), false);
  assert.equal(fs.readFileSync(other, "utf8"), "retained");
});

test("invalid role and throwing error accessors fail without propagation", (t) => {
  const f = fixture(t);
  assert.equal(recordBootstrapFailure(new Error("secret"), { paths: f.paths, argv: ["--shoggoth-internal-role=secret"] }), false);
  const error = Object.defineProperty({}, "stack", { get() { throw new Error("secret"); } });
  assert.equal(recordBootstrapFailure(error, { paths: f.paths }), false);
  assert.equal(fs.existsSync(f.target), false);
});

test("untrusted stack frames and unknown error codes are discarded", () => {
  const error = Object.assign(new TypeError("secret"), { code: "REMOTE_SECRET" });
  error.stack = "TypeError: secret\n    at /some/private/file.js:12:7\n    at node:internal/process/task_queues:105:5";
  assert.deepEqual(summarizeBootstrapError(error), [{ name: "TypeError", code: "UNKNOWN_STARTUP_ERROR", locations: [] }]);
});

test("native memory startup failures include trusted CommonJS coordinates", () => {
  const error = Object.assign(new Error("PRIVATE_MEMORY_CONTENT"), { code: "MEMORY_NATIVE_OWNER_INVALID" });
  error.stack = `Error: PRIVATE_MEMORY_CONTENT\n    at fail (${path.resolve(__dirname, "../app/agent-service/shoggoth-memory/fresh-initialization.cjs")}:14:65)`;
  assert.deepEqual(summarizeBootstrapError(error), [{ name: "Error", code: "MEMORY_NATIVE_OWNER_INVALID", locations: [
    { file: "agent-service/shoggoth-memory/fresh-initialization.cjs", line: 14, column: 65 },
  ] }]);
});

function failingBootstrapFixture(t, { role = "agent-service", asyncFailure = false } = {}) {
  const f = fixture(t);
  const fixtureHome = path.join(f.root, "fixture-home");
  fs.mkdirSync(fixtureHome, { mode: 0o700 });
  const paths = resolveServicePaths({ homeDir: fixtureHome });
  const gatePath = path.join(fixtureHome, "role-gate.json");
  fs.writeFileSync(gatePath, JSON.stringify({ parentPid: process.pid, nonce: "fixture-nonce" }), { mode: 0o600 });
  // Even the pre-fix bootstrap can only reach this injected system account.
  // HOME deliberately differs from both the gate directory and system home.
  const userInfo = () => ({ homedir: path.join(f.root, "system-home") });
  const canonicalPaths = resolveCanonicalServicePaths({ userInfo });
  const canonicalTarget = path.join(canonicalPaths.runtimeDir, "bootstrap-diagnostics.json");
  fs.mkdirSync(canonicalPaths.runtimeDir, { recursive: true, mode: 0o700 });
  const retained = `${JSON.stringify({ version: 1, records: [
    { timeMs: 1, role: "ui", errors: [{ name: "Error", code: "ENOSPC", locations: [] }] },
  ] })}\n`;
  fs.writeFileSync(canonicalTarget, retained, { mode: 0o600 });
  const exits = [];
  const logged = [];
  const serviceCalls = [];
  const writes = [];
  let canonicalResolutions = 0;
  const processFixture = {
    env: {
      HOME: path.join(f.root, "unused-home"),
      NODE_ENV: "test",
      SHOGGOTH_INTERNAL_LAUNCH: "launch-agent-v1",
      SHOGGOTH_TEST_ROLE_GATE_FILE: gatePath,
      SHOGGOTH_TEST_ROLE_GATE_NONCE: "fixture-nonce",
    },
    argv: ["electron", "--shoggoth-internal-role=" + role],
    defaultApp: true, ppid: process.pid, platform: process.platform,
    execPath: process.execPath, getuid: process.getuid,
    exit: (code) => exits.push(code),
  };
  const fail = () => {
    const error = Object.assign(new Error("PRIVATE_STARTUP_FAILURE"), {
      code: role === "mcp" ? "MCP_HELPER_SERVICE_UNAVAILABLE" : "EACCES",
    });
    if (asyncFailure) return Promise.reject(error);
    throw error;
  };
  const electronApp = { exit: (code) => exits.push(code) };
  const sourceRoot = path.resolve(__dirname, "../app");
  const load = (filename) => {
    const target = path.join(sourceRoot, filename);
    const localRequire = createRequire(target);
    const module = { exports: {} };
    const context = {
      module, exports: module.exports, __dirname: sourceRoot,
      Buffer, process: processFixture, console: { error: (message) => logged.push(message) },
      require(name) {
        if (name === "./bootstrap-role") return load("bootstrap-role.js").exports;
        if (name === "./bootstrap-diagnostics") {
          const diagnostics = load("bootstrap-diagnostics.js").exports;
          return { recordBootstrapFailure(error, options) {
            const result = diagnostics.recordBootstrapFailure(error, options);
            writes.push(result);
            return result;
          } };
        }
        if (name === "./agent-service/paths") return {
          resolveServicePaths,
          resolveCanonicalServicePaths() {
            canonicalResolutions += 1;
            return resolveCanonicalServicePaths({ userInfo });
          },
        };
        if (name === "./background-role-activation") return { prepareBackgroundRoleActivation() {} };
        if (name === "./agent-service") return { startAgentServiceProcess(options) {
          serviceCalls.push(options);
          return fail();
        } };
        if (name === "./shoggoth-mcp-helper") return { startShoggothMcpHelper: fail };
        if (name === "./mcp-crypto-worker") return { startMcpCryptoWorker: fail };
        if (name === "./desktop-data-bootstrap") return { prepareDesktopData: fail };
        if (name === "electron") return { app: electronApp };
        return localRequire(name);
      },
    };
    context.require.cache = {};
    const completion = vm.runInNewContext(fs.readFileSync(target, "utf8"), context, { filename: target });
    return { exports: module.exports, completion };
  };
  return {
    ...f, paths, gatePath, process: processFixture, serviceCalls, writes, exits, logged,
    target: path.join(paths.runtimeDir, "bootstrap-diagnostics.json"),
    canonicalTarget, retained,
    canonicalResolutions: () => canonicalResolutions,
    run: () => load("bootstrap.js").completion,
    assertCanonicalUntouched() {
      assert.equal(canonicalResolutions, 0, "gated bootstrap must not resolve the canonical directory");
      assert.equal(fs.readFileSync(canonicalTarget, "utf8"), retained);
      assert.deepEqual(fs.readdirSync(canonicalPaths.runtimeDir), ["bootstrap-diagnostics.json"]);
      assert.equal(fs.existsSync(processFixture.env.HOME), false);
    },
  };
}

for (const options of [
  { role: "agent-service" },
  { role: "agent-service", asyncFailure: true },
  { role: "mcp", asyncFailure: true },
  { role: "mcp-crypto" },
  { role: "ui" },
]) {
  test(`gated ${options.role} ${options.asyncFailure ? "async" : "sync"} bootstrap failure stays in its fixture`, async (t) => {
    const f = failingBootstrapFixture(t, options);
    await f.run();
    f.assertCanonicalUntouched();
    assert.deepEqual(f.exits, [1]);
    assert.deepEqual(f.writes, [true]);
    const record = JSON.parse(fs.readFileSync(f.target, "utf8")).records[0];
    assert.equal(record.role, options.role);
    assert.equal(record.errors[0].code, options.role === "mcp" ? "MCP_HELPER_SERVICE_UNAVAILABLE" : "EACCES");
    assert.equal(fs.statSync(f.target).mode & 0o777, 0o600);
    if (options.role === "agent-service") {
      assert.equal(f.serviceCalls.length, 1);
      assert.deepEqual(f.serviceCalls[0].paths, f.paths);
    }
    assert.doesNotMatch(f.logged.join("\n"), /PRIVATE_STARTUP_FAILURE/u);
  });
}

test("MCP role rejection with a verified test gate records only in the fixture", async (t) => {
  const f = failingBootstrapFixture(t, { role: "mcp" });
  // An invalid federation selector rejects before the ordinary test-role gate.
  f.process.env.SHOGGOTH_FEDERATION_MCP_CLIENT = "invalid";
  await f.run();
  f.assertCanonicalUntouched();
  assert.deepEqual(f.exits, [1]);
  assert.deepEqual(f.writes, [true]);
  const record = JSON.parse(fs.readFileSync(f.target, "utf8")).records[0];
  assert.equal(record.role, "mcp");
  assert.equal(record.errors[0].code, "BOOTSTRAP_ROLE_REJECTED");
});

for (const [label, invalidate] of [
  ["missing gate", (f) => { delete f.process.env.SHOGGOTH_TEST_ROLE_GATE_FILE; }],
  ["production environment", (f) => { f.process.env.NODE_ENV = "production"; }],
  ["packaged app", (f) => { f.process.defaultApp = false; }],
  ["wrong nonce", (f) => { f.process.env.SHOGGOTH_TEST_ROLE_GATE_NONCE = "wrong"; }],
  ["wrong parent", (f) => { f.process.ppid += 1; }],
  ["public gate", (f) => fs.chmodSync(f.gatePath, 0o644)],
  ["malformed gate", (f) => fs.writeFileSync(f.gatePath, "{")],
  ["symlink gate", (f) => {
    fs.renameSync(f.gatePath, `${f.gatePath}.real`);
    fs.symlinkSync(`${f.gatePath}.real`, f.gatePath);
  }],
]) {
  test(`${label} cannot redirect bootstrap diagnostics from the injected canonical path`, async (t) => {
    const f = failingBootstrapFixture(t);
    // Reject before dispatch so this check can never start a real Service.
    delete f.process.env.SHOGGOTH_INTERNAL_LAUNCH;
    invalidate(f);
    await f.run();
    assert.deepEqual(f.exits, [1]);
    assert.deepEqual(f.writes, [true]);
    assert.equal(f.canonicalResolutions(), 1);
    assert.equal(fs.existsSync(f.target), false);
    const records = JSON.parse(fs.readFileSync(f.canonicalTarget, "utf8")).records;
    assert.equal(records.length, 2);
    assert.deepEqual(records[0], JSON.parse(f.retained).records[0]);
    assert.equal(records[1].errors[0].code, "BOOTSTRAP_ROLE_REJECTED");
  });
}

test("a rejected fixture diagnostic write never falls back to the canonical directory", async (t) => {
  const f = failingBootstrapFixture(t);
  fs.mkdirSync(f.paths.runtimeDir, { recursive: true, mode: 0o700 });
  fs.symlinkSync(f.canonicalTarget, f.target);
  await f.run();
  f.assertCanonicalUntouched();
  assert.deepEqual(f.writes, [false]);
  assert.deepEqual(f.exits, [1]);
  assert.deepEqual(f.logged, ["[bootstrap] startup failure: BOOTSTRAP_FAILED"]);
});
