"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { createPostHogTransport, retryAfterMs, ENDPOINTS } = require("../app/core/product-telemetry-posthog");
const { LIMITS } = require("../app/core/product-telemetry-schema");
const { BUILD, event, fakeClock } = require("./helpers/product-telemetry-fixtures.cjs");

const make = (fetchImpl, extra = {}) => createPostHogTransport({ projectToken: BUILD.projectToken, region: "us", fetchImpl, ...extra });

test("loopback receiver sees exact batch and no cookies/auth; production destination remains fixed HTTPS", async () => {
  let received;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      received = { headers: req.headers, body: JSON.parse(body), method: req.method, url: req.url };
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"status":"Ok"}');
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const t = make((url, options) => {
      assert.equal(url, ENDPOINTS.us);
      assert.equal(options.redirect, "manual");
      assert.equal(options.credentials, "omit");
      assert.deepEqual(Object.keys(options.headers), ["Content-Type"]);
      return fetch(`http://127.0.0.1:${server.address().port}/batch/`, options);
    });
    assert.deepEqual(await t.sendBatch([event()]), { kind: "ok" });
    assert.deepEqual(received.body, { api_key: BUILD.projectToken, batch: [event()] });
    assert.equal(received.method, "POST");
    assert.equal(received.url, "/batch/");
    for (const key of ["cookie", "authorization", "referer"]) assert.equal(received.headers[key], undefined);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test("no arbitrary hosts, secret keys, invalid/detailed events, sparse arrays or oversized batches", async () => {
  for (const region of ["https://attacker.test", "us.i.posthog.com", "US", ""]) {
    assert.throws(() => make(() => {}, { region }), /UNCONFIGURED/u);
  }
  for (const projectToken of ["phx_secret", "phs_secret", "", "phc_ValidToken\n"]) {
    assert.throws(() => make(() => {}, { projectToken }), /UNCONFIGURED/u);
  }
  let hits = 0;
  const t = make(async () => { hits++; return new Response('{"status":1}'); });
  const badArray = [event()];
  badArray.toJSON = () => [{ prompt: "SECRET_CANARY" }];
  for (const events of [[], [null], new Array(1), badArray, Array.from({ length: 21 }, () => event()),
    [{ ...event(), prompt: "SECRET_CANARY" }], [{ ...event(), event: "shoggoth_daily_feature_usage" }]]) {
    assert.deepEqual(await t.sendBatch(events), { kind: "pause", code: "protocol_error" });
  }
  assert.equal(hits, 0);
  const eu = make(async (url) => { assert.equal(url, ENDPOINTS.eu); return new Response('{"status":1}'); }, { region: "eu" });
  assert.deepEqual(await eu.sendBatch([event()]), { kind: "ok" });
});

test("429/5xx retry, bounded Retry-After, no redirects, permanent 4xx and protocol failures pause", async () => {
  for (const status of [429, 500, 503, 599]) {
    const result = await make(async () => new Response("SECRET_CANARY", { status, headers: { "Retry-After": "9999999" } })).sendBatch([event()]);
    assert.deepEqual(result, { kind: "retry", code: "http_retry", retryAfterMs: LIMITS.retryMaxMs });
  }
  for (const status of [400, 401, 403, 413]) {
    assert.deepEqual(await make(async () => new Response("SECRET_CANARY", { status })).sendBatch([event()]), { kind: "pause", code: "http_rejected" });
  }
  for (const status of [201, 204, 302, 307]) {
    const t = make(async (_url, options) => {
      assert.equal(options.redirect, "manual");
      return new Response(status === 204 ? null : "SECRET_CANARY", { status, headers: { Location: "https://attacker.test" } });
    });
    assert.deepEqual(await t.sendBatch([event()]), { kind: "pause", code: "protocol_error" });
  }
  for (const body of ["1", "", "<html>SECRET_CANARY</html>", '{"status":0}', "x".repeat(2049)]) {
    assert.deepEqual(await make(async () => new Response(body)).sendBatch([event()]), { kind: "pause", code: "protocol_error" });
  }
  assert.deepEqual(await make(async () => new Response('{"status":"Ok","quota_limited":["events"]}')).sendBatch([event()]), { kind: "pause", code: "quota_limited" });
});

test("Retry-After handles seconds/date, clamps and ignores malformed metadata", () => {
  const now = Date.parse("2026-09-10T02:00:00Z");
  assert.equal(retryAfterMs("30", now), 30_000);
  assert.equal(retryAfterMs("Thu, 10 Sep 2026 02:00:15 GMT", now), 15_000);
  assert.equal(retryAfterMs("0", now), 0);
  assert.equal(retryAfterMs("99999999", now), 900_000);
  for (const value of [undefined, "invalid", "x".repeat(200), "Wed, 09 Sep 2026 00:00:00 GMT"]) assert.equal(retryAfterMs(value, now), 0);
});

test("lost ACK/network error retries with fixed error codes, never response/error text", async () => {
  const t = make(async () => { throw new Error("SECRET_CANARY with /private/path"); });
  assert.deepEqual(await t.sendBatch([event()]), { kind: "retry", code: "network", retryAfterMs: 0 });
  const partial = make(async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"status":'));
      controller.error(new Error("SECRET_CANARY connection reset during ACK"));
    },
  })));
  assert.deepEqual(await partial.sendBatch([event()]), { kind: "retry", code: "network", retryAfterMs: 0 },
    "an interrupted response body is a transient network failure, not a permanent protocol pause");
});

test("deadline includes stalled fetch and body; explicit cancellation cleans timers", async () => {
  for (const phase of ["fetch", "body"]) {
    const clock = fakeClock();
    let requestSignal;
    const t = make(async (_url, options) => {
      requestSignal = options.signal;
      if (phase === "fetch") return new Promise(() => {});
      return new Response(new ReadableStream({ start() {} }));
    }, { clock });
    const pending = t.sendBatch([event()]);
    clock.advance(LIMITS.timeoutMs);
    await clock.runDue();
    assert.deepEqual(await pending, { kind: "retry", code: "timeout", retryAfterMs: 0 });
    assert.equal(requestSignal.aborted, true);
    assert.equal(clock.timers.size, 0);
  }
  const clock = fakeClock();
  const ctrl = new AbortController();
  let seenSignal;
  const t = make(async (_url, opts) => { seenSignal = opts.signal; return new Promise(() => {}); }, { clock });
  const pending = t.sendBatch([event()], { signal: ctrl.signal });
  ctrl.abort();
  assert.deepEqual(await pending, { kind: "canceled" });
  assert.equal(seenSignal.aborted, true);
  assert.equal(clock.timers.size, 0);
  assert.deepEqual(await t.sendBatch([event()], { signal: ctrl.signal }), { kind: "canceled" });
});
