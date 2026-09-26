"use strict";

// No package manager, external modules, network, shell or model SDK is used.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const URI = "ui://local-notes/editor";
const MIME = "text/html;profile=mcp-app";
const MAX_TEXT = 16 * 1024, MAX_FILE = MAX_TEXT * 6 + 256, MAX_FRAME = 128 * 1024;
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, fields) => plain(value) && Object.keys(value).length === fields.length
  && fields.every(field => Object.hasOwn(value, field));
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const invalid = () => { throw new Error("笔记数据不可用，请检查当前连接的数据目录。"); };
const same = (a, b) => ["dev", "ino", "uid", "mode", "nlink", "size", "mtimeMs", "ctimeMs"]
  .every(key => a[key] === b[key]);

const TOOL_UI = { resourceUri: URI, visibility: ["model", "app"] };
const TOOLS = [
  { name: "read_note", description: "Read the local note and its current revision. This does not modify data.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "Read local note", readOnlyHint: true, destructiveHint: false,
      idempotentHint: true, openWorldHint: false }, _meta: { ui: TOOL_UI } },
  { name: "write_note", description: "Replace the local note after explicit user authorization. Requires the revision from read_note; an empty text clears it.",
    inputSchema: { type: "object", properties: { text: { type: "string", maxLength: MAX_TEXT },
      expectedRevision: { type: "integer", minimum: 0, maximum: 2147483646 } },
    required: ["text", "expectedRevision"], additionalProperties: false },
    annotations: { title: "Save local note", readOnlyHint: false, destructiveHint: true,
      idempotentHint: false, openWorldHint: false }, _meta: { ui: TOOL_UI } },
];

function dataDirectory() {
  const selected = process.env.PLUGIN_DATA;
  if (typeof selected !== "string" || !path.isAbsolute(selected)) invalid();
  const stat = fs.lstatSync(selected);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) invalid();
  return fs.realpathSync(selected);
}
function readNote(directory) {
  const file = path.join(directory, "note.json");
  let before;
  try { before = fs.lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return { note: { revision: 0, text: "" }, digest: null }; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_FILE
    || (before.mode & 0o077) !== 0 || (typeof process.getuid === "function" && before.uid !== process.getuid())) invalid();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!same(before, fs.fstatSync(fd))) invalid();
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break; length += count;
    }
    if (length !== before.size || !same(before, fs.fstatSync(fd)) || !same(before, fs.lstatSync(file))) invalid();
    const bytes = buffer.subarray(0, length), note = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!exact(note, ["revision", "text"]) || !Number.isSafeInteger(note.revision) || note.revision < 0
      || note.revision > 2147483647 || typeof note.text !== "string" || !note.text.isWellFormed()
      || Buffer.byteLength(note.text) > MAX_TEXT) invalid();
    return { note, digest: digest(bytes) };
  } finally { fs.closeSync(fd); }
}
function writeNote(directory, args) {
  if (!exact(args, ["text", "expectedRevision"]) || typeof args.text !== "string" || !args.text.isWellFormed()
    || Buffer.byteLength(args.text) > MAX_TEXT || !Number.isSafeInteger(args.expectedRevision)
    || args.expectedRevision < 0 || args.expectedRevision > 2147483646) {
    throw new Error("写入参数无效：需要不超过 16 KiB 的 text 和最新 expectedRevision。");
  }
  const original = readNote(directory);
  if (original.note.revision !== args.expectedRevision) throw new Error("笔记版本已变化，请重新读取后再确认写入。");
  const note = { revision: args.expectedRevision + 1, text: args.text };
  const temporary = path.join(directory, `.note-${crypto.randomUUID()}.json`);
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try {
    try { fs.writeFileSync(fd, `${JSON.stringify(note)}\n`); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    if (readNote(directory).digest !== original.digest) throw new Error("笔记版本已变化，请重新读取后再确认写入。");
    fs.renameSync(temporary, path.join(directory, "note.json"));
    const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    return note;
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function toolResult(note, saved = false) {
  return { content: [{ type: "text", text: `${saved ? "已保存。\n" : ""}${note.text || "笔记为空。"}\n\n版本：${note.revision}` }],
    structuredContent: { note }, isError: false };
}
function callTool(params) {
  if (!plain(params) || Object.keys(params).some(key => !["name", "arguments"].includes(key))) {
    return { content: [{ type: "text", text: "工具参数无效。" }], isError: true };
  }
  try {
    const args = Object.hasOwn(params, "arguments") ? params.arguments : {}, directory = dataDirectory();
    if (params.name === "read_note" && exact(args, [])) return toolResult(readNote(directory).note);
    if (params.name === "write_note") return toolResult(writeNote(directory, args), true);
    throw new Error("工具名称或参数无效。");
  } catch (error) {
    // Never reflect filesystem paths, Node errors, or environment values.
    const known = ["笔记版本已变化，请重新读取后再确认写入。", "工具名称或参数无效。",
      "写入参数无效：需要不超过 16 KiB 的 text 和最新 expectedRevision。"];
    return { content: [{ type: "text", text: known.includes(error.message) ? error.message : "笔记数据不可用，请检查当前连接的数据目录。" }], isError: true };
  }
}

let initialized = false, ready = false;
function handle(message) {
  if (!plain(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string"
    || message.method.length > 128 || Object.keys(message).some(key => !["jsonrpc", "method", "params", "id"].includes(key))) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
  }
  const request = Object.hasOwn(message, "id");
  if (request && !(Number.isSafeInteger(message.id) || (typeof message.id === "string" && message.id.length <= 96))) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request id" } };
  }
  const result = value => ({ jsonrpc: "2.0", id: message.id, result: value });
  const error = (code, text) => request ? { jsonrpc: "2.0", id: message.id, error: { code, message: text } } : null;
  if (message.method === "initialize" && request && !initialized && plain(message.params)) {
    initialized = true;
    return result({ protocolVersion: "2025-11-25", serverInfo: { name: "local-notes", version: "1.0.0" },
      capabilities: { tools: {}, resources: {} } });
  }
  if (message.method === "notifications/initialized" && !request && initialized) { ready = true; return null; }
  if (message.method === "notifications/cancelled" && !request) return null;
  if (!request) return null;
  if (!ready) return error(-32002, "Initialize the connection first");
  if (message.method === "ping") return result({});
  if (message.method === "tools/list") return result({ tools: TOOLS });
  if (message.method === "tools/call") return result(callTool(message.params));
  if (message.method === "resources/read") {
    if (!exact(message.params, ["uri"]) || message.params.uri !== URI) return error(-32602, "Unknown resource");
    const html = fs.readFileSync(path.join(__dirname, "../ui/notes.html"), "utf8");
    return result({ contents: [{ uri: URI, mimeType: MIME, text: html,
      _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } } }] });
  }
  return error(-32601, "Method not found");
}

process.stdout.on("error", () => process.exit(0));
let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf("\n")) !== -1) {
    const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
    if (Buffer.byteLength(line) > MAX_FRAME) { process.exitCode = 1; process.stdin.destroy(); return; }
    let response;
    try { response = handle(JSON.parse(line)); }
    catch { response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON or unavailable resource" } }; }
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
  if (Buffer.byteLength(buffered) > MAX_FRAME) { process.exitCode = 1; process.stdin.destroy(); }
});
