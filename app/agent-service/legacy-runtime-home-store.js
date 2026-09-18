"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");
const {
  RUNTIME_ACCOUNT_RUNTIMES,
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
  validateRuntimeAccount,
} = require("./runtime-account");
const {
  LEGACY_DEFAULT_SHOGGOTH_RUNTIME_PROFILE_ID,
  resolveNativeHome,
} = require("./runtime-account-resolver");
const { ensurePrivateDirectoryTree, lstatIfExists, serviceError } = require("./security");
const {
  inspectRuntimeStorage,
  isContained,
  validateCanonicalOwnedDirectory,
} = require("./runtime-storage-inspector");

const LEGACY_RUNTIME_HOME_MANIFEST_VERSION = 1;
const RUNTIME_PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const V7_MANAGED_ACCOUNT_ID_PATTERN = /^legacy-managed-[a-f0-9]{64}-v1$/u;
const ENTRY_ID_PATTERN = /^legacy-home-[a-f0-9]{64}-v1$/u;
const KNOWN_RUNTIME_SET = new Set(RUNTIME_ACCOUNT_RUNTIMES);
const MANIFEST_FIELDS = Object.freeze([
  "schemaVersion",
  "generation",
  "generatedAt",
  "stateRootDigest",
  "entries",
]);
const ENTRY_FIELDS = Object.freeze([
  "id",
  "runtime",
  "runtimeProfileId",
  "runtimeAccountId",
  "accountKind",
  "profileIds",
  "role",
  "path",
  "lastModifiedAt",
  "stats",
]);
const STATS_FIELDS = Object.freeze([
  "bytes",
  "files",
  "dirs",
  "symlinks",
  "entries",
  "incomplete",
  "limitReason",
  "identity",
]);
const IDENTITY_FIELDS = Object.freeze(["path", "dev", "ino", "uid", "mtimeMs"]);

function manifestError(code, message) {
  return serviceError(code, message);
}

function exactData(record, fields, code, label) {
  let descriptors;
  let keys;
  try {
    if (!record || typeof record !== "object" || Array.isArray(record)
      || Object.getPrototypeOf(record) !== Object.prototype) {
      throw manifestError(code, `${label} 必须是 plain object`);
    }
    descriptors = Object.getOwnPropertyDescriptors(record);
    keys = Reflect.ownKeys(record);
  } catch (error) {
    if (error?.code === code) throw error;
    throw manifestError(code, `${label} 无法安全读取`);
  }
  if (keys.length !== fields.length
    || keys.some((key) => typeof key !== "string" || !fields.includes(key))) {
    throw manifestError(code, `${label} 字段无效`);
  }
  for (const field of fields) {
    if (!descriptors[field]?.enumerable
      || !Object.prototype.hasOwnProperty.call(descriptors[field], "value")) {
      throw manifestError(code, `${label}.${field} 必须是 data property`);
    }
  }
  return Object.fromEntries(fields.map((field) => [field, descriptors[field].value]));
}

function profileField(profile, field) {
  let descriptor;
  try {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)
      || Object.getPrototypeOf(profile) !== Object.prototype) {
      throw manifestError("LEGACY_RUNTIME_PROFILE_INVALID", "AgentProfile 必须是 plain object");
    }
    descriptor = Object.getOwnPropertyDescriptor(profile, field);
  } catch (error) {
    if (error?.code === "LEGACY_RUNTIME_PROFILE_INVALID") throw error;
    throw manifestError("LEGACY_RUNTIME_PROFILE_INVALID", "AgentProfile 无法安全读取");
  }
  if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
    throw manifestError("LEGACY_RUNTIME_PROFILE_INVALID", `AgentProfile.${field} 无效`);
  }
  return descriptor.value;
}

function legacyHomeId(runtime, runtimeProfileId, runtimeAccountId) {
  const digest = crypto.createHash("sha256")
    .update("shoggoth-legacy-runtime-home-v1\0", "utf8")
    .update(JSON.stringify([runtime, runtimeProfileId, runtimeAccountId]), "utf8")
    .digest("hex");
  return `legacy-home-${digest}-v1`;
}

function v7ManagedAccountId(profileId, runtime) {
  const digest = crypto.createHash("sha256")
    .update("shoggoth-runtime-account-legacy-profile-v1\0", "utf8")
    .update(JSON.stringify([profileId, runtime]), "utf8")
    .digest("hex");
  return `legacy-managed-${digest}-v1`;
}

