#!/usr/bin/env node
// Production Dashboard + API client in an isolated Electron renderer; synthetic HTTP data only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'app/manage-ui/package.json'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-files-ui-'));
const output = path.resolve(process.env.DASHBOARD_FILES_UI_OUTPUT || path.join(root, '.artifacts/dashboard-group-files-ui'));
const fixture = String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {HashRouter} from 'react-router-dom';
import DashboardPage from './app/manage-ui/src/pages/DashboardPage';
import {UiProvider} from './app/manage-ui/src/components/ui';
import ScrollbarProvider from './app/manage-ui/src/components/ScrollbarProvider';
import {FALLBACK_BACKEND_DESCRIPTORS} from './app/manage-ui/src/lib/backends';
import {runPageRefresh} from './app/manage-ui/src/lib/page-refresh';
import {recentDashboardArtifacts} from './app/manage-ui/src/lib/dashboardArtifacts';
import i18n from './app/manage-ui/src/i18n';
import './app/manage-ui/src/styles.css';
import './app/manage-ui/src/manage-skin.css';
const state=window as any, options=new URLSearchParams(location.search), now=Date.now();
const language=options.get('language')||'zh-CN', theme=options.get('theme')||'light';
const groupFile=(id:string,backendId:string,name:string,time=now)=>({attachment:{id,name,mimeType:'text/plain',size:12},
  groupId:'writing-group',groupName:'写作与产品交付讨论组',messageSeq:5,backendId,agentId:'writer',agentName:'写作助手',createdAt:time});
const native=groupFile('e7b8a622-8376-470c-bfc5-3c113ed3ef61','shoggoth','产品分析报告.txt');
const external=groupFile('e7b8a622-8376-470c-bfc5-3c113ed3ef62','hermes','文献检索与参考材料.txt',now-1000);
let unavailable=false, nativeUnavailable=false, rejectMedia=false;
const posts:any[]=[], reveals:string[]=[];
const summary=()=>({generatedAt:Date.now(),sinceMs:new Date().setHours(0,0,0,0),
  status:FALLBACK_BACKEND_DESCRIPTORS.map(d=>({id:d.id,name:d.name,connected:true,info:{}})),runs:[],running:[],approvals:[],usage:[],
  artifacts:[{backend:'openclaw',supported:true,items:[{path:'/tmp/local-report.md',name:'本地目录报告.md',area:'workspace',mtimeMs:now-2000,size:20,kind:'doc'},
    {path:'/tmp/local-report.md',name:'本地目录报告.md',area:'agents/main',mtimeMs:now-2000,size:20,kind:'doc'}]},
    {backend:'shoggoth',supported:true,partial:nativeUnavailable,items:[{path:'/tmp/native-report.md',name:'原生助理报告.md',area:'session-reference',agentId:'native-writer',agentName:'原生写作助手',mtimeMs:now-500,size:30,kind:'doc'}]}],
  groupArtifacts:unavailable?{supported:false,reason:'unavailable',items:[]}:{supported:true,partial:false,truncated:false,items:[native,external,native]},
  activityPage:{items:[],hasMore:false,degradedSources:[]},taskStats:{total:{ok:0,error:0},byKind:{},byAgent:[],complete:true}});
state.fetch=async(url:unknown,init:RequestInit={})=>{
  const p=new URL(String(url),'http://fixture');let value:any={};
  if(p.pathname==='/__api/dashboard')value={summary:summary()};
  else if(p.pathname==='/__api/dashboard/live')value={generatedAt:now,running:[],approvals:[]};
  else if(p.pathname==='/__api/config')value={config:{disabledBackends:[],locale:language}};
  else if(p.pathname==='/__api/backends')value={backends:FALLBACK_BACKEND_DESCRIPTORS};
  else if(p.pathname==='/__api/agents')value={agents:[{id:'writer',name:'写作助手',backendId:p.searchParams.get('backend')}]};
  else if(p.pathname==='/__api/usage')value={series:null};
  else if(p.pathname==='/__api/inspirations/media')return new Response('saved output',{status:rejectMedia?404:200});
  else if(p.pathname==='/__api/host/reveal-attachment'){
    posts.push({name:p.searchParams.get('name'),body:await (init.body as Blob).text()});value={ok:true};
  }else if(p.pathname==='/__api/cli/reveal'){reveals.push(JSON.parse(String(init.body)).path);value={ok:true};
  }else if(init.method&&init.method!=='GET')throw Error('Unexpected write '+p.pathname);
  return new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
};
window.addEventListener('error',e=>{state.fixtureError=e.error?.stack||e.message;});
window.addEventListener('unhandledrejection',e=>{state.fixtureError=String(e.reason);});
localStorage.clear();await i18n.changeLanguage(language);document.documentElement.dataset.theme=theme;
createRoot(document.getElementById('root')!).render(<HashRouter><UiProvider><ScrollbarProvider/><DashboardPage/></UiProvider></HashRouter>);
const wait=async(check:()=>unknown,label:string)=>{const end=performance.now()+8000;while(!check()){
  if(state.fixtureError)throw Error(state.fixtureError);if(performance.now()>end)throw Error(label);await new Promise(r=>setTimeout(r,20));}};
