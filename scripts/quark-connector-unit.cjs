"use strict";

const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
const { createOfficialSkillRuntime } = require("../app/agent-service/official-skill-runtime");
const { RELEASE, managedModule, archiveFetch } = require("../app/agent-service/quark-skill-installer");
const { publicQuark } = require("../app/agent-service/quark-skill-runtime");
const dto = require("../app/core/official-skill-connector-dto");
function fixture(t, handler) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shg-quark-unit-")));
  const root = path.join(base, "runtime-bin", "official-skills", "quark-drive", crypto.randomUUID()), home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  let timestamp = 0; const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.exitCode = null;
    const call = { command, args, options, child, input: "", payload: null }; calls.push(call);
    child.finish = (data = {}, code = 0, extra = {}) => { if (child.exitCode !== null) return; child.exitCode = code; child.stdout.end(JSON.stringify({ code: code ? -1 : 0, type: "result", data, ...extra }) + "\n"); child.stderr.end(); child.emit("close", code); };
    child.kill = () => { queueMicrotask(() => child.finish({}, 143)); return true; };
    child.stdin.on("data", bytes => { call.input += bytes; });
    child.stdin.on("end", () => { call.payload = JSON.parse(call.input); queueMicrotask(() => handler(call)); }); return child;
  };
  const make = (overrides = {}) => createOfficialSkillRuntime({ providerId: "quark-drive", root, home, spawn, now: () => timestamp,
    env: { UNRELATED_SECRET: "unrelated-secret-canary", CODEX_THREAD_ID: "must-not-inherit" }, ...overrides });
  const runtime = make(); t.after(async () => { await runtime.close(); fs.rmSync(base, { recursive: true, force: true }); });
  return { root, home, calls, runtime, make, time: value => { timestamp = value; } };
}
test("Quark contracts require typed, approved writes and a fixed helper without inherited identities or secrets", async t => {
  const f = fixture(t, call => call.child.finish({ state: "signedOut" }));
  assert.equal((await f.runtime.call("account_status", {})).state, "signedOut");
  const sent = f.calls[0]; assert.ok(sent.args.some(arg => arg.endsWith("quark-skill-cli-helper.js")));
  assert.equal(sent.options.shell, false); assert.equal(sent.options.env.UNRELATED_SECRET, undefined); assert.equal(sent.options.env.CODEX_THREAD_ID, undefined);
  for (const tool of f.runtime.tools) assert.equal(tool.inputSchema.additionalProperties, false);
  for (const name of ["upload_file", "download_file", "move_files", "share_files", "save_share", "rename_files", "organize_photos", "undo_rename"]) {
    const tool = f.runtime.tools.find(tool => tool.name === name); assert.equal(tool.annotations.readOnlyHint, false); assert.ok(tool.inputSchema.required.includes("confirmed"));
    await assert.rejects(f.runtime.call(name, {}), { code: "OFFICIAL_SKILL_INVALID_ARGUMENT" });
  }
  await assert.rejects(f.runtime.call("search_files", { keyword: "报告", endpoint: "https://attacker.invalid" }), { code: "OFFICIAL_SKILL_INVALID_ARGUMENT" });
  await assert.rejects(f.runtime.call("move_files", { fids: ["--help"], targetFid: "0", confirmed: true }), { code: "OFFICIAL_SKILL_INVALID_ARGUMENT" });
  assert.equal(f.calls.length, 1);
});
test("authorization persists private pending state, polls at most every 5 seconds, and recovers after restart", async t => {
  let ready = false;
  const f = fixture(t, ({ payload, child }) => payload.operation === "start"
    ? child.finish({ authorizePageUrl: "https://pan.quark.cn/agent-oauth?fixture=1", pageCode: "private-page-canary", deviceId: "provider-device" })
    : child.finish({ state: ready ? "ready" : "authorizing", ...(ready ? { userName: "Fixture user" } : {}) }));
  const start = await f.runtime.call("account_start", {});
  assert.equal(start.state, "authorizing"); assert.equal(JSON.stringify(start).includes("private-page-canary"), false);
  const file = path.join(f.home, "quark-authorization.json"); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal((await f.runtime.call("account_status", {})).state, "authorizing"); assert.equal(f.calls.length, 1);
  f.time(5000); assert.equal((await f.runtime.call("account_status", {})).state, "authorizing");
  const restarted = f.make(); t.after(() => restarted.close()); ready = true; f.time(10000);
  const result = await restarted.call("account_status", {}); assert.equal(result.state, "ready"); assert.equal(result.userName, "Fixture user");
  assert.equal(f.calls.at(-1).payload.pageCode, "private-page-canary");
  assert.equal(f.calls.at(-1).args.some(arg => arg.includes("private-page-canary")), false);
  assert.equal(JSON.parse(fs.readFileSync(file)).pending, null);
});
test("authorization rejects off-origin pages, expires without restart and transports manual codes only on stdin", async t => {
  let bad = true;
  const f = fixture(t, ({ payload, child }) => payload.operation === "start"
    ? child.finish({ authorizePageUrl: bad ? "https://pan.quark.cn.attacker.invalid/authorize" : "https://pan.quark.cn/agent-oauth", pageCode: "private-page" })
    : child.finish({ state: "ready" }));
  await assert.rejects(f.runtime.call("account_start", {}), { code: "OFFICIAL_SKILL_AUTH_FAILED" });
  bad = false; await f.runtime.call("account_start", {});
  const ready = await f.runtime.call("account_bind", { code: "private-code-canary" }); assert.equal(ready.state, "ready");
  assert.equal(f.calls.at(-1).payload.code, "private-code-canary"); assert.equal(f.calls.at(-1).args.includes("private-code-canary"), false);
  await f.runtime.call("account_start", {}); const count = f.calls.length; f.time(300001);
  assert.equal((await f.runtime.call("account_status", {})).state, "signedOut"); assert.equal(f.calls.length, count);
});
test("local logout clears only this connector's credentials without calling provider revoke", async t => {
  const f = fixture(t, () => { throw Error("logout must be local"); });
  const directory = path.join(f.home, ".quarkclouddrive", "shoggoth"); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const config = path.join(directory, "config.json"); fs.writeFileSync(config, "private-token", { mode: 0o600 });
  fs.writeFileSync(path.join(f.home, "retained-download.txt"), "preserve", { mode: 0o600 });
  assert.equal((await f.runtime.call("account_logout", {})).state, "signedOut"); assert.equal(fs.existsSync(config), false);
  assert.equal(fs.readFileSync(path.join(f.home, "retained-download.txt"), "utf8"), "preserve"); assert.equal(f.calls.length, 0);
});
test("search keeps the query private from telemetry parameters and full results are paged through an owned receipt", async t => {
  let resultFile;
  const f = fixture(t, call => {
    call.child.stdout.write(JSON.stringify({ type: "list", data: { fid: "preview" } }) + "\n");
    call.child.stdout.write(JSON.stringify({ type: "artifact", data: { file_path: resultFile } }) + "\n");
    call.child.finish({ total: 7, accessToken: "private-access", nested: { stoken: "share-private" } });
  });
  resultFile = path.join(f.home, "result.jsonl"); fs.writeFileSync(resultFile, Array.from({ length: 7 }, (_, i) => JSON.stringify({ fid: String(i), access_token: "private" })).join("\n"), { mode: 0o600 });
  const result = await f.runtime.call("search_files", { keyword: "照片" });
  assert.ok(result.resultId); assert.equal(result.data.total, 7); assert.equal(JSON.stringify(result).includes("private-access"), false);
  assert.deepEqual(f.calls[0].payload.args, ["search", "--keyword", "照片", "--stdout-only"]);
  assert.equal(f.calls[0].input.includes("session-input"), false); assert.equal(f.calls[0].input.includes("session-id"), false);
  const complete = await f.runtime.call("result_files", { resultId: result.resultId, offset: 5, limit: 2 });
  assert.deepEqual(complete.files, [{ fid: "5" }, { fid: "6" }]); assert.equal(complete.hasMore, false);
  await assert.rejects(f.runtime.call("result_files", { resultId: "invented" }), { code: "OFFICIAL_SKILL_INVALID_ARGUMENT" });
});
test("result artifacts cannot point outside private storage, at credentials, or through symlinks", async t => {
  let target;
  const f = fixture(t, call => { call.child.stdout.write(JSON.stringify({ type: "artifact", data: { file_path: target } }) + "\n"); call.child.finish({}); });
  for (const file of ["/etc/hosts", path.join(f.home, "config.json")]) { target = file; await assert.rejects(f.runtime.call("search_files", { keyword: "文件" }), { code: "OFFICIAL_SKILL_INTEGRITY_FAILED" }); }
  const regular = path.join(f.home, "regular.jsonl"); fs.writeFileSync(regular, "{}", { mode: 0o600 }); target = path.join(f.home, "link.jsonl"); fs.symlinkSync(regular, target);
  await assert.rejects(f.runtime.call("search_files", { keyword: "文件" }), { code: "OFFICIAL_SKILL_INTEGRITY_FAILED" });
});
test("repair can relocate private HOME without losing complete-result receipts", async t => {
  const f = fixture(t, call => {
    const file = path.join(f.home, "complete.jsonl"); fs.writeFileSync(file, '{"fid":"retained-file"}\n', { mode: 0o600 });
    call.child.stdout.write(JSON.stringify({ type: "artifact", data: { file_path: file } }) + "\n"); call.child.finish({ total: 1 });
  });
  const result = await f.runtime.call("search_files", { keyword: "保留" });
  const newRoot = path.join(path.dirname(f.root), crypto.randomUUID()), newHome = path.join(newRoot, "home");
  fs.mkdirSync(newRoot, { mode: 0o700 }); fs.cpSync(f.home, newHome, { recursive: true }); fs.chmodSync(newHome, 0o700);
  const relocated = f.make({ root: newRoot, home: newHome }); t.after(() => relocated.close());
  assert.deepEqual((await relocated.call("result_files", { resultId: result.resultId })).files, [{ fid: "retained-file" }]);
});
test("uploads preserve omitted destinations, reject private connector files and carry only approved fixed arguments", async t => {
  const f = fixture(t, call => call.child.finish({ fid: "uploaded" }));
  const file = path.join(path.dirname(f.root), "selected.txt"); fs.writeFileSync(file, "fixture", { mode: 0o600 });
  await f.runtime.call("upload_file", { filePath: file, confirmed: true });
  assert.deepEqual(f.calls[0].payload.args, ["upload", "--file-path", file]);
  const secret = path.join(f.home, "secret.txt"); fs.writeFileSync(secret, "must not upload", { mode: 0o600 });
  await assert.rejects(f.runtime.call("upload_file", { filePath: secret, confirmed: true }), { code: "OFFICIAL_SKILL_INVALID_ARGUMENT" });
  await f.runtime.call("save_share", { url: "https://pan.quark.cn/s/abc123", confirmed: true });
  assert.deepEqual(f.calls.at(-1).payload.args, ["saveas", "--url", "https://pan.quark.cn/s/abc123"]);
});
test("uncertain writes cannot replay across bridge restarts and read-only reconciliation remains available", async t => {
  const f = fixture(t, call => call.payload.args[0] === "move" ? call.child.finish({}, 1) : call.child.finish({}));
  const args = { fids: ["fid1"], targetFid: "folder1", confirmed: true };
  await assert.rejects(f.runtime.call("move_files", args), { code: "OFFICIAL_SKILL_OPERATION_UNCERTAIN" });
  const restarted = f.make(); t.after(() => restarted.close());
  await assert.rejects(restarted.call("move_files", args), { code: "OFFICIAL_SKILL_OPERATION_UNCERTAIN" });
  assert.equal(f.calls.length, 1); await restarted.call("list_files", {}); assert.equal(f.calls.length, 2);
});
test("cancelling a dispatched write waits for child exit and retains an unknown ledger entry", async t => {
  const f = fixture(t, () => {}), abort = new AbortController();
  const promise = f.runtime.call("create_folder", { name: "reviewed", confirmed: true }, { signal: abort.signal });
  while (!f.calls.length || !f.calls[0].payload) await new Promise(resolve => setImmediate(resolve)); abort.abort();
  await assert.rejects(promise, { code: "OFFICIAL_SKILL_OPERATION_UNCERTAIN" });
  assert.notEqual(f.calls[0].child.exitCode, null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, "operation-guards.json"))).operations[0].state, "unknown");
});
test("rename batches are generated privately from the reviewed mappings; undo accepts only an owned receipt", async t => {
  const f = fixture(t, call => {
    const file = path.join(f.home, "rename-record.json"); fs.writeFileSync(file, "{}", { mode: 0o600 });
    call.child.finish({ batch_id: "abcdef0123456789", record_file: file });
  });
  const items = [{ fid: "fid1", oldName: "old.jpg", newName: "new.jpg", parentFid: "folder1" }];
  const result = await f.runtime.call("rename_files", { items, confirmed: true });
  const input = JSON.parse(fs.readFileSync(f.calls[0].payload.args[2])); assert.deepEqual(input.items[0], { fid: "fid1", old_name: "old.jpg", new_name: "new.jpg", parent_fid: "folder1" });
  assert.equal(fs.statSync(f.calls[0].payload.args[2]).mode & 0o777, 0o600);
  await assert.rejects(f.runtime.call("undo_rename", { receiptId: "invented", confirmed: true }), { code: "OFFICIAL_SKILL_INVALID_ARGUMENT" });
  await f.runtime.call("undo_rename", { receiptId: result.receiptId, confirmed: true }); assert.equal(f.calls.at(-1).payload.args[0], "rename-revert");
});
test("receipt persistence failure after a cloud write retains the no-replay boundary", async t => {
  const f = fixture(t, call => {
    fs.mkdirSync(path.join(f.home, "quark-receipts.json"), { mode: 0o700 });
    const file = path.join(f.home, "record.json"); fs.writeFileSync(file, "{}", { mode: 0o600 });
    call.child.finish({ batch_id: "abcdef0123456789", record_file: file });
  });
  const args = { items: [{ fid: "fid1", oldName: "old", newName: "new" }], confirmed: true };
  await assert.rejects(f.runtime.call("rename_files", args), { code: "OFFICIAL_SKILL_OPERATION_UNCERTAIN" });
  await assert.rejects(f.runtime.call("rename_files", args), { code: "OFFICIAL_SKILL_OPERATION_UNCERTAIN" });
  assert.equal(f.calls.length, 1);
});
test("photo confirmation requires a returned owned receipt and does not invent a new task", async t => {
  const f = fixture(t, call => call.child.finish({ task_id: "original-task" }, 0, { needsConfirmation: call.payload.args[0] === "organize" }));
  const proposed = await f.runtime.call("organize_photos", { query: "按城市复制去年旅游照片", confirmed: true });
  assert.equal(proposed.confirmationRequired, true); assert.ok(proposed.receiptId);
  await assert.rejects(f.runtime.call("confirm_photo_organization", { receiptId: "invented", mode: "move", confirmed: true }), { code: "OFFICIAL_SKILL_INVALID_ARGUMENT" });
  await f.runtime.call("confirm_photo_organization", { receiptId: proposed.receiptId, mode: "copy", confirmed: true });
  assert.deepEqual(f.calls.at(-1).payload.args, ["organize-copy", "--task-id", "original-task"]);
});
test("fixed Quark releases reject modified runtimes and off-origin or downgraded redirects", async () => {
  assert.equal(RELEASE.version, "1.0.25"); assert.match(RELEASE.sha256, /^[a-f0-9]{64}$/u);
  assert.throws(() => managedModule(Buffer.from("arbitrary code")), { code: "OFFICIAL_SKILL_INTEGRITY_FAILED" });
  for (const target of ["https://attacker.invalid/quarkclouddrive-1.0.25.zip", "http://pdds-c1-cdn.quark.cn/quarkclouddrive-1.0.25.zip", "https://pdds-c1-cdn.quark.cn/other.zip"]) {
    let calls = 0;
    await assert.rejects(archiveFetch(async () => { calls++; return new Response(null, { status: 302, headers: { location: target } }); })(RELEASE.url, {}), { code: "OFFICIAL_SKILL_INTEGRITY_FAILED" });
    assert.equal(calls, 1);
  }
  assert.equal(dto.validOfficialVerificationUrl("quark-drive", "https://pan.quark.cn/agent-oauth"), true);
  assert.equal(dto.validOfficialVerificationUrl("quark-drive", "https://pan.quark.cn.attacker.invalid/agent-oauth"), false);
  assert.deepEqual(publicQuark({ accessToken: "private", pageCode: "private", file: { name: "report.pdf", stoken: "private" } }), { file: { name: "report.pdf" } });
});
