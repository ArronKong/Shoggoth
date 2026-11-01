"use strict";
// A separate, disposable Service process. Fault cuts happen synchronously at
// durable Product/Transcript boundaries, never after a timing-only delay.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { createFixture, until, pause } = require("./generic-acp-service-fixture.cjs");
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const mode = argument("mode"), root = argument("root"), point = argument("point"), token = argument("token");
assert(["crash", "recover"].includes(mode)); assert(root && token && /^[a-z0-9-]+$/u.test(token));
const checkpointFile = path.join(root, "checkpoint.json"), operationFile = path.join(root, "operation.json");
const terminal = run => run && !["queued", "starting", "running", "waiting_approval", "waiting_input"].includes(run.status);
function durableJson(file, value) {
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const dir = fs.openSync(path.dirname(file), "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
async function main() {
  let faultFired = false, fixture, faultService;
  const operationId = `recovery-${token}`, key = `shoggoth:chat-send:${operationId}`;
  const crash = (service, proposed, previous, committed, boundary) => {
    if (faultFired) return; faultFired = true;
    durableJson(checkpointFile, { version: 1, point, boundary, token, operationId, pid: process.pid,
      runId: proposed.id, previous: previous || null, proposed, committed: committed || null,
      peerAudit: fixture?.auditRows() || [], at: Date.now() });
    process.kill(process.pid, "SIGKILL");
    throw Error("SIGKILL did not terminate the isolated Service process");
  };
  const beforeStart = mode === "crash" ? service => {
    const put = service.productStore.putWorkRun;
    service.productStore.putWorkRun = function(input) {
      const previous = input?.id ? service.productStore.getWorkRun(input.id) : null;
      const selected = input?.idempotencyKey === key;
      const newlyPrepared = selected && !previous?.runtimeAttemptRef && input.runtimeAttemptRef?.dispatchState === "prepared";
      const newlyWritten = selected && previous?.runtimeAttemptRef?.dispatchState === "prepared" && input.runtimeAttemptRef?.dispatchState === "write_attempted";
      const newlyAccepted = selected && !previous?.runtimeTurnRef && input.runtimeTurnRef;
      if (point === "before_prepare" && newlyPrepared) crash(service, input, previous, null, "before Product prepared append; encrypted descriptor is durable");
      if (point === "after_remote_terminal" && newlyAccepted) crash(service, input, previous, null, "durable Handle terminal before Product acceptance append");
      const result = put.call(this, input);
      if (point === "after_prepared" && newlyPrepared) crash(service, input, previous, result, "after Product prepared append and fsync");
      if (point === "after_write_marker" && newlyWritten) crash(service, input, previous, result, "after Product write_attempted append before observer returns");
      if (point === "after_accepted" && newlyAccepted) crash(service, input, previous, result, "after Product accepted append and fsync");
      if (point === "after_product_terminal" && selected && input.status === "completed" && previous?.status !== "completed") crash(service, input, previous, result, "after Product completed append before Inbox acknowledgement");
      return result;
    };
    faultService = service;
  } : undefined;
  if (mode === "crash" && point === "after_first_text") {
    const modulePath = path.resolve(__dirname, "../../app/agent-service/runtime-acp-ledger.js");
    const handlePath = path.resolve(__dirname, "../../app/agent-service/runtime-acp-handle.js");
    assert.equal(require.cache[handlePath], undefined, "Ledger fault wrapper must precede Handle module loading");
    const ledgerModule = require(modulePath), open = ledgerModule.openAcpLedger;
    ledgerModule.openAcpLedger = function(options) {
      const ledger = open(options);
      return { ...ledger, save() {
        const result = ledger.save();
        const turn = ledger.state.sessions.flatMap(session => session.turns).find(candidate =>
          candidate.operationId === operationId && !candidate.facts.terminal
          && candidate.items.some(item => item.type === "agentMessage" && item.text?.includes(`ACP answer ${token}`)));
        if (turn) {
          const run = faultService.productStore.listWorkRuns().find(candidate => candidate.idempotencyKey === key);
          assert(run); crash(faultService, run, run, run, "after first assistant Handle V2 ledger fsync and ownership metadata update; peer held before terminal");
        }
        return result;
      } };
    };
  }
  fixture = await createFixture({ root, agents: 1, beforeStart });
  if (mode === "crash") {
    const input = { operationId, sessionKey: fixture.chats[0].sessionKey,
      prompt: `[ACP_PROBE:${token}] ${point === "after_first_text" ? "[ACP_TEXT_THEN_WAIT]" : ""} controlled durable recovery`, createdAt: Date.now() };
    durableJson(operationFile, input);
    await fixture.rpc("chat.send", input);
    await until(() => faultFired, `fault point ${point} was not reached`, 20000);
    throw Error("The fault process unexpectedly continued");
  }
  const checkpoint = JSON.parse(fs.readFileSync(checkpointFile, "utf8")), input = JSON.parse(fs.readFileSync(operationFile, "utf8"));
  assert.equal(checkpoint.token, token); assert.equal(input.operationId, operationId);
  const run = await until(() => { fixture.collectOwnedHosts(); const current = fixture.service.productStore.getWorkRun(checkpoint.runId); return terminal(current) && current; }, `recovery ${point} did not settle`, 20000);
  const auditBeforeReplay = fixture.auditRows().filter(row => row.kind === "prompt" && row.token === token);
  const replay = await fixture.rpc("chat.send", input); assert.equal(replay.run.id, run.id);
  await pause(60);
  const auditAfterReplay = fixture.auditRows().filter(row => row.kind === "prompt" && row.token === token);
  assert.equal(auditAfterReplay.length, auditBeforeReplay.length, "Same operation must not dispatch another prompt");
  const rows = fixture.service.transcriptStore.listEvents(fixture.profiles[0].id, fixture.chats[0].id).filter(row => row.runId === run.id);
  const resourcesBefore = fixture.resourceSnapshot(), resourcesAfter = await fixture.closeAndObserve();
  durableJson(path.join(root, "recovered.json"), { version: 1, point, token, run, replayRunId: replay.run.id,
    promptCount: auditAfterReplay.length, prompts: auditAfterReplay, audit: fixture.auditRows(),
    transcript: rows, resourcesBefore, resourcesAfter, processExit: "natural", nativeRuntimeAcquireAttempts: resourcesAfter.nativeAcquireAttempts });
}
main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });
