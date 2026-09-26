"use strict";
const path = require("node:path");
const crypto = require("node:crypto");

function managedChatWorkspace(profileRoot, operationId) {
  return path.join(profileRoot, "sessions", crypto.createHash("sha256").update(operationId).digest("hex"));
}

function isImplicitChatWorkspace(paths, profile, workspace) {
  if (profile.defaultCwd !== null || !paths.defaultWorkspaceDir || typeof workspace !== "string") return false;
  const root = path.resolve(paths.defaultWorkspaceDir, profile.id);
  const relative = path.relative(root, path.resolve(workspace));
  // Only an exact generated session directory is implicit.
  return /^sessions\/[a-f0-9]{64}$/u.test(relative);
}

module.exports = { managedChatWorkspace, isImplicitChatWorkspace };
