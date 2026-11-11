import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

// Run after build:manage. Vite emits the shared styles into separate CSS
// chunks, so the production route is needed to exercise the actual cascade.
const dist = path.resolve(import.meta.dirname, '../app/manage-ui/dist');
const origin = 'https://shoggoth.test';
const growthLabel = 'AI 助理自动培育';
const searchLabel = '搜索灵感';
const failure = { ideaId: 'idea', runId: 'run', title: '待处理的灵感', attempts: 2, errorCode: 'INSPIRATION_FAILED' };
const responses = {
  '/__api/backends': { backends: [] },
  '/__api/status': { backends: [] },
  '/__api/inspirations': { items: [], total: 0, nextCursor: null, hasMore: false },
  '/__api/inspirations/agents': { agents: [] },
  '/__api/inspirations/agent-dock': { agents: [] },
  '/__api/inspirations/idle-agents': { agents: [], busyAgents: [] },
  '/__api/inspirations/growth': { settings: { enabled: false, revision: 1, executors: [] }, failures: [failure] },
  '/__api/inspirations/detail': { idea: { archivedAt: null, latestExecution: { runId: 'run', status: 'failed' } } },
};

async function assertSquare(button, description) {
  await button.waitFor();
  const { width, height } = await button.boundingBox();
  assert.deepEqual({ width, height }, { width: 48, height: 48 }, description);
}

function focusAppearance(button) {
  return button.evaluate(element => {
    const { borderColor, boxShadow, outlineStyle } = getComputedStyle(element);
    return { borderColor, boxShadow, outlineStyle };
  });
}

async function checkToolbar(browser, width, theme) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, colorScheme: theme,
    reducedMotion: 'reduce', serviceWorkers: 'block' });
  try {
    await context.route('**/*', (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin || request.method() !== 'GET') return route.abort();
      if (url.pathname === '/__api/config') {
        return route.fulfill({ json: { config: { locale: 'zh-CN', theme, setupCompletedAt: 1 } } });
      }
      if (responses[url.pathname]) return route.fulfill({ json: responses[url.pathname] });
      const file = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname);
      return fs.statSync(file, { throwIfNoEntry: false })?.isFile()
        ? route.fulfill({ path: file }) : route.fulfill({ status: 404 });
    });
    const page = await context.newPage();
    await page.goto(`${origin}/#/inspirations`);
    const toolbar = page.locator('[data-inspiration-toolbar]');
    const growth = toolbar.getByRole('button', { name: growthLabel });
    const search = toolbar.getByRole('button', { name: searchLabel });
    const notice = toolbar.locator('[data-inspiration-notices]');
    const scenario = `${width}px ${theme}`;
    await assertSquare(growth, `${scenario}: closed growth button`);
    await assertSquare(notice, `${scenario}: growth notice button`);
    await assertSquare(search, `${scenario}: collapsed search button`);

    const glass = await focusAppearance(growth);
    await growth.focus();
    assert.deepEqual(await focusAppearance(growth), glass, `${scenario}: focused growth button keeps the glass surface`);
    await growth.click();
    const panel = page.getByRole('dialog', { name: growthLabel });
    await panel.waitFor();
    await assertSquare(growth, `${scenario}: open growth button`);
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'hidden' });
    assert.deepEqual(await focusAppearance(growth), glass, `${scenario}: growth button after closing its panel`);

    await search.click();
    const searchBox = toolbar.getByRole('searchbox', { name: searchLabel });
    const searchWidth = await searchBox.evaluate(input => input.closest('label').getBoundingClientRect().width);
    assert.ok(searchWidth > 48, `${scenario}: expanded search width (${searchWidth}px)`);
    await assertSquare(growth, `${scenario}: growth button with expanded search`);
    console.log(`PASS Inspiration toolbar at ${scenario}`);
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch({ channel: fs.existsSync(chromium.executablePath()) ? undefined : 'chrome' });
try {
  for (const width of [1400, 390]) {
    for (const theme of ['light', 'dark']) await checkToolbar(browser, width, theme);
  }
} finally {
  await browser.close();
}
