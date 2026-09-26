"use strict";

const path = require("node:path");
const { transaction } = require("./inspiration-database");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");
const { serviceError } = require("./security");

const CHUNK_BYTES = 24 * 1024;
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_ATTACHMENTS = 8;
const ARCHIVE_MIME = "application/vnd.shoggoth.inspiration+zip";
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MIME_EXTENSIONS = Object.freeze({
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "image/heic": "heic", "image/heif": "heif", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
  "audio/webm": "webm", "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/wav": "wav",
  "text/plain": "txt", "text/markdown": "md", "text/csv": "csv", "application/json": "json",
  "application/pdf": "pdf", "application/rtf": "rtf", "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-powerpoint": "ppt", "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.ms-excel": "xls", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.oasis.opendocument.text": "odt", "application/vnd.oasis.opendocument.presentation": "odp",
  "application/vnd.oasis.opendocument.spreadsheet": "ods", "application/zip": "zip", "application/octet-stream": "bin",
  [ARCHIVE_MIME]: "zip",
});
const isDocumentType = mime => !/^(image|audio|video)\//u.test(mime);
const mediaLimit = mime => mime === ARCHIVE_MIME ? MAX_ARCHIVE_BYTES
  : mime.startsWith("video/") || isDocumentType(mime) ? MAX_VIDEO_BYTES : MAX_MEDIA_BYTES;
const mediaId = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
const validAttachment = value => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === (Object.hasOwn(value, "textOffset") ? 5 : 4) && mediaId(value.id)
  && (!Object.hasOwn(value, "textOffset") || (Number.isSafeInteger(value.textOffset) && value.textOffset >= 0 && value.textOffset <= 16 * 1024))
  && typeof value.name === "string" && value.name.trim().length > 0 && value.name.isWellFormed()
  && !/[\x00-\x1f\x7f]/u.test(value.name) && Buffer.byteLength(JSON.stringify(value.name)) <= 256
  && Object.hasOwn(MIME_EXTENSIONS, value.mimeType)
  && Number.isSafeInteger(value.size) && value.size > 0 && value.size <= mediaLimit(value.mimeType);
const validAttachments = value => Array.isArray(value) && value.length <= MAX_ATTACHMENTS
  && value.every(item => validAttachment(item) && item.mimeType !== ARCHIVE_MIME) && new Set(value.map(item => item.id)).size === value.length;
const attachmentFields = (value, fields) => value && Object.hasOwn(value, "attachments") ? [...fields, "attachments"] : fields;
const fail = (code = "INSPIRATION_INVALID") => { throw serviceError(code, code === "INSPIRATION_NOT_FOUND" ? "附件不存在或尚未上传完成" : "媒体附件无效"); };

function decodeChunk(content) {
  if (typeof content !== "string" || content.length > CHUNK_BYTES * 4 / 3 || !content.length) fail();
  const data = Buffer.from(content, "base64");
  if (data.toString("base64") !== content) fail();
  return data;
}

