"use strict";
const fs=require('node:fs');const path=require('node:path');const http=require('node:http');const crypto=require('node:crypto');const assert=require('node:assert/strict');
const {createManagedOpenClawHostClient}=require('../app/managed-openclaw-host-client');
const {client:gatewayClient}=require('./plugin-managed-openclaw-real-host-fixture.cjs');
const repo=path.resolve(__dirname,'..');const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(callback,label,ms=20000){const end=Date.now()+ms;while(Date.now()<end){if(await callback())return;await delay(100);}throw Error(label+' timed out');}
async function main(){
  const root=fs.realpathSync(process.argv[2]);assert.ok(root.startsWith('/private/tmp/sg-managed-openclaw-'));
  const appState=path.join(root,'app-state');const evidenceFile=path.join(root,'worker-public-evidence.json');
  const supervisorStateDir=fs.realpathSync(fs.mkdtempSync('/private/tmp/sg-managed-worker-host-'));fs.chmodSync(supervisorStateDir,0o700);
  let calls=0;const model=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
    calls+=1;JSON.parse(body);res.writeHead(200,{'content-type':'text/event-stream'});
    for(const[delta,finish_reason]of[[{role:'assistant',content:'Worker-owned Host result.'},null],[{},'stop']])
      res.write(`data: ${JSON.stringify({id:'worker-local',object:'chat.completion.chunk',created:1,model:'worker-local',choices:[{index:0,delta,finish_reason}]})}\n\n`);
    res.end('data: [DONE]\n\n');});});
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  const config={models:{mode:'replace',providers:{probe:{baseUrl:`http://127.0.0.1:${model.address().port}/v1`,apiKey:'fixture-only',api:'openai-completions',
    agentRuntime:{id:'openclaw'},models:[{id:'worker-local',name:'Worker Local',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1024}]}}},
    agents:{defaults:{model:{primary:'probe/worker-local'},heartbeat:{every:'0m'}}},tools:{profile:'minimal'}};
  const clientOptions={stateDir:appState,supervisorStateDir,serviceUserDataRoot:supervisorStateDir,resourcesRoot:path.join(repo,'resources/external-plugin-host-patches'),
    adapterResourcesRoot:path.join(repo,'resources/external-plugin-adapters'),sourceRoot:'/opt/homebrew/lib/node_modules/openclaw',
    interpreterPath:(process.env.SHOGGOTH_TEST_OPENCLAW_NODE || require('node:path').join(require('node:os').homedir(), '.local', 'share', 'node', 'v24.21.0', 'bin', 'node')),architecture:'arm64',gatewayConfiguration:config};
  const worker=createManagedOpenClawHostClient(clientOptions);let retiring=null;
  let socket=null;let timer=null;let tickCount=0;let maxTickGap=0;let previous=Date.now();const progress=[];const cases=[];const physical=[];
  worker.onProgress(value=>progress.push(value));
  try{
    await worker.ready;assert.equal(worker.getEndpoint(),null);assert.equal(worker.getExecution(),null);
    timer=setInterval(()=>{const now=Date.now();maxTickGap=Math.max(maxTickGap,now-previous);previous=now;tickCount+=1;},10);
    const before=Date.now();const candidate=await worker.controller.getCandidate({});const hashElapsedMs=Date.now()-before;
    clearInterval(timer);timer=null;assert.ok(candidate);assert.ok(tickCount>=20);assert.ok(maxTickGap<1500);
    assert.equal(worker.getEndpoint(),null);cases.push('actual Worker revalidates full immutable candidate while main-thread heartbeat continues; stored candidate grants no endpoint');
    const first=await worker.controller.activateCandidate({candidateId:candidate.candidateId,operationId:'worker-first'});
    assert.equal(first.healthVerified,true);assert.equal(worker.getStatus().ownership,'managed');assert.equal(worker.getStatus().state,'running');
    const endpoint=worker.getEndpoint();const execution=worker.getExecution();assert.ok(endpoint&&execution);physical.push(endpoint.identity);
    assert.equal(execution.runtimeRoot,candidate.runtimeRoot);assert.equal(execution.interpreterPath,(process.env.SHOGGOTH_TEST_OPENCLAW_NODE || require('node:path').join(require('node:os').homedir(), '.local', 'share', 'node', 'v24.21.0', 'bin', 'node')));
    assert.ok(execution.configPath.startsWith(worker.getStatus().dataRoot+'/'));assert.equal(calls,0);
    cases.push('real manager and supervisor run inside Worker: cold Gateway paused health precedes actual resume and internal endpoint/execution publication');
    const adapters=await worker.request('chat.selection.capabilities',{sessionKey:'agent:main:worker-query',agentId:'main'});
    assert.equal(adapters.adapters.length,1);assert.equal(adapters.adapters[0].adapterId,'shoggoth-shared-capabilities');
    assert.ok(adapters.subject.sessionId);await assert.rejects(worker.request('chat.send',{message:'bypass'}),e=>e.code==='MANAGED_WORKER_METHOD_UNSUPPORTED');
    const op='worker-pause';const paused=await worker.request('gateway.shoggoth.managed.pause',{operationId:op});
    assert.equal(paused.paused,true);assert.equal(worker.getEndpoint(),null);assert.equal(worker.getExecution(),null);
    const resumed=await worker.request('gateway.shoggoth.managed.resume',{operationId:op});assert.equal(resumed.paused,false);assert.ok(worker.getEndpoint());
    assert.equal(calls,0);cases.push('fixed private query/control allowlist resolves actual adapter subject; caller cannot forward model send; actual pause/resume clears and restores ready cache');
    socket=await gatewayClient(worker.getEndpoint().url,worker.getEndpoint().token);
    await socket.request('chat.send',{sessionKey:'agent:main:worker-turn',message:'worker ordinary model proof',idempotencyKey:crypto.randomUUID()});
    await until(()=>calls===1,'actual local model');await until(async()=>JSON.stringify(await worker.request('chat.history',{sessionKey:'agent:main:worker-turn',limit:20})).includes('Worker-owned Host result.'),'persisted worker result');
    socket.close();socket=null;cases.push('published internal endpoint drives actual model and persisted result while private worker query returns real chat history');
    await worker.controller.stopOwned({operationId:'worker-stop-first',timeoutMs:30000});assert.equal(worker.getEndpoint(),null);
    const configPath=path.join(supervisorStateDir,'external-plugin-host-data/openclaw/v1/openclaw.json');const saved=JSON.parse(fs.readFileSync(configPath));
    saved.models.providers.probe.models[0].name='Retained Private Model';saved.agents.defaults.skipBootstrap=true;
    fs.writeFileSync(configPath,JSON.stringify(saved),{mode:0o600});
    const second=await worker.controller.activateCandidate({candidateId:candidate.candidateId,operationId:'worker-second'});assert.equal(second.healthVerified,true);
    physical.push(worker.getEndpoint().identity);assert.notEqual(physical[1].pid,physical[0].pid);assert.throws(()=>process.kill(physical[0].pid,0));
    const retained=JSON.parse(fs.readFileSync(configPath));assert.equal(retained.models.providers.probe.models[0].name,'Retained Private Model');
    assert.equal(retained.models.providers.probe.baseUrl,config.models.providers.probe.baseUrl);
    cases.push('owned stop confirms old child exit; next activation preserves only models/agents/tools from private config and starts a new actual generation');
    assert.ok(progress.every(value=>!JSON.stringify(value).includes(root)&&!Object.hasOwn(value,'token')&&!Object.hasOwn(value,'endpoint')));
    await worker.close({operationId:'worker-final-close',timeoutMs:30000});assert.equal(worker.getStatus().state,'closed');
    for(const identity of physical)assert.throws(()=>process.kill(identity.pid,0));cases.push('owned close drains actual Host, confirms child exit then terminates Worker; progress carries no paths or credentials');
    // Cancel while the genuine manager is synchronously validating the whole
    // candidate. The retirement frame must be pumped before inspect/start.
    retiring=createManagedOpenClawHostClient(clientOptions);await retiring.ready;let retiredClose=null;
    retiring.onProgress(value=>{if(value.operationState==='activateCandidate'&&!retiredClose)
      retiredClose=retiring.close({operationId:'worker-close-during-activate',timeoutMs:30000});});
    const mutation=retiring.controller.activateCandidate({candidateId:candidate.candidateId,operationId:'worker-retired-activation'});
    await assert.rejects(mutation,error=>error.code==='MANAGED_WORKER_OPERATION_RETIRED');
    assert.ok(retiredClose);await retiredClose;assert.equal(retiring.getStatus().state,'closed');
    assert.equal(retiring.getEndpoint(),null);assert.equal(fs.existsSync(path.join(supervisorStateDir,'external-plugin-host-data/openclaw/v1/writer.fence')),false);
    assert.equal(calls,1);cases.push('real Worker close during synchronous candidate activation retires the original operation before any start/resume; owned absent stop confirms no late writer or model');
    const evidence={version:1,status:'PASS',root,supervisorStateDir,candidateId:candidate.candidateId,mainHeartbeat:{tickCount,maxTickGap,hashElapsedMs},
      physicalChildren:physical,cases,modelRequests:calls,additionalSourceCopies:0,globalWrites:0,realAccountRequests:0,
      boundary:'Actual Worker manager/supervisor/Gateway; immutable source reused, no second full dependency copy'};
    fs.writeFileSync(evidenceFile,JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
    process.stdout.write(JSON.stringify({status:'PASS',groups:cases.length,modelRequests:calls,evidence:evidenceFile,mainHeartbeat:evidence.mainHeartbeat})+'\n');
  }finally{
    if(timer)clearInterval(timer);socket?.close();if(worker.getStatus().state!=='closed')try{await worker.close({operationId:'worker-fixture-cleanup',timeoutMs:30000});}catch(error){process.stderr.write('owned worker cleanup pending: '+error.code+'\n');}
    if(retiring&&retiring.getStatus().state!=='closed')try{await retiring.close({operationId:'worker-retire-cleanup',timeoutMs:30000});}catch(error){process.stderr.write('retiring worker cleanup pending: '+error.code+'\n');}
    model.closeAllConnections();await new Promise(resolve=>model.close(resolve));
    if(worker.getStatus().state==='closed'&&(!retiring||retiring.getStatus().state==='closed'))fs.rmSync(supervisorStateDir,{recursive:true,force:true});
  }
}
main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
