"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const os = require("node:os");
const { performance } = require("node:perf_hooks");
const { MemoryEngine } = require("../app/agent-service/memory-engine");

// Measures the original two searches or the current two hot-candidate searches.
// The fake store mirrors MemoryStore.list for the first active-view build but
// avoids 100k fsyncs; this is an isolated hot path, not app P95.
const NOW = 1_800_000_000_000;
const WORKSPACE = "/synthetic/project-a";
const WORKSPACE_REF = `workspace:${crypto.createHash("sha256").update(WORKSPACE).digest("hex")}`;

function parseNumberArg(name, fallback) {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (!raw) return fallback;
  const value = Number(raw.slice(name.length + 3));
  assert.ok(Number.isSafeInteger(value) && value > 0, `--${name} must be a positive integer`);
  return value;
}

function parseSizes() {
  const raw = process.argv.find((arg) => arg.startsWith("--sizes="));
  if (!raw) return [1_000, 10_000, 100_000];
  const sizes = raw.slice("--sizes=".length).split(",").map(Number);
  assert.ok(sizes.length > 0 && sizes.every((size) => Number.isSafeInteger(size) && size > 0 && size <= 100_000));
  return sizes;
}

function makeItems(count) {
  return Array.from({ length: count }, (_, index) => {
    const scope = index % 4 === 0 ? "user" : index % 4 === 1 ? "agent" : "project";
    return {
      id: `synthetic-${String(index).padStart(6, "0")}`,
      profileId: "profile-1", scope, type: "semantic",
      content: scope === "user"
        ? `用户偏好编号 ${index}，摘要使用中文，标签 QK-${index}.`
        : `项目记录编号 ${index}，运行 Node.js，标签 QK-${index}.`,
      sourceRefs: scope === "project" ? [WORKSPACE_REF] : [`event-${index}`],
      confidence: 1, sensitivity: "normal", status: "active",
      validFrom: 0, validUntil: null, supersedes: null,
      createdAt: NOW - index, updatedAt: NOW - index,
    };
  });
}

function makeStore(items) {
  return {
    list(profileId, filter = {}) {
      assert.equal(profileId, "profile-1");
      return items
        .filter((item) => !filter.status || item.status === filter.status)
        .filter((item) => !filter.scope || item.scope === filter.scope)
        .filter((item) => !filter.type || item.type === filter.type)
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
        .map((item) => structuredClone(item));
    },
    getRevision: () => 1,
  };
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.ceil(sorted.length * ratio) - 1].toFixed(3));
}

function runSearchPair(engine) {
  const user = engine.search({
    profileId: "profile-1", query: "", scopes: ["user"],
    maxSensitivity: "private", limit: 24, maxBytes: 8 * 1024, now: NOW,
  });
  const memory = engine.search({
    profileId: "profile-1", query: "项目 QK-4827", scopes: ["agent", "project", "workspace"],
    workspace: WORKSPACE, maxSensitivity: "private", limit: 24, maxBytes: 12 * 1024, now: NOW,
  });
  assert.ok(user.items.length > 0 && memory.items.length > 0);
  return { userCount: user.items.length, memoryCount: memory.items.length };
}

function runHotSearchPair(engine) {
  const common = { profileId: "profile-1", scopes: ["user", "agent", "project", "workspace"],
    workspace: WORKSPACE, maxSensitivity: "private", limit: 100,
    maxBytes: 128 * 1024, now: NOW };
  // Match ContextCompiler's production empty-query hot selection. Ordinary
  // memory_search remains recency ranked; only the hot candidate pass opts in.
  const stable = engine.search({ ...common, query: "", hotPriority: true, scopeLimits: {
    user: { count: 40, bytes: 40 * 1024 }, agent: { count: 20, bytes: 20 * 1024 },
    project: { count: 20, bytes: 32 * 1024 }, workspace: { count: 20, bytes: 32 * 1024 },
  } });
  const related = engine.search({ ...common, query: "项目 QK-4827" });
  assert.ok(stable.items.some((item) => item.scope === "user") && related.items.length > 0);
  return { stableCount: stable.items.length, relatedCount: related.items.length };
}

function main() {
  const iterations = parseNumberArg("iterations", 12);
  const hot = process.argv.includes("--hot");
  const searchPair = hot ? runHotSearchPair : runSearchPair;
  const sizes = parseSizes();
  const rows = [];
  for (const size of sizes) {
    const items = makeItems(size);
    // Keep policy lookup outside this isolated measurement. The live policy
    // path is measured separately by product-level tests, and this fixture has
    // no persisted Profile to reconcile.
    const recallPolicy = {
      open() {}, close() {}, assertReady() {},
      snapshot: () => ({ isMemoryVisible: () => true }),
    };
    const engine = new MemoryEngine({ store: makeStore(items), recallPolicy, now: () => NOW });
    engine.open([]);
    searchPair(engine);
    const elapsed = [];
    let counts;
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      counts = searchPair(engine);
      elapsed.push(performance.now() - start);
    }
    rows.push({
      items: size,
      iterations,
      pairMs: {
        min: Number(Math.min(...elapsed).toFixed(3)),
        p50: percentile(elapsed, 0.5),
        p95: percentile(elapsed, 0.95),
        max: Number(Math.max(...elapsed).toFixed(3)),
      },
      returnedItems: counts,
      heapUsedMiB: Number((process.memoryUsage().heapUsed / 1_048_576).toFixed(1)),
    });
    engine.close();
  }
  process.stdout.write(`${JSON.stringify({
    kind: hot ? "isolated-memory-hot-search-pair" : "isolated-memory-search-pair",
    node: process.version, platform: process.platform, arch: process.arch,
    cpu: os.cpus()[0]?.model || "unknown",
    generatedAt: new Date().toISOString(),
    note: "Synthetic items; initial active-view build mirrors MemoryStore.list clone/sort, measured searches reuse the view. Excludes other ContextCompiler work, disk I/O and packaged runtime.",
    rows,
  }, null, 2)}\n`);
}

main();
