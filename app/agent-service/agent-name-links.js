"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { assertPrivateDirectory, serviceError } = require("./security");

const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const LINKS_DIRECTORY = "agents-by-name";
const filenameKey = (name) => name.normalize("NFKC").toLocaleLowerCase("und");

function contains(root, target) {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function folderName(displayName) {
  const cleaned = displayName.normalize("NFKC")
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, "-").trim().replace(/^[. ]+|[. ]+$/gu, "");
  let result = "";
  let bytes = 0;
  for (const character of cleaned) {
    bytes += Buffer.byteLength(character.normalize("NFD"));
    if (bytes > 180) break;
    result += character;
  }
  return result.replace(/[. ]+$/u, "") || "Agent";
}

function suffixedName(entry, used, bases) {
  const stem = `${entry.base}--${entry.id.slice(0, 8).replaceAll(":", "-")}`;
  let name = stem;
  for (let index = 2; used.has(filenameKey(name)) || bases.has(filenameKey(name)); index++) {
    name = `${stem}-${index}`;
  }
  return name;
}

function describeAgentDirectory(paths, profile) {
  if (typeof paths?.agentsDir !== "string" || !path.isAbsolute(paths.agentsDir)
    || typeof profile?.id !== "string" || !PROFILE_ID.test(profile.id)) return undefined;
  const agentDir = path.join(paths.agentsDir, profile.id);
  const fallback = { path: agentDir, exists: false };
  try {
    fallback.exists = fs.lstatSync(agentDir, { throwIfNoEntry: false })?.isDirectory() === true;
    if (!fallback.exists || !paths.userDataRoot) return fallback;
    const directory = path.join(paths.userDataRoot, LINKS_DIRECTORY);
    if (!fs.lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) return fallback;
    const target = path.relative(directory, agentDir);
    const matches = (name) => {
      try { return fs.readlinkSync(path.join(directory, name)) === target; }
      catch { return false; }
    };
    // A collision can give this profile a suffixed name on disk.
    const preferred = typeof profile.name === "string" ? folderName(profile.name) : "";
    const name = preferred && matches(preferred) ? preferred
      : fs.readdirSync(directory, { withFileTypes: true }).find(item => item.isSymbolicLink() && matches(item.name))?.name;
    if (name) return { path: path.join(directory, name), exists: true };
  } catch { /* A link can disappear while the Service refreshes the names. */ }
  return fallback;
}

// Finder links are derived from the roster. Keep them outside the Service
// state tree so its readers and backups only encounter the real ID directories.
function syncAgentNameLinks(paths, profiles) {
  const directory = path.join(paths.userDataRoot, LINKS_DIRECTORY);
  if (!contains(paths.trustedRoot, directory) || contains(paths.stateDir, directory)
    || fs.realpathSync(paths.userDataRoot) !== paths.userDataRoot
    || fs.realpathSync(paths.agentsDir) !== paths.agentsDir) {
    throw serviceError("UNSAFE_PATH", "Agent folder links require a canonical path outside the Service state");
  }
  assertPrivateDirectory(paths.agentsDir);
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  assertPrivateDirectory(directory);

  const prefix = path.relative(directory, paths.agentsDir) + path.sep;
  const existing = new Map();
  const used = new Set();
  // Other entries still reserve their filenames. Only relative links to the
  // real Agent ID directories belong to this generated view.
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = item.isSymbolicLink() ? fs.readlinkSync(path.join(directory, item.name)) : "";
    if (target.startsWith(prefix) && PROFILE_ID.test(target.slice(prefix.length))) {
      existing.set(item.name, target);
    } else {
      used.add(filenameKey(item.name));
    }
  }

  const entries = [];
  const bases = new Map();
  for (const profile of profiles) {
    if (typeof profile.id !== "string" || !PROFILE_ID.test(profile.id)
      || !fs.lstatSync(path.join(paths.agentsDir, profile.id), { throwIfNoEntry: false })?.isDirectory()) continue;
    const base = folderName(profile.name);
    const key = filenameKey(base);
    entries.push({ id: profile.id, base, key, target: prefix + profile.id });
    bases.set(key, (bases.get(key) || 0) + 1);
  }
  entries.sort((left, right) => left.id.localeCompare(right.id, "en"));

  const wanted = new Map();
  for (const entry of entries) {
    const name = bases.get(entry.key) === 1 && !used.has(entry.key)
      ? entry.base : suffixedName(entry, used, bases);
    wanted.set(name, entry);
    used.add(filenameKey(name));
  }
  const kept = new Set();
  for (const [name, target] of existing) {
    const canonical = name.normalize("NFC");
    if (wanted.get(canonical)?.target === target) kept.add(canonical);
    else fs.unlinkSync(path.join(directory, name));
  }
  for (const [name, entry] of wanted) {
    if (kept.has(name)) continue;
    let candidate = name;
    for (;;) {
      try {
        fs.symlinkSync(entry.target, path.join(directory, candidate), "dir");
        used.add(filenameKey(candidate));
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        used.add(filenameKey(candidate));
        candidate = suffixedName(entry, used, bases);
      }
    }
  }
  return directory;
}

module.exports = { describeAgentDirectory, syncAgentNameLinks };
