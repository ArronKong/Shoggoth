"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { parseArgs } = require("node:util");
const { setTimeout: delay } = require("node:timers/promises");
const { packageNames, fileDigest, assemble, githubClient, uploadDraft, verifyDraft, confirmDraft } = require("./release-draft.cjs");
const { assertAcceptedReceipt } = require("./notarize.cjs");

function localOptions(args) {
  const { values } = parseArgs({ args, options: {
    tag: { type: "string" }, "work-dir": { type: "string" }, identity: { type: "string" },
    keychain: { type: "string", default: path.join(os.homedir(), "Library/Keychains/login.keychain-db") },
    "notary-profile": { type: "string", default: "shoggoth-notary" },
    "notary-keychain": { type: "string" }, resume: { type: "boolean", default: false },
    "check-only": { type: "boolean", default: false }, help: { type: "boolean", default: false },
  } });
  if (values.help) return values;
  assert.match(values.tag || "", /^v\d+\.\d+\.\d+$/u, "A numeric version tag is required");
  assert.ok(path.isAbsolute(values.keychain), "Signing keychain must be absolute");
  if (values["notary-keychain"]) assert.ok(path.isAbsolute(values["notary-keychain"]));
  return { ...values, workDir: path.resolve(values["work-dir"] || `.artifacts/local-draft-${values.tag}`) };
}

async function waitForSourceCi(client, sha, { attempts = 240, pause = delay } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const runs = await (await client.request(`/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`)).json();
    const exact = runs.workflow_runs.filter(run => run.head_sha === sha);
    const success = exact.find(run => run.status === "completed" && run.conclusion === "success");
    if (success) return success.id;
    assert.ok(!exact.length || exact.some(run => run.status !== "completed"),
      "The exact public source requires successful CI before signing; inspect its failed CI run");
    console.log("Waiting for the exact public source CI...");
    await pause(15_000);
  }
  throw new Error("Source CI did not finish within one hour");
}

async function waitForNative(client, sha, title, { attempts = 480, pause = delay } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const runs = await (await client.request(`/actions/workflows/verify-signed-draft.yml/runs?head_sha=${sha}&event=workflow_dispatch&per_page=100`)).json();
    const run = runs.workflow_runs.find(item => item.head_sha === sha && item.display_title === title);
    assert.ok(run || attempt < 8,
      `No matching verification run appeared for ${title}; inspect Actions before dispatching again`);
    if (run?.status === "completed") {
      assert.equal(run.conclusion, "success", `Native verification failed: ${run.html_url}`);
      const jobs = await (await client.request(`/actions/runs/${run.id}/jobs?per_page=100`)).json();
      for (const arch of ["arm64", "x64"]) {
        const job = jobs.jobs.find(item => item.name === `Native ${arch} draft verification`);
        assert.equal(job?.conclusion, "success", `Missing successful ${arch} native verification`);
      }
      return run;
    }
    console.log(run ? `Waiting for native verification: ${run.html_url}` : "Waiting for the native verification run to appear...");
    await pause(15_000);
  }
  throw new Error("Native verification did not finish within two hours; inspect the existing run before retrying");
}

async function collectBuild(source, artifacts, version, arch, sha, runId) {
  const dist = path.join(source, "dist");
  const destination = path.join(artifacts, `signed-${arch}`);
  const targetReceipt = path.join(destination, "build-receipt.json");
  const sourceReceipt = path.join(dist, "build-receipt.json");
  const receiptPath = fs.existsSync(targetReceipt) ? targetReceipt : sourceReceipt;
  assert.ok(fs.existsSync(receiptPath),
    "Build stopped before its accepted receipt; inspect notarization before rebuilding");
  const receipt = JSON.parse(fs.readFileSync(receiptPath));
  assert.deepEqual([receipt.version, receipt.arch, receipt.sha, receipt.runId], [version, arch, sha, runId]);
  assertAcceptedReceipt(JSON.stringify(receipt.appNotarization));
  assertAcceptedReceipt(JSON.stringify(receipt.dmgNotarization));
  const names = [...packageNames(version, arch), "latest-mac.yml"];
  assert.deepEqual(Object.keys(receipt.assets).sort(), [...names].sort());
  fs.mkdirSync(destination, { recursive: true });
  for (const name of names) {
    const to = path.join(destination, name), from = path.join(dist, name);
    const file = fs.existsSync(to) ? to : from;
    assert.ok(fs.lstatSync(file).isFile());
    assert.equal(fs.statSync(file).size, receipt.assets[name].size, `Size mismatch: ${name}`);
    assert.equal(await fileDigest(file), receipt.assets[name].sha256, `Hash mismatch: ${name}`);
    if (file === from) fs.renameSync(from, to);
  }
  const evidence = path.join(artifacts, `evidence-${arch}`);
  if (!fs.existsSync(evidence)) fs.renameSync(path.join(dist, `signing-${arch}`), evidence);
  for (const [name, expected] of [["app-notarization.json", receipt.appNotarization], ["dmg-notarization.json", receipt.dmgNotarization]]) {
    assert.deepEqual(assertAcceptedReceipt(fs.readFileSync(path.join(evidence, name), "utf8")), expected);
  }
  assert.ok(fs.statSync(path.join(evidence, "source-parity.json")).size > 0);
  // The receipt is the last move. A retry can collect an interrupted move safely.
  if (receiptPath === sourceReceipt) fs.renameSync(sourceReceipt, targetReceipt);
}

