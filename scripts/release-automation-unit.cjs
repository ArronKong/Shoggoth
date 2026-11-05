"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const yaml = require("js-yaml");
const { releaseRequest } = require("./release-http.cjs");
const { recoverRelease } = require("./release-recovery.cjs");
const { createIntent, assertAccepted, assertAudits, publishAccepted, verifyPublicRelease, gateNames } = require("./release-publication.cjs");
const { packageNames } = require("./release-draft.cjs");

const repo = "ArronKong/Shoggoth", sha = "a".repeat(40), tag = "v1.2.3", version = "1.2.3";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const clone = value => structuredClone(value);
const response = value => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

test("transient GET failures use bounded backoff without exposing response bodies", async () => {
  let calls = 0; const delays = [];
  const result = await releaseRequest("https://api.github.com", {}, {
    fetch: async () => ++calls < 3 ? new Response("private response", { status: 502 }) : response({ ok: true }),
    sleep: async delay => delays.push(delay),
  });
  assert.deepEqual(await result.json(), { ok: true });
  assert.equal(calls, 3); assert.deepEqual(delays, [1500, 3000]);
});

for (const method of ["POST", "PATCH"]) test(`${method} responses and lost responses are never automatically replayed`, async () => {
  for (const transport of [false, true]) {
    let calls = 0;
    await assert.rejects(releaseRequest("https://api.github.com", { method }, { fetch: async () => {
      calls++; if (transport) throw new TypeError("fetch failed"); return new Response("secret", { status: 502 });
    } }), /Release (POST|PATCH)/u);
    assert.equal(calls, 1);
  }
});

test("credentials, validation errors and long rate-limit waits stop immediately", async () => {
  for (const status of [401, 403, 404, 422, 429]) {
    let calls = 0;
    await assert.rejects(releaseRequest("https://api.github.com", {}, { fetch: async () => {
      calls++; return new Response("secret", { status, headers: { "retry-after": "600" } });
    } }), error => error.status === status && !error.message.includes("secret"));
    assert.equal(calls, 1);
  }
});

test("exhausted read retries stop after three requests", async () => {
  let calls = 0;
  await assert.rejects(releaseRequest("https://api.github.com", {}, {
    fetch: async () => { calls++; throw new TypeError("network down"); }, sleep: async () => {},
  }), /transport failed/u);
  assert.equal(calls, 3);
});

function recoveryFixture() {
  const run = { id: 42, repository: { full_name: repo }, head_repository: { full_name: repo },
    event: "workflow_dispatch", path: ".github/workflows/release.yml", name: "Validate signed draft v1.2.3", workflow_id: 123,
    head_branch: tag, head_sha: sha, run_attempt: 1, status: "completed", conclusion: "failure" };
  const job = { id: 9, name: "source-ci / macos-hook-checks", conclusion: "cancelled", steps: [],
    labels: ["macos-latest"], check_run_url: `https://api.github.com/repos/${repo}/check-runs/8` };
  const annotations = [{ message: "The job was not acquired by Runner of type hosted even after multiple attempts" }];
  const jobs = [{ id: 6, name: "source-ci / isolated-checks", conclusion: "success" }, job,
    { id: 7, name: "Sign and notarize arm64", conclusion: "skipped" }];
  const writes = [], delays = [], records = [];
  const client = {
    get: async route => {
      if (route === "/actions/workflows/release.yml") return { id: 123, path: ".github/workflows/release.yml", name: "Signed macOS draft" };
      if (route === "/actions/runs/42") return clone(run);
      if (route.includes("/jobs?")) return clone({ total_count: jobs.length, jobs });
      if (route === "/check-runs/8") return { id: 8 };
      if (route === "/check-runs/8/annotations?per_page=100") return clone(annotations);
      if (route === `/compare/${sha}...main`) return { status: "identical" };
      throw new Error(`Unexpected read: ${route}`);
    },
    assertTag: async (candidate, source) => assert.deepEqual([candidate, source], [tag, sha]),
    request: async (route, options) => { writes.push({ route, ...options }); run.run_attempt++; run.status = "queued"; },
  };
  return { run, job, jobs, annotations, client, writes, delays, records,
    runtime: { sleep: async ms => delays.push(ms), record: item => records.push(item) } };
}

