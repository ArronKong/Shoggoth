#!/usr/bin/env node
// The actual React group panel with real IndexedDB, controlled API receipts, isolated Electron profile.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, ".."), require = createRequire(path.join(root, "app/manage-ui/package.json"));
const { build } = require("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-group-send-ui-"));
const baseline = process.env.GROUP_SEND_BASELINE === "1";
const output = process.env.GROUP_SEND_UI_OUTPUT ? path.resolve(process.env.GROUP_SEND_UI_OUTPUT) : null;
const fixture = String.raw`
import React from "react";import{createRoot}from"react-dom/client";
import GroupChatPanel from "./app/manage-ui/src/pages/GroupChatPanel";
import { UiProvider } from "./app/manage-ui/src/components/ui";
import { emitGroupChanged } from "./app/manage-ui/src/lib/groupChat";
import { GROUP_CONNECTION_EVENT, groupSendJournal } from "./app/manage-ui/src/lib/groupSendJournal";
import i18n from "./app/manage-ui/src/i18n";
import "./app/manage-ui/src/styles.css";import "./app/manage-ui/src/manage-skin.css";import "./app/manage-ui/src/pages/ChatPage.css";
const state=window as any, options=new URLSearchParams(location.search),language=options.get('language')||'zh-CN',theme=options.get('theme')||'light',pause=(ms=20)=>new Promise(resolve=>setTimeout(resolve,ms));
window.addEventListener('error',event=>state.fixtureError=event.error?.stack||event.message);
window.addEventListener('unhandledrejection',event=>state.fixtureError=String(event.reason));
const wait=async(check:()=>unknown,label:string)=>{const until=Date.now()+7000;while(!check()){if(state.fixtureError)throw Error(state.fixtureError);if(Date.now()>until)throw Error(label);await pause()}};
const equal=(a:any,b:any,label:string)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw Error(label+': '+JSON.stringify(a)+' != '+JSON.stringify(b))};
const base=(id:string)=>({ownerScope:'stable-owner',group:{id,name:'Group '+id,purpose:'',status:'active',createdAt:1,updatedAt:1,metadataRevision:1,rosterRevision:1,directoryRevision:1,controlEpoch:0,lastSeq:0,mode:'independent',policyVersion:1,protocolVersion:1},members:[{id:'a',groupId:id,backendId:'shoggoth',agentId:'a',displayName:'Alpha',handle:'a',state:'active',position:0,joinedSeq:0,leftSeq:null}],discussion:null,activeTurns:[],queuedMemberIds:[],internalSessionKeys:[],pendingInteractions:[],tasks:[]});
const seed={id:'seed',groupId:'g',seq:1,threadId:'main',author:{kind:'user'},body:'quoted source',mentions:{memberIds:[],broadcast:false,unresolved:[]},createdAt:1,origin:{discussionId:'old-request'}};
const views:any={g:base('g'),h:base('h')}, messages:any={g:[seed],h:[]}, sends:any[]=[],pending:any[]=[],reads:any[]=[],lookups:any[]=[],writes:any[]=[];
views.g.group.lastSeq=1;
let failNextRead=false, nextMessage=1, delayDetail:any=null, delayUpload=false, resolveUpload:any=null;
const result=(groupId:string,input:any)=>{const message={id:'m'+(++nextMessage),groupId,seq:nextMessage,threadId:'main',author:{kind:'user'},body:input.body,mentions:{memberIds:[],broadcast:false,unresolved:[]},createdAt:1,attachments:input.attachments,origin:{discussionId:'d'+nextMessage}};if(input.ownerScope===views[groupId].ownerScope){messages[groupId].push(message);views[groupId].group.lastSeq=message.seq}return{message,discussionId:'d'+nextMessage,duplicate:false}};
state.fetch=async(url:any,init:any={})=>{
 const parsed=new URL(String(url),'http://fixture'), groupId=parsed.searchParams.get('id')||'g', body=init.body?JSON.parse(init.body):null;
 if(parsed.pathname.includes('/messages/lookup')){lookups.push({groupId,id:parsed.searchParams.get('clientMessageId')});const id=parsed.searchParams.get('clientMessageId'), row=sends.find(row=>row.groupId===groupId&&row.input.clientMessageId===id&&row.result&&row.input.ownerScope===views[groupId].ownerScope);return new Response(JSON.stringify({status:row?'found':'not_found',ownerScope:views[groupId].ownerScope,groupId,clientMessageId:id,payloadMatches:row?true:null,payloadDigest:parsed.searchParams.get('payloadDigest'),message:row?.result.message??null,discussionId:row?.result.discussionId??null}))}
 if(init.method&&init.method!=='GET'){
  if(parsed.pathname==='/__api/inspirations/media'){const length=atob(body.content).length,response=new Response(JSON.stringify({attachment:body.attachment,nextOffset:body.offset+length}));if(delayUpload){delayUpload=false;return new Promise(resolve=>resolveUpload=()=>resolve(response))}return response}
  writes.push({url:String(url),body});
  if(parsed.pathname==='/__api/group-chats/messages'){const row={groupId,input:body};sends.push(row);return new Promise(resolve=>pending.push({row,success:()=>{row.result=result(groupId,body);resolve(new Response(JSON.stringify(row.result)))},lost:()=>{row.result=result(groupId,body);resolve(new Response(JSON.stringify({code:'fixture_offline',error:'offline'}),{status:503}))},error:()=>resolve(new Response(JSON.stringify({code:'fixture_offline',error:'offline'}),{status:503}))}))}
  throw Error('unexpected mutation '+url);
 }
 reads.push({url:String(url),groupId});
 if(failNextRead&&parsed.pathname.includes('/detail')){failNextRead=false;return new Response('{}',{status:503})}
 if(parsed.pathname.includes('/detail')){if(delayDetail){const deferred=delayDetail;delayDetail=null;return new Promise(resolve=>deferred(resolve))}return new Response(JSON.stringify(views[groupId]))}
 if(parsed.pathname.includes('/messages')){const after=Number(parsed.searchParams.get('afterSeq')||0);return new Response(JSON.stringify({messages:messages[groupId].filter((m:any)=>m.seq>after),hasMore:false}))}
 if(parsed.pathname.includes('/status'))return new Response(JSON.stringify({backends:[]}));
 return new Response('{}');
};
await i18n.changeLanguage(language);document.documentElement.setAttribute('data-theme',theme);const root=createRoot(document.getElementById('root')!);
const mount=(id:string)=>root.render(<UiProvider><GroupChatPanel key={id} groupId={id} onArchived={()=>{}}/></UiProvider>);
const textarea=()=>document.querySelector('textarea')as HTMLTextAreaElement;
const type=async(text:string)=>{const el=textarea();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(el,text);el.dispatchEvent(new Event('input',{bubbles:true}));await pause()};
const send=()=>{const button=document.querySelector('.chat-send') as HTMLButtonElement;if(button.disabled)throw Error('send disabled');button.click()};
const queueFile=(name:string)=>{const input=document.querySelector('input[type=file]')as HTMLInputElement;Object.defineProperty(input,'files',{configurable:true,value:[new File(['data'],name,{type:'text/plain'})]});input.dispatchEvent(new Event('change',{bubbles:true}))};
const addFile=async(name:string)=>{queueFile(name);await wait(()=>document.querySelector('[data-status=ready]'),'attachment ready')};
const named=(key:string)=>Array.from(document.querySelectorAll('button')).find(el=>el.textContent===i18n.t(key))as HTMLButtonElement;
mount('g');
state.runPanelFixture=async()=>{
 const checks:string[]=[];await wait(()=>textarea()&&!textarea().disabled,'panel ready');
 await type('send A');send();await wait(()=>sends.length===1,'A dispatched');
 await type('draft B');await addFile('B.txt');named('groupChat.reply.action').click();await pause();
 pending.shift().success();await wait(()=>Array.from(document.querySelectorAll('.chat-group.is-user')).some(el=>el.textContent?.includes('send A')),'A ACK');await pause(100);
 equal(textarea().value,'draft B','A ACK must preserve B');equal(document.querySelector('[data-status=ready]')?.textContent?.includes('B.txt'),true,'A ACK must preserve B attachment');equal(document.querySelector('.chat-quote-bar__text')?.textContent?.includes('quoted source'),true,'A ACK must preserve B quote');checks.push('late ACK preserves B attachments and quote');
 if(state.baseline)return{checks};
 // A failed request can only be retried by the explicit retry control with the same frozen operation.
 send();await wait(()=>sends.length===2,'B dispatched');equal(sends[1].input.replyTo,1,'B frozen quote');await type('new draft C');pending.shift().lost();
 await wait(()=>document.querySelector('[data-group-send-journal]'),'uncertain visible');
 const original=sends[1].input.clientMessageId;await pause(100);equal(sends.length,2,'failure does not replay');
 mount('h');await wait(()=>textarea()&&!textarea().disabled&&document.body.textContent?.includes('Group h'),'h ready');equal(textarea().value,'','group draft isolation');
 mount('g');await wait(()=>textarea()&&!textarea().disabled&&textarea().value==='new draft C'&&document.body.textContent?.includes('Group g'),'g restore');
 await wait(()=>lookups.some(row=>row.id===original),'original lookup on remount');await wait(()=>!document.querySelector('[data-send-id="'+original+'"]'),'accepted lost receipt reconciled');equal(sends.length,2,'remount never sends');equal(textarea().value,'new draft C','lookup keeps C');checks.push('remount lookup and no replay');
 // A fresh intentional send of the same text gets a fresh ID.
 await type('send A');send();await wait(()=>sends.length===3,'same text new send');equal(sends[2].input.clientMessageId===sends[0].input.clientMessageId,false,'fresh intent fresh id');pending.shift().error();
 await wait(()=>document.querySelector('[data-send-id="'+sends[2].input.clientMessageId+'"]')&&named('groupChat.sendJournal.retry')&&!named('groupChat.sendJournal.retry').disabled,'failed send row');
 named('groupChat.sendJournal.retry').click();await wait(()=>sends.length===4,'explicit retry');equal(sends[3].input.clientMessageId,sends[2].input.clientMessageId,'explicit retry same id');equal(sends[3].input.body,sends[2].input.body,'explicit retry original body');pending.shift().success();await wait(()=>textarea().value==='','retry consumes only exact draft');checks.push('explicit retry identity');
 // Idle panel: one event and a failed first read must recover without another event or work submission.
 const before=sends.length;const newMsg={id:'remote',groupId:'g',seq:50,threadId:'main',author:{kind:'user'},body:'idle recovered',mentions:{memberIds:[],broadcast:false,unresolved:[]},createdAt:1};messages.g.push(newMsg);views.g.group.lastSeq=50;
 failNextRead=true;emitGroupChanged('g');await wait(()=>document.body.textContent?.includes('idle recovered'),'idle sole notification recovered');equal(sends.length,before,'panel recovery read only');checks.push('idle failed read retries');
 // Connection recovery discovers a missed invalidation on an idle group.
 messages.g.push({...newMsg,id:'remote2',seq:51,body:'service reconnect recovered'});views.g.group.lastSeq=51;window.dispatchEvent(new Event(GROUP_CONNECTION_EVENT));
 await wait(()=>document.body.textContent?.includes('service reconnect recovered'),'connection notification refreshes panel');checks.push('connection revalidation');
 // A late g snapshot must not leak into a newly selected h panel.
 let resolveOld:any;delayDetail=(resolve:any)=>resolveOld=resolve;emitGroupChanged('g');await wait(()=>resolveOld,'g slow read');mount('h');await wait(()=>textarea()&&!textarea().disabled&&document.body.textContent?.includes('Group h'),'switch h');resolveOld(new Response(JSON.stringify(views.g)));await pause(100);equal(document.body.textContent?.includes('service reconnect recovered'),false,'late g result rejected');checks.push('generation fence');
 delayUpload=true;queueFile('late-upload.txt');await wait(()=>resolveUpload&&document.querySelector('[data-status=uploading]'),'upload in old group');mount('g');await wait(()=>textarea()&&!textarea().disabled&&document.body.textContent?.includes('Group g'),'upload group switch');resolveUpload();await pause(120);equal(document.body.textContent?.includes('late-upload.txt'),false,'late upload cannot attach to another group');mount('h');await wait(()=>textarea()&&!textarea().disabled&&document.body.textContent?.includes('Group h'),'return h');equal(document.querySelector('[data-status=error]')?.textContent?.includes('late-upload.txt'),true,'interrupted upload restores explicit error metadata');(document.querySelector('.chat-att-x')as HTMLButtonElement).click();await pause();checks.push('late upload fence');
 await type('old authority input');send();await wait(()=>sends.length===5,'old authority send');views.h.ownerScope='replacement-owner';views.h.group.lastSeq=0;messages.h=[];emitGroupChanged('h');await wait(()=>textarea()&&!textarea().disabled&&textarea().value==='','new authority ready');await type('new authority draft');pending.shift().success();await pause(100);
 equal(textarea().value,'new authority draft','old authority ACK retains new authority input');equal(document.body.textContent?.includes('old authority input'),false,'old authority result excluded');equal(sends.length,5,'owner change never replays');checks.push('authority fence');
 await type('unconfirmed request F');send();await wait(()=>sends.length===6,'F submitted');pending.shift().error();await wait(()=>named('groupChat.sendJournal.new')&&!named('groupChat.sendJournal.new').disabled,'F explicit new control');await type('draft B survives new request');named('groupChat.sendJournal.new').click();await wait(()=>sends.length===7,'explicit new request');equal(sends[6].input.clientMessageId===sends[5].input.clientMessageId,false,'explicit new gets fresh identity');equal(sends[6].input.body,sends[5].input.body,'explicit new uses original text');pending.shift().error();await wait(()=>!named('groupChat.sendJournal.new').disabled,'fork completed uncertain');
 mount('g');await wait(()=>textarea()&&!textarea().disabled&&document.body.textContent?.includes('Group g'),'fork leave');mount('h');await wait(()=>textarea()&&!textarea().disabled&&document.body.textContent?.includes('Group h'),'fork restore');equal(textarea().value,'draft B survives new request','detached fork must not replace current draft after remount');equal(sends.length,7,'remount never replays either fork');checks.push('explicit new ID preserves current draft on remount');
 equal(getComputedStyle(document.querySelector('.chat-header__row')!).display,'flex','actual shared Chat skin');equal(document.documentElement.scrollWidth<=innerWidth+1,true,'pending journal has no horizontal overflow');equal(matchMedia('(prefers-reduced-motion: reduce)').matches,innerWidth===390,'motion preference observed');
 state.openPendingDetails=()=>{for(const el of document.querySelectorAll('[data-send-id]'))(el as HTMLDetailsElement).open=true};
 return{passed:true,language,theme,reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,checks,sends:sends.length,lookups:lookups.length,reads:reads.length,writes:writes.length,providerCalls:0};
};`;
try {
  await build({stdin:{contents:fixture,loader:"tsx",resolveDir:root},bundle:true,format:"esm",jsx:"automatic",nodePaths:[path.join(root,"app/manage-ui/node_modules")],
    loader:{".woff2":"dataurl",".svg":"dataurl",".webp":"dataurl",".png":"dataurl"},define:{"process.env.NODE_ENV":'"production"'},outfile:path.join(temp,"fixture.js"),logLevel:"silent",
    plugins:baseline?[{name:"baseline-panel",setup(builder){builder.onLoad({filter:/GroupChatPanel\.tsx$/},()=>({contents:execFileSync("git",["show","HEAD:app/manage-ui/src/pages/GroupChatPanel.tsx"],{cwd:root,encoding:"utf8"}),loader:"tsx"}))}}]:[]});
  fs.writeFileSync(path.join(temp,"index.html"),'<link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;height:100%;min-height:0}#root{display:flex;flex-direction:column}</style><div id="root" class="chat-shell"></div><script type="module" src="fixture.js"></script>');if(output)fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(path.join(temp,"main.cjs"),`const{app,BrowserWindow}=require('electron'),fs=require('node:fs');
app.setPath('userData',${JSON.stringify(path.join(temp,"profile"))});app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{let w,ok=false;
try{const results=[],cases=${baseline ? "[[1200,'zh-CN','light']]" : "[1200,390].flatMap(width=>['zh-CN','en'].flatMap(language=>['light','dark'].map(theme=>[width,language,theme])))"};
for(let index=0;index<cases.length;index++){
const[width,language,theme]=cases[index];w=new BrowserWindow({width,height:850,show:false,webPreferences:{backgroundThrottling:false,partition:'group-send-case-'+index}});
await w.loadURL('about:blank');w.webContents.debugger.attach('1.3');await w.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:width===390?'reduce':'no-preference'}]});
await w.loadFile(${JSON.stringify(path.join(temp,"index.html"))},{query:{language,theme}});await w.webContents.executeJavaScript('window.baseline=${baseline}');
const result=await w.webContents.executeJavaScript('window.runPanelFixture()');result.width=width;results.push(result);console.log(JSON.stringify(result));
if(${Boolean(output)}){fs.writeFileSync(${JSON.stringify(output)}+'/pending-'+width+'-'+language+'-'+theme+'.png',(await w.webContents.capturePage()).toPNG());await w.webContents.executeJavaScript('window.openPendingDetails()');await new Promise(resolve=>setTimeout(resolve,30));if(await w.webContents.executeJavaScript('document.documentElement.scrollWidth>innerWidth+1'))throw Error('expanded journal horizontal overflow');fs.writeFileSync(${JSON.stringify(output)}+'/pending-details-'+width+'-'+language+'-'+theme+'.png',(await w.webContents.capturePage()).toPNG())}
w.destroy();w=null;}
if(results.length!==cases.length)throw Error('incomplete visual case matrix');fs.writeFileSync(${JSON.stringify(path.join(temp,"complete.json"))},JSON.stringify({cases:results.length,passed:true}));
if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+'/results.json',JSON.stringify(results,null,2));ok=true;
}catch(error){console.error(error.stack||error);if(w&&!w.isDestroyed()&&${Boolean(output)})try{fs.writeFileSync(${JSON.stringify(output)}+'/failed.png',(await w.webContents.capturePage()).toPNG())}catch(captureError){console.error(captureError.message)}}finally{if(w&&!w.isDestroyed())w.destroy();app.exit(ok?0:1)}});`);
  const child=spawn(require("electron"),[path.join(temp,"main.cjs")],{env:{...process.env,ELECTRON_DISABLE_SECURITY_WARNINGS:"true"},stdio:["ignore","pipe","pipe"]});child.stdout.on("data",data=>process.stdout.write(data));child.stderr.on("data",data=>process.stderr.write(data));const timer=setTimeout(()=>child.kill("SIGTERM"),60000);
  const status=await new Promise((resolve,reject)=>{child.once("exit",resolve);child.once("error",reject)});clearTimeout(timer);assert.equal(status,0,"Group panel acceptance failed");assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temp,"complete.json"))),{cases:baseline?1:8,passed:true},"all UI cases must complete before accepting process exit");
}finally{fs.rmSync(temp,{recursive:true,force:true})}
