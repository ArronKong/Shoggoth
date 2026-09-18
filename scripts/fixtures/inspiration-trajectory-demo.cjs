'use strict';

// Preview-only transcript playback. Tool names and results below are simulated;
// no model, shell command, network request, or real workspace operation is run.
const { randomUUID } = require('node:crypto');
const terminal = new Set(['completed', 'failed', 'interrupted', 'canceled', 'skipped']);
const thinking = (text, delayMs = 3600) => ({ kind: 'status', delayMs,
  content: () => ({ transcriptType: 'reasoning', reasoning: [{ text }] }) });
const say = (text, delayMs = 4200) => ({ kind: 'assistant', delayMs, content: () => ({ text }) });
const call = (key, name, displayArgs, delayMs = 4800) => ({ kind: 'tool_call', delayMs,
  content: prefix => ({ toolCallId: `${prefix}-${key}`, tool: { name, displayArgs, status: 'running' } }) });
const result = (key, name, resultSummary, delayMs = 3200, failed = false) => ({ kind: 'tool_result', delayMs,
  content: prefix => ({ toolCallId: `${prefix}-${key}`, tool: { name, resultSummary,
    status: failed ? 'failed' : 'completed', durationMs: 3600 } }) });

const scenarios = [
  { title: '城市散步路线', offset: 0, steps: [
    thinking('先确认书店、咖啡馆和公园的位置，把路线控制在两小时以内。'),
    call('brief', 'read_file', { path: '路线说明.md' }),
    result('brief', 'read_file', '已确认偏好：安静的小路、独立书店，中途留一次咖啡休息。'),
    say('正在比较三个停留点的位置，优先选择少绕路的顺序。'),
    call('places', 'web_search', { query: '独立书店 街角咖啡 林荫步道 步行距离' }, 5600),
    result('places', 'web_search', '找到 3 个合适的停留点，步行距离约 4.2 公里。'),
    thinking('书店到咖啡馆这一段较长，换一条经过公园的小路会更舒服。'),
    call('route', 'write_file', { path: '城市散步路线.html' }),
    result('route', 'write_file', '路线草稿已整理：书店 → 咖啡馆 → 林荫步道。'),
    say('正在补充每段步行时间、营业时间和下雨时的备选路线。', 5100),
    call('review', 'read_file', { path: '城市散步路线.html' }),
    result('review', 'read_file', '已检查路线顺序，继续细化沿途停留建议。', 4200),
  ] },
  { title: '周报素材库', offset: 1500, steps: [
    thinking('先按主题整理本周记录，再提取值得放进周报的进展。', 4100),
    call('notes', 'read_file', { path: '本周工作记录.md' }, 5300),
    result('notes', 'read_file', '读取了 8 条记录，正在合并重复内容。'),
    say('已分成产品进展、用户反馈和下周计划三个主题。'),
    call('source', 'web_search', { query: '补充产品发布记录中的参考资料' }, 5100),
    result('source', 'web_search', '资料源暂时没有响应，正在准备备用来源。', 3900, true),
    thinking('可以先用已有记录继续整理，稍后补齐缺失的引用。', 3600),
    call('draft', 'write_file', { path: '每周简报.md' }),
    result('draft', 'write_file', '三个主题的摘要已整理，继续检查日期和重复项。'),
    say('正在把较长的描述压缩成一句话，保留关键结果。', 5200),
  ] },
  { title: '阳台小花园', offset: 2800, steps: [
    thinking('先按光照和打理频率筛选，优先考虑容易养护的植物。', 4400),
    call('light', 'read_file', { path: '阳台光照记录.md' }, 4200),
    result('light', 'read_file', '上午有约 3 小时日照，下午以明亮散射光为主。', 3700),
    call('plants', 'web_search', { query: '适合半日照阳台 耐旱 容易养护的植物' }, 5800),
    result('plants', 'web_search', '筛选出迷迭香、薄荷和天竺葵，正在比较养护要求。'),
    say('正在按浇水频率分组，让日常照料更省心。', 4800),
    call('table', 'write_file', { path: '阳台植物照料表.md' }, 4400),
    result('table', 'write_file', '已整理每周浇水和光照检查清单。'),
    thinking('还要补充换盆与夏季遮阴提醒，避免只给出植物名单。', 5200),
    say('继续核对每种植物的季节差异，完善照料安排。', 4200),
  ] },
];

function startInspirationTrajectoryDemo(fixture, notify = () => {}) {
  const service = fixture.service;
  const timers = new Set();
  let stopped = false;
  const stop = () => { stopped = true; for (const timer of timers) clearTimeout(timer); timers.clear(); };
  const schedule = (callback, delay) => {
    if (stopped) return;
    const timer = setTimeout(() => { timers.delete(timer); if (!stopped) callback(); }, delay);
    timer.unref?.();
    timers.add(timer);
  };
  for (const scenario of scenarios) {
    const idea = service.inspirationStore.list().find(value => value.title === scenario.title);
    const execution = idea && service.inspirationStore.latestExecution(idea.id);
    const session = execution && service.chatSessionStore.getSession(execution.sessionKey);
    if (!execution || !session) continue;
    const play = (index = 0, cycle = 0) => {
      const run = service.workDispatcher.getRun(execution.runId);
      if (!run || terminal.has(run.status)) return;
      if (run.status.startsWith('waiting_')) { schedule(() => play(index, cycle), 3000); return; }
      try {
        if (run.status === 'queued') service.workDispatcher.admit(run.id);
        if (['queued', 'starting'].includes(run.status)) service.workDispatcher.transition(run.id, 'running');
        const step = scenario.steps[index];
        const content = step.content(`demo-${execution.runId}-${cycle}`);
        service.transcriptStore.appendEvent({ id: randomUUID(), profileId: execution.profileId,
          sessionId: session.id, runId: execution.runId, kind: step.kind,
          content });
        notify(execution, step.kind, content);
        const next = (index + 1) % scenario.steps.length;
        schedule(() => play(next, cycle + (next === 0 ? 1 : 0)), step.delayMs);
      } catch (error) {
        // Keep a failed demo from appending more events into a closing fixture.
        stop();
        console.error('[inspiration-trajectory-demo]', error.message);
      }
    };
    schedule(() => play(), scenario.offset);
  }
  return stop;
}

module.exports = { startInspirationTrajectoryDemo };
