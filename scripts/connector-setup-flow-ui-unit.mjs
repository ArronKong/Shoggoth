import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import ts from '../app/manage-ui/node_modules/typescript/lib/typescript.js';
const require=createRequire(new URL('../app/manage-ui/package.json',import.meta.url));
const React=require('react'),Renderer=require('react-test-renderer');
function load(relative,extra={},globals={}) {
 const module={exports:{}};
 const compiled=ts.transpileModule(fs.readFileSync(new URL(relative,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 vm.runInNewContext(compiled,{module,exports:module.exports,AbortController,Event,...globals,require:name=>name in extra?extra[name]:name.endsWith('.module.css')?{__esModule:true,default:{}}:name==='react-i18next'?{useTranslation:()=>({t:key=>key})}:require(name)});
 return module.exports;
}
let calls=0,reject=false,signals=[];
const items=Array.from({length:8},(_,i)=>({name:`read_${i}`,description:`Description ${i}`}));
const Tools=load('../app/manage-ui/src/components/ConnectorTools.tsx',{'../api/mcpConnectors':{listMcpTools:async(id,signal)=>{
 assert.equal(id,'installed');calls++;signals.push(signal);if(reject)throw Error('private error');return {id,available:true,items,totalCount:8,checkedAt:1};
}}}).default;
let ui;
await Renderer.act(async()=>{ui=Renderer.create(React.createElement(Tools,{serverId:'installed',status:'ready',checkedAt:1}));});
assert.equal(calls,0,'collapsed tool details make no request');
const toggle=async open=>Renderer.act(async()=>ui.root.findByType('details').props.onToggle({currentTarget:{open}}));
await toggle(true);assert.equal(calls,1);assert.equal(ui.root.findAllByType('li').length,8);
await Renderer.act(async()=>ui.root.findByType('input').props.onChange({target:{value:'Description 4'}}));
assert.equal(ui.root.findAllByType('li').length,1);assert.equal(calls,1,'search is local');
await toggle(false);assert.equal(signals[0].aborted,true,'closing cancels a stale read');
reject=true;await toggle(true);assert.ok(ui.root.findAllByProps({role:'alert'}).length);assert.equal(JSON.stringify(ui.toJSON()).includes('private error'),false);
reject=false;await Renderer.act(async()=>ui.root.findByType('button').props.onClick());assert.equal(ui.root.findAllByProps({role:'alert'}).length,0);
await Renderer.act(async()=>ui.unmount());
const window=new EventTarget();let saved='[]',fail=false;
window.localStorage={getItem:()=>saved,setItem:(_key,value)=>{if(fail)throw Error('quota');saved=value;}};
const pending=load('../app/manage-ui/src/lib/usePendingConnectors.ts',{}, {window});
let one,two;
function Probe({id}){const state=pending.usePendingConnectors();if(id===1)one=state;else two=state;return null;}
await Renderer.act(async()=>{ui=Renderer.create(React.createElement(React.Fragment,null,React.createElement(Probe,{id:1}),React.createElement(Probe,{id:2})));});
await Renderer.act(async()=>one.add('preset:home-assistant'));
assert.deepEqual(JSON.parse(saved),['preset:home-assistant']);assert.deepEqual([...two.ids],['preset:home-assistant'],'all mounted sections observe the same pending identity');
await Renderer.act(async()=>two.add('preset:home-assistant'));assert.equal(JSON.parse(saved).length,1);
await Renderer.act(async()=>one.remove('preset:home-assistant'));assert.equal(two.ids.length,0);
fail=true;assert.throws(()=>one.add('preset:home-assistant'),/quota/);assert.equal(one.ids.length,0);
await Renderer.act(async()=>ui.unmount());
for(const value of ['{}','bad',JSON.stringify([null,{},'https://example.test?key=secret','preset:home-assistant','preset:home-assistant'])]) {
 const result=pending.readPendingConnectors({getItem:()=>value});assert.ok(result.every(id=>id==='preset:home-assistant'));assert.ok(result.length<=1);
}
console.log('PASS tool details: lazy read, local search, abort, safe error and retry; pending identities: cross-section sync, dedupe, removal, malformed storage and failed writes');
