#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { parsePluginSelectionReadinessQuery, validatePluginSelectionReadinessInput } = require("../app/core/plugin-selection-readiness-dto");
const { startStaticServer } = require("../app/static-server");
async function main() {
  const checks = [], sessionId = "a56ca862-55eb-4dc6-99bf-999f38cff894";
  const input = { agentId: "shoggoth:test", sessionKey: `agent:shoggoth:test:${sessionId}` };
  const query = new URLSearchParams({ backend: "shoggoth", agent: input.agentId, sessionKey: input.sessionKey });
  assert.deepEqual(parsePluginSelectionReadinessQuery(query), { backendId: "shoggoth", input });
  for (const key of ["subject", "lease", "ready", "envelope", "token", "nativeMeta"]) {
    const bad = new URLSearchParams(query); bad.append(key, "caller-injected");
    assert.throws(() => parsePluginSelectionReadinessQuery(bad));
    assert.throws(() => validatePluginSelectionReadinessInput({ ...input, [key]: true }));
  }
  for (const key of ["backend", "agent", "sessionKey"]) {
    const repeated = new URLSearchParams(query); repeated.append(key, query.get(key));
    assert.throws(() => parsePluginSelectionReadinessQuery(repeated));
    const missing = new URLSearchParams(query); missing.delete(key);
    assert.throws(() => parsePluginSelectionReadinessQuery(missing));
  }
  for (const key of ["agent:other:tail", `agent:${input.agentId}:`, input.sessionKey + "\n", "x".repeat(257)]) {
    assert.throws(() => validatePluginSelectionReadinessInput({ ...input, sessionKey: key }));
  }
  assert.throws(() => validatePluginSelectionReadinessInput(Object.defineProperty({ sessionKey: input.sessionKey }, "agentId", { enumerable: true, get() { throw Error("getter ran"); } })));
  checks.push("exact bounded query rejects injected authority, duplicate/missing fields, control text, accessors and cross-Agent session prefixes");
  let serviceCalls = 0;
  const native = new ShoggothBackend({ requestService: async () => { serviceCalls++; throw Error("must remain read-only"); } });
  const profile = { id: "fixture-profile", agentId: input.agentId, backendId: "shoggoth", enabled: true };
  native._profilesByAgent.set(input.agentId, profile); native._sessionsByKey.set(sessionId, { profileId: profile.id });
  assert.equal(await native.getPluginSelectionReadiness(input), false);
  native._state = "started";
  assert.equal(await native.getPluginSelectionReadiness(input), true);
  for (const replacement of [{ ...profile, enabled: false }, { ...profile, backendId: "openclaw" }, { ...profile, agentId: "other" }]) {
    native._profilesByAgent.set(input.agentId, replacement); assert.equal(await native.getPluginSelectionReadiness(input), false);
  }
  native._profilesByAgent.set(input.agentId, profile);
  native._sessionsByKey.set(sessionId, { profileId: "other-profile" });
  assert.equal(await native.getPluginSelectionReadiness(input), false);
  native._sessionsByKey.set(sessionId, { profileId: profile.id });
  assert.equal(await native.getPluginSelectionReadiness({ ...input, ready: true }), false);
  assert.equal(serviceCalls, 0);
  checks.push("production native Backend observes only an existing started Domain/session/Profile; disabled/wrong-owner/wrong-Backend reject with zero Service/CLI/model calls");
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-selection-readiness-")); fs.chmodSync(root, 0o700);
  const externalCalls = []; let answer = true;
  const external = { async getPluginSelectionReadiness(value) { externalCalls.push(value); if (answer instanceof Error) throw answer; return answer; } };
  const registry = { backends: new Map([["shoggoth", native], ["openclaw", external]]) };
  let web;
  try {
    web = await startStaticServer(0, { homeDir: root, userDataRoot: root, registry });
    const get = async (params = query, init = {}) => {
      const res = await fetch(`${web.url}/__api/plugins/selection-readiness?${params}`, init);
      const text = await res.text(); let value; try { value = JSON.parse(text); } catch { value = text; }
      return { status: res.status, value };
    };
    assert.deepEqual(await get(), { status: 200, value: { version: 1, supported: true } });
    const extQuery = new URLSearchParams({ backend: "openclaw", agent: "main", sessionKey: "agent:main:one" });
    assert.deepEqual(await get(extQuery), { status: 200, value: { version: 1, supported: true } });
    assert.deepEqual(externalCalls[0], { agentId: "main", sessionKey: "agent:main:one" });
    for (answer of [false, "true", 1, { supported: true, token: "secret-text" }, new Error("secret-text")]) {
      assert.deepEqual(await get(extQuery), { status: 200, value: { version: 1, supported: false } });
    }
    for (const backend of ["unknown-host", "hermes"]) { const q = new URLSearchParams(extQuery); q.set("backend", backend);
      assert.deepEqual(await get(q), { status: 200, value: { version: 1, supported: false } }); }
    checks.push("real loopback HTTP delegates exact Backend input and publishes only two fields; missing/unknown Backend, nonboolean readiness and secret errors stay false");
    const count = externalCalls.length;
    assert.equal((await get(extQuery, { method: "POST", body: "{}" })).status, 405);
    assert.equal((await get(extQuery, { headers: { origin: "https://external.example" } })).status, 403);
    assert.equal((await get(extQuery, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
    for (const field of ["backend", "agent", "sessionKey", "ready", "subject", "envelope"]) {
      const bad = new URLSearchParams(extQuery); bad.append(field, "injected"); assert.equal((await get(bad)).status, 400);
    }
    const badBodyStatus = await new Promise((resolve, reject) => {
      const request = http.request(`${web.url}/__api/plugins/selection-readiness?${extQuery}`, { method: "GET", headers: { "content-length": "2" } }, response => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
      request.on("error", reject); request.end("{}");
    });
    assert.equal(badBodyStatus, 400); assert.equal(externalCalls.length, count); assert.equal(serviceCalls, 0);
    checks.push("production Origin/fetch-site gate, GET-only route, caller body and duplicate/authority query reject before Backend access");
    console.log(JSON.stringify({ passed: true, checks, serviceCalls, nativeThreadStarts: 0, modelTurns: 0,
      scope: "production HTTP/DTO + controlled native cache/external return-value boundary; not real Host readiness acceptance" }, null, 2));
  } finally { await web?.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { main };
