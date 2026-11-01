"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { A, fixture, FACT: ENGLISH_FACT, recallModel } = require("./fixtures/memory-repair-fixture.cjs");
const FACT = "琥珀望远镜每天傍晚校准，校准代号为 DERIVATIVE7392。";
const ANSWER = "校准代号：DERIVATIVE7392。频率：每天一次。";
function boundSession(f) {
  const session = f.session(), operationId = crypto.randomUUID();
  f.service.chatSessionStore.requestBinding(session.sessionKey, operationId, f.now());
  f.service.chatSessionStore.completeBinding(session.sessionKey, operationId, crypto.randomUUID());
  return session;
}
function appendAnswer(f, input, text, { legacy = false } = {}) {
  const proof = !legacy && f.owner.ownMemory?.projection(input.run);
  return f.service.transcriptStore.appendEvent({ profileId: A, sessionId: input.session.id,
    id: crypto.randomUUID(), runId: input.run.id, kind: "assistant", occurredAt: f.now(),
    content: { text, ...(proof ? { ownMemoryProvenance: proof } : {}) } });
}
function begin(f, input, items = [], history = []) {
  f.owner.ownMemory?.begin(input, items, history);
}
async function forget(f, item) {
  await f.owner.delete({ profileId: A, id: item.id, reason: "forgotten", operationId: crypto.randomUUID() });
}

test("forget removes a reformulated answer from the actual session index without editing chat", { timeout: 60000 }, async t => {
  const f = await fixture(t), item = await f.saveUser(FACT), input = f.turn("琥珀望远镜代号是什么", boundSession(f));
  const getConfig = f.owner.getConfig;
  f.owner.getConfig = () => { const cfg = getConfig(); return { ...cfg,
    memory: { ...cfg.memory, search: { ...cfg.memory.search, sources: ["memory", "sessions"] } } }; };
  begin(f, input);
  await f.search("琥珀望远镜", input);
  const answer = appendAnswer(f, input, ANSWER); await f.finish(input);
  const before = JSON.stringify(f.service.transcriptStore.listEvents(A, input.session.id));
  assert.ok((await f.owner.searchMemory({ profileId: A, workspace: f.workspace, maxSensitivity: "private", query: "DERIVATIVE7392", record: false })).results
    .some(row => row.source === "sessions" && row.snippet.includes("DERIVATIVE7392")));
  await forget(f, item);
  const after = await f.owner.searchMemory({ profileId: A, workspace: f.workspace, maxSensitivity: "private", query: "DERIVATIVE7392", record: false });
  assert.equal(after.results.some(row => row.snippet.includes("DERIVATIVE7392")), false, "the reformulated assistant answer must not survive forget");
  assert.equal(f.owner.recallPolicy.isEventVisible(A, answer), false);
  assert.equal(JSON.stringify(f.service.transcriptStore.listEvents(A, input.session.id)), before, "private chat is byte-for-byte unchanged");
  const host = f.owner.host(A);
  assert.equal(host.searchIndex.db.prepare("SELECT count(*) AS n FROM memory_index_chunks WHERE source='sessions' AND text LIKE ?").get("%DERIVATIVE7392%").n, 0);
  f.owner.recallPolicy.close(); f.owner.recallPolicy.open();
  assert.equal(f.owner.recallPolicy.isEventVisible(A, answer), false, "persisted proof survives recall-policy restart");
});

test("hot-context and inherited replies revoke together while unrelated proven replies remain eligible", { timeout: 60000 }, async t => {
  const f = await fixture(t), item = await f.saveUser(FACT), other = await f.saveUser("紫色望远镜的代号是 UNRELATED6482。");
  const first = f.turn("代号呢", boundSession(f)); begin(f, first, [item]);
  const answer = appendAnswer(f, first, ANSWER); await f.finish(first);
  const followup = f.turn("换个说法", first.session); begin(f, followup, [], [answer]);
  const inherited = appendAnswer(f, followup, "DERIVATIVE7392 就是你要的代号。"); await f.finish(followup);
  const independent = f.turn("另一个代号", boundSession(f)); begin(f, independent, [other]);
  const unrelated = appendAnswer(f, independent, "UNRELATED6482。"); await f.finish(independent);
  await forget(f, item);
  assert.equal(f.owner.recallPolicy.isEventVisible(A, answer), false);
  assert.equal(f.owner.recallPolicy.isEventVisible(A, inherited), false);
  assert.equal(f.owner.recallPolicy.isEventVisible(A, unrelated), true);
});