function legacyHomePathMatches(entry, stateDir) {
  if (typeof entry?.path !== "string" || !path.isAbsolute(entry.path)) return false;
  const resolvedStateDir = path.resolve(stateDir);
  const resolvedTarget = path.resolve(entry.path);
  const relative = path.relative(resolvedStateDir, resolvedTarget);
  if (resolvedTarget !== entry.path || relative === "" || path.isAbsolute(relative)
    || relative === ".." || relative.startsWith(`..${path.sep}`)) return false;
  const segments = relative.split(path.sep);
  const profileHome = segments.length === 2
    && segments[0] === entry.runtime
    && segments[1] === entry.runtimeProfileId;
  const v7AccountHome = entry.runtime === "codex"
    && entry.accountKind === "shoggoth-managed"
    && entry.runtimeProfileId !== entry.runtimeAccountId
    && V7_MANAGED_ACCOUNT_ID_PATTERN.test(entry.runtimeProfileId)
    && Array.isArray(entry.profileIds)
    && entry.profileIds.some((profileId) => (
      typeof profileId === "string"
        && v7ManagedAccountId(profileId, entry.runtime) === entry.runtimeProfileId
    ))
    && segments.length === 4
    && segments[0] === "runtime-accounts"
    && segments[1] === "codex"
    && segments[2] === entry.runtimeProfileId
    && segments[3] === "home";
  return profileHome || v7AccountHome;
}

function digestStateRoot(stateDir) {
  return crypto.createHash("sha256")
    .update("shoggoth-legacy-runtime-state-root-v1\0", "utf8")
    .update(stateDir, "utf8")
    .digest("hex");
}

