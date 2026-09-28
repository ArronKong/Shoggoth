"use strict";

// Fixture-only independent Graph candidate. These methods accept a caller-
// supplied profile/client for local contract tests; do not expose them through
// Service IPC, MCP or UI until an authenticated host context derives both,
// and a separately installed Shoggoth component owns the per-host grant.

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { serviceError } = require("./security");

const GRAPH_ORIGIN = "https://graph.microsoft.com";
const GRAPH_PATH = "/v1.0/me/calendarView";
const SCOPES = Object.freeze(["Calendars.Read", "User.Read", "offline_access"]);
const SELECT = "id,subject,start,end,isAllDay,showAs,location,organizer";
const MAX_PAGES = 3;
const PAGE_SIZE = 50;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 40 * 1024;
const FLOW_LIFETIME_MS = 5 * 60_000;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u;
const CLIENT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/u;
const ACCOUNT_REF = "microsoft-graph-calendar-shared-v1";
const CLIENTS = new Set(["native", "openclaw", "hermes"]);

const fail = (code = "OUTLOOK_CALENDAR_UNAVAILABLE") => {
  throw serviceError(code, "Outlook Calendar 连接或只读日程请求不可用");
};
const plain = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const scopeSet = value => new Set(value.split(" ").filter(Boolean));

// The client ID is local deployment configuration, never package content or
// renderer input. A missing file leaves the adapter inert on normal installs.
function loadOutlookCalendarConfig(paths) {
  const file = path.join(paths.pluginsDir, "outlook-calendar-graph.json");
  let fd;
  try {
    const parent = fs.lstatSync(paths.pluginsDir);
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077)
      || (process.getuid && parent.uid !== process.getuid())) fail("OUTLOOK_CALENDAR_CONFIG_INVALID");
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077)
      || stat.size > 1024 || (process.getuid && stat.uid !== process.getuid())) {
      fail("OUTLOOK_CALENDAR_CONFIG_INVALID");
    }
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) {
      fail("OUTLOOK_CALENDAR_CONFIG_INVALID");
    }
    const bytes = Buffer.alloc(stat.size);
    if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== stat.size) fail("OUTLOOK_CALENDAR_CONFIG_INVALID");
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return validateConfig(value);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    fail("OUTLOOK_CALENDAR_CONFIG_INVALID");
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function validateConfig(value) {
  if (!plain(value, ["version", "clientId"]) || value.version !== 1
    || typeof value.clientId !== "string" || !CLIENT_ID.test(value.clientId)) {
    fail("OUTLOOK_CALENDAR_CONFIG_INVALID");
  }
  return Object.freeze({ clientId: value.clientId.toLowerCase() });
}

function parseDateTime(value) {
  if (typeof value !== "string" || value.length > 35) fail("OUTLOOK_CALENDAR_RANGE_INVALID");
  const match = DATE_TIME.exec(value);
  if (!match) fail("OUTLOOK_CALENDAR_RANGE_INVALID");
  const [, year, month, day, hour, minute, second, fraction = "0", zone] = match;
  const fields = [year, month, day, hour, minute, second].map(Number);
  const ms = Number(fraction.padEnd(3, "0"));
  const utc = Date.UTC(fields[0], fields[1] - 1, fields[2], fields[3], fields[4], fields[5], ms);
  const checked = new Date(utc);
  if (fields[0] < 1900 || fields[0] > 2100
    || checked.getUTCFullYear() !== fields[0] || checked.getUTCMonth() + 1 !== fields[1]
    || checked.getUTCDate() !== fields[2] || checked.getUTCHours() !== fields[3]
    || checked.getUTCMinutes() !== fields[4] || checked.getUTCSeconds() !== fields[5]) {
    fail("OUTLOOK_CALENDAR_RANGE_INVALID");
  }
  let offset = 0;
  if (zone !== "Z") {
    const hours = Number(zone.slice(1, 3));
    const minutes = Number(zone.slice(4, 6));
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) fail("OUTLOOK_CALENDAR_RANGE_INVALID");
    offset = (hours * 60 + minutes) * 60_000 * (zone[0] === "+" ? 1 : -1);
  }
  return utc - offset;
}

