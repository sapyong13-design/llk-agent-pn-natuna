import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from './browser.mjs';
const browser = await chromium.launch({ ...browserLaunchOptions(), headless: true });
try {
  for (const fail of [false, true]) {
    const page = await browser.newPage();
    let completions = 0;
    const employee = { id:'check', nip:'199001012020011001', name:'Pengguna uji', position:'Pelaksana', satker:'Uji', department:'umum_keuangan', supervisor:{} };
    await page.route('**/api/session', r => r.fulfill({json:{employee:null,pending:{tempId:'temp-check',authenticated:true}}}));
    await page.route('**/api/bootstrap/complete', r => { completions++; return r.fulfill({status:fail?502:200,json:fail?{error:'Gagal membaca profil uji'}:{employee,history:{activities:[]}}}); });
    await page.route('**/api/employees/check/personal-template', r => r.fulfill({json:{activities:[]}}));
    await page.goto('http://127.0.0.1:4545/');
    await page.locator(fail?'#quickSsoRetryBtn':'#workChoices').waitFor({state:'visible'});
    await page.waitForTimeout(3200);
    assert.equal(completions,1,'Completion must not loop');
    if(fail) assert.match(await page.locator('#appFeedback').innerText(),/Gagal membaca profil uji/);
    await page.close();
  }
  console.log('PASS: automatic completion succeeds once; errors stop polling and remain visible.');
} finally { await browser.close(); }
