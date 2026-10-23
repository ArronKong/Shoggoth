"use strict";

const { createHash } = require("node:crypto");
const PAGE_BYTES = 16 * 1024;
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const validDigest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const validOffset = (value) => Number.isSafeInteger(value) && value >= 0;
const validText = (value) => typeof value === "string" && value.isWellFormed() && !value.includes("\0");

// Offset 和总长以 UTF-8 字节计；分页只在完整字符边界切开。摘要固定原始最终正文。
function resultPage(text, { offset = 0, digest = null } = {}) {
  if (!validText(text) || !validOffset(offset)) throw Object.assign(new Error("result invalid"), { code: "GROUP_RESULT_INVALID" });
  const bytes = Buffer.from(text, "utf8");
  const actualDigest = sha256(text);
  if (offset > bytes.length || (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80)
    || (digest !== null && digest !== actualDigest)) {
    throw Object.assign(new Error("result changed or offset invalid"), { code: "GROUP_RESULT_MISMATCH" });
  }
  let end = Math.min(bytes.length, offset + PAGE_BYTES);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  // 控制字符在 JSON 中会膨胀；完整分页也必须留在既有 64 KiB IPC 帧预算内。
  while (Buffer.byteLength(JSON.stringify(bytes.subarray(offset, end).toString("utf8"))) > 2 * PAGE_BYTES) {
    end = offset + Math.floor((end - offset) / 2);
    while (end > offset && (bytes[end] & 0xc0) === 0x80) end--;
  }
  return { offset, nextOffset: end < bytes.length ? end : null, totalBytes: bytes.length,
    digest: actualDigest, text: bytes.subarray(offset, end).toString("utf8") };
}

function validResultPage(page) {
  if (!page || Object.getPrototypeOf(page) !== Object.prototype
    || Object.keys(page).sort().join(",") !== "digest,nextOffset,offset,text,totalBytes"
    || !validOffset(page.offset) || !validOffset(page.totalBytes) || !validDigest(page.digest) || !validText(page.text)) return false;
  const size = Buffer.byteLength(page.text, "utf8");
  const end = page.offset + size;
  return size <= PAGE_BYTES && end <= page.totalBytes
    && (page.nextOffset === null ? end === page.totalBytes : size > 0 && page.nextOffset === end && end < page.totalBytes);
}

module.exports = { PAGE_BYTES, sha256, validDigest, validOffset, validText, resultPage, validResultPage };
