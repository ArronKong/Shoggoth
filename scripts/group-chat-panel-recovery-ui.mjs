#!/usr/bin/env node
// Real renderer, production components, disposable Electron profile and local synthetic API only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'app/manage-ui/package.json'));
const { build } = require('esbuild');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shoggoth-panel-recovery-ui-'));
const output = path.resolve(process.env.GROUP_PANEL_UI_OUTPUT || path.join(root, '.artifacts/group-panel-recovery-ui'));
const fixture = String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {HashRouter} from 'react-router-dom';
import GroupChatPanel from './app/manage-ui/src/pages/GroupChatPanel';
import {groupChatActivity,groupChatPreview} from './app/manage-ui/src/lib/groupChat';
import {UiProvider} from './app/manage-ui/src/components/ui';
import ScrollbarProvider from './app/manage-ui/src/components/ScrollbarProvider';
import i18n from './app/manage-ui/src/i18n';
import './app/manage-ui/src/styles.css';
import './app/manage-ui/src/manage-skin.css';
import './app/manage-ui/src/pages/ChatPage.css';
const state = window as any, language = new URLSearchParams(location.search).get('language') || 'zh-CN';
let ready = false, seq = 1, reads = 0, writes = 0, stopMode = false, completeStop: (()=>void)|null = null;
let deletionMode=false, gone=false, removed=0;
const group:any = {ownerScope:'recovery-fixture-owner',group:{id:'owned',name:'Recovery Fixture',purpose:'',status:'active',createdAt:1,updatedAt:1,
  metadataRevision:1,rosterRevision:1,directoryRevision:1,controlEpoch:0,lastSeq:0},members:[],discussion:null,
  activeTurns:[],queuedMemberIds:[],internalSessionKeys:[],pendingInteractions:[],tasks:[]};
state.fetch = async (url:unknown, init:RequestInit={}) => {
  const p = new URL(String(url), 'http://fixture');
  if(init.method && init.method !== 'GET') {
    writes++;
    if(deletionMode && init.method==='DELETE' && p.pathname.endsWith('/detail') && p.searchParams.get('id')==='owned') {
      if(JSON.parse(String(init.body)).expectedMetadataRevision!==1)throw Error('wrong delete revision');
      group.group.status='deleting';
      return new Response(JSON.stringify({groupId:'owned',status:'deleting'}),{headers:{'content-type':'application/json'}});
    }
    if(!stopMode || init.method !== 'POST' || !p.pathname.endsWith('/discussion/stop') || p.searchParams.get('id') !== 'owned')
      throw Error('Unexpected write');
    return new Promise<Response>(resolve=>{completeStop=()=>resolve(new Response(JSON.stringify(group),{headers:{'content-type':'application/json'}}));});
  }
  reads++;
  if(gone) return new Response(JSON.stringify({code:'GROUP_CHAT_DELETED',error:'Group deleted'}),{status:410});
  if (!ready) return new Response(JSON.stringify({error:'Fixture temporarily unavailable'}),{status:503});
  let data:any = p.pathname.endsWith('/detail') ? group : {};
  if(p.pathname.endsWith('/members/role-history')) data={snapshots:[],hasMore:false,nextCursor:null};
  if(p.pathname.endsWith('/members/role')) {
    const text='Fixture member role',bytes=new TextEncoder().encode(text);
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
    data={ok:true,text,offset:0,totalBytes:bytes.length,exportDigest:digest,revisionId:'fixture-role',disclosure:'verbatim',disclosurePolicyRevision:1,nextCursor:null};
  }
  if(p.pathname.endsWith('/messages')) data={messages:Array.from({length:seq},(_,i)=>({id:'message-'+(i+1),groupId:'owned',seq:i+1,
    threadId:'main',author:{kind:'user'},body:'Recovered message '+(i+1),mentions:{memberIds:[],broadcast:false,unresolved:[]},createdAt:1}))
    .filter(m=>m.seq>Number(p.searchParams.get('afterSeq')||0)),hasMore:false};
  return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
};
window.addEventListener('error', event=>{state.fixtureError=event.error?.stack||event.message;});
await i18n.changeLanguage(language);
document.documentElement.setAttribute('data-theme', language === 'en' ? 'dark' : 'light');
createRoot(document.getElementById('root')!).render(<HashRouter><UiProvider><ScrollbarProvider /><div className="chat-shell" style={{display:"flex",flex:1,minHeight:0}}>
  <GroupChatPanel groupId="owned" agents={[]} onArchived={()=>{if(!deletionMode)throw Error('Unexpected removal');removed++;}}/>
</div></UiProvider></HashRouter>);
const wait = async(fn:()=>boolean,label:string)=>{const end=Date.now()+6000;while(!fn()){if(state.fixtureError)throw Error(state.fixtureError);
  if(Date.now()>end)throw Error(label);await new Promise(r=>setTimeout(r,20));}};
