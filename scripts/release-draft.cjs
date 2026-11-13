"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Writable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const yaml = require("js-yaml");
const { assertAcceptedReceipt } = require("./notarize.cjs");
const { releaseApi, releaseRequest, sleep, isTransientReadError } = require("./release-http.cjs");

function packageNames(version, arch) {
  assert.match(version, /^\d+\.\d+\.\d+$/u);
  assert.ok(["arm64", "x64"].includes(arch));
  const zip = `Shoggoth-${version}-${arch === "arm64" ? "arm64-mac" : "mac"}.zip`;
  return [zip, `${zip}.blockmap`, `Shoggoth-${version}-${arch}.dmg`];
}

async function fileDigest(file, algorithm = "sha256", encoding = "hex") {
  const hash = createHash(algorithm);
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest(encoding);
}

function assertDraft(release, tag, sha) {
  assert.equal(release.draft, true, "Refusing to modify a published release");
  assert.equal(release.tag_name, tag, "Draft tag mismatch");
  assert.equal(release.target_commitish, sha, "Draft source mismatch");
  assert.ok(release.body?.includes(`<!-- shoggoth-draft-pipeline:${sha} -->`),
    "Existing draft belongs to another release operation");
}

function assertAssetInventory(assets, names, complete = false) {
  const actual = assets.map(asset => asset.name);
  assert.equal(new Set(actual).size, actual.length, "Duplicate remote assets");
  assert.ok(actual.every(name => names.includes(name)), "Unexpected remote asset");
  if (complete) assert.deepEqual(actual.sort(), [...names].sort(), "Incomplete draft assets");
}

async function recordBuild(dist, version, arch, sha, runId, appReceipt, dmgReceipt) {
  assert.match(sha, /^[a-f0-9]{40}$/u);
  assert.match(runId, /^\d+$/u);
  const assets = {};
  for (const name of [...packageNames(version, arch), "latest-mac.yml"]) {
    const file = path.join(dist, name);
    assert.ok(fs.lstatSync(file).isFile(), `Missing build asset: ${name}`);
    assets[name] = { size: fs.statSync(file).size, sha256: await fileDigest(file) };
  }
  const receipt = {
    version, arch, sha, runId, assets,
    appNotarization: assertAcceptedReceipt(fs.readFileSync(appReceipt, "utf8")),
    dmgNotarization: assertAcceptedReceipt(fs.readFileSync(dmgReceipt, "utf8")),
  };
  fs.writeFileSync(path.join(dist, "build-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
}

async function assemble(input, output, version, sha, runId) {
  fs.mkdirSync(output, { recursive: true });
  const documents = [];
  for (const arch of ["arm64", "x64"]) {
    const directory = path.join(input, `signed-${arch}`);
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, "build-receipt.json")));
    assert.deepEqual([receipt.version, receipt.arch, receipt.sha, receipt.runId], [version, arch, sha, runId],
      "Build receipt does not belong to this source/run/architecture");
    assertAcceptedReceipt(JSON.stringify(receipt.appNotarization));
    assertAcceptedReceipt(JSON.stringify(receipt.dmgNotarization));
    const names = packageNames(version, arch);
    assert.deepEqual(Object.keys(receipt.assets).sort(), [...names, "latest-mac.yml"].sort());
    for (const name of [...names, "latest-mac.yml"]) {
      const file = path.join(directory, name);
      assert.equal(fs.statSync(file).size, receipt.assets[name].size, `Size mismatch: ${name}`);
      assert.equal(await fileDigest(file), receipt.assets[name].sha256, `Hash mismatch: ${name}`);
    }
    const metadata = yaml.load(fs.readFileSync(path.join(directory, "latest-mac.yml"), "utf8"));
    assert.equal(metadata.version, version);
    const zip = names[0];
    const sha512 = await fileDigest(path.join(directory, zip), "sha512", "base64");
    assert.deepEqual(metadata.files, [{ url: zip, sha512, size: receipt.assets[zip].size }]);
    assert.equal(metadata.path, zip);
    assert.equal(metadata.sha512, sha512);
    documents.push(metadata);
    for (const name of names) fs.copyFileSync(path.join(directory, name), path.join(output, name), fs.constants.COPYFILE_FICLONE);
  }
  // Keep the Intel fallback fields while merging both architecture entries.
  const merged = { ...documents[1], files: documents.flatMap(document => document.files) };
  fs.writeFileSync(path.join(output, "latest-mac.yml"), yaml.dump(merged, { lineWidth: -1, noRefs: true }));
  const names = [...packageNames(version, "arm64"), ...packageNames(version, "x64"), "latest-mac.yml"];
  const sums = [];
  for (const name of names) sums.push(`${await fileDigest(path.join(output, name))}  ${name}`);
  fs.writeFileSync(path.join(output, "SHA256SUMS.txt"), sums.join("\n") + "\n");
  return [...names, "SHA256SUMS.txt"];
}

