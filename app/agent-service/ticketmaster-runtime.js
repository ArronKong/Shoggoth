"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { resolveOnPath } = require("./mcp-package-launcher");
const { CLI_ENTRY, KEY_FIELD } = require("./ticketmaster-mcp-launch");

const { ticketmaster: VERSION } = require("./data/mcp-bundled-bridge-versions.json");
const fail = (code, status) => Object.assign(new Error(code), { code, ...(status ? { status } : {}) });
const string = (description, maxLength = 256) => ({ type: "string", minLength: 1, maxLength, description });
const paging = { size: { type: "integer", minimum: 1, maximum: 20, default: 10 }, page: { type: "integer", minimum: 0, maximum: 999, default: 0 } };
const country = string("Two-letter country code. Defaults to US; select the user's requested market.", 2);
const definitions = [
  ["ticketmaster_search_events", "Search concerts, sports and theatre by date, location, artist or team. For concerts use classification_name=Music. keyword is optional, so recent concerts can be browsed without an artist name. Returns public price ranges, image URLs and official event links; no live seat inventory or purchases.", "search-events", {
    keyword: string("Optional artist, team or event keywords."), city: string("City name."), state_code: string("US state code.", 2), country_code: country,
    classification_name: string("Category such as Music, Sports or Arts & Theatre."), start_date: string("YYYY-MM-DD (UTC day) or ISO 8601 with a timezone.", 64),
    end_date: string("YYYY-MM-DD (UTC day) or ISO 8601 with a timezone.", 64), sort: { type: "string", enum: ["date,asc", "date,desc", "name,asc", "name,desc", "relevance,asc", "relevance,desc"] }, ...paging,
  }, []],
  ["ticketmaster_get_event_details", "Get one event's dates, venue, public price ranges, images, static seating map and official purchase-page link. Prices may be absent; a static seating map does not show live available seats.", "event-details", { event_id: string("Discovery event ID returned by search.") }, ["event_id"]],
  ["ticketmaster_search_venues", "Search venues by name, city and country.", "venues", { keyword: string("Venue name."), city: string("City name."), country_code: country, ...paging }, []],
  ["ticketmaster_search_attractions", "Search artists, bands, teams or other attractions.", "attractions", { keyword: string("Artist, band or team name."), classification_name: string("Category filter."), ...paging }, []],
  ["ticketmaster_get_event_images", "Get image URLs and dimensions for one event. Reuse images already returned by search/details when available to avoid another API request. Some images are marked as fallbacks.", "event-details", { event_id: string("Discovery event ID returned by search.") }, ["event_id"]],
];

const TOOLS = definitions.map(([name, description, , properties, required]) => ({ name, description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }));

