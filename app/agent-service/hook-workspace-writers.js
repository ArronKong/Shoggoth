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
  busy(runId, workspace, sandbox, agentWorkspace) {
    if (!workspace || sandbox === "read-only") return false;
    return [workspace, agentWorkspace].some(root => root && this.conflict(runId, workspaceIdentity(root)));
  }
  acquire(runId, workspace, sandbox, agentWorkspace) {
    if (!workspace || sandbox === "read-only") return false;
    const roots = [...new Set([workspace, agentWorkspace].filter(Boolean).map(workspaceIdentity))];
    const previous = this.runs.get(runId);
    if (previous && (previous.length !== roots.length || previous.some((key, index) => key !== roots[index]))) fail("HOOK_WRITE_FORBIDDEN");
    if (roots.some(key => this.conflict(runId, key))) fail("HOOK_WORKSPACE_BUSY");
    for (const key of roots) this.owners.set(key, runId);
    this.runs.set(runId, roots);
    return true;
  }
  assert(runId, workspace) {
    const key = workspaceIdentity(workspace);
    if (this.owners.get(key) !== runId || this.runs.get(runId)?.[0] !== key) fail("HOOK_WRITE_FORBIDDEN");
  }
  release(runId) {
    for (const root of this.runs.get(runId) || []) if (this.owners.get(root) === runId) this.owners.delete(root);
    this.runs.delete(runId);
  }
  close() { this.owners.clear(); this.runs.clear(); }
}
module.exports = { HookWorkspaceWriters };
