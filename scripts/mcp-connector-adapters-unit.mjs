#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createAdapter} from '../resources/external-plugin-adapters/openclaw/index.mjs';
const root=path.resolve(import.meta.dirname,'..');
const {MCP_PRODUCT_TOOL_DEFINITIONS}=await import('../app/agent-service/mcp-product-tool-controller.js');
const {SERVICE_PROTOCOL_VERSION}=await import('../app/agent-service/service-protocol-version.js');
const {checkAdapterProtocols}=await import('../app/external-plugin-adapter-protocol.js');
assert.deepEqual(checkAdapterProtocols(path.join(root,'resources/external-plugin-adapters')),[]);
const expected=MCP_PRODUCT_TOOL_DEFINITIONS.filter(tool=>tool.name.startsWith('mcp_server_'));
for(const backend of ['openclaw','hermes']){
  const contract=JSON.parse(fs.readFileSync(path.join(root,'resources/external-plugin-adapters',backend,'mcp-tools.json'),'utf8'));
  assert.equal(contract.serviceProtocolVersion,SERVICE_PROTOCOL_VERSION);assert.deepEqual(contract.tools,expected);assert.equal(contract.sharedSkillTools.length,3);assert.ok(!contract.tools.some(tool=>tool.name.startsWith('connector_')));
  assert.deepEqual(contract.deviceTools,MCP_PRODUCT_TOOL_DEFINITIONS.filter(tool=>/^apple_(calendar|reminders)_/.test(tool.name)));
}
const calls=[];const adapter=createAdapter({credential:()=> 'paired-test-token',instanceId:'test-host',requestService:async(method,params)=>{calls.push({method,params});return {servers:[]};}});
const ctx={agentId:'actual-agent',sessionId:'actual-session',runId:'actual-run'};
await assert.rejects(adapter.tool('mcp_server_list',ctx).execute('missing',{}),/trusted Host/);
assert.equal(calls.length,0);
adapter.beforeToolCall({toolName:'mcp_server_list',toolCallId:'tool-1'},ctx);
await adapter.tool('mcp_server_list',ctx).execute('tool-1',{});
assert.equal(calls[0].method,'mcp.external.tool');assert.deepEqual(calls[0].params.identity,{backendId:'openclaw',instanceId:'test-host',agentId:'actual-agent',sessionId:'actual-session',runId:'actual-run',toolCallId:'tool-1'});
assert.deepEqual(calls[0].params.arguments,{});assert.equal(Object.hasOwn(calls[0].params,'confirmation'),false);
await assert.rejects(adapter.tool('mcp_server_list',ctx).execute('tool-1',{}),/trusted Host/);
assert.equal(calls.length,1);
adapter.beforeToolCall({toolName:'shoggoth_capability_search',toolCallId:'skill-1'},ctx);
await adapter.tool('shoggoth_capability_search',ctx).execute('skill-1',{query:''});assert.equal(calls[1].params.name,'shoggoth_capability_search');
let registeredGate;
adapter.register({registerCapabilitySelectionGate(handler,metadata){registeredGate=handler;assert.equal(metadata.instanceId,'test-host');assert.throws(metadata.onTerminal,e=>e.code==='OPEN_CONNECTOR_RETIRED');return {version:1,adapterId:'shoggoth-shared-capabilities',adapterGeneration:'host-proof',instanceId:'test-host'};},on(){},registerTool(){}});
assert.throws(registeredGate,e=>e.code==='OPEN_CONNECTOR_RETIRED');assert.equal(calls.length,2,'attestation never opens retired selection service');
console.log('PASS OpenClaw trusted Host capture, consumption, global Skill aliases and rejecting managed attestation');
const python=`import importlib.util, pathlib, json, types, sys
root=pathlib.Path(${JSON.stringify(root)})
folder=root/'resources/external-plugin-adapters/hermes'
spec=importlib.util.spec_from_file_location('sgh_mcp_adapter',folder/'__init__.py',submodule_search_locations=[str(folder)])
m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)
calls=[]
def request(method,params,**kwargs):
    calls.append((method,params));return {'servers':[]}
a=m.Adapter('default',request=request,credential=lambda:'paired-test-token',instance_id='test-host')
assert len(m.NAMES)==29 and 'apple_calendar_create' in m.NAMES and 'apple_reminders_update' in m.NAMES
handler=a.handler('mcp_server_list')
assert 'error' in json.loads(handler({},session_id='session-1',task_id='task-1'))
assert len(calls)==0
result=a.middleware(tool_name='mcp_server_list',args={},session_id='session-1',task_id='task-1',turn_id='turn-1',tool_call_id='tool-1',next_call=lambda args:handler(args,session_id='session-1',task_id='task-1'))
assert json.loads(result)=={'servers':[]}
method,params=calls[0]
assert method=='mcp.external.tool'
assert params['identity']=={'backendId':'hermes','instanceId':'test-host','agentId':'hermes-default','sessionId':'session-1','taskId':'task-1','turnId':'turn-1','toolCallId':'tool-1'}
assert 'confirmation' not in params
assert m._group_argument_problems('group_collaborate',{'groupToken':'test','action':'finish','clientActionId':'test','summary':'ok'})==[]
gates=[]
def register_gate(callback,metadata,finish):
    gates.append((callback,finish))
    assert metadata=={'instance_id':'test-host','agent_id':'hermes-default'}
    return types.SimpleNamespace(selection_dispatch={'version':1,'required_adapter_id':'shoggoth_shared_capabilities','adapter_generation':'host-proof',**metadata})
a.register(types.SimpleNamespace(register_selection_dispatch_gate=register_gate,register_middleware=lambda *x:None,register_hook=lambda *x:None,register_tool=lambda **x:None))
for handler in gates[0]:
    try:
        handler({})
    except RuntimeError as error:
        assert error.code=='OPEN_CONNECTOR_RETIRED'
    else:
        raise AssertionError('retired dispatch was accepted')
assert len(calls)==1
print('PASS Hermes trusted middleware identity, direct handler refusal and preserved group validation')
`;
const result=spawnSync('python3',['-B','-c',python],{encoding:'utf8',cwd:root});process.stdout.write(result.stdout||'');if(result.status!==0){process.stderr.write(result.stderr||'');throw Error('Hermes adapter fixture failed');}
