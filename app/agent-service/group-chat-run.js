"use strict";

// 群聊成员回合与群任务运行都沿用原生 chat.send，以 operationId 前缀标识来源。读取侧按
// 「非直接聊天」收窄（D3），写入侧沿用默认机制（R1），见群聊开发计划 §8.2。
const GROUP_TURN_OPERATION_PREFIX = "group-turn-";
const GROUP_TASK_OPERATION_PREFIX = "group-task-";
const GROUP_SESSION_OPERATION_PREFIX = "group-session-";
const GROUP_TURN_IDEMPOTENCY_PATTERN = /^shoggoth:chat-send:group-turn-/u;
const GROUP_TASK_IDEMPOTENCY_PATTERN = /^shoggoth:chat-send:group-task-/u;

function isGroupChatRun(run) {
  return run?.source === "chat" && typeof run.idempotencyKey === "string"
    && (GROUP_TURN_IDEMPOTENCY_PATTERN.test(run.idempotencyKey) || GROUP_TASK_IDEMPOTENCY_PATTERN.test(run.idempotencyKey));
}

/** 群运行指向哪里：讨论回合（机会 id）或任务尝试（尝试 id）。 */
function groupRunTarget(run) {
  if (!isGroupChatRun(run)) return null;
  if (GROUP_TURN_IDEMPOTENCY_PATTERN.test(run.idempotencyKey)) {
    return { kind: "turn", opportunityId: run.idempotencyKey.replace(GROUP_TURN_IDEMPOTENCY_PATTERN, "") };
  }
  return { kind: "task", attemptId: run.idempotencyKey.replace(GROUP_TASK_IDEMPOTENCY_PATTERN, "") };
}

module.exports = {
  GROUP_TURN_OPERATION_PREFIX,
  GROUP_TASK_OPERATION_PREFIX,
  GROUP_SESSION_OPERATION_PREFIX,
  GROUP_TURN_IDEMPOTENCY_PATTERN,
  GROUP_TASK_IDEMPOTENCY_PATTERN,
  groupRunTarget,
  isGroupChatRun,
};
