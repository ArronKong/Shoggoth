#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { E5_MODEL } = require("../app/agent-service/e5-model-contract.js");
const { isTransientReadError, sleep } = require("./release-http.cjs");
const retryDelays = [5_000, 15_000];
const transientStatuses = new Set([502, 503, 504]);

function verified(file, entry) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size === entry.bytes
      && crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") === entry.sha256;
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function writeDownload(response, temporary, entry) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw Object.assign(new Error(`E5_ASSET_DOWNLOAD_FAILED:${response.status}:${entry.name}`), { status: response.status });
  }
  const fd = fs.openSync(temporary, "wx", 0o644);
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > entry.bytes) throw new Error(`E5_ASSET_SIZE_INVALID:${entry.name}`);
      let offset = 0;
      while (offset < chunk.length) offset += fs.writeSync(fd, chunk, offset, chunk.length - offset);
    }
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

async function downloadAsset(model, entry, temporary, { fetcher, pause, warn }) {
  // Build-time download only. Product runtime contains no download path.
  const url = `https://huggingface.co/${model.modelId}/resolve/${model.revision}/${entry.name}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(180_000) });
      await writeDownload(response, temporary, entry);
      return;
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      if (!(transientStatuses.has(error.status) || isTransientReadError(error))) throw error;
      const delay = retryDelays[attempt];
      if (delay === undefined) throw new Error(`E5_ASSET_DOWNLOAD_RETRIES_EXHAUSTED:${entry.name}`, { cause: error });
      warn(`E5 download interrupted for ${entry.name}. Retrying this file in ${delay / 1000}s.`);
      await pause(delay);
    }
  }
}

export async function prepareE5Model({
  model = E5_MODEL, destination = path.join(root, ".vendor/embedding/model"),
  cache = path.join(root, ".artifacts/memory-p4-model-comparison-20260928/models/e5-small"), checkOnly = false,
} = {}, { fetcher = fetch, pause = sleep, warn = console.warn } = {}) {
  let scratch;
  if (!checkOnly) {
    fs.mkdirSync(destination, { recursive: true });
    scratch = fs.mkdtempSync(path.join(destination, ".preparing-"));
  }
  try {
    for (const entry of model.files) {
      const target = path.join(destination, entry.name);
      if (verified(target, entry)) continue;
      if (checkOnly) throw new Error(`E5_BUNDLED_ASSET_INVALID:${entry.name}`);
      const temporary = path.join(scratch, "asset.part");
      const local = path.join(cache, entry.name);
      if (verified(local, entry)) {
        fs.copyFileSync(local, temporary, fs.constants.COPYFILE_FICLONE);
      } else {
        await downloadAsset(model, entry, temporary, { fetcher, pause, warn });
      }
      if (!verified(temporary, entry)) throw new Error(`E5_ASSET_IDENTITY_INVALID:${entry.name}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(temporary, target);
    }
    const manifest = { ...model, totalBytes: model.files.reduce((sum, entry) => sum + entry.bytes, 0) };
    const manifestPath = path.join(destination, "manifest.json");
    if (checkOnly) {
      if (JSON.stringify(JSON.parse(fs.readFileSync(manifestPath))) !== JSON.stringify(manifest)) {
        throw new Error("E5_ASSET_MANIFEST_INVALID");
      }
    } else {
      const temporary = path.join(scratch, "manifest.json");
      fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
      fs.renameSync(temporary, manifestPath);
    }
    return manifest;
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some(value => value !== "--check")) throw new Error("E5_PREPARE_ARGUMENTS_INVALID");
    const manifest = await prepareE5Model({ checkOnly: args.includes("--check") });
    console.log(`E5 ${manifest.revision}: ${manifest.files.length} offline assets verified (${manifest.totalBytes} bytes).`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
