"use strict";
const fs = require("node:fs"), path = require("node:path");
const { SERVICE_PROTOCOL_VERSION } = require("./agent-service/service-protocol-version");
const transports = { hermes: "transport.py", openclaw: "transport.mjs" };

function assertAdapterProtocol(backend, source) {
  const declaration = backend === "hermes" ? /^VERSION = (\d+)\b/mu : /^const VERSION = (\d+);/mu;
  if (!Object.hasOwn(transports, backend) || Number(declaration.exec(source)?.[1]) !== SERVICE_PROTOCOL_VERSION) {
    throw new Error(`Shoggoth ${backend} adapter Service protocol differs from ${SERVICE_PROTOCOL_VERSION}`);
  }
}

function adapterContractFiles() {
  const { MCP_PRODUCT_TOOL_DEFINITIONS } = require("./agent-service/mcp-product-tool-controller");
  const { MCP_SHARED_SKILL_DEFINITIONS } = require("./agent-service/mcp-connector-tools");
  const { GROUP_MCP_TOOL_DEFINITIONS } = require("./agent-service/group-mcp-tools");
  const tools = MCP_PRODUCT_TOOL_DEFINITIONS.filter(tool => tool.name.startsWith("mcp_server_"));
  const deviceTools = MCP_PRODUCT_TOOL_DEFINITIONS.filter(tool => /^apple_(?:calendar|reminders)_/u.test(tool.name));
  if (tools.length !== 10) throw new Error("MCP connector contract count changed");
  if (deviceTools.length !== 12) throw new Error("Apple device contract count changed");
  const contract = { schemaVersion: 1, serviceProtocolVersion: SERVICE_PROTOCOL_VERSION,
    sharedSkillTools: MCP_SHARED_SKILL_DEFINITIONS, tools, deviceTools };
  const pretty = value => `${JSON.stringify(value, null, 2)}\n`;
  const json = () => pretty(contract);
  const hermesDeclaration = /^MCP_CONTRACT = json.loads\(.*\)$/mu;
  const openClawVersion = /MCP_CONTRACT\.serviceProtocolVersion!==\d+/u;
  const openClawCount = /MCP_CONTRACT\.tools\.length!==\d+/u;
  return {
    "hermes/mcp-tools.json": json,
    "openclaw/mcp-tools.json": json,
    "hermes/__init__.py": source => {
      if (!hermesDeclaration.test(source)) throw new Error("missing inline MCP contract");
      return source.replace(hermesDeclaration, () => `MCP_CONTRACT = json.loads(${JSON.stringify(JSON.stringify(contract))})`);
    },
    "openclaw/index.mjs": source => {
      if (!openClawVersion.test(source) || !openClawCount.test(source)) throw new Error("missing MCP contract guard");
      return source.replace(openClawVersion, `MCP_CONTRACT.serviceProtocolVersion!==${SERVICE_PROTOCOL_VERSION}`)
        .replace(openClawCount, `MCP_CONTRACT.tools.length!==${tools.length}`);
    },
    "openclaw/openclaw.plugin.json": source => {
      const manifest = JSON.parse(source);
      manifest.contracts.tools = [...GROUP_MCP_TOOL_DEFINITIONS, ...tools, ...deviceTools, ...MCP_SHARED_SKILL_DEFINITIONS]
        .map(tool => tool.name);
      return pretty(manifest);
    },
  };
}

function syncAdapterContracts(root, { write = false } = {}) {
  const problems = [];
  for (const [relative, render] of Object.entries(adapterContractFiles())) {
    const file = path.join(root, relative);
    try {
      const source = fs.readFileSync(file, "utf8");
      const expected = render(source);
      if (source === expected) continue;
      if (write) fs.writeFileSync(file, expected);
      else problems.push(`${relative}: MCP connector contract stale`);
    } catch (error) { problems.push(`${relative}: ${error.message}`); }
  }
  return problems;
}

function checkAdapterProtocols(root) {
  const problems = [];
  for (const [backend, file] of Object.entries(transports)) {
    try { assertAdapterProtocol(backend, fs.readFileSync(path.join(root, backend, file), "utf8")); }
    catch (error) { problems.push(error.message); }
  }
  return [...problems, ...syncAdapterContracts(root)];
}
module.exports = { assertAdapterProtocol, checkAdapterProtocols, syncAdapterContracts };
