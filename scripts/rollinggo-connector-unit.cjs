"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
const { createOfficialSkillRuntime } = require("../app/agent-service/official-skill-runtime");
const { fixedFetch } = require("../app/agent-service/rollinggo-skill-cli-helper");
const { PROVIDERS } = require("../app/agent-service/official-skill-providers");
const { RELEASES } = require("../app/agent-service/official-skill-installer");
const dto = require("../app/core/official-skill-connector-dto");
const lock = { hotelId: 123, ratePlanId: "room-plan", checkInDate: "2026-12-20", checkOutDate: "2026-12-21", roomCount: 1, adultCount: 1, confirmed: true };
const guest = { firstName: "San", lastName: "Zhang", email: "san@example.test", guestList: [{ roomNum: 1, guestInfo: [{ firstName: "San", lastName: "Zhang", isAdult: true }] }], confirmed: true };
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shg-rollinggo-"))), home = path.join(root, "home");
  fs.chmodSync(root, 0o700); fs.mkdirSync(home, { mode: 0o700 });
  let now = 1000, authenticated = false, bookingFails = false, cancellationFails = false;
  const calls = [], runtimes = [];
  const spawn = (command, argv, options) => {
    assert.equal(command, process.execPath); assert.equal(options.shell, false); assert.equal(options.cwd, home);
    assert.equal(path.basename(argv[2]), "rollinggo-skill-cli-helper.js");
    assert.equal(options.env.HOME, home); assert.equal(options.env.UNRELATED_SECRET, undefined);
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null;
    let closed = false;
    const finish = (value, code = 0) => { if (closed) return; closed = true; child.exitCode = code; if (value) child.stdout.write(JSON.stringify(value)); child.emit("close", code); };
    child.kill = () => { finish(null, 0); return true; };
    let body = ""; child.stdin.on("data", chunk => { body += chunk; });
    child.stdin.on("finish", () => queueMicrotask(() => {
      const input = JSON.parse(body); calls.push(input);
      const { operation } = input;
      if (operation === "status") return finish({ authenticated, userName: authenticated ? "Fixture account" : null });
      if (operation === "login") { child.stdout.write(JSON.stringify({ verificationUrl: "https://api.rollinggo.store/s/fixture" }) + "\n"); return; }
      if (operation === "logout") { authenticated = false; return finish({ authenticated: false }); }
      if (operation === "price_confirm") return finish({ success: true, priceDetailsInfo: { referenceNo: "ref-original", hotelList: [{ totalPrice: 352, currency: "CNY", cancellationPolicyList: [{ amount: 100 }] }] } });
      if (operation === "book") return bookingFails ? finish({ errorCode: "OFFICIAL_SKILL_AUTH_FAILED" }, 1) : finish({ success: true, bookingResult: { orderNo: "order-original", paymentUrl: "https://rollinggo.cn/pay/original" } });
      if (operation === "pre_cancel") return finish({ success: true, canCancel: true, penaltyAmount: 100, confirmId: "cancel-original", bookingId: "booking-original" });
      if (operation === "confirm_cancel") return cancellationFails ? finish(null, 1) : finish({ success: true, orderNo: "order-original" });
      finish({ success: true, [operation === "orders" ? "orderInfoList" : "items"]: [] });
    }));
    return child;
  };
  const make = () => { const runtime = createOfficialSkillRuntime({ providerId: "rollinggo-hotel", root, home, env: { UNRELATED_SECRET: "private-canary" }, spawn, now: () => now }); runtimes.push(runtime); return runtime; };
  t.after(async () => { for (const runtime of runtimes) await runtime.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { runtime: make(), make, calls, authenticate: () => { authenticated = true; }, advance: ms => { now += ms; }, failBooking: () => { bookingFails = true; }, failCancellation: () => { cancellationFails = true; } };
}
test("RollingGo is one keyless official Skill recommendation with pinned CLI and dependencies", () => {
  const presets = require("../app/agent-service/data/mcp-featured-presets.json");
  assert.equal(presets.some(item => item.id === "rollinggo-hotel"), false);
  assert.equal(PROVIDERS["rollinggo-hotel"].authentication, "interactive");
  assert.deepEqual(PROVIDERS["rollinggo-hotel"].fields, []);
  assert.match(RELEASES["rollinggo-hotel"].ref, /^[a-f0-9]{40}$/u);
  assert.match(RELEASES["rollinggo-hotel"].sha256, /^[a-f0-9]{64}$/u);
  assert.ok(RELEASES["rollinggo-hotel"].docs.includes("LICENSE"));
  const deps = require("../app/agent-service/data/rollinggo-locked-js-dependencies.json");
  assert.deepEqual(deps.map(item => `${item.name}@${item.version}`), ["commander@13.1.0", "dotenv@17.4.2"]);
  assert.ok(deps.every(item => item.integrity.startsWith("sha512-")));
  assert.ok(dto.validOfficialVerificationUrl("rollinggo-hotel", "https://api.rollinggo.store/s/test"));
  for (const url of ["http://api.rollinggo.store/s/test", "https://api.rollinggo.store.attacker.test/", "https://api.qrserver.com/test", "https://user:pass@api.rollinggo.store/s/test"]) assert.equal(dto.validOfficialVerificationUrl("rollinggo-hotel", url), false);
});
test("helper network is confined to the official auth and business paths and rejects redirects", async () => {
  const calls = [], fetch = fixedFetch(async (...args) => { calls.push(args); return new Response("{}"); });
  await fetch("https://mcp.rollinggo.cn/mcp/hotelsearch", { method: "POST", body: "{}" });
  await fetch("https://api.rollinggo.store/skill/oauth/token?session_id=fixture");
  assert.ok(calls.every(([, options]) => options.redirect === "error" && options.signal));
  for (const url of ["https://attacker.test/mcp/hoteltags", "https://mcp.rollinggo.cn/mcp/update", "https://api.rollinggo.store/skill/oauth/token?session_id=x&extra=x", "https://mcp.rollinggo.cn/mcp/hoteltags?api_key=private", "http://mcp.rollinggo.cn/mcp/hoteltags"]) assert.throws(() => fetch(url));
  assert.equal(calls.length, 2);
});
test("explicit authorization returns only an official link, status confirms account, logout stops pending login", async t => {
  const f = fixture(t);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.runtime.call("account_status", {})).state, "signedOut");
  const started = await f.runtime.call("account_start", {});
  assert.equal(started.state, "authorizing"); assert.equal(started.verificationUrl, "https://api.rollinggo.store/s/fixture");
  assert.equal((await f.runtime.call("account_status", {})).state, "authorizing");
  await assert.rejects(f.runtime.call("account_bind", { code: "never-needed" }), { code: "OFFICIAL_SKILL_INVALID_ARGUMENT" });
  f.authenticate(); assert.equal((await f.runtime.call("account_status", {})).state, "ready");
  assert.equal((await f.runtime.call("account_logout", {})).state, "signedOut");
  assert.equal((await f.runtime.call("account_status", {})).state, "signedOut");
});
test("business schemas preserve required amenities, brand and occupancy, with no caller-selected command or endpoint", async t => {
  const f = fixture(t);
  await f.runtime.call("search_hotels", { originQuery: "杭州含早亚朵", place: "杭州", placeType: "城市", requiredTags: ["含早餐"], preferredBrands: ["亚朵"], maxPricePerNight: 500 });
  assert.deepEqual(f.calls.at(-1).params.hotelTags, { requiredTags: ["含早餐"], preferredBrands: ["亚朵"], maxPricePerNight: 500 });
  for (const args of [{ ...lock, confirmed: false }, { ...lock, command: "update" }, { ...lock, checkInDate: "2026-02-30" }, { ...lock, childCount: 1 }, { ...lock, checkOutDate: lock.checkInDate }]) await assert.rejects(f.runtime.call("price_confirm", args), { code: "OFFICIAL_SKILL_INVALID_ARGUMENT" });
  assert.equal(f.calls.length, 1);
});
test("booking requires this installation's current price proof, matching guests and a second confirmation; completed proof cannot replay after restart", async t => {
  const f = fixture(t), quote = await f.runtime.call("price_confirm", lock);
  await assert.rejects(f.runtime.call("book", { ...guest, confirmationId: quote.confirmationId, confirmed: false }));
  await assert.rejects(f.runtime.call("book", { ...guest, confirmationId: quote.confirmationId, guestList: [{ roomNum: 1, guestInfo: [{ firstName: "A", lastName: "B", isAdult: false }] }] }));
  const result = await f.runtime.call("book", { ...guest, confirmationId: quote.confirmationId });
  assert.equal(result.bookingResult.orderNo, "order-original"); assert.ok(result.bookingResult.paymentUrl);
  assert.equal(f.calls.filter(call => call.operation === "book").length, 1);
  const restarted = f.make();
  await assert.rejects(restarted.call("book", { ...guest, confirmationId: quote.confirmationId }), { code: "OFFICIAL_SKILL_OPERATION_UNCERTAIN" });
  assert.equal(f.calls.filter(call => call.operation === "book").length, 1);
});
test("expired quotes and quotes cleared by account replacement cannot create an order", async t => {
  const f = fixture(t), quote = await f.runtime.call("price_confirm", lock);
  f.advance(15 * 60_000);
  await assert.rejects(f.runtime.call("book", { ...guest, confirmationId: quote.confirmationId }), { code: "OFFICIAL_SKILL_PURCHASE_REVIEW_REQUIRED" });
  const fresh = await f.runtime.call("price_confirm", lock);
  await f.runtime.call("account_logout", {});
  await assert.rejects(f.runtime.call("book", { ...guest, confirmationId: fresh.confirmationId }), { code: "OFFICIAL_SKILL_PURCHASE_REVIEW_REQUIRED" });
  assert.equal(f.calls.some(call => call.operation === "book"), false);
});
test("uncertain booking is never replayed after restart and order reconciliation stays available", async t => {
  const f = fixture(t), quote = await f.runtime.call("price_confirm", lock); f.failBooking();
  await assert.rejects(f.runtime.call("book", { ...guest, confirmationId: quote.confirmationId }), { code: "OFFICIAL_SKILL_OPERATION_UNCERTAIN" });
  const restarted = f.make();
  await assert.rejects(restarted.call("book", { ...guest, confirmationId: quote.confirmationId }), { code: "OFFICIAL_SKILL_OPERATION_UNCERTAIN" });
  await restarted.call("orders", { status: "ALL" });
  assert.equal(f.calls.filter(call => call.operation === "book").length, 1);
  assert.equal(f.calls.at(-1).operation, "orders");
});
test("cancellation first exposes the real penalty, then accepts only the reviewed proof; unknown cancellation cannot replay", async t => {
  const f = fixture(t), preview = await f.runtime.call("pre_cancel", { orderNo: "order-original" });
  assert.equal(preview.penaltyAmount, 100); assert.equal(preview.confirmationRequired, true);
  await assert.rejects(f.runtime.call("confirm_cancel", { confirmationId: preview.confirmationId }));
  f.failCancellation();
  await assert.rejects(f.runtime.call("confirm_cancel", { confirmationId: preview.confirmationId, confirmed: true }), { code: "OFFICIAL_SKILL_OPERATION_UNCERTAIN" });
  const secondPreview = await f.make().call("pre_cancel", { orderNo: "order-original" });
  await assert.rejects(f.runtime.call("confirm_cancel", { confirmationId: secondPreview.confirmationId, confirmed: true }), { code: "OFFICIAL_SKILL_OPERATION_UNCERTAIN" });
  assert.equal(f.calls.filter(call => call.operation === "confirm_cancel").length, 1);
  assert.deepEqual(f.calls.find(call => call.operation === "confirm_cancel").params, { orderNo: "order-original", bookingId: "booking-original", confirmId: "cancel-original" });
});
