"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createOfficialSkillRuntime } = require("../app/agent-service/official-skill-runtime");
const { prepareOfficialSkill } = require("../app/agent-service/official-skill-installer");
const { DEVICE_URL, TOKEN_URL, CLIENT_ID } = require("../app/agent-service/shop-skill-auth");
const upstream = require("./fixtures/shop-mcp.json");

const mcp = (call, data, isError = false) => Response.json({ jsonrpc: "2.0", id: call.body.id, result: { structuredContent: data, ...(isError ? { isError: true } : {}) } });
const checkout = () => ({ id: "gid://shopify/Checkout/test", status: "ready_for_complete", currency: "USD",
  line_items: [{ id: "line-a", item: { id: "gid://shopify/ProductVariant/1001", title: "Rain jacket", price: 8000 }, quantity: 1 }],
  totals: [{ type: "total", amount: 8500 }], continue_url: "https://merchant.example/checkout?exact=1",
  payment: { instruments: [{ id: "offered-instrument", type: "shop_pay", handler_id: "shop_pay", display: { last_digits: "4242" },
    credential: { type: "shop_token", token: "shop-private-payment-canary" }, extension: { preserved: true } }] } });

function privateHome(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shg-shop-unit-"))), home = path.join(root, "home");
  fs.chmodSync(root, 0o700); fs.mkdirSync(home, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return { root, home };
}
function fixture(t, handle, options = {}) {
  const { root, home } = privateHome(t), calls = [];
  fs.writeFileSync(path.join(root, "shop-tools.json"), JSON.stringify({ tools: upstream.tools.tools }), { mode: 0o600 });
  const fetch = async (url, settings) => {
    const body = String(url) === "https://mcp.shop.com/" ? JSON.parse(settings.body) : Object.fromEntries(new URLSearchParams(settings.body));
    const call = { url: String(url), settings, body, name: body.params?.name, args: body.params?.arguments }; calls.push(call);
    return handle(call);
  };
  const make = () => createOfficialSkillRuntime({ providerId: "shop", root, home, fetch,
    spawn: () => { throw new Error("Shop must not launch a CLI"); }, env: { SHOP_ACCESS_TOKEN: "unrelated-token", OTHER_SECRET: "unrelated-secret" }, ...options });
  const runtime = make(); t.after(() => runtime.close());
  return { runtime, root, home, calls, make };
}

test("Shop directly calls its fixed MCP endpoint with official schemas, protocol metadata and exact filters", async t => {
  const f = fixture(t, call => mcp(call, { products: [{ title: "Rain jacket", url: "https://merchant.example/p?size=M&color=blue" }] }));
  const args = { catalog: { query: "rain jacket", context: { address_country: "CA", currency: "CAD" }, filters: { price: { max: 8000 } }, pagination: { limit: 2 } } };
  const result = await f.runtime.call("search_catalog", args);
  assert.equal(result.ok, true); assert.equal(result.data.products[0].url, "https://merchant.example/p?size=M&color=blue");
  const sent = f.calls[0]; assert.deepEqual(sent.args, args); assert.equal(sent.url, "https://mcp.shop.com/");
  assert.equal(sent.settings.redirect, "error"); assert.equal(sent.settings.headers.Authorization, undefined);
  assert.equal(sent.settings.headers["Mcp-Name"], "search_catalog");
  assert.equal(sent.body.params._meta["io.modelcontextprotocol/protocolVersion"], "2026-07-28");
  assert.equal(JSON.stringify(sent).includes("unrelated-token"), false);
  await assert.rejects(f.runtime.call("search_catalog", { ...args, endpoint: "https://attacker.invalid" }), { code: "OFFICIAL_SKILL_INVALID_ARGUMENT" });
  await assert.rejects(f.runtime.call("get_spend_request", { id: "any", include: "card" }), { code: "OFFICIAL_SKILL_INVALID_ARGUMENT" });
  await assert.rejects(f.runtime.call("complete_checkout", { confirmationId: "invented", instrumentId: "any", confirmed: true }), { code: "OFFICIAL_SKILL_INVALID_ARGUMENT" });
  await assert.rejects(f.runtime.call("search_orders", { orders: { filters: { date: { from: "2026-02-30" } } } }), { code: "OFFICIAL_SKILL_INVALID_ARGUMENT" });
  assert.equal(f.calls.length, 1);
  assert.equal(f.runtime.tools.find(tool => tool.name === "search_catalog").annotations.readOnlyHint, true);
  assert.equal(f.runtime.tools.find(tool => tool.name === "complete_checkout").annotations.readOnlyHint, false);
});

test("Shop preserves tool error state and HTTP 401 requests sign-in without retrying or authorizing", async t => {
  let unauthorized = false;
  const f = fixture(t, call => unauthorized ? Response.json({}, { status: 401 }) : mcp(call, { messages: [{ code: "unavailable", content: "No order data" }] }, true));
  const result = await f.runtime.call("search_orders", { orders: { filters: { status: "all" } } });
  assert.equal(result.ok, false); assert.equal(result.error.details.messages[0].content, "No order data");
  unauthorized = true;
  await assert.rejects(f.runtime.call("search_orders", { orders: {} }), { code: "OFFICIAL_SKILL_AUTH_REQUIRED" });
  assert.equal(f.calls.length, 2); assert.equal(f.calls.every(call => call.url === "https://mcp.shop.com/"), true);
});

test("Shop device authorization is explicit, rate-limited, private, restartable and verified by get_account", async t => {
  let timestamp = 0, approved = false;
  const f = fixture(t, call => {
    if (call.url === DEVICE_URL) return Response.json({ device_code: "device-private-canary", user_code: "ABC123", verification_uri_complete: "https://accounts.shop.app/device?user_code=ABC123", expires_in: 600, interval: 5 });
    if (call.url === TOKEN_URL) return approved ? Response.json({ access_token: "access-private-canary", token_type: "Bearer", expires_in: 3600 }) : Response.json({ error: "authorization_pending" }, { status: 400 });
    return mcp(call, { buyer: { email: "shopper@example.test" } });
  }, { now: () => timestamp });
  assert.equal((await f.runtime.call("account_status", {})).state, "signedOut"); assert.equal(f.calls.length, 0);
  const started = await f.runtime.call("account_start", {});
  assert.equal(started.state, "authorizing"); assert.equal(started.userCode, "ABC123");
  assert.equal(JSON.stringify(started).includes("device-private-canary"), false);
  assert.deepEqual(f.calls[0].body, { client_id: CLIENT_ID, resource: "https://mcp.shop.com", scope: "openid email personal_agent", device_name: "Shoggoth" });
  assert.equal(fs.statSync(path.join(f.home, "shop-account.json")).mode & 0o777, 0o600);
  assert.equal((await f.runtime.call("account_status", {})).state, "authorizing"); assert.equal(f.calls.length, 1);
  timestamp = 5000; assert.equal((await f.runtime.call("account_status", {})).state, "authorizing");
  const tokenRequest = f.calls.at(-1); assert.equal(tokenRequest.body.device_code, "device-private-canary"); assert.equal(tokenRequest.body.resource, undefined);
  const restarted = f.make(); t.after(() => restarted.close()); timestamp = 10000; approved = true;
  const ready = await restarted.call("account_status", {});
  assert.equal(ready.state, "ready"); assert.equal(ready.userName, "shopper@example.test");
  assert.equal(f.calls.at(-1).settings.headers.Authorization, "Bearer access-private-canary");
  assert.equal(JSON.stringify(ready).includes("access-private-canary"), false);
  assert.equal((await restarted.call("account_logout", {})).state, "signedOut");
  assert.equal(fs.existsSync(path.join(f.home, "shop-account.json")), false);
});

test("Shop rejects off-origin consent and never silently restarts expired or denied device authorization", async t => {
  let timestamp = 0, invalidUrl = true;
  const f = fixture(t, call => call.url === DEVICE_URL ? Response.json({ device_code: "private-device", user_code: "ABC123",
    verification_uri: invalidUrl ? "https://accounts.shop.app.attacker.invalid/device" : "https://accounts.shop.app/device", expires_in: 60, interval: 5 }) : Response.json({ error: "access_denied" }, { status: 400 }), { now: () => timestamp });
  await assert.rejects(f.runtime.call("account_start", {}), { code: "OFFICIAL_SKILL_AUTH_FAILED" });
  assert.equal(fs.existsSync(path.join(f.home, "shop-account.json")), false);
  invalidUrl = false; await f.runtime.call("account_start", {}); timestamp = 5000;
  assert.equal((await f.runtime.call("account_status", {})).state, "signedOut");
  const count = f.calls.length; await f.runtime.call("account_status", {}); assert.equal(f.calls.length, count);
  await f.runtime.call("account_start", {}); timestamp = 70000;
  assert.equal((await f.runtime.call("account_status", {})).state, "signedOut");
  assert.equal(f.calls.filter(call => call.url === DEVICE_URL).length, 3);
});

test("Shop completion uses the exact offered instrument privately and cannot repeat across restarts", async t => {
  const current = checkout();
  const f = fixture(t, call => mcp(call, call.name === "complete_checkout" ? { ...current, status: "completed", order: { id: "order-a" } } : current));
  const resource = { shop: "merchant.example", id: current.id }, preview = await f.runtime.call("get_checkout", resource);
  assert.ok(preview.data.confirmationId); assert.equal(JSON.stringify(preview).includes("shop-private-payment-canary"), false);
  const approval = { confirmationId: preview.data.confirmationId, instrumentId: "offered-instrument", confirmed: true };
  for (const invalid of [{ ...approval, confirmed: false }, { ...approval, instrumentId: "invented" }, { ...approval, credential: "invented" }])
    await assert.rejects(f.runtime.call("complete_checkout", invalid), { code: "OFFICIAL_SKILL_INVALID_ARGUMENT" });
  assert.equal(f.calls.length, 1);
  const completed = await f.runtime.call("complete_checkout", approval);
  assert.equal(completed.data.status, "completed"); assert.equal(completed.data.order.id, "order-a");
  assert.equal(JSON.stringify(completed).includes("shop-private-payment-canary"), false);
  assert.deepEqual(f.calls.find(call => call.name === "complete_checkout").args.checkout.payment.instruments, [{ ...current.payment.instruments[0], selected: true }]);
  const restarted = f.make(); t.after(() => restarted.close());
  const refreshed = await restarted.call("get_checkout", resource);
  await assert.rejects(restarted.call("complete_checkout", { ...approval, confirmationId: refreshed.data.confirmationId }), { code: "OFFICIAL_SKILL_OPERATION_UNCERTAIN" });
  assert.equal(f.calls.filter(call => call.name === "complete_checkout").length, 1);
  const ledger = fs.readFileSync(path.join(f.home, "operation-guards.json"), "utf8");
  assert.equal(ledger.includes("shop-private-payment-canary"), false); assert.equal(ledger.includes("merchant.example"), false);
});

test("changed totals and expired reviews stop Shop payment before dispatch", async t => {
  let current = checkout(), timestamp = 0;
  const f = fixture(t, call => mcp(call, current), { now: () => timestamp });
  const resource = { shop: "merchant.example", id: current.id }, first = await f.runtime.call("get_checkout", resource);
  current = { ...current, totals: [{ type: "total", amount: 9500 }] };
  await assert.rejects(f.runtime.call("complete_checkout", { confirmationId: first.data.confirmationId, instrumentId: "offered-instrument", confirmed: true }), { code: "OFFICIAL_SKILL_REVISION_CONFLICT" });
  const second = await f.runtime.call("get_checkout", resource); timestamp = 5 * 60_000 + 1;
  await assert.rejects(f.runtime.call("complete_checkout", { confirmationId: second.data.confirmationId, instrumentId: "offered-instrument", confirmed: true }), { code: "OFFICIAL_SKILL_INVALID_ARGUMENT" });
  assert.equal(f.calls.some(call => call.name === "complete_checkout"), false);
});

test("unknown payments stay blocked across restarts while read-only reconciliation remains available", async t => {
  const current = checkout();
  const f = fixture(t, call => { if (call.name === "complete_checkout") throw Error("Network interrupted"); return mcp(call, current); });
  const resource = { shop: "merchant.example", id: current.id }, preview = await f.runtime.call("get_checkout", resource);
  await assert.rejects(f.runtime.call("complete_checkout", { confirmationId: preview.data.confirmationId, instrumentId: "offered-instrument", confirmed: true }), { code: "OFFICIAL_SKILL_OPERATION_UNCERTAIN" });
  const restarted = f.make(); t.after(() => restarted.close());
  const refreshed = await restarted.call("get_checkout", resource); assert.equal(refreshed.ok, true);
  await assert.rejects(restarted.call("complete_checkout", { confirmationId: refreshed.data.confirmationId, instrumentId: "offered-instrument", confirmed: true }), { code: "OFFICIAL_SKILL_OPERATION_UNCERTAIN" });
  assert.equal(f.calls.filter(call => call.name === "complete_checkout").length, 1);
});

test("an HTTP 401 before dispatch does not poison the purchase ledger or trigger a retry", async t => {
  const current = checkout(); let refused = true, purchases = 0;
  const f = fixture(t, call => {
    if (call.name !== "complete_checkout") return mcp(call, current);
    if (refused) return Response.json({}, { status: 401 });
    purchases++; return mcp(call, { ...current, status: "completed", order: { id: "order-a" } });
  });
  const resource = { shop: "merchant.example", id: current.id }, first = await f.runtime.call("get_checkout", resource);
  await assert.rejects(f.runtime.call("complete_checkout", { confirmationId: first.data.confirmationId, instrumentId: "offered-instrument", confirmed: true }), { code: "OFFICIAL_SKILL_AUTH_REQUIRED" });
  assert.equal(f.calls.filter(call => call.name === "complete_checkout").length, 1); assert.equal(purchases, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, "operation-guards.json"))).operations, []);
  refused = false;
  const fresh = await f.runtime.call("get_checkout", resource);
  assert.equal((await f.runtime.call("complete_checkout", { confirmationId: fresh.data.confirmationId, instrumentId: "offered-instrument", confirmed: true })).data.status, "completed");
  assert.equal(purchases, 1);
});

