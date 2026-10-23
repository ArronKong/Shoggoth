"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { AVATAR_EXTS, resolveDesktopAssetFile, resolveDesktopAssetPaths } = require("../desktop-assets");
const { ensurePrivateDirectoryTree } = require("./security");
const manifest = require("../assets/agent-avatars/builtin/manifest.json");

const BUNDLED_DIR = path.join(__dirname, "..", "assets", "agent-avatars", "builtin");

// Called only before an automatic Profile creation. Existing Profiles and
// ordinary agent.create requests never receive these reserved images.
function assignBuiltinAgentAvatar(profile, paths) {
  if (profile.backendId !== "shoggoth") return false;
  const entry = manifest.entries.find((item) => item.profileId === profile.id && item.agentId === profile.agentId);
  if (!entry) return false;
  const assets = resolveDesktopAssetPaths({ homeDir: paths.homeDir, userDataRoot: paths.userDataRoot });
  for (const directory of [assets.avatarDir, assets.legacyAvatarDir]) {
    if (AVATAR_EXTS.some((extension) => resolveDesktopAssetFile(directory, profile.agentId + extension))) return false;
  }

  ensurePrivateDirectoryTree(assets.avatarDir, paths.trustedRoot);
  const target = path.join(assets.avatarDir, profile.agentId + ".jpg");
  const temporary = path.join(assets.avatarDir, `.builtin-avatar-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, fs.readFileSync(path.join(BUNDLED_DIR, entry.file)), { flag: "wx", mode: 0o600 });
    // Publish a complete image without replacing a concurrently uploaded one.
    fs.linkSync(temporary, target);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = { assignBuiltinAgentAvatar };
