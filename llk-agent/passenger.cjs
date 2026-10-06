'use strict';

const { spawn } = require('node:child_process');
const { mkdir, lstat, open } = require('node:fs/promises');
const { constants } = require('node:fs');
const { join, isAbsolute } = require('node:path');
const { pathToFileURL } = require('node:url');

let lockProcess, server, stopping = false, lockReady = false;
function releaseLock() {
  lockReady = false;
  lockProcess?.stdin.end();
  lockProcess?.kill('SIGTERM');
}
function fail() {
  console.error('LLK startup/runtime guard failed; worker stopped.');
  process.exit(1);
}
process.on('exit', releaseLock);
function shutdown() {
  if (stopping) return;
  stopping = true;
  if (!server?.listening) { process.exit(0); return; }
  // Retain native lock until in-flight requests finish; never create another worker beside a write.
  setTimeout(() => process.exit(1), 10_000).unref();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function acquireLock(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const dir = await lstat(directory);
  if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o077)) throw new Error('Private runtime directory required');
  const file = await open(join(directory, 'runtime.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.nlink !== 1) throw new Error('Private runtime lock required');
  } finally { await file.close(); }
  await new Promise((resolve, reject) => {
    // flock owns descriptor; --close prevents shell/cat inheriting it. Open stdin keeps holder alive.
    lockProcess = spawn('flock', ['--exclusive', '--nonblock', '--close', join(directory, 'runtime.lock'), 'sh', '-c', "printf 'LOCKED\\n'; cat >/dev/null"], { stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => reject(new Error('Lock startup timeout')), 5_000);
    let output = '';
    lockProcess.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output === 'LOCKED\n' && !lockReady) { lockReady = true; clearTimeout(timer); resolve(); }
      else if (output.length > 64) { clearTimeout(timer); reject(new Error('Lock protocol invalid')); }
    });
    lockProcess.on('error', () => { clearTimeout(timer); reject(new Error('Native flock unavailable')); if (lockReady) fail(); });
    lockProcess.stdin.on('error', () => { if (lockReady) fail(); });
    lockProcess.on('exit', () => {
      clearTimeout(timer);
      if (lockReady) fail();
      else reject(new Error('Worker lock unavailable'));
    });
  });
}

(async () => {
  const transport = process.env.LLK_TRUSTED_PROXY;
  if (process.platform !== 'linux' || !process.env.LLK_PUBLIC_ORIGIN || !['unix','loopback'].includes(transport) || process.env.LSAPI_CHILDREN !== '1') throw new Error('Linux single-worker trusted proxy required');
  const secretValue = process.env.LLK_PROXY_SECRET;
  if (transport === 'loopback' && !/^[A-Za-z0-9_-]{32,256}$/.test(secretValue || '')) throw new Error('Loopback proxy secret required');
  const runtimeDir = process.env.LLK_RUNTIME_DIR;
  if (!runtimeDir || !isAbsolute(runtimeDir)) throw new Error('LLK_RUNTIME_DIR required');
  const protocolHeader = process.env.LLK_PROXY_PROTOCOL_HEADER;
  const protocolValue = process.env.LLK_PROXY_PROTOCOL_VALUE;
  if (!protocolHeader || !protocolValue) throw new Error('Verified proxy protocol header required');
  const clientIpHeader = process.env.LLK_PROXY_CLIENT_IP_HEADER;
  const clientIpMode = process.env.LLK_PROXY_CLIENT_IP_MODE;
  if (!!clientIpHeader !== !!clientIpMode) throw new Error('Verified client IP header and mode required together');
  await acquireLock(runtimeDir);
  if (stopping) return;
  const { createAppServer } = await import(pathToFileURL(join(__dirname, 'server.js')).href);
  server = await createAppServer({ trustedProxy: { transport, protocolHeader, protocolValue, ...(transport === 'loopback' ? {secretHeader:'x-llk-proxy-secret',secretValue} : {}), ...(clientIpHeader ? { clientIpHeader, clientIpMode } : {}) } });
  server.on('error', fail);
  server.on('listening', () => {
    const address = server.address();
    const unixListener = typeof address === 'string';
    const loopbackListener = address && typeof address === 'object' && ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address.address);
    if (transport === 'unix' ? !unixListener : !unixListener && !loopbackListener) { server.close(); fail(); return; }
    console.log('LLK HTTPS worker ready.');
  });
  // LiteSpeed supplies listener; explicit loopback keeps native fallback inaccessible outside this host.
  server.listen(Number(process.env.PORT || 4545), '127.0.0.1');
})().catch(fail);
