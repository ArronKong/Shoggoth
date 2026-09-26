#!/usr/bin/env node
"use strict";

// Defaults to a deterministic fixture. --mode real-provider is an explicit,
// potentially billable run using only the supplied config, never account HOME.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");
const { runtimeHandoffSeed } = require("../app/agent-service/runtime-handoff-seed");
const { QUESTIONS, dialogueFixture, scoreAnswers, fixtureReadback } = require("./fixtures/runtime-handoff-dialogue.cjs");

function compiledCase(rounds) {
  const source = dialogueFixture(rounds);
  const f = contextFixture({ runtime: "pi", now: () => 500 });
  try {
    for (const [index, turn] of source.turns.entries()) {
      for (const kind of ["user", "assistant"]) f.append({ id: `eval-${index}-${kind}`, kind,
        content: { text: turn[kind], operationId: `round-${index}` } });
    }
    // The current evaluation question belongs to the new native session and is
    // excluded from prior transcript, just like real Coordinator dispatch.
    f.append({ id: "eval-current", kind: "user", content: { text: "Answer the fixed handoff questions.", operationId: "evaluation" } });
    const seed = runtimeHandoffSeed({ runtimeSessionId: null, workspace: null,
      retiredRuntimeSessions: [{ runtime: "codex" }] }, { runtime: "pi" });
    const snapshot = f.compiler.compile({ profile: f.profile, run: f.run, transcriptSessionId: f.transcriptSessionId,
      query: "Answer the fixed handoff questions.", contextLifecycleV1: true, currentOperationId: "evaluation",
      transcriptBudget: 48 * 1024, handoffSeed: seed });
    const context = snapshot.dynamicContext;
    return { rounds, fixtureSha256: source.sha256,
      contextSha256: crypto.createHash("sha256").update(context).digest("hex"),
      transcriptEvents: source.rounds * 2, contextBytes: Buffer.byteLength(context),
      truncatedBlocks: snapshot.report.truncatedBlocks, context,
      questions: QUESTIONS.map(({ id, question }) => ({ id, question })) };
  } finally { f.cleanup(); }
}

function parseOptions(args) {
  const allowed = new Set(["--mode", "--rounds", "--output", "--pi-cli", "--real-config", "--pi-auth", "--model", "--proxy"]);
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!allowed.has(key) || values.has(key) || !value || value.startsWith("--")) throw new Error("HANDOFF_EVAL_ARGS_INVALID");
    values.set(key, value);
  }
  const mode = values.get("--mode") || "fixture", rounds = values.get("--rounds") || "all";
  if (!["fixture", "prepare", "real-provider"].includes(mode) || !["30", "50", "all"].includes(rounds)) throw new Error("HANDOFF_EVAL_ARGS_INVALID");
  for (const key of ["--output", "--pi-cli", "--real-config", "--pi-auth"]) if (values.has(key) && !path.isAbsolute(values.get(key))) throw new Error("HANDOFF_EVAL_ABSOLUTE_PATH_REQUIRED");
  if (mode === "real-provider" && (!values.has("--pi-cli") || values.has("--real-config") === values.has("--pi-auth"))) throw new Error("HANDOFF_EVAL_REAL_CONFIG_REQUIRED");
  if (values.has("--pi-auth") !== values.has("--model")
    || (values.has("--model") && !/^[a-zA-Z0-9._:/-]{1,256}$/u.test(values.get("--model")))) throw new Error("HANDOFF_EVAL_OAUTH_MODEL_REQUIRED");
  if (mode !== "real-provider" && ["--pi-cli", "--real-config", "--pi-auth", "--model", "--proxy"].some(key => values.has(key))) throw new Error("HANDOFF_EVAL_REAL_CONFIG_FORBIDDEN");
  const proxy = require("./runtime-handoff-pi-evaluator.cjs").validateProxy(values.get("--proxy"));
  return { mode, rounds: rounds === "all" ? [30, 50] : [Number(rounds)],
    output: values.get("--output"), cliPath: values.get("--pi-cli"), configPath: values.get("--real-config"),
    ...(values.has("--pi-auth") ? { authPath: values.get("--pi-auth"), model: values.get("--model") } : {}),
    ...(proxy ? { proxy } : {}) };
}