async function main() {
  const options = localOptions(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/release-local.cjs --tag v<VERSION> [--work-dir PATH] [--identity FINGERPRINT] [--keychain PATH] [--notary-profile NAME] [--notary-keychain PATH] [--check-only] [--resume]");
    return;
  }
  assert.equal(process.platform, "darwin", "Local signing requires macOS");
  const repository = "ArronKong/Shoggoth";
  const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const client = githubClient(repository, token);
  const commit = await (await client.request(`/commits/${options.tag}`)).json();
  const sha = commit.sha;
  assert.match(sha, /^[a-f0-9]{40}$/u);
  const sourceCiRun = await waitForSourceCi(client, sha);
  const version = options.tag.slice(1);
  const existing = (await client.releases()).find(release => release.tag_name === options.tag);
  if (existing) require("./release-draft.cjs").assertDraft(existing, options.tag, sha);
  const identities = execFileSync("security", ["find-identity", "-v", "-p", "codesigning", options.keychain], { encoding: "utf8" });
  const matching = [...identities.matchAll(/([A-F0-9]{40}) "Developer ID Application: .*\(MK3JHXWR7H\)"/gu)].map(match => match[1]);
  const identity = options.identity || (matching.length === 1 ? matching[0] : null);
  assert.ok(identity && matching.includes(identity), "Select a valid Shoggoth Developer ID identity with --identity");
  const notaryArgs = ["notarytool", "history", "--keychain-profile", options["notary-profile"], "--output-format", "json"];
  if (options["notary-keychain"]) notaryArgs.push("--keychain", options["notary-keychain"]);
  execFileSync("xcrun", notaryArgs, { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  console.log(`Source ${sha}, CI ${sourceCiRun}, Developer ID and notarization profile verified.`);
  if (options["check-only"]) return;
  fs.mkdirSync(path.dirname(options.workDir), { recursive: true });
  if (!options.resume) fs.mkdirSync(options.workDir);
  const lock = path.join(options.workDir, "release.lock");
  const fd = fs.openSync(lock, "wx", 0o600);
  fs.writeFileSync(fd, `${process.pid}\n`); fs.closeSync(fd);
  try {
    const statePath = path.join(options.workDir, "local-run.json");
    const state = options.resume ? JSON.parse(fs.readFileSync(statePath)) : {
      tag: options.tag, sha, version, runId: String(Date.now()), sourceCiRun,
    };
    assert.deepEqual([state.tag, state.sha, state.version], [options.tag, sha, version]);
    const save = () => {
      fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(`${statePath}.tmp`, statePath);
    };
    save();
    const source = path.join(options.workDir, "source");
    const run = (file, args, extraEnv = {}) => execFileSync(file, args, {
      cwd: source, stdio: "inherit", timeout: 3 * 60 * 60_000,
      env: { ...process.env, ...extraEnv },
    });
    if (!fs.existsSync(source)) {
      execFileSync("git", ["clone", "--depth=1", "--branch", options.tag,
        `https://github.com/${repository}.git`, source], { stdio: "inherit", timeout: 10 * 60_000 });
    }
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim(), sha);
    assert.equal(JSON.parse(fs.readFileSync(path.join(source, "package.json"))).version, version);
    if (!state.prepared) {
      run("npm", ["ci", "--ignore-scripts"]);
      run("npm", ["--prefix", "app/manage-ui", "ci", "--ignore-scripts"]);
      const reviewed = path.join(options.workDir, `reviewed-source-${Date.now()}`);
      run("npm", ["run", "export:source", "--", reviewed]);
      run(process.execPath, ["scripts/check-release-private-keys.cjs", reviewed]);
      run(process.execPath, ["scripts/check-connector-public-release.cjs"]);
      run(process.execPath, ["node_modules/electron/install.js"]);
      run("npm", ["run", "build:manage"]);
      run("npm", ["run", "prepare:runtimes"]);
      run(process.execPath, ["scripts/release-package-checks.cjs", "preflight"]);
      run("npm", ["run", "release:metadata"]);
      run("npm", ["run", "licenses:check"]);
      state.prepared = true; state.reviewedSource = reviewed; save();
    }
    const buildEnv = { RELEASE_SOURCE_SHA: sha, RELEASE_TAG: options.tag, GITHUB_RUN_ID: state.runId,
      SHOGGOTH_CODESIGN_MODE: "developer-id", SHOGGOTH_RELEASE_DISTRIBUTION: "official",
      SHOGGOTH_CODESIGN_IDENTITY: identity, SHOGGOTH_CODESIGN_KEYCHAIN: options.keychain,
      SHOGGOTH_NOTARY_KEYCHAIN_PROFILE: options["notary-profile"], SHOGGOTH_EXPECT_NOTARIZED: "1",
      SHOGGOTH_EXPECT_TEAM_ID: "MK3JHXWR7H", SHOGGOTH_NOTARY_KEYCHAIN: options["notary-keychain"],
    };
    const artifacts = path.join(options.workDir, "artifacts");
    // Local builds share prepared inputs and run sequentially to bound disk use.
    for (const arch of ["arm64", "x64"]) {
      const destination = path.join(artifacts, `signed-${arch}`);
      if (fs.existsSync(path.join(destination, "build-receipt.json")) && state.building !== arch) {
        await collectBuild(source, artifacts, version, arch, sha, state.runId);
        continue;
      }
      assert.ok(!state.building || state.building === arch, "Another architecture has an interrupted build");
      if (!state.building) {
        const disk = fs.statfsSync(source);
        assert.ok(disk.bavail * disk.bsize >= 4 * 1024 ** 3,
          "At least 4 GiB of available space is required before starting the next architecture build");
        state.building = arch; save();
        run(process.execPath, ["scripts/release-build.cjs"], { ...buildEnv, BUILD_ARCH: arch });
      }
      await collectBuild(source, artifacts, version, arch, sha, state.runId);
      // The task-owned temporary App is recoverable from its CRC-checked signed ZIP.
      fs.rmSync(path.join(source, "dist", arch === "arm64" ? "mac-arm64" : "mac"), { recursive: true, force: true });
      delete state.building; save();
    }
    const dist = path.join(options.workDir, "dist");
    await assemble(artifacts, dist, version, sha, state.runId);
    const releaseId = await uploadDraft(client, dist, version, options.tag, sha);
    const receipt = await verifyDraft(client, dist, version, options.tag, sha, String(releaseId));
    fs.writeFileSync(path.join(options.workDir, "draft-upload.json"), JSON.stringify(receipt, null, 2) + "\n");
    const title = `Verify signed draft ${options.tag} / ${state.runId}`;
    if (!state.dispatched) {
      // Mark before dispatch. A lost response must be reconciled with existing runs.
      state.dispatched = true; save();
      await client.request("/actions/workflows/verify-signed-draft.yml/dispatches", {
        method: "POST", body: JSON.stringify({ ref: options.tag,
          inputs: { tag: options.tag, release_id: String(releaseId), request_id: state.runId } }),
      });
    }
    const native = await waitForNative(client, sha, title);
    await confirmDraft(client, receipt, version, options.tag, sha, String(releaseId));
    if (state.nativeEvidenceRun !== native.id) {
      const evidenceDir = path.join(options.workDir, `native-evidence-${native.id}-${Date.now()}`);
      execFileSync("gh", ["run", "download", String(native.id), "--repo", repository,
        "--dir", evidenceDir], { stdio: "inherit", timeout: 10 * 60_000 });
      state.nativeEvidenceRun = native.id; state.nativeEvidenceDir = evidenceDir; save();
    }
    fs.writeFileSync(path.join(options.workDir, "accepted-draft.json"), JSON.stringify({ ...receipt,
      sourceCiRun, nativeRun: native.id, nativeEvidence: state.nativeEvidenceDir,
      mode: "local-signing", acceptedAt: new Date().toISOString(),
    }, null, 2) + "\n");
    console.log(`Signed draft ${options.tag} verified on both native architectures. Receipt: ${options.workDir}/accepted-draft.json`);
  } finally { fs.unlinkSync(lock); }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { localOptions, waitForSourceCi, waitForNative, collectBuild };
