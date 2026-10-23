"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Ajv = require("ajv/dist/2020");
const { ensurePrivateDirectoryTree } = require("./security");
const { browserError, BROWSER_PUBLIC_MESSAGES } = require("./browser-use-protocol");
const { browserExecutable, loadPlaywrightMcp, createPlaywrightMcpClient } = require("./playwright-mcp-client");

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
// Browser scripts run in the page sandbox; arbitrary Node code, package installation,
// and Browser.close are not proxied. Session.close owns the browser lifecycle.
const BROWSER_TOOLS = new Set([
  "browser_navigate", "browser_navigate_back", "browser_snapshot", "browser_click",
  "browser_type", "browser_fill_form", "browser_press_key", "browser_select_option",
  "browser_hover", "browser_drag", "browser_tabs", "browser_wait_for", "browser_handle_dialog",
  "browser_take_screenshot", "browser_console_messages", "browser_network_requests",
  "browser_resize", "browser_evaluate", "browser_file_upload",
  "browser_find", "browser_drop", "browser_emulate_media", "browser_network_request",
]);
const publicSession = record => ({ id: record.id, profileId: record.profileId, workRunId: record.workRunId,
  browser: record.settings.browser, headless: record.settings.headless, isolated: record.settings.isolated,
  status: record.status, expiresAt: null });

function boundedBrowserResult(value) {
  const content = (Array.isArray(value?.content) ? value.content : [])
    .filter(part => part.type === "text" && typeof part.text === "string")
    .slice(0, 16).map(part => ({ type: "text", text: part.text }));
  const result = { content, isError: value?.isError === true, untrusted: true,
    outputTruncated: (value?.content?.length || 0) > 16 };
  // Include JSON escaping in the budget before the Service's 64 KiB frame boundary.
  while (Buffer.byteLength(JSON.stringify(result), "utf8") > 40 * 1024) {
    const longest = content.reduce((best, part) => part.text.length > best.text.length ? part : best, content[0]);
    longest.text = longest.text.slice(0, Math.floor(longest.text.length / 2)).toWellFormed();
    result.outputTruncated = true;
  }
  if (result.outputTruncated) content.push({ type: "text", text: "Browser output truncated. Use a focused browser_evaluate or another snapshot to inspect the remaining page." });
  return result;
}

