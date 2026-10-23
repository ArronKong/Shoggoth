"use strict";

// Every case loads the native supervisor in a separate Node process. Its global
// stop capability therefore owns only synthetic workers created by that case.
// No llama-server, model, credential, Product Service or non-loopback endpoint
// is acquired. Preset tests write invented paths into a temporary INI only.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const { spawn, ChildProcess } = require("node:child_process");
const { once } = require("node:events");
const { subscribe, unsubscribe } = require("node:diagnostics_channel");

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const turn = () => new Promise(resolve => setImmediate(resolve));
const read = file => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
const rows = file => read(file).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function alive(pid, group = false) {
  try { process.kill(group && process.platform !== "win32" ? -pid : pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
async function until(check, label, signal, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new Error(label);
    await delay(10);
  }
}
async function bounded(promise, label, timeout = 10_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), timeout); })]); }
  finally { clearTimeout(timer); }
}
async function port() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const value = server.address().port;
  const closed = once(server, "close"); server.close(); await closed;
  return value;
}

const workerSource = String.raw`
"use strict";
const fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const { spawn } = require("node:child_process");
const root = process.argv[2], mode = process.argv[3], port = Number(process.argv[4]);
const file = name => path.join(root, name);
const append = (name, value) => fs.appendFileSync(file(name), JSON.stringify(value) + "\n");
const read = name => fs.existsSync(file(name)) ? fs.readFileSync(file(name), "utf8") : "";
if (mode === "descendant") {
  fs.writeFileSync(file("descendant.pid"), String(process.pid));
  let stopping = false;
  process.once("SIGTERM", () => { stopping = true; fs.writeFileSync(file("descendant.stopping"), "yes"); });
  setInterval(() => { if (stopping && fs.existsSync(file("stop.gate"))) process.exit(0); }, 10);
} else {
  append("starts.jsonl", { pid: process.pid, mode, marker: process.env.SHOGGOTH_FIXTURE_MARKER });
  if (mode === "tree") spawn(process.execPath, [__filename, root, "descendant"], { stdio: "ignore", env: process.env });
  let stopping = false;
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.url === "/models?reload=1") {
      const preset = read("models.ini"), model = /^model\s*=\s*(.+)$/m.exec(preset)?.[1]?.trim();
      const failed = fs.existsSync(file("reload.fail"));
      append("reloads.jsonl", { model, failed });
      res.writeHead(failed ? 503 : 200); res.end("fixture reload"); return;
    }
    const ready = !stopping && (mode !== "cold" || fs.existsSync(file("ready.gate")));
    res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ ready, pid: process.pid }));
  });
  server.listen(port, "127.0.0.1");
  process.once("SIGTERM", () => {
    stopping = true; fs.writeFileSync(file("stopping"), "yes");
    if (mode === "tree") { server.closeAllConnections(); server.close(() => process.exit(0)); return; }
    const timer = setInterval(() => {
      if (mode !== "stop-gate" || fs.existsSync(file("stop.gate"))) {
        clearInterval(timer); server.closeAllConnections(); server.close(() => process.exit(0));
      }
    }, 10);
  });
}
`;

