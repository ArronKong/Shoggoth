#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const test = require("node:test");
const { FederationHostClient } = require("../app/agent-service/federation-host-client");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createFederationHostServer } = require("../app/federation-host-server");
const { resourceRevision } = require("../app/agent-service/app-state-projection");
const CANARY = "fixture-private-canary";
function request(operation, args, revision = null, backendId = "openclaw") {
  return { operation, backendId, targetProfileId: null, expectedRevision: revision, arguments: args,
    operationId: `mcp-v1-${crypto.randomBytes(24).toString("hex")}`, createdAt: Date.now() };
}
function fixture() {
  const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-app-manage-")); fs.chmodSync(trustedRoot, 0o700);
  const paths = resolveServicePaths({ trustedRoot, stateRoot: path.join(trustedRoot, "state"), profileRoot: path.join(trustedRoot, "profile"), cacheRoot: path.join(trustedRoot, "cache") });
  const jobs = new Map(), cards = new Map(); let writes = 0, connected = true, sequence = 0, failRun = false, ignorePatch = false;
  for (let id = 0; id < 151; id++) jobs.set(`openclaw:job-${id}`, { id: `openclaw:job-${id}`, backendId: "openclaw", agentId: "other-agent", name: `Cron ${id}`,
    prompt: CANARY, enabled: true, schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 }, lastError: CANARY });
  cards.set("card-1", { id: "card-1", title: "Card", body: "Before", column: "todo", agentId: "other-agent", priorityLevel: "normal" });
  const backend = {
    listAgents: async () => [{ id: "other-agent", name: "Other" }],
    getCronJobs: async () => [...jobs.values()].map(row => structuredClone(row)),
    createCronJob: async spec => { writes++; const id = `openclaw:created-${++sequence}`; const value = { ...spec, id, backendId: "openclaw" }; jobs.set(id, value); return structuredClone(value); },
    updateCronJob: async (id, patch) => { writes++; if (!ignorePatch) jobs.set(id, { ...jobs.get(id), ...patch }); return structuredClone(jobs.get(id)); },
    deleteCronJob: async id => { writes++; jobs.delete(id); },
    runCronJob: async () => { writes++; if (failRun) throw new Error(CANARY); return { ok: true, ran: true }; },
    getTaskBoard: async args => { assert.equal(args.readOnly, true); return { columns: [{ id: "todo", tasks: [...cards.values()].map(row => structuredClone(row)) }] }; },
    createTask: async spec => { writes++; const id = `created-card-${++sequence}`; const value = { id, ...spec, column: "todo" }; cards.set(id, value); return structuredClone(value); },
    updateTask: async (id, patch) => { writes++; if (!ignorePatch) cards.set(id, { ...cards.get(id), ...patch }); return structuredClone(cards.get(id)); },
    deleteTask: async id => { writes++; cards.delete(id); },
  };
  const registry = { getStatus: async () => [{ id: "openclaw", name: "OpenClaw", connected, info: { agentCount: 1 } }], getBackend: id => id === "openclaw" ? backend : null };
  const makeHost = () => createFederationHostServer({ paths, registry });
  return { paths, jobs, cards, backend, makeHost, client: new FederationHostClient({ paths, timeoutMs: 1000 }),
    get writes() { return writes; }, set failRun(value) { failRun = value; }, set ignorePatch(value) { ignorePatch = value; }, set connected(value) { connected = value; },
    cleanup: () => fs.rmSync(trustedRoot, { recursive: true, force: true }) };
}
async function code(action, expected) { await assert.rejects(action, error => error.code === expected && !error.message.includes(CANARY)); }

test("private socket global Cron reads every page, edits full data, and deletes with durable restart receipts", async () => {
  const f = fixture(); let host = f.makeHost(); await host.start();
  try {
    let cursor = null, rows = [];
    do { const page = await f.client.request("app.state.read", { section: "cron", cursor, limit: 50 });
      assert.equal(page.knownTotal, 151); assert.equal(page.total, null, "offline Hermes has an unknown inventory"); assert.equal(JSON.stringify(page).includes(CANARY), false); rows.push(...page.items); cursor = page.nextCursor; } while (cursor);
    assert.equal(rows.length, 151); const id = "openclaw:job-7";
    const edit = request("cron_update", { jobId: id, patch: { name: "Edited", prompt: "New instructions", schedule: { kind: "at", at: Date.now() + 60_000 } } }, rows.find(row => row.id === id).revision);
    const saved = await f.client.request("app.manage", edit); assert.equal(saved.status, "saved"); assert.equal(f.jobs.get(id).prompt, "New instructions");
    assert.equal(await f.client.request("app.manage", edit).then(row => row.revision), saved.revision); assert.equal(f.writes, 1);
    const deletion = request("cron_delete", { jobId: id }, saved.revision);
    const deleted = await f.client.request("app.manage", deletion); assert.equal(deleted.status, "deleted"); assert.equal(f.jobs.has(id), false);
    await host.stop(); host = f.makeHost(); await host.start();
    assert.deepEqual(await f.client.request("app.manage", deletion), deleted); assert.equal(f.writes, 2);
    const raw = fs.readFileSync(path.join(f.paths.stateDir, "app-management-receipts.json"), "utf8");
    assert.equal(raw.includes("New instructions"), false); assert.equal(raw.includes(CANARY), false);
    assert.equal(fs.statSync(path.join(f.paths.stateDir, "app-management-receipts.json")).mode & 0o077, 0);
  } finally { await host.stop(); f.cleanup(); }
});

