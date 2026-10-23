"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { CHAT_PERMISSION_MODES } = require("./runtime-permission-modes");
const { workspaceAutoExecution } = require("./workspace-execution-tools");

const FALLBACK_RUNTIMES = new Set(["pi", "opencode", "deepseek-harness", "antigravity"]);
const METHODS = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval",
  "item/permissions/requestApproval"]);
const FILE_TOOLS = new Set(["edit", "write", "read", "read_file", "write_file", "edit_file",
  "write_to_file", "replace_file_content", "multi_replace_file_content", "view_file"]);
const PROTECTED = /^(?:\.|node_modules$|AGENTS\.md$|CLAUDE\.md$|GEMINI\.md$|package\.json$|(?:credentials?|secrets?|tokens?|auth|id_rsa|id_ed25519)(?:\.|$)|.*\.pem$|.*\.key$)/iu;

// A deliberately narrow fallback for runtimes without an approval reviewer:
// review structured file access within the current workspace. Shell commands,
// network access, deletion, permission expansion and ambiguous inputs go to the
// user. A path grant alone is never evidence of the operation being approved.
function localFileAccess(params, workspace) {
  const input = params?.toolInput;
  if (!FILE_TOOLS.has(params?.toolName) || !input || typeof input !== "object" || Array.isArray(input)
    || typeof workspace !== "string" || !path.isAbsolute(workspace)
    || params.command || params.networkApprovalContext || params.automaticReviewBlocked) return false;
  let serialized;
  try { serialized = JSON.stringify(input); } catch { return false; }
  if (!serialized || serialized.length > 16 * 1024
    || /redacted|truncated/iu.test(serialized)) return false;
  const candidates = ["path", "file_path", "filePath", "TargetFile", "AbsolutePath", "target_file"]
    .filter(key => Object.hasOwn(input, key)).map(key => input[key]);
  if (candidates.length !== 1 || typeof candidates[0] !== "string" || !candidates[0]
    || candidates[0].length > 4096 || /[\0\r\n*?[\]{}]/u.test(candidates[0])) return false;
  const cwd = params.cwd || params.grantRoot || workspace;
  if (typeof cwd !== "string" || path.resolve(cwd) !== path.resolve(workspace)) return false;
  const target = path.resolve(workspace, candidates[0]);
  const relative = path.relative(path.resolve(workspace), target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  const segments = relative.split(path.sep);
  if (segments.length > 64 || segments.some(segment => PROTECTED.test(segment))) return false;
  try {
    let current = fs.realpathSync(workspace);
    if (!fs.statSync(current).isDirectory()) return false;
    for (let index = 0; index < segments.length; index++) {
      current = path.join(current, segments[index]);
      let stat;
      try { stat = fs.lstatSync(current); } catch (error) {
        // Allow a new file only under an existing, verified directory.
        return error.code === "ENOENT" && index === segments.length - 1;
      }
      if (stat.isSymbolicLink() || (index < segments.length - 1 ? !stat.isDirectory()
        : !stat.isFile() || stat.nlink !== 1)) return false;
    }
    return true;
  } catch { return false; }
}

function automaticRuntimeApproval({ method, params, contract }) {
  if (!contract || !METHODS.has(method) || !params) return null;
  if (workspaceAutoExecution(contract)
    && ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(method)) {
    const response = { decision: "decline" };
    if (params.approvalOptions !== undefined) {
      if (!Array.isArray(params.approvalOptions)) return { reviewer: "workspace-managed-execution", response };
      const rejects = params.approvalOptions.filter(option => option?.kind === "reject_once" && typeof option.choice === "string");
      if (rejects.length === 1) response.approvalChoice = rejects[0].choice;
    }
    return { reviewer: "workspace-managed-execution", response };
  }
  if (params.redacted === true || params.automaticReviewBlocked === true) return null;
  const full = contract.permissionMode === CHAT_PERMISSION_MODES.full;
  const review = contract.permissionMode === CHAT_PERMISSION_MODES.auto;
  if (!full && !(review && FALLBACK_RUNTIMES.has(contract.runtime)
    && contract.permissionPolicy?.sandbox !== "read-only"
    && method !== "item/permissions/requestApproval"
    && localFileAccess(params, contract.workspace))) return null;
  let response;
  if (params.approvalOptions !== undefined) {
    if (!Array.isArray(params.approvalOptions)) return null;
    const once = params.approvalOptions.filter(option => option?.kind === "allow_once"
      && typeof option.choice === "string");
    if (once.length !== 1) return null;
    response = { decision: "accept", approvalChoice: once[0].choice };
  } else if (method === "item/permissions/requestApproval") {
    if (!params.permissions || typeof params.permissions !== "object" || Array.isArray(params.permissions)) return null;
    response = { permissions: structuredClone(params.permissions), scope: "turn" };
  } else {
    response = { decision: "accept" };
  }
  return { reviewer: full ? "full-access" : "workspace-file-rules", response };
}

module.exports = { automaticRuntimeApproval };
