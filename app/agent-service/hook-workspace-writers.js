"use strict";
const { fail } = require("./hook-contract");
const fs = require("node:fs"), path = require("node:path");
const contains = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
function workspaceIdentity(workspace) {
  if (typeof workspace !== "string" || !path.isAbsolute(workspace) || workspace.includes("\0")) fail("HOOK_WRITE_FORBIDDEN");
  const missing = []; let cursor = path.resolve(workspace);
  for (;;) {
    try {
      const current = fs.realpathSync(cursor);
      if (!fs.statSync(current).isDirectory()) fail("HOOK_WRITE_FORBIDDEN");
      return path.join(current, ...missing);
    } catch (error) {
      if (error.code !== "ENOENT") fail("HOOK_WRITE_FORBIDDEN");
      const parent = path.dirname(cursor);
      if (parent === cursor) fail("HOOK_WRITE_FORBIDDEN");
      missing.unshift(path.basename(cursor)); cursor = parent;
    }
  }
}
// All writable native Runs participate, including Runs with no action Hook.
// A writer stays occupied until its exact Run terminates and workers exit.
class HookWorkspaceWriters {
  constructor() { this.owners = new Map(); this.runs = new Map(); }
  conflict(runId, key) {
    for (const [workspace, owner] of this.owners) {
      if (owner !== runId && (contains(workspace, key) || contains(key, workspace))) return true;
    }
    return false;
  }
  busy(runId, workspace, sandbox) {
    if (!workspace || sandbox === "read-only") return false;
    return this.conflict(runId, workspaceIdentity(workspace));
  }
  acquire(runId, workspace, sandbox) {
    if (!workspace || sandbox === "read-only") return false;
    const key = workspaceIdentity(workspace);
    if (this.runs.has(runId) && this.runs.get(runId) !== key) fail("HOOK_WRITE_FORBIDDEN");
    if (this.conflict(runId, key)) fail("HOOK_WORKSPACE_BUSY");
    this.owners.set(key, runId); this.runs.set(runId, key); return true;
  }
  assert(runId, workspace) {
    const key = workspaceIdentity(workspace);
    if (this.owners.get(key) !== runId || this.runs.get(runId) !== key) fail("HOOK_WRITE_FORBIDDEN");
  }
  release(runId) {
    const workspace = this.runs.get(runId);
    if (workspace && this.owners.get(workspace) === runId) this.owners.delete(workspace);
    this.runs.delete(runId);
  }
  close() { this.owners.clear(); this.runs.clear(); }
}
module.exports = { HookWorkspaceWriters };
