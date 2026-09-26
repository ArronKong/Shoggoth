#!/usr/bin/env node
"use strict";

// Read-only latency receipt for the installed control plane. Repeated status
// reads span SecretRef cache expiry while independent native requests continue.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");

async function main() {
  const output = process.argv[2];
  assert.ok(path.isAbsolute(output || "") && !fs.existsSync(output));
  const started = performance.now();
  const capacity = [], statuses = [];
  let statusDone = false;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const read = async (endpoint, timeout) => {
    const begin = performance.now();
    try {
      const response = await fetch(`http://127.0.0.1:18799${endpoint}`, { signal: AbortSignal.timeout(timeout) });
      assert.equal(response.status, 200);
      const value = await response.json();
      return { startMs: Math.round(begin - started), endMs: Math.round(performance.now() - started),
        elapsedMs: Math.round(performance.now() - begin), value };
    } catch { return { elapsedMs: Math.round(performance.now() - begin), failed: true }; }
  };
  await Promise.all([
    (async () => {
      while (performance.now() - started < 30_000 || !statusDone) {
        const result = await read("/__api/native-capacity", 2000);
        capacity.push({ startMs: result.startMs, endMs: result.endMs, elapsedMs: result.elapsedMs, failed: !!result.failed,
          enabled: result.value?.enabled, maxActive: result.value?.maxActive });
        await delay(250);
      }
    })(),
    (async () => {
      try { while (performance.now() - started < 30_000) {
        // Status includes SecretRef resolution plus two sequential Gateway RPCs
        // (8s each). Its network wait is independent of the 1s native latency
        // gate below; allow the documented bounded chain to return normally.
        const result = await read("/__api/status", 45_000);
        const backends = result.value?.backends;
        statuses.push({ startMs: result.startMs, endMs: result.endMs, elapsedMs: result.elapsedMs, failed: !!result.failed,
          backends: Array.isArray(backends) ? backends.map(row => ({
            id: row.id, connected: row.connected, disabled: row.disabled === true,
          })) : null });
        await delay(1000);
      } } finally { statusDone = true; }
    })(),
  ]);
  const sorted = capacity.map(row => row.elapsedMs).sort((a, b) => a - b);
  const receipt = { at: new Date().toISOString(), evidence: "installed-control-plane-read-only",
    durationMs: Math.round(performance.now() - started), samples: capacity.length,
    maxMs: sorted.at(-1), p95Ms: sorted[Math.floor(sorted.length * 0.95)], capacity, statuses };
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  assert.ok(capacity.length >= 30 && capacity.every(row => !row.failed && row.enabled && row.maxActive === 100));
  assert.ok(receipt.maxMs < 1000, "native control requests must stay responsive during auth refresh");
  assert.ok(statuses.length >= 3 && statuses.every(row => !row.failed));
  const last = statuses.at(-1).backends;
  for (const id of ["openclaw", "hermes", "shoggoth"]) {
    assert.ok(last?.some(row => row.id === id && row.connected && !row.disabled), `${id} must be connected`);
  }
  console.log(JSON.stringify({ output, samples: receipt.samples, maxMs: receipt.maxMs, p95Ms: receipt.p95Ms }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