async function fixture(core, directory, signal, source = workerSource) {
  const captures = [], resources = [], releases = [], settlements = [], acquisitions = new Set();
  const observe = message => {
    if (message?.process instanceof ChildProcess) {
      const child = message.process, closed = deferred();
      const capture = { child, closed: false, closure: closed.promise };
      child.once("close", () => { capture.closed = true; closed.resolve(); });
      captures.push(capture);
    }
  };
  subscribe("child_process", observe);
  const worker = path.join(directory, "fixture-worker.cjs"); fs.writeFileSync(worker, source, { mode: 0o600 });
  let config = { models: { providers: {} } };
  const acquire = core.createConfiguredProviderLocalServiceAcquirer(() => config);
  const f = {
    signal, captures, directory, acquire,
    get config() { return config; }, set config(value) { config = value; },
    settle: action => settlements.push(action),
    async resource(name, options = {}) {
      const mode = options.mode || "warm", idleStopMs = Object.hasOwn(options, "idleStopMs") ? options.idleStopMs : 30;
      const root = path.join(directory, name); fs.mkdirSync(root, { mode: 0o700 });
      const number = await port(), baseUrl = `http://127.0.0.1:${number}/v1`;
      const value = { root, number, baseUrl, providerId: name,
        file: filename => path.join(root, filename),
        open: filename => fs.writeFileSync(path.join(root, filename), "yes", { mode: 0o600 }),
        starts: () => rows(path.join(root, "starts.jsonl")),
        service: { command: process.execPath, args: [worker, root, mode, String(number)], cwd: root,
          env: { ELECTRON_RUN_AS_NODE: "1", SHOGGOTH_FIXTURE_MARKER: name }, healthUrl: `${baseUrl}/models`,
          readyTimeoutMs: 8_000, ...(idleStopMs === undefined ? {} : { idleStopMs }) } };
      value.target = { providerId: name, baseUrl };
      value.config = { baseUrl, models: [], localService: value.service };
      resources.push(value); config.models.providers[name] = value.config;
      return value;
    },
    async lease(target, callSignal = signal) {
      const acquisition = acquire(target, callSignal); acquisitions.add(acquisition);
      // Keep pending acquisition ownership even if an earlier assertion fails.
      // The caller still receives its rejection; cleanup joins its actual tail.
      acquisition.finally(() => acquisitions.delete(acquisition)).catch(() => {});
      const lease = await acquisition; assert.equal(typeof lease?.release, "function");
      releases.push(() => lease.release()); return lease;
    },
    pid(resource) {
      const starts = resource.starts(); assert.ok(starts.length); const pid = starts.at(-1).pid;
      const diagnostic = core.getManagedProviderLocalServiceDiagnosticsForTest().find(value => value.pid === pid);
      assert.ok(diagnostic, `Missing native diagnostic owner ${pid}`); assert.equal(diagnostic.healthUrl, resource.service.healthUrl);
      return pid;
    },
    capture(pid) { const result = captures.find(value => value.child.pid === pid); assert.ok(result, `Missing owned child ${pid}`); return result; },
    async stopped(resource, pid = f.pid(resource)) {
      await until(() => f.capture(pid).closed && !alive(pid, true), `Owned process ${pid} did not physically exit`, signal);
    },
    async cleanup() {
      const errors = [];
      for (const settle of settlements) { try { await settle(); } catch (error) { errors.push(error); } }
      for (const resource of resources) { resource.open("ready.gate"); resource.open("stop.gate"); }
      for (const release of releases) { try { release(); } catch (error) { errors.push(error); } }
      try { await bounded(core.stopManagedProviderLocalServices(), "Native supervisor cleanup did not settle"); }
      catch (error) { errors.push(error); }
      try { await bounded(Promise.allSettled([...acquisitions]), "Pending fixture acquisitions did not settle"); }
      catch (error) { errors.push(error); }
      for (const capture of captures) {
        const pid = capture.child.pid;
        if (!pid) continue;
        if (!capture.closed || alive(pid, true)) {
          // This ChildProcess was captured at construction inside this isolated
          // case, never discovered from a host-wide process or PID listing.
          try {
            if (alive(pid, true)) process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
            await bounded(capture.closure, `Owned child ${pid} did not close after emergency cleanup`, 5_000);
            await until(() => !alive(pid, true), `Owned tree ${pid} survived cleanup`, undefined, 5_000);
          } catch (error) { errors.push(error); }
        }
      }
      unsubscribe("child_process", observe);
      try { assert.equal(core.hasManagedProviderLocalServices(), false, "Native cleanup must release all fixture retirement owners"); }
      catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Local service fixture cleanup failed");
    },
  };
  return f;
}

