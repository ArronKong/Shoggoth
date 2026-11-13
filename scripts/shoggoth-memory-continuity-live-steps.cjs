"use strict";

// Real-provider acceptance uses the repair worker's disposable account home,
// Service, memory store and Cron store. The choice is exactly B; a subsequent
// "每 3 小时" resolves B's two frequencies without repeating the task target.
const SCENARIOS = ["continuity-distractor", "continuity-save", "continuity-remove", "continuity-b", "continuity-create"];
const TARGET = /示例观测站|example observatory/iu;

async function runContinuity({ service, profile, result, send, scenario, session, check, redact }) {
  result.scenarios = Object.fromEntries(SCENARIOS.map(name => [name, { status: "not_run" }]));
  const target = session();
  let saved, removed, nativeBefore;
  const active = () => service.memoryStore.list(profile.id, { status: "active" }).filter(item => TARGET.test(item.content));
  const own = () => ["USER", "MEMORY"].map(kind => service.memoryEngine.readCanonical(profile.id, kind).content).join("\n");
  await scenario("continuity-distractor", async () => {
    const turn = await send(target, "为什么阴天看不清星星？用一句普通文字回答，不调用工具，也不创建任务。", "continuity-distractor");
    return { answer: redact(turn.answer) };
  });
  await scenario("continuity-save", async () => {
    const turn = await send(target, "请把这个偏好记到 USER.md：跟进示例观测站的维护公告，发布后提醒我。这轮只保存偏好。", "continuity-save");
    saved = active(); check(saved.length > 0 && TARGET.test(own()), "CONTINUITY_SAVE_MISSING");
    nativeBefore = turn.nativeSessionId;
    return { memoryIds: saved.map(item => item.id), answer: redact(turn.answer) };
  });
  await scenario("continuity-remove", async () => {
    // Fix the pending options, but do not tell the model which removal mode to
    // use. That choice must come from the actual tool contract/instructions.
    const turn = await send(target, "请从 USER.md 移除这条保存的偏好。我仍想定期检查，请用普通文字给出选项并结束本轮，不调用 request_user_input。A 每周检查；B 高频跟进（每 3 小时或每 8 小时）；C 自定频率。等我选定具体频率再创建。", "continuity-remove");
    removed = saved.map(item => service.memoryStore.get(profile.id, item.id));
    check(removed.every(item => item?.status === "deleted"), "CONTINUITY_NOT_DELETED");
    check(removed.every(item => service.memoryEngine.recallPolicy.getMemoryReason(profile.id, item) === "memory_removed"), "CONTINUITY_REMOVAL_MODE_WRONG");
    check(TARGET.test(turn.answer) && /B/iu.test(turn.answer) && /3|三/u.test(turn.answer), "CONTINUITY_OPTIONS_MISSING");
    check(active().length === 0 && !TARGET.test(own()), "CONTINUITY_RESAVED_DURING_REMOVAL");
    return { answer: redact(turn.answer), memoryRemoved: true };
  });
  await scenario("continuity-b", async () => {
    const turn = await send(target, "B", "continuity-b");
    const history = turn.material.flatMap(value => value.blocks || [])
      .filter(block => /transcript|history/u.test(block.id)).map(block => block.content || "").join("\n");
    check(TARGET.test(history) && /高频/u.test(history), "CONTINUITY_NATIVE_HISTORY_MISSING");
    check(/高频/u.test(turn.answer) && /3|三/u.test(turn.answer) && /8|八/u.test(turn.answer), "CONTINUITY_B_WRONG_OPTION");
    check(!/阴天|星星|云层/u.test(turn.answer), "CONTINUITY_B_DISTRACTED");
    check(active().length === 0 && !TARGET.test(own()), "CONTINUITY_RESAVED_AFTER_B");
    check(removed.every(item => service.memoryStore.get(profile.id, item.id)?.status === "deleted"), "CONTINUITY_MEMORY_REVIVED");
    check(turn.nativeSessionId !== nativeBefore, "CONTINUITY_NATIVE_NOT_RENEWED");
    return { answer: redact(turn.answer), memoryStillRemoved: true, nativeSessionRenewed: true };
  });
  await scenario("continuity-create", async () => {
    const turn = await send(target, "每 3 小时", "continuity-create");
    const jobs = service.nativeCronStore.listJobs({ profileId: profile.id });
    check(jobs.length === 1, "CONTINUITY_CRON_COUNT");
    const job = jobs[0];
    check(TARGET.test(job.prompt) && !/阴天|星星|云层/u.test(job.prompt), "CONTINUITY_CRON_WRONG_TARGET");
    check(job.schedule.kind === "every" && job.schedule.everyMs === 3 * 60 * 60 * 1000
      || job.schedule.kind === "cron" && /^(?:0|\*) (?:\*\/3|0,3,6,9,12,15,18,21) \* \* \*$/u.test(job.schedule.expr), "CONTINUITY_CRON_WRONG_FREQUENCY");
    check(active().length === 0 && !TARGET.test(own()), "CONTINUITY_CRON_RESAVED_MEMORY");
    return { answer: redact(turn.answer), task: redact(job.prompt), schedule: job.schedule,
      memoryStillRemoved: true, isolatedCronCreated: true };
  });
}

module.exports = { runContinuity, CONTINUITY_SCENARIOS: SCENARIOS };
