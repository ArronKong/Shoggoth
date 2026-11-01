"use strict";
// The management contract is deliberately independent of any runtime/backend.
const METHODS = Object.freeze(["connector.mcp.registry.list","connector.mcp.list","connector.mcp.tools.list","connector.mcp.add","connector.mcp.import",
  "connector.mcp.verify","connector.mcp.rebind","connector.mcp.signin.start","connector.mcp.signin.get","connector.mcp.signin.cancel",
  "connector.mcp.credentials.update","connector.mcp.oauth.info","connector.mcp.agents.list","connector.mcp.agents.set","connector.mcp.update","connector.mcp.remove",
  "connector.mcp.requests.list","connector.mcp.request.complete","connector.mcp.approvals.list","connector.mcp.approvals.resolve"]);
const RETIRED = Object.freeze(["connector.status","connector.apps.list","connector.categories.list","connector.setup.get","connector.connections.list",
  "connector.connect","connector.oauth.configure","connector.operation.get","connector.operation.cancel","connector.disconnect","connector.access.set",
  "connector.actions.list","connector.agents.list","connector.calls.list","connector.call.get","connector.approvals.list","connector.approvals.prepare",
  "connector.approvals.commit","connector.selection.external.prepare","connector.selection.external.get","connector.selection.external.cancel","connector.selection.external.cancelSession"]);
const text=(v,max=4096)=>typeof v==="string"&&v.isWellFormed()&&!v.includes("\0")&&Buffer.byteLength(v)<=max;
const id=v=>text(v,128)&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(v);
const plain=v=>v&&Object.getPrototypeOf(v)===Object.prototype;
const exact=(v,required,optional=[])=>plain(v)&&Reflect.ownKeys(v).every(k=>required.includes(k)||optional.includes(k))&&required.every(k=>Object.hasOwn(v,k))
  &&Reflect.ownKeys(v).every(k=>{const d=Object.getOwnPropertyDescriptor(v,k);return d.enumerable&&Object.hasOwn(d,"value");});
const revision=v=>Number.isSafeInteger(v)&&v>0;
function invalid(){throw new TypeError("invalid connector contract");}
function json(value,max=1024*1024){
  let count=0;const visit=(v,depth=0)=>{if(++count>20000||depth>40)invalid();if(v===null||typeof v==="boolean"||typeof v==="number"&&Number.isFinite(v))return;
    if(typeof v==="string"){if(!text(v,max))invalid();return;}if(!Array.isArray(v)&&!plain(v))invalid();
    for(const k of Object.keys(v)){if(typeof k!=="string"||["__proto__","prototype","constructor"].includes(k))invalid();const d=Object.getOwnPropertyDescriptor(v,k);if(!d.enumerable||!Object.hasOwn(d,"value"))invalid();visit(d.value,depth+1);}};
  visit(value);const raw=JSON.stringify(value);if(Buffer.byteLength(raw)>max)invalid();return JSON.parse(raw);
}
function stringMap(v,max=32768){return plain(v)&&Object.keys(v).length<=64&&Object.entries(v).every(([k,s])=>text(k,128)&&k.length>0&&text(s,max));}
function fields(v){return exact(v,[],["env","headers","query","oauthClient","arguments","variables"])
  &&["env","headers","arguments","variables"].every(k=>v[k]===undefined||stringMap(v[k]))
  &&(v.query===undefined||exact(v.query,["key"])&&text(v.query.key,16384)&&v.query.key.length>0)
  &&(v.oauthClient===undefined||exact(v.oauthClient,["clientId"],["clientSecret","redirectUri"])&&text(v.oauthClient.clientId,4096)
    &&["clientSecret","redirectUri"].every(k=>v.oauthClient[k]===undefined||text(v.oauthClient[k],4096)));}