test("unattributed legacy assistant history is excluded after forget while original chat and user facts remain", { timeout: 60000 }, async t => {
  const f = await fixture(t), item = await f.saveUser(FACT), input = f.turn("我独立提供的另一条事实是 LEGACYUSER327。", boundSession(f));
  const answer = appendAnswer(f, input, ANSWER, { legacy: true }); await f.finish(input);
  assert.equal(f.owner.recallPolicy.isEventVisible(A, answer), true);
  await forget(f, item);
  assert.equal(f.owner.recallPolicy.isEventVisible(A, answer), false);
  assert.equal(f.owner.recallPolicy.isEventVisible(A, input.event), true);
  assert.equal(f.service.transcriptStore.listEvents(A, input.session.id).find(event => event.id === answer.id).content.text, ANSWER);
});

test("fresh explicit reauthorization does not bless old derivative proofs", { timeout: 60000 }, async t => {
  const f = await fixture(t), item = await f.saveUser(FACT), input = f.turn("查一下代号", boundSession(f));
  begin(f, input, [item]); const old = appendAnswer(f, input, ANSWER); await f.finish(input);
  await forget(f, item); f.advance(10);
  const renewedInput = f.turn(FACT, boundSession(f));
  const renewed = await f.owner.propose({ profileId: A, scope: "user", type: "semantic", content: FACT, classification: "explicit",
    sourceRefs: [renewedInput.event.id, renewedInput.run.id] });
  begin(f, renewedInput, [renewed]); const current = appendAnswer(f, renewedInput, ANSWER); await f.finish(renewedInput);
  assert.equal(f.owner.recallPolicy.isEventVisible(A, old), false);
  assert.equal(f.owner.recallPolicy.isEventVisible(A, current), true);
});

test("direct memory_get and actual prepared deep recall both carry source dependencies", { timeout: 60000 }, async t => {
  const f = await fixture(t, { mode: "always" }), item = await f.saveUser(ENGLISH_FACT);
  const getInput = f.turn("read the record", boundSession(f)); begin(f, getInput);
  f.service.mcpProductToolController.conversationMemoryService.get(A, item.id, getInput.run);
  const readAnswer = appendAnswer(f, getInput, "Every evening."); await f.finish(getInput);
  recallModel(f, "amber telescope");
  const recalled = f.turn("What do you remember about the amber telescope?", boundSession(f), { queued: true });
  await f.owner.prepareActiveMemory(recalled);
  assert.match(f.owner.takeActiveMemory(recalled)?.content || "", /every evening/u);
  begin(f, recalled);
  const recallAnswer = appendAnswer(f, recalled, "It is calibrated at dusk."); await f.finish(recalled);
  assert.ok(readAnswer.content.ownMemoryProvenance.refs.some(ref => ref.id === item.id));
  assert.ok(recallAnswer.content.ownMemoryProvenance.refs.some(ref => ref.id === item.id));
  await forget(f, item);
  assert.equal(f.owner.recallPolicy.isEventVisible(A, readAnswer), false);
  assert.equal(f.owner.recallPolicy.isEventVisible(A, recallAnswer), false);
});

test("expiry alone preserves historical replies; invalid ownership and incomplete proofs cannot survive forget", { timeout: 60000 }, async t => {
  const f = await fixture(t), item = await f.saveUser(FACT), input = f.turn("show the calibration", boundSession(f));
  begin(f, input, [item]); const answer = appendAnswer(f, input, ANSWER); await f.finish(input);
  await f.owner.delete({ profileId: A, id: item.id, reason: "expired", operationId: crypto.randomUUID() });
  assert.equal(f.owner.recallPolicy.isEventVisible(A, answer), true, "expiry is not a request to forget history");
  await forget(f, item);
  for (const proof of [null, { ...answer.content.ownMemoryProvenance, profileId: "wrong-owner", refs: [] },
    { ...answer.content.ownMemoryProvenance, complete: false, refs: [] }]) {
    assert.equal(f.owner.recallPolicy.isEventVisible(A, { ...answer, content: { text: "rephrased detail", ownMemoryProvenance: proof } }), false);
  }
});
