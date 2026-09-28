#!/usr/bin/env node
"use strict";

// Exercise distinct frozen Skill packages through an isolated production
// Service and the production OpenClaw adapter. All generated work stays in tmp.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createAgentService } = require("../app/agent-service/server");
const { readClientToken, requestService } = require("../app/agent-service/client");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const { ensureCredential } = require("../app/agent-service/external-plugin-adapter-auth");
const { BundledPluginCatalog, bundledRoot } = require("../app/core/bundled-plugin-catalog");

const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const body = text => text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "");

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 30_000);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${command} timed out`));
      else resolve({ code, stdout, stderr });
    });
  });
}

function pythonBinary() {
  const candidate = fs.realpathSync(execFileSync("/usr/bin/which", ["python3"],
    { encoding: "utf8", timeout: 5_000 }).trim());
  const version = execFileSync(candidate, ["--version"], { encoding: "utf8", timeout: 5_000 });
  const match = /^Python (\d+)\.(\d+)/u.exec(version);
  assert(match && (Number(match[1]) > 3 || Number(match[1]) === 3 && Number(match[2]) >= 10),
    "idea-generation helper requires Python 3.10+");
  return candidate;
}

async function main() {
  const writeEvidence = process.argv.slice(2).includes("--write-evidence");
  assert(process.argv.slice(2).every(arg => arg === "--write-evidence"),
    "usage: node scripts/plugin-frozen-skill-breadth-fixture.cjs [--write-evidence]");
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-skill-breadth-"));
  const paths = resolveServicePaths({ homeDir: root,
    userDataRoot: path.join(root, "service"), stateRoot: path.join(root, "service", "shoggoth-core"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const catalog = new BundledPluginCatalog(bundledRoot());
  let service;
  let zoteroServer;
  try {
    const credentialToken = ensureCredential(paths, "openclaw");
    service = createAgentService({ paths, prewarmMcpAuth: false, parentEnv: {},
      externalPluginAgentVerifier: async identity => ({ id: identity.agentId,
        backendId: identity.backendId }), version: "frozen-skill-breadth-fixture" });
    await service.start();
    const rpc = (method, params) => requestService(paths, {
      token: readClientToken(paths), version: SERVICE_PROTOCOL_VERSION, method, params,
    }, { timeoutMs: 15_000 });
    const externalRpc = (method, params, options = {}) => requestService(paths, {
      version: SERVICE_PROTOCOL_VERSION, method, params,
    }, { timeoutMs: options.timeoutMs || 10_000, signal: options.signal });
    const { createAdapter } = await import(pathToFileURL(path.join(__dirname,
      "../resources/external-plugin-adapters/openclaw/index.mjs")).href);
    const adapter = createAdapter({ instanceId: "frozen-skill-breadth-fixture",
      credential: () => credentialToken,
      requestService: (method, params, options) => externalRpc(method, params, options) });
    let callNumber = 0;
    const invoke = async (name, args) => {
      const toolCallId = `frozen-skill-breadth-${++callNumber}`;
      const context = { agentId: "frozen-breadth-agent", sessionId: "frozen-breadth-session",
        runId: "frozen-breadth-run" };
      assert.equal(adapter.beforeToolCall({ toolName: name, toolCallId,
        runId: context.runId }, context), undefined);
      return (await adapter.tool(name, context).execute(toolCallId, args)).details;
    };
    const findSkill = async name => (await invoke("shoggoth_capability_search",
      { query: name })).items.filter(item => item.name === name && item.source === "plugin");
    const readChunks = async (tool, args) => {
      let cursor = 0;
      let text = "";
      let digest = null;
      let pages = 0;
      do {
        const page = await invoke(tool, { ...args, cursor });
        const pageDigest = page.fileHash || page.contentHash;
        if (digest !== null) assert.equal(pageDigest, digest, "page digest drift");
        digest = pageDigest;
        text += page.content;
        pages += 1;
        assert(pages <= 64, "Skill read exceeded bounded page count");
        cursor = page.nextCursor;
      } while (cursor !== null);
      assert.equal(sha256(text), digest, "adapter content hash mismatch");
      return { text, digest, pages };
    };
    const profile = service.productStore.listAgentProfiles().find(item => item.enabled);
    assert(profile, "isolated Service must have a native Profile");
    const readFile = async (skillId, packageId, skillName, relativePath) => {
      const sourcePath = path.join(bundledRoot(), "packages", packageId,
        "skills", skillName, relativePath);
      const source = fs.readFileSync(sourcePath, "utf8");
      const read = await readChunks("shoggoth_skill_file_read", { skillId, relativePath });
      assert.equal(read.text, source, `installed file changed: ${relativePath}`);
      return { ...read, sourcePath, sourceSha256: sha256(source) };
    };
    const installSkill = async (packageId, skillName) => {
      const frozen = catalog.assertCurrent(packageId);
      assert.equal(frozen.importStatus, "previewable");
      assert.equal((await findSkill(skillName)).length, 0, "Skill visible before installation");
      const source = { kind: "bundled", packageId };
      const preview = await rpc("plugins.install.preview", { source });
      assert(preview.installable);
      const previewSkill = preview.components.skills.find(item => item.name === skillName);
      assert(previewSkill, `missing converted Skill ${skillName}`);
      const installed = (await rpc("plugins.install", { source,
        previewDigest: preview.previewDigest, expectedRevision: preview.expectedRevision,
        operationId: `frozen-breadth-install-${packageId}` })).installation;
      assert.equal(installed.desiredState, "enabled");
      const found = await findSkill(skillName);
      assert.equal(found.length, 1, `adapter did not find ${skillName}`);
      const skillId = found[0].id;
      const nativeSkill = service.runtimeSkillStore.catalog(profile.id).items.find(item => item.id === skillId);
      assert(nativeSkill, `native Runtime catalog did not find ${skillName}`);
      const skill = await readChunks("shoggoth_skill_read", { skillId });
      assert.equal(skill.digest, previewSkill.descriptorDigest);
      assert.equal(service.runtimeSkillStore.read({ profileId: profile.id,
        name: nativeSkill.name, contentHash: nativeSkill.contentHash }).content, skill.text);
      const sourceSkillPath = path.join(bundledRoot(), "packages", packageId,
        "skills", skillName, "SKILL.md");
      const sourceSkillText = fs.readFileSync(sourceSkillPath, "utf8");
      assert.equal(body(skill.text), body(sourceSkillText), "Skill instruction body changed");
      return { frozen, installed, skillId, skill, sourceSkillPath,
        sourceSkillSha256: sha256(sourceSkillText) };
    };
    const disableSkill = async (state, skillName) => {
      await rpc("plugins.installations.set", { installationId: state.installed.installationId,
        desiredState: "disabled", expectedRevision: state.installed.revision,
        operationId: `frozen-breadth-disable-${state.frozen.id}` });
      assert.equal((await findSkill(skillName)).filter(item => item.id === state.skillId).length, 0);
      assert(!service.runtimeSkillStore.catalog(profile.id).items.some(item => item.id === state.skillId));
    };
    const retrieveProgram = async (state, packageId, skillName, relativePath, name) => {
      const retrieved = await readFile(state.skillId, packageId, skillName, relativePath);
      const target = path.join(root, name);
      fs.writeFileSync(target, retrieved.text, { mode: 0o700 });
      return { ...retrieved, target };
    };

    // A synthetic issuer screen tests the actual frozen scoring materializer:
    // deterministic rank, bucket, source-freshness warning and three outputs.
    const ideas = await installSkill("public-equity-investing", "idea-generation");
    assert.match(ideas.skill.text, /research-priority status/u);
    const scoreScript = await readFile(ideas.skillId, "public-equity-investing",
      "idea-generation", "scripts/score_ideas.py");
    const py = pythonBinary();
    const childTmp = path.join(root, "child-tmp");
    fs.mkdirSync(childTmp, { mode: 0o700 });
    const childEnv = { HOME: root, TMPDIR: childTmp, LANG: "C", LC_ALL: "C",
      PATH: `${path.dirname(py)}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: "" };
    const scorePath = path.join(root, "retrieved-score_ideas.py");
    fs.writeFileSync(scorePath, scoreScript.text, { mode: 0o700 });
    const csvPath = path.join(root, "synthetic-ideas.csv");
    fs.writeFileSync(csvPath, [
      "ticker,company,idea_type,direction,sector,variant_perception_score,catalyst_score,valuation_score,risk_reward_score,variant_view,catalyst,first_rejection_risk,next_step,source,source_as_of",
      "ALFA,Example Alpha,earnings,long,software,5,5,5,5,Test strong case,Quarterly update,Accounting mismatch,Check filings,Synthetic packet,2026-09-01",
      "BETA,Example Beta,watchlist,long,software,3.5,3.5,3.5,3.5,Test middle case,Product launch,Adoption unclear,Track usage,Synthetic packet,2026-08-15",
      "GAMMA,Example Gamma,screen flag,long,hardware,1,1,bad,1,Test weak case,None,Customer concentration,Reject pending proof,Synthetic packet,2025-01-01",
    ].join("\n") + "\n");
    const scoreOutput = path.join(root, "scorecard");
    const scoreRun = await run(py, [scorePath, csvPath, "--output-dir", scoreOutput,
      "--run-date", "2026-09-27"], { cwd: root, env: childEnv });
    assert.equal(scoreRun.code, 0, `idea scorecard failed: ${scoreRun.stdout} ${scoreRun.stderr}`);
    const ranked = JSON.parse(fs.readFileSync(path.join(scoreOutput, "idea_scorecard.json"), "utf8")).rows;
    assert.deepEqual(ranked.map(row => [row.rank, row.ticker, row.composite_score,
      row.bucket, row.freshness_status]), [
      [1, "ALFA", 100, "A - immediate research candidate", "current"],
      [2, "BETA", 70, "B - watchlist / needs trigger", "current"],
      [3, "GAMMA", 20, "Reject / low-priority false positive", "stale"],
    ]);
    assert.match(ranked[2].warnings, /valuation_score invalid numeric value/u);
    assert.match(ranked[2].warnings, /source_as_of is stale/u);
    const rankedCsv = fs.readFileSync(path.join(scoreOutput, "ranked_ideas.csv"), "utf8");
    assert.match(rankedCsv, /\n1,ALFA,/u);
    assert.match(rankedCsv, /\n2,BETA,/u);
    assert.match(rankedCsv, /\n3,GAMMA,/u);
    const scoreNote = fs.readFileSync(path.join(scoreOutput, "idea_scorecard_support_note.md"), "utf8");
    assert.match(scoreNote, /Scores rank research candidates, not final recommendations/u);
    assert.match(scoreNote, /\| 1 \| ALFA \|/u);
    assert.match(scoreNote, /\| 3 \| GAMMA \|/u);
    await disableSkill(ideas, "idea-generation");

    // A bundled geography sample becomes a real, measured Remotion camera path.
    const maps = await installSkill("remotion", "remotion-maps");
    assert.match(maps.skill.text, /CesiumJS/u);
    const pathScript = await readFile(maps.skillId, "remotion", "remotion-maps",
      "techniques/cesium/scripts/prep-cesium-path.mjs");
    const sample = await readFile(maps.skillId, "remotion", "remotion-maps",
      "techniques/cesium/assets/sample-river.geojson");
    const geo = JSON.parse(sample.text);
    assert.equal(geo.features[0].geometry.type, "LineString");
    const pathScriptPath = path.join(root, "retrieved-prep-cesium-path.mjs");
    const samplePath = path.join(root, "sample-river.geojson");
    const outputPath = path.join(root, "cesium-path.json");
    fs.writeFileSync(pathScriptPath, pathScript.text, { mode: 0o700 });
    fs.writeFileSync(samplePath, sample.text);
    const pathRun = await run(process.execPath, [pathScriptPath, samplePath, outputPath],
      { cwd: root, env: childEnv });
    assert.equal(pathRun.code, 0, `Remotion path preparation failed: ${pathRun.stdout} ${pathRun.stderr}`);
    const route = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(route.length, 297, "unexpected sampled camera path length");
    assert(route.every(point => Array.isArray(point) && point.length === 2
      && point.every(Number.isFinite)), "camera path contains invalid coordinates");
    const havKm = (a, b) => {
      const r = Math.PI / 180;
      const h = Math.sin((b[1] - a[1]) * r / 2) ** 2
        + Math.cos(a[1] * r) * Math.cos(b[1] * r)
        * Math.sin((b[0] - a[0]) * r / 2) ** 2;
      return 12742 * Math.asin(Math.sqrt(h));
    };
    const steps = route.slice(1).map((point, index) => havKm(route[index], point));
    const routeKm = steps.reduce((sum, step) => sum + step, 0);
    assert(routeKm > 16 && routeKm < 19, `unexpected route length ${routeKm}`);
    assert(Math.max(...steps) < 0.12, "camera route has an abrupt spatial jump");
    assert.match(pathRun.stdout, /clip 106 → resample 297 → smooth → 297 pts · 17\.1 km/u);
    await disableSkill(maps, "remotion-maps");

    // The frozen Zotero helper is projected to OpenClaw from the installed
    // Skill, then queries an isolated local-API stand-in. No user library or
    // Zotero profile is read, and no remote provider is involved.
    const zotero = await installSkill("zotero", "zotero");
    const zoteroHelper = await readFile(zotero.skillId, "zotero", "zotero",
      "scripts/zotero.py");
    assert.match(zotero.skill.text, /search a local Zotero library/u);
    const zoteroRequests = [];
    zoteroServer = http.createServer((request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      zoteroRequests.push({ method: request.method, path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        apiVersion: request.headers["zotero-api-version"] });
      const send = (status, type, body) => {
        response.writeHead(status, { "Content-Type": type });
        response.end(body);
      };
      if (request.method !== "GET" || request.headers["zotero-api-version"] !== "3") {
        return send(400, "text/plain", "invalid local API request");
      }
      if (url.pathname === "/api/users/0/items/top"
        && url.searchParams.get("q") === "transformer") {
        return send(200, "application/json", JSON.stringify([{ key: "PXW99EKT",
          data: { itemType: "journalArticle", title: "Synthetic Transformer Study",
            date: "2024-06-01", creators: [{ firstName: "Ada", lastName: "Chen" }] } }]));
      }
      if (url.pathname === "/api/users/0/items"
        && url.searchParams.get("itemKey") === "PXW99EKT"
        && url.searchParams.get("format") === "bibtex") {
        return send(200, "text/plain", "@article{chen_transformer_2024, title={Synthetic Transformer Study}}\n");
      }
      return send(404, "text/plain", "not in isolated library");
    });
    await new Promise((resolve, reject) => {
      zoteroServer.once("error", reject);
      zoteroServer.listen(0, "127.0.0.1", resolve);
    });
    const zoteroHelperPath = path.join(root, "retrieved-zotero.py");
    fs.writeFileSync(zoteroHelperPath, zoteroHelper.text, { mode: 0o700 });
    const zoteroRun = await run(py, [zoteroHelperPath, "search", "transformer",
      "--with-bibtex-keys", "--json"], { cwd: root,
      env: { ...childEnv, ZOTERO_LOCAL_BASE_URL:
        `http://127.0.0.1:${zoteroServer.address().port}` } });
    assert.equal(zoteroRun.code, 0, `Zotero local search failed: ${zoteroRun.stdout} ${zoteroRun.stderr}`);
    assert.deepEqual(JSON.parse(zoteroRun.stdout), [{ key: "PXW99EKT",
      itemType: "journalArticle", title: "Synthetic Transformer Study",
      creators: ["Ada Chen"], year: "2024", bibtexKey: "chen_transformer_2024" }]);
    assert.deepEqual(zoteroRequests, [
      { method: "GET", path: "/api/users/0/items/top", query: { q: "transformer" }, apiVersion: "3" },
      { method: "GET", path: "/api/users/0/items", query: {
        itemKey: "PXW99EKT", format: "bibtex", limit: "100" }, apiVersion: "3" },
    ]);
    await disableSkill(zotero, "zotero");

    // Preserve the Docs Skill's canonical rich-link target and a separate
    // location-specific deep link. Reject look-alike hosts and missing IDs.
    const docs = await installSkill("google-drive", "google-docs");
    assert.match(docs.skill.text, /canonicalize_google_workspace_url\.mjs/u);
    const docsProgram = await retrieveProgram(docs, "google-drive", "google-docs",
      "scripts/canonicalize_google_workspace_url.mjs", "retrieved-canonicalize-google-url.mjs");
    const docsUrls = [
      "https://docs.google.com/document/u/2/d/Doc_123-abc/edit?usp=sharing",
      "https://docs.google.com/spreadsheets/d/Sheet_456/edit#gid=12",
      "https://www.google.com/url?q=https%3A%2F%2Fdocs.google.com%2Fpresentation%2Fd%2FDeck_789%2Fedit%3Fusp%3Dsharing",
    ];
    const docsRun = await run(process.execPath, [docsProgram.target, ...docsUrls],
      { cwd: root, env: childEnv });
    assert.equal(docsRun.code, 0, `Docs URL normalization failed: ${docsRun.stderr}`);
    const normalized = JSON.parse(docsRun.stdout);
    assert.deepEqual(normalized.map(item => [item.resourceType, item.fileId,
      item.canonicalUri, item.deepLinkUri]), [
      ["document", "Doc_123-abc", "https://docs.google.com/document/d/Doc_123-abc/edit", null],
      ["spreadsheet", "Sheet_456", "https://docs.google.com/spreadsheets/d/Sheet_456/edit",
        docsUrls[1]],
      ["presentation", "Deck_789", "https://docs.google.com/presentation/d/Deck_789/edit",
        null],
    ]);
    assert.equal(normalized[2].originalUri, docsUrls[2]);
    assert.equal(normalized[2].unwrappedUri,
      "https://docs.google.com/presentation/d/Deck_789/edit?usp=sharing");
    const docsReject = await run(process.execPath, [docsProgram.target,
      "https://docs.google.com.evil.invalid/document/d/Doc_123/edit"],
    { cwd: root, env: childEnv });
    assert.equal(docsReject.code, 1, "look-alike Google host was accepted");
    assert.match(docsReject.stderr, /not a supported Google Docs, Sheets, or Slides URL/u);
    const docsNoId = await run(process.execPath, [docsProgram.target,
      "https://docs.google.com/document/d/"],
    { cwd: root, env: childEnv });
    assert.equal(docsNoId.code, 1, "Docs URL without file ID was accepted");
    assert.match(docsNoId.stderr, /does not contain a supported Google Workspace file ID/u);
    await disableSkill(docs, "google-docs");

    // The Android QA helper converts a real hierarchy XML input into a small,
    // actionable target list with cleaned labels and exact UI bounds.
    const android = await installSkill("test-android-apps", "android-emulator-qa");
    assert.match(android.skill.text, /ui_tree_summarize\.py/u);
    const androidProgram = await retrieveProgram(android, "test-android-apps", "android-emulator-qa",
      "scripts/ui_tree_summarize.py", "retrieved-ui-tree-summarize.py");
    const uiXml = path.join(root, "synthetic-android-ui.xml");
    const uiSummary = path.join(root, "synthetic-android-summary.txt");
    fs.writeFileSync(uiXml, [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<hierarchy rotation="0">',
      '  <node class="android.widget.FrameLayout">',
      '    <node class="android.widget.TextView" text="  Sign in  " bounds="[10,20][210,65]"/>',
      '    <node class="android.widget.Button" resource-id="com.example.app:id/continue"',
      '      content-desc="Continue" clickable="true" focusable="true" bounds="[10,70][210,120]"/>',
      '    <node class="android.widget.Switch" text="Remember me" checked="true"',
      '      clickable="true" bounds="[10,125][210,170]"/>',
      '  </node>',
      '</hierarchy>',
      'UIAUTOMATOR_TRAILING_LOG_NOISE',
    ].join("\n"));
    const uiRun = await run(py, [androidProgram.target, uiXml, uiSummary],
      { cwd: root, env: childEnv });
    assert.equal(uiRun.code, 0, `Android UI summary failed: ${uiRun.stderr}`);
    const expectedUiSummary = [
      'TextView text="Sign in" bounds=[10,20][210,65]',
      'Button id=id/continue desc="Continue" flags=clickable,focusable bounds=[10,70][210,120]',
      'Switch text="Remember me" flags=clickable,checked bounds=[10,125][210,170]',
      '',
    ].join("\n");
    assert.equal(fs.readFileSync(uiSummary, "utf8"), expectedUiSummary);
    fs.writeFileSync(uiXml, '<hierarchy><node text="Broken"/>');
    const uiReject = await run(py, [androidProgram.target, uiXml, uiSummary],
      { cwd: root, env: childEnv });
    assert.equal(uiReject.code, 1, "truncated Android hierarchy was accepted");
    assert.match(uiReject.stderr, /hierarchy end tag not found/u);
    assert.equal(fs.readFileSync(uiSummary, "utf8"), expectedUiSummary,
      "rejected XML must not overwrite the last valid UI summary");
    await disableSkill(android, "android-emulator-qa");

    // Run both frozen Ads verifiers on a synthetic browser/server integration,
    // then inject a browser-visible secret reference and unsupported event.
    const ads = await installSkill("openai-ads-conversions", "openai-ads-conversions-setup");
    assert.match(ads.skill.text, /verify_capi_secret_not_exposed\.py/u);
    const adsSetupProgram = await retrieveProgram(ads, "openai-ads-conversions",
      "openai-ads-conversions-setup", "scripts/verify_ads_setup.py",
      "retrieved-verify-ads-setup.py");
    const adsSecretProgram = await retrieveProgram(ads, "openai-ads-conversions",
      "openai-ads-conversions-setup", "scripts/verify_capi_secret_not_exposed.py",
      "retrieved-verify-ads-secret.py");
    const adsRepo = path.join(root, "synthetic-ads-repo");
    fs.mkdirSync(path.join(adsRepo, "src", "client"), { recursive: true });
    fs.mkdirSync(path.join(adsRepo, "src", "server"), { recursive: true });
    fs.writeFileSync(path.join(adsRepo, "src", "client", "pixel.ts"), [
      "const pixelId = process.env.NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID;",
      'oaiq("init", { pixelId });',
      'oaiq("measure", "order_created", { event_id: orderId });',
    ].join("\n"));
    fs.writeFileSync(path.join(adsRepo, "src", "server", "conversions.ts"), [
      "const apiKey = process.env.OPENAI_ADS_CONVERSIONS_API_KEY;",
      "const pixelId = process.env.OPENAI_ADS_PIXEL_ID;",
      "const oppref = request.cookies.__oppref;",
      "const source_url = request.url;",
      "const event_id = orderId;",
    ].join("\n"));
    fs.writeFileSync(path.join(adsRepo, "README.md"),
      "Browser and server reuse the same logical Pixel ID for deduplicated events.\n");
    const setupArgs = [adsSetupProgram.target, adsRepo, "--require", "pixel",
      "--require", "capi", "--require", "dedupe", "--require", "shared-pixel-id",
      "--require", "supported-events", "--require", "oppref", "--require", "source-url"];
    const adsSetupRun = await run(py, setupArgs, { cwd: root, env: childEnv });
    assert.equal(adsSetupRun.code, 0, `Ads setup verification failed: ${adsSetupRun.stderr}`);
    const adsSetupResult = JSON.parse(adsSetupRun.stdout);
    assert.equal(adsSetupResult.passed, true);
    assert.deepEqual(adsSetupResult.failed_required, []);
    assert.deepEqual(adsSetupResult.failed_security, []);
    assert.deepEqual(adsSetupResult.failed_correctness, []);
    const adsSecretRun = await run(py, [adsSecretProgram.target, adsRepo],
      { cwd: root, env: childEnv });
    assert.equal(adsSecretRun.code, 0, `Ads secret verification failed: ${adsSecretRun.stderr}`);
    assert.deepEqual(JSON.parse(adsSecretRun.stdout).summary,
      { total: 0, high: 0, medium: 0 });
    fs.writeFileSync(path.join(adsRepo, "src", "client", "leak.ts"), [
      "const leakedSecret = process.env.VITE_OPENAI_ADS_CONVERSIONS_API_KEY;",
      "const otherLeak = process.env.OPENAI_ADS_CONVERSIONS_API_KEY;",
      'oaiq("measure", "invented_purchase", { event_id: orderId });',
    ].join("\n"));
    const adsBadSetup = await run(py, setupArgs, { cwd: root, env: childEnv });
    assert.equal(adsBadSetup.code, 2, "unsafe Ads setup was accepted");
    const adsBadSetupResult = JSON.parse(adsBadSetup.stdout);
    assert.deepEqual(adsBadSetupResult.failed_security, ["no_public_capi_env"]);
    assert.deepEqual(adsBadSetupResult.failed_correctness, ["supported_event_names"]);
    const adsBadSecret = await run(py, [adsSecretProgram.target, adsRepo],
      { cwd: root, env: childEnv });
    assert.equal(adsBadSecret.code, 2, "browser-visible Ads secret reference was accepted");
    const badSecretFindings = JSON.parse(adsBadSecret.stdout).findings;
    assert(badSecretFindings.some(item => item.rule === "public_env_secret_name"
      && item.path === "src/client/leak.ts" && item.severity === "high"));
    assert(badSecretFindings.some(item => item.rule === "capi_secret_name_in_client_file"
      && item.path === "src/client/leak.ts" && item.severity === "high"));
    await disableSkill(ads, "openai-ads-conversions-setup");

    const cases = [
      { packageId: "public-equity-investing", skill: "idea-generation",
        sourceDigest: ideas.frozen.sourceDigest, installedReleaseDigest: ideas.installed.releaseDigest,
        sourceSkillSha256: ideas.sourceSkillSha256, installedSkillSha256: ideas.skill.digest,
        scriptSha256: scoreScript.sourceSha256, skillPages: ideas.skill.pages,
        scriptPages: scoreScript.pages, ranking: ranked.map(row => ({
          ticker: row.ticker, score: row.composite_score, bucket: row.bucket,
          freshness: row.freshness_status })), outputs: 3 },
      { packageId: "remotion", skill: "remotion-maps",
        sourceDigest: maps.frozen.sourceDigest, installedReleaseDigest: maps.installed.releaseDigest,
        sourceSkillSha256: maps.sourceSkillSha256, installedSkillSha256: maps.skill.digest,
        scriptSha256: pathScript.sourceSha256, sampleSha256: sample.sourceSha256,
        skillPages: maps.skill.pages, scriptPages: pathScript.pages, samplePages: sample.pages,
        pathPoints: route.length, routeKm: Number(routeKm.toFixed(2)),
        maxStepKm: Number(Math.max(...steps).toFixed(3)) },
      { packageId: "zotero", skill: "zotero",
        sourceDigest: zotero.frozen.sourceDigest,
        installedReleaseDigest: zotero.installed.releaseDigest,
        sourceSkillSha256: zotero.sourceSkillSha256,
        installedSkillSha256: zotero.skill.digest,
        scriptSha256: zoteroHelper.sourceSha256,
        skillPages: zotero.skill.pages, scriptPages: zoteroHelper.pages,
        localApiRequests: zoteroRequests.length,
        resultKey: "PXW99EKT", bibtexKey: "chen_transformer_2024" },
      { packageId: "google-drive", skill: "google-docs",
        sourceDigest: docs.frozen.sourceDigest,
        installedReleaseDigest: docs.installed.releaseDigest,
        sourceSkillSha256: docs.sourceSkillSha256,
        installedSkillSha256: docs.skill.digest,
        scriptSha256: docsProgram.sourceSha256,
        skillPages: docs.skill.pages, scriptPages: docsProgram.pages,
        normalizedResourceTypes: normalized.map(item => item.resourceType),
        rejectedLookalikeHost: true, rejectedMissingId: true },
      { packageId: "test-android-apps", skill: "android-emulator-qa",
        sourceDigest: android.frozen.sourceDigest,
        installedReleaseDigest: android.installed.releaseDigest,
        sourceSkillSha256: android.sourceSkillSha256,
        installedSkillSha256: android.skill.digest,
        scriptSha256: androidProgram.sourceSha256,
        skillPages: android.skill.pages, scriptPages: androidProgram.pages,
        summarySha256: sha256(expectedUiSummary), summaryRows: 3,
        rejectedTruncatedXml: true },
      { packageId: "openai-ads-conversions", skill: "openai-ads-conversions-setup",
        sourceDigest: ads.frozen.sourceDigest,
        installedReleaseDigest: ads.installed.releaseDigest,
        sourceSkillSha256: ads.sourceSkillSha256,
        installedSkillSha256: ads.skill.digest,
        setupScriptSha256: adsSetupProgram.sourceSha256,
        secretScriptSha256: adsSecretProgram.sourceSha256,
        skillPages: ads.skill.pages, setupScriptPages: adsSetupProgram.pages,
        secretScriptPages: adsSecretProgram.pages,
        passedRequiredChecks: adsSetupResult.required,
        rejectedSecurityChecks: adsBadSetupResult.failed_security,
        rejectedCorrectnessChecks: adsBadSetupResult.failed_correctness,
        rejectedSecretRules: [...new Set(badSecretFindings.map(item => item.rule))].sort() },
    ];
    const inventory = JSON.parse(fs.readFileSync(path.join(__dirname,
      "../docs/architecture/bundled-skill-dependency-inventory-2026-09-27.json"), "utf8"));
    assert.equal(inventory.source.batchDigest, catalog.batchDigest,
      "frozen Skill inventory and runtime catalog disagree");
    assert.equal(inventory.skills.length, 502, "top-level Skill scope changed");
    const inventoryIds = new Set(inventory.skills.map(item => item.id));
    const acceptedIds = cases.map(item => `${item.packageId}/${item.skill}`);
    assert.equal(new Set(acceptedIds).size, cases.length, "duplicate business acceptance case");
    assert(acceptedIds.every(id => inventoryIds.has(id)),
      "business acceptance includes a non-top-level or missing Skill");
    const evidence = {
      schemaVersion: 1,
      host: "OpenClaw production adapter over isolated Service IPC",
      batchDigest: catalog.batchDigest,
      corpusTopLevelSkills: inventory.skills.length,
      acceptedTopLevelSkillIds: acceptedIds,
      remainingTopLevelSkills: inventory.skills.length - acceptedIds.length,
      cases,
      nativeFacadeRead: true,
      disabledSkillsInvisible: true,
      externalAccountUsed: false,
      realAgentOrModelUsed: false,
    };
    const evidencePath = path.join(__dirname,
      "../docs/architecture/plugin-frozen-skill-breadth-evidence-2026-09-27.json");
    if (writeEvidence) fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    else assert.deepEqual(JSON.parse(fs.readFileSync(evidencePath, "utf8")), evidence,
      "business acceptance evidence drifted; rerun with --write-evidence only after reviewing changed results");
    console.log("plugin-frozen-skill-breadth-fixture: ok", JSON.stringify(evidence));
  } finally {
    try {
      if (zoteroServer?.listening) await new Promise(resolve => zoteroServer.close(resolve));
      await service?.stop();
    }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
