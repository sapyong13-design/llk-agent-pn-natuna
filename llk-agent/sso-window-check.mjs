import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from './browser.mjs';
const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');
const minimize = new Function(`${source.slice(source.indexOf('async function minimizeLoginWindow('), source.indexOf('async function openLogin('))}; return minimizeLoginWindow;`)();
const browser = await chromium.launch({ ...browserLaunchOptions(), headless: false });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent('<title>Uji jendela SSO lokal</title><p>Uji minimize tanpa menutup sesi.</p>');
  await minimize(context);
  const session = await context.newCDPSession(page);
  const { windowId } = await session.send('Browser.getWindowForTarget');
  const { bounds } = await session.send('Browser.getWindowBounds', { windowId });
  assert.equal(bounds.windowState, 'minimized');
  assert.equal(page.isClosed(), false);
  assert.equal(await page.title(), 'Uji jendela SSO lokal');
  await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  assert.equal((await session.send('Browser.getWindowBounds', { windowId })).bounds.windowState, 'normal');
  console.log('PASS: browser minimized, page remains open, window can be restored.');
} finally { await browser.close(); }