state.runFixture = async()=>{
  await wait(()=>document.body.innerText.includes('Fixture temporarily unavailable'),'initial failure missing');
  ready=true; // Retry must recover without any write or forced group event.
  await wait(()=>document.body.innerText.includes('Recovered message 1'),'first read never recovered');
  await wait(()=>Boolean(document.querySelector('textarea')&&!document.querySelector<HTMLTextAreaElement>('textarea')!.disabled),'owned journal never became ready');
  const box=document.querySelector('textarea')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(box,'Keep this draft');
  box.dispatchEvent(new Event('input',{bubbles:true}));
  await new Promise(r=>setTimeout(r,20));
  ready=false; const before=reads; window.dispatchEvent(new Event('focus'));
  await wait(()=>reads>before,'refresh was not attempted'); await new Promise(r=>setTimeout(r,80));
  if(!document.body.innerText.includes('Recovered message 1')||box.value!=='Keep this draft')throw Error('failed refresh erased content');
  ready=true;seq=2;window.dispatchEvent(new Event('focus'));
  await wait(()=>document.body.innerText.includes('Recovered message 2'),'incremental recovery missing');
  if(document.querySelector('textarea')?.value!=='Keep this draft'||writes)throw Error('draft or read-only boundary failed');
  return {language,reads,writes,recovered:true,draftPreserved:true,messages:seq};
};
const stopButton=()=>document.querySelector<HTMLButtonElement>('button.chat-stop');
state.queueFixture=async(phase:string)=>{
  group.members=[{id:'member',groupId:'owned',backendId:'hermes',agentId:'helper',displayName:'Hermes Helper',handle:'helper',
    state:'active',position:0,joinedSeq:0,leftSeq:null,card:null}];
  group.discussion={id:'owned-discussion',status:'running',publicReplyCount:0,opportunityCount:1,deferredMemberIds:[]};
  group.activeTurns=[{opportunityId:'owned-turn',memberId:'member',startedAt:1,inputThroughSeq:2,
    activity:{groupId:'owned',memberId:'member',opportunityId:'owned-turn',taskId:null,attemptId:null,
      runId:'original-run',executionGeneration:'host-generation',phase,eventSeq:0,recentTools:[],tool:null,lastProgressAt:1}}];
  window.dispatchEvent(new Event('focus'));
  await wait(()=>Boolean(document.querySelector('[data-group-activity="owned-turn"][data-activity-phase="'+phase+'"]')),
    'bound execution phase missing: '+phase);
  if(!document.body.innerText.includes(i18n.t('groupChat.activity.phase.'+phase))||writes)
    throw Error('queue phase or read-only boundary failed');
  if(document.querySelector('textarea')?.value!=='Keep this draft')throw Error('queue transition erased draft');
  if(groupChatActivity(group)!==(phase==='queued'?'queued':'running'))throw Error('sidebar mislabels execution phase');
  if(phase==='queued'&&groupChatPreview(group,i18n.t.bind(i18n))!==i18n.t('groupChat.sidebar.queued'))throw Error('queue preview missing');
  return {[phase+'Verified']:true};
};
state.startStopFixture=async()=>{
  stopMode=true;
  group.members=[{id:'member',groupId:'owned',backendId:'hermes',agentId:'helper',displayName:'Hermes Helper',handle:'helper',
    state:'active',position:0,joinedSeq:0,leftSeq:null,card:null}];
  group.discussion={id:'owned-discussion',status:'running',publicReplyCount:0,opportunityCount:1,deferredMemberIds:[]};
  group.activeTurns=[{opportunityId:'owned-turn',memberId:'member',startedAt:Date.now(),inputThroughSeq:2}];
  window.dispatchEvent(new Event('focus'));
  await wait(()=>Boolean(stopButton()&&!stopButton()!.disabled),'stop button did not become available');
  stopButton()!.click();
  await wait(()=>writes===1&&Boolean(stopButton()?.disabled)&&document.body.innerText.includes(i18n.t('groupChat.stopState.requesting')),
    'stop did not show immediate pending feedback');
  stopButton()!.click();
  if(writes!==1)throw Error('repeat click posted another stop');
  return {requesting:true,stopWrites:writes};
};
state.confirmStopFixture=async()=>{
  group.discussion.status='cancelled';
  group.activeTurns=[{...group.activeTurns[0],stopping:true,recovery:{type:'execution',reason:'GROUP_EXECUTION_STOP_UNCONFIRMED',since:1,cancelRequested:true}}];
  if(!completeStop)throw Error('stop request missing');
  completeStop();
  await wait(()=>document.body.innerText.includes(i18n.t('groupChat.stopState.confirming'))&&Boolean(stopButton()?.disabled),
    'persisted cancellation did not show confirmation pending');
  if(document.querySelector('textarea')?.value!=='Keep this draft')throw Error('stop erased draft');
  return {confirmationPending:true,draftPreserved:true};
};
state.finishStopFixture=async()=>{
  group.activeTurns=[];window.dispatchEvent(new Event('focus'));
  await wait(()=>!stopButton(),'stop remained after terminal view');
  if(writes!==1||document.querySelector('textarea')?.value!=='Keep this draft')throw Error('stop boundary failed');
  return {terminalConfirmed:true,stopWrites:writes};
};
state.deleteFixture=async()=>{
  deletionMode=true;
  const details=document.querySelector<HTMLButtonElement>('[data-group-details-trigger]');
  if(!details)throw Error('group details entry missing');details.click();
  await wait(()=>Boolean(document.querySelector('[data-group-details-action="menu"]')),'group details missing');
  const openDelete=async()=>{
    document.querySelector<HTMLButtonElement>('[data-group-details-action="menu"]')!.click();
    await wait(()=>Boolean(document.querySelector('[data-group-details-action="delete"]')),'delete entry missing');
    return document.querySelector<HTMLElement>('[data-group-details-action="delete"]')!;
  };
  const disabled=(element:HTMLElement)=>element.getAttribute('aria-disabled')==='true'||element.hasAttribute('data-disabled');
  const button=await openDelete();
  if(disabled(button))throw Error('delete entry disabled before deletion');button.click();
  await wait(()=>Boolean(document.querySelector('[role="alertdialog"] .btn-danger')),'delete confirmation missing');
  (document.querySelector('[role="alertdialog"] .btn-danger') as HTMLButtonElement).click();
  await wait(()=>writes===2&&group.group.status==='deleting','deletion request missing');
  await wait(()=>!document.querySelector('[role="alertdialog"]'),'delete confirmation did not finish closing');
  document.querySelector<HTMLButtonElement>('[data-group-details-action="close"]')!.click();
  await wait(()=>!document.querySelector('[data-group-details]')&&document.body.innerText.includes(i18n.t('groupChat.deletingNotice')),
    'pending deletion feedback missing');
  document.querySelector<HTMLButtonElement>('[data-group-details-trigger]')!.click();
  await wait(()=>Boolean(document.querySelector('[data-group-details-action="menu"]')),'pending group details missing');
  const pendingDelete=await openDelete();
  if(!disabled(pendingDelete)||!document.querySelector<HTMLTextAreaElement>('textarea')?.disabled)throw Error('deleted group still accepts actions');
  if(groupChatActivity(group)!=='deleting')throw Error('sidebar hides pending deletion');
  pendingDelete.click();if(writes!==2)throw Error('duplicate delete request');
  document.querySelector<HTMLButtonElement>('[data-group-details-action="menu"]')!.click();
  document.querySelector<HTMLButtonElement>('[data-group-details-action="close"]')!.click();
  await wait(()=>!document.querySelector('[data-group-details]'),'details did not close');
  return {deletePending:true,deleteWrites:1};
};
state.finishDeleteFixture=async()=>{
  gone=true;window.dispatchEvent(new Event('focus'));
  await wait(()=>removed===1,'confirmed deletion did not close the group');
  if(writes!==2)throw Error('deletion made an unexpected write');
  return {deleteConfirmed:true,totalWrites:writes};
};
`;
try {
  await build({stdin:{contents:fixture,loader:'tsx',resolveDir:root},bundle:true,format:'esm',jsx:'automatic',
    nodePaths:[path.join(root,'app/manage-ui/node_modules')],define:{'process.env.NODE_ENV':'"production"'},
    loader:{'.woff2':'dataurl','.svg':'dataurl','.webp':'dataurl','.png':'dataurl'},outfile:path.join(temp,'fixture.js'),logLevel:'silent'});
  fs.writeFileSync(path.join(temp,'index.html'), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;height:100%}#root{display:flex;flex-direction:column}</style><div id="root"></div><script type="module" src="fixture.js"></script>');
  fs.mkdirSync(output,{recursive:true});
  const main=path.join(temp,'main.cjs');
  fs.writeFileSync(main, `const {app,BrowserWindow}=require('electron'),fs=require('node:fs');
