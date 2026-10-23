import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { UiProvider } from '../../app/manage-ui/src/components/ui';
import GroupChatPanel from '../../app/manage-ui/src/pages/GroupChatPanel';
import { emitGroupChanged } from '../../app/manage-ui/src/lib/groupChat';
import i18n from '../../app/manage-ui/src/i18n';
import '../../app/manage-ui/src/styles.css';
import '../../app/manage-ui/src/manage-skin.css';
import '../../app/manage-ui/src/pages/ChatPage.css';

const state = window as any, params = new URLSearchParams(location.search);
const language = params.get('language') || 'zh-CN', theme = params.get('theme') || 'light';
const errors: string[] = [], reads: string[] = [];
let writes = 0;
addEventListener('error', event => errors.push(event.error?.stack || event.message));
addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
const pause = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const check = (condition: unknown, label: string) => { if (!condition) throw Error(label); };
const equal = (a: unknown, b: unknown, label: string) => check(JSON.stringify(a) === JSON.stringify(b), label + ': ' + JSON.stringify(a));
const wait = async (predicate: () => unknown, label: string) => {
  const end = Date.now() + 6000;
  while (!predicate()) {
    if (errors.length) throw Error(errors.join('\n'));
    if (Date.now() > end) throw Error(label);
    await pause();
  }
};
const hash = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
  byte => byte.toString(16).padStart(2, '0')).join('');
const member = (id: string, displayName: string, handle = displayName.toLowerCase()) => ({ id, groupId: 'g', backendId: 'shoggoth',
  agentId: 'agent-' + id, displayName, handle, state: 'active', position: 0, joinedSeq: 0, leftSeq: null, card: null });
const members = [member('a', 'Codex'), member('b', 'Antigravity'), member('c', '虾长老'), member('d', 'default'), member('e', 'Neo')];
const message = (seq: number, author: any, body: string, extra = {}) => ({ id: 'm' + seq, groupId: 'g', seq, threadId: 'main', author,
  body, mentions: { memberIds: [], broadcast: false, unresolved: [] }, createdAt: seq, ...extra });
const richBody = '@Antigravity、@虾长老 请与 **@Codex** 核对来源。\n\n' +
  '代码 `@Neo`、邮箱 hello@codex.test、链接 [@default](https://example.invalid/@default) 保持原样。\n\n' +
  '```js\nconst literal = "@Neo";\n```\n\n- [x] 核对完成\n\n<span onclick="window.fixtureInjection=true">raw HTML</span>';
const history = [message(1, { kind: 'user' }, '请 @Codex 安排三路采集。'),
  message(2, { kind: 'member', memberId: 'a' }, '@Antigravity 负责国际模型，@虾长老 负责国内模型，@default 负责产品与应用。'),
  message(3, { kind: 'member', memberId: 'e' }, richBody),
  message(4, { kind: 'user' }, '@Codex 请核对最终附件。')];
