import { createServer } from 'node:http';
import { readFile, writeFile, rename, mkdir, appendFile, chmod, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, extname, relative, isAbsolute } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from './browser.mjs';

const ROOT = resolve(import.meta.dirname);
const PUBLIC = join(ROOT, 'public');
const DATA = join(ROOT, 'data');
const PROFILE_ROOT = join(ROOT, 'profiles');
const PORT = Number(process.env.PORT || 4545);
const LLK_BASE = 'https://llk.mahkamahagung.go.id';
const employeeFile = join(DATA, 'employees.json');
const templateFile = join(DATA, 'department-templates.json');
const reportFile = id => join(DATA, `report-${id}.json`);
const profilePath = id => join(PROFILE_ROOT, id);
const verifierFile = join(DATA, 'verifier-relationships.json');
const auditFile = join(DATA, 'audit.jsonl');
const personalTemplateRoot = join(DATA, 'personal-templates');
const personalHistoryRoot = join(DATA, 'personal-template-history');
const personalFile = id => join(personalTemplateRoot, `${safeId(id)}.json`);
const personalHistoryDir = id => join(personalHistoryRoot, safeId(id));
const MAX_HISTORY = 20;
const sensitiveKeys = /password|cookie|csrf|token|secret|authorization/i;
const locks = new Set();
const stagedPersonal = new Map();
const operationProgress=new Map();
function progress(id,stage,message,detail={}){const current=operationProgress.get(id)||{sequence:0,events:[]};const event={sequence:++current.sequence,at:new Date().toISOString(),stage,message,...sanitize(detail)};current.events.push(event);if(current.events.length>100)current.events.shift();current.active=!['complete','error'].includes(stage);current.latest=event;operationProgress.set(id,current);return event;}
function progressState(id,since=0){const current=operationProgress.get(id)||{sequence:0,events:[],active:false,latest:null};return {active:current.active,sequence:current.sequence,latest:current.latest,events:current.events.filter(event=>event.sequence>since)};}
const loginFlows = new Map();
const sessionCookies = new Map();
const stagedVerification = new Map();
const VERIFICATION_STAGE_TTL = 10 * 60_000;
function closeVerificationStage(id){const stage=stagedVerification.get(id);if(!stage)return;clearTimeout(stage.timer);stagedVerification.delete(id);stage.context?.close().catch(()=>{});}
function stageVerification(id,context,targets,filter){closeVerificationStage(id);const token=randomBytes(16).toString('hex'),stage={token,context,targets,filter,expires:Date.now()+VERIFICATION_STAGE_TTL};stage.timer=setTimeout(()=>closeVerificationStage(id),VERIFICATION_STAGE_TTL);stagedVerification.set(id,stage);return stage;}
const LOGIN_FLOW_TTL = 10 * 60_000;
// Kalender libur SKB 3 Menteri 2026 (17 libur nasional + 8 cuti bersama).
const SKB_2026_DAYS = [
  {date:'2026-01-01',type:'national',label:'Tahun Baru 2026 Masehi'},
  {date:'2026-01-16',type:'national',label:'Isra Mikraj Nabi Muhammad SAW'},
  {date:'2026-02-16',type:'collective',label:'Cuti bersama Tahun Baru Imlek 2577 Kongzili'},
  {date:'2026-02-17',type:'national',label:'Tahun Baru Imlek 2577 Kongzili'},
  {date:'2026-03-18',type:'collective',label:'Cuti bersama Hari Suci Nyepi'},
  {date:'2026-03-19',type:'national',label:'Hari Suci Nyepi, Tahun Baru Saka 1948'},
  {date:'2026-03-20',type:'collective',label:'Cuti bersama Hari Raya Idul Fitri 1447 H'},
  {date:'2026-03-21',type:'national',label:'Hari Raya Idul Fitri 1447 H'},
  {date:'2026-03-22',type:'national',label:'Hari Raya Idul Fitri 1447 H'},
  {date:'2026-03-23',type:'collective',label:'Cuti bersama Hari Raya Idul Fitri 1447 H'},
  {date:'2026-03-24',type:'collective',label:'Cuti bersama Hari Raya Idul Fitri 1447 H'},
  {date:'2026-04-03',type:'national',label:'Wafat Yesus Kristus'},
  {date:'2026-04-05',type:'national',label:'Hari Kebangkitan Yesus Kristus (Paskah)'},
  {date:'2026-05-01',type:'national',label:'Hari Buruh Internasional'},
  {date:'2026-05-14',type:'national',label:'Kenaikan Yesus Kristus'},
  {date:'2026-05-15',type:'collective',label:'Cuti bersama Kenaikan Yesus Kristus'},
  {date:'2026-05-27',type:'national',label:'Hari Raya Idul Adha 1447 H'},
  {date:'2026-05-28',type:'collective',label:'Cuti bersama Idul Adha 1447 H'},
  {date:'2026-05-31',type:'national',label:'Hari Raya Waisak 2570 BE'},
  {date:'2026-06-01',type:'national',label:'Hari Lahir Pancasila'},
  {date:'2026-06-16',type:'national',label:'1 Muharam 1448 H / Tahun Baru Islam'},
  {date:'2026-08-17',type:'national',label:'Hari Proklamasi Kemerdekaan'},
  {date:'2026-08-25',type:'national',label:'Maulid Nabi Muhammad SAW'},
  {date:'2026-12-24',type:'collective',label:'Cuti bersama Kelahiran Yesus Kristus'},
  {date:'2026-12-25',type:'national',label:'Kelahiran Yesus Kristus'}
];
function getHolidays() {
  return new Set(SKB_2026_DAYS.map(day=>day.date));
}

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = message => { throw new HttpError(400, message); };
const json = (res, status, data, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(data)); };
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
async function saveJson(path, data) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
}
const bodyJson = req => new Promise((done, reject) => {
  let body = '', settled = false;
  req.on('data', chunk => { body += chunk; if (body.length > 1_000_000 && !settled) { settled = true; reject(new HttpError(413, 'Payload terlalu besar')); req.destroy(); } });
  req.on('end', () => { if (settled) return; try { done(body ? JSON.parse(body) : {}); } catch { reject(new HttpError(400, 'JSON tidak valid')); } });
  req.on('error', reject);
});
const employeeId = nip => String(nip || '').replace(/\D/g, '');
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
function safeId(value) { const id=String(value||''); if(!/^[A-Za-z0-9_-]{1,80}$/.test(id)) bad('ID pegawai tidak valid'); return id; }
function canonical(value) { if(Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if(value&&typeof value==='object') return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`; return JSON.stringify(value); }
function sanitize(value) { if(Array.isArray(value)) return value.map(sanitize); if(value&&typeof value==='object'){const out={}; for(const [key,item] of Object.entries(value)) if(!sensitiveKeys.test(key)) out[key]=sanitize(item); return out;} return typeof value==='string'?clean(value).slice(0,500):value; }
async function audit(event, actor, payload, result={}) { const safe=sanitize(payload), record={timestamp:new Date().toISOString(),event:clean(event),actorProfile:clean(actor||'local'),counts:sanitize(result.counts||{}),result:sanitize(result.result||result),payloadDigest:createHash('sha256').update(canonical(safe)).digest('hex')}; await appendFile(auditFile,`${JSON.stringify(record)}\n`,{encoding:'utf8',mode:0o600}); }
async function rotateFiles(dir,prefix,max=MAX_HISTORY){await mkdir(dir,{recursive:true});const names=(await readdir(dir)).filter(x=>x.startsWith(prefix)).sort().reverse();await Promise.all(names.slice(max).map(name=>rm(join(dir,name),{force:true})));}
const localIso = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
function parseDate(value, label = 'Tanggal') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) bad(`${label} tidak valid`);
  const [y, m, d] = value.split('-').map(Number), date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) bad(`${label} tidak valid`);
  return date;
}
function validateRange(start, end) {
  const first = parseDate(start, 'Tanggal mulai'), last = parseDate(end, 'Tanggal akhir'), today = parseDate(localIso(new Date()));
  if (first > last) bad('Tanggal mulai harus sebelum tanggal akhir');
  if (last > today) bad('Tanggal mendatang tidak diizinkan');
  if (Math.round((last - first) / 86400000) + 1 > 31) bad('Rentang maksimum 31 hari kalender');
  return { first, last };
}
async function workdays(start, end) {
  const { first, last } = validateRange(start, end), holidays = getHolidays(), days = [];
  for (const date = new Date(first); date <= last; date.setDate(date.getDate() + 1)) {
    const iso = localIso(date), dow = date.getDay();
    if (dow && dow !== 6 && !holidays.has(iso)) days.push({ iso, dow });
  }
  return days;
}
function normalizeOfficialDate(value) {
  const text = clean(value).toLowerCase();
  const months = { januari:1, februari:2, maret:3, april:4, mei:5, juni:6, juli:7, agustus:8, september:9, oktober:10, november:11, desember:12 };
  let match = text.match(/^(\d{1,2})[-/]([0-1]?\d)[-/](\d{4})$/);
  if (match) return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  match = text.match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/);
  return match && months[match[2]] ? `${match[3]}-${String(months[match[2]]).padStart(2, '0')}-${match[1].padStart(2, '0')}` : null;
}
async function getEmployees() {
  if (!existsSync(employeeFile)) return [];
  const value = await readJson(employeeFile);
  if (!Array.isArray(value)) throw new Error('Data pegawai rusak');
  return value;
}
async function findEmployee(id) { const employee = (await getEmployees()).find(e => e.id === id); if (!employee) throw new HttpError(404, 'Pegawai tidak ditemukan'); return employee; }
async function withLock(id, task) {
  if (locks.has(id) || loginFlows.has(id)) throw new HttpError(409, 'Operasi pegawai sedang berjalan');
  locks.add(id); try { return await task(); } finally { locks.delete(id); }
}
async function ensurePasswordManagerPrefs(dir) {
  const prefDir = join(dir, 'Default'), prefFile = join(prefDir, 'Preferences');
  await mkdir(prefDir, { recursive: true });
  let prefs = {};
  try { prefs = JSON.parse(await readFile(prefFile, 'utf8')); } catch {}
  let changed = false;
  if (prefs.credentials_enable_service !== true) { prefs.credentials_enable_service = true; changed = true; }
  prefs.profile = prefs.profile || {};
  if (prefs.profile.password_manager_enabled !== true) { prefs.profile.password_manager_enabled = true; changed = true; }
  prefs.autofill = prefs.autofill || {};
  if (prefs.autofill.profile_enabled !== true) { prefs.autofill.profile_enabled = true; changed = true; }
  if (prefs.autofill.credit_card_enabled !== true) { prefs.autofill.credit_card_enabled = true; changed = true; }
  if (changed) await saveJson(prefFile, prefs);
}
const sessionCookieFile=id=>join(profilePath(id),'session-cookies.json');
async function storeSessionCookies(id,cookies){sessionCookies.set(id,cookies);await mkdir(profilePath(id),{recursive:true});await saveJson(sessionCookieFile(id),cookies);}
async function loadSessionCookies(id){if(sessionCookies.has(id))return sessionCookies.get(id);if(existsSync(sessionCookieFile(id))){try{const cookies=await readJson(sessionCookieFile(id));sessionCookies.set(id,cookies);return cookies;}catch{}}return [];}
async function launchEmployee(id, headless = true) {
  const employee = await findEmployee(id), dir = profilePath(id);
  await mkdir(dir, { recursive: true });
  if (!headless) await ensurePasswordManagerPrefs(dir);
  let context;
  const launchOptions = browserLaunchOptions();
  if (headless) { const browser = await chromium.launch({ ...launchOptions, headless: true }); context = await browser.newContext({ viewport: { width: 1365, height: 768 } }); context.on('close', () => browser.close().catch(() => {})); }
  else context = await chromium.launchPersistentContext(dir, { ...launchOptions, headless: false, viewport: null });
  const cookies = await loadSessionCookies(id);
  if (cookies?.length) await context.addCookies(cookies);
  return { employee, context };
}
async function closeLoginFlow(id, flow = loginFlows.get(id)) {
  if (!flow || flow.closing) return false;
  flow.closing = true; clearTimeout(flow.timer); loginFlows.delete(id); locks.delete(id);
  try { await flow.context.close(); } catch {}
  if (id.startsWith('temp-')) await rm(profilePath(id), { recursive: true, force: true }).catch(() => {});
  return true;
}
async function openLogin(id) {
  if (locks.has(id) || loginFlows.has(id)) throw new HttpError(409, 'Operasi pegawai sedang berjalan');
  locks.add(id);
  try {
    const { employee, context } = await launchEmployee(id, false), createdAt = new Date().toISOString();
    const flow = { employee, context, createdAt, expiresAt: new Date(Date.now() + LOGIN_FLOW_TTL).toISOString(), closing: false };
    loginFlows.set(id, flow);
    context.on('close', () => { if (loginFlows.get(id) === flow) { clearTimeout(flow.timer); loginFlows.delete(id); locks.delete(id); } });
    flow.timer = setTimeout(() => closeLoginFlow(id, flow), LOGIN_FLOW_TTL); flow.timer.unref?.();
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(LLK_BASE, { waitUntil: 'domcontentloaded' });
    return { active: true, createdAt, expiresAt: flow.expiresAt, message: 'Edge dibuka. Selesaikan login SSO, lalu klik Selesai Login.' };
  } catch (error) { await closeLoginFlow(id); locks.delete(id); throw error; }
}
const SCHEDULE_PATTERNS = {
  full: { blocks: day => day.dow === 5 ? [['08:00', '17:00']] : [['08:00', '16:30']] },
  split: { blocks: day => day.dow === 5 ? [['08:00', '12:00'], ['13:30', '17:00']] : [['08:00', '12:00'], ['13:00', '16:30']] }
};
function officialSchedule(day, pattern) {
  return SCHEDULE_PATTERNS[pattern].blocks(day);
}
function inferSchedulePattern(day, priorEntries) {
  const patterns = new Set();
  const groups = new Map();
  for (const entry of priorEntries || []) {
    const key = entry.date || entry.rawDate || '';
    if (!key) continue;
    const entries = groups.get(key) || [];
    entries.push(entry);
    groups.set(key, entries);
  }
  for (const [key, entries] of groups) {
    const entryDay = /^\d{4}-\d{2}-\d{2}$/.test(key) ? new Date(`${key}T00:00:00`).getDay() : null;
    if (entryDay !== day.dow) continue;
    const work = entries.filter(entry => !entry.isBreak).map(entry => [entry.start, entry.end]);
    const split = officialSchedule(day, 'split'), full = officialSchedule(day, 'full');
    if (JSON.stringify(work) === JSON.stringify(split)) patterns.add('split');
    if (JSON.stringify(work) === JSON.stringify(full)) patterns.add('full');
  }
  if (patterns.size === 1) return [...patterns][0];
  return 'split';
}
async function generatePreview(employee, start, end, source = 'page', department, pageActivities = [], priorEntries = []) {
  if (!employee) throw new HttpError(404, 'Pegawai tidak ditemukan');
  const stored = await readJson(templateFile), templates = stored.departments || stored;
  const selectedDepartment = clean(department) || employee.department;
  if (!templates[selectedDepartment]) bad('Template bagian tidak tersedia');
  const useGeneral = source === 'general';
  const activities = useGeneral ? templates[selectedDepartment].activities : pageActivities;
  if (!activities?.length) bad(useGeneral ? 'Template umum bagian ini belum memiliki kegiatan' : 'Halaman pertama LLK belum memiliki kegiatan. Pilih Template umum sebagai sumber alternatif.');
  let index = 0;
  return (await workdays(start, end)).map(day => {
    const schedulePattern = inferSchedulePattern(day, priorEntries);
    const activityItem = (activity, start, end) => ({ description: activity.nama || activity.description, type: activity.kategori || activity.type || 'Pendukung', result: 'Selesai', start, end });
    let items;
    if (schedulePattern === 'full') {
      const [[start, end]] = officialSchedule(day, 'full');
      items = [activityItem(activities[index++ % activities.length], start, end)];
    } else {
      const [[morningStart, morningEnd], [afternoonStart, afternoonEnd]] = officialSchedule(day, 'split');
      items = [
        activityItem(activities[index++ % activities.length], morningStart, morningEnd),
        { start: morningEnd, end: afternoonStart, description: 'Istirahat', type: 'Pendukung', result: 'Selesai' },
        activityItem(activities[index++ % activities.length], afternoonStart, afternoonEnd)
      ];
    }
    return { date: day.iso, supervisor: employee.supervisor, activitySource: useGeneral ? 'template-general' : 'llk-page-1', schedulePattern, items };
  });
}
function minute(value) { if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) bad('Jam kegiatan tidak valid'); const [h,m] = value.split(':').map(Number); return h * 60 + m; }
async function validatePreview(preview) {
  if (!Array.isArray(preview) || !preview.length || preview.length > 31) bad('Preview wajib berisi kegiatan');
  const seen = new Set(), holidays = getHolidays();
  return preview.map((day, dayIndex) => {
    if (!day || typeof day !== 'object' || seen.has(day.date)) bad('Tanggal preview duplikat atau tidak valid'); seen.add(day.date);
    const date = parseDate(day.date), iso = localIso(date), dow = date.getDay();
    if (iso !== day.date || dow === 0 || dow === 6 || holidays.has(iso)) bad(`Tanggal ${day.date} bukan hari kerja`);
    const allowedPatterns = dow === 5
      ? [[['08:00', '17:00']], [['08:00', '12:00'], ['12:00', '13:30'], ['13:30', '17:00']]]
      : [[['08:00', '16:30']], [['08:00', '12:00'], ['12:00', '13:00'], ['13:00', '16:30']]];
    const items = day.items.map((item, itemIndex) => {
      if (!item || typeof item !== 'object') bad(`Baris ${itemIndex + 1} tidak valid`);
      const start = clean(item.start), end = clean(item.end), from = minute(start), to = minute(end);
      const description = clean(item.description), type = clean(item.type), result = clean(item.result);
      if (to <= from || !description || description.length > 2000 || !result || result.length > 500 || !['Utama','Pendukung'].includes(type)) bad(`Susunan waktu/kegiatan ${day.date} tidak valid`);
      return { start, end, description, type, result };
    });
    const actualBlocks = items.map(item => [item.start, item.end]);
    if (!allowedPatterns.some(pattern => JSON.stringify(pattern) === JSON.stringify(actualBlocks))) bad(`Jadwal ${day.date} harus memakai pola kerja resmi`);
    if (items.length === 3 && (items[1].description !== 'Istirahat' || items[1].type !== 'Pendukung')) bad(`Baris tengah ${day.date} harus berupa Istirahat`);
    return { date: iso, items };
  });
}
function pageDiagnostic(page){try{const url=new URL(page.url());return {origin:url.origin,pathname:url.pathname,title:''};}catch{return {origin:'null',pathname:'',title:''};}}
async function pageDiagnostics(context){return Promise.all(context.pages().map(async page=>({...pageDiagnostic(page),title:clean(await page.title().catch(()=>''))})));}
function llkLocation(value){try{const url=value instanceof URL?value:new URL(value);return {url,sameOrigin:url.origin===LLK_BASE,authenticated:url.origin===LLK_BASE&&!/^\/(?:sso|login)(?:\/|$)/i.test(url.pathname)};}catch{return {url:null,sameOrigin:false,authenticated:false};}}
function verificationErrorMessage(error){const message=clean(error?.message||error);return /Target page, context or browser has been closed|browserContext\.(?:cookies|newPage)/i.test(message)?'Sesi verifikasi berakhir. Pindai ulang; jika berulang, buka SSO dan login ulang.':message;}
function authenticatedLlkPage(context){return context.pages().find(page=>llkLocation(page.url()).authenticated);}
async function requireAuthenticatedLlkPage(context){const page=authenticatedLlkPage(context);if(page)return page;const pages=await pageDiagnostics(context);throw new HttpError(401,`Login LLK belum terdeteksi. Halaman aktif: ${pages.map(({origin,pathname})=>`${origin}${pathname}`).join(', ')||'(tidak ada)'}`);}
async function discoverLlkRoutes(page){return page.evaluate(base=>{const normalize=value=>String(value||'').replace(/\s+/g,' ').trim().toLowerCase();const routes=[];for(const element of document.querySelectorAll('a[href],form[action]')){try{const url=new URL(element.getAttribute('href')||element.getAttribute('action'),location.href);if(url.origin!==base)continue;routes.push({url:url.href,label:normalize(`${element.textContent||''} ${element.getAttribute('title')||''} ${element.getAttribute('aria-label')||''} ${url.pathname}`)});}catch{}}return routes;},LLK_BASE);}
function discoveredRoute(routes,patterns){return routes.find(route=>patterns.some(pattern=>pattern.test(route.label)))?.url||null;}
async function navigateFeature(page,url){
  if(!url)return {available:false,reason:'route-missing'};
  try { await page.goto(url,{waitUntil:'domcontentloaded'}); }
  catch(error) {
    if(!/ERR_ABORTED|Navigation interrupted/i.test(error?.message||''))throw error;
    await page.waitForLoadState('domcontentloaded').catch(()=>{});
  }
  const location=llkLocation(page.url());
  if(!location.sameOrigin||!location.authenticated)throw new HttpError(401,'Sesi LLK kedaluwarsa; login ulang diperlukan');
  const target=new URL(url);
  return location.url.pathname===target.pathname||location.url.href===target.href?{available:true}:{available:false,reason:'llk-redirect'};
}

async function scrapeEntries(context, existingPage) {
  const page = existingPage || await context.newPage(), owned = !existingPage;
  try {
    if (!llkLocation(page.url()).authenticated) {
      await page.goto(LLK_BASE, { waitUntil: 'domcontentloaded' });
      if (!llkLocation(page.url()).authenticated) throw new HttpError(401, 'Sesi LLK kedaluwarsa; login ulang diperlukan');
    }
    const llkMenu = page.locator('a[href="/llk"], a[href="https://llk.mahkamahagung.go.id/llk"]').first();
    if (!await llkMenu.count()) {
      const empty = [];
      empty.available = false;
      empty.warning = 'Menu LLK tidak ditemukan pada halaman akun aktif.';
      return empty;
    }
    await llkMenu.click();
    await page.waitForURL(url => url.origin === LLK_BASE && /\/llk(?:\/|$|\?)/i.test(url.pathname + url.search), { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    if (!/^\/llk(?:\/|$)/i.test(new URL(page.url()).pathname)) {
      const empty = [];
      empty.available = false;
      empty.warning = `Menu LLK tidak membuka daftar kegiatan: ${page.url()}.`;
      return empty;
    }
    await page.locator('table').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    const sourceUrl = page.url();
    const entries = await page.evaluate(() => {
      const cleanText = value => String(value || '').replace(/\s+/g, ' ').trim();
      const tables = [...document.querySelectorAll('table')];
      const output = [];
      for (const table of tables) {
        const headerRow = [...table.rows].find(row => [...row.cells].some(cell => /^(?:jam|waktu|kegiatan|uraian|aktivitas|jenis|hasil(?:\/volume)?|output)$/i.test(cleanText(cell.textContent))));
        if (!headerRow) continue;
        const headers = [...headerRow.cells].map(cell => cleanText(cell.textContent).toLowerCase());
        const indexFor = pattern => headers.findIndex(header => pattern.test(header));
        const timeIndex = indexFor(/^jam$|^waktu$/), activityIndex = indexFor(/^kegiatan$|^uraian$|^aktivitas$/), typeIndex = indexFor(/^jenis$/), resultIndex = indexFor(/^hasil(?:\/volume)?$|^output$/);
        if (timeIndex < 0 || activityIndex < 0 || typeIndex < 0 || resultIndex < 0) continue;
        for (const row of [...table.rows].slice(headerRow.rowIndex + 1)) {
          if (row.querySelector('table')) continue;
          const cells = [...row.cells].map(cell => cleanText(cell.textContent));
          const times = (cells[timeIndex] || '').match(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/g) || [];
          if (times.length < 2) continue;
          const description = cleanText(cells[activityIndex]);
          if (!description) continue;
          const rowText = cleanText(cells.join(' '));
          const rawDate = (cleanText(table.parentElement?.textContent).match(/Tanggal Kegiatan\s*:\s*([^,]+)/i) || rowText.match(/Tanggal Kegiatan\s*:\s*([^,]+)/i) || [])[1] || '';
          const type = /^(Utama|Pendukung)$/i.test(cells[typeIndex]) ? cells[typeIndex] : 'Pendukung';
          const result = cells[resultIndex] || 'Selesai';
          output.push({ rawDate, start: times[0], end: times[1], description, type, result, isBreak: /^istirahat$/i.test(description) });
        }
      }
      return output;
    });
    const normalized = entries.map(entry => ({ ...entry, date: normalizeOfficialDate(entry.rawDate) }));
    normalized.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    normalized.available = true;
    normalized.sourceUrl = sourceUrl;
    normalized.pagesScanned = 1;
    return normalized;
  } finally {
    if (owned) await page.close();
  }
}
const entryKey=e=>canonical({date:e.date,start:clean(e.start),end:clean(e.end),description:clean(e.description),type:clean(e.type).replace(/^primary$/i,'Utama').replace(/^support$/i,'Pendukung'),result:clean(e.result)});
async function extractCsrfToken(page, context) {
  const selectors = ['input[name="_token"]', 'input[name="csrf_token"]', 'input[name="_csrf"]', 'meta[name="csrf-token"]'];
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.count()) {
      const val = (await el.getAttribute(sel.startsWith('meta') ? 'content' : 'value'))?.trim();
      if (val) return val;
    }
  }
  const cookies = await context.cookies(LLK_BASE);
  const xsrf = cookies.find(c => /XSRF-TOKEN/i.test(c.name));
  if (xsrf?.value) {
    try { return decodeURIComponent(xsrf.value); } catch { return xsrf.value; }
  }
  throw new Error('CSRF token tidak ditemukan pada halaman LLK');
}
async function submitPreview(id, rawPreview, policy) {
  const preview = await validatePreview(rawPreview); if (!['skip','abort'].includes(policy)) bad('duplicatePolicy harus skip atau abort');
  const { employee, context } = await launchEmployee(id), report={ at:new Date().toISOString(), employee:{id:employee.id,name:employee.name}, duplicatePolicy:policy, results:[] };
  try {
    const existingEntries=await scrapeEntries(context),existing=new Set(existingEntries.map(entryKey)),existingDates=new Set(existingEntries.map(entry=>entry.date));
    const duplicateDates=preview.filter(day=>existingDates.has(day.date)).map(day=>day.date);
    if (duplicateDates.length && policy==='abort') {
      report.results=preview.map(day=>({date:day.date,state:duplicateDates.includes(day.date)?'skipped':'ready',status:duplicateDates.includes(day.date)?'duplicate':'ready',statusLabel:duplicateDates.includes(day.date)?'Tanggal sudah ada di LLK':'Belum dikirim',submitted:false,skipped:duplicateDates.includes(day.date),failed:false,verified:duplicateDates.includes(day.date),error:duplicateDates.includes(day.date)?'Tanggal sudah memiliki LLK pada halaman pertama; pengiriman seluruh rentang dibatalkan':undefined}));
      await saveJson(reportFile(id),report);
      throw new HttpError(409,`Tanggal sudah ada di LLK: ${duplicateDates.join(', ')}. Tidak ada tanggal yang dikirim.`);
    }
    if (preview.every(day => existingDates.has(day.date))) {
      report.results = preview.map(day => ({ date: day.date, state: 'skipped', status: 'duplicate', statusLabel: 'Sudah ada di LLK', message: 'Dilewati karena tanggal sudah memiliki LLK pada halaman pertama', submitted: false, skipped: true, failed: false, verified: true, itemCount: day.items.length }));
      report.success = 0;
      report.skipped = report.results.length;
      report.failed = 0;
      await saveJson(reportFile(id), report);
      return report;
    }
    const page = await context.newPage();
    await openLlkCreateForm(page);
    const token = await extractCsrfToken(page, context);
    const selectedSupervisor = await resolveLlkSupervisor(page, employeeId(employee.supervisor.nip) || employee.supervisor.id);
    const liveSupervisor = { id: selectedSupervisor.id, nip: selectedSupervisor.nip, name: selectedSupervisor.name, fields: { nip: 'live-page-fetch', name: 'live-page-fetch' } };
    if (!employeeId(liveSupervisor.nip) || !liveSupervisor.id || !liveSupervisor.name) throw new Error('Lookup atasan tidak lengkap. Pengiriman dibatalkan.');
    const employees = await getEmployees(), employeeIndex = employees.findIndex(item => item.id === employee.id);
    employee.supervisor = { id: liveSupervisor.id, nip: liveSupervisor.nip, name: liveSupervisor.name, verified: true, source: 'llk-select2' };
    if (employeeIndex >= 0) { employees.splice(employeeIndex, 1, employee); await saveJson(employeeFile, employees); }
    for (const day of preview) {
      if (existingDates.has(day.date)) {
        report.results.push({date:day.date,state:'skipped',status:'duplicate',statusLabel:'Sudah ada di LLK',message:'Dilewati karena tanggal sudah memiliki LLK di halaman pertama',submitted:false,skipped:true,failed:false,verified:true,itemCount:day.items.length});
        continue;
      }
      const result={date:day.date,state:'failed',status:'failed',statusLabel:'Gagal dikirim',submitted:false,skipped:false,failed:true,verified:false,itemCount:day.items.length,payload:{date:day.date,items:day.items}};
      try {
        const [year,month,date]=day.date.split('-');
        const payload=new URLSearchParams({redirect:`${LLK_BASE}/llk`,_token:token,'author[name]':employee.name,'author[nip]':employee.nip,'author[jabatan_text]':employee.position,'supervisor[nip]':liveSupervisor.id,'supervisor[name]':liveSupervisor.name,activity_date:`${date}-${month}-${year}`});
        for (const item of day.items) { payload.append('items[start_time][]',item.start); payload.append('items[end_time][]',item.end); payload.append('items[description][]',item.description); payload.append('items[type][]',item.type==='Utama'?'primary':'support'); payload.append('items[result][]',item.result); payload.append('items[note][]',''); payload.append('items[id][]',''); }
        const response=await context.request.post(`${LLK_BASE}/llk/save`,{headers:{'content-type':'application/x-www-form-urlencoded',referer:`${LLK_BASE}/llk/create`},data:payload.toString(),maxRedirects:0});
        result.httpStatus=response.status();
        result.submitted = response.status() === 303;
        if (result.submitted) {
          result.state = 'saved';
          result.status = 'awaiting_supervisor';
          result.statusLabel = 'Tersimpan di LLK · Menunggu verifikasi';
          result.message = 'Berhasil disimpan ke LLK (menunggu verifikasi atasan)';
          result.failed = false;
        } else {
          result.state = 'failed';
          result.status = 'failed';
          result.statusLabel = 'Gagal';
          result.failed = true;
          result.error = `HTTP respons ${response.status()}`;
        }
      } catch (error) {
        result.error = clean(error.message).slice(0,500);
        result.statusLabel = 'Gagal koneksi';
      }
      report.results.push(result);
      await saveJson(reportFile(id), report);
      if (result.failed) break;
    }
    report.success = report.results.filter(item => item.submitted && !item.skipped).length;
    report.skipped = report.results.filter(item => item.skipped).length;
    report.failed = report.results.filter(item => item.failed).length;
    await saveJson(reportFile(id), report);
    return report;
  } finally { await context.close(); }
}
function slug(text) { return clean(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''); }
async function importVerifier(id, existingContext, existingPage){
  const owned=!existingContext,{context}=existingContext?{context:existingContext}:await launchEmployee(id);
  try {
    const page=existingPage||(existingContext?await requireAuthenticatedLlkPage(context):await context.newPage());
    if(!llkLocation(page.url()).authenticated){await page.goto(LLK_BASE,{waitUntil:'domcontentloaded'});if(!llkLocation(page.url()).authenticated)throw new HttpError(401,'Sesi LLK kedaluwarsa; login ulang diperlukan');}
    let routes=await discoverLlkRoutes(page),profileUrl=discoveredRoute(routes,[/\bprofil(?:e)?\b/,/\bakun\b/]);
    if(profileUrl){const result=await navigateFeature(page,profileUrl);if(!result.available)await page.goto(LLK_BASE,{waitUntil:'domcontentloaded'});}
    const profile=await page.evaluate(()=>{const cleanText=value=>String(value||'').replace(/\s+/g,' ').trim();const all=[...document.querySelectorAll('body *')];const labeled=label=>{const node=all.find(el=>new RegExp(`^${label}\\s*:?$`,'i').test(cleanText(el.textContent)));if(!node)return '';return cleanText(node.nextElementSibling?.textContent||node.parentElement?.textContent).replace(new RegExp(`^${label}\\s*:?\\s*`,'i'),'');};const combined=cleanText(document.querySelector('.dropdown-toggle')?.textContent);const nip=(combined.match(/\b\d{8,20}\b/)||[])[0]||labeled('NIP').match(/\d{8,20}/)?.[0]||'';const name=cleanText(document.querySelector('[data-profile-name], .profile-name, h4')?.textContent)||labeled('Nama')||cleanText(combined.replace(nip,'').replace(/NIP\s*:?/i,''));return {name,nip};});
    const verifier={employeeId:id,name:clean(profile.name),nip:employeeId(profile.nip)};
    routes=await discoverLlkRoutes(page);const verifierUrl=discoveredRoute(routes,[/verifikasi/,/verifikator/,/pegawai.*verifikasi/]);
    const navigation=await navigateFeature(page,verifierUrl);
    if(!navigation.available)return {available:false,verifier,employees:[],warning:'Tahap verifikator: daftar pegawai tidak tersedia untuk akun ini.'};
    const rows=await page.evaluate(()=>{const text=e=>String(e?.textContent||'').replace(/\s+/g,' ').trim();return [...document.querySelectorAll('table tbody tr')].map((row,index)=>{const cells=[...row.querySelectorAll('td')].map(text);const link=row.querySelector('a[href]');return {routeId:link?.getAttribute('href')?.split('/').filter(Boolean).pop()||String(index),nip:(cells.join(' ').match(/\b\d{8,20}\b/)||[])[0]||'',name:cells.find(x=>x&&!/^\d+$/.test(x))||''};}).filter(x=>x.name);});
    if(!rows.length)return {available:false,verifier,employees:[],warning:'Tahap verifikator: daftar pegawai tidak tersedia untuk akun ini.'};
    const relationships={available:true,importedAt:new Date().toISOString(),verifier,employees:rows.map(row=>({employeeId:employeeId(row.nip)||slug(row.name),name:clean(row.name),llkRouteId:clean(row.routeId)}))};
    await saveJson(verifierFile,relationships);await audit('verifier.import',id,{employeeCount:relationships.employees.length},{counts:{employees:relationships.employees.length},result:'imported'});return relationships;
  } finally {if(owned)await context.close();}
}
async function templateSnapshot(){const templates=await readJson(templateFile);return templates.version&&templates.departments?templates:{version:1,updatedAt:null,departments:templates};}
async function readPersonal(id){return existsSync(personalFile(id))?validatePersonal(await readJson(personalFile(id)),id):null;}
function validatePersonal(value,id){if(!value||typeof value!=='object'||value.employeeId!==id||!Array.isArray(value.activities)||value.activities.length>1000)bad('Daftar kegiatan profil tidak valid');const activities=value.activities.map(a=>{const nama=clean(a?.nama),kategori=clean(a?.kategori)||'Pendukung';if(!nama||/^istirahat$/i.test(nama)||!['Utama','Pendukung'].includes(kategori))bad('Kegiatan profil tidak valid');return {nama,kategori,result:'Selesai',...(a.start?{start:clean(a.start)}:{}),...(a.end?{end:clean(a.end)}:{}),...(a.count?{count:a.count}:{}),...(a.lastSeen?{lastSeen:a.lastSeen}:{})};});return {...sanitize(value),employeeId:id,activities};}
async function personalResponse(employee){const personal=await readPersonal(employee.id),stored=await readJson(templateFile),departments=stored.departments||stored,fallback=departments[employee.department];return {source:personal?.activities?.length?'personal':'department',personal,activities:personal?.activities?.length?personal.activities:(fallback?.activities||[]),fallbackLabel:fallback?.label||employee.department};}
async function importPersonal(id, existingContext, existingPage) {
  const employee = await findEmployee(id), owned = !existingContext, { context } = existingContext ? { context: existingContext } : await launchEmployee(id);
  try {
    const entries = await scrapeEntries(context, existingPage), current = await readPersonal(id);
    if (entries.available === false) return { available: false, current, candidate: null, warning: entries.warning || 'Tahap riwayat: data LLK tidak tersedia; template pribadi tidak diubah.' };
    const seen = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      const nama = clean(entry.description);
      if (!nama || /^istirahat$/i.test(nama)) continue;
      const activity = { nama, kategori: /^(Utama|Pendukung)$/i.test(entry.type) ? clean(entry.type) : 'Pendukung' };
      const result = clean(entry.result || entry.output); if (result) activity.result = result;
      const key = canonical(activity);
      if (!seen.has(key)) seen.set(key, { ...activity, occurrences: 1, lastSeen: entry.date || null });
      else { const item = seen.get(key); item.occurrences += 1; if (entry.date && (!item.lastSeen || entry.date > item.lastSeen)) item.lastSeen = entry.date; }
    }
    const activities = [...seen.values()].sort((a, b) => b.occurrences - a.occurrences || a.nama.localeCompare(b.nama, 'id-ID')).map(({ occurrences, lastSeen, ...item }) => item);
    if (!activities.length) return { available: false, current, candidate: null, warning: 'Daftar LLK ditemukan, tetapi tidak ada kegiatan yang dapat dibaca. Template personal tidak diubah.' };
    const candidate = { version: 1, updatedAt: new Date().toISOString(), employeeId: id, activities };
    const stageToken = randomBytes(16).toString('hex'), digest = createHash('sha256').update(canonical(candidate)).digest('hex');
    stagedPersonal.set(id, { stageToken, token: stageToken, digest, candidate, expires: Date.now() + 15 * 60 * 1000 });
    return { available: true, current, candidate, activities, scannedEntries: entries.length, pagesScanned: entries.pagesScanned || 1, sourceUrl: entries.sourceUrl || null, stageToken, digest, diff: { added: activities.length, modified: 0, removed: current?.activities?.length || 0 } };
  } finally { if (owned) await context.close(); }
}

async function openLlkCreateForm(page) {
  await page.goto(LLK_BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const llkMenu = page.locator('a[href="/llk"], a[href="https://llk.mahkamahagung.go.id/llk"]').first();
  if (!await llkMenu.count()) throw new Error('Menu LLK tidak ditemukan dari dashboard');
  await llkMenu.click();
  await page.waitForURL(url => url.origin === LLK_BASE && /\/llk(?:\/|$|\?)/i.test(url.pathname + url.search), { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  if (!/^\/llk(?:\/|$)/i.test(new URL(page.url()).pathname)) throw new Error(`Menu LLK tidak membuka daftar LLK: ${page.url()}`);
  const createLink = page.locator('a[href="https://llk.mahkamahagung.go.id/llk/create"], a[href="/llk/create"]').first();
  if (!await createLink.count()) throw new Error(`Tombol buat LLK tidak ditemukan: ${page.url()}`);
  await createLink.click();
  await page.waitForURL(url => url.origin === LLK_BASE && /^\/llk\/create(?:\/|$|\?)/i.test(url.pathname + url.search), { timeout: 15000 });
  await page.waitForLoadState('domcontentloaded');
  if (!await page.locator('#snip, [name="supervisor[nip]"]').count()) throw new Error('Kontrol NIP Pejabat Atasan tidak ditemukan pada form buat LLK');
}

async function resolveLlkSupervisor(page, nip) {
  const binding = await page.evaluate(() => {
    const normalize = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const nodes = [...document.querySelectorAll('label,td,th,span,div')];
    const label = nodes.find(node => /^\*?\s*nip pejabat atasan\s*:?$/i.test(normalize(node.textContent)));
    if (!label) return { url: location.href, text: normalize(document.body.innerText).slice(0, 500), nipControl: null, nameControl: null };
    const row = label.closest('tr,.form-group,.control-group,.row') || label.parentElement;
    const root = row?.parentElement || document;
    const nipControl = row?.querySelector('input,select,[class*="select2-container"],[class*="select2-choice"]') || root.querySelector('input,select,[class*="select2-container"],[class*="select2-choice"]');
    const nameLabel = nodes.find(node => /^\*?\s*pejabat atasan\s*:?$/i.test(normalize(node.textContent)) && node !== label);
    const nameRow = nameLabel?.closest('tr,.form-group,.control-group,.row') || nameLabel?.parentElement;
    const nameControl = nameRow?.querySelector('input:not([type="hidden"]),textarea');
    return { url: location.href, nipControl: nipControl ? { id: nipControl.id, name: nipControl.getAttribute('name'), className: nipControl.className, tag: nipControl.tagName } : null, nameControl: nameControl ? { id: nameControl.id, name: nameControl.getAttribute('name') } : null };
  });
  if (!binding.nipControl) throw new Error(`Kontrol NIP Pejabat Atasan tidak ditemukan pada ${binding.url}: ${binding.text || ''}`);
  const trigger = binding.nipControl.id === 'snip'
    ? page.locator('.select2-selection[aria-labelledby="select2-snip-container"]').first()
    : binding.nipControl.id
      ? page.locator(`#${binding.nipControl.id} + .select2 .select2-selection, #${binding.nipControl.id} + [class*="select2-container"] [role="combobox"]`).first()
      : page.locator(`[name="${binding.nipControl.name}"] + .select2 .select2-selection, [name="${binding.nipControl.name}"] + [class*="select2-container"] [role="combobox"]`).first();
  if (!await trigger.count()) throw new Error(`Kontrol Select2 NIP Pejabat Atasan tidak terlihat untuk ${nip}`);
  await trigger.click();
  const search = page.locator('.select2-container--open .select2-search__field, .select2-drop-active .select2-input, .select2-search input').first();
  await search.waitFor({ state: 'visible', timeout: 10000 });
  await search.fill(nip);
  const option = page.locator('.select2-results__option:not([aria-disabled="true"]), .select2-result-selectable').filter({ hasText: new RegExp(nip) }).first();
  await option.waitFor({ state: 'visible', timeout: 15000 });
  const resultText = clean(await option.textContent());
  await option.click();
  const selectedValue = clean(await page.locator(`#${binding.nipControl.id}, [name="${binding.nipControl.name}"]`).first().inputValue());
  const nameField = binding.nameControl ? page.locator(`#${binding.nameControl.id}, [name="${binding.nameControl.name}"]`).first() : page.locator('input[readonly], input[disabled]').filter({ hasNot: page.locator('[type="hidden"]') }).last();
  await nameField.waitFor({ state: 'visible', timeout: 10000 });
  const name = clean(await nameField.inputValue());
  if (!selectedValue || !name) throw new Error(`Pilihan atasan belum lengkap untuk NIP ${nip}`);
  return { id: selectedValue, nip, name, url: page.url(), resultText, control: 'interactive-select2' };
}
async function enrichEmployeeFromSso(employee, page) {
  const originalUrl = page.url();
  await page.goto(`${LLK_BASE}/profile`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const profile = await page.evaluate(() => {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const read = label => {
      const node = [...document.querySelectorAll('th, dt, label, div')].find(item => clean(item.textContent) === label);
      const container = node?.closest('tr, dl, .row, .form-group') || node?.parentElement;
      const values = [...(container?.querySelectorAll('td, dd, [class*="col-"]') || [])].map(item => clean(item.textContent)).filter(value => value && value !== label);
      return values.at(-1) || '';
    };
    return { name: read('Nama Lengkap'), nip: read('NIP'), position: read('Jabatan'), satker: read('Satuan Kerja').replace(/^\(\d+\)\s*/, '') };
  });
  const requestedNip = employeeId(employee.supervisor.nip) || clean(employee.supervisor.id);
  const lookup = { attempted: Boolean(requestedNip), nip: requestedNip, name: '', control: 'live-page-fetch', select2: true };
  if (requestedNip) {
    try {
      await openLlkCreateForm(page);
      const selected = await resolveLlkSupervisor(page, requestedNip);
      lookup.name = selected.name;
      lookup.resultText = selected.resultText;
      lookup.url = selected.url;
      lookup.control = selected.control;
    } catch (error) {
      lookup.error = clean(error.message).slice(0, 500);
    }
  }
  if (originalUrl && originalUrl !== page.url()) await page.goto(originalUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const name = clean(profile.name), nip = employeeId(profile.nip), position = clean(profile.position), satker = clean(profile.satker), supervisorName = clean(lookup.name);
  const updated = {
    ...employee,
    name: name.length > 3 ? name : employee.name,
    nip: nip || employee.nip,
    position: position.length > 3 ? position : employee.position,
    satker: satker.length > 3 ? satker : employee.satker,
    supervisor: { id: requestedNip || employee.supervisor.id, nip: requestedNip || employee.supervisor.nip, name: supervisorName || employee.supervisor.name, verified: Boolean(requestedNip && supervisorName), source: supervisorName ? 'llk-select2' : 'pending-lookup' },
    accountIdentity: { name, nip, position, satker },
    supervisorLookup: lookup
  };
  const employees = await getEmployees();
  const index = employees.findIndex(item => item.id === employee.id || item.nip === updated.nip);
  if (index >= 0) employees.splice(index, 1, updated); else employees.push(updated);
  await saveJson(employeeFile, employees);
  return updated;
}

async function launchExternalBootstrap(satker, supervisorNip, department = 'umum_keuangan') {
  const tempId = `temp-${Date.now()}`;
  const employee = { id:tempId, nip:'', name:'Pegawai Baru', position:'Pegawai / Pelaksana', department, satker:clean(satker)||'Satker Lain', supervisor:{id:employeeId(supervisorNip),nip:employeeId(supervisorNip),name:''} };
  const dir=profilePath(tempId);
  await mkdir(dir,{recursive:true});
  await ensurePasswordManagerPrefs(dir);
  const context=await chromium.launchPersistentContext(dir,{channel:'msedge',headless:false,viewport:null});
  return {employee,context,tempId};
}

async function completeExternalBootstrap(tempId, tempEmployee, context) {
  const page = await requireAuthenticatedLlkPage(context);
  const enrichedDraft = await enrichEmployeeFromSso(tempEmployee, page);
  const actualNip = employeeId(enrichedDraft.nip);
  if (!actualNip) throw new HttpError(401, 'NIP akun login SSO tidak terdeteksi dari profil LLK');
  const enriched = { ...enrichedDraft, id: actualNip, nip: actualNip };
  const employees = (await getEmployees()).filter(item => item.id !== tempId && item.id !== actualNip);
  employees.push(enriched);
  await saveJson(employeeFile, employees);
  const history = await importPersonal(actualNip, context, page);
  if (history?.candidate) await saveJson(personalFile(actualNip), history.candidate);
  await storeSessionCookies(actualNip, await context.cookies());
  const flow = loginFlows.get(tempId);
  if (flow) {
    flow.employee = enriched;
    flow.actualNip = actualNip;
    flow.fetchedAt = new Date().toISOString();
  }
  return { employee: enriched, verifier: { available: false, warning: null }, history, sessionActive: true, tempId };
}

function normalizedIdentity(value){return clean(value).toLocaleLowerCase('id-ID');}
async function completeLogin(id){
  const flow = loginFlows.get(id); if (!flow || flow.closing) throw new HttpError(409, 'Tidak ada proses login aktif');
  const page = await requireAuthenticatedLlkPage(flow.context);
  const employee = await enrichEmployeeFromSso(flow.employee, page);
  const actualNip = employeeId(employee.nip), expectedNip = employeeId(flow.employee.nip), warnings = [];
  if (expectedNip && actualNip !== expectedNip) throw new HttpError(401, 'Identitas akun SSO tidak cocok dengan NIP pegawai terpilih');
  if (!expectedNip && normalizedIdentity(employee.name) !== normalizedIdentity(flow.employee.name)) {
    throw new HttpError(401, 'Identitas akun SSO tidak cocok dengan nama pegawai terpilih');
  }
  const history = await importPersonal(id, flow.context, page); if (history.warning) warnings.push(history.warning);
  await storeSessionCookies(id, await flow.context.cookies());
  await closeLoginFlow(id, flow);
  return { active: false, authenticated: true, stage: 'complete', identity: employee.accountIdentity, employee, warning: warnings.join(' ') || null, warnings, verifier: { available: false, warning: null }, history, autoApplied: false };
}
async function verificationTargets(id, context, extractIds = true) {
  progress(id,'launch','Memuat sesi LLK tersimpan di browser headless…');
  try {
    const page=context.pages()[0]??await context.newPage();
    if(!llkLocation(page.url()).authenticated){
      await page.goto(LLK_BASE,{waitUntil:'domcontentloaded'});
      if(!llkLocation(page.url()).authenticated)throw new HttpError(401,'Sesi LLK kedaluwarsa; login ulang diperlukan');
    }
    const menu=page.locator('a[href="/verifikasi"], a[href="https://llk.mahkamahagung.go.id/verifikasi"]').first();
    const pendingCount=await menu.evaluate(node=>{const text=String(node.textContent||'').replace(/\s+/g,' ').trim(),badge=node.querySelector('.badge,.label,[class*="badge"],[class*="label"]'),raw=String(badge?.textContent||text).match(/\b(\d+)\b/)?.[1];return Number(raw||0);}).catch(()=>0);
    if(!pendingCount){
      progress(id,'complete','Menu Verifikasi LLK tidak memiliki badge merah. Tidak ada LLK yang perlu diverifikasi.',{url:page.url(),pendingCount:0});
      return Object.assign([],{pagesScanned:0,rowsFound:0,validCount:0,invalidCount:0,invalidTargets:[]});
    }
    progress(id,'home',`Badge Verifikasi LLK menunjukkan ${pendingCount} target. Membuka daftar verifikasi…`,{url:page.url(),pendingCount});
    await Promise.all([page.waitForURL(url=>url.origin===LLK_BASE&&/^\/verifikasi(?:\/|$)/i.test(url.pathname),{timeout:15000,waitUntil:'domcontentloaded'}),menu.click()]);
    await page.waitForLoadState('domcontentloaded',{timeout:15000});
    progress(id,'verification','Halaman Verifikasi LLK terbuka. Menerapkan filter Belum Terverifikasi…',{url:page.url()});
    if(!/^\/verifikasi(?:\/|$)/i.test(new URL(page.url()).pathname))throw new HttpError(401,`Menu Verifikasi LLK gagal dibuka; URL ${page.url()}`);
    const statusControl=page.locator('input[name="status"][value="1"], select[name="status"]').first();
    if(!await statusControl.count())throw new Error('Kontrol filter status verifikasi tidak ditemukan');
    if(await statusControl.evaluate(node=>node.tagName==='SELECT'))await statusControl.selectOption('1');
    else await statusControl.check({force:true});
    const byControl=page.locator('input[name="by"][value="nip"], select[name="by"]').first();
    if(await byControl.count()){
      if(await byControl.evaluate(node=>node.tagName==='SELECT'))await byControl.selectOption('nip');
      else await byControl.check({force:true});
    }
    const searchButton=page.locator('button,input[type="submit"]').filter({hasText:/Cari|Search/i}).first();
    if(!await searchButton.count())throw new Error('Tombol Cari verifikasi tidak ditemukan');
    progress(id,'filter-submit','Tombol Cari diklik. Menunggu navigasi hasil filter sampai DOM siap…',{url:page.url()});
    await searchButton.click({noWaitAfter:true});
    await page.waitForLoadState('domcontentloaded',{timeout:60000}).catch(error=>{throw new Error(`Halaman hasil filter belum siap setelah 60 detik: ${error.message}`);});
    progress(id,'filter-table','DOM hasil filter siap. Menunggu tabel hasil hingga 60 detik…',{url:page.url(),readyState:await page.evaluate(()=>document.readyState)});
    await page.locator('table').first().waitFor({state:'visible',timeout:60000});
    const appliedFilter=await page.evaluate(()=>{
      const status=document.querySelector('input[name="status"]:checked,select[name="status"]');
      const by=document.querySelector('input[name="by"]:checked,select[name="by"]');
      return {status:status?.value||'',by:by?.value||'',url:location.href};
    });
    const appliedUrl=new URL(appliedFilter.url);
    if(appliedFilter.status!=='1'||appliedFilter.by!=='nip'||appliedUrl.searchParams.get('status')!=='1'||appliedUrl.searchParams.get('by')!=='nip')throw new Error(`Filter belum diterapkan: status=${appliedFilter.status||'kosong'}, berdasarkan=${appliedFilter.by||'kosong'}, URL=${appliedFilter.url}`);
    progress(id,'filter','Filter Belum Terverifikasi dan pencarian berdasarkan NIP telah terbukti aktif.',appliedFilter);
    await page.locator('table').first().waitFor({state:'visible',timeout:15000}).catch(()=>{});
    await page.waitForTimeout(750);
    if(!llkLocation(page.url()).authenticated)throw new HttpError(401,'Sesi LLK kedaluwarsa; login ulang diperlukan');
    const rows=[],visited=new Set();
    for(let pageNum=1;pageNum<=100;pageNum++){
      const currentUrl=page.url();
      if(visited.has(currentUrl))break;
      visited.add(currentUrl);
      let pageRows;
      progress(id,'page',`Memindai halaman verifikasi ${pageNum}…`,{page:pageNum,url:currentUrl});
      for(let attempt=0;attempt<5;attempt++){
        try{
          pageRows=await page.evaluate(()=>{
            const text=node=>String(node?.textContent||'').replace(/\s+/g,' ').trim();
            return [...document.querySelectorAll('a[href*="/verifikasi/edit?cid="]')].map(link=>{
              const outerRow=link.closest('tr'),detailCell=Array.from(outerRow?.cells||[]).find(cell=>cell.querySelector('table')),nested=detailCell?.querySelector('table');
              const header=text(detailCell?.querySelector('div'));
              const rawDate=(header.match(/Tanggal Kegiatan\s*:\s*([^,]+)/i)||[])[1]||'';
              const activities=Array.from(nested?.tBodies[0]?.rows||[]).map(row=>{const cells=Array.from(row.cells||[]).map(text),times=(cells[1]||'').match(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/g)||[];return {start:times[0]||'',end:times[1]||'',description:cells[3]||'',type:cells[4]||'',result:cells[5]||''};}).filter(item=>item.start&&item.end);
              return {editUrl:link.href,summary:text(outerRow).slice(0,500),rawDate,activities};
            });
          });
          break;
        }catch(error){if(!/Execution context was destroyed|navigation/i.test(error.message)||attempt===4)throw error;await page.waitForTimeout(1000);}
      }
      rows.push(...(pageRows||[]));
      progress(id,'page-result',`Halaman ${pageNum}: ${(pageRows||[]).length} target terbaca.`,{page:pageNum,rowsFound:(pageRows||[]).length});
      const next=page.locator('ul.pagination li:not(.disabled):not(.active) a[rel="next"], ul.pagination li:not(.disabled):not(.active) a').filter({hasText:/^(?:Next|Berikut|›|»|\d+)$/i}).last();
      if(!await next.count())break;
      const href=await next.getAttribute('href');
      if(!href||visited.has(new URL(href,page.url()).href))break;
      await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),next.click()]);
    }
    const uniqueRows=[...new Map(rows.map(row=>[row.editUrl,row])).values()];
    const dateCounts=new Map();
    progress(id,'validate',`Ditemukan ${uniqueRows.length} target. Memvalidasi tanggal, jam akhir, dan deskripsi…`,{rowsFound:uniqueRows.length,pagesScanned:visited.size});
    for(const row of uniqueRows){
      if(!row.rawDate)row.rawDate=(row.summary.match(/Tanggal Kegiatan\s*:\s*([^,]+)/i)||[])[1]||'';
      row.date=normalizeOfficialDate(row.rawDate);
      if(!row.activities?.length){const times=row.summary.match(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/g)||[];row.activities=times.length>=2?[{start:times[0],end:times.at(-1),description:(row.summary.match(/\d+\s+[^\s]+\s+-\s+[^\s]+\s+\d+\s+(.+?)\s+(?:Utama|Pendukung)\b/i)||[])[1]||''}]:[];}
      if(row.date)dateCounts.set(row.date,(dateCounts.get(row.date)||0)+1);
    }
    for(const row of uniqueRows){
      const issues=[];
      if(!row.date)issues.push(`Tanggal kegiatan tidak terbaca dari: ${row.rawDate||'kosong'}`);
      else if(dateCounts.get(row.date)>1)issues.push(`Tanggal duplikat: ${row.date}`);
      const end=row.activities?.at(-1)?.end||'';
      const dow=row.date?parseDate(row.date).getDay():null,expectedEnd=dow===5?'17:00':dow>=1&&dow<=4?'16:30':null;
      if(!row.activities?.length)issues.push('Rincian kegiatan tidak terbaca dari tabel target');
      else if(expectedEnd&&end!==expectedEnd)issues.push(`Jam akhir ${end||'tidak terbaca'}; seharusnya ${expectedEnd}`);
      const work=row.activities?.filter(item=>!/^istirahat$/i.test(clean(item.description)))||[];
      if(row.activities?.length&&!work.length)issues.push('Deskripsi kegiatan hanya berisi Istirahat');
      else if(work.some(item=>!clean(item.description)||clean(item.description).length<4))issues.push('Deskripsi kegiatan belum benar atau tidak terbaca');
      row.valid=issues.length===0;row.issues=issues;
    }
    const validRows=uniqueRows.filter(row=>row.valid),invalidRows=uniqueRows.filter(row=>!row.valid);
    if(!extractIds){
      const preview=uniqueRows.map(row=>({date:row.date,summary:row.summary,editUrl:row.editUrl,activities:row.activities,valid:row.valid,issues:row.issues}));
      progress(id,'preview',`Validasi selesai: ${validRows.length} siap, ${invalidRows.length} belum benar.`,{validCount:validRows.length,invalidCount:invalidRows.length});
      preview.pagesScanned=visited.size;preview.rowsFound=uniqueRows.length;preview.validCount=validRows.length;preview.invalidCount=invalidRows.length;
      return preview;
    }
    if(!validRows.length)return Object.assign([],{pagesScanned:visited.size,rowsFound:uniqueRows.length,validCount:0,invalidCount:invalidRows.length,invalidTargets:invalidRows});
    const extracted=[];
    for(const [index,row] of validRows.entries()){
      const started=Date.now();progress(id,'target-fetch',`Membaca ID target ${index+1}/${validRows.length}…`,{target:index+1,totalTargets:validRows.length,date:row.date});
      let hllk='',response,title='',lastError;
      for(let attempt=1;attempt<=2&&!hllk;attempt++){
        try{
          response=await page.goto(row.editUrl,{waitUntil:'domcontentloaded',referer:verificationListUrl(),timeout:60000});
          hllk=await page.locator('input[name="hllk"]').first().inputValue({timeout:5000}).catch(()=>''),title=clean(await page.title().catch(()=>''));
          if(!/^[0-9]+$/.test(hllk))hllk='';
        }catch(error){lastError=error;if(attempt<2)await page.waitForTimeout(1000);}
      }
      if(hllk)extracted.push({target:{hllk,date:row.date,summary:row.summary,editUrl:row.editUrl,activities:row.activities,valid:true,issues:[]}});
      else{const formNames=await page.locator('input[name],select[name],textarea[name]').evaluateAll(nodes=>nodes.map(node=>node.name)).catch(()=>[]),errorDetail=lastError?`${/timeout/i.test(lastError.message)?'Timeout setelah 2 percobaan':'Fetch halaman edit gagal'}: ${lastError.message}`:`ID hllk tidak ditemukan; HTTP ${response?.status()||'tanpa respons'}, halaman "${title||'tanpa judul'}", URL akhir ${page.url()}, field: ${[...new Set(formNames)].slice(0,12).join(', ')||'tidak ada'}`;extracted.push({failure:{...row,valid:false,issues:[`${errorDetail} (${Date.now()-started} ms)`]}});}
    }
    const targets=extracted.map(item=>item.target).filter(Boolean),idFailures=extracted.map(item=>item.failure).filter(Boolean);
    const uniqueTargets=[...new Map(targets.map(item=>[item.hllk,item])).values()];
    uniqueTargets.pagesScanned=visited.size;uniqueTargets.rowsFound=uniqueRows.length;uniqueTargets.validCount=uniqueTargets.length;uniqueTargets.invalidCount=invalidRows.length+idFailures.length;uniqueTargets.invalidTargets=[...invalidRows,...idFailures];
    progress(id,'complete',`Pemindaian selesai: ${uniqueTargets.length} target siap, ${uniqueTargets.invalidCount} ditahan.`,{validCount:uniqueTargets.length,invalidCount:uniqueTargets.invalidCount,pagesScanned:visited.size});
    return uniqueTargets;
  } catch(error){
    const message=verificationErrorMessage(error);
    if(message!==clean(error?.message||error))throw new HttpError(409,message);
    progress(id,'error',`Pemindaian gagal: ${message}`);
    throw error;
  }
}

