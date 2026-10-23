#!/usr/bin/env node
"use strict";

// Bounded, deterministic business exercises for three further frozen top-level
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
    "usage: node scripts/plugin-frozen-skill-fifth-cohort-fixture.cjs [--write-evidence]");
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-skill-fifth-cohort-"));
  const paths = resolveServicePaths({ homeDir: root,
    userDataRoot: path.join(root, "service"), stateRoot: path.join(root, "service", "shoggoth-core"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const catalog = new BundledPluginCatalog(bundledRoot());
  let service;
  try {
    const credentialToken = ensureCredential(paths, "openclaw");
    service = createAgentService({ paths, prewarmMcpAuth: false, parentEnv: {},
      externalPluginAgentVerifier: async identity => ({ id: identity.agentId,
        backendId: identity.backendId }), version: "frozen-skill-fifth-cohort-fixture" });
    await service.start();
    const rpc = (method, params) => requestService(paths, {
      token: readClientToken(paths), version: SERVICE_PROTOCOL_VERSION, method, params,
    }, { timeoutMs: 15_000 });
    const externalRpc = (method, params, options = {}) => requestService(paths, {
      version: SERVICE_PROTOCOL_VERSION, method, params,
    }, { timeoutMs: options.timeoutMs || 10_000, signal: options.signal });
    const { createAdapter } = await import(pathToFileURL(path.join(__dirname,
      "../resources/external-plugin-adapters/openclaw/index.mjs")).href);
    const adapter = createAdapter({ instanceId: "frozen-skill-fifth-cohort-fixture",
      credential: () => credentialToken,
      requestService: (method, params, options) => externalRpc(method, params, options) });
    let callNumber = 0;
    const invoke = async (name, args) => {
      const toolCallId = `frozen-skill-fifth-${++callNumber}`;
      const context = { agentId: "frozen-fifth-agent", sessionId: "frozen-fifth-session",
        runId: "frozen-fifth-run" };
      assert.equal(adapter.beforeToolCall({ toolName: name, toolCallId,
        runId: context.runId }, context), undefined);
      try { return (await adapter.tool(name, context).execute(toolCallId, args)).details; }
      catch (error) { if (process.env.SG_SKILL_TRACE) console.error("fifth-cohort: tool-error", callNumber, name, args, error.code); throw error; }
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
          operationId: `frozen-fifth-install-${packageId}` })).installation;
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

    // Model audit: the installed inspector must identify formulas, a volatile
    // function, a hardcoded assumption and a missing review cover in a tiny
    // synthetic workbook. It rejects unsupported input formats.
    const audit = await getSkill("public-equity-investing", "model-audit-tieout");
    const auditProgram = await program(audit, "scripts/audit_workbook.py");
    const auditShared = await resource(audit, "shared/artifact_packager.py");
    const auditWork = work("model-audit");
    try {
      const workbook = path.join(auditWork, "model.xlsx");
      const make = await run(py, ["-c", String.raw`from openpyxl import Workbook
import sys
w=Workbook(); ws=w.active; ws.title='Model'
ws['A1']='Revenue'; ws['A2']=100; ws['B2']='=A2*17'
ws['C2']='=NOW()'; ws['D2']="='[external.xlsx]Inputs'!A1"
w.save(sys.argv[1])`, workbook], { cwd: auditWork, env: childEnv });
      assert.equal(make.code, 0, make.stderr);
      const out = path.join(auditWork, "audit");
      const good = await run(py, [auditProgram.target, workbook, "--out-dir", out],
        { cwd: auditWork, env: childEnv });
      assert.equal(good.code, 0, good.stderr + good.stdout);
      const findings = readJson(path.join(out, "logs", "model_audit_findings.json"));
      assert.equal(findings.summary.formula_cells, 3);
      assert(findings.formula_exceptions.some(row => row.volatile_functions.includes("NOW")));
      assert(findings.formula_exceptions.some(row => row.hardcoded_numbers.includes("17")));
      assert(findings.issues.some(row => row.category === "presentation_readiness"));
      assert(fs.existsSync(path.join(out, "model_audit_report.html")));
      const unsupported = path.join(auditWork, "input.csv");
      fs.writeFileSync(unsupported, "revenue\n100\n");
      const bad = await run(py, [auditProgram.target, unsupported,
        "--out-dir", path.join(auditWork, "bad")],
      { cwd: auditWork, env: childEnv });
      assert.equal(bad.code, 1);
      assert.match(bad.stderr, /only \.xlsx and \.xlsm files are supported/u);
    } finally { clearWork(auditWork); }
    cases.push({ id: audit.id, scripts: [auditProgram, auditShared],
      result: { formulaCells: 3, volatileNow: true, hardcoded17: true,
        missingReviewCover: true, unsupportedFormatRejected: true },
      boundary: "Synthetic workbook static scan only; formulas were not recalculated or sourced to a filing." });

    // Three-statement plan validation consumes its own frozen template through
    // an installed read, then rejects a source dated after the valuation date.
    const statements = await getSkill("public-equity-investing",
      "three-statement-model-builder");
    const statementValidator = await program(statements, "scripts/validate_plan.py");
    const statementTemplate = await program(statements, "assets/plan_template.json");
    const statementWork = work("three-statement");
    try {
      const plan = path.join(statementWork, "plan.json");
      const data = readJson(statementTemplate.target);
      fs.writeFileSync(plan, `${JSON.stringify(data)}\n`);
      const good = await run(py, [statementValidator.target, plan],
        { cwd: statementWork, env: childEnv });
      assert.equal(good.code, 0, good.stderr + good.stdout);
      assert.match(good.stdout, /Plan validation OK/u);
      data.source_basis[0].as_of_date = "2027-01-01";
      fs.writeFileSync(plan, `${JSON.stringify(data)}\n`);
      const bad = await run(py, [statementValidator.target, plan],
        { cwd: statementWork, env: childEnv });
      assert.equal(bad.code, 1);
      assert.match(bad.stderr, /cannot be after meta.as_of_date/u);
    } finally { clearWork(statementWork); }
    cases.push({ id: statements.id, scripts: [statementValidator, statementTemplate],
      result: { frozenTemplateAccepted: true, futureSourceDateRejected: true },
      boundary: "Plan contract only; no forecast workbook built or reported figures verified." });

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

    // FinnGen: freeze variant resolution and API responses locally, retaining
    // association truncation and a distinct 404 absence signal.
    const finngen = await getSkill("life-science-research", "finngen-phewas-skill");
    const finngenProbe = await runLifeProbe(finngen,
      "scripts/finngen_phewas.py", String.raw`
import io
mod.resolve_query_variant=lambda **kwargs:{'input':{'type':'grch38','value':kwargs['input_value']},'query_variant':{'canonical':'10-112998590-C-T'},'warnings':[]}
def fetch(session,variant,timeout):
 if variant=='absent': return None,404
 return {'variant':{'id':variant},'results':[{'trait':'T2D','pvalue':.001},{'trait':'CAD','pvalue':.02}]},200
mod.fetch_finngen_variant=fetch
def call(payload):
 oldin,oldout=sys.stdin,sys.stdout
 sys.stdin,sys.stdout=io.StringIO(json.dumps(payload)),io.StringIO()
 try: code=mod.main(); value=json.loads(sys.stdout.getvalue())
 finally: sys.stdin,sys.stdout=oldin,oldout
 return {'code':code,'value':value}
good=call({'grch38':'10-112998590-C-T','max_results':1})
bad=call({'grch38':'10-112998590-C-T','max_results':0})
mod.resolve_query_variant=lambda **kwargs:{'input':{'type':'grch38','value':kwargs['input_value']},'query_variant':{'canonical':'absent'},'warnings':[]}
missing=call({'grch38':'10-112998590-C-T'})
print(json.dumps({'good':good,'bad':bad,'missing':missing}))`,
    "finngen", ["scripts/variant_resolution.py"]);
    assert.equal(finngenProbe.value.good.value.association_count_total, 2);
    assert.equal(finngenProbe.value.good.value.association_count, 1);
    assert.equal(finngenProbe.value.good.value.truncated, true);
    assert.equal(finngenProbe.value.bad.value.error.code, "invalid_input");
    assert.equal(finngenProbe.value.missing.value.association_count, 0);
    assert.match(finngenProbe.value.missing.value.warnings[0], /HTTP 404/u);
    cases.push({ id: finngen.id, scripts: finngenProbe.files,
      result: { availableAssociations: 2, returnedAssociations: 1,
        invalidLimitRejected: true, missingVariantDisclosed: true },
      boundary: "Local FinnGen response double; no live PheWAS lookup or biological conclusion." });

    if (process.env.SG_SKILL_TRACE) console.error("fifth-cohort: disable-start", cases.length);
    for (const [packageId, installed] of installations) {
      if (process.env.SG_SKILL_TRACE) console.error("fifth-cohort: disable", packageId);
      await rpc("plugins.installations.set", { installationId: installed.installationId,
        desiredState: "disabled", expectedRevision: installed.revision,
        operationId: `frozen-fifth-disable-${packageId}` });
    }
    if (process.env.SG_SKILL_TRACE) console.error("fifth-cohort: invisibility-check");
    for (const state of skills.values()) {
      if (process.env.SG_SKILL_TRACE) console.error("fifth-cohort: invisible", state.id);
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
    const fourthEvidence = readJson(path.join(__dirname,
      "../docs/architecture/plugin-frozen-skill-fourth-cohort-evidence-2026-09-27.json"));
    const priorIds = ["superpowers/systematic-debugging",
      ...breadthEvidence.acceptedTopLevelSkillIds,
      ...expansionEvidence.newlyAcceptedTopLevelSkillIds,
      ...nextEvidence.newlyAcceptedTopLevelSkillIds,
      ...thirdEvidence.newlyAcceptedTopLevelSkillIds,
      ...fourthEvidence.newlyAcceptedTopLevelSkillIds];
    assert.equal(priorIds.length, 54);
    const acceptedIds = cases.map(item => item.id);
    assert.equal(cases.length, 3);
    assert.equal(new Set([...priorIds, ...acceptedIds]).size, 57,
      "new business cases duplicate earlier cases");
    assert(acceptedIds.every(id => inventoryById.has(id)),
      "case includes a missing or non-top-level Skill");
    const evidence = { schemaVersion: 1,
      candidateGapsNotAccepted: [
        { id: "public-equity-investing/earnings-preview", reason: "Frozen intake pipeline needs pandas plus python-dateutil; the isolated no-user-site Python has pandas but lacks dateutil, so no business case was counted or dependency installed." },
        { id: "life-science-research/locus-to-gene-mapper-skill", reason: "Installed file read fails closed because hasSecret flags the harmless parser expression token = str(effect[0]); no scanner exception was added and no business case counted." },
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
      "../docs/architecture/plugin-frozen-skill-fifth-cohort-evidence-2026-09-27.json");
    if (writeEvidence) fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    else assert.deepEqual(readJson(evidencePath), evidence,
      "fifth-cohort evidence drifted; rerun with --write-evidence only after reviewing changed results");
    console.log("plugin-frozen-skill-fifth-cohort-fixture: ok",
      JSON.stringify({ newCases: acceptedIds.length, cumulative: priorIds.length + acceptedIds.length,
        remaining: inventory.skills.length - priorIds.length - acceptedIds.length }));
  } finally {
    try { await service?.stop(); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
