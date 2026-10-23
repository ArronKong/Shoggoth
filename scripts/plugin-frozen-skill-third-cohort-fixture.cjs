#!/usr/bin/env node
"use strict";

// Bounded, deterministic business exercises for fifteen further frozen top-level
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
    "usage: node scripts/plugin-frozen-skill-third-cohort-fixture.cjs [--write-evidence]");
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-skill-third-cohort-"));
  const paths = resolveServicePaths({ homeDir: root,
    userDataRoot: path.join(root, "service"), stateRoot: path.join(root, "service", "shoggoth-core"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const catalog = new BundledPluginCatalog(bundledRoot());
  let service;
  try {
    const credentialToken = ensureCredential(paths, "openclaw");
    service = createAgentService({ paths, prewarmMcpAuth: false, parentEnv: {},
      externalPluginAgentVerifier: async identity => ({ id: identity.agentId,
        backendId: identity.backendId }), version: "frozen-skill-third-cohort-fixture" });
    await service.start();
    const rpc = (method, params) => requestService(paths, {
      token: readClientToken(paths), version: SERVICE_PROTOCOL_VERSION, method, params,
    }, { timeoutMs: 15_000 });
    const externalRpc = (method, params, options = {}) => requestService(paths, {
      version: SERVICE_PROTOCOL_VERSION, method, params,
    }, { timeoutMs: options.timeoutMs || 10_000, signal: options.signal });
    const { createAdapter } = await import(pathToFileURL(path.join(__dirname,
      "../resources/external-plugin-adapters/openclaw/index.mjs")).href);
    const adapter = createAdapter({ instanceId: "frozen-skill-third-cohort-fixture",
      credential: () => credentialToken,
      requestService: (method, params, options) => externalRpc(method, params, options) });
    let callNumber = 0;
    const invoke = async (name, args) => {
      const toolCallId = `frozen-skill-next-${++callNumber}`;
      const context = { agentId: "frozen-third-agent", sessionId: "frozen-third-session",
        runId: "frozen-third-run" };
      assert.equal(adapter.beforeToolCall({ toolName: name, toolCallId,
        runId: context.runId }, context), undefined);
      try { return (await adapter.tool(name, context).execute(toolCallId, args)).details; }
      catch (error) { if (process.env.SG_SKILL_TRACE) console.error("third-cohort: tool-error", callNumber, name, args, error.code); throw error; }
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
          operationId: `frozen-third-install-${packageId}` })).installation;
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
      const target = path.join(root, "mirror", state.packageId, "skills", state.skillName, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, read.text, { mode: 0o700 });
      return { relativePath, target, sha256: read.digest, pages: read.pages };
    };
    const resource = async (state, relativePath) => {
      const source = fs.readFileSync(path.join(bundledRoot(), "packages", state.packageId,
        relativePath), "utf8");
      const read = await readChunks("shoggoth_plugin_resource_read",
        { skillId: state.skillId, relativePath });
      assert.equal(read.text, source, `installed resource changed: ${state.id}/${relativePath}`);
      const target = path.join(root, "mirror", state.packageId, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, read.text, { mode: 0o700 });
      return { relativePath, target, sha256: read.digest, pages: read.pages };
    };
    const py = pythonBinary();
    const childTmp = path.join(root, "child-tmp");
    fs.mkdirSync(childTmp, { mode: 0o700 });
    const childEnv = { HOME: root, TMPDIR: childTmp, LANG: "C", LC_ALL: "C",
      PATH: `${path.dirname(py)}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: "",
      OPT_OUT_INSTRUMENTATION: "true" };
    const work = label => {
      const directory = path.join(root, "work", label);
      fs.mkdirSync(directory, { recursive: true });
      return directory;
    };
    const clearWork = directory => fs.rmSync(directory, { recursive: true, force: true });
    const cases = [];

    // Creative Production: the installed ads helper delegates to the installed
    // offer planner and bundled prompt pack, producing a local review board
    // without running image generation. Missing brief is rejected.
    const creative = await getSkill("creative-production", "produce");
    const adsProgram = await program(creative,
      "helpers/ads/scripts/build_ads_explorer.py");
    const offerProgram = await program(creative,
      "helpers/offers/scripts/build_offer_explorer.py");
    const reviewRenderer = await resource(creative, "scripts/review_renderer.py");
    const adsPack = await resource(creative,
      "assets/image-ad-library/packs/diverse-image-ad-archetypes.json");
    const creativeWork = work("creative");
    try {
      const out = path.join(creativeWork, "review");
      const good = await run(py, [adsProgram.target, "--ad-name", "Orbit Lamp",
        "--ad-brief", "A portable reading lamp for commuters",
        "--out-dir", out, "--review-only"],
        { cwd: creativeWork, env: childEnv });
      assert.equal(good.code, 0, good.stderr);
      const result = JSON.parse(good.stdout);
      assert(result.items > 1);
      assert.equal(result.images_found, 0);
      assert(fs.existsSync(result.review_html));
      const jobs = fs.readFileSync(result.jobs, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(jobs.length, result.items);
      assert(jobs.some(job => job.prompt.includes("Orbit Lamp")));
      const bad = await run(py, [adsProgram.target, "--ad-name", "Orbit Lamp",
        "--out-dir", path.join(creativeWork, "missing-brief"), "--review-only"],
        { cwd: creativeWork, env: childEnv });
      assert.notEqual(bad.code, 0);
      assert.match(bad.stderr, /Provide --offer-brief/u);
    } finally { clearWork(creativeWork); }
    cases.push({ id: creative.id,
      scripts: [adsProgram, offerProgram, reviewRenderer, adsPack],
      result: { reviewBoardItems: "multiple", generatedImages: 0,
        missingBriefRejected: true },
      boundary: "Packaged ad-prompt review board only; no Creative Production host board or image generation." });

    // Google Slides: run the installed output-QC CLI and all its installed
    // runtime modules against a synthetic deck with a stale title placeholder.
    const slides = await getSkill("google-drive", "google-slides");
    const slideFiles = [await program(slides, "scripts/check_output_issues.mjs")];
    for (const filename of ["common", "design-system", "media-geometry", "normalize",
      "output-issues", "result"]) {
      slideFiles.push(await program(slides, `runtime/${filename}.mjs`));
    }
    let slideCodes;
    const slideWork = work("slides");
    try {
      const raw = path.join(slideWork, "raw.json");
      const output = path.join(slideWork, "issues.json");
      const presentation = text => ({ presentationId: "local-deck", title: "Local deck",
        pageSize: { width: { magnitude: 720, unit: "PT" },
          height: { magnitude: 405, unit: "PT" } },
        slides: [{ objectId: "slide-1", pageElements: [{ objectId: "title-1",
          size: { width: { magnitude: 600, unit: "PT" },
            height: { magnitude: 80, unit: "PT" } },
          shape: { placeholder: { type: "TITLE" },
            text: { textElements: [{ textRun: { content: text,
              style: { fontSize: { magnitude: 24, unit: "PT" } } } }] } } }] }] });
      writeJson(raw, presentation("Click to add title"));
      const stale = await run(process.execPath, [slideFiles[0].target,
        "--input", raw, "--output", output], { cwd: slideWork, env: childEnv });
      assert.equal(stale.code, 0, stale.stderr);
      slideCodes = Object.keys(readJson(output).summary.byCode);
      assert(slideCodes.includes("GENERIC_PLACEHOLDER_TEXT"));
      writeJson(raw, presentation("Revenue grew 12%"));
      const finished = await run(process.execPath, [slideFiles[0].target,
        "--input", raw, "--output", output], { cwd: slideWork, env: childEnv });
      assert.equal(finished.code, 0, finished.stderr);
      assert.equal(readJson(output).summary.totalIssues, 0);
      const badLimit = await run(process.execPath, [slideFiles[0].target,
        "--input", raw, "--output", output, "--max-issues", "0"],
      { cwd: slideWork, env: childEnv });
      assert.equal(badLimit.code, 1);
      assert.match(badLimit.stderr, /maxIssues must be an integer/u);
    } finally { clearWork(slideWork); }
    cases.push({ id: slides.id, scripts: slideFiles,
      result: { staleTitleIssue: "GENERIC_PLACEHOLDER_TEXT",
        finishedTitleIssues: 0, invalidLimitRejected: true },
      boundary: "Synthetic Slides response normalization and output QC; no Slides account or render." });

    // NVIDIA USD tuning: installed report template renders a scored local
    // composition review and escapes hostile report text in HTML output.
    const usd = await getSkill("nvidia", "omniverse-usd-performance-tuning");
    const usdProgram = await program(usd,
      "references/report-templates/render_preview.py");
    const usdTemplate = await program(usd,
      "references/report-templates/optimization-report.html.template");
    const usdFixture = await program(usd,
      "references/report-templates/optimization-report.design-fixture.json");
    const usdWork = work("usd-report");
    try {
      const output = path.join(usdWork, "report.html");
      const good = await run(py, [usdProgram.target, "--fixture", usdFixture.target,
        "--template", usdTemplate.target, "--output", output],
        { cwd: usdWork, env: childEnv });
      assert.equal(good.code, 0, good.stderr);
      const html = fs.readFileSync(output, "utf8");
      assert(html.includes('Stage optimization score 8.2 out of 10'));
      assert.match(html, /Factory_Performance_Review/u);
      const altered = readJson(usdFixture.target);
      altered.executive_summary = "<script>unsafe()</script>";
      const alteredPath = path.join(usdWork, "hostile.json");
      writeJson(alteredPath, altered);
      const escaped = await run(py, [usdProgram.target, "--fixture", alteredPath,
        "--template", usdTemplate.target, "--output", output],
        { cwd: usdWork, env: childEnv });
      assert.equal(escaped.code, 0, escaped.stderr);
      const escapedHtml = fs.readFileSync(output, "utf8");
      assert.match(escapedHtml, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/u);
      assert(!escapedHtml.includes("<script>unsafe()</script>"));
    } finally { clearWork(usdWork); }
    cases.push({ id: usd.id, scripts: [usdProgram, usdTemplate, usdFixture],
      result: { designFixtureScore: "8.2/10", unsafeReportTextEscaped: true },
      boundary: "Bundled design fixture rendered locally; no USD stage, renderer, or Omniverse runtime profiled." });

    // iOS Simulator Browser: installed project generator creates Swift/Xcode
    // source that includes the local package and respects opt-in preview
    // filtering; nil filters leave previews unfiltered.
    const iosBrowser = await getSkill("build-ios-apps", "ios-simulator-browser");
    const xcodeProject = await program(iosBrowser, "scripts/lib/xcode-project.mjs");
    const iosProbe = String.raw`const {pathToFileURL}=require('node:url');
(async()=>{const mod=await import(pathToFileURL(process.argv[1]).href);
const project=mod.createPackageProjectFile({targetName:'PreviewHarness',bundleId:'org.example.preview',packageRelativePath:'../Source',packageProduct:'ExampleKit',pluginTargetName:'PreviewReload',deploymentTarget:'18.0'});
const filtered=mod.generatedPackageConfigurationSwiftSource({packageModule:'ExampleKit',previewFilters:['Home','Quote"View']});
const unfiltered=mod.generatedPackageConfigurationSwiftSource({packageModule:'ExampleKit',previewFilters:null});
console.log(JSON.stringify({project,filtered,unfiltered}));})().catch(error=>{console.error(error);process.exitCode=1});`;
    const iosRun = await run(process.execPath, ["-e", iosProbe, xcodeProject.target],
      { cwd: root, env: childEnv });
    assert.equal(iosRun.code, 0, iosRun.stderr);
    const iosResult = JSON.parse(iosRun.stdout);
    assert.match(iosResult.project, /org\.example\.preview/u);
    assert.match(iosResult.project, /ExampleKit/u);
    assert.match(iosResult.project, /PreviewReload/u);
    assert.match(iosResult.filtered, /previewBrowserFilters: \[String\]\? = \["Home", "Quote\\"View"\]/u);
    assert.match(iosResult.unfiltered, /previewBrowserFilters: \[String\]\? = nil/u);
    cases.push({ id: iosBrowser.id, scripts: [xcodeProject],
      result: { packageProduct: "ExampleKit", reloadTarget: "PreviewReload",
        selectedFiltersEscaped: true, nilFiltersUnrestricted: true },
      boundary: "Generated project text only; no Xcode build, simulator launch, or Swift preview rendering." });

    // Public equity deck QC: a numeric report without provenance triggers a
    // source gap; an otherwise identical cited report clears that issue.
    const deckQc = await getSkill("public-equity-investing", "deck-report-qc");
    const deckProgram = await program(deckQc, "scripts/inspect_deck_report.py");
    const deckAnalysis = await program(deckQc, "scripts/qc_analysis.py");
    const deckShared = await resource(deckQc, "shared/artifact_packager.py");
    const deckWork = work("deck-qc");
    try {
      const input = path.join(deckWork, "report.md");
      const numbers = "Revenue 10 12 14 16 18 20.\n";
      fs.writeFileSync(input, numbers);
      const uncitedDir = path.join(deckWork, "uncited");
      const uncited = await run(py, [deckProgram.target, input, "--outdir", uncitedDir],
        { cwd: deckWork, env: childEnv });
      assert.equal(uncited.code, 0, uncited.stderr + uncited.stdout);
      const first = readJson(path.join(uncitedDir, "logs", "scan.json"));
      assert(first.issues.some(issue => issue.issue_type === "source_gap"));
      assert(fs.existsSync(path.join(uncitedDir, "deck-report-qc.html"))
        || fs.readdirSync(uncitedDir).some(name => name.endsWith(".html")));
      fs.writeFileSync(input, numbers + "Source: company filing 10-Q as of 2026-09-27.\n");
      const citedDir = path.join(deckWork, "cited");
      const cited = await run(py, [deckProgram.target, input, "--outdir", citedDir],
        { cwd: deckWork, env: childEnv });
      assert.equal(cited.code, 0, cited.stderr + cited.stdout);
      const second = readJson(path.join(citedDir, "logs", "scan.json"));
      assert(!second.issues.some(issue => issue.issue_type === "source_gap"));
    } finally { clearWork(deckWork); }
    cases.push({ id: deckQc.id, scripts: [deckProgram, deckAnalysis, deckShared],
      result: { uncitedNumbersFlagged: true, citedNumbersClearSourceGap: true,
        htmlQcReportWritten: true },
      boundary: "Synthetic Markdown first-pass QC only; no visual review, issuer source validation, or finished investment report." });

    // Codex Security: the installed schema and validator accept a coherent
    // no-op disposition but reject a merge claim with non-applicable ownership.
    const risk = await getSkill("codex-security", "assess-patch-risk");
    const riskValidator = await program(risk, "scripts/validate_patch_risk_assessment.py");
    const riskSchema = await resource(risk, "schemas/patch-risk-assessment.schema.json");
    const riskContract = await resource(risk, "scripts/finalize_scan_contract.py");
    const riskWork = work("risk");
    try {
      const assessment = path.join(riskWork, "assessment.json");
      const rated = (rating, rationale) => ({ rating, rationale });
      const value = { schemaVersion: 1,
        patch: { repository: "local/repo", sourceType: "patch_file", base: "base-1",
          head: "head-1", changedFiles: ["src/example.py"], sha256: "a".repeat(64) },
        recommendation: "no_op", workflowLabel: "no_op",
        impact: rated("low", "no affected runtime"),
        regressionLikelihood: rated("low", "not applicable"),
        regressionProtection: { rating: "partial", rationale: "local checks", exactHeadChecksPassed: false },
        recoverability: rated("easy", "no rollout"), confidence: rated("high", "owner check"),
        applicability: { status: "wrong_owner", rationale: "separate repository owns the path" },
        statusQuoRisk: rated("low", "no live effect"), autoMergeExclusions: [],
        affectedRuntimeRoots: [], materialBoundaries: [],
        validation: [{ name: "owner trace", status: "passed", protects: "ownership" }],
        unknowns: [], evidencePlan: [] };
      writeJson(assessment, value);
      const good = await run(py, [riskValidator.target, assessment],
        { cwd: riskWork, env: childEnv });
      assert.equal(good.code, 0, good.stderr);
      writeJson(assessment, { ...value, recommendation: "merge", workflowLabel: "human_review_required" });
      const falseMerge = await run(py, [riskValidator.target, assessment],
        { cwd: riskWork, env: childEnv });
      assert.equal(falseMerge.code, 1);
      assert.match(falseMerge.stderr, /merge requires confirmed applicability|non-applicable disposition requires no_op/u);
    } finally { clearWork(riskWork); }
    cases.push({ id: risk.id, scripts: [riskValidator, riskSchema, riskContract],
      result: { coherentNoOpAccepted: true, falseMergeRejected: true },
      boundary: "Synthetic risk assessment and installed schema only; no live patch assessed or merged." });
    // Equity user context: installed templates initialize isolated state,
    // preserve user edits on rerun, and refuse a non-directory state target.
    const user = await getSkill("public-equity-investing", "user-context");
    const userFiles = [await program(user, "scripts/init_user_context_state.py"),
      await program(user, "scripts/state_paths.py"),
      await program(user, "plugin-author-config/user-context-config.md"),
      await program(user, "references/onboarding-state-template.json")];
    const userWork = work("equity-user");
    try {
      const stateDir = path.join(userWork, "state");
      const command = [userFiles[0].target, "--state-dir", stateDir];
      const initialized = await run(py, command, { cwd: userWork, env: childEnv });
      assert.equal(initialized.code, 0, initialized.stderr);
      const contextPath = path.join(stateDir, "user-context.md");
      const original = fs.readFileSync(contextPath, "utf8");
      assert.match(original, /status: not provided/u);
      assert(fs.existsSync(path.join(stateDir, "onboarding-state.json")));
      fs.appendFileSync(contextPath, "\n# Local analyst note\n");
      const rerun = await run(py, command, { cwd: userWork, env: childEnv });
      assert.equal(rerun.code, 0, rerun.stderr);
      assert.match(rerun.stdout, /user-context\.md: preserved/u);
      assert.match(fs.readFileSync(contextPath, "utf8"), /Local analyst note/u);
      const nonDirectory = path.join(userWork, "file-state");
      fs.writeFileSync(nonDirectory, "occupied");
      const bad = await run(py, [userFiles[0].target, "--state-dir", nonDirectory],
        { cwd: userWork, env: childEnv });
      assert.notEqual(bad.code, 0);
      assert.equal(fs.readFileSync(nonDirectory, "utf8"), "occupied");
    } finally { clearWork(userWork); }
    cases.push({ id: user.id, scripts: userFiles,
      result: { scaffoldCreated: true, rerunPreservedUserNote: true,
        fileStateTargetRefused: true },
      boundary: "Isolated local state only; no actual analyst links or accounts supplied." });

    // Scenario sensitivity: supplied price targets and probabilities produce a
    // weighted return; a 90% probability distribution must remain unpriced.
    const scenario = await getSkill("public-equity-investing", "scenario-sensitivity-generator");
    const scenarioProgram = await program(scenario,
      "scripts/materialize_public_equity_sensitivities.py");
    const scenarioWork = work("scenario");
    try {
      const input = path.join(scenarioWork, "input.json");
      const output = path.join(scenarioWork, "output.json");
      const scenarioInput = { base: { share_price: 100, required_return: 0.1 },
        cases: [{ scenario: "upside", price_target: 150, probability: 0.2 },
          { scenario: "base", price_target: 120, probability: 0.6 },
          { scenario: "downside", price_target: 80, probability: 0.2 }] };
      writeJson(input, scenarioInput);
      const args = [scenarioProgram.target, "--input", input,
        "--tables", "price_target_scenario", "--format", "json", "--output", output];
      const good = await run(py, args, { cwd: scenarioWork, env: childEnv });
      assert.equal(good.code, 0, good.stderr);
      const weighted = readJson(output).tables[0].rows.find(row => row.scenario === "probability_weighted");
      assert.equal(weighted.price_target, "118.0");
      assert.equal(weighted.return_vs_share_price, "18.0%");
      assert.equal(weighted.probability_check, "ok");
      scenarioInput.cases[2].probability = 0.1;
      writeJson(input, scenarioInput);
      const incomplete = await run(py, args, { cwd: scenarioWork, env: childEnv });
      assert.equal(incomplete.code, 0, incomplete.stderr);
      const withheld = readJson(output).tables[0].rows.find(row => row.scenario === "probability_weighted");
      assert.equal(withheld.price_target, "input required");
      assert.match(withheld.probability_check, /sum to 100%/u);
    } finally { clearWork(scenarioWork); }
    cases.push({ id: scenario.id, scripts: [scenarioProgram],
      result: { weightedPriceTarget: 118, weightedReturnPercent: 18,
        incompleteProbabilityWithheld: true },
      boundary: "User-supplied illustrative numbers only; no issuer valuation or trading decision." });

    // Equity model update: retrieved modules materialize source-to-model deltas,
    // while a missing evidence identifier fails rather than producing a map.
    const update = await getSkill("public-equity-investing", "equity-model-update");
    const updateFiles = [];
    for (const filename of ["materialize_model_update", "model_update_core",
      "model_update_dates", "model_update_io", "model_update_artifacts",
      "model_update_fields", "model_update_rows", "model_update_format", "model_update_validate"]) {
      updateFiles.push(await program(update, `scripts/${filename}.py`));
    }
    const updateWork = work("equity-update");
    try {
      const input = path.join(updateWork, "mapping.csv");
      const out = path.join(updateWork, "out");
      const header = "source_id,model_line,source_metric,proposed_model_value,current_model_value,as_of_date,source_name\n";
      fs.writeFileSync(input, header + "filing-1,Revenue,Reported revenue,120,100,2026-09-26,10-Q\n");
      const args = [updateFiles[0].target, input, "--out", out, "--run-date", "2026-09-27"];
      const good = await run(py, args, { cwd: updateWork, env: childEnv });
      assert.equal(good.code, 0, good.stderr + good.stdout);
      const csv = fs.readFileSync(path.join(out, "source_to_model.csv"), "utf8");
      assert.match(csv, /Revenue/u);
      assert.match(csv, /,20(?:\.0)?,/u);
      assert.equal(readJson(path.join(out, "run_log.json")).status, "completed");
      fs.writeFileSync(input, header + ",Revenue,Reported revenue,120,100,2026-09-26,10-Q\n");
      const bad = await run(py, [updateFiles[0].target, input,
        "--out", path.join(updateWork, "invalid"), "--run-date", "2026-09-27"],
      { cwd: updateWork, env: childEnv });
      assert.equal(bad.code, 1);
      assert.match(bad.stdout, /source_id is required/u);
      assert.equal(readJson(path.join(updateWork, "invalid", "run_log.json")).status, "failed");
    } finally { clearWork(updateWork); }
    cases.push({ id: update.id, scripts: updateFiles,
      result: { sourceToModelDelta: 20, missingSourceIdRejected: true },
      boundary: "Synthetic CSV update map only; no live model workbook edited or audited." });

    // Comps fallback: real installed materializer produces a screen-grade XLSX
    // with explicitly missing market data, and rejects invalid sourcing mode.
    const comps = await getSkill("public-equity-investing", "comps-valuation");
    const compsProgram = await program(comps, "scripts/materialize_screening_comps.py");
    const compsShared = await resource(comps, "shared/artifact_packager.py");
    const compsWork = work("comps");
    try {
      const out = path.join(compsWork, "output");
      const args = [compsProgram.target, "--output-dir", out, "--target", "Example Corp",
        "--ticker", "EXCO", "--valuation-date", "2026-09-27",
        "--peer-list", "AAA:Alpha Co,BBB:Beta Co", "--market-data-status", "missing"];
      const good = await run(py, args, { cwd: compsWork, env: childEnv });
      assert.equal(good.code, 0, good.stderr + good.stdout);
      const peers = fs.readFileSync(path.join(out, "peer_framework.csv"), "utf8");
      assert.match(peers, /Alpha Co/u);
      assert.match(peers, /Beta Co/u);
      const log = readJson(path.join(out, "run_log.json"));
      assert.equal(log.model_status, "screen-grade");
      assert.equal(log.dependency_status.openpyxl, "not_required");
      assert(fs.statSync(path.join(out, "screen_grade_comps_framework.xlsx")).size > 1000);
      const bad = await run(py, [...args.slice(0, -1), "fabricated"],
        { cwd: compsWork, env: childEnv });
      assert.equal(bad.code, 2);
      assert.match(bad.stderr, /invalid choice/u);
    } finally { clearWork(compsWork); }
    cases.push({ id: comps.id, scripts: [compsProgram, compsShared],
      result: { peerCandidates: 2, screenGradeWorkbook: true,
        absentMarketDataDisclosed: true, invalidSourcingModeRejected: true },
      boundary: "Synthetic peer candidates and missing-data workbook; no market feed or investment conclusion." });
    const runLifeProbe = async (state, relativePath, source, label) => {
      const retrieved = await program(state, relativePath);
      const directory = work(label);
      try {
        const probe = `import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location('installed_skill',sys.argv[1])\nmod=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(mod)\n${source}`;
        const result = await run(py, ["-c", probe, retrieved.target],
          { cwd: directory, env: childEnv });
        assert.equal(result.code, 0, result.stderr);
        return { file: retrieved, value: JSON.parse(result.stdout) };
      } finally { clearWork(directory); }
    };

    // PMC: parse a local Open Access XML response into a bounded scientific
    // summary and reject an absent record path.
    const pmc = await getSkill("life-science-research", "ncbi-pmc-skill");
    const pmcProbe = await runLifeProbe(pmc, "scripts/ncbi_pmc.py", String.raw`
class Response:
    text='<oa><records><record><id>PMC1</id></record><record><id>PMC2</id></record></records></oa>'
    def raise_for_status(self): pass
mod.requests.get=lambda *args,**kwargs: Response()
good=mod.execute({'max_depth':8})
bad=mod.execute({'record_path':'oa.missing'})
print(json.dumps({'good':good,'bad':bad}))`, "pmc");
    assert.equal(pmcProbe.value.good.ok, true);
    assert.deepEqual(pmcProbe.value.good.summary.oa.records.record,
      [{ id: "PMC1" }, { id: "PMC2" }]);
    assert.equal(pmcProbe.value.bad.ok, false);
    assert.equal(pmcProbe.value.bad.error.code, "invalid_response");
    cases.push({ id: pmc.id, scripts: [pmcProbe.file],
      result: { xmlArticleIds: ["PMC1", "PMC2"], absentPathRejected: true },
      boundary: "Local stub XML only; no NCBI PMC request or article download." });

    // NCBI Datasets: report-list extraction respects max_items and refuses an
    // out-of-range record selector.
    const datasets = await getSkill("life-science-research", "ncbi-datasets-skill");
    const datasetsProbe = await runLifeProbe(datasets, "scripts/ncbi_datasets.py", String.raw`
class Response:
    text='{"reports":[{"accession":"GCF_1"},{"accession":"GCF_2"},{"accession":"GCF_3"}]}'
    headers={'content-type':'application/json'}
    def raise_for_status(self): pass
    def json(self): return json.loads(self.text)
mod.requests.get=lambda *args,**kwargs: Response()
base={'path':'genome/accession/GCF_1/dataset_report','response_format':'json','record_path':'reports','max_items':2}
good=mod.execute(base)
bad=mod.execute({**base,'record_path':'reports.9'})
print(json.dumps({'good':good,'bad':bad}))`, "datasets");
    assert.equal(datasetsProbe.value.good.ok, true);
    assert.deepEqual(datasetsProbe.value.good.records,
      [{ accession: "GCF_1" }, { accession: "GCF_2" }]);
    assert.equal(datasetsProbe.value.good.record_count_available, 3);
    assert.equal(datasetsProbe.value.good.truncated, true);
    assert.equal(datasetsProbe.value.bad.error.code, "invalid_response");
    cases.push({ id: datasets.id, scripts: [datasetsProbe.file],
      result: { genomeReportsReturned: 2, available: 3, invalidIndexRejected: true },
      boundary: "Local Datasets-shaped JSON only; no NCBI Datasets endpoint or genome fetch." });

    // ClinicalTrials: a two-page local session yields both study identifiers,
    // while an invalid page bound is rejected before any request.
    const trials = await getSkill("life-science-research", "clinicaltrials-skill");
    const trialsProbe = await runLifeProbe(trials, "scripts/clinicaltrials_client.py", String.raw`
seen=[]
class Response:
    def __init__(self,data): self.data=data
    def raise_for_status(self): pass
    def json(self): return self.data
class Session:
    def __init__(self): self.headers={}
    def get(self,url,params=None,timeout=None):
        seen.append({'url':url,'params':dict(params or {})})
        if params and params.get('pageToken')=='next':
            return Response({'studies':[{'protocolSection':{'identificationModule':{'nctId':'NCT2'}}}],'totalCount':2})
        return Response({'studies':[{'protocolSection':{'identificationModule':{'nctId':'NCT1'}}}],'nextPageToken':'next','totalCount':2})
    def close(self): pass
mod.requests.Session=Session
good=mod.execute({'action':'studies','params':{'query.term':'EXCO'},'max_pages':2,'max_depth':8})
try:
    mod.parse_input({'action':'studies','max_pages':0})
    rejected=False
except ValueError:
    rejected=True
print(json.dumps({'good':good,'badRejected':rejected,'seen':seen}))`, "trials");
    assert.equal(trialsProbe.value.good.ok, true);
    assert.equal(trialsProbe.value.good.pages_fetched, 2);
    assert.equal(trialsProbe.value.good.record_count_returned, 2);
    assert.deepEqual(trialsProbe.value.good.records.map(item =>
      item.protocolSection.identificationModule.nctId), ["NCT1", "NCT2"]);
    assert.equal(trialsProbe.value.seen[1].params.pageToken, "next");
    assert.equal(trialsProbe.value.badRejected, true);
    cases.push({ id: trials.id, scripts: [trialsProbe.file],
      result: { pagedStudyIds: ["NCT1", "NCT2"], pagesFetched: 2,
        invalidPageBoundRejected: true },
      boundary: "Local ClinicalTrials v2 session double; no ClinicalTrials.gov request." });

    // ClinVar: a Clinical Tables search reports the actual total separately
    // from the bounded returned rows; an identifier lookup needs an ID.
    const clinvar = await getSkill("life-science-research", "clinvar-variation-skill");
    const clinvarProbe = await runLifeProbe(clinvar, "scripts/clinvar_variation.py", String.raw`
class Response:
    def raise_for_status(self): pass
    def json(self): return [3,['VCV1','VCV2'],{'field':'clinical_significance'},[['pathogenic'],['benign']]]
mod.requests.get=lambda *args,**kwargs: Response()
good=mod.execute({'action':'search','terms':'BRCA1','max_items':1})
bad=mod.execute({'action':'vcv'})
print(json.dumps({'good':good,'bad':bad}))`, "clinvar");
    assert.equal(clinvarProbe.value.good.ok, true);
    assert.equal(clinvarProbe.value.good.total, 3);
    assert.deepEqual(clinvarProbe.value.good.identifiers, ["VCV1"]);
    assert.deepEqual(clinvarProbe.value.good.display_rows, [["pathogenic"]]);
    assert.equal(clinvarProbe.value.good.truncated, true);
    assert.equal(clinvarProbe.value.bad.error.code, "invalid_input");
    cases.push({ id: clinvar.id, scripts: [clinvarProbe.file],
      result: { clinvarIdentifier: "VCV1", sourceTotal: 3,
        returned: 1, missingVcvRejected: true },
      boundary: "Local ClinVar-shaped response only; no clinical assertion or external lookup." });

    // NCBI Gene Clinical Tables: preserve gene ID and total while truncating
    // display rows; refuse an empty search term.
    const gene = await getSkill("life-science-research", "ncbi-clinicaltables-skill");
    const geneProbe = await runLifeProbe(gene,
      "scripts/ncbi_gene_clinicaltables.py", String.raw`
class Response:
    def raise_for_status(self): pass
    def json(self): return [3,['7157','672'],{'field':'symbol'},[['TP53'],['BRCA1']]]
mod.requests.get=lambda *args,**kwargs: Response()
good=mod.execute({'terms':'TP53','max_items':1})
bad=mod.execute({'terms':'  '})
print(json.dumps({'good':good,'bad':bad}))`, "gene");
    assert.equal(geneProbe.value.good.ok, true);
    assert.equal(geneProbe.value.good.total, 3);
    assert.deepEqual(geneProbe.value.good.codes, ["7157"]);
    assert.deepEqual(geneProbe.value.good.display_rows, [["TP53"]]);
    assert.equal(geneProbe.value.good.truncated, true);
    assert.equal(geneProbe.value.bad.error.code, "invalid_input");
    cases.push({ id: gene.id, scripts: [geneProbe.file],
      result: { geneId: "7157", symbol: "TP53", sourceTotal: 3,
        returned: 1, emptyTermRejected: true },
      boundary: "Local Clinical Tables response only; no NCBI Gene request or biological validation." });
    if (process.env.SG_SKILL_TRACE) console.error("third-cohort: disable-start", cases.length);
    for (const [packageId, installed] of installations) {
      if (process.env.SG_SKILL_TRACE) console.error("third-cohort: disable", packageId);
      await rpc("plugins.installations.set", { installationId: installed.installationId,
        desiredState: "disabled", expectedRevision: installed.revision,
        operationId: `frozen-third-disable-${packageId}` });
    }
    if (process.env.SG_SKILL_TRACE) console.error("third-cohort: invisibility-check");
    for (const state of skills.values()) {
      if (process.env.SG_SKILL_TRACE) console.error("third-cohort: invisible", state.id);
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
    const nextEvidence = readJson(path.join(__dirname,
      "../docs/architecture/plugin-frozen-skill-next-cohort-evidence-2026-09-27.json"));
    const priorIds = ["superpowers/systematic-debugging",
      ...breadthEvidence.acceptedTopLevelSkillIds,
      ...expansionEvidence.newlyAcceptedTopLevelSkillIds,
      ...nextEvidence.newlyAcceptedTopLevelSkillIds];
    assert.equal(priorIds.length, 28);
    const acceptedIds = cases.map(item => item.id);
    assert.equal(cases.length, 15);
    assert.equal(new Set([...priorIds, ...acceptedIds]).size, 43,
      "new business cases duplicate earlier cases");
    assert(acceptedIds.every(id => inventoryById.has(id)),
      "case includes a missing or non-top-level Skill");
    const evidence = { schemaVersion: 1,
      candidateGapsNotAccepted: [
        { id: "openai-developers/build-chatgpt-app", reason: "Native Runtime ineligible without its declared openaiDeveloperDocs MCP dependency; no live docs host used." },
        { id: "shopify/shopify-polaris-app-home", reason: "Validator needs TypeScript and Shopify type packages absent from the frozen installed Skill; no dependency installation or network allowed." },
        { id: "superpowers/writing-skills", reason: "Graph rendering requires host Graphviz dot; host-tool execution is outside this isolated fixture." },
      ],
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
        files: item.scripts.map(file => ({ relativePath: file.relativePath, sha256: file.sha256, pages: file.pages })),
        result: item.result, boundary: item.boundary })),
      nativeFacadeRead: true, disabledSkillsInvisible: true,
      externalAccountUsed: false, realAgentOrModelUsed: false,
      installedAppUsed: false };
    const evidencePath = path.join(__dirname,
      "../docs/architecture/plugin-frozen-skill-third-cohort-evidence-2026-09-27.json");
    if (writeEvidence) fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    else assert.deepEqual(readJson(evidencePath), evidence,
      "third-cohort evidence drifted; rerun with --write-evidence only after reviewing changed results");
    console.log("plugin-frozen-skill-third-cohort-fixture: ok",
      JSON.stringify({ newCases: acceptedIds.length, cumulative: priorIds.length + acceptedIds.length,
        remaining: inventory.skills.length - priorIds.length - acceptedIds.length }));
  } finally {
    try { await service?.stop(); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
