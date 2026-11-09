"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");

const MAX_OPEN_ATTACHMENT_BYTES = 50 * 1024 * 1024;
function validAttachmentName(name) {
  return typeof name === "string" && name.length > 0 && Buffer.byteLength(name) <= 255
    && name !== "." && name !== ".." && !/[\\/\x00-\x1f\x7f]/u.test(name);
}

// Browser-picked files have bytes rather than an OS path. Keep private copies
// for the lifetime of the desktop surface that stages them.
function createChatAttachmentStaging() {
  let directory;
  const files = new Map();
  return {
    stage(name, bytes) {
      if (!validAttachmentName(name) || !Buffer.isBuffer(bytes) || bytes.length > MAX_OPEN_ATTACHMENT_BYTES) {
        throw new Error("Invalid attachment");
      }
      const key = createHash("sha256").update(name).update("\0").update(bytes).digest("hex");
      let file = files.get(key);
      if (!file) {
        directory ||= fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-open-attachment-"));
        const target = path.join(directory, key);
        fs.mkdirSync(target, { mode: 0o700 });
        file = path.join(target, name);
        try { fs.writeFileSync(file, bytes, { mode: 0o600, flag: "wx" }); }
        catch (error) { fs.rmSync(target, { recursive: true, force: true }); throw error; }
        files.set(key, file);
      }
      return file;
    },
    dispose() {
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
      directory = undefined;
      files.clear();
    },
  };
}

function createChatAttachmentRevealer(revealPath) {
  const staging = createChatAttachmentStaging();
  return { async reveal(name, bytes) { return revealPath(staging.stage(name, bytes)); }, dispose: staging.dispose };
}

module.exports = { createChatAttachmentRevealer, createChatAttachmentStaging, validAttachmentName, MAX_OPEN_ATTACHMENT_BYTES };