const verificationListUrl=()=>`${LLK_BASE}/verifikasi?start_date=&end_date=&status=1&by=nip&q=`;
async function runAutomaticVerification(id,input) {
  const message=clean(input.message),stage=stagedVerification.get(id);
  if(!message)bad('Pesan verifikasi wajib diisi');
  if(!stage||stage.expires<Date.now()||stage.token!==clean(input.stageToken))throw new HttpError(409,'Hasil pemindaian sudah kedaluwarsa. Pindai ulang sebelum verifikasi.');
  const selected=new Set(Array.isArray(input.hllk)?input.hllk.map(String):[]),targets=selected.size?stage.targets.filter(item=>selected.has(item.hllk)):stage.targets;
  if(!targets.length)bad('Tidak ada LLK berstatus Belum Diverifikasi');
  const results=[];
  try {
    for(const [index,target] of targets.entries()){
      progress(id,'verify-target',`Memverifikasi ${index+1}/${targets.length} dari hasil filter yang sama…`,{target:index+1,totalTargets:targets.length,hllk:target.hllk,date:target.date});
      try {
        const page=stage.context.pages()[0]??await stage.context.newPage();
        await page.goto(target.editUrl,{waitUntil:'domcontentloaded',referer:stage.filter.url,timeout:60000});
        const form=page.locator('form[action*="/verifikasi/update"]').first();
        if(!await form.count())throw new Error('Form verifikasi tidak ditemukan pada LLK target');
        const submitted=await Promise.all([page.waitForLoadState('domcontentloaded',{timeout:30000}).catch(()=>{}),form.evaluate((node,note)=>{const set=(name,value)=>{const field=node.querySelector(`[name="${name}"]`);if(!field)return false;field.value=value;field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));return true;};if(!set('note',note)||!set('verified','2'))throw new Error('Kolom catatan atau status verifikasi tidak ditemukan');node.requestSubmit();},message)]);
        if(!llkLocation(page.url()).authenticated)throw new Error('Sesi LLK kedaluwarsa saat mengirim verifikasi');
        results.push({hllk:target.hllk,date:target.date,status:200,success:true,url:page.url()});
      } catch(error) { results.push({hllk:target.hllk,date:target.date,status:0,success:false,error:verificationErrorMessage(error)}); }
    }
    await audit('verification.auto',id,{message,targetIds:targets.map(item=>item.hllk),filter:stage.filter},{counts:{total:results.length,success:results.filter(item=>item.success).length},result:'completed'});
    return {total:results.length,success:results.filter(item=>item.success).length,failed:results.filter(item=>!item.success).length,results,filter:stage.filter};
  } finally { closeVerificationStage(id); }
}

