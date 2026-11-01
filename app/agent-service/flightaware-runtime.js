"use strict";

const fs = require("node:fs"), path = require("node:path"), { spawn } = require("node:child_process");
const { resolveOnPath } = require("./mcp-package-launcher");
const { CLI_ENTRY, KEY_FIELD, METERED_FIELD, METERED_ENABLED } = require("./flightaware-mcp-launch");
const VERSION = "0.2.1";
const fail = (code, status) => Object.assign(new Error(code), { code, ...(status ? { status } : {}) });
const string = (description, maxLength = 256) => ({ type: "string", minLength: 1, maxLength, description });
const identifier = description => ({ ...string(description), pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]*$" });
const enumeration = (description, values) => ({ type: "string", enum: values, description });
const windowFields = { start: string("YYYY-MM-DD (UTC) or ISO 8601 with timezone.", 64), end: string("Exclusive end, after start.", 64) };
const cursor = { cursor: string("Opaque cursor returned by the previous single page. Never pass a URL.", 2048) };
const flightId = { flight_id: identifier("FlightAware fa_flight_id from a flight result; not a flight number.") };
const airport = { airport: identifier("Airport code, preferably ICAO, such as KJFK.") };
const operator = { operator: identifier("Airline/operator ICAO code, such as UAL.") };
const definitions = [
  ["get_flight", "Look up flight status, times, gates, route endpoints and aircraft by ident. A date means a UTC day; do not combine date with start/end.", "flight", { ident: identifier("Flight number/registration/fa_flight_id, e.g. UAL123."), date: string("Departure UTC day YYYY-MM-DD.", 10), ident_type: enumeration("Ident type.", ["designator", "registration", "fa_flight_id"]), ...windowFields, ...cursor }, ["ident"], ["ident"], "flights"],
  ["get_flight_ident", "Resolve canonical flight identifiers.", "canonical-flight", { ident: identifier("Flight ident.") }, ["ident"], ["ident"]],
  ["get_position", "Get the most recent flight position.", "position", flightId, ["flight_id"], ["flight_id"]],
  ["get_track", "Get flight track points. Large tracks are bounded and explicitly marked when truncated.", "track", { ...flightId, include_estimated_positions: { type: "boolean", description: "Include estimated positions when supported." } }, ["flight_id"], ["flight_id"], "positions"],
  ["get_route", "Get a flight's filed route.", "route", flightId, ["flight_id"], ["flight_id"]],
  ["get_map", "Get a static flight-track map as an image. This does not write a file. Oversized images are rejected without retrying.", "map", { ...flightId, width: { type: "integer", minimum: 64, maximum: 640, default: 640 }, height: { type: "integer", minimum: 64, maximum: 480, default: 480 } }, ["flight_id"], ["flight_id"], "map"],
  ["search_flights", "Search flights with FlightAware query syntax. Use advanced=true for advanced syntax. Fetches at most one page.", "search", { query: string("Provider query syntax, e.g. -origin KJFK -destination KLAX.", 2048), advanced: { type: "boolean" }, ...cursor }, ["query"], ["query"], "flights"],
  ["get_schedules", "Get published schedules for a window of at most 21 days, optionally filtered by origin, destination or airline.", "schedules", { date_start: string("Start date/time with timezone or YYYY-MM-DD.", 64), date_end: string("Exclusive end date/time.", 64), origin: identifier("Origin airport."), destination: identifier("Destination airport."), airline: identifier("Airline code."), flight_number: { type: "integer", minimum: 1, maximum: 99999 }, ...cursor }, ["date_start", "date_end"], ["date_start", "date_end"], "scheduled"],
  ["get_airport", "Get airport metadata.", "airport", airport, ["airport"], ["airport"]],
  ["get_airport_flights", "Get airport arrivals, departures or scheduled flights; at most one page.", "airport-flights", { ...airport, kind: enumeration("Flight board.", ["all", "arrivals", "departures", "scheduled-departures", "scheduled-arrivals"]), airline: identifier("Airline code."), ...windowFields, ...cursor }, ["airport", "kind"], ["airport", "kind"]],
  ["get_airport_delays", "Get airport delay information.", "airport-delays", airport, ["airport"], ["airport"]],
  ["get_airport_weather", "Get airport weather observations or forecast.", "airport-weather", { ...airport, kind: enumeration("Weather type.", ["observations", "forecast"]) }, ["airport", "kind"], ["airport", "kind"]],
  ["get_airport_counts", "Get airport flight counts.", "airport-counts", airport, ["airport"], ["airport"]],
  ["get_operator", "Get airline/operator metadata.", "operator", operator, ["operator"], ["operator"]],
  ["get_operator_flights", "Get airline/operator flights; at most one page.", "operator-flights", { ...operator, kind: enumeration("Flight group.", ["all", "scheduled", "arrivals", "enroute"]), ...windowFields, ...cursor }, ["operator", "kind"], ["operator", "kind"]],
  ["get_operator_counts", "Get airline/operator flight counts.", "operator-counts", operator, ["operator"], ["operator"]],
  ["get_disruptions", "Get delay/cancellation statistics for an airline, origin or destination.", "disruptions", { entity_type: enumeration("Entity group.", ["airline", "origin", "destination"]), id: identifier("Optional airline/airport code; omit for global results."), time_period: enumeration("Time period.", ["yesterday", "today", "tomorrow", "plus2days", "twoDaysAgo", "minus2plus12hrs", "next36hrs", "week"]) }, ["entity_type"], ["entity_type", "id"]],
  ["check_aircraft_blocked", "Check whether an aircraft is blocked from public tracking.", "aircraft-blocked", { ident: identifier("Aircraft ident/registration.") }, ["ident"], ["ident"]],
  ["get_aircraft_owner", "Get publicly provided aircraft owner information, subject to provider permissions.", "aircraft-owner", { ident: identifier("Aircraft ident/registration.") }, ["ident"], ["ident"]],
  ["get_usage", "Get account usage via the provider's documented $0 endpoint. Usage can lag by 10 minutes; it is not a real-time spending cap. This tool does not enable metered queries.", "status", {}, [], []],
];
const TOOLS = definitions.map(([suffix, description, , properties, required]) => ({ name: `flightaware_${suffix}`,
  description: description + (suffix === "get_usage" ? "" : " May incur AeroAPI charges; requires the user's saved metered-query permission. Never retry automatically or enable billing."),
  inputSchema: { type: "object", properties, required, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: suffix === "get_usage", openWorldHint: true } }));

function commandFor(name, input = {}) {
  const definition = definitions.find(value => `flightaware_${value[0]}` === name);
  if (!definition || !input || Object.getPrototypeOf(input) !== Object.prototype) throw fail("FLIGHTAWARE_INVALID_ARGUMENT");
  const [, , command, fields, required, positional] = definition;
  if (Object.keys(input).some(key => !Object.hasOwn(fields, key)) || required.some(key => input[key] === undefined)) throw fail("FLIGHTAWARE_INVALID_ARGUMENT");
  for (const [key, value] of Object.entries(input)) {
    const rule = fields[key];
    const invalid = rule.type === "integer" ? !Number.isInteger(value) || value < rule.minimum || value > rule.maximum
      : rule.type === "boolean" ? typeof value !== "boolean"
      : typeof value !== "string" || !value.trim() || value.length > (rule.maxLength || 256) || /[\u0000-\u001f\u007f]/u.test(value) || rule.enum && !rule.enum.includes(value) || rule.pattern && !new RegExp(rule.pattern, "u").test(value);
    if (invalid || key === "query" && Buffer.byteLength(value) > 1000) throw fail("FLIGHTAWARE_INVALID_ARGUMENT");
  }
  const args = [command === "search" && input.advanced ? "search-advanced" : command, "--json"];
  if (command === "status") args.push("--verify");
  if (["flight", "search", "schedules", "airport-flights", "operator-flights"].includes(command)) args.push("--max-pages=1");
  for (const [key, value] of Object.entries(input)) if (!positional.includes(key) && key !== "advanced") args.push(`--${key.replaceAll("_", "-")}=${value}`);
  // End option parsing before every positional, including search syntax starting
  // with a dash. A model-supplied string can never become an extra CLI option.
  if (positional.length) args.push("--", ...positional.filter(key => input[key] !== undefined).map(key => String(input[key])));
  return args;
}
function scrub(value, key) {
  if (typeof value === "string") {
    for (const secret of [key, encodeURIComponent(key), encodeURIComponent(key).replaceAll("%20", "+")]) if (secret) value = value.replaceAll(secret, "[REDACTED]");
    return value;
  }
  if (Array.isArray(value)) return value.map(item => scrub(item, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [scrub(name, key), scrub(item, key)]));
  return value;
}
function project(name, data) {
  if (!data || typeof data !== "object" || Array.isArray(data) || !Object.keys(data).length) throw fail("MCP_SERVER_RESPONSE_INVALID");
  const expected = definitions.find(value => `flightaware_${value[0]}` === name)?.[6];
  if (expected && (expected === "map" ? typeof data.map !== "string" : !Array.isArray(data[expected]))) throw fail("MCP_SERVER_RESPONSE_INVALID");
  if (expected === "map") {
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(data.map)) throw fail("MCP_SERVER_RESPONSE_INVALID");
    const bytes = Buffer.from(data.map, "base64");
    const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg" : null;
    if (!mimeType || bytes.toString("base64") !== data.map) throw fail("MCP_SERVER_RESPONSE_INVALID");
    if (data.map.length > 190 * 1024) throw fail("MCP_SERVER_RESPONSE_TOO_LARGE");
    return { map: data.map, mimeType };
  }
  let truncated = false;
  const bounded = (value, depth = 0) => {
    if (depth > 12) { truncated = true; return null; }
    if (Array.isArray(value)) { if (value.length > 1000) truncated = true; return value.slice(0, 1000).map(item => bounded(item, depth + 1)); }
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bounded(item, depth + 1)]));
    if (typeof value === "string" && value.length > 8192) { truncated = true; return value.slice(0, 8192); }
    return value;
  };
  const result = bounded(data);
  if (truncated) result.shoggoth_truncated = true;
  if (Buffer.byteLength(JSON.stringify(result)) > 190 * 1024) throw fail("MCP_SERVER_RESPONSE_TOO_LARGE");
  return result;
}

