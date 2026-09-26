#!/usr/bin/env node
"use strict";

// Usage: node scripts/plugin-performance-baseline.cjs [--samples=21]
// Writes only .artifacts/plugin-complete-0.8.146/performance.{json,md}.
// Every scenario uses its own process and disposable Product15 directory.
// The MCP peer is an in-memory fixture: these numbers exclude real transport,
// subprocess startup, OAuth, provider latency, GUI and packaged-App behavior.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");

const repo = path.resolve(__dirname, "..");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const rounded = value => Math.round(value * 1000) / 1000;
const percentile = (sorted, p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: values.length, minMs: rounded(sorted[0]), p50Ms: rounded(percentile(sorted, 0.5)),
    p95Ms: rounded(percentile(sorted, 0.95)), maxMs: rounded(sorted.at(-1)),
    totalMs: rounded(values.reduce((sum, value) => sum + value, 0)), samplesMs: values.map(rounded) };
}
function fixtureTools(count) {
  return Array.from({ length: count }, (_, index) => ({ name: `read_fixture_${String(index).padStart(4, "0")}`,
    description: "Read a fixed local performance fixture. This tool has no external effect.",
    inputSchema: { type: "object", additionalProperties: false, properties: { query: { type: "string", maxLength: 128 },
      limit: { type: "integer", minimum: 1, maximum: 20 } }, required: ["query"] } }));
}

