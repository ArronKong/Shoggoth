'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { zipSync, unzipSync, strToU8 } = require('fflate');
const { fixture } = require('./fixtures/inspiration-coordinator-fixture.cjs');
const { CHUNK_BYTES, ARCHIVE_MIME, MAX_ARCHIVE_BYTES } = require('../app/agent-service/inspiration-media');
const { readInspirationArchive } = require('../app/agent-service/inspiration-archive');
const { transaction } = require('../app/agent-service/inspiration-database');
const ts = require('../app/manage-ui/node_modules/typescript');
const id = () => crypto.randomUUID();

function codec(api, originals = new Map()) {
  const modules = {};
  const load = name => {
    if (name === '../api/client') return api;
    if (!name.startsWith('./inspiration-')) return require(name);
    if (modules[name]) return modules[name];
    const file = path.join(__dirname, '../app/manage-ui/src/pages', `${name}.ts`);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const exports = {};
    vm.runInNewContext(code, { exports, require: load, crypto, Uint8Array, TextEncoder, File, Blob,
      fetch: async url => ({ ok: originals.has(new URL(url, 'http://localhost').searchParams.get('id')),
        arrayBuffer: async () => Uint8Array.from(originals.get(new URL(url, 'http://localhost').searchParams.get('id'))).buffer }),
    });
    return modules[name] = exports;
  };
  return load('./inspiration-archive');
}
async function upload(f, data, mimeType = ARCHIVE_MIME, name = 'notes.shoggoth.zip') {
  const attachment = { id: id(), name, mimeType, size: data.length };
  for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) await f.call('media.write', {
    attachment, offset, content: Buffer.from(data.subarray(offset, offset + CHUNK_BYTES)).toString('base64'),
  });
  return attachment;
}
function simpleArchive() {
  const fileId = id(), data = strToU8('# 文档 original\n');
  const attachment = { id: fileId, name: '中文 plan.md', mimeType: 'text/markdown', size: data.length };
  const manifest = { format: 'shoggoth.inspirations', version: 1, createdAt: 42, notes: [{
    id: id(), body: 'before\nafter', title: 'note', favorite: true, archivedAt: null, acceptedAt: null,
    createdAt: 1, updatedAt: 2, paperTone: 5, attachments: [{ ...attachment, textOffset: 7 }],
  }], files: [{ ...attachment, path: `files/${fileId}/中文 plan.md`, sha256: crypto.createHash('sha256').update(data).digest('hex') }] };
  const entries = { 'manifest.json': strToU8(JSON.stringify(manifest)), [manifest.files[0].path]: data };
  return { manifest, entries, bytes: zipSync(entries) };
}

test('real frontend codec exports all pages, archived notes and draft; imports append all originals with fresh IDs', async t => {
  const f = await fixture(t), originals = new Map();
  const types = [
    ['live.jpg', 'image/jpeg', Buffer.from('ffd8ff001122', 'hex')],
    ['live.mov', 'video/quicktime', Buffer.from('000000146674797071742020', 'hex')],
    ['audio.wav', 'audio/wav', Buffer.from('RIFF0000WAVEdata')],
    ['pic.png', 'image/png', Buffer.from('89504e470d0a1a0a001122', 'hex')],
    ['说明.md', 'text/markdown', Buffer.from('# 标题\nHello')],
    ['计划.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', zipSync({ 'word/document.xml': strToU8('<xml/>') })],
    ['slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', zipSync({ 'ppt/presentation.xml': strToU8('<xml/>') })],
    ['raw.bin', 'application/octet-stream', Buffer.from([0, 255, 1, 42])],
  ];
  const attachments = [];
  for (const [name, mime, bytes] of types) {
    const saved = await upload(f, bytes, mime, name); originals.set(saved.id, bytes);
    attachments.push({ ...saved, textOffset: 3 });
  }
  const original = (await f.call('create', { operationId: id(), body: '第一行\nlast line', attachments, paperTone: 7 })).idea;
  const archived = (await f.create('archived original'));
  // Restore an archived record via the same production archive path (no execution required).
  const a = simpleArchive(); a.manifest.notes[0].archivedAt = 8;
  a.entries['manifest.json'] = strToU8(JSON.stringify(a.manifest));
  const stage = await upload(f, zipSync(a.entries));
  const oldArchived = (await f.call('import', { operationId: id(), archiveId: stage.id })).idea;
  originals.set(oldArchived.attachments[0].id, a.entries[a.manifest.files[0].path]);
  const api = { listInspirations: input => f.call('list', { ...input, limit: 1 }) };
  const { collectInspirationNotes, buildInspirationArchive } = codec(api, originals);
  const notes = await collectInspirationNotes({ body: 'unsaved draft', paperTone: 3, attachments: [] });
  assert.equal(notes.length, 4);
  const bytes = await buildInspirationArchive(notes);
  const parsed = readInspirationArchive(bytes);
  assert.equal(parsed.notes.length, 4); assert.equal(parsed.files.size, 9);
  const entries = unzipSync(bytes);
  assert.match(Buffer.from(entries[`notes/${original.id}.md`]).toString(), /\.docx/);
  const before = f.store.exportSnapshot();
  const uploaded = await upload(f, bytes), input = { operationId: id(), archiveId: uploaded.id };
  const first = await f.call('import', input);
  const second = await f.call('import', input);
  assert.deepEqual(first, second, 'retry after staging cleanup must not duplicate notes');
  assert.equal(f.store.list().length, 7);
  for (const [key, value] of Object.entries(before.ideas)) assert.deepEqual(f.store.get(key), value, 'existing notes unchanged');
  const added = f.store.list().filter(note => !before.ideas[note.id]);
  const restored = added.find(note => note.body === original.body);
  assert.equal(restored.paperTone, 7);
  assert.equal(restored.attachments.length, 8);
  for (let index = 0; index < restored.attachments.length; index++) {
    const item = restored.attachments[index];
    assert.notEqual(item.id, original.attachments[index].id);
    assert.equal(item.textOffset, 3);
    assert.deepEqual(Buffer.from(f.store.media.read({ id: item.id, offset: 0 }).content, 'base64'), Buffer.from(types[index][2]));
  }
  assert.ok(added.some(note => note.archivedAt === 8 && note.favorite));
  await f.restart();
  assert.equal(f.store.list().length, 7); assert.deepEqual(f.store.get(archived.id), before.ideas[archived.id]);
  const again = await upload(f, bytes);
  await f.call('import', { operationId: id(), archiveId: again.id });
  assert.equal(f.store.list().length, 11, 'an intentional second import appends copies');
});

