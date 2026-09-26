"use strict";

const fs = require("node:fs");
const path = require("node:path");

// node-pty 1.1.0 ships its macOS spawn helper without the executable bit.
// Fix our dependency/artifact before signing; never modify a signed app at runtime.
function prepareNativeTerminal(root = path.resolve(__dirname, "..", "node_modules", "node-pty")) {
  for (const arch of ["arm64", "x64"]) {
    const helper = path.join(root, "prebuilds", `darwin-${arch}`, "spawn-helper");
    const stat = fs.lstatSync(helper);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe node-pty spawn helper");
    fs.chmodSync(helper, 0o755);
  }
}

function verifyPackagedNativeTerminal(appPath) {
  const { extractFile } = require("@electron/asar");
  const resources = path.join(appPath, "Contents", "Resources");
  const archive = path.join(resources, "app.asar");
  for (const file of ["node-pty/lib/index.js", "node-pty/lib/unixTerminal.js",
    "node-pty/package.json", "@xterm/headless/package.json", "@xterm/headless/lib-headless/xterm-headless.js"]) {
    if (!extractFile(archive, `node_modules/${file}`).length) throw new Error(`Native terminal dependency missing: ${file}`);
  }
  const root = path.join(resources, "app.asar.unpacked", "node_modules", "node-pty");
  for (const arch of ["arm64", "x64"]) {
    const addon = path.join(root, "prebuilds", `darwin-${arch}`, "pty.node");
    if (!fs.statSync(addon).isFile()) throw new Error(`Native terminal addon missing: ${arch}`);
  }
  prepareNativeTerminal(root);
}

if (require.main === module) prepareNativeTerminal();
module.exports = { prepareNativeTerminal, verifyPackagedNativeTerminal };
