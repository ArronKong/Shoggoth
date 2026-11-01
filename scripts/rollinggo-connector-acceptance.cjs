"use strict";
// Supply an already downloaded archive directory. No production login, order,
// payment, cancellation or external business request is made by this fixture.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { ensurePrivateDirectoryTree } = require("../app/agent-service/security");
const { prepareOfficialSkill, RELEASES } = require("../app/agent-service/official-skill-installer");
const { validatePayload } = require("../app/agent-service/official-skill-mcp-bridge");
const { NativeMcpStore } = require("../app/agent-service/native-mcp-store");
const { NativeMcpClientManager } = require("../app/agent-service/native-mcp-client-manager");
const { createOfficialSkillRuntime } = require("../app/agent-service/official-skill-runtime");
async function main() {
  assert.equal(process.argv[2], "--archive-dir"); assert.equal(process.argv.length, 4);
  const archiveDir = path.resolve(process.argv[3]), base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shg-rollinggo-acceptance-")));
  fs.chmodSync(base, 0o700);
  const paths = resolveServicePaths({ homeDir: base, trustedRoot: base, stateRoot: path.join(base, "state"), cacheRoot: path.join(base, "cache") });
  const root = path.join(paths.stateDir, "runtime-bin", "official-skills", "rollinggo-hotel", crypto.randomUUID()), home = path.join(root, "home");
  ensurePrivateDirectoryTree(home, base);
  let manager, store, runtime;
  try {
    const release = RELEASES["rollinggo-hotel"], fetched = [], stages = [];
    const prepared = await prepareOfficialSkill({ providerId: "rollinggo-hotel", root, homeDir: home, serverId: "official-rollinggo-hotel-aabbccdd", env: {},
      onStage: stage => stages.push(stage), signal: new AbortController().signal,
      fetch: async url => { fetched.push(url); return new Response(fs.readFileSync(path.join(archiveDir, url.startsWith("https://codeload.github.com/") ? "upstream-skill.zip" : new URL(url).pathname.split("/").at(-1)))); } });
    assert.equal(fetched.length, 4); assert.equal(prepared.skills[0].id, "official-rollinggo-hotel");
    validatePayload("rollinggo-hotel", root, home);
    const source = fs.readFileSync(path.join(prepared.skills[0].sourcePath, "SKILL.md"), "utf8");
    assert.ok(source.includes("无需申请或填写 API Key"));
    assert.ok(prepared.files.some(file => file.path.endsWith("references/upstream/LICENSE")));
    assert.ok(prepared.files.some(file => file.path.endsWith("references/upstream/skills/rollinggo-hotel-booking/SKILL.md")));
    store = new NativeMcpStore({ paths }).open();
    store.add({ expectedRevision: store.revision, server: { id: "official-rollinggo-hotel-aabbccdd", name: "RollingGo Hotels", enabled: true, source: { kind: "custom" }, transport: prepared.transport,
      auth: { kind: "none" }, secretRef: null, setup: { requiredFields: [], configuredFields: [] }, status: "checking", lastCheck: null, disabledProfileIds: [] } });
    manager = new NativeMcpClientManager({ store, env: {} });
    const tools = await manager.listTools("official-rollinggo-hotel-aabbccdd");
    assert.equal(tools.length, 13);
    const status = await manager.callTool("official-rollinggo-hotel-aabbccdd", "account_status", {});
    assert.equal(JSON.parse(status.content[0].text).state, "signedOut");
    await manager.close(); manager = null;
    // Run the actual downloaded auth/api exports and the production helper in
    // real subprocesses. Only the network boundary receives canned responses.
    const preload = path.join(base, "offline-network.cjs");
    fs.writeFileSync(preload, `"use strict";
const fs = require("node:fs"), path = require("node:path");
const log = path.join(process.env.HOME, "fixture-requests.jsonl");
globalThis.fetch = async (input, init = {}) => {
 const url = new URL(input), body = init.body ? JSON.parse(init.body) : null;
 fs.appendFileSync(log, JSON.stringify({ path: url.pathname, body }) + "\\n", { mode: 0o600 });
 let value;
 if (url.pathname === "/skill/oauth/init") value = { state: "fixture-state", session_id: "fixture-session" };
 else if (url.pathname === "/s/shorten") value = { shortUrl: "https://api.rollinggo.store/s/offline-fixture" };
 else if (url.pathname === "/skill/oauth/token") value = { status: "success", token: { access_token: "private-rollinggo-access-canary", refresh_token: "private-refresh-canary", user: "Offline fixture" } };
 else if (url.pathname === "/mcp/hoteltags") value = { success: true, tags: ["含早餐"] };
 else if (url.pathname === "/mcp/hotelsearch") value = { success: true, hotelInformationList: [], access_token: "private-rollinggo-access-canary" };
 else if (url.pathname === "/mcp/hoteldetail") value = { success: true, roomRatePlans: [] };
 else if (url.pathname === "/mcp/hotelpriceconfirm") value = { success: true, priceDetailsInfo: { referenceNo: "offline-ref", hotelList: [{ totalPrice: 352, currency: "CNY" }] } };
 else if (url.pathname === "/mcp/hotelbook") value = { success: true, bookingResult: { orderNo: "offline-order", paymentUrl: "https://rollinggo.cn/pay/offline-fixture" } };
 else if (url.pathname === "/mcp/hotelorders") value = { success: true, orderInfoList: [] };
 else if (url.pathname === "/mcp/hotelorderdetail") value = { success: true, orderNo: body.orderNo };
 else if (url.pathname === "/mcp/hotelprecancel") value = { success: true, canCancel: true, penaltyAmount: 100, confirmId: "offline-cancel", bookingId: "offline-booking" };
 else if (url.pathname === "/mcp/hotelcancelconfirm") value = { success: true, orderNo: body.orderNo };
 else throw new Error("Unexpected network request");
 return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
};
`, { mode: 0o600 });
    runtime = createOfficialSkillRuntime({ providerId: "rollinggo-hotel", root, home, env: {}, validate: () => validatePayload("rollinggo-hotel", root, home),
      spawn: (command, args, options) => spawn(command, ["--require", preload, ...args], options) });
    const outputs = [], call = async (name, args = {}) => { const value = await runtime.call(name, args); outputs.push(value); return value; };
    assert.equal((await call("account_start")).verificationUrl, "https://api.rollinggo.store/s/offline-fixture");
    let account;
    for (let attempt = 0; attempt < 20; attempt++) { account = await call("account_status"); if (account.state === "ready") break; await new Promise(resolve => setTimeout(resolve, 250)); }
    assert.equal(account.state, "ready");
    await call("hotel_tags");
    await call("search_hotels", { originQuery: "杭州含早", place: "杭州", placeType: "城市", requiredTags: ["含早餐"] });
    const stay = { hotelId: 123, checkInDate: "2026-12-20", checkOutDate: "2026-12-21", roomCount: 1, adultCount: 1 };
    await call("hotel_detail", stay);
    const price = await call("price_confirm", { ...stay, ratePlanId: "offline-room", confirmed: true });
    const booking = { confirmationId: price.confirmationId, firstName: "San", lastName: "Zhang", email: "san@example.test", guestList: [{ roomNum: 1, guestInfo: [{ firstName: "San", lastName: "Zhang", isAdult: true }] }], confirmed: true };
    assert.equal((await call("book", booking)).bookingResult.orderNo, "offline-order");
    await assert.rejects(call("book", booking), { code: "OFFICIAL_SKILL_OPERATION_UNCERTAIN" });
    await call("orders", { status: "ALL" }); await call("order_detail", { orderNo: "offline-order" });
    const cancellation = await call("pre_cancel", { orderNo: "offline-order" });
    assert.equal((await call("confirm_cancel", { confirmationId: cancellation.confirmationId, confirmed: true })).success, true);
    assert.ok(!JSON.stringify(outputs).includes("private-rollinggo-access-canary"));
    const requests = fs.readFileSync(path.join(home, "fixture-requests.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(requests.find(item => item.path === "/mcp/hotelsearch").body.hotelTags.requiredTags, ["含早餐"]);
    assert.equal(requests.filter(item => item.path === "/mcp/hotelbook").length, 1);
    assert.equal(requests.filter(item => item.path === "/mcp/hotelcancelconfirm").length, 1);
    assert.equal((fs.statSync(path.join(home, ".hotel-cli/token.json")).mode & 0o077), 0);
    await call("account_logout"); assert.equal((await call("account_status")).state, "signedOut");
    console.log(JSON.stringify({ outcome: "PASS", skillRef: release.ref, skillVersion: "1.1.6", cliVersion: "1.2.25", verifiedFiles: prepared.files.length,
      stages, actualStdioTools: tools.length, actualOfficialCliSubprocesses: true, offlineBusinessFlow: true, privateCredentials: true, noReplay: true,
      realAccountAuthorization: false, realBusinessCalls: false, realOrdersPaymentsCancellations: false }, null, 2));
  } finally { await runtime?.close(); await manager?.close(); store?.close(); fs.rmSync(base, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
