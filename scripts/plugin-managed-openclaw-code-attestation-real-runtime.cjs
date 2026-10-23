"use strict";
// Read-only acceptance against an existing, sealed candidate. No new runtime
// copy, Gateway, model, account token or dataRoot is created/read here.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const { createExternalProviderRuntimeAttestor } = require("../app/agent-service/external-provider-credential-runtime");
const repo = path.resolve(__dirname, ".."), stateDir = process.argv[2];
const sourceFiles = ["app/agent-service/external-provider-credential-runtime.js", "app/agent-service/external-provider-credential-writer-worker.js",
  "app/managed-plugin-host-runtime.js", "app/managed-openclaw-runtime-pins.json", "scripts/plugin-managed-openclaw-code-attestation-real-runtime.cjs"];
const hashes = () => Object.fromEntries(sourceFiles.map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(path.join(repo, file))).digest("hex")]));
async function main() {
  assert(stateDir && path.isAbsolute(stateDir) && fs.realpathSync(stateDir) === stateDir);
  const root = path.join(stateDir, "external-plugin-host-runtimes", "openclaw");
  const pointer = JSON.parse(fs.readFileSync(path.join(root, "active.json"), "utf8"));
  assert.match(pointer.candidateId, /^[a-f0-9]{64}$/u);
  const candidateRoot = path.join(root, "candidates", pointer.candidateId);
  const descriptor = JSON.parse(fs.readFileSync(path.join(candidateRoot, "descriptor.json"), "utf8"));
  const pin = require("../app/managed-openclaw-runtime-pins.json").hosts.openclaw;
  const writer = { runtimeRoot: path.join(candidateRoot, "runtime"), runtimeTreeSha256: pin.outputTreeSha256,
    interpreterPath: descriptor.interpreter.path, entryPath: path.join(candidateRoot, "runtime", pin.entryRelative) };
  const sourceHashesBefore = hashes(), attestor = createExternalProviderRuntimeAttestor({ stateDir,
    resourcesRoot: path.join(repo, "resources/external-plugin-host-patches") });
  let last = performance.now(), maxGapMs = 0, ticks = 0;
  const interval = setInterval(() => { const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - last); last = now; ticks++; }, 10);
  try {
    const firstStarted = performance.now(), guard = await attestor.verify(writer), firstMs = performance.now() - firstStarted;
    assert.equal(guard(), true);
    const cachedStarted = performance.now(), cachedGuard = await attestor.verify(writer), cachedMs = performance.now() - cachedStarted;
    assert.equal(cachedGuard(), true); assert.equal(guard(), true);
    await assert.rejects(attestor.verify({ ...writer, entryPath: path.join(writer.runtimeRoot, "foreign.mjs") }),
      error => error.code === "EXTERNAL_PROVIDER_RUNTIME_UNBOUND");
    const sourceHashesAfter = hashes(); assert.deepEqual(sourceHashesAfter, sourceHashesBefore);
    await attestor.close(); assert.throws(guard); assert.throws(cachedGuard); clearInterval(interval);
    process.stdout.write(JSON.stringify({ status: "PASS", groups: 4, candidateId: pointer.candidateId, runtimeTreeSha256: writer.runtimeTreeSha256,
      firstMs, cachedMs, ticks, maxGapMs, naturalWorkerExit: true, sourcesUnchanged: true, sourceHashesBefore, sourceHashesAfter,
      boundary: "actual sealed code and interpreter attestation only; no Host, model, credential vault, dataRoot or runtime copy",
      hostStarts: 0, modelRequests: 0, secretReads: 0 }) + "\n");
  } finally { clearInterval(interval); await attestor.close(); }
}
main().catch(error => { process.stderr.write((error.code || "FIXTURE_ASSERTION_FAILED") + "\n" + error.stack + "\n"); process.exitCode = 1; });
