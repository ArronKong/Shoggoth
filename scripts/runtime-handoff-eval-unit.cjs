#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { QUESTIONS, dialogueFixture, scoreAnswers, fixtureReadback } = require("./fixtures/runtime-handoff-dialogue.cjs");
const { compiledCase, parseOptions, evaluate, publicFailureCode } = require("./runtime-handoff-eval.cjs");
const { evaluatePi, readConfig, readPiAuth, providerFailureCode, validateProxy } = require("./runtime-handoff-pi-evaluator.cjs");

for (const rounds of [30, 50]) test(`${rounds} rounds compile real bounded handoff seed and retain all five fixed facts`, () => {
  const source = dialogueFixture(rounds);
  assert.equal(source.turns.length, rounds);
  assert.equal(source.sha256, dialogueFixture(rounds).sha256);
  const first = compiledCase(rounds), second = compiledCase(rounds);
  assert.equal(first.contextSha256, second.contextSha256);
  assert.equal(first.fixtureSha256, source.sha256);
  assert.equal(first.transcriptEvents, rounds * 2);
  assert.ok(first.contextBytes <= 56 * 1024);
  assert.match(first.context, /UNTRUSTED RUNTIME HANDOFF DATA/u);
  assert.equal(scoreAnswers(fixtureReadback(first.context)).correct, 5);
});

test("rubric enforces the approved 4/5 gate, rejects malformed answers, contradictions and wrong next-step order", () => {
  const answers = Object.fromEntries(QUESTIONS.map(q => [q.id, q.answer]));
  assert.equal(scoreAnswers(answers).correct, 5);
  assert.equal(scoreAnswers({ ...answers, goal: "unknown" }).passed, true);
  assert.equal(scoreAnswers({ ...answers, goal: "unknown", constraints: "unknown" }).passed, false);
  assert.equal(scoreAnswers({ ...answers, extra: "unexpected" }).correct, 0);
  assert.equal(scoreAnswers({ ...answers, decisions: "Use SQLite WAL and an immutable manifest, but use postgres." }).correct, 4);
  assert.equal(scoreAnswers({ ...answers, next: "First benchmark 50,000 files, then test crash recovery." }).items.at(-1).passed, false);
  assert.throws(() => scoreAnswers(answers, 3), /THRESHOLD_FIXED/u);
  const cut = compiledCase(50).context.replace(/Museum Atlas/gu, "[removed]").replace(/8 workers/gu, "[removed]");
  assert.equal(scoreAnswers(fixtureReadback(cut)).correct, 3);
});

test("CLI defaults to no-model fixture and refuses ambiguous real-provider invocation", async () => {
  assert.deepEqual(parseOptions([]), { mode: "fixture", rounds: [30, 50], output: undefined, cliPath: undefined, configPath: undefined });
  for (const args of [["--unknown", "x"], ["--mode", "real-provider"], ["--rounds", "20"],
    ["--mode", "fixture", "--real-config", "/tmp/secret"], ["--rounds", "30", "--rounds", "50"]]) {
    assert.throws(() => parseOptions(args));
  }
  const result = await evaluate(parseOptions([]));
  assert.equal(result.evidence, "fixture-readback-no-model");
  assert.equal(result.modelAcceptanceMeasured, false);
  assert.deepEqual(result.results.map(r => r.score.correct), [5, 5]);
});

