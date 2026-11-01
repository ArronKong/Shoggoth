"use strict";

// Contract fixtures follow the pinned CLI's published Skill and leaf --help.
// Every process and network boundary here is fake; no DoorDash account is used.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
const { createOfficialSkillRuntime } = require("../app/agent-service/official-skill-runtime");
const { prepareOfficialSkill } = require("../app/agent-service/official-skill-installer");
const { fetchPublicRelease } = require("../app/agent-service/doordash-skill-installer");
const { validateOfficialSkillParams, validOfficialVerificationUrl } = require("../app/core/official-skill-connector-dto");
const intent = "Order the user's requested lunch";
const privateToken = "isolated-doordash-token-canary";
const money = amount => ({ unit_amount: amount, currency: "USD", display_string: `$${(amount / 100).toFixed(2)}` });
const cart = () => ({ id: "cart-1", store_id: "101", store_name: "Fixture restaurant", items: [{ id: "line-1", item_id: "item-1", name: "Rice", quantity: 1 }], group_cart_url: null });
const quote = () => ({ quote: {
  store_order_cart: { fulfillment_type: "DELIVERY", orders: [{ order_items: [{ item: { name: "Rice" }, quantity: 1, unit_price_monetary_fields: money(1000) }] }] },
  net_total_before_tip: money(1400), line_items: [{ label: "Subtotal", final_money: money(1000) }, { label: "Fees and tax", final_money: money(400) }],
  is_pre_tippable: true, delivery_address: { printable_address: "100 Fixture Street" }, dropoff_options: [],
  delivery_availability: { delivery_options: [{ delivery_option_type: "PRIORITY" }] },
}, payment_method: { card_id: "card-1", display_name: "Visa ending in 0000" } });