async function archivePersonal(id,current){if(!current)return;const dir=personalHistoryDir(id);await mkdir(dir,{recursive:true});await saveJson(join(dir,`${String(current.version||0).padStart(6,'0')}-${Date.now()}.json`),current);await rotateFiles(dir,'');}
async function applyPersonal(id,input){const stage=stagedPersonal.get(id);if(!stage||stage.expires<Date.now()||input.stageToken!==stage.token||input.confirm!==id)throw new HttpError(409,'Stage token atau konfirmasi tidak cocok');const current=await readPersonal(id);await archivePersonal(id,current);await saveJson(personalFile(id),stage.candidate);stagedPersonal.delete(id);await audit('personal-template.apply',id,{employeeId:id,digest:stage.digest},{counts:{activities:stage.candidate.activities.length},result:'applied'});return personalResponse(await findEmployee(id));}
async function resetPersonal(id,input){if(input.confirm!==id)bad('Konfirmasi ID pegawai wajib sama');await findEmployee(id);const current=await readPersonal(id);if(current){await archivePersonal(id,current);await rm(personalFile(id),{force:true});}stagedPersonal.delete(id);await audit('personal-template.reset',id,{employeeId:id},{result:'reset'});return personalResponse(await findEmployee(id));}

async function api(req,res,url) {
  const path=url.pathname;
  if(req.method==='GET'&&path==='/api/progress'){const id=safeId(url.searchParams.get('employeeId')),since=Math.max(0,Number(url.searchParams.get('since'))||0);return json(res,200,progressState(id,since));}
  if(req.method==='GET'&&path==='/api/calendar/2026')return json(res,200,{year:2026,source:'SKB 3 Menteri',days:SKB_2026_DAYS});
  if(req.method==='GET'&&path==='/api/employees')return json(res,200,await getEmployees());
  if(req.method==='GET'&&path==='/api/templates')return json(res,200,await templateSnapshot());
  if(req.method==='DELETE'&&path.startsWith('/api/profiles/')){const id=safeId(decodeURIComponent(path.slice('/api/profiles/'.length))),input=await bodyJson(req);if(input.confirm!==id)bad('Konfirmasi ID pegawai wajib sama');if(locks.has(id))throw new HttpError(409,'Profil sedang digunakan');await rm(profilePath(id),{recursive:true,force:true});await audit('profile.delete',id,{employeeId:id},{result:'deleted'});return json(res,200,{deleted:true,employeeId:id});}
  if(req.method==='POST'&&path==='/api/verification/run'){const input=await bodyJson(req),id=safeId(input.employeeId);return json(res,200,await runAutomaticVerification(id,input));}
  if(req.method==='GET'&&path==='/api/verification/preview'){const id=safeId(url.searchParams.get('employeeId')),{context}=await launchEmployee(id,true);try{const targets=await verificationTargets(id,context),stage=stageVerification(id,context,targets,{status:'1',by:'nip',url:verificationListUrl(),pagesScanned:targets.pagesScanned||1,rowsFound:targets.rowsFound??targets.length});return json(res,200,{stageToken:stage.token,targets,total:targets.length,pagesScanned:targets.pagesScanned||1,rowsFound:targets.rowsFound??targets.length,validCount:targets.validCount??targets.length,invalidCount:targets.invalidCount||0,invalidTargets:targets.invalidTargets||[],filter:stage.filter});}catch(error){await context.close().catch(()=>{});throw error;}}
  if(req.method==='POST'&&path==='/api/bootstrap/login'){
    const input=await bodyJson(req);
    const supervisorNip=employeeId(input.supervisorNip);
    if(!supervisorNip)bad('NIP atasan wajib diisi');
    const satker=clean(input.satker)||'Satker Lain';
    const {employee,context,tempId}=await launchExternalBootstrap(satker,supervisorNip,input.department);
    const flow={employee,context,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+LOGIN_FLOW_TTL).toISOString(),closing:false};
    loginFlows.set(tempId,flow);
    flow.timer=setTimeout(()=>closeLoginFlow(tempId,flow),LOGIN_FLOW_TTL);
    const page=context.pages()[0]??await context.newPage();
    await page.goto(LLK_BASE,{waitUntil:'domcontentloaded'});
    return json(res,200,{tempId,message:'Browser login dibuka. Silakan login akun LLK Anda.'});
  }
  if(req.method==='GET'&&path==='/api/bootstrap/status'){
    const active=[...loginFlows.entries()].filter(([id,flow])=>id.startsWith('temp-')&&!flow.closing).map(([tempId,flow])=>({tempId,authenticated:Boolean(authenticatedLlkPage(flow.context)),actualNip:flow.actualNip||null,fetchedAt:flow.fetchedAt||null,createdAt:flow.createdAt,expiresAt:flow.expiresAt}));
    return json(res,200,{active});
  }
  if(req.method==='POST'&&path==='/api/bootstrap/complete'){
    const input=await bodyJson(req),tempId=safeId(input.tempId);
    let flow=loginFlows.get(tempId);
    if(!flow)flow=[...loginFlows.entries()].find(([id,f])=>id.startsWith('temp-')&&!f.closing&&authenticatedLlkPage(f.context))?.[1]||null;
    if(!flow){
      const supervisorNip=employeeId(input.supervisorNip);
      const employees=await getEmployees();
      let recovered=null;
      for(const emp of employees){
        const cookies=await loadSessionCookies(emp.id);
        if(!cookies?.length)continue;
        const {context}=await launchEmployee(emp.id,true);
        const page=context.pages()[0]??await context.newPage();
        await page.goto(LLK_BASE,{waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});
        if(llkLocation(page.url()).authenticated){recovered={employee:emp,context};break;}
        await context.close();
      }
      if(!recovered)throw new HttpError(401,'Sesi LLK tidak ditemukan dari cookie tersimpan. Buka SSO dari profil aktif dan login sekali lagi.');
      flow={employee:recovered.employee,context:recovered.context,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+LOGIN_FLOW_TTL).toISOString(),closing:false,recovered:true};
      loginFlows.set(tempId,flow);
    }
    return json(res,200,await completeExternalBootstrap(tempId,flow.employee,flow.context));
  }
  const employeeRoute = path.match(/^\/api\/employees\/([^/]+)\/(.+)$/);
  if (!employeeRoute) return json(res,404,{error:'Endpoint tidak ditemukan'});
  const id = safeId(decodeURIComponent(employeeRoute[1]));
  const action = employeeRoute[2];
  if(action==='personal-template'&&req.method==='GET')return json(res,200,await personalResponse(await findEmployee(id)));
  if (action === 'preview' && req.method === 'POST') {
    const input = await bodyJson(req);
    return json(res, 200, await withLock(id, async () => {
      const employee = await findEmployee(id), { context } = await launchEmployee(id);
      try {
        const source = input.source === 'general' ? 'general' : 'page';
        progress(id, 'preview-start', `Menyiapkan isian ${input.start} sampai ${input.end}…`);
        const page = context.pages()[0] ?? await context.newPage();
        progress(id, 'preview-llk', 'Membaca pola jadwal dan kegiatan LLK sebelumnya…');
        const entries = await scrapeEntries(context, page);
        const pageActivities = source === 'page'
          ? [...new Map(entries.filter(entry => !entry.isBreak).map(item => [canonical({ description: item.description, type: item.type }), item])).values()]
          : [];
        progress(id, 'preview-llk-done', `LLK sebelumnya terbaca: ${entries.length} baris.`);
        return generatePreview(employee, input.start, input.end, source, input.department, pageActivities, entries);
      } finally {
        await context.close();
      }
    }));
  }
  if (action === 'personal-template/apply' && req.method === 'POST') return json(res, 200, await applyPersonal(id, await bodyJson(req)));
  if (action === 'personal-template' && req.method === 'DELETE') return json(res, 200, await resetPersonal(id, await bodyJson(req)));
  if (action === 'login/status' && req.method === 'GET') {
    const flow = loginFlows.get(id);
    if (!flow || flow.closing) return json(res, 200, { active: false });
    const pages = await pageDiagnostics(flow.context), authenticated = Boolean(authenticatedLlkPage(flow.context));
    return json(res, 200, { active: true, authenticated, createdAt: flow.createdAt, expiresAt: flow.expiresAt, pages });
  }
  if (action === 'login/complete' && req.method === 'POST') return json(res, 200, await completeLogin(id));
  if (action === 'login/cancel' && req.method === 'POST') return json(res, 200, { active: false, cancelled: await closeLoginFlow(id) });
  if (action === 'login' && req.method === 'POST') return json(res, 200, await openLogin(id));
  if (action === 'personal-template/import' && req.method === 'POST') return json(res, 200, await withLock(id, () => importPersonal(id)));
  if (action === 'session/status' && req.method === 'GET') {
    const flow = loginFlows.get(id);
    if (flow && !flow.closing) return json(res, 200, { authenticated: Boolean(authenticatedLlkPage(flow.context)), source: 'active-login' });
    const { context } = await launchEmployee(id, true);
    try {
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(LLK_BASE, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      return json(res, 200, { authenticated: llkLocation(page.url()).authenticated, source: 'saved-session' });
    } finally {
      await context.close();
    }
  }
  if (action === 'submit' && req.method === 'POST') {
    const input = await bodyJson(req);
    const report = await withLock(id, () => submitPreview(id, input.preview, input.duplicatePolicy));
    await audit('submit', id, input.preview, { counts: { submitted: report.success, failed: report.failed }, result: 'completed' });
    return json(res, 200, sanitize(report));
  }
  return json(res,405,{error:'Metode tidak didukung'});
}