function calendarRange(input) {
  if (!plain(input, ["startDateTime", "endDateTime"])) fail("OUTLOOK_CALENDAR_RANGE_INVALID");
  const start = parseDateTime(input.startDateTime);
  const end = parseDateTime(input.endDateTime);
  if (end <= start || end - start > 31 * 24 * 60 * 60_000) fail("OUTLOOK_CALENDAR_RANGE_INVALID");
  return input;
}

function validToken(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384 && TOKEN.test(value);
}

function parseTokenResponse(value, now, previousRefreshToken = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.token_type?.toLowerCase() !== "bearer" || !validToken(value.access_token)
    || !Number.isSafeInteger(value.expires_in) || value.expires_in < 1 || value.expires_in > 86_400
    || typeof value.scope !== "string" || value.scope.length > 2048) fail("OUTLOOK_CALENDAR_AUTH_FAILED");
  const granted = scopeSet(value.scope);
  if (!granted.has("Calendars.Read") || !granted.has("User.Read")
    || [...granted].some(scope => !SCOPES.includes(scope) && !["openid", "profile", "email"].includes(scope))) {
    fail("OUTLOOK_CALENDAR_AUTH_FAILED");
  }
  const refreshToken = value.refresh_token ?? previousRefreshToken;
  if (!validToken(refreshToken)) fail("OUTLOOK_CALENDAR_AUTH_FAILED");
  return { accessToken: value.access_token, refreshToken,
    scopes: [...granted].sort(), expiresAt: now + value.expires_in * 1000 };
}

function parseCredential(raw, clientId) {
  let value;
  try { value = JSON.parse(raw); } catch { fail("OUTLOOK_CALENDAR_AUTH_FAILED"); }
  if (!plain(value, ["version", "clientId", "principalHash", "accessToken",
    "refreshToken", "scopes", "expiresAt", "grants"])
    || value.version !== 1 || value.clientId !== clientId
    || typeof value.principalHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.principalHash)
    || !validToken(value.accessToken) || !validToken(value.refreshToken)
    || !Array.isArray(value.scopes) || !value.scopes.includes("Calendars.Read")
    || !value.scopes.includes("User.Read")
    || value.scopes.some(scope => !SCOPES.includes(scope) && !["openid", "profile", "email"].includes(scope))
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0
    || !Array.isArray(value.grants) || value.grants.length < 1 || value.grants.length > 128
    || new Set(value.grants).size !== value.grants.length
    || value.grants.some(grant => typeof grant !== "string"
      || !/^(native|openclaw|hermes):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(grant))) {
    fail("OUTLOOK_CALENDAR_AUTH_FAILED");
  }
  return value;
}

async function boundedJson(response) {
  if (!response.ok || response.status !== 200) fail("OUTLOOK_CALENDAR_REMOTE_FAILED");
  const size = Number(response.headers.get("content-length"));
  if (Number.isFinite(size) && size > MAX_BODY_BYTES) fail("OUTLOOK_CALENDAR_REMOTE_FAILED");
  const reader = response.body?.getReader();
  if (!reader) fail("OUTLOOK_CALENDAR_REMOTE_FAILED");
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) fail("OUTLOOK_CALENDAR_REMOTE_FAILED");
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total))); }
  catch { fail("OUTLOOK_CALENDAR_REMOTE_FAILED"); }
}

function safeText(value, max = 512) {
  return typeof value === "string" && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)
    ? value : null;
}

function projectEvent(value) {
  if (!value || typeof value !== "object" || typeof value.id !== "string"
    || !safeText(value.id, 512) || !value.start || !value.end
    || !safeText(value.start.dateTime, 64) || !safeText(value.end.dateTime, 64)) {
    fail("OUTLOOK_CALENDAR_REMOTE_FAILED");
  }
  return { id: value.id, subject: safeText(value.subject, 1024),
    start: { dateTime: value.start.dateTime, timeZone: safeText(value.start.timeZone, 128) },
    end: { dateTime: value.end.dateTime, timeZone: safeText(value.end.timeZone, 128) },
    isAllDay: value.isAllDay === true, showAs: safeText(value.showAs, 32),
    location: safeText(value.location?.displayName, 512),
    organizer: { name: safeText(value.organizer?.emailAddress?.name, 256),
      address: safeText(value.organizer?.emailAddress?.address, 320) } };
}