const cases = {
  async configured(f, core) {
    const a = await f.resource("configured");
    const extra = { command: "/caller/should-not-execute" };
    const resolved = core.resolveConfiguredProviderLocalServiceTarget(f.config, { ...a.target, service: extra });
    assert.equal(resolved.service, a.service, "Process configuration belongs to the host");
    for (const url of [a.baseUrl, a.baseUrl.replace(/\/v1$/, ""), `${a.baseUrl}/?unused=yes#fragment`]) {
      assert.equal(core.resolveConfiguredProviderLocalServiceTarget(f.config, { ...a.target, baseUrl: url }).service, a.service);
    }
    const bad = [`http://127.0.0.1:${a.number + 1}/v1`, `http://localhost:${a.number}/v1`, `${a.baseUrl}/another`, "https://example.invalid/v1"];
    for (const baseUrl of bad) await assert.rejects(f.acquire({ ...a.target, baseUrl }, f.signal), /Local endpoint must match/);
    assert.equal(await f.acquire({ providerId: "undeclared", baseUrl: a.baseUrl }, f.signal), undefined);
    assert.equal(a.starts().length, 0); assert.equal(f.captures.length, 0);
  },
  async concurrent(f) {
    const a = await f.resource("concurrent", { mode: "cold" });
    const first = f.lease(a.target), second = f.lease(a.target);
    await until(() => a.starts().length === 1, "Concurrent startup was not observed", f.signal);
    const pid = f.pid(a); await delay(60); assert.equal(a.starts().length, 1);
    a.open("ready.gate"); const [one, two] = await Promise.all([first, second]);
    assert.notEqual(one, two); one.release(); one.release();
    await delay(100); assert.equal(alive(pid), true, "Independent lease must keep the shared worker alive");
    two.release(); await f.stopped(a, pid); assert.equal(a.starts().length, 1);
  },
  async one_cancel(f) {
    const a = await f.resource("one-cancel", { mode: "cold" });
    const controller = new AbortController(), reason = new Error("synthetic first waiter cancelled");
    const rejected = assert.rejects(f.lease(a.target, AbortSignal.any([controller.signal, f.signal])), error => error === reason);
    const second = f.lease(a.target);
    await until(() => a.starts().length === 1, "Shared startup not observed", f.signal);
    const pid = f.pid(a); controller.abort(reason); await rejected;
    assert.equal(alive(pid), true); assert.equal(a.starts().length, 1);
    a.open("ready.gate"); const lease = await second; lease.release(); await f.stopped(a, pid);
  },
  async last_cancel(f, core) {
    const a = await f.resource("last-cancel", { mode: "cold", idleStopMs: undefined });
    const controller = new AbortController(), reason = new Error("synthetic last waiter cancelled");
    const rejected = assert.rejects(f.lease(a.target, AbortSignal.any([controller.signal, f.signal])), error => error === reason);
    await until(() => a.starts().length === 1, "Last waiter worker not observed", f.signal);
    const pid = f.pid(a); controller.abort(reason); await rejected;
    assert.equal(f.capture(pid).closed, true, "Cancellation must join physical child close");
    assert.equal(alive(pid, true), false); assert.equal(core.hasManagedProviderLocalServices(), false);
    a.open("ready.gate"); await delay(80); assert.equal(a.starts().length, 1, "Revoked startup cannot start a late worker");
  },
  async readiness(f) {
    const a = await f.resource("readiness"), phases = [];
    const target = { ...a.target, onReadinessWait: value => phases.push(value), reconcile: async ({ baseUrl, signal }) => {
      assert.equal(baseUrl, a.baseUrl); assert.equal(signal, f.signal); assert.deepEqual(phases, [true, false]);
    } };
    const cold = await f.lease(target); phases.length = 0;
    const warm = await f.lease(target); assert.deepEqual(phases, [true, false]);
    assert.equal(a.starts().length, 1); cold.release(); warm.release(); await f.stopped(a);
  },
  async reconcile_failure(f) {
    const a = await f.resource("reconcile-failure"), reason = new Error("synthetic reconciliation rejected");
    await assert.rejects(f.acquire({ ...a.target, reconcile: async () => { throw reason; } }, f.signal), error => error === reason);
    await f.stopped(a);
    const b = await f.resource("reconcile-cancel"), controller = new AbortController(), entered = deferred(), gate = deferred();
    f.settle(() => gate.resolve());
    const abort = new Error("synthetic late reconcile cancelled");
    let completed = false;
    const rejected = assert.rejects(f.acquire({ ...b.target, reconcile: async () => { entered.resolve(); await gate.promise; } },
      AbortSignal.any([controller.signal, f.signal])).finally(() => { completed = true; }), error => error === abort);
    await entered.promise; controller.abort(abort); await turn(); assert.equal(completed, false);
    gate.resolve(); await rejected; await f.stopped(b);
  },
  async preset_transition(f, core) {
    const a = await f.resource("preset-transition", { idleStopMs: undefined });
    a.service.args.push("--models-preset", a.file("models.ini"));
    const paths = [a.file("invented-A.gguf"), a.file("invented-B.gguf"), a.file("invented-A.gguf")];
    const prepare = model => core.prepareManagedLlamaServer({ chatModel: { mode: "preserve" }, configuredChatModelIds: [],
      embeddingModelIsDefault: false, embeddingModelPath: model, port: a.number, reconcileBaseUrl: a.baseUrl, localService: a.service });
    const target = { ...a.target, reconcile: core.reconcileManagedLlamaServer };
    const baseline = await f.lease(a.target);
    for (const model of paths) {
      await prepare(model); const lease = await f.lease(target); lease.release();
    }
    assert.deepEqual(rows(a.file("reloads.jsonl")).map(row => row.model), paths);
    const cached = await f.lease(target); cached.release(); assert.equal(rows(a.file("reloads.jsonl")).length, 3);
    await prepare(paths[1]); a.open("reload.fail");
    await assert.rejects(f.acquire(target, f.signal), /preset reload failed: HTTP 503/);
    fs.unlinkSync(a.file("reload.fail")); const retried = await f.lease(target); retried.release();
    const reloads = rows(a.file("reloads.jsonl"));
    assert.deepEqual(reloads.slice(-2), [{ model: paths[1], failed: true }, { model: paths[1], failed: false }]);
    assert.equal(a.starts().length, 1, "Model reconciliation reuses the managed server"); baseline.release();
  },
  async shutdown_reacquire(f, core) {
    const a = await f.resource("shutdown-reacquire", { mode: "stop-gate", idleStopMs: 1 });
    const lease = await f.lease(a.target), pid = f.pid(a); lease.release();
    await until(() => fs.existsSync(a.file("stopping")), "Idle stop did not enter its physical gate", f.signal);
    let stopped = false, acquired = false;
    const stopping = core.stopManagedProviderLocalServices().then(() => { stopped = true; });
    const replacement = f.lease(a.target).then(value => { acquired = true; return value; });
    await delay(40); assert.equal(stopped, false); assert.equal(acquired, false);
    assert.equal(a.starts().length, 1); assert.equal(alive(pid), true); assert.equal(core.hasManagedProviderLocalServices(), true);
    a.open("stop.gate"); await stopping; const next = await replacement;
    assert.equal(f.capture(pid).closed, true); assert.equal(alive(pid, true), false);
    assert.equal(a.starts().length, 2); assert.notEqual(f.pid(a), pid); next.release(); await f.stopped(a);
  },
  async shutdown_tree(f, core) {
    if (process.platform === "win32") return;
    const a = await f.resource("shutdown-tree", { mode: "tree", idleStopMs: undefined });
    const lease = await f.lease(a.target), pid = f.pid(a);
    await until(() => fs.existsSync(a.file("descendant.pid")), "Descendant not observed", f.signal);
    const descendant = Number(read(a.file("descendant.pid"))); assert.ok(descendant > 0); assert.equal(alive(descendant), true);
    let stopped = false; const stopping = core.stopManagedProviderLocalServices().then(() => { stopped = true; });
    await until(() => f.capture(pid).closed && fs.existsSync(a.file("descendant.stopping")), "Parent exit/descendant stop not observed", f.signal);
    assert.equal(stopped, false, "Parent close alone cannot finish process-tree retirement"); assert.equal(alive(descendant), true);
    a.open("stop.gate"); await stopping;
    assert.equal(alive(pid, true), false); assert.equal(alive(descendant), false); lease.release();
  },
  async config_ownership(f) {
    const a = await f.resource("config-owner-A"), oldTarget = { ...a.target }, old = await f.lease(oldTarget), oldPid = f.pid(a);
    const b = await f.resource("config-owner-B");
    f.config.models.providers[a.providerId] = b.config;
    await assert.rejects(f.acquire(oldTarget, f.signal), /Local endpoint must match/);
    assert.equal(alive(oldPid), true, "A live old lease keeps its original process resource");
    const newer = await f.lease({ providerId: a.providerId, baseUrl: b.baseUrl }), newPid = f.pid(b);
    assert.notEqual(newPid, oldPid); assert.equal(a.starts().length, 1); assert.equal(b.starts().length, 1);
    assert.equal(b.starts()[0].marker, b.providerId, "New configuration owns the new command environment");
    newer.release(); await f.stopped(b, newPid); assert.equal(alive(oldPid), true);
    old.release(); await f.stopped(a, oldPid);
  },
};

