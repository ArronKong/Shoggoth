#!/usr/bin/env node
// Actual Panel / Activity in isolated Electron; actual server projection from controlled protocol events.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const root=path.resolve(import.meta.dirname,".."),require=createRequire(path.join(root,"app/manage-ui/package.json"));
const{build}=require("esbuild"),{GroupActivityProjection}=require(path.join(root,"app/agent-service/group-activity.js"));
const temp=fs.realpathSync(fs.mkdtempSync("/private/tmp/shoggoth-group-activity-ui-"));
const output=process.env.GROUP_ACTIVITY_UI_OUTPUT?path.resolve(process.env.GROUP_ACTIVITY_UI_OUTPUT):null;
const at=Date.now(),binding=(member,opportunity)=>({groupId:"g",discussionId:"d",memberId:member,opportunityId:opportunity,taskId:null,attemptId:null,runId:`run-${opportunity}`,executionGeneration:"execution-1"});
const alpha=new GroupActivityProjection(binding("a","alpha"),{now:()=>at}),beta=new GroupActivityProjection(binding("b","beta"),{now:()=>at});
alpha.observeEvents([{seq:1,type:"tool.start",runId:"run-alpha",createdAt:at,payload:{toolCallId:"command",tool:{name:"exec_command",arguments:{command:"node check.js",title:"Verify collaboration",apiKey:"activity-canary-secret"}}}}],"stream-a");
beta.observeStatus("waiting_approval");
const initial={alpha:alpha.snapshot(),beta:beta.snapshot()};
alpha.observeEvents([{seq:2,type:"status",runId:"run-alpha",payload:{status:"compacting",text:"private-status-canary"}}],"stream-a");const compacting=alpha.snapshot();
alpha.observeEvents([{seq:3,type:"status",runId:"run-alpha",payload:{status:"compacted"}}],"stream-a");const compacted=alpha.snapshot();
alpha.observeEvents([{seq:4,type:"tool.result",runId:"run-alpha",createdAt:at+1,payload:{toolCallId:"command",tool:{name:"exec_command",output:"",durationMs:0}}}],"stream-a");alpha.observeStatus("completed",{at:at+2});
const completed=alpha.snapshot();alpha.observeEvents([{seq:5,type:"tool.update",runId:"run-alpha",createdAt:at+3,payload:{toolCallId:"command",delta:"late output"}},{seq:6,type:"status",runId:"run-alpha",payload:{status:"compacting"}}],"stream-a");const late=alpha.snapshot();
const fixture=String.raw`
import React from"react";import{createRoot}from"react-dom/client";import GroupChatPanel from"./app/manage-ui/src/pages/GroupChatPanel";
import{UiProvider}from"./app/manage-ui/src/components/ui";import{emitGroupChanged}from"./app/manage-ui/src/lib/groupChat";import i18n from"./app/manage-ui/src/i18n";
import"./app/manage-ui/src/styles.css";import"./app/manage-ui/src/manage-skin.css";import"./app/manage-ui/src/pages/ChatPage.css";
const state=window as any,options=new URLSearchParams(location.search),language=options.get('language')||'zh-CN',theme=options.get('theme')||'light',data=FIXTUREDATA;
const pause=(ms=20)=>new Promise(resolve=>setTimeout(resolve,ms)),equal=(a:any,b:any,label:string)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw Error(label+': '+JSON.stringify(a)+' != '+JSON.stringify(b))};
window.addEventListener('error',event=>state.fixtureError=event.error?.stack||event.message);window.addEventListener('unhandledrejection',event=>state.fixtureError=String(event.reason));
const wait=async(check:()=>unknown,label:string)=>{const until=Date.now()+6000;while(!check()){if(state.fixtureError)throw Error(state.fixtureError);if(Date.now()>until)throw Error(label);await pause()}};
let writes=0,reads=0;const responses:any[]=[];
// History, live execution bubbles and interaction cards share the same scroll viewport.
const history=Array.from({length:40},(_,index)=>({id:'history-'+index,groupId:'g',seq:index+1,threadId:'main',author:{kind:'member',memberId:'a'},
 body:('Saved group response '+index+' — 已保存的群聊消息。\n\n').repeat(10),mentions:{memberIds:[],broadcast:false,unresolved:[]},createdAt:Date.now()-1000*(40-index)}));
history[39]={...history[39],author:{kind:'user'}};
const member=(id:string,name:string)=>({id,groupId:'g',backendId:'shoggoth',agentId:id,displayName:name,handle:id,state:'active',position:0,joinedSeq:0,leftSeq:null});
let view:any={ownerScope:'fixture-owner',group:{id:'g',name:'Collaboration group',status:'active',purpose:'',createdAt:1,updatedAt:1,metadataRevision:1,rosterRevision:1,directoryRevision:1,controlEpoch:0,lastSeq:history.length,ownerMemberId:'a'},members:[member('a','Alpha'),member('b','Beta')],
 currentOwnerId:'a',round:{id:'d',causeMessageId:'history-39',order:[]},
 activeTurns:[{opportunityId:'alpha',memberId:'a',discussionId:'d',startedAt:1,floor:true,released:false,activity:data.initial.alpha},{opportunityId:'beta',memberId:'b',discussionId:'d',startedAt:1,floor:false,released:true,releasedReason:'approval',activity:data.initial.beta}],queuedMemberIds:[],internalSessionKeys:[],pendingInteractions:[{opportunityId:'beta',memberId:'b',status:'pending',occurredAt:1,context:{command:'echo verified',cwd:'/work'},request:{version:1,requestId:'approval',runId:'run-beta',kind:'runtime_approval',title:'Approval',message:'Allow fixture command',fields:[],approvalChoices:['once','deny'],approvalDetails:{kind:'command',toolName:'exec_command',command:'echo verified',cwd:'/work'},expiresAt:null}}]};
state.fetch=async(url:any,init:any={})=>{
 const pathname=String(url);
 if(init.method&&init.method!=='GET'){
   writes++;if(!pathname.includes('/interactions/respond'))throw Error('unexpected fixture write '+url);
   const input=JSON.parse(init.body);responses.push(input);await pause(30);
   if(input.requestId==='approval'&&responses.filter(item=>item.requestId==='approval').length===1)
     return new Response(JSON.stringify({error:'Fixture response temporarily unavailable'}),{status:503});
   view.pendingInteractions=view.pendingInteractions.map((item:any)=>item.request.requestId===input.requestId?{...item,status:'responded'}:item);
   return new Response(JSON.stringify(view));
 }
 reads++;const result=pathname.includes('/detail')?view:pathname.includes('/messages')?{messages:history,hasMore:false}:{};
 return new Response(JSON.stringify(result));
};
await i18n.changeLanguage(language);document.documentElement.setAttribute('data-theme',theme);
createRoot(document.getElementById('root')!).render(<UiProvider><GroupChatPanel groupId='g' onArchived={()=>{}}/></UiProvider>);
const timeline=()=>document.querySelector('[data-group-timeline]')as HTMLElement;
const activity=(id:string)=>timeline()?.querySelector('[data-group-activity="'+id+'"]')as HTMLElement;
const interaction=(id:string)=>timeline()?.querySelector('[data-group-interaction="'+id+'"]')as HTMLElement;
const rect=(element:Element)=>element.getBoundingClientRect();
const toBottom=async()=>{const list=timeline();list.scrollTop=list.scrollHeight;list.dispatchEvent(new Event('scroll',{bubbles:true}));await pause()};
const reveal=async(element:Element)=>{element.scrollIntoView({block:'end',inline:'nearest'});await pause();const box=rect(element),list=rect(timeline());
 equal(box.bottom<=list.bottom+1&&box.top>=list.top-1,true,'control is reachable in the message stream')};
const checkLayout=()=>{
 const list=timeline(),composer=document.querySelector('[data-chat-composer]')!,listRect=rect(list);
 equal(list.scrollHeight>list.clientHeight,true,'long history scrolls in the message viewport');
 equal(list.clientHeight>=96,true,'message stream retains reading space');
 equal(composer.previousElementSibling===list,true,'no activity or status dock between messages and composer');
 equal(listRect.bottom<=rect(composer).top+1,true,'message stream does not overlap composer');
 equal(rect(composer).bottom<=innerHeight+1,true,'composer stays inside the window');
 equal(document.documentElement.scrollWidth<=innerWidth+1,true,'no horizontal overflow');
 const rows=Array.from(list.querySelectorAll('[data-group-execution],[data-group-interaction]'));
 for(const row of rows){const bubble=row.querySelector('.chat-bubble')!;
   equal(Boolean(bubble),true,'live entry uses an assistant message bubble');
   equal(Boolean(bubble.querySelector('[class*=author]')),true,'member name is inside the bubble');
   equal(getComputedStyle(row).overflowY,'visible','live entry has no separate scroll dock');
 }
 for(let index=1;index<rows.length;index++)equal(rect(rows[index-1]).bottom<=rect(rows[index]).top+1,true,'message cards do not overlap');
 return{timelineHeight:listRect.height,historyMessages:list.querySelectorAll('[data-seq]').length,liveBubbles:rows.length};
};
state.runActivityFixture=async()=>{
 await wait(()=>activity('alpha')&&timeline().querySelectorAll('[data-seq]').length===40,'history and activities share the message stream');
 const user=timeline().querySelector('[data-seq="40"]')!;
 const quote=Array.from(user.querySelectorAll('button')).find(button=>button.textContent===i18n.t('groupChat.reply.action'))!;
 await reveal(quote);const quoteBox=rect(quote);
 const hit=document.elementFromPoint(quoteBox.x+quoteBox.width/2,quoteBox.y+quoteBox.height/2);
 equal(hit===quote||quote.contains(hit),true,'the original user quote button still receives pointer input');
 equal(timeline().querySelectorAll('[data-group-activity]').length,2,'two separate execution states inside the stream');
 equal(document.querySelectorAll('[data-card-interactive]').length,1,'one approval card');
 equal(Boolean(interaction('approval')?.querySelector('.chat-bubble .chat-prompt')),true,'approval is an inline message card');
 const turn=activity('alpha'),approval=activity('beta');
 equal(turn.getAttribute('data-activity-phase'),'tool','Alpha tool fact');equal(approval.getAttribute('data-activity-phase'),'waiting_approval','Beta approval fact');
 equal(turn.querySelector('div')?.textContent?.includes('node check.js'),false,'raw command not primary title');
 equal(document.body.textContent?.includes('activity-canary-secret'),false,'redaction survives UI');
 equal(Boolean(turn.querySelector('time')?.textContent),true,'last progress time is inside the activity bubble');
 const details=turn.querySelector('details')as HTMLDetailsElement;equal(details.open,false,'tools initially collapsed');
 details.open=true;(details.querySelector('details')as HTMLDetailsElement).open=true;
 equal(details.textContent?.includes('node check.js'),true,'explicit tool input is available');details.open=false;
 view.activeTurns[0].draft='Current streamed answer — 同一气泡里的流式正文。';emitGroupChanged('g');
 await wait(()=>turn.closest('.chat-bubble')?.querySelector('.chat-md')?.textContent?.includes('Current streamed answer'),'draft joins its activity bubble');
 equal(timeline().querySelectorAll('[data-group-execution=alpha]').length,1,'draft and activity do not create duplicate member bubbles');
 equal(approval.closest('.chat-bubble')?.textContent?.includes(i18n.t('groupChat.turn.working')),true,'a member waiting for approval has given up the floor');
 await toBottom();view.activeTurns[0].draft+='\n\n'+('More streamed text. '.repeat(80));emitGroupChanged('g');
 await wait(()=>turn.closest('.chat-bubble')?.textContent?.includes('More streamed text.'),'streaming update rendered');await pause();
 equal(timeline().scrollHeight-timeline().clientHeight-timeline().scrollTop<=2,true,'new draft follows the bottom');
 view.activeTurns[0].activity={...data.initial.alpha,eventSeq:data.initial.alpha.eventSeq+1,tool:{...data.initial.alpha.tool,
   input:{...data.initial.alpha.tool.input,title:'New tool progress — '.repeat(24)}}};emitGroupChanged('g');
 await wait(()=>turn.textContent?.includes('New tool progress'),'tool-only activity update rendered');await pause();
 equal(timeline().scrollHeight-timeline().clientHeight-timeline().scrollTop<=2,true,'tool-only update follows the bottom');
 timeline().scrollTop=0;timeline().dispatchEvent(new Event('scroll',{bubbles:true}));await pause();const readingTop=timeline().scrollTop;
 view.activeTurns[0].draft+=' Reader stays in history.';emitGroupChanged('g');
 await wait(()=>turn.closest('.chat-bubble')?.textContent?.includes('Reader stays in history.'),'new draft while reading history');await pause();
 equal(Math.abs(timeline().scrollTop-readingTop)<=1,true,'new activity does not pull the reader away from history');
 view.activeTurns[0].activity=data.initial.alpha;view.activeTurns[0].draft='Current streamed answer — 同一气泡里的流式正文。';emitGroupChanged('g');
 await wait(()=>!turn.textContent?.includes('New tool progress'),'restore short fixture activity');
 equal(getComputedStyle(document.querySelector('.chat-header__row')!).display,'flex','shared Chat skin is loaded');
 equal(getComputedStyle(document.querySelector('.chat-composer__input')!).width===getComputedStyle(document.querySelector('.chat-composer')!).width,false,'shared composer skin applied');
 equal(matchMedia('(prefers-reduced-motion: reduce)').matches,innerWidth===390,'motion preference observed');
 await reveal(turn.closest('.chat-bubble')!);const layout=checkLayout();
 state.openActivityTool=async()=>{details.open=true;(details.querySelector('details')as HTMLDetailsElement).open=true;
   await reveal(details.querySelector('pre')!);checkLayout()};
 state.showActivityApproval=async()=>{details.open=false;await reveal(interaction('approval').querySelector('button.is-primary')!);checkLayout()};
 state.showActivityInput=async()=>{
   await toBottom();view.activeTurns[0]={...view.activeTurns[0],floor:false,released:true,releasedReason:'approval',
     activity:{...data.initial.alpha,phase:'waiting_input',eventSeq:data.initial.alpha.eventSeq+1}};
   view.pendingInteractions.push({opportunityId:'alpha',memberId:'a',status:'pending',occurredAt:2,context:null,
     request:{version:1,requestId:'clarification',runId:'run-alpha',kind:'user_input',title:'Clarify the report',message:'Which scope should the report cover?',
       fields:[{id:'scope',type:'text',label:'Report scope',description:'',required:true,secret:false,options:[]}],approvalChoices:[],expiresAt:null}});
   emitGroupChanged('g');await wait(()=>interaction('clarification')?.querySelector('input'),'input card appears in the message stream');await pause();
   equal(timeline().scrollHeight-timeline().clientHeight-timeline().scrollTop<=2,true,'new input card follows the bottom');
   const input=interaction('clarification').querySelector('input')as HTMLInputElement;
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'Public sources only');input.dispatchEvent(new Event('input',{bubbles:true}));await pause();
   view.activeTurns[0].activity={...data.initial.alpha,eventSeq:data.initial.alpha.eventSeq+2};emitGroupChanged('g');await pause(100);
   equal((interaction('clarification').querySelector('input')as HTMLInputElement).value,'Public sources only','activity refresh preserves the input draft');
   await reveal(interaction('clarification').querySelector('button.is-primary')!);checkLayout();equal(writes,0,'viewing and editing cards has no API writes');
 };
 state.respondToActivityCards=async()=>{
   const allow=interaction('approval').querySelector('button.is-primary')as HTMLButtonElement;await reveal(allow);
   const box=rect(allow),hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);equal(hit===allow||allow.contains(hit),true,'approval button is not covered');
   allow.click();await wait(()=>responses.length===1,'first approval response');await pause(80);
   equal(Boolean(interaction('approval').querySelector('button.is-primary')),true,'failed response leaves the approval card actionable');
   equal(allow.disabled,false,'failed response can be retried');allow.click();
   await wait(()=>responses.length===2&&!interaction('approval').querySelector('button'),'approval response accepted');
   equal(responses[0].operationId,responses[1].operationId,'approval retry keeps its operation id');
   equal(responses[1].target,{kind:'turn',opportunityId:'beta'},'approval responds to the original turn');equal(responses[1].response,{choice:'once'},'approval choice preserved');
   equal(responses[1].requestId,'approval','approval request id preserved');
   const submit=interaction('clarification').querySelector('button.is-primary')as HTMLButtonElement;await reveal(submit);submit.click();
   await wait(()=>responses.length===3&&!interaction('clarification').querySelector('input'),'input response accepted');
   equal(responses[2].target,{kind:'turn',opportunityId:'alpha'},'input responds to the original turn');
   equal(responses[2].requestId,'clarification','input request id preserved');equal(responses[2].response,{action:'submit',answers:{scope:'Public sources only'}},'typed answer preserved');
   equal(writes,3,'only the deliberate fixture responses write');return{responses:writes,approvalRetryDeduplicated:true,inputDraftPreserved:true};
 };
 state.showSingleActivity=async()=>{
   view.activeTurns=[{opportunityId:'alpha',memberId:'a',discussionId:'d',startedAt:1,floor:true,released:false,activity:data.initial.alpha}];
   view.pendingInteractions=[];emitGroupChanged('g');
   await wait(()=>timeline().querySelectorAll('[data-group-execution]').length===1&&activity('alpha')?.querySelector('summary'),'single remaining execution');
   await reveal(activity('alpha').closest('.chat-bubble')!);return{...checkLayout(),height:innerHeight};
 };
 state.snapshot={language,theme,...layout,executions:2,toolTitle:turn.querySelector('div')?.textContent,approval:approval.getAttribute('data-activity-phase'),
   reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,writes,followedDraft:true,followedTools:true,preservedHistoryScroll:true};return state.snapshot;
};
state.runActivityTerminal=async()=>{
 view.activeTurns[0].activity=data.completed;emitGroupChanged('g');await wait(()=>activity('alpha')?.getAttribute('data-activity-phase')==='completed','terminal rendering');
 equal(activity('alpha').textContent?.includes('0ms'),true,'zero-duration completed tool result remains visible in details');
 const before=activity('alpha').querySelector('time')?.textContent;view.activeTurns[0].activity=data.late;emitGroupChanged('g');await pause(220);
 equal(activity('alpha').getAttribute('data-activity-phase'),'completed','late tool progress does not revive');equal(activity('alpha').querySelector('time')?.textContent,before,'late progress does not invent progress time');
 view.activeTurns[0].activity={...data.initial.alpha,memberId:'wrong'};emitGroupChanged('g');await wait(()=>activity('alpha')?.getAttribute('data-activity-phase')==='running','mismatched binding fallback');
 equal(activity('alpha').textContent?.includes('node check.js'),false,'wrong execution details rejected');
 view.activeTurns[0]={opportunityId:'next-alpha',memberId:'a',startedAt:2,floor:true,released:false,activity:data.initial.alpha};emitGroupChanged('g');
 await wait(()=>activity('next-alpha')&&!activity('alpha'),'next execution replaces the old bubble');
 equal(activity('next-alpha').getAttribute('data-activity-phase'),'running','old execution activity is not borrowed by the next turn');
 equal(activity('next-alpha').querySelector('details'),null,'next turn has no previous tool details');return{language,theme,reads,writes,passed:true};
};
state.runActivityCompaction=async()=>{
 view.activeTurns[0].activity=data.compacting;emitGroupChanged('g');
 await wait(()=>activity('alpha')?.getAttribute('data-activity-phase')==='compacting','explicit compaction start renders');
 equal(activity('beta').getAttribute('data-activity-phase'),'waiting_approval','other execution stays in approval');
 equal(activity('alpha').textContent.includes('private-status-canary'),false,'raw status text is not disclosed');
 const receipt=activity('alpha').querySelector('[data-group-compaction]')as HTMLDetailsElement;
 equal(receipt.open,false,'compaction receipt starts collapsed');receipt.open=true;
 equal(receipt.textContent.includes(i18n.t('groupChat.activity.phase.compacting')),true,'localized compaction start');
 await reveal(receipt);checkLayout();
};
state.finishActivityCompaction=async()=>{
 view.activeTurns[0].activity=data.compacted;emitGroupChanged('g');
 await wait(()=>activity('alpha')?.getAttribute('data-activity-phase')==='compacted','explicit compaction completion renders');
 equal(activity('alpha').textContent.includes(i18n.t('groupChat.activity.phase.compacted')),true,'localized compaction completion');
 view.activeTurns[0].activity={...data.compacted,phase:'tool',tool:{...data.initial.alpha.tool,name:'call_mcp_tool',input:{server:'shoggoth',tool_name:'read_file',arguments:{path:'/work/source.txt'}}}};emitGroupChanged('g');
 await wait(()=>activity('alpha')?.getAttribute('data-activity-phase')==='tool','subsequent tool resumes');
 equal(activity('alpha').querySelector('div')?.textContent?.includes('call_mcp_tool'),false,'wrapper title uses existing underlying tool normalization');
 equal(activity('alpha').querySelector('[data-group-compaction]')?.getAttribute('data-group-compaction'),'compacted','completion receipt survives resumed tools');
 view.activeTurns[0].activity=data.initial.alpha;emitGroupChanged('g');
 await wait(()=>!activity('alpha').querySelector('[data-group-compaction]'),'restore fixture for other UI actions');
 return{compactionStart:true,compactionCompletion:true,compactionReceipt:true,wrapperTitlePreserved:true};
};
state.settleActivity=async()=>{
 await toBottom();history.push({id:'final-alpha',groupId:'g',seq:41,threadId:'main',author:{kind:'member',memberId:'a'},
   body:'Final saved answer',mentions:{memberIds:[],broadcast:false,unresolved:[]},createdAt:Date.now()});
 view.group.lastSeq=41;view.activeTurns=[];view.round=null;emitGroupChanged('g');
 await wait(()=>timeline().querySelector('[data-seq="41"]')&&!timeline().querySelector('[data-group-execution]'),'final answer replaces the live bubble');
 equal(timeline().querySelectorAll('[data-seq="41"]').length,1,'final message appears once');
 equal(timeline().textContent?.includes('Current streamed answer'),false,'streaming draft does not survive settlement');
 equal(document.documentElement.scrollWidth<=innerWidth+1,true,'the final answer fits narrow windows');
 timeline().querySelector('[data-seq="41"]')!.scrollIntoView({block:'center'});await pause();
 await wait(()=>!document.body.textContent?.includes('Fixture response temporarily unavailable'),'previous fixture error notice expires');
 await pause(80); // Give the compositor a frame after the notice is removed before capture.
 equal(writes,3,'settlement does not send additional responses');return{settled:true};
};`;
try{
  await build({stdin:{contents:fixture.replace("FIXTUREDATA",JSON.stringify({initial,compacting,compacted,completed,late})),loader:"tsx",resolveDir:root},bundle:true,format:"esm",jsx:"automatic",nodePaths:[path.join(root,"app/manage-ui/node_modules")],loader:{".woff2":"dataurl",".svg":"dataurl",".webp":"dataurl"},define:{"process.env.NODE_ENV":'"production"'},outfile:path.join(temp,"fixture.js"),logLevel:"silent"});
  fs.writeFileSync(path.join(temp,"index.html"),'<link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;height:100%;min-height:0}#root{display:flex;flex-direction:column}</style><div id="root" class="chat-shell"></div><script type="module" src="fixture.js"></script>');if(output)fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(path.join(temp,"main.cjs"),`const{app,BrowserWindow}=require('electron'),fs=require('node:fs');app.setPath('userData',${JSON.stringify(path.join(temp,"profile"))});app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});w.webContents.on('console-message',(_event,_level,message)=>console.log(message));let ok=false;try{await w.loadURL('about:blank');w.webContents.debugger.attach('1.3');const results=[];for(const width of[1200,390])for(const language of['zh-CN','en'])for(const theme of['light','dark']){w.setSize(width,850);await w.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:width===390?'reduce':'no-preference'}]});await w.loadFile(${JSON.stringify(path.join(temp,"index.html"))},{query:{language,theme}});const result=await w.webContents.executeJavaScript('window.runActivityFixture()');result.width=width;results.push(result);if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+'/activity-'+width+'-'+language+'-'+theme+'.png',(await w.webContents.capturePage()).toPNG());await w.webContents.executeJavaScript('window.runActivityCompaction()');if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+'/compaction-'+width+'-'+language+'-'+theme+'.png',(await w.webContents.capturePage()).toPNG());Object.assign(result,await w.webContents.executeJavaScript('window.finishActivityCompaction()'));await w.webContents.executeJavaScript('window.openActivityTool()');if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+'/tools-'+width+'-'+language+'-'+theme+'.png',(await w.webContents.capturePage()).toPNG());await w.webContents.executeJavaScript('window.showActivityApproval()');if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+'/approval-'+width+'-'+language+'-'+theme+'.png',(await w.webContents.capturePage()).toPNG());await w.webContents.executeJavaScript('window.showActivityInput()');if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+'/input-'+width+'-'+language+'-'+theme+'.png',(await w.webContents.capturePage()).toPNG());Object.assign(result,await w.webContents.executeJavaScript('window.respondToActivityCards()'));Object.assign(result,await w.webContents.executeJavaScript('window.runActivityTerminal()'));w.setSize(width,width===390?760:600);result.shortWindow=await w.webContents.executeJavaScript('window.showSingleActivity()');if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+'/single-'+width+'-'+language+'-'+theme+'.png',(await w.webContents.capturePage()).toPNG());Object.assign(result,await w.webContents.executeJavaScript('window.settleActivity()'));w.setSize(width,950);await w.webContents.executeJavaScript("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{const list=document.querySelector('[data-group-timeline]');list.scrollTop=list.scrollHeight;resolve()})))");if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+'/public-process-'+width+'-'+language+'-'+theme+'.png',(await w.webContents.capturePage()).toPNG());console.log(JSON.stringify(result))}if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+'/results.json',JSON.stringify(results,null,2));ok=true}catch(error){console.error(error.stack||error);if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+'/failed.png',(await w.webContents.capturePage()).toPNG())}finally{w.destroy();app.exit(ok?0:1)}});`);
  const child=spawn(require("electron"),[path.join(temp,"main.cjs")],{env:{...process.env,ELECTRON_DISABLE_SECURITY_WARNINGS:"true"},stdio:["ignore","pipe","pipe"]});child.stdout.on("data",data=>process.stdout.write(data));child.stderr.on("data",data=>process.stderr.write(data));const timer=setTimeout(()=>child.kill("SIGTERM"),60000);
  const status=await new Promise((resolve,reject)=>{child.once("exit",resolve);child.once("error",reject)});clearTimeout(timer);assert.equal(status,0,"group activity actual UI acceptance failed");
}finally{fs.rmSync(temp,{recursive:true,force:true})}
