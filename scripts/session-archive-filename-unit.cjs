"use strict";

const assert = require("node:assert/strict");
const {
  archiveTranscriptStemCandidates,
  findArchiveTranscriptFile,
} = require("../app/core/openclaw-backend");

// 先明确接口缺失，而不是让后续调用以 TypeError 的形式中断测试。
assert.equal(
  typeof archiveTranscriptStemCandidates,
  "function",
  "归档读取器必须导出 Topic transcript stem 推导 helper",
);
assert.equal(
  typeof findArchiveTranscriptFile,
  "function",
  "归档读取器必须导出精确 transcript 文件匹配 helper",
);

// Topic 会话的 sessionFile 带业务后缀；前代 UUID 必须继承后缀，再回退尝试裸 UUID。
function testTopicSessionKeepsItsTranscriptSuffix() {
  const currentId = "current-uuid";
  const priorId = "prior-uuid";
  const entry = {
    sessionId: currentId,
    sessionFile: `/tmp/${currentId}-topic-3.jsonl`,
  };

  assert.deepEqual(
    archiveTranscriptStemCandidates(entry, priorId),
    [`${priorId}-topic-3`, priorId],
  );
}

// 精确 reset 前缀只接受 transcript，不能把同 UUID 的 trajectory sidecar 当作聊天记录。
function testTopicResetLookupExcludesTrajectorySidecars() {
  const priorId = "prior-uuid";
  const found = findArchiveTranscriptFile(
    [
      `${priorId}-topic-3.trajectory.jsonl`,
      `${priorId}-topic-3.jsonl.reset.2026-07-10T00-00-00.000Z`,
    ],
    [`${priorId}-topic-3`, priorId],
  );

  assert.deepEqual(found, {
    file: `${priorId}-topic-3.jsonl.reset.2026-07-10T00-00-00.000Z`,
    fromReset: true,
  });
}

// 没有后缀的普通会话仍须沿用原有裸 UUID transcript 查找行为。
function testBareTranscriptRemainsTheFallback() {
  const priorId = "prior-uuid";
  assert.deepEqual(
    findArchiveTranscriptFile([`${priorId}.jsonl`], [`${priorId}-topic-3`, priorId]),
    { file: `${priorId}.jsonl`, fromReset: false },
  );
}

testTopicSessionKeepsItsTranscriptSuffix();
testTopicResetLookupExcludesTrajectorySidecars();
testBareTranscriptRemainsTheFallback();
console.log("[session-archive-filename-unit] PASS");