function matchesMediaType(data, mime) {
  const head = data.subarray(0, 12);
  // Documents are opaque originals, always delivered as downloads, never rendered as HTML.
  if (isDocumentType(mime)) return mime !== ARCHIVE_MIME || (head.length >= 4 && head.readUInt32LE(0) === 0x04034b50);
  if (mime === "image/png") return head.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (mime === "image/jpeg") return head.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"));
  if (mime === "image/gif") return ["GIF87a", "GIF89a"].includes(head.toString("ascii", 0, 6));
  if (mime === "image/webp" || mime === "audio/wav") return head.toString("ascii", 0, 4) === "RIFF"
    && head.toString("ascii", 8, 12) === (mime === "image/webp" ? "WEBP" : "WAVE");
  if (mime === "audio/webm" || mime === "video/webm") return head.subarray(0, 4).equals(Buffer.from("1a45dfa3", "hex"));
  if (mime === "audio/ogg") return head.toString("ascii", 0, 4) === "OggS";
  if (mime === "image/heic" || mime === "image/heif") return head.toString("ascii", 4, 8) === "ftyp"
    && ["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(head.toString("ascii", 8, 12));
  if (mime === "audio/mp4" || mime === "video/mp4") return head.toString("ascii", 4, 8) === "ftyp";
  if (mime === "video/quicktime") return ["ftyp", "moov", "mdat", "wide"].includes(head.toString("ascii", 4, 8));
  return mime === "audio/mpeg" && (head.toString("ascii", 0, 3) === "ID3" || (head[0] === 255 && (head[1] & 224) === 224));
}

const MEDIA_SCHEMA = `
CREATE TABLE inspiration_media (id TEXT PRIMARY KEY, metadata TEXT NOT NULL CHECK(json_valid(metadata)), received INTEGER NOT NULL);
CREATE TABLE inspiration_media_chunks (media_id TEXT NOT NULL REFERENCES inspiration_media(id), offset INTEGER NOT NULL,
  data BLOB NOT NULL, PRIMARY KEY(media_id, offset));
PRAGMA user_version=3;
`;

class InspirationMediaStore {
  constructor(db, paths) { this.db = db; this.paths = paths; this.previewTasks = new Map(); this.previewQueue = Promise.resolve(); }

  write({ attachment, offset, content }) {
    if (!validAttachment(attachment) || !Number.isSafeInteger(offset) || offset < 0 || offset % CHUNK_BYTES || offset >= attachment.size) fail();
    const data = decodeChunk(content);
    if (data.length !== Math.min(CHUNK_BYTES, attachment.size - offset) || (offset === 0 && !matchesMediaType(data, attachment.mimeType))) fail();
    const metadata = JSON.stringify({ id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size });
    return transaction(this.db, () => {
      let row = this.db.prepare("SELECT metadata,received FROM inspiration_media WHERE id=?").get(attachment.id);
      if (!row) {
        if (offset !== 0) fail();
        this.db.prepare("INSERT INTO inspiration_media VALUES (?,?,0)").run(attachment.id, metadata);
        row = { metadata, received: 0 };
      }
      if (row.metadata !== metadata || offset > row.received) fail();
      if (offset < row.received) {
        const previous = this.db.prepare("SELECT data FROM inspiration_media_chunks WHERE media_id=? AND offset=?").get(attachment.id, offset);
        if (!previous || !Buffer.from(previous.data).equals(data)) fail();
      } else {
        this.db.prepare("INSERT INTO inspiration_media_chunks VALUES (?,?,?)").run(attachment.id, offset, data);
        this.db.prepare("UPDATE inspiration_media SET received=? WHERE id=?").run(offset + data.length, attachment.id);
      }
      return { attachment, nextOffset: offset + data.length };
    });
  }

  descriptor(id) {
    if (!mediaId(id)) fail();
    const row = this.db.prepare("SELECT metadata,received FROM inspiration_media WHERE id=?").get(id);
    if (!row) fail("INSPIRATION_NOT_FOUND");
    const attachment = JSON.parse(row.metadata);
    if (!validAttachment(attachment) || row.received !== attachment.size) fail("INSPIRATION_NOT_FOUND");
    return attachment;
  }

  assertAvailable(attachments) {
    if (!validAttachments(attachments)) fail();
    for (const attachment of attachments) {
      const saved = this.descriptor(attachment.id);
      if (Object.keys(saved).some(key => saved[key] !== attachment[key])) fail();
    }
  }

  read({ id, offset }) {
    const attachment = this.descriptor(id);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset % CHUNK_BYTES || offset >= attachment.size) fail();
    const row = this.db.prepare("SELECT data FROM inspiration_media_chunks WHERE media_id=? AND offset=?").get(id, offset);
    if (!row) fail("INSPIRATION_NOT_FOUND");
    const data = Buffer.from(row.data);
    return { attachment, content: data.toString("base64"), nextOffset: offset + data.length };
  }

  async readPreview({ id, offset }) {
    const attachment = this.descriptor(id);
    if (!["image/heic", "image/heif", "video/quicktime", "video/mp4"].includes(attachment.mimeType)) return this.read({ id, offset });
    if (!Number.isSafeInteger(offset) || offset < 0 || offset % CHUNK_BYTES) fail();
    const { previewPath, readPreviewChunk, convertPreview } = require("./inspiration-media-preview");
    const file = previewPath(this.paths, attachment);
    const cached = readPreviewChunk(file, attachment, offset);
    if (cached) return cached;
    if (!this.previewTasks.has(id)) {
      // Serialize expensive native conversions; requests for the same asset share the work.
      const task = this.previewQueue.catch(() => {}).then(() => convertPreview(this.materialize(attachment), file, attachment, this.paths));
      this.previewTasks.set(id, task);
      this.previewQueue = task;
      void task.finally(() => this.previewTasks.delete(id)).catch(() => {});
    }
    await this.previewTasks.get(id);
    return readPreviewChunk(file, attachment, offset);
  }

  filePath(attachment) {
    return path.join(this.paths.stateDir, "inspiration-media", `${attachment.id}.${MIME_EXTENSIONS[attachment.mimeType]}`);
  }

  materialize(attachment) {
    this.assertAvailable([attachment]);
    const file = this.filePath(attachment);
    const data = Buffer.concat(this.db.prepare("SELECT data FROM inspiration_media_chunks WHERE media_id=? ORDER BY offset")
      .all(attachment.id).map(row => Buffer.from(row.data)));
    // Runtime tools receive only a file generated from the saved bytes, never a user-supplied path.
    let previous;
    try { previous = readPrivateFile(file, { maxBytes: MAX_VIDEO_BYTES }); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!previous?.equals(data)) atomicWritePrivateFile(file, data, { trustedRoot: this.paths.trustedRoot });
    return file;
  }
}

module.exports = { CHUNK_BYTES, MAX_MEDIA_BYTES, MAX_VIDEO_BYTES, MAX_ATTACHMENTS, MEDIA_SCHEMA, InspirationMediaStore,
  ARCHIVE_MIME, MAX_ARCHIVE_BYTES, isDocumentType, matchesMediaType,
  validAttachment, validAttachments, attachmentFields, mediaId, decodeChunk };
