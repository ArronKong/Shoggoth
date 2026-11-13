"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { DOMParser } = require("@xmldom/xmldom");
const { requestPublic } = require("./web-service");
const { digest, fail, scalar, validText, watchUrl } = require("./condition-watch-protocol");

const MAX_BYTES = 1024 * 1024;
const MAX_ENTRIES = 1000;
const MAX_FEED_SEEN = 2000;
const MAX_FEED_AGE = 30 * 86_400_000;
const MAX_EVIDENCE_BYTES = 4 * 1024;
const ATOM = "http://www.w3.org/2005/Atom";
const EXCLUDED_TAGS = new Set(["script", "style", "template", "noscript", "iframe", "object"]);
const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = require("node:fs").constants;
const MAX_LOG_READ_BYTES = 256 * 1024;
const MAX_LOG_LINE_BYTES = 64 * 1024;
const LOG_ANCHOR_BYTES = 256;

function literalText(value, limit = 512) {
  const text = value.replace(/\s+/gu, " ").replace(/[\u0000-\u001f\u007f\p{Bidi_Control}]/gu, "").trim();
  return text.length <= limit ? text : text.slice(0, limit).toWellFormed();
}

function readMarkup(text, html) {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(html ? text.replace(/^\s*<!doctype\s+html\s*>/iu, "") : text)) {
    fail("WATCH_SOURCE_INVALID");
  }
  let invalid = false;
  // Bound parser work in addition to the HTTP byte cap.
  const markup = html ? text.replace(/^\s*<!doctype\s+html\s*>/iu, "") : text;
  if ((markup.match(/</gu)?.length ?? 0) > 12_000) fail("WATCH_SOURCE_INVALID");
  const parser = new DOMParser({ errorHandler: {
    warning: () => { if (!html) invalid = true; },
    error: () => { invalid = true; },
    fatalError: () => { fail("WATCH_SOURCE_INVALID"); },
  } });
  const doc = parser.parseFromString(markup, html ? "text/html" : "application/xml");
  if (invalid || !doc?.documentElement) fail("WATCH_SOURCE_INVALID");
  return doc;
}

function markupDepth(root) {
  const stack = [[root, 0]];
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (depth > 64) fail("WATCH_SOURCE_INVALID");
    for (let child = node.lastChild; child; child = child.previousSibling) stack.push([child, depth + 1]);
  }
}

function elementText(text, elementId) {
  const doc = readMarkup(text, true);
  const roots = [];
  const stack = [doc];
  while (stack.length) {
    const node = stack.pop();
    if (node.nodeType === 1 && (EXCLUDED_TAGS.has(node.localName.toLowerCase()) || node.hasAttribute("hidden"))) continue;
    if (node.nodeType === 1 && node.getAttribute("id") === elementId) roots.push(node);
    for (let child = node.lastChild; child; child = child.previousSibling) stack.push(child);
  }
  if (roots.length !== 1) fail("WATCH_SOURCE_INVALID");
  stack.push(roots[0]);
  const chunks = [];
  while (stack.length) {
    const node = stack.pop();
    if (node.nodeType === 1 && (EXCLUDED_TAGS.has(node.localName.toLowerCase()) || node.hasAttribute("hidden"))) continue;
    if ([3, 4].includes(node.nodeType)) chunks.push(node.data);
    for (let child = node.lastChild; child; child = child.previousSibling) stack.push(child);
  }
  const result = literalText(chunks.join(" "), 513);
  if (!validText(result, 512)) fail("WATCH_SOURCE_INVALID");
  return result;
}

function children(node, name, ns = "") {
  return Array.from(node.childNodes).filter(child =>
    child.nodeType === 1 && child.localName === name && (child.namespaceURI || "") === ns);
}

function childText(node, name, ns = "") {
  return children(node, name, ns)[0]?.textContent?.trim() || "";
}

