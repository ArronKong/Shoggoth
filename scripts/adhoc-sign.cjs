"use strict";
// electron-builder afterPack hook：无 Developer ID 时 builder 直接跳过签名，
// 产物只剩 Electron 二进制的 linker 签名（Identifier=Electron、Info.plist 不
// 绑定）。macOS usernoted 无法为这种 app 建立通知注册身份，ad-hoc 签名又会
// 因每次构建的 cdhash 改变而反复触发钥匙串授权。开发/本机交付时允许通过
// SHOGGOTH_CODESIGN_IDENTITY 指定一张固定本地证书；未指定时才退回 ad-hoc。
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function verifyPackagedSqlite(appPath) {
  const { extractFile } = require("@electron/asar");
  const resources = path.join(appPath, "Contents", "Resources");
  const archive = path.join(resources, "app.asar");
  // A native resource alone is not enough: stale node_modules can make builder
  // silently omit the JS loader even though package-lock declares the dependency.
  const required = [
    "better-sqlite3/package.json", "better-sqlite3/lib/index.js",
    "better-sqlite3/lib/database.js", "better-sqlite3/lib/sqlite-error.js",
  ];
  for (const file of required) {
    try { if (extractFile(archive, `node_modules/${file}`).length > 0) continue; }
    catch { /* Convert builder's optional-file warning into a release failure. */ }
    throw new Error(`SQLite runtime missing: node_modules/${file}; run npm ci --ignore-scripts before packaging`);
  }
  const metadata = JSON.parse(extractFile(archive, "node_modules/better-sqlite3/package.json"));
  const manifest = JSON.parse(fs.readFileSync(path.join(resources, "sqlite", "manifest.json")));
  if (metadata.version !== manifest.version) throw new Error("SQLite JS/native version mismatch");
  for (const file of ["sqlite/better_sqlite3.node", "legal/BETTER-SQLITE3-LICENSE.txt"]) {
    if (!fs.statSync(path.join(resources, file)).isFile()) throw new Error(`SQLite resource missing: ${file}`);
  }
}

function appendSigningScope(args, keychainPath) {
  if (!keychainPath) return;
  if (keychainPath.includes("\0")) {
    throw new TypeError("SHOGGOTH_CODESIGN_KEYCHAIN must not contain NUL");
  }
  if (!path.isAbsolute(keychainPath)) {
    throw new TypeError("SHOGGOTH_CODESIGN_KEYCHAIN must be an absolute path");
  }
  // 显式限定证书搜索范围，避免 codesign 回落到用户登录钥匙串并触发授权框。
  args.push("--keychain", keychainPath);
}

function buildCodesignArgs({ appPath, entitlementsPath, identity, keychainPath, timestamp = false }) {
  const args = [
    "--force",
    "--deep",
    "--options", "runtime",
    timestamp ? "--timestamp" : "--timestamp=none",
    "--entitlements", entitlementsPath,
  ];
  appendSigningScope(args, keychainPath);
  args.push("--sign", identity, appPath);
  return args;
}

function buildNestedCodesignArgs({ targetPath, identity, keychainPath, timestamp = false }) {
  const args = [
    "--force", "--options", "runtime", timestamp ? "--timestamp" : "--timestamp=none",
  ];
  appendSigningScope(args, keychainPath);
  args.push("--sign", identity, targetPath);
  return args;
}

function listNativeNodeModules(root) {
  if (!fs.existsSync(root)) return [];
  const output = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) visit(target);
      else if (stat.isFile() && target.endsWith(".node")) output.push(target);
    }
  };
  visit(root);
  return output.sort((left, right) => left.localeCompare(right));
}

function nestedHostOptionalDependencyPaths(appPath) {
  const nodeModules = path.join(
    appPath, "Contents", "Resources", "app.asar.unpacked", "node_modules",
  );
  return [
    path.join(nodeModules, "@trycua", "cua-driver", "node_modules"),
    path.join(nodeModules, "@ubjs", "node", "node_modules"),
  ];
}

const MACHO_MAGIC = new Set([
  "cafebabe", "bebafeca", "cafebabf", "bfbafeca",
  "feedface", "cefaedfe", "feedfacf", "cffaedfe",
]);
const PRESERVED_VENDOR_TEAMS = new Set(["2DC432GLL2", "YCK386LBJ7"]);

function isMachOFile(target) {
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) return false;
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const magic = Buffer.alloc(4);
    return fs.readSync(fd, magic, 0, magic.length, 0) === magic.length
      && MACHO_MAGIC.has(magic.toString("hex"));
  } finally {
    fs.closeSync(fd);
  }
}