async function runCase(name, directory) {
  const core = require("../app/agent-service/shoggoth-memory/core.cjs");
  for (const key of ["createConfiguredProviderLocalServiceAcquirer", "stopManagedProviderLocalServices",
    "getManagedProviderLocalServiceDiagnosticsForTest", "hasManagedProviderLocalServices", "resolveConfiguredProviderLocalServiceTarget",
    ...(name === "preset_transition" ? ["prepareManagedLlamaServer", "reconcileManagedLlamaServer"] : [])]) {
    assert.equal(typeof core[key], "function", `Missing native bundle export ${key}`);
  }
  assert.equal(core.hasManagedProviderLocalServices(), false, "An isolated case cannot inherit service owners");
  const lifetime = new AbortController();
  const terminate = () => lifetime.abort(new Error("Isolated local-service test terminated"));
  process.once("SIGTERM", terminate);
  const f = await fixture(core, directory, lifetime.signal), errors = [];
  try { await cases[name](f, core); }
  catch (error) { errors.push(error); lifetime.abort(error); }
  try { await f.cleanup(); }
  catch (error) { errors.push(error); }
  process.removeListener("SIGTERM", terminate);
  if (errors.length) throw new AggregateError(errors, `Isolated local-service case ${name} failed`);
  process.stdout.write(`fixture-local-service-ok:${name}\n`);
}

