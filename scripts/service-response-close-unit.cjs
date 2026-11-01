"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),net=require('node:net'),crypto=require('node:crypto');
const {startInspirationFixture}=require('./fixtures/inspiration-service-fixture.cjs');
const {readClientToken}=require('../app/agent-service/client');
const {PROTOCOL_VERSION}=require('../app/agent-service/server');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('single-use Service RPC closes its side after a complete reply even when the peer keeps its write half open',async()=>{
 const f=await startInspirationFixture({serviceOptions:{prewarmMcpAuth:false,autoSparkNotes:false,setCronTimer:()=>1,clearCronTimer(){},setProactiveTimer:()=>1,clearProactiveTimer(){}}});
 const clients=new Set();
 try{
  const servers=process._getActiveHandles().filter(h=>h instanceof net.Server&&h.address()===f.paths.socketPath);assert.equal(servers.length,1);
  const server=servers[0];
  for(let i=0;i<8;i++){
   const serverSocket=new Promise(resolve=>server.once('connection',resolve));
   const client=net.createConnection({path:f.paths.socketPath,allowHalfOpen:true});clients.add(client);
   const chunks=[];let ended=false;
   client.on('data',b=>chunks.push(b));client.on('end',()=>{ended=true});client.on('error',()=>{});
   await new Promise((resolve,reject)=>{client.once('connect',resolve);client.once('error',reject)});
   const accepted=await serverSocket;let closed=accepted.destroyed;accepted.once('close',()=>{closed=true});
   const id=crypto.randomUUID(),method=i%2?'service.nonexistent-fixture':'service.status';
   client.write(JSON.stringify({id,version:PROTOCOL_VERSION,token:readClientToken(f.paths),method,params:{}})+'\n');
   const deadline=Date.now()+2000;while(!closed&&Date.now()<deadline)await delay(10);
   assert.equal(closed,true,'completed single-RPC response must release the Service socket without waiting for client EOF');
   const delivery=Date.now()+1000;while(!ended&&Date.now()<delivery)await delay(5);
   assert.equal(ended,true,'the peer receives EOF after the full response');
   const bytes=Buffer.concat(chunks),nl=bytes.indexOf(10);assert.equal(nl,bytes.length-1);assert.equal(bytes.subarray(0,nl).includes(10),false);
   const response=JSON.parse(bytes.subarray(0,nl).toString());assert.equal(response.id,id);assert.equal(response.ok,i%2===0);
   if(!response.ok)assert.equal(typeof response.error.code,'string');
   assert.equal(client.writableEnded,false,'fixture does not mask the bug by ending its write half');
   client.destroy();clients.delete(client);
  }
 }finally{for(const c of clients)c.destroy();await f.close()}
});
