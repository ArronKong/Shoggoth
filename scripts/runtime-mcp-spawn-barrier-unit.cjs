#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { RuntimeMcpGateIssuer } = require("../app/agent-service/runtime-mcp-gate");

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-mcp-barrier-")));
const executable = fs.realpathSync(process.execPath);
const bootstrap = path.join(root, "bootstrap.js");
fs.writeFileSync(bootstrap, "// isolated gate fixture\n", { mode: 0o600 });
const issuer = new RuntimeMcpGateIssuer({ paths: resolveServicePaths({ homeDir: root }),
  mcpHelperLaunch: { command: executable, argsPrefix: [] }, bootstrapPath: bootstrap }).open();
const input = { runtimeProfileId: "runtime-deepseek-barrier", runtimeAccountId: "runtime-barrier-fixture",
  parentExecutable: executable };
const checks = [];
let child;
let exited = false;
let childExit;
let reader;
let deadline;
const bounded = (promise) => Promise.race([promise, new Promise((_, reject) => {
  deadline = setTimeout(() => reject(new Error("spawn barrier fixture timed out")), 10_000);
})]).finally(() => clearTimeout(deadline));

(async () => {
  try {
    for (const parentLauncherExecutable of [null, "", executable, "/bin/zsh", "/bin/../bin/sh"]) {
      assert.throws(() => issuer.reserveMcpServer({ ...input, parentLauncherExecutable }),
        { code: "RUNTIME_MCP_GATE_INPUT_INVALID" });
    }
    assert.throws(() => issuer.reserveMcpServer({ ...input, parentLauncherExecutable: "/bin/sh",
      ancestorExecutable: executable }), { code: "RUNTIME_MCP_GATE_INPUT_INVALID" });
    checks.push("only the fixed direct-child launcher can be reserved");

    child = spawn("/bin/sh", ["-c", 'IFS= read -r _ <&3 || exit 125; exec "$@"',
      "shoggoth-deepseek-harness-launcher", executable, "-e",
      'process.stdin.resume(); process.stdout.write(JSON.stringify({pid:process.pid})+"\\n");'],
    { stdio: ["pipe", "pipe", "pipe", "pipe"] });
    childExit = new Promise((resolve, reject) => {
      child.once("exit", (code, signal) => { exited = true; resolve({ code, signal }); });
      child.once("error", reject);
    });
    await bounded(once(child, "spawn"));
    reader = readline.createInterface({ input: child.stdout });
    const ready = once(reader, "line");

    const plain = issuer.reserveMcpServer(input);
    assert.throws(() => issuer.bindMcpServer({ reservationId: plain.reservationId,
      parentPid: child.pid, parentLauncherExecutable: "/bin/sh" }),
    { code: "RUNTIME_MCP_GATE_INPUT_INVALID" });
    issuer.revokeMcpServer({ reservationId: plain.reservationId });
    checks.push("bind cannot add launcher authority to a normal reservation");

    const reservation = issuer.reserveMcpServer({ ...input, parentLauncherExecutable: "/bin/sh" });
    const readLink = issuer.getProcessLink;
    for (const invalidLink of [{ ppid: 1 }, { command: "" }, { executable }]) {
      issuer.getProcessLink = (pid) => ({ ...readLink(pid), ...invalidLink });
      assert.throws(() => issuer.bindMcpServer({ reservationId: reservation.reservationId,
        parentPid: child.pid }), { code: "RUNTIME_MCP_GATE_INPUT_INVALID" });
    }
    issuer.getProcessLink = readLink;
    issuer.bindMcpServer({ reservationId: reservation.reservationId, parentPid: child.pid });
    checks.push("bind verifies the pinned shell, live command and Service child relationship");

    const env = Object.fromEntries(reservation.env.map(({ name, value }) => [name, value]));
    const consume = { runtimeProfileId: input.runtimeProfileId, runtimeAccountId: input.runtimeAccountId,
      gatePath: env.SHOGGOTH_RUNTIME_MCP_GATE_FILE, nonce: env.SHOGGOTH_RUNTIME_MCP_GATE_NONCE,
      parentPid: child.pid };
    const gate = JSON.parse(fs.readFileSync(consume.gatePath, "utf8"));
    assert.equal(gate.parentExecutable, executable);
    assert.equal(gate.parentLauncherExecutable, undefined);
    assert.equal(JSON.stringify(reservation).includes("parentLauncherExecutable"), false);
    assert.throws(() => issuer.consume(consume), { code: "RUNTIME_MCP_GATE_INVALID" });
    checks.push("the shell cannot consume a gate that pins the final executable");

    child.stdio[3].end("go\n");
    const [line] = await bounded(ready);
    assert.equal(JSON.parse(line).pid, child.pid, "exec must preserve the bound PID");
    assert.throws(() => issuer.consume({ ...consume, parentPid: process.pid }),
      { code: "RUNTIME_MCP_GATE_INVALID" });
    issuer.getProcessLink = (pid) => ({ ...readLink(pid), executable: fs.realpathSync("/bin/sh") });
    assert.throws(() => issuer.consume(consume), { code: "RUNTIME_MCP_GATE_INVALID" });
    issuer.getProcessLink = readLink;
    assert.deepEqual(issuer.consume(consume), { consumed: true });
    assert.throws(() => issuer.consume(consume), { code: "RUNTIME_MCP_GATE_INVALID" });
    checks.push("consume verifies the final executable and original PID start after exec, exactly once");

    child.stdin.end();
    assert.deepEqual(await bounded(childExit), { code: 0, signal: null });
    checks.push("the real shell-to-Node child exits naturally after stdin EOF");
    console.log(JSON.stringify({ ok: true, checks }, null, 2));
  } finally {
    clearTimeout(deadline);
    reader?.close();
    if (child && !exited) {
      child.kill("SIGTERM");
      await childExit;
    }
    issuer.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
