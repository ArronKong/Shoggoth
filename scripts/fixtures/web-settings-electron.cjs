"use strict";
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const [html, output] = process.argv.slice(2);
app.setPath("userData", path.join(path.dirname(html), "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1240, height: 1120, webPreferences: { backgroundThrottling: false } });
  const run = js => win.webContents.executeJavaScript(js);
  const wait = async js => { for (let i=0; i<200; i++) { if (await run(js)) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw Error("Timed out: " + js); };
  const shot = async name => { await run("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))"); fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG()); };
  const choose = async (index, text) => {
    await run(`document.querySelectorAll('[role=combobox]')[${index}].click()`);
    await wait(`(()=>{const trigger=document.querySelectorAll('[role=combobox]')[${index}];return trigger.getAttribute('aria-expanded')==='true'&&!!document.getElementById(trigger.getAttribute('aria-controls'))?.querySelector('[role=option]')})()`);
    await run(`(()=>{const trigger=document.querySelectorAll('[role=combobox]')[${index}], popup=document.getElementById(trigger.getAttribute('aria-controls'));const item=[...popup.querySelectorAll('[role=option]')].find(x=>x.textContent===${JSON.stringify(text)});if(!item)throw Error('Missing option');item.click()})()`);
    await wait(`(()=>{const trigger=document.querySelectorAll('[role=combobox]')[${index}];return trigger.getAttribute('aria-expanded')!=='true'&&trigger.textContent.includes(${JSON.stringify(text)})})()`);
    await wait("[...document.querySelectorAll('[role=listbox]')].every(e=>e.getClientRects().length===0||getComputedStyle(e).visibility==='hidden')");
  };
  let ok = false;
  try {
    await win.loadFile(html); await wait("document.querySelector('[data-web-provider=tinyfish] input')?.disabled===false");
    assert.equal(await run("window.webSettingsFixture.calls.some(c=>c.method!=='GET')"), false);
    assert.equal(await run("document.querySelectorAll('input[type=password]').length"), 4);
    await run(`(()=>{const input=document.querySelector('[data-web-provider=tinyfish] input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'fixture-tinyfish-key');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await run("document.querySelector('[data-web-provider=tinyfish]').requestSubmit()");
    await wait("window.webSettingsFixture.calls.some(c=>c.method==='PUT'&&c.url.endsWith('credentials')) && document.querySelector('[data-web-provider=tinyfish] input').value===''");
    assert.equal(await run("document.body.textContent.includes('fixture-tinyfish-key')"), false);
    assert.equal(await run("document.querySelector('[data-web-provider=tinyfish]').textContent.includes('已加密保存')"), true);
    await choose(0, "TinyFish"); await choose(1, "Tavily");
    await run("document.querySelector('form').requestSubmit()");
    await wait("window.webSettingsFixture.calls.some(c=>c.url.endsWith('web-settings')&&c.method==='PUT')");
    const saved = await run("window.webSettingsFixture.calls.find(c=>c.url.endsWith('web-settings')&&c.method==='PUT').body");
    assert.deepEqual(saved, { expectedRevision: 0, config: { searchProvider: "tinyfish", fetchProvider: "tavily" } });
    await wait("document.querySelector('#settings-web').getAttribute('aria-busy')==='false'");
    await shot("web-settings-zh-wide.png");
    await choose(0, "Brave"); await run("window.webSettingsFixture.failNext=true;document.querySelector('form').requestSubmit()");
    await wait("!!document.querySelector('[role=alert]')"); assert.equal(await run("document.body.textContent.includes('private transport detail')"), false);
    win.setContentSize(700, 1000); await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(await run("document.documentElement.scrollWidth<=window.innerWidth+1"), true); await shot("web-settings-zh-narrow.png");
    await run("window.webSettingsFixture.i18n.changeLanguage('en');document.documentElement.dataset.theme='dark';document.documentElement.style.colorScheme='dark'");
    await wait("document.body.textContent.includes('Web search and page reading')");
    await run("(()=>{const button=[...document.querySelectorAll('button')].find(x=>x.textContent==='Discard drafts and reload');button.click()})()");
    await wait("!document.querySelector('[role=alert]') && document.querySelector('[data-web-provider=tinyfish] input').disabled===false");
    await run("window.scrollTo(0,0)"); await shot("web-settings-en-dark.png");
    await run("[...document.querySelector('[data-web-provider=tinyfish]').querySelectorAll('button')].find(x=>x.textContent==='Delete key').click()");
    await wait("window.webSettingsFixture.calls.some(c=>c.method==='DELETE')");
    assert.equal(await run("document.querySelector('[data-web-provider=tinyfish]').textContent.includes('Not configured')"), true);
    win.setContentSize(400, 850); await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(await run("document.documentElement.scrollWidth<=window.innerWidth+1"), true);
    assert.equal(await run("window.fixtureError||null"), null);
    console.log(JSON.stringify({ verified: true, providerChoices: true, explicitKeySave: true, keyMasked: true, deleteKey: true, conflict: true, narrow: [700,400], locales: ["zh-CN","en"], realProviderCalls: 0 }));
    ok = true;
  } catch (error) { console.error(error.stack); console.error(await run("JSON.stringify({text:document.body.textContent,error:window.fixtureError,popups:[...document.querySelectorAll('[role=listbox]')].map(e=>({html:e.parentElement.parentElement.outerHTML.slice(0,1800),visible:e.checkVisibility(),animation:getComputedStyle(e.parentElement).animation,animations:e.getAnimations().map(a=>({state:a.playState,time:a.currentTime,pending:a.pending}))}))})").catch(()=>"renderer unavailable")); }
  finally { win.destroy(); app.exit(ok ? 0 : 1); }
});