function fixture(t, { signedIn = true, handler, env = {} } = {}) {
  const root = fs.mkdtempSync("/private/tmp/doordash-unit-"); fs.chmodSync(root, 0o700);
  const home = path.join(root, "home"); fs.mkdirSync(home, { mode: 0o700 });
  const f = { root, home, calls: [], runtimes: [], time: Date.now(), state: { cart: cart(), quote: quote(), carts: [], orders: [] } };
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); };
  f.saveToken = (expiresAt = f.time + 3600000) => write(path.join(home, "doordash-token.json"), { accessToken: privateToken, expiresAt });
  if (signedIn) f.saveToken();
  const spawn = (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.exitCode = null;
    const call = { command, args, options, input: "", key: args.slice(1, 3).join(" ") }; f.calls.push(call);
    child.stdin.on("data", bytes => { call.input += bytes; });
    const finish = (value, code = 0, error) => { child.exitCode = code; child.stdout.end(value === undefined ? "" : JSON.stringify(value)); child.stderr.end(error ? JSON.stringify({ error }) : ""); child.emit("close", code); };
    child.kill = () => { if (child.exitCode === null) queueMicrotask(() => finish(undefined, 143)); return true; };
    queueMicrotask(async () => {
      let response = await handler?.(call, f);
      if (!response && call.key === "export-token --start") {
        const saved = { code_verifier: "isolated-pkce-verifier", state: "isolated-state", redirect_uri: "http://localhost:4180/oauth2/callback", created_at: f.time / 1000 };
        write(path.join(home, ".config", "dd-cli", "pending-login.json"), saved);
        const url = new URL("https://identity.doordash.com/authorize");
        for (const [name, value] of Object.entries({ state: saved.state, redirect_uri: saved.redirect_uri, code_challenge_method: "S256", code_challenge: crypto.createHash("sha256").update(saved.code_verifier).digest("base64url") })) url.searchParams.set(name, value);
        response = { value: { authorization_url: url.href } };
      }
      if (!response && call.key === "export-token --finish") response = { value: { access_token: privateToken, expires_at: new Date(f.time + 3600000).toISOString() } };
      response ||= { value: ({ "address list": { addresses: [] }, "payment-method list": { payment_methods: [] }, "cart show": { cart: f.state.cart },
        "cart list": { carts: f.state.carts }, "order preview": f.state.quote, "order submit": { order_uuid: "order-1", status: "processing" },
        "order status": { order_uuid: "order-1", status: "placed" }, "order history": { orders: f.state.orders },
        "order checkout-url": { checkout_url: "https://www.doordash.com/checkout/cart-1" } })[call.key] || { success: true } };
      finish(response.value, response.code || 0, response.error);
    });
    return child;
  };
  f.make = () => { const runtime = createOfficialSkillRuntime({ providerId: "doordash", root, home, spawn, env, validate() {}, now: () => f.time }); f.runtimes.push(runtime); return runtime; };
  f.runtime = f.make();
  t.after(async () => { for (const runtime of f.runtimes) await runtime.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return f;
}
const args = (extra = {}) => ({ intent, ...extra });
const preview = f => f.runtime.call("preview_order", args({ cartId: "cart-1", tipCents: 200 }));

test("DoorDash exposes 20 fixed tools, requires authorization, and never adopts ambient credentials", async t => {
  const f = fixture(t, { signedIn: false, env: { DD_CLI_ACCESS_TOKEN: "ambient-secret", PYTHON_KEYRING_BACKEND: "unsafe", NODE_OPTIONS: "unsafe", OTHER_SECRET: "unsafe" } });
  assert.equal(f.runtime.tools.length, 20);
  assert.ok(f.runtime.tools.every(tool => tool.inputSchema.additionalProperties === false));
  assert.equal((await f.runtime.call("account_status", {})).state, "signedOut");
  await assert.rejects(f.runtime.call("search_stores", args({ query: "lunch" })), { code: "OFFICIAL_SKILL_DOORDASH_AUTH_REQUIRED" });
  assert.equal(f.calls.length, 0);
  f.saveToken();
  await f.runtime.call("search_stores", args({ query: "rice ; $(id)", addressId: "address-1", limit: 3, dashpassOnly: true, maxEtaMinutes: 30 }));
  const call = f.calls[0]; assert.equal(call.command, path.join(f.root, "runtime", "dd-cli"));
  assert.equal(call.options.shell, false); assert.equal(call.options.cwd, f.home); assert.equal(call.args[0], "--json-output");
  assert.equal(call.args[call.args.indexOf("--query") + 1], "rice ; $(id)");
  assert.equal(call.args[call.args.indexOf("--intent") + 1], `Summary: ${intent}\nuser prompt/purpose: ""`);
  assert.equal(call.options.env.HOME, f.home); assert.equal(call.options.env.DD_CLI_ACCESS_TOKEN, privateToken);
  assert.equal(call.options.env.PYTHON_KEYRING_BACKEND, "keyring.backends.null.Keyring");
  for (const key of ["NODE_OPTIONS", "OTHER_SECRET", "ELECTRON_RUN_AS_NODE", "PYTHONPATH"]) assert.equal(call.options.env[key], undefined);
  assert.ok(!JSON.stringify(call.args).includes(privateToken));
});

test("strict DoorDash schemas reject arbitrary commands, flags, nested extras and missing purchase consent before spawning", async t => {
  const f = fixture(t);
  for (const [name, input] of [["execute", args({ command: "id" })], ["search_stores", { query: "lunch" }], ["search_stores", args({ query: "lunch", endpoint: "https://example.invalid" })],
    ["get_cart", args({ cartId: "--help" })], ["delete_cart", args({ cartId: "cart-1" })], ["submit_order", args({ confirmationId: crypto.randomUUID() })],
    ["add_cart_items", args({ storeId: "101", menuId: "menu-1", items: [{ item_id: "item-1", item_name: "Rice", quantity: 1, nested_options: [{ id: "opt-1", name: "Side", quantity: 1, executable: "bad" }] }] })]])
    await assert.rejects(f.runtime.call(name, input), { code: "OFFICIAL_SKILL_INVALID_ARGUMENT" });
  assert.equal(f.calls.length, 0);
});

test("restaurant details use returned menu and option IDs, normalizing only the documented item lookup prefix", async t => {
  const f = fixture(t);
  await f.runtime.call("get_restaurant_item", args({ storeId: "101", menuId: "menu-1", itemId: "i_12345", addressId: "address-1" }));
  assert.deepEqual(f.calls[0].args.slice(0, -2), ["--json-output", "restaurant-item-details", "--store-id", "101", "--menu-id", "menu-1", "--item-id", "12345", "--address-id", "address-1"]);
});

test("PKCE authorization uses the official host and private callback stdin; no token reaches argv or account output", async t => {
  const f = fixture(t, { signedIn: false });
  const start = await f.runtime.call("account_start", {}); assert.equal(start.state, "authorizing");
  assert.equal(new URL(start.verificationUrl).hostname, "identity.doordash.com");
  assert.ok(!JSON.stringify(start).includes("isolated-pkce-verifier"));
  const before = f.calls.length;
  for (const code of ["http://localhost:4180/oauth2/callback?code=fixture-code&state=wrong", "https://attacker.invalid/oauth2/callback?code=fixture-code&state=isolated-state", "http://localhost:4180/oauth2/callback?code=fixture-code&state=isolated-state&state=another"])
    await assert.rejects(f.runtime.call("account_bind", { code }), { code: "OFFICIAL_SKILL_INVALID_ARGUMENT" });
  assert.equal(f.calls.length, before);
  const callback = "http://localhost:4180/oauth2/callback?code=fixture-code&state=isolated-state";
  const result = await f.runtime.call("account_bind", { code: callback }); assert.equal(result.state, "ready");
  const finish = f.calls.find(call => call.key === "export-token --finish");
  assert.deepEqual(finish.args, ["--json-output", "export-token", "--finish", "-"]); assert.equal(finish.input, callback);
  assert.ok(!JSON.stringify(result).includes(privateToken)); assert.ok(!JSON.stringify(f.calls.map(call => call.args)).includes("fixture-code"));
  const file = path.join(f.home, "doordash-token.json"); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(f.home, "doordash-authorization.json")), false);
  assert.equal((await f.runtime.call("account_logout", {})).state, "signedOut"); assert.equal(fs.existsSync(file), false);
});

