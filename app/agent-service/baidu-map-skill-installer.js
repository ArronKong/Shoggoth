"use strict";

const fs = require("node:fs"), path = require("node:path");
const { scanPackage } = require("./native-skill-store");
const { sha256 } = require("./official-skill-mcp-bridge");
const RELEASE = Object.freeze({ version: "1.0.9", source: "https://clawhub.ai/baidu-maps/skills/baidu-ai-map", repository: "https://github.com/baidu-maps/map-skills",
  files: Object.freeze({ "SKILL.md": "812c15d0eae73649eda5ad663abf1dab6f0ef4d9e1bc5c62aea63010811ce528",
    "skill-card.md": "665e5a97a818288e19e7e6f62baba2d8e8c418cea586ba94170f1ecbebbefe21", "_meta.json": "15dd801a4765f0f0a00f87572f139db5a1763a219a08b52161911a41dff0dc41" }) });

// Preserve the exact ClawHub release as data. Installation imports a managed
// workflow into the normal Skill store; upstream shell examples are not run.
async function prepareBaiduMapSkill({ provider, root, homeDir, serverId, signal, onStage, writePayload, adapterInstructions, adaptedDocumentation }) {
  const files = [], skillPath = "adapters/official-baidu-maps";
  const put = (relative, bytes) => { signal?.throwIfAborted(); files.push(writePayload(root, relative, bytes)); };
  onStage("verify");
  if (provider.version !== RELEASE.version) throw Object.assign(new Error("OFFICIAL_SKILL_INTEGRITY_FAILED"), { code: "OFFICIAL_SKILL_INTEGRITY_FAILED" });
  for (const [name, digest] of Object.entries(RELEASE.files)) {
    const bytes = fs.readFileSync(path.join(__dirname, "data", "baidu-ai-map-upstream", name));
    if (sha256(bytes) !== digest) throw Object.assign(new Error("OFFICIAL_SKILL_INTEGRITY_FAILED"), { code: "OFFICIAL_SKILL_INTEGRITY_FAILED" });
    put(`vendor-docs/${name}`, bytes);
    if (name.endsWith(".md")) put(`${skillPath}/references/upstream/${name}`, adaptedDocumentation(bytes));
  }
  put(`${skillPath}/SKILL.md`, Buffer.from(adapterInstructions(provider, serverId)));
  put(`${skillPath}/skill.json`, Buffer.from(JSON.stringify({ schemaVersion: 1, id: "official-baidu-maps", name: "official-baidu-maps", version: provider.version,
    description: provider.description.en, entry: "SKILL.md", requiredTools: ["mcp_server_list", "mcp_server_tools", "mcp_server_call"], requiredRuntimeCapabilities: ["mcp"], sourceCompatibility: ["shoggoth"] })));
  onStage("installSkills");
  const scan = scanPackage(path.join(root, skillPath));
  files.push(writePayload(root, "payload-manifest.json", Buffer.from(JSON.stringify({ schemaVersion: 1, providerId: provider.id, version: provider.version, source: RELEASE, files }))));
  return { skills: [{ id: scan.manifest.id, version: scan.manifest.version, contentHash: scan.contentHash, sourcePath: path.join(root, skillPath) }], files,
    transport: { kind: "stdio-command", command: process.execPath, args: [path.join(__dirname, "official-skill-mcp-bridge.js"), "--provider", provider.id, "--root", root, "--home", homeDir], cwd: root } };
}
module.exports = { RELEASE, prepareBaiduMapSkill };
