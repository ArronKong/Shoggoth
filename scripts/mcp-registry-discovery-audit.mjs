#!/usr/bin/env node
// Public metadata GET/HEAD only. Never registers a client or starts OAuth.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
const root=path.resolve(import.meta.dirname,".."),auditPath=path.join(root,"docs/architecture/mcp-registry-candidate-audit-2026-10-26.json");
const write=process.argv.includes("--write");
if(process.argv.slice(2).some(v=>v!=="--write"))throw Error("Only --write is supported");
const audit=JSON.parse(fs.readFileSync(auditPath,"utf8")),cache=new Map(),MAX_BYTES=256*1024;
function safeUrl(value){const u=new URL(value);if(u.protocol!=="https:"||u.username||u.password||u.hash||net.isIP(u.hostname)||u.hostname==="localhost"||/\.(?:local|internal|localhost)$/iu.test(u.hostname))throw Error("UNSAFE_METADATA_URL");return u;}
const sha=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
async function request(value,method="GET"){
 const key=`${method} ${value}`;if(cache.has(key))return cache.get(key);
 const task=(async()=>{let current=safeUrl(value);const result={url:current.href,method};
 try{for(let redirects=0;redirects<4;redirects++){
   const response=await fetch(current,{method,redirect:"manual",signal:AbortSignal.timeout(8000),headers:{Accept:"application/json","User-Agent":"Shoggoth-Registry-Metadata-Audit/1"}});
   if([301,302,303,307,308].includes(response.status)){const location=response.headers.get("location");await response.body?.cancel();if(!location||redirects===3)return{...result,status:response.status,error:"REDIRECT_LIMIT"};current=safeUrl(new URL(location,current).href);continue;}
   const challenge=response.headers.get("www-authenticate")||"",metadata=/resource_metadata\s*=\s*"([^"]+)"/iu.exec(challenge)?.[1];
   const base={...result,finalUrl:current.href,status:response.status,contentType:response.headers.get("content-type"),...(metadata?{resourceMetadataChallenge:safeUrl(metadata).href}:{})};
   if(method==="HEAD"){await response.body?.cancel();return base;}
   const reader=response.body?.getReader();let length=0,chunks=[];
   if(reader)while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>MAX_BYTES){await reader.cancel();return{...base,error:"BODY_TOO_LARGE"};}chunks.push(Buffer.from(part.value));}
   const bytes=Buffer.concat(chunks);base.bytes=bytes.length;base.sha256=sha(bytes);
   if(response.status!==200)return base;
   try{const json=JSON.parse(bytes.toString("utf8"));if(!json||Array.isArray(json)||typeof json!=="object")return{...base,error:"INVALID_JSON_SHAPE"};return{...base,json};}catch{return{...base,error:"NON_JSON"};}
 }}catch(error){return{...result,error:error.name==="TimeoutError"?"TIMEOUT":error.message==="UNSAFE_METADATA_URL"?"UNSAFE_METADATA_URL":"NETWORK_ERROR"};}
 })();cache.set(key,task);return task;
}
function metadataUrls(endpoint,kind){const u=safeUrl(endpoint),suffix=u.pathname.replace(/\/$/u,"");return[...new Set([`${u.origin}/.well-known/${kind}${suffix}`,`${u.origin}/.well-known/${kind}`])];}
function evidence(result,keys){const out={...result};delete out.json;if(result.json)out.metadata=Object.fromEntries(keys.filter(k=>Object.hasOwn(result.json,k)).map(k=>[k,result.json[k]]));return out;}
async function authorizationServer(issuer){const u=safeUrl(issuer);const candidates=[...metadataUrls(u.href,"oauth-authorization-server"),new URL(".well-known/openid-configuration",u.href.replace(/\/?$/u,"/")).href];const attempts=[];
 for(const url of[...new Set(candidates)]){const result=await request(url);attempts.push(evidence(result,["issuer","authorization_endpoint","token_endpoint","registration_endpoint","code_challenge_methods_supported","token_endpoint_auth_methods_supported"]));
  if(result.json&&typeof result.json.issuer==="string"&&typeof result.json.authorization_endpoint==="string"&&typeof result.json.token_endpoint==="string")return{requestedIssuer:u.href,issuer:result.json.issuer,metadataUrl:result.finalUrl,registrationEndpoint:typeof result.json.registration_endpoint==="string"?result.json.registration_endpoint:null,dynamicRegistrationAdvertised:typeof result.json.registration_endpoint==="string",issuerMatches:result.json.issuer.replace(/\/$/u,"")===u.href.replace(/\/$/u,""),attempts};}
 return{requestedIssuer:u.href,issuer:null,metadataUrl:null,registrationEndpoint:null,dynamicRegistrationAdvertised:null,attempts};
}
async function probe(remote,index){const endpoint=safeUrl(remote.url).href,head=await request(endpoint,"HEAD"),candidates=[...(head.resourceMetadataChallenge?[head.resourceMetadataChallenge]:[]),...metadataUrls(endpoint,"oauth-protected-resource")],attempts=[];let resource=null;
 for(const url of[...new Set(candidates)]){const result=await request(url);attempts.push(evidence(result,["resource","authorization_servers","scopes_supported","bearer_methods_supported"]));if(result.json&&typeof result.json.resource==="string"&&Array.isArray(result.json.authorization_servers)&&result.json.authorization_servers.every(s=>typeof s==="string")){resource=result;break;}}
 const issuers=resource?.json.authorization_servers?.length?resource.json.authorization_servers.slice(0,4):[safeUrl(endpoint).origin];const servers=[];
 for(const issuer of issuers){try{servers.push(await authorizationServer(issuer));}catch{servers.push({requestedIssuer:issuer,error:"UNSAFE_METADATA_URL"});}}
 const dcr=servers.some(s=>s.dynamicRegistrationAdvertised===true&&s.issuerMatches===true);
 return{optionId:`remote:${index}`,endpoint,protocol:remote.type,headerFieldNames:(remote.headers||[]).map(h=>h.name),head,protectedResource:resource?{resource:resource.json.resource,metadataUrl:resource.finalUrl,authorizationServers:resource.json.authorization_servers}:null,protectedResourceAttempts:attempts,authorizationServers:servers,classification:dcr?"dynamic-registration-advertised-no-client-created":servers.some(s=>s.issuer)?"authorization-metadata-found-no-dcr-advertised":"oauth-support-unknown-metadata-not-found",readOnly:true,clientRegistrationAttempted:false,providerAccountUsed:false};
}
const fixtures=new Map(fs.readdirSync(path.join(root,"scripts/fixtures/mcp-registry")).filter(f=>f.endsWith(".json")).map(f=>{const v=JSON.parse(fs.readFileSync(path.join(root,"scripts/fixtures/mcp-registry",f)));return[v.server.name,v];}));
const jobs=[];for(const entry of audit.entries){const envelope=fixtures.get(entry.registryName);entry.oauthMetadata=[];for(const[remoteIndex,remote]of(envelope?.server.remotes||[]).slice(0,16).entries()){if(/[{}]/u.test(remote.url))continue;jobs.push(async()=>{const result=await probe(remote,remoteIndex);entry.oauthMetadata.push(result);process.stdout.write(`${entry.registryName} ${result.optionId}: ${result.classification}\n`);});}}
let cursor=0;await Promise.all(Array.from({length:6},async()=>{while(cursor<jobs.length){const job=jobs[cursor++];await job();}}));
for(const entry of audit.entries){entry.oauthMetadata.sort((a,b)=>Number(a.optionId.split(":")[1])-Number(b.optionId.split(":")[1]));entry.oauthVerification=entry.oauthMetadata.length?entry.oauthMetadata.some(v=>v.classification==="dynamic-registration-advertised-no-client-created")?"metadata-dcr-advertised-no-account-or-registration":"metadata-probed-no-account-or-registration":"not-in-recorded-registry-no-metadata-probe";}
audit.metadataCheckedAt=new Date().toISOString();audit.metadataProbePolicy={requests:"Unauthenticated public HTTPS GET/HEAD only",clientRegistrationAttempted:false,providerAccountUsed:false,notProofOf:"Client registration acceptance, OAuth consent, account eligibility, pricing, or a working authenticated MCP session",options:"Same first 16 remote options accepted by Registry parser"};
if(write)fs.writeFileSync(auditPath,JSON.stringify(audit,null,2)+"\n");
process.stdout.write(JSON.stringify({entries:audit.entries.length,options:jobs.length,requests:cache.size,written:write})+"\n");