test("authorization state, PKCE challenge and expiration are checked before exchanging credentials", async t => {
  const bad = fixture(t, { signedIn: false, handler(call, f) {
    if (call.key !== "export-token --start") return;
    const file = path.join(f.home, ".config", "dd-cli", "pending-login.json"); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ code_verifier: "fixture", state: "state", redirect_uri: "http://localhost:4180/oauth2/callback" }), { mode: 0o600 });
    return { value: { authorization_url: "https://identity.doordash.com/authorize?state=state&code_challenge=wrong&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A4180%2Foauth2%2Fcallback" } };
  } });
  await assert.rejects(bad.runtime.call("account_start", {}), { code: "OFFICIAL_SKILL_AUTH_FAILED" });
  const f = fixture(t, { signedIn: false }); await f.runtime.call("account_start", {}); f.time += 11 * 60000;
  assert.equal((await f.runtime.call("account_status", {})).state, "signedOut");
  await assert.rejects(f.runtime.call("account_bind", { code: "http://localhost:4180/oauth2/callback?code=fixture&state=isolated-state" }), { code: "OFFICIAL_SKILL_AUTH_FAILED" });
  assert.equal(f.calls.length, 1);
});

test("account cleanup cannot traverse a symlinked SDK directory and delete another application's private file", async t => {
  const f = fixture(t, { signedIn: false }), outside = path.join(f.root, "unrelated-config"), sdk = path.join(outside, "dd-cli");
  fs.mkdirSync(sdk, { recursive: true, mode: 0o700 }); const file = path.join(sdk, "pending-login.json"); fs.writeFileSync(file, "preserve", { mode: 0o600 });
  fs.symlinkSync(outside, path.join(f.home, ".config"));
  await assert.rejects(f.runtime.call("account_logout", {})); assert.equal(fs.readFileSync(file, "utf8"), "preserve"); assert.equal(f.calls.length, 0);
});

test("unapproved accounts remain unready and rate limits have no automatic retries; expired tokens cannot dispatch", async t => {
  const f = fixture(t, { handler(call) { if (call.key === "address list") return { code: 4, error: { code: "gated", message: "private provider detail" } }; return { code: 5, error: { code: "rate_limited" } }; } });
  const status = await f.runtime.call("account_status", {}); assert.equal(status.state, "unknown"); assert.equal(status.errorCode, "OFFICIAL_SKILL_APPROVAL_REQUIRED");
  await assert.rejects(f.runtime.call("search_stores", args({ query: "lunch" })), { code: "OFFICIAL_SKILL_RATE_LIMITED" }); assert.equal(f.calls.length, 2);
  f.time += 3600001; assert.equal((await f.runtime.call("account_status", {})).state, "signedOut");
  await assert.rejects(f.runtime.call("list_addresses", args()), { code: "OFFICIAL_SKILL_DOORDASH_AUTH_REQUIRED" }); assert.equal(f.calls.length, 2);
});