function assertNextLink(value, range) {
  if (typeof value !== "string" || value.length > 4096) fail("OUTLOOK_CALENDAR_REMOTE_FAILED");
  let url;
  try { url = new URL(value); } catch { fail("OUTLOOK_CALENDAR_REMOTE_FAILED"); }
  const allowed = new Set(["startDateTime", "endDateTime", "$select", "$top", "$skiptoken", "$skip"]);
  if (url.protocol !== "https:" || url.origin !== GRAPH_ORIGIN || url.pathname !== GRAPH_PATH
    || url.username || url.password || url.hash
    || [...url.searchParams.keys()].some(key => !allowed.has(key))
    || [...allowed].some(key => url.searchParams.getAll(key).length > 1)
    || (url.searchParams.has("startDateTime")
      && url.searchParams.get("startDateTime") !== range.startDateTime)
    || (url.searchParams.has("endDateTime")
      && url.searchParams.get("endDateTime") !== range.endDateTime)
    || (url.searchParams.has("$select") && url.searchParams.get("$select") !== SELECT)
    || (url.searchParams.has("$top") && url.searchParams.get("$top") !== String(PAGE_SIZE))) {
    fail("OUTLOOK_CALENDAR_REMOTE_FAILED");
  }
  return url.href;
}

class OutlookCalendarGraphController {
  #flows = new Map();
  #generation = 0;
  #calls = new Set();
  #mutationQueue = Promise.resolve();
  #pendingRevocations = 0;
  #pendingAccountSwitches = 0;
  #revocationFailed = false;
  #revocationFailureSubjects = new Set();
  // A persisted grant is not executable merely because its encrypted record
  // survived a Service restart. Only a successful connection or explicit
  // grant in this process can activate it. This also fails closed if a revoke
  // write failed and the process stopped before it could be retried.
  #sessionGrants = new Set();
  #closed = false;

  constructor({ paths, secretStore, productStore, fetchImpl = globalThis.fetch,
    now = Date.now, config = undefined, endpoints = undefined } = {}) {
    if (!paths?.pluginsDir || typeof secretStore?.get !== "function"
      || typeof secretStore?.putIfRevision !== "function" || typeof secretStore?.delete !== "function"
      || typeof productStore?.getAgentProfile !== "function" || typeof fetchImpl !== "function"
      || typeof now !== "function") throw new TypeError("Outlook Calendar requires Service-owned stores");
    this.config = config === undefined ? loadOutlookCalendarConfig(paths) : config === null ? null : validateConfig(config);
    this.secrets = secretStore;
    this.products = productStore;
    this.fetch = fetchImpl;
    this.now = now;
    this.endpoints = endpoints || Object.freeze({
      authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      me: `${GRAPH_ORIGIN}/v1.0/me?$select=id`,
      calendar: `${GRAPH_ORIGIN}${GRAPH_PATH}`,
    });
  }