function readFeed(text, source, now) {
  const doc = readMarkup(text, false);
  markupDepth(doc);
  const root = doc.documentElement;
  const atom = root.localName === "feed" && root.namespaceURI === ATOM;
  const channel = atom ? root : root.localName === "rss" && children(root, "channel")[0];
  if (!channel) fail("WATCH_SOURCE_INVALID");
  const rows = children(channel, atom ? "entry" : "item", atom ? ATOM : "");
  if (rows.length > MAX_ENTRIES) fail("WATCH_SOURCE_INVALID");
  const entries = new Map();
  for (const row of rows) {
    const ns = atom ? ATOM : "";
    const title = literalText(childText(row, "title", ns), 200);
    const link = atom ? children(row, "link", ATOM).find(node => ["", "alternate"].includes(node.getAttribute("rel")))?.getAttribute("href")
      : childText(row, "link");
    let url = null;
    try { if (link) url = watchUrl(new URL(link, source).href).href; } catch { /* Feed evidence can link to the feed itself. */ }
    const id = childText(row, atom ? "id" : "guid", ns) || url;
    if (!validText(id, 2048) || !title) fail("WATCH_SOURCE_INVALID");
    const date = childText(row, atom ? "published" : "pubDate", ns) || (atom ? childText(row, "updated", ns) : "");
    const timestamp = date && /(?:Z|GMT|[+-]\d{2}:?\d{2})$/iu.test(date) ? Date.parse(date) : NaN;
    const publishedAt = Number.isFinite(timestamp) && timestamp >= 0 && timestamp <= now + 60_000 ? timestamp : null;
    const key = digest(id);
    if (!entries.has(key)) entries.set(key, { key, title, url, publishedAt });
  }
  return [...entries.values()];
}

function readJson(text, source) {
  let value;
  try { value = JSON.parse(text); } catch { fail("WATCH_SOURCE_INVALID"); }
  for (const segment of source.path) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, segment)) fail("WATCH_SOURCE_INVALID");
    value = value[segment];
  }
  if (typeof value === "string") value = literalText(value, 513);
  if (!scalar(value)) fail("WATCH_SOURCE_INVALID");
  return value;
}

function identity(stat) { return [String(stat.dev), String(stat.ino)]; }
function sameIdentity(stat, expected) {
  return stat.isDirectory() && identity(stat).every((part, i) => part === expected[i]);
}
function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function localPath(source, { workspace, protectedRoots, managedWorkspaceRoot }) {
  if (!workspace || !path.isAbsolute(workspace)) fail("WATCH_SOURCE_DENIED");
  const target = path.resolve(workspace, source.path);
  const managed = managedWorkspaceRoot && within(managedWorkspaceRoot, workspace) && workspace !== managedWorkspaceRoot;
  if (!within(workspace, target) || protectedRoots.some(root => (within(root, workspace) || within(workspace, root))
    && !(managed && within(root, managedWorkspaceRoot)))) fail("WATCH_SOURCE_DENIED");
  return target;
}

async function readDirectory(source, options) {
  const { workspace, expected, signal } = options;
  const target = localPath(source, options);
  const check = async () => {
    // The canonical path must remain under the same authorized directory.
    if (await fs.realpath(workspace) !== workspace || await fs.realpath(target) !== target) fail("WATCH_SOURCE_DENIED");
    const root = await fs.lstat(workspace, { bigint: true });
    const entry = await fs.lstat(target, { bigint: true });
    if (!root.isDirectory() || !entry.isDirectory()
      || expected && (!sameIdentity(root, expected.workspace) || !sameIdentity(entry, expected.directory))) fail("WATCH_SOURCE_DENIED");
    return { workspace: identity(root), directory: identity(entry), modifiedAt: String(entry.mtimeNs) };
  };
  const before = await check();
  const handle = await fs.open(target, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    if (!sameIdentity(await handle.stat({ bigint: true }), before.directory)) fail("WATCH_SOURCE_DENIED");
    const dir = await fs.opendir(target, { bufferSize: 32 });
    const value = [];
    let count = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const entry = await dir.read();
        if (!entry) break;
        if (++count > MAX_ENTRIES) fail("WATCH_SOURCE_INVALID");
        if (entry.isFile() && !entry.name.startsWith(".") && validText(entry.name, 255)) value.push(entry.name);
      }
    } finally { await dir.close(); }
    const after = await check();
    if (before.modifiedAt !== after.modifiedAt) fail("WATCH_SOURCE_UNAVAILABLE");
    if (JSON.stringify(before.workspace) !== JSON.stringify(after.workspace)
      || !sameIdentity(await handle.stat({ bigint: true }), after.directory)
      || before.directory.some((part, index) => part !== after.directory[index])) fail("WATCH_SOURCE_DENIED");
    return { value: value.sort(), binding: { workspace: before.workspace, directory: before.directory } };
  } finally { await handle.close(); }
}

const logIdentity = stat => [...identity(stat), String(stat.birthtimeNs)];
const sameLog = (stat, file) => logIdentity(stat).every((part, i) => part === file[i]);
const logHash = bytes => createHash("sha256").update(bytes).digest("hex");

