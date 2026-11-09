import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { loadConnectorAddButton, loadConnectorDetails } from './fixtures/connector-details-ui.mjs';
const require = createRequire(new URL('../app/manage-ui/package.json', import.meta.url));
const React = require('react'), Renderer = require('react-test-renderer'), ts = require('typescript'), i18next = require('i18next');
const plain = value => JSON.parse(JSON.stringify(value));
function load(file, imports = {}, globals = {}) {
 const module = { exports: {} };
 const js = ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
 vm.runInNewContext(js, { module, exports: module.exports, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, Event, AbortController, require: name => name in imports ? imports[name] : require(name), ...globals });
 return module.exports;
}
const catalog = JSON.parse(fs.readFileSync(new URL('../app/agent-service/data/official-skill-connectors.json', import.meta.url)));
const resources = load('../app/manage-ui/src/i18n/officialConnectorResources.ts').officialConnectorResources;
const mcpResources = load('../app/manage-ui/src/i18n/mcpConnectorResources.ts').mcpConnectorResources;
const helpers = load('../app/manage-ui/src/lib/mcpConnectorUi.ts');
const branding = load('../app/manage-ui/src/lib/mcpRecommendationCatalog.ts');
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
const initial = id => ({ id, revision: 0, state: 'notInstalled', stage: null, version: '1.0.0', installedVersion: null, skillCount: 0, serverId: null, canRemove: false, errorCode: null });
let assertions = 0;
for (const language of ['zh-CN', 'en']) for (const definition of catalog) {
 const serviceOnly = ['fliggy', 'baidu-maps'].includes(definition.id);
 const translator = i18next.createInstance(); await translator.init({ lng: language, resources: { [language]: { translation: { officialConnectors: resources[language], mcpConnectors: mcpResources[language] } } } });
 const t = translator.t.bind(translator), events = new EventTarget(), document = new EventTarget(); document.visibilityState = 'visible';
 const openedUrls = [], qrInputs = []; events.open = (...args) => { openedUrls.push(args); return null; };
 let items = catalog.map(item => initial(item.id)), mutations = [], accountCalls = [], credentialCalls = [], configuredFields = [], allowRemove = false, statusFails = false, holdStatus = false, holdCredentials = false, settleCredentials, settleAccount, settleInstall;
 const serverSnapshot = () => ({ id: 'mcp-fixture', status: definition.fields.every(field => !field.required || configuredFields.includes(`env:${field.name}`)) ? 'ready' : 'needsSetup', setup: { requiredFields: definition.fields.filter(field => field.required).map(field => `env:${field.name}`), configuredFields: [...configuredFields] } });
 let account = { id: definition.id, state: 'ready', verificationUrl: null, qrCode: null, userCode: null, userName: 'Fixture account', errorCode: null };
 const authorizationTimers = new Map(); let timerId = 100000;
 const api = load('../app/manage-ui/src/api/officialSkillConnectors.ts', { './mcpConnectors': { MCP_CHANGE_EVENT: 'mcp-change' }, './client': { jsonFetch: async (url, options) => {
  if (url.endsWith('/status')) return { items: plain(items) };
  const input = JSON.parse(options.body), index = items.findIndex(item => item.id === input.id), current = items[index];
  assert.equal(input.expectedRevision, current.revision);
  if (url.endsWith('/account')) { accountCalls.push(input); if (statusFails) throw { code: 'OFFICIAL_SKILL_AUTH_FAILED', message: 'private-secret-error' }; if (holdStatus) return new Promise(resolve => { settleAccount = () => resolve(plain(account)); }); return plain(account); }
  mutations.push({ url, input });
  if (url.endsWith('/install')) {
   items[index] = { ...current, revision: current.revision + 1, state: 'installing', canRemove: true, stage: 'download' };
   return new Promise(resolve => { settleInstall = () => { items[index] = { ...items[index], revision: items[index].revision + 1, state: 'installed', stage: null, serverId: 'mcp-fixture', skillCount: 1, installedVersion: '1.0.0' }; resolve(plain(items[index])); }; });
  }
  assert.ok(url.endsWith('/remove')); items[index] = { ...initial(input.id), revision: current.revision + 1 }; return plain(items[index]);
 } } }, { window: events });
 assert.equal(api.officialConnectorErrorKey({ code: 'OFFICIAL_SKILL_CONFLICT' }), 'skillConflict');
 const cache = load('../app/manage-ui/src/lib/usePageCache.ts', {}, { window: events, document });
 const component = load('../app/manage-ui/src/pages/OfficialSkillConnectors.tsx', {
  'qrcode-generator': (...args) => { const qr = require('qrcode-generator')(...args), addData = qr.addData; qr.addData = value => { qrInputs.push(value); addData(value); }; return qr; },
  'react-i18next': { useTranslation: () => ({ t, i18n: translator }) }, '../api/officialSkillConnectors': api, '../lib/usePageCache': cache, '../lib/mcpConnectorUi': helpers, '../lib/mcpRecommendationCatalog': branding,
  '../api/mcpConnectors': { listMcpConnectors: async () => ({ revision: 9, servers: [serverSnapshot()] }), saveMcpCredentials: async (...args) => { credentialCalls.push(plain(args)); const saved = () => { configuredFields = Object.keys(args[1].env).map(name => `env:${name}`); return { server: serverSnapshot() }; }; if (holdCredentials) return new Promise(resolve => { settleCredentials = () => resolve(saved()); }); return saved(); } },
  '../components/Modal': { __esModule: true, default: ({ children, footer, subtitle, title, dismissible }) => React.createElement('section', { role: 'dialog', 'aria-label': typeof title === 'string' ? title : 'connector', 'data-dismissible': dismissible }, children, React.createElement("p", {}, subtitle), footer) },
  '../components/ConnectorTools': { __esModule: true, default: () => null },
  '../components/ConnectorDetails': loadConnectorDetails(t),
  '../components/ConnectorAddButton': loadConnectorAddButton(t),
 '../components/ui': { useConfirm: () => async () => allowRemove }, '../components/McpConnectorIcon': { __esModule: true, default: () => null },
  './McpConnectorDialog': { __esModule: true, default: ({ managed }) => React.createElement('div', { 'data-managed-tools': managed }) },
  '../../../agent-service/data/official-skill-connectors.json': { __esModule: true, default: catalog }, './ConnectorsPage.module.css': { __esModule: true, default: {} },
 }, { window: events, document,
  setTimeout: (handler, delay) => { if (delay !== 5000) return setTimeout(handler, delay); const id = ++timerId; authorizationTimers.set(id, handler); return id; },
  clearTimeout: id => { if (!authorizationTimers.delete(id)) clearTimeout(id); },
 });
 let model, rendered;
 function Harness() { model = component.useOfficialSkillConnectors(); return React.createElement(component.default, { id: definition.id, model, onClose() {}, onChanged() {} }); }
 const button = key => rendered.root.findAllByType('button').find(node => node.props.children === t(({ install: 'mcpConnectors.add', credentials: 'mcpConnectors.flow.saveConnect', login: 'mcpConnectors.flow.authorize', remove: 'mcpConnectors.flow.remove', ...(serviceOnly ? { check: 'officialConnectors.checkService' } : {}) })[key] || 'officialConnectors.' + key));
 const click = async target => Renderer.act(async () => { target.props.onClick(); await flush(); });
 try {
  await Renderer.act(async () => { rendered = Renderer.create(React.createElement(Harness)); await flush(); });
  assert.equal(mutations.length, 0); assert.equal(accountCalls.length, 0, 'opening never authorizes or probes a real account');
  assert.deepEqual(rendered.root.findByProps({ 'data-connector-footer': true }).findAllByType('button').map(node => node.props.children), [t('mcpConnectors.add')], 'before adding, the only footer action is Add');
  assert.ok(!rendered.root.findAllByType('a').some(link => link.props.href === definition.docsUrl), 'setup guide is hidden before adding');
  if (definition.id === 'shop') {
   assert.equal(definition.name, 'Shopify'); assert.equal(definition.fields.length, 0);
  }
  if (definition.id === 'quark-drive') {
   assert.equal(definition.version, '1.0.25'); assert.equal(definition.fields.length, 0);
   assert.ok(JSON.stringify(rendered.toJSON()).includes(definition.note[language]), 'Quark scope and account-entitlement notes visible before installation');
   assert.equal(api.officialConnectorErrorKey({ code: 'OFFICIAL_SKILL_QUARK_FAILED' }), 'quarkFailed');
   assert.equal(api.officialConnectorErrorKey({ code: 'OFFICIAL_SKILL_QUARK_LIMITED' }), 'quarkLimited');
  }
  if (definition.id === 'rollinggo-hotel') {
   assert.equal(definition.version, '1.1.6'); assert.equal(definition.fields.length, 0);
   assert.ok(JSON.stringify(rendered.toJSON()).includes(definition.note[language]), 'keyless Skill authorization and booking scope visible before installation');
   assert.equal(rendered.root.findAllByType('input').length, 0, 'RollingGo never asks for an API key');
  }
  if (definition.id === 'baidu-maps') {
   assert.equal(definition.version, '1.0.9');
   assert.deepEqual(definition.fields.map(field => field.name), ['BAIDU_MAP_AUTH_TOKEN']);
   assert.ok(JSON.stringify(rendered.toJSON()).includes(definition.note[language]));
   assert.ok(rendered.root.findAllByType('a').some(link => link.props.href === 'https://lbsyun.baidu.com/products/agentplan'));
   assert.equal(rendered.root.findAllByType('input').length, 0, 'no token is prefilled before installation');
  }
  if (definition.id === 'doordash') {
   assert.ok(JSON.stringify(rendered.toJSON()).includes(definition.note[language]), 'approval and platform limits visible before installation');
   assert.ok(rendered.root.findAllByType('a').some(link => link.props.href === definition.accessUrl), 'official waitlist remains available before installation');
   for (const [code, key] of [['OFFICIAL_SKILL_APPROVAL_REQUIRED', 'approvalRequired'], ['OFFICIAL_SKILL_PLATFORM_UNSUPPORTED', 'platform'], ['OFFICIAL_SKILL_RATE_LIMITED', 'rateLimited'], ['OFFICIAL_SKILL_PURCHASE_REVIEW_REQUIRED', 'purchaseReview']]) assert.equal(api.officialConnectorErrorKey({ code }), key);
  }
  assert.equal(button('install').props.disabled, false);
  await Renderer.act(async () => { button('install').props.onClick(); button('install').props.onClick(); await flush(); });
  assert.equal(mutations.length, 1, 'duplicate install fenced'); assert.equal(rendered.root.findByProps({ role: 'dialog' }).props['data-dismissible'], false);
  await Renderer.act(async () => { settleInstall(); await flush(); });
  assert.equal(rendered.root.findByProps({ 'data-connector-footer': true }).findAllByType('button').filter(node => node.props.children === t('mcpConnectors.flow.remove')).length, 1, 'official components use the shared footer Delete action');
  assert.ok(rendered.root.findAllByType('a').some(link => link.props.href === definition.docsUrl), 'the same guide is available after adding');
  assert.equal(accountCalls.length, 0); assert.ok(JSON.stringify(rendered.toJSON()).includes(t(serviceOnly ? definition.fields.some(field => field.required) ? 'officialConnectors.serviceNeedsCredentials' : 'officialConnectors.serviceUnknown' : 'officialConnectors.accountStates.unknown')), `${definition.id}: local installation reports missing required credentials without claiming account ready`);
  let installedRows, opened;
  const rowProps = { model, servers: [{ id: 'mcp-fixture', status: 'signedOut' }], onOpen: id => { opened = id; } };
  try {
   await Renderer.act(async () => { installedRows = Renderer.create(React.createElement(component.OfficialSkillInstalledRows, rowProps)); });
   assert.equal(installedRows.root.findByType('small').children.join(''), t('mcpConnectors.flow.notConnected'));
   assert.equal(installedRows.root.findByType('strong').children.join(''), branding.mcpConnectorName(definition.id, definition.name));
   await Renderer.act(async () => installedRows.root.findByType('button').props.onClick());
   assert.equal(opened, definition.id, 'the compact app entry opens its existing management');
   await Renderer.act(async () => installedRows.update(React.createElement(component.OfficialSkillInstalledRows, { ...rowProps, servers: [{ id: 'mcp-fixture', status: 'ready' }] })));
   assert.equal(installedRows.root.findAllByType('small').length, 0, 'ready apps omit descriptions and status');
   assert.equal(accountCalls.length, 0, 'rendering installed apps never probes account access');
  } finally { await Renderer.act(async () => installedRows?.unmount()); }
  if (definition.id === 'shop') assert.ok(button('login'), 'Shop offers optional personal account authorization');
  if (definition.id === 'rollinggo-hotel') assert.ok(button('login'), 'RollingGo offers official web authorization without a key');
  if (definition.id === 'baidu-maps') { assert.equal(button('login'), undefined); assert.equal(rendered.root.findByType('input').props.type, 'password'); assert.equal(rendered.root.findByType('input').props.value, ''); }
  if (definition.fields.length) {
   const inputs = rendered.root.findAll(node => node.type === 'input' || node.type === 'textarea'); assert.equal(inputs.length, definition.fields.length);
   const entered = inputs.map((input, index) => input.type === 'textarea' ? ' \r\nPRIVATE-KEY\nsecret-canary-' + index + '\nEND-KEY\r\n ' : ' secret-canary-' + index + ' ');
   await Renderer.act(async () => { inputs.forEach((input, index) => input.props.onChange({ target: { value: entered[index] } })); });
   holdStatus = serviceOnly;
   holdCredentials = serviceOnly;
   await Renderer.act(async () => { button('credentials').props.onClick(); button('credentials').props.onClick(); await flush(); });
   assert.equal(credentialCalls.length, 1); assert.equal(credentialCalls[0][0], 'mcp-fixture'); assert.equal(credentialCalls[0][2], 9);
   assert.deepEqual(Object.keys(credentialCalls[0][1]), ['env']); assert.deepEqual(Object.keys(credentialCalls[0][1].env), definition.fields.map(field => field.name));
   definition.fields.forEach((field, index) => assert.equal(credentialCalls[0][1].env[field.name], definition.id === 'netease-music' ? entered[index].trim() : entered[index], 'only NetEase credential boundaries are normalized'));
   if (definition.id === 'netease-music') assert.ok(JSON.stringify(rendered.toJSON()).includes(t('officialConnectors.neteaseSavedCredentials')), 'saving explains the separate authorization step');
   if (serviceOnly) {
    assert.ok(JSON.stringify(rendered.toJSON()).includes(t('officialConnectors.serviceChecking')), 'connection progress starts while the credential save is pending');
    assert.equal(accountCalls.length, 0, 'service check waits for the new credential to be saved');
    await Renderer.act(async () => { holdCredentials = false; settleCredentials(); await flush(); });
   }
   assert.equal(accountCalls.length, serviceOnly ? 1 : 0, 'Service-token save checks the service once; interactive providers keep explicit authorization');
   assert.ok(accountCalls.every(call => call.action === 'status'), 'saving never starts account authorization');
   assert.ok(rendered.root.findAll(node => node.type === 'input' || node.type === 'textarea').every(input => input.props.value === ''), 'submitted credentials cleared');
   assert.ok(!JSON.stringify(rendered.toJSON()).includes('secret-canary'));
   if (serviceOnly) {
    assert.ok(JSON.stringify(rendered.toJSON()).includes(t('officialConnectors.serviceChecking')), 'service check has visible progress');
    assert.equal(button('credentials').props.disabled, true);
    assert.equal(rendered.root.findByProps({ role: 'dialog' }).props['data-dismissible'], false);
    await Renderer.act(async () => { holdStatus = false; settleAccount(); await flush(); });
    assert.ok(JSON.stringify(rendered.toJSON()).includes(t('officialConnectors.serviceReady')), 'save confirms the actual service result');
    assert.ok(JSON.stringify(rendered.toJSON()).includes(t('officialConnectors.credentialSavedHint')), 'saved credentials remain visible as metadata after the input is cleared');
    assert.equal(rendered.root.findByType('input').props.placeholder, t('officialConnectors.credentialSavedPlaceholder'));
    statusFails = true;
    await Renderer.act(async () => { rendered.root.findByType('input').props.onChange({ target: { value: 'replacement-secret-canary' } }); });
    await click(button('credentials'));
    assert.equal(credentialCalls.length, 2); assert.equal(accountCalls.length, 2);
    assert.ok(!JSON.stringify(rendered.toJSON()).includes(t('officialConnectors.serviceReady')), 'failed save check clears previous success');
    assert.ok(!JSON.stringify(rendered.toJSON()).includes(t('officialConnectors.serviceChecking')), 'failed check clears progress');
    assert.ok(JSON.stringify(rendered.toJSON()).includes(t('officialConnectors.errors.auth')));
    assert.ok(JSON.stringify(rendered.toJSON()).includes(t('officialConnectors.serviceCheckFailed')), 'a failed service check is distinct from a connection that has not been checked');
    assert.equal(rendered.root.findByType('input').props.value, '');
    assert.ok(!JSON.stringify(rendered.toJSON()).includes('private-secret-error'));
    statusFails = false;
   }
  }
  await click(button('check')); assert.equal(accountCalls.at(-1).action, 'status'); assert.ok(JSON.stringify(rendered.toJSON()).includes(t(serviceOnly ? 'officialConnectors.serviceReady' : 'officialConnectors.accountStates.ready')));
  if (serviceOnly) {
   const checksBeforeReopen = accountCalls.length;
   await Renderer.act(async () => rendered.unmount());
   await Renderer.act(async () => { rendered = Renderer.create(React.createElement(Harness)); await flush(); });
   assert.equal(accountCalls.length, checksBeforeReopen, 'reopening reads credential metadata without repeating a provider request');
   assert.ok(JSON.stringify(rendered.toJSON()).includes(t('officialConnectors.credentialSavedHint')), 'reopening acknowledges the saved token');
   assert.equal(rendered.root.findByType('input').props.value, '', 'stored credentials are never copied into the input');
   assert.equal(rendered.root.findByType('input').props.placeholder, t('officialConnectors.credentialSavedPlaceholder'));
   assert.ok(JSON.stringify(rendered.toJSON()).includes(t('officialConnectors.serviceUnknown')), 'reopening clearly requests a fresh service check');
   assert.ok(!JSON.stringify(rendered.toJSON()).includes(t('officialConnectors.serviceReady')), 'MCP readiness alone never claims provider availability');
   account = { ...account, state: 'signedOut' };
   await click(button('check'));
   assert.ok(JSON.stringify(rendered.toJSON()).includes(t('officialConnectors.serviceNeedsCredentials')), 'an actual missing-token result has a specific next step');
   account = { ...account, state: 'ready' };
  }
  account = { ...account, state: 'unknown', errorCode: 'OFFICIAL_SKILL_OPERATION_UNCERTAIN' };
  await click(button('check')); assert.ok(JSON.stringify(rendered.toJSON()).includes(t('officialConnectors.errors.uncertain')), 'uncertain effects preserve the do-not-resubmit message');
  account = { ...account, state: 'ready', errorCode: null };
  await click(button('check'));
  statusFails = true; await click(button('check')); assert.ok(!JSON.stringify(rendered.toJSON()).includes(t(serviceOnly ? 'officialConnectors.serviceReady' : 'officialConnectors.accountStates.ready')), 'failed check clears stale ready');
  assert.ok(!JSON.stringify(rendered.toJSON()).includes('private-secret-error')); statusFails = false;
  if (button('login')) {
   account = { ...account, state: 'authorizing', userName: null, verificationUrl: definition.id === 'meituan-paotui' ? 'https://dpurl.cn/official-auth-fixture' : 'https://provider.example/authorize', userCode: 'ABC123' };
   await click(button('login')); assert.equal(accountCalls.at(-1).action, 'start'); assert.ok(rendered.root.findAllByType('a').some(a => a.props.href === account.verificationUrl));
   if (definition.id === 'meituan-paotui') {
    assert.equal(openedUrls.length, 0, 'Meituan app-only links are shown as a QR code instead of opening a broken desktop page');
    assert.match(rendered.root.findByType('img').props.src, /^data:image\/gif;base64,R0lGOD/);
    assert.equal(rendered.root.findByType('img').props.alt, t('officialConnectors.meituanScan'));
    assert.deepEqual(qrInputs, [account.verificationUrl], 'the actual local QR encoder receives only the user-facing official auth_link');
    assert.ok(JSON.stringify(rendered.toJSON()).includes(t('officialConnectors.meituanAuthorizationHint')));
    assert.equal(accountCalls.at(-1).action, 'start', 'showing a QR code never exchanges a token before user action');
    statusFails = true; await click(button('login')); statusFails = false;
    assert.equal(rendered.root.findAllByType('img').length, 0, 'failed authorization clears the previous QR code');
    await click(button('login'));
    assert.ok(rendered.root.findAllByType('a').some(a => a.props.href === account.verificationUrl), 'the official link remains available beside the QR code');
    assert.ok(JSON.stringify(rendered.toJSON()).includes(t('officialConnectors.accountStates.authorizing')));
    assert.ok(!JSON.stringify(rendered.toJSON()).includes(t('officialConnectors.errors.auth')));
   } else assert.equal(openedUrls.length, 0, 'other provider authorization behavior is preserved');
   if (definition.id === 'rollinggo-hotel') assert.equal(authorizationTimers.size, 1, 'RollingGo schedules status checks only during explicit authorization');
   if (definition.id === 'alipay') { const code = rendered.root.findAllByType('input').find(input => input.props.maxLength === 32); await Renderer.act(async () => code.props.onChange({ target: { value: '123456' } })); await click(button('bind')); assert.equal(accountCalls.at(-1).code, '123456'); }
   if (definition.id === 'doordash') {
    const callback = 'http://localhost:4180/oauth2/callback?code=private-callback-canary&state=fixture';
    const input = rendered.root.findByProps({ maxLength: 8192 }); assert.equal(input.props.type, 'password'); assert.equal(input.props.autoComplete, 'off');
    await Renderer.act(async () => input.props.onChange({ target: { value: callback } }));
    await click(button('bind')); assert.equal(accountCalls.at(-1).code, callback);
    assert.ok(!JSON.stringify(rendered.toJSON()).includes('private-callback-canary'), 'callback clears after submission');
   }
   if (definition.id === 'quark-drive') {
    const input = rendered.root.findByProps({ maxLength: 4096 }); assert.equal(input.props.type, 'password'); assert.equal(input.props.autoComplete, 'off');
    assert.equal(authorizationTimers.size, 1, 'Quark authorization schedules a single status poll');
    await Renderer.act(async () => { input.props.onFocus(); input.props.onChange({ target: { value: 'private-quark-code-canary' } }); });
    assert.equal(authorizationTimers.size, 0, 'polling pauses while entering a manual authorization code');
    await click(button('check'));
    assert.equal(rendered.root.findByProps({ maxLength: 4096 }).props.value, 'private-quark-code-canary', 'pending checks preserve a partially entered authorization code');
    await click(button('bind')); assert.equal(accountCalls.at(-1).code, 'private-quark-code-canary');
    assert.ok(!JSON.stringify(rendered.toJSON()).includes('private-quark-code-canary'), 'Quark authorization code clears after submission');
   }
  }
  await click(button('remove')); assert.equal(mutations.length, 1, 'declined removal does not mutate');
  allowRemove = true; await click(button('remove')); assert.equal(mutations.length, 2); assert.equal(mutations.at(-1).input.id, definition.id); assert.equal(items.find(item => item.id === definition.id).state, 'notInstalled');
  let recommendation;
  try {
   for (const canRemove of [false, true]) {
    await Renderer.act(async () => { recommendation?.unmount(); recommendation = Renderer.create(React.createElement(component.OfficialSkillRecommendation, { definition, model: { data: { items: [{ ...initial(definition.id), canRemove }] } }, onOpen() {} })); });
    const addButtons = recommendation.root.findAllByType('button').filter(node => node.props['aria-label'] === `${t('mcpConnectors.add')} ${definition.name}`);
    assert.equal(addButtons.length, Number(!canRemove), 'an existing installation never renders another Add button');
    if (!canRemove) {
     assert.equal(addButtons[0].findByType('svg').props['aria-hidden'], 'true');
     assert.equal(addButtons[0].children.length, 1, 'the list action displays only the icon');
    }
   }
  } finally { await Renderer.act(async () => recommendation?.unmount()); }
  assertions++;
 } finally { await Renderer.act(async () => rendered?.unmount()); cache.invalidatePageCache(); }
}
assert.deepEqual(plain(helpers.mcpFieldsFromInputs({ env: '', headers: '', definitions: [{ name: 'key', location: 'query', secret: true, required: true }], values: { 'query:key': 'canary' } })), { query: { key: 'canary' } });
console.log(`PASS ${assertions} actual bilingual provider dialogs: explicit install, duplicate fence, no implicit account access, encrypted credential payloads, clear-on-save, account state, QR/link/code and confirmed removal; DiDi query field mapping`);