let view: any = { ownerScope: 'mention-owner', group: { id: 'g', name: '新闻协作 · 展示验收', status: 'active', purpose: '',
  createdAt: 1, updatedAt: 1, metadataRevision: 1, rosterRevision: 1, directoryRevision: 1, controlEpoch: 0, lastSeq: 4, ownerMemberId: 'a' },
  currentOwnerId: 'a', members, round: null, activeTurns: [], queuedMemberIds: [], internalSessionKeys: [], pendingInteractions: [],
};
const originalHistory = JSON.stringify(history);
state.fetch = async (target: any, init: any = {}) => {
  const url = new URL(String(target), location.href);
  if (init.method && init.method !== 'GET') { writes++; throw Error('unexpected API mutation: ' + url.pathname); }
  reads.push(url.pathname);
  let result: any = {};
  if (url.pathname.endsWith('/detail')) result = view;
  else if (url.pathname.endsWith('/messages')) result = { messages: history.filter(row => row.seq > Number(url.searchParams.get('afterSeq') || 0)), hasMore: false };
  else if (url.pathname.endsWith('/role-history')) result = { snapshots: [], hasMore: false, nextCursor: null };
  else if (url.pathname.endsWith('/role')) {
    const text = 'Shared profile for ' + url.searchParams.get('memberId');
    result = { ok: true, text, disclosure: 'verbatim', offset: 0, totalBytes: new TextEncoder().encode(text).length,
      exportDigest: await hash(text), revisionId: 'fixture-role', disclosurePolicyRevision: 1, nextCursor: null };
  }
  return new Response(JSON.stringify(result));
};
await i18n.changeLanguage(language);
document.documentElement.setAttribute('data-theme', theme);
const root = createRoot(document.getElementById('root')!);
let mountRevision = 0;
const mount = () => root.render(<MemoryRouter><UiProvider><GroupChatPanel key={mountRevision} groupId="g" onArchived={() => {}} /></UiProvider></MemoryRouter>);
mount();
const timeline = () => document.querySelector('[data-group-timeline]') as HTMLElement;
const row = (seq: number) => timeline().querySelector('[data-seq="' + seq + '"]') as HTMLElement;
const mention = (seq: number, id: string) => row(seq)?.querySelector('[data-group-mention="' + id + '"]') as HTMLButtonElement;
const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement;
const title = () => dialog()?.querySelector('[class*=cardTitle]')?.textContent;
const close = async () => {
  Array.from(dialog().querySelectorAll('button')).find(button => button.textContent === i18n.t('common.close'))!.click();
  await wait(() => !dialog(), 'member dialog closes');
};
const layout = () => {
  check(document.documentElement.scrollWidth <= innerWidth + 1, 'no horizontal document overflow');
  const list = timeline().getBoundingClientRect();
  for (const bubble of timeline().querySelectorAll('.chat-bubble')) check(bubble.getBoundingClientRect().right <= list.right + 1, 'bubble fits the message viewport');
};
// 提及前后各放一个零宽参考点：其中一侧可能因换行落在别的行，取较近的一侧比较基线。
const mentionBaseline = (button: HTMLButtonElement) => {
  const inside = document.createElement('span'), before = document.createElement('span'), after = document.createElement('span');
  for (const marker of [inside, before, after]) marker.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline;padding:0;margin:0;border:0';
  button.lastElementChild!.prepend(inside); button.before(before); button.after(after);
  try { const top = inside.getBoundingClientRect().top;
    return Math.min(...[before, after].map(marker => Math.abs(top - marker.getBoundingClientRect().top))); }
  finally { inside.remove(); before.remove(); after.remove(); }
};

