#!/usr/bin/env node
// Actual production search and full-message components, synthetic read-only API, isolated Electron profile; no Service/Provider.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '..'), require = createRequire(path.join(root, 'app/manage-ui/package.json'));
const output = path.resolve(process.env.GROUP_SEARCH_UI_OUTPUT || path.join(root, '.artifacts/group-plan-completion-20261015/search-execution-ui'));
const temp = fs.realpathSync(fs.mkdtempSync('/private/tmp/shoggoth-group-search-ui-')); fs.chmodSync(temp, 0o700);
const body = '回复 #1\nSearchable saved source. 已保存的群消息全文。 needle Evidence at the end. 尾部证据。';
const digest = crypto.createHash('sha256').update(body).digest('hex');
const fixture = String.raw`
import React from 'react';import{createRoot}from'react-dom/client';import{UiProvider}from'./app/manage-ui/src/components/ui';
import Search from './app/manage-ui/src/pages/GroupChatSearch';import Source from './app/manage-ui/src/pages/GroupChatFullMessage';
import './app/manage-ui/src/i18n/groupCollaborationResources';import i18n from './app/manage-ui/src/i18n';import './app/manage-ui/src/styles.css';import './app/manage-ui/src/manage-skin.css';import './app/manage-ui/src/pages/ChatPage.css';
const state=window as any,fixture=FIXTURE,params=new URLSearchParams(location.search),language=params.get('language')||'zh-CN',theme=params.get('theme')||'light';
const errors:any[]=[],reads:any[]=[],opens:any[]=[];let writes=0;const pause=(ms=20)=>new Promise(resolve=>setTimeout(resolve,ms));
addEventListener('error',event=>errors.push(event.error?.stack||event.message));addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
const assert=(condition:unknown,label:string)=>{if(!condition)throw Error(label)},equal=(a:any,b:any,label:string)=>assert(JSON.stringify(a)===JSON.stringify(b),label+': '+JSON.stringify(a));
const wait=async(check:()=>unknown,label:string)=>{const end=Date.now()+6000;while(!check()){if(errors.length)throw Error(errors.join('\n'));if(Date.now()>end)throw Error(label);await pause()}};
const tr=(key:string,opts:any={})=>i18n.t(key,opts),button=(key:string)=>Array.from(document.querySelectorAll('button')).find(node=>node.textContent===tr(key))!;
const member={id:'member1',groupId:'g',displayName:'Long member name / 负责证据与需求核验的成员',state:'active'};
const view={ownerScope:'owner',group:{id:'g'},members:[member]};
const hit=(seq:number)=>({message:{id:'m'+seq,groupId:'g',seq,threadId:'main',author:{kind:'member',memberId:'member1'},body:fixture.body,replyTo:{seq:1,messageId:'original',author:{kind:'user'},excerpt:'Question / 用户问题'},fullResult:{bytes:new TextEncoder().encode(fixture.body).length,digest:fixture.digest},mentions:{memberIds:[],broadcast:false,unresolved:[]},createdAt:1000},snippet:fixture.body,snippetOffset:0,partial:seq===2});
state.fetch=async(target:any,init:any={})=>{const url=new URL(String(target),'http://fixture');if(init.method&&init.method!=='GET'){writes++;throw Error('unexpected write')}
 reads.push({path:url.pathname,params:Object.fromEntries(url.searchParams)});equal(url.searchParams.get('id'),'g','current group');
 if(url.pathname.endsWith('/search')){equal(url.searchParams.get('query'),'needle','query');const more=url.searchParams.has('cursor');if(more)equal(url.searchParams.get('cursor'),'fixed-cursor','cursor binding');
 return new Response(JSON.stringify({groupId:'g',query:'needle',discussionId:url.searchParams.get('discussionId'),authorKind:url.searchParams.get('authorKind'),memberId:url.searchParams.get('memberId'),upperSeq:6,hits:[hit(more?2:6)],partial:true,hasMore:!more,nextCursor:more?null:'fixed-cursor'}));}
 if(url.pathname.endsWith('/read')){equal(url.searchParams.get('seq'),'6','fixed seq');equal(url.searchParams.get('digest'),fixture.digest,'fixed digest');return new Response(JSON.stringify({page:{text:fixture.body,totalBytes:new TextEncoder().encode(fixture.body).length,offset:0,nextOffset:null,digest:fixture.digest}}));}
 throw Error('unexpected endpoint '+url.pathname);};
await i18n.changeLanguage(language);document.documentElement.setAttribute('data-theme',theme);
const root=createRoot(document.getElementById('root')!);
const render=(mode='search',message?:any)=>root.render(<UiProvider>{mode==='search'?<Search view={view as any} onClose={()=>{}} onOpenMessage={message=>{opens.push(message);render('source',message)}}/>:<Source groupId='g' message={message} onClose={()=>render()}/>}</UiProvider>);
const layout=async()=>{await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));assert(document.documentElement.scrollWidth<=innerWidth+1,'no document overflow');
 for(const node of Array.from(document.querySelectorAll('[data-group-search],input,select,article'))){assert(node.getBoundingClientRect().right<=innerWidth+1,'element within viewport');assert(node.getBoundingClientRect().left>=-1,'element left within viewport')}
 assert(!document.body.textContent?.includes('groupChat.search.'),'search translations');equal(errors,[],'no renderer errors')};
state.search=async()=>{render();await wait(()=>document.querySelector('[data-group-search] input'),'search mounted');equal(reads.length,0,'no automatic history reads');
 const input=document.querySelector('[data-group-search] input')as HTMLInputElement;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'needle');input.dispatchEvent(new Event('input',{bubbles:true}));
 await wait(()=>!button('groupChat.search.search')?.disabled,'query entered');button('groupChat.search.search').click();await wait(()=>document.querySelectorAll('[data-group-search] article').length===1,'first result');
 assert(document.body.textContent?.includes(tr('groupChat.search.partial')),'old text partial');assert(!document.body.textContent?.includes('回复 #1'),'leading marker hidden in search');await layout();return{search:true}};
state.more=async()=>{button('groupChat.search.more').click();await wait(()=>document.querySelectorAll('[data-group-search] article').length===2,'older page appended');assert(document.body.textContent?.includes(tr('groupChat.search.partialHit')),'old source label');document.querySelector('[data-group-search] article')!.scrollIntoView({block:'start'});await layout();return{pagination:true}};
state.read=async()=>{button('groupChat.search.read').click();await wait(()=>document.body.textContent?.includes(tr('groupChat.fullResult.verified')),'source verified');equal(opens.length,1,'one explicit open');equal(opens[0].fullResult.digest,fixture.digest,'frozen callback');assert(document.body.textContent?.includes(fixture.body.split('\n').slice(1).join('\n')),'full body');assert(!document.body.textContent?.includes('回复 #1'),'legacy reply marker hidden after digest verification');equal(opens[0].replyTo.seq,1,'authoritative quote preserved');await layout();return{read:true}};
state.finish=async()=>{equal(writes,0,'zero writes');equal(reads.length,3,'two searches and one source read');return{language,theme,reads,writes,errors,passed:true}};state.fixtureReady=true;`;
try {
  fs.mkdirSync(output, { recursive: true });
  await require('esbuild').build({ stdin: { contents: fixture.replace('FIXTURE', JSON.stringify({ body, digest })), loader: 'tsx', resolveDir: root }, bundle: true, format: 'esm', jsx: 'automatic', nodePaths: [path.join(root, 'app/manage-ui/node_modules')], loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.webp': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' }, outfile: path.join(temp, 'fixture.js'), logLevel: 'silent' });
  fs.writeFileSync(path.join(temp, 'index.html'), '<link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;min-height:100%}</style><div id="root"></div><script type="module" src="fixture.js"></script>');
  fs.writeFileSync(path.join(temp, 'main.cjs'), `const{app,BrowserWindow,session}=require('electron'),fs=require('node:fs');app.setPath('userData',${JSON.stringify(path.join(temp, 'profile'))});app.setPath('sessionData',${JSON.stringify(path.join(temp, 'session'))});app.on('window-all-closed',()=>{});
  app.whenReady().then(async()=>{const forbidden=[];session.defaultSession.webRequest.onBeforeRequest((details,cb)=>{const url=new URL(details.url);if(['http:','https:','ws:','wss:'].includes(url.protocol)){forbidden.push(url.origin);return cb({cancel:true})}cb({cancel:false})});const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});let ok=false;const cases=[];
  try{for(const width of[1200,390])for(const language of['zh-CN','en'])for(const theme of['light','dark']){window.setSize(width,950);await window.loadFile(${JSON.stringify(path.join(temp, 'index.html'))},{query:{language,theme}});await window.webContents.executeJavaScript('new Promise(async resolve=>{while(!window.fixtureReady)await new Promise(r=>setTimeout(r,10));resolve(true)})');for(const stage of['search','more','read']){await window.webContents.executeJavaScript('window.'+stage+'()');fs.writeFileSync(${JSON.stringify(output)}+'/'+stage+'-'+width+'-'+language+'-'+theme+'.png',(await window.webContents.capturePage()).toPNG())}const result=await window.webContents.executeJavaScript('window.finish()');cases.push({width,...result});console.log(JSON.stringify({width,language,theme,passed:result.passed}))}if(forbidden.length)throw Error('outside requests');fs.writeFileSync(${JSON.stringify(path.join(output, 'results.json'))},JSON.stringify({cases,forbidden,completed:true},null,2));ok=true}catch(error){console.error(error.stack||error);fs.writeFileSync(${JSON.stringify(path.join(output, 'failed.png'))},(await window.webContents.capturePage()).toPNG())}finally{window.destroy();if(ok)app.quit();else app.exit(1)}});`);
  const child = spawn(require('electron'), [path.join(temp, 'main.cjs')], { env: { PATH: process.env.PATH, HOME: path.join(temp, 'home'), TMPDIR: temp, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => process.stdout.write(chunk)); child.stderr.on('data', chunk => process.stderr.write(chunk));
  const timer = setTimeout(() => child.kill('SIGTERM'), 60000);
  const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); }); clearTimeout(timer);
  assert.deepEqual(status, { code: 0, signal: null }); assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'results.json'), 'utf8')).cases.length, 8);
  console.log('PASS search production UI: eight combinations; ' + output);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
