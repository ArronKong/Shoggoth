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
  '代码 `@Neo`、邮箱 hello@codex.test、链接 [@default](/fixture-link/@default) 保持原样。\n\n' +
  '```js\nconst literal = "@Neo";\n```\n\n- [x] 核对完成\n\n<span onclick="window.fixtureInjection=true">raw HTML</span>';
const history = [message(1, { kind: 'user' }, '请 @Codex 安排三路采集。'),
  message(2, { kind: 'member', memberId: 'a' }, '@Antigravity 负责国际模型。\n@虾长老 负责国内模型。\n@default 负责产品与应用。'),
  message(3, { kind: 'member', memberId: 'e' }, richBody),
  message(4, { kind: 'user' }, '@Codex 请核对最终附件。'),
  message(5, { kind: 'user' }, '请把对比结果整理成一张表。', { mentions: { memberIds: ['e'], broadcast: false, unresolved: [] } })];
let view: any = { ownerScope: 'mention-owner', group: { id: 'g', name: '新闻协作 · 展示验收', status: 'active', purpose: '',
  createdAt: 1, updatedAt: 1, metadataRevision: 1, rosterRevision: 1, directoryRevision: 1, controlEpoch: 0, lastSeq: 5, ownerMemberId: 'a' },
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
const mount = () => root.render(<MemoryRouter><UiProvider><section className="chat-conv" style={{ flex: 1 }}>
  <GroupChatPanel key={mountRevision} groupId="g" onArchived={() => {}} />
</section></UiProvider></MemoryRouter>);
mount();
const timeline = () => document.querySelector('[data-group-timeline]') as HTMLElement;
const row = (seq: number) => timeline().querySelector('[data-seq="' + seq + '"]') as HTMLElement;
const mention = (seq: number, id: string) => row(seq)?.querySelector('[data-group-mention="' + id + '"]') as HTMLElement;
const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement;
const layout = () => {
  check(document.documentElement.scrollWidth <= innerWidth + 1, 'no horizontal document overflow');
  const list = timeline().getBoundingClientRect();
  for (const bubble of timeline().querySelectorAll('.chat-bubble')) check(bubble.getBoundingClientRect().right <= list.right + 1, 'bubble fits the message viewport');
};
const centerY = (rect: DOMRect) => (rect.top + rect.bottom) / 2;
const mentionCenterOffset = (chip: HTMLElement) => {
  const adjacent = chip.nextSibling as Text;
  const firstCharacter = adjacent.data.search(/\S/u);
  check(firstCharacter >= 0, 'the alignment fixture has body text next to its chip');
  const range = document.createRange();
  range.setStart(adjacent, firstCharacter);
  range.setEnd(adjacent, firstCharacter + 1);
  const chipCenter = centerY(chip.getBoundingClientRect());
  const avatar = chip.querySelector('[data-avatar-state]')!;
  check(Math.abs(centerY(avatar.getBoundingClientRect()) - chipCenter) <= 0.5, 'the avatar is centered inside the chip');
  return Math.abs(chipCenter - centerY(range.getBoundingClientRect()));
};

state.verifyTimeline = async () => {
  await wait(() => row(5) && mention(2, 'd') && document.querySelector('[data-group-prefill=e]'), 'member mentions and the prefill render');
  equal(Array.from(row(2).querySelectorAll('[data-group-mention]'), node => node.getAttribute('data-group-mention')), ['b', 'c', 'd'], 'a reply that calls peers shows each of them');
  equal(Array.from(row(3).querySelectorAll('[data-group-mention]'), node => node.getAttribute('data-group-mention')), ['b', 'c', 'a'], 'mentions render inside ordinary and emphasized text');
  equal(row(3).querySelectorAll('pre [data-group-mention], code [data-group-mention], a [data-group-mention]').length, 0, 'code and existing links remain literal');
  equal(row(3).querySelector('a')?.getAttribute('href'), '/fixture-link/@default', 'existing link destination is intact');
  check(row(3).querySelector('button[data-code]')?.getAttribute('data-code')?.includes('"@Neo"'), 'code copy payload is intact');
  check((row(3).querySelector('input[type=checkbox]') as HTMLInputElement).checked, 'Markdown checklist is intact');
  equal(state.fixtureInjection, undefined, 'raw HTML remains escaped');
  await wait(() => mention(2, 'b').querySelector('[data-avatar-state=loaded]'), 'mention avatar actually loads');
  const prefill = document.querySelector<HTMLButtonElement>('[data-group-prefill=e]');
  check(prefill && mention(5, 'e'), 'the structured mention appears in both the composer and its sent bubble');
  for (const chip of [prefill!, mention(5, 'e'), mention(2, 'b')]) {
    const style = getComputedStyle(chip);
    const padding = chip === prefill ? '2px 6px 2px 4px' : '4px 6px 4px 4px';
    equal([style.backgroundColor, style.borderRadius, style.fontSize, style.padding, style.borderTopColor],
      ['rgb(0, 0, 0)', '12px', '11px', padding, 'rgba(255, 255, 255, 0)'], 'composer and message mentions have the expected styling');
    equal(getComputedStyle(chip.lastElementChild!).color, 'rgb(255, 255, 255)', 'the mention name stays white');
  }
  prefill!.focus();
  equal(getComputedStyle(prefill!).textDecorationLine, 'none', 'focus does not underline a composer mention');
  prefill!.blur();
  for (const chip of timeline().querySelectorAll('[data-group-mention]')) check(!chip.textContent?.includes('@'), 'avatar mentions display only the member name');
  const centerOffset = Math.max(mentionCenterOffset(mention(2, 'b')), mentionCenterOffset(mention(4, 'a')));
  check(centerOffset <= 0.5, 'the mention pill is centered on adjacent body text: offset=' + centerOffset);
  row(2).scrollIntoView({ block: 'center' });
  await pause();
  const first = mention(2, 'b').getBoundingClientRect();
  const second = mention(2, 'c').getBoundingClientRect();
  const third = mention(2, 'd').getBoundingClientRect();
  const lineGap = Math.min(second.top - first.bottom, third.top - second.bottom);
  check(lineGap >= 4, 'mentions on consecutive lines leave a visible gap: gap=' + lineGap);
  equal(writes, 0, 'rendering does not send group actions');
  equal(JSON.stringify(history), originalHistory, 'source messages are unchanged');
  layout();
  return { mentions: 3, literalCodeAndLinks: true, centerOffset, lineGap };
};
state.verifyReadOnlyMentions = async () => {
  const author = row(2).querySelector<HTMLElement>('[data-group-author]')!;
  for (const identity of [mention(2, 'b'), mention(4, 'a'), author]) {
    check(!identity.matches('button, [role="button"], [tabindex]'), 'message identity is not an interactive control');
    identity.click();
  }
  await pause();
  check(!dialog(), 'clicking a mention or author cannot open the member profile');
  check(!reads.some(route => route.includes('/members/role')), 'message identities do not fetch a member profile');
  layout();
  return { readOnlyMentions: true };
};
const verifyAvatarColors = async (scope: string, offline: boolean) => {
  const avatar = (id: string) => document.querySelector<HTMLImageElement>(scope + ' img[src="/avatar/agent-' + id + '"]')!;
  await wait(() => avatar('b')?.naturalWidth && avatar('c')?.naturalWidth, 'original group avatar assets load');
  await wait(() => getComputedStyle(avatar('b')).filter === 'grayscale(1)', 'deleted member is black and white');
  await wait(() => getComputedStyle(avatar('c')).filter === (offline ? 'grayscale(1)' : 'none'),
    offline ? 'offline member is black and white' : 'reconnected member is in color');
};
state.showDeletedTimeline = async () => {
  view = { ...view, members: members.map(item => item.id === 'b' ? { ...item, agentMissing: true }
    : item.id === 'c' ? { ...item, card: { availability: 'offline', freshness: 'stale' } } : item) };
  emitGroupChanged('g');
  await verifyAvatarColors('[data-group-details-trigger]', true);
  await verifyAvatarColors('[data-seq="2"]', true);
  timeline().scrollTop = timeline().scrollHeight; await pause();
  return { deletedAvatarInHistory: true, deletedAvatarInCollage: true };
};
state.showDeletedMember = async () => {
  document.querySelector<HTMLButtonElement>('[data-group-details-trigger]')!.click();
  await wait(() => document.querySelector('[data-group-details]'), 'group details open');
  await verifyAvatarColors('[data-group-details]', true);
  return { deletedAvatarInDetails: true, offlineAvatarInDetails: true };
};
state.finish = async () => {
  view = { ...view, members: view.members.map((item: any) => item.id === 'c'
    ? { ...item, card: { availability: 'online', freshness: 'current' } } : item) };
  emitGroupChanged('g');
  await verifyAvatarColors('[data-group-details]', false);
  document.querySelector<HTMLButtonElement>('[data-group-details-action=close]')!.click();
  await wait(() => !document.querySelector('[data-group-details]'), 'details close');
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
  view = { ...view, ownerScope: 'mention-other-owner', members: [member('other', 'Other Member', 'other')], currentOwnerId: null };
  emitGroupChanged('g');
  await wait(() => !dialog() && timeline()?.textContent?.includes('@Codex') && !timeline().querySelector('[data-group-mention]'), 'owner change removes stale identities');
  equal(writes, 0, 'all interactions only read member details');
  equal(JSON.stringify(history), originalHistory, 'inspection never changes the messages');
  equal(errors, [], 'no render errors');
  return { language, theme, streaming: true, historyReopen: true, ownerIsolation: true, writes, reads: reads.length, passed: true };
};
state.fixtureReady = true;
