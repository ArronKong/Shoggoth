"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { createOfficialSkillRuntime } = require("../app/agent-service/official-skill-runtime");
const { prepareOfficialSkill } = require("../app/agent-service/official-skill-installer");
const { validatePayload } = require("../app/agent-service/official-skill-mcp-bridge");
const { ensurePrivateDirectoryTree } = require("../app/agent-service/security");
const { PROVIDERS } = require("../app/agent-service/official-skill-providers");
const dto = require("../app/core/official-skill-connector-dto");
const token = "baidu-map-private-fixture-token";
const coordinate = "40.050711,116.301352";
function fixture(t, options = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shg-baidu-unit-"))); fs.chmodSync(base, 0o700);
  const root = path.join(base, "state/runtime-bin/official-skills/baidu-maps", crypto.randomUUID()), home = path.join(root, "home");
  ensurePrivateDirectoryTree(home, base);
  let now = 1000, response = { status: 0, result: {} };
  const calls = [], runtimes = [];
  const make = (env = { BAIDU_MAP_AUTH_TOKEN: token }) => {
    const runtime = createOfficialSkillRuntime({ providerId: "baidu-maps", root, home, env, now: () => now,
      spawn() { throw Error("Baidu must not launch an upstream shell, CLI or browser"); },
      fetch: async (url, init) => { calls.push({ url, init }); if (response instanceof Error) throw response; return response instanceof Response ? response.clone() : Response.json(response); } });
    runtimes.push(runtime); return runtime;
  };
  t.after(async () => { for (const runtime of runtimes) await runtime.close(); fs.rmSync(base, { recursive: true, force: true }); });
  return { base, root, home, calls, runtime: make(options.env), make, respond: value => { response = value; }, advance: ms => { now += ms; } };
}

