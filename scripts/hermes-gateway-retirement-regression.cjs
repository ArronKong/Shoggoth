"use strict";
const http=require('node:http');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const {WebSocketServer}=require('ws');const {gatewayRpc,HermesGatewaySocket}=require('../app/core/hermes-gateway-rpc');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){const end=Date.now()+5000;while(Date.now()<end){if(fn())return;await wait(5);}throw Error(label+' timeout');}
function managed(baseUrl,profile='default'){
  const state={current:true,token:'fixture-only-token',baseUrl};const dash={managed:true,profile};
  Object.defineProperties(dash,{baseUrl:{enumerable:true,get(){if(!state.current)throw Error('private retired owner');return state.baseUrl;}},
    token:{get(){if(!state.current)throw Error('private retired owner');return state.token;}},assertCurrent:{value:()=>state.current===true}});
  return {dash:Object.freeze(dash),state};
}
const unsent=(e,op)=>e.receiptUncertain===false&&e.admissionAccepted===false&&e.originalOperationId===op&&e.noAcpFallback===true;
const uncertain=(e,op)=>e.receiptUncertain===true&&e.executionUncertain===true&&e.admissionAccepted===null&&e.originalOperationId===op&&e.operationId===op&&e.state==='needs_verification'&&e.noAcpFallback===true;
async function main(){const frames=[],peers=[],events=[],cases=[];const sockets=[];let upgradeHold=null;
 const server=http.createServer();const wss=new WebSocketServer({noServer:true});
 server.on('upgrade',(req,socket,head)=>{if(upgradeHold){upgradeHold.push({req,socket,head});return;}wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));});
 wss.on('connection',(ws,req)=>{const peer={ws,req,frames:[]};peers.push(peer);ws.on('message',bytes=>{const frame=JSON.parse(bytes.toString());peer.frames.push(frame);frames.push(frame);
   if(!frame.method.startsWith('hold.'))ws.send(JSON.stringify({jsonrpc:'2.0',id:frame.id,result:{method:frame.method,params:frame.params}}));});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const baseUrl=`http://127.0.0.1:${server.address().port}`;
 const hashBefore=crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'../app/core/hermes-gateway-rpc.js'))).digest('hex');
 try{
  const legacy={baseUrl,token:'fixture-only-token'};assert.equal((await gatewayRpc(legacy,'config.get',{})).method,'config.get');
  const ordinary=new HermesGatewaySocket(legacy,{onEvent:e=>events.push(e)});sockets.push(ordinary);await ordinary.ensureConnected();
  const resumed=await ordinary.request('session.resume',{session_id:'legacy'});assert.equal(Object.hasOwn(resumed.params,'profile'),false);
  const ordinaryPeer=peers.at(-1);ordinaryPeer.ws.send(JSON.stringify({jsonrpc:'2.0',method:'event',params:{type:'legacy-event'}}));await until(()=>events.length===1,'legacy event');
  cases.push('legacy one-shot/persistent JSON-RPC and events remain available without managed profile injection');ordinary.close();
  const active=managed(baseUrl,'named-test');const selected=new HermesGatewaySocket(active.dash);sockets.push(selected);await selected.ensureConnected();
  for(const method of ['session.create','session.resume'])assert.equal((await selected.request(method,{session_id:'local'})).params.profile,'named-test');
  assert.equal((await gatewayRpc(active.dash,'session.resume',{session_id:'one-shot'})).params.profile,'named-test');
  const defaultDash=managed(baseUrl);assert.equal((await gatewayRpc(defaultDash.dash,'session.create',{})).params.profile,'default');
  const profileBefore=frames.length;
  await assert.rejects(selected.request('session.resume',{profile:'other'},{operationId:'profile-reject'}),e=>e.code==='MANAGED_HERMES_PROFILE_MISMATCH'&&unsent(e,'profile-reject'));
  await assert.rejects(gatewayRpc(active.dash,'session.create',{profile:'other'},{operationId:'one-profile'}),e=>e.code==='MANAGED_HERMES_PROFILE_MISMATCH'&&unsent(e,'one-profile'));
  await assert.rejects(selected.request('session.create',{toJSON(){return {profile:'different-wire'};}},{operationId:'wire-profile'}),e=>e.code==='MANAGED_HERMES_PROFILE_MISMATCH'&&unsent(e,'wire-profile'));
  assert.equal(frames.length,profileBefore);cases.push('managed create/resume bind named/default wire params.profile on both APIs; foreign caller/serialized profile cannot dispatch');selected.close();
  const retired=managed(baseUrl);retired.state.current=false;const beforeInitial=peers.length;
  assert.throws(()=>gatewayRpc(retired.dash,'config.set',{}, {operationId:'retired-one'}),e=>unsent(e,'retired-one'));
  const invalid=new HermesGatewaySocket(retired.dash);sockets.push(invalid);await assert.rejects(invalid.request('prompt.submit',{}, {operationId:'retired-prompt'}),e=>unsent(e,'retired-prompt'));
  const truthy=Object.freeze({managed:true,profile:'default',baseUrl,token:'fixture-only-token',assertCurrent:()=>({ready:true})});
  assert.throws(()=>gatewayRpc(truthy,'config.get'),e=>e.code==='MANAGED_HERMES_ENDPOINT_RETIRED');assert.equal(peers.length,beforeInitial);
  cases.push('retired initial descriptor and non-true checker fail before actual WebSocket constructor/connection');
  const serializeOne=managed(baseUrl);const oneBefore=frames.length;
  await assert.rejects(gatewayRpc(serializeOne.dash,'config.set',{toJSON(){serializeOne.state.current=false;return {key:'model',value:'must-never-send'};}},{operationId:'serialize-one'}),e=>unsent(e,'serialize-one'));
  assert.equal(frames.length,oneBefore);
  const serializePersistent=managed(baseUrl);const s=new HermesGatewaySocket(serializePersistent.dash);sockets.push(s);await s.ensureConnected();const serialPeer=peers.at(-1);const serialBefore=frames.length;
  await assert.rejects(s.request('prompt.submit',{toJSON(){serializePersistent.state.current=false;return {session_id:'local',text:'must-never-send'};}},{operationId:'serialize-persistent'}),e=>unsent(e,'serialize-persistent'));
  await until(()=>serialPeer.ws.readyState>=2,'retired serializer socket close');assert.equal(s._closed,true);assert.equal(s._reconnectTimer,null);assert.equal(frames.length,serialBefore);
  for(const method of ['prompt.submit','config.set','session.create','session.interrupt'])await assert.rejects(s.request(method,{}, {operationId:'old-'+method.replace('.','-')}),e=>e.receiptUncertain===false&&e.admissionAccepted===false&&e.noAcpFallback===true);
  cases.push('serialization-time retirement rejects outgoing model/config/session/interrupt before send and permanently closes persistent namespace without reconnect');
  const dialFrames=frames.length;upgradeHold=[];const dialing=managed(baseUrl);const d=new HermesGatewaySocket(dialing.dash);sockets.push(d);const connect=d.request('config.get',{}, {operationId:'retire-dial'});const connectRejected=assert.rejects(connect,e=>unsent(e,'retire-dial'));
  await until(()=>upgradeHold.length===1,'held upgrade');dialing.state.current=false;const held=upgradeHold[0];upgradeHold=null;wss.handleUpgrade(held.req,held.socket,held.head,ws=>wss.emit('connection',ws,held.req));await connectRejected;
  assert.equal(d._closed,true);assert.equal(d._reconnectTimer,null);assert.equal(frames.length,dialFrames);
  cases.push('owner invalidated during actual in-flight upgrade is checked again at open and never sends/reconnects');
  const delayed=managed(baseUrl);const lateEvents=[];const old=new HermesGatewaySocket(delayed.dash,{onEvent:e=>lateEvents.push(e)});sockets.push(old);await old.ensureConnected();const oldPeer=peers.at(-1);
  const lost=old.request('hold.prompt',{selection_dispatch:{operation_id:'original-selected'}},{timeoutMs:5000});const lostRejected=assert.rejects(lost,e=>uncertain(e,'original-selected'));
  await until(()=>oldPeer.frames.length===1,'dispatched pending');delayed.state.current=false;
  const freshDash=managed(baseUrl);const fresh=new HermesGatewaySocket(freshDash.dash);sockets.push(fresh);await fresh.ensureConnected();const freshPeer=peers.at(-1);
  let freshResolved=false;const freshP=fresh.request('hold.observe',{}, {operationId:'fresh-read',timeoutMs:5000}).then(v=>{freshResolved=true;return v;});await until(()=>freshPeer.frames.length===1,'fresh pending');
  oldPeer.ws.send(JSON.stringify({jsonrpc:'2.0',id:oldPeer.frames[0].id,result:{forged:'late old receipt'}}));
  oldPeer.ws.send(JSON.stringify({jsonrpc:'2.0',method:'event',params:{type:'late-old-event'}}));await lostRejected;await wait(30);
  assert.equal(freshResolved,false);assert.equal(lateEvents.length,0);assert.equal(old._closed,true);assert.equal(old._reconnectTimer,null);
  freshPeer.ws.send(JSON.stringify({jsonrpc:'2.0',id:freshPeer.frames[0].id,result:{actual:'fresh receipt'}}));assert.deepEqual(await freshP,{actual:'fresh receipt'});
  cases.push('actual late retired socket receipt/event cannot settle fresh same-number request or release event; original dispatched operation remains needs_verification with no replay');old.close();fresh.close();
  const dropping=managed(baseUrl);const drop=new HermesGatewaySocket(dropping.dash);sockets.push(drop);await drop.ensureConnected();const dropPeer=peers.at(-1);
  const interrupted=drop.request('hold.prompt',{}, {operationId:'original-ordinary'});const dropped=assert.rejects(interrupted,e=>uncertain(e,'original-ordinary'));await until(()=>dropPeer.frames.length===1,'drop pending');dropping.state.current=false;dropPeer.ws.close();await dropped;await wait(50);assert.equal(drop._reconnectTimer,null);
  const timing=managed(baseUrl);const timed=new HermesGatewaySocket(timing.dash);sockets.push(timed);await assert.rejects(timed.request('hold.prompt',{}, {operationId:'original-timeout',timeoutMs:30}),e=>uncertain(e,'original-timeout'));timed.close();
  cases.push('dispatched disconnect and timeout preserve original ordinary operation uncertainty; owner retirement suppresses reconnect and never proves known-unsent');
  const reopen=new HermesGatewaySocket(legacy);sockets.push(reopen);await reopen.ensureConnected();const firstWs=reopen._ws;const firstPeer=peers.at(-1);firstPeer.ws.close();await until(()=>!reopen._ws,'legacy disconnected');await reopen.ensureConnected();const newPeer=peers.at(-1);
  let originalResolved=false;const pending=reopen.request('hold.new',{}, {operationId:'after-reconnect',timeoutMs:2000}).then(v=>{originalResolved=true;return v;});await until(()=>newPeer.frames.length===1,'legacy fresh pending');
  // Simulate a queued callback from the real old WebSocket after new dial. Its
  // physical socket identity is an additional invariant beyond numeric RPC id.
  reopen._handleFrame(Buffer.from(JSON.stringify({id:newPeer.frames[0].id,result:{old:true}})),firstWs);assert.equal(originalResolved,false);
  newPeer.ws.send(JSON.stringify({id:newPeer.frames[0].id,result:{current:true}}));assert.deepEqual(await pending,{current:true});reopen.close();
  cases.push('legacy reconnect stays in captured namespace; queued old real-socket callback cannot resolve current physical socket pending map');
  const hashAfter=crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'../app/core/hermes-gateway-rpc.js'))).digest('hex');assert.equal(hashAfter,hashBefore);
  process.stdout.write(JSON.stringify({status:'PASS',groups:cases.length,cases,sourceSha256:hashBefore,boundary:'real loopback WebSocket transport; no actual Hermes Host/model/account'})+'\n');
 }finally{for(const s of sockets)s.close();for(const peer of peers)peer.ws.terminate();for(const h of upgradeHold||[])h.socket.destroy();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