function commandFor(name, input = {}) {
  const definition = definitions.find(value => value[0] === name);
  if (!definition || !input || Object.getPrototypeOf(input) !== Object.prototype) throw fail("TICKETMASTER_INVALID_ARGUMENT");
  const [, , command, fields, required] = definition;
  if (Object.keys(input).some(key => !Object.hasOwn(fields, key)) || required.some(key => input[key] === undefined)) throw fail("TICKETMASTER_INVALID_ARGUMENT");
  const args = [command, "--json"];
  for (const [key, value] of Object.entries(input)) {
    const rule = fields[key];
    if (rule.type === "integer" ? !Number.isInteger(value) || value < rule.minimum || value > rule.maximum
      : typeof value !== "string" || !value.trim() || value.length > (rule.maxLength || 256) || /[\u0000-\u001f\u007f]/u.test(value) || rule.enum && !rule.enum.includes(value)) throw fail("TICKETMASTER_INVALID_ARGUMENT");
    args.push(`--${key.replaceAll("_", "-")}=${value}`);
  }
  if (input.page && input.page * (input.size || 10) >= 1000) throw fail("TICKETMASTER_INVALID_ARGUMENT");
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

const pick = (value, names) => Object.fromEntries(names.filter(name => value?.[name] !== undefined).map(name => [name, value[name]]));
function images(value) {
  return (Array.isArray(value) ? value : []).slice(0, 20).map(image => pick(image, ["url", "width", "height", "ratio", "fallback", "attribution"]));
}
function entity(value) {
  const result = pick(value, ["id", "name", "type", "url", "city", "state", "country", "address", "location", "timezone", "classifications"]);
  if (Array.isArray(value?.images)) result.images = images(value.images);
  return result;
}
function event(value) {
  const result = pick(value, ["id", "name", "type", "url", "locale", "dates", "sales", "priceRanges", "seatmap", "classifications", "ticketLimit", "accessibility"]);
  for (const name of ["info", "pleaseNote", "additionalInfo"]) if (typeof value?.[name] === "string") result[name] = value[name].slice(0, 4096);
  if (Array.isArray(value?.images)) result.images = images(value.images);
  const embedded = {};
  for (const name of ["venues", "attractions"]) if (Array.isArray(value?._embedded?.[name])) embedded[name] = value._embedded[name].slice(0, 20).map(entity);
  if (Object.keys(embedded).length) result._embedded = embedded;
  return result;
}
function project(name, data, size = 10) {
  const details = ["ticketmaster_get_event_images", "ticketmaster_get_event_details"].includes(name);
  if (!data || details && typeof data.id !== "string" || !details && (!data.page || !Number.isInteger(data.page.totalElements))) throw fail("MCP_SERVER_RESPONSE_INVALID");
  let result;
  if (name === "ticketmaster_get_event_images") result = { ...pick(data, ["id", "name"]), images: images(data.images) };
  else if (name === "ticketmaster_get_event_details") result = event(data);
  else {
    const key = { ticketmaster_search_events: "events", ticketmaster_search_venues: "venues", ticketmaster_search_attractions: "attractions" }[name];
    const items = data?._embedded?.[key];
    result = { _embedded: { [key]: (Array.isArray(items) ? items : []).slice(0, size).map(key === "events" ? event : entity) }, page: data.page || {} };
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 190 * 1024) throw fail("MCP_SERVER_RESPONSE_TOO_LARGE");
  return result;
}

function createTicketmasterRuntime({ env = process.env, spawnChild = spawn, timeoutMs = 40_000, cliSource = fs.readFileSync(CLI_ENTRY, "utf8"), resolvePython = () => resolveOnPath("python3", { PATH: [env.PATH || "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(path.delimiter) }) } = {}) {
  const active = new Set();
  let probe, closed = false;
  async function run(args, { signal } = {}) {
    const key = (env[KEY_FIELD] || "").trim();
    if (!/^[\x21-\x7e]{1,1024}$/u.test(key)) throw fail("MCP_AUTH_REQUIRED");
    if (closed || signal?.aborted) throw fail("TICKETMASTER_CANCELLED");
    if (active.size >= 2) throw fail("TICKETMASTER_BUSY");
    let python;
    try { python = resolvePython(); } catch { throw fail("TICKETMASTER_PYTHON_REQUIRED"); }
    const childEnv = {};
    for (const name of ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]) {
      if (typeof env[name] === "string") childEnv[name] = env[name];
    }
    childEnv[KEY_FIELD] = key;
    // The bundled source can be read from app.asar. Python receives only fixed
    // application code in argv; the Consumer Key stays in the child environment.
    const program = 'import sys\nif sys.version_info < (3, 9):\n sys.exit(79)\n' + cliSource;
    let child;
    try { child = spawnChild(python, ["-I", "-B", "-c", program, ...args], { env: childEnv, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { throw fail("TICKETMASTER_PYTHON_REQUIRED"); }
    const abort = new AbortController();
    const operation = { abort, done: null }; active.add(operation);
    const cancelled = () => abort.abort(); signal?.addEventListener("abort", cancelled, { once: true });
    operation.done = new Promise((resolve, reject) => {
      const chunks = []; let bytes = 0, reason, timer, killTimer;
      const stop = code => { reason ||= code; try { child.kill("SIGTERM"); } catch {} killTimer ||= setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 500); killTimer.unref?.(); };
      const onAbort = () => stop("TICKETMASTER_CANCELLED");
      abort.signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => stop("MCP_SERVER_TIMEOUT"), timeoutMs); timer.unref?.();
      child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) stop("MCP_SERVER_RESPONSE_TOO_LARGE"); else chunks.push(chunk); });
      child.stderr?.resume();
      child.once("error", () => { reason ||= "TICKETMASTER_PYTHON_REQUIRED"; });
      child.once("close", code => {
        clearTimeout(timer); clearTimeout(killTimer); abort.signal.removeEventListener("abort", onAbort);
        if (reason) { reject(fail(reason)); return; }
        if (code === 79) { reject(fail("TICKETMASTER_PYTHON_REQUIRED")); return; }
        let data; try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { reject(fail("MCP_SERVER_RESPONSE_INVALID")); return; }
        if (code !== 0 || !data || typeof data !== "object" || Array.isArray(data) || data.ok === false) {
          const status = Number.isInteger(data?.error?.status) ? data.error.status : undefined;
          const code = status === 401 || status === 403 ? "MCP_AUTH_REQUIRED" : status === 429 ? "TICKETMASTER_RATE_LIMITED"
            : data?.error?.code === "network_error" ? "MCP_SERVER_CONNECTION_FAILED" : data?.error?.code === "invalid_arguments" ? "TICKETMASTER_INVALID_ARGUMENT" : "MCP_SERVER_RESPONSE_INVALID";
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
      // One ordinary Discovery call checks the saved key per server process.
      // Subsequent discovery uses this result and never repeats a failed probe.
      probe ||= run(["search-events", "--classification-name=Music", "--size=1", "--json"], options).then(data => {
        if (!data.page || !Number.isInteger(data.page.totalElements)) throw fail("MCP_SERVER_RESPONSE_INVALID");
      });
      await probe;
      return TOOLS;
    },
    async call(name, input, options = {}) {
      const args = commandFor(name, input);
      const data = await run(args, options);
      return project(name, data, input?.size || 10);
    },
    async close() { closed = true; const pending = [...active]; for (const item of pending) item.abort.abort(); await Promise.allSettled(pending.map(item => item.done)); },
  };
}

module.exports = { VERSION, TOOLS, commandFor, scrub, project, createTicketmasterRuntime };
