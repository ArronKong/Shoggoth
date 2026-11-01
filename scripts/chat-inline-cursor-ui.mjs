import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, ".."), ui = path.join(root, "app/manage-ui");
const requireUi = createRequire(path.join(ui, "package.json"));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-inline-cursor-"));
const output = process.argv.find(value => value.startsWith("--output="))?.slice(9);
const screenshot = process.argv.find(value => value.startsWith("--screenshot="))?.slice(13);
try {
  await requireUi("esbuild").build({
    stdin: { resolveDir: root, sourcefile: "inline-cursor-fixture.tsx", loader: "tsx", contents: `
      import React from "react";
      import {createRoot} from "react-dom/client";
      import {flushSync} from "react-dom";
      import ChatMarkdown from "./app/manage-ui/src/components/ChatMarkdown";
      import "./app/manage-ui/src/i18n";
      import "./app/manage-ui/src/styles.css";
      import "./app/manage-ui/src/manage-skin.css";
      import "./app/manage-ui/src/pages/ChatPage.css";
      document.documentElement.dataset.theme="light";
      const host=document.getElementById("root")!,root=createRoot(host);
      window.renderCursor=(text:string,width=360,cursor=true)=>{
        host.style.width=width+"px";
        flushSync(()=>root.render(<div className="chat-group is-assistant"><div className="chat-group__stack">
          <div className="chat-bubble is-streaming"><ChatMarkdown text={text} className="chat-md" streamingCursor={cursor}/></div>
        </div></div>));
      };
      const check=(value:unknown,label:string)=>{if(!value)throw Error(label);};
      const measure=()=>{
        const cursor=document.querySelector<HTMLElement>(".chat-cursor"),tail=cursor?.parentElement;
        check(cursor&&tail?.classList.contains("chat-cursor-tail"),"cursor must be anchored inside Markdown's last text");
        check(document.querySelectorAll(".chat-cursor").length===1,"one streaming cursor");
        const range=document.createRange();range.selectNodeContents(tail!.firstChild!);
        const text=range.getBoundingClientRect(),dot=cursor!.getBoundingClientRect();
        const offset=dot.y+dot.height/2-text.y-text.height/2;
        check(dot.width===7&&dot.height===7,"keep the 7px dot");
        check(Math.abs(offset)<=0.5,"cursor vertically centered on last character: "+offset);
        check(Math.abs(dot.left-text.right-7)<=0.5,"cursor follows final character with 7px gap");
        check(dot.top>=text.top&&dot.bottom<=text.bottom,"dot must wrap with the final character");
        check(cursor!.getAttribute("aria-hidden")==="true"&&!cursor!.textContent,"decoration must not enter copied text or accessible content");
        const bubble=cursor!.closest(".chat-bubble")!.getBoundingClientRect();
        check(dot.right<=bubble.right-23,"cursor stays inside bubble padding");
        return {x:dot.x,y:dot.y,offset,width:dot.width,tail:tail!.textContent};
      };
      window.runCursorFixture=async()=>{
        await document.fonts.ready;
        const rows=[];let previous,wrapped=false,advanced=false;
        const prose="正在查看应用内关于网易云音乐连接器的帮助文档，并核对相关配置。";
        for(let n=1;n<=prose.length;n++){
          window.renderCursor(prose.slice(0,n),240);
          const current=measure();
          if(previous){if(current.y>previous.y+10){wrapped=true;check(current.x<previous.x,"cursor returns left when text wraps");}
            else if(current.x>previous.x+1)advanced=true;}
          previous=current;
        }
        check(wrapped&&advanced,"streaming must move right and then wrap left with text");
        rows.push({case:"incremental text and wrapping",steps:prose.length,wrapped,advanced});
        for(const [name,text,last] of [
          ["bold","正在查看 **帮助文档**","档"],
          ["link","查看 [连接器说明](https://example.com/docs)","明"],
          ["list","- 检查配置\\n- 正在核对连接器文档","档"],
          ["quote","> 正在核对连接器文档","档"],
          ["heading","## 正在核对连接器文档","档"],
          ["hard break","检查配置  \\n正在核对文档","档"],
          ["inline code","正在检查 \\u0060README.md\\u0060","d"],
          ["code block","\\u0060\\u0060\\u0060js\\nconst ready = true;\\n\\u0060\\u0060\\u0060",";"],
          ["combining mark","状态 café","é"],
          ["emoji","状态 👩🏽‍💻","👩🏽‍💻"],
        ]){
          window.renderCursor(text,300,false);
          const baseline=document.querySelector(".chat-md")!.innerHTML;
          const plain=document.querySelector(".chat-md")!.textContent;
          window.renderCursor(text,300,true);
          const measured=measure();check(measured.tail===last,name+": keep final grapheme intact");
          check(document.querySelector(".chat-md")!.textContent===plain,name+": keep text content intact");
          window.renderCursor(text,300,false);
          check(!document.querySelector(".chat-cursor"),name+": settled text removes cursor");
          check(document.querySelector(".chat-md")!.innerHTML===baseline,name+": restore original Markdown structure");
          rows.push({case:name,...measured});
        }
        window.renderCursor("\\u0060\\u0060\\u0060json\\n{\\\"ready\\\":true}\\n\\u0060\\u0060\\u0060",300);
        check(!!document.querySelector("summary .chat-cursor"),"collapsed JSON cursor must stay in visible summary");
        measure();rows.push({case:"collapsed JSON"});
        document.documentElement.dataset.theme="dark";
        window.renderCursor("深色模式的末尾字符。",190);measure();rows.push({case:"dark and narrow"});
        document.documentElement.dataset.theme="light";
        return {outcome:"PASS",rows};
      };
    ` },
    bundle: true, format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff2": "dataurl", ".woff": "dataurl", ".png": "dataurl", ".webp": "dataurl", ".svg": "dataurl" },
    nodePaths: [path.join(ui, "node_modules")], outfile: path.join(temp, "fixture.js"), logLevel: "silent",
  });
  const page = path.join(temp, "index.html"), main = path.join(temp, "main.cjs");
  fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>body{margin:24px}#root{width:360px}</style><div id="root"></div><script type="module" src="fixture.js"></script>');
  fs.writeFileSync(main, `const {app,BrowserWindow}=require("electron"),fs=require("node:fs");
    app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
    app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:900,height:500,webPreferences:{backgroundThrottling:false}});
      try{await w.loadFile(${JSON.stringify(page)});const result=await w.webContents.executeJavaScript("window.runCursorFixture()",true);
        console.log(JSON.stringify(result));${output ? `fs.writeFileSync(${JSON.stringify(output)},JSON.stringify(result,null,2));` : ""}
        ${screenshot ? `await w.webContents.executeJavaScript('window.renderCursor("正在查看应用内关于网易云音乐连接器的帮助文档，并核对相关配置。",350);document.querySelector(".chat-cursor").getAnimations().forEach(a=>{a.pause();a.currentTime=750;})',true);
          const rect=await w.webContents.executeJavaScript('(()=>{const r=document.querySelector(".chat-bubble").getBoundingClientRect();return {x:Math.floor(r.x-12),y:Math.floor(r.y-12),width:Math.ceil(r.width+24),height:Math.ceil(r.height+24)}})()',true);
          fs.writeFileSync(${JSON.stringify(screenshot)},(await w.webContents.capturePage(rect)).toPNG());` : ""}
        w.destroy();app.quit();
      }catch(error){console.error(error);w.destroy();app.exit(1);}
    }).catch(error=>{console.error(error);app.exit(1)});`);
  const child = spawn(createRequire(path.join(root, "package.json"))("electron"), [main], {
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  child.stdout.on("data", data => process.stdout.write(data));
  child.stderr.on("data", data => process.stderr.write(data));
  const timeout = setTimeout(() => child.kill("SIGTERM"), 60000);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  clearTimeout(timeout);
  assert.equal(code, 0, "inline cursor fixture failed");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