test("existing carts require an explicit choice and exact menu modifiers pass literally without automatic partial retries", async t => {
  const f = fixture(t, { handler(call) { if (call.key === "cart add-items") return { value: { success: false, item_errors: [{ item_id: "item-2", error: "unavailable" }] } }; } });
  f.state.carts = [{ cart_uuid: "cart-1", store_id: "101" }];
  const input = args({ storeId: "101", menuId: "menu-1", items: [{ item_id: "item-1", item_name: "Rice", quantity: 1, default_handling: "exact", nested_options: [{ id: "opt-1", name: "Side", quantity: 1 }] }] });
  assert.equal((await f.runtime.call("add_cart_items", input)).requiresCartChoice, true); assert.equal(f.calls.some(call => call.key === "cart add-items"), false);
  input.cartId = "cart-1";
  await assert.rejects(f.runtime.call("add_cart_items", input), { code: "OFFICIAL_SKILL_OPERATION_UNCERTAIN" });
  const call = f.calls.find(call => call.key === "cart add-items"); assert.deepEqual(JSON.parse(call.args[call.args.indexOf("--items-json") + 1]), input.items);
  await assert.rejects(f.runtime.call("add_cart_items", { ...input, intent: "Check the same requested cart" }), { code: "OFFICIAL_SKILL_OPERATION_UNCERTAIN" });
  assert.equal(f.calls.filter(call => call.key === "cart add-items").length, 1);
  assert.equal((await f.runtime.call("get_cart", args({ cartId: "cart-1" }))).cart.id, "cart-1");
});

test("a malformed add acknowledgement retains the fence, while a complete add permits the next explicit quantity change", async t => {
  for (const complete of [false, true]) {
    const f = fixture(t, { handler(call) { if (call.key === "cart add-items") return { value: complete ? { success: true, cart_uuid: "cart-1", cart: cart() } : { success: true } }; } });
    const input = args({ storeId: "101", menuId: "menu-1", cartId: "cart-1", items: [{ item_id: "item-1", item_name: "Rice", quantity: 1 }] });
    if (complete) { await f.runtime.call("add_cart_items", input); await f.runtime.call("add_cart_items", input); }
    else { await assert.rejects(f.runtime.call("add_cart_items", input), { code: "OFFICIAL_SKILL_OPERATION_UNCERTAIN" }); await assert.rejects(f.runtime.call("add_cart_items", input), { code: "OFFICIAL_SKILL_OPERATION_UNCERTAIN" }); }
    assert.equal(f.calls.filter(call => call.key === "cart add-items").length, complete ? 2 : 1);
  }
});

test("preview requires an explicit delivery tip, complete address and named card; unsupported checkout hands off without submission", async t => {
  const f = fixture(t);
  let result = await f.runtime.call("preview_order", args({ cartId: "cart-1" })); assert.equal(result.canSubmit, false); assert.equal(result.requiresTipChoice, true); assert.equal(result.confirmationId, null);
  result = await f.runtime.call("preview_order", args({ cartId: "cart-1", tipCents: 0 })); assert.equal(result.canSubmit, true); assert.equal(result.totalIncludingTip.unit_amount, 1400);
  for (const mutate of [value => { delete value.payment_method; }, value => { delete value.quote.delivery_address; }, value => { value.payment_split = { source: "work" }; }, value => { delete value.quote.net_total_before_tip.currency; }]) {
    f.state.quote = quote(); mutate(f.state.quote); result = await preview(f); assert.equal(result.canSubmit, false); assert.equal(result.confirmationId, null);
  }
  f.state.quote = quote(); f.state.quote.quote.expense_order_options = { all_eligible_expense_order_budgets: [{ id: "budget-1", remaining_amount: money(500) }] };
  result = await preview(f); assert.equal(result.canSubmit, false, 'eligible work benefits hand off without applying a budget or silently charging a personal card');
  f.state.quote = quote(); f.state.quote.quote.is_pre_tippable = false;
  result = await preview(f); assert.equal(result.canSubmit, false, 'cannot promise a prepaid tip when unsupported');
  f.state.quote = quote(); result = await f.runtime.call("preview_order", args({ cartId: "cart-1", tipCents: 200, scheduledTime: "2026-12-01T12:00:00Z" })); assert.equal(result.canSubmit, false);
  f.state.quote.quote.store_order_cart.fulfillment_type = "PICKUP";
  result = await f.runtime.call("preview_order", args({ cartId: "cart-1" })); assert.equal(result.canSubmit, true); assert.equal(result.totalIncludingTip.unit_amount, 1400);
  result = await preview(f); assert.equal(result.canSubmit, false, 'an unsupported merchant tip is never silently omitted from a pickup order');
  f.state.cart.group_cart_url = "https://www.doordash.com/group-cart/fixture"; await assert.rejects(preview(f), { code: "OFFICIAL_SKILL_PURCHASE_REVIEW_REQUIRED" });
  assert.equal(f.calls.some(call => call.key === "order submit"), false);
  assert.ok(f.calls.filter(call => call.key === "order preview").every(call => call.args.includes("--include-work-benefits")));
});

