#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PER_PROFILE_RUNTIME_ROOTS = Object.freeze([
  "antigravity", "claude-code", "codex", "deepseek-harness", "grok-build", "pi",
]);

export const FOOTPRINT_CATEGORIES = Object.freeze([
  "cache", "log", "tmp", "nodeModules", "pnpmStore", "other",
]);

const DEFAULT_MAX_ENTRIES = 1_000_000;
const DEFAULT_MAX_DEPTH = 128;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const PNPM_STORE_SEGMENTS = new Set([".pnpm-store", "pnpm-store"]);
const TEMP_SEGMENTS = new Set([".tmp", "tmp", ".temp", "temp", "temporary"]);
const CACHE_SEGMENTS = new Set([".cache", "cache", "caches", "shell_snapshots"]);
const LOG_SEGMENTS = new Set([".log", "log", "logs"]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function pathSegments(relativePath) {
  if (Array.isArray(relativePath)) return relativePath;
  if (typeof relativePath !== "string") return [];
  return relativePath.split(/[\\/]/u).filter(Boolean);
}

/**
 * Assigns an entry to one exclusive footprint. More specific dependency stores
 * win over generic cache/tmp/log names so category byte totals never overlap.
 */
export function classifyStorageFootprint(relativePath) {
  const segments = pathSegments(relativePath);
  const lower = segments.map((segment) => segment.toLowerCase());
  const base = lower.at(-1) || "";
  const hasSegment = (values) => lower.some((segment) => values.has(segment));

  if (hasSegment(PNPM_STORE_SEGMENTS)
    || lower.some((segment, index) => segment === "pnpm" && lower[index + 1] === "store")) {
    return "pnpmStore";
  }
  if (lower.includes("node_modules")) return "nodeModules";
  if (hasSegment(TEMP_SEGMENTS)
    || /(?:^|[._-])tmp(?:[._-]|$)/u.test(base)) {
    return "tmp";
  }
  if (hasSegment(CACHE_SEGMENTS)) return "cache";
  if (hasSegment(LOG_SEGMENTS)
    || /\.log(?:[._-].*)?$/u.test(base)
    || /^logs?[_-].*\.sqlite(?:-[a-z]+)?$/u.test(base)) {
    return "log";
  }
  return "other";
}

function emptyStats() {
  return {
    bytes: 0,
    fileCount: 0,
    directoryCount: 0,
    symlinkCount: 0,
    otherEntryCount: 0,
    footprints: Object.fromEntries(FOOTPRINT_CATEGORIES.map((category) => [category, {
      bytes: 0,
      fileCount: 0,
      directoryCount: 0,
      symlinkCount: 0,
      otherEntryCount: 0,
    }])),
  };
}

function addEntry(stats, entry) {
  const category = classifyStorageFootprint(entry.segments);
  const footprint = stats.footprints[category];
  const countField = entry.type === "file"
    ? "fileCount"
    : entry.type === "directory"
      ? "directoryCount"
      : entry.type === "symlink"
        ? "symlinkCount"
        : "otherEntryCount";
  stats[countField] += 1;
  footprint[countField] += 1;
  if (entry.type === "file") {
    stats.bytes += entry.bytes;
    footprint.bytes += entry.bytes;
  }
}

function mergeStats(target, source) {
  for (const field of ["bytes", "fileCount", "directoryCount", "symlinkCount", "otherEntryCount"]) {
    target[field] += source[field];
  }
  for (const category of FOOTPRINT_CATEGORIES) {
    const targetFootprint = target.footprints[category];
    const sourceFootprint = source.footprints[category];
    for (const field of ["bytes", "fileCount", "directoryCount", "symlinkCount", "otherEntryCount"]) {
      targetFootprint[field] += sourceFootprint[field];
    }
  }
}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function summarizeEntries({ root, entries, generatedAt }) {
  const totals = emptyStats();
  const topLevel = new Map();
  const homesByRuntime = new Map(PER_PROFILE_RUNTIME_ROOTS.map((runtime) => [runtime, new Map()]));

  for (const entry of entries) {
    addEntry(totals, entry);
    const topName = entry.segments[0];
    if (topName) {
      if (!topLevel.has(topName)) topLevel.set(topName, emptyStats());
      addEntry(topLevel.get(topName), entry);
    }

    const runtimeHomes = homesByRuntime.get(topName);
    const runtimeProfileId = entry.segments[1];
    if (!runtimeHomes || !runtimeProfileId) continue;
    if (entry.segments.length === 2 && entry.type === "directory") {
      runtimeHomes.set(runtimeProfileId, emptyStats());
    }
    const home = runtimeHomes.get(runtimeProfileId);
    if (home) addEntry(home, entry);
  }

  const runtimeHomeTotals = emptyStats();
  const byRuntime = PER_PROFILE_RUNTIME_ROOTS.map((runtime) => {
    const homes = [...homesByRuntime.get(runtime).entries()]
      .sort(([left], [right]) => compareNames(left, right))
      .map(([runtimeProfileId, stats]) => ({
        runtimeProfileId,
        relativePath: `${runtime}/${runtimeProfileId}`,
        stats,
      }));
    const stats = emptyStats();
    for (const home of homes) mergeStats(stats, home.stats);
    mergeStats(runtimeHomeTotals, stats);
    return { runtime, homeCount: homes.length, stats, homes };
  });

  return {
    schemaVersion: 1,
    generatedAt,
    root,
    measurement: {
      scope: "explicitly-supplied-state-root",
      byteMetric: "apparent regular-file bytes",
      rootDirectoryIncluded: false,
      symlinkPolicy: "count link entry with zero bytes; never follow target",
      footprintPolicy: "exclusive; pnpmStore > nodeModules > tmp > cache > log > other",
      runtimeHomeRule: "<root>/<runtime>/<runtimeProfileId>",
    },
    totals,
    runtimeHomes: {
      homeCount: byRuntime.reduce((count, runtime) => count + runtime.homeCount, 0),
      stats: runtimeHomeTotals,
      byRuntime,
    },
    topLevel: [...topLevel.entries()]
      .sort(([left], [right]) => compareNames(left, right))
      .map(([name, stats]) => ({ name, stats })),
  };
}

function resolveInspectionRoot(stateRoot) {
  if (typeof stateRoot !== "string" || stateRoot.trim() === "") {
    fail("STORAGE_ROOT_REQUIRED", "--root <fixture-or-state-root> is required");
  }
  const requestedRoot = path.resolve(stateRoot);
  let rootStat;
  try {
    rootStat = fs.lstatSync(requestedRoot);
  } catch (error) {
    fail("STORAGE_ROOT_UNREADABLE", `cannot inspect ${requestedRoot}: ${error.message}`);
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail("STORAGE_ROOT_INVALID", "inspection root must be a real directory, not a file or symlink");
  }
  const root = fs.realpathSync(requestedRoot);
  const filesystemRoot = path.parse(root).root;
  let userHome = null;
  try {
    userHome = fs.realpathSync(os.homedir());
  } catch {
    // A missing home does not make an explicitly supplied fixture unsafe.
  }
  if (root === filesystemRoot || (userHome && root === userHome)) {
    fail("STORAGE_ROOT_UNSAFE", "refusing to inspect the filesystem root or the user's home directory");
  }
  return root;
}

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function queueDirectory(root, absolutePath, segments, stat) {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail("STORAGE_DIRECTORY_CHANGED", `directory changed before it could be queued: ${absolutePath}`);
  }
  let expectedRealPath;
  try {
    expectedRealPath = fs.realpathSync(absolutePath);
  } catch (error) {
    fail("STORAGE_DIRECTORY_CHANGED", `cannot resolve queued directory ${absolutePath}: ${error.message}`);
  }
  if (!isWithinRoot(root, expectedRealPath)) {
    fail("STORAGE_DIRECTORY_ESCAPE", `queued directory resolves outside the inspection root: ${absolutePath}`);
  }
  return {
    absolutePath,
    segments,
    expectedDev: stat.dev,
    expectedIno: stat.ino,
    expectedRealPath,
  };
}

