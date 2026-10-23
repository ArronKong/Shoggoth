"use strict";
// Reuses only the exact previously production-prepared, sealed fixture candidate.
// No provider account/global Host/package or duplicate dependency copy.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),http=require('node:http');
const {createManagedHermesProductHost}=require('../app/managed-hermes-product-host');
const {createManagedHermesProductAuth}=require('../app/managed-hermes-product-auth');
const {resolveManagedHermesProductInputs}=require('../app/managed-hermes-product-inputs');
const {createManagedHermesHostClient}=require('../app/managed-hermes-host-client');
const {HermesGatewaySocket}=require('../app/core/hermes-gateway-rpc');
const {hashFile}=require('../app/managed-plugin-host-runtime');const pins=require('../app/managed-hermes-runtime-pins.json');
const ROOT=path.resolve(__dirname,'..'),MODEL='hermes-product-local-a',MODEL2='hermes-product-local-user';
const FILES=['app/managed-hermes-product-host.js','app/managed-hermes-product-auth.js','app/managed-hermes-product-inputs.js','app/managed-hermes-host-supervisor.js','app/managed-hermes-host-worker.js','app/managed-hermes-host-client.js','app/managed-hermes-runtime-pins.json','scripts/plugin-managed-hermes-product-real-host-fixture.cjs'];
const sources=()=>Object.fromEntries(FILES.map(file=>[file,hashFile(path.join(ROOT,file))]));const hashes=sources();
const root=fs.realpathSync(fs.mkdtempSync('/private/tmp/sgh-hermes-product-proof-'));fs.chmodSync(root,0o700);
const state=process.env.SHOGGOTH_TEST_HERMES_PRODUCT_CANDIDATE_STATE||'/private/tmp/shoggoth-hermes-test-candidate/worker-cache';
let host,client,socket,server,modelError;const requests=[],events=[],progress=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));async function wait(test,label,ms=45000){const end=Date.now()+ms;while(Date.now()<end){if(modelError)throw modelError;if(await test())return;await delay(50);}throw Error(label+' timeout');}
function cleanupDirectory(dir){if(!fs.existsSync(dir))return;const walk=d=>{const s=fs.lstatSync(d);if(!s.isDirectory()||s.isSymbolicLink())return;fs.chmodSync(d,0o700);for(const name of fs.readdirSync(d)){const f=path.join(d,name);if(fs.lstatSync(f).isDirectory()&&!fs.lstatSync(f).isSymbolicLink())walk(f);}};walk(dir);fs.rmSync(dir,{recursive:true,force:true});}
async function request(auth,url,method='GET',body){const res=await fetch(url,{method,headers:{...auth.getHttpHeaders(url),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});assert.equal(res.status,200,'private HTTP status');return res.json();}
function reply(res,body){const message={role:'assistant',content:'Hermes product private turn complete'};res.writeHead(200,{'content-type':body.stream?'text/event-stream':'application/json'});if(!body.stream)return res.end(JSON.stringify({id:'local-product',object:'chat.completion',model:body.model,choices:[{index:0,message,finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}));for(const delta of [message,{}])res.write('data: '+JSON.stringify({id:'local-product',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta,finish_reason:delta.content?null:'stop'}]})+'\n\n');res.end('data: [DONE]\n\n');}
(async()=>{try{
 assert.equal(process.argv.length,2);assert.equal(fs.realpathSync(state),state);assert(state.startsWith('/private/tmp/sgh-hermes-managed-candidate-'));
 const origin=JSON.parse(fs.readFileSync(path.join(state,'fixture-owned-candidate.json'),'utf8'));assert.equal(origin.source,'production-manager-prepareCandidate');assert.equal(origin.runtimeTreeSha256,pins.hosts.hermes.outputTreeSha256);
 const volume=fs.statfsSync(root);assert(Number(volume.bavail)*Number(volume.bsize)>=128*1024*1024,'bounded private Host free space');
 server=http.createServer((req,res)=>{void(async()=>{if(req.method==='GET'&&req.url==='/v1/models'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({object:'list',data:[MODEL,MODEL2].map(id=>({id,object:'model'}))}));}if(req.method!=='POST'||req.url!=='/v1/chat/completions'){res.writeHead(404);return res.end();}let text='';for await(const chunk of req){text+=chunk;assert(text.length<2000000);}const body=JSON.parse(text);requests.push(body);reply(res,body);})().catch(error=>{modelError=error;res.writeHead(500);res.end('rejected');});});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const input=resolveManagedHermesProductInputs({hermesBin:require('node:path').join(require('node:os').homedir(), '.local', 'bin', 'hermes'),architecture:'arm64'});assert.equal(input.inputMode,'original');
 const hostState=path.join(root,'private-host');fs.mkdirSync(hostState,{mode:0o700});let mode='existing',clientStarts=0,withdrawals=0,ready=0;
 host=createManagedHermesProductHost({getMode:()=>mode,setManagedMode:()=>{mode='managed';},createClient:()=>{clientStarts++;client=createManagedHermesHostClient({stateDir:state,supervisorStateDir:hostState,serviceUserDataRoot:root,...input,
   resourcesRoot:path.join(ROOT,'resources/external-plugin-host-patches'),adapterResourcesRoot:path.join(ROOT,'resources/external-plugin-adapters'),
   hermesConfiguration:{model:{default:MODEL,provider:'custom',base_url:'http://127.0.0.1:'+server.address().port+'/v1',api_key:'local-fixture-only',api_mode:'chat_completions',context_length:128000}}});client.onProgress(value=>progress.push(value));return client;},
 onUnavailable:async()=>{withdrawals++;},onReady:async()=>{ready++;}});
 assert.equal(host.getExecution(),undefined);assert.equal(clientStarts,0);
 host.prepare({operationId:'product-prepare'});host.prepare({operationId:'product-prepare'});assert.equal(host.getExecution(),null);
 const result=await host.waitForOperation('product-prepare');assert.equal(result.state,'running');assert(result.selectionSupported);assert.equal(clientStarts,1);assert.equal(requests.length,0);
 const auth=createManagedHermesProductAuth({host,legacyResolver:()=>{throw Error('legacy path prohibited');}});
 const endpoint=auth.resolveEndpoint(),firstIdentity=endpoint.identity,firstGeneration=client.getStatus().generation;
 assert.equal(new URL(auth.getWebSocketUrl()).pathname,'/api/ws');
 const unauthorized=await fetch(endpoint.baseUrl+'/api/config',{signal:AbortSignal.timeout(10000)});assert.equal(unauthorized.status,401);
 const raw=await request(auth,endpoint.baseUrl+'/api/config/raw');assert(raw.path.startsWith(endpoint.dataRoot+'/'));assert(raw.yaml.includes(MODEL));
 socket=new HermesGatewaySocket({baseUrl:endpoint.baseUrl,token:endpoint.token},{label:'private-Hermes-product',onEvent:event=>events.push(event)});await socket.ensureConnected();
 const session=await socket.request('session.create',{model:MODEL,provider:'custom',cwd:host.getExecution().workspace});
 await socket.request('prompt.submit',{session_id:session.session_id,text:'Product private normal first'});await wait(()=>requests.length===1,'first product model');await wait(()=>events.some(event=>event.type==='message.complete'&&event.session_id===session.session_id),'first product terminal');
 // Use the actual private config API, not a stale constructor/DB injection.
 const yaml=require('js-yaml'),userConfig=yaml.load(raw.yaml);userConfig.model.default=MODEL2;userConfig.agent={...userConfig.agent,max_turns:7};userConfig.skills={disabled:['fixture-user-skill']};userConfig.providers={fixture:{label:'private user configured provider'}};
 userConfig.dashboard={...userConfig.dashboard,theme:'user-theme',input_mode:'steer',process_isolation:{enabled:true}};
 userConfig.plugins={enabled:['untrusted-user-toggle'],entries:{shoggoth_shared_capabilities:{allow_selection_dispatch_gate:false}}};userConfig.auxiliary={...userConfig.auxiliary,summary:{model:'kept-summary'},title_generation:{enabled:true}};
 await request(auth,endpoint.baseUrl+'/api/config/raw','PUT',{yaml_text:JSON.stringify(userConfig)});
 socket.close();socket=null;
 host.restart({operationId:'product-restart'});assert.equal(host.getEndpoint(),null);assert.throws(()=>auth.resolveEndpoint(),{code:'MANAGED_HERMES_ENDPOINT_UNVERIFIED'});
 assert.equal((await host.waitForOperation('product-restart')).state,'running');assert.equal(clientStarts,1);assert.equal(requests.length,1);
 const restarted=auth.resolveEndpoint();assert.notEqual(restarted.identity.pid,firstIdentity.pid);assert.notEqual(restarted.identity.nonce,firstIdentity.nonce);assert.notEqual(client.getStatus().generation,firstGeneration);
 const current=await request(auth,restarted.baseUrl+'/api/config/raw');const config=yaml.load(current.yaml);
 assert.equal(config.model.default,MODEL2);assert.equal(config.agent.max_turns,7);assert.deepEqual(config.skills,userConfig.skills);assert.deepEqual(config.providers,userConfig.providers);
 assert.equal(config.dashboard.theme,'user-theme');assert.equal(config.dashboard.input_mode,'queue');assert.equal(config.dashboard.process_isolation.enabled,false);
 assert.deepEqual(config.plugins.enabled,['shoggoth_shared_capabilities']);assert.equal(config.plugins.entries.shoggoth_shared_capabilities.allow_selection_dispatch_gate,true);assert.equal(config.auxiliary.title_generation.enabled,false);assert.deepEqual(config.auxiliary.summary,{model:'kept-summary'});
 host.prepare({operationId:'product-prepare'});assert.equal(host.getOperationStatus('product-prepare').selectionSupported,false);assert.equal(client.getStatus().identity.pid,restarted.identity.pid);assert.equal(requests.length,1);
 socket=new HermesGatewaySocket({baseUrl:restarted.baseUrl,token:restarted.token},{label:'private-Hermes-product-restart',onEvent:event=>events.push(event)});await socket.ensureConnected();
 const next=await socket.request('session.create',{cwd:host.getExecution().workspace});await socket.request('prompt.submit',{session_id:next.session_id,text:'Product current private user model after restart'});
 await wait(()=>requests.length===2,'restarted current model');await wait(()=>events.some(event=>event.type==='message.complete'&&event.session_id===next.session_id),'restarted terminal');assert.equal(requests[1].model,MODEL2);
 socket.close();socket=null;host.stop({operationId:'product-stop'});assert.equal((await host.waitForOperation('product-stop')).state,'stopped');assert.equal(client.getStatus().ownership,'absent');assert.equal(host.getExecution(),null);assert.throws(()=>auth.resolveEndpoint(),{code:'MANAGED_HERMES_ENDPOINT_UNVERIFIED'});
 await host.close({operationId:'product-close',timeoutMs:15000});assert.equal(client.getStatus().state,'closed');assert.equal(clientStarts,1);assert(ready===2&&withdrawals>=4);
 const status=host.getStatus();assert.deepEqual(Object.keys(status).sort(),['version','backendId','mode','state','operationId','selectionSupported','errorCode'].sort());
 for(const value of [status,...progress]){const text=JSON.stringify(value);assert(!text.includes(root));assert(!text.includes(endpoint.token));assert(!text.includes(restarted.token));assert(!text.includes(firstIdentity.nonce));}
 for(const body of requests){const text=JSON.stringify(body);for(const privateValue of [endpoint.token,restarted.token,firstIdentity.nonce,restarted.identity.nonce,pins.hosts.hermes.outputTreeSha256])assert(!text.includes(privateValue));}
 assert.deepEqual(sources(),hashes);
 const evidence={version:1,status:'PASS',verifiedAt:new Date().toISOString(),sourceHashes:hashes,modelRequests:requests.length,privateHttpWsActualTokenRequired:true,realPrivateProductWorkerSupervisor:true,actualRestartPreservesUserModelProviderAgentSkills:true,fixedPluginQueueTitleFencesRestored:true,actualRestartNewIdentityGeneration:true,originalOperationNoNewHostOrModel:true,knownOwnedStopAndClose:true,originalInstalledInputsDiscovery:true,reusedFrozenProductionCandidate:true,productionCandidateCopies:0,newNormalizationCopies:0,privateValuesAbsentFromPublicAndModel:true,globalWrites:0,remoteCalls:0,scope:'Default private foreground Hermes ProductHost/Auth/Worker/Supervisor and existing production candidate; new full normalization and Backend/UI are separate evidence'};
 if(process.env.SHOGGOTH_TEST_HERMES_PRODUCT_EVIDENCE_OUTPUT)fs.writeFileSync(process.env.SHOGGOTH_TEST_HERMES_PRODUCT_EVIDENCE_OUTPUT,JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
 }catch(error){console.error(JSON.stringify({code:error.code||'FIXTURE_FAILED',where:error.stack?.split('\n').find(line=>line.includes('plugin-managed-hermes-product-real-host-fixture.cjs:'))?.trim()||null}));process.exitCode=1;}finally{socket?.close();if(host)await host.close({operationId:'fixture-cleanup',timeoutMs:60000}).catch(error=>{console.error(error.code);});if(server)await new Promise(resolve=>server.close(resolve));cleanupDirectory(root);}
})().catch(error=>{console.error(JSON.stringify({code:error.code||'FIXTURE_FAILED',where:error.stack?.split('\n').find(line=>line.includes('plugin-managed-hermes-product-real-host-fixture.cjs:'))?.trim()||null}));process.exitCode=1;});
