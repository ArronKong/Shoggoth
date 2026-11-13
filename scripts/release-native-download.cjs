"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { assertDraft, assertAssetInventory, githubClient, packageNames } = require("./release-draft.cjs");

async function downloadNativeDraft(client, directory, version, arch, tag, sha, id) {
  const architectureAssets = packageNames(version, arch);
  await client.assertTag(tag, sha);
  const release = await (await client.request(`/releases/${id}`)).json();
  assert.equal(release.id, Number(id));
  assertDraft(release, tag, sha);
  const metadata = ["SHA256SUMS.txt", "latest-mac.yml"];
  assertAssetInventory(release.assets, [...packageNames(version, "arm64"), ...packageNames(version, "x64"), ...metadata], true);
  fs.mkdirSync(directory, { recursive: true });
  for (const name of [...architectureAssets, ...metadata]) {
    const asset = release.assets.find(item => item.name === name);
    assert.equal(asset.state, "uploaded");
    await client.downloadDigest(asset, path.join(directory, name));
    console.log(`Verified draft asset: ${name}`);
  }
}

async function main() {
  const { GITHUB_REPOSITORY, GH_TOKEN, RELEASE_ID, RELEASE_TAG, RELEASE_SOURCE_SHA, SHOGGOTH_DRAFT_ARCH } = process.env;
  const version = require("../package.json").version;
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(RELEASE_TAG, `v${version}`);
  if (RELEASE_SOURCE_SHA) assert.equal(sha, RELEASE_SOURCE_SHA, "Checkout differs from frozen source");
  assert.match(RELEASE_ID, /^[1-9]\d*$/u);
  await downloadNativeDraft(githubClient(GITHUB_REPOSITORY, GH_TOKEN), "dist",
    version, SHOGGOTH_DRAFT_ARCH, RELEASE_TAG, sha, RELEASE_ID);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { downloadNativeDraft };
