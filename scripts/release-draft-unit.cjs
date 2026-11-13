"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const yaml = require("js-yaml");
const { packageNames, fileDigest, assertDraft, assertAssetInventory, githubClient,
  recordBuild, assemble, uploadDraft, verifyDraft, confirmDraft } = require("./release-draft.cjs");
const { downloadNativeDraft } = require("./release-native-download.cjs");

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

test("native draft download retries a broken stream and installs only the verified file", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-draft-download-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from("signed fixture");
  const expected = path.join(root, "expected");
  fs.writeFileSync(expected, bytes);
  const asset = { id: 100, name: "fixture.zip", size: bytes.length, digest: `sha256:${await fileDigest(expected)}` };
  const destination = path.join(root, asset.name);
  let calls = 0;
  const backoffs = [];
  const client = githubClient("ArronKong/Shoggoth", "test-only", {
    fetch: async url => {
      assert.ok(url.endsWith("/releases/assets/100"));
      calls++;
      if (calls === 1) return new Response(null, { status: 502 });
      if (calls === 2) return new Response(new ReadableStream({
        start(controller) { controller.enqueue(bytes.subarray(0, 3)); },
        pull(controller) { controller.error(Object.assign(new Error("socket reset"), { code: "ECONNRESET" })); },
      }));
      return new Response(bytes);
    },
    sleep: async ms => { backoffs.push(ms); assert.deepEqual(fs.readdirSync(root), ["expected"]); },
  });
  assert.equal(await client.downloadDigest(asset, destination), asset.digest.slice(7));
  assert.deepEqual(fs.readFileSync(destination), bytes);
  assert.deepEqual(backoffs, [1500, 3000]);
  assert.equal(calls, 3);
});

test("draft asset size, digest, TLS and access failures do not retry or leave partial bytes", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-draft-download-stop-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const destination = path.join(root, "fixture.zip");
  const asset = { id: 100, name: "fixture.zip", size: 7, digest: `sha256:${"0".repeat(64)}` };
  for (const [fetch, match] of [
    [async () => new Response("small"), /size mismatch/u],
    [async () => new Response("same sz"), /hash mismatch/u],
    [async () => new Response(null, { status: 403 }), /HTTP 403/u],
    [async () => { throw new TypeError("fetch failed", { cause: { code: "CERT_HAS_EXPIRED" } }); }, /transport failed/u],
  ]) {
    const client = githubClient("ArronKong/Shoggoth", "test-only", {
      fetch, sleep: async () => assert.fail("Invalid release bytes or permissions must not retry"),
    });
    await assert.rejects(client.downloadDigest(asset, destination), match);
    assert.deepEqual(fs.readdirSync(root), []);
  }
});

test("native draft download is scoped to the expected Release ID, tag and architecture", async t => {
  const { output } = await fixture(t);
  const dir = path.join(output, "native");
  const names = [...packageNames(version, "arm64"), ...packageNames(version, "x64"), "SHA256SUMS.txt", "latest-mac.yml"];
  const assets = names.map(name => ({ name, state: "uploaded" }));
  const release = { id: 5, draft: true, tag_name: tag, target_commitish: sha, assets,
    body: `<!-- shoggoth-draft-pipeline:${sha} -->` };
  const downloads = [];
  const client = {
    assertTag: async (...args) => assert.deepEqual(args, [tag, sha]),
    request: async route => {
      assert.equal(route, "/releases/5");
      return { json: async () => release };
    },
    downloadDigest: async (asset, file) => downloads.push([asset.name, file]),
  };
  await downloadNativeDraft(client, dir, version, "x64", tag, sha, "5");
  const expected = [...packageNames(version, "x64"), "SHA256SUMS.txt", "latest-mac.yml"];
  assert.deepEqual(downloads, expected.map(name => [name, path.join(dir, name)]));
  for (const patch of [{ id: 6 }, { draft: false }, { target_commitish: "b".repeat(40) }, { assets: assets.slice(1) }]) {
    Object.assign(release, { id: 5, draft: true, target_commitish: sha, assets }, patch);
    await assert.rejects(downloadNativeDraft(client, dir, version, "x64", tag, sha, "5"));
    assert.equal(downloads.length, expected.length);
  }
});

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

test("a lost asset upload response is reconciled byte-for-byte before any retry", async t => {
  const { output } = await fixture(t), remote = fakeClient();
  const upload = remote.client.upload;
  let interrupted = false;
  remote.client.upload = async (...args) => {
    await upload(...args);
    if (!interrupted) { interrupted = true; throw Object.assign(new Error("lost response"), { retryable: true }); }
  };
  await uploadDraft(remote.client, output, version, tag, sha, async () => {});
  assert.equal(remote.uploads(), 8, "The uploaded asset must not be posted twice");
  assert.equal(remote.releases[0].assets.length, 8);
});

test("transient uploads retry a missing asset within a finite budget", async t => {
  const { output } = await fixture(t), remote = fakeClient();
  let calls = 0;
  remote.client.upload = async () => { calls++; throw Object.assign(new Error("503 before upload"), { retryable: true }); };
  await assert.rejects(uploadDraft(remote.client, output, version, tag, sha, async () => {}), /503 before upload/u);
  assert.equal(calls, 3); assert.equal(remote.releases[0].assets.length, 0);
});

test("a lost draft creation response never creates a second release", async t => {
  const { output } = await fixture(t), remote = fakeClient(), original = remote.client.request;
  let creates = 0;
  remote.client.request = async (route, options) => {
    const response = await original(route, options);
    if (route === "/releases" && options?.method === "POST") { creates++; throw new Error("lost create response"); }
    return response;
  };
  await uploadDraft(remote.client, output, version, tag, sha);
  assert.equal(creates, 1); assert.equal(remote.releases.length, 1);
});
