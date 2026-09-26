"use strict";

const path = require("node:path");
const { serviceError } = require("./security");

let sdkPromise = null;
let mutationTail = Promise.resolve();

function sdkError(code, message) {
  return serviceError(code, message);
}

function validateSdk(value) {
  if (!value || typeof value !== "object"
    || ["query", "renameSession", "deleteSession"].some((name) => typeof value[name] !== "function")) {
    throw sdkError("CLAUDE_CODE_SDK_INVALID", "Claude Agent SDK exports are invalid");
  }
  return value;
}

function loadClaudeAgentSdk(injected) {
  if (injected !== undefined) return Promise.resolve(validateSdk(injected));
  if (!require("../runtime-availability").isRuntimeAvailable("claude-code")) {
    return Promise.reject(sdkError("CLAUDE_CODE_SDK_UNAVAILABLE", "Claude Code is unavailable in this release"));
  }
  if (!sdkPromise) {
    sdkPromise = import("@anthropic-ai/claude-agent-sdk")
      .then(validateSdk)
      .catch((error) => {
        sdkPromise = null;
        if (error?.code === "CLAUDE_CODE_SDK_INVALID") throw error;
        throw sdkError("CLAUDE_CODE_SDK_UNAVAILABLE", "Claude Agent SDK could not be loaded");
      });
  }
  return sdkPromise;
}

function withClaudeConfigDir(configDir, task) {
  if (typeof configDir !== "string" || !path.isAbsolute(configDir) || configDir.includes("\0")
    || typeof task !== "function") {
    return Promise.reject(sdkError(
      "CLAUDE_CODE_SDK_OPTIONS_INVALID",
      "Claude SDK session mutation options are invalid",
    ));
  }
  const operation = mutationTail.then(async () => {
    const previous = Object.getOwnPropertyDescriptor(process.env, "CLAUDE_CONFIG_DIR");
    process.env.CLAUDE_CONFIG_DIR = configDir;
    try {
      return await task();
    } finally {
      if (previous) Object.defineProperty(process.env, "CLAUDE_CONFIG_DIR", previous);
      else delete process.env.CLAUDE_CONFIG_DIR;
    }
  });
  mutationTail = operation.catch(() => {});
  return operation;
}

module.exports = {
  loadClaudeAgentSdk,
  validateSdk,
  withClaudeConfigDir,
};
