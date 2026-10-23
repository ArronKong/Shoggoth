#!/usr/bin/env node
// Real ChatPage, synthetic API/WS, isolated Electron profile. No production data or model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const sourceRoot = path.resolve(process.env.GROUP_LOADING_SOURCE_ROOT || root);
const require = createRequire(path.join(root, 'app/manage-ui/package.json'));
const { build } = require('esbuild');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shoggoth-group-loading-'));
const output = path.resolve(process.env.GROUP_LOADING_OUTPUT || path.join(root, '.artifacts/group-loading'));
const baseline = process.env.GROUP_LOADING_BASELINE === '1';
const fixture = String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {HashRouter} from 'react-router-dom';
import ChatPage from './app/manage-ui/src/pages/ChatPage';
import {UiProvider} from './app/manage-ui/src/components/ui';
import ScrollbarProvider from './app/manage-ui/src/components/ScrollbarProvider';
import i18n from './app/manage-ui/src/i18n';
import './app/manage-ui/src/styles.css';
import './app/manage-ui/src/manage-skin.css';
const state = window as any, options = new URLSearchParams(location.search), now = Date.now();
const language = options.get('language') || 'zh-CN', baseline = options.get('baseline') === '1';
const key = 'agent:fixture:main', sessions = [{key, agentId:'fixture',agentName:'Direct Fixture',backendId:'openclaw',updatedAt:now}];
let ownerScope = 'loading-fixture-owner', delay = 650, failing = false, writes = 0;
const counts = new Map<string,number>([['a',60],['b',60]]), calls:any[] = [];
const group = (id:string) => ({ownerScope,group:{id,name:'Loading Fixture '+id,purpose:'',status:'active',createdAt:now,
  updatedAt:now,metadataRevision:1,rosterRevision:1,directoryRevision:1,controlEpoch:0,lastSeq:counts.get(id)},
  members:[{id:'member-'+id,groupId:id,backendId:'shoggoth',agentId:'fixture-'+id,displayName:'Member '+id,
    handle:'member',state:'active',position:0,joinedSeq:0,leftSeq:null,card:null}],
  discussion:null,activeTurns:[],queuedMemberIds:[],internalSessionKeys:[],pendingInteractions:[],tasks:[]});
const pause = (ms=10) => new Promise(resolve=>setTimeout(resolve,ms));
state.fetch = async (url:unknown, init:RequestInit={}) => {
  if(init.method && init.method!=='GET'){writes++;throw Error('Unexpected write: '+url);}
  const p=new URL(String(url),'http://fixture'), id=p.searchParams.get('id')||'a';
  let payload:unknown = {};
  if(p.pathname==='/__api/group-chats') payload={groups:['a','b'].map(group),enabled:true};
  else if(p.pathname==='/__api/group-chats/detail') {
    calls.push({kind:'detail',id});await pause(delay);
    if(failing)return new Response(JSON.stringify({error:'Fixture offline'}),{status:503});
    payload=group(id);
  }else if(p.pathname==='/__api/group-chats/messages'){
    calls.push({kind:'messages',id,after:p.searchParams.get('afterSeq')});await pause(40);
    payload={messages:Array.from({length:counts.get(id)||0},(_,i)=>({id:id+'-'+(i+1),groupId:id,seq:i+1,threadId:'main',
      author:{kind:'user'},body:'History '+id+' '+(i+1),mentions:{memberIds:[],broadcast:false,unresolved:[]},createdAt:now+i}))
      .filter(m=>m.seq>Number(p.searchParams.get('afterSeq')||0)),hasMore:false};
  }else if(p.pathname==='/__api/status')payload={backends:[{id:'openclaw',connected:true}]};
  else if(p.pathname==='/__api/backends')payload={backends:[]};
  else if(p.pathname.includes('/archive'))payload={archive:{supported:true,segments:[]}};
  else if(p.pathname.includes('runtime-models'))payload={selection:{canSwitch:false,candidates:[]},capabilities:{},models:[],runtimes:[]};
  return new Response(JSON.stringify(payload),{headers:{'Content-Type':'application/json'}});
};
class FixtureSocket{
  static OPEN=1;readyState=1;onopen:any;onmessage:any;onclose:any;
  constructor(){state.socket=this;setTimeout(()=>this.onopen?.(),0);}
  emit(frame:unknown){this.onmessage?.({data:JSON.stringify(frame)});}
  send(data:string){const request=JSON.parse(data);
    const payload=request.method==='sessions.list'?{sessions,hasMore:false}:
      request.method==='agents.list'?{agents:[{id:'fixture',name:'Direct Fixture',backendId:'openclaw'}]}:
      request.method==='chat.history'?{messages:[{role:'user',content:'Existing direct history',timestamp:now}]}:{};
    setTimeout(()=>this.emit({type:'res',id:request.id,ok:true,payload}),0);}
  close(){this.readyState=3;}
}
state.WebSocket=FixtureSocket;
window.addEventListener('error',event=>{state.fixtureError=event.error?.stack||event.message;});
window.addEventListener('unhandledrejection',event=>{state.fixtureError=String(event.reason);});
localStorage.clear();localStorage.setItem('shoggoth.chat.sessions.v1',JSON.stringify(sessions));localStorage.setItem('shoggoth.chat.lastActive.v1',key);
await i18n.changeLanguage(language);document.documentElement.setAttribute('data-theme',language==='en'?'dark':'light');
createRoot(document.getElementById('root')!).render(<HashRouter><UiProvider><ScrollbarProvider/><ChatPage/></UiProvider></HashRouter>);
const wait=async(check:()=>unknown,label:string)=>{const end=performance.now()+8000;while(!check()){
  if(state.fixtureError)throw Error(state.fixtureError);if(performance.now()>end)throw Error(label);await pause();}};
