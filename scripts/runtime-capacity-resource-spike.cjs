#!/usr/bin/env node
"use strict";
// Explicit opt-in resource observation. Real Pi uses only a loopback fake
// provider; this does not measure provider throughput or packaged App capacity.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");
const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
function option(name) { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; }
const mode = option("--mode");
const concurrency = Number(option("--concurrency"));
const output = option("--output");
const cli = option("--pi-cli");
assert.ok(["fake", "pi"].includes(mode) && [1, 20, 50].includes(concurrency)
  && output && path.isAbsolute(output) && (mode !== "pi" || path.isAbsolute(cli || "")),
"Use --mode fake|pi --concurrency 1|20|50 --output /absolute/result.json [--pi-cli /absolute/cli.js]");
const scratch = fs.mkdtempSync("/tmp/sg-spike-");
const children = [];
const held = [];
const samples = [];
const failures = [];
let providerRequests = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = http.createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(400); response.end(); failures.push("UNEXPECTED_LOCAL_REQUEST"); return; }
  const chunks = [];
  request.on("data", chunk => chunks.push(chunk));
  request.on("end", () => {
    const payload = JSON.parse(Buffer.concat(chunks));
    if (payload.model !== "capacity-fixture-model" || payload.stream !== true) {
      failures.push("UNEXPECTED_LOCAL_MODEL"); response.writeHead(400); response.end(); return;
    }
    providerRequests += 1;
    held.push(response);
  });
});
function command(file, parameters) {
  const value = spawnSync(file, parameters, { encoding: "utf8", timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  if (value.status !== 0) throw new Error(`RESOURCE_PROBE_FAILED:${path.basename(file)}`);
  return value.stdout;
}
function sample() {
  const rows = command("/bin/ps", ["-axo", "pid=,ppid=,rss="]).trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
  const roots = new Set(children.map(child => child.process.pid));
  const selected = new Set(roots);
  for (let changed = true; changed;) {
    changed = false;
    for (const [pid, ppid] of rows) if (!selected.has(pid) && selected.has(ppid)) { selected.add(pid); changed = true; }
  }
  const matching = rows.filter(([pid]) => selected.has(pid));
  let numericFds = 0;
  if (matching.length) {
    const value = command("/usr/sbin/lsof", ["-n", "-P", "-a", "-p", matching.map(([pid]) => pid).join(","), "-Fpf"]);
    numericFds = value.split("\n").filter(line => /^f\d+/.test(line)).length;
  }
  const memoryPressure = command("/usr/bin/memory_pressure", ["-Q"]);
  const match = memoryPressure.match(/System-wide memory free percentage:\s*(\d+)%/);
  if (!match) throw new Error("MEMORY_PRESSURE_PROBE_INVALID");
  const observed = { atMs: Date.now() - startedAt, aggregateRssKiB: matching.reduce((sum, row) => sum + row[2], 0),
    processCount: matching.length, childProcessCount: matching.filter(([pid]) => !roots.has(pid)).length,
    numericFds, memoryFreePercent: Number(match[1]), waitingResponses: held.length };
  samples.push(observed);
  if (observed.memoryFreePercent < 15) throw new Error("RESOURCE_SPIKE_MEMORY_PRESSURE_STOP");
}
function launch(index, endpoint) {
  const home = path.join(scratch, `h${index}`);
  const agentDir = path.join(home, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ enableInstallTelemetry: false, defaultProjectTrust: "never" }));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "capacity-fixture": {
    baseUrl: `${endpoint}/v1`, api: "openai-completions", apiKey: "local-fixture-dummy",
    models: [{ id: "capacity-fixture-model", name: "Capacity fixture", contextWindow: 32000, maxTokens: 64,
      reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  const childArgs = ["--require", path.join(ROOT, "scripts/fixtures/runtime-capacity-network-guard.cjs"),
    mode === "pi" ? cli : path.join(ROOT, "scripts/fixtures/runtime-capacity-worker.cjs")];
  if (mode === "pi") childArgs.push("--mode", "rpc", "--no-session", "--offline", "--no-tools", "--no-extensions", "--no-skills",
    "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--provider", "capacity-fixture", "--model", "capacity-fixture-model", "--thinking", "off");
  const child = spawn(process.execPath, childArgs, { cwd: home, env: {
    HOME: home, PI_CODING_AGENT_DIR: agentDir, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: "en_US.UTF-8",
    PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", SHOGGOTH_CAPACITY_ENDPOINT: endpoint,
  }, stdio: ["pipe", "pipe", "pipe"] });
  const record = { process: child, ready: false, completed: false, closed: false, code: null, signal: null, stderr: "", buffer: "" };
  children.push(record);
  child.stderr.on("data", chunk => { record.stderr = (record.stderr + chunk).slice(-4096); });
  child.stdout.on("data", chunk => {
    record.buffer += chunk;
    for (let newline; (newline = record.buffer.indexOf("\n")) >= 0;) {
      const line = record.buffer.slice(0, newline); record.buffer = record.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { failures.push("INVALID_RPC_OUTPUT"); continue; }
      if (event.id === "state" && event.type === "response") {
        if (!event.success || event.data?.model?.provider !== "capacity-fixture"
          || event.data.model.baseUrl !== `${endpoint}/v1`) { failures.push("MODEL_ISOLATION_FAILED"); continue; }
        record.ready = true;
        child.stdin.write(`${JSON.stringify({ id: "prompt", type: "prompt", message: "Reply CAPACITY_FIXTURE_OK." })}\n`);
      }
      if (event.type === "agent_end") {
        const text = (event.messages || []).flatMap(message => message.content || []).filter(part => part.type === "text").map(part => part.text).join("");
        if (!text.includes("CAPACITY_FIXTURE_OK")) failures.push("FIXTURE_REPLY_MISSING");
        record.completed = true;
      }
    }
  });
  child.on("error", () => failures.push("CHILD_SPAWN_FAILED"));
  child.on("close", (code, signal) => { record.closed = true; record.code = code; record.signal = signal; });
  child.stdin.write('{"id":"state","type":"get_state"}\n');
}
const startedAt = Date.now();
async function until(predicate, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (failures.length || children.some(child => child.closed && !child.completed)) throw new Error(failures[0] || "CHILD_EARLY_EXIT");
    if (Date.now() >= deadline) throw new Error("RESOURCE_SPIKE_TIMEOUT");
    await delay(100);
  }
}
(async () => {
  const result = { mode, concurrency, evidence: mode === "pi" ? "real-cli-local-provider-fixture" : "fake-process-fixture",
    installedCli: mode === "pi" ? fs.realpathSync(cli) : null, totalMemoryBytes: os.totalmem(),
    limitation: "Isolated local synthetic response only; no real provider throughput or installed-App acceptance.", status: "failed" };
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    // Bound simultaneous cold startup while still retaining all requested live processes.
    for (let index = 0; index < concurrency; index += 4) {
      for (let offset = index; offset < Math.min(index + 4, concurrency); offset += 1) launch(offset, endpoint);
      await until(() => children.every(child => child.ready)); sample();
    }
    await until(() => held.length === concurrency);
    for (let index = 0; index < 3; index += 1) { sample(); await delay(1000); }
    for (const response of held.splice(0)) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const chunk of [
        { choices: [{ index: 0, delta: { role: "assistant", content: "CAPACITY_FIXTURE_OK" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      ]) response.write(`data: ${JSON.stringify({ id: "capacity-fixture", object: "chat.completion.chunk", created: 1, model: "capacity-fixture-model", ...chunk })}\n\n`);
      response.end("data: [DONE]\n\n");
    }
    await until(() => children.every(child => child.completed)); sample();
    for (const child of children) child.process.stdin.end();
    await until(() => children.every(child => child.closed), 10000);
    assert.ok(children.every(child => child.code === 0 && child.signal === null));
    result.status = "passed";
  } catch (error) { result.errorCode = error.message; process.exitCode = 1; }
  finally {
    for (const response of held.splice(0)) response.destroy();
    for (const child of children) if (!child.closed) child.process.kill("SIGTERM");
    await delay(500);
    for (const child of children) if (!child.closed) child.process.kill("SIGKILL");
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    Object.assign(result, { durationMs: Date.now() - startedAt, providerRequests,
      completed: children.filter(child => child.completed).length, samples,
      peakAggregateRssKiB: Math.max(0, ...samples.map(value => value.aggregateRssKiB)),
      peakNumericFds: Math.max(0, ...samples.map(value => value.numericFds)),
      peakProcessCount: Math.max(0, ...samples.map(value => value.processCount)),
      peakChildProcessCount: Math.max(0, ...samples.map(value => value.childProcessCount)),
      exits: children.map(child => ({ code: child.code, signal: child.signal, stderr: child.stderr })) });
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
    fs.rmSync(scratch, { recursive: true, force: true });
    console.log(JSON.stringify({ status: result.status, mode, concurrency, completed: result.completed,
      peakAggregateRssKiB: result.peakAggregateRssKiB, peakNumericFds: result.peakNumericFds, errorCode: result.errorCode, output }));
  }
})();
