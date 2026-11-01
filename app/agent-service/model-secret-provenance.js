"use strict";
const path = require("node:path"), crypto = require("node:crypto");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");
const { serviceError } = require("./security");
const OPAQUE = new Set(["signature", "encrypted_content", "thoughtSignature", "thought_signature"]);
const digest = (field, value) => crypto.createHash("sha256").update(field).update("\0").update(value).digest("hex");
const fail = () => { throw serviceError("SECRET_MODEL_PROVENANCE_UNAVAILABLE", "模型历史的本地保护记录暂不可用"); };

class ModelSecretProvenance {
  constructor({ paths, secrets }) { this.paths = paths; this.secrets = secrets; }
  file(scope) {
    const id = crypto.createHash("sha256").update(JSON.stringify([scope.profileId, scope.sessionId])).digest("hex");
    return path.join(this.paths.stateDir, "model-secret-provenance", `${id}.json`);
  }
  read(scope) {
    let record;
    try { record = JSON.parse(readPrivateFile(this.file(scope), { maxBytes: 2 * 1024 * 1024 })); }
    catch (error) { if (error.code === "ENOENT") return new Set(); fail(); }
    if (record.version !== 1 || !Array.isArray(record.entries) || record.entries.length > 16384
      || record.entries.some(item => typeof item !== "string" || !/^[a-f0-9]{64}$/u.test(item))
      || record.mac !== this.secrets.metadataMac(scope, "model-opaque-v1", record.entries)) fail();
    return new Set(record.entries);
  }
  async verifier(scope) {
    await this.secrets.prepareMetadata();
    const entries = this.read(scope);
    return (field, value) => typeof value === "string" && entries.has(digest(field, value));
  }
  record(scope, value) {
    const found = new Set(); let nodes = 0;
    const walk = (input, depth = 0) => {
      if (++nodes > 100000 || depth > 48) fail();
      if (!input || typeof input !== "object") return;
      if (Array.isArray(input)) { for (const child of input) walk(child, depth + 1); return; }
      for (const [key, child] of Object.entries(input)) {
        if (OPAQUE.has(key) && typeof child === "string" && child.length <= 16 * 1024 * 1024) found.add(digest(key, child));
        else walk(child, depth + 1);
      }
    };
    walk(value); if (!found.size) return;
    const entries = this.read(scope); let changed = false;
    for (const value of found) if (!entries.has(value)) { entries.add(value); changed = true; }
    if (!changed) return;
    // Never silently evict proof that a retained native history can still use.
    if (entries.size > 16384) fail();
    const saved = [...entries];
    atomicWritePrivateFile(this.file(scope), JSON.stringify({ version: 1, entries: saved,
      mac: this.secrets.metadataMac(scope, "model-opaque-v1", saved) }), { trustedRoot: this.paths.trustedRoot });
  }
}
module.exports = { ModelSecretProvenance };
