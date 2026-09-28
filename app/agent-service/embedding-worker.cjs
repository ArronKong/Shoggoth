"use strict";

const { E5Encoder, embeddingError } = require("./e5-encoder");
const { NativeSemanticIndex, validateDocument } = require("./native-semantic-index");

let encoder, index, draining = false, closing = false;
const high = [], low = [];
const priorityMethods = new Set(["init", "query", "stats", "cancel", "reset", "close"]);

function reply(message, result, error = null) {
  if (!process.connected) return;
  process.send({ id: message.id, ...(error
    ? { error: /^E5_[A-Z0-9_]+$/u.test(error.code || "") ? error.code : "E5_WORKER_UNAVAILABLE" }
    : { result }) });
}

async function handle(message) {
  const { method, args } = message;
  if (closing && method !== "close") throw embeddingError("E5_WORKER_CLOSED");
  if (method === "init") {
    if (encoder) throw embeddingError("E5_WORKER_ALREADY_INITIALIZED");
    encoder = new E5Encoder({ assetDirectory: args.assetDirectory });
    const status = await encoder.open();
    index = new NativeSemanticIndex({ paths: args.paths, modelIdentity: encoder.identity });
    return status;
  }
  if (method === "close") {
    closing = true;
    index?.close(); await encoder?.close();
    return { closed: true };
  }
  if (!index) throw embeddingError("E5_WORKER_NOT_READY");
  if (method === "stats") return { rssBytes: process.memoryUsage().rss,
    peakRssBytes: process.resourceUsage().maxRSS * 1024, modelIdentity: encoder.identity };
  if (method === "ready") return { ready: index.ready(args.profileId, args.domain, args.stamp) };
  if (method === "begin") return index.begin(args.profileId, args.domain, args.stamp);
  if (method === "upsert") {
    validateDocument(args.domain, args.document);
    if (index.reusable(args.profileId, args.domain, args.document)) {
      index.write(args.profileId, args.domain, args.stamp, args.epoch, args.document);
      return { reused: true };
    }
    const chunks = [];
    for (const range of encoder.sourceRanges(args.document.text)) {
      if (!index.current(args.profileId, args.domain, args.stamp, args.epoch)) throw embeddingError("E5_INDEX_CANCELLED");
      const vector = await encoder.encode(args.document.text.slice(range.start, range.end));
      chunks.push({ ...range, vector });
      // Foreground requests preempt background indexing at each source chunk.
      while (high.length) await respond(high.shift());
    }
    index.write(args.profileId, args.domain, args.stamp, args.epoch, args.document, chunks);
    return { reused: false, chunks: chunks.length };
  }
  if (method === "commit") return index.commit(args.profileId, args.domain, args.stamp, args.epoch);
  if (method === "query") {
    const vector = await encoder.encode(args.query, "query");
    return index.search(args.profileId, args.domain, args.stamp, vector, args.filter, args.limit);
  }
  if (method === "reset" || method === "cancel") {
    if (method === "reset") index.invalidate(args.profileId);
    else index.cancel(args.profileId, args.domain);
    for (let position = low.length - 1; position >= 0; position--) {
      if (low[position].args?.profileId !== args.profileId
        || (method === "cancel" && low[position].args?.domain !== args.domain)) continue;
      reply(low.splice(position, 1)[0], null, embeddingError("E5_INDEX_CANCELLED"));
    }
    return { invalidated: true };
  }
  throw embeddingError("E5_WORKER_METHOD_INVALID");
}

async function respond(message) {
  try { reply(message, await handle(message)); }
  catch (error) { reply(message, null, error); }
  if (closing && process.connected) process.disconnect();
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (!closing && (high.length || low.length)) await respond(high.shift() || low.shift());
  } finally { draining = false; }
}

process.on("message", message => {
  if (!message || !Number.isSafeInteger(message.id) || message.id < 1
    || typeof message.method !== "string" || !message.args || typeof message.args !== "object") return;
  (priorityMethods.has(message.method) ? high : low).push(message);
  void drain();
});
process.on("disconnect", () => {
  if (closing) return;
  closing = true;
  try { index?.close(); } catch {}
  void encoder?.close().catch(() => {});
});
