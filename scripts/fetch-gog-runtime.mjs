#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repoRoot, "build", "gog-runtime-manifest.json");
const vendorRoot = path.join(repoRoot, ".vendor", "gogcli");
const maxArchiveBytes = 50 * 1024 * 1024;
const maxBinaryBytes = 100 * 1024 * 1024;
const archCpu = { arm64: 0x0100000c, x64: 0x01000007 };

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8", maxBuffer: 64 * 1024, timeout: 300_000, ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed (${result.error?.code ?? result.status ?? "unknown"})`);
  }
  return result.stdout;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function checkedBytes(file, expected, maximum, kind) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.size < 1 || stat.size > maximum) {
    throw new Error(`${kind} is not a bounded regular file`);
  }
  const bytes = await fs.readFile(file);
  if (sha256(bytes) !== expected) throw new Error(`${kind} SHA-256 mismatch`);
  return bytes;
}

async function checkedBinary(file, expectedSha, arch) {
  const bytes = await checkedBytes(file, expectedSha, maxBinaryBytes, "gog binary");
  if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0xfeedfacf
    || bytes.readUInt32LE(4) !== archCpu[arch]) {
    throw new Error(`gog binary is not macOS ${arch}`);
  }
  return { bytes: bytes.length, sha256: expectedSha };
}

function parseArgs(argv) {
  const options = { platform: `darwin-${process.arch}`, archiveDir: null };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} needs a value`);
    if (key === "--platform") options.platform = value;
    else if (key === "--archive-dir") options.archiveDir = path.resolve(value);
    else throw new Error(`unsupported argument ${key}`);
  }
  if (!["darwin-arm64", "darwin-x64", "all"].includes(options.platform)) {
    throw new Error(`unsupported gog platform ${options.platform}`);
  }
  return options;
}

export async function fetchGogRuntime(options = {}) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest.version !== "0.42.0") throw new Error("unsupported gog manifest version");
  const platforms = options.platform === "all"
    ? ["darwin-arm64", "darwin-x64"] : [options.platform || `darwin-${process.arch}`];
  const results = [];
  await fs.mkdir(vendorRoot, { recursive: true });
  for (const platform of platforms) {
    const arch = platform.slice("darwin-".length);
    const record = manifest.platforms?.[platform];
    if (!record || !archCpu[arch]
      || !/^https:\/\/github\.com\/openclaw\/gogcli\/releases\/download\/v0\.42\.0\/gogcli_0\.42\.0_darwin_(arm64|amd64)\.tar\.gz$/u.test(record.url)
      || !/^[a-f0-9]{64}$/u.test(record.archiveSha256)
      || !/^[a-f0-9]{64}$/u.test(record.binarySha256)) {
      throw new Error(`invalid gog manifest for ${platform}`);
    }
    const destination = path.join(vendorRoot, arch);
    const binary = path.join(destination, "gog");
    try {
      const verified = await checkedBinary(binary, record.binarySha256, arch);
      results.push({ platform, binary, reused: true, ...verified });
      continue;
    } catch (error) {
      if (await fs.stat(destination).then(() => true, () => false)) {
        throw new Error(`existing ${destination} is not verified: ${error.message}`);
      }
    }
    const staging = await fs.mkdtemp(path.join(vendorRoot, ".gog-staging-"));
    try {
      const archive = path.join(staging, "gog.tar.gz");
      if (options.archiveDir) {
        const source = path.join(options.archiveDir, path.basename(new URL(record.url).pathname));
        await fs.copyFile(source, archive);
      } else {
        run("curl", ["--disable", "--fail", "--silent", "--show-error", "--location",
          "--max-redirs", "5", "--proto", "=https", "--proto-redir", "=https",
          "--connect-timeout", "10", "--max-time", "300", "--max-filesize",
          String(maxArchiveBytes), "--output", archive, "--url", record.url]);
      }
      await checkedBytes(archive, record.archiveSha256, maxArchiveBytes, "gog archive");
      const entries = run("tar", ["-tzf", archive]).trim().split("\n").sort();
      if (JSON.stringify(entries) !== JSON.stringify(["./", "./gog"])) {
        throw new Error("gog archive contains unexpected entries");
      }
      const extracted = path.join(staging, "extracted");
      await fs.mkdir(extracted);
      run("tar", ["-xzf", archive, "-C", extracted, "--no-same-owner"]);
      const verified = await checkedBinary(path.join(extracted, "gog"), record.binarySha256, arch);
      await fs.chmod(path.join(extracted, "gog"), 0o755);
      await fs.rename(extracted, destination);
      results.push({ platform, binary, reused: false, ...verified });
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }
  return results;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  fetchGogRuntime(parseArgs(process.argv.slice(2))).then(results => {
    for (const result of results) process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch(error => {
    process.stderr.write(`[fetch-gog-runtime] ${error.message}\n`);
    process.exitCode = 1;
  });
}
