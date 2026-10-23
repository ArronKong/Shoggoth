"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { GroupNativeToolPreparation } = require("../app/agent-service/group-native-tools-preparation");
function fixture(options = {}) {
  let ready = false, current = true, tick = 0;
  const starts = [], resumes = [], changes = [];
  const native = {};
  const host = { host: native, capabilities: { "session.start": true, "session.resume": true, "turn.start": true },
    sessionList: async () => ({ data: [], nextCursor: null }),
    sessionStart: async args => { starts.push(args); ready = options.readyOnStart !== false; return { session: { id: "probe-session" } }; },
    sessionResume: async args => { resumes.push(args); } };
  const preparation = new GroupNativeToolPreparation({
    inspect: async () => ({ protocolVersion: 2, collaborationSupport: true, groupTools: ready, collaborationActions: ready }),
    now: () => tick, pause: async ms => { tick += ms; }, maxWaitMs: 30, pollMs: 10,
  });
  const input = { binding: { runtime: "test", runtimeProfileId: "rp", runtimeAccountId: "ra" }, host,
    profile: { id: "p", workspace: "/private/tmp/group-workspace", permissionPolicy: { approvalPolicy: "on-request", sandbox: "read-only" },
      permissionMode: "ask", nativePermissionMode: "native-mode", defaultModel: null },
    assertCurrent: () => { if (!current) throw Error("binding changed"); },
    onCapabilitiesChanged: () => changes.push("changed") };
  return { preparation, input, native, host, starts, resumes, changes, setReady(value) { ready = value; },
    invalidate() { current = false; } };
}

test("joining prepares actual MCP tools without a model turn or forged verification", async () => {
  const f = fixture();
  f.host.turnStart = () => { throw Error("must never start a model turn"); };
  const first = await f.preparation.probe(f.input);
  assert.equal(first.collaborationActions, false);
  await f.preparation.idle();
  assert.equal(f.starts.length, 1); assert.equal(f.resumes.length, 0);
  assert.equal(f.starts[0].cwd, f.input.profile.workspace);
  assert.deepEqual(f.starts[0].permissionPolicy, f.input.profile.permissionPolicy);
  assert.equal(f.starts[0].persistent, false);
  assert.equal(f.starts[0].permissionMode, "ask", "the Runtime handle receives the same product mode as ordinary chat");
  assert.equal(f.changes.length, 1);
  assert.equal((await f.preparation.probe(f.input)).collaborationActions, true);
  f.preparation.stop();
});

test("concurrent groups share preparation for the same host and session source", async () => {
  const f = fixture();
  await Promise.all([f.preparation.probe(f.input), f.preparation.probe(f.input)]);
  await f.preparation.idle(); assert.equal(f.starts.length, 1);
  const source = f.starts[0].source;
  const second = fixture(); await second.preparation.probe(second.input); await second.preparation.idle();
  assert.equal(second.starts[0].source, source, "ACP resumes the same dedicated empty preparation session after reconnect");
  f.preparation.stop(); second.preparation.stop();
});

test("no actual exposure stays pending after bounded preparation, without repeated session creation", async () => {
  const f = fixture({ readyOnStart: false });
  await f.preparation.probe(f.input); await f.preparation.idle();
  assert.equal((await f.preparation.probe(f.input)).collaborationActions, false);
  assert.equal(f.starts.length, 1); assert.equal(f.changes.length, 1);
  f.preparation.stop();
});

test("a Runtime with a read-only inventory needs no additional native session", async () => {
  const f = fixture({ readyOnStart: false });
  f.native.mcpServerStatusList = () => {};
  let calls = 0;
  f.preparation.inspect = async () => ({ protocolVersion: 2, collaborationSupport: true,
    groupTools: ++calls > 1, collaborationActions: calls > 1 });
  await f.preparation.probe(f.input); await f.preparation.idle();
  assert.equal(f.starts.length, 0); assert.equal(f.changes.length, 1);
  f.preparation.stop();
});

test("live runs, unconfigured hosts and changed identities cannot create preparation sessions", async () => {
  const live = fixture(); await live.preparation.probe({ ...live.input, runId: "live-run" });
  await live.preparation.idle(); assert.equal(live.starts.length, 0);
  const absent = fixture(); absent.preparation.inspect = async () => ({ collaborationSupport: false, collaborationActions: false });
  await absent.preparation.probe(absent.input); await absent.preparation.idle(); assert.equal(absent.starts.length, 0);
  const stale = fixture(); stale.invalidate(); await stale.preparation.probe(stale.input); await stale.preparation.idle();
  assert.equal(stale.starts.length, 0);
  live.preparation.stop(); absent.preparation.stop(); stale.preparation.stop();
});

test("unknown session creation is retained without a second start or any model call", async () => {
  const f = fixture();
  f.host.sessionStart = async args => { f.starts.push(args); throw Object.assign(Error("unknown"), { code: "RUNTIME_SESSION_ACCEPTANCE_UNKNOWN" }); };
  await f.preparation.probe(f.input); await f.preparation.idle();
  await f.preparation.probe(f.input); await f.preparation.idle();
  assert.equal(f.starts.length, 1); assert.equal(f.resumes.length, 0);
  f.preparation.stop();
});


test("a reconnect resumes only the exact metadata-identified preparation session", async () => {
  const first = fixture(); await first.preparation.probe(first.input); await first.preparation.idle();
  const source = first.starts[0].source, next = fixture();
  next.host.sessionList = async ({ archived }) => ({ data: archived ? [] : [{ id: "known", source, archived: false }], nextCursor: null });
  next.host.sessionResume = async args => { next.resumes.push(args); next.setReady(true); return { session: { id: "known" } }; };
  await next.preparation.probe(next.input); await next.preparation.idle();
  assert.equal(next.starts.length, 0); assert.equal(next.resumes[0].sessionId, "known");
  assert.equal((await next.preparation.probe(next.input)).collaborationActions, true);
  first.preparation.stop(); next.preparation.stop();
});

test("incomplete or ambiguous session metadata cannot create an untracked duplicate", async () => {
  for (const listed of [
    { data: [], nextCursor: "repeated" },
    { data: [{ source: "wrong" }], nextCursor: "repeated" },
  ]) {
    const f = fixture(); f.host.sessionList = async () => listed;
    await f.preparation.probe(f.input); await f.preparation.idle();
    assert.equal(f.starts.length, 0); assert.equal(f.resumes.length, 0); f.preparation.stop();
  }
});

test("a binding change after session creation cannot continue with another native session", async () => {
  const f = fixture();
  f.host.sessionStart = async args => { f.starts.push(args); f.invalidate(); return { session: { id: "known" } }; };
  await f.preparation.probe(f.input); await f.preparation.idle();
  assert.equal(f.starts.length, 1); assert.equal(f.resumes.length, 0);
  f.preparation.stop();
});

test("Service shutdown fences a queued preparation before any native session operation", async () => {
  const f = fixture();
  const pending = f.preparation.probe(f.input); f.preparation.stop();
  await pending; await f.preparation.idle();
  assert.equal(f.starts.length, 0); assert.equal(f.resumes.length, 0); assert.equal(f.changes.length, 0);
});
