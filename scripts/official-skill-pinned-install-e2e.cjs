"use strict";

// Explicit acceptance harness: the real pinned installer, stores, controller,
// launch guard and stdio MCP bridge run in one temporary private Service home.
// Original release archives may be supplied locally; only --allow-download
// permits missing public package downloads. --live-shop-search separately
// authorizes one anonymous catalog read. No account or purchase operation runs.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { NativeSkillStore } = require("../app/agent-service/native-skill-store");
const { NativeMcpStore } = require("../app/agent-service/native-mcp-store");
const { NativeMcpClientManager } = require("../app/agent-service/native-mcp-client-manager");
const { McpConnectorController } = require("../app/agent-service/mcp-connector-controller");
const { OfficialSkillConnectorController } = require("../app/agent-service/official-skill-connector-controller");
const { prepareOfficialSkill, RELEASES } = require("../app/agent-service/official-skill-installer");
const { OFFICIAL_SKILL_IDS } = require("../app/core/official-skill-connector-dto");
const { PROVIDERS } = require("../app/agent-service/official-skill-providers");
const { createMcpFetch } = require("../app/agent-service/mcp-http-fetch");
const { runDoorDashOfflineSmoke } = require("./doordash-cli-offline-smoke.cjs");

async function main() {
  process.umask(0o077);
  const args = process.argv.slice(2); let archiveDir = null, npmCache = null, allowDownload = false, liveShopSearch = false, liveQuarkAuthStart = false, doordashOfflineSmoke = false, ids = OFFICIAL_SKILL_IDS;
  while (args.length) {
    const arg = args.shift();
    if (arg === "--cache-dir" && args[0]) archiveDir = path.resolve(args.shift());
    else if (arg === "--npm-cache" && args[0]) npmCache = path.resolve(args.shift());
    else if (arg === "--allow-download") allowDownload = true;
    else if (arg === "--live-shop-search") liveShopSearch = true;
    else if (arg === "--live-quark-auth-start") liveQuarkAuthStart = true;
    else if (arg === "--doordash-offline-smoke") doordashOfflineSmoke = true;
    else if (arg === "--provider" && OFFICIAL_SKILL_IDS.includes(args[0])) ids = [args.shift()];
    else throw new Error("Use --cache-dir <original-archives>, --npm-cache <cache>, --provider <id>, --allow-download, --doordash-offline-smoke, --live-quark-auth-start and/or --live-shop-search");
  }
  assert.ok(archiveDir || allowDownload, "Supply pinned release archives or explicitly allow their public download");
  assert.ok(!liveShopSearch || ids.length === 1 && ids[0] === "shop", "Live shopping acceptance is limited to the Shop provider");
  assert.ok(!doordashOfflineSmoke || ids.length === 1 && ids[0] === "doordash", "The network-denied DoorDash smoke is an explicit separate selection");
  assert.ok(!liveQuarkAuthStart || ids.length === 1 && ids[0] === "quark-drive", "The unbound live Quark authorization start is an explicit separate selection");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shg-official-pinned-")));
  const paths = resolveServicePaths({ homeDir: root, trustedRoot: root, stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const skills = new NativeSkillStore({ paths }), store = new NativeMcpStore({ paths });
  const noCredentials = { get: async () => null, remove: async () => {} };
  const manager = new NativeMcpClientManager({ store, secrets: noCredentials, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root }, readinessTimeoutMs: 15000 });
  const mcp = new McpConnectorController({ store, manager, secrets: noCredentials, paths,
    getSubjects: async () => ({ items: [{ profileId: "profile-a", agentId: "profile-a", backendId: "shoggoth", label: "Isolated acceptance profile", enabled: true }], unavailableBackends: [] }) });
  const urlFiles = new Map();
  for (const [id, release] of Object.entries(RELEASES)) {
    if (!release.mcp && !release.native && !release.quark && !release.baidu) urlFiles.set(`https://codeload.github.com/${release.repo}/zip/${release.ref}`, `${id}-repository.zip`);
    if (release.runtime) urlFiles.set(release.runtime.url, { fliggy: "flyai-cli-1.0.16.tgz", alipay: "alipay-runtime-darwin-0.4.8.tgz" }[id]);
  }
  for (const archive of Object.values(require("../app/agent-service/data/doordash-cli-release.json").archives)) urlFiles.set(archive.url, path.basename(new URL(archive.url).pathname));
  const quarkRelease = require("../app/agent-service/quark-skill-installer").RELEASE;
  urlFiles.set(quarkRelease.url, `quarkclouddrive-${quarkRelease.version}.zip`);
  const dependencies = require("../app/agent-service/data/rollinggo-locked-js-dependencies.json");
  const downloads = [], originalArchives = [], npmArchives = [], network = createMcpFetch();
  const fetch = async (url, options) => {
    const shopFixture = archiveDir && path.join(archiveDir, "shop-mcp.json");
    if (String(url) === "https://mcp.shop.com/" && shopFixture && fs.existsSync(shopFixture)) {
      const fixture = JSON.parse(fs.readFileSync(shopFixture, "utf8")), request = JSON.parse(options.body);
      const result = { "server/discover": fixture.discover, "skills/list": fixture.skillsList, "skills/get": fixture.skill,
        "resources/read": fixture.resources[request.params.uri], "tools/list": fixture.tools }[request.method];
      assert.ok(result, "The fixture contains only public discovery, skills and tools metadata"); originalArchives.push("shop-mcp.json");
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    }
    const filename = urlFiles.get(String(url));
    const local = archiveDir && filename ? path.join(archiveDir, filename) : null;
    if (local && fs.existsSync(local)) {
      originalArchives.push(filename);
      return new Response(fs.readFileSync(local), { status: 200 });
    }
    const dependency = dependencies.find(item => item.url === String(url));
    if (npmCache && dependency) {
      const digest = Buffer.from(dependency.integrity.slice("sha512-".length), "base64").toString("hex");
      const cached = path.join(npmCache, "_cacache", "content-v2", "sha512", digest.slice(0, 2), digest.slice(2, 4), digest.slice(4));
      if (fs.existsSync(cached)) { npmArchives.push(`${dependency.name}@${dependency.version}`); return new Response(fs.readFileSync(cached), { status: 200 }); }
    }
    if (!allowDownload) throw new Error(`Missing original archive for ${String(url)}`);
    downloads.push(String(url)); return network(url, options);
  };
  const controller = new OfficialSkillConnectorController({ paths, skillStore: skills, mcpController: mcp,
    prepare: async options => {
      try { return await prepareOfficialSkill({ ...options, fetch }); }
      catch (error) { console.error(JSON.stringify({ stage: "prepare", provider: options.providerId, lastPublicDownload: downloads.at(-1) || null })); throw error; }
    } });
  const expectedBusiness = { doordash: "search_stores", shop: "search_catalog", "quark-drive": "search_files", "rollinggo-hotel": "search_hotels", "baidu-maps": "place", fliggy: "travel_search", weread: "bookshelf", "meituan-paotui": "delivery_preview", alipay: "submit_payment" };
  const receipts = [];
  try {
    skills.open(["profile-a"]); store.open(); manager.open(); mcp.open(); controller.open();
    for (const id of ids) {
      const installed = await controller.handle("connector.official.install", { id, expectedRevision: 0 });
      assert.equal(installed.state, "installed"); assert.equal(installed.skillCount, 1);
      const skill = skills.listGlobalEnabled().find(item => item.id === `official-${id}`);
      assert.ok(skill); assert.deepEqual(skill.requiredTools, ["mcp_server_list", "mcp_server_tools", "mcp_server_call"]);
      assert.deepEqual(skill.requiredRuntimeCapabilities, ["mcp"]);
      const registration = store.get(installed.serverId);
      assert.equal(registration.status, PROVIDERS[id].requiredFields.length ? "needsSetup" : "ready");
      // Required credentials gate business readiness, not the local protocol
      // handshake. Listing tools itself neither signs in nor invokes a CLI.
      const tools = await manager.listTools(installed.serverId);
      assert.ok(tools.some(tool => tool.name === expectedBusiness[id]));
      assert.ok(tools.some(tool => tool.name === "account_status"));
      assert.equal(new Set(tools.map(tool => tool.name)).size, tools.length);
      if (id === "quark-drive") {
        mcp.captureRun({ id: "quark-permission-run", profileId: "profile-a" });
        mcp.assertAvailable(installed.serverId, "profile-a", "quark-permission-run");
        await mcp.handle("connector.mcp.agents.set", { id: installed.serverId, disabledProfileIds: ["profile-a"], expectedRevision: store.revision });
        assert.throws(() => mcp.assertAvailable(installed.serverId, "profile-a", "quark-permission-run"), { code: "MCP_CONNECTOR_ACCESS_DENIED" });
        assert.ok(mcp.available("future-profile").some(server => server.id === installed.serverId));
        await mcp.handle("connector.mcp.agents.set", { id: installed.serverId, disabledProfileIds: [], expectedRevision: store.revision });
        assert.throws(() => mcp.assertAvailable(installed.serverId, "profile-a", "quark-permission-run"), { code: "MCP_CONNECTOR_ACCESS_DENIED" });
        mcp.captureRun({ id: "quark-next-run", profileId: "profile-a" });
        mcp.assertAvailable(installed.serverId, "profile-a", "quark-next-run");
        mcp.releaseRun("quark-permission-run"); mcp.releaseRun("quark-next-run");
        for (const name of ["upload_file", "download_file", "share_files", "move_files", "rename_files", "organize_photos"]) {
          assert.equal(tools.find(tool => tool.name === name).annotations.readOnlyHint, false);
        }
      }
      let liveAuthorizationStart = null;
      if (liveQuarkAuthStart) {
        const response = await manager.callTool(installed.serverId, "account_start", {});
        assert.equal(response.isError, undefined);
        const result = JSON.parse(response.content[0].text);
        assert.equal(result.state, "authorizing"); assert.equal(new URL(result.verificationUrl).origin, "https://pan.quark.cn");
        const authorizationUrl = new URL(result.verificationUrl);
        assert.equal(authorizationUrl.searchParams.get("agent_id"), "shoggoth"); assert.ok(authorizationUrl.searchParams.get("client_id"));
        assert.equal(authorizationUrl.searchParams.get("scope"), "clouddrive.base clouddrive.netdisk");
        liveAuthorizationStart = { state: result.state, origin: new URL(result.verificationUrl).origin, accountBound: false };
        const signedOut = await manager.callTool(installed.serverId, "account_logout", {});
        assert.equal(JSON.parse(signedOut.content[0].text).state, "signedOut");
      }
      const item = controller.records.get(id).installation;
      assert.ok(item.files.some(file => file.path === "payload-manifest.json"));
      assert.ok(item.files.some(file => file.path === `adapters/official-${id}/SKILL.md`));
      const accountFixture = id === "doordash" ? path.join(controller._root(id), "home", "preserved-account-fixture.json") : null;
      if (accountFixture) fs.writeFileSync(accountFixture, "isolated-private-fixture", { mode: 0o600 });
      if (id === "doordash") store.update({ id: installed.serverId, expectedRevision: store.revision, patch: { disabledProfileIds: ["profile-a"] } });
      const disabled = store.update({ id: installed.serverId, expectedRevision: store.revision, patch: { enabled: false, status: "disabled", lastCheck: null } });
      void disabled; await manager.closeServer(installed.serverId);
      assert.equal(controller.status(id).state, "installed"); assert.equal(store.get(installed.serverId).enabled, false);
      const repaired = await controller.handle("connector.official.install", { id, expectedRevision: installed.revision });
      assert.equal(repaired.serverId, installed.serverId); assert.equal(store.get(installed.serverId).enabled, true);
      if (accountFixture) { assert.equal(fs.readFileSync(accountFixture, "utf8"), "isolated-private-fixture"); assert.deepEqual(store.get(installed.serverId).disabledProfileIds, ["profile-a"]); }
      const count = item.files.length, runtimeRoot = controller._root(id);
      const cliSmoke = doordashOfflineSmoke ? await runDoorDashOfflineSmoke(runtimeRoot, path.join(runtimeRoot, "home")) : null;
      if (id === "shop") assert.equal(item.files.some(file => file.path.startsWith("runtime/")), false, "Shop uses its remote MCP, with no CLI payload");
      let liveSearch = null;
      if (liveShopSearch) {
        const response = await manager.callTool(installed.serverId, "search_catalog", { catalog: { query: "rain jacket", context: { address_country: "US", currency: "USD" }, pagination: { limit: 2 } } });
        assert.equal(response.isError, undefined);
        const result = JSON.parse(response.content[0].text);
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.ok(result.data.products?.length > 0, "The real anonymous catalog returns product results");
        liveSearch = { anonymous: true, productCount: result.data.products.length, titles: result.data.products.map(product => product.title) };
      }
      const removed = await controller.handle("connector.official.remove", { id, expectedRevision: repaired.revision });
      assert.equal(removed.state, "notInstalled"); assert.equal(store.get(installed.serverId), null);
      assert.equal(fs.existsSync(runtimeRoot), false); assert.equal(skills.listGlobalEnabled().some(entry => entry.id === `official-${id}`), false);
      receipts.push({ id, version: installed.installedVersion, pinnedFiles: count, tools: tools.map(tool => tool.name), install: true, handshake: true, explicitReconnect: true, removal: true, ...(cliSmoke ? { cliSmoke } : {}), ...(liveSearch ? { liveSearch } : {}), ...(liveAuthorizationStart ? { liveAuthorizationStart } : {}) });
      console.log(JSON.stringify({ provider: id, outcome: "PASS", pinnedFiles: count, tools: tools.length }));
    }
    console.log(JSON.stringify({ outcome: "PASS", originalArchives: [...new Set(originalArchives)], npmArchives: [...new Set(npmArchives)], publicDownloads: [...new Set(downloads)], receipts,
      realPrepareAndStoresAndBridge: true, realAccountAuthorization: false, businessCalls: liveShopSearch, purchases: false }));
  } finally {
    await controller.close(); await mcp.close(); await manager.close(); skills.close(); store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
