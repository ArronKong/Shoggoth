"use strict";
const { serviceError } = require("./security");
const { validatePackageTransport, McpPackageLauncher } = require("./mcp-package-launcher");
const { validateMcpRemoteUrl } = require("./native-mcp-store");
const FEATURED = require("./data/mcp-featured-servers.json");
const BASE = "https://registry.modelcontextprotocol.io/v0.1";
const MAX_BODY = 2 * 1024 * 1024;
const plain = v => v && Object.getPrototypeOf(v) === Object.prototype;
const text = (v,n=4096) => typeof v === "string" && v.isWellFormed() && !/[\0\r\n]/u.test(v) && Buffer.byteLength(v)<=n;
const fail = (code="MCP_REGISTRY_RESPONSE_INVALID") => { throw serviceError(code,code); };
const display = (v,max=4096) => typeof v === "string" && v.isWellFormed() && !v.includes("\0") ? Buffer.from(v).subarray(0,max).toString("utf8").replace(/\uFFFD$/u,"") : "";
const safeUrl = v => { if(!v)return null;try { const u=new URL(v);return u.protocol==="https:"&&!u.username&&!u.password?u.href:null; }catch{return null;} };
const clone = v => JSON.parse(JSON.stringify(v));
const ICON_MIME_TYPES = new Set(["image/png","image/jpeg","image/jpg","image/svg+xml","image/webp"]);
const ICON_SIZE = /^(?:[1-9]\d{0,4}x[1-9]\d{0,4}|any)$/u;
function registryIcons(raw) {
  if (!Array.isArray(raw)) return [];
  const icons=[];
  for (const value of raw.slice(0,16)) {
    if (!plain(value) || !text(value.src,2048) || !/^https:\/\//iu.test(value.src) || /[\u0000-\u0020\u007f]/u.test(value.src)) continue;
    let url; try { url=new URL(value.src); } catch { continue; }
    if (url.protocol!=="https:" || url.username || url.password || Buffer.byteLength(url.href)>2048
      || value.mimeType!==undefined && !ICON_MIME_TYPES.has(value.mimeType)
      || value.sizes!==undefined && (!Array.isArray(value.sizes) || value.sizes.length>16 || value.sizes.some(size=>typeof size!=="string" || !ICON_SIZE.test(size)))
      || value.theme!==undefined && !["light","dark"].includes(value.theme)) continue;
    icons.push({src:url.href,...(value.mimeType!==undefined?{mimeType:value.mimeType}:{}),
      ...(value.sizes!==undefined?{sizes:[...value.sizes]}:{}),...(value.theme!==undefined?{theme:value.theme}:{})});
  }
  return icons;
}
function field(raw,location,index) {
  if(!plain(raw))fail();
  const name=(location==="argument" ? raw.valueHint : raw.name)||`arg${index}`;
  if(!text(name,128) || !/^[A-Za-z_][A-Za-z0-9_.:-]*$/u.test(name))fail();
  if(location==="env"&&!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))fail();
  if(location==="argument"&&raw.isSecret===true)fail("MCP_REGISTRY_SECRET_ARGUMENT");
  const value={name,location,required:raw.isRequired===true,secret:location!=="argument"&&raw.isSecret===true,description:display(raw.description,1024)};
  if(raw.default!==undefined && typeof raw.default==="string" && !value.secret && text(raw.default))value.default=raw.default;
  return value;
}
function parseRegistryEntry(envelope) {
  if(!plain(envelope)||!plain(envelope.server))fail();
  const meta=envelope._meta?.["io.modelcontextprotocol.registry/official"];
  if(!plain(meta)||meta.status!=="active"||meta.isLatest!==true)return null;
  const s=envelope.server;
  if(!text(s.name,256)||!s.name.includes("/")||!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(s.name)||!text(s.version,256)||!s.version)fail();
  const options=[];
  if(s.remotes!==undefined&&!Array.isArray(s.remotes)||s.packages!==undefined&&!Array.isArray(s.packages))fail();
  for(const [i,r] of (s.remotes||[]).slice(0,16).entries()) {
    try {
      if(!plain(r)||!["streamable-http","sse"].includes(r.type)||!text(r.url))continue;
      let url=r.url;const fields=[];
      if(r.variables!==undefined) {
        if(!plain(r.variables)||Object.keys(r.variables).length>32)continue;
        for(const [name,raw] of Object.entries(r.variables)) {
          if(raw.isSecret===true)fail("MCP_REGISTRY_SECRET_ARGUMENT");
          fields.push(field({...raw,name},"variable",fields.length));url=url.replaceAll(`{${name}}`,"placeholder");
        }
      }
      validateMcpRemoteUrl(url);
      if(r.headers!==undefined&&(!Array.isArray(r.headers)||r.headers.length>64))continue;
      for(const h of r.headers||[])fields.push(field(h,"header",fields.length));
      const transport={kind:"remote",protocol:r.type,url:r.url};
      options.push({id:`remote:${i}`,transport,fields});
    }catch{}
  }
  for(const [i,p] of (s.packages||[]).slice(0,16).entries()) {
    try {
      if(!plain(p)||!["npm","pypi","oci"].includes(p.registryType)||p.transport?.type!=="stdio"
        || p.runtimeArguments?.length)continue; // Runtime flags can grant host privileges: never execute publisher-provided launcher flags.
      const officialBase={npm:"https://registry.npmjs.org",pypi:"https://pypi.org"}[p.registryType];
      if(p.registryBaseUrl&&officialBase&&p.registryBaseUrl.replace(/\/$/u,"")!==officialBase)continue;
      const transport=validatePackageTransport({kind:"stdio-package",registryType:p.registryType,identifier:p.identifier,version:p.version||"",packageArgs:[]});
      const fields=[],templates=[];
      for(const [n,a] of (p.packageArguments||[]).entries()) {
        if(n>=64||!plain(a)||!["named","positional"].includes(a.type)||a.isSecret===true||a.variables)fail();
        if(a.type==="named"&&(!text(a.name,128)||!/^--?[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(a.name)))fail();
        if(a.value!==undefined) { if(!text(a.value))fail();templates.push({type:a.type,name:a.name||null,value:a.value,field:null}); }
        else { const f=field(a,"argument",n);fields.push(f);templates.push({type:a.type,name:a.name||null,value:null,field:f.name}); }
      }
      if(p.environmentVariables!==undefined&&(!Array.isArray(p.environmentVariables)||p.environmentVariables.length>64))continue;
      for(const e of p.environmentVariables||[])fields.push(field(e,"env",fields.length));
      options.push({id:`package:${i}`,transport,fields,argumentTemplates:templates});
    }catch{}
  }
  const icons=registryIcons(s.icons);
  return {registryName:s.name,name:display(s.title||s.name,256),description:display(s.description,4096),version:s.version,
    repositoryUrl:safeUrl(s.repository?.url),websiteUrl:safeUrl(s.websiteUrl),...(icons.length?{icons}:{}),options};
}
function resolveOption(item,optionId,fields={}) {
  const selected=item?.options?.find(o=>o.id===optionId);if(!selected)fail("MCP_REGISTRY_OPTION_INVALID");
  const transport=clone(selected.transport),env={},headers={},requiredFields=[],configuredFields=[];
  const argumentsMap={},variables={};
  for(const f of selected.fields) {
    const key=`${f.location}:${f.name}`;if(f.required)requiredFields.push(key);
    const source={env:fields.env,header:fields.headers,argument:fields.arguments,variable:fields.variables}[f.location]||{};
    const value=source[f.name]??f.default;
    if(value===undefined||value==="") {if(f.required)fail("MCP_SETUP_REQUIRED");continue;}
    if(!text(value,32768))fail("MCP_SECRET_INVALID");configuredFields.push(key);
    if(f.location==="env")env[f.name]=value;else if(f.location==="header")headers[f.name]=value;
    else if(f.location==="argument")argumentsMap[f.name]=value;else variables[f.name]=value;
  }
  if(transport.kind==="remote") {
    for(const [name,value] of Object.entries(variables))transport.url=transport.url.replaceAll(`{${name}}`,encodeURIComponent(value));
    if(/[{}]/u.test(transport.url))fail("MCP_SETUP_REQUIRED");transport.url=validateMcpRemoteUrl(transport.url);
  }else {
    transport.packageArgs=[];
    for(const arg of selected.argumentTemplates||[]) {
      const value=arg.field?argumentsMap[arg.field]:arg.value;if(value===undefined)continue;
      if(arg.type==="named")transport.packageArgs.push(arg.name);transport.packageArgs.push(value);
    }
    validatePackageTransport(transport);
  }
  return {transport,env,headers,requiredFields,configuredFields};
}
async function readJson(response) {
  if(!response?.ok)fail("MCP_REGISTRY_UNAVAILABLE");
  if(Number(response.headers?.get?.("content-length")||0)>MAX_BODY)fail();
  const reader=response.body?.getReader?.();let data;
  if(reader){const chunks=[];let total=0;try {for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>MAX_BODY){await reader.cancel();fail();}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}data=Buffer.concat(chunks).toString("utf8");}
  else {data=await response.text();if(Buffer.byteLength(data)>MAX_BODY)fail();}
  try{return JSON.parse(data);}catch{fail();}
}
class McpRegistryClient {
  constructor(options={}) {this.fetch=options.fetch||require("./mcp-http-fetch").getMcpFetch();this.now=options.now||Date.now;this.ttlMs=options.ttlMs??5*60*1000;this.baseUrl=BASE;this.packageLauncher=options.packageLauncher||new McpPackageLauncher();this.cache=new Map();this.seenCursors=new Map();}
  async _fetch(url) {const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),15000);try{return await readJson(await this.fetch(url,{signal:controller.signal,redirect:"error",headers:{accept:"application/json"}}));}catch(e){if(typeof e?.code==="string"&&e.code.startsWith("MCP_"))throw e;fail("MCP_REGISTRY_UNAVAILABLE");}finally{clearTimeout(timer);}}
  async _availability(item) {
    for(const option of item.options) {
      option.available=true;option.errorCode=null;
      if(option.transport.kind==="stdio-package")try{await this.packageLauncher.prepare(option.transport);}catch{option.available=false;option.errorCode="MCP_PACKAGE_RUNTIME_MISSING";}
    }
    return item;
  }
  async list({search="",cursor=null}={}) {
    if(!text(search,256)||cursor!==null&&(!text(cursor,2048)||!cursor))fail("MCP_REGISTRY_REQUEST_INVALID");
    const key=JSON.stringify([search,cursor]),cached=this.cache.get(key);if(cached&&this.now()-cached.cachedAt<this.ttlMs)return clone(cached);
    const url=new URL(`${this.baseUrl}/servers`);if(search)url.searchParams.set("search",search);if(cursor)url.searchParams.set("cursor",cursor);url.searchParams.set("limit","50");
    url.searchParams.set("version","latest"); // Historical versions can fill a page before a featured server's latest entry.
    const value=await this._fetch(url.href);if(!plain(value)||!Array.isArray(value.servers)||value.servers.length>100||!plain(value.metadata))fail();
    const items=[];for(const entry of value.servers){try{const parsed=parseRegistryEntry(entry);if(parsed)items.push(await this._availability(parsed));}catch{}}
    const nextCursor=value.metadata.nextCursor||null;if(nextCursor!==null&&(!text(nextCursor,2048)||nextCursor===cursor))fail("MCP_REGISTRY_CURSOR_INVALID");
    // A cycle in server cursors is rejected; repeated cached reads remain harmless.
    let edges=this.seenCursors.get(search);if(!cursor||!edges){edges=new Map();this.seenCursors.set(search,edges);}
    if(nextCursor&&edges.has(nextCursor))fail("MCP_REGISTRY_CURSOR_INVALID");edges.set(cursor,nextCursor);
    const result={items,nextCursor,featured:[...FEATURED],cachedAt:this.now()};
    this.cache.set(key,result);if(this.cache.size>128)this.cache.delete(this.cache.keys().next().value);return clone(result);
  }
  async get(name,version) {
    if(!text(name,256)||!text(version,256)||!name||!version)fail("MCP_REGISTRY_REQUEST_INVALID");
    const value=await this._fetch(`${this.baseUrl}/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`);
    const item=parseRegistryEntry(value);if(!item||item.registryName!==name||item.version!==version)fail("MCP_REGISTRY_OPTION_INVALID");return this._availability(item);
  }
  resolveOption(item,optionId,fields){return resolveOption(item,optionId,fields);}
}
module.exports={McpRegistryClient,parseRegistryEntry,resolveOption,REGISTRY_BASE_URL:BASE};
