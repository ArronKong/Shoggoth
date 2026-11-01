"use strict";
// Isolated real installer/Skill store/controller/stdio bridge acceptance. A live
// token is accepted ONLY on stdin with --live, held in memory, never saved.
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { NativeSkillStore } = require("../app/agent-service/native-skill-store");
const { NativeMcpStore } = require("../app/agent-service/native-mcp-store");
const { NativeMcpClientManager } = require("../app/agent-service/native-mcp-client-manager");
const { McpConnectorController } = require("../app/agent-service/mcp-connector-controller");
const { OfficialSkillConnectorController } = require("../app/agent-service/official-skill-connector-controller");

async function main() {
  process.umask(0o077);
  const live = process.argv.includes("--live"), reportFlag = process.argv.indexOf("--report");
  assert.ok(process.argv.slice(2).every((arg, index, all) => arg === "--live" || arg === "--report" || all[index - 1] === "--report"));
  const reportPath = reportFlag < 0 ? null : path.resolve(process.argv[reportFlag + 1]);
  let token = live ? fs.readFileSync(0, "utf8").trim() : null;
  assert.ok(!live || /^[\x21-\x7e]{1,8192}$/u.test(token));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shg-baidu-acceptance-")));
  const paths = resolveServicePaths({ homeDir: root, trustedRoot: root, stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const skills = new NativeSkillStore({ paths }), store = new NativeMcpStore({ paths });
  const credentials = new Map(), reads = [], evidence = [];
  const secrets = { get: async id => { reads.push(id); return credentials.get(id) || null; }, remove: async id => credentials.delete(id) };
  const manager = new NativeMcpClientManager({ store, secrets, env: { ...process.env, HOME: root }, readinessTimeoutMs: 15000 });
  const mcp = new McpConnectorController({ paths, store, manager, secrets,
    getSubjects: async () => ({ items: [{ profileId: "profile-a", agentId: "profile-a", backendId: "shoggoth", label: "Isolated fixture", enabled: true }], unavailableBackends: [] }) });
  const controller = new OfficialSkillConnectorController({ paths, skillStore: skills, mcpController: mcp });
  const report = { source: "official baidu-ai-map 1.0.9", live, credentialPersisted: false, cases: evidence };
  try {
    skills.open(["profile-a"]); store.open(); manager.open(); mcp.open(); controller.open();
    const installed = await controller.handle("connector.official.install", { id: "baidu-maps", expectedRevision: 0 });
    assert.equal(installed.state, "installed"); assert.equal(installed.skillCount, 1);
    assert.equal(store.get(installed.serverId).status, "needsSetup");
    const skill = skills.listGlobalEnabled().find(value => value.id === "official-baidu-maps"); assert.ok(skill);
    assert.ok(fs.readdirSync(paths.skillPackagesDir).length > 0, "the managed Skill is imported into the normal package store");
    const tools = await manager.listTools(installed.serverId);
    assert.deepEqual(tools.map(tool => tool.name), ["account_status", "place", "direction", "geocoding", "reverse_geocoding", "weather", "map_render"]);
    const call = async (name, args) => {
      const response = await manager.callTool(installed.serverId, name, args);
      assert.ok(!response.isError); const value = JSON.parse(response.content[0].text);
      assert.ok(!token || !JSON.stringify(value).includes(token));
      evidence.push({ name, status: value.status ?? null, answerType: value.result?.answer_type || null,
        resultCount: Array.isArray(value.results) ? value.results.length : null, forecastCount: value.result?.forecasts?.length ?? null, hasMapResource: !!value.resource_key });
      return value;
    };
    assert.equal((await call("account_status", {})).state, "signedOut"); assert.equal(reads.length, 0);
    if (live) {
      credentials.set(`mcp-connector:${installed.serverId}`, { env: { BAIDU_MAP_AUTH_TOKEN: token } });
      store.update({ id: installed.serverId, expectedRevision: store.revision, patch: { secretRef: `mcp-connector:${installed.serverId}`,
        setup: { requiredFields: ["env:BAIDU_MAP_AUTH_TOKEN"], configuredFields: ["env:BAIDU_MAP_AUTH_TOKEN"] }, status: "checking", lastCheck: null } });
      const geocode = await call("geocoding", { address: "北京市海淀区上地十街10号百度大厦", region: "北京市" }); assert.equal(geocode.status, 0);
      const location = `${geocode.result.location.lat.toFixed(6)},${geocode.result.location.lng.toFixed(6)}`;
      assert.equal((await call("reverse_geocoding", { location })).status, 0);
      assert.equal((await call("weather", { region: "北京市海淀区" })).status, 0);
      const place = await call("place", { user_raw_request: "帮我找北京百度大厦附近3公里内的咖啡馆", region: "北京市海淀区", center: location, sort: "distance" });
      assert.equal(place.status, 0); assert.ok(place.results.length > 0); assert.ok(place.results.some(poi => poi.detail_info));
      const map = await call("map_render", { resource_key: place.resource_key }); assert.equal(new URL(map.url).hostname, "lbs.baidu.com");
      // The previous read-only probe returned this exact public POI and UID.
      // Include the selected name and fresh geocoding coordinates to exercise
      // the documented disambiguation path rather than replaying that query.
      const selected = geocode.poi_infos.find(poi => poi.name === "百度大厦-B座"); assert.ok(selected?.uid);
      const route = await call("direction", { user_raw_request: "帮我规划从北京市海淀区的百度大厦-B座驾车到颐和园北宫门的路线", location,
        refer_pois: `百度大厦-B座:${selected.uid},${selected.location.lat.toFixed(6)},${selected.location.lng.toFixed(6)}` });
      assert.equal(route.status, 0);
      if (route.result?.answer_type === "gptmodel_navigate") await call("map_render", { resource_key: route.resource_key });
      else assert.ok(["gptmodel_poi_clarify", "gptmodel_onway_search_clarify"].includes(route.result?.answer_type));
      report.routeCompleted = route.result?.answer_type === "gptmodel_navigate";
      report.routeClarification = report.routeCompleted ? null : route.result;
    }
    await manager.close(); credentials.clear();
    const scan = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) scan(file); else if (entry.isFile() && token) assert.ok(!fs.readFileSync(file).includes(Buffer.from(token)), "verification token must never be persisted");
    } };
    scan(root);
    await controller.handle("connector.official.remove", { id: "baidu-maps", expectedRevision: controller.status("baidu-maps").revision });
    assert.equal(store.get(installed.serverId), null); assert.ok(!skills.listGlobalEnabled().some(item => item.id === "official-baidu-maps"));
    report.installationRemoved = true; report.tools = tools.map(tool => tool.name); report.passed = true;
    if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify(report));
  } finally {
    token = null; credentials.clear(); await controller.close(); await manager.close(); await mcp.close(); store.close(); skills.close(); fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
