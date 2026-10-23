#!/usr/bin/env node
"use strict";

// Bounded, deterministic business exercises for eight further frozen top-level
// Skills. Every program is read from an opted-in installation through the
// production OpenClaw adapter before it is run in a disposable task directory.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
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
    "usage: node scripts/plugin-frozen-skill-business-expansion-fixture.cjs [--write-evidence]");
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-skill-expansion-"));
  const paths = resolveServicePaths({ homeDir: root,
    userDataRoot: path.join(root, "service"), stateRoot: path.join(root, "service", "shoggoth-core"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const catalog = new BundledPluginCatalog(bundledRoot());
  let service;
  try {
    const credentialToken = ensureCredential(paths, "openclaw");
    service = createAgentService({ paths, prewarmMcpAuth: false, parentEnv: {},
      externalPluginAgentVerifier: async identity => ({ id: identity.agentId,
        backendId: identity.backendId }), version: "frozen-skill-expansion-fixture" });
    await service.start();
    const rpc = (method, params) => requestService(paths, {
      token: readClientToken(paths), version: SERVICE_PROTOCOL_VERSION, method, params,
    }, { timeoutMs: 15_000 });
    const externalRpc = (method, params, options = {}) => requestService(paths, {
      version: SERVICE_PROTOCOL_VERSION, method, params,
    }, { timeoutMs: options.timeoutMs || 10_000, signal: options.signal });
    const { createAdapter } = await import(pathToFileURL(path.join(__dirname,
      "../resources/external-plugin-adapters/openclaw/index.mjs")).href);
    const adapter = createAdapter({ instanceId: "frozen-skill-expansion-fixture",
      credential: () => credentialToken,
      requestService: (method, params, options) => externalRpc(method, params, options) });
    let callNumber = 0;
    const invoke = async (name, args) => {
      const toolCallId = `frozen-skill-expansion-${++callNumber}`;
      const context = { agentId: "frozen-expansion-agent", sessionId: "frozen-expansion-session",
        runId: "frozen-expansion-run" };
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
          operationId: `frozen-expansion-install-${packageId}` })).installation;
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

    // A source-labeled issuer input is checked and rendered. Missing required
    // evidence labels must fail validation rather than produce a trusted sheet.
    const tearsheet = await getSkill("public-equity-investing", "company-tearsheet");
    const tearValidate = await program(tearsheet, "scripts/validate_tearsheet_json.py", "validate.py");
    const tearRender = await program(tearsheet, "scripts/build_tearsheet_markdown.py", "render.py");
    const tearInput = path.join(root, "synthetic-tearsheet.json");
    const tearData = { entity: "ExampleCo", profile_type: "public_company", as_of_date: "2026-09-01",
      sections: { one_line_view: "Synthetic issuer baseline only" },
      sources: [{ source_id: "S1", source_name: "Synthetic filing",
        source_type: "issuer_filing", as_of_date: "2026-08-31" }],
      metrics: [{ metric: "Revenue", period: "FY2025", value: 120,
        units: "USD million", source: "S1", evidence: "fact_source_reported", confidence: "high" }] };
    writeJson(tearInput, tearData);
    const tearValid = await run(py, [tearValidate.target, tearInput, "--strict"],
      { cwd: root, env: childEnv });
    assert.equal(tearValid.code, 0, tearValid.stderr);
    assert.match(tearValid.stdout, /validation passed/u);
    const tearOutput = path.join(root, "synthetic-tearsheet.md");
    const tearRendered = await run(py, [tearRender.target, tearInput, tearOutput],
      { cwd: root, env: childEnv });
    assert.equal(tearRendered.code, 0, tearRendered.stderr);
    const tearMarkdown = fs.readFileSync(tearOutput, "utf8");
    assert.match(tearMarkdown, /# ExampleCo Tearsheet/u);
    assert.match(tearMarkdown, /\| Revenue \| FY2025 \| 120 \| USD million \| S1 \| fact_source_reported \| high \|/u);
    writeJson(tearInput, { ...tearData, metrics: [{ ...tearData.metrics[0], evidence: "fabricated" }] });
    const tearRejected = await run(py, [tearValidate.target, tearInput, "--strict"],
      { cwd: root, env: childEnv });
    assert.equal(tearRejected.code, 1);
    assert.match(tearRejected.stdout, /invalid evidence label: fabricated/u);
    cases.push({ id: tearsheet.id, scripts: [tearValidate, tearRender],
      result: { validatedMetric: "Revenue", rejectedEvidenceLabel: "fabricated" } });

    // Short financing cost and scenario probabilities materially affect the
    // expected-value table, and an incomplete distribution must fail closed.
    const pitch = await getSkill("public-equity-investing", "long-short-pitch");
    const pitchProgram = await program(pitch, "scripts/materialize_trade_scenarios.py", "scenarios.py");
    const pitchInput = path.join(root, "synthetic-pitch.csv");
    const pitchHeader = "scenario,probability,current_value,target_value,key_drivers,timing,borrow_fee,carry_cost,holding_period_days,source,source_as_of";
    const pitchRows = [
      "Bear,75%,100,80,Profit miss,6 months,0.04,0.02,180,Synthetic packet,2026-09-01",
      "Bull,25%,100,120,Unexpected demand,6 months,0.04,0.02,180,Synthetic packet,2026-09-01",
    ];
    fs.writeFileSync(pitchInput, `${[pitchHeader, ...pitchRows].join("\n")}\n`);
    const pitchMd = path.join(root, "pitch-note.md");
    const pitchJson = path.join(root, "pitch-result.json");
    const pitchArgs = [pitchProgram.target, pitchInput, "--side", "short",
      "--markdown-out", pitchMd, "--json-out", pitchJson, "--run-date", "2026-09-27"];
    const pitchRun = await run(py, pitchArgs, { cwd: root, env: childEnv });
    assert.equal(pitchRun.code, 0, pitchRun.stderr);
    const pitchResult = readJson(pitchJson);
    assert.equal(pitchResult.probability_ok, true);
    assert.equal(pitchResult.total_probability, 1);
    assert(Math.abs(pitchResult.rows[0].financing_cost - 0.06 * 180 / 365) < 1e-12);
    assert(Math.abs(pitchResult.expected_return - (0.75 * (0.2 - 0.06 * 180 / 365)
      + 0.25 * (-0.2 - 0.06 * 180 / 365))) < 1e-12);
    assert.match(fs.readFileSync(pitchMd, "utf8"), /Expected return:/u);
    fs.writeFileSync(pitchInput, `${[pitchHeader, pitchRows[0]].join("\n")}\n`);
    const pitchMismatch = await run(py, pitchArgs, { cwd: root, env: childEnv });
    assert.equal(pitchMismatch.code, 1);
    assert.equal(readJson(pitchJson).probability_ok, false);
    cases.push({ id: pitch.id, scripts: [pitchProgram],
      result: { side: "short", probabilitySum: 1, rejectedProbabilitySum: 0.75 } });

    // The hedge scorecard ranks supplied candidates but routes credit hedges
    // away from public-equity implementation even when their numeric score is high.
    const risk = await getSkill("public-equity-investing", "portfolio-risk-management");
    const riskProgram = await program(risk, "scripts/score_hedge_candidates.py", "hedges.py");
    const riskInput = path.join(root, "synthetic-hedges.csv");
    const riskHeader = ["hedge", "hedge_type", "risk_hedged", "exposure_fit_score",
      "thesis_preservation_score", "relationship_stability_score", "downside_behavior_score",
      "tenor_alignment_score", "cost_carry_score", "liquidity_score",
      "implementation_complexity_score", "basis_risk_score", "basis_risk",
      "implementation_status", "as_of", "source", "live_pricing_status", "borrow_status",
      "option_chain_status", "risk_model_status"].join(",");
    const ready = ["Index put", "equity option", "market drawdown", ...Array(9).fill("5"),
      "Index gap", "research", "2026-09-01", "Synthetic packet",
      "current", "not_applicable", "current", "validated"].join(",");
    const credit = ["CDS overlay", "credit default swap", "issuer default", ...Array(9).fill("5"),
      "Capital structure mismatch", "research", "2026-09-01", "Synthetic packet",
      "current", "not_applicable", "not_applicable", "validated"].join(",");
    fs.writeFileSync(riskInput, `${riskHeader}\n${ready}\n${credit}\n`);
    const riskOut = path.join(root, "risk-scorecard");
    const riskRun = await run(py, [riskProgram.target, riskInput, "--output-dir", riskOut],
      { cwd: root, env: childEnv });
    assert.equal(riskRun.code, 0, riskRun.stderr);
    const riskRows = readJson(path.join(riskOut, "hedge_scorecard.json")).rows;
    assert.deepEqual(riskRows.map(row => [row.rank, row.hedge, row.bucket, row.readiness_status]), [
      [1, "Index put", "primary hedge candidate", "implementation-data-ready"],
      [2, "CDS overlay", "route to Credit Markets", "route_to_credit_markets"],
    ]);
    assert.match(riskRows[1].warnings, /Credit hedge construction belongs in Credit Markets/u);
    assert.match(fs.readFileSync(path.join(riskOut, "hedge_scorecard_support_note.md"), "utf8"),
      /Confirm live pricing, borrow, options, liquidity, and risk-model data/u);
    fs.writeFileSync(riskInput, `${riskHeader}\nIncomplete,equity option,,${Array(9).fill("5").join(",")}\n`);
    const riskReject = await run(py, [riskProgram.target, riskInput, "--output-dir", riskOut],
      { cwd: root, env: childEnv });
    assert.equal(riskReject.code, 1);
    assert.match(riskReject.stdout, /risk_hedged is required/u);
    cases.push({ id: risk.id, scripts: [riskProgram],
      result: { ranked: ["Index put", "CDS overlay"], creditRoute: "Credit Markets",
        rejectedMissingRisk: true } });

    // A 60/40 event distribution yields an exact terminal value. A 60/20
    // distribution is diagnostic-only and cannot masquerade as memo-ready EV.
    const event = await getSkill("public-equity-investing", "event-driven-analyzer");
    const eventProgram = await program(event, "scripts/event_math.py", "event_math.py");
    const eventInput = path.join(root, "synthetic-event.json");
    const eventData = { current_price: 100, scenarios: [
      { name: "close", probability: 0.6, terminal_value: 120, days_to_resolution: 180 },
      { name: "break", probability: 0.4, terminal_value: 70, days_to_resolution: 180 },
    ] };
    writeJson(eventInput, eventData);
    const eventArgs = [eventProgram.target, "--mode", "scenario_ev", "--input", eventInput];
    const eventRun = await run(py, eventArgs, { cwd: root, env: childEnv });
    assert.equal(eventRun.code, 0, eventRun.stderr);
    const eventResult = JSON.parse(eventRun.stdout);
    assert.equal(eventResult.expected_terminal_value, 100);
    assert.equal(eventResult.expected_return, 0);
    assert.equal(eventResult.probabilities_sum_to_100pct, true);
    writeJson(eventInput, { ...eventData, scenarios: [eventData.scenarios[0],
      { ...eventData.scenarios[1], probability: 0.2 }] });
    const eventReject = await run(py, eventArgs, { cwd: root, env: childEnv });
    assert.equal(eventReject.code, 1);
    assert.match(eventReject.stderr, /scenario probabilities must sum to 1\.0/u);
    const eventDiagnostic = await run(py, [...eventArgs, "--allow-probability-sum-mismatch"],
      { cwd: root, env: childEnv });
    assert.equal(eventDiagnostic.code, 0, eventDiagnostic.stderr);
    assert.equal(JSON.parse(eventDiagnostic.stdout).probabilities_sum_to_100pct, false);
    cases.push({ id: event.id, scripts: [eventProgram],
      result: { expectedTerminalValue: 100, rejectedProbabilitySum: 0.8,
        diagnosticFlaggedMismatch: true } });

    // ETTrace's processed tree yields active versus idle hotspots. Raw capture
    // JSON is deliberately rejected; no simulator or actual ETTrace run exists.
    const ettrace = await getSkill("build-ios-apps", "ios-ettrace-performance");
    const ettraceProgram = await program(ettrace, "scripts/analyze_flamegraph_json.py", "flamegraph.py");
    const flameFile = path.join(root, "output_MainThread.json");
    writeJson(flameFile, { nodes: { name: "<root>", duration: 10, children: [
      { name: "App.renderFrame", duration: 7, children: [] },
      { name: "mach_msg_trap", duration: 3, children: [] },
    ] } });
    const flameRun = await run(py, [ettraceProgram.target, flameFile, "--pattern", "renderFrame"],
      { cwd: root, env: childEnv });
    assert.equal(flameRun.code, 0, flameRun.stderr);
    assert.match(flameRun.stdout, /Total duration:\s+10\.000000/u);
    assert.match(flameRun.stdout, /Idle self total:\s+3\.000000/u);
    assert.match(flameRun.stdout, /Active total:\s+7\.000000/u);
    assert.match(flameRun.stdout, /7\.000000\s+100\.00%active App\.renderFrame/u);
    writeJson(flameFile, { threads: [], libraryInfo: {} });
    const flameReject = await run(py, [ettraceProgram.target, flameFile],
      { cwd: root, env: childEnv });
    assert.equal(flameReject.code, 1);
    assert.match(flameReject.stderr, /raw capture JSON, not processed flamegraph JSON/u);
    cases.push({ id: ettrace.id, scripts: [ettraceProgram],
      result: { active: 7, idle: 3, rejectedRawCapture: true } });

    // NVIDIA's recipe preflight diagnoses missing UCX/NCCL transport settings
    // without contacting kubectl, a GPU, a pod, or a NIXL peer.
    const interconnect = await getSkill("nvidia", "dynamo-interconnect-check");
    const interconnectProgram = await program(interconnect,
      "scripts/check_interconnect.py", "interconnect.py");
    const manifest = path.join(root, "synthetic-dynamo.yaml");
    fs.writeFileSync(manifest, "env:\n  - name: UCX_TLS\n    value: rc,cuda_ipc\n"
      + "  - name: UCX_NET_DEVICES\n    value: mlx5_0:1\n"
      + "  - name: UCX_IB_GPU_DIRECT_RDMA\n    value: y\n"
      + "  - name: NCCL_IB_HCA\n    value: mlx5_0\n"
      + "  - name: NCCL_SOCKET_IFNAME\n    value: eth0\n"
      + "  - name: NCCL_IB_DISABLE\n    value: 0\n");
    const interconnectRun = await run(py, [interconnectProgram.target, "env", manifest],
      { cwd: root, env: childEnv });
    assert.equal(interconnectRun.code, 0, interconnectRun.stderr);
    const transport = JSON.parse(interconnectRun.stdout);
    assert.equal(transport.counts.ok, 6);
    assert.equal(transport.counts.fail, 0);
    assert.equal(transport.counts.warn, 0);
    fs.writeFileSync(manifest, "env:\n  - name: UCX_TLS\n    value: tcp\n");
    const gapRun = await run(py, [interconnectProgram.target, "env", manifest],
      { cwd: root, env: childEnv });
    assert.equal(gapRun.code, 0);
    const gaps = JSON.parse(gapRun.stdout).checks;
    assert(gaps.some(item => item.name === "env:disagg-transport" && item.status === "warn"
      && item.detail.includes("NCCL_IB_HCA")));
    const absentRun = await run(py, [interconnectProgram.target, "env",
      path.join(root, "missing-manifest.yaml")], { cwd: root, env: childEnv });
    assert.equal(absentRun.code, 1);
    assert(JSON.parse(absentRun.stdout).checks.some(item => item.name === "env" && item.status === "fail"));
    cases.push({ id: interconnect.id, scripts: [interconnectProgram],
      result: { declaredTransportSettings: 6, warnedMissingTransport: true,
        rejectedMissingManifest: true } });

    // `leaks` is a required host program. A tiny isolated stand-in exercises
    // parsing and report generation; real Simulator capture remains unproven.
    const memgraph = await getSkill("build-ios-apps", "ios-memgraph-leaks");
    const memgraphProgram = await program(memgraph,
      "scripts/summarize_memgraph_leaks.py", "summarize_memgraph.py");
    const fakeBin = path.join(root, "fake-bin");
    fs.mkdirSync(fakeBin);
    const fakeLeaks = path.join(fakeBin, "leaks");
    fs.writeFileSync(fakeLeaks, ["#!/bin/sh", "case \"$1\" in",
      "  --list) printf 'Process Synthetic: 2 leaks for 96 total leaked bytes\\nLeak: 0xABC size=64 Widget  Swift  SyntheticApp\\nLeak: 0xDEF size=32 Widget  Swift  SyntheticApp\\n' ;;",
      "  --groupByType) printf 'Widget: 2 leaks\\n' ;;",
      "  --traceTree=*) printf 'trace for %s\\n' \"$1\" ;;",
      "  *) exit 4 ;;", "esac", ""].join("\n"), { mode: 0o700 });
    const memgraphFile = path.join(root, "synthetic.memgraph");
    fs.writeFileSync(memgraphFile, "synthetic fixture; not an Apple memgraph\n");
    const memgraphOut = path.join(root, "leaks-summary.md");
    const memgraphRun = await run(py, [memgraphProgram.target, memgraphFile,
      "--trace-limit", "1", "--out", memgraphOut],
    { cwd: root, env: { ...childEnv, PATH: `${fakeBin}:${childEnv.PATH}` } });
    assert.equal(memgraphRun.code, 0, memgraphRun.stderr);
    const leakSummary = fs.readFileSync(memgraphOut, "utf8");
    assert.match(leakSummary, /Total: 2 leaks \/ 96 bytes/u);
    assert.match(leakSummary, /Parsed leak entries: 2/u);
    assert.match(leakSummary, /2x Widget/u);
    assert.match(leakSummary, /trace for --traceTree=0xABC/u);
    assert.match(leakSummary, /Widget: 2 leaks/u);
    const memgraphMissing = await run(py, [memgraphProgram.target,
      path.join(root, "absent.memgraph")],
    { cwd: root, env: { ...childEnv, PATH: `${fakeBin}:${childEnv.PATH}` } });
    assert.equal(memgraphMissing.code, 2);
    assert.match(memgraphMissing.stderr, /memgraph not found/u);
    cases.push({ id: memgraph.id, scripts: [memgraphProgram],
      result: { parsedLeaks: 2, groupedType: "Widget", rejectedMissingCapture: true,
        hostTool: "leaks fixture stand-in" } });

    // Task extraction ignores faux headings inside fenced code, preserves the
    // real task body, and rejects an absent task instead of an empty brief.
    const subagents = await getSkill("superpowers", "subagent-driven-development");
    const briefProgram = await program(subagents, "scripts/task-brief", "task-brief");
    const planFile = path.join(root, "synthetic-plan.md");
    const briefFile = path.join(root, "task-2-brief.md");
    fs.writeFileSync(planFile, ["# Synthetic plan", "", "## Task 1: first", "Do first.",
      "```md", "## Task 2: fake", "Do not dispatch this.", "```", "",
      "## Task 2: implement", "Use the real task body.", "- Verify result.",
      "", "## Task 3: final", "Do final.", ""].join("\n"));
    const briefRun = await run("/bin/bash", [briefProgram.target, planFile, "2", briefFile],
      { cwd: root, env: childEnv });
    assert.equal(briefRun.code, 0, briefRun.stderr);
    assert.equal(fs.readFileSync(briefFile, "utf8"),
      "## Task 2: implement\nUse the real task body.\n- Verify result.\n\n");
    const missingBrief = await run("/bin/bash", [briefProgram.target, planFile, "9",
      path.join(root, "task-9-brief.md")], { cwd: root, env: childEnv });
    assert.equal(missingBrief.code, 3);
    assert.match(missingBrief.stderr, /task 9 not found/u);
    cases.push({ id: subagents.id, scripts: [briefProgram],
      result: { selectedTask: 2, ignoredFencedHeading: true, rejectedMissingTask: true } });

    // This separate candidate is intentionally excluded from business counts:
    // its two reviewed Codex Docs tools have no native Shoggoth equivalent.
    const gatedSource = { kind: "bundled", packageId: "openai-developers" };
    const gatedPreview = await rpc("plugins.install.preview", { source: gatedSource });
    assert(gatedPreview.installable);
    const gatedInstall = (await rpc("plugins.install", { source: gatedSource,
      previewDigest: gatedPreview.previewDigest,
      expectedRevision: gatedPreview.expectedRevision,
      operationId: "frozen-expansion-install-openai-developers" })).installation;
    installations.set("openai-developers", { ...gatedInstall,
      frozen: catalog.assertCurrent("openai-developers") });
    const gatedFound = await findSkill("build-chatgpt-app");
    assert.equal(gatedFound.length, 1, "installed gated Skill absent from discovery");
    const gatedNative = service.runtimeSkillStore.catalog(profile.id).ineligible.find(item =>
      item.id === gatedFound[0].id);
    assert(gatedNative, "reviewed Codex Docs Skill should be ineligible in native Runtime");
    assert.equal(gatedNative.reason, "tool_missing");
    assert.deepEqual(gatedNative.requiredTools, [
      "mcp__openaiDeveloperDocs__search_openai_docs",
      "mcp__openaiDeveloperDocs__fetch_openai_doc",
    ]);
    assert.equal(gatedNative.dependency, gatedNative.requiredTools[0]);

    for (const [packageId, installed] of installations) {
      await rpc("plugins.installations.set", { installationId: installed.installationId,
        desiredState: "disabled", expectedRevision: installed.revision,
        operationId: `frozen-expansion-disable-${packageId}` });
    }
    for (const state of skills.values()) {
      assert.equal((await findSkill(state.skillName)).filter(item => item.id === state.skillId).length, 0,
        `disabled Skill still visible externally: ${state.id}`);
      assert(!service.runtimeSkillStore.catalog(profile.id).items.some(item => item.id === state.skillId),
        `disabled Skill still visible natively: ${state.id}`);
    }
    assert(!service.runtimeSkillStore.catalog(profile.id).ineligible.some(item =>
      item.id === gatedFound[0].id), "disabled gated Skill still visible natively");
    const inventory = readJson(path.join(__dirname,
      "../docs/architecture/bundled-skill-dependency-inventory-2026-09-27.json"));
    assert.equal(inventory.source.batchDigest, catalog.batchDigest);
    assert.equal(inventory.skills.length, 502);
    const inventoryById = new Map(inventory.skills.map(item => [item.id, item]));
    const priorIds = ["superpowers/systematic-debugging", ...readJson(path.join(__dirname,
      "../docs/architecture/plugin-frozen-skill-breadth-evidence-2026-09-27.json"))
      .acceptedTopLevelSkillIds];
    assert.equal(priorIds.length, 7);
    const acceptedIds = cases.map(item => item.id);
    assert.equal(cases.length, 8);
    assert.equal(new Set([...priorIds, ...acceptedIds]).size, 15,
      "new business cases duplicate earlier cases");
    assert(acceptedIds.every(id => inventoryById.has(id)),
      "case includes a missing or non-top-level Skill");
    const evidence = { schemaVersion: 1,
      host: "OpenClaw production adapter over isolated Service IPC",
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
        scripts: item.scripts.map(script => ({ sha256: script.sha256, pages: script.pages })),
        result: item.result })),
      dependencyGatedNotAccepted: [{ id: "openai-developers/build-chatgpt-app",
        reason: gatedNative.reason, dependency: gatedNative.dependency,
        requiredTools: gatedNative.requiredTools }],
      nativeFacadeRead: true, disabledSkillsInvisible: true,
      externalAccountUsed: false, realAgentOrModelUsed: false,
      installedAppUsed: false };
    const evidencePath = path.join(__dirname,
      "../docs/architecture/plugin-frozen-skill-business-expansion-evidence-2026-09-27.json");
    if (writeEvidence) fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    else assert.deepEqual(readJson(evidencePath), evidence,
      "business evidence drifted; rerun with --write-evidence only after reviewing changed results");
    console.log("plugin-frozen-skill-business-expansion-fixture: ok",
      JSON.stringify({ newCases: acceptedIds.length, cumulative: priorIds.length + acceptedIds.length }));
  } finally {
    try { await service?.stop(); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
