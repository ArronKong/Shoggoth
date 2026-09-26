"use strict";
const crypto = require("node:crypto"), path = require("node:path"), fs = require("node:fs");
const { QUESTIONS, scoreAnswers } = require("./fixtures/runtime-handoff-dialogue.cjs");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { PROTOCOL_VERSION } = require("../app/agent-service/server");
async function runCompactionWorkflow({ service, paths, profileId, workspaceRoot, onProgress = () => {} }) {
  const check = (value, code) => { if (!value) throw Object.assign(new Error(code), { code }); };
  const workspace = path.join(workspaceRoot, "product-compaction"); fs.mkdirSync(workspace, { recursive: true });
  const coordinator = service.workRunCoordinator, session = service.chatSessionStore.createSession({ profileId,
    operationId: "compaction-live-create", workspace, createdAt: Date.now() });
  const bindingFor = runtime => service.productStore.getAgentRuntimeBindings(profileId).bindings.find(binding => binding.runtime === runtime);
  const call = (method, params) => requestService(paths, { version: PROTOCOL_VERSION, token: readClientToken(paths), method, params }, { timeoutMs: 30_000 });
  const switchTo = async runtime => {
    const current = service.chatSessionStore.getSession(session.sessionKey);
    await call("chat.session.runtime.switch", { profileId, sessionKey: session.sessionKey, bindingId: bindingFor(runtime).id,
      revision: current.revision, acceptAdjustments: true });
  };
  const send = async (operationId, prompt) => {
    const ack = await coordinator.send({ operationId, sessionKey: session.sessionKey, prompt });
    let timer;
    try { const run = await Promise.race([coordinator.waitForTerminal(ack.run.id), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "COMPACTION_LIVE_TIMEOUT" })), 240_000); })]);
      await coordinator.waitForIdle(run.id); check(run.status === "completed", run.errorCode || "COMPACTION_LIVE_RUN_FAILED"); return run;
    } finally { clearTimeout(timer); }
  };
  const marker = `CHECKPOINT_${crypto.randomBytes(6).toString("hex")}`;
  await switchTo("pi"); onProgress("compaction-seed");
  await send("compaction-live-seed", `The durable project marker is ${marker}. Preserve this exact marker and these five project facts:\n`
    + QUESTIONS.map(item => `${item.id}: ${item.answer}`).join("\n") + "\nReply only with the marker. Do not use tools.");
  const priorNative = service.chatSessionStore.getSession(session.sessionKey).runtimeSessionId;
  const appendHistory = (batch, rounds) => {
    for (let index = 0; index < rounds; index++) for (const kind of ["user", "assistant"]) {
      service.transcriptStore.appendEvent({ profileId, sessionId: session.id, id: `${batch}-${kind}-${index}`, kind,
        content: { text: `Synthetic acceptance transcript ${batch}, round ${index}. ` + "Routine measurement completed; project decisions and constraints remain unchanged. ".repeat(12) },
        contextExcluded: false, occurredAt: Date.now() });
    }
  };
  appendHistory("first", 60);
  const bytes = Buffer.byteLength(JSON.stringify(service.transcriptStore.listEvents(profileId, session.id)));
  check(bytes > 96 * 1024, "COMPACTION_LIVE_INPUT_TOO_SMALL");
  onProgress("compaction-auto");
  const recalled = await send("compaction-live-recall-1", "What exact durable project marker was stated earlier? Reply with only that marker. Do not use tools.");
  const first = service.conversationCheckpointStore.compatible(profileId, session.id); check(first, "COMPACTION_LIVE_CHECKPOINT_MISSING");
  if (!JSON.stringify(first.summary).includes(marker)) throw Object.assign(new Error("COMPACTION_LIVE_SUMMARY_LOST_MARKER"), {
    code: "COMPACTION_LIVE_SUMMARY_LOST_MARKER", fixtureCheckpointSummary: first.summary });
  check(recalled.resultSummary.includes(marker), "COMPACTION_LIVE_RECALL_1_FAILED");
  const renewed = service.chatSessionStore.getSession(session.sessionKey);
  check(priorNative && renewed.runtimeSessionId, "COMPACTION_LIVE_NATIVE_REF_MISSING");
  check(renewed.runtimeSessionId !== priorNative, "COMPACTION_LIVE_NATIVE_NOT_RENEWED");
  appendHistory("second", 20);
  const secondReply = await send("compaction-live-recall-2", "Repeat the original durable project marker only. Do not use tools.");
  check(secondReply.resultSummary.includes(marker), "COMPACTION_LIVE_RECALL_2_FAILED");
  const second = service.conversationCheckpointStore.compatible(profileId, session.id); check(second && second.id !== first.id, "COMPACTION_LIVE_NOT_REPEATED");
  onProgress("compaction-handoff"); await switchTo("codex");
  const handoff = await send("compaction-live-handoff", "Repeat the original durable project marker only. Do not use tools.");
  check(handoff.resultSummary.includes(marker), "COMPACTION_LIVE_HANDOFF_RECALL_FAILED");
  const factReply = await send("compaction-live-five-facts", "Answer these questions using the original project facts. Return only one JSON object with string values for goal, constraints, decisions, files, next. Do not use tools.\n"
    + QUESTIONS.map(item => `${item.id}: ${item.question}`).join("\n"));
  let answers;
  try { answers = JSON.parse(factReply.resultSummary.trim().replace(/^```(?:json)?\s*\n/u, "").replace(/\n```$/u, "")); }
  catch { check(false, "COMPACTION_LIVE_ANSWERS_INVALID"); }
  const score = scoreAnswers(answers); check(score.passed, "COMPACTION_LIVE_FACTS_LOST");
  const summaries = coordinator.listRuns({ profileId, source: "compaction" }); check(summaries.length >= 3, "COMPACTION_LIVE_TOO_FEW_SUMMARIES");
  check(summaries.every(run => run.status === "completed"), "COMPACTION_LIVE_SUMMARY_FAILED");
  const usage = service.tokenUsageStore.list({ profileId }).filter(row => row.source === "compaction"); check(usage.length >= 3, "COMPACTION_LIVE_USAGE_MISSING");
  return { evidence: "real-native-provider-with-synthetic-over-budget-transcript", sourceBytes: bytes, summaryRuns: summaries.length,
    summaryUsageRecords: usage.length, repeatedSummary: true, recallChecks: 3, semanticScore: score,
    handoff: "pi-to-codex", nativeSessionRenewed: true,
    transcriptPreserved: service.transcriptStore.listEvents(profileId, session.id).length >= 160 };
}
module.exports = { runCompactionWorkflow };
