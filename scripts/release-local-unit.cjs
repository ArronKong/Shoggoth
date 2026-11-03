"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { localOptions, waitForSourceCi, waitForNative, collectBuild } = require("./release-local.cjs");
const { recordBuild, packageNames } = require("./release-draft.cjs");

const sha = "a".repeat(40);
const immediate = { attempts: 3, pause: async () => {} };
const response = value => ({ json: async () => value });

test("local input requires an exact version and keeps default notarization in Apple's keychain search", () => {
  assert.throws(() => localOptions(["--tag", "main"]));
  assert.throws(() => localOptions(["--tag", "v1.2.3", "--keychain", "relative"]));
  assert.throws(() => localOptions(["--tag", "v1.2.3", "--publish"]));
  const options = localOptions(["--tag", "v1.2.3"]);
  assert.equal(options["notary-profile"], "shoggoth-notary");
  assert.equal(options["notary-keychain"], undefined);
  assert.ok(path.isAbsolute(options.workDir));
});

test("source signing waits for exact-source CI and rejects failed or unrelated success", async () => {
  let count = 0;
  const client = { request: async () => response({ workflow_runs: [{ id: 12, head_sha: sha,
    status: ++count === 1 ? "in_progress" : "completed", conclusion: count === 1 ? null : "success" }] }) };
  assert.equal(await waitForSourceCi(client, sha, immediate), 12);
  await assert.rejects(waitForSourceCi({ request: async () => response({ workflow_runs: [
    { head_sha: "b".repeat(40), status: "completed", conclusion: "success" },
    { head_sha: sha, status: "completed", conclusion: "failure" },
  ] }) }, sha, immediate), /requires successful CI/u);
});

test("native receipt needs this operation's run and both successful native jobs", async () => {
  const title = "Verify signed draft v1.2.3 / 123";
  let jobs = [{ name: "Native arm64 draft verification", conclusion: "success" },
    { name: "Native x64 draft verification", conclusion: "success" }];
  const client = { request: async route => response(route.includes("/jobs?") ? { jobs } : {
    workflow_runs: [{ id: 2, head_sha: sha, display_title: "another run", status: "completed", conclusion: "success" },
      { id: 3, head_sha: sha, display_title: title, status: "completed", conclusion: "success" }],
  }) };
  assert.equal((await waitForNative(client, sha, title, immediate)).id, 3);
  jobs = jobs.slice(0, 1);
  await assert.rejects(waitForNative(client, sha, title, immediate), /Missing successful x64/u);
  jobs.push({ name: "Native x64 draft verification", conclusion: "failure" });
  await assert.rejects(waitForNative(client, sha, title, immediate), /Missing successful x64/u);
});

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-local-release-unit-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source"), dist = path.join(source, "dist");
  const artifacts = path.join(directory, "artifacts");
  const evidence = path.join(dist, "signing-arm64");
  fs.mkdirSync(evidence, { recursive: true });
  for (const name of [...packageNames("1.2.3", "arm64"), "latest-mac.yml"]) fs.writeFileSync(path.join(dist, name), name);
  const receipt = { id: "12345678-1234-1234-1234-123456789abc", status: "Accepted" };
  for (const name of ["app-notarization.json", "dmg-notarization.json"]) {
    fs.writeFileSync(path.join(evidence, name), JSON.stringify(receipt));
  }
  fs.writeFileSync(path.join(evidence, "source-parity.json"), "{\"passed\":true}");
  await recordBuild(dist, "1.2.3", "arm64", sha, "123",
    path.join(evidence, "app-notarization.json"), path.join(evidence, "dmg-notarization.json"));
  return { source, dist, artifacts, destination: path.join(artifacts, "signed-arm64") };
}

test("completed signed output resumes a partial collection without another notarization", async t => {
  const { source, dist, artifacts, destination } = await fixture(t);
  const zip = packageNames("1.2.3", "arm64")[0];
  fs.mkdirSync(destination, { recursive: true });
  fs.renameSync(path.join(dist, zip), path.join(destination, zip));
  await collectBuild(source, artifacts, "1.2.3", "arm64", sha, "123");
  assert.ok(fs.existsSync(path.join(destination, "build-receipt.json")));
  await collectBuild(source, artifacts, "1.2.3", "arm64", sha, "123");
  assert.equal(fs.readdirSync(destination).length, 5);
});

test("local resume rejects altered assets, foreign runs and missing accepted build receipts", async t => {
  const { source, dist, artifacts } = await fixture(t);
  await assert.rejects(collectBuild(source, artifacts, "1.2.3", "arm64", sha, "999"));
  fs.writeFileSync(path.join(dist, packageNames("1.2.3", "arm64")[0]), "tampered");
  await assert.rejects(collectBuild(source, artifacts, "1.2.3", "arm64", sha, "123"), /mismatch/u);
  fs.unlinkSync(path.join(dist, "build-receipt.json"));
  await assert.rejects(collectBuild(source, artifacts, "1.2.3", "arm64", sha, "123"), /inspect notarization/u);
});