function cloneManifest(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalPathsOverlap(left, right) {
  return isContained(left, right) || isContained(right, left);
}

function frozenManifest(value) {
  const copy = cloneManifest(value);
  for (const entry of copy.entries) {
    Object.freeze(entry.profileIds);
    Object.freeze(entry.stats.identity);
    Object.freeze(entry.stats);
    Object.freeze(entry);
  }
  Object.freeze(copy.entries);
  return Object.freeze(copy);
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateManifest(manifest, stateDir) {
  const value = exactData(
    manifest,
    MANIFEST_FIELDS,
    "LEGACY_RUNTIME_HOME_MANIFEST_CORRUPT",
    "legacy runtime home manifest",
  );
  if (value.schemaVersion !== LEGACY_RUNTIME_HOME_MANIFEST_VERSION
    || !safeInteger(value.generation) || value.generation < 1
    || !safeInteger(value.generatedAt)
    || value.stateRootDigest !== digestStateRoot(stateDir)
    || !Array.isArray(value.entries)) {
    throw manifestError(
      "LEGACY_RUNTIME_HOME_MANIFEST_CORRUPT",
      "legacy runtime home manifest metadata 无效",
    );
  }
  const ids = new Set();
  const canonicalByAccount = new Map();
  for (const rawEntry of value.entries) {
    const entry = exactData(
      rawEntry,
      ENTRY_FIELDS,
      "LEGACY_RUNTIME_HOME_MANIFEST_CORRUPT",
      "legacy runtime home entry",
    );
    const stats = exactData(
      entry.stats,
      STATS_FIELDS,
      "LEGACY_RUNTIME_HOME_MANIFEST_CORRUPT",
      "legacy runtime home stats",
    );
    const identity = exactData(
      stats.identity,
      IDENTITY_FIELDS,
      "LEGACY_RUNTIME_HOME_MANIFEST_CORRUPT",
      "legacy runtime home identity",
    );
    const resolvedPath = typeof entry.path === "string" && path.isAbsolute(entry.path)
      ? path.resolve(entry.path)
      : null;
    if (!ENTRY_ID_PATTERN.test(entry.id) || ids.has(entry.id)
      || !KNOWN_RUNTIME_SET.has(entry.runtime)
      || !RUNTIME_PROFILE_ID_PATTERN.test(entry.runtimeProfileId)
      || typeof entry.runtimeAccountId !== "string" || entry.runtimeAccountId.length === 0
      || !["native-user", "shoggoth-managed"].includes(entry.accountKind)
      || !Array.isArray(entry.profileIds) || entry.profileIds.length === 0
      || entry.profileIds.some((id) => typeof id !== "string" || id.length === 0)
      || new Set(entry.profileIds).size !== entry.profileIds.length
      || !["canonical", "reclaimable"].includes(entry.role)
      || resolvedPath !== entry.path || !isContained(stateDir, resolvedPath)
      || !legacyHomePathMatches(entry, stateDir)
      || entry.id !== legacyHomeId(entry.runtime, entry.runtimeProfileId, entry.runtimeAccountId)
      || !safeInteger(entry.lastModifiedAt)
      || !safeInteger(stats.bytes) || !safeInteger(stats.files) || !safeInteger(stats.dirs)
      || !safeInteger(stats.symlinks) || !safeInteger(stats.entries)
      || typeof stats.incomplete !== "boolean"
      || (stats.limitReason !== null
        && !["bytes", "depth", "duration", "entries"].includes(stats.limitReason))
      || stats.incomplete !== (stats.limitReason !== null)
      || stats.entries !== stats.files + stats.dirs + stats.symlinks
      || typeof identity.path !== "string" || identity.path !== entry.path
      || !Number.isFinite(identity.dev) || !Number.isFinite(identity.ino)
      || !Number.isFinite(identity.uid) || !Number.isFinite(identity.mtimeMs)) {
      throw manifestError(
        "LEGACY_RUNTIME_HOME_MANIFEST_CORRUPT",
        "legacy runtime home entry 内容无效",
      );
    }
    if (entry.accountKind === "native-user" && entry.role !== "reclaimable") {
      throw manifestError(
        "LEGACY_RUNTIME_HOME_MANIFEST_CORRUPT",
        "native RuntimeAccount legacy Home 不能是 canonical",
      );
    }
    if (entry.role === "canonical") {
      const count = (canonicalByAccount.get(entry.runtimeAccountId) || 0) + 1;
      if (count > 1) {
        throw manifestError(
          "LEGACY_RUNTIME_HOME_MANIFEST_CORRUPT",
          "managed RuntimeAccount 只能有一个 canonical legacy Home",
        );
      }
      canonicalByAccount.set(entry.runtimeAccountId, count);
    }
    ids.add(entry.id);
  }
  return frozenManifest(value);
}

function inspectProfile(profile, accounts) {
  const id = profileField(profile, "id");
  const runtime = profileField(profile, "runtime");
  const runtimeProfileId = profileField(profile, "runtimeProfileId");
  const runtimeAccountId = profileField(profile, "runtimeAccountId");
  const isDefault = profileField(profile, "isDefault");
  if (typeof id !== "string" || id.length === 0 || !KNOWN_RUNTIME_SET.has(runtime)
    || typeof runtimeProfileId !== "string"
    || !RUNTIME_PROFILE_ID_PATTERN.test(runtimeProfileId)
    || typeof runtimeAccountId !== "string" || !accounts.has(runtimeAccountId)
    || typeof isDefault !== "boolean") {
    throw manifestError("LEGACY_RUNTIME_PROFILE_INVALID", "AgentProfile runtime identity 无效");
  }
  const account = accounts.get(runtimeAccountId);
  if (account.runtime !== runtime) {
    throw manifestError(
      "LEGACY_RUNTIME_PROFILE_INVALID",
      "AgentProfile 与 RuntimeAccount runtime 不匹配",
    );
  }
  return { id, runtime, runtimeProfileId, runtimeAccountId, isDefault, account };
}

function discoverLegacyRuntimeHomes(options = {}) {
  const { profiles, accounts, stateDir, trustedRoot } = options;
  const nativeHomePaths = options.nativeHomePaths || new Set();
  if (!Array.isArray(profiles) || !Array.isArray(accounts)) {
    throw manifestError(
      "LEGACY_RUNTIME_HOME_OPTIONS_INVALID",
      "legacy Home 发现必须接收显式 profiles 与 accounts",
    );
  }
  if (profiles.length > 10_000 || accounts.length > 10_000) {
    throw manifestError("LEGACY_RUNTIME_HOME_OPTIONS_INVALID", "legacy Home 发现输入超过容量限制");
  }
  if (!(nativeHomePaths instanceof Set)
    || [...nativeHomePaths].some((home) => typeof home !== "string"
      || !path.isAbsolute(home) || path.resolve(home) !== home)) {
    throw manifestError(
      "LEGACY_RUNTIME_HOME_OPTIONS_INVALID",
      "native RuntimeAccount Home 集合无效",
    );
  }
  const stateIdentity = validateCanonicalOwnedDirectory(stateDir, { trustedRoot });
  const accountMap = new Map();
  for (const rawAccount of accounts) {
    const account = validateRuntimeAccount(rawAccount);
    if (accountMap.has(account.id)) {
      throw manifestError("LEGACY_RUNTIME_ACCOUNT_DUPLICATE", "RuntimeAccount ID 重复");
    }
    accountMap.set(account.id, account);
  }

  const candidates = new Map();
  const inspectedProfiles = [];
  for (const rawProfile of profiles) {
    const runtime = profileField(rawProfile, "runtime");
    if (!KNOWN_RUNTIME_SET.has(runtime)) continue;
    const profile = inspectProfile(rawProfile, accountMap);
    inspectedProfiles.push(profile);
    const candidatePath = path.join(stateIdentity.path, profile.runtime, profile.runtimeProfileId);
    if (!isContained(stateIdentity.path, candidatePath)) {
      throw manifestError("LEGACY_RUNTIME_HOME_PATH_INVALID", "legacy Home 路径逃逸 stateDir");
    }
    const stat = lstatIfExists(candidatePath);
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw manifestError(
        "LEGACY_RUNTIME_HOME_PATH_UNSAFE",
        "legacy Home 必须是非 symlink 目录",
      );
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw manifestError("LEGACY_RUNTIME_HOME_PATH_UNSAFE", "legacy Home owner 无效");
    }
    const key = `${profile.runtime}\0${profile.runtimeProfileId}`;
    const existing = candidates.get(key);
    if (existing && existing.runtimeAccountId !== profile.runtimeAccountId) {
      throw manifestError(
        "LEGACY_RUNTIME_HOME_ACCOUNT_CONFLICT",
        "同一 legacy Home 被不同 RuntimeAccount 引用",
      );
    }
    if (existing) {
      existing.profileIds.add(profile.id);
      existing.hasDefault ||= profile.isDefault;
    } else {
      candidates.set(key, {
        runtime: profile.runtime,
        runtimeProfileId: profile.runtimeProfileId,
        runtimeAccountId: profile.runtimeAccountId,
        accountKind: profile.account.kind,
        profileIds: new Set([profile.id]),
        hasDefault: profile.isDefault,
        path: candidatePath,
      });
    }
  }

  // Schema v7 briefly gave each non-default managed Codex Profile its own
  // account-scoped Home. v8 rebinds those Profiles to their shared account;
  // derive the exact old ID from each current Profile instead of scanning the
  // runtime-accounts tree or trusting arbitrary directory names.
  for (const profile of inspectedProfiles) {
    if (profile.runtime !== "codex" || profile.isDefault
      || profile.account.kind !== "shoggoth-managed"
      || profile.runtimeAccountId !== SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID) continue;
    const legacyAccountId = v7ManagedAccountId(profile.id, profile.runtime);
    if (accountMap.has(legacyAccountId)) continue;
    const candidatePath = path.join(
      stateIdentity.path,
      "runtime-accounts",
      "codex",
      legacyAccountId,
      "home",
    );
    if (!isContained(stateIdentity.path, candidatePath)) {
      throw manifestError("LEGACY_RUNTIME_HOME_PATH_INVALID", "v7 managed Home 路径逃逸 stateDir");
    }
    const stat = lstatIfExists(candidatePath);
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isDirectory()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw manifestError("LEGACY_RUNTIME_HOME_PATH_UNSAFE", "v7 managed Home 不是安全目录");
    }
    candidates.set(`v7-account\0${legacyAccountId}`, {
      runtime: "codex",
      runtimeProfileId: legacyAccountId,
      runtimeAccountId: profile.runtimeAccountId,
      accountKind: "shoggoth-managed",
      profileIds: new Set([profile.id]),
      hasDefault: false,
      path: candidatePath,
    });
  }

  const canonicalPaths = new Set();
  for (const candidate of candidates.values()) {
    if (candidate.accountKind === "shoggoth-managed"
      && candidate.runtime === "codex"
      && candidate.runtimeAccountId === SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID
      && candidate.runtimeProfileId === LEGACY_DEFAULT_SHOGGOTH_RUNTIME_PROFILE_ID
      && candidate.hasDefault) {
      canonicalPaths.add(candidate.path);
    }
  }

  const canonicalNativeHomes = [...nativeHomePaths];
  const entries = [...candidates.values()]
    .filter((candidate) => !canonicalNativeHomes.some(
      (nativeHome) => canonicalPathsOverlap(candidate.path, nativeHome),
    ))
    .map((candidate) => {
      const stats = inspectRuntimeStorage(candidate.path, {
        ...options.scanLimits,
        trustedRoot: stateIdentity.path,
      });
      return {
        id: legacyHomeId(
          candidate.runtime,
          candidate.runtimeProfileId,
          candidate.runtimeAccountId,
        ),
        runtime: candidate.runtime,
        runtimeProfileId: candidate.runtimeProfileId,
        runtimeAccountId: candidate.runtimeAccountId,
        accountKind: candidate.accountKind,
        profileIds: [...candidate.profileIds].sort((left, right) => left.localeCompare(right, "en")),
        role: canonicalPaths.has(candidate.path) ? "canonical" : "reclaimable",
        path: candidate.path,
        lastModifiedAt: Math.max(0, Math.trunc(stats.identity.mtimeMs)),
        stats,
      };
    });
  entries.sort((left, right) => (
    left.runtime.localeCompare(right.runtime, "en")
      || left.runtimeAccountId.localeCompare(right.runtimeAccountId, "en")
      || left.runtimeProfileId.localeCompare(right.runtimeProfileId, "en")
  ));
  return entries;
}

