"use strict";
const fs = require("node:fs"), path = require("node:path");
const { startInspirationFixture } = require("./inspiration-service-fixture.cjs");
const { prepareFixture } = require("./lark-cli-fixture.cjs");
const { prepareLarkCli } = require("../../app/agent-service/lark-cli-installer");

async function start() {
  let attempts = 0;
  const f = await startInspirationFixture({ serviceOptions: { autoSparkNotes: false,
    larkCliOptions: { prepare: async input => {
      input.onStage("downloadCli");
      if (++attempts === 1) throw Object.assign(new Error("Controlled first-download failure"), { code: "LARK_CLI_DOWNLOAD_FAILED" });
      if (!process.env.LARK_CLI_ARCHIVE_CACHE) return prepareFixture(input);
      return prepareLarkCli({ ...input, downloadFile: async (url, destination) => {
        const name = url.includes("codeload.github.com") ? "source.zip" : "lark-cli.tar.gz";
        fs.copyFileSync(path.join(process.env.LARK_CLI_ARCHIVE_CACHE, name), destination);
      } });
    } }, setCronTimer: () => 1, clearCronTimer() {}, setProactiveTimer: () => 1, clearProactiveTimer() {} } });
  // Keep recommendations under an actual failed registry request.
  f.service.mcpConnectorController.registry.fetch = async () => { throw new Error("Controlled offline registry"); };
  const info = { url: `${f.url}/#/connectors`, root: f.root, disposable: true, realService: true,
    officialArchives: Boolean(process.env.LARK_CLI_ARCHIVE_CACHE), firstInstallFails: true };
  if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(info), { mode: 0o600 });
  console.log(JSON.stringify(info));
  const close = async () => { await f.close(); process.exit(0); };
  process.once("SIGINT", close); process.once("SIGTERM", close);
}
start().catch(error => { console.error(error); process.exitCode = 1; });
