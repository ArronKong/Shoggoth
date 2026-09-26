#!/usr/bin/env node
'use strict';

// Visual preview only: simulated WorkRuns, with optional live trajectory playback.
// Input/approval clicks settle sample records without executing their commands.
// All files belong to the fixture's temporary root, never the installed app.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { startInspirationFixture } = require('./fixtures/inspiration-service-fixture.cjs');
const { startInspirationTrajectoryDemo } = require('./fixtures/inspiration-trajectory-demo.cjs');
const { DEFAULT_AGENT_PROFILE_ID } = require('../app/agent-service/product-store');
const id = () => crypto.randomUUID();
const terminal = new Set(['completed', 'failed', 'interrupted', 'canceled', 'skipped']);

async function startPreview(port = 61805, { liveTrajectory = false } = {}) {
  const f = await startInspirationFixture({ port, agentCount: 3, hostOps: { async openPath(file) {
    const real = fs.realpathSync(file);
    if (!real.startsWith(f.root + path.sep) || !fs.statSync(real).isFile()) return 'Only this preview’s artifacts can be opened';
    return new Promise(resolve => execFile('/usr/bin/open', [real], { timeout: 10000 }, error => resolve(error ? 'Could not open preview artifact' : '')));
  } } });
  try {
    const service = f.service;
    const store = service.inspirationStore;
    const dispatcher = service.workDispatcher;
    const profile = service.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
    service.productStore.putAgentProfile({ ...profile, concurrency: { maxActive: 16, maxWorkspaceWrites: 16 } });
    const simulated = new Map();
    const pending = new Map();
    const observers = new Map();
    const watchSession = f.backend.watchSession.bind(f.backend);
    f.backend.watchSession = (key, hooks, options = {}) => {
      const execution = [...simulated.values()].find(value => key === `agent:${value.agentId}:${value.sessionKey}`);
      if (!execution) return watchSession(key, hooks, options);
      return new Promise(resolve => {
        const watchers = observers.get(execution.runId) || new Set();
        observers.set(execution.runId, watchers); watchers.add(hooks);
        const stop = () => { watchers.delete(hooks); if (!watchers.size) observers.delete(execution.runId); resolve(); };
        if (options.signal?.aborted) stop(); else options.signal?.addEventListener('abort', stop, { once: true });
      });
    };
    const notify = (execution, kind, content) => {
      for (const hooks of observers.get(execution.runId) || []) {
        if (kind === 'tool_call' || kind === 'tool_result') hooks.tool?.({
          toolCallId: content.toolCallId, name: content.tool.name, args: content.tool.displayArgs,
          phase: kind === 'tool_call' ? 'start' : 'result', result: content.tool.resultSummary,
          isError: content.tool.status === 'failed',
        });
        else if (kind === 'assistant') hooks.delta?.(content.text);
        else if (kind === 'status' && content.reasoning) hooks.thinking?.(content.reasoning.map(item => item.text).join(''));
      }
    };
    const append = (execution, kind, content) => {
      const session = service.chatSessionStore.getSession(execution.sessionKey);
      service.transcriptStore.appendEvent({ id: id(), profileId: execution.profileId,
        sessionId: session.id, runId: execution.runId, kind, content });
      notify(execution, kind, content);
    };
    const sample = (status, title, body, options = {}) => {
      let idea = store.create({ operationId: id(), body });
      idea = store.update({ id: idea.id, operationId: id(), expectedRevision: idea.revision,
        patch: { title, favorite: Boolean(options.favorite) } });
      if (status === 'saved') return idea;
      const workspace = path.join(f.root, 'samples', status, idea.id);
      fs.mkdirSync(workspace, { recursive: true });
      let execution = store.prepareExecution({ id: idea.id, operationId: id(), expectedRevision: idea.revision,
        instruction: '', agentId: profile.agentId, backendId: profile.backendId, profileId: profile.id, workspace }, () => true);
      const session = service.chatSessionStore.createSession({ operationId: id(), profileId: profile.id, workspace, createdAt: Date.now() });
      service.transcriptStore.ensureSession({ profileId: profile.id, sessionId: session.id });
      execution = store.bindSession(execution.id, session.sessionKey);
      simulated.set(execution.runId, execution);
      dispatcher.enqueue({ id: execution.runId, source: 'inspiration', sourceId: idea.id,
        idempotencyKey: `inspiration:${execution.operationId}`, profileId: profile.id, workspace });
      append(execution, 'user', { text: `${title}\n${body}` });
      if (status === 'canceled' || status === 'skipped') dispatcher.transition(execution.runId, status);
      else if (status !== 'queued') {
        dispatcher.admit(execution.runId);
        if (status !== 'starting') dispatcher.transition(execution.runId, 'running');
        if (status === 'waiting_input' || status === 'waiting_approval') {
          const type = status === 'waiting_input' ? 'prompt' : 'approval';
          const requestId = id();
          const payload = type === 'prompt' ? { requestId, message: '第一版想先记录哪一类咖啡？',
            requestedSchema: { type: 'object', properties: { coffee: { type: 'string', title: '优先支持',
              enum: ['handbrew', 'espresso'], oneOf: [{ const: 'handbrew', title: '手冲', description: '豆子、研磨与水温' },
                { const: 'espresso', title: '意式', description: '粉量、萃取时间与奶量' }] } }, required: ['coffee'] } }
            : { requestId, reason: '按类型整理下载文件前，需要你确认。此处为状态演示，不会移动真实文件。',
              command: 'mkdir -p downloads/{images,documents,archives}', cwd: workspace };
          dispatcher.transition(execution.runId, status, { waitingRequestId: requestId });
          store.recordAttention(execution.runId, { type, payload, occurredAt: Date.now() });
          pending.set(execution.runId, { type, payload });
          append(execution, type === 'prompt' ? 'input' : 'approval', { ...payload, transcriptType: type });
        } else if (terminal.has(status)) {
          dispatcher.transition(execution.runId, status, { resultSummary: options.result || null,
            errorCode: status === 'failed' ? 'DEMO_SOURCE_UNAVAILABLE' : status === 'interrupted' ? 'DEMO_SERVICE_RESTARTED' : null });
          if (options.result) append(execution, 'assistant', { text: options.result });
        }
      }
      if (options.archived) store.update({ id: idea.id, operationId: id(), expectedRevision: store.get(idea.id).revision, patch: { archived: true } });
      return store.get(idea.id);
    };

    sample('saved', '周末徒步地图', '把去过的山路、补给点和沿途风景记下来，做成自己的小地图。', { favorite: true });
    sample('saved', '城市声音收藏夹', '收集雨声、市场和地铁站的片段，留住一座城市的日常。');
    sample('canceled', '一周早餐计划', '先停一停，等空下来再整理轻松好做的早餐。');
    sample('skipped', '给未来的自己写封信', '想好了再开始，先把这个念头放在这里。');
    sample('completed', '每周阅读简报', '把收藏的文章整理成一页简报，留下值得继续研究的问题。',
      { favorite: true, result: '第一版简报已整理：\n\n- 3 个本周主题与阅读摘要\n- 每篇文章的一句话收获\n- 2 个可以继续深入的问题\n\n这是一份用于查看发芽状态的示例成果。' });
    sample('completed', '阳台植物照料表', '把光照、浇水和换盆时间做成一张容易执行的小表。',
      { result: '照料表的结构已完成，包含每周检查、浇水记录和季节提醒。示例成果可继续完善。' });
    sample('completed', '迷你读书角', '整理书单，给书桌留一小块安静的地方。',
      { archived: true, result: '书单与收纳清单已完成，这条示例灵感已经结果。' });
    sample('failed', '播客素材收集', '收集三期访谈的重点片段。资料源暂时不可用，可以换个来源后重试。');
    sample('interrupted', '旅行灵感手册', '行程整理到一半被中断，已经找到的线索保留在执行记录里。');
    sample('queued', '阳台小花园', '整理适合窗边的植物清单，等待 Agent 有空后开始。');
    sample('starting', '周报素材库', '正在整理工作目录与执行上下文，马上开始处理本周素材。');
    sample('waiting_input', '咖啡记录工具', '记录豆子、冲煮参数和每天的口味，先确定第一版的方向。');
    sample('waiting_approval', '下载文件整理助手', '方案已拟好，整理文件前先确认操作范围。');
    const walking = sample('running', '城市散步路线', '正在把书店、街角咖啡和安静的小路串起来，整理成两小时的散步路线。', { favorite: true });
    const walkingRun = store.latestExecution(walking.id);
    const output = path.join(walkingRun.workspace, '城市散步路线.html');
    fs.writeFileSync(output, '<!doctype html><meta charset="utf-8"><title>城市散步路线 · 验证样例</title><h1>两小时的城市散步路线</h1><p>书店 → 街角咖啡 → 林荫小路</p>');
    append(walkingRun, 'status', { transcriptType: 'reasoning', reasoning: [{ text: '先确认几个地点之间的距离，再整理成便于查看的路线。' }] });
    append(walkingRun, 'tool_call', { toolCallId: 'route-search', tool: { name: 'web_search', displayArgs: { query: '街区书店和步行路线' }, status: 'running' } });
    append(walkingRun, 'tool_result', { toolCallId: 'route-search', tool: { name: 'web_search', status: 'completed', resultSummary: '已找到 3 个停留地点。', durationMs: 1200 } });
    append(walkingRun, 'tool_call', { toolCallId: 'route-write', tool: { name: 'write_file', displayArgs: { path: output }, status: 'running' } });
    append(walkingRun, 'tool_result', { toolCallId: 'route-write', tool: { name: 'write_file', status: 'completed', resultSummary: `已保存 ${output}`, durationMs: 450 } });
    append(walkingRun, 'assistant', { text: '路线初稿已经保存，正在补充每段步行时间。' });
    append(walkingRun, 'tool_call', { toolCallId: 'route-check', tool: { name: 'read_file', displayArgs: { path: output }, status: 'running' } });

    // Only the seeded demonstrations use these deterministic interaction hooks.
    const coordinator = service.workRunCoordinator;
    const getSnapshot = coordinator.getRunSnapshot.bind(coordinator);
    coordinator.getRunSnapshot = runId => ({ ...getSnapshot(runId),
      ...(pending.has(runId) ? { interaction: pending.get(runId) } : {}) });
    const settle = (input, summary, canceled = false) => {
      const execution = simulated.get(input.runId);
      const run = dispatcher.getRun(input.runId);
      if (terminal.has(run.status)) return run;
      pending.delete(run.id);
      if (canceled) return dispatcher.transition(run.id, 'canceled');
      if (run.status.startsWith('waiting_')) dispatcher.transition(run.id, 'running');
      const completed = dispatcher.transition(run.id, 'completed', { resultSummary: summary });
      append(execution, 'assistant', { text: summary });
      return completed;
    };
    const respondInput = coordinator.respondInput.bind(coordinator);
    coordinator.respondInput = input => simulated.has(input.runId)
      ? Promise.resolve(settle(input, '示例已收到你的选择，第一版记录方案已生成。此处展示发芽后的状态。', input.action === 'cancel'))
      : respondInput(input);
    const respondApproval = coordinator.respondApproval.bind(coordinator);
    coordinator.respondApproval = input => simulated.has(input.runId)
      ? Promise.resolve(settle(input, input.choice === 'deny' ? '示例操作已拒绝，真实文件未发生变化。' : '示例授权已确认，整理方案已完成。未执行真实文件操作。', input.choice === 'cancel'))
      : respondApproval(input);
    const abort = coordinator.abort.bind(coordinator);
    coordinator.abort = input => simulated.has(input.runId)
      ? Promise.resolve(settle(input, '', true)) : abort(input);
    if (liveTrajectory) {
      append(walkingRun, 'tool_result', { toolCallId: 'route-check', tool: { name: 'read_file',
        status: 'completed', resultSummary: '已读取路线草稿，继续细化沿途停留建议。', durationMs: 600 } });
      const stopTrajectory = startInspirationTrajectoryDemo(f, notify);
      const close = f.close;
      f.close = async () => { stopTrajectory(); await close(); };
    }
    // Samples bypass startInspiration(), which normally syncs these Chat rows.
    // Keep the real history/observer route available to the demo as well.
    for (const execution of simulated.values()) {
      await f.backend._syncFederationTargetSession({ profileId: execution.profileId, sessionKey: execution.sessionKey }, f.backend._generation);
    }
    return f;
  } catch (error) { await f.close(); throw error; }
}

module.exports = { startPreview };
if (require.main === module) startPreview(Number(process.argv.slice(2).find(value => !value.startsWith('--')) || 61805),
  { liveTrajectory: process.argv.includes('--live-trajectory') }).then(f => {
  const info = { pid: process.pid, url: `${f.url}/#/inspirations`, activeUrl: `${f.url}/#/inspirations?filter=active`, root: f.root,
    demo: true, liveTrajectory: process.argv.includes('--live-trajectory'), ideas: f.service.inspirationStore.list().length };
  fs.writeFileSync('/tmp/a307-inspiration-preview.json', JSON.stringify(info), { mode: 0o600 });
  console.log(JSON.stringify(info));
  const stop = async () => { await f.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}).catch(error => { console.error(error); process.exitCode = 1; });