test("the observed pre-execution Mac capacity failure reruns just that job and its dependents", async () => {
  const f = recoveryFixture();
  const result = await recoverRelease(f.client, clone(f.run), f.runtime);
  assert.equal(result.decision, "retried"); assert.equal(result.nextAttempt, 2);
  assert.deepEqual(f.writes, [{ route: "/actions/jobs/9/rerun", method: "POST" }]);
  assert.deepEqual(f.delays, [60_000]); assert.equal(result.reusedSuccessfulJobs, true);
  assert.equal(f.jobs[0].conclusion, "success");
});

test("two automatic recoveries exhaust the three-attempt budget", async () => {
  const f = recoveryFixture();
  for (let attempt = 1; attempt <= 3; attempt++) {
    f.run.run_attempt = attempt; f.run.status = "completed";
    const result = await recoverRelease(f.client, clone(f.run), f.runtime);
    assert.equal(result.decision, attempt < 3 ? "retried" : "needs-attention");
  }
  assert.equal(f.writes.length, 2); assert.deepEqual(f.delays, [60_000, 180_000]);
});

for (const kind of ["code-failure", "started-job", "missing-allocation-annotation", "manual-cancel", "unknown-job", "mixed-failure"])
  test(`${kind} cannot trigger a release retry`, async () => {
    const f = recoveryFixture();
    if (kind === "code-failure") f.job.conclusion = "failure";
    if (kind === "started-job") f.job.steps = [{ name: "Build", conclusion: "failure" }];
    if (kind === "missing-allocation-annotation") f.annotations.length = 0;
    if (kind === "manual-cancel") f.run.conclusion = "cancelled";
    if (kind === "unknown-job") f.job.name = "unreviewed task";
    if (kind === "mixed-failure") f.jobs.push({ id: 15, name: "draft", conclusion: "failure", steps: [] });
    const result = await recoverRelease(f.client, clone(f.run), f.runtime);
    assert.equal(result.decision, "needs-attention"); assert.equal(f.writes.length, 0);
  });

test("fork, PR and unexpected workflow events cannot obtain recovery writes", async () => {
  for (const patch of [{ head_repository: { full_name: "fork/Shoggoth" } }, { event: "pull_request" },
    { path: ".github/workflows/other.yml" }, { head_branch: "main" }]) {
    const f = recoveryFixture(); Object.assign(f.run, patch);
    await assert.rejects(recoverRelease(f.client, clone(f.run), f.runtime));
    assert.equal(f.writes.length, 0);
  }
});

test("a duplicate completion event observes the newer attempt without another POST", async () => {
  const f = recoveryFixture(), event = clone(f.run);
  await recoverRelease(f.client, event, f.runtime);
  const again = await recoverRelease(f.client, event, f.runtime);
  assert.equal(again.decision, "already-advanced"); assert.equal(f.writes.length, 1);
});

test("manual recovery during backoff wins without being duplicated", async () => {
  const f = recoveryFixture(), event = clone(f.run);
  f.runtime.sleep = async () => { f.run.run_attempt++; f.run.status = "queued"; };
  assert.equal((await recoverRelease(f.client, event, f.runtime)).decision, "already-advanced");
  assert.equal(f.writes.length, 0);
});

test("an uncertain rerun response reconciles the same run and never posts twice", async () => {
  const f = recoveryFixture(), original = f.client.request;
  f.client.request = async (...args) => { await original(...args); throw new TypeError("connection reset"); };
  assert.equal((await recoverRelease(f.client, clone(f.run), f.runtime)).decision, "retried");
  assert.equal(f.writes.length, 1);
});

test("an unconfirmed retry stops after bounded read-only reconciliation", async () => {
  const f = recoveryFixture();
  f.client.request = async (...args) => { f.writes.push(args); throw new TypeError("connection reset"); };
  assert.equal((await recoverRelease(f.client, clone(f.run), f.runtime)).decision, "needs-attention");
  assert.equal(f.writes.length, 1); assert.equal(f.delays.filter(ms => ms === 3000).length, 10);
});

const notes = "## English\n\nA reviewed update.\n\n## 简体中文\n\n已审核的更新。";
const intentSettings = { version, tag, sha, runId: "42", mode: "publish", notesFile: `release-notes/${tag}.md`, notes };

test("draft is the default; publishing needs committed bilingual notes in the required order", () => {
  assert.equal(createIntent({ version, tag, sha, runId: "42" }).mode, "draft");
  for (const patch of [{ notesFile: "" }, { notes: "## 简体中文\n中文\n## English\nEnglish" },
    { notes: "## English\n\n## 简体中文\n中文" }, { notes: notes + "\n{{source}}" }, { mode: "unknown" }])
    assert.throws(() => createIntent({ ...intentSettings, ...patch }));
});

