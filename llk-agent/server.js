import { createServer } from 'node:http';
import { readFile, writeFile, rename, mkdir, appendFile, chmod, rm, readdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, extname, relative, isAbsolute } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';

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
const templateHistoryRoot = join(DATA, 'template-history');
const settingsFile = join(DATA, 'settings.json');
const holidayFile = join(DATA, 'holidays.json');
const auditFile = join(DATA, 'audit.jsonl');
const personalTemplateRoot = join(DATA, 'personal-templates');
const verificationRecordingFile = join(DATA, 'verification-recording.json');
const verificationScanRecordingFile = join(DATA, 'verification-scan-recording.json');
const personalHistoryRoot = join(DATA, 'personal-template-history');
const personalFile = id => join(personalTemplateRoot, `${safeId(id)}.json`);
const personalHistoryDir = id => join(personalHistoryRoot, safeId(id));
const MAX_HISTORY = 20;
const sensitiveKeys = /password|cookie|csrf|token|secret|authorization/i;
const locks = new Set();
let stagedRoster;
const stagedPersonal = new Map();
const operationProgress=new Map();
function progress(id,stage,message,detail={}){const current=operationProgress.get(id)||{sequence:0,events:[]};const event={sequence:++current.sequence,at:new Date().toISOString(),stage,message,...sanitize(detail)};current.events.push(event);if(current.events.length>100)current.events.shift();current.active=!['complete','error'].includes(stage);current.latest=event;operationProgress.set(id,current);return event;}
function progressState(id,since=0){const current=operationProgress.get(id)||{sequence:0,events:[],active:false,latest:null};return {active:current.active,sequence:current.sequence,latest:current.latest,events:current.events.filter(event=>event.sequence>since)};}
const supervisorLookups=new Map();
async function googleSupervisorLookup(rawNip){
  const nip=employeeId(rawNip);if(!/^\d{18}$/.test(nip))bad('NIP atasan harus tepat 18 digit');
  const spaced=`${nip.slice(0,8)} ${nip.slice(8,14)} ${nip.slice(14,15)} ${nip.slice(15)}`,query=`${nip} OR "${spaced}"`,sourceUrl=`https://www.google.com/search?client=firefox-b-d&hl=id&filter=0&pws=0&q=${encodeURIComponent(query)}`;
  const context=await chromium.launchPersistentContext(join(PROFILE_ROOT,'google-search'),{channel:'msedge',headless:false,locale:'id-ID',viewport:null});
  let blocks=[];
  try{
    const page=context.pages()[0]??await context.newPage();await page.goto(sourceUrl,{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForSelector('a h3',{timeout:30000}).catch(()=>{});if(!await page.locator('a h3').count()){const body=await page.locator('body').innerText().catch(()=>'');throw new HttpError(502,/unusual traffic|bukan robot|not a robot|captcha/i.test(body)?'Google meminta verifikasi CAPTCHA. Selesaikan CAPTCHA pada jendela Edge sebelum 30 detik habis, atau klik Cari NIP lagi; sesi verifikasi disimpan.':'Google tidak menampilkan hasil pencarian. Buka tautan Google dan periksa koneksi atau pembatasan akses.');}
    blocks=await page.locator('a:has(h3)').evaluateAll((links,nip)=>links.slice(0,5).map(link=>{const container=link.closest('[data-snhf],[data-sncf],div.MjjYud,div.g')||link.parentElement?.parentElement;const text=String(container?.innerText||'').replace(/\s+/g,' ').trim();return {title:String(link.querySelector('h3')?.textContent||'').trim(),url:link.href,snippet:text.replace(String(link.querySelector('h3')?.textContent||''),'').replace(nip,'').trim().slice(0,700)};}),nip);
  }finally{await context.close();}
  const classify=item=>{const text=`${item.title} ${item.snippet}`.replace(/\s+/g,' ').trim(),name=(text.match(/(?:Nama|Nama Pegawai)\s*[:\-]\s*([A-Z][A-Za-zÀ-ÿ.' ,]{3,80})/i)||text.match(/\b([A-Z][A-ZÀ-Ÿ.' ]{5,80}(?:,\s*[A-Z.]+)?)\b/))?.[1]?.trim()||'',position=(text.match(/(?:Jabatan|Posisi)\s*[:\-]\s*([^|;]{3,100})/i)||text.match(/\b(Sekretaris|Panitera(?: Muda)?|Hakim|Analis[^,;|]{0,70}|Kepala Sub Bagian[^,;|]{0,70}|Kasubbag[^,;|]{0,70})\b/i))?.[1]?.trim()||'',satker=(text.match(/(?:Satuan Kerja|Satker)\s*[:\-]\s*([^|;]{3,120})/i)||text.match(/\b((?:Pengadilan Negeri|Pengadilan Tinggi|Mahkamah Agung|Pengadilan Agama|Pengadilan Tata Usaha Negara)\s+[A-Za-zÀ-ÿ ]{2,60})\b/i))?.[1]?.trim()||'';return {...item,name:name||null,position:position||null,satker:satker||null};};
  const results=blocks.filter(item=>item.title&&/^https?:/i.test(item.url)).slice(0,5).map(classify),token=randomBytes(16).toString('hex'),result={nip,query:`"${nip}"`,sourceUrl,results,found:results.length>0,token,checkedAt:new Date().toISOString()};
  supervisorLookups.set(token,{nip,expires:Date.now()+10*60*1000});return result;
}
async function getSettings() {
  if (existsSync(settingsFile)) {
    try { return await readJson(settingsFile); } catch {}
  }
  return { satker: 'Pengadilan Negeri Natuna', customSatker: '' };
}
async function saveSettings(data) {
  const current = await getSettings();
  const next = { ...current, ...data };
  await saveJson(settingsFile, next);
  return next;
}
const loginFlows = new Map();
const sessionCookies = new Map();
let verificationRecording = null;
let verificationScanRecording = null;
let navigationRecording = null;
const LOGIN_FLOW_TTL = 10 * 60_000;
const ROSTER_URLS = [
  'https://pn-natuna.go.id/profil-pengadilan/profil-hakim',
  'https://pn-natuna.go.id/profil-pengadilan/profil-kepaniteraan',
  'https://pn-natuna.go.id/profil-pengadilan/profil-kesekretariatan'
];
async function getHolidayObject() {
  if (existsSync(holidayFile)) {
    try {
      const data = await readJson(holidayFile);
      if (Array.isArray(data)) return { "2026": data.map(clean).filter(Boolean) };
      if (data && typeof data === 'object') return data;
    } catch {}
  }
  return { "2026": ['2026-01-01','2026-01-16','2026-02-16','2026-02-17','2026-03-18','2026-03-19','2026-03-20','2026-03-21','2026-03-22','2026-03-23','2026-03-24','2026-04-03','2026-04-05','2026-05-01','2026-05-14','2026-05-15','2026-05-27','2026-05-28','2026-05-31','2026-06-01','2026-06-16','2026-08-17','2026-08-25','2026-12-24','2026-12-25'] };
}
async function getHolidays() {
  const obj = await getHolidayObject();
  return new Set(Object.values(obj).flat().map(clean).filter(Boolean));
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
  const { first, last } = validateRange(start, end), holidays = await getHolidays(), days = [];
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
  if(headless){const browser=await chromium.launch({channel:'msedge',headless:true});context=await browser.newContext({viewport:{width:1365,height:768}});context.on('close',()=>browser.close().catch(()=>{}));}
  else context=await chromium.launchPersistentContext(dir,{channel:'msedge',headless:false,viewport:null});
  const cookies = await loadSessionCookies(id);
  if (cookies?.length) await context.addCookies(cookies);
  return { employee, context };
}
async function closeLoginFlow(id, flow = loginFlows.get(id)) {
  if (!flow || flow.closing) return false;
  flow.closing = true; clearTimeout(flow.timer); loginFlows.delete(id); locks.delete(id);
  try { await flow.context.close(); } catch {}
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
async function verifyLogin(id) {
  const { context } = await launchEmployee(id);
  try {
    const page = await context.newPage();
    await page.goto(LLK_BASE, { waitUntil: 'domcontentloaded' });
    const auth = llkLocation(page.url()).authenticated;
    if (!auth) return { loggedIn: false };
    await discoverLlkRoutes(page);
    return { loggedIn: true, stage: 'authenticated-root' };
  } finally { await context.close(); }
}
async function generatePreview(employee, start, end, department) {
  if (!employee) throw new HttpError(404, 'Pegawai tidak ditemukan');
  const personal = await readPersonal(employee.id), stored = await readJson(templateFile), templates = stored.departments || stored;
  const selectedDepartment = clean(department) || employee.department;
  if (!templates[selectedDepartment]) bad('Template bagian tidak tersedia');
  const activities = selectedDepartment === employee.department && personal?.activities?.length ? personal.activities : templates[selectedDepartment].activities;
  if (!activities?.length) bad('Template jabatan/bagian belum tersedia');
  let index = 0;
  return (await workdays(start, end)).map(day => { const first = activities[index++ % activities.length], second = activities[index++ % activities.length], friday = day.dow === 5; const item=a=>({description:a.nama,type:a.kategori||'Pendukung',result:a.result||a.keterangan||'Selesai',...(a.output?{output:a.output}:{})}); return { date: day.iso, supervisor: employee.supervisor, items: [
    {...item(first),start:first.start||'08:00',end:first.end||'12:00'},
    { start:'12:00', end:friday ? '13:30':'13:00', description:'Istirahat', type:'Pendukung', result:'Selesai' },
    {...item(second),start:second.start||(friday?'13:30':'13:00'),end:second.end||(friday?'17:00':'16:30')}
  ] }; });
}
function minute(value) { if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) bad('Jam kegiatan tidak valid'); const [h,m] = value.split(':').map(Number); return h * 60 + m; }
async function validatePreview(preview) {
  if (!Array.isArray(preview) || !preview.length || preview.length > 31) bad('Preview wajib berisi kegiatan');
  const seen = new Set(), holidays = await getHolidays();
  return preview.map((day, dayIndex) => {
    if (!day || typeof day !== 'object' || seen.has(day.date)) bad('Tanggal preview duplikat atau tidak valid'); seen.add(day.date);
    const date = parseDate(day.date), iso = localIso(date), dow = date.getDay();
    if (iso !== day.date || dow === 0 || dow === 6 || holidays.has(iso)) bad(`Tanggal ${day.date} bukan hari kerja`);
    if (!Array.isArray(day.items) || !day.items.length || day.items.length > 12) bad(`Kegiatan ${day.date} tidak valid`);
    const close = dow === 5 ? 17 * 60 : 16 * 60 + 30; let cursor = 8 * 60;
    const items = day.items.map((item, itemIndex) => {
      if (!item || typeof item !== 'object') bad(`Baris ${itemIndex + 1} tidak valid`);
      const start = clean(item.start), end = clean(item.end), from = minute(start), to = minute(end);
      const description = clean(item.description), type = clean(item.type), result = clean(item.result);
      if (from !== cursor || to <= from || !description || description.length > 2000 || !result || result.length > 500 || !['Utama','Pendukung'].includes(type)) bad(`Susunan waktu/kegiatan ${day.date} tidak valid`);
      cursor = to; return { start, end, description, type, result };
    });
    if (cursor !== close) bad(`Kegiatan ${day.date} harus mencakup jam kerja tanpa celah`);
    return { date: iso, items };
  });
}
function pageDiagnostic(page){try{const url=new URL(page.url());return {origin:url.origin,pathname:url.pathname,title:''};}catch{return {origin:'null',pathname:'',title:''};}}
async function pageDiagnostics(context){return Promise.all(context.pages().map(async page=>({...pageDiagnostic(page),title:clean(await page.title().catch(()=>''))})));}
function llkLocation(value){try{const url=value instanceof URL?value:new URL(value);return {url,sameOrigin:url.origin===LLK_BASE,authenticated:url.origin===LLK_BASE&&!/^\/(?:sso|login)(?:\/|$)/i.test(url.pathname)};}catch{return {url:null,sameOrigin:false,authenticated:false};}}
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
    const targetHref = await llkMenu.getAttribute('href');
    await llkMenu.click();
    await page.waitForURL(url => url.origin === LLK_BASE && /\/llk(?:\/|$|\?)/i.test(url.pathname + url.search), { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.locator('table').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    if (!/\/llk(?:\/|$)/i.test(new URL(page.url()).pathname)) {
      const empty = [];
      empty.available = false;
      empty.warning = `Klik menu LLK tidak membuka daftar LLK${targetHref ? ` (${targetHref})` : ''}.`;
      return empty;
    }
    const sourceUrl = page.url();
    const entries = await page.evaluate(() => {
      const cleanText = value => String(value || '').replace(/\s+/g, ' ').trim();
      const output = [];
      const outerTable = Array.from(document.querySelectorAll('table')).find(table => Array.from(table.tBodies[0]?.rows || []).some(row => Array.from(row.cells || []).some(cell => cell.querySelector('table'))));
      if (!outerTable) return output;
      for (const outerRow of Array.from(outerTable.tBodies[0]?.rows || [])) {
        const detailCell = Array.from(outerRow.cells).find(cell => cell.querySelector('table'));
        const nestedTable = detailCell?.querySelector('table');
        if (!detailCell || !nestedTable) continue;
        const headerText = cleanText(detailCell.querySelector('div')?.textContent || '');
        const rawDate = (headerText.match(/Tanggal Kegiatan\s*:\s*([^,]+)/i) || [])[1] || '';
        for (const row of Array.from(nestedTable.tBodies[0]?.rows || [])) {
          const cells = Array.from(row.cells).map(cell => cleanText(cell.textContent));
          if (cells.length < 6) continue;
          const times = cells[1]?.match(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/g) || [];
          if (times.length < 2 || !cells[3] || /^istirahat$/i.test(cells[3])) continue;
          output.push({rawDate,start:times[0],end:times[1],description:cells[3],type:/^(Utama|Pendukung)$/i.test(cells[4])?cells[4]:'Pendukung',result:cells[5]||'Selesai'});
        }
      }
      return output;
    });
    const normalized = entries.map(entry => ({ ...entry, date: normalizeOfficialDate(entry.rawDate) })).filter(entry => entry.date);
    normalized.sort((a,b) => b.date.localeCompare(a.date));
    normalized.available = true;
    normalized.sourceUrl = sourceUrl;
    normalized.pagesScanned = 1;
    return normalized;
  } finally {
    if (owned) await page.close();
  }
}
const entryKey=e=>canonical({date:e.date,start:clean(e.start),end:clean(e.end),description:clean(e.description),type:clean(e.type).replace(/^primary$/i,'Utama').replace(/^support$/i,'Pendukung'),result:clean(e.result)});
async function auditEntries(id){const {context}=await launchEmployee(id);try{const entries=await scrapeEntries(context),counts=Object.create(null);entries.forEach(entry=>counts[entry.date]=(counts[entry.date]||0)+1);return {total:entries.length,unique:Object.keys(counts).length,dates:[...new Set(entries.map(e=>e.date))].sort(),duplicates:Object.entries(counts).filter(([,count])=>count>1).map(([date,count])=>({date,count}))};}finally{await context.close();}}
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
    const existing=new Set((await scrapeEntries(context)).map(entryKey)), duplicates=preview.filter(day=>day.items.every(item=>existing.has(entryKey({...item,date:day.date})))).map(day=>day.date);
    if (duplicates.length && policy==='abort') {
      report.results=preview.map(day=>({date:day.date,state:duplicates.includes(day.date)?'skipped':'ready',status:duplicates.includes(day.date)?'duplicate':'ready',statusLabel:duplicates.includes(day.date)?'Sudah ada di LLK':'Belum dikirim',submitted:false,skipped:duplicates.includes(day.date),failed:false,verified:duplicates.includes(day.date),error:duplicates.includes(day.date)?'Tanggal sudah ada; dibatalkan oleh kebijakan abort':undefined}));
      await saveJson(reportFile(id),report);
      throw new HttpError(409,`Tanggal sudah ada: ${duplicates.join(', ')}`);
    }
    const page=await context.newPage();
    for (const day of preview) {
      if (day.items.every(item=>existing.has(entryKey({...item,date:day.date})))) {
        report.results.push({date:day.date,state:'skipped',status:'duplicate',statusLabel:'Sudah ada di LLK',message:'Dilewati karena isian identik sudah tercatat',submitted:false,skipped:true,failed:false,verified:true,itemCount:day.items.length});
        continue;
      }
      const result={date:day.date,state:'failed',status:'failed',statusLabel:'Gagal dikirim',submitted:false,skipped:false,failed:true,verified:false,itemCount:day.items.length,payload:{date:day.date,items:day.items}};
      try {
        await page.goto(`${LLK_BASE}/profile`,{waitUntil:'domcontentloaded'});
        const token = await extractCsrfToken(page, context);
        const [year,month,date]=day.date.split('-');
        const payload=new URLSearchParams({redirect:`${LLK_BASE}/llk`,_token:token,'author[name]':employee.name,'author[nip]':employee.nip,'author[jabatan_text]':employee.position,'supervisor[nip]':employee.supervisor.nip || employee.supervisor.id,'supervisor[name]':employee.supervisor.name,activity_date:`${date}-${month}-${year}`});
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
      await saveJson(reportFile(id),report);
      if (result.failed) break;
      await new Promise(r=>setTimeout(r, 600));
    }
    try {
      const after = new Set((await scrapeEntries(context)).map(entryKey));
      for (const result of report.results) {
        if (result.submitted && result.payload?.items) {
          const verified = result.payload.items.every(item=>after.has(entryKey({...item,date:result.date})));
          result.verified = verified;
          if (verified) {
            result.state = 'verified';
            result.status = 'awaiting_supervisor';
            result.statusLabel = 'Tersimpan di LLK · Menunggu verifikasi';
            result.message = `${result.itemCount || result.payload.items.length} kegiatan tersimpan di LLK (menunggu verifikasi atasan)`;
          } else {
            result.state = 'saved';
            result.status = 'awaiting_supervisor';
            result.statusLabel = 'Tersimpan (sinkronisasi LLK sedang berjalan)';
            result.message = 'Data terkirim (respons 303); sinkronisasi riwayat mungkin butuh beberapa detik';
          }
        }
      }
    } catch {}
    report.success=report.results.filter(x=>(x.submitted || x.verified)&&!x.skipped).length;
    report.skipped=report.results.filter(x=>x.skipped).length;
    report.failed=report.results.filter(x=>x.failed).length;
    await saveJson(reportFile(id),report);
    return report;
  } finally { await context.close(); }
}
function decodeHtml(text) { return clean(text.replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&#039;/g,"'").replace(/&quot;/g,'"')); }
function slug(text) { return clean(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''); }
function parseRoster(html, source) {
  const articlePattern=/<article\b[^>]*class="[^"]*roster-(?:card|featured)[^"]*"[^>]*>([\s\S]*?)<\/article>/gi, people=[]; let match;
  while ((match=articlePattern.exec(html))) { const block=match[1], name=decodeHtml(block.match(/<h3\b[^>]*class="[^"]*(?:roster-name|roster-featured-name)[^"]*"[^>]*>([\s\S]*?)<\/h3>/i)?.[1]||''); if (!name) continue; const nip=clean(decodeHtml(block.match(/<dt>\s*NIP\s*<\/dt>\s*<dd>([\s\S]*?)<\/dd>/i)?.[1]||'')); const roles=[...block.matchAll(/<(?:span|div)\b[^>]*class="[^"]*roster-(?:role|eyebrow)[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div)>/gi)].map(x=>decodeHtml(x[1])).filter(x=>x&&x!=='PPPK'); const position=roles.join('; ') || (source.includes('hakim')?'Hakim':'Pegawai'); const department=source.includes('hakim')?'hakim':source.includes('kepaniteraan')?'panitera':position.match(/Kepegawaian/i)?'kepegawaian':position.match(/Umum|Keuangan/i)?'umum_keuangan':position.match(/Perencanaan|TI|Teknologi/i)?'ptip':'sekretaris'; people.push({id:nip||`adhoc-${slug(name)}`,nip,name,position,department,supervisor:{id:'',nip:'',name:''}}); }
  return people;
}
async function rosterDiff() {
  const pages=await Promise.all(ROSTER_URLS.map(async url=>{ const response=await fetch(url,{signal:AbortSignal.timeout(20000),headers:{accept:'text/html'}}); if (!response.ok) throw new Error(`Situs resmi gagal: HTTP ${response.status}`); return parseRoster(await response.text(),url); }));
  const official=[...new Map(pages.flat().map(person=>[person.id,person])).values()], local=await getEmployees(); if (official.length<20) throw new Error('Data roster resmi tidak lengkap');
  const localMap=new Map(local.map(e=>[e.id,e])), officialMap=new Map(official.map(e=>[e.id,e]));
  const added=official.filter(e=>!localMap.has(e.id)), removed=local.filter(e=>!officialMap.has(e.id)), changed=official.filter(e=>{const old=localMap.get(e.id); return old&&(old.name!==e.name||old.position!==e.position);}).map(e=>({before:localMap.get(e.id),after:e}));
  stagedRoster={official,createdAt:new Date().toISOString()}; return {createdAt:stagedRoster.createdAt,added,removed,changed,unchanged:official.length-added.length-changed.length};
}
async function applyRoster() {
  if (!stagedRoster) bad('Belum ada diff roster yang aktif'); const local=await getEmployees(), localMap=new Map(local.map(e=>[e.id,e]));
  const employees=stagedRoster.official.map(remote=>{const old=localMap.get(remote.id); return old?{...old,nip:remote.nip,name:remote.name,position:remote.position,department:old.department,supervisor:old.supervisor}:{...remote};});
  await saveJson(employeeFile,employees); const appliedAt=new Date().toISOString(); stagedRoster=undefined; return {appliedAt,count:employees.length};
}
function validateEmployeeArray(value) { if (!Array.isArray(value)||value.length>500) bad('employees tidak valid'); const ids=new Set(); return value.map(e=>{ if (!e||typeof e!=='object') bad('Pegawai tidak valid'); const id=clean(e.id),nip=clean(e.nip),name=clean(e.name),position=clean(e.position),department=clean(e.department),supervisor=e.supervisor; if(!id||ids.has(id)||!name||!position||!department||!supervisor||typeof supervisor!=='object') bad('Data pegawai restore tidak valid'); ids.add(id); return {id,nip,name,position,department,supervisor:{id:clean(supervisor.id),nip:clean(supervisor.nip),name:clean(supervisor.name)}}; }); }
function validateTemplates(value) { if (!value||typeof value!=='object'||Array.isArray(value)) bad('templates tidak valid'); for(const group of Object.values(value)){if(!group||typeof group.label!=='string'||!Array.isArray(group.activities)||group.activities.some(a=>!a||typeof a.nama!=='string'||typeof a.kategori!=='string')) bad('Template restore tidak valid');} return value; }
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
async function applyTemplates(input,actor){const current=await templateSnapshot(),departments=validateTemplates(input.departments||input);await mkdir(templateHistoryRoot,{recursive:true});await saveJson(join(templateHistoryRoot,`${String(current.version).padStart(6,'0')}-${Date.now()}.json`),current);await rotateFiles(templateHistoryRoot,'');const next={version:current.version+1,updatedAt:new Date().toISOString(),departments};await saveJson(templateFile,next);await audit('templates.apply',actor,{version:next.version},{result:'applied'});return next;}
async function readPersonal(id){return existsSync(personalFile(id))?validatePersonal(await readJson(personalFile(id)),id):null;}
function validatePersonal(value,id){if(!value||typeof value!=='object'||value.employeeId!==id||!Array.isArray(value.activities)||value.activities.length>1000)bad('Template pribadi tidak valid');const activities=value.activities.map(a=>{const nama=clean(a?.nama),kategori=clean(a?.kategori)||'Pendukung',result=clean(a?.result||a?.output);if(!nama||/^istirahat$/i.test(nama)||!['Utama','Pendukung'].includes(kategori))bad('Kegiatan template pribadi tidak valid');return {nama,kategori,...(result?{result}:{})};});return {...sanitize(value),employeeId:id,activities};}
async function personalResponse(employee){const personal=await readPersonal(employee.id),stored=await readJson(templateFile),departments=stored.departments||stored,fallback=departments[employee.department];return {source:personal?.activities?.length?'personal':'department',personal,activities:personal?.activities?.length?personal.activities:(fallback?.activities||[]),fallbackLabel:fallback?.label||employee.department};}
async function importPersonal(id, existingContext, existingPage){
  const employee=await findEmployee(id),owned=!existingContext,{context}=existingContext?{context:existingContext}:await launchEmployee(id);
  try {
    const entries=await scrapeEntries(context,existingPage),current=await readPersonal(id);
    if(entries.available===false)return {available:false,current,candidate:null,warning:entries.warning||'Tahap riwayat: data LLK tidak tersedia; template pribadi tidak diubah.'};
    const seen=new Map(), allEntries=Array.isArray(entries)?entries:[];
    for(const entry of allEntries){
      const nama=clean(entry.description);
      if(!nama||/^istirahat$/i.test(nama))continue;
      const activity={nama,kategori:/^(Utama|Pendukung)$/i.test(entry.type)?clean(entry.type):'Pendukung'};
      const result=clean(entry.result||entry.output);if(result)activity.result=result;
      const key=canonical(activity);
      if(!seen.has(key))seen.set(key,{...activity,occurrences:1,lastSeen:entry.date||null});
      else {const item=seen.get(key);item.occurrences+=1;if(entry.date&&(!item.lastSeen||entry.date>item.lastSeen))item.lastSeen=entry.date;}
    }
    const activities=[...seen.values()].sort((a,b)=>b.occurrences-a.occurrences||a.nama.localeCompare(b.nama,'id-ID')).map(({occurrences,lastSeen,...item})=>item);
    if(!activities.length)return {available:false,current,candidate:null,warning:'Daftar LLK ditemukan, tetapi tidak ada kegiatan yang dapat dibaca. Template personal tidak diubah.'};
    const candidate={version:1,updatedAt:new Date().toISOString(),employeeId:id,activities};
    const stageToken=randomBytes(16).toString('hex'),digest=createHash('sha256').update(canonical(candidate)).digest('hex');
    stagedPersonal.set(id,{stageToken,token:stageToken,digest,candidate,expires:Date.now()+15*60*1000});
    return {available:true,current,candidate,activities,scannedEntries:allEntries.length,pagesScanned:entries.pagesScanned||1,sourceUrl:entries.sourceUrl||null,stageToken,digest,diff:{added:activities.length,modified:0,removed:current?.activities?.length||0}};
  } finally {if(owned)await context.close();}
}
async function enrichEmployeeFromSso(employee, page) {
  const routes = await discoverLlkRoutes(page);
  const createUrl = discoveredRoute(routes, [/tambah.*(?:llk|kegiatan)/, /llk.*(?:buat|create)/, /kegiatan.*(?:buat|create)/]);
  const originalUrl = page.url();
  if (createUrl) await navigateFeature(page, createUrl).catch(() => {});
  else await page.goto(`${LLK_BASE}/llk/create`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const fields = await page.evaluate(() => {
    const cleanText = value => String(value || '').replace(/\s+/g, ' ').trim();
    const value = name => cleanText(document.querySelector(`[name="${name}"]`)?.value);
    const supervisor = document.querySelector('[name="supervisor[nip]"]');
    const option = supervisor?.selectedOptions?.[0];
    const profile = cleanText(document.querySelector('.dropdown-toggle, [data-profile-name], .profile-name')?.textContent);
    const profileNip = profile.match(/\b\d{8,20}\b/)?.[0] || '';
    return {
      name: value('author[name]') || cleanText(profile.replace(profileNip, '').replace(/NIP\s*:?/i, '')),
      nip: value('author[nip]') || profileNip,
      position: value('author[jabatan_text]'),
      supervisorId: cleanText(supervisor?.value),
      supervisorName: value('supervisor[name]') || cleanText(option?.textContent)
    };
  });
  if (originalUrl && originalUrl !== page.url()) await page.goto(originalUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const requestedSupervisor = employeeId(employee.supervisor.nip) || clean(employee.supervisor.id);
  const updated = {
    ...employee,
    name: clean(fields.name) || employee.name,
    nip: employeeId(fields.nip) || employee.nip,
    position: clean(fields.position) || employee.position,
    supervisor: {
      id: clean(fields.supervisorId) || requestedSupervisor || employee.supervisor.id,
      nip: requestedSupervisor || employeeId(fields.supervisorId) || employee.supervisor.nip,
      name: clean(fields.supervisorName) || employee.supervisor.name
    }
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

async function moveBrowserProfile(source, destination) {
  if (source === destination || !existsSync(source)) return;
  if (existsSync(destination)) await rm(destination, { recursive: true, force: true });
  let lastError;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
    }
  }
  throw new Error(`Profil browser SSO gagal disimpan: ${lastError?.message || 'rename gagal'}`);
}

async function completeExternalBootstrap(tempId,tempEmployee,context) {
  const page=await requireAuthenticatedLlkPage(context);
  const verifier=await importVerifier(tempId,context,page);
  const actualNip=employeeId(verifier.verifier.nip);
  if(!actualNip)throw new HttpError(401,'NIP akun login SSO tidak terdeteksi');
  const placeholder={...tempEmployee,id:actualNip,nip:actualNip,name:clean(verifier.verifier.name)||tempEmployee.name};
  const employees=await getEmployees(),index=employees.findIndex(item=>item.id===actualNip);
  index>=0?employees.splice(index,1,placeholder):employees.push(placeholder);
  await saveJson(employeeFile,employees);
  const enriched=await enrichEmployeeFromSso(placeholder,page);
  const history=await importPersonal(actualNip,context,page);
  if(history?.candidate)await saveJson(personalFile(actualNip),history.candidate);
  await storeSessionCookies(actualNip,await context.cookies([LLK_BASE]));
  const flow=loginFlows.get(tempId);
  if(flow){flow.employee=enriched;flow.actualNip=actualNip;flow.fetchedAt=new Date().toISOString();}
  return {employee:enriched,verifier,history,sessionActive:true,tempId};
}

function normalizedIdentity(value){return clean(value).toLocaleLowerCase('id-ID');}
async function completeLogin(id){
  const flow=loginFlows.get(id); if(!flow||flow.closing)throw new HttpError(409,'Tidak ada proses login aktif');
  const page=await requireAuthenticatedLlkPage(flow.context),verifier=await importVerifier(id,flow.context,page),actualNip=employeeId(verifier.verifier.nip),expectedNip=employeeId(flow.employee.nip),warnings=[];
  const employee=await enrichEmployeeFromSso(flow.employee,page);
  if(verifier.warning)warnings.push(verifier.warning);
  if(expectedNip){if(actualNip!==expectedNip)throw new HttpError(401,'Identitas akun SSO tidak cocok dengan NIP pegawai terpilih');}
  else {if(normalizedIdentity(verifier.verifier.name)!==normalizedIdentity(flow.employee.name))throw new HttpError(401,'Identitas akun SSO tidak cocok dengan nama pegawai terpilih');warnings.push('Pegawai Ad-Hoc tanpa NIP dicocokkan berdasarkan nama lengkap persis. Pastikan identitas benar sebelum melanjutkan.');}
  const history=await importPersonal(id,flow.context,page);if(history.warning)warnings.push(history.warning);
  await storeSessionCookies(id,await flow.context.cookies([LLK_BASE]));
  await closeLoginFlow(id,flow);
  return {active:false,authenticated:true,stage:'complete',identity:verifier.verifier,employee,warning:warnings.join(' ')||null,warnings,verifier,history,autoApplied:false};
}
async function startVerificationRecording(input) {
  const id=safeId(input.employeeId);
  if(verificationRecording)throw new HttpError(409,'Perekaman verifikasi sudah aktif');
  const {employee,context}=await launchEmployee(id,false);
  const page=context.pages()[0]??await context.newPage();
  const requests=[];
  const capture=request=>{
    if(request.method()==='GET'||!request.url().startsWith(LLK_BASE))return;
    let payload={};
    try{payload=Object.fromEntries(new URLSearchParams(request.postData()||''));}catch{}
    requests.push({method:request.method(),url:request.url(),payload:sanitize(payload)});
  };
  context.on('request',capture);
  await page.goto(`${LLK_BASE}/verifikasi`,{waitUntil:'domcontentloaded'});
  verificationRecording={employee,context,page,requests,capture,customMessage:clean(input.customMessage),startedAt:new Date().toISOString()};
  return {active:true,startedAt:verificationRecording.startedAt,url:page.url()};
}

async function finishVerificationRecording() {
  if(!verificationRecording)throw new HttpError(409,'Tidak ada perekaman aktif');
  const {employee,context,page,requests,capture,customMessage,startedAt}=verificationRecording;
  const forms=await page.evaluate(()=>[...document.forms].map(form=>({action:form.action,method:(form.method||'get').toUpperCase(),fields:[...form.elements].map(field=>({name:field.name,type:field.type,tag:field.tagName.toLowerCase(),value:/password|token|csrf/i.test(field.name)?'':String(field.value||'').slice(0,200)})).filter(field=>field.name)})));
  const result={employeeId:employee.id,startedAt,finishedAt:new Date().toISOString(),url:page.url(),customMessage,title:clean(await page.title().catch(()=>'')),requests,forms};
  context.off('request',capture);
  await storeSessionCookies(employee.id,await context.cookies([LLK_BASE]));
  await saveJson(verificationRecordingFile,sanitize(result));
  await context.close();
  verificationRecording=null;
  await audit('verification.record',employee.id,{customMessage,url:result.url,requestCount:requests.length,formCount:forms.length},{result:'recorded'});
  return {url:result.url,requestCount:requests.length,formCount:forms.length};
}
async function verificationTargets(id, existingContext, extractIds = true) {
  const owned=!existingContext,{context}=existingContext?{context:existingContext}:await launchEmployee(id);
  progress(id,'launch','Membuka browser headless dan memuat sesi LLK…');
  try {
    const page=existingContext?(authenticatedLlkPage(context)??context.pages()[0]??await context.newPage()):await context.newPage();
    if(!llkLocation(page.url()).authenticated){
      await page.goto(LLK_BASE,{waitUntil:'domcontentloaded'});
      if(!llkLocation(page.url()).authenticated)throw new HttpError(401,'Sesi LLK kedaluwarsa; login ulang diperlukan');
    }
    progress(id,'home','Beranda LLK aktif. Mencari menu Verifikasi LLK…',{url:page.url()});
    const menu=page.locator('a[href="/verifikasi"], a[href="https://llk.mahkamahagung.go.id/verifikasi"]').first();
    if(await menu.count()){
      await menu.click();
      await page.waitForURL(url=>url.origin===LLK_BASE&&/^\/verifikasi(?:\/|$)/i.test(url.pathname),{timeout:15000}).catch(()=>{});
      await page.waitForLoadState('domcontentloaded').catch(()=>{});
    }
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
    progress(id,'filter','Filter status=1 dan pencarian berdasarkan NIP diterapkan. Menunggu hasil…',{url:page.url()});
    const searchButton=page.locator('button,input[type="submit"]').filter({hasText:/Cari|Search/i}).first();
    if(!await searchButton.count())throw new Error('Tombol Cari verifikasi tidak ditemukan');
    await searchButton.click({noWaitAfter:true});
    await page.waitForURL(url=>url.origin===LLK_BASE&&/^\/verifikasi(?:\/|$)/i.test(url.pathname)&&url.searchParams.get('status')==='1',{timeout:15000}).catch(()=>{});
    await page.waitForLoadState('domcontentloaded',{timeout:15000}).catch(()=>{});
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
    const extracted=await Promise.all(validRows.map(async (row,index)=>{
      const started=Date.now();progress(id,'target-fetch',`Membaca ID target ${index+1}/${validRows.length}…`,{target:index+1,totalTargets:validRows.length,date:row.date});
      let editPage;
      try{
        editPage=await context.newPage();
        const response=await editPage.goto(row.editUrl,{waitUntil:'domcontentloaded',timeout:120000});
        if(!response?.ok())return {failure:{...row,valid:false,issues:[`Halaman edit gagal: HTTP ${response?.status()||'tanpa respons'} setelah ${Date.now()-started} ms`]}};
        const input=editPage.locator('input[name="hllk"]').first(),hllk=await input.inputValue({timeout:10000}).catch(()=>''),title=clean(await editPage.title().catch(()=>''));
        if(/^\d+$/.test(hllk))return {target:{hllk,date:row.date,summary:row.summary,editUrl:row.editUrl,activities:row.activities,valid:true,issues:[]}};
        const formNames=await editPage.locator('input[name],select[name],textarea[name]').evaluateAll(nodes=>nodes.map(node=>node.name)).catch(()=>[]);
        return {failure:{...row,valid:false,issues:[`ID hllk tidak ditemukan; halaman "${title||'tanpa judul'}", URL akhir ${editPage.url()}, field: ${[...new Set(formNames)].slice(0,12).join(', ')||'tidak ada'} (${Date.now()-started} ms)`]}};
      }catch(error){return {failure:{...row,valid:false,issues:[`${/timeout/i.test(error.message)?'Timeout 120 detik':'Fetch halaman edit gagal'}: ${error.message}`]}};}
      finally{if(editPage)await editPage.close().catch(()=>{});}
    }));
    const targets=extracted.map(item=>item.target).filter(Boolean),idFailures=extracted.map(item=>item.failure).filter(Boolean);
    const uniqueTargets=[...new Map(targets.map(item=>[item.hllk,item])).values()];
    uniqueTargets.pagesScanned=visited.size;uniqueTargets.rowsFound=uniqueRows.length;uniqueTargets.validCount=uniqueTargets.length;uniqueTargets.invalidCount=invalidRows.length+idFailures.length;uniqueTargets.invalidTargets=[...invalidRows,...idFailures];
    progress(id,'complete',`Pemindaian selesai: ${uniqueTargets.length} target siap, ${uniqueTargets.invalidCount} ditahan.`,{validCount:uniqueTargets.length,invalidCount:uniqueTargets.invalidCount,pagesScanned:visited.size});
    return uniqueTargets;
  } catch(error){progress(id,'error',`Pemindaian gagal: ${error.message}`);throw error;} finally {if(owned)await context.close();}
}
async function dryRunLlkToVerification(id){
  const {context}=await launchEmployee(id);
  try{
    const page=context.pages()[0]??await context.newPage();
    const llkEntries=await scrapeEntries(context,page);
    if(llkEntries.available===false)throw new HttpError(400,llkEntries.warning||'Halaman LLK gagal dibaca');
    const targets=await verificationTargets(id,context,false);
    return {safe:true,verified:false,llk:{url:llkEntries.sourceUrl,pagesScanned:1,entries:llkEntries.length},verification:{filter:{status:'1',by:'nip'},pagesScanned:targets.pagesScanned||1,rowsFound:targets.rowsFound??targets.length,total:targets.length,validCount:targets.validCount??targets.filter(item=>item.valid).length,invalidCount:targets.invalidCount??targets.filter(item=>!item.valid).length,targets}};
  }finally{await context.close();}
}
async function startVerificationScanRecording(input){
  const id=safeId(input.employeeId);
  if(verificationScanRecording)throw new HttpError(409,'Perekaman pemindaian sudah aktif');
  const {employee,context}=await launchEmployee(id,false),page=context.pages()[0]??await context.newPage(),requests=[];
  const capture=request=>{if(request.url().startsWith(LLK_BASE)&&/verifikasi/i.test(request.url()))requests.push({method:request.method(),url:request.url(),postData:sanitize(Object.fromEntries(new URLSearchParams(request.postData()||'')))});};
  context.on('request',capture);
  await page.goto(`${LLK_BASE}/verifikasi`,{waitUntil:'domcontentloaded'});
  verificationScanRecording={employee,context,page,requests,capture,startedAt:new Date().toISOString()};
  return {active:true,url:page.url()};
}

async function finishVerificationScanRecording(){
  if(!verificationScanRecording)throw new HttpError(409,'Tidak ada perekaman pemindaian aktif');
  const {employee,context,page,requests,capture,startedAt}=verificationScanRecording;
  const dom=await page.evaluate(()=>{
    const text=node=>String(node?.textContent||'').replace(/\s+/g,' ').trim();
    const attrs=node=>Object.fromEntries([...node.attributes].map(attr=>[attr.name,attr.value]));
    return {url:location.href,radios:[...document.querySelectorAll('input[type="radio"]')].map(node=>({attrs:attrs(node),checked:node.checked,label:text(node.closest('label')||node.parentElement)})),buttons:[...document.querySelectorAll('a,button,input[type="submit"]')].map(node=>({text:text(node),attrs:attrs(node)})),rows:[...document.querySelectorAll('table tbody > tr')].map(row=>({text:text(row).slice(0,500),html:row.outerHTML.slice(0,5000)})),forms:[...document.forms].map(form=>({attrs:attrs(form),html:form.outerHTML.slice(0,10000)}))};
  });
  const result={employeeId:employee.id,startedAt,finishedAt:new Date().toISOString(),requests,dom};
  context.off('request',capture);await storeSessionCookies(employee.id,await context.cookies([LLK_BASE]));await saveJson(verificationScanRecordingFile,sanitize(result));await context.close();verificationScanRecording=null;
  return {url:dom.url,rows:dom.rows.length,requests:requests.length};
}


async function startNavigationRecording(input) {
  const id=safeId(input.employeeId),mode=clean(input.mode);
  if(!['llk','verifikasi'].includes(mode))bad('Mode rekaman tidak valid');
  if(navigationRecording)throw new HttpError(409,'Perekaman navigasi sudah aktif');
  const {employee,context}=await launchEmployee(id,false),page=context.pages()[0]??await context.newPage(),requests=[];
  const capture=request=>{if(request.url().startsWith(LLK_BASE))requests.push({method:request.method(),url:request.url()});};
  context.on('request',capture);
  await context.addInitScript(() => {
    window.__llkAgentClicks=[];
    document.addEventListener('click',event=>{
      const node=event.target.closest('a,button,input[type="submit"]');
      if(!node)return;
      window.__llkAgentClicks.push({at:new Date().toISOString(),tag:node.tagName.toLowerCase(),text:String(node.textContent||node.value||'').replace(/\s+/g,' ').trim(),href:node.href||'',id:node.id||'',name:node.getAttribute('name')||'',className:String(node.className||'')});
    },true);
  });
  const current=llkLocation(page.url());
  if(!current.authenticated)await page.goto(LLK_BASE,{waitUntil:'domcontentloaded'});
  navigationRecording={employee,context,page,mode,requests,capture,startedAt:new Date().toISOString()};
  return {active:true,mode,url:page.url(),message:`Di Edge, klik menu ${mode==='llk'?'LLK':'Verifikasi LLK'} lalu tampilkan daftar yang ingin dibaca.`};
}

async function finishNavigationRecording() {
  if(!navigationRecording)throw new HttpError(409,'Tidak ada perekaman navigasi aktif');
  const {employee,context,page,mode,requests,capture,startedAt}=navigationRecording;
  let imported=null;
  if(mode==='llk'){
    imported=await importPersonal(employee.id,context,page);
    if(imported?.candidate)await saveJson(personalFile(employee.id),imported.candidate);
  }
  const clicks=await page.evaluate(()=>window.__llkAgentClicks||[]).catch(()=>[]);
  const dom=await page.evaluate(()=>({url:location.href,title:document.title,links:[...document.querySelectorAll('a[href]')].map(a=>({text:String(a.textContent||'').replace(/\s+/g,' ').trim(),href:a.href,id:a.id||'',className:String(a.className||'')})),tables:[...document.querySelectorAll('table')].map(table=>table.outerHTML.slice(0,100000))}));
  const result={employeeId:employee.id,mode,startedAt,finishedAt:new Date().toISOString(),clicks,requests,dom,imported:sanitize(imported)};
  context.off('request',capture);
  await storeSessionCookies(employee.id,await context.cookies([LLK_BASE]));
  await saveJson(join(DATA,`navigation-${mode}.json`),sanitize(result));
  await context.close();
  navigationRecording=null;
  return {mode,url:dom.url,clicks:clicks.length,requests:requests.length,tables:dom.tables.length,importedEntries:imported?.scannedEntries||0,importedActivities:imported?.candidate?.activities?.length||0};
}

async function verificationDiagnostics(id) {
  const {context}=await launchEmployee(id);
  try {
    const page=await context.newPage();
    await page.goto(`${LLK_BASE}/verifikasi`,{waitUntil:'domcontentloaded'});
    if(!llkLocation(page.url()).authenticated)throw new HttpError(401,'Sesi LLK kedaluwarsa; login ulang diperlukan');
    return page.evaluate(()=>{
      const text=node=>String(node?.textContent||'').replace(/\s+/g,' ').trim();
      const attrs=node=>Object.fromEntries([...node.attributes].map(attr=>[attr.name,attr.value]));
      return {url:location.href,radios:[...document.querySelectorAll('input[type="radio"]')].map(node=>({name:node.name,value:node.value,checked:node.checked,label:text(node.closest('label')||node.parentElement)})),badges:[...document.querySelectorAll('.badge,.label,span')].filter(node=>/^\d+$/.test(text(node))).slice(0,20).map(node=>({text:text(node),attrs:attrs(node)})),rows:[...document.querySelectorAll('table tbody > tr')].slice(0,5).map(row=>({text:text(row).slice(0,500),controls:[...row.querySelectorAll('a,button,input')].map(node=>({tag:node.tagName,type:node.type||'',text:text(node),attrs:attrs(node)}))})),forms:[...document.forms].map(form=>({action:form.action,method:form.method,fields:[...form.elements].map(node=>({name:node.name,value:node.value,type:node.type,attrs:attrs(node)}))}))};
    });
  } finally {await context.close();}
}

const verificationListUrl=()=>`${LLK_BASE}/verifikasi?start_date=&end_date=&status=1&by=nip&q=`;
const verificationPayload=(hllk,message)=>({hllk:String(hllk),redirect:verificationListUrl(),note:clean(message),verified:'2'});
async function runAutomaticVerification(id,input) {
  const message=clean(input.message);

  if(!message)bad('Pesan verifikasi wajib diisi');
  const preview=await verificationTargets(id);
  const selected=new Set(Array.isArray(input.hllk)?input.hllk.map(String):[]);
  const targets=selected.size?preview.filter(item=>selected.has(item.hllk)):preview;
  if(!targets.length)bad('Tidak ada LLK berstatus Belum Diverifikasi');
  const {context}=await launchEmployee(id);
  try {
    const page=await context.newPage();
    await page.goto(`${LLK_BASE}/verifikasi`,{waitUntil:'domcontentloaded'});
    if(!llkLocation(page.url()).authenticated)throw new HttpError(401,'Sesi LLK kedaluwarsa; login ulang diperlukan');
    const token=await extractCsrfToken(page,context);
    const results=[];
    for(const target of targets){
      const payload=new URLSearchParams(verificationPayload(target.hllk,message));
      if(token)payload.set('_token',token);
      const response=await context.request.post(`${LLK_BASE}/verifikasi/update`,{headers:{'content-type':'application/x-www-form-urlencoded',referer:`${LLK_BASE}/verifikasi`},data:payload.toString(),maxRedirects:0});
      results.push({hllk:target.hllk,status:response.status(),success:[200,302,303].includes(response.status())});
    }
    await audit('verification.auto',id,{message,targetIds:targets.map(item=>item.hllk)},{counts:{total:results.length,success:results.filter(item=>item.success).length},result:'completed'});
    return {total:results.length,success:results.filter(item=>item.success).length,failed:results.filter(item=>!item.success).length,results};
  } finally {await context.close();}
}

function previewVerificationPayload(input){
  const message=clean(input.message),hllk=clean(input.hllk);
  if(!message)bad('Pesan verifikasi wajib diisi');
  if(!/^\d+$/.test(hllk))bad('ID hllk tidak valid');
  return {safe:true,submitted:false,method:'POST',url:`${LLK_BASE}/verifikasi/update`,payload:verificationPayload(hllk,message)};
}


async function archivePersonal(id,current){if(!current)return;const dir=personalHistoryDir(id);await mkdir(dir,{recursive:true});await saveJson(join(dir,`${String(current.version||0).padStart(6,'0')}-${Date.now()}.json`),current);await rotateFiles(dir,'');}
async function applyPersonal(id,input){const stage=stagedPersonal.get(id);if(!stage||stage.expires<Date.now()||input.stageToken!==stage.token||input.confirm!==id)throw new HttpError(409,'Stage token atau konfirmasi tidak cocok');const current=await readPersonal(id);await archivePersonal(id,current);await saveJson(personalFile(id),stage.candidate);stagedPersonal.delete(id);await audit('personal-template.apply',id,{employeeId:id,digest:stage.digest},{counts:{activities:stage.candidate.activities.length},result:'applied'});return personalResponse(await findEmployee(id));}
async function resetPersonal(id,input){if(input.confirm!==id)bad('Konfirmasi ID pegawai wajib sama');await findEmployee(id);const current=await readPersonal(id);if(current){await archivePersonal(id,current);await rm(personalFile(id),{force:true});}stagedPersonal.delete(id);await audit('personal-template.reset',id,{employeeId:id},{result:'reset'});return personalResponse(await findEmployee(id));}
async function allPersonal(){await mkdir(personalTemplateRoot,{recursive:true});const out={};for(const name of await readdir(personalTemplateRoot))if(name.endsWith('.json')){const id=name.slice(0,-5);try{out[id]=validatePersonal(await readJson(join(personalTemplateRoot,name)),id);}catch{}}return out;}
async function restorePersonal(input){if(!input||typeof input!=='object'||Array.isArray(input))bad('personalTemplates tidak valid');await mkdir(personalTemplateRoot,{recursive:true});for(const [rawId,value] of Object.entries(input)){const id=safeId(rawId);await findEmployee(id);await saveJson(personalFile(id),validatePersonal(value,id));}}

async function api(req,res,url) {
  const path=url.pathname;
  if(req.method==='GET'&&path==='/api/progress'){const id=safeId(url.searchParams.get('employeeId')),since=Math.max(0,Number(url.searchParams.get('since'))||0);return json(res,200,progressState(id,since));}
  if(req.method==='GET'&&path==='/api/settings')return json(res,200,await getSettings());
  if(req.method==='POST'&&path==='/api/settings'){const input=await bodyJson(req);return json(res,200,await saveSettings(input));}
  if(req.method==='GET'&&path==='/api/verification/diagnostics'){const id=safeId(url.searchParams.get('employeeId'));return json(res,200,await verificationDiagnostics(id));}
  if(req.method==='GET'&&path==='/api/holidays')return json(res,200,await getHolidayObject());
  if(req.method==='GET'&&path==='/api/supervisor-lookup')return json(res,200,await googleSupervisorLookup(url.searchParams.get('nip')));
  if(req.method==='POST'&&path==='/api/holidays'){const input=await bodyJson(req);if(!input||typeof input!=='object')bad('Data hari libur tidak valid');await saveJson(holidayFile,input);await audit('holidays.update','local',input,{result:'saved'});return json(res,200,input);}
  if(req.method==='GET'&&path==='/api/employees')return json(res,200,await getEmployees());
  if(req.method==='GET'&&path==='/api/workflow/llk-to-verification/dry-run'){const id=safeId(url.searchParams.get('employeeId'));return json(res,200,await dryRunLlkToVerification(id));}
  if(req.method==='GET'&&path==='/api/verifier')return json(res,200,existsSync(verifierFile)?await readJson(verifierFile):{employees:[]});
  if(req.method==='POST'&&path==='/api/verifier/import'){const input=await bodyJson(req);return json(res,200,await withLock(safeId(input.employeeId),()=>importVerifier(safeId(input.employeeId))));}
  if(req.method==='GET'&&path==='/api/templates')return json(res,200,await templateSnapshot());
  if(req.method==='GET'&&path==='/api/templates/history'){await mkdir(templateHistoryRoot,{recursive:true});return json(res,200,{versions:(await readdir(templateHistoryRoot)).filter(x=>x.endsWith('.json')).sort().reverse().slice(0,MAX_HISTORY)});}
  if(req.method==='POST'&&path==='/api/templates/diff'){const input=await bodyJson(req),current=await templateSnapshot(),next=validateTemplates(input.departments||input);return json(res,200,{fromVersion:current.version,changed:Object.keys(next).filter(k=>canonical(next[k])!==canonical(current.departments[k])),removed:Object.keys(current.departments).filter(k=>!next[k])});}
  if(req.method==='POST'&&path==='/api/templates/apply')return json(res,200,await applyTemplates(await bodyJson(req),'local'));
  if(req.method==='DELETE'&&path.startsWith('/api/profiles/')){const id=safeId(decodeURIComponent(path.slice('/api/profiles/'.length))),input=await bodyJson(req);if(input.confirm!==id)bad('Konfirmasi ID pegawai wajib sama');if(locks.has(id))throw new HttpError(409,'Profil sedang digunakan');await rm(profilePath(id),{recursive:true,force:true});await audit('profile.delete',id,{employeeId:id},{result:'deleted'});return json(res,200,{deleted:true,employeeId:id});}
  if(req.method==='GET'&&path==='/api/config/backup'){const backup={version:2,createdAt:new Date().toISOString(),employees:await getEmployees(),templates:await templateSnapshot(),personalTemplates:await allPersonal()};return json(res,200,backup,{'content-disposition':`attachment; filename="llk-backup-${localIso(new Date())}.json"`});}
  if(req.method==='POST'&&path==='/api/config/restore'){const input=await bodyJson(req);if(![1,2].includes(input.version))bad('Versi backup tidak didukung');const employees=validateEmployeeArray(input.employees),templates=input.templates?.departments||input.templates;await saveJson(employeeFile,employees);await applyTemplates(templates,'local');if(input.version===2)await restorePersonal(input.personalTemplates||{});return json(res,200,{restored:true,employees:employees.length});}
  if(req.method==='POST'&&path==='/api/roster/diff')return json(res,200,await rosterDiff());
  if(req.method==='POST'&&path==='/api/roster/apply')return json(res,200,await applyRoster());
  if(req.method==='POST'&&path==='/api/verification/run'){const input=await bodyJson(req),id=safeId(input.employeeId);return json(res,200,await runAutomaticVerification(id,input));}
  if(req.method==='GET'&&path==='/api/verification/preview'){const id=safeId(url.searchParams.get('employeeId'));const targets=await verificationTargets(id);return json(res,200,{targets,total:targets.length,pagesScanned:targets.pagesScanned||1,rowsFound:targets.rowsFound??targets.length,validCount:targets.validCount??targets.length,invalidCount:targets.invalidCount||0,invalidTargets:targets.invalidTargets||[]});}
  if(req.method==='GET'&&path==='/api/navigation-recording/status')return json(res,200,{active:Boolean(navigationRecording),...(navigationRecording?{mode:navigationRecording.mode,url:navigationRecording.page.url(),startedAt:navigationRecording.startedAt}:{}),recorded:{llk:existsSync(join(DATA,'navigation-llk.json')),verifikasi:existsSync(join(DATA,'navigation-verifikasi.json'))}});
  if(req.method==='POST'&&path==='/api/navigation-recording/start')return json(res,200,await startNavigationRecording(await bodyJson(req)));
  if(req.method==='POST'&&path==='/api/navigation-recording/finish')return json(res,200,await finishNavigationRecording());
  if(req.method==='POST'&&path==='/api/verification-scan-recording/start')return json(res,200,await startVerificationScanRecording(await bodyJson(req)));
  if(req.method==='POST'&&path==='/api/verification-scan-recording/finish')return json(res,200,await finishVerificationScanRecording());
  if(req.method==='POST'&&path==='/api/bootstrap/login'){
    const input=await bodyJson(req);
    const supervisorNip=employeeId(input.supervisorNip);
    if(!supervisorNip)bad('NIP atasan wajib diisi');
    const lookup=supervisorLookups.get(clean(input.supervisorLookupToken));
    if(!lookup||lookup.expires<Date.now()||lookup.nip!==supervisorNip||input.supervisorConfirmed!==true)throw new HttpError(409,'Periksa hasil Google Search dan konfirmasi identitas atasan terlebih dahulu');
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
    const flow=loginFlows.get(tempId);
    if(!flow)throw new HttpError(409,'Sesi login eksternal tidak aktif atau kedaluwarsa');
    return json(res,200,await completeExternalBootstrap(tempId,flow.employee,flow.context));
  }
  if(req.method==='POST'&&path==='/api/verification-recording/start')return json(res,200,await startVerificationRecording(await bodyJson(req)));
  if(req.method==='POST'&&path==='/api/verification-recording/finish')return json(res,200,await finishVerificationRecording());
  if(req.method==='POST'&&path==='/api/employees'){
    const input=await bodyJson(req),id=employeeId(input.nip);
    if(id.length<8)bad('NIP pegawai minimal 8 digit angka');
    const satker=clean(input.satker)||'Pengadilan Negeri Natuna';
    const position=clean(input.position)||'Pegawai / Pelaksana';
    const department=clean(input.department)||'umum_keuangan';
    const supervisorNip=employeeId(input.supervisorNip||input.supervisor?.nip);
    const supervisorName=clean(input.supervisorName||input.supervisor?.name)||'Atasan Langsung';
    const supervisorId=clean(input.supervisorId||input.supervisor?.id||supervisorNip);
    const supervisor={id:supervisorId,nip:supervisorNip,name:supervisorName};
    const name=clean(input.name)||`Pegawai NIP ${id}`;
    const employees=await getEmployees(),employee={id,nip:id,name,position,department,satker,supervisor};
    const index=employees.findIndex(e=>e.id===id);
    index>=0?employees.splice(index,1,employee):employees.push(employee);
    await saveJson(employeeFile,employees);
    return json(res,200,employee);
  }
  const employeeRoute = path.match(/^\/api\/employees\/([^/]+)\/(.+)$/);
  if (!employeeRoute) return json(res,404,{error:'Endpoint tidak ditemukan'});
  const id = safeId(decodeURIComponent(employeeRoute[1]));
  const action = employeeRoute[2];
  if(action==='personal-template'&&req.method==='GET')return json(res,200,await personalResponse(await findEmployee(id)));
  if(action==='personal-template/import'&&req.method==='POST'){await bodyJson(req);return json(res,200,await withLock(id,()=>importPersonal(id)));}
  if(action==='personal-template/apply'&&req.method==='POST')return json(res,200,await applyPersonal(id,await bodyJson(req)));
  if(action==='personal-template'&&req.method==='DELETE')return json(res,200,await resetPersonal(id,await bodyJson(req)));
  if(action==='preview'&&req.method==='POST'){const input=await bodyJson(req);return json(res,200,await generatePreview(await findEmployee(id),input.start,input.end,input.department));}
  if(action==='report'&&req.method==='GET')return json(res,200,existsSync(reportFile(id))?await readJson(reportFile(id)):{results:[],success:0,failed:0});
  if(action==='login'&&req.method==='POST')return json(res,200,await openLogin(id));
  if(action==='login/status'&&req.method==='GET'){const flow=loginFlows.get(id); if(!flow||flow.closing)return json(res,200,{active:false}); const pages=await pageDiagnostics(flow.context), authenticated=Boolean(authenticatedLlkPage(flow.context)); return json(res,200,{active:true,authenticated,createdAt:flow.createdAt,expiresAt:flow.expiresAt,pages});}
  if(action==='login/complete'&&req.method==='POST')return json(res,200,await completeLogin(id));
  if(action==='login/cancel'&&req.method==='POST')return json(res,200,{active:false,cancelled:await closeLoginFlow(id)});
  if(action==='verify'&&req.method==='GET')return json(res,200,await withLock(id,()=>verifyLogin(id)));
  if(action==='audit'&&req.method==='GET')return json(res,200,await withLock(id,()=>auditEntries(id)));
  if((action==='submit'||action==='test-submit')&&req.method==='POST'){const input=await bodyJson(req);if(action==='test-submit'&&(!Array.isArray(input.preview)||input.preview.length!==1))bad('Tes live wajib tepat satu hari kerja');const report=await withLock(id,()=>submitPreview(id,input.preview,input.duplicatePolicy));await audit(action,id,input.preview,{counts:{submitted:report.success,failed:report.failed},result:'completed'});return json(res,200,sanitize(report));}
  return json(res,405,{error:'Metode tidak didukung'});
}

const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json'};
await mkdir(DATA,{recursive:true,mode:0o700}); await mkdir(PROFILE_ROOT,{recursive:true,mode:0o700}); await mkdir(templateHistoryRoot,{recursive:true,mode:0o700}); await mkdir(personalTemplateRoot,{recursive:true,mode:0o700}); await mkdir(personalHistoryRoot,{recursive:true,mode:0o700});
if(process.platform!=='win32')await Promise.all([chmod(DATA,0o700),chmod(PROFILE_ROOT,0o700)]);
const server=createServer(async(req,res)=>{try{const url=new URL(req.url,`http://${req.headers.host||'127.0.0.1'}`);if(url.pathname.startsWith('/api/'))return await api(req,res,url);let decoded;try{decoded=decodeURIComponent(url.pathname);}catch{bad('Path tidak valid');}const file=resolve(PUBLIC,decoded==='/'?'index.html':decoded.slice(1)),rel=relative(PUBLIC,file);if(rel.startsWith('..')||isAbsolute(rel))throw new HttpError(403,'Akses ditolak');res.writeHead(200,{'content-type':mime[extname(file)]||'application/octet-stream'});res.end(await readFile(file));}catch(error){if(!res.headersSent)json(res,error.status||400,{error:error.message||'Permintaan gagal'});else if(!res.writableEnded)res.end();}});
server.listen(PORT,'127.0.0.1',()=>console.log(`LLK Agent PN Natuna: http://127.0.0.1:${PORT}`));
let stopping=false;const shutdown=async()=>{if(stopping)return;stopping=true;await Promise.all([...loginFlows].map(([id,flow])=>closeLoginFlow(id,flow)));server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),10_000).unref();};
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
