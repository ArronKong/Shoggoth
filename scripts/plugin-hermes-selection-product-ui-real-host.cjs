#!/usr/bin/env node
'use strict';
// Production React/HTTP/Proxy/Backend, owned Hermes serve, exact adapter bytes,
// real Service public binding/current Grant and local read-only MCP subprocess.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');const {WebSocket}=require('ws');
const {createManagedHermesProductHost}=require('../app/managed-hermes-product-host');
const {createManagedHermesProductAuth}=require('../app/managed-hermes-product-auth');
const {resolveManagedHermesProductInputs}=require('../app/managed-hermes-product-inputs');
const {createManagedHermesHostClient}=require('../app/managed-hermes-host-client');
const {HermesBackend}=require('../app/core/hermes-backend');
const {HermesGatewaySocket}=require('../app/core/hermes-gateway-rpc');
const {ShoggothBackend}=require('../app/core/shoggoth-backend');
const {BackendRegistry}=require('../app/core/backend-registry');
const {startProxyGateway}=require('../app/core/proxy-gateway');
const {createWorkAdmissionGate}=require('../app/core/work-admission-gate');
const {createFederationHostServer}=require('../app/federation-host-server');
const {FederationHostClient}=require('../app/agent-service/federation-host-client');
const {startStaticServer}=require('../app/static-server');
const {createAuthResolver}=require('../app/core/device-auth');
const {createConfigStore}=require('../app/core/config-store');
const {createFixture}=require('./plugin-real-host-service-fixture.cjs');
const localMcp=require('./fixtures/plugin-openclaw-product-ui-local-mcp.cjs');
const pins=require('../app/managed-hermes-runtime-pins.json');
const REPO=path.resolve(__dirname,'..'),MODEL='hermes-product-ui-local';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const FILES=['app/core/plugin-selection-readiness-dto.js','app/core/shoggoth-backend.js','app/static-server.js',
'app/core/hermes-backend.js','app/core/hermes-local-runtime-scope.js','app/core/hermes-plugin-selection.js','app/core/hermes-selection-input.js',
'app/core/hermes-gateway-rpc.js','app/core/proxy-gateway.js','app/core/backend-registry.js','app/core/chat-broker.js','app/core/device-auth.js',
'app/managed-hermes-product-host.js','app/managed-hermes-product-auth.js','app/managed-hermes-product-inputs.js',
'app/managed-hermes-host-client.js','app/managed-hermes-host-worker.js','app/managed-hermes-host-supervisor.js',
'app/managed-plugin-host-runtime.js','app/managed-hermes-runtime-pins.json','app/agent-service/server.js',
'app/agent-service/external-plugin-selection-dispatch.js','app/agent-service/external-plugin-tool-service.js',
'resources/external-plugin-adapters/hermes/__init__.py','resources/external-plugin-adapters/hermes/transport.py',
'resources/external-plugin-adapters/hermes/plugin.yaml','app/manage-ui/src/pages/ChatPage.tsx','app/manage-ui/src/pages/ChatPluginPicker.tsx',
'app/manage-ui/src/lib/usePluginSelectionReadiness.ts','app/manage-ui/src/lib/chatSendRecovery.ts','app/manage-ui/src/api/client.ts',
'scripts/plugin-hermes-selection-product-ui-real-host.cjs','scripts/fixtures/plugin-hermes-product-ui-driver.cjs',
'scripts/fixtures/plugin-openclaw-product-ui-local-mcp.cjs'];
const sources=()=>Object.fromEntries(FILES.map(file=>[file,sha(fs.readFileSync(path.join(REPO,file)))]));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function cleanupDirectory(dir){if(!fs.existsSync(dir))return;const walk=d=>{const s=fs.lstatSync(d);if(!s.isDirectory()||s.isSymbolicLink())return;fs.chmodSync(d,0o700);for(const name of fs.readdirSync(d)){const f=path.join(d,name);if(fs.lstatSync(f).isDirectory()&&!fs.lstatSync(f).isSymbolicLink())walk(f);}};walk(dir);fs.rmSync(dir,{recursive:true,force:true});}
function modelReply(res,body,tool,finalText){if(res.destroyed||res.writableEnded)return;const message=tool?{role:'assistant',content:'',tool_calls:[{id:'hermes_joint_'+tool.name,type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.args)}}]}:{role:'assistant',content:finalText};const finish=tool?'tool_calls':'stop';
 res.writeHead(200,{'content-type':body.stream?'text/event-stream':'application/json'});
 if(!body.stream)return res.end(JSON.stringify({id:'hermes-joint',object:'chat.completion',model:MODEL,choices:[{index:0,message,finish_reason:finish}],usage:{prompt_tokens:16,completion_tokens:8,total_tokens:24}}));
 const deltas=tool?[{role:'assistant',tool_calls:[{index:0,id:message.tool_calls[0].id,type:'function',function:{name:tool.name,arguments:''}}]},{tool_calls:[{index:0,function:{arguments:JSON.stringify(tool.args)}}]}]:[message];
 for(const delta of deltas)res.write('data: '+JSON.stringify({id:'hermes-joint',object:'chat.completion.chunk',model:MODEL,choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
 res.write('data: '+JSON.stringify({id:'hermes-joint',object:'chat.completion.chunk',model:MODEL,choices:[{index:0,delta:{},finish_reason:finish}]})+'\n\n');res.end('data: [DONE]\n\n');}
async function main(){
 assert.equal(process.argv.length,2,'No live/account mode');const codeHashes=sources();
 const root=fs.realpathSync(fs.mkdtempSync('/private/tmp/sgh-hermes-product-ui-'));fs.chmodSync(root,0o700);
 const output=path.resolve(process.env.SHOGGOTH_TEST_HERMES_PRODUCT_UI_OUTPUT||'/private/tmp/plugin-hermes-product-ui');fs.mkdirSync(output,{recursive:true,mode:0o700});
 const state=process.env.SHOGGOTH_TEST_HERMES_PRODUCT_CANDIDATE_STATE||'/private/tmp/shoggoth-hermes-test-candidate/worker-cache';
 let host,client,backend,server,fixture,service,native,registry,proxy,federation,web,child,childOutput='',childError='',uiReport,business,installation,held=null,modelError=null;
 let mode='existing',clientStarts=0,prepares=0,sequence=0,armDrop=false,physical,sessionKey,cleanupKnown=false;
 const modelCalls=[],serviceEvents=[],identityOperations=new Map();
 const observed={browserRequests:[],deliveredFrames:[],selectedHostForwards:[],actualHostAcks:[],readinessCalls:[],dropped:null};
 const originalSend=WebSocket.prototype.send,originalRequest=HermesGatewaySocket.prototype.request;
 const identityKey=identity=>JSON.stringify([identity?.instanceId,identity?.agentId,identity?.sessionId,identity?.taskId,identity?.turnId]);
 const publicCall=params=>({...(params.identity?{identity:{...params.identity},operationId:params.envelope?.operationId||params.selectionEnvelope?.operationId||identityOperations.get(identityKey(params.identity))}:{}),
 ...(params.envelope?{envelope:{...params.envelope}}:{}),selectionEnvelopePresent:Object.hasOwn(params,'selectionEnvelope')});
 const note=(kind,data={})=>serviceEvents.push({sequence:++sequence,kind,...data});
 const instrument=(target,method,label)=>{const original=target[method].bind(target);target[method]=async params=>{
  if(label==='bind')identityOperations.set(identityKey(params.identity),params.envelope.operationId);
  note(label+':request',publicCall(params));try{const result=await original(params);note(label+':success',{...publicCall(params),state:result.receipt?.state||result.state,
   ...(label==='call'?{serverId:params.serverId,toolName:params.toolName,argumentIssueId:params.arguments?.issueId,result:result.result?.structuredContent,isError:result.result?.isError===true}:{}),
   ...(label==='search'?{total:result.total}:{}),});return result;}catch(error){note(label+':error',{...publicCall(params),code:error.code||'UNAVAILABLE'});throw error;}};};
 try{
  assert.equal(fs.realpathSync(state),state);assert(state.startsWith('/private/tmp/sgh-hermes-managed-candidate-'));
  const origin=JSON.parse(fs.readFileSync(path.join(state,'fixture-owned-candidate.json'),'utf8'));assert.equal(origin.source,'production-manager-prepareCandidate');assert.equal(origin.runtimeTreeSha256,pins.hosts.hermes.outputTreeSha256);
  const volume=fs.statfsSync(root);assert(Number(volume.bavail)*Number(volume.bsize)>=128*1024*1024,'bounded private Host/UI free space');
  const assets=path.join(REPO,'app/manage-ui/dist/assets');const buildHashes=Object.fromEntries(fs.readdirSync(assets).filter(file=>file.endsWith('.js')).map(file=>[file,sha(fs.readFileSync(path.join(assets,file)))]));
  fixture=createFixture(root,'hermes',{externalPluginAgentVerifier:null});service=await fixture.start();native=new ShoggothBackend({paths:fixture.paths});
  const prepare=service.externalPluginSelectionDispatch.prepare.bind(service.externalPluginSelectionDispatch);service.externalPluginSelectionDispatch.prepare=params=>{prepares++;return prepare(params);};
  instrument(service.externalPluginSelectionDispatch,'bind','bind');instrument(service.externalPluginSelectionDispatch,'finish','finish');
  for(const method of ['open','search','call'])instrument(service.externalPluginToolService,method,method);
  const cancel=service.externalPluginToolService.cancelExecution.bind(service.externalPluginToolService);service.externalPluginToolService.cancelExecution=identity=>{const canceledCount=cancel(identity);note('cancel-execution',{identity:{...identity},operationId:identityOperations.get(identityKey(identity)),canceledCount});return canceledCount;};
  const source=path.join(root,'fixture-plugin');fs.cpSync(path.join(__dirname,'fixtures/plugins/project-assistant'),source,{recursive:true});localMcp.prepareSource(source);
  const preview=await native.previewPluginInstall({kind:'directory',path:source});assert.equal(preview.installable,true);
  const installed=await native.installPlugin({source:{kind:'directory',path:source},previewDigest:preview.previewDigest,expectedRevision:preview.expectedRevision,operationId:'hermes-joint-ui-install'});
  installation=(await native.setPluginInstallationState({installationId:installed.installation.installationId,desiredState:'enabled',expectedRevision:installed.installation.revision,operationId:'hermes-joint-ui-enable'})).installation;
  business=await localMcp.connectAndGrant({service,backend:native,installation});
  server=http.createServer((req,res)=>{void(async()=>{
   if(req.method==='GET'&&req.url==='/v1/models'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({object:'list',data:[{id:MODEL,object:'model'}]}));}
   if(req.method!=='POST'||req.url!=='/v1/chat/completions'){res.writeHead(404);return res.end();}
   let raw='';for await(const chunk of req){raw+=chunk;assert(raw.length<2000000);}const body=JSON.parse(raw);modelCalls.push(body);
   const messages=body.messages,lastUser=messages.findLastIndex(item=>item.role==='user'),text=JSON.stringify(messages[lastUser]);
   const tools=messages.slice(lastUser+1).filter(item=>item.role==='tool'),issueId=text.includes('JOINT_LOST_ACK')?'fixture-002':'fixture-001';
   assert(text.includes('HOLD_SELECTED'),'unexpected model entry');
   if(tools.length===0){assert.equal(held,null);assert(body.tools.some(item=>item.function?.name==='tool_describe'));held={res,body};return;}
   if(tools.length===1){assert(JSON.stringify(tools).includes('shoggoth_plugin_call'));return modelReply(res,body,{name:'tool_call',args:{calls:[{name:'shoggoth_plugin_call',arguments:{serverId:business.serverId,toolName:business.toolName,arguments:{issueId}}}]}},null);}
   assert.equal(tools.length,2);assert(JSON.stringify(tools).includes(business.marker)&&JSON.stringify(tools).includes(issueId),'actual MCP business result must reach next model');
   modelReply(res,body,null,`Local MCP read returned ${business.marker} ${issueId}.`);
  })().catch(error=>{modelError=error;if(!res.headersSent)res.writeHead(500);res.end('local fixture rejected');});});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const input=resolveManagedHermesProductInputs({hermesBin:require('node:path').join(require('node:os').homedir(), '.local', 'bin', 'hermes'),architecture:'arm64'});assert.equal(input.inputMode,'original');
  const hostState=path.join(root,'private-host');fs.mkdirSync(hostState,{mode:0o700});
  host=createManagedHermesProductHost({getMode:()=>mode,setManagedMode:()=>{mode='managed';},createClient:()=>{clientStarts++;client=createManagedHermesHostClient({stateDir:state,supervisorStateDir:hostState,serviceUserDataRoot:fixture.paths.userDataRoot,...input,
   resourcesRoot:path.join(REPO,'resources/external-plugin-host-patches'),adapterResourcesRoot:path.join(REPO,'resources/external-plugin-adapters'),
   hermesConfiguration:{model:{default:MODEL,provider:'custom',base_url:'http://127.0.0.1:'+server.address().port+'/v1',api_key:'local-fixture-only',api_mode:'chat_completions',context_length:128000}}});return client;},
   onUnavailable:async()=>{await backend.stop();},onReady:async()=>{assert.equal(await backend.start(),true);}});
  const auth=createManagedHermesProductAuth({host,legacyResolver:()=>{throw Error('legacy path prohibited');}});
  backend=new HermesBackend({getManagedExecution:()=>host.getExecution(),getManagedEndpoint:()=>auth.resolveEndpoint(),
   getConfig:()=>({hermesMode:'remote',hermesRemotes:[{profile:'ordinary-user',baseUrl:'http://127.0.0.1:1'}]}),externalPluginSelectionService:native});
  registry=new BackendRegistry();registry.register(backend);registry.register(native);
  host.prepare({operationId:'hermes-ui-owned-prepare'});assert.equal((await host.waitForOperation('hermes-ui-owned-prepare')).state,'running');assert.equal(modelCalls.length,0);assert.equal(clientStarts,1);
  await registry.start('shoggoth');federation=createFederationHostServer({paths:fixture.paths,registry});await federation.start();
  const actualAgent=(await new FederationHostClient({paths:fixture.paths}).request('agent.get',{backendId:'hermes',agentId:'hermes-default'})).agent;assert.equal(actualAgent.id,'hermes-default');assert.equal(actualAgent.backendId,'hermes');
  sessionKey=await backend.createSession('hermes-default',{model:MODEL,provider:'custom',workspace:host.getExecution().workspace});
  const {m,sock}=await backend._gwEnsureRuntime(sessionKey,{eagerBuild:true});physical=await sock.request('prompt.selection.capabilities',{session_id:m.runtimeId});
  assert.equal(physical.adapters.length,1);assert.equal(physical.adapters[0].required_adapter_id,'shoggoth_shared_capabilities');assert.equal(physical.adapters[0].agent_id,'hermes-default');assert.equal(modelCalls.length,0);
  const row=backend.getSessionRows().find(item=>item.agentId===actualAgent.id);assert(row, 'actual Backend navigation row required');
  const admissionGate=createWorkAdmissionGate();proxy=await startProxyGateway({port:0,origin:'http://127.0.0.1',getUpstreamUrl:()=>'',registry,workAdmissionGate:admissionGate});
  const endpoint=host.getEndpoint();
  HermesGatewaySocket.prototype.request=async function(method,params,...args){const result=await originalRequest.call(this,method,params,...args);
   if(method==='prompt.submit'&&params?.selection_dispatch)observed.actualHostAcks.push({sequence:++sequence,operationId:params.selection_dispatch.operation_id,status:result.status,receipt:{...result.selection_dispatch}});return result;};
  WebSocket.prototype.send=function(data,...args){let frame;try{frame=JSON.parse(data.toString());}catch{}
   if(frame?.type==='req'&&this.url===new URL(proxy.url).href&&['chat.send','chat.operation.get','chat.abort','chat.history'].includes(frame.method))observed.browserRequests.push(frame);
   if(frame?.method==='prompt.submit'&&frame.params?.selection_dispatch&&this.url?.startsWith(endpoint.baseUrl.replace('http:','ws:')+'/api/ws'))observed.selectedHostForwards.push(frame.params.selection_dispatch.operation_id);
   if(web&&this._isServer&&this._socket?.localPort===Number(new URL(web.url).port)&&frame){
    const request=observed.browserRequests.find(item=>item.method==='chat.send'&&item.params?.message?.includes('JOINT_LOST_ACK')&&item.params.idempotencyKey===frame.payload?.runId);
    if(armDrop&&request&&frame.type==='event'&&frame.event==='chat'&&frame.payload?.state==='accepted'){
     const ack=observed.actualHostAcks.find(item=>item.operationId===request.params.idempotencyKey);assert(ack&&['accepted','binding','bound'].includes(ack.receipt.state));
     armDrop=false;observed.dropped={operationId:request.params.idempotencyKey,runId:frame.payload.runId,sessionKey,admissionStatus:'accepted',actualHostState:ack.receipt.state};this.terminate();return;}
    observed.deliveredFrames.push(frame);
   }return originalSend.call(this,data,...args);};
  const originalReadiness=backend.getPluginSelectionReadiness.bind(backend);backend.getPluginSelectionReadiness=async input=>{const before={models:modelCalls.length,prepares};const answer=await originalReadiness(input);observed.readinessCalls.push({input:{...input},answer,before,after:{models:modelCalls.length,prepares}});return answer;};
  const configStore=createConfigStore(path.join(root,'app-ui-config.json'));configStore.write({...configStore.read(),locale:'zh-CN',setupCompletedAt:Date.now()});
  const authResolver=createAuthResolver({getConfig:()=>({gatewayUrl:proxy.url,token:''}),credentialsDir:path.join(root,'browser-backend-credentials'),operatorIdentityDir:path.join(root,'browser-operator')});
  web=await startStaticServer(0,{homeDir:root,userDataRoot:root,registry,configStore,chatUpstreamUrl:proxy.url,chatOrigin:'http://127.0.0.1',authResolver,workAdmissionGate:admissionGate});
  const boot={url:`${web.url}#/chat?session=${encodeURIComponent(sessionKey)}&backend=hermes`,output,sessionKey,session:{...row,backendId:'hermes',agentName:'Hermes',updatedAt:Date.now()},installationId:installation.installationId,revision:installation.revision,packageName:'project-assistant',businessMarker:business.marker};
  const bootPath=path.join(root,'product-ui-boot.json');fs.writeFileSync(bootPath,JSON.stringify(boot),{mode:0o600});
  child=spawn(require('electron'),[path.join(__dirname,'fixtures/plugin-hermes-product-ui-driver.cjs'),bootPath],{stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,ELECTRON_DISABLE_SECURITY_WARNINGS:'true'}});
  child.stdout.on('data',bytes=>{childOutput+=bytes;});child.stderr.on('data',bytes=>{childError+=bytes;});
  child.on('message',async message=>{if(message?.type!=='fixture-command')return;try{let value;
   if(message.command==='inspect')value={modelRequests:modelCalls.length,prepares,held:held!==null,events:serviceEvents,browserRequests:observed.browserRequests,deliveredFrames:observed.deliveredFrames,forwards:observed.selectedHostForwards,dropped:observed.dropped,modelError:modelError?.message||null};
   else if(message.command==='release-tool'){assert(held);const previous=held;held=null;modelReply(previous.res,previous.body,{name:'tool_describe',args:{names:['shoggoth_plugin_call']}},null);value=true;}
   else if(message.command==='discard-held'){held?.res.destroy();held=null;value=true;}
   else if(message.command==='arm-lost-ack'){armDrop=true;value=true;}
   else if(message.command==='report'){uiReport=message.value;value=true;}else throw Error('unknown fixture command');
   if(child.connected)child.send({id:message.id,ok:true,value});}catch(error){if(child.connected)child.send({id:message.id,ok:false,error:error.message});}});
  let timer;const exit=await Promise.race([new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal}))),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Hermes joint UI deadline')),160000);})]).finally(()=>clearTimeout(timer));
  assert.equal(exit.code,0,`Hermes product UI failed: ${childOutput}\n${childError}`);assert(uiReport?.passed);assert.equal(modelError,null);assert.equal(modelCalls.length,7);assert.equal(prepares,3);
  const sends=observed.browserRequests.filter(item=>item.method==='chat.send'&&item.params?.pluginSelection);assert.equal(sends.length,3);assert.equal(new Set(sends.map(item=>item.params.idempotencyKey)).size,3);
  for(const send of sends){const operationId=send.params.idempotencyKey;assert.equal(send.params.sessionKey,sessionKey);assert.deepEqual(send.params.pluginSelection,[{installationId:installation.installationId,revision:installation.revision}]);assert.equal(Object.hasOwn(send.params,'capabilitySelection'),false);
   assert.equal(observed.selectedHostForwards.filter(id=>id===operationId).length,1);assert.equal(observed.actualHostAcks.filter(ack=>ack.operationId===operationId).length,1);
   const bind=serviceEvents.find(event=>event.kind==='bind:success'&&event.operationId===operationId);assert(bind);assert.equal(bind.identity.sessionId,physical.runtime_session_id);assert.equal(bind.identity.agentId,'hermes-default');assert.equal(bind.identity.instanceId,physical.adapters[0].instance_id);}
  const calls=[];for(const send of sends.filter(item=>!item.params.message.includes('JOINT_STOP'))){const operationId=send.params.idempotencyKey,issueId=send.params.message.includes('JOINT_LOST_ACK')?'fixture-002':'fixture-001';
   const matches=serviceEvents.filter(event=>event.kind==='call:success'&&event.operationId===operationId);assert.equal(matches.length,1);const call=matches[0];assert.equal(call.serverId,business.serverId);assert.equal(call.toolName,business.toolName);assert.equal(call.argumentIssueId,issueId);assert.equal(call.result.marker,business.marker);assert.equal(call.result.issue.id,issueId);assert.equal(call.isError,false);
   assert(Number.isSafeInteger(call.result.executingProcessId)&&call.result.executingProcessId!==process.pid);assert(execFileSync('/bin/ps',['-p',String(call.result.executingProcessId),'-o','command='],{encoding:'utf8'}).includes(root+'/service/'));
   calls.push({operationId,serverId:call.serverId,toolName:call.toolName,issueId,marker:call.result.marker,processId:call.result.executingProcessId});assert(serviceEvents.some(event=>event.kind==='finish:success'&&event.operationId===operationId&&event.state==='completed'));}
  const stopOperation=sends.find(item=>item.params.message.includes('JOINT_STOP')).params.idempotencyKey;assert.equal(serviceEvents.some(event=>event.kind==='call:request'&&event.operationId===stopOperation),false);assert(serviceEvents.some(event=>event.kind==='finish:success'&&event.operationId===stopOperation&&event.state==='canceled'));
  assert.equal(serviceEvents.some(event=>event.kind==='search:success'),false);assert(observed.dropped);assert(observed.browserRequests.some(item=>item.method==='chat.operation.get'&&item.params.idempotencyKey===observed.dropped.operationId));
  assert(observed.readinessCalls.some(item=>item.answer===true&&item.before.models===0&&item.after.models===0&&item.before.prepares===0&&item.after.prepares===0));assert.equal(backend.acpClients.size,0);
  for(const body of modelCalls){const serialized=JSON.stringify(body);for(const event of serviceEvents.filter(event=>event.envelope))for(const key of ['dispatchRef','selectionDigest','adapterGeneration'])assert.equal(serialized.includes(event.envelope[key]),false);assert(!serialized.includes(endpoint.token));}
  const privateAdapter=path.join(endpoint.dataRoot,'plugins/shoggoth_shared_capabilities');for(const name of ['__init__.py','transport.py','plugin.yaml'])assert.equal(sha(fs.readFileSync(path.join(privateAdapter,name))),sha(fs.readFileSync(path.join(REPO,'resources/external-plugin-adapters/hermes',name))));
  const identity=client.getStatus().identity,generation=client.getStatus().generation;await web.close();web=null;await proxy.close();proxy=null;await federation.stop();federation=null;await backend.stop();await host.close({operationId:'hermes-ui-known-exit',timeoutMs:30000});assert.equal(client.getStatus().state,'closed');await fixture.stop();
  for(const pid of new Set(calls.map(call=>call.processId))){await delay(50);assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});}assert.throws(()=>process.kill(identity.pid,0),{code:'ESRCH'});cleanupKnown=true;
  assert.deepEqual(sources(),codeHashes,'loaded product sources changed during joint proof; rerun stable source');
  const evidence={version:1,date:'2026-09-28',passed:true,ui:uiReport,modelRequests:modelCalls.length,selectedSends:sends.map(send=>({operationId:send.params.idempotencyKey,sessionKey,selection:send.params.pluginSelection})),business:{...business,calls,readOnlyFixture:true,actualStdioSubprocess:true},
   physicalHost:{agentId:'hermes-default',sessionId:physical.runtime_session_id,adapterInstanceId:physical.adapters[0].instance_id,generation,identity},actualHostAcks:observed.actualHostAcks,selectedHostForwards:observed.selectedHostForwards,droppedAck:observed.dropped,readinessObservations:observed.readinessCalls,
   codeHashes,buildHashes,runtimeTreeSha256:pins.hosts.hermes.outputTreeSha256,serviceBinding:'trusted App Client init -> exact private Worker -> Supervisor captured root/inode -> fixed spawn ENV -> import-frozen original production transport; no monkey patch',
   cleanup:'actual owned Hermes/MCP children confirmed absent; shared sealed candidate retained; private Service/auth/UI data removed',accountsUsed:false,installedAppAcceptance:false,productionCandidateCopies:0,newNormalizationCopies:0,remoteRequests:0,globalWrites:0,
   navigation:'Actual Backend roster row plus production session deep link to the exact successful createSession receipt; fresh rows are materialized by normal ChatPage ensureSessionRow, no readiness/selection/receipt seed',
   scope:'Production React ChatPage/picker -> actual loopback HTTP/__chatws/Proxy -> actual HermesBackend/ProductHost/Auth/Worker/Supervisor -> owned sealed serve/production adapter -> real Service global binding/current read Grant -> credentialless local MCP stdio child -> model -> final. Synthetic local Issues/local deterministic model only; no real provider/installed App claim.'};
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({passed:true,checks:uiReport.checks.length,modelRequests:modelCalls.length,selectedSends:sends.length,output:path.join(output,'report.json')}));return evidence;
 }catch(error){fs.writeFileSync(path.join(output,'joint-failure.json'),JSON.stringify({error:error.stack,childOutput,childError,observed,serviceEvents,modelRequests:modelCalls.length,modelError:modelError?.stack},null,2));throw error;}
 finally{
  WebSocket.prototype.send=originalSend;HermesGatewaySocket.prototype.request=originalRequest;held?.res.destroy();held=null;
  if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(4000)]);}
  await web?.close();await proxy?.close();await federation?.stop();await backend?.stop().catch(()=>{});await host?.close({operationId:'hermes-ui-cleanup',timeoutMs:60000}).catch(error=>{console.error(error.code);});await fixture?.stop();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(cleanupKnown||!client||client.getStatus().state==='closed')cleanupDirectory(root);else console.error('Private unknown ownership state retained for verification');
 }
}
if(require.main===module)main().catch(error=>{console.error(error.stack);process.exitCode=1;});module.exports={main};
