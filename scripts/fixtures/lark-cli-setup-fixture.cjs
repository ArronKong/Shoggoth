"use strict";
const fs = require("node:fs"), path = require("node:path");
const { prepareFixture } = require("./lark-cli-fixture.cjs");
const { sha256 } = require("../../app/agent-service/lark-cli-installer");

// A real subprocess protocol fixture. Every file belongs to the test HOME;
// confirmation gates never contact Feishu or the user's account/keychain.
async function prepareSetupFixture(input, { autoApproveAfterMs = 0, qrBinary = null } = {}) {
  if (path.resolve(input.homeDir) !== path.resolve(input.root, "../../../..")) throw new Error("Setup fixture requires an isolated test HOME");
  const prepared = await prepareFixture(input);
  const executable = path.join(input.root, "bin/lark-cli");
  const program = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const args=process.argv.slice(2),home=process.env.HOME,configPath=path.join(home,'.lark-cli/config.json');
const arg=key=>args[args.indexOf(key)+1];
const output=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const load=()=>{try{return JSON.parse(fs.readFileSync(configPath))}catch{return null}};
const save=value=>{fs.mkdirSync(path.dirname(configPath),{recursive:true,mode:0o700});fs.writeFileSync(configPath,JSON.stringify(value),{mode:0o600})};
const gate=(name,done)=>{
 if(${autoApproveAfterMs}>0)setTimeout(done,${autoApproveAfterMs});
 else{const timer=setInterval(()=>{if(fs.existsSync(path.join(home,name))){clearInterval(timer);done()}},10)}
};
fs.appendFileSync(path.join(home,'.fixture-calls.jsonl'),JSON.stringify(args)+'\\n');
if(args[0]==='--version'){console.log('lark-cli version 1.0.98')}
else if(args[0]==='auth'&&args[1]==='status'){
 const config=load();
 if(!config){process.stderr.write(JSON.stringify({ok:false,error:{type:'config',subtype:'not_configured',message:'private-status-canary'}}));process.exitCode=3}
 else output({appId:config.appId,brand:config.brand,identities:{user:{available:!!config.authorized,userName:config.authorized?'Test User':undefined,verified:args.includes('--verify')?!!config.authorized:undefined}}});
}
else if(args[0]==='config'&&args[1]==='init'){
 const done=secret=>{save({appId:args.includes('--app-id')?arg('--app-id'):'cli_created_fixture',brand:arg('--brand'),authorized:false,stdinHash:secret?crypto.createHash('sha256').update(secret.trim()).digest('hex'):null});output({appId:load().appId,appSecret:'****'})};
 if(args.includes('--new')){process.stderr.write('Open this page:\\n  https://open.feishu.cn/page/cli?user_code=CREATE-TEST\\n');gate('.fixture-config-approved',()=>done(''))}
 else{let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>done(input))}
}
else if(args[0]==='auth'&&args[1]==='login'){
 const expired=fs.existsSync(path.join(home,'.fixture-expired'));
 output({event:'device_authorization',verification_uri_complete:fs.existsSync(path.join(home,'.fixture-unsafe-url'))?'https://untrusted.example/steal':'https://accounts.feishu.cn/oauth/authorize?user_code=LOGIN-TEST',user_code:'LOGIN-TEST',expires_in:expired?1:600});
 if(expired)setTimeout(()=>{process.stderr.write('private-expiry-canary');process.exit(4)},1100);
 else if(fs.existsSync(path.join(home,'.fixture-denied'))){process.stderr.write('private-auth-canary');process.exitCode=4}
 else gate('.fixture-auth-approved',()=>{const config=load();config.authorized=true;save(config);output({event:'authorization_complete',user_name:'Test User',user_open_id:'test-user',missing:[],granted:['test:read']})});
}
else if(args[0]==='auth'&&args[1]==='qrcode'){
 const real=${JSON.stringify(qrBinary)};
 if(real){const result=require('node:child_process').spawnSync(real,args,{env:process.env,cwd:process.cwd()});if(result.status!==0)process.exit(result.status||1)}
 else fs.writeFileSync(arg('--output'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9sAAAAASUVORK5CYII=','base64'));
 output({ok:true});
}
else process.exitCode=2;
`;
  fs.writeFileSync(executable, program, { mode: 0o700 });
  return { ...prepared, cliSha256: sha256(fs.readFileSync(executable)) };
}
module.exports = { prepareSetupFixture };
