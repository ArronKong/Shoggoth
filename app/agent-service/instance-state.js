"use strict";

const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { readClientToken, requestService } = require("./client");
const { assertPrivateRegularFile, rejectSymlink, serviceError } = require("./security");

function pidIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function defaultProcessIdentity(pid) {
  try {
    // command/process.title 是可变展示字段，不能参与 PID reuse 身份判断。
    return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 500,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function parseLockRecord(contents) {
  try {
    const parsed = JSON.parse(contents);
    if (parsed && typeof parsed === "object") return parsed;
    if (Number.isSafeInteger(parsed)) return { pid: parsed, nonce: null, startIdentity: null };
  } catch {
    const legacyPid = Number.parseInt(contents, 10);
    if (Number.isSafeInteger(legacyPid)) return { pid: legacyPid, nonce: null, startIdentity: null };
  }
  return { pid: 0, nonce: null, startIdentity: null };
}

function sameFile(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino;
}

function writeFully(fileSystem, fd, value) {
  const bytes = Buffer.from(value, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const written = fileSystem.writeSync(fd, bytes, offset, bytes.length - offset, null);
    if (!Number.isSafeInteger(written) || written <= 0) {
      const error = serviceError("SERVICE_LOCK_WRITE_FAILED", "Service lock 写入未取得进展");
      error.errno = "EIO";
      throw error;
    }
    offset += written;
  }
}

function cleanupFailedOwnedLock(fileSystem, lockPath, fd, identity, primaryError) {
  const errors = [primaryError];
  try {
    fileSystem.closeSync(fd);
  } catch (error) {
    errors.push(error);
    try { fileSystem.closeSync(fd); } catch (retryError) {
      if (retryError.code !== "EBADF") errors.push(retryError);
    }
  }
  let mayRetryUnlink = false;
  try {
    const current = fileSystem.lstatSync(lockPath);
    if (sameFile(current, identity)) {
      try {
        fileSystem.unlinkSync(lockPath);
      } catch (error) {
        errors.push(error);
        mayRetryUnlink = true;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") errors.push(error);
  }
  if (mayRetryUnlink) {
    try {
      const current = fileSystem.lstatSync(lockPath);
      if (sameFile(current, identity)) fileSystem.unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== "ENOENT") errors.push(error);
    }
  }
  if (errors.length === 1) throw primaryError;
  const aggregate = new AggregateError(errors, "Service lock 创建失败且清理不完整");
  aggregate.code = "SERVICE_LOCK_ACQUIRE_FAILED";
  throw aggregate;
}

async function acquireInstanceLock(lockPath, options) {
  const {
    paths,
    instanceNonce,
    getProcessIdentity,
    lockProbeTimeoutMs,
    protocolVersion,
  } = options;
  const fileSystem = options.fs || fs;
  rejectSymlink(lockPath);
  const ownRecord = {
    pid: process.pid,
    nonce: instanceNonce,
    startIdentity: getProcessIdentity(process.pid),
    createdAt: Date.now(),
  };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let fd;
    let createdIdentity;
    try {
      fd = fileSystem.openSync(lockPath, "wx", 0o600);
      createdIdentity = fileSystem.fstatSync(fd);
      writeFully(fileSystem, fd, `${JSON.stringify(ownRecord)}\n`);
      fileSystem.fchmodSync(fd, 0o600);
      fileSystem.fsyncSync(fd);
      return { fd, identity: createdIdentity, record: ownRecord };
    } catch (error) {
      if (fd !== undefined) {
        cleanupFailedOwnedLock(fileSystem, lockPath, fd, createdIdentity, error);
      }
      if (error.code !== "EEXIST") throw error;
      const before = assertPrivateRegularFile(lockPath);
      let contents = "";
      try { contents = fs.readFileSync(lockPath, "utf8"); } catch { /* retry stale */ }
      const record = parseLockRecord(contents);
      const ownerAlive = pidIsAlive(record.pid);
      const currentIdentity = ownerAlive && record.startIdentity
        ? getProcessIdentity(record.pid)
        : null;
      const identityMismatch = ownerAlive && record.startIdentity
        && currentIdentity && currentIdentity !== record.startIdentity;
      if (ownerAlive) {
        const deadline = Date.now() + lockProbeTimeoutMs;
        while (Date.now() <= deadline) {
          try {
            const token = readClientToken(paths);
            const status = await requestService(paths, {
              method: "service.status",
              token,
              version: protocolVersion,
            }, { timeoutMs: Math.max(20, Math.min(100, deadline - Date.now())) });
            const nonceMatches = !record.nonce || status.instanceNonce === record.nonce;
            if (status.pid === record.pid && nonceMatches) {
              throw serviceError("SERVICE_ALREADY_RUNNING", `Service 已运行 (pid ${record.pid})`);
            }
          } catch (probeError) {
            if (probeError.code === "SERVICE_ALREADY_RUNNING") throw probeError;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (!identityMismatch) {
          // 活 PID 且没有启动身份不匹配的强证据时，socket 暂时不响应也可能只是
          // SIGSTOP/启动竞态。此时回收 lock 会让两个 Service 同时拥有同一路径。
          throw serviceError(
            "SERVICE_LOCK_INDETERMINATE",
            `Service owner 状态无法确认，拒绝夺锁 (pid ${record.pid})`,
          );
        }
        // identity mismatch 也必须先完成上面的 nonce+认证 status 探测；只有探测
        // 未确认原 Service 后，才把它当作 PID reuse 的 stale lock。
      }
      const after = assertPrivateRegularFile(lockPath);
      let afterContents = "";
      try { afterContents = fs.readFileSync(lockPath, "utf8"); } catch { /* changed */ }
      if (!sameFile(before, after) || contents !== afterContents) continue;
      fs.unlinkSync(lockPath);
    }
  }
  throw serviceError("SERVICE_LOCK_FAILED", "无法取得 Service 单实例锁");
}

function writePrivateToken(tokenPath) {
  const stat = rejectSymlink(tokenPath);
  if (stat) assertPrivateRegularFile(tokenPath);
  const tempPath = `${tokenPath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
    const token = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(fd, `${token}\n`, "utf8");
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    const current = rejectSymlink(tokenPath);
    if (current) assertPrivateRegularFile(tokenPath);
    fs.renameSync(tempPath, tokenPath);
    const dirFd = fs.openSync(path.dirname(tokenPath), fs.constants.O_RDONLY);
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    return token;
  } catch (error) {
    if (error.code === "ELOOP") throw serviceError("UNSAFE_SYMLINK", `拒绝 token 符号链接: ${tokenPath}`);
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tempPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

module.exports = {
  acquireInstanceLock,
  defaultProcessIdentity,
  writePrivateToken,
};