app.setPath('userData',${JSON.stringify(path.join(temp,'profile'))});
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1200,height:800,webPreferences:{backgroundThrottling:false}});let passed=false;
try{const results=[];for(const language of ['zh-CN','en']){await w.loadFile(${JSON.stringify(path.join(temp,'index.html'))},{query:{language}});
const result=await w.webContents.executeJavaScript('window.runFixture()');
for(const phase of ['queued','running']){
Object.assign(result,await w.webContents.executeJavaScript('window.queueFixture('+JSON.stringify(phase)+')'));
for(const width of [1200,390]){w.setContentSize(width,800);await w.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
await w.webContents.executeJavaScript("document.querySelector('[data-group-activity=owned-turn]').scrollIntoView({block:'center'})");
await w.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
if(!await w.webContents.executeJavaScript("(()=>{const r=document.querySelector('[data-group-activity=owned-turn]').getBoundingClientRect();return r.top>=0&&r.bottom<=document.querySelector('textarea').getBoundingClientRect().top})()"))throw Error('execution phase is outside the visible chat area');
fs.writeFileSync(${JSON.stringify(output)}+'/'+language+'-'+width+'-'+phase+'.png',(await w.webContents.capturePage()).toPNG());}}
for(const phase of ['requesting','confirming']){
Object.assign(result,await w.webContents.executeJavaScript(phase==='requesting'?'window.startStopFixture()':'window.confirmStopFixture()'));
for(const width of [1200,390]){w.setContentSize(width,800);await w.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
fs.writeFileSync(${JSON.stringify(output)}+'/'+language+'-'+width+'-'+phase+'.png',(await w.webContents.capturePage()).toPNG());}}
Object.assign(result,await w.webContents.executeJavaScript('window.finishStopFixture()'));
Object.assign(result,await w.webContents.executeJavaScript('window.deleteFixture()'));
for(const width of [1200,390]){w.setContentSize(width,800);await w.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
fs.writeFileSync(${JSON.stringify(output)}+'/'+language+'-'+width+'-deleting.png',(await w.webContents.capturePage()).toPNG());}
Object.assign(result,await w.webContents.executeJavaScript('window.finishDeleteFixture()'));results.push(result);}
fs.writeFileSync(${JSON.stringify(output)}+'/results.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));passed=true;
}catch(e){console.error(e.stack||e);console.error(await w.webContents.executeJavaScript('document.body.innerText.slice(0,2000)'));}
finally{w.destroy();app.exit(passed?0:1);}});`);
  const child=spawn(require('electron'),[main],{env:{...process.env,ELECTRON_DISABLE_SECURITY_WARNINGS:'true'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',x=>process.stdout.write(x));child.stderr.on('data',x=>process.stderr.write(x));
  const timer=setTimeout(()=>child.kill('SIGTERM'),30000);
  let status;try{status=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});}finally{clearTimeout(timer);}
  assert.equal(status,0,'group panel renderer regression failed');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
