"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");
const { ensurePrivateDirectoryTree, lstatIfExists, serviceError } = require("./security");
const { validatePackageTransport } = require("./mcp-package-launcher");
const { desktopPreset, validateDesktopPreset } = require("./mcp-desktop-presets");
const { matchOfficialSkillBridgeLaunch, validateOfficialSkillBridgeLaunch } = require("./official-skill-mcp-launch");
const { matchTicketmasterBridgeLaunch, validateTicketmasterBridgeLaunch } = require("./ticketmaster-mcp-launch");
const { matchFlightawareBridgeLaunch, validateFlightawareBridgeLaunch } = require("./flightaware-mcp-launch");
const SCHEMA_VERSION = 2, MAX_REGISTRY_BYTES = 1024 * 1024, MAX_SERVERS = 64;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const FORBIDDEN_EXECUTABLES = new Set(["bash", "csh", "dash", "env", "fish", "osascript", "sh", "tcsh", "zsh"]);
const STATUSES = new Set(["needsSetup", "signedOut", "checking", "ready", "failed", "disabled"]);
function mcpError(code, message = code) { return serviceError(code, message); }
function own(v) { return v && Object.getPrototypeOf(v) === Object.prototype; }
function exact(v, required, optional = []) { return own(v) && Reflect.ownKeys(v).every(k => required.includes(k) || optional.includes(k)) && required.every(k => Object.hasOwn(v,k)); }
function safeText(v, max = 4096, empty = false) { return typeof v === "string" && v.isWellFormed() && !v.includes("\0") && (empty || v.length > 0) && Buffer.byteLength(v) <= max; }
function inside(root,target) { const r = path.relative(root,target); return r === "" || r !== ".." && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r); }
function clone(v) { return JSON.parse(JSON.stringify(v)); }
function remoteUrl(value) {
  if (!safeText(value, 4096)) throw mcpError("MCP_SERVER_URL_INVALID");
  let u; try { u = new URL(value); } catch { throw mcpError("MCP_SERVER_URL_INVALID"); }
  if (u.username || u.password || u.hash || !(u.protocol === "https:" || u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname))) throw mcpError("MCP_SERVER_URL_INVALID");
  // Credential values belong in the encrypted envelope, never this public URL.
  if ([...u.searchParams.keys()].some(k => /token|secret|password|api.?key|authorization|^key$/iu.test(k))) throw mcpError("MCP_SERVER_URL_INVALID");
  return u.href;
}
function publicServer(r) {
  // Presentation only: keep the known module identity while argv stays private.
  // This does not attest the installed package or relax executable validation.
  const recommendationId = r.source.kind === "custom" && r.transport.kind === "stdio-command" && matchTicketmasterBridgeLaunch(r.transport.command, r.transport.args)
    ? "ticketmaster" : r.source.kind === "custom" && r.transport.kind === "stdio-command" && matchFlightawareBridgeLaunch(r.transport.command, r.transport.args)
    ? "flightaware" : r.source.kind === "custom" && r.transport.kind === "stdio-command"
    && /^python(?:\d+(?:\.\d+)*)?$/u.test(path.basename(r.transport.command))
    && r.transport.args.length === 2 && r.transport.args[0] === "-m" && r.transport.args[1] === "blmcp"
    ? "blender-lab" : null;
  let transport;
  if (r.transport.kind === "stdio-command") transport = { kind: "stdio-command", command: r.transport.command };
  else if (r.transport.kind === "stdio-package") transport = { kind: "stdio-package", registryType: r.transport.registryType, identifier: r.transport.identifier, version: r.transport.version };
  else transport = { ...r.transport };
  return { id: r.id, name: r.name, enabled: r.enabled, createdAt: r.createdAt, updatedAt: r.updatedAt,
    source: clone(r.source), transport, auth: clone(r.auth), setup: clone(r.setup), status: r.status,
    lastCheck: clone(r.lastCheck), disabledProfileIds: [...r.disabledProfileIds], ...(recommendationId ? { recommendationId } : {}) };
}
class NativeMcpStore {
  constructor(options = {}) {
    if (!options.paths?.nativeMcpDir || !options.paths?.nativeMcpRegistryPath || !options.paths?.defaultWorkspaceDir || !options.paths?.trustedRoot) throw new TypeError("NativeMcpStore requires Service MCP paths");
    this.paths = options.paths; this.fs = options.fs || fs; this.now = options.now || Date.now; this.registry = null; this.opened = false;
    this.validateDesktopPreset = options.validateDesktopPreset || validateDesktopPreset;
    try { this.trustedRootReal = this.fs.realpathSync(this.paths.trustedRoot); } catch { this.trustedRootReal = path.resolve(this.paths.trustedRoot); }
  }
  _assertOpen() { if (!this.opened) throw mcpError("MCP_REGISTRY_CLOSED"); }
  _validateExecutable(command, args) {
    const desktop = desktopPreset(command, args);
    const officialSkill = matchOfficialSkillBridgeLaunch(command, args, { paths: this.paths });
    const ticketmaster = matchTicketmasterBridgeLaunch(command, args);
    const flightaware = matchFlightawareBridgeLaunch(command, args);
    if (!path.isAbsolute(command) || !inside(this.paths.trustedRoot, command) && !desktop && !officialSkill && !ticketmaster && !flightaware) {
      throw mcpError("MCP_SERVER_PATH_INVALID", "MCP 启动命令必须位于当前用户的受信目录");
    }
    let stat;
    let real;
    try {
      stat = this.fs.statSync(command);
      real = this.fs.realpathSync(command);
      this.fs.accessSync(command, fs.constants.X_OK);
    } catch {
      throw mcpError("MCP_SERVER_PATH_INVALID", "MCP 启动命令不存在或不可执行");
    }
    if (!stat.isFile()) throw mcpError("MCP_SERVER_PATH_INVALID", "MCP 启动命令不是文件");
    const executable = path.basename(real).toLowerCase();
    if (FORBIDDEN_EXECUTABLES.has(executable)) {
      throw mcpError("MCP_SERVER_COMMAND_FORBIDDEN", "不能把 shell 注册为 MCP Server");
    }
    if (officialSkill) {
      validateOfficialSkillBridgeLaunch(command, args, { paths: this.paths, fsModule: this.fs });
      return;
    }
    if (ticketmaster) {
      validateTicketmasterBridgeLaunch(command, args, { fsModule: this.fs });
      return;
    }
    if (flightaware) {
      validateFlightawareBridgeLaunch(command, args, { fsModule: this.fs });
      return;
    }
    if (desktop && (!inside(this.paths.trustedRoot, command) || !inside(this.trustedRootReal, real))) {
      this.validateDesktopPreset(command, args, real);
      return;
    }
    if (!inside(this.trustedRootReal, real)) {
      const runtime = /^(?:python(?:\d+(?:\.\d+)*)?|node)$/u.test(executable);
      if (!runtime) throw mcpError("MCP_SERVER_PATH_INVALID", "MCP 命令解析到不受支持的外部程序");
      if (/^python/u.test(executable)
        && (args.length < 2 || args[0] !== "-m" || !/^[A-Za-z0-9_.-]{1,256}$/u.test(args[1]))) {
        throw mcpError("MCP_SERVER_COMMAND_FORBIDDEN", "工作区 Python MCP 必须使用 python -m module 启动");
      }
    }
  }