test("Shop slow_down increases the persisted polling interval without restarting consent", async t => {
  let timestamp = 0;
  const f = fixture(t, call => call.url === DEVICE_URL
    ? Response.json({ device_code: "private-device", user_code: "ABC123", verification_uri: "https://accounts.shop.app/device", expires_in: 600, interval: 5 })
    : Response.json({ error: "slow_down" }, { status: 400 }), { now: () => timestamp });
  await f.runtime.call("account_start", {}); timestamp = 5000;
  await f.runtime.call("account_status", {}); assert.equal(f.calls.filter(call => call.url === TOKEN_URL).length, 1);
  const restarted = f.make(); t.after(() => restarted.close()); timestamp = 10000;
  await restarted.call("account_status", {}); assert.equal(f.calls.filter(call => call.url === TOKEN_URL).length, 1);
  timestamp = 15000; await restarted.call("account_status", {});
  assert.equal(f.calls.filter(call => call.url === TOKEN_URL).length, 2); assert.equal(f.calls.filter(call => call.url === DEVICE_URL).length, 1);
});

function metadataFetch({ tamper = false, calls = [] } = {}) {
  return async (url, options) => {
    assert.equal(String(url), "https://mcp.shop.com/");
    const request = JSON.parse(options.body); calls.push(request);
    let result = { "server/discover": upstream.discover, "skills/list": upstream.skillsList, "skills/get": upstream.skill,
      "resources/read": upstream.resources[request.params.uri], "tools/list": upstream.tools }[request.method];
    assert.ok(result, "installation reads only official skill and tools metadata");
    if (tamper && request.method === "resources/read") { result = structuredClone(result); result.contents[0].text += "tampered"; }
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  };
}
test("Shop installation verifies the MCP-published Skill resources and installs no CLI or executable", async t => {
  const { root, home } = privateHome(t), calls = [];
  const installed = await prepareOfficialSkill({ providerId: "shop", root, homeDir: home, serverId: "official-shop-test", signal: new AbortController().signal, fetch: metadataFetch({ calls }) });
  assert.equal(installed.skills.length, 1); assert.equal(installed.skills[0].id, "official-shop");
  assert.equal(installed.files.some(file => file.path.startsWith("runtime/")), false);
  assert.equal(installed.files.some(file => file.path === "shop-tools.json"), true);
  assert.equal(calls.some(call => call.method === "tools/call"), false);
  assert.equal(calls.some(call => call.method === "skills/get"), true);
  const runtime = createOfficialSkillRuntime({ providerId: "shop", root, home, fetch: metadataFetch() }); t.after(() => runtime.close());
  assert.equal(runtime.tools.length, 18); assert.equal(runtime.tools.some(tool => tool.name.includes("spend_request")), false);
});
test("Shop refuses a changed Skill resource instead of importing unverified instructions", async t => {
  const { root, home } = privateHome(t);
  await assert.rejects(prepareOfficialSkill({ providerId: "shop", root, homeDir: home, serverId: "official-shop-test", signal: new AbortController().signal, fetch: metadataFetch({ tamper: true }) }), { code: "OFFICIAL_SKILL_INTEGRITY_FAILED" });
  assert.equal(fs.existsSync(path.join(root, "adapters/official-shop/SKILL.md")), false);
});