function publicationFixture() {
  const intent = createIntent(intentSettings), blobs = new Map();
  const names = [...packageNames(version, "arm64"), ...packageNames(version, "x64")];
  for (const name of names) blobs.set(name, Buffer.from(`signed fixture ${name}`));
  const zips = [names[0], names[3]];
  const files = zips.map(url => ({ url, size: blobs.get(url).length, sha512: createHash("sha512").update(blobs.get(url)).digest("base64") }));
  blobs.set("latest-mac.yml", Buffer.from(yaml.dump({ version, files, path: zips[1], sha512: files[1].sha512 })));
  blobs.set("SHA256SUMS.txt", Buffer.from([...blobs].map(([name, bytes]) => `${hash(bytes)}  ${name}`).join("\n") + "\n"));
  const assets = [...blobs].map(([name, bytes], i) => ({ id: 101 + i, name, size: bytes.length, digest: `sha256:${hash(bytes)}` }));
  const receipt = { releaseId: 5, tag, sha, draft: true, runId: "42", runAttempt: "1", sourceCi: "passed",
    nativeArchitectures: ["arm64", "x64"], remoteAssets: clone(assets),
    assets: assets.map(({ id, name, size, digest }) => ({ id, name, size, sha256: digest.slice(7) })) };
  const release = { id: 5, tag_name: tag, target_commitish: sha, draft: true, prerelease: false,
    name: `Shoggoth ${version} — draft validation`, body: `<!-- shoggoth-draft-pipeline:${sha} -->`, assets,
    html_url: `https://github.com/${repo}/releases/tag/${tag}` };
  const jobs = gateNames.map((name, i) => ({ id: i + 20, name, status: "completed", conclusion: "success" }));
  const patches = [], records = [];
  const client = {
    assertTag: async (candidate, source) => assert.deepEqual([candidate, source], [tag, sha]),
    get: async route => {
      if (route === "/actions/runs/42") return { id: 42, head_sha: sha, head_branch: tag, event: "workflow_dispatch", path: ".github/workflows/release.yml", repository: { full_name: repo }, run_attempt: 1 };
      if (route.includes("/jobs?")) return clone({ total_count: jobs.length, jobs });
      if (route === "") return { full_name: repo, visibility: "public", default_branch: "main" };
      if (route === `/compare/${sha}...main`) return { status: "identical" };
      if (route === `/commits/${sha}/pulls?per_page=100`) return [{ merged_at: "2026-01-01T00:00:00Z", merge_commit_sha: sha, base: { ref: "main", repo: { full_name: repo } } }];
      if (route === `/git/commits/${sha}`) return { author: { email: "user@users.noreply.github.com" }, committer: { email: "noreply@github.com" } };
      if (route === "/releases/5") return clone(release);
      if (route === "/releases/latest") return release.draft ? { id: 4, tag_name: "v1.2.2" } : clone(release);
      throw new Error(`Unexpected publication read: ${route}`);
    },
    request: async (route, options) => {
      assert.equal(route, "/releases/5"); assert.equal(options.method, "PATCH"); patches.push(JSON.parse(options.body));
      Object.assign(release, patches.at(-1), { published_at: "2026-01-01T00:00:00Z" }); return response(clone(release));
    },
  };
  const runtime = { record: item => records.push(item) };
  return { intent, receipt, release, jobs, patches, records, client, runtime, blobs };
}

test("all acceptance gates publish exactly once and a resume performs only reads", async () => {
  const f = publicationFixture();
  const result = await publishAccepted(f.client, f.intent, f.receipt, f.runtime);
  assert.equal(result.phase, "published"); assert.equal(f.patches.length, 1);
  assert.equal(f.patches[0].make_latest, "true"); assert.equal(f.patches[0].draft, false);
  assert.ok(f.release.body.indexOf("## English") < f.release.body.indexOf("## 简体中文"));
  await publishAccepted(f.client, f.intent, f.receipt, f.runtime);
  assert.equal(f.patches.length, 1);
});

for (const name of gateNames) test(`publication remains blocked when ${name} fails`, async () => {
  const f = publicationFixture(); f.jobs.find(job => job.name === name).conclusion = "failure";
  await assert.rejects(publishAccepted(f.client, f.intent, f.receipt), /Release gate failed/u);
  assert.equal(f.patches.length, 0); assert.equal(f.release.draft, true);
});

test("a lost publication response is reconciled without another PATCH", async () => {
  const f = publicationFixture(), original = f.client.request;
  f.client.request = async (...args) => { await original(...args); throw new TypeError("connection reset"); };
  assert.equal((await publishAccepted(f.client, f.intent, f.receipt)).phase, "published");
  assert.equal(f.patches.length, 1);
});

