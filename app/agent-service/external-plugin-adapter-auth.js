"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");
const { ensurePrivateDirectoryTree, lstatIfExists, serviceError } = require("./security");
const { validToken } = require("./external-plugin-lease");

const BACKENDS = new Set(["openclaw", "hermes"]);

function fail() { throw serviceError("EXTERNAL_PLUGIN_ADAPTER_AUTH_FAILED", "外部插件适配器认证失败"); }

function credentialPath(paths, backendId) {
  if (!BACKENDS.has(backendId) || typeof paths?.stateDir !== "string"
    || !path.isAbsolute(paths.stateDir) || typeof paths?.trustedRoot !== "string"
    || !path.isAbsolute(paths.trustedRoot)) fail();
  return path.join(paths.stateDir, `external-plugin-${backendId}.auth.json`);
}

function readCredential(paths, backendId) {
  let bytes;
  try { bytes = readPrivateFile(credentialPath(paths, backendId), { maxBytes: 256 }); }
  catch { fail(); }
  try {
    const record = JSON.parse(bytes.toString("utf8"));
    if (!record || Object.getPrototypeOf(record) !== Object.prototype
      || Object.keys(record).sort().join(",") !== "schemaVersion,token"
      || record.schemaVersion !== 1 || !validToken(record.token)) fail();
    return record.token;
  } catch { fail(); }
  finally { bytes.fill(0); }
}

function ensureCredential(paths, backendId, randomBytes = crypto.randomBytes) {
  const target = credentialPath(paths, backendId);
  ensurePrivateDirectoryTree(paths.stateDir, paths.trustedRoot);
  if (lstatIfExists(target)) return readCredential(paths, backendId);
  const bytes = randomBytes(32);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) {
    if (Buffer.isBuffer(bytes)) bytes.fill(0);
    fail();
  }
  let token;
  try { token = bytes.toString("base64url"); } finally { bytes.fill(0); }
  atomicWritePrivateFile(target, `${JSON.stringify({ schemaVersion: 1, token })}\n`, {
    trustedRoot: paths.trustedRoot,
  });
  return readCredential(paths, backendId);
}

function authorizeAdapter(paths, backendId, candidate) {
  if (!BACKENDS.has(backendId) || !validToken(candidate)) return false;
  let expected;
  try { expected = readCredential(paths, backendId); } catch { return false; }
  const left = Buffer.from(candidate, "utf8");
  const right = Buffer.from(expected, "utf8");
  try { return crypto.timingSafeEqual(left, right); }
  finally { left.fill(0); right.fill(0); expected = null; }
}

module.exports = { credentialPath, readCredential, ensureCredential, authorizeAdapter };