async function logBytes(handle, start, length) {
  const bytes = Buffer.alloc(length);
  if (length && (await handle.read(bytes, 0, length, start)).bytesRead !== length) fail("WATCH_SOURCE_UNAVAILABLE");
  return bytes;
}

function logTail(handle, offset) {
  const length = Math.min(LOG_ANCHOR_BYTES, offset);
  return logBytes(handle, offset - length, length);
}

function scanLog(bytes, contains, discard) {
  const needle = Buffer.from(contains);
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  let consumed = 0, count = 0, gap = false;
  for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, consumed)) {
    const line = bytes.subarray(consumed, end);
    consumed = end + 1;
    if (discard) { discard = false; continue; }
    if (line.length > MAX_LOG_LINE_BYTES || line.includes(0)) { gap = true; continue; }
    try { utf8.decode(line); } catch { gap = true; continue; }
    if (line.includes(needle)) count++;
  }
  if (!discard && bytes.length - consumed > MAX_LOG_LINE_BYTES) { discard = true; gap = true; }
  return { consumed: discard ? bytes.length : consumed, discard, count, gap };
}

async function readLog(source, contains, options) {
  const { workspace, expected, cursor, signal } = options;
  const target = localPath(source, options);
  const parentPath = path.dirname(target);
  const inspect = async () => {
    signal.throwIfAborted();
    if (await fs.realpath(workspace) !== workspace || await fs.realpath(parentPath) !== parentPath) fail("WATCH_SOURCE_DENIED");
    const root = await fs.lstat(workspace, { bigint: true });
    const parent = await fs.lstat(parentPath, { bigint: true });
    const entry = await fs.lstat(target, { bigint: true });
    if (!root.isDirectory() || !parent.isDirectory() || !entry.isFile() || entry.nlink !== 1n
      || expected && (!sameIdentity(root, expected.workspace) || !sameIdentity(parent, expected.parent))) fail("WATCH_SOURCE_DENIED");
    return { root, parent, entry };
  };
  const before = await inspect();
  const binding = { workspace: identity(before.root), parent: identity(before.parent) };
  // Nonblocking also rejects a FIFO substituted between lstat and open without waiting for a writer.
  const handle = await fs.open(target, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const entry = await handle.stat({ bigint: true });
    if (!entry.isFile() || entry.nlink !== 1n) fail("WATCH_SOURCE_DENIED");
    const file = logIdentity(entry);
    if (!sameLog(before.entry, file)) fail("WATCH_SOURCE_UNAVAILABLE");
    const size = Number(entry.size);
    if (!Number.isSafeInteger(size)) fail("WATCH_SOURCE_INVALID");
    let start = cursor?.offset ?? size;
    let tail = start <= size ? await logTail(handle, start) : Buffer.alloc(0);
    let discard = cursor ? cursor.discard : start > 0 && tail.at(-1) !== 10;
    // Detect rename/recreate, short truncation and truncation followed by regrowth.
    const reset = Boolean(cursor && (!sameLog(entry, cursor.file) || start > size || logHash(tail) !== cursor.anchor));
    if (reset) { start = 0; tail = Buffer.alloc(0); discard = false; }
    const bytes = await logBytes(handle, start, Math.min(MAX_LOG_READ_BYTES, size - start));
    const scanned = scanLog(bytes, contains, discard);
    const offset = start + scanned.consumed;
    const endTail = Buffer.concat([tail, bytes.subarray(0, scanned.consumed)]).subarray(-LOG_ANCHOR_BYTES);
    const final = await handle.stat({ bigint: true });
    if (final.nlink !== 1n || final.size < entry.size
      || !(await logTail(handle, start)).equals(tail) || !(await logTail(handle, offset)).equals(endTail)) fail("WATCH_SOURCE_UNAVAILABLE");
    const after = await inspect();
    if (!sameIdentity(after.root, binding.workspace) || !sameIdentity(after.parent, binding.parent)) fail("WATCH_SOURCE_DENIED");
    if (!sameLog(after.entry, file) || after.entry.size < final.size) fail("WATCH_SOURCE_UNAVAILABLE");
    return { binding, log: { cursor: { file, offset, anchor: logHash(endTail), discard: scanned.discard },
      count: scanned.count, gap: reset || scanned.gap, backlog: start + bytes.length < size } };
  } finally { await handle.close(); }
}

