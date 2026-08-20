import { constants, existsSync } from 'node:fs';
import { access, copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, join, resolve } from 'node:path';

const root = import.meta.dirname;
const port = Number(process.env.PORT || 4545);
const edgeCandidates = [
  process.env.EDGE_PATH,
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
].filter(Boolean);

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exitCode = 1;
}

async function portIsFree() {
  return new Promise(resolveResult => {
    const probe = createServer();
    probe.once('error', () => resolveResult(false));
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => probe.close(() => resolveResult(true)));
  });
}

async function preflight() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return fail(`PORT harus berupa angka 1-65535; nilai saat ini: ${process.env.PORT ?? '4545'}`);
  if (Number(process.versions.node.split('.')[0]) < 20) return fail(`Node.js 20 atau lebih baru diperlukan; versi saat ini ${process.version}.`);
  if (!edgeCandidates.some(existsSync)) return fail('Microsoft Edge tidak ditemukan. Instal Edge lalu coba lagi.');
  for (const dir of ['public', 'data']) {
    try { await access(join(root, dir), constants.R_OK); } catch { return fail(`Folder wajib tidak dapat dibaca: ${join(root, dir)}`); }
  }
  try { await mkdir(join(root, 'profiles'), { recursive: true }); await access(join(root, 'profiles'), constants.R_OK | constants.W_OK); }
  catch { return fail(`Folder profil tidak dapat ditulis: ${join(root, 'profiles')}`); }
  if (!(await portIsFree())) return fail(`Port ${port} sedang digunakan. Tutup aplikasi yang memakainya atau jalankan dengan PORT lain.`);
  console.log(`Pemeriksaan siap: Node ${process.version}, Edge tersedia, port ${port} bebas.`);
}

async function backup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = join(root, 'backups', `config-${stamp}`);
  const allowed = ['package.json', join('data', 'employees.json'), join('data', 'department-templates.json')];
  await mkdir(destination, { recursive: true });
  for (const relative of allowed) {
    const source = join(root, relative);
    if (!existsSync(source)) continue;
    const target = join(destination, relative);
    await mkdir(resolve(target, '..'), { recursive: true });
    await copyFile(source, target, constants.COPYFILE_EXCL);
  }
  console.log(`Backup konfigurasi dibuat: ${destination}`);
}

async function rotate() {
  const keep = Number(process.env.REPORT_KEEP || 20);
  if (!Number.isInteger(keep) || keep < 1 || keep > 1000) return fail('REPORT_KEEP harus berupa angka 1-1000.');
  const locations = [join(root, 'data'), join(root, 'reports')];
  const reports = [];
  for (const dir of locations) {
    if (!existsSync(dir)) continue;
    for (const name of await readdir(dir)) {
      if (!/^report-.*\.(?:json|jsonl)$/i.test(name)) continue;
      const path = join(dir, name);
      const info = await stat(path);
      if (info.isFile()) reports.push({ path, time: info.mtimeMs });
    }
  }
  reports.sort((a, b) => b.time - a.time);
  for (const report of reports.slice(keep)) await rm(report.path);
  console.log(`Rotasi selesai: ${Math.min(reports.length, keep)} laporan disimpan, ${Math.max(0, reports.length - keep)} dihapus.`);
}

const command = process.argv[2];
if (command === 'preflight') await preflight();
else if (command === 'backup') await backup();
else if (command === 'rotate') await rotate();
else fail(`Tugas tidak dikenal: ${basename(command || '(kosong)')}. Gunakan preflight, backup, atau rotate.`);