test("each reviewed price, address, item, card or PIN change requires a new confirmation", async t => {
  for (const mutate of [f => { f.state.quote.quote.net_total_before_tip = money(1500); }, f => { f.state.quote.quote.delivery_address.printable_address = "200 Fixture Street"; },
    f => { f.state.cart.items[0].quantity = 2; }, f => { f.state.quote.payment_method.card_id = "card-2"; }, f => { f.state.quote.quote.dropoff_options = [{ proof_of_delivery_type: "PIN_CODE" }]; }]) {
    const f = fixture(t), reviewed = await preview(f); mutate(f);
    await assert.rejects(f.runtime.call("submit_order", args({ confirmationId: reviewed.confirmationId, confirmed: true })), { code: "OFFICIAL_SKILL_PURCHASE_REVIEW_REQUIRED" });
    assert.equal(f.calls.some(call => call.key === "order submit"), false);
  }
});

test("PIN handoff requires separate consent; submit pins the reviewed tip and card, then queries status without claiming placement", async t => {
  const f = fixture(t); f.state.quote.quote.dropoff_options = [{ proof_of_delivery_type: "PIN_CODE" }];
  const reviewed = await preview(f); assert.equal(reviewed.pinHandoffRequired, true);
  await assert.rejects(f.runtime.call("submit_order", args({ confirmationId: reviewed.confirmationId, confirmed: true })), { code: "OFFICIAL_SKILL_PURCHASE_REVIEW_REQUIRED" });
  const result = await f.runtime.call("submit_order", args({ confirmationId: reviewed.confirmationId, confirmed: true, pinAccepted: true }));
  const call = f.calls.find(call => call.key === "order submit");
  assert.deepEqual(call.args.slice(0, -2), ["--json-output", "order", "submit", "--cart-uuid", "cart-1", "--tip-cents", "200", "--card-id", "card-1", "--yes"]);
  assert.equal(result.placementConfirmed, false); assert.equal(result.status, "processing");
  assert.equal((await f.runtime.call("order_status", args({ orderId: result.order_uuid }))).status, "placed");
  await assert.rejects(f.runtime.call("submit_order", args({ confirmationId: reviewed.confirmationId, confirmed: true, pinAccepted: true })), { code: "OFFICIAL_SKILL_PURCHASE_REVIEW_REQUIRED" });
});

test("successful and uncertain submissions cannot be repeated even after runtime restart, a new tip or intent", async t => {
  for (const unknown of [false, true]) {
    const f = fixture(t, { handler(call) { if (unknown && call.key === "order submit") return { code: 5, error: { code: "timeout" } }; } });
    let reviewed = await preview(f);
    const first = f.runtime.call("submit_order", args({ confirmationId: reviewed.confirmationId, confirmed: true }));
    if (unknown) await assert.rejects(first, { code: "OFFICIAL_SKILL_OPERATION_UNCERTAIN" }); else await first;
    await f.runtime.close(); f.runtime = f.make();
    reviewed = await f.runtime.call("preview_order", args({ cartId: "cart-1", tipCents: 300 }));
    await assert.rejects(f.runtime.call("submit_order", { intent: "Another purpose cannot bypass this cart's fence", confirmationId: reviewed.confirmationId, confirmed: true }), { code: "OFFICIAL_SKILL_OPERATION_UNCERTAIN" });
    assert.equal(f.calls.filter(call => call.key === "order submit").length, 1);
    const ledger = fs.readFileSync(path.join(f.home, "operation-guards.json"), "utf8"); assert.ok(!ledger.includes("cart-1")); assert.ok(!ledger.includes(privateToken));
    assert.equal((await f.runtime.call("order_status", args({ orderId: "order-1" }))).status, "placed");
  }
});

