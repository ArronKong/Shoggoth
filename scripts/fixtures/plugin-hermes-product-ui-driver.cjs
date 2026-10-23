'use strict';
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const boot = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
app.setPath('userData', path.join(path.dirname(process.argv[2]), 'private-electron-profile'));
const pending = new Map(); let sequence = 0;
process.on('message', message => {
  const item = pending.get(message?.id); if (!item) return; pending.delete(message.id);
  clearTimeout(item.timer); if (message.ok) item.resolve(message.value); else item.reject(Error(message.error));
});
function command(name, value) { return new Promise((resolve, reject) => {
  const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('fixture coordination timed out: ' + name)); }, 12000);
  pending.set(id, { resolve, reject, timer }); process.send({ type: 'fixture-command', id, command: name, value });
}); }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await check(); if (value) return value; await pause(50); }
  throw Error(label + ' timed out');
}
const helpers = `(() => {
  window.__jointErrors = []; window.addEventListener('error', event => window.__jointErrors.push(event.message));
  window.addEventListener('unhandledrejection', event => window.__jointErrors.push(String(event.reason)));
  const input = () => document.querySelector('.chat-composer__input');
  const picker = () => Array.from(document.querySelectorAll('button[aria-haspopup="dialog"]'))
    .find(button => /^(插件|Plugins)/.test(button.textContent || ''));
  const selection = () => JSON.parse(localStorage.getItem('shoggoth.chat.plugin-selection.v1') || '{}');
  const pending = () => JSON.parse(localStorage.getItem('shoggoth.chat.pending-native-sends.v1') || '[]');
  window.__jointUi = { ready: () => !!input() && !!picker() && !picker().disabled,
    picker: () => picker(), snapshot: () => ({ input: input()?.value || '', selection: selection(), pending: pending(),
      verification: document.querySelector('.chat-verification-banner')?.textContent || null,
      stop: !!document.querySelector('.chat-stop'), body: document.body.innerText, errors: window.__jointErrors }),
    choose: () => { picker().click(); },
    check: () => {
      const label = Array.from(document.querySelectorAll('[role="dialog"] label')).find(row => row.textContent?.includes('project-assistant'));
      const checkbox = label?.querySelector('input[type="checkbox"]');
      if (!checkbox || checkbox.disabled) return false; checkbox.click();
      document.querySelector('[role="dialog"] input[type="search"]')?.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true})); return true;
    },
    send: async value => {
      const field = input(); if (!field) throw Error('composer missing');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field,value);
      field.dispatchEvent(new Event('input',{bubbles:true})); await new Promise(resolve=>setTimeout(resolve,70));
      const button = document.querySelector('.chat-send[data-send-entry="composerButton"]');
      if (!button || button.disabled) throw Error('actual send button disabled'); button.click();
    }, stop: () => { const button=document.querySelector('.chat-stop'); if(!button)throw Error('actual Stop unavailable');button.click(); }
  };
})()`;
app.whenReady().then(async () => {
  const allowedOrigin = new URL(boot.url).origin;
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = /^(data:|blob:)/.test(details.url) || (() => { try { const url = new URL(details.url);
      return url.hostname === '127.0.0.1' && Number(url.port) === Number(new URL(allowedOrigin).port) && ['http:', 'ws:'].includes(url.protocol);
    } catch { return false; } })(); callback({ cancel: !allowed });
  });
  const window = new BrowserWindow({ show: false, width: 1240, height: 1000, webPreferences: { backgroundThrottling: false } });
  const checks = [], screenshots = []; let passed = false;
  const js = code => window.webContents.executeJavaScript(code, true);
  const snap = () => js('window.__jointUi?.snapshot()');
  const capture = async name => { const file = path.join(boot.output, name + '.png');
    fs.writeFileSync(file, (await window.webContents.capturePage()).toPNG()); screenshots.push(file); };
  try {
    // Bootstrap only navigation from an actual authenticated Host row, using
    // this fresh isolated origin. No readiness/selection/receipt is seeded.
    await window.loadURL(`${allowedOrigin}/__api/config`);
    await js(`localStorage.clear();localStorage.setItem('openclaw.i18n.locale','zh-CN');
      localStorage.setItem('shoggoth.chat.immersive.v1','0');
      localStorage.setItem('shoggoth.chat.sessions.v1',${JSON.stringify(JSON.stringify([boot.session]))});
      localStorage.setItem('shoggoth.chat.lastActive.v1',${JSON.stringify(boot.sessionKey)});`);
    await window.loadURL(boot.url); await js(helpers);
    await until(() => js('window.__jointUi.ready()'), 'actual authenticated readonly readiness enables real picker');
    const before = await command('inspect'); assert.equal(before.modelRequests, 0); assert.equal(before.prepares, 0);
    assert.equal((await snap()).selection[boot.sessionKey]?.length || 0, 0);
    checks.push('actual production ChatPage loads actual Hermes Host session; authenticated readiness enables picker with zero model and Service mint');
    const choose = async () => {
      await until(() => js('window.__jointUi.ready()'), 'picker ready'); await js('window.__jointUi.choose()');
      await until(() => js('window.__jointUi.check()'), 'installed public fixture catalog row');
      await until(async () => (await snap()).selection[boot.sessionKey]?.length === 1, 'real user click persists selection');
      const value = (await snap()).selection[boot.sessionKey]; assert.deepEqual(value, [{ installationId: boot.installationId, revision: boot.revision }]);
    };
    await choose(); await capture('actual-picker-selected');
    await js("window.__jointUi.send('HOLD_SELECTED JOINT_SUCCESS')");
    let first;
    await until(async () => { const state = await command('inspect');
      const send = state.browserRequests.find(item => item.method === 'chat.send' && item.params?.message?.includes('JOINT_SUCCESS'));
      if (state.held && send && state.events.some(event => event.kind === 'bind:success' && event.operationId === send.params.idempotencyKey)) { first = send; return true; } }, 'actual first selected model after Service bind');
    await until(async () => { const ui = await snap(); return !ui.input && (ui.selection[boot.sessionKey]?.length || 0) === 0; }, 'verified acceptance consumes exact draft/choice');
    const accepted = await command('inspect');
    const ackIndex = accepted.deliveredFrames.findIndex(frame => frame.type === 'res' && frame.ok && frame.id === first.id && frame.payload?.status === 'started');
    const acceptedIndex = accepted.deliveredFrames.findIndex(frame => frame.type === 'event' && frame.event === 'chat'
      && frame.payload?.state === 'accepted' && frame.payload?.runId === first.params.idempotencyKey);
    assert.ok(ackIndex >= 0 && acceptedIndex > ackIndex);
    await capture('actual-selected-accepted'); await command('release-tool');
    await until(async () => { const state = await command('inspect'); return state.events.some(event => event.kind === 'finish:success'
      && event.operationId === first.params.idempotencyKey && event.state === 'completed'); }, 'Service completes actual model/production facade/MCP/model');
    await until(async () => { const ui = await snap(); return !ui.stop && !ui.pending.length && !ui.verification && ui.body.includes(`Local MCP read returned ${boot.businessMarker} fixture-001.`) && ui.body.includes('JOINT_SUCCESS'); }, 'actual persisted user/assistant transcript');
    assert.equal((await command('inspect')).modelRequests, 3); await capture('actual-selected-completed');
    checks.push('real picker click -> selected chat.send -> durable Host ACK then accepted -> exact one-shot draft consumed -> actual model/production tool_describe/tool_call facade/real read-only MCP child/model/final transcript');

    await choose(); await js("window.__jointUi.send('HOLD_SELECTED JOINT_STOP')");
    let stopped;
    await until(async () => { const state = await command('inspect'); stopped = state.browserRequests.find(item => item.method === 'chat.send'
      && item.params?.message?.includes('JOINT_STOP')); return state.held && stopped && state.events.some(event => event.kind === 'bind:success'
      && event.operationId === stopped.params.idempotencyKey); }, 'second real model held');
    await until(async () => (await snap()).stop, 'actual Stop button'); await js('window.__jointUi.stop()');
    await until(async () => (await command('inspect')).events.some(event => event.kind === 'finish:success'
      && event.operationId === stopped.params.idempotencyKey && event.state === 'canceled'), 'real Stop cancels Service selection');
    await command('discard-held');
    const afterStop = await command('inspect'); assert.equal(afterStop.modelRequests, 4);
    assert.equal(afterStop.events.some(event => event.kind === 'call:request' && event.operationId === stopped.params.idempotencyKey), false);
    await until(async () => { const ui = await snap(); return !ui.stop && !ui.pending.length && !ui.verification; }, 'Stop durable observation clears actual UI pending/generation state'); await capture('actual-selected-stopped');
    checks.push('actual ChatPage Stop -> real chat.abort -> Host aborted -> Service canceled; zero MCP egress or extra model request for selection canceled while its actual model response was held');

    await choose(); await command('arm-lost-ack'); await js("window.__jointUi.send('HOLD_SELECTED JOINT_LOST_ACK')");
    const lost = await until(async () => { const state = await command('inspect'); return state.dropped && state; }, 'real accepted event after durable Host ACK transport cut');
    const originalId = lost.dropped.operationId;
    const beforeReload = await snap(); assert.ok(beforeReload.pending.some(entry => entry.idem === originalId && entry.key === boot.sessionKey));
    assert.equal(lost.dropped.runId, originalId);
    await capture('actual-lost-ack-pending');
    await window.loadURL(boot.url); await until(() => js('!!document.querySelector(".chat-composer__input")'), 'actual reload'); await js(helpers);
    await until(async () => (await command('inspect')).browserRequests.some(item => item.method === 'chat.operation.get'
      && item.params?.idempotencyKey === originalId && item.params?.sessionKey === boot.sessionKey), 'reload observes original selected operation');
    const observed = await command('inspect');
    assert.equal(observed.browserRequests.filter(item => item.method === 'chat.send' && item.params?.idempotencyKey === originalId).length, 1);
    assert.equal(observed.forwards.filter(value => value === originalId).length, 1); assert.equal(observed.prepares, 3);
    await until(async () => { const ui = await snap(); return (ui.selection[boot.sessionKey]?.length || 0) === 0; }, 'exact observed durable acceptance consumes original choice');
    await command('release-tool');
    await until(async () => (await command('inspect')).events.some(event => event.kind === 'finish:success'
      && event.operationId === originalId && event.state === 'completed'), 'observed original completes');
    await until(async () => { const ui = await snap(); return !ui.stop && !ui.pending.length && !ui.verification && ui.body.includes('JOINT_LOST_ACK') && ui.body.includes(`Local MCP read returned ${boot.businessMarker} fixture-002.`); }, 'original final visible after reload');
    const final = await command('inspect'); assert.equal(final.modelRequests, 7); assert.equal(final.prepares, 3);
    assert.equal(final.browserRequests.filter(item => item.method === 'chat.send').length, 3);
    await capture('actual-lost-ack-observed');
    checks.push('real browser TCP loses accepted observation after durable Host ACK; original operation persists across reload, only operation.get/history observe it, no resend/new operation/extra prepare, final transcript resolves original');
    const ui = await snap(); assert.deepEqual(ui.errors, []);
    await command('report', { passed: true, checks, screenshots, originalLostOperation: originalId,
      geometry: await js('({width:innerWidth,scrollWidth:document.documentElement.scrollWidth})'),
      rendererTransport: 'unchanged real fetch and WebSocket; only DOM interactions, isolated routing cache bootstrap' });
    passed = true;
  } catch(error) {
    const diagnostic = await snap().catch(() => null);
    fs.writeFileSync(path.join(boot.output, 'ui-failure.json'), JSON.stringify({ error: error.stack, checks, diagnostic }, null, 2));
    await capture('ui-failure').catch(() => {}); console.error(error.stack);
  } finally { window.destroy(); app.exit(passed ? 0 : 1); }
}).catch(error => { console.error(error.stack); app.exit(1); });
