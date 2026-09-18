"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { serviceError } = require("./security");

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,255}$/u;
const LOCALIZATION_DIRECTORY = /^[A-Za-z0-9_.@-]{1,64}\.lproj$/u;
const MAX_APPLICATIONS = 4096;
const MAX_SCAN_DEPTH = 4;
const MAX_LOCALIZATIONS = 128;
const MAX_LOCALIZED_PLIST_BYTES = 256 * 1024;
const SEARCH_CATALOG_TTL_MS = 15_000;

function hostError(code, message) { return serviceError(code, message); }
function safeText(value, maxBytes) {
  return typeof value === "string" && value.length > 0 && value.isWellFormed()
    && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maxBytes;
}
function inside(root, target) { return target === root || target.startsWith(`${root}${path.sep}`); }
function normalizeResult(result) {
  if (typeof result === "string" && result.length > 0) {
    throw hostError("SYSTEM_HOST_FAILED", "macOS 宿主拒绝了操作");
  }
  if (result === false) throw hostError("SYSTEM_HOST_FAILED", "macOS 宿主操作失败");
}
function defaultReadPlist(target) {
  let output;
  try {
    output = execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", target], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(output);
  } catch {
    const extract = (key) => {
      try {
        return execFileSync("/usr/bin/plutil", ["-extract", key, "raw", target], {
          encoding: "utf8",
          timeout: 2_000,
          maxBuffer: 64 * 1024,
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch { return null; }
    };
    const bundleId = extract("CFBundleIdentifier");
    const name = extract("CFBundleDisplayName") || extract("CFBundleName");
    if (!bundleId || !name) throw hostError("SYSTEM_APPLICATION_INVALID", "应用 Info.plist 无法读取");
    return { CFBundleIdentifier: bundleId, CFBundleDisplayName: name };
  }
}

class SystemHostController {
  constructor(options = {}) {
    const host = options.host;
    if (!host || typeof host.openPath !== "function" || typeof host.openExternal !== "function"
      || typeof host.showItemInFolder !== "function") {
      throw new TypeError("SystemHostController 需要 macOS Host Adapter");
    }
    if (options.readPlist !== undefined && typeof options.readPlist !== "function") {
      throw new TypeError("SystemHostController readPlist 必须是函数");
    }
    this.fs = options.fs || fs;
    this.host = host;
    this.readPlist = options.readPlist || defaultReadPlist;
    this.platform = options.platform || process.platform;
    this.homeDirectory = path.resolve(options.homeDirectory || os.homedir());
    this.applicationRoots = (options.applicationRoots || [
      "/Applications",
      "/System/Applications",
      "/System/Library/CoreServices",
      "/System/Volumes/Preboot/Cryptexes/App/System/Applications",
      path.join(this.homeDirectory, "Applications"),
    ]).map((root) => path.resolve(root));
    this.folderRoots = (options.folderRoots || [this.homeDirectory]).map((root) => path.resolve(root));
    this.allowedUrlProtocols = new Set(options.allowedUrlProtocols || ["https:", "http:"]);
    this.searchCatalogCache = null;
  }

  #assertPlatform() {
    if (this.platform !== "darwin") throw hostError("SYSTEM_HOST_UNSUPPORTED", "System Host 仅支持 macOS");
  }

  #existingRoots(roots) {
    const result = [];
    for (const root of roots) {
      let stat;
      try { stat = this.fs.lstatSync(root); } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw hostError("SYSTEM_HOST_PATH_INVALID", "宿主能力根目录无效");
      }
      let canonical;
      try { canonical = this.fs.realpathSync(root); } catch {
        throw hostError("SYSTEM_HOST_PATH_INVALID", "宿主能力根目录无法规范化");
      }
      if (canonical !== root) throw hostError("SYSTEM_HOST_PATH_INVALID", "宿主能力根目录发生跳转");
      result.push(root);
    }
    return result;
  }

  #validatePath(target, roots, kind) {
    const absolute = path.resolve(target);
    const root = this.#existingRoots(roots).find((candidate) => inside(candidate, absolute));
    if (!root) throw hostError("SYSTEM_HOST_PATH_INVALID", "目标不在允许的宿主目录边界内");
    const relative = path.relative(root, absolute);
    let cursor = root;
    for (const part of relative ? relative.split(path.sep) : []) {
      if (!part || part === "." || part === "..") {
        throw hostError("SYSTEM_HOST_PATH_INVALID", "目标路径无效");
      }
      cursor = path.join(cursor, part);
      let stat;
      try { stat = this.fs.lstatSync(cursor); } catch {
        throw hostError("SYSTEM_HOST_PATH_INVALID", "目标路径不存在");
      }
      if (stat.isSymbolicLink()) throw hostError("UNSAFE_SYMLINK", "宿主能力拒绝 symlink");
    }
    let stat;
    try { stat = this.fs.lstatSync(absolute); } catch {
      throw hostError("SYSTEM_HOST_PATH_INVALID", "目标路径不存在");
    }
    if (kind === "directory" && !stat.isDirectory()) {
      throw hostError("SYSTEM_HOST_PATH_INVALID", "目标不是目录");
    }
    if (kind === "application" && (!stat.isDirectory() || !absolute.endsWith(".app"))) {
      throw hostError("SYSTEM_HOST_PATH_INVALID", "目标不是应用包");
    }
    if (kind === "selection" && !stat.isDirectory() && !stat.isFile()) {
      throw hostError("SYSTEM_HOST_PATH_INVALID", "Finder 选择目标类型无效");
    }
    if (stat.isFile() && stat.nlink !== 1) throw hostError("UNSAFE_HARDLINK", "宿主能力拒绝 hardlink");
    let canonical;
    try { canonical = this.fs.realpathSync(absolute); } catch {
      throw hostError("SYSTEM_HOST_PATH_INVALID", "目标无法规范化");
    }
    if (canonical !== absolute) throw hostError("SYSTEM_HOST_PATH_INVALID", "目标路径发生跳转");
    return absolute;
  }

  #application(target, rootIndex = 0) {
    const applicationPath = this.#validatePath(target, this.applicationRoots, "application");
    const plistPath = path.join(applicationPath, "Contents", "Info.plist");
    this.#validatePath(plistPath, [applicationPath], "selection");
    let plistStat;
    try { plistStat = this.fs.lstatSync(plistPath); } catch {
      throw hostError("SYSTEM_APPLICATION_INVALID", "应用缺少 Info.plist");
    }
    if (plistStat.isSymbolicLink() || !plistStat.isFile() || plistStat.nlink !== 1) {
      throw hostError("SYSTEM_APPLICATION_INVALID", "应用 Info.plist 类型无效");
    }
    const plist = this.readPlist(plistPath);
    const bundleId = plist?.CFBundleIdentifier;
    const name = plist?.CFBundleDisplayName || plist?.CFBundleName
      || path.basename(applicationPath, ".app");
    if (!BUNDLE_ID.test(bundleId) || !safeText(name, 512)) {
      throw hostError("SYSTEM_APPLICATION_INVALID", "应用身份无效");
    }
    const aliases = [path.basename(applicationPath, ".app"), ...this.#localizedNames(applicationPath)]
      .filter((alias, index, values) => alias !== name && values.indexOf(alias) === index);
    return Object.freeze({
      name, bundleId, path: applicationPath, rootIndex, aliases: Object.freeze(aliases),
    });
  }

  #localizedNames(applicationPath) {
    const resourcesPath = path.join(applicationPath, "Contents", "Resources");
    let resourcesStat;
    try { resourcesStat = this.fs.lstatSync(resourcesPath); } catch (error) {
      if (error?.code === "ENOENT") return [];
      return [];
    }
    if (resourcesStat.isSymbolicLink() || !resourcesStat.isDirectory()) return [];
    try {
      if (this.fs.realpathSync(resourcesPath) !== resourcesPath) return [];
    } catch { return []; }
    let directories;
    try {
      directories = this.fs.readdirSync(resourcesPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && LOCALIZATION_DIRECTORY.test(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, MAX_LOCALIZATIONS);
    } catch { return []; }
    const names = [];
    for (const directory of directories) {
      const localizationPath = path.join(resourcesPath, directory.name);
      const plistPath = path.join(localizationPath, "InfoPlist.strings");
      let directoryStat;
      let plistStat;
      try {
        directoryStat = this.fs.lstatSync(localizationPath);
        plistStat = this.fs.lstatSync(plistPath);
        if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()
          || plistStat.isSymbolicLink() || !plistStat.isFile() || plistStat.nlink !== 1
          || plistStat.size > MAX_LOCALIZED_PLIST_BYTES
          || this.fs.realpathSync(localizationPath) !== localizationPath
          || this.fs.realpathSync(plistPath) !== plistPath) continue;
      } catch { continue; }
      let plist;
      try { plist = this.readPlist(plistPath); } catch { continue; }
      for (const candidate of [plist?.CFBundleDisplayName, plist?.CFBundleName]) {
        if (safeText(candidate, 512) && !names.includes(candidate)) names.push(candidate);
      }
    }
    return names;
  }

  #catalog() {
    this.#assertPlatform();
    const roots = this.#existingRoots(this.applicationRoots);
    const applications = [];
    const seen = new Set();
    let visited = 0;
    const walk = (directory, rootIndex, depth) => {
      let names;
      try { names = this.fs.readdirSync(directory).sort((left, right) => left.localeCompare(right)); }
      catch { return; }
      for (const name of names) {
        visited += 1;
        if (visited > MAX_APPLICATIONS * 8) {
          throw hostError("SYSTEM_HOST_CAPACITY", "应用目录超过扫描容量");
        }
        const target = path.join(directory, name);
        let stat;
        try { stat = this.fs.lstatSync(target); } catch { continue; }
        if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
        if (name.endsWith(".app")) {
          if (seen.has(target)) continue;
          try {
            applications.push(this.#application(target, rootIndex));
            seen.add(target);
          } catch (error) {
            if (!["SYSTEM_APPLICATION_INVALID", "SYSTEM_HOST_PATH_INVALID"].includes(error?.code)) throw error;
          }
          if (applications.length > MAX_APPLICATIONS) {
            throw hostError("SYSTEM_HOST_CAPACITY", "应用数量超过扫描容量");
          }
        } else if (depth < MAX_SCAN_DEPTH) {
          walk(target, rootIndex, depth + 1);
        }
      }
    };
    roots.forEach((root, index) => walk(root, index, 0));
    return applications;
  }

  #searchCatalog() {
    const current = Date.now();
    if (this.searchCatalogCache && current < this.searchCatalogCache.expiresAt) {
      return this.searchCatalogCache.applications;
    }
    const applications = Object.freeze(this.#catalog());
    this.searchCatalogCache = Object.freeze({
      applications,
      expiresAt: current + SEARCH_CATALOG_TTL_MS,
    });
    return applications;
  }

  search(input) {
    if (!input || !safeText(input.query, 512)
      || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 20) {
      throw hostError("SYSTEM_HOST_INVALID_ARGUMENTS", "应用搜索参数无效");
    }
    const query = input.query.normalize("NFKC").toLocaleLowerCase("en-US");
    const score = (application) => {
      const values = [application.name, application.bundleId, ...application.aliases]
        .map((value) => value.normalize("NFKC").toLocaleLowerCase("en-US"));
      if (values.some((value) => value === query)) return 0;
      if (values.some((value) => value.startsWith(query))) return 1;
      if (values.some((value) => value.includes(query))) return 2;
      return null;
    };
    const applications = this.#searchCatalog()
      .map((application) => ({ application, score: score(application) }))
      .filter((item) => item.score !== null)
      .sort((left, right) => left.score - right.score
        || left.application.rootIndex - right.application.rootIndex
        || left.application.name.localeCompare(right.application.name)
        || left.application.path.localeCompare(right.application.path))
      .slice(0, input.limit)
      .map(({ application }) => ({
        name: application.name, bundleId: application.bundleId, path: application.path,
      }));
    return Object.freeze({ applications: Object.freeze(applications) });
  }

  async launch(input) {
    this.#assertPlatform();
    if (!input || (Boolean(input.bundleId) === Boolean(input.applicationPath))) {
      throw hostError("SYSTEM_HOST_INVALID_ARGUMENTS", "应用启动参数必须二选一");
    }
    let application;
    if (input.bundleId) {
      if (!BUNDLE_ID.test(input.bundleId)) throw hostError("SYSTEM_HOST_INVALID_ARGUMENTS", "Bundle ID 无效");
      const matches = this.#catalog().filter((item) => item.bundleId === input.bundleId);
      if (matches.length === 0) throw hostError("SYSTEM_APPLICATION_NOT_FOUND", "找不到目标应用");
      if (matches.length > 1) throw hostError("SYSTEM_APPLICATION_AMBIGUOUS", "Bundle ID 对应多个应用");
      [application] = matches;
    } else {
      if (!safeText(input.applicationPath, 4096) || !path.isAbsolute(input.applicationPath)) {
        throw hostError("SYSTEM_HOST_INVALID_ARGUMENTS", "应用路径无效");
      }
      application = this.#application(path.resolve(input.applicationPath));
    }
    normalizeResult(await this.host.openPath(application.path));
    return Object.freeze({
      application: Object.freeze({
        name: application.name, bundleId: application.bundleId, path: application.path,
      }),
      launched: true,
    });
  }

  async openUrl(input) {
    this.#assertPlatform();
    if (!input || !safeText(input.url, 4096)) {
      throw hostError("SYSTEM_HOST_INVALID_ARGUMENTS", "URL 参数无效");
    }
    let parsed;
    try { parsed = new URL(input.url); } catch {
      throw hostError("SYSTEM_URL_FORBIDDEN", "URL 无效");
    }
    if (!this.allowedUrlProtocols.has(parsed.protocol) || parsed.username || parsed.password) {
      throw hostError("SYSTEM_URL_FORBIDDEN", "URL 协议或凭据不允许");
    }
    const normalized = parsed.href;
    normalizeResult(await this.host.openExternal(normalized));
    return Object.freeze({ url: normalized, opened: true });
  }

  async openFolder(input) {
    this.#assertPlatform();
    if (!input || !safeText(input.path, 4096)
      || (input.select !== null && input.select !== undefined && !safeText(input.select, 1024))) {
      throw hostError("SYSTEM_HOST_INVALID_ARGUMENTS", "Finder 参数无效");
    }
    const expanded = input.path === "~" ? this.homeDirectory
      : input.path.startsWith("~/") ? path.join(this.homeDirectory, input.path.slice(2)) : input.path;
    if (!path.isAbsolute(expanded)) throw hostError("SYSTEM_HOST_INVALID_ARGUMENTS", "Finder 路径必须是绝对路径");
    const folder = this.#validatePath(path.resolve(expanded), this.folderRoots, "directory");
    let selected = null;
    if (input.select !== null && input.select !== undefined) {
      if (path.basename(input.select) !== input.select || input.select === "." || input.select === "..") {
        throw hostError("SYSTEM_HOST_INVALID_ARGUMENTS", "Finder select 必须是目录内单个名称");
      }
      selected = this.#validatePath(path.join(folder, input.select), [folder], "selection");
    }
    normalizeResult(await this.host.openPath(folder));
    if (selected !== null) normalizeResult(await this.host.showItemInFolder(selected));
    return Object.freeze({ path: folder, selected, opened: true });
  }
}

module.exports = { SystemHostController };
