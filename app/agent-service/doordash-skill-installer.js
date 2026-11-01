"use strict";

const path = require("node:path");
const { scanPackage } = require("./native-skill-store");
const release = require("./data/doordash-cli-release.json");
const fail = code => { throw Object.assign(new Error(code), { code }); };

// Only the pinned public GitHub release and GitHub's release-asset CDN are
// followed. No credentials are attached and every byte is hash-verified.
async function fetchPublicRelease(fetch, url, init) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const parsed = new URL(current);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port
      || !["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(parsed.hostname)) fail("OFFICIAL_SKILL_DOWNLOAD_FAILED");
    const response = await fetch(current, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers?.get?.("location");
    await response.body?.cancel?.();
    if (!location) fail("OFFICIAL_SKILL_DOWNLOAD_FAILED");
    current = new URL(location, current).href;
  }
  fail("OFFICIAL_SKILL_DOWNLOAD_FAILED");
}

async function prepareDoorDashSkill({ provider, root, homeDir, serverId, signal, fetch, onStage, platform = process.platform, arch = process.arch,
  downloadPinned, readTar, writePayload, adapterInstructions, adaptedDocumentation }) {
  const archive = release.archives[`${platform}-${arch}`];
  if (!archive) fail("OFFICIAL_SKILL_PLATFORM_UNSUPPORTED");
  onStage("download");
  const bytes = await downloadPinned(archive, { signal, fetch: (url, init) => fetchPublicRelease(fetch, url, init) });
  onStage("verify");
  const entries = readTar(bytes), files = [], prefix = `${archive.root}/`, skillPath = "adapters/official-doordash";
  if (!entries[`${prefix}${archive.executable}`] || !entries[`${prefix}skills/dd-cli-usage/SKILL.md`]
    || !entries[`${prefix}LICENSE.txt`] || !entries[`${prefix}THIRD_PARTY_NOTICES.txt`]) fail("OFFICIAL_SKILL_INTEGRITY_FAILED");
  const put = (relative, value, executable = false) => { signal?.throwIfAborted(); files.push(writePayload(root, relative, value, executable)); };
  for (const [name, value] of Object.entries(entries)) {
    if (!name.startsWith(prefix)) fail("OFFICIAL_SKILL_INTEGRITY_FAILED");
    const relative = name.slice(prefix.length);
    if (relative === archive.executable) put("runtime/dd-cli", value, true);
    else if (relative.startsWith("_internal/")) put(`runtime/${relative}`, value);
    else if (["LICENSE.txt", "THIRD_PARTY_NOTICES.txt", "quickstart.txt", "skills/dd-cli-usage/SKILL.md"].includes(relative)) {
      put(`vendor-docs/${relative}`, value);
      if (relative === "skills/dd-cli-usage/SKILL.md") put(`${skillPath}/references/upstream/SKILL.md`, adaptedDocumentation(value));
    }
  }
  put(`${skillPath}/SKILL.md`, Buffer.from(adapterInstructions(provider, serverId)));
  put(`${skillPath}/skill.json`, Buffer.from(JSON.stringify({ schemaVersion: 1, id: "official-doordash", name: "official-doordash", version: provider.version,
    description: provider.description["zh-CN"], entry: "SKILL.md", requiredTools: ["mcp_server_list", "mcp_server_tools", "mcp_server_call"], requiredRuntimeCapabilities: ["mcp"], sourceCompatibility: ["shoggoth"] })));
  onStage("installSkills");
  const scan = scanPackage(path.join(root, skillPath));
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, providerId: "doordash", version: release.version, source: { url: archive.url, sha256: archive.sha256, platform, arch }, files }));
  files.push(writePayload(root, "payload-manifest.json", manifest));
  return { skills: [{ id: scan.manifest.id, version: scan.manifest.version, contentHash: scan.contentHash, sourcePath: path.join(root, skillPath) }], files,
    transport: { kind: "stdio-command", command: process.execPath, args: [path.join(__dirname, "official-skill-mcp-bridge.js"), "--provider", "doordash", "--root", root, "--home", homeDir], cwd: root } };
}
module.exports = { prepareDoorDashSkill, fetchPublicRelease };
