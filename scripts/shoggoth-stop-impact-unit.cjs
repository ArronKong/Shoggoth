#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createStopImpact, validStopImpact, MAX_STOP_IMPACT_RUNS } = require("../app/agent-service/stop-impact");
const { createProductHostController } = require("../app/product-host-controller");
const { createAgentService, PROTOCOL_VERSION } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { requestService, readClientToken } = require("../app/agent-service/client");

const run = (id, status, source = "chat") => ({ id, profileId: "grok-profile", source,
  sourceId: `source-${id}`, status, waitingRequestId: null, runtimeTurnRef: null });
const snapshot = (runs, instanceNonce = "instance-one") => createStopImpact({ runs, instanceNonce,
  profileFor: () => ({ name: "Grok" }), titleFor: value => `Task ${value.id}` });

test("impact includes every active state and source, excluding queues and terminal runs", () => {
  const runs = [run("chat", "running"), run("idea", "waiting_approval", "inspiration"),
    run("cron", "starting", "cron"), run("board", "waiting_input", "kanban"),
    ...["queued", "completed", "failed", "canceled", "interrupted", "skipped"].map(state => run(state, state))];
  const result = snapshot(runs);
  assert.equal(result.totalCount, 4);
  assert.deepEqual(result.runs.map(item => item.runId), ["board", "chat", "cron", "idea"]);
  assert.equal(validStopImpact(result), true);
  assert.ok(result.runs.every(item => item.agentName === "Grok" && item.title.startsWith("Task ")));
  assert.equal(snapshot([...runs].reverse()).revision, result.revision);
});

test("revision tracks new tasks, approval replacement and service restart, not streamed text", () => {
  const original = run("one", "waiting_approval");
  original.waitingRequestId = "approval-one";
  const initial = snapshot([original]);
  assert.notEqual(snapshot([{ ...original, waitingRequestId: "approval-two" }]).revision, initial.revision);
  assert.notEqual(snapshot([{ ...original, status: "running" }]).revision, initial.revision);
  assert.notEqual(snapshot([original, run("two", "running")]).revision, initial.revision);
  assert.notEqual(snapshot([original], "restarted").revision, initial.revision);
  assert.equal(snapshot([{ ...original, eventSeq: 500, resultSummary: "more text" }]).revision, initial.revision);
});

test("missing titles never hide tasks and oversized lists retain a complete count and revision", () => {
  const runs = Array.from({ length: 70 }, (_, i) => run(`run-${String(i).padStart(3, "0")}`, "running"));
  const result = createStopImpact({ runs, instanceNonce: "same", profileFor: () => { throw Error("missing"); },
    titleFor: () => "名".repeat(5_000) });
  assert.equal(result.totalCount, 70);
  assert.equal(result.runs.length, MAX_STOP_IMPACT_RUNS);
  assert.equal(validStopImpact(result), true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 64 * 1024);
  assert.ok(result.runs.every(item => item.agentName === null && Buffer.byteLength(item.title) <= 256));
  assert.notEqual(createStopImpact({ runs: runs.slice(0, -1), instanceNonce: "same",
    profileFor: () => null, titleFor: () => null }).revision, result.revision);
  assert.equal(validStopImpact({ ...result, runs: [] }), false);
});

function hostFixture() {
  const value = { runs: [], unavailable: false, stops: 0, loaded: true, nonce: "instance" };
  value.host = createProductHostController({
    serviceRequest: async method => {
      if (method === "service.stopImpact") {
        if (value.unavailable) throw Error("unavailable private detail");
        return snapshot(value.runs, value.nonce);
      }
      if (method === "service.status") return { healthy: true, protocolVersion: PROTOCOL_VERSION,
        serviceVersion: "test", startedAt: 1, domainAvailability: { kanban: true, cron: true } };
      throw Error(`Unexpected ${method}`);
    },
    launchAgent: {
      async stop() { value.stops += 1; value.loaded = false; },
      async status() { return { supported: true, installed: true, enabled: value.loaded,
        loaded: value.loaded, needsRepair: false }; },
    },
  });
  return value;
}

test("stop requires the reviewed snapshot; a newly started task requires reconfirmation", async () => {
  const value = hostFixture();
  await assert.rejects(value.host.stopBackground({}), { code: "SHOGGOTH_STOP_CONFIRMATION_REQUIRED" });
  const first = await value.host.getBackgroundStopImpact();
  value.runs.push(run("new", "running", "inspiration"));
  await assert.rejects(value.host.stopBackground({ revision: first.revision }), { code: "SHOGGOTH_STOP_IMPACT_CHANGED" });
  assert.equal(value.stops, 0);
  const reviewed = await value.host.getBackgroundStopImpact();
  const result = await value.host.stopBackground({ revision: reviewed.revision });
  assert.equal(value.stops, 1);
  assert.equal(result.background.loaded, false);
});

test("unknown impact is explicit, can be confirmed, and cannot bypass a recovered Service", async () => {
  const value = hostFixture();
  value.unavailable = true;
  const unknown = await value.host.getBackgroundStopImpact();
  assert.deepEqual(unknown, { availability: "unavailable", revision: "unavailable", totalCount: null, runs: [] });
  value.unavailable = false;
  value.runs = [run("waiting", "waiting_input")];
  await assert.rejects(value.host.stopBackground({ revision: unknown.revision }), { code: "SHOGGOTH_STOP_IMPACT_CHANGED" });
  assert.equal(value.stops, 0);
  value.unavailable = true;
  await value.host.stopBackground({ revision: unknown.revision });
  assert.equal(value.stops, 1);
});

test("a newer background intent supersedes an in-flight stop impact check", async () => {
  const value = hostFixture();
  const initial = await value.host.getBackgroundStopImpact();
  let release;
  value.host.getBackgroundStopImpact = () => new Promise(resolve => { release = resolve; });
  const first = value.host.stopBackground({ revision: initial.revision });
  // Existing internal lifecycle entry advances the same intent generation.
  await value.host.runBackgroundAction("stop");
  release(initial);
  await assert.rejects(first, { code: "SHOGGOTH_STOP_IMPACT_CHANGED" });
  assert.equal(value.stops, 1);
});

test("real private Service endpoint is read-only, validates params and changes generation on restart", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-stop-impact-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const service = createAgentService({ paths, version: "stop-impact-test" });
  t.after(async () => { await service.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await service.start();
  const request = (params = {}) => requestService(paths, { method: "service.stopImpact", params,
    token: readClientToken(paths), version: PROTOCOL_VERSION });
  const empty = await request();
  assert.equal(validStopImpact(empty), true);
  assert.equal(empty.totalCount, 0);
  await assert.rejects(request({ inject: true }), { code: "INVALID_PARAMS" });
  const previous = service.workRunCoordinator.listRuns;
  service.workRunCoordinator.listRuns = () => [run("active", "waiting_approval", "inspiration"), run("queued", "queued")];
  try {
    const active = await request();
    assert.equal(active.totalCount, 1);
    assert.equal(active.runs[0].runId, "active");
    assert.equal(validStopImpact(active), true);
  } finally { service.workRunCoordinator.listRuns = previous; }
  await service.stop();
  await service.start();
  assert.notEqual((await request()).revision, empty.revision);
});
