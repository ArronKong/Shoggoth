"use strict";

// Fixture-only wire evidence. Never retain tool arguments or successful bodies.
const crypto = require("node:crypto");
const { Transform } = require("node:stream");
const { StringDecoder } = require("node:string_decoder");
const { redactDiagnostic } = require("../app/agent-service/codex-rpc-safety");

function createMcpEvidenceObserver(record) {
  const calls = new Map();
  const returnedIds = new Set(), returnedPaths = new Set(), searches = new Set(), queries = new Set();
  const hash = value => crypto.createHash("sha256").update(value).digest("hex");
  const remember = (set, value) => { if (typeof value === "string" && set.size < 4096) set.add(hash(value)); };
  const kind = value => typeof value !== "string" ? "absent-or-invalid"
    : value.startsWith("shared-memory:") ? "borrowed-id" : value.startsWith("shared/") ? "borrowed-path"
      : value === "MEMORY.md" || /^memory\/\d{4}-\d{2}-\d{2}\.md$/u.test(value) ? "own-memory-file"
        : value.startsWith("/") ? "absolute-path" : "other-string";
  const connection = crypto.randomUUID();
  return direction => {
    let pending = "", dropping = false;
    const decoder = new StringDecoder("utf8");
    return new Transform({ transform(chunk, encoding, done) {
      pending += decoder.write(chunk);
      for (let end; (end = pending.indexOf("\n")) >= 0;) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (dropping) { dropping = false; continue; }
        try {
          const message = JSON.parse(line), id = JSON.stringify(message.id);
          const entry = { connection, direction, method: message.method ?? "response" };
          if (message.id !== undefined) entry.requestId = message.id;
          if (direction === "client" && message.method === "tools/call") {
            entry.toolName = message.params?.name;
            if (calls.size < 512) calls.set(id, { name: entry.toolName, startedAt: Date.now() });
            if (entry.toolName === "memory_search") {
              const args = message.params?.arguments || {};
              const lookup = hash(JSON.stringify(Object.keys(args).sort().map(key => [key, args[key]])));
              entry.lookupSeenBefore = searches.has(lookup);
              entry.querySeenBefore = typeof args.query === "string" && queries.has(hash(args.query));
              entry.searchTrackingSaturated = searches.size >= 4096 || queries.size >= 4096;
              if (searches.size < 4096) searches.add(lookup);
              remember(queries, args.query);
            }
            if (entry.toolName === "memory_get") {
              const args = message.params?.arguments || {};
              const allowed = ["source", "sourceId", "id", "path", "from", "lines"];
              entry.argumentShape = { fields: allowed.filter(key => Object.hasOwn(args, key)),
                unknownFields: Object.keys(args).filter(key => !allowed.includes(key)).length,
                idKind: kind(args.id), pathKind: kind(args.path),
                idFromSearch: typeof args.id === "string" && returnedIds.has(hash(args.id)),
                pathFromSearch: typeof args.path === "string" && returnedPaths.has(hash(args.path)),
                fromValidInteger: args.from === undefined || Number.isSafeInteger(args.from) && args.from > 0,
                linesValidInteger: args.lines === undefined || Number.isSafeInteger(args.lines) && args.lines > 0 && args.lines <= 200 };
            }
          }
          if (message.method === "initialize") entry.capabilities = Object.keys(message.params?.capabilities ?? {});
          if (direction === "helper" && !message.method && calls.has(id)) {
            const call = calls.get(id); calls.delete(id);
            entry.toolName = call.name; entry.elapsedMs = Date.now() - call.startedAt;
            entry.isError = message.result?.isError === true || !!message.error;
            if (!entry.isError) {
              const value = message.result?.structuredContent;
              if (entry.toolName === "memory_search") {
                const results = Array.isArray(value?.results) ? value.results : [];
                entry.resultShape = { matches: results.length, borrowed: results.filter(row => row.borrowed === true).length };
                for (const row of results) { remember(returnedIds, row.id); remember(returnedIds, row.sourceRef); remember(returnedPaths, row.path); }
              } else if (entry.toolName === "memory_get") {
                entry.resultShape = { borrowed: value?.borrowed === true,
                  textBytes: typeof value?.text === "string" ? Buffer.byteLength(value.text) : 0,
                  hasItem: Boolean(value?.item), hasCitation: typeof value?.citation === "string" };
              }
            }
          }
          if (direction === "helper" && (message.result?.isError === true || message.error)) {
            const body = JSON.stringify(message.error ? { error: message.error } : { result: message.result });
            entry.errorSha256 = crypto.createHash("sha256").update(body).digest("hex");
            entry.errorBytes = Buffer.byteLength(body);
            entry.errorBody = redactDiagnostic(body).slice(0, 16384);
            entry.errorTruncated = body.length > 16384;
            entry.errorCode = message.result?.structuredContent?.error?.code ?? message.error?.code;
          }
          record(entry);
        } catch { /* Malformed transport frames are not copied into diagnostics. */ }
      }
      if (pending.length > 1024 * 1024) { pending = ""; dropping = true; }
      // Product writers may zero the original buffer after acknowledgment.
      done(null, Buffer.from(chunk));
    } });
  };
}

module.exports = { createMcpEvidenceObserver };
