#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), childProcess = require("node:child_process");
const { sourceFingerprint, fileHash, until } = require("./fixtures/generic-acp-service-fixture.cjs");
const ALL_POINTS = Object.freeze(["before_prepare", "after_prepared", "after_write_marker", "after_first_text", "after_remote_terminal", "after_accepted", "after_product_terminal"]);
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const rawRounds = argument("rounds") || "50", rounds = Number(rawRounds);
assert(/^\d+$/u.test(rawRounds) && Number.isSafeInteger(rounds) && rounds > 0 && rounds <= 10000, "rounds must be 1..10000");
const suite = argument("suite") || "recovery"; assert(["recovery", "lifecycle"].includes(suite));
const selected = argument("crash-points") || "all";
const points = selected === "all" ? ALL_POINTS : selected.split(",");
assert(points.length && new Set(points).size === points.length && points.every(point => ALL_POINTS.includes(point)), "Unknown or duplicate crash point");
const rawJobs = argument("jobs") || "2", jobs = Number(rawJobs);
assert(/^[1-4]$/u.test(rawJobs), "jobs must be 1..4");
const activeChildren = new Set();
const outputArgument = argument("output"), output = path.resolve(outputArgument || fs.mkdtempSync(`/private/tmp/sg-acp-${suite}-receipts-`));
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
assert.equal(fs.readdirSync(output).length, 0, "Evidence output must be a fresh directory");
assert(output.startsWith("/private/tmp/") || output.startsWith(path.resolve(__dirname, "../.artifacts") + "/"));
const child = path.join(__dirname, "fixtures/generic-acp-recovery-child.cjs");
const peer = path.join(__dirname, "fixtures/generic-acp-service-peer.cjs");
const fixtureSource = path.join(__dirname, "fixtures/generic-acp-service-fixture.cjs"), lifecycleEntry = path.join(__dirname, "generic-acp-lifecycle-integration.cjs");
const testFingerprint = () => ({ child: fileHash(child), peer: fileHash(peer), fixture: fileHash(fixtureSource), runner: fileHash(__filename), lifecycleEntry: fileHash(lifecycleEntry) });
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
function runChild(mode, root, point, token) {
  return new Promise((resolve, reject) => {
    const fd = fs.openSync(path.join(root, `${mode}.log`), "w", 0o600);
    const spawned = childProcess.spawn(process.execPath, [child, `--mode=${mode}`, `--root=${root}`, `--point=${point}`, `--token=${token}`], {
      cwd: path.resolve(__dirname, ".."), env: { HOME: path.join(root, "home"), PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: root }, stdio: ["ignore", fd, fd], shell: false });
    fs.closeSync(fd); activeChildren.add(spawned);
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; spawned.kill("SIGKILL"); }, 45000);
    spawned.once("error", error => { clearTimeout(timeout); activeChildren.delete(spawned); reject(error); });
    spawned.once("exit", (code, signal) => { clearTimeout(timeout); activeChildren.delete(spawned); resolve({ pid: spawned.pid, code, signal, timedOut }); });
  });
}
async function pidsExited(rows) {
  await until(() => rows.filter(row => row.kind === "started").every(row => { try { process.kill(row.pid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; } }), "crashed Service peer processes must exit from closed stdin", 6000);
}
function validate(point, checkpoint, result) {
  assert.equal(checkpoint.point, point); assert.equal(result.point, point); assert.equal(result.run.id, checkpoint.runId);
  assert.equal(result.nativeRuntimeAcquireAttempts, 0); assert.equal(result.resourcesAfter.registry.hosts, 0); assert.equal(result.resourcesAfter.listeningServerHandles, 0);
  assert.equal(result.resourcesAfter.handles.filter(kind => kind === "ChildProcess").length, 0);
  assert(result.promptCount <= 1, "One operation may cross the ACP pipe at most once");
  const before = checkpoint.peerAudit.filter(row => row.kind === "prompt" && row.token === result.token).length;
  if (["before_prepare", "after_prepared"].includes(point)) {
    assert.equal(before, 0); assert.equal(result.promptCount, 1, "Durable no-write receipt recovers the original attempt once");
    assert.equal(result.run.status, "completed"); assert(result.run.runtimeTurnRef); assert.equal(result.run.errorCode, null);
    assert.equal(checkpoint.proposed.runtimeAttemptRef.dispatchState, "prepared");
    assert.equal(result.run.runtimeAttemptRef.attemptId, checkpoint.proposed.runtimeAttemptRef.attemptId);
  } else if (["after_write_marker", "after_first_text"].includes(point)) {
    assert.equal(result.promptCount, before, "Uncertain write must never replay the prompt");
    assert.equal(result.run.status, "interrupted"); assert.equal(result.run.errorCode, "RUNTIME_TURN_ACCEPTANCE_UNKNOWN");
    assert.equal(result.run.runtimeTurnRef, null); assert.equal(result.run.runtimeSessionRef, null);
    assert.equal(result.run.runtimeAttemptRef.dispatchState, "write_attempted");
    assert.equal(before, point === "after_write_marker" ? 0 : 1);
  } else {
    assert.equal(before, 1); assert.equal(result.promptCount, 1, "Durable terminal recovery only coalesces state");
    assert.equal(result.run.status, "completed"); assert.equal(result.run.errorCode, null); assert(result.run.runtimeTurnRef);
    assert.equal(result.run.runtimeAttemptRef.dispatchState, "write_attempted");
    assert.equal(result.run.runtimeTurnRef.turnId, checkpoint.proposed.runtimeAttemptRef.turnId);
  }
  const user = result.transcript.filter(row => row.kind === "user"); assert.equal(user.length, 1, "One durable user event per operation");
  const terminals = result.transcript.filter(row => row.content?.transcriptType === "terminal"); assert.equal(terminals.length, 1, "One durable Product terminal projection");
}
async function main() {
  const sourceBefore = sourceFingerprint(), testSources = testFingerprint();
  json(path.join(output, "source-before.json"), sourceBefore);
  const cases = suite === "lifecycle" ? Array.from({ length: rounds }, (_, round) => points.map(point => ({ round, point }))).flat()
    : Array.from({ length: rounds }, (_, round) => ({ round, point: points[round % points.length] }));
  const results = [], started = Date.now(); let firstFailure;
  json(path.join(output, "plan.json"), { version: 1, suite, rounds, points, jobs, expectedCases: cases.length, sourceDigest: sourceBefore.digest, testSources,
    contract: "real Service+Coordinator+GenericACP; synchronous durable crash cuts; no native runtime or Provider" });
  const runCase = async index => {
    const { round, point } = cases[index], token = `${suite}-${round}-${point.replaceAll("_", "-")}`;
    const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-acp-crash-case-")); fs.chmodSync(root, 0o700);
    json(path.join(output, `case-${String(index).padStart(4, "0")}.json`), { index, round, point, root, state: "running" });
    try {
      const crash = await runChild("crash", root, point, token);
      assert.equal(crash.timedOut, false, `fault process timeout ${point}`); assert.equal(crash.signal, "SIGKILL");
      const checkpoint = JSON.parse(fs.readFileSync(path.join(root, "checkpoint.json"), "utf8"));
      assert.equal(checkpoint.pid, crash.pid); await pidsExited(checkpoint.peerAudit);
      const recovery = await runChild("recover", root, point, token);
      assert.equal(recovery.timedOut, false, `recovery process timeout ${point}`); assert.equal(recovery.code, 0, `recovery child failed: ${path.join(root, "recover.log")}`); assert.equal(recovery.signal, null);
      const result = JSON.parse(fs.readFileSync(path.join(root, "recovered.json"), "utf8")); validate(point, checkpoint, result);
      await pidsExited(result.audit);
      const record = { index, round, point, root, state: "passed", crash, recovery, runId: result.run.id,
        status: result.run.status, errorCode: result.run.errorCode, promptCount: result.promptCount, resourcesAfter: result.resourcesAfter,
        checkpointSha256: fileHash(path.join(root, "checkpoint.json")), recoverySha256: fileHash(path.join(root, "recovered.json")) };
      results[index] = record; json(path.join(output, `case-${String(index).padStart(4, "0")}.json`), record);
      const passed = results.filter(Boolean).length;
      if (passed % 10 === 0 || passed === cases.length) console.log(JSON.stringify({ suite, passed, expected: cases.length, elapsedMs: Date.now() - started }));
    } catch (error) {
      const failed = { index, round, point, root, state: "failed", error: error.stack || String(error) };
      json(path.join(output, `case-${String(index).padStart(4, "0")}.json`), failed);
      if (!firstFailure) {
        firstFailure = { error, failed }; json(path.join(output, "failure.json"), failed);
        for (const running of activeChildren) running.kill("SIGKILL");
      }
      const auditFile = path.join(root, "peer-audit.jsonl");
      const audit = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
      try { await pidsExited(audit); json(path.join(root, "failed-case-cleanup.json"), { ownedPeerPids: audit.filter(row => row.kind === "started").map(row => row.pid), allOwnedPeersExited: true }); }
      catch (cleanupError) { json(path.join(root, "failed-case-cleanup.json"), { allOwnedPeersExited: false, error: cleanupError.stack }); }
      throw error;
    }
  };
  for (let offset = 0; offset < cases.length; offset += jobs) {
    await Promise.allSettled(cases.slice(offset, offset + jobs).map((_, index) => runCase(offset + index)));
    if (firstFailure) throw Object.assign(firstFailure.error, { evidenceRoot: output, failedCase: firstFailure.failed.root });
  }
  const sourceAfter = sourceFingerprint(); json(path.join(output, "source-after.json"), sourceAfter);
  assert.equal(sourceAfter.digest, sourceBefore.digest, "Production source changed during formal stress proof");
  assert.deepEqual(testSources, testFingerprint(), "Fixture sources changed during proof");
  const summary = { version: 1, suite, rounds, points, jobs, cases: results.length, expectedCases: cases.length,
    passed: results.length, failed: 0, elapsedMs: Date.now() - started, sourceDigest: sourceAfter.digest, testSources, evidenceRoot: output };
  json(path.join(output, "summary.json"), summary); console.log(JSON.stringify(summary, null, 2));
}
main().catch(error => { console.error(error.stack || error); if (error.evidenceRoot) console.error(`Evidence retained: ${error.evidenceRoot}; failed case: ${error.failedCase}`); process.exitCode = 1; });
