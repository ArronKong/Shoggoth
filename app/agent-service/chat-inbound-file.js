"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { ensureAgentWorkspace } = require("./chat-workspace");
const { serviceError } = require("./security");

const unsafe = () => serviceError("UNSAFE_PATH", "Agent 附件接收路径无效");

function inboundTarget(root, id, name) {
  if (![id, name].every(part => typeof part === "string" && part.length && path.basename(part) === part
    && part !== "." && part !== ".." && !part.includes("\0"))) throw unsafe();
  return path.join(root, "inbound", id, name);
}

function existingCopy(target) {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return false;
  if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(target) !== target) throw unsafe();
  return true;
}

// Enter each directory in a short-lived child. Its cwd pins the directory
// inode, so renaming or replacing an ancestor cannot redirect a later write.
function publish(root, id, name, original) {
  const target = inboundTarget(root, id, name);
  const enter = (component, expected) => {
    try { fs.mkdirSync(component, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    if (!fs.lstatSync(component).isDirectory()) throw unsafe();
    process.chdir(component);
    if (fs.realpathSync(".") !== expected) throw unsafe();
  };
  if (fs.realpathSync(".") !== root) throw unsafe();
  enter("inbound", path.join(root, "inbound"));
  enter(id, path.join(root, "inbound", id));
  if (existingCopy(target)) return;
  // Only link an independent, fully written staging copy. The immutable
  // attachment and the editable file must never share an inode.
  const stage = fs.mkdtempSync(path.join(path.dirname(original), ".inbound-"));
  const temp = path.join(stage, "file");
  try {
    fs.copyFileSync(original, temp, fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL);
    try { fs.linkSync(temp, name); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  if (!existingCopy(target)) throw unsafe();
}

function deliverToWorkspace(root, attachment, original) {
  const name = path.basename(original);
  const target = inboundTarget(root, attachment.id, name);
  if (!existingCopy(target)) {
    try {
      execFileSync(process.execPath, [__filename, root, attachment.id, name, original], {
        cwd: root, env: { ELECTRON_RUN_AS_NODE: "1" }, stdio: "pipe", timeout: 30_000,
      });
    } catch (error) {
      if (error.stderr?.toString().trim() === "UNSAFE_PATH") throw unsafe();
      throw serviceError("CHAT_ATTACHMENT_DELIVERY_FAILED", "附件未能写入 Agent 的 inbound 目录", error);
    }
  }
  return target;
}

// Single-file callers supply Service paths and the owning profile. Batch
// preparation resolves the same workspace once for all attachments.
function deliverInboundFile(workspaceOrPaths, ...args) {
  if (typeof workspaceOrPaths === "string") {
    const [attachment, original] = args;
    return deliverToWorkspace(workspaceOrPaths, attachment, original);
  }
  const [profileId, attachment, original] = args;
  const root = fs.realpathSync(ensureAgentWorkspace(workspaceOrPaths, profileId));
  return deliverToWorkspace(root, attachment, original);
}

if (require.main === module) {
  try { publish(...process.argv.slice(2)); }
  catch (error) { process.stderr.write(error.code || "CHAT_ATTACHMENT_DELIVERY_FAILED"); process.exitCode = 1; }
}

module.exports = { deliverInboundFile };