const row=(id:string)=>document.querySelector<HTMLButtonElement>('.chat-aside__list button[title="Loading Fixture '+id+'"]')!;
const text=()=>document.body.innerText;
const visible=(value:string)=>text().includes(value);
const box=()=>document.querySelector<HTMLTextAreaElement>('[data-chat-composer] textarea');
const paint=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
const open=async(id:string)=>{const start=performance.now();row(id).click();await wait(()=>visible('History '+id+' 60'),'group history missing '+id);
  await paint();return Math.round(performance.now()-start);};
state.runFixture=async()=>{
  await wait(()=>row('a')&&row('b')&&visible('Existing direct history'),'initial page');
  const cold=await open('a');await wait(()=>box()&&!box()!.disabled,'journal ready');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(box(),'Keep my group draft');
  box()!.dispatchEvent(new Event('input',{bubbles:true}));await pause(60);
  await open('b');const warm:number[]=[];
  for(const id of ['a','b','a','b']){
    warm.push(await open(id));
    if(!baseline && warm.at(-1)!>=delay/2)throw Error('cached navigation waited for the detail request');
    if(id==='a'){await wait(()=>box()?.value==='Keep my group draft','draft lost on return');}
    await pause(delay+80);
  }
  const direct=Array.from(document.querySelectorAll<HTMLButtonElement>('.chat-aside__list button.chat-agent')).find(b=>b.textContent?.includes('Direct Fixture'))!;
  direct.click();await wait(()=>visible('Existing direct history')&&!visible('History b 60'),'return to direct');
  const fromDirect=await open('a');
  if(!baseline && fromDirect>=delay/2)throw Error('group return from direct waited for its API');
  await pause(delay+80);
  counts.set('a',61);state.socket.emit({type:'event',event:'group.changed',payload:{groupId:'a'}});
  window.dispatchEvent(new CustomEvent('shoggoth:group-changed',{detail:{groupId:'a'}}));
  await wait(()=>visible('History a 61'),'incremental message missing');
  if((text().match(/History a 61/g)||[]).length!==1)throw Error('incremental message duplicated');
  if(box()?.value!=='Keep my group draft')throw Error('background refresh replaced draft');
  if(!baseline){
    await open('b');failing=true;await open('a');await pause(delay+100);
    if(!visible('History a 61')||box()?.value!=='Keep my group draft')throw Error('failed refresh erased cached content');
    failing=false;window.dispatchEvent(new Event('focus'));await pause(delay+100);
    // Inactive late reads and rapid switches must not paint another group.
    row('b').click();await paint();row('a').click();await paint();await pause(delay+100);
    if(!visible('History a 61')||visible('History b 60'))throw Error('late read crossed groups');
    const warmCalls=calls.filter(c=>c.kind==='messages'&&c.after!==null);
    if(warmCalls.length<4)throw Error('warm refreshes are not incremental');
  }
  if(writes)throw Error('unexpected API write');
  return {language,baseline,detailDelayMs:delay,coldMs:cold,warmMs:warm,fromDirectMs:fromDirect,writes,
    draftPreserved:true,incrementalMessages:true,readCount:calls.length};
};
`;

try {
  await build({stdin:{contents:fixture,loader:'tsx',resolveDir:sourceRoot},bundle:true,format:'esm',jsx:'automatic',
    nodePaths:[path.join(root,'app/manage-ui/node_modules')],define:{'process.env.NODE_ENV':'"production"'},
    loader:{'.woff2':'dataurl','.svg':'dataurl','.webp':'dataurl'},outfile:path.join(temp,'fixture.js'),logLevel:'silent'});
  fs.writeFileSync(path.join(temp,'index.html'),'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;height:100%}#root{display:flex;flex-direction:column}</style><div id="root"></div><script type="module" src="fixture.js"></script>');
  fs.mkdirSync(output,{recursive:true});
  const main=path.join(temp,'main.cjs');
  fs.writeFileSync(main,`const {app,BrowserWindow}=require('electron'),fs=require('node:fs');
app.setPath('userData',${JSON.stringify(path.join(temp,'profile'))});
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1200,height:800,webPreferences:{backgroundThrottling:false}});let passed=false;
try{const results=[];for(const language of ['zh-CN','en']){for(const width of [1200,600]){w.setContentSize(width,800);
await w.loadFile(${JSON.stringify(path.join(temp,'index.html'))},{query:{language,baseline:${JSON.stringify(baseline?'1':'0')}}});
results.push({...await w.webContents.executeJavaScript('window.runFixture()'),width});
fs.writeFileSync(${JSON.stringify(output)}+'/'+language+'-'+width+'.png',(await w.webContents.capturePage()).toPNG());}}
fs.writeFileSync(${JSON.stringify(output)}+'/results.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));passed=true;
}catch(e){console.error(e.stack||e);console.error(await w.webContents.executeJavaScript('document.body.innerText.slice(-2000)'));}
finally{w.destroy();app.exit(passed?0:1);}});`);
  const child=spawn(require('electron'),[main],{env:{...process.env,ELECTRON_DISABLE_SECURITY_WARNINGS:'true'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',x=>process.stdout.write(x));child.stderr.on('data',x=>process.stderr.write(x));
  const timer=setTimeout(()=>child.kill('SIGTERM'),90000);
  let status;try{status=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});}finally{clearTimeout(timer);}
  assert.equal(status,0,'group loading renderer regression failed');
} finally { fs.rmSync(temp,{recursive:true,force:true}); }
