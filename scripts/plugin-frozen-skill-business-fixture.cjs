#!/usr/bin/env node
"use strict";

// Run one frozen bundled Skill's real local workflow through the production
// OpenClaw adapter and an isolated Shoggoth Service. No user Service data or
// external account is involved.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createAgentService } = require("../app/agent-service/server");
const { readClientToken, requestService } = require("../app/agent-service/client");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const { ensureCredential } = require("../app/agent-service/external-plugin-adapter-auth");
const { BundledPluginCatalog, bundledRoot } = require("../app/core/bundled-plugin-catalog");

const PACKAGE_ID = "superpowers";
const SKILL_NAME = "systematic-debugging";
const HELPER = "find-polluter.sh";
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");

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
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-skill-business-"));
  const paths = resolveServicePaths({ homeDir: root,
    userDataRoot: path.join(root, "service"), stateRoot: path.join(root, "service", "shoggoth-core"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const catalog = new BundledPluginCatalog(bundledRoot());
  let service;
  try {
    const frozen = catalog.assertCurrent(PACKAGE_ID);
    assert.equal(frozen.importStatus, "previewable");
    const sourceSkillPath = path.join(bundledRoot(), "packages", PACKAGE_ID,
      "skills", SKILL_NAME, "SKILL.md");
    const sourceHelperPath = path.join(path.dirname(sourceSkillPath), HELPER);
    const sourceSkillText = fs.readFileSync(sourceSkillPath, "utf8");
    const sourceSkillSha256 = sha256(sourceSkillText);
    const expectedHelperSha256 = sha256(fs.readFileSync(sourceHelperPath));
    const credentialToken = ensureCredential(paths, "openclaw");
    service = createAgentService({ paths, prewarmMcpAuth: false, parentEnv: {},
      externalPluginAgentVerifier: async identity => ({ id: identity.agentId,
        backendId: identity.backendId }), version: "frozen-skill-business-fixture" });
    await service.start();
    const rpc = (method, params, options = {}) => requestService(paths, {
      token: readClientToken(paths), version: SERVICE_PROTOCOL_VERSION, method, params,
    }, { timeoutMs: options.timeoutMs || 10_000, signal: options.signal });
    const externalRpc = (method, params, options = {}) => requestService(paths, {
      version: SERVICE_PROTOCOL_VERSION, method, params,
    }, { timeoutMs: options.timeoutMs || 10_000, signal: options.signal });
    const { createAdapter } = await import(pathToFileURL(path.join(__dirname,
      "../resources/external-plugin-adapters/openclaw/index.mjs")).href);
    const adapter = createAdapter({ instanceId: "frozen-skill-business-fixture",
      credential: () => credentialToken,
      requestService: (method, params, options) => externalRpc(method, params, options) });
    let callNumber = 0;
    const invoke = async (name, args) => {
      const toolCallId = `frozen-skill-business-${++callNumber}`;
      const context = { agentId: "frozen-skill-agent", sessionId: "frozen-skill-session",
        runId: "frozen-skill-run" };
      assert.equal(adapter.beforeToolCall({ toolName: name, toolCallId,
        runId: context.runId }, context), undefined);
      return (await adapter.tool(name, context).execute(toolCallId, args)).details;
    };
    const search = () => invoke("shoggoth_capability_search", { query: SKILL_NAME });
    assert.equal((await search()).items.filter(item => item.name === SKILL_NAME).length, 0,
      "the frozen package must be absent before opt-in installation");

    const source = { kind: "bundled", packageId: PACKAGE_ID };
    const preview = await rpc("plugins.install.preview", { source });
    assert(preview.installable);
    const previewSkill = preview.components.skills.find(item => item.name === SKILL_NAME);
    assert(previewSkill);
    const installed = (await rpc("plugins.install", { source,
      previewDigest: preview.previewDigest, expectedRevision: preview.expectedRevision,
      operationId: "frozen-skill-business-install" })).installation;
    assert.equal(installed.desiredState, "enabled");
    const found = (await search()).items.filter(item => item.name === SKILL_NAME
      && item.source === "plugin");
    assert.equal(found.length, 1, "the adapter must discover the installed Skill");
    const skillId = found[0].id;
    const profile = service.productStore.listAgentProfiles().find(item => item.enabled);
    assert(profile, "isolated Service must have a native Profile");
    const nativeSkill = service.runtimeSkillStore.catalog(profile.id).items.find(item => item.id === skillId);
    assert(nativeSkill, "the same installed Skill must reach the native Runtime catalog");

    const readChunks = async (tool, args) => {
      let cursor = 0;
      let text = "";
      let digest = null;
      let chunks = 0;
      do {
        const page = await invoke(tool, { ...args, cursor });
        const pageDigest = page.fileHash || page.contentHash;
        if (digest !== null) assert.equal(pageDigest, digest);
        digest = pageDigest;
        text += page.content;
        chunks += 1;
        assert(chunks <= 32, "Skill read exceeded bounded page count");
        cursor = page.nextCursor;
      } while (cursor !== null);
      return { text, digest, chunks };
    };
    const skill = await readChunks("shoggoth_skill_read", { skillId });
    assert.equal(skill.digest, previewSkill.descriptorDigest);
    assert.equal(sha256(skill.text), previewSkill.descriptorDigest);
    // Bundled import normalizes only Skill frontmatter. The frozen instruction
    // body must survive unchanged into the installed package.
    const body = text => text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "");
    assert.equal(body(skill.text), body(sourceSkillText));
    assert.equal(service.runtimeSkillStore.read({ profileId: profile.id,
      name: nativeSkill.name, contentHash: nativeSkill.contentHash }).content, skill.text);
    assert.match(skill.text, /Root Cause Investigation/u);
    assert.match(skill.text, /Reproduce Consistently/u);
    const helper = await readChunks("shoggoth_skill_file_read", {
      skillId, relativePath: HELPER });
    assert.equal(helper.digest, expectedHelperSha256);
    assert.equal(sha256(helper.text), expectedHelperSha256);
    assert.match(helper.text, /FOUND POLLUTER/u);

    // The command bytes below come only from the adapter response. Execute
    // them in a disposable npm project where the middle test creates state.
    const project = path.join(root, "pollution-case");
    fs.mkdirSync(path.join(project, "tests"), { recursive: true });
    fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({
      private: true, scripts: { test: "node" },
    }));
    fs.writeFileSync(path.join(project, "tests", "01-clean.test.cjs"),
      'require("node:assert/strict").equal(require("node:fs").existsSync("unwanted-coverage"), false);\n');
    fs.writeFileSync(path.join(project, "tests", "02-polluter.test.cjs"),
      'require("node:fs").writeFileSync("unwanted-coverage", "created by 02-polluter\\n");\n');
    fs.writeFileSync(path.join(project, "tests", "03-clean.test.cjs"),
      'require("node:assert/strict").ok(true);\n');
    const retrievedScriptPath = path.join(root, "retrieved-find-polluter.sh");
    fs.writeFileSync(retrievedScriptPath, helper.text, { mode: 0o700 });
    const childTmpDir = path.join(root, "child-tmp");
    fs.mkdirSync(childTmpDir, { mode: 0o700 });
    const npmConfig = path.join(root, "empty.npmrc");
    fs.writeFileSync(npmConfig, "", { mode: 0o600 });
    const npmGlobalConfig = path.join(root, "empty-global.npmrc");
    fs.writeFileSync(npmGlobalConfig, "", { mode: 0o600 });
    const nodeBin = path.dirname(process.execPath);
    assert(fs.statSync(path.join(nodeBin, "npm")).isFile(), "trusted Node installation lacks npm");
    const childEnv = { PATH: `${nodeBin}:/usr/bin:/bin`, HOME: root, TMPDIR: childTmpDir,
      LANG: "C", npm_config_offline: "true", npm_config_update_notifier: "false",
      npm_config_userconfig: npmConfig, npm_config_globalconfig: npmGlobalConfig,
      npm_config_cache: path.join(root, "npm-cache") };
    const npmProbe = await run(path.join(nodeBin, "npm"), ["test",
      "./tests/02-polluter.test.cjs"], { cwd: project, env: childEnv });
    assert.equal(npmProbe.code, 0, `isolated npm test failed: ${npmProbe.stdout} ${npmProbe.stderr}`);
    const markerPath = path.join(project, "unwanted-coverage");
    assert.equal(fs.readFileSync(markerPath, "utf8"), "created by 02-polluter\n");
    fs.unlinkSync(markerPath);
    const result = await run("/bin/bash", [retrievedScriptPath, "unwanted-coverage",
      "tests/**/*.test.cjs"], { cwd: project, env: childEnv });
    assert.equal(result.code, 1, `the helper did not report a polluter: ${result.stdout} ${result.stderr}`);
    assert.match(result.stdout, /Found 3 test files/u);
    assert.match(result.stdout, /\[1\/3\] Testing: \.\/tests\/01-clean\.test\.cjs/u);
    assert.match(result.stdout, /\[2\/3\] Testing: \.\/tests\/02-polluter\.test\.cjs/u);
    assert.doesNotMatch(result.stdout, /\[3\/3\] Testing/u);
    assert.match(result.stdout, /FOUND POLLUTER/u);
    assert.match(result.stdout, /Test: \.\/tests\/02-polluter\.test\.cjs/u);
    assert.match(result.stdout, /Created: unwanted-coverage/u);
    assert.equal(fs.readFileSync(markerPath, "utf8"),
      "created by 02-polluter\n");

    await rpc("plugins.installations.set", { installationId: installed.installationId,
      desiredState: "disabled", expectedRevision: installed.revision,
      operationId: "frozen-skill-business-disable" });
    assert.equal((await search()).items.filter(item => item.id === skillId).length, 0,
      "disabled frozen Skill must leave the adapter catalog");
    assert(!service.runtimeSkillStore.catalog(profile.id).items.some(item => item.id === skillId),
      "disabled frozen Skill must leave the native catalog");
    const observedOutput = result.stdout.split(/\r?\n/u).map(line => line.trim()).filter(line =>
      /^Found 3 test files$|^\[1\/3\] Testing:|^\[2\/3\] Testing:|FOUND POLLUTER|^Test:|^Created:/u.test(line));
    console.log("plugin-frozen-skill-business-fixture: ok", JSON.stringify({
      host: "OpenClaw production adapter over isolated Service IPC",
      sourcePath: path.relative(__dirname, sourceSkillPath),
      helperPath: path.relative(__dirname, sourceHelperPath),
      batchDigest: require("../docs/architecture/bundled-plugin-inventory-2026-09-26.json").batchDigest,
      packageSourceDigest: frozen.sourceDigest, installedReleaseDigest: installed.releaseDigest,
      sourceSkillSha256, installedSkillSha256: skill.digest,
      helperSha256: expectedHelperSha256,
      skillPages: skill.chunks, helperPages: helper.chunks,
      testFiles: 3, identifiedPolluter: "tests/02-polluter.test.cjs",
      markerContent: "created by 02-polluter", helperExitCode: result.code,
      observedOutput, nativeFacadeRead: true, disabledSkillInvisible: true,
      externalAccountUsed: false,
    }));
  } finally {
    try { await service?.stop(); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