function createFlightawareRuntime({ env = process.env, spawnChild = spawn, timeoutMs = 40_000, cliSource = fs.readFileSync(CLI_ENTRY, "utf8"), resolvePython = () => resolveOnPath("python3", { PATH: [env.PATH || "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(path.delimiter) }) } = {}) {
  const active = new Set();
  let probe, closed = false;
  async function run(args, { signal } = {}) {
    if (args[0] !== "status" && env[METERED_FIELD] !== METERED_ENABLED) throw fail("FLIGHTAWARE_METERED_DISABLED");
    const key = (env[KEY_FIELD] || "").trim();
    if (!/^[\x21-\x7e]{1,1024}$/u.test(key)) throw fail("MCP_AUTH_REQUIRED");
    if (closed || signal?.aborted) throw fail("FLIGHTAWARE_CANCELLED");
    if (active.size >= 2) throw fail("FLIGHTAWARE_BUSY");
    let python;
    try { python = resolvePython(); } catch { throw fail("FLIGHTAWARE_PYTHON_REQUIRED"); }
    const childEnv = {};
    for (const name of ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]) {
      if (typeof env[name] === "string") childEnv[name] = env[name];
    }
    childEnv[KEY_FIELD] = key;
    // The bundled source can be read from app.asar. Python receives only fixed
    // application code in argv; the API key stays in the child environment.
    const program = 'import sys\nif sys.version_info < (3, 9):\n sys.exit(79)\n' + cliSource;
    let child;
    try { child = spawnChild(python, ["-I", "-B", "-c", program, ...(args[0] === "status" ? args : [args[0], "--allow-metered", ...args.slice(1)])], { env: childEnv, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { throw fail("FLIGHTAWARE_PYTHON_REQUIRED"); }
    const abort = new AbortController();
    const operation = { abort, done: null }; active.add(operation);
    const cancelled = () => abort.abort(); signal?.addEventListener("abort", cancelled, { once: true });
    operation.done = new Promise((resolve, reject) => {
      const chunks = []; let bytes = 0, reason, timer, killTimer;
      const stop = code => { reason ||= code; try { child.kill("SIGTERM"); } catch {} killTimer ||= setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 500); killTimer.unref?.(); };
      const onAbort = () => stop("FLIGHTAWARE_CANCELLED");
      abort.signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => stop("MCP_SERVER_TIMEOUT"), timeoutMs); timer.unref?.();
      child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) stop("MCP_SERVER_RESPONSE_TOO_LARGE"); else chunks.push(chunk); });
      child.stderr?.resume();
      child.once("error", () => { reason ||= "FLIGHTAWARE_PYTHON_REQUIRED"; });
      child.once("close", code => {
        clearTimeout(timer); clearTimeout(killTimer); abort.signal.removeEventListener("abort", onAbort);
        if (reason) { reject(fail(reason)); return; }
        if (code === 79) { reject(fail("FLIGHTAWARE_PYTHON_REQUIRED")); return; }
        let data; try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { reject(fail("MCP_SERVER_RESPONSE_INVALID")); return; }
        if (code !== 0 || !data || typeof data !== "object" || Array.isArray(data) || data.ok === false) {
          const status = Number.isInteger(data?.error?.status) ? data.error.status : undefined;
          const code = status === 401 ? "MCP_AUTH_REQUIRED" : status === 403 ? "FLIGHTAWARE_PLAN_REQUIRED" : status === 429 ? "FLIGHTAWARE_RATE_LIMITED"
            : data?.error?.code === "network_error" ? "MCP_SERVER_CONNECTION_FAILED" : data?.error?.code === "invalid_arguments" ? "FLIGHTAWARE_INVALID_ARGUMENT" : data?.error?.code === "response_too_large" ? "MCP_SERVER_RESPONSE_TOO_LARGE" : "MCP_SERVER_RESPONSE_INVALID";
          reject(fail(code, status)); return;
        }
        resolve(scrub(data, key));
      });
      if (signal?.aborted || closed) abort.abort();
    });
    try { return await operation.done; }
    finally { signal?.removeEventListener("abort", cancelled); active.delete(operation); }
  }
  return {
    tools: TOOLS,
    async listTools(options = {}) {
      // Only the documented $0 account-usage endpoint checks a saved key.
      // Subsequent discovery uses this result and never repeats a failed probe.
      probe ||= run(["status", "--verify", "--json"], options).then(data => { project("flightaware_get_usage", data); });
      await probe;
      return TOOLS;
    },
    async call(name, input, options = {}) {
      const args = commandFor(name, input);
      const data = await run(args, options);
      return project(name, data);
    },
    async close() { closed = true; const pending = [...active]; for (const item of pending) item.abort.abort(); await Promise.allSettled(pending.map(item => item.done)); },
  };
}


module.exports = { VERSION, TOOLS, commandFor, scrub, project, createFlightawareRuntime };
