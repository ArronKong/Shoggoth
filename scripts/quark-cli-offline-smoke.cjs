"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { prepareOfficialSkill } = require("../app/agent-service/official-skill-installer");
const { createOfficialSkillRuntime } = require("../app/agent-service/official-skill-runtime");
const { validatePayload } = require("../app/agent-service/official-skill-mcp-bridge");
async function runQuarkOfflineSmoke(archive) {
  process.umask(0o077);
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shg-quark-offline-")));
  const root = path.join(base, "state", "runtime-bin", "official-skills", "quark-drive", crypto.randomUUID()), home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const env = { HOME: home, TMPDIR: home, PATH: "/usr/bin:/bin", NO_COLOR: "1", ELECTRON_RUN_AS_NODE: "1" };
  const preload = path.resolve(__dirname, "fixtures/quark-offline-preload.cjs"), helper = path.resolve(__dirname, "../app/agent-service/quark-skill-cli-helper.js");
  let runtime, stage = "install";
  try {
    await prepareOfficialSkill({ providerId: "quark-drive", root, homeDir: home, serverId: "quark-offline", fetch: async () => new Response(fs.readFileSync(archive)) });
    validatePayload("quark-drive", root, home);
    const checks = [["--version"], ["resolve-agent"], ...["search", "browse", "upload", "download", "share", "share-detail", "share-search", "saveas", "get-share-update-list", "get-share-update-files", "get-share-saved-dir", "saveas-update", "summary", "qa", "organize", "organize-copy", "organize-move", "rename", "rename-revert"].map(name => [name, "--help"])];
    for (const args of checks) {
      const result = spawnSync(process.execPath, ["--require", preload, helper], { env, cwd: home, input: JSON.stringify({ operation: "command", args }), encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 });
      assert.equal(result.status, 0, `${args.join(" ")}: ${result.stdout} ${result.stderr}`);
      assert.match(result.stdout, args[0] === "--version" ? /1\.0\.25/u : args[0] === "resolve-agent" ? /QK_AGENT_ID=shoggoth/u : /Usage:/u);
    }
    let timestamp = 0;
    runtime = createOfficialSkillRuntime({ providerId: "quark-drive", root, home, env, now: () => timestamp,
      validate: () => validatePayload("quark-drive", root, home), spawn: (command, args, options) => spawn(command, ["--require", preload, ...args], options) });
    assert.equal((await runtime.call("account_status", {})).state, "signedOut");
    const authorization = await runtime.call("account_start", {}); assert.equal(authorization.state, "authorizing");
    const authorizationUrl = new URL(authorization.verificationUrl);
    assert.equal(authorizationUrl.searchParams.get("agent_id"), "shoggoth");
    assert.ok(authorizationUrl.searchParams.get("client_id"));
    assert.equal(authorizationUrl.searchParams.get("scope"), "clouddrive.base clouddrive.netdisk");
    assert.equal(authorizationUrl.searchParams.get("device_name"), "Shoggoth");
    timestamp = 5000;
    const account = await runtime.call("account_status", {}); assert.equal(account.state, "ready"); assert.equal(account.userName, "Offline account");
    assert.equal(JSON.stringify(account).includes("private-canary"), false);
    const config = path.join(home, ".quarkclouddrive", "shoggoth", "config.json"); assert.equal(fs.statSync(config).mode & 0o777, 0o600);
    stage = "read-only token refresh";
    fs.writeFileSync(path.join(home, "offline-expire-user-info"), "fixture", { mode: 0o600 });
    assert.equal((await runtime.call("account_status", {})).state, "ready");
    assert.ok(fs.readFileSync(config, "utf8").includes("offline-rotated-access-canary"));
    stage = "user_info";
    const info = await runtime.call("user_info", {}); assert.equal(info.ok, true);
    stage = "search_files";
    const searched = await runtime.call("search_files", { keyword: "offline report" }); assert.equal(searched.ok, true);
    stage = "list_files";
    const listed = await runtime.call("list_files", {}); assert.equal(listed.ok, true); assert.ok(listed.resultId);
    const full = await runtime.call("result_files", { resultId: listed.resultId }); assert.equal(full.files[0].fid, "offline-fid");
    stage = "create_folder";
    const created = await runtime.call("create_folder", { name: "Approved folder", confirmed: true }); assert.equal(created.data.fid, "offline-created-folder");
    stage = "no expired-write replay";
    fs.writeFileSync(path.join(home, "offline-reject-write"), "fixture", { mode: 0o600 });
    await assert.rejects(runtime.call("create_folder", { name: "Expired write", confirmed: true }), { code: "OFFICIAL_SKILL_OPERATION_UNCERTAIN" });
    assert.equal((await runtime.call("account_logout", {})).state, "signedOut"); assert.equal(fs.existsSync(config), false);
    assert.equal((await runtime.call("account_status", {})).state, "signedOut");
    stage = "denied consent";
    fs.writeFileSync(path.join(home, "offline-denied-consent"), "fixture", { mode: 0o600 });
    assert.equal((await runtime.call("account_start", {})).state, "authorizing"); timestamp += 5000;
    assert.equal((await runtime.call("account_status", {})).state, "signedOut");
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, "quark-authorization.json"))).pending, null);
    const requests = fs.readFileSync(path.join(home, "offline-requests.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(requests.length > 0); assert.equal(requests.some(request => request.hasSessionInput), false);
    assert.equal(requests.some(request => /trace|telemetry|skill_config|revoke/iu.test(request.path)), false);
    assert.equal(requests.filter(request => request.path === "/agent/v1/oauth/access_token/rotate").length, 1, "only the read-only account check refreshes tokens");
    assert.equal(requests.filter(request => request.path === "/open/v1/dir").length, 2, "one successful folder and one refused folder, with no replay");
    return { outcome: "PASS", version: "1.0.25", realPinnedPayload: true, helpCommands: checks.length, helperAndRuntime: true,
      apiBoundary: "deterministic offline fixture; all real network denied", truthfullyIdentifiesAs: "shoggoth", privateOAuthRoundTrip: true,
      statusAndSearchAndBrowseAndApprovedFolder: true, localLogout: true, telemetryRequests: 0, socketReplay: false,
      readOnlyTokenRefresh: true, expiredWriteReplay: false, realAccountAuthorization: false, realCloudFileChanges: false };
  } catch (error) { error.message = `${stage}: ${error.message}`; throw error; }
  finally { await runtime?.close(); fs.rmSync(base, { recursive: true, force: true }); }
}
if (require.main === module) runQuarkOfflineSmoke(path.resolve(process.argv[2] || ".artifacts/quark-connector-20261030/upstream/quarkclouddrive-1.0.25.zip"))
  .then(result => console.log(JSON.stringify(result)), error => { console.error(error); process.exitCode = 1; });
module.exports = { runQuarkOfflineSmoke };
