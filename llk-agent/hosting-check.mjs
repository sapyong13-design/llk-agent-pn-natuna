import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAppServer } from './server.js';

const origin = 'https://llk.pn-natuna.go.id';
const host = new URL(origin).host;
const proxy = { protocolHeader: 'x-forwarded-proto', protocolValue: 'https', clientIpHeader: 'x-forwarded-for', clientIpMode: 'single' };
const loginBody = { username: 'synthetic', password: 'synthetic-password', supervisorNip: '999999999999999999' };
const root = await mkdtemp(join(tmpdir(), 'llk-host-'));
const fixtures = [];
let sequence = 0;

function cookie(response, expired = false) {
  const value = response.headers['set-cookie']?.find(value => /^(?:__Host-)?llk-session=/.test(value));
  assert.ok(value, 'Session cookie required');
  for (const attribute of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) {
    assert.ok(value.split(';').map(part => part.trim()).includes(attribute), `Cookie requires ${attribute}`);
  }
  assert.doesNotMatch(value, /;\s*Domain=/i);
  if (expired) assert.match(value, /Max-Age=0/);
  else {
    assert.doesNotMatch(value, /;\s*(?:Max-Age|Expires)=/i);
    assert.match(value.split(';')[0].split('=')[1], /^[a-f0-9]{64}$/);
  }
  return value.split(';')[0];
}
function limited(response) {
  assert.equal(response.status, 429);
  assert.match(response.headers['retry-after'] || '', /^[1-9]\d*$/);
  assert.equal(response.headers['set-cookie'], undefined, 'Denied request cannot create session');
}
async function fixture({ tcp = false, trustedProxy = proxy, limits = {}, sessionTtlMs = 30 * 60_000, failLogin = false, crashLogin = false } = {}) {
  const id = ++sequence;
  const calls = { auth: 0, login: 0, verify: 0, close: 0 };
  const server = await createAppServer({
    publicOrigin: origin, trustedProxy, dataDir: join(root, `data-${id}`), sessionTtlMs,
    publicLimits: limits,
    authFactory() {
      calls.auth++;
      return {
        state: { stage: 'authenticator', message: 'Synthetic MFA' },
        async login() {
          calls.login++;
          if (crashLogin) throw new Error(`Internal ${root} synthetic-password`);
          if (failLogin) throw Object.assign(new Error('Synthetic rejected login'), { status: 401 });
          return this.state;
        },
        async verify() { calls.verify++; return this.state; },
        close() { calls.close++; },
      };
    },
    clientFactory() { assert.fail('Hosting boundary check must not create upstream client'); },
  });
  fixtures.push(server);
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\llk-host-${process.pid}-${id}` : join(root, `s${id}.sock`);
  const listening = once(server, 'listening');
  if (tcp) server.listen(0, '127.0.0.1');
  else server.listen(socketPath);
  await listening;
  async function request(path, { method = 'GET', jar, body, raw, ip = '192.0.2.1', headers = {} } = {}) {
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const finalHeaders = {
      host, 'x-forwarded-proto': 'https', 'x-forwarded-for': ip,
      ...(jar ? { cookie: jar } : {}),
      ...(!['GET', 'HEAD', 'OPTIONS'].includes(method) ? { origin, 'content-type': 'application/json' } : {}),
      ...(payload === undefined ? {} : { 'content-length': Buffer.byteLength(payload) }),
      ...headers,
    };
    for (const key of Object.keys(finalHeaders)) if (finalHeaders[key] === undefined) delete finalHeaders[key];
    return await new Promise((resolve, reject) => {
      const req = httpRequest({ ...(tcp ? { hostname: '127.0.0.1', port: server.address().port } : { socketPath }), path, method, headers: finalHeaders, agent: false }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let parsed;
          try { parsed = JSON.parse(text); } catch { parsed = null; }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed, text });
        });
      });
      req.setTimeout(5000, () => req.destroy(new Error(`HTTP check timeout: ${method} ${path}`)));
      req.on('error', reject);
      req.end(payload);
    });
  }
  async function session(ip) {
    const response = await request('/api/session', { ip });
    assert.equal(response.status, 200);
    assert.equal(response.body.employee, null);
    return cookie(response);
  }
  return { request, session, calls };
}

try {
  for (const publicOrigin of [
    'http://llk.pn-natuna.go.id', 'https://user@llk.pn-natuna.go.id',
    `${origin}/path`, `${origin}/`, `${origin}?q=1`, `${origin}#fragment`,
    'https://127.0.0.1', 'https://localhost', 'not-an-origin',
  ]) {
    await assert.rejects(createAppServer({ publicOrigin, dataDir: join(root, 'invalid') }), { name: 'TypeError' }, publicOrigin);
  }

  const boundary = await fixture();
  const jar = await boundary.session();
  const page = await boundary.request('/');
  assert.equal(page.status, 200);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.match(page.headers['content-security-policy'] || '', /default-src\s+'self'/);
  const scriptPolicy = page.headers['content-security-policy'].split(';').find(part => part.trim().startsWith('script-src'));
  assert.match(scriptPolicy || '', /'sha256-[A-Za-z0-9+/]+=*'/);
  assert.doesNotMatch(scriptPolicy || '', /'unsafe-inline'/);
  assert.equal((await boundary.request('/missing-static-file.txt')).status, 404);
  assert.equal((await boundary.request('/.env')).status, 403);
  for (const headers of [
    { host: 'attacker.example' }, { host: `${host}:443` },
    { 'x-forwarded-proto': undefined }, { 'x-forwarded-proto': 'http' },
    { 'x-forwarded-proto': 'https,http' }, { 'sec-fetch-site': 'cross-site' },
  ]) assert.equal((await boundary.request('/api/session', { jar, headers })).status, 403, JSON.stringify(headers));
  for (const method of ['POST', 'DELETE']) {
    for (const headers of [
      { origin: undefined }, { origin: 'https://attacker.example' },
      { origin: `${origin}:443` }, { origin: `${origin}/` },
      { 'content-type': undefined }, { 'content-type': 'text/plain' },
      { 'sec-fetch-site': 'cross-site' },
    ]) assert.equal((await boundary.request('/api/session/end', { method, jar, body: {}, headers })).status, 403, `${method} ${JSON.stringify(headers)}`);
  }
  assert.equal((await boundary.request('/api/session/end', { method: 'DELETE', jar, body: {} })).status, 404, 'Valid DELETE must pass origin boundary');
  const ended = await boundary.request('/api/session/end', { method: 'POST', jar, body: {} });
  assert.equal(ended.status, 200);
  cookie(ended, true);
  assert.equal((await boundary.request('/api/employees', { jar })).status, 401);
  assert.equal((await boundary.request('/api/employees', { jar: '__Host-llk-session=invalid' })).status, 401);

  for (const trustedProxy of [proxy, false]) {
    const tcp = await fixture({ tcp: true, trustedProxy });
    for (const headers of [{}, { 'x-forwarded-for': '127.0.0.1' }, { 'x-forwarded-proto': 'https', 'x-forwarded-for': '192.0.2.9' }]) {
      const denied = await tcp.request('/api/session', { headers });
      assert.equal(denied.status, 403, 'TCP forwarded headers never prove TLS');
      assert.equal(denied.headers['set-cookie'], undefined);
    }
  }
  const secret = 'synthetic-proxy-secret-not-production-0123456789';
  const loopback = await fixture({ tcp: true, trustedProxy: { ...proxy, transport: 'loopback', secretHeader: 'x-llk-proxy', secretValue: secret } });
  for (const headers of [
    {}, { 'x-llk-proxy': 'wrong-secret' }, { 'x-llk-proxy': `${secret},${secret}` },
    { 'x-llk-proxy': secret, 'x-forwarded-proto': undefined },
    { 'x-llk-proxy': secret, 'x-forwarded-proto': 'http' },
    { 'x-llk-proxy': secret, 'x-forwarded-proto': 'https,http' },
  ]) {
    const denied = await loopback.request('/api/session', { headers });
    assert.equal(denied.status, 403, 'Loopback proxy requires exact secret and HTTPS marker');
    assert.equal(denied.headers['set-cookie'], undefined);
  }
  const proxied = await loopback.request('/api/session', { headers: { 'x-llk-proxy': secret } });
  assert.equal(proxied.status, 200);
  const proxyJar = cookie(proxied);
  assert.equal((await loopback.request('/api/session/end', { method: 'POST', jar: proxyJar, body: {}, headers: { 'x-llk-proxy': secret, origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await loopback.request('/api/session/end', { method: 'POST', jar: proxyJar, body: {}, headers: { 'x-llk-proxy': secret } })).status, 200);
  const untrustedPipe = await fixture({ trustedProxy: false });
  assert.equal((await untrustedPipe.request('/api/session')).status, 403);

  const capacity = await fixture({ limits: { maxSessions: 2 } });
  const first = await capacity.session('192.0.2.1');
  await capacity.session('192.0.2.2');
  limited(await capacity.request('/api/session', { ip: '192.0.2.3' }));
  limited(await capacity.request('/api/session', { ip: '192.0.2.4', jar: '__Host-llk-session=invalid' }));
  assert.equal((await capacity.request('/api/session', { jar: first })).status, 200, 'Existing session works at capacity');
  assert.equal((await capacity.request('/api/session/end', { method: 'POST', jar: first, body: {} })).status, 200);
  await capacity.session('192.0.2.3');

  const anonymous = await fixture({ limits: { newSessionsPerIp: 2 } });
  await anonymous.session();
  await anonymous.session();
  limited(await anonymous.request('/api/session'));
  await anonymous.session('192.0.2.2');
  assert.equal(anonymous.calls.auth, 0);

  const sessionAttempts = await fixture({ failLogin: true, limits: { sessionAttempts: 2, ipAttempts: 10 } });
  const sessionJar = await sessionAttempts.session();
  for (let i = 0; i < 2; i++) assert.equal((await sessionAttempts.request('/api/bootstrap/login', { method: 'POST', jar: sessionJar, body: loginBody })).status, 401);
  limited(await sessionAttempts.request('/api/bootstrap/login', { method: 'POST', jar: sessionJar, body: loginBody, ip: '192.0.2.2' }));
  assert.equal(sessionAttempts.calls.auth, 2, 'Session cap precedes authFactory even after IP change');
  assert.equal(sessionAttempts.calls.login, 2);
  const independent = await sessionAttempts.session('192.0.2.3');
  assert.equal((await sessionAttempts.request('/api/bootstrap/login', { method: 'POST', jar: independent, body: loginBody, ip: '192.0.2.3' })).status, 401);

  const ipAttempts = await fixture({ failLogin: true, limits: { ipAttempts: 2, sessionAttempts: 10 } });
  for (let i = 0; i < 2; i++) {
    const next = await ipAttempts.session();
    assert.equal((await ipAttempts.request('/api/bootstrap/login', { method: 'POST', jar: next, body: loginBody })).status, 401);
  }
  const next = await ipAttempts.session();
  limited(await ipAttempts.request('/api/bootstrap/login', { method: 'POST', jar: next, body: loginBody }));
  assert.equal(ipAttempts.calls.auth, 2, 'IP budget survives session replacement');

  const mfa = await fixture({ limits: { sessionAttempts: 3, ipAttempts: 10 } });
  const mfaJar = await mfa.session();
  const loggedIn = await mfa.request('/api/bootstrap/login', { method: 'POST', jar: mfaJar, body: loginBody });
  assert.equal(loggedIn.status, 200);
  const verifyBody = { tempId: loggedIn.body.tempId, code: '123456' };
  for (let i = 0; i < 2; i++) assert.equal((await mfa.request('/api/bootstrap/authenticator', { method: 'POST', jar: mfaJar, body: verifyBody })).status, 200);
  limited(await mfa.request('/api/bootstrap/authenticator', { method: 'POST', jar: mfaJar, body: verifyBody }));
  assert.equal(mfa.calls.verify, 2, 'MFA budget checked before upstream verify');
  limited(await mfa.request('/api/bootstrap/complete', { method: 'POST', jar: mfaJar, body: { tempId: loggedIn.body.tempId } }));

  const unknownIp = await fixture({ limits: { newSessionsPerIp: 1 } });
  await unknownIp.session('not-an-ip');
  limited(await unknownIp.request('/api/session', { headers: { 'x-forwarded-for': undefined } }));
  limited(await unknownIp.request('/api/session', { ip: '192.0.2.1, 192.0.2.2' }));
  await unknownIp.session('192.0.2.3');
  const lastIp = await fixture({ trustedProxy: { ...proxy, clientIpMode: 'last' }, limits: { newSessionsPerIp: 1 } });
  await lastIp.session('192.0.2.10, 192.0.2.20');
  limited(await lastIp.request('/api/session', { ip: '192.0.2.11, 192.0.2.20' }));
  await lastIp.session('192.0.2.10, 192.0.2.21');
  const boundedIps = await fixture({ limits: { maxIpBuckets: 2 } });
  await boundedIps.session('192.0.2.1');
  await boundedIps.session('192.0.2.2');
  limited(await boundedIps.request('/api/session', { ip: '192.0.2.3' }));

  const expiry = await fixture({ sessionTtlMs: 1000, limits: { maxSessions: 1 } });
  const expiringJar = await expiry.session();
  await delay(600);
  limited(await expiry.request('/api/session', { jar: '__Host-llk-session=invalid' }));
  await delay(600);
  assert.equal((await expiry.request('/api/employees', { jar: expiringJar })).status, 401, 'Invalid cookie cannot keep other session alive');
  await expiry.session('192.0.2.2');
  const ttl = await fixture({ limits: { newSessionsPerIp: 1, ipWindowMs: 250 } });
  await ttl.session();
  limited(await ttl.request('/api/session'));
  await delay(350);
  await ttl.session();

  const bytes = await fixture({ limits: { bodyBytes: 256 } });
  const bytesJar = await bytes.session();
  assert.equal((await bytes.request('/api/bootstrap/login', { method: 'POST', jar: bytesJar, body: { ...loginBody, password: 'x'.repeat(512) } })).status, 413);
  assert.equal(bytes.calls.auth, 0);
  const errors = await fixture({ crashLogin: true });
  const errorJar = await errors.session();
  const failure = await errors.request('/api/bootstrap/login', { method: 'POST', jar: errorJar, body: loginBody });
  assert.equal(failure.status, 500);
  assert.doesNotMatch(failure.text, /Internal|synthetic-password|llk-host-/);
  console.log('hosting-check: public origin, real pipe/TCP boundary, secure cookies, caps, login/MFA throttles OK');
} finally {
  await Promise.all(fixtures.map(server => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
  await rm(root, { recursive: true, force: true });
}