// Only request completion accepts one OAuth field without exposing its sibling.
function requestFields(v) {
  if (!exact(v,[],["env","headers","oauthClient"]) || Object.keys(v).length !== 1) return false;
  if (v.oauthClient === undefined) return fields(v);
  return exact(v.oauthClient,[],["clientId","clientSecret"]) && Object.keys(v.oauthClient).length === 1
    && Object.values(v.oauthClient).every(value=>text(value,4096)&&value.length>0);
}
const auth=v=>exact(v,["kind"])&&["none","headers","oauth-dcr","oauth-client"].includes(v.kind);
const source=v=>exact(v,["kind"])&&v.kind==="custom"||exact(v,["kind","registryName","version"])&&v.kind==="registry"&&text(v.registryName,256)&&v.registryName.length>0&&text(v.version,256)&&v.version.length>0;
function publicRemoteUrl(value) {
  try {
    const u = new URL(value);
    return !u.username && !u.password && !u.hash
      && (u.protocol === "https:" || u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname))
      && ![...u.searchParams.keys()].some(key => /token|secret|password|api.?key|authorization|^key$/iu.test(key));
  } catch { return false; }
}
function transport(v,publicMode=false){
  if(!plain(v))return false;
  if(v.kind==="stdio-command")return publicMode?exact(v,["kind","command"])&&text(v.command):
    exact(v,["kind","command","args","cwd"])&&text(v.command)&&Array.isArray(v.args)&&v.args.length<=64&&v.args.every(a=>text(a))&&text(v.cwd)
    ||exact(v,["kind","commandLine","cwd"])&&text(v.commandLine,16384)&&text(v.cwd);
  if(v.kind==="stdio-package")return exact(v,["kind","registryType","identifier","version"],publicMode?[]:["packageArgs"])
    &&["npm","pypi","oci"].includes(v.registryType)&&text(v.identifier,512)&&text(v.version,256)
    &&(v.packageArgs===undefined||Array.isArray(v.packageArgs)&&v.packageArgs.length<=64&&v.packageArgs.every(a=>text(a)));
  return v.kind==="remote"&&exact(v,["kind","protocol","url"])&&["streamable-http","sse"].includes(v.protocol)&&text(v.url)&&(!publicMode||publicRemoteUrl(v.url));
}
function validateConnectorParams(method,value){
  if(!METHODS.includes(method))invalid();const r=json(value||{});let valid=false;
  switch(method){
    case "connector.mcp.list":case "connector.mcp.oauth.info":case "connector.mcp.agents.list":case "connector.mcp.approvals.list":valid=exact(r,[]);break;
    case "connector.mcp.registry.list":valid=exact(r,[],["search","cursor"])&&(r.search===undefined||text(r.search,256))&&(r.cursor===undefined||r.cursor===null||text(r.cursor,2048));break;
    case "connector.mcp.add":valid=exact(r,["source","option","expectedRevision"],["fields","name","auth"])&&source(r.source)&&revision(r.expectedRevision)
      &&(r.fields===undefined||fields(r.fields))&&(r.name===undefined||text(r.name,256)&&r.name.trim().length>0)&&(r.auth===undefined||auth(r.auth))
      &&(r.source.kind==="registry"?exact(r.option,["id"])&&/^(remote|package):\d{1,3}$/u.test(r.option.id):transport(r.option));break;
    case "connector.mcp.import":valid=exact(r,["config","expectedRevision"])&&revision(r.expectedRevision)&&(text(r.config,256*1024)||plain(r.config));break;
    case "connector.mcp.rebind":valid=exact(r,["id","option","expectedRevision"])&&id(r.id)&&transport(r.option)&&revision(r.expectedRevision);break;
    case "connector.mcp.tools.list":case "connector.mcp.verify":case "connector.mcp.signin.start":valid=exact(r,["id"])&&id(r.id);break;
    case "connector.mcp.signin.get":case "connector.mcp.signin.cancel":valid=exact(r,["signInId"])&&id(r.signInId);break;
    case "connector.mcp.credentials.update":valid=exact(r,["id","fields","expectedRevision"])&&id(r.id)&&fields(r.fields)&&revision(r.expectedRevision);break;
    case "connector.mcp.agents.set":valid=exact(r,["id","disabledProfileIds","expectedRevision"])&&id(r.id)&&revision(r.expectedRevision)
      &&Array.isArray(r.disabledProfileIds)&&r.disabledProfileIds.length<=1024&&r.disabledProfileIds.every(id)&&new Set(r.disabledProfileIds).size===r.disabledProfileIds.length;break;
    case "connector.mcp.update":valid=exact(r,["id","version","expectedRevision"])&&id(r.id)&&text(r.version,256)&&r.version.length>0&&revision(r.expectedRevision);break;
    case "connector.mcp.remove":valid=exact(r,["id","expectedRevision"])&&id(r.id)&&revision(r.expectedRevision);break;
    case "connector.mcp.requests.list":valid=exact(r,["agentId","sessionKey"],["backendId"])&&id(r.agentId)&&text(r.sessionKey,4096)&&r.sessionKey.length>0
      &&(r.backendId===undefined||["shoggoth","openclaw","hermes"].includes(r.backendId));break;
    case "connector.mcp.approvals.resolve":valid=exact(r,["requestId","argumentDigest","approved"])&&id(r.requestId)&&/^[a-f0-9]{64}$/u.test(r.argumentDigest)&&typeof r.approved==="boolean";break;
    case "connector.mcp.request.complete":valid=exact(r,["requestId"],["fields","serverId","expectedRevision"])&&id(r.requestId)&&(r.fields===undefined||requestFields(r.fields))
      &&(r.serverId===undefined||id(r.serverId))&&(r.expectedRevision===undefined||revision(r.expectedRevision));break;
  }
  if(!valid)invalid();return r;
}
function publicServer(v){
  return exact(v,["id","name","enabled","createdAt","updatedAt","source","transport","auth","setup","status","lastCheck","disabledProfileIds"],["recommendationId"])
    &&id(v.id)&&text(v.name,256)&&typeof v.enabled==="boolean"&&Number.isSafeInteger(v.createdAt)&&v.createdAt>=0&&Number.isSafeInteger(v.updatedAt)&&v.updatedAt>=v.createdAt
    &&source(v.source)&&transport(v.transport,true)&&auth(v.auth)&&exact(v.setup,["requiredFields","configuredFields"])
    &&(v.recommendationId===undefined||["blender-lab","ticketmaster","flightaware"].includes(v.recommendationId)&&v.source.kind==="custom"&&v.transport.kind==="stdio-command")
    &&["requiredFields","configuredFields"].every(k=>Array.isArray(v.setup[k])&&v.setup[k].length<=128&&v.setup[k].every(s=>text(s,256)))
    &&["needsSetup","signedOut","checking","ready","failed","disabled"].includes(v.status)
    &&(v.lastCheck===null||exact(v.lastCheck,["at","toolCount","errorCode"])&&Number.isSafeInteger(v.lastCheck.at)&&v.lastCheck.at>=0
      &&Number.isSafeInteger(v.lastCheck.toolCount)&&v.lastCheck.toolCount>=0&&(v.lastCheck.errorCode===null||id(v.lastCheck.errorCode)))
    &&Array.isArray(v.disabledProfileIds)&&v.disabledProfileIds.length<=1024&&v.disabledProfileIds.every(id);
}
function publicRequest(r){return exact(r,["requestId","kind","serverId","registryName","url","title","purpose","status","requiredFields","expiresAt","createdAt","updatedAt"],["serverIds","continuation"])
  &&id(r.requestId)&&["connection","secret","setup"].includes(r.kind)&&(r.serverId===null||id(r.serverId))&&(r.registryName===null||text(r.registryName,256))
  &&(r.kind==="setup"?Array.isArray(r.serverIds)&&r.serverIds.length>0&&r.serverIds.length<=64&&r.serverIds.every(id)&&new Set(r.serverIds).size===r.serverIds.length&&r.serverIds[0]===r.serverId
    &&["waiting","scheduled","unknown"].includes(r.continuation)&&r.registryName===null&&r.url===null&&r.requiredFields.length===0:r.serverIds===undefined&&r.continuation===undefined)
  &&(r.url===null||text(r.url))&&text(r.title,256)&&text(r.purpose,4096)&&["pending","completed","expired"].includes(r.status)
  &&Array.isArray(r.requiredFields)&&r.requiredFields.length<=128&&r.requiredFields.every(f=>exact(f,["name","label","kind"])&&text(f.name,256)&&text(f.label,256)&&["env","header","oauthClient"].includes(f.kind))
  &&["expiresAt","createdAt","updatedAt"].every(k=>Number.isSafeInteger(r[k])&&r[k]>=0);}
