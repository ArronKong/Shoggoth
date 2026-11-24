"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const {
  assertAcceptedReceipt,
  buildNotarytoolArgs,
  notarizeArchive,
} = require("./notarize.cjs");

assert.deepEqual(buildNotarytoolArgs(
  "/tmp/Shoggoth-notarization.zip", "shoggoth-release", "/tmp/release.keychain-db",
), [
  "notarytool", "submit", "/tmp/Shoggoth-notarization.zip",
  "--keychain-profile", "shoggoth-release",
  "--keychain", "/tmp/release.keychain-db",
  "--output-format", "json", "--no-wait",
]);
assert.throws(() => buildNotarytoolArgs("relative.zip", "shoggoth-release"), TypeError);
assert.throws(() => buildNotarytoolArgs("/tmp/release.zip", "bad profile"), TypeError);
assert.throws(() => buildNotarytoolArgs("/tmp/release.zip", "release", "relative.keychain-db"), TypeError);
assert.deepEqual(assertAcceptedReceipt(JSON.stringify({
  id: "12345678-1234-1234-1234-123456789abc", status: "Accepted", message: "Package Approved",
})), {
  id: "12345678-1234-1234-1234-123456789abc", status: "Accepted", message: "Package Approved",
});
assert.throws(() => assertAcceptedReceipt(JSON.stringify({
  id: "12345678-1234-1234-1234-123456789abc", status: "Invalid",
})), /NOTARIZATION_REJECTED/u);
assert.throws(() => assertAcceptedReceipt("not-json"), /NOTARIZATION_RECEIPT_INVALID/u);

const { releaseDistribution } = require("./release-distribution.cjs");
assert.equal(releaseDistribution("developer-id"), "official");
assert.equal(releaseDistribution("developer-id", "internal"), "internal");
assert.equal(releaseDistribution("adhoc"), "internal");
assert.throws(() => releaseDistribution("developer-id", "typo"), TypeError);
assert.throws(() => releaseDistribution("adhoc", "official"), TypeError);
const keys = ["SHOGGOTH_CODESIGN_MODE", "SHOGGOTH_RELEASE_DISTRIBUTION", "SHOGGOTH_NOTARY_KEYCHAIN_PROFILE"];
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
try {
  process.env.SHOGGOTH_CODESIGN_MODE = "developer-id";
  delete process.env.SHOGGOTH_NOTARY_KEYCHAIN_PROFILE;
  delete process.env.SHOGGOTH_RELEASE_DISTRIBUTION;
  const notarize = require("./notarize.cjs").default;
  assert.throws(() => notarize({ electronPlatformName: "darwin" }), /requires SHOGGOTH_NOTARY/u);
  process.env.SHOGGOTH_RELEASE_DISTRIBUTION = "internal";
  assert.doesNotThrow(() => notarize({ electronPlatformName: "darwin" }));
  process.env.SHOGGOTH_NOTARY_KEYCHAIN_PROFILE = "must-not-submit";
  assert.throws(() => notarize({ electronPlatformName: "darwin" }), /Internal builds must not/u);
} finally {
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
}

console.log("Developer ID notarization and internal distribution contract: PASS");

const id = "12345678-1234-1234-1234-123456789abc";
const accepted = { id, status: "Accepted", message: "Package Approved" };
const asp = "https://appstoreconnect.apple.com/notary/v2/asp?";

function interrupted(url, code = -1001, stdout = "") {
  return Object.assign(new Error("xcrun exited 1"), { stdout, stderr:
    `Error: HTTPError(statusCode: nil, error: Error Domain=NSURLErrorDomain Code=${code} "Request failed" UserInfo={\n`
    + `NSLocalizedDescription=The request timed out., NSErrorFailingURLStringKey=${url}, _kCFStreamErrorDomainKey=4})\n` });
}

function archiveFixture(t, kind = "dmg") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-notary-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const archive = path.join(directory, `Shoggoth-x64.${kind}`);
  fs.writeFileSync(archive, "signed bytes");
  const output = path.join(directory, "evidence");
  fs.mkdirSync(output);
  const receipt = path.join(output, "notarization.json");
  const pending = path.join(output, "notarization.submission.json");
  const operations = [], pauses = [];
  const state = { name: null, upload: null };
  const run = runTool => notarizeArchive(archive, receipt, "test-profile", undefined, {
    runFile: (file, args, settings) => {
      assert.equal(file, "/usr/bin/xcrun");
      assert.equal(args[0], "notarytool");
      assert.ok(args.includes("test-profile"));
      assert.equal(settings.encoding, "utf8");
      assert.deepEqual(settings.stdio, ["ignore", "pipe", "pipe"]);
      assert.ok(settings.timeout > 0);
      const command = args[1];
      operations.push(command);
      if (command === "submit") {
        assert.ok(args.includes("--no-wait"));
        assert.equal(path.extname(args[2]), `.${kind}`);
        assert.equal(fs.statSync(args[2]).ino, fs.statSync(archive).ino);
        assert.equal(fs.readFileSync(args[2], "utf8"), "signed bytes");
        state.upload ??= args[2];
        state.name ??= path.basename(args[2]);
        assert.equal(args[2], state.upload);
        assert.notEqual(state.name, path.basename(archive));
        assert.equal(JSON.parse(fs.readFileSync(pending)).name, state.name);
      }
      if (command === "wait") assert.deepEqual(JSON.parse(fs.readFileSync(pending)), { name: state.name, id: args[2] });
      return runTool(command, args, settings);
    },
    pause: async ms => pauses.push(ms), now: () => pauses.reduce((sum, ms) => sum + ms, 0), warn: () => {},
  });
  return { run, state, operations, pauses, receipt, pending, directory };
}

