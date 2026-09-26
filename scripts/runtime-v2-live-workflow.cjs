"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { PROTOCOL_VERSION } = require("../app/agent-service/server");

const terminalStates = new Set(["completed", "failed", "interrupted", "canceled", "skipped"]);
function fixedError(code) { return Object.assign(new Error(code), { code }); }

async function runWorkflow({ service, paths, profileId, workspaceRoot, phase = "all", onProgress = () => {}, timeoutMs = 240_000 }) {
  const coordinator = service.workRunCoordinator;
  const bindings = service.productStore.getAgentRuntimeBindings(profileId).bindings;
  const bindingFor = runtime => bindings.find(binding => binding.runtime === runtime && binding.enabled);
  if (!bindingFor("codex") || !bindingFor("pi")) throw fixedError("S6_BINDING_MISSING");
  const activeIds = new Set();
  const metrics = { peakActive: 0, peakRunning: 0, peakQueued: 0, byRuntimePeakRunning: { codex: 0, pi: 0 } };
  let snapshotTimer;
  const observe = () => {
    const runs = coordinator.listRuns().filter(run => activeIds.has(run.id));
    metrics.peakActive = Math.max(metrics.peakActive, runs.filter(run => !terminalStates.has(run.status) && run.status !== "queued").length);
    metrics.peakRunning = Math.max(metrics.peakRunning, runs.filter(run => run.status === "running").length);
    metrics.peakQueued = Math.max(metrics.peakQueued, runs.filter(run => run.status === "queued").length);
    for (const runtime of ["codex", "pi"]) metrics.byRuntimePeakRunning[runtime] = Math.max(metrics.byRuntimePeakRunning[runtime],
      runs.filter(run => run.status === "running" && run.runtimeSessionRef?.runtime === runtime).length);
  };
  const call = (method, params) => requestService(paths, { token: readClientToken(paths), version: PROTOCOL_VERSION,
    method, params }, { timeoutMs: 30_000 });
  const switchRuntime = async (sessionKey, runtime) => {
    const session = service.chatSessionStore.getSession(sessionKey);
    return call("chat.session.runtime.switch", { profileId, sessionKey, bindingId: bindingFor(runtime).id,
      revision: session.revision, acceptAdjustments: true });
  };
  const createSession = name => {
    const workspace = path.join(workspaceRoot, name);
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    return service.chatSessionStore.createSession({ profileId, operationId: `s6-create-${name}`,
      workspace, createdAt: Date.now() });
  };
  const send = async (sessionKey, operationId, prompt) => {
    const ack = await coordinator.send({ sessionKey, operationId, prompt });
    activeIds.add(ack.run.id); observe();
    return ack.run;
  };
  const awaitTerminal = async run => {
    let timer;
    try {
      const completed = coordinator.waitForTerminal(run.id).then(async result => {
        await coordinator.waitForIdle(run.id);
        return result;
      });
      const result = await Promise.race([completed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(fixedError("S6_RUN_TIMEOUT")), timeoutMs);
      })]);
      observe();
      if (result.status !== "completed") throw fixedError(result.errorCode || "S6_RUN_NOT_COMPLETED");
      return result;
    } finally { clearTimeout(timer); }
  };
  const results = { handoff: null, mixed: null };
  try {
    snapshotTimer = setInterval(observe, 100);
    if (["handoff", "all"].includes(phase)) {
      onProgress("handoff");
      const session = createSession("handoff");
      const marker = `S6_HANDOFF_${crypto.randomBytes(5).toString("hex")}`;
      const refs = [], checks = [];
      for (const [index, runtime] of ["codex", "pi", "codex"].entries()) {
        if (index) await switchRuntime(session.sessionKey, runtime);
        const prompt = index === 0
          ? `Remember the exact conversation marker ${marker}. Reply with only that marker. Do not call tools or modify files.`
          : "What is the exact conversation marker stated earlier? Reply with only the marker. Do not call tools or modify files.";
        const result = await awaitTerminal(await send(session.sessionKey, `s6-handoff-${index}`, prompt));
        if (result.runtimeSessionRef?.runtime !== runtime || !result.resultSummary?.includes(marker)) throw fixedError("S6_HANDOFF_RECALL_FAILED");
        refs.push(result.runtimeSessionRef); checks.push(true);
      }
      const current = service.chatSessionStore.getSession(session.sessionKey);
      const events = service.transcriptStore.listEvents(profileId, session.id);
      if (current.id !== session.id || current.profileId !== profileId || current.retiredRuntimeSessions.length !== 2
        || refs[0].sessionId === refs[2].sessionId
        || events.filter(e => e.kind === "user").length !== 3
        || events.filter(e => e.content.transcriptType === "runtime.switched").length !== 2) throw fixedError("S6_HANDOFF_IDENTITY_FAILED");
      results.handoff = { runtimes: refs.map(ref => ref.runtime), recallChecks: checks, sameConversation: true,
        freshCodexSessionOnReturn: true, retiredSessions: 2, userTranscriptEvents: 3 };
    }
    if (["mixed", "all"].includes(phase)) {
      onProgress("mixed-prepare");
      const sessions = [];
      for (let index = 0; index < 20; index++) {
        const runtime = index % 2 ? "pi" : "codex";
        const session = createSession(`mixed-${index}`);
        if (runtime === "pi") await switchRuntime(session.sessionKey, runtime);
        sessions.push({ session, runtime, index });
      }
      onProgress("mixed-dispatch");
      const runs = await Promise.all(sessions.map(({ session, index }) => send(session.sessionKey, `s6-mixed-${index}`,
        `Write approximately 250 words about deterministic software tests, then end with the exact marker MIXED_OK_${index}. `
        + "Do not call tools, inspect files, or modify the workspace. This is a bounded runtime acceptance test.")));
      onProgress("mixed-running");
      const outcomes = await Promise.all(runs.map(awaitTerminal));
      for (const [index, result] of outcomes.entries()) {
        if (result.runtimeSessionRef?.runtime !== sessions[index].runtime
          || !result.resultSummary?.includes(`MIXED_OK_${index}`)) throw fixedError("S6_MIXED_RESULT_INVALID");
      }
      results.mixed = { submitted: 20, completed: outcomes.length, perRuntime: { codex: 10, pi: 10 }, ...metrics,
        simultaneous20RunningObserved: metrics.peakRunning >= 20 };
    }
    return results;
  } catch (error) {
    // Cancellation is bounded by real Coordinator/native stop semantics. Service
    // shutdown remains responsible for all concrete children before parent exit.
    await Promise.allSettled([...activeIds].map(async runId => {
      const run = coordinator.getRun(runId);
      if (run && !terminalStates.has(run.status)) await coordinator.abort({ operationId: `s6-abort-${runId}`,
        sessionKey: coordinator.getRunSessionKey(run), runId });
    }));
    throw error;
  } finally { clearInterval(snapshotTimer); }
}

module.exports = { runWorkflow };
