#!/usr/bin/env node
"use strict";

// Production Service -> Harness IPC -> ShoggothBackend -> REST. Only the model
// extractor and external Runtime are fixture substitutes; all data is private
// to the temporary fixture root.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { startInspirationFixture } = require("./fixtures/inspiration-service-fixture.cjs");
const { DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");

async function main() {
  const fixture = await startInspirationFixture({ agentCount: 2 });
  try {
    const { service } = fixture;
    const profile = service.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
    const other = service.productStore.listAgentProfiles().find((item) => item.id !== profile.id);
    const session = service.chatSessionStore.listSessions().find((item) => item.profileId === profile.id);
    assert.ok(other && session);
    service.memoryCandidateService.extract = async ({ events }) => ({ candidates: events
      .filter((event) => event.text.includes("每周五进行候选集成复盘"))
      .flatMap((event) => [
        { eventId: event.eventId, sourceQuote: "每周五进行候选集成复盘",
          content: "用户每周五进行候选集成复盘", scope: "user" },
        { eventId: event.eventId, sourceQuote: "每周五进行候选集成复盘",
          content: "用户有定期进行候选集成复盘的安排", scope: "user" },
        { eventId: event.eventId, sourceQuote: "每周五进行候选集成复盘",
          content: "用户每周五会检查候选集成结果", scope: "user" },
        { eventId: event.eventId, sourceQuote: "每周五进行候选集成复盘",
          content: "用户每周五安排候选集成回顾", scope: "user" },
      ]) });

    const request = async (agentId, backend, suffix, method = "GET", body, browserOrigin = true) => {
      const url = new URL(`/__api/agents/${encodeURIComponent(agentId)}/${suffix}`, fixture.url);
      url.searchParams.set("backend", backend);
      const response = await fetch(url, { method,
        ...(body ? { headers: { "Content-Type": "application/json",
          ...(browserOrigin ? { Origin: new URL(fixture.url).origin } : {}) },
        body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json() };
    };
    const get = (query = "") => request(profile.agentId, "shoggoth", `memory-candidates${query}`);
    const post = (body, browserOrigin = true) => request(profile.agentId, "shoggoth",
      "memory-candidates", "POST", body, browserOrigin);
    const before = await get("?status=pending&cursor=0&limit=1");
    assert.equal(before.status, 200, JSON.stringify(before.data));
    assert.deepEqual(before.data.candidates.items, []);

    const started = await fixture.ipc("chat.send", { operationId: crypto.randomUUID(),
      sessionKey: session.sessionKey, prompt: "我每周五进行候选集成复盘。", createdAt: Date.now() });
    let source;
    for (let attempt = 0; attempt < 200; attempt++) {
      source = service.transcriptStore.listEvents(profile.id, session.id)
        .find((event) => event.runId === started.run.id && event.kind === "user");
      if (source) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(source, "fixture chat must persist a user event");
    for (let attempt = 0; attempt < 500; attempt++) {
      if (["ready", "archived"].includes(service.chatSessionStore.getSession(session.sessionKey)?.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(["ready", "archived"].includes(service.chatSessionStore.getSession(session.sessionKey)?.status),
      JSON.stringify(service.chatSessionStore.getSession(session.sessionKey)));
    // The fake Codex provider pauses this turn for an elicitation. Finish that
    // interaction through the real Coordinator; waiting_input is an active
    // Run and cannot be treated as completed extraction evidence.
    for (let attempt = 0; attempt < 1000; attempt++) {
      const current = service.workDispatcher.getRun(started.run.id);
      if (current?.status === "completed") break;
      if (current?.status === "waiting_input" && current.waitingRequestId) {
        await service.workRunCoordinator.respondInput({ operationId: crypto.randomUUID(),
          runId: current.id, requestId: current.waitingRequestId,
          action: "submit", answers: { choice: "Alpha" } });
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(service.workDispatcher.getRun(started.run.id)?.status, "completed",
      "fixture chat must finish before candidate extraction");
    await service.memoryCandidateService.processSession({ profileId: profile.id, sessionId: session.id });
    const first = await get("?status=pending&cursor=0&limit=1");
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.candidates.items.length, 1);
    assert.equal(first.data.candidates.hasMore, true);
    assert.equal(first.data.candidates.nextCursor, 1);
    assert.equal(first.data.candidates.items[0].source.eventId, source.id);
    const revision = first.data.candidates.revision;
    const next = await get(`?status=pending&cursor=1&limit=1&expectedRevision=${revision}`);
    assert.equal(next.status, 200, JSON.stringify(next.data));
    assert.equal(next.data.candidates.items.length, 1);
    assert.notEqual(next.data.candidates.items[0].id, first.data.candidates.items[0].id);
    assert.equal(next.data.candidates.hasMore, true);
    const foreign = await request(other.agentId, "shoggoth", "memory-candidates?status=all");
    assert.equal(foreign.status, 200, JSON.stringify(foreign.data));
    assert.deepEqual(foreign.data.candidates.items, []);
    const nonNative = await request(profile.agentId, "hermes", "memory-candidates?status=all");
    assert.notEqual(nonNative.status, 200);
    assert.doesNotMatch(JSON.stringify(nonNative.data), /每周五进行候选集成复盘/u);

    const firstId = first.data.candidates.items[0].id;
    const secondId = next.data.candidates.items[0].id;
    const noOrigin = await post({ action: "accept", candidateId: firstId,
      expectedRevision: revision, expectedMemoryRevision: 0 }, false);
    assert.equal(noOrigin.status, 403);
    assert.deepEqual(service.memoryStore.list(profile.id, { status: "active" }), []);
    const wrongMemoryRevision = await post({ action: "accept", candidateId: firstId,
      expectedRevision: revision, expectedMemoryRevision: 999, profileId: other.id });
    assert.notEqual(wrongMemoryRevision.status, 200);
    assert.match(JSON.stringify(wrongMemoryRevision.data), /HARNESS_REVISION_CONFLICT/u);
    assert.deepEqual(service.memoryStore.list(profile.id, { status: "active" }), []);
    const accepted = await post({ action: "accept", candidateId: firstId,
      expectedRevision: revision, expectedMemoryRevision: 0, profileId: other.id });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
    assert.equal(accepted.data.result.candidate.status, "accepted");
    assert.equal(accepted.data.result.memoryItem.status, "active");
    assert.equal(accepted.data.result.memoryItem.profileId, profile.id);
    assert.deepEqual(service.memoryStore.list(other.id, { status: "active" }), []);
    const afterAccept = accepted.data.result.revision;
    const stalePage = await get(`?status=pending&cursor=1&limit=1&expectedRevision=${revision}`);
    assert.notEqual(stalePage.status, 200);
    assert.match(JSON.stringify(stalePage.data), /MEMORY_CANDIDATE_REVISION_CONFLICT/u);
    const staleReject = await post({ action: "reject", candidateId: secondId,
      expectedRevision: revision });
    assert.notEqual(staleReject.status, 200);
    assert.match(JSON.stringify(staleReject.data), /MEMORY_CANDIDATE_REVISION_CONFLICT/u);
    const rejected = await post({ action: "reject", candidateId: secondId,
      expectedRevision: afterAccept });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.data));
    assert.equal(rejected.data.result.candidate.status, "rejected");
    const pending = (await get("?status=pending&limit=10")).data.candidates;
    assert.equal(pending.items.length, 2);
    const candidateIds = pending.items.map((item) => item.id);
    const wrongBatch = await post({ action: "acceptMany", candidateIds,
      expectedRevision: pending.revision, expectedMemoryRevision: 999 });
    assert.notEqual(wrongBatch.status, 200);
    assert.equal(service.memoryStore.list(profile.id, { status: "active" }).length, 1);
    const memoryRevision = service.memoryStore.getRevision(profile.id);
    const batch = await post({ action: "acceptMany", candidateIds,
      expectedRevision: pending.revision, expectedMemoryRevision: memoryRevision,
      profileId: other.id });
    assert.equal(batch.status, 200, JSON.stringify(batch.data));
    assert.deepEqual(batch.data.result.acceptedCandidateIds, candidateIds);
    assert.equal(batch.data.result.acceptedMemoryIds.length, 2);
    assert.equal(batch.data.result.memoryRevision, memoryRevision + 2,
      "one staged batch and one activation batch accept both suggestions");
    assert.equal(service.memoryStore.list(profile.id, { status: "active" }).length, 3);
    assert.deepEqual(service.memoryStore.list(other.id, { status: "active" }), []);
    assert.equal((await get("?status=pending")).data.candidates.items.length, 0);
    assert.equal((await get("?status=all")).data.candidates.items.length, 4);
    console.log("PASS candidate REST/Harness: paginated review, CAS, single/batch accept, reject and Agent isolation");
  } finally { await fixture.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