const rows=()=>Array.from(document.querySelectorAll<HTMLButtonElement>('.dash-art'));
state.prepareScreenshot=async()=>{
  await wait(()=>rows().length===4,'files did not render');
  if(window.innerWidth<600)document.querySelector('.dash-artifacts')!.scrollIntoView({block:'start'});
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
};
state.runFixture=async()=>{
  await wait(()=>rows().length===4,'files did not render or duplicates were counted');
  const names=rows().map(row=>row.querySelector('.dash-art-name')?.textContent);
  if(names.join('|')!=='产品分析报告.txt|原生助理报告.md|文献检索与参考材料.txt|本地目录报告.md')throw Error('publication order mismatch');
  if(!rows()[0].innerText.includes('写作与产品交付讨论组')||!rows()[0].innerText.includes('@写作助手'))throw Error('group/member attribution missing');
  const count=document.querySelector('.dash-artifacts .dash-section-count');
  if(count?.textContent!=='4'||!count?.getAttribute('title')?.includes('20'))throw Error('count scope missing');
  rows()[0].click();await wait(()=>posts.length===1,'reveal did not consume the saved attachment');
  if(posts[0].name!=='产品分析报告.txt'||posts[0].body!=='saved output')throw Error('wrong filename or bytes');
  if(!rows()[1].innerText.includes('@原生写作助手'))throw Error('native Agent name missing');
  rows()[1].click();await wait(()=>reveals.length===1,'native output did not reveal');
  if(reveals[0]!=='/tmp/native-report.md')throw Error('wrong native output path');
  rejectMedia=true;rows()[2].click();await wait(()=>document.body.innerText.includes(i18n.t('dashboard.artifactRevealFailed')),'missing media error');
  if(posts.length!==1||rows().length!==4)throw Error('failed media was revealed or list disappeared');rejectMedia=false;
  unavailable=true;await runPageRefresh('/dashboard');await wait(()=>rows().length===2,'group outage lost native/local rows');
  if(!document.body.innerText.includes(i18n.t('dashboard.artifactsGroupUnavailable')))throw Error('outage explanation missing');
  unavailable=false;await runPageRefresh('/dashboard');await wait(()=>rows().length===4,'groups did not recover');
  nativeUnavailable=true;await runPageRefresh('/dashboard');
  await wait(()=>document.body.innerText.includes(i18n.t('dashboard.artifactsUnavailable',{backend:'Shoggoth'})),'native partial explanation missing');
  if(rows().length!==4)throw Error('native partial lost valid rows');
  nativeUnavailable=false;await runPageRefresh('/dashboard');
  const large=summary();large.groupArtifacts={supported:true,items:Array.from({length:30},(_,i)=>groupFile('id-'+i,'shoggoth','file-'+i+'.txt',now+i))} as any;
  const selected=recentDashboardArtifacts(large as any);
  if(selected.length!==20||selected[0].name!=='file-29.txt'||selected[19].name!=='file-10.txt')throw Error('shared limit/order mismatch');
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  if(document.documentElement.scrollWidth>window.innerWidth+1)throw Error('horizontal overflow');
  return {language,theme,count:4,nativeOutputs:true,nativePartial:true,nativeReveal:reveals[0],nativeAndExternal:true,groupAttribution:true,deduplicated:true,sharedLimit:20,reveal:posts[0],missingMedia:true,outageRecovery:true};
};
`;

try {
  await require('esbuild').build({ stdin: { contents: fixture, loader: 'tsx', resolveDir: root }, bundle: true, format: 'esm',
    jsx: 'automatic', nodePaths: [path.join(root, 'app/manage-ui/node_modules')], define: { 'process.env.NODE_ENV': '"production"' },
    external: ['/fonts/*'], // Vite serves these public fonts; the unopened Inspiration dialog owns these styles.
    loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.webp': 'dataurl', '.png': 'dataurl' },
    outfile: path.join(temp, 'fixture.js'), logLevel: 'silent' });
  fs.writeFileSync(path.join(temp, 'index.html'), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><style>body{margin:0}#root{padding:24px;min-height:100vh;box-sizing:border-box}@media(max-width:600px){#root{padding:12px}}</style><div id="root"></div><script type="module" src="fixture.js"></script>');
  fs.mkdirSync(output, { recursive: true });
  const main = path.join(temp, 'main.cjs');
  fs.writeFileSync(main, `const {app,BrowserWindow}=require('electron'),fs=require('node:fs');
app.setPath('userData',${JSON.stringify(path.join(temp, 'profile'))});
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1200,height:950,webPreferences:{backgroundThrottling:false}});let passed=false;
try{const results=[];for(const language of ['zh-CN','en'])for(const theme of ['light','dark'])for(const width of [1200,390]){
w.setContentSize(width,950);await w.loadFile(${JSON.stringify(path.join(temp, 'index.html'))},{query:{language,theme}});
await w.webContents.executeJavaScript('window.prepareScreenshot()');
fs.writeFileSync(${JSON.stringify(output)}+'/'+language+'-'+theme+'-'+width+'.png',(await w.webContents.capturePage()).toPNG());
results.push({...await w.webContents.executeJavaScript('window.runFixture()'),width});}
fs.writeFileSync(${JSON.stringify(output)}+'/results.json',JSON.stringify(results,null,2));console.log('PASS Dashboard group files: '+results.length+' language/theme/width combinations');passed=true;
}catch(e){console.error(e.stack||e);console.error(await w.webContents.executeJavaScript('document.body.innerText.slice(-3000)'));
fs.writeFileSync(${JSON.stringify(output)}+'/failure.png',(await w.webContents.capturePage()).toPNG());}
finally{w.destroy();app.exit(passed?0:1);}});`);
  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [main], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => process.stdout.write(data)); child.stderr.on('data', data => process.stderr.write(data));
  const timer = setTimeout(() => child.kill('SIGTERM'), 90000);
  let status;
  try { status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); }
  finally { clearTimeout(timer); }
  assert.equal(status, 0, 'Dashboard file renderer regression failed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
