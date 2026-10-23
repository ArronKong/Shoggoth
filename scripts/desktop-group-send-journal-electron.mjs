#!/usr/bin/env node
// Production preload + IPC + renderer journal + private Main Store across different origins and two actual processes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const root=path.resolve(import.meta.dirname,".."),require=createRequire(path.join(root,"app/manage-ui/package.json"));
const {build}=require("esbuild"),temp=fs.realpathSync(fs.mkdtempSync("/private/tmp/shoggoth-group-native-ui-"));
const userData=path.join(temp,"profile");fs.mkdirSync(userData,{mode:0o700});
try{
  const fixture=String.raw`
import{GroupSendJournal,emptyGroupComposer,groupSendDigest}from"./app/manage-ui/src/lib/groupSendJournal";
const state=window as any,journal=new GroupSendJournal(),scope='owner',group='g';
const equal=(a:any,b:any,label:string)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw Error(label+': '+JSON.stringify(a)+' != '+JSON.stringify(b))};
state.runNativePrepare=async()=>{
 const oldInput={clientMessageId:'legacy-original',ownerScope:scope,body:'legacy A',mentions:[]};
 const oldDraft={version:1,key:JSON.stringify([scope,'legacy-group','legacy-draft']),ownerScope:scope,groupId:'legacy-group',draftId:'legacy-draft',revision:1,storageRevision:1,composer:{...emptyGroupComposer(),text:'legacy A'},updatedAt:1};
 const oldRecord={journalVersion:1,key:JSON.stringify([scope,'legacy-group','legacy-original']),ownerScope:scope,groupId:'legacy-group',clientMessageId:'legacy-original',payloadDigest:await groupSendDigest('legacy-group',oldInput),inputSnapshot:oldInput,draftId:'legacy-draft',draftRevision:1,composerSnapshot:oldDraft.composer,attachmentRefs:[],phase:'prepared',revision:1,createdAt:1,lastCheckedAt:null,lastError:null,acceptedMessageId:null,acceptedSeq:null,discussionId:null};
 await new Promise<void>((resolve,reject)=>{const open=indexedDB.open('shoggoth-group-journal',1);open.onupgradeneeded=()=>{open.result.createObjectStore('send_journal',{keyPath:'key'});open.result.createObjectStore('composer_snapshots',{keyPath:'key'})};open.onsuccess=()=>{const tx=open.result.transaction(['send_journal','composer_snapshots'],'readwrite');tx.objectStore('send_journal').put(oldRecord);tx.objectStore('composer_snapshots').put(oldDraft);tx.oncomplete=()=>{open.result.close();resolve()};tx.onerror=()=>reject(tx.error)}});
 const draft=await journal.saveComposer(scope,group,'draft',1,{...emptyGroupComposer(),text:'A'},0);
 const record=await journal.prepare(scope,group,{clientMessageId:'original',ownerScope:scope,body:'A',mentions:[],expectedPolicyVersion:1},draft);
 await journal.update(record,{phase:'submitting'});
 const next=await journal.saveComposer(scope,group,'draft',2,{...emptyGroupComposer(),text:'B'},draft.storageRevision);
 equal((await journal.read(scope,'legacy-group')).sends[0].clientMessageId,'legacy-original','legacy migration keeps identity');equal((await journal.read(scope,'legacy-group')).sends[0].phase,'needs_verification','legacy migration never resumes work');
 const originalRows=await new Promise<any[]>((resolve,reject)=>{const open=indexedDB.open('shoggoth-group-journal',1);open.onsuccess=()=>{const request=open.result.transaction('send_journal','readonly').objectStore('send_journal').getAll();request.onsuccess=()=>{open.result.close();resolve(request.result)};request.onerror=()=>reject(request.error)}});equal(originalRows.map(row=>row.clientMessageId),['legacy-original'],'native writes do not create a second origin ledger');
 return{record,next,origin:location.origin};
};
state.runNativeCAS=async(snapshot:any,text:string)=>{try{return{winner:true,value:await journal.saveComposer(scope,group,'draft',3,{...emptyGroupComposer(),text},snapshot.storageRevision)}}catch(error:any){return{winner:false,code:error.code}}};
state.runNativeRecovery=async()=>{
 const read=await journal.read(scope,group);equal(read.sends.length,1,'original survives new process');equal(read.sends[0].clientMessageId,'original','original identity');equal(read.draft?.composer.text.startsWith('B window'),true,'new draft survives different origin');
 equal((await indexedDB.databases()).some(database=>database.name==='shoggoth-group-journal'),false,'new origin did not fabricate a replacement IDB');
 const original=read.sends[0],text=read.draft?.composer.text;
 const proved=await state.openclawDesktop.groupSendJournal.call('accepted',{record:original,message:{id:'forged renderer id',groupId:group,seq:999},discussionId:'forged discussion'});
 equal(proved.ok,true,'Main can confirm its own source');equal(proved.value.record.acceptedMessageId,'canonical','Renderer cannot choose accepted message identity');equal(proved.value.draft.composer.text,text,'Main protects later draft');
 const canonical={id:'canonical',groupId:group,seq:9,author:{kind:'user'}}as any;
 await journal.accepted(original,canonical,'discussion');const recovered=await journal.read(scope,group);equal(recovered.draft?.composer.text,text,'duplicate confirmation does not consume B');equal(recovered.sends[0].phase,'observed','actual lookup confirms receipt');
 const bad=await state.openclawDesktop.groupSendJournal.call('writePath',{path:'/arbitrary/target'});equal(bad.ok,false,'no path capability');
 return{origin:location.origin,originalId:original.clientMessageId,draft:text,phase:recovered.sends[0].phase};
};`;
  await build({stdin:{contents:fixture,loader:"ts",resolveDir:root},bundle:true,format:"esm",outfile:path.join(temp,"fixture.js"),logLevel:"silent"});
  fs.writeFileSync(path.join(temp,"index.html"),'<script type="module" src="/fixture.js"></script>');
  const main=String.raw`
const{app,BrowserWindow,ipcMain}=require('electron'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const root=ROOT,temp=TEMP,userData=USERDATA,phase=Number(process.argv.find(arg=>arg.startsWith('--phase='))?.slice(8)||0);
const{DesktopGroupSendJournalStore}=require(path.join(root,'app/desktop-group-send-journal-store'));
const{registerDesktopGroupSendJournalIpc}=require(path.join(root,'app/desktop-group-send-journal-ipc'));
app.setPath('userData',userData);let windows=[],server,store,ipc,origin,scopeReads=0,lookupReads=0;
ipcMain.on('openclaw:get-config',event=>{event.returnValue={}});
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const create=async(url)=>{const w=new BrowserWindow({show:false,webPreferences:{preload:path.join(root,'app/preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});await w.loadURL(url);return w};
app.whenReady().then(async()=>{let ok=false;try{
 store=new DesktopGroupSendJournalStore({userDataRoot:userData});await store.open();
 server=http.createServer((request,response)=>{const js=request.url==='/fixture.js';response.setHeader('Content-Type',js?'text/javascript':'text/html');response.end(fs.readFileSync(path.join(temp,js?'fixture.js':'index.html')))});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port+'/';
 ipc=registerDesktopGroupSendJournalIpc({ipcMain,getMainWindow:()=>windows[0],getWindows:()=>windows,getUiOrigin:()=>origin,getStore:()=>store,
 getAuthorityScope:async()=>{scopeReads++;return'owner'},lookupSend:async request=>{lookupReads++;return phase===1?{status:'found',ownerScope:'owner',groupId:request.groupId,clientMessageId:request.clientMessageId,payloadMatches:true,payloadDigest:request.payloadDigest,message:{id:'canonical',groupId:request.groupId,seq:9,author:{kind:'user'}},discussionId:'discussion'}:{status:'not_found'}}});
 const first=await create(origin);windows.push(first);
 let result;if(phase===0){const prepared=await first.webContents.executeJavaScript('window.runNativePrepare()');const second=await create(origin);windows.push(second);
 const expression=text=>'window.runNativeCAS('+JSON.stringify(prepared.next)+','+JSON.stringify(text)+')';
 const race=await Promise.all([first.webContents.executeJavaScript(expression('B window one')),second.webContents.executeJavaScript(expression('B window two'))]);
 if(race.filter(row=>row.winner).length!==1||race.find(row=>!row.winner)?.code!=='GROUP_DRAFT_CONFLICT')throw Error('native multiwindow CAS did not isolate winner');
 result={origin,pid:process.pid,race:race.map(row=>({winner:row.winner,code:row.code})),sha256:hash(fs.readFileSync(store.file)),groupCalls:0};
 }else{const beforeHash=hash(fs.readFileSync(store.file)),recovered=await first.webContents.executeJavaScript('window.runNativeRecovery()');result={origin,pid:process.pid,beforeHash,recovered,groupCalls:0};}
 const foreign=await create(origin+'foreign');const denied=await foreign.webContents.executeJavaScript("window.openclawDesktop.groupSendJournal.call('read',{ownerScope:'owner',groupId:'g'})");foreign.destroy();if(denied.error?.code!=='GROUP_JOURNAL_CALLER_REQUIRED')throw Error('untrusted window read allowed');
 result.scopeReads=scopeReads;result.lookupReads=lookupReads;fs.writeFileSync(path.join(temp,'phase-'+phase+'.json'),JSON.stringify(result));console.log(JSON.stringify(result));ok=true;
 }catch(error){console.error(error.stack||error)}finally{ipc?.dispose();for(const w of windows)if(!w.isDestroyed())w.destroy();await store?.close();if(server)await new Promise(resolve=>server.close(resolve));app.exit(ok?0:1)}});`;
  fs.writeFileSync(path.join(temp,"main.cjs"),main.replace("ROOT",JSON.stringify(root)).replace("TEMP",JSON.stringify(temp)).replace("USERDATA",JSON.stringify(userData)));
  for(const phase of [0,1]){
    const child=spawn(require("electron"),[path.join(temp,"main.cjs"),`--phase=${phase}`],{env:{...process.env,ELECTRON_DISABLE_SECURITY_WARNINGS:"true"},stdio:["ignore","pipe","pipe"]});child.stdout.on("data",data=>process.stdout.write(data));child.stderr.on("data",data=>process.stderr.write(data));const timer=setTimeout(()=>child.kill("SIGTERM"),60000);
    const status=await new Promise((resolve,reject)=>{child.once("exit",resolve);child.once("error",reject)});clearTimeout(timer);assert.equal(status,0,"native group journal Electron acceptance failed");
  }
  const first=JSON.parse(fs.readFileSync(path.join(temp,"phase-0.json"))),second=JSON.parse(fs.readFileSync(path.join(temp,"phase-1.json")));
  assert.notEqual(first.pid,second.pid);assert.notEqual(first.origin,second.origin);assert.equal(first.sha256,second.beforeHash);
  assert.equal(second.recovered.originalId,"original");assert.equal(second.recovered.phase,"observed");assert.equal(first.groupCalls+second.groupCalls,0);
  console.log("PASS native group journal across 2 different HTTP origins / 2 natural Electron exits; production preload / trusted IPC / private Store; Provider 0");
}finally{fs.rmSync(temp,{recursive:true,force:true})}
