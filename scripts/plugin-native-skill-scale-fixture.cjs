#!/usr/bin/env node
"use strict";

// Exercise real, durable independent Skill installs through NativeSkillStore.
// Everything lives under a fresh temporary HOME and Service root; this probe
// never reads or writes the caller's Shoggoth user data.
// Optional batch mode commits at most 64 Skills at once. Its per-Skill timing
// is the batch API duration divided by that batch's item count; it excludes
// source creation and cleanup, just like the single-install API timing.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createAgentService } = require("../app/agent-service/server");
const { ensureCredential } = require("../app/agent-service/external-plugin-adapter-auth");

const LIMIT = Number(process.argv[2] || 500);
const INSTALL_MODE = process.argv[3] || "single";
const BATCH_SIZE = 64;
const MAX_MS = Number(process.env.SHOGGOTH_SCALE_MAX_MS || 15 * 60_000);
const MIN_FREE_BYTES = Math.floor(1.5 * 1024 ** 3);
const REGISTRY_READ_LIMIT = 4 * 1024 ** 2;
const CHECKPOINTS = LIMIT === 5_000 ? new Set([500, 5_000]) : new Set([LIMIT]);
assert([50, 500, 5_000].includes(LIMIT) && ["single", "batch"].includes(INSTALL_MODE),
  "usage: node scripts/plugin-native-skill-scale-fixture.cjs 50|500|5000 [single|batch]");
assert(Number.isSafeInteger(MAX_MS) && MAX_MS >= 30_000 && MAX_MS <= 60 * 60_000,
  "SHOGGOTH_SCALE_MAX_MS must be 30000..3600000");

const emit = (event) => console.log(JSON.stringify(event));
const byteLength = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const elapsedMs = (start) => Math.round(performance.now() - start);
const freeBytes = (root) => {
  const stat = fs.statfsSync(root);
  return Number(stat.bavail) * Number(stat.bsize);
};
const skillName = (index, total) => index === total
  ? `zz-scale-tail-${String(index).padStart(5, "0")}`
  : `scale-skill-${String(index).padStart(5, "0")}`;

function treeBytes(target) {
  let logical = 0;
  let allocated = 0;
  let files = 0;
  let directories = 0;
  let sockets = 0;
  const visit = (current) => {
    const stat = fs.lstatSync(current);
    assert(!stat.isSymbolicLink(), `probe tree contains a symlink: ${current}`);
    allocated += stat.blocks * 512;
    if (stat.isFile()) { files += 1; logical += stat.size; return; }
    if (stat.isSocket()) { sockets += 1; return; }
    assert(stat.isDirectory(), `probe tree contains a special file: ${current}`);
    directories += 1;
    for (const name of fs.readdirSync(current)) visit(path.join(current, name));
  };
  visit(target);
  return { logicalBytes: logical, allocatedBytes: allocated, files, directories, sockets };
}

function writeSource(source, name, index) {
  const description = `Persistent local scale fixture item ${index}.`;
  fs.writeFileSync(path.join(source, "skill.json"), JSON.stringify({
    schemaVersion: 1, id: name, name, version: "1.0.0", description,
    entry: "SKILL.md", requiredTools: [], requiredRuntimeCapabilities: [],
    sourceCompatibility: ["shoggoth", "openclaw", "hermes"],
  }) + "\n", { mode: 0o600 });
  fs.writeFileSync(path.join(source, "SKILL.md"),
    `# ${name}\n\nThis is isolated, durable scale fixture item ${index}.\n`, { mode: 0o600 });
}

async function main() {
  // macOS AF_UNIX socket paths are short. Use /private/tmp so the Service
  // socket cannot silently bind to a truncated path.
  const root = fs.mkdtempSync(path.join("/private/tmp", "sgns-"));
  const originalHome = process.env.HOME;
  try {
    fs.chmodSync(root, 0o700);
    process.env.HOME = root;
    await runProbe(root);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    // Only remove the exact mkdtemp directory created above, including on
    // setup, deadline, disk-reserve, startup, install, query or restart failure.
    assert(path.basename(root).startsWith("sgns-"));
    fs.rmSync(root, { recursive: true, force: true });
    emit({ event: "cleaned", rootRemoved: !fs.existsSync(root) });
  }
}

