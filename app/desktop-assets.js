"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { resolveServicePaths } = require("./agent-service/paths");

const AVATAR_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"];
const BG_STATES = new Set(["offline", "starting", "idle", "waiting", "thinking", "tool", "responding", "error"]);
const BG_VIDEO_EXTS = new Set([".mp4", ".webm"]);
const BG_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function resolveDesktopAssetPaths({ homeDir = os.homedir(), userDataRoot } = {}) {
  const root = resolveServicePaths({ homeDir, userDataRoot }).userDataRoot;
  // These are Shoggoth UI assets. The backend directory is a read-only legacy source.
  const legacyRoot = path.join(path.resolve(homeDir), ".openclaw", "desktop");
  return Object.freeze({
    avatarDir: path.join(root, "agent-avatars"),
    immersiveBgDir: path.join(root, "immersive-bg"),
    legacyAvatarDir: path.join(legacyRoot, "agent-avatars"),
    legacyImmersiveBgDir: path.join(legacyRoot, "immersive-bg"),
  });
}

function validAssetName(name) {
  return typeof name === "string" && name.length > 0
    && !name.includes("/") && !name.includes("\\") && !name.includes("..") && !name.includes("\0");
}

// Neither serving nor migration follows asset symlinks outside the selected directory.
function resolveDesktopAssetFile(directory, name) {
  if (!validAssetName(name)) return null;
  try {
    if (!fs.lstatSync(directory).isDirectory()) return null;
    const file = path.join(directory, name);
    return fs.lstatSync(file).isFile() ? file : null;
  } catch { return null; }
}

function avatarKey(name) {
  const ext = path.extname(name);
  const id = name.slice(0, -ext.length);
  return AVATAR_EXTS.includes(ext.toLowerCase()) && validAssetName(id) ? id : null;
}

function backgroundKey(name) {
  const ext = path.extname(name).toLowerCase();
  const state = path.basename(name, path.extname(name)).toLowerCase();
  return validAssetName(name) && BG_STATES.has(state)
    && (BG_VIDEO_EXTS.has(ext) || BG_IMAGE_EXTS.has(ext)) ? state : null;
}

function ensureAssetDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.lstatSync(directory).isDirectory()) throw new Error("asset directory must not be a symlink");
}

/** Copy legacy assets without deleting originals or overwriting any current asset.
 * A whole agent/state in the new directory wins, even across different extensions.
 * Each file is published atomically; an interrupted copy cannot become a valid asset.
 */
function migrateLegacyDesktopAssets(paths, { warn = console.warn } = {}) {
  const result = { copied: 0, skipped: 0, errors: 0 };
  for (const [source, destination, keyForName] of [
    [paths.legacyAvatarDir, paths.avatarDir, avatarKey],
    [paths.legacyImmersiveBgDir, paths.immersiveBgDir, backgroundKey],
  ]) {
    try {
      let names;
      try {
        if (!fs.lstatSync(source).isDirectory()) continue;
        names = fs.readdirSync(source).filter(name => keyForName(name) && resolveDesktopAssetFile(source, name));
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      if (!names.length) continue;
      // Publish the currently visible variant first. A later failed copy must
      // not switch an agent/state to a lower-priority historical image.
      names.sort((a, b) => keyForName === avatarKey
        ? AVATAR_EXTS.indexOf(path.extname(a).toLowerCase()) - AVATAR_EXTS.indexOf(path.extname(b).toLowerCase())
        : fs.statSync(path.join(source, b)).mtimeMs - fs.statSync(path.join(source, a)).mtimeMs);
      ensureAssetDirectory(destination);
      const existing = new Set(fs.readdirSync(destination).map(keyForName).filter(Boolean));
      for (const name of names) {
        if (existing.has(keyForName(name))) { result.skipped += 1; continue; }
        const temporary = path.join(destination, `.migrating-${randomUUID()}.tmp`);
        try {
          const input = resolveDesktopAssetFile(source, name);
          if (!input) continue;
          const stat = fs.statSync(input);
          fs.copyFileSync(input, temporary, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
          fs.utimesSync(temporary, stat.atime, stat.mtime);
          // link is exclusive, unlike rename, and the temporary lives on the same volume.
          fs.linkSync(temporary, path.join(destination, name));
          result.copied += 1;
        } catch (error) {
          if (error.code === "EEXIST") result.skipped += 1;
          else {
            result.errors += 1;
            existing.add(keyForName(name));
            warn(`[desktop-assets] Could not migrate ${name}: ${error.message}`);
          }
        } finally { fs.rmSync(temporary, { force: true }); }
      }
    } catch (error) {
      result.errors += 1;
      warn(`[desktop-assets] Could not migrate ${source}: ${error.message}`);
    }
  }
  return result;
}

module.exports = {
  AVATAR_EXTS, BG_STATES, BG_VIDEO_EXTS, BG_IMAGE_EXTS,
  resolveDesktopAssetPaths, resolveDesktopAssetFile, validAssetName,
  ensureAssetDirectory, migrateLegacyDesktopAssets,
};