async function worker(packageCount, toolCount, repeats, memoryMode = "unforced") {
  const loadStart = performance.now();
  const { resolveServicePaths } = require("../app/agent-service/paths");
  const { PluginStore } = require("../app/agent-service/plugin-store");
  const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
  const { previewPluginDirectory } = require("../app/agent-service/plugin-package-parser");
  const { PluginComponentCatalog } = require("../app/agent-service/plugin-component-catalog");
  const { PluginComponentResolver } = require("../app/agent-service/plugin-component-resolver");
  const { PluginServiceController } = require("../app/agent-service/plugin-service-controller");
  const { PluginToolCatalogRegistry } = require("../app/agent-service/plugin-tool-catalog-registry");
  const { buildPluginToolCatalog } = require("../app/agent-service/plugin-tool-contract");
  const { PluginRuntimeToolService, pluginServerId } = require("../app/agent-service/plugin-runtime-tool-service");
  const { CapabilityDispatcher } = require("../app/agent-service/capability-dispatcher");
  const { PermissionEngine } = require("../app/agent-service/permission-engine");
  const moduleLoadMs = performance.now() - loadStart;
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "plugin-perf-")));
  const paths = resolveServicePaths({ userDataRoot: path.join(temp, "user"),
    cacheRoot: path.join(temp, "cache"), trustedRoot: temp });
  let store, installer, runtime, dispatcher;
  const metrics = {}, sizes = {}, boundaries = [];
  let sampledRssBytes = process.memoryUsage().rss;
  const memory = () => { sampledRssBytes = Math.max(sampledRssBytes, process.memoryUsage().rss); };
  async function sample(name, action) {
    const times = [];
    const rssBeforeBytes = process.memoryUsage().rss;
    let value, firstMs;
    for (let index = 0; index <= repeats; index++) {
      const start = performance.now(); value = await action(index);
      const duration = performance.now() - start;
      if (index === 0) firstMs = duration; else times.push(duration);
      memory();
      // Diagnostics only, outside the timed production operation. The default
      // baseline never forces GC or yields beyond the production awaits.
      if (memoryMode === "event-loop") await new Promise(setImmediate);
      if (memoryMode === "forced-gc") { global.gc(); await new Promise(setImmediate); }
    }
    metrics[name] = { firstMs: rounded(firstMs), ...distribution(times),
      rssBeforeBytes, rssAfterBytes: process.memoryUsage().rss };
    return value;
  }
  const profile = { id: "performance-profile", enabled: true };
  const productStore = { getAgentProfile: id => id === profile.id ? profile : null };
  const registry = { revision: "performance-product-tools", get: name => name === "mcp_server_call"
    ? { tool: name, enabled: true, risk: "read" } : null,
    list: () => [{ tool: "mcp_server_call", enabled: true, risk: "read" }] };
  let result;
  try {
    const storeOpenStart = performance.now();
    store = new PluginStore({ paths }).open();
    const emptyStoreInitializeMs = performance.now() - storeOpenStart;
    installer = new PluginPackageInstaller({ store });
    const sources = [], installed = [], installDurations = [];
    let sourceBytes = 0, sourceFiles = 0;
    for (let index = 0; index < packageCount; index++) {
      const source = path.join(temp, `source-${index}`); fs.mkdirSync(source, { mode: 0o700 });
      fs.mkdirSync(path.join(source, "skills", "summary"), { recursive: true, mode: 0o700 });
      const payloads = {
        "plugin.json": JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: `performance-fixture-${index}` }),
        "mcp.json": JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
          mcpServers: { fixture: { type: "stdio", command: "./server.cjs" } } }),
        "server.cjs": "#!/usr/bin/env node\nthrow Error('Performance fixture must never spawn');\n",
        "skills/summary/SKILL.md": "---\nname: summary\ndescription: Fixed benchmark fixture\n---\n" + "Summarize only this local fixture.\n".repeat(50),
      };
      for (const [relative, text] of Object.entries(payloads)) {
        fs.writeFileSync(path.join(source, relative), text, { mode: relative === "server.cjs" ? 0o700 : 0o600 });
        sourceBytes += Buffer.byteLength(text); sourceFiles++;
      }
      sources.push(source);
    }
    if (sources.length) await sample("parseAllPackages", () => {
      const parsed = sources.map(source => previewPluginDirectory(source));
      assert(parsed.every(value => value.installable)); return parsed.length;
    });
    for (let index = 0; index < sources.length; index++) {
      const preview = installer.preview(sources[index]);
      const start = performance.now();
      const receipt = installer.install({ sourcePath: sources[index], previewDigest: preview.contentDigest,
        operationId: `performance-install-${index}`, expectedRevision: 0 });
      installDurations.push(performance.now() - start);
      installed.push(store.setInstallationDesiredState({ installationId: receipt.installationId,
        expectedRevision: receipt.revision, desiredState: "enabled" }));
    }
    const packageCatalog = new PluginComponentCatalog({ store });
    const packageRows = packageCatalog.list();
    const toolRegistry = new PluginToolCatalogRegistry();
    const policy = new PermissionEngine({ toolRegistry: registry });
    dispatcher = new CapabilityDispatcher({ store, permissionEngine: policy,
      resolveToolContract: value => toolRegistry.resolve(value) });
    const connections = [], clients = new Map();
    let grantCount = 0, fixtureEgressCount = 0, acceptedTools = 0, rejectionCode = null;
    const perConnection = [];
    const discoveryStart = performance.now();
    for (let index = 0; index < installed.length; index++) {
      const installation = installed[index];
      const component = packageRows.find(row => row.installationId === installation.installationId).components.find(item => item.kind === "mcp-server");
      const pending = store.createConnection({ connectionId: `performance-connection-${index}`, installationId: installation.installationId,
        componentId: component.componentId, endpointIdentity: `fixture://performance-${index}` });
      const connection = store.setConnectionIdentity({ connectionId: pending.connectionId, principalIdentity: `fixture-principal-${index}`,
        state: "ready", expectedRevision: pending.revision });
      const created = store.createBinding({ bindingId: `performance-binding-${index}`, profileId: profile.id,
        installationId: installation.installationId, componentId: component.componentId, connectionId: connection.connectionId });
      const binding = store.setBindingEnabled({ bindingId: created.bindingId, enabled: true, expectedRevision: created.revision });
      const count = Math.floor(toolCount / packageCount) + (index < toolCount % packageCount ? 1 : 0);
      perConnection.push(count);
      const tools = fixtureTools(count);
      const client = { listTools: async () => tools, release: async () => {},
        callTool: async (name, args, authority) => {
          dispatcher.authorizeEgress({ connectionId: connection.connectionId, principalIdentity: connection.principalIdentity,
            toolName: name, arguments: args, authority });
          fixtureEgressCount++;
          return { content: [{ type: "text", text: "local fixture completed" }], structuredContent: { count: 1 } };
        } };
      clients.set(connection.connectionId, client);
      connections.push({ installation, connection, binding, client, tools });
      try {
        const catalog = await toolRegistry.refresh({ installation, connection, client });
        acceptedTools += catalog.entries.length;
        for (const [toolIndex, tool] of catalog.entries.entries()) {
          store.setGrant({ grantId: `performance-grant-${index}-${toolIndex}`, bindingId: binding.bindingId,
            toolIdentity: tool.toolIdentity, contractDigest: tool.contractDigest,
            effect: "allow", approvalMode: "always", expectedRevision: 0 }); grantCount++;
        }
      } catch (error) {
        assert.equal(error.code, "MCP_SERVER_RESPONSE_INVALID");
        assert(count > 256, "only the intentional per-Connection count excess may fail this fixture");
        rejectionCode = error.code;
      }
    }
    const grantAndDiscoverySetupMs = performance.now() - discoveryStart;
    const management = new PluginServiceController({ store, installer, catalog: packageCatalog,
      resolver: new PluginComponentResolver({ store }), productStore, toolCatalogRegistry: toolRegistry,
      drainInstallation: async () => {}, resumeInstallation: () => {} });
    const page = () => management.handle("plugins.capabilities.list", { cursor: 0, limit: 20, catalogRevision: null });
    sizes.packagePageBytes = await sample("servicePackageFirstPageAndSerialize", () => bytes(page()));
    const allPages = await sample("serviceAllPackagePagesAndSerialize", () => {
      let cursor = 0, catalogRevision = null, totalBytes = 0, pageCount = 0, maximumPageBytes = 0, itemCount = 0;
      do {
        const value = management.handle("plugins.capabilities.list", { cursor, limit: 20, catalogRevision });
        const size = bytes(value); totalBytes += size; maximumPageBytes = Math.max(maximumPageBytes, size);
        pageCount++; itemCount += value.items.length; cursor = value.nextCursor; catalogRevision = value.catalogRevision;
      } while (cursor !== null);
      assert.equal(itemCount, packageCount); assert(maximumPageBytes <= 48 * 1024);
      return { totalBytes, maximumPageBytes, pageCount };
    });
    sizes.packageCatalog = allPages;
    assert.throws(() => management.handle("plugins.capabilities.list", { cursor: 0, limit: 21, catalogRevision: null }), { code: "PLUGIN_REQUEST_INVALID" });
    boundaries.push({ path: "Service package page", inputCount: 21, maximum: 20, status: "rejected", code: "PLUGIN_REQUEST_INVALID" });
    if (connections.length) {
      await sample(rejectionCode ? "rejectedToolDiscovery" : "refreshAllToolCatalogs", async () => {
        for (const item of connections) {
          if (rejectionCode) await assert.rejects(toolRegistry.refresh(item), { code: rejectionCode });
          else await toolRegistry.refresh(item);
        }
      });
    }
    sizes.rawToolCatalogs = { totalBytes: connections.reduce((sum, item) => sum + bytes(item.tools), 0),
      maximumConnectionBytes: Math.max(0, ...connections.map(item => bytes(item.tools))) };
    const runs = new Map();
    runtime = new PluginRuntimeToolService({ store, productStore, getRun: id => runs.get(id),
      toolCatalogRegistry: toolRegistry, capabilityDispatcher: dispatcher, permissionEngine: policy,
      acquireConnection: async records => clients.get(records.connection.connectionId) });
    const runInput = id => ({ id, profileId: profile.id, status: "running", workspace: temp });
    await sample("captureRunAuthority", index => {
      const run = runInput(`capture-${index}`); runs.set(run.id, run);
      const value = runtime.captureRun(run); assert.equal(value.serverCount, rejectionCode ? 0 : packageCount);
      runtime.releaseRun(run.id); runs.delete(run.id); return value;
    });
    const run = runInput("steady-runtime-run"); runs.set(run.id, run); runtime.captureRun(run);
    const authority = { profileId: profile.id, callId: "list-only" }, scope = { runId: run.id, assertCurrent: () => {} };
    const servers = await sample("listRuntimeServersAndSerialize", () => {
      const value = runtime.listServers(authority, scope); bytes(value); return value;
    });
    sizes.runtimeServerListBytes = bytes(servers);
    if (acceptedTools > 0) {
      const toolPages = await sample("allRuntimeToolPagesAndSerialize", async () => {
        let totalBytes = 0, maximumPageBytes = 0, pageCount = 0, itemCount = 0;
        for (const server of servers) {
          let cursor = 0, hasMore;
          do {
            const value = await runtime.listTools({ serverId: server.id, cursor, limit: 20 }, authority, scope);
            const size = bytes(value); totalBytes += size; maximumPageBytes = Math.max(maximumPageBytes, size);
            itemCount += value.items.length; pageCount++; cursor = value.nextCursor; hasMore = value.hasMore;
          } while (hasMore);
        }
        assert.equal(itemCount, acceptedTools); assert(maximumPageBytes <= 48 * 1024);
        return { totalBytes, maximumPageBytes, pageCount, itemCount };
      });
      sizes.runtimeToolCatalog = toolPages;
      const selected = connections[0];
      const returned = await sample("authorizedFixtureDispatch", index => runtime.callTool({ serverId: pluginServerId(selected.binding.bindingId),
        toolName: selected.tools[0].name, arguments: { query: "fixed input", limit: 1 } },
      { profileId: profile.id, callId: `fixture-dispatch-${index}` }, scope));
      sizes.fixtureCallResultBytes = bytes(returned);
      assert.equal(fixtureEgressCount, repeats + 1);
    }
    await sample("captureAndReleaseProjection", index => {
      const temporaryRun = runInput(`release-${index}`); runs.set(temporaryRun.id, temporaryRun);
      runtime.captureRun(temporaryRun);
      runtime.releaseRun(temporaryRun.id); runs.delete(temporaryRun.id);
    });
    runtime.clear(); runs.clear();
    if (packageCount === 0) {
      for (let index = 0; index < 100; index++) runtime.captureRun(runInput(`capacity-${index}`));
      assert.throws(() => runtime.captureRun(runInput("capacity-overflow")), { code: "PLUGIN_RUNTIME_CAPACITY" });
      boundaries.push({ path: "Runtime frozen Run registry", inputCount: 101, maximum: 100,
        status: "rejected", code: "PLUGIN_RUNTIME_CAPACITY" }); runtime.clear();
    }
    const identity = { installationId: "boundary-package", componentId: "a".repeat(64), connectionId: "boundary-connection" };
    assert.equal(buildPluginToolCatalog({ ...identity, tools: fixtureTools(256) }).entries.length, 256);
    boundaries.push({ path: "tool contract count", inputCount: 256, maximum: 256, status: "accepted" });
    for (const count of [257, 1000]) {
      assert.throws(() => buildPluginToolCatalog({ ...identity, tools: fixtureTools(count) }), { code: "MCP_SERVER_RESPONSE_INVALID" });
      boundaries.push({ path: "tool contract count", inputCount: count, maximum: 256,
        status: "rejected", code: "MCP_SERVER_RESPONSE_INVALID" });
    }
    const large = fixtureTools(100).map(tool => ({ ...tool, description: "x".repeat(3000) }));
    assert.throws(() => buildPluginToolCatalog({ ...identity, tools: large }), { code: "MCP_SERVER_RESPONSE_INVALID" });
    boundaries.push({ path: "tool contract serialized bytes", inputBytes: bytes(large), maximumBytes: 256 * 1024,
      status: "rejected", code: "MCP_SERVER_RESPONSE_INVALID" });
    await installer.remoteGitFetcher.close(); dispatcher.clear(); store.close();
    await sample("existingStoreReopenAndClose", () => {
      const reopened = new PluginStore({ paths }).open();
      try { assert.equal(reopened.listInstallations().length, packageCount); } finally { reopened.close(); }
    });
    result = { packages: packageCount, requestedTools: toolCount, acceptedTools, perConnectionTools: perConnection,
      status: rejectionCode ? "catalog_rejected_by_capacity" : "accepted", rejectionCode,
      startup: { moduleLoadMs: rounded(moduleLoadMs), emptyStoreInitializeMs: rounded(emptyStoreInitializeMs) },
      setup: { sourceBytes, sourceFiles, installedPackages: installed.length, grantCount,
        installTotalMs: rounded(installDurations.reduce((a, b) => a + b, 0)),
        installPerPackage: installDurations.length ? distribution(installDurations) : null,
        grantAndDiscoverySetupMs: rounded(grantAndDiscoverySetupMs) },
      metrics, sizes, boundaries, fixtureEgressCount, spawnedPluginProcesses: 0, memoryMode,
      limitsVerified: true };
  } finally {
    runtime?.clear(); dispatcher?.clear(); await installer?.remoteGitFetcher.close(); store?.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
  memory();
  result.memory = { maxRssBytes: process.resourceUsage().maxRSS * 1024, sampledMaxRssBytes: sampledRssBytes,
    rssAtExitBytes: process.memoryUsage().rss, heapUsedAtExitBytes: process.memoryUsage().heapUsed,
    note: `Per-process high-water RSS includes module loading, setup and all samples; memory mode ${memoryMode}.` };
  result.temporaryRootRemoved = !fs.existsSync(temp);
  assert.equal(result.temporaryRootRemoved, true);
  return result;
}

