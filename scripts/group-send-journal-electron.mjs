#!/usr/bin/env node
// Real Chromium IndexedDB, isolated profile, no Service / Provider calls.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, ".."), require = createRequire(path.join(root, "app/manage-ui/package.json"));
const { build } = require("esbuild");
const { canonicalGroupSendPayload: serverCanonical } = require(path.join(root, "app/group-send-payload.js"));
const vectors = [{ groupId: "g", clientMessageId: "same", body: "你好🙂", mentions: ["b", "a"] },
  { groupId: "g", clientMessageId: "id", body: "", mentions: [], replyTo: 3, taskId: "t", attachments: [{ size: 8, mimeType: "text/plain", name: "文档", id: "file", textOffset: 0 }], requestMode: "append", discussionId: "d", summaryMemberId: "m", expectedPolicyVersion: 2, ownerScope: "excluded" }];
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-group-journal-"));
try {
  const fixture = String.raw`
import { GroupSendJournal, GroupDraftSession, emptyGroupComposer, canonicalGroupSendPayload, groupSendDigest } from "./app/manage-ui/src/lib/groupSendJournal";
const w = window as any, equal=(a:any,b:any,label:string)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw Error(label+': '+JSON.stringify(a)+' != '+JSON.stringify(b))};
const rejects=async(work:()=>Promise<any>,code:string)=>{try{await work()}catch(error:any){equal(error.code,code,code);return}throw Error('expected '+code)};
w.runJournalFixture=async(vectors:any[])=>{
  const checks:string[]=[],check=(label:string)=>checks.push(label);
  for(const vector of vectors)equal(canonicalGroupSendPayload(vector.input.groupId,vector.input),vector.canonical,'canonical server/client parity');check('canonical parity');
  const one=new GroupSendJournal(indexedDB,'journal-proof'),two=new GroupSendJournal(indexedDB,'journal-proof');
  const composer={...emptyGroupComposer(),text:'first',files:[{id:'f',name:'file',status:'ready' as const,attachment:{id:'f',name:'file',mimeType:'text/plain',size:1}}]};
  let draft=await one.saveComposer('owner','g','draft',1,composer,0);
  const input={clientMessageId:'original',body:'first',mentions:[],attachments:[composer.files[0].attachment],ownerScope:'owner'};
  const frozen=await one.prepare('owner','g',input,draft);input.body='mutated';
  equal((await one.read('owner','g')).sends[0].inputSnapshot.body,'first','frozen payload copied');
  equal((await one.read('other','g')).sends.length,0,'owner scope isolation');check('frozen payload and owner');
  const replay=await two.prepare('owner','g',frozen.inputSnapshot,draft);equal(replay.payloadDigest,frozen.payloadDigest,'same identity idempotent');
  await rejects(()=>two.prepare('owner','g',{...frozen.inputSnapshot,body:'other'},draft),'GROUP_SEND_PAYLOAD_CONFLICT');check('same ID payload conflict');
  const race=await Promise.allSettled([one.saveComposer('owner','g','draft',2,{...composer,text:'window one'},draft.storageRevision),two.saveComposer('owner','g','draft',2,{...composer,text:'window two'},draft.storageRevision)]);
  equal(race.filter(value=>value.status==='fulfilled').length,1,'draft CAS single winner');
  equal(race.filter(value=>value.status==='rejected').length,1,'draft CAS refuses overwrite');check('multiwindow CAS');
  const changed=(await one.read('owner','g')).draft!;
  const accepted=await one.accepted(frozen,{id:'message',groupId:'g',seq:4} as any,'discussion');
  equal(accepted.draft?.composer.text,changed.composer.text,'old ACK retains new draft');
  const late=await two.update(frozen,{phase:'needs_verification',lastError:'late failure'});
  equal(late.phase,'observed','late failure cannot downgrade accepted');check('ACK draft and monotonic receipt');
  await one.close();await two.close();const restarted=new GroupSendJournal(indexedDB,'journal-proof');
  const recovered=await restarted.read('owner','g');equal(recovered.sends[0].clientMessageId,'original','restart keeps original identity');equal(recovered.draft?.composer.text,changed.composer.text,'restart keeps revision');check('restart read-only recovery');
  const scope=new GroupDraftSession('owner','g',recovered.draft,restarted);scope.update({...scope.composer,text:'sent A'});draft=await scope.persist();
  const a=await restarted.prepare('owner','g',{clientMessageId:'A',body:'sent A',mentions:[]},draft);
  scope.update({...scope.composer,text:'draft B'});await scope.persist();equal(await scope.accepted(a,{id:'ma',groupId:'g',seq:5}as any,'da'),false,'session preserves B');equal(scope.composer.text,'draft B','session text remains B');check('session revision');
  const active=await restarted.saveComposer('owner','fork-group','current',1,{...emptyGroupComposer(),text:'current B'},0);
  const detached=await restarted.saveComposer('owner','fork-group','fork',0,{...emptyGroupComposer(),text:'original A'},0,true);
  const fork=await restarted.prepare('owner','fork-group',{clientMessageId:'fork-id',body:'original A',mentions:[],requestMode:'new'},detached);
  equal((await restarted.read('owner','fork-group')).draft?.draftId,active.draftId,'detached fork not composer');
  await restarted.accepted(fork,{id:'fork-message',groupId:'fork-group',seq:1}as any,'fork-discussion');equal((await restarted.read('owner','fork-group')).draft?.composer.text,'current B','fork ACK preserves active B');check('detached fork preserves active draft');
  const full=new GroupSendJournal(indexedDB,'full-proof',{records:1,drafts:10,bytes:100000,entryBytes:50000,confirmedRetentionMs:0});
  const fd=await full.saveComposer('owner','g','d',1,composer,0);await full.prepare('owner','g',{clientMessageId:'one',body:'one',mentions:[]},fd);
  await rejects(()=>full.prepare('owner','g',{clientMessageId:'two',body:'two',mentions:[]},fd),'GROUP_JOURNAL_FULL');equal((await full.read('owner','g')).sends.length,1,'full transaction rolls back');check('quota retains unconfirmed');
  const absent=new GroupSendJournal(null as any,'absent');await rejects(()=>absent.read('owner','g'),'GROUP_JOURNAL_UNAVAILABLE');check('unavailable persistence');
  const corrupt=new GroupSendJournal(indexedDB,'corrupt-proof');await corrupt.read('owner','g');
  await new Promise<void>((resolve,reject)=>{const req=indexedDB.open('corrupt-proof');req.onsuccess=()=>{const tx=req.result.transaction('send_journal','readwrite');tx.objectStore('send_journal').put({key:'broken'});tx.oncomplete=()=>{req.result.close();resolve()};tx.onerror=()=>reject(tx.error)}});
  await rejects(()=>corrupt.read('owner','g'),'GROUP_JOURNAL_CORRUPT');check('corruption refuses silent loss');
  await Promise.all([restarted.close(),full.close(),corrupt.close()]);
  return {passed:true,checks,providerCalls:0};
};
w.runRestartFixture=async()=>{const journal=new GroupSendJournal(indexedDB,'journal-proof');const recovered=await journal.read('owner','g');equal(recovered.sends.map((row:any)=>row.clientMessageId).sort(),['A','original'],'process restart keeps exact operations');equal(recovered.draft?.composer.text,'draft B','process restart keeps current draft');await journal.close();return{passed:true,checks:['separate Electron process persistent original identities and draft'],providerCalls:0}};`;
  await build({ stdin: { contents: fixture, loader: "ts", resolveDir: root }, bundle: true, format: "esm", outfile: path.join(temp, "fixture.js"), logLevel: "silent" });
  fs.writeFileSync(path.join(temp, "index.html"), '<script type="module" src="fixture.js"></script>');
  fs.writeFileSync(path.join(temp, "main.cjs"), `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(temp,"profile"))});app.whenReady().then(async()=>{const w=new BrowserWindow({show:false});let ok=false;try{await w.loadFile(${JSON.stringify(path.join(temp,"index.html"))});const expression=process.argv.includes('--recovery-only')?'window.runRestartFixture()':'window.runJournalFixture('+${JSON.stringify(JSON.stringify(vectors.map(input=>({input,canonical:serverCanonical(input)}))))}+')';const result=await w.webContents.executeJavaScript(expression);console.log(JSON.stringify(result));ok=true;}catch(error){console.error(error.stack||error)}finally{w.destroy();app.exit(ok?0:1)}});`);
  for (const restart of [false, true]) {
    const child = spawn(require("electron"), [path.join(temp, "main.cjs"), ...(restart ? ["--recovery-only"] : [])], { env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", data => process.stdout.write(data)); child.stderr.on("data", data => process.stderr.write(data));
    const timer = setTimeout(() => child.kill("SIGTERM"), 60000);
    const status = await new Promise((resolve,reject)=>{child.once("exit",resolve);child.once("error",reject)});clearTimeout(timer);assert.equal(status,0,"IndexedDB acceptance failed");
  }
} finally { fs.rmSync(temp,{recursive:true,force:true}); }
