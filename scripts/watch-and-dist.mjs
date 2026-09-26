// 监听 app/ 与 scripts/ 变更后自动执行 electron-builder 打包。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const watchRoots = [path.join(root, "app"), path.join(root, "scripts")];
const ignore = new Set(["node_modules", "dist", ".git", ".artifacts"]);

let building = false;
let pending = false;
let debounceTimer = null;

function log(message) {
  console.log(`[watch:dist] ${message}`);
}

function shouldWatch(filePath) {
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith("..")) {
    return false;
  }
  const parts = relative.split(path.sep);
  return !parts.some((part) => ignore.has(part));
}

function runDist() {
  if (building) {
    pending = true;
    return;
  }
  building = true;
  log("检测到变更，开始打包…");
  const child = spawn("npm", ["run", "dist"], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => {
    building = false;
    if (code === 0) {
      log("打包完成。");
    } else {
      log(`打包失败，退出码 ${code ?? "unknown"}。`);
    }
    if (pending) {
      pending = false;
      scheduleBuild();
    }
  });
}

function scheduleBuild() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    runDist();
  }, 800);
}

function watchDir(dirPath) {
  fs.watch(dirPath, { recursive: true }, (_eventType, fileName) => {
    if (!fileName) {
      return;
    }
    const fullPath = path.join(dirPath, fileName);
    if (!shouldWatch(fullPath)) {
      return;
    }
    log(`变更: ${path.relative(root, fullPath)}`);
    scheduleBuild();
  });
  log(`监听 ${path.relative(root, dirPath)}/`);
}

log("启动自动打包监听（Ctrl+C 退出）");
watchRoots.forEach(watchDir);
runDist();
