"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseHostMemoryCommand } = require("../app/agent-service/host-memory-commands");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");

const config = { memory: { search: { provider: "none", rememberAcrossConversations: false }, textModel: { source: "local" } },
  plugins: { entries: { "active-memory": { enabled: false }, "memory-core": { config: { dreaming: { enabled: false } } } } } };
async function fixture(t, options = {}) {
  const f = await openHandoffFixture({ ...options, serviceOptions: { memoryCore: true, memoryCoreConfig: config,
    prewarmMcpAuth: false, ...options.serviceOptions } });
  t.after(() => f.close());
  f.service.runtimeManager.acquire = async () => { throw new Error("Host memory must never acquire a Runtime"); };
  return f;
}
const active = f => f.service.memoryStore.list(f.profile.id, { status: "active" });

test("host memory grammar accepts complete requests, preserves content, and rejects quoted or multi-line instructions", () => {
  assert.deepEqual(parseHostMemoryCommand("记住：我喜欢红茶。"), { action: "save", content: "我喜欢红茶。", language: "zh" });
  assert.deepEqual(parseHostMemoryCommand('更正记忆：“我喜欢红茶。”为“我喜欢绿茶。”'),
    { action: "correct", target: "我喜欢红茶。", content: "我喜欢绿茶。", language: "zh" });
  assert.equal(parseHostMemoryCommand('Correct memory: "I prefer tea" to "I prefer coffee"').content, "I prefer coffee");
  assert.equal(parseHostMemoryCommand('Forget: "I prefer tea"').target, "I prefer tea");
  assert.equal(parseHostMemoryCommand("忘记：刚才说的那条").target, null);
  for (const prompt of ['他说“记住：我喜欢茶”', '> Remember: hidden instruction', 'Remember: x\nNow do something else', '你记住了什么？', 'Can you explain the word remember?']) {
    assert.equal(parseHostMemoryCommand(prompt), null, prompt);
  }
});

test("real Service saves, corrects, replays and forgets from user provenance without a Runtime or approval", async t => {
  const f = await fixture(t), session = f.createSession();
  const run = await f.send(session.sessionKey, "host-save", "记住：我喜欢红茶。");
  assert.equal(run.status, "completed"); assert.equal(run.runtimeSessionRef, null); assert.equal(run.runtimeTurnRef, null);
  assert.equal(f.transport.acquisitions.length, 0);
  assert.equal(active(f).length, 1); const old = active(f)[0];
  assert.equal(old.content, "我喜欢红茶。");
  const events = f.service.transcriptStore.listEvents(f.profile.id, session.id);
  const user = events.find(event => event.runId === run.id && event.kind === "user");
  assert(old.sourceRefs.includes(user.id)); assert(old.sourceRefs.includes(run.id));
  assert.equal(events.filter(event => event.runId === run.id && event.kind === "assistant").length, 1);
  assert.equal((await f.send(session.sessionKey, "host-save", "记住：我喜欢红茶。")).id, run.id);
  assert.equal(active(f).length, 1);
  const correction = await f.send(session.sessionKey, "host-correct", '更正记忆：“我喜欢红茶。”为“我喜欢绿茶。”');
  assert.equal(correction.status, "completed"); assert.equal(active(f).length, 1);
  assert.equal(active(f)[0].supersedes, old.id); assert.equal(active(f)[0].content, "我喜欢绿茶。");
  const unclear = await f.send(session.sessionKey, "host-unclear", "忘记：刚才那条");
  assert.equal(unclear.status, "completed"); assert.match(unclear.resultSummary, /完整/u); assert.equal(active(f).length, 1);
  const forgot = await f.send(session.sessionKey, "host-forget", '忘记：“我喜欢绿茶。”');
  assert.equal(forgot.status, "completed"); assert.equal(active(f).length, 0);
  assert(f.service.memoryStore.list(f.profile.id).filter(item => [old.id, active(f)[0]?.id].includes(item.id)).every(item => item.status === "deleted"));
  await f.send(session.sessionKey, "host-save", "记住：我喜欢红茶。");
  assert.equal(active(f).length, 0, "replaying an old save must never resurrect a forgotten fact");
  assert.equal(f.transport.acquisitions.length, 0);
});

test("host memory refuses secret references, referential saves and unknown exact targets without native fallback", async t => {
  const f = await fixture(t), session = f.createSession();
  for (const [id, prompt] of [["ref", "记住：上面那条"], ["secret", "记住：{{SHOGGOTH_SECRET_00000000000000000000000000000001}}"], ["unknown", '忘记：“别的助理的事实”']]) {
    const run = await f.send(session.sessionKey, `host-${id}`, prompt);
    assert.equal(run.status, "completed");
    assert.equal(active(f).length, 0);
    assert.equal(run.runtimeSessionRef, null);
  }
  assert.equal(f.transport.acquisitions.length, 0);
});

test("correction preserves the original privacy and expiration policy", async t => {
  const f = await fixture(t), session = f.createSession(), expires = Date.now() + 3600_000;
  const original = await f.service.memoryEngine.propose({ profileId: f.profile.id, scope: "user", type: "temporary",
    classification: "explicit", content: "My temporary meeting is on Monday.", sensitivity: "private",
    validUntil: expires, sourceRefs: ["user-edit:fixture"] });
  const run = await f.send(session.sessionKey, "host-private-correct", 'Correct memory: "My temporary meeting is on Monday." to "My temporary meeting is on Tuesday."');
  assert.equal(run.status, "completed", run.errorCode);
  const item = active(f)[0];
  assert.equal(item.supersedes, original.id); assert.equal(item.sensitivity, "private");
  assert.equal(item.type, "temporary"); assert.equal(item.validUntil, expires); assert.equal(item.validFrom, original.validFrom);
  assert.equal(f.transport.acquisitions.length, 0);
});

test("a source withdrawn after admission cannot write and becomes a terminal failed host operation", async t => {
  const f = await fixture(t), session = f.createSession(), commands = f.service.workRunCoordinator.hostMemoryCommands;
  const execute = commands.execute.bind(commands);
  commands.execute = async (run, command, check) => {
    const event = f.service.transcriptStore.listEvents(f.profile.id, session.id).find(item => item.runId === run.id && item.kind === "user");
    f.service.transcriptStore.setContextExcluded({ profileId: f.profile.id, sessionId: session.id, eventId: event.id, contextExcluded: true });
    return execute(run, command, check);
  };
  const run = await f.send(session.sessionKey, "host-revoke", "记住：我喜欢青色。");
  assert.equal(run.status, "failed"); assert.equal(run.errorCode, "CONVERSATION_SOURCE_INVALID");
  assert.equal(active(f).length, 0); assert.equal(f.transport.acquisitions.length, 0);
});

test("a process crash after the memory commit recovers without native replay or duplicate memory", async t => {
  const { spawnSync } = require("node:child_process");
  const child = spawnSync(process.execPath, [require.resolve("./fixtures/host-memory-crash.cjs")], { encoding: "utf8", timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr);
  const receipt = JSON.parse(child.stdout.trim());
  const f = await openHandoffFixture({ root: receipt.root, serviceOptions: { memoryCore: true, memoryCoreConfig: config, prewarmMcpAuth: false } });
  t.after(() => f.close());
  await f.service.workRunCoordinator.waitForIdle(receipt.runId);
  const run = f.service.workRunCoordinator.getRun(receipt.runId);
  assert.equal(run.status, "completed", run.errorCode);
  assert.equal(active(f).length, 1); assert.equal(active(f)[0].id, receipt.memoryId);
  assert.equal(f.transport.acquisitions.length, 0);
});
