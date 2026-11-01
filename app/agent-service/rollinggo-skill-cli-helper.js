"use strict";

// Call the audited exports shipped in @rollinggo/hotel. Its interactive entry
// scans ancestor .env files and contains a global updater; neither belongs in
// a managed installation. Credentials and structured arguments stay on stdin.
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { validatePayload } = require("./official-skill-mcp-bridge");
const { validOfficialVerificationUrl } = require("../core/official-skill-connector-dto");
const { createMcpFetch } = require("./mcp-http-fetch");
const { publicOutput } = require("./official-skill-runtime");

const API_METHODS = Object.freeze({
  hotel_tags: "getHotelSearchTags", search_hotels: "searchHotels", hotel_detail: "getHotelDetail",
  price_confirm: "hotelPriceConfirm", book: "createHotelBooking", orders: "searchHotelOrders",
  order_detail: "getHotelOrderDetail", pre_cancel: "preCancelHotelBooking", confirm_cancel: "confirmCancelHotelBooking",
});
const ENDPOINTS = new Set(["/mcp/hoteltags", "/mcp/hotelsearch", "/mcp/hoteldetail", "/mcp/hotelpriceconfirm",
  "/mcp/hotelbook", "/mcp/hotelorders", "/mcp/hotelorderdetail", "/mcp/hotelprecancel", "/mcp/hotelcancelconfirm"]);
const fail = () => { throw Object.assign(new Error("OFFICIAL_SKILL_AUTH_FAILED"), { code: "OFFICIAL_SKILL_AUTH_FAILED" }); };
function fixedFetch(fetch) {
  return (input, init = {}) => {
    const url = new URL(input instanceof URL ? input.href : input.url || input);
    const method = (init.method || "GET").toUpperCase();
    const allowed = url.origin === "https://mcp.rollinggo.cn" && ENDPOINTS.has(url.pathname)
      && method === (url.pathname.endsWith("/hoteltags") ? "GET" : "POST") && !url.search
      || url.origin === "https://api.rollinggo.store" && (
        ["/skill/oauth/init", "/s/shorten"].includes(url.pathname) && method === "POST" && !url.search
        || url.pathname === "/skill/oauth/token" && method === "GET" && [...url.searchParams.keys()].join(",") === "session_id");
    if (!allowed || url.username || url.password || url.hash) fail();
    return fetch(input, { ...init, redirect: "error", signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(30_000)]) });
  };
}
async function main(argv = process.argv.slice(2), input = process.stdin) {
  if (argv.length !== 4 || argv[0] !== "--root" || argv[2] !== "--home" || process.env.HOME !== argv[3]) fail();
  const root = argv[1], home = argv[3]; validatePayload("rollinggo-hotel", root, home);
  process.umask(0o077);
  // Set only the official production endpoints; tool inputs cannot select them.
  Object.assign(process.env, { MCP_BASE_URL: "https://mcp.rollinggo.cn/mcp", OAUTH_SERVER_URL: "https://api.rollinggo.store",
    OAUTH_AUTHORIZE_URL: "https://api.rollinggo.cn/oauth2/authorize" });
  globalThis.fetch = fixedFetch(createMcpFetch());
  let body = "";
  for await (const chunk of input) { body += chunk.toString("utf8"); if (Buffer.byteLength(body) > 128 * 1024) fail(); }
  const request = JSON.parse(body);
  if (!request || Object.keys(request).sort().join(",") !== "operation,params"
    || !["login", "status", "logout", ...Object.keys(API_METHODS)].includes(request.operation)) fail();
  const auth = await import(pathToFileURL(path.join(root, "runtime/dist/auth.js")).href);
  const api = await import(pathToFileURL(path.join(root, "runtime/dist/api.js")).href);
  const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  // The upstream login logs a token prefix after authorization. Only its
  // official authorization URL is allowed out of the login process.
  console.log = (...items) => {
    if (request.operation !== "login") return;
    const text = items.map(String).join(" ").trim();
    if (validOfficialVerificationUrl("rollinggo-hotel", text)) emit({ verificationUrl: text });
  };
  if (request.operation === "login") { await auth.login("rollinggoskill"); emit({ authenticated: true }); return; }
  if (request.operation === "logout") { auth.logout(); emit({ authenticated: false }); return; }
  const token = auth.loadToken();
  if (request.operation === "status") {
    if (!token?.access_token) { emit({ authenticated: false }); return; }
    const verified = await api.getHotelSearchTags();
    if (verified?.success === false || verified?.isError || verified?.error
      || !Array.isArray(verified?.tags) && !Array.isArray(verified?.data?.tags)) fail();
    emit({ authenticated: true, userName: typeof token.user === "string" ? token.user.slice(0, 256) : null }); return;
  }
  if (!token?.access_token) throw Object.assign(new Error("signed out"), { code: "OFFICIAL_SKILL_ROLLINGGO_AUTH_REQUIRED" });
  const result = await api[API_METHODS[request.operation]](request.params);
  emit(publicOutput(result, [token.access_token, token.refresh_token]));
}
module.exports = { main, fixedFetch, API_METHODS };
if (require.main === module) main().catch(error => {
  // Never forward upstream diagnostics, credential prefixes or HTTP bodies.
  const code = error.code === "OFFICIAL_SKILL_ROLLINGGO_AUTH_REQUIRED" ? error.code : "OFFICIAL_SKILL_AUTH_FAILED";
  process.stdout.write(`${JSON.stringify({ errorCode: code })}\n`); process.exitCode = 1;
});
