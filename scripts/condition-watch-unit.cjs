"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { normalizeDefinition } = require("../app/agent-service/condition-watch-protocol");
const { probe, evaluate, previewSample, readFeed, elementText } = require("../app/agent-service/condition-watch-probe");
const { requestPublic } = require("../app/agent-service/web-service");

const NOW = Date.UTC(2026, 10, 13, 2);
const signal = AbortSignal.timeout(3_000);
const stock = (extra = {}) => normalizeDefinition({
  name: "Stock", source: { kind: "public_json", url: "https://shop.example.com/items/128", path: ["stock"] },
  predicate: { op: "equals", value: true }, ...extra,
});

test("preview and edge comparison keep independent state and confirm on fresh observations", () => {
  const rule = stock({ confirmation: 2 });
  const sample = value => ({ value, binding: { url: rule.source.url }, validator: { etag: '"1"' } });
  assert.equal(previewSample(rule, sample(true), NOW).matches, true);
  let result = evaluate(rule, null, sample(false), NOW);
  assert.equal(result.outcome, "seed");
  result = evaluate(rule, result.checkpoint, { unchanged: true }, NOW + 60_000);
  assert.equal(result.reason, "not_modified");
  result = evaluate(rule, result.checkpoint, sample(true), NOW + 120_000);
  assert.equal(result.reason, "confirmation_pending");
  assert.equal(result.checkpoint.baseline.value, false);
  assert.equal(result.checkpoint.validator, null);
  result = evaluate(rule, result.checkpoint, sample(true), NOW + 180_000);
  assert.equal(result.outcome, "hit");
  assert.deepEqual(result.evidence, { previous: false, value: true, unit: null });
  assert.equal(evaluate(rule, result.checkpoint, sample(true), NOW + 240_000).outcome, "silent");
  assert.throws(() => evaluate(rule, result.checkpoint, sample("true"), NOW), { code: "WATCH_SOURCE_INVALID" });
  const immediate = stock({ notifyIfInitiallyMatched: true, confirmation: 2 });
  const first = evaluate(immediate, null, sample(true), NOW);
  assert.equal(first.checkpoint.baseline, null);
  assert.equal(evaluate(immediate, first.checkpoint, sample(true), NOW + 60_000).outcome, "hit");
});

test("public fetch is bounded, validates the selected field and honors source backoff", async () => {
  const options = { now: NOW, signal, request: async (url, input) => {
    assert.equal(input.allowProxyFakeIp, false);
    assert.equal(input.maxBytes, 1024 * 1024);
    assert.equal(input.allowRedirects, true);
    assert.throws(() => input.redirectTarget(new URL(url), new URL("https://other.example.com/")), { code: "WATCH_SOURCE_DENIED" });
    return { url, status: 200, headers: { "content-type": "application/json; charset=utf-8", etag: '"stock"' },
      body: Buffer.from('{"stock":false}') };
  } };
  const result = await probe(stock(), { ...options, preview: true });
  assert.equal(result.value, false);
  assert.equal(result.validator.etag, '"stock"');
  assert.equal((await probe(stock(), { ...options, validator: result.validator, request: async (url, input) => {
    assert.equal(input.headers["If-None-Match"], '"stock"');
    assert.equal(input.allowRedirects, false);
    return { url, status: 304, headers: {} };
  } })).unchanged, true);
  await assert.rejects(probe(stock(), { ...options, request: async url => ({ url, status: 429,
    headers: { "retry-after": "420" } }) }), { code: "WATCH_RATE_LIMITED", retryAfter: NOW + 420_000 });
  await assert.rejects(requestPublic("https://shop.example.com/", { signal, allowProxyFakeIp: false,
    lookup: async () => [{ address: "198.18.0.10", family: 4 }], request: () => assert.fail("no connection") }), { code: "WEB_URL_BLOCKED" });
  assert.throws(() => stock({ source: { kind: "public_json", url: "https://shop.example.com/?access_token=abc", path: [] } }), { code: "WATCH_SOURCE_DENIED" });
});

test("static HTML and feeds ignore executable markup and validate identities", () => {
  assert.equal(elementText('<!DOCTYPE html><div id="stock">In <b>stock</b><script>ignored()</script></div>', "stock"), "In stock");
  assert.throws(() => elementText('<span id="stock">Yes</span><span id="stock">No</span>', "stock"), { code: "WATCH_SOURCE_INVALID" });
  assert.throws(() => readFeed('<!DOCTYPE rss SYSTEM "file:///ignored"><rss><channel/></rss>', "https://example.com/feed", NOW),
    { code: "WATCH_SOURCE_INVALID" });
  const rule = normalizeDefinition({ name: "Updates", source: { kind: "feed", url: "https://example.com/feed" },
    predicate: { op: "new_item", titleContains: "Example Widget" } });
  const parse = rows => ({ value: readFeed(`<rss version="2.0"><channel>${rows}</channel></rss>`, rule.source.url, NOW) });
  const entry = (id, title) => `<item><guid>${id}</guid><title>${title}</title><link>/news/${id}</link></item>`;
  const first = entry("old", "Example Widget earlier");
  const newEntry = entry("new", "Example Widget latest");
  const seed = evaluate(rule, null, parse(first), NOW);
  const hit = evaluate(rule, seed.checkpoint, parse(first + newEntry + newEntry), NOW + 60_000);
  assert.equal(hit.outcome, "hit");
  assert.deepEqual(hit.evidence, { count: 1, items: [{ title: "Example Widget latest", url: "https://example.com/news/new" }] });
  assert.equal(evaluate(rule, hit.checkpoint, parse(newEntry + first), NOW + 120_000).outcome, "silent");
  const atom = readFeed('<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>one</id><title>Title</title><link href="/a"/></entry></feed>',
    rule.source.url, NOW);
  assert.equal(atom[0].url, "https://example.com/a");
});

