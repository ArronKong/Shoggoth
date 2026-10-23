#!/usr/bin/env node
"use strict";
// Actual Codex wire -> Host schema -> WorkRun -> group projection -> Service
// event log -> Backend/Registry -> proxy/broker WS -> production Panel REST ->
// React DOM and two compositor frames. Only the native model process is fake.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process"), { createRequire } = require("node:module");
const { startInspirationFixture } = require("./fixtures/inspiration-service-fixture.cjs");
const root = path.resolve(__dirname, ".."), requireUi = createRequire(path.join(root, "app/manage-ui/package.json"));
const { build } = requireUi("esbuild");
const output = path.resolve(process.env.GROUP_LATENCY_OUTPUT || path.join(root, ".artifacts/group-collaboration-optimization/group-latency/result.json"));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeout = 20000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await read(); if (value) return value; await sleep(10); } throw Error(label); }
function listeners() { const r = spawnSync("/usr/sbin/lsof", ["-nP", "-iTCP:18799", "-sTCP:LISTEN", "-Fpctn"], { encoding: "utf8", timeout: 3000 }); assert([0, 1].includes(r.status)); return r.stdout || ""; }
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
// Mailbox requests are consumed by another process immediately after publish.
// Close and fsync the private staging file, then rename as the final operation;
// persistent-file postcommit identity checks do not fit a consumable mailbox.
function publishMailbox(target, value) {
  const staged = target + ".publishing", fd = fs.openSync(staged, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(staged, target);
}
const fixture = String.raw`
import React from 'react';import{createRoot}from'react-dom/client';import GroupChatPanel from './app/manage-ui/src/pages/GroupChatPanel';
import{UiProvider}from './app/manage-ui/src/components/ui';import{emitGroupChanged}from './app/manage-ui/src/lib/groupChat';
import{emitGroupConnection}from './app/manage-ui/src/lib/groupSendJournal';import i18n from './app/manage-ui/src/i18n';
import './app/manage-ui/src/styles.css';import './app/manage-ui/src/manage-skin.css';import './app/manage-ui/src/pages/ChatPage.css';
const state=window as any,options=state.fixtureOptions,observations=new Map<string,any>(),pending=new Set<string>();
state.fixtureErrors=[];addEventListener('error',e=>state.fixtureErrors.push(e.message));addEventListener('unhandledrejection',e=>state.fixtureErrors.push(String(e.reason)));
document.body.innerHTML='<div id="root" class="chat-shell"></div>';const css=document.createElement('link');css.rel='stylesheet';css.href='/__fixture/fixture.css';document.head.append(css);
const style=document.createElement('style');style.textContent='html,body,#root{margin:0;height:100%;min-height:0}#root{display:flex;flex-direction:column}';document.head.append(style);
await i18n.changeLanguage('zh-CN');document.documentElement.setAttribute('data-theme','light');
const record=(marker:string,kind:string,node:Element)=>{if(observations.has(marker)||pending.has(marker))return;pending.add(marker);requestAnimationFrame(()=>requestAnimationFrame(()=>{pending.delete(marker);if(!node.isConnected||!node.textContent?.includes(marker))return;observations.set(marker,{marker,kind,renderedAt:Date.now(),activityId:node.closest('[data-group-activity]')?.getAttribute('data-group-activity'),phase:node.closest('[data-group-activity]')?.getAttribute('data-activity-phase'),visible:document.visibilityState==='visible',focused:document.hasFocus()})}))};
const scan=()=>{for(const node of document.querySelectorAll('[data-group-activity] [class*=executionTitle]')){const marker=node.textContent?.match(/latency-\d+-\d+/)?.[0];if(marker)record(marker,'activity',node)}const name=document.querySelector('.chat-header__name');if(name?.textContent?.startsWith('recovery-'))record(name.textContent,'recovery',name)};
new MutationObserver(scan).observe(document.body,{childList:true,subtree:true,characterData:true});
const ws=new WebSocket(location.origin.replace('http:','ws:')+'/__chatws');state.fixtureWsEvents=0;state.fixtureWsOpened=false;state.fixtureWsReady=false;state.fixtureWsFrames=[];state.fixtureWsClose=null;
ws.onopen=()=>{state.fixtureWsOpened=true;emitGroupConnection()};ws.onclose=e=>state.fixtureWsClose={code:e.code,reason:e.reason};ws.onmessage=e=>{const f=JSON.parse(e.data);state.fixtureWsFrames.push({type:f.type,event:f.event});if(f.event==='gateway.ready')state.fixtureWsReady=true;if(f.type==='event'&&f.event==='group.changed'){state.fixtureWsEvents++;emitGroupChanged(f.payload.groupId)}};
createRoot(document.getElementById('root')!).render(<UiProvider><GroupChatPanel groupId={options.groupId} onArchived={()=>{}}/></UiProvider>);
state.waitFixtureMarker=async(marker:string)=>{const end=Date.now()+15000;while(!observations.has(marker)){if(state.fixtureErrors.length)throw Error(state.fixtureErrors.join('\n'));if(Date.now()>end)throw Error('DOM marker timeout '+marker);scan();await new Promise(r=>setTimeout(r,10))}return observations.get(marker)};
state.fixtureState=()=>({errors:state.fixtureErrors,wsOpened:state.fixtureWsOpened,wsReady:state.fixtureWsReady,wsClose:state.fixtureWsClose,wsFrames:state.fixtureWsFrames.slice(-15),wsEvents:state.fixtureWsEvents,title:document.querySelector('.chat-header__name')?.textContent,activities:document.querySelectorAll('[data-group-activity]').length,titles:Array.from(document.querySelectorAll('[data-group-activity]')).map(el=>({id:el.getAttribute('data-group-activity'),phase:el.getAttribute('data-activity-phase'),text:el.textContent?.slice(0,1500)})),ready:!!document.querySelector('textarea:not(:disabled)'),visible:document.visibilityState==='visible',focused:document.hasFocus(),observations:observations.size});
state.fixtureLoaded=true;`;
async function main() {
  const temp = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-group-latency-")); fs.chmodSync(temp, 0o700);
  const controlDir = path.join(temp, "main-control"); fs.mkdirSync(controlDir, { mode: 0o700 }); fs.mkdirSync(path.dirname(output), { recursive: true });
  let f, child, deadline, childExit, failure; const activitySamples = [], recoverySamples = [], beforeListeners = listeners();
  const report = { version: 1, status: "running", activitySamples, recoverySamples,
    boundary: "production native wire parser, WorkRun, projection, Service/SQLite, Backend/Registry, proxy/broker WS, actual REST, real Panel in foreground sandboxed Electron; native Codex executable controlled; notification dispatch mirrors ChatPage's group event adapter; no fetch fake and no external Provider",
    root: temp, realUserDataAccess: false, externalModelOrProviderCalls: 0, staticUiEntryExecuted: false, stdout: "", stderr: "" };
  const callMain = async (action, params = {}) => {
    const id = crypto.randomUUID(), request = path.join(controlDir, `${id}.request.json`), response = path.join(controlDir, `${id}.response.json`);
    publishMailbox(request, { id, action, params });
    const result = await until(() => { if (childExit) throw Error(`Electron exited: ${JSON.stringify(childExit)}`); if (fs.existsSync(response)) return JSON.parse(fs.readFileSync(response, "utf8")); }, `Main ${action}`, 25000);
    if (result.error) throw Error(result.error); return result.result;
  };
  const controlRuntime = async (action, context, extra = {}) => {
    const id = crypto.randomUUID(), dir = path.join(f.root, "group-control"), response = path.join(dir, `${id}.response.json`);
    publishMailbox(path.join(dir, `${id}.request.json`), { id, action, threadId: context.threadId, turnId: context.turnId, ...extra });
    const result = await until(() => { try { return JSON.parse(fs.readFileSync(response, "utf8")); } catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return null; throw error; } }, `native wire ${action}`);
    fs.unlinkSync(response); if (result.error) throw Error(JSON.stringify(result.error)); return result.result;
  };
  try {
    await build({ stdin: { contents: fixture, loader: "tsx", resolveDir: root }, bundle: true, format: "esm", jsx: "automatic",
      nodePaths: [path.join(root, "app/manage-ui/node_modules")], loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl" },
      define: { "process.env.NODE_ENV": '"production"' }, outfile: path.join(temp, "fixture.js"), logLevel: "silent" });
    f = await startInspirationFixture({ agentCount: 3, groupControlledRuntime: true, serviceOptions: { prewarmMcpAuth: false } });
    const profiles = f.service.productStore.listAgentProfiles().filter(p => p.enabled);
    const created = await f.ipc("group.create", { operationId: "latency-create", name: "Latency isolation", purpose: "Timing facts only", members: profiles.map(p => ({ backendId: "shoggoth", agentId: p.agentId })) });
    const groupId = created.group.id; report.groupId = groupId;
    report.registryGroupEvents = []; f.registry.on("backend.sessionActivity", event => { if (event.activity?.kind === "group.changed") report.registryGroupEvents.push({ groupId: event.activity.groupId, at: Date.now() }); });
    const response = await fetch(`${f.url}/__api/group-chats/messages?id=${encodeURIComponent(groupId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientMessageId: "latency-initial", ownerScope: created.ownerScope, expectedPolicyVersion: created.group.policyVersion, body: "Measure isolated execution facts", mentions: [], attachments: [], replyTo: null }) });
    assert.equal(response.status, 200, await response.text().then(value => value.slice(0, 150)));
    const turns = await until(async () => { const rows = f.service.groupChatStore.runningOpportunities().filter(t => t.groupId === groupId); return rows.length === 1 && rows.every(t => { const c = f.service.workRunCoordinator.runContexts.get(t.runId); return c?.threadId && c?.turnId && f.service.productStore.getWorkRun(t.runId)?.status === "running"; }) && rows; }, "the owner's accepted native turn");
    const contexts = turns.map(t => ({ opportunityId: t.id, memberId: t.memberId, runId: t.runId, ...f.service.workRunCoordinator.runContexts.get(t.runId) }));
    const options = { root: temp, sourceRoot: root, groupId, url: f.url, output: path.dirname(output) };
    fs.writeFileSync(path.join(temp, "options.json"), JSON.stringify(options), { mode: 0o600 });
    const env = { PATH: process.env.PATH, HOME: path.join(temp, "home"), TMPDIR: temp, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" };
    fs.mkdirSync(env.HOME, { mode: 0o700 });
    child = spawn(require(path.join(root, "node_modules/electron")), [path.join(root, "scripts/fixtures/group-collaboration-latency-electron.cjs"), path.join(temp, "options.json")], { env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", data => { report.stdout += data; }); child.stderr.on("data", data => { report.stderr += data; });
    const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => { childExit = { code, signal }; resolve(childExit); }); });
    deadline = setTimeout(() => child.kill("SIGTERM"), 300000);
    await until(() => { if (childExit) throw Error(`Electron failed ${JSON.stringify(childExit)}: ${report.stderr.slice(-5000)}`); return fs.existsSync(path.join(temp, "meta/ready.json")); }, "actual browser ready", 30000);
    const ready = await callMain("state"); assert.equal(ready.visible, true); assert.equal(ready.windowVisible, true); assert.equal(ready.ready, true); assert.equal(ready.wsOpened, true); assert.equal(ready.activities, 1);
    report.foreground = ready;
    for (let round = 0; round < 40; round++) {
      const events = await Promise.all(contexts.map((context, index) => controlRuntime("activity", context, { marker: `latency-${round}-${index}`, toolCallId: `latency-tool-${round}-${index}` })));
      if (round === 0) {
        await sleep(2000);
        report.firstFactTrace = { emitted: events, view: await f.registry.getGroupChat(groupId), serviceEvents: await f.ipc("events.subscribe", { afterSeq: 0 }),
          tracker: [...f.service.groupChatDriver.drafts.states.entries()].map(([key, state]) => ({ key, afterSeq: state.afterSeq, activity: state.projection?.snapshot() })),
          runToolEvents: await Promise.all(contexts.map(async context => { const value = await f.service.groupChatDriver.executor.readEvents({ runId: context.runId, streamId: null, afterSeq: 0 }); return { runId: context.runId, toolEvents: value.events.filter(e => e.type.startsWith("tool")) }; })),
          browser: await callMain("state") };
      }
      const rendered = await Promise.all(events.map(event => callMain("wait-marker", { marker: event.marker })));
      for (let index = 0; index < events.length; index++) {
        const event = events[index], dom = rendered[index]; assert.equal(dom.kind, "activity"); assert.equal(dom.phase, "tool"); assert.equal(dom.visible, true); assert.equal(dom.windowVisible, true);
        assert.equal(dom.activityId, contexts[index].opportunityId);
        const latencyMs = dom.renderedAt - event.emittedAt; assert(latencyMs >= 0); activitySamples.push({ ...event, ...dom, runId: contexts[index].runId, latencyMs });
      }
      if ((round + 1) % 10 === 0) console.log(`activity facts rendered: ${activitySamples.length}/40`);
    }
    let view = await f.registry.getGroupChat(groupId);
    for (let index = 0; index < 30; index++) {
      const armed = await callMain("arm-fault"), marker = `recovery-${index}`;
      view = await f.registry.updateGroupChat(groupId, { expectedMetadataRevision: view.group.metadataRevision, patch: { name: marker } });
      const authoritativeAt = Date.now(); assert.equal(view.group.name, marker);
      const dom = await callMain("wait-marker", { marker }); const after = await callMain("state");
      assert.equal(after.failedDetailReads, armed.failedDetailReads + 1); assert.equal(dom.kind, "recovery"); assert.equal(dom.visible, true); assert.equal(dom.windowVisible, true);
      const latencyMs = dom.renderedAt - authoritativeAt; assert(latencyMs >= 0); recoverySamples.push({ ...dom, authoritativeAt, metadataRevision: view.group.metadataRevision, latencyMs, failedReads: 1 });
      if ((index + 1) % 10 === 0) console.log(`foreground failed-read recoveries: ${recoverySamples.length}/30`);
    }
    report.finalState = await callMain("state");
    assert.equal(report.finalState.errors.length, 0); assert(report.finalState.wsEvents >= 40); assert.equal(f.service.productStore.listWorkRuns().length, 1, "observing and recovery must never create work");
    report.activity = { samples: activitySamples.length, p50Ms: percentile(activitySamples.map(r => r.latencyMs), .5), p95Ms: percentile(activitySamples.map(r => r.latencyMs), .95), maxMs: Math.max(...activitySamples.map(r => r.latencyMs)) };
    report.recovery = { samples: recoverySamples.length, p50Ms: percentile(recoverySamples.map(r => r.latencyMs), .5), p95Ms: percentile(recoverySamples.map(r => r.latencyMs), .95), maxMs: Math.max(...recoverySamples.map(r => r.latencyMs)) };
    const focusedSummary = rows => { const values = rows.filter(row => row.focused && row.windowFocused).map(row => row.latencyMs); return { samples: values.length, p95Ms: values.length ? percentile(values, .95) : null, maxMs: values.length ? Math.max(...values) : null }; };
    report.foregroundDefinition = "production observer: document.visibilityState visible, native window visible and not minimized, DOM plus two actual requestAnimationFrame callbacks; keyboard focus recorded separately";
    report.focusedSubsets = { activity: focusedSummary(activitySamples), recovery: focusedSummary(recoverySamples) };
    assert.equal(report.activity.samples, 40); assert(report.activity.p95Ms <= 2000, JSON.stringify(report.activity)); assert.equal(report.recovery.samples, 30); assert(report.recovery.maxMs <= 5000, JSON.stringify(report.recovery));
    await callMain("capture"); await callMain("quit"); report.naturalExit = await exited; assert.deepEqual(report.naturalExit, { code: 0, signal: null });
    report.electron = JSON.parse(fs.readFileSync(path.join(temp, "meta/final.json"), "utf8")); assert.equal(report.electron.forbiddenRequests.length, 0); assert.equal(report.electron.completed, true);
    report.status = "passed";
  } catch (error) { failure = error; report.status = "failed"; report.failure = error.stack;
    if (child && !childExit) { report.failedBrowser = await callMain("state").catch(error => ({ error: error.message })); await callMain("capture").catch(() => {}); }
  }
  finally { clearTimeout(deadline); if (child && !childExit) { child.kill("SIGTERM"); await until(() => childExit, "owned Electron exit", 5000).catch(() => child.kill("SIGKILL")); } await f?.close(); report.userListenerUnchanged = listeners() === beforeListeners; report.finishedAt = new Date().toISOString(); fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 }); if (!failure) fs.rmSync(temp, { recursive: true, force: true }); }
  if (failure) throw failure; assert.equal(report.userListenerUnchanged, true); console.log(`PASS production collaboration timing ${JSON.stringify({ activity: report.activity, recovery: report.recovery, output })}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
