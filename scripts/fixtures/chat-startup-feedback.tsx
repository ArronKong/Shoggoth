import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import TurnProcess from "../../app/manage-ui/src/components/TurnTimeline/TurnProcess";
import type { TurnStep } from "../../app/manage-ui/src/lib/turnTimeline";
import type { ChatStartupStage } from "../../app/manage-ui/src/lib/chatRunWait";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import { FALLBACK_BACKEND_DESCRIPTORS } from "../../app/manage-ui/src/lib/backends";
import { writeXHighCache } from "../../app/manage-ui/src/lib/thinkingCapability";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";
const query = new URLSearchParams(location.search), runtime = query.get("runtime") || "codex", immersive = query.has("immersive");
const backend = ["openclaw", "hermes"].includes(runtime) ? runtime : "shoggoth", agentId = `${backend}-next-turn`;
const key = `agent:${agentId}:11111111-1111-4111-8111-111111111111`, bindingId = "22222222-2222-4222-8222-222222222222";
const steer = ["codex", "claude-code", "pi", "deepseek-harness", "openclaw", "hermes"].includes(runtime);
const caps = { attachments: {}, steer, permissions: { scope: "session", apply: "next-turn", defaultMode: "ask", options: [
  { id: "read-only", label: "Read only", description: "Read files", risk: "safe" },
  { id: "ask", label: "Ask", description: "Ask before commands", risk: "standard" },
] } };
const models = ["current-model", "next-model"].map(id => ({ id, name: id, provider: runtime, backendId: backend, bindingId, runtime,
  isDefault: id === "current-model", thinkingOptions: ["low", "high"], thinkingDefault: "low", fast: true, reasoning: true }));
let selection = { sessionKey: key, revision: 1, bindingId, runtime, model: "current-model", canSwitch: true,
  candidates: [{ bindingId, support: { supported: true }, adjustments: { clearModelOverride: false, permissionMode: "ask" } }], contextUsage: null };
const sessions: any[] = [{ key, agentId, backendId: backend, agentName: runtime, model: "current-model", modelProvider: runtime,
  permissionMode: "ask", thinkingLevel: null, fastMode: false, updatedAt: Date.now() }];
let currentRunId = "fixture-run", currentRunStatus = "running", releaseSend: (() => void) | null = null;
const requests: any[] = [], sockets = new Set<FixtureSocket>();
const history: any[] = [{ role: "user", content: "帮我整理这个项目的进展", timestamp: Date.now()-10000 },
  { role: "assistant", content: "我正在检查当前的项目进展。", timestamp: Date.now()-5000 }];