const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json'};
await mkdir(DATA,{recursive:true,mode:0o700}); await mkdir(PROFILE_ROOT,{recursive:true,mode:0o700}); await mkdir(personalTemplateRoot,{recursive:true,mode:0o700}); await mkdir(personalHistoryRoot,{recursive:true,mode:0o700});
for(const entry of await readdir(PROFILE_ROOT).catch(()=>[]))if(entry.startsWith('temp-'))await rm(join(PROFILE_ROOT,entry),{recursive:true,force:true}).catch(()=>{});
if(process.platform!=='win32')await Promise.all([chmod(DATA,0o700),chmod(PROFILE_ROOT,0o700)]);
const server = createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      let decoded;
      try { decoded = decodeURIComponent(url.pathname); } catch { bad('Path tidak valid'); }
      const file = resolve(PUBLIC, decoded === '/' ? 'index.html' : decoded.slice(1)), rel = relative(PUBLIC, file);
      if (rel.startsWith('..') || isAbsolute(rel)) throw new HttpError(403, 'Akses ditolak');
      res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' });
      res.end(await readFile(file));
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, { error: error.message || 'Permintaan gagal' });
      else if (!res.writableEnded) res.end();
    }
  })().catch(error => {
    console.error('Unhandled request failure:', error);
    if (!res.headersSent) json(res, 500, { error: 'Permintaan gagal diproses' });
    else if (!res.writableEnded) res.end();
  });
});
server.listen(PORT,'127.0.0.1',()=>console.log(`LLK Agent PN Natuna: http://127.0.0.1:${PORT}`));
let stopping=false;const shutdown=async()=>{if(stopping)return;stopping=true;await Promise.all([...loginFlows].map(([id,flow])=>closeLoginFlow(id,flow)));for(const id of stagedVerification.keys())closeVerificationStage(id);server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),10_000).unref();};
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
