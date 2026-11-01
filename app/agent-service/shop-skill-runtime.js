"use strict";

const path = require("node:path");
const crypto = require("node:crypto");
const Ajv2020 = require("ajv/dist/2020");
const { readPrivateFile } = require("./private-file");

const fail = (code = "OFFICIAL_SKILL_INVALID_ARGUMENT") => { throw Object.assign(new Error(code), { code }); };
const completionSchema = {
  type: "object", additionalProperties: false,
  properties: { confirmationId: { type: "string", format: "uuid" }, instrumentId: { type: "string", minLength: 1, maxLength: 512 }, confirmed: { const: true } },
  required: ["confirmationId", "instrumentId", "confirmed"],
};
const SUPPORTED_TOOLS = Object.freeze(["search_catalog", "lookup_catalog", "get_product", "search_locations", "lookup_locations", "create_cart", "get_cart", "update_cart", "create_checkout", "get_checkout", "update_checkout", "complete_checkout", "search_orders", "get_account"]);
const writes = new Set(["create_cart", "update_cart", "create_checkout", "update_checkout", "complete_checkout"]);
function selectShopTools(tools) {
  if (!Array.isArray(tools) || tools.length > 100 || new Set(tools.map(tool => tool.name)).size !== tools.length) fail("OFFICIAL_SKILL_INTEGRITY_FAILED");
  return SUPPORTED_TOOLS.map(name => {
    const tool = tools.find(tool => tool.name === name);
    if (!tool || typeof tool.description !== "string" || tool.inputSchema?.type !== "object") fail("OFFICIAL_SKILL_INTEGRITY_FAILED");
    return { name, description: tool.description, inputSchema: tool.inputSchema };
  });
}
function getShopToolDefs(root) {
  let stored;
  try { stored = JSON.parse(readPrivateFile(path.join(root, "shop-tools.json"), { maxBytes: 2 * 1024 * 1024 })); }
  catch { fail("OFFICIAL_SKILL_INTEGRITY_FAILED"); }
  return selectShopTools(stored.tools).map(tool => [tool.name,
  tool.name === "complete_checkout"
    ? "Purchase the latest reviewed Shop checkout after explicit approval of its merchant, items, quantities, total and payment method. Use confirmationId from the latest checkout result and an offered instrumentId. Never repeat completion; use get_checkout to reconcile an unknown outcome."
    : tool.description,
    tool.name === "complete_checkout" ? completionSchema : { ...tool.inputSchema, additionalProperties: false }, writes.has(tool.name)]);
}

function createValidator() {
  return new Ajv2020({ strict: false, allErrors: false })
    .addFormat("uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu)
    .addFormat("date", value => /^\d{4}-\d{2}-\d{2}$/u.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value)
    .addFormat("date-time", value => /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/iu.test(value) && !Number.isNaN(Date.parse(value)));
}

// Payment credentials stay inside this adapter. The model chooses only the ID
// of an offered instrument; the original object goes directly to Shop's MCP.
function publicShopOutput(value) {
  if (Array.isArray(value)) return value.map(publicShopOutput);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(?:credential|access_token|refresh_token|accessToken|refreshToken|cvv|cvc|pan)$/iu.test(key))
    .map(([key, item]) => [key, publicShopOutput(item)]));
  return value;
}
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const terms = checkout => { const { next, signals, attribution, ...value } = checkout || {}; return JSON.stringify(stable(value)); };
const checkoutOf = result => result?.data?.checkout || result?.data;

