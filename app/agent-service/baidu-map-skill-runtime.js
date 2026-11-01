"use strict";

const fail = (code = "OFFICIAL_SKILL_INVALID_ARGUMENT") => { throw Object.assign(new Error(code), { code }); };
const text = maxLength => ({ type: "string", minLength: 1, maxLength });
const coordinate = { ...text(64), description: "Trusted GCJ-02 latitude,longitude, each with at least six decimal places. Obtain coordinates from the user or a previous map result; never invent them." };
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const TOOL_DEFS = [
  ["place", "Find places using the complete original request, preserving every filter and constraint. Results may include details, photos and reviews. Do not repeat an identical successful request.", object({ user_raw_request: text(8000), region: text(128), center: coordinate, sort: { enum: ["distance", "relevance"] } }, ["user_raw_request", "region"])],
  ["direction", "Plan a driving, walking, cycling or transit trip from the complete request, including waypoints or an along-route search. A successful response may instead ask to clarify a place; preserve its candidates and resolve the ambiguity before claiming a route exists. Use refer_pois with the selected name, UID and trusted coordinates when clarifying.", object({ user_raw_request: text(8000), location: coordinate,
    refer_pois: { ...text(8192), description: "Only for place or alias disambiguation: name:uid,latitude,longitude;name:uid,latitude,longitude. Preserve the returned UID and at least six decimal places." } }, ["user_raw_request", "location"])],
  ["geocoding", "Resolve a complete address to trusted GCJ-02 coordinates. Preserve multiple candidates and address precision.", object({ address: text(1000), region: text(128) }, ["address"])],
  ["reverse_geocoding", "Resolve trusted GCJ-02 coordinates to an address, administrative divisions and nearby places.", object({ location: coordinate }, ["location"])],
  ["weather", "Read actual weather and forecasts by region or trusted GCJ-02 coordinates. Supply at least one of region or location; retain the provider's forecast horizon, warnings and units.", { ...object({ region: text(128), location: coordinate }), anyOf: [{ required: ["region"] }, { required: ["location"] }] }],
  ["map_render", "Return a map link only when the user explicitly asks to see results on a map. resource_key must come from this connection's recent place result or completed direction result. Clarification candidates cannot be rendered as a completed route. This does not open a browser.", object({ resource_key: text(2048) }, ["resource_key"])],
];
const ENDPOINTS = new Set(["place", "direction", "geocoding", "reverse_geocoding", "weather"]);
const MAX_RESPONSE = 4 * 1024 * 1024;
const cancelBody = response => { try { response.body?.cancel?.()?.catch?.(() => {}); } catch {} };

function validCoordinate(value) {
  if (typeof value !== "string" || !/^-?\d{1,3}\.\d{6,},-?\d{1,3}\.\d{6,}$/u.test(value)) return false;
  const [latitude, longitude] = value.split(",").map(Number);
  return Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
}
async function readResponse(response) {
  if (Number(response.headers?.get?.("content-length") || 0) > MAX_RESPONSE) { cancelBody(response); fail("OFFICIAL_SKILL_UNAVAILABLE"); }
  let bytes;
  if (response.body?.getReader) {
    const reader = response.body.getReader(), chunks = []; let length = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        length += value.length;
        if (length > MAX_RESPONSE) { reader.cancel().catch(() => {}); fail("OFFICIAL_SKILL_UNAVAILABLE"); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    bytes = Buffer.concat(chunks);
  } else bytes = Buffer.from(await response.text());
  if (bytes.length > MAX_RESPONSE) fail("OFFICIAL_SKILL_UNAVAILABLE");
  let value; try { value = JSON.parse(bytes.toString("utf8")); } catch { fail("OFFICIAL_SKILL_UNAVAILABLE"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.status !== 0) fail("OFFICIAL_SKILL_UNAVAILABLE");
  return value;
}

function createBaiduMapAdapter({ fetch, env, account, now = Date.now }) {
  const resources = new Map();
  async function call(name, args, signal) {
    signal?.throwIfAborted();
    for (const [key, resource] of resources) if (resource.expires <= now()) resources.delete(key);
    if (name === "map_render") {
      const resource = resources.get(args.resource_key);
      if (!resource) fail();
      const url = new URL("https://lbs.baidu.com/mapstatic/agentui_resource.html");
      url.searchParams.set("resource_key", args.resource_key);
      return { url: url.href, source: resource.source };
    }
    if (!ENDPOINTS.has(name)) fail();
    for (const field of ["center", "location"]) if (args[field] !== undefined && !validCoordinate(args[field])) fail();
    if (args.sort === "distance" && !args.center) fail();
    if (args.refer_pois !== undefined) {
      for (const poi of args.refer_pois.split(";")) {
        const colon = poi.lastIndexOf(":"), parts = poi.slice(colon + 1).split(",");
        if (colon < 1 || colon > 256 || parts.length !== 3 || !/^[A-Za-z0-9_-]{1,128}$/u.test(parts[0]) || !validCoordinate(parts.slice(1).join(","))) fail();
      }
    }
    const token = env.BAIDU_MAP_AUTH_TOKEN;
    if (!token || !/^[\x21-\x7e]{1,8192}$/u.test(token)) fail("OFFICIAL_SKILL_AUTH_UNSUPPORTED");
    const url = new URL(`https://api.map.baidu.com/agent_plan/v1/${name}`);
    for (const [key, value] of Object.entries(args)) url.searchParams.set(key, value);
    let response;
    try {
      response = await fetch(url.href, { method: "GET", redirect: "error", headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60_000)]) });
    } catch { signal?.throwIfAborted(); fail("OFFICIAL_SKILL_UNAVAILABLE"); }
    if (!response.ok) {
      cancelBody(response);
      fail(response.status === 429 ? "OFFICIAL_SKILL_RATE_LIMITED" : [401, 403].includes(response.status) ? "OFFICIAL_SKILL_AUTH_FAILED" : "OFFICIAL_SKILL_UNAVAILABLE");
    }
    const result = await readResponse(response);
    if (typeof result.resource_key === "string" && result.resource_key.length > 0 && result.resource_key.length <= 2048
      && (name === "place" && Array.isArray(result.results) && result.results.length > 0 || name === "direction" && result.result?.answer_type === "gptmodel_navigate")) {
      if (resources.size >= 64) resources.delete(resources.keys().next().value);
      resources.set(result.resource_key, { source: name, expires: now() + 30 * 60_000 });
    }
    return result;
  }
  async function accountAction(action, _args, signal) {
    if (action !== "status") return account("unknown", { errorCode: "OFFICIAL_SKILL_AUTH_UNSUPPORTED" });
    if (!env.BAIDU_MAP_AUTH_TOKEN) return account("signedOut");
    await call("weather", { region: "北京市" }, signal);
    return account("ready");
  }
  return { call, account: accountAction, close: () => resources.clear() };
}
module.exports = { TOOL_DEFS, createBaiduMapAdapter, validCoordinate };
