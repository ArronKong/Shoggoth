"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { atomicWritePrivateFile, readPrivateFile, preparePrivateParent } = require("./private-file");
const { validAttachment, MAX_VIDEO_BYTES } = require("./inspiration-media");
const { isText, utf8 } = require("./chat-attachment-text");
const { serviceError } = require("./security");
const { canUseOriginal } = require("../core/chat-secret-fallback");

const MAX_TEXT = 256 * 1024;
const MAX_WIRE = 72 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/u;
const fail = (code = "SECRET_MEDIA_UNAVAILABLE") => { throw serviceError(code,
  code === "SECRET_MEDIA_SPEECH_UNAVAILABLE" ? "暂时无法在这台设备上识别语音，附件尚未发送"
    : "暂时无法隐藏附件中的私密信息，附件尚未发送"); };
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

// Align opaque references with their surrounding literal text. If a projection
// cannot be aligned unambiguously, hide every recognized line instead of
// guessing which pixels contained the replaced value.
function replacedRanges(raw, projected) {
  if (raw === projected) return [];
  const pattern = /\{\{SHOGGOTH_SECRET_[a-f0-9]{32}\}\}|\[LOCAL_CREDENTIAL_REDACTED\]/gu;
  const matches = [...projected.matchAll(pattern)];
  if (!matches.length) return [{ start: 0, end: raw.length }];
  let source = 0, output = 0; const ranges = [];
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index], literal = projected.slice(output, match.index);
    if (!raw.startsWith(literal, source)) return [{ start: 0, end: raw.length }];
    source += literal.length; output = match.index + match[0].length;
    const nextLiteral = projected.slice(output, matches[index + 1]?.index ?? projected.length);
    const end = nextLiteral ? raw.indexOf(nextLiteral, source) : raw.length;
    if (end < source || (!nextLiteral && index < matches.length - 1)) return [{ start: 0, end: raw.length }];
    ranges.push({ start: source, end }); source = end;
  }
  if (raw.slice(source) !== projected.slice(output)) return [{ start: 0, end: raw.length }];
  return ranges;
}

// One helper owns the decoded pixels until projection is ready. There is no
// raw image file, shell command, inherited provider credential or network path.
function inspectMedia({ binary, source, sourceFd, data, mimeType, locale, signal, project, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(binary, [], { stdio: ["pipe", "pipe", "pipe", ...(Number.isInteger(sourceFd) ? [sourceFd] : [])],
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" } });
    let buffer = "", phase = 0, output = null, failure = null, pending = Promise.resolve();
    const stop = code => { failure ||= serviceError(code, "附件的本地凭据处理未完成"); child.kill("SIGKILL"); };
    const abort = () => stop("SECRET_MEDIA_CANCELED");
    const timer = setTimeout(() => stop("SECRET_MEDIA_TIMEOUT"), 120_000); timer.unref?.();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.on("error", () => { failure ||= serviceError("SECRET_MEDIA_UNAVAILABLE", "本地附件处理程序不可用"); });
    // Diagnostics from system frameworks may contain file paths. Drain without
    // recording them; the private protocol returns stable error codes instead.
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => stop("SECRET_MEDIA_UNAVAILABLE"));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_WIRE) return stop("SECRET_MEDIA_CAPACITY");
      while (buffer.includes("\n")) {
        const split = buffer.indexOf("\n"), line = buffer.slice(0, split); buffer = buffer.slice(split + 1);
        pending = pending.then(async () => {
          let value; try { value = JSON.parse(line); } catch { return stop("SECRET_MEDIA_INVALID"); }
          if (value.errorCode) return stop(/^SECRET_MEDIA_[A-Z_]+$/u.test(value.errorCode) ? value.errorCode : "SECRET_MEDIA_UNAVAILABLE");
          if (value.version !== 1) return stop("SECRET_MEDIA_INVALID");
          if (phase++ === 0) {
            if (!Array.isArray(value.pages) || value.pages.length > 64 || typeof value.transcript !== "string"
              || value.pages.some(page => !Array.isArray(page) || page.length > 4096 || page.some(block =>
                typeof block.text !== "string" || !block.text.isWellFormed() || !Array.isArray(block.box)
                || block.box.length !== 4 || block.box.some(n => !Number.isFinite(n))))) return stop("SECRET_MEDIA_INVALID");
            const projected = await project(value);
            output = { text: projected.text };
            if (signal?.aborted) return abort();
            child.stdin.end(`${JSON.stringify({ masks: projected.masks })}\n`);
          } else if (phase === 2) {
            if (!["image/png", "application/pdf", "text/plain"].includes(value.mimeType)
              || typeof value.data !== "string") return stop("SECRET_MEDIA_INVALID");
            const data = Buffer.from(value.data, "base64");
            if (data.toString("base64") !== value.data || data.length > MAX_VIDEO_BYTES) return stop("SECRET_MEDIA_CAPACITY");
            output = { ...output, data, mimeType: value.mimeType };
          } else stop("SECRET_MEDIA_INVALID");
        }).catch(error => { failure ||= error; child.kill("SIGKILL"); });
      }
    });
    child.on("close", code => { void pending.then(() => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0 || phase !== 2 || !output?.data || buffer.trim()) reject(serviceError("SECRET_MEDIA_UNAVAILABLE", "本地附件处理未完成"));
      else resolve(output);
    }); });
    if (!signal?.aborted) child.stdin.write(`${JSON.stringify({ version: 1,
      path: Number.isInteger(sourceFd) ? "/dev/fd/3" : source, data, mimeType, locale })}\n`);
  });
}

