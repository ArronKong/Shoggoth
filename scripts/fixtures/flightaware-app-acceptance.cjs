"use strict";

const fs = require("node:fs"), path = require("node:path");
const { createConfigStore } = require("../../app/core/config-store");
const { McpRegistryClient } = require("../../app/agent-service/mcp-registry-client");
const { startInspirationFixture } = require("./inspiration-service-fixture.cjs");
const { createFlightawareFixture } = require("./flightaware-cli-fixture.cjs");

async function startFlightawareAcceptance() {
  const python = createFlightawareFixture();
  const configStore = createConfigStore(path.join(python.root, "config.json")); configStore.ensure(); configStore.write({ theme: "light", locale: "zh-CN" });
  let fixture;
  try {
    fixture = await startInspirationFixture({ isolatedHome: true, configStore,
      codexFakeEnv: { CODEX_FAKE_AUTOCOMPLETE_ALL: "1" }, serviceOptions: { parentEnv: python.env,
        mcpRegistryClient: new McpRegistryClient({ fetch: async () => Response.json({ servers: [], metadata: { count: 0 } }) }),
        autoSparkNotes: false, setCronTimer: () => 1, clearCronTimer() {}, setProactiveTimer: () => 1, clearProactiveTimer() {},
      } });
  } catch (error) { python.close(); throw error; }
  return { fixture, python, productUrl: `${fixture.url}/#/connectors`, configStore,
    async close() { try { await fixture.close(); } finally { python.close(); } } };
}

module.exports = { startFlightawareAcceptance };
if (require.main === module) {
  startFlightawareAcceptance().then(value => {
    // Only synthetic credentials are used by this disposable acceptance server.
    process.stdout.write(JSON.stringify({ productUrl: value.productUrl, fixtureRoot: value.fixture.root, pythonFixtureRoot: value.python.root, syntheticKey: "fixture-aeroapi-key" }) + "\n");
    for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => value.close().finally(() => process.exit(0)));
  }).catch(error => { process.stderr.write(`${error.code || error.message}\n`); process.exitCode = 1; });
}