state.verifyTimeline = async () => {
  await wait(() => row(4) && mention(2, 'd'), 'member mentions render in the timeline');
  equal(Array.from(row(2).querySelectorAll('[data-group-mention]'), node => node.getAttribute('data-group-mention')), ['b', 'c', 'd'], 'a reply that calls peers shows each of them');
  equal(Array.from(row(3).querySelectorAll('[data-group-mention]'), node => node.getAttribute('data-group-mention')), ['b', 'c', 'a'], 'mentions render inside ordinary and emphasized text');
  equal(row(3).querySelectorAll('pre [data-group-mention], code [data-group-mention], a [data-group-mention]').length, 0, 'code and existing links remain literal');
  equal(row(3).querySelector('a')?.getAttribute('href'), 'https://example.invalid/@default', 'existing link destination is intact');
  check(row(3).querySelector('button[data-code]')?.getAttribute('data-code')?.includes('"@Neo"'), 'code copy payload is intact');
  check((row(3).querySelector('input[type=checkbox]') as HTMLInputElement).checked, 'Markdown checklist is intact');
  equal(state.fixtureInjection, undefined, 'raw HTML remains escaped');
  await wait(() => mention(2, 'b').querySelector('[data-avatar-state=loaded]'), 'mention avatar actually loads');
  equal(getComputedStyle(mention(2, 'b')).color, theme === 'dark' ? 'rgb(96, 165, 250)' : 'rgb(37, 99, 235)', 'member mention is blue');
  equal(getComputedStyle(mention(4, 'a')).color, 'rgb(147, 197, 253)', 'user bubble mention stays readable blue');
  for (const button of timeline().querySelectorAll('[data-group-mention]')) check(!button.textContent?.includes('@'), 'avatar mentions display only the member name');
  const baselineOffset = Math.max(...['b', 'c', 'd'].map(id => mentionBaseline(mention(2, id))));
  check(baselineOffset <= 0.5, 'mention text shares the body baseline: offset=' + baselineOffset);
  equal(writes, 0, 'rendering does not send group actions');
  equal(JSON.stringify(history), originalHistory, 'source messages are unchanged');
  row(2).scrollIntoView({ block: 'start' }); await pause(); layout();
  return { mentions: 3, literalCodeAndLinks: true, baselineOffset };
};
state.showMember = async () => {
  const button = mention(2, 'b'); button.focus(); button.click();
  await wait(() => dialog()?.textContent?.includes('Shared profile for b'), 'mention opens existing member details');
  equal(document.querySelectorAll('[role=dialog]').length, 1, 'only one member modal');
  check(title()?.includes('Antigravity'), 'the mentioned member, not the speaker');
  layout(); state.mentionDialogTitle = title();
  return { memberDialog: true };
};
state.showStatus = async () => {
  await close();
  const roster = Array.from(document.querySelectorAll('button')).find(button => !button.hasAttribute('data-group-mention')
    && button.title === i18n.t('groupChat.card.open') && button.textContent === 'Antigravity')!;
  roster.click(); await wait(() => dialog()?.textContent?.includes('Shared profile for b'), 'top member detail');
  equal(title(), state.mentionDialogTitle, 'mention and top roster use the exact same modal title');
  await close(); layout();
  return { sameMemberModal: true };
};
state.finish = async () => {
  view.activeTurns = [{ opportunityId: 'stream-a', memberId: 'a', discussionId: 'round', startedAt: 20, floor: true, released: false,
    draft: '正在与 @Antigravity 核对。' }];
  emitGroupChanged('g');
  await wait(() => timeline().querySelector('[data-group-execution="stream-a"] [data-group-mention="b"]'), 'streaming mention appears');
  view.activeTurns[0].draft = '核对完成。'; emitGroupChanged('g');
  await wait(() => !timeline().querySelector('[data-group-execution="stream-a"] [data-group-mention]'), 'updated stream removes old mention');
  view.activeTurns = []; emitGroupChanged('g');
  await wait(() => !timeline().querySelector('[data-group-execution="stream-a"]'), 'stream settles');
  const oldTimeline = timeline(); mountRevision++; mount();
  await wait(() => timeline() !== oldTimeline && timeline()?.querySelectorAll('[data-group-mention]').length > 0 && mention(2, 'd'), 'history reopen restores mentions');
  mention(2, 'b').click(); await wait(() => dialog(), 'member modal before owner transition');
  view = { ...view, ownerScope: 'mention-other-owner', members: [member('other', 'Other Member', 'other')], currentOwnerId: null };
  emitGroupChanged('g');
  await wait(() => !dialog() && timeline()?.textContent?.includes('@Codex') && !timeline().querySelector('[data-group-mention]'), 'owner change removes stale identities and closes the old modal');
  equal(writes, 0, 'all interactions only read member details');
  equal(JSON.stringify(history), originalHistory, 'inspection never changes the messages');
  equal(errors, [], 'no render errors');
  return { language, theme, streaming: true, historyReopen: true, ownerIsolation: true, writes, reads: reads.length, passed: true };
};
state.fixtureReady = true;
