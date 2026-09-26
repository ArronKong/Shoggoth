"use strict";

const HOST_CAPABILITIES = Object.freeze([
  { id: "system.application-search", owner: "agent-service", exposure: "agent-tool", tools: ["system_application_search"] },
  { id: "system.application-launch", owner: "agent-service", exposure: "agent-tool", tools: ["system_application_launch"] },
  { id: "system.open-url", owner: "agent-service", exposure: "agent-tool", tools: ["system_open_url"] },
  { id: "finder.open-folder", owner: "agent-service", exposure: "agent-tool", tools: ["finder_open_folder"] },
  { id: "ui.reveal-item", owner: "ui-process", exposure: "ui-only", hostOp: "reveal" },
  { id: "ui.open-workspace", owner: "ui-process", exposure: "ui-only", hostOp: "openPath" },
  { id: "ui.open-external-link", owner: "ui-process", exposure: "ui-only", hostOp: "openExternal" },
  { id: "ui.select-skill-package", owner: "ui-process", exposure: "ui-only", hostOp: "selectSkillPackage" },
  { id: "ui.select-plugin-package", owner: "ui-process", exposure: "ui-only", hostOp: "selectPluginPackage" },
  { id: "ui.select-plugin-dependency", owner: "ui-process", exposure: "ui-only", hostOp: "selectPluginDependency" },
  { id: "ui.confirm-plugin-capability", owner: "ui-process", exposure: "ui-only", hostOp: "confirmPluginCapability" },
  { id: "ui.open-plugin-app", owner: "ui-process", exposure: "ui-only", hostOp: "openPluginApp" },
  { id: "ui.provider-terminal", owner: "ui-process", exposure: "ui-only", hostOp: "runInTerminal" },
  { id: "ui.resolve-cli-version", owner: "ui-process", exposure: "ui-only", hostOp: "resolveCliVersion" },
]);

const ids = HOST_CAPABILITIES.map((item) => item.id);
const uiHostOps = HOST_CAPABILITIES.filter((item) => item.exposure === "ui-only")
  .map((item) => item.hostOp);
if (new Set(ids).size !== ids.length || new Set(uiHostOps).size !== uiHostOps.length
  || HOST_CAPABILITIES.some((item) => !["agent-tool", "ui-only"].includes(item.exposure)
    || (item.exposure === "agent-tool" ? !Array.isArray(item.tools) || item.tools.length === 0
      : typeof item.hostOp !== "string"))) {
  throw new Error("Host capability manifest 无效");
}

function assertUiHostOpsCoverage(hostOps) {
  if (!hostOps || typeof hostOps !== "object" || Array.isArray(hostOps)) {
    throw new TypeError("Electron hostOps 无效");
  }
  const actual = Object.keys(hostOps).sort();
  const expected = [...uiHostOps].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)
    || expected.some((name) => typeof hostOps[name] !== "function")) {
    throw new Error("Electron host capability 必须显式标记为 agent-tool 或 ui-only");
  }
  return true;
}

module.exports = { HOST_CAPABILITIES, assertUiHostOpsCoverage };
