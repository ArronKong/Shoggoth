const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const [html, output] = process.argv.slice(2);
app.setPath('userData', path.join(path.dirname(html), 'profile'));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1360, height: 1000, webPreferences: { backgroundThrottling: false } });
  const run = script => window.webContents.executeJavaScript(script);
  const wait = async selector => {
    for (let i = 0; i < 300; i++) {
      if (await run('!!document.querySelector(' + JSON.stringify(selector) + ')')) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw Error('Missing ' + selector);
  };
  const screenshot = async name => {
    await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
    fs.writeFileSync(path.join(output, name), (await window.webContents.capturePage()).toPNG());
  };
  let passed = false;
  try {
    await window.loadFile(html);
    await wait('.chat-md a[href*="original-task-session"]');
    const ordinaryMessage = await run(`(()=>{const message=document.querySelector('.chat-md');if(!message.textContent.includes('值得回顾')||!message.textContent.includes('还没标记为结果'))throw Error('Actual model body missing');if(message.querySelectorAll('a').length!==3)throw Error('Authoritative links missing');return true;})()`);
    const noReminderUI = await run(`(()=>{if(document.querySelector('[data-proactive-panel],[data-proactive-notice]')||document.body.textContent.includes('提醒选项'))throw Error('Unrequested reminder UI');return true;})()`);
    await screenshot('sparknotes-chat-zh.png');
    await run(`document.querySelector('button[title="沉浸模式"]').click()`);
    await wait('button[aria-label="退出沉浸模式"]');
    const immersive = await run(`(()=>{if(document.querySelectorAll('a[href*="original-task-session"]').length<2)throw Error('Ordinary message not rendered in immersive chat');return true;})()`);
    await screenshot('sparknotes-immersive-zh.png');
    await run(`document.querySelector('button[aria-label="退出沉浸模式"]').click()`);
    window.setContentSize(700, 1000);
    await new Promise(resolve => setTimeout(resolve, 80));
    const narrow = await run('document.documentElement.scrollWidth<=window.innerWidth+1');
    if (!narrow) throw Error('Horizontal overflow');
    await screenshot('sparknotes-chat-narrow.png');
    await run(`document.querySelector('.chat-md a[href*="original-task-session"]').click()`);
    for (let i = 0; i < 300; i++) {
      if (await run(`document.body.textContent.includes('ORIGINAL-TASK-RESTORED')`)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const taskNavigation = await run(`(()=>{if(!document.body.textContent.includes('ORIGINAL-TASK-RESTORED'))throw Error('Original history not opened');if(window.fixtureError)throw Error(window.fixtureError);if(window.proactiveFixture.calls.some(c=>c.method==='chat.send'||c.method==='inspiration.respond'))throw Error('Reminder performed an action');return true;})()`);
    console.log(JSON.stringify({ verified: true, ordinaryMessage, noReminderUI, immersive, narrow, taskNavigation }));
    passed = true;
  } catch (error) {
    console.error(error.stack || error);
    console.error(await run('JSON.stringify({text:document.body.textContent,error:window.fixtureError})').catch(() => 'renderer unavailable'));
  } finally { window.destroy(); app.exit(passed ? 0 : 1); }
});
