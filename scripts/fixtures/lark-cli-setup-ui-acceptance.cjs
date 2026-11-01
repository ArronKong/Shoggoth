"use strict";
const fs = require("node:fs");
const { startInspirationFixture } = require("./inspiration-service-fixture.cjs");
const { prepareSetupFixture } = require("./lark-cli-setup-fixture.cjs");

(async () => {
  const f = await startInspirationFixture({ isolatedHome: true, serviceOptions: { autoSparkNotes: false,
    larkCliOptions: { prepare: input => prepareSetupFixture(input, { autoApproveAfterMs: 8000, qrBinary: process.env.LARK_CLI_QR_BINARY || null }) },
    setCronTimer: () => 1, clearCronTimer() {}, setProactiveTimer: () => 1, clearProactiveTimer() {} } });
  f.service.mcpConnectorController.registry.fetch = async () => { throw new Error("Controlled offline registry"); };
  const info = { url: `${f.url}/#/connectors`, root: f.root, isolatedHome: f.paths.homeDir === f.root,
    realServiceAndSubprocess: true, authorization: "controlled 8-second confirmation fixture", realAccountUsed: false };
  if (!info.isolatedHome) throw new Error("UI acceptance must isolate HOME");
  if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(info), { mode: 0o600 });
  console.log(JSON.stringify(info));
  const close = async () => { await f.close(); process.exit(0); };
  process.once("SIGTERM", close); process.once("SIGINT", close);
})().catch(error => { console.error(error); process.exitCode = 1; });
