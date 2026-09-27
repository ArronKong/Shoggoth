"use strict";

// Run on a fresh public-source export before pushing, and on the assembled App
// from electron-builder's afterPack hook before any signing or publication.
const { createPrivateKey } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PRIVATE_KEY_BLOCK = /-----BEGIN ((?:(?:ENCRYPTED|RSA|EC|DSA|OPENSSH) )?PRIVATE KEY)-----([\s\S]{0,131072}?)-----END \1-----/gu;
const PRIVATE_KEY_FILE = /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:p8|p12|pfx|key|kdbx|keychain-db))$/iu;

function hasPrivateJwk(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 32) return false;
  if (typeof value.kty === "string" && typeof value.d === "string") return true;
  return Object.values(value).some((part) => hasPrivateJwk(part, depth + 1));
}

function isPrivateKeyBlock(block, body) {
  const normalized = block.replace(/\\r\\n|\\n/gu, "\n");
  try {
    createPrivateKey(normalized);
    return true;
  } catch { /* Encrypted keys and deliberately invalid test fixtures need a second check. */ }
  const encoded = body.replace(/\\r\\n|\\n/gu, "\n")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z0-9+/=]{16,}$/u.test(line))
    .join("");
  return encoded.length >= 64;
}

function inspectFile(name, bytes, findings) {
  const normalizedName = name.split(path.sep).join("/");
  if (PRIVATE_KEY_FILE.test(normalizedName)) {
    findings.push({ path: name, reason: "credential file name" });
  }
  const text = bytes.toString("latin1");
  for (const match of text.matchAll(PRIVATE_KEY_BLOCK)) {
    if (isPrivateKeyBlock(match[0], match[2])) {
      findings.push({ path: name, reason: "private key block" });
      break;
    }
  }
  if (/\.(?:json|jwk)$/iu.test(name)) {
    try {
      if (hasPrivateJwk(JSON.parse(bytes.toString("utf8")))) {
        findings.push({ path: name, reason: "private JWK" });
      }
    } catch { /* Non-JSON files with these suffixes remain covered by the other checks. */ }
  }
  if (/\.der$/iu.test(name)) {
    for (const type of ["pkcs8", "pkcs1", "sec1"]) {
      try {
        createPrivateKey({ key: bytes, format: "der", type });
        findings.push({ path: name, reason: "DER private key" });
        break;
      } catch { /* Public certificates and unrelated DER data are allowed. */ }
    }
  }
}

function scanAsar(archive, relative, findings) {
  const asar = require("@electron/asar");
  let count = 0;
  for (const rawName of asar.listPackage(archive)) {
    const name = rawName.replace(/^\//u, "");
    const stat = asar.statFile(archive, name);
    if (stat.files) continue;
    if (stat.link) {
      if (PRIVATE_KEY_FILE.test(name)) findings.push({ path: `${relative}:${name}`, reason: "credential symlink name" });
      continue;
    }
    inspectFile(`${relative}:${name}`, asar.extractFile(archive, name), findings);
    count += 1;
  }
  return count;
}

function scanDirectory(root) {
  const absoluteRoot = path.resolve(root);
  if (!fs.statSync(absoluteRoot).isDirectory() || fs.lstatSync(absoluteRoot).isSymbolicLink()) {
    throw new Error("Private-key check requires a real directory");
  }
  const findings = [];
  let fileCount = 0;
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const relative = path.relative(absoluteRoot, target);
        if (PRIVATE_KEY_FILE.test(relative.split(path.sep).join("/"))) {
          findings.push({ path: relative, reason: "credential symlink name" });
        }
        continue;
      }
      if (entry.isDirectory()) {
        visit(target);
      } else if (entry.isFile()) {
        const relative = path.relative(absoluteRoot, target);
        if (entry.name === "app.asar") {
          fileCount += scanAsar(target, relative, findings);
        } else {
          inspectFile(relative, fs.readFileSync(target), findings);
          fileCount += 1;
        }
      } else {
        throw new Error(`Private-key check cannot read non-regular file: ${target}`);
      }
    }
  };
  visit(absoluteRoot);
  if (findings.length) {
    const summary = findings.slice(0, 20).map(({ path: file, reason }) => `${file} (${reason})`).join("; ");
    throw new Error(`PRIVATE_KEY_MATERIAL_FOUND: ${findings.length} finding(s): ${summary}`);
  }
  return { fileCount };
}

if (require.main === module) {
  if (process.argv.length !== 3) {
    console.error("Usage: node scripts/check-release-private-keys.cjs <public-source-export-or-App>");
    process.exitCode = 2;
  } else {
    try {
      const { fileCount } = scanDirectory(process.argv[2]);
      console.log(`Private-key check passed: ${fileCount} files`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

module.exports = { scanDirectory };
