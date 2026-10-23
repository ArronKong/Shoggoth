// Production Panel and full-message reader with real IndexedDB. API data is synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '..'), require = createRequire(path.join(root, 'app/manage-ui/package.json'));
const { build } = require('esbuild'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'group-owner-scope-ui-'));
const output = path.resolve(process.env.GROUP_OWNER_SCOPE_OUTPUT || path.join(root, '.artifacts/group-owner-final-20261015/rendered'));
const fixture = String.raw`
import React from 'react';import{createRoot}from'react-dom/client';
import Panel from './app/manage-ui/src/pages/GroupChatPanel';import{UiProvider}from'./app/manage-ui/src/components/ui';
import{emitGroupChanged}from'./app/manage-ui/src/lib/groupChat';import{groupSendJournal}from'./app/manage-ui/src/lib/groupSendJournal';
import i18n from './app/manage-ui/src/i18n';import './app/manage-ui/src/styles.css';import './app/manage-ui/src/manage-skin.css';import './app/manage-ui/src/pages/ChatPage.css';
const w=window as any,options=new URLSearchParams(location.search),language=options.get('language')!,theme=options.get('theme')!;
const pause=(ms=20)=>new Promise(r=>setTimeout(r,ms)),wait=async(check:()=>unknown,label:string)=>{let until=Date.now()+7000;while(!check()){if(w.error)throw Error(w.error);if(Date.now()>until)throw Error(label+': '+document.body.innerText);await pause()}};
window.addEventListener('error',e=>w.error=e.error?.stack||e.message);window.addEventListener('unhandledrejection',e=>w.error=String(e.reason));
const hash=async(text:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),x=>x.toString(16).padStart(2,'0')).join('');
const sourceText:any={A:'A_OLD_SOURCE_PRIVATE / 原归属固定结果',B:'B_CURRENT_SOURCE / 当前归属固定结果'};
const sourceDigest:any={};for(const o of['A','B'])sourceDigest[o]=await hash(sourceText[o]);
let owner='A',writes=0;const reads:any[]=[];let oldSource:any;
const page=(text:string,digest:string)=>({offset:0,nextOffset:null,text,totalBytes:new TextEncoder().encode(text).length,digest});
const view=()=>({ownerScope:'owner-'+owner,group:{id:'g',name:'Owner '+owner,purpose:'',status:'active',createdAt:1,updatedAt:1,metadataRevision:1,rosterRevision:1,directoryRevision:1,controlEpoch:0,lastSeq:2,ownerMemberId:'a'},
 currentOwnerId:'a',members:[{id:'a',groupId:'g',backendId:'shoggoth',agentId:'a',displayName:'Alpha',handle:'a',state:'active',position:0,joinedSeq:0,leftSeq:null}],round:null,activeTurns:[],queuedMemberIds:[],internalSessionKeys:[],pendingInteractions:[]});
const reply=(o:string)=>({id:'result-'+o,groupId:'g',seq:2,threadId:'main',author:{kind:'member',memberId:'a'},body:'Excerpt / 节选',mentions:{memberIds:[],broadcast:false,unresolved:[]},createdAt:2,
 fullResult:{bytes:new TextEncoder().encode(sourceText[o]).length,digest:sourceDigest[o]},origin:{opportunityId:'turn-'+o,runId:'run-'+o,discussionId:'round-'+o}});
w.fetch=async(url:any,init:any={})=>{const p=new URL(String(url),'http://fixture'),o=owner;reads.push({owner:o,path:p.pathname,attempt:p.searchParams.get('attemptId'),digest:p.searchParams.get('digest')});
 if(init.method&&init.method!=='GET'){writes++;throw Error('unexpected mutation')}
 const response=(value:any)=>new Response(JSON.stringify(value));
 if(p.pathname==='/__api/group-chats/detail')return response(view());
 if(p.pathname==='/__api/group-chats/messages')return response({messages:p.searchParams.get('afterSeq')?[]:[reply(o)],hasMore:false});
 if(p.pathname==='/__api/group-chats/messages/read'){if(p.searchParams.get('digest')!==sourceDigest[o])throw Error('source digest drift');const value={page:page(sourceText[o],sourceDigest[o])};return o==='A'?new Promise(resolve=>{oldSource=()=>resolve(response(value))}):response(value)}
 if(p.pathname==='/__api/status')return response({backends:[]});throw Error('unexpected read '+p.pathname)};
await i18n.changeLanguage(language);document.documentElement.setAttribute('data-theme',theme);const r=createRoot(document.getElementById('root')!);r.render(<UiProvider><Panel groupId="g" onArchived={()=>{}}/></UiProvider>);
const buttons=(node:ParentNode=document)=>Array.from(node.querySelectorAll('button'))as HTMLButtonElement[];
const named=(key:string,node:ParentNode=document)=>buttons(node).find(b=>b.textContent===i18n.t(key))!;
const dialogs=()=>document.querySelectorAll('[role=dialog]');
const fixed=()=>named('groupChat.fullResult.open');
const noOld=()=>{if(/A_OLD_SOURCE_PRIVATE/.test(document.body.innerText))throw Error('old owner content leaked');if(document.documentElement.scrollWidth>innerWidth+1)throw Error('horizontal overflow')};
const switchOwner=async(o:string)=>{owner=o;emitGroupChanged('g');await wait(()=>document.querySelector('[data-group-details-trigger]')?.textContent?.startsWith('Owner '+o),'owner '+o+' observed');await pause(50)};
const close=async()=>{const list=Array.from(dialogs()),dialog=list.at(-1)!;const button=dialog.querySelector('button[aria-label="'+i18n.t('common.close')+'"]')as HTMLButtonElement;if(!button)throw Error('modal close missing');button.click();await wait(()=>dialogs().length<list.length,'closed')};
w.sourceCase=async()=>{await wait(()=>document.querySelector('textarea:not(:disabled)')&&fixed(),'panel ready');fixed().click();await wait(()=>oldSource&&dialogs().length===1,'old source pending');
 await switchOwner('B');await wait(()=>dialogs().length===0,'old source closed');oldSource();await pause(80);noOld();if(dialogs().length)throw Error('late old source reopened');
 await wait(()=>fixed(),'current reply listed');fixed().click();await wait(()=>document.body.innerText.includes(sourceText.B)&&document.body.innerText.includes(i18n.t('groupChat.fullResult.verified')),'current fixed source verified');noOld();
 if(writes!==0)throw Error('read-only UI wrote');return{language,theme,oldSourceDiscarded:true,currentSourceVerified:true,reads:reads.length,writes,providerCalls:0,passed:true}};
w.finish=async()=>{r.unmount();await groupSendJournal.close();return{passed:true}};
`;
try {
  await build({stdin:{contents:fixture,loader:'tsx',resolveDir:root},bundle:true,format:'esm',jsx:'automatic',nodePaths:[path.join(root,'app/manage-ui/node_modules')],
    loader:{'.woff2':'dataurl','.svg':'dataurl','.webp':'dataurl','.png':'dataurl'},define:{'process.env.NODE_ENV':'"production"'},outfile:path.join(temp,'fixture.js'),logLevel:'silent'});
  fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(temp,'index.html'),'<link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;height:100%;min-height:0}#root{display:flex;flex-direction:column}</style><div id="root" class="chat-shell"></div><script type="module" src="fixture.js"></script>');
  fs.writeFileSync(path.join(temp,'main.cjs'),`const{app,BrowserWindow}=require('electron'),fs=require('node:fs');app.setPath('userData',${JSON.stringify(path.join(temp,'profile'))});app.on('window-all-closed',()=>{});app.whenReady().then(async()=>{let win;try{const results=[];for(const width of[1200,390])for(const language of['zh-CN','en'])for(const theme of['light','dark']){win=new BrowserWindow({width,height:850,show:false,webPreferences:{backgroundThrottling:false,partition:width+'-'+language+'-'+theme}});win.webContents.on('console-message',(_e,_l,message)=>console.log('renderer: '+message));await win.loadURL('about:blank');win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:width===390?'reduce':'no-preference'}]});await win.loadFile(${JSON.stringify(path.join(temp,'index.html'))},{query:{language,theme}});await win.webContents.executeJavaScript('new Promise((resolve,reject)=>{const until=Date.now()+7000;const check=()=>window.error?reject(Error(window.error)):window.sourceCase?resolve():Date.now()>until?reject(Error("fixture did not start")):setTimeout(check,20);check()})');const result=await win.webContents.executeJavaScript('window.sourceCase()');result.width=width;fs.writeFileSync(${JSON.stringify(output)}+'/source-'+width+'-'+language+'-'+theme+'.png',(await win.webContents.capturePage()).toPNG());await win.webContents.executeJavaScript('window.finish()');results.push(result);win.destroy();win=null;}fs.writeFileSync(${JSON.stringify(output)}+'/results.json',JSON.stringify(results,null,2));console.log('PASS owner scope production Panel/full message: '+results.length+'/8');app.exit(0)}catch(error){console.error(error.stack||error);if(win&&!win.isDestroyed()){try{fs.writeFileSync(${JSON.stringify(output)}+'/failed.png',(await win.webContents.capturePage()).toPNG())}catch{}win.destroy()}app.exit(1)}});`);
  const child=spawn(require('electron'),[path.join(temp,'main.cjs')],{env:{...process.env,ELECTRON_DISABLE_SECURITY_WARNINGS:'true'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',data=>process.stdout.write(data));child.stderr.on('data',data=>process.stderr.write(data));const timer=setTimeout(()=>child.kill('SIGTERM'),90000);
  const processReceipt = { pid: child.pid, exit: null, close: null, signal: null };
  child.once('exit',(code,signal)=>{processReceipt.exit=code;processReceipt.signal=signal});
  await new Promise((resolve,reject)=>{child.once('close',(code,signal)=>{processReceipt.close=code;processReceipt.signal=signal;resolve()});child.once('error',reject)});
  clearTimeout(timer);assert.equal(processReceipt.exit,0);assert.equal(processReceipt.close,0);assert.equal(processReceipt.signal,null);
  assert.throws(()=>process.kill(child.pid,0),{code:'ESRCH'});processReceipt.pidGone=true;
  fs.writeFileSync(path.join(output,'process.json'),JSON.stringify(processReceipt,null,2));
  const results=JSON.parse(fs.readFileSync(path.join(output,'results.json'),'utf8'));assert.equal(results.length,8);assert.ok(results.every(row=>row.passed&&row.oldSourceDiscarded&&row.currentSourceVerified&&row.writes===0));
} finally {fs.rmSync(temp,{recursive:true,force:true});}
