"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  collectTranscriptReferencedArtifacts, extractPathCandidates, resolveCandidate,
} = require("./session-artifact-references");

const WRITE_TOOLS = new Set([
  "write", "writefile", "writetofile", "edit", "editfile", "multiedit", "filechange",
  "replacefilecontent", "multireplacefilecontent", "applypatch", "savefile", "createfile",
]);
const PRODUCE_TOOLS = new Set([
  "generateimage", "imagegen", "renderimage", "renderpdf", "exportfile", "downloadfile",
]);
const PATH_KEYS = ["path", "file_path", "filePath", "filename", "file", "TargetFile", "target_file"];
const OUTPUT_KEYS = ["output_path", "outputPath", "output_file", "outputFile", "OutputFile", "destination"];

function strings(value, result = []) {
  if (result.length >= 256) return result;
  if (typeof value === "string" && Buffer.byteLength(value) <= 64 * 1024) result.push(value);
  else if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      strings(item, result);
      if (result.length >= 256) break;
    }
  }
  return result;
}

function toolKey(event) {
  const id = event.content?.toolCallId || event.content?.itemId;
  return id ? `${event.runId || ""}\0${id}` : null;
}

function successful(tool) {
  if (!tool || tool.success === false || tool.isError === true || tool.is_error === true
    || tool.errorCode || (Number.isInteger(tool.exitCode) && tool.exitCode !== 0)
    || ["failed", "error", "cancelled", "denied"].includes(tool.status)) return false;
  return tool.success === true || ["completed", "succeeded", "success"].includes(tool.status);
}

function toolName(tool) {
  return String(tool?.name || tool?.kind || "").split(/(?:__|[./])/u).at(-1).replace(/[_-]/gu, "").toLowerCase();
}

