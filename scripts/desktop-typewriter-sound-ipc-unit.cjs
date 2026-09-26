'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { registerDesktopTypewriterSoundIpc, START_CHANNEL, STOP_CHANNEL } = require('../app/desktop-typewriter-sound-ipc');

const ipcMain = new EventEmitter();
const wc = Object.assign(new EventEmitter(), {
  mainFrame: {}, isDestroyed: () => false, getURL: () => 'http://127.0.0.1:18799/#/inspirations',
});
const window = { webContents: wc, isDestroyed: () => false };
const children = [], launches = [];
const dispose = registerDesktopTypewriterSoundIpc({ ipcMain, getWindows: () => [window],
  getUiOrigin: () => 'http://127.0.0.1:18799', audioPath: '/fixed/audio/typewriter-loop.wav',
  spawnProcess(command, args, options) {
    const child = Object.assign(new EventEmitter(), { killed: false, kill() { this.killed = true; } });
    launches.push({ command, args, options }); children.push(child);
    return child;
  } });
const event = { sender: wc, senderFrame: wc.mainFrame };
try {
  ipcMain.emit(START_CHANNEL, { ...event, senderFrame: {} });
  ipcMain.emit(START_CHANNEL, { ...event, sender: { ...wc, getURL: () => 'https://untrusted.test/' } });
  assert.equal(launches.length, 0, 'only a trusted main frame can start native audio');
  ipcMain.emit(START_CHANNEL, event);
  assert.deepEqual(launches[0], { command: '/usr/bin/afplay',
    args: ['-v', '0.3', '-r', '2.5', '/fixed/audio/typewriter-loop.wav'], options: { stdio: 'ignore' } });
  ipcMain.emit(STOP_CHANNEL, { ...event, senderFrame: {} });
  assert.equal(children[0].killed, false, 'untrusted frames cannot control another frame\'s sound');
  ipcMain.emit(START_CHANNEL, event);
  assert.equal(children[0].killed, true, 'a new burst stops its predecessor');
  wc.emit('did-start-navigation', { isMainFrame: false });
  assert.equal(children[1].killed, false);
  wc.emit('did-start-navigation', { isMainFrame: true });
  assert.equal(children[1].killed, true, 'navigation stops audio even without renderer cleanup');
  ipcMain.emit(START_CHANNEL, event);
  ipcMain.emit(STOP_CHANNEL, event);
  assert.equal(children[2].killed, true, 'typing stop ends native playback');
  ipcMain.emit(START_CHANNEL, event);
  children[3].emit('error', new Error('AudioQueueStart failed'));
  ipcMain.emit(STOP_CHANNEL, event);
  ipcMain.emit(START_CHANNEL, event);
  wc.emit('destroyed');
  assert.equal(children[4].killed, true, 'renderer destruction stops audio');
} finally { dispose(); }
assert.equal(ipcMain.listenerCount(START_CHANNEL), 0);
assert.equal(ipcMain.listenerCount(STOP_CHANNEL), 0);
assert.equal(wc.listenerCount('did-start-navigation'), 0);
console.log('PASS desktop typewriter output: trusted frame, fixed afplay command, 2.5x rate, stop/restart, navigation, errors, destruction and disposal');
