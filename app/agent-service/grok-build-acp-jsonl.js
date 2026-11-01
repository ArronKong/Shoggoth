"use strict";

const {
  AcpJsonlClient,
  DEFAULT_MAX_FRAME_BYTES,
  acpError,
  validRequestId,
} = require("./acp-jsonl-client");

const GROK_ACP_NAMING = Object.freeze({
  codePrefix: "GROK_ACP",
  protocolLabel: "Grok ACP",
  runtimeName: "Grok Build",
});
const INTERNAL_RELOAD_IDS = new Set(["skills-reload", "workflows-reload"]);

function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, keys) {
  return plain(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

// Grok keeps its established GROK_ACP_* error codes; the transport is shared.
class GrokBuildAcpJsonlClient extends AcpJsonlClient {
  constructor(child, options = {}) {
    super(child, { ...options, naming: GROK_ACP_NAMING });
    this.internalReloadContract = false;
    this.internalReloadVersion = null;
    this.reportedInternalReloads = new Set();
  }

  _handleResponse(message) {
    const pending = this.pending.get(message.id);
    // Grok injects file-watcher requests into its own ACP input, then
    // leaks their replies to stdout. Verified with the real CLI and upstream
    // agent/app.rs (real 1.0.63 and 1.0.69 captures). These exact successes are maintenance acknowledgements,
    // never replies to a client request or evidence that a prompt completed.
    if (this.internalReloadContract && INTERNAL_RELOAD_IDS.has(message.id)
      && !pending && !this.retiredIds.has(message.id)
      && !this.serverRequestIds.has(message.id) && !this.activeServerRequestIds.has(message.id)
      && exactKeys(message, ["jsonrpc", "id", "result"])
      && exactKeys(message.result, ["result"])
      && exactKeys(message.result.result, ["reloaded"])
      && Number.isSafeInteger(message.result.result.reloaded) && message.result.result.reloaded >= 0) {
      if (!this.reportedInternalReloads.has(message.id)) {
        this.reportedInternalReloads.add(message.id);
        try {
          this.onDiagnostic?.({ code: "GROK_ACP_INTERNAL_RELOAD_ACK", id: message.id,
            agentVersion: this.internalReloadVersion });
        } catch {}
      }
      return;
    }
    super._handleResponse(message);
    if (pending?.method === "initialize") {
      // Record only a matched successful handshake, before processing another
      // frame in this stdout chunk. Notifications cannot enable compatibility.
      this.internalReloadContract = !this.ended && !Object.hasOwn(message, "error")
        && plain(message.result) && message.result.protocolVersion === 1
        && plain(message.result.agentCapabilities);
      // Version is diagnostic only: it neither enables the contract nor
      // substitutes for a valid handshake, response shape and collision checks.
      const version = message.result?._meta?.agentVersion;
      this.internalReloadVersion = this.internalReloadContract && typeof version === "string"
        && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(version) ? version : null;
    }
  }
}

module.exports = {
  DEFAULT_MAX_FRAME_BYTES,
  GrokBuildAcpJsonlClient,
  acpError,
  validRequestId,
};
