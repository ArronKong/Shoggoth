'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID: id } = require('node:crypto');
const { test } = require('node:test');
const { fixture, until } = require('./fixtures/inspiration-coordinator-fixture.cjs');
const { CHUNK_BYTES, MAX_MEDIA_BYTES, MAX_VIDEO_BYTES } = require('../app/agent-service/inspiration-media');

function image(size = CHUNK_BYTES + 31) {
  const data = Buffer.alloc(size, 42); Buffer.from('89504e470d0a1a0a', 'hex').copy(data);
  return { data, attachment: { id: id(), name: '图片.png', mimeType: 'image/png', size } };
}
async function upload(f, value) {
  for (let offset = 0; offset < value.data.length; offset += CHUNK_BYTES) {
    await f.call('media.write', { attachment: value.attachment, offset, content: value.data.subarray(offset, offset + CHUNK_BYTES).toString('base64') });
  }
}

test('media uploads survive restart, retry exactly, and support attachment-only notes and immutable execution snapshots', async t => {
  const f = await fixture(t), value = image();
  const first = { attachment: value.attachment, offset: 0, content: value.data.subarray(0, CHUNK_BYTES).toString('base64') };
  await f.call('media.write', first); await f.call('media.write', first);
  await assert.rejects(f.call('create', { operationId: id(), body: '', attachments: [value.attachment] }), { code: 'INSPIRATION_NOT_FOUND' });
  f.store.close(); f.store.open();
  await upload(f, value);
  const input = { operationId: id(), body: '', attachments: [value.attachment], paperTone: 3 };
  const idea = (await f.call('create', input)).idea;
  assert.deepEqual((await f.call('create', input)).idea, idea);
  assert.deepEqual((await f.call('list', { query: '', filter: 'saved', limit: 20, cursor: null })).items[0].attachments, input.attachments);
  assert.equal((await f.call('list', { query: value.attachment.name, filter: 'saved', limit: 20, cursor: null })).total, 1);
  const chunks = [];
  for (let offset = 0; offset < value.data.length; offset += CHUNK_BYTES) chunks.push(Buffer.from((await f.call('media.read', { id: value.attachment.id, offset })).content, 'base64'));
  assert.deepEqual(Buffer.concat(chunks), value.data);
  const started = await f.start(idea);
  const execution = f.store.executionForRun(started.latestExecution.runId);
  assert.deepEqual(execution.attachments, input.attachments);
  assert.equal(f.service.sessionOrigin(execution.sessionKey).inspirationTitle, value.attachment.name);
  const file = f.store.media.materialize(value.attachment);
  assert.deepEqual(fs.readFileSync(file), value.data);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(f.service.buildPrompt(execution).includes(file));
  assert.ok(file.startsWith(path.join(f.paths.stateDir, 'inspiration-media')));
  await f.call('update', { id: idea.id, operationId: id(), expectedRevision: started.revision, patch: { body: '改成文字', attachments: [] } });
  assert.deepEqual(f.store.executionForRun(started.latestExecution.runId).attachments, input.attachments);
  assert.deepEqual(fs.readFileSync(f.store.media.materialize(value.attachment)), value.data);
});

test('attachment preparation failures settle the run instead of stranding a saved note', async t => {
  const f = await fixture(t), value = image(48);
  await upload(f, value);
  const { idea } = await f.call('create', { operationId: id(), body: '', attachments: [value.attachment] });
  f.store.media.materialize = () => { throw Object.assign(new Error('disk failure'), { code: 'INSPIRATION_MEDIA_UNAVAILABLE' }); };
  const started = await f.start(idea);
  await until(() => ['canceled', 'failed', 'skipped'].includes(f.dispatcher.getRun(started.latestExecution.runId)?.status));
  assert.equal(f.service.launched.size, 0);
  assert.deepEqual(f.store.get(idea.id).attachments, [value.attachment]);
});

test('invalid media, incomplete uploads, identity changes, and empty notes are rejected', async t => {
  const f = await fixture(t), value = image(48);
  const write = { attachment: value.attachment, offset: 0, content: value.data.toString('base64') };
  for (const changed of [
    { attachment: { ...value.attachment, mimeType: 'image/svg+xml' } },
    { attachment: { ...value.attachment, size: MAX_MEDIA_BYTES + 1 } },
    { attachment: { ...value.attachment, id: '../escape' } },
    { content: Buffer.from('<html>not an image</html>').toString('base64') },
    { content: write.content + '\n' }, { offset: 1 },
  ]) await assert.rejects(f.call('media.write', { ...write, ...changed }), { code: 'INSPIRATION_INVALID' });
  await upload(f, value);
  await assert.rejects(f.call('media.write', { ...write, attachment: { ...value.attachment, name: 'different.png' } }), { code: 'INSPIRATION_INVALID' });
  const changed = Buffer.from(value.data); changed[20]++;
  await assert.rejects(f.call('media.write', { ...write, content: changed.toString('base64') }), { code: 'INSPIRATION_INVALID' });
  await assert.rejects(f.call('create', { operationId: id(), body: '', attachments: [] }), { code: 'INSPIRATION_INVALID' });
  await assert.rejects(f.call('create', { operationId: id(), body: 'x', attachments: [value.attachment, value.attachment] }), { code: 'INSPIRATION_INVALID' });
  const idea = (await f.call('create', { operationId: id(), body: '', attachments: [value.attachment] })).idea;
  await assert.rejects(f.call('update', { id: idea.id, operationId: id(), expectedRevision: idea.revision, patch: { attachments: [] } }), { code: 'INSPIRATION_INVALID' });
  await f.call('delete', { id: idea.id, operationId: id(), expectedRevision: idea.revision });
  await assert.rejects(f.call('get', { id: idea.id }), { code: 'INSPIRATION_NOT_FOUND' });
});