test("reviews expire and cart mutations invalidate them; reorders use returned history rather than a guessed merchant", async t => {
  const f = fixture(t); let reviewed = await preview(f); f.time += 5 * 60000 + 1;
  await assert.rejects(f.runtime.call("submit_order", args({ confirmationId: reviewed.confirmationId, confirmed: true })), { code: "OFFICIAL_SKILL_PURCHASE_REVIEW_REQUIRED" });
  reviewed = await preview(f); await f.runtime.call("remove_cart_item", args({ cartId: "cart-1", cartItemId: "line-1" }));
  await assert.rejects(f.runtime.call("submit_order", args({ confirmationId: reviewed.confirmationId, confirmed: true })), { code: "OFFICIAL_SKILL_PURCHASE_REVIEW_REQUIRED" });
  await assert.rejects(f.runtime.call("reorder", args({ orderId: "past-1", storeId: "101" })), { code: "OFFICIAL_SKILL_PURCHASE_REVIEW_REQUIRED" });
  f.state.orders = [{ order_uuid: "past-1", store_id: "101" }]; await f.runtime.call("order_history", args({ max: 5, days: 30 }));
  f.state.carts = [{ cart_uuid: "cart-1" }]; assert.equal((await f.runtime.call("reorder", args({ orderId: "past-1", storeId: "101" }))).requiresCartChoice, true);
  assert.equal(f.calls.some(call => call.key === "order reorder"), false);
});

test("DoorDash output strips guest and account tokens, including camel case keys and literal token echoes", async t => {
  const f = fixture(t, { handler() { return { value: { accessToken: privateToken, guest_token: "guest-canary", guestToken: "guest-canary", code_verifier: "verifier-canary", data: { name: `Restaurant ${privateToken}`, token: "secret" } } }; } });
  const result = await f.runtime.call("get_menu", args({ storeId: "101" }));
  assert.deepEqual(result, { data: { name: "Restaurant [redacted]" } });
});

test("the public DTO accepts only the official authorization host and bounded callback input", () => {
  assert.equal(validOfficialVerificationUrl("doordash", "https://identity.doordash.com/authorize"), true);
  for (const url of ["https://identity.doordash.com.attacker.invalid/authorize", "https://user:secret@identity.doordash.com/authorize", "http://identity.doordash.com/authorize"]) assert.equal(validOfficialVerificationUrl("doordash", url), false);
  assert.doesNotThrow(() => validateOfficialSkillParams("connector.official.account", { id: "doordash", expectedRevision: 0, action: "bind", code: "x".repeat(2000) }));
  assert.throws(() => validateOfficialSkillParams("connector.official.account", { id: "doordash", expectedRevision: 0, action: "bind", code: "x".repeat(8193) }));
});

test("unsupported platforms fail before fetching and pinned release corruption cannot install a native payload", async t => {
  const root = fs.mkdtempSync("/private/tmp/doordash-install-unit-"); fs.chmodSync(root, 0o700); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "home"), { mode: 0o700 });
  let requests = 0;
  const options = { providerId: "doordash", root, homeDir: path.join(root, "home"), serverId: "mcp-fixture", fetch: async () => { requests++; return new Response("corrupt release bytes"); } };
  for (const [platform, arch] of [["darwin", "x64"], ["win32", "x64"], ["linux", "arm64"]]) await assert.rejects(prepareOfficialSkill({ ...options, platform, arch }), { code: "OFFICIAL_SKILL_PLATFORM_UNSUPPORTED" });
  assert.equal(requests, 0);
  await assert.rejects(prepareOfficialSkill({ ...options, platform: "darwin", arch: "arm64" }), { code: "OFFICIAL_SKILL_INTEGRITY_FAILED" }); assert.equal(requests, 1);
  assert.equal(fs.existsSync(path.join(root, "runtime", "dd-cli")), false);
});

test("public release redirects remain on GitHub and its asset CDN, with no credential forwarding", async () => {
  const requested = [], initial = "https://github.com/doordash-oss/doordash-cli/releases/download/v0.2.6/fixture.tar.gz";
  const result = await fetchPublicRelease(async (url, options) => { requested.push({ url, options }); return requested.length === 1 ? new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/fixture" } }) : new Response("bytes"); }, initial, {});
  assert.equal(await result.text(), "bytes"); assert.equal(requested.length, 2); assert.ok(requested.every(item => item.options.redirect === "manual" && !item.options.headers));
  for (const location of ["http://127.0.0.1/private", "https://attacker.invalid/payload", "https://user:secret@github.com/payload"])
    await assert.rejects(fetchPublicRelease(async () => new Response(null, { status: 302, headers: { location } }), initial, {}), { code: "OFFICIAL_SKILL_DOWNLOAD_FAILED" });
});
