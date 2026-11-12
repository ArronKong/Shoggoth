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
const at=Date.now()-4000,binding=(member,opportunity)=>({groupId:"g",discussionId:"d",memberId:member,opportunityId:opportunity,taskId:null,attemptId:null,runId:`run-${opportunity}`,executionGeneration:"execution-1"});
const alpha=new GroupActivityProjection(binding("a","alpha")),beta=new GroupActivityProjection(binding("b","beta"));
const alphaEvent=(seq,type,createdAt,payload)=>({seq,type,runId:"run-alpha",createdAt,payload});
alpha.observeEvents([
  alphaEvent(1,"tool.start",at,{toolCallId:"read-missing",tool:{name:"read_file",input:{path:"missing.md"}}}),
  alphaEvent(2,"tool.result",at+2900,{toolCallId:"read-missing",tool:{error:"Fixture file missing",durationMs:2900}}),
  alphaEvent(3,"tool.start",at+2900,{toolCallId:"read-existing",tool:{name:"read_file",input:{path:"existing.md"}}}),
  alphaEvent(4,"tool.result",at+3000,{toolCallId:"read-existing",tool:{output:"Fixture file",durationMs:100}}),
  alphaEvent(5,"tool.start",at+3000,{toolCallId:"command",tool:{name:"exec_command",arguments:{command:"node check.js",title:"Verify collaboration",apiKey:"activity-canary-secret"}}}),
],"stream-a");
beta.observeStatus("waiting_approval");
const initial={alpha:alpha.snapshot(),beta:beta.snapshot()};
const retryProjection=new GroupActivityProjection(binding("a","alpha"),{now:()=>at});
retryProjection.observeEvents([{seq:1,type:"status",runId:"run-alpha",payload:{status:"retrying",reason:"RUNTIME_UPSTREAM_UNAVAILABLE",message:"private-retry-canary"}}],"stream-retry");
const retrying=retryProjection.snapshot();
alpha.observeEvents([alphaEvent(6,"status",at+3001,{status:"compacting",text:"private-status-canary"})],"stream-a");const compacting=alpha.snapshot();
alpha.observeEvents([alphaEvent(7,"status",at+3002,{status:"compacted"})],"stream-a");const compacted=alpha.snapshot();
alpha.observeEvents([alphaEvent(8,"tool.result",at+3003,{toolCallId:"command",tool:{name:"exec_command",output:"Fixture checks passed",durationMs:0}})],"stream-a");
const toolCompleted=alpha.snapshot();alpha.observeStatus("completed",{at:at+3004});
const completed=alpha.snapshot();alpha.observeEvents([alphaEvent(9,"tool.update",at+3005,{toolCallId:"command",delta:"late output"}),alphaEvent(10,"status",at+3006,{status:"compacting"})],"stream-a");const late=alpha.snapshot();
const fixture=String.raw`
import React from"react";import{createRoot}from"react-dom/client";import GroupChatPanel from"./app/manage-ui/src/pages/GroupChatPanel";
import{UiProvider}from"./app/manage-ui/src/components/ui";import{emitGroupChanged}from"./app/manage-ui/src/lib/groupChat";import i18n from"./app/manage-ui/src/i18n";
import"./app/manage-ui/src/styles.css";import"./app/manage-ui/src/manage-skin.css";import"./app/manage-ui/src/pages/ChatPage.css";
const state=window as any,options=new URLSearchParams(location.search),language=options.get('language')||'zh-CN',theme=options.get('theme')||'light',data=FIXTUREDATA;
const pause=(ms=20)=>new Promise(resolve=>setTimeout(resolve,ms)),equal=(a:any,b:any,label:string)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw Error(label+': '+JSON.stringify(a)+' != '+JSON.stringify(b))};
window.addEventListener('error',event=>state.fixtureError=event.error?.stack||event.message);window.addEventListener('unhandledrejection',event=>state.fixtureError=String(event.reason));
const wait=async(check:()=>unknown,label:string)=>{const until=Date.now()+6000;while(!check()){if(state.fixtureError)throw Error(state.fixtureError);if(Date.now()>until)throw Error(label);await pause()}};
let writes=0,reads=0,activityReads=0,savedActivityResponse:'ready'|'error'|'empty'|'legacy'='ready';const responses:any[]=[];
// History, live execution bubbles and interaction cards share the same scroll viewport.
const history=Array.from({length:40},(_,index)=>({id:'history-'+index,groupId:'g',seq:index+1,threadId:'main',author:{kind:'member',memberId:'a'},
 body:('Saved group response '+index+' — 已保存的群聊消息。\n\n').repeat(10),mentions:{memberIds:[],broadcast:false,unresolved:[]},createdAt:Date.now()-1000*(40-index)}));
history[39]={...history[39],author:{kind:'user'}};
const member=(id:string,name:string)=>({id,groupId:'g',backendId:'shoggoth',agentId:id,displayName:name,handle:id,state:'active',position:0,joinedSeq:0,leftSeq:null});
let view:any={ownerScope:'fixture-owner',group:{id:'g',name:'Collaboration group',status:'active',purpose:'',createdAt:1,updatedAt:1,metadataRevision:1,rosterRevision:1,directoryRevision:1,controlEpoch:0,lastSeq:history.length,ownerMemberId:'a'},members:[member('a','Alpha'),member('b','Beta')],
 currentOwnerId:'a',round:{id:'d',causeMessageId:'history-39',order:[]},
 activeTurns:[{opportunityId:'alpha',memberId:'a',discussionId:'d',startedAt:data.initial.alpha.recentTools[0].startedAt,floor:true,released:false,activity:null},{opportunityId:'beta',memberId:'b',discussionId:'d',startedAt:1,floor:false,released:true,releasedReason:'approval',activity:data.initial.beta}],queuedMemberIds:[],internalSessionKeys:[],pendingInteractions:[{opportunityId:'beta',memberId:'b',status:'pending',occurredAt:1,context:{command:'echo verified',cwd:'/work'},request:{version:1,requestId:'approval',runId:'run-beta',kind:'runtime_approval',title:'Approval',message:'Allow fixture command',fields:[],approvalChoices:['once','deny'],approvalDetails:{kind:'command',toolName:'exec_command',command:'echo verified',cwd:'/work'},expiresAt:null}}]};
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
 reads++;
 const params=new URL(pathname,location.href).searchParams;
 if(params.get('part')==='activity'){
   activityReads++;
   equal(Object.fromEntries(params),{id:'g',seq:'41',part:'activity',ownerScope:'fixture-owner',messageId:'final-alpha'},'only the selected saved message is read');
   if(savedActivityResponse==='error')return new Response('{}',{status:503});
   if(savedActivityResponse==='legacy')return new Response(JSON.stringify({page:{offset:0,nextOffset:null,totalBytes:12,digest:'0'.repeat(64),text:'Legacy reply'}}));
   return new Response(JSON.stringify({activity:savedActivityResponse==='empty'?null:data.completed,
     startedAt:data.initial.alpha.recentTools[0].startedAt,finishedAt:data.completed.lastProgressAt}));
 }
 const result=pathname.includes('/detail')?view:pathname.includes('/messages')?{messages:history,hasMore:false}:{};
 return new Response(JSON.stringify(result));
};
await i18n.changeLanguage(language);document.documentElement.setAttribute('data-theme',theme);
createRoot(document.getElementById('root')!).render(<UiProvider><GroupChatPanel groupId='g' onArchived={()=>{}}/></UiProvider>);
const timeline=()=>document.querySelector('[data-group-timeline]')as HTMLElement;
const activity=(id:string)=>timeline()?.querySelector('[data-group-execution="'+id+'"] .chat-bubble')as HTMLElement;
const preview=(id:string)=>activity(id)?.querySelector<HTMLElement>('[data-chat-activity-preview]');
const activityDialog=()=>document.querySelector<HTMLElement>('[role="dialog"][data-modal-variant="activity"]');
const interaction=(id:string)=>timeline()?.querySelector('[data-group-interaction="'+id+'"]')as HTMLElement;
const rect=(element:Element)=>element.getBoundingClientRect();
const toBottom=async()=>{const list=timeline();list.scrollTop=list.scrollHeight;list.dispatchEvent(new Event('scroll',{bubbles:true}));await pause()};
const reveal=async(element:Element)=>{
 const isVisible=()=>{const box=rect(element),header=rect(document.querySelector('.chat-header')!),composer=rect(document.querySelector('[data-chat-composer]')!);
   return box.bottom<=composer.top&&box.top>=header.bottom&&box.height>0;};
 let visibleSince=0;
 await wait(()=>{
   if(isVisible()){visibleSince ||= performance.now();return performance.now()-visibleSince>=32}
   visibleSince=0;element.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});return false;
 },'control is reachable between the header and composer: '+element.textContent?.trim().slice(0,100));
};
const checkLayout=()=>{
 const list=timeline(),composer=document.querySelector('[data-chat-composer]')!,listRect=rect(list);
 equal(list.scrollHeight>list.clientHeight,true,'long history scrolls in the message viewport');
 equal(list.clientHeight>=96,true,'message stream retains reading space');
 equal(composer.closest('.chat-botdock')?.previousElementSibling===list,true,'activity stays within the shared message stream');
 equal(rect(composer).bottom<=innerHeight+1,true,'composer stays inside the window');
 equal(document.documentElement.scrollWidth<=innerWidth+1,true,'no horizontal overflow');
 const rows=Array.from(list.querySelectorAll('[data-group-execution],[data-group-interaction]'));
 for(const row of rows){const approval=row.getAttribute('data-group-interaction')==='approval';
   const bubble=row.querySelector('.chat-bubble');
   const content=approval?row.querySelector('.chat-prompt'):bubble;
   equal(Boolean(bubble),!approval,'only execution and input entries use a message bubble');
   equal(Boolean(content),true,'live entry keeps its message or actionable approval card');
   const author=row.querySelector('[data-group-author]')!;
   equal(Boolean(author?.textContent?.trim()),true,'the execution or interaction retains its member identity');
   equal(author.parentElement===content.parentElement,true,'member name and content share the same message stack');
   equal(rect(author).bottom<=rect(content).top+1,true,'member identity remains above its content');
   equal(getComputedStyle(row).overflowY,'visible','live entry has no separate scroll dock');
 }
 for(let index=1;index<rows.length;index++)equal(rect(rows[index-1]).bottom<=rect(rows[index]).top+1,true,'message cards do not overlap');
 return{timelineHeight:listRect.height,historyMessages:list.querySelectorAll('[data-seq]').length,liveBubbles:rows.length};
};
state.runActivityFixture=async()=>{
 await wait(()=>activity('alpha')&&timeline().querySelectorAll('[data-seq]').length===40,'history and activities share the message stream');
 const user=timeline().querySelector('[data-seq="40"]')!;
 // Quoting now lives in the message context menu; the old inline shortcut is intentionally hidden.
 const userText=user.querySelector('.chat-md p:last-child')!;await reveal(userText);const userBox=rect(userText);
 const pointer={clientX:userBox.x+userBox.width/2,clientY:userBox.y+userBox.height/2};
 const messageHit=document.elementFromPoint(pointer.clientX,pointer.clientY);
 equal(messageHit===userText||userText.contains(messageHit),true,'the user message receives context-menu pointer input');
 userText.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,...pointer}));
 await wait(()=>document.querySelector('[data-message-menu]'),'the message context menu opens');
 const quote=Array.from(document.querySelectorAll<HTMLButtonElement>('[data-message-menu] [role=menuitem]'))
   .find(button=>button.textContent===i18n.t('chat.quote'))!;
 // Message history can render before the local draft journal finishes opening.
 await wait(()=>!quote.disabled,'the local draft journal enables quoting');
 const quoteBox=rect(quote),hit=document.elementFromPoint(quoteBox.x+quoteBox.width/2,quoteBox.y+quoteBox.height/2);
 equal(quote.disabled,false,'the context-menu quote action is enabled');
 equal(quoteBox.width>0&&quoteBox.height>0&&quoteBox.top>=0&&quoteBox.bottom<=innerHeight,true,'quote control is reachable inside the window');
 equal(hit===quote||quote.contains(hit),true,'the quote action still receives pointer input');
 quote.click();await wait(()=>document.querySelector('.chat-quote-bar')?.textContent?.includes('Saved group response 39'),'quoting selects the original user message');
 equal(Boolean(document.querySelector('[data-message-menu]')),false,'selection closes the message context menu');
 (document.querySelector('.chat-quote-bar__x')as HTMLButtonElement).click();
 await wait(()=>!document.querySelector('.chat-quote-bar'),'canceling the quote restores the composer');
 equal(Boolean(preview('alpha')),false,'no activity preview before an observed step');
 equal(timeline().querySelectorAll('[data-group-execution]').length,1,'approval uses its interaction card without a duplicate loader');
 equal(document.querySelectorAll('[data-card-interactive]').length,1,'one approval card');
 equal(Boolean(interaction('approval')?.querySelector('.chat-bubble')),false,'approval has no enclosing message bubble');
 equal(Boolean(interaction('approval')?.querySelector('.chat-prompt')),true,'approval stays actionable in the message stream');
 equal(Boolean(interaction('approval')?.querySelector('p')),false,'pending approval omits the extra waiting line');
 let turn=activity('alpha');const approval=interaction('approval');
 const waitingBubble=turn;
 equal(Boolean(approval.querySelector('.chat-prompt')),true,'Beta approval remains actionable');
 const balls=turn.querySelectorAll('[role="status"] svg circle');
 equal(balls.length,2,'waiting reply uses the shared two-ball loader');
 equal(getComputedStyle(balls[0].parentElement!).animationName==='none',innerWidth===390,'the shared loader honors reduced motion');
 view.activeTurns[0].activity=data.initial.alpha;emitGroupChanged('g');
 await wait(()=>preview('alpha')?.textContent?.includes('Verify collaboration'),'the first observed tools expand the waiting bubble');
 turn=activity('alpha');
 equal(turn.classList.contains('is-activity-loading'),true,'group activity uses the direct-chat bubble style');
 equal(turn.getAttribute('data-activity-phase'),'tool','Alpha tool facts stay bound to its reply');
 equal(preview('alpha')?.querySelectorAll('li').length,3,'the current tool and recent tools deduplicate by call ID');
 equal(preview('alpha')?.querySelector('[data-st="error"]')?.textContent,i18n.t('turnLab.failed'),'failed tool has the shared failure badge');
 equal(preview('alpha')?.querySelector('[data-st="ok"]')?.textContent,i18n.t('turnLab.done'),'completed tool has the shared completion badge');
 equal(preview('alpha')?.querySelector('[data-st="running"]')?.textContent,i18n.t('turnLab.running'),'active tool has the shared running badge');
 equal(['2.9s','0.1s'].every(duration=>turn.textContent?.includes(duration)),true,'observed durations use the shared formatting');
 equal(turn.textContent?.includes('node check.js'),false,'raw command stays inside tool details');
 equal(document.body.textContent?.includes('activity-canary-secret'),false,'redaction survives UI');
 equal(turn===waitingBubble&&turn.querySelector('[role="status"] svg circle')===balls[0],true,'the same bubble and loader stay mounted through expansion');
 await wait(()=>!turn.getAnimations().length,'the group bubble finishes expanding');
 equal(Math.round(rect(turn.querySelector('[role="status"] svg')!).top-rect(turn).top),14,'the group loader uses the approved top inset');
 equal(timeline().querySelectorAll('[data-group-stop-turn],button.chat-stop').length,0,'the timeline has no Stop action');
 equal(document.querySelectorAll('[data-chat-composer] button.chat-stop:not(:disabled)').length,1,'the composer offers one group Stop action');
 view.activeTurns[0].draft='Current streamed answer — 同一气泡里的流式正文。';emitGroupChanged('g');
 await wait(()=>activity('alpha')?.querySelector('.chat-md')?.textContent?.includes('Current streamed answer'),'draft replaces the loading bubble');
 turn=activity('alpha');
 equal(Boolean(turn.querySelector('[role="status"] svg')),false,'the two-ball loader stops when the member starts streaming an answer');
 equal(timeline().querySelectorAll('[data-group-execution=alpha]').length,1,'draft and activity do not create duplicate member bubbles');
 equal(Boolean(activity('beta')),false,'approval does not add a second member execution bubble');
 await toBottom();view.activeTurns[0].draft+='\n\n'+('More streamed text. '.repeat(80));emitGroupChanged('g');
 await wait(()=>turn.closest('.chat-bubble')?.textContent?.includes('More streamed text.'),'streaming update rendered');await pause();
 equal(timeline().scrollHeight-timeline().clientHeight-timeline().scrollTop<=2,true,'new draft follows the bottom');
 const beforeToolReads=reads;view.activeTurns[0].activity={...data.initial.alpha,eventSeq:data.initial.alpha.eventSeq+1,tool:{...data.initial.alpha.tool,
   input:{...data.initial.alpha.tool.input,title:'New tool progress — '.repeat(24)}}};emitGroupChanged('g');
 await wait(()=>reads>beforeToolReads,'tool-only activity update received');await pause();
 equal(Boolean(preview('alpha')),false,'a streamed reply has no duplicate activity preview');
 equal(timeline().scrollHeight-timeline().clientHeight-timeline().scrollTop<=2,true,'tool-only update follows the bottom');
 timeline().scrollTop=0;timeline().dispatchEvent(new Event('scroll',{bubbles:true}));await pause();const readingTop=timeline().scrollTop;
 view.activeTurns[0].draft+=' Reader stays in history.';emitGroupChanged('g');
 await wait(()=>turn.closest('.chat-bubble')?.textContent?.includes('Reader stays in history.'),'new draft while reading history');await pause();
 equal(Math.abs(timeline().scrollTop-readingTop)<=1,true,'new activity does not pull the reader away from history');
 view.activeTurns[0].activity=data.initial.alpha;view.activeTurns[0].draft='Current streamed answer — 同一气泡里的流式正文。';emitGroupChanged('g');
 await wait(()=>activity('alpha')?.textContent?.trim()==='Current streamed answer — 同一气泡里的流式正文。','restore short fixture activity');
 turn=activity('alpha');
 equal(getComputedStyle(document.querySelector('.chat-header__row')!).display,'flex','shared Chat skin is loaded');
 equal(getComputedStyle(document.querySelector('.chat-composer__input')!).width===getComputedStyle(document.querySelector('.chat-composer')!).width,false,'shared composer skin applied');
 equal(matchMedia('(prefers-reduced-motion: reduce)').matches,innerWidth===390,'motion preference observed');
 await reveal(turn.closest('.chat-bubble')!);
 view.activeTurns[0].draft=null;emitGroupChanged('g');
 await wait(()=>preview('alpha')?.textContent?.includes('Verify collaboration'),'restore the tool preview');
 await toBottom();await reveal(activity('alpha'));const layout=checkLayout();
 state.openActivityTool=async()=>{
   const trigger=preview('alpha')!;await reveal(trigger);
   const box=rect(trigger),hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);
   equal(hit===trigger||trigger.contains(hit),true,'the activity preview can receive pointer input');
   trigger.focus();
   trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
   await wait(activityDialog,'keyboard opens the shared activity dialog');
   const dialog=activityDialog()!;
   equal(dialog.textContent?.includes(i18n.t('turnLab.processLabel')+' · Alpha'),true,'details name the selected member');
   const toolHead=[...dialog.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')]
     .find(row=>row.textContent?.includes('Verify collaboration'))!;
   toolHead.click();await wait(()=>dialog.querySelector('pre')?.textContent?.includes('node check.js'),'tool details expand inside the dialog');
   equal(dialog.textContent?.includes('activity-canary-secret'),false,'expanded tool arguments remain redacted');
   view.activeTurns[0].activity=data.toolCompleted;emitGroupChanged('g');
   await wait(()=>toolHead.textContent?.includes('0.0s')&&dialog.textContent?.includes('Fixture checks passed'),'the open dialog updates the same tool row and its duration');
   equal(toolHead.getAttribute('aria-expanded'),'true','live updates preserve expanded tool details');
   equal(preview('alpha')?.textContent?.includes('0.0s'),true,'the message preview receives the same result');
   equal(preview('alpha')!.scrollHeight>preview('alpha')!.clientHeight,true,'the preview remains limited to three visible rows');
   dialog.querySelector<HTMLButtonElement>('button[aria-label="'+i18n.t('common.close')+'"]')!.click();
   await wait(()=>!activityDialog(),'closing the dialog restores the thread');
 };
 state.showActivityApproval=async()=>{
   await reveal(interaction('approval').querySelector('button.is-primary')!);checkLayout()};
 state.showActivityInput=async()=>{
   await toBottom();view.activeTurns[0]={...view.activeTurns[0],floor:false,released:true,releasedReason:'approval',
     activity:{...data.initial.alpha,phase:'waiting_input',eventSeq:data.initial.alpha.eventSeq+1}};
   view.pendingInteractions.push({opportunityId:'alpha',memberId:'a',status:'pending',occurredAt:2,context:null,
     request:{version:1,requestId:'clarification',runId:'run-alpha',kind:'user_input',title:'Clarify the report',message:'Which scope should the report cover?',
       fields:[{id:'scope',type:'text',label:'Report scope',description:'',required:true,secret:false,options:[]}],approvalChoices:[],expiresAt:null}});
   emitGroupChanged('g');await wait(()=>interaction('clarification')?.querySelector('textarea'),'input card appears in the message stream');await pause();
   equal(timeline().scrollHeight-timeline().clientHeight-timeline().scrollTop<=2,true,'new input card follows the bottom');
   const input=interaction('clarification').querySelector('textarea')as HTMLTextAreaElement;
   Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'Public sources only');input.dispatchEvent(new Event('input',{bubbles:true}));await pause();
   view.activeTurns[0].activity={...data.initial.alpha,eventSeq:data.initial.alpha.eventSeq+2};emitGroupChanged('g');await pause(100);
   equal((interaction('clarification').querySelector('textarea')as HTMLTextAreaElement).value,'Public sources only','activity refresh preserves the input draft');
   await reveal(interaction('clarification').querySelector('button.is-primary')!);checkLayout();equal(writes,0,'viewing and editing cards has no API writes');
 };
 state.respondToActivityCards=async()=>{
   const allow=interaction('approval').querySelector('button.is-primary')as HTMLButtonElement;await reveal(allow);
   const box=rect(allow),hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);equal(hit===allow||allow.contains(hit),true,'approval button is not covered');
   allow.click();await wait(()=>responses.length===1,'first approval response');await pause(80);
   equal(Boolean(interaction('approval').querySelector('button.is-primary')),true,'failed response leaves the approval card actionable');
   // A failed response refreshes the view, so retry the current card, not its detached old button.
   const retryAllow=interaction('approval').querySelector('button.is-primary')as HTMLButtonElement;
   await wait(()=>!retryAllow.disabled,'failed response can be retried');
   equal(retryAllow.isConnected,true,'retry targets the current approval card');await reveal(retryAllow);
   const retryBox=rect(retryAllow),retryHit=document.elementFromPoint(retryBox.x+retryBox.width/2,retryBox.y+retryBox.height/2);
   equal(retryHit===retryAllow||retryAllow.contains(retryHit),true,'approval retry is not covered');retryAllow.click();
   await wait(()=>responses.length===2&&!interaction('approval').querySelector('.chat-prompt'),'approval response accepted');
   equal(Boolean(interaction('approval').querySelector('[data-group-author]')),true,'responded card keeps its member identity');
   equal(responses[0].operationId,responses[1].operationId,'approval retry keeps its operation id');
   equal(responses[1].target,{kind:'turn',opportunityId:'beta'},'approval responds to the original turn');equal(responses[1].response,{choice:'once'},'approval choice preserved');
   equal(responses[1].requestId,'approval','approval request id preserved');
   const submit=interaction('clarification').querySelector('button.is-primary')as HTMLButtonElement;await reveal(submit);submit.click();
   await wait(()=>responses.length===3&&!interaction('clarification').querySelector('textarea'),'input response accepted');
   equal(responses[2].target,{kind:'turn',opportunityId:'alpha'},'input responds to the original turn');
   equal(responses[2].requestId,'clarification','input request id preserved');equal(responses[2].response,{action:'submit',answers:{scope:'Public sources only'}},'typed answer preserved');
   equal(writes,3,'only the deliberate fixture responses write');return{responses:writes,approvalRetryDeduplicated:true,inputDraftPreserved:true};
 };
 state.showSingleActivity=async()=>{
   view.activeTurns=[{opportunityId:'alpha',memberId:'a',discussionId:'d',startedAt:1,floor:true,released:false,activity:null}];
   view.pendingInteractions=[];emitGroupChanged('g');
   await wait(()=>timeline().querySelectorAll('[data-group-execution]').length===1&&activity('alpha')?.querySelector('[role="status"]'),'single remaining loading reply');
   await reveal(activity('alpha').closest('.chat-bubble')!);return{...checkLayout(),height:innerHeight};
 };
 state.snapshot={language,theme,...layout,executions:1,activityPreview:true,approvalVisible:true,
   reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,writes,followedDraft:true,followedTools:true,preservedHistoryScroll:true};return state.snapshot;
};
state.runActivityTerminal=async()=>{
 const betaTool={...data.initial.alpha.tool,input:{title:'Verify Beta separately'}};
 view.activeTurns[1].activity={...data.initial.alpha,memberId:'b',opportunityId:'beta',runId:'run-beta',tool:betaTool,recentTools:[betaTool]};
 emitGroupChanged('g');
 await wait(()=>preview('alpha')&&preview('beta')?.textContent?.includes('Verify Beta separately'),'parallel executions each show their own activity');
 equal(preview('alpha')?.textContent?.includes('Verify Beta separately'),false,'parallel members can reuse a tool ID without mixing steps');
 preview('alpha')!.click();await wait(activityDialog,'open the first member activity');
 equal(activityDialog()?.textContent?.includes('Verify Beta separately'),false,'the dialog only follows the chosen execution');
 view.activeTurns[0].activity=data.completed;emitGroupChanged('g');
 await wait(()=>!activity('alpha')&&!activityDialog(),'completed execution removes its preview and ends the live detail view');
 equal(Boolean(preview('beta')),true,'the other member stays live');
 view.activeTurns[0].activity=data.late;emitGroupChanged('g');await pause(220);
 equal(Boolean(activity('alpha')),false,'late tool progress does not revive the completed loading bubble');
 view.activeTurns[0].activity={...data.initial.alpha,memberId:'wrong'};emitGroupChanged('g');await wait(()=>activity('alpha')?.getAttribute('data-activity-phase')==='running','mismatched binding fallback');
 equal(Boolean(preview('alpha')),false,'wrong member details rejected');
 view.activeTurns[0]={opportunityId:'next-alpha',memberId:'a',startedAt:2,floor:true,released:false,activity:data.initial.alpha};emitGroupChanged('g');
 await wait(()=>activity('next-alpha')&&!activity('alpha'),'next execution replaces the old bubble');
 equal(activity('next-alpha').getAttribute('data-activity-phase'),'running','old execution activity is not borrowed by the next turn');
 equal(Boolean(preview('next-alpha')),false,'next turn has no previous tool details');return{language,theme,reads,writes,parallelTurnsIsolated:true};
};
state.runActivityCompaction=async()=>{
 view.activeTurns[0].activity=data.retrying;emitGroupChanged('g');
 await wait(()=>activity('alpha')?.getAttribute('data-activity-phase')==='retrying','provider retry renders as activity');
 equal(preview('alpha')?.textContent?.includes(i18n.t('chat.runWait.retrying')),true,'provider retry uses the shared wait status');
 equal(document.body.textContent.includes('private-retry-canary'),false,'provider diagnostics remain private');
 view.activeTurns[0].activity=data.compacting;emitGroupChanged('g');
 await wait(()=>activity('alpha')?.getAttribute('data-activity-phase')==='compacting','explicit compaction start renders');
 equal(Boolean(interaction('approval').querySelector('.chat-prompt')),true,'other member retains the approval controls');
 equal(activity('alpha').textContent.includes('private-status-canary'),false,'raw status text is not disclosed');
 equal(preview('alpha')?.textContent?.includes(i18n.t('chat.compactingCtx')),true,'compaction shows its localized activity');
 await reveal(activity('alpha'));checkLayout();
};
state.finishActivityCompaction=async()=>{
 view.activeTurns[0].activity=data.compacted;emitGroupChanged('g');
 await wait(()=>activity('alpha')?.getAttribute('data-activity-phase')==='compacted','explicit compaction completion renders');
 equal(preview('alpha')?.textContent?.includes(i18n.t('chat.compactedCtx')),true,'compaction completion updates the same activity');
 view.activeTurns[0].activity={...data.compacted,phase:'tool',tool:{...data.initial.alpha.tool,name:'call_mcp_tool',input:{server:'shoggoth',tool_name:'read_file',arguments:{path:'/work/source.txt'}}}};emitGroupChanged('g');
 await wait(()=>activity('alpha')?.getAttribute('data-activity-phase')==='tool','subsequent tool resumes');
 equal(activity('alpha').textContent?.includes('call_mcp_tool'),false,'tool wrapper stays out of the visible label');
 equal(preview('alpha')?.textContent?.includes(i18n.t('chat.compactedCtx')),true,'observed compaction remains visible when work resumes');
 view.activeTurns[0].activity=data.initial.alpha;emitGroupChanged('g');
 await wait(()=>preview('alpha')?.textContent?.includes('Verify collaboration'),'restore fixture for other UI actions');
 return{compactionStart:true,compactionCompletion:true,detailsRedacted:true};
};
state.settleActivity=async()=>{
 await toBottom();
 view.activeTurns[0]={...view.activeTurns[0],individualMessages:true,activity:data.initial.alpha};
 const reply={id:'final-alpha',groupId:'g',seq:41,threadId:'main',author:{kind:'member',memberId:'a'},
   body:'Streaming saved answer',mentions:{memberIds:[],broadcast:false,unresolved:[]},createdAt:Date.now(),revision:1,
   origin:{opportunityId:'alpha',runId:'run-alpha',discussionId:'d',textItemId:'text-alpha',partial:true,streaming:true}};
 const activityButton=(seq:number)=>Array.from(timeline().querySelectorAll<HTMLButtonElement>('[data-seq="'+seq+'"] [data-group-message-footer] button'))
   .find(button=>button.getAttribute('aria-label')===i18n.t('turnLab.processOpen'));
 history.push(reply);view.group.lastSeq=41;emitGroupChanged('g');
 await wait(()=>timeline().querySelector('[data-seq="41"] .chat-cursor')&&!activity('alpha'),'published streaming text replaces the activity preview');
 equal(Boolean(activityButton(41)),false,'a streaming reply has no history activity action');
 history[history.length-1]={...reply,body:'Final saved answer',revision:2,origin:{...reply.origin,partial:false,streaming:false}};
 emitGroupChanged('g');
 await wait(()=>timeline().querySelector('[data-seq="41"]')?.textContent?.includes('Final saved answer'),'streaming text settles in place');
 await wait(()=>timeline().querySelector('[data-seq="41"]')&&!timeline().querySelector('[data-group-execution]'),'final answer replaces the live bubble');
 equal(timeline().querySelectorAll('[data-seq="41"]').length,1,'final message appears once');
 equal(timeline().textContent?.includes('Current streamed answer'),false,'streaming draft does not survive settlement');
 equal(document.documentElement.scrollWidth<=innerWidth+1,true,'the final answer fits narrow windows');
 equal(Boolean(activityButton(40)),false,'a user message has no activity action');
 const button=activityButton(41);
 equal(Boolean(button),true,'the settled member reply can reopen activity from its footer');
 equal(activityReads,0,'history does not load saved activity before it is opened');
 await reveal(button!);button!.focus();
 equal(getComputedStyle(button!).opacity,'1','keyboard focus reveals the activity action');
 button!.click();
 await wait(()=>activityDialog()?.textContent?.includes('Verify collaboration'),'the saved steps open for the completed reply');
 equal(activityDialog()?.textContent?.includes(i18n.t('turnLab.processLabel')+' · Alpha'),true,'the saved activity belongs to the replying member');
 equal(Boolean(activityDialog()?.querySelector('[data-st="running"]')),false,'saved tool steps are not shown as running');
 const closeActivity=()=>activityDialog()!.querySelector<HTMLButtonElement>('button[aria-label="'+i18n.t('common.close')+'"]')!.click();
 closeActivity();
 await wait(()=>!activityDialog(),'closing saved activity restores the thread');
 if(theme==='light'&&innerWidth===1200){
   savedActivityResponse='legacy';button!.click();
   await wait(()=>activityDialog()?.querySelector('[role="status"]')?.textContent===i18n.t('groupChat.activity.updateRequired'),'a legacy text page asks for an app update');
   equal([...activityDialog()!.querySelectorAll('button')].some(item=>item.textContent===i18n.t('common.retry')),false,'an unsupported backend does not offer a retry');
   closeActivity();await wait(()=>!activityDialog(),'closing the update notice restores the thread');
 }
 if(language==='zh-CN'&&theme==='light'&&innerWidth===1200){
   savedActivityResponse='error';button!.click();
   await wait(()=>activityDialog()?.querySelector('[role="alert"]')?.textContent===i18n.t('groupChat.activity.error'),'a failed activity read is visible');
   savedActivityResponse='empty';
   [...activityDialog()!.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.textContent===i18n.t('common.retry'))!.click();
   await wait(()=>activityDialog()?.querySelector('[role="status"]')?.textContent===i18n.t('groupChat.activity.empty'),'retry can show a reply without retained steps');
   equal(Boolean(activityDialog()?.querySelector('[data-status="done"]')),false,'missing activity does not create a fake timeline');
   closeActivity();await wait(()=>!activityDialog(),'closing the empty state restores the thread');
 }
 timeline().querySelector('[data-seq="41"]')!.scrollIntoView({block:'center'});await pause();
 await wait(()=>!document.body.textContent?.includes('Fixture response temporarily unavailable'),'previous fixture error notice expires');
 await pause(80); // Give the compositor a frame after the notice is removed before capture.
 equal(writes,3,'settlement and reading saved activity do not send additional responses');return{settled:true,savedActivity:true};
};`;
try{
  await build({stdin:{contents:fixture.replace("FIXTUREDATA",JSON.stringify({initial,retrying,compacting,compacted,toolCompleted,completed,late})),loader:"tsx",resolveDir:root},bundle:true,format:"esm",jsx:"automatic",nodePaths:[path.join(root,"app/manage-ui/node_modules")],loader:{".woff2":"dataurl",".svg":"dataurl",".webp":"dataurl",".png":"dataurl"},define:{"process.env.NODE_ENV":'"production"'},outfile:path.join(temp,"fixture.js"),logLevel:"silent"});
  fs.writeFileSync(path.join(temp,"index.html"),'<link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;height:100%;min-height:0}#root{display:flex;flex-direction:column}</style><div id="root" class="chat-shell"></div><script type="module" src="fixture.js"></script>');if(output)fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(path.join(temp,"main.cjs"),`const{app,BrowserWindow}=require('electron'),fs=require('node:fs');app.setPath('userData',${JSON.stringify(path.join(temp,"profile"))});app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});w.webContents.on('console-message',(_event,_level,message)=>console.log(message));let ok=false;try{await w.loadURL('about:blank');w.webContents.debugger.attach('1.3');const results=[];for(const width of[1200,390])for(const language of['zh-CN','en'])for(const theme of['light','dark']){w.setSize(width,850);await w.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:width===390?'reduce':'no-preference'}]});await w.loadFile(${JSON.stringify(path.join(temp,"index.html"))},{query:{language,theme}});const result=await w.webContents.executeJavaScript('window.runActivityFixture()');result.width=width;results.push(result);if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+'/activity-'+width+'-'+language+'-'+theme+'.png',(await w.webContents.capturePage()).toPNG());await w.webContents.executeJavaScript('window.runActivityCompaction()');if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+'/compaction-'+width+'-'+language+'-'+theme+'.png',(await w.webContents.capturePage()).toPNG());Object.assign(result,await w.webContents.executeJavaScript('window.finishActivityCompaction()'));await w.webContents.executeJavaScript('window.openActivityTool()');if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+'/tools-'+width+'-'+language+'-'+theme+'.png',(await w.webContents.capturePage()).toPNG());await w.webContents.executeJavaScript('window.showActivityApproval()');if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+'/approval-'+width+'-'+language+'-'+theme+'.png',(await w.webContents.capturePage()).toPNG());await w.webContents.executeJavaScript('window.showActivityInput()');if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+'/input-'+width+'-'+language+'-'+theme+'.png',(await w.webContents.capturePage()).toPNG());Object.assign(result,await w.webContents.executeJavaScript('window.respondToActivityCards()'));Object.assign(result,await w.webContents.executeJavaScript('window.runActivityTerminal()'));w.setSize(width,width===390?760:600);result.shortWindow=await w.webContents.executeJavaScript('window.showSingleActivity()');if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+'/single-'+width+'-'+language+'-'+theme+'.png',(await w.webContents.capturePage()).toPNG());Object.assign(result,await w.webContents.executeJavaScript('window.settleActivity()'));w.setSize(width,950);await w.webContents.executeJavaScript("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{const list=document.querySelector('[data-group-timeline]');list.scrollTop=list.scrollHeight;resolve()})))");if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+'/public-process-'+width+'-'+language+'-'+theme+'.png',(await w.webContents.capturePage()).toPNG());console.log(JSON.stringify(result))}if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+'/results.json',JSON.stringify(results,null,2));ok=true}catch(error){console.error(error.stack||error);if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+'/failed.png',(await w.webContents.capturePage()).toPNG())}finally{w.destroy();app.exit(ok?0:1)}});`);
  const child=spawn(require("electron"),[path.join(temp,"main.cjs")],{env:{...process.env,ELECTRON_DISABLE_SECURITY_WARNINGS:"true"},stdio:["ignore","pipe","pipe"]});child.stdout.on("data",data=>process.stdout.write(data));child.stderr.on("data",data=>process.stderr.write(data));
  const timer=setTimeout(()=>{console.error("Group activity matrix exceeded 90 seconds");child.kill("SIGTERM")},90000);
  const status=await new Promise((resolve,reject)=>{child.once("exit",resolve);child.once("error",reject)});clearTimeout(timer);assert.equal(status,0,"group activity actual UI acceptance failed");
}finally{fs.rmSync(temp,{recursive:true,force:true})}
