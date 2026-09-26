#!/usr/bin/env node
"use strict";
// Local, explicit administration. Changes take effect on Service restart.
const fs = require("node:fs"), crypto = require("node:crypto");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { RuntimeExtensionCatalog } = require("../app/agent-service/runtime-extension-manifest");
async function main(args) {
  const [action, ...values] = args, options = new Map();
  for (let i = 0; i < values.length; i += 2) {
    if (!values[i].startsWith("--") || !values[i + 1] || options.has(values[i])) throw new Error("Invalid arguments");
    options.set(values[i], values[i + 1]);
  }
  const permitted = ["--manifest", "--trusted-key", "--runtime", "--state-root", "--token-file", "--credential-ref"];
  if ([...options.keys()].some(key => !permitted.includes(key))) throw new Error("Unknown option");
  const paths = resolveServicePaths(options.has("--state-root") ? { stateRoot: options.get("--state-root") } : {});
  const catalog = new RuntimeExtensionCatalog(paths);
  if (action === "install") {
    const envelope = JSON.parse(fs.readFileSync(options.get("--manifest"), "utf8"));
    const key = fs.readFileSync(options.get("--trusted-key"), "utf8");
    const runtime = catalog.install(envelope, key);
    console.log(JSON.stringify({ runtime, installed: true, keyFingerprint: crypto.createHash("sha256").update(key).digest("hex"), restartRequired: true }));
  } else if (action === "list") console.log(JSON.stringify(catalog.read({ verifyEnabled: false }).map(entry => ({
    runtime: entry.envelope.manifest.runtime, enabled: entry.enabled, transport: entry.envelope.manifest.transport }))));
  else if (["enable", "disable", "uninstall"].includes(action)) {
    const runtime = options.get("--runtime"); if (!runtime) throw new Error("--runtime is required");
    if (action === "uninstall") catalog.uninstall(runtime); else catalog.setEnabled(runtime, action === "enable");
    console.log(JSON.stringify({ runtime, action, restartRequired: true }));
  } else if (action === "credential" || action === "diagnostics") {
    const { requestService, readClientToken } = require("../app/agent-service/client");
    const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
    const params = action === "credential" ? { credentialRef: options.get("--credential-ref"), token:
      require("../app/agent-service/private-file").readPrivateFile(options.get("--token-file"), { maxBytes: 4096 }).toString("utf8").trim() } : {};
    const result = await requestService(paths, { version: SERVICE_PROTOCOL_VERSION, token: readClientToken(paths),
      method: action === "credential" ? "runtime.extension.credential.set" : "runtime.observability.get", params }, { maxResponseBytes: 256 * 1024 });
    console.log(JSON.stringify(result));
  } else throw new Error("Use install/list/enable/disable/uninstall/credential/diagnostics");
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.code || "EXTENSION_ADMIN_FAILED"); process.exitCode = 1; });
module.exports = { main };
