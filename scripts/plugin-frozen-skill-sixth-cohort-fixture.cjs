#!/usr/bin/env node
"use strict";

// A bounded, offline business slice of one frozen Skill. Both Python files
// come from an opted-in installation through the production OpenClaw adapter.
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
const { hasSecret } = require("../app/agent-service/memory-engine");

const SHA256 = value => crypto.createHash("sha256").update(value).digest("hex");
const body = value => value.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "");
const PACKAGE_ID = "life-science-research";
const SKILL_NAME = "locus-to-gene-mapper-skill";
const SKILL_ID = `${PACKAGE_ID}/${SKILL_NAME}`;
const PROGRAM = "scripts/map_locus_to_gene.py";
const TEST_PROGRAM = "scripts/test_map_locus_to_gene.py";

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

async function main() {
  const writeEvidence = process.argv.slice(2).includes("--write-evidence");
  assert(process.argv.slice(2).every(arg => arg === "--write-evidence"),
    "usage: node scripts/plugin-frozen-skill-sixth-cohort-fixture.cjs [--write-evidence]");
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-skill-sixth-cohort-"));
  const paths = resolveServicePaths({ homeDir: root,
    userDataRoot: path.join(root, "service"), stateRoot: path.join(root, "service", "shoggoth-core"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const catalog = new BundledPluginCatalog(bundledRoot());
  let service;
  try {
    const credential = ensureCredential(paths, "openclaw");
    service = createAgentService({ paths, prewarmMcpAuth: false, parentEnv: {},
      externalPluginAgentVerifier: async identity => ({ id: identity.agentId,
        backendId: identity.backendId }), version: "frozen-skill-sixth-cohort-fixture" });
    await service.start();
    const rpc = (method, params) => requestService(paths, {
      token: readClientToken(paths), version: SERVICE_PROTOCOL_VERSION, method, params,
    }, { timeoutMs: 15_000 });
    const externalRpc = (method, params, options = {}) => requestService(paths, {
      version: SERVICE_PROTOCOL_VERSION, method, params,
    }, { timeoutMs: options.timeoutMs || 10_000, signal: options.signal });
    const { createAdapter } = await import(pathToFileURL(path.join(__dirname,
      "../resources/external-plugin-adapters/openclaw/index.mjs")).href);
    const adapter = createAdapter({ instanceId: "frozen-skill-sixth-cohort-fixture",
      credential: () => credential,
      requestService: (method, params, options) => externalRpc(method, params, options) });
    let calls = 0;
    const invoke = async (toolName, args) => {
      const context = { agentId: "frozen-sixth-agent", sessionId: "frozen-sixth-session",
        runId: "frozen-sixth-run" };
      const toolCallId = `frozen-sixth-${++calls}`;
      assert.equal(adapter.beforeToolCall({ toolName, toolCallId,
        runId: context.runId }, context), undefined);
      return (await adapter.tool(toolName, context).execute(toolCallId, args)).details;
    };
    const search = async () => (await invoke("shoggoth_capability_search", {
      query: SKILL_NAME })).items.filter(item => item.name === SKILL_NAME && item.source === "plugin");
    const read = async (toolName, args) => {
      let cursor = 0;
      let content = "";
      let digest = null;
      let pages = 0;
      do {
        const page = await invoke(toolName, { ...args, cursor });
        const nextDigest = page.fileHash || page.contentHash;
        if (digest !== null) assert.equal(nextDigest, digest);
        digest = nextDigest;
        content += page.content;
        pages += 1;
        assert(pages <= 64, "Skill read exceeded bounded page count");
        cursor = page.nextCursor;
      } while (cursor !== null);
      assert.equal(SHA256(content), digest);
      return { content, digest, pages };
    };

    assert.equal((await search()).length, 0, "Skill visible before opt-in");
    const frozen = catalog.assertCurrent(PACKAGE_ID);
    assert.equal(frozen.importStatus, "previewable");
    const source = { kind: "bundled", packageId: PACKAGE_ID };
    const preview = await rpc("plugins.install.preview", { source });
    assert(preview.installable);
    const installed = (await rpc("plugins.install", { source,
      previewDigest: preview.previewDigest, expectedRevision: preview.expectedRevision,
      operationId: "frozen-sixth-install" })).installation;
    assert.equal(installed.desiredState, "enabled");
    const found = await search();
    assert.equal(found.length, 1);
    const skillId = found[0].id;
    const profile = service.productStore.listAgentProfiles().find(item => item.enabled);
    assert(profile);
    const nativeSkill = service.runtimeSkillStore.catalog(profile.id).items.find(item => item.id === skillId);
    assert(nativeSkill);
    const instruction = await read("shoggoth_skill_read", { skillId });
    assert.equal(service.runtimeSkillStore.read({ profileId: profile.id,
      name: nativeSkill.name, contentHash: nativeSkill.contentHash }).content, instruction.content);
    const sourceInstruction = fs.readFileSync(path.join(bundledRoot(), "packages",
      PACKAGE_ID, "skills", SKILL_NAME, "SKILL.md"), "utf8");
    assert.equal(body(instruction.content), body(sourceInstruction));
    const mirror = path.join(root, "mirror", "scripts");
    fs.mkdirSync(mirror, { recursive: true });
    const files = [];
    for (const relativePath of [PROGRAM, TEST_PROGRAM]) {
      const original = fs.readFileSync(path.join(bundledRoot(), "packages", PACKAGE_ID,
        "skills", SKILL_NAME, relativePath), "utf8");
      const retrieved = await read("shoggoth_skill_file_read", { skillId, relativePath });
      assert.equal(retrieved.content, original, `installed file changed: ${relativePath}`);
      const destination = path.join(mirror, path.basename(relativePath));
      fs.writeFileSync(destination, retrieved.content, { mode: 0o700 });
      files.push({ relativePath, sha256: retrieved.digest, pages: retrieved.pages });
    }
    const program = fs.readFileSync(path.join(mirror, path.basename(PROGRAM)), "utf8");
    assert.equal(hasSecret(program), false, "exact frozen program must pass scanner");
    assert.equal(hasSecret(`${program}\npassword = "syntheticfallback123"\n`), true,
      "an added literal credential must remain rejected");
    const python = fs.realpathSync(execFileSync("/usr/bin/which", ["python3"],
      { encoding: "utf8", timeout: 5_000 }).trim());
    const version = /^Python (\d+)\.(\d+)/u.exec(execFileSync(python,
      ["--version"], { encoding: "utf8", timeout: 5_000 }));
    assert(version && (Number(version[1]) > 3 || Number(version[1]) === 3 && Number(version[2]) >= 10));
    const tmp = path.join(root, "child-tmp");
    fs.mkdirSync(tmp, { mode: 0o700 });
    const env = { HOME: root, TMPDIR: tmp, LANG: "C", LC_ALL: "C",
      PATH: `${path.dirname(python)}:/usr/bin:/bin`, PYTHONNOUSERSITE: "1",
      PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: "", OPT_OUT_INSTRUMENTATION: "true" };
    const selfTest = await run(python, [path.join(mirror, path.basename(TEST_PROGRAM))],
      { cwd: root, env });
    assert.equal(selfTest.code, 0, selfTest.stderr + selfTest.stdout);
    assert.match(selfTest.stderr, /Ran 3 tests/u);
    const businessProbe = String.raw`import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('installed_skill',sys.argv[1])
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
print(json.dumps({
 'effect_allele':mod.parse_rsid_from_association({'snp_effect_allele':['rs7903146-A']}),
 'missing_rsid':mod.parse_rsid_from_association({'snp_effect_allele':['unknown allele']}),
 'invalid_rsid':mod.normalize_rsid('not-a-variant')
}))`;
    const probe = await run(python, ["-c", businessProbe, path.join(mirror,
      path.basename(PROGRAM))], { cwd: root, env });
    assert.equal(probe.code, 0, probe.stderr + probe.stdout);
    const result = JSON.parse(probe.stdout);
    assert.deepEqual(result, { effect_allele: "rs7903146", missing_rsid: null, invalid_rsid: null });
    await rpc("plugins.installations.set", { installationId: installed.installationId,
      desiredState: "disabled", expectedRevision: installed.revision,
      operationId: "frozen-sixth-disable" });
    assert.equal((await search()).filter(item => item.id === skillId).length, 0);
    assert(!service.runtimeSkillStore.catalog(profile.id).items.some(item => item.id === skillId));

    const previous = JSON.parse(fs.readFileSync(path.join(__dirname,
      "../docs/architecture/plugin-frozen-skill-fifth-cohort-evidence-2026-09-27.json"), "utf8"));
    assert.equal(previous.cumulativeBoundedLocalBusinessSkills, 57);
    assert.equal(previous.batchDigest, catalog.batchDigest);
    assert(!previous.newlyAcceptedTopLevelSkillIds.includes(SKILL_ID));
    const inventory = JSON.parse(fs.readFileSync(path.join(__dirname,
      "../docs/architecture/bundled-skill-dependency-inventory-2026-09-27.json"), "utf8"));
    assert.equal(inventory.source.batchDigest, catalog.batchDigest);
    assert.equal(inventory.skills.length, 502);
    assert(inventory.skills.some(item => item.id === SKILL_ID));
    const evidence = { schemaVersion: 1, id: SKILL_ID,
      batchDigest: catalog.batchDigest, sourceDigest: frozen.sourceDigest,
      installedReleaseDigest: installed.releaseDigest,
      host: "OpenClaw production adapter over isolated Service IPC",
      mode: "source; no packaging or installed App",
      priorAcceptedTopLevelSkills: previous.cumulativeBoundedLocalBusinessSkills,
      cumulativeBoundedLocalBusinessSkills: 58,
      remainingTopLevelSkillsWithoutBoundedLocalCase: 444,
      instructionSha256: instruction.digest, instructionPages: instruction.pages,
      files, result: { ...result, offlineFrozenSelfTests: 3,
        nativeFacadeRead: true, disabledSkillInvisible: true,
        appendedLiteralCredentialRejected: true },
      boundary: "Synthetic RefSNP payload and GWAS parser only; no live GWAS lookup, biological conclusion, or installed App evidence.",
      externalAccountUsed: false, realAgentOrModelUsed: false, installedAppUsed: false };
    const evidencePath = path.join(__dirname,
      "../docs/architecture/plugin-frozen-skill-sixth-cohort-evidence-2026-09-27.json");
    if (writeEvidence) fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    else assert.deepEqual(JSON.parse(fs.readFileSync(evidencePath, "utf8")), evidence,
      "sixth-cohort evidence drifted; rerun with --write-evidence after review");
    console.log("plugin-frozen-skill-sixth-cohort-fixture: ok",
      JSON.stringify({ newCases: 1, cumulative: 58, remaining: 444 }));
  } finally {
    try { await service?.stop(); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
