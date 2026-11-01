"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const source = path.join(root, "resources/antigravity-mcp-timeout/harness-bootstrap.c");
const output = path.join(root, ".vendor/antigravity-mcp-timeout");
const target = path.join(output, "harness-bootstrap");
const manifestFile = path.join(output, "manifest.json");
const hash = data => crypto.createHash("sha256").update(data).digest("hex");
const args = process.argv.slice(2);
if (args.some(value => value !== "--check" && !/^--arch=(universal|arm64|x64)$/u.test(value))
  || args.filter(value => value.startsWith("--arch=")).length > 1)
  throw new Error("Usage: build-antigravity-mcp-timeout.cjs [--check] [--arch=universal|arm64|x64]");
if (process.platform !== "darwin") throw new Error("Antigravity MCP timeout bootstrap requires macOS");
const requested = args.find(value => value.startsWith("--arch="))?.slice(7) || "universal";
const architectures = requested === "universal" ? ["arm64", "x86_64"] : [requested === "x64" ? "x86_64" : requested];
const identity = { version: 1, minimumMacOS: "13.0", architectures,
  sourceSha256: hash(fs.readFileSync(source)), builderSha256: hash(fs.readFileSync(__filename)) };
let previous;
try { previous = JSON.parse(fs.readFileSync(manifestFile, "utf8")); } catch {}
const current = previous && Object.keys(identity).every(key => JSON.stringify(identity[key]) === JSON.stringify(previous[key]))
  && fs.existsSync(target) && !fs.lstatSync(target).isSymbolicLink() && fs.lstatSync(target).isFile()
  && hash(fs.readFileSync(target)) === previous.sha256;
if (current) console.log(`PASS Antigravity MCP timeout bootstrap is current (${architectures.join(", ")})`);
else {
  if (args.includes("--check")) throw new Error("Antigravity MCP timeout bootstrap is stale or missing");
  fs.mkdirSync(output, { recursive: true, mode: 0o755 });
  const compiler = execFileSync("/usr/bin/xcrun", ["--find", "clang"], { encoding: "utf8" }).trim();
  const sdk = execFileSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8" }).trim();
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    execFileSync(compiler, ["-isysroot", sdk, ...architectures.flatMap(arch => ["-arch", arch]), "-mmacosx-version-min=13.0", "-std=c11", "-Os",
      "-fstack-protector-strong", "-Wall", "-Wextra", "-Werror", source, "-o", temporary], { cwd: root, stdio: "inherit", timeout: 60000 });
    const actual = execFileSync("/usr/bin/lipo", ["-archs", temporary], { encoding: "utf8" }).trim().split(/\s+/u).sort();
    if (actual.join(",") !== [...architectures].sort().join(",") || hash(fs.readFileSync(source)) !== identity.sourceSha256)
      throw new Error("Antigravity MCP timeout bootstrap build identity changed");
    fs.chmodSync(temporary, 0o755); fs.renameSync(temporary, target);
    fs.writeFileSync(manifestFile, JSON.stringify({ ...identity, sha256: hash(fs.readFileSync(target)) }, null, 2) + "\n");
    console.log(`PASS built Antigravity MCP timeout bootstrap (${architectures.join(", ")})`);
  } finally { fs.rmSync(temporary, { force: true }); }
}
