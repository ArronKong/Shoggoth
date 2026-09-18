#!/usr/bin/env node

// Metadata-only smoke against installed CLIs. It never creates a conversation,
// dispatches a turn, or exposes credentials. DSH's direct registry/command smoke
// lives in deepseek-harness-official-smoke.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const accounts = require("../app/agent-service/runtime-account.js");
const specs = {
  "claude-code": ["ClaudeCode", "NATIVE_CLAUDE_CODE_RUNTIME_ACCOUNT_ID"],
  pi: ["Pi", "NATIVE_PI_RUNTIME_ACCOUNT_ID"],
  antigravity: ["Antigravity", "NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID"],
};
const selected = process.argv.slice(2).find((arg) => !arg.startsWith("--")) || "all";
assert.ok(selected === "all" || specs[selected], "unsupported runtime");
for (const [runtime, [prefix, accountKey]] of Object.entries(specs)) {
  if (selected !== "all" && selected !== runtime) continue;
  const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), `shoggoth-slash-${runtime}-`));
  fs.chmodSync(trustedRoot, 0o700);
  const workspace = path.join(trustedRoot, "workspace");
  fs.mkdirSync(workspace, { mode: 0o700 });
  const Pool = require(`../app/agent-service/${runtime}-runtime-pool.js`)[`${prefix}RuntimePool`];
  const Adapter = require(`../app/agent-service/${runtime}-runtime-adapter.js`)[`${prefix}RuntimeAdapter`];
  const pool = new Pool({
    paths: { trustedRoot, stateDir: path.join(trustedRoot, "state") },
    extensionPath: path.join(root, "resources", "pi", "shoggoth-pi-extension.mjs"),
    requestTimeoutMs: 20_000,
    mcpGateIssuer: {
      reserveMcpServer() { throw new Error("metadata smoke must not dispatch a turn"); },
      bindMcpServer() { throw new Error("metadata smoke must not dispatch a turn"); },
      revokeMcpServer() {},
    },
  });
  const adapter = new Adapter({ runtimePool: pool });
  try {
    const handle = await adapter.acquire({
      runtime, runtimeProfileId: `slash-smoke-${runtime}`, runtimeAccountId: accounts[accountKey],
    }, { workspace });
    const catalog = await handle.commandsList({ sessionId: null, cwd: workspace });
    const byExecution = Object.fromEntries(["runtime", "client", "cli"].map((kind) => [
      kind, catalog.commands.filter((entry) => entry.execution === kind).length,
    ]));
    console.log(JSON.stringify({ runtime, count: catalog.commands.length, byExecution,
      bytes: Buffer.byteLength(JSON.stringify(catalog)), reason: catalog.reason,
      executable: catalog.commands.filter((entry) => entry.execution === "runtime").map((entry) => entry.name) }));
    if (process.argv.includes("--descriptions")) {
      console.log(JSON.stringify({ runtime, commands: catalog.commands.filter((entry) => entry.execution === "runtime") }));
    }
    assert.equal(catalog.supported, true);
    assert.equal(catalog.reason, null, `${runtime} must return live metadata`);
    assert.ok(byExecution.runtime > 0);
    assert.equal((await handle.sessionList({ archived: false })).data.length, 0,
      "opening a command menu cannot create a conversation");
  } finally {
    await adapter.stopAll();
    fs.rmSync(trustedRoot, { recursive: true, force: true });
  }
}
