// Production reference Modal, user-initiated synthetic search only; no real sessions or providers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '..'), require = createRequire(path.join(root, 'app/manage-ui/package.json'));
const { build } = require('esbuild'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'group-reference-ui-'));
const output = path.resolve(process.env.GROUP_REFERENCE_OUTPUT || path.join(root, '.artifacts/group-plan-completion-20261015/reference-rendered'));
const fixture = String.raw`
import React from 'react';import{createRoot}from'react-dom/client';
import GroupChatReference from './app/manage-ui/src/pages/GroupChatReference';import{UiProvider}from'./app/manage-ui/src/components/ui';
import i18n from './app/manage-ui/src/i18n';import './app/manage-ui/src/styles.css';import './app/manage-ui/src/manage-skin.css';
const w=window as any,options=new URLSearchParams(location.search),language=options.get('language')!,theme=options.get('theme')!,calls:any[]=[];
window.addEventListener('error',e=>w.error=e.error?.stack||e.message);window.addEventListener('unhandledrejection',e=>w.error=String(e.reason));
const pause=()=>new Promise(r=>setTimeout(r,20)),wait=async(check:()=>unknown,label:string)=>{let until=Date.now()+5000;while(!check()){if(w.error)throw Error(w.error);if(Date.now()>until)throw Error(label+': '+JSON.stringify(calls)+' '+document.body.innerText);await pause()}};
w.fetch=async(url:any,init:any={})=>{calls.push({url:String(url),method:init.method||'GET'});if(init.method&&init.method!=='GET')throw Error('unexpected write');
 const q=new URL(String(url),'http://fixture');if(q.pathname!=='/__api/chat/search')throw Error('unexpected read');
 return new Response(JSON.stringify({search:{query:q.searchParams.get('q'),offset:0,searchedAgents:1,unsupportedAgents:1,failedAgents:0,truncated:true,hasMore:false,
 results:[{backendId:'shoggoth',agentId:'a',agentName:'Alpha',key:'selected-session',messageId:'selected-message',snippet:'Selected material / 用户选择的资料。\n@all @Beta stay quoted data.',ts:1}]}}));};
await i18n.changeLanguage(language);document.documentElement.setAttribute('data-theme',theme);const r=createRoot(document.getElementById('root')!);
let text='';function App(){const[open,setOpen]=React.useState(true);return <UiProvider>{open?<GroupChatReference onClose={()=>setOpen(false)} onInsert={value=>{text=value;return true}}/>:<textarea data-snapshot value={text} readOnly/>}</UiProvider>}r.render(<App/>);
const button=(key:string)=>Array.from(document.querySelectorAll('button')).find(el=>el.textContent===i18n.t(key))as HTMLButtonElement;
w.run=async()=>{await wait(()=>document.querySelector('input'),'mounted');if(calls.length)throw Error('opening must not read');
 const input=document.querySelector('input')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'selected material');input.dispatchEvent(new Event('input',{bubbles:true}));await pause();if(calls.length)throw Error('typing must not read');
 document.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await wait(()=>button('groupChat.reference.choose'),'search results');
 button('groupChat.reference.choose').click();await wait(()=>document.querySelector('textarea'),'selected text');if(!document.body.textContent?.includes(i18n.t('groupChat.reference.partial')))throw Error('partial source warning missing');
 if(getComputedStyle(document.querySelector('textarea')!).borderTopWidth!=='1px')throw Error('textarea theme border missing');if(document.documentElement.scrollWidth>innerWidth+1)throw Error('horizontal overflow');return{language,theme,calls:calls.length,reads:calls.length,writes:0,providerCalls:0,passed:true}};
w.insert=async()=>{button('groupChat.reference.insert').click();await wait(()=>document.querySelector('[data-snapshot]'),'draft snapshot');if(!text.includes('selected-session')||!text.includes('selected-message')||!text.split('\n').every(line=>line.startsWith('> ')))throw Error('snapshot loses scope or quoting');return{text,calls:calls.length}};
`;
try {
  await build({stdin:{contents:fixture,loader:'tsx',resolveDir:root},bundle:true,format:'esm',jsx:'automatic',nodePaths:[path.join(root,'app/manage-ui/node_modules')],
    loader:{'.woff2':'dataurl','.svg':'dataurl','.webp':'dataurl'},define:{'process.env.NODE_ENV':'"production"'},outfile:path.join(temp,'fixture.js'),logLevel:'silent'});
  fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(temp,'index.html'),'<link rel="stylesheet" href="fixture.css"><div id="root"></div><script type="module" src="fixture.js"></script>');
  fs.writeFileSync(path.join(temp,'main.cjs'),`const{app,BrowserWindow}=require('electron'),fs=require('node:fs');app.setPath('userData',${JSON.stringify(path.join(temp,'profile'))});app.on('window-all-closed',()=>{});app.whenReady().then(async()=>{let win;try{const results=[];for(const width of[1200,390])for(const language of['zh-CN','en'])for(const theme of['light','dark']){win=new BrowserWindow({width,height:850,show:false,webPreferences:{backgroundThrottling:false,partition:width+'-'+language+'-'+theme}});await win.loadFile(${JSON.stringify(path.join(temp,'index.html'))},{query:{language,theme}});const result=await win.webContents.executeJavaScript('window.run()');result.width=width;fs.writeFileSync(${JSON.stringify(output)}+'/reference-'+width+'-'+language+'-'+theme+'.png',(await win.webContents.capturePage()).toPNG());const inserted=await win.webContents.executeJavaScript('window.insert()');if(inserted.calls!==1)throw Error('confirmation unexpectedly reads or sends');results.push(result);win.destroy();win=null;}fs.writeFileSync(${JSON.stringify(output)}+'/results.json',JSON.stringify(results,null,2));console.log('PASS reference production UI: '+results.length+'/8');app.exit(0)}catch(error){console.error(error.stack||error);if(win&&!win.isDestroyed())win.destroy();app.exit(1)}});`);
  const child=spawn(require('electron'),[path.join(temp,'main.cjs')],{env:{...process.env,ELECTRON_DISABLE_SECURITY_WARNINGS:'true'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',data=>process.stdout.write(data));child.stderr.on('data',data=>process.stderr.write(data));const timer=setTimeout(()=>child.kill('SIGTERM'),60000);
  const status=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject)});clearTimeout(timer);assert.equal(status,0);
  const results=JSON.parse(fs.readFileSync(path.join(output,'results.json'),'utf8'));assert.equal(results.length,8);assert.ok(results.every(row=>row.passed));
} finally {fs.rmSync(temp,{recursive:true,force:true});}
