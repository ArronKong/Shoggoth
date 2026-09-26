"use strict";

const { TextDecoder } = require("node:util");
const { serviceError } = require("./security");

const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_STREAM_BYTES = 32 * 1024 * 1024;

function transportError(code, message) {
  return serviceError(code, message);
}

function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

class DeepSeekHarnessJsonlDecoder {
  constructor(options = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.maxStreamBytes = options.maxStreamBytes ?? DEFAULT_MAX_STREAM_BYTES;
    if (!Number.isSafeInteger(this.maxFrameBytes) || this.maxFrameBytes < 1024
      || !Number.isSafeInteger(this.maxStreamBytes)
      || this.maxStreamBytes < this.maxFrameBytes || this.maxStreamBytes > 256 * 1024 * 1024) {
      throw transportError(
        "DEEPSEEK_HARNESS_DECODER_OPTIONS_INVALID",
        "DeepSeek decoder limits are invalid",
      );
    }
    this.buffer = Buffer.alloc(0);
    this.totalBytes = 0;
    this.finished = false;
    this.decoder = new TextDecoder("utf-8", { fatal: true });
  }

  push(chunk) {
    if (this.finished) {
      throw transportError("DEEPSEEK_HARNESS_STREAM_CLOSED", "DeepSeek stream is closed");
    }
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.totalBytes += incoming.length;
    if (this.totalBytes > this.maxStreamBytes) {
      throw transportError(
        "DEEPSEEK_HARNESS_STREAM_TOO_LARGE",
        "DeepSeek stream exceeds its limit",
      );
    }
    this.buffer = Buffer.concat([this.buffer, incoming]);
    const messages = [];
    let newline;
    while ((newline = this.buffer.indexOf(0x0a)) >= 0) {
      if (newline > this.maxFrameBytes) {
        throw transportError(
          "DEEPSEEK_HARNESS_FRAME_TOO_LARGE",
          "DeepSeek frame exceeds its limit",
        );
      }
      let frame = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (frame.length > 0 && frame[frame.length - 1] === 0x0d) frame = frame.subarray(0, -1);
      if (frame.length === 0) {
        throw transportError("DEEPSEEK_HARNESS_FRAME_INVALID", "DeepSeek emitted an empty frame");
      }
      let value;
      try { value = JSON.parse(this.decoder.decode(frame)); } catch {
        throw transportError(
          "DEEPSEEK_HARNESS_FRAME_INVALID",
          "DeepSeek emitted malformed JSON",
        );
      }
      if (!plain(value) || typeof value.type !== "string" || value.type.length === 0) {
        throw transportError(
          "DEEPSEEK_HARNESS_FRAME_INVALID",
          "DeepSeek emitted an invalid message",
        );
      }
      messages.push(value);
    }
    if (this.buffer.length > this.maxFrameBytes) {
      throw transportError(
        "DEEPSEEK_HARNESS_FRAME_TOO_LARGE",
        "DeepSeek frame exceeds its limit",
      );
    }
    return messages;
  }

  finish() {
    if (this.finished) return [];
    this.finished = true;
    if (this.buffer.length !== 0) {
      throw transportError(
        "DEEPSEEK_HARNESS_FRAME_TRUNCATED",
        "DeepSeek stream ended mid-frame",
      );
    }
    return [];
  }
}

function encodeDeepSeekHarnessMessage(value) {
  if (!plain(value) || typeof value.type !== "string" || value.type.length === 0) {
    throw transportError(
      "DEEPSEEK_HARNESS_COMMAND_INVALID",
      "DeepSeek command is invalid",
    );
  }
  const encoded = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > DEFAULT_MAX_FRAME_BYTES) {
    throw transportError(
      "DEEPSEEK_HARNESS_COMMAND_TOO_LARGE",
      "DeepSeek command exceeds its limit",
    );
  }
  return encoded;
}

module.exports = {
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_MAX_STREAM_BYTES,
  DeepSeekHarnessJsonlDecoder,
  encodeDeepSeekHarnessMessage,
};
