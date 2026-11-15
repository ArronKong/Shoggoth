"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Worker, isMainThread, parentPort } = require("node:worker_threads");
const { CodexDesktopSessionStore } = require("./codex-desktop-session-store");
const { serviceError } = require("./security");

const READ_TIMEOUT_MS = 1200;
const RETRY_DELAY_MS = 5000;
const VIEW_LIFETIME_MS = 10_000;
const MAX_VIEWS = 4;
const MAX_PENDING_READS = 4;
const STORAGE_UNAVAILABLE = "CODEX_DESKTOP_STORAGE_UNAVAILABLE";
const PUBLIC_CODES = new Set([STORAGE_UNAVAILABLE, "CODEX_DESKTOP_FORMAT_UNSUPPORTED",
  "CODEX_DESKTOP_PARAMS_INVALID", "CODEX_DESKTOP_UNAVAILABLE"]);
const readError = code => serviceError(code, code);

// A file replacement is a different source. Ordinary WAL writes can continue
// while the short-lived SQLite read transaction serves its existing pages.
function fileIdentity(file) {
  const { dev, ino } = fs.lstatSync(file, { bigint: true });
  return `${dev}:${ino}`;
}

function serveDiscovery(port) {
  const views = new Map();
  function close(id) {
    const view = views.get(id);
    if (!view) return;
    views.delete(id);
    clearTimeout(view.expiration);
    view.connection.db.close();
  }
  function begin(home) {
    while (views.size >= MAX_VIEWS) close(views.keys().next().value);
    const store = new CodexDesktopSessionStore({ home });
    const file = store.stateFile();
    const identity = fileIdentity(file);
    const connection = store.openDatabase(file);
    try {
      connection.db.exec("BEGIN");
      const id = randomUUID();
      const view = { id, store, file, identity, connection };
      view.expiration = setTimeout(() => close(id), VIEW_LIFETIME_MS);
      view.expiration.unref();
      views.set(id, view);
      return view;
    } catch (error) {
      connection.db.close();
      throw error;
    }
  }
  port.on("message", ({ requestId, home, snapshotId, after, limit, release }) => {
    if (release) { close(release); return; }
    let view;
    try {
      view = snapshotId === null ? begin(home) : views.get(snapshotId);
      if (!view) throw readError("CODEX_DESKTOP_UNAVAILABLE");
      if (view.store.home !== home) {
        view = null;
        throw readError("CODEX_DESKTOP_UNAVAILABLE");
      }
      if (view.store.stateFile() !== view.file || fileIdentity(view.file) !== view.identity) {
        throw readError("CODEX_DESKTOP_UNAVAILABLE");
      }
      const rows = view.store.selectRows(view.connection, { after, limit });
      // A page can be split by the RPC byte budget even with no extra SQL row.
      // Keep the view for retries until the fixed deadline, subject to MAX_VIEWS.
      if (!rows.length) close(view.id);
      port.postMessage({ requestId, snapshotId: view.id, rows });
    } catch (error) {
      if (view) close(view.id);
      const code = PUBLIC_CODES.has(error?.code) ? error.code : STORAGE_UNAVAILABLE;
      port.postMessage({ requestId, code });
    }
  });
}

class CodexDesktopDiscovery {
  constructor() {
    this.worker = null;
    this.pending = new Map();
    this.retryAt = 0;
    this.closed = false;
  }

  open() { this.closed = false; this.retryAt = 0; }

  release(snapshotId) {
    try { this.worker?.postMessage({ release: snapshotId }); }
    catch { /* An exited worker already discarded its transactions. */ }
  }

  async read({ home, after, limit }) {
    if (this.closed || this.retiring || this.retryAt > performance.now()) throw readError(STORAGE_UNAVAILABLE);
    const request = { home, snapshotId: after?.snapshotId ?? null,
      after: after && { updatedAt: after.updatedAt, id: after.id }, limit };
    const requestId = JSON.stringify(request);
    const pending = this.pending.get(requestId);
    if (pending) return pending.promise;
    if (this.pending.size >= MAX_PENDING_READS) throw readError("CODEX_DESKTOP_UNAVAILABLE");
    try { this.ensureWorker(); }
    catch {
      this.retryAt = performance.now() + RETRY_DELAY_MS;
      throw readError(STORAGE_UNAVAILABLE);
    }
    const worker = this.worker;
    const { promise, resolve, reject } = Promise.withResolvers();
    const timeout = setTimeout(() => this.retire(worker, true), READ_TIMEOUT_MS);
    this.pending.set(requestId, { promise, resolve, reject, timeout });
    clearTimeout(this.idle);
    worker.ref();
    try { worker.postMessage({ requestId, ...request }); }
    catch { this.retire(worker, true); }
    return promise;
  }

  ensureWorker() {
    if (this.worker) return;
    const worker = new Worker(path.join(__dirname, "codex-desktop-discovery-worker.js"), {
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    this.worker = worker;
    worker.on("message", ({ requestId, code, rows, snapshotId }) => {
      if (worker !== this.worker) return;
      const pending = this.pending.get(requestId);
      if (!pending) return;
      this.pending.delete(requestId);
      clearTimeout(pending.timeout);
      if (code) pending.reject(readError(PUBLIC_CODES.has(code) ? code : STORAGE_UNAVAILABLE));
      else pending.resolve({ rows, snapshotId });
      if (!this.pending.size) {
        worker.unref();
        this.idle = setTimeout(() => this.retire(worker), VIEW_LIFETIME_MS);
        this.idle.unref();
      }
    });
    worker.on("error", () => this.retire(worker, true));
    worker.on("exit", () => this.retire(worker, true));
  }

  retire(worker, backoff = false) {
    if (!worker || worker !== this.worker) return;
    this.worker = null;
    clearTimeout(this.idle);
    if (backoff) this.retryAt = performance.now() + RETRY_DELAY_MS;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(readError(STORAGE_UNAVAILABLE));
    }
    this.pending.clear();
    this.retiring = worker.terminate().catch(() => {}).finally(() => { this.retiring = null; });
  }

  async close() {
    this.closed = true;
    this.retire(this.worker);
    await this.retiring;
  }
}

if (!isMainThread) serveDiscovery(parentPort);

module.exports = { CodexDesktopDiscovery };
