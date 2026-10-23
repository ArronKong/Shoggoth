#!/usr/bin/env node
// The frontend checkout owns inspector saves even with a packaged API upstream.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createServer } from "../app/manage-ui/node_modules/vite/dist/node/index.js";

const root = path.resolve(import.meta.dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-inspector-source-"));
const src = path.join(temp, "src");
const file = path.join(src, "debug-overrides.css");
fs.mkdirSync(src);
fs.writeFileSync(file, "/* Existing user adjustments */\n.existing {\n  color: red !important;\n}\n");
let upstreamRequests = 0;
const upstream = http.createServer((_req, res) => {
  upstreamRequests++;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ canSave: false, packaged: true }));
});
let vite;
try {
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  vite = await createServer({
    configFile: path.join(root, "app/manage-ui/vite.config.ts"),
    root: temp,
    cacheDir: path.join(temp, ".vite"),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, strictPort: true,
      proxy: { "/__api": `http://127.0.0.1:${upstream.address().port}` } },
  });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const endpoint = origin + "/__api/debug/overrides";
  const put = (overrides, extra = {}) => fetch(endpoint, {
    method: "PUT", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ overrides }), ...extra,
  });
  const capability = await (await fetch(endpoint)).json();
  assert.equal(capability.canSave, true, "Vite must probe its own editable source, not the packaged upstream");
  assert.equal(upstreamRequests, 0, "capability request must stay in the source checkout");
  const first = await put({ ".fixture": { "font-size": "17px !important", color: "rgba(1, 2, 3, 0.9)" } });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).path, file);
  assert.match(fs.readFileSync(file, "utf8"), /color: red !important;/);
  assert.match(fs.readFileSync(file, "utf8"), /font-size: 17px !important;/);
  assert.equal((await put({ ".fixture": { "font-size": "19px !important" } })).status, 200);
  const saved = fs.readFileSync(file, "utf8");
  assert.match(saved, /font-size: 19px !important;/);
  assert.match(saved, /color: rgba\(1, 2, 3, 0.9\);/);
  assert.equal(upstreamRequests, 0, "writes must not reach the packaged app");

  for (const badOrigin of ["https://evil.example", "null", "http://127.0.0.1:1"]) {
    assert.equal((await put({ ".bad": { color: "red" } }, {
      headers: { "Content-Type": "application/json", Origin: badOrigin },
    })).status, 403, "foreign origins must not write");
  }
  assert.equal((await put({ ".bad": { color: "red" } }, {
    headers: { "Content-Type": "text/plain", Origin: origin },
  })).status, 415);
  assert.equal((await fetch(endpoint, { method: "DELETE", headers: { Origin: origin } })).status, 405);
  for (const overrides of [[], null, { ".bad": [] }, { ".bad": { color: 12 } },
    { ".bad { body": { color: "red" } }, { ".bad": { color: "red; } body { display:none" } }]) {
    assert.equal((await put(overrides)).status, 400, "invalid CSS input must not mutate the file");
  }
  assert.equal((await put({}, { body: "{" })).status, 400);
  assert.equal((await put({ ".bad": { color: "a".repeat(140000) } })).status, 413);
  assert.equal(fs.readFileSync(file, "utf8"), saved);

  fs.writeFileSync(file, "@media (max-width: 500px) { .existing { color: blue; } }\n");
  assert.equal((await put({ ".fixture": { color: "red" } })).status, 409);
  assert.equal(fs.readFileSync(file, "utf8"), "@media (max-width: 500px) { .existing { color: blue; } }\n");
  fs.unlinkSync(file);
  const outside = path.join(temp, "outside.css");
  fs.writeFileSync(outside, "keep me");
  fs.symlinkSync(outside, file);
  assert.equal((await (await fetch(endpoint)).json()).canSave, false);
  assert.equal((await put({ ".fixture": { color: "red" } })).status, 400);
  assert.equal(fs.readFileSync(outside, "utf8"), "keep me");
  fs.unlinkSync(file);
  fs.rmdirSync(src);
  assert.equal((await (await fetch(endpoint)).json()).canSave, false);

  assert.equal((await (await fetch(origin + "/__api/other")).json()).packaged, true,
    "ordinary API requests still use the existing proxy");
  assert.equal(upstreamRequests, 1);
  console.log("debug inspector source regression: local source ownership, merge, origin, input, file boundaries, proxy PASS");
} finally {
  if (vite) await vite.close();
  await new Promise(resolve => upstream.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}