function registryOption(o){
  if(!exact(o,["id","transport","fields","available","errorCode"],["argumentTemplates"])||typeof o.available!=="boolean"
    ||o.errorCode!==null&&!id(o.errorCode)||!text(o.id,32)||!transport(o.transport)||o.transport.kind==="stdio-command"
    ||!Array.isArray(o.fields)||o.fields.length>128)return false;
  if(!o.fields.every(f=>exact(f,["name","location","required","secret","description"],["default"])&&text(f.name,128)
    &&["env","header","argument","variable"].includes(f.location)&&typeof f.required==="boolean"&&typeof f.secret==="boolean"
    &&text(f.description,1024)&&(f.default===undefined||!f.secret&&text(f.default))))return false;
  return o.argumentTemplates===undefined||Array.isArray(o.argumentTemplates)&&o.argumentTemplates.length<=64&&o.argumentTemplates.every(a=>
    exact(a,["type","name","value","field"])&&["positional","named"].includes(a.type)&&(a.name===null||text(a.name,128))
    &&(a.value===null||text(a.value))&&(a.field===null||text(a.field,128)));
}
const ICON_MIME_TYPES=new Set(["image/png","image/jpeg","image/jpg","image/svg+xml","image/webp"]);
function registryIcon(icon){
  if(!exact(icon,["src"],["mimeType","sizes","theme"]) || !text(icon.src,2048) || !/^https:\/\//iu.test(icon.src) || /[\u0000-\u0020\u007f]/u.test(icon.src))return false;
  try {const u=new URL(icon.src);if(u.protocol!=="https:"||u.username||u.password||Buffer.byteLength(u.href)>2048)return false;}catch{return false;}
  return (icon.mimeType===undefined||ICON_MIME_TYPES.has(icon.mimeType))
    &&(icon.sizes===undefined||Array.isArray(icon.sizes)&&icon.sizes.length<=16&&icon.sizes.every(size=>typeof size==="string"&&/^(?:[1-9]\d{0,4}x[1-9]\d{0,4}|any)$/u.test(size)))
    &&(icon.theme===undefined||["light","dark"].includes(icon.theme));
}
function registryItem(item){
  return exact(item,["registryName","name","description","version","repositoryUrl","websiteUrl","options"],["icons"])
    &&text(item.registryName,256)&&text(item.name,256)&&text(item.description,4096)&&text(item.version,256)
    &&(item.repositoryUrl===null||text(item.repositoryUrl))&&(item.websiteUrl===null||text(item.websiteUrl))
    &&(item.icons===undefined||Array.isArray(item.icons)&&item.icons.length<=16&&item.icons.every(registryIcon))
    &&Array.isArray(item.options)&&item.options.length<=32&&item.options.every(registryOption);
}
function safeAuthUrl(value,max=16384){
  if(!text(value,max))return false;
  try {const u=new URL(value);return !u.username&&!u.password&&!u.hash&&(u.protocol==="https:"||u.protocol==="http:"&&["localhost","127.0.0.1"].includes(u.hostname));}catch{return false;}
}
function validateConnectorResult(method,value){
  if(!METHODS.includes(method))invalid();const r=json(value);let valid=false;
  if(method==="connector.mcp.list")valid=exact(r,["revision","servers"])&&revision(r.revision)&&Array.isArray(r.servers)&&r.servers.length<=64&&r.servers.every(publicServer);
  else if(method==="connector.mcp.tools.list")valid=exact(r,["id","available","items","totalCount","checkedAt"])&&id(r.id)&&typeof r.available==="boolean"
    &&Number.isSafeInteger(r.totalCount)&&r.totalCount>=0
    &&(r.checkedAt===null||Number.isSafeInteger(r.checkedAt)&&r.checkedAt>=0)
    &&Array.isArray(r.items)&&r.items.length<=256&&r.items.every(item=>exact(item,["name","description"])&&text(item.name,256)&&item.name.length>0&&text(item.description,2048))
    &&r.items.length<=r.totalCount&&(r.available||r.items.length===0);
  else if(["connector.mcp.add","connector.mcp.verify","connector.mcp.rebind","connector.mcp.credentials.update","connector.mcp.agents.set","connector.mcp.update"].includes(method))
    valid=exact(r,["revision","server"],["replaced"])&&revision(r.revision)&&publicServer(r.server)&&(r.replaced===undefined||typeof r.replaced==="boolean");
  else if(method==="connector.mcp.remove")valid=exact(r,["revision","removed"])&&revision(r.revision)&&publicServer(r.removed);
  else if(method==="connector.mcp.import")valid=exact(r,["revision","servers"],["errors"])&&revision(r.revision)&&Array.isArray(r.servers)&&r.servers.length<=64&&r.servers.every(publicServer)
    &&(r.errors===undefined||Array.isArray(r.errors)&&r.errors.every(e=>exact(e,["name","errorCode"])&&text(e.name,256)&&id(e.errorCode)));
  else if(method==="connector.mcp.registry.list")valid=exact(r,["items","nextCursor","featured","cachedAt"])
    &&Array.isArray(r.items)&&r.items.length<=100&&r.items.every(registryItem)&&(r.nextCursor===null||text(r.nextCursor,2048))
    &&Array.isArray(r.featured)&&r.featured.every(v=>text(v,256))&&Number.isSafeInteger(r.cachedAt);
  else if(method==="connector.mcp.agents.list")valid=exact(r,["items","unavailableBackends"])&&Array.isArray(r.items)&&r.items.length<=1024&&r.items.every(i=>exact(i,["profileId","backendId","agentId","label","enabled"])
    &&id(i.profileId)&&["shoggoth","openclaw","hermes"].includes(i.backendId)&&id(i.agentId)&&text(i.label,256)&&typeof i.enabled==="boolean")&&Array.isArray(r.unavailableBackends)&&r.unavailableBackends.every(b=>["openclaw","hermes"].includes(b));
  else if(method==="connector.mcp.oauth.info")valid=exact(r,["redirectUri"])&&safeAuthUrl(r.redirectUri,4096);
  else if(method.startsWith("connector.mcp.signin."))valid=exact(r,["id","signInId","status","authorizationUrl","redirectUri","expiresAt","errorCode","flow","userCode","installationUrl"])
    &&id(r.id)&&id(r.signInId)&&["starting","pending","exchanging","authorized","cancelled","failed","expired"].includes(r.status)
    &&(r.authorizationUrl===null||safeAuthUrl(r.authorizationUrl))&&["redirect","device"].includes(r.flow)
    &&(r.flow==="device"?r.redirectUri===null&&(r.userCode===null||typeof r.userCode==="string"&&/^[A-Z0-9-]{4,32}$/u.test(r.userCode)):safeAuthUrl(r.redirectUri,4096)&&r.userCode===null)
    &&(r.installationUrl===null||safeAuthUrl(r.installationUrl,4096))
    &&Number.isSafeInteger(r.expiresAt)&&r.expiresAt>=0&&(r.errorCode===null||text(r.errorCode,128)&&/^[A-Z][A-Z0-9_]*$/u.test(r.errorCode));
  else if(method==="connector.mcp.approvals.list")valid=exact(r,["items","generation"])&&revision(r.generation)&&Array.isArray(r.items)&&r.items.length<=128&&r.items.every(a=>
    exact(a,["requestId","backendId","agentId","sessionId","toolName","serverId","argumentsPreview","argumentDigest","reason","createdAt","expiresAt"])
    &&id(a.requestId)&&["openclaw","hermes"].includes(a.backendId)&&id(a.agentId)&&text(a.sessionId,4096)
    &&(/^mcp_server_[a-z_]+$/u.test(a.toolName)||Object.hasOwn(require("./apple-device-contract").TOOL_OPERATIONS,a.toolName))
    &&(a.serverId===null||id(a.serverId))&&text(a.argumentsPreview,12002)&&/^[a-f0-9]{64}$/u.test(a.argumentDigest)&&text(a.reason,1024)
    &&Number.isSafeInteger(a.createdAt)&&a.createdAt>=0
    &&(a.expiresAt===null||Number.isSafeInteger(a.expiresAt)&&a.expiresAt>=a.createdAt));
  else if(method==="connector.mcp.approvals.resolve")valid=exact(r,["resolved","approved"])&&r.resolved===true&&typeof r.approved==="boolean";
  else if(method==="connector.mcp.requests.list")valid=exact(r,["items"])&&Array.isArray(r.items)&&r.items.length<=512&&r.items.every(publicRequest);
  else if(method==="connector.mcp.request.complete")valid=publicRequest(r);
  if(!valid)invalid();return r;
}
module.exports={CONNECTOR_METHODS:METHODS,RETIRED_CONNECTOR_METHODS:RETIRED,validateConnectorParams,validateConnectorResult,
  connectorId:id,connectorService:id,connectorText:text,connectorExact:exact,connectorJson:json,isPublicMcpServer:publicServer};
