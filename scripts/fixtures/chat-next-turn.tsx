import React from "react";
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
const fullAccessMode = backend === "hermes" ? "yolo" : backend === "openclaw" ? "full" : "full-access";
const caps = { attachments: {}, steer, permissions: { scope: "session", apply: "next-turn", defaultMode: "ask", options: [
  { id: "read-only", label: "Read only", description: "Read files", risk: "safe" },
  { id: "ask", label: "Ask", description: "Ask before commands", risk: "standard" },
  { id: fullAccessMode, label: "Full access", risk: "danger", requiresConfirmation: true },
] } };
const models = ["current-model", "next-model"].map(id => ({ id, name: id, provider: runtime, backendId: backend, bindingId, runtime,
  isDefault: id === "current-model", thinkingOptions: ["low", "high"], thinkingDefault: "low", fast: true, reasoning: true }));
let selection = { sessionKey: key, revision: 1, bindingId, runtime, model: "current-model", canSwitch: true,
  candidates: [{ bindingId, support: { supported: true }, adjustments: { clearModelOverride: false, permissionMode: "ask" } }], contextUsage: null };
const sessions: any[] = [{ key, agentId, backendId: backend, agentName: runtime, model: "current-model", modelProvider: runtime,
  permissionMode: "ask", thinkingLevel: null, fastMode: false, updatedAt: Date.now() }];
const requests: any[] = [], sockets = new Set<FixtureSocket>();
const history = [{ role: "user", content: "帮我整理这个项目的进展", timestamp: Date.now()-10000 },
  { role: "assistant", content: "我正在检查当前的项目进展。", timestamp: Date.now()-5000 }];
