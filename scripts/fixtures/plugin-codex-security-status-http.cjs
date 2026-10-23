"use strict";

// Reuse the actual Service/empty-HOME Runtime from the wiring fixture. This
// module exercises production Backend/HTTP projection, never a scanner Host.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { DEFAULT_RUNTIME_ACCOUNTS } = require("../../app/agent-service/runtime-account");
const { ShoggothBackend } = require("../../app/core/shoggoth-backend");
const { requestService } = require("../../app/agent-service/client");
const { startStaticServer } = require("../../app/static-server");

module.exports = async function verifyStatusHttp({ service, paths, root, installation, profile, nativeMethods }) {
  const calls = [], checks = [];
  const backend = new ShoggothBackend({ paths, requestService(servicePaths, envelope, options) {
    calls.push({ method: envelope.method, params: structuredClone(envelope.params), timeoutMs: options.timeoutMs });
    return requestService(servicePaths, envelope, options);
  } });
  // Production's cache normally comes from profile.list. Seed only the genuine
  // ProductStore projection to avoid starting all fixture Agent accounts.
  const currentProfile = service.productStore.getAgentProfile(profile.id);
  backend._profilesByAgent.set(currentProfile.agentId, currentProfile);
  const registry = { backends: new Map([["shoggoth", backend]]) };
  let web;
  try {
    web = await startStaticServer(0, { homeDir: root, userDataRoot: root, registry });
    const route = "/__api/plugins/codex-security-status";
    const input = { installationId: installation.installationId, agentId: currentProfile.agentId };
    const send = async (body = input, { origin = web.url, method = "POST", path = route } = {}) => {
      const response = await fetch(`${web.url}${path}`, { method,
        headers: { ...(origin === null ? {} : { origin }), "content-type": "application/json" },
        ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
      const raw = await response.text();
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = raw; }
      return { status: response.status, body: parsed };
    };
    const startNative = nativeMethods.length;
    assert.equal((await send(input, { origin: null })).status, 403);
    assert.equal((await send(input, { origin: "https://external.example" })).status, 403);
    assert.equal((await send(input, { method: "GET" })).status, 405);
    for (const field of ["runtimeProfileId", "runId", "lease", "nativeMeta", "ready", "token"]) {
      assert.equal((await send({ ...input, [field]: "caller-injected" })).status, 400);
    }
    assert.equal(calls.length, 0); assert.equal(nativeMethods.length, startNative);
    checks.push("production HTTP requires browser loopback Origin and exact status-only input; injected authority/credentials cause zero Service/native calls");

    const installed = await send();
    assert.equal(installed.status, 200);
    assert.equal(installed.body.authentication, "unauthenticated");
    assert.equal(installed.body.installation.state, "enabled");
    assert.equal(installed.body.installation.integrity, "verified");
    assert.equal(installed.body.installation.skillCount, 15); assert.equal(installed.body.installation.mcpCount, 1);
    assert.equal(installed.body.fullPluginUsable, false); assert.equal(installed.body.originalToolsUnlocked, false);
    const actualBindings = service.productStore.getAgentRuntimeBindings(profile.id);
    const selectedBinding = actualBindings.bindings.find(binding => binding.id === actualBindings.defaultBindingId);
    assert.deepEqual(calls[0], { method: "agent.binding.list", params: { profileId: profile.id }, timeoutMs: 5_000 });
    assert.deepEqual(calls[1], { method: "plugins.codex-security.status",
      params: { installationId: installation.installationId, runtimeProfileId: selectedBinding.runtimeProfileId }, timeoutMs: 20_000 });
    const encoded = JSON.stringify(installed.body);
    for (const identity of [currentProfile.id, currentProfile.agentId, currentProfile.runtimeAccountId,
      selectedBinding.runtimeProfileId, installation.installationId]) assert(!encoded.includes(identity));
    assert.deepEqual(Object.keys(installed.body).sort(), ["version", "packageId", "source", "installation", "authentication",
      "connections", "fullPluginUsable", "originalToolsUnlocked", "blockers"].sort());
    checks.push("actual installer -> private-token Service socket -> production Backend -> HTTP returns verified 15 Skills/one native component, real empty-HOME account/read, and no internal IDs");

    const beforeMetadata = nativeMethods.length;
    const metadata = await send({ ...input, agentId: null });
    assert.equal(metadata.status, 200); assert.equal(metadata.body.authentication, "unobserved");
    assert.equal(nativeMethods.length, beforeMetadata);
    for (const runtime of ["pi", "codex"]) {
      const account = DEFAULT_RUNTIME_ACCOUNTS.find(item => item.runtime === runtime && item.kind === "native-user");
      const candidate = service.productStore.putAgentProfile({ ...currentProfile, id: crypto.randomUUID(),
        agentId: `fixture-readonly-native-${runtime}`, name: `Read-only ${runtime} candidate`, isDefault: false,
        runtime, runtimeProfileId: `fixture-readonly-native-${runtime}`, runtimeAccountId: account.id });
      backend._profilesByAgent.set(candidate.agentId, candidate);
      const noCandidate = await send({ ...input, agentId: candidate.agentId });
      assert.equal(noCandidate.status, 200); assert.equal(noCandidate.body.authentication, "unobserved");
      assert.equal(calls.at(-1).params.runtimeProfileId, null); assert.equal(nativeMethods.length, beforeMetadata);
    }
    const disabled = service.productStore.putAgentProfile({ ...currentProfile, enabled: false });
    backend._profilesByAgent.set(currentProfile.agentId, disabled);
    const beforeDisabled = calls.length;
    assert.equal((await send()).status, 503); assert.equal(calls.length, beforeDisabled);
    const restored = service.productStore.putAgentProfile({ ...currentProfile, enabled: true });
    backend._profilesByAgent.set(currentProfile.agentId, restored);
    checks.push("genuine non-Codex/native-user Codex bindings stay unobserved without native account access or CLI binding sync; disabled actual Agent cannot submit a candidate");

    const original = backend.getCodexSecurityStatus;
    try {
      for (const extra of [{ token: "do-not-forward" }, { candidate: "do-not-forward" }, { fullPluginUsable: true }]) {
        backend.getCodexSecurityStatus = async () => ({ ...installed.body, ...extra });
        const rejected = await send();
        assert.equal(rejected.status, 503); assert(!JSON.stringify(rejected.body).includes("do-not-forward"));
      }
      backend.getCodexSecurityStatus = async () => { throw new Error("do-not-forward-secret"); };
      const rejected = await send();
      assert.equal(rejected.status, 503); assert(!JSON.stringify(rejected.body).includes("do-not-forward-secret"));
    } finally { backend.getCodexSecurityStatus = original; }
    registry.backends.delete("shoggoth");
    try { assert.equal((await send()).status, 503); }
    finally { registry.backends.set("shoggoth", backend); }
    assert.equal((await send({}, { path: "/__api/plugins/codex-security-scan" })).status, 404);
    checks.push("unavailable/disabled Backend, invalid public DTO, and raw error fail closed without leaking secret text; no scan route exists");
    assert(nativeMethods.slice(startNative).every(method => method === "account/read"));
    return { passed: true, checks, installedProjection: installed.body, metadataProjection: metadata.body,
      backendCandidateSource: "actual ProductStore profile projection seeded into production profile.list cache; no Backend start",
      transport: "production loopback HTTP Origin restriction -> production Backend -> Service private-token socket",
      serviceCalls: calls.length, accountReads: nativeMethods.length - startNative,
      nativeThreadStarts: 0, nativeModelTurns: 0, scans: 0, originalToolsUnlocked: false, fullPluginUsable: false };
  } finally { await web?.close(); }
};
