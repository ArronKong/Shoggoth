#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { OpenClawBackend } = require("../app/core/openclaw-backend");
const { supportsOpenClawPluginSelection } = require("../app/core/openclaw-plugin-selection");
const capability = { version: 1, host: "openclaw", hostVersion: "2026.9.5", wire: "capabilitySelection",
  receiptMethod: "chat.selection.get", supportedQueueModes: ["followup"], supportedHarnesses: ["openclaw"],
  adapters: [{ adapterId: "shoggoth-shared-capabilities", adapterGeneration: "generation", instanceId: "instance" }] };
const input = { agentId: "main", sessionKey: "agent:main:existing-ui-session" };
let connects = 0, mintCalls = 0, capabilityValue = capability, actualAgent = { id: "main" }, advertised = true;
const calls = [];
const backend = new OpenClawBackend({ externalPluginSelectionService: {
  prepareExternalPluginSelection() { mintCalls += 1; throw new Error("must not mint"); },
} });
backend._connect = async () => { connects += 1; };
backend.hasGatewayMethod = () => advertised;
backend.getAgent = async () => actualAgent;
backend.request = async (method, params) => { calls.push({ method, params }); return capabilityValue; };
async function main() {
  try {
    assert.equal(await backend.getPluginSelectionReadiness(input), true);
    assert.deepEqual(calls, [{ method: "chat.selection.capabilities", params: {} }]);
    assert.equal(mintCalls, 0);
    console.log("PASS exact authenticated capability registration observation; no subject/session/dispatch creation");
    const before = connects;
    for (const invalid of [{}, { ...input, agentId: "neighbor" }, { ...input, sessionKey: "bare-session" },
      { ...input, sessionKey: "agent:main:\u0000" }, { ...input, agentId: "bad/id" }]) {
      assert.equal(await backend.getPluginSelectionReadiness(invalid), false);
    }
    assert.equal(connects, before);
    advertised = false;
    assert.equal(await backend.getPluginSelectionReadiness(input), false);
    advertised = true; actualAgent = { id: "neighbor" };
    assert.equal(await backend.getPluginSelectionReadiness(input), false);
    assert.equal(calls.length, 1);
    actualAgent = { id: "main" };
    console.log("PASS invalid identity, old Host and different real Agent never query capabilities");
    for (const invalid of [null, true, "true", { ...capability, hostVersion: "unknown" },
      { ...capability, subject: { agentId: "main", sessionId: "forged" } },
      { ...capability, adapters: [...capability.adapters, ...capability.adapters] },
      { ...capability, adapters: [{ ...capability.adapters[0], token: "forged" }] }]) {
      capabilityValue = invalid;
      assert.equal(supportsOpenClawPluginSelection(invalid), false);
      assert.equal(await backend.getPluginSelectionReadiness(input), false);
    }
    console.log("PASS readiness requires exact fixed protocol, unique real adapter and strict boolean");
    capabilityValue = capability;
    backend.getAgent = async () => { backend._connectionGeneration += 1; return { id: "main" }; };
    const beforeGeneration = calls.length;
    assert.equal(await backend.getPluginSelectionReadiness(input), false);
    assert.equal(calls.length, beforeGeneration);
    backend.getAgent = async () => ({ id: "main" });
    backend.request = async () => { backend._connectionGeneration += 1; return capability; };
    assert.equal(await backend.getPluginSelectionReadiness(input), false);
    backend.request = async () => { throw new Error("Host disconnected"); };
    assert.equal(await backend.getPluginSelectionReadiness(input), false);
    assert.equal(mintCalls, 0);
    console.log("PASS changed connection generation and failed observation never enable selection");
    console.log(JSON.stringify({ ok: true, groups: 4, sessionCreations: 0, serviceDispatches: 0, modelCalls: 0, remoteCalls: 0 }));
  } finally { await backend.stop(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
