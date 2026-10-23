#!/usr/bin/env node
// Actual inspector component + actual dev save route; temporary source/profile only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "../app/manage-ui/node_modules/vite/dist/node/index.js";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "app/manage-ui/package.json"));
const { build } = require("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-inspector-ui-"));
const output = process.env.INSPECTOR_UI_OUTPUT ? path.resolve(process.env.INSPECTOR_UI_OUTPUT) : null;
const file = path.join(temp, "src/debug-overrides.css");
fs.mkdirSync(path.dirname(file));
fs.writeFileSync(file, "/* Fixture source staging file */\n");
const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import DebugInspector from "./app/manage-ui/src/components/debug/DebugInspector";
import i18n from "./app/manage-ui/src/i18n";
import "./app/manage-ui/src/styles.css";
import styles from "./app/manage-ui/src/components/debug/DebugInspector.module.css";
const state = window as any;
const language = new URLSearchParams(location.search).get("language") || "zh-CN";
const targetClass = 'fixture-inspector-surface-' + language + '-' + innerWidth;
void i18n.changeLanguage(language);
document.documentElement.setAttribute("data-theme", language === "en" ? "dark" : "light");
const pause = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (check: () => unknown, label: string) => {
  const until = Date.now() + 5000;
  while (!check()) { if (Date.now() > until) throw Error(label); await pause(); }
};
const must = (condition: unknown, label: string) => { if (!condition) throw Error(label); };
const panel = () => document.querySelector('[data-debug-ui="panel"]')!;
const button = (key: string) => [...panel().querySelectorAll("button")].find(b => b.textContent === i18n.t(key)) as HTMLButtonElement;
const clear = () => (button("debug.clear") || button("debug.btnCleared")).click();
const rows = () => [...panel().querySelectorAll('.' + styles.histRow)] as HTMLElement[];
const target = () => document.querySelector('[data-inspector-fixture]') as HTMLElement;
createRoot(document.getElementById("root")!).render(<><main className="fixture-shell"><h1>Style inspector regression</h1><p data-inspector-fixture className={targetClass}>Temporary source save and readable history.</p></main><DebugInspector /></>);
state.runInspectorFixture = async () => {
  await wait(() => panel(), "inspector did not mount");
  target().dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
  await wait(() => button("debug.saveToCode"), "save to source button did not appear");
  const actions = [...panel().querySelector('.' + styles.toolbar)!.querySelectorAll('button')];
  must(actions[0] === button("debug.saveToCode") && actions[1] === button("debug.export")
    && actions[2] === button("debug.clear"), "source save must precede copy and clear");
  must(actions[0].classList.contains(styles.toolBtnPrimary) && !actions[1].classList.contains(styles.toolBtnPrimary),
    "source save must have the primary button style");
  const set = async (prop: string, value: string) => {
    const label = [...panel().querySelectorAll('[title]')].find(el => el.getAttribute("title") === prop);
    const input = label?.parentElement?.querySelector('input');
    must(input, "missing editor: " + prop);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    await pause();
  };
  const edits = [["font-size", "17px"], ["font-weight", "400"], ["line-height", "45px"],
    ["letter-spacing", "1px"], ["text-align", "left"], ["color", "rgba(0, 0, 0, 0.9)"],
    ["background-color", "#fafafa"], ["border-radius", "4px"], ["box-shadow", "0 2px 12px 0 rgba(1, 2, 3, 0.45)"]];
  for (const [prop, value] of edits) await set(prop, value);
  must(rows().length === 9, "nine independent edits must be retained: " + rows().length + " " + document.querySelector('style[data-debug-ui=overrides]')?.textContent);
  const assertLayout = () => {
    const list = panel().querySelector('.' + styles.histList) as HTMLElement;
    must(list.scrollHeight > list.clientHeight, "history must scroll instead of squeezing its rows");
    let previousBottom = -Infinity;
    for (const row of rows()) {
      const bounds = row.getBoundingClientRect();
      must(bounds.height >= parseFloat(getComputedStyle(row).lineHeight), "history text clipped by a shrunken row: " + bounds.height);
      must(bounds.top >= previousBottom, "history rows overlap"); previousBottom = bounds.bottom;
      let previousRight = bounds.left;
      for (const cell of row.children) {
        const box = cell.getBoundingClientRect();
        must(box.left >= previousRight - 1 && box.right <= bounds.right + 1, "history columns overlap or escape");
        previousRight = box.right;
      }
    }
    list.scrollTop = list.scrollHeight;
    const last = rows().at(-1)!.getBoundingClientRect();
    must(last.bottom <= list.getBoundingClientRect().bottom + 1, "oldest record cannot be reached");
    list.scrollTop = 0;
    const footer = panel().querySelector('.' + styles.footer)!.getBoundingClientRect();
    must(footer.bottom <= innerHeight && footer.left >= 0, "footer actions are outside viewport");
    return { rowHeight: rows()[0].getBoundingClientRect().height, listHeight: list.clientHeight, scrollHeight: list.scrollHeight };
  };
  const layout = assertLayout();
  must(getComputedStyle(target()).fontSize === "17px", "live edit did not apply");
  button("debug.saveToCode").click();
  await wait(() => button("debug.btnSaved"), "source save did not report success");
  // Clearing the temporary preview must expose the same values from saved CSS.
  clear();
  await wait(() => rows().length === 0, "clear did not clear local history");
  await wait(() => getComputedStyle(target()).fontSize === "17px", "saved CSS did not survive clearing preview");
  const moreEdits = [["font-size", "18px"], ["font-weight", "500"], ["line-height", "46px"],
    ["letter-spacing", "2px"], ["text-align", "right"], ["color", "rgba(0, 0, 0, 0.8)"],
    ["background-color", "#f8f8f8"], ["border-radius", "6px"], ["box-shadow", "0 3px 14px 0 rgba(1, 2, 3, 0.55)"]];
  for (const [prop, value] of moreEdits) await set(prop, value);
  for (let i = 0; i < 31; i++) await set(i % 2 ? "font-size" : "line-height", ((i % 2 ? 19 : 47) + i) + "px");
  must(rows().length === 40, "long history must retain all edits");
  assertLayout();
  button("debug.undo").click();
  await pause();
  must(rows().length === 39, "undo must remove exactly one edit");
  // Leave the requested nine-record case visible in the verification screenshot.
  clear(); await pause();
  for (const [prop, value] of moreEdits) await set(prop, value);
  return { language, width: innerWidth, records: rows().length, layout, saved: true, passed: true };
};
`;
let vite;
try {
  await build({ stdin: { contents: fixture, loader: "tsx", resolveDir: root }, bundle: true, format: "esm", jsx: "automatic",
    nodePaths: [path.join(root, "app/manage-ui/node_modules")], define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl" }, outfile: path.join(temp, "fixture.js"), logLevel: "silent" });
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><link rel="stylesheet" href="src/debug-overrides.css"><style>body{margin:0}.fixture-shell{padding:32px}.fixture-shell p{font-size:14px;font-weight:300;line-height:20px;color:#123}</style><div id="root"></div><script type="module" src="fixture.js"></script>');
  vite = await createServer({ configFile: path.join(root, "app/manage-ui/vite.config.ts"), root: temp,
    cacheDir: path.join(temp, ".vite"), logLevel: "silent", server: { host: "127.0.0.1", port: 0, strictPort: true } });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  if (output) fs.mkdirSync(output, { recursive: true });
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, `const {app,BrowserWindow}=require("electron"),fs=require("node:fs");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1200,height:850,webPreferences:{backgroundThrottling:false}});let passed=false;
try{const results=[];for(const width of [1200,360]){for(const language of ["zh-CN","en"]){
w.setContentSize(width,width===360?640:850);
await w.loadURL(${JSON.stringify(origin)}+"/?language="+language);
const result=await w.webContents.executeJavaScript("window.runInspectorFixture()");results.push(result);console.log(JSON.stringify(result));
if(!fs.readFileSync(${JSON.stringify(file)},"utf8").includes("font-size: 17px !important;"))throw Error("source file lacks the actual saved adjustment");
if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+"/inspector-"+language+"-"+width+".png",(await w.webContents.capturePage()).toPNG());
await w.reload();await new Promise(resolve=>setTimeout(resolve,300));
const persisted=await w.webContents.executeJavaScript("getComputedStyle(document.querySelector('[data-inspector-fixture]')).fontSize");
if(persisted!=="17px")throw Error("source style did not survive full reload");
}}if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+"/results.json",JSON.stringify(results,null,2));passed=true;
}catch(error){console.error(error.stack||error);}finally{w.destroy();app.exit(passed?0:1);}});`);
  const child = spawn(require("electron"), [main], { env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => process.stdout.write(chunk)); child.stderr.on("data", chunk => process.stderr.write(chunk));
  const timeout = setTimeout(() => child.kill("SIGTERM"), 60000);
  let status;
  try { status = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }); }
  finally { clearTimeout(timeout); }
  assert.equal(status, 0, "debug inspector UI regression failed");
} finally {
  if (vite) await vite.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
