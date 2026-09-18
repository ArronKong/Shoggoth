"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { serviceError } = require("./security");

let physicalFs = fs;
try {
  // Electron 的 fs 会把 *.asar 映射成虚拟目录；安全校验必须观察磁盘上的
  // App bundle 目录项。普通 Node 环境没有 original-fs，继续使用 node:fs。
  physicalFs = require("original-fs");
} catch {
  physicalFs = fs;
}

function assertStableAppPaths(config, options = {}) {
  const { appPath, executablePath, bootstrapPath, resourcesPath } = config;
  const resolvedApp = path.resolve(appPath || "");
  const resolvedExecutable = path.resolve(executablePath || "");
  const resolvedBootstrap = path.resolve(bootstrapPath || "");
  const resolvedResources = path.resolve(resourcesPath || "");
  const applicationsRoot = path.resolve(options.applicationsRoot || "/Applications");
  if (path.dirname(resolvedApp) !== applicationsRoot || !/^[^/]+\.app$/.test(path.basename(resolvedApp))) {
    throw serviceError("UNSTABLE_INSTALL_LOCATION", "LaunchAgent 仅支持 /Applications 下的稳定 App 安装");
  }
  const contentsPrefix = `${resolvedApp}${path.sep}Contents${path.sep}`;
  if (!resolvedExecutable.startsWith(contentsPrefix) || !resolvedBootstrap.startsWith(contentsPrefix)) {
    throw serviceError("UNSAFE_APP_PATH", "可执行文件与 bootstrap 必须位于当前 App bundle 内");
  }
  const expectedResources = path.join(resolvedApp, "Contents", "Resources");
  const archivePath = path.join(expectedResources, "app.asar");
  const expectedBootstrap = path.join(archivePath, "app", "bootstrap.js");
  if (resolvedResources !== expectedResources || resolvedBootstrap !== expectedBootstrap) {
    throw serviceError("UNSAFE_APP_PATH", "resources/bootstrap 路径与当前 App bundle 不一致");
  }
  const resolved = {
    appPath: resolvedApp,
    executablePath: resolvedExecutable,
    resourcesPath: resolvedResources,
    bootstrapPath: resolvedBootstrap,
  };
  try {
    const rootStat = physicalFs.lstatSync(applicationsRoot);
    const appStat = physicalFs.lstatSync(resolvedApp);
    if (rootStat.isSymbolicLink() || appStat.isSymbolicLink()) {
      throw serviceError("UNSAFE_SYMLINK", "Applications 或 App bundle 不能是 symlink");
    }
    if (!rootStat.isDirectory() || !appStat.isDirectory()) {
      throw serviceError("UNSAFE_APP_PATH", "Applications/App bundle 不是目录");
    }
    const realRoot = physicalFs.realpathSync(applicationsRoot);
    const realApp = physicalFs.realpathSync(resolvedApp);
    if (path.dirname(realApp) !== realRoot || realApp !== path.join(realRoot, path.basename(resolvedApp))) {
      throw serviceError("UNSAFE_APP_PATH", "App bundle realpath 逃逸稳定安装目录");
    }
    // electron-builder 的 app.asar 是普通文件；宿主文件系统只能验证 archive 本身。
    // archive 内 bootstrap 由上面的精确词法路径约束，不能继续 lstat app.asar/app。
    for (const target of [resolvedExecutable, resolvedResources, archivePath]) {
      const relative = path.relative(resolvedApp, target);
      let cursor = resolvedApp;
      for (const segment of relative.split(path.sep)) {
        cursor = path.join(cursor, segment);
        if (physicalFs.lstatSync(cursor).isSymbolicLink()) {
          throw serviceError("UNSAFE_SYMLINK", `App bundle 内路径含 symlink: ${cursor}`);
        }
      }
      const realTarget = physicalFs.realpathSync(target);
      if (!realTarget.startsWith(`${realApp}${path.sep}Contents${path.sep}`)) {
        throw serviceError("UNSAFE_APP_PATH", `App bundle 内路径 realpath 逃逸: ${target}`);
      }
    }
    // Electron 会把合法的 app.asar 通过 fs.stat 映射成虚拟目录；这里校验的
    // 是 App bundle 的物理目录项，必须使用 lstat，不能采用 ASAR 虚拟视图。
    if (!physicalFs.lstatSync(resolvedExecutable).isFile()
      || !physicalFs.lstatSync(resolvedResources).isDirectory()
      || !physicalFs.lstatSync(archivePath).isFile()) {
      throw serviceError("UNSAFE_APP_PATH", "App executable/resources/app.asar 类型无效");
    }
  } catch (error) {
    if (error.code?.startsWith("UNSAFE_")) throw error;
    throw serviceError("UNSAFE_APP_PATH", `App bundle 路径无法验证: ${error.message}`);
  }
  return resolved;
}

function inferAppPath(executablePath, applicationsRoot = "/Applications") {
  const root = path.resolve(applicationsRoot);
  const relative = path.relative(root, path.resolve(executablePath));
  const parts = relative.split(path.sep);
  if (parts.length >= 4 && /^[^/]+\.app$/.test(parts[0]) && parts[1] === "Contents") {
    return path.join(root, parts[0]);
  }
  return "";
}

module.exports = { assertStableAppPaths, inferAppPath };