test("an unconfirmed publication write stays stopped and is never blindly replayed", async () => {
  const f = publicationFixture(); f.client.request = async () => { f.patches.push({}); throw new TypeError("network down"); };
  await assert.rejects(publishAccepted(f.client, f.intent, f.receipt), /no duplicate PATCH/u);
  assert.equal(f.patches.length, 1); assert.equal(f.release.draft, true);
});

test("wrong run, incomplete native acceptance, edited notes and changed bytes block publication", async () => {
  for (const mutation of [f => f.receipt.runId = "43", f => f.receipt.nativeArchitectures.pop(),
    f => f.intent.notes += " edited", f => f.release.assets[0].id++, f => f.intent.mode = "draft"]) {
    const f = publicationFixture(); mutation(f);
    await assert.rejects(publishAccepted(f.client, f.intent, f.receipt)); assert.equal(f.patches.length, 0);
  }
});

test("older versions and a moved tag cannot replace Latest", async () => {
  for (const kind of ["newer-latest", "moved-tag"]) {
    const f = publicationFixture(), get = f.client.get;
    if (kind === "newer-latest") f.client.get = async route => route === "/releases/latest" ? { id: 6, tag_name: "v1.2.4" } : get(route);
    else f.client.assertTag = async () => { throw new Error("Version tag moved"); };
    await assert.rejects(publishAccepted(f.client, f.intent, f.receipt)); assert.equal(f.patches.length, 0);
  }
});

test("publication audits must pass and remain fresh", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-release-audits-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const name of ["audit-root.json", "audit-ui.json"]) fs.writeFileSync(path.join(directory, name),
    JSON.stringify({ npmExitCode: 0, rawReport: { auditReportVersion: 2 }, decision: { passed: true } }));
  assertAudits(directory);
  const file = path.join(directory, "audit-root.json"), old = new Date(Date.now() - 3 * 60 * 60_000);
  fs.utimesSync(file, old, old); assert.throws(() => assertAudits(directory), /Fresh/u);
  fs.writeFileSync(file, JSON.stringify({ npmExitCode: 1, rawReport: { auditReportVersion: 2 }, decision: { passed: false } }));
  assert.throws(() => assertAudits(directory), /failed/u);
});

async function anonymousFixture(f, publication, corrupt = "") {
  const requests = [];
  const request = async (url, options) => {
    requests.push({ url, ...options });
    assert.ok(!Object.keys(options.headers).some(key => /authorization|cookie/iu.test(key)));
    if (url.startsWith("https://api.github.com/")) return response(clone(f.release));
    if (url.includes("/releases/tag/")) return new Response("release page");
    const name = decodeURIComponent(url.split("/").pop()), bytes = f.blobs.get(name);
    assert.ok(bytes, name);
    if (options.method === "HEAD") return new Response(null, { headers: { "content-length": String(bytes.length + (corrupt === name ? 1 : 0)) } });
    return new Response(bytes);
  };
  const result = await verifyPublicRelease(publication, { request });
  return { result, requests };
}

test("anonymous post-publication verification checks all downloads, updater and checksum entries", async () => {
  const f = publicationFixture(), publication = await publishAccepted(f.client, f.intent, f.receipt);
  const { result, requests } = await anonymousFixture(f, publication);
  assert.equal(result.authenticated, false); assert.equal(result.downloads.length, 8); assert.equal(result.checksumEntries, 7);
  assert.equal(requests.filter(item => item.method === "HEAD").length, 8);
  assert.ok(!requests.some(item => item.method === "GET" && /\.(?:zip|dmg)$/u.test(item.url)), "Do not download large packages to verify public links");
});

test("public download mismatch reports failure while preserving the public release and its asset IDs", async () => {
  const f = publicationFixture(), publication = await publishAccepted(f.client, f.intent, f.receipt);
  await assert.rejects(anonymousFixture(f, publication, packageNames(version, "arm64")[0]), /Public size mismatch/u);
  assert.equal(f.release.draft, false); assert.equal(f.patches.length, 1);
  await publishAccepted(f.client, f.intent, f.receipt);
  assert.equal(f.patches.length, 1);
});

test("accepted receipt rejects swapped immutable IDs before any network operation", () => {
  const f = publicationFixture(); f.receipt.remoteAssets[0].id++;
  assert.throws(() => assertAccepted(f.intent, f.receipt), /bytes differ/u);
});
