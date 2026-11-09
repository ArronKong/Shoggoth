import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'app/manage-ui/package.json'));
const ts = require('typescript');
function load(name, dependencies = {}) {
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(root, 'app/manage-ui/src/lib', name + '.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  vm.runInNewContext(outputText, { module, exports: module.exports, require: specifier => dependencies[specifier] ?? require(specifier) });
  return module.exports;
}
const { groupDraftBody, groupMentionCandidates, splitGroupMentions, pasteGroupDraftText } = load('groupMentions', {
  '../../../agent-service/group-mentions': require('../agent-service/group-mentions.js'),
  './groupReferenceExcerpt': load('groupReferenceExcerpt'),
});
const member = (id, handle, displayName = handle) => ({ id, handle, displayName });
const members = [member('codex', 'codex', 'Codex'), member('anti', 'antigravity', 'Antigravity'),
  member('shrimp', '虾长老'), member('neo', 'neo', 'Neo'), member('neo2', 'neo-two', 'Neo Two')];
const split = (text, roster = members) => splitGroupMentions(text, groupMentionCandidates(roster));
const mentions = parts => Array.from(parts.filter(part => part.member), part => [part.text, part.member.id]);

await test('a selected chip touching text cannot turn into a different mention when sent', () => {
  const { parseMentions } = require('../agent-service/group-mentions.js');
  const roster = [{ memberId: 'a', handle: 'a' }, { memberId: 'ab', handle: 'ab' }];
  const body = groupDraftBody({ text: 'please@ab', mentions: [{ start: 6, end: 8, memberId: 'a' }] });
  assert.equal(body, 'please @a b');
  assert.deepEqual(parseMentions(body, roster).memberIds, ['a']);
});

await test('English handles and Chinese display names keep exact spelling and source text', () => {
  const text = '请 @Antigravity、@虾长老处理新闻；@CODEX 负责交付。';
  const parts = split(text);
  assert.deepEqual(mentions(parts), [['@Antigravity', 'anti'], ['@虾长老', 'shrimp'], ['@CODEX', 'codex']]);
  assert.equal(parts.map(part => part.text).join(''), text);
});
await test('longest names win and partial English handles are not linked', () => {
  assert.deepEqual(mentions(split('@Neo Two @neo-two @neo-more @codex123 @虾长老处理 @codex核对')),
    [['@Neo Two', 'neo2'], ['@neo-two', 'neo2'], ['@虾长老', 'shrimp'], ['@codex', 'codex']]);
});
await test('email, URL, path and escaped raw tokens stay literal', () => {
  assert.deepEqual(mentions(split('x@codex.example https://site.test/?q=@Codex /path/@codex \\@codex www.test/@Codex @unknown @all')), []);
});
await test('acknowledged broadcast aliases render without matching handles inside words or URLs', () => {
  const { BROADCAST_HANDLES } = require('../agent-service/group-mentions.js');
  const tags = BROADCAST_HANDLES.map(handle => '@' + handle);
  const text = tags.join('、') + ' @allocate me@all https://example.test/@all';
  const parts = splitGroupMentions(text, groupMentionCandidates(members, true));
  assert.deepEqual(Array.from(parts.filter(part => part.member === null), part => part.text), tags);
  assert.equal(parts.map(part => part.text).join(''), text);
  assert.equal(split(text).some(part => part.member === null), false);
});
await test('pasting Markdown restores complete members and broadcast spans without changing the source', () => {
  const source = '@Codex、@所有人请看。\r\n\r\n`@Neo` [link](https://example.test/@neo) x@neo.example \\@neo @unknown\r\n\r\n> @Antigravity';
  const pasted = pasteGroupDraftText({ text: 'Before\n\n', mentions: [] }, 8, 8, source, members);
  assert.equal(pasted.text, 'Before\n\n' + source);
  assert.deepEqual(Array.from(pasted.mentions, span => [pasted.text.slice(span.start, span.end), span.memberId]),
    [['@Codex', 'codex'], ['@所有人', null]]);
  assert.equal(groupDraftBody(pasted, members), pasted.text);
  assert.equal(pasteGroupDraftText({ text: '```\n\n```', mentions: [] }, 4, 4, '@Codex', members), null);
});
await test('ambiguous display names do not guess a member; unique handles still work', () => {
  const roster = [member('a', 'first', 'Same'), member('b', 'second', 'Same')];
  assert.deepEqual(mentions(split('@Same @first @second', roster)), [['@first', 'a'], ['@second', 'b']]);
});
await test('canonical handles take priority over another member display name', () => {
  assert.deepEqual(mentions(split('@Codex', [member('a', 'codex', 'Alice'), member('b', 'beta', 'Codex')])), [['@Codex', 'a']]);
});
await test('normalization preserves raw Unicode boundaries', () => {
  const text = '@Ｃｏｄｅｘ，@ﬃ!';
  const parts = split(text, [...members, member('ligature', 'ffi')]);
  assert.deepEqual(mentions(parts), [['@Ｃｏｄｅｘ', 'codex'], ['@ﬃ', 'ligature']]);
  assert.equal(parts.map(part => part.text).join(''), text);
});
await test('roster changes and removed members never reuse an unrelated member identity', () => {
  assert.deepEqual(mentions(split('@codex', [{ ...members[0], state: 'removed' }])), [['@codex', 'codex']]);
  assert.deepEqual(mentions(split('@codex', [member('new-owner', 'codex')])), [['@codex', 'new-owner']]);
  assert.deepEqual(mentions(split('@codex', [])), []);
});
await test('repeated mentions are preserved without modifying the roster or text', () => {
  const snapshot = JSON.stringify(members), text = '@Codex '.repeat(1000);
  const parts = split(text);
  assert.equal(mentions(parts).length, 1000);
  assert.equal(parts.map(part => part.text).join(''), text);
  assert.equal(JSON.stringify(members), snapshot);
});