function safeReportDirectory() {
  const target = path.join(repo, ".artifacts", "plugin-complete-0.8.146");
  let cursor = repo;
  for (const part of [".artifacts", "plugin-complete-0.8.146"]) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) fs.mkdirSync(cursor, { mode: 0o700 });
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
      throw Error("Unsafe performance output directory");
    }
  }
  return target;
}
function writeReport(directory, name, text) {
  const target = path.join(directory, name);
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, "unsafe existing performance report");
  }
  const temporary = path.join(directory, `.${name}.${crypto.randomUUID()}.tmp`);
  try { fs.writeFileSync(temporary, text, { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, target); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
async function main() {
  if (process.argv[2] === "--worker") {
    const [packages, tools, samples] = process.argv.slice(3, 6).map(Number);
    const memoryMode = process.argv[6] || "unforced";
    assert([0, 1, 10, 50].includes(packages) && [0, 100, 1000].includes(tools)
      && Number.isInteger(samples) && samples >= 5 && samples <= 101);
    assert(["unforced", "event-loop", "forced-gc"].includes(memoryMode));
    if (memoryMode === "forced-gc") assert.equal(typeof global.gc, "function", "use node --expose-gc for diagnostic");
    process.stdout.write(`${JSON.stringify(await worker(packages, tools, samples, memoryMode))}\n`); return;
  }
  if (process.argv.includes("--help")) {
    console.log("node scripts/plugin-performance-baseline.cjs [--samples=21]\nLocal in-memory MCP fixture only. Writes .artifacts/plugin-complete-0.8.146/performance.json and performance.md.\nSamples are warm/cache-affected; no real transport, OAuth, GUI or packaged-App performance claim."); return;
  }
  const argument = process.argv.slice(2);
  assert(argument.length <= 1 && argument.every(value => /^--samples=\d+$/u.test(value)), "unsupported benchmark option");
  const samples = argument.length ? Number(argument[0].slice(10)) : 21;
  assert(Number.isInteger(samples) && samples >= 5 && samples <= 101, "samples must be 5..101");
  const startedAt = new Date().toISOString(), started = performance.now();
  const scenarios = [[0, 0], ...[1, 10, 50].flatMap(count => [[count, 100], [count, 1000]])];
  const results = [];
  for (const [packages, tools] of scenarios) {
    const child = spawnSync(process.execPath, [__filename, "--worker", String(packages), String(tools), String(samples)],
      { encoding: "utf8", timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" } });
    assert.equal(child.status, 0, `performance scenario ${packages}/${tools} failed: ${child.stderr || child.error || child.stdout}`);
    const result = JSON.parse(child.stdout); results.push(result);
    process.stderr.write(`performance fixture ${packages} packages / ${tools} tools: ${result.status}\n`);
  }
  const sourceFiles = ["plugin-package-parser", "plugin-package-installer", "plugin-store", "plugin-component-catalog",
    "plugin-service-controller", "plugin-tool-contract", "plugin-tool-catalog-registry", "plugin-runtime-tool-service", "permission-engine", "capability-dispatcher"];
  const report = { version: 1, evidenceLevel: "local_fixture", startedAt, completedAt: new Date().toISOString(),
    elapsedMs: rounded(performance.now() - started), samplesPerMetric: samples,
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model || null,
      logicalCpuCount: os.cpus().length, totalMemoryBytes: os.totalmem(), loadAverageAtEnd: os.loadavg() },
    sourceDigests: Object.fromEntries(sourceFiles.map(name => [`app/agent-service/${name}.js`, hash(fs.readFileSync(path.join(repo, "app/agent-service", `${name}.js`)))])),
    methodology: { percentiles: "nearest rank over subsequent samples; the first invocation is reported separately",
      isolation: "one fresh Node process and temporary Product15 PluginStore per scenario",
      distribution: "total requested tools distributed evenly across one Connection per package",
      baseline: "empty Product15 plugin domain, not complete App startup",
      operations: "production parser/install/store/catalog/controller/runtime/policy/dispatcher; mock profile and in-memory MCP peer",
      exclusions: ["real transport or process startup", "real OAuth or account", "real provider side effects", "GUI", "packaged or installed App", "cold filesystem cache guarantee", "long-running leak proof", "hard realtime latency guarantee"],
      rss: "process.resourceUsage().maxRSS is recorded in KiB and converted to bytes; includes all setup and samples" }, results,
    allTemporaryRootsRemoved: results.every(value => value.temporaryRootRemoved) };
  const directory = safeReportDirectory();
  writeReport(directory, "performance.json", `${JSON.stringify(report, null, 2)}\n`);
  const table = results.map(item => `| ${item.packages} | ${item.requestedTools} | ${item.acceptedTools} | ${item.status} | ${item.metrics.captureRunAuthority.p50Ms}/${item.metrics.captureRunAuthority.p95Ms} | ${item.metrics.allRuntimeToolPagesAndSerialize ? `${item.metrics.allRuntimeToolPagesAndSerialize.p50Ms}/${item.metrics.allRuntimeToolPagesAndSerialize.p95Ms}` : "n/a"} | ${item.metrics.authorizedFixtureDispatch ? `${item.metrics.authorizedFixtureDispatch.p50Ms}/${item.metrics.authorizedFixtureDispatch.p95Ms}` : "n/a"} | ${rounded(item.memory.maxRssBytes / 1024 / 1024)} |`).join("\n");
  writeReport(directory, "performance.md", `# Plugin local performance baseline\n\nRun: \`node scripts/plugin-performance-baseline.cjs --samples=${samples}\`\n\nEach row has its own process and disposable Product15 directory. Timings are milliseconds; p50/p95 use nearest rank across ${samples} subsequent samples. The JSON retains every sample and the first invocation separately. Tools are distributed evenly across package Connections.\n\n| Packages | Requested tools | Accepted | Result | Capture p50/p95 | All tool pages p50/p95 | Local dispatch p50/p95 | Peak RSS MiB |\n|---|---|---|---|---|---|---|---|\n${table}\n\nThis measures production parser, installer, SQLite store, Service directory projection, Runtime capture, PermissionEngine and Dispatcher against an in-memory MCP peer. The empty baseline is the plugin domain in Product15, not whole-App startup. Source hashes, machine details, page sizes, schema boundaries and cleanup evidence are in performance.json.\n\nNo network, plugin child process, actual OAuth, real provider, GUI or packaged/installed App was exercised. OS caches are not flushed, GC is not forced, and other machine workloads can affect these distributions. Peak RSS includes setup and all samples; it is not steady-state memory per tool. These are a reproducible local baseline, not hard latency guarantees or a long-running memory-leak acceptance.\n`);
  console.log(JSON.stringify({ report: path.join(directory, "performance.json"), guide: path.join(directory, "performance.md"),
    scenarios: results.length, samples, allTemporaryRootsRemoved: report.allTemporaryRootsRemoved }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
