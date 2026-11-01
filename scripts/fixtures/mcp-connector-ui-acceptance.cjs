#!/usr/bin/env node
"use strict";
// Disposable UI acceptance harness. Product UI, REST, Backend, Service and MCP
// clients are real. Registry metadata, OAuth provider and runtime are fixtures.
// No product CSP, production preferences, real accounts or Keychain entries change.
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),http=require("node:http"),crypto=require("node:crypto"),assert=require("node:assert/strict");
const {startInspirationFixture}=require("./inspiration-service-fixture.cjs");
const {createConfigStore}=require("../../app/core/config-store");
const {McpRegistryClient}=require("../../app/agent-service/mcp-registry-client");
const FEATURED=require("../../app/agent-service/data/mcp-featured-servers.json");
const FIXTURE_NAME="dev.shoggoth.ui/acceptance",HEADER_VALUE="Bearer ui-header-ok",CLIENT_ID="ui-pre-registered-client",CLIENT_SECRET="ui-client-secret";
const CSP="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self' http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'";
const esc=value=>String(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
async function startUiAcceptance(){
  const configRoot=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"mcp-ui-config-")));fs.chmodSync(configRoot,0o700);
  const configStore=createConfigStore(path.join(configRoot,"config.json"));configStore.ensure();configStore.write({theme:"light",locale:"zh-CN"});
  const state={registryFailNext:false,registryPageFailNext:false,registryVersion:"1.0.0",registryCalls:0,headerRejected:0,headerAccepted:0,registrations:0,exchanges:0,oauthMode:"dcr",failNextExchange:false,authorizations:0,refreshes:0};
  const authorizationTickets=new Map(),codes=new Map(),sockets=new Set();let origin,f,closing=false;
  const accessToken="ui-acceptance-access-token",refreshToken="ui-acceptance-refresh-token";
  const read=async req=>{let raw="";for await(const bytes of req){raw+=bytes;if(Buffer.byteLength(raw)>16384)throw Error("BODY_TOO_LARGE");}return raw;};
  const json=(res,status,value)=>{res.writeHead(status,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify(value));};
  const html=(res,source)=>{res.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store","content-security-policy":CSP});res.end(source);};
  const envelope=(name,version=state.registryVersion,extra=false)=>({server:{name,title:`UI FIXTURE — ${name===FIXTURE_NAME?"Versioned connector":name}`,description:"Synthetic Registry upstream for UI acceptance; this is not a third-party account or service.",version,remotes:[{type:"streamable-http",url:`${origin}/public/${version}${extra?"-extra":""}`}],repository:{url:"https://github.com/modelcontextprotocol/servers"}},_meta:{"io.modelcontextprotocol.registry/official":{status:"active",isLatest:true}}});
  const registry=new McpRegistryClient({ttlMs:0,fetch:async raw=>{
    const url=new URL(raw);state.registryCalls++;
    const search=url.searchParams.get("search")||"",cursor=url.searchParams.get("cursor");
    if(url.pathname.endsWith("/servers")){
      if(!search&&!cursor&&state.registryFailNext){state.registryFailNext=false;return new Response("{}",{status:503});}
      if(cursor&&state.registryPageFailNext){state.registryPageFailNext=false;return new Response("{}",{status:503});}
      const entries=search?(FEATURED.includes(search)?[envelope(search)]:search.toLowerCase().includes("acceptance")?[envelope(FIXTURE_NAME)]:[]):cursor?[envelope("dev.shoggoth.ui/page-two",state.registryVersion,true)]:[envelope(FIXTURE_NAME)];
      return Response.json({servers:entries,metadata:{nextCursor:!search&&!cursor?"ui-page-two":null,count:entries.length}});
    }
    const match=url.pathname.match(/\/servers\/([^/]+)\/versions\/([^/]+)$/);if(!match)return new Response("{}",{status:404});
    const name=decodeURIComponent(match[1]),version=decodeURIComponent(match[2]);if(!["1.0.0","1.0.1"].includes(version))return new Response("{}",{status:404});
    return Response.json(envelope(name,version));
  }});
  const publicState=()=>({disposable:true,config: {theme:configStore.read().theme,locale:configStore.read().locale},productUrl:f?`${f.url}/#/connectors`:null,agentsUrl:f?`${f.url}/#/agents`:null,
    endpoints:{public:`${origin}/public/1.0.0`,header:`${origin}/header`,oauth:`${origin}/mcp`},registry:{name:FIXTURE_NAME,version:state.registryVersion,calls:state.registryCalls,failNext:state.registryFailNext,pageFailNext:state.registryPageFailNext},
    oauth:{mode:state.oauthMode,failNextExchange:state.failNextExchange,authorizations:state.authorizations,registrations:state.registrations,exchanges:state.exchanges,refreshes:state.refreshes},header:{accepted:state.headerAccepted,rejected:state.headerRejected},
    servers:f?f.service.nativeMcpStore.list().servers.map(s=>({id:s.id,name:s.name,version:s.source.version||null,status:s.status,enabled:s.enabled,disabledProfileIds:s.disabledProfileIds,toolCount:s.lastCheck?.toolCount||0})):[],
    command:f?path.join(f.paths.defaultWorkspaceDir,"ui-mcp-fixture.cjs"):null});
  const perform=async(action,body)=>{
    if(action==="appearance"){if(!["light","dark"].includes(body.theme)||!["zh-CN","en"].includes(body.locale))throw Error("INVALID_APPEARANCE");configStore.write({theme:body.theme,locale:body.locale});}
    else if(action==="registry-fail-next")state.registryFailNext=true;
    else if(action==="page-fail-next")state.registryPageFailNext=true;
    else if(action==="oauth-mode"){if(!["dcr","pre-registered"].includes(body.mode))throw Error("INVALID_OAUTH_MODE");state.oauthMode=body.mode;}
    else if(action==="oauth-fail-next")state.failNextExchange=true;
    else if(action==="seed-update"){
      const result=await f.service.mcpConnectorController.add({source:{kind:"registry",registryName:FIXTURE_NAME,version:"1.0.0"},option:{id:"remote:0"},expectedRevision:f.service.nativeMcpStore.revision});
      assert.equal(result.server.status,"ready");state.registryVersion="1.0.1";
    }else if(action==="seed-restored"){
      const store=f.service.nativeMcpStore,id="mcp-ui-restored";if(!store.get(id))store.register({expectedRevision:store.revision,server:{id,name:"UI FIXTURE — restored disabled",enabled:false,source:{kind:"custom"},transport:{kind:"remote",protocol:"streamable-http",url:`${origin}/public/1.0.0`},auth:{kind:"none"},secretRef:null,setup:{requiredFields:[],configuredFields:[]},status:"disabled",lastCheck:null,disabledProfileIds:[]}});
    }else throw Error("UNKNOWN_ACTION");
    return publicState();
  };
  const controlJs=`const output=document.getElementById('state');const report=()=>{document.getElementById('viewport').textContent=JSON.stringify({innerWidth,innerHeight,visualWidth:visualViewport?.width,dpr:devicePixelRatio,narrow680:matchMedia('(max-width: 680px)').matches});};addEventListener('resize',report);report();async function refresh(){const state=await(await fetch('/control/state')).json();output.textContent=JSON.stringify(state,null,2);for(const link of document.querySelectorAll('[data-product]'))link.href=state.productUrl;document.querySelector('[data-agents]').href=state.agentsUrl;}for(const form of document.querySelectorAll('form[data-action]'))form.addEventListener('submit',async event=>{event.preventDefault();const body=Object.fromEntries(new FormData(form));const response=await fetch('/control/'+form.dataset.action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});output.textContent=JSON.stringify(await response.json(),null,2);});document.getElementById('refresh').addEventListener('click',refresh);refresh();`;
  const server=http.createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,origin);if(url.pathname==="/control/state")return json(res,200,publicState());
      if(url.pathname==="/control.js"){res.writeHead(200,{"content-type":"application/javascript","cache-control":"no-store"});return res.end(controlJs);}
      if(url.pathname.startsWith("/control/")){
        if(req.method!=="POST"||req.headers.origin!==origin)return json(res,403,{error:"FIXTURE_ORIGIN_REQUIRED"});
        return json(res,200,await perform(url.pathname.slice(9),JSON.parse(await read(req))));
      }
      if(url.pathname==="/")return html(res,`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MCP UI acceptance — disposable fixture</title><style>body{font:15px system-ui;max-width:940px;margin:24px auto;padding:0 18px;color:#20242b;background:#fafafa}button,select,a{font:inherit;margin:5px;padding:7px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eee;padding:14px}form{margin:14px 0;border:1px solid #ccc;padding:10px}code{overflow-wrap:anywhere}.warning{border:2px solid #ad7d30;padding:12px}#viewport{position:sticky;top:0;background:#fff8cd;padding:10px}</style><h1>MCP UI 验收控制页</h1><p class="warning">仅临时测试环境。真实产品 compiled UI / Service / Backend / HTTP 客户端；Registry 上游、OAuth Provider、凭据后端及模型 Runtime 是受控夹具。此页不证明真实第三方账号、安装包或安全存储。产品 CSP 原样保留。</p><p id="viewport" aria-live="polite"></p><p><a data-product href="#">同一标签打开产品连接器页</a> · <a data-agents href="#">打开产品助理设置页</a> · <button id="refresh">读取非敏感状态</button></p><form data-action="appearance"><strong>仅改临时 config.json；保存后打开或刷新产品页</strong><br><label>Theme <select name="theme"><option>light</option><option>dark</option></select></label><label>Locale <select name="locale"><option>zh-CN</option><option>en</option></select></label><button>保存测试主题/语言</button></form><form data-action="registry-fail-next"><button>下一次目录首页失败一次</button></form><form data-action="page-fail-next"><button>下一次目录分页失败一次</button></form><form data-action="seed-update"><button>准备旧版 Registry 1.0.0 → 可更新 1.0.1</button></form><form data-action="seed-restored"><button>准备恢复后停用记录（disabled）</button></form><form data-action="oauth-mode"><label>OAuth <select name="mode"><option value="dcr">DCR 动态注册</option><option value="pre-registered">仅预注册客户端</option></select></label><button>设置测试 Provider 模式</button></form><form data-action="oauth-fail-next"><button>下一次 OAuth token 交换失败一次</button></form><h2>一次性测试输入</h2><p>Header 正确值（仅此夹具）：<code>{"Authorization":"Bearer ui-header-ok"}</code>；错误值填 <code>{"Authorization":"Bearer wrong-ui-value"}</code>。先使用下方 header URL，错误返回422，不会被OAuth自动成功掩盖。</p><p>预注册客户端仅此夹具：Client ID <code>${CLIENT_ID}</code>，Client secret <code>${CLIENT_SECRET}</code>。产品会显示真实Service回调地址；测试Provider接受该回调，无需修改正式OAuth应用。</p><p>OAuth授权新标签默认停在可见确认页，可先回产品点取消再回来继续验证迟到回调；正常点击Continue完成。</p><p>固定命令样本路径见下方 state.command，参数填 <code>[]</code>。Registry目录和推荐标题均标为 UI FIXTURE，不是所命名真实服务。</p><pre id="state" aria-live="polite">正在读取…</pre><script src="/control.js"></script>`);
      if(url.pathname.startsWith("/.well-known/oauth-protected-resource"))return json(res,200,{resource:`${origin}/mcp`,authorization_servers:[origin],scopes_supported:["read"]});
      if(["/.well-known/oauth-authorization-server","/.well-known/openid-configuration"].includes(url.pathname))return json(res,200,{issuer:origin,authorization_endpoint:`${origin}/authorize`,token_endpoint:`${origin}/token`,...(state.oauthMode==="dcr"?{registration_endpoint:`${origin}/register`}:{}),response_types_supported:["code"],grant_types_supported:["authorization_code","refresh_token"],token_endpoint_auth_methods_supported:["none","client_secret_basic"],code_challenge_methods_supported:["S256"]});
      if(url.pathname==="/register"){if(state.oauthMode!=="dcr")return json(res,403,{error:"registration_disabled"});state.registrations++;const metadata=JSON.parse(await read(req));return json(res,201,{...metadata,client_id:"ui-fixture-dcr",client_id_issued_at:1});}
      if(url.pathname==="/authorize"){
        const query=Object.fromEntries(url.searchParams),ticket=crypto.randomUUID();let redirect;try{redirect=new URL(query.redirect_uri);if(!["127.0.0.1","localhost"].includes(redirect.hostname)||redirect.protocol!=="http:"||query.resource!==`${origin}/mcp`||query.code_challenge_method!=="S256")throw Error();}catch{return json(res,400,{error:"INVALID_FIXTURE_AUTHORIZATION"});}
        authorizationTickets.set(ticket,{...query,expiresAt:Date.now()+300000});state.authorizations++;
        return html(res,`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Local OAuth fixture approval</title><h1>Local OAuth UI fixture</h1><p>No real account is being connected. Return to the product to cancel before using these buttons if testing a late callback.</p><form action="/authorize/complete" method="post"><input type="hidden" name="ticket" value="${esc(ticket)}"><button name="decision" value="continue">Continue fixture authorization</button><button name="decision" value="deny">Deny fixture authorization</button></form>`);
      }
      if(url.pathname==="/authorize/complete"){
        if(req.method!=="POST"||req.headers.origin!==origin)return json(res,403,{error:"FIXTURE_ORIGIN_REQUIRED"});const body=new URLSearchParams(await read(req)),ticket=authorizationTickets.get(body.get("ticket"));authorizationTickets.delete(body.get("ticket"));if(!ticket||ticket.expiresAt<=Date.now())return json(res,400,{error:"AUTHORIZATION_EXPIRED"});
        const redirect=new URL(ticket.redirect_uri);redirect.searchParams.set("state",ticket.state);redirect.searchParams.set("iss",origin);
        if(body.get("decision")==="continue"){const code=crypto.randomUUID();codes.set(code,ticket);redirect.searchParams.set("code",code);}else redirect.searchParams.set("error","access_denied");
        res.writeHead(302,{location:redirect.href});return res.end();
      }
      if(url.pathname==="/token"){
        const body=new URLSearchParams(await read(req));if(body.get("grant_type")==="refresh_token"){state.refreshes++;return json(res,200,{access_token:accessToken,refresh_token:refreshToken,token_type:"Bearer",expires_in:3600});}
        const authorization=codes.get(body.get("code"));codes.delete(body.get("code"));state.exchanges++;
        if(state.failNextExchange){state.failNextExchange=false;return json(res,400,{error:"invalid_grant"});}
        const basic=`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`;
        if(!authorization||authorization.code_challenge!==crypto.createHash("sha256").update(body.get("code_verifier")||"").digest("base64url")||body.get("redirect_uri")!==authorization.redirect_uri||body.get("resource")!==`${origin}/mcp`||state.oauthMode==="pre-registered"&&req.headers.authorization!==basic)return json(res,400,{error:"invalid_grant"});
        return json(res,200,{access_token:accessToken,refresh_token:refreshToken,token_type:"Bearer",expires_in:3600});
      }
      if(url.pathname==="/header"||url.pathname==="/mcp"||url.pathname.startsWith("/public/")){
        if(url.pathname==="/header"&&req.headers.authorization!==HEADER_VALUE){state.headerRejected++;return json(res,422,{error:"fixture_header_rejected"});}
        if(url.pathname==="/header")state.headerAccepted++;
        if(url.pathname==="/mcp"&&req.headers.authorization!==`Bearer ${accessToken}`){res.setHeader("www-authenticate",`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);return json(res,401,{});}
        if(req.method==="DELETE"){res.writeHead(200);return res.end();}if(req.method!=="POST"){res.writeHead(405);return res.end();}
        const msg=JSON.parse(await read(req));if(msg.id===undefined){res.writeHead(202);return res.end();}const tools=[{name:"ui_echo",description:"Local acceptance fixture only",inputSchema:{type:"object",properties:{value:{type:"string"}}}}];if(url.pathname.includes("1.0.1"))tools.push({name:"ui_version_two",description:"Version update UI fixture",inputSchema:{type:"object"}});
        const result=msg.method==="initialize"?{protocolVersion:"2025-11-25",capabilities:{tools:{}},serverInfo:{name:"ui-acceptance-fixture",version:"1"}}:msg.method==="tools/list"?{tools}:msg.method==="tools/call"?{content:[{type:"text",text:"UI fixture completed"}]}:null;
        return json(res,200,result?{jsonrpc:"2.0",id:msg.id,result}:{jsonrpc:"2.0",id:msg.id,error:{code:-32601,message:"Unknown method"}});
      }
      return json(res,404,{error:"NOT_FOUND"});
    }catch{return json(res,400,{error:"FIXTURE_REQUEST_INVALID"});}
  });
  server.on("connection",socket=>{sockets.add(socket);socket.on("close",()=>sockets.delete(socket));});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));origin=`http://127.0.0.1:${server.address().port}`;
  try{
    const portProbe=http.createServer();await new Promise(resolve=>portProbe.listen(0,"127.0.0.1",resolve));const callbackPort=portProbe.address().port;await new Promise(resolve=>portProbe.close(resolve));
    f=await startInspirationFixture({isolatedHome:true,configStore,codexFakeEnv:{CODEX_FAKE_AUTOCOMPLETE_ALL:"1"},serviceOptions:{mcpRegistryClient:registry,mcpOAuthCallbackPort:callbackPort,autoSparkNotes:false,setCronTimer:()=>1,clearCronTimer(){},setProactiveTimer:()=>1,clearProactiveTimer(){}}});
    const command=path.join(f.paths.defaultWorkspaceDir,"ui-mcp-fixture.cjs");fs.mkdirSync(f.paths.defaultWorkspaceDir,{recursive:true,mode:0o700});
    fs.writeFileSync(command,`#!/usr/bin/env node\nconst lines=require('node:readline').createInterface({input:process.stdin});lines.on('line',line=>{try{const m=JSON.parse(line);if(m.id===undefined)return;const result=m.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'ui-local-command-fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'ui_local_echo',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'UI local fixture'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}catch{}});\n`,{mode:0o700});
  }catch(error){for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));fs.rmSync(configRoot,{recursive:true,force:true});throw error;}
  const close=async()=>{if(closing)return;closing=true;await f.close();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));fs.rmSync(configRoot,{recursive:true,force:true});};
  return {controlUrl:origin,productUrl:`${f.url}/#/connectors`,root:f.root,configRoot,state:publicState,perform,fixture:f,close};
}
async function smoke(){const f=await startUiAcceptance();try{
  await f.perform("appearance",{theme:"dark",locale:"en"});const config=await(await fetch(`${f.fixture.url}/__api/config`)).json();assert.equal(config.config.theme,"dark");assert.equal(config.config.locale,"en");
  const html=await fetch(f.productUrl);assert.ok(html.headers.get("content-security-policy").includes("frame-ancestors 'none'"));
  await f.perform("seed-update",{});const before=f.state().servers.find(s=>s.version==="1.0.0");assert.ok(before);const updated=await f.fixture.service.mcpConnectorController.handle("connector.mcp.update",{id:before.id,version:"1.0.1",expectedRevision:f.fixture.service.nativeMcpStore.revision});assert.equal(updated.server.lastCheck.toolCount,2);
  await f.perform("seed-restored",{});assert.equal(f.state().servers.find(s=>s.id==="mcp-ui-restored").status,"disabled");
  const controller=f.fixture.service.mcpConnectorController,store=f.fixture.service.nativeMcpStore;
  const add=(url,name,fields)=>controller.handle("connector.mcp.add",{source:{kind:"custom"},name,option:{kind:"remote",protocol:"streamable-http",url},...(fields?{fields}:{}),expectedRevision:store.revision});
  const wrong=await add(`${f.controlUrl}/header`,"Header smoke",{headers:{Authorization:"Bearer wrong-ui-value"}});assert.equal(wrong.server.status,"failed");
  const fixed=await controller.handle("connector.mcp.credentials.update",{id:wrong.server.id,fields:{headers:{Authorization:HEADER_VALUE}},expectedRevision:store.revision});assert.equal(fixed.server.status,"ready");
  const wait=async check=>{const deadline=Date.now()+10000;while(Date.now()<deadline){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error("FIXTURE_WAIT_TIMEOUT");};
  const finish=async signin=>{const page=await(await fetch(signin.authorizationUrl)).text(),ticket=page.match(/name="ticket" value="([^"]+)"/)?.[1];assert.ok(ticket);const response=await fetch(`${f.controlUrl}/authorize/complete`,{method:"POST",headers:{Origin:f.controlUrl,"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({ticket,decision:"continue"})});return response;};
  const oauth=await add(`${f.controlUrl}/mcp`,"DCR smoke");assert.equal(oauth.server.status,"signedOut");
  await f.perform("oauth-fail-next",{});let signin=await controller.handle("connector.mcp.signin.start",{id:oauth.server.id});await finish(signin);await wait(()=>controller.oauth.get(signin.signInId).status==="failed");
  signin=await controller.handle("connector.mcp.signin.start",{id:oauth.server.id});await finish(signin);await wait(()=>store.get(oauth.server.id).status==="ready");
  await f.perform("oauth-mode",{mode:"pre-registered"});
  const pre=await add(`${f.controlUrl}/mcp`,"Pre-registered smoke",{oauthClient:{clientId:CLIENT_ID,clientSecret:CLIENT_SECRET}});assert.equal(pre.server.status,"signedOut");
  signin=await controller.handle("connector.mcp.signin.start",{id:pre.server.id});await finish(signin);await wait(()=>store.get(pre.server.id).status==="ready");
  await f.perform("oauth-mode",{mode:"dcr"});const cancelled=await add(`${f.controlUrl}/mcp`,"Cancelled smoke");signin=await controller.handle("connector.mcp.signin.start",{id:cancelled.server.id});await controller.handle("connector.mcp.signin.cancel",{signInId:signin.signInId});const late=await finish(signin);assert.ok(late.status>=400);assert.equal(controller.oauth.get(signin.signInId).status,"cancelled");assert.notEqual(store.get(cancelled.server.id).status,"ready");
  const local=await controller.handle("connector.mcp.add",{source:{kind:"custom"},name:"Command smoke",option:{kind:"stdio-command",command:f.state().command,args:[],cwd:f.fixture.paths.defaultWorkspaceDir},expectedRevision:store.revision});assert.equal(local.server.status,"ready");
  assert.equal((await fetch(`${f.controlUrl}/control/appearance`,{method:"POST",headers:{"content-type":"application/json",Origin:"https://untrusted.example"},body:'{"theme":"light","locale":"zh-CN"}'})).status,403);
  console.log("PASS UI acceptance fixture: isolated config, real compiled UI CSP, real Service update/header/OAuth-failure-retry/pre-client/cancel-late-callback/local-command, disabled restore seed, origin gate; no browser rendering claimed");
}finally{await f.close();}}
module.exports={startUiAcceptance};
if(require.main===module){if(process.argv.includes("--smoke"))smoke().catch(error=>{console.error(error);process.exitCode=1;});else startUiAcceptance().then(f=>{const info={controlUrl:f.controlUrl,productUrl:f.productUrl,root:f.root,configRoot:f.configRoot,disposable:true};const target=process.argv[2];if(target)fs.writeFileSync(target,JSON.stringify(info),{mode:0o600});console.log(JSON.stringify(info));const stop=async()=>{await f.close();process.exit(0);};process.once("SIGINT",stop);process.once("SIGTERM",stop);}).catch(error=>{console.error(error);process.exitCode=1;});}
