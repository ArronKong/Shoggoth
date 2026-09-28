#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const version = "1.22.0";
const integrity = "sha512-QaAqr7PFekrmEsmu1rpw7OxJYyG+iACjNHoNtQIVt9Oh7st8WDPIIUe6KhF9l35HVJTJd9CV1rePoPmKhSV26g==";
const expected = {
  arm64: { "onnxruntime_binding.node": "4a7e79b6f9a08aa031929416eedacaf1efc28063764470db0a2346802ffabff8",
    "libonnxruntime.1.22.0.dylib": "10b8fdb6c3541cf2c2d170264e0501f284658719e1441e0922c34e6e9b45cf7c" },
  x64: { "onnxruntime_binding.node": "f034facb39e7fcf5c04ba67bb87dd639762acde47eb7063550e61c4b4c4b087b",
    "libonnxruntime.1.22.0.dylib": "2e4bb2d31348265a9f416587972363a60851f577c3600f22cf92e00030c487fc" },
};
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json")));
const installed = JSON.parse(fs.readFileSync(path.join(root, "node_modules/onnxruntime-node/package.json")));
if (installed.version !== version || lock.packages["node_modules/onnxruntime-node"]?.integrity !== integrity) {
  throw new Error("E5_RUNTIME_LOCK_MISMATCH");
}
const architectures = {};
for (const [arch, files] of Object.entries(expected)) {
  const relative = `node_modules/onnxruntime-node/bin/napi-v6/darwin/${arch}`;
  const source = path.join(root, relative);
  const destination = path.join(root, ".vendor/embedding/node-modules", arch, relative);
  if (!check) fs.mkdirSync(destination, { recursive: true });
  architectures[arch] = [];
  for (const [name, sha256] of Object.entries(files)) {
    const original = path.join(source, name), target = path.join(destination, name);
    const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (hash(original) !== sha256) throw new Error("E5_RUNTIME_SOURCE_MISMATCH");
    const machine = execFileSync("/usr/bin/lipo", ["-archs", original], { encoding: "utf8" }).trim();
    if (machine !== (arch === "x64" ? "x86_64" : "arm64")) throw new Error("E5_RUNTIME_ARCH_MISMATCH");
    if (!check) fs.copyFileSync(original, target, fs.constants.COPYFILE_FICLONE);
    if (hash(target) !== sha256) throw new Error("E5_RUNTIME_COPY_MISMATCH");
    architectures[arch].push({ name, bytes: fs.statSync(target).size, sha256, machine });
  }
}
const manifest = { schemaVersion: 1, name: "onnxruntime-node", version, integrity,
  source: `https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-${version}.tgz`,
  note: "Hashes describe upstream pre-signing inputs; signed App binaries are checked by architecture, signature and real inference.",
  architectures };
const target = path.join(root, "build/e5-runtime-manifest.json");
const text = `${JSON.stringify(manifest, null, 2)}\n`;
if (check) {
  if (fs.readFileSync(target, "utf8") !== text) throw new Error("E5_RUNTIME_MANIFEST_MISMATCH");
} else fs.writeFileSync(target, text);
process.stdout.write("E5 CPU runtime verified for arm64 and x64.\n");