localStorage.clear();
// The fixture advertises only low/high; keep capability probing outside this settings check.
models.forEach(model => writeXHighCache(`${model.provider}:${model.id}`, false));
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
localStorage.setItem("shoggoth.chat.lastActive.v1", key);
localStorage.setItem("shoggoth.chat.immersive.v1", immersive ? "1" : "0");
void i18n.changeLanguage(query.get("lang") || "zh-CN");
const emit = (payload: any) => sockets.forEach(s => s.emit({ type: "event", event: "chat", payload: { sessionKey: key, runId: "current-run", ...payload } }));
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
    if(frame.method === "chat.history") payload={messages:history};
    if(frame.method === "sessions.patch") {
      Object.assign(sessions[0],frame.params);selection={...selection,revision:selection.revision+1};
      payload={entry:frame.params,resolved:{model:frame.params.model || sessions[0].model},scope:"session"};
    }
    if(frame.method === "chat.steer") payload={accepted:true};
    if(frame.method === "chat.send") payload={status:"started",runId:frame.params.idempotencyKey};
    setTimeout(() => this.emit({type:"res",id:frame.id,ok:true,payload}),0);
  }
  close() { this.readyState=3;sockets.delete(this);this.onclose?.(); }
}
Object.assign(window,{WebSocket:FixtureSocket});
window.fetch=async (input,init) => {
  const url=new URL(String(input),location.href);let payload:any={};
  if(url.pathname==="/__api/backends") payload={backends:FALLBACK_BACKEND_DESCRIPTORS};
  if(url.pathname==="/__api/status") payload={backends:FALLBACK_BACKEND_DESCRIPTORS.map(b=>({id:b.id,connected:true,info:{readyAgentIds:[agentId]}}))};
  if(url.pathname==="/__api/chat/capabilities") payload=caps;
  if(url.pathname==="/__api/models") payload={models,catalogRevision:"a".repeat(64)};
  if(url.pathname==="/__api/chat/cache-scope") payload={backendId:backend,cacheScope:`next-turn-${runtime}-${immersive}`};
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
const checkComposerLayout=(input:HTMLTextAreaElement)=>{
  const composer=input.closest('[data-chat-composer]')!;
  const controls=Array.from(composer.querySelectorAll('button')).map(e=>e.getBoundingClientRect()).filter(e=>e.width>0&&e.height>0);
  controls.forEach((a,index)=>controls.slice(index+1).forEach(b=>check(a.right<=b.left+.5||b.right<=a.left+.5||a.bottom<=b.top+.5||b.bottom<=a.top+.5,"composer controls overlap")));
};
const running=async()=>{await wait(()=>visible("textarea") && sockets.size,"composer");await new Promise(r=>setTimeout(r,400));emit({state:"delta",message:{role:"assistant",content:[{type:"text",text:"我正在继续检查，请随时补充方向。"}]}});await wait(()=>visible('button[title="'+i18n.t("chat.stopGenerating")+'"]'),"running stop action");};
Object.assign(window,{ nextTurnFixture:{runtime,backend,immersive,requests,running}, runNextTurnFixture:async()=>{
  await running();
  const model=visible<HTMLButtonElement>(".chat-pill--model")!,permission=visible<HTMLButtonElement>(".chat-pill--permission")!;
  check(!model.disabled && !permission.disabled,"streaming disables settings");
  if(!immersive) checkComposerLayout(visible<HTMLTextAreaElement>("textarea")!);
  model.click();await wait(()=>visible('button[title="next-model"]'),"model menu");visible<HTMLButtonElement>('button[title="next-model"]')!.click();
  await wait(()=>requests.some(r=>r.method==="model.pick"||r.method==="sessions.patch"&&r.params.model==="next-model"),"model pick");
  permission.click();await wait(()=>visible(".permission-menu__item"),"permission menu");visible<HTMLButtonElement>(".permission-menu__item")!.click();
  await wait(()=>requests.some(r=>r.method==="sessions.patch"&&r.params.permissionMode==="read-only"),"permission pick");
  const permissionPatches=()=>requests.filter(r=>r.method==="sessions.patch"&&"permissionMode" in r.params);
  await wait(()=>permission.textContent?.includes(i18n.t("chat.permissionModes.readOnly")),"read-only mode reflected");
  permission.click();await wait(()=>visible(".permission-menu__item[data-risk=danger]"),"full access option");
  visible<HTMLButtonElement>(".permission-menu__item[data-risk=danger]")!.click();
  await wait(()=>permissionPatches().some(r=>r.params.permissionMode===fullAccessMode),"full access saves without confirmation");
  await wait(()=>permission.textContent?.includes(i18n.t("chat.permissionModes.fullAccess")),"full access reflected");
  check(!document.querySelector('[role="alertdialog"], [role="dialog"]'),"permission switch opens a dialog");
  check(permissionPatches().length===2 && permissionPatches().every(r=>r.params.key===key),"each choice saves once to the active session");
  permission.click();await wait(()=>visible(".permission-menu__item[data-risk=danger]"),"active full access option");
  visible<HTMLButtonElement>(".permission-menu__item[data-risk=danger]")!.click();
  await wait(()=>!document.querySelector(".permission-menu"),"selecting current mode closes menu");
  check(permissionPatches().length===2,"selecting current mode saves again");
  permission.click();await wait(()=>visible(".permission-menu__item[data-risk=standard]"),"ask option");
  visible<HTMLButtonElement>(".permission-menu__item[data-risk=standard]")!.click();
  await wait(()=>permission.textContent?.includes(i18n.t("chat.permissionModes.ask")),"switch back to ask reflected");
  check(permissionPatches().length===3 && !document.querySelector('[role="alertdialog"], [role="dialog"]'),"switching back saves once without a dialog");
  if(!immersive) {
    const thinking=visible<HTMLButtonElement>(".chat-pill--think-fast")!;check(!thinking.disabled,"streaming disables effort/fast");thinking.click();
    await wait(()=>visible('.think-fast-menu__slider'),"effort slider");
    const effort=visible('.think-fast-menu__slider')!;
    check(thinking.textContent===i18n.t("chat.thinkLevel.low") && effort.getAttribute("aria-valuetext")===i18n.t("chat.thinkLevel.low"),"inherited mode must show its actual label");
    check(effort.getAttribute("aria-valuenow")==="0" && effort.querySelectorAll('.think-fast-menu__dots i').length===2,"inherited mode must select its existing stop without an extra option");
    check(!requests.some(r=>r.method==="sessions.patch"&&"thinkingLevel" in r.params),"rendering inherited mode must not change stored settings");
    effort.dispatchEvent(new KeyboardEvent("keydown",{key:"End",bubbles:true}));
    await wait(()=>requests.some(r=>r.method==="sessions.patch"&&r.params.thinkingLevel==="high"),"effort saved");
    visible<HTMLButtonElement>('.think-fast-menu__fast-btn')!.click();
    await wait(()=>requests.some(r=>r.method==="sessions.patch"&&r.params.fastMode===true),"Fast saved");
    document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
  }
  check(!!visible('button[title="'+i18n.t("chat.stopGenerating")+'"]'),"settings stopped current turn");
  await wait(()=>visible("textarea"),"composer available after menus close");
  const input=visible<HTMLTextAreaElement>("textarea")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(input,"先聚焦聊天功能");input.dispatchEvent(new Event("input",{bubbles:true}));
  await new Promise(r=>setTimeout(r,60));
  check(!visible(`[data-send-entry="${immersive?"immersiveButton":"composerButton"}"]`),"send and stop actions must not appear together");
  if(!immersive) checkComposerLayout(input);
  input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));
  if(steer) await wait(()=>requests.some(r=>r.method==="chat.steer"),"native steering request");
  else { await new Promise(r=>setTimeout(r,100));check(!requests.some(r=>r.method==="chat.send"||r.method==="chat.steer"),"queue interrupts original");
    emit({state:"final",message:{role:"assistant",content:[{type:"text",text:"当前回复已完成。"}]}});await wait(()=>requests.some(r=>r.method==="chat.send"),"queue sends next turn"); }
  check(!requests.some(r=>r.method==="chat.abort"),"guidance stops original run");
  return {runtime,backend,immersive,settingsEnabled:true,settingsSaved:true,permissionSwitchWithoutDialog:true,controlsVisible:true,sendHiddenWhileRunning:true,enterSends:true,behavior:steer?"native-steering":"next-turn-queue",abort:false};
}});
createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><ScrollbarProvider/><ChatPage/></UiProvider></HashRouter>);
if(query.has("preview")) void running();
