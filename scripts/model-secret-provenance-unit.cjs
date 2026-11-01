"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { TemporarySecretStore } = require("../app/agent-service/temporary-secret-store");
const { ModelSecretProjection } = require("../app/agent-service/model-secret-projection");
const { ModelSecretProvenance } = require("../app/agent-service/model-secret-provenance");
const SCOPE = { profileId: "fixture", sessionId: "fixture" };
test("opaque proof is scoped, integrity protected and survives a full vault restart", async () => {
  const root = fs.mkdtempSync("/private/tmp/sg-provenance-"), paths = { stateDir: path.join(root, "state"), trustedRoot: root };
  const secrets = await new TemporarySecretStore({ paths, cryptoBroker: {
    encrypt: async bytes => Buffer.from(bytes).reverse(), decrypt: async bytes => Buffer.from(bytes).reverse() } }).open();
  try {
    const proof = new ModelSecretProvenance({ paths, secrets }), projection = new ModelSecretProjection({ secrets });
    const reasoning = { type: "reasoning", encrypted_content: "opaque-synthetic-only", summary: [{ type: "summary_text", text: "Public summary" }] };
    await assert.rejects(projection.project(SCOPE, { input: [reasoning] }, { isTrustedOpaque: await proof.verifier(SCOPE) }),
      { code: "SECRET_MODEL_SIGNED_CONTEXT_UNSAFE" });
    proof.record(SCOPE, reasoning);
    assert(!fs.readFileSync(proof.file(SCOPE), "utf8").includes("opaque-synthetic-only"));
    await secrets.close(); await secrets.open();
    const restored = new ModelSecretProvenance({ paths, secrets });
    assert.deepEqual(await projection.project(SCOPE, { input: [reasoning] }, { isTrustedOpaque: await restored.verifier(SCOPE) }), { input: [reasoning] });
    assert.equal((await restored.verifier({ ...SCOPE, sessionId: "other" }))("encrypted_content", reasoning.encrypted_content), false);
    const file = proof.file(SCOPE), row = JSON.parse(fs.readFileSync(file)); row.entries.push("0".repeat(64)); fs.writeFileSync(file, JSON.stringify(row));
    await assert.rejects(restored.verifier(SCOPE), { code: "SECRET_MODEL_PROVENANCE_UNAVAILABLE" });
  } finally { await secrets.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test("proof does not authorize newly sensitive visible text inside a signed block", async () => {
  const projection = new ModelSecretProjection({ secrets: { project: async (_scope, text) => text.replace("sensitive", "[redacted]") } });
  await assert.rejects(projection.project(SCOPE, { input: [{ type: "reasoning", encrypted_content: "proven",
    summary: [{ type: "summary_text", text: "sensitive" }] }] }, { isTrustedOpaque: () => true }),
    { code: "SECRET_MODEL_SIGNED_CONTEXT_UNSAFE" });
});
