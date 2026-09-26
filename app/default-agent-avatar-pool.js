"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomInt, randomUUID } = require("node:crypto");
const { ensureAssetDirectory, resolveDesktopAssetFile, validAssetName } = require("./desktop-assets");
const manifest = require("./assets/agent-avatars/manifest.json");

const LIBRARY_DIR = path.join(__dirname, "assets", "agent-avatars", "library");
const SELECTIONS_FILE = ".default-selections.json";
const MAX_SELECTIONS_BYTES = 4 * 1024 * 1024;

// Group byte-identical source files so two Agents cannot display the same image
// while any distinct image is still available. Both copies remain in the App.
const groupsByHash = new Map();
const filesByName = new Map();
for (const entry of manifest.entries) {
  const file = resolveDesktopAssetFile(LIBRARY_DIR, entry.file);
  if (!file || path.extname(file).toLowerCase() !== ".jpg") continue;
  filesByName.set(entry.file, { path: file, sha256: entry.sha256 });
  if (!groupsByHash.has(entry.sha256)) groupsByHash.set(entry.sha256, []);
  groupsByHash.get(entry.sha256).push(entry.file);
}
const groups = [...groupsByHash].map(([sha256, files]) => ({ sha256, files }));

function createDefaultAgentAvatarPool(assetPaths, { choose = randomInt, warn = console.warn, hasCustomAvatar = () => false } = {}) {
  const selectionsPath = path.join(assetPaths.avatarDir, SELECTIONS_FILE);
  let selections;

  function load() {
    if (selections) return;
    selections = new Map();
    try {
      const directory = fs.lstatSync(assetPaths.avatarDir);
      if (!directory.isDirectory()) throw new Error("avatar directory is not a regular directory");
      const stat = fs.lstatSync(selectionsPath);
      if (!stat.isFile() || stat.size > MAX_SELECTIONS_BYTES) throw new Error("invalid avatar selections file");
      const saved = JSON.parse(fs.readFileSync(selectionsPath, "utf8"));
      if (saved.version !== 1 || !saved.assignments || typeof saved.assignments !== "object"
        || Array.isArray(saved.assignments)) throw new Error("invalid avatar selections format");
      for (const [agentId, file] of Object.entries(saved.assignments)) {
        if (validAssetName(agentId) && filesByName.has(file) && !hasCustomAvatar(agentId)) {
          selections.set(agentId, file);
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") warn(`[default-avatar] Could not read selections: ${error.message}`);
    }
  }

  function save() {
    const temporary = path.join(assetPaths.avatarDir, `.default-selections-${randomUUID()}.tmp`);
    let safeDirectory = false;
    try {
      ensureAssetDirectory(assetPaths.avatarDir);
      safeDirectory = true;
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, assignments: Object.fromEntries(selections) }), {
        flag: "wx", mode: 0o600,
      });
      fs.renameSync(temporary, selectionsPath);
    } catch (error) {
      warn(`[default-avatar] Could not save selections: ${error.message}`);
    } finally {
      if (safeDirectory) {
        try { fs.rmSync(temporary, { force: true }); } catch { /* warning already emitted */ }
      }
    }
  }

  function release(agentId) {
    if (!validAssetName(agentId)) return;
    load();
    if (selections.delete(agentId)) save();
  }

  function move(fromId, toId) {
    if (!validAssetName(fromId) || !validAssetName(toId) || fromId === toId) return;
    load();
    const file = selections.get(fromId);
    if (!file) return;
    selections.delete(fromId);
    if (!hasCustomAvatar(toId) && !selections.has(toId)) selections.set(toId, file);
    save();
  }

  function select(agentId) {
    if (!validAssetName(agentId)) return null;
    load();
    if (hasCustomAvatar(agentId)) {
      release(agentId);
      return null;
    }
    const existing = selections.get(agentId);
    if (existing) return filesByName.get(existing).path;

    // A custom image added outside the upload route also frees its old slot.
    for (const id of selections.keys()) {
      if (hasCustomAvatar(id)) selections.delete(id);
    }
    const used = new Set([...selections.values()].map((file) => filesByName.get(file).sha256));
    const remaining = groups.filter((group) => !used.has(group.sha256));
    const choices = remaining.length ? remaining : groups;
    if (!choices.length) return null;
    const group = choices[choose(choices.length)];
    const file = group.files[choose(group.files.length)];
    selections.set(agentId, file);
    save();
    return filesByName.get(file).path;
  }

  return { select, release, move };
}

module.exports = { createDefaultAgentAvatarPool };