test("directory sampling checks the granted directory identity and reads only direct ordinary names", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "watch-source-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inbox = path.join(root, "inbox");
  fs.mkdirSync(inbox);
  fs.writeFileSync(path.join(inbox, "new.txt"), "private file contents");
  fs.writeFileSync(path.join(inbox, ".env"), "ignored");
  fs.symlinkSync(path.join(inbox, "new.txt"), path.join(inbox, "link"));
  const rule = normalizeDefinition({ name: "Files", source: { kind: "directory", path: "inbox" }, predicate: { op: "new_entry" } });
  const seeded = await probe(rule, { signal, now: NOW, workspace: root });
  assert.deepEqual(seeded.value, ["new.txt"]);
  fs.renameSync(inbox, path.join(root, "old"));
  fs.mkdirSync(inbox);
  await assert.rejects(probe(rule, { signal, now: NOW, workspace: root, binding: seeded.binding }), { code: "WATCH_SOURCE_DENIED" });
  await assert.rejects(probe(rule, { signal, now: NOW, workspace: root, protectedRoots: [root] }), { code: "WATCH_SOURCE_DENIED" });
});

test("log watches resume from a durable cursor and count only complete new matching lines", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "watch-log-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "service.log");
  fs.writeFileSync(file, "ERROR old\nERROR pre-existing partial");
  const rule = normalizeDefinition({ name: "Logs", source: { kind: "log_file", path: "service.log" },
    predicate: { op: "new_line", contains: "ERROR" } });
  const options = { workspace: root, signal: AbortSignal.timeout(5000), now: NOW };
  const preview = previewSample(rule, await probe(rule, { ...options, preview: true }), NOW);
  assert.deepEqual(preview.value, { count: 0 });
  let checkpoint = { logCursor: preview.logCursor, observedAt: null };
  async function check() {
    const sample = await probe(rule, { ...options, binding: preview.binding, logCursor: checkpoint.logCursor });
    const result = evaluate(rule, checkpoint, sample, NOW);
    checkpoint = JSON.parse(JSON.stringify(result.checkpoint));
    return result;
  }
  fs.appendFileSync(file, "\nINFO ready\nERR");
  assert.equal((await check()).outcome, "seed");
  fs.appendFileSync(file, "OR sensitive-canary");
  assert.equal((await check()).outcome, "silent");
  fs.appendFileSync(file, "\r\nERROR again\n");
  const hit = await check();
  assert.deepEqual(hit.evidence, { count: 2, gap: false });
  assert.doesNotMatch(JSON.stringify(hit), /sensitive-canary/u);
  assert.equal((await check()).outcome, "silent");
  fs.renameSync(file, file + ".1");
  await assert.rejects(check(), { code: "ENOENT" });
  fs.writeFileSync(file, "ERROR after rotation\n");
  assert.deepEqual((await check()).evidence, { count: 1, gap: true });
  fs.writeFileSync(file, "ERROR replaced and regrown beyond the previous offset\n");
  assert.deepEqual((await check()).evidence, { count: 1, gap: true });
  fs.truncateSync(file, 0);
  assert.equal((await check()).reason, "coverage_gap");
  fs.appendFileSync(file, "x".repeat(256 * 1024) + "ERROR trailing oversize");
  assert.equal((await check()).reason, "coverage_gap");
  fs.appendFileSync(file, "\nERROR next line\n");
  assert.deepEqual((await check()).evidence, { count: 1, gap: false });
  assert.equal((await check()).outcome, "silent");
});

test("log reads reject links and protected roots, and log predicates cannot request model review", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "watch-log-scope-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const protectedRoot = path.join(root, "private"), workspace = path.join(root, "workspace");
  fs.mkdirSync(protectedRoot);
  fs.mkdirSync(workspace);
  const canary = path.join(protectedRoot, "private.log"), filename = path.join(workspace, "service.log");
  fs.writeFileSync(canary, "ERROR private\n");
  const input = { name: "Logs", source: { kind: "log_file", path: "service.log" },
    predicate: { op: "new_line", contains: "ERROR" } };
  const rule = normalizeDefinition(input);
  const options = { workspace, protectedRoots: [protectedRoot], signal: AbortSignal.timeout(5000), now: NOW };
  for (const link of [fs.symlinkSync, fs.linkSync]) {
    link(canary, filename);
    await assert.rejects(probe(rule, options), { code: "WATCH_SOURCE_DENIED" });
    fs.unlinkSync(filename);
  }
  await assert.rejects(probe(rule, { ...options, workspace: protectedRoot }), { code: "WATCH_SOURCE_DENIED" });
  for (const filename of [".", "/service.log", "../service.log", ".git/service.log"]) {
    assert.throws(() => normalizeDefinition({ ...input, source: { ...input.source, path: filename } }), { code: "WATCH_INVALID" });
  }
  assert.throws(() => normalizeDefinition({ ...input, action: "agent_review", reviewInstruction: "Review the line" }), { code: "WATCH_INVALID" });
  assert.throws(() => normalizeDefinition({ ...input, predicate: { op: "new_line" } }), { code: "WATCH_INVALID" });
});
