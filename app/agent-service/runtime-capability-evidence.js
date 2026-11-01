"use strict";

const { runtimeBinding, runtimeCapabilities } = require("./runtime-adapter");
const { serviceError } = require("./security");

const EVIDENCE_VERSION = 1;
const NATIVE_RUNTIMES = new Set(["codex", "grok-build", "antigravity", "pi", "claude-code", "opencode", "deepseek-harness"]);
const OPERATIONS = Object.freeze({
  chat: Object.freeze(["session.start", "session.list", "session.read", "turn.start", "turn.interrupt", "events"]),
  resume: Object.freeze(["session.resume", "session.read"]),
  compact: Object.freeze(["context.compact.native", "commands.execute"]),
  modelOnly: Object.freeze(["model.generate.toolFree"]),
  modelResolve: Object.freeze(["model.resolve.toolFree"]),
});

// This record belongs to the trusted adapter, never to the CLI's self-reported
// permissions. Keep each observation's origin explicit, including adapter
// guarantees that cannot be established by a no-prompt handshake.
function runtimeCapabilityEvidence(raw, bindingValue, instanceId) {
  const binding = runtimeBinding(bindingValue);
  const capabilities = runtimeCapabilities(raw.capabilities);
  const host = raw.host;
  const scope = Object.freeze({ ...binding, instanceId,
    executableIdentity: host?.runtimeIdentity?.digest ?? null,
    permissionPolicy: host?.permissionPolicy ? Object.freeze({
      approvalPolicy: host.permissionPolicy.approvalPolicy, sandbox: host.permissionPolicy.sandbox,
    }) : null });
  const observations = Object.fromEntries(Object.entries(capabilities).map(([name, supported]) => [name,
    Object.freeze({ state: supported ? "supported" : "unsupported", source: "adapter-contract" })]));
  // Prepare observers are an in-process trusted-adapter contract. A signed
  // worker cannot advertise functions or attest this guarantee over JSONL.
  if (!NATIVE_RUNTIMES.has(binding.runtime)) observations["turn.start.prepare"] = Object.freeze({
    state: host?.transport === "acp" && capabilities["turn.start.prepare"]
      && typeof raw.turnStart === "function" ? "supported" : "unsupported", source: "adapter-contract",
  });
  const native = NATIVE_RUNTIMES.has(binding.runtime);
  // Product attachment support includes Shoggoth's file-path materialization;
  // it does not claim that each CLI accepts a native PDF content block.
  const attachmentKinds = native ? ["image", "pdf", "file"] : [];
  for (const kind of ["image", "pdf", "file"]) observations[`attachment.${kind}`] = Object.freeze({
    state: attachmentKinds.includes(kind) ? "supported" : "unverified", source: "adapter-contract",
  });
  // ACP explicitly negotiates native image input; text/file materialization is
  // owned by Shoggoth and is not inferred from the remote capability object.
  if (["grok-build", "antigravity"].includes(binding.runtime) && host?.agentCapabilities) {
    observations["attachment.image"] = Object.freeze({
      state: host.agentCapabilities.promptCapabilities?.image === true ? "supported" : "unsupported",
      source: "handshake",
    });
    const resume = host.agentCapabilities.sessionCapabilities?.resume;
    observations["session.resume"] = Object.freeze({
      state: capabilities["session.resume"] && ((resume && typeof resume === "object" && !Array.isArray(resume))
        || binding.runtime === "grok-build" && host.agentCapabilities.loadSession === true) ? "supported" : "unsupported",
      source: "handshake",
    });
  }
  if (host?.transport === "acp" && !native) {
    observations["session.resume"] = Object.freeze({
      state: capabilities["session.resume"] && (host.agentCapabilities?.loadSession === true
        || host.agentCapabilities?.sessionCapabilities?.resume != null
          && typeof host.agentCapabilities.sessionCapabilities.resume === "object"
          && !Array.isArray(host.agentCapabilities.sessionCapabilities.resume)) ? "supported" : "unsupported",
      source: "handshake",
    });
    // Generic ACP currently rejects every attachment even when the Agent
    // advertises native image input. Product support requires both guarantees.
    for (const kind of ["image", "pdf", "file"]) observations[`attachment.${kind}`] = Object.freeze({
      state: "unsupported", source: "adapter-contract",
    });
  }
  if (host?.protocolProbeVerified === true && binding.runtime === "pi") {
    observations["commands.list"] = Object.freeze({ state: capabilities["commands.list"] ? "supported" : "unsupported",
      source: "read-only-probe" });
  }
  if (host?.protocolFeatures && binding.runtime === "opencode") {
    observations["context.compact.native"] = Object.freeze({
      state: capabilities["context.compact.native"] && host.protocolFeatures.nativeCompact ? "supported" : "unsupported",
      source: "handshake" });
  }
  observations["permission.enforcement"] = Object.freeze({
    state: native ? "supported" : "unverified", source: host?.effectivePermissionsVerified === true
      && binding.runtime === "opencode" ? "effective-permissions" : "adapter-contract",
  });
  return Object.freeze({ version: EVIDENCE_VERSION, contractVersion: 1, scope,
    observations: Object.freeze(observations) });
}

function capabilitiesFromEvidence(evidence) {
  return runtimeCapabilities(Object.fromEntries(Object.entries(evidence.observations)
    .filter(([name]) => !name.startsWith("attachment.") && name !== "permission.enforcement")
    .map(([name, observation]) => [name, observation.state === "supported"])));
}

function runtimeOperationSupport(evidence, operation) {
  const required = OPERATIONS[operation];
  if (!required) throw serviceError("RUNTIME_CAPABILITY_UNSUPPORTED", "Runtime operation is unsupported");
  const missing = required.filter(name => evidence?.version !== EVIDENCE_VERSION
    || evidence.observations?.[name]?.state !== "supported");
  return Object.freeze({ supported: missing.length === 0, missing: Object.freeze(missing) });
}

function assertRuntimeOperation(handle, operation) {
  // Legacy injected adapters keep their existing method guards during migration.
  // Every production RuntimeHandleV1 carries the evidence record.
  if (!handle?.capabilityEvidence) return;
  if (!runtimeOperationSupport(handle.capabilityEvidence, operation).supported) {
    throw serviceError("RUNTIME_CAPABILITY_UNSUPPORTED", "Runtime lacks a required operation capability");
  }
}

function assertRuntimeAttachments(handle, attachments = []) {
  if (!handle?.capabilityEvidence || !Array.isArray(attachments)) return;
  for (const attachment of attachments) {
    const kind = attachment.mimeType?.startsWith("image/") ? "image"
      : attachment.mimeType === "application/pdf" ? "pdf" : "file";
    if (handle.capabilityEvidence.observations[`attachment.${kind}`]?.state !== "supported") {
      throw serviceError("RUNTIME_ATTACHMENT_UNSUPPORTED", "Runtime lacks the required attachment capability");
    }
  }
}

// Deliberately excludes identity, paths, account data and diagnostic text.
function runtimeFeatureSupport(evidence) {
  const state = name => evidence?.version === EVIDENCE_VERSION
    ? evidence.observations[name]?.state ?? "unverified" : "unverified";
  return { attachments: ["image", "pdf", "file"].filter(kind => state(`attachment.${kind}`) === "supported"),
    resume: state("session.resume"), compact: state("context.compact.native"), steer: state("turn.steer") };
}

module.exports = { EVIDENCE_VERSION, runtimeCapabilityEvidence, capabilitiesFromEvidence,
  runtimeOperationSupport, assertRuntimeOperation, assertRuntimeAttachments, runtimeFeatureSupport };
