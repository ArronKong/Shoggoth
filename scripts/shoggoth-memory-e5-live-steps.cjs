"use strict";
const assert = require("node:assert/strict");
const { requiredTool } = require("./shoggoth-memory-live-worker.cjs");

// Only synthetic facts in a disposable Profile. Observe production MCP results;
// never substitute a fake model, bypass the controller or replay a write.
async function run({ service, profileId, workspace, createSession, send, result }) {
  const semantic = service.nativeMemorySemanticService;
  const calls = [], controller = service.mcpProductToolController;
  const originalHandle = controller.handle;
  controller.handle = async function(name, args, authority, scope) {
    try {
      const value = await originalHandle.call(this, name, args, authority, scope);
      if (!scope) {
        calls.push({ stage: result.stage, name, value });
      }
      return value;
    } catch (error) {
      if (!scope && authority.profileId === profileId) calls.push({
        stage: result.stage, name, errorCode: error.code,
      });
      throw error;
    }
  };
  const warm = async () => {
    const deadline = Date.now() + 30000;
    let attempts = 0;
    while (Date.now() < deadline) {
      // Run completion can still persist a checkpoint/session revision after
      // send() observes the terminal run. Await the current jobs, not a job
      // superseded by that legitimate source revision.
      const job = semantic.ensureMemory(profileId);
      const conversations = service.conversationRecallService._ensureSemantic(profileId);
      await Promise.all([job.promise, conversations.promise]); attempts++;
      if (job.state === "ready" && !job.cancelled
        && service.memoryEngine.semanticStamp(profileId) === job.stamp
        && conversations.state === "ready" && !conversations.cancelled
        && service.conversationRecallService._ensureSemantic(profileId)?.stamp === conversations.stamp) {
        (result.semanticWarmAttempts ||= []).push({ stage: result.stage, attempts }); return;
      }
      assert.notEqual(job.state, "unavailable", "memory index: " + JSON.stringify(semantic.status(profileId)));
      assert.notEqual(conversations.state, "unavailable", "conversation index: " + JSON.stringify(semantic.status(profileId, "conversation")));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail("Current source revisions did not finish indexing within 30 seconds");
  };
  const callsAt = stage => calls.filter(row => row.stage === stage && row.value);
  try {
    const first = createSession();
    const save = await send(first,
      "我的观鸟望远镜采用八倍放大和四十二毫米口径。请调用 memory_save 保存这条明确事实，"
      + "content 使用“我的观鸟望远镜采用八倍放大和四十二毫米口径”，"
      + "sourceQuote 使用“我的观鸟望远镜采用八倍放大和四十二毫米口径”。", "e5-save");
    requiredTool(save.tools, "memory_save");
    const target = service.memoryStore.list(profileId, { status: "active" })
      .find(item => item.content.includes("望远镜") && item.content.includes("四十二"));
    assert.ok(target, "real model must save binocular fact");
    const other = await send(first,
      "我的钢笔采用 F 尖，日常使用蓝黑色墨水。请调用 memory_save 保存这条明确事实，"
      + "content 使用“我的钢笔采用 F 尖，日常使用蓝黑色墨水”，"
      + "sourceQuote 使用“我的钢笔采用 F 尖，日常使用蓝黑色墨水”。", "e5-save-other");
    requiredTool(other.tools, "memory_save");
    const pen = service.memoryStore.list(profileId, { status: "active" })
      .find(item => item.content.includes("钢笔"));
    assert.ok(pen);
    await warm();
    // Legacy lexical search may return recent records even without a term match.
    // The production tool results below must carry real E5 scores and source proof.

    const second = createSession();
    const recalled = await send(second,
      "What magnification and objective diameter do my birdwatching binoculars have? "
      + "Use memory_search with this English query, memory_explain for the matching fact, "
      + "and conversation_search with the same English query in sessionId " + first.id
      + ". Use conversation_get to read the original source before answering. "
      + "Retry only a read if it reports rebuilding or a state conflict.", "e5-bilingual");
    for (const tool of ["memory_search", "memory_explain", "conversation_search", "conversation_get"]) {
      requiredTool(recalled.tools, tool);
    }
    const positive = callsAt("e5-bilingual");
    assert.ok(positive.some(row => row.name === "memory_search" && row.value.semantic?.status === "ready"
      && row.value.items.some(item => item.id === target.id && item.semanticScore >= 0.7)));
    assert.ok(positive.some(row => row.name === "memory_explain"
      && row.value.evidence?.status === "verified_quote" && row.value.evidence.sessionId === first.id));
    assert.ok(positive.some(row => row.name === "conversation_search" && row.value.semantic?.status === "ready"
      && row.value.results.some(item => target.sourceRefs.includes(item.eventId) && item.semanticEvidence)));
    assert.match(recalled.answers.join(" "), /(?:8|eight|八)/iu);
    assert.match(recalled.answers.join(" "), /(?:42|forty.two|四十二)/iu);

    const forgotten = await send(second,
      "请忘记之前保存的观鸟望远镜参数。先调用 memory_search 找到这条记忆，再调用 memory_forget，"
      + "sourceQuote 使用“请忘记之前保存的观鸟望远镜参数”。", "e5-forget");
    requiredTool(forgotten.tools, "memory_search"); requiredTool(forgotten.tools, "memory_forget");
    assert.equal(service.memoryStore.get(profileId, target.id).status, "deleted");
    assert.equal(service.memoryStore.get(profileId, pen.id).status, "active");
    await warm();
    const third = createSession();
    const after = await send(third,
      "What magnification and objective diameter do my birdwatching binoculars have? "
      + "Use memory_search and conversation_search with this English query, "
      + "restrict conversation_search to sessionId " + first.id
      + ". If no source supplies those parameters, answer 'unknown'. "
      + "A related fact about another object is not an answer.", "e5-after-forget");
    requiredTool(after.tools, "memory_search"); requiredTool(after.tools, "conversation_search");
    for (const row of callsAt("e5-after-forget")) {
      if (row.name === "memory_search") assert.ok(!row.value.items.some(item => item.id === target.id));
      if (row.name === "conversation_search") assert.ok(!row.value.results
        .some(item => target.sourceRefs.includes(item.eventId)));
    }
    assert.match(after.answers.join(" "), /unknown|don't know|do not know|not (?:available|known|found)|不知道/iu);
    assert.doesNotMatch(after.answers.join(" "), /(?:8\s*[×xX]|8\s*(?:times|fold)|42\s*mm|八倍|四十二)/iu);

    const fourth = createSession();
    const count = service.memoryStore.list(profileId, { status: "active" }).length;
    const unknown = await send(fourth,
      "How old is my father? Use memory_search to check. "
      + "If no original source states his age, say 'unknown'. Do not infer an age from other memories "
      + "and do not save a guess.", "e5-unknown");
    requiredTool(unknown.tools, "memory_search");
    assert.match(unknown.answers.join(" "), /unknown|don't know|do not know|not (?:available|known|found)|不知道/iu);
    assert.equal(service.memoryStore.list(profileId, { status: "active" }).length, count);
    assert.ok(!unknown.tools.some(tool => /(?:__|\/)memory_save$/u.test(tool) || tool === "memory_save"));
    return { status: "passed", modelId: semantic.status(profileId).modelId,
      realTurns: 6, sameSessionRepeatedSends: true, semanticMemoryAndOriginalRecall: true,
      provenanceVerified: true, forgetRevokesVectorAndOriginal: true, noUnknownFactInvented: true,
      toolCalls: { save: save.tools, other: other.tools, bilingual: recalled.tools,
        forget: forgotten.tools, afterForget: after.tools, unknown: unknown.tools },
      observedReads: calls.map(row => ({ stage: row.stage, name: row.name,
        ...(row.errorCode ? { errorCode: row.errorCode } : {
          semanticStatus: row.value.semantic?.status ?? null,
          memoryItems: row.value.items?.length ?? null, transcriptItems: row.value.results?.length ?? null,
        }) })),
    };
  } finally {
    result.p4ObservedCalls = calls.map(row=>({stage:row.stage,name:row.name,
      errorCode:row.errorCode??null,semanticStatus:row.value?.semantic?.status??null}));
    controller.handle = originalHandle;
  }
}
module.exports = { run };
