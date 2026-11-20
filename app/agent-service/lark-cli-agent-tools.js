"use strict";

const { validateHookToolArguments } = require("./hook-tool-schema");
const { serviceError } = require("./security");
const { LARK_CLI_PUBLIC_MESSAGES } = require("../core/lark-cli-contract");

const LARK_AGENT_SERVER_ID = "shoggoth-lark-cli";
const token = { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" };
const label = { type: "string", minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" };
const cellValue = { type: ["string", "number", "boolean", "null"], maxLength: 4096 };
const cellLink = { type: "object", required: ["text", "link"], additionalProperties: false,
  properties: { text: label, link: { type: "string", pattern: "^https?://[^\\s]+$", maxLength: 2048 } } };
const rows = cell => ({ type: "array", minItems: 1, maxItems: 200,
  items: { type: "array", minItems: 1, maxItems: 50, items: cell } });
const tool = (name, description, properties, required = Object.keys(properties)) => ({
  name, description, inputSchema: { type: "object", properties, required, additionalProperties: false },
});

const account = tool("lark_account_status",
  "Verify the account connected in Shoggoth's Feishu/Lark settings. A verified login does not guarantee access to a particular workbook or write permission.", {});
const info = tool("lark_sheets_workbook_info",
  "Read the workbook structure and worksheet IDs using the connected Feishu/Lark account.", { spreadsheetToken: token });
const create = tool("lark_sheets_create_workbook",
  "Create a Feishu/Lark spreadsheet, optionally with initial rows. Include any header in the first row. Inspect the result for partial success before deciding how to finish the write.", {
    title: label,
    values: rows(cellValue),
  }, ["title"]);
const write = tool("lark_sheets_write_cells",
  "Write values or labeled {text,link} hyperlinks to a worksheet. Resolve the worksheet ID with lark_sheets_workbook_info. Existing cells are protected unless allowOverwrite is explicitly true.", {
    spreadsheetToken: token, sheetId: token, startCell: { type: "string", pattern: "^[A-Z]{1,3}[1-9][0-9]{0,6}$" },
    values: rows({ anyOf: [cellValue, cellLink] }), allowOverwrite: { type: "boolean" },
  }, ["spreadsheetToken", "sheetId", "startCell", "values"]);
const createBase = tool("lark_base_create",
  "Create a Feishu/Lark Base with a named first table and the specified fields. Use this when the user wants a Base or 多维表格.", {
    name: label, tableName: label,
    fields: { type: "array", minItems: 1, maxItems: 50, items: {
      type: "object", required: ["name", "type"], additionalProperties: false,
      properties: { name: label, type: { enum: ["text", "number", "url", "checkbox"] } },
    } },
  });
const addRecords = tool("lark_base_add_records",
  "Add records to the exact Base table. Use its known writable field names as keys. Each value must be text, a number, a boolean or null.", {
    baseToken: token, tableId: { type: "string", pattern: "^tbl[A-Za-z0-9_-]{1,125}$" },
    records: { type: "array", minItems: 1, maxItems: 200, items: {
      type: "object", minProperties: 1, maxProperties: 50, propertyNames: label, additionalProperties: cellValue,
    } },
  });
const LARK_AGENT_TOOLS = Object.freeze([account, info, create, write, createBase, addRecords]);
const larkAgentWrite = name => LARK_AGENT_TOOLS.some(item => item.name === name && item !== account && item !== info);

function json(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function result(value, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

function rejected(code) {
  return result({ code, message: LARK_CLI_PUBLIC_MESSAGES[code], retryAllowed: false }, true);
}

function larkAgentTool(name, args) {
  const definition = LARK_AGENT_TOOLS.find(item => item.name === name);
  if (!definition) throw serviceError("MCP_TOOL_NOT_FOUND", "Unknown Feishu tool");
  if (!validateHookToolArguments(definition.inputSchema, args)
    || Buffer.byteLength(JSON.stringify(args)) > 10 * 1024 || (typeof args.title === "string" && !args.title.trim())) {
    throw serviceError("MCP_TOOL_INVALID_ARGUMENTS", "Invalid Feishu tool arguments");
  }
  return definition;
}

async function runLarkAgentTool(name, args, run) {
  const definition = larkAgentTool(name, args);
  let argv, input;
  if (definition === account) {
    argv = ["auth", "status", "--json", "--verify"];
  } else if (definition === createBase) {
    argv = ["base", "+base-create", "--as", "user", "--format", "json",
      `--name=${args.name}`, `--table-name=${args.tableName}`, `--fields=${JSON.stringify(args.fields)}`];
  } else if (definition === addRecords) {
    argv = ["base", "+record-batch-create", "--as", "user", "--format", "json",
      `--base-token=${args.baseToken}`, `--table-id=${args.tableId}`, `--json=${JSON.stringify({ create_records: args.records })}`];
  } else {
    argv = ["sheets", definition === info ? "+workbook-info" : definition === create ? "+workbook-create" : "+cells-set", "--as", "user", "--json"];
    if (definition === create) {
      argv.push(`--title=${args.title}`);
      if (args.values) { argv.push("--values=-"); input = JSON.stringify(args.values); }
    } else {
      argv.push(`--spreadsheet-token=${args.spreadsheetToken}`);
      if (definition === write) {
        argv.push(`--sheet-id=${args.sheetId}`, `--range=${args.startCell}`, "--cells=-",
          `--allow-overwrite=${args.allowOverwrite === true}`);
        input = JSON.stringify(args.values.map(row => row.map(value => value && typeof value === "object"
          ? { rich_text: [{ type: "link", text: value.text, link: value.link }] }
          : { value })));
      }
    }
  }
  const { stdout, stderr, exitCode } = await run(argv, input);
  const payload = json(stdout);
  const error = payload?.error || json(stderr)?.error;
  if (definition === account && exitCode === 0 && payload?.identities?.user) {
    const { available, verified } = payload.identities.user;
    return result({ authorized: available === true && verified === true, verification: verified === true ? "verified" : "unverified" });
  }
  if (error?.subtype === "not_configured" || error?.type === "auth") return rejected("LARK_CLI_AUTH_FAILED");
  if (error?.type === "missing_scope") return rejected("LARK_CLI_SCOPE_REQUIRED");
  if (payload?.ok === true && exitCode === 0 && payload.data !== undefined) return result(payload.data);
  if (larkAgentWrite(name)) throw serviceError("MCP_TOOL_COMMIT_UNCERTAIN", "Feishu write outcome requires verification");
  return rejected(definition === account ? "LARK_CLI_AUTH_STATUS_FAILED" : "LARK_CLI_ACTION_FAILED");
}

module.exports = { LARK_AGENT_SERVER_ID, LARK_AGENT_TOOLS, larkAgentTool, larkAgentWrite, runLarkAgentTool };
