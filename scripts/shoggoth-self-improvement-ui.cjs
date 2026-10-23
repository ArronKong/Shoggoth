"use strict";
// Real React -> same-origin proxy -> production REST/Backend/Service. The native
// Codex peer is synthetic, and the Electron user profile is private and fresh.
const fs = require("node:fs"), path = require("node:path"), http = require("node:http"), assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { openLearningFixture } = require("./fixtures/self-improvement-service.cjs");
const repo = path.resolve(__dirname, "..");
const output = path.resolve(process.argv[2] || `/private/tmp/shoggoth-learning-ui-${Date.now()}`);
const unifiedCatalog = process.argv.includes("--unified-catalog");
async function run() {
  assert(!fs.existsSync(output), "retain every prior attempt"); fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const f = await openLearningFixture(); const root = path.join(f.root, "renderer"); fs.mkdirSync(root, { mode: 0o700 });
  let server, child, timer;
  try {
    if (unifiedCatalog) {
      const job = await f.review("auto"); assert.equal(job.state, "applied");
      const skill = (await f.ok("skills")).items[0];
      const next = await f.send(f.session.sessionKey, "catalog-read-task", "检查构建产物");
      await f.service.mcpProductToolController.handle("skill_read", { name: skill.name,
        contentHash: skill.head, cursor: 0, maxBytes: 8192 },
      { profileId: f.profile.id, callId: require("node:crypto").randomUUID() }, { runId: next.id, assertCurrent() {} });
      await f.complete(next, "已核对产物并验证。");
    }
    await require(path.join(repo, "app/manage-ui/node_modules/esbuild")).build({ entryPoints: [path.join(repo,
      unifiedCatalog ? "scripts/fixtures/learned-skills-page.tsx" : "scripts/fixtures/self-improvement-ui.tsx")],
      bundle: true, format: "esm", outfile: path.join(root, "fixture.js"), target: "es2022", jsx: "automatic",
      loader: { ".svg": "dataurl", ".woff2": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
      nodePaths: [path.join(repo, "app/manage-ui/node_modules")], logLevel: "silent" });
    fs.writeFileSync(path.join(root, "index.html"), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script type="module" src="fixture.js"></script>');
    let origin;
    server = http.createServer(async (req, res) => {
      try {
        assert.equal(req.headers.host, new URL(origin).host);
        if (req.method !== "GET") assert.equal(req.headers.origin, origin);
        const url = new URL(req.url, origin);
        if (url.pathname.startsWith("/__api/") && (req.method === "GET" || url.pathname === "/__api/skills/learning")) {
          let body = ""; for await (const chunk of req) { body += chunk; assert(body.length < 40000); }
          const response = await fetch(f.server.url + url.pathname + url.search, { method: req.method,
            headers: { "Content-Type": "application/json", Origin: f.server.url }, ...(body ? { body } : {}) });
          res.writeHead(response.status, { "Content-Type": "application/json" }); res.end(await response.text()); return;
        }
        if (url.pathname === "/__fixture/advance" && req.method === "POST") {
          f.advance(31_000); await f.service.learningService.tick(); await f.service.learningService.active?.promise;
          res.writeHead(200); res.end("ok"); return;
        }
        if (url.pathname === "/__fixture/forget" && req.method === "POST") {
          await f.service.memoryEngine.forgetSession(f.profile.id, f.session.id);
          res.writeHead(200); res.end("ok"); return;
        }
        const name = ({ "/": "index.html", "/fixture.js": "fixture.js", "/fixture.css": "fixture.css" })[url.pathname];
        if (!name || req.method !== "GET") { res.writeHead(404); res.end(); return; }
        res.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html");
        res.end(fs.readFileSync(path.join(root, name)));
      } catch (error) { res.writeHead(500); res.end(String(error)); }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); origin = `http://127.0.0.1:${server.address().port}`;
    const main = path.join(root, "main.cjs");
    fs.writeFileSync(main, `const {app,BrowserWindow,session}=require('electron');
const fs=require('node:fs'),path=require('node:path'); app.setPath('userData',${JSON.stringify(path.join(root, "profile"))});
app.whenReady().then(async()=>{session.defaultSession.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!d.url.startsWith(${JSON.stringify(origin + "/")})&&!d.url.startsWith('data:')}));
const w=new BrowserWindow({show:false,width:1180,height:1000,webPreferences:{backgroundThrottling:false}}), rows=[];
try{await w.loadURL(${JSON.stringify(origin + "?agent=" + encodeURIComponent(f.profile.agentId) + (process.argv.includes("--late-read") ? "&lateRead=1" : ""))});
for(const stage of ${JSON.stringify(unifiedCatalog ? ["catalog", "archive", "narrow", "withdrawn"] : ["settings", "proposal", "published", "edited", "narrow", "withdrawn"])}){if(stage==='narrow')w.setSize(410,950);
rows.push({stage,...await w.webContents.executeJavaScript(${JSON.stringify(unifiedCatalog ? "window.learnedSkillsAcceptance(" : "window.learningAcceptance(")}+JSON.stringify(stage)+')',true)});
await w.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
fs.writeFileSync(path.join(${JSON.stringify(output)},stage+'.png'),(await w.webContents.capturePage()).toPNG());}
fs.writeFileSync(path.join(${JSON.stringify(output)},'result.json'),JSON.stringify({passed:true,realProvider:false,rows},null,2));
}catch(e){fs.writeFileSync(path.join(${JSON.stringify(output)},'failure.txt'),String(e)+'\\n'+await w.webContents.executeJavaScript('document.body.innerText'));throw e;}
finally{w.destroy();app.quit();}}).catch(e=>{console.error(e);app.exit(1)});`);
    const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root, LANG: "en_US.UTF-8", ELECTRON_DISABLE_SECURITY_WARNINGS: "true" };
    child = spawn(require("electron"), [main], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let log = ""; for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { log += chunk; });
    timer = setTimeout(() => child.kill("SIGTERM"), 60000);
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    fs.writeFileSync(path.join(output, "electron.log"), log); assert.equal(code, 0, `UI failed; inspect ${output}`);
    assert.equal(f.models.length, 1); assert.equal(f.released.length, 1);
    console.log(`PASS actual React/REST/Service UI: ${unifiedCatalog ? "unified learned catalog, counts, title search, status filters, archive/restore, version details, narrow layout and withdrawal" : "consent, own-Agent model, review, publication, edit ownership, version diff, narrow layout, source withdrawal"}; ${output}`);
  } finally {
    clearTimeout(timer); if (child && child.exitCode === null) child.kill("SIGKILL");
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } await f.close();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
