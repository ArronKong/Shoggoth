"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
if (args.some(arg => arg !== "--check" && !/^--arch=(arm64|x64|universal)$/u.test(arg) && !arg.startsWith("--output="))) {
  throw new Error("Usage: build-secret-media.cjs [--check] [--arch=arm64|x64|universal] [--output=/absolute/path]");
}
if (process.platform !== "darwin") throw new Error("Local media recognition requires macOS");
const source = path.join(root, "resources/local-media/secret-media.swift");
const output = args.find(arg => arg.startsWith("--output="))?.slice(9) || path.join(root, ".vendor/local-media");
if (!path.isAbsolute(output)) throw new Error("Output must be absolute");
const arch = args.find(arg => arg.startsWith("--arch="))?.slice(7) || "universal";
const architectures = arch === "universal" ? ["arm64", "x86_64"] : [arch === "x64" ? "x86_64" : arch];
const hash = data => crypto.createHash("sha256").update(data).digest("hex");
const identity = { version: 1, minimumMacOS: "13.0", architectures,
  sourceSha256: hash(fs.readFileSync(source)), builderSha256: hash(fs.readFileSync(__filename)) };
const target = path.join(output, "shoggoth-secret-media"), manifest = path.join(output, "manifest.json");
let old; try { old = JSON.parse(fs.readFileSync(manifest)); } catch {}
if (old && Object.keys(identity).every(key => JSON.stringify(identity[key]) === JSON.stringify(old[key]))
  && fs.existsSync(target) && hash(fs.readFileSync(target)) === old.sha256) {
  console.log(`PASS local media helper current (${architectures.join(", ")})`); process.exit(0);
}
if (args.includes("--check")) throw new Error("Local media helper is stale or missing");
fs.mkdirSync(output, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-local-media-build-"));
try {
  const info = path.join(temp, "Info.plist");
  fs.writeFileSync(info, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.shoggoth.local-media</string><key>CFBundleName</key><string>Shoggoth Local Media</string><key>NSSpeechRecognitionUsageDescription</key><string>在本机将你选择的音视频转成文字，隐藏密码和密钥后再发给助理。原始音视频不会上传到语音服务。</string></dict></plist>`);
  const slices = architectures.map(architecture => {
    const slice = path.join(temp, architecture);
    execFileSync("/usr/bin/xcrun", ["swiftc", "-O", "-target", `${architecture}-apple-macosx13.0`,
      "-module-cache-path", path.join(temp, "modules"), source, "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", info,
      "-o", slice], { stdio: "inherit", timeout: 120000 });
    return slice;
  });
  const candidate = path.join(temp, "universal");
  execFileSync("/usr/bin/lipo", ["-create", ...slices, "-output", candidate]);
  if (hash(fs.readFileSync(source)) !== identity.sourceSha256) throw new Error("Media source changed during compilation");
  fs.copyFileSync(candidate, target); fs.chmodSync(target, 0o755);
  fs.writeFileSync(manifest, JSON.stringify({ ...identity, sha256: hash(fs.readFileSync(target)) }, null, 2) + "\n");
  console.log(`PASS local media helper built (${architectures.join(", ")})`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
