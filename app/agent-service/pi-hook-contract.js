"use strict";
const fs = require("node:fs"), crypto = require("node:crypto");
const PI_HOOK_TITLE = "[[shoggoth-native-tool-hook-v1]]";
const PI_CALL_BINDING_TITLE = "[[shoggoth-runtime-call-binding-v1]]";
const PI_HOOK_VERSION = "0.84.4";
const PI_BUILTIN_TOOLS = Object.freeze(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const PI_MUTATING_TOOLS = new Set(["bash", "edit", "write"]);
const PI_HOOK_EXTENSION_MANIFEST = require("./pi-hook-extension-manifest.json");
const hashFile = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function piNativeHookCapabilities(host) {
  try {
    const version = Array.isArray(host?.cliVersion) ? host.cliVersion.join(".") : host?.cliVersion;
    if (host?.state !== "ready" || version !== PI_HOOK_VERSION || !host.extensionPath) return {};
    // The executed extension is an extraResource. electron-builder excludes
    // such source paths from ASAR even when files explicitly names them. Pin
    // its reviewed bytes in a manifest shipped with this Service code instead.
    if (PI_HOOK_EXTENSION_MANIFEST.schemaVersion !== 1
      || PI_HOOK_EXTENSION_MANIFEST.runtimeVersion !== PI_HOOK_VERSION
      || !/^[0-9a-f]{64}$/.test(PI_HOOK_EXTENSION_MANIFEST.extensionSha256)) return {};
    const expected = PI_HOOK_EXTENSION_MANIFEST.extensionSha256;
    const actual = hashFile(host.extensionPath);
    if (expected !== actual) return {};
    const proof = { status: "supported", owner: "runtime_bridge", evidence: "pi-tool-callback-v1",
      runtimeVersion: PI_HOOK_VERSION, extensionDigest: actual, toolNames: PI_BUILTIN_TOOLS };
    return { runtime_builtin: Object.fromEntries(["observe", "guard", "arguments", "action", "result"].map(kind => [kind, proof])) };
  } catch { return {}; }
}
module.exports = { PI_HOOK_TITLE, PI_CALL_BINDING_TITLE, PI_HOOK_VERSION, PI_BUILTIN_TOOLS,
  PI_MUTATING_TOOLS, piNativeHookCapabilities };