test('bad packages and unknown versions reject before writes; database failure rolls back notes and media together', async t => {
  const f = await fixture(t); await f.create('must survive');
  for (const mutation of [
    value => { value.manifest.version = 2; },
    value => { value.manifest.files[0].sha256 = '0'.repeat(64); },
    value => { value.manifest.notes[0].attachments[0].textOffset = 999; },
    value => { value.manifest.notes.push(value.manifest.notes[0]); },
    value => { value.entries['../escape.txt'] = strToU8('escape'); },
    value => { delete value.entries[value.manifest.files[0].path]; },
  ]) {
    const a = simpleArchive(); mutation(a); a.entries['manifest.json'] = strToU8(JSON.stringify(a.manifest));
    const uploaded = await upload(f, zipSync(a.entries));
    const before = f.store.exportSnapshot();
    await assert.rejects(f.call('import', { operationId: id(), archiveId: uploaded.id }), { code: 'INSPIRATION_ARCHIVE_INVALID' });
    assert.deepEqual(f.store.exportSnapshot(), before);
  }
  const uploaded = await upload(f, simpleArchive().bytes), input = { operationId: id(), archiveId: uploaded.id };
  const snapshot = f.store.exportSnapshot(), mediaCount = f.store.db.prepare('SELECT COUNT(*) AS n FROM inspiration_media').get().n;
  const originalCommit = f.store.commitTransaction;
  f.store.commitTransaction = (db, write) => transaction(db, () => { write(); throw new Error('simulated full disk'); });
  await assert.rejects(f.call('import', input));
  f.store.commitTransaction = originalCommit;
  assert.deepEqual(f.store.exportSnapshot(), snapshot);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM inspiration_media').get().n, mediaCount);
  await f.call('import', input); assert.equal(f.store.list().length, 2);
});

test('ZIP envelope rejects CRC damage, encryption, duplicate paths and oversized decompression declarations', () => {
  const a = simpleArchive();
  const stored = Buffer.from(zipSync(a.entries, { level: 0 }));
  const corrupted = Buffer.from(stored), body = corrupted.indexOf(Buffer.from('before'));
  corrupted[body] = 'B'.charCodeAt(0);
  assert.throws(() => readInspirationArchive(corrupted), { code: 'INSPIRATION_ARCHIVE_INVALID' });
  const central = stored.indexOf(Buffer.from('504b0102', 'hex'));
  const encrypted = Buffer.from(stored); encrypted.writeUInt16LE(1, central + 8);
  assert.throws(() => readInspirationArchive(encrypted), { code: 'INSPIRATION_ARCHIVE_INVALID' });
  const bomb = Buffer.from(stored); bomb.writeUInt32LE(MAX_ARCHIVE_BYTES + 1, central + 24);
  assert.throws(() => readInspirationArchive(bomb), { code: 'INSPIRATION_ARCHIVE_INVALID' });
  const duplicate = Buffer.from(zipSync({ 'README.txt': strToU8('a'), 'README.tx2': strToU8('b') }));
  let offset = 0;
  while ((offset = duplicate.indexOf(Buffer.from('README.tx2'), offset)) !== -1) { duplicate.write('README.txt', offset); offset += 10; }
  assert.throws(() => readInspirationArchive(duplicate), { code: 'INSPIRATION_ARCHIVE_INVALID' });
});
