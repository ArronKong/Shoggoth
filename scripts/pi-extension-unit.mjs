#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION_PATH = path.join(ROOT, "resources", "pi", "shoggoth-pi-extension.mjs");
const require = createRequire(import.meta.url);
const { MCP_PRODUCT_TOOL_DEFINITIONS, validateMcpProductToolArguments } = require(
  path.join(ROOT, "app", "agent-service", "mcp-product-tool-controller.js"),
);
const CRON_CREATE_TOOL = MCP_PRODUCT_TOOL_DEFINITIONS.find((tool) => tool.name === "cron_create");
const CRON_UPDATE_TOOL = MCP_PRODUCT_TOOL_DEFINITIONS.find((tool) => tool.name === "cron_update");
const KANBAN_CARD_UPDATE_TOOL = MCP_PRODUCT_TOOL_DEFINITIONS.find((tool) => tool.name === "kanban_card_update");
const KANBAN_LIST_TOOL = MCP_PRODUCT_TOOL_DEFINITIONS.find((tool) => tool.name === "kanban_list");
const MCP_SERVER_CALL_TOOL = MCP_PRODUCT_TOOL_DEFINITIONS.find((tool) => tool.name === "mcp_server_call");
const NATIVE_AGENT_UPDATE_TOOL = MCP_PRODUCT_TOOL_DEFINITIONS.find((tool) => tool.name === "native_agent_update");
const REQUEST_USER_INPUT_TOOL = MCP_PRODUCT_TOOL_DEFINITIONS.find((tool) => tool.name === "request_user_input");
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
          }, {
            name: "cron_create",
            description: ${JSON.stringify(CRON_CREATE_TOOL.description)},
            inputSchema: ${JSON.stringify(CRON_CREATE_TOOL.inputSchema)},
          }, {
            name: "cron_update",
            description: ${JSON.stringify(CRON_UPDATE_TOOL.description)},
            inputSchema: ${JSON.stringify(CRON_UPDATE_TOOL.inputSchema)},
          }, {
            name: "kanban_card_update",
            description: "Update a Kanban card.",
            inputSchema: ${JSON.stringify(KANBAN_CARD_UPDATE_TOOL.inputSchema)},
          }, {
            name: "kanban_list",
            description: "List Kanban items.",
            inputSchema: ${JSON.stringify(KANBAN_LIST_TOOL.inputSchema)},
          }, {
            name: "mcp_server_call",
            description: "Call a registered MCP tool.",
            inputSchema: ${JSON.stringify(MCP_SERVER_CALL_TOOL.inputSchema)},
          }, {
            name: "native_agent_update",
            description: "Update a native Agent.",
            inputSchema: ${JSON.stringify(NATIVE_AGENT_UPDATE_TOOL.inputSchema)},
          }, {
            name: "request_user_input",
            description: "Ask the user a question.",
            inputSchema: ${JSON.stringify(REQUEST_USER_INPUT_TOOL.inputSchema)},
          }],
        },
      });
    } else if (message.method === "tools/call") {
      if (message.params?.name === "cron_create") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [{ type: "text", text: "captured cron arguments" }],
            structuredContent: { arguments: message.params.arguments },
          },
        });
        continue;
      }
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
  assert.equal(first.tools.length, 8);
  const skillTool = first.tools.find((tool) => tool.name === "skill_read");
  const cronTool = first.tools.find((tool) => tool.name === "cron_create");
  const cronUpdateTool = first.tools.find((tool) => tool.name === "cron_update");
  const kanbanCardUpdateTool = first.tools.find((tool) => tool.name === "kanban_card_update");
  const kanbanListTool = first.tools.find((tool) => tool.name === "kanban_list");
  const mcpServerCallTool = first.tools.find((tool) => tool.name === "mcp_server_call");
  const nativeAgentUpdateTool = first.tools.find((tool) => tool.name === "native_agent_update");
  const requestUserInputTool = first.tools.find((tool) => tool.name === "request_user_input");
  assert.equal(skillTool.label, "skill_read");
  assert.equal(skillTool.executionMode, "sequential");
  assert.equal(cronTool.executionMode, "sequential");
  assert.match(cronTool.description, /milliseconds/u);
  assert.match(cronTool.parameters.properties.schedule.description, /milliseconds/u);
  const dueAtSeconds = Math.floor(Date.now() / 1000) + 3 * 3600 + 35 * 60;
  const malformedCronArgs = {
    name: "提醒：Claude 额度刷新",
    prompt: "提醒用户：Claude 额度已刷新。",
    workspace: "null",
    schedule: JSON.stringify({ kind: "at", at: dueAtSeconds }),
    enabled: true,
    misfirePolicy: "latest",
    maxCatchUp: 1,
    overlapPolicy: "skip",
    threadPolicy: "new",
    threadId: "null",
  };
  assert.equal(validateMcpProductToolArguments("cron_create", malformedCronArgs), false);
  assert.equal(typeof cronTool.prepareArguments, "function");
  const preparedCronArgs = cronTool.prepareArguments(malformedCronArgs);
  assert.equal(validateMcpProductToolArguments("cron_create", preparedCronArgs), true);
  assert.deepEqual(preparedCronArgs, {
    ...malformedCronArgs,
    workspace: null,
    schedule: { kind: "at", at: dueAtSeconds * 1000 },
    threadId: null,
  });
  assert.equal(typeof malformedCronArgs.schedule, "string");
  assert.equal(validateMcpProductToolArguments("cron_create", cronTool.prepareArguments({
    ...malformedCronArgs, schedule: "not JSON",
  })), false);
  assert.deepEqual(cronTool.prepareArguments({
    ...malformedCronArgs,
    workspace: "",
    schedule: { kind: "at", at: dueAtSeconds * 1000 },
    threadId: "",
  }).schedule, { kind: "at", at: dueAtSeconds * 1000 });
  const updateArgs = {
    jobId: "66666666-6666-4666-8666-666666666666",
    patch: JSON.stringify({
      schedule: JSON.stringify({ kind: "at", at: dueAtSeconds }),
      workspace: "null", threadPolicy: "new", threadId: "null",
    }),
  };
  assert.equal(typeof cronUpdateTool.prepareArguments, "function");
  const preparedUpdateArgs = cronUpdateTool.prepareArguments(updateArgs);
  assert.equal(validateMcpProductToolArguments("cron_update", preparedUpdateArgs), true);
  assert.deepEqual(preparedUpdateArgs.patch, {
    schedule: { kind: "at", at: dueAtSeconds * 1000 },
    workspace: null, threadPolicy: "new", threadId: null,
  });
  const cardArgs = {
    cardId: "66666666-6666-4666-8666-666666666666",
    patch: JSON.stringify({ title: "null", body: "null" }),
  };
  assert.equal(validateMcpProductToolArguments("kanban_card_update", cardArgs), false);
  assert.equal(typeof kanbanCardUpdateTool.prepareArguments, "function");
  const preparedCardArgs = kanbanCardUpdateTool.prepareArguments(cardArgs);
  assert.equal(validateMcpProductToolArguments("kanban_card_update", preparedCardArgs), true);
  assert.deepEqual(preparedCardArgs.patch, { title: "null", body: "null" });
  assert.equal(typeof cardArgs.patch, "string");
  const listArgs = { kind: "boards", boardId: "null", status: "null", cursor: "null", limit: 20 };
  assert.equal(validateMcpProductToolArguments("kanban_list", listArgs), false);
  assert.equal(typeof kanbanListTool.prepareArguments, "function");
  const preparedListArgs = kanbanListTool.prepareArguments(listArgs);
  assert.equal(validateMcpProductToolArguments("kanban_list", preparedListArgs), true);
  assert.deepEqual(preparedListArgs, { kind: "boards", boardId: null, status: null, cursor: null, limit: 20 });
  const nestedCallArgs = { serverId: "s", toolName: "t", arguments: JSON.stringify({ key: "value" }) };
  assert.equal(validateMcpProductToolArguments("mcp_server_call", nestedCallArgs), false);
  assert.equal(typeof mcpServerCallTool.prepareArguments, "function");
  assert.deepEqual(mcpServerCallTool.prepareArguments(nestedCallArgs).arguments, { key: "value" });
  assert.equal(validateMcpProductToolArguments(
    "mcp_server_call", mcpServerCallTool.prepareArguments(nestedCallArgs),
  ), true);
  assert.equal(validateMcpProductToolArguments("mcp_server_call", mcpServerCallTool.prepareArguments({
    ...nestedCallArgs, arguments: "not JSON",
  })), false);
  const nativeAgentArgs = {
    backendId: "shoggoth", agentId: "agent-1", source: "chat", sourceId: "s",
    expectedUpdatedAt: 0, workspace: "null",
  };
  assert.equal(validateMcpProductToolArguments("native_agent_update", nativeAgentArgs), false);
  assert.equal(validateMcpProductToolArguments(
    "native_agent_update", nativeAgentUpdateTool.prepareArguments(nativeAgentArgs),
  ), true);
  const questions = [{
    header: "Confirm", id: "choice", question: "Proceed?",
    options: JSON.stringify([
      { label: "Yes", description: "Proceed" },
      { label: "No", description: "Stop" },
    ]),
  }];
  const questionArgs = { questions: JSON.stringify(questions) };
  assert.equal(validateMcpProductToolArguments("request_user_input", questionArgs), false);
  const preparedQuestionArgs = requestUserInputTool.prepareArguments(questionArgs);
  assert.equal(validateMcpProductToolArguments("request_user_input", preparedQuestionArgs), true);
  assert.deepEqual(preparedQuestionArgs.questions[0].options, [
    { label: "Yes", description: "Proceed" },
    { label: "No", description: "Stop" },
  ]);
  assert.deepEqual((await cronTool.execute(
    "cron-call-one", preparedCronArgs, new AbortController().signal, () => {}, {},
  )).details.arguments, preparedCronArgs);
  const selections = [];
  const toolResult = await skillTool.execute(
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
  const productConfirmationResult = await skillTool.execute(
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