function githubClient(repository, token, runtime = {}) {
  const api = releaseApi(repository, token, runtime);
  const singleRead = releaseApi(repository, token, { ...runtime, singleAttempt: true });
  const pause = runtime.sleep || sleep;
  const request = (route, options = {}) => api.request(route, {
    ...(route.startsWith("/releases/assets/") ? { signal: AbortSignal.timeout(15 * 60_000) } : {}), ...options,
  });
  async function releases() {
    const result = [];
    for (let page = 1; ; page++) {
      const batch = await (await request(`/releases?per_page=100&page=${page}`)).json();
      result.push(...batch);
      if (batch.length < 100) return result;
    }
  }
  async function assertTag(tag, sha) {
    const commit = await (await request(`/commits/${encodeURIComponent(tag)}`)).json();
    assert.equal(commit.sha, sha, "Version tag moved away from the frozen source");
  }
  async function downloadDigest(asset, destination) {
    assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0 && Number.isSafeInteger(asset.size) && asset.size > 0);
    if (destination) assert.ok(!fs.existsSync(destination), "Download destination must be empty");
    for (let attempt = 1; attempt <= 3; attempt++) {
      let temporary;
      let backoffMs;
      try {
        if (destination) temporary = fs.mkdtempSync(`${destination}.part-`);
        const response = await singleRead.request(`/releases/assets/${asset.id}`, {
          headers: { Accept: "application/octet-stream" }, signal: AbortSignal.timeout(15 * 60_000),
        });
        if (!response.body || response.headers.get("content-type")?.includes("json")) {
          await response.body?.cancel();
          throw new Error("Asset endpoint returned metadata or an empty response");
        }
        const hash = createHash("sha256");
        let size = 0;
        const measure = async function* (stream) {
          for await (const chunk of stream) {
            size += chunk.length;
            assert.ok(size <= asset.size, `Remote download size mismatch: ${asset.name}`);
            hash.update(chunk);
            yield chunk;
          }
        };
        const partial = temporary && path.join(temporary, "download");
        const sink = partial ? fs.createWriteStream(partial, { flags: "wx", mode: 0o600 })
          : new Writable({ write(_chunk, _encoding, done) { done(); } });
        await pipeline(response.body, measure, sink);
        assert.equal(size, asset.size, `Remote download size mismatch: ${asset.name}`);
        const digest = hash.digest("hex");
        if (asset.digest) assert.equal(asset.digest, `sha256:${digest}`, `Remote download hash mismatch: ${asset.name}`);
        if (partial) fs.linkSync(partial, destination);
        return digest;
      } catch (error) {
        if (attempt === 3 || !(error.retryable || isTransientReadError(error))) throw error;
        backoffMs = Math.max(attempt * 1500, error.retryAfterMs ?? 0);
      } finally {
        if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
      }
      await pause(backoffMs);
    }
  }
  async function upload(release, name, file) {
    const url = new URL(release.upload_url.split("{")[0]);
    assert.equal(url.origin, "https://uploads.github.com");
    assert.equal(url.pathname, `/repos/${repository}/releases/${release.id}/assets`);
    url.searchParams.set("name", name);
    await releaseRequest(url, {
      method: "POST", duplex: "half", body: fs.createReadStream(file),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream",
        "Content-Length": String(fs.statSync(file).size) },
      signal: AbortSignal.timeout(15 * 60_000),
    });
  }
  return { request, releases, assertTag, downloadDigest, upload };
}

async function uploadDraft(client, directory, version, tag, sha, pause = sleep) {
  await client.assertTag(tag, sha);
  const names = [...packageNames(version, "arm64"), ...packageNames(version, "x64"), "latest-mac.yml", "SHA256SUMS.txt"];
  let release = (await client.releases()).find(item => item.tag_name === tag);
  if (!release) {
    try { release = await (await client.request("/releases", {
      method: "POST", body: JSON.stringify({ tag_name: tag, target_commitish: sha,
        name: `Shoggoth ${version} — draft validation`, draft: true, make_latest: "false",
        body: `Automated signed macOS draft. Native verification results are recorded in the Actions run.\n\n<!-- shoggoth-draft-pipeline:${sha} -->` }),
    })).json(); } catch (error) {
      release = (await client.releases()).find(item => item.tag_name === tag);
      if (!release) throw error; // A missing result never authorizes a second create.
    }
  }
  assertDraft(release, tag, sha);
  assertAssetInventory(release.assets, names);
  // Resume a partial upload only when every existing byte matches. Never clobber.
  for (const name of names) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      release = await (await client.request(`/releases/${release.id}`)).json();
      assertDraft(release, tag, sha);
      assertAssetInventory(release.assets, names);
      const asset = release.assets.find(item => item.name === name);
      const file = path.join(directory, name);
      if (asset) {
        assert.equal(asset.size, fs.statSync(file).size, `Existing asset differs: ${name}`);
        assert.equal(await client.downloadDigest(asset), await fileDigest(file), `Existing asset differs: ${name}`);
        break;
      } else {
        try { await client.upload(release, name, file); break; }
        catch (error) {
          if (!error.retryable || attempt === 3) throw error;
          // Re-read the inventory before retrying: the previous upload may exist.
          await pause(Math.max(attempt * 1500, error.retryAfterMs ?? 0));
        }
      }
    }
  }
  return release.id;
}

