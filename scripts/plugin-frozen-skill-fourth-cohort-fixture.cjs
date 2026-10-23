#!/usr/bin/env node
"use strict";

// Bounded, deterministic business exercises for eleven further frozen top-level
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

function hostBinary(name) {
  return fs.realpathSync(execFileSync("/usr/bin/which", [name],
    { encoding: "utf8", timeout: 5_000 }).trim());
}

async function main() {
  const writeEvidence = process.argv.slice(2).includes("--write-evidence");
  assert(process.argv.slice(2).every(arg => arg === "--write-evidence"),
    "usage: node scripts/plugin-frozen-skill-fourth-cohort-fixture.cjs [--write-evidence]");
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-skill-fourth-cohort-"));
  const paths = resolveServicePaths({ homeDir: root,
    userDataRoot: path.join(root, "service"), stateRoot: path.join(root, "service", "shoggoth-core"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const catalog = new BundledPluginCatalog(bundledRoot());
  let service;
  try {
    const credentialToken = ensureCredential(paths, "openclaw");
    service = createAgentService({ paths, prewarmMcpAuth: false, parentEnv: {},
      externalPluginAgentVerifier: async identity => ({ id: identity.agentId,
        backendId: identity.backendId }), version: "frozen-skill-fourth-cohort-fixture" });
    await service.start();
    const rpc = (method, params) => requestService(paths, {
      token: readClientToken(paths), version: SERVICE_PROTOCOL_VERSION, method, params,
    }, { timeoutMs: 15_000 });
    const externalRpc = (method, params, options = {}) => requestService(paths, {
      version: SERVICE_PROTOCOL_VERSION, method, params,
    }, { timeoutMs: options.timeoutMs || 10_000, signal: options.signal });
    const { createAdapter } = await import(pathToFileURL(path.join(__dirname,
      "../resources/external-plugin-adapters/openclaw/index.mjs")).href);
    const adapter = createAdapter({ instanceId: "frozen-skill-fourth-cohort-fixture",
      credential: () => credentialToken,
      requestService: (method, params, options) => externalRpc(method, params, options) });
    let callNumber = 0;
    const invoke = async (name, args) => {
      const toolCallId = `frozen-skill-fourth-${++callNumber}`;
      const context = { agentId: "frozen-fourth-agent", sessionId: "frozen-fourth-session",
        runId: "frozen-fourth-run" };
      assert.equal(adapter.beforeToolCall({ toolName: name, toolCallId,
        runId: context.runId }, context), undefined);
      try { return (await adapter.tool(name, context).execute(toolCallId, args)).details; }
      catch (error) { if (process.env.SG_SKILL_TRACE) console.error("fourth-cohort: tool-error", callNumber, name, args, error.code); throw error; }
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
          operationId: `frozen-fourth-install-${packageId}` })).installation;
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

    const wavWork = work("synthetic-audio");
    const wavFile = path.join(wavWork, "voice.wav");
    const sampleRate = 16_000;
    const frames = Math.round(3.2 * sampleRate);
    const wave = Buffer.alloc(44 + frames * 2);
    wave.write("RIFF", 0); wave.writeUInt32LE(wave.length - 8, 4);
    wave.write("WAVEfmt ", 8); wave.writeUInt32LE(16, 16);
    wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
    wave.writeUInt32LE(sampleRate, 24); wave.writeUInt32LE(sampleRate * 2, 28);
    wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34);
    wave.write("data", 36); wave.writeUInt32LE(frames * 2, 40);
    for (let i = 0; i < frames; i++) {
      const t = i / sampleRate;
      const speaking = t >= 0.5 && t < 1.1 || t >= 2.1 && t < 2.7;
      wave.writeInt16LE(speaking ? Math.round(10_000 * Math.sin(2 * Math.PI * 440 * t)) : 0,
        44 + i * 2);
    }
    fs.writeFileSync(wavFile, wave);
    const ffmpegBin = hostBinary("ffmpeg");
    const ffprobeBin = hostBinary("ffprobe");
    const bashBin = hostBinary("bash");
    const mediaEnv = { ...childEnv,
      PATH: `${path.dirname(ffmpegBin)}:${path.dirname(ffprobeBin)}:${childEnv.PATH}` };

    // Narrator's installed speech gate must trim the synthetic lead/tail,
    // retain the long internal pause, and refuse an absent take.
    const narrator = await getSkill("higgsfield", "narrator");
    const metrics = await program(narrator, "scripts/speech_metrics.sh");
    const speech = await run(bashBin, [metrics.target, wavFile, "--json"],
      { cwd: wavWork, env: mediaEnv });
    assert.equal(speech.code, 0, speech.stderr);
    const speechValue = JSON.parse(speech.stdout);
    assert(speechValue.speech_start >= 0.4 && speechValue.speech_start <= 0.6);
    assert(speechValue.speech_end >= 2.6 && speechValue.speech_end <= 2.8);
    assert.equal(speechValue.pauses, 1);
    const noTake = await run(bashBin, [metrics.target, path.join(wavWork, "absent.wav"), "--json"],
      { cwd: wavWork, env: mediaEnv });
    assert.notEqual(noTake.code, 0);
    assert.match(noTake.stderr, /pass an audio file/u);
    cases.push({ id: narrator.id, scripts: [metrics],
      result: { speechStartSeconds: "~0.5", speechEndSeconds: "~2.7",
        internalPauses: 1, missingTakeRejected: true },
      boundary: "Synthetic PCM only; no TTS provider, voice cloning, or rendered video." });

    // GSAP's installed audio extractor performs real ffmpeg decode, RMS and
    // frequency-bin reduction over the same fixture; invalid band count fails.
    const gsap = await getSkill("hyperframes", "gsap");
    const audioProgram = await program(gsap, "scripts/extract-audio-data.py");
    const audioOutput = path.join(wavWork, "audio-data.json");
    const audioGood = await run(py, [audioProgram.target, wavFile,
      "--fps", "10", "--bands", "8", "-o", audioOutput],
    { cwd: wavWork, env: mediaEnv });
    assert.equal(audioGood.code, 0, audioGood.stderr);
    const audioValue = readJson(audioOutput);
    assert.equal(audioValue.totalFrames, 32);
    assert.equal(audioValue.frames[0].rms, 0);
    assert(audioValue.frames.some(frame => frame.rms > 0.9));
    assert(audioValue.frames.some(frame => frame.bands.some(value => value > 0.9)));
    const audioBad = await run(py, [audioProgram.target, wavFile, "--bands", "0"],
      { cwd: wavWork, env: mediaEnv });
    assert.notEqual(audioBad.code, 0);
    assert.match(audioBad.stderr, /--bands must be at least 1/u);
    cases.push({ id: gsap.id, scripts: [audioProgram],
      result: { frames: 32, bands: 8, silenceAndToneDistinguished: true,
        invalidBandCountRejected: true },
      boundary: "Synthetic audio data extraction only; no HyperFrames composition or rendering host." });
    clearWork(wavWork);

    // Android performance's installed report orchestration uses a local
    // Simpleperf protocol double. The real app/device capture is out of scope.
    const android = await getSkill("test-android-apps", "android-performance");
    const hotspotProgram = await program(android, "scripts/simpleperf_hotspots.sh");
    const androidWork = work("android-perf");
    try {
      const fakeBin = path.join(androidWork, "bin"); fs.mkdirSync(fakeBin);
      const fakeSimpleperf = path.join(fakeBin, "simpleperf");
      fs.writeFileSync(fakeSimpleperf, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'Simpleperf 1'; exit 0; fi\ncase " $* " in *' --csv '*) echo '2.00%,20.00%,app,1,1,liborbit.so,Orbit::draw'; exit 0;; esac\nprintf 'Overhead  Children  Command  Pid  Tid  Shared Object  Symbol\\n'\nprintf '2.00%%  20.00%%  app  1  1  liborbit.so  Orbit::draw\\n'\nprintf '1.00%%  4.00%%  system  2  2  libc.so  malloc\\n'\n`, { mode: 0o700 });
      const perf = path.join(androidWork, "perf.data"); fs.writeFileSync(perf, "synthetic-perf");
      const out = path.join(androidWork, "report");
      const good = await run(bashBin, [hotspotProgram.target, perf, out,
        "--first-party-regex", "Orbit::draw"],
      { cwd: androidWork, env: { ...childEnv, PATH: `${fakeBin}:${childEnv.PATH}` } });
      assert.equal(good.code, 0, good.stderr);
      assert.match(good.stdout, /Likely first-party rows:[\s\S]*Orbit::draw/u);
      assert(fs.readFileSync(path.join(out, "simpleperf-children.txt"), "utf8").includes("malloc"));
      assert(fs.existsSync(path.join(out, "simpleperf.csv")));
      const bad = await run(bashBin, [hotspotProgram.target,
        path.join(androidWork, "missing.perf"), out],
      { cwd: androidWork, env: { ...childEnv, PATH: `${fakeBin}:${childEnv.PATH}` } });
      assert.notEqual(bad.code, 0);
      assert.match(bad.stderr, /perf.data not found/u);
    } finally { clearWork(androidWork); }
    cases.push({ id: android.id, scripts: [hotspotProgram],
      result: { firstPartySymbol: "Orbit::draw", csvCreated: true,
        missingCaptureRejected: true },
      boundary: "Local Simpleperf protocol double; no Android device, profiler binary, or live trace." });

    // DCF's installed engine computes a bounded WACC/terminal scenario and
    // rejects the economically invalid growth >= discount-rate case.
    const dcf = await getSkill("public-equity-investing", "dcf-model-builder");
    const dcfCore = await program(dcf, "scripts/skill_core.py");
    const dcfValidation = await program(dcf, "scripts/plan_validation.py");
    const dcfProbe = `import importlib.util,json,sys\nfrom pathlib import Path\nsys.path.insert(0,str(Path(sys.argv[1]).parent))\nspec=importlib.util.spec_from_file_location('dcf_core',sys.argv[1])\nmod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)\np={'wacc':{'risk_free_rate':.04,'beta':1.2,'equity_risk_premium':.05,'pre_tax_cost_of_debt':.06,'marginal_tax_rate':.25,'target_debt_pct':.2,'target_equity_pct':.8},'scenarios':{'base':{'terminal_growth_rate':.02}},'terminal_value':{'method':'perpetual_growth'}}\nw=mod.compute_wacc(p)\nt=mod.compute_terminal_value(p,[{'cash_flow':10,'ebitda':20}],w['wacc'])\ntry: mod.compute_terminal_value(p,[{'cash_flow':10}],.01); bad=False\nexcept ValueError: bad=True\nprint(json.dumps({'wacc':w['wacc'],'terminal':t['terminal_value'],'badRejected':bad}))`;
    const dcfResult = await run(py, ["-c", dcfProbe, dcfCore.target],
      { cwd: root, env: childEnv });
    assert.equal(dcfResult.code, 0, dcfResult.stderr);
    const dcfValue = JSON.parse(dcfResult.stdout);
    assert(Math.abs(dcfValue.wacc - 0.089) < 1e-9);
    assert(Math.abs(dcfValue.terminal - 147.8260869565) < 1e-6);
    assert.equal(dcfValue.badRejected, true);
    cases.push({ id: dcf.id, scripts: [dcfCore, dcfValidation],
      result: { wacc: 0.089, terminalValue: "~147.826", invalidGrowthRejected: true },
      boundary: "Synthetic WACC and terminal slice, not a decision-grade DCF plan or live market model." });

    // Memo builder materializes a real HTML/DOCX pair plus an explicit
    // screen-grade manifest from frozen code; invalid output mode fails.
    const memo = await getSkill("public-equity-investing", "memo-builder");
    const memoProgram = await program(memo, "scripts/build_memo_package.py");
    const memoPackager = await resource(memo, "shared/artifact_packager.py");
    const memoOffice = await resource(memo, "shared/office_artifacts.py");
    const memoWork = work("memo");
    try {
      const input = path.join(memoWork, "input.json");
      fs.writeFileSync(input, JSON.stringify({ issuer: "Orbit Co", ticker: "ORBT",
        recommendation: "Synthetic hold for review",
        thesis_points: [{ point: "Recurring contracts", evidence_status: "Needs source review" }],
        risks: [{ risk: "Revenue concentration", mitigant: "Request segment data" }] }));
      const out = path.join(memoWork, "output");
      const good = await run(py, [memoProgram.target, "--input", input,
        "--output-dir", out, "--primary-format", "html", "--json"],
      { cwd: memoWork, env: childEnv });
      assert.equal(good.code, 0, good.stderr);
      assert.match(fs.readFileSync(path.join(out, "investment_memo.html"), "utf8"), /Recurring contracts/u);
      assert(fs.statSync(path.join(out, "investment_memo.docx")).size > 1000);
      const summary = JSON.parse(good.stdout);
      assert.equal(summary.primary_human_deliverable,
        path.join(out, "investment_memo.html"));
      assert.equal(readJson(summary.manifest).blocked_or_partial_status.status, "partial");
      const bad = await run(py, [memoProgram.target, "--input", input,
        "--output-dir", out, "--primary-format", "pdf"],
      { cwd: memoWork, env: childEnv });
      assert.notEqual(bad.code, 0);
      assert.match(bad.stderr, /invalid choice/u);
    } finally { clearWork(memoWork); }
    cases.push({ id: memo.id, scripts: [memoProgram, memoPackager, memoOffice],
      result: { htmlAndDocx: true, thesisIncluded: true, invalidFormatRejected: true },
      boundary: "Synthetic screen-grade memo only; no market data, source verification, or recommendation." });

    const runLifeProbe = async (state, relativePath, source, label, extraFiles = []) => {
      const retrieved = [await program(state, relativePath)];
      for (const other of extraFiles) retrieved.push(await program(state, other));
      const directory = work(label);
      try {
        const probe = `import importlib.util,json,sys\nfrom pathlib import Path\nsys.path.insert(0,str(Path(sys.argv[1]).parent))\nspec=importlib.util.spec_from_file_location('installed_skill',sys.argv[1])\nmod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)\n${source}`;
        const result = await run(py, ["-c", probe, retrieved[0].target],
          { cwd: directory, env: childEnv });
        assert.equal(result.code, 0, result.stderr);
        return { files: retrieved, value: JSON.parse(result.stdout) };
      } finally { clearWork(directory); }
    };

    // GTEx: resolve an installed variant path into a b38 query, preserve the
    // reported total and truncate the display set; invalid bounds fail.
    const gtex = await getSkill("life-science-research", "gtex-eqtl-skill");
    const gtexProbe = await runLifeProbe(gtex, "scripts/gtex_eqtl.py", String.raw`
import io
mod.resolve_query_variant=lambda **kwargs:{'input':{'type':'grch38','value':kwargs['input_value']},'query_variant':{'chr':'10','pos':112998590,'ref':'C','alt':'T'},'warnings':[]}
mod.fetch_eqtls=lambda variant_id:{'data':[{'geneSymbol':'TCF7L2','tissueSiteDetailId':'Pancreas'},{'geneSymbol':'TCF7L2','tissueSiteDetailId':'Liver'},{'geneSymbol':'TCF7L2','tissueSiteDetailId':'Brain'}],'paging_info':{'total':3}}
def call(payload):
 oldin,oldout=sys.stdin,sys.stdout
 sys.stdin,sys.stdout=io.StringIO(json.dumps(payload)),io.StringIO()
 try: code=mod.main(); value=json.loads(sys.stdout.getvalue())
 finally: sys.stdin,sys.stdout=oldin,oldout
 return {'code':code,'value':value}
print(json.dumps({'good':call({'grch38':'10-112998590-C-T','max_results':1}),'bad':call({'grch38':'10-112998590-C-T','max_results':0})}))`,
    "gtex", ["scripts/variant_resolution.py"]);
    assert.equal(gtexProbe.value.good.code, 0);
    assert.equal(gtexProbe.value.good.value.query_variant.variant_id, "chr10_112998590_C_T_b38");
    assert.equal(gtexProbe.value.good.value.eqtl_count_total, 3);
    assert.equal(gtexProbe.value.good.value.eqtl_count, 1);
    assert.equal(gtexProbe.value.good.value.truncated, true);
    assert.equal(gtexProbe.value.bad.value.error.code, "invalid_input");
    cases.push({ id: gtex.id, scripts: gtexProbe.files,
      result: { b38VariantId: "chr10_112998590_C_T_b38", totalEqtlRows: 3,
        displayRows: 1, invalidLimitRejected: true },
      boundary: "Local GTEx response double and deterministic variant resolution; no real GTEx request." });

    // Genebass: normalize Ensembl version and burden alias, enrich a returned
    // phenotype, and reject malformed IDs without touching the network.
    const genebass = await getSkill("life-science-research", "genebass-gene-burden-skill");
    const genebassProbe = await runLifeProbe(genebass,
      "scripts/genebass_gene_burden.py", String.raw`
import io
mod.fetch_gene_phewas=lambda gene,burden:('http://local.test/phewas/'+gene,{'gene':{'gene_id':gene,'symbol':'ORBT','name':'Orbit'},'phewas':[{'trait_type':'ICD','phenocode':'E11','pheno_sex':'both','coding':'x','modifier':'all','Pvalue':.001},{'trait_type':'ICD','phenocode':'I25','pheno_sex':'both','coding':'x','modifier':'all','Pvalue':.02}]},200)
mod.fetch_phenotypes_metadata=lambda:[{'analysis_id':'ICD-E11-both-x-all','description':'Synthetic diabetes'}]
def call(payload):
 oldin,oldout=sys.stdin,sys.stdout
 sys.stdin,sys.stdout=io.StringIO(json.dumps(payload)),io.StringIO()
 try: code=mod.main(); value=json.loads(sys.stdout.getvalue())
 finally: sys.stdin,sys.stdout=oldin,oldout
 return {'code':code,'value':value}
print(json.dumps({'good':call({'gene_id':'ensg00000173531.4','burden_set':'lof','max_results':1}),'bad':call({'gene_id':'not-a-gene'})}))`,
    "genebass");
    assert.equal(genebassProbe.value.good.value.input.value, "ENSG00000173531");
    assert.equal(genebassProbe.value.good.value.burden_set, "pLoF");
    assert.equal(genebassProbe.value.good.value.association_count_total, 2);
    assert.equal(genebassProbe.value.good.value.associations[0].phenotype_description,
      "Synthetic diabetes");
    assert.equal(genebassProbe.value.bad.value.error.code, "invalid_input");
    cases.push({ id: genebass.id, scripts: genebassProbe.files,
      result: { canonicalGeneId: "ENSG00000173531", burdenSet: "pLoF",
        enrichedPhenotype: "Synthetic diabetes", malformedIdRejected: true },
      boundary: "Local PheWAS and phenotype doubles; no Genebass API or clinical interpretation." });

    // eQTL Catalogue: the installed client backfills service-required filters,
    // preserves association records and exposes upstream validation errors.
    const eqtl = await getSkill("life-science-research", "eqtl-catalogue-skill");
    const eqtlProbe = await runLifeProbe(eqtl, "scripts/rest_request.py", String.raw`
seen=[]
class Response:
 status_code=200
 headers={'content-type':'application/json'}
 text='{"associations":[{"variant_id":"rs1","gene_id":"ENSG1"},{"variant_id":"rs2","gene_id":"ENSG2"}]}'
 def raise_for_status(self): pass
 def json(self): return json.loads(self.text)
class Session:
 def __init__(self): self.headers={}
 def request(self,method,url,**kwargs): seen.append(kwargs['params']); return Response()
 def close(self): pass
mod.requests.Session=Session
base={'base_url':'https://www.ebi.ac.uk/eqtl/api','path':'genes/ENSG1/associations','params':{'variant_id':'rs1'},'record_path':'associations','max_items':1}
good=mod.execute(base)
bad=mod.execute({**base,'record_path':'associations.9'})
print(json.dumps({'good':good,'bad':bad,'params':seen[0]}))`, "eqtl");
    assert.equal(eqtlProbe.value.good.ok, true);
    assert.equal(eqtlProbe.value.good.record_count_available, 2);
    assert.equal(eqtlProbe.value.good.records[0].variant_id, "rs1");
    assert.equal(eqtlProbe.value.params.snp, "rs1");
    assert.equal(eqtlProbe.value.params.quant_method, "ge");
    assert.equal(eqtlProbe.value.bad.error.code, "invalid_response");
    cases.push({ id: eqtl.id, scripts: eqtlProbe.files,
      result: { defaultSnp: "rs1", quantMethod: "ge", associationsAvailable: 2,
        invalidSelectorRejected: true },
      boundary: "Local eQTL Catalogue response double; no live association evidence." });

    // AlphaFold generic compact client is exercised with a structure-list
    // response and an invalid selector; this is intentionally only a slice.
    const alpha = await getSkill("life-science-research", "alphafold-skill");
    const alphaProbe = await runLifeProbe(alpha, "scripts/rest_request.py", String.raw`
class Response:
 status_code=200
 headers={'content-type':'application/json'}
 text='[{"entryId":"AF-P12345-F1","uniprotAccession":"P12345","avgLocalConfidence":90.1},{"entryId":"AF-P12345-F2","uniprotAccession":"P12345","avgLocalConfidence":75.3}]'
 def raise_for_status(self): pass
 def json(self): return json.loads(self.text)
class Session:
 def __init__(self): self.headers={}
 def request(self,*args,**kwargs): return Response()
 def close(self): pass
mod.requests.Session=Session
base={'base_url':'https://alphafold.ebi.ac.uk/api','path':'prediction/P12345','max_items':1}
good=mod.execute(base)
bad=mod.execute({**base,'record_path':'9'})
print(json.dumps({'good':good,'bad':bad}))`, "alphafold");
    assert.equal(alphaProbe.value.good.ok, true);
    assert.equal(alphaProbe.value.good.record_count_available, 2);
    assert.equal(alphaProbe.value.good.records[0].entryId, "AF-P12345-F1");
    assert.equal(alphaProbe.value.good.truncated, true);
    assert.equal(alphaProbe.value.bad.error.code, "invalid_response");
    cases.push({ id: alpha.id, scripts: alphaProbe.files,
      result: { structureId: "AF-P12345-F1", availableModels: 2,
        displayModels: 1, invalidSelectorRejected: true },
      boundary: "Local AlphaFold-shaped metadata only; no prediction download or protein-structure judgment." });

    // Open Targets: installed heatmap groups and orders datasource scores over
    // two deterministic pages; invalid page size fails before remote use.
    const targets = await getSkill("life-science-research", "opentargets-skill");
    const targetsProbe = await runLifeProbe(targets,
      "scripts/opentargets_disease_heatmap.py", String.raw`
def page(gene,size,index):
 rows=[{'disease':{'id':'EFO1','name':'Pancreatic cancer'},'datasourceScores':[{'id':'chembl','score':.7},{'id':'ot_genetics_portal','score':.9}]},{'disease':{'id':'EFO2','name':'Asthma'},'datasourceScores':[{'id':'reactome','score':.6}]}]
 return {'id':gene,'approvedSymbol':'ORBT','associatedDiseases':{'count':2,'rows':rows[index:index+size]}}
mod.fetch_page=page
good=mod.execute({'ensembl_id':'ENSG1','page_size':1,'max_pages':2,'disease_name_filter':'cancer'})
try: mod.parse_input({'ensembl_id':'ENSG1','page_size':0}); rejected=False
except ValueError: rejected=True
print(json.dumps({'good':good,'badRejected':rejected}))`, "targets");
    assert.equal(targetsProbe.value.good.ok, true);
    assert.equal(targetsProbe.value.good.summary.pages_fetched, 2);
    assert.equal(targetsProbe.value.good.summary.returned_rows, 1);
    assert.deepEqual(targetsProbe.value.good.matrix.columns.map(row => row.id),
      ["ot_genetics_portal", "chembl"]);
    assert.equal(targetsProbe.value.badRejected, true);
    cases.push({ id: targets.id, scripts: targetsProbe.files,
      result: { pages: 2, filteredDisease: "Pancreatic cancer",
        orderedDatasources: ["ot_genetics_portal", "chembl"], invalidPageSizeRejected: true },
      boundary: "Local GraphQL page double; no Open Targets API or clinical interpretation." });

    // BLAST: installed Common URL protocol parser extracts RID/RTOE and
    // distinguishes malformed submission responses without making a request.
    const blast = await getSkill("life-science-research", "ncbi-blast-skill");
    const blastProbe = await runLifeProbe(blast, "scripts/ncbi_blast.py", String.raw`
config=mod.parse_input({'action':'submit','program':'blastp','database':'nr','query_fasta':'>q\nMTEYK','email':'test@example.invalid'})
class Response:
 def __init__(self,text): self.text=text
 def raise_for_status(self): pass
class Session:
 def __init__(self,text): self.text=text; self.seen=None
 def request(self,method,url,**kwargs): self.seen=kwargs['data']; return Response(self.text)
goodSession=Session('RID = TEST123\nRTOE = 12\n')
good=mod.submit_search(goodSession,mod.RequestThrottle(min_interval_sec=0),config)
try: mod.submit_search(Session('No RID'),mod.RequestThrottle(min_interval_sec=0),config); rejected=False
except ValueError: rejected=True
print(json.dumps({'good':good,'program':goodSession.seen['PROGRAM'],'badRejected':rejected}))`,
    "blast");
    assert.equal(blastProbe.value.good.rid, "TEST123");
    assert.equal(blastProbe.value.good.rtoe_seconds, 12);
    assert.equal(blastProbe.value.program, "blastp");
    assert.equal(blastProbe.value.badRejected, true);
    cases.push({ id: blast.id, scripts: blastProbe.files,
      result: { program: "blastp", rid: "TEST123", rtoeSeconds: 12,
        missingRidRejected: true },
      boundary: "Local BLAST protocol double; no NCBI job submission or sequence result." });
    if (process.env.SG_SKILL_TRACE) console.error("fourth-cohort: disable-start", cases.length);
    for (const [packageId, installed] of installations) {
      if (process.env.SG_SKILL_TRACE) console.error("fourth-cohort: disable", packageId);
      await rpc("plugins.installations.set", { installationId: installed.installationId,
        desiredState: "disabled", expectedRevision: installed.revision,
        operationId: `frozen-fourth-disable-${packageId}` });
    }
    if (process.env.SG_SKILL_TRACE) console.error("fourth-cohort: invisibility-check");
    for (const state of skills.values()) {
      if (process.env.SG_SKILL_TRACE) console.error("fourth-cohort: invisible", state.id);
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
    const thirdEvidence = readJson(path.join(__dirname,
      "../docs/architecture/plugin-frozen-skill-third-cohort-evidence-2026-09-27.json"));
    const priorIds = ["superpowers/systematic-debugging",
      ...breadthEvidence.acceptedTopLevelSkillIds,
      ...expansionEvidence.newlyAcceptedTopLevelSkillIds,
      ...nextEvidence.newlyAcceptedTopLevelSkillIds,
      ...thirdEvidence.newlyAcceptedTopLevelSkillIds];
    assert.equal(priorIds.length, 43);
    const acceptedIds = cases.map(item => item.id);
    assert.equal(cases.length, 11);
    assert.equal(new Set([...priorIds, ...acceptedIds]).size, 54,
      "new business cases duplicate earlier cases");
    assert(acceptedIds.every(id => inventoryById.has(id)),
      "case includes a missing or non-top-level Skill");
    const evidence = { schemaVersion: 1,
      candidateGapsNotAccepted: [{ id: "nvidia/aiq-research", reason: "Native Runtime ineligible because installed Skill declares a network host capability unavailable to isolated fixture; no AI-Q host or query executed." }],
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
      "../docs/architecture/plugin-frozen-skill-fourth-cohort-evidence-2026-09-27.json");
    if (writeEvidence) fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    else assert.deepEqual(readJson(evidencePath), evidence,
      "fourth-cohort evidence drifted; rerun with --write-evidence only after reviewing changed results");
    console.log("plugin-frozen-skill-fourth-cohort-fixture: ok",
      JSON.stringify({ newCases: acceptedIds.length, cumulative: priorIds.length + acceptedIds.length,
        remaining: inventory.skills.length - priorIds.length - acceptedIds.length }));
  } finally {
    try { await service?.stop(); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
