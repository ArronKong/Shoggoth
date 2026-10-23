#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { createManagedProviderCredentialFinishGate } = require("../app/managed-openclaw-provider-credential-finish");
function fixture(mode = "success") {
  const trace = []; let current = true, paused = true, holds = [], settles = 0;
  const gate = createManagedProviderCredentialFinishGate({ assertCurrent: () => current,
    async resumeVerified() { trace.push("resume"); paused = false; if (mode === "resume-unknown") throw new Error("synthetic private error");
      if (mode === "retire-after-resume") current = false; return true; },
    async settleVerified(outcome) { settles++; trace.push("settle:" + outcome); assert.equal(paused, false);
      if (["settle-unknown", "pause-unknown"].includes(mode)) throw new Error("synthetic canary must not escape");
      if (mode === "settle-truthy") return { settled: true }; return true; },
    async pauseVerified() { trace.push("pause-original"); if (mode === "pause-unknown") throw new Error("exact owner unavailable"); paused = true; return true; },
    async holdUnverified(verified) { holds.push(verified); trace.push(verified ? "paused-hold" : "unknown-hold"); }, });
  return { gate, trace, state: () => ({ paused, holds, settles }) };
}
async function main() {
  const groups = [], success = fixture(); assert.equal(await success.gate.finish("applied"), true); assert(success.gate.isComplete());
  assert.deepEqual(success.trace, ["resume", "settle:applied"]); await assert.rejects(success.gate.finish("applied")); assert.equal(success.state().settles, 1);
  groups.push("one exact attempt orders verified resume before verified Service settlement, and cannot send settlement a second time");
  const unknown = fixture("settle-unknown"); await assert.rejects(unknown.gate.finish("applied"), error => error.code === "MANAGED_MODEL_CREDENTIAL_FINISH_UNKNOWN" && !error.message.includes("canary"));
  assert.deepEqual(unknown.trace, ["resume", "settle:applied", "pause-original", "paused-hold"]); assert.equal(unknown.state().paused, true); assert(!unknown.gate.isComplete());
  await assert.rejects(unknown.gate.finish("applied")); assert.equal(unknown.state().settles, 1);
  groups.push("unknown settlement/ACK pauses original writer and holds unverified; it never replays settle, secret or config write");
  const noPause = fixture("pause-unknown"); await assert.rejects(noPause.gate.finish("compensated")); assert.deepEqual(noPause.state().holds, [false]);
  assert.equal(noPause.state().paused, false); assert(!noPause.gate.isComplete());
  groups.push("failed exact-owner pause remains unknown rather than reporting a fabricated paused or successful exit proof");
  const retired = fixture("retire-after-resume"); await assert.rejects(retired.gate.finish("blocked"));
  assert.equal(retired.state().settles, 0); assert.equal(retired.state().paused, true); assert.deepEqual(retired.state().holds, [true]);
  groups.push("retirement after resume prevents settlement and uses only original bounded pause cleanup");
  const resume = fixture("resume-unknown"); await assert.rejects(resume.gate.finish("applied")); assert.equal(resume.state().settles, 0); assert(resume.state().paused);
  groups.push("unknown resume does not call Service settlement; same captured writer is paused without a replacement launch");
  const truthy = fixture("settle-truthy"); await assert.rejects(truthy.gate.finish("applied")); assert(truthy.state().paused); assert(!truthy.gate.isComplete());
  groups.push("success-shaped truthy callbacks cannot complete the trusted gate; exact true is required after physical checks");
  await success.gate.withdraw(); assert(success.state().paused); assert(!success.gate.isComplete()); assert.equal(success.state().settles, 1);
  assert.throws(() => createManagedProviderCredentialFinishGate({ ready: true }));
  groups.push("later local withdrawal can only pause original owner, with no repeated resume/settle and no serializable readiness authority");
  process.stdout.write(JSON.stringify({ status: "PASS", groups: groups.length, cases: groups, hostStarts: 0, modelRequests: 0, configWrites: 0,
    boundary: "trusted callback order/control contract only; actual Host and Service physical verification remain separate" }) + "\n");
}
main().catch(error => { process.stderr.write(error.stack + "\n"); process.exitCode = 1; });