test("Baidu has only a Skill recommendation, the user-specified Agent Plan page and no built-in token", () => {
  const provider = PROVIDERS["baidu-maps"];
  assert.equal(provider.version, "1.0.9"); assert.equal(provider.accessUrl, "https://lbsyun.baidu.com/products/agentplan");
  assert.equal(provider.authentication, "api-key"); assert.deepEqual(provider.requiredFields, ["env:BAIDU_MAP_AUTH_TOKEN"]);
  assert.equal(provider.fields.length, 1); assert.equal(provider.fields[0].secret, true); assert.equal(provider.fields[0].default, undefined);
  assert.equal(require("../app/agent-service/data/mcp-featured-presets.json").some(item => item.id === "baidu-maps"), false);
  assert.throws(() => dto.validateOfficialSkillParams("connector.official.account", { id: "baidu-maps", expectedRevision: 0, action: "start" }), { code: "OFFICIAL_SKILL_INVALID_ARGUMENT" });
});
test("the exact bundled ClawHub release installs without network or executing examples; altered installed material fails integrity", async t => {
  const f = fixture(t);
  const prepared = await prepareOfficialSkill({ providerId: "baidu-maps", root: f.root, homeDir: f.home, serverId: "official-baidu-maps-aabbccdd",
    signal: new AbortController().signal, fetch() { throw Error("No download is needed for the bundled verified Skill"); } });
  assert.equal(prepared.skills[0].id, "official-baidu-maps"); assert.equal(prepared.skills[0].version, "1.0.9");
  assert.equal(validatePayload("baidu-maps", f.root, f.home).source.version, "1.0.9");
  const content = fs.readFileSync(path.join(prepared.skills[0].sourcePath, "SKILL.md"), "utf8");
  assert.ok(content.includes("https://lbsyun.baidu.com/products/agentplan")); assert.ok(content.includes("GCJ-02"));
  assert.ok(content.includes("gptmodel_poi_clarify")); assert.ok(content.includes("never invent"));
  assert.ok(prepared.files.some(file => file.path === "vendor-docs/skill-card.md"));
  fs.appendFileSync(path.join(f.root, "vendor-docs/SKILL.md"), "\nchanged\n");
  assert.throws(() => validatePayload("baidu-maps", f.root, f.home), { code: "OFFICIAL_SKILL_INTEGRITY_FAILED" });
});
test("all five queries preserve actual response fields and original request parameters with credentials only in the header", async t => {
  const f = fixture(t, { env: { BAIDU_MAP_AUTH_TOKEN: ` ${token} `, UNRELATED_SECRET: "must-not-be-forwarded" } });
  const response = { status: 0, results: [{ uid: "original-uid", detail_info: { shop_hours: "09:00-19:00", poi_status: "不对外开放", photos: ["https://example.test/photo.jpg"] } }], tokenEcho: token, result: { forecasts: [{ date: "fixture-date" }] } };
  f.respond(response);
  for (const [name, args] of [["place", { user_raw_request: "帮我找附近3公里内、可带宠物的咖啡馆\n按距离排序", region: "北京市海淀区", center: coordinate, sort: "distance" }],
    ["direction", { user_raw_request: "从百度大厦驾车到颐和园，沿途买杯咖啡", location: coordinate, refer_pois: `百度大厦:uid-returned,${coordinate}` }],
    ["geocoding", { address: "北京市海淀区上地十街10号", region: "北京市" }], ["reverse_geocoding", { location: coordinate }], ["weather", { region: "北京市" }]]) {
    const result = await f.runtime.call(name, args), request = f.calls.at(-1), url = new URL(request.url);
    assert.equal(url.origin, "https://api.map.baidu.com"); assert.equal(url.pathname, `/agent_plan/v1/${name}`);
    assert.deepEqual(Object.fromEntries(url.searchParams), args); assert.equal(request.init.headers.Authorization, `Bearer ${token}`);
    assert.equal(request.init.method, "GET"); assert.equal(request.init.redirect, "error"); assert.ok(request.init.signal);
    assert.ok(!request.url.includes(token)); assert.ok(!JSON.stringify(result).includes(token)); assert.equal(result.tokenEcho, "[redacted]");
    assert.deepEqual(result.results, response.results); assert.deepEqual(result.result, response.result);
  }
  assert.equal(fs.readdirSync(f.home).length, 0, "HTTP reads never persist credentials or account files");
  assert.equal(f.runtime.tools.length, 7); assert.ok(f.runtime.tools.every(tool => tool.annotations.readOnlyHint));
  assert.ok(!f.runtime.tools.some(tool => ["account_start", "account_logout", "execute", "map_distance_matrix"].includes(tool.name)));
});
test("missing tokens, invalid coordinate order/range/precision and undeclared endpoints fail before dispatch", async t => {
  const f = fixture(t);
  for (const [name, args] of [["weather", {}], ["place", { user_raw_request: "最近的咖啡馆", region: "北京", sort: "distance" }],
    ["direction", { user_raw_request: "从A到B", location: coordinate, refer_pois: "A:uid,40.1,116.2" }],
    ["geocoding", { address: "北京", endpoint: "https://attacker.test" }], ["map_ip_location", { ip: "127.0.0.1" }]]) {
    await assert.rejects(f.runtime.call(name, args), { code: "OFFICIAL_SKILL_INVALID_ARGUMENT" });
  }
  for (const location of ["116.301352,40.050711", "91.000000,116.301352", "40.050711,181.000000", "40.05,116.30", "NaN,NaN", `${coordinate}\n`]) {
    await assert.rejects(f.runtime.call("reverse_geocoding", { location }), { code: "OFFICIAL_SKILL_INVALID_ARGUMENT" });
  }
  const unsigned = f.make({}); assert.equal((await unsigned.call("account_status", {})).state, "signedOut");
  await assert.rejects(unsigned.call("weather", { region: "北京" }), { code: "OFFICIAL_SKILL_AUTH_UNSUPPORTED" });
  const invalidToken = f.make({ BAIDU_MAP_AUTH_TOKEN: "private\nheader" });
  await assert.rejects(invalidToken.call("weather", { region: "北京" }), { code: "OFFICIAL_SKILL_AUTH_UNSUPPORTED" });
  assert.equal(f.calls.length, 0);
});
test("explicit service status performs one read; listing tools does not verify a token", async t => {
  const f = fixture(t); assert.equal(f.calls.length, 0);
  assert.equal((await f.runtime.call("account_status", {})).state, "ready");
  assert.equal(f.calls.length, 1); assert.equal(new URL(f.calls[0].url).pathname, "/agent_plan/v1/weather");
});
test("route clarification stays intact and cannot be rendered as a completed route", async t => {
  const f = fixture(t), args = { user_raw_request: "从百度大厦-B座驾车到颐和园北宫门", location: coordinate };
  const clarify = { status: 0, resource_key: "clarify-only", result: { answer_type: "gptmodel_poi_clarify", poi_clarify_data: { data: [{ info: { uid: "actual-uid", name: "百度大厦-B座" }, location: { lat: 40.050711, lng: 116.301352 } }] } } };
  f.respond(clarify); assert.deepEqual(await f.runtime.call("direction", args), clarify);
  await assert.rejects(f.runtime.call("map_render", { resource_key: "clarify-only" }), { code: "OFFICIAL_SKILL_INVALID_ARGUMENT" });
  f.respond({ status: 0, resource_key: "completed-route", result: { answer_type: "gptmodel_navigate", routes: [{ distance: 1000 }] } });
  await f.runtime.call("direction", { ...args, refer_pois: `百度大厦-B座:actual-uid,${coordinate}` });
  assert.equal((await f.runtime.call("map_render", { resource_key: "completed-route" })).source, "direction");
  assert.equal(f.calls.length, 2, "rendering does not query the API or open a browser");
});
test("map links require this connection's recent genuine resource, encode the exact key, and expire", async t => {
  const f = fixture(t), key = "opaque/key?&extra=from-provider";
  f.respond({ status: 0, results: [{ uid: "poi" }], resource_key: key });
  await f.runtime.call("place", { user_raw_request: "找咖啡馆", region: "北京" });
  const link = await f.runtime.call("map_render", { resource_key: key }), url = new URL(link.url);
  assert.equal(url.origin, "https://lbs.baidu.com"); assert.equal(url.pathname, "/mapstatic/agentui_resource.html");
  assert.deepEqual([...url.searchParams], [["resource_key", key]]);
  await assert.rejects(f.make().call("map_render", { resource_key: key }), { code: "OFFICIAL_SKILL_INVALID_ARGUMENT" });
  f.advance(30 * 60_000); await assert.rejects(f.runtime.call("map_render", { resource_key: key }), { code: "OFFICIAL_SKILL_INVALID_ARGUMENT" });
});
for (const [label, response, code] of [["authentication refusal", new Response("denied", { status: 403 }), "OFFICIAL_SKILL_AUTH_FAILED"],
  ["rate limit", new Response("slow down", { status: 429 }), "OFFICIAL_SKILL_RATE_LIMITED"], ["redirect", new Response(null, { status: 302, headers: { location: "https://attacker.test" } }), "OFFICIAL_SKILL_UNAVAILABLE"],
  ["provider error", { status: 302, message: "private error" }, "OFFICIAL_SKILL_UNAVAILABLE"], ["invalid JSON", new Response("not-json"), "OFFICIAL_SKILL_UNAVAILABLE"],
  ["network failure", new Error("private network details"), "OFFICIAL_SKILL_UNAVAILABLE"], ["oversized response", new Response("{}", { headers: { "content-length": 5000000 } }), "OFFICIAL_SKILL_UNAVAILABLE"]]) {
  test(`${label} stops without retry or creating an account`, async t => {
    const f = fixture(t); f.respond(response); await assert.rejects(f.runtime.call("weather", { region: "北京" }), { code });
    assert.equal(f.calls.length, 1); assert.deepEqual(fs.readdirSync(f.home), []);
  });
}
test("cancellation before dispatch and closed runtimes never start a new request", async t => {
  const f = fixture(t), signal = AbortSignal.abort();
  await assert.rejects(f.runtime.call("weather", { region: "北京" }, { signal }), { name: "AbortError" });
  await f.runtime.close(); await assert.rejects(f.runtime.call("weather", { region: "北京" })); assert.equal(f.calls.length, 0);
});