async function runProbe(root) {
  const paths = resolveServicePaths({ homeDir: root, userDataRoot: path.join(root, "service"),
    stateRoot: path.join(root, "service", "shoggoth-core"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const source = path.join(root, "source");
  fs.mkdirSync(source, { mode: 0o700 });
  let service = null;
  let installedCount = 0;
  let commitCount = 0;
  let peakSampledRss = process.memoryUsage().rss;
  let stopSignal = null;
  const timings = [];
  const started = performance.now();
  const beforeFree = freeBytes(root);
  const beforeRss = process.memoryUsage().rss;
  const onInterrupt = () => { stopSignal = "SIGINT"; };
  const onTerminate = () => { stopSignal = "SIGTERM"; };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  const startService = async () => {
    const next = createAgentService({ paths, prewarmMcpAuth: false, parentEnv: { HOME: root },
      externalPluginAgentVerifier: async identity => ({ id: identity.agentId,
        backendId: identity.backendId }), version: "native-skill-scale-fixture" });
    await next.start();
    service = next;
  };
  const stopService = async () => {
    if (!service) return;
    const current = service;
    service = null;
    await current.stop();
  };
  const guard = () => {
    if (stopSignal) throw Object.assign(new Error(`interrupted by ${stopSignal}`), { code: stopSignal });
    if (performance.now() - started > MAX_MS) {
      throw Object.assign(new Error(`scale deadline ${MAX_MS} ms reached`), { code: "SCALE_DEADLINE" });
    }
    const available = freeBytes(root);
    if (available < MIN_FREE_BYTES) {
      throw Object.assign(new Error(`free space ${available} below reserve ${MIN_FREE_BYTES}`),
        { code: "SCALE_DISK_RESERVE" });
    }
  };
  const queryCheckpoint = async (count) => {
    guard();
    const restartStart = performance.now();
    await stopService();
    await startService();
    const restartMs = elapsedMs(restartStart);
    const native = service.nativeSkillStore;
    const profile = service.productStore.listAgentProfiles().find(item => item.enabled);
    assert(profile, "isolated Service has no enabled native Agent Profile");
    const tail = skillName(count, count);
    const listedStart = performance.now();
    const listed = native.list(profile.id);
    const listMs = elapsedMs(listedStart);
    const persisted = listed.items.filter(item => item.source === "user");
    assert.equal(persisted.length, count, "durable registry lost Skills after restart");
    assert(persisted.every(item => item.enabled && item.globalEnabled),
      "a persisted Skill was not globally enabled");
    assert.equal(native.listGlobalEnabled().length, count);
    assert.equal(native.listGlobalEnabled().at(-1)?.name, tail,
      "the target must be the final persisted Skill, not a synthetic descriptor");
    const authority = () => ({ profileId: profile.id, callId: crypto.randomUUID(), confirmation: true });
    const catalogStart = performance.now();
    const nativeSearch = await service.mcpProductToolController.handle("skill_catalog",
      { query: tail, cursor: 0, limit: 5 }, authority());
    const nativeSearchMs = elapsedMs(catalogStart);
    assert.equal(nativeSearch.items.length, 1, "native catalog failed to find the tail Skill");
    assert.equal(nativeSearch.items[0].name, tail);
    assert.equal(nativeSearch.hasMore, false);
    const nativeRead = await service.mcpProductToolController.handle("skill_read", {
      name: tail, contentHash: nativeSearch.items[0].contentHash, cursor: 0, maxBytes: 8_000,
    }, authority());
    assert.match(nativeRead.content, new RegExp(`fixture item ${count}`));
    const identity = { backendId: "openclaw", instanceId: "scale-instance", agentId: "scale-agent",
      sessionId: "scale-session", runId: `scale-run-${count}`, toolCallId: `scale-tool-${count}` };
    const credentialToken = ensureCredential(paths, "openclaw");
    const externalStart = performance.now();
    const opened = await service.externalPluginToolService.open({ credentialToken, identity });
    const externalSearch = await service.externalPluginToolService.search({ token: opened.token,
      identity, query: tail, cursor: 0, limit: 5 });
    const externalSearchMs = elapsedMs(externalStart);
    assert.equal(externalSearch.items.length, 1, "external catalog failed to find tail Skill");
    assert.equal(externalSearch.items[0].name, tail);
    assert.equal(externalSearch.total, 1);
    assert.equal(externalSearch.nextCursor, null);
    const readLease = await service.externalPluginToolService.open({ credentialToken, identity });
    const externalRead = await service.externalPluginToolService.readSkill({
      token: readLease.token, identity, skillId: externalSearch.items[0].id, cursor: 0 });
    assert.match(externalRead.content, new RegExp(`fixture item ${count}`));
    const first50 = timings.slice(0, 50);
    const last50 = timings.slice(-50);
    const disk = treeBytes(root);
    const row = { event: "checkpoint", count, installMode: INSTALL_MODE,
      batchSize: INSTALL_MODE === "batch" ? BATCH_SIZE : 1, commitCount,
      durationMs: elapsedMs(started),
      installMs: Math.round(timings.reduce((sum, value) => sum + value, 0)),
      first50MeanInstallMs: Math.round(first50.reduce((sum, value) => sum + value, 0) / first50.length),
      last50MeanInstallMs: Math.round(last50.reduce((sum, value) => sum + value, 0) / last50.length),
      restartMs, listMs, nativeSearchMs, externalSearchMs,
      registryBytes: fs.statSync(paths.skillRegistryPath).size,
      registryReadLimitBytes: REGISTRY_READ_LIMIT,
      listResponseBytes: byteLength(listed),
      nativeSearchResponseBytes: byteLength(nativeSearch),
      externalSearchResponseBytes: byteLength(externalSearch),
      nativeReadResponseBytes: byteLength(nativeRead),
      externalReadResponseBytes: byteLength(externalRead),
      processRssBytes: process.memoryUsage().rss, peakSampledRssBytes: peakSampledRss,
      disk, freeBytes: freeBytes(root), target: tail };
    emit(row);
  };
  emit({ event: "start", limit: LIMIT, installMode: INSTALL_MODE,
    batchSize: INSTALL_MODE === "batch" ? BATCH_SIZE : 1, beforeFreeBytes: beforeFree,
    beforeRssBytes: beforeRss, reserveBytes: MIN_FREE_BYTES, maxMs: MAX_MS });
  try {
    guard();
    await startService();
    for (let index = 1; index <= LIMIT;) {
      if (index % 10 === 1) guard();
      const nextCheckpoint = [...CHECKPOINTS].find((count) => count >= index) || LIMIT;
      const end = INSTALL_MODE === "batch"
        ? Math.min(index + BATCH_SIZE - 1, nextCheckpoint, LIMIT) : index;
      const items = [];
      for (let itemIndex = index; itemIndex <= end; itemIndex += 1) {
        const name = skillName(itemIndex, CHECKPOINTS.has(itemIndex) ? itemIndex : -1);
        const sourcePath = INSTALL_MODE === "batch"
          ? path.join(source, String(itemIndex).padStart(5, "0")) : source;
        if (INSTALL_MODE === "batch") fs.mkdirSync(sourcePath, { mode: 0o700 });
        writeSource(sourcePath, name, itemIndex);
        items.push({ sourcePath, globalEnabled: true, name });
      }
      let installMs;
      try {
        const installStart = performance.now();
        if (INSTALL_MODE === "batch") {
          const result = service.nativeSkillStore.installBatchFromDirectories({
            operationId: `scale-batch-${String(index).padStart(5, "0")}`,
            expectedRevision: service.nativeSkillStore.revision,
            items: items.map(({ sourcePath, globalEnabled }) => ({ sourcePath, globalEnabled })),
          });
          assert.equal(result.revision, commitCount + 2);
          assert.deepEqual(result.packages.map((item) => item.name), items.map((item) => item.name));
        } else {
          const result = service.nativeSkillStore.installFromDirectory({
            sourcePath: source, operationId: `scale-install-${String(index).padStart(5, "0")}`,
            expectedRevision: service.nativeSkillStore.revision, globalEnabled: true,
          });
          assert.equal(result.package.name, items[0].name);
          assert.equal(result.revision, index + 1);
        }
        installMs = performance.now() - installStart;
      } finally {
        if (INSTALL_MODE === "batch") {
          for (const item of items) fs.rmSync(item.sourcePath, { recursive: true, force: true });
        }
      }
      commitCount += 1;
      for (let itemIndex = index; itemIndex <= end; itemIndex += 1) {
        timings.push(installMs / items.length);
      }
      installedCount = end;
      if (installedCount % 10 === 0) peakSampledRss = Math.max(peakSampledRss, process.memoryUsage().rss);
      if (CHECKPOINTS.has(installedCount)) await queryCheckpoint(installedCount);
      else if (installedCount % 500 === 0 || (INSTALL_MODE === "batch" && commitCount % 10 === 0)) {
        emit({ event: "progress", installedCount, installMode: INSTALL_MODE, commitCount,
          durationMs: elapsedMs(started), registryBytes: fs.statSync(paths.skillRegistryPath).size,
          freeBytes: freeBytes(root), peakSampledRssBytes: peakSampledRss });
      }
      index = end + 1;
    }
    emit({ event: "complete", installedCount, installMode: INSTALL_MODE, commitCount,
      durationMs: elapsedMs(started),
      afterFreeBytes: freeBytes(root) });
  } catch (error) {
    emit({ event: "failed", installedCount, durationMs: elapsedMs(started),
      code: error.code || error.name || "ERROR", message: String(error.message).slice(0, 500),
      registryBytes: fs.existsSync(paths.skillRegistryPath)
        ? fs.statSync(paths.skillRegistryPath).size : null,
      freeBytes: freeBytes(root), processRssBytes: process.memoryUsage().rss });
    process.exitCode = 1;
  } finally {
    try { await stopService(); } catch (error) {
      emit({ event: "stop_failed", code: error.code || error.name || "ERROR",
        message: String(error.message).slice(0, 300) });
      process.exitCode = 1;
    }
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