  #profile(profileId) {
    if (typeof profileId !== "string" || !PROFILE_ID.test(profileId)
      || this.products.getAgentProfile(profileId)?.enabled !== true) fail("OUTLOOK_CALENDAR_FORBIDDEN");
  }

  #subject(profileId, client = "native") {
    this.#profile(profileId);
    if (!CLIENTS.has(client)) fail("OUTLOOK_CALENDAR_FORBIDDEN");
    return `${client}:${profileId}`;
  }

  #bump() {
    this.#generation += 1;
    for (const controller of this.#calls) controller.abort();
  }

  #exclusive(action) {
    const work = this.#mutationQueue.then(action);
    this.#mutationQueue = work.catch(() => {});
    return work;
  }

  async #record() {
    const revision = this.secrets.getCredentialRevision(ACCOUNT_REF);
    if (revision === null) return null;
    const raw = await this.secrets.get(ACCOUNT_REF);
    if (this.secrets.getCredentialRevision(ACCOUNT_REF) !== revision || !raw) fail("OUTLOOK_CALENDAR_AUTH_FAILED");
    return { revision, value: parseCredential(raw, this.config.clientId) };
  }

  async status({ profileId, client = "native" } = {}) {
    const subject = this.#subject(profileId, client);
    if (!this.config) return { configured: false, accountConnected: false,
      connected: false, principalHash: null, flow: null, revocationFailed: false,
      activationRequired: false };
    const record = await this.#record();
    const flow = [...this.#flows.values()].find(item => item.profileId === profileId && item.status === "pending");
    const connected = !this.#closed && !this.#revocationFailed
      && this.#pendingRevocations === 0 && this.#pendingAccountSwitches === 0
      && record?.value.grants.includes(subject) === true && this.#sessionGrants.has(subject);
    return { configured: true, accountConnected: !!record, connected,
      principalHash: connected ? record.value.principalHash : null,
      flow: flow ? { flowId: flow.id, status: flow.status, expiresAt: flow.expiresAt } : null,
      revocationFailed: this.#revocationFailed,
      activationRequired: !!record?.value.grants.includes(subject) && !this.#sessionGrants.has(subject) };
  }

  async connect({ profileId } = {}) {
    this.#profile(profileId);
    if (!this.config || this.#closed || this.#revocationFailed) fail();
    if ([...this.#flows.values()].some(flow => ["pending", "exchanging"].includes(flow.status))) {
      fail("OUTLOOK_CALENDAR_AUTH_BUSY");
    }
    if (this.#flows.size >= 8) {
      for (const [id, flow] of this.#flows) if (!["pending", "exchanging"].includes(flow.status)) this.#flows.delete(id);
    }
    const flow = { id: crypto.randomUUID(), profileId, status: "pending", expiresAt: this.now() + FLOW_LIFETIME_MS,
      state: crypto.randomBytes(32).toString("base64url"), verifier: crypto.randomBytes(32).toString("base64url"),
      generation: this.#generation, server: null, timer: null };
    const server = http.createServer((request, response) => {
      void this.#callback(flow, request, response);
    });
    server.headersTimeout = 5000;
    server.requestTimeout = 5000;
    server.maxConnections = 4;
    // Reserve admission before the asynchronous listener starts so a second
    // connect cannot publish another apparently valid OAuth flow.
    this.#flows.set(flow.id, flow);
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: "127.0.0.1", port: 0 }, resolve);
      });
      if (flow.status !== "pending" || flow.generation !== this.#generation || this.#closed) {
        fail("OUTLOOK_CALENDAR_AUTH_FAILED");
      }
      flow.server = server;
      flow.redirectUrl = `http://localhost:${server.address().port}/`;
      flow.timer = setTimeout(() => this.#finishFlow(flow, "expired"), FLOW_LIFETIME_MS);
      flow.timer.unref?.();
      const url = new URL(this.endpoints.authorize);
      url.search = new URLSearchParams({ client_id: this.config.clientId, response_type: "code",
        redirect_uri: flow.redirectUrl, response_mode: "query", scope: SCOPES.join(" "),
        state: flow.state, code_challenge: crypto.createHash("sha256").update(flow.verifier).digest("base64url"),
        code_challenge_method: "S256" }).toString();
      return { flowId: flow.id, authorizationUrl: url.href, expiresAt: flow.expiresAt };
    } catch {
      this.#flows.delete(flow.id);
      server.close();
      fail("OUTLOOK_CALENDAR_AUTH_FAILED");
    }
  }

  #finishFlow(flow, status) {
    if (flow.status !== "pending" && flow.status !== "exchanging") return;
    flow.status = status;
    flow.state = null;
    flow.verifier = null;
    clearTimeout(flow.timer);
    flow.server?.close();
    flow.server?.closeIdleConnections();
    setTimeout(() => this.#flows.delete(flow.id), FLOW_LIFETIME_MS).unref?.();
  }

  async #callback(flow, request, response) {
    const finish = (status, text) => {
      if (!response.destroyed) {
        response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'" });
        response.end(text);
      }
    };
    if (flow.status !== "pending" || request.method !== "GET" || request.headers.host !== new URL(flow.redirectUrl).host
      || typeof request.url !== "string" || request.url.length > 8192) {
      finish(400, "Invalid authorization callback"); return;
    }
    let url;
    try { url = new URL(request.url, flow.redirectUrl); } catch { finish(400, "Invalid authorization callback"); return; }
    const state = url.searchParams.getAll("state");
    const code = url.searchParams.getAll("code");
    if (url.origin !== new URL(flow.redirectUrl).origin || url.pathname !== "/" || url.hash
      || state.length !== 1 || code.length !== 1 || !code[0] || code[0].length > 4096
      || url.searchParams.has("error") || !crypto.timingSafeEqual(
        crypto.createHash("sha256").update(state[0]).digest(),
        crypto.createHash("sha256").update(flow.state).digest())) {
      finish(400, "Invalid authorization callback"); return;
    }
    flow.status = "exchanging";
    try {
      if (this.#closed || flow.status !== "exchanging" || this.now() >= flow.expiresAt
        || flow.generation !== this.#generation) {
        fail("OUTLOOK_CALENDAR_AUTH_FAILED");
      }
      const tokens = await this.#token({ grant_type: "authorization_code", code: code[0],
        redirect_uri: flow.redirectUrl, code_verifier: flow.verifier });
      this.#profile(flow.profileId);
      const identity = await this.#me(tokens.accessToken);
      await this.#exclusive(async () => {
        if (flow.status !== "exchanging" || flow.generation !== this.#generation || this.#closed
          || this.now() >= flow.expiresAt) fail("OUTLOOK_CALENDAR_AUTH_FAILED");
        this.#profile(flow.profileId);
        const previous = await this.#record();
        if (flow.status !== "exchanging" || flow.generation !== this.#generation || this.#closed
          || this.now() >= flow.expiresAt) fail("OUTLOOK_CALENDAR_AUTH_FAILED");
        const previousRevision = previous?.revision ?? null;
        const record = { version: 1, clientId: this.config.clientId,
          principalHash: digest(`${this.config.clientId}:${identity}`), ...tokens,
          grants: [`native:${flow.profileId}`] };
        this.#pendingAccountSwitches += 1;
        this.#bump();
        flow.generation = this.#generation;
        try {
          const committed = await this.secrets.putIfRevision(ACCOUNT_REF, JSON.stringify(record),
            { kind: "microsoft-graph-oauth" }, previousRevision);
          if (flow.status !== "exchanging" || flow.generation !== this.#generation || this.#closed) {
            try {
              if (this.secrets.getCredentialRevision(ACCOUNT_REF) !== committed.revision) {
                fail("OUTLOOK_CALENDAR_AUTH_FAILED");
              }
              // A canceled account switch must restore the connected account
              // and its host grants, rather than deleting the shared credential.
              if (previous) {
                await this.secrets.putIfRevision(ACCOUNT_REF, JSON.stringify(previous.value),
                  { kind: "microsoft-graph-oauth" }, committed.revision);
              } else await this.secrets.delete(ACCOUNT_REF);
            } catch {
              // A failed rollback leaves an uncertain account/grant state.
              this.#revocationFailed = true;
              this.#revocationFailureSubjects.add("*");
              this.#bump();
              fail("OUTLOOK_CALENDAR_AUTH_FAILED");
            }
            this.#bump();
            fail("OUTLOOK_CALENDAR_AUTH_FAILED");
          }
          this.#sessionGrants.clear();
          this.#sessionGrants.add(`native:${flow.profileId}`);
          this.#bump();
        } finally { this.#pendingAccountSwitches -= 1; }
      });
      this.#finishFlow(flow, "ready");
      finish(200, "Outlook Calendar connected. You can close this window.");
    } catch {
      this.#finishFlow(flow, "failed");
      finish(400, "Outlook Calendar authorization failed. Return to Shoggoth.");
    }
  }

  async flowStatus({ profileId, flowId } = {}) {
    this.#profile(profileId);
    const flow = this.#flows.get(flowId);
    if (!flow || flow.profileId !== profileId) fail("OUTLOOK_CALENDAR_FLOW_NOT_FOUND");
    return { flowId, status: flow.status, expiresAt: flow.expiresAt };
  }

  cancel({ profileId, flowId } = {}) {
    this.#profile(profileId);
    const flow = this.#flows.get(flowId);
    if (!flow || flow.profileId !== profileId) fail("OUTLOOK_CALENDAR_FLOW_NOT_FOUND");
    this.#finishFlow(flow, "canceled");
    return { canceled: true };
  }

  async grant({ profileId, client } = {}) {
    const subject = this.#subject(profileId, client);
    if (!this.config || this.#closed || this.#revocationFailed
      || this.#pendingRevocations > 0 || this.#pendingAccountSwitches > 0) fail();
    return this.#exclusive(async () => {
      if (this.#closed || this.#revocationFailed || this.#pendingRevocations > 0
        || this.#pendingAccountSwitches > 0) fail();
      const record = await this.#record();
      if (!record) fail("OUTLOOK_CALENDAR_AUTH_REQUIRED");
      if (record.value.grants.includes(subject)) {
        this.#sessionGrants.add(subject);
        return { granted: true, principalHash: record.value.principalHash };
      }
      if (record.value.grants.length >= 128) fail("OUTLOOK_CALENDAR_FORBIDDEN");
      await this.secrets.putIfRevision(ACCOUNT_REF, JSON.stringify({ ...record.value,
        grants: [...record.value.grants, subject].sort() }),
      { kind: "microsoft-graph-oauth" }, record.revision);
      this.#sessionGrants.add(subject);
      this.#bump();
      return { granted: true, principalHash: record.value.principalHash };
    });
  }

  async disconnect({ profileId, client = "native" } = {}) {
    const subject = this.#subject(profileId, client);
    if (!this.config) fail();
    this.#pendingRevocations += 1;
    this.#sessionGrants.delete(subject);
    this.#bump();
    for (const flow of this.#flows.values()) if (flow.profileId === profileId) this.#finishFlow(flow, "canceled");
    try { return await this.#exclusive(async () => {
      const record = await this.#record();
      if (!record) {
        this.#sessionGrants.clear();
        this.#revocationFailed = false;
        this.#revocationFailureSubjects.clear();
        return { disconnected: true, hadConnection: false };
      }
      if (!record.value.grants.includes(subject)) {
        // A retry can prove the failed subject is already absent. A different
        // subject must not clear an unrelated durable-revoke failure latch.
        this.#revocationFailureSubjects.delete(subject);
        this.#revocationFailed = this.#revocationFailureSubjects.size > 0;
        return { disconnected: true, hadConnection: false };
      }
      const grants = record.value.grants.filter(grant => grant !== subject);
      if (grants.length) {
        await this.secrets.putIfRevision(ACCOUNT_REF, JSON.stringify({ ...record.value, grants }),
          { kind: "microsoft-graph-oauth" }, record.revision);
      } else await this.secrets.delete(ACCOUNT_REF);
      if (!grants.length) this.#revocationFailureSubjects.clear();
      else this.#revocationFailureSubjects.delete(subject);
      this.#revocationFailed = this.#revocationFailureSubjects.size > 0;
      return { disconnected: true, hadConnection: true };
    }); } catch (error) {
      // A failed durable revoke may leave the previous encrypted grant intact.
      // Keep this candidate closed to reads until an explicit retry succeeds.
      this.#revocationFailed = true;
      this.#revocationFailureSubjects.add(subject);
      throw error;
    } finally { this.#pendingRevocations -= 1; }
  }

  async #request(url, init = {}) {
    let response;
    try { response = await this.fetch(url, { ...init, redirect: "manual", cache: "no-store",
      signal: AbortSignal.any([AbortSignal.timeout(15_000), init.signal || new AbortController().signal]) }); }
    catch { fail("OUTLOOK_CALENDAR_REMOTE_FAILED"); }
    if (response.status >= 300 && response.status < 400) fail("OUTLOOK_CALENDAR_REMOTE_FAILED");
    return boundedJson(response);
  }

  async #token(fields, previousRefreshToken = null) {
    const body = new URLSearchParams({ client_id: this.config.clientId, scope: SCOPES.join(" "), ...fields });
    const value = await this.#request(this.endpoints.token, { method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    return parseTokenResponse(value, this.now(), previousRefreshToken);
  }

  async #me(accessToken, signal) {
    const value = await this.#request(this.endpoints.me, { method: "GET", signal,
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
    if (!value || typeof value.id !== "string" || !safeText(value.id, 256) || value.id.length === 0) {
      fail("OUTLOOK_CALENDAR_AUTH_FAILED");
    }
    return value.id;
  }

  async #usableRecord(subject, expectedGeneration) {
    if (this.#pendingRevocations > 0 || this.#pendingAccountSwitches > 0 || this.#revocationFailed) {
      fail("OUTLOOK_CALENDAR_AUTH_REQUIRED");
    }
    let current = await this.#record();
    if (expectedGeneration !== this.#generation || this.#pendingRevocations > 0
      || this.#pendingAccountSwitches > 0 || this.#revocationFailed) {
      fail("OUTLOOK_CALENDAR_AUTH_REQUIRED");
    }
    if (!current?.value.grants.includes(subject) || !this.#sessionGrants.has(subject)) {
      fail("OUTLOOK_CALENDAR_AUTH_REQUIRED");
    }
    if (current.value.expiresAt > this.now() + 30_000) {
      return { record: current, generation: expectedGeneration };
    }
    const generation = this.#generation;
    if (this.#pendingRevocations > 0 || this.#pendingAccountSwitches > 0
      || this.#revocationFailed || generation !== expectedGeneration) {
      fail("OUTLOOK_CALENDAR_AUTH_REQUIRED");
    }
    const refreshed = await this.#token({ grant_type: "refresh_token",
      refresh_token: current.value.refreshToken }, current.value.refreshToken);
    const identity = await this.#me(refreshed.accessToken);
    await this.#exclusive(async () => {
      if (digest(`${this.config.clientId}:${identity}`) !== current.value.principalHash
        || generation !== this.#generation
        || this.secrets.getCredentialRevision(ACCOUNT_REF) !== current.revision) {
        fail("OUTLOOK_CALENDAR_AUTH_FAILED");
      }
      await this.secrets.putIfRevision(ACCOUNT_REF, JSON.stringify({ ...current.value, ...refreshed }),
        { kind: "microsoft-graph-oauth" }, current.revision);
      this.#bump();
    });
    current = await this.#record();
    if (!current?.value.grants.includes(subject) || !this.#sessionGrants.has(subject)) {
      fail("OUTLOOK_CALENDAR_AUTH_REQUIRED");
    }
    return { record: current, generation: this.#generation };
  }

  async calendarView({ profileId, client = "native", startDateTime, endDateTime } = {}) {
    const subject = this.#subject(profileId, client);
    if (!this.config || this.#closed || this.#revocationFailed) fail();
    const range = calendarRange({ startDateTime, endDateTime });
    if (this.#pendingRevocations > 0 || this.#pendingAccountSwitches > 0 || this.#revocationFailed) {
      fail("OUTLOOK_CALENDAR_AUTH_REQUIRED");
    }
    const admissionGeneration = this.#generation;
    const { record, generation } = await this.#usableRecord(subject, admissionGeneration);
    const controller = new AbortController();
    this.#calls.add(controller);
    const assertCurrent = () => {
      this.#subject(profileId, client);
      if (controller.signal.aborted || this.#pendingRevocations > 0
        || this.#pendingAccountSwitches > 0 || this.#revocationFailed
        || !this.#sessionGrants.has(subject)
        || generation !== this.#generation
        || this.secrets.getCredentialRevision(ACCOUNT_REF) !== record.revision) {
        fail("OUTLOOK_CALENDAR_AUTH_REQUIRED");
      }
    };
    try {
      const url = new URL(this.endpoints.calendar);
      url.search = new URLSearchParams({ startDateTime, endDateTime,
        "$select": SELECT, "$top": String(PAGE_SIZE) }).toString();
      let next = url.href;
      const seen = new Set();
      const events = [];
      let pages = 0;
      while (next && pages < MAX_PAGES) {
        assertCurrent();
        if (seen.has(next)) fail("OUTLOOK_CALENDAR_REMOTE_FAILED");
        seen.add(next);
        const page = await this.#request(next, { method: "GET", signal: controller.signal,
          headers: { Authorization: `Bearer ${record.value.accessToken}`, Accept: "application/json" } });
        assertCurrent();
        if (!page || !Array.isArray(page.value) || page.value.length > PAGE_SIZE) {
          fail("OUTLOOK_CALENDAR_REMOTE_FAILED");
        }
        for (const item of page.value) {
          const event = projectEvent(item);
          if (Buffer.byteLength(JSON.stringify([...events, event]), "utf8") > MAX_RESULT_BYTES) {
            assertCurrent();
            return { events, pages: pages + 1, truncated: true };
          }
          events.push(event);
        }
        pages += 1;
        next = page["@odata.nextLink"] === undefined ? null : assertNextLink(page["@odata.nextLink"], range);
      }
      assertCurrent();
      return { events, pages, truncated: next !== null };
    } finally {
      this.#calls.delete(controller);
    }
  }

  async close() {
    this.#closed = true;
    for (const flow of this.#flows.values()) this.#finishFlow(flow, "canceled");
    for (const controller of this.#calls) controller.abort();
    this.#calls.clear();
    this.#sessionGrants.clear();
  }
}

module.exports = { OutlookCalendarGraphController, loadOutlookCalendarConfig, calendarRange,
  parseTokenResponse, assertNextLink };