test("the observed Intel password request timeout retries only the same DMG after checking history", async t => {
  const f = archiveFixture(t);
  let submits = 0;
  const result = await f.run((command, args) => {
    if (command === "submit") {
      if (++submits === 1) throw interrupted(asp);
      return JSON.stringify({ id });
    }
    if (command === "history") return JSON.stringify({ history: [{ name: "Shoggoth-x64.dmg", id }] });
    assert.equal(args[2], id);
    return JSON.stringify(accepted);
  });
  assert.deepEqual(result, accepted);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.receipt)), accepted);
  assert.deepEqual(f.operations, ["submit", "history", "submit", "wait"]);
  assert.deepEqual(f.pauses, [5000]);
  assert.ok(!fs.existsSync(f.state.upload));
});

test("a lost upload response with a history match continues with the recorded ID", async t => {
  const f = archiveFixture(t, "zip");
  const result = await f.run((command, args) => {
    if (command === "submit") throw interrupted("https://appstoreconnect.apple.com/notary/v2/submissions", -1005);
    if (command === "history") return JSON.stringify({ history: [{ name: f.state.name, id }] });
    assert.equal(args[2], id);
    return JSON.stringify(accepted);
  });
  assert.equal(result.id, id);
  assert.deepEqual(f.operations, ["submit", "history", "wait"]);
});

test("an interrupted wait retries the same submission without extending the total budget", async t => {
  const f = archiveFixture(t, "zip");
  const timeouts = [];
  await f.run((command, args, settings) => {
    if (command === "submit") return JSON.stringify({ id });
    assert.equal(args[2], id);
    timeouts.push(settings.timeout);
    if (timeouts.length === 1) throw interrupted(asp, -1005);
    return JSON.stringify(accepted);
  });
  assert.deepEqual(f.operations, ["submit", "wait", "wait"]);
  assert.deepEqual(f.pauses, [5000]);
  assert.equal(timeouts[0] - timeouts[1], 5000);
});

test("unconfirmed uploads, permanent errors, and an exhausted preflight do not replay blindly", async t => {
  const cases = [
    ["upload", () => interrupted("https://appstoreconnect.apple.com/notary/v2/submissions"), 1, 1],
    ["different path", () => interrupted(`${asp.slice(0, -1)}/unknown`), 1, 1],
    ["partial receipt", () => interrupted(asp, -1001, JSON.stringify({ id })), 1, 1],
    ["HTTP 403", () => Object.assign(new Error("xcrun failed"), { stderr: "Error: HTTPError(statusCode: Optional(403), error: nil)" }), 1, 0],
    ["TLS error", () => interrupted(asp, -1200), 1, 0],
    ["exhausted preflight", () => interrupted(asp), 3, 3],
  ];
  for (const [name, failure, submits, histories] of cases) await t.test(name, async t => {
    const f = archiveFixture(t);
    await assert.rejects(f.run(command => {
      if (command === "submit") throw failure();
      assert.equal(command, "history");
      return JSON.stringify({ history: [] });
    }), /NOTARIZATION_SUBMI[ST]/u);
    assert.equal(f.operations.filter(command => command === "submit").length, submits);
    assert.equal(f.operations.filter(command => command === "history").length, histories);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.pending)), { name: f.state.name });
    assert.ok(!fs.existsSync(f.receipt) && !fs.existsSync(f.state.upload));
  });
});

test("failure to reconcile history prevents a duplicate submit", async t => {
  const f = archiveFixture(t);
  await assert.rejects(f.run(command => {
    if (command === "submit") throw interrupted(asp);
    return JSON.stringify({ history: [{ name: f.state.name, id }, { name: f.state.name, id }] });
  }), /NOTARIZATION_HISTORY_AMBIGUOUS/u);
  assert.deepEqual(f.operations, ["submit", "history"]);
});

test("only the same submission's Accepted result creates the acceptance receipt", async t => {
  for (const [result, expected] of [
    [{ ...accepted, status: "Invalid" }, /NOTARIZATION_REJECTED/u],
    [{ ...accepted, id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }, /NOTARIZATION_RECEIPT_ID_MISMATCH/u],
  ]) {
    const f = archiveFixture(t);
    await assert.rejects(f.run(command => JSON.stringify(command === "submit" ? { id } : result)), expected);
    assert.deepEqual(f.operations, ["submit", "wait"]);
    assert.equal(JSON.parse(fs.readFileSync(f.pending)).id, id);
    assert.ok(!fs.existsSync(f.receipt));
  }
});

test("a second process cannot replace the receipt or submit to the same stage", async t => {
  const f = archiveFixture(t);
  await f.run(command => JSON.stringify(command === "submit" ? { id } : accepted));
  const recorded = fs.readFileSync(f.pending);
  await assert.rejects(f.run(() => assert.fail("Existing submission must not run the tool")), { code: "EEXIST" });
  assert.deepEqual(f.operations, ["submit", "wait"]);
  assert.deepEqual(fs.readFileSync(f.pending), recorded);
});
