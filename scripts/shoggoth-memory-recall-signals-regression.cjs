"use strict";

// Memory repair stage 4: own recall signals count once per user event, only
// after a completed turn without borrowed dependencies, with the original
// relevance, and never block run cleanup.
const test = require("node:test"), assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { A, DAY, FACT, fixture } = require("./fixtures/memory-repair-fixture.cjs");
const { RECALL_SIGNAL_RECEIPTS_NAMESPACE } = require("../app/agent-service/shoggoth-memory/recall-signals.cjs");

const QUERY = "amber telescope calibrated";
const daily = entries => entries.find(entry => /^memory\/\d{4}-\d{2}-\d{2}\.md$/u.test(entry.path));
async function withNote(t) { const f = await fixture(t); await f.dailyNote(`- ${FACT}`); return f; }
async function ask(f, text, { searches = 1, status = "completed", session } = {}) {
  const input = f.turn(text, session);
  for (let i = 0; i < searches; i++) await f.search(QUERY, input, { minScore: 0 });
  await f.finish(input, status);
  return input;
}

test("several searches in one turn count once", { timeout: 60000 }, async t => {
  const f = await withNote(t);
  await ask(f, "When is the amber telescope calibrated?", { searches: 3 });
  const entry = daily(await f.recallEntries());
  assert.equal(entry?.recallCount, 1); assert.equal(entry?.userQueryHashes?.length, 1);
});

test("failed and cancelled turns never count", { timeout: 60000 }, async t => {
  const f = await withNote(t);
  await ask(f, "When is the amber telescope calibrated?", { status: "failed" });
  await ask(f, "How often is the telescope calibrated?", { status: "canceled" });
  assert.equal(daily(await f.recallEntries())?.userQueryHashes?.length ?? 0, 0);
  const reasons = f.diagnostics().filter(record => record.stage === "recall-signal").map(record => record.code);
  assert.deepEqual(reasons, ["NOT_COMPLETED", "NOT_COMPLETED"], "each dropped turn leaves its reason");
});

test("a user event older than the acceptance window never counts", { timeout: 60000 }, async t => {
  const f = await withNote(t);
  const input = f.turn("When is the amber telescope calibrated?");
  await f.search(QUERY, input, { minScore: 0 });
  f.advance(8 * DAY);
  await f.finish(input);
  assert.equal(daily(await f.recallEntries())?.userQueryHashes?.length ?? 0, 0);
});

test("a session whose history borrowed another Agent's memory never counts own hits", { timeout: 60000 }, async t => {
  const f = await withNote(t);
  await f.saveForeign("The amber telescope belongs to the eastern observatory.");
  const session = f.session();
  const first = f.turn("What about the amber telescope?", session);
  assert.ok((await f.search("amber telescope", first, { minScore: 0 })).results.some(result => result.borrowed === true));
  // The borrowed answer becomes part of the session history.
  f.service.transcriptStore.appendEvent({ profileId: A, sessionId: session.id, id: crypto.randomUUID(), runId: first.run.id,
    kind: "assistant", content: { text: "It belongs to the eastern observatory." }, occurredAt: f.now() });
  await f.finish(first);
  await ask(f, "When is it calibrated?", { session });
  assert.equal(daily(await f.recallEntries())?.userQueryHashes?.length ?? 0, 0);
});

test("concurrent commits for the same user event count once", { timeout: 60000 }, async t => {
  const f = await withNote(t), signals = f.owner.recallSignals;
  const input = f.turn("When is the amber telescope calibrated?");
  await f.search(QUERY, input, { minScore: 0 });
  const staged = signals.pending.get(signals.key(A, input.run.id));
  const twin = { ...input.run, id: crypto.randomUUID() };
  signals.pending.set(signals.key(A, twin.id), { profileId: A, results: new Map(staged.results) });
  const question = signals.question(A, input.run);
  signals.question = () => question;
  const outcomes = await Promise.all([signals.commit(input.run, "completed"), signals.commit(twin, "completed")]);
  assert.deepEqual(outcomes.map(outcome => outcome.committed).sort(), [0, 1]);
  assert.equal(daily(await f.recallEntries())?.recallCount, 1);
  await f.finish(input);
});

