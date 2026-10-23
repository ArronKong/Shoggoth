#!/usr/bin/env node
"use strict";

// Bounded, deterministic business exercises for thirteen further frozen top-level
// Skills. Every program is read from an opted-in installation through the
// production OpenClaw adapter before it is run in a disposable task directory.
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

const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const body = value => value.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "");
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));
const caseId = (packageId, skillName) => `${packageId}/${skillName}`;

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
  const match = /^Python (\d+)\.(\d+)/u.exec(execFileSync(candidate,
    ["--version"], { encoding: "utf8", timeout: 5_000 }));
  assert(match && (Number(match[1]) > 3 || Number(match[1]) === 3 && Number(match[2]) >= 10),
    "frozen Python helpers require Python 3.10+");
  return candidate;
}

async function main() {
  const writeEvidence = process.argv.slice(2).includes("--write-evidence");
  assert(process.argv.slice(2).every(arg => arg === "--write-evidence"),
    "usage: node scripts/plugin-frozen-skill-next-cohort-fixture.cjs [--write-evidence]");
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-skill-next-cohort-"));
  const paths = resolveServicePaths({ homeDir: root,
    userDataRoot: path.join(root, "service"), stateRoot: path.join(root, "service", "shoggoth-core"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const catalog = new BundledPluginCatalog(bundledRoot());
  let service;
  try {
    const credentialToken = ensureCredential(paths, "openclaw");
    service = createAgentService({ paths, prewarmMcpAuth: false, parentEnv: {},
      externalPluginAgentVerifier: async identity => ({ id: identity.agentId,
        backendId: identity.backendId }), version: "frozen-skill-next-cohort-fixture" });
    await service.start();
    const rpc = (method, params) => requestService(paths, {
      token: readClientToken(paths), version: SERVICE_PROTOCOL_VERSION, method, params,
    }, { timeoutMs: 15_000 });
    const externalRpc = (method, params, options = {}) => requestService(paths, {
      version: SERVICE_PROTOCOL_VERSION, method, params,
    }, { timeoutMs: options.timeoutMs || 10_000, signal: options.signal });
    const { createAdapter } = await import(pathToFileURL(path.join(__dirname,
      "../resources/external-plugin-adapters/openclaw/index.mjs")).href);
    const adapter = createAdapter({ instanceId: "frozen-skill-next-cohort-fixture",
      credential: () => credentialToken,
      requestService: (method, params, options) => externalRpc(method, params, options) });
    let callNumber = 0;
    const invoke = async (name, args) => {
      const toolCallId = `frozen-skill-next-${++callNumber}`;
      const context = { agentId: "frozen-next-agent", sessionId: "frozen-next-session",
        runId: "frozen-next-run" };
      assert.equal(adapter.beforeToolCall({ toolName: name, toolCallId,
        runId: context.runId }, context), undefined);
      try { return (await adapter.tool(name, context).execute(toolCallId, args)).details; }
      catch (error) { if (process.env.SG_SKILL_TRACE) console.error("next-cohort: tool-error", callNumber, name, args, error.code); throw error; }
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
    const installations = new Map();
    const skills = new Map();
    const getSkill = async (packageId, skillName) => {
      const id = caseId(packageId, skillName);
      if (skills.has(id)) return skills.get(id);
      let installed = installations.get(packageId);
      if (!installed) {
        assert.equal((await findSkill(skillName)).length, 0, `Skill visible before opt-in: ${id}`);
        const frozen = catalog.assertCurrent(packageId);
        assert.equal(frozen.importStatus, "previewable");
        const source = { kind: "bundled", packageId };
        const preview = await rpc("plugins.install.preview", { source });
        assert(preview.installable);
        installed = (await rpc("plugins.install", { source,
          previewDigest: preview.previewDigest, expectedRevision: preview.expectedRevision,
          operationId: `frozen-next-install-${packageId}` })).installation;
        assert.equal(installed.desiredState, "enabled");
        installations.set(packageId, { ...installed, frozen });
      }
      const found = await findSkill(skillName);
      assert.equal(found.length, 1, `adapter did not find installed ${id}`);
      const skillId = found[0].id;
      const nativeSkill = service.runtimeSkillStore.catalog(profile.id).items.find(item => item.id === skillId);
      assert(nativeSkill, `native Runtime catalog did not find eligible ${id}`);
      const skill = await readChunks("shoggoth_skill_read", { skillId });
      assert.equal(service.runtimeSkillStore.read({ profileId: profile.id,
        name: nativeSkill.name, contentHash: nativeSkill.contentHash }).content, skill.text);
      const sourceSkill = fs.readFileSync(path.join(bundledRoot(), "packages", packageId,
        "skills", skillName, "SKILL.md"), "utf8");
      assert.equal(body(skill.text), body(sourceSkill), `installed instruction body drifted: ${id}`);
      const state = { id, packageId, skillName, skillId, installed: installations.get(packageId),
        skillPages: skill.pages, sourceSkillSha256: sha256(sourceSkill),
        installedSkillSha256: skill.digest,
        nativeRequiredTools: nativeSkill.requiredTools,
        nativeRequiredRuntimeCapabilities: nativeSkill.requiredRuntimeCapabilities };
      skills.set(id, state);
      return state;
    };
    const program = async (state, relativePath, basename) => {
      const sourcePath = path.join(bundledRoot(), "packages", state.packageId,
        "skills", state.skillName, relativePath);
      const source = fs.readFileSync(sourcePath, "utf8");
      const read = await readChunks("shoggoth_skill_file_read",
        { skillId: state.skillId, relativePath });
      assert.equal(read.text, source, `installed file changed: ${state.id}/${relativePath}`);
      const target = path.join(root, "retrieved", state.packageId, state.skillName, basename);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, read.text, { mode: 0o700 });
      return { target, sha256: read.digest, pages: read.pages };
    };
    const py = pythonBinary();
    const childTmp = path.join(root, "child-tmp");
    fs.mkdirSync(childTmp, { mode: 0o700 });
    const childEnv = { HOME: root, TMPDIR: childTmp, LANG: "C", LC_ALL: "C",
      PATH: `${path.dirname(py)}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: "" };
    const cases = [];

    // Boltz: select the best design from ten local metrics, and reject an
    // empty results file rather than inventing a binding-confidence readout.
    if (process.env.SG_SKILL_TRACE) console.error("next-cohort: boltz");
    const boltz = await getSkill("boltz-api-cli", "boltz-protein-design");
    const boltzProgram = await program(boltz, "scripts/analyze_results.py", "analyze_results.py");
    const boltzRun = path.join(root, "boltz-run");
    fs.mkdirSync(path.join(boltzRun, "results"), { recursive: true });
    const boltzIndex = path.join(boltzRun, "results", "index.jsonl");
    const confidence = [0.09, 0.08, 0.07, 0.06, 0.05, 0.04, 0.03, 0.02, 0.011, 0.005];
    fs.writeFileSync(boltzIndex, confidence.map(value => JSON.stringify({
      metrics: { binding_confidence: value },
    })).join("\n") + "\n");
    const boltzGood = await run(py, [boltzProgram.target, boltzRun, "--json"],
      { cwd: root, env: childEnv });
    assert.equal(boltzGood.code, 0, boltzGood.stderr);
    const boltzData = JSON.parse(boltzGood.stdout);
    assert.equal(boltzData.n_designs, 10);
    assert.equal(boltzData.max_bc, 0.09);
    assert.equal(boltzData.bc_10th, 0.005);
    assert.equal(boltzData["frac_gt_0.01"], 0.9);
    assert.equal(boltzData["frac_gt_0.05"], 0.4);
    fs.writeFileSync(boltzIndex, '{"metrics":{}}\n');
    const boltzEmpty = await run(py, [boltzProgram.target, boltzRun, "--json"],
      { cwd: root, env: childEnv });
    assert.notEqual(boltzEmpty.code, 0);
    assert.match(boltzEmpty.stderr, /no binding_confidence values/u);
    cases.push({ id: boltz.id, scripts: [boltzProgram],
      result: { bestBindingConfidence: 0.09, tenth: 0.005,
        fractionAbove005: 0.4, rejectedMissingMetrics: true },
      boundary: "Synthetic result-index analytics only; no Boltz API design submitted." });

    // NVIDIA: a local protocol double verifies model discovery, chat payload,
    // and the missing-model refusal. It is not a real GPU or Dynamo frontend.
    if (process.env.SG_SKILL_TRACE) console.error("next-cohort: router");
    const router = await getSkill("nvidia", "dynamo-router-starter");
    const routerProgram = await program(router, "scripts/check_router_health.py", "check_router_health.py");
    let emptyModels = false;
    let chatPayload = null;
    const routerServer = http.createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.method === "GET" && request.url === "/v1/models") {
        response.end(JSON.stringify({ data: emptyModels ? [] : [{ id: "fixture-model" }] }));
      } else if (request.method === "POST" && request.url === "/v1/chat/completions") {
        let input = "";
        request.on("data", chunk => { input += chunk; });
        request.on("end", () => {
          chatPayload = JSON.parse(input);
          response.end(JSON.stringify({ choices: [{ message: { content: "fixture reply" } }] }));
        });
      } else { response.statusCode = 404; response.end(JSON.stringify({ error: "unknown path" })); }
    });
    await new Promise(resolve => routerServer.listen(0, "127.0.0.1", resolve));
    try {
      const routerUrl = `http://127.0.0.1:${routerServer.address().port}`;
      const routerArgs = [routerProgram.target, "--base-url", routerUrl,
        "--prompt", "local routing probe", "--max-tokens", "7",
        "--retries", "1", "--retry-sleep", "0"];
      const routerGood = await run(py, routerArgs, { cwd: root, env: childEnv });
      assert.equal(routerGood.code, 0, routerGood.stderr);
      assert.equal(JSON.parse(routerGood.stdout).ok, true);
      assert.deepEqual(chatPayload, { model: "fixture-model",
        messages: [{ role: "user", content: "local routing probe" }], max_tokens: 7 });
      emptyModels = true;
      const routerMissing = await run(py, routerArgs,
        { cwd: root, env: childEnv });
      assert.equal(routerMissing.code, 3);
      assert.equal(JSON.parse(routerMissing.stdout).checks[1].reason, "No model discovered");
    } finally { await new Promise(resolve => routerServer.close(resolve)); }
    cases.push({ id: router.id, scripts: [routerProgram],
      result: { discoveredModel: "fixture-model", sentChatPayload: true,
        missingModelExitCode: 3 },
      boundary: "Local HTTP protocol double only; no Dynamo cluster or GPU." });

    // Product Design: initialize only disposable context and recover saved
    // links with the source's parser. Oversized input is not misread as facts.
    if (process.env.SG_SKILL_TRACE) console.error("next-cohort: design");
    const design = await getSkill("product-design", "user-context");
    const designInit = await program(design, "scripts/init_user_context.py", "scripts/init_user_context.py");
    const designRead = await program(design, "scripts/user_context_preflight.py", "scripts/user_context_preflight.py");
    const designTemplate = await program(design,
      "plugin-author-config/user-context-template.md", "plugin-author-config/user-context-template.md");
    const designState = path.join(root, "design-state");
    const designMissing = await run(py, [designRead.target, "--state-dir", designState],
      { cwd: root, env: childEnv });
    assert.equal(JSON.parse(designMissing.stdout).user_context.status, "missing");
    const designCreated = await run(py, [designInit.target, "--state-dir", designState],
      { cwd: root, env: childEnv });
    assert.equal(designCreated.code, 0, designCreated.stderr);
    assert.match(designCreated.stdout, /user-context\.md: created/u);
    assert(fs.existsSync(designTemplate.target));
    const designContextPath = path.join(designState, "user-context.md");
    fs.writeFileSync(designContextPath, "# Brand\n## Saved Links And Context\n[Guide](https://example.test/guide)\n- Date Added: 2026-09-01\n- Useful Context: product direction\n# Research\n## Saved Links And Context\nstatus: not provided\n");
    const designPresent = await run(py, [designRead.target, "--state-dir", designState],
      { cwd: root, env: childEnv });
    const designData = JSON.parse(designPresent.stdout).user_context;
    assert.equal(designData.status, "present");
    assert.deepEqual(designData.entries.map(row => [row.category, row.name, row.url,
      row.useful_context]), [["Brand", "Guide", "https://example.test/guide",
      "product direction"]]);
    assert.deepEqual(designData.unresolved_categories, ["Research"]);
    const designOversized = await run(py, [designRead.target, "--state-dir", designState,
      "--max-context-bytes", "8"], { cwd: root, env: childEnv });
    assert.equal(JSON.parse(designOversized.stdout).user_context.status, "too_large");
    cases.push({ id: design.id, scripts: [designInit, designRead, designTemplate],
      result: { savedLink: "Guide", unresolvedCategory: "Research",
        oversizedContextRejected: true },
      boundary: "Disposable context file; no real user profile or design account." });

    // Data Analytics: source routing metadata and suppression IDs come from
    // installed assets and a disposable state file; malformed state degrades
    // to an explicit unreadable status, never a fabricated setup completion.
    if (process.env.SG_SKILL_TRACE) console.error("next-cohort: analytics");
    const analytics = await getSkill("data-analytics", "create-data-context");
    const analyticsProgram = await program(analytics,
      "scripts/data_analytics_preflight.py", "data_analytics_preflight.py");
    const categoryAsset = await program(analytics,
      "plugin-author-config/source-category-config.json",
      "source-category-config.json");
    const categoryTarget = path.join(root, "skills", "create-data-context",
      "plugin-author-config", "source-category-config.json");
    fs.mkdirSync(path.dirname(categoryTarget), { recursive: true });
    fs.copyFileSync(categoryAsset.target, categoryTarget);
    const analyticsState = path.join(root, "analytics-state");
    fs.mkdirSync(analyticsState, { recursive: true });
    const suppressionPath = path.join(analyticsState, "plugin-install-suppressions.json");
    writeJson(suppressionPath, { suppressed_plugin_installs: ["plugin-a",
      { tool_id: "plugin-b", reason: "deferred" }, "plugin-a"] });
    const analyticsArgs = [analyticsProgram.target, "--workflow", "source-intake",
      "--request-mode", "guided_setup_workflow", "--state-dir", analyticsState];
    const analyticsGood = await run(py, analyticsArgs, { cwd: root, env: childEnv });
    assert.equal(analyticsGood.code, 0, analyticsGood.stderr);
    const analyticsData = JSON.parse(analyticsGood.stdout);
    assert.equal(analyticsData.read_only, true);
    assert.equal(analyticsData.stateless, true);
    assert.equal(analyticsData.workflow, "source-intake");
    assert.deepEqual(analyticsData.context.suppressed_plugin_installs.ids,
      ["plugin-a", "plugin-b"]);
    assert.equal(analyticsData.context.source_category_config.categories.structured_data.label,
      "Data warehouse");
    assert.equal(analyticsData.context.connector_setup_summary.status, "not_tracked");
    fs.writeFileSync(suppressionPath, "{bad-json\n");
    const analyticsBad = await run(py, analyticsArgs, { cwd: root, env: childEnv });
    assert.equal(analyticsBad.code, 0);
    assert.equal(JSON.parse(analyticsBad.stdout).context.suppressed_plugin_installs.status,
      "unreadable");
    cases.push({ id: analytics.id, scripts: [analyticsProgram, categoryAsset],
      result: { routedCategory: "structured_data", suppressionIds: 2,
        unreadableStateSurfaced: true, setupStatus: "not_tracked" },
      boundary: "Only local routing envelope; no analytics connector or warehouse query." });

    // Higgsfield: align a synthetic word clock to exact authored text and
    // refuse unrelated transcription before producing burned caption text.
    if (process.env.SG_SKILL_TRACE) console.error("next-cohort: subtitles");
    const subtitles = await getSkill("higgsfield", "subtitles");
    const subtitlesProgram = await program(subtitles,
      "scripts/audio_to_captions.py", "audio_to_captions.py");
    const subtitleProbe = String.raw`import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("captions",sys.argv[1]); mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
clock=[{"word":"hello","start":0.0,"end":0.3},{"word":"world","start":0.3,"end":0.8}]
aligned,score=mod.align_words_to_script(clock,["Hello,","world!"])
captions=mod.group_captions(aligned,max_words=2,max_gap=0.5,max_chars=30)
try: mod.align_words_to_script(clock,["unrelated","text","here"])
except ValueError as error: refused="below" in str(error)
else: refused=False
print(json.dumps({"words":[row["word"] for row in aligned],"caption":captions[0]["text"],"score":score,"refused":refused}))`;
    const subtitleRun = await run(py, ["-c", subtitleProbe, subtitlesProgram.target],
      { cwd: root, env: childEnv });
    assert.equal(subtitleRun.code, 0, subtitleRun.stderr);
    const subtitleData = JSON.parse(subtitleRun.stdout);
    assert.deepEqual(subtitleData.words, ["Hello,", "world!"]);
    assert.equal(subtitleData.caption, "Hello, world!");
    assert(subtitleData.score >= 0.5);
    assert.equal(subtitleData.refused, true);
    cases.push({ id: subtitles.id, scripts: [subtitlesProgram],
      result: { authoredCaption: "Hello, world!", rejectedUnrelatedClock: true },
      boundary: "Authored text alignment slice only; no Whisper, audio, or video render." });

    // Financials normalization distinguishes sourced reported facts from
    // mislabeled consensus and non-numeric normalized financial values.
    if (process.env.SG_SKILL_TRACE) console.error("next-cohort: financials");
    const financials = await getSkill("public-equity-investing", "financials-normalizer");
    const financialsProgram = await program(financials,
      "scripts/validate_normalized_financials.py", "validate_normalized_financials.py");
    const financialsPath = path.join(root, "normalized-financials.csv");
    const financialHeader = ["entity","source_id","statement","line_item_original",
      "line_item_standard","line_item_id","period_end","period_label","period_type",
      "currency","units","source_value","normalized_value","normalization_method",
      "source_location","evidence_label","confidence"].join(",");
    const financialRow = ["ExampleCo","SRC-001","income_statement","Revenue",
      "Revenue","revenue","2025-12-31","FY2025","annual","USD","millions",
      "100","100","reported","filing-p4","fact_source_reported","high"].join(",");
    fs.writeFileSync(financialsPath, `${financialHeader}\n${financialRow}\n`);
    const financialGood = await run(py, [financialsProgram.target, financialsPath, "--json"],
      { cwd: root, env: childEnv });
    assert.equal(financialGood.code, 0, financialGood.stderr);
    assert.deepEqual(JSON.parse(financialGood.stdout).errors, []);
    assert.equal(JSON.parse(financialGood.stdout).rows, 1);
    fs.writeFileSync(financialsPath, `${financialHeader}\n${financialRow.replace(",100,100,reported,", ",100,NAN-TEXT,reported,")}\n`);
    const financialBad = await run(py, [financialsProgram.target, financialsPath, "--json"],
      { cwd: root, env: childEnv });
    assert.equal(financialBad.code, 1);
    assert.match(JSON.parse(financialBad.stdout).errors.join("; "), /normalized_value is not numeric/u);
    cases.push({ id: financials.id, scripts: [financialsProgram],
      result: { validatedRows: 1, rejectedNonnumericNormalizedValue: true },
      boundary: "Synthetic CSV provenance and numeric validation; no issuer data fetched." });

    // Initiating Coverage: enterprise to equity bridge yields an exact target;
    // a zero diluted-share denominator must be rejected.
    if (process.env.SG_SKILL_TRACE) console.error("next-cohort: initiation");
    const initiation = await getSkill("public-equity-investing", "initiating-coverage");
    const initiationProgram = await program(initiation,
      "scripts/calculate_price_target.py", "calculate_price_target.py");
    const initiationPath = path.join(root, "target-assumptions.json");
    writeJson(initiationPath, { method: "multiple", metric: 120, target_multiple: 10,
      net_debt: 200, non_operating_adjustments: 100, diluted_shares: 10 });
    const initiationGood = await run(py, [initiationProgram.target, initiationPath],
      { cwd: root, env: childEnv });
    assert.equal(initiationGood.code, 0, initiationGood.stderr);
    const initiationResult = JSON.parse(initiationGood.stdout);
    assert.equal(initiationResult.enterprise_value, 1200);
    assert.equal(initiationResult.equity_value, 1100);
    assert.equal(initiationResult.price_target, 110);
    writeJson(initiationPath, { method: "dcf", equity_value: 1100, diluted_shares: 0 });
    const initiationBad = await run(py, [initiationProgram.target, initiationPath],
      { cwd: root, env: childEnv });
    assert.equal(initiationBad.code, 1);
    assert.match(initiationBad.stdout, /diluted_shares must be positive/u);
    cases.push({ id: initiation.id, scripts: [initiationProgram],
      result: { enterpriseValue: 1200, equityValue: 1100, target: 110,
        rejectedZeroShares: true },
      boundary: "Assumption math only; no live price or valuation recommendation." });

    // The economic report gate accepts a dated, source-labeled synthesis and
    // downgrades stale material to a draft warning while blocking delivery.
    if (process.env.SG_SKILL_TRACE) console.error("next-cohort: impact");
    const impact = await getSkill("public-equity-investing", "economic-impact-report");
    const impactProgram = await program(impact,
      "scripts/check_economic_impact_report.py", "check_economic_impact_report.py");
    const impactPath = path.join(root, "economic-impact.md");
    const impactHeadings = ["Executive Call", "Event Status And Market Baseline",
      "What Is New Vs Expected", "Transmission Map", "Public Equity Framing",
      "Ranked Equity Impact Map", "What Is Priced In Vs What Requires Proof",
      "Scenario Matrix", "Monitoring Triggers And Research Queue",
      "What Would Change The View", "Bottom Line Judgment"];
    const impactBody = impactHeadings.map(value => `## ${value}\nSynthetic assessment with sourced baseline.\n`).join("\n");
    const impactSource = status => `## Source And Freshness\nData cut-off: 2026-09-01\nSources used: Synthetic packet S1\nStale or missing data: ${status}\nEvidence posture: primary source packet\n`;
    fs.writeFileSync(impactPath, impactBody + impactSource("none material"));
    const impactGood = await run(py, [impactProgram.target, impactPath],
      { cwd: root, env: childEnv });
    assert.equal(impactGood.code, 0, impactGood.stderr);
    assert.equal(JSON.parse(impactGood.stdout).valid, true);
    fs.writeFileSync(impactPath, impactBody + impactSource("stale quote"));
    const impactBad = await run(py, [impactProgram.target, impactPath],
      { cwd: root, env: childEnv });
    assert.equal(impactBad.code, 1);
    assert.match(JSON.parse(impactBad.stdout).errors.join("; "), /stale evidence disclosed/u);
    const impactDraft = await run(py, [impactProgram.target, "--mode", "draft", impactPath],
      { cwd: root, env: childEnv });
    assert.equal(impactDraft.code, 0);
    assert.match(JSON.parse(impactDraft.stdout).warnings.join("; "), /stale evidence disclosed/u);
    cases.push({ id: impact.id, scripts: [impactProgram],
      result: { acceptedDatedSource: true, staleDeliveryBlocked: true,
        staleDraftWarned: true },
      boundary: "Synthetic report structure and freshness gate only; no market evidence verified." });

    // Earnings Deep Dive: application mode requires a model and driver
    // registry; packet mode preserves an explicit no-model update route.
    if (process.env.SG_SKILL_TRACE) console.error("next-cohort: earnings");
    const earnings = await getSkill("public-equity-investing", "earnings-deep-dive");
    const earningsProgram = await program(earnings,
      "scripts/validate_plan.py", "validate_plan.py");
    const earningsIo = await program(earnings,
      "scripts/utils/io_utils.py", "utils/io_utils.py");
    const earningsValidation = await program(earnings,
      "scripts/utils/validation_utils.py", "utils/validation_utils.py");
    const earningsPath = path.join(root, "earnings-plan.json");
    const earningsPlan = { event: { ticker: "EXCO", fiscal_period: "FY2026Q1",
      event_date: "2026-09-01", timezone: "UTC", base_currency: "USD",
      base_scale: "millions" }, inputs: { normalized: { metrics_csv: "metrics.csv",
      estimates_csv: "estimates.csv", guidance_csv: "guidance.csv",
      quotes_csv: "quotes.csv", driver_updates_csv: "drivers.csv" } },
      outputs: { output_dir: path.join(root, "earnings-output"),
        model_update: { enabled: true, mode: "packet" } },
      controls: { require_source_tags: true } };
    writeJson(earningsPath, earningsPlan);
    const earningsGood = await run(py, [earningsProgram.target, earningsPath],
      { cwd: root, env: childEnv });
    assert.equal(earningsGood.code, 0, earningsGood.stderr);
    assert.match(earningsGood.stdout, /Plan is valid/u);
    writeJson(earningsPath, { ...earningsPlan,
      outputs: { ...earningsPlan.outputs, model_update: { enabled: true, mode: "apply" } } });
    const earningsBad = await run(py, [earningsProgram.target, earningsPath],
      { cwd: root, env: childEnv });
    assert.equal(earningsBad.code, 1);
    assert.match(earningsBad.stdout, /requires inputs\.model\.prior_model_xlsx/u);
    assert.match(earningsBad.stdout, /requires inputs\.model\.driver_registry_csv/u);
    cases.push({ id: earnings.id, scripts: [earningsProgram, earningsIo, earningsValidation],
      result: { acceptedPacketMode: true, blockedApplyWithoutModel: true },
      boundary: "Plan mode gate only; no model update or issuer financials." });

    // Thesis Tracker: a supplied issuer and source register materialize to
    // a concrete CSV bundle; malformed JSON cannot be labeled completed.
    if (process.env.SG_SKILL_TRACE) console.error("next-cohort: tracker");
    const tracker = await getSkill("public-equity-investing", "thesis-tracker");
    const trackerProgram = await program(tracker,
      "scripts/materialize_thesis_tracker.py", "materialize_thesis_tracker.py");
    const trackerPath = path.join(root, "tracker-input.json");
    const trackerOut = path.join(root, "tracker-output");
    writeJson(trackerPath, { dashboard: { company_issuer: "ExampleCo",
      current_thesis_status: "watch", action_recommendation: "research" },
      sources: [{ source_id: "SRC-001", source_name: "Synthetic filing",
        source_type: "issuer_filing", date_as_of: "2026-09-01" }],
      thesis_pillars: [{ pillar_id: "P1", claim: "Margins stabilize" }] });
    const trackerGood = await run(py, [trackerProgram.target, trackerPath,
      "--output-dir", trackerOut], { cwd: root, env: childEnv });
    assert.equal(trackerGood.code, 0, trackerGood.stderr);
    assert.match(fs.readFileSync(path.join(trackerOut, "dashboard.csv"), "utf8"),
      /company_issuer,ExampleCo/u);
    assert.match(fs.readFileSync(path.join(trackerOut, "sources.csv"), "utf8"),
      /SRC-001,Synthetic filing,issuer_filing,2026-09-01/u);
    assert.equal(readJson(path.join(trackerOut, "run_log.json")).source_basis[0].source_id,
      "SRC-001");
    fs.writeFileSync(trackerPath, "not-json\n");
    const trackerBad = await run(py, [trackerProgram.target, trackerPath,
      "--output-dir", trackerOut], { cwd: root, env: childEnv });
    assert.equal(trackerBad.code, 1);
    assert.equal(readJson(path.join(trackerOut, "run_log.json")).status, "failed");
    cases.push({ id: tracker.id, scripts: [trackerProgram],
      result: { issuer: "ExampleCo", sourceId: "SRC-001", malformedInputFailed: true },
      boundary: "Synthetic CSV tracker only; no real issuer evidence or XLSX review." });

    // gnomAD: compact a synthetic GraphQL data object and strictly validate
    // query shape. The remote biomedical endpoint is never contacted.
    if (process.env.SG_SKILL_TRACE) console.error("next-cohort: gnomad");
    const gnomad = await getSkill("life-science-research", "gnomad-graphql-skill");
    const gnomadProgram = await program(gnomad,
      "scripts/gnomad_graphql.py", "gnomad_graphql.py");
    const gnomadProbe = String.raw`import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("gnomad",sys.argv[1]); mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
config=mod.parse_input({"query":"query { gene { id } }","variables":{},"max_items":2,"max_depth":3})
summary=mod._compact({"genes":[{"id":"G1"},{"id":"G2"},{"id":"G3"}]},2,3)
try: mod.parse_input({"query":" ","max_items":0})
except ValueError as error: refused="query" in str(error)
else: refused=False
print(json.dumps({"query":config["query"],"summary":summary,"refused":refused}))`;
    const gnomadRun = await run(py, ["-c", gnomadProbe, gnomadProgram.target],
      { cwd: root, env: childEnv });
    assert.equal(gnomadRun.code, 0, gnomadRun.stderr);
    const gnomadData = JSON.parse(gnomadRun.stdout);
    assert.equal(gnomadData.query, "query { gene { id } }");
    assert.deepEqual(gnomadData.summary.genes.map(value => typeof value === "string" ?
      value : value.id), ["G1", "G2", "... (+1 more)"]);
    assert.equal(gnomadData.refused, true);
    cases.push({ id: gnomad.id, scripts: [gnomadProgram],
      result: { compactedRecords: 2, surfacedTruncation: true,
        rejectedBlankQuery: true },
      boundary: "Local query/response shaping only; no gnomAD call or scientific finding." });

    // Catalyst Calendar: confirmed public events can enter ICS, while an
    // estimated window remains in the workbook and out of calendar invites.
    const catalyst = await getSkill("public-equity-investing", "catalyst-calendar");
    const catalystProgram = await program(catalyst,
      "scripts/create_catalyst_calendar_workbook.py", "scripts/create_catalyst_calendar_workbook.py");
    const catalystWriter = await program(catalyst,
      "scripts/workbook_writer.py", "scripts/workbook_writer.py");
    const catalystInput = path.join(root, "catalyst-events.csv");
    const catalystWorkbook = path.join(root, "catalyst-calendar.xlsx");
    const catalystIcs = path.join(root, "catalyst-calendar.ics");
    fs.writeFileSync(catalystInput, [
      "event_id,ticker,event_name,event_date,window_start,window_end,date_type,source_label,impact_score,confidence_score",
      "E1,EXCO,Earnings Call,2026-09-15,,,confirmed date,official issuer notice,5,5",
      "E2,EXCO,Product Update,,2026-10-01,2026-10-31,estimated window,analyst assumption,3,2",
      "",
    ].join("\n"));
    const catalystArgs = [catalystProgram.target, "--input", catalystInput,
      "--output", catalystWorkbook, "--ics", catalystIcs, "--as-of", "2026-09-01"];
    const catalystGood = await run(py, catalystArgs, { cwd: root, env: childEnv });
    assert.equal(catalystGood.code, 0, catalystGood.stderr);
    assert.match(catalystGood.stdout, /Events loaded: 2/u);
    const icsText = fs.readFileSync(catalystIcs, "utf8");
    assert.match(icsText, /SUMMARY:EXCO - Earnings Call/u);
    assert.match(icsText, /DTSTART;VALUE=DATE:20260915/u);
    assert.doesNotMatch(icsText, /Product Update/u);
    assert.equal((icsText.match(/BEGIN:VEVENT/gu) || []).length, 1);
    assert(fs.statSync(catalystWorkbook).size > 1_000);
    const catalystWorkbookProbe = await run(py, ["-c", String.raw`import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as workbook:
    text=" ".join(workbook.read(name).decode("utf-8") for name in workbook.namelist() if name.endswith(".xml"))
    print("Earnings Call" in text, "Product Update" in text)
`, catalystWorkbook], { cwd: root, env: childEnv });
    assert.equal(catalystWorkbookProbe.code, 0, catalystWorkbookProbe.stderr);
    assert.equal(catalystWorkbookProbe.stdout.trim(), "True True");
    const catalystBad = await run(py, [...catalystArgs.slice(0, -2),
      "--as-of", "not-a-date"], { cwd: root, env: childEnv });
    assert.equal(catalystBad.code, 2);
    assert.match(catalystBad.stderr, /Invalid --as-of date/u);
    cases.push({ id: catalyst.id, scripts: [catalystProgram, catalystWriter],
      result: { eventRows: 2, confirmedIcsEvents: 1,
        estimatedWindowExcluded: true, invalidAsOfRejected: true },
      boundary: "Synthetic workbook and ICS; no live issuer event or calendar write." });

    // NCBI Entrez: installed helper performs an E-Utilities-shaped search
    // against a local HTTP double, truncates the returned idlist, and reports
    // an invalid record path. No NCBI request or credential is involved.
    if (process.env.SG_SKILL_TRACE) console.error("next-cohort: entrez");
    const entrez = await getSkill("life-science-research", "ncbi-entrez-skill");
    const entrezProgram = await program(entrez,
      "scripts/ncbi_entrez.py", "ncbi_entrez.py");
    const entrezRequests = [];
    const entrezServer = http.createServer((request, response) => {
      entrezRequests.push({ method: request.method, url: request.url });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ esearchresult: { idlist: ["101", "102", "103"] } }));
    });
    await new Promise(resolve => entrezServer.listen(0, "127.0.0.1", resolve));
    let entrezData;
    try {
      const entrezBase = `http://127.0.0.1:${entrezServer.address().port}`;
      const entrezProbe = String.raw`import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("entrez",sys.argv[1]); mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
mod.EUTILS_BASE=sys.argv[2]
base={"endpoint":"esearch","params":{"db":"gene","term":"EXCO"},"response_format":"json","record_path":"esearchresult.idlist","max_items":2}
good=mod.execute(dict(base))
bad=mod.execute({**base,"record_path":"esearchresult.idlist.4"})
print(json.dumps({"good":good,"bad":bad}))`;
      const entrezRun = await run(py, ["-c", entrezProbe, entrezProgram.target,
        entrezBase], { cwd: root, env: childEnv });
      assert.equal(entrezRun.code, 0, entrezRun.stderr);
      entrezData = JSON.parse(entrezRun.stdout);
    } finally { await new Promise(resolve => entrezServer.close(resolve)); }
    assert.equal(entrezRequests.length, 2);
    for (const request of entrezRequests) {
      assert.equal(request.method, "GET");
      const url = new URL(request.url, "http://127.0.0.1");
      assert.equal(url.pathname, "/esearch.fcgi");
      assert.equal(url.searchParams.get("db"), "gene");
      assert.equal(url.searchParams.get("term"), "EXCO");
    }
    assert.equal(entrezData.good.ok, true);
    assert.equal(entrezData.good.source, "ncbi-entrez");
    assert.equal(entrezData.good.record_path, "esearchresult.idlist");
    assert.deepEqual(entrezData.good.records, ["101", "102"]);
    assert.equal(entrezData.good.record_count_available, 3);
    assert.equal(entrezData.good.truncated, true);
    assert.equal(entrezData.bad.ok, false);
    assert.equal(entrezData.bad.error.code, "invalid_response");
    assert.match(entrezData.bad.error.message, /out of range/u);
    cases.push({ id: entrez.id, scripts: [entrezProgram],
      result: { inferredRecordPath: "esearchresult.idlist", returned: 2,
        available: 3, truncated: true, invalidPathRejected: true },
      boundary: "Local E-Utilities protocol double only; no NCBI endpoint or live scientific result." });

    if (process.env.SG_SKILL_TRACE) console.error("next-cohort: disable-start", cases.length);
    for (const [packageId, installed] of installations) {
      if (process.env.SG_SKILL_TRACE) console.error("next-cohort: disable", packageId);
      await rpc("plugins.installations.set", { installationId: installed.installationId,
        desiredState: "disabled", expectedRevision: installed.revision,
        operationId: `frozen-next-disable-${packageId}` });
    }
    if (process.env.SG_SKILL_TRACE) console.error("next-cohort: invisibility-check");
    for (const state of skills.values()) {
      if (process.env.SG_SKILL_TRACE) console.error("next-cohort: invisible", state.id);
      assert.equal((await findSkill(state.skillName)).filter(item => item.id === state.skillId).length, 0,
        `disabled Skill still visible externally: ${state.id}`);
      assert(!service.runtimeSkillStore.catalog(profile.id).items.some(item => item.id === state.skillId),
        `disabled Skill still visible natively: ${state.id}`);
    }
    const inventory = readJson(path.join(__dirname,
      "../docs/architecture/bundled-skill-dependency-inventory-2026-09-27.json"));
    assert.equal(inventory.source.batchDigest, catalog.batchDigest);
    assert.equal(inventory.skills.length, 502);
    const inventoryById = new Map(inventory.skills.map(item => [item.id, item]));
    const breadthEvidence = readJson(path.join(__dirname,
      "../docs/architecture/plugin-frozen-skill-breadth-evidence-2026-09-27.json"));
    const expansionEvidence = readJson(path.join(__dirname,
      "../docs/architecture/plugin-frozen-skill-business-expansion-evidence-2026-09-27.json"));
    const priorIds = ["superpowers/systematic-debugging",
      ...breadthEvidence.acceptedTopLevelSkillIds,
      ...expansionEvidence.newlyAcceptedTopLevelSkillIds];
    assert.equal(priorIds.length, 15);
    const acceptedIds = cases.map(item => item.id);
    assert.equal(cases.length, 13);
    assert.equal(new Set([...priorIds, ...acceptedIds]).size, 28,
      "new business cases duplicate earlier cases");
    assert(acceptedIds.every(id => inventoryById.has(id)),
      "case includes a missing or non-top-level Skill");
    const evidence = { schemaVersion: 1,
      host: "OpenClaw production adapter over isolated Service IPC",
      mode: "source; no packaging or installed App",
      batchDigest: catalog.batchDigest,
      corpusTopLevelSkills: inventory.skills.length,
      priorAcceptedTopLevelSkills: priorIds.length,
      newlyAcceptedTopLevelSkillIds: acceptedIds,
      cumulativeBoundedLocalBusinessSkills: priorIds.length + acceptedIds.length,
      remainingTopLevelSkillsWithoutBoundedLocalCase: inventory.skills.length - priorIds.length - acceptedIds.length,
      cases: cases.map(item => ({ id: item.id,
        sourceDigest: skills.get(item.id).installed.frozen.sourceDigest,
        installedReleaseDigest: skills.get(item.id).installed.releaseDigest,
        sourceSkillSha256: skills.get(item.id).sourceSkillSha256,
        installedSkillSha256: skills.get(item.id).installedSkillSha256,
        skillPages: skills.get(item.id).skillPages,
        nativeRequiredTools: skills.get(item.id).nativeRequiredTools,
        nativeRequiredRuntimeCapabilities: skills.get(item.id).nativeRequiredRuntimeCapabilities,
        frozenDependencySignals: {
          packageMcpDeclarations: inventoryById.get(item.id).packageMcpDeclarations,
          packageApps: inventoryById.get(item.id).packageApps,
          explicitTools: inventoryById.get(item.id).explicitTools,
          namedToolCandidates: inventoryById.get(item.id).namedToolCandidates,
          hostMarkers: inventoryById.get(item.id).hostMarkers,
          mentionedCli: inventoryById.get(item.id).mentionedCli,
        },
        files: item.scripts.map(file => ({ sha256: file.sha256, pages: file.pages })),
        result: item.result, boundary: item.boundary })),
      nativeFacadeRead: true, disabledSkillsInvisible: true,
      externalAccountUsed: false, realAgentOrModelUsed: false,
      installedAppUsed: false };
    const evidencePath = path.join(__dirname,
      "../docs/architecture/plugin-frozen-skill-next-cohort-evidence-2026-09-27.json");
    if (writeEvidence) fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    else assert.deepEqual(readJson(evidencePath), evidence,
      "next-cohort evidence drifted; rerun with --write-evidence only after reviewing changed results");
    console.log("plugin-frozen-skill-next-cohort-fixture: ok",
      JSON.stringify({ newCases: acceptedIds.length, cumulative: priorIds.length + acceptedIds.length,
        remaining: inventory.skills.length - priorIds.length - acceptedIds.length }));
  } finally {
    try { await service?.stop(); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
