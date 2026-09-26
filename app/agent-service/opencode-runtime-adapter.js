"use strict";

const { assertRuntimeAdapter, runtimeBinding, runtimeCapabilities } = require("./runtime-adapter");
const { OPENCODE_RUNTIME } = require("./opencode-runtime-paths");
const { serviceError } = require("./security");

const OPENCODE_CAPABILITIES = runtimeCapabilities({
  "session.start": true, "session.resume": true, "session.read": true, "session.list": true,
  "session.rename": true, "session.archive": true, "session.unarchive": true,
  "session.delete": true, "turn.start": true, "turn.interrupt": true,
  "models.list": true, events: true, serverRequests: true,
});

class OpenCodeRuntimeHandle {
  constructor(binding, host) {
    this.runtime = OPENCODE_RUNTIME;
    this.runtimeProfileId = binding.runtimeProfileId;
    this.runtimeAccountId = binding.runtimeAccountId;
    this.capabilities = OPENCODE_CAPABILITIES;
    this.host = host;
    this.workspace = host.workspace;
    this.controlInstance = host.controlInstance === true;
  }
  get terminated() { return this.host.terminated; }
  get registeredSecrets() { return this.host.registeredSecrets || []; }
  authenticationState() { return this.host.authenticationState(); }
  subscribe(listener) { return this.host.subscribe(listener); }
  registerServerRequestHandler(method, handler) { return this.host.registerServerRequestHandler(method, handler); }
  sessionStart(input) { return this.host.sessionStart(input); }
  sessionResume(input) { return this.host.sessionResume(input); }
  sessionRead(input) { return this.host.sessionRead(input); }
  sessionList(input) { return this.host.sessionList(input); }
  sessionRename(input) { return this.host.sessionRename(input); }
  sessionArchive(input) { return this.host.sessionArchive(input); }
  sessionUnarchive(input) { return this.host.sessionUnarchive(input); }
  sessionDelete(input) { return this.host.sessionDelete(input); }
  turnStart(input) { return this.host.turnStart(input); }
  turnInterrupt(input) { return this.host.turnInterrupt(input); }
  modelsList(input) { return this.host.modelsList(input); }
}

class OpenCodeRuntimeAdapter {
  constructor(options = {}) {
    if (!options.runtimePool || ["get", "stop", "stopAll"].some(name => typeof options.runtimePool[name] !== "function")) {
      throw serviceError("RUNTIME_ADAPTER_INVALID", "OpenCode adapter requires a runtime pool");
    }
    this.runtimePool = options.runtimePool;
    this.handles = new Map();
    this.modelOnly = false;
    assertRuntimeAdapter(this);
  }
  async acquire(value, options = {}) {
    const binding = runtimeBinding(value);
    if (binding.runtime !== OPENCODE_RUNTIME) throw serviceError("RUNTIME_UNSUPPORTED", "OpenCode runtime is required");
    const host = await this.runtimePool.get(binding, options);
    const existing = this.handles.get(host);
    if (existing) return existing;
    const handle = Object.freeze(new OpenCodeRuntimeHandle(binding, host));
    this.handles.set(host, handle);
    host.terminated?.finally(() => this.handles.delete(host)).catch(() => {});
    return handle;
  }
  stop(value) {
    const id = typeof value === "string" ? value : runtimeBinding(value).runtimeProfileId;
    for (const [host, handle] of this.handles) if (handle.runtimeProfileId === id) this.handles.delete(host);
    return this.runtimePool.stop(id);
  }
  stopAll() { this.handles.clear(); return this.runtimePool.stopAll(); }
}

module.exports = { OPENCODE_CAPABILITIES, OpenCodeRuntimeAdapter };
