"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { AcpJsonlClient } = require("../app/agent-service/acp-jsonl-client");

// A real pipe can fail after stdout EOF / logical termination. The transport
// must own that failure until its child and all three streams physically close.
if (process.argv.includes("--peer")) {
  process.send("ready");
  process.on("message", () => {
    process.stdout.end(() => setTimeout(() => process.exit(0), 40));
  });
} else if (process.argv.includes("--worker")) {
  const mode = process.argv.at(-1);
  const child = spawn(process.execPath, [__filename, "--peer"], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  const rpc = new AcpJsonlClient(child);
  (async () => {
    await new Promise(resolve => child.once("message", resolve));
    const request = rpc.request("initialize", { payload: "x".repeat(1024 * 1024) }, {
      onWriteAttempt: () => child.send("close"),
    });
    const failure = request.catch(error => error);
    // Retire while the OS is still holding a partially written frame.
    if (mode === "terminate") await new Promise(resolve => setImmediate(() => { rpc.terminate(); resolve(); }));
    const error = await failure;
    assert.equal(error.code, mode === "terminate" ? "ACP_TERMINATED" : "ACP_STDOUT_ENDED");
    assert.equal(error.dispatchState, "write_attempted");
    assert.deepEqual(await closed, { code: 0, signal: null });
    await new Promise(setImmediate);
    assert.equal(rpc.pending.size, 0);
    assert.equal(rpc.ended, true);
    assert.equal(child.stdin.listenerCount("error"), 0, "physical close releases the retirement listener");
    process.stdout.write(`PASS ${mode}: late real pipe error stayed within the retired transport\n`);
  })().catch(error => { console.error(error); process.exitCode = 1; child.kill(); });
} else {
  (async () => {
    for (const mode of ["eof", "terminate"]) {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [__filename, "--worker", mode], { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "", stderr = "";
        const timeout = setTimeout(() => child.kill(), 5000);
        child.stdout.on("data", chunk => { stdout += chunk; });
        child.stderr.on("data", chunk => { stderr += chunk; });
        child.once("error", reject);
        child.once("exit", (code, signal) => { clearTimeout(timeout); resolve({ code, signal, stdout, stderr }); });
      });
      assert.equal(result.signal, null, result.stderr);
      assert.equal(result.code, 0, result.stderr);
      process.stdout.write(result.stdout);
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
