"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID: id } = require("node:crypto");
const { test } = require("node:test");
const { InspirationStore } = require("../app/agent-service/inspiration-store");
const { InspirationService, inspirationPrompt } = require("../app/agent-service/inspiration-service");
const { validateInspirationServiceParams, validateInspirationServiceResult } = require("../app/agent-service/inspiration-service-protocol");
const { inspirationUserText, inspirationPromptHash, projectInspirationHistory } = require("../app/core/inspiration-chat-history");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { fixture, until } = require("./fixtures/inspiration-coordinator-fixture.cjs");

test("display changes only exact user prompts, preserving source history, attachments and ordinary messages", () => {
  const attachment = { id: id(), name: "参考.png", mimeType: "image/png", size: 100 };
  const execution = { title: "灵感标题", body: "rsi 是什么\n\nAdditional user instructions for this turn:\n这也是原文", instruction: "举一个例子", attachments: [attachment] };
  const prompt = inspirationPrompt(execution, ["/private/fixture/参考.png"]);
  const image = { type: "image", url: "fixture-image" };
  const history = { cursor: "preserved", messages: [
    { id: "full", role: "user", content: prompt, timestamp: 123, runId: "run" },
    { id: "parts", role: "user", content: [{ type: "text", text: prompt.slice(0, 70) }, image,
      { type: "text", text: prompt.slice(70) }], shoggoth: { contextExcluded: false } },
    { id: "assistant", role: "assistant", content: prompt },
    { id: "ordinary", role: "user", content: "请解释 Guidelines: 这个词" },
    { id: "unmatched", role: "user", content: inspirationPrompt({ ...execution, body: "另一条灵感" }) },
    { id: "tool", role: "user", content: [{ type: "text", text: prompt }, { type: "tool_result", content: "done" }] },
  ] };
  const before = structuredClone(history);
  const projections = [{ promptHash: inspirationPromptHash(prompt), text: inspirationUserText(execution), attachments: [attachment] }];
  const shown = projectInspirationHistory(history, projections);
  assert.equal(shown.cursor, history.cursor);
  assert.equal(shown.messages[0].content[0].text, `${execution.title}\n\n${execution.body}\n\n本轮补充：\n举一个例子`);
  assert.equal(shown.messages[0].timestamp, 123);
  assert.equal(shown.messages[0].id, "full");
  assert.equal(shown.messages[0].runId, "run");
  assert.deepEqual(shown.messages[1].content[1], image);
  assert.deepEqual(shown.messages[1].shoggoth, { contextExcluded: false, attachments: [attachment] });
  assert.deepEqual(shown.messages.slice(2), history.messages.slice(2));
  assert.deepEqual(history, before);
  assert.deepEqual(projectInspirationHistory(shown, projections), shown);
  const mediaOnly = { body: "", title: null, instruction: "", attachments: [attachment] };
  const media = projectInspirationHistory({ messages: [{ role: "user", content: inspirationPrompt(mediaOnly) }] },
    [{ promptHash: inspirationPromptHash(inspirationPrompt(mediaOnly)), text: inspirationUserText(mediaOnly), attachments: [attachment] }]);
  assert.equal(media.messages[0].content[0].text, "");
  assert.deepEqual(media.messages[0].shoggoth.attachments, [attachment]);
});

