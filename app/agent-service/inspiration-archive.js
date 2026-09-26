"use strict";

const { createHash } = require("node:crypto");
const { crc32 } = require("node:zlib");
const { unzipSync } = require("fflate");
const { MAX_ARCHIVE_BYTES, validAttachments, validAttachment, mediaId, matchesMediaType, ARCHIVE_MIME } = require("./inspiration-media");
const { serviceError } = require("./security");
const FORMAT = "shoggoth.inspirations";
const MAX_NOTES = 1000;
const fail = () => { throw serviceError("INSPIRATION_ARCHIVE_INVALID", "便签包损坏、版本不支持或超过容量限制，未导入任何便签"); };
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const time = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, max, empty = false) => typeof value === "string" && value.isWellFormed() && !value.includes("\0")
  && (empty || value.trim().length > 0) && Buffer.byteLength(JSON.stringify(value)) <= max;

function zipChecksums(bytes) {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = data.length - 22;
  while (end >= Math.max(0, data.length - 65557)
    && (data.readUInt32LE(end) !== 0x06054b50 || end + 22 + data.readUInt16LE(end + 20) !== data.length)) end--;
  if (end < 0 || data.readUInt32LE(end) !== 0x06054b50 || data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6)) fail();
  const count = data.readUInt16LE(end + 10), start = data.readUInt32LE(end + 16);
  if (count > MAX_NOTES * 9 + 2 || count !== data.readUInt16LE(end + 8) || start + data.readUInt32LE(end + 12) !== end) fail();
  const sums = new Map(), ranges = [];
  let cursor = start;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || data.readUInt32LE(cursor) !== 0x02014b50 || (data.readUInt16LE(cursor + 8) & 1)) fail();
    const nameLength = data.readUInt16LE(cursor + 28), local = data.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + data.readUInt16LE(cursor + 30) + data.readUInt16LE(cursor + 32);
    if (nameLength > 512 || next > end || local + 30 > start || data.readUInt32LE(local) !== 0x04034b50
      || (data.readUInt16LE(local + 6) & 1)) fail();
    const nameBytes = data.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    const localName = data.readUInt16LE(local + 26), offset = local + 30 + localName + data.readUInt16LE(local + 28);
    const stop = offset + data.readUInt32LE(cursor + 20);
    if (sums.has(name) || localName !== nameLength || !data.subarray(local + 30, local + 30 + localName).equals(nameBytes)
      || stop > start || data.readUInt16LE(local + 8) !== data.readUInt16LE(cursor + 10)) fail();
    sums.set(name, data.readUInt32LE(cursor + 16)); ranges.push([local, stop]); cursor = next;
  }
  if (cursor !== end) fail();
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges.some((range, index) => index > 0 && range[0] < ranges[index - 1][1])) fail();
  return sums;
}

// No files are extracted to disk. Bound every central-directory entry BEFORE
// allocating/decompressing it, including entries that are not in the manifest.
function readInspirationArchive(input) {
  try {
    if (input.length < 22 || input.length > MAX_ARCHIVE_BYTES) fail();
    const checksums = zipChecksums(input);
    const names = new Set();
    let total = 0;
    const entries = unzipSync(input, { filter(entry) {
      const { name, originalSize, size, compression } = entry;
      if (names.has(name) || names.size >= MAX_NOTES * 9 + 2 || name.length > 512
        || name.includes("\\") || /[\x00-\x1f\x7f]/u.test(name)
        || name.split("/").some(part => !part || part === "." || part === "..")
        || !/^(manifest\.json|README\.txt|notes\/[^/]+\.md|files\/[^/]+\/[^/]+)$/u.test(name)
        || ![0, 8].includes(compression) || !Number.isSafeInteger(originalSize) || originalSize < 0
        || (compression === 0 && originalSize !== size)
        || originalSize > (name === "manifest.json" ? 24 * 1024 * 1024 : 50 * 1024 * 1024)) fail();
      names.add(name); total += originalSize;
      if (total > MAX_ARCHIVE_BYTES) fail();
      return true;
    } });
    for (const [name, data] of Object.entries(entries)) if (crc32(data) !== checksums.get(name)) fail();
    if (!entries["manifest.json"]) fail();
    const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(entries["manifest.json"]));
    if (!exact(manifest, ["format", "version", "createdAt", "notes", "files"])
      || manifest.format !== FORMAT || manifest.version !== 1 || !time(manifest.createdAt)
      || !Array.isArray(manifest.notes) || !manifest.notes.length || manifest.notes.length > MAX_NOTES
      || !Array.isArray(manifest.files) || manifest.files.length > MAX_NOTES * 8) fail();
    const files = new Map(), paths = new Set();
    for (const file of manifest.files) {
      if (!exact(file, ["id", "name", "mimeType", "size", "path", "sha256"])) fail();
      const { path, sha256, ...attachment } = file;
      const data = entries[path];
      if (!validAttachment(attachment) || attachment.mimeType === ARCHIVE_MIME || files.has(file.id)
        || typeof path !== "string" || !path.startsWith(`files/${file.id}/`) || paths.has(path)
        || !data || data.length !== file.size || !/^[a-f0-9]{64}$/u.test(sha256)
        || createHash("sha256").update(data).digest("hex") !== sha256
        || !matchesMediaType(Buffer.from(data.buffer, data.byteOffset, data.byteLength), file.mimeType)) fail();
      files.set(file.id, { attachment, data }); paths.add(path);
    }
    const noteIds = new Set(), used = new Set();
    for (const note of manifest.notes) {
      if (!exact(note, ["id", "body", "title", "favorite", "archivedAt", "acceptedAt", "createdAt", "updatedAt", "paperTone", "attachments"])
        || !mediaId(note.id) || noteIds.has(note.id) || !validAttachments(note.attachments)
        || !text(note.body, 16 * 1024, Boolean(note.attachments.length))
        || (note.title !== null && !text(note.title, 512)) || typeof note.favorite !== "boolean"
        || !time(note.createdAt) || !time(note.updatedAt) || note.updatedAt < note.createdAt
        || ![note.archivedAt, note.acceptedAt].every(at => at === null || time(at))
        || !Number.isInteger(note.paperTone) || note.paperTone < 0 || note.paperTone > 7) fail();
      noteIds.add(note.id);
      for (const attachment of note.attachments) {
        const saved = files.get(attachment.id)?.attachment;
        if (!saved || Object.keys(saved).some(key => saved[key] !== attachment[key])
          || (attachment.textOffset ?? 0) > note.body.length) fail();
        used.add(attachment.id);
      }
    }
    if (used.size !== files.size || [...names].some(name => name.startsWith("files/") && !paths.has(name))) fail();
    return { notes: manifest.notes, files };
  } catch (error) {
    if (error.code === "INSPIRATION_ARCHIVE_INVALID") throw error;
    fail();
  }
}

module.exports = { FORMAT, MAX_NOTES, readInspirationArchive };
