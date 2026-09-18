#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { registerDesktopBoardWidgetIpc } = require("../app/desktop-board-widget-ipc");

(async () => {
  const handlers = new Map();
  const removed = [];
  const ipcMain = {
    handle(channel, handler) { assert.equal(handlers.has(channel), false); handlers.set(channel, handler); },
    removeHandler(channel) { removed.push(channel); handlers.delete(channel); },
  };
  const mainFrame = { routingId: 1 };
  const webContents = { id: 42, mainFrame, isDestroyed: () => false };
  const window = { webContents, isDestroyed: () => false };
  const calls = [];
  const registry = {
    async fetchSessionBoardHtmlWidget(backend, agentId, sessionKey, spec) {
      calls.push(["fetch", backend, agentId, sessionKey, spec]);
      return {
        supported: true,
        ok: true,
        html: Buffer.from("<!doctype html><title>safe</title>"),
        boardRevision: 4,
        widgetIdentity: { ...spec },
        viewGeneration: "a".repeat(32),
      };
    },
  };
  const ticket = "T".repeat(43);
  const nonce = "N".repeat(32);
  const host = {
    async issue(value) {
      calls.push(["issue", value]);
      return { ticket, nonce, url: `http://127.0.0.1:43210/v1/board-widget/${ticket}`, expiresAt: Date.now() + 30_000 };
    },
    async markReady(value) { calls.push(["ready", value]); return true; },
    async revokeTicket(value) { calls.push(["revoke", value]); },
    async revokeOwner(value) { calls.push(["owner", value]); },
    async revokeAll() { calls.push(["all"]); },
  };
  const navigation = {
    allowTicket(value) { calls.push(["allow", value]); },
    revokeTicket(value) { calls.push(["nav-revoke", value]); },
    revokeOwner(value) { calls.push(["nav-owner", value]); },
    clear() { calls.push(["nav-clear"]); },
  };
  const control = registerDesktopBoardWidgetIpc({
    ipcMain,
    getMainWindow: () => window,
    getRegistry: () => registry,
    getHost: () => host,
    navigationGuard: navigation,
  });
  assert.deepEqual([...handlers.keys()].sort(), [
    "shoggoth:board-widget:mint",
    "shoggoth:board-widget:ready",
    "shoggoth:board-widget:revoke",
  ]);

  const mint = handlers.get("shoggoth:board-widget:mint");
  const ready = handlers.get("shoggoth:board-widget:ready");
  const revoke = handlers.get("shoggoth:board-widget:revoke");
  const trusted = { sender: webContents, senderFrame: mainFrame };
  const request = {
    backend: "openclaw",
    agentId: "main",
    sessionKey: "agent:main:main",
    spec: { name: "weather.card", revision: 3, instanceId: "a".repeat(32) },
  };
  assert.equal((await mint({ sender: webContents, senderFrame: {} }, request)).error.code,
    "PRIVILEGED_RENDERER_REQUIRED");
  assert.equal((await mint(trusted, { ...request, extra: true })).error.code,
    "INVALID_BOARD_WIDGET_REQUEST");

  const minted = await mint(trusted, request);
  assert.deepEqual(minted, {
    ok: true,
    value: {
      frameUrl: `http://127.0.0.1:43210/v1/board-widget/${ticket}`,
      ticketId: ticket,
      nonce,
      widgetIdentity: request.spec,
    },
  });
  const issueCall = calls.find(([kind]) => kind === "issue");
  assert.equal(Buffer.isBuffer(issueCall[1].html), true);
  assert.equal(issueCall[1].scope, "openclaw\0main\0agent:main:main");
  assert.equal(issueCall[1].identity.viewGeneration, "a".repeat(32));

  assert.equal((await ready(trusted, { ticketId: ticket, nonce: "X".repeat(32) })).error.code,
    "BOARD_WIDGET_READY_FAILED");
  assert.deepEqual(await ready(trusted, { ticketId: ticket, nonce }), {
    ok: true, value: { ready: true },
  });
  assert.deepEqual(await revoke(trusted, { ticketId: ticket }), {
    ok: true, value: { revoked: true },
  });
  assert.equal(calls.some(([kind, value]) => kind === "revoke" && value === ticket), true);
  assert.equal(calls.some(([kind, value]) => kind === "nav-revoke" && value === ticket), true);

  const second = await mint(trusted, {
    ...request,
    spec: { name: "second", revision: 4, instanceId: "b".repeat(32) },
  });
  assert.equal(second.ok, true);
  await control.revokeOwner(42);
  assert.equal(calls.some(([kind, value]) => kind === "owner" && value === 42), true);
  assert.equal(calls.some(([kind, value]) => kind === "nav-owner" && value === 42), true);

  let releaseFetch;
  let fetchEntries = 0;
  const blockedFetch = new Promise((resolve) => { releaseFetch = resolve; });
  registry.fetchSessionBoardHtmlWidget = async (_backend, _agentId, _sessionKey, spec) => {
    fetchEntries += 1;
    await blockedFetch;
    return {
      supported: true,
      ok: true,
      html: Buffer.from("<!doctype html><title>concurrent</title>"),
      boardRevision: 5,
      widgetIdentity: { ...spec },
      viewGeneration: spec.instanceId,
    };
  };
  const concurrentMints = Array.from({ length: 129 }, () => mint(trusted, request));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchEntries, 128,
    "capacity must be reserved before awaiting the backend fetch");
  assert.deepEqual(await concurrentMints[128], {
    ok: false,
    error: { code: "BOARD_WIDGET_MINT_FAILED", message: "Board Widget 宿主容量不足" },
  });
  releaseFetch();
  const admitted = await Promise.all(concurrentMints.slice(0, 128));
  assert.equal(admitted.every((result) => result.ok === true), true);

  await control.revokeOwner(42);
  let releaseStaleFetch;
  const staleFetch = new Promise((resolve) => { releaseStaleFetch = resolve; });
  registry.fetchSessionBoardHtmlWidget = async (_backend, _agentId, _sessionKey, spec) => {
    await staleFetch;
    return {
      supported: true,
      ok: true,
      html: Buffer.from("<!doctype html><title>stale</title>"),
      boardRevision: 6,
      widgetIdentity: { ...spec },
      viewGeneration: spec.instanceId,
    };
  };
  const staleMint = mint(trusted, request);
  await new Promise((resolve) => setImmediate(resolve));
  const issueCountBeforeRevoke = calls.filter(([kind]) => kind === "issue").length;
  await control.revokeOwner(42);
  releaseStaleFetch();
  assert.equal((await staleMint).error.code, "BOARD_WIDGET_UNAVAILABLE");
  assert.equal(calls.filter(([kind]) => kind === "issue").length, issueCountBeforeRevoke,
    "an owner revocation must invalidate an in-flight mint before host issuance");

  registry.fetchSessionBoardHtmlWidget = async (_backend, _agentId, _sessionKey, spec) => ({
    supported: true,
    ok: true,
    html: Buffer.from("<!doctype html><title>issue-race</title>"),
    boardRevision: 7,
    widgetIdentity: { ...spec },
    viewGeneration: spec.instanceId,
  });
  const originalIssue = host.issue;
  let announceIssue;
  let releaseIssue;
  const issueEntered = new Promise((resolve) => { announceIssue = resolve; });
  const blockedIssue = new Promise((resolve) => { releaseIssue = resolve; });
  host.issue = async (value) => {
    calls.push(["issue", value]);
    announceIssue();
    await blockedIssue;
    return { ticket, nonce, url: `http://127.0.0.1:43210/v1/board-widget/${ticket}`, expiresAt: Date.now() + 30_000 };
  };
  const issueRaceMint = mint(trusted, request);
  await issueEntered;
  const allowCountBeforeIssueRace = calls.filter(([kind]) => kind === "allow").length;
  await control.revokeOwner(42);
  releaseIssue();
  assert.equal((await issueRaceMint).error.code, "BOARD_WIDGET_UNAVAILABLE");
  assert.equal(calls.filter(([kind]) => kind === "allow").length, allowCountBeforeIssueRace,
    "owner revocation during host issuance must not create a navigation allowance");
  assert.equal(calls.some(([kind, value]) => kind === "revoke" && value === ticket), true);
  host.issue = originalIssue;

  const readyRaceLease = await mint(trusted, request);
  assert.equal(readyRaceLease.ok, true);
  const originalMarkReady = host.markReady;
  let announceReady;
  let releaseReady;
  const readyEntered = new Promise((resolve) => { announceReady = resolve; });
  const blockedReady = new Promise((resolve) => { releaseReady = resolve; });
  host.markReady = async (value) => {
    calls.push(["ready", value]);
    announceReady();
    await blockedReady;
    return true;
  };
  const readyRace = ready(trusted, { ticketId: ticket, nonce });
  await readyEntered;
  await control.revokeOwner(42);
  releaseReady();
  assert.equal((await readyRace).error.code, "BOARD_WIDGET_READY_FAILED",
    "owner revocation during ready must not reactivate a deleted lease");
  host.markReady = originalMarkReady;

  await control.dispose();
  assert.deepEqual(removed.sort(), [
    "shoggoth:board-widget:mint",
    "shoggoth:board-widget:ready",
    "shoggoth:board-widget:revoke",
  ]);
  assert.equal(calls.some(([kind]) => kind === "all"), true);
  assert.equal(calls.some(([kind]) => kind === "nav-clear"), true);
  console.log("desktop-board-widget-ipc-unit: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
