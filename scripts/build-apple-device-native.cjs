"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "resources/apple-device/apple-device.mm");
const output = path.join(root, ".vendor/apple-device");
const target = path.join(output, "apple-device.node");
const manifestFile = path.join(output, "manifest.json");
const hash = data => crypto.createHash("sha256").update(data).digest("hex");
const argumentsList = process.argv.slice(2);
const requested = argumentsList.find(value => value.startsWith("--arch="))?.slice(7) || "universal";
if (argumentsList.some(value => value !== "--check" && !/^--arch=(universal|arm64|x64)$/u.test(value)))
  throw new Error("Usage: build-apple-device-native.cjs [--check] [--arch=universal|arm64|x64]");
const architectures = requested === "universal" ? ["arm64", "x86_64"] : [requested === "x64" ? "x86_64" : requested];
if (process.platform !== "darwin") throw new Error("Apple device native bridge requires macOS");
const candidates = [process.env.SHOGGOTH_NODE_HEADERS, path.resolve(path.dirname(process.execPath), "../include/node"),
  "/usr/local/include/node", "/opt/homebrew/include/node", path.join(process.env.HOME || "", ".cache/node-gyp", process.versions.node, "include/node"),
  path.join(process.env.HOME || "", "Library/Caches/node-gyp", process.versions.node, "include/node")].filter(Boolean);
const headers = candidates.find(candidate => fs.existsSync(path.join(candidate, "node_api.h")) && fs.existsSync(path.join(candidate, "js_native_api.h")));
if (!headers) throw new Error("Node N-API headers are missing. Set SHOGGOTH_NODE_HEADERS to a directory containing node_api.h.");
const identity = { version: 1, napiVersion: 8, minimumMacOS: "13.0", architectures,
  sourceSha256: hash(fs.readFileSync(source)), builderSha256: hash(fs.readFileSync(__filename)),
  headersSha256: hash(Buffer.concat(["node_api.h", "js_native_api.h", "js_native_api_types.h", "node_api_types.h"].map(name => fs.readFileSync(path.join(headers, name))))) };
let previous;
try { previous = JSON.parse(fs.readFileSync(manifestFile, "utf8")); } catch {}
const current = previous && Object.keys(identity).every(key => JSON.stringify(previous[key]) === JSON.stringify(identity[key])) &&
  fs.existsSync(target) && hash(fs.readFileSync(target)) === previous.sha256;
if (current) {
  console.log(`PASS Apple device native bridge is current (${architectures.join(", ")})`);
} else {
  if (argumentsList.includes("--check")) throw new Error("Apple device native bridge is stale or missing; run npm run build:apple-device-native.");
  fs.mkdirSync(output, { recursive: true, mode: 0o755 });
  const compiler = execFileSync("/usr/bin/xcrun", ["--find", "clang++"], { encoding: "utf8" }).trim();
  const sdk = execFileSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8" }).trim();
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    const args = ["-isysroot", sdk, ...architectures.flatMap(arch => ["-arch", arch]), "-mmacosx-version-min=13.0", "-std=c++17", "-Os",
      "-fobjc-arc", "-fblocks", "-fstack-protector-strong", "-Wall", "-Wextra", "-Werror", "-Wno-deprecated-declarations",
      "-DNAPI_VERSION=8", "-DNODE_GYP_MODULE_NAME=apple_device", "-I", headers, "-bundle", "-undefined", "dynamic_lookup",
      source, "-o", temporary, "-framework", "Foundation", "-framework", "EventKit"];
    execFileSync(compiler, args, { cwd: root, stdio: "inherit", timeout: 120000 });
    const actualArchitectures = execFileSync("/usr/bin/lipo", ["-archs", temporary], { encoding: "utf8" }).trim().split(/\s+/u).sort();
    if (actualArchitectures.join(",") !== [...architectures].sort().join(",") || hash(fs.readFileSync(source)) !== identity.sourceSha256)
      throw new Error("Apple device native build identity changed");
    fs.chmodSync(temporary, 0o755);
    fs.renameSync(temporary, target);
    fs.writeFileSync(manifestFile, JSON.stringify({ ...identity, sha256: hash(fs.readFileSync(target)) }, null, 2) + "\n");
    console.log(`PASS built Apple device native bridge (${architectures.join(", ")})`);
  } finally { fs.rmSync(temporary, { force: true }); }
}
