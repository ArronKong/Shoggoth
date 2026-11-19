"use strict";
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { TASK_ID_PATTERN } = require("./background-task-protocol");
const { ensurePrivateDirectoryTree, serviceError } = require("./security");

const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function agentWorkspaceRoot(paths, profileId) {
  if (!path.isAbsolute(paths?.defaultWorkspaceDir || "") || typeof profileId !== "string"
    || !PROFILE_ID_PATTERN.test(profileId)) {
    throw serviceError("CHAT_SESSION_INVALID", "Agent 工作区标识无效");
  }
  return path.join(paths.defaultWorkspaceDir, profileId);
}

function ensureAgentWorkspace(paths, profileId) {
  const root = agentWorkspaceRoot(paths, profileId);
  ensurePrivateDirectoryTree(root, paths.trustedRoot);
  return root;
}

function describeAgentWorkspace(paths, profileId) {
  if (!paths?.defaultWorkspaceDir) return undefined;
  const root = agentWorkspaceRoot(paths, profileId);
  return { path: root, exists: fs.lstatSync(root, { throwIfNoEntry: false })?.isDirectory() === true };
}

function managedChatWorkspace(profileRoot, operationId) {
  return path.join(profileRoot, "sessions", crypto.createHash("sha256").update(operationId).digest("hex"));
}

function isMainCreation(creation) {
  return /^default-session-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(creation.operationId)
    || (creation.operationId.startsWith("proactive-target-")
      && creation.operationId === `proactive-target-${require("./proactive-service-protocol").digest(creation.profileId)}`);
}

function wasChatWorkspaceMigrated(paths, session, creation) {
  if (!paths?.defaultWorkspaceDir || !creation || creation.sessionKey !== session.sessionKey
    || creation.profileId !== session.profileId || creation.workspace === session.workspace) return false;
  const root = agentWorkspaceRoot(paths, session.profileId);
  return session.workspace === root && (creation.workspace === managedChatWorkspace(root, creation.operationId)
    || isMainCreation(creation));
}

function matchesHistoricalWorkspace(store, session, workspace) {
  return session.workspace === workspace || store.wasOriginalWorkspace?.(session, workspace) === true;
}

// A chat at the Agent root holds a recursive writer lease. Task writers need
// a disjoint tree, even when the source did not select a project directory.
function backgroundTaskWorkspace(profileRoot, taskId) {
  if (!TASK_ID_PATTERN.test(taskId)) throw serviceError("BACKGROUND_TASK_NOT_FOUND", "后台任务标识无效");
  return path.join(path.dirname(profileRoot), ".background", path.basename(profileRoot), taskId);
}

// Older conversations used a generated child of the same Agent workspace.
function isAgentHomeWorkspace(paths, profileId, workspace) {
  if (!path.isAbsolute(paths?.defaultWorkspaceDir || "") || typeof profileId !== "string"
    || !PROFILE_ID_PATTERN.test(profileId) || typeof workspace !== "string") return false;
  const root = path.join(paths.defaultWorkspaceDir, profileId);
  const target = path.resolve(workspace);
  const relative = path.relative(root, target);
  const taskId = path.basename(target);
  return relative === "" || /^sessions\/[a-f0-9]{64}$/u.test(relative)
    || (TASK_ID_PATTERN.test(taskId) && target === backgroundTaskWorkspace(root, taskId));
}

module.exports = { agentWorkspaceRoot, ensureAgentWorkspace, describeAgentWorkspace, managedChatWorkspace, backgroundTaskWorkspace, isAgentHomeWorkspace,
  isMainCreation, wasChatWorkspaceMigrated, matchesHistoricalWorkspace };