function createShopAdapter({ client, auth, guardedWrite, account, now = Date.now }) {
  const previews = new Map();
  const request = async (name, args, signal) => {
    try { return await client.call(name, args, signal); }
    catch (error) { if (error.code === "OFFICIAL_SKILL_AUTH_REQUIRED") auth.invalidate(); throw error; }
  };
  async function accountAction(action, signal) {
    if (action === "logout") {
      auth.logout(); previews.clear(); return account("signedOut");
    }
    if (action === "start") { const { state, ...fields } = await auth.start(signal); return account(state, fields); }
    const pending = await auth.poll(signal);
    if (pending) { const { state, ...fields } = pending; return account(state, fields); }
    if (!auth.getToken()) return account("signedOut");
    let value;
    try { value = await request("get_account", {}, signal); }
    catch (error) { if (error.code === "OFFICIAL_SKILL_AUTH_REQUIRED") return account("signedOut"); throw error; }
    if (!value.ok) return account(value.error?.code === "auth_required" ? "signedOut" : "unknown",
      { errorCode: value.error?.code === "auth_required" ? null : "OFFICIAL_SKILL_AUTH_STATUS_FAILED" });
    if (value.data?.signed_in === false) return account("signedOut");
    const userName = value.data?.buyer?.name || value.data?.buyer?.email;
    return account("ready", { userName: typeof userName === "string" ? userName.slice(0, 256) : null });
  }
  function rememberCheckout(value, args) {
    const checkout = checkoutOf(value);
    if (!value.ok || !checkout || typeof checkout.id !== "string" || !args.shop) return value;
    for (const [key, preview] of previews) if (preview.expires < now() || preview.shop === args.shop && preview.id === checkout.id) previews.delete(key);
    if (checkout.status !== "ready_for_complete" || !checkout.payment?.instruments?.length) return value;
    while (previews.size >= 64) previews.delete(previews.keys().next().value);
    const confirmationId = crypto.randomUUID();
    previews.set(confirmationId, { shop: args.shop, id: checkout.id, checkout: structuredClone(checkout), expires: now() + 5 * 60_000 });
    return { ...value, data: { ...value.data, confirmationId } };
  }
  async function complete(args, signal) {
    const preview = previews.get(args.confirmationId);
    if (!preview || preview.expires < now()) fail();
    const instrument = preview.checkout.payment.instruments.find(item => item.id === args.instrumentId);
    if (!instrument) fail();
    const latest = await request("get_checkout", { shop: preview.shop, id: preview.id }, signal);
    if (!latest.ok) fail("OFFICIAL_SKILL_AUTH_FAILED");
    if (terms(checkoutOf(latest)) !== terms(preview.checkout)) {
      previews.delete(args.confirmationId); fail("OFFICIAL_SKILL_REVISION_CONFLICT");
    }
    previews.delete(args.confirmationId);
    return guardedWrite("shop:complete_checkout", { shop: preview.shop, id: preview.id }, async () => {
      const value = await request("complete_checkout", { shop: preview.shop, id: preview.id,
        checkout: { payment: { instruments: [{ ...structuredClone(instrument), selected: true }] } }, meta: { "idempotency-key": crypto.randomUUID() } }, signal);
      if (!value.ok) fail("OFFICIAL_SKILL_OPERATION_UNCERTAIN");
      return value;
    }, { keepCompleted: true });
  }
  return { account: accountAction, async call(name, args, { signal } = {}) {
    let value;
    if (name === "complete_checkout") value = await complete(args, signal);
    else if (writes.has(name)) {
      const { meta, ...identity } = args;
      value = await guardedWrite(`shop:${name}`, identity, async () => {
        const result = await request(name, { ...args, meta: { ...meta, "idempotency-key": meta?.["idempotency-key"] || crypto.randomUUID() } }, signal);
        if (!result.ok) fail("OFFICIAL_SKILL_OPERATION_UNCERTAIN");
        return result;
      });
    } else value = await request(name, args, signal);
    if (["create_checkout", "get_checkout", "update_checkout"].includes(name)) value = rememberCheckout(value, args);
    return publicShopOutput(value);
  } };
}

module.exports = { SUPPORTED_TOOLS, selectShopTools, getShopToolDefs, createValidator, createShopAdapter, publicShopOutput };
