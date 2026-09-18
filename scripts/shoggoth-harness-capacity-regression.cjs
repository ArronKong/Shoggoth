#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const ROOT = path.resolve(__dirname, "..");
const { MAX_CHAT_SESSIONS } = require(path.join(ROOT, "app", "agent-service", "chat-session-store.js"));
const { MemoryEngine } = require(path.join(ROOT, "app", "agent-service", "memory-engine.js"));
const { MemoryStore } = require(path.join(ROOT, "app", "agent-service", "memory-store.js"));
const { resolveServicePaths } = require(path.join(ROOT, "app", "agent-service", "paths.js"));
const { ToolRegistry } = require(path.join(ROOT, "app", "agent-service", "tool-registry.js"));
const { TranscriptStore } = require(path.join(ROOT, "app", "agent-service", "transcript-store.js"));
const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");

const MEMORY_COUNT = 10_000;
const TRANSCRIPT_SESSION_COUNT = 5_000;
const TRANSCRIPT_EVENT_COUNT = 20_000;
const MEMORY_WRITE_BUDGET_MS = Number(process.env.SHOGGOTH_MEMORY_CAPACITY_BUDGET_MS || 120_000);
const TRANSCRIPT_WRITE_BUDGET_MS = Number(process.env.SHOGGOTH_TRANSCRIPT_CAPACITY_BUDGET_MS || 180_000);
const TRANSCRIPT_EVENT_WRITE_BUDGET_MS = Number(process.env.SHOGGOTH_TRANSCRIPT_EVENT_BUDGET_MS || 420_000);
const READ_BUDGET_MS = Number(process.env.SHOGGOTH_CAPACITY_READ_BUDGET_MS || 10_000);
const RSS_GROWTH_BUDGET_BYTES = 512 * 1024 * 1024;

function fixturePaths(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(root, 0o700);
  return {
    root,
    paths: resolveServicePaths({
      trustedRoot: root,
      stateRoot: path.join(root, "state"),
      profileRoot: path.join(root, "profile"),
      cacheRoot: path.join(root, "cache"),
    }),
  };
}

function elapsed(action) {
  const started = performance.now();
  const value = action();
  return { value, milliseconds: performance.now() - started };
}

function mode(target) {
  return fs.statSync(target).mode & 0o777;
}

function memoryItem(index) {
  return {
    id: `memory-${String(index).padStart(5, "0")}`,
    profileId: "capacity-profile",
    scope: index % 2 === 0 ? "user" : "agent",
    type: "semantic",
    content: `capacity topic-${index} preference value-${index}`,
    sourceRefs: [`source-${index}`],
    confidence: 1,
    sensitivity: "normal",
    status: "active",
    validFrom: 1_000 + index,
    validUntil: null,
    supersedes: null,
    createdAt: 1_000 + index,
    updatedAt: 1_000 + index,
  };
}

