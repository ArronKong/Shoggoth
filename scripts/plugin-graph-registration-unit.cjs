"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { loadOutlookCalendarConfig } = require("../app/agent-service/outlook-calendar-graph");
const { FILE_NAME, getGraphRegistrationStatus, configureGraphRegistration } =
  require("../app/agent-service/plugin-graph-registration");

const CLIENT_ID = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";
const OTHER_CLIENT_ID = "11111111-2222-4333-8444-555555555555";

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-graph-registration-")));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache"),
    trustedRoot: root });
  fs.mkdirSync(paths.pluginsDir, { recursive: true, mode: 0o700 });
  const graphAccount = { config: null, hasStoredAccount: () => false };
  return { root, paths, graphAccount, file: path.join(paths.pluginsDir, FILE_NAME) };
}

function testFreshRegistration() {
  const { root, paths, graphAccount, file } = fixture();
  try {
    assert.deepEqual(getGraphRegistrationStatus(paths, graphAccount),
      { configured: false, restartRequired: false });
    assert.deepEqual(configureGraphRegistration(paths, graphAccount, { clientId: CLIENT_ID }),
      { configured: true, restartRequired: true });
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(record, { version: 1, clientId: CLIENT_ID.toLowerCase() });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(paths.pluginsDir).mode & 0o777, 0o700);
    assert.equal(fs.readdirSync(paths.pluginsDir).length, 1);
    assert.deepEqual(loadOutlookCalendarConfig(paths), { clientId: CLIENT_ID.toLowerCase() });
    assert.deepEqual(getGraphRegistrationStatus(paths, graphAccount),
      { configured: true, restartRequired: true });
    graphAccount.config = { clientId: CLIENT_ID.toLowerCase() };
    assert.deepEqual(getGraphRegistrationStatus(paths, graphAccount),
      { configured: true, restartRequired: false });
    const original = fs.readFileSync(file);
    for (const clientId of [CLIENT_ID, OTHER_CLIENT_ID]) {
      assert.throws(() => configureGraphRegistration(paths, graphAccount, { clientId }),
        { code: "GRAPH_REGISTRATION_CONFLICT" });
      assert.deepEqual(fs.readFileSync(file), original);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function testInputAndStoredAccountGates() {
  const { root, paths, graphAccount, file } = fixture();
  try {
    for (const input of [null, {}, { clientId: "not-a-guid" },
      { clientId: CLIENT_ID, clientSecret: "must-not-be-accepted" },
      { clientId: CLIENT_ID, redirectPort: 4567 },
      { clientId: CLIENT_ID, scopes: ["Sites.Read.All"] }]) {
      assert.throws(() => configureGraphRegistration(paths, graphAccount, input),
        { code: "GRAPH_REGISTRATION_INVALID" });
      assert.equal(fs.existsSync(file), false);
    }
    graphAccount.hasStoredAccount = () => true;
    assert.throws(() => getGraphRegistrationStatus(paths, graphAccount),
      { code: "GRAPH_REGISTRATION_CONFLICT" });
    assert.throws(() => configureGraphRegistration(paths, graphAccount, { clientId: CLIENT_ID }),
      { code: "GRAPH_REGISTRATION_CONFLICT" });
    assert.equal(fs.existsSync(file), false);
    graphAccount.hasStoredAccount = () => false;
    graphAccount.config = { clientId: OTHER_CLIENT_ID };
    assert.throws(() => getGraphRegistrationStatus(paths, graphAccount),
      { code: "GRAPH_REGISTRATION_CONFLICT" });
    assert.throws(() => configureGraphRegistration(paths, graphAccount, { clientId: CLIENT_ID }),
      { code: "GRAPH_REGISTRATION_CONFLICT" });
    assert.equal(fs.existsSync(file), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function testInvalidExistingConfigurationIsNotOverwritten() {
  const { root, paths, graphAccount, file } = fixture();
  try {
    fs.writeFileSync(file, '{"version":1,"clientId":"invalid"}\n', { mode: 0o600 });
    const original = fs.readFileSync(file);
    assert.throws(() => getGraphRegistrationStatus(paths, graphAccount),
      { code: "OUTLOOK_CALENDAR_CONFIG_INVALID" });
    assert.throws(() => configureGraphRegistration(paths, graphAccount, { clientId: CLIENT_ID }),
      { code: "OUTLOOK_CALENDAR_CONFIG_INVALID" });
    assert.deepEqual(fs.readFileSync(file), original);
    fs.unlinkSync(file);
    const sentinel = path.join(root, "sentinel");
    fs.writeFileSync(sentinel, "keep", { mode: 0o600 });
    fs.symlinkSync(sentinel, file);
    assert.throws(() => configureGraphRegistration(paths, graphAccount, { clientId: CLIENT_ID }),
      { code: "OUTLOOK_CALENDAR_CONFIG_INVALID" });
    assert.equal(fs.readFileSync(sentinel, "utf8"), "keep");
    assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

testFreshRegistration();
testInputAndStoredAccountGates();
testInvalidExistingConfigurationIsNotOverwritten();
console.log("plugin Graph first registration unit: ok");
