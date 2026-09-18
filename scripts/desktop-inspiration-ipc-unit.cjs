'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CHANNEL, registerDesktopInspirationIpc } = require('../app/desktop-inspiration-ipc');

for (const surface of ['main', 'desktop']) test(`${surface} archive save requires its main frame, honors cancellation and writes only the dialog-selected path`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shg-export-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'notes.zip'); await fs.writeFile(target, 'existing');
  let closed = false;
  const mainFrame = {}, window = { isDestroyed: () => closed, webContents: { mainFrame, isDestroyed: () => false } };
  const otherWindow = { isDestroyed: () => false, webContents: { mainFrame: {}, isDestroyed: () => false },
    show() { assert.fail('saving from the desktop must not show the main app'); } };
  const event = { sender: window.webContents, senderFrame: mainFrame };
  let handler, canceled = true, calls = 0, chosen = target, closeDuringDialog = false;
  const dispose = registerDesktopInspirationIpc({ getMainWindow: () => surface === 'main' ? window : otherWindow,
    getDesktopWindow: () => surface === 'desktop' ? window : otherWindow,
    ipcMain: { handle(channel, fn) { assert.equal(channel, CHANNEL); handler = fn; }, removeHandler() {} },
    dialog: { async showSaveDialog(owner, options) {
      assert.equal(owner, window, 'the caller owns the native save dialog'); assert.equal(options.defaultPath, 'notes.zip'); calls++;
      if (closeDuringDialog) closed = true;
      return { canceled, filePath: chosen };
    } },
  });
  const input = { name: 'notes.zip', bytes: new Uint8Array([80, 75, 3, 4, 42]) };
  assert.equal((await handler({ ...event, senderFrame: {} }, input)).ok, false); assert.equal(calls, 0);
  assert.equal((await handler({ ...event, sender: {} }, input)).ok, false); assert.equal(calls, 0);
  assert.equal((await handler(event, { ...input, name: '../notes.zip' })).ok, false); assert.equal(calls, 0);
  assert.deepEqual(await handler(event, input), { ok: true, canceled: true });
  assert.equal(await fs.readFile(target, 'utf8'), 'existing');
  canceled = false;
  assert.deepEqual(await handler(event, input), { ok: true, canceled: false });
  assert.deepEqual(await fs.readFile(target), Buffer.from(input.bytes));
  assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(root), ['notes.zip']);
  chosen = path.join(root, 'blocked'); await fs.mkdir(chosen); await fs.writeFile(path.join(chosen, 'keep'), 'keep');
  assert.equal((await handler(event, input)).ok, false, 'failed replacement leaves the destination intact');
  assert.equal(await fs.readFile(path.join(chosen, 'keep'), 'utf8'), 'keep');
  assert.deepEqual((await fs.readdir(root)).sort(), ['blocked', 'notes.zip']);
  closeDuringDialog = true; chosen = path.join(root, 'closed.zip');
  assert.deepEqual(await handler(event, input), { ok: false, error: 'PRIVILEGED_RENDERER_REQUIRED' });
  assert.deepEqual((await fs.readdir(root)).sort(), ['blocked', 'notes.zip'], 'closing the caller while choosing a path must not write a file');
  dispose();
});
