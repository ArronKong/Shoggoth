"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const yaml = require("js-yaml");
const { packageNames, fileDigest, assertDraft, assertAssetInventory,
  recordBuild, assemble, uploadDraft, verifyDraft, confirmDraft } = require("./release-draft.cjs");

const version = "1.2.3", tag = "v1.2.3", sha = "a".repeat(40), runId = "42";
const notarization = { id: "12345678-1234-1234-1234-123456789abc", status: "Accepted" };

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-draft-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const receipt = path.join(root, "notarization.json");
  fs.writeFileSync(receipt, JSON.stringify(notarization));
  for (const arch of ["arm64", "x64"]) {
    const directory = path.join(root, `signed-${arch}`);
    fs.mkdirSync(directory);
    const names = packageNames(version, arch);
    for (const name of names) fs.writeFileSync(path.join(directory, name), `fixture ${name}`);
    const sha512 = await fileDigest(path.join(directory, names[0]), "sha512", "base64");
    fs.writeFileSync(path.join(directory, "latest-mac.yml"), yaml.dump({ version,
      files: [{ url: names[0], sha512, size: fs.statSync(path.join(directory, names[0])).size }],
      path: names[0], sha512, releaseDate: "2026-01-01T00:00:00.000Z" }));
    await recordBuild(directory, version, arch, sha, runId, receipt, receipt);
  }
  const output = path.join(root, "dist");
  await assemble(root, output, version, sha, runId);
  return { root, output, receipt };
}

function fakeClient() {
  const releases = [];
  const bytes = new Map();
  let uploads = 0, failAt = null;
  const client = {
    releases: async () => structuredClone(releases),
    assertTag: async (requestedTag, requestedSha) => { assert.equal(requestedTag, tag); assert.equal(requestedSha, sha); },
    request: async (route, options) => {
      if (options) {
        assert.equal(route, "/releases");
        assert.equal(options.method, "POST");
        const body = JSON.parse(options.body);
        assert.equal(body.draft, true);
        assert.equal(body.make_latest, "false");
        releases.push({ ...body, id: 5, assets: [] });
      } else assert.equal(route, "/releases/5");
      return { json: async () => structuredClone(releases[0]) };
    },
    upload: async (_release, name, file) => {
      if (++uploads === failAt) throw new Error("Transport interrupted");
      const id = uploads;
      bytes.set(id, await fileDigest(file));
      releases[0].assets.push({ id, name, size: fs.statSync(file).size });
    },
    downloadDigest: async asset => bytes.get(asset.id),
  };
  return { client, releases, bytes, failAt: value => { failAt = value; }, uploads: () => uploads };
}

test("merge both exact ZIP hashes and retain the Intel fallback", async t => {
  const { output } = await fixture(t);
  const metadata = yaml.load(fs.readFileSync(path.join(output, "latest-mac.yml"), "utf8"));
  assert.equal(metadata.files.length, 2);
  assert.equal(metadata.path, "Shoggoth-1.2.3-mac.zip");
  assert.equal(metadata.sha512, metadata.files[1].sha512);
  const sums = fs.readFileSync(path.join(output, "SHA256SUMS.txt"), "utf8").trim().split("\n");
  assert.equal(sums.length, 7);
  for (const line of sums) {
    const [hash, name] = line.split("  ");
    assert.equal(hash, await fileDigest(path.join(output, name)));
  }
});

test("reject stale source, another run, and a missing architecture", async t => {
  const { root, output } = await fixture(t);
  await assert.rejects(assemble(root, output, version, "b".repeat(40), runId), /source\/run\/architecture/);
  await assert.rejects(assemble(root, output, version, sha, "43"), /source\/run\/architecture/);
  fs.rmSync(path.join(root, "signed-x64"), { recursive: true });
  await assert.rejects(assemble(root, output, version, sha, runId), /ENOENT/);
});

