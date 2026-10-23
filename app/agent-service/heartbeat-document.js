"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), yaml = require("js-yaml");
const { readPrivateFile, atomicWritePrivateFile, recoverInterruptedPrivateFile } = require("./private-file");
const { serviceError } = require("./security");
const { publicUrl } = require("./web-service");
const MAX_DOCUMENT_BYTES = 16384, MAX_SCRATCH_BYTES = 4096;
const EMPTY_REVISION = "0".repeat(64);
const DEFAULT_HEARTBEAT = "# Heartbeat\n\n<!-- Write recurring checks and notification conditions here. Headings, comments, or empty content alone do not invoke a model.\nAn optional YAML web list at the start can declare public pages or search queries:\n---\nweb:\n  - kind: fetch\n    url: https://example.com/status\n  - kind: search\n    query: project release updates\n---\nThe settings above control frequency, active hours, and notifications. -->\n";
function error(code) { throw serviceError(code, code === "PROACTIVE_REVISION_CONFLICT" ? "文件已更新，请重新读取" : "HEARTBEAT.md 内容或路径无效"); }
function revision(content) { return crypto.createHash("sha256").update(content).digest("hex"); }
function meaningful(content) {
  return content.replace(/<!--[\s\S]*?(?:-->|$)/gu, "").split(/\r?\n/u).some(line => {
    const value = line.trim(); return value && !/^(?:#{1,6}(?:\s|$)|```|~~~|[-*+]\s*(?:\[[ xX]\])?\s*$)/u.test(value);
  });
}
function parseHeartbeat(content) {
  if (typeof content !== "string" || !content.isWellFormed() || content.includes("\0") || Buffer.byteLength(content) > MAX_DOCUMENT_BYTES
    || Buffer.byteLength(JSON.stringify(content)) > 20 * 1024) error("PROACTIVE_DOCUMENT_INVALID");
  let body = content, web = [];
  if (/^\uFEFF?---\r?\n/u.test(content)) {
    const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
    if (!match) error("PROACTIVE_DOCUMENT_INVALID");
    let data; try { data = yaml.load(match[1], { schema: yaml.JSON_SCHEMA }); } catch { error("PROACTIVE_DOCUMENT_INVALID"); }
    if (!data || Object.getPrototypeOf(data) !== Object.prototype || Object.keys(data).some(k => k !== "web")
      || !Array.isArray(data.web) || data.web.length > 4) error("PROACTIVE_DOCUMENT_INVALID");
    web = data.web.map(source => {
      const field = source?.kind === "fetch" ? "url" : source?.kind === "search" ? "query" : null;
      if (!field || !source || Object.getPrototypeOf(source) !== Object.prototype || Object.keys(source).sort().join() !== [field, "kind"].sort().join()
        || typeof source[field] !== "string" || !source[field].trim() || source[field].length > (field === "url" ? 4096 : 2000)) error("PROACTIVE_DOCUMENT_INVALID");
      if (field === "url") try { publicUrl(source.url); } catch { error("PROACTIVE_DOCUMENT_INVALID"); }
      return { kind: source.kind, [field]: source[field] };
    });
    body = content.slice(match[0].length);
  }
  return { body, web, empty: !meaningful(body) && web.length === 0 };
}
class HeartbeatDocumentStore {
  constructor({ paths, productStore }) { this.paths = paths; this.products = productStore; }
  file(profileId) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(profileId) || !this.products.getAgentProfile(profileId)) error("PROACTIVE_PROFILE_UNAVAILABLE");
    const directory = path.join(this.paths.agentsDir, profileId);
    // Reject symlinked ancestors before either reading or replacing the document.
    for (const parent of [this.paths.agentsDir, directory]) {
      try { if (fs.realpathSync(parent) !== parent || !fs.lstatSync(parent).isDirectory()) error("PROACTIVE_DOCUMENT_INVALID"); }
      catch (e) { if (e.code !== "ENOENT") throw e; }
    }
    return path.join(directory, "HEARTBEAT.md");
  }
  read(profileId) {
    const file = this.file(profileId);
    let content;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(readPrivateFile(file, { maxBytes: MAX_DOCUMENT_BYTES })); }
    catch (e) {
      if (e.code === "ENOENT") return { name: "HEARTBEAT.md", content: DEFAULT_HEARTBEAT, revision: EMPTY_REVISION, missing: true, readOnly: false };
      error("PROACTIVE_DOCUMENT_INVALID");
    }
    // Keep malformed YAML editable after an external edit. Parsing happens on
    // save and before each check; a read grants no execution authority.
    if (!content.isWellFormed() || content.includes("\0") || Buffer.byteLength(JSON.stringify(content)) > 20 * 1024) error("PROACTIVE_DOCUMENT_INVALID");
    return { name: "HEARTBEAT.md", content, revision: revision(content), missing: false, readOnly: false };
  }
  write(profileId, content, expectedRevision) {
    parseHeartbeat(content);
    if (!/^[a-f0-9]{64}$/u.test(expectedRevision) || this.read(profileId).revision !== expectedRevision) error("PROACTIVE_REVISION_CONFLICT");
    const file = this.file(profileId);
    recoverInterruptedPrivateFile(file, { trustedRoot: this.paths.trustedRoot });
    if (this.read(profileId).revision !== expectedRevision) error("PROACTIVE_REVISION_CONFLICT");
    atomicWritePrivateFile(file, content, { trustedRoot: this.paths.trustedRoot });
    return this.read(profileId);
  }
}
module.exports = { HeartbeatDocumentStore, parseHeartbeat, meaningful, DEFAULT_HEARTBEAT, MAX_DOCUMENT_BYTES, MAX_SCRATCH_BYTES, EMPTY_REVISION };
