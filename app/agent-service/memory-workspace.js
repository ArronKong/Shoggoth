"use strict";

// Workspace identity uses the existing bounded repository lookup cache.
// Keep filesystem discovery separate from the pure content helpers.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function workspaceMemoryRef(workspace) {
  return `workspace:${crypto.createHash("sha256").update(workspace || "").digest("hex")}`;
}
// A project is the git repository a workspace belongs to, so every worktree
// and subdirectory of one clone shares its project memory. The key is the
// repository's common git directory; a directory outside git has none.
const repositoryKeys = new Map();
function repositoryKey(workspace) {
  if (typeof workspace !== "string" || !path.isAbsolute(workspace)) return null;
  if (repositoryKeys.has(workspace)) return repositoryKeys.get(workspace);
  let key = null;
  try {
    for (let dir = workspace; ; dir = path.dirname(dir)) {
      const marker = path.join(dir, ".git");
      const stat = fs.lstatSync(marker, { throwIfNoEntry: false });
      if (stat?.isDirectory()) { key = fs.realpathSync(marker); break; }
      if (stat?.isFile()) {
        const gitdir = /^gitdir:\s*(.+)$/mu.exec(fs.readFileSync(marker, "utf8"))?.[1]?.trim();
        if (!gitdir) break;
        const resolved = path.resolve(dir, gitdir);
        const common = fs.readFileSync(path.join(resolved, "commondir"), { encoding: "utf8", flag: "r" }).trim();
        key = fs.realpathSync(path.resolve(resolved, common));
        break;
      }
      if (path.dirname(dir) === dir) break;
    }
  } catch { key = null; }
  if (repositoryKeys.size >= 256) repositoryKeys.clear();
  repositoryKeys.set(workspace, key);
  return key;
}
// Refs a new fact of this scope carries: a project fact also names its
// repository; a workspace fact stays with its exact directory.
function workspaceMemoryRefs(workspace, scope) {
  const key = scope === "project" ? repositoryKey(workspace) : null;
  return [workspaceMemoryRef(workspace), ...(key ? [workspaceMemoryRef(`git:${key}`)] : [])];
}
// A project/workspace fact belongs to the current workspace when it carries
// the directory's ref or, for older and newer facts alike, its repository's.
function matchesWorkspace(item, workspace) {
  return workspaceMemoryRefs(workspace, "project").some((ref) => item.sourceRefs.includes(ref));
}

module.exports = { matchesWorkspace, workspaceMemoryRef, workspaceMemoryRefs };
