"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { readPrivateFile, atomicWritePrivateFile, recoverInterruptedPrivateFile } = require("./private-file");
const { validRuntime } = require("./runtime-adapter");
const { serviceError, lstatIfExists } = require("./security");
const fail = () => serviceError("RUNTIME_EXTENSION_UNTRUSTED", "Runtime extension signature or configuration is invalid");
function verifyManifest(envelope, trustedKey) {
  if (!envelope || Object.keys(envelope).sort().join() !== "manifest,signature" || typeof envelope.signature !== "string") throw fail();
  const m = envelope.manifest;
  const keys = ["version", "runtime", "transport", "command", "args", "files", "endpoint", "credentialRef"];
  if (!m || Object.keys(m).sort().join() !== keys.sort().join() || m.version !== 1 || !validRuntime(m.runtime)
    || !m.runtime.startsWith("ext-") || !["stdio", "acp", "remote"].includes(m.transport)) throw fail();
  // All file digests and argument order are signed; JSON key order is fixed here.
  const payload = JSON.stringify(Object.fromEntries(keys.map(key => [key, m[key]])));
  const publicKey = crypto.createPublicKey(trustedKey);
  if (publicKey.asymmetricKeyType !== "ed25519" || !crypto.verify(null, Buffer.from(payload), publicKey,
    Buffer.from(envelope.signature, "base64"))) throw fail();
  if (!Array.isArray(m.args) || m.args.length > 64 || m.args.some(arg => typeof arg !== "string" || !arg.isWellFormed()
    || arg.includes("\0") || Buffer.byteLength(arg) > 4096) || !Array.isArray(m.files) || m.files.length > 128) throw fail();
  if (m.transport === "remote") {
    const url = new URL(m.endpoint);
    if (!["tls:", "tcp:"].includes(url.protocol) || !url.port || url.username || url.password || url.search || url.hash
      || (url.pathname && url.pathname !== "/") || (url.protocol === "tcp:" && url.hostname !== "127.0.0.1")
      || m.command !== null || m.args.length || m.files.length || !/^runtime-worker-[a-z0-9-]{1,100}$/u.test(m.credentialRef)) throw fail();
  } else {
    if (typeof m.command !== "string" || !path.isAbsolute(m.command) || m.endpoint !== null || m.credentialRef !== null
      || !m.files.some(item => item.path === m.command)) throw fail();
    const seen = new Set();
    for (const item of m.files) {
      if (!item || Object.keys(item).sort().join() !== "path,sha256" || !path.isAbsolute(item.path)
        || !/^[a-f0-9]{64}$/u.test(item.sha256) || seen.has(item.path)) throw fail();
      seen.add(item.path);
      const stat = fs.lstatSync(item.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024 * 1024 || (stat.mode & 0o022)
        || crypto.createHash("sha256").update(fs.readFileSync(item.path)).digest("hex") !== item.sha256) throw fail();
    }
    // Any executable script referenced in argv must also be pinned. Arguments
    // that name existing files cannot escape the signed package inventory.
    for (const arg of m.args) if (path.isAbsolute(arg) && fs.existsSync(arg) && !seen.has(arg)) throw fail();
  }
  return structuredClone(m);
}
class RuntimeExtensionCatalog {
  constructor(paths) { this.paths = paths; this.file = path.join(paths.stateDir, "runtime-extensions-v1.json"); }
  read({ verifyEnabled = true } = {}) {
    if (recoverInterruptedPrivateFile(this.file, { trustedRoot: this.paths.trustedRoot }) === "uncertain") throw fail();
    if (!lstatIfExists(this.file)) return [];
    const data = JSON.parse(readPrivateFile(this.file, { maxBytes: 1024 * 1024 }));
    if (data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > 32) throw fail();
    const ids = new Set();
    return data.entries.map(entry => {
      if (!entry || Object.keys(entry).sort().join() !== "enabled,envelope,trustedKey" || typeof entry.enabled !== "boolean") throw fail();
      // Disabled entries retain their package metadata; changed/missing binaries
      // cannot prevent the user from disabling or uninstalling them.
      const id = entry.envelope?.manifest?.runtime;
      if (!validRuntime(id) || ids.has(id)) throw fail(); ids.add(id);
      if (verifyEnabled && entry.enabled) verifyManifest(entry.envelope, entry.trustedKey);
      return entry;
    });
  }
  write(entries) { if (entries.length > 32) throw fail(); atomicWritePrivateFile(this.file,
    JSON.stringify({ version: 1, entries }) + "\n", { trustedRoot: this.paths.trustedRoot }); }
  mutate(action) {
    const lease = require("./private-writer-lease").acquirePrivateWriterLease({
      lockPath: path.join(this.paths.stateDir, "runtime-extensions.writer.lock"), trustedRoot: this.paths.trustedRoot });
    try { return action(); } finally { lease.release(); }
  }
  install(envelope, trustedKey) {
    const manifest = verifyManifest(envelope, trustedKey);
    return this.mutate(() => { const entries = this.read();
      if (entries.some(entry => entry.envelope.manifest.runtime === manifest.runtime)) throw fail();
      this.write([...entries, { enabled: true, envelope, trustedKey }]); return manifest.runtime;
    });
  }
  setEnabled(runtime, enabled) { return this.mutate(() => {
    if (typeof enabled !== "boolean") throw fail();
    const entries = this.read({ verifyEnabled: false }), entry = entries.find(item => item.envelope.manifest.runtime === runtime);
    if (!entry) throw fail(); if (enabled) verifyManifest(entry.envelope, entry.trustedKey); entry.enabled = enabled; this.write(entries);
  }); }
  uninstall(runtime) { return this.mutate(() => { this.write(this.read({ verifyEnabled: false }).filter(entry => entry.envelope.manifest.runtime !== runtime)); }); }
}
module.exports = { RuntimeExtensionCatalog, verifyManifest };