test("a full receipt store refuses new signals instead of evicting old receipts", { timeout: 120000 }, async t => {
  const f = await withNote(t);
  const store = f.owner.host(A).database.openKeyedStore({ namespace: RECALL_SIGNAL_RECEIPTS_NAMESPACE, maxEntries: 20_000,
    defaultTtlMs: 14 * DAY, overflowPolicy: "reject-new" });
  for (let i = 0; i < 20_000; i++) await store.registerIfAbsent(`filler-${i}`, { at: f.now() });
  await ask(f, "When is the amber telescope calibrated?");
  assert.equal(daily(await f.recallEntries())?.userQueryHashes?.length ?? 0, 0);
  assert.ok(await store.lookup("filler-0"), "old receipts survive");
});

test("the counted relevance is the same with sharing on or off", { timeout: 120000 }, async t => {
  const scores = [];
  for (const sharing of [true, false]) {
    const f = await withNote(t); if (!sharing) await f.sharing(false);
    await ask(f, "When is the amber telescope calibrated?");
    const entry = daily(await f.recallEntries());
    assert.equal(entry?.recallCount, 1); scores.push(entry.totalScore);
  }
  // Two separate indexes differ in tiny bm25 statistics, never by the fused
  // rank (about 0.017 for the top result).
  assert.ok(Math.abs(scores[0] - scores[1]) < 1e-3, `${scores[0]} vs ${scores[1]}`);
  assert.ok(scores[0] > 0.1, `own relevance is kept, not the fused rank (${scores[0]})`);
});

test("a failing signal commit still cleans up borrowing and recall state", { timeout: 60000 }, async t => {
  const f = await withNote(t);
  f.owner.host(A).searchIndex.recordRecallSignals = async () => { throw Object.assign(new Error("disk full"), { code: "SQLITE_FULL" }); };
  const input = f.turn("When is the amber telescope calibrated?");
  await f.search(QUERY, input, { minScore: 0 });
  await f.finish(input);
  assert.equal(f.owner.recallSignals.pending.size, 0);
  assert.equal(f.owner.sharing.requests.has(input.run.id), false);
  assert.ok(f.diagnostics().some(record => record.stage === "recall-signal" && record.outcome === "error" && record.code === "SQLITE_FULL"));
});

test("stopping a Profile discards its staged signals", { timeout: 60000 }, async t => {
  const f = await withNote(t);
  const input = f.turn("When is the amber telescope calibrated?");
  await f.search(QUERY, input, { minScore: 0 });
  assert.equal(f.owner.recallSignals.pending.size, 1);
  await f.owner.stopProfile(A);
  assert.equal(f.owner.recallSignals.pending.size, 0);
});

async function promotes(t, questions) {
  const f = await withNote(t);
  for (const question of questions) { await ask(f, question); f.advance(DAY); }
  f.model = async () => ({ text: "NONE" });
  assert.equal((await f.owner.dream(A)).handled, true);
  const memory = () => f.owner.store.readFile(A, "MEMORY.md");
  const promoted = memory().includes("calibrated every evening");
  if (promoted) {
    assert.equal((await f.owner.dream(A)).handled, true);
    assert.equal(memory().split("calibrated every evening").length - 1, 1, "a second Dreaming run never promotes it again");
  }
  return { promoted, entry: daily(await f.recallEntries()), memory: memory() };
}

