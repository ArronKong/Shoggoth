"use strict";

const { core } = require("./host.cjs");
const { serviceError } = require("../security");

// The pinned plugin owns command parsing and both lifecycle handlers. The host
// captures registrations instead of duplicating their orchestration policy.
function registerActiveMemoryPlugin(api) {
  let command;
  const hooks = new Map();
  const invalid = () => { throw serviceError("MEMORY_ACTIVE_PLUGIN_INVALID", "自动召回插件注册无效"); };
  core.activeMemoryPlugin.register({ ...api,
    registerCommand(definition) {
      if (command || definition?.name !== "active-memory" || typeof definition.handler !== "function") invalid();
      command = definition;
    },
    on(name, handler, options) {
      if (!["before_prompt_build", "agent_end"].includes(name) || hooks.has(name) || typeof handler !== "function") invalid();
      if (name === "before_prompt_build" && (options?.requiresToolAuthority !== true || !Number.isSafeInteger(options.timeoutMs))) invalid();
      hooks.set(name, { handler, options });
    },
  });
  if (!command || hooks.size !== 2) invalid();
  return { command, beforePromptBuild: hooks.get("before_prompt_build").handler,
    agentEnd: hooks.get("agent_end").handler };
}

module.exports = { registerActiveMemoryPlugin };
