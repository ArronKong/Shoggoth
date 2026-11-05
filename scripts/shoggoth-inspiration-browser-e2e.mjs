// Run inside the existing ego-browser TaskSpace; it owns no other browser/tab.
// Record the existing TaskSpace id as taskSpaceId in the fixture info JSON.
// ego-browser nodejs < scripts/shoggoth-inspiration-browser-e2e.mjs
// Requires the isolated inspiration-service-fixture and a production manage build.
// Start its fixture with INSPIRATION_FIXTURE_PERMISSION_MODE=request-approval for manual-approval coverage.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const info = JSON.parse(fs.readFileSync(process.env.INSPIRATION_FIXTURE_INFO || '/tmp/a307-inspiration-fixture.json', 'utf8'));
assert.ok(Number.isSafeInteger(info.taskSpaceId) && info.taskSpaceId > 0, 'Record the existing TaskSpace id in fixture info');
const task = await taskSpace(info.taskSpaceId);
const page = task.page(info.pageLabel || process.env.INSPIRATION_EGO_PAGE || 'p1');
const rounds = Number(process.env.INSPIRATION_ROUNDS || 50);
assert.ok(Number.isSafeInteger(rounds) && rounds > 0 && rounds <= 50);
const state = async () => (await fetch(info.stateUrl)).json();
const waitState = async (predicate) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await state(); if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('Timed out waiting for fixture state');
};
const baseline = await state();
assert.equal(baseline.runs.length, 0, 'Use a fresh isolated fixture');
await page.goto(info.url + '/#/inspirations');
await page.waitForSelector('textarea[aria-label="记一条灵感"]', { state: 'visible' });
await page.fill('textarea[aria-label="记一条灵感"]', '咖啡记录工具\n记录豆子、冲煮参数和每天的口味。');
await page.press('textarea[aria-label="记一条灵感"]', 'Enter');
await page.waitForSelector('article[data-inspiration-id]', { state: 'visible' });
const captured = await state();
assert.equal(captured.ideas.length, 1); assert.equal(captured.runs.length, 0);
assert.equal(captured.sessions.length, baseline.sessions.length);
const evidence = [];
const reportPath = process.env.INSPIRATION_E2E_REPORT || '/tmp/a307-inspiration-browser-e2e.json';
for (let round = 1; round <= rounds; round++) {
  await page.click('article[data-inspiration-id] button[data-inspiration-body]');
  // A seed is sent as it opens (first intent chosen); a later round picks a follow-up chip first.
  const start = '[role="dialog"] button[aria-label="发送"]';
  await page.waitForSelector(start, { state: 'visible' });
  if (round > 1) await page.click('[role="dialog"] button:text-is("继续深入")');
  await page.click(start);
  await page.waitForSelector('[role="dialog"] .chat-prompt', { state: 'visible', timeout: 25_000 });
  await page.click('[role="dialog"] button[aria-label="关闭"]');
  await page.click('[role="tab"][aria-label="生根"]');
  const wallStatus = 'article [data-inspiration-run-header]';
  await page.waitForSelector(wallStatus, { state: 'visible' });
  await page.hover(wallStatus);
  await page.focus(wallStatus);
  assert.equal(await page.evaluate(() => document.querySelectorAll('article .chat-prompt').length), 0);
  await page.click(wallStatus);
  await page.waitForSelector('[role="dialog"] .chat-prompt', { state: 'visible' });
  const waiting = await state();
  assert.equal(waiting.runs.length, round);
  assert.equal(waiting.sessions.length, baseline.sessions.length + 1);
  assert.ok(waiting.runs.every(run => run.source === 'inspiration'));
  assert.equal(waiting.runtimeContext?.result?.structuredContent?.source, 'inspiration');
  const inSession = round % 4 === 1 || round % 4 === 0;
  if (inSession) {
    await page.click('[role="dialog"] a[href*="/chat?"]');
    await page.waitForSelector('.chat-thread[data-history-loaded="true"]', { state: 'visible' });
    await page.waitForSelector('.chat-prompt', { state: 'visible' });
    if (round % 10 === 0) {
      await page.reload();
      await page.waitForSelector('.chat-thread[data-history-loaded="true"]', { state: 'visible' });
      await page.waitForSelector('.chat-prompt', { state: 'visible' });
    }
  }
  const scope = inSession ? '.chat-prompt' : '[role="dialog"] .chat-prompt';
  const decision = round % 2 === 1 ? (round % 4 === 1 ? 'Alpha' : 'Beta')
    : (round % 8 === 0 ? '拒绝' : '允许');
  if (round % 2 === 1) {
    const choice = `${scope} input[aria-label="${decision}"]`;
    // Chat restores the scroll position on entry; use the focused radio's keyboard action.
    await page.press(choice, 'Space');
    await page.waitForSelector(`${choice}:checked`, { state: 'visible' });
    await page.press(`${scope} button:text-is("提交")`, 'Enter');
  } else await page.press(`${scope} button:text-is("${decision}")`, 'Enter');
  await page.waitForSelector('.chat-prompt', { state: 'hidden' });
  const completed = await waitState(value => value.responses === round && value.runs.every(run => run.status === 'completed')
    && value.coordinator.pendingRequests === 0 && value.coordinator.domainCommands === 0
    && value.coordinator.runHostAssignments === 0);
  assert.equal(completed.errors.length, 0);
  if (inSession) {
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.chat-header__tools button')].some(button => button.textContent.includes('回到灵感'))), false);
    await page.click('a[aria-label="灵感便签"]');
    await page.waitForSelector('[role="dialog"] #inspiration-thread-input', { state: 'visible' });
    assert.ok((await page.url()).includes(`id=${captured.ideas[0].id}`));
  }
  await page.click('[role="dialog"] button[aria-label="关闭"]');
  await page.click('[role="tab"][aria-label="发芽"]');
  await page.waitForSelector('article[data-inspiration-id] [data-status="completed"]', { state: 'visible' });
  if (round % 10 === 0) {
    await page.reload();
    await page.waitForSelector('article[data-inspiration-id] [data-status="completed"]', { state: 'visible' });
  }
  evidence.push({ round, responseSurface: inSession ? 'session' : 'dialog', kind: round % 2 ? 'input' : 'approval', decision,
    runCount: completed.runs.length, sessions: completed.sessions.length, pending: completed.coordinator.pendingRequests });
  fs.writeFileSync(reportPath, JSON.stringify({ status: 'running', rounds, completed: round, evidence }, null, 2));
  if (round % 5 === 0) console.log(`PASS Inspiration UI ${round}/${rounds}; real bundle → REST/proxy → Backend/Service/Helper → fake Runtime`);
}
const final = await waitState(value => value.backend.prompts === 0 && value.backend.active === 0);
fs.writeFileSync(reportPath, JSON.stringify({
  status: 'passed', rounds, capturedWithoutRunOrSession: true, final: { responses: final.responses, sessions: final.sessions.length,
    helperAuthentications: final.helperAuthentications, coordinator: final.coordinator, backend: final.backend }, evidence,
}, null, 2));
console.log(`PASS ${rounds} Inspiration browser rounds, input/approval in the detail dialog and Session, reload recovery, one product Session, no duplicate Run or response`);
// The calling task performs additional visual checks and finishes the TaskSpace once.
