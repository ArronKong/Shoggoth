"use strict";

const crypto = require("node:crypto");
const { createDoorDashAuth } = require("./doordash-skill-auth");
const fail = (code = "OFFICIAL_SKILL_INVALID_ARGUMENT") => { throw Object.assign(new Error(code), { code }); };
const text = (maxLength = 512) => ({ type: "string", minLength: 1, maxLength, pattern: "^[^\\u0000-\\u001f\\u007f]+$" });
const id = { ...text(512), pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" };
const storeId = { ...id, pattern: "^[0-9]+$" };
const int = maximum => ({ type: "integer", minimum: 0, maximum });
const purpose = { ...text(600), description: "A brief purpose for this personal order. Do not include credentials, health details or unrelated personal information." };
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const request = (properties = {}, required = []) => object({ ...properties, intent: purpose }, [...required, "intent"]);
const option = object({ id, name: text(200), quantity: { type: "number", exclusiveMinimum: 0, maximum: 100 }, options: { type: "array", maxItems: 30, items: { $ref: "#/$defs/option" } } }, ["id", "name", "quantity"]);
const addSchema = request({ storeId, menuId: id, cartId: id, fulfillment: { enum: ["delivery", "pickup"] }, items: { type: "array", minItems: 1, maxItems: 50,
  items: object({ item_id: id, item_name: text(200), quantity: { type: "number", exclusiveMinimum: 0, maximum: 100 }, nested_options: { type: "array", maxItems: 30, items: { $ref: "#/$defs/option" } }, default_handling: { const: "exact" } }, ["item_id", "item_name", "quantity"]) } }, ["storeId", "menuId", "items"]);
addSchema.$defs = { option };
const TOOL_DEFS = [
  ["list_addresses", "Read saved DoorDash addresses. Does not change the default address.", request()],
  ["list_payment_methods", "Read saved cards. An empty list does not mean no payment method is available; wallets are not listed.", request()],
  ["search_stores", "Search DoorDash restaurants from a returned saved address. Sign-in and account approval are required.", request({ query: text(), addressId: id, limit: { type: "integer", minimum: 1, maximum: 20 }, dashpassOnly: { type: "boolean" }, maxEtaMinutes: { type: "integer", minimum: 1, maximum: 240 } }, ["query"])],
  ["get_menu", "Read a restaurant menu, promotions and exact item IDs. Do not infer popularity from is_popular or popularity_rank. Read get_restaurant_item for required modifiers.", request({ storeId, addressId: id }, ["storeId"])],
  ["get_restaurant_item", "Read full restaurant item details and required modifier groups. Use extras[].options[].option_id for selections, not extra_id. A menu item ID's i_ prefix is removed only for this lookup.", request({ storeId, menuId: id, itemId: id, addressId: id }, ["storeId", "menuId", "itemId"])],
  ["list_carts", "Read open carts before adding items or recreating an order. Submitted orders are not in this list.", request({ storeId })],
  ["get_cart", "Read a personal cart. Cart-line IDs and menu-item IDs are different. This is also a recovery read after an uncertain mutation.", request({ cartId: id }, ["cartId"])],
  ["add_cart_items", "Add the requested items and exact modifiers to a personal cart. Existing carts require an explicit cartId; adds increase quantities and are never automatically retried.", addSchema, true],
  ["remove_cart_item", "Remove one requested cart line using its returned cart-line ID. Read the cart first.", request({ cartId: id, cartItemId: id }, ["cartId", "cartItemId"]), true],
  ["delete_cart", "Delete the specified personal cart only after the user confirms. Other carts are preserved.", request({ cartId: id, confirmed: { const: true } }, ["cartId", "confirmed"]), true],
  ["preview_order", "Read current items, address, pricing and payment card. The official quote is before tip: show it in full, then show the user's explicit tip and totalIncludingTip. A missing tip needs a user choice, including zero. Only a supported current review yields confirmationId. Scheduled orders use the official checkout link.", request({ cartId: id, tipCents: int(100000), cardId: id, scheduledTime: { ...text(40), pattern: "^\\d{4}-\\d{2}-\\d{2}T[0-9:.]+Z$" }, priority: { type: "boolean" }, noApplyCredits: { type: "boolean" } }, ["cartId"])],
  ["submit_order", "Charge and place only the exact current reviewed order after explicit approval of merchant, items, address, full price, tip and named card. PIN handoff needs pinAccepted:true. Uses confirmationId from preview_order. Never repeat; a submit response is processing, not proof of payment or placement.", request({ confirmationId: { type: "string", format: "uuid" }, confirmed: { const: true }, pinAccepted: { const: true } }, ["confirmationId", "confirmed"]), true],
  ["order_status", "Read the original order status after submission or an unknown outcome. Only placed or a later delivery/pickup stage confirms placement. Do not automatically resubmit.", request({ orderId: id }, ["orderId"])],
  ["order_history", "Read personal order history and known store IDs. Does not place or recreate an order.", request({ max: { type: "integer", minimum: 1, maximum: 100 }, days: { type: "integer", minimum: 1, maximum: 365 } })],
  ["reorder", "Recreate a previously queried personal order as a cart, not a paid order. Requires its storeId from order_history; existing carts are surfaced before any write. Compare the returned cart with the original order and disclose dropped items before confirming.", request({ orderId: id, storeId }, ["orderId", "storeId"]), true],
  ["checkout_url", "Get the official browser checkout for this same cart when required steps cannot be completed here. Does not prove payment and never replaces an uncertain order submission.", request({ cartId: id }, ["cartId"])],
];
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const fingerprint = value => JSON.stringify(stable(value));
function publicDoorDashOutput(value) {
  if (Array.isArray(value)) return value.map(publicDoorDashOutput);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !/(?:^|_)(?:token|access_?token|refresh_?token|guest_?token|code_?verifier|credential|authorization|password)(?:$|_)/iu.test(key)).map(([key, item]) => [key, publicDoorDashOutput(item)]));
  return value;
}

