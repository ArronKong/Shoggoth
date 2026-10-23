"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { automaticRuntimeApproval: approve } = require("../app/agent-service/runtime-automatic-approval");
const { CHAT_PERMISSION_MODES: MODES } = require("../app/agent-service/runtime-permission-modes");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-auto-approval-"));
const workspace = path.join(root, "workspace");
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace, "draft.txt"), "draft");
fs.writeFileSync(path.join(root, "outside.txt"), "private");
fs.symlinkSync(root, path.join(workspace, "linked"));
fs.linkSync(path.join(root, "outside.txt"), path.join(workspace, "hardlink.txt"));
const contract = { runtime: "pi", permissionMode: MODES.auto, workspace,
  permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" } };
const request = { contract, method: "item/fileChange/requestApproval",
  params: { toolName: "write", grantRoot: workspace, toolInput: { path: "draft.txt", content: "hello" } } };
try {
  for (const runtime of ["pi", "opencode", "deepseek-harness", "antigravity"]) {
    assert.deepEqual(approve({ ...request, contract: { ...contract, runtime } })?.response, { decision: "accept" });
  }
  for (const runtime of ["codex", "claude-code", "grok-build"]) {
    assert.equal(approve({ ...request, contract: { ...contract, runtime } }), null,
      "A native review fallback must reach the user instead of being overruled");
  }
  for (const file of ["../outside.txt", path.join(root, "outside.txt"), "linked/outside.txt", "hardlink.txt",
    ".env", ".git/config", "AGENTS.md", "CLAUDE.md", "node_modules/x.js", "package.json",
    "credentials.json", "auth.json", "tokens.txt", "secret.pem", "*.txt", "a\nb", "missing/draft.txt"]) {
    assert.equal(approve({ ...request, params: { ...request.params, toolInput: { path: file } } }), null, file);
  }
  assert.ok(approve({ ...request, params: { ...request.params, toolInput: { path: "new.txt" } } }));
  assert.equal(approve({ ...request, params: { grantRoot: workspace } }), null, "Grant root is not a file operation");
  for (const toolName of ["delete", "move", "bash", "unknown"]) {
    assert.equal(approve({ ...request, params: { ...request.params, toolName } }), null);
  }
  for (const patch of [{ command: "rm -rf /" }, { automaticReviewBlocked: true },
    { cwd: root }, { networkApprovalContext: {} }, { redacted: true },
    { toolInput: { path: "draft.txt", file_path: "outside.txt" } }, { toolInput: { path: "[REDACTED]" } }]) {
    assert.equal(approve({ ...request, params: { ...request.params, ...patch } }), null);
  }
  for (const permissionMode of [MODES.ask, "workspace-auto", "plan", "read-only", null]) {
    assert.equal(approve({ ...request, contract: { ...contract, permissionMode } }), null);
  }
  assert.equal(approve({ ...request, contract: { ...contract, permissionPolicy: { sandbox: "read-only" } } }), null);
  const full = { ...contract, permissionMode: MODES.full };
  const shell = { contract: full, method: "item/commandExecution/requestApproval",
    params: { command: "run something", cwd: workspace } };
  assert.deepEqual(approve(shell).response, { decision: "accept" });
  for (const method of ["mcpServer/elicitation/request", "shoggoth/pluginTool/requestApproval", "shoggoth/mcp.call"]) {
    assert.equal(approve({ ...shell, method }), null, "Product confirmations and user input stay interactive");
  }
  const options = [{ choice: "once", kind: "allow_once" }, { choice: "session", kind: "allow_always" }];
  assert.deepEqual(approve({ ...request, params: { ...request.params, approvalOptions: options } }).response,
    { decision: "accept", approvalChoice: "once" });
  assert.equal(approve({ ...request, params: { ...request.params, approvalOptions: options.slice(1) } }), null);
  const permission = { fileSystem: { write: [workspace] } };
  assert.deepEqual(approve({ contract: full, method: "item/permissions/requestApproval", params: { permissions: permission } }).response,
    { permissions: permission, scope: "turn" });
  console.log("PASS automatic approval confines file grants and preserves interactive boundaries");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
