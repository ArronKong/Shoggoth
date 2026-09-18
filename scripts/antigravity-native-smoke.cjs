#!/usr/bin/env node
"use strict";

// Explicit, opt-in live CLI smoke. Only reads files created in its private temp
// directory; reuses existing native login/onboarding without changing it.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { AntigravityRuntimePool } = require("../app/agent-service/antigravity-runtime-pool");
const { NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");

async function until(predicate, label, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`);
}

async function main() {
  if (!process.argv.includes("--live")) throw new Error("Pass --live to run authenticated CLI smoke");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-agy-native-smoke-")));
  fs.chmodSync(root, 0o700);
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { mode: 0o700 });
  const content = `SHOGGOTH_NATIVE_${crypto.randomBytes(6).toString("hex")}`;
  const files = ["allow", "deny", "interrupt"].map((name) => path.join(root, `${name}.txt`));
  for (const file of files) fs.writeFileSync(file, `${content}\n`, { mode: 0o600 });
  const bindings = [];
  const revocations = [];
  const helper = path.join(root, "mcp.cjs");
  fs.writeFileSync(helper, `require('readline').createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.id!==undefined)console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result:q.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'isolated-smoke',version:'1'}}:{tools:[]}}));});`, { mode: 0o600 });
  const pool = new AntigravityRuntimePool({
    paths: { stateDir: path.join(root, "state"), trustedRoot: root },
    homedir: os.homedir(), parentEnv: process.env,
    acceptanceTimeoutMs: 60_000, promptTimeoutMs: 120_000,
    mcpGateIssuer: {
      reserveMcpServer: () => ({ reservationId: crypto.randomBytes(32).toString("hex"), command: process.execPath, args: [helper], env: [] }),
      bindMcpServer: (value) => { bindings.push(value); },
      revokeMcpServer: (value) => { revocations.push(value); },
    },
  });
  try {
    const host = await pool.get({ runtime: "antigravity", runtimeProfileId: "native-terminal-smoke",
      runtimeAccountId: NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID }, { workspace });
    assert.equal(host.nativeApprovalsAvailable, true);
    const events = [];
    host.subscribe((event) => events.push(event));
    let pending;
    host.registerServerRequestHandler("item/commandExecution/requestApproval", (params) => new Promise((resolve) => {
      assert.equal(pending, undefined);
      pending = { params, resolve };
    }));
    const session = (await host.sessionStart({ source: `smoke-${crypto.randomUUID()}`, cwd: workspace,
      model: "gemini-3.7-flash-high", permissionMode: "accept-edits" })).session;
    let conversationId;
    for (const [index, action] of ["allow", "deny", "interrupt"].entries()) {
      const turn = (await host.turnStart({ sessionId: session.id, cwd: workspace, operationId: `smoke-${action}`,
        permissionMode: "accept-edits", prompt: `Use view_file to read ${files[index]}. Do not run shell commands. Reply only with the file content.` })).turn;
      await until(() => pending, `${action} native approval`);
      assert.equal(pending.params.sessionId, session.id);
      assert.equal(pending.params.turnId, turn.id);
      assert.ok(pending.params.reason.includes(files[index]));
      assert.equal(pending.params.sessionApprovalAvailable, false);
      assert.deepEqual(pending.params.approvalOptions.map((o) => o.kind), ["allow_once", "allow_always", "reject_once"]);
      const active = host.activeTurns.get(session.id);
      const pid = active.child.pid;
      assert.equal(active.promptTimer, null, "user waiting pauses the execution timeout");
      conversationId ??= active.remoteConversationId;
      assert.equal(active.remoteConversationId, conversationId, "native conversation is retained");
      console.log(`${action}: native request in the original turn (${turn.id})`);
      if (action === "interrupt") {
        await host.turnInterrupt({ sessionId: session.id, turnId: turn.id });
        // A late click must not write to a terminated native terminal.
        pending.resolve({ decision: "accept", approvalChoice: pending.params.approvalOptions[0].choice });
      } else {
        pending.resolve(action === "allow" ? { decision: "accept", approvalChoice: pending.params.approvalOptions[0].choice }
          : { decision: "decline", approvalChoice: "deny" });
        assert.equal(host.activeTurns.get(session.id).child.pid, pid);
      }
      pending = undefined;
      const terminal = await until(() => events.find((e) => e.turnId === turn.id && e.type === "complete"), `${action} terminal event`);
      assert.equal(terminal.status, { allow: "completed", deny: "canceled", interrupt: "interrupted" }[action]);
      if (action === "allow") assert.ok(events.some((e) => e.turnId === turn.id && e.type === "text" && e.text.includes(content)));
      assert.equal(host.activeTurns.size, 0);
      console.log(`${action}: ${terminal.status}, child reaped`);
    }
    const recovery = (await host.turnStart({ sessionId: session.id, cwd: workspace, operationId: "smoke-recovery",
      permissionMode: "accept-edits", prompt: "Do not use tools. Reply exactly RECOVERED." })).turn;
    const completed = await until(() => events.find((e) => e.turnId === recovery.id && e.type === "complete"), "recovery");
    assert.equal(completed.status, "completed");
    assert.equal(host.ledger.snapshot().sessions[0].remoteConversationId, conversationId);
    assert.equal(bindings.length, 4);
    assert.equal(revocations.length, 4);
    assert.equal(events.filter((e) => e.type === "usage").length, 0, "unmeasured usage is not fabricated");
    fs.writeFileSync(path.join(root, "result.json"), JSON.stringify({ passed: true, conversationId,
      statuses: events.filter((e) => e.type === "complete").map((e) => e.status) }, null, 2), { mode: 0o600 });
    console.log(`PASS: native allow, deny, interruption and same-conversation recovery. Evidence: ${root}`);
  } finally { await pool.stopAll(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
