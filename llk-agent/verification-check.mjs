import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from './browser.mjs';

const saved = new Set();
const submissions = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const fields = new URLSearchParams(body), id = fields.get('hllk');
    submissions.push(id);
    await new Promise(resolve => setTimeout(resolve, 250));
    if (id === '3') { res.writeHead(500); res.end('Save failed'); return; }
    if (id !== '4' && fields.get('verified') === '2' && fields.get('note') === 'Checked') saved.add(id);
    res.writeHead(303, { Location: '/verifikasi' }); res.end(); return;
  }
  res.setHeader('Content-Type', 'text/html');
  if (url.pathname === '/verifikasi/edit') {
    const id = url.searchParams.get('cid');
    res.end(`<form method="post" action="/verifikasi/update"><input name="hllk" value="${id}"><textarea name="note"></textarea><select name="verified"><option value="1" ${!saved.has(id) ? 'selected' : ''}>Pending</option><option value="2" ${saved.has(id) ? 'selected' : ''}>Verified</option></select></form>`);
  } else res.end('<h1>Verification list</h1>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ ...browserLaunchOptions(), headless: true });
  const context = await browser.newContext();
  await context.newPage();
  const targets = ['1', '2', '3', '4'].map(hllk => ({ hllk, date: hllk, editUrl: `${base}/verifikasi/edit?cid=${hllk}` }));
  const stage = { context, targets, token: 'test', expires: Date.now() + 60000, filter: { url: `${base}/verifikasi` } };
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function runAutomaticVerification('), source.indexOf('\nasync function archivePersonal('));
  const run = new Function('stagedVerification', 'clean', 'HttpError', 'bad', 'progress', 'llkLocation', 'verificationErrorMessage', 'audit', 'closeVerificationStage', `${body}; return runAutomaticVerification;`)(
    new Map([['test', stage]]), value => String(value || '').trim(), Error,
    message => { throw new Error(message); }, () => {},
    value => ({ authenticated: new URL(value).origin === base }), error => error.message,
    async () => {}, () => {}
  );
  const result = await run('test', { message: 'Checked', stageToken: 'test' });
  assert.deepEqual(result.results.map(row => row.success), [true, true, false, false]);
  assert.deepEqual([...saved], ['1', '2']);
  assert.deepEqual(submissions, ['1', '2', '3', '4']);
  console.log('PASS: delayed submissions finish in order; HTTP failure and unsaved state are not successes; no duplicate submissions.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
