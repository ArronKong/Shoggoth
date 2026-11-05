import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import ts from '../app/manage-ui/node_modules/typescript/lib/typescript.js';
import { bundledBridgeVersions, loadConnectorDetails } from './fixtures/connector-details-ui.mjs';
const uiRequire=createRequire(new URL('../app/manage-ui/package.json',import.meta.url));
const React=uiRequire('react'),Renderer=uiRequire('react-test-renderer');
const recommendations=JSON.parse(fs.readFileSync(new URL('../app/agent-service/data/mcp-featured-presets.json',import.meta.url),'utf8'));
const server={id:'mcp-ui-update',name:'Update test',source:{kind:'registry',registryName:'org/test',version:'1.0.0'},transport:{kind:'remote',protocol:'streamable-http',url:'https://example.test/mcp'},disabledProfileIds:[],status:'ready',setup:{requiredFields:[],configuredFields:[]},lastCheck:{toolCount:1,errorCode:null}};
const latest={registryName:'org/test',version:'1.0.1',description:'Latest fixture metadata',repositoryUrl:'https://github.com/example/project',options:[{id:'remote:0',transport:server.transport,fields:[]}]};
let reads=0,subjectReads=0,updates=[],observed=[];
const api={getMcpOAuthInfo:async()=>({redirectUri:'http://127.0.0.1:45829/callback'}),listMcpSubjects:async()=>{subjectReads++;return {items:[],unavailableBackends:[]};},searchMcpRegistry:async()=>{reads++;return {items:[latest]};},listMcpConnectors:async()=>({revision:8,servers:[server]}),updateMcpConnector:async(...args)=>{updates.push(args);return {revision:9,server:{...server,source:{...server.source,version:'1.0.1'}}};},formatMcpError:()=> 'safe-error'};
function load(relative,customRequire,globals={}){const module={exports:{}};const compiled=ts.transpileModule(fs.readFileSync(new URL(relative,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;vm.runInNewContext(compiled,{module,exports:module.exports,require:customRequire,AbortController,URL,setInterval,clearInterval,...globals});return module.exports;}
const helpers=load('../app/manage-ui/src/lib/mcpConnectorUi.ts',uiRequire);
const catalog=load('../app/manage-ui/src/lib/mcpRecommendationCatalog.ts',uiRequire);
const connectorDetails=loadConnectorDetails();
const detailsFor=(dialog,key)=>dialog.root.findAllByType('details').find(node=>node.findAllByType('summary')[0]?.props.children==='mcpConnectors.'+key);
let currentLanguage='en';
const authorizations=[];
const mod=load('../app/manage-ui/src/pages/McpConnectorDialog.tsx',name=>{

 if(name==='../components/McpConnectorIcon')return {__esModule:true,default:props=>React.createElement('i',{'data-dialog-icon':props.iconId||props.identity})};
 if(name==='../components/ConnectorTools')return {__esModule:true,default:()=>null};
 if(name==='../components/ConnectorDetails')return connectorDetails;
 if(name==='../../../agent-service/data/mcp-bundled-bridge-versions.json')return bundledBridgeVersions;
 if(name==='react')return React;if(name==='react/jsx-runtime')return uiRequire(name);
 if(name==='react-i18next')return {useTranslation:()=>({t:(key,options)=>key+(options?.version?':'+options.version:''),i18n:{resolvedLanguage:currentLanguage}})};
 if(name==='../components/Modal')return {__esModule:true,default:({children, footer, subtitle,title})=>React.createElement('section',{},React.createElement('header',{},title), children, React.createElement("p", {}, subtitle), footer)};
 if(name==='../components/ui')return {useConfirm:()=>async()=>true};
 if(name==='../api/mcpConnectors')return api;if(name==='../lib/mcpConnectorUi')return helpers;
 if(name==='../lib/mcpRecommendationCatalog')return catalog;
 if(name==='../../../agent-service/data/mcp-featured-presets.json')return {__esModule:true,default:recommendations};
 if(name==='../../../core/flightaware-connector-policy.json')return {__esModule:true,default:JSON.parse(fs.readFileSync(new URL('../app/core/flightaware-connector-policy.json',import.meta.url),'utf8'))};
 if(name.endsWith('.module.css'))return {__esModule:true,default:{}};
 throw Error('Unexpected import '+name);
},{window:{open:href=>authorizations.push(href)}});
let mounted;await Renderer.act(async()=>{mounted=Renderer.create(React.createElement(mod.default,{server,onClose(){},onChanged(){},onLatest:value=>observed.push(value)}));});
assert.equal(subjectReads,0,'connector dialogs do not fetch an agent selector list');
assert.equal(mounted.root.findByProps({'data-connector-footer':true}).findAllByType('button').filter(button=>button.props.children==='mcpConnectors.flow.remove').length,1,'installed connectors expose one Delete action in the common footer');
assert.equal(detailsFor(mounted,'flow.manage'),undefined,'maintenance no longer adds a separate management section');
assert.equal(JSON.stringify(mounted.toJSON()).includes('mcpConnectors.agents'),false,'agent access controls are absent');
assert.equal(reads,1);assert.equal(updates.length,0,'discovery must never install');assert.equal(observed[0].version,'1.0.1');
assert.deepEqual(mounted.root.findAllByType('dd').map(node=>node.children.join('')),['—','1.0.0'],'information uses the installed version, even if a newer version is available');
assert.ok(mounted.root.findAllByType('input').some(input=>input.props.value==='1.0.1'),'target version prefilled');
const update=mounted.root.findAllByType('button').find(button=>button.props.children==='mcpConnectors.update');assert.ok(update);assert.equal(update.props.disabled,false);
await Renderer.act(async()=>{update.props.onClick();await Promise.resolve();await Promise.resolve();});
assert.deepEqual(updates,[['mcp-ui-update','1.0.1',8]],'only the explicit update button mutates');
assert.equal(mounted.root.findAllByType('dd').at(-1).children.join(''),'1.0.1');
await Renderer.act(async()=>mounted.unmount());
console.log('PASS actual dialog component: read-only latest discovery, prefilled target, exact explicit update mutation');

// Installed management must retain its identity without a recommendation prop.
for(const [saved,expected] of [
 [{...server,source:{kind:'registry',registryName:'com.canva.mcp/mcp',version:'1.0.0'}},'com.canva.mcp/mcp'],
 ...JSON.parse(fs.readFileSync(new URL('../app/agent-service/data/official-skill-connectors.json',import.meta.url),'utf8')).map(item=>[{...server,id:`official-${item.id}-a0b0c0d0`,source:{kind:'custom'},transport:{kind:'stdio-command',command:'/managed/Shoggoth'}},item.id]),
 ...['blender-lab','flightaware','ticketmaster'].map(id=>[{...server,source:{kind:'custom'},recommendationId:id,transport:{kind:'stdio-command',command:'/managed/runtime'}},id])
]){
 let dialog;
 try{
  await Renderer.act(async()=>{dialog=Renderer.create(React.createElement(mod.default,{server:saved,onClose(){},onChanged(){}}));});
  assert.equal(dialog.root.findByType('i').props['data-dialog-icon'],expected,'installed management keeps registry/managed presentation identity');
  assert.equal(dialog.root.findAllByType('button').some(button=>button.props.children==='mcpConnectors.add'),false,'an existing record never exposes Add');
 }finally{await Renderer.act(async()=>dialog?.unmount());}
}
console.log('PASS installed dialog identities: registry, eight official components and pinned local recommendations keep icons without an Add action');

// Desktop Figma verifies the installed record without credentials or OAuth.
// First-time setup and restored records use the same path and keep agent access.
{
 const originalApi={...api},verified=[],added=[],rebound=[],ready=[];let dialog,resolveCheck;
 const desktop={...server,id:'figma-desktop',name:'Figma local',source:{kind:'custom'},auth:{kind:'none'},transport:{kind:'remote',protocol:'streamable-http',url:helpers.FIGMA_DESKTOP_URL},disabledProfileIds:['agent-off'],lastCheck:{at:1,toolCount:6,errorCode:null}};
 const item={...latest,name:'Figma MCP Server',registryName:helpers.FIGMA_REGISTRY_NAME};
 let records=[desktop],result=desktop,pending=false;
 Object.assign(api,{
  listMcpConnectors:async()=>({revision:12,servers:records}),
  verifyMcpConnector:async id=>{verified.push(id);if(pending)await new Promise(resolve=>{resolveCheck=resolve;});records=[result];return {revision:13,server:result};},
  addMcpConnector:async input=>{added.push(input);records=[result];return {revision:13,server:result};},
  rebindMcpConnector:async(...args)=>{rebound.push(args);return {revision:13,server:result};},
  saveMcpCredentials:async()=>{assert.fail('desktop connection must never save empty credentials');},
  startMcpSignIn:async()=>{assert.fail('desktop connection must not start OAuth');}
 });
 const mount=async props=>Renderer.act(async()=>{dialog=Renderer.create(React.createElement(mod.default,{allowFigmaDesktop:true,...props,onClose(){},onChanged(){},onReady:value=>ready.push(value)}));});
 const unmount=async()=>Renderer.act(async()=>{dialog.unmount();dialog=null;});
 const button=key=>dialog.root.findAllByType('button').find(node=>node.props.children==='mcpConnectors.'+key || (key==='save' && ['flow.saveConnect','flow.authorize','flow.checkConnect'].some(k=>node.props.children==='mcpConnectors.'+k)) || (key==='signin' && ['flow.authorize','flow.reconnect'].some(k=>node.props.children==='mcpConnectors.'+k)) || (key==='remove' && node.props.children==='mcpConnectors.flow.remove') || (key==='verify' && ['flow.saveConnect','flow.checkConnect'].some(k=>node.props.children==='mcpConnectors.'+k)));
 const text=()=>JSON.stringify(dialog.toJSON());
 try{
  await mount({server:desktop});
  for(const key of ['signin','save','credentials','accessToken','oauthClient','repair','showValue'])assert.equal(text().includes('mcpConnectors.'+key+'"'),false,key+' hidden for desktop');
  assert.equal(detailsFor(dialog,'figmaDesktop.setupTitle').props.open,false,'ready connections collapse setup');
  assert.ok(text().includes(helpers.FIGMA_DESKTOP_URL));
  pending=true;await Renderer.act(async()=>{button('verify').props.onClick();});
  assert.equal(button('figmaDesktop.checking').props.disabled,true,'check prevents repeat submissions');
  await Renderer.act(async()=>{resolveCheck();});pending=false;
  assert.deepEqual(verified,['figma-desktop']);assert.equal(ready.length,1);assert.equal(added.length,0);
  result={...desktop,status:'failed',lastCheck:{at:2,toolCount:0,errorCode:'MCP_SERVER_CONNECTION_FAILED'}};
  await Renderer.act(async()=>button('verify').props.onClick());
  assert.equal(detailsFor(dialog,'figmaDesktop.setupTitle').props.open,true,'failed checks reveal recovery steps');
  assert.ok(text().includes('mcpConnectors.figmaDesktop.failedHint'));assert.equal(button('signin'),undefined);
  result=desktop;await Renderer.act(async()=>button('verify').props.onClick());assert.equal(detailsFor(dialog,'figmaDesktop.setupTitle').props.open,false);
  await unmount();

  records=[];await mount({item});assert.ok(button('figmaDesktop.connect'),'Figma catalog opens desktop setup by default');
  assert.ok(text().includes('mcpConnectors.defaultAccess'),'new desktop setup explains default agent access');
  await Renderer.act(async()=>button('figmaDesktop.remote').props.onClick());assert.ok(button('save'),'remote configuration remains available');
  await Renderer.act(async()=>button('figmaDesktop.desktop').props.onClick());
  await Renderer.act(async()=>button('figmaDesktop.connect').props.onClick());
  assert.deepEqual(JSON.parse(JSON.stringify(added)),[{source:{kind:'custom'},name:'mcpConnectors.figmaDesktop.name',option:desktop.transport,expectedRevision:12}]);
  assert.equal(button('figmaDesktop.connect'),undefined,'subsequent actions use the installed record');
  await unmount();

  records=[desktop];await mount({item});await Renderer.act(async()=>button('figmaDesktop.connect').props.onClick());
  assert.equal(added.length,1,'a stale add dialog reuses the existing desktop connector');assert.equal(verified.at(-1),desktop.id);await unmount();
  const disabled={...desktop,status:'disabled'};records=[disabled];await mount({server:disabled});
  await Renderer.act(async()=>button('figmaDesktop.reconnect').props.onClick());
  assert.deepEqual(JSON.parse(JSON.stringify(rebound)),[[desktop.id,desktop.transport,12]]);assert.deepEqual(ready.at(-1).disabledProfileIds,['agent-off']);await unmount();

  records=[{...desktop,transport:{...desktop.transport,url:'https://different.example/mcp'}}];await mount({server:disabled});
  await Renderer.act(async()=>button('figmaDesktop.reconnect').props.onClick());
  assert.equal(rebound.length,1,'stale desktop UI must not overwrite a changed transport');assert.equal(dialog.root.findByProps({role:'alert'}).props.children,'safe-error');
  await unmount();await mount({item,allowFigmaDesktop:undefined});
  assert.ok(button('save'),'scoped requests keep the registry setup path by default');assert.equal(button('figmaDesktop.connect'),undefined);assert.equal(button('figmaDesktop.desktop'),undefined);
  console.log('PASS actual Figma desktop dialog: verify, busy state, failure recovery, local add, remote opt-in, duplicate prevention and safe disabled rebind without credential/OAuth calls');
 }finally{if(dialog)await unmount();for(const key of Object.keys(api))delete api[key];Object.assign(api,originalApi);}
}

// A server without DCR must offer a usable credential path instead of another login loop.
{
 const originalApi={...api},saved=[],ready=[];let signinCalls=0;
 const failed={...server,name:'GitHub',source:{kind:'custom'},status:'failed',auth:{kind:'none'},lastCheck:{toolCount:0,errorCode:'MCP_AUTH_REQUIRED'}};
 let current=failed,dialog;
 Object.assign(api,{
  listMcpConnectors:async()=>({revision:8,servers:[current]}),
  startMcpSignIn:async()=>{signinCalls++;if(current.auth.kind!=='oauth-client')throw Object.assign(Error('private diagnostic'),{code:'MCP_OAUTH_CLIENT_REQUIRED'});return {signInId:'manual-client-signin',status:'pending',authorizationUrl:'https://auth.example.test/authorize'};},
  getMcpOAuthInfo:async()=>({redirectUri:'http://127.0.0.1:18873/callback'}),cancelMcpSignIn:async()=>({}),
  saveMcpCredentials:async(id,fields,revision)=>{saved.push({id,fields,revision});current={...current,status:fields.oauthClient?'signedOut':'ready',auth:{kind:fields.oauthClient?'oauth-client':'headers'},setup:{requiredFields:[],configuredFields:fields.oauthClient?['oauthClient:clientId']:['header:Authorization']},lastCheck:{toolCount:fields.oauthClient?0:1,errorCode:null}};return {revision:9,server:current};}
 });
 const mount=async()=>Renderer.act(async()=>{dialog=Renderer.create(React.createElement(mod.default,{server:current,onClose(){},onChanged(){},onReady:value=>ready.push(value)}));});
 const button=key=>dialog.root.findAllByType('button').find(node=>node.props.children==='mcpConnectors.'+key || (key==='save' && ['flow.saveConnect','flow.authorize','flow.checkConnect'].some(k=>node.props.children==='mcpConnectors.'+k)) || (key==='signin' && ['flow.authorize','flow.reconnect'].some(k=>node.props.children==='mcpConnectors.'+k)) || (key==='remove' && node.props.children==='mcpConnectors.flow.remove') || (key==='verify' && ['flow.saveConnect','flow.checkConnect'].some(k=>node.props.children==='mcpConnectors.'+k)));
 const fill=async(key,value)=>Renderer.act(async()=>{const label=dialog.root.findAllByType('label').find(node=>node.findAllByType('span').some(span=>span.props.children==='mcpConnectors.'+key));assert.ok(label,'credential input '+key);label.findByType('input').props.onChange({target:{value}});});
 try{
  await mount();await Renderer.act(async()=>button('signin').props.onClick());
  assert.equal(signinCalls,1);assert.equal(detailsFor(dialog,'flow.advanced').props.open,true,'manual auth error opens credential setup');
  assert.ok(button('configureOAuth'),'unsupported automatic login changes into explicit client setup');
  await fill('accessToken',' Bearer token-ui-canary ');
  const tokenInput=dialog.root.findAllByType('input').find(node=>node.props.value===' Bearer token-ui-canary ');assert.equal(tokenInput.props.type,'password');
  await Renderer.act(async()=>button('save').props.onClick());
  assert.deepEqual(JSON.parse(JSON.stringify(saved[0])),{id:server.id,fields:{headers:{Authorization:'Bearer token-ui-canary'}},revision:8});
  assert.equal(signinCalls,1,'token recovery must not start OAuth again');assert.equal(ready.length,1);
  assert.equal(dialog.root.findAllByType('input').some(node=>String(node.props.value).includes('token-ui-canary')),false,'submitted token is cleared');
  await Renderer.act(async()=>dialog.unmount());

  current=failed;await mount();await Renderer.act(async()=>button('signin').props.onClick());
  await Renderer.act(async()=>button('configureOAuth').props.onClick());
  await fill('clientId','user-client-id');await fill('clientSecret','client-ui-canary');
  await Renderer.act(async()=>button('save').props.onClick());
  assert.deepEqual(JSON.parse(JSON.stringify(saved[1].fields)),{oauthClient:{clientId:'user-client-id',clientSecret:'client-ui-canary'}});
  assert.deepEqual(authorizations,['https://auth.example.test/authorize']);
  assert.equal(dialog.root.findAllByType('input').some(node=>String(node.props.value).includes('client-ui-canary')),false);
  console.log('PASS actual auth dialog: missing client reveals secure setup, Bearer token recovers without OAuth, supplied client resumes browser authorization, submitted secrets cleared');
 }finally{if(dialog)await Renderer.act(async()=>dialog.unmount());for(const key of Object.keys(api))delete api[key];Object.assign(api,originalApi);}
}

// Device login exposes the user code, opens the verification page and verifies
// the same installed connector after browser approval. No developer setup.
{
 const originalApi={...api},cancelled=[],verified=[],ready=[];let dialog;
 const pending={signInId:'device-ui',status:'pending',flow:'device',userCode:'ABCD-EFGH',authorizationUrl:'https://github.com/login/device',redirectUri:null,installationUrl:'https://github.com/apps/shoggoth-desktop/installations/new',expiresAt:Date.now()+900000};
 const current={...server,status:'signedOut',auth:{kind:'oauth-dcr'},source:{kind:'custom'}};
 Object.assign(api,{
  startMcpSignIn:async()=>pending,getMcpSignIn:async()=>({...pending,status:'authorized',userCode:null,authorizationUrl:null}),
  verifyMcpConnector:async id=>{verified.push(id);return {revision:9,server:{...current,status:'ready'}};},
  cancelMcpSignIn:async id=>{cancelled.push(id);return {...pending,status:'cancelled'};}
 });
 try{
  await Renderer.act(async()=>{dialog=Renderer.create(React.createElement(mod.default,{server:current,onClose(){},onChanged(){},onReady:value=>ready.push(value)}));});
  await Renderer.act(async()=>dialog.root.findAllByType('button').find(b=>['flow.authorize','flow.reconnect'].some(label=>b.props.children==='mcpConnectors.'+label)).props.onClick());
  assert.equal(dialog.root.findByProps({'data-device-user-code':true}).props.children,'ABCD-EFGH');
  assert.ok(dialog.root.findAllByType('a').some(a=>a.props.href===pending.installationUrl));
  assert.equal(dialog.root.findAllByType('code').some(c=>String(c.props.children).includes('18873')),false,'device flow has no callback setup');
  assert.equal(authorizations.at(-1),'https://github.com/login/device');
  assert.ok(dialog.root.findAllByType('input').every(input=>input.props.disabled),'fields stay locked while browser authorization is pending');
  await Renderer.act(async()=>{await new Promise(resolve=>setTimeout(resolve,1650));});
  assert.deepEqual(verified,[server.id]);assert.equal(ready.length,1);assert.equal(dialog.root.findAllByProps({'data-device-user-code':true}).length,0);
  await Renderer.act(async()=>dialog.unmount());assert.deepEqual(cancelled,[],'completed login is not cancelled on unmount');
  console.log('PASS actual device dialog: code, verification URL, own repository selection, completed status and same-connector readiness');
 }finally{for(const key of Object.keys(api))delete api[key];Object.assign(api,originalApi);}
}

// Recommended official remotes use the normal custom connector flow when the
// registry does not publish their OAuth configuration. Opening never installs.
{
 const originalApi={...api},added=[],signedIn=[],cancelled=[];let dialog,current;
 Object.assign(api,{
  listMcpConnectors:async()=>({revision:12,servers:[]}),
  addMcpConnector:async input=>{added.push(input);current={...server,id:'recommended-'+added.length,name:input.name,source:input.source,transport:input.option,status:'signedOut',auth:{kind:'oauth-dcr'}};return {revision:13,server:current};},
  startMcpSignIn:async id=>{signedIn.push(id);return {signInId:'signin-'+id,status:'pending',authorizationUrl:'https://auth.example.test/authorize'};},
  cancelMcpSignIn:async id=>{cancelled.push(id);return {};}
 });
 const mount=async props=>Renderer.act(async()=>{dialog=Renderer.create(React.createElement(mod.default,{...props,onClose(){},onChanged(){}}));});
 const save=()=>dialog.root.findAllByType('button').find(node=>['flow.saveConnect','flow.authorize','flow.checkConnect'].some(key=>node.props.children==='mcpConnectors.'+key));
 try{
  for(const recommendation of recommendations.filter(value=>!value.registryName && (!value.setup || value.setup==='oauth'))){
   await mount({recommendation});
   assert.equal(added.length,signedIn.length,'opening a recommendation does not add or sign in');
   assert.ok(dialog.root.findAllByType('input').some(node=>node.props.value===recommendation.url));
   assert.ok(dialog.root.findAllByType('input').some(node=>node.props.value===recommendation.name));
   assert.ok(!dialog.root.findAllByType('a').some(node=>node.props.href===recommendation.docsUrl),'the guide is hidden before adding');
   if(recommendation.note)assert.ok(dialog.root.findAllByType('p').some(node=>node.props.children===recommendation.note.en));
   await Renderer.act(async()=>save().props.onClick());
   assert.deepEqual(JSON.parse(JSON.stringify(added.at(-1))),{source:{kind:'custom'},option:{kind:'remote',protocol:'streamable-http',url:recommendation.url},fields:{},expectedRevision:12,name:recommendation.name});
   assert.equal(signedIn.at(-1),current.id,'saved remote continues into the existing OAuth flow');
   assert.ok(dialog.root.findAllByType('a').some(node=>node.props.href===recommendation.docsUrl),'the guide is visible after adding');
   await Renderer.act(async()=>dialog.unmount());dialog=null;
  }
  assert.equal(added.length,24);assert.equal(cancelled.length,24);
  const registryPresets=[...recommendations.filter(value=>value.registryName),{...recommendations.find(value=>value.id==='lovable'),registryName:'dev.lovable/fixture'}];
  for(const recommendation of registryPresets){
   const remote={id:'remote:1',transport:{kind:'remote',protocol:'streamable-http',url:new URL(recommendation.url).href},fields:[]};
   const tokenPackage={id:'package:0',transport:{kind:'stdio-package',registryType:'npm',identifier:'fixture-mcp',version:'1.0.0'},fields:[{name:'API_KEY',location:'env',required:true,secret:true}]};
   const item={registryName:recommendation.registryName,name:recommendation.name,version:'1.0.0',options:[tokenPackage,remote]};
   await mount({item,recommendation});assert.equal(dialog.root.findByType('select').props.value,'remote:1','preferred OAuth remote wins over package order');
   assert.equal(dialog.root.findAllByType('input').some(node=>node.props.required),false,'OAuth recommendation does not demand an API key');
   await Renderer.act(async()=>dialog.unmount());dialog=null;
   await mount({item:{...item,options:[tokenPackage]},recommendation});assert.equal(save().props.disabled,true,'a missing OAuth option cannot silently select an executable');
   await Renderer.act(async()=>dialog.unmount());dialog=null;
  }
  console.log('PASS recommended OAuth dialogs: twenty-four official OAuth remote presets including creative services, no implicit install, no API key, browser sign-in and preferred registry remotes with safe drift handling');
 }finally{if(dialog)await Renderer.act(async()=>dialog.unmount());for(const key of Object.keys(api))delete api[key];Object.assign(api,originalApi);}
}

// Official Blender uses its own Python module; opening setup must not install or
// mistake the unrelated PyPI blender-mcp package for Blender Lab.
{
 const originalApi={...api},added=[],verified=[],removed=[];let dialog,current;
 const recommendation=recommendations.find(value=>value.id==='blender-lab');
 const executable='/Users/fixture/blender_mcp/mcp/.venv/bin/python';
 Object.assign(api,{
  listMcpConnectors:async()=>({revision:12,servers:current?[current]:[]}),
  addMcpConnector:async input=>{added.push(input);current={...server,id:'blender-local',name:input.name,source:input.source,transport:input.option,status:'failed',auth:{kind:'none'},lastCheck:{toolCount:0,errorCode:'MCP_SERVER_CONNECTION_FAILED'}};return {revision:13,server:current};},
  verifyMcpConnector:async id=>{verified.push(id);current={...current,status:'ready',lastCheck:{toolCount:3,errorCode:null}};return {revision:14,server:current};},
  startMcpSignIn:async()=>{throw Error('Blender Lab must not start OAuth');},
  removeMcpConnector:async(id,revision)=>{removed.push({id,revision});current=null;return {revision:15,removed:{id}};},
 });
 const button=key=>dialog.root.findAllByType('button').find(node=>node.props.children==='mcpConnectors.'+key || (key==='save' && ['flow.saveConnect','flow.authorize','flow.checkConnect'].some(k=>node.props.children==='mcpConnectors.'+k)) || (key==='signin' && ['flow.authorize','flow.reconnect'].some(k=>node.props.children==='mcpConnectors.'+k)) || (key==='remove' && node.props.children==='mcpConnectors.flow.remove') || (key==='verify' && ['flow.saveConnect','flow.checkConnect'].some(k=>node.props.children==='mcpConnectors.'+k)));
 try{
  for(const language of ['en','zh-CN']){
   currentLanguage=language;
   await Renderer.act(async()=>{dialog=Renderer.create(React.createElement(mod.default,{recommendation,onClose(){},onChanged(){}}));});
   assert.equal(added.length,0,'opening official local setup never installs or downloads');
   assert.equal(button('save').props.disabled,true,'an actual installed Python path is required');
   for(const key of ['remote','paste','signin'])assert.equal(button(key),undefined);
   assert.equal(dialog.root.findAllByType('span').some(n=>n.props.children==='mcpConnectors.oauthClient'),false);
   assert.deepEqual(dialog.root.findByType('ol').findAllByType('li').map(n=>n.children.join('')),recommendation.setupSteps.map(v=>v[language]));
   assert.ok(dialog.root.findAllByType('textarea').some(n=>n.props.value==='["-m","blmcp"]'));
   if(language==='en'){await Renderer.act(async()=>dialog.unmount());dialog=null;continue;}
   const command=dialog.root.findAllByType('label').find(n=>n.findAllByType('span').some(s=>s.props.children==='mcpConnectors.commandLabel')).findByType('input');
   await Renderer.act(async()=>command.props.onChange({target:{value:executable}}));
   assert.equal(button('save').props.disabled,false);
   await Renderer.act(async()=>button('save').props.onClick());
   assert.deepEqual(JSON.parse(JSON.stringify(added[0])),{source:{kind:'custom'},option:{kind:'stdio-command',command:executable,args:['-m','blmcp'],cwd:''},fields:{},expectedRevision:12,name:'Blender Lab'});
   assert.ok(dialog.root.findAll(n=>typeof n.type==='string').some(n=>n.props['data-state']==='failed'),'a missing local service remains failed');
   await Renderer.act(async()=>button('verify').props.onClick());
   assert.deepEqual(verified,['blender-local']);assert.equal(added.length,1,'retry verifies the saved record without reinstalling');
   assert.ok(dialog.root.findAll(n=>typeof n.type==='string').some(n=>n.props['data-state']==='ready'));
  }
  await Renderer.act(async()=>dialog.unmount());
  const {publicMcpServer}=createRequire(import.meta.url)('../app/agent-service/native-mcp-store');
  current=publicMcpServer(current);
  assert.equal(current.transport.args,undefined);
  assert.equal(helpers.mcpRecommendationMatchesServer(recommendation,current),true);
  await Renderer.act(async()=>{dialog=Renderer.create(React.createElement(mod.default,{server:current,recommendation,onClose(){},onChanged(){}}));});
  await Renderer.act(async()=>button('flow.configure').props.onClick());
  assert.equal(dialog.root.findByType('ol').findAllByType('li').length,3,'reopening settings retains official setup');
  assert.equal(button('signin'),undefined);
  await Renderer.act(async()=>button('verify').props.onClick());
  assert.equal(verified.length,2);assert.equal(added.length,1);
  await Renderer.act(async()=>button('remove').props.onClick());
  assert.deepEqual(removed,[{id:'blender-local',revision:12}]);
  console.log('PASS Blender Lab setup: bilingual official instructions, required local Python, blmcp module, no OAuth or implicit install, and failure recovery');
 }finally{if(dialog)await Renderer.act(async()=>dialog.unmount());currentLanguage='en';for(const key of Object.keys(api))delete api[key];Object.assign(api,originalApi);}
}

// Lifestyle presets distinguish local apps, public search, own instances, API keys and restricted providers.
{
 const originalApi={...api},added=[],signedIn=[];let dialog;
 const preset=id=>recommendations.find(value=>value.id===id);
 Object.assign(api,{
  listMcpConnectors:async()=>({revision:12,servers:[]}),
  getMcpOAuthInfo:async()=>({redirectUri:'http://127.0.0.1:18873/mcp/oauth/callback'}),
  addMcpConnector:async input=>{added.push(input);return {revision:13,server:{...server,id:input.name,source:input.source,transport:input.option,status:input.name==='Home Assistant'?'signedOut':'ready',auth:{kind:input.fields.oauthClient?'oauth-client':'none'}}};},
  startMcpSignIn:async id=>{signedIn.push(id);return {signInId:'lifestyle-signin',status:'authorized'};},
 });
 const mount=async id=>Renderer.act(async()=>{dialog=Renderer.create(React.createElement(mod.default,{recommendation:preset(id),onClose(){},onChanged(){}}));});
 const unmount=async()=>{await Renderer.act(async()=>dialog.unmount());dialog=null;};
 const button=key=>dialog.root.findAllByType('button').find(node=>node.props.children==='mcpConnectors.'+key || (key==='save' && ['flow.saveConnect','flow.authorize','flow.checkConnect'].some(k=>node.props.children==='mcpConnectors.'+k)) || (key==='signin' && ['flow.authorize','flow.reconnect'].some(k=>node.props.children==='mcpConnectors.'+k)) || (key==='remove' && node.props.children==='mcpConnectors.flow.remove') || (key==='verify' && ['flow.saveConnect','flow.checkConnect'].some(k=>node.props.children==='mcpConnectors.'+k)));
 const field=key=>dialog.root.findAllByType('label').find(node=>node.findAllByType('span').some(span=>span.props.children==='mcpConnectors.'+key)).findByType('input');
 try{
  await mount('strava');assert.equal(button('save'),undefined);assert.equal(dialog.root.findAllByType('input').length,0);
  assert.equal(dialog.root.findAllByType('a').length,0);assert.equal(added.length,0);await unmount();
  await mount('kiwi');assert.equal(JSON.stringify(dialog.toJSON()).includes('mcpConnectors.oauthRecommendationHint'),false);
  await Renderer.act(async()=>button('save').props.onClick());assert.equal(added.at(-1).option.url,preset('kiwi').url);assert.deepEqual(JSON.parse(JSON.stringify(added.at(-1).fields)),{});assert.equal(signedIn.length,0);assert.equal(button('signin'),undefined);await unmount();
  for(const id of ['fantastical','day-one']){
   await mount(id);assert.equal(field('commandLabel').props.value,preset(id).transport.command);
   assert.equal(dialog.root.findAllByType('textarea').some(node=>node.props.value===JSON.stringify(preset(id).transport.args)),true);
   await Renderer.act(async()=>button('save').props.onClick());
   assert.deepEqual(JSON.parse(JSON.stringify(added.at(-1).option)),{...preset(id).transport,cwd:''});assert.equal(signedIn.length,0);await unmount();
  }
  await mount('home-assistant');assert.equal(button('save').props.disabled,true,'own instance needs an address');
  await Renderer.act(async()=>field('instanceUrl').props.onChange({target:{value:'https://home.example.test/api/mcp'}}));
  assert.equal(button('save').props.disabled,false);await Renderer.act(async()=>button('save').props.onClick());
  assert.deepEqual(JSON.parse(JSON.stringify(added.at(-1).fields)),{oauthClient:{clientId:'http://127.0.0.1:18873'}});
  assert.equal(added.at(-1).option.url,'https://home.example.test/api/mcp');assert.deepEqual(signedIn,['Home Assistant']);await unmount();
  await mount('amap');assert.equal(button('save').props.disabled,true);
  const key=dialog.root.findAllByType('input').find(node=>node.props.required);assert.equal(key.props.type,'password');
  await Renderer.act(async()=>key.props.onChange({target:{value:'amap-test-key'}}));
  assert.equal(button('save').props.disabled,false);await Renderer.act(async()=>button('save').props.onClick());
  assert.deepEqual(JSON.parse(JSON.stringify(added.at(-1).option)),preset('amap').transport);
  assert.deepEqual(JSON.parse(JSON.stringify(added.at(-1).fields)),{env:{AMAP_MAPS_API_KEY:'amap-test-key'}});
  assert.equal(JSON.stringify(added.at(-1).option).includes('amap-test-key'),false);
  assert.equal(dialog.root.findAllByType('input').some(node=>node.props.value==='amap-test-key'),false,'submitted key is cleared');
  assert.equal(signedIn.length,1);await unmount();
  console.log('PASS lifestyle dialogs: all nine additions, no implicit install, restricted guide, public Kiwi, exact native commands, Home Assistant public client and masked Amap key');
 }finally{if(dialog)await unmount();for(const key of Object.keys(api))delete api[key];Object.assign(api,originalApi);}
}

// Official providers with additional setup must request their real prerequisites
// before saving, keep credentials out of transport, and never invent OAuth flows.
{
 const originalApi={...api},added=[],signedIn=[],saved=[],verified=[];let dialog,current;
 const preset=id=>recommendations.find(value=>value.id===id);
 const decode=value=>JSON.parse(JSON.stringify(value));
 Object.assign(api,{
  listMcpConnectors:async()=>({revision:12,servers:[]}),
  getMcpOAuthInfo:async()=>({redirectUri:'http://127.0.0.1:18873/mcp/oauth/callback'}),
  addMcpConnector:async input=>{added.push(input);current={...server,id:'configured-'+added.length,name:input.name,source:input.source,transport:input.option,status:input.fields.oauthClient?'signedOut':'ready',auth:{kind:input.fields.oauthClient?'oauth-client':input.fields.headers?'headers':'none'}};return {revision:13,server:current};},
  startMcpSignIn:async id=>{signedIn.push(id);return {signInId:'configured-signin-'+id,status:'authorized'};},
  saveMcpCredentials:async(id,fields)=>{saved.push({id,fields});return {revision:14,server:{...current,status:'ready'}};},
  verifyMcpConnector:async id=>{verified.push(id);return {revision:14,server:{...current,status:'ready'}};},
 });
 const mount=async recommendation=>Renderer.act(async()=>{dialog=Renderer.create(React.createElement(mod.default,{recommendation,onClose(){},onChanged(){}}));});
 const unmount=async()=>{await Renderer.act(async()=>dialog.unmount());dialog=null;};
 const button=key=>dialog.root.findAllByType('button').find(node=>node.props.children==='mcpConnectors.'+key || (key==='save' && ['flow.saveConnect','flow.authorize','flow.checkConnect'].some(k=>node.props.children==='mcpConnectors.'+k)) || (key==='signin' && ['flow.authorize','flow.reconnect'].some(k=>node.props.children==='mcpConnectors.'+k)) || (key==='remove' && node.props.children==='mcpConnectors.flow.remove') || (key==='verify' && ['flow.saveConnect','flow.checkConnect'].some(k=>node.props.children==='mcpConnectors.'+k)));
 const field=key=>dialog.root.findAllByType('label').find(node=>node.findAllByType('span').some(span=>span.props.children==='mcpConnectors.'+key)).findByType('input');
 const fill=async(node,value)=>Renderer.act(async()=>node.props.onChange({target:{value}}));
 try{
  const clients=recommendations.filter(value=>value.setup==='oauth-client');assert.equal(clients.length,11);
  for(const recommendation of clients){
   const before=added.length;await mount(recommendation);assert.equal(added.length,before,'opening never installs');
   assert.equal(button('save').props.disabled,true);assert.equal(detailsFor(dialog,'flow.advanced').props.open,true,'required credentials are expanded');
   assert.ok(dialog.root.findAllByType('code').some(node=>node.props.children==='http://127.0.0.1:18873/mcp/oauth/callback'),'real callback is shown');
   await Renderer.act(async()=>button('save').props.onClick());assert.equal(added.length,before,'guard also protects programmatic submission');
   await fill(field('clientId'),'client-fixture');assert.equal(button('save').props.disabled,true);
   const secret=field('clientSecretRequired');assert.equal(secret.props.type,'password');await fill(secret,'client-secret-canary');
   assert.equal(button('save').props.disabled,false);await Renderer.act(async()=>button('save').props.onClick());
   assert.deepEqual(decode(added.at(-1)),{source:{kind:'custom'},name:recommendation.name,option:{kind:'remote',protocol:'streamable-http',url:recommendation.url},fields:{oauthClient:{clientId:'client-fixture',clientSecret:'client-secret-canary'}},expectedRevision:12});
   assert.equal(signedIn.at(-1),current.id);assert.equal(JSON.stringify(added.at(-1).option).includes('client-secret-canary'),false);
   assert.equal(dialog.root.findAllByType('input').some(node=>node.props.value==='client-secret-canary'),false);
   const savedBefore=saved.length;await Renderer.act(async()=>button('save').props.onClick());
   assert.equal(saved.length,savedBefore,'saving untouched fields must not rewrite installed OAuth credentials');assert.equal(verified.at(-1),current.id);
   await unmount();
  }
  await mount(preset('dropbox'));await fill(field('accessToken'),'Bearer token-canary');
  assert.equal(button('save').props.disabled,false,'an explicit access token can be used instead of client credentials');
  const authBefore=signedIn.length;await Renderer.act(async()=>button('save').props.onClick());
  assert.deepEqual(decode(added.at(-1).fields),{headers:{Authorization:'Bearer token-canary'}});assert.equal(signedIn.length,authBefore);await unmount();

  for(const id of ['highlevel','tessie','shopify-ucp','mijia','luckin','mcdonalds']){
   const recommendation=preset(id),before=signedIn.length;await mount(recommendation);
   assert.equal(button('save').props.disabled,true);assert.equal(field('accessTokenRequired').props.type,'password');
   if(!recommendation.url)await fill(field('url'),'https://store.example.test/api/ucp/mcp');
   await fill(field('accessTokenRequired'),'token-canary');
   for(const input of dialog.root.findAllByType('input').filter(node=>node.props.required))await fill(input,id==='highlevel'?'location-fixture':'192.0.2.1');
   assert.equal(button('save').props.disabled,false);await Renderer.act(async()=>button('save').props.onClick());
   const headers={Authorization:'Bearer token-canary',...(id==='highlevel'?{locationId:'location-fixture'}:id==='shopify-ucp'?{'Shopify-Buyer-IP':'192.0.2.1'}:{})};
   assert.deepEqual(decode(added.at(-1).fields),{headers});assert.equal(signedIn.length,before);assert.equal(button('signin'),undefined);
   assert.equal(JSON.stringify(added.at(-1).option).includes('token-canary'),false);
   assert.equal(dialog.root.findAllByType('input').some(node=>String(node.props.value).includes('token-canary')),false,'submitted key is cleared');await unmount();
  }
  await mount(preset('google-places'));assert.equal(button('save').props.disabled,true);
  const mapKey=dialog.root.findAllByType('input').find(node=>node.props.required);assert.equal(mapKey.props.type,'password');await fill(mapKey,'maps-key-canary');
  await Renderer.act(async()=>button('save').props.onClick());assert.deepEqual(decode(added.at(-1).fields),{headers:{'X-Goog-Api-Key':'maps-key-canary'}});assert.equal(button('signin'),undefined);await unmount();
  await mount(preset('didi'));assert.equal(button('save').props.disabled,true);
  const didiKey=dialog.root.findAllByType('input').find(node=>node.props.required);assert.equal(didiKey.props.type,'password');await fill(didiKey,'didi-key-canary');
  await Renderer.act(async()=>button('save').props.onClick());assert.deepEqual(decode(added.at(-1).fields),{query:{key:'didi-key-canary'}});
  assert.equal(added.at(-1).option.url,'https://mcp.didichuxing.com/mcp-servers');assert.equal(JSON.stringify(added.at(-1).option).includes('didi-key-canary'),false);
  assert.equal(dialog.root.findAllByType('input').some(node=>node.props.value==='didi-key-canary'),false);assert.equal(button('signin'),undefined);await unmount();
  await mount(preset('tailscale'));assert.equal(button('save').props.disabled,true);await fill(field('url'),'https://aperture.example.test/v1/mcp');
  await Renderer.act(async()=>button('save').props.onClick());assert.deepEqual(decode(added.at(-1).fields),{},'generic deployments do not acquire Home Assistant OAuth client IDs');await unmount();
  for(const id of ['link-by-stripe','1password']){
   const recommendation=preset(id);await mount(recommendation);await Renderer.act(async()=>button('save').props.onClick());
   assert.deepEqual(decode(added.at(-1).option),{...recommendation.transport,...(id==='1password'?{cwd:''}:{})});await unmount();
  }
  await mount(preset('quickbooks'));assert.equal(button('save').props.disabled,true);
  await fill(field('commandLabel'),'/Users/fixture/quickbooks/dist/index.js');
  const inputs=dialog.root.findAllByType('input').filter(node=>node.props.required);
  assert.equal(inputs.length,6);assert.equal(inputs[1].props.type,'password');assert.equal(inputs[2].props.type,'password');
  for(const [index,input] of inputs.entries())if(!input.props.value)await fill(input,'fixture-'+index);
  assert.equal(button('save').props.disabled,false);await Renderer.act(async()=>button('save').props.onClick());
  assert.equal(added.at(-1).fields.env.QUICKBOOKS_ENVIRONMENT,'sandbox');assert.equal(added.at(-1).fields.env.QUICKBOOKS_REFRESH_TOKEN,'fixture-2');
  assert.equal(JSON.stringify(added.at(-1).option).includes('fixture-2'),false);await unmount();
  for(const id of ['outlook-mail','outlook-calendar','vercel','shop-pay']){
   const before=added.length;await mount(preset(id));assert.equal(button('save'),undefined);assert.equal(dialog.root.findAllByType('input').length,0);assert.equal(added.length,before);await unmount();
  }
  console.log('PASS configured official providers: required OAuth apps, optional explicit tokens, callback display, secret preservation, token/header fields, deployment URLs, pinned Link package, local apps, and restricted guides');
 }finally{if(dialog)await unmount();for(const key of Object.keys(api))delete api[key];Object.assign(api,originalApi);}
}

// Only curated recommendations are shown; no directory or search is requested.
{
 const originalApi={...api};
 const {createRequire}=await import('node:module');
 const rootRequire=createRequire(new URL('../package.json',import.meta.url));
 const {parseRegistryEntry}=rootRequire('./app/agent-service/mcp-registry-client');
 const featured=rootRequire('./app/agent-service/data/mcp-featured-servers.json');
 const hiddenIds=new Set(['gmail','google-calendar','google-contacts','google-docs','google-drive','google-sheets','google-slides','zoom','asana','box','dropbox','quickbooks','outlook-mail','outlook-calendar','strava','vercel','shop-pay','shopify','shopify-ucp','uber','uber-eats']);
 const chinesePresets=new Set(['12306','amap','didi','eastmoney','ifind','luckin','mcdonalds','mijia','variflight','wind']);
 const chineseOfficial=new Set(['alipay','baidu-maps','fliggy','meituan-paotui','netease-music','quark-drive','rollinggo-hotel','weread']);
 const officialCatalog=rootRequire('./app/agent-service/data/official-skill-connectors.json');
 const presetVisible=id=>!hiddenIds.has(id)&&(currentLanguage==='zh-CN'||!chinesePresets.has(id));
 const github=parseRegistryEntry(rootRequire('./scripts/fixtures/mcp-registry/io.github.github__github-mcp-server.json'));
 const figma=parseRegistryEntry(rootRequire('./scripts/fixtures/mcp-registry/com.figma.mcp__mcp.json'));
 const newRegistryItems=featured.filter(name=>![github.registryName,figma.registryName].includes(name)).map(name=>({registryName:name,name:catalog.mcpBrandId(name),version:'1.0.0',description:'English-only registry sentinel',options:[{id:'remote:0',transport:{kind:'remote',protocol:'streamable-http',url:recommendations.find(value=>value.registryName===name)?.url||'https://example.test/mcp'},fields:[]}]}));
 const installed={...server,name:'Installed connector stays available',source:{kind:'custom'}};
 let installedServers=[installed];
 let officialDefinitions=[];
 let officialModel={data:{items:[]},refresh:async()=>{},loading:false,change(){throw Error('Installed official connectors must not be added again');}};
 let recommendationsFail=false;const registryQueries=[];
 let pendingIds=[];
 const events=new EventTarget(),document=new EventTarget();document.visibilityState='visible';
 const pageApi={
  getMcpOAuthInfo:async()=>({redirectUri:'http://127.0.0.1:45829/callback'}),
  MCP_CHANGE_EVENT:'mcp-change',listMcpConnectors:async()=>({revision:8,servers:installedServers}),mcpPublicError:()=> 'MCP_REGISTRY_UNAVAILABLE',
  searchMcpRegistry:async(search='')=>{
   registryQueries.push(search);
   assert.ok(featured.includes(search),'only featured publisher identities are requested');
   if(recommendationsFail)throw Error('MCP_REGISTRY_UNAVAILABLE');
   return {items:[github,figma,...newRegistryItems].filter(item=>!search||search===item.registryName),featured,nextCursor:null,cachedAt:1};
  }
 };
 const cache=load('../app/manage-ui/src/lib/usePageCache.ts',uiRequire);
 const page=load('../app/manage-ui/src/pages/ConnectorsPage.tsx',name=>{
  if(name==='react'||name==='react/jsx-runtime')return uiRequire(name);
  if(name==='../components/ConnectorDetails')return connectorDetails;
  if(name==='react-i18next')return {useTranslation:()=>({t:key=>key,i18n:{resolvedLanguage:currentLanguage}})};
  if(name==='react-router-dom')return {useLocation:()=>({search:''})};
  if(name==='../api/mcpConnectors')return pageApi;
  if(name==='../lib/usePageCache')return cache;
  if(name==='../lib/usePendingConnectors')return {usePendingConnectors:()=>({ids:pendingIds,add(){},remove(id){pendingIds=pendingIds.filter(value=>value!==id);}})};
  if(name==='../lib/useMcpConnectorRefresh')return {useMcpConnectorRefresh(){}};
  if(name==='../lib/mcpConnectorUi')return helpers;
  if(name==='../lib/mcpRecommendationCatalog')return catalog;
  if(name==='../lib/page-refresh')return {useRegisterPageLoading(){},useRegisterPageRefresh(){}};
  if(name==='../../../agent-service/data/mcp-featured-servers.json')return {__esModule:true,default:featured};
  if(name==='../../../agent-service/data/mcp-featured-presets.json')return {__esModule:true,default:recommendations};
  if(name==='./McpConnectorDialog')return mod;
  if(name==='./LarkCliConnector')return {__esModule:true,default:()=>null,useLarkCliConnector:()=>({data:{canRemove:false},refresh:async()=>{},loading:false}),LarkCliInstalledRow:()=>null,LarkCliRecommendation:()=>null};
  if(name==='./OfficialSkillConnectors')return {__esModule:true,default:()=>null,useOfficialSkillConnectors:()=>officialModel,officialConnectorDefinitions:officialDefinitions,OfficialSkillInstalledRows:()=>null,OfficialSkillRecommendation:({definition})=>React.createElement('div',{'data-official-recommendation':definition.id},React.createElement('button',{},'mcpConnectors.add'))};
  if(name==='../api/larkCliConnector')return {matchesLarkCli:()=>false};
  if(name==='../components/McpApprovalInbox')return {__esModule:true,default:()=>null};
  if(name==='../components/AppleDeviceConnectors')return {AppleDeviceRows:()=>null,useAppleDeviceConnectors:()=>({count:0})};
  if(name==='../components/McpConnectorIcon')return {__esModule:true,default:props=>React.createElement('i',{'data-icon':props.iconId||props.identity})};
  if(name==='../components/PageHead')return {PageHead:()=>null};
  if(name==='../components/Modal')return {__esModule:true,default:({children, footer, subtitle,title})=>React.createElement('section',{'data-unavailable-dialog':true},React.createElement('header',{},title), children, React.createElement("p", {}, subtitle), footer)};
  if(name==='../../../core/flightaware-connector-policy.json')return {__esModule:true,default:JSON.parse(fs.readFileSync(new URL('../app/core/flightaware-connector-policy.json',import.meta.url),'utf8'))};
 if(name.endsWith('.module.css'))return {__esModule:true,default:{}};
  throw Error('Unexpected page dependency '+name);
 },{window:events,document,URLSearchParams,setTimeout,clearTimeout});
 const flush=async()=>{for(let i=0;i<5;i++)await new Promise(setImmediate);};
 let rendered;
 const mount=async()=>Renderer.act(async()=>{cache.invalidatePageCache();rendered=Renderer.create(React.createElement(page.default));await flush();});
 const unmount=async()=>Renderer.act(async()=>rendered.unmount());
 const section=title=>rendered.root.findAllByType('section').find(section=>section.findAllByType('h2').some(heading=>heading.children.join('')==='mcpConnectors.'+title));
 const hasGithub=section=>!!section?.findAllByType('strong').some(label=>label.children.join('')==='GitHub');
 const hasAlert=section=>!!section?.findAll(node=>node.props.role==='alert').length;
 const retry=section=>section.findAllByType('button').find(button=>button.props.children==='mcpConnectors.retry');
 try{
  await mount();
  assert.ok(rendered.root.findAllByType('div').some(node=>node.props.className?.includes('page management-page')),'connector page uses the shared management layout');
  const installedRow=section('installed').findByType('li');
  assert.equal(installedRow.findAllByType('button').length,1,'the app itself opens management');
  assert.equal(installedRow.findAllByType('small').length,0,'ready apps show no description or status');
  assert.equal(installedRow.findByType('button').props['aria-label'],'mcpConnectors.manage '+installed.name);
  assert.ok(hasGithub(section('recommended')),'GitHub loads directly in recommendations');
  const recommendedCards=()=>section('recommended').findAllByType('button').filter(button=>button.findAllByType('strong').length);
  const cardIds=()=>recommendedCards().map(button=>catalog.mcpBrandId(button.findByType('i').props['data-icon']));
  const expectedPresetIds=()=>[...catalog.mcpRecommendationOrder].filter(id=>id!=='lark-cli'&&!officialCatalog.some(item=>item.id===id)&&presetVisible(id));
  assert.equal(new Set(cardIds()).size, cardIds().length, 'each recommendation appears once');
  assert.deepEqual(cardIds(),expectedPresetIds(),'English recommendations omit Chinese apps and keep the curated order');
  assert.equal(section('recommended').findAllByType('span').some(span=>span.children.join('').includes('mcpConnectors.officialGuide')),false,'recommendations never expose guide-only actions');
  assert.ok(recommendedCards().every(button=>!/[\u3400-\u9fff]/.test(button.findAllByType('small')[0].children.join(''))),'every English description is English');
  currentLanguage='zh-CN';await Renderer.act(async()=>rendered.update(React.createElement(page.default)));
  assert.deepEqual(cardIds(),expectedPresetIds(),'changing to Chinese adds the local recommendations in the same order');
  assert.ok(recommendedCards().every(button=>/[\u3400-\u9fff]/.test(button.findAllByType('small')[0].children.join(''))),'every card switches to Chinese on the existing page');
  assert.equal(JSON.stringify(rendered.toJSON()).includes('English-only registry sentinel'),false,'English-only remote metadata must not leak into curated summaries');
  const githubChinese=recommendedCards().find(button=>button.findByType('strong').children.join('')==='GitHub');
  await Renderer.act(async()=>{githubChinese.props.onClick();await flush();});
  assert.ok(rendered.root.findAllByType('p').some(p=>p.children.join('')===catalog.mcpRegistrySummary(github.registryName).description['zh-CN']),'dialog follows Chinese too');
  await Renderer.act(async()=>rendered.root.findByType(mod.default).props.onClose());
  currentLanguage='en';await Renderer.act(async()=>rendered.update(React.createElement(page.default)));
  assert.deepEqual(cardIds(),expectedPresetIds(),'changing back to English removes the local recommendations');
  assert.ok(recommendedCards().every(button=>!/[\u3400-\u9fff]/.test(button.findAllByType('small')[0].children.join(''))),'all descriptions switch back to English');

  for(const recommendation of recommendations)assert.equal(section('recommended').findAllByType('strong').some(label=>label.children.join('')===catalog.mcpConnectorName(recommendation.id,recommendation.name)),presetVisible(recommendation.id),'recommendation visibility: '+recommendation.name);
  assert.equal(section('directory'),undefined);
  assert.equal(rendered.root.findAllByProps({type:'search'}).length,0);
  assert.deepEqual([...registryQueries].sort(),[...featured].sort());
  assert.ok(section('installed').findAllByType('strong').some(label=>label.children.join('')===installed.name));
  const githubButton=section('recommended').findAllByType('button').find(button=>button.findAllByType('strong').some(label=>label.children.join('')==='GitHub'));
  await Renderer.act(async()=>{githubButton.props.onClick();await flush();});
  assert.ok(!rendered.root.findAllByType('a').some(link=>link.props.href===github.repositoryUrl),'the registry guide is hidden before adding');
  assert.deepEqual(rendered.root.findAllByType('dd').map(node=>node.children.join('')),['GitHub',github.version]);
  await unmount();

  recommendationsFail=true;
  await mount();
  assert.ok(hasAlert(section('recommended')));
  for(const recommendation of recommendations.filter(value=>!value.registryName))assert.equal(section('recommended').findAllByType('strong').some(label=>label.children.join('')===catalog.mcpConnectorName(recommendation.id,recommendation.name)),presetVisible(recommendation.id),'recommendation visibility during registry outage: '+recommendation.name);
  recommendationsFail=false;
  await Renderer.act(async()=>{retry(section('recommended')).props.onClick();await flush();});
  assert.ok(hasGithub(section('recommended')));assert.equal(hasAlert(section('recommended')),false);
  await unmount();

  console.log(`PASS actual connectors page: ${expectedPresetIds().length} English MCP cards in popularity order, Chinese-only recommendations, live bilingual descriptions and dialog, no directory/search, registry failure/retry`);
  installedServers=[{...installed,id:'existing-local-figma',auth:{kind:'none'},transport:{kind:'remote',protocol:'streamable-http',url:helpers.FIGMA_DESKTOP_URL}}];
  await mount();
  assert.equal(section('recommended').findAllByType('strong').some(node=>node.children.join('')==='Figma'),false);
  await Renderer.act(async()=>section('installed').findAllByType('button').find(node=>node.props['aria-label']?.startsWith('mcpConnectors.manage ')).props.onClick());
  assert.equal(rendered.root.findByType(mod.default).props.server.id,'existing-local-figma');
  await Renderer.act(async()=>rendered.root.findByType(mod.default).props.onClose());
  console.log('PASS actual connectors page: Figma recommendation manages the installed local connector instead of adding remote duplicates');
  await unmount();
  for(currentLanguage of ['en','zh-CN']){
   const groups=recommendations.filter(value=>value.connectAllServices);
   installedServers=groups.flatMap(group=>group.endpoints.map((endpoint,index)=>({...installed,id:`group-${group.id}-${index}`,name:`Saved ${group.id} ${index}`,enabled:true,transport:{kind:'remote',protocol:'streamable-http',url:endpoint.url}})));
   await mount();
   const rows=section('installed').findAllByType('li');
   assert.equal(rows.length,groups.length,'all services of an app share one installed row');
   assert.deepEqual(rows.map(row=>row.findByType('strong').children.join('')),groups.map(group=>catalog.mcpConnectorName(group.id,group.name)));
   assert.equal(section('recommended').findAllByType('strong').some(node=>groups.some(group=>node.children.join('')===catalog.mcpConnectorName(group.id,group.name))),false,'grouped apps never expose duplicate Add');
   assert.equal(rows.every(row=>row.findAllByType('small').length===0),true,'fully connected groups show only an icon and name');
   await unmount();
   installedServers=installedServers.filter(value=>value.id==='group-wind-0');
   await mount();assert.equal(section('installed').findAllByType('li').length,1,'old single-service registrations remain manageable');
   assert.equal(section('installed').findByType('small').children.join(''),'mcpConnectors.flow.notConnected','partially connected groups show not connected');await unmount();
  }
  currentLanguage='en';
  console.log('PASS service groups: one compact app entry, connected groups omit status, partial groups show not connected, no duplicate Add and legacy management in both languages');
  officialDefinitions.push(...officialCatalog);
  const installedOfficialIds=['alipay','fliggy','netease-music','shop'];
  installedServers=installedOfficialIds.map((id,index)=>({...installed,id:`official-${id}-a0b0c0d${index}`,name:`Renamed ${id}`,source:{kind:'custom'},transport:{kind:'stdio-command',command:'/Applications/Shoggoth.app/Contents/MacOS/Shoggoth'}}));
  const officialRecommendations=()=>section('recommended').findAll(node=>node.props['data-official-recommendation']).map(node=>node.props['data-official-recommendation']);
  const availableOfficial=officialDefinitions.filter(item=>!installedOfficialIds.includes(item.id)).sort((a,b)=>catalog.mcpRecommendationRank(a.id)-catalog.mcpRecommendationRank(b.id)).map(item=>item.id);
  for(const state of [{data:{items:[]},loading:false},{data:undefined,loading:true},{data:undefined,loading:false,error:'OFFICIAL_SKILL_STATE_UNAVAILABLE'}]){
   officialModel={...officialModel,...state};
   await mount();
   assert.deepEqual(section('installed').findAllByType('i').map(icon=>icon.props['data-icon']),installedOfficialIds,'installed official registrations keep bundled artwork while ownership metadata is unavailable');
   assert.deepEqual(officialRecommendations(),availableOfficial.filter(id=>!chineseOfficial.has(id)),'English keeps global official recommendations');
   await unmount();
  }
  currentLanguage='zh-CN';
  await mount();
  assert.deepEqual(officialRecommendations(),availableOfficial,'Chinese includes the regional official recommendations without duplicating installed connectors');
  await unmount();
  installedServers=[{...installed,id:'custom-alipay',name:'支付宝',transport:{kind:'stdio-command',command:'/custom/node'}}];
  await mount();
  assert.equal(section('recommended').findAll(node=>node.props['data-official-recommendation']==='alipay').length,1,'a custom display name cannot hide the real recommendation');
  await unmount();
  currentLanguage='en';
  officialDefinitions.length=0;officialModel={data:{items:[]},refresh:async()=>{},loading:false};
  console.log('PASS installed official connectors: stable icons and no duplicate Add during loading, missing metadata or service errors; custom names retain recommendations');
  const clickup=recommendations.find(value=>value.id==='clickup');
  installedServers=[{...installed,id:'existing-clickup',name:'ClickUp',transport:{kind:'remote',protocol:'streamable-http',url:clickup.url}}];
  recommendationsFail=true;
  await mount();
  assert.equal(section('installed').findByType('i').props['data-icon'],'clickup','installed official endpoint reuses the bundled brand icon');
  assert.equal(section('recommended').findAllByType('strong').some(node=>node.children.join('')==='ClickUp'),false,'installed entry leaves recommendations');
  const clickupButton=section('installed').findAllByType('button').find(button=>button.props['aria-label']?.startsWith('mcpConnectors.manage '));
  await Renderer.act(async()=>clickupButton.props.onClick());
  assert.equal(rendered.root.findByType(mod.default).props.server.id,'existing-clickup','reuse the installed official endpoint');
  await Renderer.act(async()=>rendered.root.findByType(mod.default).props.onClose());
  assert.ok(section('recommended').findAllByType('strong').some(label=>label.children.join('')==='Granola'),'other recommendations remain visible');
  assert.equal(rendered.root.findAllByProps({type:'search'}).length,0);
  console.log('PASS actual connectors page: all prior and lifestyle additions, offline recommendations and installed endpoint reuse');
  await unmount();
  const blender=recommendations.find(value=>value.id==='blender-lab');
  installedServers=[{...installed,id:'saved-blender',name:'My Blender',source:{kind:'custom'},recommendationId:'blender-lab',auth:{kind:'none'},transport:{kind:'stdio-command',command:'/Users/fixture/.venv/bin/python'}}];
  await mount();
  assert.equal(section('installed').findByType('i').props['data-icon'],'blender-lab');
  assert.equal(section('recommended').findAllByType('strong').some(node=>node.children.join('')==='Blender Lab'),false,'installed entry leaves recommendations');
  const blenderButton=section('installed').findAllByType('button').find(button=>button.props['aria-label']?.startsWith('mcpConnectors.manage '));
  await Renderer.act(async()=>blenderButton.props.onClick());
  assert.equal(rendered.root.findByType(mod.default).props.server.id,'saved-blender');
  assert.equal(rendered.root.findByType(mod.default).props.recommendation,blender);
  assert.ok(rendered.root.findAllByType('button').some(node=>node.props.children==='mcpConnectors.flow.configure'),'saved Blender can reopen its setup');
  console.log('PASS saved Blender: custom display name keeps official icon and setup, recommendation manages existing connection');
  await unmount();
  const canva=recommendations.find(value=>value.id==='canva');
  installedServers=[{...installed,id:'existing-canva',name:'Canva',source:{kind:'registry',registryName:'com.canva.mcp/mcp',version:'1.0.0'},auth:{kind:'oauth-dcr'},transport:{kind:'remote',protocol:'streamable-http',url:'https://mcp.canva.com/mcp'}}];
  await mount();
  assert.equal(section('installed').findByType('i').props['data-icon'],'canva');
  assert.equal(section('recommended').findAllByType('strong').some(node=>node.children.join('')==='Canva'),false,'installed entry leaves recommendations');
  const canvaButton=section('installed').findAllByType('button').find(button=>button.props['aria-label']?.startsWith('mcpConnectors.manage '));
  await Renderer.act(async()=>canvaButton.props.onClick());
  assert.equal(rendered.root.findByType(mod.default).props.server.id,'existing-canva','the original registry connection must be managed without creating a duplicate');
  assert.equal(rendered.root.findByType(mod.default).props.recommendation,canva);
  assert.equal(rendered.root.findAllByType('input').some(node=>node.props.type==='password'),false,'ready DCR hides credential setup');
  console.log('PASS actual Canva recommendation: original registry connection and logo retained, management opens without manual client credentials');
  await unmount();
  const zoom=recommendations.find(value=>value.id==='zoom');
  installedServers=[{...installed,id:'existing-zoom',name:'Zoom',auth:{kind:'oauth-client'},transport:{kind:'remote',protocol:'streamable-http',url:zoom.url}}];
  await mount();
  assert.equal(section('recommended').findAllByType('strong').some(label=>label.children.join('')==='Zoom'),false);
  assert.equal(section('installed').findByType('strong').children.join(''),'Zoom','hiding recommendations preserves installed connections');
  assert.equal(section('installed').findByType('i').props['data-icon'],'zoom');
  const zoomManage=section('installed').findAllByType('button').find(button=>button.props['aria-label']?.startsWith('mcpConnectors.manage '));
  await Renderer.act(async()=>zoomManage.props.onClick());
  assert.equal(rendered.root.findByType(mod.default).props.server.id,'existing-zoom');
  assert.equal(rendered.root.findByType(mod.default).props.recommendation,zoom,'installed connections keep their setup and management metadata');
  console.log('PASS hidden OAuth-app recommendation: installed Zoom retains its icon, setup metadata and management dialog');
  await unmount();
  const {validateMcpRemoteUrl}=rootRequire('./app/agent-service/native-mcp-store');
  const normalizedPresets=recommendations.filter(value=>value.url && validateMcpRemoteUrl(value.url)!==value.url);
  assert.deepEqual(normalizedPresets.map(value=>value.id).sort(),['black-forest-labs','box','kiwi','lovable','mcdonalds','shopify','tessie']);
  recommendationsFail=true;
  const checked=[];
  api.startMcpSignIn=async()=>assert.fail('public or token-only services must not start OAuth');
  api.verifyMcpConnector=async id=>{
   checked.push(id);
   installedServers=installedServers.map(value=>value.id===id?{...value,status:'ready',lastCheck:{at:1,toolCount:2,errorCode:null}}:value);
   return {revision:9,server:installedServers.find(value=>value.id===id)};
  };
  for(const language of ['en','zh-CN']) {
   installedServers=normalizedPresets.map(preset=>({...installed,id:'normalized-'+preset.id,name:preset.name,transport:{kind:'remote',protocol:'streamable-http',url:validateMcpRemoteUrl(preset.url)},...(preset.id==='kiwi'?{status:'failed',lastCheck:{at:1,toolCount:0,errorCode:'MCP_AUTH_REQUIRED'}}:{})}));
   currentLanguage=language;await mount();
   for(const preset of normalizedPresets) {
    const row=section('installed').findAllByType('li').find(row=>row.findByType('strong').children.join('')===catalog.mcpConnectorName(preset.id,preset.name));
    assert.equal(row.findByType('i').props['data-icon'],preset.id,`${preset.id}: persisted canonical URL keeps its installed logo while Registry is offline`);
    assert.equal(row.findAllByType('small').length,preset.id==='kiwi'?1:0,'only disconnected apps show a status hint');
    const manage=row.findByType('button');
    await Renderer.act(async()=>manage.props.onClick());
    assert.equal(rendered.root.findByType(mod.default).props.recommendation,preset);
    assert.equal(rendered.root.findByType(mod.default).props.server.id,'normalized-'+preset.id);
    if(['none','token'].includes(preset.setup)) assert.equal(rendered.root.findAllByType('button').some(button=>button.props.children==='mcpConnectors.signin'),false,`${preset.id}: management retains its non-OAuth setup after installation`);
    if(preset.id==='kiwi') {
     const check=rendered.root.findAllByType('button').find(button=>['verify','flow.checkConnect'].some(key=>button.props.children==='mcpConnectors.'+key));
     await Renderer.act(async()=>{check.props.onClick();await flush();});
     assert.equal(checked.at(-1),'normalized-kiwi');
     assert.ok(rendered.root.findByType(mod.default).findAllByProps({'data-state':'ready'}).some(node=>node.children.join('').includes('mcpConnectors.flow.connected')),'a readiness check clears the failed-login status without credentials or reinstallation');
    }
    await Renderer.act(async()=>rendered.root.findByType(mod.default).props.onClose());
    const card=section('recommended').findAllByType('button').find(button=>button.findAllByType('strong').some(label=>label.children.join('')===catalog.mcpConnectorName(preset.id,preset.name)));
    assert.equal(card,undefined,`${preset.id}: installed connections are hidden from recommendations`);
   }
   await unmount();
  }
  assert.equal(checked.length,2);
  console.log('PASS canonical endpoint identity: Lovable, Kiwi, Box, Tessie and Shopify keep installed logos, setup metadata and existing management in both languages with Registry offline; public Kiwi recovers by checking without OAuth or credentials');
  currentLanguage='en';installedServers=[];pendingIds=['preset:home-assistant','preset:mijia','registry:dev.shoggoth.offline/mcp'];
  await mount();
  const pendingRows=section('installed').findAllByType('li');
  assert.equal(pendingRows.length,3,'pending and offline entries remain visible in English, including Chinese apps');
  assert.ok(pendingRows.every(row=>row.findByType('small').children.join('')==='mcpConnectors.flow.notConnected'));
  const mijiaRow=pendingRows.find(row=>row.findByType('i').props['data-icon']==='mijia');
  await Renderer.act(async()=>mijiaRow.findByType('button').props.onClick());
  assert.equal(rendered.root.findByType(mod.default).props.pendingKey,'preset:mijia','a pending Chinese app can still be configured in English');
  await Renderer.act(async()=>rendered.root.findByType(mod.default).props.onClose());
  const offlineRow=pendingRows.find(row=>row.findByType('strong').children.join('')==='dev.shoggoth.offline/mcp');
  assert.equal(offlineRow.findAllByType('i').length,1,'offline entries retain a fallback icon');
  await Renderer.act(async()=>offlineRow.findByType('button').props.onClick());
  const offlineDialog=rendered.root.findByProps({'data-unavailable-dialog':true});
  assert.ok(offlineDialog.findAllByType('button').some(button=>button.props.children==='mcpConnectors.retry'),'retry stays available in management');
  await Renderer.act(async()=>offlineDialog.findAllByType('button').find(button=>button.props.children==='mcpConnectors.flow.remove').props.onClick());
  assert.deepEqual(pendingIds,['preset:home-assistant','preset:mijia'],'removing an offline entry clears only its pending identity');
  assert.equal(section('installed').findAllByType('li').length,2);
  await unmount();
  console.log('PASS compact pending entries: not connected text, fallback icon, offline management retry and removal');
 }finally{if(rendered)await unmount();for(const key of Object.keys(api))delete api[key];Object.assign(api,originalApi);}
}
// Agent-imported custom credentials use the same masked form and clear local
// values after save; no repair, removal or per-Agent switches are needed here.
{
 const originalApi={...api},saved=[],ready=[];
 const custom={...server,id:'agent-custom-key',source:{kind:'custom'},auth:{kind:'headers'},status:'needsSetup',setup:{requiredFields:['header:X-Api-Key'],configuredFields:[]}};
 Object.assign(api,{listMcpConnectors:async()=>({revision:11,servers:[custom]}),saveMcpCredentials:async(id,fields,revision)=>{saved.push({id,fields,revision});return {revision:12,server:{...custom,status:'ready'}};}});
 let rendered;
 try{
  await Renderer.act(async()=>{rendered=Renderer.create(React.createElement(mod.default,{server:custom,credentialsOnly:true,onClose(){},onChanged(){},onReady:value=>ready.push(value)}));});
  const key=rendered.root.findAllByType('label').find(label=>label.findAllByType('span').some(span=>JSON.stringify(span.props.children).includes('X-Api-Key'))).findByType('input');
  assert.equal(key.props.type,'password');
  await Renderer.act(async()=>key.props.onChange({target:{value:'agent-form-secret-canary'}}));
  const save=rendered.root.findAllByType('button').find(button=>['flow.saveConnect','flow.authorize','flow.checkConnect'].some(key=>button.props.children==='mcpConnectors.'+key));assert.ok(save);
  await Renderer.act(async()=>{save.props.onClick();for(let n=0;n<5;n++)await Promise.resolve();});
  assert.deepEqual(JSON.parse(JSON.stringify(saved)),[{id:'agent-custom-key',fields:{headers:{'X-Api-Key':'agent-form-secret-canary'}},revision:11}]);
  assert.equal(ready.length,1);assert.equal(rendered.root.findAllByType('input').some(input=>input.props.value==='agent-form-secret-canary'),false);
  assert.equal(rendered.root.findAllByType('button').some(button=>button.props.children==='mcpConnectors.remove'),false);
  assert.equal(rendered.root.findAllByType('h3').some(heading=>heading.props.children==='mcpConnectors.agents'),false);
  console.log('PASS Agent custom setup: declared header uses masked input, exact private save, clears secret and returns ready without management actions');
 }finally{if(rendered)await Renderer.act(async()=>rendered.unmount());for(const key of Object.keys(api))delete api[key];Object.assign(api,originalApi);}
}

// The catalog Add button and the configuration submit are separate operations.
{
 const originalApi={...api},saves=[],removed=[];let dialog,staged=false,closed=0;
 const preset=recommendations.find(item=>item.id==='home-assistant');
 const installed={...server,id:'home-after-setup',name:'Home Assistant',source:{kind:'custom'},auth:{kind:'oauth-client'},transport:{kind:'remote',protocol:'streamable-http',url:'http://127.0.0.1:8123/mcp'},status:'ready'};
 Object.assign(api,{listMcpConnectors:async()=>({revision:8,servers:saves.length?[installed]:[]}),
  addMcpConnector:async input=>{saves.push(input);return {revision:9,server:installed};},
  removeMcpConnector:async(id,revision)=>{removed.push({id,revision});},
  startMcpSignIn:async()=>assert.fail('adding or completing an already ready fixture must not start OAuth')});
 const mount=async extra=>Renderer.act(async()=>{dialog=Renderer.create(React.createElement(mod.default,{recommendation:preset,catalogEntry:true,pending:staged,onStage:()=>{staged=true;},onUnstage:()=>{staged=false;},onClose:()=>closed++,onChanged(){},...extra}));});
 const button=key=>dialog.root.findAllByType('button').find(node=>node.props.children==='mcpConnectors.'+key);
 const unmount=async()=>Renderer.act(async()=>{dialog.unmount();dialog=null;});
 try {
  await mount();assert.ok(button('add'));assert.equal(dialog.root.findAllByType('input').length,0,'unadded details do not expose configuration');
  await Renderer.act(async()=>button('add').props.onClick());
  assert.equal(staged,true);assert.equal(saves.length,0,'adding an instance-dependent connector only stages its identity');
  assert.ok(button('flow.remove'));assert.equal(button('flow.saveConnect').props.disabled,true);
  await unmount();await mount();assert.equal(button('add'),undefined,'reopening keeps the installed/pending stage');
  const instance=dialog.root.findAllByType('label').find(node=>node.findAllByType('span').some(span=>span.props.children==='mcpConnectors.instanceUrl')).findByType('input');
  await Renderer.act(async()=>instance.props.onChange({target:{value:installed.transport.url}}));
  await Renderer.act(async()=>button('flow.saveConnect').props.onClick());
  assert.equal(saves.length,1);assert.equal(saves[0].option.url,installed.transport.url);assert.equal(staged,false,'saving removes only the pending identity');
  assert.equal(button('flow.saveConnect'),undefined);assert.ok(button('verify'));
  await Renderer.act(async()=>button('flow.remove').props.onClick());
  assert.deepEqual(removed,[{id:installed.id,revision:8}]);assert.equal(closed,1);
  await unmount();staged=true;await mount();
  await Renderer.act(async()=>button('flow.remove').props.onClick());
  assert.equal(staged,false);assert.equal(removed.length,1,'removing an unsaved item never calls Service removal');
  await unmount();staged=false;await mount({onStage:()=>{throw Error('quota exceeded');}});
  await Renderer.act(async()=>button('add').props.onClick());
  assert.ok(button('add'),'failed pending storage never claims an installed connector');
  assert.ok(JSON.stringify(dialog.toJSON()).includes('mcpConnectors.flow.storageError'));assert.equal(saves.length,1);
  console.log('PASS staged catalog lifecycle: details/add/pending/reopen/configure/ready/remove and storage failure retain the original mutation boundary');
 }finally{if(dialog)await unmount();for(const key of Object.keys(api))delete api[key];Object.assign(api,originalApi);}
}
