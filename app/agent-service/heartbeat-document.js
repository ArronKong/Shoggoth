"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), yaml = require("js-yaml");
const { readPrivateFile, atomicWritePrivateFile, recoverInterruptedPrivateFile } = require("./private-file");
const { serviceError } = require("./security");
const { publicUrl } = require("./web-service");
const MAX_DOCUMENT_BYTES = 16384, MAX_SCRATCH_BYTES = 4096;
const EMPTY_REVISION = "0".repeat(64);
const DEFAULT_HEARTBEAT = `# Heartbeat

<!--
Write recurring checks in plain language. For each check, describe:
- What to check and where the evidence comes from.
- Which change or condition is worth a reminder.
- When to stay quiet, and when to stop repeating a reminder after it is handled.

Example only: Check the project's release page. Remind me when a new stable release appears, explain the relevant changes, and do not repeat a release already reported. Stay quiet when nothing changed.

Use current evidence. Missing access or a failed check is not proof that everything is fine. Keep reminders useful and actionable.
Frequency, active hours, and notifications are controlled by the heartbeat settings.
Headings, comments, or empty content alone do not invoke a model; this example is inactive.

Optional source collection: YAML front matter can request a read-only snapshot of unarchived Spark Notes and public web sources. To use it, place the needed fields at the very start of this file, outside this comment and before the heading, then add your actual checks below:
---
inspiration: true
web:
  - kind: fetch
    url: https://example.com/status
  - kind: search
    query: project release updates
---
-->
`;
function error(code) { throw serviceError(code, code === "PROACTIVE_REVISION_CONFLICT" ? "文件已更新，请重新读取" : "检查规则文件内容或路径无效"); }
function revision(content) { return crypto.createHash("sha256").update(content).digest("hex"); }
function meaningful(content) {
  return content.replace(/<!--[\s\S]*?(?:-->|$)/gu, "").split(/\r?\n/u).some(line => {
    const value = line.trim(); return value && !/^(?:#{1,6}(?:\s|$)|```|~~~|[-*+]\s*(?:\[[ xX]\])?\s*$)/u.test(value);
  });
}
function hasInspirationSection(body) {
  const rules = body.replace(/<!--[\s\S]*?(?:-->|$)/gu, "");
  const heading = /^ {0,3}#{1,6}[ \t]+(?:灵感便签状态检查(?:与合并汇报)?|Spark[ \t]*Notes status check)[ \t]*#*[ \t]*$/iu;
  let fence = null;
  for (const line of rules.split(/\r?\n/u)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (marker) fence = marker[1];
    else if (heading.test(line)) return true;
  }
  return false;
}
function parseHeartbeat(content) {
  if (typeof content !== "string" || !content.isWellFormed() || content.includes("\0") || Buffer.byteLength(content) > MAX_DOCUMENT_BYTES
    || Buffer.byteLength(JSON.stringify(content)) > 20 * 1024) error("PROACTIVE_DOCUMENT_INVALID");
  let body = content, web = [], inspiration;
  if (/^\uFEFF?---\r?\n/u.test(content)) {
    const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
    if (!match) error("PROACTIVE_DOCUMENT_INVALID");
    let data; try { data = yaml.load(match[1], { schema: yaml.JSON_SCHEMA }); } catch { error("PROACTIVE_DOCUMENT_INVALID"); }
    if (!data || Object.getPrototypeOf(data) !== Object.prototype || !Object.keys(data).length
      || Object.keys(data).some(k => !["web", "inspiration"].includes(k))
      || (Object.hasOwn(data, "web") && (!Array.isArray(data.web) || data.web.length > 4))
      || (Object.hasOwn(data, "inspiration") && typeof data.inspiration !== "boolean")) error("PROACTIVE_DOCUMENT_INVALID");
    inspiration = data.inspiration;
    web = (data.web ?? []).map(source => {
      const field = source?.kind === "fetch" ? "url" : source?.kind === "search" ? "query" : null;
      if (!field || !source || Object.getPrototypeOf(source) !== Object.prototype || Object.keys(source).sort().join() !== [field, "kind"].sort().join()
        || typeof source[field] !== "string" || !source[field].trim() || source[field].length > (field === "url" ? 4096 : 2000)) error("PROACTIVE_DOCUMENT_INVALID");
      if (field === "url") try { publicUrl(source.url); } catch { error("PROACTIVE_DOCUMENT_INVALID"); }
      return { kind: source.kind, [field]: source[field] };
    });
    body = content.slice(match[0].length);
  }
  // The saved status-check section predates the YAML opt-in. A reference in a
  // paragraph, example, or comment doesn't declare a source for other checks.
  inspiration ??= hasInspirationSection(body);
  return { body, web, inspiration, empty: !meaningful(body) && web.length === 0 && !inspiration };
}
class HeartbeatDocumentStore {
  constructor({ paths, productStore, documentName = "HEARTBEAT.md", defaultContent = DEFAULT_HEARTBEAT, parseContent = parseHeartbeat }) {
    if (!["HEARTBEAT.md", "DAILY_REVIEW.md"].includes(documentName)) error("PROACTIVE_DOCUMENT_INVALID");
    this.paths = paths; this.products = productStore;
    this.documentName = documentName; this.defaultContent = defaultContent; this.parseContent = parseContent;
  }
  file(profileId) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(profileId) || !this.products.getAgentProfile(profileId)) error("PROACTIVE_PROFILE_UNAVAILABLE");
    const directory = path.join(this.paths.agentsDir, profileId);
    // Reject symlinked ancestors before either reading or replacing the document.
    for (const parent of [this.paths.agentsDir, directory]) {
      try { if (fs.realpathSync(parent) !== parent || !fs.lstatSync(parent).isDirectory()) error("PROACTIVE_DOCUMENT_INVALID"); }
      catch (e) { if (e.code !== "ENOENT") throw e; }
    }
    return path.join(directory, this.documentName);
  }
  read(profileId) {
    const file = this.file(profileId);
    let content;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(readPrivateFile(file, { maxBytes: MAX_DOCUMENT_BYTES })); }
    catch (e) {
      if (e.code === "ENOENT") return { name: this.documentName, content: this.defaultContent, revision: EMPTY_REVISION, missing: true, readOnly: false };
      error("PROACTIVE_DOCUMENT_INVALID");
    }
    // Keep malformed YAML editable after an external edit. Parsing happens on
    // save and before each check; a read grants no execution authority.
    if (!content.isWellFormed() || content.includes("\0") || Buffer.byteLength(JSON.stringify(content)) > 20 * 1024) error("PROACTIVE_DOCUMENT_INVALID");
    return { name: this.documentName, content, revision: revision(content), missing: false, readOnly: false };
  }
  write(profileId, content, expectedRevision) {
    this.parseContent(content);
    if (!/^[a-f0-9]{64}$/u.test(expectedRevision) || this.read(profileId).revision !== expectedRevision) error("PROACTIVE_REVISION_CONFLICT");
    const file = this.file(profileId);
    recoverInterruptedPrivateFile(file, { trustedRoot: this.paths.trustedRoot });
    if (this.read(profileId).revision !== expectedRevision) error("PROACTIVE_REVISION_CONFLICT");
    atomicWritePrivateFile(file, content, { trustedRoot: this.paths.trustedRoot });
    return this.read(profileId);
  }
}
module.exports = { HeartbeatDocumentStore, parseHeartbeat, meaningful, DEFAULT_HEARTBEAT, MAX_DOCUMENT_BYTES, MAX_SCRATCH_BYTES, EMPTY_REVISION };