function createDoorDashAdapter({ root, home, run, parseJson, guardedWrite, account, rememberSecret, now = Date.now }) {
  const reviews = new Map(), knownOrders = new Map();
  const auth = createDoorDashAuth({ root, home, run, parseJson, rememberSecret, now });
  const intentArgs = intent => ["--intent", `Summary: ${intent}\nuser prompt/purpose: ""`];
  function decode(result) {
    const value = parseJson(result.stdout), error = parseJson(result.stderr)?.error || value?.error;
    if (result.code === 0 && value && typeof value === "object") return value;
    if (result.code === 4 || error?.code === "gated") fail("OFFICIAL_SKILL_APPROVAL_REQUIRED");
    if (result.code === 3 || ["auth_expired", "auth_forbidden", "auth_missing", "keychain_unavailable"].includes(error?.code)) fail("OFFICIAL_SKILL_DOORDASH_AUTH_REQUIRED");
    if (error?.code === "rate_limited") fail("OFFICIAL_SKILL_RATE_LIMITED");
    fail("OFFICIAL_SKILL_UNAVAILABLE");
  }
  const invoke = async (args, intent, signal) => decode(await run(["--json-output", ...args, ...intentArgs(intent)], { signal, extraEnv: { DD_CLI_ACCESS_TOKEN: auth.token() } }));
  function invalidate(cartId) { for (const [key, value] of reviews) if (value.args.cartId === cartId) reviews.delete(key); }
  async function personalCart(cartId, intent, signal) {
    const value = await invoke(["cart", "show", "--cart-uuid", cartId], intent, signal);
    if (!value.cart || value.cart.group_cart_url) fail("OFFICIAL_SKILL_PURCHASE_REVIEW_REQUIRED");
    return value.cart;
  }
  async function collision(storeId, intent, signal) {
    const value = await invoke(["cart", "list", "--store-id", storeId], intent, signal);
    if (!Array.isArray(value.carts)) fail("OFFICIAL_SKILL_UNAVAILABLE");
    return value.carts.length ? { requiresCartChoice: true, existingCarts: value.carts, message: "Choose the existing cart explicitly, or confirm its deletion before starting a new one." } : null;
  }
  function previewArgs(args) {
    return ["order", "preview", "--cart-uuid", args.cartId, "--include-work-benefits", ...(args.cardId ? ["--card-id", args.cardId] : []),
      ...(args.scheduledTime ? ["--scheduled-time", args.scheduledTime] : []), ...(args.priority ? ["--priority"] : []), ...(args.noApplyCredits ? ["--no-apply-credits"] : [])];
  }
  async function readReview(args, signal) {
    if (args.priority && args.scheduledTime || args.cardId && args.scheduledTime) fail();
    const cart = await personalCart(args.cartId, args.intent, signal), value = await invoke(previewArgs(args), args.intent, signal);
    const quote = value.quote;
    if (!quote || !quote.net_total_before_tip || !Array.isArray(quote.store_order_cart?.orders) || !Array.isArray(quote.line_items)) fail("OFFICIAL_SKILL_PURCHASE_REVIEW_REQUIRED");
    const mode = quote.store_order_cart.fulfillment_type, money = quote.net_total_before_tip, method = value.payment_method;
    const tip = mode === "PICKUP" ? 0 : args.tipCents;
    const canSubmit = Boolean(!args.scheduledTime && ["PICKUP", "DELIVERY"].includes(mode) && Number.isSafeInteger(tip)
      && !(mode === "PICKUP" && args.tipCents > 0)
      && Number.isSafeInteger(money.unit_amount) && money.unit_amount >= 0 && Number.isSafeInteger(money.unit_amount + tip) && /^[A-Z]{3}$/u.test(money.currency || "")
      && typeof money.display_string === "string" && money.display_string.trim() && /^[A-Za-z0-9][A-Za-z0-9_-]{0,511}$/u.test(method?.card_id || "") && typeof method.display_name === "string" && method.display_name.trim()
      && (mode === "PICKUP" || typeof quote.delivery_address?.printable_address === "string" && quote.delivery_address.printable_address.trim())
      && (mode === "PICKUP" || tip === 0 || quote.is_pre_tippable === true)
      && !value.payment_split
      && !quote.expense_order_options?.all_eligible_expense_order_budgets?.some(budget => budget.remaining_amount?.unit_amount > 0)
      && (!args.cardId || args.cardId === method.card_id) && quote.store_order_cart.orders.some(order => order.order_items?.length)
      && (!args.priority || mode === "DELIVERY" && quote.delivery_availability?.delivery_options?.some(option => option.delivery_option_type === "PRIORITY")));
    const terms = { cart: { id: cart.id, store_id: cart.store_id, store_name: cart.store_name, items: cart.items },
      mode, orders: quote.store_order_cart.orders, address: quote.delivery_address, totalBeforeTip: money, charges: quote.line_items,
      credits: quote.credit_details, dropoff: quote.dropoff_options, payment: method, paymentSplit: value.payment_split,
      workBenefits: quote.expense_order_options, companyPayment: quote.company_payment_info, tipCents: tip };
    return { value, terms, canSubmit, tip, pinRequired: quote.dropoff_options?.some(option => option.proof_of_delivery_type === "PIN_CODE") === true };
  }
  async function preview(args, signal) {
    const review = await readReview(args, signal); invalidate(args.cartId);
    for (const [id, value] of reviews) if (value.expiresAt < now()) reviews.delete(id);
    while (reviews.size >= 64) reviews.delete(reviews.keys().next().value);
    const confirmationId = review.canSubmit ? crypto.randomUUID() : null;
    if (confirmationId) reviews.set(confirmationId, { args: structuredClone(args), terms: fingerprint(review.terms), cardId: review.value.payment_method.card_id,
      pinRequired: review.pinRequired, tipCents: review.tip, expiresAt: now() + 5 * 60_000 });
    return { ...review.value, confirmationId, canSubmit: review.canSubmit, pinHandoffRequired: review.pinRequired,
      requiresTipChoice: review.terms.mode === "DELIVERY" && args.tipCents === undefined,
      totalIncludingTip: review.canSubmit ? { unit_amount: review.terms.totalBeforeTip.unit_amount + review.tip, currency: review.terms.totalBeforeTip.currency } : null,
      nextAction: review.canSubmit ? "Confirm every term, the explicit tip and named card before submit_order." : "Choose a tip and preview again, or use checkout_url for unsupported or scheduled checkout." };
  }
  async function submit(args, signal) {
    const reviewed = reviews.get(args.confirmationId);
    if (!reviewed || reviewed.expiresAt < now() || reviewed.pinRequired && args.pinAccepted !== true) fail("OFFICIAL_SKILL_PURCHASE_REVIEW_REQUIRED");
    const current = await readReview({ ...reviewed.args, intent: args.intent }, signal);
    if (!current.canSubmit || fingerprint(current.terms) !== reviewed.terms) { invalidate(reviewed.args.cartId); fail("OFFICIAL_SKILL_PURCHASE_REVIEW_REQUIRED"); }
    invalidate(reviewed.args.cartId);
    const result = await guardedWrite("doordash:submit", { cartId: reviewed.args.cartId }, () => invoke(["order", "submit", "--cart-uuid", reviewed.args.cartId,
      "--tip-cents", String(reviewed.tipCents), "--card-id", reviewed.cardId, "--yes", ...(reviewed.args.priority ? ["--priority"] : []),
      ...(reviewed.args.noApplyCredits ? ["--no-apply-credits"] : [])], args.intent, signal), { keepCompleted: true });
    return { ...result, placementConfirmed: false, nextAction: "Read order_status for the returned order_uuid. Do not repeat submission." };
  }
  async function execute(name, args, signal) {
    auth.token();
    if (name === "preview_order") return preview(args, signal);
    if (name === "submit_order") return submit(args, signal);
    const commands = {
      list_addresses: ["address", "list"], list_payment_methods: ["payment-method", "list"],
      search_stores: ["search", "--query", args.query, ...(args.addressId ? ["--address-id", args.addressId] : []), ...(args.limit ? ["--limit", String(args.limit)] : []), ...(args.dashpassOnly ? ["--dashpass-only"] : []), ...(args.maxEtaMinutes ? ["--max-eta-minutes", String(args.maxEtaMinutes)] : [])],
      get_menu: ["menu", "--store-id", args.storeId, ...(args.addressId ? ["--address-id", args.addressId] : [])],
      get_restaurant_item: ["restaurant-item-details", "--store-id", args.storeId, "--menu-id", args.menuId, "--item-id", args.itemId?.replace(/^i_/u, ""), ...(args.addressId ? ["--address-id", args.addressId] : [])],
      list_carts: ["cart", "list", ...(args.storeId ? ["--store-id", args.storeId] : [])],
      get_cart: ["cart", "show", "--cart-uuid", args.cartId],
      remove_cart_item: ["cart", "remove-item", "--cart-uuid", args.cartId, "--cart-item-id", args.cartItemId],
      delete_cart: ["cart", "delete", "--cart-uuid", args.cartId],
      order_status: ["order", "status", "--order-uuid", args.orderId],
      order_history: ["order", "history", ...(args.max ? ["--max", String(args.max)] : []), ...(args.days ? ["--days", String(args.days)] : [])],
      reorder: ["order", "reorder", "--order-uuid", args.orderId],
      checkout_url: ["order", "checkout-url", "--cart-uuid", args.cartId],
    };
    if (name === "add_cart_items") {
      if (args.cartId) { const cart = await personalCart(args.cartId, args.intent, signal); if (String(cart.store_id) !== args.storeId) fail(); }
      else { const existing = await collision(args.storeId, args.intent, signal); if (existing) return existing; }
      commands[name] = ["cart", "add-items", "--store-id", args.storeId, "--menu-id", args.menuId, "--items-json", JSON.stringify(args.items),
        ...(args.cartId ? ["--cart-uuid", args.cartId] : []), ...(args.fulfillment ? ["--fulfillment", args.fulfillment] : [])];
    }
    if (name === "reorder") {
      if (knownOrders.get(args.orderId) !== args.storeId) fail("OFFICIAL_SKILL_PURCHASE_REVIEW_REQUIRED");
      const existing = await collision(args.storeId, args.intent, signal); if (existing) return existing;
    }
    const write = ["add_cart_items", "remove_cart_item", "delete_cart", "reorder"].includes(name);
    if (write && args.cartId) { if (name !== "add_cart_items") await personalCart(args.cartId, args.intent, signal); invalidate(args.cartId); }
    const { intent, ...identity } = args;
    const result = write ? await guardedWrite(`doordash:${name}`, identity, async () => {
      const result = await invoke(commands[name], intent, signal);
      // A partial add can already have changed quantities. Keep the durable
      // unknown-result fence and reconcile with get_cart instead of retrying.
      if (result.success === false || result.item_errors?.length
        || name === "add_cart_items" && (result.success !== true || typeof result.cart_uuid !== "string" || !result.cart)) fail("OFFICIAL_SKILL_OPERATION_UNCERTAIN");
      return result;
    }) : await invoke(commands[name], intent, signal);
    if (name === "order_history" && Array.isArray(result.orders)) {
      knownOrders.clear(); for (const order of result.orders) if (typeof order.order_uuid === "string" && order.store_id != null) knownOrders.set(order.order_uuid, String(order.store_id));
    }
    return result;
  }
  return { async account(action, args, signal) {
    if (action === "logout") { auth.logout(); reviews.clear(); knownOrders.clear(); return account("signedOut"); }
    if (action === "start") { reviews.clear(); const { state, ...fields } = await auth.start(signal); return account(state, fields); }
    if (action === "bind") { await auth.finish(args.code, signal); }
    else { const flow = auth.pending(); if (flow) return account(flow.state, { verificationUrl: flow.verificationUrl }); }
    if (!auth.hasToken()) return account("signedOut");
    try { await invoke(["address", "list"], "Check this user's DoorDash account access", signal); return account("ready"); }
    catch (error) {
      if (["OFFICIAL_SKILL_INTEGRITY_FAILED", "OFFICIAL_SKILL_RUNTIME_MISSING"].includes(error.code)) throw error;
      return account(error.code === "OFFICIAL_SKILL_DOORDASH_AUTH_REQUIRED" ? "signedOut" : "unknown", { errorCode: error.code === "OFFICIAL_SKILL_APPROVAL_REQUIRED" ? error.code : "OFFICIAL_SKILL_AUTH_STATUS_FAILED" });
    }
  }, async call(name, args, { signal } = {}) { return publicDoorDashOutput(await execute(name, args, signal)); } };
}
module.exports = { TOOL_DEFS, createDoorDashAdapter, publicDoorDashOutput };
