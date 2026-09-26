"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const filename = path.resolve(__dirname, "../app/manage-ui/src/pages/settings/ServiceSettings.tsx");
const uiRequire = Module.createRequire(path.resolve(__dirname, "../app/manage-ui/package.json"));
const React = uiRequire("react");
const { renderToStaticMarkup } = uiRequire("react-dom/server");
const compiled = uiRequire("esbuild").transformSync(fs.readFileSync(filename, "utf8"), {
  loader: "tsx", format: "cjs", jsx: "automatic",
}).code;
const component = new Module(filename);
component.filename = filename;
component.paths = Module._nodeModulePaths(path.dirname(filename));
const originalRequire = component.require.bind(component);
component.require = (name) => name === "react-i18next"
  ? { useTranslation: () => ({ t: (key) => key }) } : originalRequire(name);
component._compile(compiled, filename);
const ServiceSettings = component.exports.default;
for (const [pendingCommandsLocked, mcpCredentialsLocked] of [[false, false], [true, false], [false, true], [true, true]]) {
  const status = {
    service: { healthy: true, pendingCommandsLocked, mcpCredentialsLocked,
      serviceVersion: "0.8.127", domainAvailability: { kanban: true, cron: true } },
    background: { supported: true, installed: true, loaded: true, needsRepair: false },
  };
  const html = renderToStaticMarkup(React.createElement(ServiceSettings, {
    status, error: false, busy: null, onRetry() {}, onAction() {},
  }));
  const locked = pendingCommandsLocked;
  assert.equal(html.includes("is-healthy"), !locked);
  assert.ok(html.includes(`<h4>settings.${locked ? "serviceStopped" : "serviceRunning"}</h4>`));
  assert.equal(html.includes("settings.shoggothLocked"), locked);
}
console.log("Service Settings readiness: PASS (4 lock combinations)");
