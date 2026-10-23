import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'app/manage-ui/package.json'));
const ts = require('typescript'), module = { exports: {} };
const source = fs.readFileSync(path.join(root, 'app/manage-ui/src/lib/groupMentions.ts'), 'utf8');
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { module, exports: module.exports });
const { groupMentionCandidates, splitGroupMentions } = module.exports;
const member = (id, handle, displayName = handle) => ({ id, handle, displayName });
const members = [member('codex', 'codex', 'Codex'), member('anti', 'antigravity', 'Antigravity'),
  member('shrimp', '虾长老'), member('neo', 'neo', 'Neo'), member('neo2', 'neo-two', 'Neo Two')];
const split = (text, roster = members) => splitGroupMentions(text, groupMentionCandidates(roster));
const mentions = parts => Array.from(parts.filter(part => part.member), part => [part.text, part.member.id]);

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