async function evaluate(options) {
  const results = [];
  for (const rounds of options.rounds) {
    const compiled = compiledCase(rounds);
    if (options.mode === "prepare") { results.push(compiled); continue; }
    const response = options.mode === "fixture" ? { answers: fixtureReadback(compiled.context), naturalExitCode: null }
      : await require("./runtime-handoff-pi-evaluator.cjs").evaluatePi({ ...options, ...compiled });
    const { context, ...metadata } = compiled;
    results.push({ ...metadata, ...response, score: scoreAnswers(response.answers) });
  }
  return { version: 1, evidence: options.mode === "fixture" ? "fixture-readback-no-model"
    : options.mode === "prepare" ? "prepared-context-no-model" : "real-provider-pi-isolated-cli",
  threshold: 4, modelAcceptanceMeasured: options.mode === "real-provider",
  limitation: "Literal rubric checks retained facts. Review model answers for semantic contradictions. No packaged/installed App or live cross-Runtime UI evidence.",
  results };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const result = await evaluate(options);
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output) {
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, text, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ evidence: result.evidence, output: options.output,
      scores: result.results.map(item => ({ rounds: item.rounds, correct: item.score?.correct, total: item.score?.total })) }));
  } else process.stdout.write(text);
  if (result.results.some(item => item.score && !item.score.passed)) process.exitCode = 1;
}
function publicFailureCode(error) {
  // Our fixed codes contain no Provider response/body, path, key or token.
  const allowed = new Set(["HANDOFF_EVAL_ARGS_INVALID", "HANDOFF_EVAL_ABSOLUTE_PATH_REQUIRED", "HANDOFF_EVAL_REAL_CONFIG_REQUIRED",
    "HANDOFF_EVAL_OAUTH_MODEL_REQUIRED", "HANDOFF_EVAL_REAL_CONFIG_FORBIDDEN", "HANDOFF_PRIVATE_CONFIG_REQUIRED",
    "HANDOFF_CONFIG_INVALID", "HANDOFF_ENDPOINT_INVALID", "HANDOFF_PRIVATE_AUTH_REQUIRED", "HANDOFF_OAUTH_INVALID",
    "HANDOFF_OAUTH_MODEL_INVALID", "HANDOFF_CLI_INVALID", "HANDOFF_AUTH_MODE_INVALID", "HANDOFF_CLI_SPAWN_FAILED",
    "HANDOFF_CLI_INPUT_FAILED", "HANDOFF_CLI_OUTPUT_LIMIT", "HANDOFF_CLI_PROTOCOL_INVALID", "HANDOFF_CLI_EARLY_EXIT",
    "HANDOFF_CLI_TIMEOUT", "HANDOFF_MODEL_ISOLATION_FAILED", "HANDOFF_PROVIDER_REQUEST_FAILED", "HANDOFF_PROVIDER_RESPONSE_FAILED",
    "HANDOFF_MODEL_ANSWER_INVALID", "HANDOFF_CLI_EXIT_TIMEOUT", "HANDOFF_CLI_EXIT_FAILED", "HANDOFF_PROVIDER_LIMIT",
    "HANDOFF_PROVIDER_AUTH_FAILED", "HANDOFF_PROVIDER_NETWORK_FAILED", "HANDOFF_PROVIDER_MODEL_UNAVAILABLE", "HANDOFF_CLI_CONFIG_FAILED",
    "HANDOFF_PROXY_INVALID"]);
  if (allowed.has(error?.message)) return error.message;
  if (["EACCES", "EPERM", "ENOENT", "EEXIST"].includes(error?.code)) return "HANDOFF_LOCAL_FILE_UNAVAILABLE";
  return "HANDOFF_EVALUATION_FAILED";
}
if (require.main === module) main().catch(error => { console.error(publicFailureCode(error)); process.exitCode = 1; });
module.exports = { compiledCase, parseOptions, evaluate, publicFailureCode };
