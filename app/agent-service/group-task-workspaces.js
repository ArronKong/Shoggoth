"use strict";

const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// 群任务的独立工作副本（计划 D13）：同一个 git 项目里已经有任务在跑时，新的原生成员任务不再排队，
// 而是在自己的 git worktree + 分支里执行。任务结束后由宿主把改动提交到这个分支并撤掉工作目录，
// 分支留给用户决定要不要合并——这里从不合并、不推送、不碰用户当前的分支和工作区。
//
// 所有 git 命令都在宿主进程里用 execFile 执行（不经 shell），关闭仓库钩子和 GPG 签名，同一仓库的
// 写操作串行。任何一步失败调用方都按「没有独立副本」处理，退回原来的排队。
const GIT_TIMEOUT_MS = 60_000;
const MAX_BLOB_BYTES = 16 * 1024 * 1024;
const BRANCH_PREFIX = "shoggoth-group/";

function gitEnvironment() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX", "GIT_OBJECT_DIRECTORY"]) delete env[name];
  return env;
}

function runGit(cwd, args, { binary = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "gc.auto=0", ...args],
      { cwd, env: gitEnvironment(), timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BLOB_BYTES, encoding: binary ? "buffer" : "utf8" },
      (error, stdout, stderr) => {
        if (error) { error.stderr = String(stderr || ""); reject(error); return; }
        resolve(stdout);
      });
  });
}

const safeRelative = (value) => typeof value === "string" && value.length > 0 && !path.isAbsolute(value)
  && !value.split(/[\\/]/u).includes("..") && !value.includes("\0");

class GroupTaskWorkspaces {
  /** @param {{ root: string, git?: typeof runGit }} options root：工作副本目录（在 Service 状态目录里，不在用户项目里） */
  constructor({ root, git = runGit }) {
    this.root = root;
    this.git = git;
    this.queues = new Map();
    this.detected = new Map();
  }