test("optional Pi RPC runner uses only explicit credentials in a disposable HOME and requires natural exit", async () => {
  const root = fs.mkdtempSync("/tmp/sghandoff-config-");
  try {
    const configPath = path.join(root, "fixture.json");
    const config = { baseUrl: "http://127.0.0.1:1/v1", model: "fake-rpc-model", contextWindow: 32000, apiKey: "explicit-fixture-dummy" };
    fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    assert.deepEqual(readConfig(configPath), config);
    const response = await evaluatePi({ ...compiledCase(30), configPath,
      cliPath: path.join(__dirname, "fixtures/runtime-handoff-pi-fake.cjs") });
    assert.equal(response.naturalExitCode, 0);
    assert.equal(scoreAnswers(response.answers).correct, 5);
    assert.equal(JSON.stringify(response).includes(config.apiKey), false);
    fs.writeFileSync(configPath, JSON.stringify({ ...config, model: "fake-failing-exit" }));
    await assert.rejects(evaluatePi({ context: "Museum Atlas", questions: QUESTIONS, configPath,
      cliPath: path.join(__dirname, "fixtures/runtime-handoff-pi-fake.cjs") }), /HANDOFF_CLI_EXIT_FAILED/u);
    fs.chmodSync(configPath, 0o644);
    assert.throws(() => readConfig(configPath), /PRIVATE_CONFIG_REQUIRED/u);
    fs.chmodSync(configPath, 0o600);
    fs.writeFileSync(configPath, JSON.stringify({ ...config, apiKey: "!must-not-execute" }));
    assert.throws(() => readConfig(configPath), /CONFIG_INVALID/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("explicit Pi OAuth copies only openai-codex into isolation and never changes source authentication", async () => {
  const root = fs.mkdtempSync("/tmp/sghandoff-oauth-");
  try {
    const authPath = path.join(root, "auth.json");
    const source = { "openai-codex": { type: "oauth", access: "fixture-access", refresh: "fixture-refresh",
      expires: Date.now() + 3600000, accountId: "fixture-account" },
    unrelated: { type: "api_key", key: "unrelated-must-not-copy" } };
    const original = JSON.stringify(source);
    fs.writeFileSync(authPath, original, { mode: 0o600 });
    assert.deepEqual(readPiAuth(authPath), source["openai-codex"]);
    const cliPath = path.join(__dirname, "fixtures/runtime-handoff-pi-fake.cjs");
    const options = parseOptions(["--mode", "real-provider", "--pi-cli", cliPath,
      "--pi-auth", authPath, "--model", "gpt-5.6-luna", "--proxy", "http://127.0.0.1:7897"]);
    assert.equal(options.authPath, authPath);
    const result = await evaluatePi({ ...options, context: "Museum Atlas", questions: QUESTIONS });
    assert.equal(result.provider, "openai-codex");
    assert.equal(result.naturalExitCode, 0);
    assert.equal(fs.readFileSync(authPath, "utf8"), original);
    assert.equal(JSON.stringify(result).includes("fixture-access"), false);
    assert.equal(JSON.stringify(result).includes("fixture-refresh"), false);
    assert.throws(() => parseOptions(["--mode", "real-provider", "--pi-cli", cliPath,
      "--pi-auth", authPath]), /OAUTH_MODEL_REQUIRED/u);
    assert.throws(() => parseOptions(["--mode", "real-provider", "--pi-cli", cliPath,
      "--pi-auth", authPath, "--model", "gpt-5.6-luna", "--real-config", authPath]), /REAL_CONFIG_REQUIRED/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("provider failures expose only fixed auth/limit/network/model codes", () => {
  for (const [input, expected] of [["401 invalid_grant private-token", "HANDOFF_PROVIDER_AUTH_FAILED"],
    ["429 rate limit with private-body", "HANDOFF_PROVIDER_LIMIT"], ["fetch failed private-endpoint", "HANDOFF_PROVIDER_NETWORK_FAILED"],
    ["model not found private-model", "HANDOFF_PROVIDER_MODEL_UNAVAILABLE"]]) {
    assert.equal(providerFailureCode(input), expected);
    assert.equal(publicFailureCode(new Error(expected)), expected);
  }
  assert.equal(publicFailureCode(new Error("HANDOFF_SECRET_private-token")), "HANDOFF_EVALUATION_FAILED");
  assert.equal(publicFailureCode(new Error("Provider arbitrary secret-bearing error")), "HANDOFF_EVALUATION_FAILED");
  assert.equal(validateProxy("http://127.0.0.1:7897"), "http://127.0.0.1:7897");
  for (const proxy of ["https://outside.invalid:443", "http://user:secret@127.0.0.1:7897", "http://127.0.0.1:7897/path",
    "http://127.0.0.1:7897?secret", "file:///tmp/proxy", "http://127.0.0.1"]) assert.throws(() => validateProxy(proxy), /HANDOFF_PROXY_INVALID/u);
});
