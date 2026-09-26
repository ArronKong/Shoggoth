"use strict";

const {
  assertRuntimeAdapter,
  runtimeBinding,
  runtimeCapabilities,
} = require("./runtime-adapter");
const { ANTIGRAVITY_RUNTIME } = require("./antigravity-runtime-paths");
const { serviceError } = require("./security");

const ANTIGRAVITY_CAPABILITIES = runtimeCapabilities({
  "session.start": true,
  "session.resume": true,
  "session.read": true,
  "session.list": true,
  "session.rename": true,
  "session.archive": true,
  "session.unarchive": true,
  "session.delete": false,
  "turn.start": true,
  "turn.steer": false,
  "turn.interrupt": true,
  "models.list": true,
  "commands.list": true,
  "commands.execute": true,
  "account.read": false,
  "account.login": false,
  "account.logout": false,
  events: true,
  serverRequests: false,
});

function adapterError(code, message) {
  return serviceError(code, message);
}

class AntigravityRuntimeHandle {
  constructor(binding, host) {
    this.runtime = ANTIGRAVITY_RUNTIME;
    this.runtimeProfileId = binding.runtimeProfileId;
    this.runtimeAccountId = binding.runtimeAccountId;
    this.capabilities = runtimeCapabilities({ ...ANTIGRAVITY_CAPABILITIES, serverRequests: host.nativeApprovalsAvailable === true });
    this.host = host;
    this.workspace = host.workspace;
    this.controlInstance = host.controlInstance === true;
  }

  get terminated() { return this.host.terminated; }
  get registeredSecrets() { return []; }

  authenticationState(options) { return this.host.authenticationState(options); }
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

class AntigravityRuntimeAdapter {
  constructor(options = {}) {
    if (!options.runtimePool || typeof options.runtimePool.get !== "function"
      || typeof options.runtimePool.stop !== "function"
      || typeof options.runtimePool.stopAll !== "function") {
      throw adapterError(
        "RUNTIME_ADAPTER_INVALID",
        "Antigravity adapter requires an AntigravityRuntimePool",
      );
    }
    this.runtimePool = options.runtimePool;
    this.handles = new Map();
    assertRuntimeAdapter(this);
  }

  async acquire(value, options = {}) {
    const binding = runtimeBinding(value);
    if (binding.runtime !== ANTIGRAVITY_RUNTIME) {
      throw adapterError("RUNTIME_UNSUPPORTED", `Antigravity adapter cannot run ${binding.runtime}`);
    }
    const host = await this.runtimePool.get(binding, options);
    const existing = this.handles.get(host);
    if (existing) return existing.handle;
    const handle = Object.freeze(new AntigravityRuntimeHandle(binding, host));
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
      if (binding.runtime !== ANTIGRAVITY_RUNTIME) {
        throw adapterError("RUNTIME_UNSUPPORTED", `Antigravity adapter cannot stop ${binding.runtime}`);
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

module.exports = {
  ANTIGRAVITY_CAPABILITIES,
  AntigravityRuntimeAdapter,
};
