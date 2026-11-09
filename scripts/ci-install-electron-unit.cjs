"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { retryElectronDownload } = require("./ci-install-electron.cjs");

const version = "44.9.3";
const archive = `https://github.com/electron/electron/releases/download/v${version}/electron-v${version}-linux-x64.zip`;

test("an official Electron download retries gateway errors and discards failed responses", async () => {
  let cancelled = 0;
  const responses = [504, 502, 503].map(status => new Response(new ReadableStream({
    cancel() { cancelled++; },
  }), { status }));
  const ok = new Response("archive bytes");
  const delays = [], logs = [];
  const options = { method: "GET", signal: new AbortController().signal };
  const fetch = retryElectronDownload(version, async (url, init) => {
    assert.equal(url, archive);
    assert.equal(init, options);
    return responses.shift() || ok;
  }, { pause: async (ms, _value, init) => {
    assert.equal(init.signal, options.signal);
    delays.push(ms);
  }, log: line => logs.push(line) });

  assert.equal(await fetch(archive, options), ok);
  assert.deepEqual(delays, [15_000, 45_000, 120_000]);
  assert.equal(cancelled, 3);
  assert.match(logs[0], /HTTP 504.*attempt 2\/4/u);
});

test("four gateway failures return the final response to the locked installer", async () => {
  const responses = Array.from({ length: 4 }, () => new Response(null, { status: 504 }));
  const last = responses.at(-1);
  const fetch = retryElectronDownload(version, async () => {
    assert.ok(responses.length, "download must stop after four attempts");
    return responses.shift();
  }, { pause: async () => {}, log: () => {} });
  assert.equal(await fetch(archive), last);
  assert.equal(responses.length, 0);
});

test("other URLs, non-GET methods and permanent HTTP failures are never retried", async () => {
  for (const [url, options, status] of [
    [archive, undefined, 404],
    [archive, { method: "POST" }, 504],
    [archive.replace("github.com", "example.invalid"), undefined, 504],
    [archive.replace("electron-v44.9.3-linux-x64.zip", "SHASUMS256.txt"), undefined, 504],
    [archive.replaceAll(version, "44.9.4"), undefined, 504],
  ]) {
    const response = new Response(null, { status });
    let calls = 0;
    const fetch = retryElectronDownload(version, async () => { calls++; return response; }, {
      pause: async () => assert.fail("unexpected retry"),
    });
    assert.equal(await fetch(url, options), response);
    assert.equal(calls, 1);
  }
});
