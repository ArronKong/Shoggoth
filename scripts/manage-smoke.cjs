"use strict";

// Headless smoke for the management data path (no Electron, no GUI).
// Starts HermesBackend (which spawns one `hermes dashboard` per profile, same
// as the app), then exercises the exact code /__api/cron/jobs runs:
//   registry.aggregateCronJobs()  and  registry.routeByCronId(id).
//
// Usage: node scripts/manage-smoke.cjs

const http = require("node:http");
const { HermesBackend } = require("../app/core/hermes-backend");
const { OpenClawBackend } = require("../app/core/openclaw-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { startStaticServer } = require("../app/static-server");

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      })
      .on("error", reject);
  });
}

async function main() {
  const hb = new HermesBackend();
  console.log("[smoke] starting HermesBackend (spawns/reuses dashboards)…");
  const ok = await hb.start();
  console.log(`[smoke] start=${ok} dashboards=[${[...hb.dashboards.keys()].join(", ")}]`);

  const registry = new BackendRegistry();
  registry.register(new OpenClawBackend());
  registry.register(hb);

  const jobs = await registry.aggregateCronJobs();
  const byBackend = jobs.reduce((acc, j) => {
    acc[j.backendId] = (acc[j.backendId] || 0) + 1;
    return acc;
  }, {});
  console.log(`[smoke] aggregateCronJobs -> ${jobs.length} job(s) by backend=${JSON.stringify(byBackend)}`);
  for (const j of jobs) {
    console.log(
      `  - ${j.id} | ${j.backendId} | "${j.name}" | sched=${JSON.stringify(j.schedule)}` +
        ` | enabled=${j.enabled} | last=${j.lastStatus ?? "-"} | next=${j.nextRunAt ?? "-"}`,
    );
  }

  if (jobs[0]) {
    const b = registry.routeByCronId(jobs[0].id);
    console.log(`[smoke] routeByCronId("${jobs[0].id}") -> ${b ? b.id : "null"}`);
  }

  // Prove the REST plane over HTTP (the new static-server routing). We only hit
  // /__api here, which never touches the static file root.
  const server = await startStaticServer(0, { registry });
  console.log(`[smoke] static server at ${server.url}`);
  const apiRes = await httpGetJson(`${server.url}/__api/cron/jobs`);
  console.log(`[smoke] GET /__api/cron/jobs -> HTTP ${apiRes.status}`);
  const apiJobs = JSON.parse(apiRes.body).jobs || [];
  console.log(`[smoke]   ${apiJobs.length} job(s) over HTTP; first id=${apiJobs[0]?.id ?? "-"}`);

  // Prove the built React control-plane SPA is served at the root (R1: the
  // React app is the primary UI at "/", assets under "/assets/").
  const manageRes = await httpGetJson(`${server.url}/`);
  const builtOk =
    manageRes.status === 200 &&
    manageRes.body.includes("/assets/") &&
    !manageRes.body.includes("尚未构建");
  console.log(`[smoke] GET / -> HTTP ${manageRes.status} built=${builtOk}`);
  const assetMatch = /\/assets\/[^"']+\.js/.exec(manageRes.body);
  if (assetMatch) {
    const assetRes = await httpGetJson(`${server.url}${assetMatch[0]}`);
    console.log(
      `[smoke] GET ${assetMatch[0]} -> HTTP ${assetRes.status} (${assetRes.body.length} bytes)`,
    );
  } else {
    console.log("[smoke] WARN: no JS asset reference found in root HTML");
  }
  await server.close();

  hb.stop();
  setTimeout(() => process.exit(0), 300);
}

main().catch((err) => {
  console.error("[smoke] FAILED:", err);
  process.exit(1);
});
