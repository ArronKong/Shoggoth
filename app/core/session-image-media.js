"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const IMAGE_TYPES = new Map([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".gif", "image/gif"], [".webp", "image/webp"], [".svg", "image/svg+xml"],
  [".bmp", "image/bmp"], [".avif", "image/avif"],
]);

// Read only explicit image deliveries, not paths mentioned in code, user input,
// tool arguments or file listings. This is separate from output-artifact discovery:
// an Agent may send an existing image without having generated it in this turn.
function imageReferences(text) {
  if (typeof text !== "string") return [];
  const refs = [];
  let fence = null;
  const prose = text.split("\n").map(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return "";
    }
    if (marker && !(marker[1][0] === "`" && marker[2].includes("`"))) { fence = marker[1]; return ""; }
    return /^(?: {4}|\t)/.test(line) ? "" : line;
  }).join("\n").replace(/(`+)[\s\S]*?\1(?!`)/g, "");
  for (const match of prose.matchAll(/^[ \t]*MEDIA:[ \t]*(\S[^\n]*?)[ \t]*$/gim)) refs.push(match[1]);
  // Destinations may have spaces inside <...> or balanced filename parentheses.
  for (const match of prose.matchAll(/!\[(?:\\.|[^\]\\\n])*\]\([ \t]*/g)) {
    let index = match.index + match[0].length;
    if (prose[index] === "<") {
      const end = prose.indexOf(">", index + 1);
      if (end >= 0 && !/[\r\n]/.test(prose.slice(index, end)) && /^[ \t]*(?:["'][^\n]*["'][ \t]*)?\)/.test(prose.slice(end + 1))) {
        refs.push(prose.slice(index + 1, end));
      }
      continue;
    }
    const start = index;
    let depth = 0;
    for (; index < prose.length; index++) {
      const char = prose[index];
      if (char === "\\") { index++; continue; }
      if (char === "(" && ++depth > 16) break;
      if (char === ")") {
        if (depth === 0) { refs.push(prose.slice(start, index)); break; }
        depth--;
      }
      if (/\s/.test(char)) {
        if (depth === 0 && /^[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^\n]*\))[ \t]*\)/.test(prose.slice(index))) refs.push(prose.slice(start, index));
        break;
      }
    }
  }
  const definitions = new Map();
  const label = value => value.trim().replace(/\s+/g, " ").toLowerCase();
  for (const match of prose.matchAll(/^ {0,3}\[([^\]\n]+)\]:[ \t]*(?:<([^<>\n]+)>|(\S+))/gm)) {
    if (!definitions.has(label(match[1]))) definitions.set(label(match[1]), match[2] || match[3]);
  }
  for (const match of prose.matchAll(/!\[([^\]\n]+)\](?:\[([^\]\n]*)\])?(?!\()/g)) {
    const ref = definitions.get(label(match[2] || match[1]));
    if (ref) refs.push(ref);
  }
  return refs;
}

function resolveImageReference(ref, workspace, runtimeHome, uriEncoded = false) {
  if (typeof workspace !== "string" || typeof runtimeHome !== "string"
    || typeof ref !== "string" || ref.length > 4096 || !ref || /[\x00-\x1f\x7f]/.test(ref)) return null;
  let value = ref;
  try {
    if (/^file:/i.test(value)) value = fileURLToPath(value);
    else if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//")) return null;
    else if (uriEncoded) value = decodeURIComponent(value.replace(/\\([\\()<>])/g, "$1"));
  } catch { return null; }
  if (/[\x00-\x1f\x7f]/.test(value) || !IMAGE_TYPES.has(path.extname(value).toLowerCase())) return null;
  if (value.startsWith("~/")) return path.resolve(runtimeHome, value.slice(2));
  return path.resolve(workspace, value);
}

function matchesImageType(bytes, mimeType) {
  if (mimeType === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mimeType === "image/gif") return /^GIF8[79]a/.test(bytes.subarray(0, 6).toString("ascii"));
  if (mimeType === "image/webp") return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (mimeType === "image/bmp") return bytes.subarray(0, 2).toString("ascii") === "BM";
  if (mimeType === "image/avif") return bytes.subarray(4, 8).toString("ascii") === "ftyp" && /avif|avis/.test(bytes.subarray(8, 40).toString("ascii"));
  return mimeType === "image/svg+xml" && /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+svg[^<>\[\]]*>\s*)?<svg[\s>]/i
    .test(bytes.subarray(0, 4096).toString("utf8").replace(/^\uFEFF/, ""));
}

async function readSessionImage({ messages, ref, workspace, runtimeHome }) {
  const requested = resolveImageReference(ref, workspace, runtimeHome);
  if (!requested || !Array.isArray(messages)) return null;
  const shared = messages.some(message => {
    if (message?.role !== "assistant") return false;
    const text = typeof message.content === "string" ? message.content : (Array.isArray(message.content) ? message.content : [])
      .filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("\n");
    return imageReferences(text).some(candidate =>
      resolveImageReference(candidate, workspace, runtimeHome) === requested
      || resolveImageReference(candidate, workspace, runtimeHome, true) === requested);
  });
  if (!shared) return null;
  let handle;
  try {
    // No symlink file, FIFO or directory reads; stat and bytes belong to the same
    // descriptor. Keep binary data out of the Service's bounded JSON protocol.
    handle = await fs.promises.open(requested, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) return null;
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) return null;
      offset += result.bytesRead;
    }
    const mimeType = IMAGE_TYPES.get(path.extname(requested).toLowerCase());
    return matchesImageType(bytes, mimeType) ? { bytes, mimeType } : null;
  } catch { return null; }
  finally { await handle?.close(); }
}

module.exports = { imageReferences, resolveImageReference, readSessionImage, MAX_IMAGE_BYTES };
