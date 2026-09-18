"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { InspirationStore } = require("../app/agent-service/inspiration-store");
const { InspirationService, inspirationPrompt } = require("../app/agent-service/inspiration-service");
const { ExternalInspirationExecutor } = require("../app/agent-service/external-inspiration-executor");
const { resolveServicePaths } = require("../app/agent-service/paths");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "insp-review-"));
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  const store = new InspirationStore({ paths }).open();
  const hostId = crypto.randomUUID();
  const observations = new Map(), sequences = new Map(), cancellations = new Map();
  const calls = [];
  const client = { async request(method, input) {
    calls.push({ method, input: structuredClone(input) });
    if (method.endsWith(".prepare")) return { hostId,
      binding: { sessionKey: "shared-opaque-key", workspace: root, mode: input.backendId === "hermes" ? "gateway" : "openclaw" } };
    let state = observations.get(input.runId) || { status: "running" };
    if (method.endsWith(".cancel")) {
      const count = (cancellations.get(input.runId) || 0) + 1;
      cancellations.set(input.runId, count);
      state = count === 1 ? { status: "unknown", errorCode: "STOP_UNCONFIRMED" } : { status: "canceled" };
      observations.set(input.runId, state);
    }
    const sequence = (sequences.get(input.runId) || 0) + 1;
    sequences.set(input.runId, sequence);
    return { hostId, snapshot: {
      executionId: input.executionId, runId: input.runId, backendId: input.backendId, agentId: input.agentId,
      sessionKey: input.sessionKey, workspace: input.workspace, mode: input.mode,
      status: state.status, sequence, resultSummary: null, errorCode: state.errorCode || null, attention: null,
      finishedAt: ["completed", "canceled"].includes(state.status) ? Date.now() : null,
    } };
  } };
  const executor = new ExternalInspirationExecutor({ store, client, prompt: inspirationPrompt, pollMs: 60_000 });
  const service = new InspirationService({ paths, store, externalExecutor: executor,
    dispatcher: { getRun: () => null }, productStore: {} });
  service.open();
  t.after(() => { service.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const call = (method, input) => service.handle(`inspiration.${method}`, input);
  const start = async backendId => {
    const idea = (await call("create", { operationId: crypto.randomUUID(), body: "Review fixture idea" })).idea;
    const started = (await call("start", { id: idea.id, operationId: crypto.randomUUID(), expectedRevision: idea.revision,
      agentId: "shared-agent", backendId, instruction: "", workspace: null })).idea;
    await new Promise(resolve => setImmediate(resolve));
    await executor.pending.get(started.latestExecution.runId);
    return service.view(idea.id);
  };
  const complete = async idea => {
    observations.set(idea.latestExecution.runId, { status: "completed" });
    await executor.schedule(store.executionForRun(idea.latestExecution.runId), true);
  };
  return { store, service, executor, calls, cancellations, call, start, complete };
}

test("A user can explicitly retry stopping after an unconfirmed cancellation", async t => {
  const f = fixture(t);
  const idea = await f.start("hermes");
  const runId = idea.latestExecution.runId;
  const first = (await f.call("cancel", { id: idea.id, runId, operationId: crypto.randomUUID() })).idea;
  assert.equal(first.status, "unknown");
  const second = (await f.call("cancel", { id: idea.id, runId, operationId: crypto.randomUUID() })).idea;
  assert.equal(second.status, "canceled");
  assert.equal(f.cancellations.get(runId), 2);
});

test("Backend identity scopes an external session even when two adapters use the same opaque key", async t => {
  const f = fixture(t);
  const hermes = await f.start("hermes");
  await f.complete(hermes);
  const openclaw = await f.start("openclaw");
  await f.complete(openclaw);
  const resumed = (await f.call("session.send", { backendId: "hermes", agentId: "shared-agent",
    sessionKey: hermes.latestExecution.sessionKey, operationId: crypto.randomUUID(), prompt: "Continue Hermes idea" })).idea;
  assert.equal(resumed.id, hermes.id);
  assert.equal(resumed.latestExecution.backendId, "hermes");
  assert.notEqual(resumed.latestExecution.runId, hermes.latestExecution.runId);
});