function retryTime(header, now) {
  if (typeof header !== "string") return null;
  const until = /^\d+$/u.test(header) ? now + Number(header) * 1000 : Date.parse(header);
  return Number.isSafeInteger(until) && until > now && until < 8.64e15 ? until : null;
}

async function probe(definition, { signal, now, request = requestPublic, workspace, protectedRoots = [],
  managedWorkspaceRoot, binding = null, validator = null, logCursor = null, preview = false, beforeRequest }) {
  const { source } = definition;
  signal.throwIfAborted();
  if (source.kind === "directory") return readDirectory(source, { workspace, protectedRoots, managedWorkspaceRoot, expected: binding, signal });
  if (source.kind === "log_file") return readLog(source, definition.predicate.contains,
    { workspace, protectedRoots, managedWorkspaceRoot, expected: binding, cursor: preview ? null : logCursor, signal });
  const original = watchUrl(binding?.url ?? source.url);
  const headers = { Accept: source.kind === "feed" ? "application/rss+xml, application/atom+xml, application/xml, text/xml"
    : source.kind === "public_json" ? "application/json" : "text/html" };
  if (validator?.etag) headers["If-None-Match"] = validator.etag;
  else if (validator?.lastModified) headers["If-Modified-Since"] = validator.lastModified;
  const response = await request(original.href, {
    signal, maxBytes: MAX_BYTES, headers, allowRedirects: preview, allowProxyFakeIp: false,
    acceptNotModified: Boolean(validator), captureRetryAfter: true, beforeRequest,
    redirectTarget: (_previous, next) => {
      const safe = watchUrl(next.href);
      if (safe.origin !== original.origin) fail("WATCH_SOURCE_DENIED");
      return safe;
    },
  });
  signal.throwIfAborted();
  const url = watchUrl(response.url);
  if (url.origin !== original.origin || !preview && url.href !== original.href) fail("WATCH_SOURCE_DENIED");
  if (response.status === 429) {
    try { fail("WATCH_RATE_LIMITED"); } catch (error) {
      error.retryAfter = retryTime(response.headers["retry-after"], now);
      throw error;
    }
  }
  if (response.status === 304 && validator) return { unchanged: true };
  if (response.status !== 200 || !response.body?.length || response.body.length > MAX_BYTES) fail("WATCH_SOURCE_INVALID");
  const type = String(response.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (source.kind === "public_html" && !["text/html", "application/xhtml+xml"].includes(type)
    || source.kind === "public_json" && !(type === "application/json" || type.endsWith("+json"))
    || source.kind === "feed" && !(type === "text/xml" || type === "application/xml" || type.endsWith("+xml"))) fail("WATCH_SOURCE_INVALID");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(response.body); } catch { fail("WATCH_SOURCE_INVALID"); }
  const value = source.kind === "public_json" ? readJson(text, source)
    : source.kind === "public_html" ? elementText(text, source.elementId) : readFeed(text, url.href, now);
  const cache = {};
  if (validText(response.headers.etag, 128)) cache.etag = response.headers.etag;
  if (validText(response.headers["last-modified"], 128)) cache.lastModified = response.headers["last-modified"];
  return { value, binding: { url: url.href }, validator: Object.keys(cache).length ? cache : null };
}

function matches(value, { op, value: operand }) {
  if (op === "changed") return null;
  if (typeof value !== typeof operand) fail("WATCH_SOURCE_INVALID");
  switch (op) {
    case "equals": return value === operand;
    case "contains": return value.includes(operand);
    case "lt": return value < operand;
    case "lte": return value <= operand;
    case "gt": return value > operand;
    case "gte": return value >= operand;
    default: fail("WATCH_INVALID");
  }
}

function evaluateScalar(definition, checkpoint, sample, now) {
  const value = sample.value;
  const current = matches(value, definition.predicate);
  const prior = checkpoint?.baseline;
  const changed = definition.predicate.op === "changed";
  if (prior && typeof prior.value !== typeof value) fail("WATCH_SOURCE_INVALID");
  const next = { baseline: prior ?? { value, matched: current }, observedAt: now, pending: null, validator: sample.validator };
  const eligible = changed ? prior && prior.value !== value
    : current && (prior ? !prior.matched : definition.notifyIfInitiallyMatched);
  if (!eligible) {
    next.baseline = { value, matched: current };
    return { checkpoint: next, outcome: prior ? "silent" : "seed", reason: prior ? "unchanged" : "baseline", evidence: null };
  }
  const key = changed ? value : true;
  const count = checkpoint?.pending?.key === key ? checkpoint.pending.count + 1 : 1;
  if (count < definition.confirmation) {
    if (!prior) next.baseline = null;
    next.pending = { key, count };
    next.validator = null;
    return { checkpoint: next, outcome: "silent", reason: "confirmation_pending", evidence: null };
  }
  next.baseline = { value, matched: current };
  return { checkpoint: next, outcome: "hit", reason: "matched",
    evidence: { previous: prior?.value ?? null, value, unit: definition.predicate.unit ?? null } };
}