class BrowserUseController {
  constructor({ paths, getSettings, isAuthorized, clientFactory = createPlaywrightMcpClient,
    engineStatus = () => loadPlaywrightMcp().version, executable = browserExecutable } = {}) {
    if (!paths || typeof getSettings !== "function" || typeof isAuthorized !== "function") throw new TypeError("Browser Use dependencies are invalid");
    this.paths = paths; this.getSettings = getSettings; this.isAuthorized = isAuthorized;
    this.clientFactory = clientFactory; this.engineStatus = engineStatus; this.executable = executable;
    this.sessions = new Map(); this.closed = false; this.timer = null;
    this.ajv = new Ajv({ allErrors: false, strict: false });
  }
  open() {
    this.closed = false;
    clearInterval(this.timer);
    this.timer = setInterval(() => { void this.reconcile().catch(() => {}); }, 1000);
    this.timer.unref?.();
  }
  async reconcile() {
    const enabled = !this.closed && this.getSettings().enabled;
    await Promise.allSettled([...this.sessions.values()]
      .filter(record => !enabled || !this.isAuthorized(record))
      .map(record => this._close(record)));
  }
  async status(profileId = null) {
    await this.reconcile();
    const settings = this.getSettings();
    let reason = this.closed ? "BROWSER_SERVICE_UNAVAILABLE" : settings.enabled ? null : "BROWSER_DISABLED", engineVersion = null;
    try { engineVersion = this.engineStatus(); if (!reason) this.executable(settings.browser); }
    catch (error) { if (!reason) reason = error.code || "BROWSER_ENGINE_UNAVAILABLE"; }
    return { available: reason === null, reason, engineVersion, browser: settings.browser,
      sessions: [...this.sessions.values()].filter(record => !profileId || record.profileId === profileId).map(publicSession) };
  }
  _assert(record) {
    if (this.closed || !this.getSettings().enabled) throw browserError("BROWSER_DISABLED");
    if (!record || this.sessions.get(record.id) !== record || !["starting", "ready"].includes(record.status)) throw browserError("BROWSER_SESSION_NOT_FOUND");
    if (!this.isAuthorized(record)) throw browserError("BROWSER_SESSION_FORBIDDEN");
  }
  _record(input) {
    const record = this.sessions.get(input.sessionId);
    if (!record) throw browserError("BROWSER_SESSION_NOT_FOUND");
    if (record.profileId !== input.profileId || record.workRunId !== input.workRunId) throw browserError("BROWSER_SESSION_FORBIDDEN");
    this._assert(record);
    return record;
  }
  async create({ profileId, workRunId, workspace }) {
    if (![profileId, workRunId].every(id => ID.test(id || "")) || typeof workspace !== "string" || !path.isAbsolute(workspace)) throw browserError("BROWSER_ARGUMENTS_INVALID");
    const state = await this.status(profileId);
    if (!state.available) throw browserError(state.reason);
    const settings = { ...this.getSettings() };
    if (this.sessions.size >= 4) throw browserError("BROWSER_SESSION_CAPACITY");
    if ([...this.sessions.values()].some(record => record.profileId === profileId
      && (record.workRunId === workRunId || (!settings.isolated && !record.settings.isolated)))) throw browserError("BROWSER_SESSION_BUSY");
    let canonicalWorkspace;
    try { canonicalWorkspace = fs.realpathSync(workspace); if (!fs.statSync(canonicalWorkspace).isDirectory()) throw new Error(); }
    catch { throw browserError("BROWSER_ARGUMENTS_INVALID"); }
    const id = crypto.randomUUID();
    const profileDirectory = path.join(this.paths.stateDir, "browser-use", "profiles", profileId, settings.browser);
    if (!settings.isolated) ensurePrivateDirectoryTree(profileDirectory, this.paths.trustedRoot);
    const record = { id, profileId, workRunId, settings, status: "starting", client: null,
      busy: false, tools: null, validators: new Map() };
    this.sessions.set(id, record);
    try {
      this._assert(record);
      record.starting = this.clientFactory({ settings, workspace: canonicalWorkspace, profileDirectory,
        sessionId: id, assertCurrent: () => this._assert(record) });
      record.client = await record.starting;
      this._assert(record);
      const tools = await record.client.listTools();
      this._assert(record);
      record.tools = tools.filter(tool => BROWSER_TOOLS.has(tool.name));
      if (!record.tools.length) throw browserError("BROWSER_ENGINE_UNAVAILABLE");
      for (const tool of record.tools) record.validators.set(tool.name, this.ajv.compile(tool.inputSchema));
      record.status = "ready";
      return publicSession(record);
    } catch (error) {
      await this._close(record).catch(() => {});
      throw browserError(Object.hasOwn(BROWSER_PUBLIC_MESSAGES, error?.code || "")
        ? error.code : "BROWSER_SESSION_START_FAILED");
    }
  }
  listTools(input) {
    const record = this._record(input);
    if (record.status !== "ready") throw browserError("BROWSER_SESSION_BUSY");
    return { sessionId: record.id, tools: structuredClone(record.tools), untrusted: true };
  }
  async callTool(input) {
    const record = this._record(input);
    if (record.status !== "ready" || record.busy) throw browserError("BROWSER_SESSION_BUSY");
    const validate = record.validators.get(input.toolName);
    if (!validate) throw browserError("BROWSER_TOOL_FORBIDDEN");
    if (!input.arguments || Object.getPrototypeOf(input.arguments) !== Object.prototype
      || Buffer.byteLength(JSON.stringify(input.arguments), "utf8") > 32 * 1024 || !validate(input.arguments)) throw browserError("BROWSER_ARGUMENTS_INVALID");
    if (input.toolName === "browser_navigate" || (input.toolName === "browser_tabs" && input.arguments.url !== undefined)) {
      let url;
      try { url = new URL(input.arguments.url); } catch { throw browserError("BROWSER_ARGUMENTS_INVALID"); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw browserError("BROWSER_ARGUMENTS_INVALID");
    }
    record.busy = true;
    let release;
    record.pending = new Promise(resolve => { release = resolve; });
    try {
      this._assert(record);
      const value = await record.client.callTool(input.toolName, structuredClone(input.arguments));
      this._assert(record);
      return { sessionId: record.id, toolName: input.toolName, ...boundedBrowserResult(value) };
    } catch (error) {
      void this._close(record).catch(() => {});
      if (["BROWSER_DISABLED", "BROWSER_SESSION_FORBIDDEN", "BROWSER_SESSION_NOT_FOUND"].includes(error?.code)) throw error;
      throw browserError("BROWSER_CALL_OUTCOME_UNKNOWN");
    } finally { record.busy = false; record.pending = null; release(); }
  }
  async waitForUser(input, requestInput) {
    const record = this._record(input);
    if (record.status !== "ready" || record.busy) throw browserError("BROWSER_SESSION_BUSY");
    if (record.settings.headless) throw browserError("BROWSER_USER_WAIT_UNAVAILABLE");
    if (typeof requestInput !== "function") throw browserError("BROWSER_SERVICE_UNAVAILABLE");
    record.busy = true;
    record.userWait = new AbortController();
    let release, result, failure;
    record.pending = new Promise(resolve => { release = resolve; });
    try {
      this._assert(record);
      const completed = await requestInput(record.userWait.signal);
      this._assert(record);
      if (typeof completed !== "boolean") throw browserError("BROWSER_USER_WAIT_FAILED");
      if (!completed) result = { sessionId: record.id, canceled: true };
      else {
        // User input is a handoff acknowledgment, not proof of login success.
        // Observe fresh state in the same context; never replay a page action.
        const snapshot = await record.client.callTool("browser_snapshot", {});
        this._assert(record);
        result = { sessionId: record.id, canceled: false, toolName: "browser_snapshot",
          ...boundedBrowserResult(snapshot) };
      }
    } catch (error) {
      failure = browserError(Object.hasOwn(BROWSER_PUBLIC_MESSAGES, error?.code || "")
        ? error.code : "BROWSER_USER_WAIT_FAILED");
    } finally {
      record.userWait = null; record.busy = false; record.pending = null; release();
    }
    // Drain before closing, including a concurrent stop/revocation. Closing must
    // not wait forever for the very input request it is withdrawing.
    if (failure || result?.canceled) {
      await this._close(record);
      if (failure) throw failure;
    }
    return result;
  }
  async _close(record) {
    if (record.closing) return record.closing;
    record.status = "closing";
    record.userWait?.abort();
    record.closing = (async () => {
      try {
        // Revoke admission immediately, then drain the already dispatched action.
        await record.pending;
        const client = record.client || await record.starting?.catch(() => null);
        if (client) await client.close();
        if (this.sessions.get(record.id) === record) this.sessions.delete(record.id);
      } catch {
        record.status = "close_failed";
        throw browserError("BROWSER_SESSION_CLOSE_FAILED");
      } finally { record.closing = null; }
    })();
    return record.closing;
  }
  async closeSession(input) {
    const record = this.sessions.get(input.sessionId);
    if (!record) return { closed: true, sessionId: input.sessionId };
    if (record.profileId !== input.profileId || record.workRunId !== input.workRunId) throw browserError("BROWSER_SESSION_FORBIDDEN");
    await this._close(record);
    return { closed: true, sessionId: record.id };
  }
  async closeForWorkRun(profileId, workRunId) {
    await Promise.allSettled([...this.sessions.values()].filter(record => record.profileId === profileId
      && record.workRunId === workRunId).map(record => this._close(record)));
  }
  async closeForProfile(profileId) {
    const results = await Promise.allSettled([...this.sessions.values()].filter(record => record.profileId === profileId).map(record => this._close(record)));
    if (results.some(result => result.status === "rejected")) throw browserError("BROWSER_SESSION_CLOSE_FAILED");
  }
  async close() {
    this.closed = true; clearInterval(this.timer); this.timer = null;
    const results = await Promise.allSettled([...this.sessions.values()].map(record => this._close(record)));
    if (results.some(result => result.status === "rejected")) throw browserError("BROWSER_SESSION_CLOSE_FAILED");
  }
}

module.exports = { BrowserUseController, BROWSER_TOOLS, boundedBrowserResult };
