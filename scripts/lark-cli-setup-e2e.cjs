"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { startInspirationFixture } = require("./fixtures/inspiration-service-fixture.cjs");
const { prepareSetupFixture } = require("./fixtures/lark-cli-setup-fixture.cjs");

async function main() {
  const f = await startInspirationFixture({ isolatedHome: true, serviceOptions: { autoSparkNotes: false, larkCliOptions: { prepare: prepareSetupFixture },
    setCronTimer: () => 1, clearCronTimer() {}, setProactiveTimer: () => 1, clearProactiveTimer() {} } });
  const rest = async (action, input, expected = 200, origin = f.url) => {
    const response = await fetch(`${f.url}/__api/connectors/lark/${action}`, input === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(input),
    });
    const text = await response.text(); let result; try { result = JSON.parse(text); } catch { result = { error: text }; }
    assert.equal(response.status, expected, text); return result;
  };
  const until = async predicate => {
    const deadline = Date.now() + 8000;
    let value;
    while (Date.now() < deadline) { value = await rest("setup/status"); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.fail(`App setup did not reach expected state: ${JSON.stringify(value)}`);
  };
  try {
    const installed = await rest("install", { expectedRevision: 0 });
    assert.equal((await rest("setup/status")).configured, false);
    const input = { expectedRevision: installed.revision, mode: "auto", brand: "feishu" };
    await rest("setup/start", input, 403, "https://untrusted.example");
    await rest("setup/start", { ...input, appSecret: "injected" }, 400);
    await rest("setup/start", { ...input, expectedRevision: 0 }, 409);
    await assert.rejects(f.ipc("connector.lark.setup.start", { ...input, command: "injected" }), { code: "LARK_CLI_INVALID_ARGUMENT" });
    let started = await rest("setup/start", input);
    await rest("setup/start", input, 409);
    await until(value => value.state === "configuring" && value.qrCode);
    await rest("remove", { expectedRevision: installed.revision }, 409);
    await rest("setup/cancel", { requestId: started.requestId });
    assert.equal((await rest("setup/status")).state, "cancelled");
    started = await rest("setup/start", input);
    await until(value => value.state === "configuring" && value.verificationUrl);
    fs.writeFileSync(path.join(f.root, ".fixture-config-approved"), "test-only");
    const authorizing = await until(value => value.state === "authorizing" && value.qrCode);
    assert.equal(authorizing.userCode, "LOGIN-TEST");
    fs.writeFileSync(path.join(f.root, ".fixture-auth-approved"), "test-only");
    const ready = await until(value => value.state === "ready");
    assert.equal(ready.userName, "Test User"); assert.equal(ready.verificationUrl, null);
    assert.deepEqual(await f.backend.connectorRequest("connector.lark.setup.status", {}), ready);
    await rest("remove", { expectedRevision: installed.revision });
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, ".lark-cli/config.json"))).authorized, true);
    assert.equal((await rest("setup/status")).state, "idle");
    console.log(JSON.stringify({ outcome: "PASS", realServiceRestIpcAndSubprocess: true, appCreateAndUserAuthorization: "controlled fixture",
      qrCodeAndAutomaticCompletion: true, cancellationAndRetry: true, removalPreservesAccount: true, realAccountAuthorizationTested: false }));
  } finally { await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
