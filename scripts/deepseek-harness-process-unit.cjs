"use strict";

const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const { spawn } = require("node:child_process");
const { Writable, PassThrough } = require("node:stream");
const test = require("node:test");
const { DeepSeekHarnessProcess } = require("../app/agent-service/deepseek-harness-process");

const tick = () => new Promise(resolve => setImmediate(resolve));
const brokenPipe = () => Object.assign(new Error("write EPIPE private-pipe-details"), { code: "EPIPE" });

function fixture(write) {
  const child = new EventEmitter();
  child.stdin = new Writable({ write });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const kills = [], failures = [];
  child.kill = signal => { kills.push(signal); return true; };
  const harness = new DeepSeekHarnessProcess({ child, onFatal: error => failures.push(error),
    onServerRequest: async () => ({ decision: "accept" }) });
  return { child, harness, kills, failures };
}

test("asynchronous EPIPE settles every pending request before exit and reports failure once", async () => {
  const value = fixture((_chunk, _encoding, callback) => setImmediate(() => callback(brokenPipe())));
  const { harness, child, kills, failures } = value;
  const results = await Promise.allSettled([harness.request("models/list"), harness.request("auth/read")]);
  await tick();
  assert.equal(results.every(result => result.status === "rejected"
    && result.reason.code === "DEEPSEEK_HARNESS_WRITE_FAILED"), true);
  assert.equal(harness.pending.size, 0);
  assert.equal(harness.closed, false, "transport failure must not claim the child already exited");
  assert.deepEqual(kills, ["SIGKILL"]);
  assert.equal(failures.length, 1, "write callback and stream error must settle only once");
  assert.equal(failures[0].message.includes("private-pipe-details"), false);
  await assert.rejects(harness.ready, { code: "DEEPSEEK_HARNESS_WRITE_FAILED" });
  await assert.rejects(harness.request("models/list"), { code: "DEEPSEEK_HARNESS_WRITE_FAILED" });
  child.emit("close", null, "SIGKILL");
  assert.equal((await harness.closedPromise).error.code, "DEEPSEEK_HARNESS_WRITE_FAILED");
  child.stdin.emit("error", brokenPipe());
  assert.equal(failures.length, 1, "late pipe errors after close are handled");
});

test("synchronous write failure rejects all pending work without waiting for timeout", async () => {
  const { child, harness } = fixture((_chunk, _encoding, callback) => callback());
  const pending = harness.request("models/list");
  child.stdin.write = () => { throw brokenPipe(); };
  const result = await Promise.allSettled([pending, harness.request("auth/read")]);
  assert.equal(result.every(item => item.reason?.code === "DEEPSEEK_HARNESS_WRITE_FAILED"), true);
  assert.equal(harness.pending.size, 0);
  child.emit("close", 1, null);
});

test("an approval reply to a broken pipe is handled through the same failure path", async () => {
  const { child, harness, failures } = fixture((_chunk, _encoding, callback) =>
    setImmediate(() => callback(brokenPipe())));
  child.stdout.write(JSON.stringify({ type: "server_request", id: "approval-1",
    method: "item/commandExecution/requestApproval", params: { command: "pwd" } }) + "\n");
  await tick(); await tick();
  assert.equal(failures[0]?.code, "DEEPSEEK_HARNESS_WRITE_FAILED");
  assert.equal(harness.activeServerRequests, 0);
  child.emit("close", 1, null);
});

for (const name of ["stdout", "stderr"]) {
  test(`${name} pipe error rejects pending requests with a safe transport failure`, async () => {
    const { child, harness } = fixture((_chunk, _encoding, callback) => callback());
    const pending = harness.request("models/list");
    child[name].destroy(brokenPipe());
    await assert.rejects(pending, { code: "DEEPSEEK_HARNESS_TRANSPORT_FAILED" });
    child.emit("close", 1, null);
  });
}

test("ending input rejects new requests without writing after end", async () => {
  let writes = 0;
  const { child, harness, failures } = fixture((_chunk, _encoding, callback) => { writes++; callback(); });
  harness.endInput();
  await assert.rejects(harness.request("models/list"), { code: "DEEPSEEK_HARNESS_RPC_CLOSED" });
  assert.equal(writes, 0);
  assert.equal(failures.length, 0);
  child.emit("close", 0, null);
});

test("a real child closing stdin cannot raise an uncaught EPIPE in the parent", { timeout: 5000 }, async () => {
  const child = spawn(process.execPath, ["-e", `
    require('node:fs').closeSync(0);
    process.stdout.write(JSON.stringify({type:'ready', protocol:'shoggoth-dsh-runtime', protocolVersion:1})+'\\n');
    setInterval(()=>{}, 1000);
  `], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "close");
  const harness = new DeepSeekHarnessProcess({ child });
  try {
    await harness.ready;
    await assert.rejects(harness.request("models/list"), { code: "DEEPSEEK_HARNESS_WRITE_FAILED" });
    assert.equal((await harness.closedPromise).error.code, "DEEPSEEK_HARNESS_WRITE_FAILED");
    assert.equal(harness.pending.size, 0);
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
});
