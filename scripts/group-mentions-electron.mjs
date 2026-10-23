#!/usr/bin/env node
// Production React/CSS, synthetic group records, isolated Electron profile and loopback-only assets.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'app/manage-ui/package.json'));
const output = path.resolve(process.env.GROUP_ASSIGNMENT_UI_OUTPUT || path.join(root, '.artifacts/group-mentions-ui'));
const temp = fs.realpathSync(fs.mkdtempSync('/private/tmp/shoggoth-group-mentions-ui-'));
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture');
  const asset = url.pathname.startsWith('/avatar/') ? path.join(root, 'app/manage-ui/public/logo.png')
    : ({ '/': path.join(temp, 'index.html'), '/fixture.js': path.join(temp, 'fixture.js'), '/fixture.css': path.join(temp, 'fixture.css') })[url.pathname];
  if (!asset) { response.writeHead(404); response.end(); return; }
  response.setHeader('content-type', asset.endsWith('.png') ? 'image/png' : asset.endsWith('.css') ? 'text/css' : asset.endsWith('.js') ? 'text/javascript' : 'text/html');
  response.end(fs.readFileSync(asset));
});
try {
  fs.mkdirSync(output, { recursive: true });
  await require('esbuild').build({ entryPoints: [path.join(root, 'scripts/fixtures/group-mentions.tsx')], bundle: true,
    format: 'esm', jsx: 'automatic', nodePaths: [path.join(root, 'app/manage-ui/node_modules')],
    loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.webp': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' },
    outfile: path.join(temp, 'fixture.js'), logLevel: 'silent' });
  fs.writeFileSync(path.join(temp, 'index.html'), '<link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;height:100%;min-height:0}#root{display:flex;flex-direction:column}</style><div id="root" class="chat-shell"></div><script type="module" src="fixture.js"></script>');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const main = `const {app,BrowserWindow,session}=require('electron'),fs=require('node:fs');
    app.setPath('userData',${JSON.stringify(path.join(temp, 'profile'))});app.setPath('sessionData',${JSON.stringify(path.join(temp, 'session'))});
    app.on('window-all-closed',()=>{});
    app.whenReady().then(async()=>{
      const forbidden=[],cases=[];
      session.defaultSession.webRequest.onBeforeRequest((details,callback)=>{
        const url=new URL(details.url);
        if(['http:','https:','ws:','wss:'].includes(url.protocol)&&url.origin!==${JSON.stringify(origin)}){
          forbidden.push(url.origin);callback({cancel:true});return;
        }
        callback({cancel:false});
      });
      const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
      window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      let passed=false;
      try {
        for(const width of[1200,390])for(const language of['zh-CN','en'])for(const theme of['light','dark']){
          window.setSize(width,950);
          await window.loadURL(${JSON.stringify(origin)}+'/?language='+language+'&theme='+theme);
          await window.webContents.executeJavaScript('new Promise((resolve,reject)=>{const end=Date.now()+6000;const timer=setInterval(()=>{if(window.fixtureReady){clearInterval(timer);resolve(true)}else if(Date.now()>end){clearInterval(timer);reject(Error("fixture startup"))}},20)})');
          const result={width,language,theme};
          for(const stage of['verifyTimeline','showMember','showStatus']){
            Object.assign(result,await window.webContents.executeJavaScript('window.'+stage+'()'));
            fs.writeFileSync(${JSON.stringify(output)}+'/'+stage+'-'+width+'-'+language+'-'+theme+'.png',(await window.webContents.capturePage()).toPNG());
          }
          Object.assign(result,await window.webContents.executeJavaScript('window.finish()'));
          cases.push(result);console.log(JSON.stringify(result));
        }
        if(forbidden.length)throw Error('Unexpected outside request: '+forbidden.join(','));
        fs.writeFileSync(${JSON.stringify(path.join(output, 'results.json'))},JSON.stringify({cases,forbidden,passed:true},null,2));passed=true;
      }catch(error){console.error(error.stack||error);fs.writeFileSync(${JSON.stringify(path.join(output, 'failed.png'))},(await window.webContents.capturePage()).toPNG());}
      finally{window.destroy();app.exit(passed?0:1)}
    });`;
  fs.writeFileSync(path.join(temp, 'main.cjs'), main);
  const child = spawn(require('electron'), [path.join(temp, 'main.cjs')], {
    env: { PATH: process.env.PATH, HOME: path.join(temp, 'home'), TMPDIR: temp, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => process.stdout.write(chunk)); child.stderr.on('data', chunk => process.stderr.write(chunk));
  const timer = setTimeout(() => child.kill('SIGTERM'), 90000);
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  clearTimeout(timer); assert.deepEqual(result, { code: 0, signal: null });
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'results.json'), 'utf8')).cases.length, 8);
  console.log('PASS member mentions: 8 rendered combinations; ' + output);
} finally {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}