class LegacyRuntimeHomeStore {
  constructor(options = {}) {
    if (!options.paths?.stateDir || !options.paths?.trustedRoot
      || !options.paths?.legacyRuntimeHomesPath) {
      throw manifestError(
        "LEGACY_RUNTIME_HOME_OPTIONS_INVALID",
        "LegacyRuntimeHomeStore paths 无效",
      );
    }
    this.paths = options.paths;
    this.now = options.now || Date.now;
    this.scanLimits = options.scanLimits || {};
    this.parentEnv = options.parentEnv || process.env;
    this.homedir = options.homedir || os.homedir;
    if (typeof this.now !== "function"
      || (!this.parentEnv || typeof this.parentEnv !== "object")
      || (typeof this.homedir !== "function" && typeof this.homedir !== "string")) {
      throw manifestError("LEGACY_RUNTIME_HOME_OPTIONS_INVALID", "LegacyRuntimeHomeStore options 无效");
    }
  }

  read() {
    if (!lstatIfExists(this.paths.legacyRuntimeHomesPath)) return null;
    let parsed;
    try {
      parsed = JSON.parse(readPrivateFile(this.paths.legacyRuntimeHomesPath, {
        maxBytes: 16 * 1024 * 1024,
      }).toString("utf8"));
    } catch (error) {
      if (String(error?.code || "").startsWith("UNSAFE_")) throw error;
      throw manifestError(
        "LEGACY_RUNTIME_HOME_MANIFEST_CORRUPT",
        "legacy runtime Home manifest 无法读取",
      );
    }
    return validateManifest(parsed, path.resolve(this.paths.stateDir));
  }

