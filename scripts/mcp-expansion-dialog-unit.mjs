import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import ts from '../app/manage-ui/node_modules/typescript/lib/typescript.js';
const require=createRequire(new URL('../app/manage-ui/package.json',import.meta.url));
const React=require('react'),Renderer=require('react-test-renderer');
const recommendations=JSON.parse(fs.readFileSync(new URL('../app/agent-service/data/mcp-featured-presets.json',import.meta.url),'utf8'));
const ids=['chrome-devtools','context7','storybook','filesystem','fetch','time','n8n','variflight','stockmap','eastmoney','ifind','wind','12306','uber','uber-eats'];
const base={id:'fixture-expansion',name:'Fixture',enabled:true,source:{kind:'custom'},auth:{kind:'none'},transport:{kind:'remote',protocol:'streamable-http',url:'https://example.test/mcp'},disabledProfileIds:[],status:'ready',setup:{requiredFields:[],configuredFields:[]},lastCheck:{at:1,toolCount:1,errorCode:null}};
const mutations=[],oauth=[];let current,records=[],language='en',revision=1,dialog;
const api={listMcpSubjects:async()=>({items:[],unavailableBackends:[]}),listMcpConnectors:async()=>({revision,servers:records}),formatMcpError:e=>e.code||'error',
 addMcpConnector:async input=>{mutations.push({kind:'add',input});current={...base,id:`${base.id}-${revision}`,name:input.name,transport:input.option};records.push(current);return {revision:++revision,server:current};},
 rebindMcpConnector:async(id,option,expectedRevision)=>{mutations.push({kind:'rebind',id,option,expectedRevision});current={...current,transport:option};records=records.map(value=>value.id===id?current:value);return {revision:++revision,server:current};},
 saveMcpCredentials:async(id,fields,expectedRevision)=>{assert.ok(Object.keys(fields).length);mutations.push({kind:'credentials',id,fields,expectedRevision});return {revision:++revision,server:current};},
 verifyMcpConnector:async id=>{mutations.push({kind:'verify',id});return {revision,server:current};},startMcpSignIn:async id=>{oauth.push(id);throw Error('Unexpected OAuth');}};
