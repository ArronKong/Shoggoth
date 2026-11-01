"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { scanPackage } = require("../../app/agent-service/native-skill-store");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
async function prepareOfficialFixture({ providerId, root, homeDir, signal, onStage, serverId }) {
  signal.throwIfAborted();
  if (homeDir !== path.join(root, "home")) throw Error("Fixture must have an isolated private HOME");
  onStage("download");
  const adapter = path.join(root, "adapters", `official-${providerId}`);
  fs.mkdirSync(adapter, { recursive: true, mode: 0o700 });
  const text = `---\nname: official-${providerId}\ndescription: Official fixture ${providerId}\nversion: 1.0.0\nx-shoggoth:\n  requiredTools: [mcp_server_list, mcp_server_tools, mcp_server_call]\n  requiredRuntimeCapabilities: [mcp]\n---\nUse mcp_server_list, mcp_server_tools, mcp_server_call with serverId ${serverId}.\n`;
  fs.writeFileSync(path.join(adapter, "SKILL.md"), text, { mode: 0o600 });
  const payload = path.join(root, "payload.txt"); fs.writeFileSync(payload, "official fixture payload", { mode: 0o600 });
  onStage("verify");
  const skill = scanPackage(adapter);
  return {
    skills: [{ id: skill.manifest.id, version: skill.manifest.version, contentHash: skill.contentHash, sourcePath: adapter }],
    transport: { kind: "stdio-command", command: process.execPath,
      args: [path.resolve(__dirname, "../../app/agent-service/official-skill-mcp-bridge.js"), "--provider", providerId, "--root", root, "--home", homeDir], cwd: root },
    files: [{ path: "payload.txt", sha256: hash(fs.readFileSync(payload)) },
      { path: `adapters/official-${providerId}/SKILL.md`, sha256: hash(text) }],
  };
}
module.exports = { prepareOfficialFixture };
