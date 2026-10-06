import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as realTimeout, clearTimeout as clearRealTimeout } from 'node:timers';
import { mock } from 'node:test';
import { load } from 'cheerio';
import { createAppServer } from './server.js';

const BASE = 'https://llk.mahkamahagung.go.id';
const NIP_A = '111111111111111111';
const NIP_B = '222222222222222222';
const SUPERVISOR = '999999999999999999';
const PASSWORD = 'synthetic-password-not-for-storage';
const CODE = '123456';
const accounts = {
  alpha: { nip: NIP_A, name: 'Synthetic Alpha', date: '2026-01-05', activity: 'Synthetic Alpha activity' },
  beta: { nip: NIP_B, name: 'Synthetic Beta', date: '2026-01-06', activity: 'Synthetic Beta activity' },
  'alpha-second': { nip: NIP_A, name: 'Synthetic Alpha second browser', date: '2026-01-07', activity: 'Synthetic second browser activity' },
  expiring: { nip: NIP_A, name: 'Synthetic idle account', date: '2026-01-05', activity: 'Synthetic idle activity' },
  reading: { nip: NIP_A, name: 'Synthetic reader', date: '2026-01-05', activity: 'Synthetic reader activity' },
  writing: { nip: NIP_A, name: 'Synthetic writer', date: '2026-01-05', activity: 'Synthetic writer activity' },
};
const sessionTokens = new Set();
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const gates = new Set();
function gate() {
  const entered = deferred(), released = deferred();
  const result = { entered: entered.promise, release: () => released.resolve(), async wait() { entered.resolve(); await released.promise; } };
  gates.add(result);
  return result;
}
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = realTimeout(() => reject(new Error(`Timed out: ${label}`)), 5000); })]);
  } finally { clearRealTimeout(timer); }
}
function entriesHtml(entries) {
  return entries.map(entry => `<section><div>Tanggal Kegiatan: ${entry.date.split('-').reverse().join('-')}, Senin</div><table><thead><tr><th>Jam</th><th>Kegiatan</th><th>Jenis</th><th>Hasil</th></tr></thead><tbody>${entry.items.map(item => `<tr><td>${item.start} - ${item.end}</td><td>${escape(item.description)}</td><td>${escape(item.type)}</td><td>${escape(item.result)}</td></tr>`).join('')}</tbody></table></section>`).join('');
}
const item = description => ({ start: '08:00', end: '16:30', description, type: 'Utama', result: 'Selesai' });
function fakeUpstream() {
  const auths = [], clients = [], loginGates = new Map(), verifyGates = new Map();
  class Auth {
    constructor() { this.state = { stage: 'initial', message: '' }; this.closed = false; this.closedSignal = deferred(); auths.push(this); }
    async login(username, password) {
      assert.equal(password, PASSWORD);
      assert.ok(accounts[username], 'Only synthetic accounts allowed');
      this.username = username;
      if (loginGates.has(username)) await loginGates.get(username).wait();
      assert.equal(this.closed, false, 'Login cannot be cancelled by another browser');
      this.state = { stage: 'authenticator', message: `Synthetic MFA ${username}` };
      return this.state;
    }
    async verify(code) {
      assert.equal(this.state.stage, 'authenticator');
      assert.equal(code, CODE);
      if (verifyGates.has(this.username)) await verifyGates.get(this.username).wait();
      assert.equal(this.closed, false, 'MFA cannot be cancelled by another browser');
      this.state = { stage: 'authenticated', message: 'Synthetic authenticated' };
      return this.state;
    }
    cookies() { assert.equal(this.closed, false); return [{ name: 'synthetic-upstream', value: this.username }]; }
    close() { this.closed = true; this.state = { stage: 'closed', message: '' }; this.closedSignal.resolve(); }
  }
  class Client {
    constructor(cookies) {
      this.username = cookies.find(cookie => cookie.name === 'synthetic-upstream')?.value;
      this.account = accounts[this.username];
      assert.ok(this.account, 'Only fake upstream cookie accepted');
      this.entries = [{ date: this.account.date, items: [item(this.account.activity)] }];
      this.closed = false; this.closedSignal = deferred(); this.readGate = null; this.postGate = null; this.posts = 0;
      clients.push(this);
    }
    async get(value) {
      assert.equal(this.closed, false, 'Closed client cannot read');
      const url = new URL(value, BASE);
      let html;
      if (url.pathname === '/profile') {
        html = `<table>${[['Nama Lengkap', this.account.name], ['NIP', this.account.nip], ['Jabatan', 'Synthetic Clerk'], ['Satuan Kerja', '(1) Synthetic Satker']].map(([label, value]) => `<tr><th>${label}</th><td>${escape(value)}</td></tr>`).join('')}</table>`;
      } else if (url.pathname === '/llk/create') {
        html = '<form action="/llk/save" method="post"><input name="_token" value="synthetic-csrf"><select name="supervisor[nip]"></select></form>';
      } else if (url.pathname === '/llk') {
        if (this.readGate) { const pending = this.readGate; this.readGate = null; await pending.wait(); }
        assert.equal(this.closed, false, 'Expiry must wait for active read');
        html = entriesHtml(this.entries);
      } else if (url.pathname === '/verifikasi') {
        html = '<table><tbody><tr><td>Tidak ada data</td></tr></tbody></table>';
      } else { throw new Error(`Unexpected upstream GET ${url.href}`); }
      return { url, html, $: load(html), response: { status: 200, headers: new Headers() } };
    }
    async request(value) {
      assert.equal(this.closed, false);
      const url = new URL(value, BASE);
      assert.equal(url.pathname, '/llk/findPegawai');
      assert.equal(url.searchParams.get('q'), SUPERVISOR);
      return { html: JSON.stringify([{ id: 'synthetic-supervisor-id', text: SUPERVISOR, nama: 'Synthetic Supervisor' }]) };
    }
    async post(value, fields) {
      assert.equal(new URL(value, BASE).pathname, '/llk/save', 'No unexpected fake writes');
      assert.equal(this.closed, false);
      this.posts++;
      if (this.postGate) { const pending = this.postGate; this.postGate = null; await pending.wait(); }
      assert.equal(this.closed, false, 'Expiry must not cancel in-flight write');
      const descriptions = fields.getAll('items[description][]');
      this.entries.push({ date: fields.get('activity_date').split('-').reverse().join('-'), items: descriptions.map((description, index) => ({
        start: fields.getAll('items[start_time][]')[index], end: fields.getAll('items[end_time][]')[index], description,
        type: fields.getAll('items[type][]')[index] === 'primary' ? 'Utama' : 'Pendukung', result: fields.getAll('items[result][]')[index],
      })) });
      return { response: { status: 303, headers: new Headers({ location: `${BASE}/llk` }) } };
    }
    close() { this.closed = true; this.closedSignal.resolve(); }
  }
  return { auths, clients, loginGates, verifyGates, authFactory: () => new Auth(), clientFactory: cookies => new Client(cookies), client: username => clients.filter(client => client.username === username).at(-1) };
}
function cookieFrom(response, expiry = false) {
  const values = response.headers['set-cookie'] || [];
  const value = values.find(value => value.startsWith('llk-session='));
  assert.ok(value, 'Session response must set cookie');
  assert.match(value, /;\s*HttpOnly(?:;|$)/i);
  assert.match(value, /;\s*SameSite=Strict(?:;|$)/i);
  assert.match(value, /;\s*Path=\/(?:;|$)/i);
  assert.doesNotMatch(value, /;\s*Secure(?:;|$)/i, 'Loopback HTTP cookie must work');
  if (expiry) {
    assert.match(value, /Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  } else {
    assert.doesNotMatch(value, /Max-Age=|Expires=/i, 'Browser-session cookie only');
    const token = value.split(';')[0].slice('llk-session='.length);
    sessionTokens.add(token);
    assert.match(token, /^[A-Za-z0-9_-]+$/);
    assert.equal(Buffer.from(token, /^[a-f0-9]{64}$/i.test(token) ? 'hex' : 'base64url').length, 32, 'Opaque 32-byte cookie');
  }
  return value.split(';')[0];
}
const employeePath = (nip, action) => `/api/employees/${nip}/${action}`;
let dataDir;
const running = [];
mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date('2026-10-06T12:00:00Z') });
try {
  dataDir = await mkdtemp(join(tmpdir(), 'llk-multi-user-'));
  // Reuse real public department fixture; never copy reports, audit, or personal data.
  await writeFile(join(dataDir, 'department-templates.json'), await readFile(new URL('./data/department-templates.json', import.meta.url)));
  async function start(ttl) {
    const upstream = fakeUpstream();
    const server = await createAppServer({ authFactory: upstream.authFactory, clientFactory: upstream.clientFactory, dataDir, sessionTtlMs: ttl });
    running.push({ server, upstream });
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const origin = `http://127.0.0.1:${server.address().port}`;
    function request(path, { method = 'GET', cookie, body, headers = {}, unsafeHeaders = true } = {}) {
      return bounded(new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const finalHeaders = { ...(cookie ? { cookie } : {}), ...(method !== 'GET' && unsafeHeaders ? { origin, 'content-type': 'application/json' } : {}), ...(payload === undefined ? {} : { 'content-length': Buffer.byteLength(payload) }), ...headers };
        const req = httpRequest(new URL(path, origin), { method, headers: finalHeaders, agent: false }, res => {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('error', reject);
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString();
            try { resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }); } catch (error) { reject(error); }
          });
        });
        req.on('error', reject);
        req.end(payload);
      }), `${method} ${path}`);
    }
    async function expect(path, options, status = 200) {
      const result = await request(path, options);
      assert.equal(result.status, status, `${options?.method || 'GET'} ${path}: ${JSON.stringify(result.body)}`);
      return result;
    }
    async function browser() {
      const response = await expect('/api/session');
      assert.equal(response.body.employee, null);
      assert.equal(response.body.pending, null);
      return { cookie: cookieFrom(response) };
    }
    async function login(jar, username) {
      const result = await expect('/api/bootstrap/login', { method: 'POST', cookie: jar.cookie, body: { username, password: PASSWORD, supervisorNip: SUPERVISOR, department: 'umum_keuangan' } });
      assert.equal(result.body.stage, 'authenticator');
      return result.body.tempId;
    }
    async function verify(jar, tempId) {
      const result = await expect('/api/bootstrap/authenticator', { method: 'POST', cookie: jar.cookie, body: { tempId, code: CODE } });
      assert.equal(result.body.stage, 'authenticated');
    }
    async function complete(jar, tempId, username) {
      const oldCookie = jar.cookie;
      const result = await expect('/api/bootstrap/complete', { method: 'POST', cookie: oldCookie, body: { tempId } });
      assert.equal(result.body.employee.id, accounts[username].nip);
      assert.equal(result.body.employee.name, accounts[username].name);
      assert.equal(result.body.sessionActive, true);
      jar.cookie = cookieFrom(result);
      assert.notEqual(jar.cookie, oldCookie, 'Authentication rotates cookie');
      await expect('/api/employees', { cookie: oldCookie }, 401);
      await expect('/api/bootstrap/complete', { method: 'POST', cookie: oldCookie, body: { tempId } }, 401);
      return result.body;
    }
    async function authenticate(jar, username) { const tempId = await login(jar, username); await verify(jar, tempId); return complete(jar, tempId, username); }
    return { upstream, request, expect, browser, login, verify, complete, authenticate, origin };
  }

  const app = await start(60 * 60_000);
  const { expect, browser, upstream } = app;
  const a = await browser(), b = await browser(), c = await browser();
  assert.notEqual(a.cookie, b.cookie);
  for (const path of ['/api/employees', `/api/progress?employeeId=${NIP_A}`, employeePath(NIP_A, 'calendar-entries'), employeePath(NIP_A, 'personal-template'), '/api/verification/preview?employeeId=' + NIP_A]) {
    assert.equal((await expect(path, {}, 401)).headers['set-cookie'], undefined, 'Private request must not create session');
    assert.equal((await expect(path, { cookie: 'llk-session=forged-token' }, 401)).headers['set-cookie'], undefined, 'Unknown private cookie must not create session');
  }
  for (const cookie of ['llk-session=', 'llk-session=%00invalid', 'llk-session=short', 'unrelated=value']) await expect('/api/employees', { cookie }, 401);
  const bootstrapBody = { username: 'alpha', password: PASSWORD, supervisorNip: SUPERVISOR };
  await expect('/api/bootstrap/login', { method: 'POST', body: bootstrapBody }, 401);
  await expect('/api/bootstrap/login', { method: 'POST', cookie: 'llk-session=forged-token', body: bootstrapBody }, 401);
  assert.equal(upstream.auths.length, 0, 'Unauthorized bootstrap must not allocate auth');
  for (const path of ['/api/bootstrap/authenticator', '/api/bootstrap/complete']) await expect(path, { method: 'POST', body: { tempId: 'temp-forged', code: CODE } }, 401);
  const forged = await expect('/api/session', { cookie: 'llk-session=forged-token' });
  assert.equal(forged.body.employee, null);
  assert.notEqual(cookieFrom(forged), 'llk-session=forged-token', 'Unknown token never adopted');
  await expect(`/api/progress?employeeId=${NIP_A}`, { cookie: a.cookie }, 401);
  await expect(employeePath(NIP_A, 'personal-template'), { cookie: a.cookie }, 401);
  await expect('/api/templates');
  await expect('/api/calendar/2026');
  await expect('/api/session', { headers: { host: 'evil.example' } }, 403);
  await expect('/api/session', { cookie: a.cookie, headers: { 'sec-fetch-site': 'cross-site' } }, 403);

  // Each login and MFA held open concurrently, proving independent session locks.
  upstream.loginGates.set('alpha', gate()); upstream.loginGates.set('beta', gate());
  const loginA = app.login(a, 'alpha'), loginB = app.login(b, 'beta');
  await bounded(Promise.all([...upstream.loginGates.values()].map(value => value.entered)), 'Concurrent login entry');
  await expect('/api/session/end', { method: 'POST', cookie: a.cookie, body: {} }, 409);
  for (const value of upstream.loginGates.values()) value.release();
  const [tempA, tempB] = await Promise.all([loginA, loginB]);
  assert.notEqual(tempA, tempB);
  assert.equal((await expect('/api/session', { cookie: a.cookie })).body.pending.tempId, tempA);
  assert.equal((await expect('/api/session', { cookie: b.cookie })).body.pending.tempId, tempB);
  await expect('/api/bootstrap/authenticator', { method: 'POST', cookie: b.cookie, body: { tempId: tempA, code: CODE } }, 401);
  await expect('/api/bootstrap/complete', { method: 'POST', cookie: b.cookie, body: { tempId: tempA } }, 401);
  await expect('/api/bootstrap/complete', { method: 'POST', cookie: a.cookie, body: { tempId: tempB } }, 401);
  await expect('/api/bootstrap/complete', { method: 'POST', cookie: a.cookie, body: { tempId: tempA } }, 409);
  upstream.verifyGates.set('alpha', gate()); upstream.verifyGates.set('beta', gate());
  const verifyA = app.verify(a, tempA), verifyB = app.verify(b, tempB);
  await bounded(Promise.all([...upstream.verifyGates.values()].map(value => value.entered)), 'Concurrent MFA entry');
  for (const value of upstream.verifyGates.values()) value.release();
  await Promise.all([verifyA, verifyB]);
  await expect('/api/bootstrap/authenticator', { method: 'POST', cookie: b.cookie, body: { tempId: tempA, code: CODE } }, 401);
  await expect('/api/bootstrap/complete', { method: 'POST', cookie: b.cookie, body: { tempId: tempA } }, 401);
  await Promise.all([app.complete(a, tempA, 'alpha'), app.complete(b, tempB, 'beta')]);
  await app.authenticate(c, 'alpha-second');
  const clientA = upstream.client('alpha'), clientB = upstream.client('beta'), clientC = upstream.client('alpha-second');
  assert.equal((await expect('/api/employees', { cookie: a.cookie })).body[0].name, accounts.alpha.name);
  assert.equal((await expect('/api/employees', { cookie: b.cookie })).body[0].id, NIP_B);
  assert.equal((await expect('/api/employees', { cookie: c.cookie })).body[0].name, accounts['alpha-second'].name);
  for (const action of ['calendar-entries', 'personal-template', 'session/status']) {
    await expect(employeePath(NIP_B, action), { cookie: a.cookie }, 401);
    await expect(employeePath(NIP_A, action), { cookie: b.cookie }, 401);
  }
  await expect(`/api/progress?employeeId=${NIP_A}`, { cookie: b.cookie }, 401);
  await expect(`/api/progress?employeeId=${NIP_B}`, { cookie: a.cookie }, 401);
  for (const [jar, username] of [[a, 'alpha'], [b, 'beta'], [c, 'alpha-second']]) {
    const account = accounts[username];
    assert.deepEqual((await expect(employeePath(account.nip, 'calendar-entries'), { cookie: jar.cookie })).body.dates, [account.date]);
    assert.equal((await expect(employeePath(account.nip, 'personal-template'), { cookie: jar.cookie })).body.activities[0].nama, account.activity);
  }

  // Same NIP still owns distinct template stages, cache, progress, and locks.
  clientA.entries[0].items = [item('Synthetic staged Alpha update')];
  const stageA = (await expect(employeePath(NIP_A, 'personal-template/import'), { method: 'POST', cookie: a.cookie, body: {} })).body;
  const stageC = (await expect(employeePath(NIP_A, 'personal-template/import'), { method: 'POST', cookie: c.cookie, body: {} })).body;
  assert.notEqual(stageA.stageToken, stageC.stageToken);
  await expect(employeePath(NIP_A, 'personal-template/apply'), { method: 'POST', cookie: c.cookie, body: { stageToken: stageA.stageToken, confirm: NIP_A } }, 409);
  await expect(employeePath(NIP_A, 'personal-template/apply'), { method: 'POST', cookie: b.cookie, body: { stageToken: stageA.stageToken, confirm: NIP_A } }, 401);
  await expect(employeePath(NIP_A, 'personal-template/apply'), { method: 'POST', cookie: a.cookie, body: { stageToken: stageC.stageToken, confirm: NIP_A } }, 409);
  const appliedA = await expect(employeePath(NIP_A, 'personal-template/apply'), { method: 'POST', cookie: a.cookie, body: { stageToken: stageA.stageToken, confirm: NIP_A } });
  assert.equal(appliedA.body.activities[0].nama, 'Synthetic staged Alpha update');
  assert.equal((await expect(employeePath(NIP_A, 'personal-template'), { cookie: c.cookie })).body.activities[0].nama, accounts['alpha-second'].activity);
  await expect(employeePath(NIP_A, 'personal-template/apply'), { method: 'POST', cookie: c.cookie, body: { stageToken: stageC.stageToken, confirm: NIP_A } });
  const previewBody = { start: '2026-01-08', end: '2026-01-08', source: 'page' };
  await expect(employeePath(NIP_A, 'preview'), { method: 'POST', cookie: a.cookie, body: previewBody });
  const progressA = (await expect(`/api/progress?employeeId=${NIP_A}`, { cookie: a.cookie })).body;
  const progressC = (await expect(`/api/progress?employeeId=${NIP_A}`, { cookie: c.cookie })).body;
  assert.ok(progressA.events.some(event => event.stage === 'preview-start'));
  assert.equal(progressC.events.some(event => event.stage === 'preview-start'), false);
  const readGate = gate(); clientA.readGate = readGate;
  const readingA = expect(employeePath(NIP_A, 'calendar-entries?refresh=1'), { cookie: a.cookie });
  await bounded(readGate.entered, 'Alpha deferred read');
  await expect(employeePath(NIP_A, 'session/status'), { cookie: a.cookie }, 409);
  assert.deepEqual((await expect(employeePath(NIP_A, 'calendar-entries?refresh=1'), { cookie: c.cookie })).body.dates, [accounts['alpha-second'].date]);
  assert.deepEqual((await expect(employeePath(NIP_B, 'calendar-entries?refresh=1'), { cookie: b.cookie })).body.dates, [accounts.beta.date]);
  readGate.release(); await readingA;

  // DELETE needs same exact local Origin plus JSON; rejected request changes nothing.
  const deletePath = employeePath(NIP_A, 'personal-template');
  const deleteBody = { confirm: NIP_A };
  await expect(deletePath, { method: 'DELETE', cookie: a.cookie, body: deleteBody, headers: { origin: 'https://evil.example' } }, 403);
  await expect(deletePath, { method: 'DELETE', cookie: a.cookie, body: deleteBody, unsafeHeaders: false }, 403);
  await expect(deletePath, { method: 'DELETE', cookie: a.cookie, body: deleteBody, headers: { 'content-type': 'text/plain' } }, 403);
  await expect(deletePath, { method: 'DELETE', cookie: a.cookie, body: deleteBody, headers: { origin: app.origin.replace('127.0.0.1', 'localhost') } }, 403);
  await expect(deletePath, { method: 'DELETE', cookie: a.cookie, body: deleteBody, headers: { 'sec-fetch-site': 'cross-site' } }, 403);
  await expect('/api/session/end', { method: 'POST', cookie: a.cookie, body: {}, headers: { 'sec-fetch-site': 'cross-site' } }, 403);
  assert.equal((await expect(deletePath, { cookie: a.cookie })).body.source, 'personal');
  assert.equal((await expect(deletePath, { method: 'DELETE', cookie: a.cookie, body: deleteBody })).body.source, 'department');
  assert.equal((await expect(deletePath, { cookie: c.cookie })).body.source, 'personal');

  const verificationA = (await expect(`/api/verification/preview?employeeId=${NIP_A}`, { cookie: a.cookie })).body;
  const verificationC = (await expect(`/api/verification/preview?employeeId=${NIP_A}`, { cookie: c.cookie })).body;
  assert.notEqual(verificationA.stageToken, verificationC.stageToken);
  await expect('/api/verification/run', { method: 'POST', cookie: c.cookie, body: { employeeId: NIP_A, stageToken: verificationA.stageToken, message: 'Synthetic verification' } }, 409);
  await expect('/api/verification/run', { method: 'POST', cookie: c.cookie, body: { employeeId: NIP_A, stageToken: verificationC.stageToken, message: 'Synthetic verification' } }, 400);

  // Duplicate-only submits exercise real report persistence without upstream writes.
  const reportsBefore = (await readdir(dataDir)).filter(name => name.startsWith('report-'));
  for (const [jar, client] of [[a, clientA], [c, clientC]]) {
    const report = (await expect(employeePath(NIP_A, 'submit'), { method: 'POST', cookie: jar.cookie, body: { preview: client.entries, duplicatePolicy: 'skip' } })).body;
    assert.equal(report.success, 0); assert.equal(report.skipped, 1); assert.equal(report.failed, 0);
  }
  const reportsAfter = (await readdir(dataDir)).filter(name => name.startsWith('report-'));
  assert.equal(reportsAfter.length - reportsBefore.length, 2, 'Same-NIP browsers cannot overwrite reports');
  assert.equal(clientA.posts + clientB.posts + clientC.posts, 0);
  const cacheB = (await expect(employeePath(NIP_B, 'calendar-entries'), { cookie: b.cookie })).body;
  const cacheC = (await expect(employeePath(NIP_A, 'calendar-entries'), { cookie: c.cookie })).body;
  const oldA = a.cookie;
  const logoutA = await expect('/api/session/end', { method: 'POST', cookie: a.cookie, body: {} });
  cookieFrom(logoutA, true);
  assert.equal(clientA.closed, true);
  assert.equal(clientB.closed, false); assert.equal(clientC.closed, false);
  await expect('/api/employees', { cookie: oldA }, 401);
  assert.deepEqual((await expect(employeePath(NIP_B, 'calendar-entries'), { cookie: b.cookie })).body, cacheB);
  assert.deepEqual((await expect(employeePath(NIP_A, 'calendar-entries'), { cookie: c.cookie })).body, cacheC);
  assert.equal((await expect(employeePath(NIP_A, 'personal-template'), { cookie: c.cookie })).body.source, 'personal');
  assert.equal((await expect('/api/session', { cookie: b.cookie })).body.employee.id, NIP_B);
  const afterLogout = await expect('/api/session', { cookie: oldA });
  assert.equal(afterLogout.body.employee, null); assert.equal(afterLogout.body.pending, null);
  assert.notEqual(cookieFrom(afterLogout), oldA);
  const abandoned = await browser();
  const abandonedId = await app.login(abandoned, 'beta');
  const abandonedAuth = upstream.auths.filter(auth => auth.username === 'beta').at(-1);
  mock.timers.tick(10 * 60_000 + 1);
  await bounded(abandonedAuth.closedSignal.promise, 'Ten-minute login expiry');
  assert.equal((await expect('/api/session', { cookie: abandoned.cookie })).body.pending, null);
  await expect('/api/bootstrap/authenticator', { method: 'POST', cookie: abandoned.cookie, body: { tempId: abandonedId, code: CODE } }, 401);
  await expect('/api/verification/run', { method: 'POST', cookie: c.cookie, body: { employeeId: NIP_A, stageToken: verificationC.stageToken, message: 'Synthetic verification' } }, 409);

  // Controlled clock: no arbitrary sleeps, no production session/server touched.
  const expiry = await start(1000);
  const pending = await expiry.browser(), idle = await expiry.browser();
  const pendingId = await expiry.login(pending, 'beta');
  await expiry.authenticate(idle, 'expiring');
  const pendingAuth = expiry.upstream.auths.find(auth => auth.username === 'beta');
  const idleClient = expiry.upstream.client('expiring');
  const idleStage = (await expiry.expect(employeePath(NIP_A, 'personal-template/import'), { method: 'POST', cookie: idle.cookie, body: {} })).body;
  await expiry.expect(`/api/verification/preview?employeeId=${NIP_A}`, { cookie: idle.cookie });
  mock.timers.tick(600);
  assert.equal((await expiry.expect('/api/session', { cookie: idle.cookie })).body.employee.id, NIP_A);
  mock.timers.tick(401);
  await bounded(pendingAuth.closedSignal.promise, 'Pending login idle expiry');
  assert.equal(idleClient.closed, false, 'Session read refreshes idle deadline');
  mock.timers.tick(600);
  await bounded(idleClient.closedSignal.promise, 'Idle expiry cleanup');
  await expiry.expect('/api/employees', { cookie: idle.cookie }, 401);
  await expiry.expect('/api/bootstrap/authenticator', { method: 'POST', cookie: pending.cookie, body: { tempId: pendingId, code: CODE } }, 401);
  const freshIdle = await expiry.expect('/api/session', { cookie: idle.cookie });
  assert.equal(freshIdle.body.employee, null); assert.equal(freshIdle.body.pending, null);
  assert.notEqual(cookieFrom(freshIdle), idle.cookie);

  const reader = await expiry.browser(); await expiry.authenticate(reader, 'reading');
  assert.equal((await expiry.expect(employeePath(NIP_A, 'personal-template'), { cookie: reader.cookie })).body.activities[0].nama, accounts.reading.activity);
  await expiry.expect(employeePath(NIP_A, 'personal-template/apply'), { method: 'POST', cookie: reader.cookie, body: { stageToken: idleStage.stageToken, confirm: NIP_A } }, 409);
  const readerClient = expiry.upstream.client('reading');
  const pinnedRead = gate(); readerClient.readGate = pinnedRead;
  const readRequest = expiry.expect(employeePath(NIP_A, 'calendar-entries?refresh=1'), { cookie: reader.cookie });
  await bounded(pinnedRead.entered, 'Pinned expiry read');
  mock.timers.tick(1001);
  assert.equal(readerClient.closed, false, 'Active read pins upstream client');
  await expiry.expect('/api/employees', { cookie: reader.cookie }, 401);
  pinnedRead.release(); await readRequest;
  await bounded(readerClient.closedSignal.promise, 'Read release cleanup');

  const writer = await expiry.browser(); await expiry.authenticate(writer, 'writing');
  const writerClient = expiry.upstream.client('writing');
  const pinnedWrite = gate(); writerClient.postGate = pinnedWrite;
  const writeRequest = expiry.expect(employeePath(NIP_A, 'submit'), { method: 'POST', cookie: writer.cookie, body: {
    preview: [{ date: '2026-01-08', items: [item('Synthetic in-flight write')] }], duplicatePolicy: 'skip',
  } });
  await bounded(pinnedWrite.entered, 'Pinned expiry write');
  await expiry.expect('/api/session/end', { method: 'POST', cookie: writer.cookie, body: {} }, 409);
  assert.equal(writerClient.closed, false, 'Rejected logout preserves in-flight write');
  mock.timers.tick(1001);
  assert.equal(writerClient.closed, false, 'Active write must not be cancelled');
  await expiry.expect('/api/employees', { cookie: writer.cookie }, 401);
  pinnedWrite.release();
  const written = await writeRequest;
  assert.equal(written.body.success, 1);
  assert.equal(written.body.results[0].submitted, true);
  assert.equal(writerClient.posts, 1, 'One fake write, never retried');
  await bounded(writerClient.closedSignal.promise, 'Write release cleanup');
  await expiry.expect('/api/employees', { cookie: writer.cookie }, 401);

  // Temp persistence cannot include passwords, MFA, upstream cookies, session tokens, or personal-template files.
  for (const name of await readdir(dataDir)) {
    assert.ok(name === 'department-templates.json' || name === 'audit.jsonl' || /^report-[A-Za-z0-9_-]+\.json$/.test(name), `Unexpected persisted file ${name}`);
    const content = await readFile(join(dataDir, name), 'utf8');
    assert.equal(content.includes(PASSWORD), false);
    assert.equal(content.includes('synthetic-upstream'), false);
    assert.equal(content.includes('synthetic-csrf'), false);
    assert.equal(content.includes(`"${CODE}"`), false);
    for (const token of sessionTokens) {
      assert.equal(name.includes(token), false);
      assert.equal(content.includes(token), false);
    }
  }
} finally {
  for (const value of gates) value.release();
  try {
    for (const { server } of running.reverse()) {
      const closed = once(server, 'close');
      server.close(); server.closeAllConnections();
      await bounded(closed, 'Test server close');
    }
    for (const { upstream } of running) {
      await bounded(Promise.all([...upstream.clients, ...upstream.auths].map(value => value.closedSignal.promise)), 'Server session cleanup');
    }
  } finally {
    mock.timers.reset();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }
}
console.log('PASS multi-user HTTP isolation');