function load(relative,customRequire){const module={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(relative,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,{module,exports:module.exports,require:customRequire,AbortController,URL,setInterval,clearInterval,window:{open(){throw Error('Unexpected sign-in window');}}});return module.exports;}
const helpers=load('../app/manage-ui/src/lib/mcpConnectorUi.ts',require),catalog=load('../app/manage-ui/src/lib/mcpRecommendationCatalog.ts',require);
const Component=load('../app/manage-ui/src/pages/McpConnectorDialog.tsx',name=>{
 if(name==='react')return React;if(name==='react/jsx-runtime')return require(name);
 if(name==='react-i18next')return {useTranslation:()=>({t:key=>key,i18n:{resolvedLanguage:language}})};
 // This suite exercises preset setup/transport, not decorative artwork or
 // tool-list rendering (covered by connector-setup-flow and official tools).
 if(['../components/McpConnectorIcon','../components/ConnectorTools'].includes(name))return {__esModule:true,default:()=>null};
 if(name==='../../../core/flightaware-connector-policy.json')return {__esModule:true,default:JSON.parse(fs.readFileSync(new URL('../app/core/flightaware-connector-policy.json',import.meta.url)))};
 if(name==='../components/Modal')return {__esModule:true,default:({children, footer, subtitle})=>React.createElement('section',{}, children, React.createElement("p", {}, subtitle), footer)};
 if(name==='../components/ui')return {useConfirm:()=>async()=>true};if(name==='../api/mcpConnectors')return api;
 if(name==='../lib/mcpConnectorUi')return helpers;if(name==='../lib/mcpRecommendationCatalog')return catalog;
 if(name==='../../../agent-service/data/mcp-featured-presets.json')return {__esModule:true,default:recommendations};
 if(name.endsWith('.module.css'))return {__esModule:true,default:{}};throw Error('Unexpected import '+name);
}).default;
const serial=v=>JSON.parse(JSON.stringify(v));
const preset=id=>recommendations.find(p=>p.id===id);
async function mount(recommendation,server){current=server;records=server?[server]:[];await Renderer.act(async()=>{dialog=Renderer.create(React.createElement(Component,{recommendation,server,onClose(){},onChanged(){}}));});}
async function unmount(){await Renderer.act(async()=>dialog.unmount());}
const save=()=>{const buttons=dialog.root.findAllByType('button');return ['mcpConnectors.flow.saveConnect','mcpConnectors.flow.checkConnect','mcpConnectors.group.connectAll','mcpConnectors.verify'].map(key=>buttons.find(b=>b.props.children===key)).find(Boolean);};
async function fillLabel(label,value){const node=dialog.root.findAllByType('label').find(l=>l.findAllByType('span').some(s=>String(s.props.children).startsWith(label)));assert.ok(node,'field '+label);await Renderer.act(async()=>node.findByType('input').props.onChange({target:{value}}));}
for(language of ['en','zh-CN'])for(const id of ids){
 const p=preset(id);assert.ok(p);const count=mutations.length;await mount(p);
 assert.equal(mutations.length,count,'opening never installs '+id);assert.equal(oauth.length,0);
 assert.ok(dialog.root.findAllByType('a').some(a=>a.props.href===p.docsUrl));
 const required=(p.fields||[]).filter(f=>f.required).length||p.envKey||p.setup==='token';
 assert.equal(save().props.disabled,!!required,id+' initial gate');
 if(!required){await Renderer.act(async()=>save().props.onClick());assert.equal(mutations.at(-1).kind,'add');assert.ok(helpers.mcpRecommendationMatchesServer(p,serial(current)),id+' keeps management identity');}
 await unmount();
}
for(language of ['en','zh-CN'])for(const id of ['uber','uber-eats']){
 const p=preset(id),denied={...base,name:p.name,transport:{kind:'remote',protocol:'streamable-http',url:p.url},auth:{kind:'none'},status:'failed',lastCheck:{at:1,toolCount:0,errorCode:'MCP_SERVER_ACCESS_DENIED'}};
 await mount(p,denied);
 assert.ok(JSON.stringify(dialog.toJSON()).includes(p.note[language]),id+' shows access requirements and app checkout limits');
 const status=()=>dialog.root.findAllByProps({role:'status'}).map(node=>node.props.children);
 assert.ok(status().includes('mcpConnectors.statuses.failed'),id+' denied access is not connected');
 const count=mutations.length;await Renderer.act(async()=>save().props.onClick());
 assert.equal(mutations.length,count+1);assert.equal(mutations.at(-1).kind,'verify',id+' retries the same saved connector');
 assert.ok(status().includes('mcpConnectors.statuses.failed'));assert.equal(oauth.length,0,id+' never invents an OAuth flow for an access denial');
 await unmount();
}
language='en';
await mount(preset('filesystem'));await fillLabel('Allowed directory','relative-folder');await Renderer.act(async()=>save().props.onClick());assert.equal(dialog.root.findByProps({role:'alert'}).props.children,'MCP_SETUP_REQUIRED');
await fillLabel('Allowed directory','/private/tmp/connector directory with spaces');await Renderer.act(async()=>save().props.onClick());
assert.deepEqual(serial(mutations.at(-1).input.option.packageArgs),['/private/tmp/connector directory with spaces']);assert.equal(mutations.at(-1).input.fields.arguments,undefined);
const installed={...current,transport:{...current.transport,version:'0.9.0'}};await unmount();await mount(preset('filesystem'),installed);
await Renderer.act(async()=>save().props.onClick());assert.equal(mutations.at(-1).kind,'verify','blank input preserves private installed directory');
await Renderer.act(async()=>dialog.root.findAllByType('button').find(b=>b.props.children==='mcpConnectors.flow.configure').props.onClick());
await fillLabel('Allowed directory','/private/tmp/replacement');await Renderer.act(async()=>save().props.onClick());assert.equal(mutations.at(-1).kind,'rebind');assert.equal(mutations.at(-1).option.version,'0.9.0','path changes never upgrade package');await unmount();
await mount(preset('ifind'));assert.equal(dialog.root.findAllByType('input').some(n=>n.props.required&&n.props.type==='password'),true);await fillLabel('iFinD MCP key','opaque:raw+key');await Renderer.act(async()=>save().props.onClick());assert.deepEqual(serial(mutations.at(-1).input.fields.headers),{Authorization:'opaque:raw+key'});assert.equal(JSON.stringify(dialog.toJSON()).includes('opaque:raw+key'),false);await unmount();
for(language of ['en','zh-CN']){
 const p=preset('eastmoney');assert.equal(p.docsUrl,'https://choice.eastmoney.com/mcp/guide');
 await mount(p);assert.ok(JSON.stringify(dialog.toJSON()).includes(p.note[language]));
 await fillLabel(language==='en'?'MX MCP API key':'妙想 MCP API Key','eastmoney-private-canary');
 await Renderer.act(async()=>save().props.onClick());
 assert.deepEqual(serial(mutations.at(-1).input.fields.headers),{em_api_key:'eastmoney-private-canary'});
 assert.equal(JSON.stringify(dialog.toJSON()).includes('eastmoney-private-canary'),false);await unmount();
}
language='en';
for(const id of ['variflight','wind']){
 const p=preset(id);await mount(p);assert.equal(dialog.root.findAllByType('select').length,0,'all services replace endpoint selection');
 if(id==='wind')await fillLabel('mcpConnectors.accessTokenRequired','Bearer opaque:key+value');else await fillLabel('VariFlight API key','variflight-canary');
 const start=mutations.length;await Renderer.act(async()=>save().props.onClick());const adds=mutations.slice(start).filter(value=>value.kind==='add');
 assert.deepEqual(adds.map(value=>value.input.option.url),p.endpoints.map(endpoint=>endpoint.url));assert.equal(records.length,p.endpoints.length);
 for(const value of adds)assert.deepEqual(serial(value.input.fields.headers),id==='wind'?{Authorization:'Bearer opaque:key+value'}:{'X-API-Key':'variflight-canary'});
 assert.ok(helpers.mcpRecommendationMatchesServer(p,serial(current)));assert.equal(dialog.root.findAllByType('input').length,0,'successful setup clears and hides key');await unmount();
}
await mount(preset('storybook'));await fillLabel('mcpConnectors.url','http://127.0.0.1:6010/mcp');await Renderer.act(async()=>save().props.onClick());assert.equal(mutations.at(-1).input.option.url,'http://127.0.0.1:6010/mcp');await unmount();
assert.equal(oauth.length,0);console.log(`PASS ${ids.length} bilingual dialogs: no opening side effects; required credentials; raw auth; all-service setup; private explicit directory and rebind; optional n8n defaults; no implicit OAuth`);
