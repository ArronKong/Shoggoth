#!/usr/bin/env node
"use strict";
const { spawnSync } = require("node:child_process");
const tempDirectory = require("node:fs").realpathSync(require("node:os").tmpdir());
const suites = ["official-skill-compatibility-unit.cjs", "flightaware-connector-unit.cjs", "flightaware-connector-ui-unit.mjs", "flightaware-connector-service-e2e.cjs", "ticketmaster-connector-unit.cjs", "ticketmaster-connector-ui-unit.mjs", "ticketmaster-connector-service-e2e.cjs", "mcp-connector-foundation-unit.cjs", "shoggoth-n8n-terminal-recovery-unit.cjs", "mcp-connector-runtime-unit.cjs", "mcp-device-oauth-unit.cjs", "mcp-http-fetch-unit.cjs", "mcp-connector-controller-unit.cjs",
  "mcp-remote-access-denied-unit.cjs", "mcp-connector-product-tools-unit.cjs", "mcp-connection-request-ui-unit.cjs", "mcp-open-connector-retirement-unit.cjs", "mcp-connector-source-retirement-unit.cjs", "mcp-connector-adapters-unit.mjs",
  "plugin-external-openclaw-tool-policy-unit.cjs", "plugin-external-adapter-registrar-unit.cjs", "hermes-shared-adapter-sync-unit.cjs",
  "mcp-connector-session-owner-unit.cjs", "mcp-connection-federation-unit.cjs", "mcp-connection-ack-restore-unit.cjs", "mcp-connector-service-smoke.cjs", "mcp-connector-agent-lanes-e2e.cjs", "mcp-connector-authority-backup-e2e.cjs", "mcp-connection-request-service-e2e.cjs", "mcp-registry-classes-unit.cjs", "shoggoth-packaged-smoke-options-unit.cjs", "mcp-connector-group-request-service-e2e.cjs"];
for (const script of suites) {
  const result = spawnSync(process.execPath, [`${__dirname}/${script}`], { stdio: "inherit", env: { ...process.env, TMPDIR: tempDirectory } });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`MCP connector unit suites: ${suites.length}/${suites.length} passed`);
