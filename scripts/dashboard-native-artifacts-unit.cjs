"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { BackendRegistry } = require("../app/core/backend-registry");

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-native-files-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.now(), sinceMs = now - 10_000;
  const profiles = ["a", "b", "archived"].map(id => ({ id, agentId: `agent-${id}`, name: `Writer ${id}`,
    enabled: id !== "archived", backendId: "shoggoth", runtime: "codex", runtimeAccountId: "codex" }));
  const sessions = profiles.flatMap(profile => ["chat", "cron", "inspiration"].map(kind => ({
    id: `${profile.id}-${kind}`, sessionKey: `${profile.id}-${kind}`, profileId: profile.id, workspace: root,
    status: "ready", createdAt: sinceMs - 100_000, updatedAt: now,
  })));
  const events = new Map(), calls = [];
  let clock = now;
  const backend = new ShoggothBackend({ paths: { tokenPath: "/tmp/unused-token" }, now: () => clock,
    readToken: () => "fixture", requestService: async () => { throw Error("unexpected real IPC"); } });
  backend._state = "started";
  backend._call = async (method, params) => {
    calls.push({ method, params });
    if (method === "profile.list") return { profiles, hasMore: false, nextCursor: null };
    if (method === "chat.session.list") {
      // Exercise real pagination instead of depending on the first sidebar page.
      const all = sessions.filter(session => session.profileId === params.profileId && session.status !== "archived");
      const cursor = Number(params.cursor || 0);
      return { sessions: all.slice(cursor, cursor + 1), hasMore: cursor + 1 < all.length, nextCursor: cursor + 1 < all.length ? String(cursor + 1) : null };
    }
    if (method === "run.list") return { runs: [{ id: `run-${params.sessionKey}`, startedAt: sinceMs - 100_000,
      finishedAt: now + 1000 }], hasMore: false, nextCursor: null };
    if (method === "harness.transcript.events") {
      const all = events.get(params.sessionId) || [];
      return { items: all.slice(params.cursor, params.cursor + 2), hasMore: params.cursor + 2 < all.length,
        nextCursor: params.cursor + 2, revision: all.length };
    }
    throw Error(`Unexpected ${method}`);
  };
  const file = (name, age = 0) => {
    const full = path.join(root, name); fs.writeFileSync(full, name);
    fs.utimesSync(full, new Date(now - age), new Date(now - age)); return full;
  };
  const output = (sessionId, full, { name = "write", success = true, input = false } = {}) => {
    const rows = events.get(sessionId) || [], id = String(rows.length);
    const event = (kind, content) => ({ kind, content, runId: `run-${sessionId}`, occurredAt: now });
    if (input) rows.push(event("user", { attachments: [{ path: full }] }));
    rows.push(event("tool_call", { toolCallId: id, tool: { name, displayArgs: { path: full } } }),
      event("tool_result", { toolCallId: id, tool: { success, status: success ? "completed" : "failed" } }));
    events.set(sessionId, rows);
  };
  return { backend, profiles, sessions, calls, events, file, output, sinceMs, now,
    advance: ms => { clock += ms; } };
}

test("native Dashboard aggregates all public Agent/session pages, excludes inputs, and limits after time filtering/dedup", async t => {
  const f = fixture(t);
  const first = f.file("first.txt"), second = f.file("second.md", 100), third = f.file("third.pdf", 200);
  f.output("a-chat", first); f.output("a-cron", second); f.output("b-inspiration", third);
  f.output("b-chat", first); // Same file referenced by two sessions, only one row.
  f.output("a-chat", f.file("uploaded.txt"), { input: true });
  f.output("a-chat", f.file("read.txt"), { name: "read" });
  f.output("a-chat", f.file("failed.txt"), { success: false });
  f.output("a-chat", f.file("old.txt", 50_000));
  f.output("archived-chat", f.file("archived.txt"));
  const result = await f.backend.getRecentArtifacts({ sinceMs: f.sinceMs, limit: 2 });
  assert.equal(result.supported, true); assert.equal(result.partial, false);
  assert.deepEqual(result.items.map(item => item.path), [first, second]);
  assert.equal(result.items[0].agentId, "agent-a"); assert.equal(result.items[0].agentName, "Writer a");
  assert.deepEqual((await f.backend.getRecentArtifacts({ sinceMs: f.sinceMs, limit: 20 })).items.map(item => item.path), [first, second, third]);
  assert.ok(!f.calls.some(call => call.params.profileId === "archived"));
});

test("concurrent reads share one scan; cached scopes refresh and removed sessions/Agents disappear immediately", async t => {
  const f = fixture(t), first = f.file("first.txt"), second = f.file("second.txt", 100);
  f.output("a-chat", first); f.output("b-chat", second);
  const query = { sinceMs: f.sinceMs };
  await Promise.all([f.backend.getRecentArtifacts(query), f.backend.getRecentArtifacts({ ...query, limit: 1 })]);
  assert.equal(f.calls.filter(call => call.method === "run.list").length, 6);
  await f.backend.getRecentArtifacts(query);
  assert.equal(f.calls.filter(call => call.method === "run.list").length, 6, "hot cache must not reread transcripts");
  f.advance(60_001);
  const stale = await f.backend.getRecentArtifacts(query);
  assert.equal(stale.items.length, 2);
  await f.backend._recentArtifactsScan?.promise;
  assert.equal(f.calls.filter(call => call.method === "run.list").length, 12);
  f.sessions.find(session => session.id === "a-chat").status = "archived";
  assert.deepEqual((await f.backend.getRecentArtifacts(query)).items.map(item => item.path), [second]);
  f.profiles[1].enabled = false;
  assert.deepEqual((await f.backend.getRecentArtifacts(query)).items, []);
});

test("one unreadable session/Agent keeps other files and exposes partial through Registry", async t => {
  const f = fixture(t), good = f.file("good.txt"); f.output("b-chat", good);
  const call = f.backend._call;
  f.backend._call = (method, params) => {
    if (method === "harness.transcript.events" && params.sessionId === "a-chat") throw Error("unavailable transcript");
    return call(method, params);
  };
  const registry = new BackendRegistry(); registry.register(f.backend);
  let [result] = await registry._dashboardSection("getRecentArtifacts", b => b.getRecentArtifacts({ sinceMs: f.sinceMs }));
  assert.equal(result.partial, true); assert.deepEqual(result.items.map(item => item.path), [good]);
  f.backend._call = (method, params) => {
    if (method === "chat.session.list" && params.profileId === "a") throw Error("unavailable Agent");
    return call(method, params);
  };
  [result] = await registry._dashboardSection("getRecentArtifacts", b => b.getRecentArtifacts({ sinceMs: f.sinceMs }));
  assert.equal(result.partial, true); assert.deepEqual(result.items.map(item => item.path), [good]);
});

test("a changed Service generation cannot publish an in-flight native artifact snapshot", async t => {
  const f = fixture(t), call = f.backend._call;
  f.backend._call = (method, params) => {
    if (method === "harness.transcript.events") f.backend._generation++;
    return call(method, params);
  };
  await assert.rejects(f.backend.getRecentArtifacts({ sinceMs: f.sinceMs }), /BACKEND_NOT_READY/);
  assert.equal(f.backend._recentArtifactsCache, undefined);
});
