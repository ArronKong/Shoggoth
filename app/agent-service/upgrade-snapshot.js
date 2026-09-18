"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  atomicWritePrivateFile,
  readPrivateFile,
  statIfExists,
} = require("./private-file");
const {
  createAuthorityBackup,
  verifyAuthorityBackup,
} = require("./authority-backup");
const { serviceError } = require("./security");

const UPGRADE_SNAPSHOT_VERSION = 2;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const LEGACY_COMPONENTS_V1 = Object.freeze([
  "product", "definition", "memory", "transcript", "toolPolicy", "skill", "browser", "runtimeHome",
]);
const COMPONENTS = Object.freeze([
  "product", "definition", "memory", "transcript", "toolPolicy", "skill", "browser", "computer",
  "runtimeHome",
]);

function upgradeError(code, message) { return serviceError(code, message); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function componentFor(relativePath) {
  if (relativePath === "state.snapshot.json" || relativePath === "events.jsonl"
    || relativePath === "chat-sessions.json" || relativePath === "runtime-switch.json"
    || relativePath.startsWith("kanban/")
    || relativePath.startsWith("cron/")) return "product";
  if (/^agents\/[^/]+\/(?:manifest\.json|definition\/|generated\/|proposals\/)/u.test(relativePath)) return "definition";
  if (/^agents\/[^/]+\/memory\//u.test(relativePath)) return "memory";
  if (/^agents\/[^/]+\/transcripts\//u.test(relativePath)) return "transcript";
  if (relativePath === "tool-permissions.json") return "toolPolicy";
  if (relativePath.startsWith("skills/") || /^agents\/[^/]+\/skills\//u.test(relativePath)) return "skill";
  if (relativePath.startsWith("browser/")) return "browser";
  if (relativePath.startsWith("computer/")) return "computer";
  // Keep this legacy grouping stable: existing v1/v2 generation manifests are
  // verified by rebuilding these component digests. New account-scoped files
  // remain covered by the authority backup root digest even when they do not
  // belong to this historical diagnostic bucket.
  if (relativePath.startsWith("codex/") || relativePath.startsWith("antigravity/")
    || relativePath.startsWith("pi/")
    || relativePath.startsWith("claude-code/")
    || relativePath.startsWith("deepseek-harness/")
    || relativePath.startsWith("runtime-ledgers/antigravity/")
    || relativePath.startsWith("runtime-ledgers/pi/")
    || relativePath.startsWith("runtime-ledgers/claude-code/")
    || relativePath.startsWith("runtime-ledgers/deepseek-harness/")) {
    return "runtimeHome";
  }
  return null;
}
function buildComponents(authorityManifest, componentNames = COMPONENTS) {
  const grouped = Object.fromEntries(componentNames.map((name) => [name, []]));
  for (const entry of authorityManifest.entries) {
    if (entry.type !== "file") continue;
    const name = componentFor(entry.path);
    if (name && grouped[name]) grouped[name].push({
      path: entry.path, size: entry.size, sha256: entry.sha256,
    });
  }
  return Object.fromEntries(componentNames.map((name) => {
    const files = grouped[name].sort((left, right) => left.path.localeCompare(right.path));
    return [name, {
      present: files.length > 0,
      files,
      digest: sha256(stable(files)),
    }];
  }));
}
function manifestBody(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    generationId: manifest.generationId,
    backupId: manifest.backupId,
    createdAt: manifest.createdAt,
    authorityRootDigest: manifest.authorityRootDigest,
    components: manifest.components,
  };
}
function validateManifest(value, expected, authorityManifest) {
  const componentNames = value?.schemaVersion === 1 ? LEGACY_COMPONENTS_V1 : COMPONENTS;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).join(",") !== "schemaVersion,generationId,backupId,createdAt,authorityRootDigest,components,checksum"
    || ![1, UPGRADE_SNAPSHOT_VERSION].includes(value.schemaVersion)
    || value.generationId !== expected.generationId || value.backupId !== expected.backupId
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
    || value.authorityRootDigest !== authorityManifest.rootDigest
    || !value.components || typeof value.components !== "object" || Array.isArray(value.components)
    || Object.keys(value.components).join(",") !== componentNames.join(",")
    || !HASH_PATTERN.test(value.checksum)
    || value.checksum !== sha256(stable(manifestBody(value)))) {
    throw upgradeError("UPGRADE_SNAPSHOT_CORRUPT", "升级快照 generation manifest 无效");
  }
  const expectedComponents = buildComponents(authorityManifest, componentNames);
  if (stable(value.components) !== stable(expectedComponents)) {
    throw upgradeError("UPGRADE_SNAPSHOT_CORRUPT", "升级快照组件与 authority payload 不一致");
  }
  return structuredClone(value);
}
function ids(generationId) {
  if (typeof generationId !== "string" || !ID_PATTERN.test(generationId)) {
    throw upgradeError("UPGRADE_GENERATION_INVALID", "升级 generationId 无效");
  }
  return { generationId, backupId: `upgrade-${generationId}` };
}
function generationPath(backupPath) { return path.join(backupPath, "generation.json"); }

function verifyUpgradeSnapshot({ paths, generationId }) {
  const identity = ids(generationId);
  const verified = verifyAuthorityBackup({ paths, backupId: identity.backupId });
  const target = generationPath(verified.backupPath);
  const stat = statIfExists(fs, target);
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.size > MAX_MANIFEST_BYTES) {
    throw upgradeError("UPGRADE_SNAPSHOT_INCOMPLETE", "升级快照 generation manifest 缺失");
  }
  let parsed;
  try {
    parsed = JSON.parse(readPrivateFile(target, { maxBytes: MAX_MANIFEST_BYTES }).toString("utf8"));
  } catch (error) {
    if (error?.code === "UPGRADE_SNAPSHOT_INCOMPLETE") throw error;
    throw upgradeError("UPGRADE_SNAPSHOT_CORRUPT", "升级快照 generation manifest 无法读取");
  }
  const manifest = validateManifest(parsed, identity, verified.manifest);
  return Object.freeze({ backupPath: verified.backupPath, manifest });
}

