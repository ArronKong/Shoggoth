"use strict";
// Shared proactive helpers for real native CLI fixtures. The proactive check
// itself is an ordinary Main-session turn; its runtime-independent behaviour
// is covered by proactive-all-runtimes-unit. Nothing touches production data.
const assert = require("node:assert/strict"), path = require("node:path"), crypto = require("node:crypto");
const { createAgentService } = require("../../app/agent-service/server");
const { resolveServicePaths } = require("../../app/agent-service/paths");
const { RuntimeAdapterRegistry } = require("../../app/agent-service/runtime-adapter-registry");
const { DEFAULT_AGENT_PROFILE_ID } = require("../../app/agent-service/product-store");
const { DEFAULT_RUNTIME_ACCOUNTS } = require("../../app/agent-service/runtime-account");
const { workspaceMemoryRefs } = require("../../app/agent-service/memory-engine");

async function seedProactiveAgentContext(service, profileId, workspace, at) {
  const current = service.agentDefinitionStore.get(profileId);
  const definitions = {
    IDENTITY: "# Identity\n\nYou are the observatory's patient guide.\n",
    AGENTS: "# Operating rules\n\nPresent the observation before the interpretation.\n",
    SOUL: "# Soul\n\n" + "Use calm language when reporting an observation.\n".repeat(360)
      + "Close each actionable reminder with a gentle next step.\n",
  };
  service.agentDefinitionStore.update({ profileId, expectedRevision: current.manifest.revision,
    actor: "user", documents: definitions });
  const user = "The user prefers a brief, friendly opening in reminders.";
  const agent = "The observatory team reviews the amber telescope after dark.";
  const daily = "Today's observation found the lens cover was closed.";
  const project = "The private project uses a different telescope.";
  for (const [content, input] of [[user, { scope: "user", sensitivity: "private" }], [agent, { scope: "agent" }],
    [daily, { scope: "agent", dailyNotePath: `memory/${new Date(at).toISOString().slice(0, 10)}.md` }],
    [project, { scope: "project", sourceRefs: ["user-edit:review-fixture", ...workspaceMemoryRefs(workspace, "project")] }]]) {
    await service.memoryEngine.propose({ profileId, classification: "explicit", content, sourceRefs: ["user-edit:review-fixture"], ...input });
  }
  return { definitions, user, agent, daily, project };
}

// Real native Adapter + real Service: the readiness check a proactive check
// runs before it is admitted (authentication state and the ordinary chat API).
// It starts no model turn. Proactive checks run in Main with Main's own
// binding, so Main is bound to the tested runtime first.
async function verifyProactiveRuntimeReadiness({ root, adapter, runtime, model }) {
  const registry = new RuntimeAdapterRegistry(); registry.register(runtime, adapter);
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "service-state"),
    profileRoot: path.join(root, "service-profile"), cacheRoot: path.join(root, "service-cache") });
  const profileId = DEFAULT_AGENT_PROFILE_ID;
  const service = createAgentService({ paths, runtimeManager: registry, autoSparkNotes: false,
    // Codex is not under test. Its built-in pool would start a host that an
    // injected runtimeManager never stops, keeping the fixture alive.
    runtimePool: { get() { throw Object.assign(Error("Readiness fixtures never start Codex"), { code: "FIXTURE_CODEX_FORBIDDEN" }); },
      async stopAll() {} },
    proactiveProfileAvailable: () => true,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() },
    setCronTimer: () => 1, clearCronTimer() {}, setProactiveTimer: () => 1, clearProactiveTimer() {},
    notificationSender: async () => { throw Error("Readiness checks never notify"); } });
  try {
    await service.start();
    const products = service.productStore;
    products.addAgentRuntimeBinding(profileId, { runtime,
      runtimeAccountId: DEFAULT_RUNTIME_ACCOUNTS.find(a => a.runtime === runtime).id }, { operationId: crypto.randomUUID() });
    const binding = products.getAgentRuntimeBindings(profileId).bindings.find(b => b.runtime === runtime);
    const mainKey = service.proactiveStore.getTarget(profileId).sessionKey;
    const main = service.chatSessionStore.getSession(mainKey);
    service.chatSessionStore.switchRuntime(mainKey, { bindingId: binding.id, revision: main.revision, model });
    const { capabilities } = await service.proactiveService.handle("proactive.runtime.verify", { profileId });
    assert.equal(capabilities.semanticVerified, true, JSON.stringify(capabilities));
    assert.equal(capabilities.runtime, runtime);
    return { proactiveReadiness: true, runtime, mainBinding: true };
  } finally { await service.stop({ notify: false }); }
}
module.exports = { verifyProactiveRuntimeReadiness, seedProactiveAgentContext };
