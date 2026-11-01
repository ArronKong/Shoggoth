"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { EncryptedSecretStore } = require("../app/agent-service/encrypted-secret-store");
const { McpConnectorSecrets } = require("../app/agent-service/mcp-connector-secrets");
const { TranscriptStore } = require("../app/agent-service/transcript-store");
const { openFixture, sendAndDrain, PROFILE_ID } = require("./shoggoth-work-run-coordinator-unit.cjs");
const defaults = require("../app/agent-service/data/mcp-featured-presets.json").find(p => p.id === "n8n").defaults.env;

async function storage(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-n8n-recovery-")));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const broker = { encrypt: async b => Buffer.from(b).reverse(), decrypt: async b => Buffer.from(b).reverse() };
  const encrypted = await new EncryptedSecretStore({ paths, cryptoBroker: broker }).open();
  encrypted.setClassificationProvider(ref => require("../app/agent-service/credential-classification").classificationFor(
    ref === "mcp-connector:n8n-fixture" ? { id: "n8n-fixture", transport: { kind: "stdio-package", registryType: "npm", identifier: "n8n-mcp" } } : null));
  const transcripts = new TranscriptStore({ paths }); transcripts.open();
  t.after(async () => { transcripts.close(); await encrypted.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, paths, encrypted, transcripts, secrets: new McpConnectorSecrets({ secretStore: encrypted }) };
}

test("n8n public defaults allow normal status while credentials, unknown env and complete envelopes remain protected", async t => {
  const { encrypted, secrets } = await storage(t);
  const envelope = { env: { ...defaults, N8N_API_KEY: "n8n-test-secret-canary" } };
  await secrets.write("n8n-fixture", envelope);
  const check = () => {
    assert.equal(encrypted.matchesPlaintext(JSON.stringify({ errorCode: null, recovered: true })), false);
    assert.equal(encrypted.matchesPlaintext("n8n-test-secret-canary"), true);
    assert.equal(encrypted.matchesPlaintext(JSON.stringify(envelope)), true);
  };
  check(); await encrypted.close(); await encrypted.open(); check();
  for (const env of [{ API_KEY: "error" }, { UNKNOWN_SETTING: "true" }, { LOG_LEVEL: "private-log-canary" }]) {
    await secrets.set("separate-credential", { env });
    assert.equal(encrypted.matchesPlaintext(Object.values(env)[0]), true);
    await secrets.remove("separate-credential");
  }
  check();
});

async function complete(value, runId) {
  const run = value.dispatcher.getRun(runId);
  const turn = value.host.threads[0].turns.find(t => t.id === run.runtimeTurnRef.turnId);
  turn.status = "completed";
  turn.items.push({ type: "agentMessage", text: "already saved answer", phase: "final_answer" });
  value.host.emit({ known: true, type: "complete", method: "turn/completed",
    threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId, status: "completed" });
  return value.coordinator.waitForIdle(runId);
}

for (const cut of ["none", "stream", "inbox", "legacy"]) test(`n8n completion and cold recovery preserve history without replay at ${cut} cut`, async t => {
  const { root, encrypted, secrets, transcripts } = await storage(t);
  await secrets.write("n8n-fixture", { env: defaults });
  const appendEvent = transcripts.appendEvent.bind(transcripts);
  if (cut === "legacy") transcripts.appendEvent = input => appendEvent(input.content?.transcriptType === "terminal"
    ? { ...input, content: { ...input.content, recovered: true } } : input);
  const value = await openFixture({ transcriptStore: transcripts, sessionWorkspace: root, sessionStatus: "ready",
    threadId: "n8n-recovery-thread", threads: [{ id: "n8n-recovery-thread", threadSource: null, turns: [] }],
    assertSecretSafe: v => !(cut === "stream" && JSON.stringify(v).includes('"errorCode"')) && !encrypted.matchesPlaintext(JSON.stringify(v)),
    inboxTransitionFailures: ["inbox", "legacy"].includes(cut) ? { completed: "PENDING_COMMAND_COMMIT_UNCERTAIN" } : {} });
  t.after(() => value.coordinator.close());
  const operationId = `n8n-${cut}`;
  const { ack } = await sendAndDrain(value, { operationId, prompt: "describe the tools" });
  if (cut === "none") await complete(value, ack.run.id);
  else await assert.rejects(complete(value, ack.run.id), { code: cut === "stream" ? "RUN_EVENT_SECRET_REJECTED" : "PENDING_COMMAND_COMMIT_UNCERTAIN" });
  assert.equal(value.dispatcher.getRun(ack.run.id).status, "completed");
  assert.equal(value.inbox.get(operationId).state, cut === "none" ? "completed" : "dispatching");
  transcripts.appendEvent = appendEvent;
  if (cut === "legacy") {
    const terminal = transcripts.listEvents(PROFILE_ID, value.sessions.session.id).find(e => e.content?.transcriptType === "terminal");
    transcripts.setContextExcluded({ profileId: PROFILE_ID, sessionId: value.sessions.session.id, eventId: terminal.id, contextExcluded: true });
  }
  const before = transcripts.listEvents(PROFILE_ID, value.sessions.session.id);
  assert.equal(before.filter(e => e.content?.transcriptType === "terminal").length, 1);
  assert.equal(value.host.turnStartCalls, 1);
  await value.coordinator.close();
  for (let restart = 0; restart < 2; restart++) {
    transcripts.close(); transcripts.open();
    const recovered = await openFixture({ dispatcher: value.dispatcher, inbox: value.inbox, sessions: value.sessions,
      transcriptStore: transcripts, sessionWorkspace: root, assertSecretSafe: v => !encrypted.matchesPlaintext(JSON.stringify(v)) });
    try {
      assert.equal(recovered.host.turnStartCalls, 0);
      assert.equal(value.inbox.get(operationId).state, "completed");
      assert.deepEqual(transcripts.listEvents(PROFILE_ID, value.sessions.session.id), before);
      assert.equal(value.dispatcher.listRuns().length, 1);
    } finally { await recovered.coordinator.close(); }
  }
});

test("recovery keeps conflicting terminal content fenced instead of completing the inbox", async t => {
  const { root, transcripts } = await storage(t);
  const value = await openFixture({ transcriptStore: transcripts, sessionWorkspace: root, sessionStatus: "ready",
    threadId: "conflict-thread", threads: [{ id: "conflict-thread", threadSource: null, turns: [] }],
    inboxTransitionFailures: { completed: "PENDING_COMMAND_COMMIT_UNCERTAIN" } });
  t.after(() => value.coordinator.close());
  const { ack } = await sendAndDrain(value, { operationId: "conflicting-terminal", prompt: "original" });
  await assert.rejects(complete(value, ack.run.id), { code: "PENDING_COMMAND_COMMIT_UNCERTAIN" });
  await value.coordinator.close();
  const before = transcripts.listEvents(PROFILE_ID, value.sessions.session.id);
  const originalGet = value.dispatcher.getRun.bind(value.dispatcher);
  value.dispatcher.getRun = id => { const run = originalGet(id); return run ? { ...run, resultSummary: "conflicting answer" } : run; };
  await assert.rejects(openFixture({ dispatcher: value.dispatcher, inbox: value.inbox, sessions: value.sessions,
    transcriptStore: transcripts, sessionWorkspace: root }), { code: "TRANSCRIPT_EVENT_CONFLICT" });
  assert.equal(value.inbox.get("conflicting-terminal").state, "dispatching");
  assert.deepEqual(transcripts.listEvents(PROFILE_ID, value.sessions.session.id), before);
});
