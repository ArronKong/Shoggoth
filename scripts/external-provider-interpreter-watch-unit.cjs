#!/usr/bin/env node
"use strict";
// Exercise the actual production watcher/record functions on owned small files.
// The access-event checks deliver the captured real watch callback explicitly;
// the write check waits for a real OS watch event. No fixed binary is modified.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const vm = require("node:vm"), { createRequire } = require("node:module");
const assert = require("node:assert/strict");
const repo = path.resolve(__dirname, ".."), sourceFile = path.join(repo,
  "app/agent-service/external-provider-credential-writer-worker.js");
const source = fs.readFileSync(sourceFile, "utf8"), sourceSha = crypto.createHash("sha256").update(source).digest("hex");
const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-interpreter-watch-")); fs.chmodSync(root, 0o700);
const watchers = [], cases = [];
const originalRequire = createRequire(sourceFile);
const context = { process, Buffer, require(name) {
  if (name === "node:worker_threads") return { parentPort: { on() {}, close() {}, postMessage() {} },
    workerData: { stateDir: root, resourcesRoot: path.join(repo, "resources/external-plugin-host-patches") } };
  if (name === "node:fs") return { ...fs, watch(file, options, callback) {
    const watcher = fs.watch(file, options, callback); watchers.push({ file, options, callback, watcher }); return watcher;
  } };
  return originalRequire(name);
} };
vm.runInNewContext(source + "\n;globalThis.probe = { watchInterpreter, record };", context, { filename: sourceFile, timeout: 10000 });
function fixture(name) {
  const file = path.join(root, name); fs.writeFileSync(file, "owned immutable baseline\n", { mode: 0o700 });
  let retired = false;
  const watcher = context.probe.watchInterpreter({ interpreterPath: file }, () => { retired = true; });
  const captured = watchers.at(-1); assert.equal(captured.file, file); assert.equal(captured.options.persistent, false);
  return { file, watcher, callback: captured.callback, retired: () => retired,
    signature: () => JSON.stringify(context.probe.record(file)) };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  try {
    const access = fixture("access-only"); const stamp = access.signature();
    fs.readFileSync(access.file); assert.equal(access.signature(), stamp);
    access.callback("change", path.basename(access.file)); assert.equal(access.retired(), false);
    cases.push("complete unchanged file record ignores access-only change delivery"); access.watcher.close();

    for (const [event, filename] of [["rename", "rename"], ["change", null], ["change", "foreign"], [null, "event"]]) {
      const value = fixture("event-" + cases.length); value.callback(event, filename);
      assert.equal(value.retired(), true); value.watcher.close();
      cases.push("unverifiable watch event retires: " + String(event) + "/" + String(filename));
    }
    const changed = fixture("bytes"); const savedMtime = fs.statSync(changed.file).mtime;
    // Yield for the OS watch stream to start before testing its delivery. The
    // original two-second event deadline and invalidation predicate are retained.
    await sleep(200);
    fs.writeFileSync(changed.file, "changed file same length\n"); fs.utimesSync(changed.file, new Date(), savedMtime);
    for (let i = 0; !changed.retired() && i < 100; i++) await sleep(20);
    assert.equal(changed.retired(), true, "real OS write event must retire even when mtime is restored");
    changed.watcher.close(); cases.push("real OS byte-write retires the record, including restored mtime");

    const permission = fixture("permission"); fs.chmodSync(permission.file, 0o500);
    permission.callback("change", path.basename(permission.file)); assert.equal(permission.retired(), true);
    permission.watcher.close(); cases.push("permission and ctime change remain invalidating");

    const replacement = fixture("replacement"); fs.renameSync(replacement.file, replacement.file + ".original");
    fs.writeFileSync(replacement.file, "owned immutable baseline\n", { mode: 0o700 });
    replacement.callback("change", path.basename(replacement.file)); assert.equal(replacement.retired(), true);
    replacement.watcher.close(); cases.push("same-path same-byte replacement remains invalidating");

    const link = fixture("link"); fs.renameSync(link.file, link.file + ".original"); fs.symlinkSync(link.file + ".original", link.file);
    link.callback("change", path.basename(link.file)); assert.equal(link.retired(), true);
    link.watcher.close(); cases.push("symlink substitution remains invalidating");

    const missing = fixture("missing"); fs.unlinkSync(missing.file);
    missing.callback("change", path.basename(missing.file)); assert.equal(missing.retired(), true);
    missing.watcher.close(); cases.push("absent file remains invalidating");
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(sourceFile)).digest("hex"), sourceSha);
    process.stdout.write(JSON.stringify({ status: "PASS", groups: cases.length, cases, sourceSha256: sourceSha,
      sourcesUnchanged: true, fixedInterpreterWrites: 0, hostStarts: 0, modelRequests: 0, secretReads: 0,
      boundary: "actual production callback and file-record functions; owned small files, explicit access-event delivery plus real OS write event" }) + "\n");
  } finally { for (const row of watchers) row.watcher.close(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { process.stderr.write(error.stack + "\n"); process.exitCode = 1; });
