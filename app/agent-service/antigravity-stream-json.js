"use strict";

const { StringDecoder } = require("node:string_decoder");
const { serviceError } = require("./security");

const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_STREAM_BYTES = 16 * 1024 * 1024;
const RESULT_STATUSES = new Set([
  "SUCCESS", "ERROR", "CANCELED", "INTERRUPTED", "INVALID", "WAITING", "RUNNING",
]);
const STEP_STATES = new Set(["ACTIVE", "DONE", "ERROR"]);
const USAGE_FIELDS = Object.freeze([
  "input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens", "total_tokens",
]);

function protocolError(code, message) {
  return serviceError(code, message);
}

function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function safeString(value, maxBytes, { empty = false } = {}) {
  return typeof value === "string" && (empty || value.length > 0) && value.isWellFormed()
    && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function optionalString(value, maxBytes, options) {
  return value === undefined || value === null || safeString(value, maxBytes, options);
}

function validUsage(value) {
  return plain(value) && USAGE_FIELDS.every((field) => (
    Number.isSafeInteger(value[field]) && value[field] >= 0
  ));
}

function validJsonValue(value, maxBytes = 256 * 1024) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= maxBytes;
  } catch {
    return false;
  }
}

function validateInit(value) {
  const payload = value.init;
  return safeString(value.conversation_id, 512)
    && plain(payload) && safeString(payload.cwd, 4096)
    && Array.isArray(payload.tools) && payload.tools.length <= 1024
    && payload.tools.every((tool) => safeString(tool, 256))
    && safeString(payload.permission_mode, 128)
    && optionalString(payload.model, 512)
    && optionalString(payload.agent, 512)
    && (payload.json_schema === undefined || validJsonValue(payload.json_schema));
}

function validateStep(value) {
  const payload = value.step_update;
  return plain(payload) && safeString(payload.conversation_id, 512)
    && Number.isSafeInteger(payload.step_index) && payload.step_index >= 0
    && STEP_STATES.has(payload.state) && safeString(payload.step_type, 128)
    && optionalString(payload.tool_name, 256)
    && optionalString(payload.text_delta, 1024 * 1024, { empty: true })
    && (payload.duration_seconds === undefined
      || (typeof payload.duration_seconds === "number" && Number.isFinite(payload.duration_seconds)
        && payload.duration_seconds >= 0))
    && (payload.usage === undefined || validUsage(payload.usage))
    && (payload.tool_info === undefined || (plain(payload.tool_info)
      && validJsonValue(payload.tool_info)))
    && (payload.subagent_info === undefined || (plain(payload.subagent_info)
      && validJsonValue(payload.subagent_info)));
}

function validateResult(value) {
  const payload = value.result;
  return plain(payload) && safeString(payload.conversation_id, 512)
    && RESULT_STATUSES.has(payload.status)
    && safeString(payload.response, 8 * 1024 * 1024, { empty: true })
    && optionalString(payload.error, 1024 * 1024, { empty: true })
    && (payload.duration_seconds === undefined
      || (typeof payload.duration_seconds === "number" && Number.isFinite(payload.duration_seconds)
        && payload.duration_seconds >= 0))
    && Number.isSafeInteger(payload.num_turns) && payload.num_turns >= 0
    && validUsage(payload.usage);
}

function validateMessage(value) {
  if (!plain(value) || !safeString(value.event, 128)) {
    throw protocolError("ANTIGRAVITY_STREAM_EVENT_INVALID", "Antigravity stream event is invalid");
  }
  if (value.event === "init" && !validateInit(value)) {
    throw protocolError("ANTIGRAVITY_STREAM_INIT_INVALID", "Antigravity init event is invalid");
  }
  if (value.event === "step_update" && !validateStep(value)) {
    throw protocolError("ANTIGRAVITY_STREAM_STEP_INVALID", "Antigravity step event is invalid");
  }
  if (value.event === "result" && !validateResult(value)) {
    throw protocolError("ANTIGRAVITY_STREAM_RESULT_INVALID", "Antigravity result event is invalid");
  }
  return Object.freeze({ known: ["init", "step_update", "result"].includes(value.event), value });
}

class AntigravityStreamJsonDecoder {
  constructor(options = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.maxStreamBytes = options.maxStreamBytes ?? DEFAULT_MAX_STREAM_BYTES;
    if (!Number.isSafeInteger(this.maxFrameBytes) || this.maxFrameBytes < 1024
      || !Number.isSafeInteger(this.maxStreamBytes) || this.maxStreamBytes < this.maxFrameBytes) {
      throw protocolError("ANTIGRAVITY_STREAM_OPTIONS_INVALID", "Antigravity stream limits are invalid");
    }
    this.decoder = new StringDecoder("utf8");
    this.buffer = "";
    this.bytes = 0;
    this.finished = false;
  }

  push(chunk) {
    if (this.finished || (!Buffer.isBuffer(chunk) && typeof chunk !== "string")) {
      throw protocolError("ANTIGRAVITY_STREAM_STATE_INVALID", "Antigravity stream state is invalid");
    }
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    this.bytes += bytes.length;
    if (this.bytes > this.maxStreamBytes) {
      throw protocolError("ANTIGRAVITY_STREAM_TOO_LARGE", "Antigravity stream exceeds its limit");
    }
    this.buffer += this.decoder.write(bytes);
    return this._drain(false);
  }

  finish() {
    if (this.finished) {
      throw protocolError("ANTIGRAVITY_STREAM_STATE_INVALID", "Antigravity stream is already finished");
    }
    this.finished = true;
    this.buffer += this.decoder.end();
    return this._drain(true);
  }

  _drain(eof) {
    const messages = [];
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > this.maxFrameBytes) {
        throw protocolError("ANTIGRAVITY_STREAM_FRAME_TOO_LARGE", "Antigravity stream frame is too large");
      }
      if (line.trim().length === 0) continue;
      messages.push(this._parse(line));
    }
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxFrameBytes) {
      throw protocolError("ANTIGRAVITY_STREAM_FRAME_TOO_LARGE", "Antigravity stream frame is too large");
    }
    if (eof && this.buffer.length > 0) {
      const line = this.buffer.replace(/\r$/u, "");
      this.buffer = "";
      if (line.trim().length > 0) messages.push(this._parse(line));
    }
    return messages;
  }

  _parse(line) {
    let parsed;
    try { parsed = JSON.parse(line); } catch {
      throw protocolError("ANTIGRAVITY_STREAM_JSON_INVALID", "Antigravity stream JSON is malformed");
    }
    return validateMessage(parsed);
  }
}

function encodeAntigravityUserMessage(content) {
  if (!safeString(content, 8 * 1024 * 1024, { empty: true })) {
    throw protocolError("ANTIGRAVITY_STREAM_INPUT_INVALID", "Antigravity user message is invalid");
  }
  return `${JSON.stringify({ event: "user", message: { content } })}\n`;
}

module.exports = {
  AntigravityStreamJsonDecoder,
  RESULT_STATUSES,
  encodeAntigravityUserMessage,
  validUsage,
  validateMessage,
};
