"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const results = require("../app/agent-service/product-tool-results");

test("only large results of pageable tools become a preview with a ref", () => {
  const cache = new results.ProductResultCache();
  assert.equal(results.pagedResult(cache, "web_fetch", { text: "small" }), null);
  const big = { content: "x".repeat(results.LARGE_RESULT_BYTES + 10) };
  for (const whole of ["browser_tool_call", "computer_snapshot", "group_messages_read", "render_ui", "workspace_execute",
    "request_user_input"]) assert.equal(results.pagedResult(cache, whole, big), null, whole);
  const paged = results.pagedResult(cache, "web_fetch", big);
  assert.equal(paged.truncated, true);
  assert.match(paged.resultRef, /^res-[0-9a-f]{24}$/u);
  assert.equal(paged.preview.length, results.PREVIEW_CHARACTERS);
  assert.equal(paged.nextOffset, results.PREVIEW_CHARACTERS);
  assert.ok(Buffer.byteLength(JSON.stringify(paged)) < 8 * 1024, "the returned preview is a small fraction of the result");
});

test("reads page through the exact original text and expire oldest first", () => {
  const cache = new results.ProductResultCache();
  const text = JSON.stringify({ body: "abc".repeat(20_000) });
  const ref = cache.put(text);
  let offset = 0, rebuilt = "";
  for (;;) {
    const page = cache.read(ref, offset);
    rebuilt += page.text;
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  assert.equal(rebuilt, text);
  assert.equal(cache.read(ref, text.length + 5).text, "");
  assert.equal(cache.read("res-000000000000000000000000", 0), null);
  for (let n = 0; n < 40; n++) cache.put(`entry-${n}`);
  assert.equal(cache.read(ref, 0), null, "the oldest result expires once the cache is full");
});

test("read arguments are strict", () => {
  assert.equal(results.validReadArguments({ resultRef: "res-0123456789abcdef01234567", offset: 0 }), true);
  for (const bad of [null, {}, { resultRef: "res-1", offset: 0 }, { resultRef: "res-0123456789abcdef01234567", offset: -1 },
    { resultRef: "res-0123456789abcdef01234567", offset: 0, length: 16_001 },
    { resultRef: "res-0123456789abcdef01234567", offset: 0, extra: 1 }]) {
    assert.equal(results.validReadArguments(bad), false, JSON.stringify(bad));
  }
});
