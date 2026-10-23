"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

function absoluteSyntax(value) {
  if (typeof value !== "string") return null;
  if (/^[A-Za-z]:[\\/]/u.test(value)
    || /^\\\\(?![?.](?:[\\/]|$))[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u.test(value)) return path.win32;
  return value.startsWith("/") ? path.posix : null;
}

const slashUnc = value => /^\/\/(?![?.](?:\/|$))[^\\/]+\/[^\\/]+(?:\/|$)/u.test(value);
function relativePath(syntax, workspace, requested) {
  const relative = syntax.relative(workspace, requested);
  return !relative || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)
    || relative.split(/[\\/]/u).includes("..") || /^[A-Za-z]:/u.test(relative) ? null : relative;
}

function artifactPath(workspace, requested) {
  if (typeof requested !== "string" || !requested || requested.includes("\0")
    || requested.split(/[\\/]/u).includes("..") || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(requested)) return null;
  if (!path.posix.isAbsolute(requested) && !path.win32.isAbsolute(requested) && !/^[A-Za-z]:/u.test(requested)) return requested;
  // Both paths belong to the bound execution host, whose syntax can differ from this Service device.
  const syntax = absoluteSyntax(workspace);
  if (!syntax || workspace.includes("\0") || workspace.split(/[\\/]/u).includes("..")) return null;
  // A // root alone cannot identify POSIX versus Windows UNC. Admit only an identical interpretation.
  if (workspace.startsWith("//")) {
    if (!slashUnc(workspace) || !slashUnc(requested) || workspace.includes("\\") || requested.includes("\\")) return null;
    const posix = relativePath(path.posix, workspace, requested), windows = relativePath(path.win32, workspace, requested);
    return posix && windows && posix === windows.replaceAll("\\", "/") ? posix : null;
  }
  if (absoluteSyntax(requested) !== syntax && !(syntax === path.win32 && slashUnc(requested))) return null;
  return relativePath(syntax, workspace, requested);
}

/** External bytes are read by the execution host; host paths are never opened on the Service device. */
class GroupExternalArtifacts {
  constructor({ store, getClient, maxBytes = 64 * 1024 * 1024 }) {
    this.store = store; this.getClient = getClient; this.maxBytes = maxBytes;
  }
  async read({ external, groupId }, requested, expectedDigest = null) {
    if (!external || !this.getClient()) return null;
    const requestedPath = artifactPath(external.workspace, requested);
    if (requestedPath === null) return null;
    const execution = external.remote ? { ...external, remote: { ...external.remote,
      ownerId: this.store.getRemoteOwnerId(), epoch: this.store.getDriverFence() } } : external;
    if (execution.remote && execution.remote.groupId !== groupId) return null;
    let offset = 0, digest = expectedDigest, bytes = null, filePath = null; const chunks = [];
    do {
      const value = await this.getClient().request("group.external.artifact", { execution, path: filePath ?? requestedPath, digest, offset });
      const item = value?.artifact;
      if (!item || item.offset !== offset || (digest && item.digest !== digest) || item.bytes > this.maxBytes
        || (bytes !== null && item.bytes !== bytes) || (filePath !== null && item.path !== filePath)) return null;
      const chunk = Buffer.from(item.content, "base64");
      if (chunk.toString("base64") !== item.content || chunk.length > 16 * 1024
        || (item.nextOffset !== null && item.nextOffset !== offset + chunk.length)
        || (item.nextOffset !== null && item.nextOffset <= offset)
        || (item.nextOffset === null && offset + chunk.length !== item.bytes)) return null;
      chunks.push(chunk); filePath = item.path; digest = item.digest; bytes = item.bytes; offset = item.nextOffset;
    } while (offset !== null);
    const content = Buffer.concat(chunks);
    if (content.length !== bytes || crypto.createHash("sha256").update(content).digest("hex") !== digest) return null;
    return { path: filePath, digest, bytes, content };
  }
  async resolve(root, requested) {
    const value = await this.read(root, requested);
    return value && { path: value.path, bytes: value.bytes, digest: value.digest };
  }
  async preview(root, artifact) {
    const value = await this.read(root, artifact.path, artifact.digest);
    if (!value) return null;
    const head = value.content.subarray(0, 256 * 1024);
    const truncated = value.content.length > head.length;
    const decoded = truncated ? head.toString("utf8").replace(/\uFFFD+$/u, "") : head.toString("utf8");
    const isText = !head.includes(0) && !decoded.includes("\uFFFD");
    return { text: isText ? decoded : null, truncated: isText && truncated, changed: false };
  }
}

module.exports = { GroupExternalArtifacts };
