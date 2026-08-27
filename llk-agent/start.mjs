import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const root = import.meta.dirname;
const port = process.env.PORT || '4545';
const dependency = join(root, 'node_modules', 'playwright-core', 'package.json');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} berhenti dengan kode ${code}`)));
  });
}

function openApp() {
  const url = `http://127.0.0.1:${port}`;
  const [command, args] = process.platform === 'win32'
    ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const opener = setTimeout(() => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
  }, 1200);
  opener.unref();
}

try {
  if (!existsSync(dependency)) {
    console.log('Menyiapkan dependensi aplikasi pertama kali…');
    const install = ['install', '--omit=dev', '--no-audit', '--no-fund'];
    await run(process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm', process.platform === 'win32' ? ['/d', '/s', '/c', `npm ${install.join(' ')}`] : install);
  }
  await run(process.execPath, ['ops.mjs', 'preflight']);
  openApp();
  await run(process.execPath, ['server.js']);
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
}
