#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { E5_MODEL } = require("../app/agent-service/e5-model-contract.js");
const destination = path.join(root, ".vendor/embedding/model");
const cache = path.join(root, ".artifacts/memory-p4-model-comparison-20260928/models/e5-small");
const checkOnly = process.argv.slice(2).includes("--check");
if (process.argv.slice(2).some(value => value !== "--check")) throw new Error("E5_PREPARE_ARGUMENTS_INVALID");

function verified(file, entry) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size === entry.bytes
      && crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") === entry.sha256;
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

for (const entry of E5_MODEL.files) {
  const target = path.join(destination, entry.name);
  if (verified(target, entry)) continue;
  if (checkOnly) throw new Error(`E5_BUNDLED_ASSET_INVALID:${entry.name}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.preparing-${process.pid}`;
  try {
    const local = path.join(cache, entry.name);
    if (verified(local, entry)) {
      fs.copyFileSync(local, temporary, fs.constants.COPYFILE_FICLONE);
    } else {
      // Build-time download only. Product runtime contains no download path.
      const url = `https://huggingface.co/${E5_MODEL.modelId}/resolve/${E5_MODEL.revision}/${entry.name}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (!response.ok || !response.body) throw new Error(`E5_ASSET_DOWNLOAD_FAILED:${response.status}`);
      const fd = fs.openSync(temporary, "wx", 0o644);
      let bytes = 0;
      try {
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > entry.bytes) throw new Error("E5_ASSET_SIZE_INVALID");
          let offset = 0;
          while (offset < chunk.length) offset += fs.writeSync(fd, chunk, offset, chunk.length - offset);
        }
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
    }
    if (!verified(temporary, entry)) throw new Error(`E5_ASSET_IDENTITY_INVALID:${entry.name}`);
    fs.renameSync(temporary, target);
  } finally { fs.rmSync(temporary, { force: true }); }
}
const manifest = { ...E5_MODEL, totalBytes: E5_MODEL.files.reduce((sum, entry) => sum + entry.bytes, 0) };
const manifestPath = path.join(destination, "manifest.json");
if (checkOnly) {
  if (JSON.stringify(JSON.parse(fs.readFileSync(manifestPath))) !== JSON.stringify(manifest)) {
    throw new Error("E5_ASSET_MANIFEST_INVALID");
  }
} else {
  fs.writeFileSync(`${manifestPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(`${manifestPath}.tmp`, manifestPath);
}
console.log(`E5 ${E5_MODEL.revision}: ${E5_MODEL.files.length} offline assets verified (${manifest.totalBytes} bytes).`);
