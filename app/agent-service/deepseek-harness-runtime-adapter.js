"use strict";

const { assertRuntimeAdapter, runtimeBinding, runtimeCapabilities } = require("./runtime-adapter");
const { DEEPSEEK_HARNESS_RUNTIME } = require("./deepseek-harness-runtime-paths");
const { serviceError } = require("./security");

const DEEPSEEK_HARNESS_CAPABILITIES = runtimeCapabilities({
  "session.start": true,
  "session.resume": true,
  "session.read": true,
  "session.list": true,
  "session.rename": true,
  "session.archive": true,
  "session.unarchive": true,
  "session.delete": true,
  "turn.start": true,
  "turn.steer": true,
  "turn.interrupt": true,
  "models.list": true,
  "commands.list": true,
  "commands.execute": true,
  "account.read": false,
  "account.login": false,
  "account.logout": false,
  events: true,
  serverRequests: true,
});

function adapterError(code, message) {
  return serviceError(code, message);
}

class DeepSeekHarnessRuntimeHandle {
  constructor(binding, host) {
    this.runtime = DEEPSEEK_HARNESS_RUNTIME;
    this.runtimeProfileId = binding.runtimeProfileId;
    this.runtimeAccountId = binding.runtimeAccountId;
    this.capabilities = DEEPSEEK_HARNESS_CAPABILITIES;
    this.host = host;
    this.workspace = host.workspace;
    this.controlInstance = host.controlInstance === true;
  }

  get terminated() { return this.host.terminated; }
  get registeredSecrets() {
    return Array.isArray(this.host.registeredSecrets) ? [...this.host.registeredSecrets] : [];
  }
  authenticationState() { return this.host.authenticationState(); }
  subscribe(listener) { return this.host.subscribe(listener); }
  registerServerRequestHandler(method, handler) {
    return this.host.registerServerRequestHandler(method, handler);
  }
  sessionStart(input) { return this.host.sessionStart(input); }
  sessionResume(input) { return this.host.sessionResume(input); }
  sessionRead(input) { return this.host.sessionRead(input); }
  sessionList(input) { return this.host.sessionList(input); }
  sessionRename(input) { return this.host.sessionRename(input); }
  sessionArchive(input) { return this.host.sessionArchive(input); }
  sessionUnarchive(input) { return this.host.sessionUnarchive(input); }
  sessionDelete(input) { return this.host.sessionDelete(input); }
  turnStart(input) { return this.host.turnStart(input); }
  turnSteer(input) { return this.host.turnSteer(input); }
  turnInterrupt(input) { return this.host.turnInterrupt(input); }
  modelsList(input) { return this.host.modelsList(input); }
  commandsList(input) { return this.host.commandsList(input); }
  commandExecute(input) { return this.host.commandExecute(input); }
}

class DeepSeekHarnessRuntimeAdapter {
  constructor(options = {}) {
    if (!options.runtimePool || typeof options.runtimePool.get !== "function"
      || typeof options.runtimePool.stop !== "function"
      || typeof options.runtimePool.stopAll !== "function") {
      throw adapterError(
        "RUNTIME_ADAPTER_INVALID",
        "DeepSeek Harness adapter requires a DeepSeekHarnessRuntimePool",
      );
    }
    this.runtimePool = options.runtimePool;
    this.handles = new Map();
    assertRuntimeAdapter(this);
  }

  async acquire(value, options = {}) {
    const binding = runtimeBinding(value);
    if (binding.runtime !== DEEPSEEK_HARNESS_RUNTIME) {
      throw adapterError(
        "RUNTIME_UNSUPPORTED",
        `DeepSeek Harness adapter cannot run ${binding.runtime}`,
      );
    }
    const host = await this.runtimePool.get(binding, options);
    const existing = this.handles.get(host);
    if (existing) return existing.handle;
    const handle = Object.freeze(new DeepSeekHarnessRuntimeHandle(binding, host));
    const entry = { host, handle };
    this.handles.set(host, entry);
    if (host.terminated && typeof host.terminated.then === "function") {
      Promise.resolve(host.terminated).then(
        () => { if (this.handles.get(host) === entry) this.handles.delete(host); },
        () => { if (this.handles.get(host) === entry) this.handles.delete(host); },
      );
    }
    return handle;
  }

  stop(value) {
    let id;
    if (typeof value === "string") id = value;
    else {
      const binding = runtimeBinding(value);
      if (binding.runtime !== DEEPSEEK_HARNESS_RUNTIME) {
        throw adapterError(
          "RUNTIME_UNSUPPORTED",
          `DeepSeek Harness adapter cannot stop ${binding.runtime}`,
        );
      }
      id = binding.runtimeProfileId;
    }
    for (const [host, entry] of this.handles) {
      if (entry.handle.runtimeProfileId === id) this.handles.delete(host);
    }
    return this.runtimePool.stop(id);
  }

  stopAll() {
    this.handles.clear();
    return this.runtimePool.stopAll();
  }
}

module.exports = { DEEPSEEK_HARNESS_CAPABILITIES, DeepSeekHarnessRuntimeAdapter };
