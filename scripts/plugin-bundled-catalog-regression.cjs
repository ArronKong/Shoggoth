"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { BundledPluginCatalog, bundledRoot } = require("../app/core/bundled-plugin-catalog");
const { startStaticServer } = require("../app/static-server");
const { createFixture } = require("./plugin-real-host-service-fixture.cjs");

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-cat-")));
  const fixture = createFixture(root, "openclaw");
  const expected = new BundledPluginCatalog(bundledRoot()).list();
  let service, web;
  try {
    service = await fixture.start();
    const backend = new ShoggothBackend({ paths: fixture.paths });
    const before = service.pluginStore.listInstallations();
    const result = await backend.listBundledPlugins();
    assert.deepEqual(result.items.map(item => item.id), expected.items.map(item => item.id));
    assert.equal(result.batchDigest, expected.batchDigest);
    assert(result.items.every(item => item.installationState === "not-installed"
      && item.installedReleaseDigest === null));
    const gmail = result.items.find(item => item.id === "gmail");
    if (expected.items.some(item => item.id === "gmail")) {
      assert.equal(gmail.localAdapter, "shoggoth-gogcli-gmail-mcp");
    }

    web = await startStaticServer(0, { homeDir: path.join(root, "web"),
      userDataRoot: path.join(root, "web"), registry: { backends: new Map([["shoggoth", backend]]) } });
    const response = await fetch(`${web.url}/__api/plugins/bundled`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), result);

    // Keep the package-to-adapter association strict. Accepting arbitrary
    // adapter strings would conceal compatibility bugs and mislabel cards.
    const base = gmail || { id: "gmail", installationId: "a".repeat(64), displayName: "Gmail",
      shortDescription: "Fixture", category: "Communication", version: "1.0.0", iconAvailable: false,
      components: { skills: 1, allSkillFiles: 1, apps: 0, mcp: 1 }, converted: { skills: 1, mcp: 1 },
      unconvertedMcp: [], importStatus: "previewable", installationState: "not-installed",
      installedReleaseDigest: null, localAdapter: "shoggoth-gogcli-gmail-mcp" };
    let reply = { batchDigest: result.batchDigest, items: [{ ...base,
      installationState: "enabled", installedReleaseDigest: "b".repeat(64) }] };
    const contract = new ShoggothBackend({ readToken: () => "fixture-catalog-token",
      requestService: async (_paths, request) => {
        assert.equal(request.method, "plugins.bundled.list");
        return structuredClone(reply);
      } });
    const enabled = await contract.listBundledPlugins();
    assert.equal(enabled.items[0].installationState, "enabled");
    assert.equal(enabled.items[0].installedReleaseDigest, "b".repeat(64));
    for (const patch of [{ localAdapter: "unknown-adapter" }, { id: "another-package" },
      { localAdapter: "shoggoth-slack-official-mcp" }]) {
      reply.items = [{ ...base, ...patch }];
      await assert.rejects(contract.listBundledPlugins(), error => error.code === "PLUGIN_RESPONSE_INVALID");
    }
    assert.deepEqual(service.pluginStore.listInstallations(), before,
      "Reading the library must not install plugins or configure accounts");
    if (process.env.SHOGGOTH_TEST_BUNDLED_CATALOG) {
      fs.writeFileSync(process.env.SHOGGOTH_TEST_BUNDLED_CATALOG, JSON.stringify(result));
    }
    console.log(JSON.stringify({ verified: true, packages: result.items.length,
      transport: "Service socket → ShoggothBackend → HTTP", strictAdapterIdentity: true,
      installationsUnchanged: true }));
  } finally {
    if (web) await web.close();
    if (service) await service.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
