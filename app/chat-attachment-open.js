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
// for the lifetime of the UI server so the default application can read them.
function createChatAttachmentOpener(openPath) {
  let directory;
  const files = new Map();
  return {
    async open(name, bytes) {
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
        fs.writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
        files.set(key, file);
      }
      return openPath(file);
    },
    dispose() {
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
      directory = undefined;
      files.clear();
    },
  };
}

module.exports = { createChatAttachmentOpener, validAttachmentName, MAX_OPEN_ATTACHMENT_BYTES };