  refresh(input = {}) {
    const generatedAt = this.now();
    if (!safeInteger(generatedAt)) {
      throw manifestError("LEGACY_RUNTIME_HOME_OPTIONS_INVALID", "LegacyRuntimeHomeStore clock 返回值无效");
    }
    const stateIdentity = validateCanonicalOwnedDirectory(this.paths.stateDir, {
      trustedRoot: this.paths.trustedRoot,
    });
    if (!Array.isArray(input.accounts)) {
      throw manifestError(
        "LEGACY_RUNTIME_HOME_OPTIONS_INVALID",
        "legacy Home 发现必须接收显式 accounts",
      );
    }
    const userHome = typeof this.homedir === "function" ? this.homedir() : this.homedir;
    const nativeHomePaths = new Set();
    for (const rawAccount of input.accounts) {
      const account = validateRuntimeAccount(rawAccount);
      if (account.kind !== "native-user") continue;
      nativeHomePaths.add(resolveNativeHome(
        fs,
        this.parentEnv,
        userHome,
        account.runtime,
      ));
    }
    const current = this.read();
    const manifest = {
      schemaVersion: LEGACY_RUNTIME_HOME_MANIFEST_VERSION,
      generation: (current?.generation || 0) + 1,
      generatedAt,
      stateRootDigest: digestStateRoot(stateIdentity.path),
      entries: discoverLegacyRuntimeHomes({
        profiles: input.profiles,
        accounts: input.accounts,
        stateDir: stateIdentity.path,
        trustedRoot: this.paths.trustedRoot,
        nativeHomePaths,
        scanLimits: this.scanLimits,
      }),
    };
    const validated = validateManifest(manifest, stateIdentity.path);
    ensurePrivateDirectoryTree(path.dirname(this.paths.legacyRuntimeHomesPath), this.paths.trustedRoot);
    atomicWritePrivateFile(
      this.paths.legacyRuntimeHomesPath,
      `${JSON.stringify(validated)}\n`,
      { trustedRoot: this.paths.trustedRoot },
    );
    return validated;
  }
}

module.exports = {
  LEGACY_RUNTIME_HOME_MANIFEST_VERSION,
  LegacyRuntimeHomeStore,
  discoverLegacyRuntimeHomes,
  legacyHomeId,
  legacyHomePathMatches,
  validateLegacyRuntimeHomeManifest: validateManifest,
};
