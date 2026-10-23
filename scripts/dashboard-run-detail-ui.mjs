// --serve leaves a loopback-only preview available for the Codex built-in browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'app/manage-ui/package.json'));
const output = path.resolve(process.env.DASHBOARD_RUN_UI_OUTPUT || path.join(root, '.artifacts/dashboard-run-detail'));
const temp = fs.mkdtempSync('/private/tmp/dashboard-run-preview-');
await require('esbuild').build({ entryPoints: [path.join(root, 'scripts/fixtures/dashboard-run-detail.tsx')],
  bundle: true, format: 'esm', jsx: 'automatic', nodePaths: [path.join(root, 'app/manage-ui/node_modules')],
  define: { 'process.env.NODE_ENV': '"production"' }, external: ['/fonts/*'],
  loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.webp': 'dataurl', '.png': 'dataurl' },
  outfile: path.join(temp, 'fixture.js'), logLevel: 'silent' });
fs.writeFileSync(path.join(temp, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dashboard 任务详情预览</title><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');
const server = http.createServer((request, response) => {
  const name = new URL(request.url, 'http://fixture').pathname;
  const paths = { '/': ['index.html', 'text/html'], '/fixture.js': ['fixture.js', 'text/javascript'], '/fixture.css': ['fixture.css', 'text/css'] };
  if (!paths[name]) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'Content-Type': paths[name][1] });
  response.end(fs.readFileSync(path.join(temp, paths[name][0])));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
if (process.argv.includes('--serve')) {
  console.log(`PREVIEW ${url}`);
  const close = () => { server.close(); fs.rmSync(temp, { recursive: true, force: true }); process.exit(0); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
} else {
  fs.mkdirSync(output, { recursive: true });
  const main = path.join(temp, 'main.cjs');
  fs.writeFileSync(main, `const {app,BrowserWindow}=require('electron'),fs=require('node:fs');
app.setPath('userData',${JSON.stringify(path.join(temp, 'profile'))});
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1200,height:1050,webPreferences:{backgroundThrottling:false}});let passed=false;
try{const results=[];for(const [language,theme,width] of [['zh-CN','light',1200],['zh-CN','dark',1200],['en','light',390]]){
w.setContentSize(width,1050);await w.loadURL(${JSON.stringify(url)}+'/?test=1&language='+language+'&theme='+theme);
results.push({...await w.webContents.executeJavaScript('window.runFixture()'),width});
fs.writeFileSync(${JSON.stringify(output)}+'/'+language+'-'+theme+'-'+width+'.png',(await w.webContents.capturePage()).toPNG());}
fs.writeFileSync(${JSON.stringify(output)}+'/results.json',JSON.stringify(results,null,2));console.log('PASS Dashboard run modal: '+results.length+' language/theme/width scenarios');passed=true;
}catch(e){console.error(e.stack||e);console.error(await w.webContents.executeJavaScript('document.body.innerText.slice(-3500)'));fs.writeFileSync(${JSON.stringify(output)}+'/failure.png',(await w.webContents.capturePage()).toPNG());}
finally{w.destroy();app.exit(passed?0:1);}});`);
  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [main], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => process.stdout.write(data)); child.stderr.on('data', data => process.stderr.write(data));
  const timer = setTimeout(() => child.kill('SIGTERM'), 70_000);
  try {
    const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(status, 0, 'Dashboard run modal regression failed');
  } finally { clearTimeout(timer); server.close(); fs.rmSync(temp, { recursive: true, force: true }); }
}
