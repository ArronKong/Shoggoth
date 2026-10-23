"use strict";
const assert = require("node:assert/strict");
const { projectCodexSecurityServiceStatus: project, validateCodexSecurityPublicStatus: publicStatus,
  validateCodexSecurityStatusInput: input } = require("../app/core/plugin-codex-security-status-dto");
const evidence = require("../docs/architecture/codex-security-service-wiring-evidence-2026-09-28.json");
const raw = evidence.accountProjection;
const request = { installationId: raw.installation.installationId, runtimeProfileId: raw.candidate.runtimeProfileId };
let groups = 0;
const test = (name, fn) => { fn(); groups += 1; console.log(`PASS ${name}`); };
const poisoned = change => { const value = structuredClone(raw); change(value); assert.throws(() => project(value, request), TypeError); };
test("real Service response projects exact bounded status and strips account/binding IDs", () => {
  const value = project(raw, request), encoded = JSON.stringify(value);
  assert.equal(value.authentication, "unauthenticated"); assert.equal(value.installation.integrity, "verified");
  assert.equal(value.installation.skillCount, 15); assert.equal(value.installation.mcpCount, 0);
  assert.equal(value.fullPluginUsable, false); assert.equal(value.originalToolsUnlocked, false);
  for (const id of [raw.candidate.runtimeAccountId, raw.candidate.runtimeProfileId, raw.candidate.profileId, raw.installation.installationId]) assert(!encoded.includes(id));
  assert(Object.isFrozen(value) && Object.isFrozen(value.installation) && Object.isFrozen(value.blockers));
});
test("IPC/App input accepts only IDs; no Run/lease/native/readiness injection, prototypes or accessors", () => {
  assert.deepEqual(input({ installationId: null, agentId: null }), { installationId: null, agentId: null });
  for (const field of ["lease", "runId", "runtimeProfileId", "ready", "nativeMeta", "token"]) assert.throws(() => input({ installationId: null, agentId: null, [field]: true }), TypeError);
  for (const agentId of [1, "x\n", "x".repeat(129), "x\u202e", {}, []]) assert.throws(() => input({ installationId: null, agentId }), TypeError);
  let reads = 0; const access = { installationId: null }; Object.defineProperty(access, "agentId", { enumerable: true, get() { reads += 1; return null; } });
  assert.throws(() => input(access), TypeError); assert.equal(reads, 0);
  assert.throws(() => input(Object.assign(Object.create({}), { installationId: null, agentId: null })), TypeError);
});
test("raw/public extra secret, account, Run and opaque fields fail closed", () => {
  for (const field of ["token", "credentials", "owningAgent", "lifecycleAdmission", "account"]) poisoned(value => { value[field] = "do-not-forward"; });
  const valid = project(raw, request);
  for (const field of ["candidate", "account", "run", "lease", "token"]) assert.throws(() => publicStatus({ ...valid, [field]: "do-not-forward" }), TypeError);
});
test("no raw readiness, tools or scan proof accepted", () => {
  for (const field of ["owningRunQualified", "lifecycleReady", "fullPluginUsable", "modelTurnStarted", "scanStarted", "originalToolsUnlocked"]) poisoned(value => { value[field] = true; });
  poisoned(value => { value.qualificationScope = "owning-run"; });
  for (const field of ["fullPluginUsable", "originalToolsUnlocked"]) assert.throws(() => publicStatus({ ...project(raw, request), [field]: true }), TypeError);
});
test("candidate must match original request and actual managed Codex identity", () => {
  poisoned(value => { value.candidate.runtimeProfileId = "another-profile"; });
  poisoned(value => { value.candidate.runtimeAccountKind = "native"; });
  poisoned(value => { value.candidate.accountGeneration = 0; });
  poisoned(value => { value.candidate = null; });
  poisoned(value => { value.candidate.principal = "secret@example.com"; });
  poisoned(value => { value.authentication.status = "unobserved"; });
});
test("installation/converted components/digests are exact and bounded", () => {
  poisoned(value => { value.installation.installationId = "another-installation"; });
  poisoned(value => { value.bundle.sourceDigest = "bad"; });
  poisoned(value => { value.bundle.fileCount = 100_001; });
  poisoned(value => { value.bundle.converted.mcp = 2; });
  poisoned(value => { value.installedComponents = null; });
  poisoned(value => { value.installedComponents.mcpServerNames = ["codex-security"]; });
  poisoned(value => { value.bundle.unconvertedMcp = Array(65).fill(value.bundle.unconvertedMcp[0]); });
});
test("mandatory blockers retained and contradictions/unknown/duplicate blockers refused", () => {
  poisoned(value => { value.fullPluginBlockers = value.fullPluginBlockers.filter(code => code !== "ORIGINAL_MCP_NOT_CONVERTED"); });
  poisoned(value => { value.fullPluginBlockers = value.fullPluginBlockers.filter(code => code !== "REDISTRIBUTION_APPROVAL_PENDING"); });
  poisoned(value => { value.fullPluginBlockers.push("FAKE_READY"); });
  poisoned(value => { value.fullPluginBlockers.push(value.fullPluginBlockers[0]); });
  poisoned(value => { value.authentication.source = "untrusted injected account"; });
  const valid = project(raw, request); assert.throws(() => publicStatus({ ...valid, connections: { total: 0, ready: 1 } }), TypeError);
  assert.throws(() => publicStatus({ ...valid, installation: { ...valid.installation, integrity: "not-installed" } }), TypeError);
});
test("no-candidate observation and disabled installation remain distinct", () => {
  const value = evidence.fixedInstalledProjection;
  assert.equal(project(value, { installationId: value.installation.installationId, runtimeProfileId: null }).authentication, "unobserved");
  const disabled = evidence.restartProjection;
  assert.equal(project(disabled, { installationId: disabled.installation.installationId, runtimeProfileId: null }).installation.state, "disabled");
});
test("fixed native artifact metadata projects one installed MCP without account/turn/scan permission", () => {
  const value = structuredClone(raw);
  value.installedComponents.mcpServerNames = ["codex-security"];
  value.installedComponents.nativeComponent = { transport: "shoggoth-codex-security-native",
    descriptorDigest: "b7bc2a19d4d2f073c453c0b311f593285f298073bad4307a551993754705109b",
    sourceDigest: "8d32d2544f37f8cc8f43df98216b2a505e6f71d9628c555086039daf1062e9fb", originalFileCount: 124 };
  const projected = project(value, request);
  assert.equal(projected.installation.mcpCount, 1);
  assert.equal(projected.fullPluginUsable, false);
  assert(projected.blockers.includes("ORIGINAL_MCP_NOT_CONVERTED"));
  for (const field of ["transport", "descriptorDigest", "sourceDigest", "originalFileCount"]) {
    const bad = structuredClone(value); bad.installedComponents.nativeComponent[field] = "forged";
    assert.throws(() => project(bad, request), TypeError);
  }
  const bad = structuredClone(value); bad.installedComponents.mcpServerNames = ["another-server"];
  assert.throws(() => project(bad, request), TypeError);
});
console.log(`${groups} Codex Security status DTO groups passed`);
