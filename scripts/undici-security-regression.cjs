"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

async function child(directory) {
  const undici = require(directory);
  const version = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")).version;
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests++;
    response.writeHead(200, {
      "content-encoding": "gzip, gzip, gzip, gzip, gzip, gzip",
      "content-length": "1", connection: "close",
    });
    response.flushHeaders();
    response.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    // GHSA-xjj6-f33q-929c: rejecting excessive encodings must not leave an
    // unhandled response-stream error capable of terminating the Service.
    await assert.rejects(undici.fetch(`http://127.0.0.1:${server.address().port}/`, {
      signal: AbortSignal.timeout(2000),
    }), error => /too many content-encodings/u.test(error.cause?.message || error.message));
    assert.equal(requests, 1);
  } finally {
    await undici.getGlobalDispatcher().close();
    await new Promise(resolve => server.close(resolve));
  }
  // Let a late error surface before the child records success and exits naturally.
  await new Promise(resolve => setTimeout(resolve, 50));
  console.log(JSON.stringify({ version, rejected: true, requests, closed: true }));
}

if (process.argv[2] === "--child") {
  child(process.argv[3]).catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const test = require("node:test");
  const root = path.resolve(__dirname, "..");
  for (const [label, directory] of [
    ["MCP HTTP client", path.join(root, "node_modules/undici")],
    ["memory core HTTP client", path.join(root, "build/shoggoth-memory/dependencies/undici")],
  ]) test(`${label} rejects excessive content encodings without a process crash`, () => {
    const result = spawnSync(process.execPath, [__filename, "--child", directory], {
      encoding: "utf8", timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      version: JSON.parse(fs.readFileSync(path.join(directory, "package.json"))).version,
      rejected: true, requests: 1, closed: true,
    });
  });
}
