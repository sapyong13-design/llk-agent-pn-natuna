import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const root = import.meta.dirname;
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const dependency = join(root, 'node_modules', 'playwright-core', 'package.json');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} berhenti dengan kode ${code}`)));
  });
}

try {
  if (!existsSync(dependency)) {
    console.log('Menyiapkan dependensi aplikasi pertama kali…');
    await run(npmCommand, ['install', '--omit=dev', '--no-audit', '--no-fund']);
  }
  await run(process.execPath, ['ops.mjs', 'preflight']);
  await run(process.execPath, ['server.js']);
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
}