test("persisted session snapshots paginate, survive edits/reopening and isolate backend, Agent and Session", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shg-insp-display-"));
  const store = new InspirationStore({ paths: { trustedRoot: root, stateDir: path.join(root, "state") } }).open();
  const service = new InspirationService({ store });
  t.after(() => { service.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const target = { backendId: "hermes", agentId: "main", sessionKey: "agent:main:display-fixture" };
  let idea = store.create({ operationId: id(), body: "第一版正文" });
  const prepare = (ideaId, scope = target, instruction = "") => {
    const execution = store.prepareExternalExecution({ operationId: id(), id: ideaId,
      expectedRevision: store.get(ideaId).revision, backendId: scope.backendId, agentId: scope.agentId,
      workspace: root, instruction }, () => true, scope.sessionKey);
    store.finishExternalBeforeStart(execution.id, { status: "canceled" });
    return execution;
  };
  const first = prepare(idea.id, target, "第一轮");
  idea = store.update({ id: idea.id, operationId: id(), expectedRevision: store.get(idea.id).revision,
    patch: { body: "第二版正文", title: "新标题" } });
  const second = prepare(idea.id, target, "第二轮");
  const huge = "x".repeat(16000);
  store.update({ id: idea.id, operationId: id(), expectedRevision: store.get(idea.id).revision, patch: { body: huge } });
  prepare(idea.id, target, huge);
  prepare(idea.id, target, huge);
  prepare(idea.id, { ...target, backendId: "openclaw" }, "另一后端");
  prepare(idea.id, { ...target, agentId: "other", sessionKey: "agent:other:display-fixture" }, "另一 Agent");
  prepare(idea.id, { ...target, sessionKey: "agent:main:other" }, "另一会话");
  store.close(); store.open(); service.open();
  const request = { ...target, cursor: null, limit: 50 };
  const page = await service.handle("inspiration.session.messages", request);
  assert.equal(page.total, 4);
  assert.equal(page.items.length, 1, "large display messages respect the response byte budget");
  assert.equal(page.hasMore, true);
  const owner = new ShoggothBackend({ maxPages: 10 });
  owner._call = (method, params) => service.handle(method, params);
  const history = { messages: [first, second].map((execution, index) => ({
    id: `user-${index}`, role: "user", content: service.buildPrompt(execution), timestamp: execution.createdAt,
  })) };
  const shown = await owner.projectExternalInspirationHistory(target, history);
  assert.equal(shown.messages[0].content[0].text, "第一版正文\n\n本轮补充：\n第一轮");
  assert.equal(shown.messages[1].content[0].text, "新标题\n\n第二版正文\n\n本轮补充：\n第二轮");
  assert.deepEqual(await owner.projectExternalInspirationHistory({ ...target, agentId: "other" }, history), history);
  assert.deepEqual(await owner.projectExternalInspirationHistory({ ...target, backendId: "openclaw" }, history), history);
  assert.match(history.messages[0].content, /^The user has captured/);
  const copied = structuredClone(page);
  copied.items[0].promptHash = "bad";
  assert.throws(() => validateInspirationServiceResult("inspiration.session.messages", copied), { code: "INSPIRATION_RESPONSE_INVALID" });
  for (const changed of [{ backendId: "shoggoth" }, { limit: 51 }, { sessionKey: "" }, { extra: true }]) {
    assert.throws(() => validateInspirationServiceParams("inspiration.session.messages", { ...request, ...changed }), { code: "INSPIRATION_INVALID" });
  }
});

test("native composer sends plain input; card continuation keeps its template, including after reopen and retry", async t => {
  const f = await fixture(t), submitted = [];
  const turnStart = f.host.turnStart.bind(f.host);
  f.host.turnStart = params => { submitted.push(structuredClone(params)); return turnStart(params); };
  const idea = await f.start(await f.create("rsi 是什么"), "简单解释");
  const run = await f.running(idea);
  assert.match(submitted[0].input[0].text, /^The user has captured/);
  const session = f.sessions.getSession(idea.latestExecution.sessionKey);
  assert.equal(f.transcript.listEvents(run.profileId, session.id).find(event => event.kind === "user").content.text,
    "rsi 是什么\n\n本轮补充：\n简单解释");
  f.host.complete(run); await until(() => f.dispatcher.getRun(run.id).status === "completed");
  const input = { operationId: id(), sessionKey: session.sessionKey, prompt: "举一个例子" };
  const next = f.service.sendFromSession(input);
  await f.running({ latestExecution: { runId: next.run.id } });
  assert.equal(submitted[1].input[0].text, input.prompt);
  assert.equal(f.store.executionForRun(next.run.id).inputSource, "chat");
  assert.equal(f.transcript.listEvents(run.profileId, session.id).filter(event => event.kind === "user").at(-1).content.text,
    input.prompt);
  f.host.complete(f.dispatcher.getRun(next.run.id));
  await until(() => f.dispatcher.getRun(next.run.id).status === "completed");
  await f.restart();
  assert.equal(f.service.buildPrompt(f.store.executionForRun(next.run.id)), input.prompt);
  assert.equal(f.service.sendFromSession(input).run.id, next.run.id);
  assert.equal(submitted.length, 2);
  const continued = await f.start((await f.call("get", { id: idea.id })).idea, "从灵感详情继续");
  await f.running(continued);
  assert.equal(continued.latestExecution.sessionKey, session.sessionKey);
  assert.match(submitted[2].input[0].text, /^The user has captured/);
  assert.match(submitted[2].input[0].text, /Additional user instructions for this turn:\n从灵感详情继续/);
  assert.equal(f.transcript.listEvents(run.profileId, session.id).filter(event => event.kind === "user").at(-1).content.text,
    "rsi 是什么\n\n本轮补充：\n从灵感详情继续");
});

test("composer only sends this turn's attachments and never reattaches the original card media", async t => {
  const f = await fixture(t), submitted = [];
  const turnStart = f.host.turnStart.bind(f.host);
  f.host.turnStart = params => { submitted.push(structuredClone(params)); return turnStart(params); };
  const upload = async name => {
    const data = Buffer.alloc(44); Buffer.from("89504e470d0a1a0a", "hex").copy(data);
    const attachment = { id: id(), name, mimeType: "image/png", size: data.length };
    await f.call("media.write", { attachment, offset: 0, content: data.toString("base64") });
    return attachment;
  };
  const original = await upload("原卡片.png"), current = await upload("本轮.png");
  const idea = await f.start((await f.call("create", { operationId: id(), body: "解释图片", attachments: [original] })).idea);
  let run = await f.running(idea);
  f.host.complete(run); await until(() => f.dispatcher.getRun(run.id).status === "completed");
  for (const [prompt, attachments] of [["继续解释", []], ["继续解释", [current]], ["", [current]]]) {
    const next = f.service.sendFromSession({ operationId: id(), sessionKey: idea.latestExecution.sessionKey,
      prompt, ...(attachments.length ? { attachments } : {}) });
    run = await f.running({ latestExecution: { runId: next.run.id } });
    const sent = submitted.at(-1);
    assert.doesNotMatch(sent.input[0].text, /The user has captured|原卡片\.png/);
    assert.equal(sent.input.filter(part => part.type === "localImage").length, attachments.length);
    const session = f.sessions.getSession(idea.latestExecution.sessionKey);
    const shown = f.transcript.listEvents(run.profileId, session.id).filter(event => event.kind === "user").at(-1);
    assert.equal(shown.content.text, prompt);
    assert.deepEqual(shown.content.attachments || [], attachments);
    f.host.complete(run); await until(() => f.dispatcher.getRun(run.id).status === "completed");
  }
});
