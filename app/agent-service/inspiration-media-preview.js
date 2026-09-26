"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const { atomicWritePrivateFile, openExistingPrivateFile, preparePrivateParent, readPrivateFile } = require("./private-file");
const { serviceError } = require("./security");
const { CHUNK_BYTES, MAX_MEDIA_BYTES, MAX_VIDEO_BYTES } = require("./inspiration-media");
const run = promisify(execFile);
const isVideo = attachment => attachment.mimeType.startsWith("video/");
const previewPath = (paths, attachment) => path.join(paths.stateDir, "inspiration-media", `${attachment.id}.preview-v1.${isVideo(attachment) ? "m4v" : "jpg"}`);

function readPreviewChunk(file, original, offset) {
  let fd;
  try {
    fd = openExistingPrivateFile(file, fs.constants.O_RDONLY);
    const size = fs.fstatSync(fd).size;
    if (!size || size > (isVideo(original) ? MAX_VIDEO_BYTES : MAX_MEDIA_BYTES) || offset >= size) {
      throw serviceError("INSPIRATION_INVALID", "媒体预览范围无效");
    }
    const data = Buffer.alloc(Math.min(CHUNK_BYTES, size - offset));
    let read = 0;
    while (read < data.length) {
      const count = fs.readSync(fd, data, read, data.length - read, offset + read);
      if (!count) throw serviceError("INSPIRATION_UNAVAILABLE", "媒体预览读取未完成");
      read += count;
    }
    return { attachment: { ...original, mimeType: isVideo(original) ? "video/mp4" : "image/jpeg", size },
      content: data.toString("base64"), nextOffset: offset + data.length };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

async function convertPreview(source, target, attachment, paths) {
  if (process.platform !== "darwin") throw serviceError("INSPIRATION_UNSUPPORTED", "此格式需要 macOS 媒体预览支持");
  const parent = preparePrivateParent(target, paths.trustedRoot);
  const directory = fs.mkdtempSync(path.join(parent, ".preview-"));
  try {
    const output = path.join(directory, isVideo(attachment) ? "preview.m4v" : "preview.jpg");
    const command = isVideo(attachment) ? "/usr/bin/avconvert" : "/usr/bin/sips";
    const args = isVideo(attachment)
      ? ["--source", source, "--preset", "PresetAppleM4V720pHD", "--output", output]
      : ["-s", "format", "jpeg", "-s", "formatOptions", "88", "-Z", "2048", source, "--out", output];
    await run(command, args, { timeout: 120_000, maxBuffer: 64 * 1024 });
    fs.chmodSync(output, 0o600);
    const data = readPrivateFile(output, { maxBytes: isVideo(attachment) ? MAX_VIDEO_BYTES : MAX_MEDIA_BYTES });
    const valid = data && (isVideo(attachment) ? data.toString("ascii", 4, 8) === "ftyp" : data.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")));
    if (!valid) throw serviceError("INSPIRATION_UNAVAILABLE", "无法生成媒体预览");
    // Cache a compatible preview; uploads and agent-visible originals remain byte-for-byte intact.
    atomicWritePrivateFile(target, data, { trustedRoot: paths.trustedRoot });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

module.exports = { previewPath, readPreviewChunk, convertPreview };
