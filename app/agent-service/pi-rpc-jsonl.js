"use strict";

const { serviceError } = require("./security");

const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_STREAM_BYTES = 32 * 1024 * 1024;

function rpcError(code, message) {
  return serviceError(code, message);
}

function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function validatePiRpcMessage(value) {
  return plain(value) && typeof value.type === "string" && value.type.length > 0
    && value.type.length <= 128 && value.type.isWellFormed() && !value.type.includes("\0");
}

class PiRpcJsonlDecoder {
  constructor(options = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.maxStreamBytes = options.maxStreamBytes ?? DEFAULT_MAX_STREAM_BYTES;
    if (!Number.isSafeInteger(this.maxFrameBytes) || this.maxFrameBytes < 1024
      || !Number.isSafeInteger(this.maxStreamBytes)
      || this.maxStreamBytes < this.maxFrameBytes || this.maxStreamBytes > 256 * 1024 * 1024) {
      throw rpcError("PI_RPC_DECODER_OPTIONS_INVALID", "Pi RPC decoder limits are invalid");
    }
    this.buffer = Buffer.alloc(0);
    this.totalBytes = 0;
    this.finished = false;
    this.textDecoder = new TextDecoder("utf-8", { fatal: true });
  }

  push(chunk) {
    if (this.finished) throw rpcError("PI_RPC_STREAM_CLOSED", "Pi RPC stream is closed");
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.totalBytes += incoming.length;
    if (this.totalBytes > this.maxStreamBytes) {
      throw rpcError("PI_RPC_STREAM_TOO_LARGE", "Pi RPC stream exceeds its limit");
    }
    this.buffer = Buffer.concat([this.buffer, incoming]);
    const messages = [];
    let newline;
    while ((newline = this.buffer.indexOf(0x0a)) >= 0) {
      if (newline > this.maxFrameBytes) {
        throw rpcError("PI_RPC_FRAME_TOO_LARGE", "Pi RPC frame exceeds its limit");
      }
      let frame = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (frame.length > 0 && frame[frame.length - 1] === 0x0d) frame = frame.subarray(0, -1);
      if (frame.length === 0) throw rpcError("PI_RPC_FRAME_INVALID", "Pi RPC emitted an empty frame");
      let value;
      try { value = JSON.parse(this.textDecoder.decode(frame)); } catch {
        throw rpcError("PI_RPC_FRAME_INVALID", "Pi RPC emitted malformed JSON");
      }
      if (!validatePiRpcMessage(value)) {
        throw rpcError("PI_RPC_FRAME_INVALID", "Pi RPC emitted an invalid message");
      }
      messages.push(value);
    }
    if (this.buffer.length > this.maxFrameBytes) {
      throw rpcError("PI_RPC_FRAME_TOO_LARGE", "Pi RPC frame exceeds its limit");
    }
    return messages;
  }

  finish() {
    if (this.finished) return [];
    this.finished = true;
    if (this.buffer.length !== 0) {
      throw rpcError("PI_RPC_FRAME_TRUNCATED", "Pi RPC stream ended mid-frame");
    }
    return [];
  }
}

function encodePiRpcCommand(value) {
  if (!plain(value) || typeof value.type !== "string" || value.type.length === 0) {
    throw rpcError("PI_RPC_COMMAND_INVALID", "Pi RPC command is invalid");
  }
  const encoded = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > DEFAULT_MAX_FRAME_BYTES) {
    throw rpcError("PI_RPC_COMMAND_TOO_LARGE", "Pi RPC command exceeds its limit");
  }
  return encoded;
}

module.exports = {
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_MAX_STREAM_BYTES,
  PiRpcJsonlDecoder,
  encodePiRpcCommand,
  validatePiRpcMessage,
};
