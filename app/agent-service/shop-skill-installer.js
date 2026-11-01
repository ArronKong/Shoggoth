"use strict";

const path = require("node:path");
const { createShopMcpClient, ENDPOINT, PROTOCOL } = require("./shop-mcp-client");
const { selectShopTools } = require("./shop-skill-runtime");
const { scanPackage } = require("./native-skill-store");
const { safeRelative, sha256 } = require("./official-skill-mcp-bridge");
const fail = () => { throw Object.assign(new Error("OFFICIAL_SKILL_INTEGRITY_FAILED"), { code: "OFFICIAL_SKILL_INTEGRITY_FAILED" }); };

async function prepareShopSkill({ provider, root, homeDir, serverId, signal, fetch, onStage, writePayload, adapterInstructions, adaptedDocumentation }) {
  const client = createShopMcpClient({ fetch }), options = { signal, anonymous: true }, files = [];
  onStage("download");
  const discovery = await client.rpc("server/discover", {}, options);
  if (!discovery.supportedVersions?.includes(PROTOCOL) || !discovery.capabilities?.extensions?.["io.modelcontextprotocol/skills"]) fail();
  const listed = await client.rpc("skills/list", {}, options);
  if (!Array.isArray(listed.skills) || listed.skills.length > 100 || !listed.skills.some(skill => skill.uri === "skill://shop/SKILL.md" && skill.frontmatter?.name === "shop")) fail();
  const { skill } = await client.rpc("skills/get", { uri: "skill://shop/SKILL.md" }, options);
  if (skill?.uri !== "skill://shop/SKILL.md" || skill.frontmatter?.name !== "shop" || !Array.isArray(skill.resources)
    || !skill.resources.length || skill.resources.length > 32 || !skill.resources.some(resource => resource.uri === skill.uri)
    || new Set(skill.resources.map(resource => resource.uri)).size !== skill.resources.length) fail();
  const inventory = await client.rpc("tools/list", {}, options);
  const tools = selectShopTools(inventory.tools), documents = [];
  for (const resource of skill.resources) {
    const relative = resource.uri?.startsWith("skill://shop/") ? resource.uri.slice("skill://shop/".length) : "";
    if (!safeRelative(relative) || !relative.endsWith(".md") || !/^sha256:[a-f0-9]{64}$/u.test(resource.digest || "")
      || !Number.isSafeInteger(resource.size) || resource.size < 1 || resource.size > 512 * 1024) fail();
    const result = await client.rpc("resources/read", { uri: resource.uri }, options);
    const content = result.contents?.find(item => item.uri === resource.uri);
    if (typeof content?.text !== "string") fail();
    const bytes = Buffer.from(content.text);
    if (bytes.length !== resource.size || `sha256:${sha256(bytes)}` !== resource.digest) fail();
    documents.push({ relative, bytes });
  }
  onStage("verify");
  const put = (relative, bytes) => { signal?.throwIfAborted(); files.push(writePayload(root, relative, bytes)); };
  const skillPath = "adapters/official-shop";
  put("shop-tools.json", Buffer.from(JSON.stringify({ source: ENDPOINT, protocol: PROTOCOL, tools })));
  put(`${skillPath}/SKILL.md`, Buffer.from(adapterInstructions(provider, serverId)));
  for (const { relative, bytes } of documents) {
    put(`vendor-docs/${relative}`, bytes);
    put(`${skillPath}/references/upstream/${relative}`, adaptedDocumentation(bytes));
  }
  put(`${skillPath}/skill.json`, Buffer.from(JSON.stringify({ schemaVersion: 1, id: "official-shop", name: "official-shop", version: provider.version,
    description: provider.description["zh-CN"], entry: "SKILL.md", requiredTools: ["mcp_server_list", "mcp_server_tools", "mcp_server_call"], requiredRuntimeCapabilities: ["mcp"], sourceCompatibility: ["shoggoth"] })));
  onStage("installSkills");
  const scan = scanPackage(path.join(root, skillPath));
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, providerId: "shop", version: provider.version,
    source: { endpoint: ENDPOINT, protocol: PROTOCOL, serverVersion: discovery._meta?.["io.modelcontextprotocol/serverInfo"]?.version || null, resources: skill.resources }, files }));
  files.push(writePayload(root, "payload-manifest.json", manifest));
  return { skills: [{ id: scan.manifest.id, version: scan.manifest.version, contentHash: scan.contentHash, sourcePath: path.join(root, skillPath) }], files,
    transport: { kind: "stdio-command", command: process.execPath, args: [path.join(__dirname, "official-skill-mcp-bridge.js"), "--provider", "shop", "--root", root, "--home", homeDir], cwd: root } };
}
module.exports = { prepareShopSkill };
