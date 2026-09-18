#!/usr/bin/env node
// Regression: never reuse a dashboard that serves a DIFFERENT Hermes profile.
//
// Ports used to be handed out by profile-list index and any dashboard answering
// on the port was reused blind. Add/remove a profile and the indexes shift, so an
// orphaned dashboard could wire agent X to profile Y's sessions/cron/SOUL. The
// reuse path must now prove identity via /api/status.hermes_home.
//
// _spawnDashboard is stubbed — we assert the *decision* (reuse vs spawn, on which
// port), not that a real `hermes dashboard` boots.

import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { HermesBackend } from "../app/core/hermes-backend.js";

const BASE = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
const homeFor = (p) => (p === "default" ? BASE : path.join(BASE, "profiles", p));

// A fake Hermes dashboard: serves the token in HTML + /api/status{hermes_home}.
function fakeDashboard(profile, { omitHome = false } = {}) {
  const server = createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<script>window.__HERMES_SESSION_TOKEN__="tok-${profile}"</script>`);
      return;
    }
    if (req.url.startsWith("/api/status")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(omitHome ? { version: "x" } : { hermes_home: homeFor(profile) }));
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

function backend() {
  const be = new HermesBackend({ getConfig: () => ({ hermesMode: "local", hermesRemotes: [] }) });
  const spawns = [];
  be._spawnDashboard = async (profile, port) => {
    spawns.push({ profile, port });
    return { profile, port, baseUrl: `http://127.0.0.1:${port}`, token: "fresh", proc: null, spawned: true };
  };
  return { be, spawns };
}

const results = [];
const check = (name, cond) => results.push({ name, ok: !!cond });
const freePort = async () => {
  const s = await new Promise((r) => createServer().listen(0, "127.0.0.1", function () { r(this); }));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
};

// 1. Free port → spawn there.
{
  const { be, spawns } = backend();
  const port = await freePort();
  const dash = await be._spawnOrReuseDashboard("default", port);
  check("free port → spawns", dash?.spawned === true && dash.port === port);
  check("free port → spawned exactly once", spawns.length === 1);
}

// 2. Port held by the SAME profile → reuse it, don't spawn.
{
  const { be, spawns } = backend();
  const srv = await fakeDashboard("default");
  const port = srv.address().port;
  const dash = await be._spawnOrReuseDashboard("default", port);
  check("same profile → reuses", dash?.spawned === false && dash.port === port);
  check("same profile → token scraped from it", dash?.token === "tok-default");
  check("same profile → never spawns", spawns.length === 0);
  await new Promise((r) => srv.close(r));
}

// 3. Port held by ANOTHER profile → must NOT reuse (this is the corruption bug).
{
  const { be, spawns } = backend();
  const srv = await fakeDashboard("bull"); // an orphan bull dashboard
  const port = srv.address().port;
  const dash = await be._spawnOrReuseDashboard("default", port);
  check("foreign profile → does NOT reuse", dash?.spawned === true);
  check("foreign profile → skips to a later port", dash?.port > port);
  check("foreign profile → spawns its own", spawns.length === 1 && spawns[0].profile === "default");
  await new Promise((r) => srv.close(r));
}

// 4. Dashboard that can't identify itself (old build) → unverifiable → don't reuse.
{
  const { be } = backend();
  const srv = await fakeDashboard("default", { omitHome: true });
  const port = srv.address().port;
  const dash = await be._spawnOrReuseDashboard("default", port);
  check("no hermes_home → refuses to reuse", dash?.spawned === true && dash.port > port);
  await new Promise((r) => srv.close(r));
}

// 5. `claimed` stops two concurrent profile scans landing on the same port.
{
  const { be, spawns } = backend();
  const port = await freePort();
  const claimed = new Set();
  const [a, b] = await Promise.all([
    be._spawnOrReuseDashboard("default", port, claimed),
    be._spawnOrReuseDashboard("bull", port, claimed),
  ]);
  check("concurrent scans get distinct ports", a.port !== b.port);
  check("concurrent scans both spawn", spawns.length === 2);
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
