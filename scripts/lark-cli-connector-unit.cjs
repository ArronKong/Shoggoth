"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { test } = require("node:test");
const { zipSync, strToU8 } = require("fflate");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { NativeSkillStore } = require("../app/agent-service/native-skill-store");
const { LarkCliConnectorController } = require("../app/agent-service/lark-cli-connector-controller");
const { RELEASE, extractSkills, installerEnvironment } = require("../app/agent-service/lark-cli-installer");
const { validateLarkCliParams, validateLarkCliResult, larkCliPublicError } = require("../app/core/lark-cli-contract");
const { prepareFixture } = require("./fixtures/lark-cli-fixture.cjs");

function fixture(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shg-lark-")));
  const paths = resolveServicePaths({ homeDir: root, trustedRoot: root, stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const store = new NativeSkillStore({ paths }); store.open(["profile-a"]);
  const make = () => new LarkCliConnectorController({ paths, skillStore: store, prepare: prepareFixture, ...options });
  const controller = make(); controller.open();
  t.after(async () => { await controller.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, paths, store, controller, make, change: (action, revision = controller.status().revision) => controller.handle(`connector.lark.${action}`, { expectedRevision: revision }) };
}

test("install is explicit, durable, globally discoverable and fully removable", async t => {
  const f = fixture(t);
  const empty = f.controller.status(); assert.equal(empty.state, "notInstalled"); assert.equal(f.store.registry.packages.length, 0);
  const result = await f.change("install"); validateLarkCliResult("connector.lark.install", result);
  assert.equal(result.state, "installed"); assert.equal(result.skillCount, 2); assert.ok(fs.existsSync(result.cliPath));
  assert.deepEqual(f.store.listGlobalEnabled().map(item => item.id).sort(), ["lark-calendar", "lark-shared"]);
  f.store.ensureProfile("future-profile");
  assert.equal(f.store.list("future-profile").items.filter(item => item.enabled).length, 2);
  const skill = f.store.listGlobalEnabled()[0];
  const loaded = f.store.readGlobalEnabled({ skillId: skill.id, version: skill.version, contentHash: skill.contentHash, registryRevision: skill.registryRevision });
  assert.ok(loaded.content.includes(result.cliPath)); assert.ok(loaded.content.includes("skills read lark-shared"));
  await f.controller.close(); const restarted = f.make(); restarted.open(); t.after(() => restarted.close());
  assert.equal(restarted.status().state, "installed");
  const before = f.store.list("profile-a");
  f.store.setProfileSkill({ profileId: "profile-a", skillId: skill.id, source: "user", version: skill.version, enabled: true, expectedRevision: before.profileRevision });
  const removed = await restarted.handle("connector.lark.remove", { expectedRevision: result.revision });
  assert.equal(removed.state, "notInstalled"); assert.equal(removed.canRemove, false); assert.equal(removed.cliPath, null);
  assert.equal(f.store.registry.packages.length, 0); assert.equal(fs.existsSync(result.cliPath), false);
  assert.equal(f.store.profileManifests.get("profile-a").selections.length, 0);
});

test("same-name imported skills and unrelated CLI/account data are preserved", async t => {
  const f = fixture(t), source = path.join(f.root, "manual");
  fs.mkdirSync(source); fs.writeFileSync(path.join(source, "SKILL.md"), "---\nname: lark-calendar\ndescription: My existing calendar skill\n---\nKeep my work.\n");
  f.store.installFromDirectory({ sourcePath: source, operationId: "manual", expectedRevision: f.store.revision, globalEnabled: true });
  const before = JSON.stringify(f.store.registry.packages);
  const outside = path.join(f.root, "global-cli"); fs.writeFileSync(outside, "my existing CLI and account data");
  await assert.rejects(f.change("install"), { code: "LARK_CLI_SKILL_CONFLICT" });
  assert.equal(f.controller.status().state, "failed"); assert.equal(JSON.stringify(f.store.registry.packages), before);
  await f.change("remove"); assert.equal(JSON.stringify(f.store.registry.packages), before);
  assert.equal(fs.readFileSync(outside, "utf8"), "my existing CLI and account data");
});

test("double clicks and stale revisions cannot race a pending installation", async t => {
  let proceed;
  const f = fixture(t, { prepare: async input => { await new Promise(resolve => { proceed = resolve; }); return prepareFixture(input); } });
  const installed = f.change("install");
  assert.equal(f.controller.status().state, "installing");
  assert.throws(() => f.change("install"), { code: "LARK_CLI_BUSY" });
  assert.throws(() => f.change("remove"), { code: "LARK_CLI_BUSY" });
  proceed(); const result = await installed;
  assert.throws(() => f.change("remove", 0), { code: "LARK_CLI_REVISION_CONFLICT" });
  assert.equal(f.controller.status().revision, result.revision);
});

test("download failure remains retryable and does not report installed", async t => {
  let attempts = 0;
  const f = fixture(t, { prepare: async input => {
    if (++attempts === 1) throw Object.assign(Error("private-network-details"), { code: "LARK_CLI_DOWNLOAD_FAILED" });
    return prepareFixture(input);
  } });
  await assert.rejects(f.change("install"), { code: "LARK_CLI_DOWNLOAD_FAILED" });
  assert.equal(f.controller.status().state, "failed"); assert.equal(f.store.listGlobalEnabled().length, 0);
  assert.equal(JSON.stringify(f.controller.status()).includes("private-network-details"), false);
  assert.equal((await f.change("install")).state, "installed");
});

test("shutdown aborts downloads and restart never automatically replays them", async t => {
  const f = fixture(t, { prepare: ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) });
  const pending = f.change("install"); const rejected = assert.rejects(pending, { code: "LARK_CLI_INTERRUPTED" });
  await f.controller.close(); await rejected;
  const restarted = f.make(); restarted.open(); t.after(() => restarted.close());
  assert.equal(restarted.status().state, "failed"); assert.equal(restarted.status().errorCode, "LARK_CLI_INTERRUPTED");
  assert.equal(f.store.registry.packages.length, 0);
  assert.equal((await restarted.handle("connector.lark.remove", { expectedRevision: restarted.status().revision })).state, "notInstalled");
});

test("durable pre-commit skill intent recovers a crash after skill registration", async t => {
  const f = fixture(t); const installed = await f.change("install");
  await f.controller.close();
  const record = JSON.parse(fs.readFileSync(f.controller.recordPath)); record.state = "installing"; record.stage = "installSkills";
  fs.writeFileSync(f.controller.recordPath, JSON.stringify(record), { mode: 0o600 });
  const restarted = f.make(); restarted.open(); t.after(() => restarted.close());
  assert.equal(restarted.status().errorCode, "LARK_CLI_INTERRUPTED"); assert.equal(restarted.status().skillCount, 2);
  await restarted.handle("connector.lark.remove", { expectedRevision: restarted.status().revision });
  assert.equal(f.store.registry.packages.length, 0); assert.equal(fs.existsSync(installed.cliPath), false);
});

test("missing or altered CLI and missing skill entries surface repair", async t => {
  const f = fixture(t); let result = await f.change("install");
  fs.appendFileSync(result.cliPath, "# altered\n"); assert.equal(f.controller.status().errorCode, "LARK_CLI_INCOMPLETE");
  result = await f.change("install"); assert.equal(result.state, "installed");
  const packageRoot = path.join(path.dirname(path.dirname(result.cliPath)), "skills", "lark-calendar");
  fs.unlinkSync(path.join(packageRoot, "SKILL.md")); assert.equal(f.controller.status().state, "failed");
  result = await f.change("install"); assert.equal(result.state, "installed");
  const skill = f.store.registry.packages[0]; f.store.uninstall({ skillId: skill.id, source: "user", version: skill.version, expectedRevision: f.store.revision });
  assert.equal(f.controller.status().errorCode, "LARK_CLI_INCOMPLETE");
});

test("modified owned skills and symlink replacements stop removal before deleting anything", async t => {
  const f = fixture(t); const result = await f.change("install"), skill = f.store.registry.packages[0];
  const file = path.join(f.paths.skillPackagesDir, skill.id, skill.version, "SKILL.md"), original = fs.readFileSync(file);
  fs.appendFileSync(file, "\nUser modification\n");
  await assert.rejects(f.change("remove"), { code: "LARK_CLI_OWNERSHIP_CONFLICT" });
  assert.equal(f.store.registry.packages.length, 2); assert.ok(fs.existsSync(result.cliPath));
  fs.writeFileSync(file, original);
  const outside = path.join(f.root, "keep-me"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "important"), "retained");
  fs.symlinkSync(outside, path.join(path.dirname(result.cliPath), "injected"));
  await assert.rejects(f.change("remove"), { code: "LARK_CLI_OWNERSHIP_CONFLICT" });
  assert.equal(fs.readFileSync(path.join(outside, "important"), "utf8"), "retained"); assert.equal(f.store.registry.packages.length, 2);
});

test("state corruption is isolated and cannot grant removal authority", async t => {
  const f = fixture(t); await f.controller.close();
  fs.writeFileSync(f.controller.recordPath, JSON.stringify({ ...f.controller.record, installation: { id: "../../user-files" } }), { mode: 0o600 });
  const restarted = f.make(); restarted.open(); t.after(() => restarted.close());
  assert.equal(restarted.status().errorCode, "LARK_CLI_STATE_UNAVAILABLE"); assert.equal(restarted.status().canRemove, false);
  assert.throws(() => restarted.handle("connector.lark.remove", { expectedRevision: restarted.status().revision }), { code: "LARK_CLI_STATE_UNAVAILABLE" });
  await restarted.close();
  fs.writeFileSync(f.controller.recordPath, "null", { mode: 0o600 });
  restarted.open();
  assert.equal(restarted.status().errorCode, "LARK_CLI_STATE_UNAVAILABLE");
});

test("archive filtering excludes repository fixtures and rejects unsafe skill paths", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shg-lark-zip-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prefix = `cli-${RELEASE.commit}/skills/`;
  const bytes = zipSync({ [`${prefix}lark-shared/SKILL.md`]: strToU8("official"), [`cli-${RELEASE.commit}/tests/skills/lark-demo/SKILL.md`]: strToU8("test only") });
  assert.deepEqual(extractSkills(bytes, root, { ...RELEASE, skillCount: 1 }), ["lark-shared"]);
  assert.equal(fs.existsSync(path.join(root, "lark-demo")), false);
  const unsafe = zipSync({ [`${prefix}lark-shared/../../escaped`]: strToU8("bad") });
  assert.throws(() => extractSkills(unsafe, root), { code: "LARK_CLI_INTEGRITY_FAILED" });
});

test("public contracts reject extra arguments and never expose raw process output", () => {
  assert.throws(() => validateLarkCliParams("connector.lark.install", { expectedRevision: 0, command: "anything" }));
  assert.throws(() => validateLarkCliParams("connector.lark.remove", { expectedRevision: -1 }));
  assert.throws(() => validateLarkCliParams("connector.lark.status", { path: "/tmp" }));
  assert.equal(larkCliPublicError(Error("private-canary")).message.includes("private-canary"), false);
  const env = installerEnvironment("/isolated", { PATH: "/private/bin", SECRET_TOKEN: "private-canary", HTTPS_PROXY: "http://127.0.0.1:7897" });
  assert.equal(env.SECRET_TOKEN, undefined); assert.equal(env.HOME, "/isolated"); assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:7897");
});
