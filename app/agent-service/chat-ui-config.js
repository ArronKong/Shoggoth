"use strict";
const path = require("node:path");
const { readPrivateFile, atomicWritePrivateFile, recoverInterruptedPrivateFile } = require("./private-file");
const { lstatIfExists } = require("./security");
const { validateChatUiConfig } = require("./chat-ui-protocol");
const { uiError } = require("./chat-ui-contract");

// Core config.json is the only policy authority. This file is its authenticated
// last applied generation; a standalone Service starts with execution disabled.
class ChatUiConfig {
  constructor({ paths, onApplied = () => {} }) {
    this.paths = paths; this.file = path.join(paths.stateDir, "chat-ui-config.json"); this.onApplied = onApplied;
    this.value = { revision: 0, config: { nativeChatUiV1: false } }; this.initialized = false; this.uncertain = false;
  }
  open() {
    try {
      if (recoverInterruptedPrivateFile(this.file, { trustedRoot: this.paths.trustedRoot }) === "uncertain") throw new Error();
      this.initialized = Boolean(lstatIfExists(this.file));
      this.value = this.initialized ? validateChatUiConfig(JSON.parse(readPrivateFile(this.file, { maxBytes: 4096 })))
        : { revision: 0, config: { nativeChatUiV1: false } };
      this.uncertain = false;
    } catch { this.uncertain = true; throw uiError("UI_STORAGE_CORRUPT"); }
  }
  read() { if (this.uncertain) throw uiError("UI_COMMIT_UNCERTAIN"); return structuredClone(this.value); }
  apply(input) {
    this.read(); const next = validateChatUiConfig(input);
    if (next.revision < this.value.revision || (this.initialized && next.revision === this.value.revision
      && JSON.stringify(next) !== JSON.stringify(this.value))) throw uiError("UI_REVISION_CONFLICT");
    if (this.initialized && next.revision === this.value.revision) return this.read();
    try { atomicWritePrivateFile(this.file, `${JSON.stringify(next)}\n`, { trustedRoot: this.paths.trustedRoot }); }
    catch (cause) { this.uncertain = true; throw uiError("UI_COMMIT_UNCERTAIN", { cause }); }
    this.value = next; this.initialized = true; this.onApplied(next); return this.read();
  }
}
module.exports = { ChatUiConfig };