function listMachOFiles(root) {
  const output = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) visit(target);
      else if (isMachOFile(target)) output.push(target);
    }
  };
  visit(root);
  return output.sort((left, right) => right.split(path.sep).length - left.split(path.sep).length
    || left.localeCompare(right));
}

function inspectCodeSignature(target) {
  const verified = spawnSync("codesign", ["--verify", "--strict", target], { encoding: "utf8" });
  if (verified.status !== 0) return { valid: false, teamId: null };
  const details = spawnSync("codesign", ["-d", "--verbose=4", target], { encoding: "utf8" });
  const teamId = /^TeamIdentifier=(.+)$/mu.exec(`${details.stdout || ""}\n${details.stderr || ""}`)?.[1] || null;
  return { valid: true, teamId };
}

function shouldSignMachO({ mode, valid, teamId }) {
  if (!valid) return true;
  if (mode !== "developer-id") return false;
  return !PRESERVED_VENDOR_TEAMS.has(teamId);
}

exports.default = function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  verifyPackagedSqlite(appPath);
  require("./prepare-native-terminal.cjs").verifyPackagedNativeTerminal(appPath);
  const entitlementsPath = path.resolve(__dirname, "..", "build", "entitlements.mac.plist");
  const identity = process.env.SHOGGOTH_CODESIGN_IDENTITY || "-";
  const keychainPath = process.env.SHOGGOTH_CODESIGN_KEYCHAIN || undefined;
  const mode = process.env.SHOGGOTH_CODESIGN_MODE || (identity === "-" ? "adhoc" : "local");
  if (!new Set(["adhoc", "local", "developer-id"]).has(mode)
    || (mode === "adhoc") !== (identity === "-")
    || (mode === "developer-id" && !keychainPath)) {
    throw new TypeError("SHOGGOTH_CODESIGN_MODE/IDENTITY/KEYCHAIN combination is invalid");
  }
  const timestamp = mode === "developer-id";
  // Electron 下载缓存可能把 com.apple.provenance 复制进 Framework；Ventura+
  // 的 codesign 会因此在子 Framework 上报 internal error。签名前只清理
  // 新产物的扩展属性，已安装 App 与用户文件不受影响。
  execFileSync("xattr", ["-cr", appPath], { stdio: "inherit" });
  // electron-builder 的 dependency collector 会把当前构建机的 optional package
  // 再嵌套到 SDK 包里，即使 npmRebuild=false；x64 包会因此优先解析 arm64 dylib。
  // 每个目标架构的顶层包已经由 verified FileSet 注入，所以这里只删除新产物里
  // 两个确定的 host-architecture shadow 目录。
  for (const target of nestedHostOptionalDependencyPaths(appPath)) {
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: false });
  }
  // arbitrary Resources 目录下的 native Node addons 不属于标准 bundle nesting，
  // --deep 不保证会重签。先逐个签这些 addons，保留 Codex/Cua 自带的第三方
  // Developer ID 可执行文件和 dylib，再签整个 App。
  for (const targetPath of listNativeNodeModules(path.join(
    appPath, "Contents", "Resources", "app.asar.unpacked", "node_modules",
  ))) {
    execFileSync("codesign", buildNestedCodesignArgs({
      targetPath, identity, keychainPath, timestamp,
    }), { stdio: "inherit" });
  }
  // App-level --deep verification can miss unsigned arbitrary dylibs in third-party bundles
  // (Electron x64 libEGL is a real example). Audit physical Mach-O files one by one. A
  // Developer ID release re-signs all Shoggoth/Electron code with its timestamped identity,
  // while retaining the pinned OpenAI and Cua vendor signatures.
  for (const targetPath of listMachOFiles(appPath)) {
    const signature = inspectCodeSignature(targetPath);
    if (!shouldSignMachO({ mode, ...signature })) continue;
    execFileSync("codesign", buildNestedCodesignArgs({
      targetPath, identity, keychainPath, timestamp,
    }), { stdio: "inherit" });
  }
  execFileSync("codesign", buildCodesignArgs({
    appPath,
    entitlementsPath,
    identity,
    keychainPath,
    timestamp,
  }), { stdio: "inherit" });
  console.log(`  • ${mode} signed  ${appPath}`);
};

exports.buildCodesignArgs = buildCodesignArgs;
exports.buildNestedCodesignArgs = buildNestedCodesignArgs;
exports.listNativeNodeModules = listNativeNodeModules;
exports.isMachOFile = isMachOFile;
exports.listMachOFiles = listMachOFiles;
exports.nestedHostOptionalDependencyPaths = nestedHostOptionalDependencyPaths;
exports.shouldSignMachO = shouldSignMachO;
exports.verifyPackagedSqlite = verifyPackagedSqlite;
