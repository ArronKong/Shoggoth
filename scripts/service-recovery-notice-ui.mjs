#!/usr/bin/env node
// Full React ChatPage and ServiceSettings; isolated Electron profile, synthetic API/WS only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const root = path.resolve(process.env.SHOGGOTH_TEST_SOURCE_ROOT || path.join(import.meta.dirname, '..'));
const uiRequire = createRequire(path.join(root, 'app/manage-ui/package.json'));
const { build } = uiRequire('esbuild');
const { MIN_WINDOW_BOUNDS } = uiRequire(path.join(root, 'app/core/config-store'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shoggoth-recovery-notice-ui-'));
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex < 0 ? fs.mkdtempSync(path.join(os.tmpdir(), 'shoggoth-recovery-notice-proof-'))
  : path.resolve(process.argv[outputIndex + 1]);
const fixture = String.raw`
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import ChatPage from './app/manage-ui/src/pages/ChatPage';
import ServiceSettings from './app/manage-ui/src/pages/settings/ServiceSettings';
import { UiProvider } from './app/manage-ui/src/components/ui';
import ScrollbarProvider from './app/manage-ui/src/components/ScrollbarProvider';
import { FALLBACK_BACKEND_DESCRIPTORS } from './app/manage-ui/src/lib/backends';
import i18n from './app/manage-ui/src/i18n';
import './app/manage-ui/src/styles.css';
import './app/manage-ui/src/manage-skin.css';
const state = window as any, options = new URLSearchParams(location.search);
const surface = options.get('surface') || 'chat', immersive = options.has('immersive');
const language = options.get('lang') || 'zh-CN';
const now = Date.now(), agentId = 'shoggoth-recovery-fixture';
const key = 'agent:' + agentId + ':11111111-1111-4111-8111-111111111111';
const operationId = 'preserve-original-operation', pendingKey = 'shoggoth.chat.pending-native-sends.v1';
const originalPending = [{ key, idem: operationId, at: now - 60000, backendId: 'shoggoth', accepted: true, terminalObserved: true }];
const sessions = [{ key, agentId, agentName: 'Fixture recovery agent', backendId: 'shoggoth', model: 'fixture-model', updatedAt: now }];
const history = Array.from({ length: 60 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user',
  content: '已保存的历史-fixture-' + index + '\n' + '用于验证长历史和恢复提示的合成内容。'.repeat(12), timestamp: now - (60 - index) * 1000 }));
const group = { group: { id: 'recovery-group', name: 'Saved group recovery fixture', purpose: '', status: 'active', createdAt: now,
  updatedAt: now, metadataRevision: 1, rosterRevision: 1, directoryRevision: 1, controlEpoch: 0, lastSeq: 0 },
  members: [{ id: 'a', groupId: 'recovery-group', backendId: 'shoggoth', agentId, displayName: 'Fixture recovery agent', handle: 'a', state: 'active', position: 0, joinedSeq: 0, leftSeq: null }],
  discussion: null, activeTurns: [], queuedMemberIds: [], internalSessionKeys: [], pendingInteractions: [], tasks: [] };
let mode = 'unknown', statusReads = 0, sent = 0, backgroundActions = 0, apiWrites = 0, observed: any[] = [];
window.addEventListener('error', event => { state.fixtureError = event.error?.stack || event.message; });
window.addEventListener('unhandledrejection', event => { state.fixtureError = String(event.reason?.stack || event.reason); });
window.fetch = async (input, init = {}) => {
  const url = new URL(String(input), location.href);
  if (init.method && init.method !== 'GET') {
    apiWrites++; if (url.pathname.includes('/shoggoth/background')) backgroundActions++;
    throw Error('Unexpected fixture API write: ' + url.pathname);
  }
  let payload: any = {};
  if (url.pathname === '/__api/status') {
    statusReads++;
    if (mode === 'unavailable') return new Response('{}', { status: 503 });
    payload = { backends: [{ id: 'shoggoth', connected: mode === 'healthy', info: {
      readyAgentIds: mode === 'healthy' ? [agentId] : [],
      ...(mode === 'starting' ? { starting: true } : mode === 'fault' ? { recoveryCode: 'SERVICE_RECOVERY_REQUIRED' }
        : mode === 'unknown' ? { recoveryCode: 'SERVICE_RECOVERY_REQUIRED_EXTRA' } : { recoveryCode: 'REQUEST_TIMEOUT' }),
    } }, { id: 'openclaw', connected: true, info: { readyAgentIds: ['main'] } }] };
  } else if (url.pathname === '/__api/backends') payload = { backends: FALLBACK_BACKEND_DESCRIPTORS };
  else if (url.pathname === '/__api/config') payload = { config: { locale: language, theme: 'light', disabledBackends: [], setupCompletedAt: 1 } };
  else if (url.pathname === '/__api/group-chats') payload = { groups: [group], enabled: true };
  else if (url.pathname === '/__api/group-chats/detail') payload = group;
  else if (url.pathname === '/__api/group-chats/messages') payload = { messages: [], hasMore: false };
  else if (url.pathname === '/__api/plugins/selection-readiness') payload = { version: 1, supported: false };
  else if (url.pathname === '/__api/plugins') payload = { page: { supported: true, catalogRevision: 'a'.repeat(64), items: [], nextCursor: null } };
  else if (url.pathname === '/__api/plugins/bundled') payload = { batchDigest: 'a'.repeat(64), items: [] };
  else if (url.pathname === '/__api/chat/capabilities') payload = { attachments: {}, slash: false, maxPromptBytes: 61440 };
  else if (url.pathname === '/__api/chat/slash') payload = { supported: false, commands: [] };
  else if (url.pathname === '/__api/chat/cache-scope') payload = { backendId: 'shoggoth', cacheScope: 'service-recovery-notice-fixture' };
  else if (url.pathname.includes('runtime-models')) payload = { selection: { canSwitch: false, bindingId: 'fixture', model: 'fixture-model' }, capabilities: { attachments: {}, slash: false },
    models: [{ id: 'fixture-model', name: 'Fixture', bindingId: 'fixture', isDefault: true }], runtimes: [] };
  else if (url.pathname === '/__api/models') payload = { models: [{ id: 'fixture-model', name: 'Fixture', provider: 'fixture', backendId: 'shoggoth' }] };
  else if (url.pathname.endsWith('/archive')) payload = { archive: { supported: false, segments: [] } };
  return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
};
class FixtureSocket {
  static OPEN = 1; readyState = 1; onopen: any; onmessage: any; onclose: any;
  constructor() { setTimeout(() => this.onopen?.(), 0); }
  emit(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  send(raw: string) {
    const request = JSON.parse(raw); let payload: any = {};
    if (request.method === 'chat.send') { sent++; throw Error('Unexpected fixture chat.send'); }
    if (request.method === 'sessions.list') payload = { sessions, hasMore: false };
    if (request.method === 'agents.list') payload = { agents: [{ id: agentId, name: sessions[0].agentName, backendId: 'shoggoth' }] };
    if (request.method === 'models.list') payload = { models: [{ id: 'fixture-model', name: 'Fixture', provider: 'fixture' }] };
    if (request.method === 'chat.history') payload = { messages: history };
    if (request.method === 'chat.operation.get') { observed.push(request.params); payload = { status: 'not_found' }; }
    if (request.method === 'chat.operation.reconcile') {
      setTimeout(() => this.emit({ type: 'res', id: request.id, ok: false, error: { code: 'BACKEND_NOT_READY', message: 'Synthetic observation unavailable' } }), 0); return;
    }
    setTimeout(() => this.emit({ type: 'res', id: request.id, ok: true, payload }), 0);
  }
  close() { this.readyState = 3; }
}
Object.assign(window, { WebSocket: FixtureSocket });
localStorage.clear();
localStorage.setItem('shoggoth.chat.sessions.v1', JSON.stringify(sessions));
localStorage.setItem('shoggoth.chat.lastActive.v1', key);
localStorage.setItem('shoggoth.chat.immersive.v1', immersive ? '1' : '0');
localStorage.setItem(pendingKey, JSON.stringify(originalPending));
await i18n.changeLanguage(language); document.documentElement.dataset.theme = 'light';
const check = (value: unknown, label: string) => { if (!value) throw Error(label); };
const pause = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (predicate: () => unknown, label: string) => {
  const deadline = Date.now() + 9000;
  while (!predicate()) { if (state.fixtureError) throw Error(state.fixtureError); if (Date.now() > deadline) throw Error('Timed out: ' + label); await pause(); }
};
const noticeTitle = () => i18n.t('settings.serviceRecoveryRequired');
const noticeHint = () => i18n.t('settings.serviceRecoveryHint');
const pending = () => JSON.parse(localStorage.getItem(pendingKey) || '[]');
const input = () => Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea')).find(el => el.getBoundingClientRect().height > 0)!;
const recoveryAlerts = () => Array.from(document.querySelectorAll<HTMLElement>('[role="alert"]')).filter(el =>
  (el.textContent?.includes(noticeTitle()) || el.textContent?.includes(noticeHint())) && el.getBoundingClientRect().height > 0);
const hasStatus = (status: string) => immersive
  ? !!document.querySelector('[data-testid="immersive-chat"] [title="' + i18n.t('chat.liveStatus.' + status) + '"]')
  : status === 'online' ? !document.querySelector('.chat-header .chat-status__label')
    : document.querySelector('.chat-header .chat-status__label')?.textContent === i18n.t('chat.liveStatus.' + status);
const setDraft = async (value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), value);
  input().dispatchEvent(new Event('input', { bubbles: true })); await pause(40);
};
const refresh = async (next: string) => {
  mode = next; const before = statusReads; window.dispatchEvent(new Event('focus'));
  await wait(() => statusReads > before, 'actual status re-probe'); await pause(80);
};
const serviceStatus = (next: string) => ({ service: { healthy: next === 'healthy', pendingCommandsLocked: next !== 'healthy', mcpCredentialsLocked: false,
  domainAvailability: { kanban: next === 'healthy', cron: next === 'healthy' },
  ...(next === 'fault' ? { recoveryCode: 'SERVICE_RECOVERY_REQUIRED' } : next === 'unknown' ? { recoveryCode: 'SERVICE_RECOVERY_REQUIRED_EXTRA' } : {}) },
  background: { supported: true, installed: true, enabled: true, loaded: true, needsRepair: false } });
function SettingsFixture() {
  const [status, setStatus] = useState(serviceStatus('unknown')), [error, setError] = useState(false);
  state.setFixtureService = (next: string, failed = false) => { setStatus(serviceStatus(next)); setError(failed); };
  return <ServiceSettings status={status} error={error} busy={null} onRetry={() => {}} onAction={() => { backgroundActions++; }} />;
}
createRoot(document.getElementById('root')!).render(<HashRouter><UiProvider><ScrollbarProvider />
  {surface === 'settings' ? <SettingsFixture /> : <ChatPage />}</UiProvider></HashRouter>);
state.waitForConnectionFixture = async () => {
  await wait(() => input() && statusReads > 0 && document.body.innerText.includes('已保存的历史-fixture-59'), 'complete ChatPage long history');
  await pause(100);
  check(hasStatus('connecting'), 'cold backend falsely shows reconnecting or online');
  const target = immersive ? document.querySelector('[data-testid="immersive-chat"]') : document.querySelector('.chat-header');
  check(target && target.scrollWidth <= target.clientWidth + 1, 'connection header overflows horizontally');
};
state.runRecoveryNoticeFixture = async () => {
  if (surface === 'settings') {
    await wait(() => state.setFixtureService && document.querySelector('#settings-shoggoth'), 'real ServiceSettings mounted');
    check(recoveryAlerts().length === 0, 'unknown ServiceSettings code falsely confirms storage fault');
    state.setFixtureService('fault'); await wait(() => recoveryAlerts().length === 1, 'ServiceSettings precise fault');
    check(document.querySelector('#settings-shoggoth h4')?.textContent === noticeTitle(), 'ServiceSettings recovery title');
    state.setFixtureService('fault', true); await pause(60); check(recoveryAlerts().length === 1, 'ServiceSettings transient error hid known fault');
    state.setFixtureService('healthy'); await wait(() => recoveryAlerts().length === 0, 'ServiceSettings fresh healthy clears notice');
    check(sent === 0 && backgroundActions === 0 && apiWrites === 0, 'ServiceSettings recovery caused a mutation');
    return { surface, outcome: 'PASS', exactCode: true, unknownIgnored: true, transientRetained: true, freshCleared: true, sent, backgroundActions, apiWrites };
  }
  await state.waitForConnectionFixture();
  check(recoveryAlerts().length === 0, 'similar code created Chat recovery alert');
  await refresh('starting'); check(hasStatus('connecting'), 'first backend startup falsely shows reconnecting');
  await refresh('healthy'); await wait(() => hasStatus('online'), 'healthy backend status');
  await refresh('starting'); await wait(() => hasStatus('reconnecting'), 'previously healthy backend must show reconnecting');
  await refresh('healthy'); await wait(() => hasStatus('online'), 'backend reconnect completed');
  await setDraft('保留的新草稿');
  const savedPending = JSON.stringify(pending());
  await refresh('fault'); await wait(() => recoveryAlerts().length > 0, 'Chat precise storage fault alert');
  check(recoveryAlerts().some(el => el.textContent?.includes(noticeHint())), 'Chat lacks recovery explanation');
  if (!immersive) check(document.querySelector('.chat-header .chat-status__label')?.textContent === noticeTitle(), 'ordinary header still says reconnecting');
  let geometry: any = null;
  if (immersive) {
    const shell = document.querySelector('[data-testid="immersive-chat"]')!;
    const alert = shell.querySelector<HTMLElement>('[role="alert"]')!;
    check(alert && !alert.closest('[data-glass-clip]') && alert.closest('[data-chat-composer-dock]'), 'immersive notice remains in scrolling history');
    await pause(100); const rect = alert.getBoundingClientRect();
    check(rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.left >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1, 'immersive long-history notice clipped outside viewport');
    check(alert.scrollWidth <= alert.clientWidth + 1, 'immersive notice text overflows horizontally');
    geometry = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewport: { width: innerWidth, height: innerHeight } };
  }
  input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })); await pause(60);
  check(sent === 0 && input().value === '保留的新草稿', 'blocked Enter changed or sent draft');
  await refresh('unavailable'); check(recoveryAlerts().length > 0, 'failed status read hid confirmed Chat fault');
  await refresh('timeout'); check(recoveryAlerts().length > 0, 'transient sample hid confirmed Chat fault');
  await refresh('healthy'); await wait(() => recoveryAlerts().length === 0, 'Chat fresh healthy clears notice');
  check(input().value === '保留的新草稿' && document.body.innerText.includes('已保存的历史-fixture-59'), 'Chat recovery changed draft or history');
  check(JSON.stringify(pending()) === savedPending && pending()[0]?.idem === operationId, 'Chat recovery replaced original operation identity');
  let groupChecked = false;
  if (!immersive) {
    await refresh('fault');
    const groupButton = document.querySelector<HTMLButtonElement>('.chat-aside__list button[title="Saved group recovery fixture"]');
    check(groupButton, 'saved group fixture absent'); groupButton!.click();
    await wait(() => Array.from(document.querySelectorAll('.chat-header__name')).some(el => el.textContent === 'Saved group recovery fixture'), 'real group panel mounted');
    check(recoveryAlerts().length === 1, 'group storage notice hidden with direct Chat section');
    await refresh('unavailable'); check(recoveryAlerts().length === 1, 'group status failure lost confirmed notice');
    await refresh('healthy'); await wait(() => recoveryAlerts().length === 0, 'group fresh healthy clears notice');
    groupChecked = true;
  }
  check(sent === 0 && backgroundActions === 0 && apiWrites === 0, 'recovery caused send or background action');
  check(observed.every(item => item.sessionKey === key && item.idempotencyKey === operationId), 'observation changed original operation owner');
  if (immersive) { await refresh('fault'); await wait(() => recoveryAlerts().length > 0, 'final notice screenshot checkpoint'); }
  return { surface, immersive, language, width: innerWidth, outcome: 'PASS', fullChatPage: true, coldStartDistinct: true, laterReconnectDistinct: true,
    exactCode: true, unknownIgnored: true, transientRetained: true, freshCleared: true,
    draftPreserved: true, historyMessages: history.length, historyPreserved: true, originalOperationPreserved: true, groupChecked, geometry, sent, backgroundActions, apiWrites };
};
`;
try {
  fs.mkdirSync(output, { recursive: true });
  await build({ stdin: { contents: fixture, loader: 'tsx', resolveDir: root }, bundle: true, format: 'esm', jsx: 'automatic',
    nodePaths: [path.join(root, 'app/manage-ui/node_modules')], define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.svg': 'dataurl', '.webp': 'dataurl', '.png': 'dataurl' },
    outfile: path.join(temp, 'fixture.js'), logLevel: 'silent' });
  fs.writeFileSync(path.join(temp, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;height:100%;min-height:0}#root{display:flex;flex-direction:column;height:100vh}</style><div id="root"></div><script type="module" src="fixture.js"></script>');
  const main = path.join(temp, 'main.cjs');
  fs.writeFileSync(main, `const {app,BrowserWindow}=require('electron'),fs=require('node:fs');
app.setPath('userData',${JSON.stringify(path.join(temp, 'profile'))});
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{backgroundThrottling:false}});let passed=false;const rows=[];
// Both modes cover the real desktop minimum; ordinary chat also covers a mobile-sized preview.
const cases=['zh-CN','en'].flatMap(lang=>[1280,${MIN_WINDOW_BOUNDS.width}].flatMap(width=>[{surface:'chat',lang,width:String(width)},{surface:'chat',immersive:'1',lang,width:String(width)}]).concat({surface:'chat',lang,width:'390'}));
cases.push({surface:'settings',lang:'zh-CN',width:'1280'},{surface:'settings',lang:'en',width:'390'});
try{for(const query of cases){
w.setSize(Number(query.width),900);
await w.loadFile(${JSON.stringify(path.join(temp, 'index.html'))},{query,hash:'/chat'});
const name=query.surface+'-'+query.lang+'-'+query.width+(query.immersive?'-immersive':'');
if(query.surface==='chat'){await w.webContents.executeJavaScript('window.waitForConnectionFixture()',true);
fs.writeFileSync(${JSON.stringify(output)}+'/'+name+'-connecting.png',(await w.webContents.capturePage()).toPNG());}
const row=await w.webContents.executeJavaScript('window.runRecoveryNoticeFixture()',true);rows.push(row);console.log(JSON.stringify(row));
if(query.immersive)fs.writeFileSync(${JSON.stringify(output)}+'/'+name+'-recovery.png',(await w.webContents.capturePage()).toPNG());
}fs.writeFileSync(${JSON.stringify(path.join(output, 'results.json'))},JSON.stringify({outcome:'PASS',scope:'full-real-ChatPage-and-ServiceSettings-isolated-Electron',languages:['zh-CN','en'],desktopWidths:[1280,${MIN_WINDOW_BOUNDS.width}],ordinaryPreviewWidth:390,theme:'light',rows,liveProvider:false,realService:false,userData:false},null,2)+'\\n');passed=true;
}catch(error){console.error(error.stack||error);console.error(await w.webContents.executeJavaScript('JSON.stringify({text:document.body.innerText.slice(0,2400),fixtureError:window.fixtureError})'));
fs.writeFileSync(${JSON.stringify(path.join(output, 'failure.png'))},(await w.webContents.capturePage()).toPNG());
}finally{w.destroy();app.exit(passed?0:1);}}).catch(error=>{console.error(error);app.exit(1)});`);
  const child = spawn(uiRequire('electron'), [main], { env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => process.stdout.write(chunk)); child.stderr.on('data', chunk => process.stderr.write(chunk));
  const deadline = setTimeout(() => child.kill('SIGTERM'), 60_000);
  let status;
  try { status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); }
  finally { clearTimeout(deadline); }
  assert.equal(status, 0, 'full ChatPage recovery notice DOM fixture failed');
  console.log(JSON.stringify({ outcome: 'PASS', output, temporaryBundleRemoved: true }));
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
