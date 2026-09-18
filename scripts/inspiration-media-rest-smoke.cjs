'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { startInspirationFixture } = require('./fixtures/inspiration-service-fixture.cjs');
const { CHUNK_BYTES } = require('../app/agent-service/inspiration-media');

(async () => {
  const f = await startInspirationFixture();
  const json = async (route, input) => {
    const response = await fetch(`${f.url}/__api/inspirations${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
  };
  try {
    const data = Buffer.alloc(CHUNK_BYTES * 2 + 257, 42); data.write('RIFF'); data.write('WAVE', 8);
    const attachment = { id: randomUUID(), name: 'voice.wav', mimeType: 'audio/wav', size: data.length };
    for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) {
      const input = { attachment, offset, content: data.subarray(offset, offset + CHUNK_BYTES).toString('base64') };
      await json('/media', input); await json('/media', input);
    }
    const created = await json('', { operationId: randomUUID(), body: '', attachments: [attachment] });
    assert.deepEqual(created.idea.attachments, [attachment]);
    const detail = await fetch(`${f.url}/__api/inspirations/detail?id=${created.idea.id}`).then(response => response.json());
    assert.deepEqual(detail.idea.attachments, [attachment]);
    const inline = { ...attachment, textOffset: 4 };
    const positioned = await json('', { operationId: randomUUID(), body: '第一行\n第二行', attachments: [inline] });
    const reopened = await fetch(`${f.url}/__api/inspirations/detail?id=${positioned.idea.id}`).then(response => response.json());
    assert.deepEqual(reopened.idea.attachments, [inline], 'REST and IPC preserve the caret position');
    const url = `${f.url}/__api/inspirations/media?id=${attachment.id}`;
    const response = await fetch(url);
    assert.equal(response.headers.get('content-type'), 'audio/wav');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), data);
    for (const [range, start, end] of [['bytes=123-25000', 123, 25000], ['bytes=24576-', 24576, data.length - 1], ['bytes=-19', data.length - 19, data.length - 1]]) {
      const partial = await fetch(url, { headers: { Range: range } });
      assert.equal(partial.status, 206);
      assert.equal(partial.headers.get('content-range'), `bytes ${start}-${end}/${data.length}`);
      assert.deepEqual(Buffer.from(await partial.arrayBuffer()), data.subarray(start, end + 1));
    }
    for (const range of ['bytes=999999-', 'bytes=100-10', 'bytes=-', 'bytes=-0', 'bytes=0-1,3-4']) {
      assert.equal((await fetch(url, { headers: { Range: range } })).status, 416);
    }
    assert.equal((await fetch(`${f.url}/__api/inspirations/media?id=../private`)).status, 400);
    assert.equal((await fetch(`${f.url}/__api/inspirations/media?id=${randomUUID()}`)).status, 404);
    const document = Buffer.from('# 中文 Markdown\nOriginal bytes'), documentId = randomUUID();
    const descriptor = { id: documentId, name: "便签's.md", mimeType: 'text/markdown', size: document.length };
    await json('/media', { attachment: descriptor, offset: 0, content: document.toString('base64') });
    const download = await fetch(`${f.url}/__api/inspirations/media?id=${documentId}`);
    assert.match(download.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''/);
    assert.ok(download.headers.get('content-disposition').includes('%27'));
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), document);
    const { zipSync, strToU8 } = require('fflate'), { createHash } = require('node:crypto');
    const filePath = `files/${documentId}/note.md`;
    const manifest = { format: 'shoggoth.inspirations', version: 1, createdAt: 1,
      notes: [{ id: randomUUID(), body: 'Imported note', title: null, favorite: false, archivedAt: null, acceptedAt: null,
        createdAt: 1, updatedAt: 1, paperTone: 2, attachments: [{ ...descriptor, textOffset: 5 }] }],
      files: [{ ...descriptor, path: filePath, sha256: createHash('sha256').update(document).digest('hex') }] };
    const bytes = zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), [filePath]: document });
    const staging = { id: randomUUID(), name: 'test.shoggoth.zip', mimeType: 'application/vnd.shoggoth.inspiration+zip', size: bytes.length };
    await json('/media', { attachment: staging, offset: 0, content: Buffer.from(bytes).toString('base64') });
    const input = { operationId: randomUUID(), archiveId: staging.id };
    const imported = await json('/import', input);
    assert.equal(imported.idea.body, 'Imported note');
    assert.notEqual(imported.idea.attachments[0].id, descriptor.id);
    assert.deepEqual(await json('/import', input), imported);
    const untouched = await fetch(`${f.url}/__api/inspirations/detail?id=${created.idea.id}`).then(response => response.json());
    assert.deepEqual(untouched.idea, created.idea);
    console.log('PASS Inspiration media REST + IPC: upload retries, attachment-only save, reload, byte integrity, audio ranges, invalid requests');
  } finally { await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