  _legacy(input, options = {}) {
    if (!exact(input,["id","name","command","args","cwd","enabled"])) throw mcpError("MCP_SERVER_INVALID");
    return this._prepare({ id: input.id, name: input.name, enabled: input.enabled, source: {kind:"custom"},
      transport: { kind:"stdio-command", command:input.command,args:input.args,cwd:input.cwd }, auth:{kind:"none"},secretRef:null,
      setup:{requiredFields:[],configuredFields:[]},status:input.enabled ? "ready" : "disabled",lastCheck:null,disabledProfileIds:[] }, options);
  }
  _prepare(input, { allowInertPath = false } = {}) {
    if (input?.command !== undefined) return this._legacy(input, {allowInertPath});
    const required=["id","name","enabled","source","transport","auth","secretRef","setup","status","lastCheck","disabledProfileIds"];
    if (!exact(input,required) || !ID_PATTERN.test(input.id) || !safeText(input.name,256) || !input.name.trim() || typeof input.enabled !== "boolean"
      || !STATUSES.has(input.status) || !input.enabled && input.status !== "disabled") throw mcpError("MCP_SERVER_INVALID");
    const s=input.source,t=input.transport;
    if (!(exact(s,["kind"]) && s.kind === "custom" || exact(s,["kind","registryName","version"]) && s.kind === "registry"
      && safeText(s.registryName,256) && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(s.registryName) && safeText(s.version,256))) throw mcpError("MCP_SERVER_INVALID");
    let transport;
    if (exact(t,["kind","command","args","cwd"]) && t.kind === "stdio-command") {
      if (!safeText(t.command) || !path.isAbsolute(t.command) || !safeText(t.cwd) || !path.isAbsolute(t.cwd)
        || !Array.isArray(t.args) || t.args.length > 64 || t.args.some(v => !safeText(v,4096,true))) throw mcpError("MCP_SERVER_INVALID");
      transport={...t,command:path.resolve(t.command),cwd:path.resolve(t.cwd),args:[...t.args]};
      if (!allowInertPath) {
        if (!inside(this.paths.trustedRoot,transport.cwd)) throw mcpError("MCP_SERVER_PATH_INVALID");
        try { if (!this.fs.statSync(transport.cwd).isDirectory() || !inside(this.trustedRootReal,this.fs.realpathSync(transport.cwd))) throw new Error(); }
        catch { throw mcpError("MCP_SERVER_PATH_INVALID"); }
        this._validateExecutable(transport.command,transport.args);
      }
    } else if (exact(t,["kind","registryType","identifier","version"],["packageArgs"]) && t.kind === "stdio-package") transport=validatePackageTransport(t);
    else if (exact(t,["kind","protocol","url"]) && t.kind === "remote" && ["streamable-http","sse"].includes(t.protocol)) transport={...t,url:remoteUrl(t.url)};
    else throw mcpError("MCP_SERVER_INVALID");
    if (!exact(input.auth,["kind"]) || !["none","headers","oauth-dcr","oauth-client"].includes(input.auth.kind)
      || input.secretRef !== null && input.secretRef !== `mcp-connector:${input.id}`) throw mcpError("MCP_SERVER_INVALID");
    if (!exact(input.setup,["requiredFields","configuredFields"]) || ["requiredFields","configuredFields"].some(k => !Array.isArray(input.setup[k])
      || input.setup[k].length>128 || input.setup[k].some(v=>!safeText(v,256)) || new Set(input.setup[k]).size!==input.setup[k].length)) throw mcpError("MCP_SERVER_INVALID");
    const check=input.lastCheck;
    if (check !== null && (!exact(check,["at","toolCount","errorCode"]) || !Number.isSafeInteger(check.at) || check.at<0
      || !Number.isSafeInteger(check.toolCount) || check.toolCount<0 || check.toolCount>10000 || check.errorCode!==null && !/^[A-Z][A-Z0-9_]{0,127}$/u.test(check.errorCode))) throw mcpError("MCP_SERVER_INVALID");
    if (!Array.isArray(input.disabledProfileIds) || input.disabledProfileIds.length>1024 || input.disabledProfileIds.some(v=>!safeText(v,128)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(v)) || new Set(input.disabledProfileIds).size!==input.disabledProfileIds.length) throw mcpError("MCP_SERVER_INVALID");
    return clone({...input,transport,name:input.name.normalize("NFKC").trim()});
  }
  prepare(input) { this._assertOpen(); return this._prepare(input); }
  prepareLaunch(input) {
    this._assertOpen();const {createdAt,updatedAt,...spec}=input;
    return this._prepare(spec);
  }
  _validateRegistry(value,{inertAll=false}={}) {
    if (!exact(value,["schemaVersion","revision","updatedAt","servers"]) || ![1,2].includes(value.schemaVersion)
      || !Number.isSafeInteger(value.revision) || value.revision<1 || !Number.isSafeInteger(value.updatedAt) || value.updatedAt<0
      || !Array.isArray(value.servers) || value.servers.length>MAX_SERVERS) throw mcpError("MCP_REGISTRY_CORRUPT");
    const ids=new Set();
    const servers=value.servers.map(r=>{
      const {createdAt,updatedAt,...spec}=r;
      if (ids.has(r.id) || !Number.isSafeInteger(createdAt) || createdAt<0 || !Number.isSafeInteger(updatedAt) || updatedAt<createdAt) throw mcpError("MCP_REGISTRY_CORRUPT");
      let prepared;
      try { prepared=value.schemaVersion===1 ? this._legacy(spec,{allowInertPath:true}) : this._prepare(spec,{allowInertPath:true}); }
      catch(error) { if (error.code==="MCP_SERVER_PATH_INVALID" || error.code==="MCP_SERVER_COMMAND_FORBIDDEN") throw error; throw mcpError("MCP_REGISTRY_CORRUPT"); }
      if(!inertAll&&prepared.status==="checking") {
        prepared.status="failed";prepared.lastCheck={at:this.now(),toolCount:0,errorCode:"MCP_CHECK_INTERRUPTED"};
      }
      // Persisted registrations are inert data until their individual launch is
      // strictly revalidated. A missing command never closes unrelated servers.
      if(!inertAll&&prepared.enabled&&prepared.transport.kind==="stdio-command") {
        try {
          const t=prepared.transport;
          this._validateExecutable(t.command,t.args);
          if(!inside(this.paths.trustedRoot,t.cwd)||!this.fs.statSync(t.cwd).isDirectory()||!inside(this.trustedRootReal,this.fs.realpathSync(t.cwd)))throw mcpError("MCP_SERVER_PATH_INVALID");
        }catch(error){prepared.status="failed";prepared.lastCheck={at:this.now(),toolCount:0,errorCode:error?.code==="MCP_SERVER_COMMAND_FORBIDDEN"?error.code:"MCP_SERVER_PATH_INVALID"};}
      }
      ids.add(r.id); return {...prepared,createdAt,updatedAt};
    });
    return {...value,schemaVersion:2,servers};
  }
  open() {
    ensurePrivateDirectoryTree(this.paths.nativeMcpDir,this.paths.trustedRoot);
    if (!lstatIfExists(this.paths.nativeMcpRegistryPath)) atomicWritePrivateFile(this.paths.nativeMcpRegistryPath,`${JSON.stringify({schemaVersion:2,revision:1,updatedAt:this.now(),servers:[]})}\n`,{fs:this.fs,trustedRoot:this.paths.trustedRoot});
    try {
      const raw=JSON.parse(readPrivateFile(this.paths.nativeMcpRegistryPath,{fs:this.fs,maxBytes:MAX_REGISTRY_BYTES}).toString("utf8"));
      this.registry=this._validateRegistry(raw); this.opened=true;
      if (raw.schemaVersion===1) this._commit(this.registry.servers);
    } catch(error) { this.registry=null;this.opened=false;if(error?.code)throw error;throw mcpError("MCP_REGISTRY_CORRUPT"); }
    return this;
  }
  close() { this.registry=null;this.opened=false; }
  get revision() { this._assertOpen();return this.registry.revision; }
  list() { this._assertOpen();return {revision:this.registry.revision,servers:this.registry.servers.map(publicServer)}; }
  get(id) { const r=this.getPrivate(id);return r?publicServer(r):null; }
  getPrivate(id) { this._assertOpen();const r=this.registry.servers.find(s=>s.id===id);return r?clone(r):null; }
  isAvailable(id,profileId) { const r=this.getPrivate(id);return Boolean(r&&r.enabled&&r.status==="ready"&&!r.disabledProfileIds.includes(profileId)); }
  _cas(revision) { this._assertOpen();if(revision!==this.registry.revision)throw mcpError("MCP_REGISTRY_REVISION_CONFLICT"); }
  _commit(servers) {
    const next={schemaVersion:2,revision:this.registry.revision+1,updatedAt:this.now(),servers:clone(servers)};
    const validated=this._validateRegistry(next,{inertAll:true});
    const raw=`${JSON.stringify(next)}\n`;if(Buffer.byteLength(raw)>MAX_REGISTRY_BYTES)throw mcpError("MCP_REGISTRY_CAPACITY");
    try { atomicWritePrivateFile(this.paths.nativeMcpRegistryPath,raw,{fs:this.fs,trustedRoot:this.paths.trustedRoot}); }
    catch(error) { if(error.committed || error.committedUncertain){this.opened=false;this.registry=null;throw mcpError("MCP_REGISTRY_COMMIT_UNCERTAIN");}throw error; }
    this.registry=validated;return next.revision;
  }
  register({server,expectedRevision}={}) {
    this._cas(expectedRevision);const existing=this.registry.servers.find(r=>r.id===server?.id);
    const sameTransport=server?.transport&&existing&&JSON.stringify(server.transport)===JSON.stringify(existing.transport);
    const prepared=sameTransport?this._prepare(server,{allowInertPath:true}):this.prepare(server);
    if(!existing&&this.registry.servers.length>=MAX_SERVERS)throw mcpError("MCP_REGISTRY_CAPACITY");
    const record={...prepared,createdAt:existing?.createdAt??this.now(),updatedAt:Math.max(this.now(),existing?.createdAt??0)};
    const next=this.registry.servers.filter(r=>r.id!==record.id);next.push(record);next.sort((a,b)=>a.id.localeCompare(b.id));
    return {revision:this._commit(next),server:publicServer(record),replaced:Boolean(existing)};
  }
  add(input) { if(this.getPrivate(input?.server?.id))throw mcpError("MCP_SERVER_ALREADY_EXISTS");return this.register(input); }
  update({id,patch,expectedRevision}={}) {
    this._cas(expectedRevision);const current=this.getPrivate(id);if(!current)throw mcpError("MCP_SERVER_NOT_FOUND");
    if(!own(patch)||Object.keys(patch).some(k=>!["name","enabled","source","transport","auth","secretRef","setup","status","lastCheck","disabledProfileIds"].includes(k)))throw mcpError("MCP_SERVER_INVALID");
    const {createdAt,updatedAt,...spec}=current;const next={...spec,...clone(patch)};
    if(next.enabled===false)next.status="disabled";else if(patch.enabled===true&&current.status==="disabled"&&!patch.status)next.status="checking";
    return this.register({server:next,expectedRevision});
  }
  setStatus(id,status,lastCheck=null) { return this.update({id,patch:{status,lastCheck},expectedRevision:this.revision}); }
  remove({id,expectedRevision}={}) {
    this._cas(expectedRevision);const existing=this.getPrivate(id);if(!existing)throw mcpError("MCP_SERVER_NOT_FOUND");
    return {revision:this._commit(this.registry.servers.filter(r=>r.id!==id)),removed:publicServer(existing)};
  }
  pruneDisabledProfiles(profileIds) {
    const allowed=new Set(profileIds);const servers=this.registry.servers.map(r=>({...r,disabledProfileIds:r.disabledProfileIds.filter(id=>allowed.has(id))}));
    return JSON.stringify(servers)===JSON.stringify(this.registry.servers)?this.revision:this._commit(servers);
  }
}
function quarantineNativeMcpRegistryForRestore({paths,now=Date.now}={}) {
  if(!paths?.nativeMcpRegistryPath||!lstatIfExists(paths.nativeMcpRegistryPath))return null;
  const store=new NativeMcpStore({paths,now});let raw;
  try { raw=JSON.parse(readPrivateFile(paths.nativeMcpRegistryPath,{maxBytes:MAX_REGISTRY_BYTES}).toString("utf8")); }catch{throw mcpError("MCP_REGISTRY_CORRUPT");}
  const verified=store._validateRegistry(raw,{inertAll:true}),disabled=verified.servers.filter(s=>s.enabled).length;
  const next={...verified,revision:verified.revision+1,updatedAt:now(),servers:verified.servers.map(s=>({...s,enabled:false,status:"disabled",secretRef:null,
    setup:{...s.setup,configuredFields:[]},lastCheck:null,updatedAt:Math.max(now(),s.createdAt)}))};
  store._validateRegistry(next,{inertAll:true});
  atomicWritePrivateFile(paths.nativeMcpRegistryPath,`${JSON.stringify(next)}\n`,{trustedRoot:paths.trustedRoot});
  return Object.freeze({disabled,retained:next.servers.length});
}
module.exports={NativeMcpStore,quarantineNativeMcpRegistryForRestore,publicMcpServer:publicServer,validateMcpRemoteUrl:remoteUrl,MCP_CONNECTOR_STATUSES:STATUSES};