test("enough different user questions on different days promote the clean daily fact into MEMORY.md once", { timeout: 120000 }, async t => {
  // Upstream needs >= 3 of each and a 0.75 blend; with exactly three the blend
  // is about 0.71, so the evidence must keep growing before a promotion.
  const { promoted, entry, memory } = await promotes(t, ["When is the amber telescope calibrated?",
    "How often is the amber telescope lens calibrated?", "What is calibrated every evening?",
    "Is the telescope calibrated daily?", "Which lens gets calibrated in the evening?"]);
  assert.equal(promoted, true, JSON.stringify(entry));
  assert.match(memory, /^- The amber telescope lens is calibrated every evening\. \[score=/mu);
  assert.doesNotMatch(memory, /shoggoth-memory-entry|^- - /mu, "storage markers never become memory");
});

test("the same question asked three times reaches the count but not the diversity gate", { timeout: 120000 }, async t => {
  const question = "When is the amber telescope calibrated?";
  const { promoted, entry } = await promotes(t, [question, question, question]);
  assert.equal(entry?.recallCount, 3); assert.equal(entry?.userQueryHashes?.length, 1);
  assert.equal(promoted, false);
});

test("fast recall counts only the complete selected fragment sent to a finished turn, then promotes it", { timeout: 120000 }, async t => {
  const sessions = new Map(), listeners = new Set(), requests = [];
  const host = {
    terminated: new Promise(() => {}),
    authenticationState: () => ({ authenticated: true, credentialPresent: true }),
    accountRead: async () => ({ account: { type: "chatgpt" }, requiresOpenaiAuth: false }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    registerServerRequestHandler() { return () => {}; },
    async threadStart({ threadSource, cwd, approvalsReviewer }) {
      const session = { id: crypto.randomUUID(), threadSource, cwd, archived: false, turns: [] };
      sessions.set(session.id, session);
      return { thread: structuredClone(session), approvalsReviewer };
    },
    async threadRead({ threadId }) { return { thread: structuredClone(sessions.get(threadId)) }; },
    async threadResume(input) { return { ...await this.threadRead(input), approvalsReviewer: input.approvalsReviewer }; },
    async threadList() { return { data: [...sessions.values()].map(session => structuredClone(session)), nextCursor: null }; },
    async threadInjectItems({ threadId, items }) {
      sessions.get(threadId).injectedContext = items.find(item => item.role === "user")?.content[0].text;
      return {};
    },
    async modelList() { return { data: [{ model: "fixture", isDefault: true, defaultReasoningEffort: "medium" }], nextCursor: null }; },
    async turnStart(input) {
      const session = sessions.get(input.threadId);
      const turn = { id: crypto.randomUUID(), status: "inProgress", itemsView: "full",
        items: [{ type: "userMessage", id: crypto.randomUUID(), clientId: input.clientUserMessageId }] };
      session.turns.push(turn);
      requests.push({ context: session.injectedContext, session, turn });
      delete session.injectedContext;
      return { turn: structuredClone(turn) };
    },
  };
  const f = await fixture(t, { runtimePool: { async get() { return host; }, async stopAll() {} } });
  await f.dailyNote(`- ${FACT}`);
  f.advance(DAY);
  await f.dailyNote("- The amber telescope crate stays locked beside the loading dock.");
  const note = /The amber telescope lens is calibrated every evening\./u;
  const recorded = async () => (await f.recallEntries()).find(entry => note.test(entry.snippet));
  const wait = async check => {
    const deadline = Date.now() + 10000;
    while (!await check()) {
      assert.ok(Date.now() < deadline, "isolated chat did not reach its expected state");
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  };
  const compiler = f.service.contextCompiler;
  const unsent = f.turn("Check the telescope lens before dusk.", undefined, { queued: true });
  const candidates = await f.search(unsent.query, unsent, { record: false, lexicalOnly: true, minScore: 0 });
  assert.ok(candidates.results.some(result => /crate stays locked/u.test(result.snippet)), "the distractor is a real lexical hit");
  await compiler.prepareRelated(unsent);
  const snapshot = compiler.compile({ ...unsent, transcriptSessionId: unsent.session.id });
  assert.match(snapshot.blocks.find(block => block.id === "active-memory")?.content || "", note);
  f.owner.stageFastRecallDelivery(unsent.run, snapshot.id, snapshot.dynamicContext.replaceAll(FACT, ""));
  await f.finish(unsent);
  assert.equal((await recorded())?.recallCount ?? 0, 0, "a snapshot whose fast fragment is absent from the request never counts");

  const questions = ["Check the telescope lens before dusk.", "Describe the telescope lens routine.",
    "Confirm the telescope lens maintenance schedule.", "Plan around the telescope lens calibration.",
    "Summarize the telescope lens checks.", "List the telescope lens maintenance requirements."];
  const session = f.session();
  for (const [index, prompt] of questions.entries()) {
    const { run } = await f.ipc("chat.send", { operationId: crypto.randomUUID(), sessionKey: session.sessionKey,
      prompt, createdAt: f.now() });
    await wait(() => {
      const current = f.service.workRunCoordinator.getRun(run.id);
      assert.ok(!["failed", "canceled", "interrupted"].includes(current?.status),
        `isolated chat ended before delivery: ${current?.status} ${current?.errorCode} ${JSON.stringify(current?.failureDetail)}`);
      return current?.status === "running" && requests.length > index;
    });
    const { context, turn, session: runtimeSession } = requests[index];
    const fastContext = context.match(/<active_memory_plugin>[\s\S]*?<\/active_memory_plugin>/u)?.[0] ?? "";
    assert.match(fastContext, note);
    assert.doesNotMatch(fastContext, /crate stays locked/u, "the unmatched lexical candidate is absent from fast recall");
    assert.equal((await recorded())?.recallCount ?? 0, index, "delivery alone does not count before completion");
    turn.status = "completed";
    turn.items.push({ type: "agentMessage", id: crypto.randomUUID(), phase: "final_answer", text: "Routine confirmed." });
    for (const listener of listeners) listener({ known: true, type: "complete", method: "turn/completed",
      threadId: runtimeSession.id, sessionId: runtimeSession.id, turnId: turn.id, status: "completed" });
    await wait(async () => (await recorded())?.recallCount === index + 1);
    await f.owner.finishActiveMemoryRun(f.service.workDispatcher.getRun(run.id));
    assert.equal((await recorded())?.recallCount, index + 1, "a repeated terminal callback does not double count");
    f.advance(DAY);
  }
  assert.equal((await recorded()).userQueryHashes.length, questions.length);
  assert.equal(f.modelCalls(), 2, "only the initial flushes used the text model");
  f.model = async () => ({ text: "NONE" });
  for (let i = 0; i < 2; i++) {
    assert.equal((await f.owner.dream(A)).handled, true);
    assert.equal(f.owner.store.readFile(A, "MEMORY.md").match(note)?.[0], FACT);
    assert.equal(f.owner.store.readFile(A, "MEMORY.md").split(FACT).length - 1, 1);
  }
});

test("fast recall keeps terminal and borrowing gates even when its own excerpt was delivered", { timeout: 60000 }, async t => {
  const f = await withNote(t);
  const compiler = f.service.contextCompiler;
  const deliver = async (message, session) => {
    const turn = f.turn(message, session, { queued: true });
    const input = { ...turn, transcriptSessionId: turn.session.id };
    await compiler.prepareRelated(input);
    const snapshot = compiler.compile(input);
    assert.match(snapshot.blocks.find(block => block.id === "active-memory")?.content || "", /calibrated every evening/u);
    f.owner.stageFastRecallDelivery(input.run, snapshot.id, snapshot.dynamicContext);
    return input;
  };
  await f.finish(await deliver("Check the telescope lens now."), "canceled");
  await f.saveForeign("The telescope lens is shipped separately. <!-- trigger:telescope lens -->");
  const borrowed = await deliver("Inspect the telescope lens delivery.");
  assert.ok(f.owner.sharing.borrowedRefsForRun(borrowed.run.id).length);
  await f.finish(borrowed);
  assert.equal(daily(await f.recallEntries())?.recallCount ?? 0, 0);
  assert.deepEqual(f.diagnostics().filter(record => record.stage === "recall-signal").map(record => record.code).sort(),
    ["BORROWED", "NOT_COMPLETED"]);
});

test("delivered historical conversation hits count against the existing corpus candidate and promote once", { timeout: 120000 }, async t => {
  const f = await fixture(t, { daysAgo: 1 });
  const past = f.session(), binding = crypto.randomUUID();
  f.service.chatSessionStore.requestBinding(past.sessionKey, binding, f.now());
  f.service.chatSessionStore.completeBinding(past.sessionKey, binding, `runtime-${binding}`);
  const original = f.turn(FACT, past);
  await f.finish(original);
  f.model = async () => ({ text: "NONE" });
  await f.owner.dream(A);
  const candidate = async () => (await f.recallEntries()).find(entry => entry.path.includes("/session-corpus/") && entry.snippet.includes(FACT));
  const initial = await candidate();
  assert.ok(initial, "the real night sweep ingested the original transcript");
  const call = (input, name, args) => {
    const controller = f.service.mcpProductToolController, { run, profile } = input;
    const current = f.service.chatSessionStore.getSession(input.session.sessionKey);
    if (current.status === "draft") {
      const operationId = crypto.randomUUID();
      f.service.chatSessionStore.requestBinding(current.sessionKey, operationId, f.now());
      f.service.chatSessionStore.completeBinding(current.sessionKey, operationId, `runtime-${operationId}`);
    }
    controller.getRuntimeContext = (profileId, selector) => profileId === A && selector.sourceId === run.sourceId
      ? { profileId: A, source: "chat", sourceId: run.sourceId, runId: run.id } : null;
    if (!controller.hookToolExecution.service.store.snapshotForRun(run.id)) {
      controller.hookToolExecution.service.freezeRun(run, profile);
    }
    return controller.handle(name, { source: "chat", sourceId: run.sourceId, ...args },
      { profileId: A, callId: crypto.randomUUID() }, { runId: run.id, assertCurrent() {} });
  };
  for (let index = 0; index < 6; index++) {
    const input = f.turn(`Review the amber telescope lens calibration detail ${index}.`);
    if (index === 0) {
      const args = { sessionId: past.id, query: "amber telescope lens" };
      let result = await call(input, "conversation_search", args);
      if (result.status === "rebuilding") {
        await f.service.conversationRecallService.whenIndexReady(A);
        result = await call(input, "conversation_search", args);
      }
      assert.equal(result.status, "ready");
      assert.ok(result.results.some(row => row.eventId === original.event.id && row.snippet.includes(FACT)));
    } else {
      const args = { sessionId: past.id, eventId: original.event.id };
      const result = await call(input, "conversation_get", args);
      assert.equal(result.events.find(event => event.eventId === original.event.id)?.text, FACT);
      await call(input, "conversation_get", args);
    }
    assert.equal((await candidate()).recallCount, index, "delivery does not count until the Run finishes");
    await f.finish(input);
    assert.equal((await candidate())?.recallCount, index + 1);
    assert.equal((await candidate()).key, initial.key);
    f.advance(DAY);
  }
  const revoked = f.turn("Double-check the amber telescope lens calibration.");
  await call(revoked, "conversation_get", { sessionId: past.id, eventId: original.event.id });
  await f.finish(revoked, "canceled");
  assert.equal((await candidate()).recallCount, 6);
  const foreign = "A ruby mount ships with the telescope lens.";
  await f.saveForeign(foreign);
  const borrowed = f.turn("Check the ruby mount and telescope lens notes.");
  await call(borrowed, "conversation_get", { sessionId: past.id, eventId: original.event.id });
  const shared = await f.search("ruby mount telescope lens", borrowed, { minScore: 0 });
  assert.ok(shared.results.some(row => row.borrowed && row.snippet.includes(foreign)));
  await f.finish(borrowed);
  assert.equal((await candidate()).recallCount, 6, "a borrowed dependency gates the whole turn");
  const scheduler = f.owner.maintenance;
  scheduler.onDreamScheduleChanged = null;
  const profile = f.service.productStore.getAgentProfile(A);
  const host = f.owner.host(A), files = host.getAgentWorkspaceAccess(host.workspaceDir).memoryFiles.maintenance;
  const commit = files.commitContent;
  let writes = 0;
  files.commitContent = async request => {
    const result = await commit(request);
    if (request.filePath.endsWith("/MEMORY.md")) {
      writes++;
      throw Object.assign(new Error("isolated interruption after publication"), { code: "EIO", publication: "uncertain" });
    }
    return result;
  };
  const runNight = async () => {
    const next = scheduler.schedule(profile).next_at;
    f.advance(Math.max(0, next - f.now()));
    scheduler.tick();
    await Promise.all([...scheduler.pending.values()]);
    return scheduler.schedule(profile);
  };
  const interrupted = await runNight();
  assert.equal(writes, 1);
  assert.equal(interrupted.state, "interrupted");
  assert.equal(interrupted.last_error, "MEMORY_DREAM_RECEIPT_PENDING");
  assert.equal(interrupted.retry_at, null);
  const published = f.owner.store.readFile(A, "MEMORY.md");
  assert.equal(published.split(FACT).length - 1, 1);
  scheduler.tick();
  assert.equal(scheduler.pending.size, 0, "the uncertain occurrence is never replayed");
  files.commitContent = async request => {
    if (request.filePath.endsWith("/MEMORY.md")) writes++;
    return commit(request);
  };
  const recovered = await runNight();
  assert.ok(recovered.due_at > interrupted.due_at);
  assert.equal(recovered.state, "completed");
  assert.ok((await candidate())?.promotedAt, "the next sweep reconciles the native promotion receipt");
  assert.equal(writes, 1);
  assert.equal(f.owner.store.readFile(A, "MEMORY.md"), published);
  await f.owner.forgetSession(A, past.id);
  assert.ok(!f.owner.store.list(A, { status: "active" }).some(item => item.content.includes(FACT)), "forget revokes the promoted historical fact");
});

test("automatic historical recall counts only a delivered verbatim excerpt and rechecks revocation", { timeout: 60000 }, async t => {
  const f = await fixture(t, { daysAgo: 1, mode: "always", memorySearch: { rememberAcrossConversations: true } });
  const past = f.session(), binding = crypto.randomUUID();
  f.service.chatSessionStore.requestBinding(past.sessionKey, binding, f.now());
  f.service.chatSessionStore.completeBinding(past.sessionKey, binding, `runtime-${binding}`);
  await f.finish(f.turn(FACT, past));
  f.model = async () => ({ text: "NONE" });
  await f.owner.dream(A);
  const count = async () => (await f.recallEntries()).find(row => row.path.includes("/session-corpus/") && row.snippet.includes(FACT))?.recallCount ?? 0;
  const deliver = async (query, summary) => {
    const turn = f.turn(query, undefined, { queued: true });
    const input = { ...turn, transcriptSessionId: turn.session.id };
    let call = 0;
    f.model = async ({ prompt }) => {
      if (++call === 1) return { text: JSON.stringify({ tool: "memory_search", arguments: { query: "amber telescope lens calibrated evening", minScore: 0 } }) };
      assert.ok(prompt.includes(FACT), "the auxiliary model really retrieved the historical event");
      return { text: JSON.stringify({ summary }) };
    };
    const compiler = f.service.contextCompiler;
    await compiler.prepareRelated(input);
    const snapshot = compiler.compile(input);
    assert.ok(snapshot.dynamicContext.includes(summary), "the main-model context contains the selected summary");
    f.owner.stageFastRecallDelivery(input.run, snapshot.id, snapshot.dynamicContext);
    return input;
  };
  await f.finish(await deliver("How is the amber lens maintained?", "We calibrate the lens nightly."));
  assert.equal(await count(), 0, "a paraphrase is not proof that the exact short-term excerpt was delivered");
  await f.finish(await deliver("What was the telescope lens routine?", FACT));
  assert.equal(await count(), 1);
  const revoked = await deliver("Recall the original lens calibration note.", FACT);
  await f.owner.forgetSession(A, past.id);
  await f.finish(revoked);
  assert.equal(await count(), 0);
  assert.ok(f.diagnostics().some(row => row.stage === "recall-signal" && row.code === "NO_CURRENT_RESULT"));
});