localStorage.clear();
document.documentElement.dataset.theme = query.get("theme") || "light";
// The fixture advertises only low/high; keep capability probing outside this settings check.
models.forEach(model => writeXHighCache(`${model.provider}:${model.id}`, false));
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
localStorage.setItem("shoggoth.chat.lastActive.v1", key);
localStorage.setItem("shoggoth.chat.immersive.v1", immersive ? "1" : "0");
void i18n.changeLanguage(query.get("lang") || "zh-CN");
const emit = (payload: any) => sockets.forEach(s => s.emit({ type: "event", event: "chat", payload: { sessionKey: key, runId: currentRunId, ...payload } }));
class FixtureSocket {
  static OPEN = 1; readyState = 1;
  onopen: (() => void) | null = null; onmessage: ((event: {data: string}) => void) | null = null; onclose: (() => void) | null = null;
  constructor() { sockets.add(this); setTimeout(() => this.onopen?.(),0); }
  emit(frame: any) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  send(raw: string) {
    const frame=JSON.parse(raw); requests.push(frame); let payload: any = {};
    if(frame.method === "sessions.list") payload={ sessions, hasMore:false };
    if(frame.method === "agents.list") payload={ agents:[{id:agentId,name:runtime,backendId:backend}] };
    if(frame.method === "models.list") payload={models};
    if(frame.method === "chat.history") payload={messages:history,hasMore:false,nextCursor:null,sourceId:`fixture-${key}`};
    if(frame.method === "chat.operation.get") payload={status:"found",stateAuthority:"native-service",admissionAccepted:true,run:{id:currentRunId,status:currentRunStatus}};
    if(frame.method === "sessions.patch") {
      Object.assign(sessions[0],frame.params);selection={...selection,revision:selection.revision+1};
      payload={entry:frame.params,resolved:{model:frame.params.model || sessions[0].model},scope:"session"};
    }
    if(frame.method === "chat.steer") payload={accepted:true};
    if(frame.method === "chat.send") {
      currentRunId=frame.params.idempotencyKey;
      currentRunStatus="running";
      history.push({role:"user",content:frame.params.message,timestamp:Date.now(),idempotencyKey:`${currentRunId}:user`});
      releaseSend=()=>this.emit({type:"res",id:frame.id,ok:true,payload:{status:"started",runId:currentRunId}});
      return;
    }
    setTimeout(() => this.emit({type:"res",id:frame.id,ok:true,payload}),0);
  }
  close() { this.readyState=3;sockets.delete(this);this.onclose?.(); }
}
Object.assign(window,{WebSocket:FixtureSocket});
window.fetch=async (input,init) => {
  const url=new URL(String(input),location.href);let payload:any={};
  if(url.pathname==="/__api/chat/secrets/prepare") {
    const body=JSON.parse(String(init?.body));
    if(typeof body.text!=="string" || typeof body.sessionKey!=="string" || typeof body.operationId!=="string") throw Error("invalid ordinary-input preparation fixture");
    payload={text:body.text,references:[],version:1};
  }
  if(url.pathname==="/__api/backends") payload={backends:FALLBACK_BACKEND_DESCRIPTORS};
  if(url.pathname==="/__api/status") payload={backends:FALLBACK_BACKEND_DESCRIPTORS.map(b=>({id:b.id,connected:true,info:{readyAgentIds:[agentId]}}))};
  // Real ChatPage also loads group state and MCP request cards. Return their
  // actual empty-list DTOs; a generic {} is not a successful list response.
  if(url.pathname==="/__api/group-chats") payload={groups:[],enabled:true,internalSessions:[]};
  if(url.pathname==="/__api/connectors/mcp/requests") payload={items:[]};
  if(url.pathname==="/__api/connectors/mcp/requests") payload={items:[]};
  if(url.pathname==="/__api/chat/capabilities") payload=caps;
  if(url.pathname==="/__api/models") payload={models,catalogRevision:"a".repeat(64)};
  if(url.pathname==="/__api/chat/cache-scope") payload={backendId:backend,cacheScope:`startup-${runtime}-${immersive}`};
  if(url.pathname==="/__api/chat/slash") payload={supported:false,commands:[]};
  if(url.pathname==="/__api/plugins/selection-readiness") payload={version:1,supported:false};
  if(url.pathname==="/__api/plugins") payload={page:{supported:false,items:[],catalogRevision:"a".repeat(64),nextCursor:null}};
  if(url.pathname.endsWith("/runtime-models")) {
    if(init?.method==="PUT") { const body=JSON.parse(String(init.body));requests.push({method:"model.pick",params:body});
      selection={...selection,model:body.model,revision:selection.revision+1};sessions[0].model=body.model;payload=selection;
    } else payload={selection,models,runtimes:[{runtime,bindingId,name:runtime,available:true,capabilities:caps}],capabilities:caps};
  }
  return new Response(JSON.stringify(payload),{headers:{"Content-Type":"application/json"}});
};
const wait=async (predicate:()=>unknown,label:string) => { const end=Date.now()+7000;while(!predicate()){if(Date.now()>end)throw Error(`timeout: ${label}`);await new Promise(r=>setTimeout(r,20));} };
const visible = <T extends HTMLElement>(selector:string) => Array.from(document.querySelectorAll<T>(selector)).find(e=>{
  const rect=e.getBoundingClientRect();if(rect.width<=0||rect.height<=0)return false;
  const hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
  return hit===e||!!hit&&e.contains(hit);
});
const check=(cond:unknown,label:string)=>{if(!cond)throw Error(label);};

