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
      activeKey: localStorage.getItem('shoggoth.chat.lastActive.v1'),
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
    // Cache only actual authenticated backend roster rows. Deep linking uses
    // the exact successful createSession receipts; no selection/readiness seed.
    await window.loadURL(`${allowedOrigin}/__api/config`);
    await js(`localStorage.clear();localStorage.setItem('openclaw.i18n.locale','zh-CN');
      localStorage.setItem('shoggoth.chat.immersive.v1','0');
      localStorage.setItem('shoggoth.chat.sessions.v1',${JSON.stringify(JSON.stringify(boot.sessions.map(item=>item.session)))});`);
    const operations=[];
    for(const [index,scenario]of boot.sessions.entries()){
      const params=new URLSearchParams({session:scenario.sessionKey,backend:'hermes'});
      await window.loadURL(boot.url+'?'+params.toString());await js(helpers);
      await until(async()=>await js('window.__jointUi.ready()')&&(await snap()).activeKey===scenario.sessionKey,'exact active named session and authenticated readiness enable actual picker');
      const before=await command('inspect');assert.equal(before.modelRequests,index*3);assert.equal(before.prepares,index);
      assert.equal((await snap()).selection[scenario.sessionKey]?.length||0,0);
      await js('window.__jointUi.choose()');await until(()=>js('window.__jointUi.check()'),'named installed shared catalog row');
      await until(async()=>(await snap()).selection[scenario.sessionKey]?.length===1,'real named selection click');
      assert.deepEqual((await snap()).selection[scenario.sessionKey],[{installationId:boot.installationId,revision:boot.revision}]);
      await capture(scenario.name+'-picker-selected');
      await js(`window.__jointUi.send(${JSON.stringify('HOLD_SELECTED '+scenario.tag)})`);
      let send;await until(async()=>{const state=await command('inspect');send=state.browserRequests.find(item=>item.method==='chat.send'&&item.params?.message?.includes(scenario.tag));return state.held&&send&&state.events.some(event=>event.kind==='bind:success'&&event.operationId===send.params.idempotencyKey);},'exact named bind before first model');
      assert.equal(send.params.sessionKey,scenario.sessionKey);
      await until(async()=>{const ui=await snap();return !ui.input&&(ui.selection[scenario.sessionKey]?.length||0)===0;},'exact named ACK consumes draft/choice');
      const accepted=await command('inspect');
      const ackIndex=accepted.deliveredFrames.findIndex(frame=>frame.type==='res'&&frame.ok&&frame.id===send.id&&frame.payload?.status==='started');
      const acceptedIndex=accepted.deliveredFrames.findIndex(frame=>frame.type==='event'&&frame.event==='chat'&&frame.payload?.state==='accepted'&&frame.payload?.runId===send.params.idempotencyKey);
      assert.ok(ackIndex>=0&&acceptedIndex>ackIndex);
      await capture(scenario.name+'-selected-accepted');await command('release-tool');
      await until(async()=>(await command('inspect')).events.some(event=>event.kind==='finish:success'&&event.operationId===send.params.idempotencyKey&&event.state==='completed'),'actual named model/tool/MCP/model Service completion');
      await until(async()=>{const ui=await snap();return !ui.stop&&!ui.pending.length&&!ui.verification&&ui.body.includes(scenario.tag)&&ui.body.includes(`Local MCP read returned ${boot.businessMarker} ${scenario.issueId}.`);},'actual named final transcript');
      const state=await command('inspect');assert.equal(state.modelRequests,(index+1)*3);assert.equal(state.prepares,index+1);
      for(const other of boot.sessions.filter(item=>item!==scenario))assert(!(await snap()).body.includes(other.tag),'another Agent transcript rendered in current chat');
      await capture(scenario.name+'-selected-completed');operations.push(send.params.idempotencyKey);
      checks.push(`${scenario.name}: actual named session/readiness -> picker -> selected send -> exact durable ACK -> Service bind -> model/tool/actual shared MCP/model -> current Agent final, with unchanged original ${scenario.name==='default'?'default':scenario.cloneFromDefault?'clone':'fresh'} gate config`);
    }
    const final=await command('inspect');assert.equal(final.modelRequests,9);assert.equal(final.prepares,3);assert.equal(final.browserRequests.filter(item=>item.method==='chat.send').length,3);
    checks.push('default, fresh and clone use the same real public package/connection/current Grant, independent actual Host Agent/session/adapter generations, and formal persistent Service audit correlation');
    const ui = await snap(); assert.deepEqual(ui.errors, []);
    await command('report', { passed: true, checks, screenshots, operations,
      geometry: await js('({width:innerWidth,scrollWidth:document.documentElement.scrollWidth})'),
      rendererTransport: 'unchanged real fetch and WebSocket; only DOM interactions, isolated routing cache bootstrap' });
    passed = true;
  } catch(error) {
    // Record the primary failure before diagnostic I/O; ENOSPC must not hide it.
    console.error(error.stack);
    const diagnostic = await snap().catch(() => null);
    try { fs.writeFileSync(path.join(boot.output, 'ui-failure.json'), JSON.stringify({ error: error.stack, checks, diagnostic }, null, 2)); }
    catch (diagnosticError) { console.error('UI diagnostic write failed: ' + diagnosticError.code); }
    await capture('ui-failure').catch(diagnosticError => console.error('UI diagnostic capture failed: ' + diagnosticError.code));
  } finally { window.destroy(); app.exit(passed ? 0 : 1); }
}).catch(error => { console.error(error.stack); app.exit(1); });
