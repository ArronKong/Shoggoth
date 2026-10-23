#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
if (!process.versions.electron) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-ui-policy-"));
  try {
    const root = path.resolve(__dirname, ".."), src = path.join(root, "app/manage-ui/src/lib");
    const { buildSync } = require(require.resolve("esbuild", { paths: [path.join(root, "app/manage-ui")] }));
    buildSync({ stdin: { contents: `import {toSanitizedMarkdownHtml} from ${JSON.stringify(path.join(src, "markdown.ts"))};
      import {installHtmlArtifacts,setHtmlArtifactScope,setSendPromptHandler} from ${JSON.stringify(path.join(src, "htmlArtifacts.ts"))};
      window.policy={render:toSanitizedMarkdownHtml,install:installHtmlArtifacts,scope:setHtmlArtifactScope,handler:setSendPromptHandler};`,
      resolveDir: root }, bundle: true, platform: "browser", format: "iife", loader: { ".css": "empty" }, outfile: path.join(dir, "policy.js") });
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const result = require("node:child_process").spawnSync(process.env.NATIVE_CHAT_UI_ELECTRON || require("electron"), [__filename, "--fixture", dir], { env, stdio: "inherit", timeout: 30000 });
    assert.equal(result.status, 0, String(result.error || result.signal || "source policy failed"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
} else {
  const { app, BrowserWindow } = require("electron"), http = require("node:http");
  const dir = process.argv[process.argv.indexOf("--fixture") + 1];
  app.setPath("userData", path.join(dir, "data"));
  app.whenReady().then(async () => {
    let win, server;
    try {
      server = http.createServer((req, res) => {
        if (req.url === "/policy.js") { res.setHeader("Content-Type", "application/javascript"); res.end(fs.readFileSync(path.join(dir, "policy.js"))); }
        else { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end('<!doctype html><div id="ordinary"></div><div id="immersive"></div><script src="/policy.js"></script>'); }
      });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      await win.loadURL(`http://127.0.0.1:${server.address().port}`);
      const result = await win.webContents.executeJavaScript(`(async()=>{
        const check=(ok,name)=>{if(!ok)throw Error(name);passed.push(name)},passed=[];
        const html='\x60\x60\x60html\\n<!doctype html><script>window.sendPrompt("old-frame")<\\/script><h1>卡片</h1>\\n\x60\x60\x60';
        const source=()=>policy.render(html),legacy=()=>policy.render(html,false,undefined,{mode:'legacy-preview',scope:'external-a'});
        check(!source().includes('chat-html-artifact'),'user-and-native-source');
        check(legacy().includes('data-html-scope="external-a"'),'external-assistant-explicit-policy');
        check(!source().includes('chat-html-artifact'),'cache-never-promotes-native');
        check(!policy.render('> '+html.replaceAll('\\n','\\n> ')).includes('chat-html-artifact'),'quoted-source');
        check(!policy.render('\x60\x60\x60html\\n<button>示例</button>\\n\x60\x60\x60',false,undefined,{mode:'legacy-preview',scope:'external-a'}).includes('chat-html-artifact'),'teaching-snippet');
        window.receipts=[];policy.handler((text,scope)=>receipts.push({text,scope}));policy.scope('external-a');policy.install();
        ordinary.innerHTML=legacy();await new Promise(r=>setTimeout(r,650));
        let old=document.querySelector('iframe.chat-html-frame');check(!!old,'external-preview-mounts');
        const oldWindow=old.contentWindow;check(receipts.length===1&&receipts[0].scope==='external-a','legacy-has-owning-session');
        policy.handler(null);policy.scope(null);ordinary.innerHTML=source();immersive.innerHTML=source();
        dispatchEvent(new MessageEvent('message',{data:{__chatHtmlArtifact:'sendPrompt',text:'late'},source:oldWindow}));
        await new Promise(r=>setTimeout(r,450));check(receipts.length===1,'late-old-frame-cannot-send');
        check(!document.querySelector('iframe.chat-html-frame'),'ordinary-and-immersive-native-no-global-host');
        return passed;})()`);
      assert.equal(result.length, 9); console.log("PASS native UI source policy", JSON.stringify(result));
    } finally { win?.destroy(); if(server?.listening) await new Promise(resolve=>server.close(resolve)); }
  }).then(()=>app.quit()).catch(error=>{console.error(error);app.exit(1);});
}
