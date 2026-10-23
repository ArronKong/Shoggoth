#!/usr/bin/env node
"use strict";

// Production Service end to end: a finished direct conversation with Agent A is
// consolidated in the background after its idle delay, and Agent B can recall
// the fact on its next turn. Only the model and Runtime are fixture substitutes.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { startInspirationFixture } = require("./fixtures/inspiration-service-fixture.cjs");
const { DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");
const { memoryTrust } = require("../app/agent-service/memory-engine");

const until = async (check, message, attempts = 1000) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
};

async function main() {
  const fixture = await startInspirationFixture({ agentCount: 2, serviceOptions: { memoryConsolidationIdleMs: 50 } });
  try {
    const { service } = fixture;
    const profile = service.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
    const other = service.productStore.listAgentProfiles().find((item) => item.id !== profile.id);
    const session = service.chatSessionStore.listSessions().find((item) => item.profileId === profile.id);
    assert.ok(other && session);
    service.memoryCandidateService.extract = async ({ events }) => ({ candidates: events
      .filter((event) => event.text.includes("每周五做发布复盘"))
      .map((event) => ({ eventId: event.eventId, sourceQuote: "每周五做发布复盘",
        content: "用户每周五做发布复盘", scope: "user" })) });
    const started = await fixture.ipc("chat.send", { operationId: crypto.randomUUID(),
      sessionKey: session.sessionKey, prompt: "我每周五做发布复盘。", createdAt: Date.now() });
    await until(async () => {
      const current = service.workDispatcher.getRun(started.run.id);
      if (current?.status === "waiting_input" && current.waitingRequestId) {
        await service.workRunCoordinator.respondInput({ operationId: crypto.randomUUID(),
          runId: current.id, requestId: current.waitingRequestId, action: "submit", answers: { choice: "Alpha" } });
      }
      return current?.status === "completed";
    }, "fixture chat must finish");
    const fact = await until(() => service.memoryStore.list(profile.id, { status: "active" })
      .find((item) => item.content === "用户每周五做发布复盘"), "the finished conversation must be consolidated");
    assert.equal(memoryTrust(fact), "system");
    const recalled = service.memoryEngine.search({ profileId: other.id, query: "发布复盘", maxSensitivity: "private" });
    assert.deepEqual(recalled.items.map((item) => [item.content, item.profileId]),
      [["用户每周五做发布复盘", profile.id]], "Agent B recalls what Agent A learned");
    const memoryPost = async (body, origin = true) => {
      const url = new URL(`/__api/agents/${encodeURIComponent(profile.agentId)}/memory`, fixture.url);
      url.searchParams.set("backend", "shoggoth");
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json",
        ...(origin ? { Origin: new URL(fixture.url).origin } : {}) }, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    };
    assert.equal((await memoryPost({ action: "undo", id: fact.id, expectedRevision: 0 }, false)).status, 403);
    assert.equal((await memoryPost({ action: "purge", id: fact.id, expectedRevision: 0 })).status, 400);
    const undone = await memoryPost({ action: "undo", id: fact.id,
      expectedRevision: service.memoryStore.getRevision(profile.id) });
    assert.equal(undone.status, 200, JSON.stringify(undone.data));
    assert.equal(undone.data.result.item.status, "deleted");
    assert.deepEqual(service.memoryEngine.search({ profileId: other.id, query: "发布复盘" }).items, [],
      "an undone consolidation is gone for every Agent");
    const forgot = await memoryPost({ action: "forgetSession", sessionId: session.id,
      expectedRevision: service.memoryStore.getRevision(profile.id) });
    assert.equal(forgot.status, 200, JSON.stringify(forgot.data));
    assert.equal(service.memoryCandidateService.candidates.get(profile.id).cursors[session.id].throughSeq,
      Number.MAX_SAFE_INTEGER, "the forgotten conversation is never consolidated again");
    console.log("PASS consolidation service: idle-triggered background consolidation reaches every Agent; REST undo and conversation forget");
  } finally { await fixture.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
