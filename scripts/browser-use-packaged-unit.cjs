"use strict";

// Physical ASAR resource loading; no real App installation or browser launch.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const asar = require("@electron/asar");

async function main() {
  const root = path.resolve(__dirname, "..");
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-browser-asar-")));
  try {
    const staging = path.join(temp, "source"), archive = path.join(temp, "app.asar");
    const sources = ["app/agent-service/playwright-mcp-client.js", "app/agent-service/browser-use-protocol.js"];
    const packages = ["@playwright/mcp", "playwright", "playwright-core"];
    for (const relative of [...sources, ...packages.map(name => `node_modules/${name}`)]) {
      fs.mkdirSync(path.dirname(path.join(staging, relative)), { recursive: true });
      fs.cpSync(path.join(root, relative), path.join(staging, relative), { recursive: true });
    }
    fs.writeFileSync(path.join(staging, "package.json"), JSON.stringify({ name: "browser-asar-fixture", version: "1.0.0" }));
    await asar.createPackageWithOptions(staging, archive, {
      unpackDir: "node_modules/{@playwright/mcp,playwright,playwright-core}",
    });
    for (const name of packages) assert.ok(fs.existsSync(`${archive}.unpacked/node_modules/${name}/package.json`));
    const check = path.join(temp, "check.cjs");
    fs.writeFileSync(check, `
      const assert=require("node:assert/strict");
      const loader=require(${JSON.stringify(path.join(archive, sources[0]))});
      const api=loader.loadPlaywrightMcp();
      assert.equal(api.version,"0.0.82");
      assert.equal(api.chromium.name(),"chromium");
      api.createConnection({browser:{isolated:false}},async()=>({})).then(async server=>{
        assert.equal(typeof server.connect,"function");
        await server.close();
        console.log(JSON.stringify({verified:true,engine:api.version,asarPhysicalResources:true,browserLaunched:false}));
      }).catch(error=>{console.error(error);process.exitCode=1});
    `);
    const result = spawnSync(require("electron"), [check], { encoding: "utf8", timeout: 20_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.match(result.stdout, /"verified":true/u);
    process.stdout.write(result.stdout);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