module.exports = { createLocalServiceFixture: fixture, until, bounded, delay, alive, rows, read, port };

if (require.main === module && process.argv[2] === "--local-service-case") {
  runCase(process.argv[3], process.argv[4]).catch(error => { console.error(error); process.exitCode = 1; });
} else if (require.main === module) {
  const test = require("node:test");
  const descriptions = {
    configured: "configured local-service targets cannot select another endpoint or process configuration",
    concurrent: "concurrent local-service leases share one startup and release independently before idle stop",
    one_cancel: "one cancelled startup waiter cannot revoke another local-service lease",
    last_cancel: "last startup waiter cancellation joins physical retirement and prevents late startup",
    readiness: "native local-service readiness pauses and resumes before cold and warm reconciliation",
    reconcile_failure: "native reconciliation failure and late cancellation release their local-service lease",
    preset_transition: "native managed presets reconcile A to B to A and retry an unacknowledged revision",
    shutdown_reacquire: "shutdown and same-key reacquisition join a pending physical idle stop",
    shutdown_tree: "native local-service shutdown waits for a descendant after its parent closes",
    config_ownership: "a stable native acquirer admits new configuration without borrowing old process ownership",
  };
  for (const [name, description] of Object.entries(descriptions)) test(description, { timeout: 40_000 }, async () => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `shoggoth-memory-local-service-${name}-`));
    const child = spawn(process.execPath, [__filename, "--local-service-case", name, directory], {
      cwd: path.resolve(__dirname, ".."), env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "", errorOutput = "", timedOut = false;
    child.stdout.on("data", value => { output += value; }); child.stderr.on("data", value => { errorOutput += value; });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 25_000);
    try {
      const [code, signal] = await bounded(once(child, "close"), `Isolated fixture did not exit; retained at ${directory}`, 35_000);
      assert.equal(timedOut, false, `Isolated fixture timed out: ${errorOutput}`);
      assert.equal(signal, null, errorOutput); assert.equal(code, 0, errorOutput);
      assert.equal(output, `fixture-local-service-ok:${name}\n`);
      fs.rmSync(directory, { recursive: true });
    } finally { clearTimeout(timer); }
  });
}