test('voice notes retain playable bytes and mixed attachments after reopening', async t => {
  const f = await fixture(t), value = image(48);
  const data = Buffer.alloc(80); data.write('RIFF'); data.write('WAVE', 8);
  const voice = { data, attachment: { id: id(), name: '语音.wav', mimeType: 'audio/wav', size: data.length } };
  await upload(f, value); await upload(f, voice);
  const { idea } = await f.call('create', { operationId: id(), body: '今天的灵感', attachments: [value.attachment, voice.attachment] });
  f.store.close(); f.store.open();
  assert.deepEqual((await f.call('get', { id: idea.id })).idea.attachments, [value.attachment, voice.attachment]);
  const audio = await f.call('media.read', { id: voice.attachment.id, offset: 0 });
  assert.equal(audio.attachment.mimeType, 'audio/wav'); assert.deepEqual(Buffer.from(audio.content, 'base64'), data);
});

test('inline media positions survive save, edit, restart and immutable execution snapshots', async t => {
  const f = await fixture(t), value = image(48);
  await upload(f, value);
  for (const textOffset of [-1, 1.5, '2', null, 16 * 1024 + 1]) {
    await assert.rejects(f.call('create', { operationId: id(), body: '前面\n后面',
      attachments: [{ ...value.attachment, textOffset }] }), { code: 'INSPIRATION_INVALID' });
  }
  const inline = { ...value.attachment, textOffset: 3 };
  const { idea } = await f.call('create', { operationId: id(), body: '前面\n后面', attachments: [inline] });
  f.store.close(); f.store.open();
  assert.deepEqual((await f.call('get', { id: idea.id })).idea.attachments, [inline]);
  const started = await f.start(idea);
  assert.deepEqual(f.store.executionForRun(started.latestExecution.runId).attachments, [inline]);
  const moved = { ...inline, textOffset: 6 };
  await f.call('update', { id: idea.id, operationId: id(), expectedRevision: started.revision,
    patch: { body: '新增\n前面\n后面', attachments: [moved] } });
  assert.deepEqual(f.store.get(idea.id).attachments, [moved]);
  assert.deepEqual(f.store.executionForRun(started.latestExecution.runId).attachments, [inline]);
});

test('GIF, HEIC, MP4, WebM and Live Photo MOV resources persist without changing their originals', async t => {
  const f = await fixture(t), attachments = [];
  for (const [mimeType, name, header] of [
    ['image/gif', 'animated.gif', '474946383961'], ['image/heic', 'IMG_1234.HEIC', '000000186674797068656963'],
    ['image/heif', 'photo.heif', '00000018667479706d696631'], ['video/quicktime', 'IMG_1234.MOV', '000000146674797071742020'],
    ['video/mp4', 'movie.mp4', '000000186674797069736f6d'], ['video/webm', 'movie.webm', '1a45dfa3'],
  ]) {
    const data = Buffer.concat([Buffer.from(header, 'hex'), Buffer.alloc(64)]);
    const attachment = { id: id(), name, mimeType, size: data.length };
    await upload(f, { attachment, data }); attachments.push(attachment);
    assert.deepEqual(Buffer.from((await f.call('media.read', { id: attachment.id, offset: 0 })).content, 'base64'), data);
    assert.deepEqual(fs.readFileSync(f.store.media.materialize(attachment)), data);
  }
  const { idea } = await f.call('create', { operationId: id(), body: '', attachments });
  f.store.close(); f.store.open();
  assert.deepEqual((await f.call('get', { id: idea.id })).idea.attachments, attachments);
  await assert.rejects(f.call('media.read', { id: attachments[0].id, offset: 0, preview: 'yes' }), { code: 'INSPIRATION_INVALID' });
  await assert.rejects(f.call('media.write', { attachment: { ...attachments[4], size: MAX_VIDEO_BYTES + 1 }, offset: 0, content: 'AAAA' }), { code: 'INSPIRATION_INVALID' });
});

test('compatible previews return their own MIME and size with chunk integrity while preserving source metadata', async t => {
  const f = await fixture(t);
  const data = Buffer.from('00000018667479706865696300000000', 'hex');
  const attachment = { id: id(), name: 'IMG_1234.HEIC', mimeType: 'image/heic', size: data.length };
  await upload(f, { attachment, data });
  const { previewPath } = require('../app/agent-service/inspiration-media-preview');
  const { atomicWritePrivateFile } = require('../app/agent-service/private-file');
  const preview = Buffer.alloc(CHUNK_BYTES + 123, 5); Buffer.from('ffd8ff', 'hex').copy(preview);
  atomicWritePrivateFile(previewPath(f.paths, attachment), preview, { trustedRoot: f.paths.trustedRoot });
  const chunks = [];
  for (const offset of [0, CHUNK_BYTES]) {
    const result = await f.call('media.read', { id: attachment.id, offset, preview: true });
    assert.equal(result.attachment.mimeType, 'image/jpeg'); assert.equal(result.attachment.size, preview.length);
    chunks.push(Buffer.from(result.content, 'base64'));
  }
  assert.deepEqual(Buffer.concat(chunks), preview);
  assert.deepEqual(f.store.media.descriptor(attachment.id), attachment);
  assert.deepEqual(Buffer.from((await f.call('media.read', { id: attachment.id, offset: 0 })).content, 'base64'), data);
  await assert.rejects(f.call('media.read', { id: attachment.id, offset: CHUNK_BYTES * 2, preview: true }), { code: 'INSPIRATION_INVALID' });
});
