'use strict';
const assert = require('node:assert/strict');
const { registerDesktopMicrophoneIpc, CHANNEL, STATUS_CHANNEL } = require('../app/desktop-microphone-ipc');
const handlers = new Map();
const ipcMain = { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) };
let check, request, status = 'not-determined', prompts = 0, now = 0;
const wc = { mainFrame: {}, isDestroyed: () => false, getURL: () => 'http://127.0.0.1:18799/#/inspirations' };
const window = { webContents: wc, isDestroyed: () => false };
const session = { setPermissionCheckHandler: value => { check = value; }, setPermissionRequestHandler: value => { request = value; } };
const dispose = registerDesktopMicrophoneIpc({ ipcMain, session, getWindows: () => [window], getUiOrigin: () => 'http://127.0.0.1:18799', platform: 'darwin', now: () => now,
  systemPreferences: { getMediaAccessStatus: () => status, askForMediaAccess: async () => { prompts++; return true; } } });
const mediaRequest = (types, mainFrame = true) => { let value; request(wc, 'media', result => { value = result; }, { isMainFrame: mainFrame, mediaTypes: types }); return value; };
(async () => {
  try {
    for (const value of ['not-determined', 'denied', 'restricted', 'unknown', 'granted']) {
      status = value;
      assert.equal(await handlers.get(STATUS_CHANNEL)({ sender: wc, senderFrame: wc.mainFrame }), value);
      assert.equal(prompts, 0, 'reading audio permission for an ambient effect never prompts');
      assert.equal(mediaRequest(['audio']), false, 'reading status cannot grant recording access');
    }
    assert.throws(() => handlers.get(STATUS_CHANNEL)({ sender: wc, senderFrame: {} }), /Untrusted/);
    status = 'not-determined';
    assert.equal(check(wc, 'media', '', { mediaType: 'audio' }), false);
    assert.equal(mediaRequest(['audio']), false);
    assert.equal(prompts, 0, 'opening a page or probing devices must never request macOS microphone access');
    await assert.rejects(handlers.get(CHANNEL)({ sender: wc, senderFrame: {} }), /Untrusted/);
    assert.equal(prompts, 0);
    assert.equal(await handlers.get(CHANNEL)({ sender: wc, senderFrame: wc.mainFrame }), true);
    assert.equal(prompts, 1); assert.equal(check(wc, 'media', '', { mediaType: 'audio' }), true);
    assert.equal(mediaRequest(['audio']), true);
    assert.equal(mediaRequest(['video']), false); assert.equal(mediaRequest(['audio', 'video']), false); assert.equal(mediaRequest(['audio'], false), false);
    now = 16_000; assert.equal(check(wc, 'media', '', { mediaType: 'audio' }), false);
    status = 'granted';
    assert.equal(await handlers.get(CHANNEL)({ sender: wc, senderFrame: wc.mainFrame }), true); assert.equal(prompts, 1, 'an existing OS grant does not prompt again');
    wc.mainFrame = {}; assert.equal(mediaRequest(['audio']), false, 'a new document cannot inherit a recording gesture');
    status = 'denied'; assert.equal(await handlers.get(CHANNEL)({ sender: wc, senderFrame: wc.mainFrame }), false); assert.equal(prompts, 1);
  } finally { dispose(); }
  assert.equal(check, null); assert.equal(request, null); assert.equal(handlers.size, 0);
  console.log('PASS microphone permission: status checks never prompt or grant access, no prompt on mount/probes, explicit recording gesture, OS grant reuse, denial, audio-only scope and document expiry');
})().catch(error => { console.error(error); process.exitCode = 1; });