class SecretMediaMediator {
  constructor({ paths, secrets, binary, inspect = inspectMedia }) {
    this.paths = paths; this.secrets = secrets; this.binary = binary; this.inspect = inspect;
    this.pending = new Map();
  }
  supportsImages() {
    if (typeof this.binary !== "string" || !this.binary) return false;
    try { return fs.statSync(this.binary).isFile() && (fs.accessSync(this.binary, fs.constants.X_OK), true); }
    catch { return false; }
  }
  location(scope, attachment) {
    if (!scope?.profileId || !scope.sessionId || !validAttachment(attachment)) fail("SECRET_MEDIA_INVALID");
    const key = digest(JSON.stringify([scope.profileId, scope.sessionId, attachment.id]));
    const directory = path.join(this.paths.stateDir, "chat-safe-attachments", key);
    return { key, directory, receipt: path.join(directory, "projection-v1.json") };
  }
  read(scope, attachment) {
    const location = this.location(scope, attachment);
    let record;
    try { record = JSON.parse(readPrivateFile(location.receipt, { maxBytes: MAX_TEXT * 4 }).toString("utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; fail(); }
    if (record.version !== 1 || record.id !== attachment.id || record.sourceDescriptor !== JSON.stringify(attachment) || !HASH.test(record.sha256)
      || !["image/png", "application/pdf", "text/plain"].includes(record.mimeType)
      || typeof record.text !== "string" || Buffer.byteLength(record.text) > MAX_TEXT
      || !["safe.png", "safe.pdf", "safe.txt", "current.txt"].includes(record.file)) fail();
    const file = path.join(location.directory, record.file);
    const bytes = readPrivateFile(file, { maxBytes: MAX_VIDEO_BYTES });
    if (digest(bytes) !== record.sha256 || bytes.length !== record.size) fail();
    // A durable text replacement also retires older raster/text copies after
    // an interrupted cleanup. Only this private cache's fixed filenames are
    // eligible; the original user attachment is never touched.
    if (record.file === "current.txt") this._retirePreviousCopies(location.directory);
    // Later known values also protect old OCR transcripts. The saved original
    // user attachment remains available to the user, never to a model file tool.
    const text = this.secrets.projectText(scope, record.text);
    if (text !== record.text) {
      // A value newly identified in this session can occur in an older image.
      // Use the complete safe text until the next local pixel transformation;
      // never return the stale raster to a native file/image tool.
      const safeFile = path.join(location.directory, "current.txt");
      const safeBytes = Buffer.from(text || "[Empty attachment]");
      atomicWritePrivateFile(safeFile, safeBytes, { trustedRoot: this.paths.trustedRoot });
      // Persist the safer representation. Forgetting an expired credential
      // must not make a previously hidden value reappear from the older cache.
      atomicWritePrivateFile(location.receipt, JSON.stringify({ ...record, file: "current.txt",
        mimeType: "text/plain", text, size: safeBytes.length, sha256: digest(safeBytes) }), { trustedRoot: this.paths.trustedRoot });
      this._retirePreviousCopies(location.directory);
      return { id: attachment.id, name: `attachment-${attachment.id}.txt`, mimeType: "text/plain",
        size: safeBytes.length, path: safeFile, secretProjection: 1, extractedText: text };
    }
    return { id: attachment.id, name: `attachment-${attachment.id}.${path.extname(file).slice(1)}`,
      mimeType: record.mimeType, size: bytes.length, path: file, secretProjection: 1, extractedText: text };
  }
  _retirePreviousCopies(directory) {
    for (const name of ["safe.png", "safe.pdf", "safe.txt"]) {
      const file = path.join(directory, name);
      try { readPrivateFile(file, { maxBytes: MAX_VIDEO_BYTES }); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      fs.unlinkSync(file);
    }
  }
  prepare(scope, attachment, media, { signal, locale = "en-US" } = {}) {
    const { key } = this.location(scope, attachment);
    if (this.pending.has(key)) return this.pending.get(key);
    const task = this._prepare(scope, attachment, media, { signal, locale }).finally(() => this.pending.delete(key));
    this.pending.set(key, task); return task;
  }
  async projectInline(scope, { mimeType, data }, { signal } = {}) {
    if (!this.binary || !["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"].includes(mimeType)
      || typeof data !== "string" || data.length > Math.ceil(MAX_VIDEO_BYTES / 3) * 4) fail();
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length || bytes.length > MAX_VIDEO_BYTES || bytes.toString("base64") !== data) fail("SECRET_MEDIA_INVALID");
    return this.inspect({ binary: this.binary, data, mimeType, signal, project: inspection =>
      this.projectInspection(scope, `inline-media-v1:${digest(bytes)}`, inspection) });
  }
  async projectResult(scope, value, options = {}) {
    // Remove binary fields before text projection. Only freshly transformed
    // bytes are restored, so base64 is neither treated as ordinary prose nor
    // allowed to bypass local image processing through a trusted-looking flag.
    const pending = new Map(); let count = 0;
    const marker = input => {
      if (pending.size >= 8) fail("SECRET_MEDIA_CAPACITY");
      const id = `{{SHOGGOTH_LOCAL_MEDIA_${crypto.randomBytes(16).toString("hex")}}}`;
      pending.set(id, input); return id;
    };
    const walk = (input, depth = 0) => {
      if (++count > 32768 || depth > 48) fail("SECRET_MEDIA_CAPACITY");
      if (!input || typeof input !== "object") return input;
      if (Array.isArray(input)) return input.map(child => walk(child, depth + 1));
      if (["image", "audio"].includes(input.type)) return { type: "text", text: marker({ kind: "block", value: input }) };
      if (typeof input.thumbnail === "string" && typeof input.thumbnailMimeType === "string" && input.artifact) {
        return { ...walk({ ...input, thumbnail: null }, depth + 1), thumbnail: marker({ kind: "thumbnail", value: input }) };
      }
      return Object.fromEntries(Object.entries(input).map(([key, child]) => [key, walk(child, depth + 1)]));
    };
    const skeleton = walk(value);
    const safe = await this.secrets.project(scope, skeleton, { ...options, model: true });
    const outputs = new Map();
    for (const [id, item] of pending) {
      let output = null;
      try {
        const media = await this.projectInline(scope, { mimeType: item.kind === "thumbnail" ? item.value.thumbnailMimeType : item.value.mimeType,
          data: item.kind === "thumbnail" ? item.value.thumbnail : item.value.data }, { signal: options.signal });
        if (media.mimeType === "image/png") output = { type: "image", mimeType: media.mimeType, data: media.data.toString("base64") };
      } catch (error) {
        // Let the caller continue with this result's original bytes. It owns
        // the execution receipt, so failed masking never repeats the tool.
        if (canUseOriginal(error) || options.signal?.aborted) throw error;
      }
      outputs.set(id, output);
    }
    const restore = input => {
      if (!input || typeof input !== "object") return input;
      if (Array.isArray(input)) return input.map(restore);
      if (input.type === "text" && outputs.has(input.text)) return outputs.get(input.text) || { type: "text",
        text: "The image is retained locally. Local credential masking was unavailable; use the protected text snapshot." };
      if (outputs.has(input.thumbnail)) {
        const output = outputs.get(input.thumbnail);
        return { ...input, thumbnail: output?.data || null, thumbnailMimeType: output?.mimeType || null };
      }
      return Object.fromEntries(Object.entries(input).map(([key, child]) => [key, restore(child)]));
    };
    return restore(safe);
  }
  async projectInspection(scope, operationId, inspection) {
    let raw = "";
    const offsets = inspection.pages.map(page => page.map(block => {
      const start = raw.length; raw += `${block.text}\n`;
      return { start, end: raw.length - 1 };
    }));
    raw += inspection.transcript;
    if (Buffer.byteLength(raw) > MAX_TEXT) fail("SECRET_MEDIA_CAPACITY");
    const prepared = (await this.secrets.prepare({ scope, operationId, text: raw })).text;
    const projected = this.secrets.projectText(scope, prepared);
    const ranges = replacedRanges(raw, projected);
    const masks = inspection.pages.map((page, pageIndex) => page.flatMap((block, index) =>
      ranges.some(range => range.start < offsets[pageIndex][index].end && range.end > offsets[pageIndex][index].start)
        || this.secrets.projectText(scope, block.text) !== block.text ? [index] : []));
    return { text: projected, masks };
  }
  async _prepare(scope, attachment, media, { signal, locale }) {
    const saved = this.read(scope, attachment); if (saved) return saved;
    if (signal?.aborted) fail("SECRET_MEDIA_CANCELED");
    media.assertAvailable([attachment]);
    const source = media.materialize(attachment);
    // Read before launching to enforce private-file/symlink and size checks.
    const bytes = readPrivateFile(source, { maxBytes: MAX_VIDEO_BYTES });
    const location = this.location(scope, attachment);
    let data, mimeType, text;
    const prepareText = async raw => {
      if (Buffer.byteLength(raw) > MAX_TEXT) fail("SECRET_MEDIA_CAPACITY");
      return (await this.secrets.prepare({ scope, operationId: `attachment-v1:${attachment.id}`, text: raw })).text;
    };
    if (isText(attachment.name, attachment.mimeType)) {
      const raw = utf8(bytes); if (raw === null) fail("SECRET_MEDIA_INVALID");
      text = await prepareText(raw); data = Buffer.from(text || "[Empty text attachment]"); mimeType = "text/plain";
    } else {
      if (!this.binary) fail();
      // Bind decoding to the bytes already checked above. Reopening a pathname
      // in the child would race a replacement or symlink change after validation.
      let sourceFd, result;
      try {
        const audiovisual = /^(?:audio|video)\//u.test(attachment.mimeType);
        if (audiovisual) {
          sourceFd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          const stat = fs.fstatSync(sourceFd), pinned = Buffer.alloc(bytes.length);
          if (!stat.isFile() || stat.size !== bytes.length
            || fs.readSync(sourceFd, pinned, 0, pinned.length, 0) !== pinned.length || !pinned.equals(bytes)) fail();
        }
        result = await this.inspect({ binary: this.binary,
          ...(audiovisual ? { sourceFd } : { data: bytes.toString("base64") }), mimeType: attachment.mimeType, locale, signal,
          project: inspection => this.projectInspection(scope, `attachment-v1:${attachment.id}`, inspection) });
      } finally { if (Number.isInteger(sourceFd)) fs.closeSync(sourceFd); }
      ({ data, mimeType, text } = result);
      if (mimeType === "text/plain") data = Buffer.from(text || "[No speech recognized]");
    }
    if (signal?.aborted) fail("SECRET_MEDIA_CANCELED");
    const file = mimeType === "image/png" ? "safe.png" : mimeType === "application/pdf" ? "safe.pdf" : "safe.txt";
    preparePrivateParent(location.receipt, this.paths.trustedRoot);
    atomicWritePrivateFile(path.join(location.directory, file), data, { trustedRoot: this.paths.trustedRoot });
    atomicWritePrivateFile(location.receipt, JSON.stringify({ version: 1, id: attachment.id,
      sourceDescriptor: JSON.stringify(attachment), sourceHash: digest(bytes), file, mimeType,
      size: data.length, sha256: digest(data), text }), { trustedRoot: this.paths.trustedRoot });
    return this.read(scope, attachment);
  }
}

module.exports = { SecretMediaMediator, inspectMedia, replacedRanges };