const tick=()=>new Promise(r=>setTimeout(r,60));
const waitNode=()=>visible<HTMLElement>('[data-testid="chat-run-wait"]');
const loadingSelector='.chat-thread .chat-bubble.is-streaming [role="status"]';
const checkLoadingBubble=()=>{
  if(immersive)return;
  const loader=visible<HTMLElement>(loadingSelector);
  check(!!loader,"pending reply must show its loading bubble");
  check(document.querySelectorAll(loadingSelector).length===1,"only one reply loading animation is shown");
  check(loader!.querySelectorAll("circle").length===2,"reply uses the existing two-ball animation");
  check(loader!.getAttribute("aria-label")===i18n.t("chat.liveStatus.running"),"loading animation announces its status");
  check(loader!.getAnimations({subtree:true}).some(animation=>animation.playState==="running"),"reply loading animation is running");
};
const stage=async(value:string,statusKind="starting")=>{
  emit({state:"status",statusKind,stage:value});
  await wait(()=>waitNode()?.dataset.stage===value,`stage ${value}`);
  check(waitNode()?.textContent?.includes(i18n.t(`chat.runWait.${value}`)),`translated ${value}`);
  const process=waitNode()!.closest('[data-chat-process]');
  check(!!process && process.textContent?.includes(i18n.t("turnLab.processLabel")),"startup is outside the activity timeline");
  check(!waitNode()!.closest('.chat-bubble'),"startup appears in a reply bubble");
  checkLoadingBubble();
  const r=waitNode()!.getBoundingClientRect();
  check(r.left>=0&&r.right<=innerWidth+1,"startup label overflows viewport");
  if(!immersive){const thread=document.querySelector<HTMLElement>(".chat-thread")!,style=getComputedStyle(thread);
    const visibleBottom=thread.getBoundingClientRect().bottom-parseFloat(style.getPropertyValue("--chat-fade-bottom"))-parseFloat(style.getPropertyValue("--chat-fade"));
    check(r.bottom<=visibleBottom+1,`startup label is hidden under the composer fade: ${JSON.stringify({bottom:r.bottom,visibleBottom,thread:thread.getBoundingClientRect().toJSON(),process:process!.getBoundingClientRect().toJSON(),sent:Array.from(document.querySelectorAll('.chat-thread .chat-group.is-user')).at(-1)?.getBoundingClientRect().toJSON()})}`);}
};
const send=async()=>{
  await wait(()=>{const input=visible<HTMLTextAreaElement>("textarea");return input&&!input.disabled&&sockets.size;},"composer ready");
  await tick();const input=visible<HTMLTextAreaElement>("textarea")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(input,`继续检查项目进展 ${requests.filter(r=>r.method==="chat.send").length+1}`);
  input.dispatchEvent(new Event("input",{bubbles:true}));await tick();
  // A visible composer can precede the asynchronous Agent/status readiness.
  // Dispatch Enter only when the same send gate presented to a user is ready.
  await wait(()=>{const button=visible<HTMLButtonElement>(`[data-send-entry="${immersive?"immersiveButton":"composerButton"}"]`);return button&&!button.disabled;},"send control ready");
  const count=requests.filter(r=>r.method==="chat.send").length;
  input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));
  await wait(()=>requests.filter(r=>r.method==="chat.send").length>count,"actual send");
  await wait(()=>waitNode()?.dataset.stage==="preparing","immediate preparing before receipt");
  check(!!waitNode()!.closest('[data-chat-process]'),"activity timeline must appear before acceptance");
  checkLoadingBubble();
  check(!!releaseSend,"request must still await acceptance");releaseSend!();releaseSend=null;
  emit({state:"accepted",backendId:backend,agentId});await tick();
};
const finish=async(state="final")=>{
  currentRunStatus=state==="final"?"completed":state==="aborted"?"canceled":"failed";
  if(state==="final")history.push({role:"assistant",content:"这次检查已完成。",timestamp:Date.now()});
  emit({state,message:state==="final"?{role:"assistant",content:[{type:"text",text:"这次检查已完成。"}]}:undefined,errorMessage:state==="error"?"Fixture failure":undefined});
  await wait(()=>!waitNode(),"terminal clears waiting");await tick();
  check(!document.querySelector(loadingSelector),"terminal removes the reply loading animation");
  check(!document.querySelector('.chat-thread .chat-cursor'),"terminal removes the reply cursor");
};
const preview=async()=>{await send();if(!query.has("all-stages"))await stage("restoring");};
Object.assign(window,{startupFeedbackFixture:{runtime,backend,immersive,requests,preview},runStartupFeedbackFixture:async()=>{
  await send();
  check(!waitNode()?.textContent?.includes("0s")&&!waitNode()?.textContent?.includes("0 秒"),"hide immediate zero counter");
  for(const value of ["context","compacting","connecting","restoring","opening"])await stage(value);
  check(!document.querySelector('.chat-header .chat-status__label')?.textContent?.includes(i18n.t("chat.liveStatus.queued")),"context maintenance must not claim a queue");
  await stage("waiting","running");
  if(runtime==="codex"&&!immersive&&i18n.language==="zh-CN") {
    const zoom=visible<HTMLButtonElement>('button[title="'+i18n.t("turnLab.processLargeView")+'"]')!;
    zoom.click();
    await wait(()=>visible('[role="dialog"] [data-testid="chat-run-wait"]'),"expanded activity shows startup");
    emit({state:"status",statusKind:"running",stage:"waiting"});
    await wait(()=>visible<HTMLElement>('[role="dialog"] [data-testid="chat-run-wait"]')?.dataset.stage==="waiting","expanded activity follows actual stage");
    document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
    await wait(()=>!document.querySelector('[role="dialog"]'),"close expanded activity");
  }
  emit({state:"delta",message:{role:"assistant",content:[{type:"text",text:""}]}});await tick();
  check(waitNode()?.dataset.stage==="waiting","empty event erased startup");
  emit({state:"thinking",thinking:"   "});await tick();
  emit({state:"plan",plan:[]});await tick();
  emit({state:"status",statusKind:"running",stage:"waiting"});await tick();
  check(waitNode()?.dataset.stage==="waiting","empty thinking/plan erased startup");
  checkLoadingBubble();
  if(runtime==="antigravity"&&!immersive){await new Promise(r=>setTimeout(r,3200));check(!!waitNode()?.querySelector('[aria-hidden="true"]'),"elapsed delay missing");}
  const sentBubble=()=>Array.from(document.querySelectorAll<HTMLElement>(".chat-thread .chat-group.is-user")).at(-1);
  const measure=()=>{const thread=document.querySelector<HTMLElement>(".chat-thread")!;return {top:sentBubble()?.getBoundingClientRect().top,
    scroll:thread?.scrollTop,height:thread?.scrollHeight,client:thread?.clientHeight,spacer:document.querySelector<HTMLElement>('.chat-stream-spacer')?.style.height,
    fade:thread&&getComputedStyle(thread).getPropertyValue("--chat-fade-bottom"),
    replyHeights:Array.from(thread.querySelectorAll<HTMLElement>('.chat-group.is-assistant .chat-bubble')).map(b=>({height:b.getBoundingClientRect().height,text:b.textContent}))};};
  const before=immersive?null:measure();
  const anchorBefore=sentBubble()?.getBoundingClientRect().top;
  emit({state:"delta",message:{role:"assistant",content:[{type:"text",text:"正在查看相关文件。"}]}});
  await wait(()=>!waitNode(),"first text replaces waiting");
  if(!immersive){
    check(!document.querySelector(loadingSelector),"first text replaces the loading animation");
    check(document.querySelectorAll('.chat-thread .chat-cursor').length===1,"streaming text has one output cursor");
  }
  if(!immersive)check(Math.abs(sentBubble()!.getBoundingClientRect().top-anchorBefore!)<=1,`first output moved the sent message on screen: ${JSON.stringify({before,after:measure()})}`);
  if(!immersive){
    const thread=document.querySelector<HTMLElement>('.chat-thread')!;
    thread.scrollTop=Math.max(0,thread.scrollTop-32);
    await tick();
    const readingTop=sentBubble()!.getBoundingClientRect().top;
    emit({state:"delta",message:{role:"assistant",content:[{type:"text",text:"正在查看相关文件。继续核对项目状态。"}]}});
    await wait(()=>thread.textContent?.includes("继续核对项目状态。"),"more reply text arrives after manual scroll");
    check(Math.abs(sentBubble()!.getBoundingClientRect().top-readingTop)<=1,"output moved the user's manually chosen reading position");
  }
  emit({state:"status",statusKind:"running",stage:"waiting"});await tick();check(!waitNode(),"late running revives startup");
  await finish();
  await send();
  if(!immersive){
    visible<HTMLButtonElement>('button[title="'+i18n.t("chat.hideTrajectory")+'"]')!.click();
    await wait(()=>!waitNode(),"hide activity timeline");
    checkLoadingBubble();
    visible<HTMLButtonElement>('button[title="'+i18n.t("chat.showTrajectory")+'"]')!.click();
    await wait(()=>waitNode()?.dataset.stage==="preparing","restore activity timeline");
    checkLoadingBubble();
  }
  emit({state:"status",statusKind:"queued",reason:"RUNTIME_ACCOUNT_ACTIVE_LIMIT",queuedAt:Date.now()});
  await wait(()=>waitNode()?.dataset.kind==="queued","queue shown");
  checkLoadingBubble();
  emit({state:"status",statusKind:"retrying",reason:"RUNTIME_RATE_LIMITED"});
  await wait(()=>waitNode()?.dataset.kind==="retrying","retry shown");
  checkLoadingBubble();
  await stage("connecting");
  sockets.forEach(s=>s.emit({type:"event",event:"session.tool",payload:{sessionKey:key,runId:currentRunId,data:{toolCallId:"fixture-tool",name:"read_file",phase:"start",args:{path:"README.md"}}}}));
  await wait(()=>!waitNode(),"tool activity replaces waiting");
  emit({state:"status",statusKind:"running",stage:"waiting"});await tick();check(!waitNode(),"late status hides tool");
  await finish();
  for(const kind of ["approval","clarify"]){
    await send();
    emit({state:"prompt",prompt:{kind,requestId:`fixture-${kind}`,question:"继续检查吗？",choices:["once","deny"]}});
    await wait(()=>document.querySelector('.chat-prompt'),"blocking prompt appears");
    check(!document.querySelector(loadingSelector),"blocking prompt replaces the loading animation");
    await finish("aborted");
  }
  await send();
  await wait(()=>visible('button[title="'+i18n.t("chat.stopGenerating")+'"]'),"stop ready");
  visible<HTMLButtonElement>('button[title="'+i18n.t("chat.stopGenerating")+'"]')!.click();
  await wait(()=>requests.some(r=>r.method==="chat.abort"),"stop request");await finish("aborted");
  await send();await finish("error");
  return {runtime,immersive,lang:i18n.language,width:innerWidth,immediate:true,insideActivity:true,replyLoadingBubble:!immersive,loadingWithoutTrajectory:!immersive,manualScrollPreserved:!immersive,stages:true,emptyEvents:true,firstOutput:true,lateStatus:true,queue:true,retry:true,blockingPrompts:true,stop:true,error:true};
}});
// Preview-only comparison: reuse the real activity renderer without inventing
// completed phases in the product's live event stream.
function AllStartupStages() {
  const [target, setTarget] = useState<Element | null>(null);
  useEffect(() => {
    const locate = () => {
      const process = document.querySelector('.chat-thread [data-chat-process]');
      if (process) setTarget(process.parentElement);
    };
    const observer = new MutationObserver(locate);
    observer.observe(document.getElementById("root")!, { childList: true, subtree: true });
    locate();
    return () => observer.disconnect();
  }, []);
  const stages: ChatStartupStage[] = ["preparing", "connecting", "restoring", "opening", "waiting"];
  const steps: TurnStep[] = stages.map((value, index) => ({ id: `preview:${value}`, kind: "status", status: index === 4 ? "running" : "ok",
    startTs: 0, statusKind: "starting", startupWait: { kind: "starting", stage: value, reason: null, since: Date.now() } }));
  if (!target) return null;
  return createPortal(<div className="startup-stage-comparison" data-preview-stages>
    <style>{`
      .chat-thread .chat-group__stack:has(> .startup-stage-comparison) > [data-chat-process] { display: none; }
      .startup-stage-comparison { width: 100%; }
      .startup-stage-comparison__note { margin: 0 0 12px; color: var(--ui-text-2); font-size: 12px; line-height: 1.7; }
      .startup-stage-comparison [data-testid="chat-run-wait"] > [aria-hidden="true"] { display: none; }
    `}</style>
    <p className="startup-stage-comparison__note">全部启动阶段 · 文案预览<br/>“接上之前的对话”和“开始这次对话”分别对应继续旧会话、新建会话，实际运行按情况出现。</p>
    <TurnProcess steps={steps} live defaultOpen />
  </div>, target);
}
createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><ScrollbarProvider/><ChatPage/>{query.has("all-stages") && <AllStartupStages/>}</UiProvider></HashRouter>);
if(query.has("preview")) void preview();
