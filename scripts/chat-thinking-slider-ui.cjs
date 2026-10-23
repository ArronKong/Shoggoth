#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const root = path.resolve(__dirname, "..");
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);

if (!process.versions.electron) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-thinking-slider-"));
  (async () => {
    await require(path.join(root, "app/manage-ui/node_modules/esbuild")).build({
      entryPoints: [path.join(root, "scripts/fixtures/chat-thinking-slider.tsx")], bundle: true, format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' }, loader: { ".woff2": "dataurl", ".woff": "dataurl", ".svg": "dataurl", ".png": "dataurl" },
      external: ["/fonts/*"], outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(root, "app/manage-ui/node_modules")], logLevel: "silent",
    });
    fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><html data-theme="light"><meta charset="utf-8"><title>思考模式滑动选择</title><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;width:100%;height:100%;background:var(--ui-canvas)}</style><div id="root"></div><script type="module" src="fixture.js"></script></html>');
    if (process.argv.includes("--serve")) {
      const server = require("node:http").createServer((request, response) => {
        const name = ({ "/": "index.html", "/fixture.js": "fixture.js", "/fixture.css": "fixture.css" })[request.url];
        if (!name) { response.writeHead(404).end(); return; }
        response.setHeader("Content-Type", name.endsWith("js") ? "text/javascript" : name.endsWith("css") ? "text/css" : "text/html");
        response.end(fs.readFileSync(path.join(temp, name)));
      });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      console.log(`PREVIEW http://127.0.0.1:${server.address().port}`);
      const close = () => { server.close(); fs.rmSync(temp, { recursive: true, force: true }); process.exit(); };
      process.once("SIGINT", close); process.once("SIGTERM", close);
      return;
    }
    const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require("node:child_process").spawn(require("electron"), [__filename, `--fixture=${temp}`,
      ...(option("output") ? [`--output=${path.resolve(option("output"))}`] : [])], { env, stdio: "inherit" });
    const timer = setTimeout(() => child.kill("SIGTERM"), 90000);
    const code = await new Promise(resolve => child.once("exit", resolve));
    clearTimeout(timer);
    assert.equal(code, 0, `Thinking slider fixture failed; retained ${temp}`);
    fs.rmSync(temp, { recursive: true, force: true });
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow } = require("electron");
  const temp = option("fixture"), output = option("output");
  app.setPath("userData", path.join(temp, "profile"));
  app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, width: 900, height: 650, webPreferences: { backgroundThrottling: false } });
    const errors = [], passed = [];
    window.webContents.on("console-message", (_event, level, message) => { if (level >= 3) errors.push(message); });
    const js = code => window.webContents.executeJavaScript(code, true);
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const check = async (label, run) => { await run(); passed.push(label); console.log(`PASS ${label}`); };
    const selector = ".think-fast-menu__slider";
    const snapshot = () => js(`(() => {
      const slider=document.querySelector('${selector}'), thumb=document.querySelector('.think-fast-menu__thumb'), popup=document.querySelector('.think-fast-menu');
      const s=slider?.getBoundingClientRect(),h=thumb?.getBoundingClientRect(),p=popup?.getBoundingClientRect();
      return { x:s?.left,y:s ? s.top+s.height/2 : 0,width:s?.width,thumb:h ? h.left+h.width/2 : 0,
        index:Number(slider?.getAttribute('aria-valuenow')),label:slider?.getAttribute('aria-valuetext'),
        dragging:slider?.hasAttribute('data-dragging'),commits:[...window.thinkingFixture.commits],
        transition:slider ? getComputedStyle(document.querySelector('.think-fast-menu__thumb-position')).transitionDuration : '',
        dark:popup?.classList.contains('think-fast-menu--dark'),popup:p ? {left:p.left,right:p.right} : null};
    })()`);
    const configure = async settings => { await js(`window.thinkingFixture.configure(${JSON.stringify(settings)})`); await wait(40); };
    const input = async (type, x, y, extra = {}) => {
      window.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), ...extra });
      await wait(25);
    };
    let pressed = false;
    const down = (x, y) => { pressed = true; return input("mouseDown", x, y, { button: "left", clickCount: 1 }); };
    const up = (x, y) => { pressed = false; return input("mouseUp", x, y, { button: "left", clickCount: 1 }); };
    const move = (x, y) => input("mouseMove", x, y, pressed ? { modifiers: ["leftButtonDown"] } : {});
    const click = async (x, y) => { await move(x, y); await down(x, y); await up(x, y); };
    const open = async () => { await js("if(!document.querySelector('.think-fast-menu'))document.querySelector('.chat-pill--think-fast').click()"); await wait(40); };
    const key = async keyCode => { window.webContents.sendInputEvent({ type: "keyDown", keyCode }); window.webContents.sendInputEvent({ type: "keyUp", keyCode }); await wait(40); };
    const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1.6, `${message}: ${actual} != ${expected}`);
    try {
      await window.loadFile(path.join(temp, "index.html"));
      await js("window.pointerEvents=[];for(const type of ['pointerdown','pointermove','pointerup','pointercancel','gotpointercapture','lostpointercapture'])document.addEventListener(type,e=>window.pointerEvents.push({type,id:e.pointerId,button:e.button,buttons:e.buttons,x:e.clientX,y:e.clientY,target:e.target.className}),true)");
      await wait(150); window.webContents.focus();
      await configure({ value: "" }); await open();
      await check("every inherited mode selects its real stop and label without an extra option or write", async () => {
        const modes = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "adaptive", "future-mode"];
        const labels = ["Off", "Minimal", "Low", "Medium", "High", "Extra high", "Max", "Ultra", "Adaptive", "future-mode"];
        await configure({ levels: ["", ...modes] });
        for (const [index, mode] of modes.entries()) {
          await configure({ defaultValue: mode }); await wait(300);
          let state = await snapshot(); assert.equal(state.index, index); assert.equal(state.label, labels[index]);
          near(state.thumb, state.x + state.width * index / (modes.length - 1), "effective mode position");
          assert.equal(await js("document.querySelector('.chat-pill--think-fast__label').textContent"), labels[index]);
          assert.equal(await js("document.querySelectorAll('.think-fast-menu__dots i').length"), modes.length);
          assert.equal(await js("document.querySelector('.think-fast-menu').textContent.includes('Inherited:')"), false);
          await click(state.thumb, state.y); state = await snapshot(); assert.deepEqual(state.commits, []);
        }
        await configure({ defaultValue: "low", levels: ["low", "medium", "high", "xhigh", "max", "ultra"] });
      });
      await configure({ value: "max" }); await wait(300); await js("window.thinkingFixture.defer(true)");
      await check("captured drag follows pointer, previews locally, saves once on release and reverts on rejection", async () => {
        let state = await snapshot(); const target = state.x + state.width * 1.35 / 5;
        await down(state.thumb + 4, state.y);
        await move(target + 4, state.y + 45); state = await snapshot();
        near(state.thumb, target, "drag keeps grab offset outside track"); assert.equal(state.label, "Medium"); assert.equal(state.dragging, true); assert.equal(state.commits.length, 0);
        await up(target + 4, state.y + 45); await wait(300); state = await snapshot();
        assert.deepEqual(state.commits, ["medium"]); near(state.thumb, state.x + state.width / 5, "release snap");
        await js("window.thinkingFixture.resolve(false)"); await wait(300); state = await snapshot(); assert.equal(state.label, "Max"); assert.equal(state.index, 4);
      });
      await check("rapid final choices serialize while remaining responsive", async () => {
        let state = await snapshot(); await click(state.x, state.y); await click(state.x + state.width * 2 / 5, state.y);
        state = await snapshot(); assert.deepEqual(state.commits, ["medium", "low"]); assert.equal(state.label, "High");
        await js("window.thinkingFixture.resolve()"); await wait(40); state = await snapshot(); assert.deepEqual(state.commits, ["medium", "low", "high"]);
        await js("window.thinkingFixture.resolve()"); await wait(300); assert.equal((await snapshot()).label, "High");
      });
      await js("window.thinkingFixture.defer(false)");
      await check("track click uses Tab liquid deformation without position overshoot", async () => {
        const state = await snapshot(); await click(state.x + state.width, state.y);
        const motion = await js(`(() => {
          const element=document.querySelector('.think-fast-menu__thumb-position'),animation=element.getAnimations()[0];
          if(!animation)return null;
          animation.pause();animation.currentTime=115;
          const fill=document.querySelector('.think-fast-menu__thumb-fill'),shape=fill.getAnimations().find(a=>a.effect.getTiming().duration===330);
          if(!shape)return null;shape.pause();shape.currentTime=63;
          const x=document.querySelector('.think-fast-menu__thumb').getBoundingClientRect();
          const result={duration:animation.effect.getTiming().duration,position:x.left+x.width/2,stretch:fill.getBoundingClientRect().width}; animation.finish();shape.finish();return result;
        })()`);
        assert.ok(motion); assert.equal(motion.duration, 250); assert.ok(motion.position > state.thumb && motion.position < state.x + state.width); assert.ok(motion.stretch > 12 && motion.stretch <= 18.1);
        await wait(40); near((await snapshot()).thumb, state.x + state.width, "click settles");
      });
      await check("short drags select the neighbour and pointer-up preserves the preview target", async () => {
        for (const direction of [-1, 1]) {
          await configure({ value: "high" }); await wait(350);
          let state = await snapshot(); const start = state.thumb, target = start + direction * state.width * .3 / 5, count = state.commits.length;
          await down(start, state.y); await move(target, state.y);
          state = await snapshot(); assert.equal(state.index, 2 + direction); assert.equal(state.commits.length, count);
          // A small release-coordinate wobble must not undo the highlighted choice.
          await up(start + direction * state.width * .15 / 5, state.y); await wait(350);
          state = await snapshot(); assert.equal(state.index, 2 + direction); assert.equal(state.commits.length, count + 1);
        }
      });
      await check("keyboard navigation remains immediate and Home selects the first real mode", async () => {
        await js(`document.querySelector('${selector}').focus()`); await key("Home"); let state = await snapshot(); assert.equal(state.label, "Low"); assert.equal(state.transition, "0s");
        await key("End"); assert.equal((await snapshot()).index, 5); await key("Left"); assert.equal((await snapshot()).index, 4);
      });
      await check("cancel, lost capture, secondary pointer and Escape never save a partial drag", async () => {
        const state = await snapshot(), count = state.commits.length;
        for (const cancel of ["cancel", "capture", "escape"]) {
          await down(state.thumb, state.y); await move(state.x + 35, state.y);
          const before = await snapshot();
          await js(`document.querySelector('${selector}').dispatchEvent(new PointerEvent('pointermove',{pointerId:99,isPrimary:false,clientX:999,bubbles:true}))`);
          near((await snapshot()).thumb, before.thumb, "secondary pointer ignored");
          if (cancel === "escape") await key("Escape");
          else await js(cancel === "cancel" ? `document.querySelector('${selector}').dispatchEvent(new PointerEvent('pointercancel',{pointerId:1,bubbles:true}))` : `document.querySelector('${selector}').releasePointerCapture(1)`);
          await up(state.x + 35, state.y); await open(); await wait(300);
          assert.equal((await snapshot()).commits.length, count); assert.equal((await snapshot()).index, 4);
        }
      });
      window.webContents.debugger.attach("1.3");
      await check("touch drag clamps to endpoints and commits on lift", async () => {
        let state = await snapshot(); const count = state.commits.length;
        const touch = (type, points) => window.webContents.debugger.sendCommand("Input.dispatchTouchEvent", { type, touchPoints: points });
        await touch("touchStart", [{ x: state.thumb, y: state.y, id: 7 }]);
        await touch("touchMove", [{ x: state.x + state.width + 80, y: state.y + 40, id: 7 }]); await wait(40);
        state = await snapshot(); assert.equal(state.index, 5); assert.equal(state.commits.length, count); near(state.thumb, state.x + state.width, "touch endpoint");
        await touch("touchEnd", []); await wait(300); assert.equal((await snapshot()).commits.length, count + 1);
      });
      await check("Fast animates both bolts only on enabling, stays still on reopen and respects reduced motion", async () => {
        const activeAnimations = () => js("[...document.querySelectorAll('.think-fast-menu__fast-btn svg,.chat-pill--think-fast__bolt svg')].flatMap(icon=>icon.getAnimations().map(animation=>animation.effect.getTiming().duration))");
        const toggle = async () => { await js("document.querySelector('.think-fast-menu__fast-btn').click()"); await wait(25); };
        const before = await js("document.querySelector('.chat-pill--think-fast').getBoundingClientRect().width");
        await toggle(); assert.deepEqual(await activeAnimations(), [340, 340]);
        assert.equal(await js("document.querySelector('.chat-pill--think-fast').getBoundingClientRect().width"), before);
        assert.equal(await js("getComputedStyle(document.querySelector('.chat-pill--think-fast')).backgroundImage"), "none");
        assert.notEqual(await js("getComputedStyle(document.querySelector('.think-fast-menu__fast-btn svg')).fill"), "none");
        await wait(360); assert.deepEqual(await activeAnimations(), []);
        await js("document.querySelector('.chat-pill--think-fast').click()"); await open(); assert.deepEqual(await activeAnimations(), []);
        await toggle(); assert.deepEqual(await activeAnimations(), []);
        assert.equal(await js("!!document.querySelector('.chat-pill--think-fast__bolt')"), false);
        await toggle(); assert.deepEqual(await activeAnimations(), [340, 340]);
        await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
        await wait(40); assert.deepEqual(await activeAnimations(), []);
        await toggle(); assert.deepEqual(await activeAnimations(), []);
      });
      await check("reduced motion, narrow dark popup, disabled and single/empty levels", async () => {
        await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
        let state = await snapshot(); await click(state.x + state.width * 2 / 5, state.y); state = await snapshot(); assert.equal(state.transition, "0s");
        await down(state.thumb, state.y); await move(state.thumb + 12, state.y);
        assert.equal(await js("getComputedStyle(document.querySelector('.think-fast-menu__thumb-fill')).transform"), "none");
        await up(state.thumb + 12, state.y);
        window.setSize(250, 650); await js("document.documentElement.setAttribute('data-theme','dark')"); await wait(100); state = await snapshot();
        assert.ok(state.dark); assert.ok(state.popup.left >= 18 && state.popup.right <= 232); assert.ok(state.x + state.width < state.popup.right);
        if (output) fs.writeFileSync(path.join(output, "dark-narrow.png"), (await window.webContents.capturePage()).toPNG());
        const count = state.commits.length; await down(state.thumb, state.y); await move(state.x + 10, state.y); await configure({ disabled: true }); await up(state.x + 10, state.y);
        assert.equal((await snapshot()).popup, null); assert.equal((await snapshot()).commits.length, count);
        await configure({ disabled: false, levels: ["high"], value: "high" }); await open(); state = await snapshot(); await click(state.x + state.width, state.y); assert.equal((await snapshot()).index, 0);
        await configure({ levels: [] }); assert.equal(await js(`!!document.querySelector('${selector}')`), false);
        await js("document.querySelector('.think-fast-menu__fast-btn').click()"); assert.equal(await js("document.querySelector('.think-fast-menu__fast-btn').getAttribute('aria-checked')"), "true");
        assert.equal(await js("[...document.querySelectorAll('.think-fast-menu__fast-btn svg,.chat-pill--think-fast__bolt svg')].flatMap(icon=>icon.getAnimations()).length"), 0);
        assert.equal(await js("getComputedStyle(document.querySelector('.chat-pill--think-fast')).backgroundImage"), "none");
      });
      await check("changing sessions drops queued saves and an abandoned drag", async () => {
        window.setSize(900, 650); await configure({ scope: 1, levels: ["low", "medium", "high", "xhigh", "max", "ultra"], value: "max" }); await open(); await js("window.thinkingFixture.defer(true)");
        let state = await snapshot(); const count = state.commits.length;
        await click(state.x, state.y); await click(state.x + state.width * 2 / 5, state.y);
        await configure({ scope: 2, value: "max" }); await js("window.thinkingFixture.resolve()"); await wait(50); assert.equal((await snapshot()).commits.length, count + 1);
        await open(); state = await snapshot(); await down(state.thumb, state.y); await move(state.x + 20, state.y); await configure({ scope: 3 }); await up(state.x + 20, state.y); await open();
        assert.equal((await snapshot()).commits.length, count + 1); assert.equal((await snapshot()).label, "Max");
      });
      await js("document.documentElement.setAttribute('data-theme','light');window.thinkingFixture.defer(false)");
      await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [] }); await wait(50);
      assert.deepEqual(errors, []);
      if (output) {
        fs.writeFileSync(path.join(output, "light.png"), (await window.webContents.capturePage()).toPNG());
        fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ passed, errors, liveProvider: false, installedApp: false }, null, 2));
      }
      window.destroy(); app.quit();
    } catch (error) { console.error(error); console.error(await snapshot().catch(() => null)); console.error(await js("window.pointerEvents.slice(-20)").catch(() => null)); window.destroy(); app.exit(1); }
  }).catch(error => { console.error(error); app.exit(1); });
}
