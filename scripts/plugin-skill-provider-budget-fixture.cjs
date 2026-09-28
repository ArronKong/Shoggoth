#!/usr/bin/env node
"use strict";

// Measure the actual request body received by the isolated OpenClaw/Hermes
// fake provider. One Skill is installed through the real Service fixture;
// the remaining descriptors are synthetic and are visible only in this test
// process. This is a context-size probe, not a 5,000-package install test or
// a real-provider token measurement.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const HOSTS = ["openclaw", "hermes"];
const COUNTS = [50, 500, 5_000];
const TARGET = "shoggoth-host-probe-skill";
const SYNTHETIC_PREFIX = "a-scale-";
const FIXTURES = {
  openclaw: "plugin-openclaw-real-host-run-fixture.cjs",
  hermes: "plugin-hermes-real-host-run-fixture.cjs",
};

function bytes(value) { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
function record(event) {
  fs.appendFileSync(process.env.SHOGGOTH_BUDGET_EVENTS, `${JSON.stringify(event)}\n`);
}

function installInstrumentation(host, count) {
  const fixtureModule = require("./plugin-real-host-service-fixture.cjs");
  const originalFactory = fixtureModule.createFixture;
  fixtureModule.createFixture = (root, backendId) => {
    const fixture = originalFactory(root, backendId);
    let service = null;
    let installed = false;
    const originalStart = fixture.start.bind(fixture);
    const originalRestart = fixture.restart.bind(fixture);
    const originalInstall = fixture.install.bind(fixture);
    const attach = current => {
      service = current;
      const store = current.nativeSkillStore;
      const originalList = store.listGlobalEnabled.bind(store);
      store.listGlobalEnabled = () => {
        const actual = originalList();
        if (!installed) return actual;
        const synthetic = Array.from({ length: count - 2 }, (_, index) => {
          const name = `${SYNTHETIC_PREFIX}${String(index).padStart(5, "0")}`;
          return { id: name, name, version: "1.0.0",
            description: "Synthetic context budget fixture", contentHash: "a".repeat(64),
            registryRevision: store.revision, requiredTools: [],
            requiredRuntimeCapabilities: [] };
        });
        return [...synthetic, ...actual];
      };
      const tools = current.externalPluginToolService;
      const originalSearch = tools.search.bind(tools);
      const originalRead = tools.readSkill.bind(tools);
      tools.search = async params => {
        const result = await originalSearch(params);
        if (params.query === TARGET) record({ type: "tail-search", host, count,
          total: result.total, found: result.items.some(item => item.name === TARGET),
          responseBytes: bytes(result), nativeCatalogSize: store.listGlobalEnabled().length,
          targetIsLastNative: store.listGlobalEnabled().at(-1)?.name === TARGET });
        return result;
      };
      tools.readSkill = async params => {
        const result = await originalRead(params);
        if (result.name === TARGET) record({ type: "tail-read", host, count,
          contentBytes: Buffer.byteLength(result.content, "utf8"),
          hasFixtureText: result.content.includes("Host probe") });
        return result;
      };
      return current;
    };
    fixture.start = async () => attach(await originalStart());
    fixture.restart = async () => attach(await originalRestart());
    fixture.install = () => {
      const result = originalInstall();
      installed = true;
      const items = service.nativeSkillStore.listGlobalEnabled();
      assert.equal(items.length, count - 1,
        "native projection plus one plugin Skill must equal requested scale");
      assert.equal(items.at(-1).name, TARGET);
      record({ type: "projection", host, count, nativeCatalogSize: items.length,
        syntheticCount: count - 2, realInstalledCount: 1 });
      return result;
    };
    return fixture;
  };

  const originalParse = JSON.parse;
  JSON.parse = function budgetParse(text, reviver) {
    const value = originalParse(text, reviver);
    if (value && typeof value === "object" && value.model === "shoggoth-host-probe"
      && Array.isArray(value.messages)) {
      const messages = JSON.stringify(value.messages);
      const tools = value.tools || [];
      const toolRows = Array.isArray(tools) ? tools : [];
      const shoggothTools = toolRows.filter(item =>
        /^shoggoth_/u.test(item?.function?.name || item?.name || ""));
      record({ type: "provider-request", host, count,
        messagesBytes: Buffer.byteLength(messages, "utf8"),
        toolsBytes: bytes(tools), shoggothToolsBytes: bytes(shoggothTools),
        toolCount: toolRows.length,
        priorToolMessages: value.messages.filter(item => item.role === "tool").length,
        syntheticNameVisible: messages.includes(SYNTHETIC_PREFIX)
          || JSON.stringify(tools).includes(SYNTHETIC_PREFIX),
        targetNameVisible: messages.includes(TARGET),
      });
    }
    return value;
  };
}

function runChild(host, count, eventFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, "--child", host, String(count)], {
      cwd: __dirname, env: { ...process.env, SHOGGOTH_BUDGET_EVENTS: eventFile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${host}/${count} exited ${code}: ${stderr.slice(-3500)}\n${stdout.slice(-1800)}`));
      } else resolve();
    });
  });
}

function summarize(host, count, events) {
  const requests = events.filter(item => item.type === "provider-request");
  const first = requests.filter(item => item.priorToolMessages === 0);
  const searches = events.filter(item => item.type === "tail-search");
  const activeSearches = searches.filter(item => item.found);
  const reads = events.filter(item => item.type === "tail-read");
  const projection = events.find(item => item.type === "projection");
  assert(projection && requests.length >= 4 && first.length >= 4,
    `${host}/${count}: provider boundary was not reached`);
  assert(activeSearches.length >= 4 && reads.length >= 4,
    `${host}/${count}: target search/read did not traverse the host`);
  assert(activeSearches.every(item => item.total === 1
    && item.targetIsLastNative && item.nativeCatalogSize === count - 1
    && item.responseBytes < 8 * 1024),
  `${host}/${count}: tail search was unbounded or missing: ${JSON.stringify(searches)}`);
  assert(reads.every(item => item.hasFixtureText), `${host}/${count}: tail Skill read missing`);
  assert(requests.every(item => !item.syntheticNameVisible),
    `${host}/${count}: synthetic catalog leaked into provider input`);
  return { host, skills: count, syntheticDescriptors: count - 2,
    actualInstalledSkills: 1, providerRequests: requests.length,
    firstPromptMessagesBytes: first[0].messagesBytes,
    firstPromptToolsBytes: first[0].toolsBytes,
    firstPromptShoggothToolsBytes: first[0].shoggothToolsBytes,
    firstPromptToolCount: first[0].toolCount,
    tailSearchMaxBytes: Math.max(...activeSearches.map(item => item.responseBytes)),
    tailSearches: activeSearches.length, tailReads: reads.length };
}

function measureNativeCompiler() {
  const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");
  let enabledCount = 50;
  const inventory = Array.from({ length: 5_000 }, (_, index) => ({
    id: `${SYNTHETIC_PREFIX}${String(index).padStart(5, "0")}`,
    name: `${SYNTHETIC_PREFIX}${String(index).padStart(5, "0")}`,
    version: "1.0.0", description: "Synthetic context budget fixture",
    source: "plugin", contentHash: "a".repeat(64),
  }));
  const fixture = contextFixture({ skillStore: {
    catalog() { return { registryRevision: "b".repeat(64), profileRevision: 1,
      items: inventory.slice(0, enabledCount), ineligible: [] }; },
    select() { return { registryRevision: "b".repeat(64), profileRevision: 1,
      items: inventory.slice(0, enabledCount), ineligible: [], selected: [] }; },
    read() { throw new Error("Unselected Skill was read by ContextCompiler"); },
  } });
  try {
    const results = COUNTS.map(count => {
      enabledCount = count;
      const compiled = fixture.compiler.compile({ profile: fixture.profile,
        run: fixture.run, transcriptSessionId: fixture.transcriptSessionId,
        query: "Unrelated context budget task" });
      const catalog = compiled.blocks.find(item => item.id === "skill-catalog")?.content;
      assert.equal(typeof catalog, "string");
      assert(!compiled.dynamicContext.includes(inventory.at(-1).name));
      return { skills: count,
        developerInstructionsBytes: Buffer.byteLength(compiled.developerInstructions, "utf8"),
        dynamicContextBytes: Buffer.byteLength(compiled.dynamicContext, "utf8"),
        skillCatalogBytes: Buffer.byteLength(catalog, "utf8"),
        skillCatalogText: catalog };
    });
    assert.equal(new Set(results.map(item => item.skillCatalogText)).size, 1);
    assert.equal(new Set(results.map(item => item.developerInstructionsBytes)).size, 1);
    assert.equal(new Set(results.map(item => item.dynamicContextBytes)).size, 1);
    return results.map(({ skillCatalogText, ...row }) => row);
  } finally { fixture.cleanup(); }
}

async function main() {
  if (process.argv[2] === "--child") {
    const host = process.argv[3];
    const count = Number(process.argv[4]);
    assert(HOSTS.includes(host) && COUNTS.includes(count));
    installInstrumentation(host, count);
    require(path.join(__dirname, FIXTURES[host]));
    return;
  }
  if (process.argv[2] === "--native") {
    console.log("plugin-skill-provider-budget-fixture native:",
      JSON.stringify(measureNativeCompiler()));
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-skill-budget-"));
  const results = [];
  try {
    for (const host of HOSTS) for (const count of COUNTS) {
      const eventsFile = path.join(root, `${host}-${count}-${crypto.randomUUID()}.jsonl`);
      await runChild(host, count, eventsFile);
      const events = fs.readFileSync(eventsFile, "utf8").trim().split("\n").map(JSON.parse);
      const row = summarize(host, count, events);
      results.push(row);
      console.log(`PASS ${host}/${count}: messages=${row.firstPromptMessagesBytes}B, tools=${row.firstPromptToolsBytes}B, tail=${row.tailSearchMaxBytes}B`);
    }
    for (const host of HOSTS) {
      const rows = results.filter(item => item.host === host);
      assert.equal(new Set(rows.map(item => item.firstPromptToolsBytes)).size, 1,
        `${host}: provider tool schemas grew with Skill count`);
      assert.equal(new Set(rows.map(item => item.firstPromptShoggothToolsBytes)).size, 1,
        `${host}: Shoggoth tool schemas grew with Skill count`);
      assert(Math.max(...rows.map(item => item.firstPromptMessagesBytes))
        - Math.min(...rows.map(item => item.firstPromptMessagesBytes)) <= 512,
      `${host}: first provider messages grew with Skill count`);
    }
    console.log("plugin-skill-provider-budget-fixture: ok", JSON.stringify({
      measurement: "UTF-8 bytes of parsed fake-provider request messages/tools",
      provider: "local fake OpenAI-compatible model, not a live account",
      scale: "one persisted Skill, N-2 synthetic global descriptors, one plugin Skill",
      results, nativeCompiler: measureNativeCompiler(),
    }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
