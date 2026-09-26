"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { unzipSync } = require("fflate");
const { serviceError } = require("./security");

const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MAX_ARCHIVE_BYTES = 40 * 1024 * 1024;
const MAX_FILES = 256;
const MAX_ENTRIES = 512;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

function fail(code, message) { throw serviceError(code, message); }
function git(repo, args, maxBuffer = 1024 * 1024) {
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !name.startsWith("GIT_")));
  Object.assign(environment, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1", GIT_LITERAL_PATHSPECS: "1" });
  const executable = process.platform === "darwin" ? "/usr/bin/git" : "git";
  const result = spawnSync(executable, ["-c", "core.hooksPath=/dev/null",
    "-c", "protocol.file.allow=never", "-C", repo, ...args], {
    encoding: null, timeout: 30_000, maxBuffer,
    env: environment,
  });
  if (result.error || result.status !== 0) {
    fail("GIT_SOURCE_INVALID", "固定 Git 来源无法读取");
  }
  return result.stdout;
}
function validateSubdir(value) {
  if (value === undefined || value === null || value === ".") return "";
  if (typeof value !== "string" || value.length > 1024 || !value
    || value.startsWith("/") || value.includes("\\") || value.includes("\0")
    || value.split("/").some((part) => !part || part === "." || part === "..")) {
    fail("GIT_SOURCE_INVALID", "Git 插件子目录无效");
  }
  return value;
}
function identifyGitSource({ repositoryPath, commit, subdir }) {
  if (typeof repositoryPath !== "string" || repositoryPath.length > 4096
    || !COMMIT_PATTERN.test(commit)) {
    fail("GIT_SOURCE_INVALID", "Git 来源必须指定本地仓库与完整提交 SHA");
  }
  let repo;
  try { repo = fs.realpathSync(repositoryPath); }
  catch { fail("GIT_SOURCE_INVALID", "Git 仓库不存在"); }
  const directory = validateSubdir(subdir);
  if (git(repo, ["cat-file", "-t", commit]).toString("utf8").trim() !== "commit") {
    fail("GIT_SOURCE_INVALID", "Git 来源不是固定提交");
  }
  const root = git(repo, ["rev-parse", "--show-toplevel"]).toString("utf8").trim();
  if (fs.realpathSync(root) !== repo) {
    fail("GIT_SOURCE_INVALID", "必须指定仓库顶层目录");
  }
  // A gitlink is a dependency on another repository, not immutable contents of
  // this commit. Do not fetch it implicitly or present it as a complete package.
  const tree = git(repo, ["ls-tree", "-r", "--full-tree", commit, "--",
    ...(directory ? [directory] : [])], 4 * 1024 * 1024).toString("utf8");
  if (tree.split("\n").some((line) => line.startsWith("160000 commit "))) {
    fail("GIT_SOURCE_INVALID", "插件包含未固定内容的 submodule");
  }
  if (tree.split("\n").some((line) => line.startsWith("120000 blob "))) {
    fail("GIT_SOURCE_INVALID", "Git 插件包含符号链接");
  }
  return { repo, commit, subdir: directory,
    sourceIdentity: `git:${repo}#${commit}:${directory || "."}` };
}
function materializeGitSource(source, targetRoot) {
  const tree = git(source.repo, ["ls-tree", "-r", "-z", "--full-tree", source.commit, "--",
    ...(source.subdir ? [source.subdir] : [])], 4 * 1024 * 1024);
  const archive = git(source.repo, ["archive", "--format=zip", source.commit, "--",
    ...(source.subdir ? [source.subdir] : [])], MAX_ARCHIVE_BYTES);
  const prefix = source.subdir ? `${source.subdir}/` : "";
  const executableByPath = new Map();
  for (const entry of tree.toString("utf8").split("\0").filter(Boolean)) {
    const separator = entry.indexOf("\t");
    const header = entry.slice(0, separator);
    const name = entry.slice(separator + 1);
    if (separator < 0 || !/^100(?:644|755) blob [a-f0-9]{40,64}$/u.test(header)
      || !name.startsWith(prefix) || !name.slice(prefix.length)
      || executableByPath.has(name)) {
      fail("GIT_SOURCE_INVALID", "Git 插件文件模式或路径无效");
    }
    executableByPath.set(name, header.startsWith("100755 "));
  }
  let count = 0;
  let entriesSeen = 0;
  let totalBytes = 0;
  let entries;
  try {
    entries = unzipSync(archive, { filter(entry) {
      if (++entriesSeen > MAX_ENTRIES) fail("PACKAGE_TOO_LARGE", "Git archive 条目过多");
      const name = entry.name;
      if (name === "__proto__" || name.includes("\\") || name.includes("\0")
        || name.startsWith("/") || name.split("/").some((part) => part === "..")) {
        fail("GIT_SOURCE_INVALID", "Git archive 包含不安全路径");
      }
      if (!name.startsWith(prefix) && name !== source.subdir) {
        fail("GIT_SOURCE_INVALID", "Git archive 超出所选子目录");
      }
      if (name.endsWith("/")) return false;
      if (entry.originalSize > MAX_FILE_BYTES || ++count > MAX_FILES
        || (totalBytes += entry.originalSize) > MAX_TOTAL_BYTES) {
        fail("PACKAGE_TOO_LARGE", "Git 插件超过容量上限");
      }
      return true;
    } });
  } catch (failure) {
    if (failure?.code) throw failure;
    fail("GIT_SOURCE_INVALID", "Git archive 无法解码");
  }
  fs.mkdirSync(targetRoot, { mode: 0o700 });
  if (Object.keys(entries).length !== executableByPath.size) {
    fail("GIT_SOURCE_INVALID", "Git archive 与提交文件列表不一致");
  }
  for (const [archiveName, bytes] of Object.entries(entries)) {
    if (!executableByPath.has(archiveName)) {
      fail("GIT_SOURCE_INVALID", "Git archive 包含提交外文件");
    }
    const relative = archiveName.slice(prefix.length);
    if (!relative || relative.split("/").some((part) => !part || part === "." || part === "..")) {
      fail("GIT_SOURCE_INVALID", "Git archive 文件路径无效");
    }
    if (bytes.length > MAX_FILE_BYTES) fail("PACKAGE_TOO_LARGE", "Git 插件文件超出容量上限");
    const target = path.join(targetRoot, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
    fs.chmodSync(target, executableByPath.get(archiveName) ? 0o700 : 0o600);
    if (Buffer.from(bytes.subarray(0, 43)).toString("utf8") === "version https://git-lfs.github.com/spec/v1\n") {
      fail("GIT_SOURCE_INVALID", "Git LFS 指针未包含真实插件内容");
    }
  }
  return targetRoot;
}

module.exports = { identifyGitSource, materializeGitSource };