test("reject tampered bytes even when the size is unchanged", async t => {
  const { root, output } = await fixture(t);
  const zip = path.join(root, "signed-arm64", packageNames(version, "arm64")[0]);
  const content = fs.readFileSync(zip); content[0] ^= 1; fs.writeFileSync(zip, content);
  await assert.rejects(assemble(root, output, version, sha, runId), /Hash mismatch/);
});

test("reject stale updater digest and unaccepted notarization", async t => {
  const { root, output, receipt } = await fixture(t);
  const directory = path.join(root, "signed-arm64");
  const file = path.join(directory, "latest-mac.yml");
  const metadata = yaml.load(fs.readFileSync(file, "utf8"));
  metadata.files[0].sha512 = "x".repeat(88);
  fs.writeFileSync(file, yaml.dump(metadata));
  await recordBuild(directory, version, "arm64", sha, runId, receipt, receipt);
  await assert.rejects(assemble(root, output, version, sha, runId));
  fs.writeFileSync(receipt, JSON.stringify({ ...notarization, status: "Invalid" }));
  await assert.rejects(recordBuild(directory, version, "arm64", sha, runId, receipt, receipt), /NOTARIZATION_REJECTED/);
});

test("draft ownership and inventory fail closed", () => {
  const release = { draft: true, tag_name: tag, target_commitish: sha,
    body: `<!-- shoggoth-draft-pipeline:${sha} -->` };
  assertDraft(release, tag, sha);
  assert.throws(() => assertDraft({ ...release, draft: false }, tag, sha), /published/);
  assert.throws(() => assertDraft({ ...release, body: "other task" }, tag, sha), /another release/);
  assert.throws(() => assertDraft({ ...release, target_commitish: "main" }, tag, sha), /source mismatch/);
  assert.throws(() => assertAssetInventory([{ name: "a" }, { name: "a" }], ["a"]), /Duplicate/);
  assert.throws(() => assertAssetInventory([{ name: "extra" }], ["a"]), /Unexpected/);
  assert.throws(() => assertAssetInventory([], ["a"], true), /Incomplete/);
});

test("partial uploads resume byte-for-byte and a completed retry performs no writes", async t => {
  const { output } = await fixture(t);
  const remote = fakeClient(); remote.failAt(4);
  await assert.rejects(uploadDraft(remote.client, output, version, tag, sha), /Transport interrupted/);
  assert.equal(remote.releases[0].assets.length, 3);
  remote.failAt(null);
  assert.equal(await uploadDraft(remote.client, output, version, tag, sha), 5);
  const uploads = remote.uploads();
  await uploadDraft(remote.client, output, version, tag, sha);
  assert.equal(remote.uploads(), uploads);
  const result = await verifyDraft(remote.client, output, version, tag, sha, "5");
  assert.equal(result.draft, true);
  assert.equal(result.assets.length, 8);
});

test("changed or published assets block resume and acceptance", async t => {
  const { output } = await fixture(t);
  const remote = fakeClient();
  await uploadDraft(remote.client, output, version, tag, sha);
  remote.bytes.set(remote.releases[0].assets[0].id, "changed");
  await assert.rejects(uploadDraft(remote.client, output, version, tag, sha), /Existing asset differs/);
  await assert.rejects(verifyDraft(remote.client, output, version, tag, sha, "5"), /hash mismatch/);
  remote.releases[0].draft = false;
  await assert.rejects(uploadDraft(remote.client, output, version, tag, sha), /published/);
  await assert.rejects(verifyDraft(remote.client, output, version, tag, sha, "5"), /published/);
});


test("post-native confirmation binds immutable asset IDs and the frozen source", async t => {
  const { output } = await fixture(t);
  const remote = fakeClient();
  await uploadDraft(remote.client, output, version, tag, sha);
  const receipt = await verifyDraft(remote.client, output, version, tag, sha, "5");
  await confirmDraft(remote.client, receipt, version, tag, sha, "5");
  remote.releases[0].assets[0].id += 100;
  await assert.rejects(confirmDraft(remote.client, receipt, version, tag, sha, "5"), /assets changed/);
});