function createUpgradeSnapshot(options = {}) {
  const identity = ids(options.generationId);
  let authority;
  try {
    authority = createAuthorityBackup({
      paths: options.paths,
      backupId: identity.backupId,
      now: options.now,
      activeServiceLock: options.activeServiceLock || null,
    });
  } catch (error) {
    if (error?.code !== "BACKUP_ALREADY_EXISTS") throw error;
    authority = verifyAuthorityBackup({ paths: options.paths, backupId: identity.backupId });
  }
  options.checkpoint?.("authority-committed");
  const target = generationPath(authority.backupPath);
  if (!statIfExists(fs, target)) {
    const manifest = {
      schemaVersion: UPGRADE_SNAPSHOT_VERSION,
      generationId: identity.generationId,
      backupId: identity.backupId,
      createdAt: authority.manifest.createdAt,
      authorityRootDigest: authority.manifest.rootDigest,
      components: buildComponents(authority.manifest),
    };
    manifest.checksum = sha256(stable(manifestBody(manifest)));
    options.checkpoint?.("before-generation-commit");
    atomicWritePrivateFile(target, `${JSON.stringify(manifest)}\n`, {
      trustedRoot: options.paths.trustedRoot,
    });
  }
  options.checkpoint?.("generation-committed");
  return verifyUpgradeSnapshot({ paths: options.paths, generationId: identity.generationId });
}

module.exports = {
  COMPONENTS,
  LEGACY_COMPONENTS_V1,
  UPGRADE_SNAPSHOT_VERSION,
  createUpgradeSnapshot,
  verifyUpgradeSnapshot,
};