function evaluateSet(definition, checkpoint, sample, now) {
  const feed = definition.source.kind === "feed";
  const rows = feed ? sample.value : sample.value.map(name => ({ key: digest(name), title: name }));
  const previous = checkpoint?.window;
  const window = rows.map(row => row.key);
  const old = new Set(previous || []);
  const known = new Map(feed ? (checkpoint?.seen ?? []).filter(([, seenAt]) => seenAt >= now - MAX_FEED_AGE) : []);
  const gap = feed && old.size > 0 && window.length > 0 && !window.some(key => old.has(key));
  const seenOverflow = feed && new Set([...known.keys(), ...window]).size > MAX_FEED_SEEN;
  const found = [];
  let watermark = checkpoint?.watermark ?? null;
  for (const row of rows) {
    const knownItem = old.has(row.key) || known.has(row.key);
    const afterGap = !gap || watermark !== null && row.publishedAt !== null && row.publishedAt > watermark;
    const { titleContains, prefix, extension } = definition.predicate;
    if (previous && !knownItem && afterGap && (!titleContains || row.title.includes(titleContains))
      && (!prefix || row.title.startsWith(prefix)) && (!extension || row.title.endsWith(extension))) found.push(row);
    if (feed) {
      known.delete(row.key);
      known.set(row.key, now);
    }
  }
  if (feed) for (const { publishedAt } of rows) {
    if (publishedAt !== null) watermark = Math.max(watermark ?? 0, publishedAt);
  }
  const next = { window, seen: [...known].slice(-MAX_FEED_SEEN), watermark, observedAt: now, validator: sample.validator };
  const evidence = found.length ? { count: found.length, items: [] } : null;
  for (const { title, url } of found.slice(0, 3)) {
    const item = { title, url: url ?? null };
    const candidate = { ...evidence, items: [...evidence.items, item] };
    if (Buffer.byteLength(JSON.stringify(candidate)) > MAX_EVIDENCE_BYTES) break;
    evidence.items.push(item);
  }
  return { checkpoint: next, outcome: found.length ? "hit" : previous ? "silent" : "seed",
    reason: gap || seenOverflow ? "coverage_gap" : found.length ? "matched" : previous ? "unchanged" : "baseline",
    evidence };
}

function evaluate(definition, checkpoint, sample, now) {
  if (definition.source.kind === "log_file") {
    const { cursor, count, gap, backlog } = sample.log;
    const seeded = checkpoint?.observedAt != null;
    return { checkpoint: { logCursor: cursor, observedAt: now }, outcome: count ? "hit" : seeded ? "silent" : "seed",
      reason: gap ? "coverage_gap" : backlog ? "log_backlog" : count ? "matched" : seeded ? "unchanged" : "baseline",
      evidence: count ? { count, gap } : null };
  }
  if (sample.unchanged) {
    if (!checkpoint?.validator || checkpoint.pending) fail("WATCH_SOURCE_INVALID");
    return { checkpoint: { ...checkpoint, observedAt: now }, outcome: "silent", reason: "not_modified", evidence: null };
  }
  return ["new_item", "new_entry"].includes(definition.predicate.op) ? evaluateSet(definition, checkpoint, sample, now)
    : evaluateScalar(definition, checkpoint, sample, now);
}

function previewSample(definition, sample, now) {
  const evaluation = evaluate(definition, null, sample, now);
  if (definition.source.kind === "log_file") return { observedAt: now, value: { count: 0 },
    matches: null, firstOutcome: evaluation.outcome, reason: evaluation.reason, binding: sample.binding,
    logCursor: sample.log.cursor };
  const set = Array.isArray(sample.value);
  return { observedAt: now, value: set ? { count: sample.value.length } : sample.value,
    matches: set ? null : matches(sample.value, definition.predicate),
    firstOutcome: evaluation.outcome, reason: evaluation.reason, binding: sample.binding };
}

module.exports = { probe, evaluate, previewSample, literalText, readFeed, elementText };
