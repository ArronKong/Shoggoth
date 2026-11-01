"use strict";

const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");
const { validOfficialVerificationUrl } = require("../core/official-skill-connector-dto");
const object = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const text = (maxLength = 2048) => ({ type: "string", minLength: 1, maxLength, pattern: "^[^\\u0000-\\u001f\\u007f]+$" });
const date = { ...text(10), pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
const positive = (maximum = 100) => ({ type: "integer", minimum: 1, maximum });
const nonnegative = { type: "integer", minimum: 0, maximum: 20 };
const hotelId = positive(Number.MAX_SAFE_INTEGER), confirmed = { const: true }, confirmationId = { ...text(36), pattern: "^[a-f0-9-]{36}$" };
const strings = { type: "array", items: text(100), minItems: 1, maxItems: 20, uniqueItems: true };
const ages = { type: "array", items: { type: "integer", minimum: 0, maximum: 17 }, maxItems: 20 };
const stay = { checkInDate: date, checkOutDate: date, roomCount: positive(20), adultCount: positive(20), childCount: nonnegative, childAgeDetails: ages };
const write = (name, description, fields, required) => [name, description, object({ ...fields, confirmed }, [...required, "confirmed"]), true];
const TOOL_DEFS = [
  ["hotel_tags", "Read RollingGo hotel filter tags for the user's requested amenities.", object()],
  ["search_hotels", "Search hotels with the exact destination, dates, tags, brands and budget. Prices are indicative; do not silently relax required filters.", object({ originQuery: text(2000), place: text(300), placeType: { enum: ["城市", "机场", "景点", "火车站", "地铁站", "酒店", "区/县", "详细地址"] }, size: positive(20), checkInDate: date, stayNights: positive(365), adultCount: positive(20), starRatings: { type: "array", items: { type: "number", minimum: 0, maximum: 5 }, minItems: 2, maxItems: 2 }, distanceInMeter: positive(1000000), requiredTags: strings, preferredBrands: strings, maxPricePerNight: { type: "number", exclusiveMinimum: 0, maximum: 10000000 } }, ["originQuery", "place", "placeType"])],
  ["hotel_detail", "Read room availability, current prices and actual cancellation policies for a hotel selected from search.", object({ hotelId, ...stay, cancelPolicy: { enum: ["CANCELABLE", "NON_CANCELABLE"] }, mealType: { enum: ["WITH_BREAKFAST", "SINGLE_BREAKFAST", "DOUBLE_BREAKFAST", "NO_MEAL"] } }, ["hotelId", "checkInDate", "checkOutDate"])],
  write("price_confirm", "Lock the chosen room price only after the user explicitly selects it. Show the returned total, currency, dates and cancellation policy, then obtain a second confirmation before book. The confirmationId expires in 15 minutes.", { hotelId, ratePlanId: text(2048), ...stay }, ["hotelId", "ratePlanId", "checkInDate", "checkOutDate", "roomCount", "adultCount"]),
  write("book", "Create one unpaid order from this connector's unexpired price confirmationId after the user confirms the exact total, dates, guests and policy. Return the actual payment link for the user. Never treat creation as payment or repeat an uncertain booking.", { confirmationId, firstName: text(100), lastName: text(100), email: { ...text(254), pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$" }, guestList: { type: "array", minItems: 1, maxItems: 20, items: object({ roomNum: positive(20), guestInfo: { type: "array", minItems: 1, maxItems: 40, items: object({ firstName: text(100), lastName: text(100), isAdult: { type: "boolean" } }, ["firstName", "lastName", "isAdult"]) } }, ["roomNum", "guestInfo"]) }, customerRequest: text(2000) }, ["confirmationId", "firstName", "lastName", "email", "guestList"]),
  ["orders", "Read the authorized account's hotel orders. Use these to reconcile an uncertain booking without submitting another order.", object({ status: { enum: ["ALL", "PENDING", "FINISHED"] }, startDate: date, endDate: date })],
  ["order_detail", "Read the actual booking and payment status of one order.", object({ orderNo: text(128) }, ["orderNo"])],
  ["pre_cancel", "Read cancellation eligibility and penalties. Show the actual penalty and refund basis and ask again before confirm_cancel. Does not cancel the order.", object({ orderNo: text(128) }, ["orderNo"])],
  write("confirm_cancel", "Irreversibly cancel the exact order from this connector's unexpired pre_cancel confirmationId only after the user agrees to the penalty. Never repeat an uncertain cancellation or invent a refund date.", { confirmationId, description: text(1000) }, ["confirmationId"]),
];
const fail = (code = "OFFICIAL_SKILL_INVALID_ARGUMENT") => { throw Object.assign(new Error(code), { code }); };
const dataOf = result => result?.data && typeof result.data === "object" ? result.data : result;
function createRollingGoAdapter({ root, home, run, now = Date.now, account, guardedWrite, stopActiveChildren, parseJson }) {
  const statePath = path.join(home, "rollinggo-receipts.json");
  let pending = null;
  const save = state => atomicWritePrivateFile(statePath, JSON.stringify(state), { trustedRoot: root });
  function load() {
    if (!fs.existsSync(statePath)) return { schemaVersion: 1, receipts: {} };
    const state = JSON.parse(readPrivateFile(statePath, { maxBytes: 512 * 1024 }));
    if (state?.schemaVersion !== 1 || !state.receipts || Array.isArray(state.receipts) || typeof state.receipts !== "object"
      || Object.keys(state.receipts).length > 1000) fail("OFFICIAL_SKILL_INTEGRITY_FAILED");
    return state;
  }
  function remember(receipt, ttl) {
    const state = load();
    for (const [key, value] of Object.entries(state.receipts)) if (value.expires <= now()) delete state.receipts[key];
    if (Object.keys(state.receipts).length >= 1000) fail("OFFICIAL_SKILL_PURCHASE_REVIEW_REQUIRED");
    const id = crypto.randomUUID(); state.receipts[id] = { ...receipt, expires: now() + ttl }; save(state); return id;
  }
  function receipt(id, kind) {
    const item = load().receipts[id];
    if (!item || item.kind !== kind || !Number.isFinite(item.expires) || item.expires <= now()) fail("OFFICIAL_SKILL_PURCHASE_REVIEW_REQUIRED");
    return item;
  }
  async function invoke(operation, params, signal, sideEffect = false, options = {}) {
    const result = await run("", ["--root", root, "--home", home], { applicationHelper: true, rawInput: JSON.stringify({ operation, params }), signal, sideEffect, ...options });
    if (result.authorization) return result;
    const value = parseJson(result.stdout);
    if (result.code !== 0 || !value || value.success === false || value.isError || value.error || value.errorCode) {
      fail(value?.errorCode === "OFFICIAL_SKILL_ROLLINGGO_AUTH_REQUIRED" ? value.errorCode : "OFFICIAL_SKILL_AUTH_FAILED");
    }
    return value;
  }
  async function accountAction(action, args, signal) {
    if (args.code !== undefined || action === "bind") fail();
    if (["start", "logout"].includes(action)) {
      await stopActiveChildren(); pending = null; save({ schemaVersion: 1, receipts: {} });
      if (action === "logout") { await invoke("logout", {}, signal); return account("signedOut"); }
      await invoke("logout", {}, signal);
      const result = await invoke("login", {}, signal, false, { timeoutMs: 330_000, onAuthorization: stdout => {
        for (const line of stdout.split(/\r?\n/u)) {
          const value = parseJson(line)?.verificationUrl;
          if (validOfficialVerificationUrl("rollinggo-hotel", value)) return value;
        }
        return null;
      } });
      if (result.authorization) { pending = { url: result.authorization, expires: now() + 5 * 60_000 }; return account("authorizing", { verificationUrl: pending.url }); }
    }
    const state = await invoke("status", {}, signal);
    if (state.authenticated === true) { pending = null; return account("ready", { userName: state.userName || null }); }
    if (pending && pending.expires > now()) return account("authorizing", { verificationUrl: pending.url });
    const expired = !!pending; pending = null;
    return account("signedOut", { errorCode: expired ? "OFFICIAL_SKILL_AUTH_FAILED" : null });
  }
  function validateStay(args) {
    for (const dateValue of [args.checkInDate, args.checkOutDate].filter(Boolean)) {
      const time = Date.parse(dateValue);
      if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== dateValue) fail();
    }
    if (args.checkOutDate && args.checkOutDate <= args.checkInDate) fail();
    if (args.childCount !== undefined && args.childCount !== (args.childAgeDetails || []).length || args.childAgeDetails?.length && args.childCount === undefined) fail();
  }
  const occupancy = args => ({ roomCount: args.roomCount || 1, adultCount: args.adultCount || 2, childCount: args.childCount || 0, ...(args.childAgeDetails ? { childAgeDetails: args.childAgeDetails } : {}) });
  async function call(name, args, signal) {
    validateStay(args);
    if (name === "search_hotels") {
      if (args.starRatings && args.starRatings[0] > args.starRatings[1]) fail();
      return invoke(name, { originQuery: args.originQuery, place: args.place, placeType: args.placeType, size: args.size || 5,
        checkInParam: { ...(args.checkInDate ? { checkInDate: args.checkInDate } : {}), stayNights: args.stayNights || 1, adultCount: args.adultCount || 2 },
        filterOptions: { ...(args.starRatings ? { starRatings: args.starRatings } : {}), ...(args.distanceInMeter ? { distanceInMeter: args.distanceInMeter } : {}) },
        hotelTags: { ...(args.requiredTags ? { requiredTags: args.requiredTags } : {}), ...(args.preferredBrands ? { preferredBrands: args.preferredBrands } : {}), ...(args.maxPricePerNight ? { maxPricePerNight: args.maxPricePerNight } : {}) } }, signal);
    }
    if (name === "hotel_detail") return invoke(name, { hotelId: args.hotelId, dateParam: { checkInDate: args.checkInDate, checkOutDate: args.checkOutDate }, occupancyParam: occupancy(args),
      filter: { ...(args.cancelPolicy ? { cancelPolicy: args.cancelPolicy } : {}), ...(args.mealType ? { mealType: args.mealType } : {}) } }, signal);
    if (name === "price_confirm") {
      const group = occupancy(args), params = { hotelID: args.hotelId, ratePlanID: args.ratePlanId, numOfRooms: group.roomCount,
        dateParam: { checkInDate: args.checkInDate, checkOutDate: args.checkOutDate }, occupancyDetails: Array.from({ length: group.roomCount }, (_, i) => ({ roomNum: i + 1, adultCount: group.adultCount, childCount: group.childCount, ...(group.childAgeDetails ? { childAgeDetails: group.childAgeDetails } : {}) })) };
      return guardedWrite("rollinggo-price", params, async () => {
        const result = await invoke(name, params, signal, true), info = dataOf(result)?.priceDetailsInfo;
        if (typeof info?.referenceNo !== "string" || !info.referenceNo || !Array.isArray(info.hotelList) || !info.hotelList.length
          || info.hotelList.some(hotel => !Number.isFinite(hotel.totalPrice) || hotel.totalPrice < 0)) fail("OFFICIAL_SKILL_PURCHASE_REVIEW_REQUIRED");
        return { ...result, confirmationId: remember({ kind: "price", referenceNo: info.referenceNo, group }, 15 * 60_000), confirmationRequired: true };
      });
    }
    if (name === "book") {
      const quote = receipt(args.confirmationId, "price"), group = quote.group;
      if (args.guestList.length !== group.roomCount || new Set(args.guestList.map(room => room.roomNum)).size !== group.roomCount
        || args.guestList.some(room => room.roomNum > group.roomCount || room.guestInfo.filter(guest => guest.isAdult).length !== group.adultCount
          || room.guestInfo.filter(guest => !guest.isAdult).length !== group.childCount)) fail();
      const params = { referenceNo: quote.referenceNo, contact: { firstName: args.firstName, lastName: args.lastName, email: args.email }, guestList: args.guestList,
        ...(args.customerRequest ? { customerRequest: args.customerRequest } : {}) };
      return guardedWrite("rollinggo-book", quote.referenceNo, async () => {
        const result = await invoke(name, params, signal, true), booking = dataOf(result)?.bookingResult;
        if (typeof booking?.orderNo !== "string" || !booking.orderNo || typeof booking.paymentUrl !== "string") fail("OFFICIAL_SKILL_OPERATION_UNCERTAIN");
        const url = new URL(booking.paymentUrl); if (url.protocol !== "https:" || url.username || url.password) fail("OFFICIAL_SKILL_OPERATION_UNCERTAIN");
        return result;
      }, { keepCompleted: true });
    }
    if (name === "orders") return invoke(name, { ...(args.status ? { status: args.status } : {}), ...(args.startDate || args.endDate ? { dateRange: { ...(args.startDate ? { startDate: args.startDate } : {}), ...(args.endDate ? { endDate: args.endDate } : {}) } } : {}) }, signal);
    if (name === "pre_cancel") {
      const result = await invoke(name, args, signal), data = dataOf(result);
      if (data?.canCancel !== true) return result;
      if (typeof data.confirmId !== "string" || !data.confirmId || !["string", "number"].includes(typeof data.bookingId)
        || !Number.isFinite(data.penaltyAmount) || data.penaltyAmount < 0) fail("OFFICIAL_SKILL_PURCHASE_REVIEW_REQUIRED");
      return { ...result, confirmationId: remember({ kind: "cancel", orderNo: args.orderNo, bookingId: data.bookingId, confirmId: data.confirmId }, 10 * 60_000), confirmationRequired: true };
    }
    if (name === "confirm_cancel") {
      const item = receipt(args.confirmationId, "cancel"), params = { orderNo: item.orderNo, bookingId: item.bookingId, confirmId: item.confirmId, ...(args.description ? { description: args.description } : {}) };
      return guardedWrite("rollinggo-cancel", item.orderNo, async () => {
        const result = await invoke(name, params, signal, true);
        if (dataOf(result)?.success !== true && result.success !== true) fail("OFFICIAL_SKILL_OPERATION_UNCERTAIN");
        return result;
      }, { keepCompleted: true });
    }
    return invoke(name, args, signal);
  }
  return { account: accountAction, call };
}
module.exports = { TOOL_DEFS, createRollingGoAdapter };