function verifyQueuedDirectory(root, queued) {
  let stat;
  try {
    stat = fs.lstatSync(queued.absolutePath);
  } catch (error) {
    fail("STORAGE_DIRECTORY_CHANGED", `queued directory disappeared: ${queued.absolutePath}: ${error.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()
    || stat.dev !== queued.expectedDev || stat.ino !== queued.expectedIno) {
    fail("STORAGE_DIRECTORY_CHANGED", `queued directory identity changed: ${queued.absolutePath}`);
  }
  let realPath;
  try {
    realPath = fs.realpathSync(queued.absolutePath);
  } catch (error) {
    fail("STORAGE_DIRECTORY_CHANGED", `cannot re-resolve queued directory ${queued.absolutePath}: ${error.message}`);
  }
  if (!isWithinRoot(root, realPath)) {
    fail("STORAGE_DIRECTORY_ESCAPE", `queued directory resolves outside the inspection root: ${queued.absolutePath}`);
  }
  if (realPath !== queued.expectedRealPath) {
    fail("STORAGE_DIRECTORY_CHANGED", `queued directory resolved path changed: ${queued.absolutePath}`);
  }
  return realPath;
}

function entryType(stat) {
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  if (stat.isSymbolicLink()) return "symlink";
  return "other";
}

function* walkEntries(root, { maxEntries, maxDepth }) {
  const rootStat = fs.lstatSync(root);
  const stack = [queueDirectory(root, root, [], rootStat)];
  let visitedEntries = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    const verifiedPath = verifyQueuedDirectory(root, current);
    const names = fs.readdirSync(verifiedPath).sort(compareNames);
    const childDirectories = [];
    for (const name of names) {
      visitedEntries += 1;
      if (visitedEntries > maxEntries) {
        fail("STORAGE_ENTRY_LIMIT", `inspection exceeded the ${maxEntries} entry safety limit`);
      }
      const absolutePath = path.join(verifiedPath, name);
      const segments = [...current.segments, name];
      const stat = fs.lstatSync(absolutePath);
      const type = entryType(stat);
      yield { segments, type, bytes: type === "file" ? stat.size : 0 };
      if (type === "directory") {
        if (segments.length >= maxDepth) {
          fail("STORAGE_DEPTH_LIMIT", `inspection exceeded the ${maxDepth} level safety limit`);
        }
        childDirectories.push(queueDirectory(root, absolutePath, segments, stat));
      }
    }
    for (let index = childDirectories.length - 1; index >= 0; index -= 1) {
      stack.push(childDirectories[index]);
    }
  }
}

function resolveGeneratedAt(now) {
  if (typeof now !== "function") {
    fail("STORAGE_CLOCK_INVALID", "now must be a function returning a valid Date");
  }
  let value;
  try {
    value = now();
  } catch (error) {
    fail("STORAGE_CLOCK_INVALID", `now failed: ${error.message}`);
  }
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    fail("STORAGE_CLOCK_INVALID", "now must return a valid Date");
  }
  return value.toISOString();
}

/**
 * Produces a read-only snapshot of a fixture or Shoggoth state root. The root
 * is mandatory and symlink targets are never traversed or charged as bytes.
 */
export function measureRuntimeAccountStorage(stateRoot, options = {}) {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    fail("STORAGE_LIMIT_INVALID", "maxEntries must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
    fail("STORAGE_LIMIT_INVALID", "maxDepth must be a positive safe integer");
  }
  const root = resolveInspectionRoot(stateRoot);
  return summarizeEntries({
    root,
    entries: walkEntries(root, { maxEntries, maxDepth }),
    generatedAt: resolveGeneratedAt(options.now ?? (() => new Date())),
  });
}

function parseArguments(argv) {
  const options = { json: false, selfTest: false, help: false, maxEntries: DEFAULT_MAX_ENTRIES };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--self-test") options.selfTest = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--root") options.root = argv[++index];
    else if (argument === "--max-entries") options.maxEntries = Number(argv[++index]);
    else fail("STORAGE_ARGUMENT_INVALID", `unknown argument: ${argument}`);
  }
  if (options.help) return options;
  if (options.selfTest && options.root) {
    fail("STORAGE_ARGUMENT_INVALID", "--self-test cannot be combined with --root");
  }
  if (!options.selfTest && !options.root) {
    fail("STORAGE_ROOT_REQUIRED", "--root <fixture-or-state-root> is required; no user-home default exists");
  }
  return options;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(1)} ${unit}`;
}

function printHumanReport(report) {
  console.log("Shoggoth RuntimeAccount storage snapshot");
  console.log(`Root: ${report.root}`);
  console.log(`Total: ${formatBytes(report.totals.bytes)}; ${report.totals.fileCount} files; ${report.totals.directoryCount} directories; ${report.totals.symlinkCount} symlinks`);
  console.log(`Per-profile Runtime Homes: ${report.runtimeHomes.homeCount}; ${formatBytes(report.runtimeHomes.stats.bytes)}`);
  for (const runtime of report.runtimeHomes.byRuntime) {
    console.log(`  ${runtime.runtime}: ${runtime.homeCount} homes; ${formatBytes(runtime.stats.bytes)}`);
  }
  console.log("Footprints (exclusive, whole supplied root):");
  for (const category of FOOTPRINT_CATEGORIES) {
    const footprint = report.totals.footprints[category];
    console.log(`  ${category}: ${formatBytes(footprint.bytes)}; ${footprint.fileCount} files; ${footprint.directoryCount} directories; ${footprint.symlinkCount} symlinks`);
  }
}

function fixtureEntry(relativePath, type, bytes = 0) {
  return { segments: relativePath.split("/"), type, bytes };
}

async function runHundredAgentCreationRegression() {
  const {
    createAgentLifecycleServiceController,
  } = require("../app/agent-service/agent-lifecycle-service-controller.js");
  const { JsonlProductStore } = require("../app/agent-service/product-store.js");
  const { resolveServicePaths } = require("../app/agent-service/paths.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-account-storage-100-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({
    trustedRoot: root,
    stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"),
  });
  const productStore = new JsonlProductStore({ paths, now: () => 10_000 });
  let controller;
  try {
    productStore.open();
    const before = measureRuntimeAccountStorage(paths.stateDir, {
      maxEntries: 50_000,
      now: () => new Date("2026-09-07T00:00:00.000Z"),
    });
    controller = createAgentLifecycleServiceController({
      productStore,
      runtimeManager: { async stop() {} },
      async initializeProfile() {},
      async activateProfile() {},
      now: () => 10_000,
    });
    controller.open();
    const backends = [
      "shoggoth", "codex", "grok-build", "antigravity", "pi", "claude-code",
      "deepseek-harness",
    ];
    const created = [];
    for (let index = 0; index < 100; index += 1) {
      const backendId = backends[index % backends.length];
      const result = await controller.handle("agent.create", {
        operationId: `storage-regression-create-${index}`,
        backendId,
        name: `Storage regression ${index}`,
        defaultCwd: null,
        createdAt: 10_000,
      });
      created.push(result.profile);
    }
    const after = measureRuntimeAccountStorage(paths.stateDir, {
      maxEntries: 50_000,
      now: () => new Date("2026-09-07T00:00:00.000Z"),
    });
    const addedBytes = after.totals.bytes - before.totals.bytes;
    assert.equal(created.length, 100);
    assert.equal(after.runtimeHomes.homeCount, before.runtimeHomes.homeCount,
      "creating logical Agents must not add per-Profile Runtime Homes");
    assert.ok(addedBytes >= 0 && addedBytes < 25 * 1024 * 1024,
      `100-Agent metadata delta must stay below 25 MiB; got ${addedBytes}`);
    assert.ok(addedBytes / created.length < 256 * 1024,
      `per-Agent metadata delta must stay below 256 KiB; got ${addedBytes / created.length}`);
    for (const backendId of backends) {
      const accountIds = new Set(created
        .filter((profile) => profile.backendId === backendId)
        .map((profile) => profile.runtimeAccountId));
      assert.equal(accountIds.size, 1, `${backendId} must use one default RuntimeAccount`);
    }
    assert.equal(after.totals.footprints.pnpmStore.bytes, 0);
    assert.equal(after.totals.footprints.nodeModules.bytes, 0);
  } finally {
    if (controller) await controller.close().catch(() => {});
    try { productStore.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function runSelfTest() {
  const fixture = [
    fixtureEntry("codex", "directory"),
    fixtureEntry("codex/alpha", "directory"),
    fixtureEntry("codex/alpha/cache", "directory"),
    fixtureEntry("codex/alpha/cache/cache.bin", "file", 3),
    fixtureEntry("codex/alpha/cache/external-link", "symlink", 10_000),
    fixtureEntry("codex/alpha/logs", "directory"),
    fixtureEntry("codex/alpha/logs/cli.log", "file", 5),
    fixtureEntry("codex/beta", "directory"),
    fixtureEntry("codex/beta/.tmp/arg0/runtime.bin", "file", 7),
    fixtureEntry("grok-build", "directory"),
    fixtureEntry("grok-build/grok-a", "directory"),
    fixtureEntry("grok-build/grok-a/Library/pnpm/store/v11/package.bin", "file", 11),
    fixtureEntry("antigravity", "directory"),
    fixtureEntry("antigravity/agy-a", "directory"),
    fixtureEntry("antigravity/agy-a/.gemini/antigravity-cli/logs_1.sqlite", "file", 23),
    fixtureEntry("pi", "directory"),
    fixtureEntry("pi/pi-a", "directory"),
    fixtureEntry("claude-code", "directory"),
    fixtureEntry("claude-code/claude-a", "directory"),
    fixtureEntry("claude-code/claude-a/session.json", "file", 17),
    fixtureEntry("deepseek-harness", "directory"),
    fixtureEntry("deepseek-harness/dsh-a", "directory"),
    fixtureEntry("deepseek-harness/dsh-a/profiles/node_modules/pkg/index.js", "file", 13),
    fixtureEntry("backups", "directory"),
    fixtureEntry("backups/pre-migration/payload.bin", "file", 19),
  ];
  const report = summarizeEntries({
    root: path.resolve("fixture-state-root"),
    entries: fixture,
    generatedAt: "2026-09-07T00:00:00.000Z",
  });
  assert.equal(report.totals.bytes, 98, "symlink targets must not contribute bytes");
  assert.equal(report.totals.symlinkCount, 1);
  assert.equal(report.runtimeHomes.homeCount, 7);
  assert.equal(report.runtimeHomes.stats.bytes, 79);
  assert.deepEqual(
    Object.fromEntries(FOOTPRINT_CATEGORIES.map((category) => [
      category,
      report.totals.footprints[category].bytes,
    ])),
    { cache: 3, log: 28, tmp: 7, nodeModules: 13, pnpmStore: 11, other: 36 },
  );
  const codex = report.runtimeHomes.byRuntime.find((runtime) => runtime.runtime === "codex");
  assert.deepEqual(codex.homes.map((home) => home.runtimeProfileId), ["alpha", "beta"]);
  assert.equal(codex.stats.bytes, 15);
  assert.equal(report.topLevel.find((entry) => entry.name === "backups").stats.bytes, 19);
  assert.equal(classifyStorageFootprint("x/Library/pnpm/store/v3/pkg"), "pnpmStore");
  assert.equal(classifyStorageFootprint("x/profiles/node_modules/pkg"), "nodeModules");
  assert.equal(classifyStorageFootprint("x/shell_snapshots/1.sh"), "cache");
  assert.throws(() => parseArguments([]), (error) => error.code === "STORAGE_ROOT_REQUIRED");
  if (fs.existsSync(os.homedir())) {
    assert.throws(
      () => resolveInspectionRoot(os.homedir()),
      (error) => error.code === "STORAGE_ROOT_UNSAFE",
    );
  }
  const readOnlySmoke = measureRuntimeAccountStorage(path.join(SCRIPT_DIR, "fixtures"), {
    maxEntries: 10_000,
    now: () => new Date("2026-09-07T00:00:00.000Z"),
  });
  assert.equal(readOnlySmoke.measurement.symlinkPolicy.includes("never follow"), true);
  const smokeStat = fs.lstatSync(readOnlySmoke.root);
  const queuedSmoke = queueDirectory(readOnlySmoke.root, readOnlySmoke.root, [], smokeStat);
  assert.equal(verifyQueuedDirectory(readOnlySmoke.root, queuedSmoke), readOnlySmoke.root);
  assert.throws(
    () => verifyQueuedDirectory(readOnlySmoke.root, {
      ...queuedSmoke,
      expectedIno: `${queuedSmoke.expectedIno}-replacement`,
    }),
    (error) => error.code === "STORAGE_DIRECTORY_CHANGED",
  );
  assert.throws(
    () => resolveGeneratedAt(() => new Date(Number.NaN)),
    (error) => error.code === "STORAGE_CLOCK_INVALID",
  );
  assert.throws(
    () => resolveGeneratedAt(() => "2026-09-07T00:00:00.000Z"),
    (error) => error.code === "STORAGE_CLOCK_INVALID",
  );
  await runHundredAgentCreationRegression();
  console.log("PASS runtime-account storage regression self-test");
}

function printHelp() {
  console.log(`Usage:
  node scripts/runtime-account-storage-regression.mjs --root <fixture-or-state-root> [--json] [--max-entries N]
  node scripts/runtime-account-storage-regression.mjs --self-test

The measurement is read-only. There is intentionally no default root, and the
filesystem root and the user's home directory are refused.`);
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) return printHelp();
  if (options.selfTest) return runSelfTest();
  const report = measureRuntimeAccountStorage(options.root, { maxEntries: options.maxEntries });
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printHumanReport(report);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`ERROR ${error.code || "STORAGE_INSPECTION_FAILED"}: ${error.message}`);
    process.exitCode = 1;
  });
}
