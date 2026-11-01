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
const theme = options.get('theme') || 'light';
const draftRecovery = options.get('draftRecovery');
const resendOutcome = options.get('resendOutcome') || 'accepted';
const withAttachment = options.has('attachment');
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
let mode = 'unknown', statusReads = 0, sent = 0, backgroundActions = 0, apiWrites = 0, observed: any[] = [], nativeOutcome = 'unresolved';
if (draftRecovery) mode = 'healthy';
let reconciliations = 0;
const sentRequests: any[] = [];
let allowRetryReconciliation = false;
window.addEventListener('error', event => { state.fixtureError = event.error?.stack || event.message; });
window.addEventListener('unhandledrejection', event => { state.fixtureError = String(event.reason?.stack || event.reason); });
window.fetch = async (input, init = {}) => {
  const url = new URL(String(input), location.href);
  if (init.method && init.method !== 'GET') {
    apiWrites++; if (url.pathname.includes('/shoggoth/background')) backgroundActions++;
    if (url.pathname === '/__api/shoggoth/background/repair') {
      await new Promise(resolve => setTimeout(resolve, 250));
      if (backgroundActions === 1) return new Response(JSON.stringify({ error: 'Disk still full' }), { status: 507 });
      mode = 'healthy';
      return new Response(JSON.stringify({ service: { healthy: true, pendingCommandsLocked: false } }));
    }
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
  else if (url.pathname === '/__api/config') payload = { config: { locale: language, theme, disabledBackends: [], setupCompletedAt: 1 } };
  else if (url.pathname === '/__api/group-chats') payload = { groups: [group], enabled: true };
  else if (url.pathname === '/__api/group-chats/detail') payload = group;
  else if (url.pathname === '/__api/group-chats/messages') payload = { messages: [], hasMore: false };
  else if (url.pathname === '/__api/plugins/selection-readiness') payload = { version: 1, supported: false };
  else if (url.pathname === '/__api/plugins') payload = { page: { supported: true, catalogRevision: 'a'.repeat(64), items: [], nextCursor: null } };
  else if (url.pathname === '/__api/plugins/bundled') payload = { batchDigest: 'a'.repeat(64), items: [] };
  else if (url.pathname === '/__api/chat/capabilities') payload = { attachments: withAttachment ? { file: {} } : {}, slash: false, maxPromptBytes: 61440 };
  else if (url.pathname === '/__api/chat/slash') payload = { supported: false, commands: [] };
  else if (url.pathname === '/__api/chat/cache-scope') payload = { backendId: 'shoggoth', cacheScope: 'service-recovery-notice-fixture' };
  else if (url.pathname === '/__api/connectors/mcp/requests') payload = { items: [] };
  else if (url.pathname.includes('runtime-models')) payload = { selection: { canSwitch: false, bindingId: 'fixture', model: 'fixture-model' }, capabilities: { attachments: withAttachment ? { file: {} } : {}, slash: false },
    models: [{ id: 'fixture-model', name: 'Fixture', bindingId: 'fixture', isDefault: true }], runtimes: [] };
  else if (url.pathname === '/__api/models') payload = { models: [{ id: 'fixture-model', name: 'Fixture', provider: 'fixture', backendId: 'shoggoth' }] };
  else if (url.pathname.endsWith('/archive')) payload = { archive: { supported: false, segments: [] } };
  return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
};
let activeSocket: FixtureSocket | null = null;
class FixtureSocket {
  static OPEN = 1; readyState = 1; onopen: any; onmessage: any; onclose: any; onerror: any;
  constructor() { activeSocket = this; if (!options.has('manualConnection')) setTimeout(() => this.onopen?.(), 0); }
  emit(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  send(raw: string) {
    const request = JSON.parse(raw); let payload: any = {};
    if (request.method === 'chat.send') {
      sent++;
      if (!draftRecovery) throw Error('Unexpected fixture chat.send');
      sentRequests.push(request.params);
      if (sent > 1 && (resendOutcome === 'accepted' || sent > 2)) {
        history.push({ role: 'user', content: request.params.message, timestamp: Date.now() });
        setTimeout(() => {
          this.emit({ type: 'res', id: request.id, ok: true, payload: { runId: request.params.idempotencyKey } });
          this.emit({ type: 'event', event: 'chat', payload: { sessionKey: key, agentId, backendId: 'shoggoth',
            runId: request.params.idempotencyKey, state: 'accepted' } });
        }, 0); return;
      }
      setTimeout(() => this.emit({ type: 'res', id: request.id, ok: false,
        error: { code: 'UPSTREAM_NEEDS_VERIFICATION', message: 'Synthetic send receipt unavailable', receiptUncertain: true } }), 0);
      return;
    }
    if (request.method === 'sessions.list') payload = { sessions, hasMore: false };
    if (request.method === 'agents.list') payload = { agents: [{ id: agentId, name: sessions[0].agentName, backendId: 'shoggoth' }] };
    if (request.method === 'models.list') payload = { models: [{ id: 'fixture-model', name: 'Fixture', provider: 'fixture' }] };
    if (request.method === 'chat.history') payload = { messages: history, hasMore: false, nextCursor: null, sourceId: 'recovery-fixture-history' };
    if (request.method === 'chat.operation.get') {
      observed.push(request.params);
      const isRetry = sentRequests.slice(1).some(item => item.idempotencyKey === request.params.idempotencyKey);
      payload = nativeOutcome === 'completed'
        ? { status: 'found', stateAuthority: 'native-service', run: { id: 'original-run', status: 'completed' } }
        : isRetry && (resendOutcome === 'accepted' || sent > 2)
          ? { status: 'found', stateAuthority: 'native-service', run: { id: request.params.idempotencyKey, status: 'running' } }
          : draftRecovery ? { status: 'unresolved', canReconcile: isRetry
            ? resendOutcome === 'not_admitted' || allowRetryReconciliation : nativeOutcome === 'not_admitted', run: null }
            : { status: 'not_found' };
    }
    if (request.method === 'chat.operation.reconcile') {
      if (draftRecovery && nativeOutcome === 'not_admitted') {
        reconciliations++; observed.push(request.params);
        if (resendOutcome === 'late-accepted') this.emit({ type: 'event', event: 'chat', payload: {
          sessionKey: key, agentId, backendId: 'shoggoth', runId: request.params.idempotencyKey, state: 'accepted' } });
        setTimeout(() => this.emit({ type: 'res', id: request.id, ok: true, payload: { status: 'not_admitted', run: null } }), 0); return;
      }
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
if (draftRecovery) localStorage.setItem(pendingKey, JSON.stringify(draftRecovery === 'reload'
  ? originalPending.map(({ accepted, terminalObserved, ...entry }) => entry) : []));
await i18n.changeLanguage(language); document.documentElement.dataset.theme = theme;
const check = (value: unknown, label: string) => { if (!value) throw Error(label); };
const pause = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (predicate: () => unknown, label: string) => {
  const deadline = Date.now() + 9000;
  while (!predicate()) { if (state.fixtureError) throw Error(state.fixtureError); if (Date.now() > deadline) throw Error('Timed out: ' + label); await pause(); }
};
const noticeTitle = () => i18n.t('settings.serviceRecoveryRequired');
const noticeHint = () => i18n.t('settings.serviceRecoveryHint');
const pending = () => JSON.parse(localStorage.getItem(pendingKey) || '[]');
const input = () => document.querySelector<HTMLTextAreaElement>(immersive
  ? '[data-testid="immersive-chat"] textarea' : '.chat-composer__input')!;
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
  const normalHeader = !immersive ? document.querySelector('.chat-header')!.getBoundingClientRect() : null;
  const normalThread = document.querySelector(immersive ? '[data-testid="immersive-chat"] [data-glass-clip]' : '.chat-thread')!.getBoundingClientRect();
  await refresh('fault'); await wait(() => recoveryAlerts().length > 0, 'Chat precise storage fault alert');
  check(recoveryAlerts().some(el => el.textContent?.includes(noticeHint())), 'Chat lacks recovery explanation');
  if (!immersive) check(document.querySelector('.chat-header .chat-status__label')?.textContent === noticeTitle(), 'ordinary header still says reconnecting');
  const checkRecoveryGeometry = async () => {
    const shell = immersive ? document.querySelector('[data-testid="immersive-chat"]')! : document.querySelector('.chat-conv')!;
    const alert = shell.querySelector<HTMLElement>('[role="alert"]')!;
    check(alert && !alert.closest('[data-glass-clip]') && !alert.closest('[data-chat-composer-dock]'), 'recovery notice must stay outside history and the composer');
    await pause(100); const rect = alert.getBoundingClientRect();
    const header = (immersive ? shell.querySelector<HTMLButtonElement>('[aria-label="' + i18n.t('chat.immersiveExit') + '"]')!.parentElement! : shell.querySelector<HTMLElement>('.chat-header')!).getBoundingClientRect();
    const thread = shell.querySelector<HTMLElement>(immersive ? '[data-glass-clip]' : '.chat-thread')!.getBoundingClientRect();
    check(rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.left >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1, 'recovery card clipped outside viewport');
    check(innerWidth - rect.right <= 48 && rect.top < innerHeight / 2, 'recovery card is not in the upper-right corner');
    // User chose an overlay: covering underlying UI is intentional, resizing it is not.
    check(Math.abs(rect.top - header.top) < 1, 'recovery overlay is not aligned with toolbar top');
    if (!immersive) check(Math.abs(rect.right - header.right) < 1 && header.width === normalHeader!.width
      && header.x === normalHeader!.x && header.y === normalHeader!.y, 'recovery overlay moved or squeezed the toolbar');
    check(thread.y === normalThread.y && thread.height === normalThread.height, 'recovery overlay moved or squeezed history');
    check(alert.contains(document.elementFromPoint(rect.right - 20, rect.top + 20)), 'recovery overlay is behind the toolbar');
    const action = alert.querySelector('button')!, actionRect = action.getBoundingClientRect();
    check(action.contains(document.elementFromPoint(actionRect.right - 16, actionRect.bottom - 8)), 'recovery action is obscured by underlying UI');
    check(alert.scrollWidth <= alert.clientWidth + 1, 'recovery card text overflows horizontally');
    check(rect.height < 220, 'recovery card is no longer compact');
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewport: { width: innerWidth, height: innerHeight } };
  };
  const geometry = await checkRecoveryGeometry();
  input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })); await pause(60);
  check(sent === 0 && input().value === '保留的新草稿', 'blocked Enter changed or sent draft');
  await refresh('unavailable'); check(recoveryAlerts().length > 0, 'failed status read hid confirmed Chat fault');
  await refresh('timeout'); check(recoveryAlerts().length > 0, 'transient sample hid confirmed Chat fault');
  await refresh('healthy'); await wait(() => recoveryAlerts().length === 0, 'Chat fresh healthy clears notice');
  check(input().value === '保留的新草稿' && document.body.innerText.includes('已保存的历史-fixture-59'), 'Chat recovery changed draft or history');
  check(JSON.stringify(pending()) === savedPending && pending()[0]?.idem === operationId, 'Chat recovery replaced original operation identity');
  await refresh('fault');
  const recoverButton = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="alert"] button'))
    .find(el => el.textContent === i18n.t('chat.recoverService') && el.getBoundingClientRect().height > 0);
  await wait(() => recoverButton(), 'visible chat recovery action'); recoverButton()!.click();
  await wait(() => recoveryAlerts().some(el => el.querySelector('button[aria-busy="true"]:disabled')), 'busy recovery button is visible');
  await checkRecoveryGeometry();
  await wait(() => backgroundActions === 1 && document.body.innerText.includes(i18n.t('chat.serviceRecoveryFailed'))
    && recoverButton() && !recoverButton()!.disabled, 'failed repair can be retried');
  check(JSON.stringify(pending()) === savedPending && input().value === '保留的新草稿', 'failed repair lost operation or draft');
  check(recoveryAlerts().length > 0, 'failed repair falsely cleared storage failure');
  recoverButton()!.click();
  await wait(() => backgroundActions === 2 && recoveryAlerts().length === 0, 'successful repair re-probes service');
  await wait(() => Array.from(document.querySelectorAll('.chat-verification-banner')).some(el =>
    el.getBoundingClientRect().height > 0 && el.textContent?.includes(i18n.t('chat.executionNeedsVerification'))), 'accepted task has an execution observation notice');
  await wait(() => !document.body.innerText.includes(i18n.t('chat.serviceRecoveryFailed')), 'successful repair clears its earlier failure toast');
  check(JSON.stringify(pending()) === savedPending, 'healthy service alone cannot clear an unknown original task');
  nativeOutcome = 'completed';
  const verify = Array.from(document.querySelectorAll<HTMLButtonElement>('.chat-verification-banner button'))
    .find(el => el.getBoundingClientRect().height > 0 && el.textContent === i18n.t('chat.verifyOriginalSend'));
  check(verify, 'verification action is available after recovery'); verify!.click();
  await wait(() => pending().length === 0, 'verified original terminal clears the send barrier');
  check(input().value === '保留的新草稿', 'terminal verification changed the draft');
  const sendEntry = document.querySelector<HTMLButtonElement>('[data-send-entry="' + (immersive ? 'immersiveButton' : 'composerButton') + '"]');
  await wait(() => sendEntry && !sendEntry.disabled, 'new input unlocks only after authoritative verification');
  let groupChecked = false;
  if (!immersive) {
    await refresh('fault');
    const groupButton = document.querySelector<HTMLButtonElement>('.chat-aside__list button[title="Saved group recovery fixture"]');
    check(groupButton, 'saved group fixture absent'); groupButton!.click();
    await wait(() => Array.from(document.querySelectorAll('.chat-header [aria-label]')).some(el =>
      el.getAttribute('aria-label')?.startsWith('Saved group recovery fixture ·')), 'real group panel mounted');
    check(recoveryAlerts().length === 1, 'group storage notice hidden with direct Chat section');
    await refresh('unavailable'); check(recoveryAlerts().length === 1, 'group status failure lost confirmed notice');
    await refresh('healthy'); await wait(() => recoveryAlerts().length === 0, 'group fresh healthy clears notice');
    groupChecked = true;
  }
  check(sent === 0 && backgroundActions === 2 && apiWrites === 2, 'recovery replayed input or repeated the explicit restart');
  check(observed.every(item => item.sessionKey === key && item.idempotencyKey === operationId), 'observation changed original operation owner');
  await refresh('fault'); await wait(() => recoveryAlerts().length > 0, 'final notice screenshot checkpoint');
  return { surface, immersive, language, theme, width: innerWidth, height: innerHeight, outcome: 'PASS', fullChatPage: true, coldStartDistinct: true, laterReconnectDistinct: true,
    exactCode: true, unknownIgnored: true, transientRetained: true, freshCleared: true,
    draftPreserved: true, historyMessages: history.length, historyPreserved: true, originalOperationPreserved: true,
    failedRecoveryRetained: true, terminalVerified: true, sendUnlocked: true, groupChecked, geometry, sent, backgroundActions, apiWrites };
};
state.runChatStatusNoticeFixture = async () => {
  const visible = (id: string) => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="' + id + '"]'))
    .find(el => el.getBoundingClientRect().height > 0);
  await wait(() => activeSocket?.onerror && visible('chat-connection-notice') && input(), 'cold connection notice');
  check(visible('chat-connection-notice')!.textContent === i18n.t('chat.connecting'), 'cold connection wording changed');
  const shell = immersive ? document.querySelector('[data-testid="immersive-chat"]')! : document.querySelector('.chat-conv')!;
  const header = (immersive ? shell.querySelector<HTMLButtonElement>('[aria-label="' + i18n.t('chat.immersiveExit') + '"]')!.parentElement! : shell.querySelector<HTMLElement>('.chat-header')!);
  const before = header.getBoundingClientRect();
  const assertNotice = (id: string) => {
    const notice = visible(id)!; check(notice?.closest('.chat-status-notices'), id + ' is outside floating stack');
    const stack = notice.closest('.chat-status-notices')!.getBoundingClientRect(), rect = notice.getBoundingClientRect();
    check(Math.abs(stack.top - before.top) < 1 && innerWidth - stack.right <= 48, id + ' is not aligned at top right');
    check(getComputedStyle(notice).borderTopWidth === '0px', id + ' restored a border');
    check(header.getBoundingClientRect().width === before.width, id + ' squeezed toolbar');
    check(notice.contains(document.elementFromPoint(rect.right - 20, rect.top + 20)), id + ' is covered by underlying UI');
  };
  assertNotice('chat-connection-notice');
  activeSocket!.onerror?.(); activeSocket!.onerror?.(); activeSocket!.onerror?.();
  await wait(() => visible('chat-error-notice'), 'connection error notice');
  assertNotice('chat-error-notice');
  check(visible('chat-error-notice')!.textContent?.includes(i18n.t('chat.connectionError')), 'error detail lost');
  await activeSocket!.onopen?.();
  await wait(() => visible('chat-verification-notice') && document.body.innerText.includes('已保存的历史-fixture-59'), 'task verification notice');
  assertNotice('chat-verification-notice');
  check(!visible('chat-error-notice') && !visible('chat-connection-notice'), 'reconnected transport retained stale notice');
  await setDraft('连接提示不挤压布局'); await pause(100); activeSocket!.onclose?.();
  await wait(() => visible('chat-connection-notice')?.textContent === i18n.t('chat.reconnectingBanner'), 'reconnect notice');
  assertNotice('chat-connection-notice'); assertNotice('chat-verification-notice');
  const upper = visible('chat-connection-notice')!.getBoundingClientRect(), lower = visible('chat-verification-notice')!.getBoundingClientRect();
  check(lower.top >= upper.bottom + 7, 'simultaneous notices overlap each other');
  check(input().value === '连接提示不挤压布局' && sent === 0 && backgroundActions === 0, 'status notices changed draft or sent a command');
  return { outcome: 'PASS', surface: 'chat-status-notices', immersive, language, width: innerWidth, height: innerHeight,
    connecting: true, reconnecting: true, errorDetail: true, verificationAction: true, stacked: true, noLayoutShift: true, sent, backgroundActions };
};
state.runDraftReturnFixture = async () => {
  const sendEntry = () => document.querySelector<HTMLButtonElement>('[data-send-entry="' + (immersive ? 'immersiveButton' : 'composerButton') + '"]')!;
  const notice = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="chat-verification-notice"]'))
    .find(el => el.getBoundingClientRect().height > 0);
  await wait(() => input() && !input().disabled && statusReads > 0 && (draftRecovery === 'reload' ? notice() : hasStatus('online'))
    && document.body.innerText.includes('已保存的历史-fixture-59'), 'draft recovery active composer and history');
  const original = '需要保留的原消息', newer = '后来输入的新草稿';
  const attach = async (name: string) => {
    const files = new DataTransfer(); files.items.add(new File(['Original fixture attachment'], name, { type: 'text/plain' }));
    const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    picker.files = files.files; picker.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(() => document.body.innerText.includes(name), 'fixture attachment added');
  };
  if (draftRecovery !== 'reload') {
    if (withAttachment) await attach('original-resend.txt');
    await setDraft(original); await wait(() => sendEntry() && !sendEntry().disabled, 'draft recovery initial send is ready');
    sendEntry().click();
  }
  await wait(() => pending().length === 1 && notice()?.textContent?.includes(i18n.t('chat.sendNeedsVerification')), 'uncertain send receipt is visible');
  check(pending()[0].accepted !== true, 'uncertain send was labelled as accepted');
  check(notice()!.textContent?.includes(i18n.t('chat.sendVerificationNoticeTitle')), 'unknown delivery needs its own title');
  check(!notice()!.textContent?.includes(i18n.t('chat.executionNeedsVerification')), 'unknown send claims the message was received');
  const originalId = pending()[0].idem;
  await setDraft(newer);
  if (withAttachment) await attach('newer-draft.txt');
  const action = notice()!.querySelector<HTMLButtonElement>('button')!;
  check(action.textContent === i18n.t('chat.checkSendResult') && !action.disabled, 'unknown delivery has a check-delivery action');
  // Unresolved observation never admits another send, even after a manual check.
  action.click(); await pause(80);
  check(sent === (draftRecovery === 'reload' ? 0 : 1) && pending()[0]?.idem === originalId && notice(), 'unknown delivery was resent');
  nativeOutcome = 'not_admitted'; action.click(); action.click();
  let resultKey = 'chat.resendingUnsentMessage';
  if (draftRecovery === 'reload') {
    resultKey = 'chat.messageNotSent';
    await wait(() => pending().length === 0 && !notice(), 'historical non-admission releases barrier without inventing a payload');
    check(sent === 0 && !sendEntry().disabled, 'reloading replayed unavailable original text');
  } else if (resendOutcome === 'late-accepted') {
    await wait(() => pending()[0]?.accepted && notice()?.textContent?.includes(i18n.t('chat.executionNeedsVerification')), 'late acceptance supersedes reconciliation');
    await pause(500);
    check(sent === 1 && pending()[0]?.idem === originalId && input().value === newer, 'an accepted original was resent');
    return { outcome: 'PASS', surface: 'confirmed-resend', immersive, language, lateAcceptanceBlockedResend: true, sent };
  } else {
    await wait(() => sent === 2, 'confirmed non-admission automatically sends the original once');
    const { idempotencyKey: oldId, ...originalParams } = sentRequests[0];
    const { idempotencyKey: retryId, ...retryParams } = sentRequests[1];
    check(oldId === originalId && retryId !== oldId && JSON.stringify(originalParams) === JSON.stringify(retryParams), 'resend changed the payload or reused a fenced operation');
    if (withAttachment) check(originalParams.attachments?.length === 1 && originalParams.attachments[0].fileName === 'original-resend.txt'
      && document.body.innerText.includes('newer-draft.txt'), 'resend consumed newer attachments or lost the original');
    if (resendOutcome === 'not_admitted') {
      resultKey = 'chat.unsentMessageRestored';
      await wait(() => pending().length === 0 && !notice(), 'repeated non-admission falls back without an automatic loop');
      check(input().value === original + '\n' + newer, 'failed retry lost either draft');
    } else if (resendOutcome === 'uncertain') {
      await wait(() => pending()[0]?.idem === retryId && notice(), 'uncertain retry keeps its own send barrier');
      await pause(500); check(sent === 2, 'uncertain retry was sent again automatically');
      allowRetryReconciliation = true;
      notice()!.querySelector<HTMLButtonElement>('button')!.click();
      await wait(() => sent === 3 && pending()[0]?.accepted && !notice(), 'another explicit check can resend only after proving non-admission');
      check(sentRequests[2].idempotencyKey !== retryId && sentRequests[2].message === original, 'manual retry reused the fenced key or sent a newer draft');
    } else await wait(() => pending()[0]?.accepted && !notice(), 'fresh send acceptance clears the old warning');
    await pause(500);
    check(sent === (resendOutcome === 'uncertain' ? 3 : 2), 'duplicate checks or automatic verification sent more than once');
  }
  if (resendOutcome !== 'not_admitted') check(input().value === newer, 'automatic resend consumed or overwrote the newer draft');
  check(observed.every(item => item.sessionKey === key && (item.idempotencyKey === originalId
    || sentRequests.slice(1).some(request => request.idempotencyKey === item.idempotencyKey))), 'operation lookup changed its owner');
  check(backgroundActions === 0 && apiWrites === 0, 'resend requires unrelated service actions');
  const toast = Array.from(document.querySelectorAll<HTMLElement>('[role="status"]'))
    .find(el => el.textContent === i18n.t(resultKey) && el.getBoundingClientRect().height > 0);
  check(toast, 'delivery feedback is not visible');
  await wait(() => getComputedStyle(toast!).opacity === '1', 'delivery feedback entrance completed');
  const text = toast!.querySelector<HTMLElement>('.chat-toast__text') || toast!;
  check(text.scrollWidth <= text.clientWidth + 1, 'delivery feedback is truncated');
  return { outcome: 'PASS', surface: 'confirmed-resend', immersive, language, draftRecovery, resendOutcome, withAttachment,
    authoritativeNonAdmission: true, newerDraftPreserved: true, explicitOutcome: true,
    freshOperation: draftRecovery !== 'reload', sent, reconciliations, backgroundActions, apiWrites };
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
cases.push(...['zh-CN','en'].flatMap(lang=>[{surface:'chat',lang,width:String(${MIN_WINDOW_BOUNDS.width}),height:String(${MIN_WINDOW_BOUNDS.height})},{surface:'chat',lang,width:String(${MIN_WINDOW_BOUNDS.width}),height:String(${MIN_WINDOW_BOUNDS.height}),immersive:'1'}]));
cases.push({surface:'chat',lang:'zh-CN',width:'1280',theme:'dark'},{surface:'chat',lang:'en',width:'720',theme:'dark'});
cases.push(...['zh-CN','en'].flatMap(lang=>[{surface:'chat',lang,width:'1280',manualConnection:'1'},{surface:'chat',lang,width:'1280',immersive:'1',manualConnection:'1'}]));
cases.push({surface:'chat',lang:'en',width:'720',height:'560',manualConnection:'1'},{surface:'chat',lang:'en',width:'720',height:'560',immersive:'1',manualConnection:'1'});
cases.push(...['zh-CN','en'].flatMap(lang=>[{surface:'chat',lang,width:'1280',draftRecovery:'live'},{surface:'chat',lang,width:'1280',immersive:'1',draftRecovery:'live'}]));
cases.push({surface:'chat',lang:'zh-CN',width:'1280',draftRecovery:'reload'},{surface:'chat',lang:'en',width:'1280',immersive:'1',draftRecovery:'reload'});
cases.push(...['uncertain','not_admitted','late-accepted'].map(resendOutcome=>({surface:'chat',lang:'zh-CN',width:'1280',draftRecovery:'live',resendOutcome})));
cases.push({surface:'chat',lang:'zh-CN',width:'1280',draftRecovery:'live',attachment:'1'},{surface:'chat',lang:'en',width:'1280',draftRecovery:'live',immersive:'1',attachment:'1'});
try{for(const query of cases){
w.setSize(Number(query.width),Number(query.height||900));
await w.loadFile(${JSON.stringify(path.join(temp, 'index.html'))},{query,hash:'/chat'});
const name=query.surface+'-'+query.lang+'-'+query.width+'x'+(query.height||900)+(query.immersive?'-immersive':'')+'-'+(query.theme||'light')+(query.manualConnection?'-status':'')+(query.draftRecovery?'-draft-'+query.draftRecovery:'')+(query.resendOutcome?'-'+query.resendOutcome:'')+(query.attachment?'-attachment':'');
if(query.surface==='chat'&&!query.manualConnection&&!query.draftRecovery){await w.webContents.executeJavaScript('window.waitForConnectionFixture()',true);
fs.writeFileSync(${JSON.stringify(output)}+'/'+name+'-connecting.png',(await w.webContents.capturePage()).toPNG());}
const row=await w.webContents.executeJavaScript(query.draftRecovery?'window.runDraftReturnFixture()':query.manualConnection?'window.runChatStatusNoticeFixture()':'window.runRecoveryNoticeFixture()',true);rows.push(row);console.log(JSON.stringify(row));
if(query.surface==='chat')fs.writeFileSync(${JSON.stringify(output)}+'/'+name+'-recovery.png',(await w.webContents.capturePage()).toPNG());
}fs.writeFileSync(${JSON.stringify(path.join(output, 'results.json'))},JSON.stringify({outcome:'PASS',scope:'full-real-ChatPage-and-ServiceSettings-isolated-Electron',languages:['zh-CN','en'],desktopWidths:[1280,${MIN_WINDOW_BOUNDS.width}],minimumWindow:${JSON.stringify(MIN_WINDOW_BOUNDS)},ordinaryPreviewWidth:390,themes:['light','dark'],rows,liveProvider:false,realService:false,userData:false},null,2)+'\\n');passed=true;
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
