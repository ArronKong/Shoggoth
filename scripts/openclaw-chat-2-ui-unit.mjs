#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "..");
const pagePath = path.join(ROOT, "app/manage-ui/src/pages/ChatPage.tsx");
const source = fs.readFileSync(pagePath, "utf8");
const ast = ts.createSourceFile(pagePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const pureNames = new Set([
  "gatewayAdvertises",
  "gatewayHasScope",
  "gatewaySupportsQuestions",
  "gatewaySupportsProgressCards",
  "normalizeGatewayContract",
  "normalizeOpenClawQuestion",
  "normalizeOpenClawQuestionPrompt",
  "openClawQuestionResolveParams",
  "progressCardPlan",
  "normalizeOpenClawProgressCard",
]);
const pureSource = ast.statements
  .filter((statement) => ts.isFunctionDeclaration(statement) && statement.name && pureNames.has(statement.name.text))
  .map((statement) => statement.getText(ast))
  .join("\n");
assert.equal((pureSource.match(/function /g) ?? []).length, pureNames.size, "all OpenClaw chat helpers must remain testable");

const compiled = ts.transpileModule(`${pureSource}\nmodule.exports = { ${[...pureNames].join(", ")} };`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: pagePath,
}).outputText;
const module = { exports: {} };
vm.runInNewContext(`(function(module, exports) { ${compiled}\n})(module, module.exports);`, {
  module,
  exports: module.exports,
});
const helpers = module.exports;
const plain = (value) => JSON.parse(JSON.stringify(value));

const hello = {
  protocol: 4,
  server: { version: "2026.8.1", buildId: "build-1" },
  features: {
    methods: ["question.list", "question.resolve", "progressCard.get"],
    events: ["question.requested", "question.resolved", "progressCard.changed", "workboard.changed"],
    capabilities: ["tool-events"],
  },
  auth: {
    role: "operator",
    scopes: ["operator.read", "operator.questions"],
    deviceToken: "must-not-reach-renderer-state",
  },
  policy: {
    maxPayload: 1_000_000,
    maxBufferedBytes: 2_000_000,
    attachments: { maxBytes: 30, maxImageBytes: 20 },
  },
};
const contract = helpers.normalizeGatewayContract(hello);
assert.equal(helpers.gatewaySupportsQuestions(contract), true);
assert.equal(helpers.gatewaySupportsProgressCards(contract), true);
assert.equal(JSON.stringify(contract).includes("deviceToken"), false, "renderer snapshot must stay sanitized");
assert.equal(helpers.gatewaySupportsQuestions({
  ...contract,
  auth: { ...contract.auth, scopes: ["operator.read"] },
}), false, "questions require the explicit operator.questions scope");
assert.equal(helpers.gatewaySupportsQuestions({
  ...contract,
  features: { ...contract.features, events: ["question.requested"] },
}), false, "questions require both advertised lifecycle events");

const question = {
  id: "question-1",
  sessionKey: "agent:main",
  agentId: "main",
  runId: "run-1",
  createdAtMs: 1_000,
  expiresAtMs: 20_000,
  status: "pending",
  questions: [{
    questionId: "token",
    header: "Token",
    question: "Enter token",
    options: [],
    isSecret: true,
    secretStore: { name: "API_TOKEN", kind: "secret", allowedHosts: ["api.example.com"] },
  }],
  // A malformed producer must not make an answer value part of UI state.
  answers: { answers: { token: ["top-secret-value"] } },
};
const prompt = helpers.normalizeOpenClawQuestionPrompt(question, 10_000);
assert.equal(prompt.kind, "openclaw_question");
assert.equal(prompt.id, "question-1");
assert.equal(JSON.stringify(prompt).includes("top-secret-value"), false, "question projection must omit answer payloads");
assert.equal(helpers.normalizeOpenClawQuestionPrompt({ ...question, status: "answered" }, 10_000), null);
assert.equal(helpers.normalizeOpenClawQuestionPrompt(question, 20_000), null, "expired questions must not be restored");
assert.deepEqual(plain(helpers.openClawQuestionResolveParams("question-1", {
  action: "submit",
  questionAnswers: { token: ["top-secret-value"] },
})), {
  id: "question-1",
  answers: { answers: { token: ["top-secret-value"] } },
});
assert.deepEqual(plain(helpers.openClawQuestionResolveParams("question-1", { action: "cancel" })), {
  id: "question-1",
  cancel: true,
});

const rawCard = {
  sessionKey: "agent:main",
  revision: 7,
  updatedAt: 1234,
  markdown: "Working",
  steps: [
    { step: "Inspect", status: "completed" },
    { step: "Patch", status: "in_progress" },
  ],
};
const card = helpers.normalizeOpenClawProgressCard(rawCard, "agent:main");
assert.deepEqual(plain(card), rawCard);
assert.deepEqual(plain(helpers.progressCardPlan(card)), [
  {
    content: "Inspect",
    status: "completed",
    progressRevision: 7,
    progressUpdatedAt: 1234,
    progressMarkdown: "Working",
  },
  { content: "Patch", status: "in_progress" },
]);
assert.deepEqual(plain(helpers.progressCardPlan({
  ...card,
  revision: 8,
  steps: card.steps.map((step) => ({ ...step, status: "completed" })),
})), [], "a fully completed progress card must not carry into the next turn");
assert.equal(helpers.progressCardPlan({ ...card, revision: 9, steps: [] }).length, 1,
  "an empty or markdown-only progress card must remain visible");
assert.equal(helpers.normalizeOpenClawProgressCard({
  ...rawCard,
  steps: [{ step: "bad", status: "running" }],
}, "agent:main"), null, "progress status must match the 8.1 enum");

const respondStart = source.indexOf("const respondPrompt = useCallback(");
const respondEnd = source.indexOf("\n\n  // Switch the model", respondStart);
assert.ok(respondStart >= 0 && respondEnd > respondStart);
const respondSource = source.slice(respondStart, respondEnd);
assert.match(respondSource, /send\("question\.resolve", openClawQuestionResolveParams\(openClawQuestion\.id, data\)\)/);
assert.match(respondSource, /else \{\s*await send\("chat\.respond"/s, "legacy Hermes prompts must keep chat.respond");
assert.doesNotMatch(respondSource, /localStorage|console\./, "question answers must not enter persistent/log storage");
assert.match(respondSource, /if \(!openClawQuestion\) \{[\s\S]*timelineFeed\(sk,[\s\S]*\}/,
  "only the legacy prompt branch may write a prompt answer to the timeline");

assert.match(source, /f\.event === "gateway\.ready"[\s\S]*normalizeGatewayContract\(f\.payload\)/);
assert.match(source, /send\("question\.list", \{\}\)/);
assert.match(source, /send\("progressCard\.get", \{ sessionKey \}\)/);
assert.match(source, /progressEventEpochRef\.current\.get\(sessionKey\)[\s\S]*!== eventEpoch/,
  "a cleared/newer progress revision must fence late progressCard.get responses");
assert.match(source, /gatewaySupportsQuestions\(gatewayContractRef\.current\)/);
assert.match(source, /new CustomEvent\("shoggoth:surface-changed", \{\s*detail: \{ surface: "kanban", event: f\.event, payload: f\.payload \}/s);

console.log("openclaw-chat-2-ui-unit: PASS");
