"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");
const { ensurePrivateDirectoryTree, lstatIfExists, serviceError } = require("./security");

const SCHEMA_VERSION = 1;
const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_SERVERS = 64;
const MAX_ARGS = 64;
const MAX_ARGUMENT_BYTES = 4096;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const FORBIDDEN_EXECUTABLES = new Set([
  "bash", "csh", "dash", "env", "fish", "osascript", "sh", "tcsh", "zsh",
]);

function mcpError(code, message) { return serviceError(code, message); }
function own(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function exact(value, fields) {
  return own(value) && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}
function safeText(value, maxBytes, allowEmpty = false) {
  return typeof value === "string" && value.isWellFormed() && !value.includes("\0")
    && (allowEmpty || value.length > 0) && Buffer.byteLength(value, "utf8") <= maxBytes;
}
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function publicServer(record) {
  return Object.freeze({
    id: record.id,
    name: record.name,
    command: record.command,
    args: [...record.args],
    cwd: record.cwd,
    enabled: record.enabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

class NativeMcpStore {
  constructor(options = {}) {
    if (!options.paths?.nativeMcpDir || !options.paths?.nativeMcpRegistryPath
      || !options.paths?.defaultWorkspaceDir || !options.paths?.trustedRoot) {
      throw new TypeError("NativeMcpStore 需要 Service MCP paths");
    }
    this.paths = options.paths;
    this.fs = options.fs || fs;
    try { this.trustedRootReal = this.fs.realpathSync(this.paths.trustedRoot); }
    catch { this.trustedRootReal = path.resolve(this.paths.trustedRoot); }
    this.now = options.now || Date.now;
    this.registry = null;
    this.opened = false;
  }

  _assertOpen() {
    if (!this.opened) throw mcpError("MCP_REGISTRY_CLOSED", "MCP Registry 未打开");
  }

  _validateExecutable(command, args) {
    if (!path.isAbsolute(command) || !inside(this.paths.trustedRoot, command)) {
      throw mcpError("MCP_SERVER_PATH_INVALID", "MCP 启动命令必须位于当前用户的受信目录");
    }
    let stat;
    let real;
    try {
      stat = this.fs.statSync(command);
      real = this.fs.realpathSync(command);
      this.fs.accessSync(command, fs.constants.X_OK);
    } catch {
      throw mcpError("MCP_SERVER_PATH_INVALID", "MCP 启动命令不存在或不可执行");
    }
    if (!stat.isFile()) throw mcpError("MCP_SERVER_PATH_INVALID", "MCP 启动命令不是文件");
    const executable = path.basename(real).toLowerCase();
    if (FORBIDDEN_EXECUTABLES.has(executable)) {
      throw mcpError("MCP_SERVER_COMMAND_FORBIDDEN", "不能把 shell 注册为 MCP Server");
    }
    if (!inside(this.trustedRootReal, real)) {
      const runtime = /^(?:python(?:\d+(?:\.\d+)*)?|node)$/u.test(executable);
      if (!runtime) throw mcpError("MCP_SERVER_PATH_INVALID", "MCP 命令解析到不受支持的外部程序");
      if (/^python/u.test(executable)
        && (args.length < 2 || args[0] !== "-m" || !/^[A-Za-z0-9_.-]{1,256}$/u.test(args[1]))) {
        throw mcpError("MCP_SERVER_COMMAND_FORBIDDEN", "工作区 Python MCP 必须使用 python -m module 启动");
      }
    }
  }

  prepare(input) {
    this._assertOpen();
    const fields = ["id", "name", "command", "args", "cwd", "enabled"];
    if (!exact(input, fields) || !ID_PATTERN.test(input.id) || !safeText(input.name, 256)
      || !safeText(input.command, 4096) || !path.isAbsolute(input.command)
      || !Array.isArray(input.args) || input.args.length > MAX_ARGS
      || input.args.some((arg) => !safeText(arg, MAX_ARGUMENT_BYTES, true))
      || !safeText(input.cwd, 4096) || !path.isAbsolute(input.cwd)
      || typeof input.enabled !== "boolean") {
      throw mcpError("MCP_SERVER_INVALID", "MCP Server 配置无效");
    }
    const command = path.resolve(input.command);
    const cwd = path.resolve(input.cwd);
    if (!inside(this.paths.trustedRoot, cwd)) {
      throw mcpError("MCP_SERVER_PATH_INVALID", "MCP 工作目录必须位于当前用户的受信目录");
    }
    let cwdStat;
    try { cwdStat = this.fs.statSync(cwd); } catch {
      throw mcpError("MCP_SERVER_PATH_INVALID", "MCP 工作目录不存在");
    }
    if (!cwdStat.isDirectory()) throw mcpError("MCP_SERVER_PATH_INVALID", "MCP 工作目录不是目录");
    this._validateExecutable(command, input.args);
    return Object.freeze({
      id: input.id,
      name: input.name.normalize("NFKC").trim(),
      command,
      args: Object.freeze([...input.args]),
      cwd,
      enabled: input.enabled,
    });
  }

  _validateRegistry(value) {
    if (!exact(value, ["schemaVersion", "revision", "updatedAt", "servers"])
      || value.schemaVersion !== SCHEMA_VERSION
      || !Number.isSafeInteger(value.revision) || value.revision < 1
      || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0
      || !Array.isArray(value.servers) || value.servers.length > MAX_SERVERS) {
      throw mcpError("MCP_REGISTRY_CORRUPT", "MCP Registry 无效");
    }
    const ids = new Set();
    const servers = value.servers.map((record) => {
      if (!exact(record, ["id", "name", "command", "args", "cwd", "enabled", "createdAt", "updatedAt"])
        || ids.has(record.id) || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
        || !Number.isSafeInteger(record.updatedAt) || record.updatedAt < record.createdAt) {
        throw mcpError("MCP_REGISTRY_CORRUPT", "MCP Registry Server 无效");
      }
      const prepared = this.prepare({
        id: record.id, name: record.name, command: record.command, args: record.args,
        cwd: record.cwd, enabled: record.enabled,
      });
      ids.add(record.id);
      return Object.freeze({ ...prepared, args: Object.freeze([...prepared.args]),
        createdAt: record.createdAt, updatedAt: record.updatedAt });
    });
    return { ...value, servers };
  }

  open() {
    ensurePrivateDirectoryTree(this.paths.nativeMcpDir, this.paths.trustedRoot);
    if (!lstatIfExists(this.paths.nativeMcpRegistryPath)) {
      const created = { schemaVersion: SCHEMA_VERSION, revision: 1, updatedAt: this.now(), servers: [] };
      atomicWritePrivateFile(this.paths.nativeMcpRegistryPath, `${JSON.stringify(created)}\n`, {
        fs: this.fs, trustedRoot: this.paths.trustedRoot,
      });
    }
    this.opened = true;
    try {
      const raw = readPrivateFile(this.paths.nativeMcpRegistryPath, { fs: this.fs, maxBytes: MAX_REGISTRY_BYTES });
      this.registry = this._validateRegistry(JSON.parse(raw.toString("utf8")));
    } catch (error) {
      this.opened = false;
      if (error?.code) throw error;
      throw mcpError("MCP_REGISTRY_CORRUPT", "MCP Registry 无法读取");
    }
    return this;
  }

  close() { this.registry = null; this.opened = false; }
  get revision() { this._assertOpen(); return this.registry.revision; }
  list() {
    this._assertOpen();
    return { revision: this.registry.revision, servers: this.registry.servers.map(publicServer) };
  }
  get(id) {
    this._assertOpen();
    const record = this.registry.servers.find((server) => server.id === id);
    return record ? publicServer(record) : null;
  }
  _commit(servers) {
    const next = {
      schemaVersion: SCHEMA_VERSION,
      revision: this.registry.revision + 1,
      updatedAt: this.now(),
      servers: servers.map((server) => ({ ...server, args: [...server.args] })),
    };
    const validated = this._validateRegistry(next);
    atomicWritePrivateFile(this.paths.nativeMcpRegistryPath, `${JSON.stringify(next)}\n`, {
      fs: this.fs, trustedRoot: this.paths.trustedRoot,
    });
    this.registry = validated;
    return this.registry.revision;
  }
  register(input) {
    this._assertOpen();
    if (!input || input.expectedRevision !== this.registry.revision) {
      throw mcpError("MCP_REGISTRY_REVISION_CONFLICT", "MCP Registry revision 已变化");
    }
    const prepared = this.prepare(input.server);
    const existing = this.registry.servers.find((server) => server.id === prepared.id);
    if (!existing && this.registry.servers.length >= MAX_SERVERS) {
      throw mcpError("MCP_REGISTRY_CAPACITY", "MCP Registry 已满");
    }
    const now = this.now();
    const record = Object.freeze({ ...prepared, args: Object.freeze([...prepared.args]),
      createdAt: existing?.createdAt ?? now, updatedAt: now });
    const servers = this.registry.servers.filter((server) => server.id !== prepared.id);
    servers.push(record);
    servers.sort((left, right) => left.id.localeCompare(right.id));
    return { revision: this._commit(servers), server: publicServer(record), replaced: Boolean(existing) };
  }
  remove(input) {
    this._assertOpen();
    if (!input || input.expectedRevision !== this.registry.revision || !ID_PATTERN.test(input.id || "")) {
      if (input?.expectedRevision !== this.registry.revision) {
        throw mcpError("MCP_REGISTRY_REVISION_CONFLICT", "MCP Registry revision 已变化");
      }
      throw mcpError("MCP_SERVER_INVALID", "MCP Server 删除参数无效");
    }
    const existing = this.registry.servers.find((server) => server.id === input.id);
    if (!existing) throw mcpError("MCP_SERVER_NOT_FOUND", "MCP Server 不存在");
    const revision = this._commit(this.registry.servers.filter((server) => server.id !== input.id));
    return { revision, removed: publicServer(existing) };
  }
}

module.exports = { NativeMcpStore };