function shellOutputTargets(command) {
  if (typeof command !== "string" || /\$\(|`/u.test(command)) return [];
  const tokens = command.split(/\r?\n/u)[0]
    .match(/"(?:\\.|[^"\\])*"|'[^']*'|\d*>{1,2}|<{1,2}|[|;&]|[^\s"'<>|;&]+/gu) || [];
  const literal = (token) => token?.replace(/^["']|["']$/gu, "");
  const executable = path.basename(literal(tokens[0]) || "");
  if (["cp", "mv", "ln", "install", "rsync"].includes(executable)
    || (executable === "cat" && !tokens.includes("<<"))) return [];
  const outputs = [];
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if ([">", ">>", "1>", "1>>"].includes(tokens[i])) outputs.push(literal(tokens[i + 1]));
    if (executable === "curl" && ["-o", "--output"].includes(tokens[i])) outputs.push(literal(tokens[i + 1]));
    if (executable === "wget" && ["-O", "--output-document"].includes(tokens[i])) outputs.push(literal(tokens[i + 1]));
  }
  return outputs;
}

function outputTargets(tool) {
  const args = tool.displayArgs || {};
  const name = toolName(tool);
  const writes = WRITE_TOOLS.has(name) || ["edit", "fileChange"].includes(tool.kind);
  const targets = [];
  if (writes) {
    if (!Array.isArray(args.changes)) {
      for (const key of PATH_KEYS) if (typeof args[key] === "string") targets.push(args[key]);
    }
    for (const change of Array.isArray(args.changes) ? args.changes : []) {
      if (!["delete", "deleted", "remove"].includes(change.kind?.type || change.kind)) {
        for (const key of PATH_KEYS) if (typeof change[key] === "string") targets.push(change[key]);
      }
    }
    // Patch bodies contain input text too; only their file headers are outputs.
    for (const match of String(args.patch || args.input || "").matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gmu)) {
      targets.push(match[1]);
    }
  }
  const produces = (writes && (!Array.isArray(args.changes) || targets.length > 0)) || PRODUCE_TOOLS.has(name);
  if (produces) {
    for (const key of OUTPUT_KEYS) if (typeof args[key] === "string") targets.push(args[key]);
  }
  // Only literal shell destinations count. Merely reading, listing or copying
  // an input file, or mentioning a directory in a command, is not output proof.
  if (["command", "commandexecution", "runcommand", "exec", "execcommand", "bash", "shell", "terminal"].includes(name)) {
    targets.push(...shellOutputTargets(args.command || args.CommandLine || args.cmd));
  }
  return { targets, produces };
}

function historyResultTool(message, content) {
  const text = strings(content).join("\n");
  let result = content && typeof content === "object" && !Array.isArray(content) ? content : {};
  try { result = JSON.parse(text) || result; } catch { /* Most tools return plain text. */ }
  const details = message.details || {};
  const status = message.status || details.status || result.status;
  const exitCode = details.exitCode ?? result.exitCode ?? result.exit_code;
  const failed = message.isError === true || message.is_error === true
    || result.success === false || Boolean(result.error)
    || (Number.isInteger(exitCode) && exitCode !== 0)
    || ["failed", "error", "cancelled", "denied"].includes(status)
    || /^\s*(?:error|exception|traceback)\b/iu.test(text);
  return { name: message.tool_name || message.toolName || message.name,
    success: !failed, status, exitCode, resultSummary: text };
}

// Convert canonical chat messages (OpenClaw/Hermes and imported native history)
// into the same call/result pairs used by native transcripts. Never pair by order.
function sessionArtifactHistory(messages, sessionCreatedAt) {
  const events = [];
  const runs = [];
  let run = null;
  for (const message of messages) {
    if (!message || message.display_kind === "hidden") continue;
    const rawTime = Number(message.timestamp ?? message.createdAt);
    const occurredAt = Number.isFinite(rawTime) && rawTime > 0
      ? Math.round(rawTime < 1e12 ? rawTime * 1000 : rawTime) : null;
    const parts = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
    const toolResultEnvelope = parts.some((part) => ["tool_result", "toolResult"].includes(part?.type));
    if (message.role === "user" && !toolResultEnvelope) {
      run = { id: `history-${runs.length}`, startedAt: occurredAt || sessionCreatedAt };
      runs.push(run);
    }
    if (!run) continue; // A truncated leading turn has no trustworthy input boundary.
    if (occurredAt) run.finishedAt = Math.max(run.finishedAt || run.startedAt, occurredAt);
    const emit = (kind, content) => events.push({ kind, content, runId: run.id,
      occurredAt: occurredAt || run.finishedAt || run.startedAt });
    if (message.role === "user" && !toolResultEnvelope) {
      emit("user", { text: message.content, attachments: message.attachments || message.shoggoth?.attachments });
      continue;
    }
    if (["tool", "toolResult"].includes(message.role)) {
      emit("tool_result", { toolCallId: message.tool_call_id || message.toolCallId,
        tool: historyResultTool(message, message.content) });
    }
    for (const part of [...parts, ...(message.tool_calls || []).map((call) => ({
      type: "toolCall", id: call.id, name: call.function?.name || call.name,
      arguments: call.function?.arguments || call.arguments,
    }))]) {
      if (["toolCall", "tool_use"].includes(part?.type) && message.role === "assistant") {
        let args = part.arguments || part.input;
        if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
        emit("tool_call", { toolCallId: part.id || part.toolCallId,
          tool: { name: part.toolName || part.name, displayArgs: args } });
      } else if (["toolResult", "tool_result"].includes(part?.type)) {
        emit("tool_result", { toolCallId: part.toolCallId || part.tool_use_id,
          tool: historyResultTool(part, part.content) });
      } else if (message.role === "assistant" && part?.type === "text") {
        emit("assistant", { text: part.text });
      }
    }
  }
  return { events, runs };
}

async function collectSessionOutputArtifacts(options) {
  const { workspace, runtimeHome, sessionCreatedAt } = options;
  let events = options.events || [];
  let runs = options.runs || [];
  const imported = events.filter((event) => event.content?.historyItem);
  if (imported.length) {
    const history = sessionArtifactHistory(imported.map((event) => ({
      ...(event.content.historyItem.payload?.message || event.content.historyItem),
      timestamp: event.occurredAt,
    })), sessionCreatedAt);
    events = [...events.filter((event) => !event.content?.historyItem),
      ...history.events];
    runs = [...runs, ...history.runs];
  }
  const resolve = (value) => resolveCandidate(value, workspace, runtimeHome)
    || (typeof value === "string" && !path.isAbsolute(value) && !/[\r\n\0]|:\/\//u.test(value)
      ? resolveCandidate(`./${value}`, workspace, runtimeHome) : null);
  const canonicalPaths = new Map();
  const canonical = (value) => {
    if (canonicalPaths.has(value)) return canonicalPaths.get(value);
    if (canonicalPaths.size >= 2000) throw new Error("Session artifact path budget exceeded");
    let real = value;
    try { real = fs.realpathSync(value); } catch { /* Missing paths are discarded below. */ }
    canonicalPaths.set(value, real);
    return real;
  };
  const pathsIn = (value) => strings(value).flatMap(extractPathCandidates)
    .map(resolve).filter(Boolean);
  const attachments = new Map();
  const inputs = new Map();
  const rememberInput = (set, file, event) => {
    const real = canonical(file);
    set.set(real, Math.min(set.get(real) ?? Infinity, event.occurredAt ?? sessionCreatedAt));
  };
  const wasInput = (set, file, event) => (set.get(canonical(file)) ?? Infinity)
    <= (event.occurredAt ?? sessionCreatedAt);
  const calls = new Map();
  for (const event of events) {
    if (event.kind === "user") {
      for (const file of pathsIn(event.content)) rememberInput(inputs, file, event);
      for (const file of pathsIn(event.content?.attachments)) rememberInput(attachments, file, event);
    }
    if (event.kind === "tool_call" && toolKey(event)) calls.set(toolKey(event), event);
  }
  const outputs = [];
  const opaqueWrites = new Map();
  const emit = (event, files) => {
    for (const file of files) {
      const resolved = resolve(file);
      if (!resolved || wasInput(attachments, resolved, event)) continue;
      try { if (!fs.lstatSync(resolved).isFile()) continue; } catch { continue; }
      outputs.push({ ...event, kind: "artifact", content: { path: resolved } });
    }
  };
  for (const event of events) {
    if (event.kind === "artifact") emit(event, pathsIn(event.content));
    if (event.kind !== "tool_result") continue;
    const call = calls.get(toolKey(event));
    const tool = { ...call?.content?.tool, ...event.content?.tool,
      name: event.content?.tool?.name || call?.content?.tool?.name,
      displayArgs: event.content?.tool?.displayArgs || call?.content?.tool?.displayArgs };
    const { targets, produces } = outputTargets(tool);
    if (!produces && !targets.length) {
      for (const file of pathsIn(tool.displayArgs)) rememberInput(inputs, file, event);
    }
    if (!successful(tool)) continue;
    emit(event, targets);
    if (produces && !targets.length && event.runId) opaqueWrites.set(event.runId,
      Math.min(opaqueWrites.get(event.runId) ?? Infinity, event.occurredAt ?? sessionCreatedAt));
  }
  for (const event of events) {
    // Older runtimes omitted write arguments. Recover explicit delivery paths
    // only when this very turn contains a successful producing tool.
    if (event.kind === "assistant" && event.content?.phase !== "commentary"
      && (opaqueWrites.get(event.runId) ?? Infinity) <= (event.occurredAt ?? sessionCreatedAt)) {
      emit(event, pathsIn(event.content?.text).filter((file) => !wasInput(inputs, file, event)));
    }
  }
  return collectTranscriptReferencedArtifacts({ ...options, runs, events: outputs,
    allowDirectories: false, mtimeOnly: true });
}

module.exports = { collectSessionOutputArtifacts, sessionArtifactHistory };