  // 同一仓库的 worktree / 提交操作排成队，避免 git 自己的锁互相撞。
  #serial(repoRoot, work) {
    const prior = this.queues.get(repoRoot) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(work);
    this.queues.set(repoRoot, next);
    void next.finally(() => { if (this.queues.get(repoRoot) === next) this.queues.delete(repoRoot); }).catch(() => {});
    return next;
  }

  /** 返回 workspace 所属 Git 仓库的真实根目录；非仓库、无提交或不可读路径返回 null。 */
  async repoRoot(workspace) {
    // 每次唤醒都会为排队中的任务再问一遍：短时间内沿用上次的判断，不为同一个目录反复起 git 进程。
    const known = this.detected.get(workspace);
    if (known && Date.now() - known.at < 5_000) return known.value;
    const value = await this.#detect(workspace);
    this.detected.set(workspace, { value, at: Date.now() });
    return value;
  }

  async #detect(workspace) {
    try {
      const real = fs.realpathSync(workspace);
      const top = fs.realpathSync((await this.git(real, ["rev-parse", "--show-toplevel"])).trim());
      await this.git(real, ["rev-parse", "--verify", "--quiet", "HEAD"]);
      return top;
    } catch { return null; }
  }

  /** 从当前 HEAD 开一个新分支和工作目录。 */
  async create({ repoRoot, taskId, workspace = repoRoot }) {
    const relativeDir = path.relative(repoRoot, fs.realpathSync(workspace));
    if (relativeDir && !safeRelative(relativeDir)) throw new Error("workspace is outside the repository");
    const id = crypto.randomUUID();
    const branch = `${BRANCH_PREFIX}${String(taskId).slice(0, 8)}-${id.slice(0, 4)}`;
    const dir = path.join(this.root, id);
    return this.#serial(repoRoot, async () => {
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
      const base = (await this.git(repoRoot, ["rev-parse", "HEAD"])).trim();
      await this.git(repoRoot, ["worktree", "add", "--quiet", "-b", branch, dir, base]);
      try {
        const effectiveWorkspace = path.join(dir, relativeDir);
        // 默认工作区继续指向同一个子项目；不能回退到仓库根目录或跟随副本里逃逸的链接。
        if (fs.realpathSync(effectiveWorkspace) !== path.join(fs.realpathSync(dir), relativeDir)
          || !fs.statSync(effectiveWorkspace).isDirectory()) {
          throw new Error("workspace is not present in the isolated checkout");
        }
        return { repoRoot, dir, workspace: effectiveWorkspace, relativeDir, branch, base, sealed: false };
      } catch (error) {
        await this.git(repoRoot, ["worktree", "remove", "--force", dir]).catch(() => {});
        await this.git(repoRoot, ["branch", "-D", branch]).catch(() => {});
        throw error;
      }
    });
  }

  /**
   * 任务尝试结束：把工作目录里的改动提交到分支，撤掉工作目录。没有改动时连分支一起删掉。
   * 提交失败时保留工作目录并返回 failed，让用户还能找到改动。
   * @returns {Promise<{ committed: boolean, commit: string|null, changedFiles: number, branch: string|null, failed: boolean }>}
   */
  async seal(isolation, { memberName, handle, objective }) {
    const { repoRoot, dir, branch, base } = isolation;
    return this.#serial(repoRoot, async () => {
      let committed = false;
      let changedFiles = 0;
      let commit = null;
      try {
        if (fs.existsSync(dir)) {
          await this.git(dir, ["add", "-A"]);
          const status = (await this.git(dir, ["status", "--porcelain"])).trim();
          if (status) {
            changedFiles = status.split("\n").length;
            await this.git(dir, ["-c", `user.name=${memberName}`, "-c", `user.email=${handle}@shoggoth.group`,
              "commit", "--quiet", "--no-verify", "-m", `${objective}\n\nShoggoth 群任务（执行：${memberName}）`]);
          }
        }
        // 工作目录已经不在（异常退出后被清掉）时，分支上已有的提交也算结果。
        try { commit = (await this.git(repoRoot, ["rev-parse", "--verify", "--quiet", branch])).trim(); } catch { commit = null; }
        committed = Boolean(commit) && commit !== base;
        if (committed && changedFiles === 0) {
          changedFiles = (await this.git(repoRoot, ["diff", "--name-only", `${base}..${branch}`])).trim().split("\n").filter(Boolean).length;
        }
      } catch (error) {
        return { committed: false, commit: null, changedFiles, branch, failed: true, error: String(error?.code || error?.message || "GIT_FAILED").slice(0, 80) };
      }
      await this.git(repoRoot, ["worktree", "remove", "--force", dir]).catch(() => { fs.rmSync(dir, { recursive: true, force: true }); });
      await this.git(repoRoot, ["worktree", "prune"]).catch(() => {});
      if (!committed) await this.git(repoRoot, ["branch", "-D", branch]).catch(() => {});
      return { committed, commit: committed ? commit : null, changedFiles, branch: committed ? branch : null, failed: false };
    });
  }

  /** 创建了工作副本却没能用上（认领失败等）时撤掉它。 */
  async discard(isolation) {
    return this.#serial(isolation.repoRoot, async () => {
      await this.git(isolation.repoRoot, ["worktree", "remove", "--force", isolation.dir])
        .catch(() => { fs.rmSync(isolation.dir, { recursive: true, force: true }); });
      await this.git(isolation.repoRoot, ["worktree", "prune"]).catch(() => {});
      await this.git(isolation.repoRoot, ["branch", "-D", isolation.branch]).catch(() => {});
    });
  }

  /** 从保存的提交读文件（旧记录退回分支，无改动读基线）；目录撤掉后也能预览。读不到返回 null。 */
  async readFile(isolation, relativePath) {
    const ref = isolation?.commit || isolation?.branch || (isolation?.sealed && !isolation.failed ? isolation.base : null);
    if (!ref || !isolation.repoRoot || !safeRelative(relativePath)) return null;
    try {
      if (isolation.relativeDir && !safeRelative(isolation.relativeDir)) return null;
      const posix = path.join(isolation.relativeDir || "", relativePath).split(path.sep).join("/");
      return await this.git(isolation.repoRoot, ["cat-file", "blob", `${ref}:${posix}`], { binary: true });
    } catch { return null; }
  }
}

module.exports = { BRANCH_PREFIX, GroupTaskWorkspaces };