function testMemoryCapacity() {
  const { root, paths } = fixturePaths("shoggoth-memory-capacity-");
  const rssBefore = process.memoryUsage().rss;
  let store = new MemoryStore({ paths });
  try {
    store.open();
    const written = elapsed(() => {
      for (let offset = 0; offset < MEMORY_COUNT; offset += 128) {
        const length = Math.min(128, MEMORY_COUNT - offset);
        store.upsertMany(Array.from({ length }, (_, index) => memoryItem(offset + index)));
      }
    });
    assert.equal(store.list("capacity-profile").length, MEMORY_COUNT);
    assert.equal(store.getRevision("capacity-profile"), Math.ceil(MEMORY_COUNT / 128));
    assert.ok(written.milliseconds <= MEMORY_WRITE_BUDGET_MS,
      `10k Memory write ${written.milliseconds.toFixed(0)}ms exceeded ${MEMORY_WRITE_BUDGET_MS}ms`);
    const memoryDir = path.join(paths.agentsDir, "capacity-profile", "memory");
    assert.equal(mode(memoryDir), 0o700);
    assert.equal(mode(path.join(memoryDir, "events.jsonl")), 0o600);
    assert.equal(mode(path.join(memoryDir, "snapshot.json")), 0o600);

    store.close();
    store = new MemoryStore({ paths });
    store.open();
    const engine = new MemoryEngine({ store, now: () => 20_000 });
    engine.open(["capacity-profile"]);
    const read = elapsed(() => engine.search({
      profileId: "capacity-profile", query: "topic-9999", limit: 24, maxBytes: 12 * 1024,
    }));
    assert.equal(read.value.items[0]?.id, "memory-09999");
    assert.ok(read.milliseconds <= READ_BUDGET_MS,
      `10k Memory search ${read.milliseconds.toFixed(0)}ms exceeded ${READ_BUDGET_MS}ms`);
    engine.close();

    const outside = path.join(root, "outside-memory");
    fs.mkdirSync(outside, { mode: 0o700 });
    fs.symlinkSync(outside, path.join(paths.agentsDir, "escape-profile"));
    assert.throws(() => store.list("escape-profile"), (error) => error.code === "UNSAFE_SYMLINK");
    assert.ok(process.memoryUsage().rss - rssBefore <= RSS_GROWTH_BUDGET_BYTES,
      "10k Memory RSS growth exceeded 512 MiB");
    console.log(`PASS 10k Memory persistence/search/perms/symlink (${written.milliseconds.toFixed(0)}ms write, ${read.milliseconds.toFixed(0)}ms search)`);
  } finally {
    try { store.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function appendTranscriptSession(store, index) {
  const suffix = String(index).padStart(5, "0");
  return store.appendEvent({
    profileId: "capacity-profile",
    sessionId: `session-${suffix}`,
    id: `event-${suffix}`,
    runId: `run-${suffix}`,
    kind: "user",
    content: { text: `capacity transcript ${suffix}` },
    runtimeRef: null,
    contextExcluded: false,
    occurredAt: 1_000 + index,
  });
}

function testTranscriptCapacity() {
  assert.ok(MAX_CHAT_SESSIONS >= TRANSCRIPT_SESSION_COUNT,
    `ChatSession cap ${MAX_CHAT_SESSIONS} cannot represent 5k Transcript sessions`);
  const { root, paths } = fixturePaths("shoggoth-transcript-capacity-");
  const rssBefore = process.memoryUsage().rss;
  let store = new TranscriptStore({ paths, assertSecretSafe: () => true });
  try {
    store.open();
    const written = elapsed(() => {
      for (let index = 0; index < TRANSCRIPT_SESSION_COUNT; index += 1) {
        appendTranscriptSession(store, index);
      }
    });
    assert.ok(written.milliseconds <= TRANSCRIPT_WRITE_BUDGET_MS,
      `5k Transcript write ${written.milliseconds.toFixed(0)}ms exceeded ${TRANSCRIPT_WRITE_BUDGET_MS}ms`);
    const transcriptRoot = path.join(paths.agentsDir, "capacity-profile", "transcripts");
    assert.equal(fs.readdirSync(transcriptRoot).length, TRANSCRIPT_SESSION_COUNT);
    assert.equal(mode(transcriptRoot), 0o700);
    assert.equal(mode(path.join(transcriptRoot, "session-00000", "events.jsonl")), 0o600);
    assert.equal(mode(path.join(transcriptRoot, "session-00000", "manifest.json")), 0o600);

    store.close();
    store = new TranscriptStore({ paths, assertSecretSafe: () => true });
    store.open();
    const read = elapsed(() => [0, 2_499, 4_999].map((index) => {
      const suffix = String(index).padStart(5, "0");
      return store.listEvents("capacity-profile", `session-${suffix}`);
    }));
    assert.deepEqual(read.value.map((events) => events.length), [1, 1, 1]);
    assert.ok(read.milliseconds <= READ_BUDGET_MS,
      `5k Transcript sampled reopen ${read.milliseconds.toFixed(0)}ms exceeded ${READ_BUDGET_MS}ms`);
    assert.ok(process.memoryUsage().rss - rssBefore <= RSS_GROWTH_BUDGET_BYTES,
      "5k Transcript RSS growth exceeded 512 MiB");
    const outside = path.join(root, "outside-transcript");
    fs.mkdirSync(outside, { mode: 0o700 });
    fs.symlinkSync(outside, path.join(paths.agentsDir, "escape-transcript"));
    assert.throws(
      () => store.listEvents("escape-transcript", "session-00000"),
      (error) => error.code === "UNSAFE_SYMLINK",
    );
    console.log(`PASS 5k-session Transcript persistence/reopen/perms (${written.milliseconds.toFixed(0)}ms write, ${read.milliseconds.toFixed(0)}ms sample)`);
  } finally {
    try { store.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testLongTranscriptCapacity() {
  const { root, paths } = fixturePaths("shoggoth-transcript-events-capacity-");
  const rssBefore = process.memoryUsage().rss;
  const profileId = "capacity-profile";
  const sessionId = "long-session";
  let store = new TranscriptStore({ paths, assertSecretSafe: () => true });
  try {
    store.open();
    const written = elapsed(() => {
      for (let index = 0; index < TRANSCRIPT_EVENT_COUNT; index += 1) {
        store.appendEvent({
          profileId,
          sessionId,
          id: `long-event-${String(index).padStart(5, "0")}`,
          runId: `long-run-${String(Math.floor(index / 2)).padStart(5, "0")}`,
          kind: index % 2 === 0 ? "user" : "assistant",
          content: { text: `bounded long transcript ${index}` },
          runtimeRef: null,
          contextExcluded: false,
          occurredAt: 1_000 + index,
        });
      }
    });
    assert.equal(store.getRevision(profileId, sessionId), TRANSCRIPT_EVENT_COUNT);
    assert.ok(written.milliseconds <= TRANSCRIPT_EVENT_WRITE_BUDGET_MS,
      `20k Transcript event write ${written.milliseconds.toFixed(0)}ms exceeded ${TRANSCRIPT_EVENT_WRITE_BUDGET_MS}ms`);
    store.close();

    store = new TranscriptStore({ paths, assertSecretSafe: () => true });
    store.open();
    const read = elapsed(() => store.listEvents(profileId, sessionId));
    assert.equal(read.value.length, TRANSCRIPT_EVENT_COUNT);
    assert.equal(read.value[0]?.id, "long-event-00000");
    assert.equal(read.value.at(-1)?.id, "long-event-19999");
    assert.ok(read.milliseconds <= READ_BUDGET_MS,
      `20k Transcript event reopen ${read.milliseconds.toFixed(0)}ms exceeded ${READ_BUDGET_MS}ms`);
    assert.ok(process.memoryUsage().rss - rssBefore <= RSS_GROWTH_BUDGET_BYTES,
      "20k Transcript event RSS growth exceeded 512 MiB");
    console.log(`PASS 20k-event Transcript persistence/reopen (${written.milliseconds.toFixed(0)}ms write, ${(written.milliseconds / TRANSCRIPT_EVENT_COUNT).toFixed(1)}ms/event, ${read.milliseconds.toFixed(0)}ms read)`);
  } finally {
    try { store.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testLongDefinitionContext() {
  const fixture = contextFixture();
  try {
    const current = fixture.definitions.get("profile-1");
    fixture.definitions.update({
      profileId: "profile-1",
      expectedRevision: current.manifest.revision,
      actor: "user",
      reason: "capacity-long-definition",
      documents: {
        SOUL: `# Soul\n\n${"保持冷静、准确。".repeat(1_200)}`,
        AGENTS: `# Operating Rules\n\n${"遵守权限边界。".repeat(1_300)}`,
      },
    });
    const compiled = elapsed(() => fixture.compiler.compile({
      profile: fixture.profile,
      run: { ...fixture.run, source: "kanban", sourceId: "capacity-card" },
      query: "",
    }));
    const soul = compiled.value.blocks.find((item) => item.kind === "soul");
    const rules = compiled.value.blocks.find((item) => item.kind === "rules");
    assert.equal(soul.truncated, true);
    assert.ok(soul.byteLength <= 12 * 1024);
    assert.ok(rules.byteLength <= 32 * 1024);
    assert.ok(compiled.value.report.totalBytes <= 96 * 1024);
    assert.ok(compiled.milliseconds <= READ_BUDGET_MS);
    const outside = path.join(fixture.root, "outside-definition");
    fs.mkdirSync(outside, { mode: 0o700 });
    fs.symlinkSync(outside, path.join(fixture.paths.agentsDir, "escape-definition"));
    assert.throws(
      () => fixture.definitions.ensureProfile({ profileId: "escape-definition" }),
      (error) => error.code === "UNSAFE_SYMLINK",
    );
    console.log(`PASS long SOUL/AGENTS bounded context (${compiled.value.report.totalBytes} bytes, ${compiled.milliseconds.toFixed(0)}ms)`);
  } finally {
    fixture.cleanup();
  }
}

function registryInput(registry, generation) {
  const tools = registry.list();
  return {
    capabilities: tools.map(({ definition, enabled, ...capability }) => capability),
    definitions: tools.map((tool) => ({
      ...tool.definition,
      description: `${tool.definition.description.replace(/ \[delta-\d+\]$/u, "")} [delta-${generation}]`,
    })),
    domainNotes: registry.state.domainNotes,
    lifecycle: registry.state.lifecycle,
  };
}

function testToolDelta() {
  const fixture = contextFixture();
  try {
    const original = fixture.compiler.toolRegistry;
    const registry = new ToolRegistry(registryInput(original, 0));
    const rssBefore = process.memoryUsage().rss;
    const replaced = elapsed(() => {
      for (let generation = 1; generation <= 2_000; generation += 1) {
        registry.replace(registryInput(registry, generation));
      }
    });
    assert.match(registry.revision, /^[a-f0-9]{64}$/u);
    assert.equal(
      registry.mcpDefinitions().length,
      registry.list().filter((tool) => tool.modelVisible !== false).length,
    );
    assert.ok(replaced.milliseconds <= READ_BUDGET_MS * 3,
      `2k tool delta ${replaced.milliseconds.toFixed(0)}ms exceeded ${READ_BUDGET_MS * 3}ms`);
    assert.ok(process.memoryUsage().rss - rssBefore <= RSS_GROWTH_BUDGET_BYTES,
      "high-frequency tool delta RSS growth exceeded 512 MiB");
    console.log(`PASS 2k Tool Registry delta bounded (${replaced.milliseconds.toFixed(0)}ms)`);
  } finally {
    fixture.cleanup();
  }
}

testMemoryCapacity();
testTranscriptCapacity();
testLongTranscriptCapacity();
testLongDefinitionContext();
testToolDelta();
console.log("PASS shoggoth harness capacity regression (5)");
