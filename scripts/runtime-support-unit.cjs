"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { supports, createRuntimeSupportFacts } = require("../app/agent-service/runtime-support");
const binding = { id: "binding", revision: 1, runtime: "codex", runtimeProfileId: "runtime",
  runtimeAccountId: "account", enabled: true };
const requirements = { model: "known", permissionMode: "read-only",
  permissionPolicy: { approvalPolicy: "on-request", sandbox: "read-only" }, workspace: null };
const facts = { releaseEnabled: true, installed: true, authenticated: true, models: ["known"],
  attachmentKinds: ["image", "file"], permissionEnforcementProven: true, generation: 1 };

test("supports distinguishes unavailable facts and never substitutes a runtime or model", () => {
  assert.deepEqual(supports({ binding, facts, requirements }), { supported: true });
  for (const [patch, code] of [
    [{ releaseEnabled: false }, "RUNTIME_RELEASE_DISABLED"], [{ installed: false }, "RUNTIME_NOT_INSTALLED"],
    [{ installed: "unknown" }, "RUNTIME_FACTS_UNKNOWN"], [{ authenticated: false }, "ACCOUNT_NOT_AUTHENTICATED"],
    [{ authenticated: "unknown" }, "ACCOUNT_AUTH_UNKNOWN"], [{ models: [] }, "MODEL_ROUTE_UNSUPPORTED"],
    [{ permissionEnforcementProven: false }, "PERMISSION_ENFORCEMENT_UNPROVEN"],
  ]) assert.deepEqual(supports({ binding, facts: { ...facts, ...patch }, requirements }), { supported: false, code });
  assert.equal(supports({ binding, facts, requirements: { ...requirements, attachmentKinds: ["video"] } }).code,
    "ATTACHMENT_UNSUPPORTED");
  assert.equal(supports({ binding: { ...binding, runtime: "deepseek-harness" }, facts, requirements }).code,
    "PERMISSION_ENFORCEMENT_UNPROVEN");
});

test("a present but unproven credential stays selectable like the execution gate", async () => {
  assert.deepEqual(supports({ binding, facts: { ...facts, authenticated: "unverified" }, requirements }),
    { supported: true });
  const profile = { permissionPolicy: requirements.permissionPolicy };
  const host = { authenticationState: async () => ({ authenticated: false, credentialPresent: true }),
    modelsList: async () => ({ data: [{ model: "known" }], nextCursor: null }) };
  const unverified = await createRuntimeSupportFacts({ runtimeManager: { acquire: async () => host } })
    .read(binding, profile);
  assert.equal(unverified.authenticated, "unverified");
  assert.deepEqual(supports({ binding, facts: unverified, requirements }), { supported: true });
  const signedOut = await createRuntimeSupportFacts({ runtimeManager: { acquire: async () => ({ ...host,
    authenticationState: async () => ({ authenticated: false, credentialPresent: false }) }) } })
    .read(binding, profile);
  assert.equal(supports({ binding, facts: signedOut, requirements }).code, "ACCOUNT_NOT_AUTHENTICATED");
});

test("fact discovery shares pending work, is bounded, and account generation invalidates cache", async () => {
  let generation = 1, calls = 0, finish;
  const cache = createRuntimeSupportFacts({ timeoutMs: 10, maxPending: 1,
    runtimeAccountAdmission: { read: () => ({ generation }) },
    discover: async () => { calls++; await new Promise(resolve => { finish = resolve; }); return facts; } });
  const profile = { permissionPolicy: requirements.permissionPolicy };
  const first = cache.read(binding, profile);
  const second = cache.read(binding, profile);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal((await cache.read({ ...binding, id: "other" }, profile)).installed, "unknown");
  assert.equal(calls, 1);
  assert.equal((await first).authenticated, "unknown");
  assert.equal((await second).authenticated, "unknown");
  finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await cache.read(binding, profile)).authenticated, true);
  generation++;
  const changed = cache.read(binding, profile);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2); finish(); await changed;
});

test("disabled bindings do not start discovery", async () => {
  const cache = createRuntimeSupportFacts({ discover: () => { throw new Error("must not acquire"); } });
  const result = await cache.read({ ...binding, enabled: false }, {});
  assert.deepEqual(supports({ binding: { ...binding, enabled: false }, facts: result, requirements }),
    { supported: false, code: "BINDING_DISABLED" });
});
