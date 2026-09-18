// ego-browser nodejs < scripts/inspiration-growth-browser-e2e.mjs
// Uses an existing TaskSpace/Page and the isolated two-Agent Service fixture.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const info = JSON.parse(fs.readFileSync(process.env.INSPIRATION_FIXTURE_INFO || '/tmp/shoggoth-growth-fixture.json', 'utf8'));
const task = await taskSpace(info.taskSpaceId);
const page = task.page(info.pageLabel);
const rounds = Number(process.env.INSPIRATION_ROUNDS || 50);
const state = async () => (await fetch(info.stateUrl)).json();
const active = value => value.runs.filter(run => ['queued', 'starting', 'running', 'waiting_input', 'waiting_approval', 'unknown'].includes(run.status));
const waitState = async predicate => {
  for (let index = 0; index < 200; index++) {
    const value = await state(); if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('Timed out waiting for automatic growth');
};
const baseline = await state();
assert.equal(baseline.ideas.length, 0, 'Use a fresh, isolated fixture');
const initialSessions = baseline.sessions.length;
await page.goto(info.url + '/#/inspirations');
await page.waitForSelector('textarea[aria-label="记一条灵感"]', { state: 'visible' });
for (let index = 0; index < rounds; index++) {
  await page.fill('textarea[aria-label="记一条灵感"]', `自动生长验证 ${String(index + 1).padStart(2, '0')}：整理一个小想法`);
  await page.click('button[aria-label="存下灵感"]');
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="记一条灵感"]').value === '');
  if ((index + 1) % 10 === 0) console.log(`Captured ${index + 1}/${rounds} seeds through the real UI`);
}
assert.equal((await state()).runs.length, 0);
await page.click('button[aria-label="Agent 自动培育"]');
await page.click('button[aria-label="添加 Agent"]');
await page.waitForSelector('#inspiration-growth-executors [role="checkbox"]', { state: 'visible' });
assert.equal(await page.evaluate(() => document.querySelectorAll('#inspiration-growth-executors [role="checkbox"]').length), 2);
await page.click('#inspiration-growth-executors [role="checkbox"] >> nth=0');
await page.click('#inspiration-growth-executors [role="checkbox"] >> nth=1');
await page.click('button[aria-label="确认选择 Agent"]');
await page.click('[role="switch"]');
await page.click('button[aria-label="Agent 自动培育"]');
// The two profiles share a RuntimeAccount. Its existing admission limit may
// keep one assigned run queued while the other waits for input.
const started = await waitState(value => active(value).length === 2 && value.runs.some(run => run.status.startsWith('waiting_')));
assert.equal(started.growth.settings.executors.length, 2);
assert.equal(new Set(active(started).map(run => run.profileId)).size, 2);
await page.click('button[aria-label="生根"]');
const evidence = [];
for (let round = 1; round <= rounds; round++) {
  const before = await waitState(value => value.runs.some(run => run.status.startsWith('waiting_')));
  const live = active(before);
  assert.equal(new Set(live.map(run => run.profileId)).size, live.length, 'An Agent must never own two active inspiration runs');
  const run = before.runs.find(run => run.status.startsWith('waiting_'));
  const card = `article[data-inspiration-id="${run.sourceId}"]`;
  await page.waitForSelector(`${card} .chat-prompt`, { state: 'visible' });
  const inSession = round % 4 === 0;
  if (inSession) {
    await page.click(`${card} a[href*="/chat?"]`);
    await page.waitForSelector('.chat-prompt', { state: 'visible' });
  }
  const scope = inSession ? '.chat-prompt' : `${card} .chat-prompt`;
  if (run.status === 'waiting_input') {
    await page.click(`${scope} button:text-is("Alpha")`);
    await page.click(`${scope} button:text-is("提交")`);
  } else await page.click(`${scope} button:text-is("允许一次")`);
  const after = await waitState(value => value.runs.find(item => item.id === run.id)?.status === 'completed');
  assert.equal(after.runs.filter(item => item.sourceId === run.sourceId).length, 1, 'One seed must create only one successful run');
  if (inSession) {
    await page.click('a[aria-label="灵感便签"]');
    await page.waitForSelector('[role="dialog"]', { state: 'visible' });
    await page.click('button[aria-label="关闭"]');
    await page.click('button[aria-label="生根"]');
  }
  evidence.push({ round, runId: run.id, profileId: run.profileId, response: inSession ? 'session' : 'card', kind: run.status });
  fs.writeFileSync('/tmp/shoggoth-growth-browser-e2e.json', JSON.stringify({ completed: round, rounds, evidence }));
  if (round % 5 === 0) console.log(`PASS Auto growth ${round}/${rounds}; two executors; one active idea per executor`);
}
const final = await waitState(value => active(value).length === 0 && value.coordinator.pendingRequests === 0
  && value.coordinator.domainCommands === 0 && value.coordinator.runHostAssignments === 0);
assert.equal(final.runs.length, rounds); assert.equal(final.growth.failures.length, 0);
assert.equal(final.sessions.length, initialSessions + rounds);
await page.click('button[aria-label="发芽"]');
await page.waitForSelector('article [data-growth="sprout"]', { state: 'visible' });
await page.click('button[aria-label="Agent 自动培育"]');
await page.click('[role="switch"]');
await waitState(value => value.growth.settings.enabled === false);
fs.writeFileSync('/tmp/shoggoth-growth-browser-e2e.json', JSON.stringify({ status: 'passed', rounds, evidence,
  final: { runs: final.runs.length, sessions: final.sessions.length, memory: final.coordinator } }, null, 2));
console.log(`PASS Auto growth ${rounds} UI rounds; no pending requests, duplicate runs or occupied executor slots`);
console.log(await page.snapshot());
