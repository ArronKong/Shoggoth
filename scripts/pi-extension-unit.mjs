#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION_PATH = path.join(ROOT, "resources", "pi", "shoggoth-pi-extension.mjs");
const ENV_KEYS = [
  "SHOGGOTH_PI_MCP_COMMAND",
  "SHOGGOTH_PI_MCP_ARGS",
  "SHOGGOTH_PI_PERMISSION_POLICY",
  "SHOGGOTH_PI_EXTENSION_TEST_SECRET",
];

function fakeRelaySource() {
  return `#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

let buffer = "";
let pendingToolCall = null;
let pendingField = null;
const parentCommPath = process.argv[2] || null;

function send(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      if (parentCommPath) {
        const parentComm = execFileSync("/bin/ps", [
          "-p", String(process.ppid), "-o", "comm=",
        ], { encoding: "utf8" }).trim();
        fs.writeFileSync(parentCommPath, parentComm, { mode: 0o600 });
      }
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-shoggoth", version: "1" },
        },
      });
    } else if (message.method === "tools/list") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [{
            name: "skill_read",
            title: 42,
            description: "Read a skill through Shoggoth.",
            inputSchema: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
              additionalProperties: false,
            },
          }],
        },
      });
    } else if (message.method === "tools/call") {
      pendingToolCall = message;
      const productConfirmation = message.params?.arguments?.name === "product-confirmation";
      pendingField = productConfirmation ? "confirm_product_action" : "choice";
      send({
        jsonrpc: "2.0",
        id: "elicitation-one",
        method: "elicitation/create",
        params: {
          message: productConfirmation ? "确认修改" : "Choose a skill version",
          requestedSchema: {
            type: "object",
            properties: {
              [pendingField]: productConfirmation
                ? { type: "string", title: "确认修改", enum: ["确认执行", "取消"] }
                : { type: "string", title: "Version", enum: ["stable", "next"] },
            },
            required: [pendingField],
          },
        },
      });
    } else if (message.id === "elicitation-one" && pendingToolCall) {
      const choice = message.result?.content?.[pendingField];
      send({
        jsonrpc: "2.0",
        id: pendingToolCall.id,
        result: {
          content: [{
            type: "text",
            text: "selected:" + choice + ";secret:"
              + (process.env.SHOGGOTH_PI_EXTENSION_TEST_SECRET ? "present" : "absent"),
          }],
          structuredContent: { choice },
        },
      });
      pendingToolCall = null;
      pendingField = null;
    }
  }
});
`;
}

function fakePi() {
  const tools = [];
  const handlers = new Map();
  return {
    api: {
      registerTool(tool) { tools.push(tool); },
      on(name, handler) { handlers.set(name, handler); },
    },
    handlers,
    tools,
  };
}

function setBridgeEnvironment(helperPath, policy, extraArgs = []) {
  process.env.SHOGGOTH_PI_MCP_COMMAND = process.execPath;
  process.env.SHOGGOTH_PI_MCP_ARGS = JSON.stringify([helperPath, ...extraArgs]);
  process.env.SHOGGOTH_PI_PERMISSION_POLICY = JSON.stringify(policy);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-pi-extension-"));
fs.chmodSync(scratch, 0o700);
const helperPath = path.join(scratch, "fake-mcp-relay.cjs");
fs.writeFileSync(helperPath, fakeRelaySource(), { mode: 0o700 });
const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

try {
  const { default: extension } = await import(pathToFileURL(EXTENSION_PATH).href);
  process.env.SHOGGOTH_PI_EXTENSION_TEST_SECRET = "must-not-reach-relay";

  const parentCommPath = path.join(scratch, "parent-comm.txt");
  setBridgeEnvironment(helperPath, {
    approvalPolicy: "on-request",
    sandbox: "danger-full-access",
  }, [parentCommPath]);
  const first = fakePi();
  const previousTitle = process.title;
  process.title = "pi";
  try {
    await extension(first.api);
    assert.equal(fs.readFileSync(parentCommPath, "utf8"), process.execPath);
    assert.equal(process.title, "pi");
  } finally {
    process.title = previousTitle;
  }
  assert.equal(first.tools.length, 1);
  assert.equal(first.tools[0].name, "skill_read");
  assert.equal(first.tools[0].label, "skill_read");
  assert.equal(first.tools[0].executionMode, "sequential");
  const selections = [];
  const toolResult = await first.tools[0].execute(
    "tool-call-one",
    { name: "sample" },
    new AbortController().signal,
    () => {},
    {
      ui: {
        async select(title, options, settings) {
          selections.push({ title, options, settings });
          return "stable";
        },
      },
    },
  );
  assert.deepEqual(selections, [{
    title: "Version",
    options: ["stable", "next"],
    settings: { timeout: 10 * 60 * 1000 },
  }]);
  assert.deepEqual(toolResult, {
    content: [{ type: "text", text: "selected:stable;secret:absent" }],
    details: { choice: "stable" },
  });
  const productConfirmationResult = await first.tools[0].execute(
    "tool-call-product-confirmation",
    { name: "product-confirmation" },
    new AbortController().signal,
    () => {},
    {
      ui: {
        async select(title, options, settings) {
          assert.equal(title, "[[shoggoth-product-confirmation]]确认修改");
          assert.deepEqual(options, ["确认执行", "取消"]);
          assert.equal(settings, undefined);
          return "确认执行";
        },
      },
    },
  );
  assert.deepEqual(productConfirmationResult, {
    content: [{ type: "text", text: "selected:确认执行;secret:absent" }],
    details: { choice: "确认执行" },
  });
  const approve = first.handlers.get("tool_call");
  assert.equal(typeof approve, "function");
  let confirmationCount = 0;
  assert.deepEqual(await approve(
    { toolName: "bash", input: { command: "touch output" } },
    {
      cwd: scratch,
      ui: { async confirm() { confirmationCount += 1; return false; } },
    },
  ), { block: true, reason: "The user declined this tool call." });
  assert.equal(confirmationCount, 1);
  assert.equal(await approve(
    { toolName: "read", input: { path: "README.md" } },
    { cwd: scratch, ui: { async confirm() { throw new Error("unexpected prompt"); } } },
  ), undefined);
  first.handlers.get("session_shutdown")();

  setBridgeEnvironment(path.join(scratch, "missing-relay.cjs"), {
    approvalPolicy: "on-request",
    sandbox: "danger-full-access",
  });
  const failedPreviousTitle = process.title;
  process.title = "pi";
  try {
    await assert.rejects(extension(fakePi().api), /Shoggoth MCP process (?:failed|closed)/u);
    assert.equal(process.title, "pi");
  } finally {
    process.title = failedPreviousTitle;
  }

  setBridgeEnvironment(helperPath, {
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  });
  const second = fakePi();
  await extension(second.api);
  const workspaceGuard = second.handlers.get("tool_call");
  assert.deepEqual(await workspaceGuard(
    { toolName: "write", input: { path: path.join(os.tmpdir(), "outside.txt") } },
    { cwd: scratch, ui: { async confirm() { return true; } } },
  ), { block: true, reason: "The target path is outside the authorized workspace." });
  assert.equal(await workspaceGuard(
    { toolName: "write", input: { path: path.join(scratch, "inside.txt") } },
    { cwd: scratch, ui: { async confirm() { return true; } } },
  ), undefined);
  second.handlers.get("session_shutdown")();

  console.log("PASS Pi trusted extension MCP, elicitation and permission bridge");
} finally {
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