async function verifyDraft(client, directory, version, tag, sha, id) {
  await client.assertTag(tag, sha);
  const release = await (await client.request(`/releases/${id}`)).json();
  assertDraft(release, tag, sha);
  const names = [...packageNames(version, "arm64"), ...packageNames(version, "x64"), "latest-mac.yml", "SHA256SUMS.txt"];
  assertAssetInventory(release.assets, names, true);
  const assets = [];
  for (const asset of release.assets) {
    const file = path.join(directory, asset.name);
    assert.equal(asset.size, fs.statSync(file).size, `Remote asset size mismatch: ${asset.name}`);
    const sha256 = await client.downloadDigest(asset);
    assert.equal(sha256, await fileDigest(file), `Remote asset hash mismatch: ${asset.name}`);
    assets.push({ id: asset.id, name: asset.name, size: asset.size, sha256 });
  }
  const after = await (await client.request(`/releases/${id}`)).json();
  assertDraft(after, tag, sha);
  assert.deepEqual(after.assets.map(a => [a.id, a.name, a.size, a.digest]),
    release.assets.map(a => [a.id, a.name, a.size, a.digest]), "Draft assets changed during verification");
  return { releaseId: Number(id), tag, sha, draft: true, assets,
    remoteAssets: release.assets.map(a => ({ id: a.id, name: a.name, size: a.size, digest: a.digest ?? null })) };
}

async function confirmDraft(client, receipt, version, tag, sha, id) {
  assert.deepEqual([receipt.releaseId, receipt.tag, receipt.sha, receipt.draft], [Number(id), tag, sha, true]);
  await client.assertTag(tag, sha);
  const release = await (await client.request(`/releases/${id}`)).json();
  assertDraft(release, tag, sha);
  assertAssetInventory(release.assets,
    [...packageNames(version, "arm64"), ...packageNames(version, "x64"), "latest-mac.yml", "SHA256SUMS.txt"], true);
  // Release asset IDs identify immutable uploaded bytes. Native verification has
  // already downloaded them; require the same IDs and digests after it finishes.
  assert.deepEqual(release.assets.map(a => ({ id: a.id, name: a.name, size: a.size, digest: a.digest ?? null })),
    receipt.remoteAssets, "Draft assets changed after byte verification");
  return receipt;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const version = require("../package.json").version;
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(sha, process.env.RELEASE_SOURCE_SHA, "Checkout differs from frozen source");
  const tag = process.env.RELEASE_TAG;
  assert.equal(tag, `v${version}`);
  if (command === "record-build") {
    return recordBuild("dist", version, process.env.BUILD_ARCH, sha, process.env.GITHUB_RUN_ID, ...args);
  }
  if (command === "assemble") return assemble("artifacts", "dist", version, sha, process.env.GITHUB_RUN_ID);
  const client = githubClient(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN);
  if (command === "validate") {
    assert.equal(process.env.GITHUB_REF, `refs/tags/${tag}`, "Dispatch from the protected version tag");
    assert.equal(sha, process.env.GITHUB_SHA, "Dispatch the workflow at the exact tagged source commit");
    await client.assertTag(tag, sha);
    const release = (await client.releases()).find(item => item.tag_name === tag);
    if (release) assertDraft(release, tag, sha);
    return;
  }
  if (command === "upload") {
    const id = await uploadDraft(client, "dist", version, tag, sha);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `release_id=${id}\n`);
    return;
  }
  if (command === "confirm") {
    const receipt = JSON.parse(fs.readFileSync("draft-upload.json", "utf8"));
    await confirmDraft(client, receipt, version, tag, sha, process.env.RELEASE_ID);
    const ciRunId = process.env.RELEASE_SOURCE_CI_RUN_ID || "";
    const ciRunAttempt = process.env.RELEASE_SOURCE_CI_RUN_ATTEMPT || "";
    assert.equal(Boolean(ciRunId), Boolean(ciRunAttempt), "Incomplete main CI proof");
    const sourceCi = ciRunId
      ? { runId: Number(ciRunId), runAttempt: Number(ciRunAttempt) }
      : "passed";
    if (ciRunId) {
      for (const id of [sourceCi.runId, sourceCi.runAttempt]) assert.ok(Number.isSafeInteger(id) && id > 0);
    }
    fs.writeFileSync("accepted-draft.json", JSON.stringify({ ...receipt,
      runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      sourceCi, nativeArchitectures: ["arm64", "x64"],
    }, null, 2) + "\n");
    return;
  }
  assert.equal(command, "verify", "Unknown draft command");
  assert.match(process.env.RELEASE_ID || "", /^\d+$/u);
  const receipt = await verifyDraft(client, "dist", version, tag, sha, process.env.RELEASE_ID);
  fs.writeFileSync(args[0], JSON.stringify(receipt, null, 2) + "\n");
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { packageNames, fileDigest, assertDraft, assertAssetInventory, recordBuild, assemble, githubClient,
  uploadDraft, verifyDraft, confirmDraft };
