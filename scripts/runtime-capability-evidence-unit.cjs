"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { runtimeCapabilities } = require("../app/agent-service/runtime-adapter");
const { runtimeCapabilityEvidence, capabilitiesFromEvidence, runtimeOperationSupport, assertRuntimeOperation, assertRuntimeAttachments }
  = require("../app/agent-service/runtime-capability-evidence");
const { supports } = require("../app/agent-service/runtime-support");

const binding = { runtime: "grok-build", runtimeProfileId: "profile", runtimeAccountId: "account" };
const capabilities = runtimeCapabilities({ "session.start": true, "session.list": true, "session.read": true,
  "session.resume": true, "turn.start": true, "turn.interrupt": true, events: true });
const policy = { approvalPolicy: "on-request", sandbox: "danger-full-access" };
const raw = (image = false) => ({ capabilities, host: { permissionPolicy: policy,
  agentCapabilities: { promptCapabilities: { image }, sessionCapabilities: { resume: {} }, permissionEnforcementProven: true },
  runtimeIdentity: { digest: "instance-digest" } } });

test("capability booleans derive from scoped immutable adapter evidence", () => {
  const evidence = runtimeCapabilityEvidence(raw(), binding, "process-1");
  assert.deepEqual(capabilitiesFromEvidence(evidence), capabilities);
  assert.deepEqual(evidence.scope, { ...binding, instanceId: "process-1", executableIdentity: "instance-digest", permissionPolicy: policy });
  assert.equal(evidence.observations["turn.start"].source, "adapter-contract");
  assert.equal(evidence.observations["permission.enforcement"].source, "adapter-contract");
  assert.equal(Object.isFrozen(evidence.observations["turn.start"]), true);
  assert.equal(Object.isFrozen(evidence.scope.permissionPolicy), true);
});

test("missing optional ACP images does not disable text execution", () => {
  const evidence = runtimeCapabilityEvidence(raw(false), binding, "process-1");
  assert.deepEqual(evidence.observations["attachment.image"], { state: "unsupported", source: "handshake" });
  assert.equal(runtimeOperationSupport(evidence, "chat").supported, true);
  assert.equal(runtimeOperationSupport(evidence, "compact").supported, false);
  assert.throws(() => assertRuntimeAttachments({ capabilityEvidence: evidence }, [{ mimeType: "image/png" }]),
    { code: "RUNTIME_ATTACHMENT_UNSUPPORTED" });
  assert.doesNotThrow(() => assertRuntimeAttachments({ capabilityEvidence: evidence }, [{ mimeType: "application/pdf" }]));
  const facts = { installed: true, authenticated: "unverified", permissionEnforcementProven: true,
    models: [], attachmentKinds: ["file", "pdf"], capabilityEvidence: evidence };
  const input = { binding: { ...binding, enabled: true }, facts,
    requirements: { workspace: "/tmp/fixture", permissionPolicy: policy } };
  assert.deepEqual(supports(input), { supported: true });
  assert.deepEqual(supports({ ...input, requirements: { ...input.requirements, attachmentKinds: ["image"] } }),
    { supported: false, code: "ATTACHMENT_UNSUPPORTED" });
});

test("a remote permission declaration never establishes the adapter permission guarantee", () => {
  const evidence = runtimeCapabilityEvidence(raw(true), { ...binding, runtime: "ext-fixture" }, "external-1");
  assert.deepEqual(evidence.observations["permission.enforcement"], { state: "unverified", source: "adapter-contract" });
});

test("OpenCode PDF materialization is the same product capability for selection, UI and dispatch", () => {
  const target = { ...binding, runtime: "opencode", enabled: true };
  const evidence = runtimeCapabilityEvidence(raw(), { ...binding, runtime: target.runtime }, "opencode");
  const { runtimeFeatureSupport } = require("../app/agent-service/runtime-capability-evidence");
  const features = runtimeFeatureSupport(evidence);
  assert.ok(features.attachments.includes("pdf"));
  assert.deepEqual(supports({ binding: target,
    facts: { installed: true, authenticated: true, permissionEnforcementProven: true,
      capabilityEvidence: evidence, attachmentKinds: features.attachments },
    requirements: { permissionPolicy: policy, workspace: "/tmp", attachmentKinds: ["pdf"] } }), { supported: true });
  assert.doesNotThrow(() => assertRuntimeAttachments({ capabilityEvidence: evidence }, [{ mimeType: "application/pdf" }]));
  const restricted = { ...evidence, observations: { ...evidence.observations, "attachment.pdf": { state: "unsupported" } } };
  assert.throws(() => assertRuntimeAttachments({ capabilityEvidence: restricted }, [{ mimeType: "application/pdf" }]),
    { code: "RUNTIME_ATTACHMENT_UNSUPPORTED" });
});

test("required operation capabilities fail before execution while optional capabilities remain separate", () => {
  const evidence = runtimeCapabilityEvidence({ ...raw(), capabilities: { ...capabilities, "turn.interrupt": false } }, binding, "process-1");
  assert.deepEqual(runtimeOperationSupport(evidence, "chat"), { supported: false, missing: ["turn.interrupt"] });
  assert.throws(() => assertRuntimeOperation({ capabilityEvidence: evidence }, "chat"), { code: "RUNTIME_CAPABILITY_UNSUPPORTED" });
  assert.equal(runtimeOperationSupport(evidence, "resume").supported, true);
  assert.throws(() => runtimeCapabilityEvidence({ capabilities: { unknown: true } }, binding, "process-1"),
    { code: "RUNTIME_CAPABILITIES_INVALID" });
});

test("missing resume does not disable new chat or history, and policy proofs cannot cross modes", () => {
  const target = raw(); target.host.agentCapabilities.sessionCapabilities = {};
  const evidence = runtimeCapabilityEvidence(target, binding, "process-1");
  assert.equal(runtimeOperationSupport(evidence, "chat").supported, true);
  assert.equal(capabilitiesFromEvidence(evidence)["session.read"], true);
  assert.equal(runtimeOperationSupport(evidence, "resume").supported, false);
  assert.equal(evidence.observations["session.resume"].source, "handshake");
  const result = supports({ binding: { ...binding, enabled: true },
    facts: { installed: true, authenticated: true, permissionEnforcementProven: true, capabilityEvidence: evidence },
    requirements: { permissionPolicy: { approvalPolicy: "never", sandbox: "danger-full-access" }, workspace: "/tmp" } });
  assert.equal(result.code, "PERMISSION_ENFORCEMENT_UNPROVEN");
});

test("V1 fences unsupported attachments and compaction before any native dispatch", async () => {
  const { runtimeHandleV1 } = require("../app/agent-service/runtime-handle-v1");
  let sends = 0, commands = 0;
  const handle = runtimeHandleV1({ ...binding, ...raw(false),
    capabilities: { "turn.start": true, "commands.execute": true },
    terminated: new Promise(() => {}), subscribe: () => () => {},
    turnStart: async () => { sends++; return { turn: { id: "turn" } }; },
    commandExecute: async () => { commands++; throw Error("Unsupported command reached native Runtime"); },
  }, binding);
  await assert.rejects(handle.turnStart({ attachments: [{ mimeType: "image/png" }] }), { code: "RUNTIME_ATTACHMENT_UNSUPPORTED" });
  await assert.rejects(handle.commandExecute({ text: "/compact" }), { code: "RUNTIME_CAPABILITY_UNSUPPORTED" });
  assert.equal(sends, 0); assert.equal(commands, 0);
  await handle.turnStart({ attachments: [], prompt: "text remains usable" });
  assert.equal(sends, 1);
});
