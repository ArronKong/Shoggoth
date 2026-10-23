// Production recovery viewer + real Chromium IndexedDB; isolated synthetic journal, no Provider.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '..'), require = createRequire(path.join(root, 'app/manage-ui/package.json'));
const { build } = require('esbuild'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'group-journal-recovery-ui-'));
const output = path.resolve(process.env.GROUP_JOURNAL_RECOVERY_OUTPUT || path.join(root, '.artifacts/group-directed-input-20261015/journal-rendered'));
const fixture = String.raw`
import React from 'react';import{createRoot}from'react-dom/client';
import Recovery from './app/manage-ui/src/pages/GroupChatJournalRecovery';import{UiProvider}from'./app/manage-ui/src/components/ui';
import{groupSendJournal as journal,emptyGroupComposer}from'./app/manage-ui/src/lib/groupSendJournal';
import i18n from './app/manage-ui/src/i18n';import './app/manage-ui/src/styles.css';import './app/manage-ui/src/manage-skin.css';
const w=window as any,options=new URLSearchParams(location.search),language=options.get('language')!,theme=options.get('theme')!;
let writes=0,network=0;w.fetch=()=>{network++;throw Error('unexpected network')};
window.addEventListener('error',e=>w.error=e.error?.stack||e.message);window.addEventListener('unhandledrejection',e=>w.error=String(e.reason));
const pause=()=>new Promise(r=>setTimeout(r,20)),wait=async(check:()=>unknown,label:string)=>{let until=Date.now()+5000;while(!check()){if(w.error)throw Error(w.error);if(Date.now()>until)throw Error(label+': '+document.body.innerText);await pause()}};
await i18n.changeLanguage(language);document.documentElement.setAttribute('data-theme',theme);
const owner='fixture-owner',group='fixture-group',composer={...emptyGroupComposer(),text:'Original draft / 待恢复草稿'};
const draft=await journal.saveComposer(owner,group,'draft',1,composer,0);
const original=await journal.prepare(owner,group,{clientMessageId:'send-00',body:'Original 00 / 原始输入',mentions:[]},draft);
const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('shoggoth-group-journal');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
const mutate=(apply:(tx:IDBTransaction)=>void)=>new Promise<void>((resolve,reject)=>{const tx=db.transaction(['send_journal','composer_snapshots'],'readwrite');apply(tx);tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error)});
await mutate(tx=>{const store=tx.objectStore('send_journal');for(let n=0;n<26;n++){const id='send-'+String(n).padStart(2,'0');store.put({...original,key:JSON.stringify([owner,group,id]),clientMessageId:id,phase:'corrupt',inputSnapshot:{...original.inputSnapshot,clientMessageId:id,body:'Original '+n+' / 原始输入 '+n}})}
 const cycle:any={key:'!cycle'};cycle.self=cycle;store.put(cycle);store.put({key:'!large',body:'x'.repeat(270000)});
 store.put({...original,key:JSON.stringify(['foreign',group,'secret']),ownerScope:'foreign',clientMessageId:'secret',inputSnapshot:{...original.inputSnapshot,clientMessageId:'secret',body:'FOREIGN_SECRET_NEVER_RENDER'}})});
let rejected=false;try{await journal.read(owner,group)}catch{rejected=true}if(!rejected)throw Error('corrupt normal read accepted');
const fingerprint=()=>new Promise<string>((resolve,reject)=>{const tx=db.transaction(['send_journal','composer_snapshots'],'readonly'),a=tx.objectStore('send_journal').getAll(),b=tx.objectStore('composer_snapshots').getAll();tx.oncomplete=()=>resolve(JSON.stringify({sends:a.result.map(row=>row.key==='!cycle'?{key:row.key,cyclic:row.self===row}:row),drafts:b.result}));tx.onabort=()=>reject(tx.error)});
const before=await fingerprint(),methods=['put','add','delete','clear']as const;for(const method of methods){const old=IDBObjectStore.prototype[method];(IDBObjectStore.prototype as any)[method]=function(...args:any[]){writes++;return(old as any).apply(this,args)}}
const r=createRoot(document.getElementById('root')!);let setScope:any;
function App(){const[scope,change]=React.useState([owner,group]);setScope=change;return <UiProvider><Recovery ownerScope={scope[0]} groupId={scope[1]} onClose={()=>{}}/></UiProvider>}r.render(<App/>);
const button=(key:string)=>Array.from(document.querySelectorAll('button')).find(el=>el.textContent===i18n.t(key))as HTMLButtonElement;
const texts=()=>Array.from(document.querySelectorAll('textarea'))as HTMLTextAreaElement[];
const visible=()=>{if(document.body.textContent?.includes('FOREIGN_SECRET_NEVER_RENDER'))throw Error('foreign owner leaked');if(texts().some(x=>!x.readOnly))throw Error('editable recovery');if(document.documentElement.scrollWidth>innerWidth+1)throw Error('horizontal overflow')};
w.run=async()=>{await wait(()=>texts().length===20,'first recovery page');visible();
 if(!document.body.textContent?.includes(i18n.t('groupChat.sendJournal.recoveryHint')))throw Error('unverified warning missing');
 if(!document.body.textContent?.includes(i18n.t('groupChat.sendJournal.recoveryPartial')))throw Error('invalid records not disclosed');
 const first=texts()[0];first.blur();first.focus();first.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));await pause();if(first.selectionStart!==0||first.selectionEnd!==first.value.length)throw Error('manual copy selection missing');
 if(getComputedStyle(first).borderTopWidth!=='1px')throw Error('theme border missing');
 const initial=texts().map(x=>x.value);button('groupChat.sendJournal.recoveryMore').click();await wait(()=>texts().length===7,'second recovery page');visible();
 if(initial.some(text=>texts().some(x=>x.value===text)))throw Error('pages accumulated');
 if(!texts().some(x=>x.value===composer.text))throw Error('draft was not recovered');
 if(button('groupChat.sendJournal.recoveryMore'))throw Error('incorrect final page');
 button('groupChat.sendJournal.recoveryRefresh').click();await wait(()=>texts().length===20,'refresh recovery');visible();
 if(before!==await fingerprint()||writes!==0||network!==0)throw Error('read-only recovery mutated original or accessed network');
 return{language,theme,firstPage:20,secondPage:7,corruptNormalReadRejected:rejected,cyclicAndLargeRowsSkipped:true,originalUnchanged:true,writes,network,providerCalls:0,passed:true}};
w.race=async()=>{const recover=journal.recover.bind(journal),oldPage=await recover(owner,group),newPage=await recover('other-owner',group);let release:any;
 journal.recover=async(o,g,offset,digest)=>o===owner?await new Promise(resolve=>{release=()=>resolve(oldPage)}):newPage;
 button('groupChat.sendJournal.recoveryRefresh').click();await wait(()=>release,'deferred current owner');setScope(['other-owner',group]);await wait(()=>document.body.textContent?.includes(i18n.t('groupChat.sendJournal.recoveryEmpty')),'new owner empty');release();await pause();await pause();if(texts().length)throw Error('late owner recovery leaked');
 journal.recover=recover;r.unmount();db.close();await journal.close();return{lateOwnerDiscarded:true}};
`;
try {
  await build({stdin:{contents:fixture,loader:'tsx',resolveDir:root},bundle:true,format:'esm',jsx:'automatic',nodePaths:[path.join(root,'app/manage-ui/node_modules')],
    loader:{'.woff2':'dataurl','.svg':'dataurl','.webp':'dataurl'},define:{'process.env.NODE_ENV':'"production"'},outfile:path.join(temp,'fixture.js'),logLevel:'silent'});
  fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(temp,'index.html'),'<link rel="stylesheet" href="fixture.css"><div id="root"></div><script type="module" src="fixture.js"></script>');
  fs.writeFileSync(path.join(temp,'main.cjs'),`const{app,BrowserWindow}=require('electron'),fs=require('node:fs');app.setPath('userData',${JSON.stringify(path.join(temp,'profile'))});app.on('window-all-closed',()=>{});app.whenReady().then(async()=>{let win;try{const results=[];for(const width of[1200,390])for(const language of['zh-CN','en'])for(const theme of['light','dark']){win=new BrowserWindow({width,height:850,show:false,webPreferences:{backgroundThrottling:false,partition:width+'-'+language+'-'+theme}});win.webContents.on('console-message',(_event,_level,message)=>console.log('renderer: '+message));await win.loadFile(${JSON.stringify(path.join(temp,'index.html'))},{query:{language,theme}});await win.webContents.executeJavaScript('new Promise((resolve,reject)=>{const until=Date.now()+5000;const check=()=>window.error?reject(Error(window.error)):window.run?resolve():Date.now()>until?reject(Error("fixture did not start")):setTimeout(check,20);check()})');const result=await win.webContents.executeJavaScript('window.run()');result.width=width;fs.writeFileSync(${JSON.stringify(output)}+'/recovery-'+width+'-'+language+'-'+theme+'.png',(await win.webContents.capturePage()).toPNG());Object.assign(result,await win.webContents.executeJavaScript('window.race()'));results.push(result);win.destroy();win=null;}fs.writeFileSync(${JSON.stringify(output)}+'/results.json',JSON.stringify(results,null,2));console.log('PASS recovery production UI + real IndexedDB: '+results.length+'/8');app.exit(0)}catch(error){console.error(error.stack||error);if(win&&!win.isDestroyed())win.destroy();app.exit(1)}});`);
  const child=spawn(require('electron'),[path.join(temp,'main.cjs')],{env:{...process.env,ELECTRON_DISABLE_SECURITY_WARNINGS:'true'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',data=>process.stdout.write(data));child.stderr.on('data',data=>process.stderr.write(data));const timer=setTimeout(()=>child.kill('SIGTERM'),60000);
  const status=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject)});clearTimeout(timer);assert.equal(status,0);
  const results=JSON.parse(fs.readFileSync(path.join(output,'results.json'),'utf8'));assert.equal(results.length,8);assert.ok(results.every(row=>row.passed&&row.lateOwnerDiscarded));
} finally {fs.rmSync(temp,{recursive:true,force:true});}
