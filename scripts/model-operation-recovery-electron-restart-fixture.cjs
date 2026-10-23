#!/usr/bin/env node
"use strict";

// Two real, sequential Electron Main processes. This is not a ui-entry/React
// App restart, model execution, credential test or global Host startup.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const moduleRoot = path.resolve(option("module-root") || path.join(__dirname, "../app"));
const driver = path.resolve(option("driver") || path.join(__dirname, "fixtures/model-operation-recovery-restart-electron-driver.cjs"));
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const sourceFiles = Object.freeze([
  "model-operation-recovery-store.js", "desktop-model-operation-recovery-ipc.js", "preload.js",
  "core/model-change-coordinator.js", "core/model-change-journal.js", "core/model-change-validation.js",
  "core/model-validation.js", "agent-service/private-file.js", "agent-service/security.js", "ui-entry.js",
]);
const codeHashes = () => Object.fromEntries(sourceFiles.map(file => [file, sha(fs.readFileSync(path.join(moduleRoot, file)))]));

function run() {
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-model-recovery-restart-"));
  fs.chmodSync(root, 0o700);
  const output = path.resolve(option("output") || `/private/tmp/model-operation-recovery-electron-restart-${process.pid}-${Date.now()}.json`);
  assert.equal(fs.existsSync(output), false, "evidence is append-only; select a new output filename");
  const before = codeHashes(), fixtureHashes = { runner: sha(fs.readFileSync(__filename)), driver: sha(fs.readFileSync(driver)) };
  const electron = require(path.join(moduleRoot, "../node_modules/electron"));
  const results = [];
  let complete = false, failure;
  try {
    for (const generation of [0, 1]) {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const result = spawnSync(electron, [driver, `--fixture-root=${root}`, `--module-root=${moduleRoot}`, `--generation=${generation}`], {
        env, encoding: "utf8", timeout: 55_000, maxBuffer: 2 * 1024 * 1024,
      });
      results.push({ generation, exitCode: result.status, signal: result.signal,
        errorCode: result.error?.code || null, stdout: result.stdout || "", stderr: result.stderr || "" });
      assert.equal(result.error, undefined, `Electron ${generation} failed: ${result.error?.code}`);
      assert.equal(result.signal, null, `Electron ${generation} must exit naturally, not ${result.signal}`);
      assert.equal(result.status, 0, `Electron ${generation} exited ${result.status}: ${result.stderr}`);
      assert.match(result.stdout, /MODEL_OPERATION_RECOVERY_RESTART_PROCESS_OK/u);
      const report = JSON.parse(fs.readFileSync(path.join(root, `generation-${generation}.json`), "utf8"));
      assert.equal(report.completed, true);
      assert.equal(report.generation, generation);
      assert.equal(report.backendCalls.length, 0);
      assert.equal(report.coordinatorReady, false);
      results[generation].report = report;
    }
    const [first, second] = results.map(value => value.report);
    assert.notEqual(first.pid, second.pid, "two distinct Main processes required");
    assert.equal(first.userData, second.userData);
    assert.equal(first.sessionData, second.sessionData);
    assert.notEqual(first.origin, second.origin);
    assert.equal(first.retainedFile.sha256, second.reopenedFile.sha256);
    assert.equal(second.newOriginStorage.length, 0);
    assert.equal(second.newOriginStorage.oldIdentity, null);
    assert.deepEqual(second.reopened.value.operations, [first.retained.value.operation]);
    assert.deepEqual(second.nonTerminal.after, second.reopened.value);
    assert.equal(second.ack.value.outcome, "compensated");
    assert.deepEqual(second.ackAgain, second.ack);
    assert.equal(second.finalRead.value.operations.length, 0);
    assert.deepEqual(codeHashes(), before, "production source changed during proof");
    assert.equal(sha(fs.readFileSync(__filename)), fixtureHashes.runner);
    assert.equal(sha(fs.readFileSync(driver)), fixtureHashes.driver);
    complete = true;
  } catch (error) { failure = error; }
  const after = codeHashes();
  // Only this exact mkdtemp root is removed, after both actual child exits.
  if (complete) fs.rmSync(root, { recursive: true, force: true });
  const evidence = {
    version: 1, verified: complete, timestamp: new Date().toISOString(), moduleRoot,
    boundary: "Real Store/Coordinator/durable journal + production preload/IPC across two Electron Main processes; ui-entry is hash-recorded only and React/product startup is not executed",
    sourceHashesBefore: before, sourceHashesAfter: after, fixtureHashes,
    electronExecutable: electron, electronExecutableSha256: sha(fs.readFileSync(electron)),
    fixtureRoot: root, exactFixtureRootRemoved: complete && !fs.existsSync(root),
    noGlobalAppHostModelAccountOrSkills: true, results,
    ...(failure ? { failure: { name: failure.name, message: failure.message } } : {}),
  };
  fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  if (failure) throw new Error(`Restart fixture failed; original isolated evidence retained at ${output}; root ${root}`, { cause: failure });
  console.log(`PASS real Electron model recovery restart: 2 natural Main exits; original marker/terminal ack; ${output}`);
}
if (require.main === module) {
  try { run(); } catch (error) { console.error(error); process.exitCode = 1; }
}
