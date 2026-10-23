"use strict";

// The bundled Figma declaration belongs to the remote Codex plugin. Shoggoth
// deliberately substitutes Figma Desktop's documented, credentialless local
// MCP endpoint only for these exact frozen source bytes.
const SOURCE_IDENTITY = "bundled:figma";
const COMPONENT_NAME = "figma";
const ENDPOINT = "http://127.0.0.1:3845/mcp";
const FROZEN_DECLARATION_DIGEST =
  "5ad3583f97d28e3dd065c38e024cef9eaf78f2b191930ead29021666ccc14466";

// Reviewed read tools available on Figma Desktop. Even local Code Connect
// writes stay out of this read/design-to-code integration.
const DESKTOP_TOOLS = new Set([
  "get_design_context", "get_metadata", "get_screenshot", "get_variable_defs",
  "get_motion_context", "get_figjam", "get_code_connect_map",
]);
const DESKTOP_SKILLS = new Set(["figma-design-to-code", "figma-implement-motion"]);

function isFigmaDesktopComponent({ installation, component } = {}) {
  return installation?.sourceIdentity === SOURCE_IDENTITY
    && component?.name === COMPONENT_NAME
    && component.transport === "streamable-http"
    && component.oauthResource === null
    && component.spec && Object.keys(component.spec).sort().join(",") === "type,url"
    && component.spec.type === "streamable-http"
    && component.spec.url === ENDPOINT;
}

function isFigmaDesktopTool(name) {
  return typeof name === "string" && DESKTOP_TOOLS.has(name);
}

function isFigmaDesktopSkill(name) {
  return typeof name === "string" && DESKTOP_SKILLS.has(name);
}

module.exports = { SOURCE_IDENTITY, COMPONENT_NAME, ENDPOINT,
  FROZEN_DECLARATION_DIGEST, isFigmaDesktopComponent, isFigmaDesktopTool,
  isFigmaDesktopSkill };