test("stale versions, disconnected backends and protected system jobs make zero writes", async () => {
  const f = fixture(), host = f.makeHost(); await host.start();
  try {
    const id = "openclaw:job-1";
    await code(() => f.client.request("app.manage", request("cron_delete", { jobId: id }, "a".repeat(64))), "APP_MANAGE_RESOURCE_CHANGED");
    f.jobs.get(id).actions = { delete: false };
    await code(() => f.client.request("app.manage", request("cron_delete", { jobId: id }, resourceRevision("cron", f.jobs.get(id)))), "APP_MANAGE_OPERATION_UNSUPPORTED");
    f.connected = false;
    await code(() => f.client.request("app.manage", request("cron_delete", { jobId: id }, resourceRevision("cron", f.jobs.get(id)))), "BACKEND_UNAVAILABLE");
    assert.equal(f.writes, 0);
  } finally { await host.stop(); f.cleanup(); }
});

test("concurrent identical creation is one effect, and external cards map assignee and priority to real backend fields", async () => {
  const f = fixture(), host = f.makeHost(); await host.start();
  try {
    const create = request("cron_create", { agentId: "other-agent", name: "Created", prompt: "Do work", schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 }, enabled: true, model: null });
    const result = await Promise.all([f.client.request("app.manage", create), f.client.request("app.manage", create)]);
    assert.deepEqual(result[0], result[1]); assert.equal(f.writes, 1);
    const card = request("kanban_card_create", { boardId: "default", title: "New card", body: "Details", assignee: "other-agent", priority: "high" });
    const saved = await f.client.request("app.manage", card); assert.equal(saved.status, "saved");
    assert.equal(f.cards.get(saved.targetId).agentId, "other-agent"); assert.equal(f.cards.get(saved.targetId).priorityLevel, "high");
    const move = request("kanban_card_move", { cardId: saved.targetId, boardId: "default", status: "done" }, saved.revision);
    const moved = await f.client.request("app.manage", move); assert.equal(f.cards.get(saved.targetId).column, "done");
    await f.client.request("app.manage", request("kanban_card_delete", { cardId: saved.targetId, boardId: "default" }, moved.revision));
    assert.equal(f.cards.has(saved.targetId), false);
  } finally { await host.stop(); f.cleanup(); }
});

test("post-effect errors or discarded edits persist unknown outcomes and never resend after restart", async () => {
  const f = fixture(); let host = f.makeHost(); await host.start();
  try {
    const id = "openclaw:job-1"; f.failRun = true;
    const run = request("cron_run_now", { jobId: id }, resourceRevision("cron", f.jobs.get(id)));
    await code(() => f.client.request("app.manage", run), "APP_MANAGE_OUTCOME_UNKNOWN");
    await code(() => f.client.request("app.manage", run), "APP_MANAGE_OUTCOME_UNKNOWN"); assert.equal(f.writes, 1);
    await host.stop(); host = f.makeHost(); await host.start();
    await code(() => f.client.request("app.manage", run), "APP_MANAGE_OUTCOME_UNKNOWN"); assert.equal(f.writes, 1);
    f.ignorePatch = true;
    const edit = request("cron_update", { jobId: id, patch: { prompt: "Changed prompt" } }, resourceRevision("cron", f.jobs.get(id)));
    await code(() => f.client.request("app.manage", edit), "APP_MANAGE_OUTCOME_UNKNOWN"); assert.equal(f.writes, 2);
    await code(() => f.client.request("app.manage", edit), "APP_MANAGE_OUTCOME_UNKNOWN"); assert.equal(f.writes, 2);
  } finally { await host.stop(); f.cleanup(); }
});

test("malformed post-send management responses mean uncertain commit, not a retryable response error", async () => {
  const f = fixture(); const initial = f.makeHost(); await initial.start(); await initial.stop();
  fs.writeFileSync(f.paths.federationTokenPath, "a".repeat(43), { mode: 0o600 });
  const server = net.createServer(socket => socket.once("data", () => socket.end("invalid-json\n")));
  await new Promise(resolve => server.listen(f.paths.federationSocketPath, resolve)); fs.chmodSync(f.paths.federationSocketPath, 0o600);
  try {
    await code(() => f.client.request("app.manage", request("cron_delete", { jobId: "openclaw:job-1" }, "a".repeat(64))), "FEDERATION_COMMIT_UNCERTAIN");
    await code(() => f.client.request("app.state.read", { section: "cron", cursor: null, limit: 50 }), "FEDERATION_RESPONSE_INVALID");
  } finally { await new Promise(resolve => server.close(resolve)); f.cleanup(); }
});
