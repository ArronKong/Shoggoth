"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");
const { lstatIfExists } = require("./security");
const { createNativeRuntimeImportAdapter } = require("./native-runtime-import-policy");

const IMPORTED_USER_SOURCE_MARKER = ".shoggoth-imported-user-source-v1.json";
const USER_SOURCE_FILES = Object.freeze(["CLAUDE.md", "settings.json", "settings.local.json"]);
const USER_AUTHORITY_ENTRIES = Object.freeze(["agents", "commands", "hooks", "plugins"]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function validMarker(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).join(",") === "schemaVersion,files"
    && value.schemaVersion === 1 && value.files && typeof value.files === "object"
    && !Array.isArray(value.files)
    && Object.keys(value.files).every((name) => USER_SOURCE_FILES.includes(name)
      && /^[a-f0-9]{64}$/u.test(value.files[name]));
}

function trustedImportedSettingSources(home) {
  try {
    if (USER_AUTHORITY_ENTRIES.some((name) => lstatIfExists(path.join(home, name)))) return [];
    const marker = JSON.parse(readPrivateFile(path.join(home, IMPORTED_USER_SOURCE_MARKER), {
      maxBytes: 4096,
    }).toString("utf8"));
    if (!validMarker(marker)) return [];
    for (const name of USER_SOURCE_FILES) {
      const target = path.join(home, name);
      if (!Object.hasOwn(marker.files, name)) {
        if (lstatIfExists(target)) return [];
        continue;
      }
      if (sha256(readPrivateFile(target, { maxBytes: 4 * 1024 * 1024 })) !== marker.files[name]) {
        return [];
      }
    }
    return ["user"];
  } catch {
    return [];
  }
}

function writeImportedUserSourceMarker({ targetRoot, plan, trustedRoot }) {
  const files = {};
  for (const name of USER_SOURCE_FILES) {
    const entry = plan.entries.find((candidate) => (
      candidate.kind === "active" && candidate.destination === name
    ));
    const target = path.join(targetRoot, name);
    if (!entry) {
      if (lstatIfExists(target)) return false;
      continue;
    }
    let bytes;
    try { bytes = readPrivateFile(target, { maxBytes: 4 * 1024 * 1024 }); }
    catch { return false; }
    if (sha256(bytes) !== entry.sha256) return false;
    files[name] = entry.sha256;
  }
  if (USER_AUTHORITY_ENTRIES.some((name) => lstatIfExists(path.join(targetRoot, name)))) return false;
  atomicWritePrivateFile(
    path.join(targetRoot, IMPORTED_USER_SOURCE_MARKER),
    `${JSON.stringify({ schemaVersion: 1, files })}\n`,
    { trustedRoot },
  );
  return true;
}

const adapter = createNativeRuntimeImportAdapter({
  runtime: "claude-code",
  sourceSegments: [".claude"],
  targetRoot: (paths, runtimeProfileId) => path.join(paths.stateDir, "claude-code", runtimeProfileId),
  active: ["CLAUDE.md", "settings.json", "settings.local.json"],
  pending: ["plugins", "commands", "agents", "hooks"],
  skills: ["skills"],
});

module.exports = Object.freeze({
  ...adapter,
  IMPORTED_USER_SOURCE_MARKER,
  trustedImportedSettingSources,
  writeImportedUserSourceMarker,
});
