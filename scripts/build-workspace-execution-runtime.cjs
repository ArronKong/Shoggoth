"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const source = path.join(root, "resources/workspace-execution/process-owner.c");
const output = path.join(root, ".vendor/workspace-execution");
const target = path.join(output, "process-owner");
const sha = data => crypto.createHash("sha256").update(data).digest("hex");
if (process.platform !== "darwin") throw new Error("Workspace execution requires macOS");
fs.mkdirSync(output, { recursive: true, mode: 0o755 });
const sourceSha256 = sha(fs.readFileSync(source));
const builderSha256 = sha(fs.readFileSync(__filename));
let old;
try { old = JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8")); } catch {}
if (old?.version === 1 && old.sourceSha256 === sourceSha256 && old.builderSha256 === builderSha256 && fs.existsSync(target)
  && sha(fs.readFileSync(target)) === old.sha256) {
  console.log("PASS workspace execution native helper is current");
} else {
  const compiler = execFileSync("/usr/bin/xcrun", ["--find", "clang"], { encoding: "utf8" }).trim();
  const sdk = execFileSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8" }).trim();
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    const args = ["-isysroot", sdk, "-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=13.0", "-std=c11", "-Os", "-Wall", "-Wextra", "-Werror",
      "-fstack-protector-strong", source, "-o", temporary, "-lproc", "-lsandbox"];
    execFileSync(compiler, args, { cwd: root, stdio: "inherit", timeout: 60000 });
    const architectures = execFileSync("/usr/bin/lipo", ["-archs", temporary], { encoding: "utf8" }).trim().split(/\s+/u).sort();
    if (architectures.join(",") !== "arm64,x86_64" || sha(fs.readFileSync(source)) !== sourceSha256) throw new Error("Workspace execution build identity changed");
    fs.chmodSync(temporary, 0o755); fs.renameSync(temporary, target);
    fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify({ version: 1, sourceSha256, builderSha256,
      sha256: sha(fs.readFileSync(target)), architectures }, null, 2) + "\n");
    console.log("PASS built universal workspace execution native helper");
  } finally { fs.rmSync(temporary, { force: true }); }
}
